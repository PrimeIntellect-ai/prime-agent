---
name: mcp
description: Use external MCP services generically from Python - search the supported-service catalog, inspect the user's connections, discover live tool schemas, and call tools on any connection (Notion, Linear, Slack, and the rest of the catalog) without per-service packages.
---

# MCP Services

Every external service reachable over MCP uses the same pre-imported `mcp`
module. Adding a service is data (a catalog entry plus a user login), never a
new Python package, and there are no per-service skills to read.

## Inventory: what can I use?

```python
# Supported catalog, one bounded page. More pages exist while nextCursor is not None.
page = await mcp.list_plugins(connection_status="not_connected", limit=50)
results = await mcp.search_plugins("notion")          # bounded search
page = await mcp.list_plugins()                       # default: first 50 entries

# The user's actual connections. connectionId is the dispatch id everywhere below.
connections = await mcp.list_connections()
```

Catalog entries carry `connectionStatus` (`connected`, `pending`,
`not_connected`, `setup_required`, `disabled`, `error`), `connectable`, and
when connected the `connectionIds` you dispatch on. `connected` means a
verified MCP handshake, not just stored credentials; `pending` means
credentials exist but verification hasn't run or succeeded yet. Entries may
also carry `setupHint` (why a service isn't connectable yet), `unverified`
(imported but not vetted), `verifiedAt`/`toolCount`, and `connectionIds`
(empty when not dispatchable). Entries with `setup_required` need a developer
app or API key first — say so honestly instead of promising one-click.

## Recommend, never connect

If a task would benefit from an unconnected service, name the real catalog
entry (e.g. "Connecting Notion would let me search your workspace directly")
and tell the user to open `/plugins` (or run `/mcp login <service>`) to connect.
Recommendations and catalog lookups never install anything, open a browser,
use credentials, or request extra scopes. There is no agent-initiated connect
call in this slice; if the user connects mid-task, the connection activates on
the next call without a reload.

## Discover, then call

```python
# Live tool metadata is cached per connection; schemas come from the server.
tools = await mcp.search_tools("search workspace documents", connection_id="notion")
tool = await mcp.describe_tool("notion", "notion-search")   # {name, description, inputSchema}
tools = await mcp.list_tools("notion")                     # full tool list with schemas

result = await mcp.call_tool("notion", "notion-search", {"query": "roadmap"})
```

- Discover before calling: don't assume tool names or arguments; read the
  `inputSchema` with `describe_tool` and construct matching arguments.
- `list_tools` returns the complete inventory or raises — never a silent
  partial list. Returned schemas are isolated copies; mutate them freely.
- `search_tools` without a `connection_id` searches at most 8 connections the
  host reports as connected and reports its scope: `searched`, `unavailable`
  (per-connection failures as fixed, redaction-safe summaries), and
  `truncated` (narrow the query or pick a connection when it is set — the
  result never claims to be exhaustive).
- Prefer narrow catalog searches over paging the whole catalog; don't dump all
  schemas into context.
- Results are already-parsed Python (a `dict` for structured output, otherwise
  a string). No `json.loads` needed.

## Errors and permissions

- `PermissionError` — the tool is excluded by the user's `enabledTools` /
  `disabledTools` policy. Don't retry; tell the user.
- `KeyError` — the tool or connection doesn't exist. Re-check with
  `list_tools` / `list_connections`; tools can change across sessions.
- `McpDiscoveryError` — the server's tool listing couldn't complete honestly
  (broken pagination). No partial inventory is published; re-run, and ask the
  user to reconnect if it persists.
- `RuntimeError` — credentials are not available (`McpCredentialsUnavailable`:
  ask the user to connect via `/plugins` or `/mcp login <service>`, never via
  environment variables), a refresh failed, or the host bridge is unavailable.
- `McpToolError` — the server flagged the call as an error. Surface the
  message; don't blindly retry a write that may have already happened.

Credentials never appear in inventory results, tool schemas, or errors.
