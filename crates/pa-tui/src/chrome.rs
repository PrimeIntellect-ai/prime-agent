//! Chat chrome: the pinned top bar, brand splash header, prompt context
//! line, and the tray line under the editor. Ports the TS components
//! `top-bar.ts`, `BrandSplashHeader` (interactive-mode.ts), and
//! `subagent-summary-line.ts` row layout.

use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::Style;

use crate::theme::{Theme, ThemeBg, ThemeColor};

/// The compact 7-row brand butterfly (TS `PRIME_COMPACT_BUTTERFLY_LOGO`).
pub const PRIME_COMPACT_BUTTERFLY_LOGO: &str = concat!(
    "                 \u{2597}\u{2584}\u{2584}\u{2588}\u{2580}\n",
    "   \u{2588}\u{2588}\u{2588}\u{2584}       \u{2597}\u{2584}\u{2588}\u{2588}\u{2588}\u{2580}\n",
    "  \u{2597}\u{2588}\u{259b}\u{2590}\u{2588}\u{2599}   \u{2597}\u{2584}\u{2588}\u{2580}\u{2597}\u{2588}\u{2580}\n",
    " \u{2597}\u{2588}\u{259b} \u{259f}\u{2588}\u{2588}\u{2599}\u{2584}\u{2588}\u{2588}\u{259b} \u{259f}\u{259b}\n",
    " \u{2597}\u{259f}\u{258c} \u{2590}\u{2588}\u{2588}\u{2588}\u{259b}\u{2598}\u{2597}\u{2584}\u{2588}\u{2596}\n",
    "\u{259f}\u{2588}\u{2588}\u{2588}\u{2584}  \u{2584}\u{2584}\u{259f}\u{2588}\u{2588}\u{2588}\u{2580}\n",
    "\u{259c}\u{2588}\u{259b}\u{2580}\u{2598}  \u{259c}\u{2588}\u{259b}\u{2580}\u{2598}",
);

/// Truncate a plain string to a visible width (TS `truncateToWidth` for
/// plain strings: cut on grapheme boundaries, appending the ellipsis).
fn truncate_to_width(value: &str, max_width: usize, ellipsis: &str) -> String {
    if str_width(value) <= max_width {
        return value.to_string();
    }
    if max_width == 0 {
        return String::new();
    }
    let mut out = String::new();
    for ch in value.chars() {
        if str_width(&out) + crate::width::char_width(ch) > max_width {
            break;
        }
        out.push(ch);
    }
    format!("{out}{ellipsis}")
}

/// Where a session runs; drives labels that depend on persistence.
#[derive(Debug, Clone, Default)]
pub struct ChromeState {
    /// Product version shown in the splash (`prime agent vX`).
    pub version: String,
    /// Session working directory (splash `cwd` line; `~`-compressed).
    pub cwd: String,
    /// Current model id (splash `model` line; `None` hides the line).
    pub model_id: Option<String>,
    /// Extra metadata lines under the splash (`label value` each; e.g. the
    /// agents view's `agents N running, ...` count row and, in scoped
    /// mode, the `depth N` row). Empty renders none.
    pub extra_metadata: Vec<(String, String)>,
    /// Top-bar chat name (session name or the cwd basename).
    pub chat_name: String,
    /// Session spend (USD) beside the chat name.
    pub cost_usd: Option<f64>,
    /// Context usage: tokens, window, percent (tray right label).
    pub context: Option<ContextUsage>,
    /// `← manage` hint: shown for persisted (attachable) sessions.
    pub show_manage: bool,
    /// The attached session's RLM depth (TS `formatAgentDepthLabel`): a
    /// subagent session renders `depth N` after the manage hint; a root
    /// session (depth 0 or unknown) renders none.
    pub tray_depth: Option<u32>,
    /// Thinking effort suffix rendered as `model:effort` in the tray.
    pub thinking_suffix: Option<String>,
    /// Startup warning (tmux keyboard setup), rendered as a status row.
    pub tmux_notice: Option<String>,
    /// The tray's goal label (TS `getTrayGoalLabel`: `Pursuing goal (0s)`
    /// while active, `Goal paused (0s)`, ...); `None` for idle/complete/error
    /// goals. Joins the tray context label first, before the model.
    pub goal_label: Option<String>,
    /// The tray's heartbeat label (TS `getTrayHeartbeatLabel`):
    /// `N heartbeats · M paused (Ctrl+R)` over the session-scoped catalog;
    /// `None` when no heartbeat is in scope. Joins between goal and model.
    pub heartbeat_label: Option<String>,
    /// Tray override label (TS `getTrayOverrideLabel`): while the Ctrl+C
    /// exit hint is armed, it replaces the tray's location label.
    pub tray_override: Option<String>,
    /// The subagent summary box under the tray (TS `SubagentSummaryLine`):
    /// `None` hides the box; a zero-total summary renders nothing either.
    pub subagents: Option<SubagentSummary>,
    /// Hide the splash `cwd` line (TS `getSplashCwd` returns `undefined`
    /// for the scoped agents view, so its metadata rows stay centered
    /// against the logo without the cwd row).
    pub splash_hide_cwd: bool,
}

