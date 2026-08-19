# Adaptive Workflow Recipes Design

Date: 2026-08-15  
Status: Approved additive addendum; implementation not started

This document is the approved additive design for adaptable workflow recipes.
It extends the six pinned documents below. The pins were computed read-only
from the repository on 2026-08-15; none of the pinned documents is changed by
this addendum.

| Pinned source | SHA-256 |
| --- | --- |
| `docs/superpowers/specs/2026-08-13-durable-workflows-design.md` | `d615adc25e3d032344b36fd90880d6cdc5a447b8e9d52cc9b7a7a44a97b7627a` |
| `docs/superpowers/specs/2026-08-13-native-methodology-design.md` | `1b43d0348bf6dde967c510fee9907a47c3aa3c978d23906361b68bd1cf06a39d` |
| `docs/superpowers/specs/2026-08-13-autoresearch-design.md` | `d094c18eac84ac55053989f32d9edf9d3d3f16eedba366852f1f1c5e49ce52b1` |
| `docs/superpowers/specs/2026-08-13-knowledge-refinement-design.md` | `a94fe8ba716ee058a092ca595b263d3ecc6f7570f44e64d1dcf5aa8fd388921f` |
| `docs/superpowers/plans/2026-08-13-durable-workflow-kernel.md` | `c96cde8f7c0b48f692f28ce96b670be45fe776640d432ee9fd3e4063d6951c48` |
| `docs/superpowers/plans/2026-08-13-durable-workflows-program.md` | `7bf837e341e9e9ccce54073fd01edb91916fcf04599d84399843dcff598087d0` |

The addendum does not reopen K-T0, change `WorkflowTask`, introduce a second
workflow authority, or authorize implementation outside the ownership table
below.

## 1. Goals and non-goals

### Goals

This addendum specifies a K-owned, immutable
`WorkflowMethodologyRecipe` artifact that is bound one-to-one to an existing
validated `WorkflowTask` DAG. It defines:

- a host-owned registry for stage and role semantics, capabilities,
  input/output schemas, evaluator and gate contracts, and resource classes;
- typed recipe nodes, task bindings, ports, schema digests, edges, fan-out,
  explicit joins, bounded back-edges, outputs, evidence, and host gates;
- binding to the existing goal, scorecard, decision, invariant, acceptance
  check, plan, configuration, resource envelope, and methodology manifests;
- deterministic K-T10A validation and scheduler mapping between K-T10 and
  K-T11;
- immutable revision, trial, hidden-holdout, canary, independent-review,
  promotion, and rollback records;
- a first-class pre-evaluation overfitting reviewer persona/lens with
  evidence-only output and host-owned hidden/adversarial holdout checks;
- native built-in AutoResearch experimentation and a native MemPalace
  durable-knowledge boundary, exposed through bundled facades and durable
  host-resolved skill snapshots; and
- recovery and idempotency rules that reuse existing artifact and journal
  mechanisms; and
- first-class acceptance fixtures for panel/research/attack/rule and
  attack/architect/judge/unify/edge_test.

### Non-goals

Recipes do not change a goal, scorecard, evaluator, approval policy, resource
ceiling, kernel contract, or completion predicate. They do not create tasks,
roles, authorities, daemon fields, journal event kinds, child runtimes,
unbounded loops, hidden holdouts chosen by a proposer, or a second scheduler.
They do not turn a role name, model output, utilization number, branch count,
or activity record into proof. They do not provide a compatibility escape from
an unknown or mismatched host manifest.

## 2. Terminology and authority

- **Recipe** is one immutable `WorkflowMethodologyRecipe` value for one
  workflow, plan revision, effective task-graph digest, configuration digest,
  and host-registry manifest digest.
- **Recipe node** is a typed evidence-producing description mapped to exactly
  one existing `WorkflowTask`. A node is not a task and cannot create a task.
- **Task boundary sidecar** is the smallest additive binding for generated
  outputs and lock paths that are absent from the frozen `WorkflowTask`.
- **Host registry** is the host-resolved, pinned manifest of stage contracts,
  role contracts, schemas, evaluators, gates, hidden tests, and resource
  classes. The recipe references registry entries by identifier and digest;
  it does not define their semantics.
- **Role label** is display and routing metadata only. A role label has no
  authority, evaluator meaning, approval power, or completion power.
- **Evidence** is an immutable, bounded observation or gate result addressed by
  a digest. Recipe nodes emit evidence only.
- **Gate** is a host-owned evaluator contract that may produce a proposal or a
  disposition. Only the existing universal host decision gate can authorize a
  consequential state change.
- **Recipe revision** is a new immutable artifact. Replacing a revision is a
  refinement decision, not mutation of an active artifact.
- **Branch instance** is a bounded execution instance under an existing node
  and task. It is not a new plan task or a new authority principal.
- **Back-edge** is a declared, gate-guarded edge that consumes a finite loop
  traversal budget. Every back-edge has a progress evidence contract and an
  exhaustion disposition.
- **Pre-evaluation overfitting reviewer** is the host-owned
  `pre_evaluation_overfitting` persona/lens. It checks metric locking, sample
  adequacy, separation, contamination, peeking, proxy exploitation, variance,
  and hidden/adversarial generalization. Its output is evidence only,
  advisory during exploration, and blocking before holdout, promotion,
  milestone acceptance, or completion. It has zero authority.
- **Native capability** is a built-in host implementation contract, not a
  vendored external implementation. The closed required set is exactly native
  AutoResearch, native MemPalace, and the native general-memory/refinement
  surface; Superpowers is the only optional host-discovered recipe library.
  Required/optional status is derived from that closed set, never accepted as
  a caller-supplied boolean. Each available capability is represented by a
  durable skill snapshot and manifest digest.
- **Capability gap** is an explicit typed missing, stale, or invalid skill
  result with a `wait`, `blocked`, or `failed` disposition. No capability gap
  silently falls back to another skill, evaluator, memory store, or authority.
- **Durable-knowledge boundary** is the native MemPalace boundary for reusable
  `how`/`why` knowledge only. A proposal must carry a typed prior canonical
  knowledge commit and authenticated host receipt, and the boundary returns
  both in its typed proposal output. It explicitly rejects `decision`,
  `outcome`, and `run_state` records; canonical commits precede any recall or
  index projection.

For a consequential state change, the invariant decision sequence remains:

```text
recon -> independent lenses -> verification -> synthesis
      -> red-team -> host-adjudication
```

The recipe may describe where evidence is gathered and how finite work is
connected, but it cannot remove, reorder, or weaken this sequence. The final
host-adjudication stage uses the existing `DurableHostAdjudication` and
`WorkflowDecisionRef` contracts. A node, role contract, judge, unifier,
evaluator, or red-team context cannot self-approve.

## 3. Architecture

The additive data flow is:

```text
goal/scorecard/config/plan decision
  -> existing WorkflowTask DAG
  -> K-T10 graph validation
  -> K-T10A sidecar + recipe binding and registry resolution
  -> worker-free ready-set and scheduler mapping
  -> host-admitted task/attempt/branch execution
  -> bounded node evidence and explicit joins
  -> judge/unify/edge-test and universal host gates
  -> existing task outcome, completion predicate, and decision projection
```

K owns the recipe artifact, schema, canonical digest, validator, sidecar join,
and scheduler mapping. The host registry owns the semantic contracts that a
recipe references. A owns runtime admission, leases, process identity,
dispatch, effects, cancellation, and recovery after consuming K's mapping. N,
R, and C may propose typed recipe revisions through their existing refinement
producer boundaries; none writes a recipe registry or promotes itself.

Direct integration is host-resolved rather than a vendored recipe
implementation. The native AutoResearch engine is required for the
experiment/improvement loop and exposes a bundled `autoresearch` skill facade;
the native MemPalace boundary is required for reusable how/why knowledge and
exposes bundled recall/write facades; general memory is also required and
remains on the existing native memory/refinement surface, separate from
transient run state. Superpowers is the only optional host-discovered
skill/recipe library and is never vendored. The host persists and resolves
each capability's immutable snapshot and manifest digest during activation and
recovery. A missing or mismatched required capability is an explicit
startup/readiness failure; a missing optional Superpowers capability returns
an explicit capability-gap result and omits only optional recipe enhancements.
No component may replace a missing capability, accept caller-provided native
required booleans, or use skill output as authority.

### Executable dependency gates

The recipe implementation is blocked until its named owner workstreams have
implemented and verified these exact prerequisite module/interface gates. The
paths below are implementation targets, not claims that a missing API is
already available:

| Gate | Required implementation surface | Recipe work that remains blocked until it passes |
| --- | --- | --- |
| K | `packages/coding-agent/src/core/workflow/config.ts` (`resolveWorkflowRuntimeConfig`); `task-graph.ts` (`validateWorkflowTaskGraph`, `computeReadyTaskIds`, `WorkflowTaskGraphContext`); `evidence.ts` (`validateWorkflowEvidenceEnvelopeRef`); `decision-gate.ts` (`WorkflowDecisionGate`); artifact publisher/resolver and `recovery.ts` (`WorkflowRecoveryPort`) | K-T10A contracts, activation, validation, evidence, and artifact recovery |
| A | `packages/coding-agent/src/core/workflow/dispatch.ts` (`WorkflowDispatcher`), `scheduler.ts` (`WorkflowScheduler`), and `runtime-recovery.ts` (`WorkflowRecoveryCoordinator`) with authenticated observe/enqueue/refill/reconcile ports | Runtime handoff, fencing, true-runtime acceptance, and recovery |
| R | `packages/coding-agent/src/core/autoresearch/types.ts`, `admission.ts`, `scheduler.ts`, `projection.ts`, `recovery.ts`, and `refinement.ts`, plus the native engine interface in `core/autoresearch/engine.ts` | AutoResearch experiment loop, evaluator/overfitting evidence, and recipe capability resolution |
| C | `packages/coding-agent/src/core/knowledge/knowledge-types.ts`, `knowledge-evidence.ts`, `knowledge-decision.ts`, `knowledge-store.ts`, `knowledge-recall.ts`, `knowledge-controls.ts`, and the canonical readiness artifact, plus the native boundary in `core/knowledge/mempalace-boundary.ts` | MemPalace prior-commit/receipt proposals, general-memory/refinement integration, and recovery |

Each gate must publish its typed interface manifest, test evidence, and
recovery-validated digest before the dependent recipe task may start. A
missing, stale, or unverified gate returns an explicit capability/dependency
failure and blocks acceptance. There is no mock, in-memory, caller-supplied,
or silent fallback implementation for any required gate; optional Superpowers
absence can omit only optional recipe enhancements.

The recipe artifact is bound through existing `planDigest`, `artifactRefs`,
and `WorkflowRuntimeConfigSnapshot.methodologyManifestDigests` plus the
existing configuration and decision digests. Recipe activation is declared by
a supported recipe-aware local `configSchemaVersion`, an exact reserved
methodology-manifest digest, and exactly one decision artifact reference at
the canonical recipe path. These three values are one closed activation
contract; none is optional when another is present. Ordinary workflows retain
the current configuration schema and existing task-graph path. A declared
recipe that is missing, unknown, stale, ambiguous, or mismatched fails closed.

Before K-T10A ships, configuration loading must already reject every
unsupported `configSchemaVersion` before graph validation or readiness. The
recipe-aware version is then introduced as an additive local configuration
schema revision. This makes requiredness visible before the recipe payload is
interpreted: a reader that does not implement recipes cannot treat the
artifact as optional or dispatch the plain DAG. The reserved methodology
manifest and canonical artifact path are constants owned by K, not strings
selected by a planner or recipe node.

The recipe does not add a journal event or daemon wire field. The recipe and
the task-boundary sidecar are immutable local artifacts. Their references are
included in the already-existing plan/decision artifact references and
configuration closure. No child receives raw recipe prose as authority; the
host resolves the registry contract and sends only the admitted capability,
schema, lease, and evidence context.

## 4. K-T10 contract drift and the smallest sidecar binding

The frozen `WorkflowTask` in
`packages/coding-agent/src/core/workflow/contracts.ts` contains `ownedPaths`
and `ownedContracts`, but not `generatedOutputPaths` or `lockPaths`. The K plan
for K-T10 currently describes those two fields in graph context/result logic
and in ownership-overlap checks. `WorkflowOwnershipLease` has optional fields
with those names, but a lease is too late to validate a graph and does not
bind the plan's output/lock contract.

The smallest additive correction is a task-keyed immutable sidecar map. It
does not alter `WorkflowTask`, `WorkflowOwnershipLease`, the journal event
union, or the daemon protocol.

### Sidecar behavior

1. K-T10A receives the frozen `WorkflowTask[]`, the existing K-T10 graph
   context, and an optional `WorkflowTaskBoundarySidecarMap`.
2. For a legacy graph with no declared recipe, the adapter supplies empty
   generated-output and lock sets. This preserves the existing graph behavior
   without adding fields to `WorkflowTask`.
3. For a recipe-bound graph, the map is mandatory, its
   `baseTaskGraphDigest` must match the frozen tasks, and it must contain one
   entry for every task and no other entry. An entry with empty arrays is still
   required; absence is not interpreted as an empty value.
4. The adapter verifies each entry's frozen `taskDigest`, canonicalizes and
   sorts its paths, and computes one effective graph digest over the frozen
   task values plus the sidecar values. The recipe must bind that effective
   digest.
5. Ownership overlap uses exactly the K-T10 ancestor/descendant path rule
   across `ownedPaths`, `generatedOutputPaths`, and `lockPaths`. Independent
   tasks with an overlapping path or contract are rejected. Dependencies may
   serialize an otherwise overlapping pair, as in the frozen K-T10 behavior.
6. A generated output or lock path outside the canonical workspace is rejected.
   Duplicate paths are canonicalized before comparison. A lock path is not a
   generated output path. No path is accepted from a recipe node or role label
   without the sidecar entry.
7. A recipe reference, sidecar reference, base digest, effective digest, or
   registry manifest mismatch returns a typed validation failure and no task
   becomes ready. The adapter does not guess, merge, or silently downgrade.
8. The resulting effective view is an internal K-T10A value. It is never
   cast back to `WorkflowTask` and is not serialized as a new generic contract.

The exact regression test constructs a value typed as the frozen
`WorkflowTask` without either missing field, proves that the base graph still
validates, joins a two-entry sidecar map, asserts both path sets appear in the
effective graph digest, rejects a foreign `taskId` and a stale
`frozenTaskDigest`, and confirms that an independent path overlap prevents
both tasks from becoming ready. It also asserts that a recipe-bound graph
with no sidecar returns `recipe_sidecar_missing` rather than treating the
paths as empty.

The sidecar map is stored in the same immutable canonical-JSON artifact as the
recipe or in a separately referenced canonical-JSON barrier artifact. Both
forms have the same digest and validation rules. The recommended first release
uses one artifact payload with schema identifier
`workflow-methodology-recipe-v1` and existing artifact `payloadKind: "barrier"`.
No `WorkflowArtifactPayloadKind` extension is therefore required. If a future
implementation introduces a dedicated payload kind, that union change is an
additive artifact-schema revision only, is capability-independent, and is a
local projection; it must not add a journal event or daemon field and must not
become required for ordinary workflows.

## 5. Exact serializable interfaces

The following interfaces are the closed recipe surface. They contain only
JSON-serializable values: strings, finite numbers, booleans, nulls, arrays,
and objects with fixed keys. The shared types are imported from the frozen
workflow contracts; they are not redeclared here.

