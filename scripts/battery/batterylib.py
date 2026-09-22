#!/usr/bin/env python3
"""Shared helpers for the parity battery: isolated per-side environments,
tmux frame capture, a JSONL daemon-wire client, and evidence-file helpers.

The battery drives the TS binary (ground truth) and the Rust binary side by
side against a deterministic mock provider (mock_provider.py). Nothing here
is part of the product.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

NL = chr(10)
# Environment keys set by this box's own prime-agent session/worker; they must
# never leak into spawned daemons, workers, or interactive sessions.
SCRUB_ENV_PREFIXES = ("PRIME_AGENT_INTERNAL", "RLM_")
SCRUB_ENV_KEYS = (
    "TMUX",
    "TMUX_PANE",
    "PRIME_AGENT_SESSION_DIR",
    "PRIME_AGENT_CODING_AGENT_DIR",
    "PRIME_AGENT_CODING_AGENT_SESSION_DIR",
    "PRIME_AGENT_KERNEL_OWNER_PID",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT",
)

TMUX_SIZE = (120, 36)


def scrubbed_env(agent_dir: Path, tmpdir: Path, extra: dict | None = None) -> dict:
    """A clean env: no worker/role markers, isolated agent dir + TMPDIR."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(SCRUB_ENV_PREFIXES) and k not in SCRUB_ENV_KEYS
    }
    env["PRIME_AGENT_CODING_AGENT_DIR"] = str(agent_dir)
    env["TMPDIR"] = str(tmpdir)
    if extra:
        env.update(extra)
    return env


