//! The image component: renders one attached image into chat rows.
//!
//! The placement contract is the TS TUI package's `components/image.ts`:
//! graphics-capable terminals get a protocol placement that reserves
//! `rows` empty lines and embeds the escape sequence on the last row
//! (with cursor bookkeeping so the TUI's cursor accounting stays inside
//! the scroll area); every other case renders the textual fallback row.
//! While the fullscreen frame is being composed, images always render
//! their fallback: the fullscreen renderer repaints the whole frame, so
//! an image placement sequence would be re-emitted every frame
//! (`withFullscreenImageFallback` in the TS renderer).

use std::cell::Cell;

use crate::terminal_image::{
    self, ImageDimensions, ImageProtocol, ImageRenderOptions, RenderedImage,
};
use crate::{Line, Span};
use ratatui::style::Style;

thread_local! {
    /// The fullscreen compose guard (TS module-level `fullscreenFallback`).
    static FULLSCREEN_FALLBACK: Cell<bool> = const { Cell::new(false) };
}

/// Run `render` with image graphics disabled (TS `withFullscreenImageFallback`):
/// the fullscreen frame composition forces every image to its textual
/// fallback. The previous state is restored even when `render` panics.
pub fn with_fullscreen_image_fallback<T>(render: impl FnOnce() -> T) -> T {
    FULLSCREEN_FALLBACK.with(|flag| {
        let previous = flag.get();
        flag.set(true);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(render));
        flag.set(previous);
        match result {
            Ok(value) => value,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    })
}

/// Whether image graphics are currently suppressed by the fullscreen
/// compose guard.
pub fn fullscreen_image_fallback_active() -> bool {
    FULLSCREEN_FALLBACK.with(Cell::get)
}

/// Options for [`ImageComponent`] (TS `ImageOptions`).
#[derive(Debug, Clone, Default)]
pub struct ImageOptions {
    pub max_width_cells: Option<usize>,
    pub filename: Option<String>,
    /// Render the textual metadata row instead of terminal graphics.
    pub fallback_only: bool,
    /// Prefix prepended to the fallback metadata row.
    pub fallback_prefix: Option<String>,
    /// Kitty image ID to reuse across re-renders.
    pub image_id: Option<u32>,
}

/// The default placement width cap (TS `maxWidthCells ?? 60`).
const DEFAULT_MAX_WIDTH_CELLS: usize = 60;
/// Default dimensions when the payload cannot be parsed (TS constructor
/// fallback `{ widthPx: 800, heightPx: 600 }`).
const DEFAULT_DIMENSIONS: ImageDimensions = ImageDimensions {
    width_px: 800,
    height_px: 600,
};

/// One rendered image: base64 payload + mime type + options. Caches its
/// rows against the render width, the fullscreen-fallback flag, and the
/// cell-dimensions version (TS `Image`).
#[derive(Debug, Clone)]
pub struct ImageComponent {
    base64_data: String,
    mime_type: String,
    dimensions: ImageDimensions,
    fallback_style: Style,
    options: ImageOptions,
    image_id: Option<u32>,
    cache: Option<CacheEntry>,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    lines: Vec<Line>,
    width: usize,
    fullscreen_fallback: bool,
    cell_dimensions_version: u32,
}

impl ImageComponent {
    pub fn new(
        base64_data: String,
        mime_type: String,
        fallback_style: Style,
        options: ImageOptions,
        dimensions: Option<ImageDimensions>,
    ) -> Self {
        let dimensions = dimensions
            .or_else(|| terminal_image::get_image_dimensions(&base64_data, &mime_type))
            .unwrap_or(DEFAULT_DIMENSIONS);
        Self {
            base64_data,
            mime_type,
            dimensions,
            fallback_style,
            options: options.clone(),
            image_id: options.image_id,
            cache: None,
        }
    }

    /// Render to rows for the given width. The returned rows reserve the
    /// placement height; the escape sequence rides the last row.
    pub fn render(&mut self, width: usize) -> Vec<Line> {
        let cell_dimensions_version = terminal_image::cell_dimensions_version();
        let fullscreen_fallback = fullscreen_image_fallback_active();
        if let Some(cache) = &self.cache {
            if cache.width == width
                && cache.fullscreen_fallback == fullscreen_fallback
                && cache.cell_dimensions_version == cell_dimensions_version
            {
                return cache.lines.clone();
            }
        }

        let max_width = width.saturating_sub(2).min(
            self.options
                .max_width_cells
                .unwrap_or(DEFAULT_MAX_WIDTH_CELLS),
        );

        let caps = terminal_image::capabilities();
        let lines: Vec<Line> = if fullscreen_fallback || self.options.fallback_only {
            self.metadata_row()
        } else if let Some(protocol) = caps.images {
            let image_id = match protocol {
                ImageProtocol::Kitty if self.image_id.is_none() => {
                    self.image_id = Some(terminal_image::allocate_image_id());
                    self.image_id
                }
                _ => self.image_id,
            };
            let rendered: Option<RenderedImage> = terminal_image::render_image(
                &self.base64_data,
                self.dimensions,
                ImageRenderOptions {
                    max_width_cells: Some(max_width),
                    image_id,
                    move_cursor: Some(false),
                    ..Default::default()
                },
            );
            match rendered {
                Some(rendered) => {
                    if let Some(image_id) = rendered.image_id {
                        self.image_id = Some(image_id);
                    }
                    placement_rows(&rendered, protocol)
                }
                None => self.fallback_row(),
            }
        } else {
            self.fallback_row()
        };

        self.cache = Some(CacheEntry {
            lines: lines.clone(),
            width,
            fullscreen_fallback,
            cell_dimensions_version,
        });
        lines
    }

