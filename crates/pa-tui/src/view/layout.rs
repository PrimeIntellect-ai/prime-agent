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
    pub(super) rows: std::sync::Arc<Vec<Line>>,
}

/// One transcript layout pass's output ([`AgentView::layout_pass`]): the
/// splash rows, the per-entry row offsets (no clones — the window
/// composition slices the cached layouts), the fresh rows of entries that
/// could not be cached (streaming messages, queued/running tool cards),
/// the status-area tail, and the whole transcript's row count.
pub(crate) struct TranscriptLayout {
    splash: Vec<Line>,
    /// Absolute row starts, including the end sentinel.
    offsets: Vec<usize>,
    fresh: std::collections::HashMap<usize, Vec<Line>>,
    tail: Vec<Line>,
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
            ChatEntry::Status { .. } | ChatEntry::User { .. } => true,
            ChatEntry::SlashCommand { .. } | ChatEntry::SlashCommandResult { .. } => true,
            ChatEntry::CompactionSummary { .. } => true,
            ChatEntry::SkillInvocation(_) => true,
            // Spacing-driven rows (agent messages, shell completions, tool
            // cards) lean on the conversation-spacing scan over PRECEDING
            // entries; the scan result is stored with the cached rows, and
            // a preceding entry's mutation propagates through
            // `mark_entry_stale`, so the look-back stays correct without a
            // per-frame re-render.
            ChatEntry::AgentMessage(_) | ChatEntry::ShellCompletion(_) => true,
            ChatEntry::InjectedPrompt(_) | ChatEntry::RefinementOutcome(_) => true,
            ChatEntry::CustomPanel(_) => true,
            ChatEntry::ClientMarkdown { .. }
            | ChatEntry::ClientText { .. }
            | ChatEntry::ChangelogPanel { .. } => true,
            ChatEntry::Assistant(message) => !message.streaming,
            ChatEntry::Tool(card) => !matches!(
                crate::tool_card::panel_status(card),
                crate::tool_card::PanelStatus::Queued | crate::tool_card::PanelStatus::Running
            ),
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
            ChatEntry::Assistant(_) => preceded_by_tool_activity,
            ChatEntry::Status { .. }
            | ChatEntry::SlashCommandResult { .. }
            | ChatEntry::InjectedPrompt(_)
            | ChatEntry::RefinementOutcome(_)
            | ChatEntry::CustomPanel(_)
            | ChatEntry::ClientMarkdown { .. }
            | ChatEntry::ClientText { .. }
            | ChatEntry::ChangelogPanel { .. } => false,
        }
    }

    /// One transcript layout pass over the splash, the chat entries, and
    /// the status-area tail (the shortcut guide plus whichever loader owns
    /// the status area). Settled entries keep their cached layout keyed by
    /// the spacing decision; dirty or still-animating entries render
    /// fresh. The pass COUNTS every entry's rows without cloning them —
    /// the scroll-window composition (`transcript_window`) slices the
    /// cached rows later, so a frame clones only the visible window (the
    /// pre-fix pass deep-cloned every cached row of the whole transcript
    /// on every render, the dogfood render-loop spin).
    pub(crate) fn layout_pass(&mut self, width: usize) -> TranscriptLayout {
        self.sparse_enabled = false;
        self.prepare_layout(width);
        let detail = match self.detail {
            crate::chat::Detail::Overview => 0,
            crate::chat::Detail::Details => 1,
            crate::chat::Detail::All => 2,
        };
        let splash = render_splash(&self.chrome, &self.theme, width);
        let mut offsets = Vec::with_capacity(self.chat.len() + 1);
        offsets.push(splash.len());
        let mut fresh: std::collections::HashMap<usize, Vec<Line>> =
            std::collections::HashMap::new();
        let mut first = true;
        let mut preceded_by_tool_activity = false;
        for (index, entry) in self.chat.iter().enumerate() {
            let spacing = self.entry_spacing(index, entry, first, preceded_by_tool_activity);
            let cacheable = self.entry_cacheable(entry);
            let hit = self.entry_layout[index][detail]
                .as_ref()
                .is_some_and(|slot| slot.spacing == spacing);
            if cacheable && hit {
                offsets.push(
                    offsets.last().copied().unwrap_or(0)
                        + self.entry_layout[index][detail]
                            .as_ref()
                            .map(|slot| slot.rows.len())
                            .unwrap_or(0),
                );
            } else {
                let rows = self.render_entry(index, entry, width, first, preceded_by_tool_activity);
                offsets.push(offsets.last().copied().unwrap_or(0) + rows.len());
                if cacheable {
                    self.entry_layout[index][detail] = Some(EntryLayout {
                        spacing,
                        rows: std::sync::Arc::new(rows),
                    });
                } else {
                    // Still animating (streaming message, queued/running
                    // tool card): its rows ride the pass so the window
                    // composition never re-renders an entry twice.
                    fresh.insert(index, rows);
                }
            }
            preceded_by_tool_activity = matches!(entry, ChatEntry::Tool(_));
            first = false;
        }
        let tail = self.render_transcript_tail(width);
        let total = offsets.last().copied().unwrap_or(splash.len()) + tail.len();
        TranscriptLayout {
            splash,
            offsets,
            fresh,
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
    }

    pub(super) fn render_transcript_tail(&self, width: usize) -> Vec<Line> {
        let mut tail: Vec<Line> = Vec::new();
        // The `?` quick-shortcut guide renders right below the chat rows
        // (TS mounts `shortcutGuideContainer` between the chat and the
        // status area, inside the scrollable main view): `Spacer(1)` then
        // `new Markdown(guide, 1, 1)` — one blank, the markdown paddingY
        // blank, the content, and the closing paddingY blank.
        if let Some(guide) = &self.shortcut_guide {
            tail.push(Vec::new());
            tail.push(Vec::new());
            let mut md = crate::markdown::MarkdownStyle::from_theme(&self.theme);
            md.code_block_indent = self.code_block_indent.clone();
            tail.extend(crate::chat::render_markdown_block(
                guide,
                &md,
                width,
                &mut crate::markdown::MarkdownBlockCache::default(),
            ));
            tail.push(Vec::new());
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
                .map(|key| crate::keybindings::format_key_text(&key))
                .unwrap_or_else(|| "Ctrl+C".to_string());
            tail.extend(crate::compaction_row::render_compaction_loader(
                compaction,
                self.pulse_frame,
                &cancel_hint,
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
            tail.extend(pane.render(&self.theme, width));
        }
        tail
    }

    /// Compose the transcript rows of one layout pass restricted to the
    /// `[start, start + height)` window: cached rows slice by reference
    /// and clone only inside the window, fresh rows join from the pass.
    /// `height == usize::MAX` composes the whole transcript (the inline
    /// frame and the headless verifiers).
    pub(crate) fn transcript_window(
        &self,
        layout: &TranscriptLayout,
        start: usize,
        height: usize,
    ) -> Vec<Line> {
        let end = start.saturating_add(height);
        let mut rows: Vec<Line> = Vec::new();
        Self::slice_rows(&layout.splash, &mut rows, 0, start, end);
        let detail = match self.detail {
            crate::chat::Detail::Overview => 0,
            crate::chat::Detail::Details => 1,
            crate::chat::Detail::All => 2,
        };
        let first = layout
            .offsets
            .partition_point(|offset| *offset <= start)
            .saturating_sub(1);
        for index in first..self.chat.len() {
            let offset = layout.offsets[index];
            if offset >= end {
                break;
            }
            let source: &[Line] = if let Some(fresh) = layout.fresh.get(&index) {
                fresh.as_slice()
            } else {
                self.entry_layout[index][detail]
                    .as_ref()
                    .map(|slot| slot.rows.as_slice())
                    .unwrap_or(&[])
            };
            Self::slice_rows(source, &mut rows, offset, start, end);
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
}