/// Live descendant counts of a session's RLM children (TS
/// `SubagentSummaryCounts` + the focus/openable state of the summary line).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SubagentSummary {
    pub running: usize,
    pub idle: usize,
    pub inactive: usize,
    /// The summary line holds keyboard focus (selected background, the
    /// open hint instead of the select hint).
    pub focused: bool,
    /// The current run may open the scoped agents view (TS `setOpenable`:
    /// true for every daemon-hosted session).
    pub openable: bool,
}

impl SubagentSummary {
    /// Every retained descendant.
    pub fn total(&self) -> usize {
        self.running + self.idle + self.inactive
    }
}

/// Context usage for the tray label (`N (P%)`).
#[derive(Debug, Clone, Copy)]
pub struct ContextUsage {
    pub tokens: u64,
    pub context_window: u64,
}

impl ContextUsage {
    pub fn percent(&self) -> f64 {
        if self.context_window == 0 {
            0.0
        } else {
            (self.tokens as f64 / self.context_window as f64) * 100.0
        }
    }
}

/// `formatTokenCount` (agent-activity.ts): 999, 1.0k-9.9k, 10k, 1.2M.
pub fn format_token_count(count: u64) -> String {
    if count < 1_000 {
        return count.to_string();
    }
    if count < 10_000 {
        return format!("{:.1}k", count as f64 / 1_000.0);
    }
    if count < 1_000_000 {
        return format!("{}k", (count as f64 / 1_000.0).round() as u64);
    }
    if count < 10_000_000 {
        return format!("{:.1}M", count as f64 / 1_000_000.0);
    }
    format!("{}M", (count as f64 / 1_000_000.0).round() as u64)
}

/// The top-bar chat name for an unnamed session: the cwd basename
/// (TS `path.basename(getCurrentCwd())`).
pub fn display_name(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.to_string())
}

/// The `~`-compressed cwd for the splash line (TS `formatSplashCwd`).
pub fn format_splash_cwd(cwd: &str, home: Option<&str>) -> String {
    let Some(home) = home else {
        return cwd.replace('\\', "/");
    };
    let home = home.replace('\\', "/");
    let normalized = cwd.replace('\\', "/");
    if home.is_empty() {
        return normalized;
    }
    if normalized == home {
        return "~".to_string();
    }
    if let Some(rest) = normalized.strip_prefix(&format!("{home}/")) {
        return format!("~/{rest}");
    }
    normalized
}

/// Middle-truncate a path: keep the last two segments (`~/…/parent/leaf`).
pub fn truncate_path_middle(value: &str, width: usize) -> String {
    if str_width(value) <= width {
        return value.to_string();
    }
    if width <= 1 {
        return truncate_to_width(value, width, "");
    }
    let normalized = value.replace('\\', "/");
    let prefix = if normalized.starts_with("~/") {
        "~/"
    } else if normalized.starts_with('/') {
        "/"
    } else {
        ""
    };
    let body = normalized[prefix.len()..].to_string();
    let mut parts: Vec<&str> = body.split('/').filter(|part| !part.is_empty()).collect();
    let last = parts.pop().unwrap_or_default().to_string();
    let previous = parts.pop().map(str::to_string);
    let suffix = previous
        .map(|previous| format!("{previous}/{last}"))
        .unwrap_or(last);
    let candidate = format!("{prefix}\u{2026}/{suffix}");
    if str_width(&candidate) <= width {
        return candidate;
    }
    truncate_to_width(&candidate, width, "…")
}

