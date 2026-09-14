use super::zip;

pub const SML: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

pub fn worksheet(content: &str) -> String {
    format!("<worksheet xmlns=\"{SML}\">{content}</worksheet>")
}

pub fn xlsx_parts(format: &str, sheets: &[(&str, &str, Option<&str>)]) -> Vec<(String, Vec<u8>)> {
    let main_type = if format == "xlsm" {
        "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
    } else {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    };
    let mut types = format!(
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"{main_type}\"/>"
    );
    let mut workbook = format!("<workbook xmlns=\"{SML}\" xmlns:r=\"{REL}\"><sheets>");
    let mut rels = format!("<Relationships xmlns=\"{PKG}\">");
    let mut parts = vec![("_rels/.rels".into(), format!("<Relationships xmlns=\"{PKG}\"><Relationship Id=\"main\" Type=\"{REL}/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>").into_bytes())];
    for (index, (name, state, sheet)) in sheets.iter().enumerate() {
        let id = index + 1;
        workbook.push_str(&format!(
            "<sheet name=\"{name}\" state=\"{state}\" sheetId=\"{id}\" r:id=\"s{id}\"/>"
        ));
        rels.push_str(&format!("<Relationship Id=\"s{id}\" Type=\"{REL}/worksheet\" Target=\"worksheets/sheet{id}.xml\"/>"));
        types.push_str(&format!("<Override PartName=\"/xl/worksheets/sheet{id}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"));
        if let Some(sheet) = sheet {
            parts.push((
                format!("xl/worksheets/sheet{id}.xml"),
                sheet.as_bytes().to_vec(),
            ));
        }
    }
    workbook.push_str("</sheets></workbook>");
    rels.push_str("</Relationships>");
    types.push_str("</Types>");
    parts.extend([
        ("xl/workbook.xml".into(), workbook.into_bytes()),
        ("xl/_rels/workbook.xml.rels".into(), rels.into_bytes()),
        ("[Content_Types].xml".into(), types.into_bytes()),
    ]);
    parts
}

pub fn ods(tables: &str) -> Vec<u8> {
    // 与实际 ODS 相同的命名空间、mimetype、manifest、content.xml；不需要办公软件或网络。
    zip(vec![
        ("mimetype".into(), b"application/vnd.oasis.opendocument.spreadsheet".to_vec()),
        ("META-INF/manifest.xml".into(), br#"<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>"#.to_vec()),
        ("content.xml".into(), format!(r#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.2"><office:body><office:spreadsheet>{tables}</office:spreadsheet></office:body></office:document-content>"#).into_bytes()),
    ])
}