```ts
import type {
  WorkflowArtifactRef,
  WorkflowControlCapacityVector,
  WorkflowDecisionRef,
  WorkflowEpochRef,
  WorkflowEvidenceEnvelopeRef,
  WorkflowResourceVector,
  WorkflowTask,
} from "./contracts.js";

export type WorkflowRecipeDigest = string;
export const WORKFLOW_RECIPE_CONFIG_SCHEMA_VERSION = 2;
export const WORKFLOW_RECIPE_ARTIFACT_SCHEMA_ID = "workflow-methodology-recipe-v1";
export const WORKFLOW_RECIPE_ARTIFACT_PATH_PREFIX = "artifacts/barrier/";
export type WorkflowRecipeId = string;
export type WorkflowRecipeNodeId = string;
export type WorkflowRecipeTaskId = WorkflowTask["taskId"];
export type WorkflowRecipePortId = string;
export type WorkflowRecipeEdgeId = string;
export type WorkflowRecipeFanOutId = string;
export type WorkflowRecipeJoinId = string;
export type WorkflowRecipeLoopId = string;
export type WorkflowRecipeGateId = string;
export type WorkflowRecipeGateContractId = string;
export type WorkflowRecipeSchemaId = string;
export type WorkflowRecipeRoleContractId = string;
export type WorkflowRecipeStageContractId = string;
export type WorkflowRecipeEvaluatorContractId = string;
export type WorkflowRecipeManifestId = string;
export type WorkflowRecipeBranchInstanceId = string;
export type WorkflowRecipeReviewerContractId = string;
export type WorkflowRecipeReviewId = string;
export type WorkflowRecipeRequiredNativeCapability = "autoresearch" | "mempalace" | "general_memory";
export type WorkflowRecipeOptionalCapability = "superpowers";
export type WorkflowRecipeSkillId = WorkflowRecipeRequiredNativeCapability | WorkflowRecipeOptionalCapability;
export type WorkflowRecipeSkillSnapshotId = string;
export type WorkflowRecipeCapabilityGapId = string;
export type WorkflowRecipeHiddenHoldoutHandleId = string;
export type WorkflowRecipeHiddenHoldoutResolverContextId = string;
export type WorkflowRecipeKnowledgeCommitId = string;
export type WorkflowRecipeKnowledgeReceiptId = string;

export const WORKFLOW_RECIPE_REQUIRED_NATIVE_CAPABILITIES: readonly WorkflowRecipeRequiredNativeCapability[] = [
  "autoresearch",
  "mempalace",
  "general_memory",
];
export const WORKFLOW_RECIPE_OPTIONAL_CAPABILITIES: readonly WorkflowRecipeOptionalCapability[] = ["superpowers"];

export type WorkflowRecipeStageKind =
  | "recon"
  | "lens"
  | "verification"
  | "synthesis"
  | "red_team"
  | "host_adjudication";

export type WorkflowRecipeGateKind =
  | "judge"
  | "unify"
  | "edge_test"
  | "scorecard"
  | "decision"
  | "invariant"
  | "check"
  | "host_adjudication";

export type WorkflowRecipeCapabilityClass =
  | "read_only"
  | "shell"
  | "ipython"
  | "edit"
  | "recursive_spawn";

export type WorkflowRecipeResourceClass =
  | "control"
  | "worker"
  | "verification"
  | "red_team"
  | "recovery"
  | "exclusive_unisolated";

export type WorkflowRecipeOverfittingCheckKind =
  | "metric_preregistration_lock"
  | "sample_adequacy"
  | "train_eval_separation"
  | "test_contamination"
  | "repeated_holdout_peeking"
  | "proxy_exploitation"
  | "variance_replicate_stability"
  | "hidden_adversarial_generalization";

export type WorkflowRecipeOverfittingBlockingBoundary =
  | "holdout_passed"
  | "canary"
  | "independent_review"
  | "promoted"
  | "milestone_acceptance"
  | "completion";

export type WorkflowRecipeOverfittingCheckDisposition = "pass" | "fail" | "inconclusive";
export type WorkflowRecipeOverfittingReviewDisposition = "advisory" | "blocking";
export type WorkflowRecipeRedTeamCaseId =
  | "small_data_win"
  | "data_leakage"
  | "repeated_peeking"
  | "unstable_variance"
  | "held_out_degradation";

export type WorkflowRecipeCapabilitySource = "host_builtin" | "host_discovered";
export type WorkflowRecipeCapabilityImplementation = "native_engine" | "native_boundary" | "host_discovered_skill";
export type WorkflowRecipeCapabilityGapDisposition = "wait" | "blocked" | "failed";
export type WorkflowRecipeCapabilityGapCode =
  | "required_capability_missing"
  | "capability_snapshot_missing"
  | "capability_manifest_mismatch"
  | "capability_gap_unavailable";

export type WorkflowRecipePortDirection = "input" | "output";
export type WorkflowRecipePortValueKind =
  | "artifact_ref"
  | "evidence_ref"
  | "branch_key"
  | "gate_verdict"
  | "scalar";
export type WorkflowRecipePortCardinality = "one" | "optional" | "many";

export interface WorkflowRecipeSchemaRef {
  schemaId: WorkflowRecipeSchemaId;
  schemaRevision: number;
  schemaDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeSchemaContract {
  schemaId: WorkflowRecipeSchemaId;
  schemaRevision: number;
  valueKind: WorkflowRecipePortValueKind;
  maxBytes: number;
  maxItems: number;
  digest: WorkflowRecipeDigest;
  owner: "host";
}

export interface WorkflowRecipeStageContract {
  stageContractId: WorkflowRecipeStageContractId;
  stageRevision: number;
  stageKind: WorkflowRecipeStageKind;
  requiredPredecessorKinds: readonly WorkflowRecipeStageKind[];
  consequential: boolean;
  universalGateRequired: true;
  semanticDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeRoleContract {
  roleContractId: WorkflowRecipeRoleContractId;
  roleRevision: number;
  displayLabel: string;
  stageContractId: WorkflowRecipeStageContractId;
  inputSchemaRefs: readonly WorkflowRecipeSchemaRef[];
  outputSchemaRefs: readonly WorkflowRecipeSchemaRef[];
  capabilitySetDigest: WorkflowRecipeDigest;
  resourceClass: WorkflowRecipeResourceClass;
  evaluatorContractIds: readonly WorkflowRecipeEvaluatorContractId[];
  gateContractIds: readonly WorkflowRecipeGateContractId[];
  canAuthorize: false;
  semanticDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeEvaluatorContract {
  evaluatorContractId: WorkflowRecipeEvaluatorContractId;
  evaluatorRevision: number;
  evaluatorDigest: WorkflowRecipeDigest;
  parserDigest: WorkflowRecipeDigest;
  guardDigest: WorkflowRecipeDigest;
  scorecardBound: true;
  owner: "host";
  heldOutRequired: true;
  independentReviewRequired: true;
  semanticDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeOverfittingReviewerContract {
  reviewerContractId: WorkflowRecipeReviewerContractId;
  reviewerRevision: number;
  persona: "pre_evaluation_overfitting";
  lens: "pre_evaluation_overfitting";
  checkKinds: readonly WorkflowRecipeOverfittingCheckKind[];
  evaluatorContractId: WorkflowRecipeEvaluatorContractId;
  hiddenTestManifestIds: readonly WorkflowRecipeManifestId[];
  owner: "host";
  emitsEvidenceOnly: true;
  authorityCapabilities: readonly [];
  canAuthorize: false;
  advisoryDuringExploration: true;
  blockingBefore: readonly WorkflowRecipeOverfittingBlockingBoundary[];
  proposerSeesHiddenHoldoutBytes: false;
  semanticDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeSkillSnapshot {
  snapshotId: WorkflowRecipeSkillSnapshotId;
  skillId: WorkflowRecipeSkillId;
  source: WorkflowRecipeCapabilitySource;
  implementation: WorkflowRecipeCapabilityImplementation;
  vendored: false;
  snapshotArtifactRef: WorkflowArtifactRef;
  contentDigest: WorkflowRecipeDigest;
  dependencyDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
  snapshotDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeRequiredNativeCapabilityManifest {
  capabilityId: WorkflowRecipeRequiredNativeCapability;
  source: "host_builtin";
  implementation: "native_engine" | "native_boundary";
  required: true;
  builtIn: true;
  skillSnapshot: WorkflowRecipeSkillSnapshot;
  outputEvidenceOnly: true;
  canAuthorize: false;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeOptionalCapabilityManifest {
  capabilityId: WorkflowRecipeOptionalCapability;
  source: "host_discovered";
  implementation: "host_discovered_skill";
  required: false;
  builtIn: false;
  skillSnapshot: WorkflowRecipeSkillSnapshot;
  outputEvidenceOnly: true;
  canAuthorize: false;
  manifestDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeCapabilityManifest =
  | WorkflowRecipeRequiredNativeCapabilityManifest
  | WorkflowRecipeOptionalCapabilityManifest;

export interface WorkflowRecipeAutoResearchEngineContract {
  capabilityId: "autoresearch";
  engineRevision: number;
  engineKind: "native_builtin_experiment_engine";
  facadeSkillId: "autoresearch";
  required: true;
  primaryMetricLocked: true;
  evaluatorContractId: WorkflowRecipeEvaluatorContractId;
  overfittingReviewerContractId: WorkflowRecipeReviewerContractId;
  emitsEvidenceOnly: true;
  canAuthorize: false;
  engineDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeDurableKnowledgeBoundary {
  schemaId: "workflow-durable-knowledge-boundary-v1";
  capabilityId: "mempalace";
  boundaryKind: "native_builtin_how_why";
  facadeSkillId: "mempalace";
  allowedKnowledgeKinds: readonly ["how", "why"];
  forbiddenKinds: readonly ["decision", "outcome", "run_state"];
  canonicalCommitRequired: true;
  hostReceiptRequired: true;
  returnsPriorCanonicalCommit: true;
  returnsHostReceipt: true;
  sourceEvidenceRequired: true;
  outputEvidenceOnly: true;
  canAuthorize: false;
  boundaryDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeHostKnowledgeReceipt {
  receiptId: WorkflowRecipeKnowledgeReceiptId;
  receiptKind: "canonical_knowledge_commit";
  owner: "host";
  authenticated: true;
  commitId: WorkflowRecipeKnowledgeCommitId;
  commitDigest: WorkflowRecipeDigest;
  receiptRef: WorkflowArtifactRef;
  receiptDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipePriorCanonicalKnowledgeCommit {
  commitId: WorkflowRecipeKnowledgeCommitId;
  knowledgeKind: "how" | "why";
  canonicalArtifactRef: WorkflowArtifactRef;
  canonicalDigest: WorkflowRecipeDigest;
  sourceEvidenceRefs: readonly WorkflowArtifactRef[];
  hostReceipt: WorkflowRecipeHostKnowledgeReceipt;
  commitDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeMemPalaceProposalInput {
  knowledgeKind: "how" | "why";
  sourceEvidenceRefs: readonly WorkflowArtifactRef[];
  priorCanonicalCommit: WorkflowRecipePriorCanonicalKnowledgeCommit;
  hostReceipt: WorkflowRecipeHostKnowledgeReceipt;
}

export interface WorkflowRecipeSkillOutput {
  skillId: WorkflowRecipeSkillId;
  outputKind: "evidence" | "knowledge_proposal";
  evidenceRefs: readonly WorkflowArtifactRef[];
  durableKnowledgeBoundaryDigest: WorkflowRecipeDigest | null;
  transientStateRefs: readonly [];
  priorCanonicalCommit: WorkflowRecipePriorCanonicalKnowledgeCommit | null;
  hostReceipt: WorkflowRecipeHostKnowledgeReceipt | null;
  rejectedKinds: readonly ["decision", "outcome", "run_state"];
  canAuthorize: false;
  outputDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeMemPalaceProposalOutput extends WorkflowRecipeSkillOutput {
  skillId: "mempalace";
  outputKind: "knowledge_proposal";
  priorCanonicalCommit: WorkflowRecipePriorCanonicalKnowledgeCommit;
  hostReceipt: WorkflowRecipeHostKnowledgeReceipt;
}

export interface WorkflowRecipeRequiredNativeSkillBinding {
  skillId: WorkflowRecipeRequiredNativeCapability;
  required: true;
  source: "host_builtin";
  snapshotDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
  capabilityGapId: WorkflowRecipeCapabilityGapId | null;
  outputEvidenceOnly: true;
  canAuthorize: false;
  bindingDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeOptionalSkillBinding {
  skillId: WorkflowRecipeOptionalCapability;
  required: false;
  source: "host_discovered";
  snapshotDigest: WorkflowRecipeDigest | null;
  manifestDigest: WorkflowRecipeDigest | null;
  capabilityGapId: WorkflowRecipeCapabilityGapId | null;
  outputEvidenceOnly: true;
  canAuthorize: false;
  bindingDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeSkillBinding = WorkflowRecipeRequiredNativeSkillBinding | WorkflowRecipeOptionalSkillBinding;

export interface WorkflowRecipeCapabilityGapBase {
  gapId: WorkflowRecipeCapabilityGapId;
  code: WorkflowRecipeCapabilityGapCode;
  phase: "startup" | "readiness" | "activation" | "recovery";
  disposition: WorkflowRecipeCapabilityGapDisposition;
  fallback: "none";
  expectedManifestDigest: WorkflowRecipeDigest | null;
  observedManifestDigest: WorkflowRecipeDigest | null;
  evidenceRefs: readonly WorkflowArtifactRef[];
  gapDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeCapabilityGap =
  | (WorkflowRecipeCapabilityGapBase & {
      capabilityId: WorkflowRecipeRequiredNativeCapability;
      required: true;
    })
  | (WorkflowRecipeCapabilityGapBase & {
      capabilityId: WorkflowRecipeOptionalCapability;
      required: false;
    });

export interface WorkflowRecipeGateContract {
  gateContractId: WorkflowRecipeGateContractId;
  gateRevision: number;
  gateKind: WorkflowRecipeGateKind;
  evaluatorContractId: WorkflowRecipeEvaluatorContractId;
  inputSchemaRefs: readonly WorkflowRecipeSchemaRef[];
  outputSchemaRefs: readonly WorkflowRecipeSchemaRef[];
  hostOwned: true;
  nodeMayEmitEvidenceOnly: true;
  requiresIndependentContext: boolean;
  semanticDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeHostOnlyHiddenHoldoutHandle {
  handleId: WorkflowRecipeHiddenHoldoutHandleId;
  owner: "host";
  hidden: true;
  opaque: true;
  hostResolverOnly: true;
  manifestDigest: WorkflowRecipeDigest;
  caseCount: number;
  bytesAccessibleToProposer: false;
  bytesAccessibleToWorker: false;
  handleDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeHiddenHoldoutResolverContext {
  contextId: WorkflowRecipeHiddenHoldoutResolverContextId;
  owner: "host";
  authorizedConsumer: "host_overfitting_reviewer";
  handleId: WorkflowRecipeHiddenHoldoutHandleId;
  authenticated: true;
  returnsEvidenceOnly: true;
  returnsBytes: false;
  authorizationReceiptRef: WorkflowArtifactRef;
  contextDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeHiddenHoldoutEvidence {
  handleId: WorkflowRecipeHiddenHoldoutHandleId;
  contextId: WorkflowRecipeHiddenHoldoutResolverContextId;
  evidenceRefs: readonly WorkflowArtifactRef[];
  hostReceiptRef: WorkflowArtifactRef;
  bytesReturned: false;
  evidenceDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeHiddenTestManifest {
  manifestId: WorkflowRecipeManifestId;
  manifestRevision: number;
  owner: "host";
  hidden: true;
  immutable: true;
  inputSchemaDigest: WorkflowRecipeDigest;
  evaluatorContractId: WorkflowRecipeEvaluatorContractId;
  caseCount: number;
  hiddenHoldoutHandle: WorkflowRecipeHostOnlyHiddenHoldoutHandle;
  resolverContext: WorkflowRecipeHiddenHoldoutResolverContext;
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeHostRegistrySnapshot {
  registryId: string;
  registryRevision: number;
  stageContracts: readonly WorkflowRecipeStageContract[];
  roleContracts: readonly WorkflowRecipeRoleContract[];
  schemaContracts: readonly WorkflowRecipeSchemaContract[];
  evaluatorContracts: readonly WorkflowRecipeEvaluatorContract[];
  reviewerContracts: readonly WorkflowRecipeOverfittingReviewerContract[];
  gateContracts: readonly WorkflowRecipeGateContract[];
  hiddenTestManifests: readonly WorkflowRecipeHiddenTestManifest[];
  capabilityManifests: readonly WorkflowRecipeCapabilityManifest[];
  durableKnowledgeBoundary: WorkflowRecipeDurableKnowledgeBoundary;
  resourceClassDigests: readonly WorkflowRecipeDigest[];
  registryManifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeRegistryResolution {
  registryManifestDigest: WorkflowRecipeDigest;
  roleContractDigests: readonly WorkflowRecipeDigest[];
  stageContractDigests: readonly WorkflowRecipeDigest[];
  schemaDigests: readonly WorkflowRecipeDigest[];
  evaluatorDigests: readonly WorkflowRecipeDigest[];
  reviewerContractDigests: readonly WorkflowRecipeDigest[];
  gateDigests: readonly WorkflowRecipeDigest[];
  hiddenTestManifestDigests: readonly WorkflowRecipeDigest[];
  capabilitySnapshotDigests: readonly WorkflowRecipeDigest[];
  capabilityManifestDigests: readonly WorkflowRecipeDigest[];
  durableKnowledgeBoundaryDigest: WorkflowRecipeDigest;
  capabilityGaps: readonly WorkflowRecipeCapabilityGap[];
  resolvedByHost: true;
  resolutionDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipePortSpec {
  portId: WorkflowRecipePortId;
  direction: WorkflowRecipePortDirection;
  valueKind: WorkflowRecipePortValueKind;
  schemaRef: WorkflowRecipeSchemaRef;
  cardinality: WorkflowRecipePortCardinality;
  required: boolean;
  evidenceContractId: string | null;
  portDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeEvidenceContract {
  evidenceContractId: string;
  evidenceKind: string;
  required: true;
  bounded: true;
  schemaRef: WorkflowRecipeSchemaRef;
  requiredArtifactKinds: readonly string[];
  evaluatorContractId: WorkflowRecipeEvaluatorContractId;
  independentVerificationRequired: boolean;
  hostAdjudicationRequired: boolean;
  evidenceDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeOverfittingReviewerBinding {
  reviewerContractId: WorkflowRecipeReviewerContractId;
  reviewerContractDigest: WorkflowRecipeDigest;
  persona: "pre_evaluation_overfitting";
  lens: "pre_evaluation_overfitting";
  requiredCheckKinds: readonly WorkflowRecipeOverfittingCheckKind[];
  evidenceContractIds: readonly string[];
  hiddenTestManifestIds: readonly WorkflowRecipeManifestId[];
  advisoryDuringExploration: true;
  blockingBefore: readonly WorkflowRecipeOverfittingBlockingBoundary[];
  proposerSeesHiddenHoldoutBytes: false;
  emitsEvidenceOnly: true;
  canAuthorize: false;
  bindingDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeOverfittingCheckResult {
  checkKind: WorkflowRecipeOverfittingCheckKind;
  disposition: WorkflowRecipeOverfittingCheckDisposition;
  evidenceRefs: readonly WorkflowArtifactRef[];
  hostHiddenHoldoutHandles: readonly WorkflowRecipeHostOnlyHiddenHoldoutHandle[];
  resolverContexts: readonly WorkflowRecipeHiddenHoldoutResolverContext[];
  hiddenHoldoutBytesExposed: false;
  resultDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeOverfittingReview {
  reviewId: WorkflowRecipeReviewId;
  recipeDigest: WorkflowRecipeDigest;
  recipeRevision: number;
  reviewerContractId: WorkflowRecipeReviewerContractId;
  reviewerContractDigest: WorkflowRecipeDigest;
  persona: "pre_evaluation_overfitting";
  lens: "pre_evaluation_overfitting";
  checkResults: readonly WorkflowRecipeOverfittingCheckResult[];
  disposition: WorkflowRecipeOverfittingReviewDisposition;
  explorationAdvisory: true;
  blockingBefore: readonly WorkflowRecipeOverfittingBlockingBoundary[];
  proposerSeesHiddenHoldoutBytes: false;
  reviewerCanAuthorize: false;
  hostAdjudicationReceiptRef: WorkflowArtifactRef | null;
  accepted: boolean;
  reviewDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeEdgeGuard =
  | { kind: "always" }
  | { kind: "gate_accepted"; gateId: WorkflowRecipeGateId }
  | { kind: "gate_rejected"; gateId: WorkflowRecipeGateId };

export interface WorkflowRecipeEdge {
  edgeId: WorkflowRecipeEdgeId;
  fromNodeId: WorkflowRecipeNodeId;
  fromPortId: WorkflowRecipePortId;
  toNodeId: WorkflowRecipeNodeId;
  toPortId: WorkflowRecipePortId;
  guard: WorkflowRecipeEdgeGuard;
  backEdgeLoopId: WorkflowRecipeLoopId | null;
  edgeDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeJoinPolicy =
  | { kind: "all"; expectedBranches: number }
  | { kind: "quorum"; minimumBranches: number; maximumBranches: number }
  | { kind: "any"; maximumBranches: number }
  | { kind: "first_success"; maximumBranches: number };

export interface WorkflowRecipeFanOutSpec {
  fanOutId: WorkflowRecipeFanOutId;
  sourceNodeId: WorkflowRecipeNodeId;
  sourcePortId: WorkflowRecipePortId;
  branchNodeIds: readonly WorkflowRecipeNodeId[];
  branchKeySchemaRef: WorkflowRecipeSchemaRef;
  maxBranches: number;
  branchOrdering: "canonical_key";
  branchFailurePolicy: "fail_join" | "record_and_join" | "stop_at_first_failure";
  explicitJoinId: WorkflowRecipeJoinId;
  fanOutDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeJoinSpec {
  joinId: WorkflowRecipeJoinId;
  inputNodeIds: readonly WorkflowRecipeNodeId[];
  inputPortIds: readonly WorkflowRecipePortId[];
  outputNodeId: WorkflowRecipeNodeId;
  outputPortId: WorkflowRecipePortId;
  policy: WorkflowRecipeJoinPolicy;
  maxWaitMilliseconds: number;
  evidenceContractId: string;
  joinDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeLoopPolicy {
  loopId: WorkflowRecipeLoopId;
  backEdgeId: WorkflowRecipeEdgeId;
  sourceNodeId: WorkflowRecipeNodeId;
  targetNodeId: WorkflowRecipeNodeId;
  failureGateId: WorkflowRecipeGateId;
  maxTraversals: number;
  progressEvidenceContractId: string;
  terminationGateId: WorkflowRecipeGateId;
  exhaustedDisposition: "blocked" | "failed" | "awaiting_user";
  loopDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeDemandHint {
  resourceClass: WorkflowRecipeResourceClass;
  declaredVector: WorkflowResourceVector;
  declaredControlCapacity: WorkflowControlCapacityVector;
  maxParallelBranches: number;
  preferredPoolDigest: WorkflowRecipeDigest | null;
  widestSafePriority: number;
  hintDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeGateBinding {
  gateId: WorkflowRecipeGateId;
  gateKind: WorkflowRecipeGateKind;
  gateContractId: WorkflowRecipeGateContractId;
  inputPortIds: readonly WorkflowRecipePortId[];
  outputEvidenceContractIds: readonly string[];
  scorecardDigest: WorkflowRecipeDigest;
  decisionRef: WorkflowDecisionRef;
  independentReviewRequired: boolean;
  nodeMayAuthorize: false;
  bindingDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeNode {
  nodeId: WorkflowRecipeNodeId;
  taskId: WorkflowRecipeTaskId;
  stageContractId: WorkflowRecipeStageContractId;
  roleContractId: WorkflowRecipeRoleContractId;
  inputPorts: readonly WorkflowRecipePortSpec[];
  outputPorts: readonly WorkflowRecipePortSpec[];
  evidenceContractIds: readonly string[];
  gateIds: readonly WorkflowRecipeGateId[];
  fanOutIds: readonly WorkflowRecipeFanOutId[];
  joinIds: readonly WorkflowRecipeJoinId[];
  loopIds: readonly WorkflowRecipeLoopId[];
  demandHint: WorkflowRecipeDemandHint;
  emitsEvidenceOnly: true;
  authorityCapabilities: readonly [];
  nodeDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeTaskNodeBinding {
  taskId: WorkflowRecipeTaskId;
  nodeId: WorkflowRecipeNodeId;
  frozenTaskDigest: WorkflowRecipeDigest;
  bindingDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeOutputContract {
  terminalNodeIds: readonly WorkflowRecipeNodeId[];
  requiredEvidenceContractIds: readonly string[];
  completionPredicateDigest: WorkflowRecipeDigest;
  hostAdjudicationGateId: WorkflowRecipeGateId;
  overfittingReviewRequired: true;
  outputSchemaRefs: readonly WorkflowRecipeSchemaRef[];
  outputDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeBinding {
  workflowId: string;
  planRevision: number;
  taskGraphDigest: WorkflowRecipeDigest;
  planDigest: WorkflowRecipeDigest;
  goalContractDigest: WorkflowRecipeDigest;
  scorecardDigest: WorkflowRecipeDigest;
  decisionRef: WorkflowDecisionRef;
  invariantDigests: readonly WorkflowRecipeDigest[];
  acceptanceCheckDigests: readonly WorkflowRecipeDigest[];
  evaluatorDigests: readonly WorkflowRecipeDigest[];
  requiredSkillSnapshotDigests: readonly WorkflowRecipeDigest[];
  skillManifestDigests: readonly WorkflowRecipeDigest[];
  durableKnowledgeBoundaryDigest: WorkflowRecipeDigest;
  universalStageContractIds: readonly WorkflowRecipeStageContractId[];
  overfittingReviewerDigest: WorkflowRecipeDigest;
  configDigest: WorkflowRecipeDigest;
  methodologyManifestDigests: readonly WorkflowRecipeDigest[];
  registryManifestDigest: WorkflowRecipeDigest;
  resourceEnvelopeDigest: WorkflowRecipeDigest;
  completionPredicateDigest: WorkflowRecipeDigest;
  recipeArtifactRef: WorkflowArtifactRef;
  boundarySidecarArtifactRef: WorkflowArtifactRef;
  bindingDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeManifest {
  manifestId: WorkflowRecipeManifestId;
  artifactSchemaId: typeof WORKFLOW_RECIPE_ARTIFACT_SCHEMA_ID;
  artifactSchemaRevision: 1;
  recipeId: WorkflowRecipeId;
  recipeRevision: number;
  registryManifestDigest: WorkflowRecipeDigest;
  configDigest: WorkflowRecipeDigest;
  methodologyManifestDigests: readonly WorkflowRecipeDigest[];
  roleContractDigests: readonly WorkflowRecipeDigest[];
  stageContractDigests: readonly WorkflowRecipeDigest[];
  schemaDigests: readonly WorkflowRecipeDigest[];
  evaluatorDigests: readonly WorkflowRecipeDigest[];
  gateDigests: readonly WorkflowRecipeDigest[];
  hiddenTestManifestDigests: readonly WorkflowRecipeDigest[];
  reviewerContractDigests: readonly WorkflowRecipeDigest[];
  capabilitySnapshotDigests: readonly WorkflowRecipeDigest[];
  capabilityManifestDigests: readonly WorkflowRecipeDigest[];
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowMethodologyRecipe {
  recipeId: WorkflowRecipeId;
  recipeRevision: number;
  workflowId: string;
  planRevision: number;
  taskGraphDigest: WorkflowRecipeDigest;
  taskNodeBindings: readonly WorkflowRecipeTaskNodeBinding[];
  nodes: readonly WorkflowRecipeNode[];
  edges: readonly WorkflowRecipeEdge[];
  fanOuts: readonly WorkflowRecipeFanOutSpec[];
  joins: readonly WorkflowRecipeJoinSpec[];
  loops: readonly WorkflowRecipeLoopPolicy[];
  gates: readonly WorkflowRecipeGateBinding[];
  evidenceContracts: readonly WorkflowRecipeEvidenceContract[];
  overfittingReviewer: WorkflowRecipeOverfittingReviewerBinding;
  skillBindings: readonly WorkflowRecipeSkillBinding[];
  durableKnowledgeBoundary: WorkflowRecipeDurableKnowledgeBoundary;
  outputContract: WorkflowRecipeOutputContract;
  binding: WorkflowRecipeBinding;
  registryResolution: WorkflowRecipeRegistryResolution;
  manifest: WorkflowRecipeManifest;
  recipeDigest: WorkflowRecipeDigest;
}

export interface WorkflowTaskBoundarySidecar {
  sidecarSchemaId: "workflow-task-boundary-v1";
  workflowId: string;
  planRevision: number;
  taskId: WorkflowRecipeTaskId;
  frozenTaskDigest: WorkflowRecipeDigest;
  generatedOutputPaths: readonly string[];
  lockPaths: readonly string[];
  entryDigest: WorkflowRecipeDigest;
}

export interface WorkflowTaskBoundarySidecarMap {
  sidecarSchemaId: "workflow-task-boundary-map-v1";
  workflowId: string;
  planRevision: number;
  baseTaskGraphDigest: WorkflowRecipeDigest;
  entries: readonly WorkflowTaskBoundarySidecar[];
  mapDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeTaskGraphBinding {
  workflowId: string;
  planRevision: number;
  baseTaskGraphDigest: WorkflowRecipeDigest;
  effectiveTaskGraphDigest: WorkflowRecipeDigest;
  recipeDigest: WorkflowRecipeDigest;
  recipeArtifactRef: WorkflowArtifactRef;
  boundarySidecarMap: WorkflowTaskBoundarySidecarMap;
  bindingDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeBranchInstance {
  branchInstanceId: WorkflowRecipeBranchInstanceId;
  fanOutId: WorkflowRecipeFanOutId;
  branchKeyDigest: WorkflowRecipeDigest;
  nodeId: WorkflowRecipeNodeId;
  taskId: WorkflowRecipeTaskId;
  ordinal: number;
  status: "planned" | "ready" | "admitted" | "running" | "evidence" | "joined" | "failed" | "quarantined";
  attemptId: string | null;
  branchDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeWaitReason =
  | "dependency_wait"
  | "ownership_wait"
  | "resource_wait"
  | "authority_wait"
  | "manifest_wait"
  | "capability_gap_wait"
  | "join_wait"
  | "loop_budget_wait";

export interface WorkflowRecipeSchedulerEntry {
  nodeId: WorkflowRecipeNodeId;
  taskId: WorkflowRecipeTaskId;
  dependencyTaskIds: readonly WorkflowRecipeTaskId[];
  ready: boolean;
  waitReasons: readonly WorkflowRecipeWaitReason[];
  demandHintDigest: WorkflowRecipeDigest;
  maxParallelBranches: number;
  effectiveTaskGraphDigest: WorkflowRecipeDigest;
  schedulerEntryDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeSchedulerMapping {
  workflowId: string;
  planRevision: number;
  recipeDigest: WorkflowRecipeDigest;
  effectiveTaskGraphDigest: WorkflowRecipeDigest;
  entries: readonly WorkflowRecipeSchedulerEntry[];
  readyTaskIds: readonly WorkflowRecipeTaskId[];
  safeParallelGroups: readonly WorkflowRecipeTaskId[][];
  mappingDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeNodeEvidence {
  evidenceId: string;
  workflowId: string;
  recipeDigest: WorkflowRecipeDigest;
  nodeId: WorkflowRecipeNodeId;
  taskId: WorkflowRecipeTaskId;
  branchInstanceId: WorkflowRecipeBranchInstanceId | null;
  attemptId: string;
  stageContractDigest: WorkflowRecipeDigest;
  roleContractDigest: WorkflowRecipeDigest;
  inputArtifactRefs: readonly WorkflowArtifactRef[];
  outputEvidenceRef: WorkflowEvidenceEnvelopeRef;
  gateResultRefs: readonly WorkflowArtifactRef[];
  epochRef: WorkflowEpochRef;
  resourceAdmissionDigest: WorkflowRecipeDigest;
  boundarySidecarDigest: WorkflowRecipeDigest;
  emittedAt: string;
  evidenceDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeGateResult {
  gateId: WorkflowRecipeGateId;
  gateKind: WorkflowRecipeGateKind;
  recipeDigest: WorkflowRecipeDigest;
  inputEvidenceRefs: readonly WorkflowEvidenceEnvelopeRef[];
  disposition: "accepted" | "rejected" | "inconclusive";
  outputEvidenceRefs: readonly WorkflowArtifactRef[];
  independentReviewRefs: readonly WorkflowArtifactRef[];
  hostAdjudicationReceiptRef: WorkflowArtifactRef | null;
  decisionRef: WorkflowDecisionRef;
  resultDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeRevisionState =
  | "proposed"
  | "trial"
  | "holdout_passed"
  | "canary"
  | "independent_review"
  | "promoted"
  | "rejected"
  | "rolled_back"
  | "revoked";

export interface WorkflowRecipeRevisionLifecycle {
  recipeId: WorkflowRecipeId;
  recipeRevision: number;
  state: WorkflowRecipeRevisionState;
  baselineRecipeDigest: WorkflowRecipeDigest;
  candidateRecipeDigest: WorkflowRecipeDigest;
  proposalDecisionRef: WorkflowDecisionRef;
  trialManifestRefs: readonly WorkflowArtifactRef[];
  hiddenHoldoutHandles: readonly WorkflowRecipeHostOnlyHiddenHoldoutHandle[];
  hiddenHoldoutResolverContexts: readonly WorkflowRecipeHiddenHoldoutResolverContext[];
  overfittingReviewRefs: readonly WorkflowArtifactRef[];
  latestOverfittingReviewRef: WorkflowArtifactRef | null;
  canaryManifestRefs: readonly WorkflowArtifactRef[];
  independentReviewRefs: readonly WorkflowArtifactRef[];
  promotionDecisionRef: WorkflowDecisionRef | null;
  rollbackDecisionRef: WorkflowDecisionRef | null;
  registryManifestDigest: WorkflowRecipeDigest;
  lifecycleDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeRedTeamAttack =
  | "metric_gaming"
  | "proxy_optimization"
  | "role_name_semantics"
  | "unauditable_dispatch"
  | "self_approval"
  | "evidence_omission"
  | "infinite_loop"
  | "activity_as_progress"
  | "hidden_scope_change"
  | "unsafe_concurrency"
  | "saturation"
  | "overfitting"
  | "recipe_self_modification";

export interface WorkflowRecipeRedTeamFinding {
  attack: WorkflowRecipeRedTeamAttack;
  caseIds: readonly WorkflowRecipeRedTeamCaseId[];
  disposition: "not_found" | "blocked" | "finding";
  evidenceRefs: readonly WorkflowArtifactRef[];
  explanationDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeRedTeamReport {
  recipeDigest: WorkflowRecipeDigest;
  revision: number;
  attacks: readonly WorkflowRecipeRedTeamFinding[];
  requiredAttackSetDigest: WorkflowRecipeDigest;
  independentReviewerRef: WorkflowArtifactRef;
  accepted: boolean;
  reportDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeValidationCode =
  | "recipe_activation_missing"
  | "recipe_activation_ambiguous"
  | "recipe_config_schema_unsupported"
  | "recipe_artifact_path_invalid"
  | "recipe_manifest_binding_mismatch"
  | "recipe_schema_invalid"
  | "recipe_digest_invalid"
  | "recipe_task_graph_mismatch"
  | "recipe_task_binding_missing"
  | "recipe_task_binding_duplicate"
  | "recipe_unknown_registry_manifest"
  | "recipe_registry_digest_mismatch"
  | "recipe_unknown_role_contract"
  | "recipe_unknown_stage_contract"
  | "recipe_unknown_schema"
  | "recipe_unknown_evaluator"
  | "recipe_unknown_gate"
  | "recipe_port_invalid"
  | "recipe_edge_invalid"
  | "recipe_schema_mismatch"
  | "recipe_fanout_invalid"
  | "recipe_join_invalid"
  | "recipe_loop_undeclared"
  | "recipe_loop_unbounded"
  | "recipe_loop_no_progress_evidence"
  | "recipe_gate_incomplete"
  | "recipe_universal_gate_missing"
  | "recipe_output_contract_invalid"
  | "recipe_evidence_contract_invalid"
  | "recipe_goal_digest_mismatch"
  | "recipe_scorecard_digest_mismatch"
  | "recipe_evaluator_digest_mismatch"
  | "recipe_config_digest_mismatch"
  | "recipe_completion_predicate_mismatch"
  | "recipe_resource_hint_exceeds_task"
  | "recipe_resource_hint_exceeds_envelope"
  | "recipe_parallelism_exceeds_ceiling"
  | "recipe_sidecar_missing"
  | "recipe_sidecar_digest_mismatch"
  | "recipe_path_invalid"
  | "recipe_ownership_overlap"
  | "recipe_unknown_artifact"
  | "recipe_hidden_test_not_host_owned"
  | "recipe_overfitting_reviewer_missing"
  | "recipe_overfitting_review_incomplete"
  | "recipe_overfitting_review_blocked"
  | "recipe_overfitting_hidden_holdout_exposed"
  | "recipe_hidden_holdout_unauthorized_resolution"
  | "recipe_hidden_holdout_bytes_exposed"
  | "recipe_required_capability_missing"
  | "recipe_required_capability_set_invalid"
  | "recipe_capability_snapshot_missing"
  | "recipe_capability_manifest_mismatch"
  | "recipe_skill_output_unauthorized"
  | "recipe_durable_knowledge_boundary_violation"
  | "recipe_revision_not_approved"
  | "recipe_revision_rollback_active";

export interface WorkflowRecipeValidationFailure {
  accepted: false;
  code: WorkflowRecipeValidationCode;
  recipeDigest: WorkflowRecipeDigest | null;
  taskGraphDigest: WorkflowRecipeDigest;
  offendingId: string | null;
  capabilityGap: WorkflowRecipeCapabilityGap | null;
  evidenceRefs: readonly WorkflowArtifactRef[];
  failureDigest: WorkflowRecipeDigest;
}

export interface WorkflowRecipeValidationSuccess {
  accepted: true;
  recipeDigest: WorkflowRecipeDigest;
  taskGraphBinding: WorkflowRecipeTaskGraphBinding;
  schedulerMapping: WorkflowRecipeSchedulerMapping;
  registryResolution: WorkflowRecipeRegistryResolution;
  overfittingReviewDigest: WorkflowRecipeDigest;
  skillSnapshotDigests: readonly WorkflowRecipeDigest[];
  validationDigest: WorkflowRecipeDigest;
}

export type WorkflowRecipeValidationResult = WorkflowRecipeValidationFailure | WorkflowRecipeValidationSuccess;

export interface WorkflowRecipeArtifactPayload {
  schemaId: typeof WORKFLOW_RECIPE_ARTIFACT_SCHEMA_ID;
  recipe: WorkflowMethodologyRecipe;
  boundarySidecarMap: WorkflowTaskBoundarySidecarMap;
  payloadDigest: WorkflowRecipeDigest;
}
```

