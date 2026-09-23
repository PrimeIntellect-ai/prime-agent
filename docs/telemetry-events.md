# Telemetry event schema (version 1)

The versioned catalog of every telemetry event Prime Agent emits, with its
properties. Emitted through `pa-telemetry` (`TelemetryClient::track`), delivered
to PostHog (batched capture; endpoint + project key from configuration) and
mirrored locally at `<agentDir>/telemetry.jsonl` (FileSink, default-on).

Schema rules:

- Every event carries `schema_version` (integer). Breaking changes to an
  event's properties bump the schema version; additive changes do not.
- Event names keep the TS product's lowercase-space convention
  (`agent started`), so series stay comparable across implementations.
- Properties are JSON primitives only, enforced at the [`Properties`] boundary:
  no objects (except the documented `phase_timings` primitive map), no arrays.
- NEVER prompt content, session content, model output, tool arguments or
  results, file paths, or repository data. The seams in this document are the
  complete set of emission points; anything not listed is not emitted.
- Identity is pseudonymous: `distinct_id` = the anonymous installation id from
  `<agentDir>/telemetry.json`. No user identity, no auth tokens, no hostnames.

## Base properties

Merged under every event's own properties (event-specific values win on
conflict):

| property | type | values / notes |
|---|---|---|
| `version` | string | product version, e.g. `0.1.0` |
| `schema_version` | number | this document's version: `1` |
| `os_family` | string | `linux`, `darwin`, `windows` (std::env::consts::OS) |
| `architecture` | string | `x86_64`, `aarch64`, ... (std::env::consts::ARCH) |
| `install_method` | string | `binary` for the compiled Rust build (additive later) |
| `execution_mode` | string | `interactive`, headless mode names, or `unknown` |
| `libc` | string | `glibc` / `musl` / `none` / `unknown` (compile-time target env on Linux; `none` off Linux) |
| `libc_version` | string | glibc version where determinable, else `unknown` |
| `cpu_baseline` | string | `avx2` / `no_avx2` (/proc/cpuinfo on linux x86_64), `not_applicable` off x86_64, `unknown` when no probe |
| `os_release` | string | kernel version where determinable, else `unknown` |
| `os_product_version` | string | macOS product version, else `unknown` |

Platform-fidelity properties are never faked: unknown means unknown.

## Session/run lifecycle (TS-parity events)

### `agent started`

Session creation, depth-0 sessions only (subagents never double-report).

| property | type | notes |
|---|---|---|
| `session_id` | string | per-process session uuid (random per client, NOT the on-disk session id) |
| `skill_count` | number | skills in the inventory at session start |
| `python_skill_count` | number | of which Python-backed skills |

### `agent run completed`

One agent run (prompt → final assistant message). Emitted when the run
finalizes (agent ends, or the turn action deactivates after the agent ended).

| property | type | notes |
|---|---|---|
| `session_id` | string | as above |
| `outcome` | string | `success` / `error` / `aborted` |
| `duration_ms` | number | run start → finalize |
| `visible_ttft_ms` | number or null | first visible text delta since first turn start |
| `first_model_event_ms` | number or null | first model event since first turn start |
| `model_latency_ms` | number | sum of assistant-message turn latencies |
| `max_model_latency_ms` | number | max single turn latency |
| `model_call_count` | number | assistant messages received |
| `turn_count` | number | turns in the run |
| `tool_call_count` | number | tool executions |
| `tool_error_count` | number | tool executions that errored |
| `input_tokens` | number | usage totals |
| `output_tokens` | number | |
| `cache_read_tokens` | number | |
| `cache_write_tokens` | number | |
| `total_tokens` | number | |
| `compaction_count` | number | completed compactions (every arm: manual `/compact` and wire `compact`, model-requested, threshold, overflow; skipped/failed/cancelled runs do not count) |
| `retry_count` | number | auto-retries |
| `failover_count` | number | provider-failover switches (the failed turn re-routed to another configured provider serving the same model) |
| `provider_category` | string | `anthropic`, `openai`, `google`, `prime`, `openrouter`, `bedrock`, `vertex`, `mistral`, `groq`, `xai`, `custom`, `unknown` |
| `model_category` | string | `claude`, `gpt`, `o1`, `o3`, `o4`, `gemini`, `glm`, `kimi`, `qwen`, `deepseek`, `llama`, `mistral`, `custom`, `unknown` |
| `error_category` | string or null | `authentication`, `rate_limit`, `timeout`, `context_limit`, `network`, `provider_unavailable`, `other`; null when no error |

