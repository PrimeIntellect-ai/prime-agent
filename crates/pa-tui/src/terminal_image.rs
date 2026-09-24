//! Terminal image support: capability detection, the Kitty graphics and
//! iTerm2 inline-image protocol encoders, pixel-dimension parsing for the
//! supported formats, and the textual fallback row.
//!
//! The behavior contract is the TS TUI package's `terminal-image.ts`:
//! image protocols are enabled only on terminals positively identified
//! as supporting them (kitty, Ghostty, WezTerm -> Kitty protocol;
//! iTerm2 -> inline images). tmux and screen swallow the graphics
//! sequences, so they - and every unrecognized terminal - report no
//! image support and every image renders the textual fallback.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

/// Which terminal graphics protocol is available (TS `ImageProtocol`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageProtocol {
    /// Kitty graphics protocol (`ESC _ G`).
    Kitty,
    /// iTerm2 inline images (`ESC ] 1337;File=`).
    Iterm2,
}

/// Terminal rendering capabilities (TS `TerminalCapabilities`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalCapabilities {
    /// The supported image protocol, or `None` when images must fall back
    /// to text.
    pub images: Option<ImageProtocol>,
    pub true_color: bool,
    pub hyperlinks: bool,
}

/// Cell dimensions in pixels; updated when the terminal answers the
/// cell-size query (default matches the TS default, 9x18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

impl Default for CellDimensions {
    fn default() -> Self {
        Self {
            width_px: 9,
            height_px: 18,
        }
    }
}

/// Image pixel dimensions (TS `ImageDimensions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageDimensions {
    pub width_px: u32,
    pub height_px: u32,
}

/// Options for [`render_image`] (TS `ImageRenderOptions`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ImageRenderOptions {
    pub max_width_cells: Option<usize>,
    pub preserve_aspect_ratio: Option<bool>,
    /// Kitty image ID; when set, the terminal replaces the existing image
    /// with this ID instead of placing a new one.
    pub image_id: Option<u32>,
    /// Whether Kitty applies its default cursor movement after placement.
    pub move_cursor: Option<bool>,
}

/// One rendered image (TS the `renderImage` result object).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedImage {
    /// The protocol escape sequence.
    pub sequence: String,
    /// Rows the placed image occupies (the TUI reserves this height).
    pub rows: usize,
    pub image_id: Option<u32>,
}

fn capabilities_cache() -> &'static Mutex<Option<TerminalCapabilities>> {
    static CACHE: OnceLock<Mutex<Option<TerminalCapabilities>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn cell_dimensions_state() -> &'static Mutex<CellDimensions> {
    static CELL: OnceLock<Mutex<CellDimensions>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(CellDimensions::default()))
}

fn cell_dimensions_version_cell() -> &'static AtomicU32 {
    static VERSION: OnceLock<AtomicU32> = OnceLock::new();
    VERSION.get_or_init(|| AtomicU32::new(0))
}

/// Detect terminal capabilities from the environment (TS
/// `detectCapabilities`). The lookup is injected so tests can exercise
/// every branch without mutating process environment.
pub fn detect_capabilities_with(env: &dyn Fn(&str) -> Option<String>) -> TerminalCapabilities {
    let term_program = env("TERM_PROGRAM")
        .map(|v| v.to_lowercase())
        .unwrap_or_default();
    let term = env("TERM").map(|v| v.to_lowercase()).unwrap_or_default();
    let color_term = env("COLORTERM")
        .map(|v| v.to_lowercase())
        .unwrap_or_default();

    // tmux and screen swallow the image sequences (passthrough is opt-in
    // and wraps them differently), so images stay off under them even when
    // the outer terminal would support the protocol.
    let in_tmux_or_screen =
        env("TMUX").is_some() || term.starts_with("tmux") || term.starts_with("screen");
    if in_tmux_or_screen {
        let true_color = color_term == "truecolor" || color_term == "24bit";
        return TerminalCapabilities {
            images: None,
            true_color,
            hyperlinks: false,
        };
    }

    if env("KITTY_WINDOW_ID").is_some() || term_program == "kitty" {
        return TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        };
    }

    if term_program == "ghostty"
        || term.contains("ghostty")
        || env("GHOSTTY_RESOURCES_DIR").is_some()
    {
        return TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        };
    }

    if env("WEZTERM_PANE").is_some() || term_program == "wezterm" {
        return TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        };
    }

    if env("ITERM_SESSION_ID").is_some() || term_program == "iterm.app" {
        return TerminalCapabilities {
            images: Some(ImageProtocol::Iterm2),
            true_color: true,
            hyperlinks: true,
        };
    }

    if term_program == "vscode" {
        return TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: true,
        };
    }

    if term_program == "alacritty" {
        return TerminalCapabilities {
            images: None,
            true_color: true,
            hyperlinks: true,
        };
    }

    // Unknown terminal: stay conservative (TS default branch).
    let true_color = color_term == "truecolor" || color_term == "24bit";
    TerminalCapabilities {
        images: None,
        true_color,
        hyperlinks: false,
    }
}

