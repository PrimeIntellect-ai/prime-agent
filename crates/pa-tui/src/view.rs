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

pub(crate) mod click;
mod geometry;
mod layout;
pub(crate) mod lazy;
mod restyle;

use click::{
    EditorClickSurface, PickerClickSurface, PickerKind, EFFORT_PICKER_CHROME_ROWS,
    MODEL_PICKER_CHROME_ROWS,
};
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
    /// The read-only info panel (the operator's 2026-09-26 directive:
    /// the `/context`-family client info displays render as the docked
    /// popup panel instead of flooding the transcript): while set, it
    /// owns the editor dock like the `/model` and `/effort` pickers.
    pub info_panel: Option<crate::info_panel::InfoPanel>,
    /// The `terminal.showImages` setting (TS `getShowImages`, default
    /// true): image blocks render their metadata rows when set, their
    /// `[Image: ...]` text placeholders otherwise.
    pub show_images: bool,
    /// The `showHardwareCursor` setting (TS default false): the hardware
    /// cursor is positioned at the focused caret for IME on every frame
    /// either way, but only shown when this is set — TS keeps the
    /// terminal's own cursor hidden by default so frame paints never drag
    /// a visible cursor across the pane (`positionHardwareCursor` and the
    /// paint tail move it while hidden).
    pub show_hardware_cursor: bool,
    /// The brand splash never renders while set (the operator's
    /// 2026-09-26 zero-layout-shift ruling): a chat that opens or rebinds
    /// directly into a non-empty transcript suppresses it — TS mounts the
    /// chat over an already-attached connection (its first visible frame
    /// is the content, and the tail-anchored fullscreen viewport scrolls
    /// the splash out of reach), so the splash never dwells or shifts a
    /// row under the pinned title bar. Every empty chat keeps it (TS
    /// `BrandSplashHeader` is the new chat's header, `quietStartup` and
    /// the onboarding `getHidden` are TS's own suppression gates).
    pub splash_suppressed: bool,
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
    /// Whether the last composed frame's transcript window reached the
    /// transcript tail (operator directive 2026-09-26: the follow hint
    /// composites only when following would actually scroll — a window
    /// that already shows the tail is at the bottom, not paused above
    /// new content).
    pub(crate) window_shows_tail: bool,
    /// A detail change whose window `resolve_sparse_geometry` consumed
    /// before its first composition: the next window build's dense arm
    /// re-derives the follow state from the post-transition geometry
    /// (operator directive 2026-09-26).
    pub(crate) detail_transition: bool,
    /// The screen cell the mouse currently hovers, set while its row is
    /// a clickable card row (operator directive 2026-09-26: the hovered
    /// card row brightens so clickability is discoverable). One cell of
    /// state — a motion report never costs more than one re-style —
    /// revalidated against every composed frame so a scroll, a resize,
    /// or streaming never leaves the affordance on a row that stopped
    /// being the hovered card.
    pub(crate) hover_pos: Option<(usize, usize)>,
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
    sparse_entries: std::collections::BTreeSet<usize>,
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
    /// The last composed frame's clickable link ranges (TS the
    /// viewport's `hyperlinkAt` over `lastFrame`): the click dispatch
    /// resolves a screen cell to its URL through these.
    pub(crate) frame_links: Vec<crate::hyperlinks::LinkRange>,
    /// In-app mouse text selection (TS `FullscreenViewport`'s selection
    /// state): anchor/head points, the mode, and the frame snapshot.
    pub(crate) selection: crate::selection::SelectionState,
    /// The selection restyle cache (TS re-styles rendered rows per
    /// frame; the window re-styles only the rows the selection change
    /// touched): walked base rows, their styled copies, and the spans.
    pub(crate) selection_restyle: restyle::SelectionRestyle,
    /// The last composed frame's clickable geometry (view/click.rs):
    /// the transcript window's visible entry spans, the dock's screen
    /// origin, the editor content rows, and the picker panes' item rows.
    /// Recorded during the fullscreen frame composition that already
    /// computes the geometry; cleared by the inline compose.
    pub(crate) click: click::ClickSurface,
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
            // A chat starts at the collapsed conversation-detail level
            // (operator directive 2026-09-28): every activity item
            // renders exactly as `details` does, with only the thinking
            // blocks hidden; Ctrl+O keeps cycling overview -> details
            // -> all, so the first press reveals the thinking.
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
            effort_picker: None,
            mcp_view: None,
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
            frame_links: Vec::new(),
            selection: crate::selection::SelectionState::default(),
            selection_restyle: restyle::SelectionRestyle::default(),
            sparse_mutation: None,
            click: click::ClickSurface::default(),
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
        self.chat.push(entry);
        self.entry_layout.push([None, None, None]);
        self.sparse_note_append();
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
        if self.sparse_window_is_tail_anchored() && self.layout_width > 0 {
            let rows = self.count_entry_rows(index, self.layout_width);
            self.sparse_tail_delta(-(rows as isize), index);
        }
        self.md_caches.borrow_mut().remove(&index);
        self.sparse_entries.remove(&index);
        self.entry_heights.pop();
        self.entry_layout.pop();
        self.chat.pop()
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
        if self.sparse_window_is_tail_anchored() && self.layout_width > 0 {
            let rows = self.count_entry_rows(index, self.layout_width);
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
                // replay instead of re-rendering on every frame — the
                // cache exists for the streaming case. A settled
                // message's blocks are final, so its rendered rows live
                // once in the entry layout and the block-cache copy is
                // dropped (a resumed large session's duplicate copy was
                // the TUI's biggest single retained allocation in the
                // tui-memory census); any later re-render rebuilds the
                // same rows from the message's own text.
                if message.streaming {
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
                } else {
                    self.md_caches.borrow_mut().remove(&index);
                    let mut settled = crate::markdown::MarkdownBlockCache::default();
                    render_assistant(
                        message,
                        detail,
                        &self.theme,
                        &self.code_block_indent,
                        width,
                        preceded_by_tool_activity,
                        &mut settled,
                    )
                }
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
        let overlay_count = lines.len() - context_rows;
        let (editor_rows, cursor) = self.render_editor_surface(width, context_rows + overlay_count);
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
    /// case). The panel opens with the one full-width muted rule every
    /// inline menu panel opens with (the operator's 2026-09-26 top-border
    /// directive), its rows pad to the input width and float on the popup
    /// background between the editor's left padding and prompt prefix, and
    /// the selected row's wash spans the panel's full width like the
    /// `/model` picker's selected row.
    fn render_autocomplete_overlay(&mut self, width: usize) -> Vec<Line> {
        let Some(state) = self.editor.autocomplete_state() else {
            return Vec::new();
        };
        let theme = &self.theme;
        let bg = self.theme.bg_style(ThemeBg::ToolPanelBg);
        let selection = self.theme.soft_selection_style();
        let padding_x = 2usize;
        // The overlay anchors against the live prompt prefix (TS
        // `getRenderMetrics`'s `promptPrefixWidth`, the `!`/`!!` prompts
        // included).
        let prompt_width = str_width(self.editor.bash_prompt_prefix().unwrap_or("> "));
        let content_width = width.saturating_sub(padding_x * 2).max(1);
        let input_width = content_width.saturating_sub(prompt_width).max(1);
        // The panel's top border: the muted `─` rule that separates an
        // inline menu panel from the rows above it, drawn on the panel
        // surface.
        let border = theme.fg_style(ThemeColor::BorderMuted).patch(bg);
        let mut rows: Vec<Line> = vec![vec![Span::styled("\u{2500}".repeat(width.max(1)), border)]];
        let mut overlay = Vec::new();
        overlay.extend(state.render(theme, input_width));
        overlay.push(Vec::new());
        for mut line in overlay {
            // The shared menu rows pad to the full input width with
            // unstyled spans, so the remaining-width fill below never
            // lands: the popup background must ride on every span the
            // row left unstyled. The selected row is the one whose spans
            // carry the selection band: its edge padding washes with the
            // selection too, so the band spans the panel's full width
            // instead of stopping at the input's edges.
            let selected = line.iter().any(|span| span.style.bg.is_some());
            for span in &mut line {
                if span.style.bg.is_none() {
                    span.style = span.style.patch(bg);
                }
            }
            let used: usize = line.iter().map(|s| str_width(&s.content)).sum();
            let edge = if selected { bg.patch(selection) } else { bg };
            let mut row: Line = vec![Span::styled(" ".repeat(padding_x + prompt_width), edge)];
            row.extend(line);
            row.push(Span::styled(
                " ".repeat(input_width.saturating_sub(used)),
                edge,
            ));
            row.push(Span::styled(" ".repeat(padding_x), edge));
            rows.push(pad_row(row, width));
        }
        rows
    }

    /// The editor surface (TS `Editor.render` with a background): a blank
    /// bg row, content rows with the `> ` prompt and a reverse-video cursor,
    /// and a trailing bg row. Scroll indicators replace the blank rows.
    fn render_editor_surface(
        &mut self,
        width: usize,
        dock_row: usize,
    ) -> (Vec<Line>, Option<(usize, usize)>) {
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
        // The content rows' click surface (view/click.rs): the TS editor
        // registers one region over its visible content rows, shifted by
        // the queue-selection header's rows (TS `getContentLineOffset`).
        self.click.record_editor(EditorClickSurface {
            dock_row,
            rows: visible.len(),
            queue_header_rows: usize::from(self.queue_selected.is_some()) * 2,
            prompt_width,
            content_width: layout_width,
        });
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
        let frame = crate::image_component::with_fullscreen_image_fallback(|| {
            self.render_frame_inner(width, height)
        });
        // The composed frame is the click surface (TS `hyperlinkAt` reads
        // the last painted frame's OSC 8 sequences): one scan serves every
        // pane — the transcript window, the dock, and the onboarding splash
        // all carry their links in span content.
        self.frame_links = crate::hyperlinks::frame_link_ranges(&frame);
        frame
    }

    fn render_frame_inner(&mut self, width: usize, height: usize) -> Vec<Line> {
        // The click surface records this frame's clickable geometry as
        // the compose computes it (the onboarding pane that returns early
        // leaves none of it).
        self.click.clear();
        // The onboarding splash covers the pane (TS `showOverlay` 100%):
        // no top bar, transcript, or prompt dock behind it. The pane is a
        // frame surface like the TS overlay (its rows select; TS's
        // `beginFrameSelection` falls through to the overlay's rows), so
        // the frame-selection regions span the whole frame.
        if let Some(screen) = self.onboarding.as_mut() {
            let kb = self.editor.keybindings();
            let mut frame = screen.render(&self.theme, width, height, kb);
            self.frame_rows = frame.len();
            self.apply_frame_selection(&mut frame, 0, width);
            return frame;
        }
        // The `/model` and `/effort` pickers mount in the editor dock (TS
        // `showConfigurationMenu` replaces the editor container), like the
        // tree and fork selectors: the prompt context (the detail hint)
        // stays above the pane and the transcript stays mounted above it.
        let prompt_context = render_prompt_context(&self.detail_label(), &self.theme, width);
        // The read-only info panel's CURRENT row budget (a terminal resize
        // re-budgets an open panel every frame, never a stale open-time
        // value): read before the panel borrow below.
        let info_viewport_rows = crate::session_ui::picker_viewport_rows(self.terminal_rows());
        let pane_row = prompt_context.len();
        let picker_dock: Option<Vec<Line>> = if let Some(picker) = self.model_picker.as_mut() {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            // The pane's item rows are clickable (view/click.rs): the
            // recorded span covers the filtered window the render drew.
            self.click.record_picker(PickerClickSurface {
                dock_row: pane_row,
                chrome_rows: MODEL_PICKER_CHROME_ROWS,
                items: picker.filtered_window(),
                kind: PickerKind::Model,
            });
            Some(dock)
        } else if let Some(picker) = &self.effort_picker {
            let mut dock = prompt_context;
            dock.extend(picker.render(&self.theme, width, self.editor.keybindings()));
            self.click.record_picker(PickerClickSurface {
                dock_row: pane_row,
                chrome_rows: EFFORT_PICKER_CHROME_ROWS,
                items: picker.visible_window(),
                kind: PickerKind::Effort,
            });
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
        } else if let Some(panel) = self.info_panel.as_mut() {
            let mut dock = prompt_context;
            dock.extend(panel.render(
                &self.theme,
                width,
                self.editor.keybindings(),
                &self.code_block_indent,
                info_viewport_rows,
            ));
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
                let kb = self.editor.keybindings();
                dock.extend(panel.render(&self.theme, width, kb));
            } else if let Some(message) = self.reload_box.as_ref() {
                dock.extend(self.render_reload_box(message, width));
            } else if let Some(menu) = self.settings_menu.as_ref() {
                dock.extend(menu.render(&self.theme, width, self.editor.keybindings()));
            }
            Some(dock)
        } else {
            picker_dock
        };
        // The top bar always renders: the surface is fullscreen-only
        // (the operator's 2026-09-28 retirement ruling — the
        // non-fullscreen render path never existed, so the preference
        // and its toggle are gone and the bar has no gate left).
        let top = render_top_bar(&self.chrome, &self.theme, width);
        let top_rows = 1;
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
        frame.push(pad_row(top, width));
        for line in window_rows {
            frame.push(pad_row(line, width));
        }
        while frame.len() < height.saturating_sub(dock.len()) {
            frame.push(vec![Span::raw(" ".repeat(width))]);
        }
        // The click surface's frame scalars: the window starts at the
        // top bar's rows, the dock starts at the frame's next row, and a
        // click's dock row indexes the un-cropped dock.
        self.click.note_frame(top_rows, frame.len(), cropped);
        for line in dock {
            frame.push(pad_row(line, width));
        }
        // The hover affordance (operator directive 2026-09-26): the
        // hovered clickable card row brightens — Muted text to the
        // theme's foreground, Dim to Muted, the "opacity shift" that
        // signals the row is clickable. One row, only while hovered —
        // and revalidated against THIS frame's just-recorded click
        // surface, so a scroll, a resize, or streaming that moves other
        // content onto the hovered row clears the affordance instead of
        // brightening whatever landed there (the review bots' finding:
        // the state is a screen coordinate, the layout moves).
        if let Some((row, col)) = self.hover_pos {
            if matches!(
                self.click_target_at(row, col),
                Some(click::ClickAction::ToggleCardExpansion)
            ) {
                if let Some(line) = frame.get_mut(row) {
                    apply_hover_affordance(line, &self.theme);
                }
            } else {
                self.hover_pos = None;
            }
        }
        // A paused viewport carries the follow hint over the last transcript
        // window row (TS composites it above the dock, below overlays) —
        // but only when following would actually scroll: a window that
        // already shows the transcript tail is at the bottom, not paused
        // above new content (operator directive 2026-09-26).
        if !self.following && !self.window_shows_tail {
            if let Some(row) = frame.get_mut(window_height) {
                let key = self
                    .editor
                    .keybindings()
                    .first_key("tui.viewport.follow")
                    .unwrap_or_else(|| "ctrl+shift+down".to_string());
                let label = format!(" {key} to follow ");
                *row = composite_follow_hint(row, &label, width);
                // The hint's row never reads as the content beneath it.
                self.click.mask_rows(window_height, window_height + 1);
            }
        }
        self.frame_rows = frame.len();
        self.apply_frame_selection(
            &mut frame,
            crate::selection::HEADER_ROWS + self.window_rows,
            width,
        );
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
            // The action ack renders as the brand-purple pill (the
            // operator directive): the theme's Accent token — the same
            // purple the brand visuals carry — flipped onto the pill's
            // background by REVERSED (the follow-hint overlay's badge
            // grammar), so the toast reads as a compact highlighted
            // chip, not a bare line.
            let style = self
                .theme
                .fg_style(crate::theme::ThemeColor::Accent)
                .add_modifier(Modifier::REVERSED);
            crate::toast::overlay_toasts(
                &mut frame,
                top_rows,
                top_rows + window_height,
                &toasts,
                width,
                style,
            );
            // The covered rows no longer read as the transcript content
            // beneath them: a click on the transient pill must not fire
            // the hidden row's target.
            let covered = toasts.len().min(window_height);
            self.click.mask_rows(top_rows, top_rows + covered);
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
            || self.info_panel.is_some()
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
        // The inline layout has no fullscreen window on screen: a click
        // must never resolve against a dock the terminal does not show.
        self.click.clear();
        rows
    }

    /// Stream the changed rows of the inline layout to `out` as the
    /// main-screen flush (TS `exitFullscreen`'s inline repaint): the flush
    /// is the one output path that writes into the user's native
    /// scrollback, so its byte stream is parity-frozen — and on a long
    /// transcript the materialized flush (`render_inline_frame` plus the
    /// row texts plus the write buffer) held the whole transcript in
    /// memory at once, a +O(rows) RSS spike right at exit. The streaming
    /// flush renders the frame one section at a time (splash, chat
    /// entries, tail, dock) and hands the encoded rows to `out` in
    /// bounded chunks, so the peak extra memory is one section plus one
    /// chunk.
    ///
    /// The write plan keeps the materialized flush's decision tree:
    ///
    /// - rows extending the flushed frame append below the cursor and
    ///   flow into native scrollback — the exit path that keeps the exit
    ///   frame and resume hint visible;
    /// - a change above the flushed tail (a transcript that grew past a
    ///   suspend-time flush, a snapshot rebuild) erases the visible
    ///   screen and repaints the last screenful, mirroring the TS full
    ///   redraw — scrollback above the screen is never rewritten,
    ///   because terminal scrollback is immutable;
    /// - an identical frame writes nothing.
    ///
    /// `self.flushed_frame` (the row texts of the last flush) is the diff
    /// base for the next flush, exactly as before.
    ///
    /// # Errors
    ///
    /// Propagates the write error when `out` rejects a chunk (a terminal
    /// that went away mid-flush): the rows already written have scrolled,
    /// so the flush is not retried — the exit tail restores the terminal.
    pub fn stream_flush_to(
        &mut self,
        out: &mut dyn std::io::Write,
        width: usize,
        screen_height: usize,
    ) -> std::io::Result<()> {
        let layout = self.layout_pass(width);
        let mut sink = FlushSink {
            flushed: std::mem::take(&mut self.flushed_frame),
            texts: Vec::new(),
            ring: std::collections::VecDeque::new(),
            chunk: String::new(),
            screen_height,
            appending: false,
            repaint: false,
        };
        sink.feed(out, &layout.splash)?;
        let mut preceded_by_tool_activity = false;
        for (index, entry) in self.chat.iter().enumerate() {
            let rows =
                self.render_entry(index, entry, width, index == 0, preceded_by_tool_activity);
            sink.feed(out, &rows)?;
            preceded_by_tool_activity = self.is_compact_neighbor(entry);
        }
        sink.feed(out, &layout.tail)?;
        let dock = self.render_dock(width);
        sink.feed(out, &dock)?;
        sink.finish(out)?;
        self.flushed_frame = std::mem::take(&mut sink.texts);
        Ok(())
    }
}

