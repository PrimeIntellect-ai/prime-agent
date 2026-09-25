# pa-daemon

Session supervision and wire serving.

## Scope
ACP stdio transport (`acp`): the JSON-RPC serve surface for Agent
Client Protocol clients - a thin transport over the pa-core session engine
(initialize, session/new, session/prompt, session/close, session/cancel,
and the outgoing session/update notification with namespaced `_meta`
correlation), owned by this crate because wire-protocol serving is its area;
the in-process transport hosts the automatic compaction arms at its turn
boundaries (`acp/compaction_arms.rs`: the TS `_checkCompaction` /
`_runPreTurnCompaction` / `_consumePendingRequestedRefine` flows — the
overflow compact-and-retry, the model-requested arm, and the threshold
arm, publishing the ACP `compaction_end` mapping and aborting an in-flight
run on session/cancel+close; the daemon-attached transport runs the
worker turn loop's arms instead), because the TS arms live in the session
turn loop every transport shares and the in-process ACP path drives the
pa-core engine directly. The compact-trigger auto-refine scheduling owns
its surface here (`compact_autorefine.rs` for the daemon worker: every
compaction arm plus the manual `compact` command arm the pa-core
trigger, and the quiescent turn boundaries / the command path consume
the gated review - TS `_scheduleAutoRefineAfterCompaction` plus the
background `_maybeAutoRefine("compact")`; `acp/autorefine.rs` for ACP:
the serialized checkpoint consumes the armed trigger after the
requested refine.run and session close drains what no turn serviced -
TS's serialized scheduling for the acp app mode). The direct-ACP goal
continuation boundary owns its surface here too (`acp/goal_continuation.rs`:
the TS session's continuation hook `_getContinuationMessages` runs inside
the one `session/prompt` request on the in-process path — the goal arm with
exclusive priority over the autonomous arm, the budget-limit wrap-up steer,
the natural continuation mint per settled boundary, the terminal-error
goal failure, the threshold-arm goal queue before its compaction (with
the cancel rollback), and the compact-with-active-goal continue; the
daemon-attached transport rides the worker's #244 loop instead).
Supervisor process (one worker process per active session), restart/backoff
supervision, session registry/roster + worker self-registration (session
identity survives supervisor restarts: workers re-register with backoff and
the roster rebuilds), parent-death child cleanup (`supervisor_parent_death.rs`:
an unexpectedly exited worker's resident RLM children close with it - the
same plain-stop semantics as the worker-side #246 close, which SIGKILL
bypasses - via the durable create's `parentActiveSessionId` join), append-only session store ownership (including the
compaction-entry fold for compacted message reads), client attach/detach
(full-snapshot and chunked `session_snapshot_begin`/`chunk`/`end`
streaming), direct-attach transport (supervisor-issued single-use tickets
with a 10s TTL, worker-side peer grants burned on first use, session-plane
command gating on peer links), kernel agent_message/agent_observe bridge (`agent_messaging.rs`: the worker-side controllers over the supervisor link; the family view joins the supervisor roster with the session's own RLM children registry - the same registry `rlm.list_subagents` reads - so registry children are Child members addressable by name, RLM child id, and persisted session id, the spawning session is the Parent member for a subagent worker, and everything else stays a sibling; delivery tries the direct peer transport then the supervisor-routed `send_message`), worker-to-worker peer messaging (stage 3:
`worker`-purpose single-use grants minted by `get_worker_peer_transport`
for a source worker's kernel `agent_message.send`, direct
`worker_deliver_message` on the target worker's socket with the supervisor
routed `send_message` as the never-retried fallback), session archiving
(`session_archive.rs`: the sessions directory must not grow forever — a
supervisor boot sweep plus a periodic re-sweep at the TS idle-eviction
cadence retire sessions by age (settings `sessionArchiveMaxAgeDays`,
default 30) and count (settings `sessionArchiveMaxSessions`, default 200;
each rule independently off-able) by MOVING them into
`<agent-dir>/sessions-archive`; resident-worker sessions and sessions with
active scheduled jobs are never archived; an archived session stays
resumable — the catalog resolve falls back to the archive, restores the
file into the sessions dir, and the wake spawns over the live path),
saved-session wake
for non-resident `send_message` targets (`session_catalog.rs`: catalog
resolve by session-id prefix or exact name, cwd-scoped first, archived
fallback with restore; a resident
worker hosting the file is reused, otherwise one spawns over it; RLM
children fall back to the spawn ledger's live child edges when the catalog
misses - children persist outside the sessions dir, under the parent's
session-artifacts tree - and wake over their own session file), wire protocol serve/negotiation (including the
`compact`/`abort_compaction`/`set_auto_compaction` commands and their
`compaction_start`/`compaction_end` events, and the live
`set_model`/`set_thinking_level` commands — `model_switch.rs`: registry
resolution, the durable `model_change`/`thinking_level_change` rows, the
settings defaults, and the engine's live agent/provider-target/level
switch), session export commands (`session_export.rs`: the worker-side
`export_html`/`export_jsonl` handlers; the HTML data carries the engine's
tools section and custom-tool pre-render through the
`SessionEngine::export_tools`/`export_rendered_tools` seams, built
lazily when an export precedes the first turn - the TS state exists from
create), the `get_model_catalog` command (the TS `refreshModelCatalog`:
registry refresh — live Prime Inference catalog fetch, disk cache at
`<agent-dir>/prime-inference-models-cache.json`, bundled fallback — then
the full catalog minus unauthorized private models plus the configured
providers; the worker create path fires the same refresh at startup), the
agent-roster arms
(`roster_subscribe`/`roster_unsubscribe` with the full snapshot, live
`roster_update` pushes keyed by the TS roster `agentId` = session id, and
authenticated `worker_roster_delta` self-reports so live status reaches
subscribers without polling) plus the live-roster ledger seed (TS
`seedRosterLedger`, `supervisor_roster.rs`: passivated ledger descendants
of resident workers seed into the live roster - roots are the resident
session files, descent is membership at any parent-walk step, and
present rows by agent id or session file are never overwritten - at
subscribe, spawn-admission, and worker-stop moments, so subscribers see
the full family, not just resident rows), cloud sandbox attach, session
leases (`core/session-lease.ts` port). Daemon-owned RLM spawn ledger (`rlm_ledger.rs`):
one append-only JSONL per sessions dir (spawn/rename/delete admissions with
the TS `rlm-ledger.ts` record grammar, bounds, stat-guarded replay, and
legacy-registry seeding) plus the per-child display files; family topology
is read from the ledger, never re-derived from session files. Passive-RLM
roster walk (`rlm_roster.rs`): `list --all` and the saved-session catalog
merge non-resident ledger children (walk roots = saved + resident session
files), so passivated children stay roster-visible (TS
`walkPassiveRlmSubagents` / `withPassiveRlmDescendantInfos`). The saved
session scan (`session_store.rs`) folds each file once into the durable
catalog row, including the agents-view search corpus the TS scan builds:
the capped `allMessagesText` transcript text (64 KiB). Archived sessions live in
`<agent-dir>/sessions-archive` and never reach the catalog scan, so search
covers live sessions only.
Supervisor-backed RLM child sessions
(`rlm_children.rs`, the daemon side of the pa-core `RlmSubagentHost` seam):
`rlm.spawn`/`rlm.create_session` create real daemon sessions through the
worker's supervisor link - one supervised worker process per child - and the
parent-side registry serves `rlm.list_subagents`/`rlm.collect`/
`rlm.delete_subagent` with TS-parity selector errors; child model resolution
and thinking-level validation live in `rlm_child_model.rs`; the create
command carries the RLM recursion identity (`rlmDepth`/`rlmMaxDepth`/
`parentSessionPath`/`thinking`) so respawned children keep their depth. Per-session model binding: the
create-config `provider`/`model`/`apiKey` are authoritative for worker model
resolution (explicit CLI flags reach the worker; env remains the no-flag
fallback). Worker session files carry the TS creation prefix
(`model_change`/`thinking_level_change`/`service_tier_change`), and queue
snapshots persist to the worker recovery journal, not the session file.
Queue-lane command surface (`queue_commands.rs`): the full TS
`DAEMON_COMMAND_TYPES` accept list with exhaustive router tables in
`protocol.rs` (see `docs/protocol-breadth-audit.md` for the staged breadth
plan), plus the worker's `mutate_queued_message`/`resume_queue` arms
(`AgentSession.mutateQueuedMessage`/`resumeQueuedWork`: preview-addressed
delete/move/replace over the two lanes with the TS status vocabulary, and
the empty-queue resume refusal).
Prompt attachments: the `prompt`/`steer`/`follow_up` wire `images` array
(base64 payload + mime type) rides the queue item into the session engine
as multimodal user content (images on a queued prompt do not survive a
worker respawn - the recovery journal keeps the text lanes only, the TS
command-recovery shape).
Eager turn abort (TS `requestAbort`'s closing `agent.abort()`): every
worker abort surface — `abort`/`abort_and_clear_queue`, the compaction and
branch-navigation interrupt-and-settle waits, shutdown, kill, and the
`cancel_prompt_admission` cancel-owned arm — funnels through
`SessionEngine::abort_in_flight_turn` (the engine's build-time agent
mirror), so an abort landing mid-provider-wait cancels the in-flight fetch
immediately and the aborted turn settles on its zero-usage aborted message
(the usage-accounting parity of the #238 adjacent gap 3 fix; the transport
half is pa-core's provider-adapter cancellation token).
Queued-input suspension (TS `_sessionInputPumpSuspended`, the #227/#233
ruling — see PORTING-NOTES.md): `abort`/`abort_and_clear_queue`/manual
`compact` suspend queued-input admission indefinitely; while suspended a
plain `prompt`/`prompt_and_wait` is rejected with the TS admission error
and the lanes park. Resume sites: a prompt carrying `streamingBehavior`,
`steer`/`follow_up`, `resume_queue` (even on the empty queue), an applied
`mutate_queued_message`, a cron/heartbeat fire, and a successful compact
with an active goal. Agent-message delivery is rejected while suspended
and idle (TS `acceptAgentMessagePrompt` runs with `resumeIfIdle: false`).
The compact-with-active-goal resume is also the TS post-compaction
continue (agent-session.ts `compact()`'s `didCompact` branch): with no
queued work parked, the worker mints the owed goal continuation through
the engine (`SessionEngine::mint_post_compaction_goal_continuation`, the
`_maybeResumeGoalContinuationAfterRlmWork` mint — the follow-up lane item
with the durable goal-context row), emits the mint's `goal_update`, then
resumes: the parked continuation crosses the suspension gate through the
resume site and the turn runner drives it (the `_schedulePostCompactionContinue`
schedule). The compact-trigger auto-refine defers behind that continuation
(TS `_compactAutoRefinePending`), servicing at its turn boundary.
Thread-goal durability (TS one-store parity): every `goal_update`
announcement mirrors the new state as a `thread_goal_state` custom row in
the worker session file (the turn emit closure; the compact mint persists
its row at the mint site, outside a turn), and the engine's session-build
adoption rehydrates the fresh goal driver from the moved branch's or the
session file's latest valid `thread_goal_state` entry
(`goal_state_persist.rs`) — status, objective, usage counters, and
continuation counts continue across a worker-recovery rebuild, and the
seeded published baseline keeps the rehydrated state from announcing
itself (TS loads at construction without emitting). Recovery branch
rebuild (TS one-store parity): the owned-session worker respawns with
`--resume <sessionFile>` (`createRpcRecoveryArgs`), so the rebuilt
session's branch is the durable history — while the Rust worker owns the
file writes and the engine keeps an in-memory manager, the engine's
session-build adoption rebuilds the branch from the worker session file
(the `pending_branch` seam's recovery twin), so a post-recovery compaction
walk (and the live loop context) reads the full durable history instead
of a fresh engine's empty branch skipping "Session is too short to
compact". Platform wall
(`platform`): per-OS endpoint naming and socket identity; the transport itself
is the shared trait in `pa_types::platform::transport`, and the private-frame
codec plus command planes are the shared wire contract in
`pa_types::daemon` (clients in pa-tui/pa-cli speak them).

Live token-stream rendering
(`streaming`): turn events forward from the hosted engine to the worker's
emit path as they arrive (one `message_update` per provider delta, the
full partial message per frame - never buffered until turn settle); the
worker coalesces them for broadcast in a single-slot coalescer with a
50ms flusher, while `message_start`/`message_end`/tool frames flush the
parked update first and go out directly, so wire order and event-sequence
order match uncoalesced streaming. The supervisor stays payload-free:
deltas ride the worker -> client session-event stream (direct-attach or
supervisor-routed). Verifier: `scripts/battery/streaming_render.py`
(pane-growth acceptance + TS settled-frame differential).

Autonomous
continuation driving in the worker's engine: per-message usage accounting
runs in the agent-loop subscription, and the in-run continuation hook
(`autonomous_continuation.rs`) consults the pa-core `AutonomousDriver`
policy at the agent loop's natural turn end (product default: shell
quality gates in the session cwd; deterministic drivers injectable for
eval harnesses) — continuations mint as durable user rows churned
inside the one prompt wait (the TS `getContinuationMessages` shape), a
threshold compaction holds its minted continuation for the worker's
queued `followUp` admission, and gate pass/fail or limit stops surface no
row (the headless status request and the print exit contract carry
them).

Live MCP product-path verifier
(`tests/mcp_product_path_e2e.rs`): a settings-declared stdio MCP server
round-trips through a real worker session and kernel - the kernel cell's
`mcp.list_tools`/`mcp.call_tool` resolve `mcp.config` through the
session's host handlers, spawn the fixture
(`tests/fixtures/mcp_echo_server.py`), and echo back.

Update-prepare transaction (`update_prepare.rs`, spec
`docs/update-flow-state-machine.md` §5): the supervisor-side FSM
`Draining -> Fenced -> Snapshotted -> Prepared -> Stopping` with the
mutation-drain latch + admission gate (mutating commands refused with
"Daemon is preparing an update restart" while active; reads/attach and the
TS abort-family drain commands stay served), the hard prepare deadline
(90 s default) and the durable 45 s marker self-expiry as watchdogs — both
re-checked on a timer and on any later command — idempotent
`prepare_update_restart` on `updateId` (a different id is a typed refusal
the coordinator maps to Join), and `Aborted -> Serving` with prepared-dir
cleanup as the failure default. The prepare RPC drives accept
through the mutation drain to `Fenced`, snapshots every resident worker
(`update_snapshot`, `worker.rs`), assembles the roster (`update_roster.rs`:
sessions/workers/subagents from the ledger + displays, heartbeats as a
read-only `scheduled-jobs.json` projection), writes
`prepared/<id>/{roster,marker}.json` durably, and acks `Prepared` — all
inside the prepare budget. `commit_update_restart` consumes the
transaction (`update_stop.rs`): the acked worker `shutdown` (its handler is
the flush barrier) with the 30s + 30s budgets, abandon-on-refusal (the
supervisor resumes `Serving`, refused sessions untouched, stopped workers
relaunched — never a kill), or the update exit when all workers stopped
(descriptors survive for the new supervisor's create-or-adopt restore).
The new supervisor's boot owns the update's restore side
(`update_restore.rs`, spec §6): it consumes `PRIME_AGENT_UPDATE_ROSTER`
from its spawn env before the unconditional scratch-dir sweep (this
socket's `update-restarts/` subtree plus the TS-era legacy names — no
liveness checks, no exceptions), then restores the roster rows bottom-up
(create-or-adopt; per-session failure records, restore never fails the
boot), re-arms scheduled work (a boot scan of `scheduled-jobs.json`;
due active jobs of sessionless files are woken once, never archived), and
reports the pass over `update_restore_status` while `hello.update_resume`
carries the settle state; client attaches to a not-yet-restored roster row
queue behind the pass instead of failing. The heartbeat-catalog change
broadcast owns its surface here too (the worker's cron-store
`on_heartbeat_change` listener emits a `heartbeats_changed` outbound frame
— TS daemon-mode's `broadcastGlobal` — and the supervisor re-broadcasts it
to every client, so any heartbeat mutation anywhere in the daemon reaches
attached UIs daemon-wide).

## Non-goals
No agent behavior inside workers beyond hosting a pa-core engine; no UI.

## Public API
Supervisor entrypoint, worker entrypoint, `mcp_login::{WorkerMcpLoginUi, wire_worker_mcp_login}` (the worker's browser+callback login behind `mcp.begin_login`; wired by the agent engine before sessions register host handlers), client connection API for pa-tui/pa-cli, `acp::{run_acp_mode, AcpOptions}` (pa-cli dispatches `--mode acp` through it), `agent_messaging::LinkAgentMessageController` + `rlm_children::{SupervisorChildSessions, ParentIdentity, RlmChildIdentity}` (e2e verifiers construct the worker-side family controller and the children registry; the engine wires the same types), `agent_engine::AgentSessionEngine::dispose_kernel` (the session-end kernel teardown the worker invokes at kill/shutdown/orphan exit — the engine outlives the session, so the pa-core engine-drop teardown cannot run there), the worker's `get_mcp_connections` command (`mcp_connections.rs`: the `/mcp` view's roster from the session's MCP manager overlaid with the session kernel's per-server tool listing — Rust-native session-plane extension; the TS daemon has no counterpart). Supervision internals `pub(crate)`.


## Depends on
pa-types, pa-core (one-way).
