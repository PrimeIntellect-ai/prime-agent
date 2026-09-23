//! Transcript component rendering: status rows, the user-message block,
//! assistant messages (text, thinking, and their error rows), and the
//! working loader line. Ports the TS chat components' row geometry:
//! `user-message.ts` (Box 2x1 on `userMessageBg`), `assistant-message.ts`
//! block spacers, and `loader.ts` (`Loader` + `agent-activity.ts` labels).
//! Tool-call cards live in `crate::tool_card`.

mod geometry;
pub(crate) use geometry::{assistant_row_count, user_block_row_count};

use crate::snapshot::RetryStartReason;
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::Style;

/// How much detail the conversation shows (TS `setChatDetail` levels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    /// `overview`: thinking hidden, tool output and edit diffs collapsed.
    Overview,
    /// `details`: thinking visible, edit diffs expanded, tool output collapsed.
    Details,
    /// `all`: thinking visible, edit diffs and tool output expanded.
    All,
}

impl Detail {
    /// The Ctrl+O cycle (TS `toggleToolOutputExpansion`): overview adds
    /// details, details adds the expanded output, all wraps to overview.
    pub fn next(self) -> Self {
        match self {
            Detail::Overview => Detail::Details,
            Detail::Details => Detail::All,
            Detail::All => Detail::Overview,
        }
    }

    /// Thinking blocks render (TS `hideThinkingBlock = detail === "overview"`).
    pub fn show_thinking(self) -> bool {
        !matches!(self, Detail::Overview)
    }

    /// Tool output expands (TS `toolOutputExpanded = detail === "all"`).
    pub fn tool_output_expanded(self) -> bool {
        matches!(self, Detail::All)
    }

    /// Edit diffs expand (TS `editDiffsExpanded = detail !== "overview"`).
    pub fn edit_diffs_expanded(self) -> bool {
        !matches!(self, Detail::Overview)
    }
}

