//! Terminal image metadata: pixel-dimension parsing, the bounded-prefix
//! dimension read the render path uses, and the textual fallback row.
//! Every tool-result image row is the textual fallback (TS mounts `Image`
//! components with `fallbackOnly`), so the TUI never decodes a whole
//! payload: [`get_image_dimensions_prefix`] reads dimensions from a
//! bounded prefix. [`is_image_line`] stays for the exit-flush scrollback.

/// Image pixel dimensions (TS `ImageDimensions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

const KITTY_PREFIX: &str = "\x1b_G";
const ITERM2_PREFIX: &str = "\x1b]1337;File=";

/// Whether a rendered row carries an image placement sequence (TS
/// `isImageLine`).
pub fn is_image_line(line: &str) -> bool {
    line.contains(KITTY_PREFIX) || line.contains(ITERM2_PREFIX)
}

fn png_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    if bytes.len() < 24 {
        return None;
    }
    if bytes[0] != 0x89 || bytes[1] != 0x50 || bytes[2] != 0x4e || bytes[3] != 0x47 {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some(ImageDimensions {
        width_px: width,
        height_px: height,
    })
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    use std::cmp::min;
    if bytes.len() < 2 {
        return None;
    }
    if bytes[0] != 0xff || bytes[1] != 0xd8 {
        return None;
    }
    let mut offset = 2usize;
    while offset + 9 < bytes.len() {
        if bytes[offset] != 0xff {
            offset += 1;
            continue;
        }
        let marker = bytes[offset + 1];
        if (0xc0..=0xc2).contains(&marker) {
            let height = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]);
            let width = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]);
            return Some(ImageDimensions {
                width_px: u32::from(width),
                height_px: u32::from(height),
            });
        }
        if offset + 3 >= bytes.len() {
            return None;
        }
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]);
        if length < 2 {
            return None;
        }
        offset = min(offset + 2 + length as usize, bytes.len());
    }
    None
}

fn gif_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    if bytes.len() < 10 {
        return None;
    }
    let signature = &bytes[..6];
    if signature != b"GIF87a" && signature != b"GIF89a" {
        return None;
    }
    let width = u16::from_le_bytes([bytes[6], bytes[7]]);
    let height = u16::from_le_bytes([bytes[8], bytes[9]]);
    Some(ImageDimensions {
        width_px: u32::from(width),
        height_px: u32::from(height),
    })
}

fn webp_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    if bytes.len() < 30 {
        return None;
    }
    if &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let chunk = &bytes[12..16];
    if chunk == b"VP8 " {
        let width = u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff;
        let height = u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff;
        Some(ImageDimensions {
            width_px: u32::from(width),
            height_px: u32::from(height),
        })
    } else if chunk == b"VP8L" {
        if bytes.len() < 25 {
            return None;
        }
        let bits = u32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
        let width = (bits & 0x3fff) + 1;
        let height = ((bits >> 14) & 0x3fff) + 1;
        Some(ImageDimensions {
            width_px: width,
            height_px: height,
        })
    } else if chunk == b"VP8X" {
        let width =
            (u32::from(bytes[24]) | u32::from(bytes[25]) << 8 | u32::from(bytes[26]) << 16) + 1;
        let height =
            (u32::from(bytes[27]) | u32::from(bytes[28]) << 8 | u32::from(bytes[29]) << 16) + 1;
        Some(ImageDimensions {
            width_px: width,
            height_px: height,
        })
    } else {
        None
    }
}

/// The bounded-prefix decode budget for [`get_image_dimensions_prefix`]:
/// a payload whose header spills past the budget reports `None`.
pub const IMAGE_DIMENSIONS_PREFIX_BYTES: usize = 1024;

/// Read an image's pixel dimensions from a BOUNDED PREFIX of its base64
/// payload (image-heavy tool results must never be decoded whole for a
/// metadata row). `None` for unsupported mime types, payloads that do
/// not decode at the quantum-aligned prefix, or headers that spill past
/// [`IMAGE_DIMENSIONS_PREFIX_BYTES`].
pub fn get_image_dimensions_prefix(
    base64_data: &str,
    mime_type: &str,
    max_decoded_bytes: usize,
) -> Option<ImageDimensions> {
    use base64::Engine;
    // The bounded window comes first and the trim stays INSIDE it: a
    // payload padded with megabytes of trailing whitespace never pays a
    // full-suffix scan.
    let window = base64_data.trim_start();
    let take = (max_decoded_bytes.div_ceil(3) * 4).min(window.len());
    let window = window.get(..take)?.trim_end();
    // Keep the prefix at a multiple of 4 base64 characters so the slice
    // decodes as a complete unpadded sequence.
    let aligned = window.len() - window.len() % 4;
    let prefix = window.get(..aligned)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(prefix)
        .ok()?;
    match mime_type {
        "image/png" => png_dimensions(&bytes),
        "image/jpeg" => jpeg_dimensions(&bytes),
        "image/gif" => gif_dimensions(&bytes),
        "image/webp" => webp_dimensions(&bytes),
        _ => None,
    }
}

