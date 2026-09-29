//! The render surface: the frame composer (splash, search prompt,
//! sectioned list, hints), the row builders, the notice/list/row
//! renderers, the cell/truncate helpers, and the terminal/
//! headless renderer (moved with their concern).
use super::*;

impl AgentsViewMode {
    /// Compose one frame (splash, search prompt, sectioned list, hints).
    pub(super) fn render_frame(
        &mut self,
        width: usize,
        height: usize,
    ) -> (Vec<Line>, Option<(usize, usize)>) {
        // The frame height feeds the page step (TS reads
        // `ui.terminal.rows` live at key time instead).
        self.last_height = height;
        let theme = &self.theme;
        let mut lines: Vec<Line> = Vec::new();
        // TS `getAgentCountsText` rides the splash as extra metadata. Like
        // TS `countRowsBySection`, it counts agent-kind rows only — nested
        // subagent and summary rows never inflate the header.
        let count_agents = |section: Section| {
            self.rows
                .iter()
                .filter(|row| row.kind == RowKind::Agent && row.section == section)
                .count()
        };
        let (running, idle, inactive) = (
            count_agents(Section::Running),
            count_agents(Section::Idle),
            count_agents(Section::Inactive),
        );
        let mut extra_metadata = vec![(
            "agents".to_string(),
            format!("{running} running, {idle} idle, {inactive} inactive"),
        )];
        if let Some(depth) = self.scope_depth {
            extra_metadata.push(("depth".to_string(), depth.to_string()));
        }
        let chrome = crate::chrome::ChromeState {
            version: self.options.version.clone(),
            cwd: self.options.cwd.to_string_lossy().to_string(),
            extra_metadata,
            splash_hide_cwd: self.scope_active,
            ..Default::default()
        };
        // `render_splash` already trails one blank row (TS renderContent's
        // `headerLines.push("")`), so the incident notice rides directly
        // under it (TS `renderContent`'s `headerLines.push("",
        // ...noticeLines)`): the warning line and its pointer stay above
        // the scope label and the search prompt.
        lines.extend(crate::chrome::render_splash(&chrome, theme, width));
        lines.extend(self.render_incident_notice(width));
        // The scoped view's back label (TS `<back> back · <title> ›
        // subagents`), dim, over the full width under the splash.
        if self.scope_active {
            if let Some(scope) = &self.options.scope {
                let title = scope
                    .session_name
                    .clone()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "Untitled agent".to_string());
                let label = truncate_text(
                    &format!("\u{2190} back \u{b7} {title} \u{203a} subagents"),
                    width,
                );
                let mut row = vec![crate::Span::styled(label, theme.fg_style(ThemeColor::Dim))];
                row = crate::width::pad_line(row, width);
                lines.push(row);
                lines.push(vec![]);
            }
        }

        // Inline search prompt (TS renders the transparent editor with the
        // `> ` prefix, paddingX 2, and the dim "Search sessions" placeholder).
        let mut prompt: Line = vec![crate::Span::styled(
            " >  ".to_string(),
            theme.fg_style(ThemeColor::Muted),
        )];
        let head = truncate_text(&self.query, width.saturating_sub(5).max(1));
        prompt.push(crate::Span::styled(head, theme.fg_style(ThemeColor::Muted)));
        if self.query.is_empty() {
            prompt.push(crate::Span::styled(
                " ".to_string(),
                theme.fg_style(ThemeColor::Muted),
            ));
            prompt.push(crate::Span::styled(
                "Search sessions".to_string(),
                theme.fg_style(ThemeColor::Dim),
            ));
        }
        let cursor = Some((
            lines.len(),
            4 + str_width(&self.query).min(width.saturating_sub(4)),
        ));
        lines.push(prompt);
        lines.push(vec![]);

