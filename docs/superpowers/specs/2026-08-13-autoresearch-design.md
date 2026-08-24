# Native AutoResearch Subsystem Design

Date: 2026-08-13
Status: Approved by the user for implementation planning; implementation not started
Approval baseline SHA-256: 1152a9410008de681627290161e3ebcae327108317d43b665e141d76b46195d0
Behavioral source: local AutoResearch repository supplied by the user
Source commit: 95e2fa1189f08ce694eb1a2b3e85d4bf58d3cfbf
Source description: v0.6.0-47-g95e2fa1
Source license: MIT (Copyright (c) 2026 LLLLLe)

## Approved clarification/addendum (2026-08-14)

This approved clarification supplements the 2026-08-13 AutoResearch design.
The original approval status and `Approval baseline SHA-256` above remain
unchanged; the addendum does not authorize a new objective, scorecard,
resource/cloud/spend envelope, or external effect.

AutoResearch specializes the generic adaptive controller for candidate
resource placement. While its durable goal is active, the host observes the
verified experiment critical path, candidate queue, evaluator/guard evidence
gaps, blocker state, candidate throughput and latency, marginal admitted
progress per resource, uncertainty, live worktree/provider leases, and control
reserve. These signals adapt grants, role mix, worktree slots, evaluator
capacity, and refill timing only inside the already approved resource plan.
The primary metric, target, direction, evaluator, parser, guard, acceptance
checks, protected invariants, scope, and objective remain fixed. A worker,
metric improvement, or utilization signal cannot self-score progress or
authorize frontier admission.

After each claim, candidate result, admission/rejection, lease release,
material evidence transition, phase transition, or recovery event, the host
records a fresh observation and sends any allocation change through the
generic recon/lens/verification/synthesis/anti-gaming-red-team/host gate. It
shifts capacity toward a verified bottleneck with hysteresis, minimum windows,
and finite role/reallocation ceilings; it never starves the verifier, red team,
frontier lock, or recovery reserve. Unknown capacity is zero. Cloud, spend,
egress, credential, authority, or resource-envelope expansion requires an
exact user approval and a new resource decision; no idle or inferred pool is
used.

After every AutoResearch phase, incident, and completion gate, the host queues
a small improvement review from accepted candidate/evaluator evidence. The
candidate is compared with the approved baseline plus held-out, replay, or
canary cases, receives independent Goodhart/regression/safety red-team review,
and is promoted atomically only when compatible and measurable. A rejected or
regressed revision is rolled back and excluded from future runs. Canonical
knowledge stores approved how/why/provenance; optional MemPalace only indexes
those records and neither can authorize a candidate, allocation, scorecard,
frontier, or completion transition.

A recurring independent efficiency-red-team reviewer, `cron`, is scheduled
only by the approved resource plan. Its trusted clock/cadence, major-transition
triggers, exactly-once window, one-catch-up-after-restart rule, and bounded
review overhead/cloud-cost reserve are explicit and schedule changes require a
new decision. A fresh read-only reviewer consumes a host-resolved snapshot of
the candidate critical path, queue, leases, cost, latency, admitted progress,
and evidence. It checks placement for underuse, overuse, redundancy,
serializable work, context churn, verification starvation, review overhead,
cloud cost, and Goodhart risk. It emits immutable suggestions only; it has no
write, candidate, lease, allocation, frontier, scorecard, approval, or
completion authority. Applying a suggestion uses the full decision/approval
pipeline, while a failed or late review is nonblocking and leaves the fixed
metric/guard and last safe allocation unchanged.

The generic kernel owns adaptive state/events, leases, approval, recovery,
rollback, and finite ceilings; AutoResearch owns only fixed-metric/guard
signals, candidate-role demand hints, and experiment-specific evidence. The
first release is bounded to observable local banks and already approved cloud
adapters, with no resident infinite daemon, unknown capacity, automatic
envelope expansion, or daemon wire change.

## Summary

Native AutoResearch is the measurable-experiment specialization of the durable
workflow, decision, and capacity kernel. It binds only to a goal whose generic
workflow contract has already been hardened, independently red-teamed, and
accepted. The scorecard is a typed execution projection of that contract; it may
make measurement and acceptance concrete, but it cannot redefine the objective,
drop a hardened requirement, or widen authority. It then turns that bound
objective into a strict loop:

```text
recon -> scorecard proposal -> independent review -> user approval
      -> known-good baseline -> claim -> isolated candidate
      -> fixed evaluation + acceptance checks/optional guard
      -> serialized frontier admission
      -> audit/refinement -> refill until target or a terminal condition
```

The workflow kernel remains the authority for goal binding, user approval,
provenance, leases, recovery, budgets, and host gates. AutoResearch supplies the
experiment contract: one repository per run, one mandatory numeric primary metric
and target, a fixed evaluator, an editable user-owned scope, baseline and guard
evidence, worktree-isolated candidates, exploit/explore scheduling, and strict
frontier admission. A worker may propose one focused change; it cannot decide that
the change is an improvement, modify the scorecard, or complete the run.

The ordering is normative: goal-contract hardening and red-team acceptance happen
before scorecard synthesis; scorecard and resource-envelope decisions are then
independently red-teamed and approved; only the resulting contract and digests may
reach baseline or candidate execution. A scorecard/objective mismatch is a new
workflow decision, not a local AutoResearch amendment.

The native subsystem preserves the current external v2 artifact contract:
`run.json` keeps its exact string `run_id` and strict fields, `events.jsonl` keeps
its existing `schema_version/run_id/seq/time/event` shapes, candidate command
output is parsed strictly, failed trials remain inspectable on candidate branches,
and `autoresearch-results/` is never staged. The workflow journal is authoritative
for native authorization, decisions, leases, recovery, and completion; it wraps
each external v2 projection append in an intent/commit binding by sequence and
digest. It never reconstructs native state from model conversation or a replaceable
report, and it does not invent a competing AutoResearch event schema.

## Relationship to the Durable Kernel

AutoResearch is not a second coordinator or agent runtime. It is a specialization
of the durable workflow/decision/capacity kernel described in
`2026-08-13-durable-workflows-design.md`:

| Kernel responsibility | AutoResearch specialization |
| --- | --- |
| Hardened goal and user authority | Immutable typed scorecard with one numeric primary metric, target, scope, evaluator and v2 command timeout, repeatability policy, acceptance checks, protected invariants, and optional guard command. |
| Decision pipeline | Every scorecard revision and candidate admission follows recon, independent lenses, evidence verification, synthesis, anti-gaming red team, host gate, then deterministic execution. |
| Task planning | The plan is a stream of candidate attempts. The frontier is the only accepted predecessor for the next attempt. |
| Capacity scheduling | A separately versioned resource plan holds finite workflow/candidate/planner/strategy/analysis ceilings, compute bank, profile, worktree, lease policy, and optional user-authorized cloud envelope, producing explicit conservative grants and slot accounting. |
| Worker isolation | Each candidate gets a dedicated Git worktree outside the repository. Frontier admission is serialized even while candidate work is parallel. |
| Progress evidence | A fixed evaluator emits one finite numeric value; required acceptance checks and protected invariants, plus an optional baseline-passing guard, protect behavior outside the metric. |
| Recovery | Kernel-authoritative binding records around immutable v2 run configuration/event projections, leases, reconcile/reap, stale rebasing, and no blind replay. |
| Completion | A candidate reaching the target is only a target signal. Independent verification, completion red team, and final refinement still authorize workflow and goal completion. |
| Continual learning | Audited tactics and repeated failure patterns become scoped refinement/memory entries, never a transcript dump. |

The general workflow kernel may run independent tasks in one shared workspace. The
AutoResearch specialization deliberately chooses stronger isolation because a trial
must be measured against a known commit and must never be allowed to contaminate a
neighboring trial or the frontier. The candidate worktree is the unit of ownership;
the repository frontier is the unit of admission.

### Authority and trust boundaries

| Actor | May do | May not do |
| --- | --- | --- |
| User | Approve the scorecard, amend scope or budget, authorize cloud capacity, pause/resume/stop, archive a terminal run, and request global refinement. | Treat a model-authored proposal as approved without an explicit response. |
| Root coordinator/host gate | Validate state, create worktrees, launch workers, run the fixed evaluator and guard, acquire the admission lock, rebase stale candidates, append events, reconcile, and apply approved transitions. | Infer missing state, silently repair a journal, or accept a worker's completion claim. |
| Candidate worker | Inspect its packet, make one coherent change inside its worktree and configured scope, run exploratory checks, and call `finish`. | Change `run.json`, the evaluator, the guard, the target, another worktree, the frontier, or the worker prompt. |
| Evaluator | Read the candidate worktree and emit a finite primary metric. | Change tracked/untracked repository state, choose a different metric, or vary by candidate. |
| Guard | Return pass/fail for protected behavior. | Override the primary metric or turn a failed run into success. |
| Anti-gaming red team | Attempt to falsify the exact proposed admission against the objective, scorecard, protected paths, and proxy risks. | Vote a candidate into the frontier or weaken the scorecard. |
| Refinement reviewer | Propose small evidence-backed local or explicitly authorized global harness edits. | Persist candidate history, transient blockers, unsupported hypotheses, or unverified success. |

## Goals

The first native release will:

1. Start only through an explicit AutoResearch command or an explicit workflow
   request; ordinary sessions and ordinary goals remain unchanged.
2. Require one repository, one user-approved typed scorecard, one numeric primary
   metric, one numeric target, one fixed evaluator, a declared repeatability policy,
   binary acceptance checks, protected invariants, and optional baseline-passing
   guard commands per run.
3. Refuse initialization until the repository has a clean named Git branch, a
   readable goal, a valid scope, a passing baseline evaluator and acceptance checks,
   and a passing guard when one is configured.
4. Keep all candidate changes in worktrees outside the repository and keep the
   frontier branch separate from discarded trials.
5. Run exploit and explore candidates concurrently when declared capacity permits,
   refill a slot immediately when it becomes free, and degrade to sequential claims
   without changing the state model when the host cannot spawn children.
6. Serialize admission, rebase and re-measure a stale candidate against the
   frontier it would actually land on, and reject any stale or late result that
   cannot be revalidated.
7. Run an anti-gaming red team on every candidate that reaches admission and never
   treat a proxy improvement as proof of the requested outcome.
8. Persist enough immutable evidence and kernel binding events to recover after
   root, daemon, worker, process, evaluator, or cloud-boundary interruption without
   replaying an uncertain action or disagreeing with the v2 projection.
9. Expose status, history, reconciliation, and reports through interactive UI and
   headless command paths without adding a second daemon protocol.
10. Feed only audited, reusable lessons into the existing refinement and memory
    stores with explicit local/global scope.

## Non-goals

The first release will not:

- change ordinary goal, autonomous, skill, subagent, or session behavior;
- run one experiment across multiple repositories;
- allow candidate workers to share a worktree or edit the primary checkout;
- infer a metric, target, scope, budget, evaluator, or cloud authorization;
- accept model-authored percentages, prose, votes, or screenshots as metric evidence;
- alter the evaluator, guard, parser, or target during a candidate attempt;
- silently fall back to an old artifact layout, a guessed metric, or synthetic success;
- automatically approve a scorecard revision, scope expansion, external side effect,
  cloud envelope, blocker, or completion result;
- implement a cloud provider, billing integration, remote scheduler, or credential
  store in this design; or
- merge, push, deploy, publish, post messages, or otherwise perform a consequential
  repository action not already authorized by the caller and repository policy.

## Compatibility with Current AutoResearch Behavior

Compatibility is an adapter contract, not a claim that the native types replace
the existing files. The current v2 surface remains exact:

- `run.json` uses `schema_version = 2`, opaque string `run_id`, and the existing
  strict `repo/branch/goal/scope/metric/guard/target/max_candidates/timeout_seconds/docs/parallel`
  fields;
- `events.jsonl` uses the current common
  `schema_version/run_id/seq/time/event` fields and existing event-specific shapes;
- its first event is `baseline`, and the existing status/replay/report commands can
  continue to read the projection; and
- native-only decision, capacity, approval, provenance, target-pending, and recovery
  state lives in the workflow journal, not as unrecognized v2 fields.

An existing validated v2 run is attached through an explicit user-approved
`LegacyRunBinding` that records its run ID, repository/root session/workflow/goal
IDs, objective digest, config digest, event-prefix sequence/digest, and status
mapping. Attachment is read-only: native status/history/report may validate and
project the existing prefix, but attachment cannot claim, finish, append, rewrite,
renumber, reset, or declare the legacy run or its bound goal complete. Legacy
`status` is a compatibility view of the last validated prefix, not native
authority; legacy mutating commands, including `finish`, are fenced with a stable
`native_owner` disposition while a native binding is active. Invalid, unsupported,
or incomplete older schemas remain read-only and require archive or a separately
designed migration; there is no silent fallback.

Attachment may become a mutable native run only through a fresh, explicit
hardening/rebaseline decision. That decision must fill and independently verify
the native acceptance checks, protected invariants, fixed evaluator and parser,
repeatability policy, selected resource bank/envelope and control-plane reserve,
scope, lease, and completion authority. It requires the generic goal contract to
be hardened/red-teamed first, a user approval for the exact scorecard and resource
decisions, and a new known-good baseline/rebaseline with fresh artifacts. Missing
fields are an attachment limitation, not values to synthesize from v2 prose,
reports, logs, screenshots, or a favorable metric. Until this gate succeeds the
binding remains read-only and no native candidate or frontier mutation is allowed.

For a native run after that gate, every v2 append is wrapped by a flushed kernel
`projection_intent(expected_v2_seq, prior_prefix_digest, effect_digest)` and a
`projection_committed(result_v2_seq, result_prefix_digest)` event. A crash between
them enters reconciliation before native progress advances. The kernel journal
sequence is separate, positive, and authoritative; the v2 `seq` preserves its
existing zero-based numbering and is never reused as a kernel sequence.

Native candidate projection is deliberately bounded. Kernel candidate claims,
mandatory checks, invariant results, leases, and execution attempts remain
kernel-only until final candidate resolution. Only a terminal outcome whose
meaning maps exactly to an existing v2 event/reason is projected, and the v2
`candidate_started` plus `candidate_resolved` lines are published as one bound
projection transaction so a crash cannot leave a dangling `candidate_started`.
Because parallel candidates may resolve out of claim order, the projection lock
assigns the next consecutive `V2CandidateNumber` from the validated prefix; that
number is distinct from the native `CandidateId` and is bound to it by an immutable
`CandidateV2ProjectionBinding`. Both v2 lines use that projection number. An
unrepresentable resolution receives no v2 number, so it cannot create a numbering
gap.
When that resolved admitted metric reaches target, the same transaction includes
the required next v2 `complete` line, so every externally visible prefix remains
valid under the existing validator.
An outcome that v2 cannot encode remains kernel-only through resolution; the host
does not falsify it as `no_improvement`, `abandoned`, `error`, or another reason.
For every post-initialization projection, the adapter materializes the validated
prior bytes plus the complete suffix in a same-directory temporary file, flushes
and revalidates it, atomically replaces `events.jsonl`, and flushes the parent
directory. It never publishes the paired start/resolution or following target
event through separately visible appends.
The v2 schema stays version 2 and gains no unrecognized fields. A future projection
schema requires an explicitly versioned migration/capability decision; it is never
introduced implicitly.

The native subsystem adopts the following current contract from the authoritative
workflow, experiment, and parallel references:

- `status` is the first read for every invocation. Only `not_initialized` is fresh;
  a validated active, stopped, blocked, error, or complete v2 run must be surfaced and
  resumed, stopped, or archived explicitly rather than overwritten.
- A fresh run is confirmed once with the goal, repository-relative scope, metric,
  baseline, target, direction, evaluator/parser, guard, rollback behavior,
  concurrency, worktree root, lease, and optional candidate limit. No project or
  run files are written before clear user approval.
- Parallelism is explicit. `maxParallel`, `worktreeRoot`, `leaseSeconds`, `window`,
  `minPerRole`, and `plateauK` are supplied or resolved from a declared bank; no
  hidden default controls candidate count.
- `compute detect` is read-only. The selected bank is written explicitly to
  `autoresearch/compute.json`; `autoresearch/goal.md` must exist, and curated
  decisions are changed only through `decide`.

The optional v2 candidate-limit field is compatibility data only. Fresh native runs
write `max_candidates: null` because the immutable v2 field cannot truthfully encode
renewable kernel budget revisions; existing non-null v2 runs attach read-only and
require archival plus a fresh native run before research continues. A resolved
native `BudgetSpec` always supplies finite candidate-dispatch, run wall/token,
planner-cycle, per-requirement strategy/analysis, and per-candidate ceilings through
the approved kernel resource envelope. If the user omits them, the host proposes
conservative finite values; no candidate can dispatch until they are approved.
- Every worker receives a complete packet containing the overarching goal,
  decisions, individual target, role, resource grant, worktree, lease, and exact
  commands. The coordinator does not author a different prompt per worker.
- A worker changes one focused hypothesis and closes it only through `finish`. The
  host commits and measures there, runs the guard, and admits a genuine improvement.
  A discarded candidate retains its trial and revert history on its own branch while
  the frontier remains unchanged.