/// Detect capabilities from the process environment.
pub fn detect_capabilities() -> TerminalCapabilities {
    detect_capabilities_with(&|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
}

/// Cached capabilities (TS `getCapabilities`): detected once per process.
pub fn capabilities() -> TerminalCapabilities {
    let mut cache = lock(capabilities_cache());
    if let Some(caps) = *cache {
        return caps;
    }
    let caps = detect_capabilities();
    *cache = Some(caps);
    caps
}

/// Drop the cached capabilities so the next read re-detects. Test seam:
/// the product process never invalidates the detected capabilities.
#[cfg(test)]
pub fn reset_capabilities_cache() {
    *lock(capabilities_cache()) = None;
}

/// Test-only mutex serializing every test that touches the process-global
/// capability and cell-dimension state: the cargo test harness runs tests
/// on parallel threads, and one test's `set_capabilities`/`reset` would
/// otherwise race another's (the failures move run to run, which is what
/// exposes the race). Tests hold this lock for their whole body.
#[cfg(test)]
pub fn test_state_lock() -> std::sync::MutexGuard<'static, ()> {
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Override the cached capabilities (tests exercise both image paths).
#[cfg(test)]
pub fn set_capabilities(caps: TerminalCapabilities) {
    *lock(capabilities_cache()) = Some(caps);
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The current cell dimensions (TS `getCellDimensions`).
pub fn cell_dimensions() -> CellDimensions {
    *lock(cell_dimensions_state())
}

/// Update the cell dimensions; a real change bumps the version image
/// components use as a render-cache key (TS `setCellDimensions`, fed by
/// the terminal's cell-size query response). Test seam until the TUI
/// issues that query.
#[cfg(test)]
pub fn set_cell_dimensions(dims: CellDimensions) {
    let mut cell = lock(cell_dimensions_state());
    if dims.width_px != cell.width_px || dims.height_px != cell.height_px {
        *cell = dims;
        cell_dimensions_version_cell().fetch_add(1, Ordering::SeqCst);
    }
}

/// The cell-dimensions version (TS `getCellDimensionsVersion`).
pub fn cell_dimensions_version() -> u32 {
    cell_dimensions_version_cell().load(Ordering::SeqCst)
}

const KITTY_PREFIX: &str = "\x1b_G";
const ITERM2_PREFIX: &str = "\x1b]1337;File=";

/// Whether a rendered row carries an image placement sequence (TS
/// `isImageLine`; multi-row images carry a cursor-up prefix first).
pub fn is_image_line(line: &str) -> bool {
    line.contains(KITTY_PREFIX) || line.contains(ITERM2_PREFIX)
}

/// Allocate a random Kitty image ID in `[1, u32::MAX]` (TS
/// `allocateImageId`): random IDs avoid collisions between components.
/// The ID is drawn from the per-process random hasher seeded by the OS,
/// which needs no extra dependency.
pub fn allocate_image_id() -> u32 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let tick = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(tick);
    hasher.write_u32(std::process::id());
    (hasher.finish() % 0xFFFF_FFFE) as u32 + 1
}

/// Options for [`encode_kitty`] (TS `encodeKitty`'s options object).
#[derive(Debug, Clone, Copy, Default)]
pub struct KittyEncodeOptions {
    pub columns: Option<usize>,
    pub rows: Option<usize>,
    pub image_id: Option<u32>,
    /// Whether Kitty applies its default cursor movement after placement
    /// (the TUI disables it and moves the cursor itself). Default: enabled.
    pub move_cursor: Option<bool>,
}

/// Encode a Kitty graphics placement for base64 payload (TS `encodeKitty`).
/// Large payloads split into 4096-char chunks with `m=1`/`m=0` continuation
/// markers.
pub fn encode_kitty(base64_data: &str, options: KittyEncodeOptions) -> String {
    const CHUNK_SIZE: usize = 4096;

    let mut params: Vec<String> = vec!["a=T".into(), "f=100".into(), "q=2".into()];
    if options.move_cursor == Some(false) {
        params.push("C=1".into());
    }
    if let Some(columns) = options.columns {
        params.push(format!("c={columns}"));
    }
    if let Some(rows) = options.rows {
        params.push(format!("r={rows}"));
    }
    if let Some(image_id) = options.image_id {
        params.push(format!("i={image_id}"));
    }

    if base64_data.len() <= CHUNK_SIZE {
        return format!("\x1b_G{};{base64_data}\x1b\\", params.join(","));
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut offset = 0usize;
    let mut is_first = true;
    while offset < base64_data.len() {
        let end = (offset + CHUNK_SIZE).min(base64_data.len());
        let chunk = &base64_data[offset..end];
        let is_last = end == base64_data.len();
        if is_first {
            chunks.push(format!("\x1b_G{},m=1;{chunk}\x1b\\", params.join(",")));
            is_first = false;
        } else if is_last {
            chunks.push(format!("\x1b_Gm=0;{chunk}\x1b\\"));
        } else {
            chunks.push(format!("\x1b_Gm=1;{chunk}\x1b\\"));
        }
        offset = end;
    }
    chunks.join("")
}

/// Options for [`encode_iterm2`] (TS `encodeITerm2`'s options object).
#[derive(Debug, Clone, Default)]
pub struct Iterm2EncodeOptions<'a> {
    pub width: Option<String>,
    pub height: Option<String>,
    pub name: Option<&'a str>,
    pub preserve_aspect_ratio: Option<bool>,
    pub inline: Option<bool>,
}

/// Encode an iTerm2 inline image placement (TS `encodeITerm2`).
pub fn encode_iterm2(base64_data: &str, options: Iterm2EncodeOptions) -> String {
    use base64::Engine;
    let mut params: Vec<String> = vec![format!(
        "inline={}",
        if options.inline == Some(false) { 0 } else { 1 }
    )];
    if let Some(width) = &options.width {
        params.push(format!("width={width}"));
    }
    if let Some(height) = &options.height {
        params.push(format!("height={height}"));
    }
    if let Some(name) = options.name {
        let name_base64 = base64::engine::general_purpose::STANDARD.encode(name);
        params.push(format!("name={name_base64}"));
    }
    if options.preserve_aspect_ratio == Some(false) {
        params.push("preserveAspectRatio=0".into());
    }
    format!("\x1b]1337;File={}:{}\x07", params.join(";"), base64_data)
}

/// Rows a width-fitted image occupies (TS `calculateImageRows`): the image
/// scales to `target_width_cells` columns, and the scaled pixel height
/// rounds up to cell rows (at least one).
pub fn calculate_image_rows(
    image_dimensions: ImageDimensions,
    target_width_cells: usize,
    cell: CellDimensions,
) -> usize {
    let target_width_px = target_width_cells as f64 * cell.width_px as f64;
    let scale = target_width_px / image_dimensions.width_px as f64;
    let scaled_height_px = image_dimensions.height_px as f64 * scale;
    let rows = (scaled_height_px / cell.height_px as f64).ceil();
    rows.max(1.0) as usize
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
                width_px: width as u32,
                height_px: height as u32,
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
        width_px: width as u32,
        height_px: height as u32,
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
            width_px: width as u32,
            height_px: height as u32,
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
        let width = (bytes[24] as u32 | (bytes[25] as u32) << 8 | (bytes[26] as u32) << 16) + 1;
        let height = (bytes[27] as u32 | (bytes[28] as u32) << 8 | (bytes[29] as u32) << 16) + 1;
        Some(ImageDimensions {
            width_px: width,
            height_px: height,
        })
    } else {
        None
    }
}