/// The pinned top bar: chat name centered, spend beside it (TS `TopBar`).
pub fn render_top_bar(state: &ChromeState, theme: &Theme, width: usize) -> Line {
    let name = state
        .chat_name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .replace(char::is_whitespace, " ")
        .trim()
        .to_string();
    if name.is_empty() {
        return Vec::new();
    }
    let mut line: Line = Vec::new();
    let name_width = str_width(&name);
    let text = theme.fg_style(ThemeColor::Text);
    let dim = theme.fg_style(ThemeColor::Dim);
    let start = (width.saturating_sub(name_width)) / 2;
    line.push(Span::styled(" ".repeat(start), Style::default()));
    line.push(Span::styled(name, text));
    if let Some(cost) = state.cost_usd.filter(|cost| *cost >= 0.0) {
        line.push(Span::styled("  ".to_string(), Style::default()));
        line.push(Span::styled(format!("${cost:.2}"), dim));
    }
    line
}

/// The brand splash: butterfly logo beside the version/model/cwd metadata
/// (TS `BrandSplashHeader`; `topPadding` is always on in the chat header).
pub fn render_splash(state: &ChromeState, theme: &Theme, width: usize) -> Vec<Line> {
    let safe_width = width.max(1);
    let padding_x = if safe_width > 1 { 1 } else { 0 };
    let content_width = safe_width.saturating_sub(padding_x * 2).max(1);
    let logo_raw: Vec<&str> = PRIME_COMPACT_BUTTERFLY_LOGO.split('\n').collect();
    let logo_canvas_width = logo_raw
        .iter()
        .map(|line| str_width(line))
        .max()
        .unwrap_or(0);
    let gutter = 3usize;
    let show_logo =
        logo_canvas_width > 0 && content_width.saturating_sub(logo_canvas_width + gutter) >= 24;
    let meta_width = if show_logo {
        content_width.saturating_sub(logo_canvas_width + gutter)
    } else {
        content_width
    };

    let text = theme.fg_style(ThemeColor::Text);
    let muted = theme.fg_style(ThemeColor::Muted);
    let dim = theme.fg_style(ThemeColor::Dim);
    let title = "prime agent";
    let version = format!("v{}", state.version);
    let mut meta_lines: Vec<Line> = Vec::new();
    if str_width(&format!("{title} {version}")) <= meta_width {
        meta_lines.push(vec![
            Span::styled(title.to_string(), text),
            Span::styled(" ".to_string(), Style::default()),
            Span::styled(version, muted),
        ]);
    } else {
        meta_lines.push(vec![Span::styled(title.to_string(), text)]);
        meta_lines.push(vec![Span::styled(version, muted)]);
    }
    for (label_text, value_text) in &state.extra_metadata {
        let label = format!("{label_text} ");
        let value = truncate_to_width(
            value_text,
            meta_width.saturating_sub(str_width(&label)).max(1),
            "",
        );
        meta_lines.push(vec![Span::styled(label, dim), Span::styled(value, muted)]);
    }
    if let Some(model_id) = &state.model_id {
        let label = "model ";
        let value = truncate_to_width(
            model_id,
            meta_width.saturating_sub(str_width(label)).max(1),
            "",
        );
        meta_lines.push(vec![
            Span::styled(label.to_string(), dim),
            Span::styled(value, muted),
        ]);
    }
    if !state.splash_hide_cwd {
        let cwd_label = "cwd ";
        let home = pa_types::platform::home_dir().map(|home| home.to_string_lossy().into_owned());
        let cwd = truncate_path_middle(
            &format_splash_cwd(&state.cwd, home.as_deref()),
            meta_width.saturating_sub(str_width(cwd_label)).max(1),
        );
        meta_lines.push(vec![
            Span::styled(cwd_label.to_string(), dim),
            Span::styled(cwd, muted),
        ]);
    }

    let mut lines: Vec<Line> = vec![Vec::new()];
    let row_count = logo_raw.len().max(meta_lines.len());
    let meta_start = if show_logo {
        (row_count - meta_lines.len()) / 2
    } else {
        0
    };
    let logo_text = theme.fg_style(ThemeColor::Text);
    for index in 0..row_count {
        let mut spans: Line = Vec::new();
        let pad = if padding_x > 0 { " " } else { "" };
        spans.push(Span::styled(pad.to_string(), Style::default()));
        if show_logo {
            let logo_line = logo_raw.get(index).copied().unwrap_or("");
            spans.push(Span::styled(logo_line.to_string(), logo_text));
            let fill = logo_canvas_width.saturating_sub(str_width(logo_line)) + gutter;
            spans.push(Span::styled(" ".repeat(fill), Style::default()));
        }
        let meta_index = index as isize - meta_start as isize;
        if meta_index >= 0 {
            if let Some(meta_line) = meta_lines.get(meta_index as usize) {
                spans.extend(meta_line.iter().cloned());
            }
        }
        let used: usize = spans.iter().map(|s| str_width(&s.content)).sum();
        spans.push(Span::styled(
            " ".repeat(safe_width.saturating_sub(used + padding_x)),
            Style::default(),
        ));
        lines.push(spans);
    }
    // Header container: the splash row block trails one blank row.
    lines.push(Vec::new());
    lines
}

