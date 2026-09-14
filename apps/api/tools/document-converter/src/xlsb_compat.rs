//! 将 MS-XLSB 短单元格补齐为 Calamine 支持的完整记录；只处理关系指向的工作表。
use crate::Failure;
use quick_xml::{NsReader, events::Event, name::ResolveResult};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use zip::{ZipArchive, ZipWriter, result::ZipError};

const MAX_INPUT: usize = 100 * 1024 * 1024;
const MAX_EXPANDED: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const PKG: &[u8] = b"http://schemas.openxmlformats.org/package/2006/relationships";
const WORKBOOK: &str = "xl/workbook.bin";
const RELS: &str = "xl/_rels/workbook.bin.rels";
const SST: &str = "xl/sharedStrings.bin";
type Parts = BTreeMap<String, Vec<u8>>;

pub(crate) fn normalize_xlsb(bytes: &[u8]) -> Result<Vec<u8>, Failure> {
    if bytes.len() > MAX_INPUT {
        return Err(Failure::ResourceLimit);
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(zip_error)?;
    if archive.len() > MAX_ENTRIES {
        return Err(Failure::ResourceLimit);
    }
    check_directory(
        bytes,
        archive.central_directory_start() as usize,
        archive.len(),
    )?;
    let mut parts = Parts::new();
    let mut names = HashSet::new();
    let mut expanded = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        if entry.encrypted() {
            return Err(Failure::Encrypted);
        }
        let name = std::str::from_utf8(entry.name_raw()).map_err(|_| Failure::Malformed)?;
        validate_name(name)?;
        if !names.insert(name.to_lowercase()) {
            return Err(Failure::Malformed);
        }
        let name = name.to_owned();
        if entry.size() > (MAX_EXPANDED - expanded) as u64 {
            return Err(Failure::ResourceLimit);
        }
        // 不信任 central directory 的 size；含未引用部件在内，实际解压并读到 EOF 校验 CRC。
        let mut data = Vec::new();
        let mut buffer = [0; 16 * 1024];
        loop {
            let length = entry.read(&mut buffer).map_err(|_| Failure::Malformed)?;
            if length == 0 {
                break;
            }
            extend(&mut data, &buffer[..length], MAX_EXPANDED - expanded)?;
        }
        expanded += data.len();
        parts.insert(name, data);
    }
    let sheets = worksheet_parts(&parts)?;
    let strings = shared_string_count(parts.get(SST).map(Vec::as_slice))?;
    for name in &sheets {
        let original = parts.get(name).ok_or(Failure::MissingPart)?;
        let other_bytes = expanded - original.len();
        let normalized = normalize_sheet(original, strings, MAX_EXPANDED - other_bytes)?;
        expanded = other_bytes + normalized.len();
        parts.insert(name.clone(), normalized);
    }
    let mut writer = ZipWriter::new(BoundedCursor(Cursor::new(Vec::new())));
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(zip_error)?;
        if sheets.contains(entry.name()) {
            // 未改变的部件原样复制压缩数据；工作表保留 ZIP 选项、样式、值和公式缓存。
            writer
                .start_file(entry.name(), entry.options())
                .map_err(zip_error)?;
            writer.write_all(&parts[entry.name()]).map_err(io_error)?;
        } else {
            writer.raw_copy_file(entry).map_err(zip_error)?;
        }
    }
    Ok(writer.finish().map_err(zip_error)?.0.into_inner())
}

