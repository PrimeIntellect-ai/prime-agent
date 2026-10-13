//! Transcript component rendering: status rows, the user-message block,
//! assistant messages (text, thinking, and their error rows), and the
//! working loader line. Tool-call cards live in `crate::tool_card`.

mod geometry;
pub(crate) use geometry::{assistant_row_count, user_block_row_count};

use crate::snapshot::RetryStartReason;
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::str_width;
use crate::{Line, Span};
use ratatui::style::{Modifier, Style};

/// How much detail the conversation shows.
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
    /// The Ctrl+O cycle: overview -> details -> all -> overview.
    #[must_use]
    pub fn next(self) -> Self {
        match self {
            Detail::Overview => Detail::Details,
            Detail::Details => Detail::All,
            Detail::All => Detail::Overview,
        }
    }

    #[must_use]
    pub fn show_thinking(self) -> bool {
        !matches!(self, Detail::Overview)
    }

    #[must_use]
    pub fn tool_output_expanded(self) -> bool {
        matches!(self, Detail::All)
    }

    #[must_use]
    pub fn edit_diffs_expanded(self) -> bool {
        !matches!(self, Detail::Overview)
    }

    /// The stored wire name (TS `ChatDetail`): "overview" | "details" | "all".
    #[must_use]
    pub fn wire_name(self) -> &'static str {
        match self {
            Detail::Overview => "overview",
            Detail::Details => "details",
            Detail::All => "all",
        }
    }

    /// The level for a stored wire name: an unset or unknown value reads
    /// as the `overview` startup level (operator ruling 2026-09-28).
    #[must_use]
    pub fn from_wire_name(name: &str) -> Self {
        match name {
            "details" => Detail::Details,
            "all" => Detail::All,
            _ => Detail::Overview,
        }
    }
}