/// The encoded flush rows leave the process in slices of at most this
/// many bytes: big enough that each PTY write stays one syscall, small
/// enough that the flush buffer never holds the transcript. 32KiB also
/// bounds the exit guard's blind window on a slow terminal: a completed
/// chunk write is the guard's progress proof (the writer blocks inside a
/// chunk while the terminal drains, invisible from userspace), and at
/// this size a drain of at least ~65KB/s completes chunks within the
/// guard's grace window — the flush rides out a slow drain instead of
/// tripping the 1500ms force-quit deadline mid-write.
const CHUNK_BYTES: usize = 32 * 1024;

/// The streaming main-screen flush state: feeds the inline frame's rows
/// section by section, routes them between the append stream and the
/// repaint ring, and writes the encoded bytes in bounded chunks.
struct FlushSink {
    /// The last flush's row texts — the diff base (owned: the new frame's
    /// texts replace it at the end of the flush).
    flushed: Vec<String>,
    /// The new frame's row texts, accumulated as the rows stream (the
    /// diff base the NEXT flush compares against).
    texts: Vec<String>,
    /// The most recent `screen_height` rows seen, for the repaint write:
    /// a change above the flushed tail repaints the frame tail only.
    ring: std::collections::VecDeque<crate::Line>,
    /// The encoded append rows not yet handed to `out`.
    chunk: String,
    screen_height: usize,
    /// Set once a row extends the flushed frame: every later row appends.
    appending: bool,
    /// Set when a row inside the flushed frame changed: every row keeps
    /// landing in the repaint ring instead.
    repaint: bool,
}