/// The plain row above the prompt: optional recap left, detail status right
/// (TS `PromptContextLine`, always `["", row]`).
pub fn render_prompt_context(detail_label: &str, theme: &Theme, width: usize) -> Vec<Line> {
    if width < 1 {
        return Vec::new();
    }
    let padding_x = if width > 2 { 1 } else { 0 };
    let content_width = width.saturating_sub(padding_x * 2);
    let dim = theme.fg_style(ThemeColor::Dim);
    let label_width = str_width(detail_label);
    let label = if label_width > content_width {
        truncate_to_width(detail_label, content_width, "")
    } else {
        detail_label.to_string()
    };
    let space = content_width.saturating_sub(str_width(&label));
    let row = vec![
        Span::raw(" ".repeat(padding_x)),
        Span::raw(" ".repeat(space)),
        Span::styled(label, dim),
        Span::raw(" ".repeat(padding_x)),
    ];
    vec![Vec::new(), row]
}

/// The conversation-detail status label (TS `formatConversationDetailStatus`):
/// "Expanded" (all output), "Details" (thinking + diffs, output collapsed), or
/// "Collapsed"; only Expanded flips the key hint to "collapse".
pub fn conversation_detail_status(all_output: bool, details: bool, key_display: &str) -> String {
    let label = if all_output {
        "Expanded"
    } else if details {
        "Details"
    } else {
        "Collapsed"
    };
    let action = if all_output { "collapse" } else { "expand" };
    format!("{label} mode ({key_display} to {action})")
}

/// The tray row under the editor (TS `SubagentSummaryLine.renderInfoLine`):
/// location label left, context label right, over the full width.
pub fn render_tray(state: &ChromeState, theme: &Theme, width: usize) -> Line {
    let dim = theme.fg_style(ThemeColor::Dim);
    let muted = theme.fg_style(ThemeColor::Muted);
    let mut left: Line = Vec::new();
    if let Some(override_label) = &state.tray_override {
        // TS `renderInfoLine`: the override label replaces the location
        // label on the left while it is set.
        left.push(Span::styled(override_label.clone(), muted));
    } else if state.show_manage {
        left.push(Span::styled("\u{2190}".to_string(), dim));
        left.push(Span::styled(" manage".to_string(), muted));
        // TS `getTrayLocationLabel`: a subagent session joins its
        // `depth N` label onto the manage hint (a root session
        // renders none).
        if let Some(depth) = state.tray_depth.filter(|depth| *depth > 0) {
            left.push(Span::styled("  ".to_string(), muted));
            left.push(Span::styled(format!("depth {depth}"), muted));
        }
    }
    let mut right: Line = Vec::new();
    if let Some(goal) = &state.goal_label {
        right.push(Span::styled(goal.clone(), dim));
    }
    if let Some(heartbeats) = &state.heartbeat_label {
        if !right.is_empty() {
            right.push(Span::styled(" \u{00b7} ".to_string(), dim));
        }
        right.push(Span::styled(heartbeats.clone(), dim));
    }
    if let Some(model) = &state.model_id {
        let mut label = model.clone();
        if let Some(suffix) = &state.thinking_suffix {
            label.push(':');
            label.push_str(suffix);
        }
        if !right.is_empty() {
            right.push(Span::styled(" \u{00b7} ".to_string(), dim));
        }
        right.push(Span::styled(label, dim));
    }
    if let Some(context) = &state.context {
        if !right.is_empty() {
            right.push(Span::styled(" \u{00b7} ".to_string(), dim));
        }
        right.push(Span::styled(
            format!(
                "{} ({:.0}%)",
                format_token_count(context.tokens),
                context.percent()
            ),
            dim,
        ));
    }
    let left_width: usize = left.iter().map(|s| str_width(&s.content)).sum();
    let right_width: usize = right.iter().map(|s| str_width(&s.content)).sum();
    let gap = width.saturating_sub(left_width + right_width);
    let mut line: Line = Vec::new();
    line.extend(left);
    line.push(Span::styled(" ".repeat(gap), Style::default()));
    line.extend(right);
    line
}

