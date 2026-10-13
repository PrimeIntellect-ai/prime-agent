//! Per-card expansion (the TS components' private `expanded`):
//! `toggled_cards` holds the indices whose card a click flipped away
//! from the conversation level (XOR), so new entries, rebuilds, and
//! the Ctrl+O reset need no code.

use super::AgentView;
use crate::chat::Detail;

impl AgentView {
    /// The detail one entry's card renders at: the conversation level,
    /// flipped for the entries a click toggled away from it. Exact for
    /// both sides: the never-toggled entries get `self.detail` (a click
    /// can only toggle the kinds `transcript_click_target` matches),
    /// and the card renderers read `Detail` only through
    /// `tool_output_expanded()` — the level's other readers (thinking
    /// blocks, edit diffs) belong to rows no click can toggle, so the
    /// flip never leaks into them.
    #[must_use]
    pub(super) fn entry_detail(&self, index: usize) -> Detail {
        if self.toggled_cards.contains(&index) {
            if self.detail.tool_output_expanded() {
                Detail::Overview
            } else {
                Detail::All
            }
        } else {
            self.detail
        }
    }

    /// Toggle the clicked card's own expansion; the invalidation rides the in-place-mutation
    /// path, so a paused window keeps its absolute row while the clicked card grows or shrinks.
    pub(crate) fn toggle_card_expansion(&mut self, index: usize) {
        self.prepare_entry_mutation(index);
        if !self.toggled_cards.remove(&index) {
            self.toggled_cards.insert(index);
        }
        self.mark_entry_stale(index);
    }

    /// The Ctrl+O cycle (`app.tools.expand`, TS `toggleToolOutputExpansion` +
    /// `applyChatExpansion`): step the conversation level and reset every card to it — the
    /// flips are XOR-ed against the level. The stale-mark is required: a toggled entry's cache
    /// slot holds its flipped rows.
    pub(crate) fn cycle_detail(&mut self) {
        for index in std::mem::take(&mut self.toggled_cards) {
            self.mark_entry_stale(index);
        }
        self.detail = self.detail.next();
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::chat::{ChatEntry, ToolResultView};
    use crate::theme::{ColorMode, Theme};
    use crate::tool_card::ToolCallCard;
    use serde_json::json;

    /// A settled `bash` card whose output out-talls the collapsed preview, so expansion is the
    /// only way its first output lines render.
    pub(in crate::view) fn finished_tool_card(id: &str, line: &str) -> ChatEntry {
        let output = (1..=8)
            .map(|number| format!("{line} {number}"))
            .collect::<Vec<_>>()
            .join("\n");
        ChatEntry::Tool(Box::new(ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: json!({ "command": "echo hi" }),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(ToolResultView {
                content: vec![json!({ "type": "text", "text": output })],
                details: serde_json::Value::Null,
                is_error: false,
            }),
            result_partial: false,
            aborted: false,
        }))
    }

    pub(in crate::view) fn transcript_text(view: &mut AgentView) -> String {
        view.render_transcript(80)
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect::<Vec<String>>()
            .join("\n")
    }

    /// The Ctrl+O cycle resets a toggled card (TS `applyChatExpansion` overwrites every
    /// component's `expanded`): the cleared flip re-renders.
    #[test]
    fn the_detail_cycle_resets_a_toggled_card() {
        let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
        view.push_entry(finished_tool_card("c0", "alpha"));
        view.push_entry(finished_tool_card("c1", "beta"));
        assert_eq!(view.detail, Detail::Overview);
        // The click toggles card 0 alone: its first output lines render,
        // card 1's stay folded.
        view.toggle_card_expansion(0);
        let toggled = transcript_text(&mut view);
        assert!(
            toggled.contains("alpha 1"),
            "the clicked card's own output expanded: {toggled}"
        );
        assert!(
            !toggled.contains("beta 1"),
            "the other card stays collapsed: {toggled}"
        );
        // The cycle resets every card to each new level: `details` keeps
        // the output collapsed, `all` expands every card.
        view.cycle_detail();
        let at_details = transcript_text(&mut view);
        assert_eq!(view.detail, Detail::Details);
        assert!(
            !at_details.contains("alpha 1"),
            "the cycle reset the toggled card: {at_details}"
        );
        view.cycle_detail();
        let at_all = transcript_text(&mut view);
        assert!(
            at_all.contains("alpha 1") && at_all.contains("beta 1"),
            "the `all` level expands every card: {at_all}"
        );
        view.cycle_detail();
        let collapsed = transcript_text(&mut view);
        assert_eq!(view.detail, Detail::Overview);
        assert!(
            !collapsed.contains("alpha 1"),
            "no stale flipped rows survive the cycle: {collapsed}"
        );
    }
}
