//! Tool-call card rendering, the TUI side of the TS `tool-execution.ts` /
//! `tool-panel.ts` / `ipython-cell.ts` / `bash.ts` renderer stack. The card
//! model mirrors the TS component state (args, execution start, partial
//! results, live timing); each tool renders through its own shell
//! (`ipython` self-renders, `bash` and the generic fallback render the
//! `ToolPanel` on the panel background).

pub mod bash;
pub mod generic;
pub mod highlight;
pub mod ipython;
pub mod ipython_details;
mod layout;

use std::time::Instant;

use serde_json::Value;

use crate::chat::Detail;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// One tool call and its execution state (TS `ToolExecutionComponent`
/// state minus the renderer caches).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolCallCard {
    pub id: String,
    pub name: String,
    pub args: Value,
    /// `tool_execution_start` seen (live only; replayed cards infer it from
    /// the result).
    pub started: bool,
    /// When the execution started, when seen live (drives `Took`/`Elapsed`).
    pub started_at: Option<Instant>,
    /// When the final result landed (replay sets start and end together).
    pub ended_at: Option<Instant>,
    /// The result so far; `None` until the first result frame.
    pub result: Option<ToolResultView>,
    /// `result` is a partial streaming frame.
    pub result_partial: bool,
    /// The run's failed final frame (an abort or a provider error) settled
    /// this still-pending card with the run's error text; the tool's late
    /// result frames are dropped (TS `resetPendingToolState` removed the
    /// component from the pending map the same way).
    pub aborted: bool,
}

/// One (partial or final) tool result (TS `AgentToolResult` view).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolResultView {
    pub content: Vec<Value>,
    pub details: Value,
    pub is_error: bool,
}

impl ToolResultView {
    /// The joined text of the result's text blocks, ANSI stripped, with
    /// hidden image blocks appended as `[Image: ...]` fallback text (TS
    /// `render-utils.getTextOutput` with `showImages` false: each image
    /// contributes its mime type and, when the payload parses, its
    /// dimensions).
    pub fn text_output(&self, show_images: bool) -> String {
        let mut parts: Vec<String> = Vec::new();
        for block in &self.content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => parts.push(
                    crate::error_summary::normalize_error_details(
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )
                    .replace('\r', ""),
                ),
                Some("image") if !show_images => parts.push(hidden_image_text(block)),
                _ => {}
            }
        }
        parts.join("\n")
    }
}

/// The `[Image: ...]` text standing in for one hidden image block (TS
/// `imageFallback(mimeType, dims)` with `includeImageDimensions: false` —
/// the interactive transcript's two mount sites pass the knob off, so the
/// hidden text never parses image dimensions; the export renderer is the
/// dims-including consumer). The payload is never decoded: the text is
/// the mime alone, for live payloads and elided markers alike.
fn hidden_image_text(block: &Value) -> String {
    let mime = block
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/unknown");
    crate::terminal_image::image_fallback(mime, None, None)
}

/// The image block's rendered size segment: `140.1KB` — the elided payload's
/// byte count when the transcript load replaced the data, the payload's own
/// length otherwise. Never touches the payload beyond its length.
pub(crate) fn image_block_size_text(block: &Value) -> String {
    format_size(image_block_bytes(block))
}

/// The payload's size in bytes, from the elision marker when present (the
/// transcript load's [`crate::snapshot`] marker shape: `elidedBytes`),
/// from the payload's own character length otherwise.
pub(crate) fn image_block_bytes(block: &Value) -> usize {
    block
        .get("elidedBytes")
        .and_then(Value::as_u64)
        .map_or_else(
            || {
                block
                    .get("data")
                    .and_then(Value::as_str)
                    .map_or(0, str::len)
            },
            |bytes| bytes as usize,
        )
}

/// The animated working icon glyph (TS `working-icon.ts`).
#[must_use]
pub fn working_icon(frame: usize) -> &'static str {
    crate::chat::working_icon_frame(frame)
}

