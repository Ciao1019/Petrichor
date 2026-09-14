mod support;
use calamine::{Reader, Xls, Xlsb};
use petrichor_doc_convert::convert_bytes;
use std::io::Cursor;
use support::*;

fn unicode(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

fn xlsb_formula(cached: &[u8]) -> Vec<u8> {
    // CellParsedFormula：PtgInt(99)，缓存可以是尚未重算的旧值。
    [
        cached,
        &[0, 0],
        &3u32.to_le_bytes(),
        &[0x1e, 99, 0],
        &0u32.to_le_bytes(),
    ]
    .concat()
}

fn xls_formula(col: u16, cached: &[u8]) -> Vec<u8> {
    biff(
        0x0006,
        &[
            &[0, 0][..],
            &col.to_le_bytes(),
            &[0, 0],
            cached,
            &[0; 6],
            &[3, 0, 0x1e, 99, 0],
        ]
        .concat(),
    )
}

#[test]
fn real_binary_cells_use_cached_values_not_formula_execution() {
    let mut binary = record(0x81, &[]);
    binary.extend(record(
        0x94,
        &[
            0u32.to_le_bytes(),
            0u32.to_le_bytes(),
            0u32.to_le_bytes(),
            6u32.to_le_bytes(),
        ]
        .concat(),
    ));
    binary.extend(record(0x91, &[]));
    binary.extend(record(0, &[0; 17]));
    let string = [2u32.to_le_bytes().to_vec(), unicode("缓存")].concat();
    for (col, kind, payload) in [
        (0u32, 5, 1.5f64.to_le_bytes().to_vec()),
        (1, 4, vec![1]),
        (2, 3, vec![7]),
        // 真正的 BrtFmlaNum/String/Bool/Error，不以普通值记录替代公式。
        (3, 9, xlsb_formula(&7f64.to_le_bytes())),
        (4, 8, xlsb_formula(&string)),
        (5, 10, xlsb_formula(&[0])),
    ] {
        binary.extend(record(
            kind,
            &[col.to_le_bytes().to_vec(), vec![0; 4], payload].concat(),
        ));
    }
    let xlsb_ok = xlsb(&[(
        "Values".into(),
        false,
        Some([binary.clone(), record(0x92, &[]), record(0x82, &[])].concat()),
    )]);
    // BrtFmlaError 真实记录：Calamine 可读公式，却会静默遗漏此缓存值。
    binary.extend(record(
        11,
        &[
            6u32.to_le_bytes().to_vec(),
            vec![0; 4],
            xlsb_formula(&[0x17]),
        ]
        .concat(),
    ));
    binary.extend(record(0x92, &[]));
    binary.extend(record(0x82, &[]));
    let xlsb = xlsb(&[("Values".into(), false, Some(binary))]);

    let mut sheet = xls_sheet(&[]);
    sheet.truncate(sheet.len() - 4); // 去掉夹具 EOF 后追加真实 BIFF8 记录。
    sheet.extend(biff(
        0x0203,
        &[vec![0; 6], 1.5f64.to_le_bytes().to_vec()].concat(),
    ));
    sheet.extend(biff(0x0205, &[0, 0, 1, 0, 0, 0, 1, 0]));
    sheet.extend(biff(0x0205, &[0, 0, 2, 0, 0, 0, 7, 1]));
    sheet.extend(xls_formula(3, &7f64.to_le_bytes()));
    // FormulaValue 特殊结果以 FFFF 结尾；字符串结果由紧随其后的 String 记录承载。
    sheet.extend(xls_formula(4, &[0, 0, 0, 0, 0, 0, 0xff, 0xff]));
    sheet.extend(biff(0x0207, &[vec![2, 0, 1], unicode("缓存")].concat()));
    sheet.extend(xls_formula(5, &[1, 0, 0, 0, 0, 0, 0xff, 0xff]));
    sheet.extend(xls_formula(6, &[2, 0, 0x17, 0, 0, 0, 0xff, 0xff]));
    sheet.extend(biff(0x000a, &[]));
    let xls = xls(&[("Values".into(), false, sheet)]);

    // 独立读取公式区，证明确实是四条可解析公式，而非只让数值解析器误认记录。
    let formulas = [
        Xls::new(Cursor::new(&xls))
            .unwrap()
            .worksheet_formula("Values")
            .unwrap(),
        Xlsb::new(Cursor::new(&xlsb))
            .unwrap()
            .worksheet_formula("Values")
            .unwrap(),
    ];
    for range in formulas {
        for col in 3..=6 {
            assert_eq!(range.get_value((0, col)).map(String::as_str), Some("99"));
        }
    }
    let upstream = Xlsb::new(Cursor::new(&xlsb))
        .unwrap()
        .worksheet_range("Values")
        .unwrap();
    assert!(upstream.get_value((0, 6)).is_none());
    assert_eq!(
        convert_bytes(&xlsb, "xlsb"),
        Err(petrichor_doc_convert::Failure::Unsupported)
    );
    for (format, bytes, row) in [
        (
            "xls",
            xls,
            "| 1.5 | true | \\#DIV/0! | 7 | 缓存 | false | \\#REF! |",
        ),
        (
            "xlsb",
            xlsb_ok,
            "| 1.5 | true | \\#DIV/0! | 7 | 缓存 | false |",
        ),
    ] {
        let result = convert_bytes(&bytes, format).unwrap();
        assert_eq!(result["engine"], "calamine");
        let text = result["markdown"].as_str().unwrap();
        assert!(text.contains(row), "{format}: {text}");
        assert!(!text.contains("99"));
    }
}
