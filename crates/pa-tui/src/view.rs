//! Interactive agent view: fullscreen chat frame composed like the TS
//! interactive mode — a pinned top bar, a scrollable transcript window
//! (splash, chat rows, loader), and a dock (prompt-context line, editor
//! surface, tray). The session loop folds events into the view; this module
//! owns row geometry and scroll behavior only.

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

/// Minimum transcript rows when the dock would crowd them out
/// (TS `FULLSCREEN_MIN_TRANSCRIPT_ROWS`).
pub const FULLSCREEN_MIN_TRANSCRIPT_ROWS: usize = 3;

/// A `/share` gist upload in flight (TS `BorderedLoader` with
/// `CancellableLoader`): the spinner "Creating gist..." rows that replace
/// the editor while `gh gist create` runs.
#[derive(Debug, Clone)]
pub struct ShareLoader {
    /// The message under the spinner.
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
    /// A pending confirm: the Yes/No selector over the editor dock.
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
    /// The cross-view layout handoff held for this rebuild (see
    /// `view::handoff`): consumed by the first layout preparation, which
    /// validates the stored render shape and seeds the visible-window
    /// entry packs; dropped by every chat mutation (the held packs are
    /// only valid for the entries the rebuild pushed, so an append, an
    /// in-place mutation, or a wipe must never serve them after the
    /// transcript changed again).
    pending_handoff: Option<handoff::LayoutHandoff>,
    /// How many first-draw windows this view served from an adopted
    /// layout handoff (the served-path observable: an adopted pack
    /// serving a window never enters `render_entry` — the headless
    /// verifiers assert the reuse actually happened, else the
    /// byte-identical frames make a vacuous pass).
    pub(crate) handoff_seeds: u32,
    /// Entries whose card a click flipped away from the level's
    /// tool-output expansion (see `view/expansion.rs`).
    toggled_cards: std::collections::BTreeSet<usize>,
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
        if let Some(picker) = self.effort_picker.as_mut() {
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
        // A held layout handoff is only valid for the entries the rebuild
        // pushed; a later append means the transcript changed after the
        // adopt, so the handoff must never serve its rows (view::handoff).
        self.pending_handoff = None;
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
        // Same rule as `push_entry`: the pop is a transcript mutation
        // (the transcript this handoff was held for is no longer the
        // one under the view), so a held handoff must never serve its
        // rows after it (view::handoff).
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
        // Same rule as `push_entry`: a wipe retires any held handoff
        // (the rebuilt transcript is not the one it was held for).
        self.pending_handoff = None;
        self.sparse_enabled = true;
        self.sparse_entries.clear();
        self.toggled_cards.clear();
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
        // An in-place mutation changes the transcript after the adopt:
        // the held handoff is retired before the mutation lands.
        self.pending_handoff = None;
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
        // The mutation choke point (every in-place entry change routes
        // through here): the held handoff's packs are stale the moment
        // the transcript mutates, so they must never serve after this.
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

    /// Render the scrollable transcript: splash rows, chat component rows,
    /// and the working loader when a turn is active (the full compose —
    /// the inline frame and the headless verifiers; the fullscreen frame
    /// composes only its scroll window through the layout pass).
    pub fn render_transcript(&mut self, width: usize) -> Vec<Line> {
        let layout = self.layout_pass(width);
        self.transcript_window(&layout, 0, usize::MAX)
    }
}

/// Scroll state of the transcript window (TS `ScrollInfo`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollInfo {
    pub following: bool,
    pub lines_above: usize,
    pub lines_below: usize,
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
