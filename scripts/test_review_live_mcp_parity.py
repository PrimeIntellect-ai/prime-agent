#!/usr/bin/env python3
"""Lightweight verifier tests; these do not claim binary parity."""
import copy
import http.client
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

import review_live_mcp_parity as parity


class VerifierTests(unittest.TestCase):
    def observation(self):
        return {'before': {'pid': 10, 'configs': {'fixture-before': parity.BEFORE, 'fixture-after': {}}},
                'after': {'pid': 10, 'configs': {'fixture-before': {}, 'fixture-after': parity.AFTER}}}

    def test_rejects_stale_and_rebuilt_rust_handler(self):
        good = self.observation()
        parity.validate_observation(good, 'rust')
        stale = self.observation()
        stale['after']['configs'] = copy.deepcopy(stale['before']['configs'])
        with self.assertRaises(AssertionError):
            parity.validate_observation(stale, 'rust')
        rebuilt = self.observation()
        rebuilt['after']['pid'] = 11
        with self.assertRaises(AssertionError):
            parity.validate_observation(rebuilt, 'rust')
        parity.validate_observation(rebuilt, 'ts')
        self.assertFalse(rebuilt['kernel_pid_equal'])

    def test_provider_selects_offered_tool_and_requires_actual_result(self):
        server = parity.Server()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            first = {'tools': [{'type': 'function', 'function': {'name': 'python_repl'}}], 'messages': []}
            connection.request('POST', '/v1/chat/completions', json.dumps(first), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            wire = response.read().decode()
            self.assertEqual(response.status, 200)
            event = json.loads(wire.splitlines()[0].removeprefix('data: '))
            function = event['choices'][0]['delta']['tool_calls'][0]['function']
            self.assertEqual(function, {'name': 'python_repl', 'arguments': json.dumps({'code': parity.CELL})})
            with self.assertRaises(AssertionError):
                parity.latest_probe(server.requests['before'])
            actual = self.observation()['before']
            second = {'messages': [{'role': 'tool', 'content': parity.MARKER + json.dumps(actual)}]}
            connection.request('POST', '/v1/chat/completions', json.dumps(second), {'Content-Type': 'application/json'})
            connection.getresponse().read()
            self.assertEqual(parity.latest_probe(server.requests['before']), actual)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_after_probe_selects_latest_result_in_history(self):
        before, after = self.observation()['before'], self.observation()['after']
        old = {'role': 'tool', 'content': parity.MARKER + json.dumps(before)}
        new = {'role': 'tool', 'content': [{'type': 'text', 'text': parity.MARKER + json.dumps(after)}]}
        requests = [{'messages': [old]}, {'messages': [old, new]}]
        self.assertEqual(parity.latest_probe(requests), after)

    def test_jsonl_client_preserves_fragmented_frames_and_protocol(self):
        errors = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.sock'
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(path))
            listener.listen(1)
            protocol = {'name': 'prime-agent.daemon', 'version': 7}
            def serve():
                try:
                    with listener.accept()[0] as connection:
                        greeting = json.dumps({'type': 'daemon_hello', 'protocol': protocol}).encode() + b'\n'
                        connection.sendall(greeting[:5])
                        connection.sendall(greeting[5:])
                        envelope = json.loads(connection.makefile('rb').readline())
                        assert envelope['protocol'] == protocol
                        assert envelope['command'] == {'type': 'reload'}
                        response = {'type': 'response', 'id': envelope['id'], 'success': True, 'data': {'ok': 1}}
                        connection.sendall(b'{"type":"session_event"}\n' + json.dumps(response).encode() + b'\n')
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=serve)
            thread.start()
            process = type('Process', (), {'poll': lambda self: None})()
            client = parity.Client(path, process)
            try:
                self.assertEqual(client.request({'type': 'reload'}), {'ok': 1})
                self.assertEqual(len(client.frames), 3)
            finally:
                client.socket.close()
                thread.join(timeout=3)
                listener.close()
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main()
