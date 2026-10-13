#!/usr/bin/env python3
"""Check the restart fixture's durable identity and observable resync gate."""
import json
from pathlib import Path
import socket
import threading
import unittest

from review_reconnect_version_parity import RestartSupervisor


class Connection:
    def __init__(self, descriptor=4):
        self.descriptor = descriptor
        self.frames = []
        self.shutdowns = []

    def fileno(self):
        return self.descriptor

    def sendall(self, data):
        self.frames.append(json.loads(data))

    def shutdown(self, how):
        self.shutdowns.append(how)


def fixture():
    server = object.__new__(RestartSupervisor)
    server.root = Path('/tmp/reconnect-fixture')
    server.closed = False
    server.hello = {'appVersion': '0.9.8', 'protocol': {'version': 7}}
    server.lock = threading.Lock()
    server.sockets = []
    server.release_catalog = threading.Event()
    server.catalog_held = threading.Event()
    return server


class RestartFixtureTests(unittest.TestCase):
    def test_attach_and_list_share_the_durable_session_identity(self):
        server, connection = fixture(), Connection()
        server.send(connection, {'type': 'response', 'command': 'attach',
            'data': {'snapshot': {'summary': {'id': 's1'}, 'state': {'sessionId': 'fixture-durable'}}}})
        server.send(connection, {'type': 'response', 'command': 'list', 'data': {'sessions': []}})
        attached = connection.frames[0]['data']['snapshot']['summary']
        listed = connection.frames[1]['data']['sessions'][0]
        self.assertEqual(attached, listed)
        self.assertEqual(attached['sessionId'], 'fixture-durable')
        self.assertEqual(attached['activeSessionId'], 's1')
        self.assertTrue(attached['sessionFile'].endswith('/sessions/fixture.jsonl'))

    def test_restart_announces_shutdown_before_closing_only_live_connections(self):
        server = fixture()
        live, closed = Connection(), Connection(-1)
        server.sockets = [live, closed]
        server.restart('0.10.0')
        self.assertEqual(live.frames, [
            {'type': 'daemon_closing', 'reason': 'shutdown'},
            {'type': 'session_closed', 'activeSessionId': 's1', 'reason': 'shutdown'}])
        self.assertEqual(live.shutdowns, [socket.SHUT_RDWR])
        self.assertEqual(closed.frames, [])
        self.assertEqual(server.hello['appVersion'], '0.10.0')
        self.assertEqual(server.hello['protocol'], {'version': 7})
        self.assertTrue(server.hello['supervisorGeneration'])

    def test_restarted_catalog_response_waits_for_capture_release(self):
        server, connection = fixture(), Connection()
        server.closed = True
        response = {'type': 'response', 'command': 'get_commands', 'data': {'commands': []}}
        thread = threading.Thread(target=server.send, args=(connection, response), daemon=True)
        thread.start()
        try:
            self.assertTrue(server.catalog_held.wait(2))
            self.assertEqual(connection.frames, [])
        finally:
            server.release_catalog.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(connection.frames, [response])


if __name__ == '__main__':
    unittest.main()
