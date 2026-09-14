use crate::{Failure, limits::append};
use calamine::{Data, Range, Reader, Xls, XlsError, Xlsb, XlsbError};
use std::io::{Cursor, Read, Seek};

const MAX_SHEETS: usize = 100;
const MAX_ROWS: u32 = 10_000;
const MAX_COLS: u32 = 256;
const MAX_CELLS: u64 = 100_000;
const MAX_CELL_BYTES: usize = 128 * 1024;

pub(crate) fn convert(bytes: &[u8], extension: &str) -> Result<String, Failure> {
    let ole_normalized = if extension == "xls" {
        crate::ole_padding::normalize(bytes)?
    } else {
        std::borrow::Cow::Borrowed(bytes)
    };
    let bytes = ole_normalized.as_ref();
    // 加密 XLSB 是 OLE 包装而非 ZIP，必须先识别加密，避免被兼容层误报损坏。
    crate::ole::check(bytes, extension)?;
    let normalized = if extension == "xlsb" {
        std::borrow::Cow::Owned(crate::xlsb_compat::normalize_xlsb(bytes)?)
    } else {
        std::borrow::Cow::Borrowed(bytes)
    };
    let bytes = normalized.as_ref();
    // 使用指定格式的 Cursor 入口，避免 auto 探测吞掉 Password 等结构化错误。
    match extension {
        "xls" => render(
            &mut Xls::new(Cursor::new(bytes)).map_err(xls_error)?,
            xls_error,
        ),
        "xlsb" => render(
            &mut Xlsb::new(Cursor::new(bytes)).map_err(xlsb_error)?,
            xlsb_error,
        ),
        _ => Err(Failure::Unsupported),
    }
}

fn xls_error(error: XlsError) -> Failure {
    match error {
        XlsError::Password => Failure::Encrypted,
        XlsError::WorksheetNotFound(_) => Failure::MissingPart,
        _ => Failure::Malformed,
    }
}

fn xlsb_error(error: XlsbError) -> Failure {
    match error {
        XlsbError::Password => Failure::Encrypted,
        XlsbError::FileNotFound(_) | XlsbError::WorksheetNotFound(_) => Failure::MissingPart,
        XlsbError::Zip(error) => crate::limits::zip_error(error),
        XlsbError::UnsupportedType(_) => Failure::Unsupported,
        _ => Failure::Malformed,
    }
}

fn render<RS: Read + Seek, R: Reader<RS>>(
    workbook: &mut R,
    map_error: impl Fn(R::Error) -> Failure,
) -> Result<String, Failure> {
    let names = workbook.sheet_names();
    if names.len() > MAX_SHEETS {
        return Err(Failure::ResourceLimit);
    }
    let mut output = String::new();
    let mut cells = 0;
    for name in names {
        // worksheets() 会静默略过失败表；逐表读取并传播任何错误，含隐藏表和空表。
        let range = workbook.worksheet_range(&name).map_err(&map_error)?;
        append(&mut output, "## ")?;
        escape(&mut output, &name)?;
        append(&mut output, "\n\n")?;
        render_range(&mut output, &range, &mut cells)?;
        append(&mut output, "\n")?;
    }
    Ok(output)
}

fn render_range(output: &mut String, range: &Range<Data>, cells: &mut u64) -> Result<(), Failure> {
    let Some((last_row, last_col)) = range.end() else {
        return append(output, "（空表）\n");
    };
    if last_row >= MAX_ROWS || last_col >= MAX_COLS {
        return Err(Failure::ResourceLimit);
    }
    // 从 A1 展开，保留起始空列/空行及中间空洞；总格数按工作簿累计，不按非空单元格计算。
    let rows = last_row + 1;
    let cols = last_col + 1;
    *cells += u64::from(rows) * u64::from(cols);
    if *cells > MAX_CELLS {
        return Err(Failure::ResourceLimit);
    }
    for row in 0..rows {
        append(output, "|")?;
        for col in 0..cols {
            append(output, " ")?;
            if let Some(value) = range.get_value((row, col)) {
                render_cell(output, value)?;
            }
            append(output, " |")?;
        }
        append(output, "\n")?;
        if row == 0 {
            append(output, "|")?;
            for _ in 0..cols {
                append(output, " --- |")?;
            }
            append(output, "\n")?;
        }
    }
    Ok(())
}

fn render_cell(output: &mut String, value: &Data) -> Result<(), Failure> {
    // 不请求公式表达式/VBA；Calamine Data 是缓存值。日期保留其 Excel 序列值而不猜测格式。
    match value {
        Data::String(text) | Data::DateTimeIso(text) | Data::DurationIso(text) => {
            escape(output, text)
        }
        Data::Empty => Ok(()),
        _ => escape(output, &value.to_string()),
    }
}

fn escape(output: &mut String, text: &str) -> Result<(), Failure> {
    if text.len() > MAX_CELL_BYTES {
        return Err(Failure::ResourceLimit);
    }
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '&' => append(output, "&amp;")?,
            '<' => append(output, "&lt;")?,
            '>' => append(output, "&gt;")?,
            // HTML 实体保留单元格首尾及连续空格，避免 GFM trim 后丢失信息。
            ' ' => append(output, "&#32;")?,
            '\t' => append(output, "&#9;")?,
            '\r' | '\n' => {
                if ch == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                append(output, "<br>")?;
            }
            '\\' | '|' | '`' | '*' | '_' | '[' | ']' | '~' | '#' => {
                append(output, "\\")?;
                append(output, ch.encode_utf8(&mut [0u8; 4]))?;
            }
            _ => append(output, ch.encode_utf8(&mut [0u8; 4]))?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{CellErrorType, ExcelDateTime, ExcelDateTimeType};

    #[test]
    fn every_data_type_and_whitespace() {
        let values = [
            Data::Int(-3),
            Data::Float(1.5),
            Data::Bool(true),
            Data::Empty,
            Data::Error(CellErrorType::Div0),
            Data::DateTime(ExcelDateTime::new(2.5, ExcelDateTimeType::DateTime, false)),
            Data::DateTimeIso("2026-01-01T00:00:00".into()),
            Data::DurationIso("PT2H".into()),
            Data::String(" a  b | <x> & *c*\r\n\t".into()),
        ];
        let mut output = String::new();
        for value in values {
            render_cell(&mut output, &value).unwrap();
            append(&mut output, "\n").unwrap();
        }
        assert_eq!(
            output,
            "-3\n1.5\ntrue\n\n\\#DIV/0!\n2.5\n2026-01-01T00:00:00\nPT2H\n&#32;a&#32;&#32;b&#32;\\|&#32;&lt;x&gt;&#32;&amp;&#32;\\*c\\*<br>&#9;\n"
        );
    }

    #[test]
    fn cell_and_markdown_limits_fail_without_truncation() {
        assert_eq!(
            escape(&mut String::new(), &"x".repeat(MAX_CELL_BYTES + 1)),
            Err(Failure::ResourceLimit)
        );
        let mut output = "x".repeat(crate::MAX_MARKDOWN_BYTES);
        assert_eq!(escape(&mut output, "字"), Err(Failure::ResourceLimit));
    }
}
