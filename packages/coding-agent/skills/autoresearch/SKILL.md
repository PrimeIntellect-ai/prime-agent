---
name: autoresearch
description: Run long-horizon, publication-grounded research with a retained trajectory supervisor, four hostile reviewer roles, claim provenance, canonical lineage, and cycle-level stagnation checks. Use for autonomous literature-to-problem discovery, autoresearch, AI scientist, research-gap, or sustained novelty-search tasks.
---

# Autoresearch

Use this skill for research **problem discovery**. It is not a general note
store and does not make an unsupported claim true. The TypeScript host owns
the durable state and stagnation calculation; the Python API is a typed bridge.

## Required loop

1. Call `await autoresearch.initialize(objective, topic=...)` once. This creates
   or recovers one retained supervisor child.
2. Begin with publications. Use `discover_literature`, Crossref, Semantic
   Scholar graph expansion, arXiv, and Unpaywall as appropriate. Read legal full
   text where possible and verify publication identity/status separately. Add
   each important work with `add_publication`.
3. Add claims with exact evidence bindings. Promote only claims whose wording
   is supported. Keep contradictions and unresolved objections visible.
4. Build a candidate, then call `await autoresearch.review_candidate(candidate)`.
   The four children are a literature auditor, prior-art killer, experimental
   critic, and top-tier editor. Marked JSON replies are ingested automatically.
5. Call `complete_cycle` after **every** major cycle, including rejection,
   revision, prior-art collision, or experimental failure. The host compares
   the complete field map, counts genuinely new publication identities,
   evaluates prototype stagnation heuristics, and messages the supervisor.
6. `complete_cycle` waits for and ingests the retained supervisor's marked JSON
   response by default. The supervisor may redirect search but may not promote
   claims or declare novelty. `record_supervision` remains available for manual
   recovery of an unmarked response.
7. Record preliminary work with `record_experiment`; completed results require
   artifact paths, metrics, results, interpretation, and confounds.
8. End problem discovery only after `stop_gate()` passes. Final
   `export_deliverable()` is blocked until then and returns all 18 roadmap
   sections.

Never skip the supervisor checkpoint because a candidate failed.

## Scholarly discovery API

```python
found = await autoresearch.discover_literature("agent memory evidence authority")
verified = await autoresearch.crossref_verify("10.1234/example")
references = await autoresearch.semantic_scholar_expand(
    "DOI:10.1234/example", relation="references"
)
recent = await autoresearch.arxiv_search(
    'all:"agent memory" AND submittedDate:[202501010000 TO 202612312359]'
)
oa = await autoresearch.unpaywall_lookup("10.1234/example")
artifact = await autoresearch.download_open_full_text(
    oa["full_text_url"], filename="example-paper"
)
```

Crossref records deliberately use `published_status_unclear`; Crossref deposit
metadata alone is not universal proof of peer review. Confirm venue/publisher
status separately before changing that field. Semantic Scholar is a discovery
graph, not the authoritative publication-status record. arXiv records remain
`preprint` even when they include a DOI. API keys and contact emails are read
from `SEMANTIC_SCHOLAR_API_KEY`, `CROSSREF_MAILTO`, and `UNPAYWALL_EMAIL` and are
never persisted in research state.

`download_open_full_text` accepts only credential-free public HTTPS targets,
revalidates redirects, enforces a byte limit, and stores a SHA-256-addressed
artifact with user-only permissions. Call it only for a legal OA/arXiv/publisher
copy, then inspect the complete saved PDF/HTML rather than inferring from the
abstract.

The cache lives under the session's `autoresearch/api-cache` directory, uses
user-only permissions, and retries rate limits/transient server errors.

## Research memory and safe reuse

Use `remember` for `PAPER_FINDING`, `ASSUMPTION`, `CONTRADICTION`,
`NOVELTY_COLLISION`, `FAILED_DIRECTION`, `EXPERIMENT_RESULT`, `OPEN_QUESTION`,
`REVIEWER_OBJECTION`, `SUPERVISOR_INTERVENTION`, and `USEFUL_SEARCH_QUERY`.
Rejected cycles, reviewer objections, failed experiments, and supervisor
interventions are remembered automatically.

Retrieval is only a hint. Before an old procedure affects current work, create a
QCR-style reuse proposal with memory IDs, live-state bindings, applicability
conditions, a reusable procedure, and verification requirements. Call
`verify_memory_reuse` only after checking those requirements. A plan is not
usable while its status is `proposed` or `rejected`.

`remember` mirrors records into NVIDIA NOOA when `nooa-memory` is installed on a
supported Python 3.12–3.13 runtime. Prime's current Python 3.14 runtime uses the
same host-owned typed records and reuse gates as a lossless fallback; inspect
`nooa_backend_status()` rather than assuming the optional mirror is active.

## Publication and claim API

