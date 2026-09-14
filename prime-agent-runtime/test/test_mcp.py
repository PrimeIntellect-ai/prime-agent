from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from mcp.types import CallToolResult, TextContent
from rlm import McpToolError, mcp
from rlm.mcp_base import _parse_result


_STDIO_FIXTURE = r"""import asyncio, json, os, sys
if pid_file := os.environ.get("FIXTURE_PID_FILE"):
    open(pid_file, "w").write(str(os.getpid()))
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
            result = {"content": [{"type": "text", "text": json.dumps({"args": sys.argv[1:], "cwd": os.getcwd(), "env": os.environ.get("FIXTURE_ENV"), "ambient": os.environ.get("UNRELATED"), "arguments": params.get("arguments", {})})}]}
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
asyncio.run(main())
"""

_FAILING_STDIO_FIXTURE = r"""import os, sys
from pathlib import Path
Path(sys.argv[1]).write_text(str(os.getpid()))
secret = os.environ["FIXTURE_SECRET"]
print("\x1b[31mImportError:\x00 broken " + secret + "\x1b[0m", file=sys.stderr, flush=True)
for index in range(300):
    print(f"oversized diagnostic line {index:04d} " + "x" * 100, file=sys.stderr)
print("sentinel tail " + secret, file=sys.stderr, flush=True)
raise ImportError("fixture startup crash")
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
        async def scenario():
            with mock.patch.object(mcp._registry, "_get_locked", mock.AsyncMock(return_value=generation)):
                self.assertEqual([tool["name"] for tool in await mcp.list_tools("svc")], ["yes"])
                with self.assertRaises(PermissionError):
                    await mcp.call_tool("svc", "denied")

        run(scenario())

    def test_reuses_generation_and_closes_before_replacement(self):
        configs = [{"type": "http", "url": "a"}, {"type": "http", "url": "a"}, {"type": "http", "url": "b"}]
        opened = []

        async def config(_server):
            return configs.pop(0)

        async def open_generation(generation):
            opened.append(generation)
            generation.session = FakeSession([])

        async def scenario():
            with mock.patch.object(mcp, "_config", config), mock.patch.object(mcp._Generation, "open", open_generation):
                first = await mcp._registry.get("svc")
                self.assertIs(await mcp._registry.get("svc"), first)
                second = await mcp._registry.get("svc")
            return first, second

        first, second = run(scenario())
        self.assertTrue(first.closed)
        self.assertIs(second, opened[-1])

    def test_config_failure_preserves_cached_generation(self):
        generation = self.generation({"type": "http", "url": "a"}, [])
        mcp._registry._generations["svc"] = generation

        async def unavailable(_server):
            raise RuntimeError("host request timed out")

        async def scenario():
            with mock.patch.object(mcp, "_config", unavailable):
                with self.assertRaises(RuntimeError):
                    await mcp._registry.get("svc")

        run(scenario())
        self.assertFalse(generation.closed)
        self.assertIs(mcp._registry._generations["svc"], generation)

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

        async def scenario():
            with mock.patch.object(mcp, "_config", config), mock.patch.object(mcp._Generation, "open", open_generation):
                with self.assertRaises(RuntimeError):
                    await mcp._registry.get("bad")
                self.assertEqual((await mcp._registry.get("good")).server, "good")

        run(scenario())

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

    def test_cross_loop_dispatch_does_not_impose_a_second_deadline(self):
        loop = asyncio.new_event_loop()
        thread = threading.Thread(target=loop.run_forever)
        thread.start()
        try:
            mcp._registry._owner_loop = loop
            observed_timeout = object()
            real_wait = asyncio.wait

            async def operation():
                await asyncio.sleep(0.01)
                return "done"

            async def capture_wait(*args, **kwargs):
                nonlocal observed_timeout
                observed_timeout = kwargs.get("timeout")
                return await real_wait(*args, **kwargs)

            with mock.patch.object(mcp.asyncio, "wait", capture_wait):
                self.assertEqual(run(mcp._dispatch(operation)), "done")
            self.assertIsNone(observed_timeout)
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join()
            loop.close()

    def test_open_cancellation_after_ready_closes_lifecycle(self):
        generation = mcp._Generation("svc", {"type": "http"})

        async def lifecycle(ready):
            ready.set_result(None)
            asyncio.current_task().get_loop().call_soon(opening.cancel)
            try:
                await generation._close_requested.wait()
            finally:
                generation.closed = True

        async def scenario():
            nonlocal opening
            with mock.patch.object(generation, "_run_lifecycle", lifecycle):
                opening = asyncio.create_task(generation.open())
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(opening, 0.1)
            self.assertTrue(generation.closed)
            self.assertTrue(generation._close_requested.is_set())

        opening = None
        run(scenario())

    def test_stdio_env_is_scrubbed_and_tagged(self):
        with mock.patch.dict(os.environ, {"PATH": "/bin", "SECRET": "value", "UNRELATED": "no"}, clear=True):
            env = mcp._stdio_env({"env": {"TOKEN": {"env": "SECRET"}}})
        self.assertEqual(env, {"PATH": "/bin", "TOKEN": "value"})
        self.assertNotIn("UNRELATED", env)

    def test_acp_headers_never_consult_or_override_host_oauth(self):
        config = {
            "type": "http",
            "url": "https://task.example/mcp",
            "headers": {"Authorization": "Bearer task-token"},
            "credentialSource": "acp",
        }
        with mock.patch.object(mcp, "_read_auth", side_effect=AssertionError("auth.json must not be read")):
            headers = run(mcp._headers("linear", config))
        self.assertEqual(headers, {"Authorization": "Bearer task-token"})

    def test_acp_config_skips_oauth_identity_and_refresh(self):
        async def host_request(_method, _payload):
            return {
                "type": "http",
                "url": "https://task.example/mcp",
                "headers": {"Authorization": "Bearer task-token"},
                "credentialSource": "acp",
            }

        with mock.patch.object(mcp, "host_request", host_request), mock.patch.object(
            mcp, "_auth_identity", side_effect=AssertionError("ACP must not resolve host credentials")
        ):
            config = run(mcp._config("linear"))
        self.assertNotIn("_authIdentity", config)

    def test_acp_stdio_env_uses_literal_values_without_ambient_secrets(self):
        with mock.patch.dict(os.environ, {"PATH": "/bin", "UNRELATED": "ambient-secret"}, clear=True):
            env = mcp._stdio_env({"credentialSource": "acp", "env": {"TOKEN": "task-secret"}})
        self.assertEqual(env, {"PATH": "/bin", "TOKEN": "task-secret"})

    def test_endpoint_bound_credential_never_attaches_to_another_url(self):
        cred = {"access": "old-token", "endpoint": "https://old.example/mcp"}
        config = {"oauth": True, "url": "https://new.example/mcp"}
        with mock.patch.object(mcp, "_read_auth", return_value=cred):
            with self.assertRaises(RuntimeError):
                asyncio.run(mcp._headers("remote", config))
            # Exact match only: even a trailing-slash difference is a changed entry.
            config["url"] = "https://old.example/mcp/"
            with self.assertRaises(RuntimeError):
                asyncio.run(mcp._headers("remote", config))
            config["url"] = "https://old.example/mcp"
            headers = asyncio.run(mcp._headers("remote", config))
        self.assertEqual(headers["Authorization"], "Bearer old-token")

    def test_unbound_credential_requires_relogin(self):
        config = {"oauth": True, "url": "https://srv.example/mcp"}
        with mock.patch.object(mcp, "_read_auth", return_value={"access": "unbound-token"}):
            with self.assertRaises(RuntimeError):
                asyncio.run(mcp._headers("remote", config))

    def test_diagnostics_do_not_contain_headers_or_env_secrets(self):
        async def host_request(*_args):
            raise RuntimeError("bridge failed")

        with mock.patch.object(mcp, "host_request", host_request):
            with self.assertRaises(RuntimeError) as caught:
                run(mcp.call_tool("svc", "tool", {"secret": "do-not-print"}))
        self.assertNotIn("do-not-print", str(caught.exception))

    def test_startup_cancellation_is_not_wrapped(self):
        generation = mcp._Generation("svc", {"type": "stdio"})
        generation._stderr = mock.Mock()

        class CancelledSession:
            async def initialize(self):
                raise asyncio.CancelledError()

        async def open_transport():
            return object(), object()

        class SessionContext:
            async def __aenter__(self):
                return CancelledSession()

            async def __aexit__(self, *_args):
                return False

        async def scenario():
            with mock.patch.object(generation, "_open_transport", open_transport), mock.patch(
                "mcp.ClientSession", return_value=SessionContext()
            ):
                with self.assertRaises(asyncio.CancelledError):
                    await generation.open()

        run(scenario())

    def test_startup_cleanup_does_not_consume_handshake_deadline(self):
        generation = mcp._Generation("svc", {"type": "stdio", "startupTimeoutMs": 10})
        generation._stderr = mock.Mock()
        generation._stderr.tail.return_value = "ImportError: useful detail"

        class FailedSession:
            async def initialize(self):
                raise RuntimeError("Connection closed")

        async def open_transport():
            return object(), object()

        class SessionContext:
            async def __aenter__(self):
                return FailedSession()

            async def __aexit__(self, *_args):
                return False

        async def slow_close():
            await asyncio.sleep(0.03)

        async def scenario():
            with mock.patch.object(generation, "_open_transport", open_transport), mock.patch.object(
                generation, "close", slow_close
            ), mock.patch("mcp.ClientSession", return_value=SessionContext()):
                with self.assertRaisesRegex(mcp.McpStartupError, "useful detail"):
                    await generation.open()

        run(scenario())

    def test_short_secret_omits_all_child_details(self):
        generation = mcp._Generation("svc", {"type": "stdio"})
        generation._stderr = mock.Mock()
        generation._stderr_disclosable = False
        error = generation._startup_error(RuntimeError("message contains xy"))
        self.assertNotIn("xy", str(error))
        self.assertNotIn("message contains", str(error))
        generation._stderr.tail.assert_not_called()

    def test_cancelled_close_can_be_retried(self):
        generation = mcp._Generation("svc", {"type": "http"})
        release = asyncio.Event()

        async def lifecycle(ready):
            ready.set_result(None)
            await generation._close_requested.wait()
            await release.wait()
            await generation.stack.aclose()
            generation.closed = True

        async def scenario():
            ready = asyncio.get_running_loop().create_future()
            generation._lifecycle = asyncio.create_task(lifecycle(ready))
            await ready
            closing = asyncio.create_task(generation.close())
            await asyncio.sleep(0)
            closing.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await closing
            self.assertFalse(generation.closed)
            release.set()
            await generation.close()

        run(scenario())
        self.assertTrue(generation.closed)

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

    def test_real_acp_stdio_preserves_cwd_and_exact_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "stdio_server.py"
            fixture.write_text(_STDIO_FIXTURE)
            config = {
                "type": "stdio",
                "command": sys.executable,
                "args": [str(fixture), "task"],
                "cwd": str(fixture.parent),
                "env": {"FIXTURE_ENV": "task-secret"},
                "credentialSource": "acp",
            }

            async def scenario():
                with mock.patch.dict(os.environ, {"UNRELATED": "ambient-secret"}, clear=False):
                    generation = mcp._Generation("task-tools", config)
                    await generation.open()
                    try:
                        result = await generation.call("fixture/raw.tool", {})
                    finally:
                        await generation.close()
                return json.loads(result)

            output = run(scenario())
        self.assertEqual(Path(output["cwd"]).resolve(), fixture.parent.resolve())
        self.assertEqual(output["env"], "task-secret")
        self.assertIsNone(output["ambient"])

    def test_reload_reaps_real_acp_stdio_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "stdio_server.py"
            pid_file = Path(tmp) / "stdio.pid"
            fixture.write_text(_STDIO_FIXTURE)
            config = {
                "type": "stdio",
                "command": sys.executable,
                "args": [str(fixture)],
                "cwd": str(fixture.parent),
                "env": {"FIXTURE_PID_FILE": str(pid_file)},
                "credentialSource": "acp",
            }

            async def scenario():
                with mock.patch.object(mcp, "_config", new=mock.AsyncMock(return_value=config)):
                    await mcp._registry.tools("task-tools")
                    pid = int(pid_file.read_text())
                    os.kill(pid, 0)
                    await mcp._registry.reload("task-tools")
                    return pid

            pid = run(scenario())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_real_stdio_startup_diagnostic_is_safe_bounded_and_reaped(self):
        secret = "stdio-secret-SENTINEL"
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "failing_stdio_server.py"
            pid_file = Path(tmp) / "child.pid"
            fixture.write_text(_FAILING_STDIO_FIXTURE)
            config = {
                "type": "stdio",
                "command": sys.executable,
                "args": [str(fixture), str(pid_file)],
                "cwd": tmp,
                "env": {"FIXTURE_SECRET": {"env": "SOURCE_SECRET"}},
            }

            async def scenario():
                with mock.patch.dict(os.environ, {"SOURCE_SECRET": secret}, clear=False):
                    generation = mcp._Generation("svc", config)
                    with self.assertRaises(mcp.McpStartupError) as caught:
                        await generation.open()
                    self.assertTrue(generation.closed)
                    self.assertEqual(generation.tools, {})
                    return str(caught.exception)

            diagnostic = run(scenario())
            pid = int(pid_file.read_text())

        self.assertIn("MCP stdio server failed during startup", diagnostic)
        self.assertIn("MCPError: Connection closed", diagnostic)
        self.assertIn("sentinel tail [REDACTED]", diagnostic)
        self.assertNotIn(secret, diagnostic)
        self.assertNotIn("\x1b", diagnostic)
        self.assertNotIn("\x00", diagnostic)
        self.assertLessEqual(len(diagnostic.encode()), mcp._STDERR_BYTE_LIMIT + 1200)
        self.assertLessEqual(len(diagnostic.splitlines()), mcp._STDERR_LINE_LIMIT + 1)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_successful_stdio_discards_startup_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "stdio_server.py"
            fixture.write_text(
                _STDIO_FIXTURE.replace(
                    "async def main():",
                    "print('startup note', file=sys.stderr, flush=True)\nasync def main():",
                )
            )
            config = {"type": "stdio", "command": sys.executable, "args": [str(fixture)]}

            async def scenario():
                generation = mcp._Generation("svc", config)
                await generation.open()
                self.assertIsNotNone(generation._stderr)
                self.assertEqual(generation._stderr.tail(()), "")
                await generation.close()

            run(scenario())

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

    def test_shutdown_closes_servers_concurrently_with_one_deadline(self):
        started = 0
        all_started = asyncio.Event()

        class SlowGeneration:
            closed = False

            async def close(self):
                nonlocal started
                started += 1
                if started == 2:
                    all_started.set()
                await all_started.wait()
                await asyncio.sleep(10)

        async def scenario():
            registry = mcp._Registry()
            registry._generations = {"one": SlowGeneration(), "two": SlowGeneration()}
            with mock.patch.object(mcp, "_SHUTDOWN_TIMEOUT", 0.02):
                with self.assertRaises(TimeoutError):
                    await registry.shutdown()
            self.assertEqual(started, 2)
            with self.assertRaises(RuntimeError):
                await registry.get("new")

        run(scenario())

    def test_reload_remains_reusable_but_shutdown_is_terminal(self):
        async def config(_server):
            return {"type": "http", "url": "a"}

        async def open_generation(generation):
            generation.session = FakeSession([])

        async def scenario():
            registry = mcp._Registry()
            with mock.patch.object(mcp, "_config", config), mock.patch.object(
                mcp._Generation, "open", open_generation
            ):
                first = await registry.get("svc")
                await registry.reload("svc")
                second = await registry.get("svc")
                self.assertIsNot(first, second)
                await registry.shutdown()
                with self.assertRaises(RuntimeError):
                    await registry.reload("svc")

        run(scenario())

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
                closing = asyncio.create_task(mcp._registry.shutdown())
                await asyncio.sleep(0)
                self.assertFalse(closing.done())
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await opening
                await closing
                self.assertEqual(mcp._registry._generations, {})

        run(scenario())


if __name__ == "__main__":
    unittest.main()
