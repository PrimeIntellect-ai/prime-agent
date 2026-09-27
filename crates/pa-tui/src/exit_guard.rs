//! Force-quit guard for the double-Ctrl+C exit contract.
//!
//! The interactive loop is not always alive when the user wants out: a
//! daemon request on the key-handling path can hold the loop for seconds
//! (`UI_REQUEST_TIMEOUT_MS`), the exit path itself awaits several bounded
//! requests, and a wedged runtime never runs those bounds at all. Issue
//! #138's per-request caps bound the healthy path, but the second Ctrl+C
//! still has to be *observed by the loop* before they apply, so the exit
//! could lag indefinitely — the live report: the first press is accepted
//! (abort sent), the second never terminates.
//!
//! The contract this module enforces: two Ctrl+C presses inside the exit
//! window mean exit, and the process is gone within
//! [`FORCE_QUIT_AFTER_MS`] of the second press — no matter what the loop,
//! the daemon connection, or the async runtime is doing. The observation
//! runs on the terminal reader thread (the one component that stays alive
//! when the UI loop is wedged) and the enforcement runs on a plain
//! `std::thread` watchdog that needs no runtime, so even a deadlocked
//! runtime cannot stop it.
//!
//! Semantics stay TS-exact while the loop is healthy: the reader arms the
//! watchdog for any in-window Ctrl+C *pair*, and the loop disarms it once
//! it has handled every observed Ctrl+C press without exiting (first press
//! closed an autocomplete or aborted the turn, TS `handleCtrlC`). Counted
//! handoff is what makes both directions sound: a handled press can never
//! clear the deadline of a press still queued behind it, so a pair that
//! the wedged loop never reaches always fires, and a pair a healthy loop
//! consumed always disarms.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

/// The double-press window (TS `EXIT_HINT_DURATION_MS`): a Ctrl+C pair is
/// two presses at most this far apart.
pub(crate) const CTRL_C_WINDOW_MS: u64 = 2_000;
/// Hard ceiling from the second Ctrl+C to process exit. The contract is
/// "exited within 2 seconds of the second press"; the watchdog fires
/// 500ms inside that so the exit (best-effort terminal restore plus
/// `process::exit`) is *observed* within the 2s window once process
/// teardown and terminal latency are included.
pub(crate) const FORCE_QUIT_AFTER_MS: u64 = 1_500;
/// How long the exit path may stay silent after a real observation of
/// progress before the watchdog treats it as stalled. The exit flush
/// hands the whole transcript to the terminal in bounded chunks
/// (view.rs `FlushSink`), and a slow terminal consumes those chunks at
/// its own pace: the writer blocks inside `write` while the terminal
/// drains, which looks exactly like a wedged shutdown to a pure wall
/// clock. A completed chunk write is proof the exit is moving, so the
/// watchdog holds fire while progress was observed within this window
/// and force-quits only once it goes stale (a dead terminal, a wedged
/// writer). TS has no watchdog at all — its exit simply waits for the
/// writes — so holding on observed progress is the TS-healthy behavior;
/// the hard 1500ms ceiling stays for the silent case (the wedged loop
/// the guard was built for). With 32KiB chunks this holds for any drain
/// faster than ~65KB/s; slower drains read as stalled and force-quit
/// (deliberate: the 1500ms contract outranks an unbounded wait).
const EXIT_PROGRESS_GRACE_MS: u64 = 500;
/// Watchdog poll slice: the sleep-until-deadline loop wakes this often to
/// re-read the deadline (so a disarm or cancel lands) and never
/// overshoots the deadline by more than a few milliseconds.
const WATCHDOG_POLL_MS: u64 = 25;
/// The name of the watchdog thread (visible in thread dumps).
const WATCHDOG_THREAD_NAME: &str = "tui-exit-watchdog";

/// When the exit path last proved it is making progress (`None` until the
/// first proof). Process-global on purpose: the writers that owe the proof
/// (the exit flush's chunked writes in view.rs, the release tail in
/// `exit_restore.rs`, the resume hint in `pa-cli`) do not own the guard — the
/// guard is shared across surfaces and the writers live in other layers —
/// and a stamp beside the watchdog reads at every poll slice exactly the
/// same state any guard's watchdog would. One TUI process, one exit.
static LAST_EXIT_PROGRESS: Mutex<Option<Instant>> = Mutex::new(None);

