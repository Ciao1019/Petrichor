use crate::{Failure, MAX_SOURCE_BYTES};
use std::io::{Cursor, Read};

pub(crate) fn check(bytes: &[u8], extension: &str) -> Result<(), Failure> {
    if extension != "xls" && !bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
        return Ok(());
    }
    let mut compound =
        cfb::CompoundFile::open(Cursor::new(bytes)).map_err(|_| Failure::Malformed)?;
    if compound.is_stream("/EncryptedPackage") || compound.is_stream("/EncryptionInfo") {
        return Err(Failure::Encrypted);
    }
    if extension != "xls" {
        return Err(Failure::Malformed);
    }
    let name = ["/Workbook", "/Book", "/WORKBOOK", "/BOOK"]
        .into_iter()
        .find(|name| compound.is_stream(name))
        .ok_or(Failure::MissingPart)?;
    let stream = compound.open_stream(name).map_err(|_| Failure::Malformed)?;
    let mut workbook = Vec::new();
    stream
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut workbook)
        .map_err(|_| Failure::Malformed)?;
    if workbook.len() as u64 > MAX_SOURCE_BYTES {
        return Err(Failure::ResourceLimit);
    }
    let mut offsets = Vec::new();
    records(&workbook, true, &mut offsets)?;
    if offsets.len() > 100 {
        return Err(Failure::ResourceLimit);
    }
    for offset in offsets {
        records(
            workbook.get(offset..).ok_or(Failure::Malformed)?,
            false,
            &mut Vec::new(),
        )?;
    }
    Ok(())
}

fn records(mut bytes: &[u8], globals: bool, offsets: &mut Vec<usize>) -> Result<(), Failure> {
    let mut first = true;
    loop {
        let header = bytes.get(..4).ok_or(Failure::Malformed)?;
        let kind = u16::from_le_bytes([header[0], header[1]]);
        let length = u16::from_le_bytes([header[2], header[3]]) as usize;
        let data = bytes.get(4..4 + length).ok_or(Failure::Malformed)?;
        bytes = &bytes[4 + length..];
        if first && !matches!(kind, 0x0809 | 0x0409 | 0x0209 | 0x0009) {
            return Err(Failure::Malformed);
        }
        first = false;
        // FilePass 的 XOR 变体首字为 0，Calamine 仅检查非零，必须在入口统一拒绝。
        if globals && kind == 0x002f {
            return Err(Failure::Encrypted);
        }
        if globals && kind == 0x0085 {
            let offset = data.get(..4).ok_or(Failure::Malformed)?;
            offsets.push(
                u32::from_le_bytes(offset.try_into().map_err(|_| Failure::Malformed)?) as usize,
            );
        }
        if kind == 0x000a {
            return Ok(());
        }
    }
}
