//! The cross-view layout handoff oracles: the reuse serves the re-entry's
//! window byte-identically without a re-render, and every changed
//! transcript (a different session, a moved sequence, a different entry
//! count), a changed render shape, or a post-adopt mutation re-renders
//! exactly as before the cut. The served-path assertions ride the
//! test-only `ENTRY_RENDERS` counter (a held pack serving a window never
//! enters `render_entry`).
use super::super::expansion::tests::finished_tool_card;
use super::super::layout::{EntryLayout, ENTRY_RENDERS};
use super::super::AgentView;
use super::*;
use crate::chat::{ChatEntry, StatusKind};
use crate::theme::{ColorMode, Theme};

/// The handoff store is process-wide: the tests serialize through this
/// lock so one test's store is never adopted (or reset) by another.
static HANDOFF_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn view() -> AgentView {
    AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
}

/// The round-trip fixture shape: a handful of settled one-row entries
/// (the window walks back through them) plus a wide tail entry (the
/// class the view-switch record measured: the visible window fills
/// inside one big entry). Every entry is cacheable so the window build
/// packs them.
fn fill(view: &mut AgentView) {
    for text in [
        "one",
        "two",
        "three",
        "a settled tail entry that wraps across a couple of rows to fill the visible window the way the resumed transcripts do",
    ] {
        view.push_entry(ChatEntry::Status {
            text: text.to_string(),
            kind: StatusKind::Info,
        });
    }
}

/// Draw `left`'s window and hold its handoff under the round-trip key
/// (the session id, the generation, the sequence), returning the key.
fn stash(left: &mut AgentView, sequence: u64) -> (String, String, u64) {
    left.visible_transcript_window(80, 6);
    let session_id = "sess".to_string();
    let generation = "gen-1".to_string();
    left.stash_layout_handoff(&session_id, &generation, sequence);
    (session_id, generation, sequence)
}

#[test]
fn the_reentry_window_serves_the_held_packs_byte_identically() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let left_rows = left.visible_transcript_window(80, 6).0;
    assert!(
        !left_rows.is_empty(),
        "the fixture window renders content rows"
    );
    let (session_id, generation, sequence) = stash(&mut left, 7);

    // The re-entry: a FRESH view (the run boundary's shape) over the same
    // transcript, adopting the held handoff on the key's exact match.
    let mut reentry = view();
    fill(&mut reentry);
    reentry.adopt_layout_handoff(&session_id, &generation, sequence);
    ENTRY_RENDERS.with(|count| count.set(0));
    let reentry_rows = reentry.visible_transcript_window(80, 6).0;
    assert_eq!(
        ENTRY_RENDERS.with(std::cell::Cell::get),
        0,
        "the held packs served the re-entry's window: no render_entry call"
    );
    assert_eq!(
        reentry_rows, left_rows,
        "the served rows are byte-identical"
    );
    assert_eq!(
        reentry.handoff_seeds, 1,
        "the served-path observable counts the window the packs served"
    );

    // The full frame is the frozen surface: the re-entry's composed
    // frame equals the pre-exit frame row for row.
    assert_eq!(reentry.render_frame(80, 24), left.render_frame(80, 24));
}

