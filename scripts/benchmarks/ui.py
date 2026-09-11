from __future__ import annotations

import hashlib
import json
import os
import pwd
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from schema import ProcessMemory, Request, Side
from terminal import Terminal

# Fixture shape: "many sessions, many large sessions" plus a deep subagent chain.
# Scale mirrors real long-lived installs: hundreds of saved sessions, one very
# large transcript, and a spawn ledger with enough edges to stress hydration.
MEDIUM_COUNT = 150
MEDIUM_MESSAGES = 120
LARGE_COUNT = 3
LARGE_MESSAGES = 2000
HUGE_MESSAGES = 16000
FANOUT_COUNT = 40
FANOUT_MESSAGES = 20
SUBAGENT_DEPTH = 6
SUBAGENT_MESSAGES = 400

BASE_TIMESTAMP_MS = 946684800000  # 2000-01-01T00:00:00Z; fixed so fixtures are deterministic
TOOL_OUTPUT_LINES = 60

AGENTS_VIEW_HINT = "type to search sessions"
SEARCH_PLACEHOLDER = "Search sessions"
ROSTER_COUNT = re.compile(r"agents\s+(\d+) running, (\d+) idle, (\d+) inactive")
READY_MARKER = "benchready"
LEFT_ARROW = "\x1b[D"
RIGHT_ARROW = "\x1b[C"
DOWN_ARROW = "\x1b[B"
EXPAND_ARROW = "\x1b[1;3C"
BACKSPACE = "\x7f"
ENTER = "\r"
FIXTURE_NAMESPACE = uuid.UUID("b0d5f4a1-6d64-4bf8-9d7a-2f4f0a9c1e10")


def session_id(kind: str, index: int) -> str:
    return str(uuid.uuid5(FIXTURE_NAMESPACE, f"prime-agent-ui-bench/{kind}/{index}"))


def session_name(kind: str, index: int) -> str:
    return f"ui-bench-{kind}-{index:02d}"


def tail_marker(kind: str, index: int) -> str:
    return f"ui-bench-tail-{kind}-{index:02d}"


