"""Trusted rewrites for pinned SWE-bench Verified test templates."""

import json
from pathlib import Path

INSTALLS = {
    "python -m pip install -e .[test] --verbose",
    "python -m pip install -e .",
    "python -m pip install -e .[dev]",
    "python -m pip install -e .[test]",
    "python -m pip install .",
}
PARSER = 'uv run parser.py | tee -a "$LOG_FILE"'
LOG_ASSIGNMENT = "LOG_FILE=$(mktemp)"
TEE_REDIRECT = 'exec > >(tee "$LOG_FILE") 2>&1'


def trusted_base_commit(task_dir: Path) -> str:
    config = json.loads((task_dir / "tests" / "config.json").read_text())
    base = config.get("base_commit")
    if not isinstance(base, str) or len(base) != 40 or any(ch not in "0123456789abcdef" for ch in base):
        raise ValueError("invalid SWE-bench base commit")
    return base


def patch_collect_command(task_dir: Path) -> str:
    base = trusted_base_commit(task_dir)
    return (
        "rm -rf /logs/artifacts && "
        "git add -N -- . && "
        f"git diff --binary --no-ext-diff {base} -- . > /tmp/prime-agent.patch"
    )


def rewrite_test_script(script: str) -> str:
    install_lines = [line for line in script.splitlines() if line.strip().startswith("python -m pip install")]
    if (
        script.count(PARSER) != 1
        or script.count(LOG_ASSIGNMENT) != 1
        or script.count(TEE_REDIRECT) != 1
        or script.count(" || true") != 1
        or len(install_lines) > 1
        or any(line.strip() not in INSTALLS for line in install_lines)
    ):
        raise RuntimeError("SWE-bench verifier template did not match")
    for line in install_lines:
        replacement = line[: len(line) - len(line.lstrip())] + (
            ": # dependencies are pinned in the task image; test the mounted source tree"
        )
        script = script.replace(line, replacement, 1)
    script = script.replace(" || true", " || TEST_STATUS=$?", 1)
    script = script.replace(LOG_ASSIGNMENT, "LOG_FILE=/dev/null", 1)
    script = script.replace(TEE_REDIRECT, ": # output captured by the runtime controller", 1)
    return script.replace(PARSER, 'exit "${TEST_STATUS:-0}"', 1)