fn check_directory(bytes: &[u8], mut position: usize, unique: usize) -> Result<(), Failure> {
    // zip 的 IndexMap 会覆盖同名条目，必须按原始目录计数，不能漏检被覆盖的 ZIP 部件。
    let mut count = 0;
    while bytes.get(position..position.saturating_add(4)) == Some(b"PK\x01\x02") {
        count += 1;
        if count > MAX_ENTRIES {
            return Err(Failure::ResourceLimit);
        }
        let header = bytes
            .get(position..position.saturating_add(46))
            .ok_or(Failure::Malformed)?;
        let variable: usize = [28, 30, 32]
            .iter()
            .map(|&n| u16::from_le_bytes([header[n], header[n + 1]]) as usize)
            .sum();
        position = position
            .checked_add(46 + variable)
            .filter(|&end| end <= bytes.len())
            .ok_or(Failure::Malformed)?;
    }
    if count != unique {
        return Err(Failure::Malformed);
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), Failure> {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains(['\\', ':', '%', '?', '#'])
        || name.chars().any(char::is_control)
        || name
            .trim_end_matches('/')
            .split('/')
            .any(|s| matches!(s, "" | "." | ".."))
    {
        return Err(Failure::Malformed);
    }
    Ok(())
}

fn target(path: &str) -> Result<String, Failure> {
    if path.is_empty()
        || path.starts_with("//")
        || path.ends_with('/')
        || path.contains(['\\', ':', '%', '?', '#'])
        || path.chars().any(char::is_control)
    {
        return Err(Failure::Malformed);
    }
    let mut segments = if path.starts_with('/') {
        vec![]
    } else {
        vec!["xl"]
    };
    for segment in path.split('/') {
        match segment {
            "" | "." => (),
            ".." => {
                segments.pop().ok_or(Failure::Malformed)?;
            }
            _ => segments.push(segment),
        }
    }
    let result = segments.join("/");
    validate_name(&result)?;
    Ok(result)
}

struct Relationship {
    target: String,
    worksheet: bool,
    external: bool,
}

fn relationships(bytes: &[u8]) -> Result<HashMap<String, Relationship>, Failure> {
    std::str::from_utf8(bytes).map_err(|_| Failure::Malformed)?;
    let mut reader = NsReader::from_reader(bytes);
    reader.config_mut().expand_empty_elements = true;
    let mut depth: usize = 0;
    let mut seen_root = false;
    let mut result = HashMap::new();
    loop {
        match reader.read_event().map_err(|_| Failure::Malformed)? {
            Event::Start(start) => {
                let (namespace, _) = reader.resolver().resolve_element(start.name());
                if !matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() == PKG) {
                    return Err(Failure::Malformed);
                }
                match (depth, start.local_name().as_ref()) {
                    (0, b"Relationships") if !seen_root => seen_root = true,
                    (1, b"Relationship") => (),
                    _ => return Err(Failure::Malformed),
                }
                let mut attrs = HashMap::new();
                for attr in start.attributes() {
                    let attr = attr.map_err(|_| Failure::Malformed)?;
                    if attr.key.as_ref() == b"xmlns" || attr.key.as_ref().starts_with(b"xmlns:") {
                        continue;
                    }
                    let value = attr
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::default(),
                            reader.decoder(),
                        )
                        .map_err(|_| Failure::Malformed)?
                        .into_owned();
                    if attrs.insert(attr.key.as_ref().to_vec(), value).is_some() {
                        return Err(Failure::Malformed);
                    }
                }
                if depth == 1 {
                    if result.len() >= MAX_ENTRIES {
                        return Err(Failure::ResourceLimit);
                    }
                    let required = |key: &[u8]| {
                        attrs
                            .get(key)
                            .filter(|v| !v.is_empty())
                            .ok_or(Failure::Malformed)
                    };
                    let kind = required(b"Type")?;
                    let rel = Relationship {
                        target: required(b"Target")?.clone(),
                        worksheet: matches!(
                            kind.as_str(),
                            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
                                | "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet"
                        ),
                        external: match attrs.get(b"TargetMode".as_slice()).map(String::as_str) {
                            None | Some("Internal") => false,
                            Some("External") => true,
                            _ => return Err(Failure::Malformed),
                        },
                    };
                    if result.insert(required(b"Id")?.clone(), rel).is_some() {
                        return Err(Failure::Malformed);
                    }
                }
                depth += 1;
            }
            Event::End(_) => depth = depth.checked_sub(1).ok_or(Failure::Malformed)?,
            Event::Text(text)
                if text
                    .decode()
                    .map_err(|_| Failure::Malformed)?
                    .trim()
                    .is_empty() =>
            {
                ()
            }
            Event::Decl(_) | Event::Comment(_) | Event::PI(_) => (),
            Event::Eof if depth == 0 && seen_root => return Ok(result),
            // 不允许 DTD、实体或嵌套关系；整个流程不解析外部资源。
            _ => return Err(Failure::Malformed),
        }
    }
}