- The evaluator exits zero and emits either a finite scalar on its final non-empty
  UTF-8 stdout line or a final JSON object with one explicitly named finite numeric
  key. Parsing errors, command errors, timeouts, non-UTF-8 output, generated
  byproducts, and invalid Git state stop the run with an exact error and log path.
- `run.json` is immutable configuration and `events.jsonl` is append-only history.
  Neither is edited by hand. Full command output is preserved under
  `autoresearch-results/logs/`; a report is a replaceable view, never recovery state.
- A candidate role is `exploit` or `explore`. Exploit deepens the current best
  direction; explore tries a materially different mechanism. After `plateauK`
  consecutive non-admitting exploits, the policy forces an explore. A role override
  requires a recorded reason.
- The coordinator refills a slot as soon as its worker returns. It does not wait for
  a whole batch. A lease that lapses is reported by `reconcile`; the host attempts
  deterministic reclaim only after strong nonexecution proof, and otherwise records
  finite terminal escalation. A returning stale worker is refused.
- Admission is serialized. If the frontier moved, the candidate is rebased and
  re-measured before it can be admitted. A discarded or reaped candidate can never
  be admitted later.
- The run continues while active until the target, an explicit user stop, an
  approved candidate limit, an explicit hard budget, or a verified external blocker.
  A difficult hypothesis or a temporary lack of improvement is not by itself a
  blocker, and a plateau never masquerades as completion.

## User Flow and Scorecard Gate

### Start and confirmation

`/autoresearch start` and the equivalent command-line entry first create or bind the
kernel-owned durable goal/workflow in `awaiting_user`, then require that its generic
goal contract has reached the kernel's hardened, independently red-teamed accepted
revision before AutoResearch can synthesize a scorecard. If hardening is pending,
AutoResearch remains preflight-only and delegates that decision to the generic
workflow. It then inspects the Git root, existing run status, source/tests/project
commands, and read-only compute capacity. A fresh coordinator proposes a typed
scorecard derived from the accepted contract. It does not write project/run
configuration, create a worktree, or start a worker before approval.

The proposal passes independent lenses for intent, metric integrity, evaluator
determinism, guard coverage, scope/ownership, security, resource authority, and
licensing/data handling. A fresh red-team context receives the exact synthesized
proposal and tries to falsify it. The host then validates syntax, finite numbers,
repository-relative paths, clean Git state, command timeouts, and authorization.

The scorecard and resource envelope remain two material decisions with independent
proposal, verification, red-team, digest, approval token, and journal record. The UI
may display them in one concise confirmation card rather than asking about every
field separately, but the response explicitly approves or rejects each named child
decision and the host consumes them independently:

```text
Goal: reduce the project-owned error count
Repository: /repo (one repository)
Scope: src/parser, tests/parser (revision 1)
Metric: error_count, lower is better (baseline 7, target 0)
Verify: python3 scripts/score.py; final JSON key error_count
Guard: python3 -m pytest -q (passes at baseline)
Parallel: 3 candidates; local bank; exploit/explore refill enabled
Worktrees: /tmp/prime-autoresearch-worktrees/<run>
Lease: 1800 seconds; window 8; min per role 2; plateau explore threshold 4
Budget: 40 candidates; no cloud envelope
Rollback: failed trials keep commit/revert history on their candidate branches;
          the frontier stays unchanged

Approve the scorecard? [yes/no]
Approve the listed resource envelope? [yes/no]
```

The confirmation response supplies the two exact approval responses. If target,
scope, evaluator, guard, resource authority, or external side effects are ambiguous,
the host asks a focused clarification before writing. A negative response leaves no
initialized run while preserving the awaiting-user goal/workflow for revision or
cancellation.

### Scorecard and resource amendments

The scope is editable user-owned configuration, not a worker permission. It may be
edited before initialization. Because the compatible v2 `run.json` is immutable,
an active run never changes scope, evaluator, guard, metric, target, direction,
parallelism, timeout, worktree root, lease policy, or prepare command in place.
Such a request pauses claims, reconciles
active candidates, runs the full decision pipeline, and asks the user whether to
stop/archive the current run and initialize a new run with a new baseline. Prior
artifacts remain immutable and independently replayable. A materially changed
objective always starts a new run. A candidate can never expand its own scope or
change the scorecard/config digest in its packet.

A kernel-only budget renewal may revise finite wall/token/model-call/candidate,
planner, strategy, analysis, and recovery ceilings without changing v2 bytes. It
is a new resource proposal with recon, lenses, verification, synthesis, red team,
and exact user approval; the active resource-plan revision changes by compare-and-
swap. Any proposal that changes a v2-visible execution field takes the new-run path
above instead.

## CLI and Interactive UI

### Commands

The native command names mirror the current control surface while keeping the
workflow entry explicit:

| Command | Behavior |
| --- | --- |
| `/autoresearch start [options] <objective>` | Propose, red-team, confirm, initialize, measure the baseline, and begin the active run. With no objective, bind to the current active goal only after an exact objective match. |
| `/autoresearch status` | Validate the full journal and display run status, phase, scorecard revision, baseline/frontier/target, slots, leases, role streak, budgets, and pending approval. |
| `/autoresearch pause [reason]` | Stop new claims, allow active attempts to reach a safe host boundary, and persist a resumable pause. |
| `/autoresearch respond <decision-id> <option-id>` | Consume one exact typed scorecard, resource, recovery, amendment, blocker, or completion approval response. Ordinary messages never count. |
| `/autoresearch resume [note]` | Validate state, reconcile uncertain attempts, and resume a user-paused/stopped run in a fresh coordinator context. It never consumes a pending approval. |
| `/autoresearch stop [reason]` | Preserve current v2 `stopped` behavior: stop dispatch, preserve worktrees/results, pause the bound goal, and permit an explicit later resume after validation. |
| `/autoresearch cancel [reason]` | Record terminal kernel cancellation, stop/reconcile children, preserve artifacts, and leave the goal paused for explicit replacement/completion; the cancelled run cannot resume. |
| `/autoresearch reconcile` | Inspect live child registrations, transcripts, worktrees, leases, locks, and artifacts; report dispositions without repairing or replaying them. |
| `/autoresearch reap --candidate <id>` | Request inspection/confirmation of a lapsed candidate; the host frees the slot only after strong process/provider nonexecution proof, otherwise it records finite terminal escalation. |
| `/autoresearch abandon --candidate <id> --reason <reason>` | Resolve a worker-reported candidate that has no safe continuation; it is never an admission path. |
| `/autoresearch history [--tsv]` | Render the validated immutable event history. |
| `/autoresearch report` | Generate a replaceable static report from the validated run and event history. |
| `/autoresearch archive` | Explicitly archive a terminal run, or execute an already approved verification-gap replacement after child reconciliation. It cannot archive an active run by ordinary request. |
| `/autoresearch decide --add <note>` | Append a bounded reusable decision through the kernel-controlled document writer. |
| `/autoresearch refine [instructions]` | Run an audited local refinement review; global refinement requires explicit authorization. |

The headless command-line entry, `--autoresearch <objective>`, uses normal session
creation and sends the start request through existing prompt transport. Immutable
scorecard flags are `--scope`, `--metric-name`, `--direction`, `--verify`,
`--metric-key`, `--target`, `--guard`, and `--timeout-seconds`; the last is the v2
per-command evaluator/guard timeout, not a renewable workflow wall-time budget.
Resource-plan flags include `--max-parallel`, `--worktree-root`, `--lease-seconds`,
`--window`, `--min-per-role`, `--plateau-k`, `--max-candidates`, finite run/candidate
wall and token ceilings, planner/strategy/analysis ceilings, and the explicit
resource/cloud envelope. There is no hidden parallelism or implicit cloud selection.
A headless process may exit while approval, budget, recovery, or a blocker is
durable; a later status/resume continues the same run.
`--max-candidates` selects the initial finite kernel candidate-dispatch ceiling; it
does not populate immutable v2 `max_candidates`.

Status mapping is explicit and has one precedence rule: the generic kernel journal
and the generic workflow reducer instance outrank any v2 projection, and a validated v2 prefix outranks
logs, reports, transcripts, or worker claims. A v2 `error` can therefore pause a
native run for reconciliation, but cannot manufacture native completion or replace
an already-authorized native cancellation. The typed projection is:

```ts
interface StatusProjection {
  native: RunStatus;
  workflow: WorkflowStatus;
  workflowPhase: WorkflowPhaseId;
  autoResearchPhase: RunPhase | null;
  goal: WorkflowGoalProjectionStatus;
  source: "kernel" | "v2_prefix";
  reason: string;
}
```

The phase tag mapping is closed and deterministic:

| AutoResearch phase | Generic phase |
| --- | --- |
| `scorecard` | `hardening_scorecard` |
| `baseline`, `evaluating` | `verifying_evidence` |
| `claiming` | `dispatching` |
| `executing` | `executing` |
| `admitting` | `adjudicating` |
| `reconciling` | `recovering` |
| `verifying` | `verifying` |
| `auditing_completion` | `auditing_completion` |
| `refining` | `refining` |

Delegated generic phases retain their exact `WorkflowPhaseId` without inventing
an AutoResearch phase: `discovering_capacity`, `hardening_goal`,
`reconnaissance`, `analyzing_lenses`, `synthesizing`, `red_teaming`, `planning`,
and `auditing_progress` use `autoResearchPhase = null` unless an experiment phase
is concurrently being projected read-only. Generic phase authority never flows
backward from the optional domain tag.

Status rows below select the phase through this table; an `or` in explanatory
prose never represents a second mapping.

The deterministic rows are:

| Native condition | Generic workflow / phase | Goal projection | v2 compatibility projection |
| --- | --- | --- | --- |
| `not_initialized` or `awaiting_user` | `awaiting_user` / exact delegated preflight phase (`hardening_goal`, decision-pipeline phase, or `hardening_scorecard`) | `idle` when no goal is bound, otherwise `paused` | no v2 write |
| initialization failure before `initialized` | `failed` / `recovering` | `error` | no v2 write; retain diagnostic artifacts only |
| `active` in scorecard/baseline | `active` / mapped phase above | `active` | last valid v2 prefix; no status invention |
| `active` in claiming/executing/evaluating/admitting | `active` / mapped phase above | `active` | v2 candidate projection only at the defined resolution boundary |
| `paused` or user-stopped `stopped` | `paused` / `recovering` | `paused` | compatible v2 `stopped` only when authorized and representable |
| `budget_limited` | `budget_limited` / `dispatching` | `budget_limited` | v2 stop only if its reason/shape is exact |
| `blocked` | `blocked` / `recovering` | `paused` | compatible v2 `blocked` with exact blocker evidence when representable |
| `target_pending_verification` | `active` / `verifying` | `active` | exact v2 `complete` target event is present, but is only experiment-target projection, never native workflow/goal completion |
| validated legacy v2 `complete` under a read-only attachment | `awaiting_user` / `recovering` | `paused` | preserve the exact v2 prefix; require hardening/rebaseline before native target verification |
| `failed` from invalid native state or unreconciled invariant | `failed` / `recovering` | `error` | no synthetic v2 reason; preserve last valid prefix |
| consistent v2 `error` discovered during native operation | `paused` / `recovering` | `paused` | v2 error remains the observed prefix; native dispatch is fenced |
| native `cancelled` | `cancelled` / `recovering` | `paused` | compatible v2 `stopped` reason may be atomically projected; binding remains terminal |
| `complete` after verification/audit/refinement | `complete` / last committed `refining` phase | `complete` | preserve the already-bound v2 `complete`; commit native workflow/goal completion only now |

`target_pending_verification` is an AutoResearch specialization-only projection
of generic `WorkflowStatus: "active"` and `WorkflowPhaseId: "verifying"`; its
`AutoResearchTargetPendingProjection` is read-only, cannot schedule work, and
cannot complete the workflow or goal. The generic reducer and completion gate
remain authoritative, while the exact v2 artifact must retain v2 semantics.
Only an admitted frontier or approved baseline
can cause the host to atomically project the required v2 `complete` target event,
record kernel `target_reached`, fence new claims/admissions, and reconcile late
candidates. The v2 event means only that its numeric experiment target was reached;
it cannot complete the native workflow or bound goal. Fresh verification,
completion red team, and final refinement authorization still gate those native
transitions, with no second v2 `complete` append. A baseline that already satisfies
the target writes one valid initial v2 prefix containing zero-based `baseline` and
the required following `complete`, then enters native target-pending. A
legacy v2 complete run instead attaches read-only in
`awaiting_user`/`recovering` and is never treated as bound-goal completion
merely because its prefix says complete. Only an explicitly approved
hardening/rebaseline that still meets the target may enter native
target-pending verification. Restart replays this precedence and never infers
completion from a target metric alone.

If native verification later finds a substantive goal gap, that is evidence that
the approved scorecard was insufficient. The completed v2 experiment stays
immutable. The host records `verification_gap_found`, transitions the generic
workflow to `awaiting_user`, pauses the same still-owned goal, and publishes an
exact replacement request. Only fresh goal-contract amendment, scorecard, and
resource decisions that each complete the universal pipeline and required user
approvals may authorize `run_archive_intent`. The host then reconciles every old
child/lease, archives the closed run by ID and prefix digest, generates a new opaque
run ID, and initializes a fresh results root/baseline before reactivating the same
goal binding. It never appends candidates after v2 `complete` or treats a failed
native verification as v2 `active`. A materially different objective is not this
replacement path: it requires explicit workflow cancellation, goal replacement,
and a newly approved workflow binding.

### Status view

The interactive status panel is a read-only projection of validated state. It shows:

- run and workflow IDs, current status/phase, scorecard revision, and journal
  sequence/digest;
- goal, metric direction, baseline, current frontier, target, strict improvement
  rule, and the last accepted evidence reference;
- fixed evaluator and guard digests, scope prefixes, excluded evaluator paths, and
  the current known-good baseline commit;
- one row per candidate with role, branch/worktree, base/frontier commit, lifecycle
  state, lease age/expiry, grant, attempt number, metric result, guard result,
  red-team result, and immutable log/result links;
- available, claimed, running, lapsed, and reserved local/cloud capacity;
- exploit streak, forced-explore reason, rolling window role counts, candidate and
  budget usage, and the exact stop/block/pause reason; and
- pending scorecard approval, scope amendment, cloud authorization, reconciliation
  decision, or completion audit.

No percentage complete is displayed. A chart may show the measured metric trajectory
and candidate outcomes, but it is a derived report and never a completion claim.

## Typed Configuration and State

The following TypeScript model is the native binding and specialization contract
between the host, kernel journal reducer, scheduler, evaluator, and UI. It is not a
replacement schema for v2 `run.json`/`events.jsonl`. Generic decision, approval,
resource-envelope, lease, artifact, and fencing types are imported from the workflow
kernel rather than redeclared. The compatible run ID and existing daemon/session/
goal IDs remain opaque strings; candidate/attempt/event sequence IDs are positive
integers, while the compatibility v2 event sequence is the separate zero-based
`V2EventSequence` type.

Numeric native candidate and attempt IDs never cross the generic API directly.
The adapter publishes one `CandidateKernelIdBinding` and maps them to stable string
task/attempt IDs scoped by opaque run ID; kernel lease IDs remain strings. When a
representable resolution is projected, a separate `CandidateV2ProjectionBinding`
maps the native identity to the next consecutive positive v2 candidate number.
Replay rejects an ID or projection number used with a different binding digest.

`ResourceLeaseRef`, `OwnershipLeaseRef`, and `CandidateLeaseProjection` below
are read-only projections of the canonical `WorkflowResourceLease` and
`WorkflowOwnershipLease`. They introduce no AutoResearch lease reducer,
transition, renewal, release, or expiry authority; replay recomputes them from
the generic workflow store.

