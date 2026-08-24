# Unified Durable Workflows Design

Date: 2026-08-13
Status: Approved by the user for implementation planning; implementation not started
Approval baseline SHA-256: 713b1223bf37aafbb8208de1c3ee565955daf82329fac8fcf6629ec05156ee8e

## Approved clarification/addendum (2026-08-14)

This approved clarification supplements the 2026-08-13 design. The original
approval status and `Approval baseline SHA-256` above remain unchanged; this
addendum is an implementation clarification, not an implicit approval to
expand the user's resource, cloud, spend, or authority envelope.

While a durable goal is active, the controller continuously seeks the fastest
genuine result that the approved contract can prove. It observes a verified
critical path, ready queues, evidence gaps, blockers, throughput and latency,
marginal verified progress per resource, uncertainty, live local/cloud leases,
and control-plane reserve. These are host-observed scheduling facts. They are
not model-authored progress scores, and throughput, latency, utilization, or
worker count can never replace requirement evidence or a scorecard result.

After every task, phase, result, lease release, or material evidence
transition, the controller records a fresh observation and, when an allocation
change is proposed, runs the universal recon/lens/verification/synthesis/red-
team/host gate against that exact observation. The host then shifts capacity to
the independently verified bottleneck when the change is inside the approved
envelope. An unchanged observation is a deterministic no-op; it does not create
model turns, activity artifacts, or a background busy loop. Hysteresis,
minimum observation windows, and bounded reallocation counts prevent thrash.

The controller never self-scores progress, starves the verifier, red team, or
control plane, uses unknown capacity, or exceeds an approved local/cloud/spend
limit. Any envelope, cloud, spend, credential, egress, authority, or execution-
ceiling expansion pauses for an exact user approval bound to the changed
digests. Adaptive allocation state, proposals, applications, stale-observation
rejections, lease dispositions, crash recovery, and rollback are durable
journal records. A crashed controller restores the last committed safe
allocation, quarantines uncertain leases, rejects stale observations, and
reconciles before making another allocation decision.

After each phase, incident, and completion gate, the controller also queues a
small evidence-backed improvement review. A candidate workflow, methodology,
or policy revision must beat its current baseline on the same pressure cases
plus held-out, replay, or canary cases as applicable; an independent verifier
and Goodhart/regression/safety red team must accept it. Compatible revisions
promote atomically by compare-and-swap with rollback metadata. Rejected or
rolled-back revisions are not loaded by future runs; future runs load only
approved revisions. Canonical knowledge stores the resulting how/why and
provenance records, while optional MemPalace only indexes approved canonical
records. Neither store authorizes allocation, workflow state, or completion.

A recurring independent efficiency-red-team reviewer, named `cron`, is an
approved read-only workflow role, not an unbounded daemon. Its trusted clock,
cadence, major-transition trigger set, exactly-once window policy, catch-up
rule, and bounded review resource/cost reserve are part of the approved
resource envelope. At each scheduled window or enabled major transition, a
fresh independent context receives only the host-resolved critical-path,
queue, lease, cost, latency, verified-progress, and evidence snapshot. It
checks resource placement and fastest genuine completion for underuse,
overuse, redundancy, serializable work, context churn, verification
starvation, review overhead, cloud cost, and Goodhart risk. It emits only
immutable evidence-backed suggestions; it has zero write, lease, allocation,
approval, or completion authority. Applying a suggestion is a new full
decision and approval, and changing its schedule is itself a decision.

The reviewer runs at most once per window. Overlapping runs are rejected by
window CAS; after restart, at most one bounded catch-up review is admitted and
the remainder of the missed schedule is discarded, never replayed as a
backlog storm. Reviewer overhead is reserved before workers and cannot starve
verification, red-team, recovery, or control-plane work. A failed, late, or
unavailable reviewer records a nonblocking failure and leaves the last safe
allocation in place. Canonical knowledge may retain an accepted how/why
lesson about a suggestion, while optional MemPalace only indexes that accepted
record; raw suggestions never become authority.

The kernel owns this adaptive controller, its durable state/events, resource
leases, universal gate, recovery, and rollback. Native methodology owns phase
and role demand hints; AutoResearch owns experiment-specific signals while
keeping its fixed metric/guard and objective; the knowledge layer owns audited
improvement records and provenance. The first release is bounded to observable
local pools and already approved cloud adapters, existing durable leases, and
finite controller/review ceilings. It adds no resident infinite daemon, hidden
capacity, automatic envelope expansion, or daemon wire change.

## Summary

Prime Agent will add an explicit durable workflow mode for long-running work. A workflow binds one persistent goal to a host-managed loop that hardens the goal, establishes a user-approved scorecard and resource envelope, gathers evidence, plans work, saturates safely available capacity, audits every decision and claimed advance, verifies the whole result, refines reusable harness knowledge, and continues until the goal is proven complete or a legitimate terminal condition is reached.

The workflow engine composes existing goals, skills, autonomous continuations, daemon-backed subagents, session artifacts, recovery journals, and continual-harness refinement. It is the common kernel for four built-in systems:

1. the durable workflow and universal decision kernel described here;
2. the native development methodology described in `2026-08-13-native-methodology-design.md`;
3. the native AutoResearch specialization described in `2026-08-13-autoresearch-design.md`; and
4. the durable knowledge, refinement, and optional MemPalace layer described in `2026-08-13-knowledge-refinement-design.md`.

The kernel owns state, authority, provenance, scheduling, recovery, and transition validation. Skills own adaptable methodology. AutoResearch supplies a specialized experiment protocol. The knowledge layer stores only audited durable how/why/procedure knowledge. None of these creates a second agent runtime.

## Unified Evidence and Decision Pattern

Every model-proposed state change or trust-advancing conclusion uses the same finite pipeline:

```text
recon -> independent lenses -> evidence verification -> synthesis
      -> adversarial red team -> host gate -> deterministic execution
```

- **Recon** gathers current ground truth before action. It is read-only and fans out across relevant sources, code, state, history, tests, or external evidence.
- **Lenses** analyze the same decision through distinct, non-overlapping charters such as intent, correctness, reuse, security, efficiency, operations, metric integrity, and authority.
- **Verification** checks factual claims against exact evidence and state digests. It uses fresh contexts and host-observed commands or artifacts rather than accepting worker self-report.
- **Synthesis** deduplicates and reconciles surviving findings into one exact proposal. It does not treat agent votes as ground truth.
- **Red team** receives the exact synthesized proposal and tries to falsify it against the original objective, approved contract, authority boundaries, protected invariants, proxy risks, and known failure modes.
- **Host gate** accepts only a current, authorized, conflict-free proposal with valid provenance. It applies pre-approved transition rules deterministically or pauses for the user.

This pattern is used for goal contracts, scorecards, resource envelopes, plans, ownership, strategy changes, progress acceptance, blockers, recovery classifications, AutoResearch candidate admission, refinement, memory writes, and completion.

The pattern does not recurse indefinitely. Evidence artifacts, adversarial findings, digest calculation, journal appends, predicate evaluation, replay, and exact application of an already approved transition are deterministic mechanisms rather than new decisions. Changing a proposal's target, effect, authority, preconditions, scope, or semantic merge creates a new decision revision and therefore a new red-team pass.

### Fresh stages and independence limits

A stage is **fresh** when the host starts a new invocation with a new session
and execution identity, gives it only the exact immutable input artifacts and
state digests declared by the decision, and does not continue or expose the
prior stage's conversation. A stage is **independent** of another stage when,
in addition, it has a distinct invocation/session and execution identity, a
non-overlapping charter and output namespace, no mutable output channel shared
with the other stage, and no authority to edit the proposal or evidence being
judged. Both stages may inspect the same immutable input snapshot; that shared
input is required for comparable verdicts and is not itself a dependency.
Independence is invalid if a stage reads an unreferenced mutable output,
inherits hidden conversation state, reuses the prior stage's execution
identity, or judges its own proposal without a declared adversarial boundary.

Fresh contexts and these independence controls do not prove truth or eliminate
correlated failure. Stages may use the same model family, provider, code,
filesystem, evaluator, or flawed source evidence; distinct lenses can
therefore repeat a common mistake. Re-running a parser over one artifact is not
independent evidence, and a red-team verdict is an independent challenge of a
proposal rather than an independent observation of the user outcome. The host
can verify declared provenance, digests, identities, and output boundaries, but
cannot prove that an unobservable hidden channel or common source defect did not
correlate the stages. Verdicts and evidence must carry these limitations so a
stage count is never treated as a confidence score.

## Problem

The current runtime already persists conversations and goals, continues turns autonomously, runs command gates, recovers daemon workers, and supports durable subagents. These mechanisms do not yet provide a single durable coordinator that:

- carries a complex objective across fresh model contexts;
- keeps planning after workers, contexts, or initial strategies end;
- fans out all dependency-independent work safely;
- pauses without losing state when a skill requires user approval;
- distinguishes observable progress from model-authored claims;
- reconciles uncertain work after a crash without replaying side effects;
- independently verifies the full user outcome; and
- turns audited lessons into reusable harness improvements.

As a result, a long task can be durable at the session level while still losing coherence at the work-orchestration level.

## Goals

The first release must:

1. Start workflows explicitly rather than changing ordinary session behavior.
2. Bind each workflow to a durable goal that remains active across turns, context resets, child sessions, client disconnects, worker crashes, and daemon replacement.
3. Establish a typed scorecard of numeric targets, binary acceptance checks, and protected invariants; red-team it and obtain user approval before work advances against it.
4. Probe local capacity and ask the user whether cloud compute is available, then red-team and obtain user approval for the exact resource, time, cost, provider, region, and egress envelope.
5. Use fresh contexts for recon, lenses, synthesis, red team, goal hardening, planning cycles, workers, progress audits, verification, completion audits, reconciliation, and refinement review.
6. Red-team every model-proposed state-changing or trust-advancing decision before host acceptance.
7. Keep a durable planner moving the workflow forward until completion or a legitimate stopping condition.
8. Continuously fill every safe capacity slot with independently valuable ready work and refill it as soon as a lease is released.
9. Dispatch ownership-compatible general tasks in the shared workspace only when the host can enforce their write sets; serialize unsafe write-capable tasks while continuing independent read-only work.
10. Treat installed skills as authoritative phase methodology, including human approval requirements, and authenticate the exact skill revision and gate events used.
11. Pause durably for skill-mandated approval and resume from a fresh context with the recorded response.
12. Accept progress only when an independent auditor can attach observable, current evidence to a hardened goal requirement.
13. Detect attempts to satisfy proxy metrics, inflate utilization, weaken verification, or narrow scope while missing the actual objective.
14. Recover through fencing, idempotency keys, and reconciliation rather than blind replay.
15. Require independent verification and an adversarial completion decision before success.
16. Run evidence-backed continual-harness refinement as part of the loop.
17. Provide native AutoResearch, native development methodology, canonical operational memory, and optional MemPalace indexing as specializations of the same kernel.
18. Support explicit durable-inline and durable-parallel execution profiles over the same contracts, with evidence-based profile selection and no automatic ordinary-session activation.
19. Produce bounded, evidence-linked continuity capsules so every fresh planner can resume the exact current state without replaying conversation or committing status documents.

## Non-goals

The first release will not:

- replace ordinary goals or autonomous mode;
- parse skill prose into host logic or silently replace project/user methodology;
- support more than one unfinished workflow per root session;
- use Git worktrees for ordinary shared-workspace tasks unless isolation is required because a write set cannot be enforced; AutoResearch candidates always use worktrees;
- merge, commit, push, deploy, post messages, or perform other consequential actions without the authority already present in the user request and repository policy;
- use model-authored completion percentages;
- automatically approve a skill gate;
- infer unknown cloud capacity, quota, pricing, region, credentials, or data-egress authority;
- create duplicate, no-op, unrelated, or artificial tasks merely to raise utilization;
- infer an execution profile from prompt keywords or silently turn an ordinary session into a workflow;
- maintain a second authoritative set of project progress/diary/session documents or automatically commit workflow status files;
- roll back workspace changes when a workflow is cancelled; or
- add a new daemon wire command, event, or response shape.

## Existing Mechanisms Reused

The design extends the current architecture at its existing boundaries:

- `GoalState` remains the user-facing objective and aggregate-usage projection for
  workflow-owned goals; the workflow journal is authoritative for their
  transitions and binding.
- `AgentSession` remains the owner of prompts, host requests, transcript writes, and child lifecycles.
- the resource loader and existing skill invocation path remain authoritative for skill discovery and loading;
- daemon-backed RLM children provide fresh planner, worker, auditor, verifier, and reconciliation sessions;
- autonomous mode provides bounded continuation inside one phase attempt;
- session artifacts store workflow state beside other session-owned durable data;
- daemon worker recovery restores the root tree and observes the child registry
  for liveness only; the registry cannot authorize workflow state, effects, or
  completion;
- the existing refinement subsystem reviews and transactionally updates local or global continual-harness state.

Existing session leases and daemon supervisor ownership patterns inform workflow coordinator fencing. The current kernel boot gate remains one input to capacity planning, but it is not the workflow resource allocator because it does not account for live worker slots, RAM, accelerators, provider quotas, cost, network, or control-plane reserve.

For a goal bound to a workflow, the journal is the sole authority for every
workflow-owned goal transition. The coordinator appends and durably commits the
workflow transition event first; the reducer then applies that event to the
user-facing `GoalState` projection with an idempotent compare-and-swap keyed by
workflow ID, event sequence, and transition digest. A crash between those steps
replays the same CAS; it never invents a new transition and never makes the
projection authoritative. Direct skill, slash-command, model, or daemon writes
to a bound goal are rejected, including writes that appear to be harmless
status or usage updates. Unbound, ordinary goals retain their existing direct
mutation path. Goal accounting exposed by `GoalState` is therefore a projection
of journaled usage and transition events, not an independent source of truth.

The first release has four implementation prerequisites that the current substrate does not yet fully provide:

1. a durable admission record that propagates one workflow attempt/idempotency key through child creation and permits live-child reattachment;
2. a host effect broker that checks the active fencing epoch at effect commit, owns descendant process groups, and records external idempotency capabilities;
3. a host-enforced mutation boundary for concurrent writers, or isolated worktrees plus serialized integration when such enforcement is unavailable; and
4. immutable skill snapshots with dependency digests and machine-readable workflow gate metadata.

These are required kernel work, not facts assumed about the existing implementation. If any prerequisite requires a daemon wire change, that part must stop for capability-gated or incompatible protocol design and compatibility tests before implementation continues.

## User Interface

### Interactive commands

- `/workflow start [--profile inline|parallel] [--max-workers <n>] <objective>` creates a goal and starts workflow preflight; `--profile` records a requested preference, not a resolved grant.
- `/workflow start [--profile inline|parallel] [--max-workers <n>]` binds workflow preflight to the current active goal with the same preference semantics.
- `/workflow status` shows the current phase, scorecard, resource envelope, decision queue, hardened requirements, accepted evidence, running tasks, pending dependencies, capacity leases, worker identities, usage, and any pause reason.
- `/workflow decisions [decision-id]` shows proposals, evidence, lens findings, red-team verdicts, approvals, revisions, and host disposition.
- `/workflow resources` shows discovered capacity, the approved envelope, live reservations, control reserve, limiting pools, queue age, cost, and idle reasons.
- `/workflow pause [reason]` prevents new dispatch and leaves active attempts at a safe host-controlled boundary.
- `/workflow respond <decision-id> <option-id>` consumes the exact pending approval through a typed command and resumes in a fresh planner context.
- `/workflow resume [note]` resumes only a user-paused workflow; it never consumes an approval.
- `/workflow cancel [reason]` stops active children and records cancellation without reverting workspace changes.

If a workflow is awaiting user input, the host persists a durable approval
request containing an `approvalRequestId`, a hash of the one-use response
secret (never the raw secret), decision and revision IDs, exact proposal and
state digests, store/coordinator epochs, requesting client/session identity,
expiry, and expected response sequence. A typed UI action or
`/workflow respond <decision-id> <option-id>` resolves that request through the
host; the client supplies the request identity, trusted principal, and a
transport-only `secretProof`. Its binding digest covers the request, decision,
state, store/coordinator epochs, principal, client session, response sequence,
selected option, and hash of the one-use secret. The host verifies the proof,
strips the raw secret before persistence, and atomically consumes its hash with
the approval CAS. A headless caller instead uses the discriminated
`signed_headless` response with no secret field; its signature covers the exact
request, decision, state, store/coordinator epochs, principal, client session,
response sequence, option, and expiry. The host validates that binding before
the same atomic consume/CAS when the configured trust policy supports it. An
ordinary message, quoted command, model-authored text,
`/workflow resume`, or inspection/control command never counts as approval.
Stale, duplicate, wrong-client, wrong-principal, wrong-epoch, expired, or
digest-mismatched responses are rejected.

Start is valid only when the root session has no unfinished workflow. With an explicit objective and no active goal, start creates the goal. With an active goal, an omitted objective binds to it; a supplied objective must match it exactly or start fails. A terminal prior workflow remains inspectable and does not prevent starting a new one. Cancellation terminally unbinds the workflow from its goal while leaving the goal paused and explicitly resumable or replaceable; a new workflow may start only after the user resumes, completes, or replaces that paused goal. Duplicate approval responses are idempotently rejected after the bound `approvalRequestId` is consumed; no raw approval secret is retained in the journal.

Preflight probes observable local resources, then asks whether cloud compute is available and, if so, requests provider, account, region, CPU/GPU types and counts, model/API concurrency and rate quotas, time window, spend ceiling, and data-egress restrictions. Unknown values mean zero allocatable cloud capacity. Goal hardening may use only the finite local control-plane ceiling; it cannot consume cloud or dispatch product work. The resulting task resource envelope, resolved profile, and downstream scorecard are separate material decisions; each receives evidence verification, red-team review, and explicit user approval before task dispatch.

### Command-line entry

`--workflow <objective>` starts the same explicit workflow in a newly created or resumed root session. `--workflow-profile inline|parallel` requests a profile preference, and `--workflow-max-workers <n>` optionally caps concurrent worker tasks; both require `--workflow`. The resolved profile is selected only after capacity discovery and initial graph/resource review, then approved with those exact decisions. Non-interactive invocations may provide a previously approved resource-envelope file and scorecard digest; absent approval, they durably stop at `awaiting_user` rather than assuming authority.

The command-line implementation creates the session normally, then sends the workflow start request through existing prompt transport. This avoids adding workflow fields to daemon session-creation protocol messages.

A headless invocation may exit while the workflow is durably awaiting approval,
paused, budget-limited, blocked, failed, cancelled, or complete. A later attach
inspects every state; resume is valid only for the explicitly resumable states in
the transition matrix. `cancelled`, `failed`, and `complete` never resume.

## Execution Profiles and Continuity

Ordinary sessions remain the direct lightweight path and never enter this state
machine automatically. An explicit workflow has one of two execution profiles:

- `inline` keeps implementation in one fresh phase context at a time while still
  using separate fresh recon, verifier, red-team, progress-audit, recovery, and
  refinement contexts. It is useful when the graph has one write path or safe
  capacity is one.
- `parallel` uses the widest safe dependency/ownership/resource-compatible wave and
  immediate refill. It is the recommended profile when at least two independently
  valuable ready tasks fit the approved envelope.

Preflight stores only a requested preference. The planner resolves a profile
from the accepted initial task graph and measured capacity, and the user approves
it with the plan/resource decisions before dispatch. Profile changes
are material plan/resource revisions and receive the universal decision pipeline.
Both profiles have identical goal, scorecard, approval, anti-cheating, evidence,
recovery, verification, completion, and refinement requirements. A profile never
changes merely because a prompt contains a route-like word.

At every accepted material transition, context rollover, pause, budget stop,
blocker, recovery boundary, and completion gate, the host deterministically derives
a bounded `ContinuityCapsule` from the authoritative journal. It contains goal and
contract revisions, current phase/profile, proven/unproven/regressed requirements,
accepted evidence references, current plan/ready set, ownership/resource leases,
failed strategies, unresolved decisions, exact continuation entry point, and the
journal/workspace digests. It contains references and bounded facts, not raw
conversation or a model-authored percentage.

The capsule is a content-addressed projection under session artifacts. It is never
authoritative, never committed to the project, and is regenerated when its source
digest changes. A fresh planner receives the capsule plus exact referenced evidence;
the host rejects stale capsules. Optional model-written compression is a semantic
decision and must be verified/red-teamed before use; the deterministic typed capsule
needs no recursive model review. Workflow continuation state never enters canonical
how/why memory or MemPalace merely because a context ended.

## Linked workflow source integration boundary

The workflow repository supplied during design review was inspected at pinned
commit `e6c899ffd82d7d32aa9f93f0986a402add47c32d` (owner
`viettran-edgeAI`, tag `v1.1.3`, Git tree
`516333967c2a0042922ce3e5b80f725debc138cb`, retrieved
`2026-08-13`). The user-supplied locator has SHA-256
`58ed3d5cb0d47dcae80abb128cef1c5cdd27097738180b9c5ffa5d612e34f676`.
No license, notice, or other explicit reuse grant was present in that tree. The
canonical no-grant scan record has SHA-256
`d26b07b0903fa71a792e9bfdd5b7b51678e3214a055e0f2d7bcb15fae6449572`.
This design therefore adopts only independently
described ideas: no source code, instruction text, templates, names, generated
configuration, or project-document layout from that repository may be copied,
vendored, or distributed. Any later direct reuse requires a verified license
grant and a separate dependency/vendor decision.

Its useful mechanics are normalized into the existing kernel rather than added
as another runtime:

- its lightweight route remains an ordinary direct session;
- its medium and heavy route distinction becomes explicit `inline` and
  `parallel` profiles with identical gates, not prompt-keyword classification;
- narrow explorer, executor, tester, documentation, and closure roles become
  fresh attempt-scoped role contracts and typed handoffs, never resident
  authorities;
- evidence-rich worker packets become `WorkflowAttemptHandoff` records;
- routine tester-to-fixer repair becomes a bounded event-driven lane under the
  root decision authority;
- project progress/session documents become deterministic continuity and
  progress projections under session artifacts, not another ledger or automatic
  project commit; and