#[test]
fn a_changed_transcript_misses_and_re_renders() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let _ = left.visible_transcript_window(80, 6);
    let (session_id, generation, sequence) = stash(&mut left, 7);

    // A different entry count (a message landed while away) adopts
    // nothing.
    let mut reentry = view();
    fill(&mut reentry);
    reentry.push_entry(ChatEntry::Status {
        text: "a new message that landed while the view was away".to_string(),
        kind: StatusKind::Info,
    });
    reentry.adopt_layout_handoff(&session_id, &generation, sequence);
    assert!(reentry.pending_handoff.is_none());

    // Each mismatch probe needs its OWN held handoff: a mismatching
    // adopt consumes the one-shot store (a stale key never serves — not
    // even to the next probe), so probing two mismatched keys back to
    // back would only prove the second probe read an empty slot. The
    // held key is re-stashed before every probe so each mismatch key is
    // genuinely exercised against a live store.
    let mut reentry_same_count = view();
    fill(&mut reentry_same_count);
    // A moved event sequence (any event since the stored attach): the
    // same-count case misses too — the in-place stream growth class.
    reentry_same_count.adopt_layout_handoff(&session_id, &generation, sequence + 1);
    assert!(reentry_same_count.pending_handoff.is_none());
    // A restarted worker (a different generation) misses a fresh stash.
    let mut regen = view();
    fill(&mut regen);
    stash(&mut regen, sequence);
    regen.adopt_layout_handoff(&session_id, "gen-2", sequence);
    assert!(regen.pending_handoff.is_none());
    // A different session misses a fresh stash.
    let mut others = view();
    fill(&mut others);
    stash(&mut others, sequence);
    others.adopt_layout_handoff("other", &generation, sequence);
    assert!(others.pending_handoff.is_none());

    ENTRY_RENDERS.with(|count| count.set(0));
    let _ = reentry_same_count.visible_transcript_window(80, 6);
    assert!(
        ENTRY_RENDERS.with(std::cell::Cell::get) > 0,
        "a missed handoff re-renders exactly as before the cut"
    );
}

#[test]
fn a_shape_mismatch_drops_the_held_packs() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let (session_id, generation, sequence) = stash(&mut left, 7);

    let mut reentry = view();
    fill(&mut reentry);
    reentry.adopt_layout_handoff(&session_id, &generation, sequence);
    assert!(reentry.pending_handoff.is_some());
    ENTRY_RENDERS.with(|count| count.set(0));
    // A different width (the terminal resized while away): the held
    // packs were laid out at 80 and must never serve at 100.
    let _ = reentry.visible_transcript_window(100, 6);
    assert!(
        ENTRY_RENDERS.with(std::cell::Cell::get) > 0,
        "a width-mismatched handoff never serves: the window re-rendered"
    );
    assert_eq!(
        reentry.handoff_seeds, 0,
        "a shape-mismatched handoff drops its packs WITHOUT burning a seed: the observable counts only served windows"
    );
}

#[test]
fn a_post_adopt_mutation_retires_the_held_packs() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let (session_id, generation, sequence) = stash(&mut left, 7);

    let mut reentry = view();
    fill(&mut reentry);
    reentry.adopt_layout_handoff(&session_id, &generation, sequence);
    assert!(reentry.pending_handoff.is_some());
    // A mutation lands between the adopt and the first draw (a startup
    // notice, a live event): the held packs retire and the window
    // re-renders.
    reentry.push_entry(ChatEntry::Status {
        text: "a late notice after the adopt".to_string(),
        kind: StatusKind::Info,
    });
    assert!(reentry.pending_handoff.is_none());
    ENTRY_RENDERS.with(|count| count.set(0));
    let _ = reentry.visible_transcript_window(80, 6);
    assert!(
        ENTRY_RENDERS.with(std::cell::Cell::get) > 0,
        "the transcript changed after the adopt: the window re-rendered"
    );
}

#[test]
fn a_stale_spacing_self_guards_to_a_re_render() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let (session_id, generation, sequence) = stash(&mut left, 7);
    // Corrupt the held spacing decision: the read path re-derives the
    // spacing and must discard the pack instead of serving it.
    {
        let mut guard = slot().lock().expect("the handoff slot");
        let handoff = guard.as_mut().expect("the stashed handoff");
        let (_, slots) = handoff
            .packs
            .iter_mut()
            .find(|(_, slots)| slots.iter().any(Option::is_some))
            .expect("the handoff holds a pack");
        let held = slots
            .iter_mut()
            .find_map(std::mem::take)
            .expect("the held pack");
        *slots.first_mut().expect("the detail slot") = Some(EntryLayout {
            spacing: !held.spacing,
            rows: held.rows,
        });
    }

    let mut reentry = view();
    fill(&mut reentry);
    reentry.adopt_layout_handoff(&session_id, &generation, sequence);
    assert!(reentry.pending_handoff.is_some());
    ENTRY_RENDERS.with(|count| count.set(0));
    let _ = reentry.visible_transcript_window(80, 6);
    assert!(
        ENTRY_RENDERS.with(std::cell::Cell::get) > 0,
        "a spacing-mismatched pack is discarded at read, never served"
    );
}

