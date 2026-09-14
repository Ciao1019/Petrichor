mod support;
use petrichor_doc_convert::{Failure, convert_bytes};
use std::io::{Cursor, Read};
use zip::ZipArchive;

const REAL: &[u8] = include_bytes!("support/xlsb-short-real.xlsb");
const COMPRESSED: &[u8] = include_bytes!("support/xlsb-short-compressed-real.xlsb");

#[test]
fn public_entry_keeps_both_real_sheets_and_every_short_cell() {
    let result = convert_bytes(REAL, "xlsb").unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["engine"], "calamine");
    assert_eq!(
        result["markdown"],
        "## 主表\n\n| 名称 | 金额 | 备注 |\n| --- | --- | --- |\n| 一号 | 42 | 管道\\|内容 |\n| 二号 | 84 | 最后一列 |\n\n## 附表\n\n| 第二工作表 | 列B |\n| --- | --- |\n| 保留 | 末尾标记 |\n\n"
    );
}

#[test]
fn public_entry_keeps_compressed_short_cells_and_middle_empty_column() {
    let result = convert_bytes(COMPRESSED, "xlsb").unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["engine"], "calamine");
    assert_eq!(
        result["markdown"],
        "## 压缩表\n\n| A | B | C |\n| --- | --- | --- |\n| 一 |  | 末列 |\n| 二 | 3 | 完整 |\n\n"
    );
}

fn with_sheet_target(target: &str) -> Vec<u8> {
    let mut archive = ZipArchive::new(Cursor::new(REAL)).unwrap();
    let mut parts = Vec::new();
    let mut replaced = false;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let name = entry.name().to_owned();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        if name == "xl/_rels/workbook.bin.rels" {
            let xml = String::from_utf8(data).unwrap();
            assert!(xml.contains("worksheets/sheet1.bin"));
            data = xml.replace("worksheets/sheet1.bin", target).into_bytes();
            replaced = true;
        }
        parts.push((name, data));
    }
    assert!(replaced);
    support::zip(parts)
}

#[test]
fn normalized_relationships_never_become_partial_success_in_public_entry() {
    let expected = convert_bytes(REAL, "xlsb").unwrap();
    for path in [
        "worksheets/./sheet1.bin",
        "/xl/worksheets/sheet1.bin",
        "../xl/worksheets/sheet1.bin",
    ] {
        // 兼容层识别合法内部路径不意味着下游支持该写法；成功时必须保留全部表和值。
        match convert_bytes(&with_sheet_target(path), "xlsb") {
            Ok(actual) => assert_eq!(actual, expected, "{path}"),
            Err(Failure::Malformed | Failure::MissingPart | Failure::Unsupported) => (),
            other => panic!("关系路径不得返回其他结果：{path}: {other:?}"),
        }
    }
}
