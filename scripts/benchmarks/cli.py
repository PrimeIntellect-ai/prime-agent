from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from prime_sandboxes import APIClient, SandboxClient

from controller import Controller, cleanup
from github import WORKFLOW, GitHub
from report import render
from schema import Config, Report, Side, load_report, report_complete, write_json


def workflow_source(event: dict) -> dict:
    run = event["workflow_run"]
    if (
        run["event"] not in ("pull_request_target", "workflow_dispatch")
        or run["path"].split("@")[0] != f".github/workflows/{WORKFLOW}"
        or run["repository"]["full_name"] != os.environ["GITHUB_REPOSITORY"]
        or (run["event"] == "workflow_dispatch" and run["head_branch"] != "main")
    ):
        raise ValueError("Unexpected source workflow")
    return run


def validate_completion(report: Report, request: Report, run: dict) -> None:
    identity = {
        "repository",
        "head_repository",
        "pr",
        "run_id",
        "attempt",
        "harness_sha",
        "base_sha",
        "head_sha",
        "started_at",
        "config",
    }
    if report.model_dump(include=identity) != request.model_dump(include=identity):
        raise ValueError("Result identity does not match the trusted benchmark request")
    if (request.run_id, request.attempt) != (run["id"], run["run_attempt"]) or run[
        "display_title"
    ] != f"Prime Agent benchmarks · PR #{request.pr}":
        raise ValueError("Benchmark request does not match the completed workflow")


def completed_report(result_path: Path, request_path: Path, run: dict) -> Report:
    request = load_report(request_path)
    validate_completion(request, request, run)
    try:
        report = load_report(result_path) if result_path.exists() else request
        validate_completion(report, request, run)
    except (ValueError, OSError):
        report = request
        report.status = "failed"
        report.errors.append("Benchmark report failed validation; see the workflow artifacts")
    if report.status == "completed" and not report_complete(report):
        report.status = "partial"
        report.errors.append("Benchmark claimed completion with failed or missing measurements")
    if report.status == "running":
        report.status = "canceled" if run["conclusion"] == "cancelled" else "failed"
        report.errors.append("Benchmark did not produce a final report; see the workflow logs")
    if report.status != "pending-trust" and report.finished_at is None:
        report.finished_at = datetime.now(UTC)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("resolve", "run", "publish", "finalize", "cleanup", "local"))
    parser.add_argument("--results", type=Path, default=Path("results"))
    parser.add_argument("--request", type=Path, default=Path("request/report.json"))
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--pending-trust", action="store_true")
    args = parser.parse_args()
    args.results.mkdir(parents=True, exist_ok=True)
    repository = os.environ.get("GITHUB_REPOSITORY", "PrimeIntellect-ai/prime-agent")
    config = Config.load(args.config) if args.config else Config.load()
    if args.command == "local":
        if not args.base or not args.head:
            parser.error("local requires exact --base and --head commit SHAs")
        report = Report(
            repository=repository,
            head_repository=repository,
            pr=0,
            run_id=int(datetime.now(UTC).timestamp()),
            attempt=1,
            harness_sha=subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
            base_sha=args.base,
            head_sha=args.head,
            started_at=datetime.now(UTC),
            config=config,
            main=Side(sha=args.base),
            pr_head=Side(sha=args.head),
        )
        controller = Controller(report, args.results, live_github=False)
        controller.run()
        require_success(controller.report)
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if args.command == "cleanup":
        run = workflow_source(event)
        client = SandboxClient(APIClient(api_key=os.environ["PRIME_SANDBOX_API_KEY"]))
        deleted = cleanup(client, repository, run["id"], run["run_attempt"])
        print(f"Cleaned up {len(deleted)} remaining benchmark sandboxes")
        return
    github = GitHub(repository)
    if args.command == "resolve":
        pr = int(event.get("pull_request", {}).get("number") or event["inputs"]["pr"])
        if pr <= 0:
            raise ValueError("Invalid PR number")
        report, author = github.resolve(
            pr,
            os.environ["GITHUB_SHA"],
            int(os.environ["GITHUB_RUN_ID"]),
            int(os.environ["GITHUB_RUN_ATTEMPT"]),
            config,
        )
        write_json(args.results / "report.json", report)
        manual = os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" or report.attempt > 1
        needed = manual or not github.duplicate(report)
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write(
                f"pr={pr}\nauthor={author}\nharness={report.harness_sha}\nneeded={str(needed).lower()}\n"
            )
        return
    report_path = args.results / "report.json"
    report = (
        completed_report(report_path, args.request, workflow_source(event))
        if args.command == "finalize"
        else load_report(report_path if report_path.exists() else args.request)
    )
    if report.repository != repository:
        raise ValueError("Result repository does not match the workflow")
    if args.command == "finalize":
        github.publish(report)
    else:
        if (report.run_id, report.attempt) != (
            int(os.environ["GITHUB_RUN_ID"]),
            int(os.environ["GITHUB_RUN_ATTEMPT"]),
        ):
            raise ValueError("Result identity does not match the active workflow")
        if args.command == "run":
            if not os.environ.get("PRIME_SANDBOX_API_KEY"):
                report.status = "failed"
                report.errors.append("Repository secret PRIME_SANDBOX_API_KEY is not configured")
            if report.status == "running":
                controller = Controller(report, args.results)
                controller.run()
                report = controller.report
            else:
                write_json(report_path, report)
        else:
            if args.pending_trust:
                report.status = "pending-trust"
                write_json(report_path, report)
            github.publish(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        Path(summary).write_text(render(report))
    if args.command == "run":
        require_success(report)


def require_success(report: Report) -> None:
    if report.status != "completed" or not report_complete(report):
        raise SystemExit(f"Benchmark {report.status}: failed or incomplete; see saved report and transcripts")


if __name__ == "__main__":
    main()
