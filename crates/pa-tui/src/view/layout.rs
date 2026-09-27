//! The transcript layout cache and per-frame composition (extracted from
//! `view.rs`: the incremental layout is its own ownership area). The
//! render-loop cost model lives here — see `layout_pass` and
//! `transcript_window` for the streaming-while-long-transcript
//! guarantees (the dogfood CPU-spin fix).

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

/// One chat entry's cached transcript layout: its rendered rows plus the
/// spacing decision they were laid out under (TS keeps every component's
/// rendered lines resident across renders and recomputes only the dynamic
/// conversation-spacing decision; the Rust layout pass stores that
/// decision with the rows, so a settled entry keeps its layout while a
/// tail message streams instead of re-rendering per delta).
#[derive(Debug, Clone)]
pub(super) struct EntryLayout {
    /// The [`AgentView::entry_spacing`] decision the rows render under.
    pub(super) spacing: bool,
    pub(super) rows: std::sync::Arc<RowPack>,
}

/// One packed row's start: its content offset in [`RowPack::blob`] and
/// the index of its first span record.
#[derive(Debug, Clone, Copy)]
struct RowStart {
    offset: u32,
    first: u32,
}

/// One span's packed record: its content length plus the id of its
/// style in [`RowPack::styles`]. The blob offset is not stored — the
/// blob is contiguous, so a row's spans read as running lengths from
/// the row's [`RowStart::offset`] (the tui-scroll-retain2 census: the
/// offset field was structurally redundant, 4 of every 20 record
/// bytes).
#[derive(Debug, Clone, Copy)]
struct PackedSpan {
    len: u32,
    style: u32,
}

/// Packed row storage for one cached layout: the entry's rendered rows
/// as a single content blob plus dense per-span records, expanded
/// byte-exactly on demand.
///
/// The layout cache keeps every visited entry's rows for the process
/// lifetime, and a scroll walk over a large transcript retains hundreds
/// of thousands of fragment-sized spans (the tui-scroll-retain census:
/// a 2600-key walk retained 713k spans holding 9.6MB of text — most of
/// the retained heap was per-span `Vec`/`String` chunk overhead, not
/// text). Packing stores the same rows — the same span boundaries, the
/// same styles, the same content bytes — as one blob plus dense
/// records, and [`RowPack::range`] rebuilds the exact `Vec<Line>` form
/// for any row range, so every consumer (frame composition, selection
/// walks, the exit-flush inline scrollback) sees byte-identical rows:
/// the compaction is storage-only, invisible to every output path.
/// The records stay minimal because every derived field is derived on
/// read: a span's blob offset is the running length from its row's
/// start, and its style is an id into the pack's small table of
/// distinct styles (the styles come from the renderer's fixed palette —
/// the tui-scroll-retain2 census measured at most 6 distinct styles per
/// entry on the canonical fixtures — so the dedup scan stays trivial
/// and the table stays tiny). Each record is 8 bytes (length + style
/// id) against the expanded span's ~40-byte chunk cost and the earlier
/// 20-byte records' redundant offset and inline style.
/// Expansion allocates only the requested range, so a frame inside a
/// huge entry (the transcript's pad row set) pays only its visible rows
/// — the same clones the sliced form always cost per frame.
#[derive(Debug, Clone)]
pub(super) struct RowPack {
    /// Row i's spans are `spans[starts[i].first..starts[i + 1].first]`,
    /// reading content from `starts[i].offset` as running lengths; the
    /// final element is the sentinel end (blob length, span count).
    starts: Vec<RowStart>,
    spans: Vec<PackedSpan>,
    blob: String,
    /// The pack's distinct styles; a record's `style` id indexes this
    /// table, and expansion copies the exact style back out.
    styles: Vec<ratatui::style::Style>,
}