The implementation uses the existing `digestObject` canonicalization rules
for the shared task values and a recipe canonicalizer that sorts all ID-keyed
arrays before hashing. Digest fields are excluded from their own preimage and
then populated with the resulting digest. The canonicalizer rejects unknown
keys, non-finite numbers, duplicate IDs, invalid UTF-8, and values outside the
declared cardinality limits.

## 6. Host registry and semantic resolution

The registry is a host artifact, not a recipe field that can redefine meaning.
For every reference in a recipe, K-T10A resolves the exact registry manifest
and verifies the referenced revision and digest. Resolution requires:

1. the stage contract to define the stage kind and predecessor requirements;
2. the role contract to bind to that stage and to closed input/output schema
   digests;
3. the evaluator contract to be host-owned, scorecard-bound, repeatable, and
   held-out capable;
4. every gate contract to name its host evaluator and independent-context
   requirement;
5. the pre-evaluation overfitting reviewer contract to contain all eight
   checks, host-owned hidden/adversarial manifests, and the literal empty
   authority tuple; and
6. the resource class to be present in the approved host resource policy.

`displayLabel` is never consulted for validation or scheduling. The resolver
uses contract identifiers and digests only. A registry entry that is unknown,
revoked, stale, or semantically different from its manifest fails closed with
no ready task. Hidden holdouts and edge-test manifests have `owner: "host"`
and `hidden: true`; the recipe carries only an opaque
`WorkflowRecipeHostOnlyHiddenHoldoutHandle` and an authenticated
`WorkflowRecipeHiddenHoldoutResolverContext`. A proposer or worker cannot
alter, inspect, select, omit, replace, resolve, or receive bytes from that
handle. The host-only resolver context returns evidence only and rejects any
unauthorized caller or raw-byte request.

The registry also resolves the closed required native capability set:
`autoresearch`, `mempalace`, and `general_memory`. Their bundled/native
implementations must have durable content/dependency snapshot digests and
manifest digests; the host verifies those refs on activation and recovery.
The resolver derives `required: true` and `builtIn: true` for exactly those
three IDs and rejects a caller-supplied required flag, duplicate, extra, or
optional native manifest. `superpowers` is the only optional host-discovered
skill with `vendored: false`; its absence produces a typed optional capability
gap and cannot remove a required gate or evaluator. A missing or mismatched
required capability returns a startup/readiness failure and never selects a
fallback.

The host may map a role contract to existing capability classes and an
existing `WorkflowChildAuthority` during admission. The recipe's literal
`authorityCapabilities: readonly []` and `canAuthorize: false` values make
the absence of node authority machine-checkable. The host still checks the
existing task authority, approval, epoch, lease, and resource contracts.

## 7. Validation rules

K-T10A validates the complete recipe before computing a ready set. It returns
one of the closed `WorkflowRecipeValidationCode` values and never partially
dispatches a graph.

For a recipe-aware configuration, K-T10's base ready set is an internal input
only and is not dispatchable. K-T10A is the sole producer of the effective
ready set. Missing or invalid activation, sidecar, registry, or recipe data
returns no ready tasks; callers cannot fall back to K-T10 output.

### Identity and binding

- A recipe-aware workflow has
  `configSchemaVersion === WORKFLOW_RECIPE_CONFIG_SCHEMA_VERSION`, exactly one
  decision artifact whose parsed `schemaId` equals
  `WORKFLOW_RECIPE_ARTIFACT_SCHEMA_ID`, and a `relativePath` equal to
  `WORKFLOW_RECIPE_ARTIFACT_PATH_PREFIX + artifactRef.digest`. Its manifest
  digest must occur exactly once in `methodologyManifestDigests`. A partial,
  duplicate, unsupported, or cross-mismatched activation fails before any
  ready task is returned.
- `workflowId`, `planRevision`, `taskGraphDigest`, `planDigest`, goal digest,
  scorecard digest, resource-envelope digest, completion-predicate digest,
  configuration digest, and methodology manifest digests must equal the
  current host-resolved records.
- `taskNodeBindings` and `nodes` contain exactly one node per existing task,
  with equal ID sets. A recipe-only node, missing task, duplicate task, or
  duplicate node is invalid.
- A node's `frozenTaskDigest` is the digest of the exact frozen
  `WorkflowTask`; a changed objective, dependency, owned path, authority,
  declared vector, status, or attempt list invalidates the recipe.
- `effectiveTaskGraphDigest` includes the sidecar path sets and is the digest
  bound by the recipe. A recipe cannot bind only the base task digest.

### Registry, ports, and edges

- Every stage, role, schema, evaluator, gate, and hidden-test reference must
  resolve in one host registry manifest. Identifiers are not enough; all
  referenced digests must match.
- The host capability resolver derives the exact required native set from
  `WORKFLOW_RECIPE_REQUIRED_NATIVE_CAPABILITIES` and permits at most the one
  optional `superpowers` manifest. Native manifests must be host-built-in with
  literal `required: true`/`builtIn: true`; the optional manifest must be
  host-discovered with literal `required: false`/`builtIn: false`. A caller
  cannot supply, override, omit, duplicate, or add a required-capability
  boolean. Any set mismatch returns `recipe_required_capability_set_invalid`
  before readiness.
- Port IDs are unique within a node. Output-to-input edges must match value
  kind, schema revision, schema digest, and cardinality. Required inputs have
  one incoming edge unless a declared join supplies them.
- Edge endpoints must exist, an edge cannot be a self-edge, and an edge with a
  rejected/accepted guard must name an existing gate. A cycle is invalid unless
  every edge in the cycle belongs to a declared loop policy.
- A terminal node must produce the evidence required by `outputContract`; no
  terminal node may bypass the host-adjudication gate.

