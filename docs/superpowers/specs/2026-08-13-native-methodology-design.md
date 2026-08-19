# Native Superpowers Methodology Design

Date: 2026-08-13
Status: Approved by the user for implementation planning; implementation not started
Approval baseline SHA-256: dc8fe0160fdd13a890f98c5feae7783365e559ec42c240c4c61d39b46771ac8f
Source snapshot: /Users/nathanballou/Documents/GitHub/superpowers
Source version: 6.2.0
Source description: v6.2.0-5-gb6b5897
Source commit: b6b58974aa8c731d7c160975959a0e62777975c6
License: MIT (Copyright (c) 2025 Jesse Vincent)

## Approved clarification/addendum (2026-08-14)

This approved clarification supplements the 2026-08-13 native methodology
design. The original approval status and `Approval baseline SHA-256` above are
preserved exactly; this addendum does not authorize implementation, vendor
replacement, or a larger resource/cloud/spend/authority envelope.

Native methodology participates in the kernel's bounded adaptive controller.
While a durable goal is active, phase and role contexts report demand hints and
host-observed evidence about the verified critical path, queue age, evidence
gaps, blockers, throughput/latency, marginal verified requirement evidence per
resource, uncertainty, live leases, and control reserve. The methodology never
self-scores progress or treats activity, utilization, worker count, or a model
claim as proof. The kernel re-runs the universal recon/lens/verification/
synthesis/red-team/host gate after each task, phase, result, lease release, or
material evidence transition that could change allocation, then shifts only
inside the approved envelope and toward a verified bottleneck. Hysteresis,
minimum windows, finite review/phase ceilings, and reserved verifier/red-team/
control capacity prevent thrash or starvation.

Every phase, incident, and completion gate also produces a bounded continual-
improvement review from accepted evidence. A small methodology/workflow/policy
revision must pass baseline plus held-out, replay, or canary pressure cases,
independent Goodhart/regression/safety red-team review, and atomic version CAS
with reload and rollback metadata. Future runs load only approved compatible
revisions. Canonical knowledge stores the resulting how/why/provenance; an
optional MemPalace projection indexes those records only and cannot authorize a
phase, allocation, approval, resource expansion, or completion.

A recurring independent efficiency-red-team reviewer, `cron`, may inspect
native phase placement only through the kernel-approved schedule. Its trusted
clock/cadence, major-transition triggers, exactly-once window, one-restart
catch-up, and bounded overhead reserve are included in the resource envelope;
schedule changes are new decisions. Each review receives a fresh read-only
host-resolved snapshot of critical path, queues, leases, cost, latency,
verified progress, and evidence. It checks underuse, overuse, redundancy,
serializable work, context churn, verification starvation, review overhead,
cloud cost, and Goodhart risk. It produces immutable suggestions with zero
write, lease, allocation, approval, or completion authority. Applying one
requires the full universal decision and exact approval; a failed or late
review is recorded without blocking native work, and only one catch-up review
may run after restart.

The generic kernel owns adaptive allocation state/events, leases, ceilings,
cloud/spend/authority approval, recovery, and rollback. This document owns
native phase/role demand hints and methodology pressure evidence. The first
release adapts observable local capacity and already approved adapters only; it
does not add a resident infinite daemon, infer unknown capacity, expand an
envelope, or change daemon wire behavior. Envelope/cloud/spend/authority
expansion always returns to the exact user approval gate.

## Summary

Prime Agent will vendor the portable methodology skills from the user's
Superpowers fork as native, versioned host-routed skills. A
host-owned methodology coordinator will enforce observable phase contracts,
durable approvals, task ownership, review barriers, and provenance. The skill
files remain the adaptable methodology. The host never turns their prose into
an implicit parser and never creates a second model runtime.

The methodology specializes the durable workflow and universal decision kernel
described in 2026-08-13-durable-workflows-design.md. It reuses AgentSession,
the existing ResourceLoader, RLM child sessions, session artifacts, daemon
recovery, autonomous continuations, and continual-harness refinement.

The native lifecycle is:

~~~text
kernel capacity/scorecard/goal preflight and approval
  -> activation
  -> brainstorming and design artifact
  -> design/spec review and user approval
  -> writing plan and plan review
  -> user execution approval
  -> widest-safe implementation waves
       -> TDD or systematic-debugging contract
       -> task spec + quality review
       -> bounded fix rounds
       -> combined-suite barrier
  -> final whole-branch review
  -> independent verification
  -> completion red team
  -> branch-finishing approval and verified disposition
  -> optional audited refinement
  -> host completion
~~~

Every transition that changes trust or durable state passes the shared
recon, independent-lenses, evidence-verification, synthesis, adversarial
red-team, and host-gate pipeline. A model can propose an outcome, but only the
host can authenticate it, append it to the workflow journal, and apply it.

## Context and assumptions

This design assumes the unified durable workflow kernel owns generic workflow
state, fencing, decision records, resource accounting, journal replay,
reconciliation, and the universal gate. This document owns the native
development methodology that consumes those interfaces.

Existing Prime Agent boundaries remain authoritative:

- GoalState remains the durable objective and aggregate usage record.
- AgentSession remains the owner of prompts, host requests, transcript writes,
  child lifecycles, and resource-loader access.
- ResourceLoader remains authoritative for skill precedence and discovery.
- RLM child runtimes provide fresh contexts; an rlm admission handle never
  substitutes for a child result.
- SessionManager.getSessionArtifactDir() remains the artifact root.
- CommandRecoveryJournal semantics inform, but do not replace, the workflow
  journal.
- planRefinement and applyRefinementProposal remain the refinement transaction
  boundary.

No ordinary session behavior changes merely because the snapshot is installed.
Bootstrap and discipline-enforcing methodology skills are hidden from the ordinary
model catalog through a host-level no-model-invocation flag. They are loaded only by
an explicit workflow phase or an exact user `/skill:` invocation. Automatic
workflow activation is deferred; it cannot be enabled by prompt text, skill prose,
or a mutation that already occurred.

Hidden visibility is a host prerequisite, not a convention that a model or skill
is expected to follow. Before activation or any discipline-skill invocation, the
host must verify and journal a `NativeSkillVisibilityPrerequisite` for the exact
skill set. If the host cannot enforce the hidden catalog view, workflow startup
fails closed; a skill instruction, prompt phrase, or model claim cannot satisfy
this prerequisite.

## Goals

The first native methodology release will:

1. Bundle the fork's portable skills and all supporting references directly in
   the coding-agent package.
2. Preserve the fork's MIT license, copyright notice, source revision, and
   release provenance in source and package artifacts.
3. Keep skill prose versioned and replaceable through normal resource precedence
   while keeping host contracts stable and ordinary model catalogs unaffected.
4. Make activation behavior explicit and backwards-compatible.
5. Enforce brainstorming, design approval, written planning, debugging, TDD,
   parallel waves, reviews, verification, and branch-finishing approval through
   typed observable contracts.
6. Dispatch the widest safe wave of independent work while serializing
   dependency, ownership, authority, and resource conflicts.
7. Give every phase and worker a fresh context and durable artifact handoff.
8. Authenticate the exact skill digest, invocation, gate token, and decision
   provenance used by every accepted phase.
9. Allow continual refinement to change methodology only after audited evidence
   and writing-skills RED/GREEN/REFACTOR pressure tests.
10. Recover after daemon, worker, context, or coordinator failure without
    replaying uncertain side effects.
11. Preserve ordinary goals, autonomous runs, skills, subagents, and daemon
    protocol compatibility.

## Non-goals

This design does not:

- parse SKILL.md prose, reviewer prose, or model prose to infer host state;
- register or run harness-specific hooks, telemetry, plugins, or visual servers;
- replace Prime Agent's RLM runtime, IPython bridge, session manager, or skill
  precedence rules;
- require every ordinary question or read-only session to enter a workflow;
- auto-approve design, plan, skill, destructive, publication, or branch
  finishing gates;
- silently rewrite a user or project skill to match the bundled methodology;
- let refinement edit the vendored snapshot in place;
- use model-authored completion percentages or worker self-report as proof;
- let workers commit, push, merge, post messages, or broaden authority; or
- add a daemon command, event, response shape, or startup dependency in the
  first release.

## Source snapshot and packaging

### Vendored layout

The pinned source snapshot is copied, preserving relative paths, into the
package's existing built-in skill tree:

~~~text
packages/coding-agent/skills/superpowers/
  skills/
    brainstorming/
    dispatching-parallel-agents/
    executing-plans/
    finishing-a-development-branch/
    receiving-code-review/
    requesting-code-review/
    subagent-driven-development/
    systematic-debugging/
    test-driven-development/
    using-git-worktrees/
    using-superpowers/
    verification-before-completion/
    writing-plans/
    writing-skills/
    ...supporting files...
  LICENSE
  THIRD_PARTY_NOTICE.md
  RELEASE-NOTES.md
  SOURCE.json
~~~

The vendor manifest has separate, explicit path sets. Every Markdown guidance
file below `skills/` is included, including reviewer prompts, examples,
creation logs, and visual-companion documentation. Every non-Markdown helper
or executable-looking support file below `skills/` is included only in
`referenceOnlyPaths`; this covers `scripts/**` plus `.sh`, `.js`, `.cjs`,
`.ts`, `.html`, and `.dot` files. They are never registered as executable host
tools. The manifest's `excludedPaths` applies only outside the imported
`skills/` tree, including `.git/**`, plugin manifests, and top-level hooks. A
vendor check fails if any source path below `skills/` matches neither
`includedPaths` nor `referenceOnlyPaths`, or if a path matches both after the
reference-only classification takes precedence.

The visual companion documentation and server/launcher bytes are therefore
present for an exact, reviewable snapshot, but every executable asset is
`reference_only`. The manifest records that the assets are included while the
runtime capability is unavailable and execution is denied; the host does not
invent a substitute transport.

Preserving a source file or its mode is not execution authority. In the first
release every imported support script, hook reference, helper, server launcher,
and lifecycle command is `reference_only`: it is not registered as a tool and
cannot be executed by a phase. All writes, tests, pressure runs, child dispatch,
configuration changes, and Git effects use host-owned typed adapters with the
current decision, lease, and repository-policy checks. A later support-script
allowlist would require a separate manifest revision, source/dependency digest,
effect declaration, sandbox review, red team, and acceptance test; no imported
file is grandfathered because it was executable upstream.

SOURCE.json is generated from the fork and contains:

~~~json
{
  "name": "superpowers",
  "version": "6.2.0",
  "sourceRepository": "https://github.com/nathanballou/superpowers.git",
  "upstreamRepository": "https://github.com/obra/superpowers.git",
  "sourceCommit": "b6b58974aa8c731d7c160975959a0e62777975c6",
  "license": "MIT",
  "copyright": "Copyright (c) 2025 Jesse Vincent",
  "importedPaths": ["skills/"],
  "includedPaths": [
    "skills/**/*.md"
  ],
  "referenceOnlyPaths": [
    "skills/**/scripts/**",
    "skills/**/*.sh",
    "skills/**/*.js",
    "skills/**/*.cjs",
    "skills/**/*.ts",
    "skills/**/*.html",
    "skills/**/*.dot"
  ],
  "excludedPaths": [
    ".git/**",
    "plugin-manifests/**",
    "hooks/**"
  ],
  "visualCompanion": {
    "assetsIncluded": true,
    "execution": "denied",
    "runtimeCapability": "unavailable"
  },
  "vendorFormat": 1
}
~~~

The existing copy-assets step copies skills/ to dist/skills/. The vendor check
must verify that the nested snapshot survives both source-checkout and packaged
layouts. The existing recursive ResourceLoader discovers the nested skills, so
no second discovery mechanism is introduced.

### Attribution and license obligations

The exact upstream LICENSE file is shipped at the vendor root and is never
rewritten by the sync process. A package-local THIRD_PARTY_NOTICE.md identifies
the embedded snapshot, source and upstream repositories, commit, license,
copyright holder, imported path, and the fact that Prime Agent's host contracts
are original integration code. A repository-level THIRD_PARTY_NOTICES.md may
repeat that attribution for source-tree readers, but the package-local file is
normative because root files are not guaranteed to be included in a published
package. The coding-agent README and skills documentation link to the packaged
notice.

The vendor script fails if LICENSE is absent, if its MIT permission and
copyright text differ from the source snapshot, if SOURCE.json disagrees with
the copied files, or if a package archive omits either the package-local notice
or license.
Prime Agent remains MIT-licensed; the vendored MIT material is attributed
separately and is not relabeled as Prime Agent-authored.

## Default activation policy

The default configuration is enabled with explicit activation:

~~~typescript
interface NativeMethodologyConfig {
  enabled: boolean; // true
  mode: "explicit" | "off"; // "explicit"
  requireDesignApproval: boolean; // true
  requirePlanApproval: boolean; // true
  maxFixRounds: number; // 5
  allowAutomaticUserApproval: false;
  refinementScope: "local" | "explicit-global"; // "local"
  vendorPolicy: "pinned" | "resolved"; // "pinned"
}
~~~

The host accepts only `maxFixRounds` values from one through five; a
configuration cannot weaken the required design, plan, verification, or user
approval gates.

| Context | Native skills | Host enforcement | Default result |
| --- | --- | --- | --- |
| Read-only question or inspection | Hidden from model; user-listable | No workflow phase | Existing behavior |
| Ordinary coding session | Hidden from model; exact user invocation only | Existing lightweight verification rules | Existing behavior |
| /workflow start or --workflow | Required phase skills | Full strict methodology and durable workflow contracts | Workflow starts |
| Explicit /skill:methodology-name | Named skill | Scoped contract when that skill has one | Named skill runs |
| enabled: false | Hidden and not host-routed | No native activation | Explicit external skill paths keep normal rules |
| RLM child with a workflow role | Role-specific skills | Worker contract and write-set enforcement | Inherited |

Mode explicit avoids changing lightweight sessions solely because the vendor
snapshot is installed. A later automatic mode would require a separate approved
design for pre-mutation activation and compatibility; it is not part of this
release.

## Configuration and project methodology profile

Native methodology extends the existing global and project `settings.json`
precedence through one nested `workflow` object; it does not create another
configuration authority or write a project entry-point file. Bundled defaults
and skill manifests are immutable package inputs, global/project settings are
user-owned inputs, and each workflow records one immutable resolved-config
snapshot. Continuity, progress, routes, and worker prompts are generated session
projections, never configuration sources.

~~~typescript
interface NativeProjectMethodologyProfile {
  schemaVersion: 1;
  principles?: readonly string[];
  requiredSkillsByPhase?: Readonly<
    Partial<Record<NativePhaseId, readonly string[]>>
  >;
  verificationAdapterId?: ProjectVerificationAdapterId;
  preferredExecutionProfile?: "inline" | "parallel";
}

interface NativeWorkflowSettings {
  schemaVersion: 1;
  methodology?: Partial<NativeMethodologyConfig>;
  projectProfile?: NativeProjectMethodologyProfile;
}