### `agent session ended`

Session dispose (interactive exit, worker shutdown).

| property | type | notes |
|---|---|---|
| `session_id` | string | |
| `duration_ms` | number | session lifetime |
| `prompt_count` | number | user prompts |
| `run_count` | number | |
| `successful_run_count` | number | |
| `failed_run_count` | number | |
| `aborted_run_count` | number | |
| `tool_call_count` | number | session total |
| `compaction_count` | number | session total across all compaction arms (same counting as the run property) |
| `model_call_count` | number | session total |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `total_tokens` | number | session totals |

### `agent command used`

Builtin slash commands only (resolved canonical name). Two seams, one event
per submission: session commands (`compact`, `refine`, `goal`,
`autonomous`) emit from the worker's session telemetry at execution; client
commands (`model`, `effort`, `tree`, `fork`, `clone`, `export`, `share`,
`hotkeys`, `session`, `context`, `system-prompt`, `logs`, `changelog`,
`mcp`, `heartbeats`) emit from the interactive client at dispatch (TS
`captureAgentCommandUsed`).

| property | type | notes |
|---|---|---|
| `command_name` | string | canonical builtin command name |

### `skill used`

A `/skill:<name>` submission expanded into its skill block (the
skill-command execution seam, TS `_expandSkillCommand`). Emitted once per
expanded invocation from the session's prompt admission; never carries
prompt or skill content.

| property | type | notes |
|---|---|---|
| `skill_name` | string | the invoked skill's name |
| `skill_kind` | string | `markdown` / `python` |
| `source` | string | `prompt` (admitted fresh) / `steer` / `follow_up` (queued during a run) |

### `onboarding completed`

| property | type | notes |
|---|---|---|
| `duration_ms` | number | |
| `outcome` | string | `success` / `error` / `aborted` |
| `auth_category` | string | `oauth`, `api_key`, `runtime_api_key`, `environment`, `prime_cli`, `models_json`, `fallback`, `stale`, `stored`, `none` |
| `provider_category` | string | as above |

## New v1 events (adoption backbone)

### `startup`

Process entry to a ready interactive session environment. One-shot client,
emitted and flushed before the TUI starts.

| property | type | notes |
|---|---|---|
| `duration_ms` | number | total startup |
| `phase_timings` | object | primitive map of phase name → ms (`daemon_ready`) |
| `execution_mode` | string | `interactive` |

### `onboarding completed`

| property | type | notes |
|---|---|---|
| `duration_ms` | number | onboarding-task creation → completion |
| `outcome` | string | `success` (the Rust onboarding flow is the trace question; no error/abort path exists yet) |
| `auth_category` | string | `none` (no auth step in the flow) |
| `provider_category` | string | `unknown` |

### `daemon event`

Supervision lifecycle, emitted by the supervisor process. Counts only,
never session payload. `session_rebound`: a client command addressed a
superseded active session id and the supervisor rebound it to the
session's current worker (the stale-id rebind).

| property | type | notes |
|---|---|---|
| `kind` | string | `worker_spawned`, `worker_exited`, `worker_restarted`, `attach`, `reattach`, `detach`, `sessions_archived`, `worker_children_closed`, `session_rebound`, `catalog_refresh`, `compaction_abort_declared` |
| `exit_reason` | string | only for `worker_exited`: `normal` / `crash` |
| `count` | number | only for `sessions_archived`, `worker_children_closed`, `catalog_refresh`, and `compaction_abort_declared` (always 1): how many sessions the sweep moved to the archive / how many resident RLM children the supervisor closed with a hard-killed parent worker / how many models the resolved no-cold-start chain serves after the daemon's startup catalog refresh / one wedged-worker compaction the supervisor declared aborted |

### `mcp connector used`

`mcp.*` host-request activity and the connector install flows. Server name
ONLY — never tool names, arguments, results, or pasted credential material.

| property | type | notes |
|---|---|---|
| `action` | string | `config` / `refresh` / `paste-install` |
| `server_name` | string | server id from settings / ACP admission / the resolved service catalog |

### `tool executed`

Per tool execution. Tool name only — never arguments or results.

| property | type | notes |
|---|---|---|
| `session_id` | string | |
| `tool_name` | string | `bash`, `edit`, `ipython`, skill tool names |
| `duration_ms` | number | execution wall time |
| `is_error` | boolean | execution failed |

### `kernel bootstrap`

One per actual kernel boot (memoized startups report once): process spawn,
handshake, namespace restore, and runtime bootstrap. With the session-create
prewarm, daemon-hosted and headless main sessions report this at creation
(no `ipython` tool use needed); subagents report at their first cell.

