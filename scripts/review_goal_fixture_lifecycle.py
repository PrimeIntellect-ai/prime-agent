"""Linux process ownership and cleanup for the offline goal CLI fixture."""
import json
import os
from pathlib import Path
import signal
import threading
import time

TAG = 'PA_GOAL_FIXTURE_ID'


def process_identity(pid):
    stat = Path('/proc/%d/stat' % pid).read_text()
    fields = stat[stat.rfind(')') + 2:].split()
    return 'proc:' + fields[19], fields[0]


def verify_worker(row, active, binary, socket_path):
    pid = row['pid']
    assert row.get('rootActiveSessionId') == active, 'wrong descriptor identity'
    assert row.get('supervisorSocketPath') == str(socket_path), 'wrong supervisor descriptor'
    command = Path('/proc/%d/cmdline' % pid).read_bytes().split(b'\0')
    assert command[0] == str(binary).encode(), 'worker argv0 is not fixture binary'
    env = dict(item.split(b'=', 1) for item in Path('/proc/%d/environ' % pid).read_bytes().split(b'\0') if b'=' in item)
    for key, value in {
        'PRIME_AGENT_INTERNAL_DAEMON_WORKER': '1',
        'PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID': active,
        'PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET': str(socket_path),
    }.items():
        assert env.get(key.encode()) == value.encode(), 'wrong fixture worker env identity'
    worker_socket = str(row['socketPath']).encode()
    assert (worker_socket in command or env.get(b'PRIME_AGENT_INTERNAL_DAEMON_WORKER_SOCKET') == worker_socket), 'wrong worker socket identity'
    identity, state = process_identity(pid)
    assert row.get('processStartId') == identity and state != 'Z', 'wrong/reused worker PID'
    return pid, identity




class OwnedProcesses:
    def __init__(self, binary, root, socket_path):
        self.binary, self.root, self.socket_path = binary, root, socket_path
        self.direct = {}
        self.targets = {}
        self.errors = []

    def register(self, process, command):
        identity, state = process_identity(process.pid)
        assert state != 'Z', 'fixture process exited before identity capture'
        self.direct[process.pid] = (identity, [str(arg).encode() for arg in command])
        self.targets[process.pid] = identity

    def ownership(self, pid, identity):
        try:
            current, state = process_identity(pid)
            if current != identity or state == 'Z':
                return False
            env = dict(item.split(b'=', 1) for item in Path('/proc/%d/environ' % pid).read_bytes().split(b'\0') if b'=' in item)
            if env.get(TAG.encode()) != str(self.root).encode():
                return False
            command = Path('/proc/%d/cmdline' % pid).read_bytes().rstrip(b'\0').split(b'\0')
            if pid in self.direct:
                return self.direct[pid] == (identity, command)
            if command[0] == str(self.binary).encode():
                for path in (self.root / 'agent' / 'daemon-workers').rglob('*.json'):
                    row = json.loads(path.read_text())
                    if row.get('pid') == pid:
                        return verify_worker(row, row['rootActiveSessionId'], self.binary, self.socket_path) == (pid, identity)
                return False
            # Kernels retain the owner PID supplied by the actual TS/Rust launcher.
            return ('python' in Path(command[0].decode()).name
                    and env.get(b'PRIME_AGENT_KERNEL_OWNER_PID') in
                    {str(owner).encode() for owner in self.targets})
        except (OSError, ValueError, KeyError, AssertionError, UnicodeError):
            return False

    def discover(self):
        # Capture verified workers before their kernels, including detached workers.
        for path in (self.root / 'agent' / 'daemon-workers').rglob('*.json'):
            try:
                row = json.loads(path.read_text())
                pid, identity = verify_worker(row, row['rootActiveSessionId'], self.binary, self.socket_path)
                if self.ownership(pid, identity):
                    self.targets[pid] = identity
            except (OSError, ValueError, KeyError, AssertionError):
                pass  # A partial/retired descriptor is not an ownership proof.
        for entry in Path('/proc').iterdir():
            if entry.name.isdigit():
                pid = int(entry.name)
                try:
                    identity, _ = process_identity(pid)
                    if self.ownership(pid, identity):
                        self.targets[pid] = identity
                except OSError:
                    pass

    def live(self):
        alive = []
        for pid, identity in list(self.targets.items()):
            try:
                current, state = process_identity(pid)
                if current == identity and state != 'Z':
                    alive.append(pid)
            except FileNotFoundError:
                pass
        return alive

    def wait_gone(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            self.discover()
            alive = self.live()
            if not alive:
                return
            if time.monotonic() >= deadline:
                raise AssertionError('owned goal fixture processes remained: ' + str(alive))
            threading.Event().wait(0.025)

    def send(self, pid, signum):
        identity = self.targets[pid]
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            return False
        try:
            if not self.ownership(pid, identity):
                return False
            signal.pidfd_send_signal(fd, signum)
            return True
        except ProcessLookupError:
            return False
        finally:
            os.close(fd)


def finish(scope, client, daemon, observation):
    """Fallback can reap leftovers but never converts failed shutdown into success."""
    observation['cleanup_verified'] = False
    try:
        scope.discover()
        if daemon is not None:
            assert client is not None, 'owned daemon cleanup client unavailable'
            client.call('shutdown', force=True)
            observation['shutdown_wire'] = client.wire
            client.close()  # TS net.Server.close waits for raw fixture connections.
            daemon.wait(timeout=15)
            assert daemon.returncode == 0, 'owned goal daemon shutdown failed'
        scope.wait_gone(5)
        observation['cleanup_verified'] = True
    except Exception as error:
        observation['cleanup_error'] = str(error)
        observation['fallback_signals'] = []
        for signum, timeout in ((signal.SIGTERM, 3), (signal.SIGKILL, 2)):
            try:
                scope.discover()
            except Exception as discovery_error:
                scope.errors.append('fallback discovery failed: ' + str(discovery_error))
            for pid in scope.live():
                try:
                    if scope.send(pid, signum):
                        observation['fallback_signals'].append({'pid': pid, 'signal': signum.name})
                except OSError as signal_error:
                    scope.errors.append(str(signal_error))
            try:
                scope.wait_gone(timeout)
                break
            except Exception as wait_error:
                scope.errors.append('fallback wait failed: ' + str(wait_error))
        observation['fallback_remaining'] = scope.live()
        observation['fallback_errors'] = scope.errors
    finally:
        if client is not None:
            try:
                client.close()
            except Exception as close_error:
                observation['cleanup_verified'] = False
                observation.setdefault('cleanup_error', str(close_error))
        observation['owned_process_identities'] = dict(scope.targets)
