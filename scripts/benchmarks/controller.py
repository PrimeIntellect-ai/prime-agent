from __future__ import annotations

import os
import shlex
import signal
import time
from datetime import UTC, datetime
from pathlib import Path

from prime_sandboxes import APIClient, CreateSandboxRequest, SandboxClient
from prime_sandboxes.models import BackgroundJob, Sandbox

from github import GitHub
from report import render
from schema import (
    ROOT,
    UV_VERSION,
    Report,
    Request,
    Result,
    SandboxUsage,
    Side,
    write_json,
)

REMOTE = "/opt/prime-benchmark"
OWNER_LABEL = "prime-agent-benchmarks-v1"
FILES = ("schema.py", "terminal.py", "kernel.py", "worker.py", "pyproject.toml", "uv.lock")


def elapsed_seconds(start: datetime) -> float:
    return max(0, (datetime.now(UTC) - start.replace(tzinfo=start.tzinfo or UTC)).total_seconds())


class Canceled(Exception):
    pass


def labels(repository: str, run_id: int, attempt: int) -> list[str]:
    return [OWNER_LABEL, f"repository:{repository}", f"run:{run_id}", f"attempt:{attempt}"]


def cleanup(client: SandboxClient, repository: str, run_id: int, attempt: int) -> list[str]:
    expected = labels(repository, run_id, attempt)
    owned = []
    page = 1
    while True:
        response = client.list(labels=expected, page=page, per_page=100, exclude_terminated=True)
        owned.extend(sandbox.id for sandbox in response.sandboxes if set(expected) <= set(sandbox.labels))
        if not response.has_next:
            break
        page += 1
    failed = []
    for sandbox_id in owned:
        try:
            client.delete(sandbox_id)
        except Exception:
            failed.append(sandbox_id)
    if failed:
        raise RuntimeError(f"Cleanup failed for {len(failed)} sandbox(es); TTL remains active")
    return owned


