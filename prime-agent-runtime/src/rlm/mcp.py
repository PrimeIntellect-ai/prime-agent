"""Kernel-owned generic MCP client registry."""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import re
import sys
import threading
import time
from contextlib import AsyncExitStack
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from . import host_request
from .mcp_base import _parse_result, _read_auth, _resolve_config_value

__all__ = ["McpStartupError", "call_tool", "close", "list_tools", "reload"]

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


class McpStartupError(RuntimeError):
    """A stdio server failed while completing the MCP startup handshake."""


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

        from .mcp_base import _resolve_streamable_http

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
        response = await self.session.list_tools()
        tools: dict[str, dict[str, Any]] = {}
        for tool in response.tools:
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
        self.tools = tools

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
            return [dict(tool) for name, tool in generation.tools.items() if generation.allows(name)]

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
            raise RuntimeError(f"MCP credentials for '{server}' are not available")
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
        raise RuntimeError(f"MCP credentials for '{server}' are not available")
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


def install_shutdown_hook() -> None:
    try:
        kernel = get_ipython().kernel  # type: ignore[name-defined]
    except (AttributeError, NameError):
        return
    if getattr(kernel, "_prime_agent_mcp_shutdown", False):
        return
    _registry.bind_owner()
    original = kernel.do_shutdown

    async def do_shutdown(restart: bool):
        try:
            await close()
        except BaseException as exc:
            print(f"Prime Agent MCP shutdown failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        result = original(restart)
        if hasattr(result, "__await__"):
            return await result
        return result

    kernel.do_shutdown = do_shutdown
    kernel._prime_agent_mcp_shutdown = True