- immutable defaults, user-owned settings, generated projections, schema
  migrations, mutation plans, backups, and drift detection inform methodology
  configuration and vendor lifecycle transactions.

Automatic prompt routing, persistent agent authority, project diary/status
churn, automatic documentation reconciliation, end-of-session Git commits, and
a second package/update runtime are explicitly not imported. Neither are its
agent/model configuration, project-instruction importer, ignore-file edits,
enable/disable entry points, updater, removal behavior, or path layout. Existing
runtime policy, resource loading, settings, repository instructions, and Git
authority remain in force.

This boundary is clean-room enforced. The source is non-authoritative design
evidence, not a build input or runtime dependency. The provenance record must
retain the exact user-supplied locator in the private design-request artifact,
the locator digest above in source, pinned revision/tree, owner, retrieval date,
license/notice scan result, and independently authored notes that connect each
adopted mechanic to an existing kernel contract. CI must verify that the source tree is absent from
the package and that no source file, prompt/instruction text, template,
generated configuration, distinctive string sequence, or path layout from the
linked tree entered the implementation or generated artifacts. A provenance
manifest digest and the CI clean-room report are acceptance evidence; changing
the linked revision requires a new scan and review rather than silently
extending the prior approval.

## Workflow Lifecycle

Workflow status and phase are separate. Status answers whether the workflow may run; phase answers what the coordinator is doing.

Statuses:

- `active`
- `awaiting_user`
- `paused`
- `budget_limited`
- `blocked`
- `failed`
- `cancelled`
- `complete`

Phases:

- `discovering_capacity`
- `hardening_goal`
- `hardening_scorecard`
- `reconnaissance`
- `analyzing_lenses`
- `verifying_evidence`
- `synthesizing`
- `red_teaming`
- `adjudicating`
- `planning`
- `dispatching`
- `executing`
- `auditing_progress`
- `verifying`
- `auditing_completion`
- `refining`
- `recovering`

```typescript
type WorkflowStatus =
  | "active"
  | "awaiting_user"
  | "paused"
  | "budget_limited"
  | "blocked"
  | "failed"
  | "cancelled"
  | "complete";

type WorkflowGoalProjectionStatus =
  | "idle"
  | "active"
  | "paused"
  | "budget_limited"
  | "complete"
  | "error";

type WorkflowPhaseId =
  | "discovering_capacity"
  | "hardening_goal"
  | "hardening_scorecard"
  | "reconnaissance"
  | "analyzing_lenses"
  | "verifying_evidence"
  | "synthesizing"
  | "red_teaming"
  | "adjudicating"
  | "planning"
  | "dispatching"
  | "executing"
  | "auditing_progress"
  | "verifying"
  | "auditing_completion"
  | "refining"
  | "recovering";
```

The workflow status transition matrix is closed and host-enforced:

| Current status | Allowed next status | Required event or gate |
| --- | --- | --- |
| `active` | `active`, `awaiting_user`, `paused`, `budget_limited`, `blocked`, `failed`, `cancelled`, `complete` | A validated non-blocker phase outcome, user action, budget decision, recovery result, confirmed `WorkflowBlockerRecord`, or completion gate |
| `awaiting_user` | `active`, `paused`, `blocked`, `failed`, `cancelled` | The bound approval response, explicit pause/cancel, confirmed `WorkflowBlockerRecord`, or unrecoverable recovery finding |
| `paused` | `active`, `cancelled`, `failed` | Explicit user resume/cancel or unrecoverable recovery finding |
| `budget_limited` | `active`, `cancelled`, `failed` | Reconciled budget extension/release, explicit cancel, or unrecoverable recovery finding |
| `blocked` | `active`, `awaiting_user`, `cancelled`, `failed` | Audited safe alternative, required user authority, explicit cancel, or unrecoverable recovery finding |
| `failed` | none | Terminal; inspectable only |
| `cancelled` | none | Terminal after descendant fencing and reconciliation |
| `complete` | none | Terminal after completion-readiness and final projection |

No status transition is inferred from a missing child, transcript text, model
final message, or daemon registry state. A phase may produce only one of the
closed, discriminated outcomes defined below, and the host maps that outcome to
one row of this matrix.

The normal loop is:

```text
discovering_capacity
  -> hardening_goal
  -> hardening_scorecard
  -> recon -> lenses -> verify -> synthesize -> red-team -> host adjudication
  -> planning
  -> decision pipeline
  -> dispatching
  -> executing
  -> auditing_progress
  -> decision pipeline
  -> planning                 when requirements remain
  -> verifying               when all requirements have current evidence
  -> auditing_completion
  -> decision pipeline
  -> planning                 when verification or the audit finds a gap
  -> refining
  -> decision pipeline
  -> complete
```

`decision pipeline` expands to the recon, lens, evidence-verification, synthesis, red-team, and host-adjudication phases. The host may reuse current recon evidence only while all bound state digests remain unchanged; it never reuses an adversarial verdict for a changed decision revision.

An approved reusable lesson may also trigger a refinement checkpoint after an audited milestone or repeated audited failure. The next planner context loads the refined harness state.

No phase is complete merely because its model response ended. Every phase must record a valid structured outcome through the workflow host bridge.

The workflow coordinator keeps the existing goal lifecycle aligned with workflow status. `active` keeps the goal active; `awaiting_user`, user `paused`, `blocked`, and `cancelled` pause the goal with the workflow reason; `budget_limited` preserves the matching goal status; unrecoverable workflow failure marks the goal `error`; and only an authorized completion audit marks both workflow and goal `complete`. Resuming a resumable workflow state reactivates the same goal rather than creating a replacement. This mapping is a journaled workflow transition followed by the idempotent `GoalState` projection CAS described above; a projection lag or retry cannot create a second transition.

While a workflow owns a goal binding, ordinary skill, slash-command, model, or
daemon requests cannot complete, replace, resume, or otherwise bypass the
workflow transition. Goal mutations carry the workflow ID, approved decision
revision, store epoch, and coordinator epoch and apply by compare-and-swap only
after the corresponding journal event is committed. Cancellation releases
workflow ownership only after descendant fencing and reconciliation; it
preserves the paused goal. Starting another workflow therefore requires an
explicit goal resume, completion, or replacement transition first. The daemon
child registry can report liveness and identity observations during this process
but cannot mutate the binding or authorize its release.

## Durable State

Each workflow belongs to one root session and is stored at:

```text
session-artifacts/<session-id>/workflows/<workflow-id>/
  events.log
  handoffs/
  evidence/
```

`events.log` is the authoritative append-only hash-chained journal. A logical
event uses a framed `prepared` record followed by a framed `committed` marker.
Each frame has a fixed magic/version header, byte length, sequence, kind,
store epoch, coordinator epoch, prior committed-event digest, payload digest,
authenticated writer identity, canonical payload bytes, and frame checksum.
Only a fully
written, flushed, parent-directory-durable committed marker makes the event
visible to the reducer or permits the effect it authorizes.

Journal payloads use one versioned canonical UTF-8 encoding with sorted object
keys, normalized line endings, explicit empty fields, and duplicate-key
rejection. The active coordinator holds an inter-process append lease. Only a
final prepared frame that is provably uncommitted, with proof that the host
never crossed the commit-return boundary, may be quarantined as uncommitted. A partial commit,
partial outcome, unresolved committed intent, or any tail whose effect status
cannot be proven is never treated as non-execution: replay enters recovery,
fences new effects, and reconciles it before retry. Malformed or unauthenticated
interior frames, gaps, duplicate sequences, unknown required fields, and chain
breaks quarantine the journal and forbid writes. Compaction, if later added,
must publish a content-addressed checkpoint plus a retained chain prefix and
cannot silently discard audit history.

Large structured handoffs and command evidence live in separate immutable files.
Artifact payloads never contain their own reference wrapper. Journal events
reference them by normalized relative path and content digest; absolute paths,
`..`, symlinks, hardlinks, device files, and paths outside the workflow artifact
root are rejected. Workflow status is reconstructed from the journal; an optional
derived snapshot may improve load time but is never authoritative.

`WorkflowArtifactEnvelope` is host-created only after hashing and publishing the
payload. Self-referential payload fields are forbidden. A payload may refer to
earlier immutable artifacts, but never to its own future event sequence or digest.

The root workflow coordinator is the only journal writer. This is enforced with an owner lease and monotonically increasing fencing epoch, not merely assumed. Every journal mutation, decision compare-and-swap, resource lease, and dispatch must match the active epoch. A restored coordinator acquires a new epoch before acting; stale coordinators cannot append or dispatch.

Children may create attempt-unique immutable handoff or evidence files, then report their references to the root; they never append workflow events. Artifact publication uses a temporary file, file flush, atomic rename, and parent-directory flush before the root appends the referencing event. Orphaned artifacts without a journal reference are ignored during replay and may be reported for cleanup.

The reconstructed state includes:

- format version, workflow ID, root session ID, and timestamps;
- current status and phase;
- original objective and bound goal ID;
- user-approved scorecard revisions and protected invariants;
- discovered local capacity and user-approved cloud/resource envelope revisions;
- durable resource reservations, limiting pools, cost, and release outcomes;
- coordinator lease epochs and fencing history;
- hardened goal contract revisions;
- decision IDs, revisions, parent relationships, evidence/lens/synthesis/red-team artifacts, approvals, and dispositions;
- plan revisions and task dependency graph;
- task attempts, assigned child sessions, and ownership claims;
- invoked skills and their source paths;
- approval requests and user responses;
- structured handoffs;
- requirement evidence and invalidations;
- verification and adversarial audit findings;
- planner strategy changes and failed approaches;
- refinement reviews and applied refinement IDs;
- canonical memory proposals, red-team outcomes, applied entries, optional index state, and rollback references;
- phase and total usage;
- interruption, retry, pause, block, failure, cancellation, and completion reasons.

Every workflow record carries a format version independent of the daemon protocol version. The store epoch identifies the durable-store instance generation; the coordinator epoch identifies the current workflow owner within that store. A valid event, decision, lease, approval, child identity, projection CAS, or phase outcome must carry and match both epochs where applicable. A coordinator replacement advances its coordinator epoch; store recovery or replacement advances its store epoch and quarantines records from a prior store generation until explicitly reconciled.

The following shared records are normative interfaces consumed by all
specializations; native layers extend them rather than declaring parallel
approval, artifact, phase, evidence, handoff, or reconciliation schemas:

