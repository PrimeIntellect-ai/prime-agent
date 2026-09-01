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

Do not inspect the module, Prime source/tests, or skill files and do not call
`help()`, `dir()`, `hasattr()`, or `inspect.getsource()` to rediscover the API. This contract
is complete. Begin with the user's task files and then
`await avo.initialize(objective)` for a new run,
or `await avo.get_state()` after restart. Use the returned execution contract.
Never pass or request an environment override.

## Required iterative loop

1. Read `verificationClass`, `verificationPolicy`, and the host-derived
   `obligations` from state. Before candidate work, decompose any additional
   multi-part specification into immutable obligations with
   `register_obligations()`. Each obligation declares the evidence kind that
   can satisfy it (`test`, `build`, `lint`, `benchmark`, `runtime`,
   `filesystem`, `git`, `artifact`, `external`, or `deterministic`). The host
   already retains the full objective and every explicit checklist item, so do
   not delete, merge away, or silently omit requirements. List every additional
   obligation the candidate addresses in `candidate.obligation_ids`. After its
   host evaluation passes, bind the exact receipt with
   `cover_obligation({"obligation_id": ..., "candidate_id": ...,
   "evaluation_ids": [...]})`. An uncovered critical obligation blocks both
   cycle acceptance and canonical delivery.
   For a candidate with many obligations, bind them in one idempotent model turn
   with `cover_obligations(candidate_id, [evaluation_id],
   candidate["candidate"]["obligationIds"])`; the host still validates every
   individual obligation/receipt pair. Do this before `complete_cycle()` or
   `stop_gate()`.

   If the approach depends on a fragile critical assumption, preregister its
   statement, falsification plan, and evidence kind with
   `register_critical_assumptions()` before candidate work. Run the falsification
   check and call `resolve_critical_assumption()` with the host receipt. Open or
   refuted critical assumptions block completion; declarations are stored
   separately from observed results and are never treated as verified facts.
   For host-routed long-horizon coding, this pre-mortem is mandatory before any
   task workspace change: register at least two distinct critical assumptions.
   Use concrete statements and different falsification plans, for example one
   boundary-contract assumption tested by a direct regression and one
   integration assumption tested by a runtime check. Generic duplicates such
   as "the code works" are rejected. The host binds preregistration to the
   original workspace and will not accept assumptions invented after editing.
   Resolve each mandatory assumption with its own host receipt from a distinct
   check; one broad receipt or repeated command cannot discharge both plans.

2. For a
   coding task, before modifying the workspace or recording a candidate, call
   `run_coding_baseline(command)` with a recognized direct test command that
   explicitly names an unchanged baseline test file. Mutable package-script
   wrappers such as `npm test` and output-printed filenames are not identity
   proof. The host binds the explicit test identities, result, command digest,
   and original workspace to the immutable pre-candidate contract.
3. Record a candidate with `add_candidate`. A candidate may be an answer,
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
   For coding candidates, the host records the exact changed paths and derives
   `impactSurfaces`. Source changes require a trusted test; public API/schema
   changes require both test and build evidence; configuration changes require
   test plus build or runtime evidence; documentation changes require a direct
   filesystem check. Inspect these surfaces in the returned candidate/state
   and run every required evidence class. One parser test cannot certify an
   unrelated README, schema, or configuration change.
   If host evidence revises or fails a coding candidate, the next candidate is
   a correction, not a relabel: set `parent_candidate_id` to that failed
   candidate and materially change the workspace. The host rejects an unlinked
   successor or an identical workspace digest.
4. For an executable check, call `run_evaluation(candidate_id, command)`. The
   host runs one recognized direct test/build/lint/benchmark/runtime/filesystem/
   git command and creates the immutable environment receipt from its actual
   exit status and output. Shell composition is rejected. A coding test created
   during the task cannot certify itself alone: the exact trusted command must
   have run before the candidate and must explicitly target the same unchanged
   baseline tests afterward.
	A passing pytest run is diagnostic rather than semantic authority when the
	candidate changes Python code, because candidate code shares pytest's process
	and can tamper with its result channel. Use an out-of-process verifier (for
	example, an immutable Node test that launches the Python program as a child and
	asserts its structured response) or an independently verified exact spec proof.
	Pytest failures still provide useful negative evidence but cannot promote a
	changed Python candidate.
   Deterministic arithmetic and artifact tasks do not use a generic command as
   proof: call `verify_deterministic_result(candidate_id)` so the host evaluates
   the expression from the active objective, or `verify_artifacts(candidate_id)`
   so the host hashes every candidate-declared, task-created artifact.