@dataclass(frozen=True)
class FixtureSpec:
    """Session ids the probe addresses; every id is derived deterministically."""

    large: list[str]
    medium: list[str]
    root: str
    subagents: list[str]
    fanout: list[str]

    @property
    def resume_id(self) -> str:
        """Cold-resume target; never touched by the warm scenario."""
        return self.large[1]

    @property
    def switch_id(self) -> str:
        """Warm in-session /resume target; the very large transcript."""
        return self.large[2]

    @property
    def open_id(self) -> str:
        """Search-and-open target from the agents view."""
        return self.large[0]


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _session_lines(
    name: str,
    identifier: str,
    count: int,
    cwd: Path,
    *,
    depth: int,
    tail: str | None,
) -> list[dict]:
    """One deterministic session transcript: header, name, model, then a realistic message mix."""
    timestamp = BASE_TIMESTAMP_MS
    parent: str | None = None
    lines: list[dict] = []
    prefix = identifier.replace("-", "")[:8]

    def link(entry_id: str) -> dict:
        nonlocal parent, timestamp
        timestamp += 1000
        entry = {"id": entry_id, "parentId": parent, "timestamp": _iso(timestamp)}
        parent = entry_id
        return entry

    lines.append(
        {
            "type": "session",
            "version": 3,
            "id": identifier,
            "timestamp": _iso(timestamp),
            "cwd": str(cwd),
            "rlmDepth": depth,
        }
    )
    entry = link(f"{prefix}n")
    entry.update({"type": "session_info", "name": name})
    lines.append(entry)
    entry = link(f"{prefix}m")
    entry.update({"type": "model_change", "provider": "prime-inference", "modelId": "internal/glm-5.3-fast"})
    lines.append(entry)
    usage = {
        "input": 100,
        "output": 50,
        "cacheRead": 0,
        "cacheWrite": 0,
        "totalTokens": 150,
        "cost": {"input": 0.0001, "output": 0.0001, "cacheRead": 0, "cacheWrite": 0, "total": 0.0002},
    }
    for index in range(count):
        final = index == count - 1
        entry = link(f"{prefix}u{index}")
        entry.update(
            {
                "type": "message",
                "message": {
                    "role": "user",
                    "timestamp": 0,
                    "content": (
                        f"Please continue task {name} step {index}: review the module, run the checks, "
                        "and summarize findings for the migration notes."
                    ),
                },
            }
        )
        lines.append(entry)
        text = (
            f"Working on {name} step {index}. The parser handles nested records correctly; the next edit "
            "keeps the schema stable while trimming the duplicated branch."
        )
        if final and tail:
            text = f"Finished all steps. {tail}"
        content = [
            {
                "type": "thinking",
                "thinking": (
                    f"Step {index} for {name}: check the invariants, then update the affected call "
                    "sites before running the full suite again to confirm no behavior changed."
                ),
            },
            {"type": "text", "text": text},
        ]
        if not final:
            content.append(
                {"type": "toolCall", "id": f"call-{index}", "name": "ipython", "arguments": {"code": "pass"}}
            )
        entry = link(f"{prefix}a{index}")
        entry.update(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "timestamp": 0,
                    "content": content,
                    "api": "responses",
                    "provider": "prime-inference",
                    "model": "internal/glm-5.3-fast",
                    "usage": usage,
                    "stopReason": "stop" if final else "toolUse",
                },
            }
        )
        lines.append(entry)
        if not final:
            entry = link(f"{prefix}t{index}")
            entry.update(
                {
                    "type": "message",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": f"call-{index}",
                        "toolName": "ipython",
                        "content": [{"type": "text", "text": "all checks passed\n" * TOOL_OUTPUT_LINES}],
                        "isError": False,
                        "timestamp": 0,
                    },
                }
            )
            lines.append(entry)
    return lines


def spawn_ledger_path(agent_dir: Path, sessions_dir: Path) -> Path:
    canonical = Path(os.path.realpath(sessions_dir))
    digest = hashlib.sha256(str(canonical).encode()).hexdigest()[:16]
    return agent_dir / "rlm-ledger" / f"{digest}.jsonl"


def write_fixtures(agent_dir: Path, workspace: Path, spec: FixtureSpec, *, uid: int | None = None) -> None:
    """Regenerate every session file and the spawn ledger from scratch for one trial.

    The harness runs as root; pass the benchmark user's ids so the spawned CLI can
    read and append its own sessions.
    """
    sessions_dir = agent_dir / "sessions"
    for directory in (sessions_dir, agent_dir / "session-artifacts", agent_dir / "session-leases"):
        shutil.rmtree(directory, ignore_errors=True)
    sessions_dir.mkdir(parents=True, exist_ok=True)

    def write(identifier: str, name: str, count: int, *, depth: int = 0, tail: str | None = None) -> Path:
        path = sessions_dir / f"{identifier}.jsonl"
        path.write_text(
            "".join(
                json.dumps(line, separators=(",", ":")) + "\n"
                for line in _session_lines(name, identifier, count, workspace, depth=depth, tail=tail)
            )
        )
        return path

    for index in range(1, LARGE_COUNT + 1):
        identifier = spec.large[index - 1]
        messages = HUGE_MESSAGES if index == 3 else LARGE_MESSAGES
        write(identifier, session_name("large", index), messages, tail=tail_marker("large", index))
    for index in range(1, MEDIUM_COUNT + 1):
        identifier = spec.medium[index - 1]
        write(identifier, session_name("medium", index), MEDIUM_MESSAGES)
    parent = write(spec.root, session_name("root", 0), SUBAGENT_MESSAGES, tail=tail_marker("root", 0))
    edges = []
    for fanout in range(1, FANOUT_COUNT + 1):
        identifier = spec.fanout[fanout - 1]
        path = write(identifier, session_name("fan", fanout), FANOUT_MESSAGES, depth=1)
        edges.append(
            {
                "childId": identifier,
                "parent": str(parent),
                "child": str(path),
                "depth": 1,
                "name": session_name("fan", fanout),
            }
        )
    for depth in range(1, SUBAGENT_DEPTH + 1):
        identifier = spec.subagents[depth - 1]
        path = write(
            identifier,
            session_name("sub", depth),
            SUBAGENT_MESSAGES,
            depth=depth,
            tail=tail_marker("sub", depth),
        )
        edges.append(
            {
                "childId": identifier,
                "parent": str(parent),
                "child": str(path),
                "depth": depth,
                "name": session_name("sub", depth),
            }
        )
        parent = path
    ledger = spawn_ledger_path(agent_dir, sessions_dir)
    ledger.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "v": 1,
            "op": "meta",
            "at": _iso(BASE_TIMESTAMP_MS),
            "sessionsDir": str(Path(os.path.realpath(sessions_dir))),
        }
    ]
    records.extend(
        {"v": 1, "op": "spawn", "at": _iso(BASE_TIMESTAMP_MS + edge["depth"]), **edge} for edge in edges
    )
    ledger.write_text("".join(json.dumps(record, separators=(",", ":")) + "\n" for record in records))
    if uid is not None:
        gid = pwd.getpwuid(uid).pw_gid
        os.chown(agent_dir, uid, gid)
        for path in agent_dir.rglob("*"):
            os.chown(path, uid, gid)


