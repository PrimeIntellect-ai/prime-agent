"""Shared real-binary lifecycle check infrastructure: owned daemons, PTY terminals,
protocol fixture supervisors, terminal screen capture and owned-process cleanup."""
import codecs
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import socket
import struct
import subprocess
import threading
import time
import fcntl
import termios
import unicodedata

LIMIT = 35


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stop(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)


def env_for(root):
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TZ")
           if key in os.environ}
    for key in ("PRIME_AGENT_KERNEL_PYTHON", "PA_E2E_KERNEL_PYTHON"):
        if key in os.environ:
            env[key] = os.environ[key]
    for name in ("home", "tmp", "xdg", "agent/sessions"):
        (root / name).mkdir(parents=True, exist_ok=True)
    env.update(HOME=str(root / "home"), TMPDIR=str(root / "tmp"),
               XDG_CONFIG_HOME=str(root / "xdg"),
               PRIME_AGENT_CODING_AGENT_DIR=str(root / "agent"),
               PI_CODING_AGENT_DIR=str(root / "agent"), TERM="xterm-256color",
               PRIME_AGENT_MODEL_PROVIDER="parity-local", PRIME_AGENT_MODEL="parity-1",
               PI_OFFLINE="1", DO_NOT_TRACK="1")
    (root / "agent/settings.json").write_text(json.dumps({
        "onboardingCompleted": True, "onboardingShown": True,
        "telemetry": {"noticeShown": True}}))
    (root / "agent/models.json").write_text(json.dumps({"providers": {
        "parity-local": {"api": "openai-completions", "baseUrl": "http://127.0.0.1:1/v1",
                         "apiKey": "fixture-only", "models": [{"id": "parity-1",
                         "name": "Parity 1", "contextWindow": 128000, "maxTokens": 4096}]}}}))
    return env


def skill_pythonpath():
    """The repo's bundled skill sources for kernel cells that import skills. With a
    PRIME_AGENT_KERNEL_PYTHON override the product installs no bundled skills into
    that venv (it disables them), so these checks put the sources on PYTHONPATH."""
    skills = Path(__file__).resolve().parent.parent / "skills"
    return os.pathsep.join(sorted(str(path) for path in skills.glob("*/src")))


