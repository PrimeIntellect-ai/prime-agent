//! The queued-message strip above the prompt dock (TS
//! `updatePendingMessagesDisplay`): the picked-up prompt whose turn is
//! still preparing renders as the "Starting" row (TS #2063), then every
//! human-typed steering/follow-up
//! message parked behind the running turn renders as a preview row - dim,
//! with the TS prompt-highlight styling on top (a leading slash command
//! in accent, `@path`/`--flag` argument tokens in their own colors) - with
//! one hint row below them. The queued internal prompts (heartbeat fires,
//! agent messages, goal contexts, background-command notices) condense
//! into the single counted row instead of preview rows, so the strip
//! stays about what the user typed (the condensed row renders after the
//! human previews). The strip is empty (renders nothing) when
//! the queue is empty, so delivered messages make it disappear.
//!
//! The condensation is a SANCTIONED DIVERGENCE from TS (operator request,
//! Kevin 2026-09-24, queue-condensed-display; per-origin counts refined
//! 2026-09-25): TS renders every internal prompt as its own preview row
//! too; Rust renders one counted row naming each origin with its own
//! plural-correct count - "1 agent message, 1 heartbeat, and 1 other
//! internal prompt queued" - so the visual queue prioritizes
//! human-inserted prompts. The classifier
//! is TS `isLabeledQueuedPreview` on the preview string (the wire carries
//! no provenance), so a human-typed prompt that begins with one of the
//! internal labels condenses too - it still delivers, and the browse
//! affordance walks and shows it. The
//! browse/edit affordances TS gives the strip (TS `QueueSelection`,
//! alt+up/alt+down to pick a parked message, ctrl+alt+arrows to reorder,
//! Enter to steer the edit, the follow-up key to park it) still walk every
//! queued item, internal prompts included: the selection state is owned by
//! the session UI and projected to the view as the dimmed browse header,
//! and only the strip rows condense.

use crate::theme::{Theme, ThemeColor};
use crate::width::{pad_line, truncate_line};
use crate::Line;

/// The dim preview label for messages parked on the steering lane.
pub const STEERING_LABEL: &str = "Steering";
/// The dim preview label for messages parked on the follow-up lane.
pub const FOLLOW_UP_LABEL: &str = "Follow-up";
/// The dim preview label for the picked-up prompt whose turn is preparing
/// (TS #2063 `Starting`): the queued strip keeps showing the prompt the
/// pump selected while it is still on its way into the conversation.
pub const STARTING_LABEL: &str = "Starting";

/// The origin of a queued internal prompt, classified by its preview
/// label (the wire carries no provenance - the label is the classifier):
/// what the condensed row counts the prompt as.
#[derive(Debug, Clone, Copy)]
enum InternalPromptOrigin {
    /// An `Agent message received: ` preview.
    AgentMessage,
    /// A `Heartbeat prompt: ` preview.
    Heartbeat,
    /// Every other internal prompt: `Goal context: ` and
    /// `Background command finished: ` previews.
    Other,
}

/// TS `HEARTBEAT_PROMPT_PREVIEW_LABEL` & co.: internal prompts that queue
/// with their own visible label render as-is (no lane label prepended),
/// each paired with the origin the condensed row counts it as.
const LABELED_PREVIEW_PREFIXES: [(&str, InternalPromptOrigin); 4] = [
    ("Heartbeat prompt: ", InternalPromptOrigin::Heartbeat),
    ("Goal context: ", InternalPromptOrigin::Other),
    (
        "Agent message received: ",
        InternalPromptOrigin::AgentMessage,
    ),
    ("Background command finished: ", InternalPromptOrigin::Other),
];

/// TS `isLabeledQueuedPreview`: the queued prompt's origin when it
/// carries an internal label, `None` when it is human-typed.
fn internal_prompt_origin(message: &str) -> Option<InternalPromptOrigin> {
    LABELED_PREVIEW_PREFIXES
        .iter()
        .find(|(prefix, _)| message.starts_with(prefix))
        .map(|(_, origin)| *origin)
}

/// The queued internal prompts' counts by origin across both lanes, or
/// `None` when every queued message is human-typed.
#[derive(Debug, Default)]
struct CondensedCounts {
    agent_messages: usize,
    heartbeats: usize,
    other: usize,
}

