//! Interactive agent view: fullscreen chat frame — a pinned top bar, a
//! scrollable transcript window (splash, chat rows, loader), and a dock.
//! The session loop folds events into the view; this module owns row
//! geometry and scroll behavior only.

use crate::chat::{ChatEntry, CompactionState, Detail, WorkingState};
use crate::chrome::{conversation_detail_status, ChromeState};
use crate::editor::Editor;
use crate::session::TranscriptItem;
use crate::theme::Theme;
use crate::Line;

pub(crate) mod click;
pub(crate) mod editor_surface;
mod expansion;
mod flush;
mod frame;
mod geometry;
mod handoff;
mod layout;
pub(crate) mod lazy;
mod panels;
mod restyle;
mod rows;

use layout::EntryLayout;

/// Minimum transcript rows when the dock would crowd them out.
pub const FULLSCREEN_MIN_TRANSCRIPT_ROWS: usize = 3;

/// A `/share` gist upload in flight: the spinner rows that replace the
/// editor while `gh gist create` runs.
#[derive(Debug, Clone)]
pub struct ShareLoader {
    pub message: String,
}

impl ShareLoader {
    #[must_use]
    pub fn new() -> Self {
        ShareLoader {
            message: "Creating gist...".to_string(),
        }
    }
}

impl Default for ShareLoader {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AgentView {
    pub theme: Theme,
    /// The chat markdown fenced-code indent (`markdown.codeBlockIndent`;
    /// default two spaces).
    pub code_block_indent: String,
    pub editor: Editor,
    pub chrome: ChromeState,
    /// Queued input parked behind the running turn (steering/follow-up
    /// lanes); renders as the dim strip above the prompt dock.
    pub queued: crate::queued::QueuedMessages,
    pub queue_selected: Option<crate::queued::QueueSelectionItem>,
    pub chat: Vec<ChatEntry>,
    /// In-flight bash cards held above the execution indicator while the
    /// agent streams; they flush into the transcript when the turn ends.
    pub pending_bash: Vec<crate::bash_card::BashExecutionCard>,
    pub detail: Detail,
    pub working: Option<WorkingState>,
    /// A compaction run in flight: replaces the working loader from
    /// `compaction_start` to `compaction_end`.
    pub compaction: Option<CompactionState>,
    /// Bumped on every `compaction_start`: a backgrounded abort outcome
    /// addresses the exact loader it was sent for.
    pub compaction_generation: u64,
    /// Animation frame for spinners and the working icon.
    pub pulse_frame: usize,
    /// When the current working loader started (elapsed label).
    pub working_since: Option<std::time::Instant>,
    pub retry: Option<crate::chat::RetryState>,
    pub onboarding: Option<crate::onboarding::OnboardingScreen>,
    pub model_picker: Option<crate::model_picker::ModelPicker>,
    pub tree_selector: Option<crate::tree_selector::TreeSelector>,
    pub confirm: Option<crate::confirm::ConfirmPanel>,
    pub provider_auth: Option<crate::provider_auth::ProviderAuthSelector>,
    pub auth_panel: Option<crate::auth_panel::AuthPanel>,
    pub fork_selector: Option<crate::user_message_selector::UserMessageSelector>,
    /// The `/effort` inline picker (TS
    /// `ThinkingSelectorComponent` seam): while set, it owns the whole frame
    /// like the model picker.
    pub(crate) choice_picker: Option<crate::choice_picker::ChoicePicker>,
    pub mcp_view: Option<crate::mcp_view::McpView>,
    /// The factory page: while set, it owns the editor dock like the
    /// inline pickers (one panel per live factory run) — the activity
    /// dock's factory group's destination.
    pub factory_view: Option<crate::factory_view::FactoryView>,
    /// The `/heartbeats` inline management view (TS
    /// `HeartbeatManagerComponent`, inline-picker style): while set, it
    /// owns the editor dock like the `/model` and `/effort` pickers.
    pub heartbeats_picker: Option<crate::heartbeats_picker::HeartbeatsPicker>,
    pub goal_panel: Option<crate::goal_surface::GoalPanel>,
    pub bash_view: Option<crate::bash_view::BashView>,
    pub share_loader: Option<ShareLoader>,
    pub reload_box: Option<String>,
    pub side_pane: Option<crate::side_question::SideQuestionPane>,
    pub settings_menu: Option<crate::settings_menu::SettingsMenu>,
    /// The read-only info panel (operator directive 2026-09-26: the
    /// `/context`-family displays dock instead of flooding the transcript).
    pub info_panel: Option<crate::info_panel::InfoPanel>,
    /// The `terminal.showImages` setting (default true): image blocks
    /// render metadata rows when set, `[Image: ...]` placeholders otherwise.
    pub show_images: bool,
    /// The `showHardwareCursor` setting (TS default false): frame paints
    /// never drag a visible cursor across the pane.
    pub show_hardware_cursor: bool,
    /// The brand splash never renders while set (operator ruling 2026-09-26, zero layout
    /// shift): an opening non-empty transcript suppresses it.
    pub splash_suppressed: bool,
    pub(crate) scroll_top: usize,
    following: bool,
    /// The transcript-tail offset of the last composed frame: scroll
    /// deltas page from here, not from zero.
    pub(crate) last_max_scroll: usize,
    /// Rows of the terminal the editor should lay out against.
    terminal_rows: u16,
    /// Cursor cell within the last dock render: (dock row, column).
    dock_cursor: Option<(usize, usize)>,
    pub(crate) window_rows: usize,
    /// Whether the last frame's window reached the tail (operator
    /// directive 2026-09-26): the follow hint shows only then.
    pub(crate) window_shows_tail: bool,
    /// A detail change `resolve_sparse_geometry` consumed before its
    /// first composition: the next build re-derives the follow state.
    pub(crate) detail_transition: bool,
    /// The hovered screen cell, while its row is a clickable card row
    /// (operator directive 2026-09-26); revalidated every frame.
    pub(crate) hover_pos: Option<(usize, usize)>,
    /// Rendered rows per chat entry and detail mode: a frame re-renders only entries invalidated
    /// since the last frame, so a transcript-scale frame pays full layout once per entry/detail.
    entry_layout: Vec<[Option<EntryLayout>; 3]>,
    entry_heights: Vec<[Option<(bool, usize)>; 3]>,
    sparse_window: Option<lazy::SparseWindow>,
    sparse_enabled: bool,
    /// The height of the entry an in-place mutation is about to change:
    /// consumed by `mark_entry_stale` for the sparse tail bookkeeping.
    sparse_mutation: Option<(usize, usize)>,
    sparse_entries: std::collections::BTreeSet<usize>,
    /// The cross-view layout handoff (see `view::handoff`): consumed by
    /// the first layout preparation, dropped by every chat mutation.
    pending_handoff: Option<handoff::LayoutHandoff>,
    /// How many first-draw windows this view served from an adopted
    /// layout handoff: the verifiers assert the reuse happened.
    pub(crate) handoff_seeds: u32,
    /// Entries whose card a click flipped away from the level's
    /// tool-output expansion (see `view/expansion.rs`).
    toggled_cards: std::collections::BTreeSet<usize>,
    /// Per-assistant-entry markdown block caches: a streaming message re-renders every frame, so
    /// settled blocks replay from the cache. `RefCell` because the layout pass borrows immutably.
    md_caches:
        std::cell::RefCell<std::collections::HashMap<usize, crate::markdown::MarkdownBlockCache>>,
    /// The width the cached rows were laid out for.
    pub(crate) layout_width: usize,
    /// Rendering options that affect cached entry rows.
    layout_options: Option<(Theme, String, bool, bool)>,
    /// Row texts of the inline frame at the last main-screen flush: the
    /// next flush diffs against this, so exits never duplicate scrollback.
    flushed_frame: Vec<String>,
    pub(crate) frame_rows: usize,
    /// The last composed frame's clickable link ranges: the click
    /// dispatch resolves a screen cell to its URL through these.
    pub(crate) frame_links: Vec<crate::hyperlinks::LinkRange>,
    /// In-app mouse text selection state: anchor/head points, the mode,
    /// and the frame snapshot.
    pub(crate) selection: crate::selection::SelectionState,
    /// The selection restyle cache: re-styles only the rows the selection
    /// change touched.
    pub(crate) selection_restyle: restyle::SelectionRestyle,
    /// The last composed frame's clickable geometry (view/click.rs):
    /// recorded during the frame composition; cleared by the inline compose.
    pub(crate) click: click::ClickSurface,
    /// The ephemeral action toasts (the top-right auto-dismiss overlay;
    /// a sanctioned divergence from TS — see `toast`).
    pub toasts: crate::toast::Toasts,
}

/// Clip the editor selection to one rendered chunk (the chunk of `source_line` starting at
/// `source_start`): `None` when the selection does not touch this chunk.
fn chunk_selection(
    selection: Option<((usize, usize), (usize, usize))>,
    source_line: usize,
    source_start: usize,
    text: &str,
) -> Option<(usize, usize)> {
    let ((start_line, start_col), (end_line, end_col)) = selection?;
    if source_line < start_line || source_line > end_line {
        return None;
    }
    let chunk_chars = text.chars().count();
    let lo = if source_line == start_line {
        start_col.saturating_sub(source_start)
    } else {
        0
    };
    let hi = if source_line == end_line {
        end_col.saturating_sub(source_start)
    } else {
        chunk_chars
    };
    let hi = hi.min(chunk_chars);
    let lo = lo.min(chunk_chars);
    (lo < hi).then_some((lo, hi))
}

impl AgentView {
    /// Agent messages, tool calls, bash executions, and shell completions
    /// render flush against each other.
    pub(super) fn is_compact_neighbor(entry: &ChatEntry) -> bool {
        matches!(
            entry,
            ChatEntry::Tool(_)
                | ChatEntry::AgentMessage(_)
                | ChatEntry::ShellCompletion(_)
                | ChatEntry::BashExecution(_)
        )
    }

