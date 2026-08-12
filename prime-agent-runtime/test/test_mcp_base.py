from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from unittest import mock

from rlm import mcp_base
from rlm.mcp_base import McpDisabled, McpIntegration, McpToolError, NotEnabled


def _run(coro):
    return asyncio.run(coro)


class _FakeSession:
    """Stand-in for an mcp ClientSession with canned tools/results."""

    def __init__(self, tools, result):
        self._tools = tools
        self._result = result
        self.calls = []

    async def list_tools(self):
        Tool = type("Tool", (), {})

        def make(name, desc, schema):
            t = Tool()
            t.name = name
            t.description = desc
            t.inputSchema = schema
            return t

        resp = type("Resp", (), {})()
        resp.tools = [make(*t) for t in self._tools]
        return resp

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self._result


class _Integration(McpIntegration):
    server = "demo"
    url = "https://example.test/mcp"


class McpIntegrationTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.agent_dir = Path(self._tmp.name)
        self.auth_path = self.agent_dir / "auth.json"
        patcher = mock.patch.object(mcp_base, "_agent_dir", return_value=self.agent_dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)

    def _write_auth(self, cred):
        self.auth_path.write_text(json.dumps({"mcp:demo": cred}))

    def _patch_session(self, session):
        # Replace _open_session so no real network/SDK is needed.
        async def fake_open(self_, stack: AsyncExitStack):
            return session

        return mock.patch.object(_Integration, "_open_session", fake_open)

    def test_not_enabled_without_credentials(self):
        integration = _Integration()
        with self.assertRaises(NotEnabled):
            _run(integration._resolve_token())

    def test_reads_oauth_access_token(self):
        self._write_auth(
            {"type": "oauth", "access": "tok-123", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        self.assertEqual(_run(_Integration()._resolve_token()), "tok-123")

    def test_reads_api_key(self):
        self._write_auth({"type": "api_key", "key": "key-abc"})
        self.assertEqual(_run(_Integration()._resolve_token()), "key-abc")

    def test_api_key_env_indirection_resolved(self):
        self._write_auth({"type": "api_key", "key": "MY_MCP_KEY"})
        with mock.patch.dict("os.environ", {"MY_MCP_KEY": "resolved-secret"}):
            self.assertEqual(_run(_Integration()._resolve_token()), "resolved-secret")

    def test_refreshes_via_host_when_expired(self):
        self._write_auth(
            {"type": "oauth", "access": "old", "refresh": "r", "expires": (time.time() - 10) * 1000}
        )

        async def fake_host_request(req_type, payload):
            self.assertEqual(req_type, "mcp.refresh")
            self.assertEqual(payload, {"server": "demo"})
            # Simulate the host rewriting auth.json with a fresh token.
            self._write_auth(
                {"type": "oauth", "access": "new", "refresh": "r", "expires": (time.time() + 3600) * 1000}
            )
            return {}

        with mock.patch.object(mcp_base, "host_request", fake_host_request):
            self.assertEqual(_run(_Integration()._resolve_token()), "new")

    def test_not_enabled_when_refresh_leaves_token_expired(self):
        # Host refresh "succeeds" but auth.json still holds an expired token →
        # must raise NotEnabled, not return the stale access value.
        self._write_auth(
            {"type": "oauth", "access": "stale", "refresh": "r", "expires": (time.time() - 10) * 1000}
        )

        async def fake_host_request(req_type, payload):
            return {}  # no-op: token stays expired

        with mock.patch.object(mcp_base, "host_request", fake_host_request):
            with self.assertRaises(NotEnabled):
                _run(_Integration()._resolve_token())

    def test_refresh_failure_surfaces_as_error_not_not_enabled(self):
        # Creds exist but the host refresh fails transiently → surface a refresh
        # error, not a misleading NotEnabled (which implies re-login).
        self._write_auth(
            {"type": "oauth", "access": "stale", "refresh": "r", "expires": (time.time() - 10) * 1000}
        )

        async def failing_host_request(req_type, payload):
            raise RuntimeError("network down")

        with mock.patch.object(mcp_base, "host_request", failing_host_request):
            with self.assertRaises(RuntimeError) as ctx:
                _run(_Integration()._resolve_token())
        self.assertNotIsInstance(ctx.exception, NotEnabled)
        self.assertIn("refresh", str(ctx.exception).lower())

    def test_bearer_token_env_wins(self):
        class EnvIntegration(_Integration):
            bearer_token_env = "DEMO_MCP_TOKEN"

        with mock.patch.dict("os.environ", {"DEMO_MCP_TOKEN": "env-secret"}):
            self.assertEqual(_run(EnvIntegration()._resolve_token()), "env-secret")

    def test_empty_structured_result_preserved(self):
        for payload in ({}, []):
            result = type("R", (), {"structuredContent": payload, "content": [], "isError": False})()
            self.assertEqual(mcp_base._parse_result(result), payload)

    def test_error_result_raises(self):
        block = type("B", (), {"text": "boom"})()
        result = type("R", (), {"isError": True, "content": [block], "structuredContent": None})()
        with self.assertRaises(McpToolError) as ctx:
            mcp_base._parse_result(result)
        self.assertIn("boom", str(ctx.exception))

    def test_auto_bound_tool_calls_session(self):
        session = _FakeSession(
            tools=[("list_issues", "List issues", {"type": "object"})],
            result=type("R", (), {"structuredContent": {"issues": [1, 2]}})(),
        )
        self._write_auth(
            {"type": "oauth", "access": "t", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        with self._patch_session(session):
            integration = _Integration()
            out = _run(integration.list_issues(team="Eng"))
        self.assertEqual(out, {"issues": [1, 2]})
        self.assertEqual(session.calls, [("list_issues", {"team": "Eng"})])

    def test_unknown_tool_raises_with_available_list(self):
        session = _FakeSession(tools=[("list_issues", "", {})], result=None)
        self._write_auth(
            {"type": "oauth", "access": "t", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        with self._patch_session(session):
            integration = _Integration()
            with self.assertRaises(AttributeError) as ctx:
                _run(integration.nonexistent_tool())
        self.assertIn("list_issues", str(ctx.exception))

    def test_text_result_parsing(self):
        block = type("B", (), {"text": "hello"})()
        result = type("R", (), {"content": [block], "structuredContent": None})()
        self.assertEqual(mcp_base._parse_result(result), "hello")

    def test_requires_server_attribute(self):
        class Bad(McpIntegration):
            server = ""

        with self.assertRaises(ValueError):
            Bad()

    def _run_open_session_with_transport(self, transport, *, config=None, write_auth=True):
        """Drive the real _open_session against a fake transport callable.

        `transport` must declare its real parameters (headers= or http_client=)
        so the signature inspection in _open_session is exercised faithfully.
        """
        if write_auth:
            self._write_auth(
                {
                    "type": "oauth",
                    "access": "tok-xyz",
                    "refresh": "r",
                    "expires": (time.time() + 3600) * 1000,
                }
            )

        async def fake_host_request(req_type, payload):
            return config or {}  # no URL override by default; fall back to self.url

        with mock.patch.object(mcp_base, "host_request", fake_host_request), \
             mock.patch.object(mcp_base, "_resolve_streamable_http", lambda: transport), \
             mock.patch("mcp.ClientSession") as session_cls:
            session = mock.MagicMock()
            session.initialize = mock.AsyncMock()
            session.call_tool = mock.AsyncMock(
                return_value=type("R", (), {"content": [], "structuredContent": None})()
            )
            session_cls.return_value.__aenter__ = mock.AsyncMock(return_value=session)
            session_cls.return_value.__aexit__ = mock.AsyncMock(return_value=False)
            _run(_Integration().call_tool("noop", {}))

    def test_open_session_uses_headers_signature(self):
        # streamablehttp_client(url, headers=...)
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, headers=None):
            captured["headers"] = headers
            return _CM()

        self._run_open_session_with_transport(transport)
        self.assertEqual(captured["headers"], {"Authorization": "Bearer tok-xyz"})

    def _assert_explicit_host_disable_stops_before_auth_or_transport(self, config):
        calls = []

        async def fake_host_request(req_type, payload):
            calls.append((req_type, payload))
            return config

        def unexpected_transport(*args, **kwargs):
            raise AssertionError("disabled integration must not create a transport")

        with mock.patch.object(mcp_base, "host_request", fake_host_request), \
             mock.patch.object(mcp_base, "_resolve_streamable_http", unexpected_transport), \
             mock.patch.object(_Integration, "_resolve_token", side_effect=AssertionError("disabled integration must not resolve a token")):
            with self.assertRaises(McpDisabled) as ctx:
                _run(_Integration()._open_session(AsyncExitStack()))
        self.assertEqual(calls, [("mcp.config", {"server": "demo"})])
        self.assertIn("settings", str(ctx.exception))
        self.assertIn("/reload", str(ctx.exception))
        self.assertNotIn("login", str(ctx.exception).lower())
        self.assertNotIn("token", str(ctx.exception).lower())

    def test_open_session_disabled_anonymous_server_stops_before_auth_or_transport(self):
        self._assert_explicit_host_disable_stops_before_auth_or_transport(
            {"enabled": False, "url": "https://host.test/mcp", "requiresAuth": False}
        )

    def test_open_session_disabled_server_with_credentials_stops_before_auth_or_transport(self):
        self._write_auth(
            {"type": "oauth", "access": "tok", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        self._assert_explicit_host_disable_stops_before_auth_or_transport(
            {"enabled": False, "url": "https://host.test/mcp", "requiresAuth": True}
        )

    def test_mcp_disabled_is_lazily_exported_from_rlm(self):
        from rlm import McpDisabled as lazy_export

        self.assertIs(lazy_export, McpDisabled)

    def test_open_session_missing_enabled_signal_remains_backward_compatible(self):
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, headers=None):
            captured["headers"] = headers
            return _CM()

        self._run_open_session_with_transport(transport, config={"requiresAuth": False}, write_auth=False)
        self.assertEqual(captured["headers"], {})

    def test_open_session_allows_anonymous_server(self):
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, headers=None):
            captured["headers"] = headers
            return _CM()

        self._run_open_session_with_transport(
            transport,
            config={"requiresAuth": False, "headers": {"X-Extra": "1"}},
            write_auth=False,
        )
        self.assertEqual(captured["headers"], {"X-Extra": "1"})

    def test_open_session_preserves_static_authorization_for_anonymous_server(self):
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, headers=None):
            captured["headers"] = headers
            return _CM()

        self._run_open_session_with_transport(
            transport,
            config={
                "requiresAuth": False,
                "headers": {"Authorization": "Basic explicit", "X-Extra": "1"},
            },
            write_auth=False,
        )
        self.assertEqual(captured["headers"], {"Authorization": "Basic explicit", "X-Extra": "1"})

    def test_open_session_resolved_bearer_overrides_static_authorization(self):
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, headers=None):
            captured["headers"] = headers
            return _CM()

        self._run_open_session_with_transport(
            transport,
            config={"headers": {"Authorization": "Basic explicit", "X-Extra": "1"}},
        )
        self.assertEqual(
            captured["headers"], {"Authorization": "Bearer tok-xyz", "X-Extra": "1"}
        )

    def test_open_session_closes_session_transport_and_client_in_reverse_order(self):
        self._write_auth(
            {"type": "oauth", "access": "tok", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )
        events = []

        class _Context:
            def __init__(self, name, value):
                self.name = name
                self.value = value

            async def __aenter__(self):
                events.append(f"enter:{self.name}")
                return self.value

            async def __aexit__(self, *a):
                events.append(f"exit:{self.name}")
                return False

        def transport(url, *, http_client=None):
            events.append("transport-created")
            return _Context("transport", ("read", "write", None))

        class Session:
            async def initialize(self):
                events.append("initialized")

            async def call_tool(self, name, arguments):
                events.append("called")
                return type("R", (), {"content": [], "structuredContent": None})()

        def build_client(headers):
            events.append("client-created")
            return _Context("client", object())

        async def fake_host_request(req_type, payload):
            return {}

        with mock.patch.object(mcp_base, "host_request", fake_host_request), \
             mock.patch.object(mcp_base, "_resolve_streamable_http", lambda: transport), \
             mock.patch.object(mcp_base, "_build_mcp_http_client", build_client), \
             mock.patch("mcp.ClientSession", return_value=_Context("session", Session())):
            _run(_Integration().call_tool("noop", {}))

        self.assertEqual(
            events,
            [
                "client-created",
                "enter:client",
                "transport-created",
                "enter:transport",
                "enter:session",
                "initialized",
                "called",
                "exit:session",
                "exit:transport",
                "exit:client",
            ],
        )

    def test_open_session_uses_http_client_signature(self):
        # streamable_http_client(url, *, http_client=...) — must NOT pass headers=
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, *, http_client=None):
            captured["http_client"] = http_client
            return _CM()

        self._run_open_session_with_transport(transport)
        self.assertIsNotNone(captured["http_client"])

    def test_open_session_http_client_uses_mcp_timeouts(self):
        # Bare httpx.AsyncClient defaults to a 5s read timeout, which aborts long
        # MCP tool calls with ReadTimeout. The http_client branch must use the SDK
        # factory so MCP defaults (30s general / 300s SSE read) apply.
        captured = {}

        class _CM:
            async def __aenter__(self_inner):
                return ("read", "write", None)

            async def __aexit__(self_inner, *a):
                return False

        def transport(url, *, http_client=None):
            captured["http_client"] = http_client
            return _CM()

        self._run_open_session_with_transport(transport)
        client = captured["http_client"]
        self.assertIsNotNone(client)
        timeout = client.timeout
        # Literals (not SDK constants): pin values that keep long tool calls alive.
        # A 5s read timeout is what the bare-httpx regression used to apply.
        self.assertEqual(timeout.connect, 30.0)
        self.assertEqual(timeout.write, 30.0)
        self.assertEqual(timeout.pool, 30.0)
        self.assertEqual(timeout.read, 300.0)
        # Authorization must still be injected on the prebuilt client.
        self.assertEqual(client.headers.get("Authorization"), "Bearer tok-xyz")

    def test_resolve_config_prefers_host_override_and_headers(self):
        async def host_with_override(req_type, payload):
            return {"url": "https://override.test/mcp", "headers": {"X-Extra": "1"}}

        async def host_empty(req_type, payload):
            return {}

        with mock.patch.object(mcp_base, "host_request", host_with_override):
            url, headers = _run(_Integration()._resolve_config())
            self.assertEqual(url, "https://override.test/mcp")
            self.assertEqual(headers, {"X-Extra": "1"})
        with mock.patch.object(mcp_base, "host_request", host_empty):
            url, headers = _run(_Integration()._resolve_config())
            self.assertEqual(url, _Integration.url)
            self.assertEqual(headers, {})


if __name__ == "__main__":
    unittest.main()
