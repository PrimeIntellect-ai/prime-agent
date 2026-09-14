#!/usr/bin/env python3
"""Delete Prime sandboxes owned by one behavioral-evaluation generation."""

from __future__ import annotations

import argparse
import os
import re

from prime_sandboxes import APIClient, SandboxClient

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


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
    team_id = os.environ.get("PRIME_TEAM_ID") or None
    sandbox_ids = []
    for page in range(1, 21):
        response = client.list(
            team_id=team_id,
            labels=labels,
            page=page,
            per_page=50,
            exclude_terminated=True,
        )
        sandbox_ids.extend(sandbox.id for sandbox in response.sandboxes)
        if len(response.sandboxes) < 50:
            break
    for sandbox_id in sandbox_ids:
        client.delete(sandbox_id)
    return len(sandbox_ids)


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
