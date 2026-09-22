"""Pure scorer for the swarm-fanout eval.

The scorer consumes a fixture manifest plus a recorded outcome dict and
applies the orchestration rubric. It never runs the agent; the runner
records the outcome and calls in, so every rule below is unit-testable
without a model or network.

Rubric (all four are required for a resolved run):
  - coverage: every shard's answer appears in combined-index.md and
    matches the machine-computed expected value from the fixture.
  - delegation evidence: at least one live depth-1 spawn edge per shard,
    each with a distinct childId and distinct name in the RLM ledger, and
    at least one sub-* child session dir per shard holding a session
    file. A parent that answers everything itself fails here.
  - dedup: no shard's worker name is spawned twice while another child
    for that shard is still live, and total depth-1 spawns stay within
    one retry per shard (2x the shard count).
  - receipt completeness: every depth-1 child (live or deleted) has a
    parent-visible reply or an explicit child failure/terminal notice in
    the parent transcript. A silently dropped child fails here.

Efficiency (tokens, turns, wall time) is informational until a
single-agent baseline datapoint exists.
"""

from __future__ import annotations

import json
import os
import re

LEDGER_OPS = {"meta", "spawn", "rename", "delete"}
NOTICE_CUSTOM_TYPES = {"rlm_child_terminal_notice", "rlm_child_failure"}
REPLY_CUSTOM_TYPE = "agent_message"

# One "- <shard>: <answer>" bullet per line; the shard name may not
# contain a colon, the answer is everything after the first colon.
ANSWER_LINE = re.compile(r"^\s*[-*]\s+(.+?):\s*(.*?)\s*$")


def score_fixture(fixture: dict, outcome: dict) -> dict:
    """Apply the swarm-fanout rubric to one recorded outcome."""
    records, malformed = parse_ledger(outcome.get("ledger_text", ""))
    edges = replay_edges(records)
    answers = parse_answers(outcome.get("artifact_text", ""))
    coverage = score_coverage(fixture, answers)
    delegation = score_delegation(fixture, edges, outcome.get("child_session_dirs", {}))
    dedup = score_dedup(fixture, records)
    receipts = score_receipts(edges, outcome.get("parent_transcript_text", ""))
    usage = outcome.get("usage") or {}
    resolved = (
        coverage["coverage"] and delegation["delegation_evidence"] and dedup["dedup"] and receipts["receipts"]
    )
    return {
        "fixture": fixture.get("name"),
        "resolved": resolved,
        "coverage": coverage["coverage"],
        "missing_shards": coverage["missing_shards"],
        "wrong_answers": coverage["wrong_answers"],
        "delegation_evidence": delegation["delegation_evidence"],
        "live_depth1_edges": delegation["live_depth1_edges"],
        "distinct_worker_names": delegation["distinct_worker_names"],
        "child_session_dirs": delegation["child_session_dirs"],
        "verified_shard_workers": delegation["verified_shard_workers"],
        "dedup": dedup["dedup"],
        "duplicate_spawns": dedup["duplicate_spawns"],
        "total_spawns": dedup["total_spawns"],
        "spawn_budget": dedup["spawn_budget"],
        "receipts": receipts["receipts"],
        "missing_receipts": receipts["missing_receipts"],
        "ledger_malformed_lines": malformed,
        "tokens_used": int(usage.get("tokens", 0)),
        "turns": int(usage.get("turns", 0)),
        "wall_time_s": float(outcome.get("wall_time_s", 0.0)),
    }


def parse_ledger(ledger_text: str) -> tuple[list[dict], int]:
    """Parse ledger JSONL, skipping blank and malformed lines.

    The product ledger fails closed on malformed lines; the scorer is a
    passive reader of a possibly torn artifact, so malformed lines are
    skipped and counted in the result for diagnosis. Each record's fields
    are validated against the product schema (parseLedgerLine) before it
    is replayed: a structurally invalid spawn line must not count as
    delegation evidence. Records with a valid envelope but an unknown op
    are skipped silently, the same forward-compat carve-out the product
    reader makes.
    """
    records: list[dict] = []
    malformed = 0
    for line in ledger_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            record = json.loads(stripped)
        except ValueError:
            malformed += 1
            continue
        if not isinstance(record, dict) or record.get("op") not in LEDGER_OPS:
            if isinstance(record, dict) and record.get("v") == 1 and isinstance(record.get("at"), str):
                continue  # unknown op: forward-compat, not a defect
            malformed += 1
            continue
        if not _valid_ledger_record(record):
            malformed += 1
            continue
        records.append(record)
    return records, malformed


def _is_string(value: object) -> bool:
    return isinstance(value, str)


def _valid_ledger_record(record: dict) -> bool:
    """Field-level validation, mirroring the product's parseLedgerLine."""
    if record.get("v") != 1 or not _is_string(record.get("at")):
        return False
    op = record.get("op")
    if op == "meta":
        return _is_string(record.get("sessionsDir"))
    if not (_is_string(record.get("childId")) and _is_string(record.get("child"))):
        return False
    if op == "spawn":
        return (
            _is_string(record.get("parent"))
            and _is_string(record.get("name"))
            and isinstance(record.get("depth"), int)
            and not isinstance(record.get("depth"), bool)
        )
    if op == "rename":
        return _is_string(record.get("name"))
    return _is_string(record.get("reason"))


