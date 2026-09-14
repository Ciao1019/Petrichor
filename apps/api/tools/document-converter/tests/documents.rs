mod support;
use lopdf::{Document, Object, Stream, dictionary};
use petrichor_doc_convert::{Failure, convert_bytes};

fn pdf(kinds: &[&str]) -> Document {
    let mut doc = Document::with_version("1.5");
    let pages = doc.new_object_id();
    let font = doc.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let image = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 8, "Height" => 8,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        vec![127; 64],
    ));
    let mut kids = Vec::new();
    for kind in kinds {
        let mut page = dictionary! {
            "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! {"Font" => dictionary! {"F1" => font}},
        };
        if *kind == "scan" {
            page.set(
                "Resources",
                dictionary! {"XObject" => dictionary! {"Im1" => image}},
            );
        }
        let content: Option<&[u8]> = match *kind {
            "text" => Some(b"BT /F1 12 Tf 72 700 Td (Offline document conversion preserves meaningful text. This is a complete text page with sufficient words for extraction.) Tj ET"),
            "scan" => Some(b"q 500 0 0 700 50 50 cm /Im1 Do Q"),
            "empty-stream" => Some(b""),
            "annots" => { page.set("Annots", Object::Array(vec![])); None },
            _ => None,
        };
        if let Some(content) = content {
            page.set(
                "Contents",
                doc.add_object(Stream::new(dictionary! {}, content.to_vec())),
            );
        }
        kids.push(doc.add_object(page).into());
    }
    doc.objects.insert(
        pages,
        dictionary! {"Type" => "Pages", "Kids" => kids, "Count" => kinds.len() as i64}.into(),
    );
    let root = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
    doc.trailer.set("Root", root);
    doc
}