### Fan-out and joins

- `maxBranches` and every policy bound are positive safe integers. The host
  computes actual branch count from the canonical branch-key input and clamps
  it to `maxBranches` and the approved resource/control ceilings.
- Every fan-out names exactly one explicit join. Every join names its branch
  inputs, output, policy, wait bound, and evidence contract. An implicit
  “collect everything” behavior is invalid.
- `all` requires `expectedBranches` equal to the declared branch count for the
  accepted input. `quorum`, `any`, and `first_success` still have finite
  maximums, and every dropped or failed branch emits bounded evidence.
- Branch instances have deterministic IDs derived from recipe digest, fan-out
  ID, and canonical branch-key digest. They do not add task IDs to the plan.
- Branch instances are bounded sub-attempts of the one bound task, not
  independent task completions. Only the declared join can aggregate their
  evidence into the bound task's terminal outcome. A branch cannot mark the
  task accepted, and a failed or omitted branch remains visible to the join's
  failure policy and completion checks.

### Loops and back-edges

- A back-edge must appear in `edges`, name one loop policy, and be guarded by a
  rejected host gate. A forward edge cannot silently become a retry.
- `maxTraversals` is a positive safe integer and is included in the recipe
  digest. Every loop names progress evidence, a termination gate, and an
  exhaustion disposition. The global traversal bound is the sum of declared
  loop bounds and is checked before admission.
- An edge-test failure may traverse only its named back-edge. A loop that
  exhausts becomes `blocked`, `failed`, or `awaiting_user` exactly as declared;
  it never wraps to its first node or waits for activity indefinitely.

### Universal gates and evidence

- A recipe that can change consequential state must bind all six universal
  stage kinds and a host-adjudication gate to the same decision and scorecard
  digests. A routine read-only projection may emit evidence without applying a
  state change, but it still cannot be used as completion evidence without the
  host gate.
- The six universal stages are a host-gate overlay represented by
  `binding.universalStageContractIds`; they need not be six additional task
  nodes in the topology. This permits the four-node panel fixture and the
  five-node attack fixture to retain their exact task DAGs while every
  consequential transition still traverses recon, lenses, verification,
  synthesis, red-team, and host adjudication.
- Judge, unify, and edge-test nodes emit evidence and gate results. The host
  verifies those results with the referenced evaluator, independent review,
  protected invariants, and hidden holdouts.
- Evidence contracts are bounded, require their declared schemas and artifact
  references, and carry the recipe, task, attempt, epoch, and sidecar digests.
  Missing evidence, a proxy-only observation, a stale evaluator, or a worker's
  self-reported completion is rejected.
- The output contract binds the existing completion predicate. A recipe cannot
  redefine “done” as a node status, branch count, throughput, utilization,
  judge label, or successful command alone.

### Pre-evaluation overfitting reviewer

- Every recipe has exactly one host-resolved `pre_evaluation_overfitting`
  reviewer binding. Its contract contains exactly these checks: metric
  pre-registration/locking, sample adequacy, train/eval separation, test
  contamination, repeated holdout exposure/peeking, proxy exploitation,
  variance/replicate stability, and generalization on host-owned
  hidden/adversarial holdouts.
- During proposal and exploratory trial, the review is advisory evidence only;
  it cannot authorize a task, gate, allocation, revision, or completion. A
  failing or inconclusive advisory result remains visible and cannot be
  relabeled as a pass.
- Before `holdout_passed`, `canary`, `independent_review`, `promoted`,
  `milestone_acceptance`, or `completion`, the review is a blocking host
  predicate. Every check must pass with current evidence and the host must
  bind the review digest into the lifecycle/acceptance decision. Missing,
  stale, incomplete, or failed review returns a typed validation failure.
- The reviewer receives host-selected holdout/adversarial manifests and
  evidence handles, never hidden holdout bytes. Each handle is opaque and
  host-only, and each resolver context is authenticated for exactly the
  host overfitting reviewer and declares `returnsBytes: false`. The proposer
  or worker cannot resolve it, receive raw bytes, or supply a replacement
  artifact ref. Unauthorized resolution returns
  `recipe_hidden_holdout_unauthorized_resolution`; any raw-byte exposure
  returns `recipe_hidden_holdout_bytes_exposed`. The proposer receives neither
  the bytes nor a selector, and cannot alter the evaluator, sample, split,
  replicate count, or review result. `authorityCapabilities: []`,
  `emitsEvidenceOnly: true`, and `canAuthorize: false` are checked literally.

### Native capabilities and skill evidence

- Recipe activation requires the native built-in AutoResearch experiment
  engine and its bundled skill facade, the native built-in MemPalace
  durable-knowledge boundary and its bundled recall/write facades, and the
  existing native general-memory/refinement surface. Their content,
  dependency, snapshot, and manifest digests are durable artifact inputs and
  must be re-resolved during recovery.
- Superpowers is an optional host-discovered recipe library. A missing or
  stale Superpowers snapshot yields a typed capability-gap `wait`/`blocked`
  result and omits only optional enhancements; it never weakens the six-stage
  gates, overfitting review, hidden holdouts, evaluator, or completion
  predicate. Missing or stale AutoResearch/MemPalace/native-memory inputs are
  required capability failures before readiness and cannot fall back.
- Skill output is a bounded `WorkflowRecipeSkillOutput` evidence/proposal.
  It cannot mutate a recipe, plan, registry, memory store, queue, gate,
  allocation, or decision. A MemPalace proposal must require and return the
  typed `WorkflowRecipePriorCanonicalKnowledgeCommit` and
  `WorkflowRecipeHostKnowledgeReceipt`; it can contain only reusable `how`
  or `why` knowledge with source evidence. `decision`, `outcome`, and
  `run_state` records are rejected even if a lower-level refinement surface
  permits them for other workflows.
- The MemPalace boundary compares the returned prior commit/receipt identities
  and digests with the required input, and requires the output's
  `rejectedKinds` tuple to be exactly `["decision", "outcome", "run_state"]`.
  Missing, foreign, stale, or mismatched commit/receipt material returns
  `recipe_durable_knowledge_boundary_violation` before any write or recall.

### Scorecard, decision, and invariants

- Gate bindings must reference the current scorecard and decision. The host
  recomputes classification and materiality from the exact operation; a recipe
  cannot claim that a strategy, role, or gate is routine to avoid approval.
- Every protected invariant and acceptance check named by the current
  scorecard must be bound or the recipe is rejected. The recipe may add an
  evidence-producing check only if it does not replace an existing one.
- Judge/unify/edge-test outputs are proposals and evidence. Applying a result
  uses the existing one-use approval and host-adjudication path.

### Resources and ownership

- Demand hints cannot exceed the corresponding frozen task declaration or the
  approved resource envelope. The host clamps hints to the envelope and
  preserves the control-plane, verifier, red-team, recovery, and approval
  reserves.
- Fan-out demand is the branch demand multiplied by the admitted branch count;
  it is checked before any branch is admitted. Unknown capacity serializes to
  zero and cannot make a recipe ready.
- K-T10A applies the sidecar path-overlap rule before the scheduler mapping.
  A task with a missing sidecar entry, unknown output/lock path, or cross-task
  overlap fails closed.

## 8. Lifecycle and data flow

### Activation

1. The host resolves the goal, scorecard, evaluator, invariant, acceptance
   check, plan, resource envelope, configuration closure, and methodology
   manifests, plus the required native AutoResearch engine, native MemPalace
   boundary, general-memory surface, and their skill snapshots. It records
   their existing digests in the plan decision. Missing required capability
   manifests fail startup/readiness with a typed capability gap.
2. A planner proposes an immutable recipe artifact and boundary sidecar map.
   The proposal is evidence only until the existing universal decision gate
   and approval policy accept it.
3. K-T10 validates the frozen task DAG. K-T10A resolves the registry,
   joins the sidecar, computes the effective graph digest, validates the
   recipe, and emits the worker-free `WorkflowRecipeSchedulerMapping`.
4. The plan decision references the recipe artifact and sidecar artifact in
   existing `artifactRefs`. The configuration snapshot binds the registry and
   methodology manifest digests. The recipe-aware configuration-schema
   revision and canonical artifact path declare that this binding is required.
   A does not dispatch until all refs resolve, and it never consumes K-T10's
   base ready set for a recipe-aware configuration.
5. The host resolves exactly one pre-evaluation overfitting reviewer binding.
   Its exploratory result may be advisory, but the first transition toward a
   hidden holdout or consequential acceptance requires a current blocking
   review digest. The proposer never receives hidden holdout bytes.

### Execution, joins, and gates

1. The scheduler selects only ready existing task IDs from the mapping. A
   admits an attempt with the existing epoch, ownership/resource leases, child
   identity, and host-resolved role contract.
2. A node invocation receives typed port values and host capability context.
   It can emit only bounded evidence and artifacts. It cannot mutate the task,
   approve a gate, expand a resource, or change the recipe. AutoResearch
   experiment results and optional Superpowers skill output use this same
   evidence-only path.
3. Fan-out creates deterministic branch instances under the target task. The
   explicit join waits according to its policy and emits join evidence. Branch
   failures are retained as evidence and follow the declared failure policy.
4. Judge and unify gates consume evidence through host-owned evaluator
   contracts. Edge-test gates produce accepted or rejected evidence. Only a
   rejected edge-test result can activate its explicitly declared back-edge.
5. Before evaluation is treated as a holdout, canary, independent review,
   promotion, milestone acceptance, or completion claim, the host runs the
   overfitting reviewer checks against locked metrics, adequate samples,
   separated/clean data, replicate evidence, and host-owned hidden/adversarial
   holdouts. A failed or inconclusive check blocks the transition.
6. The universal decision sequence runs for every consequential transition.
   The host adjudication receipt is the only evidence that can authorize the
   existing task/goal/decision projection.

### Completion

The host checks the existing completion predicate against all required output
and evidence contracts, scorecard metrics, protected invariants, independent
verification, overfitting review, and red-team results. Recipe topology alone
never establishes completion. A failure or inconclusive gate leaves the task
or workflow in the
existing `needs_fix`, `blocked`, `awaiting_user`, or `failed` state according
to the host decision; it does not trigger an undeclared retry.

## 9. Persistence, recovery, and idempotency

- Recipe and sidecar bytes are written through the existing immutable artifact
  publisher with canonical JSON, `payloadKind: "barrier"`, and source event
  sequence. Their refs are included in existing plan/decision artifact refs;
  no recipe-specific journal event exists.
- The artifact preimage contains `schemaId`, all fixed fields, and the sidecar
  map. The digest binds task graph, registry, scorecard, evaluator, config,
  methodology manifests, native capability snapshots/manifests, durable
  knowledge-boundary digest, overfitting reviewer contract/review, resource
  envelope, gates, holdouts, and output predicate. A changed byte produces a
  different recipe digest.
- Publish, sidecar binding, validation, scheduler mapping, branch admission,
  gate evaluation, and lifecycle projection use idempotency keys derived from
  the workflow ID, plan revision, recipe digest, task/node ID, branch ID,
  attempt ID, and operation kind. Repeating a committed operation returns the
  existing artifact/result; a same-key different-preimage operation is an
  idempotency conflict.
- On restart, K re-resolves the artifact refs, registry manifest, every skill
  snapshot/manifest digest, and the native durable-knowledge boundary,
  verifies the base/effective graph digests and latest blocking overfitting
  review, and recomputes the worker-free mapping.
  Missing, stale, foreign, malformed, or digest-mismatched recipe material is
  quarantined and no recipe-bound task is admitted.
- A runtime crash uses the existing attempt, process, lease, epoch, and effect
  recovery contracts. An ambiguous branch or gate effect is quarantined; it
  is never treated as not executed or as successful progress. A branch may be
  reconciled only under the same recipe digest and loop budget.
- A recovered mapping is deterministic. It does not replay a fan-out, join,
  gate, or back-edge whose idempotency record already exists. A stale mapping
  is rejected and replaced only after a fresh host decision if the binding
  changed.

## 10. Approvals, security, and authority

The recipe has no authority list beyond the literal empty node authority
tuples. Existing task authority, host-issued capability attestations,
ownership leases, resource admissions, approvals, and epochs remain the only
execution controls. In particular:

- a role label cannot grant edit, shell, child-spawn, lease, approval,
  allocation, canonical-knowledge, or completion authority;
- a judge cannot approve its own evidence, and a unifier cannot accept a judge
  without the host evaluator and independent verification;
- a recipe author cannot choose or omit hidden holdouts, evaluator predicates,
  protected invariants, acceptance checks, resource reserves, or approval
  requirements;
- the pre-evaluation overfitting reviewer cannot write, allocate, approve,
  promote, complete, or reveal hidden holdout bytes; its evidence is advisory
  during exploration and host-blocking at the declared lifecycle boundaries;
- AutoResearch engine/facade output, Superpowers output, and general-memory
  output are evidence/proposals only. The native MemPalace boundary requires
  and returns a typed prior canonical commit plus authenticated host receipt,
  accepts only canonical reusable how/why knowledge with source evidence, and
  rejects `decision`, `outcome`, and `run_state` even if another refinement
  surface permits those records;
- recipe artifact paths are canonical relative paths under the workflow root;
  artifact bytes are immutable, size-bounded, digest-verified, and redacted by
  the existing artifact/evidence controls;
- registry manifests, configuration closures, scorecards, decisions, and
  hidden-test manifests are host-owned and pinned. A foreign or revoked
  signature/ref/digest fails closed; and
- recipe execution cannot write outside the existing task ownership and
  generated-output/lock sidecar boundaries.

Any recipe change that affects a consequential operation enters the existing
recon/lenses/verification/synthesis/red-team/host-adjudication path and, when
classified as material, the existing one-use user approval path. Plain worker
messages, a role verdict, a branch result, or `/workflow resume` cannot approve
or promote a recipe.

## 11. Resource adaptation and scheduler mapping

Recipe demand hints are inputs to the existing K/A adaptive allocation loop,
not a new controller. The host observes verified critical path, evidence gaps,
queue age, resource usage, live leases, uncertainty, and reserves. It may
resize only unclaimed work inside the approved envelope and only after the
existing universal decision gate. Hints never increase the envelope, control
capacity, approval scope, or completion predicate.

The scheduler mapping is deterministic:

1. sort nodes by canonical node ID;
2. use the effective K-T10 graph for dependency, ownership, authority, and
   resource wait reasons;
3. expand only the admitted branch count under a fan-out, without adding plan
   task IDs;
4. group ready tasks only when their effective owned/generated/lock paths,
   contracts, resource demand, and control capacity are disjoint and the
   verifier/red-team/recovery/control reserves remain available; and
5. return sorted `readyTaskIds`, explicit wait reasons, and a mapping digest.

### Parallel fan-out example

The panel/research fixture below has three canonical research keys. The host
creates three branch instances under `task:research`, waits for the explicit
all-join, and admits only branches that fit the envelope. A branch result is
evidence; it does not authorize the attack or rule task.

### Widest-safe allocation example

Assume the approved envelope has six worker process slots, one verification
slot, one red-team slot, and two reserved control/recovery slots. Four ready
research branches each demand one worker slot and one model-call slot; the
downstream verifier demands one verification slot. The host admits three
research branches if admitting a fourth would consume the verifier or reserve,
then admits the verifier when its dependency is satisfied. It does not claim
that four-way saturation is safe, and it does not convert queue activity into
progress. If two ready tasks have overlapping generated outputs or lock paths,
they remain serialized even when capacity is idle.

## 12. First-class recipe fixtures

The fixture tests use the same host registry, schema, evaluator, scorecard,
sidecar, and universal-gate validation as production recipes. They are not
special parser cases. The exact topology assertions are:

```ts
export interface WorkflowRecipeFixtureEdgeAssertion {
  edgeId: WorkflowRecipeEdgeId;
  fromNodeId: WorkflowRecipeNodeId;
  toNodeId: WorkflowRecipeNodeId;
  guard: "always" | "gate_accepted" | "gate_rejected";
  backEdgeLoopId: WorkflowRecipeLoopId | null;
}

export interface WorkflowRecipeFixtureAssertion {
  fixtureId: string;
  nodeTaskIds: readonly { nodeId: WorkflowRecipeNodeId; taskId: WorkflowRecipeTaskId }[];
  edges: readonly WorkflowRecipeFixtureEdgeAssertion[];
  fanOut: readonly {
    fanOutId: WorkflowRecipeFanOutId;
    sourceNodeId: WorkflowRecipeNodeId;
    branchNodeIds: readonly WorkflowRecipeNodeId[];
    maxBranches: number;
    explicitJoinId: WorkflowRecipeJoinId;
  }[];
  joins: readonly {
    joinId: WorkflowRecipeJoinId;
    policy: "all" | "quorum" | "any" | "first_success";
    expectedBranches: number | null;
  }[];
  loops: readonly {
    loopId: WorkflowRecipeLoopId;
    backEdgeId: WorkflowRecipeEdgeId;
    failureGateId: WorkflowRecipeGateId;
    maxTraversals: number;
  }[];
  requiredStageKinds: readonly WorkflowRecipeStageKind[];
  requiredGateKinds: readonly WorkflowRecipeGateKind[];
}

export const PANEL_RESEARCH_ATTACK_RULE_FIXTURE: WorkflowRecipeFixtureAssertion = {
  fixtureId: "recipe-fixture:panel-research-attack-rule",
  nodeTaskIds: [
    { nodeId: "recipe-node:panel", taskId: "task:panel" },
    { nodeId: "recipe-node:research", taskId: "task:research" },
    { nodeId: "recipe-node:attack", taskId: "task:attack" },
    { nodeId: "recipe-node:rule", taskId: "task:rule" },
  ],
  edges: [
    { edgeId: "edge:panel-research", fromNodeId: "recipe-node:panel", toNodeId: "recipe-node:research", guard: "always", backEdgeLoopId: null },
    { edgeId: "edge:research-attack", fromNodeId: "recipe-node:research", toNodeId: "recipe-node:attack", guard: "always", backEdgeLoopId: null },
    { edgeId: "edge:attack-rule", fromNodeId: "recipe-node:attack", toNodeId: "recipe-node:rule", guard: "always", backEdgeLoopId: null },
  ],
  fanOut: [
    { fanOutId: "fanout:panel-research", sourceNodeId: "recipe-node:panel", branchNodeIds: ["recipe-node:research"], maxBranches: 3, explicitJoinId: "join:panel-research" },
  ],
  joins: [
    { joinId: "join:panel-research", policy: "all", expectedBranches: 3 },
  ],
  loops: [],
  requiredStageKinds: ["recon", "lens", "verification", "synthesis", "red_team", "host_adjudication"],
  requiredGateKinds: ["scorecard", "invariant", "check", "host_adjudication"],
};

export const ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST_FIXTURE: WorkflowRecipeFixtureAssertion = {
  fixtureId: "recipe-fixture:attack-architect-judge-unify-edge-test",
  nodeTaskIds: [
    { nodeId: "recipe-node:attack", taskId: "task:attack" },
    { nodeId: "recipe-node:architect", taskId: "task:architect" },
    { nodeId: "recipe-node:judge", taskId: "task:judge" },
    { nodeId: "recipe-node:unify", taskId: "task:unify" },
    { nodeId: "recipe-node:edge-test", taskId: "task:edge-test" },
  ],
  edges: [
    { edgeId: "edge:attack-architect", fromNodeId: "recipe-node:attack", toNodeId: "recipe-node:architect", guard: "always", backEdgeLoopId: null },
    { edgeId: "edge:architect-judge", fromNodeId: "recipe-node:architect", toNodeId: "recipe-node:judge", guard: "always", backEdgeLoopId: null },
    { edgeId: "edge:judge-unify", fromNodeId: "recipe-node:judge", toNodeId: "recipe-node:unify", guard: "gate_accepted", backEdgeLoopId: null },
    { edgeId: "edge:unify-edge-test", fromNodeId: "recipe-node:unify", toNodeId: "recipe-node:edge-test", guard: "always", backEdgeLoopId: null },
    { edgeId: "edge:edge-test-architect-retry", fromNodeId: "recipe-node:edge-test", toNodeId: "recipe-node:architect", guard: "gate_rejected", backEdgeLoopId: "loop:edge-test-retry" },
  ],
  fanOut: [],
  joins: [],
  loops: [
    { loopId: "loop:edge-test-retry", backEdgeId: "edge:edge-test-architect-retry", failureGateId: "gate:edge-test", maxTraversals: 2 },
  ],
  requiredStageKinds: ["recon", "lens", "verification", "synthesis", "red_team", "host_adjudication"],
  requiredGateKinds: ["judge", "unify", "edge_test", "scorecard", "invariant", "check", "host_adjudication"],
};
```

