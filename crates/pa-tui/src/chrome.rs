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
    /// Tray override label (TS `getTrayOverrideLabel`): while the Ctrl+C
    /// exit hint is armed, it replaces the tray's location label.
    pub tray_override: Option<String>,
    /// Compact, borderless activity dock under the editor.
    pub activity: Option<ActivityDock>,
    /// The footer's tok/sec readout (TS `FooterComponent` under `/speed`):
    /// the dim bottom row's text; `None` renders no row. The client keeps
    /// `None` until the first completed response while the display is on
    /// (TS renders nothing when enabled without text).
    pub speed_text: Option<String>,
    /// Hide the splash `cwd` line (TS `getSplashCwd` returns `undefined`
    /// for the scoped agents view, so its metadata rows stay centered
    /// against the logo without the cwd row).
    pub splash_hide_cwd: bool,
}

/// Which actionable group owns the activity-dock selection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ActivityGroup {
    #[default]
    Subagents,
    Heartbeats,
    Bash,
    /// The active goal: selectable while a goal is being pursued, opens
    /// the read-only goal panel (the objective and its facts).
    Goal,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActivityDock {
    /// The directly-running children right now (the `direct` number of
    /// the dock's rendered `direct, nested subagents` pair; the
    /// operator's 2026-09-25 split).
    pub subagents_running_direct: usize,
    /// The further running descendants below them (subagents of
    /// subagents): the `nested` number of the rendered pair. Idle and
    /// dead registry rows never count — they render in the scoped
    /// agents view.
    pub subagents_running_nested: usize,
    /// Every descendant, finished ones included: this keeps the dock
    /// mounted and its Subagents group selectable while any subagent
    /// history remains browsable (the rendered count stays live-only).
    pub subagents_total: usize,
    /// The CURRENT session's heartbeats (nested sessions' jobs do not
    /// surface here, operator scoping).
    pub heartbeats: usize,
    /// How many of the scoped heartbeats are paused.
    pub heartbeats_paused: usize,
    /// Bash processes actively running right now (the current session's
    /// kernel registry only): finished runs never inflate the indicator
    /// — they stay as rows inside the bash view.
    pub bash_running: usize,
    /// Every catalogued kernel-bash run, finished ones included: this
    /// keeps the dock (and so the bash view's history) reachable when no
    /// run is live; the rendered indicator count stays `bash_running`.
    pub bash_total: usize,
    /// The active goal's dock label — `Pursuing goal (12m 05s)`-style,
    /// the elapsed-time form (the operator's 2026-09-24 directive: the
    /// row reads the time, the token budget lives inside the goal
    /// panel); `None` unless the goal is actively being pursued (a
    /// completed or idle goal carries no dock segment).
    pub goal_label: Option<String>,
    pub selected: ActivityGroup,
    pub focused: bool,
}

