## The re-adoption wake paths: a background bash completion must wake its session — across a supervisor restart that re-adopts the worker

**The bug (the macos-tty-sane takeover finding, relayed by the controller):** after a daemon supervisor restart re-adopted a live worker, its scheduled/notify wakes never fired — the frozen worker had a detached background `bash()` (a base-gates watcher) running; the watcher process exited at 18:18:13Z having written its `BASE_GATES_DONE` marker, and the session stayed asleep forever: no heartbeat, no steer path, invisible-but-alive.

**Root cause:** the port had **no kernel host handlers for `bash.completed`/`bash.consumed` at all**. The kernel runtime (`prime-agent-runtime` `bash.py`) arms a notice task for every detached background `bash()` whose creating cell ends before the command settles; when the process finishes with its result unconsumed it sends the `bash.completed` host request. The TS session answers it (agent-session.ts `_createKernelHostHandlers`'s `bash.completed` arm → `createAsyncBashCompletionMessage` → `_promptInjectedMessage(..., { streamingBehavior: "steer", queueIfBusy: true, resumeIfIdle: true })`): a busy session queues the `[bash-done pid:N exit:M]` notice as a steering row, an idle session wakes into a new turn that runs on the row. The Rust daemon answered every `bash.completed` as an unavailable host request, so a background command finishing after its turn **never** woke a session — the supervisor restart is where the fleet caught it (the worker and its kernel survive supervisor death, so the frozen-waiter shape is exactly the re-adoption window).

### The port (every piece cites its TS site)

| TS site | behavior | Rust port |
|---|---|---|
| `createAsyncBashCompletionHostHandler` (rlm-runtime.ts) | validated details: positive integer pid, non-empty string command, integer exit code | `bash_notices.rs::validate_completion`/`validate_consumed` |
| `createAsyncBashCompletionMessage` (messages.ts) | the `[bash-done pid:N exit:M]` `async_bash_completion` custom row, `display`, details `{pid, command, exitCode}` | `pa-core session_engine::messages::create_async_bash_completion_message` (+ the custom-type/preview-label constants; parity test included) |
| the `bash.completed` arm's `_promptInjectedMessage` options | queue-if-busy (visible steer row), resume-if-idle (invisible injected wake) | `admit_bash_completion_notice`: steering lane, `queue_visible`/`TurnPolicy` from `core.busy`, the `work_notify` wake |
| `injectedMessagePreviewLabel` → `ASYNC_BASH_COMPLETION_PREVIEW_LABEL` | the queue row reads `Background command finished: <content>` (the TUI already renders the labeled prefix) | the queued item's `preview` |
| `bash.consumed` → `_withdrawAsyncBashCompletionNotice` | the kernel read the result first: the undelivered notice cancels (pid+command — pids are reused) | `withdraw_bash_completion_notice` over both lanes + the settle checkpoint |
| `_disposed`/`session_closed` gates | a closing session admits no injected work | the sink's `session_is_closed` refusal (weak engine ref — the engine holds the sinks, so the sink must not pin it) |
| the action store's crash replay (`restoreSessionActions`) | a queued notice survives a worker crash and replays | the recovery-journal queue-snapshot checkpoint at admission (`steer_queued` busy evidence; the revived worker's create replay restores the lanes) |

### Why the wake now survives re-adoption and revival
- **Adopted-live workers** (the incident): the handler, the sink, the kernel, and the runner all live in the worker process — a supervisor restart never touches them; the notice fires, admits, wakes.
- **Revived workers** (the worker died after the notice queued): the admission's queue-snapshot checkpoint is busy evidence, so the adoption relaunches the worker and the create replay restores the lane — the queued notice delivers. (A command still running when its worker dies loses its kernel notice task entirely — TS parity: the notice task is kernel-process state.)
- **Scheduled fires** (heartbeats): the worker's in-process scheduler keeps firing across the restart — verified by the e2e's heartbeat-across-restart variant. The supervisor's boot re-arm (`rearm_scheduled_wake`, #2592's gates) covers workerless saved sessions; the continuous `recomputeScheduledSessionWake` timer stays a recorded slice-5 scope cut (owned by the scheduled-wake family lane).

### The scheduled-fire arm: the cron scheduler's timer death (live evidence)