/// Report exit-path progress: the writer completed a real step toward the
/// process exit (a flush chunk, a release-tail write, the resume hint).
/// The watchdog holds its force-quit while progress lands within
/// [`EXIT_PROGRESS_GRACE_MS`]; a shutdown that keeps moving is draining a
/// slow terminal, not stalled, and TS semantics for it are to let the
/// writes finish (TS has no forced exit at all). Feeding is one mutex
/// store per bounded chunk: never on a frame path, only on the exit path.
pub fn note_exit_progress() {
    if let Ok(mut last) = LAST_EXIT_PROGRESS.lock() {
        *last = Some(Instant::now());
    }
}

/// Whether the watchdog may force-quit at `now`: the deadline has passed
/// AND the exit path has been silent for the whole grace window. A fresh
/// progress stamp means the exit is draining a slow terminal (a healthy
/// flush), so the forced exit would kill a live writer mid-stream —
/// truncating the scrollback contract the flush is frozen to, and
/// queueing the restore's own bytes mid-flush. Silence for the grace
/// window means nothing is moving: the original wedged-shutdown case.
fn force_quit_due(now: Instant, deadline: Instant, last_progress: Option<Instant>) -> bool {
    now >= deadline
        && !last_progress.is_some_and(|last| {
            now.duration_since(last) <= Duration::from_millis(EXIT_PROGRESS_GRACE_MS)
        })
}

/// What one Ctrl+C observation means, given the previous press.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CtrlCDecision {
    /// First press of a pair (or outside the window): record it only.
    Record,
    /// Second press inside the window: arm the force-quit deadline. The
    /// loop disarms it once it has handled the pair without exiting.
    ArmForceQuit,
}

/// Classify one Ctrl+C press against the previous one: a press inside
/// [`CTRL_C_WINDOW_MS`] of the previous press is the second half of an
/// exit gesture and arms the force-quit deadline.
fn classify_pair(prev_ms: u64, now_ms: u64) -> CtrlCDecision {
    if prev_ms == 0 || now_ms.saturating_sub(prev_ms) > CTRL_C_WINDOW_MS {
        CtrlCDecision::Record
    } else {
        CtrlCDecision::ArmForceQuit
    }
}

/// State shared between the terminal reader thread, the UI loop, and the
/// watchdog thread. Timestamps are milliseconds since [`GuardState::base`]
/// (1-based; `0` is the no-press sentinel).
struct GuardState {
    base: Instant,
    /// The force-quit deadline; `u64::MAX` when unarmed. The earliest
    /// armed deadline wins; a disarm clears it back to `MAX`.
    force_deadline_ms: AtomicU64,
    /// The last observed Ctrl+C press (reader thread).
    last_ctrl_c_ms: AtomicU64,
    /// Ctrl+C presses observed by the reader thread.
    observed_ctrl_c: AtomicU64,
    /// Ctrl+C presses handled by the UI loop (every consumer surface
    /// reports: session editor, model picker, onboarding).
    handled_ctrl_c: AtomicU64,
    /// The run handed the terminal to a follow-on surface (the agents
    /// view): the process may legitimately continue; no force quit.
    settled: AtomicBool,
    /// The watchdog thread is spawned once, on the first arming.
    watchdog_spawned: AtomicBool,
}

/// The double-Ctrl+C exit guard. Clones share one state; cheap to pass
/// around (one `Arc`).
#[derive(Clone)]
pub(crate) struct ExitGuard {
    state: Arc<GuardState>,
}

impl Default for ExitGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl ExitGuard {
    pub(crate) fn new() -> Self {
        ExitGuard {
            state: Arc::new(GuardState {
                base: Instant::now(),
                force_deadline_ms: AtomicU64::new(u64::MAX),
                last_ctrl_c_ms: AtomicU64::new(0),
                observed_ctrl_c: AtomicU64::new(0),
                handled_ctrl_c: AtomicU64::new(0),
                settled: AtomicBool::new(false),
                watchdog_spawned: AtomicBool::new(false),
            }),
        }
    }