fn save(mut doc: Document) -> Vec<u8> {
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn actual_csv_rtf_and_docx() {
    let csv = convert_bytes("名称,数量\n茶,2\n咖啡,3\n".as_bytes(), "csv").unwrap();
    assert_eq!(csv["engine"], "anydoc");
    assert!(csv["markdown"].as_str().unwrap().contains("咖啡"));
    let rtf = convert_bytes(
        br"{\rtf1\ansi Hello \b world\b0\par second paragraph}",
        "rtf",
    )
    .unwrap();
    assert!(rtf["markdown"].as_str().unwrap().contains("world"));
    let docx = support::zip(vec![
        ("[Content_Types].xml".into(), br#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.to_vec()),
        ("_rels/.rels".into(), br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_vec()),
        ("word/document.xml".into(), br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Real DOCX sample</w:t></w:r></w:p></w:body></w:document>"#.to_vec()),
    ]);
    let result = convert_bytes(&docx, "docx").unwrap();
    assert!(
        result["markdown"]
            .as_str()
            .unwrap()
            .contains("Real DOCX sample")
    );
}

#[test]
fn mixed_pdf_split_into_single_page_text_blank_and_ocr() {
    let mixed = pdf(&["text", "scan", "blank"]);
    assert_eq!(
        convert_bytes(&save(mixed.clone()), "pdf"),
        Err(Failure::Unsupported)
    );
    for (keep, kind) in [(1, "text"), (2, "scan"), (3, "blank")] {
        let mut page = mixed.clone();
        page.delete_pages(&(1..=3).filter(|p| *p != keep).collect::<Vec<_>>());
        let result = convert_bytes(&save(page), "pdf");
        match kind {
            "text" => assert!(
                result.unwrap()["markdown"]
                    .as_str()
                    .unwrap()
                    .contains("Offline document")
            ),
            "scan" => assert_eq!(result, Err(Failure::NeedsOcr)),
            _ => assert_eq!(result.unwrap()["markdown"], ""),
        }
    }
    assert_eq!(
        Failure::NeedsOcr.json(),
        serde_json::json!({"ok": false, "code": "needsOcr", "pages": [1], "pageCount": 1})
    );
}

#[test]
fn empty_stream_and_annotations_are_not_structurally_blank() {
    for kind in ["empty-stream", "annots"] {
        let bytes = save(pdf(&[kind]));
        let upstream = anydoc::to_markdown_bytes(&bytes, anydoc::Format::Pdf).unwrap_err();
        // 非结构性空页沿用引擎的真实分类，不能强制成功，也不能把 unsupported 改写成 OCR。
        assert_eq!(
            convert_bytes(&bytes, "pdf").unwrap_err().json()["code"],
            upstream.code()
        );
    }
    assert_eq!(
        convert_bytes(b"%PDF-1.7\ndamaged", "pdf"),
        Err(Failure::Malformed)
    );
    let mut damaged = pdf(&["blank"]);
    let page = *damaged.get_pages().values().next().unwrap();
    damaged.get_dictionary_mut(page).unwrap().remove(b"Parent");
    assert_eq!(
        convert_bytes(&save(damaged), "pdf"),
        Err(Failure::Malformed)
    );
}

#[test]
fn pdf_requires_a_valid_effective_media_box_even_for_blank_or_scan() {
    let boxes = [
        None,
        Some(Object::Null),
        Some(Object::Name(b"wrong".to_vec())),
        Some(Object::Array(vec![0.into(), 0.into(), 612.into()])),
        Some(Object::Array(vec![
            0.into(),
            0.into(),
            Object::string_literal("612"),
            792.into(),
        ])),
        Some(Object::Array(vec![
            0.into(),
            0.into(),
            0.into(),
            792.into(),
        ])),
        Some(Object::Array(vec![
            0.into(),
            0.into(),
            612.into(),
            0.into(),
        ])),
        Some(Object::Array(vec![
            612.into(),
            0.into(),
            0.into(),
            792.into(),
        ])),
    ];
    for kind in ["blank", "scan"] {
        for media_box in &boxes {
            let mut doc = pdf(&[kind]);
            let page = *doc.get_pages().values().next().unwrap();
            let dict = doc.get_dictionary_mut(page).unwrap();
            dict.remove(b"MediaBox");
            if let Some(media_box) = media_box {
                dict.set("MediaBox", media_box.clone());
            }
            assert_eq!(
                convert_bytes(&save(doc), "pdf"),
                Err(Failure::Malformed),
                "{kind}: {media_box:?}"
            );
        }
    }
}

#[test]
fn pdf_inherits_media_box_through_valid_parents_and_indirect_numbers() {
    let mut doc = pdf(&["blank"]);
    let page = *doc.get_pages().values().next().unwrap();
    let root = doc
        .get_dictionary(page)
        .unwrap()
        .get(b"Parent")
        .unwrap()
        .as_reference()
        .unwrap();
    let width = doc.add_object(Object::Real(612.5));
    let media_box = doc.add_object(Object::Array(vec![
        (-1).into(),
        0.into(),
        width.into(),
        792.into(),
    ]));
    let indirect = doc.add_object(Object::Reference(media_box));
    let parent = doc.add_object(dictionary! {"Type" => "Pages", "Parent" => root, "Kids" => vec![page.into()], "Count" => 1});
    doc.get_dictionary_mut(root)
        .unwrap()
        .set("Kids", vec![parent.into()]);
    doc.get_dictionary_mut(root)
        .unwrap()
        .set("MediaBox", indirect);
    doc.get_dictionary_mut(page).unwrap().remove(b"MediaBox");
    doc.get_dictionary_mut(page).unwrap().set("Parent", parent);
    assert_eq!(
        convert_bytes(&save(doc.clone()), "pdf").unwrap()["markdown"],
        ""
    );
    // 页级非法值不能回退到父级合法值。
    doc.get_dictionary_mut(page)
        .unwrap()
        .set("MediaBox", Object::Null);
    assert_eq!(convert_bytes(&save(doc), "pdf"), Err(Failure::Malformed));
}

#[test]
fn pdf_media_box_reference_cycles_missing_targets_and_depth_fail_closed() {
    for kind in ["cycle", "missing", "deep", "coordinate-cycle"] {
        let mut doc = pdf(&["blank"]);
        let page = *doc.get_pages().values().next().unwrap();
        let missing = doc.new_object_id();
        let mut target = missing;
        if kind != "missing" {
            doc.objects.insert(target, Object::Reference(target));
        }
        if kind == "deep" {
            doc.objects.insert(
                target,
                Object::Array(vec![0.into(), 0.into(), 612.into(), 792.into()]),
            );
            for _ in 0..129 {
                target = doc.add_object(Object::Reference(target));
            }
        } else if kind == "coordinate-cycle" {
            target = doc.add_object(Object::Array(vec![
                0.into(),
                0.into(),
                target.into(),
                792.into(),
            ]));
        }
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("MediaBox", target);
        assert_eq!(
            convert_bytes(&save(doc), "pdf"),
            Err(Failure::Malformed),
            "{kind}"
        );
    }
}

#[test]
fn pdf_invalid_inheritance_tree_never_returns_empty_success() {
    for kind in [
        "root-parent",
        "parent-cycle",
        "wrong-parent-type",
        "wrong-count",
        "kids-cycle",
    ] {
        let mut doc = pdf(&["blank"]);
        let page = *doc.get_pages().values().next().unwrap();
        let root = doc
            .get_dictionary(page)
            .unwrap()
            .get(b"Parent")
            .unwrap()
            .as_reference()
            .unwrap();
        match kind {
            "root-parent" => doc.get_dictionary_mut(root).unwrap().set("Parent", page),
            "parent-cycle" => doc.get_dictionary_mut(page).unwrap().set("Parent", page),
            "wrong-parent-type" => doc.get_dictionary_mut(root).unwrap().set("Type", "Page"),
            "wrong-count" => doc.get_dictionary_mut(root).unwrap().set("Count", 2),
            _ => doc
                .get_dictionary_mut(root)
                .unwrap()
                .set("Kids", vec![root.into()]),
        }
        assert_eq!(
            convert_bytes(&save(doc), "pdf"),
            Err(Failure::Malformed),
            "{kind}"
        );
    }
}

#[test]
fn encrypted_pdf_has_a_distinct_code() {
    let mut document = pdf(&["text"]);
    let encrypt = document.add_object(dictionary! {"Filter" => "Standard", "V" => 1, "R" => 2, "O" => Object::string_literal(vec![0; 32]), "U" => Object::string_literal(vec![0; 32]), "P" => -4});
    document.trailer.set("Encrypt", encrypt);
    document.trailer.set(
        "ID",
        vec![
            Object::string_literal(vec![1; 16]),
            Object::string_literal(vec![1; 16]),
        ],
    );
    assert_eq!(
        convert_bytes(&save(document), "pdf"),
        Err(Failure::Encrypted)
    );
}

#[test]
fn markdown_limit_is_utf8_bytes_and_no_truncation() {
    let text = "字".repeat(700_000);
    assert_eq!(
        convert_bytes(text.as_bytes(), "csv"),
        Err(Failure::ResourceLimit)
    );
}