interface ResolvedNativeWorkflowConfig {
  schemaVersion: 1;
  settingsScopeDigests: readonly string[];
  bundledDefaultsDigest: string;
  vendorManifestDigest: string;
  profile: NativeProjectMethodologyProfile;
  config: NativeMethodologyConfig;
  resolvedDigest: string;
}
~~~

Project principles and preferences constrain proposals but never grant effect,
resource, cloud, branch, or user-approval authority. A preferred profile is an
initial recommendation and still appears in the explicit plan approval. A
project profile contains stable methodology preferences only; task progress,
session history, one-off decisions, and learned procedures belong neither in
settings nor in this profile. Audited learning may propose a profile edit, but
the normal refinement and exact settings-write approval gates must accept it.

Persistent config revisions use ordered, pure schema migrations. Before a
settings mutation, the host produces an exact key-level mutation plan, validates
the current file digest under the existing settings lock, preserves unrelated
and unknown keys, writes a recoverable backup, atomically replaces and flushes
the file and parent directory, reloads it, and rolls back on verification
failure. Drift or an unknown newer schema stops with an actionable error. The
workflow never silently rewrites or commits project settings, and the first
release has no background updater or network-driven config mutation path.

User-requested skills remain required even when a phase recommends another
skill. User, project, package, and CLI resource precedence may override a
bundled skill with the same name. The host records the selected source and
digest; it does not silently substitute the bundled copy or declare an
override noncompliant because its prose differs. A replacement can satisfy a
native required phase only when its own immutable workflow manifest explicitly
declares a compatible contract version, binds the current
`NativeMinimumHostGateContract`, and passes the decision gate. Compatibility is
set inclusion: its approvals, artifact kinds, pressure tests, and allowed
transitions must contain every host-minimum requirement; an override may add gates
or narrow permissions but can never omit, weaken, or replace a minimum gate. It
never silently inherits the bundled skill's approval/artifact contract. An
override without such metadata remains usable as guidance but cannot authenticate
a required native phase.

## Host contract boundary

### Registry, not prose parsing

The host owns a finite registry of phase definitions. A registry entry names a
skill and an observable contract; it does not contain a transcription of the
skill instructions.

~~~typescript
type NativePhaseId =
  | "brainstorming"
  | "design_review"
  | "writing_plans"
  | "plan_review"
  | "systematic_debugging"
  | "tdd_red"
  | "tdd_green"
  | "tdd_refactor"
  | "wave_dispatch"
  | "task_execution"
  | "task_review"
  | "progress_audit"
  | "fix_round"
  | "suite_barrier"
  | "final_review"
  | "verification"
  | "reconciling"
  | "branch_finishing"
  | "refinement";

interface NativePhaseDefinition {
  id: NativePhaseId;
  workflowPhaseId: WorkflowPhaseId;
  requiredSkills: readonly string[];
  allowedPredecessors: readonly NativePhaseId[];
  allowedSuccessors: readonly NativePhaseId[];
  mutation: "read_only" | "task_owned" | "host_only";
  approval: "none" | "user";
  outcomeKind: "artifact" | "evidence" | "review" | "approval";
  contractVersion: string;
}

interface NativeSkillWorkflowManifest {
  skillName: string;
  contractVersion: string;
  visibilityPrerequisite: NativeSkillVisibilityPrerequisite;
  minimumHostGateContractDigest: string;
  requiredApprovals: readonly string[];
  requiredArtifactKinds: readonly string[];
  requiredPressureTests: readonly string[];
  allowedPhaseIds: readonly NativePhaseId[];
  importedSupportExecution: "deny";
  hostAdapterIds: readonly string[];
  manifestDigest: string;
}

type NativeMinimumGateId =
  | "goal_contract_approval"
  | "design_approval"
  | "plan_approval"
  | "tdd_red_green_refactor"
  | "task_review"
  | "progress_audit"
  | "suite_barrier"
  | "independent_verification"
  | "completion_red_team"
  | "branch_operation_approval"
  | "refinement_pressure_tests";

interface NativeMinimumHostGateContract {
  contractVersion: string;
  gateIds: readonly NativeMinimumGateId[];
  requiredApprovals: readonly string[];
  requiredArtifactKinds: readonly string[];
  requiredPressureTests: readonly string[];
  contractDigest: string;
}

interface NativeSkillVisibilityPrerequisite {
  kind: "host_enforced_skill_visibility";
  skillNames: readonly string[];
  modelCatalog: "hidden";
  exactUserInvocation: "allowed";
  hostCapabilityRevision: string;
}

type NativePhaseTransition = readonly [
  from: NativePhaseId,
  to: NativePhaseId
];

interface NativePhaseTransitionMatrix {
  definitions: readonly NativePhaseDefinition[];
  legalTransitions: readonly NativePhaseTransition[];
  matrixDigest: string;
}
~~~

The generic workflow state simultaneously records recon, lens, evidence-verifier,
synthesis, red-team, and host-adjudication phases and their fresh context identities.
`NativePhaseId` names methodology work layered on that state; it does not collapse
or replace the universal decision pipeline.

`NativePhaseDefinition.workflowPhaseId` is the explicit, one-way binding from
each native phase to the generic `WorkflowPhaseId`. The registry also publishes
one closed `NativePhaseTransitionMatrix`; a native transition is legal only when
its `(from, to)` pair is in that matrix and the target definition's
`workflowPhaseId` is the generic reducer transition being accepted. The contract
test enumerates every definition and matrix pair, rejects duplicate or unbound
definitions, rejects every pair outside the matrix, and verifies that journal
replay regenerates the same native projection from the accepted generic events.

The shipped registry uses this closed phase binding:

| Native phase | Generic phase |
| --- | --- |
| `brainstorming` | `hardening_goal` |
| `design_review` | `verifying_evidence` |
| `writing_plans` | `planning` |
| `plan_review` | `analyzing_lenses` |
| `systematic_debugging` | `reconnaissance` |
| `tdd_red`, `tdd_green`, `tdd_refactor` | `executing` |
| `wave_dispatch` | `dispatching` |
| `task_execution`, `fix_round`, `branch_finishing` | `executing` |
| `task_review`, `final_review` | `analyzing_lenses` |
| `progress_audit` | `auditing_progress` |
| `suite_barrier`, `verification` | `verifying` |
| `reconciling` | `recovering` |
| `refinement` | `refining` |

The table maps projection tags only. Any trust-advancing result still traverses
the generic recon/lens/verification/synthesis/red-team/adjudication phases;
the table cannot skip that decision pipeline.

`NativePhaseDefinition` and its matrix are validation tables consumed atomically
by the generic workflow reducer, not a native reducer. The native controller may
propose a phase tag and artifact, but only one generic journal event can accept
that tag and map it to the current `WorkflowPhaseId`. Native status is never
stored independently. Recovery replays the generic reducer and regenerates the
native projection; it does not reconcile two state machines.

The host-owned manifest is shipped beside each bundled methodology skill and
maps its observable gates without parsing prose. The host enforces phase
membership, state transitions, artifact presence,
workspace digests, ownership, required skill invocation, and approval tokens.
The skill decides how to reason, what questions to ask, which alternatives to
show, and how to phrase the artifact. A skill upgrade can change methodology
without a host parser update if it retains a compatible manifest, typed bridge,
and observable artifacts. A manifest change is a contract decision, not a
silent content upgrade.

Every fresh phase attempt returns exactly one typed outcome through the host
bridge:

~~~typescript
interface NativePhaseOutcomeMetadata {
  phase: NativePhaseId;
  contractVersion: string;
  skillInvocationIds: readonly string[];
}

type NativePhaseOutcome = WorkflowPhaseOutcome & NativePhaseOutcomeMetadata;
~~~

The generic discriminant remains authoritative. A native `pause` references
the separately persisted `NativeApprovalRequest` by `approvalRequestId`, and a
native `failed` outcome uses the generic `errorCode`/`retryable` fields plus an
optional error artifact. Native metadata cannot attach an approval to a
`complete` outcome or an error to a non-failed outcome.

The native type module also owns the serializable references used by every
phase. These are intentionally small: large Markdown, command output, and
review material live in durable artifacts and are addressed by digest.
All `Workflow*` base records come from the generic kernel and retain its IDs,
revisions, epochs, nonces, digests, authority, leases, expiry, and execution keys;
native serialization is a lossless tagged extension, never a parallel approval or
journal schema.

~~~typescript
interface NativeArtifactRef extends WorkflowArtifactRef {
  mediaType: string;
}

type NativeApprovalOption = WorkflowApprovalOption;

interface NativeApprovalRequest extends WorkflowApprovalRequest {
  decisionKind: NativeDecisionKind;
  question: string;
  options: readonly NativeApprovalOption[];
  phase: NativePhaseId;
}

interface NativeReviewFinding {
  findingId: string;
  severity: "critical" | "important" | "minor";
  category: string;
  statement: string;
  evidenceRefs: readonly NativeArtifactRef[];
  disposition: "open" | "addressed" | "parked" | "rejected";
}

interface NativeMethodologyError {
  code: string;
  message: string;
  retryable: boolean;
  evidenceRefs: readonly NativeArtifactRef[];
}

interface NativeDesignArtifact {
  artifactRef: NativeArtifactRef;
  objective: string;
  scope: readonly string[];
  nonGoals: readonly string[];
  assumptions: readonly string[];
  alternatives: readonly string[];
  recommendation: string;
  architecture: string;
  dataFlow: string;
  errorHandling: string;
  testingApproach: string;
  contentDigest: string;
}

interface NativeDebugEvidence {
  artifactRef: NativeArtifactRef;
  failureRefs: readonly NativeArtifactRef[];
  reproductionRef: NativeArtifactRef;
  rootCause: string;
  patternEvidenceRefs: readonly NativeArtifactRef[];
  hypotheses: readonly NativeHypothesisAttempt[];
  regressionRedRef?: NativeArtifactRef;
  failedFixCount: number;
}

interface NativeHypothesisAttempt {
  hypothesisId: string;
  statement: string;
  testRef: NativeArtifactRef;
  result: "supported" | "rejected" | "inconclusive";
}

type NativeTddPolicy =
  | {
      kind: "required";
      decisionRef: WorkflowDecisionRef;
      reason: "behavior_change" | "regression_risk" | "user_required";
    }
  | {
      kind: "exempt";
      decisionRef: WorkflowDecisionRef;
      reason: "generated_code" | "configuration_only" | "throwaway_prototype";
    };

interface NativeCommandResult {
  commandId: ProjectVerificationCheckId;
  affectedTestBindings: readonly NativeAffectedTestBinding[];
  exitCode: number;
  stdoutRef: NativeArtifactRef;
  stderrRef: NativeArtifactRef;
  workspaceDigest: string;
}

type NativeExpectedRedFailureClassification =
  | "assertion_failure"
  | "missing_behavior"
  | "expected_nonzero";

interface NativeTddRedEvidence {
  phase: "red";
  commandId: ProjectVerificationCheckId;
  result: NativeCommandResult;
  expectedFailure: {
    classification: NativeExpectedRedFailureClassification;
    observed: "expected" | "unexpected";
  };
}

interface NativeTddGreenEvidence {
  phase: "green";
  commandId: ProjectVerificationCheckId;
  result: NativeCommandResult;
  expectedResult: "pass";
}

interface NativeTddRefactorEvidence {
  phase: "refactor";
  commandId: ProjectVerificationCheckId;
  result: NativeCommandResult;
  expectedResult: "pass";
  behaviorUnchanged: true;
}

type NativeTddEvidence =
  | {
      taskId: string;
      policy: Extract<NativeTddPolicy, { kind: "required" }>;
      red: NativeTddRedEvidence;
      green: NativeTddGreenEvidence;
      refactor: NativeTddRefactorEvidence;
      affectedTestBindings: readonly NativeAffectedTestBinding[];
      focusedTestRefs: readonly NativeArtifactRef[];
      preTestDigest: string;
      preProductionDigest: string;
      postGreenDigest: string;
      postRefactorDigest: string;
    }
  | {
      taskId: string;
      policy: Extract<NativeTddPolicy, { kind: "exempt" }>;
      exemptionEvidenceRefs: readonly NativeArtifactRef[];
    };
~~~

An assistant final message is never a phase outcome. A missing, malformed,
stale, wrong-phase, wrong-digest, or tokenless outcome leaves the phase open
and records a host error.

### Kernel bridge

Prime Agent adds a host-owned Python skill named workflow as the typed bridge
for native workflow phases. It is Prime Agent integration code, not part of
the vendored MIT snapshot. Its wrappers call existing rlm.host_request and do
not own state:

~~~typescript
interface NativeReviewVerdict {
  reviewKind: "spec" | "task" | "final" | "verification";
  status: "approved" | "issues_found" | "cannot_verify" | "needs_fixes";
  findings: readonly NativeReviewFinding[];
  artifactRef: NativeArtifactRef;
}

interface NativeWorkflowHostRequestMap {
  "workflow.phase_outcome": NativePhaseOutcome;
  "workflow.skill_invocation": NativeSkillInvocationProvenance;
  "workflow.decision_proposal": WorkflowDecisionRecord;
  "workflow.tdd_evidence": NativeTddEvidence;
  "workflow.review_verdict": NativeReviewVerdict;
  "workflow.branch_finish_approval": NativeApprovalResponse;
}

interface NativeWorkflowHostAck {
  journalSequence: number;
  stateDigest: string;
}

interface NativeWorkflowHostResponseMap {
  "workflow.phase_outcome": NativeWorkflowSnapshot;
  "workflow.skill_invocation": NativeWorkflowHostAck;
  "workflow.decision_proposal": NativeWorkflowHostAck;
  "workflow.tdd_evidence": NativeWorkflowHostAck;
  "workflow.review_verdict": NativeWorkflowHostAck;
  "workflow.branch_finish_approval": NativeWorkflowSnapshot;
}

type NativeWorkflowHostRequestType = keyof NativeWorkflowHostRequestMap;

type NativeWorkflowHostRequest<
  K extends NativeWorkflowHostRequestType = NativeWorkflowHostRequestType
> = {
  [P in K]: { type: P; payload: NativeWorkflowHostRequestMap[P] };
}[K];

type NativeWorkflowHostResponse<
  K extends NativeWorkflowHostRequestType = NativeWorkflowHostRequestType
> = {
  [P in K]: { type: P; result: NativeWorkflowHostResponseMap[P] };
}[K];

interface NativeWorkflowStartRequest {
  objective: string;
  goalId?: string;
  mode?: NativeMethodologyConfig["mode"];
  requestedExecutionProfile?: "inline" | "parallel";
  maxWorkers?: number;
  scorecardDecisionRef?: WorkflowDecisionRef;
  resourceEnvelopeDecisionRef?: WorkflowDecisionRef;
}

