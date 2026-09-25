//! Condensed tool runs in the collapsed conversation view (operator
//! feature, Kevin 2026-09-24 - a NEW product surface with no TS twin):
//! a run of more than four consecutive tool calls with only hidden
//! thinking between them renders as ONE compact block - a summary row
//! (status glyph, the call count, the run's wall-clock) plus a
//! branch-gutter breakdown row (the class counts and the drill-in hint).
//! The block is LIVE while the run streams (the counts, the elapsed
//! wall-clock, and the working icon update on every pulse frame), and
//! `details`/`all` (the Ctrl+O cycle) render every card exactly as
//! before - the condensing is `overview`-only, purely a render-time
//! grouping over the unchanged transcript model.
//!
//! The grouping is computed here from the entry stream at render time
//! (operator hard constraint: "just a UI change ... it should just be
//! visual" - no session jsonl schema change, no stored-event change, no
//! daemon/kernel data-model change; a run's boundaries, counts, and
//! wall-clock derive from the same entries either way, so the condensed
//! form is retroactively correct for old sessions).

use crate::chat::{ChatEntry, ToolCallCard};
use crate::theme::{Theme, ThemeColor};
use crate::width::{truncate_line, wrap_line, wrapped_line_count};
use crate::{Line, Span};

/// A tool run condenses at this many tool calls or more (the operator's
/// ">4 consecutive tool calls" trigger).
pub const CONDENSE_MIN_CALLS: usize = 5;

/// One condensed run: the half-open entry range `[start, end)` over the
/// chat vector. The first entry is always a tool card; the interior
/// entries are tool cards and hidden-in-overview assistant messages (the
/// "only thinking between them" glue); the run ends at the first entry
/// that renders on its own (agent text, an agent message, a user row,
/// any custom or status row).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolRun {
    /// The first member's chat index (always a `Tool` entry).
    pub start: usize,
    /// One past the last member's chat index.
    pub end: usize,
    /// The tool cards inside the range (assistant glue entries do not
    /// count).
    pub calls: usize,
}

impl ToolRun {
    /// Whether the run crosses the condensing threshold.
    pub fn qualifies(self) -> bool {
        self.calls >= CONDENSE_MIN_CALLS
    }
}

/// One entry's place in the run map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunSlot {
    /// The entry renders on its own (no qualifying run covers it).
    Solo,
    /// The FIRST entry of a qualifying run: the block's rows hang on
    /// it, and the slot carries the run's extent.
    Start(ToolRun),
    /// A later member of a qualifying run (renders nothing; its rows
    /// ride the start's block).
    Member,
}

/// Whether one entry renders nothing in the collapsed view: a tool card
/// always renders (an orphan result card excluded - it keeps its own
/// standalone row and breaks runs like any other entry); an assistant
/// message is run glue when the overview hides all of its blocks and it
/// raises no error or abort row (the hidden thinking the operator's
/// trigger allows between calls).
pub fn is_run_glue(entry: &ChatEntry) -> bool {
    match entry {
        ChatEntry::Tool(card) => !card.unmatched_result,
        ChatEntry::Assistant(message) => {
            !message.aborted
                && message.error.is_none()
                && message.blocks.iter().all(|block| match block {
                    crate::chat::MessageBlock::Thinking(_) => true,
                    crate::chat::MessageBlock::Text(text) => text.trim().is_empty(),
                })
        }
        _ => false,
    }
}

/// A run's stable identity: the wire id of its first tool card. A
/// resync rebuild replaces the chat wholesale and shifts indices, so
/// a run's position is not stable across it - the first card's wire id
/// is (the runs view's reconcile re-finds a survived run by this key).
pub fn run_key(chat: &[ChatEntry], run: ToolRun) -> Option<&str> {
    chat.get(run.start..run.end)?
        .iter()
        .find_map(|entry| match entry {
            ChatEntry::Tool(card) => Some(card.id.as_str()),
            _ => None,
        })
}

/// The condensed block's inputs, derived from the run's entries at
/// render time (never stored - the transcript model stays exactly as
/// the event stream built it).
#[derive(Debug, Clone, PartialEq)]
pub struct RunSummary {
    /// The tool cards in the run.
    pub calls: usize,
    /// Any card is still queued or running (the block animates and its
    /// wall-clock extends to now).
    pub live: bool,
    /// Any card settled with an error (the status glyph's error state
    /// wins, the panel-status semantics).
    pub failed: bool,
    /// The run's wall-clock in milliseconds: the wire message
    /// timestamps when the whole run carries them (the replay path),
    /// else the live instants (first execution start to the last
    /// execution end, or now while the run is live).
    pub wall_ms: Option<u64>,
    /// The class counts in first-occurrence order: the per-card language
    /// label the rows themselves show (`python`, `bash`, or the tool's
    /// own name), plus the trailing `agent messages sent`/`queued`
    /// classes from the ipython receipt records.
    pub classes: Vec<ClassCount>,
}