```ts
type AutoResearchRunId = string;
type CandidateId = number;
type AttemptId = number;
type V2CandidateNumber = number; // host validates the next consecutive positive integer
type KernelEventSequence = number; // host validates positive integer
type V2EventSequence = number; // host validates integer >= 0
type MetricDirection = "lower" | "higher";
type Role = "exploit" | "explore";

type MetricDirectionBinding =
  | { native: "lower"; kernel: "minimize" }
  | { native: "higher"; kernel: "maximize" };

type MetricParser =
  | { kind: "scalar"; finalLine: "finite_number" }
  | { kind: "json"; finalLine: "object"; metricKey: string };

interface FixedEvaluator {
  command: string;
  argv: string[];
  shell: false;
  parser: MetricParser;
  cwd: "candidate_worktree";
  immutableBundlePaths: string[];
  sourcePaths: string[];
  inputPaths: string[];
  dependencyBundleDigests: string[];
  inputBundleDigests: string[];
  heldOutDataRef?: string;
  scratch: {
    root: string;
    perAttempt: true;
    writableByEvaluator: true;
  };
  evaluatorDigest: string;
  timeoutMs: number;
  sanitizedEnvironment: Record<string, string>; // non-secret allowlisted values only
  inheritedEnvironment: "clean";
  cachePolicy: "attempt_unique" | "pinned_read_only";
  network: "disabled" | "user_authorized";
  networkEnforcement: "blocked" | "authorized_egress";
  descendantProcessEnforcement: "tracked_and_terminated";
}

interface PrimaryMetric {
  name: string;
  direction: MetricDirection;
  target: number;
  evaluator: FixedEvaluator;
  repeatability:
    | {
        kind: "single_deterministic";
        baselineRuns: 1;
        candidateRuns: 1;
        aggregation: "exact";
        tolerance: 0;
        hostDeterminismAttestationRef: string;
        deterministicInputClosureDigest: string;
      }
    | {
        kind: "repeated";
        baselineRuns: number;
        candidateRuns: number;
        aggregation: "median" | "mean";
        tolerance: number;
        maxVariance: number;
        heldOutInputDigest?: never;
      }
    | {
        kind: "held_out";
        baselineRuns: number;
        candidateRuns: number;
        aggregation: "median" | "mean";
        tolerance: number;
        maxVariance: number;
        heldOutInputDigest: string;
      };
}

interface HostCheckDescriptor {
  descriptorId: string;
  command: string;
  argv: readonly string[];
  shell: false;
  cwd: "isolated_verification";
  immutableBundlePaths: readonly string[];
  sourceBundleDigests: readonly string[];
  dependencyBundleDigests: readonly string[];
  inputBundleDigests: readonly string[];
  fixtureBundleDigests: readonly string[];
  expectedExitCode: 0;
  timeoutMs: number;
  sanitizedEnvironment: Readonly<Record<string, string>>;
  inheritedEnvironment: "clean";
  network: "disabled" | "user_authorized";
  descriptorDigest: string;
  evidenceFreshnessSeconds: number;
}

interface HostCheckResultBase {
  descriptorId: string;
  descriptorDigest: string;
  executionIdentity: string;
  workspaceDigest: string;
  stdoutRef: string;
  stderrRef: string;
  evidenceDigest: string;
  completedAt: string;
}

type HostCheckResult = HostCheckResultBase &
  (
    | { passed: true; exitCode: 0 }
    | {
        passed: false;
        exitCode: number | null;
        failureKind:
          | "nonzero_exit"
          | "timeout"
          | "spawn_failed"
          | "missing_evidence"
          | "stale_evidence"
          | "descriptor_changed"
          | "workspace_changed"
          | "containment_violation";
        diagnosticRef: string;
      }
  );

type HostCheckPassResult = Extract<HostCheckResult, { passed: true }>;

interface HostGuardResultBase {
  guardDigest: string;
  executionIdentity: string;
  workspaceDigest: string;
  logRef: string;
  evidenceDigest: string;
  completedAt: string;
}

type HostGuardResult = HostGuardResultBase &
  (
    | { passed: true; exitCode: 0 }
    | {
        passed: false;
        exitCode: number | null;
        failureKind: "nonzero_exit" | "timeout" | "spawn_failed" | "stale_or_changed";
        diagnosticRef: string;
      }
  );

type HostGuardPassResult = Extract<HostGuardResult, { passed: true }>;

interface AcceptanceCheck {
  checkId: string;
  descriptor: HostCheckDescriptor;
  expected: "pass";
}

interface ProtectedInvariant {
  invariantId: string;
  description: string;
  descriptor: HostCheckDescriptor;
}

interface ScopeSpec {
  revision: number;
  repoRelativePrefixes: string[];
  excludedPrefixes: string[];
  editableBy: "user";
}

interface GuardSpec {
  command: string;
  sourcePaths: string[];
  guardDigest: string;
  timeoutMs: number;
  inheritedEnvironment: "clean";
  cachePolicy: "attempt_unique" | "pinned_read_only";
  network: "disabled" | "user_authorized";
  baselineRequired: true;
}

interface BudgetSpec {
  maxParallel: number | "bank";
  maxCandidates: number;
  maxRunWallSeconds: number;
  maxRunTokens: number;
  maxCandidateWallSeconds: number;
  maxCandidateTokens: number;
  maxPlannerCycles: number;
  maxDistinctStrategiesPerRequirement: number;
  maxAnalysisAttemptsPerRequirement: number;
  leaseSeconds: number;
  window: number;
  minPerRole: number;
  plateauK: number;
  kernelCeilings: WorkflowExecutionCeilings;
}

type ResourceVector = WorkflowResourceVector;

interface LegacyV2ComputeBank {
  cores_per_candidate: number;
  measurement: "parallel" | "exclusive";
  bank: Array<
    | { id: string; kind: "cores"; cores: number; label: string }
    | { id: string; kind: "agents"; slots: number; label: string }
    | { id: string; kind: "node"; capacity: number; label: string }
  >;
  workers: {
    simple: { model: string; thinking_tokens: number };
    standard: { model: string; thinking_tokens: number };
    complex: { model: string; thinking_tokens: number };
  };
}

interface AutoResearchMeasurementBase {
  measurementId: string;
  runId: AutoResearchRunId;
  candidateId: CandidateId | null;
  attemptId: AttemptId | null;
  sampleIndex: number;
  sampleCount: number;
  aggregation: "exact" | "mean" | "median";
  direction: MetricDirection;
  metricValue: number;
  variance: number;
  maxVariance: number;
  inputDigest: string;
  evaluatorRef: WorkflowArtifactRef;
  evaluatorDigest: string;
  parserRef: WorkflowArtifactRef;
  parserDigest: string;
  workspaceDigest: string;
  evidenceRefs: readonly WorkflowArtifactRef[];
  measuredAt: number;
  measurementDigest: string;
}

type AutoResearchMeasurementRef =
  | (AutoResearchMeasurementBase & {
      kind: "baseline" | "candidate" | "replay" | "canary";
      heldOutInputDigest?: never;
    })
  | (AutoResearchMeasurementBase & {
      kind: "held_out";
      heldOutInputDigest: string;
    });

interface LegacyV2ParallelProjection {
  max_parallel: number | "bank";
  max_parallel_resolved: number;
  worktree_root: string;
  prepare: string | null;
  lease_seconds: number;
  allocation: { window: number; min_per_role: number; plateau_k: number };
}

interface ComputeBankProjection {
  schema: number;
  v2: {
    bank: LegacyV2ComputeBank;
    parallel: LegacyV2ParallelProjection;
  };
  selectedExecutionProfile: "inline" | "parallel";
  selectedWorkerTier: "simple" | "standard" | "complex";
  computeDigest: string;
  prepare: string | null;
  controlReserve: ResourceVector;
  local: Array<{
    node: number;
    source: "detect" | "user";
    resources: ResourceVector;
    coresPerCandidate: number;
    maxCandidates: number;
  }>;
  cloud?: WorkflowCloudEnvelope;
}

interface Scorecard {
  revision: number;
  objective: string;
  primaryMetric: PrimaryMetric;
  acceptanceChecks: AcceptanceCheck[];
  protectedInvariants: ProtectedInvariant[];
  scope: ScopeSpec;
  guard?: GuardSpec; // compatible v2 permits zero or one guard command
  improvementEvaluatorContract: WorkflowImprovementEvaluatorContract;
  scorecardDecisionRef: WorkflowDecisionRef;
  scorecardDigest: string;
  redTeamDigest: string;
}

interface AutoResearchResourcePlan {
  revision: number;
  executionProfile: "inline" | "parallel";
  budget: BudgetSpec;
  compute: ComputeBankProjection;
  controlCapacity: WorkflowControlCapacityVector;
  canonicalPoolLedgerRef: WorkflowArtifactRef;
  resourceEnvelopeRef: WorkflowArtifactRef;
  authenticatedCapacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
  revisionRegistryRef: WorkflowArtifactRef;
  revisionRegistryDigest: string;
  worktreeRoot: string;
  resourceDecisionRef: WorkflowDecisionRef;
  resourcePlanDigest: string;
  redTeamDigest: string;
}

interface BaselineEvidence {
  commit: string;
  branch: string;
  metric: number;
  guardResults: Array<HostGuardPassResult>;
  acceptanceResults: Array<HostCheckPassResult & { checkId: string }>;
  protectedInvariantEvidence: Array<
    HostCheckPassResult & { invariantId: string; held: true }
  >;
  workspaceDigest: string;
  evaluatorDigest: string;
  measurementRefs: readonly AutoResearchMeasurementRef[];
  measuredAt: number;
}

interface AutoResearchRunConfig {
  schema: number;
  runId: AutoResearchRunId;
  workflowId: string;
  rootSessionId: string;
  goalId: string;
  objectiveDigest: string;
  repositoryRoot: string;
  baseBranch: string;
  scorecard: Scorecard;
  initialResourcePlan: AutoResearchResourcePlan;
  baseline: BaselineEvidence;
  configDigest: string;
}

type RunStatus =
  | "not_initialized"
  | "awaiting_user"
  | "active"
  | "paused"
  | "budget_limited"
  | "blocked"
  | "stopped"
  | "cancelled"
  | "target_pending_verification"
  | "failed"
  | "complete";

type RunPhase =
  | "scorecard"
  | "baseline"
  | "claiming"
  | "executing"
  | "evaluating"
  | "admitting"
  | "reconciling"
  | "verifying"
  | "auditing_completion"
  | "refining";

type CandidateStatus =
  | "claimed"
  | "dispatched"
  | "running"
  | "awaiting_finish"
  | "measuring"
  | "admitting"
  | "stale"
  | "admitted"
  | "discarded"
  | "abandoned"
  | "reaped"
  | "interrupted"
  | "failed";

type ResourceLeaseRef = Pick<
  WorkflowResourceLease,
  | "leaseId"
  | "status"
  | "storeEpoch"
  | "coordinatorEpoch"
  | "acquisitionEventSequence"
  | "expiresAt"
>;

type OwnershipLeaseRef = Pick<
  WorkflowOwnershipLease,
  | "leaseId"
  | "status"
  | "storeEpoch"
  | "coordinatorEpoch"
  | "acquisitionEventSequence"
>;

interface CandidateLeaseProjection {
  resourceLease: ResourceLeaseRef;
  ownershipLease: OwnershipLeaseRef;
  observedAt: string;
  lapsed: boolean;
}

interface CandidateState {
  candidateId: CandidateId;
  attemptId: AttemptId;
  role: Role;
  packetDigest: string;
  childIdentity?: WorkflowChildIdentity;
  epochRef: WorkflowEpochRef;
  executionKey: string;
  baseCommit: string;
  branch: string;
  worktree: string;
  status: CandidateStatus;
  grant: ResourceVector;
  capacityGrant: WorkflowCapacityGrant;
  controlCapacityGrant: WorkflowControlCapacityVector;
  controlCapacityProjectionDigest: string;
  taskValueCertificateRef: WorkflowArtifactRef;
  lease: CandidateLeaseProjection;
  resultRefs: string[];
  measurementRefs: readonly AutoResearchMeasurementRef[];
  lastKernelEventSequence: KernelEventSequence;
}

interface CandidateKernelIdBinding {
  runId: AutoResearchRunId;
  candidateId: CandidateId;
  attemptId: AttemptId;
  workflowTaskId: string;    // ar:<run-id>:candidate:<candidate-id>
  workflowAttemptId: string; // ar:<run-id>:attempt:<attempt-id>
  workflowLeaseRef: WorkflowLeaseRef;
  bindingDigest: string;
}

interface CandidateV2ProjectionBinding {
  runId: AutoResearchRunId;
  candidateId: CandidateId;
  attemptId: AttemptId;
  v2CandidateNumber: V2CandidateNumber;
  projectionIntentEventSequence: KernelEventSequence;
  priorV2PrefixDigest: string;
  bindingDigest: string;
}

interface FrontierState {
  frontierRef: string;
  frontierWorktree: string;
  commit: string;
  metric: number;
  admittedCandidate?: CandidateId;
  workspaceDigest: string;
  resultRef: string;
  measurementRefs: readonly AutoResearchMeasurementRef[];
  refGeneration: number;
  refDigest: string;
  compareAndSwap: {
    expectedRef: string;
    expectedCommit: string;
    expectedGeneration: number;
    executionKey: string;
    epochRef: WorkflowEpochRef;
  };
}

interface ExpectedArtifact {
  kind: "run_config" | "event_prefix" | "baseline_log" | "acceptance_log" | "diagnostic";
  relativePath: string;
}

interface InitializationIntent {
  executionKey: string;
  resourceLease: ResourceLeaseRef;
  ownershipLease: OwnershipLeaseRef;
  expectedArtifacts: ExpectedArtifact[];
  expectedV2RunId: AutoResearchRunId;
  expectedV2FirstSeq: 0;
}

interface LegacyRunBinding {
  schema: 1;
  runId: AutoResearchRunId;
  repositoryRoot: string;
  rootSessionId: string;
  workflowId: string;
  goalId: string;
  objectiveDigest: string;
  configDigest: string;
  eventPrefixSequence: V2EventSequence;
  eventPrefixDigest: string;
  mappedV2Status: "active" | "stopped" | "blocked" | "error" | "complete";
  approvalRequestId: string;
  approvalDecisionRef: WorkflowDecisionRef;
  epochRef: WorkflowEpochRef;
  attachedAt: string;
}

interface AutoResearchStateBase {
  workflowId: string;
  rootSessionId: string;
  goalId: string;
  objectiveDigest: string;
  epochRef: WorkflowEpochRef;
  status: RunStatus;
  workflowPhase: WorkflowPhaseId;
  experimentPhase: RunPhase | null;
  availableSlots: number;
  lastError?: string;
  lastKernelEventSequence: KernelEventSequence;
}

interface AutoResearchTargetPendingProjection {
  status: "target_pending_verification";
  genericWorkflowStatus: "active";
  genericWorkflowPhase: "verifying";
  targetReachedEventRef: WorkflowArtifactRef;
  verificationGapRef: WorkflowArtifactRef;
  readOnlySpecialization: true;
  cannotSchedule: true;
  cannotComplete: true;
  projectionDigest: string;
}

interface AutoResearchPreflightState extends AutoResearchStateBase {
  initialization: "preflight";
  runId?: AutoResearchRunId;
  status: "not_initialized" | "awaiting_user" | "cancelled" | "failed";
  experimentPhase: "scorecard" | "baseline" | null;
  scorecardProposalRef?: string;
  scorecardDecisionRef?: WorkflowDecisionRef;
  resourceDecisionRef?: WorkflowDecisionRef;
  initializationIntent?: InitializationIntent;
  initializationGuardResults?: readonly HostGuardResult[];
  initializationCheckResults?: readonly HostCheckResult[];
  candidates: readonly [];
  availableSlots: 0;
}

interface AutoResearchInitializedState extends AutoResearchStateBase {
  initialization: "initialized";
  runId: AutoResearchRunId;
  status: Exclude<RunStatus, "not_initialized">;
  configDigest: string;
  baseline: BaselineEvidence;
  frontier: FrontierState;
  activeResourcePlan: AutoResearchResourcePlan;
  candidates: CandidateState[];
  availableSlots: number;
  roleWindow: { exploit: number; explore: number; completed: number };
  targetPendingProjection: AutoResearchTargetPendingProjection | null;
  consecutiveNonAdmittingExploits: number;
  lastError?: string;
  stopReason?: "target" | "user" | "candidate_limit" | "budget" | "plateau" | "blocked";
}

interface AutoResearchRunArchiveRef {
  runId: AutoResearchRunId;
  finalV2PrefixSequence: V2EventSequence;
  finalV2PrefixDigest: string;
  archiveArtifactRef: WorkflowArtifactRef;
  archiveDecisionRef: WorkflowDecisionRef;
  archivedAt: string;
  archiveDigest: string;
}

interface AutoResearchReplacementState extends AutoResearchStateBase {
  initialization: "replacement_pending";
  status: "awaiting_user";
  experimentPhase: "reconciling" | "scorecard" | "baseline";
  closedRun: AutoResearchInitializedState & {
    status: "target_pending_verification";
    targetPendingProjection: AutoResearchTargetPendingProjection;
  };
  verificationGapRef: WorkflowArtifactRef;
  goalContractDecisionRef?: WorkflowDecisionRef;
  replacementScorecardDecisionRef?: WorkflowDecisionRef;
  replacementResourceDecisionRef?: WorkflowDecisionRef;
  archivedRun?: AutoResearchRunArchiveRef;
  replacementRunId?: AutoResearchRunId;
  candidates: CandidateState[]; // observed old-run candidates; all must be terminal before archive
  availableSlots: 0;
}

type AutoResearchState =
  | AutoResearchPreflightState
  | AutoResearchInitializedState
  | AutoResearchReplacementState;
```

`RunStatus`, `RunPhase`, and `AutoResearchState` are typed specialization views
reduced from accepted generic workflow events plus the exact bound v2 prefix. They
do not have a separate coordinator, reducer, approval path, or terminal authority.
Every domain transition maps to one `WorkflowStatus`/`WorkflowPhaseId` transition
inside the generic reducer; an invalid or unknown domain tag cannot schedule work or
advance the goal. V2 status remains a compatibility projection and never outranks
the generic state.

