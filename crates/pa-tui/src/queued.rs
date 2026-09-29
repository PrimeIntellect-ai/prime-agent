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
//! affordance walks and shows it. The parked RLM child status notices
//! (`[child-exited: ...]` / `[child-failed ...]` lifecycle rows) are the
//! one origin that NEVER string-classifies: they condense by WIRE-TYPED
//! provenance (operator directive 2026-09-25 — the queue-fold bug: many
//! child exits parked behind one busy turn rendered as that many
//! user-like rows), the daemon marking its own injected rows by index on
//! the queue projection, so a user-typed prompt that merely looks like a
//! notice stays the human row it is.
//!
//! The engine-minted continuations (goal continuations and budget-limit
//! steers, threshold-compaction continuations) park preview-less and
//! queue-invisible - TS's `visibleSessionActionProjection` filters them
//! out of the projection entirely, Rust's projection kept serving their
//! raw text, so they rendered as user-like rows. They now carry their own
//! WIRE-TYPED provenance too (the `injectedPrompts` rider, the
//! `rlmChildStatus` precedent; operator directive 2026-09-28: "please
//! group the child exits in the summary of agent messages, internal
//! messages, etc. they should not be individual rows"): they count into
//! the condensed row's "other internal prompt" bucket and never render
//! their own rows, while a user-typed prompt with a continuation's exact
//! text stays the human row it is.
//!
//! The browse affordances TS gives the strip (TS `QueueSelection`,
//! alt+up/alt+down to pick a parked message, ctrl+alt+arrows to reorder,
//! Enter to steer the edit, the follow-up key to park it) still walk
//! every queued item, internal prompts included (the full queue stays
//! inspectable; the selection state is owned by the session UI and
//! projected to the view as the dimmed browse header), but the EDIT
//! affordances apply to the user-origin items only (operator directive
//! 2026-09-28: "humans should only be editing the human sent and queued
//! messages" - a human edit of a harness prompt can mis-steer the
//! agent, the system owns them): internal items render the header's
//! read-only phrasing and the edit/reorder/delete gates refuse them.
//! That gate is another SANCTIONED DIVERGENCE from TS (TS's queue edit
//! surface edits any projected item).

use crate::theme::{Theme, ThemeColor};
use crate::width::{pad_line, truncate_line};
use crate::Line;

#[cfg(test)]
mod tests;

/// The dim preview label for messages parked on the steering lane.
pub const STEERING_LABEL: &str = "Steering";
/// The dim preview label for messages parked on the follow-up lane.
pub const FOLLOW_UP_LABEL: &str = "Follow-up";
/// The dim preview label for the picked-up prompt whose turn is preparing
/// (TS #2063 `Starting`): the queued strip keeps showing the prompt the
/// pump selected while it is still on its way into the conversation.
pub const STARTING_LABEL: &str = "Starting";

/// The origin of a queued internal prompt: what the condensed row counts
/// the prompt as. The four TS labels classify by preview string (the wire
/// carries no provenance for them - the label is the classifier); the RLM
/// child status notices classify only by wire-typed provenance.
#[derive(Debug, Clone, Copy)]
enum InternalPromptOrigin {
    /// An `Agent message received: ` preview.
    AgentMessage,
    /// A `Heartbeat prompt: ` preview.
    Heartbeat,
    /// A parked RLM child status notice (an injected
    /// `rlm_child_terminal_notice` / `rlm_child_failure` row), classified
    /// by wire-typed provenance only (see [`QueueLaneIndices`]).
    ChildStatus,
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
    child_status: usize,
    other: usize,
}

impl CondensedCounts {
    /// Every counted origin's total (zero means no condensed row).
    fn total(&self) -> usize {
        self.agent_messages + self.heartbeats + self.child_status + self.other
    }

