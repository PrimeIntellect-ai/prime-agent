"""Trusted rewrites for pinned SWE-bench Verified test templates."""

import json
import re
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
    # j/tests/conftest.py" or prefix-less ones, which _header_path cannot attribute
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


_C_ESCAPES = {
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    '"': '"',
}


def _unquote_c_style(text: str) -> tuple[str, int]:
    """Decode the C-quoted name at the start of text, like git's unquote_c_style.

    Returns the name and the index just past the closing quote. Unknown escapes or a
    missing closing quote fail closed; git rejects those headers too. Octal escapes
    are bytes, decoded here as Latin-1 code points (not UTF-8 text); TEST_CONTROL
    only inspects ASCII structure, so that is harmless.
    """
    out: list[str] = []
    i = 1
    while i < len(text):
        ch = text[i]
        i += 1
        if ch == '"':
            return "".join(out), i
        if ch != "\\":
            out.append(ch)
            continue
        esc = text[i : i + 1]
        if esc in _C_ESCAPES:
            out.append(_C_ESCAPES[esc])
            i += 1
        elif octal := re.match(r"[0-3][0-7]{2}", text[i:]):
            out.append(chr(int(octal.group(), 8)))
            i += octal.end()
        else:
            break
    raise RuntimeError(f"malformed quoted path in candidate patch: {text[:80]!r}")


def _header_path(text: str, *, prefixed: bool = True) -> str | None:
    """Resolve one path after a name-bearing header keyword, like git's find_name.

    Unquoted names end at CR/LF like git's find_name (and at TAB for prefixed names).
    Prefixed names (diff --git, ---, +++) must carry the pinned a/ or b/ prefix, which
    is stripped; rename/copy names carry none, and /dev/null is an absent side. A NUL
    would be truncated by git's C strings, so it is refused rather than matched.
    """
    if text.startswith('"'):
        name = _unquote_c_style(text)[0]
    else:
        name = text.rstrip("\r\n")
        if prefixed:
            name = name.split("\t")[0]
    if "\x00" in name or "//" in name:
        # git's squash_slash collapses "//" (pkg//tests/x.py -> pkg/tests/x.py) and its C
        # strings end at NUL, so both would be matched against a name git does not use.
        raise RuntimeError(f"patch path contains NUL or //; refusing to filter: {text.strip()[:80]!r}")
    if not prefixed:
        return name
    if name == "/dev/null":
        return None
    if name[:2] not in ("a/", "b/") or len(name) < 3:
        raise RuntimeError(f"patch header has no a/ or b/ path; refusing to filter: {text.strip()[:80]!r}")
    return name[2:]


def _git_header_paths(line: str) -> list[str]:
    """Both names of a diff --git line, like git's git_header_name; either may be C-quoted."""
    rest = line[len("diff --git ") :].rstrip("\r\n")
    if rest.startswith('"'):
        _, end = _unquote_c_style(rest)
        first, second = rest[:end], rest[end:].lstrip(" ")
    elif (quote := rest.find(' "')) >= 0:
        # git_header_name: with an unquoted first name, a double quote can only start
        # the second name.
        first, second = rest[:quote], rest[quote + 1 :]
    else:
        first, _, second = rest.partition(" ")
        if " " in second:
            # Unquoted names with spaces are only parseable when both sides name the
            # same path, so the separator is the middle character of the line.
            mid = len(rest) // 2
            if len(rest) % 2 == 0 or rest[mid] != " " or rest[2:mid] != rest[mid + 3 :]:
                raise RuntimeError(f"unparseable diff --git header; refusing to filter: {rest[:80]!r}")
            first, second = rest[:mid], rest[mid + 1 :]
    return [p for p in (_header_path(first), _header_path(second)) if p]


def _hunk_counts(header: str) -> tuple[int, int]:
    # Anchored to the real header shape: a line starting with @@ that is not a hunk
    # header is garbage git would skip, and skipping it would lose hunk-end detection.
    m = re.match(r"@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@", header)
    if not m:
        raise RuntimeError(f"malformed hunk header in candidate patch: {header.strip()[:80]!r}")
    old, new = m.groups()
    return (1 if old is None else int(old), 1 if new is None else int(new))


_NAME_HEADERS = (
    "--- ",
    "+++ ",
    "rename from ",
    "rename to ",
    "rename old ",
    "rename new ",
    "copy from ",
    "copy to ",
)


def filter_test_control(raw: bytes | str) -> str:
    """Drop sections that touch test-control paths from a unified diff.

    The input may be raw bytes (as returned by Runtime.read) or text. Every
    name-bearing header line (diff --git, ---, +++, rename/copy) is resolved with
    git's unquoting and prefix rules, a section is dropped when any resolved path
    is test-control, and a header the resolver cannot read raises, so no header
    form smuggles a test-control file past the check. A patch without a
    diff --git header is rejected so traditional header-less diffs cannot bypass
    the filter.
    """
    patch = _decode_patch(raw)
    kept: list[str] = []
    current: list[str] = []
    paths: list[str] = []
    saw_header = False
    saw_hunk = False
    old_left = new_left = 0

    def flush() -> None:
        if current and not any(map(TEST_CONTROL.fullmatch, paths)):
            kept.extend(current)

    for line in patch.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if not saw_header and current:
                # Content before the first header is traditional-diff preamble:
                # git apply can still apply it, so it cannot bypass the filter.
                raise RuntimeError(
                    "candidate patch has content before the first diff --git header; refusing to filter",
                )
            flush()
            current, paths = [line], _git_header_paths(line)
            saw_header, saw_hunk, old_left, new_left = True, False, 0, 0
        elif old_left > 0 or new_left > 0:
            # git's parse_fragment: '-' consumes an old line, '+' a new line, context both,
            # '\\ No newline' none; the hunk ends when both counts are exhausted.
            if line.startswith("-"):
                old_left -= 1
            elif line.startswith("+"):
                new_left -= 1
            elif not line.startswith("\\"):
                old_left -= 1
                new_left -= 1
            current.append(line)
        elif line.startswith("@@"):
            saw_hunk, (old_left, new_left) = True, _hunk_counts(line)
            current.append(line)
        elif line.startswith(_NAME_HEADERS):
            if saw_hunk:
                # A header after this section's hunks is a separate (traditional) file
                # patch for git apply, so it gets its own path attribution.
                flush()
                current, paths, saw_hunk = [], [], False
            keyword = next(k for k in _NAME_HEADERS if line.startswith(k))
            text = line[len(keyword) :]
            prefixed = keyword in ("--- ", "+++ ")
            path = _header_path(text, prefixed=prefixed)
            if prefixed and path and " " in path and "\t" not in text and not text.startswith('"'):
                # git's traditional parser strips a space-separated timestamp from the
                # name; real git TAB-terminates unquoted names that contain spaces.
                raise RuntimeError(
                    f"---/+++ name has a space but no TAB; refusing to filter: {text.strip()[:80]!r}"
                )
            if path:
                paths.append(path)
            current.append(line)
        else:
            current.append(line)
    flush()
    if not saw_header and patch.strip():
        raise RuntimeError("candidate patch has no diff --git header; refusing to filter")
    return "".join(kept)
