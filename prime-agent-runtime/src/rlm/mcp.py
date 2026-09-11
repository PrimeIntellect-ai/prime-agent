"""Kernel-owned generic MCP client registry.

Two surfaces, one module:

- Dispatch: ``list_tools(connection)`` / ``call_tool(connection, tool, arguments)``
  open a configured MCP server (host-resolved via ``mcp.config``), discover its
  tools, and call them. Adding a service is data, not a new Python module.
- Discovery: ``list_plugins`` / ``search_plugins`` (host-owned catalog),
  ``list_connections`` (the user's actual connections), ``search_tools`` /
  ``describe_tool`` (live tool metadata). Inventory calls are bounded and never
  return credentials; live tool schemas and results are passed through
  unmodified.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import io
import json
import os
import re
import threading
import time
from contextlib import AsyncExitStack
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, TypeVar

from . import host_request

__all__ = [
    "McpCredentialsUnavailable",
    "McpDiscoveryError",
    "McpStartupError",
    "McpToolError",
    "call_tool",
    "close",
    "describe_tool",
    "list_connections",
    "list_plugins",
    "list_tools",
    "reload",
    "search_plugins",
    "search_tools",
]

_DEFAULT_STARTUP_TIMEOUT = 20.0
_DEFAULT_CALL_TIMEOUT = 60.0
# Must stay strictly below the host's KERNEL_SHUTDOWN_TIMEOUT_MS (5s) kill deadline.
_SHUTDOWN_TIMEOUT = 2.5
_T = TypeVar("_T")
_STDERR_BYTE_LIMIT = 8 * 1024
_STDERR_LINE_LIMIT = 40
_SAFE_ENV = ("HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR")
_ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)")
_CONTROL_CHAR = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
# Host-backed inventory requests are interactive-sized, not tool-call-sized.
_INVENTORY_TIMEOUT = 15.0
_DEFAULT_PLUGIN_LIMIT = 50
_MAX_PLUGIN_LIMIT = 200
_DEFAULT_PLUGIN_SEARCH_LIMIT = 10
_MAX_PLUGIN_SEARCH_LIMIT = 50
_MAX_CURSOR_CHARS = 512
_PLUGIN_CONNECTION_STATUSES = ("connected", "not_connected")
# tools/list pagination: a server that paginates must not wedge discovery.
_MAX_TOOL_PAGES = 25
_DEFAULT_TOOL_SEARCH_LIMIT = 20
_MAX_TOOL_SEARCH_LIMIT = 50
_MAX_TOOL_SEARCH_SERVERS = 8
# Defensive only: the host must already whitelist safe metadata in inventory
# entries. Never applied to live tool schemas or results — argument names there
# are server-defined and legitimately credential-like.
_SECRET_KEY_PATTERN = re.compile(r"token|secret|password|credential|authorization|api[_-]?key|private[_-]?key", re.I)


class McpStartupError(RuntimeError):
    """A stdio server failed while completing the MCP startup handshake."""


class McpToolError(RuntimeError):
    """Raised when an MCP tool call returns a result flagged as an error."""


class McpDiscoveryError(RuntimeError):
    """Raised when a server's tools/list pagination cannot complete honestly.

    A repeated or malformed pagination cursor, or more pages than allowed,
    means the inventory cannot be trusted — a partial tool map is never
    published as if complete."""


class McpCredentialsUnavailable(RuntimeError):
    """Raised when a configured connection has no usable credentials.

    The user must connect the service first (`/plugins` or
    `/mcp login <service>`)."""


class _StderrTail(io.TextIOBase):
    """A pipe-backed, bounded stderr tail that is safe for subprocess writers."""

    def __init__(self) -> None:
        self._read_fd, self._write_fd = os.pipe()
        self._buffer = bytearray()
        self._lock = threading.Lock()
        self._capture = True
        self._pipe_closed = False
        self._reader = threading.Thread(target=self._drain, name="mcp-stderr-drain", daemon=True)
        self._reader.start()

    def fileno(self) -> int:
        return self._write_fd

    def writable(self) -> bool:
        return True

    def write(self, value: str) -> int:
        data = value.encode("utf-8", errors="replace")
        os.write(self._write_fd, data)
        return len(value)

    def flush(self) -> None:
        return None

    def _drain(self) -> None:
        try:
            while chunk := os.read(self._read_fd, 4096):
                with self._lock:
                    if not self._capture:
                        continue
                    self._buffer.extend(chunk)
                    if len(self._buffer) > _STDERR_BYTE_LIMIT:
                        del self._buffer[: len(self._buffer) - _STDERR_BYTE_LIMIT]
                    lines = self._buffer.splitlines(keepends=True)
                    if len(lines) > _STDERR_LINE_LIMIT:
                        self._buffer[:] = b"".join(lines[-_STDERR_LINE_LIMIT:])
        finally:
            os.close(self._read_fd)

    def stop_capture(self) -> None:
        with self._lock:
            self._capture = False
            self._buffer.clear()

    def tail(self, secrets: tuple[str, ...], private_values: tuple[str, ...] = ()) -> str:
        with self._lock:
            raw = bytes(self._buffer)
        return _sanitize_diagnostic(raw.decode("utf-8", errors="replace"), secrets, private_values)

    def close(self) -> None:
        if self._pipe_closed:
            return
        self._pipe_closed = True
        os.close(self._write_fd)
        self._reader.join(timeout=1)
        super().close()


class _Generation:
    def __init__(self, server: str, config: dict[str, Any]):
        self.server = server
        self.config = config
        self.stack = AsyncExitStack()
        self.session: Any = None
        self.tools: dict[str, dict[str, Any]] = {}
        self.closed = False
        self._call_lock = asyncio.Lock()
        self._stderr: _StderrTail | None = None
        self._stderr_secrets: tuple[str, ...] = ()
        self._stderr_disclosable = True
        self._diagnostic_private_values: tuple[str, ...] = ()
        self._close_requested = asyncio.Event()
        self._lifecycle: asyncio.Task[None] | None = None

    @property
    def startup_timeout(self) -> float:
        return _seconds(self.config.get("startupTimeoutMs"), _DEFAULT_STARTUP_TIMEOUT)

    @property
    def call_timeout(self) -> float:
        return _seconds(self.config.get("callTimeoutMs"), _DEFAULT_CALL_TIMEOUT)

    async def open(self) -> None:
        if self._lifecycle is not None:
            raise RuntimeError("MCP generation has already started")
        ready = asyncio.get_running_loop().create_future()
        self._lifecycle = asyncio.create_task(self._run_lifecycle(ready))
        try:
            await asyncio.shield(ready)
        except BaseException:
            if ready.done():
                self._close_requested.set()
            else:
                self._lifecycle.cancel()
            try:
                await asyncio.shield(self._lifecycle)
            except BaseException:
                pass
            raise

    async def _run_lifecycle(self, ready: asyncio.Future[None]) -> None:
        startup_failure: Exception | None = None
        try:
            try:
                async with asyncio.timeout(self.startup_timeout):
                    read, write = await self._open_transport()
                    from mcp import ClientSession

                    self.session = await self.stack.enter_async_context(
                        ClientSession(read, write, read_timeout_seconds=self.call_timeout)
                    )
                    try:
                        await self.session.initialize()
                        await self.discover()
                    except Exception as exc:
                        if self._stderr is None or _is_exception_group(exc):
                            raise
                        startup_failure = exc
                    if startup_failure is None and self._stderr is not None:
                        self._stderr.stop_capture()
            except BaseException as exc:
                if not ready.done():
                    ready.set_exception(exc)
                return

            if startup_failure is not None:
                if not ready.done():
                    ready.set_exception(self._startup_error(startup_failure))
                return

            ready.set_result(None)
            await self._close_requested.wait()
        finally:
            try:
                try:
                    async with asyncio.timeout(_SHUTDOWN_TIMEOUT):
                        await self.stack.aclose()
                except TimeoutError:
                    pass
            finally:
                if self._stderr is not None:
                    self._stderr.close()
                self.closed = True

    def _startup_error(self, exc: Exception) -> McpStartupError:
        assert self._stderr is not None
        if self._stderr_disclosable:
            original = _sanitize_diagnostic(
                f"{type(exc).__name__}: {exc}",
                self._stderr_secrets,
                self._diagnostic_private_values,
                byte_limit=1024,
            ) or type(exc).__name__
        else:
            original = f"{type(exc).__name__}: details omitted for safe redaction"
        stderr = (
            self._stderr.tail(self._stderr_secrets, self._diagnostic_private_values)
            if self._stderr_disclosable
            else ""
        )
        detail = f" Stderr tail:\n{stderr}" if stderr else ""
        return McpStartupError(f"MCP stdio server failed during startup ({original}).{detail}")

    async def _open_transport(self):
        kind = self.config.get("type")
        if kind == "http":
            return await self._open_http()
        if kind == "stdio":
            return await self._open_stdio()
        raise ValueError(f"MCP server '{self.server}' has unsupported transport {kind!r}")

    async def _open_http(self):
        import inspect

        url = self.config.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError(f"MCP server '{self.server}' requires a URL")
        headers = await _headers(self.server, self.config)
        transport = _resolve_streamable_http()
        # SDK signatures vary: some take headers=, others only http_client=.
        if "headers" in inspect.signature(transport).parameters:
            streams = await self.stack.enter_async_context(transport(url, headers=headers))
        else:
            # This SDK shape requires its companion httpx2 client (the transport calls client.sse()).
            import httpx2

            # SDK-factory timeouts (30s ops / 300s SSE reads); reads must also outlast the session-enforced call timeout.
            # No redirects: a redirecting endpoint must not receive configured secret headers.
            client = await self.stack.enter_async_context(
                httpx2.AsyncClient(
                    headers=headers,
                    timeout=httpx2.Timeout(30.0, read=max(300.0, self.call_timeout + 30.0)),
                    follow_redirects=False,
                )
            )
            streams = await self.stack.enter_async_context(transport(url, http_client=client))
        return streams[0], streams[1]

    async def _open_stdio(self):
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client

        command = self.config.get("command")
        args = self.config.get("args", [])
        cwd = self.config.get("cwd")
        if not isinstance(command, str) or not command or not _strings(args):
            raise ValueError(f"MCP server '{self.server}' requires command and string args")
        if cwd is not None and not isinstance(cwd, str):
            raise ValueError(f"MCP server '{self.server}' cwd must be a string")
        env = _stdio_env(self.config)
        configured_values = _configured_stdio_values(self.config, env)
        self._stderr_disclosable = not any(0 < len(value) < 4 for value in configured_values)
        self._stderr_secrets = tuple(
            sorted({value for value in configured_values if len(value) >= 4}, key=len, reverse=True)
        )
        self._diagnostic_private_values = _private_config_values(self.config) + (os.getcwd(),)
        self._stderr = _StderrTail()
        params = StdioServerParameters(command=command, args=args, cwd=cwd, env=env)
        return await self.stack.enter_async_context(stdio_client(params, errlog=self._stderr))

    async def discover(self) -> None:
        """Fetch the complete tool inventory, following tools/list cursors.

        Raises McpDiscoveryError when pagination cannot complete honestly — a
        repeated or malformed continuation cursor, or more pages than allowed —
        so a partial inventory is never published as if complete.
        """
        tools: dict[str, dict[str, Any]] = {}
        cursors: set[str] = set()
        cursor: str | None = None
        pages = 0
        while True:
            response = await self._list_tools_page(cursor)
            pages += 1
            for tool in getattr(response, "tools", None) or []:
                name = getattr(tool, "name", None)
                if not isinstance(name, str):
                    continue
                schema = getattr(tool, "input_schema", None)
                if schema is None:
                    schema = getattr(tool, "inputSchema", None)
                tools[name] = {
                    "name": name,
                    "description": getattr(tool, "description", "") or "",
                    "inputSchema": schema if isinstance(schema, dict) else {},
                }
            cursor = getattr(response, "next_cursor", None)
            if cursor is None:
                cursor = getattr(response, "nextCursor", None)
            if cursor is None:
                break
            if not isinstance(cursor, str) or not cursor:
                raise McpDiscoveryError(
                    f"MCP server '{self.server}' returned a malformed tools/list pagination cursor"
                )
            if cursor in cursors:
                raise McpDiscoveryError(
                    f"MCP server '{self.server}' repeated a tools/list pagination cursor; "
                    "its tool inventory cannot be completed"
                )
            if pages >= _MAX_TOOL_PAGES:
                raise McpDiscoveryError(
                    f"MCP server '{self.server}' paginated tools/list beyond {_MAX_TOOL_PAGES} pages; "
                    "refusing to publish a partial tool inventory"
                )
            cursors.add(cursor)
        self.tools = tools

    async def _list_tools_page(self, cursor: str | None) -> Any:
        if cursor is None:
            return await self.session.list_tools()
        from mcp.types import PaginatedRequestParams

        return await self.session.list_tools(params=PaginatedRequestParams(cursor=cursor))

    def allows(self, tool: str) -> bool:
        enabled = self.config.get("enabledTools")
        disabled = self.config.get("disabledTools")
        if isinstance(enabled, list) and tool not in enabled:
            return False
        return not (isinstance(disabled, list) and tool in disabled)

    async def call(self, tool: str, arguments: dict[str, Any]) -> Any:
        if not self.allows(tool):
            raise PermissionError(f"MCP tool '{tool}' is disabled for server '{self.server}'")
        if tool not in self.tools:
            raise KeyError(f"MCP server '{self.server}' has no tool '{tool}'")
        async with self._call_lock:
            async with asyncio.timeout(self.call_timeout):
                result = await self.session.call_tool(tool, arguments)
        return _parse_result(result)

    async def close(self) -> None:
        lifecycle = self._lifecycle
        if lifecycle is None:
            if not self.closed:
                await self.stack.aclose()
                if self._stderr is not None:
                    self._stderr.close()
                self.closed = True
            return
        if self.closed:
            return
        self._close_requested.set()
        await asyncio.shield(lifecycle)


class _Registry:
    def __init__(self):
        self._owner_loop: asyncio.AbstractEventLoop | None = None
        self._generations: dict[str, _Generation] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._operations: set[asyncio.Task[Any]] = set()
        self._state = "open"
        self._shutdown_task: asyncio.Task[None] | None = None

    def bind_owner(self) -> asyncio.AbstractEventLoop:
        loop = asyncio.get_running_loop()
        if self._owner_loop is None:
            self._owner_loop = loop
        return self._owner_loop

    def _assert_owner(self) -> None:
        loop = asyncio.get_running_loop()
        if self._owner_loop is None:
            self._owner_loop = loop
        elif loop is not self._owner_loop:
            raise RuntimeError("MCP registry state must only be accessed on its owner loop")

    def _accepting_work(self) -> None:
        self._assert_owner()
        if self._state != "open":
            raise RuntimeError(f"MCP registry is {self._state.replace('_', ' ')}")

    async def _tracked(self, operation: Callable[[], Awaitable[_T]]) -> _T:
        self._accepting_work()
        task = asyncio.current_task()
        assert task is not None
        self._operations.add(task)
        try:
            return await operation()
        finally:
            self._operations.discard(task)

    async def get(self, server: str) -> _Generation:
        return await self._tracked(lambda: self._get(server))

    async def _get(self, server: str) -> _Generation:
        self._accepting_work()
        _validate_name(server, "server")
        lock = self._locks.setdefault(server, asyncio.Lock())
        async with lock:
            return await self._get_locked(server)

    async def _get_locked(self, server: str) -> _Generation:
        self._accepting_work()
        current = self._generations.get(server)
        config = await _config(server)
        self._accepting_work()
        if current and current.config == config and not current.closed:
            return current
        if current:
            await current.close()
            if self._generations.get(server) is current:
                self._generations.pop(server, None)
        self._accepting_work()
        generation = _Generation(server, config)
        self._generations[server] = generation
        try:
            await generation.open()
        except BaseException:
            if self._generations.get(server) is generation:
                self._generations.pop(server, None)
            raise
        return generation

    async def tools(self, server: str) -> list[dict[str, Any]]:
        async def operation() -> list[dict[str, Any]]:
            generation = await self._get(server)
            return [
                copy.deepcopy(tool) for name, tool in generation.tools.items() if generation.allows(name)
            ]

        return await self._tracked(operation)

    async def search(self, server: str, query: str, limit: int) -> list[dict[str, Any]]:
        async def operation() -> list[dict[str, Any]]:
            generation = await self._get(server)
            return _match_tools(generation, query, limit)

        return await self._tracked(operation)

    async def describe(self, server: str, tool: str) -> dict[str, Any]:
        async def operation() -> dict[str, Any]:
            generation = await self._get(server)
            if tool not in generation.tools:
                raise KeyError(f"MCP server '{server}' has no tool '{tool}'")
            if not generation.allows(tool):
                raise PermissionError(f"MCP tool '{tool}' is disabled for server '{server}'")
            return copy.deepcopy(generation.tools[tool])

        return await self._tracked(operation)

    async def call(self, server: str, tool: str, arguments: dict[str, Any]) -> Any:
        async def operation() -> Any:
            self._accepting_work()
            _validate_name(server, "server")
            lock = self._locks.setdefault(server, asyncio.Lock())
            async with lock:
                generation = await self._get_locked(server)
                return await generation.call(tool, arguments)

        return await self._tracked(operation)

    async def reload(self, server: str | None = None) -> None:
        async def operation() -> None:
            names = [server] if server is not None else list(set(self._locks) | set(self._generations))
            results = await asyncio.gather(*(self._close_name(name) for name in names), return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException):
                    raise result

        await self._tracked(operation)

    async def _close_name(self, name: str) -> None:
        self._assert_owner()
        lock = self._locks.setdefault(name, asyncio.Lock())
        async with lock:
            generation = self._generations.get(name)
            if generation:
                await generation.close()
                if generation.closed and self._generations.get(name) is generation:
                    self._generations.pop(name, None)

    async def shutdown(self) -> None:
        self._assert_owner()
        if self._state == "shut_down":
            return
        task = self._shutdown_task
        if task is None or task.done():
            self._state = "shutting_down"
            task = asyncio.create_task(self._shutdown_once())
            self._shutdown_task = task
        await asyncio.shield(task)

    async def _shutdown_once(self) -> None:
        self._assert_owner()
        async with asyncio.timeout(_SHUTDOWN_TIMEOUT):
            operations = list(self._operations)
            for operation in operations:
                operation.cancel()
            if operations:
                await asyncio.gather(*operations, return_exceptions=True)
            names = set(self._locks) | set(self._generations)
            await asyncio.gather(*(self._close_name(name) for name in names), return_exceptions=True)
        self._state = "shut_down"


_registry = _Registry()


async def _dispatch(
    operation: Callable[[], Awaitable[_T]], *, timeout: float | None = None
) -> _T:
    current = asyncio.get_running_loop()
    owner = _registry.bind_owner()
    if current is owner:
        return await operation()
    if owner.is_closed() or not owner.is_running():
        raise RuntimeError("MCP owner loop is unavailable")

    coroutine = operation()
    try:
        submitted = asyncio.run_coroutine_threadsafe(coroutine, owner)
    except BaseException:
        coroutine.close()
        raise RuntimeError("Could not schedule work on the MCP owner loop") from None
    wrapped = asyncio.wrap_future(submitted)
    try:
        done, _ = await asyncio.wait({wrapped}, timeout=timeout)
        if not done:
            submitted.cancel()
            raise RuntimeError("Timed out waiting for the MCP owner loop")
        return await wrapped
    finally:
        if not wrapped.done():
            wrapped.cancel()


async def list_tools(server: str) -> list[dict[str, Any]]:
    return await _dispatch(lambda: _registry.tools(server))


async def call_tool(server: str, tool: str, arguments: dict[str, Any] | None = None) -> Any:
    _validate_name(tool, "tool")
    if arguments is not None and not isinstance(arguments, dict):
        raise TypeError("arguments must be a dict or None")
    return await _dispatch(lambda: _registry.call(server, tool, arguments or {}))


async def reload(server: str | None = None) -> None:
    if server is not None:
        _validate_name(server, "server")
    await _dispatch(lambda: _registry.reload(server), timeout=_SHUTDOWN_TIMEOUT + 1)


async def close() -> None:
    await _dispatch(_registry.shutdown, timeout=_SHUTDOWN_TIMEOUT + 1)


# -- discovery / inventory surface ---------------------------------------------


async def list_connections() -> list[dict[str, Any]]:
    """The user's current MCP connections (host-owned records, no secrets).

    Each entry carries at least ``connectionId``; other fields are host-defined
    (label, service, status, account). ``connectionId`` is the name
    ``list_tools``/``call_tool`` accept.
    """
    result = await _host_inventory("mcp.list_connections", {})
    connections = _inventory_entries(result, "connections")
    for entry in connections:
        connection_id = entry.get("connectionId")
        if not isinstance(connection_id, str) or not connection_id:
            raise RuntimeError("MCP connection inventory from the host is malformed")
    return [_sanitize_inventory_entry(entry) for entry in connections]


async def list_plugins(
    connection_status: str | None = None,
    limit: int = _DEFAULT_PLUGIN_LIMIT,
    cursor: str | None = None,
) -> dict[str, Any]:
    """One bounded page of the supported-service catalog (host-owned).

    Returns ``{"plugins": [...], "nextCursor": str | None}``; while
    ``nextCursor`` is not None, more entries exist — pass it back as ``cursor``.
    ``connection_status`` filters to ``"connected"`` or ``"not_connected"``.
    """
    if connection_status is not None and connection_status not in _PLUGIN_CONNECTION_STATUSES:
        raise ValueError("connection_status must be None, 'connected' or 'not_connected'")
    _validate_limit(limit, "limit", _MAX_PLUGIN_LIMIT)
    payload: dict[str, Any] = {"limit": limit}
    if connection_status is not None:
        payload["connectionStatus"] = connection_status
    if cursor is not None:
        _validate_cursor(cursor)
        payload["cursor"] = cursor
    result = await _host_inventory("mcp.list_plugins", payload)
    return _plugin_page(result)


async def search_plugins(query: str, limit: int = _DEFAULT_PLUGIN_SEARCH_LIMIT) -> dict[str, Any]:
    """Bounded search of the supported-service catalog by the host.

    Matches service ids, labels, aliases, descriptions, categories and
    publishers. Returns ``{"plugins": [...], "nextCursor": None}``; narrow the
    query rather than expecting exhaustive pages.
    """
    if not isinstance(query, str) or not query.strip():
        raise TypeError("query must be a non-empty string")
    _validate_limit(limit, "limit", _MAX_PLUGIN_SEARCH_LIMIT)
    payload: dict[str, Any] = {"query": query.strip(), "limit": limit}
    result = await _host_inventory("mcp.search_plugins", payload)
    return _plugin_page(result)


async def search_tools(
    query: str,
    connection_id: str | None = None,
    limit: int = _DEFAULT_TOOL_SEARCH_LIMIT,
) -> dict[str, Any]:
    """Search live tool names/descriptions and report the search scope.

    With ``connection_id`` only that connection is searched and its errors
    propagate. Without it, at most ``_MAX_TOOL_SEARCH_SERVERS`` connections the
    host reports as connected are searched in host order; per-connection
    failures are reported as fixed, redaction-safe summaries, not raised.

    Returns ``{"tools": [{connectionId, name, description}, ...], "searched":
    [connectionId, ...], "unavailable": [{connectionId, error}, ...],
    "truncated": bool}``. ``truncated`` means matches or servers may remain —
    narrow the query or search a specific connection.
    """
    if not isinstance(query, str) or not query.strip():
        raise TypeError("query must be a non-empty string")
    _validate_limit(limit, "limit", _MAX_TOOL_SEARCH_LIMIT)
    needle = query.strip()
    if connection_id is not None:
        _validate_name(connection_id, "connection")
        tools = await _dispatch(lambda: _registry.search(connection_id, needle, limit))
        return {"tools": tools, "searched": [connection_id], "unavailable": [], "truncated": len(tools) >= limit}
    candidates = [
        entry["connectionId"]
        for entry in await list_connections()
        if entry.get("status") == "connected"
    ]
    scoped = candidates[:_MAX_TOOL_SEARCH_SERVERS]
    tools: list[dict[str, Any]] = []
    searched: list[str] = []
    unavailable: list[dict[str, Any]] = []
    for connection in scoped:
        try:
            found = await _dispatch(lambda cid=connection: _registry.search(cid, needle, limit))
        except Exception as exc:
            unavailable.append({"connectionId": connection, "error": _bounded_error(exc)})
            continue
        searched.append(connection)
        if len(tools) < limit:
            tools.extend(found[: limit - len(tools)])
    truncated = len(tools) >= limit or len(candidates) > len(scoped)
    return {"tools": tools, "searched": searched, "unavailable": unavailable, "truncated": truncated}


async def describe_tool(connection_id: str, tool: str) -> dict[str, Any]:
    """One live tool's ``{"name", "description", "inputSchema"}``.

    Raises ``KeyError`` when the tool or connection is unknown and
    ``PermissionError`` when policy (``enabledTools``/``disabledTools``)
    excludes the tool. Schemas pass through unmodified.
    """
    _validate_name(connection_id, "connection")
    _validate_name(tool, "tool")
    return await _dispatch(lambda: _registry.describe(connection_id, tool))


async def _host_inventory(request_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    outcome: str | None = None
    try:
        async with asyncio.timeout(_INVENTORY_TIMEOUT):
            result = await host_request(request_type, payload)
    except TimeoutError:
        outcome = "timed out"
    except Exception:
        outcome = "failed"
    if outcome is not None:
        # Raised outside the handler so the original exception is not chained:
        # arbitrary host/bridge error text (which can embed credential-bearing
        # URLs, query strings, headers and HTTP bodies) is never echoed, and
        # not even reachable through __cause__/__context__.
        raise RuntimeError(f"MCP {request_type} request {outcome}")
    if not isinstance(result, dict):
        raise RuntimeError(f"MCP {request_type} returned a malformed response")
    return result


def _inventory_entries(result: dict[str, Any], key: str) -> list[dict[str, Any]]:
    entries = result.get(key)
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise RuntimeError(f"MCP {key} inventory from the host is malformed")
    return entries


def _plugin_page(result: dict[str, Any]) -> dict[str, Any]:
    entries = _inventory_entries(result, "plugins")
    next_cursor = result.get("nextCursor")
    if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor):
        raise RuntimeError("MCP plugin inventory from the host is malformed")
    return {
        "plugins": [_sanitize_inventory_entry(entry) for entry in entries],
        "nextCursor": next_cursor,
    }


def _sanitize_inventory_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Copy one inventory entry, dropping secret-looking keys defensively.

    The host must already whitelist safe metadata; this is a second line of
    defense for catalog and connection records only. Never applied to live tool
    schemas or tool results.
    """
    cleaned: dict[str, Any] = {}
    for key, value in entry.items():
        if isinstance(key, str) and _SECRET_KEY_PATTERN.search(key):
            continue
        cleaned[key] = _sanitize_inventory_value(value)
    return cleaned