Validation rejects unknown schema fields, nonpositive integer limits, empty or
absolute scope prefixes, absolute evaluator source paths, non-finite targets or
metrics, a target that cannot be meaningfully compared to the direction, a guard
that fails at baseline, a cloud envelope without user authorization, and a
`maxParallel` value that cannot be accounted for by the selected bank. No field is
silently defaulted when it controls parallelism, budget, lease, or admission.
Every per-run and aggregate measurement is a typed `AutoResearchMeasurementRef`
with host evaluator/parser, input, workspace, aggregation, sample, and variance
digests; a `held_out` measurement must carry its required
`heldOutInputDigest`, while other kinds cannot smuggle one in. Missing,
non-finite, duplicate, or out-of-range measurement metadata fails admission.
The active resource plan's `executionProfile` is `inline` when the approved resolved
candidate concurrency is one and `parallel` when it is greater than one; it is part
of the resource approval and persisted in the generic workflow capsule. Changing it
requires a new run because compatible v2 parallelism is immutable.

The specialization adapter maps `lower -> minimize` and `higher -> maximize`;
AutoResearch does not use the kernel's point-target direction. It converts
`evidenceFreshnessSeconds` to kernel milliseconds with checked integer
multiplication and preserves the original seconds in the compatibility
projection. Overflow, rounding, or a conflicting direction binding fails
validation.

### Resource vectors and capacity

`compute detect` reports observed local capacity and provenance without writing. The
user chooses the bank and the host writes the compatible explicit `compute.json`,
whose exact v2 fields are `cores_per_candidate`, `measurement`, `bank`, and
`workers`; the host also persists the exact v2 parallel projection fields
`max_parallel`, `max_parallel_resolved`, `worktree_root`, `prepare`,
`lease_seconds`, and `allocation`. The selected execution profile and selected
worker tier are explicit native decisions, and `computeDigest` covers the
canonical bank, parallel projection, selected profile, and control reserve. The
host translates each legacy bank entry into a multidimensional kernel grant:
cores become CPU capacity, agent slots become provider/session capacity, and a
node becomes an exclusive resource. Translation never overbooks a pool and does
not infer missing limits. Candidate admission uses
the kernel's multidimensional fit across CPU, RAM/headroom, disk/I/O, GPU/device
memory, process/session/provider slots, wall time, tokens, request/rate/cost, and
egress pools. The historical core/node formula is only a compatibility projection;
it can never allocate a slot when another pool is exhausted. Planner, decision,
audit, verification, and recovery control-plane reserve is subtracted before
candidate capacity is computed.

The plan's `canonicalPoolLedgerRef` is the single per-pool authority: its
instantaneous concurrency/token/byte/wall pools are distinct from cumulative
spend pools, and the plan's control reserve, candidate grant, and legacy bank
projection carry only ledger-bound digests. Candidate `grant` and
`controlCapacityGrant` fields are projections of the discriminated
`capacityGrant`, not independent reserves. Candidate admission uses a
discriminated worker/control `WorkflowCapacityGrant`; the worker variant has
zero control dimensions, and all eight hard control dimensions are reconciled
component-wise without a duplicate reserve ledger.

`prepare` is an immutable v2 compatibility command projection, not an unreviewed
setup hook: its digest, cwd, argv, shell policy, and output artifacts are bound in
the native decision. The selected profile may only narrow the approved bank; it
cannot silently increase concurrency. The native control-plane reserve is charged
before worker grants and remains available for planning, admission, recovery, and
completion even when candidate capacity is exhausted.

Local grants are conservative accounting on platforms without a hard resource
isolator. The host observes process groups and available OS telemetry; worker
self-report is not authoritative. The coordinator does not claim that macOS or
another host enforces CPU shares. Observed pressure/overage reduces admission,
quarantines the candidate before frontier admission, and enters reconciliation; it
is not hidden by reducing recorded usage. Every candidate/process and the entire
native run have finite approved ceilings. Unknown or unenforceable consumption
uses the kernel's `exclusive_unisolated` resource admission and serializes the
affected pools rather than relying on after-the-fact telemetry.

Cloud execution is disabled unless the kernel has completed its cloud-availability
question and a user-approved/red-teamed `WorkflowCloudEnvelope` plus concrete host
adapter can report launch, usage, termination, billing lag, and provenance. The
envelope is a product boundary, not a promise that this repository launches a
provider. It specifies provider/account/region, credential reference, expiry,
maximum spend, wall time, candidate count, provider-side idempotency, and data-egress policy. Credentials are
never written to packets, `run.json`, `events.jsonl`, logs, reports, or refinement
memory. The scheduler reserves the envelope before dispatch, refuses a launch when
remaining limits are unknown, and pauses for user direction when provider usage or
termination is ambiguous. There is no silent local/cloud fallback and no cloud
retry that could duplicate a non-idempotent charge.

## Adaptive candidate allocation and improvement contract

AutoResearch consumes the kernel's adaptive allocation state and emits only a
read-only specialization projection. The projection binds observations to the
fixed scorecard/frontier and makes the reason for a grant visible; it does not
introduce a candidate allocator or a second event schema.

```typescript
interface AutoResearchAdaptiveObservation {
  runId: AutoResearchRunId;
  sourceJournalSequence: KernelEventSequence;
  sourceJournalDigest: string;
  scorecardDigest: string;
  resourcePlanDigest: string;
  frontierDigest: string;
  revisionRegistryRef: WorkflowArtifactRef;
  revisionRegistryDigest: string;
  criticalPathCertificateRef: WorkflowArtifactRef;
  criticalPathCandidateIds: readonly CandidateId[];
  readyCandidateRoles: readonly Role[];
  evidenceGapRefs: readonly WorkflowArtifactRef[];
  blockerRefs: readonly WorkflowArtifactRef[];
  throughputEvidenceRefs: readonly WorkflowArtifactRef[];
  latencyEvidenceRefs: readonly WorkflowArtifactRef[];
  marginalAdmittedProgressEvidenceRefs: readonly WorkflowArtifactRef[];
  uncertaintyEvidenceRefs: readonly WorkflowArtifactRef[];
  liveLeaseRefs: readonly ResourceLeaseRef[];
  controlReserve: ResourceVector;
  controlReserveCapacity: WorkflowControlCapacityVector;
  observedControlCapacity: WorkflowControlCapacityVector;
  authenticatedCapacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
  limitingPool: WorkflowAdaptiveBottleneckPool;
  fixedMetricDigest: string;
  fixedGuardDigest: string | null;
  observationDigest: string;
}

interface AutoResearchAdaptiveProjection {
  runId: AutoResearchRunId;
  genericAllocationStateRef: WorkflowArtifactRef;
  observationRef: WorkflowArtifactRef;
  allocationRevision: number;
  roleWindow: { exploit: number; explore: number; completed: number };
  minimumWindowEvents: number;
  cooldownUntil: string | null;
  rollbackAllocationRef: WorkflowArtifactRef | null;
  status: "stable" | "rebalancing" | "awaiting_user" | "quarantined";
  projectionDigest: string;
}
```

The host derives candidate demand from verified queue age, evaluator/guard
latency, frontier dependency, accepted metric movement, lease pressure, and
control reserve. A metric value is useful only after fixed evaluator,
repeatability, acceptance-check, invariant, and anti-gaming evidence has been
accepted; utilization or a candidate claim is never progress. The controller
may adjust candidate grants, exploit/explore role mix, worktree/evaluator
slots, and refill timing inside the approved bank. It may not change the
objective, scorecard, metric, target, direction, evaluator, parser, guard,
scope, v2-visible parallel fields, or frontier authority through adaptation.

For every claim, result, admission/rejection, lease release, material evidence
transition, phase transition, and recovery event, the host captures a fresh
observation and sends any allocation change through the generic recon, distinct
lenses, evidence verification, synthesis, anti-gaming red team, and host gate.
An unchanged observation is a deterministic no-op. Hysteresis, `window`,
`minPerRole`, `plateauK`, and finite reallocation ceilings prevent role or slot
thrash; a protected-invariant failure or threatened control reserve can force an
immediate stop. Unknown capacity and stale provider reports are zero. Any
proposal that increases resource, cloud, spend, egress, credential, authority,
or execution ceilings pauses for the exact user approval and resource decision;
the scheduler never silently falls back to local or inferred capacity.

Adaptive state uses the kernel observation/allocation epochs and compare-and-
swap. A stale frontier, scorecard, resource-plan, lease, workspace, evaluator,
guard, or config digest rejects the observation without moving a candidate. A
controller crash replays the last committed allocation, quarantines uncertain
worktree/provider leases and charges, and reruns reconciliation before refill.
Rollback restores the prior allocation only through an exact CAS; a conflict
pauses dispatch and requests a fresh decision. No late worker or v2 projection
can become free capacity or change the frontier by observation alone.

The kernel's host-derived critical-path certificate is reproducible from the
accepted candidate DAG, typed host-derived remaining-work estimates,
host-observed novelty/nonduplicate proofs, and scheduler-policy digest. Its
lexicographic objective is time-to-genuine-proof, then evidence gap, cost,
uncertainty, queue age, and deterministic candidate/task ID digest. Independent
host admission binds the certificate to the accepted DAG and estimate digests.
Each candidate role/task binds a host task-value certificate to an unproven
requirement/evidence gap, typed novelty proof, typed bounded observable outcome,
finite exploration quota, and independent admission; candidate utilization or
metric claims never substitute for it.

Every candidate allocation binds task, attempt, resource lease, ownership lease,
discriminated worker/control `WorkflowCapacityGrant` backed by the generic
`WorkflowCanonicalPoolLedger`, and task-value certificate. Only `unclaimed`
slots may shift in place. A
claimed/active candidate is fenced and reconciled before a new attempt and
lease are created, and late results cannot alter the frontier. The resource plan
and every observation carry authenticated capacity, usage, billing, and
rate-limit snapshot refs with monotonic sequence and `observedAt`/`expiresAt`
TTL; stale, expired,
unauthenticated, or unknown state is zero at CAS, including provider charges.
Process, session, model-call/token, and recovery control partitions are hard;
`exclusive_unisolated` candidates are isolated/serialized away from the control
plane.

AutoResearch persists fairness aging, last-served role/task, bounded
priority-bucket promotion, finite exploration quota, `benefitThreshold`,
`minimumDwellMilliseconds`, minimum observation window,
`maxTransitionsPerWindow`, and last decision. After a positive starvation
deadline, role aging may promote only within the bounded configured buckets and
promotion-per-window count, without outranking the certified proof objective.
All fairness/hysteresis values are finite, positive, and range-validated. Only
a recorded safety override may bypass those limits, and it cannot expand the
fixed metric/guard envelope. Observations are
coalesced to one latest pending and one active review; superseded pending work
is cancelled and an active review is fenced so its result cannot apply.

Allocation intent precedes every grant, lease, evaluator, frontier, and provider
effect. A crash before the applied marker is uncertain and requires effect-broker
nonexecution proof or fenced idempotent reconciliation, including provider
charges and leases. Expired candidate leases reclaim only after strong
nonexecution proof; otherwise a finite deadline records terminal escalation,
not an indefinite user reap.

### AutoResearch projection of the recurring efficiency red team (`cron`)

The generic resource envelope schedules one fresh independent `cron` reviewer
per window and may arm major candidate/phase/lease/evidence transitions. The
AutoResearch projection contributes only fixed-metric/guard context, candidate
role mix, frontier dependency, evaluator/guard latency, queue age, worktree
leases, admitted progress, evidence gaps, uncertainty, cost, and control
reserve. The host resolves that snapshot before invocation; the reviewer never
reads mutable worker output or writes a candidate/worktree.

The host dereferences and re-hashes the immutable original objective,
hardened contract, scorecard/protected invariants, plan, critical-path
certificate, resource/configuration plan, fixed evaluator and optional guard,
revision registry, and authenticated capacity/usage/billing/rate-limit refs
before invocation. Missing, stale, mismatched, revoked, or untrusted refs
reject the snapshot; AutoResearch cannot substitute a mutable run file,
frontier, metric, or self-generated progress proof. The dereference and stale
rejection proof is part of the immutable snapshot consumed by `cron`.

Its immutable charter tests whether candidate placement is the fastest genuine
route to the fixed objective. It checks underuse, overuse, duplicate or
redundant candidates, safely serializable work, context churn, verification and
anti-gaming red-team starvation, review overhead, cloud cost, and Goodhart or
proxy-metric behavior. It may suggest a grant/role/refill change or a schedule
change, but it cannot change the objective, scorecard, metric, target,
evaluator, parser, guard, scope, frontier, lease, v2 projection, or completion.
Applying a suggestion requires the full generic decision and exact approval;
changing the schedule is also a new resource/configuration decision.

Window compare-and-swap rejects an overlapping review and coalesces multiple
candidate transitions into one snapshot/review. Restart admits exactly one
validated catch-up and discards older missed windows. A late, malformed, stale,
or unavailable reviewer is recorded as a bounded nonblocking failure; it leaves
the fixed metric/guard and last safe allocation unchanged, and its reserve
cannot starve candidate admission, evaluator verification, anti-gaming red
team, frontier lock, recovery, or the control plane.

The generic `WorkflowEfficiencyRedTeamInvocation` and typed
`WorkflowEfficiencyRedTeamResult` persist a monotonic clock observation and last-admitted
window sequence/id, rejecting backward, duplicate, or replayed windows. Each
AutoResearch invocation binds the immutable snapshot, reviewer child identity,
independent read-only capability proof, admission and resource/ownership
leases, epoch, execution key, and invocation token. Its typed success/failure
result records actual usage; failed, timed-out, stale, unavailable, or fenced
results are durable nonblocking outcomes and cannot alter candidate admission,
the frontier, or the fixed scorecard.

### AutoResearch improvement review

The host owns and freezes the improvement scorecard, host evaluator/parser
contract, and case manifests; an AutoResearch proposer cannot select, replace,
or omit a manifest. The evaluator contract fixes metric direction,
aggregation, variance/repeatability, deterministic risk classification, and
stage-scoped holdout commitments. Risk-relevant changes require a host-selected
hidden holdout with required `heldOutInputDigest`, required sample sizes,
effect/tolerance thresholds, protected-invariant/non-regression predicates,
and explicit maximum cost and latency. The fixed primary metric/guard remains
unchanged, and these predicates are evaluated independently of candidate claims.

After each experiment phase, incident, and completion gate, the host creates a
bounded refinement trigger from accepted candidate, evaluator, guard, and
recovery evidence. AutoResearch routes it through the generic discriminated
`WorkflowImprovementProposal` → `WorkflowImprovementReview` →
`WorkflowImprovementResult` lifecycle, including baseline/candidate measurement
refs, queue/crash fencing, verifier/Goodhart/regression/safety results, and
registry CAS. The candidate revision is measured against the approved baseline
on the same cases plus held-out, replay, or canary cases where the scorecard
requires them. Independent verification and Goodhart/regression/safety red
team review metric gaming, leakage, overfit, resource cost, authority, and
compatibility. A compatible revision is applied atomically by registry epoch
CAS with rollback-of/event-sequence metadata, reload verification, and
future-load verification. A rejected, stale, unverified, or regressed revision
is not loaded by future runs. Refinement cannot change the AutoResearch
objective or fixed scorecard; those changes are new approved workflow decisions
and, for v2-visible fields, a new archived run/baseline.

Improvement reviews use latest-wins admission with at most one pending and one
active review; superseded pending work is cancelled and fenced active results
cannot apply. The host enforces positive finite duty-cycle, cadence, review
wall/token/cost, per-window/phase/workflow limits, and a dedicated review
reserve disjoint from candidate planner, evaluator/verifier, anti-gaming red
team, frontier, recovery, and control capacity. Invalid or exhausted bounds
fail closed without implicit retry or a resident loop.

Before any phase admission or evaluator/frontier effect, the host resolves the
current revision-registry epoch and compatibility closure. Superseded or
revoked methodology/policy/evaluator entries fence affected candidate attempts,
leases, approvals, and caches; pinned bytes and registry events remain for audit.

### Ownership and first-release boundary

| Concern | Owner | Boundary |
| --- | --- | --- |
| Generic adaptive observation/state/events, leases, CAS, hysteresis, recovery | Workflow kernel (`resources.ts`, `scheduler.ts`, `recovery.ts`) | AutoResearch consumes typed projections; no second reducer, daemon, or hidden capacity |
| Candidate/role demand hints and fixed metric/guard evidence | AutoResearch `scheduler.ts`, `admission.ts`, evaluator adapter | Hints are non-authorizing; scorecard, objective, evaluator, guard, scope, and frontier remain immutable for the run |
| Recurring `cron` efficiency review | Workflow schedule/window/recovery owner with AutoResearch projection | One fresh read-only reviewer/window and one restart catch-up; suggestions have zero write, lease, allocation, approval, or completion authority |
| Host-owned improvement scorecard, hidden holdouts, review budget, and revision registry | Workflow decision/refinement/revision owner | AutoResearch supplies evidence only; host freezes manifests and bounds, checks registry closure/status, and fences affected work on revocation |
| Cloud/account/spend/authority expansion | Workflow decision/approval gate | Exact user approval and reporting adapter required; no silent fallback or provider inference |
| How/why/provenance improvement records | Canonical knowledge/refinement ledger | Canonical commit first; optional MemPalace only indexes approved records |