interface NativeWorkflowSnapshot {
  workflowId: string;
  goalId: string;
  status: WorkflowStatus;
  workflowPhase: WorkflowPhaseId;
  nativePhase?: NativePhaseId;
  revision: number;
  executionProfile: "unresolved" | "inline" | "parallel";
  scorecardDigest?: string;
  resourceEnvelopeDigest?: string;
  revisionRegistryRef?: WorkflowArtifactRef;
  revisionRegistryDigest?: string;
  artifactRefs: readonly NativeArtifactRef[];
  pendingApproval?: NativeApprovalRequest;
}

type NativeApprovalResponse = WorkflowApprovalResponse;
~~~

~~~python
await workflow.phase_complete(artifact_refs, evidence_refs)
await workflow.pause_for_approval(question, options, artifact_refs)
await workflow.record_tdd(tdd_evidence)
await workflow.submit_review(verdict, findings)
await workflow.finish_branch(option)
~~~

The authoritative host request types are stable strings with schema validation:

- workflow.phase_outcome
- workflow.skill_invocation
- workflow.decision_proposal
- workflow.tdd_evidence
- workflow.review_verdict
- workflow.branch_finish_approval

`NativeWorkflowHostRequestMap` and `NativeWorkflowHostResponseMap` are the
closed request/response schema. The controller accepts a discriminated request
only when its `type` and payload agree and returns the matching discriminated
response; an unknown type or mismatched payload is rejected before any journal
append. There is no open-ended dictionary bridge.

The host rejects requests that do not match the active phase, one-time attempt
token, resource lease, and current workspace digest. It does not trust a
Python wrapper return value as proof that a transition occurred.

The native controller exposes no direct goal mutation operation. While a
workflow owns a goal binding, skill, role, slash-command, and model requests to
complete, replace, resume, or otherwise mutate that goal are rejected unless
the generic coordinator receives the workflow ID, goal ID, approved decision
revision, and active coordinator epoch through its fenced host gate. A direct
goal call cannot bypass a pending approval, capability grant, or workflow
transition.

## Native lifecycle and gates

### Activation and brainstorming

`/workflow start` creates or binds the existing goal, records only an optional
profile preference, discovers local capacity, and asks the generic cloud
availability question. A fresh brainstorming context then contributes to the
goal-contract proposal under the finite local control-plane ceiling; it cannot
dispatch implementation work or consume unapproved cloud capacity. After the
goal contract is independently verified, red-teamed, and accepted, the host
derives the preliminary scorecard, initial graph, resource-envelope proposal,
and a non-authorizing profile recommendation. That recommendation cannot enter
the workflow snapshot or grant resources. Final profile resolution happens only
after the typed plan graph and resource decision are approved, and that exact
selection is approved before any implementation worker starts. The brainstorming context receives the original objective as
untrusted task data, current repository state, available skill catalog, and a
read-only workspace lease. Material changes to the objective, scorecard, graph,
or resource envelope return through the kernel revision/approval gate rather
than silently changing preflight.

The fork's brainstorming skill remains responsible for:

- exploring project context and recent changes;
- asking clarifying questions one at a time;
- offering two or three approaches with trade-offs;
- presenting design sections for approval;
- writing the design artifact; and
- self-reviewing underspecified sections, contradictions, scope, and ambiguity.

The host contract requires a NativeDesignArtifact with objective, scope,
non-goals, assumptions, alternatives, recommendation, architecture, data
flow, error handling, testing approach, and artifact digest. The host does not
inspect Markdown for these words; the artifact sidecar is typed and a fresh
design reviewer verifies its content. Both the human-readable design and its
sidecar live only under the workflow's session-artifact tree. They are never
written to project documentation, staged, committed, or treated as a product
change.

No production, test, configuration, or branch mutation is authorized in this
phase. Before the brainstorming child is admitted, the host verifies the
`NativeSkillVisibilityPrerequisite` for every discipline-enforcing skill and
records the host capability revision. If that check fails, activation stops
before a phase prompt. The vendor manifest's explicit visual-companion
exclusion remains reference-only documentation and records the capability as
unavailable; it does not imply a bundled server or substitute transport.

### Design/spec review and approval

The written spec is reviewed in a fresh context using the fork's
spec-document-reviewer-prompt.md contract. The reviewer returns:

~~~typescript
interface NativeSpecReview {
  status: "approved" | "issues_found";
  issues: readonly NativeReviewFinding[];
  recommendations: readonly NativeReviewFinding[];
  artifactRef: NativeArtifactRef;
}
~~~

Only approved allows a user approval request. Approval is bound to the design
digest, review digest, workflow ID, and one-time token. If the skill presents
sections in chunks, each section may have its own approval token. Rejection or
requested changes starts a fresh brainstorming context with exact findings; it
never edits the design behind the user's back.

The next phase cannot begin because a model says approved. The host requires
the review artifact, current design digest, and exact user approval record.

### Writing plans

After design approval, a fresh planning context invokes the fork's
writing-plans skill. The plan artifact follows its required header and contains
Global Constraints, exact files, interfaces, bite-sized steps, RED/GREEN test
commands, and commit boundaries. The Markdown plan remains for humans and
workers; a machine-readable sidecar is authoritative for scheduling metadata.
Both remain under session artifacts. The host interprets any imported
methodology instruction to save or commit a planning document through this
adapter: planning artifacts never enter the project tree and are never
committed. A listed commit boundary is a host checkpoint, not commit authority.

~~~typescript
type ProjectVerificationAdapterId = "prime-agent-repository";

type ProjectVerificationCheckId =
  | "coding-agent-specific-test-file"
  | "coding-agent-repository-check";

interface ProjectVerificationAdapter {
  adapterId: ProjectVerificationAdapterId;
  checkIds: readonly ProjectVerificationCheckId[];
  mutationPolicy: "snapshot-authority-diff-rerun";
  formatterMutationPolicy: "intent_owned_implementation_only";
}

interface NativeAffectedTestBinding {
  testPath: string;
  affectedRequirementIds: readonly string[];
  checkId: ProjectVerificationCheckId;
  checkDescriptorRef: NativeArtifactRef;
  commandDigest: string;
  discoveryDigest: string;
  sourceDigest: string;
  ownershipLeaseRef: WorkflowLeaseRef;
  bindingDigest: string;
}

interface ProjectVerificationBaselineManifest {
  capturedBeforeWaveWorkspaceDigest: string;
  testSourceDigests: readonly string[];
  testDiscoveryConfigDigests: readonly string[];
  fixtureDigests: readonly string[];
  evaluatorAndParserDigests: readonly string[];
  thresholdAndSnapshotDigests: readonly string[];
  dependencyAndLockfileDigests: readonly string[];
  checkDescriptorDigests: readonly string[];
  manifestDigest: string;
}

interface NativeApprovedAdditiveTest {
  relativePath: string;
  preWaveState: "absent";
  requirementIds: readonly string[];
  affectedTestBindings: readonly NativeAffectedTestBinding[];
  expectedRedClassification: string;
  planTaskId: string;
  approvalDecisionRef: WorkflowDecisionRef;
  additionDigest: string;
}

interface NativeAdditiveTestSeal {
  waveId: string;
  approvedAdditionDigest: string;
  relativePath: string;
  contentDigest: string;
  redEvidenceRef: NativeArtifactRef;
  postRedWorkspaceDigest: string;
  epochRef: WorkflowEpochRef;
  sealDigest: string;
}

interface NativeWaveVerificationProtectionIntent {
  waveId: string;
  protectedBaseline: ProjectVerificationBaselineManifest;
  approvedAdditiveTests: readonly NativeApprovedAdditiveTest[];
  verificationContractDecisionRefs: readonly WorkflowDecisionRef[];
  epochRef: WorkflowEpochRef;
  intentDigest: string;
}

interface NativeSuiteBarrierIntent {
  waveId: string;
  waveProtectionIntentRef: NativeArtifactRef;
  waveProtectionIntentDigest: string;
  preBarrierWorkspaceDigest: string;
  adapterId: ProjectVerificationAdapterId;
  checkIds: readonly ProjectVerificationCheckId[];
  affectedTestBindings: readonly NativeAffectedTestBinding[];
  formatterAllowedImplementationPaths: readonly string[];
  additiveTestSealRefs: readonly NativeArtifactRef[];
  epochRef: WorkflowEpochRef;
  resourceLeaseRef: WorkflowLeaseRef;
  intentDigest: string;
}

interface NativeFormatterMutationResult {
  barrierIntentDigest: string;
  beforeWorkspaceDigest: string;
  afterWorkspaceDigest: string;
  changedImplementationPaths: readonly string[];
  firstRunEvidenceRef: NativeArtifactRef;
  rerunEvidenceRef: NativeArtifactRef;
  resultDigest: string;
}

type NativeRoleId =
  | "recon_explorer"
  | "task_executor"
  | "evidence_tester"
  | "documentation_executor"
  | "closure_auditor"
  | "suite_failure_fixer";

type NativeTaskCapability =
  | "read_task_inputs"
  | "write_task_owned_paths"
  | "run_focused_checks"
  | "publish_handoff"
  | "request_repair";

type NativeBranchCapability =
  | "merge_local"
  | "push_and_open_pr"
  | "keep_branch"
  | "keep_detached_workspace"
  | "discard_confirmed";

interface NativeCapabilityGrant {
  role: NativeRoleId;
  taskCapabilities: readonly NativeTaskCapability[];
  branchCapabilities: readonly NativeBranchCapability[];
  workflowId: string;
  taskId?: string;
  attemptId?: string;
  epochRef: WorkflowEpochRef;
  leaseRef: WorkflowLeaseRef;
  decisionRef: WorkflowDecisionRef;
}

interface NativePlanTask {
  taskId: string;
  requirementIds: readonly string[];
  objective: string;
  completionCriteria: readonly string[];
  dependsOn: readonly string[];
  ownedPaths: readonly string[];
  ownedContracts: readonly string[];
  readsContracts: readonly string[];
  requiredSkills: readonly string[];
  recommendedSkills: readonly string[];
  verificationChecks: readonly ProjectVerificationCheckId[];
  taskCapabilities: readonly NativeTaskCapability[];
  authority: readonly WorkflowAuthorityCapability[];
  tddPolicy: NativeTddPolicy;
}

interface NativeEscalationRequest extends WorkflowEscalationRequest {
  materialChangeKinds: readonly (
    | "scope"
    | "contract"
    | "authority"
    | "dependency"
    | "invariant"
    | "architecture"
    | "security"
    | "migration"
  )[];
}

interface NativeWorkerCapsule extends WorkflowAttemptHandoff {
  role: NativeRoleId;
  capabilityGrant: NativeCapabilityGrant;
  skillInvocationIds: readonly string[];
  tddEvidenceRef?: NativeArtifactRef;
  escalation: NativeEscalationRequest | null;
}

type NativeBoundedChangedLineCount = number; // host validates integer 1..200

interface NativeHostRoutineRepairClassification {
  classifier: "host";
  disposition: "routine";
  findingMetadataDigest: string;
  proposedDiffRef: NativeArtifactRef;
  proposedDiffDigest: string;
  proposedWriteSet: readonly string[];
  ownershipSnapshotDigest: string;
  authorityDigest: string;
  protectedInvariantDigest: string;
  priorEquivalentFindingCount: 0;
  materialChangeKinds: readonly [];
  effectClasses: readonly ["owned_reversible_local_write"];
  changedFileCount: 1 | 2 | 3;
  changedLineCount: NativeBoundedChangedLineCount;
  createsDeletesOrRenames: false;
  changesPublicInterface: false;
  changesTestsEvaluatorsFixturesOrDiscovery: false;
  changesDependenciesLockfilesOrConfiguration: false;
  changesAuthorityResourcesContractsOrGeneratedSchemas: false;
  classificationRulesetDigest: string;
  classifiedStateDigest: string;
}

interface NativeRepairRequest {
  repairId: string;
  taskId: string;
  attemptId: string;
  findingId: string;
  requirementId: string;
  expectedResult: string;
  observedResult: string;
  reproductionRef: NativeArtifactRef;
  evidenceDigest: string;
  applicationMode: "deterministic_exact_diff";
  fixRound: number;
  hostClassification: NativeHostRoutineRepairClassification;
  repairDecisionRef: WorkflowDecisionRef;
  repairRedTeamRef: NativeArtifactRef;
  approvedScopeDigest: string;
  epochRef: WorkflowEpochRef;
  ownershipLeaseRef: WorkflowLeaseRef;
  parentDecisionRef: WorkflowDecisionRef;
  parentAttemptId: string;
  parentFixRound: number;
  artifactRef: NativeArtifactRef;
}

interface NativePlanManifest {
  planId: string;
  planRevision: number;
  goalContractDigest: string;
  globalConstraints: readonly string[];
  executionProfile: "parallel" | "inline";
  verificationAdapterId: ProjectVerificationAdapterId;
  tasks: readonly NativePlanTask[];
  workspaceDigest: string;
  artifactRef: NativeArtifactRef;
}

interface NativePlanReview {
  status: "approved" | "issues_found" | "cannot_verify";
  specAlignment: readonly NativeReviewFinding[];
  decomposition: readonly NativeReviewFinding[];
  ownershipAndResourceFit: readonly NativeReviewFinding[];
  buildability: readonly NativeReviewFinding[];
  artifactRef: NativeArtifactRef;
}
~~~

The host validates cycles, unknown skills, missing ownership, overlapping write
sets, unowned generated files, unknown verification adapter/check IDs, closed
role/task capabilities, and attempts to weaken the approved goal. It does not
parse prose to derive those values. A model must publish the sidecar through
the bridge; absent or conflicting metadata is a plan failure. The start request
carries only an optional profile preference. The resolved `executionProfile`
is copied from the approved `NativePlanManifest` into the generic workflow
snapshot only after both the plan and its exact resource decision are approved;
startup and brainstorming may recommend but cannot resolve it before capacity,
graph, and authority review.

A fresh plan reviewer uses plan-document-reviewer-prompt.md and returns
completeness, spec alignment, task decomposition, and buildability findings.
The plan also presents the generic workflow's explicit execution choice:
`parallel` (recommended when independent work and capacity exist) or `inline`,
with the same TDD, review, evidence, recovery, and completion gates. The selected
option and resource implications are bound to plan approval; no worker starts
before selection. The plan is then paused for explicit user execution approval. Plan review
approval is separate from design approval because it authorizes a concrete
write set and worker schedule.

### Systematic debugging

The systematic-debugging skill is required for an explicit bugfix workflow
and whenever the host observes a failing test, failed quality gate, tool error,
or unexpected worker result. The transition is event-based, not triggered by a
word in a model response.

The phase contract mirrors its four phases:

1. Root-cause investigation: read the complete error, reproduce, inspect
   recent changes, instrument component boundaries when needed, and trace data
   flow to the source.
2. Pattern analysis: compare working examples and references completely,
   enumerate differences, and understand dependencies.
3. Hypothesis/testing: record one falsifiable hypothesis and its smallest
   test; a failed hypothesis starts a new investigation.
4. Implementation: create a failing regression test, apply one root-cause fix,
   verify it, and return to investigation if it fails.