    /// The fallbackOnly metadata row (TS the `fallbackOnly` branch):
    /// `prefix? [filename? · mime · WxH]`, styled by the fallback color.
    fn metadata_row(&self) -> Vec<Line> {
        let mut parts: Vec<String> = vec![self.mime_type.clone()];
        parts.push(format!(
            "{}\u{d7}{}",
            self.dimensions.width_px, self.dimensions.height_px
        ));
        let prefix = self.options.fallback_prefix.clone().unwrap_or_default();
        let filename = self.options.filename.as_deref();
        let mut row = String::new();
        row.push_str(&prefix);
        row.push('[');
        if let Some(filename) = filename {
            row.push_str(filename);
            row.push_str(" \u{b7} ");
        }
        row.push_str(&parts.join(" \u{b7} "));
        row.push(']');
        vec![vec![Span::styled(row, self.fallback_style)]]
    }

    /// The no-capability fallback row (TS `imageFallback`): `[Image: ...]`.
    fn fallback_row(&self) -> Vec<Line> {
        let prefix = self.options.fallback_prefix.clone().unwrap_or_default();
        let text = terminal_image::image_fallback(
            &self.mime_type,
            Some(self.dimensions),
            self.options.filename.as_deref(),
        );
        vec![vec![Span::styled(
            format!("{prefix}{text}"),
            self.fallback_style,
        )]]
    }
}

