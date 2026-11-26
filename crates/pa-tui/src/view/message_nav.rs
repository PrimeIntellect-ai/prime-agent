//! Transcript message navigation: ctrl+up/ctrl+down walk the user-message
//! anchors (pa-gpui `prev_message`/`next_message` parity, `widgets.rs`).
//! A step re-anchors the transcript window so the landed user message's
//! first row sits at the viewport top; a step past either end is a no-op.

use super::AgentView;
use crate::chat::ChatEntry;

/// One ctrl+up/ctrl+down transcript step: toward the previous or the
/// next user-sent message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MessageNavDirection {
    Prev,
    Next,
}

impl AgentView {
    /// The transcript entry indexes of the user messages, in order.
    pub(crate) fn user_message_anchors(&self) -> Vec<usize> {
        self.chat
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| matches!(entry, ChatEntry::User { .. }).then_some(index))
            .collect()
    }

    /// One message-navigation step (see the module docs). The user message
    /// the window's top row sits in comes fully into view first when its
    /// top is cut off; otherwise the walk lands on the previous or next
    /// user message. The landed index is recorded even when the step runs
    /// past the end (pa-gpui's `nav_ix` behavior).
    pub(crate) fn navigate_messages(&mut self, direction: MessageNavDirection) {
        if self.layout_width == 0 || self.window_rows == 0 || self.chat.is_empty() {
            return;
        }
        // A selection may live in the sparse window's tail coordinates:
        // resolve it to absolute rows before any re-anchor (the
        // scroll_to_top/scroll_to_bottom contract).
        if self.has_selection() {
            self.resolve_sparse_geometry();
        }
        let sparse_enabled = self.sparse_enabled;
        let layout = crate::image_component::with_fullscreen_image_fallback(|| {
            self.layout_pass(self.layout_width)
        });
        self.sparse_enabled = sparse_enabled;
        let offsets = &layout.offsets;
        let total = layout.total;
        let top_row = self.sparse_window_top_row(total);
        // The chat entry under the window's top row, when that row sits in
        // the chat (the splash and the tail sections own the edges).
        let top_entry = (top_row >= offsets[0] && top_row < *offsets.last().expect("non-empty"))
            .then(|| offsets.partition_point(|&offset| offset <= top_row) - 1);
        let cut_user_top = top_entry.filter(|&index| {
            matches!(self.chat[index], ChatEntry::User { .. }) && top_row > offsets[index]
        });
        let target = match (cut_user_top, direction) {
            (Some(index), _) => Some(index),
            (None, MessageNavDirection::Prev) => match top_entry {
                Some(index) => self
                    .user_message_anchors()
                    .into_iter()
                    .rev()
                    .find(|&anchor| anchor < index),
                None => {
                    if top_row >= *offsets.last().expect("non-empty") {
                        self.user_message_anchors().last().copied()
                    } else {
                        // Above the chat nothing precedes.
                        None
                    }
                }
            },
            (None, MessageNavDirection::Next) => match top_entry {
                Some(index) => self
                    .user_message_anchors()
                    .into_iter()
                    .find(|&anchor| anchor > index),
                None => {
                    if top_row < offsets[0] {
                        self.user_message_anchors().first().copied()
                    } else {
                        // Past the chat nothing follows the last one.
                        None
                    }
                }
            },
        };
        self.message_nav = target;
        let Some(target) = target else {
            return;
        };
        // Bring the landed user message's first row to the viewport top
        // (the gpui `ListOffset { item_ix, offset_in_item: 0 }` jump).
        let top = offsets[target];
        let last_max_scroll = total.saturating_sub(self.window_rows);
        self.last_max_scroll = last_max_scroll;
        self.scroll_top = top.min(last_max_scroll);
        self.following = self.scroll_top >= last_max_scroll;
        self.sparse_window = Some(super::lazy::SparseWindow::at_row(
            self.scroll_top,
            self.detail,
            self.layout_width,
        ));
    }

    /// Jump to the first user message anchor (pa-gpui `first_message`
    /// parity, `widgets.rs`). The first user message's first row sits at
    /// the viewport top; a call with no user messages is a no-op.
    pub(crate) fn navigate_to_first_message(&mut self) {
        if self.layout_width == 0 || self.window_rows == 0 || self.chat.is_empty() {
            return;
        }
        if self.has_selection() {
            self.resolve_sparse_geometry();
        }
        let anchors = self.user_message_anchors();
        let Some(&first) = anchors.first() else {
            return;
        };
        let sparse_enabled = self.sparse_enabled;
        let layout = crate::image_component::with_fullscreen_image_fallback(|| {
            self.layout_pass(self.layout_width)
        });
        self.sparse_enabled = sparse_enabled;
        let offsets = &layout.offsets;
        let total = layout.total;
        let top = offsets[first];
        let last_max_scroll = total.saturating_sub(self.window_rows);
        self.last_max_scroll = last_max_scroll;
        self.scroll_top = top.min(last_max_scroll);
        self.following = self.scroll_top >= last_max_scroll;
        self.message_nav = Some(first);
        self.sparse_window = Some(super::lazy::SparseWindow::at_row(
            self.scroll_top,
            self.detail,
            self.layout_width,
        ));
    }

    /// Jump to the last user message anchor (pa-gpui `last_message`
    /// parity, `widgets.rs`). The last user message's first row sits at
    /// the viewport top; a call with no user messages is a no-op.
    pub(crate) fn navigate_to_last_message(&mut self) {
        if self.layout_width == 0 || self.window_rows == 0 || self.chat.is_empty() {
            return;
        }
        if self.has_selection() {
            self.resolve_sparse_geometry();
        }
        let anchors = self.user_message_anchors();
        let Some(&last) = anchors.last() else {
            return;
        };
        let sparse_enabled = self.sparse_enabled;
        let layout = crate::image_component::with_fullscreen_image_fallback(|| {
            self.layout_pass(self.layout_width)
        });
        self.sparse_enabled = sparse_enabled;
        let offsets = &layout.offsets;
        let total = layout.total;
        let top = offsets[last];
        let last_max_scroll = total.saturating_sub(self.window_rows);
        self.last_max_scroll = last_max_scroll;
        self.scroll_top = top.min(last_max_scroll);
        self.following = self.scroll_top >= last_max_scroll;
        self.message_nav = Some(last);
        self.sparse_window = Some(super::lazy::SparseWindow::at_row(
            self.scroll_top,
            self.detail,
            self.layout_width,
        ));
    }
}

#[cfg(test)]
#[path = "message_nav_tests.rs"]
mod tests;
