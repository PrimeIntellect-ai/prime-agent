#!/usr/bin/env python3
"""Mock product modes: daemon shutdown waits for its held UI connection.

Only used by the Rust harness regression; never loads or launches the product.
"""
import json
from pathlib import Path
import select
import socket
import sys
import time

path = Path(sys.argv[sys.argv.index('--daemon-socket') + 1])
if '--mode' not in sys.argv:
    with socket.socket(socket.AF_UNIX) as peer:
        peer.connect(str(path))
        peer.recv(4096)
        peer.sendall(b'held-ui\n')
        sys.stdout.write('▗▄▄█▀ mock paint 0 (0%)\n')
        sys.stdout.flush()
        # The mock UI remains connected until its owned process is stopped.
        while peer.recv(4096):
            pass
    sys.exit(0)

listener = socket.socket(socket.AF_UNIX)
listener.bind(str(path))
listener.listen()
peers = {}
accepting = True
shutdown = False
deadline = time.monotonic() + 20
try:
    while accepting or peers:
        assert time.monotonic() < deadline, 'mock daemon connection drain timed out'
        ready, _, _ = select.select(([listener] if accepting else []) + list(peers), [], [], 1)
        for peer in ready:
            if peer is listener:
                client, _ = listener.accept()
                peers[client] = b''
                try:
                    client.sendall(b'{"type":"daemon_hello"}\n')
                except (BrokenPipeError, ConnectionResetError):
                    client.close()
                    del peers[client]
                continue
            try:
                data = peer.recv(4096)
            except ConnectionResetError:
                data = b''
            if not data:
                peer.close()
                del peers[peer]
                continue
            peers[peer] += data
            if peers[peer] == b'held-ui\n':
                continue
            if b'\n' not in peers[peer]:
                continue
            request = json.loads(peers[peer])
            assert request['command']['type'] == 'shutdown'
            peer.sendall((json.dumps({'type': 'response', 'id': request['id'],
                                     'success': True}) + '\n').encode())
            listener.close()
            accepting = False
            shutdown = True
    assert shutdown, 'mock daemon never received protocol shutdown'
    path.with_suffix('.drained').write_text('all UI/control connections closed\n')
finally:
    listener.close()
    for peer in peers:
        peer.close()
