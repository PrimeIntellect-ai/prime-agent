"""Base class for MCP-client integrations exposed in the RLM kernel.

An integration is a Python skill package that subclasses :class:`McpIntegration`,
declares the MCP ``server`` it targets, and is imported in the kernel like any
other skill. Tools are auto-discovered from the server and bound as async
methods, so the agent writes ordinary Python:

    import linear
    issues = await linear.list_issues(team="Engineering")

Credentials live in the host's ``auth.json`` (single store, survives kernel
rebuilds). This module reads that file directly for the common case; on token
expiry it asks the host to refresh via ``rlm.host_request("mcp.refresh", ...)``
and re-reads. Interactive login runs host-side, never here.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from . import host_request

__all__ = ["McpIntegration", "McpToolError", "NotEnabled"]

# Stored access tokens are treated as expired this many seconds early so a token
# never dies mid-request. Mirrors the host's refresh buffer.
_EXPIRY_SKEW_SECONDS = 30


class NotEnabled(RuntimeError):
    """Raised when an integration has no usable credentials.

    The integration is installed but not logged in. The message tells the agent
    how to enable it so it can relay that to the user rather than retrying.
    """

    def __init__(self, server: str):
        self.server = server
        super().__init__(
            f"The '{server}' integration is not enabled: no credentials found. "
            f"Tell the user to run `/mcp login {server}` in Prime Agent to connect it. "
            f"Do not ask them to set environment variables."
        )


class McpToolError(RuntimeError):
    """Raised when an MCP tool call returns a result flagged as an error."""


def _agent_dir() -> Path:
    """Resolve the Prime Agent config dir the same way the rest of the runtime does."""
    raw = (
        os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        or os.environ.get("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    # resolve() so a relative env override reads auth.json from the right place,
    # not relative to the kernel's cwd.
    return Path(raw).expanduser().resolve()


def _read_auth(provider: str) -> dict[str, Any] | None:
    """Read one credential entry from auth.json. Returns None if absent/unreadable."""
    try:
        data = json.loads((_agent_dir() / "auth.json").read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    cred = data.get(provider)
    return cred if isinstance(cred, dict) else None


def _resolve_config_value(value: str) -> str:
    """Resolve a stored api_key value the way the host does.

    A value may be a literal, an env-var name, or a `!command` indirection. The
    command form can't run safely in the kernel (the host injects those resolved),
    so skip it; otherwise treat the value as an env-var name if set, else literal.
    """
    value = value.strip()
    if not value or value.startswith("!"):
        return ""
    return (os.environ.get(value) or value).strip()


def _resolve_streamable_http():
    """Return an SDK streamable-HTTP transport callable.

    SDK versions vary: some expose ``streamablehttp_client(url, headers=...)``,
    others ``streamable_http_client(url, *, http_client=...)``, and some expose
    both with *different* signatures. Imported lazily so importing an integration
    package never hard-fails when ``mcp`` is absent.
    """
    from mcp.client import streamable_http as mod  # noqa: PLC0415

    for name in ("streamablehttp_client", "streamable_http_client"):
        fn = getattr(mod, name, None)
        if fn is not None:
            return fn
    raise ImportError(
        "the installed `mcp` SDK exposes no streamable-HTTP client; upgrade `mcp`"
    )


class McpIntegration:
    """Subclass and set :attr:`server` (and :attr:`url` for remote servers).

    Tools are discovered on first use and bound as async methods via
    ``__getattr__``; ``await self.call_tool(name, args)`` is the explicit escape
    hatch and the hook for hand-written typed wrappers.
    """

    #: Credential / config key for this integration (matches the auth.json entry
    #: ``mcp:<server>`` and the mcpServers settings key).
    server: str = ""

    #: Remote MCP endpoint. Required unless a subclass overrides ``_open_streams``.
    url: str | None = None

    #: Optional env var holding a static bearer token (used instead of auth.json OAuth).
    bearer_token_env: str | None = None

    def __init__(self) -> None:
        if not self.server:
            raise ValueError(f"{type(self).__name__} must set a non-empty `server`")
        self._tools: dict[str, Any] | None = None
        self._lock = asyncio.Lock()

    # -- credentials --------------------------------------------------------

    @property
    def _provider_id(self) -> str:
        return f"mcp:{self.server}"

    def _token(self) -> str | None:
        """Current usable bearer token, or None if missing/expired (needs refresh).

        A static bearer-token env var wins (matches the host's `isAuthed` check);
        otherwise read auth.json. OAuth tokens are only returned while still fresh.
        """
        if self.bearer_token_env:
            env_token = os.environ.get(self.bearer_token_env, "").strip()
            if env_token:
                return env_token
        cred = _read_auth(self._provider_id)
        if cred is None:
            return None
        if cred.get("type") == "api_key":
            return _resolve_config_value(str(cred.get("key") or "")) or None
        # OAuth credential: {access, refresh, expires(ms)}.
        access = str(cred.get("access") or "")
        expires = cred.get("expires")
        fresh = isinstance(expires, (int, float)) and (
            time.time() * 1000 < expires - _EXPIRY_SKEW_SECONDS * 1000
        )
        if access and fresh:
            return access
        return None  # signal: needs refresh

    async def _resolve_token(self) -> str:
        token = self._token()
        if token:
            return token
        # Expired or missing-access: ask the host to refresh, then re-validate via
        # _token() (which re-checks expiry) rather than trusting any access value.
        if _read_auth(self._provider_id) is not None:
            refresh_error: Exception | None = None
            try:
                await host_request("mcp.refresh", {"server": self.server})
            except RuntimeError as exc:
                refresh_error = exc
            token = self._token()
            if token:
                return token
            # A refresh that failed (vs. genuinely-absent creds) is a recoverable
            # error; don't mislabel it as "not enabled / re-login".
            if refresh_error is not None:
                raise RuntimeError(
                    f"Failed to refresh credentials for '{self.server}': {refresh_error}"
                ) from refresh_error
        raise NotEnabled(self.server)

    # -- connection ---------------------------------------------------------

    async def _resolve_config(self) -> tuple[str | None, dict[str, str]]:
        """The integration's own (url, extra_headers). Never consults user
        ``mcpServers`` entries: a same-named entry must not repoint an authored
        integration, whose credentials (stored or env-sourced) would follow.
        """
        return self.url, {}

    async def _open_session(self, stack: AsyncExitStack):
        """Open an initialized MCP ClientSession bound to ``stack``.

        Override for non-HTTP transports (e.g. stdio). The default connects over
        streamable HTTP to the class ``url`` with a Bearer token from auth.json.
        """
        import inspect  # noqa: PLC0415

        from mcp import ClientSession  # noqa: PLC0415

        url, extra_headers = await self._resolve_config()
        if not url:
            raise ValueError(
                f"{type(self).__name__} must set `url` or override `_open_session`"
            )
        token = await self._resolve_token()
        transport = _resolve_streamable_http()
        # Extra configured headers first, Authorization last so it always wins.
        auth_header = {**extra_headers, "Authorization": f"Bearer {token}"}

        # SDK signatures vary: some take headers=, others only http_client=.
        params = inspect.signature(transport).parameters
        if "headers" in params:
            cm = transport(url, headers=auth_header)
        elif "http_client" in params:
            # This SDK shape requires its companion httpx2 client (the transport calls client.sse()).
            import httpx2  # noqa: PLC0415

            # SDK-factory timeouts; a default client's 5s read cap drops idle SSE streams.
            # No redirects: a redirecting endpoint must not receive the bearer header.
            client = await stack.enter_async_context(
                httpx2.AsyncClient(
                    headers=auth_header,
                    timeout=httpx2.Timeout(30.0, read=300.0),
                    follow_redirects=False,
                )
            )
            cm = transport(url, http_client=client)
        else:
            raise RuntimeError(
                f"unsupported mcp streamable-HTTP client signature: {tuple(params)}"
            )

        read, write, *_ = await stack.enter_async_context(cm)
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        return session

    # -- tools --------------------------------------------------------------

    async def list_tools(self) -> list[dict[str, Any]]:
        """Return the server's tools as ``[{name, description, inputSchema}]``."""
        await self._ensure_tools()
        return [dict(t) for t in (self._tools or {}).values()]

    async def _ensure_tools(self) -> None:
        if self._tools is not None:
            return
        async with self._lock:
            if self._tools is not None:
                return
            async with AsyncExitStack() as stack:
                session = await self._open_session(stack)
                resp = await session.list_tools()
                self._tools = {
                    t.name: {
                        "name": t.name,
                        "description": getattr(t, "description", "") or "",
                        "inputSchema": getattr(t, "inputSchema", None) or {},
                    }
                    for t in resp.tools
                }

    async def call_tool(self, tool: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call ``tool`` on the server and return its parsed result.

        Opens a fresh session per call: MCP sessions are not safe to hold across
        the kernel's snapshot/restore, and per-call connect keeps this robust to
        idle sessions and token rotation at modest latency cost.
        """
        async with AsyncExitStack() as stack:
            session = await self._open_session(stack)
            result = await session.call_tool(tool, arguments or {})
        return _parse_result(result)

    def __getattr__(self, name: str):
        # Only reached for names not found normally; bind as an async tool call.
        if name.startswith("_"):
            raise AttributeError(name)

        async def _call(**kwargs: Any) -> Any:
            await self._ensure_tools()
            if self._tools is not None and name not in self._tools:
                available = ", ".join(sorted(self._tools)) or "(none)"
                raise AttributeError(
                    f"'{self.server}' has no tool '{name}'. Available: {available}"
                )
            return await self.call_tool(name, kwargs)

        _call.__name__ = name
        _call.__qualname__ = f"{type(self).__name__}.{name}"
        if self._tools and name in self._tools:
            schema = self._tools[name].get("inputSchema") or {}
            desc = self._tools[name].get("description") or ""
            _call.__doc__ = f"{desc}\n\nArguments (JSON Schema):\n{json.dumps(schema, indent=2)}"
        return _call


def _parse_result(result: Any) -> Any:
    """Normalize a CallToolResult into plain Python (structured output preferred).

    Raises McpToolError when the server flags the result as an error, so a failed
    tool call doesn't look like a successful one to the caller.
    """
    texts: list[str] = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text is not None:
            texts.append(text)
    is_error = getattr(result, "is_error", getattr(result, "isError", False))
    if is_error:
        raise McpToolError("\n".join(texts) or "MCP tool returned an error")

    structured = getattr(result, "structured_content", getattr(result, "structuredContent", None))
    if structured is not None:  # falsy-but-valid payloads ({} / []) are real results
        return structured
    if texts:
        return "\n".join(texts)

    # Non-text content (images, embedded resources): return them as plain dicts
    # rather than the opaque SDK object so callers get usable data.
    blocks = getattr(result, "content", None) or []
    if blocks:
        return [b.model_dump(mode="json") if hasattr(b, "model_dump") else b for b in blocks]
    return result
