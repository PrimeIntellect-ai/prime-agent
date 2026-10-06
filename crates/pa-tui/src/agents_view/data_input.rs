//! The data assembly and the input surface: the unified records, the row rebuild (the
//! reconciled roster+catalog with the query filter), the roster update apply, the saved-catalog
//! stream reconcile, and the selection/key/mouse dispatch residue.
use super::{
    build_rows, compute_rollups, filter_empty_sessions, filter_unified_sessions,
    parse_search_query, reconcile_unified_sessions, resolve_selection, scope_ancestors, scope_root,
    scope_to_subtree, AgentsViewMode, AgentsViewRow, AgentsViewScope, Composer, OpenedRow, PathBuf,
    PressedMouseClick, RowKind, ScopeRoot, SelectionEdge, SelectionKey, SessionSelection, Value,
    ANCHOR_LOADING_HINT,
};

impl AgentsViewMode {
    pub(super) fn records(&self) -> Vec<crate::agents_view_state::UnifiedRecord> {
        reconcile_unified_sessions(&self.roster, &self.saved)
    }

    /// Rebuild rows from the current roster, catalog, and query. A scoped run lists the scope
    /// root's subtree with the root's own row excluded; a gone scope root falls back.
    pub(super) fn rebuild_rows(&mut self) {
        let identity = self.rows.get(self.selected).map(|row| row.identity.clone());
        let records = self.records();
        // A scope frame whose root is gone drops, with the nearest fallback surfaced as a
        // status message.
        let mut scope_active = false;
        let scoped = match &self.options.scope {
            Some(scope) if !self.scope_dropped => {
                if let Some(scoped) = scope_to_subtree(&records, scope) {
                    scope_active = true;
                    self.scope_root = scope_root(&records, scope);
                    Some(scoped)
                } else {
                    self.scope_root = None;
                    self.scope_dropped = true;
                    self.set_status("Scope is no longer available; returned to the global view");
                    None
                }
            }
            _ => None,
        };
        self.scope_active = scope_active;
        let working: &[_] = match &scoped {
            Some(scoped) => scoped,
            None => &records,
        };
        // The empty-catalog filter preserves the anchor and the scope root; the search filter
        // keeps ancestors so a match never orphans its parent row.
        let mut preserved = Vec::new();
        if let Some(anchor) = self.options.anchor_session_id.as_deref() {
            preserved.push(anchor);
        }
        if let Some(scope) = self.options.scope.as_ref() {
            if let Some(session) = scope.session_id.as_deref() {
                preserved.push(session);
            }
        }
        let filtered = filter_empty_sessions(working, &preserved);
        let filtered = if self.query.trim().is_empty() {
            filtered
        } else {
            let parsed = parse_search_query(self.query.trim());
            filter_unified_sessions(&filtered, &parsed)
        };
        // The rollup runs over the full reconciled set, so a filter never changes a row's total.
        let rollups = compute_rollups(&records);
        let mut rows = build_rows(
            &filtered,
            self.options.scope.as_ref(),
            &self.expanded_parents,
            &self.program_shown_parents,
            &rollups,
            self.options.anchor_session_id.as_deref(),
        );
        // The entry anchor's row may be nested: arm the same ancestor expansion below so this
        // pass reveals it (a scoped view never lists the anchor).
        if let (true, Some(anchor)) = (
            self.anchor_selection_pending
                && self.options.scope.is_none()
                && self.pending_ancestors.is_none(),
            self.options.anchor_session_id.as_deref(),
        ) {
            self.pending_ancestors = Some(scope_ancestors(
                &records,
                &AgentsViewScope {
                    session_id: Some(anchor.to_string()),
                    active_session_id: None,
                    session_name: None,
                },
            ));
        }
        // Re-expand the drilled-in row's ancestors: a nested row appears only once its parent is
        // expanded (expand-and-rebuild until a pass reveals nothing new).
        if let Some(wanted) = self.pending_ancestors.take() {
            let mut added = true;
            while added {
                added = false;
                for row in &rows {
                    if row.kind == RowKind::SubagentSummary {
                        continue;
                    }
                    let session_id = row.summary.get("sessionId").and_then(Value::as_str);
                    if session_id.is_some_and(|id| wanted.iter().any(|w| w == id)) {
                        // The drilled row sits under the ONE merged line, so the reveal opens it.
                        if self.expanded_parents.insert(row.identity.clone()) {
                            added = true;
                        }
                    }
                }
                if added {
                    rows = build_rows(
                        &filtered,
                        self.options.scope.as_ref(),
                        &self.expanded_parents,
                        &self.program_shown_parents,
                        &rollups,
                        self.options.anchor_session_id.as_deref(),
                    );
                }
            }
        }
        // Keep the selection on the same row across rebuilds, falling back to the carried
        // identity/key.
        self.selected = resolve_selection(
            &rows,
            self.selected,
            identity.as_deref().or(self.selected_identity.as_deref()),
            self.selected_key.as_ref(),
        );
        // The entry anchor lands the selection on its row once it appears; the sync below pins it,
        // so later rebuilds restore onto it through the carried identity/key alone.
        if let (true, Some(anchor)) = (
            self.anchor_selection_pending,
            self.options.anchor_session_id.as_deref(),
        ) {
            if let Some(index) = rows.iter().position(|row| {
                row.selectable()
                    && row.summary.get("sessionId").and_then(Value::as_str) == Some(anchor)
            }) {
                self.selected = index;
                self.end_anchor_wait();
            }
        }
        self.rows = rows;
        // The armed confirm only rides a row the list still carries under the session key it
        // armed with: a removed, re-created, or re-keyed row retires it.
        if let Some(pending) = &self.pending_delete {
            let still_there = self.rows.iter().any(|row| row.identity == pending.identity);
            let unchanged_key = self
                .rows
                .iter()
                .find(|row| row.identity == pending.identity)
                .map(|row| self.armed_session_key(row))
                .is_some_and(|key| key == pending.session_key);
            if !still_there || !unchanged_key {
                self.pending_delete = None;
            }
        }
        self.sync_selected_row_state();
    }