    /// One paste routed by the open overlay, the key dispatch's order:
    /// the overlay's own input takes it, the input-less overlays consume
    /// it, and the bare dock's editor takes it when nothing is open.
    /// Returns whether an overlay took or consumed the paste.
    pub fn route_paste(&mut self, text: &str) -> bool {
        if let Some(picker) = self.model_picker.as_mut() {
            picker.paste(text);
            return true;
        }
        if let Some(picker) = self.choice_picker.as_mut() {
            picker.paste(text);
            return true;
        }
        if let Some(mcp) = self.mcp_view.as_mut() {
            mcp.paste(text);
            return true;
        }
        if let Some(selector) = self.tree_selector.as_mut() {
            selector.paste(text);
            return true;
        }
        if let Some(auth) = self.provider_auth.as_mut() {
            auth.paste(text);
            return true;
        }
        if let Some(menu) = self.settings_menu.as_mut() {
            menu.paste(text);
            return true;
        }
        // The input-less frame owners (the key dispatch's same set): the
        // heartbeats picker, the bash view, the read-only goal and info
        // panels, the fork selector, the pending confirm, the share
        // loader, the reload box, and the auth panel (its own channel
        // drives it). None of them leaves a paste to the editor behind.
        if self.heartbeats_picker.is_some()
            || self.bash_view.is_some()
            || self.goal_panel.is_some()
            || self.info_panel.is_some()
            || self.fork_selector.is_some()
            || self.confirm.is_some()
            || self.share_loader.is_some()
            || self.reload_box.is_some()
            || self.auth_panel.is_some()
        {
            return true;
        }
        false
    }

