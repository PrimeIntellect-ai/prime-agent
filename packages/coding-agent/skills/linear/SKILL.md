---
name: linear
description: Read and write Linear issues, projects, cycles, comments, and more via Linear's official MCP server. Tools are auto-discovered from the server at runtime.
---

# Linear

Talk to Linear through its official hosted MCP server from the Python kernel.

## Setup

Connect via `/login` → **Services** tab → **Linear** (OAuth in the browser).
`/mcp login linear` does the same. Once connected, this skill is enabled
automatically. If a call raises `NotEnabled`, the user isn't logged in — walk
them through `/login`; don't ask them to set environment variables.

## Usage

The tool set is defined by the server, not by this skill, so **discover before
you call** — don't assume tool names or argument names:

```python
import linear

# 1. Discover available tools
for tool in await linear.list_tools():
    print(tool["name"], "-", tool["description"])

# 2. Inspect a specific tool's arguments (rendered from its JSON Schema)
help(linear.list_issues)

# 3. Call it; keyword args must match the tool's input schema
result = await linear.list_issues(team="Engineering")
print(result)
```

Notes:
- Every tool is an `async` method — always `await`.
- Results are already-parsed Python (a `dict` for structured output, otherwise a
  string). No need to `json.loads` them.
- For tools whose names aren't valid Python identifiers, use the escape hatch:
  `await linear.call_tool("tool-name", {"arg": "value"})`.
- Run `list_tools()` before relying on `help()` or assuming a tool exists — it
  populates the schemas `help()` shows, and the server is the source of truth
  for tool names and arguments.
