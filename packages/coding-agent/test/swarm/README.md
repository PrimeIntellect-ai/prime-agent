# PR-B00A deterministic local swarm evidence

This directory is **test-only deterministic local evidence infrastructure**. It
has no production import path, does not contact a provider, and makes no change
to agent admission, retries, limits, scheduling, daemon protocol, or CLI output.
It is a B00A prerequisite only. **B00B production-path/RSS integration remains
required** before PR-B00 can be considered complete.

Run the inexpensive fixture rehearsal:

```sh
(cd packages/coding-agent && npx tsx test/swarm/rehearsal-bench.ts -- --fanout 1,4,16,64 --output /tmp/prime-agent-b00a --faults)
(cd packages/coding-agent && npx vitest --run test/swarm/swarm-evidence.test.ts)
```

Each fanout writes an owner-only (`0700` directory, `0600` files), canonical
artifact set:

- `manifest.json` — public/content-free schema input, recomputable fingerprint,
  fixed artifact hash/byte index, a deterministic-subset identity, and an
  artifact-index commitment which callers can retain out-of-band;
- `events.jsonl` — canonical runtime-timing evidence with stable `worker-NNNN`
  and `request-NNNN` joins;
- `oracle.jsonl` — exact logical event order and fields, deliberately excluding
  nondeterministic elapsed timing, suitable for byte-identical repeated runs;
- `process-samples.json` — injected sampler output and summed RSS;
- `cost-attribution.json` — exact direct/downstream input/output/cost tree;
- `summary.json` — terminal, delivery, cleanup, and fixture dispatch accounting.

Normal on-disk evidence is content-free. Arbitrary string **keys and values**,
including metadata, provider/model/error/progress text, filenames, paths,
credentials, Unicode, and split chunks are replaced before serialization.
Stable structural IDs, event type/order, counts, and numeric economics are
retained. The writer verifies the artifact immediately; `verifySwarmEvidence()`
fails closed on a missing/extra file, link, duplicate/unexpected index,
non-canonical JSON/JSONL, hash/size mismatch, fingerprint mismatch,
non-content-free key/value or event/oracle detail, malformed process sample,
oracle/event mismatch, bad event identity/order, assignment/terminal-usage
cost mismatch, summary mismatch, or invalid cost-tree/economic invariant.

## Determinism and authenticity contract

Only the normalized logical subset—`oracle.jsonl`, `cost-attribution.json`, and
`summary.json`—is deterministic. Its SHA-256 `deterministicBundleId` is stable
across equivalent fixture runs. `events.jsonl` (elapsed timings) and
`process-samples.json` (live sampler observations such as PID/RSS) are
explicitly volatile and are **not** a deterministic replay claim.

The manifest index detects ordinary at-rest corruption but is mutable with the
artifact directory. `writeSwarmEvidence(directory, evidence)` returns an opaque,
module-branded capability registered for that canonical directory and artifact
index in the current process. Pass that retained value to
`verifySwarmEvidence(directory, capability)`. A string read back from
`manifest.json` is not a capability and is rejected, and a capability issued for
another directory/bundle is rejected. The capability is deliberately neither
serialized nor reconstructible from the manifest. Durable cross-process signed
commitments, keys, and signature verification are explicitly **B00B** work.

`runSwarmBenchmark()` maps local fake assignments directly into `Promise.all`
without a queue, semaphore, retry, local limiter, or synthetic 429. Its
independent-dispatch bit is only a fixture admission assertion, not a claim
about the production path.

## Explicit B00B requirements

B00B must retain this scope boundary while adding real daemon/RLM/provider
integration: scripted exact provider stream/raw-retention policy and adversarial
canary/chunk coverage; two-model cache/tool/retry/error/abort decimal economics;
barrier/slow-fast/cancellation/backpressure/genuine-provider-429 dispatch tests;
and supervised fresh-process process-tree RSS baseline/peak/final/repetition
campaigns with platform-qualified Linux/macOS/Windows collection. The Unix `ps`
sampler here is only an injected local extension point, not a peak RSS claim.