fn worksheet_parts(parts: &Parts) -> Result<HashSet<String>, Failure> {
    let rels = relationships(parts.get(RELS).ok_or(Failure::MissingPart)?)?;
    let mut sheets = HashSet::new();
    for rel in rels.values().filter(|r| r.worksheet) {
        if rel.external {
            return Err(Failure::Malformed);
        }
        let path = target(&rel.target)?;
        if !path.ends_with(".bin") || matches!(path.as_str(), WORKBOOK | SST) {
            return Err(Failure::Malformed);
        }
        if !parts.contains_key(&path) {
            return Err(Failure::MissingPart);
        }
        if !sheets.insert(path) {
            return Err(Failure::Malformed);
        }
    }
    if sheets.len() > 100 {
        return Err(Failure::ResourceLimit);
    }
    // 同时核对 BundleSh 的关系 ID，避免缺失或伪造关系使某张表绕过短记录转换。
    let workbook = parts.get(WORKBOOK).ok_or(Failure::MissingPart)?;
    let mut position = 0;
    let mut ids = HashSet::new();
    let mut sheet_names = HashSet::new();
    let mut phase = 0;
    while position < workbook.len() {
        let (start, kind, data) = record(workbook, &mut position)?;
        match kind {
            0x83 if phase == 0 && start == 0 && data.is_empty() => phase = 1,
            0x8f if phase == 1 && data.is_empty() => phase = 2,
            0x90 if phase == 2 && data.is_empty() => phase = 3,
            0x84 if phase == 3 && data.is_empty() && position == workbook.len() => phase = 4,
            0x83 | 0x8f | 0x90 | 0x84 => return Err(Failure::Malformed),
            _ if phase == 0 => return Err(Failure::Malformed),
            _ => (),
        }
        if kind == 0x9c {
            if phase != 2 {
                return Err(Failure::Malformed);
            }
            if u32_at(data, 0)? > 2 {
                return Err(Failure::Malformed);
            }
            let id_end = wide_end(data, 8)?;
            let end = wide_end(data, id_end)?;
            if end != data.len() {
                return Err(Failure::Malformed);
            }
            let id = wide_text(&data[8..id_end])?;
            let name = wide_text(&data[id_end..])?;
            if id.is_empty()
                || name.is_empty()
                || !ids.insert(id.clone())
                || !sheet_names.insert(name)
            {
                return Err(Failure::Malformed);
            }
            let rel = rels.get(&id).ok_or(Failure::MissingPart)?;
            if !rel.worksheet {
                return Err(Failure::Unsupported);
            }
            if ids.len() > 100 {
                return Err(Failure::ResourceLimit);
            }
        }
    }
    if phase != 4 || ids.len() != sheets.len() {
        return Err(Failure::Malformed);
    }
    Ok(sheets)
}

fn shared_string_count(bytes: Option<&[u8]>) -> Result<u32, Failure> {
    let Some(bytes) = bytes else {
        return Ok(0);
    };
    let mut position = 0;
    let mut expected = None;
    let mut count = 0;
    while position < bytes.len() {
        let (_, kind, data) = record(bytes, &mut position)?;
        match kind {
            0x9f => {
                if data.len() != 8 || expected.is_some() {
                    return Err(Failure::Malformed);
                }
                expected = Some(u32_at(data, 4)?);
            }
            0x13 => {
                wide_end(data, 1)?;
                count += 1;
            }
            _ => (),
        }
    }
    if expected != Some(count) {
        return Err(Failure::Malformed);
    }
    Ok(count)
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, Failure> {
    let value = bytes
        .get(offset..offset.checked_add(4).ok_or(Failure::Malformed)?)
        .ok_or(Failure::Malformed)?;
    Ok(u32::from_le_bytes(
        value.try_into().map_err(|_| Failure::Malformed)?,
    ))
}

fn wide_end(bytes: &[u8], offset: usize) -> Result<usize, Failure> {
    let count = u32_at(bytes, offset)? as usize;
    let start = offset.checked_add(4).ok_or(Failure::Malformed)?;
    let end = count
        .checked_mul(2)
        .and_then(|n| start.checked_add(n))
        .ok_or(Failure::Malformed)?;
    let text = bytes.get(start..end).ok_or(Failure::Malformed)?;
    if char::decode_utf16(
        text.chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]])),
    )
    .any(|c| c.is_err())
    {
        return Err(Failure::Malformed);
    }
    Ok(end)
}

fn wide_text(bytes: &[u8]) -> Result<String, Failure> {
    let end = wide_end(bytes, 0)?;
    String::from_utf16(
        &bytes[4..end]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<_>>(),
    )
    .map_err(|_| Failure::Malformed)
}