```typescript
interface WorkflowArtifactRef {
  artifactId: string;
  relativePath: string;
  digest: string;
  sizeBytes: number;
  sourceEventSequence: number;
}

interface WorkflowArtifactEnvelope {
  ref: WorkflowArtifactRef;
  payloadKind: string;
}

interface WorkflowAcceleratorResource {
  poolId: string;
  deviceType: string;
  count: number;
  memoryBytes: number;
}

interface WorkflowProviderResource {
  poolId: string;
  concurrentRequests: number;
  requestsPerMinute: number;
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  idempotency: "provider_native" | "host_reconciled" | "none";
}

interface WorkflowResourceVector {
  cpuMilliCores: number;
  memoryBytes: number;
  diskBytes: number;
  ioWeight: number;
  accelerators: readonly WorkflowAcceleratorResource[];
  providers: readonly WorkflowProviderResource[];
  networkEgressBytes: number;
  wallMilliseconds: number;
  monetaryMicrounits: number;
}

interface WorkflowInstantaneousPoolLedger {
  poolId: string;
  dimension: "concurrency" | "tokens" | "bytes" | "wall_time";
  approvedCapacity: number;
  reservedCapacity: number;
  activeCapacity: number;
  remainingCapacity: number;
  observedAt: string;
  monotonicObservationSequence: number;
  ledgerDigest: string;
}

interface WorkflowCumulativeSpendLedger {
  poolId: string;
  budgetMicrounits: number;
  committedMicrounits: number;
  settledMicrounits: number;
  quarantinedMicrounits: number;
  remainingMicrounits: number;
  observedAt: string;
  monotonicObservationSequence: number;
  ledgerDigest: string;
}

type WorkflowResourceLedgerComponent =
  | "cpuMilliCores"
  | "memoryBytes"
  | "diskBytes"
  | "ioWeight"
  | "accelerators"
  | "providers"
  | "networkEgressBytes"
  | "wallMilliseconds"
  | "monetaryMicrounits";
type WorkflowControlLedgerComponent =
  | "processSlots"
  | "childSessionSlots"
  | "modelCallSlots"
  | "modelInputTokens"
  | "modelOutputTokens"
  | "verificationSlots"
  | "redTeamSlots"
  | "recoverySlots";

interface WorkflowCanonicalPoolLedger {
  ledgerId: string;
  ledgerEpoch: number;
  instantaneousPools: readonly WorkflowInstantaneousPoolLedger[];
  cumulativeSpendPools: readonly WorkflowCumulativeSpendLedger[];
  accountedResourceComponents: readonly WorkflowResourceLedgerComponent[];
  accountedControlComponents: readonly WorkflowControlLedgerComponent[];
  exhaustiveComponentAccounting: true;
  reserveRepresentation: "canonical_ledger_only";
  ledgerDigest: string;
}

interface WorkflowExecutionCeilings {
  maxWorkflowWallMilliseconds: number;
  maxWorkflowTokens: number;
  maxModelCalls: number;
  maxTaskAttempts: number;
  maxPlannerCycles: number;
  maxDistinctStrategiesPerRequirement: number;
  maxAnalysisAttemptsPerRequirement: number;
  maxRecoveryAttemptsPerEffectClass: number;
  renewalRequiresUserApproval: true;
}

type WorkflowResourceEnforcementClass =
  | "isolated_metered"
  | "host_bounded"
  | "exclusive_unisolated";

interface WorkflowResourceAdmission {
  capacityGrant: WorkflowCapacityGrant;
  canonicalPoolLedgerRef: WorkflowArtifactRef;
  controlCapacity: WorkflowControlCapacityVector;
  controlCapacityProjectionDigest: string;
  declaredVector: WorkflowResourceVector;
  hostDerivedConservativeVector: WorkflowResourceVector;
  reservedVector: WorkflowResourceVector;
  derivationPolicyDigest: string;
  enforcementClass: WorkflowResourceEnforcementClass;
  unknownPoolIds: readonly string[];
  admissionDigest: string;
}

interface WorkflowAuthenticatedCapacitySnapshotRefs {
  capacitySnapshotRef: WorkflowArtifactRef;
  usageSnapshotRef: WorkflowArtifactRef;
  billingSnapshotRef: WorkflowArtifactRef;
  rateLimitSnapshotRef: WorkflowArtifactRef;
  authenticationDigest: string;
  observedAt: string;
  expiresAt: string;
  monotonicObservationSequence: number;
  snapshotDigest: string;
}

interface WorkflowControlPartition {
  capacity: WorkflowControlCapacityVector;
  resourceVector: WorkflowResourceVector;
  canonicalPoolLedgerRef: WorkflowArtifactRef;
  partitionDigest: string;
}

interface WorkflowControlCapacityVector {
  processSlots: number;
  childSessionSlots: number;
  modelCallSlots: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  verificationSlots: number;
  redTeamSlots: number;
  recoverySlots: number;
}

interface WorkflowZeroControlCapacityVector {
  processSlots: 0;
  childSessionSlots: 0;
  modelCallSlots: 0;
  modelInputTokens: 0;
  modelOutputTokens: 0;
  verificationSlots: 0;
  redTeamSlots: 0;
  recoverySlots: 0;
}

type WorkflowCapacityGrant =
  | {
      kind: "worker";
      grantId: string;
      resourceVector: WorkflowResourceVector;
      controlCapacity: WorkflowZeroControlCapacityVector;
      canonicalPoolLedgerRef: WorkflowArtifactRef;
      grantDigest: string;
    }
  | {
      kind: "control";
      grantId: string;
      resourceVector: WorkflowResourceVector;
      controlCapacity: WorkflowControlCapacityVector;
      canonicalPoolLedgerRef: WorkflowArtifactRef;
      grantDigest: string;
    };

interface WorkflowWorkerPartition {
  resourceVector: WorkflowResourceVector;
  controlCapacity: WorkflowControlCapacityVector;
  enforcementClass: WorkflowResourceEnforcementClass;
  canonicalPoolLedgerRef: WorkflowArtifactRef;
  partitionDigest: string;
}

type WorkflowImprovementCaseKind =
  | "baseline"
  | "same_case"
  | "held_out"
  | "replay"
  | "canary";

interface WorkflowImprovementCaseManifestBase {
  manifestId: string;
  kind: WorkflowImprovementCaseKind;
  sourceArtifactRefs: readonly WorkflowArtifactRef[];
  inputDigest: string;
  hidden: boolean;
  requiredSampleSize: number;
  effectThreshold: number;
  tolerance: number;
  nonRegressionPredicateRefs: readonly WorkflowArtifactRef[];
  maxCostMicrounits: number;
  maxLatencyMilliseconds: number;
  manifestDigest: string;
}

type WorkflowImprovementCaseManifest =
  | (WorkflowImprovementCaseManifestBase & {
      kind: "baseline" | "same_case" | "replay" | "canary";
      hidden: false;
      heldOutInputDigest?: never;
    })
  | (WorkflowImprovementCaseManifestBase & {
      kind: "held_out";
      hidden: true;
      heldOutInputDigest: string;
    });

type WorkflowImprovementMetricDirection = "maximize" | "minimize" | "target";
type WorkflowImprovementAggregation = "exact" | "mean" | "median";
type WorkflowImprovementRiskClassification = "routine" | "risk_relevant";

interface WorkflowImprovementHoldoutCommitment {
  stage: "proposal" | "evaluation" | "red_team" | "promotion";
  inputCommitmentDigest: string;
  disclosure: "hidden_until_stage_complete" | "disclosed_after_evaluation";
  requiredSampleSize: number;
  effectThreshold: number;
  tolerance: number;
  commitmentDigest: string;
}

interface WorkflowImprovementEvaluatorContract {
  evaluatorRef: WorkflowArtifactRef;
  parserRef: WorkflowArtifactRef;
  owner: "host";
  metricDirection: WorkflowImprovementMetricDirection;
  aggregation: WorkflowImprovementAggregation;
  repeatabilityRuns: number;
  varianceBound: number;
  deterministicRiskClassifierRef: WorkflowArtifactRef;
  riskClassification: WorkflowImprovementRiskClassification;
  holdoutCommitmentRefs: readonly WorkflowArtifactRef[];
  evaluatorDigest: string;
  parserDigest: string;
  contractDigest: string;
}

interface WorkflowImprovementScorecard {
  scorecardId: string;
  revision: number;
  owner: "host";
  riskRelevantChange: boolean;
  caseManifestRefs: readonly WorkflowArtifactRef[];
  mandatoryHiddenHoldout: boolean;
  hiddenHoldoutManifestRefs: readonly WorkflowArtifactRef[];
  requiredSampleSizes: Readonly<Record<string, number>>;
  effectThreshold: number;
  tolerance: number;
  nonRegressionPredicateRefs: readonly WorkflowArtifactRef[];
  maxCostMicrounits: number;
  maxLatencyMilliseconds: number;
  proposerMayChooseOrOmitHoldouts: false;
  evaluatorContract: WorkflowImprovementEvaluatorContract;
  metricDirection: WorkflowImprovementMetricDirection;
  aggregation: WorkflowImprovementAggregation;
  repeatabilityRuns: number;
  varianceBound: number;
  riskClassification: WorkflowImprovementRiskClassification;
  holdoutCommitmentRefs: readonly WorkflowArtifactRef[];
  decisionRef: WorkflowDecisionRef;
  scorecardDigest: string;
}

interface WorkflowImprovementReviewBudget {
  observationQueuePolicy: "latest_wins";
  maxPendingReviews: 1;
  maxActiveReviews: 1;
  supersededCancellation: "required";
  dutyCycleCapPermille: number;
  maxReviewsPerWindow: number;
  maxReviewsPerPhase: number;
  maxReviewsPerWorkflow: number;
  reviewResourceAdmission: WorkflowResourceAdmission;
  dedicatedReviewReserve: WorkflowResourceVector;
  plannerVerifierReserve: WorkflowResourceVector;
  dedicatedReviewReserveLedgerRefs: readonly WorkflowArtifactRef[];
  plannerVerifierReserveLedgerRefs: readonly WorkflowArtifactRef[];
  reserveVectorsAreLedgerProjections: true;
  budgetDigest: string;
}

type WorkflowImprovementProducer =
  | "durable"
  | "native"
  | "autoresearch"
  | "knowledge";
type WorkflowImprovementProposalStatus =
  | "queued"
  | "reviewing"
  | "proposed"
  | "rejected"
  | "approved"
  | "rolled_back"
  | "superseded";

interface WorkflowImprovementProposal {
  proposalId: string;
  producer: WorkflowImprovementProducer;
  kind: "workflow" | "methodology" | "policy" | "evaluator" | "knowledge";
  baselineRevisionId: string;
  baselineRevisionDigest: string;
  candidateRef: WorkflowArtifactRef;
  candidateDigest: string;
  scorecardRef: WorkflowArtifactRef;
  scorecardDigest: string;
  evaluatorRef: WorkflowArtifactRef;
  parserRef: WorkflowArtifactRef;
  baselineEvidenceRefs: readonly WorkflowArtifactRef[];
  candidateEvidenceRefs: readonly WorkflowArtifactRef[];
  queueState: "pending" | "active" | "superseded" | "cancelled";
  queueRevision: number;
  attemptId: string | null;
  reviewLeaseRef: WorkflowLeaseRef | null;
  ownershipLeaseRef: WorkflowLeaseRef | null;
  epochRef: WorkflowEpochRef;
  executionKey: string;
  status: WorkflowImprovementProposalStatus;
  proposalDigest: string;
}

interface WorkflowImprovementReview {
  reviewId: string;
  proposalRef: WorkflowArtifactRef;
  immutableSnapshotRef: WorkflowArtifactRef;
  baselineEvidenceRefs: readonly WorkflowArtifactRef[];
  candidateEvidenceRefs: readonly WorkflowArtifactRef[];
  verifierResultRef: WorkflowArtifactRef;
  goodhartResultRef: WorkflowArtifactRef;
  regressionResultRef: WorkflowArtifactRef;
  safetyResultRef: WorkflowArtifactRef;
  queueState: "pending" | "active" | "passed" | "failed" | "superseded" | "cancelled";
  leaseRef: WorkflowLeaseRef;
  epochRef: WorkflowEpochRef;
  executionKey: string;
  status: "pending" | "active" | "passed" | "failed" | "superseded" | "cancelled";
  hostEvaluatorDigest: string;
  parserDigest: string;
  stageHoldoutCommitmentRefs: readonly WorkflowArtifactRef[];
  reviewDigest: string;
}

interface WorkflowImprovementResult {
  resultId: string;
  proposalRef: WorkflowArtifactRef;
  reviewRef: WorkflowArtifactRef;
  disposition: "promoted" | "rejected" | "rolled_back" | "empty";
  registryStateRef: WorkflowArtifactRef;
  expectedRegistryEpoch: number;
  appliedRegistryEpoch: number | null;
  rollbackOfRevisionId: string | null;
  rollbackEventSequence: number | null;
  casExecutionKey: string;
  reloadVerificationRef: WorkflowArtifactRef;
  futureLoadVerificationRef: WorkflowArtifactRef;
  resultDigest: string;
}

type WorkflowImprovementEventKind =
  | "proposal_queued"
  | "review_started"
  | "review_superseded"
  | "review_completed"
  | "result_promoted"
  | "result_rejected"
  | "result_rolled_back"
  | "result_fenced";

interface WorkflowImprovementEvent {
  eventSequence: number;
  kind: WorkflowImprovementEventKind;
  proposalRef: WorkflowArtifactRef;
  reviewRef: WorkflowArtifactRef | null;
  resultRef: WorkflowArtifactRef | null;
  queueState: "pending" | "active" | "superseded" | "cancelled";
  crashFenceState: "none" | "prepared" | "fenced" | "reconciled";
  registryEpoch: number;
  eventDigest: string;
}

type WorkflowRevisionRegistryStatus = "approved" | "superseded" | "revoked";
type WorkflowRevisionScope =
  | "session"
  | "workflow"
  | "knowledge"
  | "workspace"
  | "user"
  | "global";

interface WorkflowRevisionCompatibilityClosure {
  compatibleRevisionDigests: readonly string[];
  incompatibleRevisionDigests: readonly string[];
  requiredHostContractDigests: readonly string[];
  closureDigest: string;
}

interface WorkflowRevisionScopeBindingBase {
  scope: WorkflowRevisionScope;
  sessionDecisionRefs: readonly DurableDecisionRef[];
  knowledgeDecisionRefs: readonly DurableDecisionRef[];
  knowledgeDecisionRef: DurableDecisionRef | null;
  knowledgeEntryRef: WorkflowArtifactRef | null;
  knowledgeScope: "session" | "workflow" | null;
  scopeDigest: string;
}

type WorkflowRevisionScopeBinding =
  | (WorkflowRevisionScopeBindingBase & {
      scope: "session";
      sessionId: string;
      workflowId: string | null;
    })
  | (WorkflowRevisionScopeBindingBase & {
      scope: "workflow";
      sessionId: string;
      workflowId: string;
    })
  | (WorkflowRevisionScopeBindingBase & {
      scope: "knowledge";
      knowledgeScope: "session";
      knowledgeEntryRef: WorkflowArtifactRef;
      knowledgeDecisionRef: DurableDecisionRef;
      sessionId: string;
      workflowId: string | null;
    })
  | (WorkflowRevisionScopeBindingBase & {
      scope: "knowledge";
      knowledgeScope: "workflow";
      knowledgeEntryRef: WorkflowArtifactRef;
      knowledgeDecisionRef: DurableDecisionRef;
      sessionId: string;
      workflowId: string;
    })
  | (WorkflowRevisionScopeBindingBase & {
      scope: "workspace" | "user" | "global";
      sessionId: string | null;
      workflowId: string | null;
    });

interface WorkflowRevisionRegistryEntryBase {
  registryEntryId: string;
  revisionId: string;
  revisionDigest: string;
  pinnedArtifactRefs: readonly WorkflowArtifactRef[];
  compatibilityClosure: WorkflowRevisionCompatibilityClosure;
  status: WorkflowRevisionRegistryStatus;
  approvedDecisionRef: WorkflowDecisionRef;
  supersededByRevisionId: string | null;
  revocationEpoch: number | null;
  revocationEventSequence: number | null;
  rollbackOfRevisionId: string | null;
  rollbackEventSequence: number | null;
  rollbackCasExecutionKey: string | null;
  registryEpoch: number;
  registryCasExecutionKey: string;
  entryDigest: string;
}

type WorkflowRevisionRegistryEntry =
  | (WorkflowRevisionRegistryEntryBase & {
      revisionKind: "knowledge";
      scope: "knowledge";
      scopeBinding: WorkflowRevisionScopeBinding & { scope: "knowledge" };
    })
  | (WorkflowRevisionRegistryEntryBase & {
      revisionKind: Exclude<
        "workflow" | "methodology" | "policy" | "evaluator" | "knowledge",
        "knowledge"
      >;
      scope: Exclude<WorkflowRevisionScope, "knowledge">;
      scopeBinding: Exclude<WorkflowRevisionScopeBinding, { scope: "knowledge" }>;
    });

interface WorkflowRevisionRegistryState {
  registryEpoch: number;
  entries: readonly WorkflowRevisionRegistryEntry[];
  stateDigest: string;
}

interface WorkflowRevisionResolution {
  registryEntryRef: WorkflowArtifactRef;
  registryEntryId: string;
  registryEpoch: number;
  revisionKind: WorkflowRevisionRegistryEntry["revisionKind"];
  scope: WorkflowRevisionScope;
  scopeBinding: WorkflowRevisionScopeBinding;
  registryStatus: "approved";
  compatibilityClosureDigest: string;
  expectedRegistryEpoch: number;
  observedRegistryEpoch: number;
  revocationEpoch: number | null;
  revocationEventSequence: number | null;
  rollbackOfRevisionId: string | null;
  rollbackEventSequence: number | null;
  casExecutionKey: string;
  hostVerified: true;
  resolutionDigest: string;
}

type WorkflowEfficiencyRedTeamTrigger =
  | "scheduled_window"
  | "task_terminal"
  | "phase_transition"
  | "result_transition"
  | "lease_release"
  | "material_evidence_transition"
  | "incident"
  | "recovery_boundary"
  | "completion_gate";

interface WorkflowEfficiencyRedTeamSchedule {
  scheduleId: string;
  trustedClockSourceDigest: string;
  clockObservationRef: WorkflowArtifactRef;
  lastAdmittedWindowSequence: number;
  lastAdmittedWindowId: string | null;
  cadenceMilliseconds: number;
  majorTransitionTriggers: readonly WorkflowEfficiencyRedTeamTrigger[];
  maxReviewsPerWindow: 1;
  maxReviewsPerPhase: number;
  maxReviewsPerWorkflow: number;
  dutyCycleCapPermille: number;
  overlapPolicy: "reject";
  catchUpAfterRestart: "one";
  reviewResourceAdmission: WorkflowResourceAdmission;
  maxReviewWallMilliseconds: number;
  maxReviewTokens: number;
  maxReviewCostMicrounits: number;
  scheduleBoundsDigest: string;
  approvalDecisionRef: WorkflowDecisionRef;
  scheduleDigest: string;
}

interface WorkflowMonotonicClockObservation {
  clockSourceDigest: string;
  observedAt: string;
  monotonicMilliseconds: number;
  observationSequence: number;
  previousObservationSequence: number | null;
  previousMonotonicMilliseconds: number | null;
  observationDigest: string;
}

type WorkflowEfficiencyRedTeamEventKind =
  | "efficiency_red_team_scheduled"
  | "efficiency_red_team_snapshot_published"
  | "efficiency_red_team_started"
  | "efficiency_red_team_completed"
  | "efficiency_red_team_suggestion_recorded"
  | "efficiency_red_team_overlap_rejected"
  | "efficiency_red_team_catch_up_consumed"
  | "efficiency_red_team_failed";

interface WorkflowResourceEnvelope {
  envelopeId: string;
  resources: WorkflowResourceVector;
  canonicalPoolLedger: WorkflowCanonicalPoolLedger;
  canonicalPoolLedgerRef: WorkflowArtifactRef;
  controlPlaneReserve: WorkflowResourceVector;
  controlPartition: WorkflowControlPartition;
  workerPartition: WorkflowWorkerPartition;
  processSlots: number;
  childSessionSlots: number;
  candidateSlots: number;
  executionCeilings: WorkflowExecutionCeilings;
  providerQuotaSnapshotRef: WorkflowArtifactRef;
  authenticatedCapacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
  improvementReviewBudget: WorkflowImprovementReviewBudget;
  revisionRegistryRef: WorkflowArtifactRef;
  inventoryDigest: string;
  pricingDigest: string;
  terminationPolicyDigest: string;
  billingReconciliationPolicyDigest: string;
  egressPolicyDigest: string;
  validFrom: string;
  validUntil: string;
  approvalDecisionRef: WorkflowDecisionRef;
  efficiencyRedTeamSchedule: WorkflowEfficiencyRedTeamSchedule;
  envelopeDigest: string;
}

interface WorkflowCloudEnvelope extends WorkflowResourceEnvelope {
  envelopeId: string;
  provider: string;
  accountRef: string;
  region: string;
  validFrom: string;
  validUntil: string;
  resources: WorkflowResourceVector;
  credentialRef: string;
  egressPolicyDigest: string;
  providerSpendCapRef: string;
}

type DurableDecisionScope =
  | { kind: "workflow"; workflowId: string; rootSessionId: string }
  | { kind: "session"; rootSessionId: string };

type DurableDecisionKind =
  | "goal_binding"
  | "goal_transition"
  | "goal_contract"
  | "scorecard"
  | "resource_envelope"
  | "configuration_revision"
  | "profile_selection"
  | "plan"
  | "ownership"
  | "strategy_change"
  | "progress_acceptance"
  | "blocker"
  | "recovery"
  | "skill_gate"
  | "autoresearch_candidate"
  | "refinement"
  | "memory_write"
  | "completion"
  | "cancellation";

type WorkflowAuthorityCapability =
  | "observe_workflow"
  | "read_workspace"
  | "read_external_evidence"
  | "propose_transition"
  | "write_owned_paths"
  | "spawn_child"
  | "consume_resource_lease"
  | "invoke_host_effect"
  | "request_user_approval"
  | "apply_goal_projection"
  | "accept_progress"
  | "accept_completion"
  | "write_canonical_knowledge";

type DurableDecisionStage =
  | "recon"
  | "lens"
  | "verification"
  | "synthesis"
  | "red_team";

type DurableStageVerdictDisposition =
  | "accepted"
  | "rejected"
  | "inconclusive";

interface DurableStageIndependence {
  freshContext: true;
  distinctSessionIdentity: true;
  distinctExecutionIdentity: true;
  sharedConversation: false;
  sharedMutableOutput: false;
  inputStateDigest: string;
  charterDigest: string;
  limitationRefs: readonly WorkflowArtifactRef[];
}

interface DurableStageVerdict {
  decisionId: string;
  decisionRevision: number;
  stage: DurableDecisionStage;
  stageId: string;
  disposition: DurableStageVerdictDisposition;
  sessionId: string;
  executionIdentity: string;
  storeEpoch: number;
  coordinatorEpoch: number;
  inputStateDigest: string;
  evidenceDigest: string;
  artifactRefs: readonly WorkflowArtifactRef[];
  independence: DurableStageIndependence;
}

type DurableMateriality = "routine" | "material" | "consequential";

type DurableEffectClass =
  | "read_only"
  | "owned_reversible_local_write"
  | "public_interface"
  | "test_or_evaluator"
  | "dependency_or_lockfile"
  | "configuration"
  | "goal_contract_or_scorecard"
  | "authority_or_resource"
  | "git_or_publication"
  | "external_side_effect"
  | "destructive_or_irreversible"
  | "unknown";

interface DurableHostDecisionClassification {
  classifier: "host";
  rulesetDigest: string;
  effectClasses: readonly DurableEffectClass[];
  normalizedReadSet: readonly string[];
  normalizedWriteSet: readonly string[];
  derivedMateriality: DurableMateriality;
  requiresUserApproval: boolean;
  reasonCodes: readonly string[];
  classifiedTargetDigest: string;
  classifiedEffectDigest: string;
}

interface DurableDecisionRecord {
  decisionScope: DurableDecisionScope;
  decisionId: string;
  revision: number;
  parentDecisionIds: readonly string[];
  kind: DurableDecisionKind;
  hostClassification: DurableHostDecisionClassification;
  storeEpoch: number;
  coordinatorEpoch: number;
  targetDigest: string;
  effectDigest: string;
  preconditionDigest: string;
  authority: readonly WorkflowAuthorityCapability[];
  expiresAt: string;
  objectiveDigest: string;
  contractDigest: string;
  scorecardDigest: string;
  planDigest: string;
  workspaceDigest: string;
  evidenceDigest: string;
  readSet: readonly string[];
  writeSet: readonly string[];
  attemptToken: string;
  nonce: string;
  executionKey: string;
  proposerSessionId: string;
  lensSessionIds: readonly string[];
  verifierSessionId: string;
  synthesizerSessionId: string;
  redTeamSessionId: string;
  stageVerdicts: readonly DurableStageVerdict[];
  artifactRefs: readonly WorkflowArtifactRef[];
  disposition:
    | "proposed"
    | "rejected"
    | "awaiting_user"
    | "authorized"
    | "applied"
    | "stale"
    | "conflicted";
}

type WorkflowDecisionRecord = DurableDecisionRecord & {
  decisionScope: {
    kind: "workflow";
    workflowId: string;
    rootSessionId: string;
  };
};

interface DurableDecisionRef {
  decisionScope: DurableDecisionScope;
  decisionId: string;
  revision: number;
  storeEpoch: number;
  decisionDigest: string;
}

type WorkflowDecisionRef = DurableDecisionRef & {
  decisionScope: {
    kind: "workflow";
    workflowId: string;
    rootSessionId: string;
  };
  coordinatorEpoch: number;
};

interface ContinuityCapsule {
  workflowId: string;
  sourceJournalSequence: number;
  sourceJournalDigest: string;
  sourceConfigDigest: string;
  workspaceDigest: string;
  goalContractRevision: number;
  scorecardRevision: number;
  executionProfile: "unresolved" | "inline" | "parallel";
  phase: WorkflowPhaseId;
  provenRequirementIds: readonly string[];
  unprovenRequirementIds: readonly string[];
  regressedRequirementIds: readonly string[];
  acceptedEvidenceRefs: readonly WorkflowArtifactRef[];
  planRevision: number;
  readyTaskIds: readonly string[];
  ownershipLeaseRefs: readonly WorkflowLeaseRef[];
  resourceLeaseRefs: readonly WorkflowLeaseRef[];
  failedStrategies: readonly string[];
  unresolvedDecisionRefs: readonly WorkflowDecisionRef[];
  continuationEntryPoint: string;
}

type WorkflowMetricDirection = "maximize" | "minimize" | "target";

type WorkflowRepeatabilityPolicy =
  | {
      kind: "single";
      hostDeterminismAttestationRef: WorkflowArtifactRef;
      deterministicInputClosureDigest: string;
      allowedVariance: 0;
    }
  | {
      kind: "repeated";
      runs: number;
      aggregation: "median" | "mean";
      maxVariance: number;
    }
  | {
      kind: "held_out";
      runs: number;
      heldOutInputDigest: string;
      aggregation: "median" | "mean";
      maxVariance: number;
    };

interface WorkflowScorecardMetric {
  metricId: string;
  direction: WorkflowMetricDirection;
  baseline: number | null;
  target: number;
  tolerance: number;
  parserDigest: string;
  measurementCommandDigest: string;
  evaluatorDigest: string;
  repeatability: WorkflowRepeatabilityPolicy;
}

interface WorkflowScorecardAcceptanceCheck {
  checkId: string;
  description: string;
  evaluatorDigest: string;
  requiredEvidenceKinds: readonly string[];
  freshnessMilliseconds: number;
  reproducibilityDigest: string;
}

interface WorkflowScorecardInvariant {
  invariantId: string;
  description: string;
  evaluatorDigest: string;
  falsificationArtifactRefs: readonly WorkflowArtifactRef[];
}

interface WorkflowScorecard {
  scorecardId: string;
  revision: number;
  metrics: readonly WorkflowScorecardMetric[];
  acceptanceChecks: readonly WorkflowScorecardAcceptanceCheck[];
  protectedInvariants: readonly WorkflowScorecardInvariant[];
  guardMetricIds: readonly string[];
  resourceConstraintDigest: string;
  proxyAttackArtifactRefs: readonly WorkflowArtifactRef[];
  evidenceRuleDigest: string;
  scorecardDigest: string;
}

interface WorkflowGoalRequirement {
  requirementId: string;
  outcome: string;
  acceptanceCheckIds: readonly string[];
  requiredEvidenceKinds: readonly string[];
  adversarialTestArtifactRefs: readonly WorkflowArtifactRef[];
}

interface WorkflowGoalContract {
  goalId: string;
  revision: number;
  originalObjective: string;
  requirements: readonly WorkflowGoalRequirement[];
  constraints: readonly string[];
  nonGoals: readonly string[];
  authorityCapabilities: readonly WorkflowAuthorityCapability[];
  contractDigest: string;
}

type WorkflowTaskStatus =
  | "pending"
  | "ready"
  | "admitted"
  | "running"
  | "awaiting_audit"
  | "accepted"
  | "needs_fix"
  | "blocked"
  | "cancelled";

interface WorkflowTask {
  taskId: string;
  planRevision: number;
  objective: string;
  requirementIds: readonly string[];
  completionCriteria: readonly string[];
  dependencyTaskIds: readonly string[];
  ownedPaths: readonly string[];
  ownedContracts: readonly string[];
  requiredSkillSnapshotDigests: readonly string[];
  verificationCommandDigests: readonly string[];
  authority: readonly WorkflowAuthorityCapability[];
  declaredResourceVector: WorkflowResourceVector;
  declaredControlCapacity: WorkflowControlCapacityVector;
  taskValueCertificateRef: WorkflowArtifactRef;
  status: WorkflowTaskStatus;
  attemptIds: readonly string[];
}

interface WorkflowTaskGrant {
  taskId: string;
  attemptId: string;
  resourceLeaseRef: WorkflowLeaseRef;
  ownershipLeaseRef: WorkflowLeaseRef;
  resourceAdmission: WorkflowResourceAdmission;
  capacityGrant: WorkflowCapacityGrant;
  controlCapacity: WorkflowControlCapacityVector;
  controlCapacityProjectionDigest: string;
  taskValueCertificateRef: WorkflowArtifactRef;
  grantDigest: string;
}

type WorkflowRequirementProgressStatus = "unproven" | "proven" | "regressed";

interface WorkflowProgressEntry {
  requirementId: string;
  status: WorkflowRequirementProgressStatus;
  evidenceRefs: readonly WorkflowArtifactRef[];
  workspaceDigest: string;
  auditorDecisionRef: WorkflowDecisionRef;
  observedAt: string;
  invalidatedByDecisionId: string | null;
}

interface WorkflowProgressLedger {
  contractRevision: number;
  entries: readonly WorkflowProgressEntry[];
  progressDigest: string;
}

type WorkflowLeaseStatus =
  | "reserved"
  | "active"
  | "release_pending"
  | "released"
  | "quarantined"
  | "expired";

interface WorkflowEpochRef {
  storeEpoch: number;
  coordinatorEpoch: number;
}

interface WorkflowLeaseRef extends WorkflowEpochRef {
  leaseId: string;
  acquisitionEventSequence: number;
}

interface WorkflowResourceLease {
  leaseId: string;
  workflowId: string;
  taskId: string | null;
  attemptId: string | null;
  holderIdentity: string;
  resourceAdmission: WorkflowResourceAdmission;
  capacityGrant: WorkflowCapacityGrant;
  controlCapacity: WorkflowControlCapacityVector;
  controlCapacityProjectionDigest: string;
  status: WorkflowLeaseStatus;
  storeEpoch: number;
  coordinatorEpoch: number;
  acquisitionEventSequence: number;
  idempotencyKey: string;
  expiresAt: string;
  releaseEventSequence: number | null;
}

interface WorkflowOwnershipLease {
  leaseId: string;
  workflowId: string;
  taskId: string;
  attemptId: string;
  ownedPaths: readonly string[];
  ownedContracts: readonly string[];
  status: WorkflowLeaseStatus;
  storeEpoch: number;
  coordinatorEpoch: number;
  acquisitionEventSequence: number;
  releaseEventSequence: number | null;
}

type WorkflowChildCapability =
  | "read_only"
  | "shell"
  | "ipython"
  | "edit"
  | "recursive_spawn";

type WorkflowChildWriteClass = "read_only" | "write_capable";

interface WorkflowChildAuthority {
  capabilities: readonly WorkflowChildCapability[];
  writeClass: WorkflowChildWriteClass;
  parentAttemptId: string | null;
  rootSpawned: boolean;
}

interface WorkflowChildIdentity {
  admissionId: string;
  childSessionId: string;
  processGroupId: string;
  executionKey: string;
  epochRef: WorkflowEpochRef;
  runtimeVersion: string;
  hostCapabilityRevision: string;
  agentRole: string;
  modelId: string;
  reasoningEffort: string;
  launchConfigDigest: string;
  identityDigest: string;
}

interface WorkflowApprovalOption {
  optionId: string;
  label: string;
  effectDigest: string;
}

type WorkflowTrustedPrincipalKind =
  | "interactive_ui"
  | "workflow_command"
  | "headless_signer";

interface WorkflowTrustedPrincipal {
  kind: WorkflowTrustedPrincipalKind;
  principalId: string;
  credentialDigest: string;
}

interface DurableSignedApprovalArtifact {
  kind: "signed_headless";
  approvalRequestId: string;
  decisionRef: DurableDecisionRef;
  optionId: string;
  principal: WorkflowTrustedPrincipal;
  storeEpoch: number;
  clientSessionId: string;
  responseSequence: number;
  signedRequestDigest: string;
  keyId: string;
  signatureAlgorithm: "ed25519";
  signature: string;
}

interface WorkflowSignedApprovalArtifact extends DurableSignedApprovalArtifact {
  workflowId: string;
  decisionRef: WorkflowDecisionRef;
  coordinatorEpoch: number;
}

interface DurableApprovalSecretProof {
  oneUseSecret: string; // transport-only; never written to the journal
  bindingDigest: string;
  bindingDigestAlgorithm: "sha256";
}

interface DurableApprovalRequest {
  approvalRequestId: string;
  decisionRef: DurableDecisionRef;
  stateDigest: string;
  storeEpoch: number;
  tokenHash: string;
  tokenHashAlgorithm: "sha256";
  trustedPrincipal: WorkflowTrustedPrincipal;
  requestingClientSessionId: string;
  expectedResponseSequence: number;
  expiresAt: string;
  question: string;
  options: readonly WorkflowApprovalOption[];
}

interface WorkflowApprovalRequest extends DurableApprovalRequest {
  workflowId: string;
  decisionRef: WorkflowDecisionRef;
  coordinatorEpoch: number;
}

interface DurableApprovalResponseBase {
  approvalRequestId: string;
  decisionRef: DurableDecisionRef;
  storeEpoch: number;
  clientSessionId: string;
  trustedPrincipal: WorkflowTrustedPrincipal;
  responseSequence: number;
  optionId: string;
}

type DurableApprovalResponse = DurableApprovalResponseBase &
  (
    | {
        mode: "interactive_secret";
        secretProof: DurableApprovalSecretProof;
        signedHeadlessArtifact?: never;
      }
    | {
        mode: "signed_headless";
        secretProof?: never;
        signedHeadlessArtifact: DurableSignedApprovalArtifact;
      }
  );

interface WorkflowApprovalResponseBase extends DurableApprovalResponseBase {
  workflowId: string;
  decisionRef: WorkflowDecisionRef;
  coordinatorEpoch: number;
}

type WorkflowApprovalResponse = WorkflowApprovalResponseBase &
  (
    | {
        mode: "interactive_secret";
        secretProof: DurableApprovalSecretProof;
        signedHeadlessArtifact?: never;
      }
    | {
        mode: "signed_headless";
        secretProof?: never;
        signedHeadlessArtifact: WorkflowSignedApprovalArtifact;
      }
  );

type WorkflowAttemptStatus =
  | "admitted"
  | "starting"
  | "running"
  | "awaiting_audit"
  | "reconciling"
  | "completed"
  | "needs_fix"
  | "blocked"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "quarantined";

type WorkflowBlockerAlternativeDisposition =
  | "failed_with_evidence"
  | "unsafe"
  | "outside_authority"
  | "external_state_unavailable";

interface WorkflowBlockerAlternativeResult {
  alternativeId: string;
  strategyDigest: string;
  disposition: WorkflowBlockerAlternativeDisposition;
  attemptedStateDigest: string;
  evidenceRefs: readonly WorkflowArtifactRef[];
}

interface WorkflowBlockerClaim {
  dependencyId: string;
  conditionDigest: string;
  requiredChange: string;
  registeredAlternativeSetDigest: string;
  alternativeResults: readonly WorkflowBlockerAlternativeResult[];
  evidenceRefs: readonly WorkflowArtifactRef[];
}

interface WorkflowBlockerRecord extends WorkflowBlockerClaim {
  blockerId: string;
  workflowId: string;
  firstObservedGoalTurnId: string;
  lastObservedGoalTurnId: string;
  consecutiveGoalTurnCount: number;
  observedGoalTurnIds: readonly string[];
  remainingSafeAlternativeIds: readonly string[];
  auditDecisionRefs: readonly WorkflowDecisionRef[];
  disposition: "claimed" | "rejected" | "awaiting_user" | "confirmed";
}

interface WorkflowPhaseOutcomeBase {
  workflowId: string;
  phaseAttemptId: string;
  epochRef: WorkflowEpochRef;
  invocationToken: string;
  inputStateDigest: string;
}

type WorkflowPhaseOutcome =
  | (WorkflowPhaseOutcomeBase & {
      status: "complete";
      outputStateDigest: string;
      artifactRefs: readonly WorkflowArtifactRef[];
      evidenceRefs: readonly WorkflowArtifactRef[];
    })
  | (WorkflowPhaseOutcomeBase & {
      status: "pause";
      approvalRequestId: string;
      artifactRefs: readonly WorkflowArtifactRef[];
      evidenceRefs: readonly WorkflowArtifactRef[];
    })
  | (WorkflowPhaseOutcomeBase & {
      status: "blocked";
      blockerClaim: WorkflowBlockerClaim;
    })
  | (WorkflowPhaseOutcomeBase & {
      status: "failed";
      errorCode: string;
      retryable: boolean;
      artifactRefs: readonly WorkflowArtifactRef[];
      evidenceRefs: readonly WorkflowArtifactRef[];
    });

interface WorkflowAttemptLifecycle {
  workflowId: string;
  taskId: string;
  attemptId: string;
  status: WorkflowAttemptStatus;
  childIdentity: WorkflowChildIdentity | null;
  childAuthority: WorkflowChildAuthority;
  admissionEventSequence: number;
  terminalEventSequence: number | null;
  epochRef: WorkflowEpochRef;
  statusDigest: string;
}

```

