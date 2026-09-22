//! Result-rendering helpers shared by tool renderers.
//!
//! Port of `packages/coding-agent/src/core/tools/render-utils.ts`, including
//! `sanitizeBinaryOutput` from `utils/shell.ts`, the `strip-ansi` package's
//! pattern, and the `imageFallback` / `getImageDimensions` helpers from
//! `packages/tui/src/terminal-image.ts`.

use base64::Engine;

use pa_types::ai::{ImageContent, TextContent, UserContentBlock};

use crate::tools::shell_utils::sanitize_binary_output;

/// `[Image: ...]` fallback text for an image that cannot be displayed.
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
    if let Some(dims) = dimensions {
        parts.push(format!("{}x{}", dims.width_px, dims.height_px));
    }
    format!("[Image: {}]", parts.join(" "))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

/// Decode base64 image bytes and read their pixel dimensions.
///
/// Mirrors the TS `getImageDimensions(data, mimeType)`: returns `None`
/// for unknown mime types or undecodable payloads.
pub fn get_image_dimensions(data: &str, mime_type: &str) -> Option<ImageDimensions> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
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

/// Shorten an absolute path under the user's home directory to `~/...`.
pub fn shorten_path(path: &str) -> String {
    let home = pa_types::platform::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !home.is_empty() && path.starts_with(&home) {
        return format!("~{}", &path[home.len()..]);
    }
    path.to_string()
}

/// Replace tab characters with three spaces (TUI tool-call rendering).
pub fn replace_tabs(text: &str) -> String {
    text.replace('\t', "   ")
}

/// A tool-result content block (text or image).
pub type ContentBlock = UserContentBlock;

/// Build a text block.
pub fn text_block(text: impl Into<String>) -> ContentBlock {
    ContentBlock::Text(TextContent {
        text: text.into(),
        text_signature: None,
        rest: Default::default(),
    })
}

/// Build an image block.
pub fn image_block(data: impl Into<String>, mime_type: impl Into<String>) -> ContentBlock {
    ContentBlock::Image(ImageContent {
        data: data.into(),
        mime_type: mime_type.into(),
        rest: Default::default(),
    })
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TextOutputOptions {
    /// Whether image fallbacks should parse image dimensions from base64 data.
    pub include_image_dimensions: bool,
}

/// Join a tool result's content into the plain-text output shown for it.
///
/// Port of `getTextOutput`: text blocks are ANSI-stripped, sanitized, and
/// joined with newlines; images that are not shown inline become
/// `[Image: ...]` fallback lines.
pub fn get_text_output(
    content: &[ContentBlock],
    show_images: bool,
    options: TextOutputOptions,
) -> String {
    let text_blocks: Vec<&str> = content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect();
    let image_blocks: Vec<(&str, &str)> = content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Image(img) => Some((img.data.as_str(), img.mime_type.as_str())),
            _ => None,
        })
        .collect();

    let mut output = text_blocks
        .iter()
        .map(|text| {
            let stripped = strip_ansi(text);
            let sanitized = sanitize_binary_output(&stripped);
            sanitized.replace('\r', "")
        })
        .collect::<Vec<_>>()
        .join("\n");

    if !image_blocks.is_empty() && !show_images {
        let indicators = image_blocks
            .iter()
            .map(|(data, mime_type)| {
                let dims = if options.include_image_dimensions {
                    get_image_dimensions(data, mime_type)
                } else {
                    None
                };
                image_fallback(mime_type, dims, None)
            })
            .collect::<Vec<_>>()
            .join("\n");
        output = if output.is_empty() {
            indicators
        } else {
            format!("{output}\n{indicators}")
        };
    }

    output
}

/// Remove ANSI escape sequences, using the exact pattern of the `strip-ansi` npm package.
pub fn strip_ansi(text: &str) -> String {
    let re = fancy_regex::Regex::new(
        r"[\x{001B}\x{009B}][\[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x{0007})|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))",
    )
    .expect("valid strip-ansi pattern");
    re.replace_all(text, "").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("\x1b[1;32mbold green\x1b[39;49m"), "bold green");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    // HOME-asserting: with no HOME (the Windows default), the shortening
    // no-ops, so the test only runs where HOME is the real source.
    #[cfg(unix)]
    #[test]
    fn shorten_path_replaces_home() {
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(shorten_path(&format!("{home}/a/b")), "~/a/b");
        assert_eq!(shorten_path("/etc/passwd"), "/etc/passwd");
    }

    #[test]
    fn text_output_joins_and_strips() {
        let blocks = vec![text_block("a\r\n"), text_block("\x1b[2mb\x1b[0m")];
        assert_eq!(
            get_text_output(&blocks, true, TextOutputOptions::default()),
            "a\n\nb"
        );
    }

    #[test]
    fn image_fallback_text() {
        assert_eq!(
            image_fallback("image/png", None, None),
            "[Image: [image/png]]"
        );
        assert_eq!(
            image_fallback(
                "image/png",
                Some(ImageDimensions {
                    width_px: 4,
                    height_px: 2
                }),
                None
            ),
            "[Image: [image/png] 4x2]"
        );
    }

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
        let dims = get_image_dimensions(&data, "image/png").unwrap();
        assert_eq!((dims.width_px, dims.height_px), (2, 3));
    }
}