fn integer(bytes: &[u8], position: &mut usize, maximum: usize) -> Result<u32, Failure> {
    let mut value = 0;
    for index in 0..maximum {
        let byte = *bytes.get(*position).ok_or(Failure::Malformed)?;
        *position += 1;
        value |= u32::from(byte & 127) << (index * 7);
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err(Failure::Malformed)
}

fn record<'a>(bytes: &'a [u8], position: &mut usize) -> Result<(usize, u16, &'a [u8]), Failure> {
    let start = *position;
    let kind = integer(bytes, position, 2)? as u16;
    let length = integer(bytes, position, 4)? as usize;
    let end = position.checked_add(length).ok_or(Failure::Malformed)?;
    let data = bytes.get(*position..end).ok_or(Failure::Malformed)?;
    *position = end;
    Ok((start, kind, data))
}

fn cell_payload(kind: u16, data: &[u8], header: usize, strings: u32) -> Result<(), Failure> {
    let fixed = match kind {
        1 => Some(header),
        2 | 7 => Some(header + 4),
        3 | 4 => Some(header + 1),
        5 => Some(header + 8),
        6 => Some(wide_end(data, header)?),
        _ => None,
    };
    if let Some(length) = fixed {
        if data.len() != length {
            return Err(Failure::Malformed);
        }
    } else {
        // 公式只校验缓存和两个长度界定的 token 区，绝不解释或执行表达式。
        let cache_end = match kind {
            8 => wide_end(data, header)?,
            9 => header + 8,
            10 | 11 => header + 1,
            _ => return Err(Failure::Unsupported),
        };
        let tokens = cache_end + 2;
        let extra = tokens
            .checked_add(4)
            .and_then(|n| n.checked_add(u32_at(data, tokens).ok()? as usize))
            .ok_or(Failure::Malformed)?;
        let end = extra
            .checked_add(4)
            .and_then(|n| n.checked_add(u32_at(data, extra).ok()? as usize))
            .ok_or(Failure::Malformed)?;
        if data.len() != end {
            return Err(Failure::Malformed);
        }
    }
    if matches!(kind, 4 | 10) && data[header] > 1 {
        return Err(Failure::Malformed);
    }
    if matches!(kind, 3 | 11) && !matches!(data[header], 0 | 7 | 15 | 23 | 29 | 36 | 42 | 43) {
        return Err(Failure::Malformed);
    }
    if kind == 7 && u32_at(data, header)? >= strings {
        return Err(if strings == 0 {
            Failure::MissingPart
        } else {
            Failure::Malformed
        });
    }
    Ok(())
}

fn row_header(data: &[u8]) -> Result<u32, Failure> {
    let row = u32_at(data, 0)?;
    let spans = u32_at(data, 13)? as usize;
    if row >= 1_048_576 || spans > 16 || data.len() != 17 + spans * 8 {
        return Err(Failure::Malformed);
    }
    for span in 0..spans {
        let first = u32_at(data, 17 + span * 8)?;
        let last = u32_at(data, 21 + span * 8)?;
        if first > last || last >= 16_384 {
            return Err(Failure::Malformed);
        }
    }
    Ok(row)
}

