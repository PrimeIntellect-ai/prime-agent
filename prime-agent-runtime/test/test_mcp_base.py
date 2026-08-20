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
from rlm.mcp_base import McpIntegration, McpToolError, NotEnabled


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

    def _run_open_session_with_transport(self, transport):
        """Drive the real _open_session against a fake transport callable.

        `transport` must declare its real parameters (headers= or http_client=)
        so the signature inspection in _open_session is exercised faithfully.
        """
        self._write_auth(
            {"type": "oauth", "access": "tok-xyz", "refresh": "r", "expires": (time.time() + 3600) * 1000}
        )

        async def fake_host_request(req_type, payload):
            return {}  # no host URL override; _resolve_url falls back to self.url

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

    def test_resolve_config_ignores_host_overrides(self):
        # A same-named mcpServers entry must not repoint an authored integration:
        # its credentials (auth.json or a bearer-token env var) would follow.
        async def host_with_override(req_type, payload):
            raise AssertionError("authored integrations must not consult mcp.config")

        with mock.patch.object(mcp_base, "host_request", host_with_override):
            url, headers = _run(_Integration()._resolve_config())
            self.assertEqual(url, _Integration.url)
            self.assertEqual(headers, {})


if __name__ == "__main__":
    unittest.main()
