mod support;
use petrichor_doc_convert::{Failure, convert_bytes};
use support::*;

#[test]
fn actual_xlsx_xlsm_use_anydoc_with_two_sheets_gaps_and_cached_formulas() {
    let data = xml::worksheet(
        r#"<sheetData>
        <row r="1"><c r="B1" t="inlineStr"><is><t>Name</t></is></c><c r="D1" t="inlineStr"><is><t>Count</t></is></c></row>
        <row r="2"><c r="B2" t="inlineStr"><is><t>Tea</t></is></c><c r="D2"><f>99</f><v>7</v></c></row>
        </sheetData>"#,
    );
    let second = xml::worksheet(
        r#"<sheetData>
        <row r="1"><c r="A1" t="str"><f>99</f><v>Cached</v></c><c r="B1" t="b"><f>99</f><v>1</v></c><c r="C1" t="e"><f>99</f><v>#REF!</v></c></row>
        </sheetData>"#,
    );
    for format in ["xlsx", "xlsm"] {
        let bytes = zip(xml::xlsx_parts(
            format,
            &[
                ("Data", "visible", Some(&data)),
                ("Second", "visible", Some(&second)),
            ],
        ));
        let result = convert_bytes(&bytes, format).unwrap();
        assert_eq!(result["engine"], "anydoc");
        let text = result["markdown"].as_str().unwrap();
        assert_eq!(
            text,
            anydoc::to_markdown_bytes(&bytes, anydoc::Format::Excel).unwrap()
        );
        for value in [
            "## Data",
            "## Second",
            "Name",
            "Count",
            "Tea",
            "7",
            "Cached",
            "TRUE",
            "#REF!",
        ] {
            assert!(text.contains(value), "{format}: missing {value}: {text}");
        }
        assert!(!text.contains("99"));
        // anydoc 采用已用范围：起始空 A 列被裁掉，但 B/D 之间的空 C 列必须保留。
        let row = text.lines().find(|line| line.contains("Tea")).unwrap();
        let cells = row
            .strip_prefix('|')
            .unwrap()
            .strip_suffix('|')
            .unwrap()
            .split('|')
            .map(str::trim)
            .collect::<Vec<_>>();
        assert_eq!(cells, ["Tea", "", "7"], "{text}");
    }
}

#[test]
fn actual_ods_keeps_two_sheets_hidden_content_repeats_and_caches() {
    let bytes = xml::ods(
        r#"
      <table:table table:name="Data"><table:table-row>
        <table:table-cell/><table:table-cell office:value-type="string"><text:p>Name</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="string"><text:p>Count</text:p></table:table-cell>
      </table:table-row><table:table-row>
        <table:table-cell/><table:table-cell office:value-type="string"><text:p>Tea</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="2"/><table:table-cell table:formula="of:=99" office:value-type="float" office:value="7"/>
      </table:table-row></table:table>
      <table:table table:name="Hidden" table:display="false"><table:table-row>
        <table:table-cell table:formula="of:=99" office:value-type="string" office:string-value="Cached"/>
        <table:table-cell table:formula="of:=99" office:value-type="boolean" office:boolean-value="true"/>
        <table:table-cell office:value-type="string"><text:p>HiddenContent</text:p></table:table-cell>
      </table:table-row></table:table>"#,
    );
    let result = convert_bytes(&bytes, "ods").unwrap();
    assert_eq!(result["engine"], "anydoc");
    let text = result["markdown"].as_str().unwrap();
    assert_eq!(
        text,
        anydoc::to_markdown_bytes(&bytes, anydoc::Format::Ods).unwrap()
    );
    // ODS 上游确实包含 display=false 的表；不把 XLSX 的可见性策略套用到 ODS。
    for value in [
        "## Data",
        "## Hidden",
        "Tea",
        "7",
        "Cached",
        "TRUE",
        "HiddenContent",
    ] {
        assert!(text.contains(value), "missing {value}: {text}");
    }
    assert!(!text.contains("99"));
    let row = text.lines().find(|line| line.contains("Tea")).unwrap();
    let cells = row
        .strip_prefix('|')
        .unwrap()
        .strip_suffix('|')
        .unwrap()
        .split('|')
        .map(str::trim)
        .collect::<Vec<_>>();
    assert_eq!(cells, ["", "Tea", "", "", "7"], "{text}");
}

