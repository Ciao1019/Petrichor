//! 兼容部分 XLS 写入器把 FAT 表尾部未使用项填为 ENDOFCHAIN 的行为。
//! 仅处理物理文件范围外的条目，不修改真实扇区链；随后仍执行完整 CFB 校验。
use crate::{Failure, MAX_SOURCE_BYTES};
use std::{borrow::Cow, collections::HashSet};

const FREE: u32 = 0xffff_ffff;
const END: u32 = 0xffff_fffe;

fn word(bytes: &[u8], offset: usize) -> Result<u32, Failure> {
    let raw = bytes.get(offset..offset + 4).ok_or(Failure::Malformed)?;
    Ok(u32::from_le_bytes(
        raw.try_into().map_err(|_| Failure::Malformed)?,
    ))
}

fn sector_offset(id: u32, size: usize, count: usize) -> Result<usize, Failure> {
    if id as usize >= count {
        return Err(Failure::Malformed);
    }
    Ok((id as usize + 1) * size)
}

pub(crate) fn normalize(bytes: &[u8]) -> Result<Cow<'_, [u8]>, Failure> {
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(Failure::ResourceLimit);
    }
    if bytes.len() < 512 || !bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
        return Err(Failure::Malformed);
    }
    let version = u16::from_le_bytes([bytes[26], bytes[27]]);
    let shift = u16::from_le_bytes([bytes[30], bytes[31]]);
    let size = match (version, shift) {
        (3, 9) => 512,
        (4, 12) => 4096,
        _ => return Err(Failure::Malformed),
    };
    if bytes.len() % size != 0 || bytes.len() <= size {
        return Err(Failure::Malformed);
    }
    let count = bytes.len() / size - 1;
    let fat_count = word(bytes, 44)? as usize;
    let difat_count = word(bytes, 72)? as usize;
    if fat_count == 0 || fat_count > count || difat_count > count {
        return Err(Failure::Malformed);
    }
    let mut fat = Vec::with_capacity(fat_count);
    let mut seen = HashSet::new();
    let mut push_fat = |id| -> Result<(), Failure> {
        if id == FREE {
            return Ok(());
        }
        sector_offset(id, size, count)?;
        if fat.len() >= fat_count || !seen.insert(id) {
            return Err(Failure::Malformed);
        }
        fat.push(id);
        Ok(())
    };
    for index in 0..109 {
        push_fat(word(bytes, 76 + index * 4)?)?;
    }
    let mut next = word(bytes, 68)?;
    let mut difat_seen = HashSet::new();
    for _ in 0..difat_count {
        let offset = sector_offset(next, size, count)?;
        if !difat_seen.insert(next) {
            return Err(Failure::Malformed);
        }
        for index in 0..size / 4 - 1 {
            push_fat(word(bytes, offset + index * 4)?)?;
        }
        next = word(bytes, offset + size - 4)?;
    }
    drop(push_fat);
    if (next != END && !(difat_count == 0 && next == FREE))
        || fat.len() != fat_count
        || fat.iter().any(|id| difat_seen.contains(id))
        || fat_count * (size / 4) < count
    {
        return Err(Failure::Malformed);
    }
    let mut normalized = Cow::Borrowed(bytes);
    let entries = size / 4;
    for (table, id) in fat.into_iter().enumerate() {
        let offset = sector_offset(id, size, count)?;
        // 只改代表“不存在的物理扇区”的填充项，实际扇区的 END 保持原样。
        for index in 0..entries {
            if table * entries + index < count {
                continue;
            }
            let position = offset + index * 4;
            match word(bytes, position)? {
                FREE => {}
                END => {
                    normalized.to_mut()[position..position + 4].copy_from_slice(&FREE.to_le_bytes())
                }
                _ => return Err(Failure::Malformed),
            }
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        let mut bytes = vec![0; 4 * 512];
        bytes[..8].copy_from_slice(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1");
        bytes[26..28].copy_from_slice(&3u16.to_le_bytes());
        bytes[30..32].copy_from_slice(&9u16.to_le_bytes());
        bytes[44..48].copy_from_slice(&1u32.to_le_bytes());
        bytes[68..72].copy_from_slice(&END.to_le_bytes());
        for index in 0..109 {
            bytes[76 + index * 4..80 + index * 4].copy_from_slice(&FREE.to_le_bytes());
        }
        bytes[76..80].copy_from_slice(&1u32.to_le_bytes());
        let fat = 2 * 512;
        for index in 0..128 {
            bytes[fat + index * 4..fat + index * 4 + 4].copy_from_slice(&END.to_le_bytes());
        }
        bytes[fat + 4..fat + 8].copy_from_slice(&0xffff_fffdu32.to_le_bytes());
        bytes
    }

    #[test]
    fn changes_only_padding_beyond_physical_sectors() {
        let bytes = fixture();
        let result = normalize(&bytes).unwrap();
        assert!(matches!(result, Cow::Owned(_)));
        assert_eq!(&result[..1024 + 3 * 4], &bytes[..1024 + 3 * 4]);
        for index in 3..128 {
            assert_eq!(word(&result, 1024 + index * 4).unwrap(), FREE);
        }
        assert_eq!(&result[1536..], &bytes[1536..]);
        assert!(matches!(normalize(&result).unwrap(), Cow::Borrowed(_)));
    }

    #[test]
    fn invalid_actual_chain_is_not_repaired() {
        let mut bytes = fixture();
        bytes[1024..1028].copy_from_slice(&900u32.to_le_bytes());
        let result = normalize(&bytes).unwrap();
        assert_eq!(word(&result, 1024).unwrap(), 900);
        // 此处只验证原始指针未被改写；从合法 CFB 构造的拒绝负例见 tests/xls_padding.rs。
    }

    #[test]
    fn rejects_unknown_padding_and_invalid_allocation_metadata() {
        for offset in [44, 68, 76, 1024 + 3 * 4] {
            let mut bytes = fixture();
            bytes[offset..offset + 4].copy_from_slice(&900u32.to_le_bytes());
            assert_eq!(normalize(&bytes), Err(Failure::Malformed));
        }
        let mut bytes = fixture();
        bytes.pop();
        assert_eq!(normalize(&bytes), Err(Failure::Malformed));
    }
}
