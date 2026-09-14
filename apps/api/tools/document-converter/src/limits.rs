use crate::Failure;
use std::io::{Cursor, Read};
use zip::{ZipArchive, result::ZipError};

pub const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;
const MAX_ZIP_EXPANDED: u64 = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 10_000;

pub(crate) fn zip_error(error: ZipError) -> Failure {
    match error {
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => Failure::Encrypted,
        ZipError::UnsupportedArchive(_) => Failure::Unsupported,
        ZipError::FileNotFound => Failure::MissingPart,
        _ => Failure::Malformed,
    }
}

pub(crate) fn check_container(bytes: &[u8], extension: &str) -> Result<(), Failure> {
    // 加密 Office 文件使用 OLE 外壳，由对应解析器识别，不能误报 ZIP 损坏。
    if bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
        return Ok(());
    }
    let requires_zip = matches!(
        extension,
        "docx"
            | "docm"
            | "odt"
            | "pptx"
            | "pptm"
            | "ppsx"
            | "ppsm"
            | "epub"
            | "xlsx"
            | "xlsm"
            | "xlsb"
            | "ods"
            | "odp"
    );
    if requires_zip || bytes.starts_with(b"PK") {
        check_zip(bytes)?;
    }
    Ok(())
}

fn check_zip(bytes: &[u8]) -> Result<(), Failure> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(zip_error)?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(Failure::ResourceLimit);
    }
    let mut expanded = 0u64;
    let mut buffer = [0u8; 16 * 1024];
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        if entry.encrypted() {
            return Err(Failure::Encrypted);
        }
        // size 仅用于提前拒绝；所有条目（含未被转换器引用的条目）都必须实际读完并校验 CRC。
        if entry.size() > MAX_ZIP_EXPANDED - expanded {
            return Err(Failure::ResourceLimit);
        }
        loop {
            let length = entry.read(&mut buffer).map_err(|_| Failure::Malformed)?;
            if length == 0 {
                break;
            }
            expanded += length as u64;
            if expanded > MAX_ZIP_EXPANDED {
                return Err(Failure::ResourceLimit);
            }
        }
    }
    Ok(())
}

pub(crate) fn append(output: &mut String, text: &str) -> Result<(), Failure> {
    if text.len() > MAX_MARKDOWN_BYTES.saturating_sub(output.len()) {
        return Err(Failure::ResourceLimit);
    }
    output.push_str(text);
    Ok(())
}
