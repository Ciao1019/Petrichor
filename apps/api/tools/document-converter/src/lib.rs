//! 单源、离线文档转换；业务错误只暴露稳定代码。

mod limits;
mod ole;
mod ole_padding;
mod pdf;
mod pdf_visuals;
mod spreadsheet;
mod workbook;
mod xlsb_compat;

use anydoc::{ConvertError, Format};
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

pub use limits::{MAX_MARKDOWN_BYTES, MAX_SOURCE_BYTES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    NeedsOcr,
    Unsupported,
    Malformed,
    Encrypted,
    ResourceLimit,
    MissingPart,
    Io,
}

impl Failure {
    pub fn json(self) -> Value {
        let code = match self {
            Self::NeedsOcr => "needsOcr",
            Self::Unsupported => "unsupported",
            Self::Malformed => "malformed",
            Self::Encrypted => "encrypted",
            Self::ResourceLimit => "resourceLimit",
            Self::MissingPart => "missingPart",
            Self::Io => "io",
        };
        if self == Self::NeedsOcr {
            json!({"ok": false, "code": code, "pages": [1], "pageCount": 1})
        } else {
            json!({"ok": false, "code": code})
        }
    }
}

fn anydoc_error(error: ConvertError) -> Failure {
    // 只有确认为单页的 PDF 才允许发出 OCR 请求，不能把 unsupported 改写为 OCR。
    if let ConvertError::NeedsOcr { pages, page_count } = &error {
        return if pages.as_slice() == [1] && *page_count == 1 {
            Failure::NeedsOcr
        } else {
            Failure::Malformed
        };
    }
    match error.code() {
        "unsupported" => Failure::Unsupported,
        "encrypted" => Failure::Encrypted,
        "resourceLimit" => Failure::ResourceLimit,
        "missingPart" => Failure::MissingPart,
        "io" => Failure::Io,
        _ => Failure::Malformed,
    }
}

pub fn supported_format(extension: &str) -> bool {
    matches!(
        extension,
        "doc"
            | "docx"
            | "docm"
            | "odt"
            | "pdf"
            | "ppt"
            | "pps"
            | "pot"
            | "pptx"
            | "pptm"
            | "ppsx"
            | "ppsm"
            | "rtf"
            | "epub"
            | "xlsx"
            | "xlsm"
            | "xlsb"
            | "xls"
            | "ods"
            | "odp"
            | "csv"
    )
}

pub fn convert_bytes(bytes: &[u8], extension: &str) -> Result<Value, Failure> {
    if !supported_format(extension) {
        return Err(Failure::Unsupported);
    }
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(Failure::ResourceLimit);
    }
    limits::check_container(bytes, extension)?;
    spreadsheet::check(bytes, extension)?;
    let (markdown, engine) = match extension {
        "xls" | "xlsb" => (workbook::convert(bytes, extension)?, "calamine"),
        "pdf" if pdf::is_structurally_blank(bytes)? => (String::new(), "anydoc"),
        _ => {
            let format = Format::from_extension(extension).ok_or(Failure::Unsupported)?;
            (
                anydoc::to_markdown_bytes(bytes, format).map_err(anydoc_error)?,
                "anydoc",
            )
        }
    };
    if markdown.len() > MAX_MARKDOWN_BYTES {
        return Err(Failure::ResourceLimit);
    }
    let mut result = json!({"ok": true, "markdown": markdown, "engine": engine});
    if extension == "pdf" {
        // 文字是否需要 OCR 与页面是否包含图像是两个独立结论。
        result["visuals"] = pdf_visuals::inspect(bytes)?;
    }
    Ok(result)
}

pub fn convert_file(path: &Path, extension: &str) -> Result<Value, Failure> {
    if !supported_format(extension) {
        return Err(Failure::Unsupported);
    }
    // 先拒绝符号链接/管道/设备，再对实际打开的句柄复核，避免 FIFO 阻塞和路径竞态。
    let metadata = std::fs::symlink_metadata(path).map_err(|_| Failure::Io)?;
    if !path.is_absolute() || !metadata.is_file() {
        return Err(Failure::Io);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| Failure::Io)?;
    let metadata = file.metadata().map_err(|_| Failure::Io)?;
    if !metadata.is_file() {
        return Err(Failure::Io);
    }
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(Failure::ResourceLimit);
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Io)?;
    convert_bytes(&bytes, extension)
}
