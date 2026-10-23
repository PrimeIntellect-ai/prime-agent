#!/usr/bin/env python3
"""Controls for the real-daemon request-capture verifier (no Rust build)."""
import http.client
import json
import threading
import unittest

from review_reasoning_wire_parity import ANSWER, PLAN, Capture, differences


class CaptureControls(unittest.TestCase):
    def test_http_capture_keeps_original_body_bytes_and_headers(self):
        server = Capture()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = http.client.HTTPConnection(*server.server_address, timeout=5)
        raw = b'{ "model" : "synthetic", "messages": [], "extra": 17 }'
        try:
            client.request("POST", "/v1/chat/completions", body=raw,
                           headers={"Content-Type": "application/json", "X-Fixture": "retained"})
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn(PLAN.encode(), response.read())
            self.assertEqual(len(server.requests), 1)
            capture = server.requests[0]
            self.assertEqual((capture["path"], capture["raw"], capture["body"]),
                             ("/v1/chat/completions", raw, json.loads(raw)))
            self.assertEqual(capture["headers"]["X-Fixture"], "retained")
        finally:
            client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_comparison_keeps_reasoning_difference_and_unrelated_static_changes(self):
        legacy = {"messages": [{"role": "assistant", "content": PLAN + ANSWER}], "temperature": 0}
        preserved = {"messages": [{"role": "assistant", "content": ANSWER, "reasoning_content": PLAN}], "temperature": 1}
        self.assertEqual(differences(legacy, preserved), [
            {"path": "$.messages[0].content", "ts": PLAN + ANSWER, "rust": ANSWER},
            {"path": "$.messages[0].reasoning_content", "ts": None, "rust": PLAN},
            {"path": "$.temperature", "ts": 0, "rust": 1},
        ])

    def test_whole_array_difference_keeps_every_unmatched_message(self):
        self.assertEqual(differences([], [{"role": "assistant", "content": PLAN}]),
                         [{"path": "$", "ts": [], "rust": [{"role": "assistant", "content": PLAN}]}])


if __name__ == "__main__":
    unittest.main()
