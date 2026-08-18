from __future__ import annotations

import asyncio
import json
import os
import sys
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from mcp.types import CallToolResult, TextContent
from rlm import McpToolError, mcp
from rlm.mcp_base import _parse_result


_STDIO_FIXTURE = r"""import asyncio, json, os, sys
async def main():
    while line := await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline):
        request = json.loads(line)
        if request.get("id") is None:
            continue
        method = request.get("method")
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fixture", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "fixture/raw.tool", "description": "fixture", "inputSchema": {"type": "object"}}]}
        else:
            params = request["params"]
            result = {"content": [{"type": "text", "text": json.dumps({"args": sys.argv[1:], "cwd": os.getcwd(), "env": os.environ.get("FIXTURE_ENV"), "arguments": params.get("arguments", {})})}]}
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
asyncio.run(main())
"""

_HTTP_FIXTURE = """from mcp.server.mcpserver import MCPServer
server = MCPServer("fixture")
@server.tool(name="http/raw.tool")
def echo(value: str) -> dict[str, str]:
    return {"value": value}
server.run(transport="streamable-http", host="127.0.0.1", port=int(__import__("sys").argv[1]))
"""


def run(coro):
    return asyncio.run(coro)


class FakeStack:
    def __init__(self):
        self.closed = 0

    async def aclose(self):
        self.closed += 1


class FakeSession:
    def __init__(self, tools=None, result=None):
        self.tools = tools or []
        self.result = result
        self.calls = []

    async def list_tools(self):
        return SimpleNamespace(tools=self.tools)

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self.result