NativeDebugEvidence must reference a reproducible failure, root cause, pattern
evidence, hypothesis attempts, and a failing test before a production
mutation is accepted. It records every fix attempt. After three failed fixes
the host opens an architecture decision and requires the universal red-team
gate plus user direction before another architectural change. It never permits
a fourth speculative symptom fix by continuing the same context.

### Test-driven development

Every implementation task whose `tddPolicy.kind` is `"required"` runs the
fork's RED/GREEN/REFACTOR contract in a fresh worker context with a
task-specific write lease. An `"exempt"` task carries its typed decision and
closed exemption reason in the plan; the host never infers an exemption from
prose or from a command result.

- RED: record the pre-test workspace digest, publish the smallest real behavior
  test within the task-owned test scope, run the adapter check, and publish a
  discriminated `NativeTddRedEvidence` with command ID, result, and expected
  failure classification plus the post-test/pre-production workspace digest.
  Every focused result carries a `NativeAffectedTestBinding` whose exact test
  path, affected requirements, closed check ID, check-descriptor digest,
  command/discovery/source digests, and ownership lease are host-resolved;
  arbitrary verification strings, guessed paths, and unbound checks are not
  evidence.
  For a new test, the host then commits a `NativeAdditiveTestSeal` over the exact
  path/content and RED evidence before any production write.
- GREEN: make the smallest implementation change, run the focused adapter
  check, and publish `NativeTddGreenEvidence` with a passing command result and
  changed workspace digest.
- REFACTOR: clean duplication and naming only after GREEN, then publish
  `NativeTddRefactorEvidence` for the covering rerun with unchanged behavior.

Host-observed command results and workspace snapshots are evidence; a worker
claim that a command passed is not. A RED command that fails with its declared
expected classification is successful RED evidence and permits the
implementation write. A RED command with an unexpected failure classification
or an execution/tool failure opens systematic debugging; it is not accepted as
RED evidence and no production write is authorized until that debugging gate
closes. A production write before host-observed expected RED evidence and the
required additive-test seal is rejected, as is any later mutation, replacement,
shadowing, or deletion of the sealed test; a refactor before GREEN is rejected.

Generated code, configuration-only changes, and throwaway prototypes are
possible exemptions only when the discriminated policy carries the approved
decision and matching reason; the host never infers an exemption from prose.

Tests must exercise real behavior. Mocks are allowed only when a dependency
cannot be used safely or deterministically, and the task review must explain
the boundary. A test that only checks a mock call, string presence, or a
constant is not outcome evidence.

### Widest-safe wave execution

After plan/execution approval and before any task in a wave receives a write
lease, the host captures and flushes one `NativeWaveVerificationProtectionIntent`
from the untouched pre-wave workspace. Existing tests, discovery configuration,
fixtures, evaluators/parsers, thresholds/snapshots, dependencies/lockfiles, and
check descriptors are protected for the entire wave. A RED task may create only an
exact plan-approved additive test path that was absent at capture and is bound to
its requirement, expected RED classification, and approval decision. It cannot
replace, shadow, delete, rename, or weaken a pre-wave protected artifact.
Once that additive test produces the expected host-observed RED result, its exact
content is sealed and joins the protected set for the remainder of the wave.

An intentional change to an existing protected surface is a separate
`revise_verification_contract` decision before wave capture. Root planning must
show the exact old/new artifact, why the original objective requires the change,
and old-versus-new behavioral evidence; independent review, metric-integrity red
team, and exact user approval must close before the host applies it. The host then
runs both applicable old and new checks and captures a new wave intent. A worker,
suite fixer, formatter, or post-wave snapshot can never self-authorize that
revision.

The scheduler computes the widest safe wave after every durable transition.
Every task whose dependencies are accepted, authority is available, resource
vector fits, and enforced ownership is disjoint is dispatched before the host
waits for any sibling. A task with an uncertain or unenforceable write set is
not placed in the same wave as another write-capable task; independent
read-only recon can continue.

Until the generic kernel effect/mutation broker or equivalent OS isolation can
enforce shell, symlink, rename, ignored/generated-output, and descendant writes,
all shared-checkout writers are serialized. The scheduler may instead isolate
writers in dedicated worktrees only when the accepted plan and user authority
explicitly permit worktree creation, then serialize audited integration. "Widest safe"
never converts post-hoc diff detection into a concurrency guarantee.

Ownership is explicit and includes indirect outputs:

- files and path prefixes;
- generated files and package locks;
- schemas, configuration keys, and named contracts;
- test fixtures and fixed ports;
- external resources or APIs;
- branch and commit scope; and
- any shared artifact a task may mutate.

The scheduler compares normalized paths, ancestor prefixes, generated-output
declarations, and named contracts. Ambiguous overlap serializes. A worker that
discovers an undeclared overlap stops before editing that area and returns a
typed ownership amendment. Workers share one checkout for ordinary tasks and
never revert a sibling's changes only when the host can enforce that boundary;
otherwise the serialization/isolation rule above applies. A task worker does not run Git operations or
the full suite; the host owns task commits and the suite barrier.

Dispatch is write-before-side-effect: append task intent, create a one-time
attempt/idempotency key, record write/resource leases and active epoch, admit a
fresh child through a key-capable host path, then record the child identity. Native
worker dispatch is hard-disabled until the child path can bind that key and expose
identity/liveness for reattachment. If a crash makes existing non-key-capable
admission ambiguous, the attempt is quarantined and never retried automatically. A
child result is `awaiting_audit`, never accepted progress, until an independent
auditor validates it.

### Bounded role mapping

The imported methodology and the generic kernel use one normalized set of fresh,
attempt-scoped roles rather than resident agents:

| Role | Authority | Required output |
| --- | --- | --- |
| Recon explorer | Read-only evidence scope | Evidence references, uncertainties, and a bounded recon delta |
| Task executor | Approved task-owned mutation scope | `NativeWorkerCapsule` and focused command evidence |
| Evidence tester | Read-only or isolated test scope | Independent result, method, artifact, and confidence evidence |
| Documentation executor | Only explicitly assigned product-document paths | User-visible documentation diff and verification; never status documents |
| Closure auditor | Read-only journal, capsule, and operation evidence | Reconciled readiness or exact open requirements; never a commit or completion transition |
| Suite-failure fixer | One host-issued barrier-failure repair scope | Focused repair evidence and bounded re-review request |

No role remains authoritative across phase boundaries. A fresh context receives
the current continuity capsule and exact immutable artifacts; it does not inherit
the prior role's conversation. The host retains scheduling, journal, approval,
Git, and terminal-status authority. This preserves narrow role specialization
without introducing a persistent explorer, automatic documentation writer, or
end-of-session commit owner.

Role, task, and branch capabilities are closed unions, not model-selected
strings. The host issues a `NativeCapabilityGrant` bound to the workflow,
task/attempt when applicable, parent decision, and lease. A role may use only
its granted task capabilities; branch operations may use only the matching
`NativeBranchCapability` from the explicit user option. No worker role receives
Git, approval, journal, completion, or direct goal-transition capability.

### Task spec and quality reviews

After a worker reports a valid `NativeWorkerCapsule`, the host commits only
task-owned product paths when commit authority is present and dispatches one
fresh task reviewer. Planning, progress, continuity, and review artifacts are
never included in such a commit. A worker report is a bounded evidence and
knowledge delta, not an activity diary; elapsed effort, message count, or file
count cannot substitute for outcome and evidence fields.
The reviewer receives the task brief, Global Constraints, exact Interfaces
block, report artifact, and immutable diff package. It returns both verdicts:

~~~typescript
interface NativeTaskReview {
  specCompliance: "approved" | "issues_found" | "cannot_verify";
  interfaceConformance: "conforms" | "deviates" | "not_applicable";
  quality: "approved" | "needs_fixes";
  strengths: readonly string[];
  issues: readonly NativeReviewFinding[];
  artifactRef: NativeArtifactRef;
}

interface NativeProgressAudit {
  taskId: string;
  attemptId: string;
  requirementEvidence: readonly WorkflowRequirementEvidence[];
  rejectedClaims: readonly NativeReviewFinding[];
  preWorkspaceDigest: string;
  postWorkspaceDigest: string;
  disposition: "accepted" | "rejected" | "regressed";
  artifactRef: NativeArtifactRef;
}

interface NativeReconciliationOutcome extends WorkflowReconciliationOutcome {
  phase: "reconciling";
  affectedTaskIds: readonly string[];
  skillSnapshotRefs: readonly NativeArtifactRef[];
}
~~~

The reviewer checks missing, extra, or misunderstood requirements; exact
names/signatures/types/path ownership; error behavior; real tests; separation
of concerns; and maintainability. It is read-only and does not run the full
suite. A cannot_verify item is resolved by the host against the cross-task
ledger; it is not silently ignored.

The task review is a methodology lens, not progress authority. It is followed by a
fresh generic progress auditor that checks the pre/post workspace, host-run command
evidence, immutable diff, goal requirements, scorecard, and review findings. Only a
`NativeProgressAudit` accepted through the full universal pipeline can satisfy a
dependency. Plan review, task review, final review, verification, and reconciliation
each record their generic recon/lens/verifier/synthesis/red-team role identities in
the workflow journal.

### Fix rounds

Critical, Important, spec-compliance, interface, or confirmed cross-task gaps
start a per-task fix loop. Minor findings are recorded for final review and
do not consume a fix round. Every round uses a fresh implementer, original
brief, exact interfaces, report file, and open findings. The implementer runs
focused covering tests and appends evidence to the durable report.

Each round ends with one scoped re-review of the fix diff. The re-review
verdicts every finding ADDRESSED or NOT_ADDRESSED and checks only new breakage
in the fix diff. It does not become a broad new review.

An accepted review finding first enters a host-owned repair classifier; neither
the reviewer nor worker may label its materiality. A fresh repair proposer with
no result-branch mutation authority prepares a content-addressed diff in an
isolated scratch worktree. The host computes classification from the immutable
finding metadata, proposed diff/write set, current ownership and authority
snapshot, protected invariants, and stable prior-finding identity. Only a
host-produced `NativeHostRoutineRepairClassification` with no material-change
kind and no prior equivalent finding may enter the direct route. The closed
routine predicate additionally requires one to three already owned files, at
most 200 changed lines, no create/delete/rename, and exactly the
`owned_reversible_local_write` effect class. Any interface, test/evaluator/
fixture/discovery, dependency/lockfile/configuration, generated schema,
contract, authority, resource, external-effect, or uncertain change fails closed
to the root pipeline regardless of size. Classification
is a deterministic policy result, not edit authority. The exact classified diff
then becomes a child decision revision and still runs the complete universal
recon/lens/evidence-verification/synthesis/red-team/host-gate pipeline with
scoped charters. Only its authorized `repairDecisionRef` and current red-team
artifact permit creation of `NativeRepairRequest`. The route skips an
unnecessary root planning turn, not a decision or adversarial gate. It then uses
deterministic exact-diff application, a one-time repair lease, and scoped
re-review. Any changed diff or write set invalidates classification and
authorization.

The host compare-and-swaps the request's `parentDecisionRef`,
`parentAttemptId`, and `parentFixRound` against the active workflow decision,
attempt, and round before applying the classified diff; a stale parent, lease,
workspace digest, repair ID, classification digest, or ownership snapshot fails
closed. The route is event-driven and is valid only inside the approved task
objective, ownership, interfaces, resource lease, and fix-round budget. A
scope, authority, architecture, security, or migration change returns to the
root decision pipeline (as do contract, dependency, protected-invariant,
repeated, or ambiguous findings). The root coordinator remains the only
transition authority even when the repair lane avoids an unnecessary planning
context.

There are at most `maxFixRounds` rounds per task, with an absolute maximum of
five. Rounds one through three use the task tier; rounds four and five, when
configured, escalate one tier. At the configured cap (whether one, three, or
five), the coordinator adjudicates residual findings: contestable or
non-load-bearing findings are parked with a ruling for final review; real
load-bearing findings create a typed blocker claim and enter `awaiting_user`
with plan text and full history. They cannot set terminal workflow `blocked`
until the generic stable-identity, exhausted-alternative, three-consecutive-turn
gate is satisfied. A lower configured cap shortens repair; it never converts an
unresolved finding into approval or skips final review. The controller never
edits product code itself to bypass review.

### Suite barriers

When every task in a wave is review-clean or parked with a ruling, the host
runs exactly one combined suite barrier on the shared result. This is the first
run that observes sibling changes together. The plan names only the closed
`ProjectVerificationAdapterId` and `ProjectVerificationCheckId` values; a typed
`ProjectVerificationAdapter` resolves those IDs to commands, working
directories, prohibited commands, timeouts, and expected artifacts. Model prose
cannot add a command or check ID.

Before the first barrier process starts, the host persists and flushes a
`NativeSuiteBarrierIntent` bound to the wave's immutable pre-wave protection
intent, every committed additive-test seal, and the exact post-wave/pre-barrier
workspace digest. The intent also carries a complete set of
`NativeAffectedTestBinding` records: each affected test path must resolve to a
closed adapter check descriptor and matching command, discovery, source, and
requirement digests. Every barrier rerun and fixer result is compared with the
pre-wave protected manifest and exact sealed additive-test contents; the post-wave
snapshot can never redefine what is protected.
The suite-failure fixer may change only already owned product implementation
paths; it cannot edit, delete, rename, regenerate, or shadow any baseline test,
discovery, fixture, evaluator, threshold, dependency, or check artifact. A
legitimate change to one of those surfaces returns to the root decision pipeline,
requires independent review and red team against the original pre-failure
baseline, and creates a new approved barrier intent. It never happens inside the
immediate fixer rerun.

For this repository, adapter `prime-agent-repository` resolves
`coding-agent-specific-test-file` to each affected test file run from the
`packages/coding-agent` package root with
`npx tsx ../../node_modules/vitest/dist/cli.js --run <specific-test-file>`;
the adapter resolves `coding-agent-repository-check` to `npm run check` from
the repository root. The adapter never runs `npm test`, `npm run dev`,
`npm run build`, or an unapproved broad suite. The barrier consists of the
affected specific test files plus the repository check, with full output
retained. Specific tests remain package-local; a root invocation is not a
substitute for the package-root command.

`npm run check` is mutating because its formatter may use `--write`; the
repository-check descriptor therefore has `mutationPolicy:
"snapshot-authority-diff-rerun"` and is never treated as read-only. Before
running it, the host snapshots the workspace and declared ownership, acquires
the host-owned mutation authority, runs the check, and inspects the complete
post-run diff. The barrier intent allowlists only owned product implementation
paths for formatter mutation. Any write to a protected surface, an additive test,
an undeclared implementation path, or any other path rejects the barrier and
enters reconciliation; formatter output never updates the protected baseline.
Permitted implementation-only formatter writes create a separate immutable
`NativeFormatterMutationResult` bound to the unchanged barrier intent and its
before/after workspace digests. The host then reruns the full check and retains
complete output from both runs; neither the intent nor protected baseline is
rewritten.

