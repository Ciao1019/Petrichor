//! anydoc 仍负责 XLSX/XLSM/ODS 转换；这里只拒绝已知会被上游静默略过的内容。
use crate::{Failure, limits::zip_error};
use quick_xml::{NsReader, events::Event, name::ResolveResult};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use zip::ZipArchive;

const SML: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const TABLE: &str = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const OFFICE: &str = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TEXT: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";

type Archive<'a> = ZipArchive<Cursor<&'a [u8]>>;

pub(crate) fn check(bytes: &[u8], extension: &str) -> Result<(), Failure> {
    if !matches!(extension, "xlsx" | "xlsm" | "ods" | "xlsb") || !bytes.starts_with(b"PK") {
        // OLE 加密外壳交还 anydoc，保留 encrypted 分类。
        return Ok(());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(zip_error)?;
    if extension == "xlsb" {
        return check_xlsb_formula_errors(&mut archive);
    }
    if extension == "ods" {
        if archive
            .file_names()
            .any(|name| name == "META-INF/manifest.xml")
        {
            let manifest = part(&mut archive, "META-INF/manifest.xml")?;
            visit(&manifest, &mut |node| {
                if node.is(
                    "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0",
                    "encryption-data",
                ) {
                    return Err(Failure::Encrypted);
                }
                Ok(())
            })?;
        }
        let root = part(&mut archive, "content.xml")?;
        return visit(&root, &mut |node| {
            if node.is(TABLE, "table-cell") && node.attr(TABLE, "formula").is_some() {
                let key = match node.attr(OFFICE, "value-type") {
                    Some("float" | "currency" | "percentage") => "value",
                    Some("string") => "string-value",
                    Some("boolean") => "boolean-value",
                    Some("date") => "date-value",
                    Some("time") => "time-value",
                    _ => "",
                };
                let cached = !key.is_empty() && node.attr(OFFICE, key).is_some();
                if !cached && !node.children.iter().any(|child| child.is(TEXT, "p")) {
                    return Err(Failure::Unsupported);
                }
            }
            Ok(())
        });
    }
    let rels = relationships(&mut archive, "_rels/.rels")?;
    let main = rels
        .values()
        .find(|rel| rel.kind == format!("{REL}/officeDocument"))
        .ok_or(Failure::MissingPart)?;
    let main = target("", main)?;
    let workbook = part(&mut archive, &main)?;
    if !workbook.is(SML, "workbook") {
        return Err(Failure::Malformed);
    }
    let (dir, file) = main.rsplit_once('/').unwrap_or(("", &main));
    let rel_path = if dir.is_empty() {
        format!("_rels/{file}.rels")
    } else {
        format!("{dir}/_rels/{file}.rels")
    };
    let rels = relationships(&mut archive, &rel_path)?;
    let sheets = workbook
        .children
        .iter()
        .find(|n| n.is(SML, "sheets"))
        .ok_or(Failure::Malformed)?;
    let mut names = HashSet::new();
    let mut targets = HashSet::new();
    for sheet in &sheets.children {
        if !sheet.is(SML, "sheet") {
            return Err(Failure::Malformed);
        }
        if matches!(sheet.attr("", "state"), Some("hidden" | "veryHidden")) {
            // anydoc 0.2.4 只输出可见表/行/列；不能把其余内容丢掉后返回完整成功。
            return Err(Failure::Unsupported);
        }
        if !names.insert(sheet.required("", "name")?) {
            return Err(Failure::Malformed);
        }
        let rel = rels
            .get(sheet.required(REL, "id")?)
            .ok_or(Failure::MissingPart)?;
        if rel.kind != format!("{REL}/worksheet") {
            return Err(Failure::Unsupported);
        }
        let path = target(&main, rel)?;
        if !targets.insert(path.clone()) {
            return Err(Failure::Malformed);
        }
        let worksheet = part(&mut archive, &path)?;
        if !worksheet.is(SML, "worksheet") {
            return Err(Failure::Malformed);
        }
        visit(&worksheet, &mut |node| {
            if (node.is(SML, "row") || node.is(SML, "col"))
                && matches!(node.attr("", "hidden"), Some("1" | "true"))
            {
                return Err(Failure::Unsupported);
            }
            if node.is(SML, "c") && node.children.iter().any(|n| n.is(SML, "f")) {
                let cache = node
                    .children
                    .iter()
                    .find(|n| n.is(SML, "v"))
                    .ok_or(Failure::Unsupported)?;
                let value = cache.text.trim();
                match node.attr("", "t").unwrap_or("n") {
                    "str" => (), // 合法的空字符串缓存，不等同于缺失缓存。
                    "n" if value.parse::<f64>().is_ok_and(f64::is_finite) => (),
                    "b" if matches!(value, "0" | "1" | "true" | "false") => (),
                    "e" | "d" if !value.is_empty() => (),
                    "n" | "b" | "e" | "d" => return Err(Failure::Malformed),
                    _ => return Err(Failure::Unsupported),
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

// Calamine 0.36.1 的 next_cell 跳过 BrtFmlaError(0x000B)，但 next_formula 能解析它。
// 不改写成普通值记录、不升级依赖：遇到这种真实公式缓存必须整份失败，不能漏掉错误单元格。
fn check_xlsb_formula_errors(archive: &mut Archive<'_>) -> Result<(), Failure> {
    let rels = relationships(archive, "xl/_rels/workbook.bin.rels")?;
    for rel in rels
        .values()
        .filter(|rel| rel.kind == format!("{REL}/worksheet"))
    {
        let path = target("xl/workbook.bin", rel)?;
        let mut entry = archive.by_name(&path).map_err(zip_error)?;
        while let Some(kind) = record_integer(&mut entry, 2)? {
            let length = record_integer(&mut entry, 4)?.ok_or(Failure::Malformed)?;
            if kind == 0x000b {
                return Err(if length < 19 {
                    Failure::Malformed
                } else {
                    Failure::Unsupported
                });
            }
            // 只跳过记录负载，不分配与声明长度成比例的缓冲区。
            let copied = std::io::copy(
                &mut entry.by_ref().take(u64::from(length)),
                &mut std::io::sink(),
            )
            .map_err(|_| Failure::Malformed)?;
            if copied != u64::from(length) {
                return Err(Failure::Malformed);
            }
        }
    }
    Ok(())
}

fn record_integer(reader: &mut impl Read, max_bytes: usize) -> Result<Option<u32>, Failure> {
    let mut value = 0;
    for index in 0..max_bytes {
        let mut byte = [0];
        if reader.read(&mut byte).map_err(|_| Failure::Malformed)? == 0 {
            return if index == 0 {
                Ok(None)
            } else {
                Err(Failure::Malformed)
            };
        }
        value |= u32::from(byte[0] & 0x7f) << (7 * index);
        if byte[0] & 0x80 == 0 {
            return Ok(Some(value));
        }
    }
    Err(Failure::Malformed)
}

struct Relationship {
    kind: String,
    path: String,
    external: bool,
}

fn relationships(
    archive: &mut Archive<'_>,
    path: &str,
) -> Result<HashMap<String, Relationship>, Failure> {
    let root = part(archive, path)?;
    if !root.is(PKG, "Relationships") {
        return Err(Failure::Malformed);
    }
    let mut result = HashMap::new();
    for node in root.children {
        if !node.is(PKG, "Relationship") {
            return Err(Failure::Malformed);
        }
        let rel = Relationship {
            kind: node.required("", "Type")?.replace(
                "http://purl.oclc.org/ooxml/officeDocument/relationships",
                REL,
            ),
            path: node.required("", "Target")?.into(),
            external: node.attr("", "TargetMode") == Some("External"),
        };
        if result
            .insert(node.required("", "Id")?.to_owned(), rel)
            .is_some()
        {
            return Err(Failure::Malformed);
        }
    }
    Ok(result)
}

fn target(base: &str, rel: &Relationship) -> Result<String, Failure> {
    if rel.external || rel.path.contains([':', '%', '?', '#', '\\']) {
        return Err(Failure::Unsupported);
    }
    let mut parts: Vec<&str> = if rel.path.starts_with('/') {
        Vec::new()
    } else {
        base.rsplit_once('/')
            .map(|(dir, _)| dir.split('/').collect())
            .unwrap_or_default()
    };
    for part in rel.path.split('/') {
        match part {
            "" | "." => (),
            ".." => {
                parts.pop().ok_or(Failure::Malformed)?;
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(Failure::Malformed);
    }
    Ok(parts.join("/"))
}

#[derive(Default)]
struct Node {
    ns: String,
    name: String,
    attrs: HashMap<(String, String), String>,
    children: Vec<Node>,
    text: String,
}

impl Node {
    fn is(&self, ns: &str, name: &str) -> bool {
        self.ns == ns && self.name == name
    }
    fn attr(&self, ns: &str, name: &str) -> Option<&str> {
        self.attrs
            .get(&(ns.into(), name.into()))
            .map(String::as_str)
    }
    fn required(&self, ns: &str, name: &str) -> Result<&str, Failure> {
        self.attr(ns, name)
            .filter(|v| !v.is_empty())
            .ok_or(Failure::Malformed)
    }
}

fn visit(
    node: &Node,
    callback: &mut impl FnMut(&Node) -> Result<(), Failure>,
) -> Result<(), Failure> {
    callback(node)?;
    for child in &node.children {
        visit(child, callback)?;
    }
    Ok(())
}

fn namespace(ns: ResolveResult<'_>) -> Result<String, Failure> {
    let ns = match ns {
        ResolveResult::Bound(ns) => std::str::from_utf8(ns.as_ref())
            .map_err(|_| Failure::Malformed)?
            .to_owned(),
        ResolveResult::Unbound => String::new(),
        ResolveResult::Unknown(_) => return Err(Failure::Malformed),
    };
    Ok(match ns.as_str() {
        "http://purl.oclc.org/ooxml/spreadsheetml/main" => SML.into(),
        "http://purl.oclc.org/ooxml/officeDocument/relationships" => REL.into(),
        _ => ns,
    })
}

fn part(archive: &mut Archive<'_>, path: &str) -> Result<Node, Failure> {
    let mut bytes = Vec::new();
    archive
        .by_name(path)
        .map_err(zip_error)?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Malformed)?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(Failure::ResourceLimit);
    }
    let mut reader = NsReader::from_reader(bytes.as_slice());
    reader.config_mut().expand_empty_elements = true;
    let mut stack: Vec<Node> = Vec::new();
    let mut root = None;
    let mut buffer = Vec::new();
    let mut count = 0;
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|_| Failure::Malformed)?
        {
            Event::Start(start) => {
                count += 1;
                if stack.len() >= 128 || count > 1_000_000 {
                    return Err(Failure::ResourceLimit);
                }
                if stack.is_empty() && root.is_some() {
                    return Err(Failure::Malformed);
                }
                let mut node = Node {
                    ns: namespace(reader.resolver().resolve_element(start.name()).0)?,
                    name: std::str::from_utf8(start.local_name().as_ref())
                        .map_err(|_| Failure::Malformed)?
                        .into(),
                    ..Node::default()
                };
                for attr in start.attributes() {
                    let attr = attr.map_err(|_| Failure::Malformed)?;
                    if attr.key.as_ref() == b"xmlns" || attr.key.as_ref().starts_with(b"xmlns:") {
                        continue;
                    }
                    let (ns, local) = reader.resolver().resolve_attribute(attr.key);
                    let key = (
                        namespace(ns)?,
                        std::str::from_utf8(local.as_ref())
                            .map_err(|_| Failure::Malformed)?
                            .to_owned(),
                    );
                    let value = attr
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::default(),
                            reader.decoder(),
                        )
                        .map_err(|_| Failure::Malformed)?
                        .into_owned();
                    if node.attrs.insert(key, value).is_some() {
                        return Err(Failure::Malformed);
                    }
                }
                stack.push(node);
            }
            Event::End(_) => {
                let node = stack.pop().ok_or(Failure::Malformed)?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else {
                    root = Some(node);
                }
            }
            Event::Text(text) => {
                let text = text.decode().map_err(|_| Failure::Malformed)?;
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&text);
                } else if !text.trim().is_empty() {
                    return Err(Failure::Malformed);
                }
            }
            Event::CData(text) => {
                stack
                    .last_mut()
                    .ok_or(Failure::Malformed)?
                    .text
                    .push_str(&text.decode().map_err(|_| Failure::Malformed)?);
            }
            Event::GeneralRef(reference) => {
                let entity = format!("&{};", reference.decode().map_err(|_| Failure::Malformed)?);
                let text = quick_xml::escape::unescape(&entity).map_err(|_| Failure::Malformed)?;
                stack
                    .last_mut()
                    .ok_or(Failure::Malformed)?
                    .text
                    .push_str(&text);
            }
            Event::DocType(_) => return Err(Failure::Unsupported),
            Event::Eof => break,
            _ => (),
        }
        buffer.clear();
    }
    if !stack.is_empty() {
        return Err(Failure::Malformed);
    }
    root.ok_or(Failure::Malformed)
}
