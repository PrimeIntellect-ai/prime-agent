# Phase G — API-Learning Analog (issues [#25]–[#26](https://github.com/badvision/prime-agent/issues/25), size XL, **deferred**)

Read this doc before touching #25/#26. The design deliberately excludes phase G from the core plan: it activates **only if retained-tool usage outgrows the hand-built catalog**. These are SARK's second axis (implemented there, the `apilearning/` package) expressed for prime-agent.

## Activation conditions

- Phases A–F are stable and retained tools are in real use.
- Retained-tool usage demonstrably outgrows the hand-built catalog (i.e. the catalog is the bottleneck, not the agent's competence).
- **Re-plan first:** the two issues are XL placeholders and are not session-sized as written — re-decompose into session-sized tasks on activation (this is the documented risk on both issues).

## Scope (as intended)

1. **Capability-gap detection → MCP endpoint discovery (#25):** detect recurring capability gaps in retained-tool usage, discover candidate MCP endpoints, and draft a registration proposal a user can review.
2. **Proposed registration + feedback edge (#26):** register the approved MCP tool as a retained tool and wire its usage counters into the phase C gate (so the gates protect it like any other tool).

Depends on phase D (semantic search over a larger catalog) and the existing `McpManager` (`packages/coding-agent/src/core/mcp/mcp-manager.ts`, which today registers only user-declared servers).

## Done when (on activation)

- #25: a detected gap produces one registration proposal a user can review.
- #26: a registered MCP tool appears in `/tools list` with counters that feed the gate.
