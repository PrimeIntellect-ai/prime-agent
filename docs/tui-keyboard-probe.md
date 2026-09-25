# Keyboard capability on terminal startup

Prime Agent uses crossterm 0.28.1 for input. Its keyboard support query shares the event-reader lock with the app. Unanswered queries previously starved early keys for 2,000ms. A one-line vendored crossterm patch caps that query at 250ms, retaining crossterm’s own parser, filtering and typeahead queue. The existing same-harness 10-trial A/B measured launch-to-ready 2,212ms → 335ms and early-submit wire 2,053ms → 297ms, with all 60/60 trials valid (bounded-query binary SHA-256 `5192cc8c` prefix, commit `39a409e3c`).

## Decision

On the first terminal surface only, infer capability from **direct-terminal identifiers** before considering a query:

| Identifier | Terminal | Decision |
|---|---|---|
| `KITTY_WINDOW_ID`, `TERM_PROGRAM=kitty` | kitty | enable kitty flags without querying |
| `GHOSTTY_RESOURCES_DIR`, `TERM_PROGRAM=ghostty` | Ghostty | enable kitty flags without querying |
| `WEZTERM_PANE`, `TERM_PROGRAM=WezTerm` | WezTerm | enable kitty flags without querying |
| `TERM=dumb`, `TERM=linux` | dumb / Linux console | use legacy keyboard mode without querying |

These are terminal-specific process environment markers, not generic capability claims; generic `TERM=xterm*`, `COLORTERM`, `TERMINAL_EMULATOR`, and VS Code are **not** reliable enough to infer kitty support. Markers may be forwarded through a multiplexer or SSH even when escape replies are filtered: `TMUX`, `STY`, `ZELLIJ`, `SSH_CONNECTION`, `SSH_TTY`, and `TERM=tmux*`/`screen*` therefore force the ambiguous path even if a direct-terminal marker is also present. This is a conservative best-effort heuristic, not a security boundary or a claim that environment variables prove device identity.

An ambiguous terminal runs the already-proven crossterm query, with its 250ms cap. Ghostty replies were observed after **211–299ms** in the diagnostic A/B. The 250ms cap may miss that slow tail on ambiguous transports, while a 100ms cap would miss every measured Ghostty reply. A truly silent PTY still waits 250ms, but direct Ghostty with its identifier avoids the probe entirely. The env-scrubbed benchmark PTY is intentionally ambiguous; the new fast path does not apply to it, so the previous 60/60 A/B remains evidence for its unchanged worst-case path, **not** measured evidence for a speedup on real Ghostty. Terminal-specific PTY checks must verify fast-path timing and key delivery separately.

## Why not copy Codex’s probe

Codex batches cursor, OSC 10/11 colors, kitty and DA1 into one 100ms query; it can stop early once cursor, *both* colors and keyboard-or-DA1 have arrived. It still waits the full 100ms if there is no response. It reads tty bytes directly, then replays non-response bytes via `crossterm::event::buffer_input`; Codex uses a forked crossterm **0.29.0**, whereas Prime Agent’s stock **0.28.1 has no `buffer_input` API**. Copying the probe without porting that API would consume early keys, incomplete CSI, bracketed paste or UTF-8; switching crossterm/forking the parser substantially expands the change. Its 100ms deadline also misclassifies the measured Ghostty replies. The Codex probe suppresses completed OSC replies before replay; its reply completion is not a shortcut for silent PTYs.

The UI already launches and renders alongside the daemon while its existing background crossterm query resolves. Starting input immediately in legacy mode does **not** eliminate the crossterm reader lock: keys queued before a later kitty enable are parsed according to their original bytes, not retroactively reinterpreted; asking an independent reader to consume responses requires byte-accurate replay across incomplete escape sequences. The direct-terminal fast path avoids that race altogether for known terminals. Unknown terminals keep crossterm’s single reader and safe queue.

The same keyboard-mode stack applies on teardown and suspend/resume; after resolving support once, later starts reapply kitty flags without querying. No model-facing surface changes. The `tui enhanced keys` adoption event retains its existing primitive-only `kitty` and `modify_other_keys` properties.
