//! 将正文排版装饰与图形区分，避免网页打印 PDF 被整页截图反复插入。
use super::Rect;
use lopdf::{Dictionary, Document, Object};
use pdf_inspector::types::{ItemType, TextItem};
use std::collections::HashSet;

pub(super) fn monospace_fonts(doc: &Document, page_id: lopdf::ObjectId) -> HashSet<String> {
    let mut names = HashSet::new();
    let Ok((local, inherited)) = doc.get_page_resources(page_id) else {
        return names;
    };
    for resource in local.into_iter().chain(
        inherited
            .iter()
            .filter_map(|id| doc.get_dictionary(*id).ok()),
    ) {
        let Some(fonts) = resource
            .get(b"Font")
            .ok()
            .and_then(|v| doc.dereference(v).ok())
            .and_then(|(_, v)| v.as_dict().ok())
        else {
            continue;
        };
        for (name, value) in fonts.iter() {
            let Some(font) = doc
                .dereference(value)
                .ok()
                .and_then(|(_, v)| v.as_dict().ok())
            else {
                continue;
            };
            let Ok(base) = font.get(b"BaseFont").and_then(Object::as_name) else {
                continue;
            };
            let base = String::from_utf8_lossy(base).to_ascii_lowercase();
            if ["mono", "courier", "consolas", "menlo"]
                .iter()
                .any(|value| base.contains(value))
            {
                names.insert(String::from_utf8_lossy(name).into_owned());
            }
        }
    }
    names
}

pub(super) fn has_visual_annotations(doc: &Document, page: &Dictionary) -> bool {
    let Ok(value) = page.get(b"Annots") else {
        return false;
    };
    let Some(values) = doc
        .dereference(value)
        .ok()
        .and_then(|(_, v)| v.as_array().ok())
    else {
        return true;
    };
    values.iter().any(|value| {
        let Some(annotation) = doc
            .dereference(value)
            .ok()
            .and_then(|(_, v)| v.as_dict().ok())
        else {
            return true;
        };
        // 普通超链接没有独立可见内容；带外观流的链接、批注和图章仍需保留。
        annotation.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Link")
            || annotation.has(b"AP")
    })
}

fn text(item: &TextItem) -> bool {
    matches!(item.item_type, ItemType::Text) && !item.text.trim().is_empty()
}

fn inside(r: Rect, item: &TextItem) -> bool {
    let (x, y, w) = (f64::from(item.x), f64::from(item.y), f64::from(item.width));
    text(item) && y >= r[1] - 2. && y <= r[3] + 2. && x + w > r[0] && x < r[2]
}

// 仅接受沿矩形边界绘制的闭合底框（可含圆角）；三角形、曲线和内部连线不能被归为底色。
pub(super) fn box_outline(r: Rect, points: &[(f64, f64)]) -> bool {
    let tolerance = ((r[2] - r[0]).min(r[3] - r[1]) * 0.15).clamp(0.5, 4.);
    let corners = [(r[0], r[1]), (r[0], r[3]), (r[2], r[1]), (r[2], r[3])];
    points.len() >= 4
        && corners.iter().all(|(x, y)| {
            points
                .iter()
                .any(|(px, py)| (px - x).abs() <= tolerance && (py - y).abs() <= tolerance)
        })
        && points.iter().all(|(x, y)| {
            (x - r[0]).abs() <= tolerance
                || (x - r[2]).abs() <= tolerance
                || (y - r[1]).abs() <= tolerance
                || (y - r[3]).abs() <= tolerance
        })
}

// 宽幅填充框中已存在多行正文，属于正文底板；框中的图片和后续矢量笔画仍独立保留。
pub(super) fn text_backdrop(r: Rect, page_width: f64, items: &[TextItem]) -> bool {
    if r[2] - r[0] < page_width * 0.8 {
        return false;
    }
    let mut lines = items
        .iter()
        .filter(|item| inside(r, item))
        .map(|item| item.y);
    let Some(first) = lines.next() else {
        return false;
    };
    lines.any(|y| (y - first).abs() > 8.)
}

// 只忽略与普通段落相邻的单行等宽代码底框，不把独立图表节点/多行代码框当装饰。
pub(super) fn inline_code_backdrop(
    r: Rect,
    items: &[TextItem],
    mono_fonts: &HashSet<String>,
) -> bool {
    items.iter().filter(|item| inside(r, item)).any(|item| {
        let size = f64::from(item.font_size).max(1.);
        if !mono_fonts.contains(&item.font) || r[3] - r[1] > size * 2.2 || r[3] - r[1] < size * 0.6
        {
            return false;
        }
        items.iter().any(|neighbor| {
            if !text(neighbor)
                || neighbor.font == item.font
                || (neighbor.y - item.y).abs() > item.font_size * 0.5
            {
                return false;
            }
            let (left, right) = (
                f64::from(neighbor.x),
                f64::from(neighbor.x + neighbor.width),
            );
            (right <= r[0] + 2. && r[0] - right <= size * 1.5)
                || (left >= r[2] - 2. && left - r[2] <= size * 1.5)
        })
    })
}
