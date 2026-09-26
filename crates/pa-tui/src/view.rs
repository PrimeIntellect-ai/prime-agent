//! Interactive agent view: fullscreen chat frame composed like the TS
//! interactive mode — a pinned top bar, a scrollable transcript window
//! (splash, chat rows, loader), and a dock (prompt-context line, editor
//! surface, tray). The session loop folds events into the view; this module
//! owns row geometry and scroll behavior only.

use crate::chat::{
    render_assistant, render_text_rows, render_user_block, ChatEntry, CompactionState, Detail,
    WorkingState,
};
use crate::chrome::{
    conversation_detail_status, render_prompt_context, render_top_bar, render_tray, ChromeState,
};
use crate::editor::Editor;
use crate::prompt_highlight::{
    command_token, editor_chunk_highlights, editor_text_spans, find_arg_tokens, ArgTokenSpan,
};
use crate::session::TranscriptItem;
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::str_width;
use crate::{Line, Span};
use pa_types::slash_commands::SlashCommandRegistry;
use ratatui::style::{Modifier, Style};

mod geometry;
mod layout;
pub(crate) mod lazy;
mod restyle;
mod runs;

use layout::EntryLayout;

/// Minimum transcript rows when the dock would crowd them out
/// (TS `FULLSCREEN_MIN_TRANSCRIPT_ROWS`).
pub const FULLSCREEN_MIN_TRANSCRIPT_ROWS: usize = 3;

/// TS `getSpacingContent`: an assistant message's conversation-spacing
/// classification at the current detail level.
enum SpacingContent {
    Visible,
    ToolOnly,
    Hidden,
}

/// A `/share` gist upload in flight (TS `BorderedLoader` with
/// `CancellableLoader`): the spinner "Creating gist..." rows that replace
/// the editor while `gh gist create` runs.
#[derive(Debug, Clone)]
pub struct ShareLoader {
    /// The message under the spinner.
    pub message: String,
}

impl ShareLoader {
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

/// The run-shape inputs one in-place mutation can move (the
/// `prepare_entry_mutation`/`mark_entry_stale` pair's capture): an
/// assistant flips its glue state (a boundary flip merges or splits
/// runs); an ipython card's parseable receipt ids are a condensing
/// threshold input (a result landing receipts can qualify a short
/// run, and a same-count id swap changes the dedupe); a card with no
/// receipt-bearing potential moves only its own rows - the run map's
/// shape never changes for it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RunShapeInputs {
    /// The assistant's glue state before the mutation.
    AssistantGlue(bool),
    /// The card's parseable receipt ids before the mutation (the
    /// threshold's change detector: a count change OR a same-count id
    /// swap re-derives the run map - the dedupe keys on ids).
    Receipts(Vec<Option<String>>),
}

pub struct AgentView {
    pub theme: Theme,
    /// The chat markdown fenced-code indent (`markdown.codeBlockIndent`,
    /// TS `getMarkdownThemeWithSettings`; default two spaces).
    pub code_block_indent: String,
    pub editor: Editor,
    pub chrome: ChromeState,
    /// Queued input parked behind the running turn (steering/follow-up
    /// lanes); renders as the dim strip above the prompt dock.
    pub queued: crate::queued::QueuedMessages,
    /// The queue item selected for browsing/edit (TS `QueueSelection`):
    /// while set, the dim browse header renders above the editor.
    pub queue_selected: Option<crate::queued::QueueSelectionItem>,
    pub chat: Vec<ChatEntry>,
    /// In-flight bash cards held ABOVE the execution indicator while the
    /// agent streams (TS `pendingMessagesContainer` +
    /// `pendingBashComponents`): a `bash_start` during an active turn
    /// mounts here and flushes into the transcript when the turn ends.
    pub pending_bash: Vec<crate::bash_card::BashExecutionCard>,
    pub detail: Detail,
    pub working: Option<WorkingState>,
    /// A compaction run in flight (TS `autoCompactionLoader`): replaces the
    /// working loader from `compaction_start` to `compaction_end`.
    pub compaction: Option<CompactionState>,
    /// The compaction loader's generation: bumped on every
    /// `compaction_start`, so a backgrounded abort outcome addresses the
    /// exact loader it was sent for — a late failure for a settled run
    /// never clears a newer run's loader.
    pub compaction_generation: u64,
    /// Animation frame for spinners and the working icon.
    pub pulse_frame: usize,
    /// When the current working loader started (elapsed label).
    pub working_since: Option<std::time::Instant>,
    /// An active provider auto-retry (replaces the working loader while
    /// the retry loop waits, TS `retryLoader`).
    pub retry: Option<crate::chat::RetryState>,
    /// The first-run onboarding pane (TS `runStartupOnboarding`): while
    /// set, it owns the whole frame.
    pub onboarding: Option<crate::onboarding::OnboardingScreen>,
    /// The `/model` inline picker (TS `ModelSelectorComponent` seam):
    /// while set, it owns the whole frame like the onboarding pane.
    pub model_picker: Option<crate::model_picker::ModelPicker>,
    /// The `/tree` selector (owns the frame while open).
    pub tree_selector: Option<crate::tree_selector::TreeSelector>,
    /// A pending extension confirm (TS `showExtensionConfirm`: the
    /// Yes/No selector over the editor dock).
    pub confirm: Option<crate::confirm::ConfirmPanel>,
    /// The `/login` / `/logout` provider selector (TS
    /// `OAuthSelectorComponent` inline): owns the frame while open.
    pub provider_auth: Option<crate::provider_auth::ProviderAuthSelector>,
    /// The inline auth panel (TS `LoginDialogComponent` +
    /// `PrimeTeamSelectorComponent`): owns the frame while a login flow
    /// drives it through the panel channel.
    pub auth_panel: Option<crate::auth_panel::AuthPanel>,
    /// The `/fork` user-message selector.
    pub fork_selector: Option<crate::user_message_selector::UserMessageSelector>,
    /// The `/effort` inline picker (TS `ThinkingSelectorComponent` seam):
    /// while set, it owns the whole frame like the model picker.
    pub effort_picker: Option<crate::effort_picker::EffortPicker>,
    /// The `/mcp` inline connections view (the MCP surface's own
    /// picker): while set, it owns the editor dock like the model
    /// picker.
    pub mcp_view: Option<crate::mcp_view::McpView>,
    /// The `/heartbeats` inline management view (TS
    /// `HeartbeatManagerComponent`, inline-picker style): while set, it
    /// owns the editor dock like the `/model` and `/effort` pickers.
    pub heartbeats_picker: Option<crate::heartbeats_picker::HeartbeatsPicker>,
    /// The read-only goal panel (the dock's `Pursuing goal` row): while
    /// `Some`, the panel owns the frame exactly like the docked pickers.
    pub goal_panel: Option<crate::goal_surface::GoalPanel>,
    /// The dedicated bash view (the dock's Bash group's destination):
    /// while set, it owns the editor dock like the inline pickers.
    pub bash_view: Option<crate::bash_view::BashView>,
    /// A `/share` gist upload in flight (TS `BorderedLoader`): while set,
    /// it replaces the editor with the cancellable loader rows.
    pub share_loader: Option<ShareLoader>,
    /// The `/reload` box (TS `handleReloadCommand`'s `reloadBox`): a
    /// bordered note that replaces the editor while the reload travels.
    pub reload_box: Option<String>,
    /// The side-question pane (TS `sideQuestionContainer`): mounted above
    /// the prompt dock (below the queue strip) while a side conversation
    /// is open; `None` is the main-thread state.
    pub side_pane: Option<crate::side_question::SideQuestionPane>,
    /// The `/settings` inline menu (TS `SettingsSelectorComponent`):
    /// mounted in the editor dock like the tree and fork selectors.
    pub settings_menu: Option<crate::settings_menu::SettingsMenu>,
    /// The `?` quick-shortcut guide (TS `shortcutGuideContainer`): while
    /// set, its markdown renders at the transcript tail, above the dock;
    /// the next submission clears it (TS `clearShortcutGuide`).
    pub shortcut_guide: Option<String>,
    /// The `terminal.showImages` setting (TS `getShowImages`, default
    /// true): image blocks render their metadata rows when set, their
    /// `[Image: ...]` text placeholders otherwise.
    pub show_images: bool,
    /// The runtime `terminal.fullscreen` preference (TS `fullscreenEnabled`):
    /// the fullscreen compose pins the top bar; the inline surface (TS
    /// `fullscreen rendering off`) renders without it.
    pub fullscreen: bool,
    /// The `showHardwareCursor` setting (TS default false): the hardware
    /// cursor is positioned at the focused caret for IME on every frame
    /// either way, but only shown when this is set — TS keeps the
    /// terminal's own cursor hidden by default so frame paints never drag
    /// a visible cursor across the pane (`positionHardwareCursor` and the
    /// paint tail move it while hidden).
    pub show_hardware_cursor: bool,
    pub(crate) scroll_top: usize,
    following: bool,
    /// The transcript-tail offset of the last composed frame (TS
    /// `lastMaxScroll`): scroll deltas page from here, not from zero.
    pub(crate) last_max_scroll: usize,
    /// Rows of the terminal the editor should lay out against.
    terminal_rows: u16,
    /// Cursor cell within the last dock render: (dock row, column).
    dock_cursor: Option<(usize, usize)>,
    /// Window height of the last composed frame (cursor positioning).
    pub(crate) window_rows: usize,
    /// Plain text of the last frame's rows: OSC zone-marker emission only
    /// re-emits rows whose content changed (mirroring the TS renderer,
    /// which writes a row's marker sequences when it rewrites that row).
    osc_last_rows: std::collections::HashMap<usize, String>,
    /// Rendered rows per chat entry and detail mode: a frame re-renders
    /// only entries invalidated since the last frame; settled entries keep
    /// their cached rows instead of re-running markdown and code previews.
    /// A transcript-scale frame pays full layout cost once per entry/detail, not
    /// once per draw. Each slot also stores the spacing decision its rows
    /// were laid out under (TS keeps every component's rendered lines
    /// resident and recomputes only the dynamic conversation-spacing
    /// decision per frame): a settled entry survives a live stream — the
    /// pre-fix render loop re-rendered every agent message in the
    /// transcript on every streaming delta, the dogfood CPU spin.
    entry_layout: Vec<[Option<EntryLayout>; 3]>,
    entry_heights: Vec<[Option<(bool, usize)>; 3]>,
    sparse_window: Option<lazy::SparseWindow>,
    sparse_enabled: bool,
    /// The height of the entry an in-place mutation is about to change,
    /// captured by `prepare_entry_mutation` and consumed by
    /// `mark_entry_stale` to grow the sparse window's tail bookkeeping by
    /// the mutation's delta instead of resolving the whole geometry.
    sparse_mutation: Option<(usize, usize)>,
    /// The condensed tool runs' suffix capture for one in-place mutation
    /// (the `prepare_entry_mutation`/`mark_entry_stale` pair): the
    /// affected run's start index and the suffix's row count before the
    /// mutation. The block's row-count change folds into the sparse
    /// window's tail bookkeeping through the run's owning index, except
    /// an assistant mutation that keeps the glue boundary (a streaming
    /// grow), which folds at the entry's own slot.
    runs_prepare: Option<(usize, usize)>,
    /// The run-shape input captured before one in-place mutation,
    /// independent of the sparse-window fold above (a top-anchored
    /// window folds nothing, but the run map still re-derives when the
    /// input moves); `mark_entry_stale` consumes it.
    runs_shape: Option<RunShapeInputs>,
    sparse_entries: std::collections::BTreeSet<usize>,
    /// The condensed tool runs (a purely render-time grouping, never
    /// stored): one slot per chat entry. Rebuilt from the earliest
    /// point a mutation can move a run's shape (the run map's own
    /// suffix protocol).
    pub(crate) run_map: crate::tool_runs::ToolRuns,
    /// Per-assistant-entry markdown block caches (TS `Markdown.blockCache`,
    /// one per component instance): a streaming message re-renders every
    /// frame, so its settled blocks replay from the cache instead of
    /// re-running inline styling and wrapping (only the growing final block
    /// renders fresh). `RefCell` because the layout pass borrows the chat
    /// immutably while rendering. Cleared wherever `entry_layout` is.
    md_caches:
        std::cell::RefCell<std::collections::HashMap<usize, crate::markdown::MarkdownBlockCache>>,
    /// The width the cached rows were laid out for.
    pub(crate) layout_width: usize,
    /// Rendering options that affect cached entry rows.
    layout_options: Option<(Theme, String, bool, bool)>,
    /// Row texts of the inline frame at the last main-screen flush (TS
    /// `exitFullscreen`'s inline repaint): the next flush diffs against
    /// this, so suspend/resume/exit cycles never duplicate the transcript
    /// in terminal scrollback.
    flushed_frame: Vec<String>,
    /// Rows of the last composed frame (frame-selection geometry; TS
    /// `lastFrameVisibleHeight`).
    pub(crate) frame_rows: usize,
    /// In-app mouse text selection (TS `FullscreenViewport`'s selection
    /// state): anchor/head points, the mode, and the frame snapshot.
    pub(crate) selection: crate::selection::SelectionState,
    /// The selection restyle cache (TS re-styles rendered rows per
    /// frame; the window re-styles only the rows the selection change
    /// touched): walked base rows, their styled copies, and the spans.
    pub(crate) selection_restyle: restyle::SelectionRestyle,
    /// The ephemeral action toasts (the top-right auto-dismiss overlay;
    /// a sanctioned divergence from TS — see `toast`).
    pub toasts: crate::toast::Toasts,
}