impl CondensedCounts {
    /// The counted row's text: each origin with queued prompts and its
    /// count, plural-correct (only a count of one reads singular - a
    /// listed `0` would read plural too), in the fixed agent-message,
    /// heartbeat, other order, joined into one concise line. A
    /// zero-count origin never lists.
    fn row_text(&self) -> String {
        let mut parts = [
            (self.agent_messages, InternalPromptOrigin::AgentMessage),
            (self.heartbeats, InternalPromptOrigin::Heartbeat),
            (self.other, InternalPromptOrigin::Other),
        ]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, origin)| {
            let name = match origin {
                InternalPromptOrigin::AgentMessage => "agent message",
                InternalPromptOrigin::Heartbeat => "heartbeat",
                InternalPromptOrigin::Other => "other internal prompt",
            };
            let plural = if count == 1 { "" } else { "s" };
            format!("{count} {name}{plural}")
        })
        .collect::<Vec<_>>();
        let last = parts.len() - 1;
        if last > 0 {
            parts[last] = format!("and {}", parts[last]);
        }
        // Two origins read "1 heartbeat and 1 other internal prompt" - the
        // comma-list phrasing starts at three ("A, B, and C").
        let list_separator = if parts.len() == 2 { " " } else { ", " };
        format!("{} queued", parts.join(list_separator))
    }
}

/// Count every queued internal prompt by origin across both lanes, or
/// `None` when every queued message is human-typed.
fn condensed_counts(queue: &QueuedMessages) -> Option<CondensedCounts> {
    let mut counts = CondensedCounts::default();
    for origin in queue
        .steering
        .iter()
        .chain(queue.follow_ups.iter())
        .filter_map(|message| internal_prompt_origin(message))
    {
        match origin {
            InternalPromptOrigin::AgentMessage => counts.agent_messages += 1,
            InternalPromptOrigin::Heartbeat => counts.heartbeats += 1,
            InternalPromptOrigin::Other => counts.other += 1,
        }
    }
    (counts.agent_messages + counts.heartbeats + counts.other > 0).then_some(counts)
}

/// TS `formatQueuedMessagePreview`: the lane label plus the message, or
/// the message itself when it carries an internal label.
pub fn format_queued_message_preview(message: &str, label: &str) -> String {
    if internal_prompt_origin(message).is_some() {
        message.to_string()
    } else {
        format!("{label}: {message}")
    }
}

/// The queued input lanes as the session reports them
/// (`sessionActions.steering` / `.followUps`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueuedMessages {
    /// Messages delivered at the next turn boundary (Enter while busy).
    pub steering: Vec<String>,
    /// Messages delivered when the run goes idle (the follow-up key).
    pub follow_ups: Vec<String>,
    /// The picked-up prompt whose turn is still preparing (TS #2063
    /// `sessionActions.active` with `kind: "turn"` and
    /// `phase: "preparing"`): the strip keeps it visible as its
    /// "Starting" row until the turn's rows land — the prompt left its
    /// lane at pickup, so without the row it would be visible nowhere
    /// until the turn renders it. Not browsable: the browse affordances
    /// walk the parked lanes only (the prompt is already delivered).
    pub starting: Option<String>,
}

impl QueuedMessages {
    pub fn is_empty(&self) -> bool {
        self.steering.is_empty() && self.follow_ups.is_empty()
    }
}

/// TS `QueueLane`: one of the two queue lanes, by its wire name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueLane {
    Steering,
    FollowUp,
}

impl QueueLane {
    /// The wire name (`"steering"` / `"followUp"`).
    pub fn wire_name(&self) -> &'static str {
        match self {
            QueueLane::Steering => "steering",
            QueueLane::FollowUp => "followUp",
        }
    }

    /// The browse-header display name (TS `getQueueSelectionHeader`).
    pub fn display_name(&self) -> &'static str {
        match self {
            QueueLane::Steering => "steering",
            QueueLane::FollowUp => "follow-up",
        }
    }
}

/// One addressable queue item (TS `QueueSelectionItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueSelectionItem {
    pub lane: QueueLane,
    pub index: usize,
    pub text: String,
}