If the barrier fails, one fresh suite-failure fixer receives the complete
failure output and all affected briefs. It must not weaken tests or acceptance
criteria, and the host verifies the immutable baseline before accepting its diff.
The host reruns the barrier. A second failure stops the wave and sets
the workflow to `awaiting_user` with the evidence and a gated
planning/architecture proposal; it does not assume the architecture is wrong,
mutate it automatically, or fan out unbounded fixers.

Only after the barrier passes does the host close the wave and compute the next
widest-safe wave. The ledger records task commits, review verdicts, fix rounds,
barrier command, exit status, output artifact, and workspace digest.

### Final review, verification, and branch finishing

After the final wave, a fresh whole-branch reviewer receives a diff package from
the merge base and the complete native ledger. It uses the fork's
requesting-code-review rubric and checks plan alignment, architecture,
security, compatibility, tests, documentation, and seams between concurrent
tasks. Deferred minors and parked findings are explicit inputs.

If final review finds issues, the host permits one fix dispatch followed by one
scoped re-review. Remaining load-bearing findings block and require user
direction; the host does not start another unbounded fix wave.

A separate fresh verifier invokes verification-before-completion. It runs in an
isolated verification workspace against immutable evaluator, parser, fixture,
test-discovery, dependency, and held-out-input digests. It rereads
the approved goal and plan, runs configured complete verification commands,
checks the changed workspace, and publishes exact evidence. The verifier
cannot complete the workflow; a separate completion-readiness decision runs the
universal red-team gate against narrowed scope, hidden failures, stale
evidence, metric substitution, mock-only proof, and skill-gate bypass.

An accepted readiness decision fences product writes and moves to branch
finishing; it does not yet mark the workflow or bound goal complete.

The branch-finishing phase invokes finishing-a-development-branch. It verifies
the final tree before showing exactly one user decision menu:

~~~typescript
type NativeBranchFinishOptionId =
  | "merge_local"
  | "push_and_open_pr"
  | "keep_branch"
  | "keep_detached_workspace"
  | "discard_confirmed";

interface NativeBranchFinishOption extends NativeApprovalOption {
  optionId: NativeBranchFinishOptionId;
  baseRevision: string;
  resultRef: string;
  requiredCapabilities: readonly NativeBranchCapability[];
  cleanupIncluded: boolean;
}
~~~

~~~text
Implementation complete. What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)

Which option?
~~~

On detached HEAD the host shows only the two detached-workspace options from
the skill. The host validates a typed option against the exact finish digest;
ordinary prose claiming merge or push approval is not sufficient. No merge,
push, or cleanup occurs before the user's explicit choice. Discard exists only
after an explicit request and exact discard confirmation. If the base branch is
unknown, the host asks before presenting merge options.

After the selected branch operation, or immediately after `keep_branch`, the
host reruns the project-adapted final verification against the resulting tree
and operation evidence. Only the final host completion gate can then mark the
workflow and bound goal complete, and only when every requirement has current
independent evidence, review/barrier conditions passed, required skill
provenance is valid, the readiness revision survived red teaming, and the
authorized branch operation has the expected result. A failed or ambiguous
operation enters reconciliation rather than claiming completion.

## Universal decision red-team gate

The shared gate applies to every native methodology trust/state decision:
activation mode changes, design and plan approval, debugging root-cause
acceptance, TDD exemption, task dispatch, ownership amendment, worker handoff
acceptance, review verdict, fix-round closure, suite-barrier closure, evidence
acceptance, blocker classification, final verification, refinement, vendor
upgrade, and branch finishing.

The native layer consumes generic WorkflowDecisionRecord and gate APIs; it does
not create a second gate. Its decision kinds are closed and auditable:

~~~typescript
type NativeDecisionKind =
  | "activate_methodology"
  | "approve_design"
  | "approve_plan"
  | "accept_debug_evidence"
  | "approve_tdd_exception"
  | "revise_verification_contract"
  | "accept_evidence"
  | "classify_blocker"
  | "open_architecture_decision"
  | "amend_task_ownership"
  | "dispatch_task"
  | "accept_task_progress"
  | "accept_task_review"
  | "open_fix_round"
  | "close_fix_round"
  | "close_suite_barrier"
  | "authorize_final_review"
  | "authorize_verification"
  | "accept_verification_evidence"
  | "authorize_completion"
  | "apply_methodology_refinement"
  | "upgrade_vendor_snapshot"
  | "finish_branch";

interface NativeDecisionKindMap {
  activate_methodology: "configuration_revision";
  approve_design: "goal_contract";
  approve_plan: "plan";
  accept_debug_evidence: "progress_acceptance";
  approve_tdd_exception: "skill_gate";
  revise_verification_contract: "scorecard";
  accept_evidence: "progress_acceptance";
  classify_blocker: "blocker";
  open_architecture_decision: "strategy_change";
  amend_task_ownership: "ownership";
  dispatch_task: "plan";
  accept_task_progress: "progress_acceptance";
  accept_task_review: "progress_acceptance";
  open_fix_round: "strategy_change";
  close_fix_round: "progress_acceptance";
  close_suite_barrier: "progress_acceptance";
  authorize_final_review: "strategy_change";
  authorize_verification: "strategy_change";
  accept_verification_evidence: "progress_acceptance";
  authorize_completion: "completion";
  apply_methodology_refinement: "refinement";
  upgrade_vendor_snapshot: "configuration_revision";
  finish_branch: "completion";
}

interface NativeDecisionSpecialization<K extends NativeDecisionKind> {
  schema: 1;
  nativeKind: K;
  genericKind: NativeDecisionKindMap[K];
  specializationDigest: string;
}

type NativeDecisionRecord<K extends NativeDecisionKind> =
  WorkflowDecisionRecord & {
    kind: NativeDecisionKindMap[K];
    specialization: NativeDecisionSpecialization<K>;
  };
~~~

`NativeDecisionKindMap` is exhaustive: an added native kind cannot compile or
journal without one existing generic `DurableDecisionKind`. The host persists
the specialization object inside the generic decision artifact, includes its
canonical bytes in the decision digest, and rejects a `nativeKind` whose mapped
`genericKind` differs from the record's generic `kind`. It does not widen the
closed generic decision vocabulary or create a second reducer.

For each decision, the host records exact target/effect, read/write set,
authority, expiry, workflow/goal/plan/workspace/evidence digests, skill
invocation IDs, and one-time execution key. Fresh proposer, independent lens,
verifier, synthesizer, and adversarial contexts receive required artifacts and
never share a mutable conversation.

The host applies a decision only after validating:

- current fencing epoch and compare-and-swap revision;
- exact resource and ownership leases;
- source/digest and invocation provenance for required skills;
- fresh, unexpired, one-time gate token;
- user authority and required approval token;
- no concurrent overlapping state change;
- protected invariants and evidence freshness; and
- no unresolved red-team finding.

Changing target, effect, authority, precondition, scope, ownership, or skill
revision creates a new decision revision and a new red-team pass. Deterministic
journal append, schema validation, digest calculation, replay, exact
application of an already-approved transition, and known-lease release are
execution mechanisms, not model decisions.

## Fresh contexts and durable artifacts

Every phase, worker, reviewer, verifier, red team, fixer, reconciliation
attempt, and refinement review runs in a new RLM child context. Context
compaction, model change, daemon reconnect, or retry never turns a completed
context into continuing authority. The next context receives a bounded ledger
slice and immutable artifact references, not an unbounded parent transcript.

The workflow artifact tree is:

~~~text
session-artifacts/<session-id>/workflows/<workflow-id>/
  events.log
  source-manifest.json
  designs/
  plans/
  continuity/
  briefs/
  handoffs/
  progress/
  evidence/
  reviews/
  decisions/
  approvals/
  recovery/
  refinements/
  finish/
~~~

Large artifacts are written to a temporary file, flushed, atomically renamed,
and followed by a parent-directory flush before the root appends its reference.
Journal records are hash chained, sequence numbered, bound to a coordinator
fencing epoch, and written before the side effect they authorize. The root
coordinator is the only journal writer; children can publish attempt-unique
immutable files but cannot declare state transitions.

`continuity/` and `progress/` contain deterministic projections of the generic
journal for fresh contexts and imported methodology adapters. They never form a
second ledger. The host validates their source sequence and digest before use,
regenerates stale projections, and never writes them into the project tree.
Imported per-session progress-file or automatic-commit conventions are thus
served by the workflow bridge without granting file or Git authority.

### Host-authenticated skill provenance

The host computes digests from bytes, not model claims. A skill invocation
records:

~~~typescript
interface NativeSkillInvocationProvenance {
  invocationId: string;
  skillName: string;
  canonicalPath: string;
  source: string;
  scope: "user" | "project" | "temporary";
  vendorVersion?: string;
  sourceCommit?: string;
  license?: string;
  skillDigest: string;
  supportingTreeDigest: string;
  workflowManifestDigest: string;
  immutableSnapshotRef: NativeArtifactRef;
  trustTier: "bundled" | "user" | "project" | "temporary";
  loaderGeneration: number;
  phase: NativePhaseId;
  attemptId: string;
  hostGateToken: string;
  contextSessionId: string;
  hostRuntimeVersion: string;
  workerRole: NativeRoleId;
  modelId: string;
  reasoningEffort: string;
  multiAgentCapabilityRevision: string;
  invokedAt: string;
}
~~~

`skillDigest` is SHA-256 of exact SKILL.md. `supportingTreeDigest` is a
deterministic canonical hash of relative paths, file type, mode/executable bit,
symlink target policy, and bytes for the skill plus every manifest-declared
dependency. Before invocation, the host publishes that exact tree and workflow
manifest as an immutable content-addressed snapshot under the workflow artifact
tree; the phase invokes the snapshot, not the mutable loader path. The source
manifest supplies vendor version, commit, and license for bundled skills;
overrides record actual local source metadata and trust tier. A path outside the
resolved directory, symlink escape, changed bytes/mode/dependency, missing or
incompatible manifest, or mismatched loader generation invalidates invocation.

The host issues a single-use gate token and appends the invocation record
before sending the phase prompt. A phase cannot complete without the token and
matching invocation ID. Gate provenance records proposer, verifier,
synthesizer, and red-team context IDs; model identifiers; input/output
artifact digests; decision revision; workspace digest; verdict; and host
event sequence. Host-authenticated append authority and the generic journal hash
chain make provenance tamper-evident against model-authored forgery; authentication
is mandatory, not an optional HMAC setting. This is integrity evidence, not an operating-system security sandbox;
the kernel and repository still run with user permissions.

## Adaptive methodology allocation and improvement boundary

The native controller supplies phase-specific demand hints to the generic
adaptive allocation state; it does not own a second allocator. A hint names the
phase/task, required and optional capabilities, the current evidence gap or
critical-path dependency, conservative resource vector, and the evidence that
supports the request. The host derives the reservation and verifies whether the
hint addresses a real bottleneck. A role cannot increase its own grant, widen
its write set, consume control reserve, or relabel a failed outcome as progress.

After each phase/task result, review, suite barrier, lease release, or material
evidence transition, the kernel captures a fresh observation and runs the
universal allocation decision pipeline when a shift is proposed. Native lenses
may challenge phase fit, TDD/review ordering, ownership, and methodology risk;
the kernel's verifier and red team decide whether the allocation is supported.
The host shifts capacity only within the accepted graph, skill snapshot,
resource envelope, control reserve, and finite phase/review ceilings. Unknown
capacity is zero. A stale observation, changed skill/config digest, or uncertain
lease rejects the hint and leaves the last committed allocation in place until
reconciliation. Hysteresis and minimum windows keep role assignments from
oscillating; safety, protected-invariant, and control-reserve failures may force
an immediate stop instead.

The kernel's host-generated critical-path certificate is reproducible from the
accepted native task DAG, typed host-derived remaining-work estimates,
host-observed novelty/nonduplicate proofs, and policy digest. Its fixed
lexicographic order is time-to-genuine-proof, evidence gap, cost, uncertainty,
queue age, then task ID/digest. Independent host admission binds the certificate
to the accepted DAG and estimate digests. Native phase hints cannot replace
that certificate. Each phase/task hint and exploration task also binds a host
task-value certificate naming its unproven requirement/evidence gap, typed
novelty proof, typed bounded observable outcome, finite exploration quota, and
independent admission; utilization or model confidence cannot substitute.

Native allocations carry the task, attempt, resource-lease, ownership-lease,
discriminated worker/control `WorkflowCapacityGrant` backed by the generic
`WorkflowCanonicalPoolLedger`, and task-value bindings. Only an
`unclaimed` slot may shift in place; a
claimed/active phase is fenced and reconciled before a new attempt and lease
are created. Capacity, usage, billing, and rate-limit references are
authenticated, monotonic, and TTL-bound with `observedAt`/`expiresAt` refs;
stale, expired, or unknown data is zero at the allocation CAS, including
provider charges. Process, child-session,
model-call/token, and recovery capacity is a hard control partition separate
from worker capacity. `exclusive_unisolated` work is isolated/serialized away
from the control plane.

Fairness aging, last-served state, bounded priority-bucket promotion, and finite
exploration quota bound native role starvation. After a positive starvation
deadline, a role may move only within the persisted maximum promotion buckets
and promotion-per-window count, without outranking the certified proof
objective. The persisted `benefitThreshold`, `minimumDwellMilliseconds`,
minimum observation window, `maxTransitionsPerWindow`, and last decision bound
reallocation; every fairness/hysteresis number is finite, positive, and
range-validated. Only a recorded safety override may break them and it cannot
expand the envelope. Observations coalesce to one
latest pending and one active review; superseded pending work is cancelled and
an active review is fenced at a safe boundary so its result cannot apply.

Allocation intent is durable before its effect. A crash before the applied
marker is uncertain and requires effect-broker nonexecution proof or fenced,
idempotent reconciliation of the allocation, leases, and provider charges.
Expired leases are reclaimed only after strong host/provider nonexecution proof;
otherwise a finite deadline records terminal escalation rather than an
indefinite user reap.

The improvement review is separate from phase progress. The host owns and
freezes the improvement scorecard and preregistered case manifests; native
proposers cannot choose, replace, or omit them. Risk-relevant changes require a
host-selected hidden holdout with required `heldOutInputDigest`, required
sample sizes, effect/tolerance thresholds, protected-invariant and
non-regression predicates, and explicit cost/latency limits. At every phase,
incident, and completion gate, native refinement may propose one small
workflow/methodology/policy change or an explicit empty set, but it may use only
accepted progress-audit, verification, review, and recovery evidence. The
candidate is compared with the current baseline on the same pressure cases and
on held-out, replay, or canary cases where applicable. A fresh verifier and
independent Goodhart, regression, and safety red team inspect behavior,
authority, scope, resource cost, and compatibility. The host promotes a
compatible revision atomically by version CAS, reload verification, and
rollback metadata; otherwise it rejects or rolls back without changing the
active workflow. Objective, scorecard, evaluator, authority, envelope, and
project-scope changes remain user-approved decisions, not methodology learning.

