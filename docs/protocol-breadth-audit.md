# Daemon protocol breadth audit (roadmap item 7)

Ground truth: `DAEMON_COMMAND_TYPES` in `modes/daemon/daemon-supervisor.ts` (TS
reference, 106 client command types) and the per-command handlers in
`modes/daemon/daemon-supervisor.ts` (supervisor arms) and
`modes/daemon/daemon-mode.ts` (worker arms). Rust state:
`pa_types::daemon::command::DaemonCommand` (wire shapes), the accept list
`KNOWN_COMMAND_TYPES` and the routing tables `command_type_name` /
`command_active_session_id` in `pa-daemon/src/protocol.rs`, the supervisor
dispatch (`Supervisor::execute_parsed_command` / `route_client_command`) and
the worker dispatch (`Worker::dispatch`).

## Method

1. Extracted the 106 TS command types from `DAEMON_COMMAND_TYPES`.
2. Diffed against the Rust accept list, the supervisor arms, the worker arms,
   and the `pa-types` wire enum.
3. Classified each unknown into:
   - **(a)** the Rust daemon already handles it (same wire name and shape);
     only the accept list / routing tables must be widened.
   - **(b)** the wire shape parses (`pa-types`) but no Rust handler exists
     yet; grouped into small waves by TS surface.
   - **(c)** TS-internal or deprecated; document, no port.

## Summary

- The `pa-types` `DaemonCommand` union already covers **all 106** TS command
  types (plus 5 Rust-native supervisor/worker commands:
  `worker_register`, `worker_roster_delta`, `get_worker_peer_transport`,
  `commit_update_restart`, `update_restore_status`).
- The bottleneck is the daemon accept layer: `KNOWN_COMMAND_TYPES` listed 35
  entries (34 of them TS types), so the supervisor rejected 72 of the 106 TS
  types with
  the TS wire error `Unknown daemon command: <type>` before dispatch; and
  `command_type_name`/`command_active_session_id` had wildcard fallbacks
  (`"unknown"` / `None`) for every variant outside the old list, so even a
  command that parsed would route with a wrong type name and never reach its
  session.
- Class (a): 7 TS types handled today but missing from the accept list:
  `roster_subscribe`, `roster_unsubscribe`, `start_side_question`,
  `abort_side_question`, `set_model`, `set_thinking_level`,
  `prepare_update_restart` (plus the 4 Rust-native supervisor commands
  `worker_roster_delta`, `get_worker_peer_transport`, `commit_update_restart`,
  `update_restore_status`, and `worker_register`, which was already listed).
- Class (b): 65 types with a wire shape but no handler, grouped into waves
  below.
- Class (c): 0. Nothing in `DAEMON_COMMAND_TYPES` is deprecated or
  supervisor-internal-only; `ack_result` is the command journal ack and is
  already handled as such.

## Wave plan for class (b)

| wave | surface | types |
|---|---|---|
| b1 (landed) | queue lane mutation/resume on the worker (`queue_commands.rs`) | `mutate_queued_message`, `resume_queue` |
| b2 | read-only state getters (worker) | `get_connection_state`, `get_context_tree`, `get_commands`, `get_resource_snapshot`, `get_rlm_children`, `get_session_context`, `get_session_tree`, `get_user_messages_for_forking`, `get_system_prompt`, `get_tool_definition`, `get_rlm_max_depth_status`, `get_model_catalog`, `get_available_models` |
| b3 | model/setting switches (worker) | `cycle_model`, `set_scoped_models`, `cycle_thinking_level`, `set_service_tier`, `set_transport`, `set_steering_mode`, `set_follow_up_mode`, `set_auto_retry`, `abort_retry` |
| b4 | custom-message & session-command surface (worker) | `append_custom_message`, `restore_next_turn`, `restore_actions`, `refine`, `abort_branch_summary`, `set_session_entry_label`, `reload`, `extension_ui_response` |
| b5 | bash surface (worker) | `execute_bash`, `execute_bash_and_wait`, `abort_bash` |
| b6 | RLM surface | `cancel_rlm_child`, `delete_rlm_subagent`, `set_rlm_max_depth` |
| b7 | agent-message ingestion | `agent_messages_status`, `agent_messages_pause`, `agent_messages_resume`, `agent_messages_clear` |
| b8 | supervisor: session input pause | `acquire_session_input_pause`, `release_session_input_pause` |
| b9 | supervisor: ownership/lifecycle, session navigation | `complete_owned_session`, `promote_owned_session`, `new_session`, `switch_session`, `fork`, `navigate_tree`, `import_jsonl`, `export_html`, `export_jsonl`, `cancel_prompt_admission` |
| b10 (landed) | supervisor: scheduling catalog | `cron_list`, `cron_add`, `cron_cancel`, `heartbeats_list`, `heartbeat_manage`, `heartbeat_get`, `heartbeat_set`, `heartbeat_update` |
| b11 (landed) | supervisor: saved-session catalog & peer roster | `rename_saved_session`, `delete_saved_session`, `list_agent_peers` |

