# ACP Mode

ACP mode makes Prime Agent an [Agent Client Protocol](https://agentclientprotocol.com) agent, speaking JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout. Any ACP client — an editor like Zed or VS Code, or an evaluation harness — can drive it without knowing anything Prime Agent-specific.

```bash
prime-agent --mode acp
```

Use ACP mode when something external needs to *drive* a session interactively: prompt, watch tool calls stream, cancel a turn. For batch runs where you want every event dumped and an exit code, [JSON event stream mode](json.md) is a better fit. [RPC mode](rpc.md) remains available and exposes Prime Agent's own richer command surface.

## Transport

- One JSON-RPC message per line on stdout, requests read from stdin.
- stdin stays open for the life of the connection; the agent exits when it closes.
- Diagnostics go to stderr. Never write anything else to stdout, which belongs to the protocol.

## Supported methods

| Method | Notes |
|---|---|
| `initialize` | Returns protocol version, capabilities, and agent info. |
| `session/new` | Creates the session. One session per connection. |
| `session/prompt` | Runs one turn and resolves with a stop reason. |
| `session/cancel` | Notification; aborts the addressed session's turn. |
| `session/close` | Releases the session and frees the connection for a new one. |

One session per connection is a deliberate limit: Prime Agent's underlying session is fixed at process startup, so a second concurrent session would silently share its conversation, working directory, and model. A second `session/new` is refused rather than pretending to isolate. Start another process for a second session.

Likewise `session/prompt` refuses a concurrent turn while one is running, and the working directory cannot be changed after startup — a client-supplied `cwd` that differs from the agent's real one is reported back in `_meta` rather than silently ignored.

## Streamed updates

Session activity arrives as `session/update` notifications:

| Prime Agent activity | ACP update |
|---|---|
| assistant text | `agent_message_chunk` |
| reasoning | `agent_thought_chunk` |
| tool starts | `tool_call` (`in_progress`) |
| tool finishes | `tool_call_update` (`completed` / `failed`) |
| shell output | `tool_call` plus incremental `tool_call_update` |

IPython is Prime Agent's model-facing tool, so a cell is a `tool_call` of kind `execute` whose `rawInput` carries the cell source.

## Prime Agent extensions

Prime Agent has capabilities ACP has no field for: subagents, autonomous quality gates, goals, heartbeats, continual-harness refinement, compaction, and rich IPython output. These travel in a reverse-domain `_meta` envelope:

```json
{
  "sessionUpdate": "session_info_update",
  "_meta": {
    "ai.primeintellect.prime-agent": {
      "subagents": [{ "id": "sub-1", "sessionName": "reviewer", "status": "running" }]
    }
  }
}
```

A standard ACP client ignores `_meta` entirely and still works. A Prime Agent-aware client, or a harness that cares about subagent trees and gate attempts, reads it. Nothing non-standard is ever added to an ACP object root, which the protocol reserves for future fields.

## Stop reasons

`session/prompt` resolves with one of ACP's stop reasons:

- `end_turn` — the turn finished normally.
- `cancelled` — `session/cancel` aborted it.
- `max_tokens` — an autonomous token budget was exhausted.
- `max_turn_requests` — an autonomous turn, continuation, or wall-clock limit stopped the run.

Autonomous quality gates run *inside* a single prompt turn. A failing gate is a continuation, not a stop reason, so the turn resolves only once the gate loop settles. Gate attempts are visible in `_meta` while that happens.
