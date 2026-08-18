"""Kernel-owned generic MCP client registry."""

from __future__ import annotations

import asyncio
import atexit
import hashlib
import os
import time
from contextlib import AsyncExitStack
from typing import Any

from . import host_request
from .mcp_base import _parse_result, _read_auth, _resolve_config_value

__all__ = ["call_tool", "close", "list_tools", "reload"]

_DEFAULT_STARTUP_TIMEOUT = 20.0
_DEFAULT_CALL_TIMEOUT = 60.0
_SAFE_ENV = ("HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR")


class _Generation:
    def __init__(self, server: str, config: dict[str, Any]):
        self.server = server
        self.config = config
        self.stack = AsyncExitStack()
        self.session: Any = None
        self.tools: dict[str, dict[str, Any]] = {}
        self.closed = False
        self._call_lock = asyncio.Lock()

    @property
    def startup_timeout(self) -> float:
        return _seconds(self.config.get("startupTimeoutMs"), _DEFAULT_STARTUP_TIMEOUT)

    @property
    def call_timeout(self) -> float:
        return _seconds(self.config.get("callTimeoutMs"), _DEFAULT_CALL_TIMEOUT)

    async def open(self) -> None:
        try:
            async with asyncio.timeout(self.startup_timeout):
                read, write = await self._open_transport()
                from mcp import ClientSession

                self.session = await self.stack.enter_async_context(
                    ClientSession(read, write, read_timeout_seconds=self.call_timeout)
                )
                await self.session.initialize()
                await self.discover()
        except BaseException:
            await self.close()
            raise

    async def _open_transport(self):
        kind = self.config.get("type")
        if kind == "http":
            return await self._open_http()
        if kind == "stdio":
            return await self._open_stdio()
        raise ValueError(f"MCP server '{self.server}' has unsupported transport {kind!r}")

    async def _open_http(self):
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import create_mcp_http_client

        url = self.config.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError(f"MCP server '{self.server}' requires a URL")
        headers = await _headers(self.server, self.config)
        client = await self.stack.enter_async_context(create_mcp_http_client(headers=headers))
        streams = await self.stack.enter_async_context(streamable_http_client(url, http_client=client))
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
        params = StdioServerParameters(command=command, args=args, cwd=cwd, env=_stdio_env(self.config))
        return await self.stack.enter_async_context(stdio_client(params))

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
        if self.closed:
            return
        async with self._call_lock:
            try:
                async with asyncio.timeout(5):
                    await self.stack.aclose()
            except TimeoutError:
                pass
            self.closed = True


class _Registry:
    def __init__(self):
        self._generations: dict[str, _Generation] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._closing = False

    async def get(self, server: str) -> _Generation:
        _validate_name(server, "server")
        lock = self._locks.setdefault(server, asyncio.Lock())
        async with lock:
            return await self._get_locked(server)

    async def _get_locked(self, server: str) -> _Generation:
        if self._closing:
            raise RuntimeError("MCP registry is closing")
        config = await _config(server)
        current = self._generations.get(server)
        if current and current.config == config and not current.closed:
            return current
        if current:
            await current.close()
            self._generations.pop(server, None)
        generation = _Generation(server, config)
        await generation.open()
        self._generations[server] = generation
        return generation

    async def tools(self, server: str) -> list[dict[str, Any]]:
        _validate_name(server, "server")
        lock = self._locks.setdefault(server, asyncio.Lock())
        async with lock:
            generation = await self._get_locked(server)
            return [dict(tool) for name, tool in generation.tools.items() if generation.allows(name)]

    async def call(self, server: str, tool: str, arguments: dict[str, Any]) -> Any:
        _validate_name(server, "server")
        lock = self._locks.setdefault(server, asyncio.Lock())
        async with lock:
            generation = await self._get_locked(server)
            return await generation.call(tool, arguments)

    async def reload(self, server: str | None = None) -> None:
        names = [server] if server is not None else list(set(self._locks) | set(self._generations))
        for name in names:
            lock = self._locks.setdefault(name, asyncio.Lock())
            async with lock:
                generation = self._generations.pop(name, None)
                if generation:
                    await generation.close()

    async def close(self) -> None:
        self._closing = True
        try:
            names = set(self._locks) | set(self._generations)
            for name in names:
                lock = self._locks.setdefault(name, asyncio.Lock())
                async with lock:
                    generation = self._generations.pop(name, None)
                    if generation:
                        await generation.close()
        finally:
            self._closing = False


_registry = _Registry()


async def list_tools(server: str) -> list[dict[str, Any]]:
    return await _registry.tools(server)


async def call_tool(server: str, tool: str, arguments: dict[str, Any] | None = None) -> Any:
    _validate_name(tool, "tool")
    if arguments is not None and not isinstance(arguments, dict):
        raise TypeError("arguments must be a dict or None")
    return await _registry.call(server, tool, arguments or {})


async def reload(server: str | None = None) -> None:
    if server is not None:
        _validate_name(server, "server")
    await _registry.reload(server)


async def close() -> None:
    await _registry.close()


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
        config["_authIdentity"] = await _auth_identity(server, config)
    return config


async def _auth_identity(server: str, config: dict[str, Any]) -> str:
    env_name = config.get("bearerTokenEnvVar")
    token = os.environ.get(env_name, "").strip() if isinstance(env_name, str) else ""
    if config.get("oauth") is True and not token:
        provider = f"mcp:{server}"
        cred = _read_auth(provider)
        expires = (cred or {}).get("expires")
        if isinstance(expires, (int, float)) and expires <= time.time() * 1000 + 30_000:
            try:
                await host_request("mcp.refresh", {"server": server})
            except Exception as exc:
                raise RuntimeError(f"Could not refresh MCP credentials for '{server}'") from exc
            cred = _read_auth(provider)
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
    env_name = config.get("bearerTokenEnvVar")
    token = os.environ.get(env_name, "").strip() if isinstance(env_name, str) else ""
    if config.get("oauth") is True and not token:
        cred = _read_auth(f"mcp:{server}")
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
    for key, reference in raw.items():
        if not isinstance(key, str) or not isinstance(reference, dict) or set(reference) != {"env"}:
            raise ValueError("MCP stdio env values must use {\"env\": \"NAME\"} references")
        source = reference["env"]
        if not isinstance(source, str) or source not in os.environ:
            raise ValueError(f"MCP stdio environment reference for '{key}' is unavailable")
        env[key] = os.environ[source]
    return env


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
    original = kernel.do_shutdown

    async def do_shutdown(restart: bool):
        await close()
        result = original(restart)
        if hasattr(result, "__await__"):
            return await result
        return result

    kernel.do_shutdown = do_shutdown
    kernel._prime_agent_mcp_shutdown = True


def _close_at_exit() -> None:
    try:
        asyncio.run(close())
    except Exception:
        pass


atexit.register(_close_at_exit)
