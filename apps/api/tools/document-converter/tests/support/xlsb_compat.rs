// 本文件由 xlsb_compat 的 cfg(test) 引入，不依赖或修改其他测试夹具。
use super::*;
use calamine::{CellErrorType, Data, Reader, Xlsb};
use zip::{CompressionMethod, write::SimpleFileOptions};

fn rec(kind: u16, data: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    write_integer(&mut result, kind as usize, usize::MAX).unwrap();
    write_integer(&mut result, data.len(), usize::MAX).unwrap();
    result.extend(data);
    result
}
fn wide(text: &str) -> Vec<u8> {
    let mut result = (text.encode_utf16().count() as u32).to_le_bytes().to_vec();
    result.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    result
}
fn row(number: u32) -> Vec<u8> {
    rec(0, &[number.to_le_bytes().as_slice(), &[0; 13]].concat())
}
fn short(kind: u16, value: &[u8]) -> Vec<u8> {
    rec(kind, &[&[0; 4], value].concat())
}
fn full(kind: u16, column: u32, value: &[u8]) -> Vec<u8> {
    rec(
        kind,
        &[column.to_le_bytes().as_slice(), &[0; 4], value].concat(),
    )
}
fn sheet(body: &[u8]) -> Vec<u8> {
    [
        rec(0x81, &[]),
        rec(0x94, &[0; 16]),
        rec(0x91, &[]),
        body.to_vec(),
        rec(0x92, &[]),
        rec(0x82, &[]),
    ]
    .concat()
}
fn package(sheets: &[Vec<u8>]) -> Parts {
    let mut workbook = [rec(0x83, &[]), rec(0x8f, &[])].concat();
    let mut rels = String::from(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    let mut parts = Parts::new();
    for (index, sheet) in sheets.iter().enumerate() {
        let id = format!("rId{index}");
        workbook.extend(rec(
            0x9c,
            &[
                &[0; 4],
                (index as u32 + 1).to_le_bytes().as_slice(),
                &wide(&id),
                &wide(&format!("表{index}")),
            ]
            .concat(),
        ));
        rels.push_str(&format!("<Relationship Id=\"{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.bin\"/>"));
        parts.insert(format!("xl/worksheets/sheet{index}.bin"), sheet.clone());
    }
    workbook.extend(rec(0x90, &[]));
    workbook.extend(rec(0x84, &[]));
    rels.push_str("</Relationships>");
    parts.insert(WORKBOOK.into(), workbook);
    parts.insert(RELS.into(), rels.into_bytes());
    parts
}
fn zip(parts: &Parts) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in parts {
        writer
            .start_file(
                name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn unzip(bytes: &[u8]) -> Parts {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    (0..archive.len())
        .map(|index| {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            (name, bytes)
        })
        .collect()
}
fn records(bytes: &[u8]) -> Vec<(u16, Vec<u8>)> {
    let mut position = 0;
    let mut result = Vec::new();
    while position < bytes.len() {
        let (_, kind, data) = record(bytes, &mut position).unwrap();
        result.push((kind, data.to_vec()));
    }
    result
}
fn formula(kind: u16, column: u32) -> Vec<u8> {
    let cache = match kind {
        8 => wide("缓存😀"),
        9 => 42.5f64.to_le_bytes().to_vec(),
        10 => vec![1],
        11 => vec![7],
        _ => unreachable!(),
    };
    // 字节仅用于测试长度和原样保留，不调用 worksheet_formula。
    full(
        kind,
        column,
        &[cache, vec![0; 2], vec![3, 0, 0, 0, 0x1e, 1, 0], vec![0; 4]].concat(),
    )
}
fn normalize(body: &[u8]) -> Result<Vec<u8>, Failure> {
    normalize_sheet(&sheet(body), 1, MAX_EXPANDED)
}

#[test]
fn seven_short_types_and_styles_become_complete_cells() {
    let values = [
        vec![],
        (42u32 << 2 | 2).to_le_bytes().to_vec(),
        vec![7],
        vec![1],
        2.25f64.to_le_bytes().to_vec(),
        wide("短文本😀"),
        0u32.to_le_bytes().to_vec(),
    ];
    let style = [0x12, 0x34, 0x56, 0x80];
    let mut body = row(0);
    for (index, value) in values.iter().enumerate() {
        body.extend(rec(
            0x0c + index as u16,
            &[style.as_slice(), value].concat(),
        ));
    }
    let output = normalize(&body).unwrap();
    let cells: Vec<_> = records(&output)
        .into_iter()
        .filter(|(k, _)| (1..=7).contains(k))
        .collect();
    assert_eq!(cells.len(), 7);
    for (index, (kind, data)) in cells.iter().enumerate() {
        assert_eq!(*kind, index as u16 + 1);
        assert_eq!(u32_at(data, 0).unwrap(), index as u32);
        assert_eq!(&data[4..8], &style);
        assert_eq!(&data[8..], &values[index]);
    }
    let mut parts = package(&[sheet(&body)]);
    parts.insert(
        SST.into(),
        [
            rec(0x9f, &[1, 0, 0, 0, 1, 0, 0, 0]),
            rec(0x13, &[vec![0], wide("共享值")].concat()),
            rec(0xa0, &[]),
        ]
        .concat(),
    );
    let result = normalize_xlsb(&zip(&parts)).unwrap();
    let mut workbook = Xlsb::new(Cursor::new(&result)).unwrap();
    let range = workbook.worksheet_range("表0").unwrap();
    assert_eq!(range.get_value((0, 1)), Some(&Data::Int(42)));
    assert_eq!(
        range.get_value((0, 2)),
        Some(&Data::Error(CellErrorType::Div0))
    );
    assert_eq!(range.get_value((0, 3)), Some(&Data::Bool(true)));
    assert_eq!(range.get_value((0, 4)), Some(&Data::Float(2.25)));
    assert_eq!(
        range.get_value((0, 5)),
        Some(&Data::String("短文本😀".into()))
    );
    assert_eq!(
        range.get_value((0, 6)),
        Some(&Data::String("共享值".into()))
    );
    let after = unzip(&result);
    assert_eq!(after[SST], parts[SST]);
    assert_eq!(after[WORKBOOK], parts[WORKBOOK]);
}

#[test]
fn blanks_advance_columns_and_each_all_short_row_restarts_at_a() {
    let body = [
        row(0),
        short(0x11, &wide("左")),
        rec(0x0c, &[]),
        short(0x11, &wide("右")),
        row(1),
        short(0x11, &wide("下一行")),
        short(0x0c, &[]),
        short(0x11, &wide("末列")),
    ]
    .concat();
    let bytes = normalize_xlsb(&zip(&package(&[sheet(&body)]))).unwrap();
    let mut workbook = Xlsb::new(Cursor::new(bytes)).unwrap();
    let range = workbook.worksheet_range("表0").unwrap();
    assert_eq!(range.get_value((0, 0)), Some(&Data::String("左".into())));
    assert_eq!(range.get_value((0, 1)), Some(&Data::Empty));
    assert_eq!(range.get_value((0, 2)), Some(&Data::String("右".into())));
    assert_eq!(
        range.get_value((1, 0)),
        Some(&Data::String("下一行".into()))
    );
    assert_eq!(range.get_value((1, 2)), Some(&Data::String("末列".into())));
}

#[test]
fn full_cells_all_formula_caches_and_unknown_records_keep_column_state() {
    let mut body = row(0);
    body.extend(full(1, 3, &[]));
    body.extend(short(0x11, &wide("空格之后")));
    let unknown = rec(0x1234, &[0x11, 0x0d, 0xff]);
    body.extend(&unknown);
    for kind in 8..=11 {
        body.extend(formula(kind, (kind - 8) as u32 * 3 + 7));
        body.extend(short(0x11, &wide("公式之后")));
    }
    let result = normalize(&body).unwrap();
    assert!(result.windows(unknown.len()).any(|v| v == unknown));
    for kind in 8..=11 {
        let original = formula(kind, (kind - 8) as u32 * 3 + 7);
        assert!(result.windows(original.len()).any(|v| v == original));
    }
    let columns: Vec<_> = records(&result)
        .iter()
        .filter(|(k, _)| *k == 6)
        .map(|(_, d)| u32_at(d, 0).unwrap())
        .collect();
    assert_eq!(columns, [4, 8, 11, 14, 17]);
}

#[test]
fn sheetjs_padded_short_error_is_normalized_without_reserved_tail() {
    let body = [row(0), rec(0x0e, &[0, 0, 0, 0, 7, 0, 0, 0])].concat();
    let output = records(&normalize(&body).unwrap());
    let data = &output.iter().find(|(kind, _)| *kind == 3).unwrap().1;
    assert_eq!(data, &[0, 0, 0, 0, 0, 0, 0, 0, 7]);
}

#[test]
fn real_sheetjs_smoke_fixtures_keep_every_sheet_and_last_column() {
    // 来自 scratch/import-smoke.xlsb 与 import-compressed-smoke.xlsb 的合成冒烟夹具。
    let original = include_bytes!("xlsb-short-real.xlsb");
    let normalized = normalize_xlsb(original).unwrap();
    let mut workbook = Xlsb::new(Cursor::new(&normalized)).unwrap();
    let names = workbook.sheet_names();
    assert_eq!(names.len(), 2);
    let first = workbook.worksheet_range(&names[0]).unwrap();
    assert_eq!(first.get_size(), (3, 3));
    assert_eq!(first.get_value((0, 1)), Some(&Data::String("金额".into())));
    assert_eq!(first.get_value((0, 2)), Some(&Data::String("备注".into())));
    assert_eq!(first.get_value((1, 1)), Some(&Data::Int(42)));
    assert_eq!(
        first.get_value((1, 2)),
        Some(&Data::String("管道|内容".into()))
    );
    assert_eq!(first.get_value((2, 1)), Some(&Data::Int(84)));
    assert_eq!(
        first.get_value((2, 2)),
        Some(&Data::String("最后一列".into()))
    );
    let second = workbook.worksheet_range(&names[1]).unwrap();
    assert_eq!(second.get_size(), (2, 2));
    assert_eq!(
        second.get_value((1, 1)),
        Some(&Data::String("末尾标记".into()))
    );
    let before = unzip(original);
    let after = unzip(&normalized);
    for (path, data) in before
        .iter()
        .filter(|(p, _)| !p.starts_with("xl/worksheets/"))
    {
        assert_eq!(&after[path], data, "{path}");
    }
    let compressed = normalize_xlsb(include_bytes!("xlsb-short-compressed-real.xlsb")).unwrap();
    let mut workbook = Xlsb::new(Cursor::new(compressed)).unwrap();
    assert_eq!(workbook.sheet_names().len(), 1);
    let first = workbook
        .worksheet_range(&workbook.sheet_names()[0])
        .unwrap();
    assert_eq!(first.get_size(), (3, 3));
    assert_eq!(first.get_value((1, 1)), Some(&Data::Empty));
    assert_eq!(first.get_value((1, 2)), Some(&Data::String("末列".into())));
    assert_eq!(first.get_value((2, 2)), Some(&Data::String("完整".into())));
}

#[test]
fn invalid_lengths_utf16_and_record_headers_are_rejected() {
    for (kind, payload) in [
        (0x0c, vec![0]),
        (0x0d, vec![0; 7]),
        (0x0e, vec![0; 6]),
        (0x0f, vec![0; 6]),
        (0x10, vec![0; 11]),
        (0x11, vec![0; 7]),
        (0x12, vec![0; 7]),
        (1, vec![0; 7]),
        (2, vec![0; 11]),
        (3, vec![0; 8]),
        (4, vec![0; 8]),
        (5, vec![0; 15]),
        (6, vec![0; 11]),
        (7, vec![0; 11]),
    ] {
        assert_eq!(
            normalize(&[row(0), rec(kind, &payload)].concat()),
            Err(Failure::Malformed),
            "{kind:x}"
        );
    }
    for text in [
        vec![1, 0, 0, 0, 0, 0xd8],
        vec![1, 0, 0, 0, 0, 0xdc],
        vec![2, 0, 0, 0, 65, 0],
        vec![0xff; 4],
    ] {
        assert_eq!(
            normalize(&[row(0), short(0x11, &text)].concat()),
            Err(Failure::Malformed)
        );
    }
    for malformed in [
        vec![0x80],
        vec![0x80, 0x80],
        vec![0x11, 0x80],
        vec![0x11, 0xff, 0xff, 0xff, 0xff, 0x00],
        vec![0x11, 0x7f],
    ] {
        assert_eq!(
            normalize(&[row(0), malformed].concat()),
            Err(Failure::Malformed)
        );
    }
    for kind in 8..=11 {
        let mut broken = records(&formula(kind, 0)).remove(0).1;
        broken.pop();
        assert_eq!(
            normalize(&[row(0), rec(kind, &broken)].concat()),
            Err(Failure::Malformed)
        );
    }
    assert_eq!(
        normalize(&[row(0), short(0x0f, &[2])].concat()),
        Err(Failure::Malformed)
    );
}

#[test]
fn absent_headers_disorder_physical_overflow_and_shared_indexes_fail() {
    let value = short(0x11, &wide("值"));
    for body in [
        value.clone(),
        [row(0), row(0), value.clone()].concat(),
        [row(1), row(0), value.clone()].concat(),
        [row(1_048_576), value.clone()].concat(),
        [row(0), full(1, 2, &[]), full(1, 1, &[])].concat(),
        [row(0), full(1, 16_383, &[]), rec(0x0c, &[])].concat(),
        [row(0), full(1, u32::MAX, &[])].concat(),
        [rec(0, &[0; 16]), value].concat(),
    ] {
        assert_eq!(normalize(&body), Err(Failure::Malformed));
    }
    assert_eq!(
        normalize(&[row(0), short(0x12, &1u32.to_le_bytes())].concat()),
        Err(Failure::Malformed)
    );
    assert_eq!(
        normalize_sheet(
            &sheet(&[row(0), short(0x12, &[0; 4])].concat()),
            0,
            MAX_EXPANDED
        ),
        Err(Failure::MissingPart)
    );
    assert_eq!(
        normalize_sheet(&rec(0x91, &[]), 0, MAX_EXPANDED),
        Err(Failure::Malformed)
    );
}

#[test]
fn only_actual_values_enforce_row_and_column_limits() {
    for body in [
        [row(10_000), short(0x11, &wide("值"))].concat(),
        [row(0), full(6, 256, &wide("值"))].concat(),
        [row(0), full(1, 255, &[]), short(0x11, &wide("值"))].concat(),
    ] {
        assert_eq!(normalize(&body), Err(Failure::ResourceLimit));
    }
    assert!(normalize(&[row(9_999), full(6, 255, &wide("边界"))].concat()).is_ok());
    assert!(normalize(&[row(1_048_575), full(1, 16_383, &[])].concat()).is_ok());
    let mut metadata = sheet(&[row(0), short(0x11, &wide("值"))].concat());
    let offset = rec(0x81, &[]).len() + 3;
    metadata[offset + 4..offset + 8].copy_from_slice(&1_048_575u32.to_le_bytes());
    metadata[offset + 12..offset + 16].copy_from_slice(&16_383u32.to_le_bytes());
    assert!(normalize_sheet(&metadata, 0, MAX_EXPANDED).is_ok());
}

#[test]
fn relationships_paths_missing_sheets_and_nonworksheet_parts_are_checked() {
    let mut parts = package(&[sheet(&[row(0), short(0x11, &wide("值"))].concat())]);
    // 未引用的 bin 不是 worksheet，即使内部字节看起来像短记录也不能改写。
    parts.insert("xl/worksheets/unreferenced.bin".into(), rec(0x11, &[]));
    parts.insert("xl/vbaProject.bin".into(), rec(0x0d, &[1, 2, 3]));
    let normalized = unzip(&normalize_xlsb(&zip(&parts)).unwrap());
    assert_eq!(
        normalized["xl/worksheets/unreferenced.bin"],
        parts["xl/worksheets/unreferenced.bin"]
    );
    assert_eq!(normalized["xl/vbaProject.bin"], parts["xl/vbaProject.bin"]);
    for bad in [
        "../../outside.bin",
        "https://example.invalid/sheet.bin",
        "worksheets/../workbook.bin",
        "sharedStrings.bin",
        "worksheets/%2e%2e/sheet.bin",
        "worksheets\\sheet0.bin",
    ] {
        let mut changed = parts.clone();
        changed.insert(
            RELS.into(),
            String::from_utf8(parts[RELS].clone())
                .unwrap()
                .replace("worksheets/sheet0.bin", bad)
                .into_bytes(),
        );
        assert_eq!(
            normalize_xlsb(&zip(&changed)),
            Err(Failure::Malformed),
            "{bad}"
        );
    }
    let mut missing = parts.clone();
    missing.remove("xl/worksheets/sheet0.bin");
    assert_eq!(normalize_xlsb(&zip(&missing)), Err(Failure::MissingPart));
    let rels = String::from_utf8(parts[RELS].clone()).unwrap();
    for xml in [
        rels.replace("Target=", "TargetMode=\"External\" Target="),
        rels.replace("rId0", "missing"),
        rels.replace("</Relationships>", ""),
        rels.replace("<Relationship Id", "<Relationship Id=\"dup\" Id"),
        rels.replace("package/2006/relationships", "wrong-namespace"),
        format!("<!DOCTYPE x [<!ENTITY e SYSTEM 'https://example.invalid'>]>{rels}"),
    ] {
        let mut changed = parts.clone();
        changed.insert(RELS.into(), xml.into_bytes());
        assert!(normalize_xlsb(&zip(&changed)).is_err());
    }
    for path in [
        "worksheets/./sheet0.bin",
        "/xl/worksheets/sheet0.bin",
        "../xl/worksheets/sheet0.bin",
    ] {
        let mut changed = parts.clone();
        changed.insert(
            RELS.into(),
            rels.replace("worksheets/sheet0.bin", path).into_bytes(),
        );
        assert!(normalize_xlsb(&zip(&changed)).is_ok());
    }
}

#[test]
fn input_entries_actual_expansion_crc_and_new_output_are_bounded() {
    assert_eq!(
        normalize_xlsb(&vec![0; MAX_INPUT + 1]),
        Err(Failure::ResourceLimit)
    );
    let parts: Parts = (0..=MAX_ENTRIES)
        .map(|n| (format!("p{n}"), Vec::new()))
        .collect();
    assert_eq!(normalize_xlsb(&zip(&parts)), Err(Failure::ResourceLimit));
    let parts = Parts::from([
        ("a".into(), vec![0; MAX_EXPANDED / 2]),
        ("b".into(), vec![0; MAX_EXPANDED / 2 + 1]),
    ]);
    let mut expanded = zip(&parts);
    assert_eq!(normalize_xlsb(&expanded), Err(Failure::ResourceLimit));
    // 两个条目的声明尺寸都缩成一字节，实际解压仍必须累计受限（或被 ZIP 校验拒绝）。
    let directories: Vec<_> = expanded
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"PK\x01\x02")
        .map(|(n, _)| n)
        .collect();
    for offset in directories {
        expanded[offset + 24..offset + 28].copy_from_slice(&1u32.to_le_bytes());
    }
    assert!(matches!(
        normalize_xlsb(&expanded),
        Err(Failure::ResourceLimit | Failure::Malformed)
    ));
    let body = sheet(&[row(0), rec(0x0c, &[])].concat());
    assert_eq!(
        normalize_sheet(&body, 0, body.len()),
        Err(Failure::ResourceLimit)
    );
    let mut output = BoundedCursor(Cursor::new(Vec::new()));
    output.seek(SeekFrom::Start(MAX_INPUT as u64)).unwrap();
    assert_eq!(
        io_error(output.write_all(&[0]).unwrap_err()),
        Failure::ResourceLimit
    );
    assert!(output.0.get_ref().is_empty());
    let mut corrupt = zip(&package(&[sheet(&[])]));
    // 修改首个 central directory 的 CRC；必须实际读到 EOF 才能发现错误。
    let cd = corrupt.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    corrupt[cd + 16] ^= 1;
    assert_eq!(normalize_xlsb(&corrupt), Err(Failure::Malformed));
}

#[test]
fn duplicate_zip_entries_and_out_of_order_bundle_sheets_cannot_hide_data() {
    let mut bytes = zip(&Parts::from([("a".into(), vec![1]), ("b".into(), vec![2])]));
    let cd = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    bytes[cd + 47 + 46] = b'a';
    assert_eq!(normalize_xlsb(&bytes), Err(Failure::Malformed));
    let mut parts = package(&[sheet(&[])]);
    let mut workbook = records(&parts[WORKBOOK]);
    workbook.swap(2, 3); // BundleSh 被放到 EndBundleShs 之后，Calamine 原本会跳过它。
    parts.insert(
        WORKBOOK.into(),
        workbook.iter().flat_map(|(k, d)| rec(*k, d)).collect(),
    );
    assert_eq!(normalize_xlsb(&zip(&parts)), Err(Failure::Malformed));
}