#[test]
fn xlsx_hidden_content_fails_closed_instead_of_upstream_partial_success() {
    let good = xml::worksheet(
        r#"<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Visible</t></is></c></row></sheetData>"#,
    );
    for format in ["xlsx", "xlsm"] {
        for state in ["hidden", "veryHidden"] {
            let bytes = zip(xml::xlsx_parts(
                format,
                &[
                    ("Good", "visible", Some(&good)),
                    ("Hidden", state, Some(&good.replace("Visible", "Secret"))),
                ],
            ));
            let upstream = anydoc::to_markdown_bytes(&bytes, anydoc::Format::Excel).unwrap();
            assert!(upstream.contains("Visible"));
            assert!(!upstream.contains("Secret"));
            assert_eq!(convert_bytes(&bytes, format), Err(Failure::Unsupported));
        }
        for hidden in [
            good.replace("<row r=\"1\">", "<row r=\"1\" hidden=\"true\">"),
            good.replace(
                "<sheetData>",
                "<cols><col min=\"1\" max=\"1\" hidden=\"1\"/></cols><sheetData>",
            ),
        ] {
            let bytes = zip(xml::xlsx_parts(
                format,
                &[
                    ("Good", "visible", Some(&good)),
                    ("Hidden", "visible", Some(&hidden)),
                ],
            ));
            assert_eq!(convert_bytes(&bytes, format), Err(Failure::Unsupported));
        }
    }
}