```python
await autoresearch.add_publication({
    "paper_id": "doi:10.1234/example",
    "title": "Example",
    "authors": ["A. Author"],
    "year": 2026,
    "venue": "Example Conference",
    "doi": "10.1234/example",
    "publication_status": "peer_reviewed",  # peer_reviewed | preprint | published_status_unclear
    "full_text_url": "https://example.org/paper.pdf",
    "metadata_verified_by": ["crossref", "publisher"],
})

claim = await autoresearch.add_claim({
    "claim_text": "The evaluated methods share assumption A.",
    "claim_type": "SHARED_ASSUMPTION",
    "confidence": "medium",
    "supporting_evidence": [{
        "source_type": "publication",
        "source_id": "doi:10.1234/example",
        "exact_pointer": "Section 3, p. 5",
        "demonstrates": "The method requires A during training.",
        "interpretation": "This is one instance of assumption A, not proof of field-wide consensus.",
    }],
    "contradicting_evidence": [],
    "unresolved_objections": ["Need evidence from additional method families."],
})
await autoresearch.promote_claim(claim["claim"]["claimId"])
```

When later evidence changes the picture, call `update_claim(claim_id, update)`
with additional `supporting_evidence`, `contradicting_evidence`,
`unresolved_objections`, and/or `confidence`. Adding contradictory evidence to
a canonical claim downgrades it to `contested` while preserving its lineage.
Use `invalidate_claim` when the claim is no longer supportable.

Claim types are `FIELD_PRACTICE`, `SHARED_ASSUMPTION`, `KNOWN_LIMITATION`,
`CONTRADICTION`, `PRIOR_ART`, `EMPIRICAL_OBSERVATION`,
`MECHANISTIC_HYPOTHESIS`, and `FEASIBILITY_CONSTRAINT`. Evidence source types
are `publication`, `experiment`, `dataset`, `code`, and `web`. Literature claim
types require publication evidence before promotion.

## Candidate and cycle API

A candidate must include these keys:

```python
candidate = {
    "candidate_id": "candidate-authority-not-retrieval",
    "statement": "...",
    "motivation": "...",
    "mechanistic_motivation": "...",
    "closest_prior_art": "...",
    "unresolved_questions": ["..."],
    "falsifier": "...",
    "experiment_design": "...",
    "baseline_plan": "...",
    "broader_relevance": "...",
    "requirements": ["dataset X", "API Y", "2x GPU"],
}
reviewers = await autoresearch.review_candidate(candidate)
```

Complete the cycle with the candidate, the publications first encountered in
that cycle, the **entire current** field map, reviewer JSON results, and all
problem gates:

```python
checkpoint = await autoresearch.complete_cycle({
    "candidate": candidate,
    "outcome": "rejected",  # rejected | revised | survived | experiment_failed | promoted
    "rejection_reason": "closest work already tests the same mechanism",
    "prior_art_cluster": "paper-x/paper-y authority calibration",
    "explicit_stuck": False,
    "trajectory_fingerprint": "memory retrieval policy modification",
    "publications": [],
    "field_maps": {
        "assumptions": ["..."],
        "limitations": ["..."],
        "contradictions": ["..."],
        "methods_and_evaluations": ["..."],
        "closest_prior_work": ["..."],
    },
    "reviewers": [{
        "role": "prior_art_killer",
        "verdict": "reject",
        "summary": "...",
        "objections": ["..."],
    }],
    "gates": {
        "important": True,
        "unresolved": False,
        "publication_backed": True,
        "mechanistically_motivated": True,
        "falsifiable": True,
        "feasible": True,
        "closest_prior_work_analyzed": True,
        "broader_relevance": True,
    },
    "search_coverage": {
        "mechanism_queries": True,
        "synonyms_and_adjacent": True,
        "backward_references": True,
        "forward_citations": True,
        "related_recommendations": True,
        "recent_12_to_24_months": True,
        "recent_preprints": True,
        "surveys_or_reviews": True,
    },
    "motivation_paper_ids": ["doi:10.1234/example", "arxiv:2608.12345"],
    "closest_prior_work_paper_ids": ["doi:10.1234/example"],
    "preliminary_evidence_experiment_ids": [],
    "canonical_promotion_ids": [],
})
```

`survived` and `promoted` require all four reviewer roles, all eight gates,
complete search coverage, at least two verified motivation papers, and a
ledger-backed closest-prior-work comparison. `promoted` additionally requires
an already-canonical claim and at least one completed preliminary experiment.
The host returns `progressing`, `watch`, or `intervene`; numerical trigger
thresholds are prototype heuristics, not claims about NVIDIA's private AVO
implementation.

If `delivery.error` is present, the cycle is still durable. Inspect retained
children and repair messaging before continuing; do not submit the same cycle
again merely to retry delivery.

For unattended runs, `enable_heartbeat(interval="30m")` uses Prime's existing
host scheduler to collect results and advance evidence-grounded cycles. Delete
it with `disable_heartbeat(id)` once the stop gate passes or external authority
is required.
