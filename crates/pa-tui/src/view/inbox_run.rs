//! Inbox-notice runs: consecutive inbox notices collapse into the one dim
//! counter line their first entry paints (the rest paint nothing), and
//! expand to the full per-notice rows through the card expansion
//! affordances (Ctrl+O, or a click on the line).

use super::AgentView;
use crate::chat::ChatEntry;
use crate::custom_message::InboxNoticeRow;
use crate::Line;

impl AgentView {
    /// The first entry of the consecutive inbox-notice run holding the
    /// notice at `index`: the entry that owns the run's expansion and its
    /// counter line. Memoized, so a long run costs one walk, not one per
    /// member and repaint.
    pub(super) fn inbox_run_head(&self, index: usize) -> usize {
        let mut heads = self.inbox_run_heads.borrow_mut();
        while heads.len() <= index {
            let next = heads.len();
            let joins = next > 0
                && matches!(self.chat[next], ChatEntry::InboxNotice(_))
                && matches!(self.chat[next - 1], ChatEntry::InboxNotice(_));
            let head = if joins { heads[next - 1] } else { next };
            heads.push(head);
        }
        heads[index]
    }

    /// The chat range of the inbox-notice run holding the notice at `index`.
    pub(super) fn inbox_run(&self, index: usize) -> std::ops::Range<usize> {
        let head = self.inbox_run_head(index);
        let len = self.chat[head..]
            .iter()
            .take_while(|entry| matches!(entry, ChatEntry::InboxNotice(_)))
            .count();
        head..head + len
    }

    /// Keep a run's expansion on its head when spliced entries join the
    /// run from the front (older history that ends in inbox notices).
    pub(super) fn follow_inbox_run_heads(&mut self) {
        let moved: Vec<(usize, usize)> = self
            .toggled_cards
            .iter()
            .map(|&index| (index, self.inbox_run_head(index)))
            .filter(|(index, head)| index != head)
            .collect();
        for (index, head) in moved {
            self.toggled_cards.remove(&index);
            self.toggled_cards.insert(head);
        }
    }

    /// The entry that paints `index`'s rows: a collapsed run paints on its
    /// head, every other entry on itself.
    pub(super) fn painting_entry(&self, index: usize) -> usize {
        if matches!(self.chat[index], ChatEntry::InboxNotice(_)) && !self.inbox_run_expanded(index)
        {
            self.inbox_run_head(index)
        } else {
            index
        }
    }

    pub(super) fn inbox_run_expanded(&self, index: usize) -> bool {
        self.entry_detail(self.inbox_run_head(index))
            .tool_output_expanded()
    }

    /// The notices a collapsed run head counts: the head and every inbox
    /// notice directly after it. Empty for a non-head entry.
    fn inbox_run_notices(&self, index: usize) -> Vec<&InboxNoticeRow> {
        if self.inbox_run_head(index) != index {
            return Vec::new();
        }
        self.chat[index..]
            .iter()
            .map_while(|entry| match entry {
                ChatEntry::InboxNotice(row) => Some(row.as_ref()),
                _ => None,
            })
            .collect()
    }

    /// One inbox notice's rows: its full rows in an expanded run, the run's
    /// counter line on a collapsed head, nothing for the rest of a
    /// collapsed run.
    pub(super) fn render_inbox_notice_entry(
        &self,
        index: usize,
        row: &InboxNoticeRow,
        width: usize,
    ) -> Vec<Line> {
        let expanded = self.inbox_run_expanded(index);
        let leading = self.conversation_leading(index, expanded);
        if expanded {
            return crate::custom_message::render::render_inbox_notice(
                row,
                &self.theme,
                width,
                leading,
            );
        }
        let notices = self.inbox_run_notices(index);
        if notices.is_empty() {
            return Vec::new();
        }
        let mut rows = Vec::new();
        if leading {
            rows.push(Vec::new());
        }
        rows.extend(crate::custom_message::render::text_rows(
            &crate::custom_message::inbox_counter::counter_line(&notices, &self.theme),
            width,
        ));
        rows
    }