/// One rendered chat component.
#[derive(Debug, Clone, PartialEq)]
/// The style tier of a status row (TS `showStatus`/`showWarning`/`showError`).
pub enum StatusKind {
    /// Muted informational note.
    Info,
    /// Warning highlight.
    Warning,
    /// Error highlight.
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatEntry {
    /// `showStatus` / `showWarning` / `showError` rows (startup notices,
    /// client notes, turn errors).
    Status { text: String, kind: StatusKind },
    /// The user's submitted prompt.
    User { text: String },
    /// A durable session-command echo row (`session_slash_command`):
    /// the command as typed, laid out like a user message.
    SlashCommand { text: String },
    /// A durable session-command outcome row (`session_slash_command_result`).
    SlashCommandResult { content: String },
    /// The compaction summary row (TS `CompactionSummaryMessageComponent`):
    /// `◆ Context compacted` with the summary below.
    CompactionSummary {
        /// The summarizer's summary text.
        summary: String,
        /// The context size before the compaction (the expanded metadata).
        tokens_before: u64,
        /// `/compact <instructions>` focus guidance.
        custom_instructions: Option<String>,
    },
    /// One assistant message: ordered content blocks.
    Assistant(Box<AssistantMessage>),
    /// One tool call and its execution state (rendered by
    /// [`crate::tool_card`]).
    Tool(Box<ToolCallCard>),
    /// One agent-message summary row (TS `AgentMessageComponent`: the
    /// received transcript rows).
    AgentMessage(Box<crate::custom_message::AgentMessageRow>),
    /// One skill-invocation card (TS `SkillInvocationMessageComponent`):
    /// the expandable `<skill>`-block card a user message carrying a
    /// skill invocation parses into (the trailing arguments render as the
    /// user block that follows it).
    SkillInvocation(Box<crate::custom_message::SkillInvocationRow>),
    /// One injected prompt row (TS `InjectedPromptMessageComponent`).
    InjectedPrompt(Box<crate::custom_message::InjectedPromptRow>),
    /// One `!`/`!!` bash run (TS `BashExecutionComponent`): the bordered
    /// card the live `bash_start`/`bash_output`/`bash_end` events, the
    /// replayed `bashExecution` row, and the pending-while-streaming hold
    /// all render through.
    BashExecution(Box<crate::bash_card::BashExecutionCard>),
    /// One background-shell completion row (TS `ShellCompletionComponent`).
    ShellCompletion(Box<crate::custom_message::ShellCompletionRow>),
    /// One refinement outcome row (TS `RefinementOutcomeMessageComponent`).
    RefinementOutcome(Box<crate::custom_message::RefinementOutcomeRow>),
    /// One generic custom row (TS `CustomMessageComponent` box).
    CustomPanel(Box<crate::custom_message::CustomPanelRow>),
    /// A client-side markdown block appended to the chat (TS
    /// `chatContainer.addChild(new Markdown(...))`, e.g. the `/hotkeys`
    /// guide): not a durable session row.
    ClientMarkdown { text: String },
    /// A client-side info block (TS `chatContainer.addChild(new
    /// Spacer(1))` + `new Text(info, 1, 0)`, e.g. the `/session`,
    /// `/context`, `/system-prompt`, and `/logs` displays): not a durable
    /// session row.
    ClientText {
        rows: Vec<crate::info_commands::ClientLine>,
    },
    /// The `/changelog` panel (TS `handleChangelogCommand`): the border,
    /// `What's New` title, and the entries markdown. Not a durable
    /// session row.
    ChangelogPanel { markdown: String },
}

// The card types live in `tool_card`; re-exported here because the
// transcript vocabulary (`ChatEntry`) is this module's.
pub use crate::tool_card::{render_tool_card, ToolCallCard, ToolResultView};
// The compaction rows (loader + summary) live in `compaction_row`; same
// re-export rule as the tool cards.
pub use crate::compaction_row::{
    render_compaction_loader, render_compaction_summary, CompactionReason, CompactionState,
};

/// An assistant message's visible content (tool calls move to cards).
#[derive(Debug, Clone, PartialEq)]
pub struct AssistantMessage {
    pub blocks: Vec<MessageBlock>,
    /// `toolUse` when the message carried tool calls (drives spacers).
    pub has_tool_calls: bool,
    /// The message is still streaming (an update may replace its blocks).
    pub streaming: bool,
    /// A failed assistant message's error row (TS renders abort and error
    /// text inside the message component): `aborted` always renders,
    /// `error` only without tool calls (their cards carry the failure).
    pub error: Option<String>,
    /// `stopReason: "aborted"` (drives the tool-call trailing spacer).
    pub aborted: bool,
}

impl AssistantMessage {
    /// TS `AssistantMessageComponent.hasTrailingSpace`: the tool-call
    /// separator renders for visible bodies, aborted messages, and messages
    /// not following tool activity (the same condition `render_assistant`
    /// applies).
    pub fn has_trailing_space(&self, detail: Detail, preceded_by_tool_activity: bool) -> bool {
        let has_visible_content = self.blocks.iter().any(|block| match block {
            MessageBlock::Thinking(text) => detail.show_thinking() && !text.trim().is_empty(),
            MessageBlock::Text(text) => !text.trim().is_empty(),
        });
        self.has_tool_calls && (has_visible_content || self.aborted || !preceded_by_tool_activity)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum MessageBlock {
    Thinking(String),
    Text(String),
}

/// The working loader (TS `Loader`): spinner + activity label, or a
/// tool-owned working message while one is set (TS `workingMessage`).
#[derive(Debug, Clone, PartialEq)]
pub struct WorkingState {
    pub activity: &'static str,
    /// A transient message owned by the running tool (TS
    /// `workingMessage`, set by the python-kernel bootstrap): replaces the
    /// activity label and the token count until the tool clears it.
    pub message: Option<String>,
    /// Streaming direction: `true` while tokens flow down.
    pub download: bool,
    pub tokens: u64,
    /// Whole seconds since the loader started.
    pub elapsed_secs: u64,
}

/// TS `message_end`'s aborted arm: the live abort row's text — the retry
/// count and the working-elapsed suffix ride the client, never the wire
/// (the rebuild path keeps the stored "Operation aborted").
pub fn live_abort_text(retry_attempt: u32, elapsed_secs: Option<u64>) -> String {
    let elapsed_suffix = elapsed_secs
        .map(|secs| format!(" \u{00b7} {}", format_working_elapsed(secs)))
        .unwrap_or_default();
    if retry_attempt > 0 {
        format!(
            "Aborted after {retry_attempt} retry attempt{}{elapsed_suffix}",
            if retry_attempt > 1 { "s" } else { "" }
        )
    } else {
        format!("Operation aborted{elapsed_suffix}")
    }
}

/// TS `formatWorkingElapsed`: "3s", "1m 05s", "1h 02m 03s", "1d 02h 03m 04s".
pub fn format_working_elapsed(total_secs: u64) -> String {
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let hours = total_mins / 60;
    if total_mins == 0 {
        return format!("{secs}s");
    }
    if hours == 0 {
        return format!("{mins}m {:02}s", secs);
    }
    let days = hours / 24;
    if days == 0 {
        return format!("{hours}h {mins:02}m {secs:02}s");
    }
    format!("{days}d {:02}h {mins:02}m {secs:02}s", hours % 24)
}

impl WorkingState {
    pub fn label(&self) -> String {
        // Extensions and tool bootstrap own the message: plain
        // "<message> <elapsed>" (TS `getWorkingLoaderMessage`).
        if let Some(message) = &self.message {
            return format!("{message} {}", format_working_elapsed(self.elapsed_secs));
        }
        let mut parts = vec![self.activity.to_string()];
        parts.push(format_working_elapsed(self.elapsed_secs));
        if self.tokens > 0 {
            parts.push(format!(
                "{} {} tokens",
                if self.download {
                    "\u{2193}"
                } else {
                    "\u{2191}"
                },
                crate::chrome::format_token_count(self.tokens)
            ));
        }
        parts.join(" \u{00b7} ")
    }
}

/// Spinner frames (TS `Loader` DEFAULT_FRAMES).
pub(crate) const LOADER_FRAMES: [&str; 10] = [
    "\u{280b}", "\u{2819}", "\u{2839}", "\u{2838}", "\u{283c}", "\u{2834}", "\u{2826}", "\u{2827}",
    "\u{2807}", "\u{280f}",
];

/// The working pulse icon frames (TS `theme/working-icon.ts`
/// `WORKING_ICON_FRAMES`, 250ms interval): the shared "still working"
/// marker across the agents view, the subagent tray, and in-progress
/// tool markers.
pub const WORKING_ICON_FRAMES: [&str; 4] = ["\u{25c7}", "\u{25c8}", "\u{25c6}", "\u{25c8}"];

pub fn working_icon_frame(frame: usize) -> &'static str {
    WORKING_ICON_FRAMES[frame % WORKING_ICON_FRAMES.len()]
}

/// A blank line (`Spacer(1)`).
fn spacer() -> Line {
    Vec::new()
}

/// Pad a rendered line to the full width with a base style.
pub(crate) fn pad_to(line: Line, width: usize, base: Style) -> Line {
    let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
    let mut out = line;
    if used < width {
        out.push(Span::styled(" ".repeat(width - used), base));
    }
    out
}

/// Render a status text (TS `Text` with paddingX=1, paddingY=0): wrapped at
/// `width - 2`, one leading margin column, padded to the full width.
pub fn render_text_rows(text: &str, style: Style, width: usize) -> Vec<Line> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let content_width = width.saturating_sub(2).max(1);
    let wrapped = crate::width::wrap_text(text, content_width);
    let row_count = wrapped.len();
    let mut out = Vec::new();
    for (index, line) in wrapped.into_iter().enumerate() {
        // The TS Text component prepends the margin outside the styled
        // content: the margin itself keeps the default foreground. Wrapped
        // rows keep the ANSI state open through their trailing padding (the
        // closing reset lands on the final wrapped row), so continuation
        // rows pad with the row style.
        let mut row: Line = vec![Span::raw(" ")];
        let styled: Line = line
            .into_iter()
            .map(|span| Span::styled(span.content, style))
            .collect();
        row.extend(styled);
        let padding_style = if index + 1 < row_count {
            style
        } else {
            Style::default()
        };
        out.push(pad_to(row, width, padding_style));
    }
    if out.is_empty() {
        out.push(vec![Span::styled(" ".repeat(width), Style::default())]);
    }
    out
}

/// The user-message block (TS `UserMessageComponent`: Box(2,1) on
/// `userMessageBg`, markdown inside colored `userMessageText`). The
/// prompt-highlight tokens (the accent command segment of a recognized
/// leading slash command, the `@path`/`--flag` argument tokens) render in
/// their own colors: TS masks them to same-width placeholders before the
/// markdown layout and restores them after, so markdown cannot wrap,
/// emphasize, or eat them (`HighlightedMarkdown` + `PromptTokenMask`).
pub fn render_user_block(
    text: &str,
    theme: &Theme,
    code_block_indent: &str,
    width: usize,
) -> Vec<Line> {
    let bg = theme.bg_style(ThemeBg::UserMessageBg);
    let content_width = width.saturating_sub(4).max(1);
    let body = theme.fg_style(ThemeColor::UserMessageText);
    let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
    md.code_block_indent = code_block_indent.to_string();
    let mask = geometry::user_mask(text);
    let rendered = crate::markdown::render_markdown(&mask.text, content_width, &md);
    let mut rows: Vec<Line> = Vec::new();
    let blank = vec![Span::styled(" ".repeat(width), bg)];
    rows.push(blank.clone());
    if rendered.is_empty() {
        let row = vec![
            Span::styled("  ".to_string(), bg),
            Span::styled("".to_string(), body),
        ];
        rows.push(pad_to(row, width, bg));
    }
    for line in rendered {
        let mut row: Line = vec![Span::styled("  ".to_string(), bg)];
        // The user block colors everything `userMessageText` on the block
        // background; markdown structure (wrapping) is kept, its own colors
        // are not. The masked placeholders restore to their token colors
        // over that base.
        let restyled: Line = line
            .into_iter()
            .map(|span| Span::styled(span.content, bg.patch(body)))
            .collect();
        row.extend(mask.restore_line(theme, &restyled));
        rows.push(pad_to(row, width, bg));
    }
    rows.push(blank);
    // Zone markers: `A` on the first block row, `B`/`C` on the last (TS
    // `UserMessageComponent.render`).
    if let Some(first) = rows.first_mut() {
        crate::osc133::mark_start(first);
    }
    if let Some(last) = rows.last_mut() {
        crate::osc133::mark_end(last);
    }
    rows
}

/// One assistant message (TS `AssistantMessageComponent`): a leading spacer
/// when a visible body exists, markdown blocks separated by spacers (text in
/// `mdBody`, thinking in `dim`), and a trailing spacer before its tool calls.
pub fn render_assistant(
    message: &AssistantMessage,
    detail: Detail,
    theme: &Theme,
    code_block_indent: &str,
    width: usize,
    preceded_by_tool_activity: bool,
    cache: &mut crate::markdown::MarkdownBlockCache,
) -> Vec<Line> {
    let visible_blocks = geometry::visible_blocks(message, detail);
    let has_visible_content = !visible_blocks.is_empty();
    let mut out: Vec<Line> = Vec::new();
    if has_visible_content {
        out.push(spacer());
    }
    let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
    md.code_block_indent = code_block_indent.to_string();
    for (index, block) in visible_blocks.iter().enumerate() {
        match block {
            MessageBlock::Text(text) => {
                out.extend(render_markdown_block(text, &md, width, cache));
            }
            MessageBlock::Thinking(text) => {
                out.extend(render_thinking_block(text, theme, &md, width, cache));
                // Thinking adds spacing only when another visible block follows.
                if index + 1 < visible_blocks.len() {
                    out.push(spacer());
                }
            }
        }
    }
    if let Some(error) = &message.error {
        out.push(spacer());
        // TS `createErrorComponent`: an error whose text ends with the
        // login-recovery suffix renders as one merged inline line.
        let merged = crate::error_summary::format_inline_login_recovery_message(error);
        out.extend(crate::error_summary::render_collapsible_error(
            merged.as_deref().unwrap_or(error),
            None,
            detail.tool_output_expanded(),
            ThemeColor::Error,
            theme,
            width,
        ));
    }
    // TS `AssistantMessageComponent.hasTrailingSpace`: the tool-call
    // separator renders for visible bodies, aborted messages, and messages
    // not following tool activity.
    if geometry::trailing_space(message, has_visible_content, preceded_by_tool_activity) {
        out.push(spacer());
    }
    // Zone markers on message bodies without tool calls (TS
    // `AssistantMessageComponent.render`: tool-call messages return
    // unmarked).
    if !message.has_tool_calls {
        if let Some(first) = out.first_mut() {
            crate::osc133::mark_start(first);
        }
        if let Some(last) = out.last_mut() {
            crate::osc133::mark_end(last);
        }
    }
    out
}

/// Markdown rows with TS margins: rendered at `width - 2`, one leading margin
/// column, padded to the full width.
pub(crate) fn render_markdown_block(
    text: &str,
    md: &crate::markdown::MarkdownStyle,
    width: usize,
    cache: &mut crate::markdown::MarkdownBlockCache,
) -> Vec<Line> {
    let content_width = width.saturating_sub(2).max(1);
    let rendered =
        crate::markdown::render_markdown_tagged(text.trim(), content_width, md, "", cache);
    let mut out = Vec::new();
    for line in rendered.into_iter() {
        let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
        row.extend(line);
        // TS pads every markdown row with unstyled spaces after the row's
        // closing 39m reset (tmux trims them); padding never carries the
        // content style, or a dangling SGR prefix survives the trim on rows
        // whose content style differs from the body color (code rows, blank
        // space rows).
        out.push(pad_to(row, width, Style::default()));
    }
    out
}

/// The thinking block: markdown with every style collapsed to `dim`.
fn render_thinking_block(
    text: &str,
    theme: &Theme,
    md: &crate::markdown::MarkdownStyle,
    width: usize,
    cache: &mut crate::markdown::MarkdownBlockCache,
) -> Vec<Line> {
    let md = geometry::thinking_style(md, theme);
    let content_width = width.saturating_sub(2).max(1);
    let rendered =
        crate::markdown::render_markdown_tagged(text.trim(), content_width, &md, "dim", cache);
    let mut out = Vec::new();
    for line in rendered.into_iter() {
        // The markdown margin sits outside the styled content (default fg).
        let mut row: Line = vec![Span::raw(" ")];
        row.extend(line);
        // TS pads with unstyled spaces after the row's closing reset (see
        // render_markdown_block); padding never carries the dim content color.
        out.push(pad_to(row, width, Style::default()));
    }
    out
}

/// The working loader rows (TS `Loader.render`: `["", spinner + message]`).
pub fn render_loader(
    working: &WorkingState,
    frame: usize,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let accent = theme.fg_style(ThemeColor::Accent);
    let muted = theme.fg_style(ThemeColor::Muted);
    let spinner = LOADER_FRAMES[frame % LOADER_FRAMES.len()];
    let message = working.label();
    let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
    row.push(Span::styled(spinner.to_string(), accent));
    if !message.is_empty() {
        // The gap between the spinner and the label is unstyled (TS's
        // `Loader` builds `${renderedFrame} ${messageColorFn(message)}`:
        // the plain space sits between chalk's two colored runs, so the
        // emitted row resets to default fg there instead of carrying the
        // label color over the gap).
        row.push(Span::raw(" ".to_string()));
        row.push(Span::styled(message, muted));
    }
    vec![spacer(), pad_to(row, width, Style::default())]
}

/// An in-flight provider auto-retry (TS `retryLoader` + `CountdownTimer`):
/// replaces the working loader until the retry loop settles.
#[derive(Debug, Clone, PartialEq)]
pub struct RetryState {
    pub attempt: u32,
    pub max_attempts: u32,
    pub ends_at: std::time::Instant,
    /// The provider error that started this retry (TS `errorMessage`).
    pub error_message: String,
    /// Why the retry started: a quick retry counts down; a provider
    /// failover switch names the backup the turn re-routes to.
    pub reason: RetryStartReason,
}

impl RetryState {
    /// Whole seconds left in the countdown (never negative).
    pub fn seconds_left(&self) -> u64 {
        self.ends_at
            .saturating_duration_since(std::time::Instant::now())
            .as_secs()
    }

