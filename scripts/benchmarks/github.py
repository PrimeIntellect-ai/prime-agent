from __future__ import annotations

import os
import re
from datetime import UTC, datetime

import httpx

from report import MARKER, fingerprint, render
from schema import Config, Report, Side

WORKFLOW = "benchmarks.yml"
TITLE = "Prime Agent benchmarks · PR #"
GENERATION = re.compile(r"<!-- run:(\d+):(\d+) head:([a-f0-9]{40}) -->")


class GitHub:
    def __init__(self, repository: str):
        self.repository = repository
        self.client = httpx.Client(
            base_url=f"https://api.github.com/repos/{repository}/",
            headers={
                "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=30,
        )

    def request(self, method: str, path: str, body: dict | None = None) -> dict | list:
        response = self.client.request(method, path, json=body)
        response.raise_for_status()
        return response.json()

    def pages(self, path: str, key: str | None = None):
        separator = "&" if "?" in path else "?"
        page = 1
        while True:
            data = self.request("GET", f"{path}{separator}per_page=100&page={page}")
            items = data[key] if key else data
            yield items
            if len(items) < 100:
                return
            page += 1

    def resolve(
        self, pr: int, harness_sha: str, run_id: int, attempt: int, config: Config
    ) -> tuple[Report, str]:
        pull = self.request("GET", f"pulls/{pr}")
        if pull["state"] != "open":
            raise ValueError("Benchmark requires an open PR")
        if pull["base"]["repo"]["full_name"] != self.repository:
            raise ValueError("PR belongs to another repository")
        base = self.request("GET", "git/ref/heads/main")["object"]["sha"]
        report = Report(
            repository=self.repository,
            head_repository=pull["head"]["repo"]["full_name"],
            pr=pr,
            run_id=run_id,
            attempt=attempt,
            harness_sha=harness_sha,
            base_sha=base,
            head_sha=pull["head"]["sha"],
            started_at=datetime.now(UTC),
            config=config,
            main=Side(sha=base),
            pr_head=Side(sha=pull["head"]["sha"]),
        )
        return report, pull["user"]["login"]

    def fresh(self, report: Report) -> bool:
        pull = self.request("GET", f"pulls/{report.pr}")
        if pull["state"] != "open" or pull["head"]["sha"] != report.head_sha:
            return False
        run = self.request("GET", f"actions/runs/{report.run_id}")
        if run["run_attempt"] != report.attempt:
            return False
        for runs in self.pages(f"actions/workflows/{WORKFLOW}/runs", "workflow_runs"):
            if any(
                candidate["display_title"] == f"{TITLE}{report.pr}"
                and (candidate["run_number"], candidate["run_attempt"]) > (run["run_number"], report.attempt)
                for candidate in runs
            ):
                return False
            if not runs or min(candidate["run_number"] for candidate in runs) < run["run_number"]:
                break
        return True

    def comment(self, pr: int) -> dict | None:
        comments = [
            comment
            for page in self.pages(f"issues/{pr}/comments")
            for comment in page
            if comment["user"]["login"] == "github-actions[bot]"
            and comment.get("body", "").startswith(MARKER)
        ]
        return comments[-1] if comments else None

    def duplicate(self, report: Report) -> bool:
        comment = self.comment(report.pr)
        return bool(
            comment and f"<!-- comparison:{fingerprint(report)} status:completed -->" in comment["body"]
        )

    def publish(self, report: Report) -> bool:
        if not self.fresh(report):
            return False
        comment = self.comment(report.pr)
        if comment:
            generation = GENERATION.search(comment["body"])
            if generation and tuple(map(int, generation.groups()[:2])) > (report.run_id, report.attempt):
                return False
        body = render(report)
        if comment and comment["body"] == body:
            return False
        if not self.fresh(report):
            return False
        if comment:
            self.request("PATCH", f"issues/comments/{comment['id']}", {"body": body})
        else:
            self.request("POST", f"issues/{report.pr}/comments", {"body": body})
        return True
