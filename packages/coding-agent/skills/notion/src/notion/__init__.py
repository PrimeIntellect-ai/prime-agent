"""Notion integration: tools auto-discovered from Notion's official MCP server.

Usage in the kernel:

    import notion
    results = await notion.search(query="roadmap")
"""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Notion", "notion"]


class Notion(McpIntegration):
    server = "notion"
    url = "https://mcp.notion.com/mcp"


notion = Notion()

# Don't forward names the kernel bootstrap probes (e.g. `run`) or it wraps the
# module as a callable skill and breaks `await notion.<tool>()` dispatch.
_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name: str):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(notion, name)