def fixture_spec() -> FixtureSpec:
    return FixtureSpec(
        large=[session_id("large", index) for index in range(1, LARGE_COUNT + 1)],
        medium=[session_id("medium", index) for index in range(1, MEDIUM_COUNT + 1)],
        root=session_id("root", 0),
        subagents=[session_id("sub", depth) for depth in range(1, SUBAGENT_DEPTH + 1)],
        fanout=[session_id("fan", index) for index in range(1, FANOUT_COUNT + 1)],
    )


def process_stats(uid: int) -> list[ProcessMemory]:
    """Snapshot every live process of one user with RSS, PSS, and cumulative CPU time."""
    stats: list[ProcessMemory] = []
    try:
        clock_ticks = os.sysconf("SC_CLK_TCK")
    except (ValueError, AttributeError, OSError):
        return stats
    for status_path in Path("/proc").glob("[0-9]*/status"):
        try:
            fields = dict(line.split(":", 1) for line in status_path.read_text().splitlines() if ":" in line)
            if int(fields["Uid"].split()[0]) != uid or fields["State"].strip().startswith("Z"):
                continue
            stat_fields = (status_path.parent / "stat").read_text().rsplit(")", 1)[1].split()
            cpu_seconds = (int(stat_fields[11]) + int(stat_fields[12])) / clock_ticks
            pss = None
            try:
                for line in (status_path.parent / "smaps_rollup").read_text().splitlines():
                    if line.startswith("Pss:"):
                        pss = int(line.split()[1]) * 1024
            except (PermissionError, FileNotFoundError, ProcessLookupError):
                pass
            stats.append(
                ProcessMemory(
                    pid=int(status_path.parent.name),
                    name=fields["Name"].strip(),
                    rss=int(fields.get("VmRSS", "0").split()[0]) * 1024,
                    pss=pss,
                    cpu=cpu_seconds,
                )
            )
        except (PermissionError, FileNotFoundError, ProcessLookupError, ValueError, IndexError):
            continue
    return stats


def total_cpu(stats: list[ProcessMemory]) -> float:
    return sum(process.cpu or 0.0 for process in stats)


def quiet(terminal: Terminal, seconds: float = 0.6, cap: float = 8.0) -> None:
    """Pump output until the terminal stays silent, so the editor can accept input again."""
    started = time.perf_counter()
    last_output = time.perf_counter()
    while time.perf_counter() - started < cap:
        if terminal.pump():
            last_output = time.perf_counter()
        elif time.perf_counter() - last_output >= seconds:
            return