impl RowPack {
    /// Pack freshly rendered rows (byte-exact: boundaries, styles, and
    /// content bytes are preserved; empty spans keep their records), or
    /// `None` when the rows cannot be represented: the records store
    /// `u32` span indices and blob offsets, so a rendered entry whose
    /// span count or content bytes exceed `u32::MAX` is refused rather
    /// than narrowed — wrapped offsets would make [`Self::range`] read
    /// the wrong bytes (or panic slicing the blob off a UTF-8
    /// boundary). Oversized entries simply stay uncached.
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
                // The style id dedups against the pack's few distinct
                // styles (renderer palette-bounded; see the struct
                // docs) — the scan cost is bounded by the palette, not
                // the span count.
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

    /// The number of packed rows.
    pub(super) fn len(&self) -> usize {
        self.starts.len().saturating_sub(1)
    }

    /// Rebuild rows `[from, to)` in the expanded `Vec<Line>` form
    /// (byte-exact to the rows that were packed).
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
    /// The row count (the sparse walk's section lengths).
    pub(super) fn len(&self) -> usize {
        match self {
            EntryRows::Packed(pack) => pack.len(),
            EntryRows::Fresh(rows) => rows.len(),
        }
    }

    /// Whether the section holds no rows (the touch surface's
    /// shows-tail peek skips empty trailing sections).
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
/// rows are constructed only when `transcript_window` visits their range.
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
    /// Whether one chat entry's rows are stable: content that later frames
    /// cannot change (nothing mutates status/user/slash rows once pushed;
    /// an assistant message stops changing when its stream settles; a tool
    /// card stops animating once it holds a final result). Everything else
    /// the rows depend on rides the cache key instead (the spacing
    /// decision) or the cache key (width, detail, render options), so a settled
    /// entry keeps its layout while another message streams — the
    /// transcript-wide "any streaming" exclusion re-rendered every
    /// settled agent message per streaming delta, the dogfood CPU spin.
    pub(super) fn entry_cacheable(&self, entry: &ChatEntry) -> bool {
        match entry {
            ChatEntry::Status { .. }
            | ChatEntry::User { .. }
            | ChatEntry::SlashCommand { .. }
            | ChatEntry::CompactionSummary { .. }
            | ChatEntry::SkillInvocation(_)
            // Spacing-driven rows (agent messages, shell completions, tool
            // cards) lean on the conversation-spacing scan over PRECEDING
            // entries; the scan result is stored with the cached rows, and
            // a preceding entry's mutation propagates through
            // `mark_entry_stale`, so the look-back stays correct without a
            // per-frame re-render.
            | ChatEntry::AgentMessage(_)
            | ChatEntry::ShellCompletion(_)
            | ChatEntry::InjectedPrompt(_)
            | ChatEntry::RefinementOutcome(_)
            | ChatEntry::CustomPanel(_) => true,
            ChatEntry::Assistant(message) => !message.streaming,
            ChatEntry::Tool(card) => !matches!(
                crate::tool_card::panel_status(card),
                crate::tool_card::PanelStatus::Queued | crate::tool_card::PanelStatus::Running
            ),
            // A running bash card animates (the loader spinner frames);
            // a settled one caches like the other spacing-driven rows.
            ChatEntry::BashExecution(card) => !card.running,
        }
    }

    /// The spacing decision [`Self::render_entry`] lays this entry's rows
    /// out under: the leading-blank flags for spacer-driven rows (the
    /// first-entry rule, the conversation-leading scan for agent
    /// messages, shell completions, and tool cards) or the
    /// preceded-by-tool flag for assistant bodies. Every input is
    /// kind-based or a look-back over PRECEDING entries, so the decision
    /// is stable for a settled entry while a tail message streams; the
    /// stored rows go stale with it only through `mark_entry_stale`'s
    /// forward propagation.
    pub(super) fn entry_spacing(
        &self,
        index: usize,
        entry: &ChatEntry,
        first: bool,
        preceded_by_tool_activity: bool,
    ) -> bool {
        match entry {
            // TS `addMessageToChat`: a user submission leads with
            // `Spacer(1)` unless the chat is empty — except the skill
            // invocation's own argument text, which joins the card above
            // it without a spacer.
            ChatEntry::User { .. } => {
                // TS `addMessageToChat`: a user submission leads with
                // `Spacer(1)` unless the chat is empty — except the skill
                // invocation's own argument text, which joins the card
                // above it without a spacer.
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
                self.conversation_leading(index, self.detail.tool_output_expanded())
            }
            // The bash card's own mount rule (TS `Spacer(1)` unless the
            // chat's last child is an agent message, captured on the card
            // when it mounted).
            ChatEntry::BashExecution(card) => !card.suppress_leading_space,
            ChatEntry::Assistant(_) => preceded_by_tool_activity,
            ChatEntry::Status { .. }
            | ChatEntry::InjectedPrompt(_)
            | ChatEntry::RefinementOutcome(_)
            | ChatEntry::CustomPanel(_) => false,
        }
    }

