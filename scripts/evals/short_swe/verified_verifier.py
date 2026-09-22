"""Trusted rewrites for pinned SWE-bench Verified test templates."""

import json
import re
import shlex
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
    # The candidate agent controls this sandbox, including its git config, so the
    # collect command must not honor repo-local diff prefix settings: a candidate
    # that sets diff.srcPrefix/diff.dstPrefix (or diff.mnemonicPrefix, or
    # diff.noprefix) would emit headers like "diff --git i/tests/conftest.py
    # j/tests/conftest.py" or prefix-less ones, which _patch_paths cannot attribute
    # to a path. -c overrides any repo config.
    return (
        "rm -rf /logs/artifacts && "
        "git add -N -- . && "
        "git -c diff.srcPrefix=a/ -c diff.dstPrefix=b/ -c diff.mnemonicPrefix=false "
        "-c diff.noprefix=false "
        f"diff --binary --no-ext-diff {base} -- . > /tmp/prime-agent.patch"
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


# Maximum patch size accepted for filtering (prevents memory abuse).
MAX_PATCH_BYTES = 16 * 1024 * 1024

# Paths that control test execution; a candidate patch must not touch them
# in the verifier sandbox because the pinned test metadata is the contract.
TEST_CONTROL = re.compile(
    r"^(?:[^/]+/)*"
    r"(?:tests(?:/.*)?|testing(?:/.*)?|conftest\.py|\.?pytest\.ini|tox\.ini|pyproject\.toml|setup\.cfg|"
    r"test_[^/]*\.py|[^/]*_test\.py)$"
)


def _decode_patch(raw: bytes | str) -> str:
    """Decode a runtime.read patch payload to text, capped in both forms."""
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > MAX_PATCH_BYTES:
            raise RuntimeError("candidate patch exceeds the filtering cap")
        return raw
    if len(raw) > MAX_PATCH_BYTES:
        raise RuntimeError("candidate patch exceeds the filtering cap")
    return raw.decode("utf-8", errors="strict")


def _patch_paths(header: str) -> tuple[str, str]:
    """Extract the a-side and b-side paths from a diff --git header.

    A header that yields no a/ or b/ token cannot be attributed to a path, so it is
    rejected instead of kept: git config (diff.srcPrefix, diff.dstPrefix, or
    diff.mnemonicPrefix) can produce headers such as
    ``diff --git i/tests/conftest.py j/tests/conftest.py``, and a kept-but-unattributed
    section would smuggle test-control edits into the verifier.
    """
    tokens = shlex.split(header)
    a_path = ""
    b_path = ""
    for token in tokens:
        if token.startswith("a/") and not a_path:
            a_path = token[2:]
        elif token.startswith("b/") and not b_path:
            b_path = token[2:]
    if not a_path or not b_path:
        raise RuntimeError(
            f"diff --git header has no a/ or b/ path; refusing to filter: {header.strip()[:80]!r}"
        )
    return a_path, b_path


def _unquote_path(raw: str) -> str:
    """Strip surrounding quotes from a traditional ---/+++ path token."""
    raw = raw.strip().split("\t")[0]
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    return raw


def _strip_diff_prefix(path: str) -> str:
    return path[2:] if len(path) > 2 and path[1] == "/" and path[0] in "ab" else path


def _hunk_expected_lines(header: str) -> int | None:
    # Anchored to the real header shape (-N[,M] then +N[,M] then @@): a greedy
    # pattern could capture a fake "+N,M @@" from arbitrary function-context
    # text, inflating the count and keeping in_hunk true past the real hunk end.
    m = re.search(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", header)
    if not m:
        return None
    return 1 if m.group(2) is None else int(m.group(2))


def _in_traditional_section(current: list[str]) -> bool:
    return bool(current) and current[0].startswith("--- ")


def filter_test_control(raw: bytes | str) -> str:
    """Drop hunks that modify test-control paths from a unified diff.

    The input may be raw bytes (as returned by Runtime.read) or text.
    Only diff --git headers are recognized; a patch without any
    recognized header is rejected so traditional header-less diffs
    cannot bypass the filter, and any header whose a/ or b/ path is
    missing is rejected so diff-prefix tampering cannot smuggle
    test-control edits through as unattributable sections.
    """
    patch = _decode_patch(raw)
    kept: list[str] = []
    current: list[str] = []
    a_path = ""
    b_path = ""
    saw_header = False
    in_hunk = False
    hunk_lines_left: int | None = None
    for line in patch.splitlines(keepends=True):
        if in_hunk and hunk_lines_left is not None and hunk_lines_left <= 0:
            # The previous hunk's line count is exhausted; a --- here is a new
            # traditional file header (git apply treats it as such), not hunk content.
            in_hunk = False
        if line.startswith("diff --git "):
            if not saw_header and current:
                # Content before the first header is traditional-diff preamble:
                # git apply can still apply it, so it cannot bypass the filter.
                raise RuntimeError(
                    "candidate patch has content before the first diff --git header; refusing to filter",
                )
            if current and not (TEST_CONTROL.fullmatch(a_path) or TEST_CONTROL.fullmatch(b_path)):
                kept.extend(current)
            current = [line]
            a_path, b_path = _patch_paths(line)
            saw_header = True
            in_hunk = False
            hunk_lines_left = None
        elif (
            line.startswith("--- ")
            and current
            and not in_hunk
            and _strip_diff_prefix(_unquote_path(line[4:])) not in (a_path, b_path)
        ):
            # Traditional-diff header between hunks: git apply parses it as a new
            # file patch after the preceding section, so it cannot ride along a
            # kept section's attribution. Route it through TEST_CONTROL on its
            # own a/b paths; a test-control traditional section is dropped.
            if current and not (TEST_CONTROL.fullmatch(a_path) or TEST_CONTROL.fullmatch(b_path)):
                kept.extend(current)
            current = [line]
            a_path = _strip_diff_prefix(_unquote_path(line[4:]))
            b_path = ""
            in_hunk = False
            hunk_lines_left = None
        elif b_path == "" and line.startswith("+++ ") and current and _in_traditional_section(current):
            current.append(line)
            b_path = _strip_diff_prefix(_unquote_path(line[4:]))
        else:
            if line.startswith("@@"):
                in_hunk = True
                hunk_lines_left = _hunk_expected_lines(line)
            elif in_hunk and hunk_lines_left is not None and not line.startswith("\\"):
                hunk_lines_left -= 1
            current.append(line)
    if current and not (TEST_CONTROL.fullmatch(a_path) or TEST_CONTROL.fullmatch(b_path)):
        kept.extend(current)
    if not saw_header and patch.strip():
        raise RuntimeError("candidate patch has no diff --git header; refusing to filter")
    return "".join(kept)
