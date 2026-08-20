"""evidence-ledger — provenance-bearing store of verified scientific claims.

SQLite (WAL) + FTS5 at artifacts/harness/evidence.db. Zero external
infrastructure by design: the canonical record must survive kernel loss,
session loss, and machine moves with nothing but the repository checkout.

Retrieval discipline: status and commit filters come BEFORE text relevance —
a semantically similar but refuted claim must never outrank a verified one.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ._common import current_commit, harness_dir, read_json, utc_now_iso

__all__ = [
    "STATUSES",
    "record",
    "get",
    "search",
    "invalidate",
    "ingest",
    "stats",
    "run",
]

STATUSES = ("verified", "refuted", "inconclusive", "unverified", "superseded")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    claim TEXT NOT NULL,
    claim_type TEXT NOT NULL DEFAULT 'fact',
    status TEXT NOT NULL,
    assumptions TEXT NOT NULL DEFAULT '{}',
    commit_sha TEXT,
    verifier TEXT,
    artifact_paths TEXT NOT NULL DEFAULT '[]',
    confidence REAL,
    source TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    invalidated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_status ON evidence(status);
CREATE INDEX IF NOT EXISTS idx_evidence_commit ON evidence(commit_sha);
CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
    claim, notes, content=evidence, content_rowid=rowid
);
CREATE TRIGGER IF NOT EXISTS evidence_ai AFTER INSERT ON evidence BEGIN
    INSERT INTO evidence_fts(rowid, claim, notes) VALUES (new.rowid, new.claim, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS evidence_ad AFTER DELETE ON evidence BEGIN
    INSERT INTO evidence_fts(evidence_fts, rowid, claim, notes) VALUES ('delete', old.rowid, old.claim, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS evidence_au AFTER UPDATE ON evidence BEGIN
    INSERT INTO evidence_fts(evidence_fts, rowid, claim, notes) VALUES ('delete', old.rowid, old.claim, old.notes);
    INSERT INTO evidence_fts(rowid, claim, notes) VALUES (new.rowid, new.claim, new.notes);
END;
"""


def _db_path() -> Path:
    return harness_dir() / "evidence.db"


@contextmanager
def _connect():
    conn = sqlite3.connect(str(_db_path()), timeout=30)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.executescript(_SCHEMA)
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _new_id() -> str:
    stamp = utc_now_iso().replace("-", "").replace(":", "")[:15]
    return f"ev-{stamp}-{uuid.uuid4().hex[:8]}"


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    out = dict(row)
    for key in ("assumptions",):
        try:
            out[key] = json.loads(out.get(key) or "{}")
        except json.JSONDecodeError:
            pass
    for key in ("artifact_paths",):
        try:
            out[key] = json.loads(out.get(key) or "[]")
        except json.JSONDecodeError:
            pass
    out.pop("rank", None)
    return out


def record(
    claim: str,
    *,
    status: str,
    claim_type: str = "fact",
    assumptions: dict[str, Any] | None = None,
    commit_sha: str | None = None,
    verifier: str | None = None,
    artifacts: list[str] | None = None,
    confidence: float | None = None,
    source: str | None = None,
    notes: str | None = None,
) -> str:
    """Insert a claim and return its evidence id.

    `status='verified'` requires a `verifier` — an unverified claim cannot be
    laundered into the ledger as verified without naming what checked it.
    """
    claim = claim.strip()
    if not claim:
        raise ValueError("claim must be non-empty")
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}, got {status!r}")
    if status == "verified" and not verifier:
        raise ValueError("a 'verified' record requires verifier= (what verified it?)")
    if confidence is not None and not 0.0 <= float(confidence) <= 1.0:
        raise ValueError("confidence must be in [0, 1]")
    evidence_id = _new_id()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO evidence (id, claim, claim_type, status, assumptions, commit_sha, verifier, "
            "artifact_paths, confidence, source, notes, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                evidence_id, claim, claim_type, status,
                json.dumps(assumptions or {}, default=str),
                commit_sha or current_commit(),
                verifier, json.dumps(artifacts or [], default=str),
                confidence, source, notes, utc_now_iso(),
            ),
        )
    return evidence_id


