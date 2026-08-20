# Deterministic evaluation corpus

`corpus.json` is the versioned public baseline corpus for governed Continual
Harness replay. Its 16 small objective physics/mathematics tasks include six
symbolic identities (sign/domain/assumption traps), four Decimal
precision-ladder numerics (18/36/72 digits), three convergence-order cases,
and three invariant-drift cases.

`harness/replay.py` is standard-library-only and fail-closed. It **never
accepts responses inside a snapshot**. Instead it invokes a digest-pinned,
trusted behavior adapter twice for every task. The adapter receives the frozen
local+global harness state and a challenge with all oracle fields removed, then
returns one strict JSON answer. Replay independently verifies that answer. A
malformed, missing, timed-out, errored, or nondeterministic adapter response is
a scored failure and blocks promotion.

## Baseline self-test

The checked-in `executors/reference_adapter.py` is a deterministic corpus-oracle
self-test. It is allowed only for single-snapshot baseline checks; comparison
mode rejects both the reference directory and the exact corpus-pinned file
digest, including a byte-for-byte copy. Because this corpus is public, static
code cannot prove that a modified adapter is not a semantic oracle. Adapter
review plus the CI-only private holdout is the enforcement boundary for such
reward-hacking; an edited/derived reference oracle is forbidden even if its
bytes evade the exact-digest denylist.

From an installed repository, run the baseline twice:

```bash
python -S harness/replay.py \
  --executor checks/evalset/executors/reference_adapter.py \
  --snapshot checks/evalset/snapshots/baseline-v1.json \
  --require-perfect \
  --output artifacts/harness/replay/baseline-run-1.json
python -S harness/replay.py \
  --executor checks/evalset/executors/reference_adapter.py \
  --snapshot checks/evalset/snapshots/baseline-v1.json \
  --require-perfect \
  --output artifacts/harness/replay/baseline-run-2.json
```

The two reports must be byte-identical. Reports contain no clock, absolute
input path, raw response, or raw harness state. They retain only stable scores,
task verdicts, and SHA-256 provenance.

## Snapshot contract

A schema-v1 snapshot contains:

- `snapshot_id`, `role` (`baseline` or `candidate`), deterministic `seed`, and
  exact `corpus_sha256` and `executor_sha256` values;
- an inline `harness_state` with both `local` and `global` objects, including
  real refinement histories; and
- no caller-prepared response bundle. Keys such as `responses`,
  `prepared_responses`, `gold_answers`, or `answer_bundle` are rejected at any
  nesting depth rather than being passed to an adapter.

Replay rejects malformed or duplicate history events and emits the canonical
SHA-256 of the candidate's named refinement event in the comparison receipt.

A candidate also contains `refinement_id`, `parent_snapshot_sha256`, and
`parent_harness_state_sha256`. Both parent digests bind the exact baseline. The
local history must preserve every baseline event byte-for-byte and append
exactly one new event whose id matches `refinement_id`, whose `changes` list is
nonempty, and whose `created_at` is present. There must be a substantive local
state change beyond that event, while global state remains identical for this
local-only workflow. The report records the new event digest. Baseline and
candidate use the same adapter digest and distinct state.
Canonical digests use UTF-8 JSON with sorted keys and separators `(',', ':')`.

## Trusted behavior-adapter protocol

Production comparison adapters live under `harness/replay_adapters/`, are
reviewed like code, and are pinned by their file SHA-256. For each invocation,
replay starts the adapter with isolated Python (`-I -S`) and sends one JSON
object on stdin:

```json
{
  "protocol_version": 1,
  "seed": 20260808,
  "repetition": 0,
  "harness_state_sha256": "...",
  "harness_state": {"local": {}, "global": {}},
  "challenge": {"id": "...", "category": "...", "prompt": "...", "response_contract": {}}
}
```

The adapter must instantiate the evaluated agent/behavior from that exact
state, set deterministic model/runtime controls, present the challenge, and
write only the answer JSON to stdout. It must not read gold answers or reuse a
caller-prepared response bundle. If no trustworthy state-applying adapter is
available, replay is inconclusive and the refinement remains `unverified`.
See `harness/replay_adapters/README.md` for the trust boundary.

## Baseline-versus-candidate governance

```bash
python -S harness/replay.py \
  --executor harness/replay_adapters/prime_agent_adapter.py \
  --baseline artifacts/harness/replay/before.json \
  --candidate artifacts/harness/replay/after.json \
  --output artifacts/harness/replay/comparison.json
```

Comparison requires stable executions, the corpus-wide and per-category
minimums in `promotion_policy`, no previously passing task regression, and no
lower candidate total. One decision drives all signals: exit 0 iff
`status == "pass"` iff `comparison.eligible_for_promotion == true`. Exit 1 is a
valid non-promotable evaluation; exit 2 is an input, provenance, confinement,
or integrity error. `--require-perfect` participates in that same decision.

Corpus, snapshots, adapters, and output are confined to the current Git
repository (an alternate `--repo-root` cannot redirect the trust boundary);
output is written atomically under `artifacts/harness/replay/`. The
public corpus is not a secret holdout. CI-only holdouts remain the separate
anti-overfitting control.