def actual_hello(binary, root, env):
    path = root / "hello.sock"
    with open(root / "hello-daemon.log", "wb") as log:
        process = subprocess.Popen([str(binary), "--mode", "daemon", "--daemon-socket", str(path)],
            cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = time.monotonic() + LIMIT
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("hello-discovery daemon exited before greeting")
                try:
                    with socket.socket(socket.AF_UNIX) as sock:
                        sock.settimeout(2)
                        sock.connect(str(path))
                        with sock.makefile("rb") as stream:
                            hello = json.loads(stream.readline())
                        if hello.get("type") != "daemon_hello" or not hello.get("schemaId"):
                            raise RuntimeError(f"invalid actual hello: {hello}")
                        return hello
                except (FileNotFoundError, ConnectionRefusedError, socket.timeout):
                    # Poll actual socket readiness, bounded by the discovery deadline.
                    threading.Event().wait(0.05)
            raise TimeoutError("hello-discovery socket readiness")
        finally:
            stop(process)


class Screen:
    """Minimal xterm cell capture; raw ANSI is retained separately for audit."""
    def __init__(self, width=120, height=40):
        self.width, self.height = width, height
        self.cells = [[" "] * width for _ in range(height)]
        self.row = self.col = 0
        self.saved = (0, 0)
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.cells)

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        replies = []
        while self.pending:
            if self.pending[0] == "\x1b":
                if len(self.pending) < 2:
                    break
                if self.pending[1] in "]P_^":
                    end = re.search(r"\x07|\x1b\\", self.pending[2:])
                    if end is None:
                        break
                    self.pending = self.pending[2 + end.end():]
                    continue
                if self.pending[1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.pending)
                    if match is None:
                        break
                    params, _, command = match.groups()
                    self.pending = self.pending[match.end():]
                    nums = [int(x) if x.isdigit() else 0 for x in params.lstrip("?<>").split(";")]
                    n = nums[0] or 1
                    if command in "Hf":
                        self.row = min(self.height - 1, max(0, (nums[0] or 1) - 1))
                        self.col = min(self.width - 1, max(0, ((nums[1] if len(nums) > 1 else 1) or 1) - 1))
                    elif command == "A": self.row = max(0, self.row - n)
                    elif command == "B": self.row = min(self.height - 1, self.row + n)
                    elif command == "C": self.col = min(self.width - 1, self.col + n)
                    elif command == "D": self.col = max(0, self.col - n)
                    elif command == "G": self.col = min(self.width - 1, n - 1)
                    elif command == "J":
                        if nums[0] in (2, 3): self.cells = [[" "] * self.width for _ in range(self.height)]
                        elif nums[0] == 0:
                            self.cells[self.row][self.col:] = [" "] * (self.width - self.col)
                            for row in range(self.row + 1, self.height): self.cells[row] = [" "] * self.width
                    elif command == "K":
                        start, end = (0, self.width) if nums[0] == 2 else ((0, self.col + 1) if nums[0] == 1 else (self.col, self.width))
                        self.cells[self.row][start:end] = [" "] * (end - start)
                    elif command == "P":
                        line = self.cells[self.row]
                        line[self.col:] = (line[self.col + n:] + [" "] * n)[:self.width - self.col]
                    elif command == "X":
                        end = min(self.width, self.col + n)
                        self.cells[self.row][self.col:end] = [" "] * (end - self.col)
                    elif command == "n" and nums[0] == 6:
                        replies.append(f"\x1b[{self.row + 1};{self.col + 1}R".encode())
                    elif command == "c": replies.append(b"\x1b[?1;2c")
                    continue
                command = self.pending[1]
                self.pending = self.pending[2:]
                if command == "7": self.saved = (self.row, self.col)
                elif command == "8": self.row, self.col = self.saved
                elif command in "()" and self.pending: self.pending = self.pending[1:]
                continue
            char, self.pending = self.pending[0], self.pending[1:]
            if char == "\r": self.col = 0
            elif char == "\n":
                self.row += 1
                if self.row >= self.height:
                    self.cells.pop(0); self.cells.append([" "] * self.width); self.row = self.height - 1
            elif char == "\b": self.col = max(0, self.col - 1)
            elif char >= " " and not unicodedata.combining(char):
                if self.col >= self.width: self.col = 0; self.row = min(self.height - 1, self.row + 1)
                self.cells[self.row][self.col] = char
                self.col += 2 if unicodedata.east_asian_width(char) in "WF" else 1
        return replies


def fixture_state(root, active):
    # AgentConnectionState wire shape.
    # No model selected: model and contextUsage are optional on the wire.
    return {"activeSessionId": active, "cwd": str(root), "sessionId": "fixture-durable",
            "sessionName": "Draft fixture", "thinkingLevel": "off", "serviceTier": "default",
            "availableThinkingLevels": ["off"], "isStreaming": False,
            "isCompacting": False, "isBashRunning": False, "retryAttempt": 0,
            "steeringMode": "all", "followUpMode": "all", "leafId": None,
            "autoCompactionEnabled": False, "messageCount": 0, "compactionCount": 0,
            "sessionActions": {"queuedCount": 0, "steering": [], "followUps": []},
            "goal": {"active": False, "status": "idle", "tokensUsed": 0,
                     "timeUsedSeconds": 0, "continuationsUsed": 0},
            "scopedModels": [], "activeToolNames": []}