/// One breakdown class: a label and its count (`8 python`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassCount {
    pub label: String,
    pub count: usize,
}

/// The run's class label for one tool card: the ipython cell's own
/// language (`python` or `bash` - a literal bash launch is bash), the
/// bash tool's `bash`, or the card's tool name otherwise (the same label
/// the card's own rows show).
fn class_label(card: &ToolCallCard) -> String {
    if card.name == "ipython" {
        let code = card
            .args
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let is_bash_cell = crate::code_preview::parse_ipython_bash_cell(code).is_some();
        if is_bash_cell {
            return "bash".to_string();
        }
        match crate::code_preview::preview_ipython_code(code).language {
            crate::code_preview::CodePreviewLanguage::Bash => "bash".to_string(),
            crate::code_preview::CodePreviewLanguage::Python => "python".to_string(),
        }
    } else {
        card.name.clone()
    }
}

/// Count the sent-agent-message receipts one run carries (the
/// `agent_message.send` tool results riding the ipython cell details:
/// the `Agent message sent`/`Agent message queued` rows under each
/// card).
fn message_receipts(cards: &[&ToolCallCard]) -> (usize, usize) {
    let (mut sent, mut queued) = (0, 0);
    for card in cards {
        let Some(result) = &card.result else {
            continue;
        };
        let details = crate::tool_card::ipython_details::IpythonDetails::parse(&result.details);
        for receipt in &details.sent_agent_messages {
            if crate::tool_card::ipython_details::parse_sent_agent_message(receipt)
                .is_some_and(|parsed| parsed.delivered)
            {
                sent += 1;
            } else {
                queued += 1;
            }
        }
    }
    (sent, queued)
}

/// The run's wall-clock in milliseconds from the live instants: the
/// earliest execution start to the latest execution end - `None` while
/// no card started, and growing to `now` while any card is live.
fn instant_wall_ms(cards: &[&ToolCallCard], live: bool) -> Option<u64> {
    let mut start: Option<std::time::Instant> = None;
    let mut end: Option<std::time::Instant> = None;
    for card in cards {
        if let Some(at) = card.started_at {
            start = Some(start.map_or(at, |seen| seen.min(at)));
            end = Some(end.map_or(at, |seen| seen.max(at)));
        }
        if let Some(at) = card.ended_at {
            end = Some(end.map_or(at, |seen| seen.max(at)));
        }
    }
    let start = start?;
    let end = end?;
    let end = if live { std::time::Instant::now() } else { end };
    end.checked_duration_since(start)
        .map(|elapsed| elapsed.as_millis() as u64)
}

/// The run's wall-clock span (start, end) in milliseconds from the wire
/// message timestamps (the replay path carries `timestamp` on every
/// stored assistant and toolResult message - reading existing fields
/// only, no schema change): `None` unless EVERY card carries both
/// stamps.
fn wire_span_ms(cards: &[&ToolCallCard]) -> Option<(u64, u64)> {
    let mut start: Option<u64> = None;
    let mut end: Option<u64> = None;
    for card in cards {
        let started = card.started_ms?;
        let ended = card.ended_ms?;
        start = Some(start.map_or(started, |seen: u64| seen.min(started)));
        end = Some(end.map_or(ended, |seen: u64| seen.max(ended)));
    }
    Some((start?, end?))
}

/// The run's wall-clock in milliseconds: the wire span when every card
/// carries both stamps - EXTENDED to `now` while the run is live (the
/// block keeps working: a still-running background shell, so the
/// elapsed clock runs on instead of freezing at the last settled
/// stamp) - else the live instants.
fn wall_ms(cards: &[&ToolCallCard], live: bool) -> Option<u64> {
    match wire_span_ms(cards) {
        Some((start, end)) => Some(if live {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as u64)
                .unwrap_or(end);
            now.max(end).saturating_sub(start)
        } else {
            end.saturating_sub(start)
        }),
        None => instant_wall_ms(cards, live),
    }
}

