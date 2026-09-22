#!/usr/bin/env python3
"""Deterministic heavy-scale corpus for the interactive-resume gate.

One session file per turn count: a turn is a user message, an assistant
message carrying one `ipython` tool call (the code-preview path), and the
`toolResult` — three message rows per turn. `custom_message` rows (the
harness-digest shape) add eleven base rows plus one row per twenty turns,
so the row counts match the heavy-scale benchmark corpus:
5000 turns -> 15,261 transcript rows.

Not part of the product.
"""

from __future__ import annotations

import json
from pathlib import Path

T0 = 1789584016603


def _ts(index: int) -> str:
    return "2026-09-16T18:40:%02d.%03dZ" % (index % 60, index % 1000)


def _ipython_code(turn: int) -> str:
    return (
        "import subprocess\n"
        f"result = subprocess.run(['echo', 'corpus {turn}'], capture_output=True, text=True)\n"
        "print(result.stdout.strip())\n"
        "files = [f for f in range(3)]\n"
        "print(sorted(files))\n"
    )


def _usage(extra: int = 0) -> dict:
    return {
        "input": 100 + extra,
        "output": 20 + extra,
        "cacheRead": 10,
        "cacheWrite": 0,
        "totalTokens": 130 + extra,
        "cost": {"input": 0.1, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.12},
    }


def generate(turns: int, cwd: str) -> list[dict]:
    """The corpus entries for `turns` turns (session header included)."""
    lines: list[dict] = [
        {
            "type": "session",
            "id": "scale-corpus",
            "version": 3,
            "timestamp": "2026-09-16T18:40:16.600Z",
            "cwd": cwd,
            "rlmDepth": 0,
        }
    ]
    parent = None

    def entry(entry_type: str, fields: dict, entry_id: str, index: int) -> dict:
        record = dict(fields)
        record["type"] = entry_type
        record["id"] = entry_id
        record["parentId"] = parent
        record["timestamp"] = _ts(index)
        return record

    counter = 0

    def next_id() -> str:
        nonlocal counter
        counter += 1
        return f"{counter:08x}"[:8]

    for base in range(11):
        record = entry(
            "custom_message",
            {
                "customType": "harness_digest",
                "content": (
                    f"[harness-digest] base note {base}: persistent state summary for the scale corpus."
                ),
            },
            next_id(),
            counter,
        )
        lines.append(record)
        parent = record["id"]

    for turn in range(turns):
        record = entry(
            "message",
            {
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": f"please do task number {turn}"}],
                    "timestamp": T0 + turn,
                }
            },
            next_id(),
            counter,
        )
        lines.append(record)
        parent = record["id"]

        record = entry(
            "message",
            {
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": f"task {turn}: run the corpus command"},
                        {"type": "text", "text": f"Running the tool for task {turn}."},
                    ],
                    "toolCalls": [
                        {
                            "id": f"call_{turn:06d}",
                            "name": "ipython",
                            "arguments": {"code": _ipython_code(turn)},
                        }
                    ],
                    "api": "openai-completions",
                    "provider": "prime-inference",
                    "model": "mock-1",
                    "usage": _usage(),
                    "stopReason": "tool_calls",
                    "timestamp": T0 + turn,
                }
            },
            next_id(),
            counter,
        )
        lines.append(record)
        parent = record["id"]

        record = entry(
            "message",
            {
                "message": {
                    "role": "toolResult",
                    "toolCallId": f"call_{turn:06d}",
                    "content": [{"type": "text", "text": f"corpus {turn}\n[0, 1, 2]\n"}],
                    "isError": False,
                    "timestamp": T0 + turn,
                }
            },
            next_id(),
            counter,
        )
        lines.append(record)
        parent = record["id"]

        if (turn + 1) % 20 == 0:
            record = entry(
                "custom_message",
                {
                    "customType": "harness_digest",
                    "content": (
                        f"[harness-digest] note {turn}: persistent state summary for the scale corpus."
                    ),
                },
                next_id(),
                counter,
            )
            lines.append(record)
            parent = record["id"]

    return lines


def corpus_rows(turns: int) -> int:
    """Transcript rows the corpus yields (messages + custom rows)."""
    return 3 * turns + 11 + turns // 20


def corpus_path(turns: int, run_dir: Path, cwd: str) -> Path:
    """Write (or reuse) the deterministic corpus for `turns` under `run_dir`."""
    path = run_dir / f"scale-corpus-{turns}.jsonl"
    if not path.exists():
        entries = generate(turns, cwd)
        path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
    return path