def replay_edges(records: list[dict]) -> dict[tuple[str, str], dict]:
    """Replay ledger records into edges, last-writer-wins per childId+child.

    The product ledger keys an edge by (childId, canonical child session
    path) - two records sharing a childId but naming different child
    sessions are two distinct edges, and a rename or delete applies only
    to the edge its own child path names. The scorer mirrors that key so
    a shadowed child cannot slip out of delegation and receipt checks.
    """
    edges: dict[tuple[str, str], dict] = {}
    for record in records:
        op = record.get("op")
        child_id = record.get("childId")
        child = record.get("child")
        if not isinstance(child_id, str) or not isinstance(child, str):
            continue
        key = (child_id, _canonical_session_path(child))
        if op == "spawn":
            edges[key] = {
                "childId": child_id,
                "parent": record.get("parent"),
                "child": record.get("child"),
                "depth": record.get("depth"),
                "name": record.get("name"),
                "deleted": None,
            }
        elif op == "rename":
            edge = edges.get(key)
            if edge is not None and isinstance(record.get("name"), str):
                edge["name"] = record["name"]
        elif op == "delete":
            edge = edges.get(key)
            if edge is not None:
                edge["deleted"] = record.get("reason")
    return edges


def _canonical_session_path(session_path: str) -> str:
    """Mirror the product's canonicalSessionPath for edge keys.

    The path is real path'd when it exists, falling back to the parent's
    real path joined with the file name, so a canonical and a plain
    spelling of the same child session share one edge key.
    """
    resolved = os.path.abspath(session_path)
    return os.path.realpath(resolved)


def parse_answers(artifact_text: str) -> dict[str, list[str]]:
    """Map shard file name to every answer given in the index bullets.

    Duplicate bullets are kept, not overwritten: a shard answered twice
    with conflicting values must not pass coverage just because one of
    the two happens to be right. Coverage requires every occurrence to
    match the expected answer.
    """
    answers: dict[str, list[str]] = {}
    for line in artifact_text.splitlines():
        match = ANSWER_LINE.match(line)
        if match is None:
            continue
        shard, answer = match.group(1), match.group(2)
        answers.setdefault(shard, []).append(answer)
    return answers


def score_coverage(fixture: dict, answers: dict[str, list[str]]) -> dict:
    """Every shard's answer must match the machine-computed expected value.

    A shard listed more than once is covered only when every occurrence
    matches: conflicting duplicates are fabricated answers, not noise.
    """
    missing: list[str] = []
    wrong: dict[str, dict] = {}
    for shard in fixture.get("shards", []):
        file = shard["file"]
        expected = str(shard["expected"])
        found = answers.get(file)
        if not found:
            missing.append(file)
        elif any(value != expected for value in found):
            wrong[file] = {"expected": expected, "found": found}
    return {
        "coverage": not missing and not wrong,
        "missing_shards": missing,
        "wrong_answers": wrong,
    }


def score_delegation(fixture: dict, edges: dict[str, dict], child_session_dirs: dict[str, list[str]]) -> dict:
    """Spawn evidence must exist per shard: ledger edges plus child dirs.

    Every shard's worker name must have a live depth-1 ledger edge, and
    every such edge must be backed by its real child session dir: the
    edge's recorded child file must exist in the collected sub-* dirs.
    A parent that answers every shard without spawning one child per
    shard fails delegation even though coverage may pass - the no-spawn
    cheat is the blind-answer analog of swe-fix-loop's blind patch, and
    helper-named children do not substitute for shard workers.
    """
    required_workers = {shard["worker"] for shard in fixture.get("shards", [])}
    live_depth1 = [edge for edge in edges.values() if edge.get("depth") == 1 and edge.get("deleted") is None]
    worker_names = {edge.get("name") for edge in live_depth1 if edge.get("name") in required_workers}
    verified_workers = 0
    claimed_sessions: set[tuple[str, str]] = set()
    for worker in required_workers:
        for edge in live_depth1:
            if edge.get("name") != worker:
                continue
            session = _edge_session_dir_and_file(edge)
            if session is None or session in claimed_sessions:
                continue
            if _session_dir_has_file(child_session_dirs, session):
                claimed_sessions.add(session)
                verified_workers += 1
                break
    passed = worker_names == required_workers and verified_workers == len(required_workers)
    return {
        "delegation_evidence": passed,
        "live_depth1_edges": len({edge["childId"] for edge in live_depth1}),
        "distinct_worker_names": len({edge.get("name") for edge in live_depth1 if edge.get("name")}),
        "child_session_dirs": len(child_session_dirs),
        "verified_shard_workers": verified_workers,
    }


def _path_segments(path: str) -> list[str]:
    """Split a recorded path on both separators, platform-independent.

    The product writes ledger paths with the host separator; on Windows
    they are backslash-joined, so splitting on "/" alone would reject
    every valid child session there.
    """
    return [segment for segment in path.replace("\\", "/").split("/") if segment]