5. For Serper `websearch` in IPython or Vertex native Google Search, take a
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
6. Use `record_evaluation` only for subjective self/reviewer judgment. It only
   accepts `authority="model_opinion"`; callers cannot mint host, environment,
   or external authority.
7. Complete the cycle with `complete_cycle`. The host derives accept/reject/
   revise/inconclusive from receipts; callers cannot declare their own outcome.
8. Inspect the checkpoint and revise. A host anti-laziness watchdog also checks
   every blocked root turn. Only an immutable baseline execution, meaningful
   host pass, completed cycle, host-bound experiment cell, completed experiment,
   newly covered obligation, or tested critical assumption resets it. A
   workspace edit or fresh candidate by itself no longer counts as qualified
   progress. Reading,
   narrating, repeating the same failed check, inspecting Prime internals, or
   merely saying done does not. Six consecutive tool batches without a
   milestone inject an immediate steering intervention. A host-bounded tool
   timeout intervenes immediately without waiting for six batches and requires
   a bounded reproducer plus a nontermination fix before retrying. At blocked root-turn
   boundaries, one empty turn triggers a corrective watch, two trigger
   intervention, and three escalate an automatic horizon to long.
   Repeatedly changing or decorating an already verified canonical delivery
   triggers a separate delivery intervention without weakening its exact bind.
   Automatic routing never lowers an active horizon.
9. Finish only after `stop_gate()` passes. Model opinion alone cannot pass it.
   When it passes, stop tool use immediately and return the exact canonical
   delivery requested by the host. Do not clean verifier helpers, inspect
   state, or call the gate a second time.
10. The host enforces this lifecycle at the root turn boundary. After an
   accepted cycle, return only its canonical delivery (general payload text,
   deterministic numeric result, or coding/research candidate summary), with
   no preface/suffix. A skipped gate or different final answer is automatically
   continued instead of being treated as task completion.

For repeatable comparisons in any adapter, call `record_experiment()` before
executing trials with a structured `plan`: preregister candidate IDs,
conditions and their command templates/parameters, seeds, pairing, a baseline
candidate for multi-candidate comparisons, the primary metric/direction, and
whether the run is `screening` or `confirmation`.
Seeds may be marker-safe strings or safe integers and are stored canonically as strings.
The cross-product may contain at most 1,024 cells.
The prospective mode is the default. Templates must bind `--seed {{seed}}` and
any declared `--name {{param:name}}`; multi-candidate non-coding plans also
bind `--candidate {{candidate_id}}`. A successful trial command emits exactly one line such as
`AVO_TRIAL_METRICS_JSON:{"score":12.5}`.

Use this canonical Python shape. Field names are snake_case; the direction
field is `metric_direction` (plain `direction` is invalid). `title`,
`hypothesis`, and `design` are required.

```python
experiment = await avo.record_experiment({
    "experiment_id": "batch-size-screening",
    "title": "Batch size screening",
    "hypothesis": "Batch size 8 improves score.",
    "design": "Screen batch size 8 against batch size 4 on three paired development seeds.",
    "plan": {
        "stage": "screening",
        "mode": "prospective",
        "candidate_ids": ["batch-size-4", "batch-size-8"],
        "conditions": [{
            "condition_id": "default",
            "command_template": "python benchmark.py --seed {{seed}}",
        }],
        "seeds": [1, 2, 3],
        "pairing": "paired",
        "primary_metric": "score",
        "metric_direction": "maximize",
        "baseline_candidate_id": "batch-size-4",
    },
})
```

Screening is the default and may contain one or many challengers. For a paired
multi-candidate screening, list every candidate, set `baseline_candidate_id`
to the current champion, and use the same conditions and seeds for every
candidate. Screening produces a host-derived ranking and
`provisionalBestCandidateId`, but it never promotes a champion—even with only
one challenger. This prevents exploratory winner selection from being reused
as confirmatory evidence.

To promote the selected challenger, preregister a new confirmation experiment.
It must reference the completed screening, compare exactly its provisional
winner with the same baseline, metric, direction, conditions, and command
templates, and use seeds that have not appeared in an earlier experiment for
that candidate pair and metric. Confirmation is prospective and paired. It
also requires a positive meaningful-effect threshold; `min_effect` is in the
primary metric's units and `min_relative_effect` is a fraction of the absolute
baseline mean. The host applies the larger threshold. Candidate IDs are not
enough: the host records and compares exact payload, claim, artifact, and
workspace identity digests from screening, including when confirmation happens
in a later task.