Improvement reviews use the generic discriminated
`WorkflowImprovementProposal` → `WorkflowImprovementReview` →
`WorkflowImprovementResult` lifecycle; native producers cannot bypass its
queue/crash-fencing state, baseline/candidate evidence, verifier/goodhart/
regression/safety results, or registry CAS. The host evaluator/parser is frozen
with metric direction, aggregation, variance/repeatability, deterministic risk
classification, and stage-scoped holdout commitments. Latest-wins admission
has at most one pending and one active review; superseded pending work is
cancelled and fenced active results cannot apply. The kernel enforces positive finite cadence/duty-cycle,
wall/token/cost, per-window/phase/workflow limits, and a dedicated review
reserve disjoint from planner, TDD, verifier, red-team, recovery, and control
capacity. Invalid or exhausted bounds fail closed without implicit retries or a
resident loop. Before each phase admission or host effect, the current
revision-registry epoch and compatibility closure are checked; superseded or
revoked entries fence affected phases, leases, approvals, and caches while
pinned bytes remain available for audit. Promotion and rollback are registry
epoch CAS operations with rollback-of/event-sequence metadata, restart reload
verification, and future-load verification; only approved compatible revisions
can be loaded by later native runs.

Native components own only these boundaries:

| Concern | Native owner | Kernel boundary and first-release limit |
| --- | --- | --- |
| Phase/role demand hints and methodology evidence | `native-methodology.ts`, phase adapters, review contracts | Hints are non-authorizing evidence; kernel computes grants and gates all shifts |
| Adaptive allocation state, leases, hysteresis, and recovery | Generic `workflow/resources.ts`, `scheduler.ts`, `recovery.ts` | Native code consumes typed state; no second reducer, polling daemon, unknown capacity, or envelope expansion |
| Improvement pressure tests and revision proposal | `native-methodology-reviews.ts`, existing refinement boundary | Baseline plus held-out/replay/canary and independent Goodhart/regression/safety red team; finite attempts and rollback |
| Host-owned improvement scorecard, holdouts, review budget, and revision registry | Generic workflow decision/refinement/revision owner | Native proposers cannot select holdouts or registry status; positive finite bounds and fence-on-revocation remain kernel-owned |
| Canonical how/why/provenance | Knowledge/refinement ledger | Canonical commit is authoritative; optional MemPalace only indexes approved records and never authorizes |
| Recurring `cron` efficiency review | Generic schedule/window/recovery owner with native phase projection | Fresh read-only reviewer and one catch-up/window; native suggestions have zero write, lease, allocation, approval, or completion authority |
| Cloud/spend/authority changes | Generic workflow decision/approval gate | Exact user approval required; first release uses only observable local pools and already approved adapters |

This boundary keeps native methodology adaptable without allowing a phase or
role to become a resident authority or an unsafe infinite improvement loop.

### Native projection of the recurring efficiency red team (`cron`)

The kernel's approved schedule and resource-envelope reserve drive one fresh
independent `cron` review per window. Native methodology contributes a
read-only projection of phase/role demand, TDD/review barriers, required skill
gates, queue age, context churn, and verification/review overhead; it cannot
change the schedule or start a second reviewer. The host resolves one snapshot
of the generic critical path, queues, leases, cost, latency, accepted progress,
evidence gaps, uncertainty, and control reserve before invoking the reviewer.

Before invocation the host dereferences and re-hashes the immutable original
objective, hardened contract, scorecard/protected invariants, plan,
critical-path certificate, native configuration, evaluator/guard, revision
registry, and authenticated capacity/usage/billing/rate-limit refs. Missing,
stale, mismatched, revoked, or untrusted refs reject the snapshot; native
methodology cannot substitute a mutable phase/config path or self-generated
progress proof. The host records the dereference and stale-rejection proof in
the snapshot consumed by `cron`.

The reviewer checks whether native phase placement is the fastest genuine path
to accepted requirements. Its charter explicitly tests underuse, overuse,
redundancy, work that could safely serialize, context churn, verifier/red-team
starvation, review overhead, cloud cost, and Goodhart/proxy behavior. It returns
immutable suggestions only, with no write, lease, allocation, approval, or
completion authority. Applying a suggestion requires the generic full
recon/lens/verification/synthesis/red-team/host gate and exact approval; a
schedule or trigger change is a new resource/configuration decision.

Window compare-and-swap rejects overlap and coalesces same-window transition
triggers. Restart permits exactly one validated catch-up and discards older
missed windows. A late, malformed, stale, or unavailable reviewer is a
nonblocking diagnostic and leaves the last safe native allocation unchanged;
its bounded reserve cannot starve TDD, task review, verification, red team,
recovery, or the control plane.

The generic `WorkflowEfficiencyRedTeamInvocation` and typed
`WorkflowEfficiencyRedTeamResult` persist a monotonic clock observation and last-admitted
window sequence/id, rejecting backward, duplicate, or replayed windows. Each
native invocation binds the immutable snapshot, reviewer child identity,
independent read-only capability proof, admission and resource/ownership
leases, epoch, execution key, and invocation token. The typed success/failure
result records actual usage; failed, timed-out, stale, unavailable, or fenced
results are durable nonblocking outcomes and cannot allocate or become progress.

## Refinement and methodology evolution

The native methodology is adaptable, but adaptation is evidence-gated. The
existing /refine subsystem remains the only mutation path for
continual-harness entries. Native workflow refinement wraps it with an audited
decision and never edits the vendored snapshot.

Native how/why/procedure learning emits the single canonical
`KnowledgeMutationProposal` imported from the knowledge design; this document
does not redeclare that contract. Producer identity and native evidence remain
in its referenced immutable source artifact and do not add alternate scope,
action, or authority fields.

Prompt, skill, and reusable-role changes are methodology mutations rather than
knowledge records. They use a separate typed producer envelope:

~~~typescript
interface NativeMethodologyMutationProposal {
  proposalId: string;
  source: "native_refinement" | "native_learning";
  requestedScope: "session" | "workspace" | "user";
  targetKind: "prompt" | "skill" | "subagent";
  targetRef: string;
  evidenceRefs: readonly NativeArtifactRef[];
  baselineDigest: string;
  proposedChangeRef: NativeArtifactRef;
  expectedObservation: string;
  rollbackRef: NativeArtifactRef;
}
~~~

The shared knowledge ledger and existing `planRefinement` /
`applyRefinementProposal` transaction boundary adapt both producer forms into
their correct host-owned decision, CAS, reload, and rollback paths. A native
controller may emit a proposal but cannot apply it directly. Every
`NativeMethodologyMutationProposal` is rejected unless the host records the
writing-skills RED/GREEN/REFACTOR gate and its pressure-test artifacts; no
direct prompt, skill, or subagent edit can bypass that gate. Execution-profile
or other workflow-setting changes are configuration revisions against
`WorkflowRuntimeConfigSnapshot`; they never travel through knowledge or
continual-harness refinement.

A refinement proposal must cite:

- an accepted progress-audit or verification artifact;
- the repeated failure or reusable tactic it addresses;
- the smallest target component (prompt, memory, skill, or subagent);
- scope (local by default; global only with explicit authority);
- expected behavior and a validation command or observation;
- baseline and post-change workspace/harness digests; and
- rollback metadata.

An empty edit set is valid. Unverified worker claims, one-off history,
transient blockers, secrets, private source content, and unsupported
hypotheses are rejected.

When a proposal changes methodology or a discipline-enforcing skill, the host
requires the writing-skills process:

1. RED: run at least three combined-pressure scenarios without the candidate
   guidance and preserve exact violating decisions and rationalizations.
2. GREEN: apply the smallest candidate change and rerun the same scenarios with
   the guidance; the agent must comply.
3. REFACTOR: capture newly discovered rationalizations, close each loophole
   with a targeted counter, and rerun prior scenarios without regression.
4. Run wording micro-tests with a no-guidance control, at least five fresh
   repetitions per variant, and manually inspect every flagged match. Variance
   means the wording is not binding evidence.

The host accepts structured pressure-test artifacts and agent choices; it does
not grep a skill for a particular sentence. The RED baseline is mandatory:
without observed failure, a model suggestion cannot justify a methodology
change. Local refinements can be tested in a session overlay. Global or
vendored methodology changes require explicit user approval, a new source or
overlay digest, reload verification, compare-and-swap against prior harness
state, and rollback metadata. A failed refinement is recorded and does not
erase valid implementation evidence.

## File and interface ownership

The native layer is split from the generic workflow kernel. Shared interfaces
named in the durable workflow design are consumed, not redeclared. This table
is normative.