    /// The loader message for this retry (TS `auto_retry_start` rendering).
    fn message(&self) -> String {
        match &self.reason {
            RetryStartReason::Quick => format!(
                "Retrying ({}/{}) in {}s...",
                self.attempt,
                self.max_attempts,
                self.seconds_left()
            ),
            RetryStartReason::Backup { backup_model } => format!(
                "Primary model unavailable ({}) — retrying on backup model {backup_model}...",
                self.error_message
            ),
        }
    }
}

/// The retry loader rows (TS auto_retry_start rendering: muted spinner +
/// the retry message).
pub fn render_retry(retry: &RetryState, frame: usize, theme: &Theme, width: usize) -> Vec<Line> {
    let muted = theme.fg_style(ThemeColor::Muted);
    let spinner = LOADER_FRAMES[frame % LOADER_FRAMES.len()];
    let message = retry.message();
    let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
    row.push(Span::styled(spinner.to_string(), muted));
    // The gap between the spinner and the label is unstyled (the TS
    // `Loader` pen reset — see `render_loader`).
    row.push(Span::raw(" ".to_string()));
    row.push(Span::styled(message, muted));
    vec![spacer(), pad_to(row, width, Style::default())]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme, ThemeColor};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    #[test]
    fn backup_switch_loader_renders_the_failover_message() {
        // TS reason "backup": no countdown — the switch re-issues
        // immediately on the backup provider.
        let retry = RetryState {
            attempt: 3,
            max_attempts: 5,
            ends_at: std::time::Instant::now(),
            error_message: "Connection failed".to_string(),
            reason: RetryStartReason::Backup {
                backup_model: "prime-backup/mock-1".to_string(),
            },
        };
        let rows = render_retry(&retry, 0, &theme(), 60);
        let text = rows[1]
            .iter()
            .map(|s| s.content.as_str())
            .collect::<String>();
        assert!(
            text.contains(
                "Primary model unavailable (Connection failed) — retrying on backup model prime-backup/mock-1..."
            ),
            "got: {text}"
        );
    }

