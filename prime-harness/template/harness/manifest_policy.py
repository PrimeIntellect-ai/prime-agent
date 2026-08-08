#!/usr/bin/env python3
"""Shared fail-closed policy for gate-profile applicability minima."""

from __future__ import annotations

from typing import Any, Iterable, Mapping

DEFAULT_MIN_APPLICABLE_CHECKS = 1
RESULT_STATUSES = frozenset({"pass", "fail", "timeout", "error", "skipped"})


class ManifestPolicyError(ValueError):
    """A manifest applicability policy value is malformed or unsafe."""


def profile_minimum(profile: Mapping[str, Any], profile_name: str = "profile") -> int:
    """Return a strictly positive minimum; booleans never count as integers."""
    value = profile.get("min_applicable_checks", DEFAULT_MIN_APPLICABLE_CHECKS)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ManifestPolicyError(
            f"profile {profile_name!r} min_applicable_checks must be an integer >= 1, got {value!r}"
        )
    return value


def validate_profiles(profiles: object) -> dict[str, int]:
    """Validate profile containers and return each effective minimum."""
    if not isinstance(profiles, dict) or not profiles:
        raise ManifestPolicyError("manifest profiles must be a non-empty object")
    minima: dict[str, int] = {}
    for name, profile in profiles.items():
        if not isinstance(name, str) or not name:
            raise ManifestPolicyError("profile names must be non-empty strings")
        if not isinstance(profile, dict):
            raise ManifestPolicyError(f"profile {name!r} must be an object")
        minima[name] = profile_minimum(profile, name)
        for section in ("required", "conditional"):
            entries = profile.get(section, [])
            if not isinstance(entries, list):
                raise ManifestPolicyError(f"profile {name!r} {section} must be a list")
    return minima


def applicable_count(results: Iterable[Mapping[str, Any]]) -> int:
    """Count checks that executed or errored before execution; skips do not count."""
    count = 0
    for index, result in enumerate(results):
        status = result.get("status")
        if status not in RESULT_STATUSES:
            raise ManifestPolicyError(f"result {index} has unsupported status {status!r}")
        if status != "skipped":
            count += 1
    return count


def coverage_fields(
    results: Iterable[Mapping[str, Any]], minimum: int, *, allow_vacuous: bool,
) -> dict[str, Any]:
    """Return deterministic fields consumed by the gate's final verdict."""
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 1:
        raise ManifestPolicyError(f"minimum must be an integer >= 1, got {minimum!r}")
    materialized = list(results)
    applicable = applicable_count(materialized)
    deficient = applicable < minimum
    return {
        "applicable_checks": applicable,
        "min_applicable_checks": minimum,
        "vacuous": deficient,
        "vacuous_allowed": bool(deficient and allow_vacuous),
        "coverage_satisfied": bool(not deficient or allow_vacuous),
    }
