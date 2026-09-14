use super::inspect;
use lopdf::{Document, Stream, dictionary};

fn document(drawing: &str, rotate: i64) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages = doc.new_object_id();
    let font =
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica"});
    let mono =
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Courier"});
    let image=doc.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Image","Width"=>16,"Height"=>16,"ColorSpace"=>"DeviceRGB","BitsPerComponent"=>8},vec![140;16*16*3]));
    let text = "BT /F1 12 Tf 40 750 Td (Why this works: the document contains meaningful text as well as a picture. This complete paragraph provides sufficient words for direct extraction.) Tj ET\n";
    let stream = doc.add_object(Stream::new(
        dictionary! {},
        format!("{text}{drawing}").into_bytes(),
    ));
    let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),600.into(),800.into()],"Rotate"=>rotate,"Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>font,"F2"=>mono},"XObject"=>dictionary!{"Image"=>image}},"Contents"=>stream});
    doc.objects.insert(
        pages,
        dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}.into(),
    );
    let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
    doc.trailer.set("Root", root);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn text_does_not_hide_picture_and_print_background_is_not_a_figure() {
    let result = inspect(&document(
        "1 1 1 rg 10 10 580 780 re f q 200 0 0 300 40 350 cm /Image Do Q",
        0,
    ))
    .unwrap();
    assert_eq!(result["fallback"], false);
    let regions = result["regions"].as_array().unwrap();
    assert_eq!(regions.len(), 1);
    assert!(regions[0]["width"].as_f64().unwrap() < 210.);
    assert!(
        regions[0]["anchor"]
            .as_str()
            .unwrap()
            .contains("Why this works")
    );
}

#[test]
fn vector_paths_and_adjacent_fragments_are_rendered_as_one_region() {
    for drawing in [
        "q 2 0 0 2 40 300 cm 0 0 m 80 0 l 80 80 l 0 80 l h S 0 0 m 80 80 l S Q",
        "q 100 0 0 100 40 300 cm /Image Do Q q 100 0 0 100 140 300 cm /Image Do Q",
    ] {
        let result = inspect(&document(drawing, 0)).unwrap();
        assert_eq!(result["fallback"], false);
        assert_eq!(result["regions"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn rotation_uses_original_page_instead_of_wrong_crop() {
    let result = inspect(&document("q 200 0 0 300 40 350 cm /Image Do Q", 90)).unwrap();
    assert_eq!(result["fallback"], true);
    assert!(result["regions"].as_array().unwrap().is_empty());
}

#[test]
fn hyperlink_does_not_turn_a_text_page_into_an_image() {
    for visible_appearance in [false, true] {
        let mut doc = Document::load_mem(&document("", 0)).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let mut link = dictionary! {"Type"=>"Annot", "Subtype"=>"Link", "Rect"=>vec![40.into(),740.into(),200.into(),760.into()], "A"=>dictionary!{"S"=>"URI", "URI"=>lopdf::Object::string_literal("https://example.test")}};
        if visible_appearance {
            let appearance = doc.add_object(Stream::new(
                dictionary! {"BBox"=>vec![0.into(),0.into(),160.into(),20.into()]},
                b"0 0 160 20 re f".to_vec(),
            ));
            link.set("AP", dictionary! {"N"=>appearance});
        }
        let annotation = doc.add_object(link);
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![annotation.into()]);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let result = inspect(&bytes).unwrap();
        assert_eq!(result["fallback"], visible_appearance);
        assert!(result["regions"].as_array().unwrap().is_empty());
    }
}

#[test]
fn inline_code_background_is_not_a_picture_but_standalone_diagram_is() {
    let code = "0.8 g 90 700 82 18 re f BT /F2 12 Tf 93 705 Td (raw/assets/) Tj ET";
    for (neighbors, expected) in [
        ("", 1),
        (
            "BT /F1 12 Tf 40 705 Td (Before) Tj ET BT /F1 12 Tf 180 705 Td (after) Tj ET",
            0,
        ),
    ] {
        let result = inspect(&document(&format!("{code} {neighbors}"), 0)).unwrap();
        assert_eq!(result["fallback"], false);
        assert_eq!(
            result["regions"].as_array().unwrap().len(),
            expected,
            "{result}"
        );
    }
}

#[test]
fn partial_page_text_background_does_not_capture_the_paragraph_as_a_picture() {
    let drawing = "1 g 30 500 m 565 500 l 565 780 l 30 780 l h f BT /F1 12 Tf 40 700 Td (Another line in the same prose block.) Tj ET";
    let result = inspect(&document(drawing, 0)).unwrap();
    assert_eq!(result["fallback"], false);
    assert!(result["regions"].as_array().unwrap().is_empty(), "{result}");
    // 带内部笔画的矢量图不能按正文底框丢弃。
    let result = inspect(&document(
        &format!("{drawing} 40 520 m 250 720 l 480 520 l h f"),
        0,
    ))
    .unwrap();
    assert_eq!(result["regions"].as_array().unwrap().len(), 1);
}
