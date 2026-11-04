"""CI gate for the bundled websearch response budget without an HTTP dependency."""

import asyncio
import gzip
import importlib.machinery
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


WEBSEARCH = (
    Path(__file__).resolve().parents[2]
    / "skills"
    / "websearch"
    / "src"
    / "websearch"
    / "websearch.py"
)
MAX_BYTES = 2 * 1024 * 1024


class FakeResponse:
    def __init__(self, *chunks, status=200, headers=None):
        self.chunks = chunks
        self.status_code = status
        self.is_success = 200 <= status < 300
        self.headers = headers or {}
        self.encoding = "utf-8"
        self.read = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def aiter_raw(self, chunk_size=8192):
        self.read = True
        for chunk in self.chunks:
            for start in range(0, len(chunk), chunk_size):
                yield chunk[start : start + chunk_size]


class FakeClient:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def stream(self, _method, _url, **_kwargs):
        return self.response


def fetch(response):
    fake_httpx = types.ModuleType("httpx")
    fake_httpx.__spec__ = importlib.machinery.ModuleSpec("httpx", loader=None)
    fake_httpx.AsyncClient = lambda timeout: FakeClient(response)
    with patch.dict(sys.modules, {"httpx": fake_httpx}):
        spec = importlib.util.spec_from_file_location("websearch_ci_probe", WEBSEARCH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return asyncio.run(module._fetch_serper("query", "test-key"))


class WebsearchResponseBoundsTests(unittest.TestCase):
    def test_normal_result_keeps_its_format(self):
        response = FakeResponse(b'{"organic":[{"title":"A"}]}')
        self.assertEqual(fetch(response), "Result 0: A")

    def test_error_keeps_its_status_and_body(self):
        with self.assertRaisesRegex(
            RuntimeError, r"Serper search error \(429\): slow down"
        ):
            fetch(FakeResponse(b"slow down", status=429))

    def test_declared_size_is_rejected_before_read(self):
        response = FakeResponse(
            b'{"organic":[]}', headers={"Content-Length": str(MAX_BYTES + 1)}
        )
        with self.assertRaisesRegex(ValueError, "Serper response exceeds"):
            fetch(response)
        self.assertFalse(response.read)

    def test_gzip_expansion_is_bounded(self):
        compressed = gzip.compress(b'{"organic":[]}' + b" " * MAX_BYTES)
        with self.assertRaisesRegex(ValueError, "Serper response exceeds"):
            fetch(FakeResponse(compressed, headers={"Content-Encoding": "gzip"}))

    def test_concatenated_gzip_members_share_the_budget(self):
        compressed = gzip.compress(b'{"organic":[]}') + gzip.compress(b" " * MAX_BYTES)
        with self.assertRaisesRegex(ValueError, "Serper response exceeds"):
            fetch(FakeResponse(compressed, headers={"Content-Encoding": "gzip"}))


if __name__ == "__main__":
    unittest.main()