/// Truncate a styled span row to a visible width, replacing the tail with
/// the ellipsis when it does not fit (TS `truncateToWidth` on the composed
/// row).
fn truncate_spans_to_width(spans: &[crate::Span], width: usize) -> Vec<crate::Span> {
    let mut out: Vec<crate::Span> = Vec::new();
    let mut remaining = width;
    for span in spans {
        if remaining == 0 {
            break;
        }
        let mut text = String::new();
        let mut consumed = 0usize;
        for ch in span.content.chars() {
            let char_width = crate::width::char_width(ch);
            if consumed + char_width > remaining {
                break;
            }
            text.push(ch);
            consumed += char_width;
        }
        if text.is_empty() {
            break;
        }
        let mut truncated = false;
        if consumed < str_width(&span.content) {
            // The span could not fit whole: the ellipsis replaces the first
            // character that would not fit, and nothing after it renders.
            text.push('\u{2026}');
            truncated = true;
        }
        let mut piece = span.clone();
        piece.content = text;
        out.push(piece);
        remaining -= consumed;
        if truncated {
            break;
        }
    }
    out
}

/// The subagent summary box (TS `SubagentSummaryLine.render`, the counts
/// box under the tray): a `\u{256d}\u{2500} subagents \u{2500}\u{256e}` frame with the
/// status counts left and the open/select hint right; the focused row
/// carries the selection background. A zero-total summary renders nothing.
pub fn render_subagent_summary(
    summary: &SubagentSummary,
    confirm_hint: &str,
    open_hint: &str,
    select_hint: &str,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    if summary.total() == 0 || width < 2 {
        return Vec::new();
    }
    let inner = width - 2;
    let border = theme.fg_style(ThemeColor::Border);
    let label = "subagents";
    let label_width = str_width(label);
    let top_rule = "\u{2500}".repeat(inner.saturating_sub(3 + label_width));
    let top: Line = vec![
        Span::styled("\u{256d}\u{2500} ".to_string(), border),
        Span::styled(label.to_string(), theme.fg_style(ThemeColor::Accent)),
        Span::styled(format!(" {top_rule}\u{256e}"), border),
    ];
    let counts = [
        (
            ThemeColor::Success,
            format!("\u{25cf} {} running", summary.running),
        ),
        (
            ThemeColor::Warning,
            format!("\u{25d0} {} idle", summary.idle),
        ),
        (
            ThemeColor::Dim,
            format!("\u{25cb} {} inactive", summary.inactive),
        ),
    ];
    let counts_width: usize = counts
        .iter()
        .map(|(_, text)| str_width(text))
        .sum::<usize>()
        + (counts.len() - 1) * 3;
    let hint = match (summary.openable, summary.focused) {
        (true, true) => format!("{confirm_hint}/{open_hint} open"),
        (true, false) => format!("{select_hint} select"),
        _ => String::new(),
    };
    let hint_width = str_width(&hint);
    let gap = inner.saturating_sub(2 + counts_width + hint_width).max(1);
    // The composed row: one leading space, counts (3-space separated), the
    // gap, the hint, one trailing space (TS `\u{20}${counts}${gap}${hint}\u{20}`).
    let mut spans: Vec<crate::Span> = vec![Span::raw(" ".to_string())];
    for (index, (color, text)) in counts.iter().enumerate() {
        if index > 0 {
            spans.push(Span::raw("   ".to_string()));
        }
        spans.push(Span::styled(text.clone(), theme.fg_style(*color)));
    }
    spans.push(Span::raw(" ".repeat(gap)));
    if !hint.is_empty() {
        spans.push(Span::styled(hint.clone(), theme.fg_style(ThemeColor::Dim)));
    }
    spans.push(Span::raw(" ".to_string()));
    let body = truncate_spans_to_width(&spans, inner);
    let body_width: usize = body.iter().map(|s| str_width(&s.content)).sum();
    let pad = inner.saturating_sub(body_width);
    let mut row: Line = vec![Span::styled("\u{2502}".to_string(), border)];
    if summary.focused {
        let selected = theme.bg_style(ThemeBg::SelectedBg);
        for mut span in body {
            span.style = span.style.patch(selected);
            row.push(span);
        }
        row.push(Span::styled(" ".repeat(pad), selected));
    } else {
        row.extend(body);
        row.push(Span::raw(" ".repeat(pad)));
    }
    row.push(Span::styled("\u{2502}".to_string(), border));
    let bottom: Line = vec![Span::styled(
        format!("\u{2570}{}\u{256f}", "\u{2500}".repeat(inner)),
        border,
    )];
    vec![top, row, bottom]
}

