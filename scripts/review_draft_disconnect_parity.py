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


class Supervisor:
    def __init__(self, path, hello, scenario, root):
        self.path, self.hello, self.scenario, self.root = path, hello, scenario, root
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(path)); self.listener.listen(); self.listener.settimeout(0.2)
        self.done = threading.Event()
        self.lock = threading.Lock()
        self.sockets, self.threads, self.errors = [], [], []
        self.commands, self.prompts = [], []
        self.attaches = 0
        self.closed = False
        self.rebound = False
        self.post_close_attached = False
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def send(self, sock, data):
        sock.sendall((json.dumps(data) + "\n").encode())

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
        hello = dict(self.hello, serverCapabilities=[], clientId="draft-fixture")
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
                    with self.lock:
                        self.commands.append(command)
                    active = "s2" if self.rebound else "s1"
                    response = {"type": "response", "id": request_id, "command": name,
                                "success": True, "data": {}}
                    if name == "create":
                        response["data"] = {"activeSessionId": active, "id": active,
                            "sessionId": "fixture-durable", "sessionFile": str(self.root / "agent/sessions/fixture.jsonl")}
                    elif name == "attach":
                        state = {"activeSessionId": active, "cwd": str(self.root),
                                 "sessionId": "fixture-durable", "sessionName": "Draft fixture",
                                 "model": None, "isStreaming": False, "isCompacting": False,
                                 "sessionActions": {"queuedCount": 0, "steering": [], "followUps": []}}
                        response["data"] = {"protocol": hello["protocol"], "activeSessionId": active,
                            "snapshot": {"activeSessionId": active, "summary": {"id": active, "cwd": str(self.root)},
                                         "state": state, "messages": [], "lastEventSequence": 0, "lastEventCursor": None},
                            "client": {"id": "draft-fixture", "capabilities": []},
                            "lastEventSequence": 0, "lastEventCursor": None}
                        with self.lock:
                            self.attaches += 1
                            if self.closed: self.post_close_attached = True
                    elif name == "prompt":
                        with self.lock:
                            self.prompts.append(command)
                            first = len(self.prompts) == 1
                        if first and self.scenario == "refusal":
                            response.update(success=False, error=REFUSAL)
                        elif first and self.scenario == "rebind_close":
                            self.rebound = True
                            self.send(sock, {"type": "session_binding", "previousActiveSessionId": "s1", "activeSessionId": "s2"})
                            continue
                        elif first and self.scenario == "queued_close":
                            self.closed = True
                            return  # Accepted by the fixture; intentionally no response/ACK.
                        # Successful probes settle without producing transcript content.
                    elif name == "detach" and self.scenario == "rebind_close" and self.rebound and not self.closed:
                        self.closed = True
                        return  # The attach already adopted s2 before it requested detach(s1).
                    elif name == "list": response["data"] = {"sessions": []}
                    elif name == "heartbeats_list": response["data"] = {"heartbeats": []}
                    elif name == "roster_subscribe": response["data"] = {"changed": [], "removed": [], "resync": True}
                    elif name == "get_model_catalog": response["data"] = {"models": [], "configuredProviders": []}
                    elif name == "get_commands": response["data"] = {"commands": []}
                    elif name == "list_kernel_bash": response["data"] = {"commands": []}
                    elif name == "factory_activity": response["data"] = {"activity": [], "jobs": []}
                    elif name in ("get_state", "get_session_stats", "get_connection_state", "get_mcp_connections", "detach"):
                        response["data"] = {"isStreaming": False, "isCompacting": False,
                                            "sessionActions": {"queuedCount": 0, "steering": [], "followUps": []}}
                    else:
                        self.errors.append(f"unexpected command: {name}")
                        response.update(success=False, error=f"Unsupported fixture command: {name}")
                    self.send(sock, response)
                    if name == "prompt" and response["success"]:
                        # A visible synthetic assistant turn proves the ACK/events were handled
                        # before typing the transport probe. No real provider is called.
                        marker = f"FIXTURE_SETTLED_{len(self.prompts)}"
                        message = {"role": "assistant", "stopReason": "stop",
                                   "content": [{"type": "text", "text": marker}]}
                        for event in ({"type": "turn_start"},
                                      {"type": "message_start", "message": message},
                                      {"type": "message_end", "message": message},
                                      {"type": "turn_end"}):
                            self.send(sock, {"type": "session_event", "activeSessionId": active, "event": event})
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
                          and "daemon reconnected" in terminal.screen.text().lower(), server)
        result["screens"]["before_resubmit"] = terminal.screen.text()
        before = len(server.prompts)
        terminal.send("\r")
        if name == "refusal":
            terminal.wait("resubmitted refusal visibly settled", lambda:
                          "FIXTURE_SETTLED_2" in terminal.screen.text(), server)
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
                      f"FIXTURE_SETTLED_{probe_index}" in terminal.screen.text(), server)
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
        result.update(wire_commands=server.commands, prompts=messages,
                      expected_prompts=expected, fixture_errors=server.errors,
                      draft_restored=name == "refusal" and messages == expected,
                      draft_consumed=name != "refusal" and messages == expected,
                      invariant_passed=bool(result["executed"] and messages == expected
                                           and not server.errors and not result.get("cleanup_errors")))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    receipt = {"fixture": "pr3401-draft-disconnect", "results": {},
               "comparison_scope": "Targeted prompt-dispatch/draft behavior only; raw terminals, decoded screens and commands are retained but full frame/wire equivalence is not asserted.",
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
        comparisons[name] = {"both_executed": all(x.get("executed") for x in sides),
                             "same_prompt_observations": bool(all(x.get("executed") for x in sides)
                                 and sides[0].get("prompts") == sides[1].get("prompts")),
                             "both_invariants_passed": all(x.get("invariant_passed") for x in sides)}
    receipt["comparisons"] = comparisons
    receipt["parity"] = bool("preflight_error" not in receipt and all(
        all(item.values()) for item in comparisons.values()))
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["parity"] else 1


if __name__ == "__main__":
    sys.exit(main())
