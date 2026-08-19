# MCP Integrations

Connect external services (Linear, Notion, …) to Prime Agent over the
[Model Context Protocol](https://modelcontextprotocol.io).

Consistent with Prime Agent's single-tool design, MCP integrations are **not**
exposed as new agent tools. Each integration is a [Python-backed skill](skills.md)
that the model imports and calls from the IPython kernel:

```python
import linear
issues = await linear.list_issues(team="Engineering")
```

The MCP connection runs inside the kernel via the official `mcp` Python SDK. The
host's only jobs are interactive login (browser OAuth) and minting/refreshing
credentials in `auth.json`.

## Table of Contents

- [Using a built-in integration](#using-a-built-in-integration)
- [How a call works](#how-a-call-works)
- [Authoring your own integration](#authoring-your-own-integration)
  - [1. Declare the server](#1-declare-the-server)
  - [2. Ship the skill package](#2-ship-the-skill-package)
  - [Authentication](#authentication)
- [The `McpIntegration` API](#the-mcpintegration-api)
- [Enable-by-login lifecycle](#enable-by-login-lifecycle)
- [Caveats](#caveats)

## Using a built-in integration

Built-in integrations (Linear, Notion) ship **disabled**. Logging in enables them:

- Open `/login`, switch to **MCP Connections**, pick the integration, and
  complete OAuth in the browser. `/mcp login <name>` does the same from the TUI command line.
- Once connected, the integration's skill becomes visible to the model and is
  auto-imported into the kernel.
- `/mcp` lists integrations and connection status; `/mcp logout <name>`
  disconnects.

Credentials are stored once in `~/.prime/agent/auth.json` under `mcp:<name>`.
Enablement is derived from whether valid credentials exist — there is no separate
on/off switch.

## How a call works

The tool set is defined by the **server**, not the skill, so discover before you
call — don't assume tool names or arguments:

```python
import linear

# 1. Discover available tools
for tool in await linear.list_tools():
    print(tool["name"], "-", tool["description"])

# 2. Inspect a tool's argument schema
help(linear.list_issues)        # populated once list_tools() has run

# 3. Call it; keyword args match the tool's JSON Schema
result = await linear.list_issues(team="Engineering")
```

- Every tool is an `async` method — always `await`.
- Results are already-parsed Python: a `dict` for structured output, a string for
  text, or a list of content blocks otherwise. No need to `json.loads` them.
- A tool whose name isn't a valid Python identifier (e.g. Notion's `notion-search`)
  is called via the escape hatch: `await notion.call_tool("notion-search", {...})`.
- A call against an integration with no credentials raises `NotEnabled` (telling
  the user to `/mcp login`); a tool that returns an error raises `McpToolError`.

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

Built-in integration names (`linear`, `notion`, ...) are reserved: `mcp add`
rejects them, and a hand-edited `mcpServers` entry with such a name disables the
built-in skill instead of reconfiguring it. Earlier releases documented a
catalog-name override (custom `url` plus `bearerTokenEnvVar` under a built-in
name); that override no longer works — rename the entry (for example
`linear-proxy`) to reach a custom endpoint through the generic runtime.

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

The generic `mcp` module is pre-imported in IPython. Server and tool names are
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

Authored Linear and Notion skills remain available as optional typed wrappers.
They use the same existing login and credential behavior.

## Authored wrapper API

Built-in wrappers subclass `rlm.McpIntegration` and expose `list_tools()`,
`call_tool(name, arguments)`, and Python methods for identifier-safe tool names.
They raise `NotEnabled` when credentials are unavailable and `McpToolError` when
a service returns a tool error. Generic servers do not need a wrapper and should
use the pre-imported `mcp` API above.

## Enable-by-login lifecycle

This auth-gating applies to the **built-in** integrations (Linear, Notion):

1. The built-in skill ships installed but **disabled** — excluded from the prompt
   and not imported into the kernel — because no credentials exist.
2. The user logs in; credentials land in `auth.json` under `mcp:<server>`.
3. A resource reload (automatic after `/login`/`/mcp login`, or `/reload`) detects
   the credentials, enables the skill, and the kernel installs + imports the
   package.
4. Logout (or losing credentials) disables it again.

If you log in mid-turn, the reload is deferred — run `/reload` after the turn to
activate the integration.

## Caveats

- Discover before assuming tool names or argument schemas.
- Generic MCP connections are kernel-local. Separate Prime Agent sessions use
  separate connections even when they reference the same user setting.
- A custom `PRIME_AGENT_KERNEL_PYTHON` must include the current
  `prime-agent-runtime` dependencies.

See also: [Skills](skills.md), [Settings](settings.md).
