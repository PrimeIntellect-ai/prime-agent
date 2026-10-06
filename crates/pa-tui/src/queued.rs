//! The queued-message strip above the prompt dock (see [`render_queue`]). Sanctioned divergence
//! (operator request Kevin 2026-09-24; directives 2026-09-25, 2026-09-28): internal prompts
//! condense into one counted row by origin instead of preview rows; child status notices and
//! engine-minted continuations classify by wire-typed provenance only (user-typed look-alikes stay
//! human rows); browse walks every item; edits are human-origin only.

use crate::theme::{Theme, ThemeColor};
use crate::width::{pad_line, truncate_line};
use crate::Line;

#[cfg(test)]
mod tests;

pub const STEERING_LABEL: &str = "Steering";
pub const FOLLOW_UP_LABEL: &str = "Follow-up";
/// The dim preview label for the picked-up prompt still preparing.
pub const STARTING_LABEL: &str = "Starting";

#[derive(Debug, Clone, Copy)]
enum InternalPromptOrigin {
    AgentMessage,
    Heartbeat,
    /// A parked RLM child status notice, classified by wire-typed provenance only.
    ChildStatus,
    Other,
}

/// Internal prompts that queue with their own visible label render as-is (no lane label prepended),
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

/// The queued internal prompts' counts by origin across both lanes.
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

    /// The counted row's text: each origin with queued prompts and its count, plural-correct, in
    /// the fixed order; a zero-count origin never lists.
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

/// Count every queued internal prompt by origin, or `None` when every queued message is
/// human-typed.
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

/// Walk the parked queue items lane-by-lane, oldest-first, with each item's lane and index.
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

/// One queued item's origin for the strip: the wire-typed provenance decides
/// FIRST, then the TS internal labels classify by preview string; `None` is a human-typed row.
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
    // The rider is the only thing that can classify the continuation (a
    // user-typed prompt with its exact text never rides it).
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueuedMessages {
    /// Messages delivered at the next turn boundary (Enter while busy).
    pub steering: Vec<String>,
    /// Messages delivered when the run goes idle (the follow-up key).
    pub follow_ups: Vec<String>,
    /// The picked-up prompt whose turn is still preparing: the strip keeps it visible as its
    /// "Starting" row until the turn's rows land; not browsable.
    pub starting: Option<String>,
    /// Which parked items are RLM child status notices, by lane index (wire-typed
    /// provenance): folded into the condensed count, still browseable.
    pub rlm_child_status: QueueLaneIndices,
    /// Which parked items are engine-minted internal prompts, by lane index (the second wire-typed
    /// provenance rider); folded into the condensed count, read-only.
    pub injected_prompts: QueueLaneIndices,
}

impl QueuedMessages {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.steering.is_empty() && self.follow_ups.is_empty()
    }
}

/// The lane-indices rider shape the typed-provenance marks share (`sessionActions.rlmChildStatus` /
/// `sessionActions.injectedPrompts`); the strip never classifies by preview text.
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

/// One of the two queue lanes, by its wire name.
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

    /// The browse-header display name.
    #[must_use]
    pub fn display_name(&self) -> &'static str {
        match self {
            QueueLane::Steering => "steering",
            QueueLane::FollowUp => "follow-up",
        }
    }
}

/// One addressable queue item (TS `QueueSelectionItem`). `internal` marks an internal prompt, which
/// the browse walks READ-ONLY; `false` is the human row the edit affordances apply to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueSelectionItem {
    pub lane: QueueLane,
    pub index: usize,
    pub text: String,
    pub internal: bool,
}

/// The strip rows: the "Starting" row of a preparing turn above a truncated dim preview per
/// human-typed queued message, the condensed internal-prompt row, and the queue hint. Empty input
/// renders no rows; a preparing turn alone renders its row but never the hint.
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
    if let Some(starting) = queue.starting.as_deref() {
        rows.push(preview_row(theme, STARTING_LABEL, starting, width));
    }
    // The human-typed previews render individually, so what the user parked stays explicit above
    // the condensed row; child status notices classify by typed provenance here.
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

/// The browse header text: the lane, its 1-based index, and the effective keys for the affordances;
/// an internal prompt renders the read-only phrasing instead.
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

/// One styled preview row: the labeled message's first line with the TS prompt-highlight styling,
/// truncated with `...` to the padded content width, with a plain 1-col left pad.
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
    // The right pad keeps the row at the full width like TS, so 1 left pad +
    // content cut to `width - 1` leaves the trailing space.
    pad_line(truncate_line(&line, width.saturating_sub(1), "..."), width)
}

/// The condensed internal-prompt row (the sanctioned divergence, see the module docs): one dim line
/// carrying the counts by origin.
fn condensed_row(theme: &Theme, counts: &CondensedCounts, width: usize) -> Line {
    let line: crate::Line = vec![
        crate::Span::raw(" ".repeat(width.min(1))),
        crate::Span::styled(counts.row_text(), theme.fg_style(ThemeColor::Dim)),
    ];
    pad_line(truncate_line(&line, width.saturating_sub(1), "..."), width)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueBrowseDirection {
    Older,
    Newer,
}

/// Which parked message the user is browsing with alt+up/alt+down: items are addressed by (lane,
/// index, text) — the text is the authoritative check; browsing order is newest-first.
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

    /// Move the cursor; returns the text to show, or `None` for a boundary noop.
    pub fn browse(
        &mut self,
        queue: &QueuedMessages,
        draft: &str,
        direction: QueueBrowseDirection,
    ) -> Option<String> {
        match (self.cursor, direction) {
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

    /// Re-point the selection after a mutation or queue update: the selection
    /// survives only when the addressed item is unchanged (TS `refreshAt`).
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

/// Mirror one applied lane move locally: swap the item with its neighbor so the strip and the
/// selection update without waiting for the `session_action_update` event.
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
        // The typed provenance mirrors the same swap (a marked index rides its item through the
        // move), so the classification stays correct until the daemon's action update lands.
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