Waves b2-b7 are worker commands routed through the generic path
(`Supervisor::execute_parsed_command` fallback -> `route_client_command` ->
`Worker::dispatch`); the TS supervisor's `forwardToWorker` resolves the
session id the same way, so the worker arm is the only new logic. Waves
b8-b11 carry TS **supervisor** logic (input-pause lease bookkeeping,
ownership promotion, saved-session catalog writes, cron/heartbeat catalog
merge, peer roster auth) and must port the supervisor arms, not just worker
arms.

## Per-type state (all 106 TS types)

Legend: `accepted` = present in `KNOWN_COMMAND_TYPES` (the supervisor's
`DAEMON_COMMAND_TYPES` gate); `plane` = TS `DAEMON_COMMAND_PLANE`;
`handled today` = existing Rust supervisor arm (`supervisor`), worker arm
(`worker`), or both. Types not in any wave column are already accepted and
handled.

| type | plane | accepted | handled today | wave |
|---|---|---|---|---|
| `ack_result` | Control | yes | supervisor |  |
| `list` | Control | yes | supervisor |  |
| `list_agent_peers` | Control | yes | supervisor |  |
| `get_direct_worker_transport` | Control | yes | supervisor |  |
| `roster_subscribe` | Control | no | supervisor | (a) wave 1 |
| `roster_unsubscribe` | Control | no | supervisor | (a) wave 1 |
| `list_saved_sessions` | Control | yes | supervisor |  |
| `create` | Control | yes | supervisor+worker |  |
| `attach` | Session | yes | worker |  |
| `reattach` | Control | yes | none |  |
| `detach` | Session | yes | worker |  |
| `complete_owned_session` | Control | no | none | b9 supervisor-level: ownership/lifecycle |
| `promote_owned_session` | Control | no | none | b9 supervisor-level: ownership/lifecycle |
| `kill` | Control | yes | worker |  |
| `rename` | Control | yes | worker |  |
| `prompt` | Session | yes | worker |  |
| `cancel_prompt_admission` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `prompt_and_wait` | Session | yes | worker |  |
| `steer` | Session | yes | worker |  |
| `follow_up` | Session | yes | worker |  |
| `restore_next_turn` | Session | no | none | b4 custom-message & session-command surface |
| `restore_actions` | Session | no | none | b4 custom-message & session-command surface |
| `append_custom_message` | Session | no | none | b4 custom-message & session-command surface |
| `resume_queue` | Session | no | none | b1 queue surface (this PR, wave 2) |
| `send_message` | Control | yes | supervisor |  |
| `agent_messages_status` | Control | no | none | b7 agent-message ingestion |
| `agent_messages_pause` | Control | no | none | b7 agent-message ingestion |
| `agent_messages_resume` | Control | no | none | b7 agent-message ingestion |
| `agent_messages_clear` | Control | no | none | b7 agent-message ingestion |
| `abort` | Session | yes | worker |  |
| `abort_and_send_queued` | Session | yes | worker | TS PR #2426 (schema 29): abort + deliver the parked steering (divergence 2026-09-25: the queue keeps flowing on a follow-up-only abort too; abort-only when empty) |
| `start_side_question` | Session | no | worker | (a) wave 1 |
| `abort_side_question` | Session | no | worker | (a) wave 1 |
| `execute_bash` | Session | no | none | b5 bash surface |
| `execute_bash_and_wait` | Session | no | none | b5 bash surface |
| `abort_bash` | Session | no | none | b5 bash surface |
| `cancel_rlm_child` | Session | no | none | b6 rlm surface |
| `delete_rlm_subagent` | Session | no | none | b6 rlm surface |
| `wait_for_idle` | Session | yes | worker |  |
| `wait_for_headless_completion` | Session | yes | worker |  |
| `get_session_header` | Session | yes | worker |  |
| `get_state` | Session | yes | worker |  |
| `get_connection_state` | Session | no | none | b2 read-only state getters |
| `get_messages` | Session | yes | worker |  |
| `get_rlm_children` | Session | no | none | b2 read-only state getters |
| `get_session_stats` | Session | yes | worker |  |
| `get_context_tree` | Session | no | none | b2 read-only state getters |
| `get_commands` | Session | no | none | b2 read-only state getters |
| `get_resource_snapshot` | Session | no | none | b2 read-only state getters |
| `replace_acp_mcp_servers` | Session | yes | worker |  |
| `get_model_catalog` | Session | no | none | b2 read-only state getters |
| `get_available_models` | Session | no | none | b2 read-only state getters |
| `get_queue` | Session | yes | worker |  |
| `mutate_queued_message` | Session | no | none | b1 queue surface (this PR, wave 2) |
| `clear_queue` | Session | yes | worker |  |
| `abort_and_clear_queue` | Session | yes | worker |  |
| `acquire_session_input_pause` | Session | no | none | b8 supervisor-level: session input pause |
| `release_session_input_pause` | Session | no | none | b8 supervisor-level: session input pause |
| `cron_list` | Control | yes | supervisor+worker |  |
| `heartbeats_list` | Control | yes | supervisor+worker |  |
| `heartbeat_manage` | Control | yes | supervisor+worker |  |
| `cron_add` | Control | yes | supervisor+worker |  |
| `cron_cancel` | Control | yes | supervisor+worker |  |
| `heartbeat_get` | Control | yes | worker |  |
| `heartbeat_set` | Control | yes | supervisor+worker |  |
| `heartbeat_update` | Control | yes | worker |  |
| `set_model` | Session | no | worker | (a) wave 1 |
| `cycle_model` | Session | no | none | b3 model/setting switches |
| `set_scoped_models` | Session | no | none | b3 model/setting switches |
| `set_thinking_level` | Session | no | worker | (a) wave 1 |
| `cycle_thinking_level` | Session | no | none | b3 model/setting switches |
| `set_service_tier` | Session | no | none | b3 model/setting switches |
| `set_transport` | Session | no | none | b3 model/setting switches |
| `set_steering_mode` | Session | no | none | b3 model/setting switches |
| `set_follow_up_mode` | Session | no | none | b3 model/setting switches |
| `set_auto_compaction` | Session | yes | worker |  |
| `set_auto_retry` | Session | no | none | b3 model/setting switches |
| `compact` | Session | yes | worker |  |
| `refine` | Session | no | none | b4 custom-message & session-command surface |
| `abort_compaction` | Session | yes | worker |  |
| `abort_branch_summary` | Session | no | none | b4 custom-message & session-command surface |
| `abort_retry` | Session | no | none | b3 model/setting switches |
| `reload` | Session | no | none | b4 custom-message & session-command surface |
| `new_session` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `switch_session` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `fork` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `navigate_tree` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `import_jsonl` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `export_html` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `export_jsonl` | Session | no | none | b9 supervisor-level: ownership/lifecycle |
| `set_session_name` | Control | yes | worker |  |
| `get_rlm_max_depth_status` | Session | no | none | b2 read-only state getters |
| `set_rlm_max_depth` | Session | no | none | b6 rlm surface |
| `rename_saved_session` | Control | yes | supervisor+worker |  |
| `delete_saved_session` | Control | yes | supervisor+worker |  |
| `get_session_context` | Session | no | none | b2 read-only state getters |
| `get_session_tree` | Session | no | none | b2 read-only state getters |
| `get_user_messages_for_forking` | Session | no | none | b2 read-only state getters |
| `get_last_assistant_text` | Session | yes | worker |  |
| `get_system_prompt` | Session | no | none | b2 read-only state getters |
| `get_tool_definition` | Session | no | none | b2 read-only state getters |
| `set_session_entry_label` | Session | no | none | b4 custom-message & session-command surface |
| `extension_ui_response` | Session | no | none | b4 custom-message & session-command surface |
| `prepare_update_restart` | Control | no | supervisor | (a) wave 1 |
| `retry_worker` | Control | yes | none |  |
| `restart` | Control | yes | supervisor |  |
| `shutdown` | Control | yes | supervisor+worker |  |