/// The textual fallback for an image that cannot be displayed (TS
/// `imageFallback`).
pub fn image_fallback(
    mime_type: &str,
    dimensions: Option<ImageDimensions>,
    filename: Option<&str>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(filename) = filename {
        parts.push(filename.to_string());
    }
    parts.push(format!("[{mime_type}]"));
    if let Some(dimensions) = dimensions {
        parts.push(format!("{}x{}", dimensions.width_px, dimensions.height_px));
    }
    format!("[Image: {}]", parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn tiny_png(width: u32, height: u32) -> String {
        let mut bytes = vec![0x89, b'P', b'N', b'G'];
        bytes.extend(vec![0u8; 12]); // length + IHDR tag
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn png_dimensions_parse_from_payload() {
        let data = tiny_png(64, 32);
        assert_eq!(
            get_image_dimensions_prefix(&data, "image/png", IMAGE_DIMENSIONS_PREFIX_BYTES),
            Some(ImageDimensions {
                width_px: 64,
                height_px: 32
            })
        );
        assert_eq!(
            get_image_dimensions_prefix(&data, "image/jpeg", IMAGE_DIMENSIONS_PREFIX_BYTES),
            None
        );
        assert_eq!(
            get_image_dimensions_prefix("!!!", "image/png", IMAGE_DIMENSIONS_PREFIX_BYTES),
            None
        );
    }

    #[test]
    fn jpeg_dimensions_parse_from_sof_marker() {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        bytes.extend(*b"JFIF");
        bytes.extend(vec![0u8; 12]); // APP0 body
        bytes.extend([0xff, 0xc0, 0x00, 0x11, 0x08]); // SOF0
        bytes.extend(720u16.to_be_bytes()); // height
        bytes.extend(1080u16.to_be_bytes()); // width
        bytes.extend(vec![0u8; 8]); // SOF payload tail: the scan needs
                                    // `offset + 9 < len`
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert_eq!(
            get_image_dimensions_prefix(&data, "image/jpeg", IMAGE_DIMENSIONS_PREFIX_BYTES),
            Some(ImageDimensions {
                width_px: 1080,
                height_px: 720
            })
        );
    }

    #[test]
    fn gif_and_webp_dimensions_parse() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend(32u16.to_le_bytes());
        gif.extend(16u16.to_le_bytes());
        let data = base64::engine::general_purpose::STANDARD.encode(gif);
        assert_eq!(
            get_image_dimensions_prefix(&data, "image/gif", IMAGE_DIMENSIONS_PREFIX_BYTES),
            Some(ImageDimensions {
                width_px: 32,
                height_px: 16
            })
        );

        let mut webp = b"RIFF".to_vec();
        webp.extend([0x24, 0x00, 0x00, 0x00]); // size
        webp.extend(b"WEBPVP8X");
        webp.extend(vec![0u8; 14]); // VP8X size + flags + canvas minus-1
        webp[24] = 0x63; // width - 1 = 99
        webp[27] = 0x4f; // height - 1 = 79
        let data = base64::engine::general_purpose::STANDARD.encode(webp);
        assert_eq!(
            get_image_dimensions_prefix(&data, "image/webp", IMAGE_DIMENSIONS_PREFIX_BYTES),
            Some(ImageDimensions {
                width_px: 100,
                height_px: 80
            })
        );
    }

    #[test]
    fn the_prefix_read_stays_bounded_around_whitespace_padding() {
        let padded = format!("{}{}", tiny_png(64, 32), " ".repeat(1 << 20));
        assert_eq!(
            get_image_dimensions_prefix(&padded, "image/png", IMAGE_DIMENSIONS_PREFIX_BYTES),
            Some(ImageDimensions {
                width_px: 64,
                height_px: 32
            })
        );
        let newline = format!("{}\n", tiny_png(64, 32));
        assert_eq!(
            get_image_dimensions_prefix(&newline, "image/png", IMAGE_DIMENSIONS_PREFIX_BYTES),
            Some(ImageDimensions {
                width_px: 64,
                height_px: 32
            })
        );
        assert_eq!(
            get_image_dimensions_prefix(
                &" ".repeat(4096),
                "image/png",
                IMAGE_DIMENSIONS_PREFIX_BYTES
            ),
            None
        );
    }

    #[test]
    fn the_prefix_read_never_touches_the_payload_past_the_budget() {
        // A payload whose prefix decodes but whose tail (past the
        // budget) is invalid base64 still reports its dimensions.
        let header = tiny_png(640, 480);
        let poisoned = format!("{header}{}{}", "A".repeat(4096), "!".repeat(64));
        assert_eq!(
            get_image_dimensions_prefix(&poisoned, "image/png", IMAGE_DIMENSIONS_PREFIX_BYTES),
            Some(ImageDimensions {
                width_px: 640,
                height_px: 480
            })
        );
        // A header that spills past the budget reports None: dims sit
        // at byte 16 here, so a 12-byte budget cannot see them.
        assert_eq!(get_image_dimensions_prefix(&header, "image/png", 12), None);
    }

    #[test]
    fn fallback_text_shapes() {
        assert_eq!(
            image_fallback("image/png", None, None),
            "[Image: [image/png]]"
        );
        assert_eq!(
            image_fallback(
                "image/png",
                Some(ImageDimensions {
                    width_px: 800,
                    height_px: 600
                }),
                None
            ),
            "[Image: [image/png] 800x600]"
        );
        assert_eq!(
            image_fallback(
                "image/png",
                Some(ImageDimensions {
                    width_px: 8,
                    height_px: 6
                }),
                Some("shot.png")
            ),
            "[Image: shot.png [image/png] 8x6]"
        );
    }

    #[test]
    fn is_image_line_detects_both_protocols() {
        assert!(is_image_line("\x1b_Ga=T;QUJD\x1b\\"));
        assert!(is_image_line("\x1b[3A\x1b_Ga=T;QUJD\x1b\\"));
        assert!(is_image_line("\x1b]1337;File=inline=1:QQ\x07"));
        assert!(!is_image_line("plain row"));
    }
}