Two live captures. (1) 2026-09-23T20:30Z: the governance session's `*/2` follow-up heartbeat (`bac7ba7a`) rows as ACTIVE in both registries (kernel `rlm_heartbeat.list` and daemon `cron_list`) with `nextRunAt` frozen at its 17:46 creation value and `runCount` 0 — the worker's scheduler never claimed it, across the 19:10-19:12 supervisor restart that re-adopted the (still-live) worker; the session only woke on external nudges. (2) 2026-09-23T21:00Z: the operator's RECREATED beat (`8c991e0e`, fresh registration ~20:44Z on the same live worker) is equally frozen — `nextRun` 20:38Z passed, `runs: 0`, `lastRun: None`, no wake delivered: a fresh registration's mutation wake cannot revive the dead machinery, confirming the death is in the worker's scheduler (not the old job's row) and that no self-heal exists before this fix. (3) 2026-09-23T21:02Z, the controlled experiment: a fresh registration with a VERIFIED FUTURE `nextRunAt` (`8bb99814`, created 21:01:37, due 21:02:00 — correct in `scheduled-jobs.json`) never fired; at 21:02:47 the row still sat at its creation values (`updatedAt` 21:01:37, `runCount` 0, `lastRunAt` null, no claim). The store's write path is healthy (every recreated job computed a correct future run at creation); the claim/fire path is dead — the timer death, exactly. Two structural death vectors in `pa-core/src/cron/scheduler.rs`, both hardened:

- **The timer task died on the empty store** (`next_active_run_at() == None → return`): a store whose active set emptied mid-life killed the timer task with no replacement, and a later mutation's `wake()` notified a `Notify` with no waiter. The fix parks the task on the wake notify instead of exiting — the TS `recomputeScheduledSessionWake` shape (every recompute arms a fresh timer), so a parked timer always re-arms and an adopted worker's due fires survive.
- **The run-pass re-entrancy flag** (`running`) had no panic guard: a claim or dispatch that unwound wedged it at `true`, silently no-oping every later pass while the timer kept spinning. A drop guard resets it however the pass ends.

Regression: `a_panicking_dispatch_does_not_wedge_the_run_pass` + `the_timer_parks_on_an_empty_store_and_re_arms_on_wake` (pa-core scheduler tests).

### Verifiers
- `crates/pa-daemon/tests/readoption_wake_e2e.rs` — the deterministic repro, both arms:
  - **The notify path:** a live-kernel session (mock OpenAI provider via models.json, `PA_E2E_KERNEL_PYTHON`) runs a real `bash()` cell (`sleep 12`), the turn settles, the supervisor is **killed -9 and relaunched** (the worker is re-adopted mid-bash-completion-wait), the watcher exits — and the wake asserts: the `async_bash_completion` row persists, the `[bash-done pid:N exit:M]` turn runs to its reply.
  - **The scheduled wake:** an `every 5s` heartbeat on a scripted session keeps firing across the same kill -9 + relaunch (the row count grows past the pre-restart snapshot).
- Unit: the row-builder byte parity (pa-core), the notice admission lanes + busy evidence + the consumed withdrawal + the busy-session visible row + the mismatched-withdrawal keep (worker), the handler validation contract (bash_notices).
- Live red/green repro: `.scratch/repro_readoption_wake.py` — the same scenario against a binary; red on the pre-fix build (`WAKE_MISSING`, no `async_bash_completion` row), green on this branch's build (`WAKE_OK`).

### Ownership compliance
- `pa-core` + `pa-daemon` only. `bash_notices.rs` is the new module (the handlers + validation); the rest are seam-local edits in the owning files (`messages.rs` row builder, `agent_engine.rs` fields + registration, `worker.rs` sink wiring + the admit/withdraw + the tests, `engine.rs` the sink types). No new shared wire types (the notice rides the existing kernel host-request surface; the custom row reuses the existing CustomMessage shape the TUI already renders — pa-tui needs nothing).

### Telemetry
No new user-visible surface: the wake is the injected `[bash-done]` row TS already emits (and the Rust TUI already renders); TS emits no telemetry for the completion notice, so none is added (parity beats invention).

### Known base-red (pre-existing, not this PR)
None introduced; the VM gate triage follows the fleet's standing environmental-failure classification.