The attempt status transition matrix is closed and idempotent:

| Current attempt status | Allowed next status | Required evidence |
| --- | --- | --- |
| `admitted` | `starting`, `cancelled`, `quarantined` | Admission identity and durable lease |
| `starting` | `running`, `failed`, `interrupted`, `cancelled`, `quarantined` | Child identity or a reconciliation finding |
| `running` | `awaiting_audit`, `failed`, `interrupted`, `cancelled`, `reconciling` | Structured outcome, observed termination, fence, or uncertainty |
| `awaiting_audit` | `completed`, `needs_fix`, `blocked`, `reconciling`, `cancelled` | Independent progress-audit decision or recovery finding |
| `reconciling` | `running`, `completed`, `needs_fix`, `blocked`, `interrupted`, `quarantined`, `cancelled` | Current child/workspace/external identity evidence |
| `completed` | none | Terminal; projection only |
| `needs_fix` | none | Terminal for this attempt; a bounded retry creates a new attempt ID |
| `blocked` | none | Terminal for this attempt; an audited safe alternative creates a new attempt ID |
| `failed` | `reconciling`, `cancelled` | Recovery finding for an uncertain failure or explicit cancel; a retry creates a new attempt ID |
| `interrupted` | `reconciling`, `cancelled` | Reconciliation result or explicit cancel; proven non-execution may authorize a new attempt ID |
| `cancelled` | none | Terminal after descendant reconciliation |
| `quarantined` | `reconciling`, `cancelled` | Explicit recovery disposition |

An attempt status cannot be advanced by a child transcript, child-registry
presence, or a repeated terminal report alone. The host compares the expected
status, store epoch, coordinator epoch, and status digest by CAS, so retries
return the existing status rather than creating a second transition.

```typescript
interface WorkflowPhaseOutcomeRecord {
  outcome: WorkflowPhaseOutcome;
  attemptStatus: WorkflowAttemptStatus;
}

interface WorkflowRequirementEvidence {
  evidenceId: string;
  requirementId: string;
  claim: string;
  result: string;
  method: string;
  artifactRefs: readonly WorkflowArtifactRef[];
  confidence: "high" | "medium" | "low";
  limitations: readonly string[];
  workspaceDigest: string;
  observedAt: string;
}

interface WorkflowEscalationRequest {
  reason: string;
  materialChangeKinds: readonly string[];
  evidenceRefs: readonly WorkflowArtifactRef[];
  requestedDecision: string;
}

interface WorkflowAttemptHandoff {
  taskId: string;
  attemptId: string;
  outcome: "completed" | "needs_fix" | "blocked" | "interrupted";
  planRevision: number;
  goalContractRevision: number;
  ownedPaths: readonly string[];
  ownedContracts: readonly string[];
  upstreamDecisionRefs: readonly WorkflowArtifactRef[];
  interfaceAndDependencyRefs: readonly WorkflowArtifactRef[];
  recommendation: string;
  rationale: string;
  preservedInvariants: readonly string[];
  pitfalls: readonly string[];
  requirementEvidence: readonly WorkflowRequirementEvidence[];
  verificationEvidenceRefs: readonly WorkflowArtifactRef[];
  unresolvedIssues: readonly string[];
  failedApproaches: readonly string[];
  escalation: WorkflowEscalationRequest | null;
  preWorkspaceDigest: string;
  postWorkspaceDigest: string;
}

interface WorkflowReconciliationOutcome {
  workflowId: string;
  reconciliationAttemptId: string;
  taskId: string;
  attemptId: string;
  disposition:
    | "reattached"
    | "still_running"
    | "completed"
    | "proven_not_executed"
    | "corrective_work_required"
    | "user_input_required"
    | "failed";
  persistedChildIdentity: WorkflowChildIdentity | null;
  observedChildIdentity: WorkflowChildIdentity | null;
  observedProcessGroupId: string | null;
  observedTranscriptDigest: string | null;
  observedWorkspaceDigest: string;
  epochRef: WorkflowEpochRef;
  evidenceRefs: readonly WorkflowArtifactRef[];
  stateDigest: string;
}

interface WorkflowSpecializationProjection {
  kind: "native_methodology" | "autoresearch";
  contractVersion: string;
  phaseTag: string;
  statusTag?: string;
  sourceJournalSequence: number;
  sourceJournalDigest: string;
  payloadRef: WorkflowArtifactRef;
}

interface WorkflowKnowledgeCommitRef {
  knowledgeStoreId: string;
  workflowEpochRef: WorkflowEpochRef;
  knowledgeStoreEpoch: number;
  proposalId: string;
  decisionRef: DurableDecisionRef;
  knowledgeJournalSequence: number;
  knowledgeJournalDigest: string;
  transactionDigest: string;
}
```

There is exactly one workflow reducer and one authoritative `WorkflowStatus` /
`WorkflowPhaseId` state machine. Native-methodology and AutoResearch phase or
status names are tagged domain projections carried by
`WorkflowSpecializationProjection`; they cannot transition scheduling, goal
binding, approval, recovery, or completion independently. A specialization event
is appended through the generic coordinator, and the generic reducer validates
its declared mapping before exposing the projection. Unknown tags remain
inspectable but cannot advance state.

The durable decision primitive is also available to an explicit, ordinary
session refinement or knowledge operation without silently starting a workflow.
Such a record uses `decisionScope.kind = "session"`, has the same finite
recon/lens/verify/synthesize/red-team/host gate, and cannot dispatch workflow
tasks, consume a workflow resource envelope, mutate a workflow-owned goal, or
claim workflow completion. Every workflow decision uses the narrower
`WorkflowDecisionRecord` scope and active coordinator epoch.

The same host-owned durable-store substrate implements canonical encoding,
authenticated append, store leases/fencing, immutable artifacts, prepared/commit
transactions, CAS, idempotency, replay, and corruption quarantine for both the
workflow journal and the cross-session knowledge ledger. They remain separate
store instances because their retention and scope differ, but they do not
duplicate append/transaction/fencing machinery. One generic reducer implementation
consumes the versioned event stream for each store instance and emits typed
projections; the workflow instance supplies the workflow state machine and the
knowledge instance supplies its ledger projection, but neither adds a second
reducer or coordinator. Only the workflow projection owns planning, workers,
resources, goal transitions, recovery orchestration, and completion.
Compatibility files, v2 experiment files, HarnessState, index outbox, and UI
snapshots are projections, never additional coordinators or authorities.

Every child identity, phase outcome, approval response, specialization grant,
lease reference, and cross-store commit reference carries or dereferences one
canonical `WorkflowEpochRef`. Before accepting it, the host resolves every
`WorkflowLeaseRef` against the authoritative lease, verifies matching store and
coordinator epochs plus acquisition sequence, and compare-and-swaps the current
store/coordinator epoch. A bare ID, missing epoch, stale dereference, or mixed
epoch set is rejected before append or effect; specialization payloads cannot
substitute their own fencing fields.

A workflow-bound knowledge mutation first commits a workflow intent containing
the proposal/decision digest, then the separate knowledge-store transaction
commits, and finally the workflow journal records a
`WorkflowKnowledgeCommitRef`. A crash between stores enters reconciliation;
neither store is rewritten to pretend cross-file atomicity. An orphan knowledge
commit remains canonical only within its approved decision scope and cannot
count as workflow progress until the exact reference is bound.

The shared durable-store primitive is parameterized by store identity, epoch,
retention policy, event schema, and reducer projection. It owns canonical
encoding, authenticated writers, append leases, prepared/commit durability,
CAS, idempotency, replay, artifact publication, and corruption quarantine for
both separate store instances. A specialization may add fields to its payload
but may not fork these primitives or treat a projection as authority.

## Runtime configuration and generated projections

Workflow configuration follows four ownership layers:

1. immutable package defaults and built-in manifests;
2. user-owned global and project settings, with existing project-over-global
   precedence;
3. one content-addressed resolved-config snapshot pinned to a workflow; and
4. generated session projections such as continuity capsules, worker briefs,
   progress views, and resolved role prompts.

Only layer 2 is mutable configuration. Generated files are disposable views and
never become settings or journal authority. The workflow configuration schema is
versioned independently from the workflow journal format, native methodology
contract, skill content, and daemon protocol.

```typescript
interface WorkflowRuntimeConfigSnapshot {
  configSchemaVersion: number;
  configRevision: number;
  runtimeIdentityDigest: string;
  repositoryPolicyDigest: string;
  workspaceIdentityDigest: string;
  globalSettingsDigest: string;
  projectSettingsDigest: string;
  packageDefaultsDigest: string;
  methodologyManifestDigests: readonly string[];
  nativeMethodologyContractDigest: string;
  skillContentDigests: readonly string[];
  skillDependencyDigests: readonly string[];
  evaluatorDigests: readonly string[];
  parserDigests: readonly string[];
  guardDigests: readonly string[];
  scorecardRuleDigest: string;
  resourceInventoryDigest: string;
  resourceEnvelopePolicyDigest: string;
  egressPolicyDigest: string;
  authorityPolicyDigest: string;
  approvalPolicyDigest: string;
  provenanceManifestDigest: string;
  daemonCapabilityDigest: string;
  executionProfile: "inline" | "parallel";
  decisionLimitsDigest: string;
  schedulerPolicyDigest: string;
  journalFormatDigest: string;
  closureManifestRef: WorkflowArtifactRef;
  closureManifestDigest: string;
  resolvedConfigDigest: string;
}
```

The closure manifest enumerates every immutable runtime, repository policy,
workspace identity, skill/dependency, evaluator/parser/guard, resource,
egress, authority, approval, provenance, and protocol-capability input used to
resolve the snapshot. `resolvedConfigDigest` covers that manifest and every
field above; an omitted or changed closure member invalidates the snapshot
rather than inheriting ambient process state.

Persistent settings migrate only through ordered, pure `N -> N + 1` functions.
Additive defaults do not rewrite a settings file merely because it was read;
unknown newer schemas are rejected. A mutation first produces an exact plan of
owned keys and projections, verifies current digests and drift, records a
recoverable backup and prepared transaction, atomically replaces and flushes
changed files, reloads and verifies the result, then commits or compensates.
Unrelated and unknown user keys, original file mode, and platform-appropriate
metadata are preserved. Symlinks, canonical/legacy path conflicts, unsafe
ownership changes, and ambiguous paths are rejected. Parsing and migration use
typed JSON structures, never textual or regular-expression rewriting. The
backup has a digest manifest and recovery state, not merely a timestamped copy.
Generated projections carry the source config/journal digest and are
regenerated rather than semantically merged when stale. `resolvedConfigDigest`
is the canonical digest of every field in `WorkflowRuntimeConfigSnapshot`,
including all listed settings, manifests, skills and dependencies, evaluators,
parsers, guards, policies, profile, journal format, and capability closure; it
is not a digest of only user settings or a selected subset. Any changed closure
member invalidates the pinned snapshot and every decision or evidence artifact
that names it.

An active workflow remains pinned to its complete resolved-config closure,
including skill content/dependencies, manifests, evaluators, parsers, guards,
policies, journal format, and capability digests. A newly installed default or settings edit affects new
workflows only unless the running workflow accepts an explicit configuration
revision through the universal decision gate; changes to execution profile,
authority, limits, evaluator, or methodology contract also require exact user
approval. Runtime configuration migrations and vendor-snapshot upgrades are
separate transactions. The first release has no second updater, background
network mutation, or project-entry-point generator.

## Universal Decision Gate

Models propose; they never authorize. Each state-changing or trust-advancing
proposal is stored as a typed decision record. `DurableDecisionKind` and
`WorkflowAuthorityCapability` are closed unions: an unknown kind or capability
is rejected, never treated as an opaque string or implicitly broadened. Each
decision and each stage verdict is bound to both the durable-store epoch and
the coordinator fencing epoch. A stage verdict is persisted only after its
fresh-context identity, input digest, charter, artifact references, and
declared independence limitations have been verified; the host requires one
current verdict for each required stage before adjudication.

Each state-changing or trust-advancing proposal contains:

- workflow and decision IDs, monotonic revision, and parent decision IDs;
- decision kind and the host-derived materiality/effect classification;
- exact target, effect, preconditions, authority, and expiry;
- original-objective, contract, scorecard, plan, workspace, and evidence digests;
- declared read and write sets;
- host-issued attempt token, nonce, and one-time execution key; and
- the proposer, verifier, synthesizer, and red-team session identities plus their artifact digests.

The finite decision protocol is:

1. The host classifies the operation using deterministic policy.
2. A fresh proposer produces a non-authorizing proposal.
3. Recon and independent lenses gather and challenge the relevant evidence.
4. A fresh verifier checks factual claims against exact current evidence.
5. A fresh synthesizer produces the exact transition proposal.
6. A fresh adversarial context challenges that transition.
7. The host validates provenance, digests, closed authority capabilities, ownership, both epochs, one-time execution key, and policy predicates.
8. The host applies the approved transition by compare-and-swap, requests exact user approval, or records rejection.

Caller-supplied materiality is ignored. The host derives normalized read/write
sets and `DurableEffectClass` values from the typed operation, proposed diff,
current contracts, authority, and effect broker before any decision stage runs.
Only a fully known, locally reversible write confined to already owned paths may
be `routine`. Public interfaces, tests/evaluators/fixtures, dependencies,
configuration, contracts/scorecards, authority/resources, Git/publication,
external effects, destructive effects, and unknown effects are at least
`material`; external, publication, destructive, irreversible, or unknown effects
are `consequential`. Material and consequential classifications require exact
user approval unless a narrower unexpired policy explicitly names that effect;
unknown classification always fails closed and requires a new user decision.
The classification, ruleset, normalized sets, and approval predicate are part of
the decision digest. A proposer that labels the same effect differently cannot
change routing.

Verdicts are invalid if stale, forged, duplicated, expired, bound to another revision, or based on changed state. Model prose claiming approval is never authoritative. Concurrent disjoint decisions may commit; an overlapping write set or semantic merge conflict invalidates the losing revision and sends it through a new decision cycle.

Decision revision attempts are finite. Repeated revisions with the same plan, workspace, contract, and evidence digest cannot count as movement. On reaching the configured revision cap, the workflow asks the user for a material choice or submits an independently audited blocker proposal. This liveness rule applies to planning, reconciliation, verification fixes, AutoResearch admission, refinement, and memory writes.

The host owns a finite decision state machine. Each revision has fixed maximum stage count, model-call count, elapsed time, tokens, and resource reservation; findings and evidence cannot recursively open another pipeline unless they change the proposed target or effect. Exhaustion leaves authoritative state unchanged and transitions to `awaiting_user`, `budget_limited`, or an independently audited blocker path. A new revision cannot reset the workflow-level repeated-cycle counter when contract, workspace, plan, and evidence digests are unchanged.

The following are deterministic execution, not recursive decisions:

- journal append, fsync, digest calculation, schema validation, and replay;
- evaluation of already approved host predicates;
- exact application of an approved patch with unchanged digests;
- idempotent retry with the same execution key and proven prior non-execution;
- release of a known resource lease; and
- collection of immutable evidence without interpreting it.

Changing target, effect, scope, authority, precondition, scorecard, evaluator, ownership, or semantic merge always creates a new decision revision.

Material scope or contract changes, consequential external or destructive actions, publication, unresolved ambiguity, uncertain non-idempotent recovery, and resource-envelope expansion require explicit user approval bound to exact digests. A global learning write additionally requires either exact user approval for that write or an exact match to a separately user-approved, red-teamed, unexpired, unrevoked durable-learning policy whose ID and revision are bound to the decision. Concurrent state or policy changes invalidate approval.

## Hardened Goal Contract

Workflow start creates or binds the existing persistent goal. Before planning, a fresh proposer derives a hardened contract from the user objective; recon, lenses, evidence verification, synthesis, and a separate adversarial context then challenge it. The contract contains:

- immutable original objective;
- individually testable required outcomes;
- constraints and non-goals;
- evidence required for each outcome;
- adversarial tests intended to falsify completion;
- likely shortcut, proxy-metric, and false-positive paths;
- authority boundaries and conditions that require user input.

The host may accept clarifications or strengthening that the decision pipeline proves do not change the objective's meaning. If a proposed contract changes scope, removes an implied outcome, adds a consequential requirement, or changes meaning, the workflow persists the proposal and enters `awaiting_user` before planning.

The planner cannot weaken or delete a hardened requirement. Contract amendments require another red-team pass, and material amendments require user approval. The original objective remains visible to every auditor so a malformed contract cannot erase user intent.

The scorecard is downstream of this contract. Its metric and evaluator digests
must reference existing requirement IDs, and a scorecard proposal that adds,
removes, or changes a requirement is rejected as a goal-contract amendment and
sent back through goal hardening and its own approval gate.

## Typed Scorecard

