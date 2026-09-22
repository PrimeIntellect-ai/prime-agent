//! Reading an image from the system clipboard for editor paste.
//!
//! The contract is the TS `utils/clipboard-image.ts`: enumerate the
//! clipboard's available types, prefer a supported image type (PNG, JPEG,
//! GIF, WebP), read its bytes, and hand back the payload plus its mime
//! type. On WSL the Windows clipboard is reached through PowerShell and a
//! temp PNG file (the temp-file write); on macOS the pasteboard is read
//! through a JavaScript-for-Automation script.
//!
//! Every reader is best-effort: a missing tool, an empty clipboard, or an
//! unsupported type returns `None` and the paste is a no-op (the TS
//! behavior when its native module or Photon converter is unavailable -
//! an unsupported type is dropped rather than sent).

use std::time::Duration;

use tokio::process::Command;

use crate::image_load::{LoadedImage, SUPPORTED_IMAGE_MIME_TYPES};

const DEFAULT_LIST_TIMEOUT: Duration = Duration::from_millis(1000);
const DEFAULT_READ_TIMEOUT: Duration = Duration::from_millis(3000);
const DEFAULT_POWERSHELL_TIMEOUT: Duration = Duration::from_millis(5000);
const DEFAULT_MAX_BUFFER_BYTES: usize = 50 * 1024 * 1024;

/// One clipboard image: the base64 payload plus its sniffed mime type
/// (the same attachment type disk-loaded images produce).
pub type ClipboardImage = LoadedImage;

/// Strip parameters from a mime type (`image/png; charset=...`).
fn base_mime_type(mime_type: &str) -> String {
    mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

/// The supported image type among `types`, preferring the
/// `SUPPORTED_IMAGE_MIME_TYPES` order; any other `image/*` type loses to
/// `None` (the converter is unavailable, so it cannot be sent).
fn select_supported_image_mime_type(types: &[String]) -> Option<String> {
    let normalized: Vec<String> = types
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(base_mime_type)
        .collect();
    for preferred in SUPPORTED_IMAGE_MIME_TYPES {
        if let Some(found) = normalized.iter().find(|t| t.as_str() == preferred) {
            return Some(found.clone());
        }
    }
    None
}

/// Run one command with a hard timeout and capture stdout. `None` on
/// spawn failure, nonzero exit, or timeout.
async fn run_command(program: &str, args: &[&str], timeout: Duration) -> Option<Vec<u8>> {
    let child = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) | Err(_) => return None,
    };
    if !output.status.success() {
        return None;
    }
    if output.stdout.len() > DEFAULT_MAX_BUFFER_BYTES {
        return None;
    }
    Some(output.stdout)
}

/// Whether this is a WSL session (TS `isWSL`).
fn is_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSLENV").is_some() {
        return true;
    }
    std::fs::read_to_string("/proc/version")
        .map(|version| {
            version.contains("microsoft")
                || version.contains("Microsoft")
                || version.contains("WSL")
        })
        .unwrap_or(false)
}

/// Whether this is a Wayland session (TS `isWaylandSession`).
fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
}