    #[test]
    fn retry_loader_renders_countdown() {
        let retry = RetryState {
            attempt: 1,
            max_attempts: 2,
            ends_at: std::time::Instant::now() + std::time::Duration::from_millis(1500),
            error_message: "provider down".to_string(),
            reason: RetryStartReason::Quick,
        };
        let rows = render_retry(&retry, 0, &theme(), 60);
        let text = rows[1]
            .iter()
            .map(|s| s.content.as_str())
            .collect::<String>();
        assert!(text.contains("Retrying (1/2) in 1s..."), "got: {text}");
    }

    /// TS `retryLoader` wraps the same `Loader` with muted spinner and
    /// message color fns: the muted pen colors the spinner, and the gap
    /// to the label resets to default fg.
    #[test]
    fn retry_loader_spans_carry_the_ts_sgr_boundaries() {
        let retry = RetryState {
            attempt: 1,
            max_attempts: 2,
            ends_at: std::time::Instant::now() + std::time::Duration::from_millis(1500),
            error_message: "provider down".to_string(),
            reason: RetryStartReason::Quick,
        };
        let t = theme();
        let muted = t.fg_style(ThemeColor::Muted);
        let rows = render_retry(&retry, 0, &t, 60);
        assert_eq!(
            rows[1][..4],
            [
                Span::styled(" ", Style::default()),
                Span::styled(LOADER_FRAMES[0], muted),
                Span::raw(" "),
                Span::styled("Retrying (1/2) in 1s...", muted),
            ]
        );
    }

