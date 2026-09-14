//! 保留视觉区域；不把成功提取文字当作页面没有图片的证据。
use crate::Failure;
use lopdf::{Document, Object, content::Content};
use pdf_inspector::types::ItemType;
use serde_json::{Value, json};

type Rect = [f64; 4];
type Matrix = [f64; 6];
const IDENTITY: Matrix = [1., 0., 0., 1., 0., 0.];

#[path = "pdf_visuals_decorations.rs"]
mod decorations;

fn number(v: &Object) -> Option<f64> {
    match v {
        Object::Integer(n) => Some(*n as f64),
        Object::Real(n) => Some(f64::from(*n)),
        _ => None,
    }
}

fn array<const N: usize>(v: &Object) -> Option<[f64; N]> {
    let values = v.as_array().ok()?;
    if values.len() != N {
        return None;
    }
    let mut result = [0.; N];
    for (out, input) in result.iter_mut().zip(values) {
        *out = number(input)?;
    }
    result.iter().all(|v| v.is_finite()).then_some(result)
}

fn resolved_array<const N: usize>(doc: &Document, value: &Object) -> Option<[f64; N]> {
    let values = value.as_array().ok()?;
    if values.len() != N {
        return None;
    }
    let mut result = [0.; N];
    for (out, input) in result.iter_mut().zip(values) {
        *out = number(doc.dereference(input).ok()?.1)?;
    }
    result.iter().all(|v| v.is_finite()).then_some(result)
}

fn point(m: Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn multiply(a: Matrix, b: Matrix) -> Matrix {
    let (x, y) = point(a, b[4], b[5]);
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        x,
        y,
    ]
}

fn include(rect: &mut Option<Rect>, x: f64, y: f64) {
    *rect = Some(match *rect {
        None => [x, y, x, y],
        Some(r) => [r[0].min(x), r[1].min(y), r[2].max(x), r[3].max(y)],
    });
}

