//! Chat chrome: the pinned top bar, brand splash header, prompt context
//! line, and the tray line under the editor. Ports the TS components
//! `top-bar.ts`, `BrandSplashHeader` (interactive-mode.ts), and
//! `subagent-summary-line.ts` row layout.

use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::Style;
use serde_json::Value;

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
    /// The current model's provider (the daemon state's `model.provider`),
    /// when the session reports one: the picker matches the current-model
    /// catalog entry by provider plus id — two providers can carry the
    /// same id, and only the provider disambiguates them.
    pub model_provider: Option<String>,
    /// Extra metadata lines under the splash (`label value` each; e.g. the
    /// agents view's `agents N running, ...` count row and, in scoped
    /// mode, the `depth N` row). Empty renders none.
    pub extra_metadata: Vec<(String, String)>,
    /// Top-bar chat name (session name or the cwd basename).
    pub chat_name: String,
    /// Session spend (USD) beside the chat name: the family rollup
    /// (the session's own whole-file spend plus every subagent
    /// descendant's — the same number the agents view bills the row).
    pub cost_usd: Option<f64>,
    /// Context usage: tokens, window, percent (tray right label).
    pub context: Option<ContextUsage>,
    /// `← manage` hint: shown for persisted (attachable) sessions.
    pub show_manage: bool,
    /// The attached session's RLM depth (TS `formatAgentDepthLabel`): a
    /// subagent session renders `depth N` after the manage hint; a root
    /// session (depth 0 or unknown) renders none.
    pub tray_depth: Option<u32>,
    /// Thinking effort suffix rendered as `model:effort` in the tray (TS
    /// `getModelContextLabel`); `None` keeps the bare model id.
    pub thinking_suffix: Option<String>,
    /// The session's effective service tier as its wire name (TS
    /// `connectionState.serviceTier`): the tray badge after the model —
    /// `fast` for priority, the tier name for any other non-default tier.
    /// `None` (or `default`) renders no badge.
    pub service_tier: Option<String>,
    /// Startup warning (tmux keyboard setup), rendered as a status row.
    pub tmux_notice: Option<String>,
    /// Tray override label (TS `getTrayOverrideLabel`): while the Ctrl+C
    /// exit hint is armed, it replaces the tray's location label.
    pub tray_override: Option<String>,
    /// The compact, borderless activity dock under the editor: a live
    /// session always mounts it; `None` means no session owns this
    /// view (the replay and app surfaces).
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

/// Which actionable group owns the activity-dock selection. Every
/// group is arrow-traversable whether or not it has rows (the
/// operator's 2026-09-26 muscle-memory directive): emptiness never
/// removes a group from the cycle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ActivityGroup {
    #[default]
    Subagents,
    Heartbeats,
    Bash,
    /// The factory page: live factory runs. Its group renders exactly
    /// while the daemon advertises the `factory_activity` lane (the
    /// opt-in gate; an advertised empty one reads its zero count) and
    /// opens the factory page over the lane — the same navigation family
    /// as the subagents, heartbeats, and shells pages.
    Factory,
    /// The active goal: its group is mounted while a goal is being
    /// pursued and opens the read-only goal panel (the objective and
    /// its facts); a goal that ended unmounts the row with it.
    Goal,
}

/// Which way an arrow key steps along the dock's rendered groups.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityDirection {
    /// The left arrow: the previous group, wrapping past the first.
    Prev,
    /// The right arrow: the next group, wrapping past the last.
    Next,
}