fn normalize_sheet(bytes: &[u8], strings: u32, cap: usize) -> Result<Vec<u8>, Failure> {
    let mut output = Vec::new();
    let mut position = 0;
    let mut phase = 0;
    let mut dimensions = false;
    let mut row = None;
    let mut column: Option<u32> = None;
    while position < bytes.len() {
        let (start, kind, data) = record(bytes, &mut position)?;
        match kind {
            0x81 if phase == 0 && start == 0 && data.is_empty() => phase = 1,
            0x94 if phase == 1 && !dimensions => {
                if data.len() != 16
                    || u32_at(data, 0)? > u32_at(data, 4)?
                    || u32_at(data, 8)? > u32_at(data, 12)?
                    || u32_at(data, 4)? >= 1_048_576
                    || u32_at(data, 12)? >= 16_384
                {
                    return Err(Failure::Malformed);
                }
                dimensions = true;
            }
            0x91 if phase == 1 && dimensions && data.is_empty() => phase = 2,
            0x92 if phase == 2 && data.is_empty() => phase = 3,
            0x82 if phase == 3 && data.is_empty() && position == bytes.len() => phase = 4,
            0x81 | 0x82 | 0x91 | 0x92 | 0x94 => return Err(Failure::Malformed),
            0 => {
                if phase != 2 {
                    return Err(Failure::Malformed);
                }
                let next = row_header(data)?;
                if row.is_some_and(|previous| next <= previous) {
                    return Err(Failure::Malformed);
                }
                row = Some(next);
                column = None;
            }
            1..=0x12 | 0x3e => {
                let row = row.filter(|_| phase == 2).ok_or(Failure::Malformed)?;
                let short = (0x0c..=0x12).contains(&kind);
                let full = if short { kind - 0x0b } else { kind };
                let col = if short {
                    column
                        .map(|v| v.checked_add(1).ok_or(Failure::Malformed))
                        .transpose()?
                        .unwrap_or(0)
                } else {
                    u32_at(data, 0)?
                };
                if col >= 16_384 || column.is_some_and(|previous| col <= previous) {
                    return Err(Failure::Malformed);
                }
                column = Some(col);
                // 只限制实际值的范围；RowHdr、WsDim 和带格式的空格不扩张数据范围。
                if full != 1 && (row >= 10_000 || col >= 256) {
                    return Err(Failure::ResourceLimit);
                }
                // 零负载 ShortBlank 表示无格式空格；SheetJS 四字节 ShortCell 变体保留其样式。
                let payload = if kind == 0x0c && data.is_empty() {
                    &[0; 4][..]
                } else {
                    data
                };
                // SheetJS 的 ShortError 写入三个保留零字节；正规 CellError 仅需一字节错误值。
                let payload = if kind == 0x0e && payload.len() == 8 && payload[5..] == [0; 3] {
                    &payload[..5]
                } else {
                    payload
                };
                cell_payload(full, payload, if short { 4 } else { 8 }, strings)?;
                if short {
                    let length = payload.len().checked_add(4).ok_or(Failure::ResourceLimit)?;
                    extend(&mut output, &[full as u8], cap)?;
                    write_integer(&mut output, length, cap)?;
                    extend(&mut output, &col.to_le_bytes(), cap)?;
                    extend(&mut output, payload, cap)?;
                    continue;
                }
            }
            _ if phase == 0 => return Err(Failure::Malformed),
            _ => (), // 未知记录逐字节保留，不把 workbook/SST 记录误认作工作表单元格。
        }
        extend(&mut output, &bytes[start..position], cap)?;
    }
    if phase != 4 {
        return Err(Failure::Malformed);
    }
    Ok(output)
}

fn write_integer(output: &mut Vec<u8>, mut value: usize, cap: usize) -> Result<(), Failure> {
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        extend(output, &[byte | if value == 0 { 0 } else { 128 }], cap)?;
        if value == 0 {
            return Ok(());
        }
    }
}

fn extend(output: &mut Vec<u8>, bytes: &[u8], cap: usize) -> Result<(), Failure> {
    if bytes.len() > cap.saturating_sub(output.len()) {
        return Err(Failure::ResourceLimit);
    }
    output
        .try_reserve(bytes.len())
        .map_err(|_| Failure::ResourceLimit)?;
    output.extend_from_slice(bytes);
    Ok(())
}

struct BoundedCursor(Cursor<Vec<u8>>);
impl Write for BoundedCursor {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let end = self
            .0
            .position()
            .checked_add(bytes.len() as u64)
            .filter(|end| *end <= MAX_INPUT as u64)
            .ok_or_else(|| io::Error::from(io::ErrorKind::FileTooLarge))?;
        if end as usize > self.0.get_ref().capacity() {
            let capacity = self
                .0
                .get_ref()
                .capacity()
                .saturating_mul(2)
                .max(end as usize)
                .min(MAX_INPUT);
            let additional = capacity - self.0.get_ref().len();
            self.0
                .get_mut()
                .try_reserve_exact(additional)
                .map_err(|_| io::Error::from(io::ErrorKind::FileTooLarge))?;
        }
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Seek for BoundedCursor {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.0.seek(from)
    }
}
fn io_error(error: io::Error) -> Failure {
    if error.kind() == io::ErrorKind::FileTooLarge {
        Failure::ResourceLimit
    } else {
        Failure::Malformed
    }
}
fn zip_error(error: ZipError) -> Failure {
    match error {
        ZipError::Io(error) => io_error(error),
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => Failure::Encrypted,
        ZipError::UnsupportedArchive(_) => Failure::Unsupported,
        ZipError::FileNotFound => Failure::MissingPart,
        _ => Failure::Malformed,
    }
}

#[cfg(test)]
#[path = "../tests/support/xlsb_compat.rs"]
mod tests;