fn union(a: Rect, b: Rect) -> Rect {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

pub(crate) fn inspect(bytes: &[u8]) -> Result<Value, Failure> {
    let doc = Document::load_mem(bytes).map_err(|_| Failure::Malformed)?;
    let page_id = *doc.get_pages().values().next().ok_or(Failure::Malformed)?;
    let page = doc
        .get_dictionary(page_id)
        .map_err(|_| Failure::Malformed)?;
    let mut node = page;
    let mut media = None;
    let mut uncertain = decorations::has_visual_annotations(&doc, page);
    for _ in 0..128 {
        if media.is_none() {
            media = node
                .get(b"MediaBox")
                .ok()
                .and_then(|v| doc.dereference(v).ok())
                .and_then(|(_, v)| resolved_array::<4>(&doc, v));
        }
        // 旋转、裁切、非默认单位的坐标不能直接映射到 Poppler 的预览；按页保留。
        uncertain |= node.has(b"CropBox")
            || node
                .get(b"Rotate")
                .ok()
                .and_then(number)
                .is_some_and(|v| v != 0.)
            || node.has(b"UserUnit");
        let Ok(parent) = node.get(b"Parent").and_then(Object::as_reference) else {
            break;
        };
        node = doc.get_dictionary(parent).map_err(|_| Failure::Malformed)?;
    }
    let media = media.ok_or(Failure::Malformed)?;
    let (width, height) = (media[2] - media[0], media[3] - media[1]);
    if width <= 0. || height <= 0. {
        return Err(Failure::Malformed);
    }
    if !page.has(b"Contents") && !page.has(b"Annots") {
        return Ok(json!({"width":width,"height":height,"fallback":false,"regions":[]}));
    }
    uncertain |= media[0] != 0. || media[1] != 0.;
    let items = pdf_inspector::extract_text_with_positions_mem(bytes).ok();
    uncertain |= items.is_none();
    let items = items.unwrap_or_default();
    let mono_fonts = decorations::monospace_fonts(&doc, page_id);
    let mut regions = Vec::new();
    for item in &items {
        if matches!(item.item_type, ItemType::Image) {
            regions.push([
                f64::from(item.x),
                f64::from(item.y),
                f64::from(item.x + item.width),
                f64::from(item.y + item.height),
            ]);
        }
    }
    let content = doc
        .get_page_content(page_id)
        .map_err(|_| Failure::Malformed)?;
    let content = Content::decode(&content).map_err(|_| Failure::Malformed)?;
    if content.operations.len() > 100_000 {
        return Err(Failure::ResourceLimit);
    }
    let mut matrix = IDENTITY;
    let mut stack = Vec::new();
    let mut path = None;
    let mut path_points = Vec::new();
    let mut single_rectangle = false;
    for op in content.operations {
        let nums: Option<Vec<_>> = op.operands.iter().map(number).collect();
        match op.operator.as_str() {
            "q" => {
                if stack.len() >= 128 {
                    return Err(Failure::ResourceLimit);
                }
                stack.push(matrix);
            }
            "Q" => {
                if let Some(m) = stack.pop() {
                    matrix = m;
                } else {
                    uncertain = true;
                }
            }
            "cm" => {
                if let Some(n) = nums.filter(|n| n.len() == 6) {
                    matrix = multiply(matrix, n.try_into().unwrap());
                } else {
                    uncertain = true;
                }
            }
            "m" | "l" | "c" | "v" | "y" => {
                single_rectangle = false;
                if let Some(n) = nums.filter(|n| n.len() % 2 == 0) {
                    for xy in n.chunks_exact(2) {
                        let (x, y) = point(matrix, xy[0], xy[1]);
                        include(&mut path, x, y);
                        path_points.push((x, y));
                    }
                } else {
                    uncertain = true;
                }
            }
            "re" => {
                single_rectangle = path.is_none();
                if let Some(n) = nums.filter(|n| n.len() == 4) {
                    for (x, y) in [
                        (n[0], n[1]),
                        (n[0] + n[2], n[1]),
                        (n[0], n[1] + n[3]),
                        (n[0] + n[2], n[1] + n[3]),
                    ] {
                        let (x, y) = point(matrix, x, y);
                        include(&mut path, x, y);
                        path_points.push((x, y));
                    }
                } else {
                    uncertain = true;
                }
            }
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                if let Some(r) = path.take() {
                    // 浏览器打印 PDF 常用大块纯色矩形铺底；它不是正文插图。
                    let box_outline = decorations::box_outline(r, &path_points);
                    let background = box_outline
                        && matches!(op.operator.as_str(), "f" | "F" | "f*")
                        && ((single_rectangle
                            && (r[2] - r[0]) * (r[3] - r[1]) > width * height * 0.7)
                            || decorations::text_backdrop(r, width, &items));
                    let inline_code =
                        box_outline && decorations::inline_code_backdrop(r, &items, &mono_fonts);
                    if !background && !inline_code {
                        regions.push(r);
                    }
                }
                single_rectangle = false;
                path_points.clear();
            }
            "n" => {
                path = None;
                single_rectangle = false;
                path_points.clear();
            }
            // Form 可能由文字、线条和碎片图片组合；未知变换/裁切时保留原页。
            "Do" => {
                let name = op.operands.first().and_then(|v| v.as_name().ok());
                if let Some(name) = name {
                    let (local, inherited) = doc
                        .get_page_resources(page_id)
                        .map_err(|_| Failure::Malformed)?;
                    let resource = local
                        .into_iter()
                        .chain(
                            inherited
                                .iter()
                                .filter_map(|id| doc.get_dictionary(*id).ok()),
                        )
                        .find_map(|r| {
                            r.get(b"XObject")
                                .ok()
                                .and_then(|v| doc.dereference(v).ok())
                                .and_then(|(_, v)| v.as_dict().ok())
                                .and_then(|d| d.get(name).ok())
                        });
                    let obj = resource
                        .and_then(|v| doc.dereference(v).ok())
                        .and_then(|(_, v)| v.as_stream().ok());
                    if let Some(stream) = obj {
                        if stream.dict.get(b"Subtype").and_then(Object::as_name).ok()
                            == Some(b"Form")
                        {
                            let form_matrix = stream
                                .dict
                                .get(b"Matrix")
                                .ok()
                                .and_then(array::<6>)
                                .unwrap_or(IDENTITY);
                            if let Some(r) = stream.dict.get(b"BBox").ok().and_then(array::<4>) {
                                let mut bounds = None;
                                for (x, y) in
                                    [(r[0], r[1]), (r[0], r[3]), (r[2], r[1]), (r[2], r[3])]
                                {
                                    let (x, y) = point(multiply(matrix, form_matrix), x, y);
                                    include(&mut bounds, x, y);
                                }
                                if let Some(r) = bounds {
                                    regions.push(r);
                                }
                            } else {
                                uncertain = true;
                            }
                        }
                    } else {
                        uncertain = true;
                    }
                }
            }
            "BI" | "ID" | "sh" => {
                uncertain = true;
            }
            _ => {}
        }
    }
    regions.retain(|r| {
        r.iter().all(|v| v.is_finite())
            && r[2] >= r[0]
            && r[3] >= r[1]
            && r[2] > 0.
            && r[3] > 0.
            && r[0] < width
            && r[1] < height
    });
    // 合并接触的图形和碎片，渲染整个区域，保留叠加的标签、透明度与矢量线条。
    let mut merged: Vec<Rect> = Vec::new();
    for r in regions {
        let mut r = r;
        let mut i = 0;
        while i < merged.len() {
            let b = merged[i];
            if r[0] <= b[2] + 8. && r[2] + 8. >= b[0] && r[1] <= b[3] + 8. && r[3] + 8. >= b[1] {
                r = union(r, merged.remove(i));
                i = 0;
            } else {
                i += 1;
            }
        }
        merged.push(r);
        if merged.len() > 512 {
            uncertain = true;
            break;
        }
    }
    merged.retain(|r| r[2] - r[0] > 2. && r[3] - r[1] > 2.);
    uncertain |= merged.len() > 32
        || merged
            .iter()
            .any(|r| (r[2] - r[0]) * (r[3] - r[1]) > width * height * 0.85);
    merged.sort_by(|a, b| b[3].total_cmp(&a[3]).then(a[0].total_cmp(&b[0])));
    let regions: Vec<Value> = if uncertain {
        Vec::new()
    } else {
        merged.iter().map(|r| {
        let anchor = items.iter().filter(|it| matches!(it.item_type, ItemType::Text) && f64::from(it.y)>=r[3]-2. && !it.text.trim().is_empty())
            .min_by(|a,b| a.y.total_cmp(&b.y)).map(|it| it.text.trim()).unwrap_or("");
        json!({"x":(r[0]-2.).max(0.),"y":(height-r[3]-2.).max(0.),"width":(r[2]+2.).min(width)-(r[0]-2.).max(0.),"height":(r[3]+2.).min(height)-(r[1]-2.).max(0.),"anchor":anchor})
    }).collect()
    };
    Ok(json!({"width":width,"height":height,"fallback":uncertain,"regions":regions}))
}

#[cfg(test)]
#[path = "pdf_visuals_tests.rs"]
mod tests;