        // The notice panel (a multi-line refusal from the previous run)
        // takes its rows between the list and the hint line, so the list
        // window shrinks while the full text stays visible. A budget that
        // cannot hold the borders and one content row (a degenerate pane)
        // falls back to the hint-line status with the notice's first line.
        let budget = height.saturating_sub(lines.len() + 1);
        // The panel is built and the notice's borrow ends here (render_list
        // below takes the mode mutably).
        let notice_panel = self
            .notice
            .as_deref()
            .filter(|_| budget >= 4)
            .map(|notice| self.render_notice(notice, width, budget));
        // Owned: the fallback's borrow of the notice must end before the
        // mutable list render below.
        let status_fallback: Option<String> = notice_panel
            .is_none()
            .then(|| {
                self.notice
                    .as_deref()
                    .and_then(|notice| notice.lines().next())
            })
            .flatten()
            .map(str::to_string);
        let notice_height = notice_panel.as_ref().map_or(0, Vec::len);
        let list_rows = height.saturating_sub(lines.len() + 1 + notice_height);
        let list_frame_row = lines.len();
        lines.extend(self.render_list(width, list_rows, list_frame_row));
        if let Some(panel) = notice_panel {
            lines.extend(panel);
        }
        while lines.len() < height.saturating_sub(1) {
            lines.push(vec![]);
        }
        lines.push(self.render_hints(width, status_fallback.as_deref()));
        while lines.len() > height {
            lines.pop();
        }
        (lines, cursor)
    }

    /// The notice panel: the notice's own lines wrapped to the pane's
    /// inner width inside a bordered box, with the dismissal row last. The
    /// content fits the budget (the borders and the dismissal row are the
    /// fixed three); an overflow names the cap instead of silently
    /// cutting the refusal.
    pub(super) fn render_notice(&self, notice: &str, width: usize, budget: usize) -> Vec<Line> {
        let theme = &self.theme;
        let inner = width.saturating_sub(4).max(1);
        let mut content: Vec<Line> = Vec::new();
        for line in notice.split('\n') {
            if line.trim().is_empty() {
                content.push(vec![]);
                continue;
            }
            content.extend(crate::width::wrap_text(line, inner));
        }
        // The fixed rows: the borders and the dismissal row. The notice's
        // content fits what is left; an overflow names the cap (the marker
        // wraps with the same width, so a narrow pane never overflows the
        // border).
        let cap = budget.saturating_sub(3).max(1);
        if content.len() > cap {
            // One row of room carries the marker alone: a truncated
            // refusal never renders without the indication.
            if cap == 1 {
                content.clear();
            } else {
                content.truncate(cap - 1);
            }
            content.extend(crate::width::wrap_text(
                "… the notice continues — a taller pane shows it whole",
                inner,
            ));
            content.truncate(cap);
        }
        content.push(vec![crate::Span::styled(
            "any key dismisses".to_string(),
            theme.fg_style(ThemeColor::Dim),
        )]);
        let border = |left: &str, right: &str| {
            let row = vec![
                crate::Span::styled(left.to_string(), theme.fg_style(ThemeColor::Dim)),
                crate::Span::styled(
                    "─".repeat(width.saturating_sub(2)),
                    theme.fg_style(ThemeColor::Dim),
                ),
                crate::Span::styled(right.to_string(), theme.fg_style(ThemeColor::Dim)),
            ];
            crate::width::pad_line(row, width)
        };
        let mut panel = Vec::with_capacity(content.len() + 2);
        panel.push(border("┌", "┐"));
        for line in content {
            let mut row = vec![crate::Span::styled(
                "│ ".to_string(),
                theme.fg_style(ThemeColor::Dim),
            )];
            row.extend(line);
            let used: usize = row.iter().map(|s| str_width(&s.content)).sum();
            row.push(crate::Span::raw(" ".repeat(width.saturating_sub(used + 2))));
            row.push(crate::Span::styled(
                " │".to_string(),
                theme.fg_style(ThemeColor::Dim),
            ));
            panel.push(crate::width::pad_line(row, width));
        }
        panel.push(border("└", "┘"));
        panel
    }

    /// The sectioned session list (TS `renderSessionRows`): the rows group
    /// into section blocks behind their headings, and the viewport follows
    /// the selection — the slice centers on the selected row and clips
    /// the overflow behind leading/trailing ellipses, so a roster rebuild
    /// (spawn churn, activity re-sorts) never scrolls the user's position
    /// off-screen. Nested rows (summary rows and expanded subagents)
    /// render inside their top-level agent's section block, and the
    /// headings count top-level agents only (TS `getDisplayRowsForSection`
    /// / `countRowsBySection`).
    pub(super) fn render_list(
        &mut self,
        width: usize,
        max_rows: usize,
        frame_row: usize,
    ) -> Vec<Line> {
        /// One rendered display entry of the sectioned list (TS
        /// `DisplayItem`): the spacer between section blocks, a section
        /// heading, or one row (carrying its `self.rows` index — the
        /// click surface's row identity).
        enum DisplayItem<'a> {
            Spacer,
            Heading(Section),
            Row(usize, &'a AgentsViewRow),
        }
        // The click surface records this render's visible rows; the
        // early exits below leave it empty.
        self.click_rows.clear();
        if max_rows == 0 {
            return Vec::new();
        }
        if self.rows.is_empty() {
            let text = if self.query.trim().is_empty() {
                "No sessions yet."
            } else {
                "No sessions match your search."
            };
            return vec![vec![self.theme.fg(ThemeColor::Dim, text.to_string())]];
        }
        let layout = build_layout(&self.rows, width);
        // The display-item sequence (TS `displayItems`): each non-empty
        // section contributes a spacer (when not first), its heading, then
        // its rows.
        let counts: Vec<(Section, usize)> = [Section::Running, Section::Idle, Section::Inactive]
            .into_iter()
            .map(|section| {
                (
                    section,
                    self.rows
                        .iter()
                        .filter(|row| row.kind == RowKind::Agent && row.section == section)
                        .count(),
                )
            })
            .collect();
        let mut display: Vec<DisplayItem> = Vec::new();
        // While a query is active the list is a ranked picker: one flat,
        // relevance-ordered run of hits (per-row icons carry the status),
        // not status section blocks. Without a query the sectioned
        // layout stays TS-identical.
        if self.query.trim().is_empty() {
            for (section, count) in &counts {
                if *count == 0 {
                    continue;
                }
                if !display.is_empty() {
                    display.push(DisplayItem::Spacer);
                }
                display.push(DisplayItem::Heading(*section));
                let mut include = false;
                for (index, row) in self.rows.iter().enumerate() {
                    if row.depth == 0 {
                        include = row.kind == RowKind::Agent && row.section == *section;
                    }
                    if include {
                        display.push(DisplayItem::Row(index, row));
                    }
                }
            }
        } else {
            display.extend(
                self.rows
                    .iter()
                    .enumerate()
                    .map(|(index, row)| DisplayItem::Row(index, row)),
            );
        }
        // The viewport (TS `renderSessionRows`): reserve the column header
        // and its spacer, center the slice on the selected row, and clip
        // the overflow behind ellipsis lines. The selected row's display
        // index drives the window, so a rebuild that re-sorts the rows
        // keeps the selection on-screen instead of snapping the window
        // back to the top of the list.
        let header_rows = max_rows.saturating_sub(1).min(2);
        let visible_rows = max_rows - header_rows;
        let selected_identity = self
            .rows
            .get(self.selected)
            .map(|row| row.identity.as_str());
        let selected_display_index = display
            .iter()
            .position(
                |item| matches!(item, DisplayItem::Row(_, row) if Some(row.identity.as_str()) == selected_identity),
            )
            .map_or(-1, |index| index as isize);
        let anchor = selected_display_index - (visible_rows / 2) as isize;
        let upper = display.len() as isize - visible_rows as isize;
        let start = anchor.min(upper).max(0) as usize;
        let show_leading = start > 0 && visible_rows > 1;
        let show_trailing = start + visible_rows < display.len() && visible_rows > 2;
        let content_rows = visible_rows - show_leading as usize - show_trailing as usize;
        let slice_start = if selected_display_index >= start as isize + content_rows as isize {
            (selected_display_index + 1 - content_rows as isize) as usize
        } else {
            start
        };
        let slice_end = (slice_start + content_rows).min(display.len());
        let mut lines: Vec<Line> = Vec::with_capacity(content_rows);
        let mut click_rows: Vec<(usize, usize)> = Vec::new();
        for item in &display[slice_start..slice_end] {
            let local = lines.len();
            match item {
                DisplayItem::Spacer => lines.push(Vec::new()),
                DisplayItem::Heading(section) => {
                    let count = counts
                        .iter()
                        .find(|(count_section, _)| count_section == section)
                        .map_or(0, |(_, count)| *count);
                    lines.push(vec![self.theme.fg(
                        ThemeColor::Muted,
                        truncate_text(&format!("{} ({count})", section_title(*section)), width),
                    )]);
                }
                DisplayItem::Row(index, row) => {
                    lines.push(self.render_row(row, &layout, width));
                    click_rows.push((local, *index));
                }
            }
        }
        if show_leading {
            lines.insert(0, vec![self.theme.fg(ThemeColor::Dim, "  ...".to_string())]);
        }
        if show_trailing {
            lines.push(vec![self.theme.fg(ThemeColor::Dim, "  ...".to_string())]);
        }
        if header_rows > 1 {
            lines.insert(0, Vec::new());
        }
        if header_rows > 0 {
            lines.insert(
                0,
                vec![crate::Span::styled(
                    layout.legend,
                    self.theme
                        .fg_style(ThemeColor::Text)
                        .add_modifier(ratatui::style::Modifier::BOLD),
                )],
            );
        }
        // The viewport's front rows (the leading ellipsis and the column
        // legend block) shift the session rows down; the recorded click
        // rows carry the shift with them.
        let shift = header_rows + show_leading as usize;
        self.click_rows = click_rows
            .into_iter()
            .map(|(local, index)| (frame_row + local + shift, index))
            .collect();
        lines
    }

    /// One session row (TS `renderRow`): the summary rows render their
    /// `▸/▾ title` cell over the full width; agent rows render icon, title
    /// (nested rows indented), model, cost/age. The selected row
    /// carries the selection background.
    pub(super) fn render_row(&self, row: &AgentsViewRow, layout: &RowLayout, width: usize) -> Line {
        let theme = &self.theme;
        let selected = Some(row.identity.as_str())
            == self.rows.get(self.selected).map(|r| r.identity.as_str());
        if row.kind == RowKind::SubagentSummary {
            // TS: `formatTableCell(`${indent}${expanded ? "▾" : "▸"} ${title}`, width)`.
            let indent = "  ".repeat(row.depth);
            let marker = if row.expanded { "\u{25be}" } else { "\u{25b8}" };
            let text = format!("{indent}{marker} {}", row.title);
            // BOTH summary lines bill the descendant tree in the Cost
            // column (the operator's 2026-09-26 ask, then the follow-up:
            // an all-done tree renders no running line, so the inactive
            // line — the row the operator actually sees then — carries
            // the same aggregate; TS renders no cost on the summary
            // row): each title spans the Session + Model zone — every
            // row yields its leading cells to the cost column — and the
            // aggregate rides the same right-aligned `${:.2}` cell the
            // agent rows print, leaving the Age column blank behind it.
            if crate::agents_view_forest::is_summary_row_identity(&row.identity) {
                let zone = layout.name_width + 2 + layout.model_width;
                let title = crate::agents_view_state::truncate_text(&text, zone);
                let pad = zone.saturating_sub(str_width(&title));
                let mut line: Line = vec![
                    crate::Span::raw(title),
                    crate::Span::raw(" ".repeat(pad)),
                    crate::Span::styled("  ".to_string(), ratatui::style::Style::default()),
                    theme.fg(
                        ThemeColor::Dim,
                        layout
                            .details
                            .get(&row.identity)
                            .cloned()
                            .unwrap_or_default(),
                    ),
                ];
                line = pad_line(line, width);
                if selected {
                    return theme.selection_paint(line);
                }
                return line;
            }
            let mut line: Line = vec![crate::Span::raw(crate::agents_view_state::truncate_text(
                &text, width,
            ))];
            line = pad_line(line, width);
            if selected {
                return theme.selection_paint(line);
            }
            return line;
        }
        let icon = match row.section {
            Section::Running => ["\u{25c7}", "\u{25c8}", "\u{25c6}", "\u{25c8}"][self.pulse % 4],
            _ => "\u{2022}",
        };
        let icon_color = match row.section {
            Section::Running => ThemeColor::Text,
            Section::Idle => ThemeColor::Warning,
            Section::Inactive => ThemeColor::Dim,
        };
        let icon_style = theme
            .fg_style(icon_color)
            .add_modifier(ratatui::style::Modifier::BOLD);
        // TS `renderRow`: `${"  ".repeat(depth)}${icon} ${title}` padded to
        // the name column, then the model cell, then the dim
        // cost/age details.
        let indent = "  ".repeat(row.depth);
        let indent_width = str_width(&indent);
        let mut line: Line = Vec::new();
        if indent_width > 0 {
            line.push(crate::Span::raw(indent));
        }
        line.push(crate::Span::styled(icon, icon_style));
        line.push(crate::Span::styled(
            " ".to_string(),
            ratatui::style::Style::default(),
        ));
        // TS `formatTableCell(title, nameWidth)`: the name cell (indent +
        // icon + title) clips to the column width, so a long session name
        // can never push the model and cost/age columns
        // off-screen. The icon and its space take the first two cells.
        let title = truncate_text(
            &row.title,
            layout.name_width.saturating_sub(2 + indent_width),
        );
        // Session titles render uniformly (no bold for named sessions);
        // explicit product decision — differs from TS `styleRowTitle`, which
        // bolds explicit session names.
        line.push(crate::Span::styled(
            title.clone(),
            theme.fg_style(ThemeColor::Text),
        ));
        line.push(crate::Span::styled(
            " ".repeat(
                layout
                    .name_width
                    .saturating_sub(str_width(&title) + 2 + indent_width),
            ),
            ratatui::style::Style::default(),
        ));
        line.push(crate::Span::styled(
            "  ".to_string(),
            ratatui::style::Style::default(),
        ));
        line.push(theme.fg(ThemeColor::Muted, cell(&row.model, layout.model_width)));
        line.push(crate::Span::styled(
            "  ".to_string(),
            ratatui::style::Style::default(),
        ));
        let details = layout
            .details
            .get(&row.identity)
            .cloned()
            .unwrap_or_default();
        line.push(theme.fg(ThemeColor::Dim, details));
        if selected {
            line = pad_line(line, width);
            return theme.selection_paint(line);
        }
        line
    }

    /// The bottom hint/status line. `status_override` carries the
    /// notice's first line when the degenerate pane skipped the panel.
    pub(super) fn render_hints(&self, width: usize, status_override: Option<&str>) -> Line {
        let theme = &self.theme;
        if self.exit_armed {
            // TS `renderHints`: the exit hint renders the effective
            // `app.clear` key ("Press Ctrl+C again to exit"); a disabled
            // binding (an empty override) falls back to the plain hint.
            let hint = match self.keybindings.first_key("app.clear") {
                Some(key) => format!(
                    "Press {} again to exit",
                    crate::keybindings::format_key_text(&key)
                ),
                None => "Press again to exit".to_string(),
            };
            return truncate_line(vec![theme.fg(ThemeColor::Muted, hint)], width);
        }
        // The armed stop-or-delete confirm: "Press ctrl+x again to
        // stop|delete" (TS `renderHints`'s delete hint, keyed by the
        // armed row's CURRENT live work — a row that settles between
        // the presses shows the word the confirm now carries).
        if let Some(pending) = &self.pending_delete {
            let stop = self
                .rows
                .iter()
                .find(|row| row.identity == pending.identity)
                .map_or(pending.stop, |row| self.delete_arm_word(row));
            let word = if stop { "stop" } else { "delete" };
            let hint = match self.keybindings.first_key("app.agents.delete") {
                Some(key) => format!(
                    "Press {} again to {word}",
                    crate::keybindings::format_key_text(&key)
                ),
                None => format!("Press again to {word}"),
            };
            return truncate_line(vec![theme.fg(ThemeColor::Muted, hint)], width);
        }
        if let Some(status) = status_override.or(self.status.as_deref()) {
            return truncate_line(vec![theme.fg(ThemeColor::Error, status.to_string())], width);
        }
        // TS `renderHints`: every hint slot renders the effective binding
        // (`keyText`, arrows for up/down/left/right), so a user override
        // moves the hint with the handler. The summary row swaps the open
        // action for expand/collapse (TS `renderHints`'s `rightAction`);
        // the scoped view adds the parent-back hint.
        let right_action = match self.rows.get(self.selected) {
            Some(row) if row.kind == RowKind::SubagentSummary => {
                if row.expanded {
                    "collapse"
                } else {
                    "expand"
                }
            }
            _ => "open",
        };
        // The bar lists every effective action key of the view, so a
        // merged binding can never ship without its slot (the
        // operator's completeness directive). Every segment — including
        // navigate, open, parent, and new — renders its bindings' first
        // effective keys and drops entirely when its action is unbound
        // (the same contract as the jump and stop-or-delete slots; the
        // bar never advertises a default key the handler does not
        // take).
        let first = |id: &str| {
            self.keybindings
                .first_key(id)
                .map(|key| crate::keybindings::format_key_text(&key))
        };
        // A two-key segment keeps whichever of the pair is bound.
        let pair = |a: &str, b: &str| match (first(a), first(b)) {
            (Some(a), Some(b)) => Some(format!("{a}/{b}")),
            (Some(only), None) | (None, Some(only)) => Some(only),
            (None, None) => None,
        };
        let mut segments = Vec::new();
        if let Some(keys) = pair("tui.select.up", "tui.select.down") {
            segments.push(format!("{keys} navigate"));
        }
        // The jump slot shows the first effective key of each edge
        // binding (the full key sets would overflow the one-line hint);
        // an override that empties either binding drops the slot.
        if let (Some(top), Some(bottom)) = (
            self.keybindings.first_key("tui.select.top"),
            self.keybindings.first_key("tui.select.bottom"),
        ) {
            segments.push(format!(
                "{}/{} first/last",
                crate::keybindings::format_key_text(&top),
                crate::keybindings::format_key_text(&bottom)
            ));
        }
        if let Some(keys) = pair("tui.select.confirm", "app.agents.open") {
            segments.push(format!("{keys} {right_action}"));
        }
        // The stop-or-delete slot rides the selected row's arming target
        // and the handler's empty-search gate (the key is inert while a
        // query is active): the word matches what the second press would
        // do, the segment carries every configured key (dispatch takes
        // the whole set), and a row with no target — a summary row, or
        // no selection — or an emptied binding drops the slot instead
        // of advertising a no-op.
        if self.query.is_empty() {
            if let Some(pending) = self.delete_arm_target() {
                let keys = self.keybindings.get_keys("app.agents.delete");
                if !keys.is_empty() {
                    let word = if pending.stop { "stop" } else { "delete" };
                    segments.push(format!(
                        "{} {word}",
                        crate::keybindings::format_key_text(&keys.join("/"))
                    ));
                }
            }
        }
        // The parent key shares the handler's empty-search gate.
        if self.scope_active && self.query.is_empty() {
            if let Some(back) = first("app.agents.back") {
                segments.push(format!("{back} parent"));
            }
        }
        if let Some(new) = first("app.agents.new") {
            segments.push(format!("{new} new"));
        }
        let hints = segments.join("   ");
        truncate_line(vec![theme.fg(ThemeColor::Muted, hints)], width)
    }
}