/// The strip rows (TS `queuedMessagesContainer`): one blank spacer, the
/// "Starting" row of a preparing turn (TS #2063) above a truncated dim
/// preview per human-typed queued message, the one condensed
/// internal-prompt row, and the queue hint. Empty input renders no rows
/// at all — a preparing turn alone still renders its row (the strip is
/// the only place the picked-up prompt is visible until its turn runs),
/// but never the hint (there is nothing parked to browse).
/// `browse_key` is the effective binding display for
/// `app.message.navigateOlder` (user overrides show).
pub fn render_queue(
    theme: &Theme,
    queue: &QueuedMessages,
    browse_key: &str,
    width: usize,
) -> Vec<Line> {
    if queue.is_empty() && queue.starting.is_none() {
        return Vec::new();
    }
    let mut rows = vec![Vec::new()];
    // The preparing turn's prompt renders first (TS #2063: a queued
    // prompt leaves its lane at pickup, and its own pre-turn work can
    // hold it out of the conversation for a while — the "Starting" row
    // keeps it visible there until the turn begins).
    if let Some(starting) = queue.starting.as_deref() {
        rows.push(preview_row(theme, STARTING_LABEL, starting, width));
    }
    // The human-typed previews (the non-labeled messages) render
    // individually, so what the user parked stays explicit and
    // prioritized above the condensed row.
    for message in queue
        .steering
        .iter()
        .filter(|message| internal_prompt_origin(message).is_none())
    {
        rows.push(preview_row(theme, STEERING_LABEL, message, width));
    }
    for message in queue
        .follow_ups
        .iter()
        .filter(|message| internal_prompt_origin(message).is_none())
    {
        rows.push(preview_row(theme, FOLLOW_UP_LABEL, message, width));
    }
    if let Some(counts) = condensed_counts(queue) {
        rows.push(condensed_row(theme, &counts, width));
    }
    if queue.is_empty() {
        // A starting row alone carries no parked messages to browse.
        return rows;
    }
    let hint = format!("\u{2570}\u{2500} {browse_key} to browse and edit queued messages");
    let hint_line: crate::Line = vec![
        crate::Span::raw(" ".repeat(width.min(1))),
        crate::Span::styled(hint, theme.fg_style(ThemeColor::Dim)),
    ];
    rows.push(pad_line(
        truncate_line(&hint_line, width.saturating_sub(1), "..."),
        width,
    ));
    rows
}

/// The browse header text (TS `getQueueSelectionHeader`, the editor header
/// line while a queued message is selected): the lane, its 1-based index,
/// and the effective keys for the affordances.
pub fn browse_header_text(selected: &QueueSelectionItem, key_display: &QueueBrowseKeys) -> String {
    format!(
        "{} {} \u{00b7} {}/{} browse \u{00b7} {}/{} reorder \u{00b7} enter steers \u{00b7} {} queues \u{00b7} empty deletes",
        selected.lane.display_name(),
        selected.index + 1,
        key_display.navigate_older,
        key_display.navigate_newer,
        key_display.move_earlier,
        key_display.move_later,
        key_display.follow_up,
    )
}

/// The effective key displays the browse header quotes.
#[derive(Debug, Clone)]
pub struct QueueBrowseKeys {
    pub navigate_older: String,
    pub navigate_newer: String,
    pub move_earlier: String,
    pub move_later: String,
    pub follow_up: String,
}

/// One styled preview row (TS
/// `TruncatedText(styleQueuedMessagePreview(...), 1, 0)`): the labeled
/// message's first line with the TS prompt-highlight styling (dim base,
/// accent on a leading recognized command's `/name` segment, colored
/// argument tokens), truncated with `...` to the padded content width, with
/// a plain 1-col left pad and the row padded to the full width.
fn preview_row(theme: &Theme, label: &str, message: &str, width: usize) -> Line {
    let text = match message.split_once('\n') {
        Some((first_line, _)) => first_line,
        None => message,
    };
    let padding_x = width.min(1);
    let mut line: crate::Line = vec![crate::Span::raw(" ".repeat(padding_x))];
    line.extend(crate::prompt_highlight::style_queued_message_preview(
        theme, text, label,
    ));
    // The right pad keeps the row at the full width like TS
    // (`lineWithPadding + paddingNeeded`), so 1 left pad + content cut to
    // `width - 1` leaves the trailing space.
    pad_line(truncate_line(&line, width.saturating_sub(1), "..."), width)
}

