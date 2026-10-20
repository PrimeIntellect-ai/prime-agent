#!/usr/bin/env python3
"""Check the binary verifier's transport and provider hold, not product behavior."""
import http.client
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from check_agent_bounce import Client, Provider


class LiveProcess:
    @staticmethod
    def poll():
        return None


class FixtureTests(unittest.TestCase):
    def test_client_skips_events_but_checks_correlated_command_failure(self):
        with tempfile.TemporaryDirectory(prefix='bounce-test-', dir='/tmp') as root:
            path = Path(root) / 'd.sock'
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(path))
                listener.listen()
                received = []
                errors = []
                def serve():
                    try:
                        conn, _ = listener.accept()
                        with conn, conn.makefile('rb') as stream:
                            conn.sendall(b'{"type":"daemon_hello"}\n')
                            received.append(json.loads(stream.readline()))
                            conn.sendall(b'{"type":"session_event"}\n')
                            conn.sendall(b'{"type":"response","id":"1","success":true,"data":{"steering":[],"followUp":[]}}\n')
                            received.append(json.loads(stream.readline()))
                            conn.sendall(b'{"type":"response","id":"2","success":false,"error":"fixture refusal"}\n')
                    except Exception as error:
                        errors.append(error)
                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                client = Client(path, LiveProcess())
                try:
                    self.assertEqual(client.call('get_queue', activeSessionId='fixture'),
                                     {'steering': [], 'followUp': []})
                    with self.assertRaisesRegex(AssertionError, 'fixture refusal'):
                        client.call('clear_queue', activeSessionId='fixture')
                finally:
                    client.close()
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(received[0]['command'], {'type': 'get_queue', 'activeSessionId': 'fixture'})
                self.assertEqual(received[0]['protocol'], {'name': 'prime-agent.daemon', 'version': 7})

    def test_provider_observes_actual_request_before_releasing_response(self):
        provider = Provider()
        server = threading.Thread(target=provider.serve_forever, daemon=True)
        server.start()
        done = threading.Event()
        errors = []
        def request():
            try:
                conn = http.client.HTTPConnection('127.0.0.1', provider.server_port, timeout=5)
                conn.request('POST', '/v1/chat/completions',
                             json.dumps({'messages': [{'content': 'HOLD_TEST'}]}),
                             {'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'data: [DONE]\n\n')
                conn.close()
            except Exception as error:
                errors.append(error)
            finally:
                done.set()
        client = threading.Thread(target=request, daemon=True)
        client.start()
        try:
            provider.wait_for('HOLD_TEST')
            self.assertFalse(done.is_set(), 'response escaped the busy-turn gate')
            provider.release.set()
            self.assertTrue(done.wait(5))
            self.assertEqual(errors, [])
        finally:
            provider.release.set()
            provider.shutdown()
            provider.server_close()
            client.join(5)


if __name__ == '__main__':
    unittest.main()
