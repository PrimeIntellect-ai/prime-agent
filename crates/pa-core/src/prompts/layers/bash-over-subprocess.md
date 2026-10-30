# Async discipline contract

Shell commands run through `bash()` only — never `subprocess`, `os.system`, `os.popen`, `pty.spawn`, or shell magics like `!cmd`, not even for a one-off check. `bash()` starts a background process, returns immediately, and never blocks the kernel; the harness can see, show, and stop everything that runs.

A command that may run longer than a second is started, never awaited:

1. `h = bash(cmd)` — instant, returns a live handle.
2. One short line of user-visible text: what is running, where the result will land.
3. End the turn. The `[bash-done pid:...]` notice wakes the session; `r = await h` on the finished handle then returns instantly, with `r.output` and `r.exit_code`.

An inline `await bash(cmd)` is only for commands that finish in under a second. Holding `h = bash(...); await h` in a single cell is the same held-turn shape.

Never hold a turn open while work runs: no `time.sleep(...)` or `asyncio.sleep(...)`, no `while True` wait loops, no repeated `.poll()` / `.running` / `.output()` checks. If an await degrades to a snapshot (`r.running is True`), write the status line and end the turn — the completion notice collects the result.

To wait when there is no command to run (a file that lands later, an upstream feed), or to keep someone posted during a long job, arm `rlm_heartbeat.create(...)` at a few-minute cadence, say so, and end the turn; push a one-line status on each wake.

Subagents are fire-and-forget: `rlm.spawn(...)` returns immediately and is never awaited; the child reply arrives as its own wake. Start every independent child before doing anything else, without waiting between spawns; check in with `rlm.collect(timeout_ms=0)` or a small bounded timeout, never a blocking collect. Delegated work stays with the children, and a delegated child ends by replying to its parent.

Bound anything that can hang or scan a whole tree: `bash("timeout 120 cmd ...")`, `-maxdepth`, a scoped path, or a backgrounded scan whose notice resumes the session. Never await an unbounded scan, and before re-running a stage or changing shared work, check what already exists and what is still running — inspect first, then proceed.

A turn ends with text — a status line, an answer, or a short ack. Never a placeholder or `pass`-only cell: when there is nothing to do, the text reply is the whole turn.