After capacity discovery and goal-contract hardening, fresh contexts propose a
scorecard derived from the already accepted original objective and typed goal
requirements. Goal hardening therefore precedes scorecard derivation: a metric,
parser, evaluator, target, or guard may measure a requirement, but cannot create,
delete, narrow, or redefine the goal requirement it measures. It contains:

- zero or more numeric metrics with direction, baseline, target, parser, measurement command, tolerance, and repeatability policy;
- binary acceptance checks tied to user-visible outcomes;
- protected invariants that must never regress;
- guard metrics and resource/cost constraints;
- evidence freshness and reproducibility requirements; and
- known proxy, leakage, overfit, threshold-lowering, and scope-narrowing attacks.

Every workflow requires at least one acceptance check and one protected invariant. A numeric metric is required when the objective is genuinely quantitative. AutoResearch always requires exactly one primary numeric metric and target, with optional secondary guards.

A single measurement is admissible only with a current host-produced determinism
attestation covering the complete evaluator, dependency, input, environment, and
workspace closure and declaring zero allowed variance. Without that evidence, the
scorecard requires at least two baseline and candidate runs, a fixed aggregation,
and a finite variance bound; benchmark-leakage or overfit risk additionally
requires held-out input. The host rejects a favorable trial outside the approved
variance policy rather than selecting it.

The scorecard is verified, red-teamed, and user-approved before it can authorize progress. Changing a metric, target, parser, evaluator, guard, scope, invariant, or evidence rule creates a material decision revision and requires another red-team pass and user approval. Activity, utilization, token consumption, number of workers, number of commits, and model-authored percentages can never serve as outcome metrics by themselves.

## Capacity Discovery and Resource Envelope

Workflow preflight discovers observable local capacity:

- logical CPUs and current load;
- total and available RAM plus reserved headroom;
- accelerators, device memory, and supported runtimes;
- disk capacity and I/O pressure;
- network availability and declared egress restrictions;
- kernel, daemon, child-session, and provider admission limits; and
- other active workflow or repository contention visible to the runtime.

It then asks whether cloud capacity is available. If so, the user supplies or authorizes discovery of provider, account, region, instance/accelerator types and counts, model/API concurrency and rate limits, time window, spend ceiling, credentials boundary, and data-egress policy. Unknown quota, pricing, region, or authority is treated as zero capacity. Local implementation and development of this feature do not use cloud compute unless separately requested; this handshake is runtime product behavior.

The resulting envelope is a typed, user-approved, red-teamed decision. It reserves capacity for the planner, decision verifiers, red team, progress auditor, completion verifier, and recovery coordinator so worker saturation cannot deadlock the control plane.

Every phase attempt, agent, evaluator, command, and descendant process declares a
resource vector covering the pools it can consume, but that declaration is never
the reservation authority. The host derives a conservative vector from the typed
operation, executable/process tree, model/provider limits, historical high-water
evidence, workspace isolation, and platform enforcement. The reserved vector is
the per-pool maximum of the declared and host-derived bounds. Unknown or
unenforceable consumption selects `exclusive_unisolated`: it receives exclusive
access to the affected pools and serializes potentially conflicting work rather
than optimistically under-reserving. Before any side effect, the host atomically
records the complete `WorkflowResourceAdmission` in a durable resource lease. At
all times:

```text
running + reserved + control-plane reserve <= approved resource envelope
```

Retries, continuations, failed attempts, egress, API calls, tokens, and cloud runtime consume the same approved budgets. Uncertain reservations after a crash remain quarantined until reconciliation. Lease release is exactly once.

The scheduler's saturation objective is not 100 percent CPU or the maximum worker count. A workflow is saturated when no ready, ownership-compatible, authority-approved, independently valuable task fits the remaining safe resource envelope. The scheduler refills immediately when a lease is released, cancelled, or reconciled. Queue entries record the limiting resource pool and age.

Host telemetry records capacity and scheduling facts, not progress claims:

- utilization and reservation by pool;
- ready-fit queue age and idle reason;
- throttles, memory pressure, accelerator exhaustion, and I/O pressure;
- cost and rate-limit consumption;
- retry, duplicate-work, and reservation-leak counts; and
- accepted evidence produced per unit resource and cost.

No-op, sleep, duplicate, unrelated, or proxy-only tasks may not improve progress or scorecard evidence. If useful implementation work cannot safely fill a slot, the planner may dispatch non-duplicative recon, lens, refutation, or exploration work. It may not invent activity to claim saturation.

The `WorkflowCanonicalPoolLedger` is the one authoritative per-pool ledger across the entire workflow tree, including root, children, continuations, evaluator processes, retries, caches, API requests, egress, and control-plane work. Its instantaneous concurrency/token/byte/wall pools are separate from its cumulative spend pools; `controlPlaneReserve`, partition vectors, grants, and admission vectors are projections with the ledger digest, never additional reserve ledgers. The repeated `controlCapacity` fields on admission, leases, task grants, and allocation entries are normalized projections of their discriminated `WorkflowCapacityGrant` and must match its `controlCapacityProjectionDigest`; they are not independently spendable reserves. Every resource component and every hard control dimension appears exactly once in exhaustive component accounting. Provider/account usage remains reserved until reported billing and rate-limit state is reconciled; billing lag never becomes free capacity. Every approved envelope has finite `WorkflowExecutionCeilings`, including workflow wall time/tokens/model calls/task attempts/planner cycles plus per-requirement strategy and analysis quotas. The host proposes conservative local defaults when the user supplies none; omission never means infinity. Exhaustion produces `budget_limited` before another dispatch. Extension is a new red-teamed resource decision and explicit user approval, so distinct-looking recon or exploration cannot evade the cap.

## Adaptive Allocation and Continuous Improvement Contract

Adaptive allocation is a bounded workflow controller, not a second scheduler
or an unbounded resident agent. It runs only while the workflow has a durable
active goal and only from journal events or a host-observed capacity signal.
The host recomputes the observation after each task, phase, result, resource or
ownership lease release, and material evidence transition. It may also take a
bounded observation at a recovery, pause, budget, or completion boundary.

The observation joins independently verified outcome evidence with host
telemetry. Queue age, throughput, latency, lease pressure, and marginal
verified progress/resource identify where capacity might help; they do not
prove progress. A requirement remains `unproven` until the ordinary progress
auditor or verifier accepts current evidence. The controller prefers the
ready, ownership-compatible task on the verified critical path with the best
host-derived marginal requirement evidence per scarce resource, subject to
protected invariants, authority, dependency order, and control reserve. If
critical-path evidence is uncertain, it preserves the last safe allocation or
spends a bounded read-only verification/recon lease rather than treating
uncertainty as progress.

```typescript
type WorkflowAdaptiveBottleneckPool =
  | "dependency"
  | "ownership"
  | "authority"
  | "cpu"
  | "memory"
  | "disk"
  | "io"
  | "accelerator"
  | "provider"
  | "network"
  | "wall_time"
  | "monetary"
  | "control_plane"
  | "evidence"
  | "uncertain";

type WorkflowAdaptiveObjectiveOrder = readonly [
  "time_to_genuine_proof",
  "evidence_gap",
  "cost",
  "uncertainty",
  "queue_age",
  "task_id"
];

interface WorkflowRemainingWorkEstimate {
  taskId: string;
  requirementIds: readonly string[];
  acceptedDagDigest: string;
  remainingWorkMilliseconds: number;
  remainingWorkVector: WorkflowResourceVector;
  evidenceGapRequirementIds: readonly string[];
  hostObservationRef: WorkflowArtifactRef;
  observedAt: string;
  estimateSequence: number;
  estimateDigest: string;
}

interface WorkflowObservedTaskNovelty {
  taskId: string;
  candidateDigest: string;
  priorCandidateDigestRefs: readonly WorkflowArtifactRef[];
  duplicate: false;
  hostObservationRef: WorkflowArtifactRef;
  proofDigest: string;
}

interface WorkflowBoundedOutcomeEvidence {
  taskId: string;
  observableOutcomeRef: WorkflowArtifactRef;
  boundedOutcomeDescription: string;
  expectedEvidenceRefs: readonly WorkflowArtifactRef[];
  maximumWorkMilliseconds: number;
  maximumCostMicrounits: number;
  outcomeDigest: string;
}

interface WorkflowCriticalPathCertificate {
  certificateId: string;
  planRevision: number;
  taskGraphDigest: string;
  acceptedDagRef: WorkflowArtifactRef;
  remainingWorkEstimates: readonly WorkflowRemainingWorkEstimate[];
  hostObservedNoveltyProofRefs: readonly WorkflowArtifactRef[];
  independentAdmissionRef: WorkflowArtifactRef;
  independentCertificateAdmission: true;
  independentAdmissionStatus: "accepted";
  schedulerPolicyDigest: string;
  acceptedRequirementIds: readonly string[];
  unprovenRequirementIds: readonly string[];
  criticalPathTaskIds: readonly string[];
  objectiveOrder: WorkflowAdaptiveObjectiveOrder;
  proofDigest: string;
  certificateDigest: string;
}

interface WorkflowTaskValueCertificate {
  taskId: string;
  attemptId: string;
  requirementIds: readonly string[];
  evidenceGapRequirementIds: readonly string[];
  hostObservedNoveltyProof: WorkflowObservedTaskNovelty;
  boundedOutcomeEvidence: WorkflowBoundedOutcomeEvidence;
  explorationQuota: number;
  independentAdmissionRef: WorkflowArtifactRef;
  independentAdmissionStatus: "accepted";
  valuePolicyDigest: string;
  certificateDigest: string;
}

interface WorkflowAdaptiveFairnessPolicy {
  priorityBucketOrder: readonly string[];
  promotionEnabled: boolean;
  agingQuantumMilliseconds: number;
  starvationDeadlineMilliseconds: number;
  maxAgingBoost: number;
  maxPromotionBuckets: number;
  maxPromotionsPerWindow: number;
  explorationQuotaPerWindow: number;
  policyDigest: string;
}

interface WorkflowAdaptiveHysteresisPolicy {
  minimumWindowEvents: number;
  minimumWindowMilliseconds: number;
  benefitThreshold: number;
  minimumDwellMilliseconds: number;
  maxTransitionsPerWindow: number;
  policyDigest: string;
}

interface WorkflowAdaptiveFairnessState {
  taskLastServedAt: Readonly<Record<string, string>>;
  priorityBucketByTask: Readonly<Record<string, string>>;
  promotionCountByWindow: Readonly<Record<string, number>>;
  policy: WorkflowAdaptiveFairnessPolicy;
  agingPolicyDigest: string;
  explorationQuotaRemaining: number;
  explorationQuotaWindow: number;
  lastServedTaskId: string | null;
  fairnessDigest: string;
}

interface WorkflowAdaptiveReviewQueueState {
  pendingObservationRef: WorkflowArtifactRef | null;
  activeObservationRef: WorkflowArtifactRef | null;
  supersededObservationIds: readonly string[];
  cancellationDigest: string | null;
}

interface WorkflowLeaseReclaimDecision {
  leaseRef: WorkflowLeaseRef;
  expiredAt: string;
  nonExecutionEvidenceRefs: readonly WorkflowArtifactRef[];
  reclaimDeadline: string;
  disposition: "reclaimed" | "terminal_escalation";
  decisionRef: WorkflowDecisionRef;
  decisionDigest: string;
}

interface WorkflowAdaptiveObservation {
  observationId: string;
  sourceEventSequence: number;
  sourceJournalDigest: string;
  workflowId: string;
  goalContractDigest: string;
  scorecardDigest: string;
  revisionRegistryDigest: string;
  workspaceDigest: string;
  criticalPathCertificateRef: WorkflowArtifactRef;
  remainingWorkEstimates: readonly WorkflowRemainingWorkEstimate[];
  hostObservedNoveltyProofRefs: readonly WorkflowArtifactRef[];
  taskValueCertificateRefs: readonly WorkflowArtifactRef[];
  independentCertificateAdmissionRef: WorkflowArtifactRef;
  criticalPathTaskIds: readonly string[];
  readyQueueTaskIds: readonly string[];
  evidenceGapRequirementIds: readonly string[];
  blockerIds: readonly string[];
  throughputEvidenceRefs: readonly WorkflowArtifactRef[];
  latencyEvidenceRefs: readonly WorkflowArtifactRef[];
  marginalVerifiedProgressEvidenceRefs: readonly WorkflowArtifactRef[];
  uncertaintyEvidenceRefs: readonly WorkflowArtifactRef[];
  liveResourceLeaseRefs: readonly WorkflowLeaseRef[];
  liveOwnershipLeaseRefs: readonly WorkflowLeaseRef[];
  controlPlaneReserve: WorkflowResourceVector;
  controlPlaneReserveCapacity: WorkflowControlCapacityVector;
  observedCapacity: WorkflowResourceVector;
  observedControlCapacity: WorkflowControlCapacityVector;
  authenticatedCapacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
  limitingPool: WorkflowAdaptiveBottleneckPool;
  observedAt: string;
  observationDigest: string;
}

interface WorkflowAdaptiveAllocationEntry {
  taskId: string;
  attemptId: string;
  resourceLeaseRef: WorkflowLeaseRef;
  ownershipLeaseRef: WorkflowLeaseRef;
  slotState: "unclaimed" | "claimed" | "active";
  capacityGrant: WorkflowCapacityGrant;
  controlCapacity: WorkflowControlCapacityVector;
  controlCapacityProjectionDigest: string;
  attemptClass: "implementation" | "recon" | "lens" | "verification" | "red_team" | "recovery";
  resourceAdmission: WorkflowResourceAdmission;
  taskValueCertificate: WorkflowTaskValueCertificate;
  reason: WorkflowAdaptiveBottleneckPool;
  sourceObservationDigest: string;
}

interface WorkflowAdaptiveAllocationState {
  allocationRevision: number;
  acceptedObservation: WorkflowArtifactRef;
  allocationEntries: readonly WorkflowAdaptiveAllocationEntry[];
  limitingPool: WorkflowAdaptiveBottleneckPool;
  fairness: WorkflowAdaptiveFairnessState;
  reviewQueue: WorkflowAdaptiveReviewQueueState;
  hysteresisPolicy: WorkflowAdaptiveHysteresisPolicy;
  minimumWindowEvents: number;
  minimumWindowMilliseconds: number;
  benefitMetricDigest: string;
  benefitThreshold: number;
  minimumDwellMilliseconds: number;
  maxTransitionsPerWindow: number;
  transitionsInWindow: number;
  lastDecisionRef: WorkflowDecisionRef | null;
  safetyOverride: "none" | "active";
  cooldownUntil: string | null;
  rollbackAllocationRef: WorkflowArtifactRef | null;
  status: "stable" | "rebalancing" | "awaiting_user" | "quarantined";
  allocationDigest: string;
}

type WorkflowAdaptiveEventKind =
  | "adaptive_observation_recorded"
  | "adaptive_observation_coalesced"
  | "adaptive_review_superseded"
  | "adaptive_review_cancelled"
  | "adaptive_allocation_intent"
  | "adaptive_allocation_proposed"
  | "adaptive_allocation_applied"
  | "adaptive_allocation_reconciled"
  | "adaptive_allocation_rejected"
  | "adaptive_observation_rejected_stale"
  | "adaptive_allocation_rollback_intent"
  | "adaptive_allocation_rolled_back"
  | "adaptive_controller_recovered";
```

The host, rather than a worker or model, creates a reproducible
`WorkflowCriticalPathCertificate` from the accepted dependency DAG, typed
`WorkflowRemainingWorkEstimate` records, and scheduler-policy digest. Each
estimate carries its host observation, accepted-DAG digest, numeric remaining
work and resource vector, evidence gap, observation sequence, and digest;
host-observed novelty records prove that a candidate is not a duplicate. Its
lexicographic objective is exactly `time_to_genuine_proof`, then evidence gap,
cost, uncertainty, queue age, and finally task ID/digest as the deterministic
tie break. Independent host admission binds the certificate to the accepted
DAG and all estimates. A critical-path claim without this typed certificate,
or with a different graph/policy/estimate/novelty digest, is rejected. Every
dispatched or explored task also carries a host `WorkflowTaskValueCertificate`
mapping it to an unproven requirement/evidence gap, a typed novelty proof, a
typed bounded observable outcome with finite work/cost bounds, and a finite
exploration quota; utilization, model confidence, or a self-reported score
cannot substitute for that certificate.

Every observation binds authenticated capacity, usage, billing, and rate-limit
snapshot references with a monotonic observation sequence and `observedAt`/
`expiresAt` TTL. At allocation CAS, stale, expired, unauthenticated, or
unknown snapshots resolve to zero capacity/usage headroom (including provider
charges and rate limits), never to an optimistic estimate. The resource
envelope partitions processes, child sessions, model calls/tokens, and
recovery attempts into a hard control partition and a worker partition; no
worker may borrow control capacity. An `exclusive_unisolated` worker is
isolated from and serialized against the control plane by the host broker.
`WorkflowControlCapacityVector` is the authoritative hard scalar accounting
unit: every dimension is a finite nonnegative integer, and admission, lease,
task-grant, partition, observation, and allocation CAS sums each dimension
component-wise against the approved control partition. A worker grant has no
reserved control dimensions; `exclusive_unisolated` work cannot consume any
reserved control slot, model-call/token, verification, red-team, or recovery
dimension, and unknown/unverifiable usage is rejected or serialized.
The `WorkflowWorkerPartition.controlCapacity` vector is therefore all zeroes;
only explicitly admitted planner, verifier, red-team, recovery, and host
control grants may draw from `WorkflowControlPartition.capacity`.

For each named dimension `d`, the host atomically enforces
`sum(activeGrants[d]) + sum(reviewReserve[d]) + sum(recoveryReserve[d]) <=
approvedControlCapacity[d]`; a CAS compares the complete vector, not a scalar
total. A partial vector, omitted dimension, or component-wise overflow is an
admission failure even when another dimension is idle.

An adaptive allocation entry binds one task, attempt, resource lease, ownership
lease, discriminated worker/control capacity grant, and task-value certificate.
Only an entry marked `unclaimed` may move slots in place. A claimed or active
entry is fenced and reconciled before any new attempt/lease is created; it is
never silently reassigned. The host persists bounded fairness state (aging,
last-served task, priority bucket, promotion count, and a finite exploration
quota) so critical-path priority cannot starve eligible work. After a task
passes its positive starvation deadline, aging may promote it by at most the
persisted `maxPromotionBuckets` and `maxPromotionsPerWindow`; it cannot cross
the certified time-to-genuine-proof/evidence/cost/uncertainty objective bucket
or bypass ownership, authority, or dependency order. The final deterministic
tie remains task ID/digest.
Every aging quantum, starvation deadline, boost, promotion limit, exploration
quota, benefit threshold, dwell, observation window, and transition cap is
host-validated as finite and positive; `promotionEnabled: false` disables
promotion while retaining positive bounded limits, and every persisted policy
digest is checked at CAS. Reallocation needs a
numeric benefit above the persisted `benefitThreshold`, the persisted
`minimumDwellMilliseconds`, and room below `maxTransitionsPerWindow`. A safety
override is the only exception, and it is recorded with evidence and cannot
expand the approved envelope.

The controller coalesces observations to the latest source state with at most
one pending and one active review. A newer observation supersedes and cancels
unstarted pending work; an active review is fenced at its next safe boundary,
and its result cannot apply after supersession. This prevents review backlog,
context churn, and duplicate allocation effects.

Each adaptive event carries the workflow/store/coordinator epochs, source
journal sequence and digest, objective/contract/scorecard/config digests,
observation and allocation digests, affected lease references, and the
universal decision reference when a proposal is made. The reducer rejects an
observation whose source sequence, workspace, config, lease, or evaluator
digests are no longer current. It records the rejection and takes no capacity
action. Allocation application is a compare-and-swap against both the last
accepted observation and allocation revision; a retry with the same decision
and execution key returns the existing result.

At every trigger the controller performs this bounded sequence:

1. Capture current host telemetry and fresh, immutable evidence references;
2. reconcile live leases, queue membership, child identities, and control
   reserve against the authoritative journal;
3. run recon, non-overlapping lenses, evidence verification, synthesis, and an
   adversarial red team over any proposed allocation change;
4. apply only a host-gated, ownership-compatible reallocation whose component-
   wise resource sum remains within the approved envelope and reserve; and
5. persist the result, lease changes, cooldown/window counters, and any
   rollback reference before the next dispatch.

The host may keep a task's lease, move a fitting lease to a verified bottleneck,
or release and refill capacity. It cannot preempt an unsafe effect, change a
task's objective, weaken a scorecard, or use a telemetry improvement as proof of
an outcome. Reallocation is held until the minimum window unless the current
allocation is unsafe, a lease is released, a protected invariant is at risk,
or a material evidence transition proves the current bottleneck changed. A
bounded maximum number of changes per window prevents oscillation. Control-plane
reserve is admitted before worker capacity and cannot be consumed by workers to
make a plan appear saturated.

An allocation proposal that would increase any approved envelope component,
cloud/account/region/quota, spend, egress, credential, authority capability,
workflow ceiling, or control-plane obligation enters `awaiting_user`. The host
does not infer consent from a model response, a prior envelope, an idle pool, or
an unknown provider report. Unknown or stale capacity is zero until a fresh
host-observed, approved resource decision is committed.

### Adaptive recovery and rollback

The controller persists an allocation intent before any allocation, lease,
process, session, model-call, or provider-billing effect. The intent names the
effect-broker idempotency key, expected effect digest, all affected lease and
provider-charge references, and the allocation revision; only a later applied
marker makes the effect committed. A crash before that marker is uncertain, not
an automatic no-op: the effect broker must prove nonexecution or fence and
reconcile the effect idempotently, including leases and provider charges. Until
then, affected capacity and charges remain quarantined and cannot be reused.
Recovery fences stale coordinators, rejects stale observations, and reruns the
universal pipeline from the last committed observation. A failed or conflicting
rollback never partially moves leases; it pauses dispatch and requests a fresh,
exact decision. The recovery record names the allocation revision, effect
broker result, affected leases, provider-charge reconciliation, observed
process groups, and evidence used to prove the disposition.

