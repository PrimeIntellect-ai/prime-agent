#!/usr/bin/env python3
"""Real-binary #3401 parity: isolated supervisor failures and ordinary PTY input.

No inference, ambient state, binary installation, or production daemon is used.
A short owned daemon supplies each binary's actual hello/schema. The supervisor
fixture then exercises the ordinary --daemon-socket UI, with no test-only flags.
All terminal captures and wire observations are preserved in the receipt.
"""
import argparse
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
import sys
import tempfile
import threading
import time
import fcntl
import termios
import unicodedata

TS_ARCHIVE_SHA256 = "83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2"
LIMIT = 35
PROMPT = "DRAFT_DISCONNECT_SENTINEL"
PROBE = "DRAFT_TRANSPORT_PROBE"
TS_SOURCE_COMMIT = "7d442aafa985f9342134fac16c2ef41f03fb45c1"
REFUSAL = "Fixture definitively refused this prompt"


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


def env_for(root, kind):
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TZ")
           if key in os.environ}
    if kind == "ts" and "PI_PACKAGE_DIR" in os.environ:
        env["PI_PACKAGE_DIR"] = os.environ["PI_PACKAGE_DIR"]
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
    # AgentConnectionState in the pinned TS binary's source commit (types.ts).
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
        self.rebound = False
        self.post_close_attached = False
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

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
        # The pinned protocol requires this for prompt dispatch. Advertise only
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
                    active = "s2" if self.rebound else "s1"
                    response = {"type": "response", "id": request_id, "command": name,
                                "success": True, "data": {}}
                    if name == "ack_result":
                        # TS supervisor acknowledges its journal and returns undefined;
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
                            # Exact TS supervisor semantics: (clientId, commandId) completion
                            # returns the cached result without dispatching the prompt again.
                            cached_response, index = cached
                            self.send(sock, cached_response)
                            if cached_response["success"]:
                                self.settle(sock, active, key, index)
                            continue
                        with self.lock:
                            self.prompts.append(command)
                            index = len(self.prompts)
                            first = index == 1
                        if first and self.scenario == "refusal":
                            response.update(success=False, error=REFUSAL)
                        with self.lock:
                            # Model complete-before-reply loss, not pending/uncertain journal
                            # recovery. This scenario tests a lost ACK for a completed admission.
                            self.journal[key] = (dict(response), index)
                            if response["success"]:
                                self.accepted_prompts.append({"id": request_id, "clientId": client_id,
                                                              "command": command})
                        if first and self.scenario == "rebind_close":
                            self.settle(sock, active, key, index, emit=False)
                            self.rebound = True
                            self.send(sock, {"type": "session_binding", "previousActiveSessionId": "s1", "activeSessionId": "s2"})
                            continue
                        if first and self.scenario == "queued_close":
                            self.settle(sock, active, key, index, emit=False)
                            self.closed = True
                            return  # Admission/result cached; reply intentionally lost.
                    elif name == "detach" and self.scenario == "rebind_close" and self.rebound and not self.closed:
                        self.closed = True
                        return  # The attach already adopted s2 before it requested detach(s1).
                    elif name == "list": response["data"] = {"sessions": []}
                    elif name == "heartbeats_list": response["data"] = {"heartbeats": []}
                    elif name == "roster_subscribe": response["data"] = {"changed": [], "removed": [], "resync": True}
                    elif name == "get_available_models": response["data"] = {"models": []}
                    elif name == "get_resource_snapshot":
                        # AgentConnectionResourceSnapshot from the pinned TS source.
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
                        # Pinned AgentSession.getContextTree / ContextTreeNode and
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
                    elif name == "get_mcp_connections": response["data"] = {"connections": []}
                    elif name == "detach": response["data"] = {}
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