    #[test]
    fn detail_cycle_visits_all_three_levels() {
        // TS `toggleToolOutputExpansion`: overview -> details -> all -> overview.
        let mut detail = Detail::Overview;
        assert!(!detail.show_thinking());
        assert!(!detail.tool_output_expanded());
        assert!(!detail.edit_diffs_expanded());
        detail = detail.next();
        assert_eq!(detail, Detail::Details);
        assert!(detail.show_thinking());
        assert!(!detail.tool_output_expanded());
        assert!(detail.edit_diffs_expanded());
        detail = detail.next();
        assert_eq!(detail, Detail::All);
        assert!(detail.show_thinking());
        assert!(detail.tool_output_expanded());
        assert!(detail.edit_diffs_expanded());
        detail = detail.next();
        assert_eq!(detail, Detail::Overview);
    }

    #[test]
    fn user_block_renders_box_rows() {
        let rows = render_user_block("Run a quick check.", &theme(), "  ", 60);
        assert_eq!(rows.len(), 3);
        let text = rows[1]
            .iter()
            .map(|s| s.content.as_str())
            .collect::<String>();
        assert_eq!(text.trim(), "Run a quick check.");
        assert_eq!(text.len(), 60);
    }

    /// The user block's styling tiers: the row background, the
    /// `userMessageText` body, and the prompt-highlight token colors.
    fn user_block_styles() -> (Style, Style, Style, Style, Style) {
        let theme = theme();
        let bg = theme.bg_style(ThemeBg::UserMessageBg);
        let body = theme.fg_style(ThemeColor::UserMessageText);
        let on_bg = |fg: Style| bg.patch(fg);
        (
            bg,
            on_bg(body),
            on_bg(theme.fg_style(ThemeColor::Accent)),
            on_bg(theme.fg_style(ThemeColor::Success)),
            on_bg(theme.fg_style(ThemeColor::MdLink)),
        )
    }

    /// One row's runs with adjacent same-style spans merged: the
    /// markdown renderer splits words and the restore keeps token runs,
    /// so the styled runs — not the span segmentation — are the contract.
    fn row_runs(row: &Line) -> Vec<(String, Style)> {
        let mut runs: Vec<(String, Style)> = Vec::new();
        for span in row {
            if let Some((text, style)) = runs.last_mut() {
                if *style == span.style {
                    text.push_str(&span.content);
                    continue;
                }
            }
            runs.push((span.content.to_string(), span.style));
        }
        runs
    }

    #[test]
    fn user_block_highlights_argument_tokens() {
        // TS `PromptTokenMask`: the argument tokens render in their own
        // colors inside the `userMessageText` body.
        let (bg, body, _, success, md_link) = user_block_styles();
        let rows = render_user_block("fix @Cargo.toml --quiet now", &theme(), "  ", 60);
        assert_eq!(rows.len(), 3);
        assert_eq!(
            row_runs(&rows[1]),
            vec![
                ("  ".to_string(), bg),
                ("fix ".to_string(), body),
                ("@Cargo.toml".to_string(), success),
                (" ".to_string(), body),
                ("--quiet".to_string(), md_link),
                (" now".to_string(), body),
                (" ".repeat(60 - 2 - 27), bg),
            ]
        );
    }

    #[test]
    fn user_block_accents_a_recognized_leading_command() {
        // TS `UserMessageComponent`: a leading `/name` naming a recognized
        // command masks in accent over the whole command segment; an
        // unrecognized one renders like any other text.
        let (bg, body, accent, _, _) = user_block_styles();
        let rows = render_user_block("/hotkeys", &theme(), "  ", 40);
        assert_eq!(
            row_runs(&rows[1]),
            vec![
                ("  ".to_string(), bg),
                ("/hotkeys".to_string(), accent),
                (" ".repeat(40 - 2 - 8), bg),
            ]
        );
        let rows = render_user_block("/definitely-not-builtin now", &theme(), "  ", 40);
        let styled = row_runs(&rows[1]);
        // The unrecognized row stays uniform `userMessageText`.
        assert_eq!(
            styled
                .iter()
                .map(|(t, _)| t.as_str())
                .collect::<String>()
                .trim(),
            "/definitely-not-builtin now"
        );
        assert!(
            styled
                .iter()
                .filter(|(_, s)| s != &bg)
                .all(|(_, s)| s == &body),
            "no accent for unrecognized commands: {styled:?}"
        );
    }

    #[test]
    fn user_block_mask_shields_tokens_from_markdown() {
        // The mask exists so markdown cannot eat or emphasize the token
        // text: an `@path` full of asterisks renders verbatim in the token
        // color, and a long token wraps like plain text.
        let (_, _, _, success, _) = user_block_styles();
        let rows = render_user_block("use @a*b_c and more", &theme(), "  ", 60);
        let text: String = rows[1].iter().map(|s| s.content.as_str()).collect();
        assert!(
            text.contains("@a*b_c"),
            "the token renders verbatim: {text:?}"
        );
        assert!(
            row_runs(&rows[1])
                .iter()
                .any(|(t, s)| t == "@a*b_c" && *s == success),
            "the token renders in success color"
        );
    }

    #[test]
    fn user_block_plain_sources_stay_plain() {
        // A source holding literal mask-range characters (TS
        // `MASK_LITERAL_PATTERN`) masks nothing at all: the token colors
        // would alias the literals, so the row renders whole.
        let (bg, body, _, _, _) = user_block_styles();
        let rows = render_user_block("look \u{E000} at @file", &theme(), "  ", 60);
        let styled: Vec<(String, Style)> = rows[1]
            .iter()
            .map(|s| (s.content.to_string(), s.style))
            .collect();
        assert!(
            styled
                .iter()
                .filter(|(_, s)| s != &bg)
                .all(|(_, s)| s == &body),
            "a literal-mask source renders whole: {styled:?}"
        );
        // More masked graphemes than the placeholder alphabet holds (TS
        // MASK_CAPACITY = 0xF8FF - 0xE000 + 1 = 6400) mask nothing. (The
        // block's OSC zone-marker spans on the first and last rows are
        // exempt.)
        let long = format!("fix {} now", "@x".repeat(3300));
        let rows = render_user_block(&long, &theme(), "  ", 60);
        let offending: Vec<(String, Style)> = rows
            .iter()
            .flatten()
            .filter(|s| !s.content.contains('\u{1b}'))
            .filter(|s| s.style != body && s.style != bg)
            .map(|s| (s.content.clone(), s.style))
            .collect();
        assert!(
            offending.is_empty(),
            "over-capacity sources render whole: {offending:?}"
        );
    }

