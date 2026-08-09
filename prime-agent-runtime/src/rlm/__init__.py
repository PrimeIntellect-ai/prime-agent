"""Tiny rlm-compatible kernel shim for Prime Agent."""

from __future__ import annotations

import asyncio
import os
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .harness import HarnessEntry, HarnessScope, HarnessState, RefinementEvent, get_harness_state

try:
    from ipykernel.comm import Comm
except Exception:  # pragma: no cover - depends on ipykernel version
    Comm = None  # type: ignore[assignment]

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover - only available in kernels
    get_ipython = None  # type: ignore[assignment]

HOST_COMM_TARGET = "host.request"
HOST_REQUEST_TIMEOUT_ENV = "PRIME_AGENT_HOST_REQUEST_TIMEOUT_MS"
DEFAULT_HOST_REQUEST_TIMEOUT_MS = 120_000
MAX_HOST_REQUEST_TIMEOUT_MS = 3_600_000
_HOST_REQUEST_TIMEOUT_FIELD = "_prime_agent_timeout_ms"
_HOST_REQUEST_EXECUTION_OWNED_FIELD = "_prime_agent_execution_owned"
_host_request_execution_task: asyncio.Task[Any] | None = None
_host_request_task_tracking_installed = False


def _set_host_request_execution_task(*_args: Any) -> None:
    global _host_request_execution_task
    _host_request_execution_task = asyncio.current_task()


def _clear_host_request_execution_task(*_args: Any) -> None:
    global _host_request_execution_task
    _host_request_execution_task = None


def _install_host_request_task_tracking() -> None:
    """Track the task that owns a top-level IPython execution."""
    global _host_request_task_tracking_installed
    if _host_request_task_tracking_installed or get_ipython is None:
        return
    shell = get_ipython()
    if shell is None:
        return
    try:
        shell.events.register("pre_run_cell", _set_host_request_execution_task)
        try:
            shell.events.register("post_run_cell", _clear_host_request_execution_task)
        except Exception:
            shell.events.unregister("pre_run_cell", _set_host_request_execution_task)
            raise
    except Exception:
        return
    _host_request_task_tracking_installed = True


def _host_request_is_execution_owned() -> bool:
    if not _host_request_task_tracking_installed:
        return True
    return asyncio.current_task() is _host_request_execution_task


_install_host_request_task_tracking()


@dataclass(frozen=True)
class RLMSpawnHandle:
    rlm_child_id: str
    name: str
    session_dir: Path
    model: str


@dataclass(frozen=True)
class RLMModel:
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True)
class RLMSubagent:
    rlm_child_id: str
    active_session_id: str | None
    session_id: str | None
    session_name: str
    session_dir: Path
    status: str