def _edge_session_dir_and_file(edge: dict) -> tuple[str, str] | None:
    """The edge's recorded (child session dir, session file) pair."""
    child_file = edge.get("child")
    if not isinstance(child_file, str):
        return None
    segments = _path_segments(child_file)
    if len(segments) < 2:
        return None
    return segments[-2], segments[-1]


def _session_dir_has_file(child_session_dirs: dict[str, list[str]], session: tuple[str, str]) -> bool:
    """True when the recorded session file exists in the collected dirs.

    The ledger's child path points into the child's own sub-* dir; the
    runner collects the dir-to-files mapping, so a fabricated edge with
    no persisted session behind it cannot pass delegation.
    """
    child_dir, session_file = session
    return session_file in child_session_dirs.get(child_dir, [])


def score_dedup(fixture: dict, records: list[dict]) -> dict:
    """No shard may be worked by two live children; one retry per shard.

    The replay mirrors the daemon's ledger semantics: a spawn adds the
    childId to its name's live set, a delete removes it. A spawn for a
    shard's worker name while another child already holds that name is
    duplicate work. Total depth-1 spawns may not exceed two per shard,
    which is the retry budget the task prompt grants.
    """
    n_shards = len(fixture.get("shards", []))
    shard_workers = {shard["worker"] for shard in fixture.get("shards", [])}
    # A child's shard assignment is its name at spawn and survives renames:
    # renaming the first worker-events-01 child away must not free the name
    # for a second spawn while the first child is still live. Deletes are
    # the only legitimate way a shard's worker name becomes reusable.
    spawn_name: dict[str, str] = {}
    live_depth1_ids: set[str] = set()
    duplicates: list[dict] = []
    total_spawns = 0
    for record in records:
        op = record.get("op")
        child_id = record.get("childId")
        if not isinstance(child_id, str):
            continue
        if op == "spawn" and record.get("depth") == 1:
            total_spawns += 1
            name = record.get("name")
            spawn_name[child_id] = name
            if name in shard_workers and any(spawn_name.get(live_id) == name for live_id in live_depth1_ids):
                duplicates.append({"name": name, "childId": child_id})
            live_depth1_ids.add(child_id)
        elif op == "delete":
            live_depth1_ids.discard(child_id)
    budget = 2 * n_shards
    return {
        "dedup": not duplicates and total_spawns <= budget,
        "duplicate_spawns": duplicates,
        "total_spawns": total_spawns,
        "spawn_budget": budget,
    }


def score_receipts(edges: dict[str, dict], parent_transcript_text: str) -> dict:
    """Every depth-1 child must be accounted for in the parent transcript.

    A receipt is a child reply (an agent_message custom record naming the
    child's session id) or an explicit failure/terminal notice record
    naming the childId. Deleted children are still checked: deleting a
    silently failed child hides the drop, it does not receipt it.
    """
    replies: set[str] = set()
    notices: set[str] = set()
    for entry in _transcript_records(parent_transcript_text):
        if entry.get("customType") == REPLY_CUSTOM_TYPE:
            details = entry.get("details") or {}
            # Only an explicit child reply receipts a child: the daemon
            # always stamps fromRelationship on delivered messages, so a
            # record missing it (or claiming another relationship) with a
            # matching session id is not the child's reply.
            if details.get("fromRelationship") != "child":
                continue
            sender = details.get("from") or {}
            session_id = sender.get("sessionId")
            if isinstance(session_id, str) and session_id:
                replies.add(session_id)
        elif entry.get("customType") in NOTICE_CUSTOM_TYPES:
            details = entry.get("details") or {}
            child_id = details.get("childId")
            if isinstance(child_id, str) and child_id:
                notices.add(child_id)
    missing: list[dict] = []
    for edge in edges.values():
        if edge.get("depth") != 1:
            continue
        child_session_id = _session_id_from_file(edge.get("child"))
        if child_session_id in replies or edge["childId"] in notices:
            continue
        missing.append({"childId": edge["childId"], "name": edge.get("name")})
    return {"receipts": not missing, "missing_receipts": missing}


def summarize_usage(session_text: str) -> dict:
    """Sum assistant tokens and assistant turns from the session JSONL.

    In --mode json each completed assistant message is emitted once on
    message_end; turn_end repeats the same message, so only message_end
    events are counted.
    """
    tokens = 0
    turns = 0
    for line in session_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "message_end":
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = message.get("usage") or {}
        total = usage.get("totalTokens", 0)
        if not isinstance(total, int) or total <= 0:
            continue
        tokens += total
        turns += 1
    return {"tokens": tokens, "turns": turns}


def _transcript_records(transcript_text: str):
    """Yield parsed custom_message records from a session JSONL."""
    for line in transcript_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("type") == "custom_message":
            yield entry


def _session_id_from_file(session_file: object) -> str | None:
    """The ledger child path is a <session-id>.jsonl file; extract the id."""
    if not isinstance(session_file, str):
        return None
    segments = _path_segments(session_file)
    if not segments:
        return None
    name = segments[-1]
    return name[:-6] if name.endswith(".jsonl") else name