```python
confirmation = await avo.record_experiment({
    "experiment_id": "batch-size-confirmation",
    "title": "Confirm batch size 8",
    "hypothesis": "Batch size 8 improves score by at least 5 points.",
    "design": "Fresh paired confirmation on seeds 101-110.",
    "plan": {
        "stage": "confirmation",
        "mode": "prospective",
        "candidate_ids": ["batch-size-4", "batch-size-8"],
        "conditions": [{
            "condition_id": "default",
            "command_template": "python benchmark.py --seed {{seed}}",
        }],
        "seeds": [101, 102, 103, 104, 105, 106, 107, 108, 109, 110],
        "pairing": "paired",
        "primary_metric": "score",
        "metric_direction": "maximize",
        "baseline_candidate_id": "batch-size-4",
        "confirmation_of_experiment_id": "batch-size-screening",
        "promotion": {
            "min_pairs": 10,
            "min_effect": 5,
            "min_relative_effect": 0.01,
        },
    },
})
```

In coding tasks, restore each candidate's exact workspace state before calling
`run_trial()` for its cells.

Call `run_trial(experiment_id, candidate_id, condition_id, seed)`. The host
selects the preregistered cell, renders the direct command, binds its digest and
candidate payload to the receipt, and records only the declared finite numeric
metric. `record_trial()` may bind an already existing matching host receipt.
`complete_experiment()` requires every candidate × condition × seed cell once,
then derives overall and per-condition candidate means, medians, sample
variances, standard deviations, ranges, Student-t 95% confidence intervals,
paired deltas, win/loss/tie counts, and win rates. Screening remains
`inconclusive` for promotion. Only a valid two-candidate confirmation may issue
a conservative `promote` or `retain` decision. Confidence intervals use
two-sided Student-t critical values because
the host estimates variance from the observed sample; a single observation has
no estimable interval.

Automatic promotion additionally uses one project-wide online-Bonferroni
selection budget. The host preregisters confirmation attempt `i` before any of
its results are visible and assigns `alpha_i = 0.05 / (i * (i + 1))`; the
infinite schedule sums to 0.05. Attempt 1 therefore preserves the former
one-sided alpha 0.025 threshold, attempt 2 receives about 0.00833, and later
selection becomes progressively stricter. A restart, a new Prime session, a
renamed experiment, or a second concurrent agent does not reset the project
counter. An abandoned confirmation still spends its reserved alpha so the model
cannot inspect results and selectively register only a favorable attempt. The
host promotes only when the paired one-sided Student-t p-value clears the
reserved alpha, its corresponding lower confidence bound exceeds the
preregistered absolute or relative meaningful-effect threshold, and the plan
has at least five fresh matched pairs. Five pairs is only the hard host floor;
use 10-20 or more paired seeds for consequential comparisons.

This controls the host's repeated confirmation-selection false-positive budget
under the validity assumptions of the paired tests. It does not prove global
optimality, benchmark representativeness, independence, or memory quality. Use
held-out tasks and varied task families when claiming general improvement. The verified NOOA
episode stores declared hypothesis/design separately from observed trials and
derived statistics, so declarations are never treated as empirical findings.
Experiment episodes embed the host-derived candidate identity digests and use
an exact serialized-content digest as their durable memory ID, so reusing a
human-readable experiment ID—or repeating identical metrics for a different
candidate payload—in a later session cannot overwrite or alias earlier project
evidence.

Long runs bind a retained supervisor. For required coding work it performs a
bounded read-only adversarial acceptance audit after an accepted cycle: it
inspects the implementation and existing tests, challenges up to three
high-risk specification boundaries, and may veto but never upgrade host
evidence. Requirement-dense iterative work receives the same audit; other
iterative runs bind a supervisor only when the host detects stagnation. Direct
tasks never pay that cost.

## Example

```python
import avo

await avo.initialize(
    "Fix the parser race without regressions",
)
await avo.run_coding_baseline(
    "node --test tests/parser-race.test.cjs",
)
candidate = await avo.add_candidate({
    "candidate_id": "patch-parser-lock",
    "kind": "patch",
    "summary": "Serialize parser cache mutation",
    "payload": {"diff_sha256": "..."},
})
await avo.run_evaluation(
    candidate["candidate"]["candidateId"],
    "node --test tests/parser-race.test.cjs",
)
await avo.complete_cycle({"candidate_id": "patch-parser-lock"})
await avo.stop_gate()
```