| property | type | notes |
|---|---|---|
| `duration_ms` | number | whole bootstrap wall time |
| `cold` | boolean | no prior namespace snapshot existed to restore |
| `outcome` | string | `success` / `error` |

### `session archived`

Emitted on the daemon `kill` path, before the session-ended finalization.

| property | type | notes |
|---|---|---|
| `duration_ms` | number | session lifetime at archive time |

### `tui scroll used`

The interactive transcript viewport's first scroll action per client run
(adoption; later actions in the same run are not reported).

| property | type | notes |
|---|---|---|
| `action` | string | `page_up` / `page_down` / `top` / `follow` |
| `resumed_following` | boolean | the action resumed tail-following |

### `tui selection used`

The interactive transcript viewport's first in-app mouse selection copy per
client run (adoption; later copies in the same run are not reported).

| property | type | notes |
|---|---|---|
| `lines` | number | the copied text's line count |

### `tui enhanced keys`

The terminal enhanced-key modes settled for an interactive run (adoption:
emitted once per client run when the kitty keyboard protocol answer lands).

| property | type | notes |
|---|---|---|
| `kitty` | boolean | the kitty keyboard protocol is active (flags `1\|2\|4`) |
| `modify_other_keys` | boolean | always `false` in this port: the xterm modifyOtherKeys mode-2 fallback is never armed (crossterm cannot parse the resulting `CSI 27;mods;key~` sequences — the whole input buffer drops on the parse error, the shift-modified-printable bug class); every surface start instead resets the mode. The property keeps the TS event shape. |

### `tui hyperlinks`

The terminal hyperlink (OSC 8) capability resolved for an interactive run
(adoption: emitted once per client run, terminal runs only — headless runs
never paint a tty).

| property | type | notes |
|---|---|---|
| `enabled` | boolean | clickable link rendering is active (the `detectCapabilities` gate: on in terminals positively known to implement OSC 8 — kitty/ghostty/wezterm/iTerm2/VS Code/Alacritty — and off under tmux/screen and in unknown terminals) |

### `tui image pasted`

An image was pasted into the input editor from the clipboard and attached
to the prompt (adoption of inline image support).

| property | type | notes |
|---|---|---|
| `mime_type` | string | the attachment's sniffed format (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) |

### `update completed`

The staged-activation update flow (`prime-agent update`), emitted once per
invocation by the invoking CLI at the terminal status (the coordinator-mode
process never emits - its invoker owns the event). Terminal outcomes only;
the privacy contract keeps paths, status messages, and ids out.

| property | type | notes |
|---|---|---|
| `outcome` | string | `complete`, `skipped`, `aborted`, `failed` |
| `sessions_total` | number | roster sessions the update flow carried |
| `sessions_restored` | number | restored by the successor supervisor |
| `sessions_failed` | number | recorded restore failures |

### `update download started` / `update staged` / `update prepare started` / `update prepared` / `update stopping` / `update restarting` / `update restoring` / `update complete` / `update rollback` / `update aborted` / `update failed`

The update flow's per-phase events (spec
`docs/update-flow-state-machine.md` §11): one event per status-file state
transition, all derived from the same transitions that drive the CLI status
lines and the client banner. Emitted by the invoking CLI (the same process
owns `update completed`); the coordinator never emits. Primitives only -
phase timings and counts; no paths, messages, or ids (privacy contract).

| property | type | notes |
|---|---|---|
| `phase` | string | the event's own phase name (`update_prepared`, …) |
| `duration_ms` | number | observed time since the previous phase event |
| `sessions_total` | number | terminal events only: roster sessions |
| `sessions_restored` | number | terminal events only: restored by the successor |
| `sessions_failed` | number | terminal events only: recorded restore failures |

Emission map: `Downloading` → `update_download_started`, `Staged` →
`update_staged`, `Preparing` → `update_prepare_started`, `Prepared` →
`update_prepared`, `Stopping` → `update_stopping`, `Activating`/`Booting` →
`update_restarting`, `Restoring` → `update_restoring`, `Complete` →
`update_complete`, `Rollback` → `update_rollback`, `Aborted` →
`update_aborted`, `Failed` → `update_failed`.

### `tui exit`

How one interactive client run ended.

| property | type | notes |
|---|---|---|
| `exit_reason` | string | `ctrl_c_twice` (second press of the exit-hint window), `ctrl_d`, `session_request` (`/exit`, `/quit`, `/resume`, agents-back), `daemon_closed` |
| `turn_active` | boolean | a turn was still running at exit |