    /// The counted row's text: each origin with queued prompts and its
    /// count, plural-correct (only a count of one reads singular - a
    /// listed `0` would read plural too), in the fixed agent-message,
    /// heartbeat, child-status, other order, joined into one concise
    /// line. A zero-count origin never lists.
    fn row_text(&self) -> String {
        let mut parts = [
            (self.agent_messages, InternalPromptOrigin::AgentMessage),
            (self.heartbeats, InternalPromptOrigin::Heartbeat),
            (self.child_status, InternalPromptOrigin::ChildStatus),
            (self.other, InternalPromptOrigin::Other),
        ]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, origin)| {
            let name = match origin {
                InternalPromptOrigin::AgentMessage => "agent message",
                InternalPromptOrigin::Heartbeat => "heartbeat",
                InternalPromptOrigin::ChildStatus => "child status notice",
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
    for (lane, index, message) in queued_items(queue) {
        if let Some(origin) = queued_item_origin(message, queue, lane, index) {
            match origin {
                InternalPromptOrigin::AgentMessage => counts.agent_messages += 1,
                InternalPromptOrigin::Heartbeat => counts.heartbeats += 1,
                InternalPromptOrigin::ChildStatus => counts.child_status += 1,
                InternalPromptOrigin::Other => counts.other += 1,
            }
        }
    }
    (counts.total() > 0).then_some(counts)
}

/// Walk the parked queue items lane-by-lane, oldest-first, with each
/// item's lane and index (its provenance address).
fn queued_items(queue: &QueuedMessages) -> impl Iterator<Item = (QueueLane, usize, &str)> {
    queue
        .steering
        .iter()
        .enumerate()
        .map(|(index, message)| (QueueLane::Steering, index, message.as_str()))
        .chain(
            queue
                .follow_ups
                .iter()
                .enumerate()
                .map(|(index, message)| (QueueLane::FollowUp, index, message.as_str())),
        )
}

/// One queued item's origin for the strip: the wire-typed provenance
/// decides FIRST (the daemon marks its own injected rows — the child
/// status notices and the engine-minted continuations; the preview text
/// never classifies them), then the TS internal labels classify by
/// preview string exactly like `isLabeledQueuedPreview`. `None` is a
/// human-typed row.
fn queued_item_origin(
    message: &str,
    queue: &QueuedMessages,
    lane: QueueLane,
    index: usize,
) -> Option<InternalPromptOrigin> {
    if queue.rlm_child_status.is_marked(lane, index) {
        return Some(InternalPromptOrigin::ChildStatus);
    }
    if let Some(origin) = internal_prompt_origin(message) {
        return Some(origin);
    }
    // The engine-minted continuations carry no preview label, so the
    // rider is the only thing that can classify them (a user-typed
    // prompt with the continuation's exact text never rides it).
    if queue.injected_prompts.is_marked(lane, index) {
        return Some(InternalPromptOrigin::Other);
    }
    None
}

/// TS `formatQueuedMessagePreview`: the lane label plus the message, or
/// the message itself when it carries an internal label.
#[must_use]
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
    /// Which parked items are RLM child status notices, by lane index
    /// (the wire-typed provenance; see [`QueueLaneIndices`]). The
    /// strip folds exactly these rows into the condensed count — they
    /// stay browseable with their full notice text.
    pub rlm_child_status: QueueLaneIndices,
    /// Which parked items are engine-minted internal prompts (the
    /// injected, queue-invisible continuations), by lane index (the
    /// second wire-typed provenance rider; see [`QueueLaneIndices`]).
    /// The strip folds exactly these rows into the condensed count too
    /// — they stay browseable with their full text, read-only.
    pub injected_prompts: QueueLaneIndices,
}

impl QueuedMessages {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.steering.is_empty() && self.follow_ups.is_empty()
    }
}

/// The lane-indices rider shape the queue projection's typed-provenance
/// marks share (`sessionActions.rlmChildStatus` for the parked RLM child
/// status notices — the daemon derives the indices from the parked rows'
/// injected custom rows, the `rlm_child_terminal_notice` /
/// `rlm_child_failure` kinds — and `sessionActions.injectedPrompts` for
/// the engine-minted continuations). The strip never classifies by
/// preview text through either: a user-typed message that merely looks
/// like a notice or a continuation (or starts with any internal-looking
/// prefix) stays a human row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueueLaneIndices {
    pub steering: Vec<usize>,
    pub follow_up: Vec<usize>,
}