The first release supports bounded adaptive placement across observable local
banks and already approved cloud adapters, with finite candidate/planner/
analysis/recovery ceilings. It does not promise optimal scheduling or physical
isolation where the host cannot enforce it; it serializes or stops instead.

## Durable Files and Immutable Evidence

The repository-facing layout remains compatible with the current skill:

```text
autoresearch/
  goal.md                 # overarching process goal, required
  decisions.md            # curated decisions, changed only through decide, <= 4 KiB
  compute.json            # selected explicit capacity bank

autoresearch-results/
  run.json                # immutable compatible v2 approved configuration
  events.jsonl            # append-only validated v2 history; baseline has seq 0
  slots.json              # derived liveness projection; never authoritative
  candidates/<id>/
    packet.json           # immutable packet snapshot
    handoffs/<attempt>.json
    results/<attempt>.json
    diffs/<attempt>.patch
    logs/<attempt>-verify.log
    logs/<attempt>-guard.log
    logs/<attempt>-red-team.json
  logs/                   # full command and state diagnostics
  docs/                   # content-addressed goal/decision/compute snapshots
  report.html             # replaceable validated report
```

The durable workflow layer stores its own session artifact directory:

```text
session-artifacts/<session-id>/workflows/<workflow-id>/
  events.log              # framed kernel authorization/phase journal
  autoresearch/<run-id>.json  # binding and result digests
  handoffs/
  evidence/
```

The v2 projection and kernel journal have distinct, explicitly bound roles.
`autoresearch-results/run.json` and `events.jsonl` remain the exact compatibility
surface and source history for unbound legacy v2 status/history/report tools. Once
a run is natively bound, they are a validated projection and never a second native
authority. The kernel journal is the only authority for native decisions, approvals, leases, candidate admission intent,
recovery, and workflow completion. Every v2 mutation is a deterministic projection
between a kernel intent and commit marker, so native progress never depends on an
unbound external append. Neither surface is rebuilt from a report, transcript, or
conversational memory; a missing or conflicting binding enters reconciliation.

The fenced root coordinator is the only native writer of the kernel journal or v2
projection. External legacy commands are detected through a changed v2 prefix and
must be reconciled before native dispatch resumes. A worker may write an
attempt-unique handoff, diff, log, or result file using temporary file, flush,
atomic rename, and parent-directory flush. The coordinator validates the digest and
appends the referencing event. Orphaned artifacts are ignored during replay and
reported for cleanup; they never become evidence automatically.

`run.json` is created only after user approval and successful baseline measurement.
It retains the exact current v2 schema; native scorecard/evaluator/guard/resource
digests and binding identities live in the kernel journal. It is immutable. Any
scorecard change creates a new archived run rather than an in-place revision.

### Kernel journal and v2 projection

The generic workflow journal keeps its canonical schema, hash chain, coordinator
epoch, decision envelope, idempotency key, and immutable artifact references. The
following are AutoResearch payload kinds inside that journal; they are not new v2
`events.jsonl` event shapes:

| Event | Required payload/effect |
| --- | --- |
| `scorecard_proposed` | Proposal, independent-lens findings, and proposal digest; no run yet. |
| `scorecard_red_teamed` | Exact proposal digest, findings, and disposition. |
| `scorecard_approved` | User response, approved revision, and authorization timestamp. |
| `initialization_intent` | Approved hardened goal/scorecard/resource digests, clean branch identity, initialization lease, one-time execution key, expected v2 run ID/first sequence, and the complete expected artifact set. This is flushed before any baseline log, evaluator, guard, or acceptance-check process starts. |
| `baseline_intent` | Baseline command/parser/guard/check digests, attempt lease and execution key, expected log/result paths, expected known-good commit, and pre-command workspace/config digests. |
| `initialized` | Committed v2 `run.json` digest plus valid initial prefix digest: `baseline` at seq 0 and, when baseline meets target, required `complete` at seq 1; includes known-good commit/metric/checks and binding IDs. |
| `candidate_claim_intent` | Candidate/attempt/role/base commit/grant/lease before child creation. |
| `candidate_dispatched` | Resolved child session identity after dispatch. |
| `lease_renewed` | Candidate lease identity and new expiry. |
| `candidate_handoff_published` | Immutable handoff and workspace digest. |
| `finish_intent` | Candidate commit/evaluation operation authorized before its side effects. |
| `metric_recorded` | Attempt, commit, strict host parser output, finite metric, and typed per-run/held-out `AutoResearchMeasurementRef` with aggregation, variance, input/evaluator/parser/workspace digests, and verify log digest. |
| `guard_recorded` | Guard results and logs; pass/fail is determined by exit status. |
| `admission_lock_acquired` | Frontier digest and lock owner. |
| `stale_rebase_requested` / `remeasured` | Old/new frontier, rebase commit, fresh metric/guard evidence. |
| `candidate_red_teamed` | Exact candidate diff/result, anti-gaming findings, and red-team digest. |
| `frontier_update_intent` | Exact dedicated frontier ref/worktree identity, expected ref/commit/generation/digest, lock/coordinator epochs, one-time execution key, and candidate commit before Git compare-and-swap. |
| `candidate_admitted` | Resolved Git ref compare-and-swap, strict improvement, guard/acceptance pass, clean red team, and new frontier. |
| `candidate_discarded` | Exact reason, trial/revert commits, metric/guard/red-team refs, frontier unchanged. |
| `admission_lock_released` | Lock owner and resulting frontier digest. |
| `candidate_abandoned` / `candidate_reaped` | Worker or host reason, lease/liveness evidence, no-admission disposition. |
| `recovery_classified` | Evidence-backed disposition of every uncertain attempt. |
| `stop_requested` / `budget_limited` / `blocked` | Exact authority, budget, or blocker evidence. |
| `candidate_target_observed` | Pre-admission evaluator result meets target; diagnostic only, with no status, claim, admission, or frontier authority. |
| `target_reached` | An admitted frontier or approved baseline meets target; workflow enters target-pending and still requires independent verification. |
| `verification_gap_found` | Fresh verification or completion audit proves a substantive goal/scorecard gap after v2 target completion; pause the same bound goal and request exact replacement decisions. |
| `run_archive_intent` / `run_archived` | After fresh goal-contract/scorecard/resource approvals and full child reconciliation, bind the closed run ID/prefix digest to its archive destination before/after atomic archival; no goal ownership release. |
| `verified` / `completion_audited` | Fresh verifier and separate completion red-team evidence. |
| `refinement_recorded` | Audited evidence refs, scope, applied result, or empty edit set. |
| `completed` | Completion auditor authorization and final frontier/result digest. |

Scorecard proposal/recon/lens/verification/synthesis/red-team/approval events live
only in the kernel before initialization. After approval, the host appends and
flushes `initialization_intent` and then `baseline_intent` before creating any log,
running the evaluator, guard, or acceptance checks. Those intents carry the
initialization/baseline lease, execution key, expected artifact paths, and all
pre-command digests. Only after the commands and checks produce validated evidence
does the host atomically write compatible `run.json` and a validator-complete
initial `events.jsonl` prefix: `baseline` at sequence 0 and, only when that metric
meets target, v2 `complete` at sequence 1. It then appends `initialized` with both
digests and kernel `target_reached` when applicable. No reader can observe a
target-reaching active prefix that the v2 validator rejects. A crash at any
boundary enters reconciliation; the host either finishes the exact idempotent
projection from immutable evidence or quarantines it. A candidate cannot dispatch
before `initialized`; admission cannot precede a full candidate decision pipeline,
current-frontier check, and resolved Git-ref CAS; and `completed` cannot precede
verification, completion audit, and final refinement review.
V2 lines retain their existing strict validator; kernel corruption follows
the generic journal quarantine rules.

Initialization implements that multi-file publication by writing all v2 config,
logs, and the complete initial prefix into a same-filesystem sibling staging
directory, flushing and validating the staged tree, atomically renaming it to the
required absent results root, and flushing the parent directory. An existing root,
cross-filesystem publication, failed directory flush, or ambiguous rename is
quarantined; the host never approximates atomic initialization with separately
visible `run.json` and event writes.

## Lifecycle

Run status and phase are separate. Status describes whether the run may continue;
phase describes the coordinator's current work:

```text
awaiting_user(scorecard)
  -> baseline
  -> claiming -> executing -> evaluating -> admitting
  -> claiming                 when the frontier remains below target
  -> target_pending_verification (read-only projection of active/verifying)
  -> auditing_completion -> refining -> complete

executing/evaluating/admitting -> reconciling -> claiming
any active phase -> paused | budget_limited | stopped | blocked | failed
```

The normal sequence is:

1. `status` validates any existing run. A non-`not_initialized` state is surfaced
   and the user chooses resume, stop, or archive. A different goal cannot overwrite
   an unfinished or terminal run without explicit archive.
2. Recon gathers Git, evaluator, guard, scope, project commands, existing
   `goal.md`, decisions, and compute evidence. Independent lenses and red team
   produce a typed scorecard proposal.
3. The user approves the exact scorecard and resource decisions. The host validates
   the already-created awaiting-user workflow/goal binding, runs the evaluator,
   optional guard, and acceptance checks at the known-good commit, and
   writes immutable config and baseline evidence only after success.
4. The scheduler computes free capacity and claims all currently available slots.
   Each claim gets an exploit/explore role, grant, lease, candidate ID, isolated
   worktree, and immutable packet.
5. Workers inspect and change one hypothesis. A normal model response ending is not
   a terminal candidate result; only a structured handoff followed by `finish` is.
6. The host commits and measures the candidate, runs the optional guard and
   acceptance checks, and records all output.
   A failed guard or malformed measurement cannot be converted to a metric win.
7. A candidate with a possibly improving result enters the serialized admission
   transaction. The host refreshes the frontier, rebases/re-measures stale work,
   runs the exact anti-gaming red team, and admits only a strict improvement with
   current scope, evaluator, guard, and provenance.
8. The coordinator releases the slot and claims a replacement immediately. It does
   not wait for other candidates in the prior batch.
9. After every meaningful batch, failure, interruption, rejection, stale rebase,
   recovery, or refinement, a fresh planner/coordinator context either dispatches
   safe work, asks for authority, records an audited blocker, or advances to
   verification.
10. Only an admitted frontier, or the approved baseline, may atomically enter
    `target_pending_verification`. A raw candidate target emits only
    `candidate_target_observed`. For an admitted candidate, the host appends
    `target_reached` inside the same serialized admission critical section after
    `candidate_admitted` and before releasing its lock; it then fences new claims
    and admissions and reconciles already-running candidates without letting a
    late result move the frontier. A fresh verifier and separate completion red
    team inspect the original objective, scorecard, baseline, frontier history,
    candidate evidence, and anti-gaming risks. If either finds a substantive goal
    gap, the closed v2 experiment remains immutable: the typed verification-gap
    transition pauses the same bound goal; fresh goal-contract, scorecard, and
    resource decisions plus exact approvals, reconciled archival, a new opaque run
    ID, and a fresh results root/baseline are required before candidate work
    resumes. Only the completion auditor can authorize final refinement and native
    workflow/goal completion.

## Candidate Scheduling, Worktrees, and Roles

### Claim and packet

The scheduler uses a typed adapter over the host's native child primitive. The
adapter persists attempt/execution key, packet digest, selected model/token limits,
resource lease, child session identity, heartbeat/liveness evidence, and reattachment
metadata through the generic workflow admission record. The adapter accepts only
host-supported child parameters; the experiment packet is task data delivered
verbatim after admission, not invented child-creation flags.

The control-plane contract is:

```text
claim --count N
  -> N complete worker packets
spawn N workers concurrently
bind each child identity
worker returns / finish resolves a slot
claim --count 1 immediately
```

When concurrent spawning is unavailable, the host claims one slot at a time. The
state model, lease rules, admission lock, and results remain identical.

The deterministic packet includes:

- run, candidate, attempt, scorecard, scope, target, and current frontier digest;
- `autoresearch/goal.md` and `decisions.md` snapshots, each capped at 4 KiB;
- role and role rationale, including any forced-explore decision;
- exact evaluator, guard, finish, and report commands;
- candidate branch/worktree path and base commit;
- active resource-plan revision/digest, conservative grant, canonical resource and
  ownership lease refs/expiry, and allowed side-effect boundary;
- exact required skill snapshots, supporting-tree digests, host invocation tokens,
  and declared approval-gate outcomes; and
- a requirement to publish a structured handoff and call `finish` without committing
  or measuring on behalf of another candidate.

`claim` returns the packet; the coordinator passes it verbatim. It does not ask a
child to infer missing configuration or author a bespoke worker prompt.

### Roles and plateau policy

- **Exploit** deepens the mechanism that produced the current frontier or the most
  recent accepted improvement. It is the default when recent evidence supports it.
- **Explore** attempts a materially different mechanism, representation, algorithm,
  test strategy, or search direction. It is not a cosmetic rename of an exploit.
- An explicit role override records `roleReason` and is visible in history.
- `plateauK` counts consecutive completed exploit attempts that admit nothing. Once
  the count reaches `plateauK`, the next available slot is forced to `explore` and
  the reason is persisted. `window` is the rolling number of completed attempts used
  for role fairness; `minPerRole` is the minimum claim count per role before a user
  may call a plateau stop.

Plateau is a diagnostic and a forced-exploration transition, not success. The
coordinator continues while active after a plateau. The user may explicitly stop
with reason `plateau` once the status view shows the configured window and role
minimums; a model cannot self-stop merely because several hypotheses failed.

### Worktree isolation

Initialization requires `worktreeRoot` outside the repository and a clean named
branch with a working Git author/committer identity. Every candidate starts from the
current frontier in a dedicated worktree and branch such as
`autoresearch/<run-display-id>/c<zero-padded-candidate-id>`.

The run also owns a dedicated frontier ref and worktree outside the primary
checkout. User approval authorizes candidate commits and compare-and-swap updates to
that run-specific frontier ref only; it does not authorize changing the user's
branch/HEAD, merging to the base branch, pushing, or publishing. The approved base
commit and base-branch identity are pinned. A primary-checkout branch switch or
change during the run is detected as external state but is never overwritten or
misreported as frontier state.

The host resolves every allowed prefix relative to the candidate root through
canonical real paths and enforces it in the kernel effect/mutation broker. Checks
cover symlink swaps, renames, submodules, ignored/untracked/generated files,
lockfiles, evaluator/guard sources, shared caches/services, and late descendant
processes before commit and admission. An out-of-scope edit is an invariant failure,
freezes new dispatch, and enters reconciliation; it is never silently deleted.
Workers do not revert another candidate or the primary checkout.

The baseline and every retained frontier commit remain addressable. A discarded
candidate retains its trial commit and a visible revert/cleanup commit on its own
branch so investigators can inspect it; the frontier history contains only admitted
commits. No destructive reset is used for rollback.

## Evaluation and Frontier Admission

### Fixed evaluator

The evaluator is fixed by the approved scorecard. Its command, parser, source-path
digests, dependency-lock/input/fixture/held-out-data bundle digests, timeout,
sanitized environment allowlist, clean cache policy, working directory, network and
egress policy, and repeatability/aggregation/tolerance policy are content-addressed
in `FixedEvaluator` and the kernel scorecard. The candidate cannot pass a new command,
change `metricKey`, set a different direction, or reinterpret output.

If evaluator or guard source lies inside an otherwise editable scope, the host takes
an approved immutable bundle outside the candidate scope and executes that fixed
copy in a separate host-owned process environment. Protected inputs are mounted or
copied read-only and held-out targets remain inaccessible to the candidate when the
objective permits. The scorecard red team must explicitly approve this arrangement;
a candidate edit that changes evaluator/guard/dependency selection is still out of
scope. Evaluators and guards run with a clean inherited environment, attempt-unique
temporary cache/output directory, tracked/untracked pre/post snapshots, descendant
process tracking, network disabled unless separately authorized, and no write access
to candidate or frontier state. A byproduct or changed digest is an invariant error,
not cleanup work.

The final non-empty stdout line must be either:

```text
7
```

or, with an explicit parser key:

```json
{"error_count": 7, "passed": 12}
```

The line must decode as UTF-8 and the configured scalar or JSON metric key must
contain a finite number. Empty output, a missing configured key, a non-numeric or
non-finite configured value, duplicate JSON keys, a non-object JSON line, a
nonzero evaluator exit, timeout, or parser error fails the measurement. Unrelated
JSON keys remain permitted and ignored exactly as in v2; they never become extra
metrics or acceptance evidence. There is no fallback parsing, output scraping,
previous-value reuse, or synthetic result. Baseline and candidate measurements run
the approved number of repetitions; the declared exact/median/mean aggregation and
tolerance are host computed. Nondeterminism outside that policy blocks admission
and opens a scorecard or blocker finding rather than selecting the most favorable
trial.

`single_deterministic` is valid only with a fresh host attestation over the full
evaluator/dependency/input/environment/workspace closure and zero variance. Model
claims or one observed stable run cannot create it. Otherwise baseline and
candidate runs are each at least two, use the fixed aggregation and variance bound,
and use held-out inputs whenever the scorecard identifies leakage or overfit risk.
The host compares the full result distribution; it never admits a lucky best trial.

