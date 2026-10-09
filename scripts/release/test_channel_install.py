#!/usr/bin/env python3
"""Exercise the current curl installer and reinstall against a local channel.

Uses the real candidate executable and installer; no provider requests are made.
The installer's normal Python/kernel bootstrap may access package registries.
"""
from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

from test_legacy_upgrade import archive_identity, digest, execute, isolated_environment, publish_archive, release_server


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--installer", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    version, platform = archive_identity(args.archive)
    report = {"version": version, "platform": platform, "archive_sha256": digest(args.archive),
              "installer_sha256": digest(args.installer), "steps": []}
    try:
        with tempfile.TemporaryDirectory(prefix="prime-channel-install-") as temporary:
            root = Path(temporary)
            feed = root / "feed"
            publish_archive(feed, args.archive)
            shutil.copyfile(args.installer, feed / "install.sh")
            (feed / "stable").write_text(version + "\n")
            (feed / "latest.json").write_text(json.dumps({"version": version, "binaries": [
                {"platform": platform, "file": args.archive.name, "sha256": digest(args.archive)}]}))
            with release_server(feed) as base:
                env = isolated_environment(root / "user", base)
                prefix = root / "user" / "prefix with spaces"
                env.update(PRIME_AGENT_RUST_PREFIX=str(prefix), PRIME_AGENT_ALLOW_HTTP="1")
                state = Path(env["PRIME_AGENT_CODING_AGENT_DIR"])
                witnesses = {"settings.json": '{}\n', "auth.json": '{}\n',
                             "sessions/preserved.jsonl": '{"migrationWitness":"saved session"}\n'}
                for name, content in witnesses.items():
                    path = state / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)
                command = ["bash", "-o", "pipefail", "-c", 'curl -fsSL "$PRIME_AGENT_DOWNLOAD_BASE_URL/install.sh" | sh']
                for _ in range(2):
                    report["steps"].append(execute(command, env))
                    probe = execute([str(prefix / "bin/prime-agent"), "--version"], env)
                    report["steps"].append(probe)
                    if probe["stdout"].strip() != version:
                        raise ValueError("Installed launcher did not report channel version")
                    report["steps"].append(execute([str(prefix / "bin/prime-agent"), "--help"], env))
                    for name, content in witnesses.items():
                        if (state / name).read_text() != content:
                            raise ValueError(f"Installer changed user state: {name}")
                report.update(status="passed", fresh_install=True, reinstall=True, user_state_preserved=True)
    except Exception as error:
        report.update(status="failed", error=str(error))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "steps"}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
