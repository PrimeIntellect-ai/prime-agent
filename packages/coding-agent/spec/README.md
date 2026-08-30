# Prime AVO behavioral contract

This directory is the source of truth for behavior that Prime must prove, not merely claim. The coding model is a candidate generator. It cannot mark its own implementation correct.

`requirements.json` assigns every important invariant a stable ID and describes normal behavior, failure behavior, ordering, authority, and persistence boundaries. Each invariant must pass six heterogeneous gates in this order:

1. `static`
2. `unit`
3. `integration`
4. `behavioral`
5. `adversarial`
6. `independent_review`

A linked test is only supporting evidence. It makes a requirement `partial`; it does not prove that the test ran or that the test correctly captures the specification. `verified` requires current host receipts for all six gates, a host-issued runtime trace whose event cites the requirement ID, an independent reviewer separate from the candidate generator, at least five distinct mechanisms, and evidence from at least four files. Receipts bind to a digest of the requirement's current source files, so changing an implementation makes old receipts stale. Every observed receipt also requires an HMAC from a host-held key supplied as `PRIME_AGENT_AVO_SPEC_RECEIPT_KEY`; a model-written JSON file with plausible host fields is rejected.

Run the structural checker from the repository root:

```bash
npm run check:spec-contract
```

The checker fails on malformed contracts, missing files or anchors, duplicate IDs, reused receipts, stale source digests, fake independent reviews, and any attempt to declare a requirement more proven than its evidence permits. Missing proof remains visible as `partial` or `unproven` without pretending that the repository is broken merely because an independent run has not yet been performed.

Runtime trace events must include a `satisfies` array, for example:

```json
{
  "event": "memory_recall_completed_before_candidate",
  "satisfies": ["ORDER-001"]
}
```

The next enforcement layer consumes this contract during significant AVO coding changes: affected requirements become host obligations, and canonical acceptance requires current gate receipts rather than model-authored assertions.