Acceptance checks and protected invariants use immutable
`HostCheckDescriptor` records, not free-form worker commands or descriptions.
The host snapshots their executable sources, test discovery, dependencies,
inputs, and fixtures outside candidate ownership, validates every approved
digest immediately before execution, and runs them under a separate host-issued
execution identity in the constrained verification environment. Each run emits
a fresh `HostCheckResult` bound to the descriptor and candidate workspace
digests. A missing, stale, candidate-modified, or wrong-digest descriptor/result
is a failed check even when the primary metric improves.

Check and guard results are discriminated evidence, not success-only records.
Nonzero exit, timeout, spawn failure, missing/stale evidence, digest drift, and
containment failure persist their exact failure kind, nullable exit code, logs,
diagnostic reference, execution identity, and workspace digest. `BaselineEvidence`
may contain only the extracted pass variants because it exists only after a valid
baseline; failed initialization remains in the preflight attempt evidence instead
of being discarded or coerced into a pass-shaped record. Candidate failures use
the same full unions before disposition.

### Guard

Guard commands are optional for v2 compatibility; every configured guard is
pass/fail and must pass at baseline. The kernel scorecard still requires binary
acceptance checks and protected invariants even when `run.json.guard` is null. A
guard protects behavior not represented by the primary metric, such as a regression
suite around a latency benchmark. A candidate with an improved numeric result and a
failed guard or acceptance check is discarded. Output and exit status are
preserved; a guard does not choose the primary metric.

The host applies the direction predicates exactly: for `lower`, an admission
requires `candidateMetric < frontierMetric` and the target is reached at
`candidateMetric <= target`; for `higher`, an admission requires
`candidateMetric > frontierMetric` and the target is reached at
`candidateMetric >= target`. A baseline that already satisfies the target does not
skip verification or completion audit; the run records the baseline as the known
starting evidence and still requires the independent completion gates.

### Admission transaction

The only admission path is `finish --candidate <id>`, executed by the host:

The candidate trial, fixed evaluator, guard, acceptance checks, recon, lenses,
verifier, synthesis, and anti-gaming red team run outside the admission lock
against an immutable candidate/frontier snapshot. The lock is a brief finite
fenced CAS lock with a host heartbeat, acquired only for final revalidation,
decision binding, frontier/projection CAS, and release. An expensive evaluator,
review, or rebase never holds the lock; a stale snapshot releases it and is
remeasured outside the lock.

1. Append and flush `finish_intent` before committing or running commands.
2. Validate candidate identity, branch, worktree, lease, packet revision, scope,
   and base commit.
3. Commit the one coherent trial change in the candidate worktree. Record the trial
   commit and workspace digest.
4. Run the fixed evaluator and parse its final line strictly. Record a content-
   addressed result and complete verify log. Run the configured guard, when present,
   plus every host-owned acceptance-check and protected-invariant descriptor, and
   record each fresh typed result/log.
5. If measurement or guard is invalid, classify the attempt with the exact error
   and leave the frontier unchanged. It cannot proceed as an improvement.
6. Publish the immutable candidate/frontier snapshot and complete all expensive
   evidence work outside the lock. Then acquire the brief finite fenced admission
   lock with a heartbeat and re-read the validated frontier. A lock is never
   inferred free merely because a process is slow; release it immediately after
   the re-read unless the final CAS phase has begun.
7. If the candidate's base or pre-lock frontier is stale, release the lock before
   rebasing. Rebase onto the current frontier, record `stale_rebase_requested`,
   rerun the fixed evaluator and guard/acceptance/invariant descriptors, and
   repeat the immutable snapshot/review sequence. A rebase conflict has no
   automatic model resolution and leaves the candidate non-admitted.
8. The recon, independent lenses, verifier, synthesis, and anti-gaming red team
   all inspect the immutable snapshot outside the lock. Record every artifact and
   decision/revision digest. After they finish, acquire or reacquire the brief
   fenced lock only to bind the decision and revalidate all digests against the
   current frontier.
9. The deterministic host gate admits only under that final fenced lock when the
   full decision pipeline is current, the guard/acceptance checks/invariants pass,
   the candidate is in scope, skill/evaluator/provenance is current, and its metric
   is a strict improvement over the current frontier in the approved direction.
   A tie is not admission.
10. For an improvement, while the finite fenced lock heartbeat is valid, append
    and flush `frontier_update_intent` with the active coordinator/lock epochs,
    one-time execution key, expected frontier ref/commit,
    and candidate commit. Atomically update the dedicated frontier ref by Git
    compare-and-swap. Then append and flush `candidate_admitted` with the resolved
    ref, metric, result, and workspace digests. A crash between intent, ref CAS, and
    resolution quarantines the lock and reconciles the exact ref; it never retries a
    blind merge. Still under that lock, publish one bound v2 projection transaction
    containing its compatible candidate resolution and, when the admitted frontier
    meets target, the required following v2 `complete` event. After
    `projection_committed`, append and flush kernel `target_reached` and reduce to
    target-pending before lock release. A pre-admission target value may emit
    `candidate_target_observed` but cannot fence claims or change status. For rejection, append the discard decision
    with no ref mutation.
11. Release the fenced lock/lease exactly once, resolve the candidate, and claim a
    replacement immediately unless the run entered target-pending, budget, stop,
    recovery, or another terminal state.

Two candidates that improve against the same old frontier are still serialized. The
first admitted candidate moves the frontier; the second is stale, is rebased and
re-measured, and can be admitted only if it improves over the moved frontier. A
candidate that returns after `reap` or `abandon` is refused even if its metric is
better. No worker self-report can satisfy a dependency or advance the frontier.

### Anti-gaming red team

Every candidate reaching the admission transaction is checked for:

- changing, shadowing, or bypassing the evaluator, parser, guard, target, direction,
  fixtures, benchmark inputs, or result path;
- lowering thresholds, skipping tests, changing test discovery, suppressing errors,
  deleting failures, or weakening protected behavior;
- hardcoding the metric, emitting a fabricated final line, altering environment
  selection, or relying on nondeterministic timing to win one trial;
- narrowing scope or objective, removing a requirement, changing a proxy instead of
  the requested outcome, or presenting unrelated churn as progress;
- dependency, license, network, data-egress, credential, or external-side-effect
  changes outside the approved authority; and
- evidence from an obsolete workspace, stale evaluator digest, missing command log,
  unreviewed generated file, or a worker-authored check with no independent result.

An unmitigated finding produces `candidate_discarded` with disposition
`red_team_rejected`; it never becomes a frontier commit. A finding that changes the
meaning of the scorecard produces an approval-required revision instead of a
discard that silently narrows the goal. The red team is adversarial evidence, not a
majority vote; the host gate applies the typed predicates.

## Budgets, Stop Conditions, and Completion

The existing goal aggregates time, tokens, and continuations across root, planner,
worker, auditor, verifier, and refinement contexts. AutoResearch adds explicit
run/candidate budgets:

- `maxCandidates` stops new claims at the approved kernel limit and leaves active
  attempts to finish or reconcile. Native state becomes `budget_limited`; the valid
  v2 prefix remains a non-authorizing compatibility view and is not given a false
  immutable limit or terminal reason.
- `maxRunWallSeconds`, `maxRunTokens`, local grant exhaustion, or
  an authorized cloud envelope limit prevent new substantive work and produce
  `budget_limited`. The host does not force a worker to keep spending.
- `maxPlannerCycles`, `maxDistinctStrategiesPerRequirement`, and
  `maxAnalysisAttemptsPerRequirement` bound distinct-looking recon, exploration,
  and hypothesis churn. Exhaustion is `budget_limited`; only an approved envelope
  revision can renew it.
- A lease expiry is not a budget stop; it is a liveness fact requiring reconcile,
  deterministic reclaim after strong nonexecution proof, or finite terminal
  escalation when proof is unavailable.
- Every candidate decision, unchanged strategy, stale-rebase, reconciliation, and
  infrastructure retry class inherits finite kernel revision/attempt limits. Cycle
  identity binds objective, scorecard, frontier, role strategy, workspace, and
  evidence digests. Repeating the same identity cannot reset counters; exhaustion
  requests a material user choice or enters the independently audited blocker path.
- User pause/stop is durable and leaves workspace changes, candidate branches,
  results, and logs intact. Resume uses a fresh coordinator context; stop is
  explicitly resumable after validation. Cancel is terminal until archive.
- A blocker is terminal only after evidence, exhausted safe alternatives, and the
  same external dependency has prevented progress across three consecutive goal
  turns. A failed hypothesis, noisy candidate, or discard streak is not a blocker.
- The target is complete only when an admitted frontier metric satisfies the strict
  direction/target predicate, independent verification passes, completion red team
  finds no proxy or scope violation, and final refinement review has run. A target
  signal alone is never completion.
- Invalid or unreadable immutable state, invariant violations that cannot be
  reconciled, rollback failure, or repeated infrastructure failure that prevents any
  phase from running produces `failed` with the exact diagnostic and log path.

The completion report includes baseline, final frontier, target/direction, candidate
count, admitted/discarded/reaped counts, role counts, budget usage, retained commits,
verification evidence, completion-audit findings, and refinement outcome. It does
not claim success from the candidate limit, a plateau, a nearly exhausted budget, or
an appealing worker final message.

## Recovery, Leases, and No Blind Replay

### Dispatch protocol

Every dispatch and closeout follows write-before-side-effect ordering:

1. append and flush intent with workflow/run/candidate/attempt identifiers,
   coordinator and lease epochs, host attempt token, nonce, stable one-time
   execution/idempotency key, resource reservation, and expected effect digest;
2. create or message the child session/worktree through the typed adapter that binds
   the same execution key;
3. append and flush the resolved child identity, packet digest, and
   worktree/branch identity;
4. observe the child through existing daemon registries, heartbeats, transcripts,
   and immutable handoffs; and
5. append the structured terminal outcome only after host-observed evidence exists.

The same ordering and kernel effect broker apply to cloud reservation, evaluator
launch, commit/rebase, frontier-ref CAS, admission-lock acquisition, refinement
application, and user-authorized external actions. A stale coordinator epoch cannot
append, launch, admit, release, or commit a host-controlled effect. Descendant
process groups are terminated/reaped on fencing where enforceable; an effect with no
provider/filesystem idempotency or observable outcome becomes user-resolved when
ambiguous.

### Lease behavior

Each claimed candidate has an attempt-unique lease. A worker can renew only its own
lease through the host. `status` displays age, expiry, heartbeat, and lapsed state.
`reconcile` reports lapsed candidates, broken slots, live child identities, worktree
state, and admission-lock ownership. It may clear an admission lock only when the
holder is provably gone. After expiry, the host attempts deterministic reclaim only
with strong nonexecution proof: the fenced process group and descendants are absent,
provider idempotency/usage/billing records are settled, and the lease epoch is
fenced. `reap` remains an explicit inspection/confirmation command but is not the
only recovery path. If proof is unavailable, a finite reclaim deadline records
terminal `failed`, `blocked`, or `awaiting_user` escalation; the host never waits
for an indefinite user reap. A slow worker and a dead worker look the same until
reconciliation establishes a safe disposition. `abandon` is for a worker that
reports it has no continuation, not for the coordinator to free a slot conveniently.

### Root/daemon/worker recovery

After root or daemon restoration, the reducer validates the complete event history
and enters `reconciling` when a candidate has an intent but no terminal event. It:

1. compares candidate events with live child registrations, transcripts, leases,
   worktrees, branch heads, evaluator logs, and published artifacts;
2. reattaches a child that is demonstrably live and still owns the matching lease;
3. records missing/dead children as interrupted without assuming their commands did
   or did not have side effects;
4. captures current workspace/branch/evaluator/guard state; and
5. starts a fresh reconciliation context that classifies each uncertain attempt as
   still running, completed with exact evidence, safe to retry, requiring corrective
   work, requiring user input, or failed.

The coordinator never blindly replays an uncertain commit, evaluator, cloud launch,
or external action. If an action may have been non-idempotent and its outcome is not
observable, the run pauses for user direction. A retry requires a new attempt ID,
fresh lease, current frontier, and an explicit reconciliation result. An artifact
without a journal reference, an intent without child identity, or a child identity
without terminal outcome remains uncertain and cannot be imported as evidence.

### State corruption

The run stops immediately on malformed JSON, duplicate keys, unknown schema fields,
event gaps, invalid transitions, nonnumeric metrics, non-UTF-8 output, command
timeout, unexpected Git state, evaluator/guard mutation, out-of-scope edits, digest
mismatch, or rollback failure. The error includes the exact file, event sequence,
candidate/attempt, and command log. The host never reconstructs state from old layout,
report HTML, a partial transcript, a previous metric, or conversational memory.

## Refinement and Memory Outputs

AutoResearch reuses the existing continual-harness refinement subsystem and its
local-by-default policy. Refinement is eligible only after a progress auditor or
completion auditor has accepted the evidence that motivates it:

- after a verified frontier milestone;
- after at least two compatible independently audited discard/failure observations
  expose one reusable cause/remedy;
- after completion audit, before final goal completion; and
- after an explicit user refinement request with exact intended scope.

The reviewer receives the scorecard, admitted and rejected results, role history,
red-team findings, stale-rebase outcomes, recovery classifications, verifier
evidence, and prior refinement history. It emits the shared
`KnowledgeMutationProposal`; AutoResearch defines no alternative edit, scope, or
authority schema. The proposal explicitly selects `session|workspace|user`,
workspace identity when applicable, privacy, retention, typed evidence, expected
versions/digests, and optional decision reference. Missing fields cause rejection,
not host invention.

This output is non-authorizing. The local knowledge layer runs the full universal
recon/lens/verification/synthesis/red-team/authority/CAS transaction. Any `skill`
or methodology edit remains a harness refinement outside the knowledge action
union and additionally requires writing-skills
RED/GREEN/REFACTOR pressure evidence, reload verification, and rollback metadata.

Valid outputs include an empty edit set. Memory entries capture durable how/why,
such as a repeatable evaluator pitfall or a verified exploit/explore tactic. Skills
capture repeatable procedures with their callable contract. Subagent entries capture
roles that repeatedly improve admission. Prompt entries capture narrow behavioral
policies. None may contain a candidate's transient worktree path, lease, run history,
personal decision, temporary blocker, unsupported hypothesis, secret, credential, or
unverified metric claim.

The run's `goal.md` and `decisions.md` remain run coordination documents, capped at
4 KiB and changed only through `decide --add`; their snapshots are immutable result
artifacts. Refinement state is session-local by default. Global edits require explicit
user request or a previously authorized durable-learning policy and the existing
global-scope conflict/rollback checks. A refinement failure or skipped review is
recorded and disclosed; it does not erase valid experiment evidence or prevent the
planner from continuing unless the final completion gate requires the review and
state is unreadable.

## Failure Modes and Host Responses

