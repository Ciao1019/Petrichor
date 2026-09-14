mod support;
use petrichor_doc_convert::{Failure, convert_bytes};

fn with_legacy_padding(mut bytes: Vec<u8>) -> Vec<u8> {
    let size = 1usize << u16::from_le_bytes([bytes[30], bytes[31]]);
    let count = bytes.len() / size - 1;
    let tables = u32::from_le_bytes(bytes[44..48].try_into().unwrap()) as usize;
    assert!(tables <= 109);
    let mut changed = 0;
    for table in 0..tables {
        let header = 76 + table * 4;
        let id = u32::from_le_bytes(bytes[header..header + 4].try_into().unwrap()) as usize;
        for index in 0..size / 4 {
            if table * (size / 4) + index >= count {
                let offset = (id + 1) * size + index * 4;
                assert_eq!(&bytes[offset..offset + 4], &u32::MAX.to_le_bytes());
                bytes[offset..offset + 4].copy_from_slice(&0xffff_fffeu32.to_le_bytes());
                changed += 1;
            }
        }
    }
    assert!(changed > 0);
    bytes
}

#[test]
fn legacy_padding_keeps_workbook_contents_and_encryption_checks() {
    let original = support::xls(&[
        (
            "Data".into(),
            false,
            support::xls_sheet(&[
                (0, 0, "Name"),
                (0, 2, "Amount"),
                (1, 0, "Tea"),
                (1, 2, "17"),
            ]),
        ),
        (
            "Hidden".into(),
            true,
            support::xls_sheet(&[(0, 0, "LastMarker")]),
        ),
    ]);
    let expected = convert_bytes(&original, "xls").unwrap();
    let legacy = with_legacy_padding(original);
    assert!(cfb::CompoundFile::open(std::io::Cursor::new(&legacy)).is_err());
    let actual = convert_bytes(&legacy, "xls").unwrap();
    assert_eq!(actual, expected);
    assert!(
        actual["markdown"]
            .as_str()
            .unwrap()
            .contains("| Name |  | Amount |\n| --- | --- | --- |\n| Tea |  | 17 |\n")
    );
    for value in ["Name", "Amount", "Tea", "17", "## Hidden", "LastMarker"] {
        assert!(actual["markdown"].as_str().unwrap().contains(value));
    }
    let encrypted = with_legacy_padding(support::xls_encrypted());
    assert_eq!(convert_bytes(&encrypted, "xls"), Err(Failure::Encrypted));
}

#[test]
fn invalid_real_chain_remains_malformed_after_padding_compatibility() {
    let original = support::xls(&[(
        "Data".into(),
        false,
        support::xls_sheet(&[(0, 0, "KeepThis")]),
    )]);
    assert!(cfb::CompoundFile::open(std::io::Cursor::new(&original)).is_ok());
    assert!(convert_bytes(&original, "xls").is_ok());
    let mut broken = with_legacy_padding(original);
    assert!(convert_bytes(&broken, "xls").is_ok());
    let size = 1usize << u16::from_le_bytes([broken[30], broken[31]]);
    let count = broken.len() / size - 1;
    let table = u32::from_le_bytes(broken[76..80].try_into().unwrap()) as usize;
    let offset = (table + 1) * size;
    let index = (0..count.min(size / 4))
        .find(|index| {
            u32::from_le_bytes(
                broken[offset + index * 4..offset + index * 4 + 4]
                    .try_into()
                    .unwrap(),
            ) == 0xffff_fffe
        })
        .expect("合法文件应包含已分配链的结尾");
    broken[offset + index * 4..offset + index * 4 + 4]
        .copy_from_slice(&((count + 100) as u32).to_le_bytes());
    assert_eq!(convert_bytes(&broken, "xls"), Err(Failure::Malformed));
}