The first fixture must prove that three research branches are represented in
the fan-out and that the `all` join is explicit before attack can become ready.
The second must prove that an edge-test rejection activates only
`edge:edge-test-architect-retry`, decrements the two-traversal budget, records
progress evidence, and reaches the declared exhaustion disposition. A third
rejection is a terminal bounded failure or user gate; it cannot create another
architect attempt automatically.

## 13. Recipe refinement and revision lifecycle

Refinement is strictly proposal-based:

```text
proposal -> trial -> hidden holdout -> canary
          -> independent review -> host promotion
          -> rollback when a promoted revision regresses
```

The existing generic improvement-review queue supplies latest-wins, one
pending review, one active review, bounded review capacity, and durable
rollback fencing. The recipe lifecycle adds the typed artifact refs and
state-digest in `WorkflowRecipeRevisionLifecycle`; it does not add a journal
event kind.

Every candidate revision must retain identical digests for:

- original goal and non-goals;
- scorecard metrics, evaluator, parser, guard, protected invariants,
  acceptance checks, repeatability, hidden holdouts, and completion predicate;
- approval policy, required approvals, authority policy, and host-adjudication
  contract;
- resource ceilings, control-plane/verifier/red-team/recovery reserves,
  cloud/egress/spend policy, and scheduler/kernel contract; and
- workflow scope, owned task IDs, task boundary sidecar, and plan decision.

Only topology, evidence routing, bounded fan-out/join choices, bounded demand
hints within existing ceilings, and non-authorizing node metadata may differ.
If any protected digest changes, the candidate is a scope-changing plan or
policy revision and is rejected by recipe refinement; the relevant existing
goal/scorecard/resource/approval workflow must handle it separately.

The proposer cannot select or omit hidden holdouts. Trial and canary results
must include baseline, same-case, replay, and evidence returned by the
host-only hidden-holdout resolver, plus the latest overfitting review as
applicable. The review is advisory during exploration, then blocking before
`holdout_passed`, `canary`,
`independent_review`, `promoted`, milestone acceptance, and completion.
Independent review must cover the full red-team attack set below. Promotion is
a host compare-and-swap against the current registry entry and records the
previous digest. A rollback is another host decision; future runs load only
the approved compatible revision. Rejected, superseded, revoked, or
rolled-back recipes are never silently reloaded.

## 14. Required red-team review

Every recipe proposal, revision, trial result, canary result, and promotion or
rollback decision runs the following attacks. A missing attack result is a
validation failure, not a pass.

| Attack | Required falsification check |
| --- | --- |
| Metric gaming | Try to improve the reported metric while violating the original goal, protected invariant, or hidden holdout. |
| Proxy optimization | Replace genuine evidence with throughput, latency, utilization, branch count, queue drainage, or a role verdict. |
| Role-name-as-semantics | Change display labels while retaining/dropping semantic contract digests; labels must not alter dispatch or authority. |
| Unauditable dispatch | Remove a task/branch/lease/registry/evaluator digest or make the scheduler depend on an unrecorded hint. |
| Self-approval | Let a node, judge, unifier, proposer, reviewer, or child consume its own result as approval. |
| Evidence omission | Drop a failed branch, limitation, gate result, hidden-test result, or required output while claiming a join or completion. |
| Infinite loops | Remove a max traversal, failure guard, progress evidence, or exhaustion disposition; every cycle must fail validation. |
| Activity-as-progress | Emit repeated no-op turns, unchanged observations, or busy work without new requirement evidence. |
| Hidden scope change | Alter goal, scorecard, evaluator, approval, resource ceiling, kernel, completion predicate, owned task set, or sidecar. |
| Unsafe concurrency | Overlap owned/generated/lock paths, consume verifier/control reserve, or admit a branch after an epoch/lease change. |
| Saturation | Fill all worker capacity so verification, red-team, recovery, approval, or control work cannot run. |
| Overfitting | Try to claim a small-data win, leak train/eval or test data, peek repeatedly at a holdout, exploit unstable variance, or degrade on a host-owned held-out/adversarial set while preserving the visible metric. |
| Recipe self-modification | Let execution bytes, role output, branch result, or a recipe node rewrite the active artifact or registry. |

The report is accepted only when all 13 attack IDs have an independent
evidence-backed result and the host adjudication binds that report digest. The
`overfitting` finding must carry all five typed case IDs:
`small_data_win`, `data_leakage`, `repeated_peeking`, `unstable_variance`, and
`held_out_degradation`.

## 15. Error handling and fail-closed behavior

The validator returns a `WorkflowRecipeValidationFailure` for all malformed,
unknown, stale, mismatched, unauthorized, over-budget, or ambiguous inputs.
The host maps the failure to the existing workflow state without inventing a
new status:

- a missing/unknown/mismatched manifest, sidecar, evaluator, gate, schema, or
  artifact is `blocked` with the exact validation code;
- a malformed or tampered artifact is quarantined by the existing artifact and
  recovery boundary;
- an exhausted loop is the declared `blocked`, `failed`, or `awaiting_user`
  disposition;
- an uncertain process, branch, lease, or effect is quarantined and requires
  existing runtime reconciliation;
- a stale allocation or mapping is discarded and recomputed from the last
  committed safe state; and
- a failed red-team, hidden holdout resolver, independent review, evaluator, or host
  adjudication never becomes a successful recipe revision.
- a hidden-holdout handle or resolver context that is proposer/worker-owned,
  unauthenticated, mismatched, directly resolvable, or accompanied by bytes
  returns the typed unauthorized-resolution or byte-exposure failure; an
  ordinary `WorkflowArtifactRef` is never exposed for hidden holdout bytes.
- a missing/invalid required native AutoResearch engine, native MemPalace
  boundary, general-memory surface, or durable skill snapshot returns the
  explicit capability-gap code and startup/readiness `failed` or `blocked`
  disposition; no alternate evaluator, memory store, or skill is selected;
- a missing optional Superpowers snapshot returns an explicit `wait`/`blocked`
  capability gap and omits only optional recipe enhancements. It never weakens
  gates, evidence, the overfitting reviewer, or completion requirements.
- an overfitting review that is missing, stale, incomplete, failed, exposes
  hidden bytes, or lacks any required case is advisory only during exploration
  and a blocking typed failure at every declared pre-holdout, promotion,
  milestone-acceptance, or completion boundary.

There is no fallback from an unknown role to a guessed role, from an unknown
schema to an untyped port, from a missing holdout to a visible case, or from a
missing sidecar to a task mutation.

## 16. Compatibility and protocol classification

| Surface | Classification | Required behavior |
| --- | --- | --- |
| `WorkflowTask` fields | Backward-compatible additive sidecar | Frozen shape remains unchanged. K-T10A joins an optional sidecar map through a local effective view. |
| Existing task graph | Backward-compatible | A graph without a declared recipe retains the current worker-free validation and ready-set behavior. |
| Recipe activation and artifact schema `workflow-methodology-recipe-v1` | Additive local configuration and artifact schema revision | Ordinary workflows retain the current schema. A recipe-aware configuration uses the reserved manifest digest and canonical decision-artifact path. Unsupported configuration-schema versions fail before readiness; readers must never ignore a required recipe and dispatch the plain DAG. |
| Journal events | Unchanged | Recipe publication, validation, and lifecycle use existing artifact refs and existing generic improvement event kinds. No recipe-specific event is added. |
| Daemon protocol and schema | Unchanged | `DAEMON_PROTOCOL_VERSION` and `DAEMON_SCHEMA_REVISION` remain unchanged. No startup requirement or wire field is added. |
| Runtime scheduler | Capability-independent local projection | A consumes K's scheduler mapping through existing task/attempt/lease contracts; no wire negotiation is needed. |
| Host registry | Fail-closed manifest resolution | Unknown or mismatched manifests prevent recipe-bound dispatch; no role fallback is allowed. |
| Native capabilities and skill snapshots | Additive local artifact/host-capability contract | AutoResearch, MemPalace, and general memory are the closed required built-in native capabilities; optional Superpowers is host-discovered and not vendored. Required/optional literals are resolver-derived, not caller booleans. Snapshot/manifest refs are durable and recovery-validated. No journal event, daemon field, or silent fallback is added. |

If a dedicated artifact payload kind is later selected instead of the existing
barrier kind, it is classified solely as an additive artifact schema revision,
capability-independent/local projection. It is never a daemon capability,
startup dependency, journal event, or approval bypass.

## 17. Persistence and ownership placement

| Owner/task | Production placement | Test/acceptance placement |
| --- | --- | --- |
| K-T10A | `packages/coding-agent/src/core/workflow/recipe-contracts.ts`; additive adapter in `packages/coding-agent/src/core/workflow/task-graph.ts` | `packages/coding-agent/test/workflow-recipe-contracts.test.ts`, `packages/coding-agent/test/workflow-task-graph-sidecar.test.ts`, `packages/coding-agent/test/workflow-recipe-fixtures.test.ts` |
| K host registry resolver | `packages/coding-agent/src/core/workflow/recipe-registry.ts` | registry manifest and unknown/mismatch tests in `workflow-recipe-contracts.test.ts` |
| K capability/skill boundary | `packages/coding-agent/src/core/workflow/recipe-capabilities.ts`; native engine/facade adapters in `packages/coding-agent/src/core/autoresearch/engine.ts`, `packages/coding-agent/src/core/knowledge/mempalace-boundary.ts`, and existing native memory/refinement modules | `packages/coding-agent/test/workflow-recipe-capabilities.test.ts`, `packages/coding-agent/test/autoresearch-native-integration.test.ts`, `packages/coding-agent/test/knowledge-mempalace-boundary.test.ts` |
| A runtime consumer | Existing `packages/coding-agent/src/core/workflow/dispatch.ts`, `scheduler.ts`, `runtime-recovery.ts`; consume-only changes after K-T10A handoff | Existing runtime dispatch, scheduler, and recovery suites plus recipe mapping assertions |
| N/R/C producers | Existing native-methodology, autoresearch, and knowledge refinement producer modules; emit proposals only | Existing producer/refinement tests consume the K recipe proposal surface |
| IS integration | Existing high-fan-in session/CLI/SDK paths only if activation needs a projection | Existing aggregate workflow matrix and compatibility tests |

K-T10A is inserted between K-T10 and K-T11. It owns the sidecar join,
registry resolution, recipe validation, fixture contract, and worker-free
scheduler mapping. A cannot add a second recipe scheduler, N/R/C cannot add
role semantics to a recipe, and IS cannot move recipe authority into a UI or
daemon bridge.

## 18. Acceptance and test matrix

All commands below run from the package root
`/Users/nathanballou/Documents/GitHub/prime-agent/packages/coding-agent`.
They are implementation acceptance commands for the future K-T10A slice;
this document-only task does not claim their results.

| ID | Test | Acceptance |
| --- | --- | --- |
| AR-01 | `workflow-recipe-contracts.test.ts` | Exact serializable interfaces, canonical digesting, fixed-key rejection, registry resolution, and literal no-authority fields. |
| AR-02 | `workflow-task-graph-sidecar.test.ts` | Frozen `WorkflowTask` remains unchanged; absent legacy sidecar yields empty sets; recipe-bound map requires one entry per task; effective digest includes generated/lock paths. |
| AR-03 | `workflow-task-graph-sidecar.test.ts` | Canonical relative paths, ancestor/descendant overlap, contract overlap, workspace escape, duplicate paths, and dependency serialization match K-T10. |
| AR-04 | `workflow-recipe-fixtures.test.ts` | Panel/research/attack/rule has three fan-out branches and an explicit all-join before attack. |
| AR-05 | `workflow-recipe-fixtures.test.ts` | Attack/architect/judge/unify/edge_test has judge/unify/edge-test gates and one rejected edge-test back-edge with `maxTraversals: 2`. |
| AR-06 | `workflow-recipe-contracts.test.ts` | Unknown or mismatched registry, schema, evaluator, gate, config, scorecard, plan, or methodology manifests fail closed. |
| AR-07 | `workflow-recipe-contracts.test.ts` | Universal six-stage chain and host-adjudication binding are required for consequential changes; nodes cannot authorize. |
| AR-08 | `workflow-recipe-contracts.test.ts` | Missing ports, schema mismatch, implicit joins, unguarded cycles, unbounded loops, omitted progress evidence, and omitted exhaustion fail closed. |
| AR-09 | `workflow-recipe-contracts.test.ts` | Demand hints are bounded by task/envelope/control reserves; widest-safe mapping is deterministic and does not saturate verification/red-team/recovery. |
| AR-10 | `workflow-recipe-contracts.test.ts` | Node evidence carries recipe/task/attempt/epoch/sidecar digests; failed branches and gate results cannot be omitted. |
| AR-11 | `workflow-recipe-contracts.test.ts` | Repeated publication, validation, branch admission, join, gate, and rollback operations are idempotent; conflicting preimages fail. |
| AR-12 | `workflow-recipe-contracts.test.ts` | Restart re-resolves immutable artifacts, quarantines mismatch/uncertainty, and never replays an already committed branch or back-edge. |
| AR-13 | `workflow-recipe-contracts.test.ts` | Refinement preserves all protected digests and requires trial, hidden holdout, canary, independent review, host promotion, and rollback records. |
| AR-14 | `workflow-recipe-contracts.test.ts` | All 13 red-team attack IDs, including the five typed overfitting case IDs, are required for proposal, revision, decision, promotion, and rollback. |
| AR-15 | `workflow-recipe-contracts.test.ts` | No journal event, daemon field, startup dependency, or ordinary-workflow compatibility regression is introduced. |
| AR-25 | Tasks 2, 4, 7, and 9, capability/contract tests | The closed required native set is exactly AutoResearch, MemPalace, and general memory; resolver-derived literal manifests reject caller booleans; durable snapshots/manifests, optional Superpowers gaps, evidence-only output, and no silent fallback validate. |
| AR-26 | Tasks 4, 7, 8, and 9, contract/recovery tests | The pre-evaluation overfitting reviewer has all eight checks, zero authority, opaque host-only handles, authenticated resolver contexts, unauthorized-resolution/byte-exposure rejection, advisory exploration behavior, and blocking gates before holdout/promotion/milestone acceptance/completion. |
| AR-27 | Tasks 2, 9, and 10, lifecycle/A runtime suites | Non-gameable overfitting RED cases cover small-data wins, leakage, repeated peeking, unstable variance, and held-out degradation; MemPalace requires/returns typed prior canonical commit/host receipt and rejects decision/outcome/run-state; runtime acceptance/recovery rejects missing, stale, exposed, or mutated review evidence. |

Required focused commands:

```bash
cd /Users/nathanballou/Documents/GitHub/prime-agent/packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/workflow-recipe-contracts.test.ts test/workflow-recipe-capabilities.test.ts test/autoresearch-native-integration.test.ts test/knowledge-mempalace-boundary.test.ts test/workflow-task-graph-sidecar.test.ts test/workflow-recipe-fixtures.test.ts
npx tsx ../../node_modules/vitest/dist/cli.js --run test/workflow-task-graph.test.ts
cd /Users/nathanballou/Documents/GitHub/prime-agent
npm run check
```

The acceptance gate is not complete until the six source hashes at the top of
this document still match, the frozen `WorkflowTask` source has no new
generated-output/lock fields, the daemon constants remain unchanged, and the
focused tests plus `npm run check` provide logs. A future implementation must
also run the existing K/A runtime and aggregate matrix after the recipe slice;
mock-only evidence is insufficient for dispatch, recovery, or compatibility
claims.

## 19. Explicit success criteria

The design is successfully implemented only when all of the following are
verified by the acceptance artifacts:

1. one immutable recipe digest and one effective task-graph digest bind every
   recipe-bound plan revision;
2. every recipe node maps one-to-one to an existing task and emits evidence
   only;
3. the host registry resolves all semantics and rejects unknown or mismatched
   manifests;
4. typed ports, schema digests, edges, fan-out, explicit joins, bounded loops,
   output contracts, evidence contracts, gates, scorecards, decisions,
   invariants, checks, resource hints, and scheduler mappings validate;
5. the two exact fixtures pass as ordinary recipes, including the explicit
   panel join and bounded edge-test back-edge;
6. K-T10A resolves the generated-output/lock-path drift without changing the
   frozen `WorkflowTask` contract;
7. recovery and idempotency preserve immutable artifacts, epochs, leases,
   branch identities, gate results, and loop budgets;
8. refinement cannot change protected goal/scorecard/evaluator/approval/
   ceiling/kernel/completion digests and cannot self-promote; and
9. the native AutoResearch engine and MemPalace durable how/why boundary are
   required built-ins with durable bundled-facade snapshots/manifests, the
   existing native general-memory surface is separate from transient run
   state, optional Superpowers absence is an explicit capability gap, and no
   skill output can self-authorize; 
10. every recipe has the zero-authority pre-evaluation overfitting reviewer,
   all eight checks, hidden/adversarial host holdouts, advisory exploration
   behavior, and blocking review before holdout, canary, independent review,
   promotion, milestone acceptance, and completion; and
11. the required 13-attack red-team matrix (including small-data wins,
   leakage, repeated peeking, unstable variance, and held-out degradation),
   focused tests, runtime acceptance/recovery evidence, protocol review, and
   root `npm run check` all produce evidence-backed results.

## 20. Draft self-audit

Before handoff, the draft was checked for unresolved markers, undefined local
types in the interface block, contradictory authority statements, missing
manifest bindings, unbounded loop paths, undeclared fan-out joins, and
unclassified protocol changes. The interface block defines every recipe-local
type and imports only existing frozen contracts. The only repeat path is the
explicit edge-test back-edge with a finite traversal count. The only artifact
schema change is the classified local recipe schema carried by an existing
barrier artifact; journal and daemon surfaces remain unchanged.

## 21. Approved protected-milestone and acceleration addendum

This section is a normative, approved additive contract of this design. It
adds a host-resolved protected milestone and a bounded acceleration path to
the recipe sidecar. It does not reopen K-T0, alter the frozen `WorkflowTask`,
or change the universal `recon -> lenses -> verification -> synthesis ->
red-team -> host-adjudication` sequence. Acceleration may change admission of
already-approved work inside the existing envelope; it cannot change what the
workflow is trying to prove.

A **protected milestone** is a finite, host-resolved, evidence-bearing proof
slice called `firstTestableMilestone`. It is not completion and it is not a
new task graph. A **milestone run** is either a worker-free K shell that
resolves and validates the slice, or an A true-runtime execution that has
real processes, leases, effects, and host evidence. The shell may prove
deterministic contract properties, but it can never produce an accepted
milestone or a trusted elapsed-time metric. True runtime continuity starts
once, survives restarts, and ends only at host adjudication.

### 21.1 Exact ownership and compatibility

The ownership boundary is fixed:

