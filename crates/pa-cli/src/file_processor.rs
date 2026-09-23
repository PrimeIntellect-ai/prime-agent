//! `@file` argument expansion for the initial prompt, ported from
//! `cli/file-processor.ts` (`processFileArguments`): each argument becomes
//! either a `<file name>` text block or a base64 image attachment.
//!
//! The image path is the `utils/mime.ts` sniff (magic bytes, never the
//! extension) plus the same 4.5MB inline limit TS enforces on the base64
//! payload. TS resizes oversized images through its Photon converter; this
//! build has no resize engine, so an oversized image under the auto-resize
//! setting falls back to the converter-unavailable text TS emits
//! (`[Image omitted: ...]`) instead of attaching an unusable payload. With
//! auto-resize off, TS attaches the raw payload regardless of size, and so
//! does this path.

use std::path::{Path, PathBuf};

use pa_agent::types::ImageContent;

/// TS `DEFAULT_MAX_BYTES`: 4.5MB of base64 payload, headroom below the
/// provider's 5MB limit.
const DEFAULT_MAX_BYTES: usize = 4_500_000;

/// The expanded first prompt: @file text blocks joined into one string,
/// plus the image attachments.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ProcessedFiles {
    pub text: String,
    pub images: Vec<ImageContent>,
}

/// A file-argument failure: the exact stderr line TS prints before
/// `process.exit(1)`.
#[derive(Debug, Clone, PartialEq)]
pub struct FileProcessingError {
    pub message: String,
}

/// Expand the `@file` arguments (TS `processFileArguments`): every
/// argument resolves against the cwd (with the TS macOS filename
/// variants), a missing file fails the run, an empty file is skipped, an
/// image attaches as base64, and anything else embeds as a `<file name>`
/// text block.
pub fn process_file_arguments(
    file_args: &[String],
    cwd: &Path,
    auto_resize_images: bool,
) -> Result<ProcessedFiles, FileProcessingError> {
    let mut processed = ProcessedFiles::default();
    for file_arg in file_args {
        let resolved = pa_core::resolve_read_path(file_arg, &cwd.to_string_lossy());
        let absolute_path = PathBuf::from(&resolved);
        let metadata = std::fs::metadata(&absolute_path).map_err(|_| FileProcessingError {
            message: format!("Error: File not found: {resolved}"),
        })?;
        if metadata.len() == 0 {
            continue;
        }
        match pa_tui::image_load::load_image_from_path(&absolute_path) {
            // An image: attach the payload (the same sniff the paste path
            // uses), with the auto-resize setting gating the size limit.
            Ok(Some(image)) => {
                if auto_resize_images && image.data.len() > DEFAULT_MAX_BYTES {
                    processed.text.push_str(
                        &format!(
                            "<file name=\"{resolved}\">[Image omitted: could not be resized below the inline image size limit.]</file>\n",
                        ),
                    );
                    continue;
                }
                processed.images.push(ImageContent {
                    data: image.data,
                    mime_type: image.mime_type,
                });
                processed
                    .text
                    .push_str(&format!("<file name=\"{resolved}\"></file>\n"));
            }
            // Not an image: embed the UTF-8 content in a file block.
            Ok(None) => {
                let content = std::fs::read_to_string(&absolute_path).map_err(|error| {
                    FileProcessingError {
                        message: format!("Error: Could not read file {resolved}: {error}"),
                    }
                })?;
                processed
                    .text
                    .push_str(&format!("<file name=\"{resolved}\">\n{content}\n</file>\n"));
            }
            Err(error) => {
                return Err(FileProcessingError {
                    message: format!("Error: Could not read file {resolved}: {error}"),
                });
            }
        }
    }
    Ok(processed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    #[test]
    fn text_files_embed_in_file_blocks() {
        let (_guard, dir) = temp_dir();
        let file = dir.join("notes.md");
        std::fs::write(&file, "the content").expect("write fixture");
        let processed = process_file_arguments(&[file.to_string_lossy().to_string()], &dir, true)
            .expect("process");
        assert_eq!(processed.images, Vec::new());
        assert_eq!(
            processed.text,
            format!(
                "<file name=\"{}\">\nthe content\n</file>\n",
                file.to_string_lossy()
            )
        );
    }

    #[test]
    fn relative_paths_resolve_against_the_cwd() {
        let (_guard, dir) = temp_dir();
        std::fs::write(dir.join("a.txt"), "relative").expect("write fixture");
        let processed =
            process_file_arguments(&["a.txt".to_string()], &dir, true).expect("process");
        assert!(processed.text.contains("relative"));
        assert!(processed.text.contains(&format!(
            "<file name=\"{}\">",
            dir.join("a.txt").to_string_lossy()
        )));
    }

    #[test]
    fn missing_file_fails_with_the_ts_error() {
        let (_guard, dir) = temp_dir();
        let missing = dir.join("nope.txt").to_string_lossy().to_string();
        let error = process_file_arguments(std::slice::from_ref(&missing), &dir, true).unwrap_err();
        assert_eq!(error.message, format!("Error: File not found: {missing}"));
    }

    #[test]
    fn empty_files_are_skipped() {
        let (_guard, dir) = temp_dir();
        let file = dir.join("empty.txt");
        std::fs::write(&file, "").expect("write fixture");
        let processed = process_file_arguments(&[file.to_string_lossy().to_string()], &dir, true)
            .expect("process");
        assert_eq!(processed, ProcessedFiles::default());
    }

    #[test]
    fn images_attach_as_base64_content() {
        let (_guard, dir) = temp_dir();
        // A minimal 1x1 PNG (the magic prefix the sniffer matches).
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        ];
        let file = dir.join("pixel.png");
        std::fs::write(&file, png).expect("write fixture");
        let processed = process_file_arguments(&[file.to_string_lossy().to_string()], &dir, true)
            .expect("process");
        assert_eq!(processed.images.len(), 1);
        assert_eq!(processed.images[0].mime_type, "image/png");
        assert!(processed.text.contains(&format!(
            "<file name=\"{}\"></file>",
            file.to_string_lossy()
        )));
    }

    #[test]
    fn oversized_images_under_auto_resize_get_the_omitted_note() {
        let (_guard, dir) = temp_dir();
        // A PNG-magic payload whose base64 exceeds the 4.5MB limit.
        let mut png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend(std::iter::repeat_n(0u8, 4_000_000));
        let file = dir.join("huge.png");
        std::fs::write(&file, &png).expect("write fixture");
        let processed = process_file_arguments(&[file.to_string_lossy().to_string()], &dir, true)
            .expect("process");
        assert_eq!(processed.images, Vec::new());
        assert!(processed
            .text
            .contains("[Image omitted: could not be resized below the inline image size limit.]"));
    }

    #[test]
    fn auto_resize_off_attaches_the_raw_payload() {
        let (_guard, dir) = temp_dir();
        let mut png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend(std::iter::repeat_n(0u8, 4_000_000));
        let file = dir.join("huge.png");
        std::fs::write(&file, &png).expect("write fixture");
        let processed = process_file_arguments(&[file.to_string_lossy().to_string()], &dir, false)
            .expect("process");
        assert_eq!(processed.images.len(), 1);
    }
}