def _install_control_comm_handlers() -> None:
    """Let comm replies arrive on the control channel during an execute_request."""
    if get_ipython is None:
        return
    shell = get_ipython()
    kernel = getattr(shell, "kernel", None)
    comm_manager = getattr(kernel, "comm_manager", None)
    control_handlers = getattr(kernel, "control_handlers", None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault("comm_msg", comm_manager.comm_msg)
    control_handlers.setdefault("comm_close", comm_manager.comm_close)


def _spawn_handle_from_payload(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    child_id = payload.get("rlm_child_id")
    name = payload.get("name")
    session_dir = payload.get("session_dir")
    model = payload.get("model")
    if not all(isinstance(value, str) and value for value in (child_id, name, session_dir, model)):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    return RLMSpawnHandle(
        rlm_child_id=child_id,
        name=name,
        session_dir=Path(session_dir),
        model=model,
    )


def _resolve_host_request_timeout_ms(timeout_ms: int | None) -> int:
    value: object = os.environ.get(HOST_REQUEST_TIMEOUT_ENV) if timeout_ms is None else timeout_ms
    if value is None:
        return DEFAULT_HOST_REQUEST_TIMEOUT_MS
    if isinstance(value, str):
        try:
            value = int(value)
        except ValueError as error:
            raise ValueError(
                f"{HOST_REQUEST_TIMEOUT_ENV} must be an integer from 1 to {MAX_HOST_REQUEST_TIMEOUT_MS}"
            ) from error
    if isinstance(value, bool) or not isinstance(value, int):
        name = "timeout_ms" if timeout_ms is not None else HOST_REQUEST_TIMEOUT_ENV
        raise TypeError(f"{name} must be an int")
    if value < 1 or value > MAX_HOST_REQUEST_TIMEOUT_MS:
        name = "timeout_ms" if timeout_ms is not None else HOST_REQUEST_TIMEOUT_ENV
        raise ValueError(f"{name} must be from 1 to {MAX_HOST_REQUEST_TIMEOUT_MS}")
    return value


async def host_request(
    request_type: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    """Send a typed request to the Prime Agent host and await its reply.

    This is the kernel side of the generic host bridge: Python skills call
    ``await host_request("<type>", {...})`` and the TypeScript host dispatches
    on the type. Requests time out after 120 seconds by default. Override the
    deadline per call with ``timeout_ms`` or for the kernel with
    ``PRIME_AGENT_HOST_REQUEST_TIMEOUT_MS`` (1..3,600,000 ms).

    Raises RuntimeError when the host reports an error or no handler for the
    type is registered, and TimeoutError when the request, handler, or reply
    does not complete before the deadline.
    """
    if not isinstance(request_type, str) or not request_type:
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    resolved_timeout_ms = _resolve_host_request_timeout_ms(timeout_ms)
    if Comm is None:
        raise RuntimeError("Jupyter comm support is unavailable in this kernel")
    _install_control_comm_handlers()

    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    comm = Comm(target_name=HOST_COMM_TARGET, primary=False)

    def _schedule(callback: Any) -> None:
        if future.done():
            return
        try:
            loop.call_soon_threadsafe(callback)
        except RuntimeError:
            # The loop can close while a late comm reply is being dispatched.
            return

    def _on_msg(msg: dict[str, Any]) -> None:
        content = msg.get("content", {})
        reply = content.get("data", {}) if isinstance(content, dict) else {}
        if not isinstance(reply, dict):
            return

        status = reply.get("status")
        if status == "ok":

            def _resolve_result() -> None:
                if not future.done():
                    future.set_result({k: v for k, v in reply.items() if k != "status"})

            _schedule(_resolve_result)
            return
        if status == "error":
            message = reply.get("error") or f"host request {request_type} failed"
            error_type = TimeoutError if reply.get("error_type") == "timeout" else RuntimeError

            def _resolve_error() -> None:
                if not future.done():
                    future.set_exception(error_type(str(message)))

            _schedule(_resolve_error)
            return

        unexpected = f"host request {request_type} returned unexpected status: {status!r}"

        def _resolve_unexpected() -> None:
            if not future.done():
                future.set_exception(RuntimeError(unexpected))

        _schedule(_resolve_unexpected)

    comm.on_msg(_on_msg)
    try:
        # Reserved bridge metadata and request_type go last so payload keys
        # cannot change the deadline or reroute the request.
        comm.open(
            data={
                **(payload or {}),
                _HOST_REQUEST_TIMEOUT_FIELD: resolved_timeout_ms,
                _HOST_REQUEST_EXECUTION_OWNED_FIELD: _host_request_is_execution_owned(),
                "type": request_type,
            }
        )
        try:
            return await asyncio.wait_for(future, resolved_timeout_ms / 1000)
        except asyncio.TimeoutError as error:
            raise TimeoutError(
                f'host request "{request_type}" timed out after {resolved_timeout_ms}ms; '
                "its outcome is unknown because the request, handler, or reply may have stalled; "
                "inspect host state before retrying"
            ) from error
    finally:
        if not future.done():
            future.cancel()
        try:
            comm.on_msg(None)
        except Exception:
            pass
        try:
            comm.close()
        except Exception:
            pass


async def run(prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Spawn a recursive Prime Agent child and return once its task is admitted.

    ``model`` selects a child with an exact ``provider/model`` selector.
    """
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    payload = await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs})
    return _spawn_handle_from_payload(payload)


def _model_from_payload(payload: Any) -> RLMModel:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    provider = payload.get("provider")
    model_id = payload.get("id")
    name = payload.get("name")
    selector = payload.get("selector")
    if not all(isinstance(value, str) and value for value in (provider, model_id, name, selector)):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    return RLMModel(provider=provider, id=model_id, name=name, selector=selector)


async def find_models(query: str = "", limit: int = 8) -> list[RLMModel]:
    """Search a bounded list of models backed by active user credentials."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(limit, int):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    payload = await host_request("rlm.find_models", {"query": query, "limit": limit})
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("rlm.find_models returned an invalid models list")
    return [_model_from_payload(model) for model in models]


def _subagent_from_payload(payload: Any, operation: str = "rlm.list_subagents") -> RLMSubagent:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    child_id = payload.get("rlm_child_id")
    active_session_id = payload.get("active_session_id")
    session_id = payload.get("session_id")
    session_name = payload.get("session_name")
    session_dir = payload.get("session_dir")
    status = payload.get("status")
    if not isinstance(child_id, str) or not child_id:
        raise RuntimeError(f"{operation} entry is missing rlm_child_id")
    if active_session_id is not None and not isinstance(active_session_id, str):
        raise RuntimeError(f"{operation} entry has invalid active_session_id")
    if session_id is not None and not isinstance(session_id, str):
        raise RuntimeError(f"{operation} entry has invalid session_id")
    if not isinstance(session_name, str) or not session_name:
        raise RuntimeError(f"{operation} entry is missing session_name")
    if not isinstance(session_dir, str) or not session_dir:
        raise RuntimeError(f"{operation} entry is missing session_dir")
    if status not in {"running", "completed", "error"}:
        raise RuntimeError(f"{operation} entry has invalid status")
    return RLMSubagent(
        rlm_child_id=child_id,
        active_session_id=active_session_id,
        session_id=session_id,
        session_name=session_name,
        session_dir=Path(session_dir),
        status=status,
    )


async def list_subagents() -> list[RLMSubagent]:
    """List direct RLM children retained by the current parent session."""
    payload = await host_request("rlm.list_subagents")
    entries = payload.get("subagents")
    if not isinstance(entries, list):
        raise RuntimeError("rlm.list_subagents returned an invalid subagents registry")
    return [_subagent_from_payload(entry) for entry in entries]


async def delete_subagent(target: str | RLMSubagent) -> RLMSubagent:
    """Delete one running or retained direct child from the current parent session."""
    if isinstance(target, RLMSubagent):
        selector = target.rlm_child_id
    elif isinstance(target, str):
        selector = target.strip()
        if not selector:
            raise ValueError("target must not be empty")
    else:
        raise TypeError(f"target must be str or RLMSubagent, got {type(target).__name__}")
    payload = await host_request("rlm.delete_subagent", {"target": selector})
    return _subagent_from_payload(payload.get("subagent"), "rlm.delete_subagent")


class _HarnessProxy:
    """Resolve the harness state against the current environment on every access.

    The kernel forkserver preimports rlm in a template process before per-session
    env vars exist; a state bound at import time would freeze that (env-less)
    resolution into every forked kernel. Resolving per access picks up the env
    applied after fork. Resolution must never raise (a failure inside the kernel
    namespace would take down the kernel). When the local store is genuinely
    unconfigured (no session env, e.g. --no-session) reads see an empty view but
    local writes raise instructively instead of vanishing on kernel exit; any
    other resolution failure degrades to a shared in-memory store until local
    resolution starts succeeding.
    """

    _fallback: HarnessState | None = None
    _unpersisted: HarnessState | None = None

    def _resolve(self) -> HarnessState:
        try:
            return get_harness_state()
        except RuntimeError as exc:
            if "Local harness state requires" in str(exc):
                if _HarnessProxy._unpersisted is None:
                    _HarnessProxy._unpersisted = HarnessState(
                        in_memory=True,
                        local_write_error=(
                            f"{exc} This session has no persistent local harness store; "
                            "pass global_=True to persist across sessions."
                        ),
                    )
                return _HarnessProxy._unpersisted
            return self._degraded()
        except Exception:  # pragma: no cover - harness access must never raise
            return self._degraded()

    @staticmethod
    def _degraded() -> HarnessState:
        if _HarnessProxy._fallback is None:
            _HarnessProxy._fallback = HarnessState(in_memory=True)
        return _HarnessProxy._fallback

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resolve(), name)

    def __repr__(self) -> str:
        return repr(self._resolve())


_harness_state = _HarnessProxy()


class _RLMCallable:
    harness = _harness_state
    get_harness_state = staticmethod(get_harness_state)

    async def run(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self) -> list[RLMSubagent]:
        return await list_subagents()

    async def delete_subagent(self, target: str | RLMSubagent) -> RLMSubagent:
        return await delete_subagent(target)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()
harness = _harness_state


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "HarnessEntry",
    "HarnessScope",
    "HarnessState",
    "McpIntegration",
    "McpToolError",
    "NotEnabled",
    "RLMModel",
    "RLMSpawnHandle",
    "RLMSubagent",
    "RefinementEvent",
    "delete_subagent",
    "find_models",
    "get_harness_state",
    "harness",
    "host_request",
    "list_subagents",
    "rlm",
    "run",
]

# Lazily re-export the MCP base class. Kept lazy so `import rlm` never requires
# the optional `mcp` SDK — only integration packages that subclass it do.
_LAZY_MCP = {"McpIntegration", "McpToolError", "NotEnabled"}


def __getattr__(name: str) -> Any:  # noqa: D401 - module-level lazy attr hook
    if name in _LAZY_MCP:
        from . import mcp_base

        return getattr(mcp_base, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