def rust_binary_staleness(binary: Path, repo_root: Path) -> str | None:
    """Why a built Rust binary cannot include this checkout's current
    product code (`None` = fresh or unknown). A stale build reports false
    divergences against the TS ground truth (run 20260920: the
    compaction-abort harness "failed" on main only because the checkout's
    target/release binary predates the auto-compaction merge), so the
    harnesses fail fast instead of wasting a run. The binary's mtime must
    postdate the newest commit touching the product sources; set
    PA_BATTERY_ALLOW_STALE_RUST=1 to skip the guard (deliberate
    old-build testing).
    """
    if os.environ.get("PA_BATTERY_ALLOW_STALE_RUST") == "1":
        return None
    try:
        binary = Path(binary)
        if not binary.exists():
            return None  # a missing binary is the caller's own error
        out = subprocess.run(
            ["git", "log", "-1", "--format=%ct", "--", "crates", "prime-agent-runtime"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        if not out:
            return None
        newest_product_commit = int(out)
        built = binary.stat().st_mtime
        # One minute of slack: a build started at the commit's timestamp
        # still includes it.
        if built + 60 < newest_product_commit:
            age_min = int((newest_product_commit - built) / 60)
            return (
                f"{binary} predates the newest product commit in {repo_root} "
                f"(binary built ~{age_min} min before the newest crates/ or "
                "prime-agent-runtime/ change): a stale build reports false "
                "divergences. Rebuild (cargo build --release -p pa-cli) or "
                "point --rust-bin/PA_PARITY_RUST at a current build; set "
                "PA_BATTERY_ALLOW_STALE_RUST=1 to override."
            )
    except Exception:
        return None
    return None


def run_cmd(
    argv: list[str],
    env: dict,
    cwd: Path,
    timeout: float = 120.0,
    stdin_text: str | None = "",
) -> dict:
    """Run a command, returning a record with stdout/stderr/exit/duration."""
    start = time.time()
    try:
        proc = subprocess.run(
            argv,
            env=env,
            cwd=str(cwd),
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "argv": argv,
            "exit_code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "duration_s": round(time.time() - start, 2),
            "timeout": False,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "argv": argv,
            "exit_code": None,
            "stdout": exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
            "stderr": exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or ""),
            "duration_s": round(time.time() - start, 2),
            "timeout": True,
        }


class MockProvider:
    """One mock-provider process per side, so request logs never interleave."""

    def __init__(self, battery_dir: Path, port_offset_holder: list[int]):
        self.script_path = battery_dir / "mock-script.json"
        self.requests_path = Path(str(self.script_path) + ".requests.jsonl")
        for path in (self.script_path, self.requests_path):
            if path.exists():
                path.unlink()
        self.port = None
        self._holder = port_offset_holder
        self._proc = None

    def set_responses(self, responses: list[dict], queues: list[dict] | None = None) -> None:
        """Write the mock script. `responses` is the default queue; each
        entry of `queues` is a session-scoped queue ({"name", "match",
        "matchModels", "responses"}) served to requests whose model id
        (matchModels) or user-message text (match markers) selects it
        (mock_provider.py picks per request). An entry may also be a
        scripted provider failure: {"error": "<message>", "status": 400}."""
        script = {"responses": responses}
        if queues:
            script["queues"] = queues
        with open(self.script_path, "w") as f:
            json.dump(script, f)

    def start(self) -> int:
        here = Path(__file__).parent
        for _ in range(20):
            self._proc = subprocess.Popen(
                ["python3", str(here / "mock_provider.py"), str(self.script_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            line = self._proc.stdout.readline()
            try:
                self.port = int(line.strip())
                return self.port
            except ValueError:
                self._proc.kill()
                time.sleep(0.1)
        raise RuntimeError("mock provider failed to start")

    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def requests(self) -> list[dict]:
        if not self.requests_path.exists():
            return []
        out = []
        for line in self.requests_path.read_text().splitlines():
            if line.strip():
                out.append(json.loads(line))
        return out

    def stop(self) -> None:
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()


@dataclass
class Side:
    """One product side (ts or rust) with fully isolated state."""

    name: str
    binary: str
    root: Path  # evidence/<side>
    agent_dir: Path
    work_dir: Path
    daemon_socket: Path
    mock: MockProvider
    env: dict = field(default_factory=dict)
    daemon_proc: subprocess.Popen | None = None

    @property
    def base_url(self) -> str:
        return self.mock.url()

    def write_models_json(self) -> None:
        self.agent_dir.mkdir(parents=True, exist_ok=True)
        models = {
            "providers": {
                "prime-inference": {
                    "api": "openai-completions",
                    "baseUrl": self.base_url,
                    "apiKey": "sk-battery",
                    "models": [
                        {
                            "id": "mock-1",
                            "name": "Mock 1",
                            "api": "openai-completions",
                            "baseUrl": self.base_url,
                            "contextWindow": 128000,
                            "maxTokens": 4096,
                        }
                    ],
                }
            }
        }
        (self.agent_dir / "models.json").write_text(json.dumps(models, indent=1))

    # -- evidence helpers ---------------------------------------------------

    def evidence(self, flow: str, name: str, text: str) -> Path:
        path = self.root / flow / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def evidence_json(self, flow: str, name: str, obj) -> Path:
        path = self.root / flow / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(obj, indent=1, sort_keys=False))
        return path

    def sessions_dir(self) -> Path:
        return self.agent_dir / "sessions"

    def session_files(self) -> list[Path]:
        d = self.sessions_dir()
        if not d.exists():
            return []
        return sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)

    # -- daemon --------------------------------------------------------------

    def start_daemon(self, timeout: float = 30.0) -> None:
        """Start the daemon on this side's socket (identical argv both sides)."""
        log = self.root / "daemon.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "ab") as logfile:
            self.daemon_proc = subprocess.Popen(
                [self.binary, "--mode", "daemon", "--daemon-socket", str(self.daemon_socket)],
                env=self.env,
                cwd=str(self.work_dir),
                stdin=subprocess.DEVNULL,
                stdout=logfile,
                stderr=logfile,
            )
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.daemon_socket.exists():
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                        probe.connect(str(self.daemon_socket))
                        return
                except OSError:
                    pass
            if self.daemon_proc.poll() is not None:
                raise RuntimeError(
                    f"{self.name} daemon exited early: {log.read_text(errors='replace')[-2000:]}"
                )
            time.sleep(0.2)
        raise RuntimeError(f"{self.name} daemon socket never appeared")

    def stop_daemon(self) -> None:
        """Shut this side's daemon down and reap its whole tree (the
        shared `reap_daemons` sweep; see its docstring for the leak
        history). Only processes whose argv references this side's unique
        socket paths are touched, never unrelated daemons."""
        needles = [str(self.daemon_socket)]
        tmpdir = self.env.get("TMPDIR")
        if tmpdir:
            needles.append(tmpdir.rstrip("/"))
        reap_daemons(socket_paths=[self.daemon_socket], needles=needles, proc=self.daemon_proc)

    def own_daemon_pids(self) -> list[int]:
        """Daemon processes whose argv references this side's daemon
        socket or its TMPDIR (the supervisor's socket lives there)."""
        exclude = {self.daemon_proc.pid} if self.daemon_proc else set()
        needles = [str(self.daemon_socket)]
        tmpdir = self.env.get("TMPDIR")
        if tmpdir:
            needles.append(tmpdir.rstrip("/"))
        return daemon_pids_matching(needles, exclude_pids=exclude)


def daemon_pids_matching(needles, exclude_pids=()) -> list[int]:
    """Live `--mode daemon` processes whose argv references any of
    `needles` (daemon socket paths, isolated TMPDIR roots, or a harness
    sandbox root containing either). Empty-string needles are dropped: a
    bare "" would match every process."""
    seen: list[int] = []
    live_needles = [needle for needle in needles if needle]
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        pid = int(proc_dir.name)
        if pid in (1, os.getpid()) or pid in exclude_pids:
            continue
        try:
            argv = [
                part.decode(errors="replace")
                for part in (proc_dir / "cmdline").read_bytes().split(b"\0")
                if part
            ]
        except OSError:
            continue
        if "--mode" not in argv or "daemon" not in argv:
            continue
        if any(needle in part for part in argv for needle in live_needles):
            seen.append(pid)
    return seen


def worker_pids_under(cwd_roots=(), exclude_pids=()) -> list[int]:
    """Processes whose working directory sits under any of `cwd_roots`
    (normalized, trailing-separator-safe). The products' detached session
    workers run as `<binary> worker` with no sandbox path in their argv,
    but with the session's cwd (the side's work dir), so cwd is the only
    scope that reaches them."""
    roots = []
    for root in cwd_roots:
        if root:
            text = str(root).rstrip("/") + "/"
            roots.append(text)
    seen: list[int] = []
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        pid = int(proc_dir.name)
        if pid in (1, os.getpid()) or pid in exclude_pids:
            continue
        try:
            cwd = os.readlink(proc_dir / "cwd")
        except OSError:
            continue
        if any(cwd.startswith(root) for root in roots):
            seen.append(pid)
    return seen


def reap_daemons(socket_paths=(), needles=(), proc=None, cwd_roots=()) -> None:
    """Reap a harness's daemon tree (the #221 pattern, lifted so every
    standalone harness shares it).

    A bare terminate() leaks: the TS product runs a per-run supervisor
    (its own `--mode daemon` process on a socket under the side's TMPDIR)
    that RESPAWNS a killed main daemon, so SIGTERM alone leaves the pair
    behind (run 20260920: every wire-harness pass leaked two daemons; the
    #223 close-out: a standalone harness rmtree'd its tempdir and left a
    daemon spinning at 74% CPU on the deleted socket). The graceful `sd` wire
    shutdown (both products implement it) goes first for every
    `socket_paths` entry; `proc` (a directly spawned daemon) is then
    terminated; then the sweep kills every `--mode daemon` process whose
    argv references any of `needles` — a respawned main or a detached
    supervisor — and finally every process whose cwd sits under any of
    `cwd_roots` (the detached session workers: `<binary> worker` carries
    no sandbox path in its argv, only in its cwd). SIGTERM first,
    escalate to SIGKILL, re-check for a respawned main until the
    supervisor is gone."""
    for socket_path in socket_paths:
        try:
            wire = Wire(Path(socket_path))
            wire.send_command("sd", {"type": "shutdown"})
            wire.close()
            time.sleep(2)
        except Exception:
            pass
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    exclude = {proc.pid} if proc else set()
    for _ in range(3):
        pids = daemon_pids_matching(needles, exclude_pids=exclude)
        pids += worker_pids_under(cwd_roots, exclude_pids=exclude)
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, 15)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(1.0)
        for pid in daemon_pids_matching(needles, exclude_pids=exclude) + worker_pids_under(
            cwd_roots, exclude_pids=exclude
        ):
            try:
                os.kill(pid, 9)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(0.5)


class Wire:
    """JSONL daemon-protocol client (protocol 7, the TS wire format)."""

    def __init__(self, socket_path: Path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(90)
        self.sock.connect(str(socket_path))
        self.buf = b""
        self.events: list = []
        self.hello = self.read_line()

    def send_command(self, command_id: str, command: dict) -> None:
        envelope = {
            "type": "command",
            "id": command_id,
            "protocol": {"name": "prime-agent.daemon", "version": 7},
            "command": command,
        }
        self.sock.sendall((json.dumps(envelope) + chr(10)).encode())

    def read_line(self, timeout: float = 60.0) -> dict:
        """Read one JSON line; raises TimeoutError when nothing arrives."""
        deadline = time.time() + timeout
        while bytes([10]) not in self.buf:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError("daemon line timeout")
            self.sock.settimeout(max(0.1, remaining))
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("daemon closed the connection")
            self.buf += chunk
        line, self.buf = self.buf.split(bytes([10]), 1)
        return json.loads(line.decode())

    def request(self, command_id: str, command: dict, timeout: float = 60.0) -> dict:
        """Send a command; return the response carrying the matching id.

        Side events (non-matching lines) are recorded into `self.events`.
        """
        self.send_command(command_id, command)
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError(f"no response for command {command_id}")
            line = self.read_line(timeout=remaining)
            if line.get("id") == command_id:
                return line
            self.events.append(line)

    def drain(self, timeout: float = 3.0) -> list:
        """Read whatever the daemon sends for up to `timeout` seconds,
        buffering side events into `self.events`; returns the new events."""
        deadline = time.time() + timeout
        fresh = []
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return fresh
            try:
                line = self.read_line(timeout=remaining)
            except TimeoutError:
                return fresh
            fresh.append(line)
            self.events.append(line)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


# -- tmux ---------------------------------------------------------------------

def tmux(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run tmux on the default socket (never the agentui socket)."""
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    proc = subprocess.run(
        ["env", "-u", "TMUX", "-u", "TMUX_PANE", "tmux", *args],
        env=env,
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"tmux {args} failed: {proc.stderr}")
    return proc


def tmux_launch(
    session: str, command: list[str], env: dict, cwd: Path, size: tuple[int, int] = TMUX_SIZE
) -> None:
    """Create a detached session of `size` running `command` with `env`.

    tmux panes inherit the tmux server's environment, not the client's, so
    the pane command is wrapped in `env KEY=VALUE ...` (and TMUX unset) to
    guarantee isolation from the ambient agent session.

    The pane runs with `-c cwd` as its working directory, so a relative
    `command[0]` (e.g. `target/release/prime-agent` passed from the repo
    root) would resolve against the pane cwd and vanish instantly. Resolve
    the binary to an absolute path before it reaches the pane.
    """
    if command and not os.path.isabs(command[0]) and "/" in command[0]:
        resolved = Path(command[0]).resolve()
        if not resolved.exists():
            raise RuntimeError(f"tmux_launch: binary {command[0]} not found at {resolved}")
        command = [str(resolved), *command[1:]]
    # The pane inherits the tmux server env, so only the deltas (the scrubbed
    # overrides) need explicit assignment; everything else stays inherited.
    assignment = [
        f"{key}={value}"
        for key, value in sorted(env.items())
        if os.environ.get(key) != value or key in ("PRIME_AGENT_CODING_AGENT_DIR", "TMPDIR")
    ]
    unset = ["-u", "TMUX", "-u", "TMUX_PANE"]
    for key in SCRUB_ENV_KEYS:
        if key not in ("TMUX", "TMUX_PANE"):
            unset += ["-u", key]
    # The tmux server inherited this session's worker markers; unset every
    # one of them so pane processes never see daemon-worker identity.
    for key in list(os.environ):
        if key.startswith(SCRUB_ENV_PREFIXES):
            unset += ["-u", key]
    # tmux runs multi-argument pane commands through its default shell, so
    # wrap explicitly: sh -c 'exec env -u ... KEY=V ... <command>'.
    words = (
        ["exec", "/usr/bin/env"]
        + unset
        + assignment
        + list(command)
    )
    import shlex

    shell_command = " ".join(shlex.quote(w) for w in words)
    tmux(
        "new-session",
        "-d",
        "-x",
        str(size[0]),
        "-y",
        str(size[1]),
        "-s",
        session,
        "-c",
        str(cwd),
        "/bin/sh",
        "-c",
        shell_command,
    )


def tmux_resize(session: str, size: tuple[int, int]) -> None:
    """Resize a detached session's window (frame-parity captures at a
    second terminal size)."""
    tmux("resize-window", "-t", session, "-x", str(size[0]), "-y", str(size[1]), check=False)


def tmux_capture(session: str, pane: str = "0") -> str:
    return tmux("capture-pane", "-p", "-t", f"{session}:{pane}").stdout


def tmux_send(session: str, keys: str, enter: bool = True) -> None:
    tmux("send-keys", "-t", session, keys, "Enter" if enter else "")


def children_of(pid: int) -> list[int]:
    """Live child pids of `pid` (youngest last), by /proc traversal."""
    out = []
    for proc_dir in Path("/proc").iterdir():
        if not proc_dir.name.isdigit():
            continue
        try:
            stat = (proc_dir / "stat").read_text()
        except OSError:
            continue
        # The comm field can contain spaces/parens: split after the last ')'.
        rest = stat[stat.rfind(")") + 1 :].split()
        if len(rest) >= 2 and rest[1] == str(pid):
            out.append(int(proc_dir.name))
    return sorted(out)


def tmux_kill(session: str) -> None:
    tmux("kill-session", "-t", session, check=False)


def tmux_wait_text(session: str, pattern: str, timeout: float = 60.0, poll: float = 0.5) -> str:
    """Poll a pane until `pattern` appears; returns the final frame."""
    deadline = time.time() + timeout
    frame = ""
    while time.time() < deadline:
        frame = tmux_capture(session)
        if re.search(pattern, frame):
            return frame
        time.sleep(poll)
    return frame


# -- normalization + diff helpers ---------------------------------------------

def normalize(value, skip_keys=("timestamp", "id", "parentId", "sessionId", "socketPath", "pid")):
    """Recursively normalize volatile keys for cross-side comparisons."""

    def norm(v):
        if isinstance(v, dict):
            return {k: ("<norm>" if k in skip_keys else norm(val)) for k, val in v.items()}
        if isinstance(v, list):
            return [norm(x) for x in v]
        return v

    return norm(value)


def shape_of(value):
    """A structural fingerprint: dict keys / list shapes / type names."""

    def shp(v):
        if isinstance(v, dict):
            return {k: shp(val) for k, val in sorted(v.items())}
        if isinstance(v, list):
            return [shp(v[0])] if v else []
        return type(v).__name__

    return shp(value)


def copy_dir_contents(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def write_report(path: Path, title: str, sections: list[dict]) -> None:
    """Write the markdown gap report."""
    lines = [f"# {title}", ""]
    for section in sections:
        lines.append(f"## {section['title']}")
        lines.append("")
        for row in section.get("rows", []):
            lines.append(f"- {row}")
        lines.append("")
    path.write_text(NL.join(lines))
