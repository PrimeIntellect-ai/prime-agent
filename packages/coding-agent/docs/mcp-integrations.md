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
host resolves connection settings and, when needed, handles browser OAuth and
credential refresh in `auth.json`.

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
  complete OAuth in the browser. `/mcp login <name>` does the same from the CLI.
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
  the user to `/mcp login`). A server explicitly disabled in settings raises
  `McpDisabled` (tell the user to enable it in settings and run `/reload`); a tool
  that returns an error raises `McpToolError`.

## Authoring your own integration

An integration is a [Python skill package](skills.md#python-backed-skills) whose
module subclasses `McpIntegration`. The built-in `linear` / `notion` packages are
the reference implementations.

### 1. Declare the server

Add it under `mcpServers` in `~/.prime/agent/settings.json` (or project
`.prime/agent/settings.json`):

```jsonc
// ~/.prime/agent/settings.json
{
  "mcpServers": {
    "acme": {
      "type": "http",
      "url": "https://mcp.acme.com/mcp",
      "oauth": true
    }
  }
}
```

Currently only remote `"http"` servers are supported by `McpIntegration`. HTTP
server fields:

| Field | Meaning |
|-------|---------|
| `type` | Must be `"http"` |
| `url` | The MCP endpoint |
| `oauth` | `true` to use the browser OAuth flow (requires the server to support dynamic client registration) |
| `bearerTokenEnvVar` | Name of an env var holding a static bearer token, instead of OAuth |
| `headers` | Extra static HTTP headers sent on every request |
| `enabled` | Set `false` to force-disable even when credentials exist; calls raise `McpDisabled` until it is enabled and `/reload` runs |

Omit both `oauth` and `bearerTokenEnvVar` for a server that accepts
unauthenticated requests.

> `stdio` (local-subprocess) servers are not yet wired through to the kernel —
> the host drops non-HTTP entries — so an integration must target an HTTP endpoint.

### 2. Ship the skill package

Create a skill directory (any [skills location](skills.md#locations), e.g.
`~/.prime/agent/skills/acme/`) with the standard Python-skill layout:

```
acme/
  SKILL.md
  pyproject.toml
  src/acme/__init__.py
```

`pyproject.toml` (depends on `mcp`, `httpx`, and `prime-agent-runtime`):

```toml
[project]
name = "prime-agent-skill-acme"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["mcp", "httpx", "prime-agent-runtime"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/acme"]
```

`src/acme/__init__.py`:

```python
from rlm import McpIntegration

class Acme(McpIntegration):
    server = "acme"                      # matches the mcpServers key / auth.json `mcp:acme`
    url = "https://mcp.acme.com/mcp"

acme = Acme()

# Forward bare module access (`import acme; await acme.<tool>(...)`) to the
# instance, but NOT the names the kernel bootstrap probes — forwarding `run`
# would make it treat the module as a callable skill and break tool dispatch.
_RESERVED = {"run", "__wrapped__", "__call__"}

def __getattr__(name):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(acme, name)
```

The base class connects with the `mcp` SDK, resolves the URL and headers from the
host, injects a bearer token when the server requires one, and binds the server's
tools as async methods. Authoring is a few lines — the package above is the whole
integration.

### Authentication

- **None** (omit `oauth` and `bearerTokenEnvVar`): Prime connects without an
  `Authorization` header. Static `headers` are still included when configured.
- **OAuth** (`"oauth": true`): the user runs `/login` → MCP Connections → your server (or
  `/mcp login acme`). Works when the server supports OAuth 2.1 dynamic client
  registration (RFC 7591); login discovers the auth server, registers a client,
  and runs PKCE. Servers requiring a pre-registered client id are not yet
  supported via `mcpServers`.
- **Static bearer token** (`"bearerTokenEnvVar": "ACME_TOKEN"`): no login needed;
  the integration is "connected" whenever that env var is set. Set the matching
  `bearer_token_env = "ACME_TOKEN"` on the subclass.

## The `McpIntegration` API

Imported from `rlm` (`from rlm import McpIntegration`).

Class attributes to set on your subclass:

- `server: str` — required; the `mcpServers` key and `auth.json` credential id.
- `url: str | None` — the remote endpoint (required unless you override
  `_open_session` for a non-HTTP transport).
- `bearer_token_env: str | None` — optional env var holding a static bearer token.

Methods:

- `await list_tools() -> list[dict]` — the server's tools as
  `[{name, description, inputSchema}]`. Also populates the docstrings shown by
  `help(integration.<tool>)`.
- `await call_tool(name, arguments={}) -> Any` — explicit call; the escape hatch
  for non-identifier tool names.
- `integration.<tool>(**kwargs)` — auto-bound async method for any discovered tool.

Exceptions (both importable from `rlm`):

- `NotEnabled` — raised when an authenticated server has no usable credentials.
- `McpDisabled` — raised when the host configuration explicitly sets `enabled: false`;
  enable it in settings and run `/reload` rather than logging in.
- `McpToolError` — raised when a tool call returns a result flagged as an error.

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

**User-authored integrations are not auth-gated this way.** A skill you drop into
a skills directory is loaded like any other skill — visible to the model and
imported into the kernel immediately. Anonymous servers work immediately;
authenticated servers fail at call time with `NotEnabled` until credentials
exist. Make the skill's `SKILL.md` explain the configured auth mode:

- **OAuth** (`"oauth": true`): instruct the user to run `/mcp login <server>` (or
  `/login` → MCP Connections). `/mcp login` only works for OAuth servers.
- **Bearer token** (`bearerTokenEnvVar`): instruct the user to set that env var —
  do *not* point them at `/mcp login`, which has no provider for a bearer-only
  server and reports "Unknown MCP integration".

## Caveats

- **Discover before assuming.** Tool names and argument schemas come from the
  server and can change; call `list_tools()` / `help()` rather than hardcoding.
- **Custom kernel + name collisions.** The kernel import name is the `server`
  value. On a custom `PRIME_AGENT_KERNEL_PYTHON` that already has an unrelated PyPI
  package of the same name (e.g. `notion`), `import <name>` may resolve to that
  package instead. Use the default managed kernel venv to avoid this.
- **Overriding a built-in name.** Declaring an `mcpServers` entry whose key matches
  a built-in (e.g. `linear`) with a custom `url` points the integration at your
  URL. A previously stored official credential is *not* reused for the override, to
  avoid sending the official token to your endpoint. Authenticate such an override
  via `bearerTokenEnvVar` only — OAuth credentials are not honored for a
  catalog-name override, or omit authentication for a public endpoint. (Use a
  name that isn't a built-in to get OAuth.)
- **Multi-session daemon.** OAuth provider registration is process-global; a
  user-declared server unique to one daemon session is re-registered on that
  session's next reload.

See also: [Skills](skills.md), [Settings](settings.md).