def input_ready(terminal: Terminal, marker: str, *, timeout: float = 120) -> None:
    """Wait for a rendered marker, then confirm the editor echoes, retrying past input loss.

    Keystrokes sent while a freshly opened session is still mounting can be dropped,
    so the echo is retried with a quiet window instead of failing the trial.
    """
    terminal.until(lambda display: marker in display.text(), timeout)
    for _ in range(5):
        quiet(terminal, 0.8)
        terminal.child.send(READY_MARKER)
        try:
            terminal.until(lambda display: READY_MARKER in display.text(), 6)
        except TimeoutError:
            terminal.child.send(BACKSPACE * (len(READY_MARKER) + 2))
            continue
        terminal.child.send(BACKSPACE * len(READY_MARKER))
        terminal.until(lambda display: READY_MARKER not in display.text(), 10)
        return
    raise TimeoutError("Editor did not echo the readiness marker")


def clear_search(terminal: Terminal, *, attempts: int = 5) -> None:
    """Empty the agents-view search box; keystrokes can be eaten by re-entry renders."""
    for _ in range(attempts):
        terminal.child.send(BACKSPACE * 24)
        try:
            terminal.until(lambda display: SEARCH_PLACEHOLDER in display.text(), 5)
            return
        except TimeoutError:
            continue
    raise TimeoutError("Agents-view search box did not clear")


def type_query(terminal: Terminal, query: str, *, attempts: int = 3) -> None:
    """Type a search query and verify it echoed before filtering on it."""
    for _ in range(attempts):
        clear_search(terminal)
        terminal.child.send(query)
        try:
            terminal.until(lambda display: query in display.text(), 8)
            return
        except TimeoutError:
            continue
    raise TimeoutError("Agents-view search query did not echo")


def expand_subagents(terminal: Terminal, *, attempts: int = 4) -> None:
    """Expand the selected row's subagent list; the toggle retries to survive eaten keystrokes."""
    expanded = terminal.display.text().count("▾")
    for _ in range(attempts):
        terminal.child.send(EXPAND_ARROW)
        terminal.settle(1.0)
        if terminal.display.text().count("▾") > expanded:
            return
    raise TimeoutError("Selected agent subagents did not expand")


def roster_inactive(display) -> int | None:  # type: ignore[no-untyped-def]
    for line in display.text().splitlines():
        match = ROSTER_COUNT.search(line)
        if match:
            return int(match.group(3))
    return None


def wait_for_roster(terminal: Terminal, *, settle: float = 3.0, timeout: float = 90) -> float:
    """Wait until the agents-view roster stops growing; saved sessions stream in."""
    started = time.perf_counter()
    last_count: int | None = None
    last_change = time.perf_counter()
    while time.perf_counter() - started < timeout:
        terminal.settle(0.4)
        count = roster_inactive(terminal.display)
        if count is not None and count == last_count and time.perf_counter() - last_change >= settle:
            return time.perf_counter() - started
        if count != last_count:
            last_count = count
            last_change = time.perf_counter()
    raise TimeoutError("Agents-view roster did not settle")