def get(evidence_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM evidence WHERE id = ?", (evidence_id,)).fetchone()
    return _row_to_dict(row) if row else None


def _fts_escape(query: str) -> str:
    # Quote each term so user text can't inject FTS5 syntax (AND/OR/NEAR/(...)).
    terms = [t for t in re.split(r"\s+", query.strip()) if t]
    return " ".join('"' + t.replace('"', '""') + '"' for t in terms)


def search(
    query: str = "",
    *,
    status: str | None = "verified",
    commit_sha: str | None = None,
    include_invalidated: bool = False,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Filtered retrieval: exact id → SQL filters → FTS relevance → LIKE fallback.

    Default returns only live, verified records. Pass status=None for all
    statuses; include_invalidated=True to see superseded history.
    """
    limit = max(1, min(int(limit), 100))
    with _connect() as conn:
        if query and query.startswith("ev-"):
            row = conn.execute("SELECT * FROM evidence WHERE id = ?", (query,)).fetchone()
            if row:
                return [_row_to_dict(row)]

        conditions: list[str] = []
        params: list[Any] = []
        if status is not None:
            conditions.append("e.status = ?")
            params.append(status)
        if commit_sha is not None:
            conditions.append("e.commit_sha = ?")
            params.append(commit_sha)
        if not include_invalidated:
            conditions.append("e.invalidated_at IS NULL")
        where = (" AND " + " AND ".join(conditions)) if conditions else ""

        rows: list[sqlite3.Row] = []
        if query.strip():
            fts = _fts_escape(query)
            try:
                rows = conn.execute(
                    f"SELECT e.*, f.rank FROM evidence_fts f JOIN evidence e ON e.rowid = f.rowid "
                    f"WHERE evidence_fts MATCH ?{where} ORDER BY f.rank LIMIT ?",
                    [fts, *params, limit],
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []
            if not rows:
                like = f"%{query.strip()}%"
                rows = conn.execute(
                    f"SELECT e.* FROM evidence e WHERE (e.claim LIKE ? OR e.notes LIKE ?){where} "
                    f"ORDER BY e.created_at DESC LIMIT ?",
                    [like, like, *params, limit],
                ).fetchall()
        else:
            where_bare = where[len(" AND "):] if where else "1=1"
            rows = conn.execute(
                f"SELECT e.* FROM evidence e WHERE {where_bare} ORDER BY e.created_at DESC LIMIT ?",
                [*params, limit],
            ).fetchall()
    return [_row_to_dict(r) for r in rows]


def invalidate(evidence_id: str, reason: str) -> dict[str, Any]:
    """Mark a record invalidated (never deleted — provenance is append-only)."""
    if not reason.strip():
        raise ValueError("an invalidation reason is required")
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE evidence SET invalidated_at = ?, invalidated_by = ? WHERE id = ? AND invalidated_at IS NULL",
            (utc_now_iso(), reason.strip(), evidence_id),
        )
        if cur.rowcount == 0:
            raise KeyError(f"no live record with id {evidence_id!r}")
    result = get(evidence_id)
    assert result is not None
    return result


def ingest(path: str | os.PathLike[str], *, status_override: str | None = None) -> str:
    """Ingest an untrusted harness artifact while preserving its provenance.

    Artifact fields are self-attested, so neither ``status=pass`` nor a claimed
    method/evidence payload can create a verified record. After independently
    running the named verifier, callers must use :func:`record` explicitly.
    """
    artifact = Path(path)
    data = read_json(artifact)
    if not isinstance(data, dict):
        raise ValueError(f"{artifact} is not a JSON object")
    claim = data.get("claim") or data.get("task") or data.get("summary") or artifact.stem
    raw_status = str(data.get("status") or "unverified").lower()
    mapping = {"pass": "unverified", "verified": "unverified", "done": "unverified", "fail": "refuted",
               "counterexample_found": "refuted", "error": "inconclusive"}
    status = mapping.get(raw_status, raw_status if raw_status in STATUSES else "unverified")
    if status_override is not None:
        override = status_override.lower()
        if override not in STATUSES:
            raise ValueError(f"status_override must be one of {STATUSES}")
        if override == "verified":
            raise ValueError(
                "ingest cannot create verified evidence from self-attested artifact fields; "
                "run the verifier and call record(..., status='verified', verifier=...)"
            )
        status = override
    reported_verifier = data.get("method") or data.get("verifier") or data.get("role")
    note_fields = {
        k: data[k] for k in ("evidence", "warnings", "recommended_action") if k in data
    }
    if isinstance(reported_verifier, str) and reported_verifier.strip():
        note_fields["reported_verifier"] = reported_verifier.strip()
    if raw_status in ("pass", "verified"):
        note_fields["ingest_policy"] = f"self-attested {raw_status} remains unverified"
    return record(
        str(claim)[:2000],
        status=status,
        claim_type=str(data.get("claim_type", "artifact")),
        assumptions=data.get("assumptions") if isinstance(data.get("assumptions"), dict) else {},
        verifier=None,
        artifacts=[str(artifact)],
        source=str(data.get("source") or "ingest"),
        notes=json.dumps(note_fields, default=str)[:4000],
    )


def stats() -> dict[str, Any]:
    with _connect() as conn:
        by_status = dict(
            conn.execute("SELECT status, COUNT(*) FROM evidence WHERE invalidated_at IS NULL GROUP BY status").fetchall()
        )
        total = conn.execute("SELECT COUNT(*) FROM evidence").fetchone()[0]
        invalidated = conn.execute("SELECT COUNT(*) FROM evidence WHERE invalidated_at IS NOT NULL").fetchone()[0]
    return {"db": str(_db_path()), "total": total, "live_by_status": by_status, "invalidated": invalidated}


def run(query: str = "") -> Any:
    """Module entry point: search when given a query, stats otherwise."""
    return search(query) if query.strip() else stats()
