//! Image loading from disk with MIME-type detection for the supported
//! attachment formats (PNG, JPEG, GIF, WebP - the attach-image skill's
//! formats).
//!
//! The contract is the TS `utils/mime.ts` + `cli/file-processor.ts` image
//! path: sniff a bounded prefix of the file's bytes (never trust the
//! extension), keep only the supported image types, and read the payload
//! as base64.

use std::path::Path;

use base64::Engine;

/// The supported attachment mime types (TS `IMAGE_MIME_TYPES`).
pub const SUPPORTED_IMAGE_MIME_TYPES: [&str; 4] =
    ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// How many leading bytes are sniffed for format detection (TS
/// `FILE_TYPE_SNIFF_BYTES`).
const SNIFF_BYTES: usize = 4100;

/// A loaded image attachment: base64 payload plus its detected mime type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedImage {
    pub data: String,
    pub mime_type: String,
}

/// Detect the supported image mime type from leading bytes (the same
/// magic signatures the `file-type` package matches for these formats).
pub fn detect_supported_image_mime_from_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Detect the supported image mime type of a file, reading only the sniff
/// prefix. `Ok(None)` for a non-image or empty file (TS
/// `detectSupportedImageMimeTypeFromFile`).
pub fn detect_supported_image_mime_from_path(path: &Path) -> std::io::Result<Option<&'static str>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; SNIFF_BYTES];
    let read = file.read(&mut buffer)?;
    buffer.truncate(read);
    if buffer.is_empty() {
        return Ok(None);
    }
    Ok(detect_supported_image_mime_from_bytes(&buffer))
}

/// Load an image file as an attachment payload. `Ok(None)` when the file
/// is empty or not a supported image (TS `processFileArguments`' image
/// branch treats those as plain text instead; the caller decides).
pub fn load_image_from_path(path: &Path) -> std::io::Result<Option<LoadedImage>> {
    let Some(mime_type) = detect_supported_image_mime_from_path(path)? else {
        return Ok(None);
    };
    let bytes = std::fs::read(path)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(LoadedImage {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: mime_type.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_image(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        // Leak the dir: the tempdir guard would drop the file on scope
        // exit; keep the path alive for the assertion lifetime instead.
        std::mem::forget(dir);
        path
    }

    #[test]
    fn sniffs_each_supported_format_from_magic_bytes() {
        assert_eq!(
            detect_supported_image_mime_from_bytes(&[
                0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a
            ]),
            Some("image/png")
        );
        assert_eq!(
            detect_supported_image_mime_from_bytes(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(
            detect_supported_image_mime_from_bytes(b"GIF89a\x01\x02"),
            Some("image/gif")
        );
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBPVP8 ");
        assert_eq!(
            detect_supported_image_mime_from_bytes(&webp),
            Some("image/webp")
        );
        assert_eq!(detect_supported_image_mime_from_bytes(b"hello"), None);
        assert_eq!(detect_supported_image_mime_from_bytes(b""), None);
    }

    #[test]
    fn sniff_ignores_extensions_and_reads_only_the_prefix() {
        let png = temp_image("notes.png", b"this is not an image at all");
        assert_eq!(
            detect_supported_image_mime_from_path(&png).unwrap(),
            None,
            "content, not the name, decides"
        );
        let jpeg = temp_image("photo.txt", &[0xff, 0xd8, 0xff, 0xe0, 0, 0]);
        assert_eq!(
            detect_supported_image_mime_from_path(&jpeg).unwrap(),
            Some("image/jpeg")
        );
    }

    #[test]
    fn loads_supported_images_as_base64_attachments() {
        let gif = temp_image("a.gif", b"GIF89a\x02\x00\x01\x00");
        let loaded = load_image_from_path(&gif).unwrap().expect("image");
        assert_eq!(loaded.mime_type, "image/gif");
        assert_eq!(
            loaded.data,
            base64::engine::general_purpose::STANDARD.encode(b"GIF89a\x02\x00\x01\x00")
        );
        let text = temp_image("a.txt", b"just text");
        assert_eq!(load_image_from_path(&text).unwrap(), None);
        let empty = temp_image("a.png", b"");
        assert_eq!(load_image_from_path(&empty).unwrap(), None);
    }

    #[test]
    fn missing_file_is_an_error_not_none() {
        assert!(detect_supported_image_mime_from_path(Path::new("/nonexistent/x.png")).is_err());
    }
}