class McpRegistryTest(unittest.TestCase):
    def setUp(self):
        mcp._registry = mcp._Registry()

    def generation(self, config, tools):
        generation = mcp._Generation("svc", config)
        generation.stack = FakeStack()
        generation.session = FakeSession(tools)
        run(generation.discover())
        return generation

    def test_schema_alias_and_exact_names(self):
        schema = {"type": "object", "properties": {"x": {"const": 1}}}
        tool = SimpleNamespace(name="raw.tool/name", description="raw", input_schema=schema)
        generation = self.generation({"type": "http"}, [tool])
        self.assertEqual(generation.tools["raw.tool/name"]["inputSchema"], schema)

    def test_sdk_result_aliases_preserve_structured_output_and_errors(self):
        structured = CallToolResult(content=[], structuredContent={})
        self.assertEqual(_parse_result(structured), {})

        failed = CallToolResult(content=[TextContent(type="text", text="redacted failure")], isError=True)
        with self.assertRaisesRegex(McpToolError, "redacted failure"):
            _parse_result(failed)

    def test_enabled_then_disabled_filters_listing_and_dispatch(self):
        tools = [SimpleNamespace(name=name, description="", inputSchema={}) for name in ("yes", "denied", "other")]
        generation = self.generation(
            {"type": "http", "enabledTools": ["yes", "denied"], "disabledTools": ["denied"]}, tools
        )
        with mock.patch.object(mcp._registry, "_get_locked", mock.AsyncMock(return_value=generation)):
            self.assertEqual([tool["name"] for tool in run(mcp.list_tools("svc"))], ["yes"])
            with self.assertRaises(PermissionError):
                run(mcp.call_tool("svc", "denied"))

    def test_reuses_generation_and_closes_before_replacement(self):
        configs = [{"type": "http", "url": "a"}, {"type": "http", "url": "a"}, {"type": "http", "url": "b"}]
        opened = []

        async def config(_server):
            return configs.pop(0)

        async def open_generation(generation):
            opened.append(generation)
            generation.session = FakeSession([])

        with mock.patch.object(mcp, "_config", config), mock.patch.object(mcp._Generation, "open", open_generation):
            first = run(mcp._registry.get("svc"))
            self.assertIs(run(mcp._registry.get("svc")), first)
            second = run(mcp._registry.get("svc"))
        self.assertTrue(first.closed)
        self.assertIs(second, opened[-1])

    def test_reload_waits_for_in_flight_first_open(self):
        opening = asyncio.Event()
        release = asyncio.Event()
        opened = []

        async def config(_server):
            return {"type": "http", "url": "a"}

        async def open_generation(generation):
            opened.append(generation)
            generation.session = FakeSession([])
            opening.set()
            await release.wait()

        async def scenario():
            with mock.patch.object(mcp, "_config", config), mock.patch.object(
                mcp._Generation, "open", open_generation
            ):
                first_open = asyncio.create_task(mcp._registry.get("svc"))
                await opening.wait()
                reload_all = asyncio.create_task(mcp._registry.reload())
                await asyncio.sleep(0)
                self.assertFalse(reload_all.done())
                release.set()
                await first_open
                await reload_all

        run(scenario())
        self.assertTrue(opened[0].closed)
        self.assertNotIn("svc", mcp._registry._generations)

    def test_startup_failure_cleanup_and_server_isolation(self):
        async def config(server):
            return {"type": "http", "url": server}

        async def open_generation(generation):
            if generation.server == "bad":
                await generation.close()
                raise RuntimeError("failed")
            generation.session = FakeSession([])

        with mock.patch.object(mcp, "_config", config), mock.patch.object(mcp._Generation, "open", open_generation):
            with self.assertRaises(RuntimeError):
                run(mcp._registry.get("bad"))
            self.assertEqual(run(mcp._registry.get("good")).server, "good")

    def test_call_timeout_cancels_request(self):
        cancelled = False

        class Slow(FakeSession):
            async def call_tool(self, name, arguments):
                nonlocal cancelled
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    cancelled = True
                    raise

        tool = SimpleNamespace(name="slow", description="", inputSchema={})
        generation = self.generation({"type": "http", "callTimeoutMs": 10}, [tool])
        generation.session = Slow([tool])
        with self.assertRaises(TimeoutError):
            run(generation.call("slow", {}))
        self.assertTrue(cancelled)

    def test_stdio_env_is_scrubbed_and_tagged(self):
        with mock.patch.dict(os.environ, {"PATH": "/bin", "SECRET": "value", "UNRELATED": "no"}, clear=True):
            env = mcp._stdio_env({"env": {"TOKEN": {"env": "SECRET"}}})
        self.assertEqual(env, {"PATH": "/bin", "TOKEN": "value"})
        self.assertNotIn("UNRELATED", env)

    def test_diagnostics_do_not_contain_headers_or_env_secrets(self):
        async def host_request(*_args):
            raise RuntimeError("bridge failed")

        with mock.patch.object(mcp, "host_request", host_request):
            with self.assertRaises(RuntimeError) as caught:
                run(mcp.call_tool("svc", "tool", {"secret": "do-not-print"}))
        self.assertNotIn("do-not-print", str(caught.exception))

    def test_cancelled_close_can_be_retried(self):
        generation = self.generation({"type": "http"}, [])

        async def scenario():
            await generation._call_lock.acquire()
            closing = asyncio.create_task(generation.close())
            await asyncio.sleep(0)
            closing.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await closing
            self.assertFalse(generation.closed)
            generation._call_lock.release()
            await generation.close()

        run(scenario())
        self.assertTrue(generation.closed)
        self.assertEqual(generation.stack.closed, 1)

    def test_close_is_idempotent(self):
        generation = self.generation({"type": "http"}, [])
        run(generation.close())
        run(generation.close())
        self.assertEqual(generation.stack.closed, 1)

    def test_real_stdio_argv_cwd_env_and_raw_tool(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "stdio_server.py"
            fixture.write_text(_STDIO_FIXTURE)
            output = self._run_real_stdio(fixture)
        self.assertEqual(output["args"], ["literal value", "$NO_SHELL"])
        self.assertEqual(Path(output["cwd"]).resolve(), fixture.parent.resolve())
        self.assertEqual(output["env"], "resolved")
        self.assertEqual(output["arguments"], {"x": 1})

    def _run_real_stdio(self, fixture):
        config = {
            "type": "stdio",
            "command": sys.executable,
            "args": [str(fixture), "literal value", "$NO_SHELL"],
            "cwd": str(fixture.parent),
            "env": {"FIXTURE_ENV": {"env": "SOURCE_VALUE"}},
        }

        async def scenario():
            with mock.patch.dict(os.environ, {"SOURCE_VALUE": "resolved"}, clear=False):
                generation = mcp._Generation("svc", config)
                await generation.open()
                try:
                    result = await generation.call("fixture/raw.tool", {"x": 1})
                finally:
                    await generation.close()
            return json.loads(result)

        return run(scenario())

    def test_real_anonymous_streamable_http(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        fixture = Path(tmp.name) / "http_server.py"
        fixture.write_text(_HTTP_FIXTURE)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, str(fixture), str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        try:
            deadline = time.time() + 10
            while time.time() < deadline:
                with socket.socket() as probe:
                    if probe.connect_ex(("127.0.0.1", port)) == 0:
                        break
                time.sleep(0.05)
            else:
                self.fail("HTTP MCP fixture did not start")

            async def scenario():
                generation = mcp._Generation("svc", {"type": "http", "url": f"http://127.0.0.1:{port}/mcp"})
                await generation.open()
                try:
                    tools = list(generation.tools)
                    result = await generation.call("http/raw.tool", {"value": "ok"})
                finally:
                    await generation.close()
                return tools, result

            tools, result = run(scenario())
            self.assertEqual(tools, ["http/raw.tool"])
            self.assertEqual(result, {"value": "ok"})
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    def test_boolean_timeout_is_rejected(self):
        with self.assertRaises(ValueError):
            mcp._seconds(True, 1)

    def test_shutdown_hook_supports_synchronous_kernel_handler(self):
        class Kernel:
            def __init__(self):
                self._prime_agent_mcp_shutdown = False

            def do_shutdown(self, restart):
                return {"status": "ok", "restart": restart}

        kernel = Kernel()
        shell = SimpleNamespace(kernel=kernel)
        with mock.patch.object(mcp, "get_ipython", create=True, return_value=shell):
            mcp.install_shutdown_hook()
        with mock.patch.object(mcp, "close", mock.AsyncMock()) as close:
            self.assertEqual(run(kernel.do_shutdown(False)), {"status": "ok", "restart": False})
        close.assert_awaited_once()

    def test_close_waits_for_inflight_startup(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def config(_server):
            return {"type": "http", "url": "a"}

        async def open_generation(generation):
            started.set()
            await release.wait()
            generation.session = FakeSession([])

        async def scenario():
            with mock.patch.object(mcp, "_config", config), mock.patch.object(mcp._Generation, "open", open_generation):
                opening = asyncio.create_task(mcp._registry.get("svc"))
                await started.wait()
                closing = asyncio.create_task(mcp._registry.close())
                await asyncio.sleep(0)
                self.assertFalse(closing.done())
                release.set()
                await opening
                await closing
                self.assertEqual(mcp._registry._generations, {})

        run(scenario())


if __name__ == "__main__":
    unittest.main()