def _sanitize_inventory_value(value: Any) -> Any:
    if isinstance(value, dict):
        return _sanitize_inventory_entry(value)
    if isinstance(value, list):
        return [_sanitize_inventory_value(item) for item in value]
    return value


def _match_tools(generation: _Generation, query: str, limit: int) -> list[dict[str, Any]]:
    needle = query.lower()
    matches: list[dict[str, Any]] = []
    for name, tool in generation.tools.items():
        if not generation.allows(name):
            continue
        haystack = f"{name}\n{tool.get('description') or ''}".lower()
        if needle not in haystack:
            continue
        matches.append(
            {"connectionId": generation.server, "name": name, "description": tool.get("description") or ""}
        )
        if len(matches) >= limit:
            break
    return matches


_SEARCH_FAILURE_HINTS: tuple[tuple[type[BaseException], str], ...] = (
    (McpCredentialsUnavailable, "credentials for this connection are not available; the user must connect it"),
    (McpStartupError, "the MCP server failed during startup"),
    (KeyError, "the connection or tool is not declared"),
    (PermissionError, "policy excludes this connection or tool"),
    (TimeoutError, "opening or querying the connection timed out"),
)


def _bounded_error(exc: BaseException) -> str:
    """A fixed, redaction-safe summary of one connection's search failure.

    Raw exception text can embed credential-bearing URLs and HTTP bodies, so
    only the exception type name and a fixed hint are ever surfaced.
    """
    hint = "the connection could not be opened or searched"
    for failure_type, message in _SEARCH_FAILURE_HINTS:
        if isinstance(exc, failure_type):
            hint = message
            break
    return f"{type(exc).__name__}: {hint}"