/// Decode base64 image data and read its pixel dimensions (TS
/// `getImageDimensions`): `None` for unsupported mime types and undecodable
/// payloads. Animated formats report the first frame's dimensions.
pub fn get_image_dimensions(base64_data: &str, mime_type: &str) -> Option<ImageDimensions> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .ok()?;
    match mime_type {
        "image/png" => png_dimensions(&bytes),
        "image/jpeg" => jpeg_dimensions(&bytes),
        "image/gif" => gif_dimensions(&bytes),
        "image/webp" => webp_dimensions(&bytes),
        _ => None,
    }
}

/// Render an image through the detected protocol (TS `renderImage`):
/// `None` when the terminal has no image support. The placement is sized
/// to `max_width_cells` (default 80) and occupies the returned row count.
pub fn render_image(
    base64_data: &str,
    image_dimensions: ImageDimensions,
    options: ImageRenderOptions,
) -> Option<RenderedImage> {
    let caps = capabilities();
    let protocol = caps.images?;

    let max_width = options.max_width_cells.unwrap_or(80);
    let rows = calculate_image_rows(image_dimensions, max_width, cell_dimensions());

    match protocol {
        ImageProtocol::Kitty => {
            let sequence = encode_kitty(
                base64_data,
                KittyEncodeOptions {
                    columns: Some(max_width),
                    rows: Some(rows),
                    image_id: options.image_id,
                    move_cursor: options.move_cursor,
                },
            );
            Some(RenderedImage {
                sequence,
                rows,
                image_id: options.image_id,
            })
        }
        ImageProtocol::Iterm2 => {
            let sequence = encode_iterm2(
                base64_data,
                Iterm2EncodeOptions {
                    width: Some(max_width.to_string()),
                    height: Some("auto".into()),
                    name: None,
                    preserve_aspect_ratio: Some(options.preserve_aspect_ratio.unwrap_or(true)),
                    inline: None,
                },
            );
            Some(RenderedImage {
                sequence,
                rows,
                image_id: None,
            })
        }
    }
}