class Controller:
    def __init__(self, report: Report, results: Path, *, live_github: bool = True):
        self.report = report
        self.results = results
        self.results.mkdir(parents=True, exist_ok=True)
        self.harness = self.results / "harness"
        self.harness.mkdir(exist_ok=True)
        for name in FILES:
            (self.harness / name).write_bytes((ROOT / name).read_bytes())
        self.client = SandboxClient(APIClient(api_key=os.environ["PRIME_SANDBOX_API_KEY"]))
        self.github = GitHub(report.repository) if live_github else None
        self.sandboxes: dict[str, Sandbox] = {}
        self.requests: dict[str, Request] = {}
        self.started = time.monotonic()
        self.deadline = self.started + report.config.timeout_seconds
        self.last_fresh_check = 0.0

    def checkpoint(self) -> None:
        now = time.monotonic()
        if now > self.deadline:
            raise TimeoutError("Benchmark exceeded its runtime limit")
        if self.github and now - self.last_fresh_check > 60:
            self.last_fresh_check = now
            if not self.github.fresh(self.report):
                raise Canceled("A newer PR head or benchmark run superseded this run")

    def save(self) -> None:
        self.report.errors = self.report.errors[:30]
        self.report = Report.model_validate(self.report.model_dump())
        write_json(self.results / "report.json", self.report)
        (self.results / "comment.md").write_text(render(self.report))

    def command(self, sandbox: Sandbox, args: list[str], timeout: int = 60) -> None:
        self.checkpoint()
        result = self.client.execute_command(sandbox.id, shlex.join(args), timeout=timeout)
        if result.exit_code:
            raise RuntimeError(f"Sandbox setup command failed with exit code {result.exit_code}")

    def start(self, role: str) -> Sandbox:
        started = time.monotonic()
        side = self.report.main if role == "main" else self.report.pr_head
        config = self.report.config
        sha = self.report.base_sha if role == "main" else self.report.head_sha
        request = Request(
            repository=self.report.repository,
            source_repository=self.report.repository if role == "main" else self.report.head_repository,
            sha=sha,
            harness_sha=self.report.harness_sha,
            pr=self.report.pr,
            run_id=self.report.run_id,
            attempt=self.report.attempt,
            role=role,
            config=config,
        )
        self.requests[role] = request
        self.checkpoint()
        sandbox = self.client.create(
            CreateSandboxRequest(
                name=f"agent-bench-{self.report.run_id}-{self.report.attempt}-{role}",
                docker_image=config.image,
                cpu_cores=config.cpu_cores,
                memory_gb=config.memory_gb,
                disk_size_gb=config.disk_gb,
                vm=False,
                region=config.region,
                timeout_minutes=config.ttl_minutes,
                labels=labels(self.report.repository, self.report.run_id, self.report.attempt)
                + [f"role:{role}"],
                idempotency_key=f"agent-bench-{self.report.repository}-{self.report.run_id}-{self.report.attempt}-{role}",
            )
        )
        self.sandboxes[role] = sandbox
        print(f"Created {role} sandbox {sandbox.id}", flush=True)
        while self.client.get(sandbox.id).status != "RUNNING":
            self.checkpoint()
            state = self.client.get(sandbox.id).status
            if state in ("ERROR", "FAILED", "TERMINATED", "STOPPED", "TIMEOUT"):
                raise RuntimeError(f"{role} sandbox failed during provisioning")
            time.sleep(2)
        side.timings["provision"] = time.monotonic() - started
        started = time.monotonic()
        self.command(sandbox, ["mkdir", "-p", REMOTE])
        for name in FILES:
            self.client.upload_file(sandbox.id, f"{REMOTE}/{name}", str(self.harness / name))
        request_path = self.results / f"request-{role}.json"
        write_json(request_path, request)
        self.client.upload_file(sandbox.id, f"{REMOTE}/request.json", str(request_path))
        setup = (
            "set -eu\n"
            "apt-get update -qq\n"
            "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv "
            "libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep\n"
            "ln -sf /usr/bin/fdfind /usr/local/bin/fd\n"
            "useradd --create-home --uid 1500 --shell /bin/bash builder\n"
            "python3 -m venv /opt/benchmark-bootstrap\n"
            f"/opt/benchmark-bootstrap/bin/pip -q install uv=={UV_VERSION}\n"
            f"/opt/benchmark-bootstrap/bin/uv sync --locked --no-dev --project {REMOTE}\n"
        )
        command = f"{shlex.join(['sh', '-c', setup])} > {REMOTE}/setup.log 2>&1"
        job = self.client.start_background_job(sandbox.id, command)
        self.wait(sandbox, job, "setup")
        side.timings["setup"] = time.monotonic() - started
        return sandbox

    def wait(self, sandbox: Sandbox, job: BackgroundJob, label: str) -> None:
        while True:
            self.checkpoint()
            status = self.client.get_background_job(sandbox.id, job, timeout=30)
            if status.completed:
                if status.exit_code:
                    raise RuntimeError(f"{label} failed with exit code {status.exit_code}")
                return
            time.sleep(2)

    def phase(self, role: str, phase: str, trial: int = 0) -> None:
        started = time.monotonic()
        sandbox = self.sandboxes[role]
        args = [f"{REMOTE}/.venv/bin/python", f"{REMOTE}/worker.py", phase, "--trial", str(trial)]
        command = f"{shlex.join(args)} > {REMOTE}/{phase}.log 2>&1"
        job = self.client.start_background_job(sandbox.id, command)
        try:
            self.wait(sandbox, job, f"{role} {phase} {trial}")
        except (Canceled, TimeoutError):
            raise
        except Exception:
            try:
                self.collect_result(role)
            except Exception:
                pass
            raise
        else:
            self.collect_result(role)
        finally:
            if phase == "prepare":
                side = self.report.main if role == "main" else self.report.pr_head
                side.timings["build"] = time.monotonic() - started
                self.save()

    def collect_result(self, role: str) -> None:
        path = self.results / f"result-{role}.json"
        self.client.download_file(self.sandboxes[role].id, f"{REMOTE}/results/result.json", str(path))
        if path.stat().st_size > 2_000_000:
            raise ValueError("Sandbox result exceeds size limit")
        result = Result.model_validate_json(path.read_text())
        if result.request != self.requests[role] or result.side.sha != self.requests[role].sha:
            raise ValueError("Sandbox result does not match this run's request")
        previous = self.report.main if role == "main" else self.report.pr_head
        result.side.timings = previous.timings.copy()
        if role == "main":
            self.report.main = result.side
        else:
            self.report.pr_head = result.side
        self.save()

    def logs(self, role: str) -> None:
        sandbox = self.sandboxes[role]
        # Never unpack PR-produced archives on the GitHub runner.
        args = [
            "python3",
            "-c",
            "import pathlib,tarfile; "
            f"root=pathlib.Path({REMOTE!r}); "
            "paths=[p for p in root.glob('*.log') if p.is_file() and p.stat().st_size < 8000000]; "
            "paths += [p for p in (root/'results').glob('*') "
            "if p.is_file() and p.stat().st_size < 8000000]; "
            "archive=tarfile.open(root/'logs.tar.gz','w:gz'); "
            "[archive.add(p,arcname=str(p.relative_to(root)),recursive=False) for p in paths[:1000]]; "
            "archive.close()",
        ]
        result = self.client.execute_command(sandbox.id, shlex.join(args), timeout=30)
        if result.exit_code == 0:
            self.client.download_file(
                sandbox.id, f"{REMOTE}/logs.tar.gz", str(self.results / f"{role}-logs.tar.gz")
            )

    def run(self) -> None:
        old_handler = signal.signal(signal.SIGTERM, cancel)
        try:
            self.save()
            while time.monotonic() - self.started < self.report.config.debounce_seconds:
                self.checkpoint()
                time.sleep(1)
            ready = []
            for role in ("main", "pr"):
                try:
                    self.start(role)
                    self.phase(role, "prepare")
                    server = shlex.join(
                        [
                            "runuser",
                            "-u",
                            "builder",
                            "--",
                            "python3",
                            "-m",
                            "http.server",
                            "18741",
                            "--bind",
                            "127.0.0.1",
                            "--directory",
                            f"{REMOTE}/www",
                        ]
                    )
                    self.client.start_background_job(self.sandboxes[role].id, server)
                    ready.append(role)
                except (Canceled, TimeoutError):
                    raise
                except Exception as error:
                    self.report.errors.append(f"{role} setup: {type(error).__name__}")
            for phase, count in (
                ("install", self.report.config.install_trials),
                ("measure", self.report.config.trials),
                ("runtime", self.report.config.trials),
            ):
                for trial in range(count):
                    for role in ready if trial % 2 == 0 else list(reversed(ready)):
                        print(f"{role}: {phase} trial {trial + 1}/{count}", flush=True)
                        try:
                            self.phase(role, phase, trial)
                        except (Canceled, TimeoutError):
                            raise
                        except Exception as error:
                            if len(self.report.errors) < 25:
                                self.report.errors.append(f"{role} {phase} {trial}: {type(error).__name__}")
                        compute = sum(
                            elapsed_seconds(sandbox.created_at) * self.report.config.hourly_cost() / 3600
                            for sandbox in self.sandboxes.values()
                        )
                        if compute >= self.report.config.budget_usd:
                            raise TimeoutError("Reached the estimated run budget")
            complete = all(
                side_complete(side, self.report.config.trials, self.report.config.install_trials)
                for side in (self.report.main, self.report.pr_head)
            )
            self.report.status = "completed" if complete and not self.report.errors else "partial"
            if not ready:
                self.report.status = "failed"
        except Canceled:
            self.report.status = "canceled"
        except Exception as error:
            self.report.status = "failed"
            message = str(error)
            for key in ("PRIME_SANDBOX_API_KEY", "GITHUB_TOKEN"):
                if os.environ.get(key):
                    message = message.replace(os.environ[key], "[REDACTED]")
            self.report.errors.append(message[:500])
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            for role, sandbox in self.sandboxes.items():
                deleted = False
                try:
                    self.logs(role)
                except Exception:
                    self.report.errors.append(f"{role} logs could not be collected")
                try:
                    self.client.delete(sandbox.id)
                    deleted = True
                except Exception:
                    self.report.errors.append(
                        f"{role} sandbox cleanup deferred to the cleanup workflow or TTL"
                    )
                seconds = elapsed_seconds(sandbox.created_at)
                if not deleted:
                    seconds = max(seconds, self.report.config.ttl_minutes * 60)
                self.report.sandboxes.append(
                    SandboxUsage(
                        id=sandbox.id,
                        role=role,
                        seconds=seconds,
                        deleted=deleted,
                        estimated_usd=seconds * self.report.config.hourly_cost() / 3600,
                    )
                )
            self.report.finished_at = datetime.now(UTC)
            self.save()
            signal.signal(signal.SIGTERM, old_handler)


def cancel(_signum: int, _frame: object) -> None:
    raise Canceled("Workflow was canceled")


def side_complete(side: Side, trials: int, installs: int) -> bool:
    expected = {
        "cold": trials,
        "warm": trials,
        "kernel_start": trials,
        "kernel_exec": trials,
        "bash": trials,
        "git_status": trials,
        "output": trials,
        "mixed": trials,
        "interrupt": trials,
        "snapshot": trials,
        "restore": trials,
        "kernel_rss": trials,
        "loaded_rss": trials,
        "rss": trials,
        "install": installs,
        "disk": 1,
        "bundle": 1,
    }
    return not side.error and all(
        len(side.metrics.get(metric, [])) == count
        and all(sample.value is not None for sample in side.metrics[metric])
        for metric, count in expected.items()
    )