### `tui input queued`

A prompt submission parked in the steering/follow-up queue behind a
running turn (adoption of the visible follow-up queue; emitted once per
parked submission, not per rendered row).

| property | type | notes |
|---|---|---|
| `lane` | string | `steering` (Enter while a turn runs) / `follow_up` (the follow-up key) |
| `steering_mode` | string | the session's queue delivery mode at the submission (TS `steeringMode`): `all` = the parked steering prefix delivers as one batched turn at the boundary, `one-at-a-time` = one steer per turn — exposure under batched delivery is the multi-steer batch feature's adoption signal |

### `tui queue edited`

A parked queued message was touched through the browse/edit affordance
(adoption of queue editing, TS `QueueSelection`): selecting a parked
message, re-queueing an edited one (moving its lane), deleting it with an
empty edit, or reordering it with ctrl+alt+arrows. Emitted once per
completed user action, and only when the mutation was applied; never
carries the message text.

| property | type | notes |
|---|---|---|
| `action` | string | `select` (a browse opened a selection) / `edit` (the edited text re-queued, possibly to the other lane) / `delete` (empty edit) / `reorder` (ctrl+alt+arrow move) |

### `tui suspend used`

The run's first `app.suspend` cycle (default ctrl+z; adoption of the
suspend-to-background surface; later cycles in the same run are not
reported).

| property | type | notes |
|---|---|---|
| `outcome` | string | `resumed` (the SIGCONT continuation re-applied the terminal modes) / `failed` (the cycle errored) |

### `tui subagents open`

The subagent summary line opened the scoped agents view (adoption of the
subagent inspection surface; emitted once per open action).

| property | type | notes |
|---|---|---|
| `children_total` | number | live RLM descendant count at open time |

### `tui activity opened`

The user opened an activity surface from the session view: the unified
panel itself (dock Enter, a second Alt+A, or a dock group's Enter) or a
group's management view from the panel (the scoped agents view, the
heartbeats view, a bash output tail). The goal indicator is read-only and
does not emit this event. No command, output, prompt, or goal content is
collected.

| property | type | notes |
|---|---|---|
| `kind` | string | `panel` / `subagents` / `heartbeats` / `bash` |

### `tui prompt stash`

A prompt-stash transition (adoption of the session-switch draft stash, TS
`prompt-stash-state.ts`): an editor draft stashed on the way out of a chat,
or a stashed draft restored into a reopened chat's editor. Emitted once per
transition; never carries prompt content.

| property | type | notes |
|---|---|---|
| `action` | string | `agents_view` / `session_switch` (a draft stashed on the way out) / `restored` (a stashed draft returned to the editor) |
| `had_images` | boolean | the draft carried pasted images |

### `tui bash shortcut used`

The `!`/`!!` bash-from-chat shortcut ran a command from the input editor
(adoption of the bash-mode surface; emitted once per dispatched run, never
carrying the command or its output).

| property | type | notes |
|---|---|---|
| `excluded` | boolean | the `!!` variant: the run stays out of the session context |
| `side_conversation` | boolean | the run executed inside a side-question pane (transient, pane-rendered) |

### `tui bash bang executed`

A dispatched bang run settled (adoption settle signal for the bash-mode
surface; primitives only — never the command, its output, or its spill path).

| property | type | notes |
|---|---|---|
| `duration_bucket` | string | `lt_5s` / `5_to_30s` / `30s_plus` / `unknown` (unknown when the client never observed the run's start) |
| `exit_class` | string | `zero` / `nonzero` / `cancelled` / `failed` (spawn failure) / `unknown` |

## Planned events (seams not yet in the product)

Planned events stay in this catalog as schema v1 placeholders until
their product seam lands (each in the same PR as the seam, per the
adoption convention below). None are pending right now: the former
`skill used` placeholder shipped with its seam (the `/skill:` expansion).

## Cohorts and breakdowns

`distinct_id` is the installation id, so PostHog cohorts and breakdowns work
directly over any base property (`version`, `os_family`, `architecture`,
`libc`, `execution_mode`) and per-event properties (`provider_category`,
`model_category`, `tool_name`, `skill_name`). Feature flags are fetched via the
decide v3 API against the same `distinct_id`.

## Adoption convention

Every user-visible feature ships its adoption event in the same PR: add the
event name + properties here (bump `schema_version` on breaking changes) and
emit it at the feature's seam from day one. See AGENTS.md.
