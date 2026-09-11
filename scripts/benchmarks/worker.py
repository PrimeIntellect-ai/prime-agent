from __future__ import annotations

import argparse
import hashlib
import json
import os
import pwd
import shutil
import signal
import subprocess
import time
from pathlib import Path

from kernel import (
    BASH_EMPTY,
    BASH_OUTPUT,
    CELL_REPEATS,
    FRAME_COLUMNS,
    FRAME_ROWS,
    GIT_STATUS,
    OUTPUT_BYTES,
    SHELL_REPEATS,
    Kernel,
)
from schema import (
    ROOT,
    Metric,
    Observation,
    ProcessMemory,
    Request,
    Result,
    Side,
    write_json,
)
from terminal import Terminal

HOMES = Path("/home")
SOURCE = HOMES / "builder/source"
RESULTS = ROOT / "results"
VERSION = "0.0.0-benchmark"
ORIGIN = "http://127.0.0.1:18741"
BUN_VERSION = "1.4.0"


def clean_error(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"[:500]


def environment(user: str) -> dict[str, str]:
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
    return env


def run_as(
    user: str,
    args: list[str],
    cwd: Path,
    *,
    timeout: int = 60,
    log: Path | None = None,
    extra_env: dict[str, str] | None = None,
    merge_output: bool = False,
) -> str:
    env = environment(user) | (extra_env or {})
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


def prepare_native_artifact(agent: Path, artifacts: Path, log: Path) -> bool:
    build = agent / "scripts/build-binary.mjs"
    assemble = SOURCE / "scripts/assemble-release-archives.mjs"
    if not build.exists() and not assemble.exists():
        return False
    if not build.is_file() or not assemble.is_file():
        raise RuntimeError("Compiled release build scripts are incomplete")
    tools = SOURCE / ".benchmark-bun"
    run_as(
        "builder",
        ["npm", "install", "--prefix", str(tools), "--no-audit", "--no-fund", f"bun@{BUN_VERSION}"],
        SOURCE,
        timeout=180,
        log=log,
    )
    run_as(
        "builder",
        ["node", str(build), "--platform", "linux-x64"],
        SOURCE,
        timeout=600,
        log=log,
        extra_env={"BUN_BINARY": str(tools / "node_modules/.bin/bun")},
    )
    run_as(
        "builder",
        ["node", str(assemble), str(agent / "binaries"), str(artifacts), VERSION],
        SOURCE,
        timeout=180,
        log=log,
    )
    if not (artifacts / f"prime-agent-{VERSION}-linux-x64.tar.gz").is_file():
        raise RuntimeError("Compiled Linux x64 release archive is missing")
    return True


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
    if len(list(artifacts.glob("*.tgz"))) != 4:
        raise RuntimeError("Expected the four release package tarballs")
    native = prepare_native_artifact(agent, artifacts, log)
    archives = sorted([*artifacts.glob("*.tgz"), *artifacts.glob("*.tar.gz")])
    side.artifacts = {path.name: path.stat().st_size for path in archives}
    (artifacts / "SHA256SUMS").write_text(
        "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in archives)
    )
    record(side, "bundle", 0, sum(side.artifacts.values()))
    release = ROOT / "www/releases" / f"v{VERSION}"
    release.parent.mkdir(parents=True, exist_ok=True)
    release.symlink_to(artifacts)
    for name in ("node", "npm"):
        side.runtime[name] = run_as("builder", [name, "--version"], SOURCE).strip()
    side.runtime["kernel"] = os.uname().release
    side.runtime["machine"] = os.uname().machine
    side.runtime["artifact_format"] = "npm-tarballs+linux-x64-native" if native else "npm-tarballs"
    if native:
        side.runtime["bun"] = BUN_VERSION
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
                "PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS": "1",
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
            info = pwd.getpwnam(user)
            settings = home / ".prime/agent/settings.json"
            settings.write_text(json.dumps({"onboardingShown": True}) + "\n")
            os.chown(settings, info.pw_uid, info.pw_gid)
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


def record(
    side: Side, metric: Metric, trial: int, value: float | None = None, error: str | None = None
) -> None:
    samples = side.metrics.setdefault(metric, [])
    samples[:] = [sample for sample in samples if sample.trial != trial]
    samples.append(Observation(trial=trial, value=value, error=error))


def stop_agents(home: Path) -> None:
    listing = json.loads(run_as("benchmark1", ["prime-agent", "list", "--json"], home))
    for session in listing["sessions"]:
        if session.get("activeSessionId"):
            run_as(
                "benchmark1",
                ["prime-agent", "stop", session["activeSessionId"], "--json"],
                home,
            )


def measure(request: Request, side: Side, trial: int) -> None:
    if not any(s.value is not None and s.trial == 0 for s in side.metrics.get("install", [])):
        raise RuntimeError("The first installation must succeed before interactive measurements")
    home = HOMES / "benchmark1"
    stop_processes("benchmark1")
    for mode in ("cold", "warm"):
        terminal = Terminal(
            [
                "/usr/sbin/runuser",
                "-u",
                "benchmark1",
                "--",
                "prime-agent",
            ],
            home / "workspace",
            environment("benchmark1"),
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
        except Exception as error:
            record(side, mode, trial, error=clean_error(error))
        finally:
            terminal.close()
        if mode == "cold":
            stop_agents(home)
    stop_processes("benchmark1")
    if trial == 0 and any(sample.value is not None for sample in side.metrics.get("cold", [])):
        record(side, "disk", 0, disk_bytes(home) - int(side.runtime["home_before_install_bytes"]))


def runtime(side: Side, trial: int) -> None:
    home = HOMES / "benchmark1"
    user = pwd.getpwnam("benchmark1")
    stop_processes("benchmark1")
    state = home / f"runtime-benchmark-{trial}"
    state.mkdir()
    os.chown(state, user.pw_uid, user.pw_gid)
    command = [
        "/usr/sbin/runuser",
        "-u",
        "benchmark1",
        "--",
        str(home / ".prime/agent/kernel-venv/bin/python"),
        "-m",
        "rlm.repl",
    ]
    kernel = None
    metric: Metric = "kernel_start"

    def rss() -> int:
        processes = memory(user.pw_uid)
        if not processes:
            raise RuntimeError("No kernel processes found for memory measurement")
        (RESULTS / f"{metric}-{trial}.json").write_text(
            json.dumps([process.model_dump() for process in processes], indent=2) + "\n"
        )
        return sum(process.rss for process in processes)

    try:
        kernel = Kernel(command, home / "workspace", environment("benchmark1"), RESULTS / f"kernel-{trial}")
        elapsed, python = kernel.ready()
        record(side, metric, trial, elapsed)
        side.runtime["python"] = python
        metric = "kernel_rss"
        record(side, metric, trial, rss())
        kernel.execute("from rlm import bash")
        kernel.batch("pass", 5)
        kernel.batch(BASH_EMPTY, 1)
        for metric, code, repeats, output in (
            ("kernel_exec", "pass", CELL_REPEATS, None),
            ("bash", BASH_EMPTY, SHELL_REPEATS, None),
            ("git_status", GIT_STATUS, SHELL_REPEATS, None),
            ("output", BASH_OUTPUT, SHELL_REPEATS, OUTPUT_BYTES),
        ):
            record(side, metric, trial, kernel.batch(code, repeats, output_bytes=output))
        metric = "mixed"
        record(side, metric, trial, kernel.mixed())
        metric = "interrupt"
        record(side, metric, trial, kernel.interrupt())
        metric = "loaded_rss"
        kernel.execute(
            f"import pandas as pd\nframe = pd.DataFrame({{str(i): range({FRAME_ROWS}) "
            f"for i in range({FRAME_COLUMNS})}})\npayload = list(range({FRAME_ROWS}))\n"
            f"assert frame.shape == ({FRAME_ROWS}, {FRAME_COLUMNS})"
        )
        record(side, metric, trial, rss())
        metric = "snapshot"
        started = time.perf_counter()
        events = kernel.request(
            "snapshot", path=str(state / "state.pkl"), manifest_path=str(state / "manifest.json")
        )
        elapsed = time.perf_counter() - started
        if not {"frame", "payload"} <= set(events[-1].get("saved", [])):
            raise RuntimeError("Snapshot did not save the complete state fixture")
        record(side, metric, trial, elapsed)
        kernel.close()
        kernel = None
        metric = "restore"
        kernel = Kernel(command, home / "workspace", environment("benchmark1"), RESULTS / f"restore-{trial}")
        kernel.ready()
        started = time.perf_counter()
        events = kernel.request("restore", path=str(state / "state.pkl"))
        elapsed = time.perf_counter() - started
        if events[-1].get("failed") or not {"frame", "payload"} <= set(events[-1].get("restored", [])):
            raise RuntimeError("Restore did not recover the complete state fixture")
        kernel.execute(
            f"assert frame.shape == ({FRAME_ROWS}, {FRAME_COLUMNS})\n"
            f"assert int(frame.sum().sum()) == {FRAME_COLUMNS * FRAME_ROWS * (FRAME_ROWS - 1) // 2}\n"
            f"assert payload == list(range({FRAME_ROWS}))"
        )
        record(side, metric, trial, elapsed)
    except Exception as error:
        record(side, metric, trial, error=clean_error(error))
    finally:
        try:
            if kernel:
                kernel.close()
        finally:
            stop_processes("benchmark1")
            shutil.rmtree(state)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("prepare", "install", "measure", "runtime"))
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
        elif args.phase == "measure":
            measure(request, result.side, args.trial)
        else:
            runtime(result.side, args.trial)
    except Exception as error:
        result.side.error = clean_error(error)
        raise
    finally:
        write_json(path, result)


if __name__ == "__main__":
    main()