    /// Milliseconds since the guard's base, always at least 1: `0` is the
    /// "no press yet" sentinel, so a press in the first millisecond must
    /// still read as recorded.
    fn ms(&self, at: Instant) -> u64 {
        at.checked_duration_since(self.state.base)
            .map_or(1, |elapsed| elapsed.as_millis() as u64 + 1)
    }

    /// Observe one key from the terminal reader: a Ctrl+C press inside the
    /// window of the previous press arms the force-quit deadline. Runs on
    /// the reader thread, independent of the UI loop.
    pub(crate) fn observe_key(&self, key: &KeyEvent) {
        let is_press = matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat)
            && key.code == KeyCode::Char('c')
            && key.modifiers.contains(KeyModifiers::CONTROL);
        if !is_press {
            return;
        }
        self.state.observed_ctrl_c.fetch_add(1, Ordering::SeqCst);
        let now_ms = self.ms(Instant::now());
        let prev_ms = self.state.last_ctrl_c_ms.swap(now_ms, Ordering::SeqCst);
        if classify_pair(prev_ms, now_ms) == CtrlCDecision::ArmForceQuit {
            self.arm(now_ms + FORCE_QUIT_AFTER_MS);
        }
    }

    /// The UI loop handled one Ctrl+C key (session editor, model picker, or
    /// onboarding — every consumer reports). Once every observed press has
    /// been handled and the loop did not exit, the pair was consumed with
    /// TS semantics (abort, autocomplete cancel): the force-quit deadline
    /// clears. A press still queued behind this one keeps its deadline, so
    /// a wedged loop that never reaches the second press still fires.
    pub(crate) fn note_ctrl_c_handled(&self) {
        let handled = self.state.handled_ctrl_c.fetch_add(1, Ordering::SeqCst) + 1;
        if handled >= self.state.observed_ctrl_c.load(Ordering::SeqCst) {
            self.disarm();
        }
    }

    /// The run decided to leave (exit key, session request, or the daemon
    /// connection closing): the process must be gone within
    /// [`FORCE_QUIT_AFTER_MS`] even if the shutdown path wedges — the
    /// bounded stats/detach/telemetry requests and the exit flush are all
    /// best-effort now.
    pub(crate) fn arm_for_exit(&self) {
        let now_ms = self.ms(Instant::now());
        self.arm(now_ms + FORCE_QUIT_AFTER_MS);
    }

    /// Pull the force-quit deadline earlier (never push it later): the
    /// reader's pair observation is the exact second-press timestamp, so
    /// it wins over a later loop-side arming.
    fn arm(&self, deadline_ms: u64) {
        let mut current = self.state.force_deadline_ms.load(Ordering::SeqCst);
        while deadline_ms < current {
            match self.state.force_deadline_ms.compare_exchange(
                current,
                deadline_ms,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
        if !self.state.watchdog_spawned.swap(true, Ordering::SeqCst) {
            spawn_watchdog(Arc::clone(&self.state));
        }
    }

    /// Clear the force-quit deadline (the pair was consumed without an
    /// exit, or the run handed off); a later fresh pair re-arms.
    fn disarm(&self) {
        self.state
            .force_deadline_ms
            .store(u64::MAX, Ordering::SeqCst);
    }

    /// The run finished and the process may continue (the agents-view
    /// handoff): retire the watchdog. Every other completion is a process
    /// exit, where the deadline simply dies with the process — or fires
    /// when the exit wedged, which is the point.
    pub(crate) fn cancel(&self) {
        self.state.settled.store(true, Ordering::SeqCst);
        self.disarm();
    }
}

/// The watchdog: one thread per guard, spawned on the first arming. Sleeps
/// toward the deadline in [`WATCHDOG_POLL_MS`] slices (so a disarm or
/// cancel lands promptly), then force-quits.
fn spawn_watchdog(state: Arc<GuardState>) {
    let thread_state = Arc::clone(&state);
    let spawned = std::thread::Builder::new()
        .name(WATCHDOG_THREAD_NAME.to_string())
        .spawn(move || loop {
            if thread_state.settled.load(Ordering::Acquire) {
                return;
            }
            let deadline_ms = thread_state.force_deadline_ms.load(Ordering::SeqCst);
            if deadline_ms == u64::MAX {
                // Disarmed: keep watching — a later pair re-arms.
                std::thread::sleep(Duration::from_millis(WATCHDOG_POLL_MS));
                continue;
            }
            let deadline = thread_state.base + Duration::from_millis(deadline_ms);
            let now = Instant::now();
            if now >= deadline {
                // Drain-aware: the deadline passed, but a writer that
                // completed a step recently is draining a slow terminal,
                // not stalled. Hold the fire while progress keeps landing
                // (checked every poll slice); the silent case still fires
                // at the deadline, exactly as before.
                let last_progress = LAST_EXIT_PROGRESS.lock().ok().and_then(|last| *last);
                if force_quit_due(now, deadline, last_progress) {
                    force_quit();
                }
                // Held: re-check on the next poll slice (progress may go
                // stale while the drain stalls).
                std::thread::sleep(Duration::from_millis(WATCHDOG_POLL_MS));
                continue;
            }
            std::thread::sleep((deadline - now).min(Duration::from_millis(WATCHDOG_POLL_MS)));
        });
    if spawned.is_err() {
        // A spawn failure (out of thread resources) leaves the loop's own
        // bounded exit path in place; the next arming retries the spawn.
        state.watchdog_spawned.store(false, Ordering::SeqCst);
    }
}

/// Force-quit right now: restore the terminal best-effort and exit the
/// process with code 0 (the user asked to close the TUI; the exit is
/// deliberate, not a crash).
fn force_quit() -> ! {
    crate::exit_restore::restore_terminal();
    eprintln!("Prime Agent: shutdown stalled; forced exit.");
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that touch the process-global progress stamp:
    /// the stamp is shared by every test thread, so a reader must hold
    /// this lock across its whole observation window.
    static PROGRESS_STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn ctrl_c() -> KeyEvent {
        KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
    }

    #[test]
    fn force_quit_holds_only_while_progress_is_fresh() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(1);
        // Before the deadline the watchdog never fires, progress or not.
        assert!(!force_quit_due(now, deadline, None));
        assert!(!force_quit_due(now, deadline, Some(now)));
        // Past the deadline with no progress ever observed: the wedged
        // shutdown — fires at the deadline, unchanged.
        assert!(force_quit_due(deadline, deadline, None));
        // Past the deadline with progress inside the grace window: the
        // exit is draining a slow terminal — hold.
        let fresh = deadline
            .checked_sub(Duration::from_millis(EXIT_PROGRESS_GRACE_MS))
            .expect("the grace window precedes the deadline");
        assert!(!force_quit_due(deadline, deadline, Some(fresh)));
        // Progress one millisecond older than the grace window: nothing
        // has moved for the whole window — stalled, fire.
        let stale = deadline
            .checked_sub(Duration::from_millis(EXIT_PROGRESS_GRACE_MS + 1))
            .expect("the stale timestamp precedes the deadline");
        assert!(force_quit_due(deadline, deadline, Some(stale)));
    }

    #[test]
    fn note_exit_progress_stamps_the_last_observation() {
        let _state = PROGRESS_STATE_LOCK.lock();
        {
            let mut last = LAST_EXIT_PROGRESS.lock().expect("progress lock");
            *last = None;
        }
        note_exit_progress();
        let first = LAST_EXIT_PROGRESS
            .lock()
            .expect("progress lock")
            .expect("the note stamped an observation");
        note_exit_progress();
        let second = LAST_EXIT_PROGRESS
            .lock()
            .expect("progress lock")
            .expect("the note stamped again");
        assert!(second >= first, "the stamp keeps the LAST observation");
    }

    #[test]
    fn first_press_records_and_pairs_arm() {
        // A lone press (no previous) records only.
        assert_eq!(classify_pair(0, 500), CtrlCDecision::Record);
        // A second press inside the window arms the force quit.
        assert_eq!(classify_pair(500, 2_200), CtrlCDecision::ArmForceQuit);
        assert_eq!(
            classify_pair(500, 500 + CTRL_C_WINDOW_MS),
            CtrlCDecision::ArmForceQuit
        );
        // One outside the window records instead.
        assert_eq!(
            classify_pair(500, 501 + CTRL_C_WINDOW_MS),
            CtrlCDecision::Record
        );
    }

    #[test]
    fn non_ctrl_c_keys_never_count() {
        let guard = ExitGuard::new();
        let plain_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::NONE);
        guard.observe_key(&plain_c);
        assert_eq!(guard.state.last_ctrl_c_ms.load(Ordering::SeqCst), 0);
        let mut release = ctrl_c();
        release.kind = KeyEventKind::Release;
        guard.observe_key(&release);
        assert_eq!(guard.state.last_ctrl_c_ms.load(Ordering::SeqCst), 0);
        assert_eq!(guard.state.observed_ctrl_c.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn single_press_never_arms_and_pairs_arm_at_the_second_press() {
        let guard = ExitGuard::new();
        guard.observe_key(&ctrl_c());
        let first = guard.state.last_ctrl_c_ms.load(Ordering::SeqCst);
        assert!(first > 0);
        assert_eq!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX,
            "a single press never arms the force quit"
        );
        guard.observe_key(&ctrl_c());
        let second = guard.state.last_ctrl_c_ms.load(Ordering::SeqCst);
        // Two presses can land in the same millisecond; both must read as
        // recorded (never 0), and the second at least the first.
        assert!(second >= first);
        let deadline = guard.state.force_deadline_ms.load(Ordering::SeqCst);
        assert!(
            deadline >= second + FORCE_QUIT_AFTER_MS,
            "the pair arms the force deadline at the second press"
        );
        // Tests never force-quit: settle the watchdog before the guard drops.
        guard.cancel();
    }

    #[test]
    fn handling_every_observed_press_without_exiting_disarms() {
        let guard = ExitGuard::new();
        guard.observe_key(&ctrl_c());
        guard.observe_key(&ctrl_c());
        assert_ne!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX
        );
        // The first handled press still has its pair partner queued: the
        // deadline must survive (a wedged loop that never reaches the
        // second press must still fire).
        guard.note_ctrl_c_handled();
        assert_ne!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX,
            "a handled press never clears the deadline of a queued one"
        );
        // The second handled press drained the pair without an exit
        // (autocomplete cancel, turn abort): disarm.
        guard.note_ctrl_c_handled();
        assert_eq!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX
        );
        guard.cancel();
    }

    #[test]
    fn a_new_pair_re_arms_after_a_consumed_one() {
        let guard = ExitGuard::new();
        guard.observe_key(&ctrl_c());
        guard.note_ctrl_c_handled();
        assert_eq!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX
        );
        std::thread::sleep(Duration::from_millis(CTRL_C_WINDOW_MS + 10));
        guard.observe_key(&ctrl_c());
        assert_eq!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX
        );
        guard.observe_key(&ctrl_c());
        assert_ne!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX
        );
        guard.cancel();
    }

    #[test]
    fn arming_keeps_the_earliest_deadline() {
        let guard = ExitGuard::new();
        guard.arm(10_000);
        guard.arm(5_000);
        assert_eq!(guard.state.force_deadline_ms.load(Ordering::SeqCst), 5_000);
        // A later arming never pushes the deadline out.
        guard.arm(9_000);
        assert_eq!(guard.state.force_deadline_ms.load(Ordering::SeqCst), 5_000);
        guard.cancel();
    }

    #[test]
    fn arm_for_exit_arms_from_now() {
        let guard = ExitGuard::new();
        guard.arm_for_exit();
        let deadline = guard.state.force_deadline_ms.load(Ordering::SeqCst);
        let now_ms = guard.ms(Instant::now());
        assert!(deadline >= now_ms + FORCE_QUIT_AFTER_MS);
        assert!(deadline <= guard.ms(Instant::now()) + FORCE_QUIT_AFTER_MS);
        guard.cancel();
    }

    #[test]
    fn cancel_settles_and_disarms() {
        let guard = ExitGuard::new();
        guard.observe_key(&ctrl_c());
        guard.observe_key(&ctrl_c());
        guard.cancel();
        assert!(guard.state.settled.load(Ordering::Acquire));
        assert_eq!(
            guard.state.force_deadline_ms.load(Ordering::SeqCst),
            u64::MAX
        );
    }
}
