#!/usr/bin/env python3
"""Prime Harness preflight doctor — verify the environment before trusting it.

Stdlib-only; runs under the project Python. Exit 0 = healthy (warnings OK),
exit 2 = at least one FAIL.

Usage: python harness/doctor.py [--json] [--strict]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from manifest_policy import ManifestPolicyError, load_manifest_object, marker_status, profile_minimum

SKILLS = {
    "harness-orchestrator": "harness_orchestrator",
    "sci-verify": "sci_verify",
    "evidence-ledger": "evidence_ledger",
    "external-critic": "external_critic",
    "repo-map": "repo_map",
}

KERNEL_DEPS = ["sympy", "hypothesis", "pytest", "yaml"]


def repo_root() -> Path:
    # Doctor belongs to <repo>/harness/doctor.py. Bind diagnostics to that
    # installation, never to an unrelated caller CWD used for absolute invocation.
    return Path(__file__).resolve().parent.parent


class Report:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def add(self, level: str, name: str, detail: str, fix: str = "") -> None:
        self.checks.append({"level": level, "name": name, "detail": detail, "fix": fix})

    def ok(self, name: str, detail: str) -> None:
        self.add("PASS", name, detail)

    def warn(self, name: str, detail: str, fix: str = "") -> None:
        self.add("WARN", name, detail, fix)

    def fail(self, name: str, detail: str, fix: str = "") -> None:
        self.add("FAIL", name, detail, fix)


def run_quiet(argv: list[str], timeout: int = 60, cwd: str | None = None) -> subprocess.CompletedProcess[str] | None:
    try:
        # explicit UTF-8: the Windows cp1252 default makes stdout None (crash
        # at .strip()) when a child emits bytes undefined in cp1252
        return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=timeout, cwd=cwd)
    except (OSError, subprocess.TimeoutExpired):
        return None


def configured_shell_path(root: Path) -> str | None:
    """settings.json shellPath — the FIRST step of Prime Agent's shell
    resolution (project settings override global)."""
    agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
    global_settings = Path(agent_dir).expanduser() if agent_dir else Path.home() / ".prime" / "agent"
    for settings_file in (root / ".prime" / "agent" / "settings.json", global_settings / "settings.json"):
        try:
            data = json.loads(settings_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and isinstance(data.get("shellPath"), str) and data["shellPath"].strip():
            return data["shellPath"]
    return None


def check_bash(report: Report, root: Path) -> None:
    """Mirror Prime Agent's shell resolution (utils/shell.ts): settings
    shellPath first — and when it is set but missing, Prime Agent throws
    rather than falling back, so the doctor must FAIL there too."""
    shell_path = configured_shell_path(root)
    if shell_path is not None:
        if Path(shell_path).is_file():
            report.ok("bash", f"settings shellPath = {shell_path}")
        else:
            report.fail("bash", f"settings shellPath does not exist: {shell_path} "
                        "(Prime Agent throws 'Custom shell path not found' — it does NOT fall back)",
                        "fix or remove shellPath in settings.json")
        return
    if os.name != "nt":
        bash = shutil.which("bash")
    else:
        bash = None
        for env_var in ("ProgramFiles", "ProgramFiles(x86)"):
            base = os.environ.get(env_var)
            if base and (Path(base) / "Git" / "bin" / "bash.exe").is_file():
                bash = str(Path(base) / "Git" / "bin" / "bash.exe")
                break
        bash = bash or shutil.which("bash.exe") or shutil.which("bash")
    if bash:
        report.ok("bash", bash)
    else:
        report.fail("bash", "no bash found — Prime Agent throws 'No bash shell found' at startup",
                    "install Git for Windows, or set settings.json shellPath")


def resolve_kernel_python(report: Report) -> str | None:
    explicit = os.environ.get("PRIME_AGENT_KERNEL_PYTHON")
    if explicit:
        if Path(explicit).is_file():
            report.ok("kernel-python", f"PRIME_AGENT_KERNEL_PYTHON = {explicit}")
            return explicit
        report.fail("kernel-python", f"PRIME_AGENT_KERNEL_PYTHON points at missing file: {explicit}",
                    "fix the env var or unset it")
        return None
    candidates = [os.environ.get("PRIME_AGENT_KERNEL_VENV")
                  or str(Path.home() / ".prime" / "agent" / "kernel-venv")]
    if os.name != "nt":
        # documented XDG fallback: ${XDG_DATA_HOME:-~/.local/share}/prime/agent/kernel-venv
        xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        candidates.append(str(Path(xdg) / "prime" / "agent" / "kernel-venv"))
    for venv in candidates:
        for sub in (("bin", "python"), ("Scripts", "python.exe")):
            candidate = Path(venv).joinpath(*sub)
            if candidate.is_file():
                report.ok("kernel-python", f"managed kernel venv found: {candidate}")
                return str(candidate)
    level = "managed kernel venv not found at " + " or ".join(candidates)
    if os.name == "nt":
        report.warn(
            "kernel-python",
            level + " — Prime Agent's managed venv bootstrap is POSIX-shaped and unverified on native Windows",
            "set PRIME_AGENT_KERNEL_PYTHON to a Python 3.11+ with ipykernel installed "
            "(python -m pip install ipykernel), or run Prime Agent under WSL",
        )
    else:
        report.warn("kernel-python", level, "it is created on first Prime Agent session; run one, then re-run doctor")
    return None


def check_frontmatter(skill_md: Path) -> str | None:
    text = skill_md.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return "missing YAML frontmatter fence"
    match = re.match(r"^---\r?\n(.*?)\r?\n---", text, flags=re.DOTALL)
    if not match:
        return "unterminated frontmatter"
    front = match.group(1)
    if not re.search(r"^name:\s*\S", front, flags=re.MULTILINE):
        return "frontmatter missing name"
    if not re.search(r"^description:\s*\S", front, flags=re.MULTILINE):
        return "frontmatter missing description (skill will NOT load)"
    description = re.search(r"^description:\s*(.+)$", front, flags=re.MULTILINE)
    if description and len(description.group(1)) > 1024:
        return "description exceeds 1024 chars"
    return None


def check_upstream_watch(report: Report, root: Path) -> None:
    helper = root / "harness" / "upstream_check.py"
    if not helper.is_file():
        report.fail("upstream-watch", f"missing {helper}", "re-run install.py")
        return
    try:
        spec = importlib.util.spec_from_file_location("prime_harness_upstream_check", helper)
        if spec is None or spec.loader is None:
            raise ImportError("could not create module spec")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.probe(root, check_pr=False)
    except Exception as exc:
        report.fail("upstream-watch", f"probe failed: {type(exc).__name__}: {exc}",
                    "run python -S harness/upstream_check.py --json")
        return
    comparison = result.get("comparison", {})
    status = comparison.get("status")
    reasons = comparison.get("reasons", [])
    if status == "stable":
        current = result.get("current", {}).get("prime_agent", {})
        digest = str(current.get("binary_sha256") or "")[:12]
        report.ok(
            "upstream-watch",
            f"Prime Agent {current.get('version')} hash={digest}; both Windows patch signatures present",
        )
    elif status == "uninitialized":
        report.warn(
            "upstream-watch",
            "install-time Prime Agent baseline is not recorded",
            "python -S harness/upstream_check.py --record-baseline --json",
        )
    elif status == "unavailable" and (
        not result.get("baseline_present")
        or any("install-time Prime Agent" in str(reason) for reason in reasons)
    ):
        report.warn("upstream-watch", "; ".join(map(str, reasons)),
                    "install/run Prime Agent, then explicitly replace the baseline")
    else:
        report.fail(
            "upstream-watch",
            f"{status}: " + "; ".join(map(str, reasons)),
            "run python -S harness/upstream_check.py --check-pr --json and review before refreshing baseline",
        )


def check_manifest_applicability(report: Report, root: Path, manifest: dict[str, object]) -> None:
    """Fail strict doctor when gate entries are statically inapplicable."""
    profiles = manifest.get("profiles")
    if not isinstance(profiles, dict):
        report.fail("manifest-applicability", "profiles must be an object", "regenerate or repair harness/manifest.json")
        return
    skipped: list[str] = []
    deficits: list[str] = []
    invalid: list[str] = []
    for profile_name in sorted(profiles):
        profile = profiles[profile_name]
        if not isinstance(profile, dict):
            invalid.append(f"{profile_name}: profile is not an object")
            continue
        try:
            minimum = profile_minimum(profile, str(profile_name))
        except ManifestPolicyError as exc:
            invalid.append(str(exc))
            continue
        applicable = 0
        for section in ("required", "conditional"):
            entries = profile.get(section, [])
            if not isinstance(entries, list):
                invalid.append(f"{profile_name}:{section} is not a list")
                continue
            for index, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    invalid.append(f"{profile_name}:{section}[{index}] is not an object")
                    continue
                name = str(entry.get("name") or f"{section}[{index}]")
                marker = entry.get("skip_if_missing")
                if marker is None:
                    applicable += 1
                    continue
                try:
                    present, reason = marker_status(root, marker)
                except ManifestPolicyError as exc:
                    invalid.append(f"{profile_name}:{name} {exc}")
                    continue
                if present:
                    applicable += 1
                else:
                    skipped.append(f"{profile_name}:{name} ({reason})")
        if applicable < minimum:
            deficits.append(f"{profile_name} applicable={applicable} minimum={minimum}")
    details = invalid + deficits + skipped
    if details:
        report.fail(
            "manifest-applicability", "; ".join(details),
            "run install.py <repo> --tailor, review the draft, and replace placeholder entries",
        )
    else:
        report.ok("manifest-applicability", "all profile minima and skip_if_missing markers are currently satisfiable")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true", help="fail on statically skipped manifest entries")
    args = parser.parse_args()

    report = Report()
    root = repo_root()

    # --- interpreter / OS basics -------------------------------------------
    if sys.version_info >= (3, 10):
        report.ok("python", f"{sys.version.split()[0]} at {sys.executable}")
    else:
        report.fail("python", f"Python {sys.version.split()[0]} < 3.10", "install Python >= 3.10")

    # the gate's manifest commands may start with bare `python`; verify.py
    # rewrites that to its own interpreter, but launchers/prompts still shell
    # out to `python harness/verify.py` — so the SHELL-resolved python matters
    shell_python = shutil.which("python")
    if shell_python is None:
        report.warn("shell-python", "no `python` on PATH (python3-only system?) — "
                    "burst launchers and docs invoke `python harness/verify.py`",
                    "ensure `python` resolves (alias/symlink), or adjust launchers to python3")
    elif "WindowsApps" in shell_python:
        report.warn("shell-python", f"`python` resolves to the Windows Store stub: {shell_python}",
                    "disable the App Execution Alias or put a real Python first on PATH")
    else:
        version_check = run_quiet([shell_python, "-c", "import sys; print(sys.version_info >= (3, 10))"])
        if version_check and "True" in (version_check.stdout or ""):
            report.ok("shell-python", shell_python)
        else:
            report.warn("shell-python", f"`python` on PATH ({shell_python}) is older than 3.10 or broken")

    git = run_quiet(["git", "--version"])
    if git and git.returncode == 0:
        if (root / ".git").exists():
            report.ok("git", f"{(git.stdout or '').strip()} — repo at {root}")
        else:
            report.fail("git", f"no .git found at repository root {root}", "install into a Git repository root")
    else:
        report.fail("git", "git not found on PATH", "install git")

    check_bash(report, root)

    prime_bin = shutil.which("prime-agent") or shutil.which("pi")
    if prime_bin:
        report.ok("prime-binary", prime_bin)
    else:
        report.warn("prime-binary", "neither 'prime-agent' nor 'pi' found on PATH",
                    "install Prime Agent (or run from source); the harness skills still install fine")

    kernel_python = resolve_kernel_python(report)
    check_upstream_watch(report, root)

    # --- harness files ------------------------------------------------------
    skills_dir = root / ".prime" / "agent" / "skills"
    common_hashes: set[str] = set()
    for skill_name, import_name in SKILLS.items():
        base = skills_dir / skill_name
        problems: list[str] = []
        skill_md = base / "SKILL.md"
        if not skill_md.is_file():
            report.fail(f"skill:{skill_name}", f"missing {skill_md}", "re-run install.py")
            continue
        front_problem = check_frontmatter(skill_md)
        if front_problem:
            problems.append(front_problem)
        if not (base / "pyproject.toml").is_file():
            problems.append("missing pyproject.toml (degrades to markdown-only skill)")
        init = base / "src" / import_name / "__init__.py"
        if not init.is_file():
            problems.append(f"missing src/{import_name}/__init__.py")
        else:
            compile_check = run_quiet([sys.executable, "-m", "py_compile", str(init)])
            if compile_check is None or compile_check.returncode != 0:
                problems.append(f"__init__.py does not compile: {(compile_check.stderr if compile_check else 'launch failure').strip()[:200]}")
            common = base / "src" / import_name / "_common.py"
            if common.is_file():
                import hashlib

                common_hashes.add(hashlib.sha256(common.read_bytes()).hexdigest())
            else:
                problems.append("missing _common.py")
        if problems:
            report.fail(f"skill:{skill_name}", "; ".join(problems), "re-run install.py --force")
        else:
            report.ok(f"skill:{skill_name}", "SKILL.md + pyproject + package OK")
    if len(common_hashes) > 1:
        report.warn("skill:_common", "_common.py copies have drifted apart between skills",
                    "make all copies identical (they are duplicated by design, but must match)")

    manifest = root / "harness" / "manifest.json"
    try:
        data = load_manifest_object(manifest)
        profiles_value = data.get("profiles", {})
        profiles = sorted(profiles_value) if isinstance(profiles_value, dict) else []
        if profiles:
            report.ok("manifest", f"profiles: {', '.join(profiles)}")
            if args.strict:
                check_manifest_applicability(report, root, data)
        else:
            report.fail("manifest", "no profiles defined", "edit harness/manifest.json")
    except ManifestPolicyError as exc:
        report.fail("manifest", str(exc), "fix harness/manifest.json")

    gate = run_quiet([sys.executable, str(root / "harness" / "verify.py"), "--list"], cwd=str(root))
    if gate and gate.returncode == 0:
        report.ok("gate-runner", "harness/verify.py --list OK")
    else:
        report.fail("gate-runner", "harness/verify.py --list failed",
                    (gate.stderr.strip()[:300] if gate else "could not launch"))

    settings = root / ".prime" / "agent" / "settings.json"
    try:
        settings_data = json.loads(settings.read_text(encoding="utf-8"))
        if not isinstance(settings_data, dict):
            report.fail("settings", f"settings.json must be a JSON object, got {type(settings_data).__name__}",
                        "fix .prime/agent/settings.json")
        else:
            auto_refine = settings_data.get("autoRefine", {})
            if not isinstance(auto_refine, dict):
                report.warn("settings", f"autoRefine must be an object, got {type(auto_refine).__name__}",
                            'use {"autoRefine": {"enabled": false}}')
            elif auto_refine.get("enabled") is False:
                report.ok("settings", "project settings.json valid; autoRefine disabled (governed refinement)")
            else:
                report.warn("settings", "autoRefine is NOT disabled in project settings — Prime Agent "
                            "auto-refines every 25 turns by default",
                            'add {"autoRefine": {"enabled": false}} to .prime/agent/settings.json')
    except FileNotFoundError:
        report.warn("settings", f"missing {settings}", "re-run install.py")
    except json.JSONDecodeError as exc:
        report.fail("settings", f"invalid JSON (Prime Agent will treat it as {{}} and refuse saves): {exc}",
                    "fix .prime/agent/settings.json")

    if (root / ".prime" / "agent" / "APPEND_SYSTEM.md").is_file():
        report.ok("append-system", "APPEND_SYSTEM.md present")
    else:
        report.fail("append-system", "missing .prime/agent/APPEND_SYSTEM.md (operating policy not applied)",
                    "re-run install.py")

    # --- data layer ---------------------------------------------------------
    # The ledger runs inside the KERNEL Python — its sqlite build is the one
    # that matters. Without FTS5 there, every ledger operation raises
    # (the schema's CREATE VIRTUAL TABLE fails), so this is a FAIL, not a
    # degradation. Before the first session (no kernel yet), probe the project
    # Python as a heuristic only.
    fts_probe = "import sqlite3; sqlite3.connect(':memory:').execute('CREATE VIRTUAL TABLE t USING fts5(x)')"
    if kernel_python:
        fts = run_quiet([kernel_python, "-c", fts_probe], timeout=120)
        if fts and fts.returncode == 0:
            report.ok("sqlite-fts5", "available in kernel Python (evidence ledger functional)")
        else:
            report.fail("sqlite-fts5", "FTS5 unavailable in kernel Python — every evidence_ledger "
                        "operation will raise sqlite3.OperationalError",
                        "point PRIME_AGENT_KERNEL_PYTHON at a Python built with FTS5")
    else:
        try:
            conn = sqlite3.connect(":memory:")
            conn.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
            conn.close()
            report.warn("sqlite-fts5", "kernel Python unresolved; probed project Python only (OK) — "
                        "re-run doctor after the first Prime Agent session")
        except sqlite3.OperationalError:
            report.fail("sqlite-fts5", "FTS5 unavailable in project Python — the kernel build likely "
                        "lacks it too; every evidence_ledger operation would raise",
                        "use a Python built with FTS5 (python.org builds include it)")

    artifacts_rel = "artifacts/harness"
    try:
        config = json.loads((root / "harness" / "config.json").read_text(encoding="utf-8"))
        if isinstance(config, dict):
            artifacts_rel = str(config.get("artifacts_dir", artifacts_rel))
    except (OSError, json.JSONDecodeError):
        pass
    artifacts = root / artifacts_rel
    try:
        artifacts.mkdir(parents=True, exist_ok=True)
        probe = tempfile.NamedTemporaryFile(dir=str(artifacts), delete=True)
        probe.close()
        report.ok("artifacts", f"{artifacts} writable")
    except OSError as exc:
        report.fail("artifacts", f"cannot write {artifacts}: {exc}")

    gitignore = root / ".gitignore"
    ignored = gitignore.read_text(encoding="utf-8", errors="replace") if gitignore.is_file() else ""
    if artifacts_rel.replace("\\", "/") in ignored:
        report.ok("gitignore", f"{artifacts_rel} ignored")
    else:
        report.warn("gitignore", f"{artifacts_rel} not in .gitignore — runtime files will pollute git status",
                    f"add '{artifacts_rel}/' to .gitignore (install.py does this for the default path)")

    # --- gate-side deps (project interpreter, not the kernel) ---------------
    gate_python = shell_python or sys.executable
    deps_check = run_quiet([gate_python, "-c", "import pytest, hypothesis"], timeout=120)
    if deps_check and deps_check.returncode == 0:
        report.ok("gate-deps", "pytest + hypothesis importable by the gate interpreter")
    else:
        report.warn("gate-deps", "pytest/hypothesis missing in the gate interpreter — the example "
                    "checks/ suites (and any pytest gate command) will fail until installed",
                    f'"{gate_python}" -m pip install pytest hypothesis')

    # --- kernel-side deps (only meaningful after first session) -------------
    if kernel_python:
        missing = []
        for dep in KERNEL_DEPS:
            check = run_quiet([kernel_python, "-c", f"import {dep}"], timeout=120)
            if check is None or check.returncode != 0:
                missing.append(dep)
        if not missing:
            report.ok("kernel-deps", f"kernel python imports: {', '.join(KERNEL_DEPS)}")
        else:
            report.warn("kernel-deps", f"kernel python missing: {', '.join(missing)}",
                        "skill dependencies install on the next Prime Agent session start "
                        "(uv pip install --editable per skill); re-run doctor afterwards")

    # --- output -------------------------------------------------------------
    fails = [c for c in report.checks if c["level"] == "FAIL"]
    if args.json:
        print(json.dumps({"status": "fail" if fails else "pass", "checks": report.checks}, indent=2))
    else:
        width = max(len(c["name"]) for c in report.checks)
        for check in report.checks:
            print(f"[{check['level']:<4}] {check['name']:<{width}}  {check['detail']}")
            if check["fix"] and check["level"] != "PASS":
                print(f"       {'':{width}}  fix: {check['fix']}")
        print(f"\n{'FAIL' if fails else 'OK'}: {len(fails)} failing, "
              f"{sum(1 for c in report.checks if c['level'] == 'WARN')} warnings, "
              f"{sum(1 for c in report.checks if c['level'] == 'PASS')} passing")
    return 2 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