def ui_measure(request: Request, side: Side, trial: int, *, results: Path, homes: Path, user: str) -> None:
    """One UI-interaction trial: fresh fixtures, a cold resume, then the warm navigation scenario."""
    from worker import clean_error, environment, record, stop_processes

    home = homes / user
    workspace = home / "workspace"
    agent_dir = home / ".prime/agent"
    uid = pwd.getpwnam(user).pw_uid
    spec = fixture_spec()
    details: dict[str, dict] = {}
    metric = "resume_large"

    def note(name: str, *, seconds: float, cpu: float, pty_bytes: int) -> None:
        details[name] = {"seconds": round(seconds, 4), "cpu": round(cpu, 4), "pty_bytes": pty_bytes}

    def cpu_total() -> float:
        return total_cpu(process_stats(uid))

    stop_processes(user)
    write_fixtures(agent_dir, workspace, spec, uid=uid)
    env = environment(user)
    runuser = "/usr/sbin/runuser"
    try:
        # Cold resume of a large session from the CLI, from process spawn to usable editor.
        cpu_start = cpu_total()
        terminal = Terminal(
            [runuser, "-u", user, "--", "prime-agent", "--resume", spec.resume_id],
            workspace,
            env,
            results / f"ui-resume-{trial}",
        )
        try:
            metric = "resume_large"
            bytes_start = terminal.bytes
            input_ready(terminal, tail_marker("large", 2))
            elapsed = time.perf_counter() - terminal.started
            cpu = cpu_total() - cpu_start
            record(side, "resume_large", trial, elapsed)  # type: ignore[arg-type]
            record(side, "resume_large_cpu", trial, cpu)  # type: ignore[arg-type]
            note("resume_large", seconds=elapsed, cpu=cpu, pty_bytes=terminal.bytes - bytes_start)
        finally:
            terminal.close()
        stop_processes(user)

        # Warm navigation scenario in a single TUI process.
        metric = "switch_large"
        terminal = Terminal(
            [runuser, "-u", user, "--", "prime-agent"], workspace, env, results / f"ui-scenario-{trial}"
        )
        try:
            terminal.ready()

            # Warm switch into a different large session from the running editor.
            started = time.perf_counter()
            cpu_start = cpu_total()
            bytes_start = terminal.bytes
            terminal.child.send(f"/resume {spec.switch_id}{ENTER}")
            input_ready(terminal, tail_marker("large", 3))
            elapsed = time.perf_counter() - started
            cpu = cpu_total() - cpu_start
            record(side, "switch_large", trial, elapsed)  # type: ignore[arg-type]
            record(side, "switch_large_cpu", trial, cpu)  # type: ignore[arg-type]
            note("switch_large", seconds=elapsed, cpu=cpu, pty_bytes=terminal.bytes - bytes_start)

            # Session -> agents view: keystroke to rendered roster splash.
            metric = "agents_view"
            started = time.perf_counter()
            cpu_start = cpu_total()
            bytes_start = terminal.bytes
            terminal.child.send(LEFT_ARROW)
            terminal.until(lambda display: AGENTS_VIEW_HINT in display.text(), 60)
            elapsed = time.perf_counter() - started
            cpu = cpu_total() - cpu_start
            record(side, "agents_view", trial, elapsed)  # type: ignore[arg-type]
            record(side, "agents_view_cpu", trial, cpu)  # type: ignore[arg-type]
            note("agents_view", seconds=elapsed, cpu=cpu, pty_bytes=terminal.bytes - bytes_start)

            # Full roster with many sessions: saved sessions and ledger children stream in.
            metric = "agents_roster"
            cpu_start = cpu_total()
            bytes_start = terminal.bytes
            roster_seconds = wait_for_roster(terminal)
            cpu = cpu_total() - cpu_start
            record(side, "agents_roster", trial, roster_seconds)  # type: ignore[arg-type]
            record(side, "agents_roster_cpu", trial, cpu)  # type: ignore[arg-type]
            note("agents_roster", seconds=roster_seconds, cpu=cpu, pty_bytes=terminal.bytes - bytes_start)

            # Agents view -> another large session, found by its unique id prefix.
            metric = "agents_open"
            started = time.perf_counter()
            cpu_start = cpu_total()
            bytes_start = terminal.bytes
            type_query(terminal, spec.open_id[:8])
            terminal.until(lambda display: session_name("large", 1) in display.text(), 60)
            terminal.settle(0.8)
            terminal.child.send(RIGHT_ARROW)
            input_ready(terminal, tail_marker("large", 1))
            elapsed = time.perf_counter() - started
            cpu = cpu_total() - cpu_start
            record(side, "agents_open", trial, elapsed)  # type: ignore[arg-type]
            record(side, "agents_open_cpu", trial, cpu)  # type: ignore[arg-type]
            note("agents_open", seconds=elapsed, cpu=cpu, pty_bytes=terminal.bytes - bytes_start)

            # Chain parent: open the root so the deepest subagent opens against a live parent.
            metric = "parent_open"
            started = time.perf_counter()
            cpu_start = cpu_total()
            bytes_start = terminal.bytes
            terminal.child.send(LEFT_ARROW)
            terminal.until(lambda display: AGENTS_VIEW_HINT in display.text(), 60)
            terminal.settle(1.0)
            type_query(terminal, spec.root[:8])
            terminal.until(lambda display: session_name("root", 0) in display.text(), 60)
            terminal.settle(0.5)
            terminal.child.send(RIGHT_ARROW)
            input_ready(terminal, tail_marker("root", 0))
            elapsed = time.perf_counter() - started
            cpu = cpu_total() - cpu_start
            record(side, "parent_open", trial, elapsed)  # type: ignore[arg-type]
            record(side, "parent_open_cpu", trial, cpu)  # type: ignore[arg-type]
            note("parent_open", seconds=elapsed, cpu=cpu, pty_bytes=terminal.bytes - bytes_start)

            # Deepest subagent session: search, drill in, open at depth SUBAGENT_DEPTH
            # while its parent session is live, matching real subagent workflows.
            metric = "subagent_open"
            started = time.perf_counter()
            cpu_start = cpu_total()
            bytes_start = terminal.bytes
            terminal.child.send(LEFT_ARROW)
            terminal.until(lambda display: AGENTS_VIEW_HINT in display.text(), 60)
            terminal.settle(1.0)
            query = spec.subagents[-1][:8]
            type_query(terminal, query)
            terminal.until(lambda display: session_name("root", 0) in display.text(), 60)
            clear_search(terminal)
            expand_subagents(terminal)
            # The search box must be empty to expand; refilter to the chain so the
            # first fan-out sibling cannot steal the down-arrow, then drill a level
            # at a time until the deepest subagent row is selected.
            type_query(terminal, query)
            terminal.settle(0.5)
            terminal.child.send(DOWN_ARROW)
            terminal.settle(0.8)
            for _ in range(SUBAGENT_DEPTH - 1):
                clear_search(terminal)
                expand_subagents(terminal)
                terminal.settle(0.8)
                terminal.child.send(DOWN_ARROW)
                terminal.settle(0.8)
            terminal.child.send(RIGHT_ARROW)
            input_ready(terminal, tail_marker("sub", SUBAGENT_DEPTH))
            elapsed = time.perf_counter() - started
            cpu = cpu_total() - cpu_start
            record(side, "subagent_open", trial, elapsed)  # type: ignore[arg-type]
            record(side, "subagent_open_cpu", trial, cpu)  # type: ignore[arg-type]
            note("subagent_open", seconds=elapsed, cpu=cpu, pty_bytes=terminal.bytes - bytes_start)

            # Whole-tree memory after the interactions.
            metric = "ui_rss"
            terminal.settle(1)
            processes = process_stats(uid)
            if not processes:
                raise RuntimeError("No owned processes found for the UI memory measurement")
            record(side, "ui_rss", trial, sum(process.rss for process in processes))  # type: ignore[arg-type]
            side.processes = processes
            (results / f"ui-memory-{trial}.json").write_text(
                json.dumps([process.model_dump() for process in processes], indent=2) + "\n"
            )
        finally:
            terminal.close()
    except Exception as error:
        record(side, metric, trial, error=clean_error(error))  # type: ignore[arg-type]
    finally:
        stop_processes(user)
        (results / f"ui-{trial}.json").write_text(json.dumps(details, indent=2, sort_keys=True) + "\n")
