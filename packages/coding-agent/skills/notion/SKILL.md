---
name: notion
description: Search Notion and read/create/update pages and databases via Notion's official hosted MCP server. Tools are auto-discovered from the server at runtime.
---

# Notion

Talk to Notion through its official hosted MCP server from the Python kernel.

## Setup

Connect via `/login` → **Services** tab → **Notion** (OAuth in the browser).
`/mcp login notion` does the same. Once connected, this skill is enabled
automatically. If a call raises `NotEnabled`, the user isn't logged in — walk
them through `/login`; don't ask them to set environment variables.

## Usage

The tool set is defined by the server, not by this skill, so **discover before
you call** — don't assume tool names or argument names:

Notion's tools are named with hyphens (e.g. `notion-search`, `notion-fetch`),
which are **not** valid Python identifiers — so call them via `call_tool`:

```python
import notion

# 1. Discover available tools (returns names + schemas)
for tool in await notion.list_tools():
    print(tool["name"], "-", tool["description"])

# 2. Call by exact name; the second arg matches the tool's input schema
result = await notion.call_tool("notion-search", {"query": "roadmap"})
print(result)
```

Tools whose names *are* valid identifiers can also be called as
`await notion.<tool>(**args)`, and `help(notion.<tool>)` shows their schema once
`list_tools()` has run.

Notes:
- Every call is `async` — always `await`.
- Results are already-parsed Python (a `dict` for structured output, otherwise a
  string). No need to `json.loads` them.
- Run `list_tools()` before relying on `help()` or assuming a tool exists — the
  server's schema is the source of truth for names and arguments.
- The kernel import name is `notion`. On a custom `PRIME_AGENT_KERNEL_PYTHON` that
  already has the unrelated PyPI `notion` client installed, `import notion` may
  resolve to that instead; use the default managed kernel venv to avoid the clash.