/// Derive the condensed block's summary from the run's entries.
pub fn run_summary(chat: &[ChatEntry], run: ToolRun) -> RunSummary {
    let cards: Vec<&ToolCallCard> = chat[run.start..run.end]
        .iter()
        .filter_map(|entry| match entry {
            ChatEntry::Tool(card) => Some(card.as_ref()),
            _ => None,
        })
        .collect();
    let mut live = false;
    let mut failed = false;
    for card in &cards {
        match crate::tool_card::panel_status(card) {
            crate::tool_card::PanelStatus::Queued | crate::tool_card::PanelStatus::Running => {
                live = true;
            }
            crate::tool_card::PanelStatus::Error => failed = true,
            crate::tool_card::PanelStatus::Done => {}
        }
        // An ipython card whose final result carries a still-running
        // background shell keeps the run live: the cell settled, but
        // the renderer's own status for the card is Running (the
        // no-exit-code shell case) - the block keeps animating and the
        // wall-clock keeps running.
        if crate::tool_card::ipython::background_shell_running(card) {
            live = true;
        }
    }
    let wall_clock = wall_ms(&cards, live);
    let mut classes: Vec<ClassCount> = Vec::new();
    for card in &cards {
        let label = class_label(card);
        match classes.iter_mut().find(|class| class.label == label) {
            Some(class) => class.count += 1,
            None => classes.push(ClassCount { label, count: 1 }),
        }
    }
    let (sent, queued) = message_receipts(&cards);
    if sent > 0 {
        classes.push(ClassCount {
            label: "agent messages sent".to_string(),
            count: sent,
        });
    }
    if queued > 0 {
        classes.push(ClassCount {
            label: "agent messages queued".to_string(),
            count: queued,
        });
    }
    RunSummary {
        calls: run.calls,
        live,
        failed,
        wall_ms: wall_clock,
        classes,
    }
}

/// The summary row's glyph (the tool-card marker vocabulary): an error
/// marker when any card failed (error wins even while the run streams,
/// the panel-status semantics), the working icon while the run is live,
/// the settled check otherwise.
fn status_glyph(summary: &RunSummary, frame: usize) -> (&'static str, ThemeColor) {
    if summary.failed {
        ("\u{2717}", ThemeColor::Error)
    } else if summary.live {
        (crate::chat::working_icon_frame(frame), ThemeColor::BashMode)
    } else {
        ("\u{2713}", ThemeColor::Success)
    }
}

/// The wall-clock label: the working loader's elapsed format (`3s`,
/// `1m 05s`, `1h 02m 03s`).
fn wall_label(wall_ms: Option<u64>) -> Option<String> {
    wall_ms.map(|ms| crate::chat::format_working_elapsed(ms / 1000))
}