| Surface | K owns | A owns | Classification and prohibition |
| --- | --- | --- | --- |
| Milestone scope | Resolving `firstTestableMilestone` from the accepted plan/DAG, assigning namespaced milestone task IDs, issuing the resolver receipt, and binding goal/scorecard/evaluator/approval/resource/kernel/completion digests | Consuming the immutable scope and reporting runtime observations | Additive local artifact contract. A cannot select, widen, or reinterpret scope. |
| Capacity | K capacity request, `discoverWorkflowCapacity`, host/cloud verification, canonical component ledger, control/worker partitions, and `publishWorkflowResourceEnvelope` | Read-only consumption of the approved envelope and existing adaptive allocation host | Existing K resource contracts are reused. A cannot discover a second capacity pool or enlarge a ceiling. |
| Allocation evidence | K’s existing adaptive controller/CAS contract and its immutable state | A runtime observation and the evidence-only efficiency reviewer | Additive local evidence projection. The reviewer has no write, reallocation, approval, or completion authority. |
| Plan churn | Typed bounded proposal and host CAS against the existing plan/revision head | Runtime evidence that may trigger a proposal | Existing plan/revision persistence and decision path; no recipe or worker may mutate a plan. |
| RED tests | Host-owned immutable executable manifest, hidden holdouts, verifier, result binding, and independent review | Execution in the real runtime and publication of process/evidence receipts | Additive local artifacts. A may execute only the host manifest and cannot edit or select tests. |
| Overfitting review | Resolving the host reviewer contract, eight check manifests, current review digest, and hidden-byte boundary | Supplying evidence handles and replicate/holdout results; no bytes or authority | Additive local evidence. Advisory during exploration; blocking before holdout, promotion, milestone acceptance, or completion. |
| Acceptance | Once-only milestone acceptance record and fence, host evidence, and state CAS | Supplying true-runtime evidence and invoking the existing scheduler after the fence | Additive local artifacts. K is the only milestone authority; A cannot self-accept. |
| Backlog | Holdback/resume state and canonical queue-key binding | Persisted queue consumption and the existing scheduler call | No second scheduler. The only resume dispatch is `scheduler.refill(workflowId, epochRef)`. |

K-T10A remains between K-T10 and K-T11. The generated-output/lock-path
drift is resolved only by the existing `WorkflowTaskBoundarySidecarMap`:
`generatedOutputPaths` and `lockPaths` are sidecar fields, never new
`WorkflowTask` fields. The effective task-graph digest includes those paths.
A missing sidecar entry is a recipe-bound validation failure; a legacy
ordinary workflow keeps its current `WorkflowTask` behavior.

Compatibility is fixed as follows:

- Existing `WorkflowTask`, journal event kinds, daemon commands, daemon
  response shapes, `DAEMON_PROTOCOL_VERSION`, and `DAEMON_SCHEMA_REVISION`
  remain unchanged. No recipe, milestone, reviewer, churn, RED, acceptance,
  holdback, or resume event kind is added.
- New records are immutable canonical-JSON artifacts carried by existing
  `artifactRefs`, plan decisions, `planDigest`, and configuration
  `methodologyManifestDigests`. Their payloads are an additive,
  capability-independent/local-projection artifact schema revision. If a
  payload kind later needs an extension, it remains an additive artifact
  schema revision and is not a daemon capability, startup dependency, or
  protocol negotiation.
- Recipe activation still uses the existing version-2 configuration contract
  and canonical barrier path. Unknown or mismatched manifests fail closed
  before readiness; readers may not ignore a required artifact and dispatch
  the plain DAG.
- The null ordinary path is backward-compatible: when no recipe is bound,
  all milestone scope, holdback, acceptance, and acceleration references are
  `null`, the current scheduler ordering is used, and no new handshake or
  reviewer work is required. Recipe-bound workflows require native
  AutoResearch/MemPalace capability closure and the overfitting reviewer;
  ordinary workflows do not gain a startup dependency.

### 21.2 Exact serializable contracts

The following interfaces are the complete additive records. Names such as
`WorkflowArtifactRef`, `WorkflowDecisionRef`, `WorkflowEpochRef`,
`WorkflowVerifiedHostReceipt`, `WorkflowMonotonicClockObservation`,
`WorkflowResourceVector`, `WorkflowControlCapacityVector`,
`WorkflowCanonicalPoolDimension`, `WorkflowCanonicalPoolLedger`,
`WorkflowControlPartition`, `WorkflowWorkerPartition`,
`WorkflowResourceEnvelopeDraft`, `WorkflowResourceEnvelope`,
`WorkflowAuthenticatedCapacitySnapshotRefs`, `WorkflowLeaseRef`,
`WorkflowAdaptiveAllocationObservation`, `WorkflowAdaptiveAllocationEntry`,
`WorkflowCapacityDiscoveryInput`, and `WorkflowCapacitySnapshot` refer to
the existing frozen K/A contracts. Every interface below is serializable: it
contains no function, class instance, `Map`, `Set`, `Date`, `Uint8Array`, or
opaque runtime object.

```ts
export type WorkflowProtectedMilestoneId = `milestone:${string}`;
export type WorkflowProtectedMilestoneTaskId = `milestone-task:${string}`;
export type WorkflowProtectedMilestoneOperationId = `milestone-op:${string}`;
export type WorkflowPlanChurnId = `plan-churn:${string}`;
export type WorkflowRedTestId = `red-test:${string}`;
export type WorkflowProtectedAllocationId = `allocation:${string}`;

export interface WorkflowFirstTestableMilestone {
  name: "firstTestableMilestone";
  milestoneId: WorkflowProtectedMilestoneId;
  requirementIds: readonly string[];
  taskIds: readonly WorkflowProtectedMilestoneTaskId[];
  acceptanceGateContractIds: readonly WorkflowRecipeGateContractId[];
  evidenceContractIds: readonly string[];
  completionPredicateDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedMilestoneTaskBinding {
  milestoneTaskId: WorkflowProtectedMilestoneTaskId;
  workflowTaskId: string;
  nodeId: WorkflowRecipeNodeId;
  ordinal: number;
  dependencyTaskIds: readonly WorkflowProtectedMilestoneTaskId[];
  frozenTaskDigest: WorkflowRecipeDigest;
  effectiveTaskGraphDigest: WorkflowRecipeDigest;
  boundarySidecarDigest: WorkflowRecipeDigest;
  uniqueTaskKeyDigest: WorkflowRecipeDigest;
}

export interface WorkflowFirstTestableMilestoneScope {
  schemaId: "workflow-first-testable-milestone-v1";
  workflowId: string;
  recipeDigest: WorkflowRecipeDigest;
  planRevision: number;
  planDigest: WorkflowRecipeDigest;
  effectiveTaskGraphDigest: WorkflowRecipeDigest;
  boundarySidecarDigest: WorkflowRecipeDigest;
  firstTestableMilestone: WorkflowFirstTestableMilestone;
  taskBindings: readonly WorkflowProtectedMilestoneTaskBinding[];
  resolverManifestRef: WorkflowArtifactRef;
  resolverReceiptRef: WorkflowArtifactRef;
  resolverReceipt: WorkflowVerifiedHostReceipt;
  inputArtifactRefs: readonly WorkflowArtifactRef[];
  goalContractDigest: WorkflowRecipeDigest;
  scorecardDigest: WorkflowRecipeDigest;
  evaluatorDigest: WorkflowRecipeDigest;
  approvalPolicyDigest: WorkflowRecipeDigest;
  resourceCeilingsDigest: WorkflowRecipeDigest;
  kernelContractDigest: WorkflowRecipeDigest;
  scopeDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedMilestoneClockBoundary {
  schemaId: "workflow-protected-milestone-clock-boundary-v1";
  boundary: "start" | "end";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  epochRef: WorkflowEpochRef;
  stateHeadDigest: WorkflowRecipeDigest;
  leaseHeadDigest: WorkflowRecipeDigest;
  clockObservation: WorkflowMonotonicClockObservation;
  trustedClockReceiptRef: WorkflowArtifactRef;
  trustedClockReceipt: WorkflowVerifiedHostReceipt;
  continuityEvidenceRefs: readonly WorkflowArtifactRef[];
  boundaryDigest: WorkflowRecipeDigest;
}

export interface WorkflowCanonicalMilestoneTimeMetric {
  schemaId: "workflow-canonical-milestone-time-v1";
  metricKind: "first-testable-milestone-trusted-wall-time";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  start: WorkflowProtectedMilestoneClockBoundary;
  end: WorkflowProtectedMilestoneClockBoundary;
  elapsedMilliseconds: number;
  restartCount: number;
  continuityEvidenceRefs: readonly WorkflowArtifactRef[];
  excludedIntervals: readonly [];
  evaluatorDigest: WorkflowRecipeDigest;
  scorecardDigest: WorkflowRecipeDigest;
  completionPredicateDigest: WorkflowRecipeDigest;
  metricPreimageDigest: WorkflowRecipeDigest;
  metricDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedMilestoneIntegrityAttestation {
  schemaId: "workflow-protected-milestone-integrity-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  startScopeDigest: WorkflowRecipeDigest;
  endScopeDigest: WorkflowRecipeDigest;
  goalContractDigest: WorkflowRecipeDigest;
  scorecardDigest: WorkflowRecipeDigest;
  evaluatorDigest: WorkflowRecipeDigest;
  approvalPolicyDigest: WorkflowRecipeDigest;
  resourceCeilingsDigest: WorkflowRecipeDigest;
  kernelContractDigest: WorkflowRecipeDigest;
  completionPredicateDigest: WorkflowRecipeDigest;
  realProcessEvidenceRefs: readonly WorkflowArtifactRef[];
  mockDetectionEvidenceRefs: readonly WorkflowArtifactRef[];
  proxyMetricEvidenceRefs: readonly WorkflowArtifactRef[];
  restartContinuityEvidenceRefs: readonly WorkflowArtifactRef[];
  integrationEvidenceRefs: readonly WorkflowArtifactRef[];
  noScopeChange: true;
  noMockOnly: true;
  noProxyOnly: true;
  noRestartReset: true;
  noIntegrationSubstitution: true;
  hostReceiptRef: WorkflowArtifactRef;
  hostReceipt: WorkflowVerifiedHostReceipt;
  attestationDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedPoolComponentTotal {
  dimension: WorkflowCanonicalPoolDimension;
  poolIds: readonly string[];
  approved: number;
  reserved: number;
  active: number;
  remaining: number;
  committed: number;
  released: number;
  quarantined: number;
  componentDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedPoolAccounting {
  schemaId: "workflow-protected-pool-accounting-v1";
  workflowId: string;
  epochRef: WorkflowEpochRef;
  canonicalLedgerRef: WorkflowArtifactRef;
  canonicalLedgerDigest: WorkflowRecipeDigest;
  dimensions: readonly WorkflowProtectedPoolComponentTotal[];
  controlPartition: WorkflowControlPartition;
  workerPartition: WorkflowWorkerPartition;
  controlCapacity: WorkflowControlCapacityVector;
  workerCapacity: WorkflowControlCapacityVector;
  componentAssignmentDigest: WorkflowRecipeDigest;
  accountingDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedCapacityVerification {
  schemaId: "workflow-protected-capacity-verification-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  requestDigest: WorkflowRecipeDigest;
  capacitySnapshot: WorkflowCapacitySnapshot;
  authenticatedSnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
  cloudCapacityReceipt: WorkflowCloudCapacityReceipt | null;
  poolAccounting: WorkflowProtectedPoolAccounting;
  unknownPoolIds: readonly string[];
  verifierManifestRef: WorkflowArtifactRef;
  verifierReceiptRef: WorkflowArtifactRef;
  verifierReceipt: WorkflowVerifiedHostReceipt;
  verified: true;
  verificationDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedCapacityEnvelopeHandshake {
  schemaId: "workflow-protected-capacity-envelope-handshake-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  epochRef: WorkflowEpochRef;
  currentStateDigest: WorkflowRecipeDigest;
  currentRevision: number;
  capacityRequestDigest: WorkflowRecipeDigest;
  trustedClockReceiptRef: WorkflowArtifactRef;
  capacitySnapshotDigest: WorkflowRecipeDigest;
  verification: WorkflowProtectedCapacityVerification;
  envelopeDraft: WorkflowResourceEnvelopeDraft;
  decisionRef: WorkflowDecisionRef;
  envelope: WorkflowResourceEnvelope;
  handshakeReceiptRef: WorkflowArtifactRef;
  handshakeReceipt: WorkflowVerifiedHostReceipt;
  handshakeDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedEfficiencyObservation {
  schemaId: "workflow-protected-efficiency-observation-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  taskId: string;
  attemptId: string;
  allocationId: WorkflowProtectedAllocationId;
  executionKey: string;
  epochRef: WorkflowEpochRef;
  observation: WorkflowAdaptiveAllocationObservation;
  observationRef: WorkflowArtifactRef;
  observationDigest: WorkflowRecipeDigest;
  ledgerRef: WorkflowArtifactRef;
  ledgerHeadDigest: WorkflowRecipeDigest;
  leaseRef: WorkflowLeaseRef;
  leaseDigest: WorkflowRecipeDigest;
  decisionRef: WorkflowDecisionRef;
  decisionReceiptRef: WorkflowArtifactRef;
  decisionReceipt: WorkflowVerifiedHostReceipt;
  controllerHeadDigest: WorkflowRecipeDigest;
  authenticatedSnapshotRefs: WorkflowAuthenticatedCapacitySnapshotRefs;
  actualUsage: WorkflowResourceVector;
  trustedClockObservation: WorkflowMonotonicClockObservation;
  observationSequence: number;
  observationDigestPreimage: WorkflowRecipeDigest;
}

export interface WorkflowProtectedEfficiencyReview {
  schemaId: "workflow-protected-efficiency-review-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  allocationId: WorkflowProtectedAllocationId;
  freshObservationRef: WorkflowArtifactRef;
  freshObservationDigest: WorkflowRecipeDigest;
  freshLedgerRef: WorkflowArtifactRef;
  freshLedgerHeadDigest: WorkflowRecipeDigest;
  freshLeaseRef: WorkflowLeaseRef;
  freshLeaseDigest: WorkflowRecipeDigest;
  freshDecisionRef: WorkflowDecisionRef;
  freshDecisionReceiptRef: WorkflowArtifactRef;
  efficiencyEvidenceRefs: readonly WorkflowArtifactRef[];
  reviewerManifestRef: WorkflowArtifactRef;
  reviewerReceipt: WorkflowVerifiedHostReceipt;
  writeAuthority: false;
  reallocationAuthority: false;
  approvalAuthority: false;
  completionAuthority: false;
  reviewDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedAdaptiveAllocationCas {
  schemaId: "workflow-protected-adaptive-allocation-cas-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  allocationId: WorkflowProtectedAllocationId;
  epochRef: WorkflowEpochRef;
  expectedControllerHeadDigest: WorkflowRecipeDigest;
  freshObservationRef: WorkflowArtifactRef;
  freshObservationDigest: WorkflowRecipeDigest;
  freshLedgerRef: WorkflowArtifactRef;
  freshLedgerHeadDigest: WorkflowRecipeDigest;
  freshLeaseRef: WorkflowLeaseRef;
  freshLeaseDigest: WorkflowRecipeDigest;
  freshDecisionRef: WorkflowDecisionRef;
  freshDecisionReceiptRef: WorkflowArtifactRef;
  nextAllocation: WorkflowAdaptiveAllocationEntry;
  idempotencyKey: string;
  casResult: "committed" | "already_committed" | "rejected";
  nextControllerHeadDigest: WorkflowRecipeDigest | null;
  hostReceiptRef: WorkflowArtifactRef;
  hostReceipt: WorkflowVerifiedHostReceipt;
  casDigest: WorkflowRecipeDigest;
}

export type WorkflowPlanChurnReason =
  | "protected_milestone_failure"
  | "edge_test_failure"
  | "host_reconciliation"
  | "verified_resource_change";

export interface WorkflowPlanChurnProposal {
  schemaId: "workflow-plan-churn-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  recipeDigest: WorkflowRecipeDigest;
  churnId: WorkflowPlanChurnId;
  reason: WorkflowPlanChurnReason;
  reasonEvidenceRefs: readonly WorkflowArtifactRef[];
  priorPlanDigest: WorkflowRecipeDigest;
  nextPlanDigest: WorkflowRecipeDigest;
  priorPlanRevision: number;
  nextPlanRevision: number;
  changedTaskIds: readonly string[];
  redTestManifestRef: WorkflowArtifactRef;
  expectedPlanHeadDigest: WorkflowRecipeDigest;
  expectedEpoch: WorkflowEpochRef;
  churnOrdinal: number;
  maxChurns: number;
  remainingChurnsBefore: number;
  proposalReceiptRef: WorkflowArtifactRef;
  proposalDigest: WorkflowRecipeDigest;
}

export interface WorkflowPlanChurnCasRecord {
  schemaId: "workflow-plan-churn-cas-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  churnId: WorkflowPlanChurnId;
  proposalDigest: WorkflowRecipeDigest;
  expectedPlanHeadDigest: WorkflowRecipeDigest;
  committedPlanHeadDigest: WorkflowRecipeDigest | null;
  expectedEpoch: WorkflowEpochRef;
  priorPlanRevision: number;
  committedPlanRevision: number | null;
  churnOrdinal: number;
  maxChurns: number;
  remainingChurnsAfter: number;
  result: "committed" | "already_committed" | "rejected";
  decisionRef: WorkflowDecisionRef;
  hostReceiptRef: WorkflowArtifactRef;
  hostReceipt: WorkflowVerifiedHostReceipt;
  casDigest: WorkflowRecipeDigest;
}

export interface WorkflowRedTestCase {
  testId: WorkflowRedTestId;
  attackId: string;
  commandArtifactRef: WorkflowArtifactRef;
  inputArtifactRefs: readonly WorkflowArtifactRef[];
  hiddenInputHandleIds: readonly WorkflowRecipeHiddenHoldoutHandleId[];
  expectedExitCode: number;
  timeoutMilliseconds: number;
  requiredEvidenceKinds: readonly string[];
  owner: "host";
  hidden: boolean;
  requiresRealRuntime: true;
  mockOnly: false;
  testDigest: WorkflowRecipeDigest;
}

export interface WorkflowRedTestManifest {
  schemaId: "workflow-red-test-manifest-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  recipeDigest: WorkflowRecipeDigest;
  planRevision: number;
  tests: readonly WorkflowRedTestCase[];
  maxTests: number;
  maxRuntimeMilliseconds: number;
  hiddenHoldoutHandle: WorkflowRecipeHostOnlyHiddenHoldoutHandle;
  resolverContext: WorkflowRecipeHiddenHoldoutResolverContext;
  evaluatorDigest: WorkflowRecipeDigest;
  executable: true;
  owner: "host";
  manifestDigest: WorkflowRecipeDigest;
}

export interface WorkflowRedTestResult {
  schemaId: "workflow-red-test-result-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  manifestDigest: WorkflowRecipeDigest;
  testId: WorkflowRedTestId;
  invocationId: WorkflowProtectedMilestoneOperationId;
  runtimeMode: "worker_free_shell" | "true_runtime";
  startBoundaryRef: WorkflowArtifactRef;
  endBoundaryRef: WorkflowArtifactRef;
  exitCode: number;
  timedOut: boolean;
  stdoutArtifactRef: WorkflowArtifactRef;
  stderrArtifactRef: WorkflowArtifactRef;
  evidenceRefs: readonly WorkflowArtifactRef[];
  passed: boolean;
  hostReceiptRef: WorkflowArtifactRef;
  hostReceipt: WorkflowVerifiedHostReceipt;
  resultDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedMilestoneAcceptanceRecord {
  schemaId: "workflow-protected-milestone-acceptance-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  milestoneId: WorkflowProtectedMilestoneId;
  acceptanceId: WorkflowProtectedMilestoneOperationId;
  onceOnlyKey: WorkflowRecipeDigest;
  runtimeMode: "worker_free_shell" | "true_runtime";
  scope: WorkflowFirstTestableMilestoneScope;
  timeMetric: WorkflowCanonicalMilestoneTimeMetric | null;
  integrity: WorkflowProtectedMilestoneIntegrityAttestation;
  capacityHandshakeRef: WorkflowArtifactRef;
  efficiencyReviewRefs: readonly WorkflowArtifactRef[];
  redTestManifestRef: WorkflowArtifactRef;
  redTestResultRefs: readonly WorkflowArtifactRef[];
  hostEvidenceRefs: readonly WorkflowArtifactRef[];
  requiredGateResultRefs: readonly WorkflowArtifactRef[];
  decisionRef: WorkflowDecisionRef;
  expectedStateHeadDigest: WorkflowRecipeDigest;
  expectedEpoch: WorkflowEpochRef;
  status: "accepted" | "rejected";
  acceptanceOrdinal: 1;
  hostReceiptRef: WorkflowArtifactRef;
  hostReceipt: WorkflowVerifiedHostReceipt;
  acceptanceDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedMilestoneAcceptanceFence {
  schemaId: "workflow-protected-milestone-acceptance-fence-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  onceOnlyKey: WorkflowRecipeDigest;
  acceptanceDigest: WorkflowRecipeDigest;
  expectedStateHeadDigest: WorkflowRecipeDigest;
  expectedEpoch: WorkflowEpochRef;
  claimed: boolean;
  claimSequence: number;
  claimReceiptRef: WorkflowArtifactRef;
  claimReceipt: WorkflowVerifiedHostReceipt;
  fenceDigest: WorkflowRecipeDigest;
}

export interface WorkflowCanonicalSchedulerPriorityKey {
  priority: number;
  queuedAt: string;
  taskId: string;
  keyDigest: WorkflowRecipeDigest;
}

export interface WorkflowBacklogHoldbackState {
  schemaId: "workflow-full-backlog-holdback-v1";
  workflowId: string;
  recipeDigest: WorkflowRecipeDigest | null;
  scopeDigest: WorkflowRecipeDigest | null;
  state: "none" | "held_back" | "resumable" | "resumed" | "blocked";
  reason: "no_recipe" | "protected_milestone" | "acceptance_pending" | "acceptance_rejected" | "runtime_recovery";
  backlogQueueHeadDigest: WorkflowRecipeDigest;
  queuedTaskIds: readonly string[];
  heldBackTaskIds: readonly string[];
  originalPriorityKeys: readonly WorkflowCanonicalSchedulerPriorityKey[];
  epochRef: WorkflowEpochRef;
  holdbackDigest: WorkflowRecipeDigest;
}

export interface WorkflowBacklogResumeRecord {
  schemaId: "workflow-full-backlog-resume-v1";
  workflowId: string;
  scopeDigest: WorkflowRecipeDigest;
  acceptanceFenceDigest: WorkflowRecipeDigest;
  beforeQueueHeadDigest: WorkflowRecipeDigest;
  afterQueueHeadDigest: WorkflowRecipeDigest;
  resumedTaskIds: readonly string[];
  epochRef: WorkflowEpochRef;
  schedulerRefillInvocationDigest: WorkflowRecipeDigest;
  schedulerRefillInvocationCount: 1;
  hostReceiptRef: WorkflowArtifactRef;
  hostReceipt: WorkflowVerifiedHostReceipt;
  resumeDigest: WorkflowRecipeDigest;
}

export interface WorkflowProtectedMilestoneSchedulerProjection {
  workflowId: string;
  recipeDigest: WorkflowRecipeDigest | null;
  firstTestableMilestoneScopeDigest: WorkflowRecipeDigest | null;
  holdbackStateDigest: WorkflowRecipeDigest | null;
  acceptanceFenceDigest: WorkflowRecipeDigest | null;
  readyTaskIds: readonly string[];
  priorityKeys: readonly WorkflowCanonicalSchedulerPriorityKey[];
  ordinaryPath: boolean;
  projectionDigest: WorkflowRecipeDigest;
}
```