    /// Apply one roster push (`changed` upserts, `removed` deletes,
    /// `resync` replaces the whole roster).
    pub(super) fn apply_roster_update(
        &mut self,
        changed: Vec<Value>,
        removed: Vec<String>,
        resync: bool,
    ) {
        if resync {
            self.roster.clear();
        }
        for entry in changed {
            let Some(agent_id) = entry.get("agentId").and_then(Value::as_str) else {
                continue;
            };
            if let Some(existing) = self
                .roster
                .iter_mut()
                .find(|row| row.get("agentId").and_then(Value::as_str) == Some(agent_id))
            {
                *existing = entry;
            } else {
                self.roster.push(entry);
            }
        }
        for agent_id in removed {
            self.roster.retain(|row| {
                row.get("agentId").and_then(Value::as_str) != Some(agent_id.as_str())
            });
        }
        self.rebuild_rows();
    }

    /// Track the selected row's identity and key: they survive rebuilds, and EVERY selection move
    /// refreshes them (a stale key would win the active-session-id fallback on the next rebuild).
    pub(super) fn sync_selected_row_state(&mut self) {
        if let Some(row) = self.rows.get(self.selected) {
            self.selected_identity = Some(row.identity.clone());
            self.selected_key = Some(crate::agents_view_forest::selection_key(&row.summary));
        } else {
            self.selected_identity = None;
            self.selected_key = None;
        }
    }