| Failure | Host response | Recovery guarantee |
| --- | --- | --- |
| Existing v2 run is active, stopped, blocked, error, or complete | Surface validated status; require resume/stop/archive or native-binding choice; never initialize over it. | Prior run and artifacts remain inspectable. |
| Dirty branch, detached HEAD, missing author, invalid repository, or bad worktree root | Refuse initialization with exact Git/path diagnostic. | No run or candidate side effect. |
| Missing goal/decisions/compute bank or invalid parallelism | Request the missing user-owned input; do not infer or write a default. | Scorecard remains uninitialized. |
| Scorecard missing numeric target, direction, fixed evaluator, repeatability, required `heldOutInputDigest`, acceptance checks, protected invariants, or host-owned improvement predicates | Reject proposal before initialization; a v2 guard may be null. | No untyped run can dispatch and no proposer-selected holdout can enter evaluation. |
| User rejects scorecard or amendment | Remain `awaiting_user`/`paused` with exact proposal. | No candidate or scope side effect. |
| Baseline evaluator/parser/guard fails | Write an initialization diagnostic only; do not create an active run. | A known-good baseline is mandatory. |
| Candidate edits outside scope or protected evaluator/guard files | Freeze dispatch and enter reconciliation; preserve the worktree and evidence. | No contaminated candidate can be admitted. |
| Evaluator emits malformed/nonfinite output, exits nonzero, times out, or mutates files | Record exact log and stop the run; never reuse prior metric. | Metric comparison remains auditable. |
| Guard fails with a metric improvement | Discard candidate with guard evidence; frontier unchanged. | Proxy improvement cannot regress protected behavior. |
| Rebase conflict or changed frontier | Preserve trial; rebase/re-measure only with a new attempt result; conflict remains non-admitted. | Admission compares against the actual frontier. |
| Anti-gaming finding | Record red-team evidence and discard, or require a scorecard amendment if objective meaning changed. | No silent metric gaming. |
| Worker dies, lease lapses, or child identity is ambiguous | Reconcile; reattach only if live; reclaim only after strong nonexecution proof or record finite terminal escalation; stale return refused. | No blind replay or late admission. |
| Admission lock appears abandoned | Reconcile liveness; clear only when holder is provably gone. | Two admissions cannot race on an inferred lock. |
| Evaluator, guard, recon, lens, verifier, synthesis, or anti-gaming review holds the admission lock or uses a mutable snapshot | Fence/release the lock, run expensive work against an immutable snapshot outside it, and reacquire only a finite heartbeat-bounded lock for final revalidation/CAS | Lock interval/heartbeat, snapshot digest, and final CAS evidence |
| Root/daemon restart with uncertain side effect | Enter recovery and classify from evidence; pause for user input for non-idempotent ambiguity. | Restart cannot duplicate a commit, charge, or external action. |
| Journal/result digest, schema, sequence, or transition is invalid | Stop `failed` with exact path/sequence/log; do not reconstruct. | Corruption is visible rather than normalized. |
| Local resource overage or bank exhaustion | Stop new claims, record usage, and reconcile active attempts. | Grants remain truthful and bounded by scheduler accounting. |
| Cloud provider unavailable, usage unknown, envelope expired, or termination ambiguous | Pause/blocked with provider evidence; no silent fallback or duplicate launch. | User-authorized spend remains fail-closed. |
| Candidate limit, hard budget, user stop, or plateau stop | Stop dispatch, preserve all worktrees/results, and report exact reason. | Stop is not reported as completion. |
| Refinement model fails or proposes unsupported edits | Record failed/rejected/empty refinement; continue with audited run state. | Learning cannot mutate source or erase evidence. |
| Adaptive observation is stale or disagrees with frontier, scorecard, resource-plan, evaluator, guard, workspace, or lease digests | Reject the observation and retain the last committed allocation; reconcile before refill. | No candidate moves or frontier change from stale state. |
| Adaptive shift would exhaust control reserve or exceed local/cloud/spend/authority ceilings | Reject or pause before dispatch and request the exact user-approved resource decision. | Verifier, red-team, recovery, and host capacity remain available. |
| Role/slot allocation thrashes or a bottleneck is uncertain | Apply hysteresis/minimum-window rules or spend a bounded read-only verification lease; never add proxy work. | Allocation revision and no-op/rejection evidence remain durable. |
| Adaptive controller crashes around lease release, provider usage, or allocation CAS | Restore the last committed allocation or quarantine and reconcile the uncertain lease/effect; rollback only by exact CAS. | No blind replay, duplicate charge, or late worker admission. |
| `cron` schedule/clock/trigger set is missing, untrusted, overlapping, or changed without approval | Reject the trigger or schedule revision and retain the approved resource plan | Trusted-clock, schedule-digest, window-CAS, and approval evidence |
| `cron` reviewer is late, unavailable, malformed, stale, or requests a write/lease/allocation/frontier effect | Record a bounded nonblocking failure or reject the suggestion before host effects; preserve fixed metric/guard and allocation | Fresh independent identity, read-only capability proof, failure/suggestion digest, and unchanged frontier |
| Restart has several missed `cron` windows or a catch-up already ran | Admit exactly one validated catch-up and discard the rest without backlog replay | Restart epoch, catch-up marker, window state, and bounded review count |
| Critical-path candidate certificate or task-value certificate is missing, stale, non-reproducible, duplicate, or lacks a bounded outcome/quota | Reject the candidate allocation or exploration task; preserve the fixed scorecard/frontier and leave the slot for certified work | Accepted DAG/estimate/policy refs, lexicographic proof, novelty digest, and rejection artifact |
| Candidate task/attempt/lease bindings do not match, or an active candidate is proposed for in-place movement | Fence and reconcile the active attempt, then create a fresh candidate attempt and leases; only unclaimed slots may shift | Binding/fence/reconcile evidence and new attempt/lease IDs |
| Capacity, usage, billing, or rate-limit snapshot refs are unauthenticated, non-monotonic, expired, or unknown | Treat capacity/headroom as zero at CAS, quarantine charges, and stop affected dispatch | Authenticated snapshot refs, sequence/TTL checks, and provider reconciliation |
| A candidate or evaluator would borrow the hard process/session/model-call/token/recovery control partition or overlap `exclusive_unisolated` work | Reject or serialize it away from the control plane; preserve admission, verifier, red-team, recovery, and lock reserve | Partition accounting, isolation class, and host decision |
| Crash occurs after allocation/effect intent but before applied marker | Require effect-broker proof of nonexecution or fenced idempotent reconciliation for grant, lease, evaluator, frontier, and provider charge; no blind retry | Intent/applied marker, idempotency key, broker result, and reconciliation evidence |
| Fairness aging, last-served role/task, exploration quota, benefit threshold, minimum dwell, or transition cap cannot be proven | Keep the last allocation; only a recorded safety stop may override and it cannot expand the fixed metric/guard envelope | Persisted fairness/hysteresis state and bounded decision artifact |
| Candidate lease expires without strong nonexecution proof by the finite reclaim deadline | Do not reclaim optimistically; record terminal escalation and quarantine candidate/effects rather than requiring indefinite `reap` | Process/provider proof, deadline, reclaim decision, and terminal event |
| More than one adaptive review is pending/active or a newer observation supersedes one | Coalesce to latest, cancel unstarted work, fence active review at safe boundary, and prevent superseded output from applying | Queue state, cancellation/supersession digest, and unchanged frontier |
| Improvement candidate fails baseline, held-out/replay/canary, or Goodhart/regression/safety review | Reject or roll back atomically and exclude the revision from future runs. | Fixed scorecard/frontier and last approved revision remain intact. |
| A control-capacity vector is missing, negative, non-finite, over-reserved, or not component-wise reconciled | Reject grant/lease/admission CAS; preserve hard control dimensions and serialize `exclusive_unisolated` candidates away from them | Vector, partition, grant/lease sums, and rejection digest |
| A host improvement scorecard lacks a required sample, hidden holdout/digest, effect/tolerance, non-regression, or cost/latency predicate | Reject the revision; retain the fixed metric/guard and prevent proposer-selected holdouts | Frozen manifest/scorecard, host-selection proof, and comparison evidence |
| The revision registry is stale, revoked, superseded, incompatible, or missing pinned bytes | Reject phase/effect admission, fence affected attempts/leases/approvals/caches, and retain audit bytes | Registry epoch/event CAS, closure proof, fence set, and pinned refs |
| The `cron` snapshot cannot dereference or verify its objective/contract/scorecard/plan/critical-path/config/evaluator/guard/registry refs | Reject review and preserve the last safe candidate allocation; mutable run files cannot substitute proof | Host dereference proof, per-ref digests, stale rejection, and unchanged frontier |
| Schedule, cadence, duty-cycle, reserve, or review-count limits are zero, negative, non-finite, or over budget | Reject schedule/budget CAS; do not retry implicitly or start a resident review loop | Bound validation, reserve partition, budget digest, and approval ref |

## Licensing, Data, and External-Side-Effect Boundary

The native implementation belongs to this repository and follows its MIT license.
The behavioral source explicitly supplied for this design is the local
AutoResearch snapshot at commit
`95e2fa1189f08ce694eb1a2b3e85d4bf58d3cfbf`; its checked-in LICENSE grants MIT
terms and names Copyright (c) 2026 LLLLLe. The native implementation independently
implements its typed behavior without a runtime dependency on the external skill.
If code or substantial text is copied, the exact external copyright notice, MIT
license, source commit, and imported paths must appear in package-local and
repository third-party notices; a semantic reimplementation must not imply that
external authors endorse the native product.

The separate upstream research repository inspected while designing the experiment
loop did not contain a verifiable license file at its pinned revision. It is an
idea-level research reference only: no code or substantial text from it may be
copied, vendored, or distributed without a verified grant.

Candidate source, tests, evaluator data, provider SDKs, and cloud APIs retain their
own licenses and terms. The subsystem does not relicence user repositories or bundle
provider code. Before admission, the host compares dependency manifests/locks,
license/SPDX evidence, notices, network/egress requests, and credential-sensitive
environment changes against the approved scorecard. New or incompatible terms and
new egress require an exact user-authorized decision; missing license evidence blocks
admission rather than relying on a model checklist. Evaluator output, diffs, logs,
and reports may contain proprietary source or data and remain local unless the user
explicitly authorizes transmission.
Cloud credentials are references owned by the host credential boundary, never run
artifacts or memory. Cloud provider terms, account ownership, billing, data egress,
and retention are shown in the approval envelope and are not silently accepted by a
worker.

Worker/evaluator environments are sanitized and outputs pass versioned secret and
private-data redaction before durable publication or model review. Raw local logs
use private permissions and never enter refinement/memory; a detected credential or
restricted-data leak quarantines the candidate and every derived artifact. The
design claims bounded scanner coverage, not universal detection of all paraphrases.

No network, cloud, message-posting, merge, deployment, or publishing action is
performed merely because a candidate improves a metric. An evaluator requiring
network access must declare it in the approved scorecard and pass through the same
user-authorized envelope. An uncertain external side effect pauses recovery rather
than replaying it.

## Integration Boundaries

Implementation should add focused modules rather than absorb the subsystem into
`AgentSession` or duplicate the kernel. `core/autoresearch/` is a thin
specialization/compatibility adapter: it imports the kernel's decision, approval,
journal, resource, lease, artifact, effect-broker, and recovery interfaces and owns
only experiment-specific scorecard, v2 projection, candidate, evaluator, role, and
frontier logic.

- `packages/coding-agent/src/core/autoresearch/types.ts` for AutoResearch-only
  scorecard extensions, v2 binding, candidate/frontier state, and payloads; generic
  resource/decision/journal types are imported;
- `scorecard.ts` for proposal validation, strict parser/evaluator descriptors,
  approval revisions, baseline checks, and scorecard red-team inputs;
- `projection.ts` for strict v2 read/write compatibility plus kernel
  intent/commit binding, legacy attachment, prefix digest validation, and recovery;
- `compute.ts` for read-only detection, explicit compatible bank persistence, and
  translation into kernel multidimensional grant/resource-envelope accounting;
- `scheduler.ts` for exploit/explore roles, immediate refill, worktree allocation,
  candidate packets, leases, and ownership checks;
- `admission.ts` for finish, strict evaluation/guard execution, serialized locks,
  stale rebase/re-measure, anti-gaming red team, and frontier updates;
- `recovery.ts` for AutoResearch-specific worktree/frontier/v2 reconciliation over
  the generic reattach, fencing, idempotency, and no-blind-replay APIs;
- `refinement.ts` for audited AutoResearch evidence projection into existing local or
  authorized global refinement;
- existing `goals.ts`, `autonomous.ts`, `AgentSession`, `rlm-runtime.ts`, resource
  loading, and agent-connection snapshots only at the required integration seams;
- existing slash-command/CLI registries and interactive components for command
  parsing, status projection, approval, and history/report views; and
- `packages/coding-agent/test/` integration suites using real temporary Git
  repositories, processes, worktrees, daemon restoration, and durable files.

The normal CLI-to-session prompt path and existing daemon child lifecycle are reused;
the first release adds no daemon command, event, response shape, or startup
requirement. If implementation discovers a required daemon wire change, work stops
at this boundary and the change is redesigned as capability-gated or incompatible,
with protocol/schema revisions and old-client/new-daemon plus new-client/old-daemon
tests as required by the durable kernel contract.

## Real Integration Acceptance Tests

