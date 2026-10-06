# Crossterm 0.28.1 keyboard-probe timeout patch

Pinned source of crates.io `crossterm` 0.28.1 (MIT). The only upstream source change is `src/terminal/sys/unix.rs`: the kitty/DA1 support query's answer window. See benchmark diagnostic record `1c5af0f` (`kitty-ab-diagnostic-20260925`): unanswered kitty queries starved app key reads for two seconds, and the same fix class continues here.

The window bound is 250ms (instead of upstream's 2000ms), held in 10ms poll slices instead of one blocking hold: each slice parks the process-global event-reader lock for at most a slice, so the app reader interleaves and delivers input typed during the probe at its own cadence, while the probe still reads its reply through the same shared queue (a reply read on the app side is found by the probe's next slice; the parked-reply and skipped-event queues are the same shared state under the same lock). A slice timeout yields to the app reader and re-polls until the 250ms deadline — the settle time, the answer contract, the response filtering, and the queued user keys are unchanged; only the lock-hold shape changes. A poll error retries inside the same window and settles at the deadline (upstream retried without a bound, parking the lock 250ms at a time on a broken tty). Answering terminals still resolve immediately (a DA1 reply alone settles no-kitty early — the flags filter matches the primary-device-attributes reply too); a silent PTY settles at 250ms. Responses after the deadline remain filtered, but do not enable kitty on this first surface. Prefer upstreaming a configurable bounded-query API (ideally with lock-free slices) to crossterm before removing this vendor patch.

# Additive exports for the edge-driven app reader (2026-09-28, wave-6 tui-wake-thread)

The `event-stream` feature's waker machinery (upstream, unchanged: `WAKE_TOKEN`,
the `Waker` type, `InternalEventReader::waker`) compiles in for the product
(`crates/pa-tui` enables the feature), and three additive exports make it
usable by the app's single input-reader thread:

* `event::poll_opt(timeout: Option<Duration>)` — the existing `poll` with the
  `None` park that `InternalEventReader::poll` already supported internally:
  park until real tty/signal input, or a waker wake, which the reader maps to
  `Ok(false)` exactly like a timeout.
* `event::waker() -> Option<Waker>` — the process-global source's wake handle,
  `None` when the source failed to initialize (no controlling tty: parking is
  unsafe then — the vendored contract makes the caller keep a bounded poll).
* `pub struct Waker` / `pub fn Waker::wake` / the `pub use` chain
  (`event::sys`, `event::sys::unix::waker::mio`, `event::sys::windows::waker`)
  — visibility bumps only; the type was already `pub(crate)` under the same
  feature gate, and `new` stays crate-private.
* `InternalEventReader::try_waker` — the non-panicking `waker()` variant
  (`Option` instead of `.expect("reader source not set")`).

The app reader (`crates/pa-tui/src/input.rs`) parks on `poll_opt(None)` when its
sequence guard holds nothing, keeps the 10ms bounded poll while the kitty-probe
window is open (`pa_tui::enhanced_keys::query_in_flight`) — the probe's slices
and the reader share the process-global event-reader lock, and a park would
starve them — and its stop flag is now observed through `Waker::wake()` at
teardown instead of a poll tick. Behavior on the wire (events, parse order,
chunk boundaries, handoff) is unchanged; only the idle wait's wakeup rate is.

# The verdict time per terminal class (2026-09-29, kitty-verdict-time lane)

The probe's conclusion time was characterized on a real pty per class
(`kitty_verdict_time_e2e`'s sweep mode, VM feq0mhg7yk19ycrk2ytuhuww at the
tip; rows in the lane's record):

* A kitty terminal concludes at its flags reply (push at answer+~6ms).
* A DA1-answering non-kitty terminal — the COMMON non-kitty class; real
  tmux 3.2a answers DA1 in 15-24us and never answers the flags query
  (1001ms silence, 10/10); real screen 4.09 answers in 15-33us —
  concludes at the DA1 arrival (the window measured CLOSED from +20ms
  with the answer at +15ms; a flags reply at +20..+80ms never upgrades),
  so a raced mode transition lands with its dispatch (offset+2ms) instead
  of the deadline.
* A fully-silent pty (no DA1 ever — CI harnesses) is the only class that
  pays the deadline: the raced teardown pins at 249-251ms at every
  in-window offset, and the upgrade cliff sits at 240-250ms.

The 250ms bound is therefore TWO contracts at once: the silent class's
verdict bound, and the late-kitty catch window — a kitty terminal over a
slow hop answers its flags at RTT (this fleet's own single public hop
measures 24-29ms; the intercontinental SSH classes ride 80-250ms),
inside today's window and outside any 50ms cut. A flat deadline cut is
rejected on that misclassification distribution: it would silently drop
the enhancement for the RTT>50ms class (the product's primary remote-SSH
deployment shape) while buying only the silent class's raced-transition
stall, which no user rides. The timed contract is locked by
`crates/pa-cli/tests/kitty_verdict_time_e2e.rs`.