class Supervisor:
    def __init__(self, path, hello, scenario, root):
        self.path, self.hello, self.scenario, self.root = path, hello, scenario, root
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path)); self.listener.listen(); self.listener.settimeout(0.2)
        self.done = threading.Event()
        self.lock = threading.Lock()
        self.sockets, self.threads, self.errors = [], [], []
        self.commands, self.prompts, self.prompt_envelopes = [], [], []
        self.accepted_prompts, self.result_acks = [], []
        self.journal, self.settled = {}, set()
        self.messages = []
        self.attaches = 0
        self.closed = False
        self.post_close_attached = False
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def extra_command(self, command, response):
        """Subclass-owned protocol additions, handled before unknown-command errors."""
        return False

    def send(self, sock, data):
        sock.sendall((json.dumps(data) + "\n").encode())

    def settle(self, sock, active, key, index, emit=True):
        # Each admitted synthetic turn finishes once; cached result replay
        # does not execute another turn. No real provider is called.
        marker = f"Fixture settled {index}"
        message = {"role": "assistant", "stopReason": "stop",
                   "api": "openai-completions", "provider": "parity-local", "model": "parity-1",
                   "timestamp": 1750000000000, "usage": {"input": 0, "output": 0,
                   "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                   "content": [{"type": "text", "text": marker}]}
        with self.lock:
            if key in self.settled:
                return
            self.settled.add(key)
            prompt = self.prompts[index - 1]
            self.messages.extend([{"role": "user", "content": [{"type": "text", "text": prompt["message"]}],
                                   "timestamp": 1750000000000}, message])
        if not emit:
            return  # Completed history survives lost events and is delivered by attach.
        for event in ({"type": "turn_start"},
                      {"type": "message_start", "message": message},
                      {"type": "message_end", "message": message},
                      {"type": "turn_end", "message": message, "toolResults": []}):
            self.send(sock, {"type": "session_event", "activeSessionId": active, "event": event})

    def accept(self):
        while not self.done.is_set():
            try: sock, _ = self.listener.accept()
            except socket.timeout: continue
            except OSError: return
            sock.settimeout(0.2)
            self.sockets.append(sock)
            thread = threading.Thread(target=self.serve, args=(sock,), daemon=True)
            self.threads.append(thread); thread.start()

    def serve(self, sock):
        # The protocol requires this for prompt dispatch. Advertise only
        # the admission path implemented here; leave direct-peer routing disabled.
        hello = dict(self.hello, serverCapabilities=["session_input_admission"], clientId="draft-fixture")
        buffer = b""
        try:
            self.send(sock, hello)
            while not self.done.is_set():
                try: data = sock.recv(65536)
                except socket.timeout: continue
                if not data: return
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip(): continue
                    envelope = json.loads(line)
                    command = envelope.get("command", envelope)
                    name = command.get("type")
                    request_id = envelope.get("id")
                    client_id = envelope.get("clientId")
                    key = (client_id, request_id)
                    with self.lock:
                        self.commands.append(command)
                    active = "s1"
                    response = {"type": "response", "id": request_id, "command": name,
                                "success": True, "data": {}}
                    if name == "ack_result":
                        # The supervisor acknowledges its journal and returns nothing;
                        # this one-way command must not receive a synthetic response.
                        with self.lock:
                            ack_key = (client_id, command.get("commandId"))
                            self.result_acks.append({"clientId": client_id, "commandId": command.get("commandId")})
                            self.journal.pop(ack_key, None)
                        continue
                    if name == "create":
                        response["data"] = {"activeSessionId": active, "id": active,
                            "sessionId": "fixture-durable", "sessionFile": str(self.root / "agent/sessions/fixture.jsonl")}
                    elif name == "attach":
                        state = fixture_state(self.root, active)
                        with self.lock:
                            messages = list(self.messages)
                        state["messageCount"] = len(messages)
                        response["data"] = {"protocol": hello["protocol"], "activeSessionId": active,
                            "snapshot": {"activeSessionId": active, "summary": {"id": active, "cwd": str(self.root)},
                                         "state": state, "messages": messages, "lastEventSequence": 0, "lastEventCursor": None},
                            "client": {"id": "draft-fixture", "capabilities": []},
                            "lastEventSequence": 0, "lastEventCursor": None}
                        with self.lock:
                            self.attaches += 1
                            if self.closed: self.post_close_attached = True
                    elif name == "prompt":
                        # daemon-mode's accepted prompt success has no data payload.
                        response.pop("data", None)
                        if not client_id or not request_id:
                            raise RuntimeError("prompt envelope lacks clientId/id for recovery identity")
                        with self.lock:
                            self.prompt_envelopes.append({"id": request_id, "clientId": client_id, "command": command})
                            cached = self.journal.get(key)
                        if cached is not None:
                            # Supervisor semantics: (clientId, commandId) completion
                            # returns the cached result without dispatching the prompt again.
                            cached_response, index = cached
                            self.send(sock, cached_response)
                            if cached_response["success"]:
                                self.settle(sock, active, key, index)
                            continue
                        with self.lock:
                            self.prompts.append(command)
                            index = len(self.prompts)
                            self.journal[key] = (dict(response), index)
                            if response["success"]:
                                self.accepted_prompts.append({"id": request_id, "clientId": client_id,
                                                              "command": command})
                    elif name == "list": response["data"] = {"sessions": []}
                    elif name == "heartbeats_list": response["data"] = {"heartbeats": []}
                    elif name == "roster_subscribe": response["data"] = {"changed": [], "removed": [], "resync": True}
                    elif name == "get_available_models": response["data"] = {"models": []}
                    elif name == "get_resource_snapshot":
                        # AgentConnectionResourceSnapshot wire shape.
                        response["data"] = {"contextFiles": [], "skills": [], "prompts": [],
                                            "extensions": [], "themes": [], "diagnostics": {
                                            "skills": [], "prompts": [], "extensions": [], "themes": []}}
                    elif name == "get_session_stats":
                        # AgentSession.getSessionStats's empty-session return shape.
                        response["data"] = {"sessionId": "fixture-durable", "userMessages": 0,
                                            "assistantMessages": 0, "toolCalls": 0, "toolResults": 0,
                                            "totalMessages": 0, "cost": 0, "tokens": {
                                            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
                        with self.lock:
                            response["data"].update(userMessages=len(self.messages) // 2,
                                                    assistantMessages=len(self.messages) // 2,
                                                    totalMessages=len(self.messages))
                    elif name == "get_context_tree":
                        # AgentSession.getContextTree / ContextTreeNode and
                        # usage.emptyUsage: an empty session is a single active root.
                        usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                                 "totalTokens": 0, "cost": {"input": 0, "output": 0,
                                 "cacheRead": 0, "cacheWrite": 0, "total": 0}}
                        response["data"] = {"id": "root", "label": "Draft fixture", "status": "active",
                                            "ownUsage": usage, "totalUsage": usage, "children": []}
                    elif name == "get_model_catalog": response["data"] = {"models": [], "configuredProviders": []}
                    elif name == "get_commands": response["data"] = {"commands": []}
                    elif name == "list_kernel_bash": response["data"] = {"commands": []}
                    elif name == "factory_activity": response["data"] = {"activity": [], "jobs": []}
                    elif name in ("get_state", "get_connection_state"):
                        response["data"] = fixture_state(self.root, active)
                        with self.lock:
                            response["data"]["messageCount"] = len(self.messages)
                    elif name == "get_messages":
                        # pa-daemon worker::commands::handle_get_messages returns
                        # the actual transcript.
                        # Fixture turns only append; no branches/pagination are used.
                        with self.lock:
                            response["data"] = {"messages": list(self.messages)}
                    elif name == "get_session_context":
                        # pa-daemon state_getters::handle_get_session_context's
                        # context envelope. This fixture has no compaction or
                        # model/thinking/tier change rows: build_session_context
                        # preserves its turns and uses off/None/None defaults.
                        with self.lock:
                            response["data"] = {"context": {
                                "messages": list(self.messages), "thinkingLevel": "off",
                                "serviceTier": None, "model": None}}
                    elif name == "get_mcp_connections": response["data"] = {"connections": []}
                    elif name == "detach": response["data"] = {}
                    elif name == "set_auto_compaction":
                        if not isinstance(command.get("enabled"), bool):
                            raise RuntimeError("set_auto_compaction requires a boolean")
                        response.pop("data", None)
                    elif self.extra_command(command, response):
                        pass
                    else:
                        self.errors.append(f"unexpected command: {name}")
                        response.update(success=False, error=f"Unsupported fixture command: {name}")
                    self.send(sock, response)
                    if name == "prompt" and response["success"]:
                        self.settle(sock, active, key, index)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            if not self.done.is_set(): self.errors.append(f"{type(error).__name__}: {error}")
        finally:
            sock.close()

    def close(self):
        self.done.set(); self.listener.close()
        for sock in self.sockets:
            try: sock.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        self.thread.join(timeout=2)
        for thread in self.threads: thread.join(timeout=2)
        if self.thread.is_alive() or any(thread.is_alive() for thread in self.threads):
            raise RuntimeError("owned supervisor threads did not terminate")


class Terminal:
    def __init__(self, command, root, env):
        self.master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~(termios.ECHO | termios.ICANON)
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.process = subprocess.Popen(command, cwd=root, env=env, stdin=slave,
            stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.screen, self.raw = Screen(), bytearray()

    def pump(self):
        if select.select([self.master], [], [], 0.05)[0]:
            try: data = os.read(self.master, 65536)
            except OSError: data = b""
            self.raw.extend(data)
            for reply in self.screen.feed(data): os.write(self.master, reply)

    def wait(self, label, predicate, server):
        deadline = time.monotonic() + LIMIT
        while time.monotonic() < deadline:
            self.pump()
            if server.errors: raise RuntimeError(f"supervisor fixture error: {server.errors}")
            if self.process.poll() is not None: raise RuntimeError(f"UI exited during {label}: {self.process.returncode}")
            if predicate(): return
        raise TimeoutError(label)

    def send(self, data): os.write(self.master, data.encode())

    def close(self):
        stop(self.process)
        os.close(self.master)


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
            # Kernels retain the owner PID supplied by the actual launcher.
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
            except (FileNotFoundError, ProcessLookupError):
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
            client.close()  # The daemon's close waits for raw fixture connections.
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


class DockScreen:
    """Existing xterm cell capture with explicit per-cell SGR attributes."""
    def __init__(self, width=120, height=40):
        self.width, self.height = width, height
        self.cells = [[" "] * width for _ in range(height)]
        self.styles = [[{} for _ in range(width)] for _ in range(height)]
        self.sgr = {}
        self.unsupported_sgr = []
        self.unsupported_terminal = []
        self.keyboard_controls = []
        self.autowrap = True
        self.alternate = None
        self.row = self.col = 0
        self.saved = (0, 0, {})
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.cells)

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        replies = []
        while self.pending:
            if self.pending[0] == "\x1b":
                if len(self.pending) < 2:
                    break
                if self.pending[1] in "]P_^":
                    end = re.search(r"\x07|\x1b\\", self.pending[2:])
                    if end is None:
                        break
                    sequence = self.pending[:2 + end.end()]
                    # OSC titles/hyperlinks do not move terminal cells. DCS,
                    # APC and PM can carry graphics or sixel: never silently
                    # accept their unknown effect on the captured frame.
                    payload = self.pending[2:2 + end.start()]
                    osc_kind = payload.split(';', 1)[0]
                    # Terminals may be asked for the default foreground/background via
                    # OSC10;? / OSC11;?. Queries
                    # do not paint or set a color; a legacy PTY may stay silent.
                    # Color-setting variants remain unsupported and fail closed.
                    color_query = payload in ('10;?', '11;?')
                    if self.pending[1] != ']' or (not color_query and osc_kind not in ('0', '1', '2', '7', '8', '52', '133')):
                        self.unsupported_terminal.append(sequence)
                    self.pending = self.pending[2 + end.end():]
                    continue
                if self.pending[1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.pending)
                    if match is None:
                        break
                    params, intermediate, command = match.groups()
                    sequence = self.pending[:match.end()]
                    self.pending = self.pending[match.end():]
                    nums = [int(x) if x.isdigit() else 0 for x in params.lstrip("?<>").split(";")]
                    n = nums[0] or 1
                    if intermediate and not (command == 'q' and intermediate == ' '):
                        self.unsupported_terminal.append(sequence)
                        continue
                    # Actual hosted captures contain these keyboard
                    # protocol controls. They do not paint cells and must not
                    # be interpreted as SGR4 (underline) after stripping >.
                    if command == 'm' and params in ('>4;0', '>4;1', '>4;2'):
                        self.keyboard_controls.append(sequence)
                        continue
                    if command == 'u' and params == '?':
                        self.keyboard_controls.append(sequence)
                        # Even a zero-flags reply advertises Kitty support to
                        # crossterm (vendor terminal/sys/unix.rs:255). This PTY
                        # emits legacy keys: stay silent on the Kitty query.
                        # The following DA1 query's response settles non-Kitty
                        # through KeyboardEnhancementFlagsFilter instead.
                        continue
                    if command == 'u' and (re.fullmatch(r'[>=]\d+(?:;\d+)?', params)
                                           or re.fullmatch(r'<\d*', params)):
                        self.keyboard_controls.append(sequence)
                        continue
                    if params.startswith(('?', '<', '>')) and command not in 'hlnc':
                        self.unsupported_terminal.append(sequence)
                        continue
                    if command == "m": self.apply_sgr(nums)
                    elif command in "Hf":
                        self.row = min(self.height - 1, max(0, (nums[0] or 1) - 1))
                        self.col = min(self.width - 1, max(0, ((nums[1] if len(nums) > 1 else 1) or 1) - 1))
                    elif command == "A": self.row = max(0, self.row - n)
                    elif command == "B": self.row = min(self.height - 1, self.row + n)
                    elif command == "C": self.col = min(self.width - 1, self.col + n)
                    elif command == "D": self.col = max(0, self.col - n)
                    elif command == "G": self.col = min(self.width - 1, n - 1)
                    elif command == "J":
                        if nums[0] == 2:
                            self.cells = [[" "] * self.width for _ in range(self.height)]
                            self.styles = [[dict(self.sgr) for _ in range(self.width)] for _ in range(self.height)]
                        elif nums[0] == 0:
                            self.cells[self.row][self.col:] = [" "] * (self.width - self.col)
                            self.styles[self.row][self.col:] = [dict(self.sgr) for _ in range(self.width - self.col)]
                            for row in range(self.row + 1, self.height):
                                self.cells[row] = [" "] * self.width
                                self.styles[row] = [dict(self.sgr) for _ in range(self.width)]
                        elif nums[0] != 3:  # ED3 clears scrollback, not visible cells.
                            self.unsupported_terminal.append(sequence)
                    elif command == "K":
                        if nums[0] not in (0, 1, 2):
                            self.unsupported_terminal.append(sequence)
                            continue
                        start, end = (0, self.width) if nums[0] == 2 else ((0, self.col + 1) if nums[0] == 1 else (self.col, self.width))
                        self.cells[self.row][start:end] = [" "] * (end - start)
                        self.styles[self.row][start:end] = [dict(self.sgr) for _ in range(end - start)]
                    elif command == "P":
                        line = self.cells[self.row]
                        line[self.col:] = (line[self.col + n:] + [" "] * n)[:self.width - self.col]
                        styles = self.styles[self.row]
                        styles[self.col:] = (styles[self.col + n:] + [dict(self.sgr) for _ in range(n)])[:self.width - self.col]
                    elif command == "X":
                        end = min(self.width, self.col + n)
                        self.cells[self.row][self.col:end] = [" "] * (end - self.col)
                        self.styles[self.row][self.col:end] = [dict(self.sgr) for _ in range(end - self.col)]
                    elif command == "n" and nums[0] == 6:
                        replies.append(f"\x1b[{self.row + 1};{self.col + 1}R".encode())
                    elif command == "c": replies.append(b"\x1b[?1;2c")
                    elif command in 'hl' and params.startswith('?'):
                        for mode in nums:
                            if mode == 7:
                                self.autowrap = command == 'h'
                            elif mode == 1049:
                                if command == 'h' and self.alternate is None:
                                    self.alternate = (self.cells, self.styles, self.row, self.col,
                                                      dict(self.sgr), self.autowrap)
                                    self.cells = [[' '] * self.width for _ in range(self.height)]
                                    self.styles = [[{} for _ in range(self.width)] for _ in range(self.height)]
                                    self.row = self.col = 0
                                elif command == 'l' and self.alternate is not None:
                                    self.cells, self.styles, self.row, self.col, self.sgr, self.autowrap = self.alternate
                                    self.alternate = None
                            elif mode not in (12, 25, 1000, 1002, 1003, 1004, 1006, 2004, 2026):
                                self.unsupported_terminal.append(sequence)
                    elif command == 'q' and intermediate == ' ':
                        pass  # Cursor presentation, not cell geometry.
                    else:
                        self.unsupported_terminal.append(sequence)
                    continue
                command = self.pending[1]
                if command in '()' and len(self.pending) < 3:
                    break
                self.pending = self.pending[2:]
                if command == "7": self.saved = (self.row, self.col, dict(self.sgr))
                elif command == "8":
                    self.row, self.col, saved_sgr = self.saved
                    self.sgr = dict(saved_sgr)
                elif command in "()" and self.pending:
                    charset = self.pending[0]
                    self.pending = self.pending[1:]
                    if charset != 'B':
                        self.unsupported_terminal.append('\x1b' + command + charset)
                else:
                    self.unsupported_terminal.append('\x1b' + command)
                continue
            char, self.pending = self.pending[0], self.pending[1:]
            if char == "\r": self.col = 0
            elif char == "\n":
                self.row += 1
                if self.row >= self.height:
                    self.cells.pop(0); self.cells.append([" "] * self.width)
                    self.styles.pop(0); self.styles.append([dict(self.sgr) for _ in range(self.width)])
                    self.row = self.height - 1
            elif char == "\b": self.col = max(0, self.col - 1)
            elif char == '\t': self.col = min(self.width - 1, ((self.col // 8) + 1) * 8)
            elif char >= " " and not unicodedata.combining(char):
                if self.col >= self.width:
                    if self.autowrap:
                        self.col = 0
                        self.row += 1
                        if self.row == self.height:
                            self.cells.pop(0); self.cells.append([' '] * self.width)
                            self.styles.pop(0); self.styles.append([dict(self.sgr) for _ in range(self.width)])
                            self.row = self.height - 1
                    else:
                        self.col = self.width - 1
                self.cells[self.row][self.col] = char
                self.styles[self.row][self.col] = dict(self.sgr)
                width = 2 if unicodedata.east_asian_width(char) in "WF" else 1
                if width == 2 and self.col + 1 < self.width:
                    # A terminal paints both cells of a wide glyph, replacing
                    # any old text and background in its continuation cell.
                    self.cells[self.row][self.col + 1] = ' '
                    self.styles[self.row][self.col + 1] = dict(self.sgr)
                self.col += width
            elif char not in ('\x00', '\x07') and not unicodedata.combining(char):
                self.unsupported_terminal.append(char)
        return replies

    def apply_sgr(self, nums):
        i = 0
        while i < len(nums):
            value = nums[i]
            if value == 0:
                self.sgr = {}
            elif value in (1, 2, 3, 4, 7, 9):
                self.sgr[str(value)] = True
            elif value in (22, 23, 24, 27, 29):
                for key in {22: ('1', '2'), 23: ('3',), 24: ('4',), 27: ('7',), 29: ('9',)}[value]:
                    self.sgr.pop(key, None)
            elif 30 <= value <= 37 or 90 <= value <= 97:
                self.sgr['fg'] = ['ansi', value]
            elif 40 <= value <= 47 or 100 <= value <= 107:
                self.sgr['bg'] = ['ansi', value]
            elif value in (39, 49):
                self.sgr.pop('fg' if value == 39 else 'bg', None)
            elif value in (38, 48) and i + 1 < len(nums):
                count = {5: 1, 2: 3}.get(nums[i + 1])
                if count is not None and i + 2 + count <= len(nums):
                    self.sgr['fg' if value == 38 else 'bg'] = nums[i + 1:i + 2 + count]
                    i += 1 + count
                else:
                    self.unsupported_sgr.append(nums[i:])
                    break
            else:
                self.unsupported_sgr.append([value])
            i += 1

    def dock_styles(self):
        return [{"text": ''.join(row).rstrip(), "styles": [dict(style) for style in self.styles[index]]}
                for index, row in enumerate(self.cells)
                if 'subagents' in ''.join(row) or 'running' in ''.join(row)]
