"""Scope cargo-deny 0.20.2's ID-wide lru exceptions to the reviewed path.

Any new lru version or direct consumer needs a fresh source audit.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"


def check_lru_scope(metadata: dict) -> None:
    packages = {package["id"]: package for package in metadata["packages"]}
    lru_ids = {package_id for package_id, package in packages.items() if package["name"] == "lru"}
    reviewed_lru_ids = {
        package_id
        for package_id in lru_ids
        if packages[package_id]["version"] == "0.12.5"
        and packages[package_id]["source"] == REGISTRY_SOURCE
    }
    if len(lru_ids) != 1 or lru_ids != reviewed_lru_ids:
        raise ValueError("lru advisory exceptions require exactly lru 0.12.5")

    reviewed_parent_ids = {
        package_id
        for package_id, package in packages.items()
        if package["name"] == "ratatui"
        and package["version"] == "0.29.0"
        and package["source"] == REGISTRY_SOURCE
    }
    consumers = {
        node["id"]
        for node in metadata["resolve"]["nodes"]
        if any(dependency["pkg"] in lru_ids for dependency in node["deps"])
    }
    if len(reviewed_parent_ids) != 1 or consumers != reviewed_parent_ids:
        names = sorted(
            f"{packages[package_id]['name']} {packages[package_id]['version']}"
            for package_id in consumers
        )
        raise ValueError(
            "lru advisory exceptions require ratatui 0.29.0 as the only direct dependent; "
            f"found {names}"
        )


if __name__ == "__main__":
    manifest = Path(__file__).resolve().parents[1] / "Cargo.toml"
    output = subprocess.check_output(
        [
            "cargo",
            "metadata",
            "--locked",
            "--format-version",
            "1",
            "--all-features",
            "--manifest-path",
            str(manifest),
        ],
        text=True,
    )
    try:
        check_lru_scope(json.loads(output))
    except ValueError as error:
        raise SystemExit(str(error)) from error
