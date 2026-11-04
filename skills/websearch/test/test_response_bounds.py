"""The Serper fetch should bound response bytes before parsing or returning them."""

import asyncio
import gzip
from unittest.mock import patch

import httpx
import pytest

from websearch.websearch import SERPER_MAX_RESPONSE_BYTES, _fetch_serper


class BodyStream(httpx.AsyncByteStream):
    def __init__(self, *chunks: bytes):
        self.chunks = chunks
        self.read = False

    async def __aiter__(self):
        self.read = True
        for chunk in self.chunks:
            yield chunk


def fetch_with_response(response: httpx.Response) -> str:
    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda _request: response)
    with patch.object(
        httpx,
        "AsyncClient",
        side_effect=lambda **kwargs: original_client(transport=transport, **kwargs),
    ):
        return asyncio.run(_fetch_serper("test query", "test-key"))


def test_normal_serper_result_keeps_its_format():
    response = httpx.Response(
        200,
        headers={"Content-Type": "application/json"},
        stream=BodyStream(
            b'{"organic":[{"title":"A","link":"https://example.com","snippet":"hello"}]}'
        ),
    )
    assert (
        fetch_with_response(response) == "Result 0: A\nURL: https://example.com\nhello"
    )


def test_serper_error_keeps_its_status_and_body():
    with pytest.raises(RuntimeError, match=r"Serper search error \(429\): slow down"):
        fetch_with_response(httpx.Response(429, stream=BodyStream(b"slow down")))


def test_oversized_declared_response_is_rejected_before_read():
    stream = BodyStream(b'{"organic": []}')
    response = httpx.Response(
        200,
        headers={"Content-Length": str(SERPER_MAX_RESPONSE_BYTES + 1)},
        stream=stream,
    )
    with pytest.raises(ValueError, match="Serper response exceeds"):
        fetch_with_response(response)
    assert not stream.read


def test_oversized_unannounced_response_is_rejected():
    body = b'{"organic": []}' + b" " * SERPER_MAX_RESPONSE_BYTES
    response = httpx.Response(200, stream=BodyStream(body))
    with pytest.raises(ValueError, match="Serper response exceeds"):
        fetch_with_response(response)


def test_normal_gzip_result_keeps_its_format():
    body = gzip.compress(b'{"organic": [{"title": "A"}]}')
    response = httpx.Response(
        200,
        headers={"Content-Encoding": "gzip"},
        stream=BodyStream(body),
    )
    assert fetch_with_response(response) == "Result 0: A"


def test_gzip_bomb_rejected_without_eager_decode():
    body = gzip.compress(b'{"organic": []}' + b" " * SERPER_MAX_RESPONSE_BYTES)
    response = httpx.Response(
        200,
        headers={"Content-Encoding": "gzip"},
        stream=BodyStream(body),
    )
    with patch.object(
        response, "aiter_bytes", side_effect=AssertionError("eager decode")
    ):
        with pytest.raises(ValueError, match="Serper response exceeds"):
            fetch_with_response(response)