An expired lease is reclaimed automatically only after a deterministic,
host-verified nonexecution proof: the fenced process group and descendants are
absent, provider idempotency/usage/billing records are settled, and the lease
epoch is fenced. Without that proof, the host starts a finite reclaim deadline;
at its deadline it records a terminal `failed`, `blocked`, or `awaiting_user`
escalation with exact evidence. There is no indefinite user-triggered reap
requirement and no unbounded retry.

### Recurring efficiency red-team reviewer (`cron`)

The `cron` reviewer is a fresh, independent, read-only context scheduled by
the approved `WorkflowEfficiencyRedTeamSchedule` in the resource envelope. A
trusted host clock determines cadence; the host also arms the configured major
transition triggers. A trigger does not create a second schedule or bypass the
window CAS. The host resolves one immutable snapshot containing the current
critical path, ready queues, ownership/resource leases, cost, throughput and
latency, accepted progress, evidence gaps, uncertainty, and control reserve.

Before invoking `cron`, the host dereferences every immutable snapshot
reference—original objective, hardened contract, scorecard and protected
invariants, plan, critical-path certificate, configuration, evaluator/guard,
revision registry, and capacity/usage/billing/rate-limit evidence—and
recomputes each digest. A missing, stale, mismatched, revoked, or untrusted
reference rejects the snapshot and review; `cron` cannot dereference mutable
paths or substitute its own critical-path, scorecard, or progress proof. The
host records the dereference and stale-rejection proof in the snapshot before
admission.

```typescript
interface WorkflowEfficiencyRedTeamSnapshot {
  reviewId: string;
  scheduleId: string;
  windowId: string;
  sourceJournalSequence: number;
  sourceJournalDigest: string;
  workflowStateDigest: string;
  originalObjectiveRef: WorkflowArtifactRef;
  originalObjectiveDigest: string;
  hardenedGoalContractRef: WorkflowArtifactRef;
  hardenedGoalContractDigest: string;
  scorecardRef: WorkflowArtifactRef;
  scorecardDigest: string;
  protectedInvariantRefs: readonly WorkflowArtifactRef[];
  protectedInvariantDigest: string;
  planRef: WorkflowArtifactRef;
  planDigest: string;
  criticalPathCertificateRef: WorkflowArtifactRef;
  criticalPathCertificateDigest: string;
  configurationRef: WorkflowArtifactRef;
  configurationDigest: string;
  evaluatorRef: WorkflowArtifactRef;
  evaluatorDigest: string;
  guardRef: WorkflowArtifactRef | null;
  guardDigest: string | null;
  revisionRegistryRef: WorkflowArtifactRef;
  revisionRegistryDigest: string;
  hostDereferenceProofRef: WorkflowArtifactRef;
  staleRejectionPolicyDigest: string;
  criticalPathTaskIds: readonly string[];
  readyQueueTaskIds: readonly string[];
  liveResourceLeaseRefs: readonly WorkflowLeaseRef[];
  liveOwnershipLeaseRefs: readonly WorkflowLeaseRef[];
  costEvidenceRefs: readonly WorkflowArtifactRef[];
  throughputEvidenceRefs: readonly WorkflowArtifactRef[];
  latencyEvidenceRefs: readonly WorkflowArtifactRef[];
  acceptedProgressEvidenceRefs: readonly WorkflowArtifactRef[];
  evidenceGapRefs: readonly WorkflowArtifactRef[];
  uncertaintyEvidenceRefs: readonly WorkflowArtifactRef[];
  controlPlaneReserve: WorkflowResourceVector;
  controlPlaneReserveCapacity: WorkflowControlCapacityVector;
  canonicalPoolLedgerRef: WorkflowArtifactRef;
  canonicalPoolLedgerDigest: string;
  authenticatedCapacitySnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
  envelopeDigest: string;
  snapshotDigest: string;
}

interface WorkflowEfficiencyRedTeamInvocation {
  reviewId: string;
  snapshotRef: WorkflowArtifactRef;
  reviewerChildIdentity: WorkflowChildIdentity;
  readOnlyCapabilityProofRef: WorkflowArtifactRef;
  admissionRef: WorkflowArtifactRef;
  resourceLeaseRef: WorkflowLeaseRef;
  ownershipLeaseRef: WorkflowLeaseRef;
  epochRef: WorkflowEpochRef;
  windowSequence: number;
  executionKey: string;
  casExecutionKey: string;
  invocationTokenDigest: string;
  startedAt: string;
  actualUsage: WorkflowResourceVector;
  status: "prepared" | "started" | "completed" | "failed" | "fenced";
  invocationDigest: string;
}

interface WorkflowEfficiencyRedTeamSuccessResult {
  kind: "success";
  reviewId: string;
  invocationRef: WorkflowArtifactRef;
  suggestionRef: WorkflowArtifactRef;
  actualUsage: WorkflowResourceVector;
  completedAt: string;
  resultDigest: string;
}

interface WorkflowEfficiencyRedTeamFailureResult {
  kind: "failure";
  reviewId: string;
  invocationRef: WorkflowArtifactRef;
  status: "failed" | "timed_out" | "stale" | "unavailable" | "fenced";
  errorRef: WorkflowArtifactRef;
  actualUsage: WorkflowResourceVector;
  completedAt: string;
  resultDigest: string;
}

type WorkflowEfficiencyRedTeamResult =
  | WorkflowEfficiencyRedTeamSuccessResult
  | WorkflowEfficiencyRedTeamFailureResult;

interface WorkflowEfficiencyRedTeamWindowState {
  scheduleId: string;
  windowId: string;
  scheduledAt: string;
  windowSequence: number;
  clockObservationSequence: number;
  lastAdmittedWindowSequence: number;
  triggerDigests: readonly string[];
  reviewId: string | null;
  invocationRef: WorkflowArtifactRef | null;
  resultRef: WorkflowArtifactRef | null;
  catchUpConsumed: boolean;
  status: "pending" | "running" | "completed" | "failed" | "rejected_overlap" | "skipped";
  sourceSnapshotDigest: string | null;
  completedAt: string | null;
  windowDigest: string;
}

interface WorkflowEfficiencyRedTeamSuggestion {
  suggestionId: string;
  reviewId: string;
  windowId: string;
  disposition: "no_change" | "suggest_reallocation" | "suggest_schedule_change" | "suggest_user_decision" | "safety_finding";
  findingRefs: readonly WorkflowArtifactRef[];
  evidenceRefs: readonly WorkflowArtifactRef[];
  recommendedAllocationRef: WorkflowArtifactRef | null;
  expectedVerifiedOutcomeRef: WorkflowArtifactRef | null;
  writeAuthority: false;
  leaseAuthority: false;
  allocationAuthority: false;
  approvalAuthority: false;
  completionAuthority: false;
  suggestionDigest: string;
}
```

The reviewer checks whether placement advances the fastest genuine completion,
not whether utilization is high. Its immutable charter covers underuse,
overuse, duplicate/redundant work, work that could safely serialize, context
churn, verifier/red-team starvation, review overhead, local/cloud cost, lease
and queue pressure, and Goodhart or proxy-progress risk. It may recommend a
new allocation or schedule, but it cannot write, acquire/release a lease,
reallocate, approve, mutate a scorecard, or mark progress/completion. The
suggestion is evidence only. Applying it starts a new full recon/lens/
verification/synthesis/red-team/host decision and any required exact user
approval; changing cadence, trusted clock, trigger set, window, or review
reserve is itself a new schedule/resource decision.

The host validates that cadence, every review wall/token/cost ceiling,
per-window/phase/workflow review limit, duty-cycle cap, and dedicated reserve
are finite positive bounds, that `maxReviewsPerWindow` remains exactly one, and
that the review reserve is disjoint from planner, verifier, red-team, recovery,
and control reserves. A disabled schedule is represented by an absent schedule,
not a zero bound. Missing, non-finite, negative, zero, or overflow-prone values
fail closed before schedule CAS; a schedule change is a new approved decision.

The host admits at most one reviewer per schedule window. Window state uses
epoch-qualified compare-and-swap: an active or completed review rejects an
overlapping trigger, and coalesced major-transition triggers share one snapshot
and one review. On restart, the host may admit exactly one catch-up review for
the most recent missed window after validating the schedule and source state;
older missed windows are discarded, not replayed. A reviewer failure, timeout,
stale snapshot, or unavailable read-only context records a nonblocking
diagnostic and leaves the last safe allocation unchanged. The fixed review
resource/cost ceiling is charged before worker capacity and can never consume
verifier, red-team, recovery, or control-plane reserve.

Each window also records a host `WorkflowMonotonicClockObservation` and a
persisted last-admitted window sequence/id. The host rejects backward clock
observations, duplicate or replayed sequences, and any window sequence at or
below the persisted last-admitted value. The window CAS advances that marker
atomically with invocation admission; restart recovery revalidates the clock
source and sequence before consuming the one permitted catch-up. Every
invocation binds the immutable snapshot, reviewer child identity, independent
read-only capability proof, admission, resource and ownership leases, epoch,
execution key, and invocation token. Results are typed success or failure and
carry actual usage; a failed result is durable and nonblocking, never silently
treated as success or as a reason to allocate.

### Adaptive allocation failure modes

| Failure | Host response | Required evidence |
| --- | --- | --- |
| Observation is stale, incomplete, or based on an old lease/config/workspace digest | Reject the observation, retain the last safe allocation, and capture a fresh observation | Rejection event with source and current digests |
| Bottleneck or marginal verified progress is uncertain | Keep the current bounded allocation or spend a finite read-only verification lease; do not add workers for activity | Uncertainty artifacts and unchanged allocation digest |
| Proposed shift would consume control reserve or exceed a local/cloud/spend/authority ceiling | Reject or pause before dispatch; ask for exact approval for any expansion | Host-derived resource vector, reserve calculation, and approval request |
| Lease release, provider report, or descendant state is ambiguous | Quarantine the lease/effect and enter reconciliation; never count it as free capacity | Live identity, billing/usage, epoch, and reconciliation evidence |
| Controller crashes before or after an allocation intent | Replay the last committed allocation or validate one exact CAS result; roll back on conflict | Journal boundary, allocation revision, and rollback/recovery artifact |
| Reallocation thrashes inside a window | Hold the current allocation until hysteresis/minimum-window rules permit a change, unless safety requires immediate stop | Window counters, cooldown, and trigger evidence |
| `cron` schedule is missing, untrusted, overlaps an active window, or requests an unapproved schedule change | Reject the trigger or schedule decision; preserve the approved envelope and last safe allocation | Trusted-clock, schedule-digest, window-CAS, and approval evidence |
| `cron` reviewer is late, unavailable, times out, or returns malformed/read-write output | Record a nonblocking reviewer failure, discard the output, and continue with the last safe allocation | Fresh-context identity, bounded resource usage, failure artifact, and unchanged allocation digest |
| Restart leaves multiple missed `cron` windows or a catch-up already consumed | Admit at most one validated catch-up and discard the rest without backlog replay | Restart epoch, catch-up marker, window state, and no-storm event count |
| `cron` suggestion attempts a write, lease/allocation change, approval, scorecard mutation, or completion claim | Reject the suggestion before any host effect and open a new full decision only if a trusted proposer requests application | Read-only capability proof, rejected suggestion digest, and unchanged state |
| Improvement candidate fails baseline, held-out/replay/canary, or Goodhart/regression/safety red team | Reject or atomically roll back the candidate; continue with the last approved revision | Comparison artifacts, verifier result, and red-team disposition |
| Critical-path graph, remaining-work estimate, policy digest, or task-value certificate is missing, stale, or non-reproducible | Reject the observation/allocation and retain the last safe state; no model or worker may self-supply the proof | Host-derived certificate inputs, lexicographic objective, and rejection digest |
| Claimed adaptive entry is claimed/active or its task, attempt, resource lease, or ownership lease does not match | Fence and reconcile the active attempt, then create a new attempt/lease; only `unclaimed` slots may shift in place | Epoch-qualified binding, fence result, new attempt ID, and lease evidence |
| Capacity, usage, billing, or rate-limit snapshot is unauthenticated, non-monotonic, expired, or unknown | Resolve capacity and headroom to zero at CAS, quarantine provider charges, and pause affected dispatch | Authentication, sequence, observed/expiry, billing, and rate-limit snapshot refs |
| Worker admission would borrow process/session/model-call/token/recovery capacity from the control partition or run `exclusive_unisolated` work concurrently | Reject or serialize the worker away from the control plane; preserve the hard control reserve | Partition vectors, isolation class, and scheduler decision |
| Allocation intent has no applied marker after a crash | Treat the effect as uncertain; require effect-broker nonexecution proof or fenced idempotent reconciliation before retry or release | Intent key, provider/lease refs, broker result, and reconciliation evidence |
| Fairness, aging, exploration quota, hysteresis threshold/dwell, or transition cap is missing or exceeded | Preserve the last allocation; safety override may stop work but cannot expand the envelope | Persisted fairness/last-served and numeric window decision state |
| Expired lease lacks strong nonexecution proof by the reclaim deadline | Do not reclaim optimistically; record finite terminal escalation (`failed`, `blocked`, or `awaiting_user`) with no indefinite reap | Reclaim decision, deadline, process/provider proof, and escalation artifact |
| More than one adaptive review is pending/active or a newer observation supersedes an older one | Coalesce to the latest source, cancel unstarted superseded work, fence active review at a safe boundary, and prevent its result from applying | Queue state, cancellation digest, and supersession event |
| Task-value certificate lacks an unproven requirement/evidence gap, novelty/nonduplicate digest, bounded outcome, or finite exploration quota | Reject dispatch as proxy work and keep the slot available for certified work or bounded verification | Certificate digest and host rejection finding |
| A control-capacity vector is missing, negative, non-finite, over-reserved, or not component-wise reconciled | Reject admission/CAS; preserve every hard control dimension and serialize `exclusive_unisolated` work away from it | Vector, partition, lease/grant sums, and rejection digest |
| An improvement scorecard lacks a host-owned manifest, required sample, hidden holdout, effect/tolerance, non-regression, or cost/latency predicate | Reject the refinement and retain the active revision; the proposer cannot select or omit holdouts | Frozen scorecard, manifest digests, host selection proof, and comparison result |
| A revision registry entry is stale, revoked, superseded, incompatible, or missing pinned bytes | Reject phase/effect admission, fence affected work/leases/approvals/caches, and retain pinned audit bytes | Registry epoch/event CAS, closure proof, fence set, and pinned-byte refs |
| A `cron` snapshot cannot dereference or verify an immutable objective/contract/scorecard/plan/certificate/config/evaluator/guard/registry ref | Reject the snapshot/review and preserve the last safe allocation; mutable paths cannot substitute evidence | Host dereference proof, per-ref digests, stale-rejection event, and unchanged allocation |
| Schedule, review duty-cycle, cadence, or phase/workflow limits are zero, negative, non-finite, or exceed the approved reserve | Reject the schedule/budget CAS; no implicit retry or resident review loop may start | Bound validation, reserve partition, budget digest, and decision ref |

### Continuous improvement review

The host, never the proposer, creates and freezes a
`WorkflowImprovementScorecard` and `WorkflowImprovementEvaluatorContract` with
preregistered case manifests, required sample sizes, effect and tolerance
thresholds, non-regression predicates, maximum cost/latency, metric direction,
aggregation, repeatability count/variance bound, and deterministic risk
classification. The evaluator and parser are host-owned immutable references;
their digests, direction, aggregation, variance/repeatability rule, and stage
scoped holdout commitments are parsed and validated before admission. A
risk-relevant revision must include a host-selected hidden holdout whose
`heldOutInputDigest` is required and undisclosed to the proposer; the proposer
cannot choose, replace, or omit it. The scorecard is immutable for the review
and its protected invariants and cost/latency predicates are evaluated
independently of the candidate.

After every phase, incident, and completion gate, the host creates a bounded
refinement trigger from accepted evidence. All durable, native, AutoResearch,
and knowledge producers route through the discriminated
`WorkflowImprovementProposal` → `WorkflowImprovementReview` →
`WorkflowImprovementResult` lifecycle and its journaled
`WorkflowImprovementEvent`s. A proposal may identify one small workflow,
methodology, evaluator-policy, controller-policy, or knowledge revision; it may
also be an explicit empty set. It must identify baseline and candidate evidence,
the frozen evaluator/parser and stage holdouts, queue/crash-fencing state,
rollback artifact, and affected ownership/authority. A verifier reruns the
baseline and candidate on the same cases plus host-selected held-out, replay,
or canary cases. Independent verifier, Goodhart, regression, and safety
red-team results are required before promotion. The host atomically applies a
compatible revision by registry epoch CAS with `rollbackOf`/event-sequence
metadata, reload verification, and future-load verification, or records
rejection/rollback without mutating the active contract. A revision that changes
objective, scorecard, evaluator, authority, envelope, or workflow scope remains
a new user-approved decision, not a refinement shortcut. Crash-fenced proposals
remain queued/quarantined until their effect is proven absent or reconciled
idempotently; they are never inferred from a torn record.

Review admission is latest-wins with at most one pending and one active review;
superseded pending work is cancelled and a fenced active result cannot apply.
The host enforces the persisted `WorkflowImprovementReviewBudget`: positive
finite duty-cycle, per-window, per-phase, and per-workflow bounds, a dedicated
review reserve, and a separate planner/verifier reserve that review work may
not consume. Zero, negative, non-finite, or overflow-prone budgets fail closed;
the review loop has no implicit retry or resident daemon.

Future workflows resolve only revisions in the approved revision registry. A
candidate, rejected, unverified, stale, or rolled-back revision is not loaded by
default, and an optional MemPalace projection can only index an already
committed canonical knowledge record. Knowledge stores how/why/provenance and
refinement evidence; they cannot authorize a workflow transition, allocation,
resource expansion, or completion.

The registry records each revision's compatibility closure, discriminated scope
binding, session and knowledge decision refs, pinned artifact bytes, approval,
and `approved`/`superseded`/`revoked` status. A `revisionKind:"knowledge"`
entry must use `scope:"knowledge"` and a `scopeBinding` whose nested
`knowledgeScope` is exactly `"session"` or `"workflow"`; its singular
`knowledgeDecisionRef` and `knowledgeEntryRef` must match the corresponding
host-resolved entry and the audit arrays. This is a scope discriminator and
does not grant knowledge authority or permit a scope upgrade. Before every
phase admission and every host effect, the host produces a typed
`WorkflowRevisionResolution`, rehashes the exact registry entry, compares the
expected and observed registry epochs, verifies approved status and compatible
pinned bytes, and rejects stale, replayed, mismatched kind/scope, or incomplete
closure proof. A supersession or revocation fences affected active work,
leases, approvals, and caches before any reload; pinned bytes and registry
events remain retained for audit. A rollback is an atomic registry CAS that
supersedes the bad entry, records `rollbackOfRevisionId`, rollback event
sequence, and CAS execution key, then proves restart reload and future-work
loading of the prior approved compatible bytes. Revocation requires an
epoch/event CAS and cannot be represented by a mutable display flag.

### Ownership and first-release boundary

| Concern | Implementation owner | First-release boundary |
| --- | --- | --- |
| Observation schema, allocation state/events, CAS, hysteresis, and deterministic no-op handling | `core/workflow/resources.ts`, `scheduler.ts`, `reducer.ts` | Local observed pools, existing leases, finite windows/ceilings; no hidden capacity or infinite polling |
| Hard control-capacity vector and worker/control partition enforcement | `core/workflow/resources.ts`, `scheduler.ts`, `recovery.ts` | Component-wise CAS accounting for all eight dimensions; `exclusive_unisolated` work is isolated/serialized; no unverifiable physical-isolation claim |
| Universal allocation proposal/review and exact approvals | `core/workflow/decision-gate.ts`, `evidence.ts` | Existing universal stages and host gate; envelope/cloud/spend/authority expansion always pauses for user |
| Lease, child, provider, and crash reconciliation | `core/workflow/recovery.ts`, `effect-broker.ts` | Quarantine and rollback on ambiguity; no blind replay or new daemon wire |
| Recurring `cron` efficiency red-team schedule, snapshot, window CAS, and catch-up | `core/workflow/resources.ts`, `scheduler.ts`, `evidence.ts`, `recovery.ts` | Fresh read-only reviewer, one review/window, one restart catch-up, bounded overhead; suggestions have zero authority |
| Native phase demand hints | `core/workflow/native-methodology*.ts` | Hints are evidence inputs only; native phases cannot allocate or self-score |
| AutoResearch metric/guard signals | `core/autoresearch/admission.ts`, `scheduler.ts` | Fixed objective/scorecard/metric/guard; adaptation may change grants/roles only inside approval |
| Host-owned improvement scorecard, hidden holdouts, review budget, and case manifests | `core/workflow/refinement.ts`, `decision-gate.ts`, `evidence.ts` | Positive finite bounds, mandatory host-selected holdouts, independent comparison/red teams; proposer has no manifest authority |
| Canonical policy/methodology/evaluator revision registry | `core/workflow/revisions.ts`, `recovery.ts`, `effect-broker.ts` | Compatibility closure, scope/status/epoch CAS, fencing on supersession/revocation, pinned audit bytes; no mutable-path reload |
| Approved how/why/provenance and methodology revisions | `core/refinement/*` and knowledge ledger | Canonical commit first; optional MemPalace indexes only; no authority or memory egress |

The first release does not promise optimal scheduling or physical resource
isolation on hosts without an enforcement broker. It promises conservative,
auditable allocation within the approved envelope and stops or serializes when
the host cannot verify a safe shift.

## Phase Contracts and Skills

Each fresh phase receives:

- its role and allowed state transitions;
- the original objective and current hardened goal contract;
- the relevant workflow ledger slice;
- current workspace and Git state;
- required input artifacts;
- available skill metadata;
- the exact required skill content digests and host-issued invocation tokens;
- its decision role in the recon/lens/verify/synthesize/red-team pipeline;
- its resource vector and lease boundary;
- explicit completion criteria; and
- the workflow host-response schema.

A phase reports exactly one structured outcome:

- `complete`, with artifact and evidence references;
- `pause`, with the exact user decision required;
- `blocked`, with evidence and exhausted alternatives; or
- `failed`, with an actionable error.

