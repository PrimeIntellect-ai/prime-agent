---
name: autoresearch
description: Run long-horizon, publication-grounded research with a retained trajectory supervisor, four hostile reviewer roles, claim provenance, canonical lineage, and cycle-level stagnation checks. Use for autonomous literature-to-problem discovery, autoresearch, AI scientist, research-gap, or sustained novelty-search tasks.
---

# Autoresearch

Use this skill for research **problem discovery**. It is not a general note
store and does not make an unsupported claim true. The TypeScript host owns
the durable state and stagnation calculation; the Python API is a typed bridge.

## Required loop

### Execution discipline

Treat this loaded skill as the API contract. Do **not** spend tool turns reading
this `SKILL.md`, calling `inspect`, printing `dir(autoresearch)`, or reading the
Python/TypeScript implementation. The first Python action of a new run must be
`await autoresearch.initialize(...)`; on a resumed run it must be
`await autoresearch.get_state()`. Then begin evidence search immediately. Use
the returned `execution_contract` instead of guessing function names or
arguments. If the contract is no longer visible, call
`autoresearch.execution_contract()` exactly once. Surface a real error if one
occurs, and fix that specific error instead of exploring the implementation. This rule is
especially important for fast/Flash models because runtime introspection can
consume the provider quota without creating any durable research state.

1. Call `await autoresearch.initialize(objective, topic=...)` once. This creates
   or recovers one retained supervisor child.
   If the root process restarts after a cycle was durably committed but before
   its supervisor reply was collected, call
   `await autoresearch.retry_supervision(latest_unsupervised_cycle_id)`. Never
   submit that cycle again: the retry API rebinds a fresh supervisor and
   redelivers the existing host-owned checkpoint.
2. Begin with publications. Use Prime's native search/web tools for broad
   discovery, synonym expansion, references, citations, related work, and
   recent papers. Use Crossref, arXiv, and Unpaywall as verification/full-text
   helpers. Read legal full text where possible and add each important work
   with `add_publication`. For every serious candidate, bind the query, source,
   result URLs, and inspected verified papers with `record_search` for each
   applicable coverage category.
3. Add claims with exact evidence bindings. Promote only claims whose wording
   is supported. Keep contradictions and unresolved objections visible.
4. Build a candidate, then call `await autoresearch.review_candidate(candidate)`.
   The host—not the root model—spawns and binds the literature auditor,
   prior-art killer, experimental critic, and top-tier editor. A marked JSON
   verdict is accepted only from the child assigned to that candidate and role.
   This is required even when the candidate will be rejected or revised.
5. Call `complete_cycle` after **every** major cycle, including rejection,
   revision, prior-art collision, or experimental failure. The host compares
   the complete field map, counts genuinely new publication identities,
   evaluates prototype stagnation heuristics, and messages the supervisor.
6. `complete_cycle` waits for and ingests the retained supervisor's marked JSON
   response by default. The supervisor may redirect search but may not promote
   claims or declare novelty. `record_supervision` remains available for manual
   recovery of an unmarked response, but manual recovery can never clear the
   final stop gate.
7. Record preliminary work with `record_experiment`; completed results require
   artifact paths, metrics, results, interpretation, and confounds. The host
   resolves and SHA-256-hashes every artifact, then rechecks those receipts
   before experimental evidence can support promotion or the final gate.
8. End problem discovery only after `stop_gate()` passes. Final
   `export_deliverable()` is blocked until then and returns all 18 roadmap
   sections.

Never skip the supervisor checkpoint because a candidate failed.

## Search, verification, and full text

Search with the agent's normal tools first. Do not depend on a separate
scholarly graph API or declare novelty from one query. Once a paper matters to
the argument, verify and inspect it:

```python
verified = await autoresearch.crossref_verify("10.1234/example")
recent = await autoresearch.arxiv_search(
    'all:"agent memory" AND submittedDate:[202501010000 TO 202612312359]'
)
oa = await autoresearch.unpaywall_lookup("10.1234/example")
artifact = await autoresearch.download_open_full_text(
    oa["full_text_url"], filename="example-paper"
)
```