impl QueueLaneIndices {
    /// Whether the lane item at `index` is a child status notice.
    #[must_use]
    pub fn is_marked(&self, lane: QueueLane, index: usize) -> bool {
        match lane {
            QueueLane::Steering => self.steering.contains(&index),
            QueueLane::FollowUp => self.follow_up.contains(&index),
        }
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
    #[must_use]
    pub fn wire_name(&self) -> &'static str {
        match self {
            QueueLane::Steering => "steering",
            QueueLane::FollowUp => "followUp",
        }
    }

    /// The browse-header display name (TS `getQueueSelectionHeader`).
    #[must_use]
    pub fn display_name(&self) -> &'static str {
        match self {
            QueueLane::Steering => "steering",
            QueueLane::FollowUp => "follow-up",
        }
    }
}

/// One addressable queue item (TS `QueueSelectionItem`). `internal`
/// is the item's origin: `true` marks an internal prompt (a TS-labeled
/// preview, an RLM child status notice, or an engine-minted
/// continuation — every non-user-origin item), which the browse walks
/// READ-ONLY (the edit gates refuse internal items; the system owns
/// them), `false` the human-typed row the edit affordances apply to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueSelectionItem {
    pub lane: QueueLane,
    pub index: usize,
    pub text: String,
    pub internal: bool,
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
#[must_use]
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
    // prioritized above the condensed row. The child status notices
    // classify by typed provenance here (never by their text), so a
    // user-typed row that merely looks like a notice renders too.
    for (lane, index, message) in queued_items(queue) {
        if queued_item_origin(message, queue, lane, index).is_none() {
            let label = match lane {
                QueueLane::Steering => STEERING_LABEL,
                QueueLane::FollowUp => FOLLOW_UP_LABEL,
            };
            rows.push(preview_row(theme, label, message, width));
        }
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
/// and the effective keys for the affordances. An internal prompt renders
/// the read-only phrasing instead (the edit affordances never apply to
/// it - the system owns the harness prompts, so the header offers
/// browsing only, never the reorder/steer/queue/delete keys).
#[must_use]
pub fn browse_header_text(selected: &QueueSelectionItem, key_display: &QueueBrowseKeys) -> String {
    if selected.internal {
        return format!(
            "{} {} \u{00b7} {}/{} browse \u{00b7} read-only internal prompt",
            selected.lane.display_name(),
            selected.index + 1,
            key_display.navigate_older,
            key_display.navigate_newer,
        );
    }
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
    #[must_use]
    pub fn selected(&self) -> Option<&QueueSelectionItem> {
        self.cursor.and_then(|cursor| self.items.get(cursor))
    }

    #[must_use]
    pub fn is_browsing(&self) -> bool {
        self.cursor.is_some()
    }

    #[must_use]
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
        // The typed provenance mirrors the same swap (a marked index
        // rides its item through the move), so the strip classification
        // stays correct in the window before the daemon's action update
        // lands with the fresh indices. Both riders mirror: a user
        // row's reorder can swap it across an internal one.
        let (lane_child, lane_injected) = match lane {
            QueueLane::Steering => (
                &mut queue.rlm_child_status.steering,
                &mut queue.injected_prompts.steering,
            ),
            QueueLane::FollowUp => (
                &mut queue.rlm_child_status.follow_up,
                &mut queue.injected_prompts.follow_up,
            ),
        };
        for indices in [lane_child, lane_injected] {
            for marked in indices.iter_mut() {
                if *marked == index {
                    *marked = target;
                } else if *marked == target {
                    *marked = index;
                }
            }
        }
    }
}

/// The flattened browse order (TS `flatten`): steering lane first, then the
/// follow-up lane, both oldest-first, so the last item is the newest
/// follow-up and the cursor walks newest-first down to the oldest steering.
fn flatten(queue: &QueuedMessages) -> Vec<QueueSelectionItem> {
    let item = |lane: QueueLane, index: usize, text: &str| QueueSelectionItem {
        lane,
        index,
        text: text.to_string(),
        internal: queued_item_origin(text, queue, lane, index).is_some(),
    };
    let steering = queue
        .steering
        .iter()
        .enumerate()
        .map(|(index, text)| item(QueueLane::Steering, index, text));
    let follow_up = queue
        .follow_ups
        .iter()
        .enumerate()
        .map(|(index, text)| item(QueueLane::FollowUp, index, text));
    steering.chain(follow_up).collect()
}