/// Split a command's textual stdout into trimmed lines.
fn stdout_lines(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// `wl-paste` (Wayland): list the offered types, pick the preferred
/// supported image type, read it without a trailing newline.
async fn read_via_wl_paste() -> Option<ClipboardImage> {
    let types =
        stdout_lines(&run_command("wl-paste", &["--list-types"], DEFAULT_LIST_TIMEOUT).await?);
    let selected = select_supported_image_mime_type(&types)?;
    let bytes = run_command(
        "wl-paste",
        &["--type", &selected, "--no-newline"],
        DEFAULT_READ_TIMEOUT,
    )
    .await?;
    clipboard_image_from_bytes(bytes)
}

/// `xclip` (X11): enumerate `TARGETS`, then read the preferred supported
/// image type (trying each in order when no target matched).
async fn read_via_xclip() -> Option<ClipboardImage> {
    let targets = run_command(
        "xclip",
        &["-selection", "clipboard", "-t", "TARGETS", "-o"],
        DEFAULT_LIST_TIMEOUT,
    )
    .await
    .map(|stdout| stdout_lines(&stdout))
    .unwrap_or_default();
    let mut candidates: Vec<String> = Vec::new();
    if let Some(preferred) = select_supported_image_mime_type(&targets) {
        candidates.push(preferred);
    }
    candidates.extend(SUPPORTED_IMAGE_MIME_TYPES.iter().map(|t| t.to_string()));
    for mime_type in candidates {
        let bytes = run_command(
            "xclip",
            &["-selection", "clipboard", "-t", &mime_type, "-o"],
            DEFAULT_READ_TIMEOUT,
        )
        .await
        .filter(|bytes| !bytes.is_empty());
        if let Some(image) = bytes.and_then(clipboard_image_from_bytes) {
            return Some(image);
        }
    }
    None
}

/// Validate clipboard bytes against the supported formats by content (the
/// clipboard-reported type may be missing or wrong, and there is no image
/// converter to fall back on - the TS product converts unsupported types
/// to PNG through Photon and drops the image when it is unavailable;
/// content sniffing is this port's equivalent check). Returns the payload
/// with the sniffed mime type, or `None` when the bytes are not a
/// supported image.
fn clipboard_image_from_bytes(bytes: Vec<u8>) -> Option<ClipboardImage> {
    use base64::Engine;
    if bytes.is_empty() {
        return None;
    }
    let mime_type = crate::image_load::detect_supported_image_mime_from_bytes(&bytes)?;
    Some(ClipboardImage {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: mime_type.to_string(),
    })
}

/// WSL (TS `readClipboardImageViaPowerShell`): PowerShell reads the
/// Windows clipboard and saves it as a PNG next to a temp path, which
/// WSL reads back and removes.
async fn read_via_powershell() -> Option<ClipboardImage> {
    let temp_dir = std::env::temp_dir();
    std::fs::create_dir_all(&temp_dir).ok()?;
    let temp_path = temp_dir.join(format!("prime-agent-clip-{}.png", unique_suffix()));
    let windows_path = String::from_utf8_lossy(
        &run_command(
            "wslpath",
            &["-w", temp_path.to_str()?],
            DEFAULT_LIST_TIMEOUT,
        )
        .await?,
    )
    .trim()
    .to_string();
    if windows_path.is_empty() {
        return None;
    }
    let escaped_path = windows_path.replace('\'', "''");
    let script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        format!("$path = '{escaped_path}'").as_str(),
        "$img = [System.Windows.Forms.Clipboard]::GetImage()",
        "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
    ]
    .join("; ");
    let output = run_command(
        "powershell.exe",
        &["-NoProfile", "-Command", &script],
        DEFAULT_POWERSHELL_TIMEOUT,
    )
    .await?;
    if String::from_utf8_lossy(&output).trim() != "ok" {
        return None;
    }
    let image = crate::image_load::load_image_from_path(&temp_path)
        .ok()
        .flatten();
    let _ = std::fs::remove_file(&temp_path);
    image
}

/// A unique temp-file suffix: the per-process random hasher seeded by the
/// OS plus the current nanosecond clock.
fn unique_suffix() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0),
    );
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

