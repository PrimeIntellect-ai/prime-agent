"""Linear integration: tools auto-discovered from Linear's official MCP server.

Usage in the kernel:

    import linear
    issues = await linear.list_issues(team="Engineering")
"""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Linear", "linear"]


class Linear(McpIntegration):
    server = "linear"
    url = "https://mcp.linear.app/mcp"


linear = Linear()


# Names the kernel bootstrap probes to decide if a module is a callable skill.
# Don't forward them, or `getattr(module, "run")` returns an MCP tool stub and the
# module gets wrapped as callable, breaking `await linear.<tool>()` dispatch.
_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name: str):
    # Forward bare module-level access (e.g. linear.list_issues) to the instance,
    # so `import linear; await linear.list_issues(...)` works without `.linear`.
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(linear, name)
