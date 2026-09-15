#!/usr/bin/env python3
"""Delete Prime sandboxes owned by one behavioral-evaluation generation."""

from __future__ import annotations

import argparse
import os
import re

from prime_sandboxes import APIClient, SandboxClient

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def cleanup_owned(client, labels: list[str], team_id: str | None = None) -> int:
    sandbox_ids = []
    page = 1
    while True:
        response = client.list(
            team_id=team_id,
            labels=labels,
            page=page,
            per_page=100,
            exclude_terminated=True,
        )
        sandbox_ids.extend(sandbox.id for sandbox in response.sandboxes if set(labels) <= set(sandbox.labels))
        if not response.has_next:
            break
        page += 1
    failures = []
    for sandbox_id in sandbox_ids:
        try:
            client.delete(sandbox_id)
        except Exception:
            failures.append(sandbox_id)
    if failures:
        raise RuntimeError(f"cleanup failed for {len(failures)} sandbox(es); TTL remains active")
    return len(sandbox_ids)


def cleanup(repository: str, run_id: int, attempt: int) -> int:
    if not REPO_RE.fullmatch(repository):
        raise ValueError("invalid repository")
    labels = [
        "prime-agent-behavioral-v1",
        f"repository:{repository}",
        f"run:{run_id}",
        f"attempt:{attempt}",
    ]
    client = SandboxClient(APIClient(api_key=os.environ["PRIME_SANDBOX_API_KEY"]))
    return cleanup_owned(client, labels, os.environ.get("PRIME_TEAM_ID") or None)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--attempt", required=True, type=int)
    args = parser.parse_args()
    count = cleanup(args.repository, args.run_id, args.attempt)
    print(f"Deleted {count} behavioral-evaluation sandboxes.")


if __name__ == "__main__":
    main()