impl FlushSink {
    /// Feed one section of the inline frame.
    fn feed(&mut self, out: &mut dyn std::io::Write, rows: &[crate::Line]) -> std::io::Result<()> {
        for row in rows {
            let index = self.texts.len();
            let text = row_text_of(row);
            if self.appending {
                crate::interactive::write_flush_rows(&mut self.chunk, std::slice::from_ref(row));
                self.texts.push(text);
                if self.chunk.len() >= CHUNK_BYTES {
                    out.write_all(self.chunk.as_bytes())?;
                    self.chunk.clear();
                    // A completed chunk write is exit-path progress: the
                    // exit guard holds its force-quit while these keep
                    // landing, so a slow terminal drains the flush
                    // instead of dying mid-write.
                    crate::exit_guard::note_exit_progress();
                }
            } else if self.repaint || index >= self.flushed.len() {
                // Rows inside the flushed frame landed in the ring while
                // the mode was undecided; a changed row turns the write
                // into a repaint, and a row past the flushed frame turns
                // it into an append.
                if self.repaint {
                    self.ring_push(row);
                } else {
                    self.appending = true;
                    crate::interactive::write_flush_rows(
                        &mut self.chunk,
                        std::slice::from_ref(row),
                    );
                }
                self.texts.push(text);
            } else {
                if self.flushed[index].as_str() != text.as_str() {
                    self.repaint = true;
                }
                self.ring_push(row);
                self.texts.push(text);
            }
        }
        Ok(())
    }

