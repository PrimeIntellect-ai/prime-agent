"""Publication-grounded autoresearch over Prime Agent's host-owned state."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

from rlm import host_request


_USER_AGENT = "Prime-Agent-Autoresearch/0.1 (scholarly metadata client)"
_REVIEWER_ROLES = {
    "literature_auditor",
    "prior_art_killer",
    "experimental_critic",
    "top_tier_editor",
}


def _validate_public_https_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("full-text URL must be credential-free HTTPS")
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    if not addresses:
        raise ValueError("full-text URL hostname did not resolve")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("full-text URL must resolve only to public Internet addresses")


class _PublicHttpsRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        _validate_public_https_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _object(value: dict[str, Any], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be a dict, got {type(value).__name__}")
    return value


def _cache_root() -> Path | None:
    session_dir = os.environ.get("RLM_SESSION_DIR")
    if not session_dir:
        return None
    return Path(session_dir) / "autoresearch" / "api-cache"


def _cached_bytes(url: str, headers: dict[str, str], ttl_seconds: int = 86_400) -> bytes:
    root = _cache_root()
    cache_path = root / f"{hashlib.sha256(url.encode()).hexdigest()}.json" if root else None
    if cache_path and cache_path.exists() and time.time() - cache_path.stat().st_mtime <= ttl_seconds:
        return cache_path.read_bytes()
    request = Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json", **headers})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                content = response.read()
            break
        except HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise
            if attempt == 2:
                raise
            retry_after = error.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else 2**attempt)
    else:  # pragma: no cover - the retry loop always returns or raises
        raise RuntimeError("scholarly request exhausted retries")
    if cache_path:
        root.mkdir(parents=True, exist_ok=True)
        temporary = cache_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        temporary.write_bytes(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, cache_path)
    return content


def _request_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    payload = json.loads(_cached_bytes(url, headers or {}).decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"scholarly API returned {type(payload).__name__}, expected object")
    return payload


def _crossref_year(item: dict[str, Any]) -> int | None:
    for key in ("published-print", "published-online", "published", "issued", "created"):
        value = item.get(key)
        if not isinstance(value, dict):
            continue
        parts = value.get("date-parts")
        if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]:
            year = parts[0][0]
            if isinstance(year, int):
                return year
    return None


def _crossref_publication(item: dict[str, Any]) -> dict[str, Any]:
    doi = str(item.get("DOI", "")).strip()
    titles = item.get("title")
    title = str(titles[0]).strip() if isinstance(titles, list) and titles else doi
    authors: list[str] = []
    for author in item.get("author", []):
        if isinstance(author, dict):
            name = " ".join(str(author.get(part, "")).strip() for part in ("given", "family")).strip()
            if name:
                authors.append(name)
    containers = item.get("container-title")
    links = item.get("link")
    full_text_url = None
    if isinstance(links, list):
        full_text_url = next(
            (str(link.get("URL")) for link in links if isinstance(link, dict) and link.get("URL")),
            None,
        )
    publication: dict[str, Any] = {
        "paper_id": f"doi:{doi.lower()}" if doi else f"crossref:{hashlib.sha256(title.encode()).hexdigest()[:20]}",
        "title": title,
        "authors": authors or ["Unknown author"],
    }
    if doi:
        publication["doi"] = doi
    year = _crossref_year(item)
    if year:
        publication["year"] = year
    if isinstance(containers, list) and containers:
        publication["venue"] = str(containers[0])
    if full_text_url:
        publication["full_text_url"] = full_text_url
    if not doi and not full_text_url:
        publication["full_text_url"] = str(item.get("URL", "https://api.crossref.org"))
    return publication


async def initialize(objective: str, topic: str | None = None) -> dict[str, Any]:
    """Initialize one session-local research run and retain its supervisor child."""
    if not isinstance(objective, str):
        raise TypeError(f"objective must be str, got {type(objective).__name__}")
    if topic is not None and not isinstance(topic, str):
        raise TypeError(f"topic must be str or None, got {type(topic).__name__}")
    payload: dict[str, Any] = {"objective": objective}
    if topic is not None:
        payload["topic"] = topic
    return await host_request("autoresearch.initialize", payload)


async def get_state() -> dict[str, Any]:
    """Return the host-owned research state for the current root session."""
    return await host_request("autoresearch.get")


async def crossref_search(
    query: str,
    *,
    rows: int = 10,
    from_year: int | None = None,
    mailto: str | None = None,
) -> list[dict[str, Any]]:
    """Search Crossref metadata without treating deposit metadata as peer-review proof."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(rows, int) or not 1 <= rows <= 100:
        raise ValueError("rows must be an integer from 1 to 100")
    params: dict[str, str | int] = {"query.bibliographic": query, "rows": rows}
    if from_year is not None:
        if not isinstance(from_year, int):
            raise TypeError(f"from_year must be int or None, got {type(from_year).__name__}")
        params["filter"] = f"from-pub-date:{from_year}-01-01"
    email = mailto or os.environ.get("CROSSREF_MAILTO")
    if email:
        params["mailto"] = email
    payload = await asyncio.to_thread(_request_json, f"https://api.crossref.org/works?{urlencode(params)}")
    message = payload.get("message")
    items = message.get("items", []) if isinstance(message, dict) else []
    return [_crossref_publication(item) for item in items if isinstance(item, dict)]