| Path | Ownership | Interface boundary |
| --- | --- | --- |
| packages/coding-agent/src/core/workflow/native-methodology-types.ts | New | NativePhaseId, config, outcomes, task/review/TDD/provenance/artifact types |
| packages/coding-agent/src/core/workflow/native-methodology-contracts.ts | New | Pure validators for transitions, manifests, ownership, TDD, and review reports; no I/O/model calls |
| packages/coding-agent/src/core/workflow/native-methodology.ts | New | NativeMethodologyController; orchestration over generic coordinator, ResourceLoader, SessionManager, and child host |
| packages/coding-agent/src/core/workflow/native-methodology-provenance.ts | New | Byte digests, source-manifest resolution, invocation records, token binding, verification |
| packages/coding-agent/src/core/workflow/native-methodology-tdd.ts | New | RED/GREEN/REFACTOR state machine and command/workspace evidence |
| packages/coding-agent/src/core/workflow/native-methodology-reviews.ts | New | Task review, scoped re-review, five-round breaker, suite barrier, final review and verification |
| packages/coding-agent/src/core/workflow/native-methodology-recovery.ts | New | Native phase recovery and reconciliation adapter; generic journal remains elsewhere |
| packages/coding-agent/src/core/workflow/workflow-config.ts | New | Typed workflow settings, precedence resolution, immutable snapshots, ordered migrations, and mutation plans |
| packages/coding-agent/src/core/agent-session.ts | Modify | Wire workflow host handlers/events/controller only; no scheduler or review logic |
| packages/coding-agent/src/core/agent-session-services.ts | Modify | Carry config and construct controller with existing services |
| packages/coding-agent/src/core/sdk.ts | Modify | Expose creation options and native controller types; preserve defaults |
| packages/coding-agent/src/core/slash-commands.ts | Modify | Register deterministic /workflow shapes; do not classify free-form prompts |
| packages/coding-agent/src/cli/args.ts | Modify | Parse --workflow, --workflow-max-workers, and explicit mode flags |
| packages/coding-agent/src/core/skills.ts | Shared loader only | Preserve Skill/SourceInfo precedence; no methodology rules |
| packages/coding-agent/src/core/resource-loader.ts | Shared loader only | Expose resolved skill snapshot/generation; no fork-specific precedence |
| packages/coding-agent/src/core/settings-manager.ts | Modify | Carry nested workflow settings and strengthen exact settings transaction without changing precedence |
| packages/coding-agent/src/core/refinement/refinement.ts | Existing transaction boundary only | Accept audited native refinement metadata without changing CRUD semantics |
| packages/coding-agent/skills/workflow/SKILL.md | New | Prime Agent-owned kernel bridge documentation |
| packages/coding-agent/skills/workflow/pyproject.toml | New | Minimal bridge package metadata |
| packages/coding-agent/skills/workflow/src/workflow/__init__.py | New | Thin rlm.host_request wrappers; no durable state |
| packages/coding-agent/skills/superpowers/skills/** | New vendor assets | Exact fork skill content and supporting files; never hand-edited by host logic |
| packages/coding-agent/skills/superpowers/LICENSE | New vendor asset | Exact MIT notice from source fork |
| packages/coding-agent/skills/superpowers/THIRD_PARTY_NOTICE.md | New vendor asset | Package-local attribution included in published archives |
| packages/coding-agent/skills/superpowers/SOURCE.json | Generated | Pinned source, commit, version, license, paths, format |
| scripts/vendor-superpowers.mjs | New | Explicit sync/check; source, license, manifest, deterministic copy |
| THIRD_PARTY_NOTICES.md | New or modify | Source-tree mirror of package attribution and upgrade record |
| packages/coding-agent/README.md | Modify | Architecture, activation, packaged attribution, setup, and verification |
| packages/coding-agent/docs/skills.md | Modify | Native activation, override, provenance, attribution docs |
| packages/coding-agent/docs/settings.md | Modify | Workflow schema, global/project precedence, profiles, and migration behavior |
| packages/coding-agent/CHANGELOG.md | Modify | One Unreleased user-visible entry |
| packages/coding-agent/test/suite/native-methodology-*.test.ts | New | Contract, activation, provenance, TDD, waves, review, recovery, refinement |

The generic workflow files retain ownership of the journal, decision records,
scorecard, capacity, leases, reducer, and host gate. The native controller
consumes them through dependency injection:

~~~typescript
interface NativeMethodologyController {
  start(request: NativeWorkflowStartRequest): Promise<NativeWorkflowSnapshot>;
  status(): NativeWorkflowSnapshot;
  respondApproval(request: NativeApprovalResponse): Promise<NativeWorkflowSnapshot>;
  resumePaused(note?: string): Promise<NativeWorkflowSnapshot>;
  handleHostRequest<K extends NativeWorkflowHostRequestType>(
    request: NativeWorkflowHostRequest<K>
  ): Promise<NativeWorkflowHostResponse<K>>;
  dispose(): Promise<void>;
}
~~~

`respondApproval` consumes only the exact pending approval request;
`resumePaused` handles only an explicitly user-paused workflow and never
consumes approval authority. The methods reject the opposite state rather than
sharing a permissive resume path.

It produces native phase events, immutable artifacts, and typed decision
proposals. It never writes the generic journal directly except through the
coordinator's fenced append API.

## Compatibility and recovery

### Compatibility classification

The first release is backward-compatible:

- bundled skills are ordinary resources discovered by the existing loader;
- explicit slash commands use the existing prompt/command path;
- command-line workflow startup sends an existing prompt after session creation;
- native state uses existing custom entries/events and session-artifact files;
- RLM child creation, messaging, and observation use existing host APIs;
- the source manifest and native workflow format are versioned on disk,
  independently of daemon protocol version; and
- ordinary sessions retain current goal, autonomous, skill, subagent, and
  recovery behavior.

If implementation requires a daemon wire change, work stops at design review.
The change must instead be classified capability-gated or incompatible, update
protocol/schema revisions and compatibility maps, and add old-client/new-daemon
and new-client/old-daemon tests before implementation resumes.

### Recovery rules

The native controller uses the generic workflow journal's write-before-side-
effect sequence. On root or daemon recovery it acquires a new fencing epoch,
replays the hash chain, and marks an active phase with no terminal outcome as
recovering. It compares journal attempts with live child registrations,
transcripts, artifacts, workspace snapshots, leases, and external evidence.

A fresh reconciliation context classifies the attempt as completed, still
running, proven not executed and safe to retry, requiring corrective work, or
requiring user input. A missing child identity, unreferenced artifact, changed
skill digest, uncertain branch operation, or possible non-idempotent external
effect is quarantined. The host never blindly retries it.

Approvals are bound to workflow, phase, revision, artifact digest, and token.
Restart preserves an approval pause; a duplicate response is an idempotent
rejection. A stale coordinator, stale verdict, stale skill invocation, wrong
workspace digest, broken journal chain, or reused execution key fails closed.

Cancellation stops new dispatch, lets active workers reach the next safe host
boundary, persists artifacts, and leaves workspace changes intact. It does not
falsely complete the goal or delete evidence.

### Error taxonomy

Native errors are structured and actionable:

| Code | Host response |
| --- | --- |
| native_skill_missing | Required phase fails closed; record source paths and reload diagnostics |
| native_skill_digest_mismatch | Quarantine invocation; require reload or approved revision |
| native_skill_provenance_invalid | Reject phase outcome and gate; preserve evidence |
| native_phase_outcome_invalid | Keep phase open; return schema/path/token finding |
| native_approval_required | Persist exact question and pause; never assume |
| native_approval_stale | Reject response; request approval against current digest |
| native_plan_invalid | Reject graph, ownership, or interface manifest |
| native_tdd_order_violation | Reject task acceptance; require a new cycle |
| native_debug_evidence_missing | Reject fix acceptance until root-cause evidence exists |
| native_ownership_conflict | Stop conflicting dispatch; amend through a new decision |
| native_review_open | Keep task/wave open; enter bounded fix round |
| native_fix_round_exhausted | Park non-load-bearing finding or block on load-bearing finding |
| native_suite_barrier_failed | One suite-failure fix; second failure enters awaiting_user with evidence |
| native_verification_stale | Invalidate evidence and return to planning |
| native_refinement_unverified | Record skipped/failed refinement; retain implementation evidence |
| native_vendor_mismatch | Refuse packaging or upgrade until manifest/license/copy agrees |
| native_config_schema_newer | Refuse mutation; preserve bytes and report supported schema |
| native_config_drift | Reject stale mutation plan; reload and request a new exact decision |
| native_config_transaction_uncertain | Enter recovery from prepared record and backup manifest |
| native_remote_update_unsupported | Refuse runtime/network update; require explicit local vendor source |
| native_recovery_uncertain | Quarantine effect/lease and request reconciliation or user input |
| native_finish_unauthorized | Leave branch intact; wait for exact user choice |
| native_journal_corrupt | Fail closed into recovery; never invent success |
| native_infrastructure_failure | Retry within bounded policy; then surface audited blocker |
| native_adaptive_observation_stale | Reject the phase demand hint; retain the last safe allocation and request a fresh host observation |
| native_adaptive_expansion_unapproved | Pause before dispatch; require exact approval for envelope, cloud, spend, egress, credential, or authority expansion |
| native_adaptive_control_reserve_low | Stop new implementation dispatch and preserve verifier, red-team, recovery, and host capacity |
| native_adaptive_lease_uncertain | Quarantine the lease/effect and enter generic reconciliation; never treat it as released capacity |
| native_adaptive_certificate_invalid | Reject the phase hint when the host critical-path or task-value certificate is missing, stale, non-reproducible, or lacks a bounded outcome |
| native_adaptive_binding_conflict | Fence/reconcile the claimed or active attempt and create a new attempt/lease; only unclaimed slots may move |
| native_adaptive_snapshot_stale | Resolve capacity, usage, billing, and rate-limit headroom to zero at CAS and quarantine provider charges |
| native_adaptive_control_partition_violation | Reject or serialize `exclusive_unisolated` work away from the hard process/session/model/token/recovery control partition |
| native_adaptive_effect_uncertain | Require effect-broker nonexecution proof or fenced idempotent reconciliation after an intent-before-marker crash |
| native_adaptive_fairness_limit | Preserve the allocation when aging, last-served, exploration quota, benefit threshold, dwell, or transition cap is violated; safety stop is recorded separately |
| native_adaptive_reclaim_escalated | Do not reclaim an expired lease without strong nonexecution proof; record finite terminal escalation at the deadline |
| native_adaptive_review_superseded | Coalesce to the latest observation, cancel pending work, and fence an active review whose result can no longer apply |
| native_efficiency_schedule_invalid | Reject the `cron` trigger or schedule revision; retain the approved envelope and window state |
| native_efficiency_review_overlap | Reject the overlapping review by window CAS; coalesce its trigger into the current window without another context |
| native_efficiency_review_failed | Record a bounded nonblocking failure; preserve the last safe phase allocation and continue methodology work |
| native_efficiency_catchup_exhausted | Discard older missed windows after one validated restart catch-up; never create a backlog storm |
| native_efficiency_suggestion_unauthorized | Reject the suggestion before host effects; require a new full decision/approval for any application |
| native_methodology_revision_unverified | Reject or roll back the candidate revision; do not load it in future workflows |
| native_methodology_revision_regressed | Restore the last approved compatible revision and retain baseline/held-out/canary evidence |
| native_control_capacity_invalid | Reject native grant/lease/admission CAS when a control vector is missing, negative, non-finite, over-reserved, or not component-wise reconciled; serialize `exclusive_unisolated` work away from control capacity |
| native_improvement_scorecard_invalid | Reject refinement when the host-owned manifest, required sample, hidden holdout/digest, effect/tolerance, non-regression, or cost/latency predicate is missing |
| native_revision_registry_stale | Reject phase/effect admission and fence affected phases, leases, approvals, and caches until the current registry epoch/closure is restored; retain pinned audit bytes |
| native_efficiency_snapshot_unverifiable | Reject a `cron` snapshot when immutable objective/contract/scorecard/plan/certificate/config/evaluator/guard/registry refs are missing, stale, or mismatched |
| native_review_budget_invalid | Reject schedule/review CAS when cadence, duty-cycle, reserve, or per-window/phase/workflow bounds are non-positive, non-finite, or exceed the approved envelope |

No error path silently falls back to a weaker phase contract. Recommended skills
may be unavailable and are recorded as skipped; required skills are never
downgraded to recommendations.

## Licensing and upgrade strategy

The vendor snapshot is updated deliberately, not at runtime:

1. A maintainer checks fork and upstream revisions, license, release notes,
   and intended source diff.
2. scripts/vendor-superpowers.mjs --source <path> --check verifies source
   shape, frontmatter, supporting files, executable bits, and MIT notice.
3. The sync command copies the exact skills/ tree and writes SOURCE.json with
   new fork commit and version.
4. Native contract tests, discovery tests, provenance tests, and the
   writing-skills pressure-test campaign run against the new snapshot.
5. The coding-agent changelog, package-local THIRD_PARTY_NOTICE.md,
   repository THIRD_PARTY_NOTICES.md, and skills docs record user-visible
   changes and source provenance.
6. The update is reviewed and merged normally. The old snapshot remains
   recoverable from Git history; active workflows remain pinned to recorded
   skill digests.

Fork-specific changes stay in the user's fork and are not silently upstreamed.
When syncing upstream, maintainers resolve fork changes, update source commit
and release notes, and rerun pressure tests. A skill content version may
advance independently of the host contract. If an upgrade changes an
observable contract, the host contract version is bumped and migration and
compatibility tests are required.

Vendor-snapshot upgrade and workflow-settings migration are separate
transactions. A running workflow stays pinned to its recorded skill tree,
manifest, resolved config, and contract digests; installing a newer snapshot
does not rewrite its state. New workflows use the new compatible default. If an
old immutable snapshot is unavailable at recovery, the workflow stops at
`awaiting_user` with an exact migration/archive choice rather than silently
substituting current bytes.

The vendor script has no new runtime dependency. It refuses an ambiguous or
dirty source selection, rejects path traversal and symlink escapes, and
produces deterministic output. Resource precedence remains normal user,
project, package, and built-in order; the pinned vendor copy is lowest
precedence.

Every vendor/config lifecycle mutation is plan-first and ownership-bounded. The
host or maintenance script computes the exact current, incoming, preserved, and
removed paths; validates version, manifest, license, digests, modes, and paths;
stages the complete incoming tree; writes a durable prepared record and
recoverable backup; applies atomic replacements; verifies the installed tree;
then records commit or restores the backup. Drift outside declared generated or
vendor-owned paths is preserved and reported, not semantically merged. Remove is
an explicit two-step confirmation and never deletes unrelated settings, project
files, or session artifacts.

The first release accepts only an explicit local source path for vendor sync and
has no independent updater. A future remote archive path would require a
separately approved design with publisher provenance or signature, pinned release
identity, checksum, bounded redirects and response/archive size, explicit egress,
duplicate/path-traversal/case-collision/symlink/special-file rejection, and
verified licensing. Downloaded code is never executed as the updater. This
cannot be added as an implicit background network route.

## Acceptance tests and evidence

Every test must assert an observable host result or real integration behavior.
String-presence checks on skill prose are not sufficient.

### Vendor and activation

N-01. Snapshot version, commit, license, copyright, and imported paths produce a
   deterministic SOURCE.json.
N-02. Exact MIT LICENSE and package-local notice appear in source and packaged
   layouts; package checks fail when either is omitted.
N-03. Nested fork skills and supporting references are found by ResourceLoader
   without duplicate or collision.
N-04. The default catalog is available in a new top-level session, while explicit
   mode creates no workflow for a read-only or ordinary coding prompt.
N-05. /workflow start and --workflow create one bound workflow and goal; duplicate
   starts are rejected without changing existing state.
N-06. No automatic mode or prompt/skill-prose substring can open a workflow in the
   first release.
N-07. User and project overrides use normal precedence and record actual source and
   digest.

### Brainstorming and planning

N-08. Brainstorming cannot mutate production files, tests, configuration, branch,
   or task leases before design approval.
N-09. Design sections, review, and approval survive root/daemon restart; stale or
   duplicate approval is rejected idempotently.
N-10. A fresh spec reviewer prevents plan creation while a material issue exists.
N-11. Writing plans produces a typed sidecar with exact files, interfaces,
   dependencies, ownership, skills, and verification commands.
N-12. Cycles, unknown required skills, missing ownership, generated collisions,
   and goal-contract weakening are rejected before dispatch.
N-13. Plan review and explicit execution approval precede worker admission.

### Debugging and TDD

N-14. A host-observed test or quality failure opens systematic debugging in a
   fresh context even if the model never names debugging.
N-15. A production change without RED/failing-test evidence cannot be accepted
   for a TDD task.
N-16. GREEN is required before REFACTOR; a refactor without covering rerun is
   rejected.
N-17. Generated/config-only TDD exemptions require typed declaration and
   red-team/user approval; prose claims do not suffice.
N-18. Three failed fix attempts open an architecture decision and prevent a
   fourth symptom fix without a new approved strategy.
N-19. Debug evidence records reproduction, root cause, pattern comparison, one
   hypothesis per attempt, and a real failing test.

### Waves and reviews

N-20. All ready, disjoint tasks are admitted concurrently before any sibling is
   awaited; dependencies and ownership conflicts serialize.
N-21. Undeclared path, generated output, package lock, schema, or contract writes
   are denied or invalidate attempts before progress acceptance.
N-22. Workers run focused checks only, do not commit, and do not run the combined
   suite; the host records task-scoped commits and reports.
N-23. Task review returns spec-compliance and quality verdicts, exact interface
   conformance, and cannot_verify findings.
N-24. Critical, Important, spec, and interface findings enter fresh fix loops;
   each round has covering test evidence and scoped re-review.
N-25. Fifth unresolved round invokes breaker and parks or blocks with a durable
   ruling; it cannot loop indefinitely.
N-26. Combined suite barrier runs after task reviews, sees sibling changes, and
   permits one suite-failure fix before entering `awaiting_user` with the full
   second-failure evidence and a gated strategy proposal.
N-27. Final whole-branch review runs after all waves and allows one fix dispatch
   plus one scoped re-review.

### Verification and branch finishing

N-28. Fresh verifier reruns configured complete checks in an isolated workspace
   with immutable evaluator/input digests and rejects worker-only or mock-only
   evidence.
N-29. Completion red team returns a seemingly complete workflow to planning for
   narrowed scope, stale evidence, hidden failures, metric substitution, or
   gate bypass.
N-30. Only the host completion gate can complete workflow and bound goal, after
   the selected branch outcome and post-operation verification are current.
N-31. Branch-finishing verifies the final tree before displaying merge/push/keep;
   no consequential operation occurs before user choice.
N-32. Detached HEAD exposes detached-safe options and discard requires explicit
   request plus exact confirmation.

### Provenance, decisions, and recovery

N-33. Changed skill bytes, supporting files, source manifest, loader generation,
   or invocation path invalidate the phase until a new invocation is recorded.
N-34. Forged, stale, duplicated, expired, wrong-revision, wrong-epoch, and
   wrong-workspace verdicts are rejected without state mutation.
N-35. Every native decision kind has a fresh red-team artifact before host gate;
   disjoint decisions may commit while overlapping revisions re-gate.
N-36. Killing a worker around every dispatch journal boundary produces
   reconciliation, not blind replay or duplicate side effects.
N-37. Replacement coordinator fences the old epoch; stale coordinator cannot
   append, dispatch, release, or approve.
N-38. Truncated final records and unreferenced artifacts do not invent success;
   broken chains fail closed into recovery.
N-39. Approval pause, goal accounting, task history, evidence, leases, and skill
   provenance survive session and daemon restart.

### Refinement and compatibility

N-40. Refinement cannot apply from an unverified worker claim or failed audit and
   accepts an empty edit set.
N-41. Methodology refinement without RED baseline pressure evidence is rejected.
N-42. Writing-skills GREEN pressure tests, REFACTOR loophole tests, and five-plus
   repetition micro-tests with a no-guidance control are durable evidence.
N-43. Local refinement is default; global refinement requires explicit authority
   and scope metadata, and rollback/reload verification works.
N-44. Existing ordinary goals, autonomous sessions, skill commands, child
   sessions, daemon recovery, and resource precedence pass unchanged suites.
N-45. Design, plan, progress, continuity, and review artifacts remain under
   session artifacts and cannot be staged or committed as project changes.
N-46. Explicit workflow `inline` and `parallel` profiles preserve the same
   decision, evidence, recovery, and completion gates. An ordinary direct
   session remains outside the workflow state machine under existing
   lightweight rules; prompt keywords never promote it into a profile.
N-47. A stale continuity/progress projection is rejected and deterministically
   regenerated from the journal without changing authoritative state.
N-48. A worker handoff missing ownership, upstream decisions, interfaces,
   rationale, invariants, requirement evidence, verification evidence, or exact
   workspace digests cannot advance a requirement; required `escalation` may be
   null only when the outcome/acceptance applicability proves no escalation is
   needed; activity volume is ignored.
N-49. Only a host-classified routine finding with an immutable isolated proposed
   diff, owned write set, current authority/invariant snapshots, and no prior
   equivalent finding may take the bounded direct repair lane; the exact diff
   still survives the universal decision/red-team pipeline, worker/reviewer
   labels cannot select the lane, and material or repeated findings return to root.
N-50. Global/project workflow settings resolve through existing precedence into
   one immutable snapshot; migration preserves unknown keys, detects drift and
   newer schemas, and recovers from interruption without partial application.
N-51. The project verification adapter runs each affected specific test and
   `npm run check` with full output, and rejects prohibited broad, development,
   or build commands.
N-52. Role contexts are fresh and attempt-scoped; no explorer, documenter,
   tester, or closure role retains journal, Git, approval, or completion
   authority across a phase boundary.
N-53. Vendor lifecycle crash tests cover prepared, replacement, verification,
   and commit boundaries; unrelated files and settings survive update and
   confirmed removal.
N-54. Settings and vendor transactions preserve restrictive file modes, reject
   symlinks and canonical/legacy path conflicts, and restore from a
   digest-manifested backup after every injected crash boundary.
N-55. No workflow activation, upgrade, disable, or removal path rewrites project
   instruction files, ignore rules, unrelated settings, or hidden project
   directories.
N-56. No model/role defaults, prompt routes, templates, updater code, or project
   document layout from an unlicensed design source enter source or packaged
   artifacts; provenance scanning verifies the independently implemented
   boundary.
N-57. The first release exposes no background update check or downloaded-code
   execution path; future archive fixtures must fail on bad publisher identity,
   redirect/size limit, checksum, license, traversal, duplicate, case collision,
   symlink, or special-file input.
N-58. Imported support scripts, hooks, servers, lifecycle helpers, status-document
   writers, and Git helpers remain non-executable reference assets; attempts to
   invoke them fail before process creation, while approved behavior proceeds
   only through a named host adapter and current decision/lease.
N-59. Every native phase definition has exactly one explicit `WorkflowPhaseId`
   binding; matrix tests reject an unbound, duplicate, or illegal native
   transition and recovery regenerates the same native projection from generic
   journal events.
N-60. Workflow start requires host-observed hidden-skill visibility; it records
   only an optional profile preference. Capacity/graph review plus exact user
   approval of the plan and resource decision resolves `executionProfile`; an
   earlier value is recommendation-only, and a model convention, prompt, or
   skill prose cannot satisfy visibility or select it.
N-61. Required TDD tasks carry the discriminated policy, command evidence, and
   host-resolved `NativeAffectedTestBinding` for every affected test path and
   closed check descriptor; expected RED failure is accepted, unexpected RED
   failure opens debugging, and exempt tasks require a typed reason plus
   decision reference.
N-62. Direct repair accepts only the exact host-classified diff plus matching
   current repair decision/red-team references, ownership snapshot, parent
   decision/attempt/round fence, and lease; changed write sets and security,
   migration, scope, authority, architecture, repeated, or ambiguous changes
   return through the root decision gate.
N-63. Adapter tests reject arbitrary verification strings, guessed paths, and
   unknown check IDs or descriptors; each affected test path binds its command,
   discovery/source digest, requirements, and ownership lease. The repository
   check snapshots before its formatter-capable run, rejects unowned writes,
   inspects the diff, and reruns full output under owned mutation authority.
N-64. Capability tests reject role/task/branch capability escalation and direct
   goal completion, replacement, resume, or mutation without the workflow
   decision revision and coordinator epoch.
N-65. The bridge accepts only matching discriminated request/response map entries;
   unknown types and mismatched payloads append nothing.
N-66. Vendor-manifest tests require every source path to be included, reference-
   only, or explicitly excluded, and reject an ambiguous visual-companion
   claim or executable reference asset.
N-67. Native refine/learning emits a shared `KnowledgeMutationProposal`; skill or
   workflow-profile edits are rejected without writing-skills RED/GREEN/REFACTOR
   pressure artifacts and their required approval.
N-68. Before any wave write, the host freezes the existing test, discovery, fixture,
   evaluator, parser, threshold, snapshot, dependency, lockfile, and
   check-descriptor manifest and affected-test path/check-descriptor bindings.
   Only exact approved additive test paths absent at
   capture may be created during RED; the host seals their exact content after the
   expected RED result and before production writes, and later changes are rejected.
   A suite fixer or worker that changes any frozen component cannot turn red to
   green; a legitimate existing-surface change
   requires a separate root `revise_verification_contract` decision, old/new
   behavioral evidence, independent review/red team, user approval, and a new
   pre-wave intent.
N-69. Direct repair is rejected unless the host-classified exact diff changes one
   to three owned files and no more than 200 lines, is reversible and local, and
   changes none of the prohibited semantic surfaces. Splitting one finding across
   requests or changing the diff after classification also returns to root.
N-70. An override manifest may add gates or narrow permissions but cannot omit,
   replace, relax, or reorder the minimum host gate contract. The resolved
   minimum-contract digest is pinned to the workflow and every native decision.
N-71. Native planning and repair consume the generic approved finite workflow,
   planner, task-attempt, per-requirement strategy/analysis, and recovery ceilings;
   different role names, fresh contexts, or repair rounds cannot reset them.
N-72. Native decision specialization is exhaustive: every `NativeDecisionKind`
   resolves through the pinned `NativeDecisionKindMap` to one generic decision
   kind, and a missing, duplicate, or changed mapping/digest blocks the decision
   before any host effect.
N-73. Formatter-capable barrier checks receive an intent-bound allowlist containing
   only owned product implementation paths. Writes to tests, discovery, fixtures,
   evaluators/parsers, thresholds/snapshots, dependencies/lockfiles, check
   descriptors, approved additive tests, or undeclared paths reject the barrier;
   formatter writes never update the protected baseline.
NAD-01. Each phase, task, result, lease release, and material evidence transition
   emits a host-observed demand observation; native hints include critical-path,
   evidence-gap, uncertainty, lease, and control-reserve evidence, and cannot
   self-score progress or authorize a grant.
NAD-02. Allocation changes caused by native hints run the generic recon/lens/
   verification/synthesis/red-team/host gate, preserve TDD/review ordering,
   move only ownership-compatible capacity to a verified bottleneck, and never
   starve verifier, red-team, recovery, or control-plane reserve.
NAD-03. Hysteresis, minimum windows, bounded priority-bucket aging/promotion,
   finite phase/review ceilings, positive finite/range-validated fairness and
   hysteresis numbers, stale-observation rejection, and exact user approval for
   envelope/cloud/spend/authority changes prevent role thrash, unknown-capacity
   use, and unsafe expansion.
NAD-04. Native adaptive state and lease tests recover from controller crashes,
   reject wrong epoch/config/skill/workspace observations, quarantine ambiguous
   leases, and restore or roll back the last committed allocation without blind
   replay.
NAD-05. After each phase, incident, and completion gate, refinement routes through
   the generic discriminated proposal/review/result/event lifecycle and proposes
   a small methodology/workflow/policy revision or an empty set only from
   accepted evidence; the host-owned evaluator/parser and scorecard freeze
   metric direction, aggregation, variance/repeatability, deterministic risk,
   preregistered cases, required samples, effect/tolerance, stage-scoped hidden
   holdout/digest, non-regression, and cost/latency predicates that native
   proposers cannot choose or omit, while baseline plus held-out/replay/canary
   pressure tests and independent Goodhart/regression/safety red-team evidence
   gate promotion.
NAD-06. A compatible methodology revision is atomically registry-epoch-CASed,
   reload-verified, future-load-verified, and rollback-capable with rollback-of/
   event-sequence metadata; rejected, unverified, stale, or rolled-back
   revisions cannot load in future runs, and objective/scorecard/evaluator/
   authority/envelope changes return to exact user approval. Registry
   compatibility closure, discriminated scope with session/knowledge decision
   refs, status, and epoch/event CAS are checked before phase/effect;
   superseded/revoked entries fence affected phases, leases, approvals, and
   caches while pinned bytes remain for audit.
NAD-07. Native canonical knowledge outputs preserve how/why/provenance and evidence;
   optional MemPalace only indexes approved canonical records and cannot authorize
   a phase, allocation, resource expansion, approval, or completion.
NAD-08. First-release tests prove bounded local adaptation and explicit adapter
   prerequisites without a resident infinite daemon, hidden capacity, automatic
   envelope expansion, or daemon wire changes; unenforceable resource ownership
   serializes or stops rather than claiming safe parallelism.
NAD-09. The approved resource envelope carries `cron` trusted clock/cadence,
   monotonic clock observation/sequence and persisted last-admitted window,
   major-transition triggers, exactly-once window, one-catch-up-after-restart
   rule, positive finite cadence/duty-cycle and per-window/phase/workflow
   ceilings, and bounded reviewer overhead/cost reserve; changing a schedule
   field creates a new configuration/resource decision and exact approval.
NAD-10. Each native `cron` review consumes one fresh independent read-only snapshot
   of phase/role placement, critical path, queues, leases, cost, latency,
   accepted progress, evidence gaps, uncertainty, and control reserve, including
   immutable objective/contract/scorecard/invariant/plan/critical-path/config/
   evaluator/guard/registry refs and digests. Host dereference and stale
   rejection precede review; invocation binds reviewer child identity,
   read-only capability proof, admission/leases, epoch, execution key, and
   token, and typed success/failure records actual usage. It checks underuse,
   overuse, redundancy, serializable work, context churn, verification
   starvation, review overhead, cloud cost, and Goodhart risk.
NAD-11. Native `cron` output is immutable evidence-only with zero write, lease,
   allocation, approval, or completion authority; applying a suggestion uses
   the complete generic decision/red-team/approval pipeline.
NAD-12. Window CAS rejects overlap, backward/duplicate/replayed sequences, and
   coalesces same-window transition triggers;
   restart admits exactly one validated catch-up, discards older missed windows,
   and creates no backlog storm or extra model turns.
NAD-13. Late, malformed, stale, unavailable, or failed `cron` review is bounded and
    nonblocking, leaves the last safe phase allocation unchanged, and cannot
    starve TDD, review, verification, red team, recovery, or control capacity;
    latest-wins admission keeps one pending and one active review, cancels
    superseded work, and enforces a dedicated reserve/duty-cycle cap.
NAD-14. Replaying the accepted native DAG, typed host-derived remaining-work
   estimates, host-observed novelty proofs, and policy digest yields the same
   independently admitted host critical-path certificate and ordering by
   time-to-genuine-proof, evidence gap, cost, uncertainty, queue age, and
   deterministic task ID/digest tie-break.
NAD-15. Native phase hints bind task, attempt, resource lease, ownership lease,
   discriminated capacity grant, and a task-value certificate; only unclaimed
   slots move in place, while
    claimed/active phases are fenced, reconciled, and retried under new IDs.
NAD-16. Authenticated monotonic TTL-bound capacity, usage, billing, and rate-limit
    refs resolve stale/expired/unknown headroom to zero at CAS, including
    provider charges.
NAD-17. Process/session/model-call/token/recovery control partitions cannot be
    borrowed by native workers, and `exclusive_unisolated` work is serialized
    away from the control plane; the generic `WorkflowCanonicalPoolLedger`
    separates instantaneous concurrency from cumulative spend with exhaustive
    components, and every `WorkflowControlCapacityVector` component is
    reconciled in admission, leases, grants, partitions, observations, and
    allocation CAS.
NAD-18. Crash tests before an applied marker prove allocation, lease, and provider
    effects through broker nonexecution evidence or fenced idempotent
    reconciliation; uncertain effects are quarantined and never blindly replayed.
NAD-19. Persisted aging, last-served, bounded priority-bucket promotion,
   exploration quota, numeric benefit threshold, minimum dwell, transition cap,
   positive finite/range-validated hysteresis numbers, and safety-only override
   prevent native role starvation and thrash across restart.
NAD-20. Expired native leases reclaim only after strong host/provider nonexecution
    proof; otherwise the finite reclaim deadline records terminal escalation and
    does not wait for an indefinite user reap.
NAD-21. Rapid phase observations keep one latest pending and one active review;
    superseded pending work is cancelled and an active result cannot apply
    after its fence.
NAD-22. Every dispatched phase/task has an independently admitted host task-value
   certificate naming an unproven requirement/evidence gap, host-observed
   novelty/nonduplicate proof, typed bounded observable outcome, and finite
   exploration quota.

Verification uses the existing session harness and faux provider for
deterministic phase tests. Worker, lease, journal, and daemon restart tests
use real child processes and durable artifacts; mock-only recovery evidence is
inadequate. Focused tests run from packages/coding-agent with the prescribed
Vitest command, and repository-wide verification is npm run check. The native
implementation must not weaken or replace existing commands to make a barrier
green.

## Implementation sequence and review gates

Implementation follows the methodology it embeds:

1. Vendor the pinned snapshot and notices; verify discovery and packaging.
2. Add pure native types, phase registry, and contract validators with tests.
3. Add provenance/digest verification and host bridge with tests.
4. Wire explicit activation and UI/CLI commands without changing ordinary
   sessions.
5. Add brainstorming/design/planning approvals and artifact recovery.
6. Add systematic-debugging and TDD enforcement.
7. Add task manifests, ownership, widest-safe waves, task reviews, fix rounds,
   and suite barriers.
8. Add final review, verification, branch finishing, and refinement gates.
9. Run real daemon recovery, compatibility, vendor-upgrade, and pressure-test
   campaigns.

Each slice is planned as a task with exact Files and Interfaces blocks. It is
implemented RED/GREEN/REFACTOR, reviewed for both spec compliance and quality,
fixed through bounded loops, and closed only at the combined-suite barrier.
This document is planning-only; it does not authorize implementation, branch
mutation, vendor sync, or a commit.

## Risks and unresolved design questions

These are explicit risks for written-spec review, not hidden assumptions:

- The current ResourceLoader records SourceInfo but does not yet expose a
  generation or full supporting-tree digest. The implementation must add that
  read-only observation without moving precedence or parsing skill prose.
- Existing RLM child admission does not necessarily carry a workflow
  idempotency key. Until it does, uncertain dispatches must remain quarantined
  and cannot be retried automatically.
- Shared-workspace ownership is cooperative unless host write enforcement is
  added. An unenforceable write set must serialize or use an isolated worktree;
  it must never be treated as safe parallelism.
- Branch finishing can involve external Git state and user authority. The
  host must keep the finish operation pending until the exact user choice is
  recorded; it cannot infer approval from a natural-language response.
- Pressure-test campaigns are expensive. The minimum counts in this design are
  acceptance requirements, but scheduling and artifact retention policy need
  bounded storage and cost limits in the generic workflow kernel.
- The exact UI representation of native phase status may use existing custom
  transcript messages and snapshots; no new daemon wire shape is assumed.
- The source fork may add a skill whose supporting runtime is not portable to
  Prime Agent. Such a skill is either retained as documentation-only with a
  recorded diagnostic or excluded by a reviewed vendor manifest; it is never
  silently rewritten.