/// The bottom activity dock: it renders in every session, the all-zero
/// row included (the operator's 2026-09-28 directive; TS
/// `SubagentSummaryLine` renders nothing at zero, a sanctioned
/// divergence).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActivityDock {
    /// The directly-running children right now (one addend of the
    /// dock's single running total).
    pub subagents_running_direct: usize,
    /// The further running descendants below them (subagents of
    /// subagents): the total's other addend. Idle and dead registry
    /// rows never count — they render in the scoped agents view.
    pub subagents_running_nested: usize,
    /// The CURRENT session's heartbeats (nested sessions' jobs do not
    /// surface here, operator scoping).
    pub heartbeats: usize,
    /// How many of the scoped heartbeats are paused.
    pub heartbeats_paused: usize,
    /// Bash processes actively running right now (the current session's
    /// kernel registry only): finished runs never inflate the indicator
    /// — they stay as rows inside the bash view.
    pub bash_running: usize,
    /// Factory runs actively live right now (a live state — running,
    /// stopping, or paused — or a terminal run whose children are still
    /// in flight, the residents teardown; the current session's kernel
    /// registry only): fully terminal runs never inflate the indicator,
    /// exactly like the bash group's running-only count.
    pub factory_runs: usize,
    /// Whether the factory group renders at all: the daemon's
    /// `factory_activity` advertisement (the factory's opt-in gate —
    /// `factory.enabled`, off by default). A daemon without the lane
    /// mounts no factory group anywhere: no row, no traversal, no
    /// click, no page.
    pub factory_group: bool,
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
    /// The groups this dock renders, left to right — the arrow
    /// traversal order. The subagents, heartbeats, and shells groups
    /// always render (an empty one reads its zero count and stays
    /// traversable); the factory group renders exactly while the daemon
    /// advertises the `factory_activity` lane (the opt-in gate), and the
    /// goal group exactly while a live goal keeps its row mounted.
    #[must_use]
    pub fn groups(&self) -> Vec<ActivityGroup> {
        let mut groups = vec![
            ActivityGroup::Subagents,
            ActivityGroup::Heartbeats,
            ActivityGroup::Bash,
        ];
        if self.factory_group {
            groups.push(ActivityGroup::Factory);
        }
        if self.goal_label.is_some() {
            groups.push(ActivityGroup::Goal);
        }
        groups
    }

    /// One arrow step along the rendered groups: the neighbor in
    /// `direction`, wrapping at the row's ends. A group's emptiness
    /// never skips it, so the cycle is deterministic — N rendered
    /// groups take N presses to return to the start. A `current` that
    /// no longer renders (a goal group whose row unmounted) steps
    /// from the row's start.
    #[must_use]
    pub fn step(&self, current: ActivityGroup, direction: ActivityDirection) -> ActivityGroup {
        let groups = self.groups();
        let len = groups.len();
        let position = groups
            .iter()
            .position(|group| *group == current)
            .unwrap_or(0);
        let neighbor = match direction {
            ActivityDirection::Prev => position + len - 1,
            ActivityDirection::Next => position + 1,
        };
        groups[neighbor % len]
    }
}

/// Context usage for the tray label (`N (P%)`).
#[derive(Debug, Clone, Copy)]
pub struct ContextUsage {
    pub tokens: u64,
    pub context_window: u64,
}

impl ContextUsage {
    #[must_use]
    pub fn percent(&self) -> f64 {
        if self.context_window == 0 {
            0.0
        } else {
            (self.tokens as f64 / self.context_window as f64) * 100.0
        }
    }
}

/// `formatTokenCount` (agent-activity.ts): 999, 1.0k-9.9k, 10k, 1.2M.
#[must_use]
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
#[must_use]
pub fn display_name(cwd: &str) -> String {
    std::path::Path::new(cwd).file_name().map_or_else(
        || cwd.to_string(),
        |name| name.to_string_lossy().to_string(),
    )
}

/// The `~`-compressed cwd for the splash line (TS `formatSplashCwd`).
#[must_use]
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
#[must_use]
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
#[must_use]
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
#[must_use]
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
#[must_use]
pub fn render_tray(state: &ChromeState, theme: &Theme, width: usize) -> Line {
    render_tray_with_hint(state, theme, width).0
}