async def crossref_verify(doi: str, *, mailto: str | None = None) -> dict[str, Any]:
    """Resolve one DOI against Crossref and return a publication-ledger record."""
    if not isinstance(doi, str):
        raise TypeError(f"doi must be str, got {type(doi).__name__}")
    params = {}
    email = mailto or os.environ.get("CROSSREF_MAILTO")
    if email:
        params["mailto"] = email
    suffix = f"?{urlencode(params)}" if params else ""
    payload = await asyncio.to_thread(
        _request_json,
        f"https://api.crossref.org/works/{quote(doi.strip(), safe='')}{suffix}",
    )
    message = payload.get("message")
    if not isinstance(message, dict):
        raise RuntimeError("Crossref DOI response omitted message metadata")
    return _crossref_publication(message)


async def arxiv_search(query: str, *, max_results: int = 10, start: int = 0) -> list[dict[str, Any]]:
    """Search arXiv's Atom API and return preprint records with legal full-text URLs."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(max_results, int) or not 1 <= max_results <= 100:
        raise ValueError("max_results must be an integer from 1 to 100")
    if not isinstance(start, int) or start < 0:
        raise ValueError("start must be a non-negative integer")
    params = urlencode(
        {
            "search_query": query if ":" in query else f"all:{query}",
            "start": start,
            "max_results": max_results,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        }
    )
    content = await asyncio.to_thread(
        _cached_bytes,
        f"https://export.arxiv.org/api/query?{params}",
        {"Accept": "application/atom+xml"},
    )
    root = ET.fromstring(content)
    atom = "{http://www.w3.org/2005/Atom}"
    arxiv = "{http://arxiv.org/schemas/atom}"
    publications: list[dict[str, Any]] = []
    for entry in root.findall(f"{atom}entry"):
        identifier = (entry.findtext(f"{atom}id") or "").rsplit("/", 1)[-1]
        base_id = re.sub(r"v\d+$", "", identifier)
        title = " ".join((entry.findtext(f"{atom}title") or "").split())
        authors = [
            " ".join((author.findtext(f"{atom}name") or "").split())
            for author in entry.findall(f"{atom}author")
        ]
        published = entry.findtext(f"{atom}published") or ""
        doi = entry.findtext(f"{arxiv}doi")
        pdf_url = next(
            (
                link.attrib.get("href")
                for link in entry.findall(f"{atom}link")
                if link.attrib.get("type") == "application/pdf"
            ),
            f"https://arxiv.org/pdf/{identifier}",
        )
        publication: dict[str, Any] = {
            "paper_id": f"arxiv:{base_id.lower()}",
            "title": title,
            "authors": authors or ["Unknown author"],
            "preprint_id": base_id,
            "full_text_url": pdf_url,
            "abstract": " ".join((entry.findtext(f"{atom}summary") or "").split()),
        }
        if published[:4].isdigit():
            publication["year"] = int(published[:4])
        if doi:
            publication["doi"] = doi
        publications.append(publication)
    return publications


async def unpaywall_lookup(doi: str, *, email: str | None = None) -> dict[str, Any]:
    """Look up a DOI's legal OA locations; an email is required by Unpaywall."""
    contact = email or os.environ.get("UNPAYWALL_EMAIL") or os.environ.get("CROSSREF_MAILTO")
    if not contact:
        raise ValueError("Unpaywall requires email= or UNPAYWALL_EMAIL/CROSSREF_MAILTO")
    payload = await asyncio.to_thread(
        _request_json,
        f"https://api.unpaywall.org/v2/{quote(doi.strip(), safe='')}?{urlencode({'email': contact})}",
    )
    best = payload.get("best_oa_location") if isinstance(payload.get("best_oa_location"), dict) else {}
    return {
        "doi": payload.get("doi", doi),
        "is_oa": payload.get("is_oa", False),
        "oa_status": payload.get("oa_status"),
        "full_text_url": best.get("url_for_pdf") or best.get("url_for_landing_page"),
        "host_type": best.get("host_type"),
        "license": best.get("license"),
        "metadata_verified_by": ["unpaywall"],
    }


