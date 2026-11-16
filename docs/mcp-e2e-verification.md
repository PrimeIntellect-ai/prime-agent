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
