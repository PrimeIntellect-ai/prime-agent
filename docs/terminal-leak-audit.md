# TERMINAL-LEAK-AUDIT — the terminal-state differential

Operator directive (2026-09-28): "if the kitty protocol is leaking to my shell, check if OTHER things are leaking too."

Lane: `lane/terminal-mode-leak-audit` (the kitty mode itself is owned by `kitty-exit-leak`; this lane owns the inventory + the differential net + every non-kitty fix).

## Part 1 — the inventory: every mode-affecting terminal write in pa-tui (+ pa-cli's interactive surface)

### Modes with arm/restore pairs (the tracked set)

| Mode | Sequence(s) | Arm site(s) | Restore site(s) | Leak found? (the differential's verdict per route) |
|------|-------------|--------------|-----------------|-------------|
| Kitty keyboard flags (push) | `ESC[>7u` (flags 1\|2\|4) | `enhanced_keys.rs` `enable` (first surface: the probe; later: `PushFlags` from the recorded capability) | `ESC[<u` pop in `enhanced_keys::disable` + `disable_keyboard_modes` (every drain) | **NO leak on any audited route.** The one CONFIRMED kitty leak is the kitty-exit-leak lane's (their fix + their repro); this harness nets the same window: the late-answer-inside-the-exit route shows no flags push after the exit began, and every route's push/pop stack lands at depth 0 with the pop last. |
| modifyOtherKeys | `ESC[>4;0m` (reset-only; the mode-2 fallback is never armed — a documented divergence, see enhanced_keys' docs) | never armed; the reset is written at every start | the same reset written at every teardown | no — final value 0 on every route |
| Bracketed paste | `ESC[?2004h` | `enhanced_keys::enable` (every surface start; the suspend resume) | `ESC[?2004l` in `enhanced_keys::disable` (every teardown + both exit tails) | no — off on every route |
| SGR mouse tracking | `ESC[?1002h ESC[?1003h ESC[?1006h` | `mouse_tracking::enable`: the chat mount (interactive.rs 3595/3680), the resume (3825), the agents-view mount (2188), the suspend resume (suspend.rs 261) | `ESC[?1006l ESC[?1003l ESC[?1002l` in `mouse_tracking::disable`: the chat finish (3971), the suspend stop (3786), the view handoff (2423), `restore_terminal` (72) | no — all three modes off on every route |
| Alternate screen | `ESC[?1049h` (crossterm EnterAlternateScreen; the chat arms it to the first draw's flush) | `altscreen::enter`/`enter_queued`: the chat first draw, the view mount (2179), the selector (579), the replay (92) | `ESC[?1049l`: `altscreen::leave` (the suspend stop + the parity flush 3855), `force_leave` (restore_terminal 78 — the unconditional last-line-of-defense) | no — left on every route |
| Cursor visibility | `ESC[?25l` (ratatui's frame-end hide; explicit hides at the chat resume 3813, the chat handoff 3990, the view mount 2242, the view handoff 2424) | every frame + the mounts | `ESC[?25h`: `restore_terminal` (81) + `terminal_release_tail` (107); ratatui's `Terminal` drop shows on the unwind order | no — visible at every exit (default-on semantics: the deviation is the hide, and it ends shown) |
| Synchronized output | `ESC[?2026h` (Begin) | `app.rs::draw` around every frame paint (292) | `ESC[?2026l`: the draw's End (332, written even on paint errors) + both exit tails (exit_restore 42/104) | no — the pending-update hold releases on every route |
| SGR (colors/attrs) | `ESC[..m` (every styled write; the exit flush's rows carry them) | everywhere | `ESC[0m`: both exit tails, after the flush | no — the attribute state is empty at every exit ("SGR ends at reset") |
| Raw mode (termios — invisible to the byte stream) | `enable_raw_mode` | the chat setup (3573), the resume (3803), the view (2170), the selector (575), the replay (88) | `disable_raw_mode` in both exit tails + the cooked-tty verification/repair | no — the pty's termios returns byte-equal on every route (the harness captures it before the spawn and compares after the exit) |
| OSC 8 hyperlinks | `ESC]8;;URL ST` open | `hyperlinks.rs` (frame paints + the exit-flush rows) | `ESC]8;; ST` close, paired inline per span | no — every open closed (the fixtures' URL rows exercise the pairs) |
| OSC 52 clipboard | `ESC]52;c;.. BEL` (one-shot; no mode state) | `session_ui/keys.rs` 274 | n/a (state-free) | n/a — counted per stream |
| OSC 133 shell-integration zones | `ESC]133;A/B/C BEL` (content markers; no mode state) | `osc133.rs` mark_start/mark_end on transcript rows | n/a (state-free) | n/a — counted per stream |

### Modes the product never writes (the forbidden set — any appearance in the differential is a finding)

| Mode | Sequence family | Status |
|------|-----------------|--------|
| Focus reporting | `ESC[?1004h/l` | never written; the ledger's negative control proves an unknown mode leaks are caught the day a future surface arms one |
| Cursor shape DECSCUSR | `ESC[N SP q` | never written (a finding if it appears) |
| Keypad DECKPAM/DECKPNM | `ESC=` / `ESC>` | never written (a finding if it appears) |
| Wrap DECAWM | `ESC[?7h/l` | never written (tracked with default-on semantics: a `?7l` without its `?7h` would fail) |
| Margins/origin | DECSTBM `ESC[t;br r`, `ESC[?6h` | never written (a finding if it appears) |
| Flow control | `ESC[?33h/l` | never written (covered by the generic DEC-mode tracking) |
| Window title | OSC 0/2 | never written (a finding if it appears) |
| Charset designations | `ESC(X`/`ESC)X` | never written by the product (US-ASCII `B` designations from a test runner's own reporter are benign — the terminal default) |

pa-cli's interactive surface writes only the resume-hint dim SGR pair (`ESC[2m ... ESC[22m`) after the restore — balanced inline; no other mode writes exist outside pa-tui.

### The exit routes (the parameterization — the enumeration shared with the kitty-exit-leak lane)

From the code: every restore site calls `exit_restore::restore_terminal` or `exit_restore::terminal_release_tail`:

1. **Parity exit** (chat): `Renderer::finish(preserve=false)` — enhanced-keys drain → mouse disable → enhanced-keys disable → the flush (altscreen leave + the inline transcript) → the release tail (interactive.rs 3946-4009). Drives: `/exit`, `/quit`, the Ctrl+C pair (a healthy loop), ctrl+d.
2. **The detach handoffs** (chat): `Renderer::finish(preserve=true)` — the drain-for-handoff, the mode disables, the cursor hide (3976-3996); modes stay on by design (the in-process handoff), and the adopting surface owns the release.
3. **The client-command suspend** (chat): `Renderer::suspend` (3780-3797) — mouse off → enhanced-keys off → the flush → the release tail; the resume re-arms.
4. **The SIGTSTP suspend** (chat): the same `Renderer::suspend` through `suspend.rs`'s cycle + the process-group stop; the SIGCONT resume re-arms.
5. **Agents view exit**: `Renderer::finish` (agents_view.rs 2406-2439): the preserve arm (disable + hide) or the real-exit arm (`restore_terminal` 2433).
6. **Agents-view error returns**: the roster-link failure behind a TUI-state handoff → the in-surface restore (2643) + the wrapper's idempotent pass (2617); any post-mount error → the wrapper restore.
7. **Chat error returns**: post-mount error → the wrapper restore (interactive.rs 1693, gated on mounted-or-altscreen); the PRE-mount daemon refusal restores NOTHING (nothing was armed — verified by the route).
8. **Picker exits** (config_selector.rs): Esc close (630); the exit action (a remapped `app.clear` → 615 + process exit); the toggle error (559); the panic (the unwind guard).
9. **Force-quit**: the watchdog's `force_quit()` — `restore_terminal` + `exit(0)` (exit_guard.rs 309-312).
10. **Panic unwind**: `SurfaceRestore`'s drop while panicking → `restore_terminal` (exit_restore.rs 148-165; armed in the interactive/agents-view/config-selector/replay surfaces).
11. **Replay surface exits** (app.rs run_app): the clean exit (170); the error (70); the panic (`--panic-exit`'s driver).

## Part 2 — the differential harness

`crates/pa-cli/tests/terminal_state_differential_e2e.rs`:

- **a recording mock terminal**: the harness reads the pty master non-blockingly and records every byte the child writes (the child is this same binary re-executed under the pty, `setsid`+`TIOCSCTTY`, a session per surface — chat, agents view, config selector, replay);
- **kitty-capable**: it answers the kitty capability query (`ESC[?u`) with `ESC[?7u ESC[?62;c` and requires the flags push as the arm proof;
- **the mode ledger**: a full escape-stream state machine — every DEC private mode (known AND unknown numbers; `?7`/`?25` carry default-ON semantics: the deviation is the `l` write), the kitty flags stack (push/pop/absolute-set), modifyOtherKeys (and any other `>N` modify form), a live SGR attribute set, OSC 8 open/close, and forbidden writes (DECKPAM/DECKPNM, DECSCUSR, margins, OSC 0/2 titles, non-ASCII charset designations);
- **the termios differential**: the pty's line discipline is captured before the child spawns and compared byte-equal after the exit — raw-mode leaks live here, invisible to the byte stream;
- **the assertion: THE MODE DELTA IS EMPTY** — the ledger's final state equals the pre-launch state (every `h`-armed mode has its `l`-partner on the exit write stream, every pushed kitty flag popped, SGR ends at reset) and the termios is byte-equal;
- **10 negative controls** drive the ledger directly with synthetic streams — the net's proof it catches each leak class (a leaked mouse mode, an unknown mode — focus reporting —, a default-on mode left off, a kitty re-arm after the final pop, an absolute kitty set, a dangling SGR, a dangling hyperlink, DECKPAM/DECSCUSR/title writes, modifyOtherKeys left armed);
- **13 parameterized routes** (one `#[test]` per exit route): the parity exit via `/exit`; the parity exit via the Ctrl+C pair; the detach handoff → the view exit; the force-quit watchdog from a loop wedged in a stalled daemon request; the agents-view fresh exit; the agents-view roster failure behind a preserved handoff; the picker close; the picker's remapped exit action; the picker's toggle error; the replay surface's clean exit; the replay surface's panic unwind; the pre-mount daemon refusal (which must arm nothing); and the suspend cycle (gated like the fleet's suspend e2es: the runner's session + a SIGTSTP stop-capability probe);
- plus the **late-kitty-answer** route: the probe's query answered inside the exit window — the stream must carry no kitty flags push after the exit began (the standdown contract the kitty lane's fix hardens; this route is the net over that window for every OTHER mode too).

Usage: `cargo test -p pa-cli --test terminal_state_differential_e2e`.

## The current-build run (what leaks TODAY)

**Verdict: NOTHING leaks beyond the kitty lane's one confirmed kitty-mode leak.** 12 of 13 driven routes pass byte-clean on the current build (the 13th — the suspend cycle — is environment-gated exactly like the fleet's existing suspend e2es; its release path is the same `Renderer::suspend` tail the parity route verifies). Specifically, on every driven exit route:

- mouse 1002/1003/1006: off;
- bracketed paste 2004: off;
- alt screen 1049: left;
- cursor 25: shown;
- synchronized output 2026: released;
- SGR: reset at the tail (attribute state empty);
- the kitty stack: depth 0, the pop is the last stack write; no flags push after the exit began (the late-answer window held on the repro);
- modifyOtherKeys: 0;
- OSC 8: every open closed; OSC 52/133 counted, state-free;
- the pty's termios: byte-equal to the pre-spawn capture (the cooked-tty verification found nothing to repair);
- the pre-mount refusal wrote NO mode bytes at all — the nothing-armed-nothing-restored contract holds;
- the forbidden set (1004 focus reporting, DECSCUSR, DECKPAM/DECKPNM, ?7 wrap, margins, titles): zero appearances.

The restore architecture is the reason: `exit_restore.rs` is a one-funnel contract (every route ends through `restore_terminal` or `terminal_release_tail`), `altscreen::force_leave` is an unconditional last line of defense, the kitty probe stands down before every exit, and the exit tails append the two unconditional bytes (`?2026l`, SGR reset) plus the cursor show. The harness now nets every future regression across that whole surface: any mode armed without its restore, on any exit route, fails the route's ledger.

**No non-kitty leaks to fix** — the mission's fix mandate is satisfied by the finding that the current build's restore set is complete; the fixes that landed in this lane are the harness's own bring-up corrections (default-on mode semantics for `?25`, the child-mode epilogue silencing so libtest's reporter cannot pollute the tape, and the mock supervisor's per-connection threads so the roster-failure route's listener shutdown refuses deterministically).
