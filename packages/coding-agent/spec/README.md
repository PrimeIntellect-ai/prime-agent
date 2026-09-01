# Prime AVO behavioral contract

This directory is the source of truth for behavior that Prime must prove, not merely claim. The coding model is a candidate generator. It cannot mark its own implementation correct.

`requirements.json` assigns every important invariant a stable ID and describes normal behavior, failure behavior, ordering, authority, and persistence boundaries. Each invariant must pass six heterogeneous gates in this order:

1. `static`
2. `unit`
3. `integration`
4. `behavioral`
5. `adversarial`
6. `independent_review`

A linked test is only supporting evidence. It makes a requirement `partial`; it does not prove that the test ran or that the test correctly captures the specification. `verified` requires current host receipts for all six gates, a host-issued runtime trace whose event cites the requirement ID, an independent reviewer separate from the candidate generator, at least five distinct mechanisms, and evidence from at least four files. Receipts bind to a digest of the requirement's current source files, so changing an implementation makes old receipts stale. Every observed receipt also requires an Ed25519 signature verified with `PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY`; Prime never receives the corresponding private key, so a same-user model process cannot recover it from the parent environment and forge evidence.

Run the structural checker from the repository root:

```bash
npm run check:spec-contract
```

Map a candidate's changed files and enforce current external receipts with:

```bash
PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY="$(cat /independent/verifier/avo-spec-public.pem)" \
PRIME_AGENT_AVO_SPEC_RECEIPT_DIR="/host/outside/the/candidate/workspace" \
PRIME_AGENT_AVO_SPEC_RUN_ID="<active AVO task run ID>" \
npm --prefix packages/coding-agent run eval:spec-contract -- \
  --changed packages/coding-agent/src/core/avo/store.ts \
  --enforce
```

Generate the Ed25519 key pair in the independent verifier or CI boundary. Give Prime only the public PEM. Never place the private key, its path, or the retired `PRIME_AGENT_AVO_SPEC_RECEIPT_KEY` HMAC secret in the Prime process environment; same-user model tools can inspect parent process environments on Linux. A coding session rejects the retired HMAC setting rather than offering a false trust boundary.

Every signed receipt includes the exact AVO `runId`, final candidate `workspaceDigest`, and task-start `contractDigest`. Prime also freezes the independent verifier's public-key fingerprint in the task-start baseline. The live gate recomputes these bindings and rejects receipts from an older task, another candidate workspace, a changed contract, or a verifier key substituted after work began. It also fingerprints the workspace again after receipt validation to catch concurrent mutation during the gate.

The receipt directory is loaded as a read-only overlay. Signed receipts can promote linked evidence for the current run without modifying the candidate-owned manifest. A changed file under `protectedRoots` that has no requirement mapping fails enforcement rather than disappearing from coverage.

The checker fails on malformed contracts, missing files or anchors, duplicate IDs, reused receipts, stale source digests, fake independent reviews, and any attempt to declare a requirement more proven than its evidence permits. Missing proof remains visible as `partial` or `unproven` without pretending that the repository is broken merely because an independent run has not yet been performed.

Runtime trace events must include a `satisfies` array, for example:

```json
{
  "event": "memory_recall_completed_before_candidate",
  "satisfies": ["ORDER-001"]
}
```

The live AVO completion gate snapshots this contract before candidate work, discovers it from the Git workspace root even when Prime starts in a subdirectory, and maps the final workspace delta back to the retained requirements. Any changed protected file without a requirement, any candidate edit to the contract, or any affected requirement without all six current independently signed gates blocks canonical delivery. Repositories without an executable contract keep the ordinary AVO coding gate.