/// One rendered chat component.
#[derive(Debug, Clone, PartialEq)]
/// The style tier of a status row.
pub enum StatusKind {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChatEntry {
    /// Startup notices, client notes, turn errors.
    Status { text: String, kind: StatusKind },
    /// The user's submitted prompt.
    User { text: String },
    /// A durable session-command echo row (`session_slash_command`):
    /// the command as typed, laid out like a user message.
    SlashCommand { text: String },
    /// The compaction summary row (TS `CompactionSummaryMessageComponent`):
    /// `◆ Context compacted` with the summary below.
    CompactionSummary {
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
    /// One agent-message summary row: the received transcript rows.
    AgentMessage(Box<crate::custom_message::AgentMessageRow>),
    /// One skill-invocation card: the expandable `<skill>`-block card a
    /// user message carrying a skill invocation parses into.
    SkillInvocation(Box<crate::custom_message::SkillInvocationRow>),
    /// One injected prompt row.
    InjectedPrompt(Box<crate::custom_message::InjectedPromptRow>),
    /// One `!`/`!!` bash run: the live `bash_start`/`bash_output`/`bash_end` events, the replayed
    /// `bashExecution` row, and the pending-while-streaming hold all render through this card.
    BashExecution(Box<crate::bash_card::BashExecutionCard>),
    /// One background-shell completion row.
    ShellCompletion(Box<crate::custom_message::ShellCompletionRow>),
    /// One refinement outcome row.
    RefinementOutcome(Box<crate::custom_message::RefinementOutcomeRow>),
    /// One generic custom row.
    CustomPanel(Box<crate::custom_message::CustomPanelRow>),
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
    /// A failed assistant message's error row: `aborted` always renders, `error` only
    /// without tool calls (their cards carry the failure).
    pub error: Option<String>,
    /// `stopReason: "aborted"` (drives the tool-call trailing spacer).
    pub aborted: bool,
}

impl AssistantMessage {
    /// The tool-call separator renders for visible bodies, aborted
    /// messages, and messages not following tool activity.
    #[must_use]
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
    /// A transient message owned by the running tool (set by the python-kernel
    /// bootstrap): replaces the activity label and the token count until the tool clears it.
    pub message: Option<String>,
    /// Streaming direction: `true` while tokens flow down.
    pub download: bool,
    pub tokens: u64,
    /// Whole seconds since the loader started.
    pub elapsed_secs: u64,
}

/// The live abort row's text (TS `message_end`'s aborted arm): the retry
/// count and the working-elapsed suffix ride the client, never the wire
/// (the rebuild path keeps the stored "Operation aborted").
#[must_use]
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

#[must_use]
pub fn format_working_elapsed(total_secs: u64) -> String {
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let hours = total_mins / 60;
    if total_mins == 0 {
        return format!("{secs}s");
    }
    if hours == 0 {
        return format!("{mins}m {secs:02}s");
    }
    let days = hours / 24;
    if days == 0 {
        return format!("{hours}h {mins:02}m {secs:02}s");
    }
    format!("{days}d {:02}h {mins:02}m {secs:02}s", hours % 24)
}

impl WorkingState {
    #[must_use]
    pub fn label(&self) -> String {
        // A tool-provided working message owns the loader line: plain
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

/// Spinner frames.
pub(crate) const LOADER_FRAMES: [&str; 10] = [
    "\u{280b}", "\u{2819}", "\u{2839}", "\u{2838}", "\u{283c}", "\u{2834}", "\u{2826}", "\u{2827}",
    "\u{2807}", "\u{280f}",
];

/// The working pulse icon frames (250ms interval): the shared "still working"
/// marker across the agents view, the subagent tray, and tool markers.
pub const WORKING_ICON_FRAMES: [&str; 4] = ["\u{25c7}", "\u{25c8}", "\u{25c6}", "\u{25c8}"];

#[must_use]
pub fn working_icon_frame(frame: usize) -> &'static str {
    WORKING_ICON_FRAMES[frame % WORKING_ICON_FRAMES.len()]
}

fn spacer() -> Line {
    Vec::new()
}

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
#[must_use]
pub fn render_text_rows(text: &str, style: Style, width: usize) -> Vec<Line> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let content_width = width.saturating_sub(2).max(1);
    let wrapped = crate::width::wrap_text(text, content_width);
    let row_count = wrapped.len();
    let mut out = Vec::new();
    for (index, line) in wrapped.into_iter().enumerate() {
        // The margin keeps the default foreground. Wrapped rows keep the ANSI state open
        // through their trailing padding, so continuation rows pad with the row style.
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

/// The user-message block (TS `UserMessageComponent`: Box(2,1) on `userMessageBg`,
/// markdown inside colored `userMessageText`). Prompt-highlight tokens render
/// in their own colors (TS masks them to same-width placeholders so markdown cannot eat them).
#[must_use]
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
            Span::styled(String::new(), body),
        ];
        rows.push(pad_to(row, width, bg));
    }
    for line in rendered {
        let mut row: Line = vec![Span::styled("  ".to_string(), bg)];
        // The user block colors everything `userMessageText` on the block background;
        // markdown structure (wrapping) is kept, its own colors are not, and the link
        // affordance survives the restyle.
        let restyled: Line = line
            .into_iter()
            .map(|span| {
                let mut style = bg.patch(body);
                if span.style.add_modifier.contains(Modifier::UNDERLINED) {
                    style = style.add_modifier(Modifier::UNDERLINED);
                }
                if span.style.fg == md.link_url.fg {
                    style = style.patch(md.link_url);
                }
                Span::styled(span.content, style)
            })
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

/// One assistant message: a leading spacer when a visible body exists, markdown
/// blocks separated by spacers, and a trailing spacer before its tool calls.
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
    if geometry::trailing_space(message, has_visible_content, preceded_by_tool_activity) {
        out.push(spacer());
    }
    // Zone markers on message bodies without tool calls (TS `AssistantMessageComponent.render`:
    // tool-call messages return unmarked).
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
    for line in rendered {
        let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
        row.extend(line);
        // Padding never carries the content style: a dangling SGR prefix survives tmux's
        // trim on rows whose content style differs from the body color.
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
    let rendered = crate::markdown::render_markdown_tagged(
        text.trim(),
        content_width,
        &md,
        geometry::THINKING_CACHE_TAG,
        cache,
    );
    let mut out = Vec::new();
    for line in rendered {
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
#[must_use]
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
        // The gap between the spinner and the label is unstyled: the plain space sits
        // between the two colored runs, so the row resets to default fg there.
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
    /// The provider error that started this retry.
    pub error_message: String,
    /// Why the retry started: a quick retry counts down; a provider
    /// failover switch names the backup the turn re-routes to.
    pub reason: RetryStartReason,
}

impl RetryState {
    /// Whole seconds left in the countdown (never negative).
    #[must_use]
    pub fn seconds_left(&self) -> u64 {
        self.ends_at
            .saturating_duration_since(std::time::Instant::now())
            .as_secs()
    }

    /// The loader message for this retry. SANCTIONED DIVERGENCE from the TS
    /// `auto_retry_start` rendering (operator ruling 2026-09-23): the quick-retry line
    /// names the ERROR too, not just the attempt.
    fn message(&self) -> String {
        match &self.reason {
            RetryStartReason::Quick => format!(
                "{} — retrying ({}/{}) in {}s...",
                self.error_message,
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

/// The retry loader rows (TS `auto_retry_start` rendering: muted spinner +
/// the retry message).
#[must_use]
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
mod tests;