    #[test]
    fn user_block_carries_zone_markers() {
        let rows = render_user_block("Run a quick check.", &theme(), "  ", 60);
        // The zone-start sequence leads the first block row; the end and
        // final sequences lead the last block row (TS prepends both).
        assert!(crate::osc133::row_markers(&rows[0]).start);
        assert!(crate::osc133::row_markers(&rows[2]).end);
        let first: String = rows[0].iter().map(|s| s.content.as_str()).collect();
        assert!(first.starts_with(crate::osc133::ZONE_START));
        let last: String = rows[2].iter().map(|s| s.content.as_str()).collect();
        assert!(last.starts_with(crate::osc133::ZONE_END_PREFIX));
        // Markers are zero-width: marked rows still measure full width.
        assert_eq!(crate::width::line_width(&rows[0]), 60);
    }

    #[test]
    fn assistant_markers_skip_tool_call_messages() {
        let plain = AssistantMessage {
            blocks: vec![MessageBlock::Text("Done.".to_string())],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        };
        let rows = render_assistant(
            &plain,
            Detail::Overview,
            &theme(),
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        assert!(crate::osc133::row_markers(&rows[0]).start);
        assert!(crate::osc133::row_markers(rows.last().unwrap()).end);

        let with_tools = AssistantMessage {
            blocks: vec![MessageBlock::Text("Working.".to_string())],
            has_tool_calls: true,
            streaming: false,
            error: None,
            aborted: false,
        };
        let rows = render_assistant(
            &with_tools,
            Detail::Overview,
            &theme(),
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        assert_eq!(crate::osc133::row_markers(&rows[0]), Default::default());
    }

    #[test]
    fn code_block_indent_rides_the_render_calls() {
        // `markdown.codeBlockIndent` (TS getCodeBlockIndent ->
        // getMarkdownThemeWithSettings): the settings string flows through
        // render_assistant / render_user_block into every fenced block.
        let message = AssistantMessage {
            blocks: vec![MessageBlock::Text(
                "intro\n\n```\nfn main() {}\n```".to_string(),
            )],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        };
        let strip_markers = |row: &str| {
            row.replace(crate::osc133::ZONE_END_PREFIX, "")
                .replace(crate::osc133::ZONE_END, "")
                .trim_end()
                .to_string()
        };
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme(),
            "    ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        let flat: Vec<String> = rows
            .iter()
            .map(|line| line.iter().map(|s| s.content.as_str()).collect::<String>())
            .map(|row| strip_markers(&row))
            .collect();
        assert!(
            flat.iter().any(|row| row == "     fn main() {}"),
            "non-default indent applied: {flat:?}"
        );
        // The default (no setting) stays two spaces.
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme(),
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        let flat: Vec<String> = rows
            .iter()
            .map(|line| line.iter().map(|s| s.content.as_str()).collect::<String>())
            .map(|row| strip_markers(&row))
            .collect();
        assert!(
            flat.iter().any(|row| row == "   fn main() {}"),
            "default indent: {flat:?}"
        );
    }

    #[test]
    fn ipython_card_done_line() {
        let card = ToolCallCard {
            id: "toolu_1".into(),
            name: "ipython".into(),
            args: serde_json::json!({ "code": "print('visual parity ok')" }),
            started: true,
            result: Some(ToolResultView {
                content: vec![serde_json::json!({ "type": "text", "text": "visual parity ok" })],
                details: serde_json::json!({ "status": "ok", "durationMs": 2, "stdout": "visual parity ok\n" }),
                is_error: false,
            }),
            result_partial: false,
            ..Default::default()
        };
        let rows = render_tool_card(&card, 0, Detail::Overview, &theme(), 100, true);
        let text = rows[0]
            .iter()
            .map(|s| s.content.as_str())
            .collect::<String>();
        assert!(
            text.contains("\u{2713} python \u{00b7} print('visual parity ok') \u{00b7} \u{2191} 1 \u{2193} 1 lines"),
            "got: {text}"
        );
    }

    #[test]
    fn assistant_error_row_and_spacers() {
        let message = AssistantMessage {
            blocks: vec![MessageBlock::Text("Running the checks.".into())],
            has_tool_calls: false,
            streaming: false,
            error: Some("Error: request failed after retries".into()),
            aborted: false,
        };
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme(),
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        let flat: Vec<String> = rows
            .iter()
            .map(|line| line.iter().map(|s| s.content.as_str()).collect())
            .collect();
        assert!(
            flat[0].starts_with(crate::osc133::ZONE_START),
            "leading spacer carries the OSC-133 start marker: {flat:?}"
        );
        assert!(
            flat.iter().any(|row| row.contains("Error: request failed")),
            "got: {flat:?}"
        );
        // A tool-carrying message keeps its trailing spacer.
        let message = AssistantMessage {
            blocks: vec![MessageBlock::Text("body".into())],
            has_tool_calls: true,
            streaming: false,
            error: None,
            aborted: false,
        };
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme(),
            "  ",
            60,
            true,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        assert_eq!(rows.last().unwrap().len(), 0, "trailing spacer");
        // A tool-only message after tool activity renders no spacers.
        let message = AssistantMessage {
            blocks: Vec::new(),
            has_tool_calls: true,
            streaming: false,
            error: None,
            aborted: false,
        };
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme(),
            "  ",
            60,
            true,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        assert!(rows.is_empty(), "got: {rows:?}");
    }

    /// TS `createErrorComponent` + `formatInlineLoginRecoveryMessage`: an
    /// error whose text ends with the login-recovery suffix renders as ONE
    /// merged inline line (`{base} · Run /login to update credentials.`),
    /// error-colored and one-space indented like every other error row, and
    /// identical across detail modes (a plain row, never the collapsible
    /// component).
    #[test]
    fn login_recovery_error_renders_one_merged_inline_line() {
        let theme = theme();
        let error_style = theme.fg_style(ThemeColor::Error);
        let message = AssistantMessage {
            blocks: Vec::new(),
            has_tool_calls: false,
            streaming: false,
            error: Some("Auth failed. \n\nRun /login to update credentials.".into()),
            aborted: false,
        };
        for detail in [Detail::Overview, Detail::Details, Detail::All] {
            let rows = render_assistant(
                &message,
                detail,
                &theme,
                "  ",
                60,
                false,
                &mut crate::markdown::MarkdownBlockCache::default(),
            );
            assert_eq!(
                rows,
                vec![
                    vec![Span::raw(crate::osc133::ZONE_START)],
                    vec![
                        Span::raw(crate::osc133::ZONE_END_PREFIX),
                        Span::raw(" "),
                        Span::styled(
                            "Auth failed. · Run /login to update credentials.",
                            error_style
                        ),
                        Span::raw(" ".repeat(11)),
                    ],
                ]
            );
        }
    }

    /// The exact daemon authentication-failure wording merges: one inline
    /// logical line at full width, and the same single line flows across
    /// wrapped rows when narrow (the suffix never renders as its own
    /// blank-line block).
    #[test]
    fn login_recovery_merges_the_exact_daemon_error_wording() {
        let theme = theme();
        let error_style = theme.fg_style(ThemeColor::Error);
        let message = AssistantMessage {
            blocks: Vec::new(),
            has_tool_calls: false,
            streaming: false,
            error: Some(
                "Authentication failed for \"prime-inference\". Credentials may have expired or network is unavailable.\n\nRun /login to update credentials."
                    .into(),
            ),
            aborted: false,
        };
        let merged = "Authentication failed for \"prime-inference\". Credentials may have expired or network is unavailable. · Run /login to update credentials.";
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme,
            "  ",
            140,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        assert_eq!(
            rows,
            vec![
                vec![Span::raw(crate::osc133::ZONE_START)],
                vec![
                    Span::raw(crate::osc133::ZONE_END_PREFIX),
                    Span::raw(" "),
                    Span::styled(merged, error_style),
                    Span::raw(" ".repeat(3)),
                ],
            ]
        );

        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme,
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        let flat: Vec<String> = rows
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
                    .replace(crate::osc133::ZONE_END_PREFIX, "")
                    .replace(crate::osc133::ZONE_START, "")
            })
            .collect();
        assert_eq!(flat.len(), 4, "spacer + 3 wrapped rows: {flat:?}");
        assert_eq!(
            flat[1..],
            vec![
                format!(
                    " Authentication failed for \"prime-inference\". Credentials{}",
                    " ".repeat(3)
                ),
                " may have expired or network is unavailable. · Run /login to".to_string(),
                format!(" update credentials.{}", " ".repeat(40)),
            ]
        );
    }

