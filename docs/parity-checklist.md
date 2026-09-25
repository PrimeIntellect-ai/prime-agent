# Remaining-parity checklist

Audit of the TS product surface vs the Rust crates, per candidate. Status:
`done` (verifier proves it), `partial` (surface exists, behavior gap), `missing`
(not implemented). Evidence cites TS paths under `~/prime-agent` (read-only
ground truth) and Rust paths in this repo. Wire goldens come from the live TS
daemon (`/tmp/prime-agent-1000/daemon.sock`, protocol 7, schema 28) captured
with read-only `get_*` commands.

## 1. Session-info scan/list machinery - partial

TS: `packages/coding-agent/src/core/session-manager.ts` `SessionManager.list`
(L2449, cwd-filtered) / `listAll` (L2468) over `listSessionsFromDir` with
incremental per-file scan state (`foldSessionScanLine`, session scan queue) and
streaming `onProgress`/`onSession` callbacks.

- done: daemon surface. `crates/pa-daemon/src/supervisor.rs`
  `handle_saved_session_list` streams `session_list_item` +
  `session_list_progress` events then the final response (TS
  `handleSavedSessionList` parity); `crates/pa-daemon/src/session_store.rs`
  `read_session_info`/`list_sessions` extract the row fields.
  Verifier: `crates/pa-daemon/tests/supervisor_e2e.rs` asserts the event
  sequence and saved-session row shape against live-TS goldens (commit #58);
  `list --all` summary rows differentially asserted (commit #56).
- done (was the CLI seam gap): the pa-cli daemon client (#67) wires the
  saved-session scan to users. `crates/pa-cli/src/daemon_command.rs`
  `run_daemon_command` connects to `~/.prime/agent/daemon.sock` and serves
  `list` (`--all`/`-a`, `crates/pa-cli/src/daemon_command.rs` L151-184),
  `kill`, `rename`, `send`, and `cron`/`schedule`;
  `crates/pa-cli/src/daemon_session_list.rs` renders the rows. The `agents`
  view entry point is parsed (`explicit_agents_view`,
  `crates/pa-cli/src/public_command.rs` L148) but its mode rides the
  unmerged agents-view lane.
- partial (perf only, no behavior gap): TS scans incrementally (chunked reads +
  per-file fold state) while `read_session_info` re-reads whole files; row
  output is identical, so this is an optimization follow-up, not a parity bug.

Follow-up spec (CLI lane): landed in #67 (daemon client + daemon-backed
commands); only the `agents` view entry point still waits on its lane. The
supervisor side was already parity-tested.

## 2. Extensions / package-manager - partial (CLI half done)

TS: `packages/coding-agent/src/core/package-manager.ts` (2443 LoC: install/
remove/update of npm/git/local packages, settings `packages` records, and
session resource resolution) plus the extension runner under
`packages/coding-agent/src/core/extensions/` (loader.ts/runner.ts/types.ts,
~3.3k LoC, jiti-based TS module loading).

- done: the package-manager CLI subsystem. `crates/pa-core/src/packages/`
  ports install/remove/list/update for `npm:` (npm CLI child process via the
  `npmCommand` setting, global root via `npm root -g`, bun `pm bin -g`
  special case), git (`git clone`/`checkout`, fetch/reset/clean updates,
  remove with empty-parent pruning, GIT_TERMINAL_PROMPT=0 remote probes),
  and local-dir sources (bind by path, settings stored relative to the
  settings base). Settings mutation goes through
  `SettingsManager::set_packages`/`set_project_packages` (field-scoped
  merge into the current file; a scope whose file failed to parse is never
  written). Source parsing matches TS exactly, including the quirks:
  `git://host/path` parses as a LOCAL path (the `git:` prefix strips the
  protocol), shorthand only with the `git:` prefix, hosted shortcut forms
  (`github:`, `gitlab:`, `bitbucket:`, `gist:`), and `#`/`@` ref pinning
  (pinned packages never auto-update).
  `crates/pa-cli/src/package_command.rs` runs every subcommand to
  completion: `install`/`remove`/`list`/`update [source]`, progress lines,
  `Installed`/`Removed`/`Updated` output, "No matching package found"
  errors with suggestions, and settings-load warnings
  (`Warning (package command, <scope> settings): ...`).
  Verifier: `crates/pa-cli/tests/package_e2e.rs` drives a 25-step corpus
  (local-dir, npm-shim, git-ssh-shim fixture) against BOTH the TS binary
  and the Rust binary and asserts identical stdout/stderr/exit codes after
  path/hash normalization, plus direct Rust-sandbox assertions (settings
  documents, npm project prefix, git dir pruning). No network is used;
  npm-network behavior needs no `#[ignore]` marker because the shim covers
  the flows offline.
- missing (typed boundary): Prime Agent self-update - the `prime-agent
  update` / `package update --self` half needs the native release plan
  (`cli/native-update.ts`, release manifests, rollback) and the daemon
  update-restart coordinator (`cli/daemon-update-restart.ts`). The Rust CLI
  reports a typed "self-update is not available in this build yet" error
  until that lane lands.
- done: resource resolution (`resolve()` -> `ResolvedPaths`).
  `crates/pa-core/src/packages/resolve/` ports `DefaultPackageManager
  .resolve()`: precedence-ranked resolution of extensions/skills/prompts/
  themes from configured packages (pi manifest in package.json, convention
  dirs, filter patterns with the `!`/`+`/`-` override forms), settings
  top-level arrays (paths relative to the settings base, `applyPatterns`),
  auto-discovery (`<base>/skills|prompts|themes|extensions` dirs,
  `.agents/skills` ancestor scan up to the git root, pi-mode SKILL.md
  stopping rule, `.gitignore`/`.ignore`/`.fdignore` rules), and bundled
  skills (exe-adjacent `skills/`, websearch + builtin-override excludes).
  First-wins collision order sorts by the TS `resourcePrecedenceRank`
  (project settings > project auto > user settings > user auto > package >
  builtin); dedupe by canonicalized path (symlinked trees resolve once).
  `resolveExtensionSources` covers the CLI-extension temporary scope with
  auto-refresh of unpinned temporary git sources; missing configured sources
  install on resolve unless offline (or skipped via the on-missing policy).
  The resource loader (`crates/pa-core/src/resources`) consumes the enabled
  paths and provenance (SourceInfo) so sessions see package-provided
  skills/prompts; extension *paths* are resolved and surfaced for the
  extension-runner lane.
  Verifier: `crates/pa-core/src/packages/resolve/tests.rs` (54 ported TS
  test cases: settings entries, auto-discovery, ignore files, symlinks,
  pattern forms, package dedupe, offline/missing-source policies, bundled
  skills) plus `crates/pa-cli/tests/package_resources_e2e.rs`: a
  settings-configured fixture package provides a skill that appears in a
  created session's skill list through the full binary pipeline.
- descoped (operator decision 2026-09-17): the extension runner. Stages 1-2
  of the sidecar host (`docs/extensions-runner-design.md`) landed harmlessly;
  stages 3-6 (event surface, commands/keybindings/UI, reload, failure policy)
  will not be built. Rationale: skills + the Python kernel packages are the
  product extensibility story; models.json covers custom providers; only one
  builtin extension exists (herdr-agent-state); the pi-ecosystem plugin
  surface is not a product requirement. See `docs/completion-matrix.md`
  family 13.

Follow-up spec - resource resolution (LANDED in #75; kept for history):
port `DefaultPackageManager.resolve()`: precedence-ranked resolution of
extensions/skills/prompts/themes from (a) configured packages (pi manifest in
`package.json`, convention dirs, filter patterns with `!`/`+`/`-` override
forms), (b) settings top-level arrays (paths relative to the settings base,
`applyPatterns` enable/disable), (c) auto-discovery (`<base>/skills|prompts|
themes|extensions` dirs, `.agents/skills` ancestor scan up to the git root,
pi-mode SKILL.md stopping rule), (d) bundled skills with the websearch and
builtin-override exclude patterns. Consumers: `crates/pa-core/src/resources`
(resource-loader.ts) and startup notices (`check_for_available_updates` +
`modes/shared/startup-notices.ts` - already ported on the manager).
First-wins name collision resolution sorts by the TS `resourcePrecedenceRank`
(project settings > project auto > user settings > user auto > package >
builtin); dedupe by canonicalized path. `resolveExtensionSources` (temporary
scope + auto-refresh of unpinned temporary git sources) belongs to this port
as well.

Follow-up spec - extension runner (design lane, needs a runtime decision):
TS extensions are TypeScript/JS modules loaded with jiti into the agent
process (loader.ts aliases `@earendil-works/pi-*` packages into the built
dist), exposing lifecycle hooks and custom tools through `ExtensionRunner`.
A Rust process cannot import TS modules; the port needs a deliberate host
design before any code: either a sidecar JS runtime (node/bun subprocess with
a typed RPC surface mirroring `extensions/types.ts`), or a wasm/plugin
contract, plus the resource loading of resolved extension paths from the
resolution lane above. Surface to preserve: the `pi.extensions`/
`extensions/index.ts|js` discovery conventions and the extension event
surface consumed by sessions (`BeforeProviderRequest`, `AgentEnd`, custom
tools, slash commands, keybindings). This is the largest remaining gap in
the extensions area and blocks only extension-authored content, not the
package install/remove flows landed here.

Update: the host design decision landed as `docs/extensions-runner-design.md`
(sidecar node runtime with a typed RPC surface; discovery ports to Rust, the
TS module surface is preserved by the sidecar host script, staged plan with
per-stage verifiers inside).

Update: stages 1-2 landed (verifiers in `crates/pa-core/tests/extension_host.rs`
and `extension_runner.rs`); the rest was descoped by the operator decision
above - the historical spec below no longer gates any lane.

## 3. Side questions (`side_question_transcript`) - done

TS: `packages/coding-agent/src/core/side-question.ts` (startSideQuestion:
second LLM turn over `previousTurns` with its own retry policy, events
`side_question_event`), daemon handlers `daemon-mode.ts` L4730
(`start_side_question`/`abort_side_question`).

- done: `crates/pa-daemon/src/protocol.rs` `KNOWN_COMMAND_TYPES` accepts both
  commands and routes them (`command_active_session_id` +
  `command_type_name`); the worker runs them
  (`crates/pa-daemon/src/worker.rs` `handle_start_side_question` /
  `handle_abort_side_question`: TS error strings, one live run per client per
  session, abort by owner, runs aborted on detach/kill). The turn behavior is
  one extra `SessionEngine::run_side_question` call per run:
  `crates/pa-daemon/src/engine.rs` (seam + `side_question_event` wire values),
  `ScriptedEngine` (scripted side-question provider calls with a scriptable
  retry policy), and `AgentSessionEngine` over
  `pa-core::session_engine::side_question::run_side_question` (conversation
  clone with the KV-cacheable prefix preserved, tool block, turn cap, retry
  policy from `pa-core::session_engine::provider_retry`).
- done: verifier. Unit: retry-policy decisions + driver
  (`pa-core provider_retry`), side-thread clone/replay/retry/abort/tool-block
  (`pa-core side_question`). E2e:
  `crates/pa-daemon/tests/supervisor_e2e.rs`
  `side_questions_start_abort_and_events_scripted` (scripted engine, asserts
  TS error strings, event sequence running->complete, abort -> cancelled).
  Differential against the live TS daemon (protocol 7): `start_side_question`
  response shape, guard errors ("Side question already exists: <id>", "A side
  question is already running for this client and session", "Unknown active
  session: <id>"), `abort_side_question` `{aborted: false}` for unknown ids /
  `{aborted: true}` for live runs, and the live event stream
  (running empty answer -> running partial -> complete; abort -> cancelled with
  the partial answer).

## 4. Chunked snapshot streaming - done

TS: `daemon-supervisor.ts` `streamSnapshot` (L5413) +
`createStreamedAttachResult` (L5397), `daemon-mode.ts`
`snapshotTransferId` + `createSnapshotTranscriptChunks`
(`snapshot-transcript-cache.ts`, `SNAPSHOT_TARGET_CHUNK_BYTES` = 512 KiB):
when the client advertises `chunked_snapshot`, the attach response omits the
transcript (`messages` arrays emptied, `snapshotStream` descriptor added)
and the snapshot streams as `session_snapshot_begin` /
`session_snapshot_chunk` / `session_snapshot_end` records, one message
array per record under the byte budget, ids shared across response and
records.

- done: `crates/pa-daemon/src/snapshot_stream.rs` (chunking, streamed-result
  rewrite, event/failed record construction, capability normalization);
  `crates/pa-daemon/src/supervisor.rs` routes attach/reattach for chunked
  clients through it; legacy clients keep the full snapshot in the response.
  The attach result now echoes the client's own capability set (live TS
  golden; previously the supervisor's worker-facing set leaked).
- verifier: `crates/pa-daemon/tests/supervisor_e2e.rs`
  `chunked_snapshot_attach_streams_begin_chunk_end` (scripted 700 KB
  transcript -> multi-chunk stream; reassembled transcript equals the
  legacy client's full snapshot; snapshot id is
  `<activeSessionId>-<generation>-<sequence>` from the event cursor) +
  unit tests in `snapshot_stream.rs` (budget, oversized-message, failed
  path, capability normalization). Live-TS golden:
  `crates/pa-daemon/tests/goldens/chunked-attach-live-ts.json`, captured
  read-only from `/tmp/prime-agent-1000/daemon.sock` (10-message session ->
  1 chunk; 2219-message session -> 5 chunks of <= 512 KiB; client
  capability echo; purpose `attach`).
- design deviation (PORTING-NOTES): the Rust supervisor materializes the
  whole snapshot before writing the streamed response, so the TS async
  abort/reservation machinery collapses into the synchronous dispatch;
  a malformed worker transcript surfaces as `session_snapshot_failed`
  after the response, a snapshotless worker payload fails the attach
  before any record exists.


## 5. Compaction daemon wiring (`compact` on the daemon session) - done

TS: `daemon-mode.ts` L5236 `case "compact"` -> `session.compact(customInstructions)`
returning `CompactionResult`; `abort_compaction`; `set_auto_compaction`.

- done (#85): `compact`/`abort_compaction`/`set_auto_compaction` are worker
  commands (`crates/pa-daemon/src/protocol.rs` L51-53 `KNOWN_COMMAND_TYPES`;
  dispatch in `crates/pa-daemon/src/worker.rs` L843, handler
  `handle_compaction` L1498-1500 with the `CompactionResult` wire shape).
- done (engine side): `crates/pa-core/src/session_engine/mod.rs`
  `AgentSession::compact` + `compact_session.rs` (cut resolution, summarizer
  call, compaction entry persistence, context rebuild) and the `CompactionSettings`
  decision logic in `compaction.rs`.
- verifier: battery flow f7 against the live mock provider (run
  `scripts/battery/runs/20260917T062810Z`: both sides answer `compact`
  with summary/firstKeptEntryId/tokensBefore; the historical shape delta —
  TS adds `details{readFiles, modifiedFiles}` which Rust omitted — is
  fixed: the Rust response now mirrors the TS dataKeys, `details` verbatim
  from the durable entry).
- remaining (kernel half): the model-facing `compact.status`/`compact.run`
  host requests (TS `agent-session.ts` L3703-3731) have no registered Rust
  product-path handler, so the model cannot trigger compaction of its own
  session; see `docs/completion-matrix.md` family 6.

## 6. `rlm.create_session` through the daemon - implemented

TS: kernel `prime-agent-runtime/src/rlm/__init__.py` `create_session` ->
`host_request("rlm.create_session")`; daemon-mode `createRlmRootSession`
(L2627) creates a depth-0 resident session over the supervisor link and
prompts it.

- implemented: `crates/pa-core/src/session_engine/rlm_host.rs` registers the
  `rlm.*` host handlers (`rlm.run`/spawn, `rlm.find_models`,
  `rlm.create_session`, `rlm.progress_note`, `rlm.list_subagents`,
  `rlm.delete_subagent`, `rlm.collect`) through the session runtime wiring
  (`runtime_wiring.rs`); the no-children default keeps the handler surface
  with TS-parity errors.
- the daemon implements the `RlmSubagentHost` seam
  (`crates/pa-daemon/src/rlm_children.rs`) over the worker's shared
  supervisor link: one supervised worker process per child, created through
  the supervisor like any other session; parent-side roster, collect
  snapshots, and TS-verbatim selector errors. Mechanism note: the TS daemon
  hosts children in-process; the redesign keeps the kernel-visible surface
  (PORTING-NOTES).
- verified: `crates/pa-daemon/tests/rlm_children_e2e.rs` (spawn/roster/
  collect/delete/create_session/recursion bound against the real
  supervisor, including the child session file's `parentSession`/`rlmDepth`
  header parity).

The `rlm.collect` fan-in rides the same registry: the runtime's `collect()`
sends `host_request("rlm.collect", {"targets": [selectors], "timeout_ms":
N})`; the host resolves selectors (child ids, session ids, names) with the
TS selector errors and returns `{"results": [...]}` entries with
`rlm_child_id`, terminal `status`, `settled`, and an answer preview.

## 7. Read-command surface (`get_session_stats` / `get_context_tree` / `get_commands` / `get_resource_snapshot`) - partial

TS: `daemon-mode.ts` L183352+ delegates to `getSessionStats` (TS
`core/session-stats.ts` shape), `getContextTree` (`core/context-tree.ts`),
`createAgentConnectionCommands` / `createAgentConnectionResourceSnapshot`
(`modes/agent-connection/snapshot.ts`).

- done (merged): `get_session_stats` and `get_session_header` - worker
  handlers computed from the session store, routed supervisor -> worker.
  Verifier: `crates/pa-daemon/tests/supervisor_e2e.rs`
  `session_stats_and_header_match_live_daemon_goldens` asserts the response
  shape against goldens captured from the live TS daemon (see below), plus
  unit tests in `crates/pa-daemon/src/session_stats.rs`.
- missing: `get_context_tree` - needs RLM child-session machinery (live child
  nodes + disk-loaded completed children); root-only would diverge whenever a
  session has children. Blocked on item 6.
- missing: `get_commands` / `get_resource_snapshot` - need per-worker resource
  loading (skills/prompts/themes/extensions). pa-core
  `resources::load_resources` provides the data; wire an engine-level accessor
  plus the command handlers. Note: `crates/pa-core/src/skills/mod.rs`
  `SourceOrigin` currently serializes `topLevel`, but the TS wire uses
  `top-level` (see `core/source-info.ts`); fix to kebab-case when landing
  these commands.

Live-TS goldens (read-only captures, protocol 7):
- `get_session_stats` data: `{ sessionFile, sessionId, userMessages,
  assistantMessages, toolCalls, toolResults, totalMessages, tokens: { input,
  output, cacheRead, cacheWrite, total }, cost, contextUsage? }` where
  `contextUsage` is `{ tokens, contextWindow, percent }` and is omitted when
  the session has no model context window.
- `get_session_header` data: `{ header: { type: "session", version, id,
  timestamp, cwd, parentSession?, rlmDepth?, git? } }`.

## 8. Adjacent gaps found during the audit

- CLI daemon client: RESOLVED in #67 (`crates/pa-cli/src/daemon_client.rs`
  + `daemon_command.rs` serve `list`/`kill`/`rename`/`send`/`cron` against
  the daemon socket; `attach` opens the session). Still unavailable with a
  typed "daemon discovery ... is not available in this build yet" error:
  `status`, `doctor`, `shutdown` (`crates/pa-cli/src/public_command.rs`
  L375-398) - drivers exist on the unmerged `lane/cli-discovery-2`
  (`c4c285c`). Self-update (`update`) still reports the typed
  self-update-unavailable error; `session export` is
  `MissingSubsystem::SessionExport`.
- Daemon command vocabulary: `crates/pa-daemon/src/protocol.rs`
  `KNOWN_COMMAND_TYPES` (L25) accepts 32 command types (26 before #85/#89);
  the TS supervisor accepts ~106 (`daemon-supervisor.ts` L244
  `DAEMON_COMMAND_TYPES`). `pa-types` already models the variants, so
  enabling them is per-command work in pa-daemon only. Still missing among
  them: `get_context_tree`, `get_commands`, `get_resource_snapshot` (§7).
- `model list` catalog output (found by the surface audit): the TS binary
  prints the model catalog table (`cli/list-models.ts`); the Rust binary
  answers "No response produced." because `RunOptions.list_models` has no
  consuming runtime (`crates/pa-cli/src/print_runtime.rs`; only the dead
  `UnavailableRuntime` checks it, `crates/pa-cli/src/mode.rs` L188). The
  `config` command likewise reports the pa-tui resource-configuration UI as
  not linked (`crates/pa-cli/src/lib.rs`).
- Tool-result persistence (still open): TS session files contain
  `toolResult` message entries; the pa-core persistence listener writes only
  user/assistant messages (`crates/pa-core/src/session_engine/mod.rs`
  L325-331 `persist_event`). Affects `get_session_stats.toolResults`,
  transcripts, and external tooling reading session files.

## Battery findings (live A/B parity battery; first run 20260916T210320Z, fixed rows verified by run 20260916T221725Z)

Battery greenness covers only the scripted flows f1-f11 over the deterministic
mock provider. "0 gaps" (latest run 20260917T062810Z, 35 checks) does NOT
mean product parity: it missed the interactive `--thinking` propagation
blocker (`docs/completion-matrix.md` family 2) and does not exercise the
partial/missing families catalogued there. Do not conflate the two.

Standing battery harness committed at `scripts/battery/` (see
`docs/parity-battery.md` for the flow list and re-run instructions). All
gaps below are reproduced by the committed first run
(`scripts/battery/runs/20260916T210320Z/`) except B-3, whose evidence is
`runs/20260916T203149Z/` (superseded by the short-TMPDIR harness fix, the
product gap remains). B-1, B-7, and B-11 are fixed (run
`runs/20260916T221725Z/`); the same lane also ported the models.json
`apiKey` resolution for daemon-worker request auth (no battery row).
Categories: visual/behavior/protocol/timing.

- B-1 (protocol, f1): FIXED. Rust interactive dropped `--provider`/`--model`
  CLI flags (the daemon worker resolved its model from env or its fallback;
  a capture with `--provider battery --model mock-1` answered with
  `prime-inference/z-ai/glm-5.3`). The TUI create config now carries the
  flags over the wire (TS runtime-config propagation), the supervisor
  persists them into the durable create, and the worker binds them onto its
  engine; env stays the no-flag fallback. Verified by run
  `runs/20260916T221725Z/{ts,rust}/f1_launch/first-prompt-mock-requests.json`
  (both sides request `mock-1`). Historical evidence:
  `runs/20260916T210320Z/extras/rust-interactive-model-flags-session.jsonl`.
- B-2 (visual, f1): FIXED (#93 "interactive: first-run parity (B-2)").
  The Rust TUI now renders the splash + trace-sharing notice and answers
  persistently (`crates/pa-tui/src/onboarding.rs`,
  `crates/pa-tui/src/interactive.rs` L186-207). Verified by run
  `runs/20260917T062810Z` ("first-run splash + trace-sharing notice
  rendered and answerable on both sides"). The `/traces` command itself
  still has no client UI and the trace upload subsystem does not exist
  (`docs/completion-matrix.md` families 3/19). Historical evidence:
  `runs/20260916T210320Z/{ts,rust}/f1_launch/01-launch.txt`.
- B-3 (timing, f1): FIXED (run `runs/20260917T041145Z/`). The worker connect
  budget is 30s (TS `WORKER_CONNECT_TIMEOUT_MS`): socket probes, connect,
  and the auth handshake share one deadline and a stuck child is killed at
  timeout. Over-limit AF_UNIX paths (107-byte `sun_path`) now re-anchor
  through an O_PATH directory fd (`/proc/self/fd/<fd>/<name>`), the same
  mechanism the TS runtime applies transparently (strace of the installed
  product shows `bind(13, {sun_path="/proc/self/fd/12/worker-...sock"}) = 0`),
  so worker sockets bind at arbitrary TMPDIR depth. Evidence:
  `runs/20260917T041145Z/extras/b3-deep-tmpdir/` (worker socket bound at a
  159-char path, full interactive turn over it; per-file session prefix now
  matches TS). Historical evidence: `runs/20260916T203149Z/rust/`.
- B-4 (protocol, f2) - RESOLVED: model tool surface differs - TS exposes only
  `ipython`; Rust exposed `bash`, `edit`, `ipython`. Evidence:
  `runs/20260916T210320Z/{ts,rust}/f2_prompt/mock-requests.json`.
  Fixed (run `runs/20260916T224512Z/`): both sides expose only `ipython`
  (byte-identical tool schemas); `bash`/`edit` stay kernel-resident.
- B-5 (protocol, f2) - RESOLVED: TS prepends a `[harness-digest]` user
  message; Rust sent none. Fixed (same run): the Rust session engine composes
  and delivers the digest at cold context boundaries; the captured digest
  messages are byte-identical on both sides.
- B-6 (protocol, f2) - RESOLVED: system prompt differed (23119 vs 13526
  chars): Rust omitted the conversation-log path, installed skill modules
  line, available-skills inventory, and harness-refinement guidance. Fixed
  (same run): normalized prompts are identical; golden test
  `crates/pa-core/tests/golden/system_prompt.rs` pins the assembly against
  the TS `buildSystemPrompt` over the vendored skills.
- B-7 (protocol, f2/f5) - REMOVED 2026-09-25 by operator directive: the
  Rust port drops the status-line recap (the qwen request, the
  `session_status` broadcast, and its surfaces) end to end; the TS product
  keeps `daemon-session-summarizer.ts` per its own decisions. Historical
  evidence of the pre-removal parity:
  `runs/20260916T221725Z/{ts,rust}/f5_side_questions/statusline-requests.json`.
- B-8 (protocol, f3/f8): FIXED (run `runs/20260917T041145Z/`). Session
  entry sets now match on both sides: `service_tier_change` is emitted in
  the creation prefix (fresh + resume, settings default, engine and daemon
  store), `custom_message` (harness_digest) and `compaction` landed in
  #83/#85, and the queue snapshot moved from session-file `custom` entries
  into the worker recovery journal. Settled status verdicts now persist as
  `agent_status` entries (real model classifications and transcript error
  verdicts only; the needs_input fallback and sweeps never grow the journal;
  respawned workers seed the in-memory verdict from the persisted entry).
  Differential evidence: `runs/20260917T041145Z/extras/b8-agent-status/`.
  Historical evidence: `runs/20260916T210320Z/f3_tool-session-shapes.json`,
  `f8_resume-session-shapes.json`.
- B-9 (visual, f4): FIXED. `/` opens the slash-command menu, driven by the
  shared pa-types registry (fuzzy filter, argument-hint column, directional
  scroll info, selected description, popup background above the editor).
  Frame-diff vs the TS product at 120x36 (2026-09-17): same row structure;
  remaining deltas are the ambient skill/template commands the TS daemon
  lists (a separate surface), the dynamic `/effort` argument hint
  (`[low/high/max]` from the model's thinking levels vs the static
  registry hint), and `/fast` not being filtered by model eligibility
  (needs model/auth knowledge pa-tui does not hold yet). Dispatch parity
  lives in `pa-tui/src/session_ui.rs` (session commands forward to the
  worker, client commands without UIs report unavailability, unknown
  commands reproduce the TS `Unknown command: /x. Did you mean /y?`).
  Verifier: `pa-cli` `tui_dispatches_slash_commands_menu_and_suggestions`
  (headless TUI over a live faux-engine session: echo/result rows, menu,
  suggestion, unavailable note, persisted session rows). Historical
  evidence: `runs/20260916T210320Z/rust/f4_commands/01-slash-menu.txt`.
- B-10 (protocol, f7): FIXED (#85, item 5 above is now `done`); the known
  shape delta is also fixed (lane compact-datakeys). Both sides answer
  `compact` with `{summary, firstKeptEntryId, tokensBefore,
  details{readFiles, modifiedFiles}}` — the Rust response mirrors the TS
  dataKeys, `details` verbatim from the durable entry. Verified by run
  `runs/20260917T062810Z` f7 (both compacts succeed). Historical evidence:
  `runs/20260916T210320Z/{ts,rust}/f7_compaction/compact-response.json`.
- B-11 (behavior, f8): FIXED. TS print `-c` refuses while the session is
  active in the daemon ("Session is already active in <id>: <path>"); the
  Rust print path now guards `-c`/`-r` with a daemon live-roster probe and
  refuses with the exact message (message + canonicalization from the
  session-lease port). Verified by run
  `runs/20260916T221725Z/{ts,rust}/f8_resume/continue-cmd.json` (both sides
  exit 1 with the same shape). Historical evidence:
  `runs/20260916T210320Z/ts/f8_resume/continue-cmd.json`.

Passed-check highlights (both products agree, live through the mock):
print-mode stdout identical; `ipython` tool turns execute in both;
side questions stream `side_question_event` running->complete on both;
wire attach returns the same snapshot data keys; CLI `attach` opens in both.

## 9. Interactive TUI visual parity - done for the scripted core states

Verified by a tmux frame-diff harness (`scripts/visual_parity.py`): the harness
drives the installed TS binary and the Rust binary side by side in tmux, runs
the same scripted turn on both (faux model with content-block responses: a
thinking block, a text block, an `ipython` tool call, and a final answer), and
compares `tmux capture-pane -e` frames after normalizing volatile content
(versions, session ids, durations, token counts, spinner frames).

Verified states (both at 120x36 and 220x50, PASS on 2025-06-27):
- (a) fresh start: splash + header (model/cwd), prompt, footer, collapsed-mode
  indicator, empty editor on `userMessageBg`.
- (b) idle after a turn with a tool-call card: user block, assistant text,
  collapsed ipython card (`\u2713 python \u00b7 <code preview> \u00b7 \u2191 N \u2193 M lines \u00b7 <duration>`),
  final answer, tray stats.
- (c) thinking visible (Ctrl+O): dim thinking block between user message and
  assistant text, `Details mode` indicator.
- (d) spinner/working state: loader row with activity label, elapsed seconds,
  token estimate, spinner frames.

Deliberate deviations / notes:
- The kernel-packaging lane added the packaged sidecar resolution (binary
  directory + `PI_PACKAGE_DIR`, source-checkout fallback), so a packaged
  layout (`make package` / `scripts/package_release.py`) boots without
  `PI_PACKAGE_DIR`; the visual-parity harness still points `PI_PACKAGE_DIR`
  at the installed TS release so both products run the same runtime
  (`find_runtime_package_dir` in the harness) - see
  `crates/pa-cli/tests/packaged_layout_e2e.rs` for the packaged-layout
  verifier.
- `code_preview` helpers are vendored under `crates/pa-tui/src/code_preview/`
  (pa-tui may not depend on pa-core); consolidation into pa-types is a
  follow-up.
- Tool-card output rows beyond the collapsed line ("all" mode) and markdown
  block types outside the scripted content are not yet frame-verified.
- The harness normalizes boundary foreground resets
  (`\x1b[39m` at end-of-row vs before next row's margin): tmux emits the same
  reset at either position for identical screens.
- The daemon worker exposes an event-log seam (`PA_DAEMON_EVENT_LOG=<path>`)
  used to verify wire parity during harness development.

Run it: `python3 scripts/visual_parity.py --sizes 120x36 220x50` (requires the
TS binary on PATH and a built `target/debug/prime-agent`).

## 10. Agent-to-agent messaging (`send_message` / kernel `agent_message.*`) - partial

TS: `modes/daemon/daemon-supervisor.ts` `send_message` block, `daemon-mode.ts`
`worker_deliver_message` + `sendAgentSessionMessage`, `core/agent-messages.ts`
(receipt/prompt/validation, `createAgentMessageHostHandlers`), TS
`core/kernel/shared.ts` (sent-message bridge),
`modes/daemon/supervisor-link.ts`.

- done: supervisor `send_message` arm (`crates/pa-daemon/src/messaging.rs`):
  source/target resolution with the TS unknown-session errors, self-target
  refusal, sender endpoint from the source session's live summary (CLI-origin
  sender is the client id), `worker_deliver_message` routing to the target.
  Worker delivery (`crates/pa-daemon/src/worker.rs`
  `handle_worker_deliver_message`): renders the exact TS
  `[agent-message from ...]` prompt, steer lane by default / `follow_up` on
  request, pending-capacity guard, `createAgentSessionMessageReceipt`-shaped
  receipt. Worker->supervisor link (`crates/pa-daemon/src/supervisor_link.rs`,
  TS supervisor-link.ts port; a write-phase failure to a dead supervisor
  transparently reconnects once, the TS close-listener teardown equivalent)
  and the kernel `agent_message.send` / `agent_observe.*` host controllers
  wired through the engine's `extra_host_handlers`
  (`crates/pa-daemon/src/agent_messaging.rs`). The family view joins the
  roster with the session's own RLM children registry (the same registry
  `rlm.list_subagents` reads): registry children are Child members
  addressable by name, RLM child id, and persisted session id (alias
  selectors on the kernel `AgentFamilyMember`), the roster row that
  spawned a subagent worker is its Parent member, and the rest stay
  siblings; the `send_message` wake falls back to the spawn ledger's live
  child edges when the saved-session catalog misses a child selector
  (`tests/agent_family_e2e.rs` verifies the round trip end to end).
- done: the kernel `agent_message.send` contract
  (`crates/pa-core/src/session_engine/agent_messaging.rs`, TS
  `createAgentMessageHostHandlers` port): role/name resolution through the
  family roster with the exact TS error strings, `target: "all"` broadcast
  with all-settled receipts, positional-target rejection, and the removed
  `agent_message.list_agents` migration error. The daemon worker's family
  roster is the family view above (children, parent, then siblings;
  `tests/agent_family_e2e.rs`); receipts carry the TS target endpoint
  (activeSessionId/sessionId/sessionName/runtimeKind) so the kernel
  sent-message display bridge parses them.
- done: worker-to-worker peer transport (thin-supervisor stage 3): the
  supervisor mints single-use `worker`-purpose grants
  (`get_worker_peer_transport`, `crates/pa-daemon/src/peer_tickets.rs`,
  authenticated by the requester's worker token like TS `list_agent_peers`),
  the target worker admits them over `peer_auth` into a `PeerWorker` role
  (`crates/pa-daemon/src/peer.rs`, `worker_deliver_message` only, no event
  streaming), and the source worker's kernel send delivers directly to the
  target's socket (`crates/pa-daemon/src/peer_client.rs` +
  `agent_messaging.rs`) with the TS sender identity block
  (`createAgentSessionMessageSender` shape: endpoint fields from the
  worker-pushed live summary + `clientId: "agent"`). The supervisor-routed
  `send_message` stays as the fallback (only when the direct link cannot be
  established; once the delivery command is sent the outcome is final).
- done (was the superseded hang): the client-to-client `send_message` shape
  completes - the direct path bypasses the supervisor's route plane by
  design. Verified in `crates/pa-daemon/tests/peer_messaging_e2e.rs`:
  (1) a kernel send over real spawned workers delivers through the peer
  transport with the receipt shape and the prompt rendered once in the
  target; (2) two attached clients, kernel send from A into B, receipt
  observed, prompt rendered once in B, both clients still served promptly
  afterwards (no route starvation); (3) supervisor `kill -9`
  mid-conversation, workers re-register with the restarted supervisor, and
  the next kernel send still delivers.
- done (was deferred): saved-session wake for non-resident targets
  (`crates/pa-daemon/src/session_catalog.rs` + the wake block in
  `crates/pa-daemon/src/messaging.rs`): the catalog resolves the selector
  (session-id prefix or exact name, cwd-scoped first; ambiguity carries the
  TS `Ambiguous session selector` error), a resident worker hosting the file
  is reused, otherwise one spawns over it; the CLI prints `Sent to <name>`
  like TS. Verifier: `crates/pa-daemon/tests/saved_session_wake_e2e.rs` and
  the CLI goldens in `pa-cli/tests/daemon_commands_e2e.rs` (including the
  TS-differential wake flow).
- deferred gaps: the family-reach
  assertion needs the session family catalog the thin supervisor does not
  keep; delivered agent messages persist as plain user prompts, not TS
  `custom` messages (`customType: "agent_message"` with a details block); the
  sender relationship in the delivered prompt derives from `runtimeKind`
  (subagent -> child) instead of the family graph; the TS `deliveryMode` wire
  field is legacy-ignored in TS but honored here (default `steer` matches TS).

The user-facing summary of this area now lives in
`docs/completion-matrix.md` family 8.