    /// Move the selection by `delta` selectable rows, refreshing the carried identity/key. The
    /// first move is an explicit user choice: it cancels the entry anchor's wait.
    pub(super) fn move_selection(&mut self, delta: isize) {
        self.anchor_selection_pending = false;
        self.search_return = None;
        self.clear_anchor_loading_hint();
        let selectable: Vec<usize> = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.selectable())
            .map(|(index, _)| index)
            .collect();
        if selectable.is_empty() {
            self.selected = 0;
            self.sync_selected_row_state();
            return;
        }
        let current = selectable
            .iter()
            .position(|index| *index == self.selected)
            .unwrap_or(0);
        let next = (current as isize + delta).clamp(0, selectable.len() as isize - 1) as usize;
        self.selected = selectable[next];
        self.sync_selected_row_state();
        // The reply stays armed only while the selection sits on the targeted row.
        self.disarm_reply_off_selected();
    }

    /// Jump the selection to the first or last selectable row (`home`/`end` and their ctrl/super
    /// variants), with `move_selection`'s contract.
    pub(super) fn move_selection_to(&mut self, edge: SelectionEdge) {
        self.anchor_selection_pending = false;
        self.search_return = None;
        self.clear_anchor_loading_hint();
        let selectable: Vec<usize> = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.selectable())
            .map(|(index, _)| index)
            .collect();
        self.selected = match edge {
            SelectionEdge::First => selectable.first().copied(),
            SelectionEdge::Last => selectable.last().copied(),
        }
        .unwrap_or(0);
        self.sync_selected_row_state();
        // The list-edge jumps are moves too: the reply disarms when the selection
        // leaves the row.
        self.disarm_reply_off_selected();
    }

    /// Open the selected row: the summary row toggles its list, a nested child drills into its
    /// transcript with its ancestor chain, and a top-level agent opens its session.
    ///
    /// While the entry anchor still waits, opening would confirm an arbitrary row, so the open
    /// waits: a direction key or row click cancels the wait.
    pub(super) fn end_anchor_wait(&mut self) {
        self.anchor_selection_pending = false;
        self.clear_anchor_loading_hint();
    }

    /// Buffer one streamed saved row: the loop flushes the batch in its reconcile window, never
    /// per row.
    pub(super) fn buffer_saved_stream_item(&mut self, session: Value) {
        self.saved_stream.push(session);
    }

    /// Flush the streamed batch into the catalog: upsert by path first, then durable id, so a
    /// superseded fetch's late frames never duplicate a row. Returns whether the catalog changed.
    pub(super) fn flush_saved_stream(&mut self) -> bool {
        if self.saved_stream.is_empty() {
            return false;
        }
        for row in std::mem::take(&mut self.saved_stream) {
            let path = row.get("path").and_then(Value::as_str);
            let durable_id = row.get("id").and_then(Value::as_str);
            let existing = self.saved.iter().position(|saved| {
                path.is_some_and(|path| saved.get("path").and_then(Value::as_str) == Some(path))
                    || durable_id
                        .is_some_and(|id| saved.get("id").and_then(Value::as_str) == Some(id))
            });
            match existing {
                Some(index) => self.saved[index] = row,
                None => self.saved.push(row),
            }
        }
        self.rebuild_rows();
        true
    }

    /// Drop the unflushed stream batch: the terminal response replaces the catalog wholesale, and
    /// a terminal failure keeps the last good rows.
    pub(super) fn drop_saved_stream(&mut self) {
        self.saved_stream.clear();
    }

    /// The saved-catalog fetch settled on a terminal failure: the entry anchor's wait ends with
    /// it (the anchor's row can only arrive through this fetch).
    pub(super) fn settle_anchor_wait_on_saved_failure(&mut self) {
        self.end_anchor_wait();
    }

    /// One search edit (TS `queryChanged`). The rebuilt list selects its
    /// first row, the top-ranked hit, instead of following the previous
    /// row (a lower-ranked hit, or an index clamped onto the last hit when
    /// that row was filtered out). The first keystroke remembers the
    /// selected session, and the edit that clears the query returns to it
    /// while it is still listed, else to the top. Searching is an explicit
    /// choice, so it ends the entry anchor's wait (TS `syncSelectedRowState`).
    ///
    /// TS `rearmSavedSearchFetch`: a terminal saved-catalog failure re-arms
    /// on the next query change. The loop owns the client, so the mode only
    /// records the intent; `take_saved_fetch_rearm` hands it to the loop
    /// AND consumes the failure: at most one retry is ever armed, so two
    /// concurrent `list_saved_sessions` scans (whose completions can
    /// arrive out of order) never race a stale failure over a newer
    /// success.
    pub(super) fn query_changed(&mut self, was_empty: bool) {
        self.saved_query_rearm = self.saved_fetch_failed;
        self.end_anchor_wait();
        if was_empty {
            self.search_return = self
                .selected_identity
                .clone()
                .zip(self.selected_key.clone());
        }
        self.rebuild_rows();
        if !self.query.is_empty() {
            self.selected = self
                .rows
                .iter()
                .position(AgentsViewRow::selectable)
                .unwrap_or(0);
        } else if let Some((identity, key)) = self.search_return.take() {
            self.selected = resolve_selection(&self.rows, 0, Some(&identity), Some(&key));
        }
        self.sync_selected_row_state();
    }

    /// A landed saved-catalog snapshot: the authoritative array replaces the stream's rows, with
    /// this run's deleted paths filtered out (a slow fetch never restores a deleted row).
    pub(super) fn apply_saved_loaded(&mut self, sessions: Vec<Value>) {
        self.saved = sessions
            .into_iter()
            .filter(|saved| {
                saved
                    .get("path")
                    .and_then(Value::as_str)
                    .is_none_or(|path| !self.deleted_saved_paths.contains(path))
            })
            .collect();
        self.saved_fetch_failed = false;
        // The flow's next view run reuses the settled catalog without a fetch.
        self.saved_catalog_loaded = true;
    }

    /// Whether the loop must re-arm the saved-catalog fetch (one retry per terminal failure).
    pub(super) fn take_saved_fetch_rearm(&mut self) -> bool {
        let rearm = std::mem::take(&mut self.saved_query_rearm);
        if rearm {
            self.saved_fetch_failed = false;
        }
        rearm
    }

    /// The loading hint belongs to the wait alone: ending the wait by either arm drops it, so the
    /// status line returns to the flow's own notice, never a stale loading message.
    pub(super) fn clear_anchor_loading_hint(&mut self) {
        if self.status_text() == Some(ANCHOR_LOADING_HINT) {
            self.status = None;
        }
    }

    /// The selection page step: the page keys move by the terminal rows minus the fixed frame
    /// chrome (splash, search prompt, hints), floored at 4 rows.
    pub(super) fn page_step(&self) -> usize {
        self.last_height.saturating_sub(9).max(4).max(1)
    }

    /// Handle one key id. Every action dispatches through the effective keybindings in TS
    /// dispatch order, so a user override moves both the handler and the hint — the same contract
    /// as the session view (#184).
    pub(super) fn handle_key(&mut self, key: &str) {
        // A sticky line clears on any keypress (the transient lines ride their own
        // expiry).
        self.clear_sticky_status();
        let was_armed = self.exit_armed;
        // The notice panel: any key closes it (the refusal's ways out stay copy-pasteable while
        // it is up), except the exit key, which falls through so the double-press exit convention
        // keeps working with the panel open.
        if self.notice.is_some() && !self.keybindings.matches(key, "app.clear") {
            self.notice = None;
            return;
        }
        self.notice = None;
        // Any other key clears the exit hint and the stop-or-delete confirm.
        self.exit_armed = false;
        let was_delete_armed = self.pending_delete.take();
        let has_query = !self.query.is_empty();
        // The armed composer owns every key before the app-level handlers; the draft
        // comes out owned, and an unarmed Search parks nothing.
        match std::mem::replace(&mut self.composer, Composer::Search) {
            Composer::Rename(rename) => {
                self.handle_rename_key(rename, key);
                return;
            }
            Composer::Reply(reply) => {
                self.handle_reply_key(reply, was_delete_armed, key);
                return;
            }
            Composer::Search => {}
        }
        // `app.clear` (default ctrl+c): the first press arms the exit hint, a second press while
        // armed exits. One handled Ctrl+C press: the force-quit guard disarms once the whole
        // observed pair was handled; an exit re-arms from the run loop's break.
        if self.keybindings.matches(key, "app.clear") {
            if key == "ctrl+c" {
                self.exit_guard.note_ctrl_c_handled();
            }
            if was_armed {
                self.running = false;
            } else {
                self.exit_armed = true;
            }
            return;
        }
        // Esc dismisses the incident notice while it is the only thing to cancel (an empty search
        // prompt). An armed delete confirmation is the more dangerous state: Esc cancels it (the
        // take() above) and keeps the notice; without a visible notice, Esc keeps its back/exit
        // meaning.
        if was_delete_armed.is_none()
            && !has_query
            && self.keybindings.matches(key, "tui.select.cancel")
            && self.dismiss_incident_notice()
        {
            return;
        }
        // `app.agents.rename` (default ctrl+r, empty editor only, before the delete arm):
        // enter the rename composer.
        if !has_query && self.keybindings.matches(key, "app.agents.rename") {
            self.enter_rename_mode();
            return;
        }
        // `app.agents.delete` (default ctrl+x, empty editor only): the first press arms the
        // confirm (the hint reads "stop" for live work, "delete" otherwise), the second press on
        // the same row executes, any other key clears the arm.
        if !has_query && self.keybindings.matches(key, "app.agents.delete") {
            // Stopping or deleting a tailnet peer happens on its machine
            // (TS #2516); the view stays read-only context for it.
            if self.guard_remote_row("stop or delete") {
                return;
            }
            self.confirm_delete_for_selected(was_delete_armed);
            return;
        }
        // `app.agents.reply` (default space, empty editor only): arm the reply over
        // the selected row; the same target disarms, and a space with a query is
        // search text.
        if !has_query && self.keybindings.matches(key, "app.agents.reply") {
            self.toggle_reply();
            return;
        }
        // TS `app.agents.new` (default ctrl+n): start a session; a plain
        // "n" is search text like any other character. Scoped (the
        // operator's 2026-09-28 directive, a deliberate TS divergence -
        // TS always starts a root session): the session starts under the
        // scope root, one level below it and in its directory, so it
        // lists in this view and the agents-back return lands here. A
        // root with no session file (a `--no-session` root) has nothing
        // to bind and starts a root session.
        if self.keybindings.matches(key, "app.agents.new") {
            let (selection, rlm_depth, cwd) = match self.scope_root.clone() {
                Some(ScopeRoot {
                    child_depth,
                    session_file: Some(file),
                    cwd,
                }) => (
                    SessionSelection::NewChild {
                        parent_session_file: PathBuf::from(file),
                        rlm_depth: child_depth,
                    },
                    Some(child_depth),
                    cwd,
                ),
                Some(ScopeRoot {
                    session_file: None, ..
                })
                | None => (SessionSelection::New, None, None),
            };
            self.opened = Some(OpenedRow {
                selection,
                expanded_ancestors: Vec::new(),
                selected_row_identity: String::new(),
                selected_key: SelectionKey::default(),
                rlm_depth,
                has_children: false,
                status_message: None,
                cwd,
            });
            self.running = false;
            return;
        }
        // `app.agents.program` (default ctrl+o, empty editor only): show or hide the selected
        // row's target spawn program.
        if !has_query && self.keybindings.matches(key, "app.agents.program") {
            self.cycle_program_for_selected();
            return;
        }
        // `app.agents.expand` (default alt+right, search empty): toggle the selected parent's
        // list when it has children.
        if !has_query && self.keybindings.matches(key, "app.agents.expand") {
            let selected = self.rows.get(self.selected).cloned();
            if let Some(row) = selected {
                if row.kind == RowKind::SubagentSummary || row.descendant_count > 0 {
                    self.toggle_subagent_list(&row);
                }
            }
            return;
        }
        // `app.agents.open` (right) and the editor submit (enter) both open the selection; the
        // summary row toggles its list instead.
        if self.keybindings.matches(key, "app.agents.open")
            || self.keybindings.matches(key, "tui.select.confirm")
        {
            self.open_selected();
            return;
        }
        if self.keybindings.matches(key, "tui.select.up") {
            self.move_selection(-1);
            return;
        }
        if self.keybindings.matches(key, "tui.select.down") {
            self.move_selection(1);
            return;
        }
        if self.keybindings.matches(key, "tui.select.pageUp") {
            self.move_selection(-(self.page_step() as isize));
            return;
        }
        if self.keybindings.matches(key, "tui.select.pageDown") {
            self.move_selection(self.page_step() as isize);
            return;
        }
        // The list-edge jump keys (operator directive, no TS counterpart): one-row up/down is
        // too slow on a large forest, so home/end and their ctrl/super variants select the
        // first/last row (the search editor keeps `ctrl+a`/`ctrl+e` for its own line ends).
        if self.keybindings.matches(key, "tui.select.top") {
            self.move_selection_to(SelectionEdge::First);
            return;
        }
        if self.keybindings.matches(key, "tui.select.bottom") {
            self.move_selection_to(SelectionEdge::Last);
            return;
        }
        // The scoped view's parent key (default left): with an empty search it hands the
        // terminal back to the scope root's session and pops the scope; the global view has no
        // hierarchy parent and consumes the key without opening a chat.
        if !has_query && self.keybindings.matches(key, "app.agents.back") {
            if self.scope_active {
                self.open_scope_root(true);
            }
            return;
        }
        // `app.input.clear` (default escape): clear the search; scoped, reopen the last-opened
        // session (the scope root in this flow) without touching the scope frame; otherwise exit.
        if self.keybindings.matches(key, "app.input.clear") {
            if !self.query.is_empty() {
                self.query.clear();
                self.query_changed(false);
            } else if self.scope_active {
                self.open_scope_root(false);
            } else {
                self.running = false;
            }
            return;
        }
        // `app.exit` (default ctrl+d, empty editor): leave the view without opening a session.
        if !has_query && self.keybindings.matches(key, "app.exit") {
            self.running = false;
            return;
        }
        // Editor text keys: backspace deletes the last character, ctrl+u clears the line, and
        // any single character is search text.
        if self
            .keybindings
            .matches(key, "tui.editor.deleteCharBackward")
        {
            // A no-op edit on an empty query changes nothing: the
            // re-arm's expensive retry must not fire behind it.
            if self.query.pop().is_some() {
                self.query_changed(false);
            }
            return;
        }
        if self
            .keybindings
            .matches(key, "tui.editor.deleteToLineStart")
        {
            if !self.query.is_empty() {
                self.query.clear();
                self.query_changed(false);
            }
            return;
        }
        // TS `Editor.handleInput`'s `deleteWordBackward` (ctrl+w / alt+backspace).
        if self
            .keybindings
            .matches(key, "tui.editor.deleteWordBackward")
        {
            if truncate_trailing_word(&mut self.query) {
                self.query_changed(false);
            }
            return;
        }
        // The printable decode the editor uses (`decode_printable`):
        // the space arrives as the `space` key id (TS parseKey maps the
        // raw space there), and the shift+letter ids decode to their
        // characters.
        if let Some(text) = crate::editor::decode_printable(key) {
            let was_empty = self.query.is_empty();
            self.query.push_str(&text);
            self.query_changed(was_empty);
        }
    }

    /// Materialize the armed composer's parked suggestion request: `getSuggestions`
    /// resolves after the keystroke batch, so the host materializes it (the chat's
    /// `materialize_editor_autocomplete`). Search and provider-less editors park
    /// nothing.
    pub(super) fn materialize_composer_autocomplete(&mut self) {
        match &mut self.composer {
            Composer::Search => {}
            Composer::Rename(rename) => rename.editor.materialize_autocomplete(),
            Composer::Reply(reply) => reply.editor.materialize_autocomplete(),
        }
    }

    /// One paste (bracketed, or the reader's coalesced marker-less burst — tmux ≤3.2
    /// forwards pastes without markers, and Enter submits, so a line-by-line burst
    /// would submit per line): the armed composer's editor takes it; the search field
    /// ignores it.
    pub(super) fn handle_paste(&mut self, text: &str) {
        match std::mem::replace(&mut self.composer, Composer::Search) {
            Composer::Search => {}
            Composer::Rename(mut rename) => {
                rename.editor.handle_paste(text);
                let _ = rename.editor.take_events();
                self.composer = Composer::Rename(rename);
            }
            Composer::Reply(mut reply) => {
                reply.editor.handle_paste(text);
                let _ = reply.editor.take_events();
                self.composer = Composer::Reply(reply);
            }
        }
    }

    /// One mouse report, scoped to the view's rows: a plain left press always re-records the row
    /// under it, a drag kills the pending click, and a plain release on the same row selects and
    /// opens that row — the Enter action with its own preamble (a showing notice panel consumes
    /// the click, the exit hint and the stop-or-delete confirm clear with it). The clicked row is
    /// an explicit user choice: it ends the entry anchor's wait, so the open targets the clicked
    /// row. Wheel turns and other buttons are consumed without a dispatch (the view's window is
    /// selection-centered, not scroll-driven).
    pub(super) fn handle_mouse(&mut self, event: &crate::mouse::MouseEvent) {
        if !crate::mouse_tracking::active() {
            return;
        }
        // A buttonless motion report is the hover (operator directive 2026-09-29, `?1003` any-event
        // tracking): the row under the mouse carries the light hover band while it resolves to a
        // session row. Motion never disturbs the click grammar: a pending press keeps its row
        // (only a left-button drag marks it).
        if event.button == crate::mouse::BUTTON_NONE && event.motion {
            let row = event.y.saturating_sub(1) as usize;
            let hover = self
                .click_rows
                .iter()
                .any(|(click_row, _)| *click_row == row)
                .then_some(row);
            self.hover_row = hover;
            return;
        }
        if event.button != crate::mouse::BUTTON_LEFT {
            return;
        }
        // Modifier presses stay inert — this view has no selection surface to offer (a stale
        // pending click dies with them).
        if event.shift || event.alt || event.ctrl {
            self.pressed_click = None;
            return;
        }
        let row = event.y.saturating_sub(1) as usize;
        if event.press {
            // A fresh plain press always re-records its row: a release lost to a focus change
            // or a touch cancel must never pin the next tap to the old row. A motion report while
            // pressed only marks the drag.
            if event.motion {
                if let Some(pressed) = self.pressed_click.as_mut() {
                    pressed.dragged = true;
                }
            } else {
                self.pressed_click = Some(PressedMouseClick {
                    row,
                    dragged: false,
                });
            }
            return;
        }
        let Some(pressed) = self.pressed_click.take() else {
            return;
        };
        if pressed.dragged || pressed.row != row {
            return;
        }
        let Some((_, index)) = self.click_rows.iter().find(|(r, _)| *r == row) else {
            return;
        };
        // The click runs the Enter action's preamble: a showing notice panel consumes it, and the
        // exit hint and the stop-or-delete confirm clear with it, so a later ctrl+x re-arms over
        // the clicked row instead of executing a stale arm.
        if self.notice.is_some() {
            self.notice = None;
            return;
        }
        self.exit_armed = false;
        self.pending_delete = None;
        self.selected = *index;
        self.search_return = None;
        // A click is an explicit user choice like a direction key: it
        // ends the entry anchor's wait, so the open below targets the
        // clicked row, never the loading hint.
        self.anchor_selection_pending = false;
        self.clear_anchor_loading_hint();
        self.sync_selected_row_state();
        // The click moves the selection like a direction key, so the keyboard rule
        // applies before the open: the composer never stays armed against a row the
        // highlight left.
        self.disarm_reply_off_selected();
        self.open_selected();
    }
}

/// Delete the query's trailing word run plus the whitespace before it
/// (TS `Editor.deleteWordBackwards` with the caret at the text's end —
/// this view's query is append-only, so the caret always sits there):
/// the search input's punctuation-aware walk, so a dotted query
/// ("error.rs") loses its trailing word run and keeps "error." — a
/// whitespace-only scan would take the whole dotted word. Returns
/// whether anything was deleted: a no-op edit re-arms nothing.
fn truncate_trailing_word(query: &mut String) -> bool {
    let chars: Vec<char> = query.chars().collect();
    let start = crate::search_input::word_walk_start(query);
    if start == chars.len() {
        return false;
    }
    *query = chars[..start].iter().collect();
    true
}