/// The editor surface background: `userMessageBg` (TS `getEditorTheme`).
pub fn editor_background(theme: &Theme) -> ratatui::style::Style {
    theme.bg_style(ThemeBg::UserMessageBg)
}

#[cfg(test)]
mod tests {
    #[test]
    fn subagent_summary_box_matches_ts_geometry() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let summary = SubagentSummary {
            running: 0,
            idle: 1,
            inactive: 0,
            focused: false,
            openable: true,
        };
        let rows = render_subagent_summary(&summary, "Enter", "\u{2192}", "\u{2193}", &theme, 120);
        assert_eq!(rows.len(), 3, "the box frame is three rows");
        let flat = |row: &Line| row.iter().map(|s| s.content.as_str()).collect::<String>();
        assert_eq!(
            flat(&rows[0]),
            "\u{256d}\u{2500} subagents ".to_string() + &"\u{2500}".repeat(106) + "\u{256e}"
        );
        assert_eq!(
            flat(&rows[1]),
            "\u{2502} \u{25cf} 0 running   \u{25d0} 1 idle   \u{25cb} 0 inactive".to_string()
                + &" ".repeat(71)
                + "\u{2193} select \u{2502}"
        );
        assert_eq!(
            flat(&rows[2]),
            "\u{2570}".to_string() + &"\u{2500}".repeat(118) + "\u{256f}"
        );
        assert_eq!(str_width(&flat(&rows[1])), 120);
    }

    #[test]
    fn subagent_summary_box_hidden_without_children() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let summary = SubagentSummary::default();
        assert!(
            render_subagent_summary(&summary, "Enter", "\u{2192}", "\u{2193}", &theme, 120)
                .is_empty()
        );
        let focused = SubagentSummary {
            running: 2,
            idle: 0,
            inactive: 1,
            focused: true,
            openable: true,
        };
        let rows = render_subagent_summary(&focused, "Enter", "\u{2192}", "\u{2193}", &theme, 120);
        let flat = |row: &Line| row.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(
            flat(&rows[1])
                .trim()
                .ends_with("Enter/\u{2192} open \u{2502}"),
            "{}",
            flat(&rows[1])
        );
    }

    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    #[test]
    fn token_count_formats() {
        assert_eq!(format_token_count(999), "999");
        assert_eq!(format_token_count(6_123), "6.1k");
        assert_eq!(format_token_count(61_234), "61k");
        assert_eq!(format_token_count(1_234_567), "1.2M");
    }

    #[test]
    fn splash_renders_logo_version_model_and_cwd() {
        let state = ChromeState {
            version: "0.0.0".to_string(),
            cwd: "/tmp/project".to_string(),
            model_id: Some("faux-1".to_string()),
            ..Default::default()
        };
        let lines = render_splash(&state, &theme(), 120);
        assert_eq!(lines[0], Vec::new());
        let text = |line: &Line| line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(lines.iter().any(|l| text(l).contains("prime agent v0.0.0")));
        assert!(lines.iter().any(|l| text(l).contains("model faux-1")));
        assert!(lines.iter().any(|l| text(l).contains("cwd /tmp/project")));
        assert!(lines
            .iter()
            .any(|l| text(l).contains("\u{2597}\u{2584}\u{2584}")));
    }

    #[test]
    fn top_bar_centers_name_with_cost() {
        let state = ChromeState {
            chat_name: "shared-cwd".to_string(),
            cost_usd: Some(0.0),
            ..Default::default()
        };
        let line = render_top_bar(&state, &theme(), 120);
        let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(text.contains("shared-cwd  $0.00"));
        let start = text.find("shared-cwd").unwrap();
        assert_eq!(start, 55);
    }

    #[test]
    fn tray_left_and_right_labels() {
        let state = ChromeState {
            show_manage: true,
            model_id: Some("faux-1".to_string()),
            context: Some(ContextUsage {
                tokens: 6_123,
                context_window: 128_000,
            }),
            ..Default::default()
        };
        let line = render_tray(&state, &theme(), 120);
        let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(text.starts_with("\u{2190} manage"));
        assert!(text.contains("faux-1 \u{00b7} 6.1k (5%)"));
        assert_eq!(str_width(&text), 120);
    }

    /// The tray's goal label joins the context label first (TS
    /// `getTrayContextLabel`: `[goalLabel, ..., modelContextLabel]`).
    #[test]
    fn tray_goal_label_joins_the_context_label() {
        let state = ChromeState {
            show_manage: true,
            model_id: Some("mock-1".to_string()),
            context: Some(ContextUsage {
                tokens: 190,
                context_window: 128_000,
            }),
            goal_label: Some("Pursuing goal (0s)".to_string()),
            ..Default::default()
        };
        let line = render_tray(&state, &theme(), 120);
        let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(text.contains("Pursuing goal (0s) \u{b7} mock-1 \u{b7} 190 (0%)"));
        assert_eq!(str_width(&text), 120);
    }

    /// The tray's heartbeat label joins between goal and model (TS
    /// `getTrayContextLabel`:
    /// `[goalLabel, heartbeatLabel, modelContextLabel]`).
    #[test]
    fn tray_heartbeat_label_joins_between_goal_and_model() {
        let state = ChromeState {
            show_manage: true,
            model_id: Some("mock-1".to_string()),
            context: Some(ContextUsage {
                tokens: 190,
                context_window: 128_000,
            }),
            goal_label: Some("Pursuing goal (0s)".to_string()),
            heartbeat_label: Some("2 heartbeats · 1 paused (Ctrl+R)".to_string()),
            ..Default::default()
        };
        let line = render_tray(&state, &theme(), 120);
        let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(text.contains(
            "Pursuing goal (0s) \u{b7} 2 heartbeats \u{b7} 1 paused (Ctrl+R) \u{b7} mock-1 \u{b7} 190 (0%)"
        ));
        assert_eq!(str_width(&text), 120);
    }

    #[test]
    fn tray_override_replaces_location_label() {
        let state = ChromeState {
            show_manage: true,
            tray_override: Some("Press Ctrl+C again to exit".to_string()),
            model_id: Some("faux-1".to_string()),
            ..Default::default()
        };
        let line = render_tray(&state, &theme(), 120);
        let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(text.starts_with("Press Ctrl+C again to exit"));
        assert!(!text.contains("manage"));
    }

    #[test]
    fn detail_status_label() {
        assert_eq!(
            conversation_detail_status(false, false, "Ctrl+O"),
            "Collapsed mode (Ctrl+O to expand)"
        );
        assert_eq!(
            conversation_detail_status(false, true, "Ctrl+O"),
            "Details mode (Ctrl+O to expand)"
        );
        assert_eq!(
            conversation_detail_status(true, true, "Ctrl+O"),
            "Expanded mode (Ctrl+O to collapse)"
        );
    }
}
