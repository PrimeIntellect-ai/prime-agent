//! The render surface: the frame composer (splash, search prompt, sectioned list, hints), the
//! row builders, the notice/list/row renderers, the cell/truncate helpers, and the terminal/
//! headless renderer.
use super::{
    build_layout, mpsc, pad_line, section_title, str_width, truncate_text, AgentsStep,
    AgentsViewMode, AgentsViewRow, AgentsViewUiMode, Composer, Duration, Line, Result, RowKind,
    RowLayout, Section, Theme, ThemeColor, UiInput, Value,
};

impl AgentsViewMode {
    pub(super) fn render_frame(
        &mut self,
        width: usize,
        height: usize,
    ) -> (Vec<Line>, Option<(usize, usize)>) {
        // The frame height feeds the page step (TS reads `ui.terminal.rows` live at key time).
        self.last_height = height;
        let mut lines: Vec<Line> = Vec::new();
        // The splash counts agent-kind rows only — nested subagent and summary rows never
        // inflate the header.
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
        if let Some(root) = &self.scope_root {
            extra_metadata.push(("depth".to_string(), root.child_depth.to_string()));
        }
        let theme = &self.theme;
        let chrome = crate::chrome::ChromeState {
            version: self.options.version.clone(),
            cwd: self.options.cwd.to_string_lossy().to_string(),
            extra_metadata,
            splash_hide_cwd: self.scope_active,
            ..Default::default()
        };
        // `render_splash` already trails one blank row, so the incident notice rides directly
        // under it: the warning line and its pointer stay above the scope label and the prompt.
        lines.extend(crate::chrome::render_splash(&chrome, theme, width));
        lines.extend(self.render_incident_notice(width));
        // The scoped view's back label, dim, over the full width under the splash.
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

        // The prompt's editor mutates its own scroll state, so the theme borrow
        // above ends here and the frame re-borrows it for the list below.
        let (header, prompt_rows, box_cursor) = self.render_prompt(width);
        lines.extend(header);
        let prompt_start = lines.len();
        lines.extend(prompt_rows);
        let cursor = box_cursor.map(|(row, col)| (prompt_start + row, col));
        lines.push(vec![]);

        // The notice panel takes its rows between the list and the hint line. A budget that
        // cannot hold the borders and one content row falls back to the hint-line status.
        let budget = height.saturating_sub(lines.len() + 1);
        // The notice's borrow ends here (render_list below takes the mode mutably).
        let notice_panel = self
            .notice
            .as_deref()
            .filter(|_| budget >= 4)
            .map(|notice| self.render_notice(notice, width, budget));
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

    /// The prompt block: the search composer renders the transparent editor shape
    /// (muted `> ` prefix, dim placeholder); the rename composer renders the real
    /// editor box — the warning header inside it, the draft, the dim placeholder.
    fn render_prompt(&mut self, width: usize) -> (Vec<Line>, Vec<Line>, Option<(usize, usize)>) {
        let theme = &self.theme;
        match &mut self.composer {
            Composer::Search => {
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
                (
                    Vec::new(),
                    vec![prompt],
                    // The cursor caps at the same width the query displays
                    // (`truncate_text` keeps width - 5): a longer query would park the
                    // caret past the last rendered cell, where the frame skips it.
                    Some((0, 4 + str_width(&self.query).min(width.saturating_sub(5)))),
                )
            }
            // The reply composer's real editor box (the rename box's shape): the
            // target's header rides INSIDE the box, the placeholder names the action
            // by the target's state, and an open completion renders its overlay
            // above the box (the chat's stacking).
            Composer::Reply(reply) => {
                let overlay = crate::view::editor_surface::overlay(&reply.editor, theme, width);
                let header = reply.header_line(theme);
                let placeholder = reply.placeholder();
                let surface = crate::view::editor_surface::render(
                    &mut reply.editor,
                    theme,
                    width,
                    u16::try_from(self.last_height).unwrap_or(u16::MAX),
                    Some(header),
                    Some(placeholder),
                );
                (overlay, surface.rows, surface.cursor)
            }
            // The rename composer's real editor box: the warning header rides INSIDE
            // the box, the draft renders through the editor's own surface.
            Composer::Rename(rename) => {
                let header =
                    vec![theme.fg(ThemeColor::Warning, "Rename agent session".to_string())];
                let surface = crate::view::editor_surface::render(
                    &mut rename.editor,
                    theme,
                    width,
                    u16::try_from(self.last_height).unwrap_or(u16::MAX),
                    Some(header),
                    Some("Name this agent session"),
                );
                (Vec::new(), surface.rows, surface.cursor)
            }
        }
    }

    /// The notice panel: the notice's lines wrapped to the pane's inner width inside a bordered
    /// box, with the dismissal row last. An overflow names the cap instead of cutting silently.
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
        // The fixed rows are the borders and the dismissal row; an overflow names the cap (the
        // marker wraps, so a narrow pane never overflows the border).
        let cap = budget.saturating_sub(3).max(1);
        if content.len() > cap {
            // One row of room carries the marker alone: a truncated refusal never renders without
            // the indication.
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

    /// The sectioned session list: the viewport centers the slice on the selected row, so a
    /// roster rebuild never scrolls the user's position off-screen.
    pub(super) fn render_list(
        &mut self,
        width: usize,
        max_rows: usize,
        frame_row: usize,
    ) -> Vec<Line> {
        /// One rendered display entry: the spacer between section blocks, a section heading,
        /// or one row (carrying its `self.rows` index — the click surface's row identity).
        enum DisplayItem<'a> {
            Spacer,
            Heading(Section),
            Row(usize, &'a AgentsViewRow),
        }
        // The click surface records this render's visible rows; the early exits below leave it
        // empty.
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
        // Each non-empty section contributes a spacer (when not first), its heading, then its rows.
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
        // While a query is active the list is a ranked picker: one flat, relevance-ordered run
        // of hits (per-row icons carry the status), not status section blocks.
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
        // The viewport: reserve the column header and its spacer, center the slice on the
        // selected row, clip the overflow — a re-sorting rebuild keeps the selection on-screen.
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
        let content_rows = visible_rows - usize::from(show_leading) - usize::from(show_trailing);
        let slice_start = if selected_display_index >= start as isize + content_rows as isize {
            (selected_display_index + 1 - content_rows as isize) as usize
        } else {
            start
        };
        let slice_end = (slice_start + content_rows).min(display.len());
        // The viewport's front rows shift the session rows down — the click rows and the hover
        // band carry the shift.
        let shift = header_rows + usize::from(show_leading);
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
                    // The row's frame position carries the hover (operator directive
                    // 2026-09-29): the light band rides the row the mouse rests on.
                    let frame_position = frame_row + local + shift;
                    let hovered = self.hover_row == Some(frame_position);
                    lines.push(self.render_row(row, &layout, width, hovered));
                    // Only selectable rows open on a click (a program
                    // row is read-only context).
                    if row.selectable() {
                        click_rows.push((local, *index));
                    }
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
        self.click_rows = click_rows
            .into_iter()
            .map(|(local, index)| (frame_row + local + shift, index))
            .collect();
        // The hover revalidates against THIS frame's rows: a rebuild that moved the rows re-aims
        // the band, and a row that scrolled out clears it.
        if self.hover_row.is_some_and(|row| {
            !self
                .click_rows
                .iter()
                .any(|(click_row, _)| *click_row == row)
        }) {
            self.hover_row = None;
        }
        lines
    }

    /// One session row: summary rows render their `▸/▾ title` cell over the full width; agent
    /// rows render icon, title (nested rows indented), model, cost/age.
    pub(super) fn render_row(
        &self,
        row: &AgentsViewRow,
        layout: &RowLayout,
        width: usize,
        hovered: bool,
    ) -> Line {
        let theme = &self.theme;
        // A muted, truncated program line on the tool-panel background; never selection-painted.
        if row.kind == RowKind::Code {
            let text = format!("{}  {}", "  ".repeat(row.depth), row.title);
            let line = pad_line(
                vec![theme.fg(ThemeColor::Muted, truncate_text(&text, width))],
                width,
            );
            return theme.bg_paint(crate::theme::ThemeBg::ToolPanelBg, line);
        }
        let selected = Some(row.identity.as_str())
            == self.rows.get(self.selected).map(|r| r.identity.as_str());
        if row.kind == RowKind::SubagentSummary {
            let indent = "  ".repeat(row.depth);
            let marker = if row.expanded { "\u{25be}" } else { "\u{25b8}" };
            let text = format!("{indent}{marker} {}", row.title);
            // BOTH summary lines bill the descendant tree in the Cost column (operator directive
            // 2026-09-26: an all-done tree renders no running line, so the inactive line carries
            // the same aggregate; deliberate divergence from TS, which renders no cost there).
            if crate::agents_view_forest::is_summary_row_identity(&row.identity) {
                let zone = layout.name_width + 2 + layout.model_width;
                let title = crate::agents_view_state::truncate_text(&text, zone);
                let pad = zone.saturating_sub(str_width(&title));
                let line: Line = vec![
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
                // The summary rows always pad to the full width; the finish adds the bands.
                let line = pad_line(line, width);
                return finish_session_row(theme, line, selected, hovered, width);
            }
            let line: Line = vec![crate::Span::raw(crate::agents_view_state::truncate_text(
                &text, width,
            ))];
            let line = pad_line(line, width);
            return finish_session_row(theme, line, selected, hovered, width);
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
        // Operator directive (2026-09-29, a sanctioned TS divergence): the
        // row carries its own session's heartbeat count in the dock's `◷`
        // vocabulary — TS renders `♥ N·<countdown>` (error/dim) and rolls
        // descendants' jobs into ancestors; here the count is per-session
        // (the dock's operator scoping), green while any job is active,
        // amber when all are paused.
        let session_id = row
            .summary
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let active_session_id = row.summary.get("activeSessionId").and_then(Value::as_str);
        let jobs: Vec<&crate::heartbeats_picker::HeartbeatJob> = self
            .heartbeats
            .iter()
            .map(|entry| &entry.job)
            .filter(|job| job.in_session(active_session_id, session_id))
            .collect();
        // The badge rides only a name column with room for the row's
        // fixed prefix plus it: a too-narrow column would push the model
        // and cost/age cells right, so the row renders exactly as a
        // badge-less one instead.
        let badge = (!jobs.is_empty())
            .then(|| format!("\u{25f7} {}", jobs.len()))
            .filter(|badge| layout.name_width > 2 + indent_width + str_width(badge));
        let badge_width = badge.as_deref().map_or(0, |badge| str_width(badge) + 1);
        if let Some(badge) = badge {
            let color = if jobs.iter().any(|job| job.is_active()) {
                ThemeColor::Success
            } else {
                ThemeColor::Warning
            };
            line.push(crate::Span::styled(badge, theme.fg_style(color)));
            line.push(crate::Span::styled(
                " ".to_string(),
                ratatui::style::Style::default(),
            ));
        }
        // TS `formatTableCell(title, nameWidth)`: the name cell (indent +
        // icon + badge + title) clips to the column width, so a long
        // session name can never push the model and cost/age columns
        // off-screen. The icon, its space, and the badge take the
        // leading cells.
        let title = truncate_text(
            &row.title,
            layout
                .name_width
                .saturating_sub(2 + indent_width + badge_width),
        );
        // Session titles render uniformly (no bold for named sessions): deliberate divergence
        // from TS `styleRowTitle`, which bolds explicit session names.
        let pad = layout
            .name_width
            .saturating_sub(str_width(&title) + 2 + indent_width + badge_width);
        line.push(crate::Span::styled(title, theme.fg_style(ThemeColor::Text)));
        line.push(crate::Span::raw(" ".repeat(pad)));
        line.push(crate::Span::styled(
            "  ".to_string(),
            ratatui::style::Style::default(),
        ));
        line.push(theme.fg(ThemeColor::Muted, cell(&row.model, layout.model_width)));
        line.push(crate::Span::styled(
            "  ".to_string(),
            ratatui::style::Style::default(),
        ));
        // The remote row's machine label renders in its own column (TS
        // #2516: every remote row names its tailnet connection, and the
        // label is never truncated); local rows render an empty cell so
        // the table stays aligned, like the CLI's conditional host
        // column.
        if layout.host_width > 0 {
            let host_cell = row.host_label.as_deref().unwrap_or("");
            let color = if row
                .host_label
                .as_deref()
                .is_some_and(|label| label.ends_with("(offline)"))
            {
                ThemeColor::Dim
            } else {
                ThemeColor::Muted
            };
            line.push(theme.fg(color, cell(host_cell, layout.host_width)));
            line.push(crate::Span::styled(
                "  ".to_string(),
                ratatui::style::Style::default(),
            ));
        }
        let details = layout
            .details
            .get(&row.identity)
            .cloned()
            .unwrap_or_default();
        line.push(theme.fg(ThemeColor::Dim, details));
        finish_session_row(theme, line, selected, hovered, width)
    }

    /// The bottom hint/status line. `status_override` carries the
    /// notice's first line when the degenerate pane skipped the panel.
    pub(super) fn render_hints(&self, width: usize, status_override: Option<&str>) -> Line {
        let theme = &self.theme;
        // Every slot's effective binding label, hoisted so the branches and the bar slots share
        // one definition.
        let first = |id: &str| {
            self.keybindings
                .first_key(id)
                .map(|key| crate::keybindings::format_key_text(&key))
        };
        if self.exit_armed {
            // The exit hint renders the effective `app.clear` key; a disabled binding falls back
            // to the plain hint.
            let hint = first("app.clear").map_or_else(
                || "Press again to exit".to_string(),
                |key| format!("Press {key} again to exit"),
            );
            return truncate_line(&vec![theme.fg(ThemeColor::Muted, hint)], width);
        }
        // The armed stop-or-delete confirm, keyed by the armed row's CURRENT live work (a row
        // that settles between the presses shows the word the confirm now carries).
        if let Some(pending) = &self.pending_delete {
            let stop = self
                .rows
                .iter()
                .find(|row| row.identity == pending.identity)
                .map_or(pending.stop, Self::delete_arm_word);
            let word = if stop { "stop" } else { "delete" };
            let hint = first("app.agents.delete").map_or_else(
                || format!("Press again to {word}"),
                |key| format!("Press {key} again to {word}"),
            );
            return truncate_line(&vec![theme.fg(ThemeColor::Muted, hint)], width);
        }
        // The status renders in its own tone. `truncate_text` keeps the style:
        // `truncate_line` re-wraps plain text and would strip the span — the tone
        // is the row's whole point (deliberate divergence).
        if let Some(status) = self.status.as_ref() {
            return vec![theme.fg(status.tone().color(), truncate_text(status.text(), width))];
        }
        // The notice fallback (the degenerate pane's refusal line) stays Error.
        if let Some(status) = status_override {
            return vec![theme.fg(ThemeColor::Error, truncate_text(status, width))];
        }
        // The reply composer's hints: the confirm key's word by the target's CURRENT
        // state (steer while it streams, send live, resume & send saved), the queue
        // hint while the draft has text, and cancel over the cancel binding's keys.
        if let Composer::Reply(reply) = &self.composer {
            let current = self.current_reply_summary(&reply.target);
            let live = current
                .get("activeSessionId")
                .and_then(serde_json::Value::as_str)
                .is_some();
            let streaming = live
                && current
                    .get("isStreaming")
                    .and_then(serde_json::Value::as_bool)
                    == Some(true);
            let word = if streaming {
                "steer"
            } else if live {
                "send"
            } else {
                "resume & send"
            };
            let mut hints = vec![format!(
                "{} {word}",
                self.keybindings.key_text("tui.select.confirm")
            )];
            if !reply.editor.get_text().trim().is_empty() {
                hints.push(format!(
                    "{} queue",
                    self.keybindings.key_text("app.message.followUp")
                ));
            }
            hints.push(format!(
                "{} cancel",
                self.keybindings.key_text("tui.select.cancel")
            ));
            let hint = hints.join("   ");
            return truncate_line(&vec![theme.fg(ThemeColor::Muted, hint)], width);
        }
        // The rename composer's hint: save/cancel over the confirm/cancel bindings' every key.
        if let Composer::Rename(_) = &self.composer {
            let hint = format!(
                "{} save   {} cancel",
                self.keybindings.key_text("tui.select.confirm"),
                self.keybindings.key_text("tui.select.cancel")
            );
            return truncate_line(&vec![theme.fg(ThemeColor::Muted, hint)], width);
        }
        // Every hint slot renders the effective binding, so a user override moves the hint with
        // the handler.
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
        // The bar lists every effective action key, so a merged binding can never ship without
        // its slot (the operator's completeness directive); a two-key segment keeps whichever
        // is bound.
        let pair = |a: &str, b: &str| match (first(a), first(b)) {
            (Some(a), Some(b)) => Some(format!("{a}/{b}")),
            (Some(only), None) | (None, Some(only)) => Some(only),
            (None, None) => None,
        };
        let mut segments = Vec::new();
        if let Some(keys) = pair("tui.select.up", "tui.select.down") {
            segments.push(format!("{keys} navigate"));
        }
        // The jump slot shows the first effective key of each edge binding (the full key sets
        // would overflow the hint).
        if let (Some(top), Some(bottom)) = (first("tui.select.top"), first("tui.select.bottom")) {
            segments.push(format!("{top}/{bottom} first/last"));
        }
        if let Some(keys) = pair("tui.select.confirm", "app.agents.open") {
            segments.push(format!("{keys} {right_action}"));
        }
        // The rename, stop-or-delete, program, and parent hints only show with an empty search
        // and a target.
        if self.query.is_empty() {
            // The multi-key slots render every configured key (dispatch
            // takes the whole set).
            let all =
                |id: &str| Some(self.keybindings.key_text(id)).filter(|keys| !keys.is_empty());
            if let Some(keys) = all("app.agents.rename").filter(|_| self.rename_target().is_some())
            {
                segments.push(format!("{keys} rename"));
            }
            // The reply slot (the operator's completeness directive: TS shows none,
            // so the space arm would be undiscoverable): only while the selected row
            // is replyable.
            if let Some(keys) = all("app.agents.reply").filter(|_| self.reply_target().is_some()) {
                segments.push(format!("{keys} reply"));
            }
            if let Some(pending) = self.delete_arm_target() {
                if let Some(keys) = all("app.agents.delete") {
                    let word = if pending.stop { "stop" } else { "delete" };
                    segments.push(format!("{keys} {word}"));
                }
            }
            if self
                .program_target()
                .is_some_and(|summary| summary.has_spawn_code)
            {
                if let Some(keys) = all("app.agents.program") {
                    segments.push(format!("{keys} program"));
                }
            }
            if self.scope_active {
                if let Some(back) = first("app.agents.back") {
                    segments.push(format!("{back} parent"));
                }
            }
        }
        if let Some(new) = first("app.agents.new") {
            segments.push(format!("{new} new"));
        }
        let hints = segments.join("   ");
        truncate_line(&vec![theme.fg(ThemeColor::Muted, hints)], width)
    }
}

/// One session row's affordance finish (operator directive 2026-09-29): the selected row keeps
/// the ONE selection band; a hovered unselected row gains the ONE light hover band — the same
/// color the selection paints (distinguish by cue, never by color).
pub(super) fn finish_session_row(
    theme: &Theme,
    mut line: Line,
    selected: bool,
    hovered: bool,
    width: usize,
) -> Line {
    if selected {
        return theme.selection_paint(pad_line(line, width));
    }
    if hovered {
        line = pad_line(line, width);
        theme.paint_hover_band(&mut line, 0..width);
    }
    line
}

pub(super) fn cell(value: &str, width: usize) -> String {
    let truncated = truncate_text(value, width);
    format!(
        "{truncated}{}",
        " ".repeat(width.saturating_sub(str_width(&truncated)))
    )
}

pub(super) fn truncate_line(line: &Line, width: usize) -> Line {
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    crate::width::wrap_text(&text, width.max(1))
        .into_iter()
        .next()
        .unwrap_or_default()
}

pub(super) enum Renderer {
    Terminal {
        term: ratatui::Terminal<crate::hyperlinks::LinkBackend>,
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
                // The raw-mode bracket's `cfmakeraw` write clears IXON, the kernel's one
                // trigger for lifting a pending Ctrl+S stop (see the flow e2e's launch route).
                crossterm::terminal::enable_raw_mode()?;
                // The terminal state changed: every later setup step is fallible and still owns
                // the release — the flag arms here, not at the end of setup.
                surface_mounted.store(true, std::sync::atomic::Ordering::SeqCst);
                // Adopt the alternate screen the previous surface left in place: only the first
                // surface of the process enters it, so a view switch never flashes the primary
                // screen.
                crate::altscreen::enter()?;
                // The enhanced-key modes come up with the raw-mode bracket: pastes arrive as one
                // chunk, the kitty probe runs before the reader starts polling.
                crate::enhanced_keys::enable(&mut std::io::stdout())?;
                // SGR button tracking while the view owns the terminal, released on every exit
                // path.
                crate::mouse_tracking::enable(&mut std::io::stdout())?;
                // One reader thread feeds the view; the registry joins the previous surface's
                // reader before this one starts polling. The reader also observes Ctrl+C pairs:
                // it stays alive when the view loop is wedged in a daemon request, so the
                // force-quit contract holds.
                // The paste-aware variant (the session surface's reader):
                // a marker-less multi-line keystroke burst coalesces into
                // one paste — Enter submits in the composers, so a burst
                // typed line by line would submit per line.
                crate::input::spawn_paste_aware_reader(move |input| match input {
                    crate::input::ReaderInput::BurstPaste(text) => {
                        ui_tx.send(UiInput::Paste(text)).is_ok()
                    }
                    // A guard-reassembled report: consumed unless tracking is active,
                    // the same contract as the terminal's own mouse events below.
                    crate::input::ReaderInput::Mouse(report) => {
                        if crate::mouse_tracking::active() {
                            ui_tx.send(UiInput::Mouse(report)).is_ok()
                        } else {
                            true
                        }
                    }
                    crate::input::ReaderInput::Event(event) => match event {
                        crossterm::event::Event::Key(key) => {
                            exit_guard.observe_key(&key);
                            // The id door filters as every session handler does: a forwarded
                            // empty id would run handle_key's "any other key" arm — clearing
                            // the armed exit hint between the presses of a double Ctrl+C.
                            let Some(id) = crate::keys::key_event_to_id(&key) else {
                                return true;
                            };
                            ui_tx.send(UiInput::Key(id)).is_ok()
                        }
                        crossterm::event::Event::Paste(text) => {
                            ui_tx.send(UiInput::Paste(text)).is_ok()
                        }
                        crossterm::event::Event::Mouse(mouse) => {
                            // Mouse reports are consumed even when tracking is off; an active
                            // surface decodes and dispatches them.
                            let report = crate::mouse_tracking::active()
                                .then(|| crate::mouse::from_crossterm(mouse))
                                .flatten();
                            match report {
                                Some(event) => ui_tx.send(UiInput::Mouse(event)).is_ok(),
                                None => true,
                            }
                        }
                        crossterm::event::Event::Resize(..) => ui_tx.send(UiInput::Resize).is_ok(),
                        _ => true,
                    },
                });
                let terminal = ratatui::Terminal::new(crate::hyperlinks::stdout_backend())?;
                // The adopted buffer still holds the previous view's frame: queue the clear escape
                // with the cursor hide so the first draw's single flush carries clear + frame
                // together (a separate clear-and-flush shows a blank pane for the whole
                // render gap).
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
                // The click grammar's dispatch gate: a headless run's Click steps drive the same
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
                                // The SGR press/release pair a click sends (one-based report
                                // cells), decoded by the same parser the terminal path feeds.
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
                // ratatui's `set_cursor_position` shows unconditionally, so only the show case may
                // hand it the caret; the hidden case queues the bare MoveTo after the paint.
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
                            // execute! (not queue!): the paint's flush already ran inside `draw`,
                            // so a queued write would sit in the stdout buffer until the next
                            // frame.
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

    /// Teardown. `preserve_alt_screen` mirrors TS `ui.stop({ preserveAltScreen })`: a handoff to
    /// the chat keeps the alternate screen (and raw mode), hiding the cursor; a real exit
    /// releases the screen. The frame never flushes onto the main screen (TS
    /// `flushFullscreen: false`).
    pub(super) fn finish(self, preserve_alt_screen: bool) -> Vec<String> {
        match self {
            Renderer::Terminal { term, .. } => {
                // ratatui's `Terminal` drop restores the cursor its last frame hid: run the drop
                // before the handoff's hide so the hide is the final word.
                drop(term);
                // The input reader stands down before the pane is handed on: a parked reader would
                // hold crossterm's global event-reader lock indefinitely — the wake exits it now.
                crate::input::request_reader_stop();
                if preserve_alt_screen {
                    // The enhanced-key modes release with the raw-mode bracket on every exit,
                    // handoffs included.
                    let mut out = std::io::stdout();
                    let _ = crate::enhanced_keys::disable(&mut out);
                    // The adopting surface re-enables tracking through its own setting; the view
                    // never leaves it on.
                    let _ = crate::mouse_tracking::disable(&mut out);
                    let _ = crossterm::execute!(std::io::stdout(), crossterm::cursor::Hide);
                } else {
                    // The one exit restore ends the view's real exit — the same whole-terminal
                    // contract every exit path guarantees (the frame never flushes).
                    crate::exit_restore::restore_terminal();
                }
                Vec::new()
            }
            Renderer::Headless { frames, .. } => frames,
        }
    }
}