/// The condensed internal-prompt row (the sanctioned divergence, see the
/// module docs): one dim line carrying the queued internal prompts'
/// counts by origin instead of one preview row each, so the strip's
/// per-message rows stay about the human prompts. Truncated and padded
/// like a preview row.
fn condensed_row(theme: &Theme, counts: &CondensedCounts, width: usize) -> Line {
    let line: crate::Line = vec![
        crate::Span::raw(" ".repeat(width.min(1))),
        crate::Span::styled(counts.row_text(), theme.fg_style(ThemeColor::Dim)),
    ];
    pad_line(truncate_line(&line, width.saturating_sub(1), "..."), width)
}

/// Browse direction: `Older` moves toward the oldest steering message,
/// `Newer` toward the draft (TS `move(queue, draft, -1 | 1)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueBrowseDirection {
    Older,
    Newer,
}

/// Port of TS `QueueSelection`: which parked message the user is browsing
/// with alt+up/alt+down. Items are addressed by (lane, index, text) - the
/// text is the authoritative check when a mutation is applied, so no ids
/// or revisions are needed. Browsing order is newest-first: draft -> last
/// follow-up -> ... -> first steering.
#[derive(Debug, Default)]
pub struct QueueSelection {
    items: Vec<QueueSelectionItem>,
    /// `None` = the draft; `Some(cursor)` indexes [`Self::items`].
    cursor: Option<usize>,
    draft: String,
    has_stashed_draft: bool,
}

impl QueueSelection {
    pub fn selected(&self) -> Option<&QueueSelectionItem> {
        self.cursor.and_then(|cursor| self.items.get(cursor))
    }

    pub fn is_browsing(&self) -> bool {
        self.cursor.is_some()
    }

    pub fn has_draft(&self) -> bool {
        self.has_stashed_draft
    }

    pub fn replace_draft(&mut self, draft: String) {
        self.draft = draft;
        self.has_stashed_draft = true;
    }

    /// Move the cursor. Returns the text to show, or `None` for a boundary
    /// noop; reaching the draft end the browse (the stashed draft returns).
    pub fn browse(
        &mut self,
        queue: &QueuedMessages,
        draft: &str,
        direction: QueueBrowseDirection,
    ) -> Option<String> {
        match (self.cursor, direction) {
            // Browsing newer than the draft is a noop.
            (None, QueueBrowseDirection::Newer) => None,
            // Leaving the draft stashes the current editor text first.
            (None, QueueBrowseDirection::Older) => {
                self.items = flatten(queue);
                if self.items.is_empty() {
                    return None;
                }
                if !self.has_stashed_draft {
                    self.draft = draft.to_string();
                    self.has_stashed_draft = true;
                }
                let last = self.items.len() - 1;
                self.cursor = Some(last);
                self.items.get(last).map(|item| item.text.clone())
            }
            (Some(cursor), direction) => {
                let next = match direction {
                    QueueBrowseDirection::Older => cursor.checked_sub(1),
                    QueueBrowseDirection::Newer => Some(cursor + 1),
                };
                match next {
                    // Older than the oldest steering message is a noop.
                    None => None,
                    // Newer than the newest follow-up lands back on the
                    // draft: restore it and end the browse.
                    Some(next) if next > self.items.len() - 1 => Some(self.reset()),
                    Some(next) => {
                        self.cursor = Some(next);
                        self.items.get(next).map(|item| item.text.clone())
                    }
                }
            }
        }
    }

    /// Re-point the selection after a mutation or queue update. The
    /// selection survives only when the addressed item is unchanged; a stale
    /// selection resets and returns the stashed draft (TS `refreshAt`).
    pub fn refresh_at(
        &mut self,
        queue: &QueuedMessages,
        lane: QueueLane,
        index: usize,
        expected_text: &str,
    ) -> Option<String> {
        self.items = flatten(queue);
        let cursor = match lane {
            QueueLane::Steering => Some(index),
            QueueLane::FollowUp => queue.steering.len().checked_add(index),
        };
        let selected = cursor.and_then(|cursor| self.items.get(cursor));
        if selected.is_some_and(|item| {
            item.lane == lane && item.index == index && item.text == expected_text
        }) {
            self.cursor = cursor;
            None
        } else {
            Some(self.reset())
        }
    }

    /// Resolve the selection; returns the stashed draft (TS `reset`).
    pub fn reset(&mut self) -> String {
        self.cursor = None;
        self.has_stashed_draft = false;
        std::mem::take(&mut self.draft)
    }
}

