#![allow(dead_code)]
// 测试夹具完全在内存构造，不含第三方文档或用户数据。
pub mod xml;
use std::io::{Cursor, Write};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub fn zip(parts: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in parts {
        // ODF 的首个 mimetype 条目必须不压缩。
        let compression = if name == "mimetype" {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        };
        writer
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(compression),
            )
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

pub fn ole(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut writer = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    writer
        .create_stream(name)
        .unwrap()
        .write_all(bytes)
        .unwrap();
    writer.into_inner().into_inner()
}

pub fn biff(kind: u16, data: &[u8]) -> Vec<u8> {
    [
        kind.to_le_bytes().as_slice(),
        (data.len() as u16).to_le_bytes().as_slice(),
        data,
    ]
    .concat()
}

fn bof(kind: u16) -> Vec<u8> {
    biff(
        0x0809,
        &[
            0x00, 0x06, kind as u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
    )
}

pub fn xls_sheet(cells: &[(u16, u16, &str)]) -> Vec<u8> {
    let mut sheet = bof(0x10);
    for (row, col, text) in cells {
        let mut data = [row.to_le_bytes(), col.to_le_bytes(), [0, 0]].concat();
        data.extend((text.encode_utf16().count() as u16).to_le_bytes());
        data.push(1);
        for ch in text.encode_utf16() {
            data.extend(ch.to_le_bytes());
        }
        sheet.extend(biff(0x0204, &data));
    }
    sheet.extend(biff(0x000a, &[]));
    sheet
}

pub fn xls(sheets: &[(String, bool, Vec<u8>)]) -> Vec<u8> {
    let mut globals = bof(5);
    let mut positions = Vec::new();
    for (name, hidden, _) in sheets {
        let mut data = vec![0, 0, 0, 0, u8::from(*hidden), 0, name.len() as u8, 0];
        data.extend(name.as_bytes());
        positions.push(globals.len() + 4);
        globals.extend(biff(0x0085, &data));
    }
    globals.extend(biff(0x000a, &[]));
    for ((_, _, sheet), position) in sheets.iter().zip(positions) {
        let offset = (globals.len() as u32).to_le_bytes();
        globals[position..position + 4].copy_from_slice(&offset);
        globals.extend(sheet);
    }
    ole("/Workbook", &globals)
}

pub fn xls_encrypted() -> Vec<u8> {
    ole(
        "/Workbook",
        &[bof(5), biff(0x002f, &[0, 0, 1, 0, 2, 0]), biff(0x000a, &[])].concat(),
    )
}

pub fn record(kind: u16, data: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    if kind < 128 {
        output.push(kind as u8);
    } else {
        output.extend([(kind as u8 & 127) | 128, (kind >> 7) as u8]);
    }
    let mut length = data.len();
    loop {
        let byte = (length & 127) as u8;
        length >>= 7;
        output.push(if length == 0 { byte } else { byte | 128 });
        if length == 0 {
            break;
        }
    }
    output.extend(data);
    output
}

fn wide(text: &str) -> Vec<u8> {
    let mut data = (text.encode_utf16().count() as u32).to_le_bytes().to_vec();
    for ch in text.encode_utf16() {
        data.extend(ch.to_le_bytes());
    }
    data
}

pub fn xlsb_sheet(cells: &[(u32, u32, &str)]) -> Vec<u8> {
    let mut data = record(0x81, &[]); // BrtBeginSheet
    let last_row = cells.iter().map(|v| v.0).max().unwrap_or(0);
    let last_col = cells.iter().map(|v| v.1).max().unwrap_or(0);
    data.extend(record(
        0x94,
        &[
            0u32.to_le_bytes(),
            last_row.to_le_bytes(),
            0u32.to_le_bytes(),
            last_col.to_le_bytes(),
        ]
        .concat(),
    ));
    data.extend(record(0x91, &[])); // BrtBeginSheetData
    let mut current_row = None;
    for (row, col, text) in cells {
        if current_row != Some(*row) {
            let mut header = row.to_le_bytes().to_vec();
            header.extend([0; 13]);
            data.extend(record(0, &header));
            current_row = Some(*row);
        }
        let mut cell = [col.to_le_bytes(), 0u32.to_le_bytes()].concat();
        cell.extend(wide(text));
        data.extend(record(6, &cell)); // BrtCellSt
    }
    data.extend(record(0x92, &[])); // BrtEndSheetData
    data.extend(record(0x82, &[])); // BrtEndSheet
    data
}

pub fn xlsb(sheets: &[(String, bool, Option<Vec<u8>>)]) -> Vec<u8> {
    let mut workbook = record(0x83, &[]);
    workbook.extend(record(0x8f, &[]));
    let mut rels = String::from(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    let mut parts = Vec::new();
    for (index, (name, hidden, sheet)) in sheets.iter().enumerate() {
        let id = format!("rId{}", index + 1);
        let mut bundle = [
            u32::from(*hidden).to_le_bytes(),
            (index as u32 + 1).to_le_bytes(),
        ]
        .concat();
        bundle.extend(wide(&id));
        bundle.extend(wide(name));
        workbook.extend(record(0x9c, &bundle));
        rels.push_str(&format!("<Relationship Id=\"{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.bin\"/>"));
        if let Some(sheet) = sheet {
            parts.push((format!("xl/worksheets/sheet{index}.bin"), sheet.clone()));
        }
    }
    workbook.extend(record(0x90, &[]));
    workbook.extend(record(0x84, &[]));
    rels.push_str("</Relationships>");
    parts.push(("xl/workbook.bin".into(), workbook));
    parts.push(("xl/_rels/workbook.bin.rels".into(), rels.into_bytes()));
    zip(parts)
}