def _validate_limit(value: Any, label: str, maximum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"{label} must be an integer between 1 and {maximum}")


def _validate_cursor(value: Any) -> None:
    if not isinstance(value, str) or not value or len(value) > _MAX_CURSOR_CHARS:
        raise ValueError(f"cursor must be a non-empty string of at most {_MAX_CURSOR_CHARS} characters")


def _validate_name(value: str, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise TypeError(f"{label} must be a non-empty string")


async def _config(server: str) -> dict[str, Any]:
    try:
        async with asyncio.timeout(_DEFAULT_STARTUP_TIMEOUT):
            config = await host_request("mcp.config", {"server": server})
    except Exception as exc:
        raise RuntimeError(f"Could not load MCP configuration for '{server}'") from exc
    if not config:
        raise KeyError(f"MCP server '{server}' is not declared in user settings")
    if config.get("enabled") is False:
        raise RuntimeError(f"MCP server '{server}' is disabled")
    if config.get("type") == "http":
        config = dict(config)
        if config.get("credentialSource") != "acp":
            config["_authIdentity"] = await _auth_identity(server, config)
    return config


def _bound_auth(provider: str, config: dict[str, Any]) -> dict[str, Any] | None:
    """The stored credential, only when bound to this exact endpoint: a token
    that is unbound or bound elsewhere (login finished after a retarget) must
    never be attached — re-login is required. Exact match: both strings come
    from the same settings entry, so any difference means the entry changed."""
    cred = _read_auth(provider)
    if cred is None:
        return None
    endpoint = cred.get("endpoint")
    if not isinstance(endpoint, str) or endpoint != str(config.get("url", "")):
        return None
    return cred


def _credentials_unavailable(server: str) -> McpCredentialsUnavailable:
    return McpCredentialsUnavailable(
        f"MCP credentials for '{server}' are not available. Ask the user to connect it "
        f"(/plugins or /mcp login {server}); do not ask them to set environment variables."
    )


async def _auth_identity(server: str, config: dict[str, Any]) -> str:
    env_name = config.get("bearerTokenEnvVar")
    token = os.environ.get(env_name, "").strip() if isinstance(env_name, str) else ""
    if config.get("oauth") is True and not token:
        provider = f"mcp:{server}"
        cred = _bound_auth(provider, config)
        expires = (cred or {}).get("expires")
        if isinstance(expires, (int, float)) and expires <= time.time() * 1000 + 30_000:
            try:
                await host_request("mcp.refresh", {"server": server})
            except Exception as exc:
                raise RuntimeError(f"Could not refresh MCP credentials for '{server}'") from exc
            cred = _bound_auth(provider, config)
        token = _resolve_config_value(str((cred or {}).get("access") or (cred or {}).get("key") or ""))
    if not token:
        if config.get("oauth") is True or env_name:
            raise _credentials_unavailable(server)
        return "anonymous"
    return hashlib.sha256(token.encode()).hexdigest()


async def _headers(server: str, config: dict[str, Any]) -> dict[str, str]:
    raw = config.get("headers", {})
    if not isinstance(raw, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in raw.items()):
        raise ValueError("MCP HTTP headers must contain strings")
    headers = dict(raw)
    if config.get("credentialSource") == "acp":
        return headers
    env_name = config.get("bearerTokenEnvVar")
    token = os.environ.get(env_name, "").strip() if isinstance(env_name, str) else ""
    if config.get("oauth") is True and not token:
        cred = _bound_auth(f"mcp:{server}", config)
        token = _resolve_config_value(str((cred or {}).get("access") or (cred or {}).get("key") or ""))
    if token:
        headers["Authorization"] = f"Bearer {token}"
    elif config.get("oauth") is True or env_name:
        raise _credentials_unavailable(server)
    return headers


def _stdio_env(config: dict[str, Any]) -> dict[str, str]:
    env = {key: value for key in _SAFE_ENV if (value := os.environ.get(key)) is not None}
    raw = config.get("env", {})
    if not isinstance(raw, dict):
        raise ValueError("MCP stdio env must be an object")
    if config.get("credentialSource") == "acp":
        if not all(isinstance(key, str) and isinstance(value, str) for key, value in raw.items()):
            raise ValueError("ACP MCP stdio env must contain string values")
        env.update(raw)
        return env
    for key, reference in raw.items():
        if not isinstance(key, str) or not isinstance(reference, dict) or set(reference) != {"env"}:
            raise ValueError("MCP stdio env values must use {\"env\": \"NAME\"} references")
        source = reference["env"]
        if not isinstance(source, str) or source not in os.environ:
            raise ValueError(f"MCP stdio environment reference for '{key}' is unavailable")
        env[key] = os.environ[source]
    return env


def _is_exception_group(exc: BaseException) -> bool:
    try:
        return isinstance(exc, BaseExceptionGroup)
    except NameError:  # pragma: no cover - Python 3.10
        return False


def _configured_stdio_values(config: dict[str, Any], env: dict[str, str]) -> tuple[str, ...]:
    """Return configured (not ordinarily inherited) env values for this generation."""
    raw = config.get("env", {})
    if not isinstance(raw, dict):
        return ()
    return tuple(env[key] for key in raw if isinstance(key, str) and key in env)


def _private_config_values(config: dict[str, Any]) -> tuple[str, ...]:
    """Strings an SDK exception must not echo from connection configuration."""
    values: set[str] = set()

    def collect(value: Any) -> None:
        if isinstance(value, str):
            if value:
                values.add(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                collect(key)
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    for key in ("command", "args", "cwd", "url", "headers", "env", "bearerTokenEnvVar"):
        collect(config.get(key))
    return tuple(sorted(values, key=len, reverse=True))


def _sanitize_diagnostic(
    value: str,
    secrets: tuple[str, ...],
    private_values: tuple[str, ...] = (),
    *,
    byte_limit: int = _STDERR_BYTE_LIMIT,
) -> str:
    value = _ANSI_ESCAPE.sub("", value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " "))
    value = _CONTROL_CHAR.sub("", value)
    for secret in secrets:
        value = value.replace(secret, "[REDACTED]")
    for private in private_values:
        if len(private) >= 4:
            value = value.replace(private, "[REDACTED]")
        else:
            value = re.sub(rf"(?<!\w){re.escape(private)}(?!\w)", "[REDACTED]", value)
    lines = [line.strip() for line in value.splitlines() if line.strip()][-_STDERR_LINE_LIMIT:]
    value = "\n".join(lines)
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) > byte_limit:
        value = encoded[-byte_limit:].decode("utf-8", errors="ignore")
    return value.strip()


def _seconds(value: Any, default: float) -> float:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ValueError("MCP timeouts must be positive milliseconds")
    return value / 1000


def _strings(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


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
    both with *different* signatures.
    """
    from mcp.client import streamable_http as mod

    for name in ("streamablehttp_client", "streamable_http_client"):
        fn = getattr(mod, name, None)
        if fn is not None:
            return fn
    raise ImportError(
        "the installed `mcp` SDK exposes no streamable-HTTP client; upgrade `mcp`"
    )


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