def scenario(kind, binary, root, hello, name):
    root.mkdir()
    env = env_for(root, kind)
    server = Supervisor(root / "fixture.sock", hello, name, root)
    terminal = None
    result = {"scenario": name, "executed": False, "screens": {}}
    try:
        terminal = Terminal([str(binary), "--daemon-socket", str(server.path)], root, env)
        terminal.wait("initial attach and visible terminal", lambda: server.attaches >= 1
                      and bool(terminal.screen.text().strip()), server)
        terminal.send(PROMPT)
        terminal.wait("typed sentinel visibly in editor", lambda: PROMPT in terminal.screen.text(), server)
        terminal.send("\r")
        terminal.wait("first prompt received", lambda: len(server.prompts) == 1, server)
        if name == "refusal":
            terminal.wait("definite refusal and restored draft", lambda: REFUSAL in terminal.screen.text()
                          and PROMPT in terminal.screen.text(), server)
        else:
            terminal.wait("reconnected attach and visible reconnect result", lambda: server.post_close_attached
                          and ("Fixture settled 1" in terminal.screen.text()
                               or any(phrase in terminal.screen.text().lower() for phrase in
                                      ("daemon reconnected", "daemon restarted (v0.9.8) - reconnected"))), server)
        result["screens"]["before_resubmit"] = terminal.screen.text()
        before = len(server.prompts)
        terminal.send("\r")
        if name == "refusal":
            terminal.wait("resubmitted refusal visibly settled", lambda:
                          "Fixture settled 2" in terminal.screen.text(), server)
        # A visible marker typed afterwards is the barrier that Enter has been handled;
        # the next prompt also proves the post-reconnect transport is operational.
        terminal.send(PROBE)
        terminal.wait("probe visibly typed", lambda: PROBE in terminal.screen.text(), server)
        result["screens"]["after_resubmit"] = terminal.screen.text()
        terminal.send("\r")
        terminal.wait("transport probe received", lambda: any(PROBE in p.get("message", "") for p in server.prompts), server)
        probe_index = next(index + 1 for index, prompt in enumerate(server.prompts)
                           if PROBE in prompt.get("message", ""))
        terminal.wait("transport probe visibly settled", lambda:
                      f"Fixture settled {probe_index}" in terminal.screen.text(), server)
        result.update(executed=True, dispatches_before_resubmit=before,
                      rebound=server.rebound, reconnected=server.post_close_attached)
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        if terminal is not None:
            result["terminal_raw"] = terminal.raw.decode("utf-8", "replace")
            result["screens"]["final"] = terminal.screen.text()
            try:
                terminal.close()
            except Exception as error:
                result.setdefault("cleanup_errors", []).append(f"UI cleanup: {type(error).__name__}: {error}")
        try:
            server.close()
        except Exception as error:
            result.setdefault("cleanup_errors", []).append(f"supervisor cleanup: {type(error).__name__}: {error}")
        # Snapshot only after the owned UI has stopped and all fixture threads joined.
        # A late dispatch cannot be hidden behind an earlier passing invariant.
        messages = [p.get("message") for p in server.prompts]
        expected = [PROMPT, PROMPT, PROBE] if name == "refusal" else [PROMPT, PROBE]
        accepted = [item["command"].get("message") for item in server.accepted_prompts]
        wire_messages = [item["command"].get("message") for item in server.prompt_envelopes]
        result.update(wire_commands=server.commands, prompts=messages,
                      wire_prompt_messages=wire_messages,
                      prompt_envelopes=server.prompt_envelopes,
                      accepted_logical_prompts=server.accepted_prompts,
                      accepted_logical_messages=accepted, result_acks=server.result_acks,
                      persisted_messages=server.messages,
                      expected_prompts=expected, fixture_errors=server.errors,
                      draft_restored=name == "refusal" and messages == expected,
                      draft_consumed=name != "refusal" and messages == expected,
                      invariant_passed=bool(result["executed"] and messages == expected
                                           and accepted == [PROMPT, PROBE] and not server.errors and not result.get("cleanup_errors")))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    receipt = {"fixture": "pr3401-draft-disconnect", "results": {},
               "fixture_schema_source_commit": TS_SOURCE_COMMIT,
               "comparison_scope": "Targeted accepted logical prompt/draft behavior; complete result recovery is keyed by the actual (clientId, commandId), so same-ID wire retries are recorded but do not dispatch a second prompt. Raw IDs, attempts, terminals and commands are retained; full frame/wire equivalence is not asserted.",
               "ci_provenance": {key: os.environ.get(key) for key in ("GITHUB_RUN_ID", "GITHUB_SHA")},
               "ts_reference": {"version": "0.9.8", "expected_archive_sha256": TS_ARCHIVE_SHA256},
               "pre_send_limitation": "A deterministically dead client before send needs the in-process death-watch seam; the binary fixture tests definitive refusal separately."}
    try:
        if sys.platform != "linux": raise RuntimeError("real binary fixture requires Linux")
        if repo in args.receipt.resolve().parents: raise RuntimeError("receipt must be outside repository")
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if event_path:
            event = json.loads(Path(event_path).read_text())
            receipt["ci_provenance"]["pull_request_head_sha"] = event.get("pull_request", {}).get("head", {}).get("sha")
        archive = Path(os.environ["PA_TS_ARCHIVE"])
        receipt["ts_reference"]["verified_archive_sha256"] = digest(archive)
        if digest(archive) != TS_ARCHIVE_SHA256: raise RuntimeError("official TS archive SHA-256 mismatch")
        with tempfile.TemporaryDirectory(prefix="pa-draft-parity-") as temp:
            for kind in ("ts", "rust"):
                item = receipt["results"][kind] = {}
                try:
                    binary = Path(os.environ.get(f"PA_{kind.upper()}_BINARY") or os.environ[f"{kind.upper()}_BINARY"]).resolve()
                    if not binary.is_file() or not os.access(binary, os.X_OK): raise RuntimeError("missing executable")
                    item.update(binary=str(binary), sha256=digest(binary))
                    root = Path(temp) / kind; root.mkdir()
                    env = env_for(root, kind)
                    version = subprocess.run([str(binary), "--version"], cwd=root, env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=15, check=True)
                    item["version"] = version.stdout.strip()
                    if kind == "ts" and "0.9.8" not in item["version"]: raise RuntimeError("unexpected TS version")
                    item["actual_hello"] = actual_hello(binary, root, env)
                    item["scenarios"] = {name: scenario(kind, binary, root / name, item["actual_hello"], name)
                                         for name in ("queued_close", "refusal", "rebind_close")}
                except Exception as error: item["error"] = f"{type(error).__name__}: {error}"
    except Exception as error: receipt["preflight_error"] = f"{type(error).__name__}: {error}"
    comparisons = {}
    for name in ("queued_close", "refusal", "rebind_close"):
        sides = [receipt["results"].get(kind, {}).get("scenarios", {}).get(name, {}) for kind in ("ts", "rust")]
        executed = all(x.get("executed") for x in sides)
        comparisons[name] = {"both_executed": executed,
                             "same_logical_prompt_observations": bool(executed and sides[0].get("prompts") == sides[1].get("prompts")),
                             "same_accepted_logical_observations": bool(executed and sides[0].get("accepted_logical_messages") == sides[1].get("accepted_logical_messages")),
                             "same_wire_prompt_observations": bool(executed and sides[0].get("wire_prompt_messages") == sides[1].get("wire_prompt_messages")),
                             "both_invariants_passed": all(x.get("invariant_passed") for x in sides)}
    receipt["comparisons"] = comparisons
    receipt["parity"] = bool("preflight_error" not in receipt and all(
        all(item[key] for key in ("both_executed", "same_logical_prompt_observations",
                                 "same_accepted_logical_observations", "both_invariants_passed"))
        for item in comparisons.values()))
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["parity"] else 1


if __name__ == "__main__":
    sys.exit(main())