/// The breakdown row's class text: `8 python \u{b7} 3 bash \u{b7} 2 agent
/// messages sent`.
pub fn class_text(summary: &RunSummary) -> String {
    summary
        .classes
        .iter()
        .map(|class| format!("{} {}", class.count, class.label))
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

/// The breakdown row's full text: the class counts plus the drill-in
/// hint (`8 python \u{b7} 2 agent messages sent \u{b7} Alt+T to expand`).
fn breakdown_text(summary: &RunSummary, expand_hint: &str) -> String {
    let mut text = class_text(summary);
    if !expand_hint.is_empty() {
        if !text.is_empty() {
            text.push_str(" \u{b7} ");
        }
        text.push_str(expand_hint);
    }
    text
}

/// The summary row: `<glyph> <N> tool calls \u{b7} <wall-clock>`. The
/// row leads with the one-column chat margin span (the runs view skips
/// it when the row rides its own list indent).
pub fn render_summary_row(summary: &RunSummary, frame: usize, theme: &Theme, width: usize) -> Line {
    let muted = theme.fg_style(ThemeColor::Muted);
    let dim = theme.fg_style(ThemeColor::Dim);
    let (glyph, color) = status_glyph(summary, frame);
    let mut row: Line = vec![Span::raw(" ")];
    row.push(Span::styled(glyph.to_string(), theme.fg_style(color)));
    row.push(Span::raw(" "));
    row.push(Span::styled(format!("{} tool calls", summary.calls), muted));
    if let Some(label) = wall_label(summary.wall_ms) {
        row.push(Span::styled(" \u{b7} ".to_string(), dim));
        row.push(Span::styled(label, dim));
    }
    truncate_line(&row, width, "")
}

/// The breakdown rows: the class text plus the drill-in hint, wrapped at
/// the branch content width and hung on the dim branch gutter.
fn breakdown_rows(text: &str, theme: &Theme, width: usize) -> Vec<Line> {
    if text.is_empty() {
        return Vec::new();
    }
    let dim = theme.fg_style(ThemeColor::Dim);
    let content_width = crate::branch::branch_content_width(width);
    let source = vec![Span::styled(text.to_string(), dim)];
    let wrapped = wrap_line(&source, content_width);
    let mut rows: Vec<Line> = Vec::new();
    for (index, line) in wrapped.into_iter().enumerate() {
        let mut row: Line = vec![Span::raw(" ")];
        if index == 0 {
            row.push(Span::styled(crate::branch::BRANCH_GUTTER.to_string(), dim));
        } else {
            row.push(Span::raw(crate::branch::BRANCH_CONTINUATION.to_string()));
        }
        row.extend(line);
        rows.push(truncate_line(&row, width, ""));
    }
    rows
}

/// Paint the condensed block's rows (the leading spacer rides the
/// caller's conversation-spacing decision, like a tool card's).
pub fn render_run_block(
    summary: &RunSummary,
    frame: usize,
    expand_hint: &str,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let mut rows = Vec::with_capacity(2);
    rows.push(render_summary_row(summary, frame, theme, width));
    rows.extend(breakdown_rows(
        &breakdown_text(summary, expand_hint),
        theme,
        width,
    ));
    rows
}

/// The condensed block's row count without painting.
pub fn run_block_rows(summary: &RunSummary, expand_hint: &str, width: usize) -> usize {
    let text = breakdown_text(summary, expand_hint);
    if text.is_empty() {
        1
    } else {
        1 + wrapped_line_count(
            &vec![Span::raw(text)],
            crate::branch::branch_content_width(width),
        )
    }
}

/// The per-entry run map over a chat vector, rebuilt from the earliest
/// point a mutation can change a run's shape (a run never changes before
/// the first mutated entry).
#[derive(Debug, Clone, Default)]
pub struct ToolRuns {
    slots: Vec<RunSlot>,
}

impl ToolRuns {
    /// The slot classification of one entry.
    pub fn slot(&self, index: usize) -> Option<RunSlot> {
        self.slots.get(index).copied()
    }

    /// The qualifying run whose block starts at `index`.
    pub fn run_at(&self, index: usize) -> Option<ToolRun> {
        match self.slot(index) {
            Some(RunSlot::Start(run)) => Some(run),
            _ => None,
        }
    }

    /// The owning run-start index for a member entry (`None` for solo
    /// entries and out-of-range indices). A member walks at most its own
    /// run's length backwards.
    pub fn block_owner(&self, index: usize) -> Option<usize> {
        match self.slot(index) {
            Some(RunSlot::Start(_)) => Some(index),
            Some(RunSlot::Member) => (0..=index).rev().find_map(|candidate| {
                self.slot(candidate)
                    .filter(|slot| matches!(slot, RunSlot::Start(_)))
                    .map(|_| candidate)
            }),
            _ => None,
        }
    }

    /// Rebuild the map's suffix from `from` over `chat`: the prefix keeps
    /// its classification. Call AFTER the chat vector itself changed.
    /// A tail member sequence ending at `from` can extend across the
    /// mutation point, so the rebuild point first rolls back over it -
    /// the whole affected run re-derives from its own start (callers
    /// that already pass a walked-back start stay idempotent).
    pub fn rebuild_from(&mut self, chat: &[ChatEntry], from: usize) {
        let mut from = from.min(chat.len());
        while from > 0 && is_run_glue(&chat[from - 1]) {
            from -= 1;
        }
        self.slots.truncate(from);
        let mut index = self.slots.len();
        while index < chat.len() {
            match scan_run(chat, index) {
                None => {
                    self.slots.push(RunSlot::Solo);
                    index += 1;
                }
                Some(run) => {
                    if run.qualifies() {
                        self.slots.push(RunSlot::Start(run));
                        for _ in run.start + 1..run.end {
                            self.slots.push(RunSlot::Member);
                        }
                    } else {
                        for _ in run.start..run.end {
                            self.slots.push(RunSlot::Solo);
                        }
                    }
                    index = run.end;
                }
            }
        }
    }
}

/// The maximal tool run starting at `start` (a tool entry), scanning over
/// zero-row assistant glue between cards; `None` when `start` is not a
/// run member at all (an orphan result card seeds nothing - it keeps
/// its standalone row).
fn scan_run(chat: &[ChatEntry], start: usize) -> Option<ToolRun> {
    match &chat[start] {
        ChatEntry::Tool(card) if !card.unmatched_result => {}
        _ => return None,
    }
    let mut end = start + 1;
    let mut calls = 1;
    while end < chat.len() {
        match &chat[end] {
            // An orphan result card keeps its standalone row: it is not
            // a call, so it BREAKS the run like any other self-rendering
            // entry (never a member, never counted).
            ChatEntry::Tool(card) if card.unmatched_result => break,
            ChatEntry::Tool(_) => {
                calls += 1;
                end += 1;
            }
            glue if is_run_glue(glue) => {
                // The glue binds only when another CARD follows it: a
                // trailing hidden assistant stays its own (zero-row)
                // entry, exactly as the uncondensed view renders it. The
                // probe skips hidden-assistant chains only - a card ends
                // the probe and the scan continues through the main loop.
                let mut probe = end + 1;
                while probe < chat.len()
                    && is_run_glue(&chat[probe])
                    && !matches!(chat[probe], ChatEntry::Tool(_))
                {
                    probe += 1;
                }
                if matches!(chat.get(probe), Some(ChatEntry::Tool(_))) {
                    end = probe;
                } else {
                    break;
                }
            }
            _ => break,
        }
    }
    Some(ToolRun { start, end, calls })
}

#[cfg(test)]
mod tests;