/// Render one tool-call card through its tool shell. `show_images` is the
/// `terminal.showImages` setting (TS `showImages` on the tool component):
/// image blocks render their metadata rows when set, their
/// `[Image: ...]` text placeholders otherwise.
#[must_use]
pub fn render_tool_card(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> Vec<Line> {
    match card.name.as_str() {
        "ipython" => ipython::render(card, frame, detail, theme, width, show_images),
        "bash" => bash::render(card, frame, detail, theme, width, show_images),
        _ => generic::render(card, frame, detail, theme, width, show_images),
    }
}

/// The generic panel status (TS `ToolExecutionComponent.panelStatus`):
/// the last non-partial result settles the card; error wins even while
/// streaming; `running` animates until then.
pub(crate) enum PanelStatus {
    Queued,
    Running,
    Done,
    Error,
}

pub(crate) fn panel_status(card: &ToolCallCard) -> PanelStatus {
    if let Some(result) = &card.result {
        if !card.result_partial {
            return if result.is_error {
                PanelStatus::Error
            } else {
                PanelStatus::Done
            };
        }
        if result.is_error {
            return PanelStatus::Error;
        }
    }
    if card.started {
        PanelStatus::Running
    } else {
        PanelStatus::Queued
    }
}

/// The panel header row: `label · status` (TS `panelHeader`).
pub(crate) fn panel_header(card: &ToolCallCard, frame: usize, theme: &Theme) -> Line {
    use crate::theme::ThemeColor::{BashMode, Dim, Error, Muted, Success};
    let muted = theme.fg_style(Muted);
    let dim = theme.fg_style(Dim);
    let mut header: Line = vec![Span::styled(card.name.clone(), muted)];
    header.push(Span::styled(" \u{00b7} ".to_string(), dim));
    let status: Line = match panel_status(card) {
        PanelStatus::Error => vec![Span::styled("error".to_string(), theme.fg_style(Error))],
        PanelStatus::Done => vec![Span::styled("done".to_string(), theme.fg_style(Success))],
        PanelStatus::Running => vec![Span::styled(
            format!("{} running", working_icon(frame)),
            theme.fg_style(BashMode),
        )],
        PanelStatus::Queued => vec![Span::styled("queued".to_string(), theme.fg_style(Muted))],
    };
    header.extend(status);
    header
}

/// One tool-panel row: content indented by 2, padded to the full width on
/// the panel background (TS `toolPanelLine`).
pub(crate) fn panel_line(content: Line, bg: ratatui::style::Style, width: usize) -> Line {
    let padding = 2usize;
    let content_width = layout::panel_content_width(width);
    let mut line: Line = vec![Span::styled(" ".repeat(padding), bg)];
    let used: usize = content
        .iter()
        .map(|s| crate::width::str_width(&s.content))
        .sum();
    for span in content {
        line.push(Span::styled(span.content, bg.patch(span.style)));
    }
    if used > content_width {
        return crate::width::truncate_line(&line, width, "");
    }
    line.push(Span::styled(" ".repeat(content_width - used), bg));
    line.push(Span::styled(" ".repeat(padding), bg));
    line
}

/// `formatDuration` for the bash panel: tenths of a second.
pub(crate) fn format_bash_duration(ms: u128) -> String {
    format!("{:.1}s", ms as f64 / 1000.0)
}

/// The instant a still-running call started (the live-timer gate,
/// operator feature 2026-10-03): `Some` while the card saw its execution
/// start and the final result never landed — every settle path stamps
/// `ended_at` together with the result — `None` once settled or when the
/// card never saw its start (the TS render-state lifecycle). A running
/// call exists only inside an active turn, and the turn's loader spinner
/// keeps the loop repainting at its 80ms phase cadence (#3296's wake), so
/// a duration rendered from this instant ticks on those repaints without
/// adding a wake of its own.
fn live_started(card: &ToolCallCard) -> Option<Instant> {
    card.started_at.filter(|_| card.ended_at.is_none())
}

/// The `Elapsed`/`Took` duration row the panel shells render below the
/// call's content (the bash card's TS `Took 1.2s` row): while the call
/// runs the label is `Elapsed` and the value is recomputed on every
/// paint — the loader spinner's 80ms phase repaints tick it — and once
/// the final result lands the row is the exact static `Took` timing the
/// settled card always rendered. A card that never saw its execution
/// start renders no row.
fn duration_row(
    card: &ToolCallCard,
    theme: &Theme,
    content_width: usize,
    rows: &mut layout::RowOutput,
) {
    let Some(started) = card.started_at else {
        return;
    };
    let label = if card.ended_at.is_some() {
        "Took"
    } else {
        "Elapsed"
    };
    let elapsed = card.ended_at.unwrap_or_else(Instant::now) - started;
    let text = format!("{label} {}", format_bash_duration(elapsed.as_millis()));
    rows.blank();
    rows.wrapped_text(&text, theme.fg_style(ThemeColor::Dim), content_width);
}

/// The bash tool's output byte budget (TS `DEFAULT_MAX_BYTES`), used in the
/// truncation warning when the spill carries no `maxBytes`.
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;

/// `formatSize` (TS `truncate.ts`): `512B`, `50.0KB`, `1.2MB`.
#[must_use]
pub fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Image result blocks render their metadata row below the card (TS
/// `tool-execution.ts` adds one `Image` component per result image
/// block, with `fallbackOnly` and the `\u{2570}\u{2500}` prefix, in the
/// toolOutput fallback color). Blocks without data or a mime type, and
/// every image while `show_images` is false, render nothing here — the
/// hidden ones contribute their `[Image: ...]` text through
/// [`ToolResultView::text_output`] instead.
///
/// The row is built from the block's metadata only (the render-path skip,
/// the image-heavy session-open fix): the TS component decoded the whole
/// base64 string for its dimensions, and a tool result carrying megabytes
/// of image payload paid that decode on every visited card. The
/// dimensions now come from [`get_image_dimensions_prefix`]'s bounded
/// prefix read, and a payload whose header does not parse from the
/// prefix renders its size instead — `[image/jpeg · 140.1KB omitted]` —
/// so the base64 is never cloned or decoded in full.
///
/// [`get_image_dimensions_prefix`]:
/// crate::terminal_image::get_image_dimensions_prefix
pub(crate) fn image_rows(
    result: Option<&ToolResultView>,
    show_images: bool,
    theme: &Theme,
) -> Vec<Line> {
    let fallback = theme.fg_style(ThemeColor::ToolOutput);
    let mut rows: Vec<Line> = Vec::new();
    for block in eligible_image_blocks(result, show_images) {
        rows.push(vec![Span::styled(
            format!("    \u{2570}\u{2500} {}", image_block_row_text(block)),
            fallback,
        )]);
    }
    rows
}

/// The metadata-row text for one shown image block: the TS `Image`
/// component's fallback-only shape `[mime · WxH]`, or the size-only
/// placeholder `[mime · 140.1KB omitted]` when the dimensions are not
/// available. The dimensions come from the elision marker's
/// `widthPx`/`heightPx` when the transcript load elided the payload, and
/// from the payload's bounded prefix otherwise (never a full decode).
/// Computed without cloning the payload.
pub(crate) fn image_block_row_text(block: &Value) -> String {
    let mime = block
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/unknown");
    let dimensions = image_block_dimensions(block);
    match dimensions {
        Some(dimensions) => format!(
            "[{mime} \u{b7} {}\u{d7}{}]",
            dimensions.width_px, dimensions.height_px
        ),
        None => format!("[{mime} \u{b7} {} omitted]", image_block_size_text(block)),
    }
}

/// The image block's pixel dimensions, without a payload decode: the
/// elision marker's `widthPx`/`heightPx` when the transcript load elided
/// the data (the marker the daemon's attach snapshot writes), else the
/// bounded-prefix read of the payload.
pub(crate) fn image_block_dimensions(
    block: &Value,
) -> Option<crate::terminal_image::ImageDimensions> {
    if let (Some(width), Some(height)) = (
        block.get("widthPx").and_then(Value::as_u64),
        block.get("heightPx").and_then(Value::as_u64),
    ) {
        return Some(crate::terminal_image::ImageDimensions {
            width_px: width as u32,
            height_px: height as u32,
        });
    }
    match (
        block.get("data").and_then(Value::as_str),
        block.get("mimeType").and_then(Value::as_str),
    ) {
        (Some(data), Some(mime)) => crate::terminal_image::get_image_dimensions_prefix(
            data,
            mime,
            crate::terminal_image::IMAGE_DIMENSIONS_PREFIX_BYTES,
        ),
        _ => None,
    }
}

fn eligible_image_blocks(
    result: Option<&ToolResultView>,
    show_images: bool,
) -> impl Iterator<Item = &Value> {
    result
        .into_iter()
        .flat_map(|result| result.content.iter())
        .filter(move |block| {
            // The paint eligibility mirrors the geometry count's
            // (`eligible_images`): a block whose `data` is not a string
            // renders no row on either path, so a `data: null` block can
            // never make the cached card heights diverge from rendering.
            show_images
                && block.get("type").and_then(Value::as_str) == Some("image")
                && block.get("data").and_then(Value::as_str).is_some()
                && block.get("mimeType").and_then(Value::as_str).is_some()
        })
}

fn eligible_images(
    result: Option<&ToolResultView>,
    show_images: bool,
) -> impl Iterator<Item = (&str, &str)> {
    result
        .into_iter()
        .flat_map(|result| &result.content)
        .filter_map(move |block| {
            if !show_images || block.get("type").and_then(Value::as_str) != Some("image") {
                return None;
            }
            Some((
                block.get("data")?.as_str()?,
                block.get("mimeType")?.as_str()?,
            ))
        })
}

/// Exact row geometry for every tool shell without painting output rows.
pub(crate) fn count_tool_card(
    card: &ToolCallCard,
    frame: usize,
    detail: Detail,
    theme: &Theme,
    width: usize,
    show_images: bool,
) -> usize {
    match card.name.as_str() {
        "ipython" => ipython::count(card, frame, detail, theme, width, show_images),
        "bash" => bash::count(card, frame, detail, theme, width, show_images),
        _ => generic::count(card, frame, detail, theme, width, show_images),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> crate::theme::Theme {
        use crate::theme::{ColorMode, Theme};
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn text_of(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect()
    }

    fn tiny_png(width: u32, height: u32) -> String {
        use base64::Engine;
        let mut bytes = vec![0x89, b'P', b'N', b'G'];
        bytes.extend(vec![0u8; 12]); // length + IHDR tag
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn image_result(data: &str, mime: &str) -> Option<ToolResultView> {
        Some(ToolResultView {
            content: vec![
                serde_json::json!({ "type": "text", "text": "done" }),
                serde_json::json!({ "type": "image", "data": data, "mimeType": mime }),
            ],
            details: serde_json::Value::Null,
            is_error: false,
        })
    }

    #[test]
    fn shown_image_rows_render_metadata_without_materializing_the_payload() {
        // A payload whose header parses but whose tail (past the bounded
        // prefix) is invalid base64: the row still renders its dimensions,
        // proving the payload was never decoded in full — a full decode
        // would have failed and rendered the size placeholder instead.
        let payload = format!("{}{}{}", tiny_png(64, 32), "A".repeat(4096), "!".repeat(64));
        let result = image_result(&payload, "image/png");
        let rows = image_rows(result.as_ref(), true, &theme());
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert_eq!(
            flat,
            vec!["    \u{2570}\u{2500} [image/png \u{b7} 64\u{d7}32]".to_string()]
        );
        // The render never emits any of the payload's tail bytes.
        assert!(flat.iter().all(|row| !row.contains("AAAA")));
    }

    #[test]
    fn shown_image_rows_render_the_size_placeholder_when_the_header_does_not_parse() {
        // A payload whose dimensions do not parse from the bounded prefix
        // renders its size instead (the honest omission marker).
        let payload = "x".repeat(186_328);
        let result = image_result(&payload, "image/jpeg");
        let rows = image_rows(result.as_ref(), true, &theme());
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert_eq!(
            flat,
            vec!["    \u{2570}\u{2500} [image/jpeg \u{b7} 182.0KB omitted]".to_string()]
        );
    }

    #[test]
    fn elided_payloads_render_the_size_placeholder_from_the_marker() {
        // The transcript load's elision marker (data emptied, the byte
        // count in elidedBytes): the row renders from the marker alone.
        let result = Some(ToolResultView {
            content: vec![serde_json::json!({
                "type": "image",
                "data": "",
                "mimeType": "image/jpeg",
                "elidedBytes": 186_328
            })],
            details: serde_json::Value::Null,
            is_error: false,
        });
        let rows = image_rows(result.as_ref(), true, &theme());
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert_eq!(
            flat,
            vec!["    \u{2570}\u{2500} [image/jpeg \u{b7} 182.0KB omitted]".to_string()]
        );
    }

    #[test]
    fn hidden_image_text_never_parses_the_payload_or_the_marker() {
        let view = ToolResultView {
            content: vec![serde_json::json!({
                "type": "image",
                "data": tiny_png(64, 32),
                "mimeType": "image/png"
            })],
            ..Default::default()
        };
        assert_eq!(view.text_output(false), "[Image: [image/png]]");

        let elided = ToolResultView {
            content: vec![serde_json::json!({
                "type": "image",
                "data": "",
                "mimeType": "image/jpeg",
                "elidedBytes": 186_328
            })],
            ..Default::default()
        };
        assert_eq!(elided.text_output(false), "[Image: [image/jpeg]]");
    }

    #[test]
    fn non_string_data_blocks_render_no_rows_on_either_path() {
        // A `data: null` image block is not an image row: the paint
        // eligibility mirrors the geometry count's, so the cached card
        // heights cannot diverge from rendering (the Macroscope finding).
        let result = Some(ToolResultView {
            content: vec![serde_json::json!({
                "type": "image",
                "data": null,
                "mimeType": "image/png"
            })],
            details: serde_json::Value::Null,
            is_error: false,
        });
        assert!(image_rows(result.as_ref(), true, &theme()).is_empty());
        assert_eq!(eligible_images(result.as_ref(), true).count(), 0);
        // The elided marker (data: "") stays a real row on both paths.
        let elided = Some(ToolResultView {
            content: vec![serde_json::json!({
                "type": "image",
                "data": "",
                "mimeType": "image/png",
                "elidedBytes": 500 * 1024
            })],
            details: serde_json::Value::Null,
            is_error: false,
        });
        assert_eq!(image_rows(elided.as_ref(), true, &theme()).len(), 1);
        assert_eq!(eligible_images(elided.as_ref(), true).count(), 1);
    }

    #[test]
    fn panel_status_settles_on_error_even_while_partial() {
        let mut card = ToolCallCard {
            name: "bash".into(),
            started: true,
            ..Default::default()
        };
        card.result = Some(ToolResultView {
            is_error: true,
            ..Default::default()
        });
        card.result_partial = true;
        assert!(matches!(panel_status(&card), PanelStatus::Error));
        card.result_partial = false;
        assert!(matches!(panel_status(&card), PanelStatus::Error));
        card.result = Some(ToolResultView::default());
        assert!(matches!(panel_status(&card), PanelStatus::Done));
        card.result = None;
        assert!(matches!(panel_status(&card), PanelStatus::Running));
        card.started = false;
        assert!(matches!(panel_status(&card), PanelStatus::Queued));
    }
}