#[test]
fn the_slot_is_one_shot_and_a_second_store_wins() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let (session_id, generation, sequence) = stash(&mut left, 7);
    // The one-shot take: a second adopt attempt finds the slot empty.
    let mut reentry = view();
    fill(&mut reentry);
    reentry.adopt_layout_handoff(&session_id, &generation, sequence);
    let mut second = view();
    fill(&mut second);
    second.adopt_layout_handoff(&session_id, &generation, sequence);
    assert!(second.pending_handoff.is_none());

    // A different session's handoff overwrites the slot (the one-slot
    // bound: the previous session's packs are dropped with it), and a
    // mismatching adopt consumes the slot — the stale key never serves.
    let mut other = view();
    fill(&mut other);
    let _ = other.visible_transcript_window(80, 6);
    other.stash_layout_handoff("other", "gen-1", 9);
    let mut third = view();
    fill(&mut third);
    third.adopt_layout_handoff(&session_id, &generation, sequence);
    assert!(
        third.pending_handoff.is_none(),
        "the overwritten session's key never serves"
    );
    // A fresh store over the new key serves it (the miss consumed the
    // slot; only a new handoff refills it).
    let _ = other.visible_transcript_window(80, 6);
    other.stash_layout_handoff("other", "gen-1", 9);
    third.adopt_layout_handoff("other", "gen-1", 9);
    assert!(
        third.pending_handoff.is_some(),
        "a fresh store serves its own key"
    );
}

/// The post-turn sojourn class (the live-sequence key): a turn during the
/// run advanced the worker's sequence past this run's own attach value —
/// the stash keys the LATEST sequence the run saw (the live tracker), so
/// the transcript-unchanged sojourn's re-entry (the next attach reporting
/// that same live value) adopts. Keying the run's own stale attach value
/// instead (the pre-fix shape) misses the same re-entry: a re-entry whose
/// transcript DID change must miss either way, but a turn before the exit
/// never changes the sojourn's transcript.
#[test]
fn a_post_turn_sojourn_reentry_matches_the_live_sequence_key() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let left_rows = left.visible_transcript_window(80, 6).0;
    let session_id = "sess".to_string();
    let generation = "gen-1".to_string();
    // The run attached at sequence 7; the turn during the run advanced the
    // live tracker to 8 — the stash keys the live value.
    left.stash_layout_handoff(&session_id, &generation, 8);

    let mut reentry = view();
    fill(&mut reentry);
    reentry.adopt_layout_handoff(&session_id, &generation, 8);
    assert!(
        reentry.pending_handoff.is_some(),
        "the live-keyed stash matches the post-turn re-entry's attach"
    );
    ENTRY_RENDERS.with(|count| count.set(0));
    let reentry_rows = reentry.visible_transcript_window(80, 6).0;
    assert_eq!(
        ENTRY_RENDERS.with(std::cell::Cell::get),
        0,
        "the held packs served the post-turn re-entry: no render_entry call"
    );
    assert_eq!(
        reentry_rows, left_rows,
        "the served rows are byte-identical"
    );

    // The pre-fix shape for the same re-entry: a stash keyed at the run's
    // own stale attach value misses the post-turn re-attach and re-renders.
    let mut stale_left = view();
    fill(&mut stale_left);
    let _ = stale_left.visible_transcript_window(80, 6);
    stale_left.stash_layout_handoff(&session_id, &generation, 7);
    let mut stale_reentry = view();
    fill(&mut stale_reentry);
    stale_reentry.adopt_layout_handoff(&session_id, &generation, 8);
    assert!(
        stale_reentry.pending_handoff.is_none(),
        "the stale attach-sequence key never serves the post-turn re-entry"
    );
    ENTRY_RENDERS.with(|count| count.set(0));
    let _ = stale_reentry.visible_transcript_window(80, 6);
    assert!(
        ENTRY_RENDERS.with(std::cell::Cell::get) > 0,
        "the stale-keyed handoff missed and the window re-rendered"
    );
}