Search helpers return candidate identities, never authoritative status fields.
`add_publication` immediately asks a fixed-domain host verifier to resolve the
DOI through Crossref or the preprint ID through arXiv. The host records a
metadata digest and receipt; callers cannot submit `publication_status` or
`metadata_verified_by`. A Crossref journal/proceedings registration with a
container establishes only `published`; other Crossref records stay
`published_status_unclear`, and arXiv-only records stay `preprint`. To establish
`peer_reviewed_verified`, call `verify_peer_review(paper_id, evidence_url,
exact_quote)`. The host resolves the DOI, restricts the evidence page to the
exact DOI item page on the publisher host, pins each request to the public DNS
address it vetted before that redirect, downloads it with a byte limit, and
requires a complete item-specific positive sentence in visible, applicable
page context. Negative, uncertain, cropped, hidden, or generic policy wording
cannot upgrade the item.
Contact emails are read from `CROSSREF_MAILTO` and `UNPAYWALL_EMAIL` and are
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

`remember`, `sync_nooa_memory`, `recall`, `spontaneous_recall`, and
`reflect_memory` use NVIDIA NOOA 0.0.8 through a
pinned Python 3.13 `uv` sidecar. Prime's model, provider, and main Python runtime
are unchanged. Canonical records remain host-owned; NOOA supplies its real
hashing embeddings, dense+sparse candidate retrieval, ACT-R scoring, and graph
spread. If the sidecar is unavailable, recall reports the reason and uses the
host lexical index as a lossless fallback. Inspect `nooa_backend_status()` and
the returned `nooa` receipt rather than assuming it ran.

Initialization and every completed cycle return a bounded, non-reinforcing
`spontaneous_recall` context for the next research step. Official NOOA
consolidation runs automatically every five cycles, after a supervisor
intervention, and when a candidate is promoted; its maintenance report and any
newly archived NOOA memory IDs are recorded in canonical maintenance history.
NOOA pruning never deletes or invalidates the lossless host memory ledger.
Later host syncs preserve NOOA's access counters, graph edges, rescored
importance, and sidecar archive tombstones instead of recreating those records.

## Publication and claim API

```python
await autoresearch.add_publication({
    "paper_id": "doi:10.1234/example",
    "title": "Example",
    "authors": ["A. Author"],
    "year": 2026,
    "venue": "Example Conference",
    "doi": "10.1234/example",
    "full_text_url": "https://example.org/paper.pdf",
})

await autoresearch.verify_peer_review(
    "doi:10.1234/example",
    "https://example.org/articles/example",
    "This article underwent peer review before publication.",
)

claim = await autoresearch.add_claim({
    "claim_text": "The evaluated methods share assumption A.",
    "claim_type": "SHARED_ASSUMPTION",
    "confidence": "medium",
    "supporting_evidence": [{
        "source_type": "publication",
        "source_id": "doi:10.1234/example",
        "exact_pointer": "Section 3, p. 5",
        "evidence_kind": "text",
        "exact_quote": "The method requires A during every training update.",
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
types require publication evidence before promotion. Textual publication
evidence requires `exact_quote`; use `evidence_kind` of `figure`, `table`, or
`result` for genuinely non-textual evidence instead of inventing a quote.

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
await autoresearch.review_candidate(candidate)
```

Before completing a surviving/promoted candidate, record all eight search
categories. Each receipt must cite at least one public HTTPS result and one
paper already present in the host-verified publication ledger:

```python
await autoresearch.record_search(
    candidate,
    coverage_kind="mechanism_queries",
    query='"evidence authority" agent memory mechanism',
    source="google_search",
    result_urls=["https://example.org/search-result"],
    inspected_paper_ids=["doi:10.1234/example"],
)
```

Coverage kinds are `mechanism_queries`, `synonyms_and_adjacent`,
`backward_references`, `forward_citations`, `related_recommendations`,
`recent_12_to_24_months`, `recent_preprints`, and `surveys_or_reviews`.
Allowed sources are `google_search`, `arxiv`, `crossref`, `publisher`,
`repository`, `citation_graph`, and `other`.

Complete the cycle with the candidate, the publications first encountered in
that cycle, and the **entire current** field map. Do not pass problem-gate
booleans or reviewer verdicts. The host derives all eight gates from verified
publication/search/experiment receipts and evidence-rich results from its
assigned reviewer children:

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
    "motivation_paper_ids": ["doi:10.1234/example", "arxiv:2608.12345"],
    "closest_prior_work_paper_ids": ["doi:10.1234/example"],
    "preliminary_evidence_experiment_ids": [],
    "canonical_promotion_ids": [],
})
```

Every completed major cycle requires all four host-bound reviewer roles.
`survived` and `promoted` additionally require all four verdicts to pass, all
eight host-derived problem gates, reviewer query/paper/evidence receipts,
host-derived complete search coverage, at least two
verified motivation papers, and a ledger-backed closest-prior-work comparison.
`promoted` additionally requires
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