    /// Measure entries through shared count-only render geometry. Exact
    /// heights persist independently of rendered Lines for every detail.
    pub(crate) fn layout_pass(&mut self, width: usize) -> TranscriptLayout {
        self.sparse_enabled = false;
        self.prepare_layout(width);
        let detail = match self.detail {
            crate::chat::Detail::Overview => 0,
            crate::chat::Detail::Details => 1,
            crate::chat::Detail::All => 2,
        };
        // A splash suppressed at the rebuild boundary (a chat that opened
        // directly into content) contributes no rows: the offsets start
        // at the first entry and every scroll/geometry consumer sees the
        // same layout with or without it.
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
            let cacheable = self.entry_cacheable_at(index, entry);
            let cached_height = self.entry_heights[index][detail]
                .filter(|(cached_spacing, _)| cacheable && *cached_spacing == spacing)
                .map(|(_, height)| height);
            let count = cached_height.unwrap_or_else(|| self.count_entry_rows(index, width));
            if cacheable {
                self.entry_heights[index][detail] = Some((spacing, count));
            }
            offsets.push(offsets.last().copied().unwrap_or(0) + count);
            // TS `precededByToolActivity` = the compact set (tool calls,
            // agent messages, bash executions, shell completions).
            preceded_by_tool_activity = self.is_compact_neighbor(entry);
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
    }

    pub(super) fn render_transcript_tail(&self, width: usize) -> Vec<Line> {
        let mut tail: Vec<Line> = Vec::new();
        // In-flight bash output for the current turn renders ABOVE the
        // execution indicator (TS `pendingMessagesContainer` sits between
        // the chat rows and the status area) and flushes into the
        // transcript when the turn settles.
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
        // While the provider retry loop waits, its countdown loader owns
        // the status area (TS `stopWorkingLoader` + `retryLoader`); a
        // compaction run owns it next (TS `startCompactionLoader`); the
        // working loader renders only when neither is active.
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
            // The live streamed-summary block (the operator's "stream
            // the compacted summary" feature): under the loader row, the
            // expanded view renders the summary as the compaction model
            // generates it — one delta at a time — nested on the branch
            // grammar like the expanded summary row that settles it.
            tail.extend(crate::compaction_row::render_compaction_stream(
                compaction,
                self.detail.tool_output_expanded(),
                &self.theme,
                width,
            ));
        } else if let Some(working) = &self.working {
            tail.extend(render_loader(working, self.pulse_frame, &self.theme, width));
        }
        // The side-question pane (TS `sideQuestionContainer`): a scroll-area
        // component under the status area, not a dock row — it hugs the
        // transcript tail, so the frame's slack (a short transcript against
        // a bottom-pinned dock) lands between the pane and the editor like
        // TS, never inside the pane. TS mounts the pane behind a `Spacer(1)`
        // (`sideQuestionContainer.addChild(new Spacer(1))`), so one blank
        // row precedes the component's own leading blank.
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

    /// Materialize only rows intersecting `[start, start + height)`.
    /// `usize::MAX` intentionally requests the whole transcript (inline).
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
            // map (view/click.rs) — bounded by the rows on screen.
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

    /// Append the source rows that fall inside `[start, end)` (absolute
    /// transcript positions starting at `offset`) and return the offset
    /// after the section.
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
    /// range is expanded (a packed entry pays its visible rows, not the
    /// whole row set).
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
}