## Parity notes beyond the type list

- `retry_worker` is accepted today, but the TS handler is a supervisor arm
  (worker recovery); the Rust supervisor routes it to the worker, which
  answers `Unknown worker command: retry_worker`. Fix belongs in wave b9.
- The TS supervisor enriches several routed commands at the supervisor
  (prompt-admission bookkeeping for `prompt`/`prompt_and_wait`, rename
  reservations for `rename`/`set_session_name`, session-id resolution from
  roster summaries). The Rust supervisor already mirrors the rename/prompt
  paths it implements; new waves must keep that layering.
- `agent_messages_pause`/`resume` without an `activeSessionId` broadcast to
  every live worker in TS; the Rust command shape marks the field optional,
  so wave b7 needs a supervisor arm plus worker arms.
- The Rust worker's queue lanes are plain prompt queues; TS
  `mutate_queued_message` previews (`expectedText`) and
  `restore_actions`'s recovery snapshot (`SessionActionRecoverySnapshot`)
  are the wire contract for wave b1/b4 and were read from
  `core/session-action-store.ts` / `core/agent-session.ts` before porting.
- The supervisor's generic forward gate matches the TS semantics exactly:
  a command whose `activeSessionId` field is present routes by that selector
  (present-but-empty answers `Unknown active session: ...`, like TS
  `findWorkerForClient`), while a command that addresses no session answers
  the TS generic-forward error `Supervisor cannot route daemon command:
  <type>` until its supervisor arm lands. Before wave 1 the no-session
  commands never got that far (the type was rejected as unknown).


## Close-out (waves b10-b11)

All 106 TS client command types are now accepted, routed, and handled:

- waves b1-b9 landed in #176/#181/#186; waves b10 (scheduling catalog:
  `cron_list`, `heartbeats_list`, `heartbeat_manage`, `cron_add`,
  `cron_cancel`, `heartbeat_get`, `heartbeat_set`, `heartbeat_update`) and
  b11 (saved-session catalog & peer roster: `rename_saved_session`,
  `delete_saved_session`, `list_agent_peers`) close the audit.
- `scripts/protocol_breadth_parity.py` covers every type with a
  deterministic fresh-supervisor comparison (empty-catalog reads and
  bogus-selector refusals); the last two EXPECTED-DIFF rows (`cron_list`,
  `heartbeats_list`) are gone.
- Types whose fresh-supervisor path is a real side effect are verified by
  the e2e suites instead of the parity script: `create` and `attach`
  spawn worker processes (`supervisor_e2e`, `direct_attach_e2e`),
  `ack_result` answers nothing (command-journal ack, `journal.rs`), and
  `restart`/`shutdown`/`prepare_update_restart` terminate or fence the
  supervisor (update-flow e2e and `supervisor_restart_e2e`).
