# Registered work: MCP end-to-end verification

**Status: registered, not scheduled (登记待排).** Do not start this until it is
scheduled. It records a gap in the MCP series that shipped on
`wip/block-images-strip`, with a deliberately small scope so the work cannot grow
into a second feature.

## The gap

The MCP capabilities (resources, prompts, subscriptions, notifications, sampling,
elicitation, telemetry) are covered at the unit and handler level, but no automated
test drives a **real MCP server** through the whole path. The one behavior a user
actually sees — a server pushes a notification and the model wakes with it in the
transcript — is verified only at the `KernelNoticeSink` seam, not end to end.

## Scope (fixed — do not add to it)

One minimal stdio MCP server fixture, implementing exactly:

- `initialize`
- `resources/list`
- `resources/subscribe`
- one `notifications/resources/updated` push after a successful subscribe

Along that one path, assert:

1. the notification row is written to the transcript (the durable custom row);
2. **the model is woken** (the only user-visible behavior this path exists for);
3. the subscription is rebuilt after a kernel reconnect/reload;
4. the row renders through the TUI's custom-message panel for its custom type
   (this absorbs the "no type-level rendering assertion for the new row types"
   gap — a fixture-driven end-to-end test is the cheapest place to pin it).

One fixture, one path. Anything more is a separate card.

## Evidence of the covered ground (run 2026-11-16, Windows)

Numbers below are what the commands printed on the branch head; see
`docs/testing-known-failures.md` for the environment's known red.

| Command | Result |
| --- | --- |
| `cargo test -p pa-daemon --lib mcp_elicitation` | 9 passed |
| `cargo test -p pa-daemon --lib mcp_sampling` | 5 passed |
| `cargo test -p pa-core --lib mcp_notices` | 6 passed |
| `cargo test -p pa-core --lib session_counters` | 2 passed |
| `cargo test -p pa-core --test prompt_guards` | 7 passed |
| `cargo test -p pa-daemon --lib` | 1081 passed, 42 failed — the same 42 names as `main` |
| `cd prime-agent-runtime && uv run --python 3.11 python -m unittest test.test_mcp` | 85 tests, 2 errors (both the known Windows `os.kill` tests) |

## Known not done (kept out on purpose)

- **Third-party MCP servers** (Notion, GitHub, …): manual verification only. Their
  APIs drift; automating them would be a maintenance tax, not coverage.
- **pty end to end**: owned by the agent-backend line's gate, not this one.

## Blockers

- **This batch of commits has never been run on Linux.** The runtime suite and the
  workspace gates ran on Windows only; Linux CI is the authority. Do not treat
  Windows-green as green.
- Branch split/rename and PR timing are the Owner's call; the branch also carries
  the blockImages fix.

## Manual verification, 2026-11-17 (Windows, real ConPTY)

The three behaviors this card exists for were verified by hand once, without a
committed test: the TUI ran under a real Windows ConPTY (pywinpty) with a pyte
screen model, bound to its own daemon socket (`--daemon-socket`) so it never
touched the installed sessions, against a minimal stdlib MCP server (one tool
that sends a single-field `elicitation/create`; one resource whose subscribe
pushes `resources/updated` two seconds later).

Results (raw screen snapshots kept beside the harness):

1. `[mcp_elicitation]` and `[mcp_notification]` rows render in the screen buffer,
   content untruncated (`[verify] asks: … Answer with /elicit accept <name> …`).
2. Idle + a server push ⇒ the row appears and a model turn starts and answers
   with no user input (`resource_updated`).
3. Injected keys `/elicit accept Jev` complete the prompt mid-turn; the waiting
   tool call returns `answer=accept:Jev` (584 ms) and the row
   `[verify] elicitation request 1 accept` lands.

This run found a real defect the unit tests could not see: `/elicit` used to
enter the steering lane, and the steer interrupted the very tool call waiting
for the answer (60 s, `KeyboardInterrupt`). It is now applied in
`Worker::handle_prompt` ahead of admission.

Still not covered by an automated test: everything in "Scope" above. The card
stays registered.