/// Clip the editor selection to one rendered chunk (view.rs): the
/// selection's (line, col) bounds become a char range within `text` — the
/// chunk of `source_line` starting at `source_start`. `None` when the
/// selection does not touch this chunk. Lines fully inside the selection
/// highlight whole; the boundary lines clip at the selection's columns.
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
    // The start column is a source-line column (it converts to the
    // chunk's coordinates); a fully-covered line selects to the chunk's
    // end directly, and the END line's column converts like the start.
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
    /// TS `isCompactAgentMessageNeighbor`: agent messages, tool calls (the
    /// ipython cells included), bash executions, and shell completions
    /// render flush against each other — the set both the leading-space
    /// scan and `precededByToolActivity` compact decisions use.
    pub(super) fn is_compact_neighbor(&self, entry: &ChatEntry) -> bool {
        matches!(
            entry,
            ChatEntry::Tool(_)
                | ChatEntry::AgentMessage(_)
                | ChatEntry::ShellCompletion(_)
                | ChatEntry::BashExecution(_)
        )
    }

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
            // TS #2447: a chat starts at the middle conversation-detail
            // level (edit diffs expanded, thinking visible, tool output
            // collapsed); Ctrl+O keeps cycling overview -> details -> all.
            detail: Detail::Details,
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
            effort_picker: None,
            mcp_view: None,
            heartbeats_picker: None,
            goal_panel: None,
            bash_view: None,
            share_loader: None,
            reload_box: None,
            side_pane: None,
            settings_menu: None,
            shortcut_guide: None,
            show_images: true,
            fullscreen: true,
            show_hardware_cursor: false,
            scroll_top: 0,
            following: true,
            last_max_scroll: 0,
            terminal_rows: 24,
            dock_cursor: None,
            window_rows: 0,
            osc_last_rows: std::collections::HashMap::new(),
            toasts: crate::toast::Toasts::default(),
            entry_layout: Vec::new(),
            entry_heights: Vec::new(),
            sparse_window: None,
            sparse_enabled: true,
            sparse_entries: std::collections::BTreeSet::new(),
            md_caches: std::cell::RefCell::new(std::collections::HashMap::new()),
            layout_width: 0,
            layout_options: None,
            flushed_frame: Vec::new(),
            frame_rows: 0,
            selection: crate::selection::SelectionState::default(),
            selection_restyle: restyle::SelectionRestyle::default(),
            sparse_mutation: None,
            runs_prepare: None,
            runs_shape: None,
            run_map: crate::tool_runs::ToolRuns::default(),
        }
    }

    /// Zone-marker emission plan for a freshly composed frame: every marked
    /// row whose content changed since the last frame. The marker sequences
    /// are part of the row content (a row gaining or keeping its marker is a
    /// changed row, exactly like the TS renderer's per-row writes).
    pub fn take_osc_emissions(
        &mut self,
        frame: &[Line],
    ) -> Vec<(usize, crate::osc133::RowMarkers)> {
        // Only candidate rows build their text: the zone markers ride on a
        // handful of boundary rows, so joining the whole frame costs
        // O(transcript) per render for a comparison only marked rows need.
        // The stored text carries the zero-width marker sequences, so a
        // row gaining or keeping its marker is a changed row exactly like
        // the TS renderer's per-row writes.
        let mut plan = Vec::new();
        let mut last_rows = std::collections::HashMap::new();
        for (row, line) in frame.iter().enumerate() {
            let markers = crate::osc133::row_markers(line);
            if !markers.start && !markers.end {
                continue;
            }
            let text: String = line.iter().map(|s| s.content.as_str()).collect();
            let changed = self
                .osc_last_rows
                .get(&row)
                .is_none_or(|prev| prev != &text);
            if changed {
                plan.push((row, markers));
            }
            last_rows.insert(row, text);
        }
        self.osc_last_rows = last_rows;
        plan
    }

    /// The terminal height the pickers size themselves against.
    pub fn terminal_rows(&self) -> u16 {
        self.terminal_rows
    }

    pub fn set_terminal_rows(&mut self, rows: u16) {
        self.terminal_rows = rows;
    }

    /// Append one chat component (no cached layout yet: the next frame
    /// renders it and stores its rows). A paused window keeps its rows:
    /// the append folds into the sparse window's tail bookkeeping (TS
    /// keeps `scrollTop` while content appends), never a geometry resolve.
    pub fn push_entry(&mut self, entry: ChatEntry) {
        // A glue-or-tool push can extend or newly qualify a tail run:
        // capture the affected suffix's rows BEFORE the push, rebuild
        // the run map from the sequence's start, and fold the whole
        // row-count change (the pushed entry's own rows plus the block's
        // growth or first condensation) through the run's owning index.
        // Any other entry renders on its own: the plain append fold.
        let glued = crate::tool_runs::is_run_glue(&entry);
        let captured = glued.then(|| {
            // The pushed glue can only extend a run that ends at the
            // very tail: a non-glue last entry ends every earlier run,
            // so the affected suffix starts at the push's own slot. The
            // walk must not skip past that boundary row into the
            // earlier run's start - a paused window would fold the
            // append in above the content it is holding still.
            let start = if self.chat.last().is_some_and(crate::tool_runs::is_run_glue) {
                self.member_start(self.chat.len().saturating_sub(1))
            } else {
                self.chat.len()
            };
            let before = self
                .sparse_window_is_tail_anchored()
                .then(|| (start, self.suffix_rows(start, self.layout_width)));
            (start, before)
        });
        self.chat.push(entry);
        self.entry_layout.push([None, None, None]);
        if let Some((start, before)) = captured {
            if self.run_map.append_tail(&self.chat) {
                // The in-place tail patch widened the owning run's extent:
                // only its block's cached rows (at the start slot)
                // re-render - the members' rows never left their empty
                // caches, and the pushed slot has none yet.
                if let Some(slot) = self.entry_layout.get_mut(start) {
                    *slot = [None, None, None];
                }
                if let Some(slot) = self.entry_heights.get_mut(start) {
                    *slot = [None, None, None];
                }
            } else {
                self.run_map.rebuild_from(&self.chat, start);
                self.invalidate_run_suffix(start);
            }
            if let Some((start, before)) = before {
                let after = self.suffix_rows(start, self.layout_width);
                // A qualifying run grew its block - the run's owning
                // index carries the whole change. Without one (a short
                // uncondensed sequence, or a standalone card) the push's
                // own slot owns its rows: the fold lands there, never
                // at the sequence's first card.
                let fold = match self.run_map.run_at(start) {
                    Some(_) => start,
                    None => self.chat.len() - 1,
                };
                self.sparse_tail_delta(after as isize - before as isize, fold);
            }
        } else {
            // A non-glue entry never joins a run: keep the map in
            // lockstep with the chat vector (the push's own slot).
            self.run_map.rebuild_from(&self.chat, self.chat.len() - 1);
            self.sparse_note_append();
        }
    }

    /// The number of chat entries (the status-row in-place update checks
    /// whether its own row is still the transcript's last entry).
    pub fn chat_len(&self) -> usize {
        self.chat.len()
    }

    /// Pop the LAST chat entry with its cached layout (the retry-episode
    /// collapse: the superseded failed attempt's error row leaves the
    /// chat when its retry replaces it — SANCTIONED DIVERGENCE from TS,
    /// operator ruling 2026-09-23). The sparse window's tail shrinks by
    /// the entry's rows, mirroring `push_entry`'s growth note.
    pub fn pop_chat_entry(&mut self) -> Option<ChatEntry> {
        let index = self.chat.len().checked_sub(1)?;
        // A glue-or-tool pop can shrink a tail run below the condensing
        // threshold (the block dissolves back into card rows): fold the
        // affected suffix's whole row-count change through the run's
        // owning index, exactly the push path in reverse. Any other
        // entry folds its own rows only.
        let captured = crate::tool_runs::is_run_glue(&self.chat[index]).then(|| {
            let start = self.member_start(index);
            let before = self
                .sparse_window_is_tail_anchored()
                .then(|| (start, self.suffix_rows(start, self.layout_width)));
            (start, before)
        });
        match &captured {
            Some((start, _)) => {
                if let Some(slot) = self.entry_layout.get_mut(*start) {
                    *slot = [None, None, None];
                }
            }
            None => {
                if self.sparse_window_is_tail_anchored() && self.layout_width > 0 {
                    let rows = self.count_entry_rows(index, self.layout_width);
                    self.sparse_tail_delta(-(rows as isize), index);
                }
            }
        }
        self.md_caches.borrow_mut().remove(&index);
        self.sparse_entries.remove(&index);
        self.entry_heights.pop();
        self.entry_layout.pop();
        let popped = self.chat.pop();
        if let Some((start, before)) = captured {
            self.run_map.rebuild_from(&self.chat, start);
            self.invalidate_run_suffix(start);
            if let Some((start, before)) = before {
                let after = self.suffix_rows(start, self.layout_width);
                // A qualifying run shrank its block - the run's owning
                // index carries the whole change. Without one (a solo
                // card leaving a short uncondensed sequence) the popped
                // slot owns its rows: the fold lands there, never at
                // the sequence's first card.
                let fold = match self.run_map.run_at(start) {
                    Some(_) => start,
                    None => index,
                };
                self.sparse_tail_delta(after as isize - before as isize, fold);
            }
        } else {
            // A non-glue pop (the retry-episode error row) left the
            // map one slot long: truncate it back into lockstep - the
            // entries before the popped row never moved, but a stale
            // slot would let the next tail append misread the tail.
            self.run_map.truncate_tail(&self.chat);
        }
        popped
    }

    /// Replace the text and tone of the status entry at `index` (TS
    /// `showStatus` updates its previous status row in place when nothing
    /// followed it). Returns `false` when the entry is not a status row.
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

    /// Append a replay transcript item (mapped onto chat components).
    ///
    /// A tool result completes the pending tool card with the same id
    /// (TS `buildConversationComponents` folds results onto their call
    /// components, never a new row); a result without a pending card keeps
    /// its standalone card so the row never disappears.
    pub fn push(&mut self, item: TranscriptItem) {
        if let TranscriptItem::ToolResult {
            tool_call_id,
            tool_name,
            text,
            content,
            details,
            is_error,
            timestamp,
        } = &item
        {
            let pending = self.chat.iter().rposition(|entry| {
                matches!(entry, ChatEntry::Tool(card) if card.id == *tool_call_id && card.result.is_none())
            });
            if let Some(index) = pending {
                // The matched card's result settles IN PLACE: prepare
                // the sparse fold first - the card's rows (or its run's
                // block) can grow or wrap when the result lands, and
                // `mark_entry_stale` alone never captures the row delta
                // for a tail-anchored window.
                self.prepare_entry_mutation(index);
                if let Some(ChatEntry::Tool(card)) = self.chat.get_mut(index) {
                    card.started = true;
                    // Replayed cards never saw the live execution: the
                    // timing collapses to the rebuild instant, matching
                    // the snapshot path.
                    let now = std::time::Instant::now();
                    card.started_at = Some(now);
                    card.ended_at = Some(now);
                    card.ended_ms = (*timestamp > 0).then_some(*timestamp);
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
                ended_ms: (*timestamp > 0).then_some(*timestamp),
                result: Some(view),
                // An orphan keeps its own standalone row: it never
                // joins a condensed run (it is not a call).
                unmatched_result: true,
                ..Default::default()
            })));
            return;
        }
        // TS `bash_start`/`addMessageToChat` suppress the component's
        // leading spacer only against an agent-message row.
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
        self.sparse_enabled = true;
        self.sparse_entries.clear();
        self.sparse_window = None;
        self.chat.clear();
        self.entry_layout.clear();
        self.entry_heights.clear();
        self.run_map.rebuild_from(&self.chat, 0);
        self.runs_prepare = None;
        self.runs_shape = None;
        self.md_caches.borrow_mut().clear();
        // A rebuilt transcript has no pending hold (TS
        // `resetCurrentSessionRenderState` clears `pendingBashComponents`).
        self.pending_bash.clear();
    }

    /// Prepare an in-place mutation of one entry: capture its current
    /// height so `mark_entry_stale` folds the growth into the sparse
    /// window's tail bookkeeping instead of resolving the whole geometry
    /// (a streaming delta on a paused or selecting view re-styles the
    /// entry's rows, never the transcript). Top-anchored windows are
    /// absolute already and need nothing.
    pub fn prepare_entry_mutation(&mut self, index: usize) {
        // The run-shape capture is independent of the sparse-window fold
        // below: a top-anchored window folds nothing, but the run map
        // still re-derives when the shape input moves (a result landing
        // agent-message receipts can qualify a short run while the user
        // is scrolled away), so `mark_entry_stale` reads this capture
        // regardless of the window mode.
        self.runs_shape = match self.chat.get(index) {
            Some(ChatEntry::Assistant(_)) => Some(RunShapeInputs::AssistantGlue(
                crate::tool_runs::is_run_glue(&self.chat[index]),
            )),
            Some(ChatEntry::Tool(card)) => Some(RunShapeInputs::Receipts(
                crate::tool_runs::card_receipt_ids(card),
            )),
            _ => None,
        };
        if self.sparse_window_is_tail_anchored() && self.layout_width > 0 {
            // A glue-or-tool entry's mutation moves its run's block, not
            // just its own rows: capture the affected suffix so
            // `mark_entry_stale` folds the whole change through the
            // run's owning index (the per-entry capture never sees the
            // block, which lives on the run's first entry). An assistant
            // mutates the same way: it can cross the glue boundary in
            // either direction (a streamed message gains text and its
            // run splits; a rebuilt one loses it and the runs merge), so
            // its capture is the run-aware suffix too.
            let assistant = matches!(self.chat[index], ChatEntry::Assistant(_));
            if assistant || crate::tool_runs::is_run_glue(&self.chat[index]) {
                let start = self.member_start(index);
                let before = self.suffix_rows(start, self.layout_width);
                self.sparse_mutation = None;
                self.runs_prepare = Some((start, before));
                return;
            }
            let rows = self.count_entry_rows(index, self.layout_width);
            self.runs_prepare = None;
            self.sparse_mutation = Some((index, rows));
        }
    }

    /// Mark one chat entry's cached rows stale: a mutation changed its
    /// content (streamed blocks, tool-card state, an attached error row),
    /// so the next frame lays it out again. A mutated entry can also
    /// change the conversation-leading decision of every LATER
    /// spacing-driven row (the look-back scans cross it), so those cached
    /// layouts go stale too — the sweep walks the suffix after the
    /// mutation point, which is the animating tail in the streaming case,
    /// not the whole transcript.
    pub fn mark_entry_stale(&mut self, index: usize) {
        // A mutated assistant message can cross the run-glue boundary (a
        // streamed message gains text and its run splits; a rebuilt one
        // loses it), and a tool result landing agent-message receipts
        // moves the condensing threshold (the receipts are items):
        // rebuild the run map's affected suffix so the grouping always
        // matches the entries it reads.
        let inputs = self.runs_shape.take();
        let rebuild = match self.chat.get(index) {
            Some(ChatEntry::Assistant(_)) => Some(self.member_start(index)),
            Some(ChatEntry::Tool(card)) => match inputs.as_ref() {
                Some(RunShapeInputs::Receipts(before))
                    if crate::tool_runs::card_receipt_ids(card) != before.as_slice() =>
                {
                    Some(self.member_start(index))
                }
                _ => None,
            },
            _ => None,
        };
        if let Some(start) = rebuild {
            self.run_map.rebuild_from(&self.chat, start);
        }
        // The sparse-window fold: a glue-or-tool mutation folded its run's
        // whole suffix (the block's change included) through the run's
        // owning index; any other mutation folds its own rows.
        if let Some((start, before)) = self.runs_prepare.take() {
            if self.layout_width > 0 {
                let after = self.suffix_rows(start, self.layout_width);
                // An assistant that kept its glue state only grew its
                // own rows (the streaming case): fold at the entry's
                // own slot, exactly like every other self-contained
                // mutation. A boundary flip (the merge/split), a
                // receipt change that crossed the threshold, or a
                // member card's state change folds through the run's
                // owning index - the block's shape moved there.
                let fold = match inputs {
                    Some(RunShapeInputs::AssistantGlue(was))
                        if crate::tool_runs::is_run_glue(&self.chat[index]) == was =>
                    {
                        index
                    }
                    // A boundary flip (the merge/split) or a receipt
                    // change that re-derived the run map reshapes the
                    // block at the captured suffix start - a formed,
                    // dissolved, or re-counted run moves its rows there
                    // (and the standalone card's own start IS its index).
                    Some(RunShapeInputs::AssistantGlue(_) | RunShapeInputs::Receipts(_))
                        if rebuild.is_some() =>
                    {
                        start
                    }
                    // Everything else is a bare content/state change:
                    // a member card moves the BLOCK's rows (they live at
                    // the run's start); a solo card (a short uncondensed
                    // sequence, or a standalone card) moves only its own
                    // rows - the fold lands there, never at the
                    // sequence's first card.
                    Some(RunShapeInputs::AssistantGlue(_) | RunShapeInputs::Receipts(_)) | None => {
                        match self.run_map.slot(index) {
                            Some(
                                crate::tool_runs::RunSlot::Start(_)
                                | crate::tool_runs::RunSlot::Member,
                            ) => start,
                            _ => index,
                        }
                    }
                };
                self.sparse_tail_delta(after as isize - before as isize, fold);
            }
        } else if let Some((pending, before)) = self.sparse_mutation.take() {
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
        // A mutation inside a condensed run re-renders the block itself
        // (its counts, wall-clock, and status glyph read the run's
        // cards), and an assistant flip re-rendered every entry the
        // rebuild reclassified: drop the whole affected suffix's caches.
        let invalidate_from = match rebuild {
            Some(start) => Some(start),
            None => self.run_map.block_owner(index),
        };
        if let Some(start) = invalidate_from {
            self.invalidate_run_suffix(start);
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

    /// Scroll the transcript window (TS `FullscreenViewport.scrollBy`):
    /// a following view pages from the tail; scrolling up pauses following
    /// and reaching the bottom resumes it.
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

    /// Jump to the transcript start (TS `scrollToTop`); an empty transcript
    /// keeps following.
    pub fn scroll_to_top(&mut self) {
        if self.has_selection() {
            self.resolve_sparse_geometry();
        }
        self.sparse_window = Some(lazy::SparseWindow::top(self.detail, self.layout_width));
        self.scroll_top = 0;
        self.following = self.chat.is_empty();
    }

    /// Jump to the transcript end and resume following (TS
    /// `scrollToBottom`).
    pub fn scroll_to_bottom(&mut self) {
        if self.has_selection() {
            self.resolve_sparse_geometry();
        }
        self.sparse_window = None;
        self.scroll_top = self.last_max_scroll;
        self.following = true;
    }

    /// Resume following (fresh attach, session switch).
    pub fn follow(&mut self) {
        self.sparse_window = None;
        self.following = true;
    }

    /// One page of the transcript window (TS `pageSize`: the window minus
    /// one row, at least one).
    pub fn page_size(&self) -> usize {
        self.window_rows.saturating_sub(1).max(1)
    }

    /// Whether the window pins the transcript tail.
    pub fn is_following(&self) -> bool {
        self.following
    }

    /// Scroll state of the last composed frame (TS `ScrollInfo`).
    pub fn scroll_info(&mut self) -> ScrollInfo {
        self.resolve_sparse_geometry();
        ScrollInfo {
            following: self.following,
            lines_above: self.scroll_top,
            lines_below: self.last_max_scroll.saturating_sub(self.scroll_top),
        }
    }

    /// TS `createConversationSpacing.shouldAddLeadingSpace` for one
    /// spacing-driven custom row (agent message, shell completion): scan
    /// back over entries that contribute no rows at this detail level
    /// (hidden thinking-only and tool-only assistant messages), then apply
    /// the trailing-space and compact-neighbor rules. `expanded` follows
    /// the TS `shouldAddLeadingSpace(expanded)` call shape.
    fn conversation_leading(&self, index: usize, expanded: bool) -> bool {
        let mut idx = index;
        let mut tool_separator = false;
        while idx > 0 {
            idx -= 1;
            match &self.chat[idx] {
                ChatEntry::Assistant(message) => {
                    match self.assistant_spacing_content(message) {
                        SpacingContent::Hidden => {}
                        SpacingContent::ToolOnly => {
                            tool_separator = true;
                        }
                        SpacingContent::Visible => {
                            // TS `hasTrailingSpace` on the visible body
                            // (`precededByToolActivity` is the full compact
                            // set: a tool call, agent message, bash
                            // execution, or shell completion).
                            let preceded_by_tool =
                                idx > 0 && self.is_compact_neighbor(&self.chat[idx - 1]);
                            if tool_separator
                                || message.has_trailing_space(self.detail, preceded_by_tool)
                            {
                                return false;
                            }
                            // An assistant message is never a compact
                            // neighbor; the collapsed and expanded rules
                            // both add the leading blank here.
                            return true;
                        }
                    }
                }
                preceding => {
                    if tool_separator && !self.is_compact_neighbor(preceding) {
                        return false;
                    }
                    if expanded {
                        return true;
                    }
                    return !self.is_compact_neighbor(preceding);
                }
            }
        }
        // The scan exhausted the transcript (only hidden or tool-only
        // assistant rows): TS keeps the tool separator with a trailing
        // space (no leading blank); with nothing preceding at all, the
        // expanded form sits flush against the top of the chat while the
        // collapsed form still leads with a blank
        // (`!isCompactAgentMessageNeighbor(undefined)`).
        if tool_separator {
            return false;
        }
        !expanded
    }

    /// TS `getSpacingContent`: an assistant message's contribution to
    /// conversation spacing at the current detail level.
    fn assistant_spacing_content(&self, message: &crate::chat::AssistantMessage) -> SpacingContent {
        let visible_body = message.blocks.iter().any(|block| match block {
            crate::chat::MessageBlock::Thinking(text) => {
                self.detail.show_thinking() && !text.trim().is_empty()
            }
            crate::chat::MessageBlock::Text(text) => !text.trim().is_empty(),
        });
        if visible_body || message.aborted || (message.error.is_some() && !message.has_tool_calls) {
            return SpacingContent::Visible;
        }
        if message.has_tool_calls {
            SpacingContent::ToolOnly
        } else {
            SpacingContent::Hidden
        }
    }

    /// Lay out one chat entry's transcript rows (the only producer of
    /// cached layout rows).
    fn render_entry(
        &self,
        index: usize,
        entry: &ChatEntry,
        width: usize,
        first: bool,
        preceded_by_tool_activity: bool,
    ) -> Vec<Line> {
        #[cfg(test)]
        layout::ENTRY_RENDERS.with(|count| count.set(count.get() + 1));
        // A condensed run's block renders in place of its entries in the
        // collapsed detail mode (the members render nothing); every other
        // detail mode renders each entry exactly as before.
        if let Some(rows) = self.render_condensed(index, width) {
            return rows;
        }
        let detail = self.detail;
        match entry {
            ChatEntry::Status { text, kind } => {
                let style = match kind {
                    crate::chat::StatusKind::Info => self.theme.fg_style(ThemeColor::Dim),
                    crate::chat::StatusKind::Warning => self.theme.fg_style(ThemeColor::Warning),
                    crate::chat::StatusKind::Error => self.theme.fg_style(ThemeColor::Error),
                };
                let mut rows = Vec::new();
                rows.push(Vec::new());
                rows.extend(render_text_rows(text, style, width));
                rows
            }
            ChatEntry::User { text } => {
                let mut rows = Vec::new();
                // TS `addMessageToChat` separates a user submission from
                // the components above it with `Spacer(1)` — EXCEPT the
                // skill invocation's own argument text, which joins the
                // card below it without a spacer.
                let follows_skill_card =
                    index > 0 && matches!(self.chat[index - 1], ChatEntry::SkillInvocation(_));
                if !first && !follows_skill_card {
                    rows.push(Vec::new());
                }
                rows.extend(render_user_block(
                    text,
                    &self.theme,
                    &self.code_block_indent,
                    width,
                ));
                rows
            }
            ChatEntry::SlashCommand { text } => {
                // The echo row leads with a spacer when the chat is not
                // empty (TS adds `Spacer(1)` before the component).
                let mut rows = Vec::new();
                if !first {
                    rows.push(Vec::new());
                }
                rows.extend(crate::chat_slash::render_slash_command(
                    text,
                    &self.theme,
                    width,
                ));
                rows
            }
            ChatEntry::CompactionSummary {
                summary,
                tokens_before,
                custom_instructions,
            } => {
                // TS `addMessageToChat` conversation spacing: the summary
                // follows the previous component with `Spacer(1)` when not
                // first (in the rebuilt transcript it trails the kept
                // tail's echo row).
                let mut rows = Vec::new();
                if !first {
                    rows.push(Vec::new());
                }
                rows.extend(crate::compaction_row::render_compaction_summary(
                    summary,
                    *tokens_before,
                    custom_instructions.as_deref(),
                    // TS `applyChatExpansion` fans `toolOutputExpanded`
                    // out to every `ExpandableEventMessage` in the chat;
                    // `CompactionSummaryMessageComponent` renders the
                    // collapsed `EventSummary` until the Ctrl+O cycle
                    // reaches detail `all`.
                    detail.tool_output_expanded(),
                    &self.theme,
                    width,
                ));
                rows
            }
            ChatEntry::Assistant(message) => {
                // The per-entry block cache (TS's per-component
                // `blockCache`): settled blocks of the streaming message
                // replay instead of re-rendering on every frame.
                let mut caches = self.md_caches.borrow_mut();
                let cache = caches.entry(index).or_default();
                render_assistant(
                    message,
                    detail,
                    &self.theme,
                    &self.code_block_indent,
                    width,
                    preceded_by_tool_activity,
                    cache,
                )
            }
            ChatEntry::Tool(card) => {
                // TS `ToolExecutionComponent`: the leading spacer rides on
                // `createConversationSpacing(...).shouldAddLeadingSpace`
                // (the same spacing the assistant and agent-message rows
                // use; consecutive tool cards stay flush).
                let mut rows: Vec<Line> = Vec::new();
                if self.conversation_leading(index, detail.tool_output_expanded()) {
                    rows.push(Vec::new());
                }
                rows.extend(crate::tool_card::render_tool_card(
                    card,
                    self.pulse_frame,
                    detail,
                    &self.theme,
                    width,
                    self.show_images,
                ));
                rows
            }
            ChatEntry::BashExecution(card) => {
                // TS `BashExecutionComponent` mounts with `Spacer(1)`
                // unless it follows an agent-message component
                // (`suppressLeadingSpace`, decided at mount time).
                let mut rows: Vec<Line> = Vec::new();
                if !card.suppress_leading_space {
                    rows.push(Vec::new());
                }
                // TS `keyText("tui.select.cancel")`: every key of the
                // binding joins the hint ("Esc/Ctrl+C").
                let cancel_hint = self.editor.keybindings().key_text("tui.select.cancel");
                rows.extend(crate::bash_card::render_bash_execution(
                    card,
                    self.pulse_frame,
                    detail.tool_output_expanded(),
                    &cancel_hint,
                    &self.theme,
                    width,
                ));
                rows
            }
            ChatEntry::AgentMessage(row) => crate::custom_message::render::render_agent_message(
                row,
                detail,
                &self.theme,
                width,
                self.conversation_leading(index, detail.tool_output_expanded()),
            ),
            // TS `addMessageToChat`'s user case: `Spacer(1)` when the chat
            // is non-empty, then the card (the conversation-spacing scan the
            // agent-message rows use does not apply — the TS user case is
            // the plain children-count check).
            ChatEntry::SkillInvocation(row) => {
                crate::custom_message::skill_invocation::render_skill_invocation(
                    row,
                    detail,
                    &self.theme,
                    width,
                    !first,
                )
            }
            ChatEntry::InjectedPrompt(row) => {
                crate::custom_message::injected_prompt::render_injected_prompt(
                    row,
                    detail,
                    &self.theme,
                    width,
                )
            }
            ChatEntry::ShellCompletion(row) => {
                crate::custom_message::render::render_shell_completion(
                    row,
                    detail,
                    &self.theme,
                    width,
                    self.conversation_leading(index, detail.tool_output_expanded()),
                )
            }
            ChatEntry::RefinementOutcome(row) => {
                crate::custom_message::refinement::render_refinement_outcome(
                    row,
                    detail,
                    &self.theme,
                    width,
                )
            }
            ChatEntry::CustomPanel(row) => {
                crate::custom_message::render::render_custom_panel(row, &self.theme, width)
            }
            // TS `/hotkeys`: `Spacer(1)` then `new Markdown(guide, 1, 1)`
            // — the markdown component's `paddingY=1` renders one blank row
            // above and below the content (one margin column each side,
            // rows padded to the full width, like the assistant blocks).
            ChatEntry::ClientMarkdown { text } => {
                let mut rows: Vec<Line> = Vec::new();
                rows.push(Vec::new());
                rows.push(Vec::new());
                let mut md = crate::markdown::MarkdownStyle::from_theme(&self.theme);
                md.code_block_indent.clone_from(&self.code_block_indent);
                rows.extend(crate::chat::render_markdown_block(
                    text,
                    &md,
                    width,
                    &mut crate::markdown::MarkdownBlockCache::default(),
                ));
                rows.push(Vec::new());
                rows
            }
            // TS `Spacer(1)` + `Text(info, 1, 0)` blocks: one blank row,
            // then the styled source lines wrapped with a one-column
            // margin on each side (the info displays).
            ChatEntry::ClientText { rows } => {
                crate::info_commands::render_client_text(rows, &self.theme, width)
            }
            // The `/changelog` panel: border, the accent `What's New`
            // title, and the entries markdown between the closing border.
            ChatEntry::ChangelogPanel { markdown } => crate::info_commands::render_changelog_panel(
                markdown,
                &self.theme,
                &self.code_block_indent,
                width,
            ),
        }
    }

    /// Render the scrollable transcript: splash rows, chat component rows,
    /// and the working loader when a turn is active (the full compose —
    /// the inline frame and the headless verifiers; the fullscreen frame
    /// composes only its scroll window through the layout pass).
    pub fn render_transcript(&mut self, width: usize) -> Vec<Line> {
        let layout = self.layout_pass(width);
        self.transcript_window(&layout, 0, usize::MAX)
    }

    /// Render the dock: prompt-context row(s), the autocomplete overlay
    /// (when showing), the editor surface, the tray, and the subagent
    /// summary box (TS `SubagentSummaryLine` under the tray).
    pub fn render_dock(&mut self, width: usize) -> Vec<Line> {
        // The queued-input strip sits directly above the prompt dock rows
        // (TS `queuedMessagesContainer` above the editor).
        let browse_key = {
            let kb = self.editor.keybindings();
            crate::keybindings::format_key_text(&kb.get_keys("app.message.navigateOlder").join("/"))
        };
        let queue_rows = crate::queued::render_queue(&self.theme, &self.queued, &browse_key, width);
        let mut lines = queue_rows;
        lines.extend(render_prompt_context(
            &self.detail_label(),
            &self.theme,
            width,
        ));
        let context_rows = lines.len();
        let overlay_rows = self.render_autocomplete_overlay(width);
        lines.extend(overlay_rows);
        let (editor_rows, cursor) = self.render_editor_surface(width);
        let overlay_count = lines.len() - context_rows;
        self.dock_cursor = cursor.map(|(row, col)| (context_rows + overlay_count + row, col));
        lines.extend(editor_rows);
        lines.push(render_tray(&self.chrome, &self.theme, width));
        if let Some(dock) = &self.chrome.activity {
            if let Some(frame) = crate::chrome::render_activity_dock(dock, &self.theme, width) {
                lines.extend(frame);
            }
        }
        // The `/speed` footer (TS `footerSlot`, the main container's last
        // child): a dim row only while the display is on with a sample.
        if let Some(speed) = &self.chrome.speed_text {
            lines.push(crate::chrome::render_speed_footer(
                speed,
                &self.theme,
                width,
            ));
        }
        lines
    }

    /// The autocomplete dropdown, mounted just above the editor surface (TS
    /// anchors the overlay immediately above the cursor row; the editor's
    /// first content row carries the cursor in the common single-line
    /// case). Each row pads to the input width and floats on the popup
    /// background between the editor's left padding and prompt prefix.
    fn render_autocomplete_overlay(&mut self, width: usize) -> Vec<Line> {
        let Some(state) = self.editor.autocomplete_state() else {
            return Vec::new();
        };
        let theme = &self.theme;
        let bg = self.theme.bg_style(ThemeBg::ToolPanelBg);
        let padding_x = 2usize;
        // The overlay anchors against the live prompt prefix (TS
        // `getRenderMetrics`'s `promptPrefixWidth`, the `!`/`!!` prompts
        // included).
        let prompt_width = str_width(self.editor.bash_prompt_prefix().unwrap_or("> "));
        let content_width = width.saturating_sub(padding_x * 2).max(1);
        let input_width = content_width.saturating_sub(prompt_width).max(1);
        let mut rows: Vec<Line> = Vec::new();
        let mut overlay = Vec::new();
        overlay.push(Vec::new());
        overlay.extend(state.render(theme, input_width));
        overlay.push(Vec::new());
        for mut line in overlay {
            // The shared menu rows pad to the full input width with
            // unstyled spans, so the remaining-width fill below never
            // lands: the popup background must ride on every span the
            // row left unstyled (the selected row's selection band
            // carries its own background and is kept).
            for span in &mut line {
                if span.style.bg.is_none() {
                    span.style = span.style.patch(bg);
                }
            }
            let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
            let mut row: Line = vec![Span::styled(" ".repeat(padding_x + prompt_width), bg)];
            row.extend(line);
            row.push(Span::styled(
                " ".repeat(input_width.saturating_sub(used)),
                bg,
            ));
            row.push(Span::styled(" ".repeat(padding_x), bg));
            rows.push(pad_row(row, width));
        }
        rows
    }

    /// The editor surface (TS `Editor.render` with a background): a blank
    /// bg row, content rows with the `> ` prompt and a reverse-video cursor,
    /// and a trailing bg row. Scroll indicators replace the blank rows.
    fn render_editor_surface(&mut self, width: usize) -> (Vec<Line>, Option<(usize, usize)>) {
        let bg = crate::chrome::editor_background(&self.theme);
        let border = self.theme.fg_style(ThemeColor::BorderMuted);
        let padding_x = 2usize;
        let content_width = width.saturating_sub(padding_x * 2).max(1);
        // TS `getPromptPrefix` + `getRenderMetrics`: a bang first line
        // swaps the `> ` for the `! `/`!! ` prompt (styled through the
        // editor border color, `formatPromptPrefix`), which also narrows
        // the input width.
        let bash_prompt = self.editor.bash_prompt_prefix();
        let prompt = bash_prompt.unwrap_or("> ");
        let prompt_width = str_width(prompt);
        let input_width = content_width.saturating_sub(prompt_width).max(1);
        let layout_width = input_width;
        let (visible, scroll_offset, _hidden_above, hidden_below) =
            self.editor.visible_window(layout_width, self.terminal_rows);
        let mut rows: Vec<Line> = Vec::new();
        if scroll_offset > 0 {
            let indicator = format!(" \u{2191} {scroll_offset} more");
            rows.push(indicator_row(&indicator, bg, border, width));
        } else {
            rows.push(vec![Span::styled(" ".repeat(width), bg)]);
        }
        if let Some(selected) = &self.queue_selected {
            // TS `getQueueSelectionHeader` (the editor's header line while a
            // parked message is selected): `CustomEditor.render` inserts the
            // dim header row plus an empty companion row BELOW the top row,
            // so the editor box grows by two rows while a message is selected
            // (TS `getContentLineOffset` shifts the click regions with it).
            let keys = {
                let kb = self.editor.keybindings();
                let display =
                    |id: &str| crate::keybindings::format_key_text(&kb.get_keys(id).join("/"));
                crate::queued::QueueBrowseKeys {
                    navigate_older: display("app.message.navigateOlder"),
                    navigate_newer: display("app.message.navigateNewer"),
                    move_earlier: display("app.message.moveEarlier"),
                    move_later: display("app.message.moveLater"),
                    follow_up: display("app.message.followUp"),
                }
            };
            // Dim text on the editor background (the header line renders
            // inside the editor box like the `> ` rows): the dim
            // foreground patched over the editor background style.
            let dim = bg.patch(self.theme.fg_style(ThemeColor::Dim));
            let header = crate::queued::browse_header_text(selected, &keys);
            let mut row: Line = vec![Span::styled(" ".repeat(padding_x), bg)];
            let line: Line = vec![Span::styled(header, dim)];
            row.extend(crate::width::truncate_line(&line, content_width, "..."));
            let used = crate::width::line_width(&row);
            row.push(Span::styled(" ".repeat(width.saturating_sub(used)), bg));
            rows.push(row);
            rows.push(vec![Span::styled(" ".repeat(width), bg)]);
        }
        // TS `CustomEditor.render`: a bare `--` separator highlights only
        // while the first line opens with an argument-taking slash command.
        let selection = self.editor.selection_range();
        let editor_lines = self.editor.get_lines();
        let registry = SlashCommandRegistry::builtin_cached();
        let include_bare_separator = editor_lines
            .first()
            .and_then(|first| command_token(first))
            .is_some_and(|token| registry.takes_argument(&token.name));
        let arg_token_spans: Vec<Vec<ArgTokenSpan>> = editor_lines
            .iter()
            .map(|line| find_arg_tokens(line, 0, include_bare_separator))
            .collect();
        let mut cursor: Option<(usize, usize)> = None;
        for (index, line) in visible.iter().enumerate() {
            let mut row: Line = vec![Span::styled(" ".to_string(), bg)];
            // The `> ` prompt prefix renders plain on the surface
            // background; the `!` bash prompts render through the editor
            // border color (TS `formatPromptPrefix`).
            if index == 0 {
                let style = if bash_prompt.is_some() { border } else { bg };
                row.push(Span::styled(prompt.to_string(), style));
            } else {
                row.push(Span::styled(" ".repeat(prompt_width), bg));
            }
            row.push(Span::styled(" ".to_string(), bg));
            let text: &str = &line.text;
            let cursor_pos = line
                .has_cursor
                .then(|| line.cursor_pos.min(text.chars().count()));
            // The prompt-highlight spans of this chunk: argument tokens, and
            // the command token of the first layout line in accent unless
            // the cursor sits inside it (TS `styleDisplayText`).
            let command = (scroll_offset + index == 0)
                .then(|| command_token(text))
                .flatten();
            let command_takes_argument = command
                .as_ref()
                .is_some_and(|token| registry.takes_argument(&token.name));
            let highlights = editor_chunk_highlights(
                text,
                arg_token_spans
                    .get(line.source_line)
                    .map_or(&[][..], |spans| spans),
                line.source_start,
                command.as_ref(),
                command_takes_argument,
                cursor_pos,
            );
            row.extend(editor_text_spans(
                &self.theme,
                text,
                &highlights,
                chunk_selection(selection, line.source_line, line.source_start, text),
                cursor_pos,
                bg,
            ));
            let mut used = str_width(text);
            if cursor_pos == Some(text.chars().count()) {
                // The end-of-line cursor appends one reversed cell.
                used += 1;
            }
            if let Some(position) = cursor_pos {
                let head = split_at_chars(text, position).0;
                cursor = Some((index + 1, str_width(head) + prompt_width + 2));
            }
            row.push(Span::styled(
                " ".repeat(input_width.saturating_sub(used)),
                bg,
            ));
            row.push(Span::styled(" ".repeat(padding_x), bg));
            rows.push(row);
        }
        if hidden_below > 0 {
            rows.push(indicator_row(
                &format!(" \u{2193} {hidden_below} more"),
                bg,
                border,
                width,
            ));
        } else {
            rows.push(vec![Span::styled(" ".repeat(width), bg)]);
        }
        (rows, cursor)
    }

    /// Compose the fullscreen frame: top bar, transcript window (padded),
    /// dock at the bottom — exactly `height` rows.
    pub fn render_frame(&mut self, width: usize, height: usize) -> Vec<Line> {
        // The fullscreen compose forces image components to their textual
        // fallback (TS `withFullscreenImageFallback` around the fullscreen
        // render): the frame repaints on every tick, and re-emitting an
        // image placement each paint would corrupt the display. Graphics
        // placements belong to the inline paint path only.
        crate::image_component::with_fullscreen_image_fallback(|| {
            self.render_frame_inner(width, height)
        })
    }

    fn render_frame_inner(&mut self, width: usize, height: usize) -> Vec<Line> {
        // The onboarding splash covers the pane (TS `showOverlay` 100%):
        // no top bar, transcript, or prompt dock behind it.
        if let Some(screen) = self.onboarding.as_mut() {
            let frame = screen.render(&self.theme, width, height);
            self.frame_rows = frame.len();
            return frame;
        }
        // The `/model` and `/effort` pickers mount in the editor dock (TS
        // `showConfigurationMenu` replaces the editor container), like the
        // tree and fork selectors: the prompt context (the detail hint)
        // stays above the pane and the transcript stays mounted above it.
        let prompt_context = render_prompt_context(&self.detail_label(), &self.theme, width);
        let picker_dock: Option<Vec<Line>> = if let Some(picker) = self.model_picker.as_mut() {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(picker) = &self.effort_picker {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(mcp_view) = self.mcp_view.as_mut() {
            let mut dock = prompt_context;
            dock.extend(mcp_view.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(picker) = &self.heartbeats_picker {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else if let Some(panel) = &self.goal_panel {
            let mut dock = prompt_context;
            dock.extend(crate::goal_surface::render_goal_panel(
                panel,
                &self.theme,
                width,
                self.editor.keybindings(),
            ));
            Some(dock)
        } else if let Some(view) = self.bash_view.as_ref() {
            let mut dock = prompt_context;
            dock.extend(view.render(&self.theme, width, self.editor.keybindings()));
            Some(dock)
        } else {
            None
        };
        // The tree and fork selectors mount in the editor container (TS
        // `showSelector`): an auto-height pane over the dock's rows with the
        // transcript above it.
        let selector_dock: Option<Vec<Line>> = if self.tree_selector.is_some()
            || self.fork_selector.is_some()
            || self.share_loader.is_some()
            || self.confirm.is_some()
            || self.provider_auth.is_some()
            || self.auth_panel.is_some()
            || self.reload_box.is_some()
            || self.settings_menu.is_some()
        {
            // TS's editor container holds the prompt context (the detail
            // hint) and the editor; `showSelector` replaces only the editor
            // part, so the hint stays above the pane.
            let mut dock = render_prompt_context(&self.detail_label(), &self.theme, width);
            if let Some(selector) = self.tree_selector.as_ref() {
                dock.extend(selector.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(selector) = self.fork_selector.as_ref() {
                dock.extend(selector.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(loader) = self.share_loader.as_ref() {
                dock.extend(self.render_share_loader(loader, width));
            } else if let Some(confirm) = self.confirm.as_ref() {
                dock.extend(confirm.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(selector) = self.provider_auth.as_mut() {
                dock.extend(selector.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(panel) = self.auth_panel.as_mut() {
                dock.extend(panel.render(&self.theme, width, self.editor.keybindings()));
            } else if let Some(message) = self.reload_box.as_ref() {
                dock.extend(self.render_reload_box(message, width));
            } else if let Some(menu) = self.settings_menu.as_ref() {
                dock.extend(menu.render(&self.theme, width, self.editor.keybindings()));
            }
            Some(dock)
        } else {
            picker_dock
        };
        let top = self
            .fullscreen
            .then(|| render_top_bar(&self.chrome, &self.theme, width));
        let top_rows = usize::from(top.is_some());
        let dock = match selector_dock {
            // The replacement surfaces swap only the editor part of the
            // dock; the `/speed` footer stays the dock's last row under
            // them (TS `footerSlot` renders while `showSelector`/the
            // pickers own the frame).
            Some(mut dock) => {
                if let Some(speed) = &self.chrome.speed_text {
                    dock.push(crate::chrome::render_speed_footer(
                        speed,
                        &self.theme,
                        width,
                    ));
                }
                dock
            }
            None => self.render_dock(width),
        };
        let dock_height = dock
            .len()
            .min(height.saturating_sub(FULLSCREEN_MIN_TRANSCRIPT_ROWS));
        let cropped = dock.len().saturating_sub(dock_height);
        // The hardware cursor rides the dock's rows: a front crop removes
        // the first `cropped` rows, so the editor's cursor sits that many
        // rows closer to the displayed dock's start — subtract, or the
        // reported cursor lands below the editor at every cropped height.
        self.dock_cursor = self
            .dock_cursor
            .map(|(row, col)| (row.saturating_sub(cropped), col));
        let dock: Vec<Line> = if dock.len() > dock_height {
            dock[dock.len() - dock_height..].to_vec()
        } else {
            dock
        };
        let window_height = height
            .saturating_sub(top_rows + dock.len())
            .max(FULLSCREEN_MIN_TRANSCRIPT_ROWS.min(height.saturating_sub(top_rows + dock.len())));
        let (window_rows, start) = self.visible_transcript_window(width, window_height);
        self.window_rows = window_height;
        // The selection restyle diff: only the rows the selection change
        // touched re-style; the rest reuse the cached styled rows.
        let window_rows = self.selection_styled_window(window_rows, start);
        let mut frame: Vec<Line> = Vec::with_capacity(height);
        if let Some(top) = top {
            frame.push(pad_row(top, width));
        }
        for line in window_rows {
            frame.push(pad_row(line, width));
        }
        while frame.len() < height.saturating_sub(dock.len()) {
            frame.push(vec![Span::raw(" ".repeat(width))]);
        }
        for line in dock {
            frame.push(pad_row(line, width));
        }
        // A paused viewport carries the follow hint over the last transcript
        // window row (TS composites it above the dock, below overlays).
        if !self.following {
            if let Some(row) = frame.get_mut(window_height) {
                let key = self
                    .editor
                    .keybindings()
                    .first_key("tui.viewport.follow")
                    .unwrap_or_else(|| "ctrl+shift+down".to_string());
                let label = format!(" {key} to follow ");
                *row = composite_follow_hint(row, &label, width);
            }
        }
        self.frame_rows = frame.len();
        self.apply_frame_selection(&mut frame, width);
        // The action toasts overlay the transcript window's top rows
        // (newest at the bottom of the stack), above the selection restyle
        // so the transient text stays legible. The overlay never runs
        // past the window's last row (a short transcript keeps the dock
        // untouched) and sits out an in-progress selection drag: the
        // transient overlay must never hide rows a drag is selecting —
        // releasing over covered text could copy content that was not
        // visible.
        let now = std::time::Instant::now();
        let toasts: Vec<String> = if self.selection.is_dragging() {
            Vec::new()
        } else {
            self.toasts.active(now)
        };
        if !toasts.is_empty() {
            // The action ack renders as the Success-colored pill: REVERSED
            // flips the Success color onto the pill's background (the
            // follow-hint overlay's badge grammar), so the toast reads as a
            // compact highlighted chip, not a bare line.
            let style = self
                .theme
                .fg_style(crate::theme::ThemeColor::Success)
                .add_modifier(Modifier::REVERSED);
            crate::toast::overlay_toasts(
                &mut frame,
                top_rows,
                top_rows + window_height,
                &toasts,
                width,
                style,
            );
        }
        frame
    }

    /// The `/share` loader rows (TS `BorderedLoader` + `CancellableLoader`):
    /// border, spinner + message, cancel hint, border — replacing the
    /// editor in the dock while `gh gist create` runs.
    fn render_share_loader(&self, loader: &ShareLoader, width: usize) -> Vec<Line> {
        let border = self.theme.fg_style(ThemeColor::Border);
        let muted = self.theme.fg_style(ThemeColor::Muted);
        let dim = self.theme.fg_style(ThemeColor::Dim);
        let spinner =
            crate::chat::LOADER_FRAMES[self.pulse_frame % crate::chat::LOADER_FRAMES.len()];
        let mut rows: Vec<Line> = Vec::with_capacity(7);
        rows.push(vec![Span::styled("─".repeat(width.max(1)), border)]);
        let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
        // TS `BorderedLoader` wraps a `Loader` with the muted spinner and
        // muted message color fns; the gap between them is the unstyled
        // plain space (the `Loader` pen reset — see `chat::render_loader`).
        row.push(Span::styled(spinner.to_string(), muted));
        row.push(Span::raw(" ".to_string()));
        row.push(Span::styled(loader.message.clone(), muted));
        rows.push(row);
        rows.push(vec![Span::raw(String::new())]);
        // TS `keyHint("tui.select.cancel", "cancel")`: every key of the
        // binding, first letter capitalized, then the description.
        let key_text = self.editor.keybindings().key_text("tui.select.cancel");
        let mut hint: Line = vec![Span::styled(" ".to_string(), Style::default())];
        hint.push(Span::styled(key_text, dim));
        hint.push(Span::styled(" cancel".to_string(), muted));
        rows.push(hint);
        rows.push(vec![Span::raw(String::new())]);
        rows.push(vec![Span::styled("─".repeat(width.max(1)), border)]);
        rows
    }

    /// The `/reload` box (TS `handleReloadCommand`): `DynamicBorder`, blank,
    /// the muted message, blank, `DynamicBorder` — the editor container's
    /// replacement while the reload runs.
    fn render_reload_box(&self, message: &str, width: usize) -> Vec<Line> {
        let border = self.theme.fg_style(ThemeColor::Border);
        let muted = self.theme.fg_style(ThemeColor::Muted);
        let rule = "─".repeat(width.max(1));
        let rows: Vec<Line> = vec![
            vec![Span::styled(rule.clone(), border)],
            vec![Span::raw(String::new())],
            vec![
                Span::raw(" ".to_string()),
                Span::styled(message.to_string(), muted),
            ],
            vec![Span::raw(String::new())],
            vec![Span::styled(rule, border)],
        ];
        rows
    }

    /// Hardware cursor position within the last composed frame (0-based row,
    /// 0-based column), when the editor surface drew the cursor.
    pub fn frame_cursor(&self) -> Option<(usize, usize)> {
        if self.onboarding.is_some()
            || self.model_picker.is_some()
            || self.effort_picker.is_some()
            || self.heartbeats_picker.is_some()
            || self.goal_panel.is_some()
            || self.bash_view.is_some()
            || self.tree_selector.is_some()
            || self.fork_selector.is_some()
            || self.share_loader.is_some()
            || self.confirm.is_some()
            || self.provider_auth.is_some()
            || self.auth_panel.is_some()
            || self.reload_box.is_some()
            || self.settings_menu.is_some()
        {
            return None;
        }
        self.dock_cursor
            .map(|(row, col)| (row + 1 + self.window_rows, col))
    }

    /// The inline layout the exit flush paints onto the main screen (TS
    /// `exitFullscreen`'s synchronous inline repaint): the full transcript
    /// plus the dock, without the fullscreen window, top-bar pin, or height
    /// padding. Unlike an alt-screen frame, these rows persist in the
    /// terminal's native scrollback, which is what keeps the exit frame
    /// (and the resume hint printed below it) visible after the app exits.
    pub fn render_inline_frame(&mut self, width: usize) -> Vec<Line> {
        let mut rows = self.render_transcript(width);
        rows.extend(self.render_dock(width));
        rows
    }

    /// Rows of the inline layout that changed since the last main-screen
    /// flush, as a write plan for the flush primitive (TS
    /// `exitFullscreen`'s inline repaint):
    ///
    /// - [`FlushPlan::Append`] when the flushed frame is a prefix of the
    ///   new one (or nothing was flushed yet): the new tail appends below
    ///   the cursor and flows into native scrollback — this is the exit
    ///   path that keeps the exit frame and resume hint visible.
    /// - [`FlushPlan::Repaint`] when rows above the flushed tail changed
    ///   (a transcript that grew past a suspend-time flush, a snapshot
    ///   rebuild): the visible screen is erased and the last screenful
    ///   repainted, mirroring the TS full redraw. Scrollback above the
    ///   screen is never rewritten — terminal scrollback is immutable,
    ///   the same trade-off the TS renderer makes.
    pub fn take_flush_plan(&mut self, width: usize, screen_height: usize) -> FlushPlan {
        let rows = self.render_inline_frame(width);
        let texts: Vec<String> = rows.iter().map(row_text_of).collect();
        let first_changed = (0..self.flushed_frame.len().max(texts.len())).find(|&index| {
            let old = self.flushed_frame.get(index).map(String::as_str);
            let new = texts.get(index).map(String::as_str);
            old != new
        });
        let plan = match first_changed {
            // Identical frame: nothing to write.
            None => FlushPlan::Append(Vec::new()),
            // The flushed frame is a prefix: append the new tail.
            Some(index) if index >= self.flushed_frame.len() => {
                FlushPlan::Append(rows[index.min(rows.len())..].to_vec())
            }
            // Rows above the flushed tail changed: repaint the visible
            // window (the frame tail), leaving scrollback untouched.
            Some(_) => {
                let start = rows.len().saturating_sub(screen_height);
                FlushPlan::Repaint(rows[start..].to_vec())
            }
        };
        self.flushed_frame = texts;
        plan
    }
}

/// The main-screen write plan produced by [`AgentView::take_flush_plan`].
#[derive(Debug, PartialEq, Eq)]
pub enum FlushPlan {
    /// Write the rows below the cursor (joined with newlines), scrolling
    /// excess rows into native scrollback.
    Append(Vec<Line>),
    /// Erase the visible screen (scrollback above it stays) and paint the
    /// rows from the top — the TS full-redraw path for changes above the
    /// flushed tail.
    Repaint(Vec<Line>),
}

/// Concatenated span contents of a row (includes zero-width OSC zone
/// markers, which must persist into scrollback).
fn row_text_of(line: &Line) -> String {
    line.iter().map(|span| span.content.as_str()).collect()
}

/// Split a string at a char boundary.
fn split_at_chars(text: &str, at: usize) -> (&str, &str) {
    let mut end = text.len();
    let mut count = 0;
    for (index, _) in text.char_indices() {
        if count == at {
            end = index;
            break;
        }
        count += 1;
    }
    if count < at {
        return (text, "");
    }
    (&text[..end], &text[end..])
}

/// One scroll-indicator surface row (`↑ N more` on the editor background).
fn indicator_row(indicator: &str, bg: Style, border: Style, width: usize) -> Line {
    let mut row: Line = vec![Span::styled(indicator.to_string(), border)];
    let used = str_width(indicator);
    row.push(Span::styled(" ".repeat(width.saturating_sub(used)), bg));
    row
}

/// Pad a rendered row to the full width (default background).
fn pad_row(line: Line, width: usize) -> Line {
    let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
    let mut out = line;
    if used < width {
        out.push(Span::raw(" ".repeat(width - used)));
    }
    out
}

/// Scroll state of the transcript window (TS `ScrollInfo`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollInfo {
    pub following: bool,
    pub lines_above: usize,
    pub lines_below: usize,
}

/// Composite the follow hint over one frame row (TS `renderFullscreen`:
/// `ctrl+shift+down to follow` reversed, centered, over the last transcript
/// window row). Leading OSC-133 zone markers stay at the row head so the
/// marker plan keeps flagging the row.
fn composite_follow_hint(row: &Line, label: &str, width: usize) -> Line {
    let label_width = str_width(label);
    let (markers, rest) = crate::osc133::split_leading_markers(row);
    let col = width.saturating_sub(label_width) / 2;
    let mut out: Line = markers;
    out.extend(crate::width::slice_line_by_column_strict(
        &rest, 0, col, true,
    ));
    out.push(Span::styled(
        label.to_string(),
        Style::default().add_modifier(Modifier::REVERSED),
    ));
    out.extend(crate::width::slice_line_by_column_strict(
        &rest,
        col.saturating_add(label_width),
        width,
        true,
    ));
    out
}

/// Map a replay transcript item onto a chat component.
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
            timestamp,
        } => ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id,
            name,
            args: serde_json::from_str(&arguments).unwrap_or(serde_json::Value::Null),
            started: false,
            started_ms: (timestamp > 0).then_some(timestamp),
            ..Default::default()
        })),
        // A replayed tool result reaches the view through
        // [`AgentView::push`], which folds it onto its pending tool card;
        // this arm keeps a standalone card for any unmatched result.
        TranscriptItem::ToolResult {
            tool_call_id,
            tool_name,
            text,
            content,
            details,
            is_error,
            timestamp,
        } => ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id: tool_call_id,
            name: tool_name,
            args: serde_json::Value::Null,
            started: true,
            ended_ms: (timestamp > 0).then_some(timestamp),
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
            // TS `addMessageToChat`'s `bashExecution` case: the same
            // component the live events render, completed over the
            // recorded output.
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
mod tests {
    use super::*;
    use crate::chat::{AssistantMessage, MessageBlock};
    use crate::osc133::RowMarkers;
    use crate::theme::{ColorMode, Theme};
    use crate::tool_card::{ToolCallCard, ToolResultView};

    fn view() -> AgentView {
        AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
    }

    fn text_of(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect::<String>()
    }

    /// A rendered hint row carries the platform's alt label: the queue
    /// browse header quotes `app.message.navigateOlder` and friends through
    /// the shared `format_key_text`, so the row shows `Alt+\u{2191}` on
    /// Linux/Windows hosts and `Option+\u{2191}` on macOS (TS
    /// `formatKeyPart`'s darwin branch).
    /// TS #2447: a fresh chat starts at the middle conversation-detail
    /// level (`details`: edit diffs expanded, thinking visible, tool
    /// output collapsed) instead of the most-collapsed overview; the
    /// Ctrl+O cycle from there is unchanged (details -> all -> overview).
    #[test]
    fn a_chat_starts_at_the_middle_detail_level() {
        let mut v = view();
        assert_eq!(v.detail, Detail::Details, "the startup level is details");
        assert!(v.detail.show_thinking());
        assert!(v.detail.edit_diffs_expanded());
        assert!(!v.detail.tool_output_expanded());
        assert_eq!(v.detail.next(), Detail::All);
        v.detail = v.detail.next();
        assert_eq!(v.detail.next(), Detail::Overview);
        v.detail = v.detail.next();
        assert_eq!(v.detail.next(), Detail::Details);
    }

    /// The `!`/`!!` prompt (TS `getBashPromptInfo` + `formatPromptPrefix`):
    /// the typed prefix hides behind the styled `! `/`!! ` prompt, later
    /// lines keep the prompt column, and the prompt carries the editor
    /// border color.
    #[test]
    fn bang_prompt_renders_in_place_of_the_typed_prefix() {
        let mut v = view();
        v.editor.set_text("!echo hi");
        let frame = v.render_dock(80);
        let joined = frame.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(
            joined.contains("!  echo hi"),
            "the prompt swallows the typed prefix:\n{joined}"
        );
        assert!(
            !joined.contains("> echo hi"),
            "the default prompt does not render for a bang line:\n{joined}"
        );
        let border = v.theme.fg_style(ThemeColor::BorderMuted);
        let prompt_row = frame
            .iter()
            .find(|line| text_of(line).contains("!  echo hi"))
            .expect("the prompt row");
        assert!(
            prompt_row.iter().any(|span| span.style == border),
            "the bang prompt renders through the editor border color"
        );

        let mut v = view();
        v.editor.set_text("!!echo quiet");
        let frame = v.render_dock(80);
        let joined = frame.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(
            joined.contains("!!  echo quiet"),
            "the !! prompt hides its typed prefix:\n{joined}"
        );
    }

    #[test]
    fn autocomplete_dropdown_rows_carry_the_popup_background() {
        // The dropdown floats on the ToolPanelBg overlay above the editor:
        // every span of a menu row (the shared menu_panel rows pad to the
        // full input width with unstyled spans) must carry a background,
        // so an unselected row does not blend into the transcript behind.
        let mut v = view();
        v.editor.handle_input("/");
        v.editor.handle_input("m");
        v.editor.materialize_autocomplete();
        assert!(v.editor.is_showing_autocomplete(), "the dropdown opens");
        let frame = v.render_dock(80);
        let marker_row = frame
            .iter()
            .find(|line| text_of(line).contains("\u{203a}"))
            .expect("the dropdown renders its marker row");
        assert!(
            marker_row.iter().all(|span| span.style.bg.is_some()),
            "dropdown row spans the popup background: {marker_row:?}"
        );
    }

    #[test]
    fn hint_rows_carry_the_platform_alt_label() {
        let mut v = view();
        v.queue_selected = Some(crate::queued::QueueSelectionItem {
            lane: crate::queued::QueueLane::Steering,
            index: 0,
            text: "turn right".to_string(),
        });
        let frame = v.render_frame(80, 24);
        let joined = frame.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(
            joined.contains("browse"),
            "the queue browse header renders: {joined}"
        );
        if std::env::consts::OS == "macos" {
            assert!(
                joined.contains("Option+\u{2191}"),
                "macOS hint row: {joined}"
            );
        } else {
            assert!(joined.contains("Alt+\u{2191}"), "hint row: {joined}");
        }
    }

    #[test]
    fn frame_is_exactly_height_rows() {
        let mut v = view();
        v.chrome.version = "0.0.0".to_string();
        v.chrome.cwd = "/tmp/project".to_string();
        v.chrome.chat_name = "project".to_string();
        let frame = v.render_frame(80, 24);
        assert_eq!(frame.len(), 24);
        assert!(frame.iter().all(|l| str_width(&text_of(l)) <= 80));
        let joined = frame.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("prime agent v0.0.0"));
        assert!(joined.contains("Details mode (Ctrl+O to expand)"));
        assert!(joined.contains('>'));
    }

    #[test]
    fn osc_emissions_reemit_only_changed_rows() {
        let mut v = view();
        v.chrome.version = "0.0.0".to_string();
        v.chrome.cwd = "/w".to_string();
        v.chrome.chat_name = "w".to_string();
        v.push(TranscriptItem::UserMessage {
            text: "hello".to_string(),
        });
        let frame = v.render_frame(80, 24);
        let first = v.take_osc_emissions(&frame);
        let marked: Vec<usize> = first.iter().map(|(row, _)| *row).collect();
        assert!(!marked.is_empty());
        // Re-emitting an unchanged frame rewrites no rows.
        let again = v.take_osc_emissions(&frame);
        assert!(again.is_empty());
    }

    /// Fill the transcript past one window so there is scrollable history.
    fn filled(mut v: AgentView, turns: usize) -> AgentView {
        v.chrome.version = "0.0.0".to_string();
        v.chrome.cwd = "/w".to_string();
        v.chrome.chat_name = "w".to_string();
        v.onboarding = None;
        for index in 0..turns {
            v.push(TranscriptItem::UserMessage {
                text: format!("user line {index}"),
            });
            v.push(TranscriptItem::Assistant {
                blocks: vec![crate::chat::MessageBlock::Text(format!(
                    "assistant reply {index}"
                ))],
                has_tool_calls: false,
            });
        }
        v
    }

    fn row_text(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect::<String>()
    }

    #[test]
    fn scroll_pages_from_tail_and_resumes_at_bottom() {
        let mut v = filled(view(), 30);
        let frame = v.render_frame(80, 24);
        // Fresh render follows the tail.
        assert!(v.is_following());
        let info = v.scroll_info();
        assert_eq!(info.lines_below, 0);
        assert!(frame.iter().any(|l| row_text(l).contains("reply 29")));

        // PageUp pauses following and moves the window up a page: `page`
        // rows remain below the window (`ScrollInfo` reports the tail
        // distance in `lines_below`, the transcript-top offset in
        // `lines_above`).
        let page = v.page_size();
        v.scroll_by(-(page as isize));
        assert!(!v.is_following());
        assert_eq!(v.scroll_info().lines_below, page);

        // Scrolling back down reaches the tail and resumes following.
        v.scroll_by(page as isize);
        assert!(v.is_following());
        assert_eq!(v.scroll_info().lines_below, 0);
    }

    #[test]
    fn scroll_offset_is_visible_in_frames() {
        let mut v = filled(view(), 30);
        let following = v.render_frame(80, 24);
        v.scroll_to_top();
        let top = v.render_frame(80, 24);
        // The top frame shows the earliest history the following frame
        // scrolled past: distinct window content for the same transcript.
        assert!(top.iter().any(|l| row_text(l).contains("reply 0")));
        assert!(!following.iter().any(|l| row_text(l).contains("reply 0")));
        assert!(following.iter().any(|l| row_text(l).contains("reply 29")));
        assert!(!top.iter().any(|l| row_text(l).contains("reply 29")));
    }

    #[test]
    fn compaction_loader_replaces_the_working_loader() {
        // TS `startCompactionLoader`: the compaction loader owns the status
        // area while a compaction runs, working loader hidden.
        let mut v = view();
        v.working = Some(WorkingState {
            activity: "Waiting",
            message: None,
            download: false,
            tokens: 0,
            elapsed_secs: 0,
        });
        v.compaction = Some(crate::chat::CompactionState {
            reason: crate::chat::CompactionReason::Manual,
            custom_instructions: None,
            summary: String::new(),
        });
        let frame = v.render_frame(80, 24);
        let flat: Vec<String> = frame.iter().map(row_text).collect();
        assert!(
            flat.iter()
                .any(|l| l.contains("Compacting context... (Ctrl+C to cancel)")),
            "{flat:?}"
        );
        assert!(
            !flat.iter().any(|l| l.contains("Waiting")),
            "the working loader is hidden during compaction: {flat:?}"
        );
        // `compaction_end` clears it; the summary row renders from the
        // transcript entry.
        v.compaction = None;
        v.push_entry(crate::chat::ChatEntry::CompactionSummary {
            summary: "the story so far".to_string(),
            tokens_before: 1234,
            custom_instructions: None,
        });
        let frame = v.render_frame(80, 24);
        let flat: Vec<String> = frame.iter().map(row_text).collect();
        assert!(
            flat.iter()
                .any(|l| l.trim() == "\u{25c6} Context compacted"),
            "{flat:?}"
        );
        assert!(
            flat.iter().any(|l| l.trim() == "the story so far"),
            "{flat:?}"
        );
    }

    /// The live streamed-summary block (the operator's "stream the
    /// compacted summary" feature): while a compaction runs, the expanded
    /// view (`all` detail) renders the accumulated delta text under the
    /// loader row on the branch grammar; collapsed details keep the
    /// loader alone; the settling end clears the streamed block when the
    /// durable summary row lands.
    #[test]
    fn compaction_streams_the_summary_under_the_loader_in_expanded_detail() {
        let mut v = view();
        v.detail = crate::chat::Detail::All;
        v.compaction = Some(crate::chat::CompactionState {
            reason: crate::chat::CompactionReason::Threshold,
            custom_instructions: None,
            summary: "The session covered the fleet work.".to_string(),
        });
        let frame = v.render_frame(80, 24);
        let flat: Vec<String> = frame.iter().map(row_text).collect();
        let loader = flat
            .iter()
            .position(|l| l.contains("Auto-compacting..."))
            .expect("the loader row renders");
        // The streamed block hangs off the loader row on the branch
        // gutter, the content visible under the spinner.
        let gutter = &flat[loader + 1];
        assert!(
            gutter
                .trim_start()
                .starts_with(crate::branch::BRANCH_GUTTER),
            "the live block nests under the loader: {flat:?}"
        );
        assert!(
            gutter.contains("The session covered the fleet work."),
            "{flat:?}"
        );
        // Collapsed detail (`overview`): the loader stands alone — no
        // streamed block (TS keeps the loader plain outside `all`).
        v.detail = crate::chat::Detail::Overview;
        let frame = v.render_frame(80, 24);
        let flat: Vec<String> = frame.iter().map(row_text).collect();
        assert!(
            flat.iter().any(|l| l.contains("Auto-compacting...")),
            "{flat:?}"
        );
        assert!(
            !flat
                .iter()
                .any(|l| l.contains("The session covered the fleet work.")),
            "no streamed block outside the expanded detail: {flat:?}"
        );
        // `compaction_end` resolves the streamed block into the durable
        // summary row (the loader and the live block clear together).
        v.detail = crate::chat::Detail::All;
        v.compaction = None;
        v.push_entry(crate::chat::ChatEntry::CompactionSummary {
            summary: "The session covered the fleet work.".to_string(),
            tokens_before: 1234,
            custom_instructions: None,
        });
        let frame = v.render_frame(80, 24);
        let flat: Vec<String> = frame.iter().map(row_text).collect();
        assert!(
            !flat.iter().any(|l| l.contains("Auto-compacting...")),
            "the loader cleared: {flat:?}"
        );
        assert!(
            flat.iter()
                .any(|l| l.trim() == "\u{25c6} Context compacted"),
            "the durable summary row replaced the streamed block: {flat:?}"
        );
    }

    #[test]
    fn follow_hint_shows_when_paused_and_hides_when_following() {
        let mut v = filled(view(), 30);
        let following_frame = v.render_frame(80, 24);
        assert!(!following_frame
            .iter()
            .any(|l| row_text(l).contains("to follow")));
        v.scroll_by(-(v.page_size() as isize));
        let paused_frame = v.render_frame(80, 24);
        assert!(paused_frame
            .iter()
            .any(|l| row_text(l).contains("ctrl+shift+down to follow")));
        // The follow key resumes: the hint disappears.
        v.scroll_to_bottom();
        let resumed_frame = v.render_frame(80, 24);
        assert!(v.is_following());
        assert!(!resumed_frame
            .iter()
            .any(|l| row_text(l).contains("to follow")));
        // scrollToTop pins the top; the hint shows again (TS shows it for
        // every non-following window, even at the very top).
        v.scroll_to_top();
        let top_frame = v.render_frame(80, 24);
        assert!(!v.is_following());
        assert!(top_frame.iter().any(|l| row_text(l).contains("to follow")));
    }

    #[test]
    fn follow_hint_keeps_zone_markers_on_the_composited_row() {
        // A marked row composited with the hint keeps its zone flags at
        // the head (the marker plan keeps flagging the row) and keeps the
        // visible text around the centered label.
        let mut row = vec![crate::Span::raw("x".repeat(80))];
        crate::osc133::mark_end(&mut row);
        let mut out = composite_follow_hint(&row, " ctrl+shift+down to follow ", 80);
        let markers = crate::osc133::row_markers(&out);
        assert!(markers.end && !markers.start);
        assert!(row_text(&out).contains("to follow"));
        assert_eq!(str_width(&row_text(&out)), 80);
        // Stripping the markers leaves the hint visible.
        crate::osc133::strip(&mut out);
        assert!(row_text(&out).contains("to follow"));
        // An unmarked row stays unmarked.
        let plain = vec![crate::Span::raw(" ".repeat(80))];
        let out = composite_follow_hint(&plain, " ctrl+shift+down to follow ", 80);
        assert_eq!(crate::osc133::row_markers(&out), RowMarkers::default());
    }

    #[test]
    fn flush_plan_appends_then_repaints_the_changed_tail() {
        let mut v = view();
        v.chrome.version = "0.0.0".to_string();
        v.chrome.cwd = "/w".to_string();
        v.chrome.chat_name = "w".to_string();
        v.push(TranscriptItem::UserMessage {
            text: "first turn".to_string(),
        });
        // The first flush appends the whole inline frame (splash,
        // transcript, dock) and keeps the zero-width zone markers embedded
        // in the rows — they must survive into scrollback for
        // shell-integration jumps.
        let first = v.take_flush_plan(80, 24);
        let FlushPlan::Append(rows) = &first else {
            panic!("first flush must append");
        };
        let joined = rows.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("prime agent v0.0.0"));
        assert!(joined.contains("first turn"));
        assert!(rows.iter().any(|l| crate::osc133::row_markers(l).start));

        // An unchanged frame flushes nothing.
        assert_eq!(v.take_flush_plan(80, 24), FlushPlan::Append(Vec::new()));

        // New transcript rows land ABOVE the flushed dock, so the flush
        // repaints the visible window: the changed region is rewritten, not
        // appended below the stale dock (which would duplicate it).
        v.push(TranscriptItem::UserMessage {
            text: "second turn".to_string(),
        });
        let FlushPlan::Repaint(rows) = v.take_flush_plan(80, 24) else {
            panic!("growth past the flushed dock must repaint");
        };
        let joined = rows.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("second turn"));
        assert!(joined.contains("first turn"));
        // The repaint covers at most one screenful: a long transcript
        // repaints only the tail.
        let mut long = filled(view(), 30);
        let FlushPlan::Append(_) = long.take_flush_plan(80, 10) else {
            panic!("first flush of a long transcript must append");
        };
        long.push(TranscriptItem::UserMessage {
            text: "late turn".to_string(),
        });
        let FlushPlan::Repaint(rows) = long.take_flush_plan(80, 10) else {
            panic!("growth past the flushed dock must repaint");
        };
        assert!(rows.len() <= 10);
        let joined = rows.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("late turn"));
        assert!(!joined.contains("reply 0"));

        // A shrinking rebuild never rewinds into a rewrite of scrollback:
        // the changed region repaints the visible window only.
        v.clear_chat();
        let FlushPlan::Repaint(rows) = v.take_flush_plan(80, 24) else {
            panic!("a rebuild past the flushed frame must repaint");
        };
        let joined = rows.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(!joined.contains("second turn"));
    }

    #[test]
    fn inline_frame_is_transcript_plus_dock_without_padding() {
        let mut v = filled(view(), 30);
        // The inline layout is the unpinned frame: every transcript row is
        // present (no window slicing) and no height padding rows follow.
        let frame = v.render_frame(80, 24);
        let inline = v.render_inline_frame(80);
        assert!(inline.iter().any(|l| text_of(l).contains("reply 0")));
        assert!(inline.iter().any(|l| text_of(l).contains("reply 29")));
        assert!(frame.len() == 24 && inline.len() != frame.len());
        // The dock rows ride at the end (prompt context, editor, tray).
        let joined = inline.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("Details mode"));
    }

    #[test]
    fn dock_pads_window_between_splash_and_editor() {
        let mut v = view();
        v.chrome.version = "0.0.0".to_string();
        v.chrome.cwd = "/w".to_string();
        v.chrome.chat_name = "w".to_string();
        let frame = v.render_frame(60, 40);
        assert_eq!(frame.len(), 40);
        // The editor prompt sits above the (empty) tray row.
        let joined = frame.iter().map(text_of).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("Details mode"));
    }

    fn view_with(entries: Vec<ChatEntry>) -> AgentView {
        let mut view = AgentView::new(crate::theme::Theme::builtin(
            "prime",
            crate::theme::ColorMode::Color256,
        ));
        for entry in entries {
            view.push_entry(entry);
        }
        view
    }

    fn settled_tool_card(id: &str) -> ChatEntry {
        ChatEntry::Tool(Box::new(ToolCallCard {
            id: id.to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": "echo done"}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: Some(std::time::Instant::now()),
            result: Some(ToolResultView {
                content: vec![serde_json::json!({"type": "text", "text": "done"})],
                details: serde_json::Value::Null,
                is_error: false,
            }),
            result_partial: false,
            aborted: false,
            ..Default::default()
        }))
    }

    fn transcript_text(view: &mut AgentView, width: usize) -> String {
        let rows = view.render_transcript(width);
        rows.iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect::<Vec<String>>()
            .join("\n")
    }

    /// A settled transcript renders identically from the layout cache and
    /// from a fresh layout: caching must never change the frame.
    #[test]
    fn cached_transcript_rows_match_fresh_render() {
        let mut view = view_with(vec![
            ChatEntry::User {
                text: "hello".to_string(),
            },
            ChatEntry::Assistant(Box::new(AssistantMessage {
                blocks: vec![MessageBlock::Text("world".to_string())],
                has_tool_calls: false,
                streaming: false,
                error: None,
                aborted: false,
            })),
            settled_tool_card("call_1"),
        ]);
        let fresh = transcript_text(&mut view, 80);
        let cached = transcript_text(&mut view, 80);
        assert_eq!(fresh, cached);
    }

    /// A mutation marked stale re-renders: the cached rows must never hide
    /// new content (streamed blocks, tool-card state, attached errors).
    #[test]
    fn stale_entry_re_renders_new_content() {
        let mut view = view_with(vec![ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![MessageBlock::Text("part one".to_string())],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        }))]);
        let before = transcript_text(&mut view, 80);
        if let Some(ChatEntry::Assistant(open)) = view.chat.get_mut(0) {
            open.blocks = vec![MessageBlock::Text("part one part two".to_string())];
        }
        view.mark_entry_stale(0);
        let after = transcript_text(&mut view, 80);
        assert!(before.contains("part one"));
        assert!(!before.contains("part two"));
        assert!(after.contains("part one part two"));
    }

    /// A running tool card animates: its rows must not be cached (the
    /// spinner frame advances), while a settled card's rows ignore the
    /// pulse frame.
    #[test]
    fn running_card_is_not_cached_and_settled_card_is() {
        let running = ChatEntry::Tool(Box::new(ToolCallCard {
            id: "call_r".to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": "sleep 1"}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: None,
            result: None,
            result_partial: false,
            aborted: false,
            ..Default::default()
        }));
        let mut view = view_with(vec![running, settled_tool_card("call_d")]);
        view.pulse_frame = 0;
        let frame0 = transcript_text(&mut view, 80);
        view.pulse_frame = 1;
        let frame1 = transcript_text(&mut view, 80);
        assert_ne!(frame0, frame1, "the running spinner must animate");

        // With only a settled card, the pulse frame cannot change rows.
        let mut settled_view = view_with(vec![settled_tool_card("call_d")]);
        settled_view.pulse_frame = 0;
        let s0 = transcript_text(&mut settled_view, 80);
        settled_view.pulse_frame = 7;
        let s7 = transcript_text(&mut settled_view, 80);
        assert_eq!(s0, s7);
    }

    /// A conversation-detail change re-flows every cached row (thinking
    /// blocks and tool output expand).
    #[test]
    fn detail_change_invalidates_cached_rows() {
        let mut view = view_with(vec![ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![
                MessageBlock::Thinking("thinking body".to_string()),
                MessageBlock::Text("answer".to_string()),
            ],
            has_tool_calls: false,
            streaming: false,
            error: None,
            aborted: false,
        }))]);
        // The hidden-thinking scenario starts at the collapsed overview
        // level (the startup level is the middle details since TS #2447).
        view.detail = Detail::Overview;
        let overview = transcript_text(&mut view, 80);
        view.detail = view.detail.next();
        let details = transcript_text(&mut view, 80);
        assert!(!overview.contains("thinking body"));
        assert!(details.contains("thinking body"));
    }

    /// The compaction summary is a collapsible block (TS
    /// `CompactionSummaryMessageComponent`, an `ExpandableEventMessage`):
    /// collapsed until the Ctrl+O detail cycle reaches `all`, expanded
    /// there, collapsed again when the cycle wraps to `overview`.
    #[test]
    fn compaction_summary_block_toggles_with_the_detail_cycle() {
        let summary = "## Summary\nthe session story, first line\nand a second line that wraps";
        let mut view = view_with(vec![ChatEntry::CompactionSummary {
            summary: summary.to_string(),
            tokens_before: 12345,
            custom_instructions: Some("the goal".to_string()),
        }]);
        // Collapsed at the startup `details` (TS #2447): the header plus
        // the whitespace-collapsed EventSummary, never the token metadata.
        let collapsed = transcript_text(&mut view, 80);
        assert!(collapsed.contains("\u{25c6} Context compacted"));
        assert!(collapsed.contains("## Summary the session story, first line"));
        assert!(!collapsed.contains("Compacted from"));
        // The row is cacheable; the first render stored it. A detail
        // change must re-flow it (the cache drops wholesale), or the
        // block would stay collapsed forever.
        view.detail = view.detail.next();
        let expanded = transcript_text(&mut view, 80);
        assert!(
            expanded.contains("Compacted from 12,345 tokens \u{b7} focus: the goal"),
            "the expanded metadata row renders: {expanded}"
        );
        // The expanded body is markdown, not the EventSummary collapse:
        // the heading renders as its own row.
        assert!(
            expanded.contains("Summary"),
            "the expanded markdown body renders: {expanded}"
        );
        // The cycle wraps through `overview` (the other collapsed level):
        // the block collapses again.
        view.detail = view.detail.next();
        let collapsed_again = transcript_text(&mut view, 80);
        assert!(
            !collapsed_again.contains("Compacted from"),
            "the cycle back to `overview` collapses the block: {collapsed_again}"
        );
        view.detail = Detail::Details;
        let at_details = transcript_text(&mut view, 80);
        assert!(
            !at_details.contains("Compacted from"),
            "the middle `details` level keeps the block collapsed too: {at_details}"
        );
    }

    fn user_row() -> ChatEntry {
        ChatEntry::User {
            text: "hello".to_string(),
        }
    }

    /// A tool-carrying assistant whose only body is a thinking block: the
    /// body hides in collapsed mode (TS `hideThinkingBlock`), so the
    /// message's whole height rides the spacing decisions.
    fn thinking_tool_assistant() -> ChatEntry {
        ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![MessageBlock::Thinking("thinking body".to_string())],
            has_tool_calls: true,
            streaming: false,
            error: None,
            aborted: false,
        }))
    }

    fn agent_message_row() -> ChatEntry {
        ChatEntry::AgentMessage(Box::new(crate::custom_message::AgentMessageRow {
            direction: crate::custom_message::AgentMessageDirection::Received,
            counterpart: "lane".to_string(),
            message: "hi".to_string(),
        }))
    }

    fn shell_completion_row() -> ChatEntry {
        ChatEntry::ShellCompletion(Box::new(crate::custom_message::ShellCompletionRow {
            pid: Some(1),
            exit_code: Some(0),
            content: "[bash-done]".to_string(),
        }))
    }

    /// TS `createConversationSpacing.shouldAddLeadingSpace` for one
    /// spacing-driven row: scan back over hidden assistant rows, honor the
    /// trailing space of a visible assistant, and sit flush against compact
    /// TS `UserMessageComponent` is a Box(2,1): its vertical padding row
    /// under the content is the first of two blanks before a tool card
    /// (the card's `shouldAddLeadingSpace` spacer is the second). The f20
    /// spawn frame shows exactly this seam.
    #[test]
    fn tool_card_after_user_message_keeps_ts_two_blank_seam() {
        let mut view = view_with(vec![
            ChatEntry::User {
                text: "run the cell".to_string(),
            },
            settled_tool_card("t1"),
        ]);
        let rows = view.render_transcript(120);
        let flat: Vec<String> = rows
            .iter()
            .map(|l| l.iter().map(|s| s.content.as_str()).collect())
            .collect();
        let user = flat
            .iter()
            .position(|r| r.contains("run the cell"))
            .expect("user row");
        // The box padding row carries the OSC 133 zone-end markers behind
        // its background spaces; both seam rows are visually empty (zero
        // printable width once the blank padding is trimmed away).
        let empty = |row: &str| crate::width::str_width(row.trim()) == 0;
        assert!(empty(&flat[user + 1]), "box bottom padding row");
        assert!(empty(&flat[user + 2]), "tool leading spacer row");
        assert!(
            flat[user + 3].trim().starts_with("bash"),
            "card after the two blanks: {:?}",
            &flat[user + 3..]
        );
    }

    /// neighbors (tool cards, agent messages, shell completions).
    #[test]
    fn conversation_leading_matches_ts_spacing_rules() {
        let visible_assistant = || {
            ChatEntry::Assistant(Box::new(AssistantMessage {
                blocks: vec![MessageBlock::Text("done".to_string())],
                has_tool_calls: true,
                streaming: false,
                error: None,
                aborted: false,
            }))
        };
        let tool_only_assistant = || {
            ChatEntry::Assistant(Box::new(AssistantMessage {
                blocks: Vec::new(),
                has_tool_calls: true,
                streaming: false,
                error: None,
                aborted: false,
            }))
        };
        let user = || ChatEntry::User {
            text: "hello".to_string(),
        };

        // Nothing preceding: the collapsed form leads with a blank, the
        // expanded form sits flush against the top of the chat.
        let view = view_with(vec![agent_message_row()]);
        assert!(view.conversation_leading(0, false));
        assert!(!view.conversation_leading(0, true));

        // A user row is never a compact neighbor: both forms lead.
        let view = view_with(vec![user(), agent_message_row()]);
        assert!(view.conversation_leading(1, false));
        assert!(view.conversation_leading(1, true));

        // A visible assistant with tool calls carries the trailing space:
        // the next agent message sits flush in both forms.
        let view = view_with(vec![visible_assistant(), agent_message_row()]);
        assert!(!view.conversation_leading(1, false));
        assert!(!view.conversation_leading(1, true));

        // A compact neighbor (tool card, shell completion, agent message):
        // flush collapsed, blank expanded.
        for neighbor in [
            settled_tool_card("c1"),
            shell_completion_row(),
            agent_message_row(),
        ] {
            let view = view_with(vec![neighbor, agent_message_row()]);
            assert!(!view.conversation_leading(1, false), "flush collapsed");
            assert!(view.conversation_leading(1, true), "blank expanded");
        }

        // A tool-only assistant (no visible body) is a separator: the row
        // after it keeps the trailing-space spacing in both forms.
        let view = view_with(vec![tool_only_assistant(), agent_message_row()]);
        assert!(!view.conversation_leading(1, false));
        assert!(!view.conversation_leading(1, true));

        // The backward scan returns at the first non-skippable row it
        // meets: a user row NEWER than the tool-only assistant ends the
        // scan, so the agent message leads (the separator is never
        // reached).
        let view = view_with(vec![tool_only_assistant(), user(), agent_message_row()]);
        assert!(view.conversation_leading(2, false));
        assert!(view.conversation_leading(2, true));
        // With the separator NEWER than the non-compact row, the
        // separator dominates (TS returns the tool separator with a
        // trailing space), so the agent message renders flush.
        let view = view_with(vec![user(), tool_only_assistant(), agent_message_row()]);
        assert!(!view.conversation_leading(2, false));
        assert!(!view.conversation_leading(2, true));
        // A compact row older than the separator ends the scan WITHOUT the
        // separator (TS falls through the `toolSeparator` branch to the
        // compact row): flush collapsed, blank expanded.
        let view = view_with(vec![
            settled_tool_card("c2"),
            tool_only_assistant(),
            agent_message_row(),
        ]);
        assert!(!view.conversation_leading(2, false));
        assert!(view.conversation_leading(2, true));

        // A hidden thinking-only assistant contributes nothing to spacing:
        // the scan skips it to the user row.
        let hidden_assistant = || {
            ChatEntry::Assistant(Box::new(AssistantMessage {
                blocks: vec![MessageBlock::Thinking("quiet".to_string())],
                has_tool_calls: false,
                streaming: false,
                error: None,
                aborted: false,
            }))
        };
        let mut view = view_with(vec![user(), hidden_assistant(), agent_message_row()]);
        view.detail = Detail::Overview;
        assert!(view.conversation_leading(2, false));
    }

    /// TS `AgentMessageComponent` is a compact neighbor
    /// (`isCompactAgentMessageNeighbor`): the hidden thinking of a
    /// tool-carrying assistant after an agent message renders ZERO rows
    /// — no leading spacer, no trailing tool separator — so the tool
    /// card sits flush under the agent-message row (the collapsed
    /// thinking never leaves a visual gap).
    #[test]
    fn hidden_thinking_after_an_agent_message_renders_zero_height() {
        let mut view = view_with(vec![
            user_row(),
            agent_message_row(),
            thinking_tool_assistant(),
            settled_tool_card("c1"),
        ]);
        view.detail = Detail::Overview;
        let text = transcript_text(&mut view, 80);
        assert!(!text.contains("thinking body"), "collapsed hides thinking");
        let lines: Vec<&str> = text.lines().collect();
        let agent_row = lines
            .iter()
            .position(|line| line.contains("Agent message \u{b7} \u{2193} lane"))
            .expect("the agent-message row renders");
        // The card's panel header is its FIRST row; the seam check must
        // look above it, never inside the panel's own padding.
        let header_row = lines
            .iter()
            .position(|line| line.contains("bash \u{b7} done"))
            .expect("the tool card header renders");
        // Flush: the row directly above the card header is the agent
        // message block's own last row (its body), never the hidden
        // thinking's trailing spacer (the pre-fix gap).
        assert!(
            agent_row < header_row,
            "the card renders after the agent message:\n{text}"
        );
        assert!(
            lines[header_row - 1].contains("Agent message \u{b7} \u{2193} lane"),
            "the agent message header sits directly above the card header:\n{text}"
        );
    }

    /// A bash execution card is a compact neighbor like the tool cards
    /// themselves: the hidden thinking between a `!` bash card and the
    /// next tool call renders zero height (TS
    /// `isCompactAgentMessageNeighbor` includes
    /// `BashExecutionComponent`).
    #[test]
    fn hidden_thinking_after_a_bash_card_renders_zero_height() {
        let mut view = view_with(vec![
            user_row(),
            ChatEntry::BashExecution(Box::new(crate::bash_card::BashExecutionCard {
                id: "b1".to_string(),
                command: "echo hi".to_string(),
                excluded: false,
                output_lines: vec!["hi".to_string()],
                running: false,
                exit_code: Some(0),
                cancelled: false,
                error_message: None,
                truncated: false,
                full_output_path: None,
                suppress_leading_space: false,
            })),
            thinking_tool_assistant(),
            settled_tool_card("c1"),
        ]);
        view.detail = Detail::Overview;
        let text = transcript_text(&mut view, 80);
        assert!(!text.contains("thinking body"), "collapsed hides thinking");
        let lines: Vec<&str> = text.lines().collect();
        let bash_row = lines
            .iter()
            .position(|line| line.contains("echo hi"))
            .expect("the bash card renders");
        // The tool panel's header is its first row; the seam sits above it.
        let header_row = lines
            .iter()
            .position(|line| line.contains("bash \u{b7} done"))
            .expect("the tool card header renders");
        // Flush: the row directly above the tool card header is the bash
        // card's own closing border, never a hidden-thinking spacer.
        assert!(
            bash_row < header_row,
            "the card renders after the bash card:\n{text}"
        );
        assert!(
            lines[header_row - 1].contains("\u{2500}"),
            "the bash card's border sits directly above the card header:\n{text}"
        );
    }

    /// A visible assistant body after a compact neighbor keeps its own
    /// spacers (the collapsed fix only flattens the invisible body).
    #[test]
    fn a_visible_assistant_after_an_agent_message_keeps_its_spacers() {
        let mut view = view_with(vec![
            user_row(),
            agent_message_row(),
            ChatEntry::Assistant(Box::new(AssistantMessage {
                blocks: vec![MessageBlock::Text("answer body".to_string())],
                has_tool_calls: true,
                streaming: false,
                error: None,
                aborted: false,
            })),
            settled_tool_card("c1"),
        ]);
        view.detail = Detail::Overview;
        let text = transcript_text(&mut view, 80);
        let lines: Vec<&str> = text.lines().collect();
        let agent_row = lines
            .iter()
            .position(|line| line.contains("Agent message \u{b7} \u{2193} lane"))
            .expect("the agent-message row renders");
        // In overview the agent message renders its header alone; the
        // visible assistant body then leads with its blank, renders, and
        // keeps the tool separator before the card (TS `hasTrailingSpace`
        // with a visible body).
        assert!(lines[agent_row + 1].trim().is_empty(), "{text}");
        assert!(lines[agent_row + 2].contains("answer body"), "{text}");
        assert!(lines[agent_row + 3].trim().is_empty(), "{text}");
        assert!(lines[agent_row + 4].contains("bash \u{b7} done"), "{text}");
    }

    /// The custom rows render through the transcript path: the agent
    /// message header plus its guttered body, and the shell-completion row.
    #[test]
    fn custom_rows_render_in_the_transcript() {
        let mut view = view_with(vec![agent_message_row(), shell_completion_row()]);
        view.detail = Detail::All;
        let text = transcript_text(&mut view, 80);
        assert!(text.contains("Agent message \u{b7} \u{2193} lane"));
        assert!(text.contains("\u{2570}\u{2500} hi"));
        assert!(text.contains("Background shell command finished"));
        assert!(text.contains("[bash-done]"));
    }

    /// A streaming assistant message updates across frames: its rows stay
    /// out of the cache until the stream settles.
    #[test]
    fn streaming_assistant_updates_across_frames() {
        let mut view = view_with(vec![ChatEntry::Assistant(Box::new(AssistantMessage {
            blocks: vec![MessageBlock::Text("so far".to_string())],
            has_tool_calls: false,
            streaming: true,
            error: None,
            aborted: false,
        }))]);
        let frame0 = transcript_text(&mut view, 80);
        assert!(frame0.contains("so far"));
        if let Some(ChatEntry::Assistant(open)) = view.chat.get_mut(0) {
            open.blocks = vec![MessageBlock::Text("so far, and more".to_string())];
        }
        view.mark_entry_stale(0);
        let frame1 = transcript_text(&mut view, 80);
        assert!(frame1.contains("and more"));
    }

    /// The action toast renders as a compact right-aligned pill over the
    /// top transcript rows — the covered row keeps its own content, the
    /// toast never spans the row — and auto-dismisses once its TTL passes.
    /// Consecutive identical actions coalesce into one refreshed toast
    /// (the count bump), never stacked duplicate rows.
    #[test]
    fn action_toasts_render_as_a_pill_coalesce_and_auto_dismiss() {
        // A transcript taller than the window puts real content on the
        // window's top row (the tail-aligned window), so the pill lands
        // over a covered row that has content to keep.
        let mut view = view_with(vec![ChatEntry::ClientText {
            rows: (0..40)
                .map(|index| {
                    vec![crate::info_commands::ClientSpan {
                        text: format!("covered line {index}"),
                        color: None,
                    }]
                })
                .collect(),
        }]);
        view.toasts.push("Copied to clipboard");
        let frame = view.render_frame(60, 24);
        let rows: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        let toast_row = rows
            .iter()
            .position(|row| row.contains("Copied to clipboard"))
            .expect("the toast renders");
        // Right-aligned: the top bar stays above the overlay (fullscreen:
        // row 0).
        assert!(toast_row >= 1, "the toast sits below the top bar");
        // The pill is compact: the covered transcript row keeps its own
        // content beside the toast (the toast never spans the row).
        assert!(
            rows[toast_row].contains("covered line"),
            "the covered row keeps its content: {:?}",
            rows[toast_row]
        );
        // The pill reads as a toast chip: the Success color flipped onto
        // the pill's background (REVERSED), not a bare dim line.
        let frame = view.render_frame(60, 24);
        let pill = frame
            .iter()
            .flatten()
            .find(|span| span.content.contains("Copied to clipboard"))
            .expect("the pill renders");
        assert!(
            pill.style.add_modifier.contains(Modifier::REVERSED),
            "the pill carries the reversed-chip style: {:?}",
            pill.style
        );
        // Consecutive identical actions coalesce: the stack holds one
        // toast with the count bump, not stacked duplicate rows.
        view.toasts.push("Copied to clipboard");
        view.toasts.push("Copied to clipboard");
        let frame = view.render_frame(60, 24);
        let joined: String = frame
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let toast_rows = joined
            .lines()
            .filter(|row| row.contains("Copied to clipboard"))
            .count();
        assert_eq!(
            toast_rows, 1,
            "one coalesced toast row, not stacked: {joined}"
        );
        assert!(
            joined.contains("Copied to clipboard (x3)"),
            "the count bump acknowledges every copy: {joined}"
        );
        // The overlay expires with its TTL.
        view.toasts
            .age_by(crate::toast::TOAST_TTL + std::time::Duration::from_millis(1));
        let frame = view.render_frame(60, 24);
        let joined: String = frame
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !joined.contains("Copied to clipboard"),
            "the expired toast is gone: {joined}"
        );
    }

    /// The browse header inserts BELOW the editor's top row with an empty
    /// companion row (TS `CustomEditor.render`'s two header rows), so the
    /// content rows shift down two rows while a parked message is selected.
    #[test]
    fn browse_header_pair_sits_below_the_editor_top_row() {
        let mut v = view();
        v.queue_selected = Some(crate::queued::QueueSelectionItem {
            lane: crate::queued::QueueLane::Steering,
            index: 0,
            text: "turn right".to_string(),
        });
        let frame = v.render_frame(80, 24);
        let joined: Vec<String> = frame.iter().map(text_of).collect();
        // The header truncates at the content width; `browse` sits inside
        // the visible prefix (the strip hint row is absent - the queue is
        // empty here, only the selection is set).
        let header_row = joined
            .iter()
            .position(|row| row.contains("browse"))
            .expect("the queue browse header renders");
        assert!(
            joined[header_row - 1].trim().is_empty(),
            "the editor top row stays above the header: {:?}",
            joined[header_row - 1]
        );
        assert!(
            joined[header_row + 1].trim().is_empty(),
            "the empty companion row follows the header: {:?}",
            joined[header_row + 1]
        );
        assert!(
            joined[header_row + 2].contains("> "),
            "the content rows shift below the header pair: {:?}",
            joined[header_row + 2]
        );
    }
    // ------------------------------------------------------------------
    // Condensed tool runs (the collapsed-view condensing, tool_runs.rs)
    // ------------------------------------------------------------------

    fn condensed_view(entries: Vec<ChatEntry>) -> AgentView {
        let mut view = view_with(entries);
        view.detail = Detail::Overview;
        view
    }

    fn thinking_only() -> ChatEntry {
        ChatEntry::Assistant(Box::new(crate::chat::AssistantMessage {
            blocks: vec![crate::chat::MessageBlock::Thinking("hmm".to_string())],
            has_tool_calls: true,
            streaming: false,
            error: None,
            aborted: false,
        }))
    }

    fn run_cards(count: usize) -> Vec<ChatEntry> {
        (0..count)
            .map(|index| settled_tool_card(&format!("run_c{index}")))
            .collect()
    }

    #[test]
    fn three_items_condense_into_the_block_two_do_not() {
        let mut three = condensed_view(run_cards(3));
        let text = transcript_text(&mut three, 80);
        assert!(
            text.contains("3 tool calls"),
            "the block's summary row renders: {text}"
        );
        assert!(
            text.contains("\u{2570}\u{2500} 3 bash"),
            "the breakdown row hangs on the branch gutter: {text}"
        );
        assert!(
            !text.contains("to expand"),
            "no drill-in hint rides the breakdown row: {text}"
        );
        assert!(
            !text.contains("bash \u{b7} done"),
            "the cards' own panel rows are gone in overview: {text}"
        );

        let mut two = condensed_view(run_cards(2));
        let text = transcript_text(&mut two, 80);
        assert!(
            text.contains("bash \u{b7} done"),
            "two cards render their own rows: {text}"
        );
        assert!(
            !text.contains("tool calls"),
            "nothing condenses at or below two items: {text}"
        );
    }

    #[test]
    fn condensing_is_overview_only_and_ctrl_o_reveals_every_item() {
        // The Ctrl+O cycle owns the whole story: overview condenses the
        // run into one block and hides the thinking; details/all render
        // every card, every notice, and the thinking itself.
        let mut entries = run_cards(3);
        entries.push(thinking_only());
        entries.push(agent_message_row());
        let mut view = condensed_view(entries);
        let text = transcript_text(&mut view, 80);
        assert!(
            text.contains("3 tool calls \u{b7} 1 agent message"),
            "overview condenses the mixed run: {text}"
        );
        assert!(
            text.contains("1 agent messages received"),
            "the notice merges into the block's breakdown: {text}"
        );
        assert!(
            !text.contains("Agent message \u{b7} \u{2193}"),
            "the notice's own row is gone in overview: {text}"
        );
        assert!(
            !text.contains("hmm"),
            "collapsed hides the thinking: {text}"
        );
        for detail in [Detail::Details, Detail::All] {
            view.detail = detail;
            let text = transcript_text(&mut view, 80);
            assert!(
                !text.contains("tool calls"),
                "no block at {detail:?}: {text}"
            );
            assert!(
                text.contains("bash \u{b7}"),
                "the cards render their own rows at {detail:?}: {text}"
            );
            assert!(
                text.contains("Agent message \u{b7} \u{2193} lane"),
                "the notice keeps its own row at {detail:?}: {text}"
            );
            assert!(
                text.contains("hmm"),
                "the thinking is visible at {detail:?}: {text}"
            );
        }
        view.detail = Detail::Overview;
        let text = transcript_text(&mut view, 80);
        assert!(text.contains("3 tool calls"), "overview condenses: {text}");
    }

    #[test]
    fn a_received_notice_merges_into_the_block_and_short_groups_stay_solo() {
        // The operator's screenshot fix: tool calls, hidden thinking,
        // and received notices in one stretch condense into ONE block -
        // the notice neither breaks the run nor renders its own row;
        // a genuine short group (one card, one notice) keeps both rows.
        let mut entries = run_cards(3);
        entries.push(thinking_only());
        entries.push(agent_message_row());
        entries.extend(run_cards(2));
        let mut view = condensed_view(entries);
        let text = transcript_text(&mut view, 80);
        assert!(
            text.contains("5 tool calls \u{b7} 1 agent message"),
            "one aggregate spans the whole interleaved stretch: {text}"
        );
        assert!(
            text.contains("1 agent messages received"),
            "the notice's count rides the breakdown: {text}"
        );
        assert!(
            !text.contains("Agent message \u{b7} \u{2193}"),
            "the notice renders nothing of its own inside the run: {text}"
        );
        assert!(
            text.matches("tool calls").count() == 1,
            "exactly one block, no tiny groups: {text}"
        );

        let short = vec![run_cards(1).pop().unwrap(), agent_message_row()];
        let mut view = condensed_view(short);
        let text = transcript_text(&mut view, 80);
        assert!(
            text.contains("Agent message \u{b7} \u{2193} lane"),
            "a two-item group keeps the notice's own row: {text}"
        );
        // The collapsed row carries no body preview (the operator's
        // 2026-09-25 directive): the content only opens on expand.
        assert!(
            !text.contains("hi"),
            "the collapsed row never previews the body: {text}"
        );
        assert!(
            text.contains("bash \u{b7} done"),
            "a two-item group keeps the card's own rows: {text}"
        );
    }

    #[test]
    fn the_live_block_updates_between_frames() {
        let mut view = condensed_view(Vec::new());
        view.push_entry(crate::chat::ChatEntry::User {
            text: "go".to_string(),
        });
        let running = ChatEntry::Tool(Box::new(ToolCallCard {
            id: "run_r".to_string(),
            name: "bash".to_string(),
            args: serde_json::json!({"command": "sleep 1"}),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ended_at: None,
            result: None,
            result_partial: false,
            ..Default::default()
        }));
        // Four settled cards plus one running: the block is live and its
        // glyph animates with the pulse frame.
        let mut entries = run_cards(4);
        entries.push(running);
        for entry in entries {
            view.push_entry(entry);
        }
        view.pulse_frame = 0;
        let frame0 = transcript_text(&mut view, 80);
        assert!(frame0.contains("5 tool calls"), "the live block: {frame0}");
        assert!(
            frame0.contains(crate::chat::working_icon_frame(0)),
            "the working icon rides the summary row: {frame0}"
        );
        view.pulse_frame = 2;
        let frame1 = transcript_text(&mut view, 80);
        assert!(
            frame1.contains(crate::chat::working_icon_frame(2)),
            "the icon advanced with the pulse: {frame1}"
        );
        // The last card settles: the glyph flips to the settled check.
        let index = view.chat.len() - 1;
        view.prepare_entry_mutation(index);
        if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
            card.result = Some(ToolResultView {
                content: vec![serde_json::json!({ "type": "text", "text": "done" })],
                details: serde_json::Value::Null,
                is_error: false,
            });
            card.result_partial = false;
            card.ended_at = Some(std::time::Instant::now());
        }
        view.mark_entry_stale(index);
        let settled = transcript_text(&mut view, 80);
        assert!(
            settled.contains("\u{2713} 5 tool calls"),
            "the settled glyph: {settled}"
        );
    }

    #[test]
    fn the_block_appears_at_the_third_streamed_card_before_results() {
        // Staged streaming: the run row first appears when the THIRD
        // named/id card streams in - before any `tool_execution_end` -
        // and the count increments immediately on the fourth. The
        // threshold crossing and the O(1) tail patch both keep the
        // block's rows current while the run is still running.
        let streamed = |id: &str| {
            ChatEntry::Tool(Box::new(ToolCallCard {
                id: id.to_string(),
                name: "bash".to_string(),
                args: serde_json::json!({"command": "echo done"}),
                started: true,
                started_at: Some(std::time::Instant::now()),
                ..Default::default()
            }))
        };
        let mut view = condensed_view(Vec::new());
        view.push_entry(crate::chat::ChatEntry::User {
            text: "go".to_string(),
        });
        view.push_entry(streamed("c0"));
        view.push_entry(streamed("c1"));
        let two = transcript_text(&mut view, 80);
        assert!(
            !two.contains("tool calls"),
            "two streamed cards wait for the third: {two}"
        );
        view.push_entry(streamed("c2"));
        let three = transcript_text(&mut view, 80);
        assert!(
            three.contains("3 tool calls"),
            "the block appears at the third streamed card, results pending: {three}"
        );
        view.push_entry(streamed("c3"));
        let four = transcript_text(&mut view, 80);
        assert!(
            four.contains("4 tool calls"),
            "the count increments immediately on the fourth: {four}"
        );
    }

    #[test]
    fn a_landing_result_with_receipts_qualifies_the_short_run() {
        // `tool_execution_end` replays a result whose sentAgentMessages
        // carry two receipts: the one-card-plus-receipts run crosses
        // the >=3 threshold the moment the result lands (prepare
        // captured the pre-mutation receipt count, mark re-derives the
        // map), and the block replaces the card's rows in overview.
        let mut view = condensed_view(Vec::new());
        view.push_entry(crate::chat::ChatEntry::User {
            text: "go".to_string(),
        });
        let mut cell = settled_tool_card("cell0");
        if let ChatEntry::Tool(card) = &mut cell {
            card.name = "ipython".to_string();
            card.args = serde_json::json!({"code": "print(1)"});
        }
        view.push_entry(cell);
        let before = transcript_text(&mut view, 80);
        assert!(
            !before.contains("agent message"),
            "one streamed cell without receipts stays solo: {before}"
        );
        let index = view.chat.len() - 1;
        view.prepare_entry_mutation(index);
        if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
            card.result = Some(ToolResultView {
                content: vec![serde_json::json!({"type": "text", "text": "done"})],
                details: serde_json::json!({
                    "sentAgentMessages": [
                        { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" },
                        { "id": "m2", "message": "b", "deliveryStatus": "delivered", "receiverRole": "parent" }
                    ]
                }),
                is_error: false,
            });
        }
        view.mark_entry_stale(index);
        let after = transcript_text(&mut view, 80);
        assert!(
            after.contains("1 tool call \u{b7} 2 agent messages"),
            "the landed receipts qualify the run: {after}"
        );
        assert!(
            after.contains("2 agent messages sent"),
            "the breakdown carries the receipt class: {after}"
        );
    }

    #[test]
    fn a_landing_receipt_qualifies_the_run_while_the_window_is_top_anchored() {
        // The top-anchored window (the user scrolled up) folds nothing on
        // a mutation, but the run-shape capture is independent of the
        // sparse fold: a result landing agent-message receipts re-derives
        // the run map immediately, and the block forms without waiting
        // for the next tail push.
        let mut view = condensed_view(Vec::new());
        for index in 0..40 {
            view.push_entry(crate::chat::ChatEntry::Status {
                text: format!("row {index}"),
                kind: crate::chat::StatusKind::Info,
            });
        }
        let mut cell = settled_tool_card("cell0");
        if let ChatEntry::Tool(card) = &mut cell {
            card.name = "ipython".to_string();
            card.args = serde_json::json!({"code": "print(1)"});
        }
        view.push_entry(cell);
        view.push_entry(settled_tool_card("card1"));
        let _ = view.render_frame(80, 12);
        view.scroll_to_top();
        assert!(
            !view.sparse_window_is_tail_anchored(),
            "the window holds the top, not the tail"
        );
        let frame = view.render_frame(80, 12);
        let rendered: Vec<String> = frame
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert!(
            rendered.iter().any(|row| row.contains("prime agent v")),
            "the top-anchored frame holds the transcript's splash: {rendered:?}"
        );
        let index = view.chat.len() - 2;
        view.prepare_entry_mutation(index);
        if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
            card.result = Some(ToolResultView {
                content: vec![serde_json::json!({"type": "text", "text": "done"})],
                details: serde_json::json!({
                    "sentAgentMessages": [
                        { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" },
                        { "id": "m2", "message": "b", "deliveryStatus": "delivered", "receiverRole": "parent" }
                    ]
                }),
                is_error: false,
            });
        }
        view.mark_entry_stale(index);
        assert!(
            view.run_map.run_at(index).is_some(),
            "the block formed while the window was scrolled away"
        );
        assert!(
            view.runs_shape.is_none(),
            "the shape capture is consumed by the stale pass"
        );
        let after = transcript_text(&mut view, 80);
        assert!(
            after.contains("2 tool calls \u{b7} 2 agent messages"),
            "the block renders with both kinds counted: {after}"
        );
    }

    #[test]
    fn condensed_geometry_matches_the_render() {
        for calls in [3usize, 8] {
            let mut view = condensed_view(run_cards(calls));
            for width in [0, 1, 10, 40, 80] {
                for detail in [Detail::Overview, Detail::Details, Detail::All] {
                    view.detail = detail;
                    for index in 0..view.chat.len() {
                        let entry = &view.chat[index];
                        assert_eq!(
                            view.count_entry_rows(index, width),
                            view.render_entry(index, entry, width, false, false).len(),
                            "calls {calls} index {index} width {width} detail {detail:?}"
                        );
                    }
                }
            }
        }
        // A mixed run (a notice and a receipt-carrying cell) keeps the
        // same count/render parity on every index.
        let mut cell = settled_tool_card("mix0");
        if let ChatEntry::Tool(card) = &mut cell {
            card.name = "ipython".to_string();
            card.args = serde_json::json!({"code": "print(1)"});
            card.result = Some(ToolResultView {
                content: vec![serde_json::json!({"type": "text", "text": "done"})],
                details: serde_json::json!({
                    "sentAgentMessages": [
                        { "id": "m1", "message": "a", "deliveryStatus": "delivered", "receiverRole": "parent" }
                    ]
                }),
                is_error: false,
            });
        }
        let mut view = condensed_view(vec![agent_message_row(), thinking_only(), cell]);
        for width in [0, 1, 10, 40, 80] {
            for detail in [Detail::Overview, Detail::Details, Detail::All] {
                view.detail = detail;
                for index in 0..view.chat.len() {
                    let entry = &view.chat[index];
                    assert_eq!(
                        view.count_entry_rows(index, width),
                        view.render_entry(index, entry, width, false, false).len(),
                        "mixed index {index} width {width} detail {detail:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_block_survives_a_cache_roundtrip() {
        // The settled block is cacheable: a second render serves the
        // cached rows and they match a fresh render byte for byte.
        let mut view = condensed_view(run_cards(3));
        let first = transcript_text(&mut view, 80);
        let second = transcript_text(&mut view, 80);
        assert_eq!(first, second, "the cached block rows are stable");
        let mut fresh = condensed_view(run_cards(3));
        let fresh_text = transcript_text(&mut fresh, 80);
        assert_eq!(
            first.replace("0s", "").replace("0.0s", ""),
            fresh_text.replace("0s", "").replace("0.0s", ""),
            "a fresh view renders the same block (the wall clock may move)"
        );
    }
}
#[cfg(test)]
mod chunk_selection_tests {
    use super::chunk_selection;

    /// A fully-covered line highlights to the chunk's own end (the
    /// chunk-local length), not `chunk length - source start` — wrapped
    /// continuations keep their highlight (Bugbot round-1 fix).
    #[test]
    fn wrapped_chunks_on_fully_covered_lines_highlight_to_their_end() {
        let sel = Some(((0, 10), (2, 5)));
        // A wrapped continuation chunk of line 1 (source cols 20..30).
        let range = chunk_selection(sel, 1, 20, "wrapped text");
        assert_eq!(range, Some((0, 12)), "the whole chunk highlights");
        // The selection's ending line converts its source column.
        let range = chunk_selection(sel, 2, 0, "abcde");
        assert_eq!(range, Some((0, 5)));
        // A chunk the selection ends before does not highlight.
        let range = chunk_selection(sel, 2, 6, "fgh");
        assert_eq!(range, None);
        // The starting line clips at its start column: a chunk that
        // begins exactly where the selection does is fully covered, and a
        // chunk the selection starts AFTER stays clear.
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