/// The protocol placement rows (TS the `caps.images` branch): `rows - 1`
/// empty lines reserve the placement height, then the last row moves the
/// cursor back up, draws the image, and (for Kitty, whose default cursor
/// movement is disabled with `C=1`) back down, so the TUI's cursor
/// accounting stays inside the scroll area.
fn placement_rows(rendered: &RenderedImage, protocol: ImageProtocol) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::with_capacity(rendered.rows);
    for _ in 0..rendered.rows.saturating_sub(1) {
        lines.push(Vec::new());
    }
    let row_offset = rendered.rows.saturating_sub(1);
    let move_up = if row_offset > 0 {
        format!("\x1b[{row_offset}A")
    } else {
        String::new()
    };
    let move_down = if protocol == ImageProtocol::Kitty && row_offset > 0 {
        format!("\x1b[{row_offset}B")
    } else {
        String::new()
    };
    lines.push(vec![Span::raw(format!(
        "{move_up}{}{move_down}",
        rendered.sequence
    ))]);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_image::{set_capabilities, CellDimensions, TerminalCapabilities};

    fn kitty_caps() {
        set_capabilities(TerminalCapabilities {
            images: Some(ImageProtocol::Kitty),
            true_color: true,
            hyperlinks: true,
        });
    }

    fn no_caps() {
        set_capabilities(TerminalCapabilities {
            images: None,
            true_color: false,
            hyperlinks: false,
        });
    }

    fn reset() {
        crate::terminal_image::reset_capabilities_cache();
    }

    fn styled_text(line: &Line) -> String {
        line.iter().map(|span| span.content.as_str()).collect()
    }

    /// A 2x2 red PNG: dimensions parse from the payload.
    fn tiny_png() -> String {
        use base64::Engine;
        let mut bytes = vec![0x89, b'P', b'N', b'G'];
        bytes.extend(vec![0u8; 12]);
        bytes.extend(2u32.to_be_bytes());
        bytes.extend(1u32.to_be_bytes());
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn fallback_only_renders_the_metadata_row() {
        let mut image = ImageComponent::new(
            "QQ==".into(),
            "image/png".into(),
            Style::new(),
            ImageOptions {
                fallback_only: true,
                fallback_prefix: Some("    \u{2570}\u{2500} ".into()),
                ..Default::default()
            },
            Some(ImageDimensions {
                width_px: 800,
                height_px: 600,
            }),
        );
        let rows = image.render(80);
        assert_eq!(
            styled_text(&rows[0]),
            "    \u{2570}\u{2500} [image/png \u{b7} 800\u{d7}600]"
        );
    }

    #[test]
    fn metadata_row_includes_filename_first() {
        let mut image = ImageComponent::new(
            "QQ==".into(),
            "image/png".into(),
            Style::new(),
            ImageOptions {
                fallback_only: true,
                filename: Some("shot.png".into()),
                ..Default::default()
            },
            Some(ImageDimensions {
                width_px: 8,
                height_px: 6,
            }),
        );
        let rows = image.render(80);
        assert_eq!(
            styled_text(&rows[0]),
            "[shot.png \u{b7} image/png \u{b7} 8\u{d7}6]"
        );
    }

    #[test]
    fn unparseable_payload_falls_back_to_default_dimensions() {
        let image = ImageComponent::new(
            "QQ==".into(),
            "image/png".into(),
            Style::new(),
            ImageOptions::default(),
            None,
        );
        assert_eq!(image.dimensions, DEFAULT_DIMENSIONS);
    }

    #[test]
    fn no_capabilities_renders_the_image_fallback_text() {
        let _state = crate::terminal_image::test_state_lock();
        no_caps();
        let mut image = ImageComponent::new(
            tiny_png(),
            "image/png".into(),
            Style::new(),
            ImageOptions {
                filename: Some("shot.png".into()),
                ..Default::default()
            },
            None,
        );
        let rows = image.render(80);
        assert_eq!(styled_text(&rows[0]), "[Image: shot.png [image/png] 2x1]");
        reset();
    }

    #[test]
    fn kitty_placement_reserves_rows_and_reuses_the_image_id() {
        let _state = crate::terminal_image::test_state_lock();
        kitty_caps();
        set_cell_dimensions_default();
        let mut image = ImageComponent::new(
            tiny_png(),
            "image/png".into(),
            Style::new(),
            ImageOptions {
                max_width_cells: Some(20),
                ..Default::default()
            },
            None,
        );
        let rows = image.render(80);
        // 2x1 image at 20 cells wide: 180px wide, height scaled to 90px,
        // ceil(90/18) = 5 rows.
        assert_eq!(rows.len(), 5);
        assert!(rows[..4].iter().all(Vec::is_empty));
        let text = styled_text(rows.last().unwrap());
        assert!(text.starts_with("\x1b[4A"));
        assert!(text.contains("\x1b_Ga=T,f=100,q=2,C=1,c=20,r=5,i="));
        assert!(text.ends_with("\x1b[4B"));
        // The cache hit re-renders identical rows and reuses the ID.
        let first_id = image.image_id;
        let rows2 = image.render(80);
        assert_eq!(rows, rows2, "cache hit");
        assert_eq!(image.image_id, first_id);
        assert!(styled_text(rows2.last().unwrap()).contains("i="));
        reset();
        restore_cell_dimensions_default();
    }

    #[test]
    fn kitty_multi_row_placement_moves_the_cursor_back_down() {
        let _state = crate::terminal_image::test_state_lock();
        kitty_caps();
        set_cell_dimensions_default();
        let mut image = ImageComponent::new(
            tiny_png(),
            "image/png".into(),
            Style::new(),
            ImageOptions {
                max_width_cells: Some(80),
                ..Default::default()
            },
            None,
        );
        // Force tall dimensions so the placement spans several rows.
        image.dimensions = ImageDimensions {
            width_px: 9,
            height_px: 90,
        };
        let rows = image.render(80);
        // 80 cells wide at 9px = 720px; scale = 80; height = 7200px = 400 rows.
        assert!(rows.len() > 2);
        assert!(rows[..rows.len() - 1].iter().all(Vec::is_empty));
        let last = styled_text(rows.last().unwrap());
        let offset = rows.len() - 1;
        assert!(last.starts_with(&format!("\x1b[{offset}A")));
        assert!(last.ends_with(&format!("\x1b[{offset}B")));
        reset();
        restore_cell_dimensions_default();
    }

    #[test]
    fn fullscreen_guard_forces_fallback_during_compose() {
        let _state = crate::terminal_image::test_state_lock();
        kitty_caps();
        let mut image = ImageComponent::new(
            tiny_png(),
            "image/png".into(),
            Style::new(),
            ImageOptions::default(),
            None,
        );
        let rows = with_fullscreen_image_fallback(|| image.render(80));
        assert!(!styled_text(&rows[0]).contains("\x1b_G"));
        // The compose guard renders the same metadata row as fallbackOnly
        // (TS Image.render's shared branch).
        assert_eq!(styled_text(&rows[0]), "[image/png \u{b7} 2\u{d7}1]");
        // The cache keys the guard flag, so the graphics render resumes
        // after the compose finishes.
        let rows = image.render(80);
        assert!(styled_text(rows.last().unwrap()).contains("\x1b_G"));
        reset();
    }

    fn set_cell_dimensions_default() {
        crate::terminal_image::set_cell_dimensions(CellDimensions {
            width_px: 9,
            height_px: 18,
        });
    }

    fn restore_cell_dimensions_default() {
        set_cell_dimensions_default();
    }
}
