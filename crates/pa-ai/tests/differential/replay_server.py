#!/usr/bin/env python3
# Tiny SSE replay server for the prime-inference differential test.
# Serves the captured stream from
# crates/pa-ai/tests/testdata/prime_inference_glm53_flash.sse for every
# POST to /api/v1/chat/completions.
# Usage: replay_server.py <port>
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SSE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "testdata", "prime_inference_glm53_flash.sse")

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        with open(SSE_PATH, "rb") as handle:
            body = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def log_message(self, *args):
        pass

def main():
    port = int(sys.argv[1])
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"listening on {port}", flush=True)
    server.serve_forever()

if __name__ == "__main__":
    main()
