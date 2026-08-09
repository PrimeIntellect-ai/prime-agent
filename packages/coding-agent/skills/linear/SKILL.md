---
name: linear
description: Read and modify Linear issues, projects, cycles, comments, and related data through Linear's official hosted MCP server. Use for Linear work after discovering the server's current tool names and input schemas.
---

# Linear

Use Linear through its official hosted Model Context Protocol server from the
IPython kernel. The server defines the available tools and their JSON Schema
inputs at runtime.

## Setup

Run `/login`, open the **Services** tab, and select **Linear** to authorize with
OAuth in the browser. `/mcp login linear` performs the same connection flow.
Once connected, the skill is enabled automatically. When a call raises
`NotEnabled`, explain how to complete `/login`. Do not ask the user to set an
environment variable for this connection.

## Usage

Discover the server's current tools before relying on a tool name or argument:

```python
import linear

tools = await linear.list_tools()
for tool in tools:
    print(tool["name"], "-", tool["description"])

# After selecting a tool and reading its discovered schema:
result = await linear.call_tool("<tool-name-from-list>", {"<documented-arg>": "value"})
print(result)
```

- Every discovered tool is asynchronous and must be awaited.
- Structured results arrive as parsed Python values, usually a `dict`.
  Unstructured results arrive as strings. Do not call `json.loads` on a parsed
  result.
- When a server tool name is not a valid Python identifier, call it through
  `await linear.call_tool("tool-name", {"arg": "value"})`.
- `list_tools()` populates the schemas used by `help()`. Run it before assuming a
  tool exists or that a remembered input shape is still current. The connected
  server is authoritative for tool names and arguments.
