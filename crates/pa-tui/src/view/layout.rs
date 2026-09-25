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

/// Exact transcript geometry plus the small splash/status surfaces. Entry
/// rows are constructed only when `transcript_window` visits their range.
pub(crate) struct TranscriptLayout {
    splash: Vec<Line>,
    /// Absolute row starts, including the end sentinel.
    offsets: Vec<usize>,
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
            | ChatEntry::CustomPanel(_)
            | ChatEntry::ClientMarkdown { .. }
            | ChatEntry::ClientText { .. }
            | ChatEntry::ChangelogPanel { .. } => true,
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
            | ChatEntry::CustomPanel(_)
            | ChatEntry::ClientMarkdown { .. }
            | ChatEntry::ClientText { .. }
            | ChatEntry::ChangelogPanel { .. } => false,
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
        let splash = render_splash(&self.chrome, &self.theme, width);
        let mut offsets = Vec::with_capacity(self.chat.len() + 1);
        offsets.push(splash.len());
        let mut first = true;
        let mut preceded_by_tool_activity = false;
        for (index, entry) in self.chat.iter().enumerate() {
            let spacing = self.entry_spacing(index, entry, first, preceded_by_tool_activity);
            let cacheable = self.entry_cacheable(entry);
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
        // The `?` quick-shortcut guide renders right below the chat rows
        // (TS mounts `shortcutGuideContainer` between the chat and the
        // status area, inside the scrollable main view): `Spacer(1)` then
        // `new Markdown(guide, 1, 1)` — one blank, the markdown paddingY
        // blank, the content, and the closing paddingY blank.
        if let Some(guide) = &self.shortcut_guide {
            tail.push(Vec::new());
            tail.push(Vec::new());
            let mut md = crate::markdown::MarkdownStyle::from_theme(&self.theme);
            md.code_block_indent.clone_from(&self.code_block_indent);
            tail.extend(crate::chat::render_markdown_block(
                guide,
                &md,
                width,
                &mut crate::markdown::MarkdownBlockCache::default(),
            ));
            tail.push(Vec::new());
        }
        // In-flight bash output for the current turn renders ABOVE the
        // execution indicator (TS `pendingMessagesContainer` sits between
        // the shortcut guide and the status area) and flushes into the
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
            Self::slice_rows(&source, &mut rows, offset, start, end);
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
