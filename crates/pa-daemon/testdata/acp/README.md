# ACP differential corpus (slice 1)

Captures of the installed TS binary (`prime-agent --mode acp --no-session
--provider prime-inference --model z-ai/glm-5.3-flash`) speaking ACP over
stdio, one file per scenario. Every file is line-delimited JSON:

    {"scenario": ..., "direction": "in"|"out", "frame": {jsonrpc frame}}

`out` lines are what the scenario client sent; `in` lines are what the
binary answered, in order. The last line of each file is a `meta` row with
the process exit code and stderr.

## Scenarios

- `happy_path`: initialize, session/new (matching cwd), one text prompt,
  session/close. Shows the full completion envelope: chunks, then the
  `responseBoundary` info update (`terminalQuiescenceExpected: true`,
  `outcome`), the quiescence event, the `terminalQuiescence` envelope, then
  the `{stopReason}` response.
- `cwd_mismatch`: session/new with cwd `/tmp` while the process runs in
  another directory. The result carries `_meta.cwd {requested, actual}`.
- `errors`: unknown-session prompt/close, a second session/new on a live
  connection, an unknown method (`-32601` with the observed message
  shape), close. Also demonstrates the one-`initialize`-per-connection
  behavior of the served surface.
- `second_initialize`: a second `initialize` on the same connection is
  served normally.
- `cancel`: `session/cancel` mid-turn. The prompt resolves
  `{stopReason: "cancelled"}` with no boundary frames after the streamed
  chunks.
- `tool_call`: a turn that calls the ipython tool (`6*7`). Shows the
  `tool_call` / `tool_call_update` shapes including the `content` wrapper
  and the ipython rich-output `_meta` on results that carry attachments.
- `compact_command`: two turns, then `/compact`. The session is too short
  to compact, so the observable parity is the namespaced `compaction: {}`
  update (the TS `compaction_end` with an undefined result) followed by the
  normal completion envelope and `end_turn`.
- `goal_command`: `/goal <objective>` then `/goal status`. Shows the
  goal-start `_meta.goal` frame, mid-turn usage updates after each settled
  message, the completion observation, and the status-prompt frame.
- `autonomous_gate`: `--autonomous --autonomous-gate true`. The gate passes
  after the first turn: the completion and terminal envelopes carry the
  `_meta.autonomous` accounting and `remainingAutonomousContinuations`
  reflects the configured budget; the stop reason is `end_turn`.
- `autonomous_limit`: `--autonomous --autonomous-max-tokens 1`. The token
  limit stops the run: the envelopes carry the final accounting and the
  stop reason is `max_tokens`.
- `mcp_stdio`: `session/new` with two valid servers (one stdio with a
  literal environment entry, one http with a header) plus one
  schema-invalid entry (missing the required `env` array): the ACP SDK
  zod filter (`vecSkipError(zMcpServer)`) silently drops it, admission
  succeeds with the survivors, and close releases them.
- `mcp_replace`: admission, close, then a replacement admission with a
  different server list — the owner-scoped clear/re-release cycle.
- `mcp_errors`: the full resolve-stage rejection matrix, every entry
  schema-valid: bad name pattern, duplicate name, NUL in the stdio
  command, duplicate environment entry (case-sensitive), duplicate HTTP
  header (case-insensitive, the reason reports the second casing),
  unsupported sse transport, embedded URL credentials (all `-32602` with
  the exact TS `reason` payloads), then a name that passes the 64-char
  admission pattern but fails the 48-char tool-name pattern
  (`-32603` with `Invalid ACP MCP server name: ...` details), then a
  valid admission and close. Failed admissions keep the connection
  serving.

## The Rust captures in this directory

The `rust-*.jsonl` files are the evidence run for this slice: the same
scenario client against the Rust build with the same provider/model
(`z-ai/glm-5.3-flash`) and the kernel sidecar resolved through
`PI_PACKAGE_DIR` (a cargo-built binary has no sidecar next to the exe).

Since slice 4 the Rust ACP mode prefers the daemon-attached transport
(the TS `shouldUseDaemonClient` behavior): the binary spawns a supervisor
on the sandboxed `--daemon-socket`, hosts a client-owned daemon session,
and streams its session events as ACP updates. The daemon-attached
captures are: happy_path, cwd_mismatch, errors, second_initialize,
tool_call, compact_command, mcp_stdio, mcp_replace, mcp_errors — all
MATCH in full mode. The in-process engine stays the fallback when no
daemon is reachable, and three captures still ride it (they exercise
surfaces the daemon plane serves differently today):

- `cancel`: the in-process capture matched in full mode; the
  daemon-attached run resolves the same `{stopReason: "cancelled"}` shape
  with no boundary frames, but a fresh worker's first-token latency
  exceeds the scenario's 2s cancel window, so the pre-cancel chunk count
  differs per run. The daemon-attached cancel semantics are locked by
  the deterministic e2e (`acp_daemon_attached_cancels_mid_turn`).
- `goal_command` / `autonomous_limit`: the daemon worker executes the
  commands (durable rows, goal continuations, the autonomous loop) but
  does not yet emit `goal_update` / autonomous-accounting session events,
  so the namespaced metas are an in-process-only surface until the
  daemon event plane grows those producers. `autonomous_gate` matches in
  full mode on the in-process capture.

## Comparing a Rust run

`compare_differential.py` normalizes both captures (volatile ids, version,
model-generated text, sequence numbers) and compares the frame shape
sequences field by field. `mcpCapabilities` is compared exactly: both
binaries advertise `{ "http": true }`:

    python3 compare_differential.py ts-happy_path.jsonl rust-happy_path.jsonl

Both captures must come from the same scenario client with the same
request order. `crates/pa-cli/tests/acp_mode_e2e.rs` locks the deterministic
scenarios offline against the scripted faux provider; the
network-dependent scenarios (tool_call, cancel mid-turn) are verified by
running the scenario client against both binaries on a networked box.

`--landmarks` drops model-behavior-dependent work frames (tool calls,
chunk streams, and mid-turn goal-usage updates) and compares the protocol
envelopes only. Use it for scenarios where the two model runs legally
diverge in their tool usage (`goal_command`: one run answered directly,
the other ran several ipython cells; `autonomous_limit`: one run wrote
the essay with tool calls, the other without — both sequences are
correct protocol behavior). The goal and autonomous frames themselves are
locked field-by-field by the offline e2e tests. All other scenarios
(happy_path, cwd_mismatch, errors, second_initialize, tool_call,
compact_command, cancel, autonomous_gate, mcp_stdio, mcp_replace,
mcp_errors) match in full mode.
