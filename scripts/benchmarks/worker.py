from __future__ import annotations

import argparse
import json
import os
import pwd
import signal
import subprocess
import time
from pathlib import Path

from schema import (
    ANSWER,
    PROMPT,
    ROOT,
    InferenceUsage,
    Metric,
    Observation,
    Price,
    ProcessMemory,
    Request,
    Result,
    Side,
    finite_number,
    write_json,
)
from terminal import Terminal

HOMES = Path("/home")
SOURCE = HOMES / "builder/source"
RESULTS = ROOT / "results"
VERSION = "0.0.0-benchmark"
ORIGIN = "http://127.0.0.1:18741"
SECRET = os.environ.get("PRIME_API_KEY", "")


def clean_error(error: Exception) -> str:
    text = f"{type(error).__name__}: {error}"
    return (text.replace(SECRET, "[REDACTED]") if SECRET else text)[:500]


def environment(user: str, inference: bool = False) -> dict[str, str]:
    home = str(HOMES / user)
    env = {
        "HOME": home,
        "USER": user,
        "LOGNAME": user,
        "SHELL": "/bin/bash",
        "PATH": f"{home}/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "C.UTF-8",
        "NPM_CONFIG_PREFIX": f"{home}/.local",
        "NPM_CONFIG_CACHE": f"{home}/.npm",
        "UV_CACHE_DIR": f"{home}/.cache/uv",
        "UV_LINK_MODE": "copy",
    }
    if inference:
        env["PRIME_API_KEY"] = SECRET
        if os.environ.get("PRIME_TEAM_ID"):
            env["PRIME_TEAM_ID"] = os.environ["PRIME_TEAM_ID"]
    return env


def run_as(
    user: str,
    args: list[str],
    cwd: Path,
    *,
    timeout: int = 60,
    log: Path | None = None,
    inference: bool = False,
    extra_env: dict[str, str] | None = None,
    merge_output: bool = False,
) -> str:
    env = environment(user, inference) | (extra_env or {})
    command = ["/usr/sbin/runuser", "-u", user, "--", *args]
    if log:
        with log.open("a") as stream:
            subprocess.run(
                command,
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=stream,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=timeout,
            )
        return ""
    return subprocess.check_output(
        command,
        cwd=cwd,
        env=env,
        stderr=subprocess.STDOUT if merge_output else subprocess.PIPE,
        text=True,
        timeout=timeout,
    )


