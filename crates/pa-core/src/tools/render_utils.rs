//! Image dimension parsing from base64 headers.

use base64::Engine;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

/// The bounded-prefix decode budget for [`get_image_dimensions_prefix`]:
/// every supported format's dimension header lives in the first bytes.
pub const IMAGE_DIMENSIONS_PREFIX_BYTES: usize = 1024;

/// Read an image's pixel dimensions from a BOUNDED PREFIX of its base64 payload — a tool result can
/// carry megabytes of base64, and its metadata row must never decode the whole string. `None` for
/// unsupported mime types or an undecodable prefix.
#[must_use]
pub fn get_image_dimensions_prefix(
    data: &str,
    mime_type: &str,
    max_decoded_bytes: usize,
) -> Option<ImageDimensions> {
    let trimmed = data.trim();
    // Keep the prefix at a multiple of 4 base64 characters so the slice decodes
    // as a complete unpadded sequence; `get` returns `None` when the cut lands
    // inside a multi-byte character (a non-ASCII payload is not decodable anyway).
    let take = (max_decoded_bytes.div_ceil(3) * 4).min(trimmed.len());
    let prefix = trimmed.get(..take)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(prefix)
        .ok()?;
    match mime_type {
        "image/png" => png_dimensions(&bytes),
        "image/gif" => gif_dimensions(&bytes),
        "image/jpeg" => jpeg_dimensions(&bytes),
        "image/webp" => webp_dimensions(&bytes),
        _ => None,
    }
}

fn be_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

fn le_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

fn le_u24(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        0,
    ]))
}

fn png_dimensions(b: &[u8]) -> Option<ImageDimensions> {
    // Signature (8 bytes) then IHDR: length(4) + "IHDR"(4) + width(4) + height(4).
    if b.len() < 24 || &b[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
    let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
    Some(ImageDimensions {
        width_px: w,
        height_px: h,
    })
}

fn gif_dimensions(b: &[u8]) -> Option<ImageDimensions> {
    if b.len() < 10 || &b[..6] != b"GIF87a" && &b[..6] != b"GIF89a" {
        return None;
    }
    Some(ImageDimensions {
        width_px: u32::from(le_u16(b, 6)?),
        height_px: u32::from(le_u16(b, 8)?),
    })
}

fn jpeg_dimensions(b: &[u8]) -> Option<ImageDimensions> {
    let mut i = 2usize;
    while i + 9 < b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let marker = b[i + 1];
        // SOF0..SOF15 except DHT(0xC4), DAC(0xCC), JPG(0xC8), TEM(0xD8).
        let is_sof =
            (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
        let length = usize::from(be_u16(b, i + 2)?);
        if is_sof {
            let height = u32::from(be_u16(b, i + 5)?);
            let width = u32::from(be_u16(b, i + 7)?);
            return Some(ImageDimensions {
                width_px: width,
                height_px: height,
            });
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
        } else {
            i += 2 + length;
        }
    }
    None
}

fn webp_dimensions(b: &[u8]) -> Option<ImageDimensions> {
    if b.len() < 30 || &b[..4] != b"RIFF" || &b[8..12] != b"WEBP" {
        return None;
    }
    match &b[12..16] {
        b"VP8 " => {
            // Lossy: frame tag (3 bytes), then sync code 0x9D 0x01 0x2A, then
            // 14-bit little-endian width/height minus 1.
            let w = (u32::from(le_u16(b, 26)?) & 0x3FFF) + 1;
            let h = (u32::from(le_u16(b, 28)?) & 0x3FFF) + 1;
            Some(ImageDimensions {
                width_px: w,
                height_px: h,
            })
        }
        b"VP8L" => {
            // Lossless: signature 0x2F, then 14-bit packed width/height minus 1.
            let bits = u32::from(le_u16(b, 21)?) | (u32::from(b[23]) << 16);
            let w = (bits & 0x3FFF) + 1;
            let h = ((bits >> 14) & 0x3FFF) + 1;
            Some(ImageDimensions {
                width_px: w,
                height_px: h,
            })
        }
        b"VP8X" => {
            // Extended: canvas size as 24-bit minus 1, width at offset 24, height at 27.
            let w = le_u24(b, 24)? + 1;
            let h = le_u24(b, 27)? + 1;
            Some(ImageDimensions {
                width_px: w,
                height_px: h,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions_parsed() {
        // Minimal PNG header with IHDR 2x3.
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&[0, 0, 0, 13]);
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&2u32.to_be_bytes());
        b.extend_from_slice(&3u32.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        let data = base64::engine::general_purpose::STANDARD.encode(&b);
        let dims = get_image_dimensions_prefix(&data, "image/png", IMAGE_DIMENSIONS_PREFIX_BYTES)
            .expect("minimal png parses");
        assert_eq!((dims.width_px, dims.height_px), (2, 3));
    }
}