impl ActivityDock {
    pub fn visible(&self) -> bool {
        self.subagents_total > 0
            || self.heartbeats > 0
            || self.bash_total > 0
            || self.goal_label.is_some()
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
    std::path::Path::new(cwd).file_name().map_or_else(
        || cwd.to_string(),
        |name| name.to_string_lossy().to_string(),
    )
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
    let padding_x = usize::from(safe_width > 1);
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

/// The plain row above the prompt: the detail status right (TS
/// `PromptContextLine`, always `["", row]`).
pub fn render_prompt_context(detail_label: &str, theme: &Theme, width: usize) -> Vec<Line> {
    if width < 1 {
        return Vec::new();
    }
    let padding_x = usize::from(width > 2);
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
    for (index, span) in spans.iter().enumerate() {
        if remaining == 0 {
            // The frame filled on a span boundary: the later spans still
            // exist, so the ellipsis must land (a silent drop would hide
            // content the reader cannot know about).
            if content_follows(spans, index) {
                land_marker(&mut out, width);
            }
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
            // This span's first character cannot fit: nothing of it
            // renders, and the ellipsis must still mark the cut.
            if content_follows(spans, index) {
                land_marker(&mut out, width);
            }
            break;
        }
        if consumed < str_width(&span.content) {
            // The span could not fit whole: the ellipsis borrows its
            // column from the span's last kept character — a span that
            // fills the edge exactly gives one character back (and at a
            // one-column remainder the ellipsis renders alone), so the
            // row always ends INSIDE the width.
            let ellipsis = crate::width::char_width('\u{2026}');
            while consumed + ellipsis > remaining {
                match text.pop() {
                    Some(dropped) => consumed -= crate::width::char_width(dropped),
                    None => break,
                }
            }
            text.push('\u{2026}');
            let mut piece = span.clone();
            piece.content = text;
            out.push(piece);
            break;
        }
        let mut piece = span.clone();
        piece.content = text;
        out.push(piece);
        remaining -= consumed;
    }
    out
}

/// Whether any span from `index` (inclusive) still carries content — a
/// cut there must leave a marker.
fn content_follows(spans: &[crate::Span], index: usize) -> bool {
    spans[index..].iter().any(|span| !span.content.is_empty())
}

/// Land the truncation marker on a row that filled the frame on a span
/// boundary: the ellipsis borrows a column from the last kept character
/// (however wide it was), and a row too narrow for any content keeps
/// the marker alone when it fits at all.
fn land_marker(out: &mut Vec<crate::Span>, width: usize) {
    let ellipsis = crate::width::char_width('\u{2026}');
    let row_width = |out: &Vec<crate::Span>| {
        out.iter()
            .map(|piece| crate::width::str_width(&piece.content))
            .sum::<usize>()
    };
    while row_width(out) + ellipsis > width {
        match out.last_mut() {
            Some(piece) => {
                if piece.content.pop().is_none() {
                    out.pop();
                }
            }
            None => break,
        }
    }
    match out.last_mut() {
        Some(piece) => piece.content.push('\u{2026}'),
        None => {
            if ellipsis <= width {
                out.push(crate::Span::raw("\u{2026}"));
            }
        }
    }
}

/// The framed activity dock: a muted separator rule above one row of
/// the actionable groups. The TS summary line wraps its content in an
/// accent-colored box (`╭─ subagents ─╮`); the inline design language
/// keeps the separation with the same muted `─` rule that frames the
/// pickers' search fields, not an accent box.
///
/// The row color-codes live activity (the operator's 2026-09-24
/// directive): every count-holding segment goes green while its count
/// is above zero (subagents, heartbeats, shells, the active goal) and
/// stays neutral at zero. The subagents segment is one consolidated
/// item — `◆ x subagents` (the operator's 2026-09-25 consolidation:
/// the separate running cluster was redundant).
pub fn render_activity_dock(dock: &ActivityDock, theme: &Theme, width: usize) -> Option<Vec<Line>> {
    if !dock.visible() || width == 0 {
        return None;
    }
    // The status-dot vocabulary rides the remaining count cluster (TS
    // `subagent-summary-line`'s `● running / ◐ idle / ○ inactive`): the
    // half circle marks waiting work. Only the heartbeat pause keeps a
    // dot.
    let cluster = |text: &str, color: ThemeColor| {
        vec![
            theme.fg_span(ThemeColor::Dim, " · ".to_string()),
            theme.fg_span(color, text.to_string()),
        ]
    };
    // The live-only number: the count of actively-running subagents
    // right now, split into the directly-running children and the
    // running descendants nested below them (the operator's
    // 2026-09-25 `direct, nested` pair — `◆ 1, 7 subagents` = one
    // running child plus seven running descendants under it). Idle and
    // finished descendants stay out of the indicator; they render in
    // the scoped agents view. The pair rides the label itself (the
    // operator's `◆ x subagents` consolidation) in the dock's running
    // color; a quiet roster keeps the plain zero readout.
    let running_color = |count: usize| {
        if count > 0 {
            ThemeColor::Success
        } else {
            ThemeColor::Muted
        }
    };
    let running = dock.subagents_running_direct + dock.subagents_running_nested;
    let subagents = vec![theme.fg_span(
        running_color(running),
        if running > 0 {
            format!(
                "◆ {}, {} subagents",
                dock.subagents_running_direct, dock.subagents_running_nested
            )
        } else {
            "◆ 0 subagents".to_string()
        },
    )];
    let mut heartbeats = vec![theme.fg_span(
        running_color(dock.heartbeats),
        format!(
            "◷ {} heartbeat{}",
            dock.heartbeats,
            if dock.heartbeats == 1 { "" } else { "s" }
        ),
    )];
    if dock.heartbeats_paused > 0 {
        heartbeats.extend(cluster(
            &format!("◐ {} paused", dock.heartbeats_paused),
            ThemeColor::Warning,
        ));
    }
    let mut groups = vec![
        (ActivityGroup::Subagents, subagents),
        (ActivityGroup::Heartbeats, heartbeats),
        // Only live bash runs count in the dock's indicator (operator
        // scoping); the bash view keeps the finished rows. The label is
        // "shell(s)" (operator directive via #2677): the tool name stays
        // bash() everywhere else.
        (
            ActivityGroup::Bash,
            vec![theme.fg_span(
                running_color(dock.bash_running),
                format!(
                    "▸ {} shell{}",
                    dock.bash_running,
                    if dock.bash_running == 1 { "" } else { "s" }
                ),
            )],
        ),
    ];
    if let Some(goal) = &dock.goal_label {
        // The goal row carries the dock's activity convention: an
        // actively pursued goal reads green, and the paused and
        // budget-limited states read amber (the paused heartbeat
        // cluster's own warning color) — the dock is the goal's one
        // chrome surface, so every live state stays visible.
        let goal_color = if goal.starts_with("Pursuing goal") {
            ThemeColor::Success
        } else {
            ThemeColor::Warning
        };
        groups.push((
            ActivityGroup::Goal,
            vec![theme.fg_span(goal_color, goal.clone())],
        ));
    }
    let mut line = vec![Span::raw(" ")];
    for (index, (group, spans)) in groups.iter().enumerate() {
        if index > 0 {
            line.push(theme.fg_span(ThemeColor::Dim, "  ·  "));
        }
        if dock.focused && dock.selected == *group {
            // The focused group reads as one unit behind a slight green
            // band (the theme's success-panel background — the operator's
            // 2026-09-26 selection directive); each span keeps its own
            // status color, so the selection never repaints the text.
            let band = theme.bg_style(ThemeBg::ToolSuccessBg);
            for span in spans {
                line.push(Span::styled(span.content.clone(), span.style.patch(band)));
            }
        } else {
            for span in spans {
                line.push(span.clone());
            }
        }
    }
    let frame = vec![
        vec![theme.fg_span(ThemeColor::BorderMuted, "─".repeat(width))],
        truncate_spans_to_width(&line, width),
    ];
    Some(frame)
}

/// The footer's tok/sec row (TS `FooterComponent::render` under `/speed`):
/// one dim line — the dock's last row — truncated with no ellipsis when it
/// overflows the width.
pub fn render_speed_footer(text: &str, theme: &Theme, width: usize) -> Line {
    let dim = theme.fg_style(ThemeColor::Dim);
    let text = truncate_to_width(text, width, "");
    vec![Span::styled(text, dim)]
}

/// The editor surface background: `userMessageBg` (TS `getEditorTheme`).
pub fn editor_background(theme: &Theme) -> ratatui::style::Style {
    theme.bg_style(ThemeBg::UserMessageBg)
}

#[cfg(test)]
mod tests {
    #[test]
    fn activity_dock_frames_one_row_with_running_paused_and_goal_counts() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let dock = ActivityDock {
            subagents_running_direct: 1,
            subagents_running_nested: 1,
            heartbeats: 3,
            heartbeats_paused: 1,
            bash_running: 1,
            bash_total: 2,
            goal_label: Some("Pursuing goal (0s)".to_string()),
            ..ActivityDock::default()
        };
        // The heartbeat cluster and the goal label widen the row: the
        // fixture renders at 120 so the full line stays untruncated.
        let frame = render_activity_dock(&dock, &theme, 120).unwrap();
        assert_eq!(frame.len(), 2, "a muted separator rule plus the row");
        let rule = frame[0]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(rule.chars().next(), Some('─'));
        assert_eq!(rule.chars().count(), 120);
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(
            text,
            " ◆ 1, 1 subagents  ·  ◷ 3 heartbeats · ◐ 1 paused  ·  ▸ 1 shell  ·  Pursuing goal (0s)"
        );
        // The color-coding (the operator's 2026-09-24 directive): every
        // above-zero count segment and the active goal render green.
        let success = theme.fg_style(ThemeColor::Success).fg;
        let colored = |text: &str, color| {
            frame[1]
                .iter()
                .any(|span| span.content.contains(text) && span.style.fg == color)
        };
        assert!(colored("◆ 1, 1 subagents", success));
        assert!(colored("◷ 3 heartbeats", success));
        assert!(colored("▸ 1 shell", success));
        assert!(colored("Pursuing goal", success));
        // A paused goal stays on the dock (the tray cluster is gone) in
        // the warning color — every live goal state keeps a surface.
        let dock = ActivityDock {
            subagents_total: 1,
            goal_label: Some("Goal paused (0s)".to_string()),
            ..ActivityDock::default()
        };
        let frame = render_activity_dock(&dock, &theme, 100).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        let warning = theme.fg_style(ThemeColor::Warning).fg;
        assert!(
            text.contains("Goal paused (0s)"),
            "the paused row renders: {text}"
        );
        assert!(
            frame[1]
                .iter()
                .any(|span| span.content.contains("Goal paused") && span.style.fg == warning),
            "the paused goal reads amber"
        );
        // A running count of zero still renders: a long idle roster must
        // read as quiet, not as uniformly busy — and the count segments
        // go neutral at zero.
        let dock = ActivityDock {
            subagents_total: 2,
            heartbeats: 1,
            bash_total: 3,
            ..ActivityDock::default()
        };
        let frame = render_activity_dock(&dock, &theme, 100).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(text, " ◆ 0 subagents  ·  ◷ 1 heartbeat  ·  ▸ 0 shells");
        // A dead-only roster keeps the dock mounted and its Subagents
        // group selectable (finished subagents are browsable history):
        // the rendered count stays running-only and reads zero.
        let dock = ActivityDock {
            subagents_total: 154,
            ..ActivityDock::default()
        };
        let frame = render_activity_dock(&dock, &theme, 100).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(
            text,
            " \u{25c6} 0 subagents  \u{b7}  \u{25f7} 0 heartbeats  \u{b7}  \u{25b8} 0 shells"
        );
        // The zero segments stay neutral, never green.
        assert!(frame[1]
            .iter()
            .all(|span| span.style.fg != theme.fg_style(ThemeColor::Success).fg));
        // Finished-only bash rows keep the dock mounted (the bash view's
        // history stays reachable) while the indicator reads zero live
        // runs.
        let dock = ActivityDock {
            bash_total: 2,
            ..ActivityDock::default()
        };
        let frame = render_activity_dock(&dock, &theme, 100).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(text.contains("▸ 0 shells"));
        assert!(render_activity_dock(&ActivityDock::default(), &theme, 100).is_none());
        // An overflowing row (every group plus the goal) truncates INSIDE
        // the width: the ellipsis reserves its own column, so the row
        // never renders past the terminal frame (the bot-round fix).
        let dock = ActivityDock {
            subagents_running_direct: 1,
            subagents_running_nested: 2,
            heartbeats: 4,
            heartbeats_paused: 2,
            bash_running: 2,
            goal_label: Some("Pursuing goal (12m 05s)".to_string()),
            ..ActivityDock::default()
        };
        for width in 20..=45 {
            let frame = render_activity_dock(&dock, &theme, width).unwrap();
            let row = &frame[1];
            let used = crate::width::spans_width(row);
            assert!(
                used <= width,
                "the truncated row stays inside {width}: {used}"
            );
            let text = row
                .iter()
                .map(|span| span.content.as_str())
                .collect::<String>();
            assert!(
                text.ends_with('\u{2026}'),
                "the truncation carries the ellipsis: {text:?}"
            );
        }
        // A row that fits whole keeps every character — the ellipsis
        // column is only borrowed when truncation actually happens.
        let frame = render_activity_dock(&dock, &theme, 120).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert!(
            !text.contains('\u{2026}'),
            "the untruncated row keeps its characters: {text:?}"
        );
        assert!(text.contains("Pursuing goal (12m 05s)"));
    }

    /// The dock's subagents segment is one consolidated item (the
    /// operator's `◆ x subagents` form, with the 2026-09-25 running
    /// split): the counts are the running pair (direct, then nested),
    /// never the descendant total, and no category breakdown rides the
    /// row.
    #[test]
    fn prompt_bar_subagent_segment_is_the_running_count_only() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        // Two running among seven descendants (one direct child plus one
        // nested worker): the readout is the running pair, not the
        // descendant total and not a category breakdown.
        let dock = ActivityDock {
            subagents_running_direct: 1,
            subagents_running_nested: 1,
            subagents_total: 7,
            ..ActivityDock::default()
        };
        let frame = render_activity_dock(&dock, &theme, 80).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(text, " ◆ 1, 1 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
        assert!(!text.contains("idle"), "no category breakdown: {text}");
        assert!(!text.contains('7'), "the total never renders: {text}");
        // A single running descendant keeps the same shape.
        let dock = ActivityDock {
            subagents_running_direct: 0,
            subagents_running_nested: 1,
            subagents_total: 1,
            ..ActivityDock::default()
        };
        let frame = render_activity_dock(&dock, &theme, 80).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(text, " ◆ 0, 1 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
        // A quiet roster (history but nothing running) keeps the plain
        // zero readout — the pair only renders while work runs.
        let dock = ActivityDock {
            subagents_total: 5,
            ..ActivityDock::default()
        };
        let frame = render_activity_dock(&dock, &theme, 80).unwrap();
        let text = frame[1]
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(text, " ◆ 0 subagents  ·  ◷ 0 heartbeats  ·  ▸ 0 shells");
    }

    /// The focused dock's selection reads as a slight green band behind
    /// the selected group (the operator's 2026-09-26 directive), never as
    /// an accent text repaint: the band is the theme's success-panel
    /// background across exactly the group's spans, and each span keeps
    /// its own status color.
    #[test]
    fn activity_dock_selection_is_a_slight_green_band_not_accent_text() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let dock = ActivityDock {
            subagents_running_direct: 1,
            subagents_running_nested: 1,
            subagents_total: 2,
            heartbeats: 3,
            heartbeats_paused: 1,
            bash_running: 1,
            bash_total: 2,
            goal_label: Some("Pursuing goal (0s)".to_string()),
            selected: ActivityGroup::Heartbeats,
            focused: true,
        };
        let frame = render_activity_dock(&dock, &theme, 120).unwrap();
        let row = &frame[1];
        // The band is the theme's slight green panel background (prime:
        // #0e1510 — green-leaning), never the accent.
        let band = Some(Color::Rgb(0x0e, 0x15, 0x10));
        assert_eq!(theme.bg_style(ThemeBg::ToolSuccessBg).bg, band);
        let span = |text: &str| {
            row.iter()
                .find(|span| span.content == text)
                .unwrap_or_else(|| panic!("missing span {text:?}"))
        };
        // The whole selected group carries the band while keeping its
        // own status colors: the running count stays success green, the
        // paused cluster stays amber, the in-group separator stays dim.
        let success = theme.fg_style(ThemeColor::Success).fg;
        let warning = theme.fg_style(ThemeColor::Warning).fg;
        let dim = theme.fg_style(ThemeColor::Dim).fg;
        assert_eq!(span("\u{25f7} 3 heartbeats").style.bg, band);
        assert_eq!(span("\u{25f7} 3 heartbeats").style.fg, success);
        assert_eq!(span(" \u{b7} ").style.bg, band);
        assert_eq!(span(" \u{b7} ").style.fg, dim);
        assert_eq!(span("\u{25d0} 1 paused").style.bg, band);
        assert_eq!(span("\u{25d0} 1 paused").style.fg, warning);
        // The band rides exactly the selected group: the other groups
        // and the separators between them carry no band.
        let selected = ["\u{25f7} 3 heartbeats", " \u{b7} ", "\u{25d0} 1 paused"];
        for span in row {
            assert_eq!(
                span.style.bg == band,
                selected.contains(&span.content.as_str()),
                "the band rides exactly the selected group: {:?}",
                span.content
            );
        }
        // No purple on selection: the accent color never rides the row.
        let accent = theme.fg_style(ThemeColor::Accent).fg;
        assert!(row.iter().all(|span| span.style.fg != accent));
        // The band is a focus-owned signal: the same dock without focus
        // renders no band at all.
        let unfocused = ActivityDock {
            focused: false,
            ..dock
        };
        let frame = render_activity_dock(&unfocused, &theme, 120).unwrap();
        assert!(frame[1].iter().all(|span| span.style.bg.is_none()));
    }

    /// The `/speed` footer row (TS `FooterComponent::render`): one dim row
    /// with the readout, truncated with no ellipsis when it overflows.
    #[test]
    fn speed_footer_is_one_dim_row_truncated_to_width() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let row = render_speed_footer("188 tok/s · avg 200", &theme, 100);
        let text = row
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(text, "188 tok/s · avg 200");
        assert_eq!(row.len(), 1);
        let narrow = render_speed_footer("188 tok/s · avg 200", &theme, 10);
        let text = narrow
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        assert_eq!(text.chars().count(), 10);
        assert!(!text.contains("…"));
    }

    use super::*;
    use crate::theme::{ColorMode, Theme};
    use ratatui::style::Color;

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

    /// The tray (the line below the prompt bar) never carries the goal
    /// label (the operator's 2026-09-24 directive: "pursuing goal should
    /// not show up in the line below prompt bar") — the goal lives in
    /// the activity dock below, and the tray joins model straight to
    /// context.
    #[test]
    fn tray_never_repeats_the_heartbeat_counts() {
        let state = ChromeState {
            show_manage: true,
            model_id: Some("mock-1".to_string()),
            context: Some(ContextUsage {
                tokens: 190,
                context_window: 128_000,
            }),
            ..Default::default()
        };
        let line = render_tray(&state, &theme(), 120);
        let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
        assert!(text.contains("mock-1 \u{b7} 190 (0%)"));
        assert!(!text.contains("Pursuing goal"));
        assert!(!text.contains("goal"));
        assert!(!text.contains("heartbeat"));
        assert!(!text.contains("Ctrl+R"));
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