pub(super) fn cell(value: &str, width: usize) -> String {
    let truncated = truncate_text(value, width);
    format!(
        "{truncated}{}",
        " ".repeat(width.saturating_sub(str_width(&truncated)))
    )
}

pub(super) fn truncate_line(line: Line, width: usize) -> Line {
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    crate::width::wrap_text(&text, width.max(1))
        .into_iter()
        .next()
        .unwrap_or_default()
}

pub(super) enum Renderer {
    Terminal {
        term: ratatui::Terminal<crate::hyperlinks::LinkBackend>,
        /// The `showHardwareCursor` setting snapshot the surface mounted
        /// with (TS constructs the agents-view TUI with the live
        /// `settingsManager.getShowHardwareCursor()`).
        show_hardware_cursor: bool,
    },
    Headless {
        width: u16,
        height: u16,
        frames: Vec<String>,
    },
}

impl Renderer {
    pub(super) fn setup(
        ui: AgentsViewUiMode,
        ui_tx: mpsc::UnboundedSender<UiInput>,
        exit_guard: crate::exit_guard::ExitGuard,
        surface_mounted: &std::sync::Arc<std::sync::atomic::AtomicBool>,
        show_hardware_cursor: bool,
    ) -> Result<Renderer> {
        match ui {
            AgentsViewUiMode::Terminal => {
                crossterm::terminal::enable_raw_mode()?;
                // The terminal state changed: every later setup step is
                // fallible and an error from any of them still owns the
                // release. The flag arms here, not at the end of setup.
                surface_mounted.store(true, std::sync::atomic::Ordering::SeqCst);
                // Adopt the alternate screen the previous surface left in
                // place (TS `pendingAltScreenHandoff`); only the first
                // surface of the process enters it, so a view switch never
                // flashes the primary screen.
                crate::altscreen::enter()?;
                // The enhanced-key modes come up with the raw-mode
                // bracket (TS `ProcessTerminal.start`): pastes arrive as
                // one chunk, the kitty probe runs before the reader
                // thread starts polling.
                crate::enhanced_keys::enable(&mut std::io::stdout())?;
                // The view's rows open on a click (the session surface's
                // mouse grammar): SGR button tracking while the view owns
                // the terminal, released on every exit path.
                crate::mouse_tracking::enable(&mut std::io::stdout())?;
                // One reader thread feeds the view; the reader registry
                // joins the previous surface's reader (the chat it opened)
                // before this one starts polling. The reader also observes
                // Ctrl+C pairs for the exit guard: this thread stays alive
                // when the view loop is wedged in a daemon request, so the
                // force-quit contract holds regardless of loop state.
                crate::input::spawn_terminal_reader(move |event| match event {
                    crossterm::event::Event::Key(key) => {
                        exit_guard.observe_key(&key);
                        // The id door filters the way every session handler
                        // does (`let Some(id) = key_event_to_id(&key)`): kitty
                        // Release events and unmappable keys map to no id, and
                        // a forwarded empty id would run handle_key's "any
                        // other key" arm — clearing the armed exit hint
                        // between the presses of a double Ctrl+C, so the
                        // second press re-arms instead of exiting.
                        let Some(id) = crate::keys::key_event_to_id(&key) else {
                            return true;
                        };
                        ui_tx.send(UiInput::Key(id)).is_ok()
                    }
                    crossterm::event::Event::Mouse(mouse) => {
                        // Mouse reports are consumed even when tracking is
                        // off (terminal noise downstream); an active surface
                        // decodes and dispatches them.
                        let report = crate::mouse_tracking::active()
                            .then(|| crate::mouse::from_crossterm(&mouse))
                            .flatten();
                        match report {
                            Some(event) => ui_tx.send(UiInput::Mouse(event)).is_ok(),
                            None => true,
                        }
                    }
                    crossterm::event::Event::Resize(..) => ui_tx.send(UiInput::Resize).is_ok(),
                    _ => true,
                });
                let terminal = ratatui::Terminal::new(crate::hyperlinks::stdout_backend())?;
                // The adopted buffer still holds the previous view's frame;
                // the first draw repaints the same buffer (a fresh alt
                // screen is already blank). TS paints the new frame
                // straight over the old one, so the clear escape must
                // never reach the pane on its own: queue it with the
                // cursor hide and let the first draw's single flush carry
                // clear + frame together. A separate clear-and-flush here
                // shows a blank pane for the whole render gap — a visible
                // flicker on every surface switch. The cursor hides with
                // the mount (TS `TUI.start` writes hideCursor, never a
                // show): a shown cursor here sits visible at a stale
                // position until the first frame decides the visibility,
                // the exact window the cursor glitch shows in.
                crossterm::queue!(
                    std::io::stdout(),
                    crossterm::terminal::Clear(crossterm::terminal::ClearType::All),
                    crossterm::cursor::Hide
                )?;
                Ok(Renderer::Terminal {
                    term: terminal,
                    show_hardware_cursor,
                })
            }
            AgentsViewUiMode::Headless(plan) => {
                // The click grammar's dispatch gate (the terminal arm's
                // enable records the same state; a headless stdout only
                // records it): a headless run's Click steps drive the same
                // active-tracking branch a terminal's reports take.
                let _ = crate::mouse_tracking::enable(&mut std::io::stdout());
                let steps = plan.steps;
                tokio::spawn(async move {
                    for step in steps {
                        match step {
                            AgentsStep::Type(text) => {
                                for ch in text.chars() {
                                    if ui_tx.send(UiInput::Key(ch.to_string())).is_err() {
                                        return;
                                    }
                                }
                            }
                            AgentsStep::Key(key) => {
                                if ui_tx.send(UiInput::Key(key)).is_err() {
                                    return;
                                }
                            }
                            AgentsStep::WaitSettle { timeout_ms } => {
                                let _ = ui_tx.send(UiInput::Settled);
                                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                            }
                            AgentsStep::WaitRender { needle, timeout_ms } => {
                                if ui_tx
                                    .send(UiInput::WaitRender { needle, timeout_ms })
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            AgentsStep::Click { row, col } => {
                                // The SGR press/release pair a click sends
                                // (the report cells are one-based):
                                // decoded by the same parser the terminal
                                // path feeds.
                                for sequence in [
                                    format!("\x1b[<0;{};{}M", col + 1, row + 1),
                                    format!("\x1b[<0;{};{}m", col + 1, row + 1),
                                ] {
                                    if let Some(event) =
                                        crate::mouse::parse_sgr_mouse_event(&sequence)
                                    {
                                        if ui_tx.send(UiInput::Mouse(event)).is_err() {
                                            return;
                                        }
                                    }
                                }
                            }
                            AgentsStep::Mouse(sequence) => {
                                if let Some(event) = crate::mouse::parse_sgr_mouse_event(&sequence)
                                {
                                    if ui_tx.send(UiInput::Mouse(event)).is_err() {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    let _ = ui_tx.send(UiInput::Done);
                });
                Ok(Renderer::Headless {
                    width: plan.width,
                    height: plan.height,
                    frames: Vec::new(),
                })
            }
        }
    }

    pub(super) fn draw(&mut self, mode: &mut AgentsViewMode) -> Option<(usize, usize)> {
        match self {
            Renderer::Terminal {
                term,
                show_hardware_cursor,
            } => {
                let area = term.size().expect("terminal size");
                let (lines, cursor) = mode.render_frame(area.width as usize, area.height as usize);
                crate::hyperlinks::install_frame(&lines);
                // TS cursor control: the hardware cursor is positioned at
                // the focused caret for IME on every frame, but only shown
                // when `showHardwareCursor` is on (default off). ratatui's
                // `set_cursor_position` shows unconditionally, so only the
                // show case may hand it the caret; the hidden case queues
                // the bare MoveTo after the paint instead (TS positions
                // the caret while the cursor stays hidden).
                let show = *show_hardware_cursor;
                term.draw(|f| {
                    let area = ratatui::layout::Rect::new(0, 0, area.width, area.height);
                    let rendered: Vec<ratatui::text::Line<'static>> =
                        lines.iter().map(crate::markdown::to_ratatui_line).collect();
                    f.render_widget(ratatui::text::Text::from(rendered), area);
                    if show {
                        if let Some((row, col)) = cursor {
                            if row < area.height as usize && col < area.width as usize {
                                f.set_cursor_position(ratatui::layout::Position::new(
                                    col as u16, row as u16,
                                ));
                            }
                        }
                    }
                })
                .expect("draw frame");
                if !show {
                    if let Some((row, col)) = cursor {
                        if row < area.height as usize && col < area.width as usize {
                            // execute! (not queue!): the position write must
                            // flush now — the paint backend's flush already
                            // ran inside `draw`, so a queued write would sit
                            // in the stdout buffer until the next frame.
                            let _ = crossterm::execute!(
                                std::io::stdout(),
                                crossterm::cursor::MoveTo(col as u16, row as u16)
                            );
                        }
                    }
                }
                None
            }
            Renderer::Headless {
                width,
                height,
                frames,
            } => {
                let (lines, _) = mode.render_frame(*width as usize, *height as usize);
                let text = lines
                    .iter()
                    .map(|line| line.iter().map(|s| s.content.as_str()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n");
                if frames.last().map(String::as_str) != Some(text.as_str()) {
                    frames.push(text);
                }
                None
            }
        }
    }

    /// The headless capture's frames (None on a terminal renderer): the
    /// headless plan's render barrier waits on these.
    pub(super) fn headless_frames(&self) -> Option<&[String]> {
        match self {
            Renderer::Headless { frames, .. } => Some(frames),
            Renderer::Terminal { .. } => None,
        }
    }

    /// Teardown. `preserve_alt_screen` mirrors TS `ui.stop({ preserveAltScreen })`:
    /// a handoff to the chat the view just selected keeps the alternate screen
    /// (and raw mode, so the handoff gap cannot echo into the preserved frame)
    /// for the adopting surface, hiding the cursor; a real exit releases the
    /// screen and restores the terminal. `flushFullscreen` stays false either
    /// way (TS agents-view-mode `finish`): the picker frame is never flushed
    /// onto the main screen.
    pub(super) fn finish(self, preserve_alt_screen: bool) -> Vec<String> {
        match self {
            Renderer::Terminal { term, .. } => {
                // ratatui's `Terminal` drop restores the cursor its last
                // frame hid (the `hidden_cursor` flag): run the drop
                // before the handoff's hide so the hide is the final
                // word — TS `stop(preserveAltScreen)` leaves the cursor
                // hidden for the surface taking the screen over. The
                // real-exit arm ends shown for the shell either way.
                drop(term);
                if preserve_alt_screen {
                    // The enhanced-key modes release with the raw-mode
                    // bracket (TS `stop` on every exit, handoffs included).
                    let mut out = std::io::stdout();
                    let _ = crate::enhanced_keys::disable(&mut out);
                    // The adopting surface re-enables tracking through its
                    // own setting; the view never leaves it on.
                    let _ = crate::mouse_tracking::disable(&mut out);
                    let _ = crossterm::execute!(std::io::stdout(), crossterm::cursor::Hide);
                } else {
                    // The one exit restore ends the view's real exit: the
                    // probe standdown, the input drain, the mode releases,
                    // the alt-screen leave, the sync/SGR tail, and the
                    // cooked-tty verification — the same whole-terminal
                    // contract every exit path guarantees. (The view never
                    // flushes its frame: TS agents-view `finish` passes
                    // `flushFullscreen: false`.)
                    crate::exit_restore::restore_terminal();
                }
                Vec::new()
            }
            Renderer::Headless { frames, .. } => frames,
        }
    }
}
