//! The transcript layout cache and per-frame composition. The
//! render-loop cost model lives here (`layout_pass`,
//! `transcript_window`).

use super::AgentView;
use crate::chat::{render_loader, ChatEntry};
use crate::chrome::render_splash;
use crate::Line;

#[cfg(test)]
thread_local! {
    pub(super) static ENTRY_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(super) static ENTRY_RENDERS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;

/// One chat entry's cached layout: its rendered rows plus the spacing
/// decision they were laid out under.
#[derive(Debug, Clone)]
pub(super) struct EntryLayout {
    /// The spacing decision the rows render under.
    pub(super) spacing: bool,
    pub(super) rows: std::sync::Arc<RowPack>,
}

/// One packed row's start: its content blob offset and first span
/// record.
#[derive(Debug, Clone, Copy)]
struct RowStart {
    offset: u32,
    first: u32,
}

/// One span's packed record: content length plus style id. The blob offset is not stored — spans
/// read as running lengths from the row's [`RowStart::offset`].
#[derive(Debug, Clone, Copy)]
struct PackedSpan {
    len: u32,
    style: u32,
}

/// Packed row storage for one cached layout: the entry's rendered rows as a single content blob
/// plus dense per-span records, expanded byte-exactly on demand — the cache keeps every visited
/// entry's rows for the process lifetime, so rows store packed.
#[derive(Debug, Clone)]
pub(super) struct RowPack {
    /// Row i's spans are `spans[starts[i].first..starts[i + 1].first]`,
    /// reading content from `starts[i].offset`; the final element is the
    /// sentinel end.
    starts: Vec<RowStart>,
    spans: Vec<PackedSpan>,
    blob: String,
    /// The pack's distinct styles (`style` ids index this table).
    styles: Vec<ratatui::style::Style>,
}

impl RowPack {
    /// Pack freshly rendered rows (byte-exact), or `None` when the rows
    /// cannot be represented as `u32` offsets — oversized entries stay
    /// uncached.
    pub(super) fn pack(rows: &[Line]) -> Option<Self> {
        let span_count: usize = rows.iter().map(Line::len).sum();
        let content_bytes: usize = rows
            .iter()
            .flat_map(|line| line.iter())
            .map(|span| span.content.len())
            .sum();
        if span_count > u32::MAX as usize || content_bytes > u32::MAX as usize {
            return None;
        }
        let mut starts = Vec::with_capacity(rows.len() + 1);
        let mut spans = Vec::with_capacity(span_count);
        let mut blob = String::with_capacity(content_bytes);
        let mut styles: Vec<ratatui::style::Style> = Vec::new();
        for line in rows {
            starts.push(RowStart {
                offset: blob.len() as u32,
                first: spans.len() as u32,
            });
            for span in line {
                // The style dedup scan is bounded by the renderer
                // palette, not the span count.
                let style = if let Some(id) = styles.iter().position(|style| *style == span.style) {
                    id
                } else {
                    styles.push(span.style);
                    styles.len() - 1
                } as u32;
                spans.push(PackedSpan {
                    len: span.content.len() as u32,
                    style,
                });
                blob.push_str(&span.content);
            }
        }
        starts.push(RowStart {
            offset: blob.len() as u32,
            first: spans.len() as u32,
        });
        Some(Self {
            starts,
            spans,
            blob,
            styles,
        })
    }

    pub(super) fn len(&self) -> usize {
        self.starts.len().saturating_sub(1)
    }

    /// Rebuild rows `[from, to)` byte-exact to the rows that were
    /// packed.
    pub(super) fn range(&self, from: usize, to: usize) -> Vec<Line> {
        let rows = self.len();
        let from = from.min(rows);
        let to = to.min(rows);
        let mut expanded = Vec::with_capacity(to.saturating_sub(from));
        for row in from..to {
            let start = self.starts[row];
            let end = self.starts[row + 1].first as usize;
            let first = start.first as usize;
            let mut offset = start.offset as usize;
            let mut line = Vec::with_capacity(end - first);
            for packed in &self.spans[first..end] {
                let content = &self.blob[offset..offset + packed.len as usize];
                line.push(crate::Span {
                    style: self.styles[packed.style as usize],
                    content: content.to_string(),
                });
                offset += packed.len as usize;
            }
            expanded.push(line);
        }
        expanded
    }
}

/// One entry's readable rows: a cacheable entry's packed storage or a
/// transient entry's freshly rendered rows (never stored).
#[derive(Debug, Clone)]
pub(super) enum EntryRows {
    Packed(std::sync::Arc<RowPack>),
    Fresh(std::sync::Arc<Vec<Line>>),
}

impl EntryRows {
    pub(super) fn len(&self) -> usize {
        match self {
            EntryRows::Packed(pack) => pack.len(),
            EntryRows::Fresh(rows) => rows.len(),
        }
    }

    /// Whether the section holds no rows (the shows-tail peek skips
    /// empty trailing sections).
    pub(super) fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Rows `[from, to)` in the expanded `Vec<Line>` form.
    pub(super) fn range(&self, from: usize, to: usize) -> Vec<Line> {
        match self {
            EntryRows::Packed(pack) => pack.range(from, to),
            EntryRows::Fresh(rows) => {
                let from = from.min(rows.len());
                let to = to.min(rows.len());
                rows[from..to].to_vec()
            }
        }
    }
}

/// Exact transcript geometry plus the small splash/status surfaces. Entry
/// rows are constructed only when `transcript_window` visits them.
pub(crate) struct TranscriptLayout {
    pub(super) splash: Vec<Line>,
    /// Absolute row starts, including the end sentinel.
    offsets: Vec<usize>,
    pub(super) tail: Vec<Line>,
    pub(super) total: usize,
}

impl TranscriptLayout {
    pub(super) fn cursor_at(&self, row: usize) -> (usize, usize) {
        if row < self.splash.len() {
            return (0, row);
        }
        let index = self
            .offsets
            .partition_point(|offset| *offset <= row)
            .saturating_sub(1);
        (index + 1, row.saturating_sub(self.offsets[index]))
    }
}

impl AgentView {
    /// Whether one chat entry's rows are stable: content that later frames cannot change (an
    /// assistant settles with its stream; a tool card with a final result, except a still-running
    /// background shell). Everything else rides the cache key.
    pub(super) fn entry_cacheable(entry: &ChatEntry) -> bool {
        match entry {
            ChatEntry::Status { .. }
            | ChatEntry::User { .. }
            | ChatEntry::SlashCommand { .. }
            | ChatEntry::CompactionSummary { .. }
            | ChatEntry::SkillInvocation(_)
            // Spacing-driven rows lean on the scan over PRECEDING entries; a preceding mutation
            // propagates through `mark_entry_stale`.
            | ChatEntry::AgentMessage(_)
            | ChatEntry::ShellCompletion(_)
            | ChatEntry::InjectedPrompt(_)
            | ChatEntry::RefinementOutcome(_)
            | ChatEntry::CustomPanel(_) => true,
            ChatEntry::Assistant(message) => !message.streaming,
            ChatEntry::Tool(card) => {
                !matches!(
                    crate::tool_card::panel_status(card),
                    crate::tool_card::PanelStatus::Queued | crate::tool_card::PanelStatus::Running
                ) && !crate::tool_card::ipython::background_shell_running(card)
            }
            // A running bash card animates; a settled one caches.
            ChatEntry::BashExecution(card) => !card.running,
        }
    }

    /// The spacing decision [`Self::render_entry`] lays this entry's rows out under: leading-blank
    /// flags for spacer-driven rows, or the preceded-by-tool flag for assistant bodies.
    pub(super) fn entry_spacing(
        &self,
        index: usize,
        entry: &ChatEntry,
        first: bool,
        preceded_by_tool_activity: bool,
    ) -> bool {
        match entry {
            // TS `addMessageToChat`: a user submission leads with `Spacer(1)` unless the chat is
            // empty.
            ChatEntry::User { .. } => {
                let follows_skill_card = index > 0
                    && matches!(
                        self.chat.get(index - 1),
                        Some(ChatEntry::SkillInvocation(_))
                    );
                !first && !follows_skill_card
            }
            ChatEntry::SkillInvocation(_)
            | ChatEntry::SlashCommand { .. }
            | ChatEntry::CompactionSummary { .. } => !first,
            ChatEntry::AgentMessage(_) | ChatEntry::ShellCompletion(_) | ChatEntry::Tool(_) => {
                self.conversation_leading(index, self.entry_detail(index).tool_output_expanded())
            }
            // The bash card's own mount rule (TS `Spacer(1)` unless the
            // chat's last child is an agent message).
            ChatEntry::BashExecution(card) => !card.suppress_leading_space,
            ChatEntry::Assistant(_) => preceded_by_tool_activity,
            ChatEntry::Status { .. }
            | ChatEntry::InjectedPrompt(_)
            | ChatEntry::RefinementOutcome(_)
            | ChatEntry::CustomPanel(_) => false,
        }
    }

    /// Measure entries through shared count-only render geometry.
    pub(crate) fn layout_pass(&mut self, width: usize) -> TranscriptLayout {
        self.sparse_enabled = false;
        self.prepare_layout(width);
        let detail = match self.detail {
            crate::chat::Detail::Overview => 0,
            crate::chat::Detail::Details => 1,
            crate::chat::Detail::All => 2,
        };
        // A suppressed splash contributes no rows: the offsets start at
        // the first entry.
        let splash = if self.splash_suppressed {
            Vec::new()
        } else {
            render_splash(&self.chrome, &self.theme, width)
        };
        let mut offsets = Vec::with_capacity(self.chat.len() + 1);
        offsets.push(splash.len());
        let mut first = true;
        let mut preceded_by_tool_activity = false;
        for (index, entry) in self.chat.iter().enumerate() {
            let spacing = self.entry_spacing(index, entry, first, preceded_by_tool_activity);
            let cacheable = Self::entry_cacheable(entry);
            let cached_height = self.entry_heights[index][detail]
                .filter(|(cached_spacing, _)| cacheable && *cached_spacing == spacing)
                .map(|(_, height)| height);
            let count = cached_height.unwrap_or_else(|| self.count_entry_rows(index, width));
            if cacheable {
                self.entry_heights[index][detail] = Some((spacing, count));
            }
            offsets.push(offsets.last().copied().unwrap_or(0) + count);
            // TS `precededByToolActivity` = the compact set.
            preceded_by_tool_activity = Self::is_compact_neighbor(entry);
            first = false;
        }
        let tail = self.render_transcript_tail(width);
        let total = offsets.last().copied().unwrap_or(splash.len()) + tail.len();
        TranscriptLayout {
            splash,
            offsets,
            tail,
            total,
        }
    }

    pub(super) fn prepare_layout(&mut self, width: usize) {
        if let (Some(working), Some(since)) = (&mut self.working, self.working_since) {
            working.elapsed_secs = since.elapsed().as_secs();
        }
        let options = (
            self.theme.clone(),
            self.code_block_indent.clone(),
            self.show_images,
            crate::image_component::fullscreen_image_fallback_active(),
        );
        if self.layout_width != width || self.layout_options.as_ref() != Some(&options) {
            self.entry_heights.clear();
            self.layout_width = width;
            self.layout_options = Some(options);
            if self.sparse_enabled {
                for index in &self.sparse_entries {
                    self.entry_layout[*index] = [None, None, None];
                }
                self.sparse_entries.clear();
            } else {
                self.entry_layout
                    .iter_mut()
                    .for_each(|slot| *slot = [None, None, None]);
            }
            self.md_caches.borrow_mut().clear();
        }
        self.entry_layout
            .resize_with(self.chat.len(), || [None, None, None]);
        self.entry_heights
            .resize(self.chat.len(), [None, None, None]);
        self.seed_pending_handoff();
    }

    pub(super) fn render_transcript_tail(&self, width: usize) -> Vec<Line> {
        let mut tail: Vec<Line> = Vec::new();
        // In-flight bash output renders ABOVE the execution indicator and
        // flushes into the transcript when the turn settles.
        if !self.pending_bash.is_empty() {
            // TS `keyText("tui.select.cancel")`: every key of the
            // binding joins the hint ("Esc/Ctrl+C").
            let cancel_hint = self.editor.keybindings().key_text("tui.select.cancel");
            for card in &self.pending_bash {
                tail.push(Vec::new());
                tail.extend(crate::bash_card::render_bash_execution(
                    card,
                    self.pulse_frame,
                    self.detail.tool_output_expanded(),
                    &cancel_hint,
                    &self.theme,
                    width,
                ));
            }
        }
        // The retry loader owns the status area, a compaction run next;
        // the working loader renders only when neither is active.
        if let Some(retry) = &self.retry {
            tail.extend(crate::chat::render_retry(
                retry,
                self.pulse_frame,
                &self.theme,
                width,
            ));
        } else if let Some(compaction) = &self.compaction {
            let cancel_hint = self
                .editor
                .keybindings()
                .first_key("app.clear")
                .map_or_else(
                    || "Ctrl+C".to_string(),
                    |key| crate::keybindings::format_key_text(&key),
                );
            tail.extend(crate::compaction_row::render_compaction_loader(
                compaction,
                self.pulse_frame,
                &cancel_hint,
                &self.theme,
                width,
            ));
            // The live streamed-summary block (the operator's "stream the compacted summary"
            // feature): the expanded view renders it under the loader row.
            tail.extend(crate::compaction_row::render_compaction_stream(
                compaction,
                self.detail.tool_output_expanded(),
                &self.theme,
                width,
            ));
        } else if let Some(working) = &self.working {
            tail.extend(render_loader(working, self.pulse_frame, &self.theme, width));
        }
        // The side-question pane hugs the transcript tail, not the dock, so the frame's slack
        // lands between the pane and the editor (TS mounts it behind a `Spacer(1)`).
        if let Some(pane) = &self.side_pane {
            tail.push(Vec::new());
            tail.extend(pane.render(
                &self.theme,
                self.pulse_frame,
                self.detail.tool_output_expanded(),
                &self.editor.keybindings().key_text("tui.select.cancel"),
                width,
            ));
        }
        tail
    }

    /// Materialize only rows intersecting `[start, start + height)`;
    /// `usize::MAX` requests the whole transcript (inline).
    pub(crate) fn transcript_window(
        &mut self,
        layout: &TranscriptLayout,
        start: usize,
        height: usize,
    ) -> Vec<Line> {
        let end = start.saturating_add(height);
        let mut rows: Vec<Line> = Vec::new();
        Self::slice_rows(&layout.splash, &mut rows, 0, start, end);
        let first = layout
            .offsets
            .partition_point(|offset| *offset <= start)
            .saturating_sub(1);
        for index in first..self.chat.len() {
            let offset = layout.offsets[index];
            if offset >= end {
                break;
            }
            let source = self.sparse_entry_rows(index, self.layout_width);
            let from = rows.len();
            Self::slice_entry_rows(&source, &mut rows, offset, start, end);
            // The entry's visible span feeds the click surface's window
            // map — bounded by the rows on screen.
            if from < rows.len() {
                self.click.record_window_section(index, from, rows.len());
            }
        }
        Self::slice_rows(
            &layout.tail,
            &mut rows,
            layout
                .offsets
                .last()
                .copied()
                .unwrap_or(layout.splash.len()),
            start,
            end,
        );
        rows
    }

    /// Append the source rows inside `[start, end)` (absolute positions
    /// from `offset`); return the offset after the section.
    fn slice_rows(
        source: &[Line],
        out: &mut Vec<Line>,
        offset: usize,
        start: usize,
        end: usize,
    ) -> usize {
        let from = start.saturating_sub(offset).min(source.len());
        let to = end.saturating_sub(offset).min(source.len());
        if from < to {
            out.extend_from_slice(&source[from..to]);
        }
        offset + source.len()
    }

    /// [`Self::slice_rows`] for one entry's rows: only the intersecting
    /// range is expanded.
    fn slice_entry_rows(
        source: &EntryRows,
        out: &mut Vec<Line>,
        offset: usize,
        start: usize,
        end: usize,
    ) -> usize {
        let from = start.saturating_sub(offset).min(source.len());
        let to = end.saturating_sub(offset).min(source.len());
        if from < to {
            out.extend(source.range(from, to));
        }
        offset + source.len()
    }
    /// The cross-view layout handoff's seed (see `view::handoff`): a matching handoff places its
    /// packs into the layout cache; a mismatch drops the packs.
    fn seed_pending_handoff(&mut self) {
        let Some(handoff) = self.pending_handoff.take() else {
            return;
        };
        let (width, options) = match self.layout_options.as_ref() {
            // The branch above left the layout state equal to this
            // draw's shape, so the packs validate against it.
            Some(options) => (self.layout_width, options),
            None => return,
        };
        if handoff.shape.0 != width || &handoff.shape.1 != options {
            // A shape-mismatched handoff drops its packs: the
            // served-path observable must NOT count it.
            return;
        }
        let mut seeded = 0usize;
        for (index, slots) in handoff.packs {
            let Some(target) = self.entry_layout.get_mut(index) else {
                continue;
            };
            for (detail, slot) in slots.into_iter().enumerate() {
                if slot.is_some() {
                    target[detail] = slot;
                    seeded += 1;
                    self.sparse_entries.insert(index);
                }
            }
        }
        if seeded > 0 {
            self.handoff_seeds = self.handoff_seeds.saturating_add(1);
        }
    }
}