    /// The row count [`Self::render_inbox_notice_entry`] paints.
    pub(super) fn count_inbox_notice_entry(
        &self,
        index: usize,
        row: &InboxNoticeRow,
        width: usize,
    ) -> usize {
        let expanded = self.inbox_run_expanded(index);
        let leading = self.conversation_leading(index, expanded);
        if expanded {
            return crate::custom_message::geometry::inbox_notice_row_count(
                row,
                &self.theme,
                width,
                leading,
            );
        }
        let notices = self.inbox_run_notices(index);
        if notices.is_empty() {
            return 0;
        }
        usize::from(leading)
            + crate::custom_message::geometry::text_row_count(
                &crate::custom_message::inbox_counter::counter_line(&notices, &self.theme),
                width,
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::Detail;
    use crate::theme::{ColorMode, Theme, ThemeColor};

    fn notice(text: &str) -> ChatEntry {
        ChatEntry::InboxNotice(Box::new(InboxNoticeRow {
            class: "arrival".to_string(),
            count: Some(1),
            text: text.to_string(),
        }))
    }

    fn rows_text(rows: &[Line]) -> Vec<String> {
        rows.iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    /// Three notices paint one dim counter line, never a row per notice;
    /// the Ctrl+O expansion brings back every notice's own rows.
    #[test]
    fn three_inbox_notices_collapse_to_one_dim_counter_line() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let mut view = AgentView::new(theme.clone());
        view.splash_suppressed = true;
        let texts = [
            "[inbox 19:14 UTC] 1 new message (bash-done); total waiting: 1. Read them with msgs = await rlm.inbox.read().",
            "[inbox 19:15 UTC] 1 new message (agent-message); total waiting: 2. Read them with msgs = await rlm.inbox.read().",
            "[inbox 19:16 UTC] 1 new message (bash-done); total waiting: 3. Read them with msgs = await rlm.inbox.read().",
        ];
        for text in texts {
            view.push_entry(notice(text));
        }
        assert_eq!(view.detail, Detail::Overview);
        let collapsed = view.render_transcript(80);
        let collapsed_text = rows_text(&collapsed);
        assert_eq!(
            collapsed_text
                .iter()
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>(),
            [" \u{2709} Agent inbox \u{b7} 3 new (2 bash-done, 1 agent-message)"]
        );
        let dim = theme.fg_style(ThemeColor::Dim);
        let line = collapsed
            .iter()
            .find(|row| row.iter().any(|span| span.content.contains("Agent inbox")))
            .expect("the counter line renders");
        assert!(
            line.iter()
                .filter(|span| !span.content.trim().is_empty())
                .all(|span| span.style == dim),
            "{line:?}"
        );

        view.cycle_detail();
        view.cycle_detail();
        let expanded = rows_text(&view.render_transcript(80)).join("\n");
        for text in texts {
            assert!(expanded.contains(&text[..30]), "{expanded}");
        }
        assert_eq!(
            expanded.matches("\u{2709} Agent inbox").count(),
            3,
            "{expanded}"
        );
    }

    /// Older history that ends in inbox notices joins the run in front of
    /// its head: the click-expanded run stays expanded.
    #[test]
    fn a_prepended_run_head_keeps_the_run_expanded() {
        let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
        for index in 0..3 {
            view.push_entry(notice(&format!("[inbox 19:1{index} UTC] newer")));
        }
        view.toggle_card_expansion(0);
        assert!(view.inbox_run_expanded(2));
        view.prepend_entries(vec![
            ChatEntry::User {
                text: "older".to_string(),
            },
            notice("[inbox 19:00 UTC] older"),
        ]);
        assert_eq!(view.inbox_run(4), 1..5);
        assert!((1..5).all(|index| view.inbox_run_expanded(index)));
    }

    /// Older history that ends in inbox notices joins a collapsed run whose
    /// counter line tops a paused window: the line moves to the run's new
    /// head and stays on top, now counting the joined notice.
    #[test]
    fn a_prepend_joining_a_collapsed_run_keeps_its_counter_line_on_top() {
        let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
        view.splash_suppressed = true;
        for index in 0..3 {
            view.push_entry(notice(&format!("[inbox 19:1{index} UTC] newer")));
        }
        for index in 0..200 {
            view.push_entry(ChatEntry::User {
                text: format!("after {index}"),
            });
        }
        view.render_frame(37, 24);
        view.scroll_to_top();
        // The counter line, then the first entry after the run.
        let top = |rows: &[String], count: &str| {
            let counter = rows.iter().position(|row| row.contains(count));
            let after = rows.iter().position(|row| row.contains("after 0"));
            counter
                .zip(after)
                .is_some_and(|(counter, after)| counter < after)
        };
        let home = rows_text(&view.render_frame(37, 24));
        assert!(top(&home, "Agent inbox \u{b7} 3 new"), "{home:?}");
        view.prepend_entries(vec![
            ChatEntry::User {
                text: "older".to_string(),
            },
            notice("[inbox 19:00 UTC] older"),
        ]);
        let after = rows_text(&view.render_frame(37, 24));
        assert!(top(&after, "Agent inbox \u{b7} 4 new"), "{after:?}");
    }

    /// An older-history trim that drops a click-expanded run's head keeps
    /// the surviving run expanded.
    #[test]
    fn a_trimmed_run_head_keeps_the_run_expanded() {
        let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
        view.push_entry(ChatEntry::User {
            text: "older".to_string(),
        });
        for index in 0..3 {
            view.push_entry(notice(&format!("[inbox 19:1{index} UTC] newer")));
        }
        view.toggle_card_expansion(1);
        assert!(view.inbox_run_expanded(3));
        view.render_frame(80, 24);
        view.drop_leading_entries(2);
        assert_eq!(view.inbox_run(1), 0..2);
        assert!((0..2).all(|index| view.inbox_run_expanded(index)));
    }

    /// A click on a run in a paused, tail-anchored window folds every
    /// member's row change: the window keeps its absolute scroll start,
    /// like the full rebuild.
    #[test]
    fn a_run_toggle_keeps_a_paused_tail_window() {
        let build = || {
            let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
            view.splash_suppressed = true;
            for index in 0..120 {
                view.push_entry(ChatEntry::User {
                    text: format!("before {index}"),
                });
            }
            for index in 0..6 {
                view.push_entry(notice(&format!(
                    "[inbox 19:1{index} UTC] 1 new message (bash-done); total waiting: {index}."
                )));
            }
            for index in 0..12 {
                view.push_entry(ChatEntry::User {
                    text: format!("after {index}"),
                });
            }
            view
        };
        let mut sparse = build();
        let mut full = build();
        sparse.render_frame(37, 24);
        full.render_frame(37, 24);
        sparse.scroll_by(-30);
        full.resolve_sparse_geometry();
        full.sparse_enabled = false;
        full.scroll_by(-30);
        full.resolve_sparse_geometry();
        full.sparse_enabled = false;
        let frame = |view: &mut AgentView| rows_text(&view.render_frame(37, 24));
        assert_eq!(frame(&mut sparse), frame(&mut full));
        sparse.toggle_card_expansion(120);
        full.toggle_card_expansion(120);
        full.resolve_sparse_geometry();
        full.sparse_enabled = false;
        assert_eq!(
            frame(&mut sparse),
            frame(&mut full),
            "the expanded run keeps the paused window"
        );
    }
}