    /// Keep the repaint ring at one screenful.
    fn ring_push(&mut self, row: &crate::Line) {
        self.ring.push_back(row.clone());
        while self.ring.len() > self.screen_height {
            self.ring.pop_front();
        }
    }

    /// Write what the decided mode owes: the append tail, the repaint
    /// erase plus the ring, or nothing for an identical frame.
    fn finish(&mut self, out: &mut dyn std::io::Write) -> std::io::Result<()> {
        if self.appending {
            if !self.chunk.is_empty() {
                out.write_all(self.chunk.as_bytes())?;
                self.chunk.clear();
                crate::exit_guard::note_exit_progress();
            }
        } else if self.repaint || self.texts.len() < self.flushed.len() {
            // A frame that shrank never rewinds into a rewrite of
            // scrollback: the changed region repaints the visible window.
            let mut buffer = String::from("\x1b[2J\x1b[H");
            let ring: Vec<crate::Line> = std::mem::take(&mut self.ring).into_iter().collect();
            crate::interactive::write_flush_rows(&mut buffer, &ring);
            out.write_all(buffer.as_bytes())?;
            self.chunk.clear();
            crate::exit_guard::note_exit_progress();
        }
        Ok(())
    }
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
/// The hover affordance's row restyle (operator directive 2026-09-26):
/// Muted spans brighten to the theme's foreground and Dim spans to
/// Muted — the "text opacity changes a little bit" the operator asked
/// for. Accent paint (the status glyphs, errors, links) keeps its own
/// color, so the row stays legible and only its dim text brightens.
fn apply_hover_affordance(row: &mut Line, theme: &crate::theme::Theme) {
    let muted = theme.fg_style(crate::theme::ThemeColor::Muted).fg;
    let dim = theme.fg_style(crate::theme::ThemeColor::Dim).fg;
    let text = theme.fg_style(crate::theme::ThemeColor::Text);
    let bright = theme.fg_style(crate::theme::ThemeColor::Muted);
    for span in row.iter_mut() {
        if span.style.fg == muted {
            span.style = span.style.patch(text);
        } else if span.style.fg == dim {
            span.style = span.style.patch(bright);
        }
    }
}

fn indicator_row(indicator: &str, bg: Style, border: Style, width: usize) -> Line {
    // The indicator text paints on the editor surface's background too
    // (operator directive 2026-09-26): the bar's `↑/↓ N more` rows read
    // as part of the prompt bar, not as text floating on the terminal's
    // bare background.
    let mut row: Line = vec![Span::styled(indicator.to_string(), border.patch(bg))];
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
        } => ChatEntry::Tool(Box::new(crate::chat::ToolCallCard {
            id,
            name,
            args: serde_json::from_str(&arguments).unwrap_or(serde_json::Value::Null),
            started: false,
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
mod tests;
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