/// The textual fallback for an image that cannot be displayed (TS
/// `imageFallback`): `[Image: filename? [mime] WxH?]`.
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
    use std::collections::HashMap;

    fn env_of<'a>(map: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + use<'a> {
        let map: HashMap<String, String> = map
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn tmux_and_screen_disable_images_and_hyperlinks() {
        for term in ["tmux-256color", "screen"] {
            let caps =
                detect_capabilities_with(&env_of(&[("TERM", term), ("COLORTERM", "truecolor")]));
            assert_eq!(caps.images, None, "{term}");
            assert!(caps.true_color, "{term}");
            assert!(!caps.hyperlinks, "{term}");
        }
        let caps = detect_capabilities_with(&env_of(&[("TMUX", "/tmp/x,0,0")]));
        assert_eq!(caps.images, None);
        assert!(!caps.hyperlinks);
    }

    #[test]
    fn known_terminals_map_to_their_protocols() {
        let kitty = detect_capabilities_with(&env_of(&[("KITTY_WINDOW_ID", "1")]));
        assert_eq!(kitty.images, Some(ImageProtocol::Kitty));
        let ghostty = detect_capabilities_with(&env_of(&[("GHOSTTY_RESOURCES_DIR", "/x")]));
        assert_eq!(ghostty.images, Some(ImageProtocol::Kitty));
        let wezterm = detect_capabilities_with(&env_of(&[("WEZTERM_PANE", "1")]));
        assert_eq!(wezterm.images, Some(ImageProtocol::Kitty));
        let iterm = detect_capabilities_with(&env_of(&[("ITERM_SESSION_ID", "w0")]));
        assert_eq!(iterm.images, Some(ImageProtocol::Iterm2));
        let vscode = detect_capabilities_with(&env_of(&[("TERM_PROGRAM", "vscode")]));
        assert_eq!(vscode.images, None);
        assert!(vscode.hyperlinks);
    }

    #[test]
    fn unknown_terminal_is_conservative() {
        let caps = detect_capabilities_with(&env_of(&[("TERM", "xterm-256color")]));
        assert_eq!(
            caps,
            TerminalCapabilities {
                images: None,
                true_color: false,
                hyperlinks: false
            }
        );
        let caps = detect_capabilities_with(&env_of(&[
            ("TERM", "xterm-256color"),
            ("COLORTERM", "24bit"),
        ]));
        assert!(caps.true_color);
    }

    #[test]
    fn capabilities_cache_is_overrideable_and_resettable() {
        let _state = test_state_lock();
        let original = capabilities();
        set_capabilities(TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        });
        assert_eq!(capabilities().images, Some(ImageProtocol::Kitty));
        reset_capabilities_cache();
        set_capabilities(original);
    }

    #[test]
    fn cell_dimensions_bump_the_version_on_change_only() {
        let _state = test_state_lock();
        set_cell_dimensions(CellDimensions {
            width_px: 9,
            height_px: 18,
        });
        let before = cell_dimensions_version();
        set_cell_dimensions(CellDimensions {
            width_px: 9,
            height_px: 18,
        });
        assert_eq!(cell_dimensions_version(), before);
        set_cell_dimensions(CellDimensions {
            width_px: 10,
            height_px: 20,
        });
        assert_eq!(cell_dimensions_version(), before + 1);
        assert_eq!(
            cell_dimensions(),
            CellDimensions {
                width_px: 10,
                height_px: 20
            }
        );
        set_cell_dimensions(CellDimensions::default());
    }

    #[test]
    fn allocate_image_id_stays_in_range() {
        for _ in 0..100 {
            let id = allocate_image_id();
            assert!(id >= 1);
        }
    }

    #[test]
    fn kitty_encoding_single_chunk_and_params() {
        let sequence = encode_kitty(
            "QUJD",
            KittyEncodeOptions {
                columns: Some(40),
                rows: Some(3),
                image_id: Some(7),
                move_cursor: Some(false),
            },
        );
        assert_eq!(sequence, "\x1b_Ga=T,f=100,q=2,C=1,c=40,r=3,i=7;QUJD\x1b\\");
    }

    #[test]
    fn kitty_encoding_chunks_long_payloads() {
        // 8192 chars: 4096 + 4096 -> first m=1, last m=0 with the full tail.
        let payload = "A".repeat(8192);
        let sequence = encode_kitty(&payload, KittyEncodeOptions::default());
        assert!(sequence.starts_with("\x1b_Ga=T,f=100,q=2,m=1;"));
        let first = sequence.find("\x1b\\").unwrap();
        let rest = &sequence[first + 2..];
        assert!(rest.starts_with("\x1b_Gm=0;"));
        assert!(rest.ends_with(&format!("{}\x1b\\", "A".repeat(4096))));
        assert_eq!(sequence.matches("\x1b_G").count(), 2);
    }

    #[test]
    fn iterm2_encoding_carries_params() {
        let sequence = encode_iterm2(
            "QUJD",
            Iterm2EncodeOptions {
                width: Some("80".into()),
                height: Some("auto".into()),
                name: Some("shot.png"),
                preserve_aspect_ratio: Some(false),
                inline: None,
            },
        );
        let expected_name = base64::engine::general_purpose::STANDARD.encode("shot.png");
        assert_eq!(
            sequence,
            format!(
                "\x1b]1337;File=inline=1;width=80;height=auto;name={expected_name};preserveAspectRatio=0:QUJD\x07"
            )
        );
    }

    #[test]
    fn iterm2_inline_false() {
        let sequence = encode_iterm2(
            "QQ",
            Iterm2EncodeOptions {
                inline: Some(false),
                ..Default::default()
            },
        );
        assert!(sequence.starts_with("\x1b]1337;File=inline=0:"));
    }

    #[test]
    fn image_rows_follow_cell_geometry() {
        let dims = ImageDimensions {
            width_px: 180,
            height_px: 90,
        };
        let cell = CellDimensions {
            width_px: 9,
            height_px: 18,
        };
        // Scaled to 20 cells wide: 180px, height stays 90px = 5 rows.
        assert_eq!(calculate_image_rows(dims, 20, cell), 5);
        // One cell: the scale makes the image smaller than a row; stays 1.
        assert_eq!(calculate_image_rows(dims, 1, cell), 1);
    }

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
            get_image_dimensions(&data, "image/png"),
            Some(ImageDimensions {
                width_px: 64,
                height_px: 32
            })
        );
        assert_eq!(get_image_dimensions(&data, "image/jpeg"), None);
        assert_eq!(get_image_dimensions("!!!", "image/png"), None);
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
                                    // `offset + 9 < len`, so the frame must
                                    // not end right after the width
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert_eq!(
            get_image_dimensions(&data, "image/jpeg"),
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
            get_image_dimensions(&data, "image/gif"),
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
            get_image_dimensions(&data, "image/webp"),
            Some(ImageDimensions {
                width_px: 100,
                height_px: 80
            })
        );
    }

    #[test]
    fn render_image_requires_protocol_support() {
        let _state = test_state_lock();
        let dims = ImageDimensions {
            width_px: 180,
            height_px: 90,
        };
        set_capabilities(TerminalCapabilities {
            images: None,
            true_color: false,
            hyperlinks: false,
        });
        assert!(render_image("QUJD", dims, ImageRenderOptions::default()).is_none());
        reset_capabilities_cache();

        set_capabilities(TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        });
        let rendered = render_image(
            "QUJD",
            dims,
            ImageRenderOptions {
                max_width_cells: Some(20),
                image_id: Some(9),
                move_cursor: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rendered.rows, 5);
        assert!(rendered
            .sequence
            .starts_with("\x1b_Ga=T,f=100,q=2,C=1,c=20,r=5,i=9;"));
        reset_capabilities_cache();

        set_capabilities(TerminalCapabilities {
            images: Some(ImageProtocol::Iterm2),
            true_color: true,
            hyperlinks: true,
        });
        let rendered = render_image(
            "QUJD",
            dims,
            ImageRenderOptions {
                max_width_cells: Some(20),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(rendered
            .sequence
            .starts_with("\x1b]1337;File=inline=1;width=20;height=auto:"));
        reset_capabilities_cache();
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
