use crate::Failure;
use lopdf::{Document, Object, ObjectId};
use std::collections::HashSet;

pub(crate) fn is_structurally_blank(bytes: &[u8]) -> Result<bool, Failure> {
    let document = Document::load_mem(bytes).map_err(|_| Failure::Malformed)?;
    if document.trailer.has(b"Encrypt") || document.is_encrypted() || document.was_encrypted() {
        return Err(Failure::Encrypted);
    }
    let catalog = resolve(
        &document,
        document
            .trailer
            .get(b"Root")
            .map_err(|_| Failure::Malformed)?,
    )?
    .as_dict()
    .map_err(|_| Failure::Malformed)?;
    let root = catalog
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|_| Failure::Malformed)?;
    if !catalog.has_type(b"Catalog") {
        return Err(Failure::Malformed);
    }
    let mut visited = HashSet::new();
    let mut pages = Vec::new();
    walk(&document, root, None, false, &mut visited, &mut pages, 0)?;
    if pages.len() != 1 {
        return Err(if pages.is_empty() {
            Failure::Malformed
        } else {
            Failure::Unsupported
        });
    }
    let page = document.objects[&pages[0]]
        .as_dict()
        .map_err(|_| Failure::Malformed)?;
    // 仅“键完全不存在”才是结构性空页；空流、Null、空数组、批注均交还 anydoc 判定。
    Ok(!page.has(b"Contents") && !page.has(b"Annots"))
}

// 不调用隐式递归解引用：框及坐标都可能经间接对象引用，必须同时限制深度和环。
fn resolve<'a>(document: &'a Document, mut object: &'a Object) -> Result<&'a Object, Failure> {
    let mut visited = HashSet::new();
    while let Object::Reference(id) = object {
        if visited.len() >= 128 || !visited.insert(*id) {
            return Err(Failure::Malformed);
        }
        object = document.objects.get(id).ok_or(Failure::Malformed)?;
    }
    Ok(object)
}

fn check_media_box(document: &Document, object: &Object) -> Result<(), Failure> {
    let array = resolve(document, object)?
        .as_array()
        .map_err(|_| Failure::Malformed)?;
    if array.len() != 4 {
        return Err(Failure::Malformed);
    }
    let mut bounds = [0.0f64; 4];
    for (bound, object) in bounds.iter_mut().zip(array) {
        *bound = match resolve(document, object)? {
            Object::Integer(value) => *value as f64,
            Object::Real(value) => f64::from(*value),
            _ => return Err(Failure::Malformed),
        };
        if !bound.is_finite() {
            return Err(Failure::Malformed);
        }
    }
    if bounds[2] <= bounds[0] || bounds[3] <= bounds[1] {
        return Err(Failure::Malformed);
    }
    Ok(())
}

fn walk(
    document: &Document,
    id: ObjectId,
    parent: Option<ObjectId>,
    mut has_media_box: bool,
    visited: &mut HashSet<ObjectId>,
    pages: &mut Vec<ObjectId>,
    depth: usize,
) -> Result<usize, Failure> {
    if depth > 128 || !visited.insert(id) {
        return Err(Failure::Malformed);
    }
    if visited.len() > 10_000 {
        return Err(Failure::ResourceLimit);
    }
    // 页树节点必须直接是字典；Parent 必须与从 Catalog 出发遍历的真实父节点相符。
    let dictionary = document
        .objects
        .get(&id)
        .ok_or(Failure::Malformed)?
        .as_dict()
        .map_err(|_| Failure::Malformed)?;
    if let Some(parent) = parent {
        if dictionary
            .get(b"Parent")
            .and_then(Object::as_reference)
            .ok()
            != Some(parent)
        {
            return Err(Failure::Malformed);
        }
    } else if dictionary.has(b"Parent") || !dictionary.has_type(b"Pages") {
        return Err(Failure::Malformed);
    }
    if let Ok(media_box) = dictionary.get(b"MediaBox") {
        check_media_box(document, media_box)?;
        has_media_box = true;
    }
    match dictionary
        .get(b"Type")
        .and_then(Object::as_name)
        .map_err(|_| Failure::Malformed)?
    {
        b"Page" => {
            if !has_media_box || dictionary.has(b"Kids") || dictionary.has(b"Count") {
                return Err(Failure::Malformed);
            }
            pages.push(id);
            Ok(1)
        }
        b"Pages" => {
            if dictionary.has(b"Contents") || dictionary.has(b"Annots") {
                return Err(Failure::Malformed);
            }
            let children = dictionary
                .get(b"Kids")
                .and_then(Object::as_array)
                .map_err(|_| Failure::Malformed)?;
            let mut count = 0usize;
            for child in children {
                let child = child.as_reference().map_err(|_| Failure::Malformed)?;
                count += walk(
                    document,
                    child,
                    Some(id),
                    has_media_box,
                    visited,
                    pages,
                    depth + 1,
                )?;
            }
            if dictionary.get(b"Count").and_then(Object::as_i64).ok() != Some(count as i64) {
                return Err(Failure::Malformed);
            }
            Ok(count)
        }
        _ => Err(Failure::Malformed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_box_rejects_nonfinite_numbers() {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let array = Object::Array(vec![0.into(), 0.into(), value.into(), 792.into()]);
            assert_eq!(
                check_media_box(&Document::new(), &array),
                Err(Failure::Malformed)
            );
        }
    }
}
