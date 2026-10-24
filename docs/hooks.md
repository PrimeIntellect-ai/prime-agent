# Command hooks: bounded compatibility contract

Prime Agent implements bounded command hooks for seven lifecycle events: startup,
prompt admission, tool execution, natural completion, compaction, and shutdown. This is a
bounded subset of the [Codex hooks contract](https://learn.chatgpt.com/docs/hooks),
reviewed on 2026-10-15. It is not a complete Codex extension runtime or a complete
security boundary. Existing tool authorization remains authoritative.

This does **not** restore Pi extension compatibility. The extension subsystem
removed by PR #3189 remains removed; legacy extension configuration keys remain
ignored. These hooks accept only the documented bounded command-hook JSON
contract and do not load or execute old extension modules.

This document records the supported API and deliberate compatibility limits.
Independent static review complements the executed checks described in the
validation record below. Unsupported events and capabilities must produce diagnostics; they
must not silently appear to work.

## Compatibility matrix

| Event | Current Codex contract | Prime Agent implementation |
| --- | --- | --- |
| `SessionStart` | Match `source`: `startup`, `resume`, `clear`, `compact`, `fork`. Text stdout or `hookSpecificOutput.additionalContext` supplies developer context. Common `continue: false` stops before the next model request. | Synchronous control gate, deferred until real work before the first model request. Sources `startup`, `resume`, `compact`; no `clear` or `fork` event is fabricated. Context/text output is explicitly unsupported. Exit 2 is a callback failure, not a veto. |
| `UserPromptSubmit` | Matcher ignored. Input includes `prompt`, `turn_id`. Text/context output supplements developer context; `decision: "block"` or exit 2 rejects the prompt. | Synchronous admission before user-message context/persistence, including queued user batches and hook continuations. Internal autonomous rows are excluded by provenance. Block/exit 2 requires a nonempty reason; context output is unsupported. |
| `PreToolUse` | Match canonical tool name and aliases. Input includes tool id, arguments and turn id. Supports deny, context and allow with replacement arguments. Plain stdout ignored. | Synchronous denial only: modern `permissionDecision: "deny"`, legacy `decision: "block"`, or exit 2. Deny/block and exit 2 require nonempty reasons. Allow/rewrite and model-context injection are unsupported and diagnosed; permissions remain unchanged. |
| `PostToolUse` | Match tool name. Input adds `tool_response`. Synchronous block/exit 2 can replace the model-visible tool result, although effects already happened. Asynchronous handlers cannot control execution. | Requires `async: true`; observation only. No result replacement, approval, continuation or model-context injection. Raw tool output and durable transcripts remain unchanged. |
| `Stop` | Matcher ignored. Input includes `stop_hook_active` and nullable `last_assistant_message`. Block/exit 2 creates a continuation user prompt; `continue: false` wins over continuation. Nonempty plain stdout invalid. | Runs at genuine natural completion after host continuation gates. Ordered block reasons become one persisted user continuation, admitted through UserPromptSubmit. One continuation per run; the next Stop has `stop_hook_active: true` and additional blocks are diagnosed and ignored. |
| `SessionEnd` | Main session only; reason `other`; always synchronous, even with `async: true`. Advisory output. Timeout default 1 second, maximum 3 seconds. Client detachment is not session end. | Root-session explicit shutdown/kill, print completion/error, RPC EOF and RPC-handled SIGTERM/SIGHUP. Concurrent callers join one bounded batch. Exit 0 ignores stdout; failures are advisory. Detach/runtime rebuild and abrupt process death do not emit it. |
| `PreCompact` | Match trigger `manual` or `auto`; common JSON controls, no plain-text context; `continue: false` stops before compaction. | Synchronous gate at shared manual/automatic compaction entry, after eligibility and before the compaction flight lock. JSON `continue: false` vetoes; every nonzero exit is a callback failure. Successful compaction schedules SessionStart source `compact` before the next model call. |

SessionStart stops the next model request; internally generated continuation rows may
already be recorded and are not rolled back. Prompt admission before persistence
applies to submitted user rows, not those internal records.

Other Codex events (`PermissionRequest`, `PostCompact`, `SubagentStart`,
`SubagentStop`, `Interrupt`) are unsupported. MCP, prompt and agent handlers,
plugin manifests, managed hook policy, inline TOML, and Codex config autoimport
are outside this milestone. No tool-permission bypass option is introduced.

Daemon user rows are persisted and forwarded only after core admission succeeds,
including every row in a submitted batch. Accepted text and image content retain
their exact typed wire representation and appear once. A veto, image-route refusal,
engine-build failure, or cancellation before admission leaves no attempted user
row in the transcript. This correctness change also applies with hooks disabled;
older daemon builds eagerly persisted attempted prompts before these checks.
SessionStart classifies custom-only setup/goal history as startup; durable
conversation or its summaries classify as resume. If compaction occurs before
the first admission, the initial startup/resume event runs before the pending
compact event; neither replaces the other. A completed SessionStart stop
is consumed once; cancellation before completion leaves the event pending.

## Configuration and trust

The sources are `<agent_dir>/hooks.json` and
`<git-root>/.prime/hooks.json` (nearest Git root; canonical cwd when no Git root exists). The usual user agent directory is
`~/.prime/agent`. Source order is user, then project; array order is preserved.
Codex's `~/.codex` and project `.codex` settings are not automatically loaded.
Copy a supported JSON definition after reviewing its paths and tool arguments.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /absolute/path/check_command.py",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /absolute/path/record_command.py",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Supported configuration fields are deliberately narrow:

| Level | Accepted fields | Rejected examples |
| --- | --- | --- |
| Source | `description`, `hooks` | Managed/plugin configuration |
| Group | `matcher`, `hooks` | Unknown group fields |
| Handler | `type: "command"`, `command`, integer `timeout` (1–600; SessionEnd 1–3), `async` | `statusMessage`, `additionalContextLimit`, `commandWindows`, `mcp_tool`, `prompt`, `agent` |
| Output | Event-specific controls in the matrix; `systemMessage`; pre-tool `hookSpecificOutput.permissionDecision` and reason | `updatedInput`, `additionalContext`, `updatedMCPToolOutput`, unknown fields |

`suppressOutput` is accepted and ignored on SessionStart, UserPromptSubmit,
PreCompact and Stop, matching upstream behavior. Common controls are rejected on
tool events in this bounded subset. SessionEnd ignores successful stdout entirely.

There is no `/hooks` browser. Hook diagnostics are shown to the user as
display-only `hook_notice` transcript rows; they are never model context:

- The TUI shows each one as a warning status line. Daemon clients, through the
  supervisor or a direct worker connection, receive it as a durable custom row
  (`message_start`/`message_end`).
- Print mode writes each one to stderr as `Warning: <text>`; `--mode json` and
  `--mode rpc` also stream the row as a `message_end` event with
  `customType: "hook_notice"`.
- Load diagnostics (an untrusted or invalid source, or disabled hooks) appear once
  per session, at the first lifecycle dispatch. Command failures, timeouts and
  `systemMessage` output name the event and the command (whitespace collapsed,
  first 120 characters). Identical diagnostics are shown once per session, and at
  most 32 distinct ones are shown before the rest are suppressed.
- A diagnostic raised outside an active run, for example by a late PostToolUse
  observer, appears with the next admitted prompt. SessionEnd failures happen
  while the session closes and are not shown.

An untrusted source reports its path and the fingerprint to trust, for example:

```text
Hooks skipped: /work/repo/.prime/hooks.json is not trusted for /work/repo. Trust covers the file's path and bytes and the session directory, so an edit or another directory needs a new entry. After reviewing it, add this fingerprint to /home/me/.prime/agent/hook-trust.json (see docs/hooks.md):
<sha256>
```

Review and record trust outside the agent run; there is no automatic
trust action or bypass flag. To calculate a fingerprint without changing trust:

```python
import hashlib, os
from pathlib import Path
source = Path("/absolute/path/to/hooks.json").resolve(strict=True)
cwd = Path("/absolute/session/working/directory").resolve(strict=True)
print(hashlib.sha256(os.fsencode(source) + b"\0" + os.fsencode(cwd)
                     + b"\0" + source.read_bytes()).hexdigest())
```

Matchers are regular expressions. Omitted, empty or `"*"` matches every
matched event value. UserPromptSubmit and Stop ignore matchers. SessionStart matches source,
PreCompact trigger, SessionEnd reason, and tool events canonical tool name. Prime does not expand Codex tool aliases; match `Bash`, `edit` or `python_repl` as applicable. Hook commands run in the session working directory, which can
be a repository subdirectory; absolute script paths are preferable.

Both sources require explicit trust. The trust record is
`<agent_dir>/hook-trust.json`, never repository configuration:

```json
{
  "version": 1,
  "trusted": ["<reviewed-source-sha256>"]
}
```

For both sources, the digest binds the canonical source path, a NUL separator,
the canonical session cwd, another NUL separator, and the exact source bytes.
Trust is deliberately specific to the execution directory, even for user hooks. On the next configuration load, editing a source invalidates its trust.
Configuration is an immutable per-session snapshot loaded at first lifecycle dispatch;
reopen the session to load configuration or trust changes. This conservatively
trusts the whole source rather than Codex's individual hook definitions.
Trusting a command definition does not authenticate the contents of external
scripts it invokes; review those scripts and their update process too.

Untrusted sources are skipped with diagnostics in interactive, daemon, direct
and headless execution. Headless execution cannot implicitly approve project
hooks. A project cannot provide its own trust record. The trust file must be a regular
file, not a symlink, and the agent directory must be outside the canonical
project root. On Unix, both trust file and directory must belong to the current
user and must not be group- or world-writable. Configuration sources also reject
final-component symlinks. Files are opened nonblocking before checking regular-file
metadata, so a FIFO cannot wait indefinitely for a writer. Hook trust never changes tool permissions.

Each source is validated atomically: one invalid event, handler, matcher or limit
skips that entire source with a diagnostic. An invalid project source cannot
remove accepted user hooks. An invalid or unsafe shared trust record disables
both sources. These failures leave normal runtime behavior unchanged.

## Wire contract

A command receives one JSON object on standard input. The output contract uses
Codex's field spelling: snake_case inputs, camelCase outputs. Protocol version
1 is identified outside this JSON object through
`PRIME_AGENT_HOOK_PROTOCOL_VERSION=1`; adding `schema_version` to the input
would violate Codex's schemas, which disallow extra fields.

All payloads follow their event-specific schemas. Tool-event fields include:

| Input | Meaning |
| --- | --- |
| `session_id` | Durable session identity; daemon mirrors use the host ledger identity rather than their temporary in-memory manager id. |
| `transcript_path` | Existing raw session transcript path, or JSON `null`. Its file format is not a stable hook API. |
| `cwd` | Session working directory. |
| `hook_event_name` | `PreToolUse` or `PostToolUse`. |
| `model` | Active model identifier. |
| `permission_mode` | `default` for this milestone. This is descriptive, never authorization or a claim of Codex approval-mode equivalence. |
| `turn_id` | UUID generated at the real `AgentStart` boundary and shared across that run's tool calls. |
| `tool_name` | Canonical hook-facing tool name; shell calls use `Bash`. |
| `tool_use_id` | Tool invocation identifier, shared by its pre/post events. |
| `tool_input` | Tool arguments. Bash supplies its string `command`. |
| `tool_response` | Post event only: the original tool response. |

Lifecycle payloads use the following exact field sets; absent optional agent metadata
is omitted. Every event includes `session_id`, `transcript_path`, `cwd` and
`hook_event_name`.

| Event | Additional fields |
| --- | --- |
| SessionStart | `model`, `permission_mode`, `source` |
| UserPromptSubmit | `model`, `permission_mode`, `turn_id`, `prompt` |
| Stop | `model`, `permission_mode`, `turn_id`, `stop_hook_active`, `last_assistant_message` |
| PreCompact | `model`, `turn_id`, `trigger` |
| SessionEnd | `reason: "other"` |

SessionStart reports `resume` when restored conversation history is present; an
empty restored session currently reports `startup`. There is no separate `clear`
or `fork` source in this implementation.

Pre-run compaction uses a lifecycle UUID initialized with the engine. A real
AgentStart replaces it with the actual run UUID; Stop feedback stays in that run.
Manual triggers include explicit user/model requests; automatic threshold and
overflow compaction use `auto`. RPC preflight runs outside transport guards and
returns a single-use permit bound to the session/model/instructions. The host
revalidates the session before mutation; consuming the permit cannot run a second
command under those guards.
Daemon `/compact` and RPC manual compaction register host cancellation before
preflight; abort and shutdown cancel a blocked hook, and the permit retains the
same signal through guarded execution.

The current CLI and daemon constructors expose `python_repl` as their model tool;
hook support does not add or rename tools. Shared-engine embeddings can register
other tools. Hook matching uses the resolved executor name: the executable
`python` and `ipython` aliases therefore match `python_repl`, while raw model call
names and IDs remain unchanged in history. The adapter maps a registered `bash` tool to canonical `Bash`, while
`edit` remains `edit` rather than pretending to be Codex `apply_patch`. A Codex
`Bash` matcher therefore does not intercept shell operations performed inside the
Python kernel. Interception at the outer Python tool does not imply interception
of every nested operation in that persistent kernel.

The binary transport probes veto one real `python_repl` call and observe the
original error result of a second call with kernel bootstrap explicitly disabled.
Shared-engine tests separately verify generic tool denial and unchanged successful
results. This distinction avoids claiming coverage of a live Python environment
or a native Bash/edit surface that those constructors do not currently provide.

A synchronous denial can return:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "This command requires a different workflow."
  }
}
```

The equivalent legacy output is:

```json
{"decision":"block","reason":"This command requires a different workflow."}
```

Model-visible hook text names its source: tool denials use
`Blocked by a PreToolUse hook: <reason>` and Stop continuations use
`Continuation requested by a Stop hook: <reason>`. The original reason is
preserved after the prefix; hook JSON schemas are unchanged.

All events except PostToolUse and SessionEnd require synchronous handlers.
PostToolUse requires `async: true`; SessionEnd ignores the async setting.

For PreToolUse and UserPromptSubmit, exit code 2 requires nonempty trimmed
standard error as the denial reason. Stop uses that text as continuation feedback.
Empty reasons are callback failures; they do not invent a veto. SessionStart and
PreCompact treat every nonzero exit as a callback failure. Exit 0 with empty stdout
is success without a decision. Non-JSON plain stdout is ignored for tool
events, matching Codex. A background observer should exit 0 with no output;
it cannot block a completed tool. `systemMessage` is shown to the user as a hook
diagnostic for every supported event except SessionEnd, whose stdout is ignored; it is not injected into model context.
Unsupported structured control fields must
be diagnosed rather than silently interpreted as an approval or rewrite.

Malformed JSON, unsupported output and command failures are hook failures,
not tool denials. Each handler's output is interpreted atomically: combining a
valid deny with an unsupported field fails that handler rather than applying a
partial decision. A denial must come from a successfully interpreted supported
decision. This follows Codex's documented distinction between a supported
policy decision and a callback failure; hooks are not a replacement for the
runtime's permission boundary.

## Runtime and resource requirements

The implementation loads configuration lazily on a blocking worker at first lifecycle dispatch,
without external commands on engine construction, session load or first paint.
The inactive path retains the original tool result behavior; performance checks
must also account for callback-context construction in the agent loop.

Command execution is supported on Linux and macOS; other platforms reject it
with a diagnostic. The command runner limits configuration files to 256 KiB, total handlers and groups to 32 each across both sources,
matchers to 1,024 bytes, command strings to 16 KiB, and trust entries to 256;
input to 1 MiB and each output stream to 64 KiB. Timeout defaults to 600 seconds, except SessionEnd defaults to 1 second with a
3-second maximum. SessionEnd also has a total 3-second batch budget, including queue
admission, configuration loading, and cancellation/joining of observers and active synchronous commands. New command admission stops when shutdown begins. Values above event limits are rejected. A process-wide semaphore limits
children to four, with at most three occupied by background observers so
synchronous decisions retain capacity. Each session admits at most eight running or pending
tool observations. Each observation can match up to 32 handlers, giving a
maximum of 256 pending/running observer-handler invocations per session. Input bytes are shared between pending handlers; only the four active command
slots make private stdin copies. These are per-worker-process limits, not a
daemon-wide quota. Timeouts
include pipe operations and queue admission. Readers and the stdin writer run
concurrently to avoid pipe deadlocks. A full observer queue reports overflow
and returns immediately; it cannot stall tool execution.

Cancellation, timeout and dropped work terminate the process group and reap
the child. Descendants retaining stdout/stderr cannot extend the deadline.
Hook commands receive `PRIME_AGENT_HOOK_ACTIVE=1`; a Prime Agent invocation
inheriting that marker disables nested hook runtimes. Limits and platform support must be explicit in implementation
diagnostics and verified with real subprocess tests.

Matching synchronous hooks should be launched independently under the resource
bound and their results combined in source/group/handler order. A common `continue: false` takes precedence over denial or continuation. Otherwise, the first denial is retained and Stop reasons are joined in order, bounded to 64 KiB; one hook cannot approve an operation another denies. Observers may finish out
of order and their output cannot initiate a new model turn. Never hold a
session-manager lock while awaiting an external command.

Codex defaults most command hooks to 600 seconds and runs up to eight
background hooks concurrently per session, with additional invocations queued.
Prime Agent preserves the default timeout but imposes the additional finite
limits above. Its smaller process concurrency and bounded observer admission
are deliberate compatibility deviations. Unsupported timeout values are
rejected explicitly rather than silently clamped. Subagent sessions are
excluded in this milestone; no fabricated parent session identity is emitted.

## Schema evidence

The official page defines release behavior; the linked schemas on `main` can
contain unreleased fields. All seven requested event input schemas and the six
available output schemas were inspected. SessionEnd has no output schema.

| Event | Generated schemas |
| --- | --- |
| SessionStart | [input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.input.schema.json), [output](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-start.command.output.schema.json) |
| UserPromptSubmit | [input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json), [output](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json) |
| PreToolUse | [input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json), [output](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json) |
| PostToolUse | [input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/post-tool-use.command.input.schema.json), [output](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/post-tool-use.command.output.schema.json) |
| Stop | [input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/stop.command.input.schema.json), [output](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/stop.command.output.schema.json) |
| SessionEnd | [input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/session-end.command.input.schema.json) |
| PreCompact | [input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-compact.command.input.schema.json), [output](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-compact.command.output.schema.json) |

Event-specific schema details:

- SessionEnd lacks `model` and `permission_mode`, despite the general common
  input prose. Its exact input is session id, transcript path, cwd, event and
  reason.
- PreCompact lacks `permission_mode`; its output has common controls only,
  without `decision`, `reason` or `hookSpecificOutput`.
- Stop has no `hookSpecificOutput`. A block requires a reason at semantic
  validation time, even though the JSON schema does not require that field.
- SessionStart now includes `fork` in both the release page and generated schema.
  Prime does not emit that source; its supported sources remain listed above.
- Optional `agent_id` and `agent_type` appear on tool, prompt and compaction
  inputs. Omit absent optional fields rather than emitting JSON null.
- Background Codex hooks can deliver informational model context at a later
  safe point; that output delivery is outside this observer-only post-tool implementation.

Context injection, tool-input rewrites, synchronous post-tool decisions, and unlimited
Stop continuations remain outside this bounded contract. No developer-role channel
is fabricated in Prime Agent's provider message types.

An invalid or unreadable source is skipped atomically with a diagnostic. It cannot
disable accepted hooks from another source; in particular, a malformed untrusted
project source cannot remove a trusted user policy. Invalid trust authority still
disables all hooks.

## Security-hook suitability and concrete gaps

This subset can veto a **supported root-session model tool invocation** before
its tool executor runs. It cannot currently establish that an extension-era
security policy is enforced across Prime Agent. Do not describe it as a complete
security boundary or as a verified migration of existing security hooks. Each
policy and its hook definitions require a separate coverage assessment.

| Path or requirement | Current coverage and consequence |
| --- | --- |
| Root-session model tools | PreToolUse sees prepared, schema-validated arguments and a supported nonempty deny prevents the executor from running. The original model call and denial remain in the transcript. CLI/daemon currently expose `python_repl`; a `Bash` matcher alone does not protect that surface. |
| Operations inside an allowed Python cell | No separate hook for nested shell commands, file/network operations or kernel-host requests. The outer cell can be rejected as a whole; its later dynamic operations are not individually authorized by this API. Previously started background kernel work is not retroactively vetoed. |
| Subagent model tools | All hooks are excluded at `rlm_depth > 0`, including PreToolUse. Parent-cell admission does not enforce a policy on the child's later calls. This exclusion is intentional and tested. |
| Daemon user bash | `execute_bash` and `execute_bash_and_wait` route through `user_bash::run_bash`, which directly spawns the shell and does not enter the model-tool hook pipeline. A model-tool Bash matcher does not cover this separate user-command surface. |
| Preparation and refused calls | Tool lookup, `prepare_arguments` and schema validation precede the hook. Unknown/invalid tool calls do not execute, but also do not produce Pre/Post hook audit events. An embedding's preparation callback is outside this veto boundary. |
| Permissions and approvals | `permission_mode` is the fixed descriptive value `default`, not a live permission/sandbox policy. PermissionRequest and allow/rewrite controls are unsupported. The adapter can deny; it neither grants permissions nor adds an independent sandbox or approval system. Existing execution restrictions, where provided, remain necessary. |
| Post-execution security controls | PostToolUse is asynchronous observation only. It cannot prevent an effect, roll it back, redact the original result/transcript, or replace model-visible output. Its bounded queue can drop observations and shutdown cancels outstanding observers, so it is not a guaranteed security audit sink. |

**PreToolUse is fail-open on hook failure.** No matching/trusted handler means no
hook veto. Missing/unreadable/invalid configuration or trust, mismatched
fingerprints, regex execution errors, process spawn failure, timeout (including
slot waiting), input above 1 MiB, output above 64 KiB per stream, malformed output,
unsupported fields, nonzero exits other than valid exit 2, and empty deny reasons
leave the operation unchanged. A hook diagnostic reports failures, but there is no required
policy mode, fail-closed option, or interactive/headless admission error for an
unavailable security hook. Another successfully parsed handler can still deny.
Cancellation remains governed by the host's abort handling; a discarded hook
outcome is not itself authorization to ignore cancellation.

For example, exit 2 with empty stderr does not deny. A JSON denial combined with
an unsupported field such as `additionalContext` is rejected atomically and does
not partially apply the denial. Existing Codex/security scripts must be checked
against the supported output subset before relying on them.

**Trust approves execution of hook code, not mandatory enforcement of policy.**
The source/cwd/bytes fingerprint and safe trust-file ownership prevent project
configuration from silently authorizing itself. They do not pin external script
contents, prevent an authorized user from removing/changing configuration, or
make trust tamper-proof against the same OS user. Changes take effect only on the
next session snapshot; removing trust does not revoke an already loaded session.
Commands inherit the host environment and run under its OS authority, with
process/resource bounds rather than isolation. `PRIME_AGENT_HOOK_ACTIVE` is an
unauthenticated recursion guard: its presence disables hooks in that process,
including a separately launched child agent. It is not an enforcement credential.

Code evidence: [tool admission pipeline](../crates/pa-agent/src/agent_loop/tool_call.rs),
[adapter and fixed permission mode](../crates/pa-core/src/session_engine/hooks.rs),
[root-only installation](../crates/pa-core/src/session_engine/engine.rs),
[failure/admission handling](../crates/pa-core/src/hooks/mod.rs),
[atomic output parser](../crates/pa-core/src/hooks/output.rs),
[configuration/trust](../crates/pa-core/src/hooks/config.rs),
[command process authority](../crates/pa-core/src/hooks/process.rs), and
[user-bash execution](../crates/pa-daemon/src/user_bash.rs).

Fail-closed policy, broader interception, permission controls and legacy extension
support require separate designs and validation; this API does not provide them.

## Independent implementation review

Static review checked these concrete implementation boundaries:

- Configuration uses an immutable lazy snapshot, exact source/cwd hashes and
  descriptor-based trust ownership checks. Nonblocking, no-follow file opening
  rejects FIFO and final-component symlink sources.
- The adapter emits the required tool-event fields, including an AgentStart
  run UUID; it maps `bash` to `Bash` and returns no post-tool result override.
  Its metadata-only callback mode omits conversation-history snapshots; the
  existing generic callback API keeps full snapshots by default.
- Pending handlers share serialized input, with copies made only after acquiring
  one of four active process slots. Observer admission bounds tool observations
  to eight, not individual handlers; up to 256 handlers can be pending.
- The output parser validates supported JSON atomically. Unsupported allow/rewrite/context
  outputs fail the hook without changing authorization.
- Process cleanup signals the process group without a potentially recycled PID
  fallback, including after normal shell exit. Standard input, both output
  streams and child exit are handled concurrently under a deadline.

## Validation record

The initial seven-event implementation was developed against `3e0893260` and
recorded in commit `3ae7c6c08`. Its historical validation included:

- 41 focused hook/runtime/adapter tests and 4 final lifecycle regressions,
  including durable daemon identity.
- 406 shared session-engine tests, 35 pa-agent tests, 120 worker tests,
  4 RPC protocol tests, and 45 print/RPC integration tests. Live-provider and
  kernel-launch cases were excluded where documented by those runs.
- Binary probes through print JSON, stdio RPC, supervisor JSONL and direct
  authenticated worker transport; child-worker exclusion was exercised with
  trusted hook definitions present.
- Formatting, whitespace and strict Clippy checks for the tested targets.
  These were not a claim that every workspace target or live environment passed.

Binary probes used a faux provider and deliberately disabled Python bootstrap.
They establish lifecycle dispatch, denial, unchanged error results and transcript
identity on those paths; they do not establish policy coverage inside a live
Python kernel. The reproducible transport harness and its setup are in
[`scripts/hooks_transport_probe.py`](../scripts/hooks_transport_probe.py) and
[its instructions](../scripts/hooks_transport_probe.md).

The 2026-10-15 integration targets main commit `5f218f780dabc51e26b039580da5d0686cc5616a`.
The official release documentation and all thirteen linked schemas were checked
again on that date. Historical test counts and startup/load measurements do not
validate the integrated revision. Fresh formatting, focused lifecycle/runtime
checks, transport probes and applicable integration checks must be recorded
against the exact PR head; consult the PR validation results for their outcomes.