The host validates outcomes before appending them. An ordinary assistant final message is never a terminal workflow signal.

A phase-level `blocked` outcome is only a typed blocker claim. The host derives
the stable `blockerId` from workflow, dependency, and condition digests, compares
the reported results with its registered safe-alternative set, and reduces the
claim into a `WorkflowBlockerRecord`; a phase cannot supply its own identity,
counter, or terminal disposition. It enters adversarial blocker audit and cannot
set terminal workflow status directly.

The planner attaches required and recommended skill names to phases and tasks. The coordinator resolves them through the existing resource loader and dispatches them through the existing skill invocation path. Before invocation, the host copies the exact skill and declared dependencies into an immutable content-addressed snapshot and records canonical path, source provenance, trust tier, content and dependency digests, workflow contract revision, and a host-issued one-time invocation token. Byte or dependency changes invalidate the snapshot and require a new decision revision. A phase outcome is invalid if it claims a different skill revision, omits the token, or bypasses a required pause.

The workflow engine does not parse a skill's prose into host logic. A versioned machine-readable workflow manifest declares required approval gates, artifacts, pressure tests, and allowed transitions for built-in methodology skills; third-party skills without such metadata may still guide a worker but cannot claim a host-enforced gate. The host enforces observable contracts: the required immutable snapshot was loaded, the invocation occurred, required artifacts exist, required evidence is current, and every declared approval gate was durably honored. Project or user overrides retain established precedence, but their trust tier and changed digests remain explicit and cannot inherit a built-in manifest silently.

Explicitly user-requested skills are always required. The goal hardener, planner, and completion auditor each receive the available skill catalog and invocation ledger. A task that omits a required skill or violates a recorded skill gate cannot be accepted as progress, even if its output otherwise appears successful.

When an invoked skill requires human approval, the phase must report `pause`. The coordinator persists the approval request before returning control. It never converts the request into an autonomous assumption. Resumption records the exact user response and starts a fresh context with that response and the prior artifact.

This permits workflows such as brainstorming, written design review, implementation planning, test-driven implementation, review, and verification to retain their skill-defined gates while gaining durable orchestration.

Prime Agent ships an attributed, versioned native methodology snapshot based on the user's Superpowers fork. Its detailed behavior, upgrade rules, and pressure-test requirements are defined in `2026-08-13-native-methodology-design.md`. Ordinary coding sessions receive lightweight skill routing and verification safeguards. The full durable planner, decision pipeline, capacity scheduler, and recovery machinery runs only for explicit workflows and native AutoResearch runs.

## Durable Planner

The planner is a logical role backed by repeated fresh sessions, not one indefinitely growing conversation. Durable state, rather than conversation history, preserves continuity.

A new planner cycle runs after:

- goal hardening;
- user approval;
- a worker batch completes;
- a worker is interrupted or fails;
- a progress audit rejects a claim;
- verification finds a gap;
- a completion audit finds a shortcut or missing outcome;
- reconciliation finishes; or
- an approved refinement checkpoint changes the harness.

Each cycle must either dispatch safe ready work, request a required approval, record an independently supportable blocker, or advance to verification. It cannot stop because an earlier plan ended, a worker failed, a context reset occurred, or an intermediate metric passed.

Coordinator progress is event-driven. A journal transition, child terminal or
heartbeat-loss event, lease release, resource-capacity change, approval response,
verification result, or recovery finding recomputes the ready set and schedules
the next required planner or repair action. The host may use bounded transport
polling internally when an existing registry lacks push events, but an unchanged
observation creates no model turn, activity artifact, progress claim, or busy
wait. A control-plane slot remains reserved to process these events.

The planner never directly changes workflow state. It proposes a plan revision. Recon establishes current code, evidence, capacity, and dependencies; distinct lenses inspect intent, architecture, simplicity, reuse, risk, testability, ownership, and resource fit; verification checks cited facts; synthesis emits the exact graph; red team attacks the graph for missed requirements, proxy optimization, unsafe concurrency, hidden scope changes, and no-progress work. Only the host gate may accept the revision.

Plans are revisions of a typed dependency graph. A task contains:

- stable task ID and plan revision;
- objective and requirement IDs served;
- completion criteria;
- dependencies;
- owned files, path prefixes, or named domains;
- contracts it reads and changes;
- required and recommended skills;
- verification commands or observable evidence;
- authority requirements; and
- current state and attempt history.

Invalid graphs, dependency cycles, unknown skills, missing ownership, or attempts to weaken the goal contract are rejected before dispatch and returned to a fresh planner cycle as concrete findings.

Every plan revision must add new evidence, change the task graph, or record a materially different strategy in response to findings. An unchanged plan against an unchanged workspace is rejected as no progress. Cycle identity is the digest of the contract, scorecard, plan, workspace, evidence, and rejected-strategy set. Repeating a cycle identity cannot reset retry counters or consume unbounded work. The coordinator requests an independent strategy review; safe alternatives return to planning, while the finite decision-revision cap sends genuine ambiguity to the user and absence of alternatives to blocker audit.

## Parallel Scheduler

The shared workspace is the primary execution model for general work. The scheduler computes the ready set after every durable state transition and immediately dispatches every task that:

1. has all dependencies accepted by progress audit;
2. has no unresolved approval or authority gate;
3. belongs to an accepted, red-teamed plan revision;
4. has explicit host-enforceable ownership;
5. does not overlap a running task's files, path prefixes, generated outputs, lockfiles, schemas, or named contracts; and
6. has a resource vector that fits the current approved envelope after control-plane reserve.

Tasks with overlapping or ambiguous ownership are serialized. Tasks with independent ownership and fitting resources are submitted immediately to existing daemon-backed subagents. Each dispatch first acquires and persists a capacity lease and a stable attempt idempotency key. The existing host boot-admission gate still bounds kernel startup pressure, while the workflow allocator bounds total live resource use. `--max-workers` is one upper bound within the larger typed envelope, not the definition of capacity.

The planner must include indirect shared outputs such as generated files and package locks in ownership. A task that discovers an unplanned overlap reports it before editing that area. The scheduler persists the ownership amendment and delays conflicting work.

Workers are not allowed to revert other workers' changes. Their phase contract identifies the shared workspace, current ownership, allowed tools and commands, and the requirement to accommodate concurrent changes.

Parallel writes require host enforcement at the filesystem/process boundary. The enforcer must cover built-in edit tools, shell commands, symlink swaps, renames, ignored and generated outputs, and late descendant processes. Until that broker or equivalent OS/copy-on-write isolation exists, the first release must serialize every shared-workspace writer while continuing unrelated read-only recon, lens, verification, or planning work; it may instead run writers in isolated worktrees and serialize their audited integration. A task whose effects cannot be classified is treated as write-capable. This is a safety classification, not a silent best-effort fallback.

AutoResearch candidates are the explicit specialization that always uses isolated Git worktrees because candidates intentionally compete and may run arbitrary evaluators. Ordinary workflow tasks remain in the shared workspace unless their accepted plan explicitly requires isolation.

Child authority is classified before admission. Any child granted `shell`,
`ipython`, `edit`, or `recursive_spawn` is `write_capable`, even when its
declared task is read-only; only a child with the explicit `read_only`
capability and none of those capabilities is read-only. A child never inherits
the authority to create another child: recursive child creation is root-only,
and `recursive_spawn` is denied to non-root children. Until the host mutation
and process brokers enforce these boundaries, all write-capable children are
serialized in the shared workspace or run in isolated copy-on-write/worktree
contexts whose audited integration is serialized. Read-only work may continue
in parallel. The daemon child registry reports liveness and observed identity
for reconciliation only; it does not grant capability, create descendants,
release a lease, or advance an attempt.

Worker completion moves an attempt to `awaiting_audit`; it does not satisfy dependencies. The scheduler advances the graph only after a fresh progress auditor accepts the task's requirement evidence.

The coordinator records the union of active ownership and compares workspace changes continuously where supported and again at quiescent audit boundaries. A denied or detected out-of-ownership change, undeclared shared output, late write after lease release, or transcript evidence that a worker attempted another task's ownership invalidates the affected attempt, freezes conflicting dispatch, and enters reconciliation. Final correctness never depends on attributing an ambiguous concurrent edit to a specific worker.

Scheduling order is deterministic for the same accepted plan, capacity snapshot, and journal prefix. It is fair across ready tasks and records `resource_wait`, `ownership_wait`, `dependency_wait`, or `authority_wait` when a task cannot start. Refill occurs on every release rather than at batch barriers; only cross-task integration checks, synthesis, and frontier admission create barriers.

## Structured Handoffs

Every attempt runs in a fresh context and writes a
`WorkflowAttemptHandoff` before reporting completion. It binds the task and
attempt to plan/goal revisions, exact ownership, upstream decisions,
interfaces/dependencies, recommendation and rationale, preserved invariants,
pitfalls, unresolved issues, failed approaches, pre/post workspace digests,
and any material escalation. Evidence is layered as claim, observable result,
method, immutable artifact, confidence, and limitations. Commands retain exit
status and bounded output in the referenced artifact.

The handoff is a result and knowledge delta, not an activity report. Time spent,
messages sent, files touched, commits made, and workers used are telemetry and
cannot stand in for the typed outcome or requirement evidence. Missing required
fields leave the attempt open; model prose cannot patch the record after the
attempt token expires.

Worker claims are inputs to progress audit, not accepted evidence by themselves.

## Anti-Cheating Progress Ledger

The progress ledger contains one entry per hardened requirement. Its status is one of:

- `unproven`
- `proven`
- `regressed`

There is no completion percentage.

After each parallel batch, a fresh progress auditor compares:

- the original objective;
- the hardened contract;
- the pre-batch workspace snapshot;
- the post-batch workspace snapshot;
- worker handoffs;
- command and integration evidence; and
- prior accepted evidence.

Only independently demonstrated outcome changes can mark a requirement `proven`. Evidence records its source, command or observation, exit state, relevant bounded output, timestamp, workspace digest, and the auditor decision. Later changes or verifier findings may invalidate evidence and mark a requirement `regressed`.

The auditor selects or reruns the checks needed for acceptance rather than copying a worker's conclusion. Worker-authored tests may contribute evidence, but a test designed by the same worker is not sufficient by itself when independent behavioral or integration evidence is available.

The auditor explicitly searches for:

- deleted, skipped, weakened, or narrowed tests;
- lowered thresholds or altered acceptance criteria;
- hardcoded outputs, stubs, or mock-only success;
- scope silently removed from the plan or contract;
- self-reported completion without observable state;
- unrelated churn presented as progress;
- verification authored to guarantee the worker's own success;
- passing commands that do not prove user-visible outcomes;
- evidence from an obsolete workspace revision;
- a proxy metric improving while the actual requirement remains unmet;
- fabricated utilization, no-op or duplicate workers, and resource burn presented as progress;
- stale, forged, reused, or wrong-revision decision verdicts;
- unapproved changes to metric, target, evaluator, parser, guard, scope, ownership, or resource envelope;
- evaluator leakage, benchmark overfit, or train/test contamination; and
- skill revision substitution or approval-gate bypass.

Rejected claims become planner findings. The next planner cycle must change strategy, decompose the work further, or create corrective tasks. Repeated failed approaches remain in the durable ledger so fresh contexts do not retry them without new evidence.

A blocker claim receives the full decision pipeline and its own adversarial
false-blocker review. If a safe alternative remains, the workflow returns to
planning. The reducer increments `consecutiveGoalTurnCount` only when the same
stable dependency/condition identity survives independent audit on distinct,
consecutive host-issued goal turns and the registered alternative set is fully
accounted for with evidence. New artifact names, revised prose, fresh contexts,
or repeated self-reports neither reset nor increment it. A materially changed
condition creates a new identity and counter. Terminal `blocked` is permitted
only after three such consecutive goal turns, zero remaining safe alternatives,
independent obstruction evidence, and exhausted finite strategy revisions, when
progress requires new user authority, unavailable external state, or resolution
of a contradictory requirement. Before then the host continues safe work or
uses `awaiting_user`; an explicit cancel or pause does not manufacture a blocker.
Worker or planner self-report cannot terminate the workflow.

## Verification and Completion

When every requirement has current evidence, a fresh verifier receives the original objective, hardened contract, accepted evidence, plan history, all relevant handoffs, current workspace, immutable scorecard/evaluator/parser/guard digests, and required verification skills.

The verifier independently inspects the result and runs the checks that prove the outcome from a clean or isolated verification environment with a separate host-issued execution identity. Evaluators, parsers, guards, tests, fixtures, and held-out data required by the scorecard are read-only or compared with their approved digests. Worker self-checks and mock-only tests do not substitute for this pass; worker-authored checks require independent behavioral or integration evidence, and held-out tests/data are used when the objective admits them. A verification failure or evaluator mutation invalidates affected evidence and returns the workflow to planning.

After verification passes, a separate fresh completion decision runs recon, distinct completion lenses, evidence verification, synthesis, and adversarial red team. It attempts to falsify success using the contract's adversarial tests and cheating risks. It checks that the goal was not satisfied by changing the metric, narrowing the scope, hiding failures, burning resources, or proving a surrogate outcome.

Only the host completion-readiness gate may authorize the final refinement and
completion sequence, and only when every requirement has current independent
evidence, every protected invariant holds, every required skill gate has
authenticated provenance, no unresolved decision conflict exists, and the exact
revision survived red team. Neither the planner, worker, verifier, synthesizer,
nor red-team model can directly mark the workflow complete.

Final refinement cannot invalidate evidence invisibly. Its proposal declares the
runtime prompt/skill/subagent/memory digests it can change. If an applied edit can
affect the active contract, implementation behavior, evaluator, verification
environment, or completion reasoning, the host invalidates readiness and reruns
the affected verification and completion pipeline with the new digests. A purely
non-injected record or an empty/failed refinement may proceed to final completion
with its outcome disclosed. The final host transition occurs only after this
digest-impact check and any required re-verification.

## Recovery and Reconciliation

All dispatches follow a write-before-side-effect sequence using committed framed
journal events:

1. acquire the active coordinator fencing epoch;
2. prepare, commit, and flush dispatch intent with a stable attempt ID, one-time idempotency key, decision revision, resource lease, and expected effect digest;
3. create or message the child through an admission path that binds the same idempotency key;
4. prepare, commit, and flush the resolved child identity;
5. observe the child through existing registries and transcript events; and
6. prepare, commit, and flush the structured terminal outcome, then release the resource lease exactly once.

Workflow-controlled effects pass through the host effect broker. Before the
broker admits an effect, the host performs the current revision-registry
epoch/compatibility check and fences the effect if the referenced revision is
superseded or revoked. The broker then performs an atomic active-epoch and
decision check at the latest enforceable commit boundary, owns the attempt's
process group, terminates and reaps stale descendants after fencing, and uses
provider/filesystem idempotency or compare-and-swap primitives when available.
Effects that cannot be fenced or made observable are classified as
consequential and non-idempotent before dispatch; they require explicit
authority and become user-resolved if their outcome is ambiguous. Epochs fence
coordinator authorization but are not claimed to cancel an already accepted
external effect retroactively.

If an existing child/admission path cannot bind a stable idempotency key, a crash
between intent and identity makes the attempt ambiguous. The coordinator must not
retry it automatically. Reconciliation must prove non-execution, reattach the
exact child, or request user direction when the possible effect is consequential
or non-idempotent. In the first implementation, workflow child dispatch is
disabled until a durable host admission registry can atomically bind
`workflowId/attemptId/executionKey/coordinatorEpoch` to the child identity and
recover it. If that identity must cross daemon process or wire boundaries, the
change is not covered by the no-wire-change preference: implementation pauses for
capability-gated/incompatible protocol classification and both compatibility
directions before enabling dispatch.

Every acceptance criterion involving child overlap, immediate refill, live
reattachment, descendant cancellation, or worker saturation is therefore gated
on that registry and the effect/mutation prerequisites. The initial vertical
slice may exercise goal, decision, approval, journal, planning, and status paths
only; it cannot claim dispatch or parallelism evidence. The release cannot claim
durable execution complete until the gated criteria run with real processes.

On root restoration, the workflow coordinator first acquires a new lease epoch and fences prior owners. It replays the hash-chained journal and enters `recovering` if an active attempt lacks a durable terminal event. It then:

1. compares persisted attempts with live child registrations and transcripts;
2. reattaches workers that are still live;
3. marks missing workers `interrupted`;
4. captures current workspace and evidence state; and
5. quarantines uncertain resource leases and execution keys; and
6. launches the full decision pipeline to classify each uncertain attempt as completed, still running, proven not executed and safe to retry, requiring corrective work, or requiring user input.

The coordinator never blindly replays an uncertain action. If a task may have performed an external or otherwise non-idempotent side effect, reconciliation pauses for user direction unless observable evidence proves the exact outcome.

If recovery finds an artifact published without its journal reference, an intent without a child identity, or a child identity without a terminal outcome, reconciliation treats the attempt as uncertain. It imports no artifact and retries no action until current workspace, transcript, child-registry, and external evidence establish a safe disposition.

Recovery preserves the workflow ID, task IDs, decision IDs and revisions, attempt history, goal accounting, approval state, resource accounting, and accepted evidence. A workflow already awaiting approval remains paused after every restart. Stale coordinators, stale approvals, duplicate execution keys, broken hash chains, and wrong-epoch journal events are rejected rather than reconciled as success.

## Budgets and Continuations

Autonomous turn, token, time, and continuation limits apply to one fresh phase attempt. Reaching one ends that context but does not end the workflow. The coordinator records the limit and starts the next required planner, worker, auditor, or reconciliation context.

The existing goal records aggregate time, tokens, and continuations across the workflow tree. The approved resource envelope adds hard time, token, request, rate, concurrency, egress, accelerator, and monetary budgets when applicable. Reaching any hard limit produces `budget_limited` and prevents new substantive work before the next charge or dispatch. Reserved but unused amounts are reconciled explicitly; the workflow cannot spend against an uncertain reservation.

When the user supplies no budget, the host proposes a conservative finite local
execution envelope for approval. The workflow may continue autonomously within
that envelope until completion, cancellation, another required approval, an
independently proven blocker, or `budget_limited`; it never interprets an omitted
limit as unbounded work. Renewal requires a new exact resource decision and user
approval. Cloud execution likewise never begins without finite explicit ceilings.

Transient model, process, or verification failures are planner inputs rather than workflow terminal states. Terminal `failed` is reserved for invalid or unreadable durable state, an invariant violation the host cannot reconcile, or repeated infrastructure failure that prevents any phase from running.

## Refinement Loop

The existing refinement review gate consumes the audited workflow trajectory. It may run:

- after a verified milestone;
- after a repeated audited failure exposes a reusable lesson; and
- after the completion audit passes, before final completion.

The review receives the plan, decision artifacts, handoffs, rejected progress claims, failed approaches, recovery events, verifier evidence, skill outcomes, capacity outcomes, and prior refinement history. It may propose creating, updating, deleting, or rolling back small evidence-backed continual-harness entries, including:

- reusable skill descriptions;
- durable memories or prompt rules;
- reusable subagent specifications; and
- repeated failure patterns with verified remedies.

It must not persist task history, transient blockers, individual thread decisions, secrets, private source content, or unsupported hypotheses. An empty edit set is valid.

Every refinement or canonical memory mutation is a decision revision. A fresh verifier checks its cited trajectory; a fresh red team tests one-off overfitting, prompt or memory poisoning, privacy leakage, duplication, incorrect scope, and blast radius. Application uses baseline-version compare-and-swap, then reload verification and rollback metadata.

Changes to skill or methodology content additionally follow the native writing-skills process: a pressure scenario must demonstrate the baseline failure, the smallest change must pass the same scenario, and refactoring must close newly observed loopholes without regressing prior cases. Methodology cannot rewrite itself from an untested model suggestion.

Refinement defaults to session-local scope. Global edits require an explicit user request or previously authorized durable-learning policy and must satisfy the existing global-scope rules. Applied refinements retain the current transactional, conflict-detection, history, and rollback behavior.

A skipped or failed refinement is recorded and does not erase valid implementation evidence. At intermediate checkpoints, the planner continues. At the final checkpoint, independent verification remains valid and the workflow may complete with the refinement failure disclosed.

The canonical knowledge and optional MemPalace behavior are defined in `2026-08-13-knowledge-refinement-design.md`. Prime Agent's typed ledger is authoritative. MemPalace is an optional local semantic/verbatim index and recall adapter; it is never the only copy or the authority for workflow state. Knowledge/refinement proposers, verifiers, red teams, evidence, canonical records, and index operations are local-only with `egress = none`. A workflow's separately approved cloud envelope does not authorize memory content or evidence to enter a remote model request; the first release has no memory-egress authority path.

## Native AutoResearch Specialization

Native AutoResearch uses this workflow, decision, evidence, capacity, and refinement kernel with stricter experiment invariants defined in `2026-08-13-autoresearch-design.md`:

- one user-approved primary numeric metric and target;
- a pinned evaluator, parser, editable scope, base revision, budget, and protected guards;
- candidate-specific Git worktrees and evaluator processes;
- parallel exploit and explore candidate roles with immediate safe refill;
- durable leases, reconcile, and reap;
- serialized frontier admission against the current known-good baseline;
- stale-candidate rebase and remeasurement before comparison;
- independent reproducibility evidence and red-team checks for leakage, gaming, overfit, duplication, and stale results; and
- immutable candidate and result ledgers with no blind replay.

A numeric improvement alone never authorizes candidate admission. The full decision gate must also accept correctness, scope, guard, authority, and reproducibility evidence.

## Cancellation and User Pauses

User pause stops new dispatch. Running tasks are allowed to reach the next safe host boundary, then their state is persisted. Resume always starts with a fresh planner context.

Approval pause differs from a user pause: it records a specific question and accepts exactly one response before continuing. It never auto-resumes after restart.

