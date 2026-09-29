//! The cross-view layout handoff (the tui-switch-layout-reuse cut): the
//! last frame's visible-window entry packs, held for the process
//! lifetime between chat runs so the agents-view round trip's re-entry
//! reuses them instead of re-rendering its first draw's window.
//!
//! [`AgentView`] owns its packed entry layouts for the run's lifetime;
//! the agents-view handoff drops them with the view, and the re-entry
//! re-rendered the visible window from scratch — the view-switch
//! record measured that first pack at ~105ms on the canonical 10MiB
//! fixture (one 4.3MB tail message rendering 36,410 wrapped rows on
//! EVERY re-entry, 93-95% of the first draw; the second frame on the
//! same view serves the identical window from the pack in ~0.3ms). TS
//! keeps no cross-view render cache either — its `returnToAgentsView`
//! tears down the whole `InteractiveMode` and the re-entry mounts fresh
//! components — so this store is a Rust-side improvement, not a parity
//! restoration, invisible on every frozen surface: a pack expands
//! byte-exactly to the rows a fresh render of the same entry would
//! produce, so the re-entry's frames are identical either way.
//!
//! Soundness rides the attach's own freshness contract instead of a new
//! validity domain: the handoff records the session id, the worker
//! generation, the LATEST event sequence the exiting run saw (the live
//! tracker: the attach's value, then the monotonic max over every
//! event's `meta.sequence`), and the entry count, and the adopt fires
//! only on an exact match against the re-attach's values. The worker's
//! event sequence is the same monotonic counter the resume cursor
//! rides: every transcript change — a message appended, a tool card
//! settled, a streamed block grown in place (the same-count mutation
//! class), a compaction rewrite — rides an event that bumps it, so a
//! matching sequence means the entries the packs were rendered from
//! ARE the entries the rebuild just pushed, index for index (a turn
//! run during the exiting chat run advances the stash's key to the
//! value the next attach reports, so a transcript-unchanged sojourn
//! still adopts — the post-turn class; a change during the sojourn
//! itself still misses and re-renders); a worker restart changes the
//! generation, and a different session changes the id. A cursor-less
//! attach never keys: the collapsed default identity could alias
//! across same-count attaches. The packs are only held for a view whose
//! transcript did not change after the adopt (the pending handoff is
//! dropped by every chat mutation — see [`AgentView::adopt_layout_handoff`]),
//! so no post-adopt mutation can be served stale rows. Every miss
//! re-renders exactly as before: the store can only make a re-entry
//! faster, never different.
//!
//! What is held: the last frame's visible-window entries' packed
//! layouts (the click surface's recorded window sections), one
//! process-wide slot — the packs stay resident between the surfaces
//! exactly as they already do during a run (the layout cache keeps
//! visited entries' rows for the process lifetime), and the next
//! handoff overwrites the slot.

use super::layout::EntryLayout;
use super::AgentView;
use crate::theme::Theme;
use std::sync::{Mutex, OnceLock};

/// The render-shape inputs a packed layout's rows depend on besides the
/// entry itself: the width plus the view's `layout_options` tuple
/// (theme, code-block indent, image display, the fullscreen image
/// fallback). A handoff whose shape does not match the adopting draw's
/// is dropped — the rows would be laid out differently.
pub(super) type LayoutShape = (usize, (Theme, String, bool, bool));

/// One visible-window entry's held layouts, per detail slot (a pack is
/// valid for the detail slot it was built under, independent of the
/// view's current detail mode).
pub(super) type HeldSlots = [Option<EntryLayout>; 3];

/// The stored handoff: the adopt key plus the window's packed layouts.
pub(super) struct LayoutHandoff {
    pub(super) session_id: String,
    pub(super) generation: String,
    pub(super) sequence: u64,
    pub(super) entry_count: usize,
    pub(super) shape: LayoutShape,
    /// (entry index, its per-detail packed layouts) for the last
    /// frame's visible-window entries, ascending by index.
    pub(super) packs: Vec<(usize, HeldSlots)>,
}

/// The one process-wide handoff slot (the agents view and the chat runs
/// share the process; a store written by one run dies with it).
static HANDOFF: OnceLock<Mutex<Option<LayoutHandoff>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<LayoutHandoff>> {
    HANDOFF.get_or_init(|| Mutex::new(None))
}

/// Hold `handoff` as the one slot (a different session's handoff is
/// dropped with it).
fn store(handoff: LayoutHandoff) {
    *slot()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(handoff);
}

/// Take the held handoff when its key matches this attach exactly — the
/// session id, the worker generation, the ATTACH event sequence, and
/// the entry count. Every other key shape (a different session, a
/// restarted worker, any event since the stored attach — the sequence
/// moved — a different entry count) consumes the slot as a miss so the
/// re-entry re-renders exactly as before.
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

/// Drop any held handoff (the tests' isolation seam: a store written by
/// one test must never serve another).
#[cfg(test)]
pub(super) fn reset() {
    *slot()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

impl AgentView {
    /// Hold this view's visible-window packs for the next chat run over
    /// the same session (the agents-back handoff's exit step): the last
    /// composed frame's window entries' packed layouts keyed by the
    /// LATEST event sequence the run has seen (the live tracker — a
    /// turn during the run advances the key past this run's own attach
    /// value, so the post-turn sojourn's re-entry still matches). The
    /// next run over the SAME transcript-unchanged session — the
    /// operators' LEFT/ENTER round trip — adopts them and its first
    /// draw serves the window instead of re-rendering it; every other
    /// attach re-renders exactly as before.
    pub fn stash_layout_handoff(&self, session_id: &str, generation: &str, sequence: u64) {
        if self.layout_width == 0 {
            // A view that never composed a window holds nothing visible
            // to reuse.
            return;
        }
        let mut packs: std::collections::BTreeMap<usize, HeldSlots> =
            std::collections::BTreeMap::new();
        for section in &self.click.window_sections {
            // A clicked card's slot holds its flipped rows, but the
            // re-entry mounts every card at the level (the toggles live
            // in this view), so its pack must not serve there.
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
        // The width guard above implies the options are set (a view that
        // drew carries them); the defensive shape keeps the stash
        // panic-free either way.
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

    /// Hold the stored handoff for this rebuild's first draw when its key
    /// matches this attach exactly (the same session, the same worker
    /// generation, the same event sequence, the same entry count — a
    /// transcript unchanged since the run that just left). The first
    /// layout preparation validates the stored render shape and seeds
    /// the packs; a mismatch, or any chat mutation before that first
    /// draw, drops the handoff and the window re-renders.
    pub fn adopt_layout_handoff(&mut self, session_id: &str, generation: &str, sequence: u64) {
        if let Some(handoff) = take_if_match(session_id, generation, sequence, self.chat.len()) {
            self.pending_handoff = Some(handoff);
        }
    }
}

#[cfg(test)]
#[path = "handoff_tests.rs"]
mod tests;