/// The retry-episode pop (`pop_chat_entry`, the retry collapse that
/// retires the failed attempt's error row) is a transcript mutation: the
/// held handoff retires exactly like every other post-adopt mutation, so a
/// pop between the adopt and the first draw never serves pre-pop packs.
#[test]
fn a_retry_episode_pop_retires_the_held_handoff() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let mut left = view();
    fill(&mut left);
    let (session_id, generation, sequence) = stash(&mut left, 7);

    let mut reentry = view();
    fill(&mut reentry);
    reentry.adopt_layout_handoff(&session_id, &generation, sequence);
    assert!(reentry.pending_handoff.is_some());
    // The retry episode collapses the failed attempt's error row between
    // the adopt and the first draw: the pop is a transcript mutation.
    reentry.pop_chat_entry();
    assert!(
        reentry.pending_handoff.is_none(),
        "the pop retired the held handoff"
    );
    ENTRY_RENDERS.with(|count| count.set(0));
    let _ = reentry.visible_transcript_window(80, 6);
    assert!(
        ENTRY_RENDERS.with(std::cell::Cell::get) > 0,
        "the popped transcript re-renders: the pre-pop packs never served"
    );
}

/// A clicked card is not held across the round trip: its slot holds the
/// flipped rows, but the re-entry mounts every card at the level (the
/// toggles live in the exiting view). The card follows a status row, so
/// its leading spacing is the same either way and the spacing guard
/// cannot discard a stale pack.
#[test]
fn a_clicked_card_re_renders_at_the_level_after_the_round_trip() {
    let _guard = HANDOFF_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    reset();
    let fill_card = |view: &mut AgentView| {
        view.push_entry(ChatEntry::Status {
            text: "one".to_string(),
            kind: StatusKind::Info,
        });
        view.push_entry(finished_tool_card("c0", "alpha"));
    };
    let text = |rows: &[crate::Line]| -> String {
        rows.iter()
            .flatten()
            .map(|span| span.content.as_str())
            .collect()
    };
    let mut left = view();
    fill_card(&mut left);
    left.toggle_card_expansion(1);
    assert!(text(&left.visible_transcript_window(80, 24).0).contains("alpha 1"));
    left.stash_layout_handoff("sess", "gen-1", 7);

    let mut reentry = view();
    fill_card(&mut reentry);
    reentry.adopt_layout_handoff("sess", "gen-1", 7);
    let rows = reentry.visible_transcript_window(80, 24).0;
    assert_eq!(
        reentry.handoff_seeds, 1,
        "the round trip adopted the handoff"
    );
    let mut fresh = view();
    fill_card(&mut fresh);
    assert_eq!(
        rows,
        fresh.visible_transcript_window(80, 24).0,
        "the card renders at the level, like a fresh mount"
    );
    assert_eq!(
        reentry.count_entry_rows(1, 80),
        reentry.sparse_entry_rows(1, 80).len(),
        "the card's row count matches the rows it renders"
    );
    reentry.toggle_card_expansion(1);
    assert!(
        text(&reentry.visible_transcript_window(80, 24).0).contains("alpha 1"),
        "the next click expands the card"
    );
}
