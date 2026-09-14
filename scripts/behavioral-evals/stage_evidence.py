#!/usr/bin/env python3
"""Create a size-bounded, symlink-free evidence tree for artifact upload."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import tempfile
from pathlib import Path

TOTAL_LIMIT = 100_000_000
LOG_LIMIT = 2_000_000
FILE_LIMIT = 50_000_000


def _plan(sources: list[Path]) -> list[tuple[Path, Path, int]]:
    files = []
    total = 0
    for source in sources:
        if source.is_symlink():
            raise ValueError(f"evidence source must be a directory: {source}")
        if not source.exists():
            continue
        if not source.is_dir():
            raise ValueError(f"evidence source must be a directory: {source}")
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"evidence must not contain symlinks: {path}")
            if not path.is_file():
                continue
            size = path.stat().st_size
            if path.suffix != ".log" and size > FILE_LIMIT:
                raise ValueError(f"evidence file exceeds its size limit: {path}")
            staged_size = min(size, LOG_LIMIT) if path.suffix == ".log" else size
            total += staged_size
            if total > TOTAL_LIMIT:
                raise ValueError("behavioral evidence exceeds its total size limit")
            relative = Path(source.name) / path.relative_to(source)
            files.append((path, relative, size))
    return files


def _copy_file(source: Path, target: Path, expected_size: int) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    with os.fdopen(descriptor, "rb") as input_stream:
        source_stat = os.fstat(input_stream.fileno())
        if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_size != expected_size:
            raise ValueError(f"evidence file changed while staging: {source}")
        size = min(expected_size, LOG_LIMIT) if source.suffix == ".log" else expected_size
        if source.suffix == ".log" and expected_size > size:
            input_stream.seek(expected_size - size)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output_stream:
            remaining = size
            while remaining:
                data = input_stream.read(min(1_048_576, remaining))
                if not data:
                    raise ValueError(f"evidence file changed while staging: {source}")
                output_stream.write(data)
                remaining -= len(data)
            if source.suffix != ".log" and input_stream.read(1):
                raise ValueError(f"evidence file changed while staging: {source}")


def stage(sources: list[Path], output: Path) -> None:
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"evidence output already exists: {output}")
    files = _plan(sources)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        for source, relative, size in files:
            _copy_file(source, staging / relative, size)
        staging.rename(output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    stage(args.source, args.output)


if __name__ == "__main__":
    main()