#[test]
fn xml_missing_damaged_sheets_and_uncached_formulas_never_return_partial_success() {
    let good = xml::worksheet(
        r#"<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Good</t></is></c></row></sheetData>"#,
    );
    let no_cache =
        xml::worksheet(r#"<sheetData><row r="1"><c r="A1"><f>99</f></c></row></sheetData>"#);
    for format in ["xlsx", "xlsm"] {
        for (sheet, failure) in [
            (None, Failure::MissingPart),
            (Some("<broken>"), Failure::Malformed),
            (Some("<wrong/>"), Failure::Malformed),
            (Some(no_cache.as_str()), Failure::Unsupported),
        ] {
            let bytes = zip(xml::xlsx_parts(
                format,
                &[("Good", "visible", Some(&good)), ("Bad", "visible", sheet)],
            ));
            assert_eq!(convert_bytes(&bytes, format), Err(failure));
        }
        let mut parts = xml::xlsx_parts(
            format,
            &[
                ("Good", "visible", Some(&good)),
                ("Bad", "visible", Some(&good)),
            ],
        );
        let (_, rels) = parts
            .iter_mut()
            .find(|(name, _)| name == "xl/_rels/workbook.xml.rels")
            .unwrap();
        *rels = String::from_utf8(rels.clone())
            .unwrap()
            .replace("Id=\"s2\"", "Id=\"unreferenced\"")
            .into_bytes();
        let bytes = zip(parts);
        assert!(
            anydoc::to_markdown_bytes(&bytes, anydoc::Format::Excel)
                .unwrap()
                .contains("Good")
        );
        assert_eq!(convert_bytes(&bytes, format), Err(Failure::MissingPart));
    }
    let bytes = xml::ods(
        r#"<table:table table:name="Data"><table:table-row><table:table-cell office:value-type="string"><text:p>Good</text:p></table:table-cell><table:table-cell table:formula="of:=99"/></table:table-row></table:table>"#,
    );
    assert!(
        anydoc::to_markdown_bytes(&bytes, anydoc::Format::Ods)
            .unwrap()
            .contains("Good")
    );
    assert_eq!(convert_bytes(&bytes, "ods"), Err(Failure::Unsupported));
}

#[test]
fn xml_preflight_resolves_namespaces_entities_and_rejects_bad_formula_caches() {
    let good = xml::worksheet(
        r#"<sheetData><row r="1"><c r="A1"><f>99</f><v>&#55;</v></c><c r="B1" t="str"><f>99</f><v/></c></row></sheetData>"#,
    );
    let mut parts = xml::xlsx_parts("xlsx", &[("Data", "visible", Some(&good))]);
    for (_, data) in &mut parts {
        *data = String::from_utf8(data.clone())
            .unwrap()
            .replace("xmlns:r=", "xmlns:link=")
            .replace(" r:id=", " link:id=")
            .replace(
                "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
                "http://purl.oclc.org/ooxml/spreadsheetml/main",
            )
            .replace(
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
                "http://purl.oclc.org/ooxml/officeDocument/relationships",
            )
            .into_bytes();
    }
    let result = convert_bytes(&zip(parts), "xlsx").unwrap();
    assert!(result["markdown"].as_str().unwrap().contains('7'));
    for cache in ["not-a-number", "NaN", "", "inf"] {
        let bad = good.replace("&#55;", cache);
        let bytes = zip(xml::xlsx_parts("xlsx", &[("Data", "visible", Some(&bad))]));
        assert_eq!(convert_bytes(&bytes, "xlsx"), Err(Failure::Malformed));
    }
    let bytes = zip(xml::xlsx_parts(
        "xlsx",
        &[("Data", "h&#105;dden", Some(&good))],
    ));
    assert_eq!(convert_bytes(&bytes, "xlsx"), Err(Failure::Unsupported));
}

#[test]
fn xml_preflight_preserves_encrypted_classification_and_blocks_external_sheets() {
    for format in ["xlsx", "xlsm"] {
        assert_eq!(
            convert_bytes(&ole("/EncryptedPackage", b"encrypted"), format),
            Err(Failure::Encrypted)
        );
        let good = xml::worksheet("<sheetData/>");
        let mut parts = xml::xlsx_parts(format, &[("Data", "visible", Some(&good))]);
        let (_, rels) = parts
            .iter_mut()
            .find(|(name, _)| name == "xl/_rels/workbook.xml.rels")
            .unwrap();
        *rels = String::from_utf8(rels.clone())
            .unwrap()
            .replace("Target=", "TargetMode=\"External\" Target=")
            .into_bytes();
        assert_eq!(
            convert_bytes(&zip(parts), format),
            Err(Failure::Unsupported)
        );
    }
    let encrypted = zip(vec![
        ("META-INF/manifest.xml".into(), br#"<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry m:full-path="content.xml"><m:encryption-data/></m:file-entry></m:manifest>"#.to_vec()),
        ("content.xml".into(), b"encrypted ciphertext, not XML".to_vec()),
    ]);
    assert_eq!(convert_bytes(&encrypted, "ods"), Err(Failure::Encrypted));
}

#[test]
fn actual_xls_and_xlsb_keep_all_sheets_and_empty_columns() {
    let documents = [
        (
            "xls",
            xls(&[
                (
                    "Data".into(),
                    false,
                    xls_sheet(&[(0, 1, "Name"), (0, 3, "Count"), (2, 3, " a  b | <x> ")]),
                ),
                ("Hidden".into(), true, xls_sheet(&[(0, 0, "secret")])),
                ("Empty".into(), false, xls_sheet(&[])),
            ]),
        ),
        (
            "xlsb",
            xlsb(&[
                (
                    "Data".into(),
                    false,
                    Some(xlsb_sheet(&[
                        (0, 1, "Name"),
                        (0, 3, "Count"),
                        (2, 3, " a  b | <x> "),
                    ])),
                ),
                ("Hidden".into(), true, Some(xlsb_sheet(&[(0, 0, "secret")]))),
                ("Empty".into(), false, Some(xlsb_sheet(&[]))),
            ]),
        ),
    ];
    for (extension, bytes) in documents {
        let result = convert_bytes(&bytes, extension).unwrap();
        assert_eq!(result["engine"], "calamine");
        let markdown = result["markdown"].as_str().unwrap();
        assert!(
            markdown.contains("|  | Name |  | Count |"),
            "{extension}: {markdown}"
        );
        assert!(markdown.contains("|  |  |  |  |"));
        assert!(markdown.contains("&#32;a&#32;&#32;b&#32;\\|&#32;&lt;x&gt;&#32;"));
        assert!(markdown.contains("## Hidden\n\n| secret |"));
        assert!(markdown.contains("## Empty\n\n（空表）"));
    }
}

#[test]
fn missing_or_damaged_sheet_never_returns_partial_success() {
    let missing = xlsb(&[
        ("Good".into(), false, Some(xlsb_sheet(&[(0, 0, "good")]))),
        ("Missing".into(), false, None),
    ]);
    assert_eq!(convert_bytes(&missing, "xlsb"), Err(Failure::MissingPart));
    let damaged = xlsb(&[("Damaged".into(), false, Some(vec![0x81]))]);
    assert_eq!(convert_bytes(&damaged, "xlsb"), Err(Failure::Malformed));
    let damaged = xls(&[("Damaged".into(), false, vec![0x09, 0x08, 0xff, 0x7f])]);
    assert_eq!(convert_bytes(&damaged, "xls"), Err(Failure::Malformed));
    for extension in ["xls", "xlsb"] {
        assert_eq!(
            convert_bytes(b"damaged", extension),
            Err(Failure::Malformed)
        );
    }
}

#[test]
fn encrypted_workbooks_are_distinct_from_malformed() {
    assert_eq!(
        convert_bytes(&xls_encrypted(), "xls"),
        Err(Failure::Encrypted)
    );
    assert_eq!(
        convert_bytes(&ole("/EncryptedPackage", b"encrypted"), "xlsb"),
        Err(Failure::Encrypted)
    );
}

#[test]
fn matrix_limits_count_expanded_cells_and_absolute_coordinates() {
    for (row, col) in [(10_000, 0), (0, 256), (999, 100)] {
        let bytes = xlsb(&[(
            "Limit".into(),
            false,
            Some(xlsb_sheet(&[(row, col, "value")])),
        )]);
        assert_eq!(convert_bytes(&bytes, "xlsb"), Err(Failure::ResourceLimit));
        let bytes = xls(&[(
            "Limit".into(),
            false,
            xls_sheet(&[(row as u16, col as u16, "value")]),
        )]);
        assert_eq!(convert_bytes(&bytes, "xls"), Err(Failure::ResourceLimit));
    }
    let bytes = xlsb(
        &(0..101)
            .map(|i| (format!("S{i}"), false, Some(xlsb_sheet(&[]))))
            .collect::<Vec<_>>(),
    );
    assert_eq!(convert_bytes(&bytes, "xlsb"), Err(Failure::ResourceLimit));
    let bytes = xls(&(0..101)
        .map(|i| (format!("S{i}"), false, xls_sheet(&[])))
        .collect::<Vec<_>>());
    assert_eq!(convert_bytes(&bytes, "xls"), Err(Failure::ResourceLimit));
    let bytes = xlsb(&[
        ("A".into(), false, Some(xlsb_sheet(&[(599, 99, "a")]))),
        ("B".into(), false, Some(xlsb_sheet(&[(599, 99, "b")]))),
    ]);
    assert_eq!(convert_bytes(&bytes, "xlsb"), Err(Failure::ResourceLimit));
}

#[test]
fn actual_xlsb_cell_and_markdown_limits() {
    let text = "字".repeat(44_000);
    let bytes = xlsb(&[("Cell".into(), false, Some(xlsb_sheet(&[(0, 0, &text)])))]);
    assert_eq!(convert_bytes(&bytes, "xlsb"), Err(Failure::ResourceLimit));
    let text = "x".repeat(120_000);
    let cells = (0..18).map(|r| (r, 0, text.as_str())).collect::<Vec<_>>();
    let bytes = xlsb(&[("Output".into(), false, Some(xlsb_sheet(&cells)))]);
    assert_eq!(convert_bytes(&bytes, "xlsb"), Err(Failure::ResourceLimit));
}

#[test]
fn actual_zip_expansion_is_bounded_even_with_forged_lengths() {
    let mut bytes = zip(vec![("bomb".into(), vec![b'A'; 64 * 1024 * 1024 + 1])]);
    assert_eq!(convert_bytes(&bytes, "xlsb"), Err(Failure::ResourceLimit));
    // 同时伪造本地和中央目录未压缩长度。不得信任长度字段后把压缩流全部放入内存。
    let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
    bytes[22..26].copy_from_slice(&1u32.to_le_bytes());
    bytes[central + 24..central + 28].copy_from_slice(&1u32.to_le_bytes());
    assert!(matches!(
        convert_bytes(&bytes, "xlsb"),
        Err(Failure::ResourceLimit | Failure::Malformed)
    ));
}