    #[must_use]
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            code_block_indent: "  ".to_string(),
            editor: Editor::new(),
            chrome: ChromeState::default(),
            queued: crate::queued::QueuedMessages::default(),
            queue_selected: None,
            chat: Vec::new(),
            pending_bash: Vec::new(),
            // A chat starts at the collapsed conversation-detail level
            // (operator directive 2026-09-28): only thinking is hidden.
            detail: Detail::Overview,
            working: None,
            compaction: None,
            compaction_generation: 0,
            pulse_frame: 0,
            working_since: None,
            retry: None,
            onboarding: None,
            model_picker: None,
            tree_selector: None,
            confirm: None,
            provider_auth: None,
            auth_panel: None,
            fork_selector: None,
            choice_picker: None,
            mcp_view: None,
            factory_view: None,
            heartbeats_picker: None,
            goal_panel: None,
            bash_view: None,
            share_loader: None,
            reload_box: None,
            side_pane: None,
            settings_menu: None,
            info_panel: None,
            show_images: true,
            show_hardware_cursor: false,
            splash_suppressed: false,
            scroll_top: 0,
            following: true,
            last_max_scroll: 0,
            terminal_rows: 24,
            dock_cursor: None,
            window_rows: 0,
            window_shows_tail: false,
            detail_transition: false,
            hover_pos: None,
            toasts: crate::toast::Toasts::default(),
            entry_layout: Vec::new(),
            entry_heights: Vec::new(),
            sparse_window: None,
            sparse_enabled: true,
            sparse_entries: std::collections::BTreeSet::new(),
            toggled_cards: std::collections::BTreeSet::new(),
            md_caches: std::cell::RefCell::new(std::collections::HashMap::new()),
            layout_width: 0,
            layout_options: None,
            flushed_frame: Vec::new(),
            frame_rows: 0,
            frame_links: Vec::new(),
            selection: crate::selection::SelectionState::default(),
            selection_restyle: restyle::SelectionRestyle::default(),
            sparse_mutation: None,
            pending_handoff: None,
            handoff_seeds: 0,
            click: click::ClickSurface::default(),
        }
    }

    pub fn terminal_rows(&self) -> u16 {
        self.terminal_rows
    }

    pub fn set_terminal_rows(&mut self, rows: u16) {
        self.terminal_rows = rows;
    }

    /// Append one chat component (no cached layout yet). A paused window
    /// folds the append into its tail bookkeeping, never a geometry resolve.
    pub fn push_entry(&mut self, entry: ChatEntry) {
        self.pending_handoff = None;
        self.chat.push(entry);
        self.entry_layout.push([None, None, None]);
        self.sparse_note_append();
    }

    pub fn chat_len(&self) -> usize {
        self.chat.len()
    }

    /// Pop the LAST chat entry with its cached layout (SANCTIONED
    /// DIVERGENCE from TS, operator ruling 2026-09-23: the retry collapse
    /// drops the superseded failed attempt's error row).
    pub fn pop_chat_entry(&mut self) -> Option<ChatEntry> {
        self.pending_handoff = None;
        let index = self.chat.len().checked_sub(1)?;
        if self.sparse_window_is_tail_anchored() && self.layout_width > 0 {
            let rows = self.count_entry_rows(index, self.layout_width);
            self.sparse_tail_delta(-(rows as isize), index);
        }
        self.md_caches.borrow_mut().remove(&index);
        self.sparse_entries.remove(&index);
        self.toggled_cards.remove(&index);
        self.entry_heights.pop();
        self.entry_layout.pop();
        self.chat.pop()
    }

    /// Replace the text and tone of the status entry at `index` in place;
    /// `false` when the entry is not a status row.
    pub fn update_status_row(
        &mut self,
        index: usize,
        text: &str,
        kind: crate::chat::StatusKind,
    ) -> bool {
        self.prepare_entry_mutation(index);
        let Some(ChatEntry::Status {
            text: slot,
            kind: kind_slot,
        }) = self.chat.get_mut(index)
        else {
            return false;
        };
        *slot = text.to_string();
        *kind_slot = kind;
        self.mark_entry_stale(index);
        true
    }

    /// Append a replay transcript item (mapped onto chat components). A
    /// tool result completes the pending tool card with the same id.
    pub fn push(&mut self, item: TranscriptItem) {
        if let TranscriptItem::ToolResult {
            tool_call_id,
            tool_name,
            text,
            content,
            details,
            is_error,
        } = &item
        {
            let pending = self.chat.iter().rposition(|entry| {
                matches!(entry, ChatEntry::Tool(card) if card.id == *tool_call_id && card.result.is_none())
            });
            if let Some(index) = pending {
                // The result settles IN PLACE: the card's rows can grow
                // when it lands, so the sparse fold must be prepared first.
                self.prepare_entry_mutation(index);
                if let Some(ChatEntry::Tool(card)) = self.chat.get_mut(index) {
                    card.started = true;
                    // Replayed cards never saw the live execution: the
                    // timing collapses to the rebuild instant.
                    let now = std::time::Instant::now();
                    card.started_at = Some(now);
                    card.ended_at = Some(now);
                    card.result = Some(crate::chat::ToolResultView {
                        content: if content.is_empty() {
                            vec![serde_json::json!({ "type": "text", "text": text })]
                        } else {
                            content.clone()
                        },
                        details: details.clone(),
                        is_error: *is_error,
                    });
                    card.result_partial = false;
                }
                self.mark_entry_stale(index);
                return;
            }
            let view = crate::chat::ToolResultView {
                content: if content.is_empty() {
                    vec![serde_json::json!({ "type": "text", "text": text })]
                } else {
                    content.clone()
                },
                details: details.clone(),
                is_error: *is_error,
            };
            self.push_entry(ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
                id: tool_call_id.clone(),
                name: tool_name.clone(),
                args: serde_json::Value::Null,
                started: true,
                result: Some(view),
                ..Default::default()
            })));
            return;
        }
        let mut entry = item_to_entry(item);
        if let ChatEntry::BashExecution(card) = &mut entry {
            card.suppress_leading_space =
                matches!(self.chat.last(), Some(ChatEntry::AgentMessage(_)));
        }
        self.push_entry(entry);
    }

    /// Drop the whole transcript and its cached layout (a fresh snapshot
    /// rebuild re-renders every row).
    pub fn clear_chat(&mut self) {
        self.pending_handoff = None;
        self.sparse_enabled = true;
        self.sparse_entries.clear();
        self.toggled_cards.clear();
        self.sparse_window = None;
        self.chat.clear();
        self.entry_layout.clear();
        self.entry_heights.clear();
        self.md_caches.borrow_mut().clear();
        self.pending_bash.clear();
    }

    /// Prepare an in-place mutation of one entry: capture its current
    /// height for `mark_entry_stale`'s tail bookkeeping fold.
    pub fn prepare_entry_mutation(&mut self, index: usize) {
        self.pending_handoff = None;
        if self.sparse_window_is_tail_anchored() && self.layout_width > 0 {
            let rows = self.count_entry_rows(index, self.layout_width);
            self.sparse_mutation = Some((index, rows));
        }
    }

    /// Mark one chat entry's cached rows stale: the next frame lays it out again. A mutated
    /// entry changes every LATER spacing-driven row, so those go stale too.
    pub fn mark_entry_stale(&mut self, index: usize) {
        self.pending_handoff = None;
        if let Some((pending, before)) = self.sparse_mutation.take() {
            if pending == index && self.layout_width > 0 {
                let after = self.count_entry_rows(index, self.layout_width);
                self.sparse_tail_delta(after as isize - before as isize, index);
            }
        }
        if let Some(slot) = self.entry_layout.get_mut(index) {
            *slot = [None, None, None];
        }
        if let Some(slot) = self.entry_heights.get_mut(index) {
            *slot = [None, None, None];
        }
        for (offset, entry) in self.chat.iter().enumerate().skip(index + 1) {
            if matches!(
                entry,
                ChatEntry::AgentMessage(_) | ChatEntry::ShellCompletion(_) | ChatEntry::Tool(_)
            ) {
                if let Some(slot) = self.entry_layout.get_mut(offset) {
                    *slot = [None, None, None];
                }
                if let Some(slot) = self.entry_heights.get_mut(offset) {
                    *slot = [None, None, None];
                }
            }
        }
    }

    /// The conversation-detail label for the prompt-context row.
    fn detail_label(&self) -> String {
        let key = self
            .editor
            .keybindings()
            .first_key("app.tools.expand")
            .map(|key| crate::keybindings::format_key_text(&key))
            .unwrap_or_default();
        conversation_detail_status(
            self.detail.tool_output_expanded(),
            self.detail.show_thinking(),
            &key,
        )
    }

    /// Scroll the transcript window: scrolling up pauses following and
    /// reaching the bottom resumes it.
    pub fn scroll_by(&mut self, delta: isize) {
        if let Some(window) = &mut self.sparse_window {
            window.scroll_by(delta);
            self.following = window.at_tail();
            return;
        }
        let base = if self.following {
            self.last_max_scroll
        } else {
            self.scroll_top
        };
        self.scroll_top = (base as isize + delta).max(0) as usize;
        self.following = self.scroll_top >= self.last_max_scroll;
        if self.following {
            self.scroll_top = self.last_max_scroll;
        }
    }

    /// Jump to the transcript start; an empty transcript keeps following.
    pub fn scroll_to_top(&mut self) {
        if self.has_selection() {
            self.resolve_sparse_geometry();
        }
        self.sparse_window = Some(lazy::SparseWindow::top(self.detail, self.layout_width));
        self.scroll_top = 0;
        self.following = self.chat.is_empty();
    }

    pub fn scroll_to_bottom(&mut self) {
        if self.has_selection() {
            self.resolve_sparse_geometry();
        }
        self.sparse_window = None;
        self.scroll_top = self.last_max_scroll;
        self.following = true;
    }

    pub fn follow(&mut self) {
        self.sparse_window = None;
        self.following = true;
    }

    /// One page of the transcript window: the window minus one row, at
    /// least one.
    pub fn page_size(&self) -> usize {
        self.window_rows.saturating_sub(1).max(1)
    }

    pub fn is_following(&self) -> bool {
        self.following
    }

    pub fn scroll_info(&mut self) -> ScrollInfo {
        self.resolve_sparse_geometry();
        ScrollInfo {
            following: self.following,
            lines_above: self.scroll_top,
            lines_below: self.last_max_scroll.saturating_sub(self.scroll_top),
        }
    }

    /// Render the scrollable transcript: splash rows, chat rows, and the
    /// working loader (the full compose; fullscreen composes only its window).
    pub fn render_transcript(&mut self, width: usize) -> Vec<Line> {
        let layout = self.layout_pass(width);
        self.transcript_window(&layout, 0, usize::MAX)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollInfo {
    pub following: bool,
    pub lines_above: usize,
    pub lines_below: usize,
}

fn item_to_entry(item: TranscriptItem) -> ChatEntry {
    match item {
        TranscriptItem::UserMessage { text } => ChatEntry::User { text },
        TranscriptItem::SystemNote { text } => ChatEntry::Status {
            text,
            kind: crate::chat::StatusKind::Info,
        },
        TranscriptItem::Assistant {
            blocks,
            has_tool_calls,
        } => ChatEntry::Assistant(Box::new(crate::chat::AssistantMessage {
            blocks,
            has_tool_calls,
            streaming: false,
            error: None,
            aborted: false,
        })),
        TranscriptItem::ToolCall {
            id,
            name,
            arguments,
        } => ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id,
            name,
            args: serde_json::from_str(&arguments).unwrap_or(serde_json::Value::Null),
            started: false,
            ..Default::default()
        })),
        // A replayed tool result normally folds onto its pending card through `AgentView::push`;
        // this arm keeps a standalone card when unmatched.
        TranscriptItem::ToolResult {
            tool_call_id,
            tool_name,
            text,
            content,
            details,
            is_error,
        } => ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: tool_call_id,
            name: tool_name,
            args: serde_json::Value::Null,
            started: true,
            result: Some(crate::chat::ToolResultView {
                content: if content.is_empty() {
                    vec![serde_json::json!({ "type": "text", "text": text })]
                } else {
                    content
                },
                details,
                is_error,
            }),
            ..Default::default()
        })),
        TranscriptItem::BashExecution {
            command,
            output,
            exit_code,
            cancelled,
            truncated,
            full_output_path,
            excluded,
        } => {
            // The same component the live events render, completed over
            // the recorded output.
            let mut card = crate::bash_card::BashExecutionCard::settled(&command, excluded);
            card.append_output(&output);
            card.set_complete(exit_code, cancelled, truncated, full_output_path);
            ChatEntry::BashExecution(Box::new(card))
        }
        TranscriptItem::ModelChange { model_id, .. } => ChatEntry::Status {
            text: format!("\u{2699} {model_id}"),
            kind: crate::chat::StatusKind::Info,
        },
        TranscriptItem::CustomRow { entry } => entry,
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod chunk_selection_tests {
    use super::chunk_selection;

    /// A fully-covered line highlights to the chunk's own end (the
    /// chunk-local length), not `chunk length - source start`.
    #[test]
    fn wrapped_chunks_on_fully_covered_lines_highlight_to_their_end() {
        let sel = Some(((0, 10), (2, 5)));
        let range = chunk_selection(sel, 1, 20, "wrapped text");
        assert_eq!(range, Some((0, 12)), "the whole chunk highlights");
        let range = chunk_selection(sel, 2, 0, "abcde");
        assert_eq!(range, Some((0, 5)));
        let range = chunk_selection(sel, 2, 6, "fgh");
        assert_eq!(range, None);
        let range = chunk_selection(sel, 0, 0, "01234567890123456789");
        assert_eq!(range, Some((10, 20)));
        let range = chunk_selection(sel, 0, 10, "0123456789");
        assert_eq!(
            range,
            Some((0, 10)),
            "the selection starts at this chunk's start"
        );
        let range = chunk_selection(sel, 0, 5, "01234");
        assert_eq!(range, None, "the selection starts after this chunk ends");
    }
}