def _download_open_full_text(url: str, filename: str | None, max_bytes: int) -> dict[str, Any]:
    _validate_public_https_url(url)
    session_dir = os.environ.get("RLM_SESSION_DIR")
    if not session_dir:
        raise RuntimeError("RLM_SESSION_DIR is required for durable full-text downloads")
    request = Request(url, headers={"User-Agent": _USER_AGENT})
    opener = build_opener(_PublicHttpsRedirectHandler())
    with opener.open(request, timeout=60) as response:
        content_type = response.headers.get_content_type()
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = response.read(min(1024 * 1024, max_bytes - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise ValueError(f"full text exceeds max_bytes={max_bytes}")
            chunks.append(chunk)
    content = b"".join(chunks)
    suffixes = {
        "application/pdf": ".pdf",
        "text/html": ".html",
        "application/xhtml+xml": ".html",
        "text/plain": ".txt",
        "application/xml": ".xml",
        "application/atom+xml": ".xml",
    }
    suffix = suffixes.get(content_type, Path(urlparse(url).path).suffix[:10] or ".bin")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", filename or Path(urlparse(url).path).stem).strip("-.")
    stem = stem[:100] or hashlib.sha256(url.encode()).hexdigest()[:20]
    root = Path(session_dir) / "autoresearch" / "fulltext"
    root.mkdir(parents=True, exist_ok=True)
    destination = root / f"{stem}-{hashlib.sha256(url.encode()).hexdigest()[:12]}{suffix}"
    temporary = destination.with_suffix(f"{destination.suffix}.{uuid.uuid4().hex}.tmp")
    temporary.write_bytes(content)
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)
    return {
        "path": str(destination),
        "url": url,
        "content_type": content_type,
        "bytes": size,
        "sha256": hashlib.sha256(content).hexdigest(),
    }


async def download_open_full_text(
    url: str,
    *,
    filename: str | None = None,
    max_bytes: int = 50 * 1024 * 1024,
) -> dict[str, Any]:
    """Download a declared legal OA/arXiv copy to session artifacts for full inspection."""
    if not isinstance(url, str):
        raise TypeError(f"url must be str, got {type(url).__name__}")
    if filename is not None and not isinstance(filename, str):
        raise TypeError(f"filename must be str or None, got {type(filename).__name__}")
    if not isinstance(max_bytes, int) or not 1 <= max_bytes <= 250 * 1024 * 1024:
        raise ValueError("max_bytes must be an integer from 1 to 262144000")
    return await asyncio.to_thread(_download_open_full_text, url, filename, max_bytes)


async def add_publication(publication: dict[str, Any]) -> dict[str, Any]:
    """Add an identity, then ask the host to verify its metadata and status."""
    candidate = dict(_object(publication, "publication"))
    for key in ("publication_status", "publicationStatus", "metadata_verified_by", "metadataVerifiedBy"):
        candidate.pop(key, None)
    added = await host_request("autoresearch.publication.add", {"publication": candidate})
    recorded = added.get("publication")
    paper_id = recorded.get("paperId") if isinstance(recorded, dict) else None
    if not isinstance(paper_id, str):
        raise RuntimeError("autoresearch.publication.add returned no paperId")
    return await verify_publication(paper_id)


async def verify_publication(paper_id: str) -> dict[str, Any]:
    """Run fixed-domain host verification for a recorded DOI or arXiv identity."""
    if not isinstance(paper_id, str):
        raise TypeError(f"paper_id must be str, got {type(paper_id).__name__}")
    return await host_request("autoresearch.publication.verify", {"paper_id": paper_id})


async def record_experiment(experiment: dict[str, Any]) -> dict[str, Any]:
    """Plan, update, fail, or complete an experiment with inspectable artifacts."""
    return await host_request(
        "autoresearch.experiment.record",
        {"experiment": _object(experiment, "experiment")},
    )


def nooa_backend_status() -> dict[str, Any]:
    """Describe the pinned Python 3.13 NOOA sidecar without changing Prime's provider."""
    uv = shutil.which("uv")
    session_dir = os.environ.get("RLM_SESSION_DIR")
    if not uv:
        return {"available": False, "backend": "host_owned_fallback", "reason": "uv is unavailable"}
    if not session_dir:
        return {
            "available": False,
            "backend": "host_owned_fallback",
            "reason": "RLM_SESSION_DIR is unset",
        }
    return {
        "available": True,
        "backend": "nooa_memory_sidecar",
        "package": "nooa-memory==0.0.8",
        "runtime": "python3.13",
        "provider_unchanged": True,
    }


def _run_nooa_sidecar(command: str, payload: dict[str, Any]) -> dict[str, Any]:
    status = nooa_backend_status()
    if not status["available"]:
        return status
    session_dir = os.environ["RLM_SESSION_DIR"]
    path = Path(session_dir) / "autoresearch" / "nooa-memory.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    sidecar = Path(__file__).with_name("nooa_sidecar.py")
    process = subprocess.run(
        [
            shutil.which("uv") or "uv",
            "run",
            "--no-project",
            "--python",
            "3.13",
            "--with",
            "nooa-memory==0.0.8",
            "python",
            str(sidecar),
            command,
            str(path),
        ],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    if process.returncode != 0:
        reason = process.stderr.strip() or process.stdout.strip() or f"sidecar exited {process.returncode}"
        return {**status, "ok": False, "reason": reason[-2000:]}
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        return {**status, "ok": False, "reason": f"invalid sidecar JSON: {error}"}
    if not isinstance(result, dict):
        return {**status, "ok": False, "reason": "sidecar returned a non-object result"}
    return {**status, **result, "path": str(path)}


def _mirror_memory_to_nooa(memory: dict[str, Any]) -> dict[str, Any]:
    return _run_nooa_sidecar("upsert", {"memory": memory})


async def remember(memory: dict[str, Any], *, mirror_nooa: bool = True) -> dict[str, Any]:
    """Store typed research experience and mirror it to NOOA when compatible."""
    response = await host_request(
        "autoresearch.memory.remember",
        {"memory": _object(memory, "memory")},
    )
    recorded = response.get("memory")
    response["nooa"] = (
        await asyncio.to_thread(_mirror_memory_to_nooa, recorded)
        if mirror_nooa and isinstance(recorded, dict)
        else nooa_backend_status()
    )
    return response


async def recall(query: str, *, limit: int = 8) -> dict[str, Any]:
    """Retrieve through NOOA hybrid/ACT-R recall, with the host index as fallback."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    fallback = await host_request("autoresearch.memory.recall", {"query": query, "limit": limit})
    state_response = await get_state()
    state = state_response.get("state")
    memories = state.get("memories", []) if isinstance(state, dict) else []
    sync = await asyncio.to_thread(
        _run_nooa_sidecar,
        "sync",
        {"memories": [memory for memory in memories if isinstance(memory, dict)]},
    )
    if not sync.get("ok"):
        fallback["nooa"] = sync
        return fallback
    nooa = await asyncio.to_thread(_run_nooa_sidecar, "recall", {"query": query, "limit": limit})
    recalled_ids = nooa.get("memory_ids")
    if isinstance(recalled_ids, list):
        by_id = {
            str(memory.get("memoryId")): memory
            for memory in memories
            if isinstance(memory, dict) and memory.get("memoryId")
        }
        fallback["memories"] = [by_id[memory_id] for memory_id in recalled_ids if memory_id in by_id]
    fallback["nooa"] = nooa
    return fallback


async def sync_nooa_memory() -> dict[str, Any]:
    """Synchronize the canonical host ledger into the real NOOA vector store."""
    status = nooa_backend_status()
    if not status["available"]:
        return {**status, "mirrored": 0}
    response = await get_state()
    state = response.get("state")
    memories = state.get("memories", []) if isinstance(state, dict) else []
    return await asyncio.to_thread(
        _run_nooa_sidecar,
        "sync",
        {"memories": [memory for memory in memories if isinstance(memory, dict)]},
    )


async def prepare_memory_reuse(reuse: dict[str, Any]) -> dict[str, Any]:
    """Create a QCR-style current-state-conditioned reuse plan."""
    return await host_request(
        "autoresearch.memory.reuse.prepare",
        {"reuse": _object(reuse, "reuse")},
    )


async def verify_memory_reuse(reuse_id: str, *, accepted: bool, evidence: list[str]) -> dict[str, Any]:
    """Accept or reject a reuse plan only after its stated checks are run."""
    if not isinstance(reuse_id, str):
        raise TypeError(f"reuse_id must be str, got {type(reuse_id).__name__}")
    if not isinstance(accepted, bool):
        raise TypeError(f"accepted must be bool, got {type(accepted).__name__}")
    if not isinstance(evidence, list) or not all(isinstance(item, str) for item in evidence):
        raise TypeError("evidence must be list[str]")
    return await host_request(
        "autoresearch.memory.reuse.verify",
        {"reuse_id": reuse_id, "accepted": accepted, "evidence": evidence},
    )


async def add_claim(claim: dict[str, Any]) -> dict[str, Any]:
    """Add a proposed claim with explicit supporting and contradicting evidence bindings."""
    return await host_request("autoresearch.claim.add", {"claim": _object(claim, "claim")})


async def update_claim(claim_id: str, update: dict[str, Any]) -> dict[str, Any]:
    """Append new evidence/objections and downgrade canonical claims when contradicted."""
    if not isinstance(claim_id, str):
        raise TypeError(f"claim_id must be str, got {type(claim_id).__name__}")
    return await host_request(
        "autoresearch.claim.update",
        {"claim_id": claim_id, "update": _object(update, "update")},
    )


async def promote_claim(claim_id: str) -> dict[str, Any]:
    """Promote a sufficiently evidenced proposed claim into canonical research state."""
    if not isinstance(claim_id, str):
        raise TypeError(f"claim_id must be str, got {type(claim_id).__name__}")
    return await host_request("autoresearch.claim.promote", {"claim_id": claim_id})


async def invalidate_claim(claim_id: str, reason: str) -> dict[str, Any]:
    """Invalidate a claim while preserving its evidence and objection history."""
    if not isinstance(claim_id, str):
        raise TypeError(f"claim_id must be str, got {type(claim_id).__name__}")
    if not isinstance(reason, str):
        raise TypeError(f"reason must be str, got {type(reason).__name__}")
    return await host_request("autoresearch.claim.invalidate", {"claim_id": claim_id, "reason": reason})


async def reviewer_prompts(candidate: dict[str, Any]) -> dict[str, Any]:
    """Build the four role-separated hostile-review prompts for a candidate."""
    return await host_request("autoresearch.reviewer_prompts", {"candidate": _object(candidate, "candidate")})


async def spawn_reviewers(
    candidate: dict[str, Any],
) -> list[dict[str, Any]]:
    """Ask the host to spawn and bind all four reviewer children."""
    payload: dict[str, Any] = {"candidate": _object(candidate, "candidate")}
    response = await host_request("autoresearch.reviewers.spawn", payload)
    assignments = response.get("assignments")
    if not isinstance(assignments, list):
        raise RuntimeError("autoresearch.reviewers.spawn returned no assignments")
    return [assignment for assignment in assignments if isinstance(assignment, dict)]


async def collect_results() -> dict[str, Any]:
    """Ingest marked reviewer and supervisor replies from the root transcript."""
    return await host_request("autoresearch.results.collect")


async def await_reviews(
    candidate_id: str,
    *,
    timeout: float = 300,
    poll_interval: float = 2,
) -> list[dict[str, Any]]:
    """Wait until the host has ingested all four role-separated reviews."""
    if not isinstance(candidate_id, str):
        raise TypeError(f"candidate_id must be str, got {type(candidate_id).__name__}")
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        collected = await collect_results()
        reviews = [
            item["reviewer"]
            for item in collected.get("reviews", [])
            if isinstance(item, dict)
            and item.get("candidateId") == candidate_id
            and isinstance(item.get("reviewer"), dict)
        ]
        if {str(review.get("role")) for review in reviews} == _REVIEWER_ROLES:
            return reviews
        if asyncio.get_running_loop().time() >= deadline:
            found = sorted(str(review.get("role")) for review in reviews)
            raise TimeoutError(f"timed out waiting for four reviews for {candidate_id}; received {found}")
        await asyncio.sleep(poll_interval)


async def review_candidate(
    candidate: dict[str, Any],
    *,
    timeout: float = 300,
    poll_interval: float = 2,
) -> list[dict[str, Any]]:
    """Spawn all specialist reviewers and return their automatically ingested results."""
    await spawn_reviewers(candidate)
    candidate_id = candidate.get("candidate_id") or candidate.get("candidateId")
    if not isinstance(candidate_id, str):
        raise ValueError("candidate requires candidate_id to await its reviews")
    return await await_reviews(candidate_id, timeout=timeout, poll_interval=poll_interval)


async def complete_cycle(
    cycle: dict[str, Any],
    *,
    await_supervisor: bool = True,
    timeout: float = 300,
    poll_interval: float = 2,
) -> dict[str, Any]:
    """Commit a cycle, message the retained supervisor, and ingest its response."""
    canonical_cycle = dict(_object(cycle, "cycle"))
    canonical_cycle.pop("reviewers", None)
    response = await host_request("autoresearch.cycle.complete", {"cycle": canonical_cycle})
    cycle_result = response.get("cycle")
    cycle_id = cycle_result.get("cycleId") if isinstance(cycle_result, dict) else None
    if not await_supervisor or not isinstance(cycle_id, str) or response.get("delivery", {}).get("error"):
        response["nooa"] = await sync_nooa_memory()
        return response
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        collected = await collect_results()
        supervision = next(
            (
                item
                for item in collected.get("supervision", [])
                if isinstance(item, dict) and item.get("cycleId") == cycle_id
            ),
            None,
        )
        if supervision:
            response["supervision"] = supervision
            response["nooa"] = await sync_nooa_memory()
            return response
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError(f"timed out waiting for supervisor response for {cycle_id}")
        await asyncio.sleep(poll_interval)


async def record_supervision(supervision: dict[str, Any]) -> dict[str, Any]:
    """Record a supervisor JSON response without granting it canonical-state authority."""
    return await host_request(
        "autoresearch.supervision.record",
        {"supervision": _object(supervision, "supervision")},
    )


async def stop_gate() -> dict[str, Any]:
    """Evaluate every roadmap stop condition against durable canonical state."""
    return await host_request("autoresearch.stop_gate")


async def export_deliverable(*, final: bool = True) -> dict[str, Any]:
    """Export the 18-section dossier, blocking final export until the stop gate passes."""
    if not isinstance(final, bool):
        raise TypeError(f"final must be bool, got {type(final).__name__}")
    return await host_request("autoresearch.export", {"final": final})


async def enable_heartbeat(
    *,
    interval: str = "30m",
    label: str = "autoresearch-trajectory",
) -> dict[str, Any]:
    """Create a root-session heartbeat that keeps long-running discovery moving."""
    instruction = (
        "Continue the active autoresearch run. Collect marked reviewer/supervisor results, inspect the durable "
        "autoresearch state and stop gate, then advance one evidence-grounded research cycle. Do not skip a "
        "cycle checkpoint; stop the heartbeat once the final stop gate passes or external authority is required."
    )
    return await host_request(
        "rlm_heartbeat.create",
        {"instruction": instruction, "interval": interval, "label": label, "delivery_mode": "follow_up"},
    )


async def disable_heartbeat(heartbeat_id: str) -> dict[str, Any]:
    """Delete an autoresearch heartbeat by its host-owned identifier."""
    if not isinstance(heartbeat_id, str):
        raise TypeError(f"heartbeat_id must be str, got {type(heartbeat_id).__name__}")
    return await host_request("rlm_heartbeat.delete", {"id": heartbeat_id})


__all__ = [
    "add_claim",
    "add_publication",
    "arxiv_search",
    "await_reviews",
    "collect_results",
    "complete_cycle",
    "crossref_search",
    "crossref_verify",
    "disable_heartbeat",
    "download_open_full_text",
    "enable_heartbeat",
    "export_deliverable",
    "get_state",
    "initialize",
    "invalidate_claim",
    "nooa_backend_status",
    "prepare_memory_reuse",
    "promote_claim",
    "recall",
    "record_experiment",
    "record_supervision",
    "remember",
    "review_candidate",
    "reviewer_prompts",
    "spawn_reviewers",
    "stop_gate",
    "sync_nooa_memory",
    "unpaywall_lookup",
    "update_claim",
    "verify_memory_reuse",
]