/// The tray row plus the `← manage` hint's column span (the click
/// surface's region: a plain click on the hint's own cells performs
/// the hinted action — the left arrow's agents-back handoff, operator
/// directive 2026-09-29). `None` when the left label is the override
/// or the hint is hidden: the tray keeps no region then.
#[must_use]
pub fn render_tray_with_hint(
    state: &ChromeState,
    theme: &Theme,
    width: usize,
) -> (Line, Option<std::ops::Range<usize>>) {
    let dim = theme.fg_style(ThemeColor::Dim);
    let muted = theme.fg_style(ThemeColor::Muted);
    let mut hint: Option<std::ops::Range<usize>> = None;
    let mut left: Line = Vec::new();
    if let Some(override_label) = &state.tray_override {
        // TS `renderInfoLine`: the override label replaces the location
        // label on the left while it is set.
        left.push(Span::styled(override_label.clone(), muted));
    } else if state.show_manage {
        left.push(Span::styled("\u{2190}".to_string(), dim));
        left.push(Span::styled(" manage".to_string(), muted));
        // The hint's own cells — the two spans just pushed — are the
        // clickable region; the depth label that may follow is the
        // session's metadata, not part of the hinted action.
        hint = Some(0..left.iter().map(|s| str_width(&s.content)).sum());
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
    // TS footer badge (#2144): `fast` for the priority tier, the tier name
    // for any other non-default tier.
    let tier_badge = match state.service_tier.as_deref() {
        Some("priority") => Some("fast"),
        Some(tier) if tier != "default" => Some(tier),
        _ => None,
    };
    if let Some(badge) = tier_badge {
        if !right.is_empty() {
            right.push(Span::styled(" \u{00b7} ".to_string(), dim));
        }
        right.push(Span::styled(badge.to_string(), dim));
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
    (line, hint)
}

/// The tray model label's thinking-effort suffix (TS `getModelContextLabel`:
/// `model.reasoning ? connectionState.thinkingLevel : undefined` — a model
/// without reasoning renders the bare id, and so does a level outside the
/// wire vocabulary, which TS would render raw). The state's level parses
/// to its wire name, so the suffix is always one of the TS `ThinkingLevel`
/// strings, including "off" when the session explicitly turned thinking
/// off — the tray shows `model:off` like TS; only the agents-view Model
/// column hides "off" (`formatSessionModel`).
pub(crate) fn tray_thinking_suffix(state: &Value) -> Option<String> {
    let reasoning = state
        .get("model")
        .and_then(|model| model.get("reasoning"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !reasoning {
        return None;
    }
    state
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .and_then(pa_types::ai::thinking_level_from_str)
        .map(|level| level.wire_name().to_string())
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
/// the actionable groups — the row renders in every session, all-zero
/// included. The TS summary line wraps its content in an
/// accent-colored box (`╭─ subagents ─╮`); the inline design language
/// keeps the separation with the same muted `─` rule that frames the
/// pickers' search fields, not an accent box.
///
/// The row color-codes live activity (the operator's 2026-09-24
/// directive): every count-holding segment goes green while its count
/// is above zero (subagents, heartbeats, shells, factory, the active
/// goal) and stays neutral at zero. The subagents segment is one
/// consolidated item — `◆ x subagents` (the operator's 2026-09-25
/// consolidation: the separate running cluster was redundant).
#[must_use]
pub fn render_activity_dock(dock: &ActivityDock, theme: &Theme, width: usize) -> Vec<Line> {
    render_activity_dock_segments(dock, theme, width).0
}

/// One rendered group segment's column span on the dock's row (the
/// click surface's region: a plain click on the group's own cells
/// opens that group's view, the dock's Enter route — operator
/// directive 2026-09-29, the hover + click affordance pass).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityDockSegment {
    pub group: ActivityGroup,
    /// The row columns the group's spans occupy, start inclusive, end
    /// exclusive.
    pub cols: std::ops::Range<usize>,
}

/// The framed activity dock plus its groups' column segments (see
/// [`render_activity_dock`] for the row itself): the segments cover
/// exactly the cells each group renders — separators between groups
/// stay inert — clamped to the row the truncation actually kept.
#[must_use]
pub fn render_activity_dock_segments(
    dock: &ActivityDock,
    theme: &Theme,
    width: usize,
) -> (Vec<Line>, Vec<ActivityDockSegment>) {
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
    // right now, direct children and nested descendants together (the
    // operator's 2026-09-28 ask: ONE number, never the `direct,
    // nested` pair of the 2026-09-25 split — `◆ 9 subagents` is two
    // running children plus seven running descendants under them).
    // Idle and finished descendants stay out of the indicator; they
    // render in the scoped agents view. The total rides the label in
    // the dock's running color; a quiet roster keeps the plain zero
    // readout.
    let running_color = |count: usize| {
        if count > 0 {
            ThemeColor::Success
        } else {
            ThemeColor::Muted
        }
    };
    let running = dock.subagents_running_direct + dock.subagents_running_nested;
    // The row and the arrows share one group order (`groups()`): a
    // group renders exactly when it stays traversable, so the focused
    // selection never binds to a hidden segment and no group can be
    // skipped by its emptiness.
    let groups = dock.groups();
    let mut line = vec![Span::raw(" ")];
    let mut segments: Vec<ActivityDockSegment> = Vec::new();
    for (index, group) in groups.iter().copied().enumerate() {
        if index > 0 {
            line.push(theme.fg_span(ThemeColor::Dim, "  ·  "));
        }
        // The group's cells start where the row now stands: the
        // segment's column span is what the terminal will paint (the
        // truncation below clamps its end).
        let start = line.iter().map(|s| str_width(&s.content)).sum();
        let spans = match group {
            ActivityGroup::Subagents => {
                vec![theme.fg_span(running_color(running), format!("◆ {running} subagents"))]
            }
            ActivityGroup::Heartbeats => {
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
                heartbeats
            }
            // Only live bash runs count in the dock's indicator (operator
            // scoping); the bash view keeps the finished rows. The label is
            // "shell(s)" (operator directive via #2677): the tool name stays
            // bash() everywhere else.
            ActivityGroup::Bash => vec![theme.fg_span(
                running_color(dock.bash_running),
                format!(
                    "▸ {} shell{}",
                    dock.bash_running,
                    if dock.bash_running == 1 { "" } else { "s" }
                ),
            )],
            // The factory page's indicator counts live runs only
            // (running, stopping, paused): done and failed runs stay as
            // panels inside the factory page, never in the indicator.
            ActivityGroup::Factory => vec![theme.fg_span(
                running_color(dock.factory_runs),
                format!("⚙ {} factory", dock.factory_runs),
            )],
            // The goal row carries the dock's activity convention: an
            // actively pursued goal reads green, and the paused and
            // budget-limited states read amber (the paused heartbeat
            // cluster's own warning color) — the dock is the goal's one
            // chrome surface, so every live state stays visible.
            ActivityGroup::Goal => {
                let goal = dock.goal_label.as_deref().unwrap_or_default();
                let goal_color = if goal.starts_with("Pursuing goal") {
                    ThemeColor::Success
                } else {
                    ThemeColor::Warning
                };
                vec![theme.fg_span(goal_color, goal.to_string())]
            }
        };
        if dock.focused && dock.selected == group {
            // The focused group reads as one unit behind the ONE shared
            // selection band (the operator's 2026-09-29 one-color
            // ruling: the same light band the hover paints, the same
            // style every activity surface's selected row paints);
            // each span keeps its own status color, so the selection
            // never repaints the text.
            let band = theme.selection_row_style();
            for span in spans {
                line.push(Span::styled(span.content.clone(), span.style.patch(band)));
            }
        } else {
            for span in spans {
                line.push(span);
            }
        }
        let end = line.iter().map(|s| str_width(&s.content)).sum();
        segments.push(ActivityDockSegment {
            group,
            cols: start..end,
        });
    }
    let row = truncate_spans_to_width(&line, width);
    let rendered = row
        .iter()
        .map(|s| str_width(&s.content))
        .sum::<usize>()
        .min(width);
    // The truncation may cut a trailing group's tail or drop it whole:
    // a segment that no longer renders stays out of the click surface,
    // and a partially kept one ends at the row's last painted column.
    let segments = segments
        .into_iter()
        .filter(|segment| segment.cols.start < rendered)
        .map(|mut segment| {
            segment.cols.end = segment.cols.end.min(rendered);
            segment
        })
        .collect();
    (
        vec![
            vec![theme.fg_span(ThemeColor::BorderMuted, "─".repeat(width))],
            row,
        ],
        segments,
    )
}

/// The footer's tok/sec row (TS `FooterComponent::render` under `/speed`):
/// one dim line — the dock's last row — truncated with no ellipsis when it
/// overflows the width.
#[must_use]
pub fn render_speed_footer(text: &str, theme: &Theme, width: usize) -> Line {
    let dim = theme.fg_style(ThemeColor::Dim);
    let text = truncate_to_width(text, width, "");
    vec![Span::styled(text, dim)]
}

/// The editor surface background: `userMessageBg` (TS `getEditorTheme`).
#[must_use]
pub fn editor_background(theme: &Theme) -> ratatui::style::Style {
    theme.bg_style(ThemeBg::UserMessageBg)
}
#[cfg(test)]
mod tests;
