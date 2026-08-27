---
name: avo
description: Prime's default candidate-evaluate-revise lifecycle for every root task. Always use this skill before completing general, coding, or research work; the host automatically chooses the internal evaluation adapter and task horizon, keeping direct tasks lightweight while enabling lineage, NOOA memory, recovery, and trajectory supervision when needed.
---

# Universal AVO

Prime has one AVO substrate. General, coding, and research are evaluation
adapters; direct, iterative, and long are task horizons. The TypeScript host
owns canonical state and lineage. This Python package is a typed bridge.

AVO is always active for a root task; it is not a mode the user has to enter.
The host selects the adapter and horizon automatically from the task. Do not ask
the user to choose an adapter. The model cannot select an environment and may
only escalate the horizon to `iterative` or `long`. A user may override the
horizon through the `/avo horizon` command.
The host also selects `verificationClass`: `external_factual`,
`deterministic_local`, `coding`, `research`, `artifact`, or `subjective`.
Required `external_factual` candidates cannot be recorded without explicit
verbatim claims.
After a task passes its stop gate, the next root task starts a fresh task run;
the prior candidate/evaluation lineage is archived while verified memory remains
available across runs.

Do not inspect the module or guess API signatures. Begin with
`await avo.initialize(objective)` for a new run,
or `await avo.get_state()` after restart. Use the returned execution contract.
Never pass or request an environment override.

## Required iterative loop

1. Read `verificationClass` and `verificationPolicy` from host state. For a
   coding task, before modifying the workspace or recording a candidate, call
   `run_coding_baseline(command)` with a recognized direct test command that
   explicitly names an unchanged baseline test file. Mutable package-script
   wrappers such as `npm test` and output-printed filenames are not identity
   proof. The host binds the explicit test identities, result, command digest,
   and original workspace to the immutable pre-candidate contract.
2. Record a candidate with `add_candidate`. A candidate may be an answer,
   action, artifact, patch, implementation, plan, or hypothesis. The host
   stores a digest rather than trusting a model-supplied hash. Factual answers
   must declare each verifiable statement in `claims` as
   `{"claim_id": "...", "claim_text": "verbatim text from payload"}`.
	For deterministic arithmetic in the host's exact safe-integer subset
	(`+`, `-`, `*`, exact `/`, and parentheses), the payload must be exactly
	`{"result": <finite number>}`. Ambiguous/multiple expressions, decimals,
	exponents, non-integral division, and unsafe integers fail closed. For
	file-producing tasks, declare every intended output in `artifact_paths` and
	make the candidate payload contain exactly those paths.
3. For an executable check, call `run_evaluation(candidate_id, command)`. The
   host runs one recognized direct test/build/lint/benchmark/runtime/filesystem/
   git command and creates the immutable environment receipt from its actual
   exit status and output. Shell composition is rejected. A coding test created
   during the task cannot certify itself alone: the exact trusted command must
   have run before the candidate and must explicitly target the same unchanged
   baseline tests afterward.
   Deterministic arithmetic and artifact tasks do not use a generic command as
   proof: call `verify_deterministic_result(candidate_id)` so the host evaluates
   the expression from the active objective, or `verify_artifacts(candidate_id)`
   so the host hashes every candidate-declared, task-created artifact.
4. For Serper `websearch` in IPython or Vertex native Google Search, take a
   result URL, call `fetch_external_source(url)` to inspect the host-fetched
   visible page text, then call
   `bind_url(candidate_id, claim_id, url, exact_quote)`. The host re-fetches the
   credential-free public HTTPS URL with DNS pinning and redirect checks before
   issuing authority. For a direct host-trusted provider-native or Prime-built-in
   tool result, `bind_tool_result(candidate_id, claim_id, tool_call_id,
   exact_quote)` is also available. It verifies that the exact quote occurs in
   exactly one text source record, refuses ambiguous multi-URL records, applies a
   deterministic contradiction/admissibility filter, and asks an isolated RLM verifier to
   classify it as `supports`, `contradicts`, or `insufficient` for that exact
   candidate claim. The RLM may veto but cannot upgrade deterministically
   insufficient text. The host binds argument, result, source, timestamp, claim, and
   candidate digests into an external receipt. Every declared claim must have a
   `supports` receipt before a factual candidate is canonical.
5. Use `record_evaluation` only for subjective self/reviewer judgment. It only
   accepts `authority="model_opinion"`; callers cannot mint host, environment,
   or external authority.
6. Complete the cycle with `complete_cycle`. The host derives accept/reject/
   revise/inconclusive from receipts; callers cannot declare their own outcome.
7. Inspect the checkpoint and revise. Direct automatically escalates to
   iterative after a failed attempt. Repeated stagnation can escalate iterative
   to long. Automatic routing never lowers an active horizon.
8. Finish only after `stop_gate()` passes. Model opinion alone cannot pass it.
9. The host enforces this lifecycle at the root turn boundary. After an
   accepted cycle, return only its canonical delivery (general payload text,
   deterministic numeric result, or coding/research candidate summary), with
   no preface/suffix. A skipped gate or different final answer is automatically
   continued instead of being treated as task completion.

Long runs bind a retained generic supervisor. Iterative runs bind one only when
the host detects stagnation. Direct tasks never pay that cost.

## Example

```python
import avo

await avo.initialize(
    "Fix the parser race without regressions",
)
await avo.run_coding_baseline(
    "python -m pytest -q tests/test_parser_race.py",
)
candidate = await avo.add_candidate({
    "candidate_id": "patch-parser-lock",
    "kind": "patch",
    "summary": "Serialize parser cache mutation",
    "payload": {"diff_sha256": "..."},
})
await avo.run_evaluation(
    candidate["candidate"]["candidateId"],
    "python -m pytest -q tests/test_parser_race.py",
)
await avo.complete_cycle({"candidate_id": "patch-parser-lock"})
await avo.stop_gate()
```

## Memory

Memory namespaces are `general`, `coding`, `research`, and `shared`. Recall
uses the active environment plus `shared`. Promote a memory to `shared` only
with at least two environment-qualified source IDs from distinct environments,
for example `coding:test-123` and `research:review-456`. Promotion runs only
after the host resolves every ID to an accepted candidate, cycle,
authoritative passing evaluation, or canonical adapter-progress entry in the
current/archived AVO lineage. Syntactically plausible IDs are rejected. NOOA 0.0.8
runs in its pinned Python 3.13 sidecar; host lexical recall remains the lossless
fallback. Canonical memory remains host-owned.