/// Mirror one applied lane move locally (TS
/// `moveQueueSelection`'s local mirror): swap the item with its neighbor so
/// the strip and the selection update without waiting for the
/// `session_action_update` event. Out-of-range targets are a no-op (the
/// daemon already rejected them).
pub fn mirror_lane_move(queue: &mut QueuedMessages, lane: QueueLane, index: usize, target: i64) {
    if target < 0 {
        return;
    }
    let target = target as usize;
    let lane_items = match lane {
        QueueLane::Steering => &mut queue.steering,
        QueueLane::FollowUp => &mut queue.follow_ups,
    };
    if index < lane_items.len() && target < lane_items.len() && index != target {
        lane_items.swap(index, target);
    }
}

/// The flattened browse order (TS `flatten`): steering lane first, then the
/// follow-up lane, both oldest-first, so the last item is the newest
/// follow-up and the cursor walks newest-first down to the oldest steering.
fn flatten(queue: &QueuedMessages) -> Vec<QueueSelectionItem> {
    let steering = queue
        .steering
        .iter()
        .enumerate()
        .map(|(index, text)| QueueSelectionItem {
            lane: QueueLane::Steering,
            index,
            text: text.clone(),
        });
    let follow_up = queue
        .follow_ups
        .iter()
        .enumerate()
        .map(|(index, text)| QueueSelectionItem {
            lane: QueueLane::FollowUp,
            index,
            text: text.clone(),
        });
    steering.chain(follow_up).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn queue() -> QueuedMessages {
        QueuedMessages {
            steering: vec!["turn right".to_string()],
            follow_ups: vec!["then summarize".to_string()],
            starting: None,
        }
    }

    #[test]
    fn empty_queue_renders_no_rows() {
        assert!(render_queue(&theme(), &QueuedMessages::default(), "alt+up", 80).is_empty());
    }

    /// TS #2063 (RES-1306): a picked-up prompt leaves its lane at
    /// delivery, so while its turn is still preparing the strip is the
    /// only place it is visible — it renders as the "Starting" row, the
    /// first row of the strip, and never carries the browse hint (nothing
    /// is parked to browse).
    #[test]
    fn a_preparing_turn_renders_the_starting_row_alone() {
        let queue = QueuedMessages {
            steering: Vec::new(),
            follow_ups: Vec::new(),
            starting: Some("queued before compaction".to_string()),
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 80);
        assert_eq!(rows.len(), 2, "spacer + the starting row, no hint");
        let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        assert_eq!(text.trim(), "Starting: queued before compaction");
    }

    /// The "Starting" row renders above the parked lanes, and the hint
    /// follows the parked lanes as before.
    #[test]
    fn the_starting_row_renders_above_the_parked_lanes() {
        let queue = QueuedMessages {
            steering: Vec::new(),
            follow_ups: vec!["then summarize".to_string()],
            starting: Some("queued before compaction".to_string()),
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 80);
        assert_eq!(rows.len(), 4, "spacer + starting + follow-up + hint");
        let starting: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        assert_eq!(starting.trim(), "Starting: queued before compaction");
        let follow_up: String = rows[2].iter().map(|span| span.content.as_str()).collect();
        assert_eq!(follow_up.trim(), "Follow-up: then summarize");
        assert!(crate::ansi::line_to_ansi(&rows[3]).contains("to browse and edit queued messages"));
    }

    /// The strip drops the "Starting" row the moment the projection no
    /// longer reports a preparing turn (the phase left `preparing`).
    #[test]
    fn the_starting_row_drops_with_the_projection() {
        let rows = render_queue(
            &theme(),
            &QueuedMessages {
                steering: Vec::new(),
                follow_ups: Vec::new(),
                starting: None,
            },
            "alt+up",
            80,
        );
        assert!(rows.is_empty());
    }

    #[test]
    fn queue_renders_labels_and_hint() {
        let rows = render_queue(&theme(), &queue(), "alt+up", 80);
        assert_eq!(rows.len(), 4, "spacer + two previews + hint");
        let expected: crate::Line = crate::width::pad_line(
            vec![
                crate::Span::raw(" "),
                crate::Span::styled(
                    "Steering: turn right".to_string(),
                    theme().fg_style(ThemeColor::Dim),
                ),
            ],
            80,
        );
        assert_eq!(
            rows[1], expected,
            "the steering preview is indented, dim, labeled and padded"
        );
        assert!(crate::ansi::line_to_ansi(&rows[2]).contains("Follow-up: then summarize"));
        let expected_hint: crate::Line = crate::width::pad_line(
            vec![
                crate::Span::raw(" "),
                crate::Span::styled(
                    "\u{2570}\u{2500} alt+up to browse and edit queued messages".to_string(),
                    theme().fg_style(ThemeColor::Dim),
                ),
            ],
            80,
        );
        assert_eq!(rows[3], expected_hint, "the hint row matches TS");
    }

    #[test]
    fn slash_previews_render_the_command_segment_in_accent() {
        let queue = QueuedMessages {
            steering: vec!["/hotkeys".to_string()],
            follow_ups: vec!["fix @Cargo.toml --quiet".to_string()],
            starting: None,
        };
        let theme = theme();
        let rows = render_queue(&theme, &queue, "alt+up", 80);
        assert_eq!(rows.len(), 4);
        let expected_command: crate::Line = crate::width::pad_line(
            vec![
                crate::Span::raw(" "),
                theme.fg_span(ThemeColor::Dim, "Steering: "),
                theme.fg_span(ThemeColor::Accent, "/hotkeys"),
            ],
            80,
        );
        assert_eq!(
            rows[1], expected_command,
            "a recognized command previews dim-labeled with its accent segment"
        );
        let expected_plain: crate::Line = crate::width::pad_line(
            vec![
                crate::Span::raw(" "),
                theme.fg_span(ThemeColor::Dim, "Follow-up: fix "),
                theme.fg_span(ThemeColor::Success, "@Cargo.toml"),
                theme.fg_span(ThemeColor::Dim, " "),
                theme.fg_span(ThemeColor::MdLink, "--quiet"),
            ],
            80,
        );
        assert_eq!(
            rows[2], expected_plain,
            "a plain preview stays dim with its argument tokens colored"
        );
    }

    #[test]
    fn long_previews_truncate_with_ellipsis() {
        let queue = QueuedMessages {
            steering: vec!["x".repeat(100)],
            follow_ups: Vec::new(),
            starting: None,
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 30);
        assert_eq!(rows.len(), 3);
        let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        // The row pads to the width like TS (a trailing pad column follows
        // the ellipsis), so the check strips the pad.
        assert!(
            text.trim_end().ends_with("..."),
            "truncated with ellipsis: {text}"
        );
        assert!(
            crate::width::line_width(&rows[1]) <= 30,
            "row fits the width"
        );
    }

    #[test]
    fn multiline_preview_renders_its_first_line() {
        let queue = QueuedMessages {
            steering: vec!["first line\nsecond line".to_string()],
            follow_ups: Vec::new(),
            starting: None,
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 80);
        let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        assert_eq!(text.trim(), "Steering: first line");
    }

    #[test]
    fn labeled_internal_prompts_keep_their_own_label() {
        assert_eq!(
            format_queued_message_preview("Heartbeat prompt: tick", STEERING_LABEL),
            "Heartbeat prompt: tick"
        );
        assert_eq!(
            format_queued_message_preview("run tests", FOLLOW_UP_LABEL),
            "Follow-up: run tests"
        );
        // The strip itself no longer renders internal prompts as their
        // own rows (the sanctioned divergence): the condensation tests
        // below own that behavior.
    }

    #[test]
    fn internal_prompts_condense_into_one_counted_row() {
        let queue = QueuedMessages {
            steering: vec![
                "Heartbeat prompt: [heartbeat: every 10m run#0]\n\nnudge".to_string(),
                "Agent message received: the research is done".to_string(),
            ],
            follow_ups: vec!["Goal context: milestone".to_string()],
            starting: None,
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 80);
        assert_eq!(
            rows.len(),
            3,
            "spacer + the one condensed row + hint, no per-prompt rows"
        );
        let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        assert_eq!(
            text.trim(),
            "1 agent message, 1 heartbeat, and 1 other internal prompt queued",
            "one line counts each origin across both lanes, each singular"
        );
        let joined = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !joined.contains("nudge")
                && !joined.contains("research")
                && !joined.contains("milestone"),
            "the internal prompts' content never reaches the strip: {joined}"
        );
    }

    #[test]
    fn human_prompts_render_before_the_condensed_row() {
        let queue = QueuedMessages {
            steering: vec![
                "Heartbeat prompt: nudge".to_string(),
                "turn right".to_string(),
            ],
            follow_ups: vec![
                "then summarize".to_string(),
                "Background command finished: sleep done".to_string(),
            ],
            starting: None,
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 80);
        assert_eq!(
            rows.len(),
            5,
            "spacer + two human previews + condensed + hint"
        );
        let texts: Vec<String> = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect();
        assert_eq!(texts[1].trim(), "Steering: turn right");
        assert_eq!(texts[2].trim(), "Follow-up: then summarize");
        assert_eq!(
            texts[3].trim(),
            "1 heartbeat and 1 other internal prompt queued",
            "the counts name the queued origins only - no agent message queued"
        );
        assert!(
            texts[4]
                .trim()
                .starts_with("\u{2570}\u{2500} alt+up to browse"),
            "the hint stays the strip's last row"
        );
    }

    #[test]
    fn condensed_row_counts_each_origin_with_correct_plurals() {
        let queue = QueuedMessages {
            steering: vec![
                "Agent message received: one".to_string(),
                "Agent message received: two".to_string(),
                "Agent message received: three".to_string(),
                "Heartbeat prompt: nudge".to_string(),
                "Goal context: milestone".to_string(),
                "Goal context: next".to_string(),
            ],
            follow_ups: vec!["Heartbeat prompt: again".to_string()],
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 80);
        assert_eq!(rows.len(), 3);
        let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        assert_eq!(
            text.trim(),
            "3 agent messages, 2 heartbeats, and 2 other internal prompts queued",
            "each origin's count sums across both lanes and pluralizes"
        );
    }

    #[test]
    fn one_queued_agent_message_reads_singular() {
        let queue = QueuedMessages {
            steering: vec!["Agent message received: hi".to_string()],
            follow_ups: Vec::new(),
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 80);
        assert_eq!(rows.len(), 3);
        let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        assert_eq!(text.trim(), "1 agent message queued");
    }

    #[test]
    fn condensed_row_truncates_to_the_width() {
        let queue = QueuedMessages {
            steering: vec![
                "Heartbeat prompt: nudge".to_string(),
                "Agent message received: done".to_string(),
            ],
            follow_ups: vec![],
            starting: None,
        };
        let rows = render_queue(&theme(), &queue, "alt+up", 30);
        assert_eq!(rows.len(), 3);
        let text: String = rows[1].iter().map(|span| span.content.as_str()).collect();
        assert!(
            text.trim_end().ends_with("..."),
            "the condensed row truncates with an ellipsis: {text}"
        );
        assert!(
            crate::width::line_width(&rows[1]) <= 30,
            "the row fits the width"
        );
    }

    #[test]
    fn internal_prompts_stay_browseable_when_condensed() {
        let queue = QueuedMessages {
            steering: vec![
                "Heartbeat prompt: nudge".to_string(),
                "turn right".to_string(),
            ],
            follow_ups: vec!["then summarize".to_string()],
            starting: None,
        };
        let mut selection = QueueSelection::default();
        // Browsing still walks every queued item newest-first, the
        // condensed internal prompt included (only the strip rows
        // condense): draft -> follow-up -> steering, newest to oldest.
        let text = selection.browse(&queue, "draft", QueueBrowseDirection::Older);
        assert_eq!(text.as_deref(), Some("then summarize"));
        let text = selection.browse(&queue, "", QueueBrowseDirection::Older);
        assert_eq!(text.as_deref(), Some("turn right"));
        let text = selection.browse(&queue, "", QueueBrowseDirection::Older);
        assert_eq!(text.as_deref(), Some("Heartbeat prompt: nudge"));
    }

    #[test]
    fn browse_walks_newest_first_and_ends_on_the_draft() {
        let mut selection = QueueSelection::default();
        // Leaving the draft stashes it.
        let text = selection.browse(&queue(), "current draft", QueueBrowseDirection::Older);
        assert_eq!(text.as_deref(), Some("then summarize"));
        assert!(selection.is_browsing());
        assert_eq!(selection.selected().map(|item| item.text.clone()), text);
        // Older walks toward the steering lane.
        let text = selection.browse(&queue(), "", QueueBrowseDirection::Older);
        assert_eq!(text.as_deref(), Some("turn right"));
        let text = selection.browse(&queue(), "", QueueBrowseDirection::Older);
        assert_eq!(
            text, None,
            "older than the oldest steering message is a noop"
        );
        // Newer walks back to the draft and restores it.
        let text = selection.browse(&queue(), "", QueueBrowseDirection::Newer);
        assert_eq!(text.as_deref(), Some("then summarize"));
        let text = selection.browse(&queue(), "", QueueBrowseDirection::Newer);
        assert_eq!(text.as_deref(), Some("current draft"));
        assert!(!selection.is_browsing());
        let text = selection.browse(&queue(), "current draft", QueueBrowseDirection::Newer);
        assert_eq!(text, None, "newer than the draft is a noop");
    }

    #[test]
    fn browse_stashes_the_draft_once_and_reset_returns_it() {
        let mut selection = QueueSelection::default();
        selection.browse(&queue(), "draft one", QueueBrowseDirection::Older);
        assert!(selection.has_draft());
        // A deeper browse ignores the editor text: the stash keeps the
        // draft the browse left.
        selection.browse(&queue(), "", QueueBrowseDirection::Older);
        // Walking back to the draft restores the stashed draft and clears
        // the stash.
        selection.browse(&queue(), "", QueueBrowseDirection::Newer);
        let restored = selection.browse(&queue(), "", QueueBrowseDirection::Newer);
        assert_eq!(restored.as_deref(), Some("draft one"));
        assert!(!selection.is_browsing());
        assert!(!selection.has_draft());
        // Reset on a fresh browse returns the newly stashed draft.
        selection.browse(&queue(), "fresh draft", QueueBrowseDirection::Older);
        assert_eq!(selection.reset(), "fresh draft");
        assert!(!selection.has_draft());
    }

    #[test]
    fn refresh_keeps_a_matching_selection_and_drops_a_stale_one() {
        let mut selection = QueueSelection::default();
        selection.browse(&queue(), "draft", QueueBrowseDirection::Older);
        assert_eq!(
            selection.selected().map(|i| (i.lane, i.index)),
            Some((QueueLane::FollowUp, 0))
        );
        // Unchanged queue + item keeps the cursor.
        assert_eq!(
            selection.refresh_at(&queue(), QueueLane::FollowUp, 0, "then summarize"),
            None
        );
        assert_eq!(selection.selected().map(|item| item.index), Some(0));
        // A moved item (queue changed) drops the selection and returns the
        // stashed draft.
        let changed = QueuedMessages {
            steering: vec!["turn right".to_string()],
            follow_ups: vec!["edited".to_string()],
            starting: None,
        };
        assert_eq!(
            selection.refresh_at(&changed, QueueLane::FollowUp, 0, "then summarize"),
            Some("draft".to_string())
        );
        assert!(!selection.is_browsing());
    }

    #[test]
    fn mirror_lane_move_swaps_within_the_lane_only() {
        let mut queue = QueuedMessages {
            steering: vec!["one".to_string(), "two".to_string()],
            follow_ups: vec!["later".to_string()],
            starting: None,
        };
        mirror_lane_move(&mut queue, QueueLane::Steering, 0, 1);
        assert_eq!(queue.steering, vec!["two", "one"]);
        assert_eq!(
            queue.follow_ups,
            vec!["later"],
            "the other lane is untouched"
        );
        mirror_lane_move(&mut queue, QueueLane::FollowUp, 0, -1);
        assert_eq!(
            queue.follow_ups,
            vec!["later"],
            "a negative target is a noop"
        );
        mirror_lane_move(&mut queue, QueueLane::FollowUp, 0, 7);
        assert_eq!(
            queue.follow_ups,
            vec!["later"],
            "an out-of-range target is a noop"
        );
    }

    #[test]
    fn browse_header_quotes_lane_index_and_keys() {
        let selected = QueueSelectionItem {
            lane: QueueLane::Steering,
            index: 0,
            text: "turn right".to_string(),
        };
        let keys = QueueBrowseKeys {
            navigate_older: "alt+up".to_string(),
            navigate_newer: "alt+down".to_string(),
            move_earlier: "ctrl+alt+up".to_string(),
            move_later: "ctrl+alt+down".to_string(),
            follow_up: "alt+enter".to_string(),
        };
        assert_eq!(
            browse_header_text(&selected, &keys),
            "steering 1 \u{00b7} alt+up/alt+down browse \u{00b7} ctrl+alt+up/ctrl+alt+down reorder \u{00b7} enter steers \u{00b7} alt+enter queues \u{00b7} empty deletes"
        );
    }
}