Cancellation is a fenced multi-step transition. The host first stops new
dispatch, records a non-terminal cancellation intent in the recovery operation,
and fences the current coordinator epoch. It then enumerates the full admitted
descendant graph from the journal and admission registry, terminates and reaps
every owned process group and provider callback where enforceable, waits for
each descendant to be observed terminal or explicitly quarantined, reconciles
all attempts and resource/ownership leases, and records the descendant-set
digest plus reconciliation outcomes. Any missing, still-running, or ambiguous
descendant keeps the goal binding and workflow out of the terminal cancellation
transition and enters recovery/user input. Only after the full descendant
fence and reconciliation barrier commits may the host append terminal
`cancelled` and release the workflow binding. GoalState remains paused and is
updated only by the idempotent projection CAS; cancellation never clears or
falsely completes the goal. Transcripts, artifacts, journal records, and
workspace changes remain intact for inspection. A cancelled workflow itself
cannot resume.

## Compatibility Classification

The first release is designed as backward-compatible without a daemon wire change:

- slash commands execute inside the existing session prompt path;
- command-line workflow startup translates into an existing prompt after normal session creation;
- workflow status is represented through existing custom transcript messages and snapshots;
- child creation, messaging, observation, and recovery use existing daemon capabilities;
- workflow artifacts use a separately versioned on-disk format.

If implementation discovers that a daemon command, event, response shape, or startup dependency must change, that change must be redesigned as capability-gated or incompatible before implementation continues. It must update protocol versions or schema revisions as required, compatibility maps, and both new-client/old-daemon and old-client/new-daemon tests.

## Success Criteria and Evidence

The implementation is accepted only when the following behaviors have direct evidence:

D-01. Explicit start creates a bound goal and durable workflow journal.
D-02. Preflight records observable local capacity, asks for cloud availability, and treats unknown cloud quota, pricing, region, and authority as zero.
D-03. No substantive dispatch occurs until a typed scorecard and resource envelope each survive verification, red team, and user approval.
D-04. Goal hardening detects a material scope change and pauses for exact user approval.
D-05. Every decision kind produces one current fresh-context red-team artifact before host acceptance.
D-06. Proposal, evidence, lens, synthesis, or red-team failure leaves authoritative state unchanged.
D-07. Stale, forged, duplicated, expired, wrong-digest, and wrong-revision verdicts are rejected.
D-08. Concurrent overlapping decisions trigger compare-and-swap conflict and new gating; disjoint decisions may commit concurrently.
D-09. A skill-required approval persists across root worker and daemon restart.
D-10. Approval response resumes in a fresh planner context only after its bound
    one-use secret proof passes; missing, wrong, transplanted, stale, and racing
    proofs fail, and duplicate responses are rejected idempotently.
D-11. Host provenance detects a changed skill revision, omitted invocation, forged gate, and approval bypass.
D-12. Independent tasks overlap in wall-clock execution when their enforced ownership and resource vectors permit it.
D-13. Dependency-related, ownership-conflicting, resource-incompatible, and unenforceable write-capable tasks do not overlap.
D-14. The scheduler fills every safe ready-fit slot, immediately refills released slots, and records truthful limiting-pool reasons for idle capacity.
D-15. Control-plane reserve admits planning, audit, verification, and recovery while workers are saturated; its `WorkflowControlCapacityVector` hard dimensions remain disjoint from worker grants.
D-16. Resource accounting never exceeds the approved envelope under retries, continuations, cancellation, throttling, or crash recovery; `WorkflowTaskGrant`, resource admission, leases, partitions, observations, and adaptive allocations reconcile every control-vector component by CAS.
D-17. No-op, duplicate, unrelated, sleep, or proxy-only work can satisfy progress or utilization evidence.
D-18. A planner cycle follows every completed wave, interruption, rejected claim, verifier failure, completion-audit failure, and applied refinement.
D-19. Ending a phase context without a structured outcome cannot complete the phase, decision, or workflow.
D-20. A progress auditor rejects weakened or deleted tests, hardcoded success, stale evidence, unrelated churn, mock-only claims, proxy-only improvements, and scorecard mutation.
D-21. Rejected progress returns to planning with durable findings and failed approaches.
D-22. Worker self-report and worker-authored tests alone cannot satisfy a dependency before independent progress-audit acceptance.
D-23. An unchanged contract/plan/workspace/evidence cycle is rejected, consumes a finite revision attempt, and cannot spin as recorded progress.
D-24. A blocker cannot terminate work without a stable host-owned blocker identity,
    three independently audited consecutive goal turns, mechanically exhausted
    registered safe alternatives, zero remaining alternatives, and adversarial
    false-blocker review; fresh prose or artifacts cannot reset the counter.
D-25. Parallel out-of-ownership writes, symlink escapes, generated-output collisions, and late descendant writes are denied or invalidate the attempt before acceptance.
D-26. Killing a worker at each dispatch journal boundary produces reconciliation and no blind replay or duplicate external effect.
D-27. Live workers are reattached after root recovery; uncertain effects and resource leases remain quarantined.
D-28. A replacement coordinator fences the prior epoch; a split-brain stale coordinator cannot journal, dispatch, approve, or release resources.
D-29. Journal replay rejects broken hash chains and stale epochs, and ignores truncated events and unreferenced artifacts without inventing success; only a final prepared frame that is provably uncommitted may be quarantined as uncommitted.
D-30. A fresh verifier prevents completion without independent current outcome evidence.
D-31. A fresh completion decision can return the workflow to planning after recon, lenses, verification, synthesis, and adversarial challenge.
D-32. Per-context limits cause a fresh context, not workflow termination.
D-33. Token, time, request, rate, cost, egress, or other hard budget exhaustion durably prevents the next substantive charge or dispatch.
D-34. Intermediate and final refinement reviews consume only audited evidence, accept empty edits, and never learn from failed or unverified claims.
D-35. Memory and refinement red teams reject one-off history, unsupported hypotheses, secrets, private-source leakage, duplicates, poisoning, and over-broad scope.
D-36. Methodology changes cannot apply without baseline failure evidence, pressure-test success, version compare-and-swap, reload verification, and rollback metadata.
D-37. AutoResearch rejects candidates with better primary metrics when guards fail, evaluation is stale/non-reproducible, scope changed, or gaming/leakage is detected.
D-38. AutoResearch worktree candidates run in parallel within the resource envelope while frontier admission remains serialized and remeasures stale candidates.
D-39. Completed workflows retain inspectable contracts, scorecards, resource envelopes, decisions, plans, handoffs, evidence, audits, usage, refinement, and memory outcomes.
D-40. Workflow pause, budget, failure, cancellation, resume, replacement, and completion preserve the defined bound-goal state mapping.
D-41. Existing non-workflow goals, autonomous sessions, skills, subagents, recovery, and ordinary lightweight coding behavior remain unchanged.
D-42. Approval races across messages, clients, restarts, and coordinator
    replacement consume at most one current `approvalRequestId`; the stored
    token hash, trusted principal, signed headless artifact (when supported),
    and exact digests prevent approval of a stale or changed decision. Ordinary
    messages and `/workflow resume` leave pending approvals untouched.
D-43. A durable attempt key survives admission and root restoration; a live child is reattached or an ambiguous child remains quarantined without duplicate dispatch.
D-44. Fencing a coordinator terminates and reaps its owned process groups where enforceable; a stale descendant or provider callback cannot commit a host-controlled effect under the old epoch.
D-45. Verification rejects changed evaluators, parsers, guards, fixtures, test discovery, and held-out inputs, including mutations hidden in generated or ignored files.
D-46. Changing a required skill or declared dependency byte invalidates its snapshot, invocation token, gate evidence, and any decision that depended on it.
D-47. Journal tests cover canonical encoding, duplicate keys, authenticated writer identity, concurrent append attempts, interior corruption, directory durability, and quarantine without invented state.
D-48. Cloud/account tests cover billing lag, rate-limit lag, provider-side idempotency, region and egress authority, credential redaction, and uncertain termination without exceeding the approved envelope.
D-49. Refinement tests cover concurrent semantic writers, corrupt canonical state, transaction interruption, poisoning, and held-out executable pressure tests without partial application or empty-state overwrite.
D-50. Ordinary direct sessions never activate a workflow; inline and parallel
    profiles persist in journal state and enforce identical decision, evidence,
    recovery, completion, and refinement contracts.
D-51. A profile recommendation is based on the accepted graph and measured
    capacity, but only exact plan/resource approval selects it; a mid-run profile
    change creates a material revision.
D-52. Every material transition and interruption produces a bounded continuity
    capsule; stale, forged, wrong-config, or wrong-journal capsules are rejected
    and regenerated without mutating authoritative state.
D-53. A fresh planner can resume from a valid capsule plus referenced evidence
    without raw conversation replay, status documents, or canonical-memory
    pollution.
D-54. A handoff missing outcome, ownership, upstream decisions,
    interfaces/dependencies, rationale, invariants, layered evidence,
    escalation, or pre/post digests cannot advance a requirement; activity
    volume is ignored; `escalation` is required and may be null only when the
    handoff outcome and acceptance applicability prove that no escalation is
    needed.
D-55. Worker, lease, approval, evidence, and recovery events recompute the ready
    set and refill capacity without model polling; unchanged observations
    produce no turns or progress artifacts.
D-56. Workflow settings migrations are ordered and mode-preserving, reject
    unknown newer schemas, symlinks and drift, preserve unrelated keys, and
    recover from every prepared/apply/verify boundary using a digest manifest.
D-57. Active workflows remain pinned to exact config, skill, manifest, and
    evaluator digests; an upgrade or settings edit cannot alter them without an
    approved revision.
D-58. Continuity/progress projections, project diaries, automatic documentation
    reconciliation, and closure reports never become a second ledger or an
    automatic project commit.
D-59. A bounded direct repair lane handles only routine findings inside the
    approved scope/lease and skips only root replanning, never the universal
    decision or red-team gate; material, ambiguous, security, migration,
    contract, authority, or repeated failures return to the root pipeline.
D-60. Cancellation enumerates every admitted descendant, fences and reaps each
    process group/callback where enforceable, reconciles still-running and
    ambiguous attempts and all leases, and refuses to unbind the goal until the
    full descendant-set barrier is durably committed.
D-61. A child with shell, IPython, edit, or recursive-spawn capability is treated
    as write-capable; non-root recursive child creation is rejected, and shared
    write-capable work is serialized or isolated until host brokers exist.
D-62. Goal transition tests show journal event first, idempotent `GoalState` CAS
    projection second, direct bound-goal mutation rejection, and daemon child
    registry observations that cannot authorize state.
D-63. Fresh-stage tests verify distinct identities, immutable input/output
    boundaries, independence limitation records, and rejection of verdicts
    whose declared provenance or charter is reused; clean-room checks retain a
    pinned-source provenance digest and CI report with no linked-source payloads
    or distinctive text in packaged or generated outputs.
D-64. A caller that labels a write, external effect, authority change, or scope
    change as non-material cannot weaken the gate: the host recomputes the closed
    effect/materiality classification from the concrete operation and state, and
    unknown classifications fail closed before mutation.
D-65. Every admitted workflow, requirement, strategy, planner cycle, task attempt,
    and effect-recovery class has an approved finite ceiling. Omitted values cause
    conservative finite host proposals, never infinity; exhaustion records
    `budget_limited` before another substantive charge, dispatch, or analysis turn.
D-66. Declared resource underreporting cannot create capacity. The host reserves the
    component-wise conservative maximum of declared and observed requirements;
    unknown or unenforceable consumption receives `exclusive_unisolated` admission
    and serializes against conflicting work; it cannot consume any reserved
    `WorkflowControlCapacityVector` dimension.
D-67. A one-run metric is rejected without a host determinism attestation, immutable
    input closure, and zero variance. Repeated and held-out policies preserve every
    run, apply only the approved aggregation/tolerance, and reject excess variance
    or a lucky single trial before progress or completion acceptance.
D-68. Interactive approval without the exact one-use secret proof and signed
    headless approval with a stale epoch, wrong trusted principal, or changed
    decision/config/artifact digest are rejected without consuming or advancing
    the pending decision.
D-69. Child, phase, capability, repair, approval, lease, and knowledge mutations
    require canonical workflow/epoch-qualified references. Bare or stale IDs from
    a prior coordinator or store generation cannot append, release, authorize, or
    mutate state.
AD-01. While a goal is active, task, phase, result, lease-release, and material
    evidence events produce host-observed adaptive observations containing the
    verified critical path, queues, evidence gaps, blockers, throughput/latency,
    marginal verified progress/resource, uncertainty, live leases, and control
    reserve; telemetry or model prose cannot mark a requirement proven.
AD-02. Every adaptive allocation proposal reruns recon, independent lenses,
    evidence verification, synthesis, red team, and the host gate against the
    exact current observation, then shifts only ownership-compatible capacity
    to a verified bottleneck inside the approved envelope; an unchanged
    observation is a durable no-op with no model polling loop.
AD-03. Adaptive state/events use epoch-qualified observation and allocation CAS;
    stale observations, leases, workspace/config digests, duplicate execution
    keys, and wrong revisions are rejected without allocation changes.
AD-04. Hysteresis, minimum observation windows, cooldowns, finite reallocation
    counters, and bounded priority-bucket aging/promotion prevent thrash or
    starvation; every fairness/hysteresis number is finite, positive, and
    range-validated, while verifier/red-team/control-plane reserve remains
    available when worker capacity is saturated.
AD-05. Unknown capacity is zero and declared resource under-reporting cannot create
    capacity; local/cloud/spend/egress/credential/authority/envelope expansion
    requires an exact user approval and never occurs from an idle or inferred
    pool. A single `WorkflowCanonicalPoolLedger` separates instantaneous
    concurrency from cumulative spend with exhaustive components; every
    discriminated worker/control `WorkflowCapacityGrant` and hard
    `WorkflowControlCapacityVector` is component-wise reconciled in admission,
    leases, grants, partitions, observations, and allocation CAS;
    `exclusive_unisolated` work cannot consume its reserved dimensions.
AD-06. Crash tests around adaptive observation, lease release, allocation CAS,
    provider usage, and rollback restore the last committed safe allocation or
    quarantine and reconcile the uncertain effect without blind replay.
AD-07. After every phase, incident, and completion gate, a bounded improvement
    review routes durable, native, AutoResearch, and knowledge proposals through
    the generic discriminated proposal/review/result/event lifecycle; the
    host-owned scorecard freezes preregistered cases, required samples,
    effect/tolerance, hidden holdout/digest, non-regression, cost/latency,
    metric direction, aggregation, variance/repeatability, deterministic risk,
    and stage-scoped holdout commitments, and the proposer cannot choose or
    omit a holdout; it never self-scores progress or writes from an unverified
    claim.
AD-08. Improvement candidates compare the approved baseline with same-case and
    held-out/replay/canary evidence, receive independent Goodhart/regression/
    safety red-team review, and promote atomically by registry epoch CAS with
    `rollbackOf`/event sequence, reload verification, and future-load
    verification or remain rejected; missing required samples, hidden holdout
    digest, predicates, or cost/latency bounds fail closed.
AD-09. Future workflows load only approved, compatible revisions; rejected, stale,
    unverified, or rolled-back workflow/methodology/policy revisions cannot
    become active through canonical knowledge or an optional index. Registry
    compatibility closure, discriminated scope binding with session/knowledge
    decision refs, status, and epoch/event CAS are checked before phase/effect.
    A `revisionKind:"knowledge"` entry requires the `scope:"knowledge"`
    binding, exact session- or workflow-scoped `knowledgeDecisionRef`, and
    matching `knowledgeEntryRef`; the host resolver rejects kind/scope or
    decision mismatches and cannot widen authority. Superseded/revoked entries
    fence affected work, leases, approvals, and caches while pinned bytes
    remain for audit.
AD-10. Canonical knowledge records retain how/why/provenance and decision evidence;
    optional MemPalace projections remain local indexes and neither can authorize
    allocation, resource expansion, workflow state, or completion.
AD-11. Native methodology and AutoResearch adaptive hints are consumed through the
    generic kernel contracts: AutoResearch keeps its fixed objective/metric/guard,
    and native role hints cannot bypass the host gate or approval envelope.
AD-12. First-release tests prove bounded local adaptation, finite controller/review
    ceilings, explicit cloud-adapter prerequisites, no daemon wire change, and
    no resident infinite loop; hosts without enforceable capacity serialize or
    stop rather than claim optimal scheduling.
AD-13. An approved resource envelope contains a trusted `cron` clock/cadence and
    monotonic clock observation/sequence with persisted last-admitted window,
    major-transition trigger set, exactly-once window policy, one-restart
    catch-up rule, bounded reviewer resource/token/cost reserve, and positive
    finite cadence/duty-cycle/per-window/phase/workflow ceilings; changing any
    schedule field creates a new decision and exact approval request.
AD-14. Each `cron` review receives a fresh, independent, read-only snapshot of the
    host-resolved critical path, queues, leases, cost, latency, accepted
    progress, evidence gaps, uncertainty, and control reserve, plus immutable
    objective/contract/scorecard/invariant/plan/critical-path/config/evaluator/
    guard/registry refs and digests. Host dereference and stale rejection precede
    review; the invocation binds reviewer child identity, read-only capability
    proof, admission/leases, epoch, execution key, and token, and its typed
    success/failure result records actual usage. It checks underuse, overuse,
    redundancy, serializable work, context churn, verifier/red-team starvation,
    review overhead, cloud cost, and Goodhart risk.
AD-15. `cron` suggestions are immutable evidence-only artifacts with zero write,
    lease, allocation, approval, or completion authority; applying one starts a
    new full universal decision/approval pipeline and never applies directly.
AD-16. Window CAS rejects overlapping, backward, duplicate, or replayed window
    sequences and coalesces major-transition triggers; after restart exactly one
    validated catch-up can run and missed backlog is discarded without a
    model-turn or resource storm.
AD-17. A reviewer failure, timeout, stale snapshot, malformed output, or unavailable
    context is nonblocking, consumes only its bounded reserve, leaves the last
    safe allocation unchanged, and cannot starve verifier, red-team, recovery,
    or control-plane work; review admission remains latest-wins with one pending,
    one active, superseded cancellation, a duty-cycle cap, finite per-window/
    phase/workflow limits, and a dedicated reserve that cannot consume planner
    or verifier capacity.
AD-18. Replaying an adaptive observation on the same accepted DAG, typed
    host-derived remaining-work estimates, host-observed novelty proofs, and
    scheduler-policy digest produces the same independently admitted
    critical-path certificate and lexicographic ordering:
    time-to-genuine-proof, evidence gap, cost, uncertainty, queue age, then
    task ID/digest.
AD-19. Every adaptive entry binds task, attempt, resource lease, ownership lease,
    discriminated capacity grant, and a host task-value certificate; only
    `unclaimed` entries move in place, while claimed/active entries are fenced,
    reconciled, and replaced by a new attempt and lease.
AD-20. Capacity, usage, billing, and rate-limit refs are authenticated,
    monotonic, and TTL-bound; stale, expired, unauthenticated, or unknown
    state resolves to zero at allocation CAS, including provider charges.
AD-21. Process, session, model-call/token, and recovery control partitions remain
    hard and cannot be borrowed by workers; `exclusive_unisolated` work is
    isolated/serialized away from the control plane.
AD-22. Crash injection before every adaptive applied marker proves that intent is
    reconciled through broker nonexecution evidence or fenced idempotent effect
    reconciliation for allocations, leases, and provider charges; no blind
    replay or premature capacity release occurs.
AD-23. Fairness aging, last-served state, bounded priority-bucket promotion,
    finite exploration quota, numeric benefit threshold, minimum dwell,
    transition cap, and safety-only override survive restart and prevent
    starvation or allocation thrash; all persisted values are finite and
    range-validated.
AD-24. Expired lease reclaim occurs only with strong host/provider nonexecution
    proof; otherwise a finite deadline records terminal escalation rather than
    requiring an indefinite user reap.
AD-25. Rapid observations coalesce to one latest pending and one active review;
    superseded pending work is cancelled and a fenced active result cannot
    apply after supersession.
AD-26. Every task dispatch has an independently admitted host task-value
    certificate naming an unproven requirement/evidence gap, host-observed
    novelty/nonduplicate proof, typed bounded observable outcome, and finite
    exploration quota; uncertified proxy work is rejected.

Verification will use focused tests from `packages/coding-agent` with the existing session harness and faux provider. Crash and recovery behaviors require real daemon worker processes and durable files; mock-only recovery evidence is insufficient. After code changes, the full repository check must complete with no errors, warnings, or informational findings.

## Implementation Boundaries

The implementation should introduce narrowly scoped modules under
`packages/coding-agent/src/core/workflow/` for types/contracts, the hash-chained
journal and reducer, decision records and gate, approval tokens, scorecard
validation, capacity discovery and tree-wide leases, immutable skill
snapshots/manifests, profile selection, task-graph validation, the fenced
effect/mutation broker, scheduling, structured worker handoffs, evidence, phase
hosting, continuity/progress projections, runtime config/migrations, and recovery
reconciliation. `AgentSession` should coordinate these modules rather than absorb
their internal logic.

The concrete first-release module boundaries are:

```text
packages/coding-agent/src/core/workflow/
  contracts.ts
  journal.ts
  reducer.ts
  decision-gate.ts
  approvals.ts
  scorecard.ts
  resources.ts
  skill-snapshots.ts
  profile.ts
  task-graph.ts
  scheduler.ts
  effect-broker.ts
  worker-handoff.ts
  evidence.ts
  phase-host.ts
  continuity-capsule.ts
  projections.ts
  config.ts
  migrations.ts
  recovery.ts
```

Session artifacts are resolved through the existing session manager. Existing
session custom entries, goal state, context snapshots, event bus, and daemon
recovery journals may expose or trigger projections but never become workflow
authority. Explicit slash/CLI entry uses the existing prompt transport; profile
or workflow fields are not added to daemon session creation.

Native AutoResearch belongs under `packages/coding-agent/src/core/autoresearch/` and depends on the workflow interfaces rather than duplicating them. Native methodology remains distributed as versioned built-in skills plus host-observable contracts. Canonical knowledge and optional MemPalace integration extend the existing refinement boundary rather than replacing it.

Every changed line must serve the workflow contract above. Existing goals, autonomous logic, child runtime, skill loading, recovery journals, and refinement code should be extended only at required integration points.