The acceleration closure additionally carries the current blocking
`WorkflowRecipeOverfittingReview` ref/digest and every required native
capability snapshot/manifest digest. Acceptance and recovery re-resolve these
records before any fence or refill. A shell or runtime adapter cannot replace
the review with a role verdict, visible holdout, or skill output.

The two typed milestone task IDs are artifact identities, not new
`WorkflowTask` IDs. `workflowTaskId` must resolve to one existing task, and
the resolver must establish a bijection between `taskBindings` and the
existing task IDs in the scope. The canonical ID form is
`milestone-task:<workflow-id>:<plan-revision>:<workflow-task-id>` after
lowercase ASCII normalization; a slash, whitespace, empty segment, duplicate,
or case-fold collision is invalid. `uniqueTaskKeyDigest` is
`SHA-256(canonicalJson({ workflowId, planRevision, workflowTaskId, nodeId }))`.

### 21.3 Resolver, time, and anti-cheating rules

K resolves `firstTestableMilestone` only from the current host-resolved
goal, accepted plan decision, effective K-T10 graph, sidecar, evaluator,
scorecard, completion predicate, and host registry. The resolver returns no
scope if any input is stale or ambiguous. It sorts requirement IDs, task
bindings, gate IDs, evidence IDs, and artifact refs by canonical ID before
hashing. The resolver manifest and its one-use host receipt bind the scope
digest, current state head, plan revision, epoch, and resolver inputs. A
planner, recipe node, role label, efficiency reviewer, or RED test cannot
choose the milestone or alter its task set.

The exact rules are:

1. `firstTestableMilestone.taskIds` is non-empty, finite, and unique. Each
   task binding points to one existing task and one existing recipe node;
   dependency IDs are in the same scope and form a finite DAG. `ordinal` is
   contiguous `0..n-1`.
2. Goal, scorecard, evaluator, approval, resource, kernel, completion, plan,
   effective graph, sidecar, and methodology digests are the protected
   baseline. No scope or acceleration record may replace one.
3. The worker-free shell may validate fixed IDs, schemas, RED manifests,
   capacity accounting, and CAS preimages. It records
   `runtimeMode: "worker_free_shell"` and cannot set an accepted record,
   trusted time metric, or true-runtime result.
4. A true-runtime start boundary is written exactly once after host scope
   acceptance and before the first real process/lease effect. The end
   boundary is written only after final process/effect evidence, all required
   gates, RED results, independent review, and host adjudication. Both use
   host `receiptKind: "clock"` receipts and the existing monotonic clock
   observation; model timestamps are never boundaries.
5. End monotonic time is not less than start monotonic time, and elapsed time
   is exactly their difference. `excludedIntervals` is `[]`: pauses, queue
   holdback, leases, retries, crashes, restarts, and recovery time count. A
   restart increments `restartCount`, adds continuity evidence, and never
   resets the start.
6. Every protected digest is identical at start and end. Any change is a
   hidden-scope-change failure, not a new milestone run.
7. Acceptance requires host evidence for real process identity, ownership and
   resource lease, actual effect/artifact path, integration execution,
   restart continuity when applicable, proxy-metric falsification, and mock
   detection. Unit tests, faux providers, role verdicts, utilization,
   throughput, branch count, queue drainage, and shell elapsed time cannot
   satisfy those requirements.
8. The host-owned immutable RED manifest and every result bind hidden
   holdouts/edge tests by digest, actual process boundaries, exit status,
   output refs, evidence, and a host receipt. Missing, timed-out, mock-only,
   substituted, or proposer-owned tests fail closed.
9. A protected milestone cannot accept without a current blocking overfitting
   review whose eight check results bind the locked metric, sample/split,
   contamination, peeking, proxy, replicate, and hidden/adversarial evidence.
   The reviewer sees only host-issued evidence handles; hidden holdout bytes
   are never included in a proposer, recipe, or worker input.
10. Required native AutoResearch/MemPalace/general-memory capability snapshots
    and manifest digests are part of the protected closure. A missing or
    mismatched required snapshot fails startup/readiness or recovery; an
    optional Superpowers gap is recorded explicitly and cannot change gates.

The anti-cheat checks are explicit: scope comparison blocks scope cheating;
real-process/lease/effect evidence blocks mock cheating; direct evaluator,
output, hidden-holdout, and invariant evidence blocks proxy optimization;
the persisted start and monotonic chain block restart resets; and host-run
manifest commands plus end-to-end artifacts block integration substitution.
The overfitting reviewer additionally rejects visible-metric-only wins, data
leakage, repeated holdout peeking, unstable replicate variance, and held-out
degradation. Capability gaps and skill snapshot drift are explicit failures,
never silent fallback.

### 21.4 K capacity discovery, verification, and envelope handshake

K owns the exact existing capacity sequence. A consumes the immutable envelope
and never calls a second probe or derives an independent pool total. For a
protected scope, K performs these operations in order:

1. Read current state head, revision, epoch, plan decision, recipe scope,
   active leases, and existing canonical pool ledger. Construct the existing
   `WorkflowCapacityDiscoveryInput` from the approved cloud request.
2. Obtain a trusted clock receipt over `digestObject(capacityRequest)`, then
   call the existing K operation with this exact shape:

   ```ts
   const capacity = await discoverWorkflowCapacity({
     workflowId,
     probe: context.services.capacity,
     request: capacityRequest,
     artifactPublisher,
     artifactResolver,
     cloudEvidenceVerifier,
     trustedClockReceipt,
     receiptContext,
     currentStateDigest,
     currentRevision,
   });
   ```

   The operation publishes the request before probing, verifies finite local
   vectors, verifies cloud request/response/receipt and all capacity,
   pricing, credential, quota, rate-limit, billing, egress, and termination
   artifacts, and represents unknown or stale pools as zero available.
3. K resolves every returned artifact through the existing receipt context
   and verifies workflow/request/state/revision/epoch, receipt, monotonic
   sequence, validity interval, and `WorkflowProtectedPoolAccounting`. A
   verifier result without a host receipt is not a result.
   The existing cloud verifier invocation inside
   `discoverWorkflowCapacity` receives the exact bound request/response tuple
   before the protected verification artifact is accepted:

   ```ts
   await cloudEvidenceVerifier.verify({
     workflowId,
     request: capacityRequest,
     response: capacity.cloudAvailability,
     receiptContext,
     currentStateDigest,
     currentRevision,
     trustedNow: trustedClockReceipt.issuedAt,
   });
   ```

   Local capacity, cloud capacity, usage, billing, rate-limit, and ledger
   refs are then included in the verifier's one-use host receipt.
4. K computes the existing `WorkflowCanonicalPoolLedger` component-wise.
   There is exactly one `WorkflowProtectedPoolComponentTotal` for each
   `WorkflowCanonicalPoolDimension`; no unlisted dimension is accepted. For
   each dimension, sums of pool approved/reserved/active/remaining/
   committed/released/quarantined values equal the canonical ledger totals.
   `controlPartition.capacity` carries control reserve, while the worker
   partition's eight control values are all zero. A worker grant cannot
   consume verification, red-team, recovery, approval, or other control
   capacity.

   The required dimension set is the existing union expanded in this exact
   canonical order: `cpuMilliCores`, `memoryBytes`, `diskBytes`, `ioWeight`,
   `accelerators`, `providers`, `networkEgressBytes`, `wallMilliseconds`,
   `monetaryMicrounits`, `processSlots`, `childSessionSlots`, `modelCallSlots`,
   `modelInputTokens`, `modelOutputTokens`, `verificationSlots`,
   `redTeamSlots`, `recoverySlots`, `spend`, `acceleratorCount`,
   `acceleratorMemoryBytes`, `providerConcurrentRequests`,
   `providerRequestsPerMinute`, `providerTotalRequests`,
   `providerInputTokens`, and `providerOutputTokens`. A duplicate or missing
   dimension fails the verifier before envelope construction.
   For each of the eight control dimensions, the verifier checks
   `ledger.exhaustiveControlDimensions[d] === controlPartition.capacity[d] +
   workerPartition.controlCapacity[d]` and checks
   `workerPartition.controlCapacity[d] === 0`. Resource and accelerator/
   provider dimensions use the same component-wise pool sum; no aggregate
   scalar may hide a pool or a control reserve.
5. K constructs `envelopeDraft` with the existing resource-envelope builder;
   its inputs are the verified capacity snapshot, authenticated canonical
   ledger, control-plane reserve and reserve capacity, declared and
   host-derived control capacities, execution ceilings, declared resource
   vector, required pool IDs, local pricing digest, and approved profile:

   ```ts
   const envelopeDraft = buildWorkflowResourceEnvelope({
     capacity,
     authenticatedLedger,
     controlPlaneReserve,
     controlPlaneReserveCapacity,
     declaredControlCapacity,
     hostDerivedControlCapacity,
     executionCeilings,
     declaredVector,
     requiredPoolIds,
     localPricingDigest,
     profile,
   });
   ```

   A missing required pool, reserve, control scalar, pricing digest, or
   execution ceiling rejects the draft before any decision or publication.
6. After verifier approval and an existing host decision binds the draft, K
   publishes through the exact existing operation:

   ```ts
   const envelope = await publishWorkflowResourceEnvelope({
     workflowId,
     draft: envelopeDraft,
     decisionRef,
     expectedEpoch,
     trustedClockReceipt: envelopeClockReceipt,
     store: context.services.resources.envelopeStore,
     receiptContext,
     currentStateDigest,
     currentRevision,
   });
   ```

   Envelope CAS requires the draft digest, decision scope/digest, epoch,
   current state head, trusted clock, and final capacity-receipt binding to
   match. K stores the handshake through existing artifact refs and generic
   capacity/envelope observations; it does not append a milestone event.
   A observes only the final envelope and canonical ledger ref/digest.

Unknown, stale, expired, unverifiable, non-finite, regressed, underreported,
or saturated capacity invalidates the handshake. Stale observations produce
zero available capacity and no lease/allocation mutation. Demand hints may
choose the widest safe allocation only inside the task declaration, approved
envelope, control partition, and execution ceilings.

### 21.5 Evidence-only efficiency review and adaptive CAS

The efficiency reviewer is a host-scheduled evidence observer. It may report
critical-path value, useful evidence, idle time, queue age, actual usage, or
saturation, but cannot write adaptive state, resize a lease, approve a
decision, promote a recipe, or accept a milestone. For every allocation,
fresh values are mandatory for the observation artifact and monotonic
sequence, canonical ledger and head, resource/ownership lease and digest,
decision and one-use receipt, authenticated capacity refs, controller head,
actual usage, epoch, task/attempt/execution key, and host receipt.

The flow is fixed:

1. A records `WorkflowProtectedEfficiencyObservation` after reading the
   existing `WorkflowAdaptiveAllocationObservation` and all fresh refs.
2. The reviewer emits `WorkflowProtectedEfficiencyReview` as evidence only;
   its four literal authority fields are validated.
3. The existing `WorkflowAdaptiveAllocationController` consumes that review
   as an observation and proposes a bounded allocation. The existing
   adaptive store/CAS is the sole write path and must match every fresh field
   in `WorkflowProtectedAdaptiveAllocationCas`.
4. A accepts only `committed`, or an idempotent `already_committed` result
   with the same preimage. A stale/rejected result leaves the safe allocation
   unchanged and enters existing recovery for a fresh observation.

No reviewer output is a completion predicate. No efficiency metric rewards
activity without new requirement evidence. Existing hysteresis, aging,
exploration, transition limits, and reserve policy remain the one K/A
controller; this addendum creates no controller.

### 21.6 Durable bounded plan churn and executable RED tests

Plan churn is an immutable proposal plus a typed CAS record, never an in-place
edit. A protected scope has one host-owned `maxChurns` copied from the
approved ceiling. `churnOrdinal` starts at `1`, increments by one, and cannot
exceed `maxChurns`; `remainingChurnsAfter` is exactly
`maxChurns - churnOrdinal`. A change to goal, scorecard, evaluator, approval,
resource ceiling, kernel, completion predicate, or owned task boundary is a
scope/policy change and is rejected as churn.

`maxChurns` is a safe integer greater than zero,
`1 <= churnOrdinal <= maxChurns`, and
`remainingChurnsBefore === maxChurns - churnOrdinal + 1`. A zero remaining
budget is terminal; it cannot be renewed by a recipe, restart, reviewer, or
worker.

Any recipe, milestone, demand-hint, or acceleration revision still follows
the complete lifecycle `proposal -> trial -> hidden holdout -> canary ->
independent review -> host promotion`, with host rollback as the only
reversal. A plan-churn CAS is permitted only after the relevant host
promotion/decision and RED results; it cannot activate a draft directly or
short-circuit approval, evaluator, scorecard, ceiling, kernel, or completion
contracts.

The CAS checks expected plan head, prior revision, epoch, scope, recipe,
ordinal, and one-use host decision. It writes the new plan only when every
preimage matches. Repeating a `churnId` with the same proposal returns
`already_committed`; the same ID with another preimage conflicts. Existing
artifact/revision recovery replays typed records and cannot infer missing
churn, skip the bound, or reset the counter.

Each proposal includes a host-owned executable `WorkflowRedTestManifest`.
The finite manifest limits test count and runtime; each test has an immutable
command artifact, bounded timeout, inputs, expected exit code, evidence
kinds, `owner: "host"`, hidden flag, `requiresRealRuntime: true`, and
`mockOnly: false`. The command artifact is the exact argv/environment/
workspace policy, not executable model text. Results include actual process
boundaries, exit status, stdout/stderr refs, evidence, and a host receipt.
Missing cases, unbounded timeouts, proposer ownership, visible holdout
substitution, and mock-only results fail before promotion or acceptance.

`maxTests` and `maxRuntimeMilliseconds` are safe integers greater than zero;
`tests.length <= maxTests`, every test timeout is a positive safe integer,
and the sum of test timeouts is no greater than `maxRuntimeMilliseconds`.

The manifest covers the existing 13 red-team attacks plus scope, mock, proxy,
restart, integration, capacity accounting, stale allocation, churn bounds,
unsafe concurrency, saturation, evidence omission, and recipe
self-modification. Hidden holdouts and edge tests remain host-owned immutable
artifacts. A failed result blocks promotion, churn, or acceptance.

### 21.7 Once-only acceptance, holdback, and exact resume

K creates one acceptance record for `(workflowId, scopeDigest, milestoneId)`;
`onceOnlyKey` is `SHA-256(canonicalJson({ workflowId, scopeDigest,
milestoneId }))`. The acceptance CAS requires current state head and epoch,
scope resolver receipt, capacity handshake, fresh allocation review/CAS refs,
the current blocking pre-evaluation overfitting review with all eight checks,
all gate and RED results, integrity attestation, true-runtime end boundary,
and host adjudication. `acceptanceOrdinal` is literally `1`; a second accepted record
is invalid. A worker-free shell may emit the shape only with
`runtimeMode: "worker_free_shell"` and `status: "rejected"`.

The separate acceptance fence is claimed once against the same state head,
epoch, scope, and once-only key. Duplicate submission returns the existing
fence and does not dispatch. Conflicting evidence, epoch, or scope is
quarantined through existing recovery.

While unresolved, the full persistent scheduler backlog is held back. Every
task, original priority, `queuedAt`, task ID, dependency, and queue-head
digest remains; `heldBackTaskIds` is the complete complement of milestone
ready tasks. No task is deleted, renamed, reprioritized, or silently
re-enqueued. Holdback survives restart, pause, crash, lease expiry, and
recovery. Rejected/failed/stale/quarantined acceptance remains held or
blocked under the existing host disposition; a retry needs a fresh scope and
plan CAS and cannot reuse the old fence.

After the fence is claimed and the host marks the workflow resumable, K writes
`resumable`, A projects `resumed`, and invokes this exact existing method
once, with no wrapper scheduler or extra argument:

```ts
const dispatches = await scheduler.refill(workflowId, epochRef);
```

`WorkflowBacklogResumeRecord` binds invocation digest, queue-head before and
after, epoch, and dispatch evidence. Recovery replays that record and does
not call `refill` a second time for the same fence. A stale epoch/head leaves
the backlog held and uses existing scheduler recovery.

### 21.8 Canonical priority, tie-break, fairness, and null path

The existing scheduler ordering is normative: higher numeric `priority`
first; for equal priority, earlier RFC-3339 `queuedAt`; for equal priority
and timestamp, ascending `taskId.localeCompare` using the existing scheduler
comparator. These three fields are
the complete priority key. Role, node label, branch count, utilization,
reviewer score, or current wall time is not a tie-break.

A refill examines each ready queue item at most once for the current queue
head, dispatches only a safe item whose existing dependencies, paths, leases,
and resources fit, and retains a non-fitting item with the same key and an
explicit wait reason. There is no acceleration priority boost. Existing queue
age and adaptive fairness are the only aging mechanisms, so restart/refill
cannot starve an older equal-priority task or duplicate a newer task. Every
ready task is dispatched, held with a reason, or quarantined with evidence.

The ordinary null path is explicit:

```ts
const ordinaryProjection: WorkflowProtectedMilestoneSchedulerProjection = {
  workflowId,
  recipeDigest: null,
  firstTestableMilestoneScopeDigest: null,
  holdbackStateDigest: null,
  acceptanceFenceDigest: null,
  readyTaskIds: existingReadyTaskIds,
  priorityKeys: existingPriorityKeys,
  ordinaryPath: true,
  projectionDigest,
};
```

For this path, the scheduler has its existing behavior; no milestone clock,
capacity handshake, reviewer, churn, RED, acceptance, or holdback artifact
is required, and no new branch or task ID is generated. A recipe path sets
`ordinaryPath: false` and must provide every non-null digest before dispatch.

### 21.9 Canonical digest preimages

All section-21 digests use existing `digestObject(canonicalJson(...))`. The
named digest is excluded from its own preimage. ID-keyed arrays are sorted by
their ID; other arrays retain declared order. Unknown keys, duplicate IDs,
non-finite numbers, invalid timestamps, and out-of-range integers fail before
hashing. The complete preimage list is:

| Digest | Canonical preimage fields |
| --- | --- |
| `uniqueTaskKeyDigest` | `workflowId`, `planRevision`, `workflowTaskId`, `nodeId` |
| `scopeDigest` | `schemaId`, `workflowId`, `recipeDigest`, `planRevision`, `planDigest`, `effectiveTaskGraphDigest`, `boundarySidecarDigest`, `firstTestableMilestone`, sorted `taskBindings`, `resolverManifestRef`, `resolverReceiptRef`, `resolverReceipt`, sorted `inputArtifactRefs`, `goalContractDigest`, `scorecardDigest`, `evaluatorDigest`, `approvalPolicyDigest`, `resourceCeilingsDigest`, and `kernelContractDigest` |
| `boundaryDigest` | `schemaId`, `boundary`, `workflowId`, `scopeDigest`, `epochRef`, `stateHeadDigest`, `leaseHeadDigest`, `clockObservation`, `trustedClockReceiptRef`, `trustedClockReceipt`, sorted `continuityEvidenceRefs` |
| `metricPreimageDigest` | `schemaId`, `metricKind`, `workflowId`, `scopeDigest`, `start.boundaryDigest`, `end.boundaryDigest`, both monotonic values, `elapsedMilliseconds`, `restartCount`, sorted `continuityEvidenceRefs`, literal `excludedIntervals: []`, `evaluatorDigest`, `scorecardDigest`, `completionPredicateDigest` |
| `metricDigest` | `schemaId`, `metricKind`, `workflowId`, `scopeDigest`, full `start`, full `end`, `elapsedMilliseconds`, `restartCount`, `continuityEvidenceRefs`, literal `excludedIntervals: []`, evaluator/scorecard/completion digests, and `metricPreimageDigest` |
| `componentDigest` | `dimension`, sorted `poolIds`, `approved`, `reserved`, `active`, `remaining`, `committed`, `released`, `quarantined` |
| `componentAssignmentDigest` | `workflowId`, `epochRef`, every required resource/control dimension and its canonical pool ID |
| `accountingDigest` | `schemaId`, `workflowId`, `epochRef`, `canonicalLedgerRef`, `canonicalLedgerDigest`, sorted `dimensions`, `controlPartition`, `workerPartition`, `controlCapacity`, `workerCapacity`, `componentAssignmentDigest` |
| `verificationDigest` | `schemaId`, `workflowId`, `scopeDigest`, `requestDigest`, `capacitySnapshot`, `authenticatedSnapshotRefs`, `cloudCapacityReceipt`, `poolAccounting`, sorted `unknownPoolIds`, `verifierManifestRef`, `verifierReceiptRef`, `verifierReceipt`, literal `verified: true` |
| `handshakeDigest` | `schemaId`, `workflowId`, `scopeDigest`, `epochRef`, `currentStateDigest`, `currentRevision`, `capacityRequestDigest`, `trustedClockReceiptRef`, `capacitySnapshotDigest`, `verification`, `envelopeDraft`, `decisionRef`, `envelope`, `handshakeReceiptRef`, `handshakeReceipt` |
| `observationDigestPreimage` | `schemaId`, `workflowId`, `scopeDigest`, `taskId`, `attemptId`, `allocationId`, `executionKey`, `epochRef`, `observation`, `observationRef`, `ledgerRef`, `ledgerHeadDigest`, `leaseRef`, `leaseDigest`, `decisionRef`, `decisionReceiptRef`, `decisionReceipt`, `controllerHeadDigest`, `authenticatedSnapshotRefs`, `actualUsage`, `trustedClockObservation`, `observationSequence` |
| `observationDigest` | `observationDigestPreimage`, `observationSequence`, `observationRef.digest` |
| `reviewDigest` | `schemaId`, `workflowId`, `scopeDigest`, `allocationId`, `freshObservationRef`, `freshObservationDigest`, `freshLedgerRef`, `freshLedgerHeadDigest`, `freshLeaseRef`, `freshLeaseDigest`, `freshDecisionRef`, `freshDecisionReceiptRef`, sorted `efficiencyEvidenceRefs`, `reviewerManifestRef`, `reviewerReceipt`, and four literal authority fields |
| allocation `casDigest` | `schemaId`, `workflowId`, `scopeDigest`, `allocationId`, `epochRef`, `expectedControllerHeadDigest`, all fresh observation/ledger/lease/decision refs and digests, `nextAllocation`, `idempotencyKey`, `casResult`, `nextControllerHeadDigest`, `hostReceiptRef`, `hostReceipt` |
| churn `proposalDigest` | `schemaId`, `workflowId`, `scopeDigest`, `recipeDigest`, `churnId`, `reason`, sorted `reasonEvidenceRefs`, `priorPlanDigest`, `nextPlanDigest`, `priorPlanRevision`, `nextPlanRevision`, sorted `changedTaskIds`, `redTestManifestRef`, `expectedPlanHeadDigest`, `expectedEpoch`, `churnOrdinal`, `maxChurns`, `remainingChurnsBefore`, `proposalReceiptRef` |
| churn `casDigest` | `schemaId`, `workflowId`, `scopeDigest`, `churnId`, `proposalDigest`, `expectedPlanHeadDigest`, `committedPlanHeadDigest`, `expectedEpoch`, `priorPlanRevision`, `committedPlanRevision`, `churnOrdinal`, `maxChurns`, `remainingChurnsAfter`, `result`, `decisionRef`, `hostReceiptRef`, `hostReceipt` |
| `testDigest` | `testId`, `attackId`, `commandArtifactRef`, sorted non-hidden `inputArtifactRefs`, sorted `hiddenInputHandleIds`, `expectedExitCode`, `timeoutMilliseconds`, sorted `requiredEvidenceKinds`, `owner`, `hidden`, literal `requiresRealRuntime: true`, literal `mockOnly: false` |
| `handleDigest` | `handleId`, literal host/hidden/opaque/hostResolverOnly fields, `manifestDigest`, `caseCount`, literal proposer/worker byte-denial fields |
| `contextDigest` | `contextId`, literal host/host_overfitting_reviewer authorization, `handleId`, literal authenticated/evidence-only/no-bytes fields, `authorizationReceiptRef` |
| knowledge `commitDigest`/`receiptDigest` | canonical knowledge kind/ref/digest, sorted source evidence, commit identity, and authenticated host receipt fields; no decision/outcome/run-state payload is in either preimage |
| `manifestDigest` | `schemaId`, `workflowId`, `scopeDigest`, `recipeDigest`, `planRevision`, sorted `tests`, `maxTests`, `maxRuntimeMilliseconds`, `hiddenHoldoutHandle`, `resolverContext`, `evaluatorDigest`, literal `executable: true`, literal `owner: "host"` |
| `resultDigest` | `schemaId`, `workflowId`, `scopeDigest`, `manifestDigest`, `testId`, `invocationId`, `runtimeMode`, `startBoundaryRef`, `endBoundaryRef`, `exitCode`, `timedOut`, `stdoutArtifactRef`, `stderrArtifactRef`, sorted `evidenceRefs`, `passed`, `hostReceiptRef`, `hostReceipt` |
| `attestationDigest` | `schemaId`, `workflowId`, `scopeDigest`, `startScopeDigest`, `endScopeDigest`, every protected baseline digest, sorted real/mock/proxy/restart/integration refs, literal `noScopeChange`, `noMockOnly`, `noProxyOnly`, `noRestartReset`, `noIntegrationSubstitution`, `hostReceiptRef`, `hostReceipt` |
| `acceptanceDigest` | `schemaId`, `workflowId`, `scopeDigest`, `milestoneId`, `acceptanceId`, `onceOnlyKey`, `runtimeMode`, full `scope`, `timeMetric`, `integrity`, `capacityHandshakeRef`, sorted `efficiencyReviewRefs`, `redTestManifestRef`, sorted `redTestResultRefs`, sorted `hostEvidenceRefs`, sorted `requiredGateResultRefs`, `decisionRef`, `expectedStateHeadDigest`, `expectedEpoch`, `status`, literal `acceptanceOrdinal: 1`, `hostReceiptRef`, `hostReceipt` |
| `fenceDigest` | `schemaId`, `workflowId`, `scopeDigest`, `onceOnlyKey`, `acceptanceDigest`, `expectedStateHeadDigest`, `expectedEpoch`, `claimed`, `claimSequence`, `claimReceiptRef`, `claimReceipt` |
| `keyDigest` | priority, queuedAt, taskId |
| `holdbackDigest` | `schemaId`, `workflowId`, `recipeDigest`, `scopeDigest`, `state`, `reason`, `backlogQueueHeadDigest`, sorted `queuedTaskIds`, sorted `heldBackTaskIds`, sorted `originalPriorityKeys`, `epochRef` |
| `schedulerRefillInvocationDigest` | `workflowId`, `acceptanceFenceDigest`, `beforeQueueHeadDigest`, `epochRef`, literal `schedulerMethod: "refill"`, literal arguments `[workflowId, epochRef]` |
| `resumeDigest` | `schemaId`, `workflowId`, `scopeDigest`, `acceptanceFenceDigest`, `beforeQueueHeadDigest`, `afterQueueHeadDigest`, sorted `resumedTaskIds`, `epochRef`, `schedulerRefillInvocationDigest`, literal `schedulerRefillInvocationCount: 1`, `hostReceiptRef`, `hostReceipt` |
| `projectionDigest` | `workflowId`, nullable `recipeDigest`, `firstTestableMilestoneScopeDigest`, `holdbackStateDigest`, `acceptanceFenceDigest`, sorted `readyTaskIds`, sorted `priorityKeys`, `ordinaryPath` |

Receipt fields in these preimages are separately published immutable receipt
objects. The receipt's `payloadDigest` binds the artifact containing the
preimage record without its receipt fields; it never binds the containing
record's final digest. The record digest is computed after the receipt is
inserted and the host verifies the receipt's binding. This rule prevents a
receipt/digest cycle and makes every receipt-bearing preimage deterministic.

Any section-21 digest not covered by this list is a design error. It must be
added to the preimage contract before implementation; it cannot be inferred
from serializer field order.

### 21.10 Recovery, authority, and milestone red-team tests

All records are immutable artifacts referenced by the existing plan decision
and configuration closure. Recovery resolves bytes, size, digest, receipt,
epoch, and state head before action; missing/foreign/stale material
quarantines the scope. Every operation key is its complete preimage plus
operation kind. Same-key same-preimage replay returns the existing result;
same-key different preimage, receipt, epoch, lease, queue head, or state head
is a conflict. Receipt one-use rules remain in force.

No recipe node, role, judge, unifier, reviewer, RED command, planner, or
worker may write an active artifact, registry entry, plan/adaptive head,
lease, fence, or scheduler queue. K host decisions and existing approval,
epoch, lease, and CAS boundaries are the only mutation authorities. A is an
execution/effect/recovery consumer and may invoke only the existing scheduler
after K’s claimed fence.

Every proposal, revision, decision, trial, holdout, canary, review,
promotion, rollback, allocation, churn, and acceptance reruns the existing
13 red-team attacks plus these falsification cases:

| Attack | Required falsification |
| --- | --- |
| Scope substitution | Replace one resolver task/requirement/receipt and show scope/CAS rejection. |
| Clock reset | Replay a prior start after restart and show metric/fence rejection. |
| Shell-to-runtime substitution | Present shell artifacts as true-runtime evidence and show acceptance remains rejected. |
| Capacity partition theft | Move one control scalar to the worker partition and show accounting/envelope failure. |
| Stale reviewer allocation | Reuse any observation, ledger/head, lease, decision, receipt, or controller head and show CAS rejection. |
| Churn exhaustion | Submit `maxChurns + 1` or reset remaining count and show plan head unchanged. |
| RED omission/substitution | Remove a hidden/edge test or replace command/result bytes and show promotion/acceptance failure. |
| Overfitting | Force a small-data win, leak train/eval or test data, peek repeatedly, vary replicates to hide instability, or degrade on held-out data and show the blocking review/acceptance failure. |
| Fence replay | Resubmit acceptance or alter one field after claim and show no second acceptance/refill. |
| Backlog starvation | Alter a queue key or omit a held task and show holdback/resume/fairness digest failure. |

The field-mutation test is one-field-at-a-time: mutate every field below while
all other bytes remain unchanged; the containing digest must change and the
validator/CAS must reject. Nested artifact mutation must also produce a
ref/receipt mismatch.

| Record | Fields covered by independent mutations |
| --- | --- |
| Scope/task | Every workflow/recipe/plan/graph/sidecar field; milestone name/ID/requirements/tasks/gates/evidence; each task ID/node/ordinal/dependency/frozen/effective/sidecar/unique digest; resolver refs/receipt; every protected baseline and input ref |
| Clock/time/integrity | Boundary kind/workflow/scope/epoch/state/lease heads; every monotonic observation field and clock ref/receipt; continuity; start/end/elapsed/restart/exclusions; evaluator/scorecard/completion; every integrity baseline/ref/boolean/receipt |
| Capacity/ledger | Request/clock/snapshot/cloud refs/receipt; every dimension/pool/value; ledger; partitions; all eight control scalars; unknown pools; verifier refs/receipt; draft/decision/envelope; state/revision |
| Efficiency/CAS | Allocation/task/attempt/execution/epoch; observation/sequence; ledger/head/lease/decision/receipt refs/digests; controller head; capacity refs; usage; next allocation; idempotency/result/next head/host receipt |
| Churn/RED | Churn/reason/evidence; prior/next plan/revisions/tasks; RED ref; expected head/epoch/ordinal/max/remaining; proposal/decision/receipt; every test command/input/exit/timeout/evidence/owner/hidden/runtime/mock field; every manifest/result field |
| Skills/overfitting | Every capability ID/source and derived required/built-in literal; skill content/dependency/snapshot/manifest refs/digests; capability-gap code/disposition; reviewer persona/lens/check IDs/dispositions/evidence/opaque hidden-holdout handles/authenticated resolver contexts/zero-authority literals; each of the five overfitting case IDs; review phase, blocking disposition, hidden-byte flag, and host receipt |
| Acceptance/fence | Acceptance/milestone/once-only/mode; scope/time/integrity; capacity/review/RED/gate/host evidence; decision/head/epoch/status/ordinal/receipt; every fence key/claim/sequence/ref/receipt |
| Holdback/order/resume | Recipe/scope/state/reason; queue head and every queued/held task; every priority/queuedAt/task/key; epoch/fence; before/after heads; resumed IDs; invocation args/count/receipt; nullable projection fields and ordinary bit |

The focused acceptance matrix is:

| ID | Acceptance |
| --- | --- |
| AR-16 | Resolver receipt, protected baseline, non-empty scope, bijective unique task bindings, and sidecar digest; one-field scope mutations fail. |
| AR-17 | Trusted monotonic start/end, zero exclusions, true-runtime evidence, restart continuity, and all five anti-cheat checks; shell cannot accept. |
| AR-18 | Exact K discovery/verifier/envelope calls, unknown-pool fail-closed behavior, every canonical pool component, partition sums, and envelope CAS. |
| AR-19 | Evidence-only reviewer and fresh observation/ledger/head/lease/decision/receipt/controller-head CAS; stale mutation fails. |
| AR-20 | Durable bounded typed churn CAS and executable RED manifest/results covering all 13 attacks and five overfitting cases; omission/mock/substitution fails. |
| AR-21 | Once-only acceptance/fence, complete backlog retention, exact queue keys, recovery, and one exact `scheduler.refill(workflowId, epochRef)`. |
| AR-22 | Priority-descending, queuedAt-ascending, task-ID tie-break, fairness, holdback, and null ordinary path match the existing scheduler. |
| AR-23 | Frozen task, journal, daemon, scheduler identity, and artifact-only compatibility classification remain unchanged. |
| AR-24 | Every field in the mutation table changes its containing digest and fails the relevant validator/CAS independently. |
| AR-25 | The closed required native set is exactly AutoResearch, MemPalace, and general memory; literal native/optional manifests reject caller-supplied booleans, durable snapshots/manifests survive recovery, optional Superpowers gaps are explicit, and skill output remains evidence-only. |
| AR-26 | The overfitting reviewer contract and binding contain all eight checks, zero authority, opaque host-only handles, authenticated resolver contexts, unauthorized-resolution/byte-exposure rejection, advisory exploration behavior, and blocking review before holdout, canary, independent review, promotion, milestone acceptance, and completion. |
| AR-27 | Non-gameable RED cases for small-data wins, leakage, repeated peeking, unstable variance, and held-out degradation fail promotion/acceptance; real A runtime/recovery coverage rejects missing, stale, mutated, or exposed review evidence. MemPalace proposals require and return a typed prior canonical commit and host receipt and reject decision/outcome/run-state records. |

For this documentation-only addendum, structural verification is:

```bash
cd /Users/nathanballou/Documents/GitHub/prime-agent
shasum -a 256 docs/superpowers/specs/2026-08-13-durable-workflows-design.md \
  docs/superpowers/specs/2026-08-13-native-methodology-design.md \
  docs/superpowers/specs/2026-08-13-autoresearch-design.md \
  docs/superpowers/specs/2026-08-13-knowledge-refinement-design.md \
  docs/superpowers/plans/2026-08-13-durable-workflow-kernel.md \
  docs/superpowers/plans/2026-08-13-durable-workflows-program.md
shasum -a 256 docs/superpowers/specs/2026-08-15-adaptive-workflow-recipes-design.md
marker='UNRESOLVED_SPEC''_MARKER'
rg -n "$marker" docs/superpowers/specs/2026-08-15-adaptive-workflow-recipes-design.md
awk 'BEGIN { fences=0 } /^```/ { fences++ } END { if (fences % 2 != 0) exit 1; print "fenced blocks:", fences }' docs/superpowers/specs/2026-08-15-adaptive-workflow-recipes-design.md
```

The marker scan must return no unresolved marker and the fence count must be
even. The six source hashes must equal the header pins. Future implementation
work must run AR-16 through AR-24, the existing focused recipe tests, the
K/A runtime matrix, and `npm run check` with logs; this document does not
claim those implementation tests have run.

## 22. Final addendum self-audit

The addendum was self-scanned after drafting. It has one K resolver, one K
capacity/envelope handshake, one existing adaptive controller/CAS, one
evidence-only reviewer, one typed bounded plan-churn CAS, one host-owned
executable RED manifest, one once-only acceptance fence, and one existing
scheduler. It introduces no journal event, daemon wire field, daemon version
change, `WorkflowTask` field, role authority, hidden-holdout choice, or
second scheduler. Every repeat path is bounded by an existing ceiling or an
explicit finite field (`maxChurns`, RED test/time limits, or the once-only
fence); no recipe loop or restart path is unbounded. The native dependency
gates for K/A/R/C are explicit implementation prerequisites; a missing gate,
opaque-handle authorization failure, hidden-byte exposure, caller-supplied
native capability boolean, or MemPalace commit/receipt mismatch blocks
acceptance with no fallback.

The worker-free shell and true-runtime continuity are explicitly distinct;
trusted clock start/end, anti-cheat evidence, capacity partitions, fresh CAS
inputs, RED results, host acceptance, holdback, resume, priority, fairness,
null ordinary behavior, canonical digest preimages, and field-by-field
mutation tests are normative. Any unknown, mismatched, stale, omitted, or
ambiguous artifact fails closed.
