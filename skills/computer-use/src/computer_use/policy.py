"""Allowlist _gate, deny-lists, risk labels, and the locked-screen check.

The user-edited settings file at ``~/.prime/agent/settings/computer-use.toml``
is the hard _gate of the computer-use safety model: every app binding and every
action re-checks it, and the skill never writes it. Decision cores take plain
data and stay IO-free; the thin shells touch disk or Quartz.
"""

from __future__ import annotations

import os

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypedDict

def _agent_dir() -> Path:
    """The agent state dir: PRIME_AGENT_CODING_AGENT_DIR overrides the default."""
    override = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
    return Path(override).expanduser() if override else Path.home() / ".prime" / "agent"


SETTINGS_PATH = _agent_dir() / "settings" / "computer-use.toml"
STATE_DIR = _agent_dir() / "state" / "computer-use"

SYSTEM_DENY: tuple[str, ...] = ("com.apple.loginwindow", "com.apple.ScreenSaver")
RISK_LABELS: tuple[str, ...] = ("low", "medium", "high")
DEFAULT_RISK = "medium"


@dataclass(frozen=True)
class Settings:
    """Normalized settings; the defaults deny every app until the file allows it."""

    allowed: tuple[str, ...] = ()
    blocked: tuple[str, ...] = ()
    system_deny: tuple[str, ...] = SYSTEM_DENY
    risk: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class GateResult:
    """One _gate decision; ``reason`` is the actionable denial text, empty when allowed."""

    allowed: bool
    reason: str
    risk: str


def _bundle_list(value: object, base: tuple[str, ...] = ()) -> tuple[str, ...]:
    """Keep the string entries of one settings list after ``base``, in order, without duplicates."""
    kept = list(base)
    if isinstance(value, list):
        for entry in value:
            if isinstance(entry, str) and entry not in kept:
                kept.append(entry)
    return tuple(kept)


def _parse_settings(raw: object) -> Settings:
    """Normalize a decoded settings document, ignoring every invalid piece."""
    if not isinstance(raw, Mapping):
        return Settings()
    apps = raw.get("apps")
    risk_raw = raw.get("risk")
    risk: dict[str, str] = {}
    if isinstance(risk_raw, Mapping):
        risk = {
            key: value
            for key, value in risk_raw.items()
            if isinstance(key, str) and value in RISK_LABELS
        }
    return Settings(
        allowed=_bundle_list(apps.get("allowed") if isinstance(apps, Mapping) else None),
        blocked=_bundle_list(apps.get("blocked") if isinstance(apps, Mapping) else None),
        system_deny=_bundle_list(raw.get("system_deny"), SYSTEM_DENY),
        risk=risk,
    )


def _load_settings(path: Path | str | None = None) -> Settings:
    """Load the settings file, falling back to the tolerant defaults on any read or parse error."""
    settings_path = Path(path) if path is not None else SETTINGS_PATH
    try:
        with open(settings_path, "rb") as handle:
            raw = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return Settings()
    return _parse_settings(raw)


def _gate(bundle_id: str, settings: Settings) -> GateResult:
    """Decide one bundle id against settings; the deny-lists win over the allowlist."""
    risk = settings.risk.get(bundle_id, DEFAULT_RISK)
    if bundle_id in settings.system_deny:
        reason = (
            f"{bundle_id} is on the system deny-list; OS authentication surfaces are "
            f"always refused. To allow an app, add its bundle id to `apps.allowed` "
            f"in {SETTINGS_PATH}."
        )
    elif bundle_id in settings.blocked:
        reason = (
            f"{bundle_id} is on the blocked list; remove it from `apps.blocked` "
            f"in {SETTINGS_PATH} to use it. To allow an app, add its bundle id "
            "to `apps.allowed` in the same file."
        )
    elif bundle_id not in settings.allowed:
        reason = (
            f"{bundle_id} is not on the allowlist. To allow it, add its bundle "
            f"id to `apps.allowed` in {SETTINGS_PATH}:\n\n    [apps]\n    "
            f'allowed = ["{bundle_id}"]\n\n'
            "The allowlist is user-edited; Prime Agent never edits it."
        )
    else:
        return GateResult(True, "", risk)
    return GateResult(False, reason, risk)


def _gate_app(bundle_id: str) -> GateResult:
    """Gate one app against the settings file on disk."""
    return _gate(bundle_id, _load_settings())


class AllowlistSummary(TypedDict):
    """The JSON-shaped allowlist view surfaced by get_state()."""

    allowed: list[str]
    blocked: list[str]
    system_deny: list[str]
    risk: dict[str, str]


def _allowlist_summary() -> AllowlistSummary:
    """Read a JSON-shaped view of the current settings for get_state()."""
    settings = _load_settings()
    return AllowlistSummary(
        allowed=list(settings.allowed),
        blocked=list(settings.blocked),
        system_deny=list(settings.system_deny),
        risk=dict(settings.risk),
    )


def _locked_from_session(session: object) -> bool:
    """Decide lock state from one session dictionary; absent or unreadable reads as unlocked.

    ``session`` is what ``CGSessionCopyCurrentDictionary`` returns: a mapping
    with ``CGSSessionScreenIsLocked`` truthy while the screen is locked, and no
    such key otherwise.
    """
    if not isinstance(session, Mapping):
        return False
    return bool(session.get("CGSSessionScreenIsLocked"))


def _screen_locked() -> bool:
    """Report whether the session screen is locked, failing open when unavailable.

    The check is advisory UX on top of the allowlist hard _gate, so a session
    that cannot be read (non-mac host, missing Quartz, API error) reads as
    unlocked and never blocks allowed work on its own.
    """
    try:
        from computer_use import _compat

        # pyobjc binds CGSessionCopyCurrentDictionary with no arguments.
        session = _compat._require_mac().quartz.CGSessionCopyCurrentDictionary()
    except Exception:
        return False
    return _locked_from_session(session)
