#!/usr/bin/env python3
"""Deterministic OpenAI-compatible mock provider for the parity battery.

Serves `/v1/chat/completions` (SSE streaming) and `/v1/models` from a JSON
script file, so the TS binary and the Rust binary can be driven side by side
with identical model responses. Not part of the product; battery harness
only.

Script file format:
    {
      "responses": [
        {"text": "hello"},
        {"toolCall": {"name": "bash", "arguments": {"command": "echo hi"}}},
        {"error": "prompt is too long: 213462 tokens > 200000 maximum", "status": 400},
        {"text": "done", "delayMs": 500, "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "prompt_tokens_details": {"cached_tokens": 80}}}
      ],
      "queues": [
        {"name": "child", "match": ["child task text"], "matchModels": ["mock-1"], "responses": [{"text": "child reply"}]}
      ]
    }
Optional per-response keys: `delayMs` (stream starts after the delay), `usage`
(overrides the reported token usage, so a flow can push the session past a
context/compaction threshold deterministically), and `error`/`status` (a
scripted provider failure: the non-2xx answer carries the OpenAI error body,
so a flow can script overflow probes identically for both binaries).

Responses are SESSION-SCOPED, not global. The chat-completions wire carries
no session id, so a queue is selected per request: the first queue whose
`matchModels` entry equals the request's model id, or whose `match` marker
appears in the concatenated text of the request's user-role messages, serves
the request; a request that matches no queue falls through to the default
`responses` queue. This keeps a parent session and a spawned child session
(which race the provider concurrently) on independent scripted response
cursors instead of popping one shared queue in arrival order, and keeps
model-routed flows (a scripted turn model vs a dashboard status-line model)
off each other's cursors. User-role text is the discriminator because a
parent's post-tool continuation embeds the child's task text in tool-call
arguments and tool results; matching those would misroute the parent.
Each queue pops its next scripted response per matching request
(round-robin when a queue runs dry: its last entry repeats). Every request,
the raw request body, and the serving queue's name are logged to
`<script>.requests.jsonl` for wire-level diffs.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def user_message_text(body: dict) -> str:
    """Concatenated text of the request's user-role messages (string or
    content-part form). Tool results and tool-call arguments are excluded:
    a parent's post-tool continuation embeds the child's task text there,
    so those would misroute the parent into the child's queue."""
    parts = []
    for message in body.get("messages", []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("text"):
                    parts.append(part["text"])
    return chr(10).join(parts)


class MockState:
    def __init__(self, script_path: str):
        self.script_path = script_path
        self.script_mtime = None
        self.responses = []
        self.index = 0
        # Session-scoped queues: [{"name", "match", "responses", "index"}]
        self.queues = []
        self.request_log_path = script_path + ".requests.jsonl"
        self.lock = threading.Lock()
        self._reload_if_changed()

    def _reload_if_changed(self):
        """Reload the script when the file changes; a new script restarts
        every response cursor at 0, so each battery flow can swap scripts
        against one long-lived provider process."""
        mtime = os.stat(self.script_path).st_mtime
        if mtime != self.script_mtime:
            with open(self.script_path) as f:
                script = json.load(f)
            self.script_mtime = mtime
            self.responses = script["responses"]
            self.index = 0
            self.queues = []
            for queue in script.get("queues", []):
                self.queues.append(
                    {
                        "name": queue["name"],
                        "match": queue.get("match", []),
                        "matchModels": queue.get("matchModels", []),
                        "responses": queue["responses"],
                        "index": 0,
                    }
                )

    def next_response(self, body: dict):
        """Pop the next scripted response for this request's session: the
        first queue whose model id or user-text markers match serves it;
        no match falls through to the default queue. Returns the serving
        queue's name and the scripted entry."""
        with self.lock:
            self._reload_if_changed()
            user_text = user_message_text(body)
            model = body.get("model", "")
            for queue in self.queues:
                matched_model = model in queue["matchModels"]
                matched_text = any(marker in user_text for marker in queue["match"])
                if matched_model or matched_text:
                    entry = queue["responses"][min(queue["index"], len(queue["responses"]) - 1)]
                    queue["index"] += 1
                    return queue["name"], entry
            entry = self.responses[min(self.index, len(self.responses) - 1)]
            self.index += 1
            return "default", entry


def chunk_delta(delta, finish_reason=None):
    return {
        "id": "chatcmpl-battery",
        "object": "chat.completion.chunk",
        "created": 1750000000,
        "model": "mock-1",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


class Handler(BaseHTTPRequestHandler):
    state: MockState
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json(
                200,
                {"object": "list", "data": [{"id": "mock-1", "object": "model", "owned_by": "battery"}]},
            )
        else:
            self._json(404, {"error": {"message": f"unknown path {self.path}"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self._json(400, {"error": {"message": "invalid json"}})
            return
        if "/chat/completions" not in self.path:
            self._json(404, {"error": {"message": f"unknown path {self.path}"}})
            return
        queue_name, entry = self.state.next_response(body)
        with open(self.state.request_log_path, "a") as f:
            f.write(
                json.dumps(
                    {
                        "path": self.path,
                        "body": body,
                        "auth": self.headers.get("Authorization", ""),
                        "queue": queue_name,
                    }
                )
                + "\n"
            )
        # Optional scripted provider failure: `{"error": "<message>",
        # "status": 400}` answers with a non-2xx status and the OpenAI
        # error body, so a flow can script provider failures (overflow
        # probes included) identically for both binaries.
        if "error" in entry:
            error_body = {"message": entry["error"]}
            if entry.get("errorType"):
                error_body["type"] = entry["errorType"]
            self._json(int(entry.get("status") or 400), {"error": error_body})
            return
        # Optional scripted delay: the response starts streaming after
        # `delayMs`, so a battery flow can hold a session mid-turn.
        delay_ms = float(entry.get("delayMs") or 0)
        if delay_ms > 0:
            time.sleep(delay_ms / 1000.0)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def send(obj):
            data = f"data: {json.dumps(obj)}\r\n\r\n".encode()
            # Proper HTTP chunked framing: each write is one chunk.
            self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")

        try:
            if "text" in entry:
                send(chunk_delta({"role": "assistant", "content": entry["text"]}))
            elif "toolCall" in entry:
                call = entry["toolCall"]
                args = json.dumps(call["arguments"])
                send(
                    chunk_delta(
                        {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": call.get("id", "call_battery_1"),
                                    "type": "function",
                                    "function": {"name": call["name"], "arguments": ""},
                                }
                            ],
                        }
                    )
                )
                # Stream the arguments JSON in two pieces like a real server.
                half = max(1, len(args) // 2)
                send(
                    chunk_delta(
                        {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": args[:half]},
                                }
                            ]
                        }
                    )
                )
                send(
                    chunk_delta(
                        {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": args[half:]},
                                }
                            ],
                        }
                    )
                )
            else:
                send(chunk_delta({"role": "assistant", "content": ""}))
            send(chunk_delta({}, "stop"))
            usage = entry.get("usage") or {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "total_tokens": 110,
                "prompt_tokens_details": {"cached_tokens": 80},
            }
            send(
                {
                    "id": "chatcmpl-battery",
                    "object": "chat.completion.chunk",
                    "created": 1750000000,
                    "model": "mock-1",
                    "choices": [],
                    "usage": usage,
                }
            )
            done = b"data: [DONE]\r\n\r\n"
            self.wfile.write(f"{len(done):X}\r\n".encode() + done + b"\r\n")
            # Terminal chunk: end of the chunked body.
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    script_path = sys.argv[1]
    Handler.state = MockState(script_path)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
