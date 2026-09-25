# Herdr Integration Contract

Contract version: **1**

This page lists the values [Herdr](https://herdr.dev) can rely on to detect, track, and resume Prime Agent in a Herdr pane. Prime Agent ships a built-in Herdr reporter. No `herdr integration install` step is needed. Values in tables are exact strings. Changes follow the [Versioning](#versioning) section below.

## Identity

| Field | Value |
|---|---|
| `source` | `custom:prime-agent` |
| `agent` | `prime-agent` |
| Executable | `prime-agent` |

The reporter sends the same `source` and `agent` on every `pane.report_agent` and `pane.release_agent` request.

Proposed official pair: `("herdr:prime-agent", "prime-agent")`. Herdr resumes sessions only for official pairs, so Herdr does not restore Prime Agent sessions until it adopts this pair. When Herdr ships the pair, Prime Agent will switch `source` to `herdr:prime-agent` in contract version 2.

## Activation

The reporter is active only when all of these conditions are true:

- `HERDR_ENV` is `1`
- `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are set and non-empty
- the session is not an RLM subagent (subagents share the parent's pane and never report)
- extensions are not disabled (`--no-extensions` also disables the built-in reporter)
- no extension file named `herdr-agent-state.ts` or `herdr-agent-state.js` was loaded (for example Herdr's Pi integration copied into `~/.prime/agent/extensions/`). If one was loaded, the built-in reporter stays off for that session load, so two reporters never race on one pane. That extension then reports with its own identity, and this contract does not apply.

Interactive sessions usually run in the Prime Agent background service. The pane's `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` are forwarded to the service when the session is created, so each session reports for the pane that created it.

## Wire Protocol

Each request is one JSON line written to `HERDR_SOCKET_PATH`. The connection is closed after the first response byte, the peer closing, an error, or 500 ms. Responses are not inspected. On Windows a Unix-style socket path is mapped into `\\.\pipe\`.

```json
{"id":"custom:prime-agent:<ms>:<rand>","method":"pane.report_agent","params":{"pane_id":"<HERDR_PANE_ID>","source":"custom:prime-agent","agent":"prime-agent","state":"working","seq":1780000000000000,"agent_session_path":"/home/me/.prime/agent/sessions/<id>.jsonl"}}
{"id":"custom:prime-agent:release:<ms>:<rand>","method":"pane.release_agent","params":{"pane_id":"<HERDR_PANE_ID>","source":"custom:prime-agent","agent":"prime-agent","seq":1780000000000001}}
```

`message` is sent only for `blocked` reports and is omitted otherwise.

### Sequence Numbers

`seq` is an integer. It starts at the current Unix time in milliseconds × 1000, and each report uses `max(previous + 1, now_ms × 1000)`. It is strictly increasing across all sessions in one Prime Agent process. That includes successor sessions after `/new`, `/resume`, `/fork`, or a reload. A later process in the same pane starts above an earlier process's values. Values stay below 2^53.

## Lifecycle States

| Prime Agent event | Reported state | Notes |
|---|---|---|
| Session start (startup, reload, new, resume, fork) | `idle`, or `working` if the agent is already streaming | Always sent, even if unchanged. Also refreshes the session reference. |
| Agent turn starts | `working` | Clears any pending error hold. |
| Turn ends normally, nothing queued | `idle` | Sent immediately. |
| Turn ends with queued follow-up or steering messages | `idle` after 250 ms | Cancelled if the next turn starts first, so the pane does not flicker. |
| Turn ends with a provider error (`stopReason: "error"`) | `working`, then `blocked` after 2500 ms | If a retry starts within the grace window, the pane stays `working`. Otherwise `blocked` with `message` set to the error message, or `provider error` if the error has no message. |
| User abort (`stopReason: "aborted"`) | `idle` | |
| Extension emits `herdr:blocked` with `{ active: true, label }` | `blocked` with `message` set to `label` | Blocks nest. Each `{ active: false }` closes one block, and the state is recomputed when none remain. |
| Session runtime ends (for example `prime-agent stop <agent>` or `prime-agent shutdown`) | `pane.release_agent` | Sent after any in-flight report finishes. It is the last write, and no report follows it. |
| Session replaced (`/new`, `/resume`, `/fork`) or reloaded | nothing | The old reporter goes silent without releasing. The successor reports immediately. |

Priority when several apply: `herdr:blocked` block > provider-error `blocked` > `working` > `idle`. A report is sent only when the state or message changes, except that session start always sends a report. Duplicate turn-end events that arrive while no turn is active are ignored.

Closing the TUI does not end a session that runs in the Prime Agent background service. The client detaches, the session keeps running, and the pane is not released. The session keeps reporting to the pane that created it, for example `idle` when a running turn ends.

Prime Agent's own prompts do not currently report `blocked`. `blocked` comes only from unretried provider errors and from extensions that emit `herdr:blocked` on the extension event bus (`pi.events.emit("herdr:blocked", { active, label })`).

The 250 ms and 2500 ms defaults can be tuned with `HERDR_PI_IDLE_DEBOUNCE_MS` and `HERDR_PI_RETRY_GRACE_MS` (non-negative integers, in milliseconds). These tuning variables are not part of the versioned contract.

## Session Identity

Each report carries exactly one session reference:

| Field | Value | Sent when |
|---|---|---|
| `agent_session_path` | Absolute path of the session JSONL file | The session has a file and its path starts with `/` |
| `agent_session_id` | Session id | Otherwise (for example on Windows, or sessions without a file) |

- Session ids of new sessions are UUIDv7 strings (for example `019e71ec-e08a-75a9-b573-aaaaaaaaaaaa`). Treat them as opaque.
- The default file location is `~/.prime/agent/sessions/<session-id>.jsonl`. The directory can be moved with `PRIME_AGENT_CODING_AGENT_DIR`, `PRIME_AGENT_SESSION_DIR`, the `sessionDir` setting, or `--session-dir`. Use the reported path as is. Do not rebuild it from the id.
- The file may not exist until the session has content (usually after the first assistant reply). If that session is no longer running, resuming a path that does not exist yet starts a new empty session, and resuming the id fails.
- The reference is updated on every session start, so it follows `/new`, `/resume`, and `/fork` in the same pane.
- `session_start_source` is not sent.
- Sessions started with `--no-session` have no file. Their reported id cannot be resumed.
- The file format and its versioning are documented in [Session Format](session-format.md).

## Resume

| Session reference kind | Resume argv |
|---|---|
| `path` | `["prime-agent", "--resume", <path>]` |
| `id` | `["prime-agent", "--resume", <id>]` |

`-r <value>` and `--resume=<value>` are equivalent. With `--resume` or `-r`, pass the value as its own argv element, not as shell text.

A path is preferred:

- A value containing `/` or `\`, or ending in `.jsonl`, is opened directly as a file. The session runs in the working directory recorded in its file, and no directory scan happens.
- Any other value is matched against saved session ids in the configured sessions directory. The match is dash-insensitive and case-insensitive: first an exact id match, then a unique hex prefix or suffix. Ambiguous or unknown values exit with an error. If the matched session was recorded in a different working directory, Prime Agent asks in the terminal whether to fork it into the current directory. Without a terminal, it exits with an error.
- If the session is still running in the Prime Agent background service, the client attaches to it and does not load a second copy. The attached session keeps the `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` it was created with, so lifecycle reports go to the new pane only if Herdr reuses the same pane id and socket path.
- `--resume` without a value opens the interactive session picker and requires a terminal. Herdr should always pass a value.

Suggested Herdr resume table entry once the official pair exists (mirrors Pi and OMP; both path and id are accepted):

| source | agent | ref kinds | argv |
|---|---|---|---|
| `herdr:prime-agent` | `prime-agent` | `path`, `id` | `prime-agent --resume <value>` |

## Detection

The built-in reporter is the primary signal. Screen or process detection manifests are Herdr's fallback and are maintained in Herdr.

| Signal | Value |
|---|---|
| Foreground process | `prime-agent` for native installs. npm installs run under Node and set the process title (argv[0]) to `prime-agent`; on macOS their kernel process name stays `node`. |
| Terminal title (informational) | `prime-agent - <cwd basename>`, or `prime-agent - <session name> - <cwd basename>` for named sessions. The agents view uses `prime-agent - Agents`. Set with OSC 0. Extensions can override it, so it is not part of the versioned contract. |

## Versioning

- The contract version is an integer, currently `1`. It changes when a value in the Identity, Wire Protocol, Lifecycle States, Session Identity, or Resume sections changes incompatibly. Values marked informational are not versioned.
- Every version change is recorded in the Changelog section below and in the Prime Agent release notes.
- Inputs Prime Agent accepts (the resume argv forms and session file paths) keep working for at least two minor releases after a breaking change.
- Identity strings Prime Agent sends (`source`, `agent`) cannot be sent in two forms at once. A change to them bumps the version, is announced here first, and is coordinated with Herdr so that Herdr accepts both pairs during the transition.

## Changelog

- **Version 1**: First published contract. The reporter `source` changed from `herdr:pi` to `custom:prime-agent`, so Prime Agent no longer reports under Pi's source.
