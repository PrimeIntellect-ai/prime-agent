//! The cross-view layout handoff: the last frame's visible-window entry packs, held between
//! chat runs so the agents-view round trip's re-entry reuses them. The adopt fires only on an
//! exact session/generation/sequence/entry-count match; a pack expands byte-exactly — a miss
//! re-renders as before.

use super::layout::EntryLayout;
use super::AgentView;
use crate::theme::Theme;
use std::sync::{Mutex, OnceLock};

/// The render-shape inputs a packed layout's rows depend on: the width
/// plus the view's `layout_options` tuple.
pub(super) type LayoutShape = (usize, (Theme, String, bool, bool));

/// One visible-window entry's held layouts, per detail slot (a pack is
/// valid for the slot it was built under).
pub(super) type HeldSlots = [Option<EntryLayout>; 3];

/// The stored handoff: the adopt key plus the window's packed layouts.
pub(super) struct LayoutHandoff {
    pub(super) session_id: String,
    pub(super) generation: String,
    pub(super) sequence: u64,
    pub(super) entry_count: usize,
    pub(super) shape: LayoutShape,
    /// (entry index, per-detail packed layouts) for the last frame's
    /// visible-window entries.
    pub(super) packs: Vec<(usize, HeldSlots)>,
}

/// The one process-wide handoff slot (a store written by one run dies
/// with it).
static HANDOFF: OnceLock<Mutex<Option<LayoutHandoff>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<LayoutHandoff>> {
    HANDOFF.get_or_init(|| Mutex::new(None))
}

/// Hold `handoff` as the one slot.
fn store(handoff: LayoutHandoff) {
    *slot()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(handoff);
}

/// Take the held handoff when its key matches this attach exactly;
/// every other key shape consumes the slot as a miss.
fn take_if_match(
    session_id: &str,
    generation: &str,
    sequence: u64,
    entry_count: usize,
) -> Option<LayoutHandoff> {
    let mut guard = slot()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let matches = guard.as_ref().is_some_and(|held| {
        held.session_id == session_id
            && held.generation == generation
            && held.sequence == sequence
            && held.entry_count == entry_count
    });
    if matches {
        guard.take()
    } else {
        *guard = None;
        None
    }
}

/// Drop any held handoff (the tests' isolation seam).
#[cfg(test)]
pub(super) fn reset() {
    *slot()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

impl AgentView {
    /// Hold this view's visible-window packs for the next chat run over the same session, keyed
    /// by the LATEST event sequence the run saw.
    pub fn stash_layout_handoff(&self, session_id: &str, generation: &str, sequence: u64) {
        if self.layout_width == 0 {
            // A view that never composed a window holds nothing visible
            // to reuse.
            return;
        }
        let mut packs: std::collections::BTreeMap<usize, HeldSlots> =
            std::collections::BTreeMap::new();
        for section in &self.click.window_sections {
            // A clicked card's slot holds its flipped rows, but the re-entry mounts every card
            // at the level, so its pack must not serve there.
            if self.toggled_cards.contains(&section.entry) {
                continue;
            }
            if let Some(slots) = self.entry_layout.get(section.entry) {
                if slots.iter().any(Option::is_some) {
                    packs.insert(section.entry, slots.clone());
                }
            }
        }
        if packs.is_empty() {
            // An all-transient window (animated rows are never packed)
            // holds nothing to reuse.
            return;
        }
        // The width guard above implies the options are set; the
        // defensive shape keeps the stash panic-free either way.
        let Some(options) = self.layout_options.clone() else {
            return;
        };
        let shape = (self.layout_width, options);
        store(LayoutHandoff {
            session_id: session_id.to_string(),
            generation: generation.to_string(),
            sequence,
            entry_count: self.chat.len(),
            shape,
            packs: packs.into_iter().collect(),
        });
    }

    /// Hold the stored handoff for this rebuild's first draw when its
    /// key matches this attach; the first layout preparation validates
    /// the shape, and any chat mutation before that drops it.
    pub fn adopt_layout_handoff(&mut self, session_id: &str, generation: &str, sequence: u64) {
        if let Some(handoff) = take_if_match(session_id, generation, sequence, self.chat.len()) {
            self.pending_handoff = Some(handoff);
        }
    }
}

#[cfg(test)]
#[path = "handoff_tests.rs"]
mod tests;
