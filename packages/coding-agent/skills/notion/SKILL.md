---
name: notion
description: Search Notion and read, create, or update pages and databases through Notion's official hosted MCP server. Use for Notion work after discovering the server's current tool names and input schemas.
---

# Notion

Use Notion through its official hosted Model Context Protocol server from the
IPython kernel. The server defines the available tools and their JSON Schema
inputs at runtime.

## Setup

Run `/login`, open the **Services** tab, and select **Notion** to authorize with
OAuth in the browser. `/mcp login notion` performs the same connection flow.
Once connected, the skill is enabled automatically. When a call raises
`NotEnabled`, explain how to complete `/login`. Do not ask the user to set an
environment variable for this connection.

## Usage

Discover the server's current tools before relying on a tool name or argument.
Notion tool names commonly contain hyphens, such as `notion-search` and
`notion-fetch`, so call them through `call_tool`:

```python
import notion

for tool in await notion.list_tools():
    print(tool["name"], "-", tool["description"])

result = await notion.call_tool("notion-search", {"query": "roadmap"})
print(result)
```

A tool whose exact name is a valid Python identifier can also be called as
`await notion.<tool>(**args)`. After `list_tools()` has populated the schemas,
`help(notion.<tool>)` shows that tool's input contract.

- Every tool call is asynchronous and must be awaited.
- Structured results arrive as parsed Python values, usually a `dict`.
  Unstructured results arrive as strings. Do not call `json.loads` on a parsed
  result.
- The connected server is authoritative for current tool names and arguments.
- The kernel import name is `notion`. In a custom `PRIME_AGENT_KERNEL_PYTHON`
  environment that already contains the unrelated PyPI `notion` client,
  `import notion` may resolve to that package. Use the default managed kernel
  environment to avoid the import collision.