## Memory

Prime uses NVIDIA NOOA 0.0.9 as its cognition engine while the TypeScript host
remains the truth authority. Every memory has four independent dimensions:

- cognitive type: `info`, `skill`, `episode`, `intent`, `todo`, `reflection`,
  or task-only `scratch`;
- environment namespace: `general`, `coding`, `research`, or `shared`;
- persistence scope: `task`, `project`, or `global`;
- verification: `proposed`, `verified`, `contested`, or `invalidated`.

Before every root turn, Prime automatically builds a cue from the user message,
objective, environment, latest candidate, and latest failure. It asks NOOA for
spontaneous recall and inserts a bounded context block before model reasoning.
This uses NOOA's `touch=False` semantics: injected recall is logged but does not
reinforce itself. `recall()` remains available for deliberate inspection.
The block includes bounded memory content—not only titles—and labels it as
historical data rather than instructions. Experiment episodes put host-derived
outcomes and statistics first, and the formatter reserves space for every
selected memory so one long record cannot hide the rest.

The host writes rejected, revised, and inconclusive cycle episodes immediately
as verified observations. An accepted-cycle episode remains proposed until the
host matches and delivers that exact canonical candidate; only then does it
become verified. Generic experiments, research-adapter experiments, supervisor
interventions, and completed tasks also become verified project episodes. Exact duplicates
are reinforced instead of copied. Project and global canonical ledgers live
under Prime's agent data directory at
`memory/projects/<git-identity-sha256>/canonical.json` and
`memory/global/canonical.json`; matching NOOA SQLite indexes sit beside them.
The non-resettable project confirmation schedule is stored under the same
project identity in `memory/projects/<git-identity-sha256>/promotion-policy.json`.
Task memory remains in the session artifact directory. Git subdirectories share
one project identity; a normalized origin remote, or the repository root commit
when no remote exists, keeps that identity stable when a repository moves.
Canonical ledgers are refreshed before recall, so concurrent sessions see new
project/global records without restarting.

Proposed task memories may be recalled deliberately or spontaneously. Proposed
project memories are deliberate-only until verified. Proposed global memory is
forbidden; global persistence accepts only host-verified `info`, `skill`, or
`reflection` records. The retained supervisor receives a separate bounded
profile containing only verified trajectory episodes/reflections. Ordinary RLM
workers and adversarial research reviewers do not receive automatic root memory.

Owners use NOOA's `role@instance` format. Root memories are written as
`prime-root@<session>`. Supervisor and research-reviewer proposals remain
owner-isolated. A reflection or skill becomes unowned canonical shared memory
only after an independent verifier supports it against at least two verified
episodes. NOOA consolidation may archive proposed records but cannot invalidate
host-verified canonical memory.
For semantic reconsolidation, NOOA finds similar `info`, `skill`, and
`reflection` clusters. The current model proposes same-fact supersession, an
independent model verifies it, and the host permits archival only when the
replacement is a newer verified record with the same type, namespace, and
scope. Similar counterexamples or distinct facts must remain separate.

References can bind memory to current files, candidates, experiments, trials,
evaluations, cycles, artifacts, tasks, or other memories. Prime re-resolves
them when recalled and labels stale targets `DANGLING`; stored file prose is not
treated as current state.

NOOA's hashing embedder is the zero-cost default. To opt into an explicitly
configured LiteLLM/OpenAI-compatible embedding endpoint, set:

```text
PRIME_AGENT_AVO_MEMORY_EMBEDDING=litellm
PRIME_AGENT_AVO_MEMORY_EMBEDDING_MODEL=<model>
PRIME_AGENT_AVO_MEMORY_EMBEDDING_ENDPOINT=<endpoint>
PRIME_AGENT_AVO_MEMORY_EMBEDDING_API_KEY=<key>
PRIME_AGENT_AVO_MEMORY_EMBEDDING_DIMENSIONS=<integer>
```

Recall uses the active environment plus `shared`. Add a memory to the `shared`
namespace only with at least two environment-qualified source IDs from distinct
environments, for example `coding:test-123` and `research:review-456`. The host
must resolve every ID to current accepted host-owned lineage. Syntactically
plausible IDs are rejected. If NOOA is unavailable, host lexical recall remains
the lossless fallback and the dashboard exposes the recall/verification counts.