def stop_processes(user: str) -> None:
    uid = pwd.getpwnam(user).pw_uid
    for sig, delay in ((signal.SIGTERM, 3), (signal.SIGKILL, 2)):
        for process in memory(uid):
            try:
                os.kill(process.pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            if not memory(uid):
                return
            time.sleep(0.05)
    if memory(uid):
        raise RuntimeError(f"Processes remain for {user}")


def memory(uid: int) -> list[ProcessMemory]:
    processes = []
    for path in Path("/proc").glob("[0-9]*/status"):
        try:
            fields = dict(line.split(":", 1) for line in path.read_text().splitlines() if ":" in line)
            if int(fields["Uid"].split()[0]) != uid or fields["State"].strip().startswith("Z"):
                continue
            pss = None
            try:
                for line in (path.parent / "smaps_rollup").read_text().splitlines():
                    if line.startswith("Pss:"):
                        pss = int(line.split()[1]) * 1024
            except (PermissionError, FileNotFoundError, ProcessLookupError):
                pass
            processes.append(
                ProcessMemory(
                    pid=int(path.parent.name),
                    name=fields["Name"].strip(),
                    rss=int(fields.get("VmRSS", "0").split()[0]) * 1024,
                    pss=pss,
                )
            )
        except (PermissionError, FileNotFoundError, ProcessLookupError):
            continue
    return processes


def prepare(request: Request, side: Side) -> None:
    log = RESULTS / "build.log"
    source_url = f"https://github.com/{request.source_repository}.git"
    SOURCE.mkdir(parents=True, exist_ok=True)
    builder = pwd.getpwnam("builder")
    os.chown(SOURCE, builder.pw_uid, builder.pw_gid)
    for args in (
        ["git", "init", "--quiet"],
        ["git", "fetch", "--depth=1", source_url, request.sha],
        ["git", "checkout", "--detach", "FETCH_HEAD"],
        ["npm", "ci", "--no-audit", "--no-fund"],
    ):
        run_as("builder", args, SOURCE, timeout=600, log=log)
    actual = run_as("builder", ["git", "rev-parse", "HEAD"], SOURCE).strip()
    if actual != request.sha:
        raise RuntimeError("Checkout did not resolve to the requested commit")
    for package in ("tui", "ai", "agent", "coding-agent"):
        run_as(
            "builder",
            [str(SOURCE / "node_modules/.bin/tsgo"), "-p", "tsconfig.build.json"],
            SOURCE / "packages" / package,
            timeout=180,
            log=log,
        )
    agent = SOURCE / "packages/coding-agent"
    run_as("builder", ["chmod", "+x", "dist/cli.js"], agent)
    for script in ("copy-assets", "bundle"):
        run_as("builder", ["npm", "run", script], agent, timeout=180, log=log)
    run_as(
        "builder",
        [
            "node",
            "scripts/pack-prime-agent-release.mjs",
            "--base-url",
            ORIGIN,
            "--version",
            VERSION,
            "--out-dir",
            "packages/coding-agent/release/benchmark",
        ],
        SOURCE,
        timeout=180,
        log=log,
    )
    artifacts = agent / "release/benchmark/artifacts"
    side.artifacts = {path.name: path.stat().st_size for path in sorted(artifacts.glob("*.tgz"))}
    if len(side.artifacts) != 4:
        raise RuntimeError("Expected the four release package tarballs")
    record(side, "bundle", 0, sum(side.artifacts.values()))
    release = ROOT / "www/releases" / f"v{VERSION}"
    release.parent.mkdir(parents=True, exist_ok=True)
    release.symlink_to(artifacts)
    for name in ("node", "npm"):
        side.runtime[name] = run_as("builder", [name, "--version"], SOURCE).strip()
    side.runtime["kernel"] = os.uname().release
    side.runtime["machine"] = os.uname().machine
    side.runtime["artifact_format"] = "npm-tarballs"
    cpu = Path("/proc/cpuinfo").read_text()
    side.runtime["cpu"] = next(
        (line.partition(":")[2].strip() for line in cpu.splitlines() if line.startswith("model name")),
        "unavailable",
    )
    if side.runtime["machine"] != "x86_64":
        raise RuntimeError("Benchmark requires Linux x64")


def disk_bytes(home: Path) -> int:
    output = subprocess.check_output(
        [
            "du",
            "--apparent-size",
            "--summarize",
            "--block-size=1",
            "--exclude=.cache",
            "--exclude=.npm",
            "--exclude=*.log",
            "--exclude=sessions",
            "--exclude=session-artifacts",
            "--exclude=workspace",
            str(home),
        ],
        text=True,
    )
    return int(output.split()[0])


def install(request: Request, side: Side, trial: int) -> None:
    user = f"benchmark{trial + 1}"
    subprocess.run(
        ["useradd", "--create-home", "--uid", str(2001 + trial), "--shell", "/bin/bash", user], check=True
    )
    home = HOMES / user
    before = disk_bytes(home)
    started = time.perf_counter()
    try:
        run_as(
            user,
            ["sh", str(SOURCE / "install.sh"), VERSION],
            home,
            timeout=240,
            log=RESULTS / f"install-{trial}.log",
            extra_env={
                "PRIME_AGENT_DOWNLOAD_BASE_URL": ORIGIN,
                "PRIME_AGENT_INSTALLER_PLAIN": "1",
                "PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL": "1",
                "PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL": "1",
                "PRIME_AGENT_INSTALL_UV": "1",
            },
        )
        elapsed = time.perf_counter() - started
        version = run_as(user, ["prime-agent", "--version"], home, merge_output=True).strip()
        if VERSION not in version:
            raise RuntimeError(f"Installed version does not match the packed release: {version[:100]}")
        if not (home / ".prime/agent/kernel-venv/bin/python").exists():
            raise RuntimeError("The installer's Python bootstrap did not complete")
        record(side, "install", trial, elapsed)
        if trial == 0:
            side.runtime["home_before_install_bytes"] = str(before)
            config = home / ".prime/agent"
            config.mkdir(parents=True, exist_ok=True)
            models = {
                "providers": {
                    "prime-inference": {
                        "modelOverrides": {
                            request.model: {"maxTokens": request.config.max_output_tokens},
                        }
                    }
                }
            }
            path = config / "models.json"
            path.write_text(json.dumps(models))
            info = pwd.getpwnam(user)
            os.chown(path, info.pw_uid, info.pw_gid)
            workspace = home / "workspace"
            workspace.mkdir()
            os.chown(workspace, info.pw_uid, info.pw_gid)
            (workspace / "README.md").write_text(
                "# Benchmark fixture\n\nA small repository for CLI benchmarks.\n"
            )
            (workspace / "example.py").write_text("def add(left, right):\n    return left + right\n")
            for path in workspace.iterdir():
                os.chown(path, info.pw_uid, info.pw_gid)
            for command in (
                ["git", "init", "--quiet", "--initial-branch=main"],
                ["git", "add", "README.md", "example.py"],
                [
                    "git",
                    "-c",
                    "user.name=Benchmark",
                    "-c",
                    "user.email=benchmark@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "chore: initialize benchmark fixture",
                ],
            ):
                run_as(
                    user,
                    command,
                    workspace,
                    extra_env={
                        "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z",
                        "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z",
                    },
                )
            side.runtime["installed"] = version
            try:
                run_as(
                    user,
                    ["npm", "ls", "--global", "--all", "--json"],
                    home,
                    log=RESULTS / "installed-dependencies.json",
                )
            except subprocess.CalledProcessError:
                side.runtime["dependency_inventory"] = "npm ls reported dependency warnings; see inventory"
    except Exception as error:
        record(side, "install", trial, error=clean_error(error))
    finally:
        stop_processes(user)


def read_messages(home: Path) -> list[dict]:
    messages = []
    for path in (home / ".prime/agent/sessions").glob("**/*.jsonl"):
        if path.stat().st_size > 2_000_000:
            raise RuntimeError("Session file exceeds the measurement limit")
        for index, line in enumerate(path.read_text().splitlines()):
            entry = json.loads(line)
            message = entry.get("message", {})
            if entry.get("type") == "message" and message.get("role") == "assistant":
                messages.append(message | {"benchmark_id": f"{path.name}:{index}"})
    return messages


def usage_for(messages: list[dict], price: Price) -> InferenceUsage:
    usage = InferenceUsage(prompts=1)
    for message in messages:
        raw = message.get("usage", {})
        numbers = [finite_number(raw.get(key)) for key in ("input", "output", "cacheRead", "cacheWrite")]
        if None in numbers:
            continue
        incoming, outgoing, cached, written = (int(value) for value in numbers if value is not None)
        usage.responses += 1
        usage.input_tokens += incoming + cached + written
        usage.output_tokens += outgoing
        usage.cached_tokens += cached
        usage.estimated_usd += (
            incoming * price.input
            + written * (price.cache_write if price.cache_write is not None else price.input)
            + outgoing * price.output
            + cached * (price.cache_read if price.cache_read is not None else price.input)
        ) / 1_000_000
    if not usage.responses or not messages or messages[-1].get("stopReason") != "stop":
        usage.incomplete_prompts = 1
    return usage


def add_usage(total: InferenceUsage, addition: InferenceUsage) -> None:
    for field in InferenceUsage.model_fields:
        setattr(total, field, getattr(total, field) + getattr(addition, field))


def record(
    side: Side, metric: Metric, trial: int, value: float | None = None, error: str | None = None
) -> None:
    samples = side.metrics.setdefault(metric, [])
    samples[:] = [sample for sample in samples if sample.trial != trial]
    samples.append(Observation(trial=trial, value=value, error=error))


def stop_agents(home: Path) -> None:
    listing = json.loads(run_as("benchmark1", ["prime-agent", "list", "--json"], home, inference=True))
    for session in listing["sessions"]:
        if session.get("activeSessionId"):
            run_as(
                "benchmark1",
                ["prime-agent", "stop", session["activeSessionId"], "--json"],
                home,
                inference=True,
            )


def measure(request: Request, side: Side, trial: int) -> None:
    if not any(s.value is not None and s.trial == 0 for s in side.metrics.get("install", [])):
        raise RuntimeError("The first installation must succeed before interactive measurements")
    home = HOMES / "benchmark1"
    stop_processes("benchmark1")
    seen = {message["benchmark_id"] for message in read_messages(home)}

    def fresh_messages() -> list[dict]:
        return [message for message in read_messages(home) if message["benchmark_id"] not in seen]

    submitted = False
    for mode in ("cold", "warm"):
        terminal = Terminal(
            [
                "/usr/sbin/runuser",
                "-u",
                "benchmark1",
                "--",
                "prime-agent",
                "--provider",
                "prime-inference",
                "--model",
                request.model,
                "--thinking",
                request.config.effort,
            ],
            home / "workspace",
            environment("benchmark1", inference=True),
            RESULTS / f"{mode}-{trial}",
        )
        try:
            record(side, mode, trial, terminal.ready())
            terminal.settle(1)
            if mode == "cold":
                processes = memory(pwd.getpwnam("benchmark1").pw_uid)
                if not processes:
                    raise RuntimeError("No owned processes found for memory measurement")
                record(side, "rss", trial, sum(process.rss for process in processes))
                if all(process.pss is not None for process in processes):
                    record(side, "pss", trial, sum(process.pss or 0 for process in processes))
                side.processes = processes
                write_json(RESULTS / f"memory-{trial}.json", Result(request=request, side=side))
                if terminal.display.answer_prefix():
                    raise RuntimeError("Answer fixture is already present before submission")
                terminal.child.send(PROMPT)
                terminal.until(lambda display: PROMPT in display.text(), 5)
                entered = time.perf_counter()
                terminal.child.send("\r")
                submitted = True
                first = terminal.until(lambda display: display.answer_prefix() is not None, 45)
                if terminal.display.answer_prefix() != ANSWER:
                    terminal.until(lambda display: display.answer_prefix() == ANSWER, 15)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    terminal.settle(0.1)
                    fresh = fresh_messages()
                    if fresh and fresh[-1].get("stopReason") == "stop":
                        answer = "".join(
                            part.get("text", "")
                            for part in fresh[-1].get("content", [])
                            if part.get("type") == "text"
                        )
                        if answer.strip() != ANSWER:
                            raise RuntimeError("Response did not match the answer fixture")
                        record(side, "ttft", trial, first - entered)
                        break
                else:
                    raise TimeoutError("Answer appeared but no completed session message was persisted")
        except Exception as error:
            metric = "ttft" if mode == "cold" and submitted else mode
            record(side, metric, trial, error=clean_error(error))
        finally:
            terminal.close(SECRET)
        if mode == "cold":
            if submitted:
                add_usage(side.inference, usage_for(fresh_messages(), request.price))
            stop_agents(home)
    stop_processes("benchmark1")
    if trial == 0 and any(sample.value is not None for sample in side.metrics.get("cold", [])):
        record(side, "disk", 0, disk_bytes(home) - int(side.runtime["home_before_install_bytes"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("prepare", "install", "measure"))
    parser.add_argument("--trial", type=int, default=0)
    args = parser.parse_args()
    RESULTS.mkdir(exist_ok=True)
    request = Request.model_validate_json((ROOT / "request.json").read_text())
    path = RESULTS / "result.json"
    result = (
        Result.model_validate_json(path.read_text())
        if path.exists()
        else Result(
            request=request,
            side=Side(sha=request.sha),
        )
    )
    try:
        if args.phase == "prepare":
            prepare(request, result.side)
        elif args.phase == "install":
            install(request, result.side, args.trial)
        else:
            measure(request, result.side, args.trial)
    except Exception as error:
        result.side.error = clean_error(error)
        raise
    finally:
        write_json(path, result)


if __name__ == "__main__":
    main()