/// macOS (the TS native clipboard module's role): a
/// JavaScript-for-Automation script reads the pasteboard's PNG data and
/// writes it to a temp file, which we read back and remove. PNG is the
/// screenshot format; non-PNG pasteboard image flavors are not read.
async fn read_via_osascript() -> Option<ClipboardImage> {
    let temp_dir = std::env::temp_dir();
    std::fs::create_dir_all(&temp_dir).ok()?;
    let temp_path = temp_dir.join(format!("prime-agent-clip-{}.png", unique_suffix()));
    let path_str = temp_path.to_str()?.to_string();
    let script = format!(
        r#"ObjC.import('Cocoa');
const pb = $.NSPasteboard.generalPasteboard;
const types = pb.types.allObjects;
if (!types.containsObject($.NSPasteboardTypePNG)) {{
    'empty'
}} else {{
    const data = pb.dataForType($.NSPasteboardTypePNG);
    const text = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding);
    text.writeToFileAtomicallyEncodingError('{path_str}', false, $.NSISOLatin1StringEncoding, null);
    'ok'
}}"#
    );
    let output = run_command(
        "osascript",
        &["-l", "JavaScript", "-e", &script],
        DEFAULT_READ_TIMEOUT,
    )
    .await?;
    if String::from_utf8_lossy(&output).trim() != "ok" {
        return None;
    }
    let image = crate::image_load::load_image_from_path(&temp_path)
        .ok()
        .flatten();
    let _ = std::fs::remove_file(&temp_path);
    image
}

/// Read an image from the system clipboard, if one of the supported types
/// is present. Termux exposes no clipboard image path (TS guard). The
/// reader order matches the TS `readClipboardImage`: Wayland sessions
/// try `wl-paste` then `xclip`; WSL additionally falls through to
/// PowerShell (which sees the Windows clipboard directly); X11 sessions
/// use `xclip`; macOS reads the pasteboard through osascript. The TS
/// native-module readers that need a bundled binary are replaced by the
/// command-line equivalents.
pub async fn read_clipboard_image() -> Option<ClipboardImage> {
    // Verification seam (the `script_path` pattern — the product never sets
    // it): a harness without a display server cannot drive the real
    // clipboard readers, so a fixture file stands in for the clipboard.
    // Only `read_clipboard_image` honors it; the image travels the exact
    // paste path (marker insertion, registry, wire attach) from there.
    if let Some(path) = std::env::var_os("PRIME_AGENT_TEST_CLIPBOARD_IMAGE") {
        return std::fs::read(path)
            .ok()
            .and_then(clipboard_image_from_bytes);
    }
    if std::env::var_os("TERMUX_VERSION").is_some() {
        return None;
    }
    match std::env::consts::OS {
        "linux" => {
            let wsl = is_wsl();
            let wayland = is_wayland_session();
            let mut image = None;
            if wayland || wsl {
                image = read_via_wl_paste().await;
                if image.is_none() {
                    image = read_via_xclip().await;
                }
            }
            if image.is_none() && wsl {
                image = read_via_powershell().await;
            }
            if image.is_none() && !wayland {
                image = read_via_xclip().await;
            }
            image
        }
        "macos" => read_via_osascript().await,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_mime_strips_parameters() {
        assert_eq!(base_mime_type(" image/PNG; charset=utf8 "), "image/png");
    }

    #[test]
    fn supported_type_selection_prefers_png_over_other_images() {
        let types = vec!["text/plain".to_string(), "image/webp".to_string()];
        assert_eq!(
            select_supported_image_mime_type(&types),
            Some("image/webp".to_string())
        );
        let mixed = vec![
            "image/webp".to_string(),
            "image/png".to_string(),
            "image/jpeg".to_string(),
        ];
        assert_eq!(
            select_supported_image_mime_type(&mixed),
            Some("image/png".to_string())
        );
        // An unsupported image type is never selected: it cannot be sent
        // without the converter.
        assert_eq!(
            select_supported_image_mime_type(&["image/bmp".to_string()]),
            None
        );
        assert_eq!(
            select_supported_image_mime_type(&["text/plain".to_string()]),
            None
        );
        assert_eq!(select_supported_image_mime_type(&[]), None);
    }

    #[test]
    fn stdout_lines_trim_and_drop_empty() {
        let stdout = b"image/png\r\ntext/plain\n\n\r\n";
        assert_eq!(stdout_lines(stdout), vec!["image/png", "text/plain"]);
    }

    #[test]
    fn unique_suffix_is_unique() {
        let a = unique_suffix();
        let b = unique_suffix();
        assert_ne!(a, b);
    }
}