Acceptance evidence must exercise the real host, filesystem, Git, evaluator/guard
processes, worktree operations, daemon child lifecycle, journal files, and recovery
paths. A faux model provider may make planner responses deterministic, but mock-only
schedulers, fake metrics, fake Git, or in-memory journals are not acceptance
evidence. Each test records command output, process IDs, wall-clock timestamps,
commit/worktree identities, event digests, and result paths.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| AR-01 | Start with no numeric target, nonfinite target, missing evaluator, or invalid parser. | Initialization refuses before a run file or worker exists; exact validation error is visible. |
| AR-02 | Confirm a valid scorecard and resource envelope in a real temporary Git repository. | One card yields two independent approval records, preserves the bound goal, and creates immutable compatible `run.json`, baseline commit, finite metric, passing acceptance checks/optional guard, and bound journal prefix. |
| AR-03 | Baseline evaluator, guard, acceptance check, or protected invariant fails or lacks fresh evidence. | No active run is created; full host-executed command output, descriptor/result digests, and diagnostic path are preserved. |
| AR-04 | Material scorecard/scope change is proposed. | Independent red-team finding persists, status becomes `awaiting_user`, and no candidate dispatch occurs until explicit approval and new baseline. |
| AR-05 | Candidate tries to change evaluator, guard, parser, target, acceptance/invariant source, test discovery, dependency, input, protected fixture, or an out-of-scope path. | Real worktree and immutable host-bundle checks reject the candidate; missing/stale/wrong-digest evidence cannot pass, and the frontier and approved descriptor digests remain unchanged. |
| AR-06 | Two real candidate workers run in separate worktrees concurrently. | Distinct branches/paths and overlapping wall-clock intervals are recorded; neither sees the other's unadmitted edits. |
| AR-07 | Exploit/explore role scheduling reaches the plateau threshold. | Role packets include reasons; `plateauK` non-admitting exploits force an explore; `window` and `minPerRole` appear in status; plateau does not claim completion. |
| AR-08 | One worker finishes while another remains active. | A new `claim`/dispatch event occurs immediately for the free slot without waiting for the other worker. |
| AR-09 | Candidate improves the metric but fails the guard. | Real guard exit failure discards the candidate, preserves trial/revert logs, and leaves the frontier at the known prior commit. |
| AR-10 | Two candidates both improve from the same frontier. | Admission lock serializes them; the loser is rebased onto the admitted commit, re-measured, and admitted only if still strictly better. |
| AR-11 | Candidate metric is improved by hardcoding output, skipping tests, lowering thresholds, or narrowing scope. | Fresh anti-gaming red team rejects the exact candidate with immutable findings; no proxy-only admission occurs. |
| AR-12 | Admitted frontier reaches the numeric target. | The bound candidate-resolution projection immediately appends the validator-required v2 `complete`, then the specialization-only `target_pending_verification` projection maps to generic `active`/`verifying`; it cannot schedule or complete. Independent verification, a separate completion red team, and final refinement all finish before native workflow/goal `completed`, with no second v2 `complete`. |
| AR-13 | Candidate lease lapses while the worker is alive, then the worker returns late. | `status`/`reconcile` show lapsed state; strong nonexecution proof permits deterministic reclaim, otherwise finite terminal escalation is recorded; late `finish` is refused and cannot alter the frontier. |
| AR-14 | Worker process dies after dispatch and before terminal event. | Root recovery finds the uncertain attempt, does not replay it, and records reconcile classification; a safe retry gets a new attempt ID. |
| AR-15 | Root/daemon restarts while a worker remains live. | Worker is reattached from real registry/transcript evidence with the same candidate/lease; no duplicate child or claim is created. |
| AR-16 | Admission lock holder dies. | Reconcile clears the lock only with process/liveness evidence; a second candidate can then acquire it exactly once. |
| AR-17 | Journal line is truncated, malformed, duplicated, has an unknown schema field, or has an event gap. | Replay ignores only a provably truncated final line; any complete invalid state fails with exact sequence/path and does not invent recovery. |
| AR-18 | Evaluator writes a tracked/untracked byproduct or emits malformed/non-UTF-8 output. | Real command output causes a run error; no prior metric or synthetic result is reused. |
| AR-19 | Local compute bank has fungible cores and a whole node. | `compute detect`, explicit `compute.json`, grant vectors, and capacity formula produce the declared number of simultaneous candidates; overage is recorded. |
| AR-20 | Cloud envelope is absent, unauthorized, expired, or over its budget. | Cloud dispatch is refused or paused fail-closed; no credential is present in packets/logs/results and no local fallback silently occurs. |
| AR-21 | User pause, resume, stop, native candidate-dispatch ceiling, and hard budget. | Dispatch halts at the safe boundary and state survives process exit; user stop has an exact compatible v2 stop/resume projection, while native renewable ceilings remain kernel `budget_limited` against a valid v2 prefix with `max_candidates: null`; none is shown as completion. |
| AR-22 | A genuine external blocker persists across three goal turns. | Blocker evidence, exhausted alternatives, and `blocked` state are journaled; a failed hypothesis alone does not block. |
| AR-23 | History and report views are generated after multiple keep/discard/rebase/reap events. | TSV/report output is derived from validated events and cannot change runtime state; retained commits and metrics match the journal. |
| AR-24 | Verified milestone and repeated audited failure trigger refinement. | Local refinement receives evidence refs, accepts an empty edit set, and never writes candidate history/transient blockers; global edit requires user authorization. |
| AR-25 | Existing ordinary goal, autonomous, skill, subagent, and daemon recovery tests run with AutoResearch unused. | Existing behavior remains unchanged; no new startup wire requirement or accidental run initialization occurs. |
| AR-26 | An uncertain non-idempotent evaluator/cloud/external action occurs. | Reconciliation pauses for user direction rather than replaying or duplicating the action; the unresolved artifact is not imported as evidence. |
| AR-27 | Material from the licensed local behavioral source is copied rather than independently implemented, or an unlicensed research reference appears in the tree. | Package-local/repository notices include exact license, copyright, commit, and imported paths for permitted material; provenance scanning rejects unlicensed source/text reuse and candidate/user/provider licensing boundaries remain unchanged. |
| AR-28 | Attach validated active, stopped, blocked, error, and complete v2 fixtures with opaque string run IDs. | Existing files remain byte-compatible and unrenumbered; native bindings map status/goal correctly, and legacy complete remains awaiting-user/read-only until approved hardening/rebaseline can enter target verification. |
| AR-29 | Kill between every kernel projection intent, v2 `run.json`/event append, and kernel commit marker. | Reconciliation binds exactly one v2 prefix or quarantines it; no native progress is invented and no duplicate v2 event appears. |
| AR-30 | Replace the coordinator during dispatch, evaluator launch, admission lock, frontier CAS, and release. | Stale epochs/execution keys cannot append, launch, admit, mutate the frontier ref, or release; ambiguous effects remain quarantined. |
| AR-31 | Candidate admission has missing/stale recon, lens, verifier, synthesis, red-team, skill, or decision artifacts. | The universal host gate rejects admission without frontier mutation. |
| AR-32 | Memory, GPU, provider-rate, token, or control-plane reserve is the limiting pool while CPU remains free. | Kernel multidimensional accounting refuses the extra candidate and still admits planner/recovery work. |
| AR-33 | Worker changes an evaluator dependency/cache/input, tampers with held-out data, varies clock/network/environment, or produces noisy runs. | Immutable bundles, clean environment, repeatability policy, and pre/post snapshots reject or deterministically aggregate the measurement. |
| AR-34 | Primary checkout changes branch/files while a candidate reaches frontier admission; crash before/after Git ref CAS. | Dedicated frontier worktree/ref preserves user state; expected-ref CAS and kernel resolution report exactly one frontier. |
| AR-35 | A candidate is admitted at target while another candidate returns late; a separate raw candidate also measures at target but is rejected before admission. | Only the admitted frontier atomically publishes its compatible resolution plus v2 `complete` and kernel `target_reached`; the raw observation changes no status or v2 prefix, and late work cannot move the target frontier before native completion decision. |
| AR-36 | Repeat an unchanged objective/scorecard/frontier/strategy/workspace/evidence cycle through the revision cap. | Counters do not reset; the run asks for material user direction or enters audited blocker review without artificial work. |
| AR-37 | Change required skill/supporting bytes or bypass an approval token in a candidate packet. | Invocation provenance is invalidated and the attempt cannot execute or admit. |
| AR-38 | Add a dependency with disallowed/unknown terms and make an evaluator print a secret canary. | License/notice policy and bounded redaction quarantine the candidate; protected output remains local and never reaches refinement. |
| AR-39 | An ordinary message or `/autoresearch resume` arrives while an approval is pending. | Pending tokens remain unconsumed; only the exact typed UI response or `/autoresearch respond <decision-id> <option-id>` advances either decision. |
| AR-40 | The approved baseline already reaches the target. | Initialization atomically writes a validator-compatible zero-based prefix containing `baseline` at seq 0 and v2 `complete` at seq 1, records kernel `target_reached`, admits no candidate, and leaves the native workflow/goal in target-pending until verification, completion red team, and refinement finish. |
| AR-41 | Native verification of a target-reaching v2 experiment finds a substantive goal gap. | The v2 prefix remains byte-identical and terminal; no candidate can append after `complete`, and only fresh hardened/red-teamed goal-contract, scorecard, and resource decisions, their exact approvals, reconciled archival, and a fresh run/baseline can resume research on the same paused goal. |
| AR-42 | A baseline or candidate host check exits nonzero, times out, cannot spawn, is stale, or violates containment. | The corresponding discriminated failure result and diagnostics persist; no pass-shaped result, active initialization, candidate admission, or target signal is synthesized. |
| AR-43 | A scorecard requests one-run measurement without a host determinism attestation, or repeated/held-out runs exceed approved variance or omit the held-out input digest. | Validation rejects the single-run policy before initialization, requires `heldOutInputDigest` for `held_out`, and aggregation rejects the noisy or lucky candidate without frontier movement; typed per-run and held-out measurement refs retain exact results, aggregation, sample count, input/evaluator/parser/workspace digests, and variance. |
| AR-44 | The user omits run, planner, per-requirement strategy/analysis, or candidate ceilings, then an approved ceiling is exhausted. | The host proposes conservative finite values for exact user approval; omission never becomes infinity, and exhaustion durably enters `budget_limited` before another model call, process, or candidate dispatch. |
| AR-45 | A worker or evaluator underreports, omits, or cannot isolate a resource dimension. | Host-derived conservative accounting reserves the component-wise maximum; unknown or unenforceable use receives `exclusive_unisolated` admission and serializes against conflicting work rather than creating fictitious capacity. |
| AR-46 | Parallel native candidates resolve in a different order from their claim IDs, including an unrepresentable outcome between two representable outcomes. | Under the projection lock, each representable resolution receives the next consecutive positive `V2CandidateNumber`; its paired start/resolution lines share that number, the unrepresentable outcome creates no gap, immutable bindings preserve native identity, and the full v2 prefix validates after every transaction. |
| AR-47 | A reader polls during initialization and during every line boundary of a paired candidate resolution plus target completion, while crashes are injected before and after file/directory flush and rename. | The reader observes either no initialized run or a fully validator-compatible tree/prefix; initialization uses one staged-directory publication, later projections use one complete-suffix atomic file replacement, and ambiguous durability enters reconciliation without a separately visible partial event group. |
| AR-48 | A user approves a larger finite kernel budget, then proposes a different profile, parallelism, timeout, worktree root, lease policy, or prepare command. | The ceiling-only renewal advances the active resource-plan revision by current-epoch compare-and-swap without changing v2 bytes; every v2-visible change is rejected in place and requires reconciled archive plus a separately approved fresh run/baseline. |
| AR-49 | Target-reaching v2 completion is followed by a substantive native verification gap, including crashes before and after archival publication and replacement initialization. | `verification_gap_found` pauses the same owned goal; no child remains live; fresh goal-contract, scorecard, and resource decisions each have exact approval; archive intent/result bind the old run ID and terminal prefix digest; replay selects exactly one archive; a fresh opaque run ID/results root/baseline is initialized before goal reactivation; the old v2 prefix remains immutable and no second goal binding is created. |
| ARAD-01 | Candidate queue, evaluator latency, lease pressure, and accepted metric/guard evidence identify a verified bottleneck while another pool is idle. | A fresh adaptive observation and universal decision pipeline shift only fitting candidate grants/role mix/refill capacity toward that bottleneck; the fixed objective, scorecard, evaluator, guard, and frontier remain unchanged. |
| ARAD-02 | Claim, result, admission/rejection, lease-release, material-evidence, and recovery events arrive in rapid succession. | Each event has an epoch-qualified observation; unchanged observations are deterministic no-ops, hysteresis/minimum windows prevent role thrash, and verifier/red-team/control reserve is never consumed by candidates. |
| ARAD-03 | Adaptive observation or allocation CAS is stale, duplicated, or interrupted by root/daemon/controller crash, including ambiguous provider usage. | The stale proposal is rejected, the last committed allocation is restored or exactly rolled back, uncertain leases/charges remain quarantined, and no blind replay or late admission occurs. |
| ARAD-04 | An adaptive request would require more cloud, spend, egress, credentials, authority, bank, or execution ceiling than approved. | Dispatch pauses before the charge and requests the exact user-approved resource decision; unknown capacity remains zero and no silent local fallback occurs. |
| ARAD-05 | A candidate experiment phase, incident, or completion gate yields a reusable evidence-backed methodology/policy improvement. | The host-owned evaluator/parser and scorecard freeze metric direction, aggregation, variance/repeatability, deterministic risk, preregistered cases, required samples, effect/tolerance, mandatory hidden holdout/`heldOutInputDigest`, non-regression, and cost/latency predicates; baseline plus typed same-case and held-out/replay/canary measurement refs, independent Goodhart/regression/safety red team, and the generic proposal/review/result/event lifecycle determine promotion; registry epoch CAS, reload/future-load verification, and rollback-of/event metadata are required; an empty set is valid. |
| ARAD-06 | A proposed refinement is rejected, stale, unverified, or regresses a protected guard/invariant. | The revision is excluded from future runs or rolled back atomically; the approved scorecard/frontier and valid experiment evidence remain intact, and the discriminated revision registry scope/closure/status/epoch is checked before phase/effect with affected work fenced on supersession/revocation. |
| ARAD-07 | An AutoResearch proposal attempts to change the objective, scorecard, metric, target, evaluator, parser, guard, scope, v2-visible parallelism, or frontier authority through adaptive hints. | The host rejects it as a new user-approved workflow/resource decision; no candidate, v2 projection, or frontier state changes. |
| ARAD-08 | Canonical knowledge receives an approved how/why/provenance result and MemPalace is enabled or unavailable. | Canonical commit remains authoritative; MemPalace only indexes the committed record, and missing/stale/corrupt indexing cannot authorize a candidate or completion. |
| ARAD-09 | The adaptive controller is run on a host without enforceable physical resource isolation or with unknown capacity. | Conservative accounting serializes or stops the affected pool and records the limitation; the run never claims optimal or unknown capacity. |
| ARAD-10 | The approved resource plan schedules `cron` with trusted cadence and major-transition triggers while candidates claim, finish, release leases, and recover. | One fresh independent read-only snapshot/review is admitted per window, includes immutable objective/contract/scorecard/invariant/plan/critical-path/config/evaluator/guard/registry refs and digests plus critical path/queue/lease/cost/latency/progress/evidence; monotonic window state rejects backward/duplicate/replayed windows, and invocation binds reviewer child identity, read-only capability proof, admission/leases, epoch/execution key/token with typed actual-usage success/failure; host dereference/stale rejection precedes checks for underuse, overuse, redundancy, serializable work, context churn, verification starvation, review overhead, cloud cost, and Goodhart risk. |
| ARAD-11 | Two candidate/phase triggers overlap in one `cron` window or restart leaves several missed windows. | Window CAS rejects overlap, coalesces triggers, admits exactly one validated catch-up after restart, and discards older backlog without extra reviews or model turns. |
| ARAD-12 | `cron` returns a write, lease, allocation, frontier, scorecard, approval, or completion action, or its snapshot is stale/malformed. | The output is rejected as non-authorizing evidence; no candidate/frontier/scorecard/resource state changes and any application requires a new full decision/approval. |
| ARAD-13 | `cron` is late, unavailable, times out, or exceeds its approved review overhead/cost reserve. | A bounded nonblocking failure is recorded; latest-wins admission keeps one pending/one active review, enforces positive finite duty-cycle and per-window/phase/workflow limits with a dedicated reserve, and fixed metric/guard, last safe allocation, candidate admission, verifier, red team, recovery, and control reserve remain available. |
| ARAD-14 | A user or model changes `cron` cadence, trusted clock, trigger set, window, catch-up, or review reserve. | The schedule change is a new configuration/resource decision with exact approval; the active schedule remains unchanged until committed. |
| ARAD-15 | An accepted `cron` suggestion is retained for durable learning. | Only a subsequently accepted how/why/provenance knowledge record may be canonical or indexed; raw suggestions remain immutable evidence and never authority. |
| ARAD-16 | Recompute candidate demand from the same accepted DAG, typed host-derived remaining-work estimates, host-observed novelty proofs, and scheduler-policy digest. | The host emits the same independently admitted critical-path certificate and lexicographic ordering by time-to-genuine-proof, evidence gap, cost, uncertainty, queue age, and candidate/task ID digest. |
| ARAD-17 | Move a slot whose candidate is unclaimed, claimed, or active. | Only the unclaimed slot moves in place; claimed/active work is fence/reconciled and receives a new candidate attempt plus resource/ownership leases and a discriminated capacity grant. |
| ARAD-18 | Supply stale, expired, unauthenticated, non-monotonic, or unknown capacity/usage/billing/rate-limit refs. | Allocation CAS resolves headroom to zero, including provider charges, and preserves authenticated snapshot provenance. |
| ARAD-19 | Saturate worker grants while process/session/model-call/token/recovery control work is needed, including an `exclusive_unisolated` worker. | Hard control partitions remain available; the unisolated worker is isolated/serialized away from admission, verification, red team, recovery, and control. |
| ARAD-20 | Crash after a grant/lease/evaluator/frontier/provider intent and before its applied marker. | Effect broker proves nonexecution or fences/reconciles idempotently; uncertain leases/charges remain quarantined and no blind retry occurs. |
| ARAD-21 | Run exploit/explore allocation through repeated queue events and restart. | Persisted aging, last-served, bounded priority-bucket promotion, finite exploration quota, numeric benefit threshold, minimum dwell, transition cap, positive finite/range-validated fairness/hysteresis values, and safety-only override prevent starvation/thrash; the hard `WorkflowControlCapacityVector` and canonical pool ledger are component-wise reconciled and `exclusive_unisolated` work cannot consume reserved control dimensions. |
| ARAD-22 | Let a candidate lease expire with and without strong process/provider nonexecution proof. | Proven nonexecution reclaims deterministically; missing proof reaches finite terminal escalation without an indefinite user reap. |
| ARAD-23 | Deliver rapid adaptive observations while a review is pending or active. | The host keeps one latest pending and one active review, cancels superseded pending work, fences superseded active work, and prevents its result from applying. |
| ARAD-24 | Dispatch a task/candidate without an independently admitted value certificate or with duplicate novelty, unbounded outcome, or exhausted exploration quota. | Host rejects proxy work and preserves a finite certificate mapping to an unproven requirement/evidence gap, host-observed novelty proof, and typed bounded observable outcome. |
| ARAD-25 | Inject a slow evaluator/review, stale frontier, and admission-lock crash. | Expensive work runs outside the lock on an immutable snapshot; only a brief fenced heartbeat lock performs final revalidation/CAS, and stale/uncertain effects are reconciled without duplicate admission or charge. |

The implementation must run the affected package tests from the package root and
then the repository check required by the project. Acceptance is evidence-backed
only when the process logs, durable artifacts, and real integration assertions are
available for review; a passing mock suite alone is inadequate.

## Unresolved Risks

These risks are deliberately bounded in the first release rather than hidden by
optimistic defaults:

- The existing daemon child lifecycle and the kernel's general shared-workspace
  scheduler may not yet expose every identity, liveness, or worktree hook needed by
  an isolated candidate. The implementation must add adapters at existing seams;
  discovering a required wire change pauses implementation for the protocol review
  described above.
- Local resource grants are accounting and scheduling contracts, not hard CPU,
  memory, GPU, or disk sandboxes on every host. An evaluator or worker can exceed a
  grant before the host observes it. The run must record the overage and fail closed
  for admission, but cannot claim physical enforcement.
- Cloud execution remains an envelope and adapter boundary. Until a provider
  adapter reports launch, usage, termination, and provenance end-to-end, cloud
  capacity must stay disabled; no implementation may infer or emulate that evidence.
- A lease heartbeat can be delayed by a slow but live worker, making it look like a
  dead worker. Deterministic reclaim therefore requires strong process/provider
  nonexecution proof; without it, a finite deadline records terminal escalation
  and keeps the effect quarantined rather than waiting for an indefinite user reap.
- A deterministic evaluator can still be invalidated by mutable dependencies,
  external services, hidden caches, or noisy benchmarks. The fixed command, digest,
  environment/network policy, and baseline guard reduce this risk but do not prove
  evaluator validity; a detected instability is a scorecard or blocker finding.
- Worktree isolation does not remove conflicts in generated files, lockfiles,
  shared build caches, or external services. The scheduler must declare these as
  ownership and evaluator boundaries and freeze/reconcile an undeclared overlap;
  it must not guess a merge or discard another candidate's evidence.
- Anti-gaming red teams can miss a novel proxy or interaction. Independent verifier,
  completion red team, protected guards, immutable evaluator digests, and user
  approval reduce the risk, but the product must describe these as defenses rather
  than a formal proof of semantic optimality.
- A user scope or evaluator amendment can invalidate expensive in-flight candidates.
  Reconciliation preserves their artifacts and provenance, but the user accepts the
  resulting wasted capacity when approving the amendment.

## Design Decisions Resolved Here

1. The numeric primary metric and numeric target are mandatory; a guard is separate
   and pass/fail. There is no multi-objective or prose-only admission in the first
   release.
2. The evaluator is fixed and content-addressed. If the evaluator lies in editable
   scope, the host runs an approved immutable copy rather than trusting the
   candidate's version.
3. Scope is editable by the user through approved revisions, never by a candidate.
   A material objective change starts a new archived run.
4. Candidate worktrees are outside the repository and isolated. The frontier is
   advanced only by serialized host admission; failed trials are preserved, not
   destructively reset.
5. Plateau forces exploration and is visible evidence; it is not success and does
   not silently terminate an active run. A plateau stop is user-authorized.
6. Local capacity is explicit and advisory. Cloud capacity is disabled unless a
   user-authorized envelope and reporting adapter exist; this document specifies
   product behavior, not provider infrastructure.
7. Immutable files and validated append-only events are the only runtime source of
   truth. Reports, transcripts, caches, stale worker messages, and model summaries
   cannot repair or complete a run.
8. Completion requires target admission, independent verification, anti-gaming
   completion audit, and final refinement review. A candidate's `complete` word is
   never enough.
