# MCP Integrations

Connect external services (Linear, Notion, …) to Prime Agent over the
[Model Context Protocol](https://modelcontextprotocol.io).

Consistent with Prime Agent's single-tool design, MCP integrations are **not**
exposed as new agent tools. Every service is reached through the one generic
Python `mcp` module that is pre-imported in the kernel:

```python
# Discover, then call. Connection ids come from /plugins or the connections list.
tools = await mcp.list_tools("linear")
result = await mcp.call_tool("linear", "list_issues", {"team": "Engineering"})
```

The MCP connection runs inside the kernel via the official `mcp` Python SDK. The
host's jobs are the service catalog, interactive login (browser OAuth), credential
storage and refresh, and connection verification.

## Table of Contents

- [Connecting a service](#connecting-a-service)
- [How a call works](#how-a-call-works)
- [Connection states](#connection-states)
- [The model-facing inventory](#the-model-facing-inventory)
- [Generic MCP servers](#generic-mcp-servers)
- [Migration from the authored wrappers](#migration-from-the-authored-wrappers)
- [Caveats](#caveats)

## Connecting a service

`/plugins` and bare `/mcp` open the same searchable external-service screen:

- Type to search (e.g. "Notion") — one canonical card per service, no duplicates.
- Each card shows its honest state: **Connect**, **Connected**, **Reconnect**,
  **Verifying**, **Requires setup**, or **Disabled**.
- Press Enter on a **Connect** card to review and complete browser OAuth. The
  credentials are stored locally in `~/.prime/agent/auth.json` under
  `mcp:<service>`; Prime Agent never proxies them.
- After login, Prime Agent verifies the connection with a real MCP handshake
  (initialize + `tools/list`). A stored token alone is never reported as
  Connected: until the handshake succeeds the state stays **Verifying** or
  **Reconnect**. On success the connection activates in the current conversation
  without a restart, and the discovered tool count is shown.
- Enter on a **Connected** card disconnects it (removes the local credentials and
  connection record; revoking the provider grant stays a provider-side action).
- Cards marked **Requires setup** explain what is missing (developer app, API
  key, tenant URL, stdio adapter). They never show a fake Connect button.

`/mcp login <name>` and `/mcp logout <name>` work from the command line for the
same connections. The advanced subcommands (`/mcp add|list|get|remove`) remain
available and unchanged.

Connection records live in `~/.prime/agent/mcp-connections.json`. They keep the
`connectionId` (the dispatch id and credential key), the catalog `serviceId`, the
bound endpoint, and the last verification result. Multiple accounts per service
will use distinct connection ids; grants are never merged because names look
similar.

## How a call works

The tool set is defined by the **server**, not by Prime Agent, so discover before
you call — don't assume tool names or arguments:

```python
# 1. Discover available tools
for tool in await mcp.list_tools("notion"):
    print(tool["name"], "-", tool["description"])

# 2. Call with a JSON-Schema-shaped dict
result = await mcp.call_tool("notion", "notion-search", {"query": "meeting notes"})
```

- Every call is `async` — always `await`.
- Results are already-parsed Python: a `dict` for structured output, a string for
  text, or a list of content blocks otherwise.
- Missing credentials surface as an explicit error telling the user to run
  `/plugins`; a tool that returns an error raises `McpToolError`.
- Configuration is re-read per call; `await mcp.reload()` closes all current
  connections immediately.

## Connection states

- **Connected** — a real MCP handshake succeeded against the bound endpoint
  with the stored credentials. Token presence alone never yields this state.
- **Verifying / pending** — credentials exist but the handshake has not
  succeeded (yet), e.g. right after login or while the endpoint is unreachable.
  The connection is usable; dispatch performs the live handshake.
- **Reconnect / error** — the credential was rejected (expired with no refresh
  token, or bound to a different endpoint). Reconnecting from `/plugins` fixes
  it; existing grants are not deleted by a failed verification.
- **Requires setup** — the service needs manual setup (developer app, API key,
  tenant URL, or a stdio adapter). The card states what is needed.
- **Disabled** — the server entry is disabled in settings.

Account/workspace identity is shown only when the provider exposes it; MCP has
no universal identity capability, so unknown is reported honestly.

## The model-facing inventory

The kernel can ask the host for both supported-but-unconnected services and the
user's actual connections (via `mcp.list_plugins`, `mcp.search_plugins`, and
`mcp.list_connections`). The full catalog is never injected into the prompt; the
model queries it on demand and searches it server-side. A recommendation to
connect a service never installs it or opens a browser by itself: connecting is
an explicit user action in `/plugins`.

## Generic MCP servers

Manage generic servers from either the shell (which exits without starting an
agent) or the TUI. Both surfaces update only `~/.prime/agent/settings.json`:

```bash
prime-agent mcp add remote --url https://mcp.example.com/mcp --bearer-token-env-var EXAMPLE_TOKEN
prime-agent mcp add local --cwd /absolute/path --env TOKEN=EXAMPLE_TOKEN -- node server.js --stdio
prime-agent mcp list
prime-agent mcp get remote
prime-agent mcp remove remote
```

Use the same forms after `/mcp` in the TUI. Add `--oauth` for the existing OAuth
login flow and then use `/mcp login <name>`; use `--force` to replace a complete
existing entry. Static secret values are not accepted: bearer and stdio secrets
are environment-variable references. Project `.prime/agent/settings.json` MCP
entries are ignored for execution, so a repository cannot start a local process
or shadow a user server.

Bundled integration names (`linear`, `notion`) are reserved: `mcp add` rejects
them, and a hand-edited `mcpServers` entry with such a name is ignored instead of
reconfiguring the built-in service. For service ids added later by the service
catalog, a user-declared server with the same name keeps working and owns the id;
connect the official endpoint instead through a differently-named entry.

Advanced runtime options may still be written directly
to the user settings file:

```jsonc
{
  "mcpServers": {
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "bearerTokenEnvVar": "EXAMPLE_TOKEN",
      "enabledTools": ["search"],
      "disabledTools": ["delete"]
    },
    "local": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/server.js", "--stdio"],
      "cwd": "/absolute/path",
      "env": { "TOKEN": { "env": "EXAMPLE_TOKEN" } },
      "startupTimeoutMs": 20000,
      "callTimeoutMs": 60000
    }
  }
}
```

The generic `mcp` module is pre-imported in the Python REPL. Server and tool names are
passed through unchanged:

```python
tools = await mcp.list_tools("remote")
result = await mcp.call_tool("remote", "search", {"query": "example"})
```

HTTP servers may be anonymous, use static `headers`, use a token named by
`bearerTokenEnvVar`, or opt into the existing OAuth login with `oauth: true`.
For stdio, `command` and `args` are executed directly without a shell. `env`
accepts only tagged references to existing environment variables; literal
secrets are not supported. The runtime passes a small ambient environment plus
those references. `enabledTools` is applied first and `disabledTools` second at
both discovery and dispatch. `enabled: false` disables a server.

A connection is initialized and its tools discovered on first use, then reused
by that kernel. Configuration changes replace the connection on the next call;
`await mcp.reload()` closes all current connections immediately. Startup and
calls have separate bounded timeouts, and kernel shutdown closes HTTP sessions
and terminates stdio children.

## Migration from the authored wrappers

Earlier releases shipped authored Linear/Notion Python wrapper packages
(`import linear`, `import notion`) and the `rlm.McpIntegration` authoring API.
These are removed: every service now uses the same generic `mcp` route — no
per-service Python packages, and adding a service is catalog data, not code.
Existing `mcp:linear` / `mcp:notion` credentials keep working unchanged; run
`await mcp.list_tools("linear")` where you previously imported `linear`.

## Caveats

- Discover before assuming tool names or argument schemas.
- Token presence is not connection readiness; the Connected state requires a
  verified handshake.
- Generic MCP connections are kernel-local. Separate Prime Agent sessions use
  separate connections even when they reference the same user setting.
- A custom `PRIME_AGENT_KERNEL_PYTHON` must include the current
  `prime-agent-runtime` dependencies.

See also: [Skills](skills.md), [Settings](settings.md).