    /// Only an end-of-text suffix with a non-empty, single-line base merges;
    /// every other error shape keeps the normal (collapsible) rows.
    #[test]
    fn login_recovery_fallthroughs_keep_the_normal_error_rows() {
        let theme = theme();
        let error_style = theme.fg_style(ThemeColor::Error);
        let render = |error: &str, detail: Detail| {
            render_assistant(
                &AssistantMessage {
                    blocks: Vec::new(),
                    has_tool_calls: false,
                    streaming: false,
                    error: Some(error.to_string()),
                    aborted: false,
                },
                detail,
                &theme,
                "  ",
                60,
                false,
                &mut crate::markdown::MarkdownBlockCache::default(),
            )
        };
        // No suffix: the raw single-line error row is unchanged (fence).
        assert_eq!(
            render("Auth failed.", Detail::Overview)[1],
            vec![
                Span::raw(crate::osc133::ZONE_END_PREFIX),
                Span::raw(" "),
                Span::styled("Auth failed.", error_style),
                Span::raw(" ".repeat(47)),
            ]
        );
        // Multi-line base: the collapsible path applies to the full error —
        // the summary row while collapsed, the suffix as its own block while
        // expanded.
        let multi = "Auth failed\nfor provider.\n\nRun /login to update credentials.";
        assert_eq!(
            render(multi, Detail::Overview)[1],
            vec![
                Span::raw(crate::osc133::ZONE_END_PREFIX),
                Span::raw(" "),
                Span::styled("Auth failed ", error_style),
                Span::raw(" ".repeat(47)),
            ]
        );
        let flat: Vec<String> = render(multi, Detail::All)
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
                    .replace(crate::osc133::ZONE_END_PREFIX, "")
                    .replace(crate::osc133::ZONE_START, "")
            })
            .collect();
        assert_eq!(
            flat,
            vec![
                String::new(),
                format!(" Auth failed{}", " ".repeat(48)),
                format!(" for provider.{}", " ".repeat(46)),
                // The error's empty line pads to a full-width spaces row
                // (TS `collapsible-error.ts` renderText: `rawLine || " "`
                // then pad to width); `render_collapsible_error` matches
                // that — never a truly blank row inside the error body.
                " ".repeat(60),
                format!(" Run /login to update credentials.{}", " ".repeat(26)),
            ]
        );
        // Suffix not at the end: no merge, the collapsed summary stands.
        let trailing = "Auth failed.\n\nRun /login to update credentials.\nProvider degraded.";
        assert_eq!(
            render(trailing, Detail::Overview)[1],
            vec![
                Span::raw(crate::osc133::ZONE_END_PREFIX),
                Span::raw(" "),
                Span::styled("Auth failed. ", error_style),
                Span::raw(" ".repeat(46)),
            ]
        );
    }

    /// TS `AssistantMessageComponent.rebuild`'s aborted arm: the aborted
    /// message renders its "Operation aborted" row inside the component,
    /// in the theme's error color with no "Error: " prefix, behind a
    /// spacer; a non-generic errorMessage renders itself; the abort also
    /// keeps the tool-call trailing spacer (TS `hasTrailingSpace`).
    #[test]
    fn aborted_assistant_message_renders_the_red_abort_row() {
        let theme = theme();
        let message = AssistantMessage {
            blocks: vec![MessageBlock::Text("Partial answer.".into())],
            has_tool_calls: true,
            streaming: false,
            error: Some("Operation aborted".into()),
            aborted: true,
        };
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme,
            "  ",
            60,
            true,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        let abort_row_index = rows
            .iter()
            .position(|line| {
                line.iter()
                    .any(|span| span.content.contains("Operation aborted"))
            })
            .expect("the aborted row never rendered");
        // The row before is the spacer TS `rebuild` adds, the row is
        // error-colored with the plain text (no "Error: " prefix), and
        // the trailing tool spacer follows (hasTrailingSpace's aborted
        // arm, even after tool activity).
        assert_eq!(
            rows[abort_row_index - 1].len(),
            0,
            "no spacer before the abort row"
        );
        let error_style = theme.fg_style(ThemeColor::Error);
        let abort_text = rows[abort_row_index]
            .iter()
            .find(|span| span.content.contains("Operation aborted"))
            .expect("the abort span");
        assert_eq!(
            abort_text.style, error_style,
            "the abort row is not error-colored"
        );
        assert!(
            !rows[abort_row_index]
                .iter()
                .any(|span| span.content.contains("Error: ")),
            "unexpected error prefix"
        );
        assert_eq!(rows.last().unwrap().len(), 0, "trailing spacer");
        // A provider-supplied abort reason renders instead of the generic
        // text (TS: every errorMessage but "Request was aborted" wins).
        let message = AssistantMessage {
            blocks: Vec::new(),
            has_tool_calls: false,
            streaming: false,
            error: Some("aborted by the user".into()),
            aborted: true,
        };
        let rows = render_assistant(
            &message,
            Detail::Overview,
            &theme,
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        assert!(
            rows.iter().any(|line| {
                line.iter()
                    .any(|span| span.content.contains("aborted by the user"))
            }),
            "the custom abort reason never rendered: {rows:?}"
        );
    }

    #[test]
    fn loader_line_shape() {
        let working = WorkingState {
            activity: "Writing",
            message: None,
            download: true,
            tokens: 72,
            elapsed_secs: 1,
        };
        let rows = render_loader(&working, 4, &theme(), 100);
        assert_eq!(rows.len(), 2);
        let text = rows[1]
            .iter()
            .map(|s| s.content.as_str())
            .collect::<String>();
        assert!(text.contains("\u{283c} Writing \u{00b7} 1s \u{00b7} \u{2193} 72 tokens"));
    }

    /// TS `Loader`: `${spinnerColorFn(frame)} ${messageColorFn(msg)}` —
    /// the gap between the spinner and the label sits between chalk's two
    /// colored runs, so the emitted row resets to default fg there instead
    /// of carrying the label color over the gap.
    #[test]
    fn loader_gap_between_spinner_and_label_is_unstyled() {
        let working = WorkingState {
            activity: "Writing",
            message: None,
            download: true,
            tokens: 72,
            elapsed_secs: 1,
        };
        let t = theme();
        let accent = t.fg_style(ThemeColor::Accent);
        let muted = t.fg_style(ThemeColor::Muted);
        let rows = render_loader(&working, 0, &t, 100);
        assert_eq!(
            rows[1][..4],
            [
                Span::styled(" ", Style::default()),
                Span::styled(LOADER_FRAMES[0], accent),
                Span::raw(" "),
                Span::styled("Writing \u{00b7} 1s \u{00b7} \u{2193} 72 tokens", muted),
            ]
        );
    }

    /// While a tool owns the working message (python-kernel bootstrap), the
    /// loader shows "<message> <elapsed>" and drops the activity label and
    /// the token count (TS `getWorkingLoaderMessage`).
    #[test]
    fn loader_working_message_replaces_the_activity_label() {
        let working = WorkingState {
            activity: "Executing",
            message: Some("\u{203a} setting up python kernel (one-time, ~30s)\u{2026}".into()),
            download: true,
            tokens: 72,
            elapsed_secs: 3,
        };
        let rows = render_loader(&working, 4, &theme(), 100);
        let text = rows[1]
            .iter()
            .map(|s| s.content.as_str())
            .collect::<String>();
        assert!(
            text.contains("\u{283c} \u{203a} setting up python kernel (one-time, ~30s)\u{2026} 3s"),
            "got: {text}"
        );
        assert!(!text.contains("Executing"));
        assert!(!text.contains("72 tokens"));
    }

    /// TS `formatWorkingElapsed`: "3s" below a minute, then "1m 05s",
    /// "1h 02m 03s", "1d 02h 03m 04s".
    #[test]
    fn elapsed_label_formats_like_ts() {
        assert_eq!(format_working_elapsed(3), "3s");
        assert_eq!(format_working_elapsed(65), "1m 05s");
        assert_eq!(format_working_elapsed(3723), "1h 02m 03s");
        assert_eq!(format_working_elapsed(93784), "1d 02h 03m 04s");
    }

    /// TS `message_end`'s aborted arm: the live abort row carries the
    /// client's own retry count and working-elapsed suffix (the wire row
    /// never does; the rebuild keeps the plain stored text).
    #[test]
    fn live_abort_text_matches_ts() {
        assert_eq!(live_abort_text(0, None), "Operation aborted");
        assert_eq!(live_abort_text(0, Some(3)), "Operation aborted \u{00b7} 3s");
        assert_eq!(
            live_abort_text(1, Some(2)),
            "Aborted after 1 retry attempt \u{00b7} 2s"
        );
        assert_eq!(
            live_abort_text(2, Some(65)),
            "Aborted after 2 retry attempts \u{00b7} 1m 05s"
        );
    }
}
