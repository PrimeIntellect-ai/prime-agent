# Durable Knowledge, Refinement, and MemPalace Design

Date: 2026-08-13
Status: Approved by the user for implementation planning; implementation not started
Approval baseline SHA-256: 72b3b08a03a7168ee636d27d303a7911d4ea75a5d84962303386a6fc21c9639b
MemPalace source: `/Users/nathanballou/.claude/plugins/marketplaces/mempalace`
MemPalace version: 3.7.0
MemPalace source commit: `759b1273d3fc92721596938a57168b1314e77f41`
MemPalace license: MIT (Copyright (c) 2026 MemPalace Contributors)

## Approved clarification/addendum (2026-08-14)

This approved clarification supplements the 2026-08-13 knowledge/refinement
design. The original approval status and `Approval baseline SHA-256` above are
unchanged; this addendum does not authorize memory egress, index authority,
resource/cloud/spend expansion, or an unbounded refinement daemon.

The durable workflow's adaptive controller owns resource placement and observes
verified critical paths, evidence gaps, blockers, queue/throughput/latency,
marginal verified progress/resource, uncertainty, live leases, and control
reserve. The knowledge layer may record an accepted how/why/provenance lesson
about that evidence, but it cannot score progress, allocate a lease, approve a
workflow transition, or authorize an envelope/authority change. Optional
MemPalace remains a local index of committed canonical records only; it never
authorizes a memory, refinement, resource allocation, or completion.

After every workflow/methodology phase, incident, and completion gate, the
host queues a bounded improvement review. The proposal uses accepted evidence,
compares the current revision with baseline plus held-out, replay, or canary
cases, and receives independent Goodhart/regression/safety red-team review.
Only a compatible measurable revision passes one atomic canonical CAS with
reload and rollback metadata. Rejected, stale, unverified, or rolled-back
revisions are excluded from future runs; an explicit empty edit is valid.
Changing objective, scorecard, evaluator, authority, envelope, or scope is a
new exact user-approved decision, not a knowledge shortcut.

A recurring independent efficiency-red-team reviewer, `cron`, is a kernel
review role whose schedule, trusted clock/cadence, major-transition triggers,
exactly-once window, one-catch-up-after-restart rule, and bounded overhead
reserve are approved resource-envelope fields. It receives a fresh read-only
host-resolved snapshot of critical path, queues, leases, cost, latency,
verified progress, and evidence, then checks underuse, overuse, redundancy,
serializable work, context churn, verification starvation, review overhead,
cloud cost, and Goodhart risk. Its output is immutable evidence-backed
suggestions with zero write, lease, allocation, approval, or completion
authority. Applying a suggestion is a new full decision and approval; changing
the schedule is also a decision. Failed/late reviews do not block canonical
work, and raw suggestions are never knowledge authority.

The canonical ledger owns the durable how/why/provenance and revision history;
the outbox owns only projection work; MemPalace owns only its local index. The
first release is bounded to finite review/retry ceilings, local no-egress
semantic adapters, existing leases, and approved resource envelopes. It uses
hysteresis and minimum windows for any resource observation it displays and
fails closed on unknown capacity, stale observations, corrupt index state, or
ambiguous writer/lease recovery. No resident infinite loop or daemon wire
change is introduced.

## Summary

Prime Agent will make its continual harness the canonical local ledger for
small, typed, durable knowledge. Active entries are either independently
audited reusable how/why/procedure knowledge or exact user-confirmed durable
facts within their approved scope. Observations and legacy content remain
non-injected candidates until they pass that gate. The ledger remains useful
with no network, no optional plugin, and no vector index.

MemPalace 3.7.0 is an optional local-first semantic index for approved canonical
records. It is never the authority for a Prime Agent fact, procedure, scope, or
refinement. Prime Agent writes the canonical ledger first, then projects approved
records to a local MemPalace index through a durable outbox. Raw transcript/project
drawers are outside the first-release semantic path and remain explicit UI-only
material if they already exist. An absent, stale, corrupt, or disabled index cannot
erase or block valid canonical knowledge.

The design extends the existing `HarnessState`, `HarnessEntry`,
`planRefinement`, `applyRefinementProposal`, `RefinementResult`, and `refine`
skill boundaries. It does not create a second agent runtime and does not make
MemPalace a hidden cloud dependency. The current session-local/global split is
preserved, while scope, provenance, evidence, privacy, CAS, and authority are
made explicit.

The first-release prerequisite is an authority-preserving host bridge. Existing
Python harness and refinement paths become read-only immutable snapshots plus
typed host requests. They cannot mutate a state file, resolve or write a
canonical path, acquire a global lease, call an adapter, or apply a proposal.
`/refine` only emits a typed request; the host must run the complete decision
pipeline and CAS gate before any semantic write. A missing or unverified bridge
blocks the proposal rather than preserving a legacy write path.

Every semantic memory or refinement mutation invokes the kernel's finite
universal decision pipeline:

```text
recon -> independent lenses -> evidence verification -> synthesis
      -> fresh adversarial red team -> authority/scope host gate
      -> canonical CAS transaction -> index outbox
      -> optional adapter projection -> measured result
```

The red team is independent of the authoring context and receives the exact
proposal, evidence digests, current ledger digest, and authority request. It
must test one-off content, poisoning, privacy/secrets, duplication, scope, and
blast radius. Global writes require explicit user approval or a narrowly
scoped, user-preauthorized policy with an unexpired revision. The host, not the
model, decides whether a write is applied.

## Goals

The first release must:

1. Keep Prime Agent's canonical durable how/why/procedure ledger local and
   usable without MemPalace or a network.
2. Preserve the existing continual-harness entry kinds (`prompt`, `memory`,
   `skill`, and `subagent`) and refine scheduling contract while adding a
   typed knowledge projection.
3. Attach provenance, evidence references, content/state digests, authority,
   scope, retention, privacy classification, and supersession information to
   every durable knowledge record.
4. Reject one-off or unsupported automatic memories while permitting an
   explicitly user-requested durable fact after the same safety review; only
   audited or explicit user-confirmed records may become active or enter prompts.
5. Run a fresh independent red-team review for every memory/refine decision,
   including create, update, semantic delete, and rollback; no semantic write
   bypasses the review. Exact retention expiry is deterministic execution of a
   previously approved/red-teamed policy, not a new model decision.
6. Make global writes require exact user approval or an exact match to a
   separately user-approved, red-teamed, unexpired, unrevoked policy.
   Calling `global_=True` is a request for global scope, not approval by
   itself.
7. Serialize canonical writes, enforce compare-and-swap (CAS), make retries
   idempotent, and preserve before/after snapshots for safe rollback.
8. Keep MemPalace indexing optional, local-first, privacy-screened, and
   recoverable from its own local source data or from the canonical ledger.
9. Implement `direct`, `prefer`, and `require` routing without allowing a
   `require` operation to silently fall back to an unsafe direct writer.
10. Bound memory recall and prompt injection by scope, status, provenance, and
    hard token/entry limits.
11. Allow canonical operation in degraded mode when the semantic index is
    absent, unavailable, stale, or under repair, with visible status rather
    than an unsubstantiated success claim.
12. Run refinement only after verified milestones, repeated audited failures,
    final completion, or an explicit user request. Turn-interval and
    post-compaction review opportunities remain candidates, not permission to
    write noisy memories.
13. Require the `writing-skills` RED/GREEN/REFACTOR pressure-test cycle for a
    methodology or executable-skill change.
14. Provide inspect, approve, reject, forget, rollback, retention, routing,
    recall, and rebuild controls without posting or syncing data externally.
15. Produce measurable evidence of recall quality, write safety, privacy
    behavior, index health, CAS conflicts, and red-team coverage.

## Non-goals

The first release will not:

- treat a vector result, MemPalace drawer, knowledge-graph triple, model
  summary, or worker self-report as canonical evidence;
- upload canonical knowledge, transcripts, embeddings, secrets, or evidence to
  a cloud service;
- add cloud capacity merely because a memory or index operation is slow;
- store credentials, API keys, access tokens, cookies, private keys, or their
  reversible encodings in either the ledger or the optional index;
- automatically promote every conversation, tool result, or successful turn
  into durable knowledge;
- rewrite the immutable Prime Agent base system prompt;
- let a child session write the global ledger directly;
- use a direct ChromaDB writer beside a writable MemPalace daemon or MCP HTTP
  owner;
- repair an index by re-mining source transcripts when the local index's
  SQLite source can be rebuilt;
- run raw MemPalace transcript/project mining in the first release; existing
  raw drawers, if present, remain explicit display-only material and never
  enter prompts or canonical authority;
- silently delete newer knowledge during rollback;
- infer user approval from a model-authored phrase, a metadata flag, or a
  stale approval token; or
- change daemon wire commands/events in the knowledge layer's first release.

Product workflows may ask the user for approved cloud capacity for unrelated
execution work. That approval does not authorize memory egress. Memory and
the index remain local unless a separate, explicit memory-sharing authority is
introduced later; this implementation has no such path. All knowledge/refinement
proposers, verifiers, red teams, evidence reads, canonical writes, adapter calls,
and recall operate locally with `egress = none`. If a requested knowledge decision
cannot run locally, it blocks without sending content to a remote model. The
first release admits semantic model calls only through host-registered proposer,
verifier, and red-team adapters that have a verified local/no-egress capability.
An arbitrary provider helper, caller-supplied model client, or unverified local
adapter is rejected before it receives proposal or evidence content. The host
enforces a deny-by-default network trap around the semantic pipeline and records
the adapter identity and trap result; a connection attempt is a blocked
decision, not a degraded success. Every source/evidence field is scanned and
redacted before it is put into any proposer, verifier, or red-team input, and
every derived model input is screened again after transformation.

## Design principles

### Authority before convenience

The canonical ledger is the only source used to assert that Prime Agent has a
durable how/why/procedure lesson. MemPalace is a semantic index of canonical
projections. If its result conflicts with the ledger, the ledger wins and the
conflict is shown to the user or passed to verification.

### Evidence before persistence

A proposal may contain a useful observation, but only evidence with a stable
digest can support durable state. Evidence is bounded and local. A missing or
changed evidence reference lowers trust and prevents new promotion; it does
not get replaced by a model assertion.

### Explicit blast radius

Every record says where it can be read, how long it is retained, who/what
authorized it, and whether it can affect future prompts. The default is the
smallest useful session scope. Global is exceptional.

### Deterministic host gate

LLM calls propose and red-team. Deterministic host code validates schemas,
secret policy, scopes, digests, duplicate keys, CAS, leases, and transaction
ordering. A model cannot mark its own proposal accepted.

### Recall is question-driven

Do not search an index reflexively on greenfield work. Search the canonical
ledger, then the optional index, when the question concerns past work,
people, projects, decisions, preferences, or historical evidence. If a
required recall source is unavailable, report that fact instead of guessing.

### Local degradation is safe

The canonical ledger, normal sessions, and ongoing work continue when an
optional embedding/index process fails. Index lag, degraded reads, rejected
projections, and repair state remain visible and are never reported as
complete indexing.

## Existing mechanisms and integration boundaries

The implementation uses the current architecture at these boundaries:

- `packages/coding-agent/src/core/refinement/refinement.ts` remains the
  planner, validator, state loader, proposal applicator, refinement history,
  baseline-state conflict check, and rollback entry point.
- `HarnessState` remains a read-only materialized compatibility snapshot
  containing prompt, memory, skill, and subagent records. The new hash-chained
  canonical mutation journal is authoritative; `HarnessState` is
  deterministically regenerated at an exact committed journal sequence and
  never outranks it. This is one logical ledger with a derived snapshot, not
  competing databases. Legacy snapshot contents are never read by the prompt
  builder: they can affect a prompt only through a committed, typed canonical
  projection that passes active status, scope, privacy, retention, digest, and
  evidence-freshness checks.
- `HarnessEntry` remains the compatibility envelope with `id`, `kind`,
  `title`, `content`, `path`, `scope`, `reference`, `arguments`, `metadata`,
  timestamps, and version. New durable records carry a validated `knowledge`
  metadata object; legacy records are readable but are not globally promoted
  until provenance and scope are classified.
- `RefinementProposal` remains model output. Its edits are candidates and do
  not include host approval. Native and AutoResearch how/why/procedure outputs
  both adapt to the shared `KnowledgeMutationProposal` contract; neither gets
  a private writer or decision path. Prompt, skill, and reusable-role changes
  use the separate typed methodology envelope and writing-skills gate, then
  enter the same host-owned refinement transaction. The host adds a decision
  envelope and red-team result before applying.
- `applyRefinementProposal` remains the semantic edit primitive but runs only
  inside the single serialized journal transaction after all-or-nothing
  preflight/CAS. Partial application is not a valid committed transaction.
- `RefinementResult` and `prime-agent.refinement` custom entries remain the
  user-visible audit trail. They gain decision, digest, authority, red-team,
  and projection status through additive fields or a referenced local audit
  artifact.
- `AgentSession` remains the owner of the session-local writer, kernel host
  bridge, refine scheduling, prompt rebuild, session custom entries, and
  result events.
- `rlm.harness.*` remains a read-only snapshot and typed host-request bridge.
  Python code never edits `harness_state.json`, resolves canonical state paths,
  acquires a store/global lease, mutates local or global state, invokes an
  adapter, or applies a proposal. Kernel code never edits `harness_state.json`
  directly and never becomes a competing writer. An untyped or direct legacy
  request is rejected before the decision pipeline.
- `refine.run()` keeps its deferred turn-boundary behavior. A scheduled call
  means that a proposal/review is queued; it never means that a write already
  happened.
- The current `turn_interval` and `compact` auto-refine settings remain
  review opportunities. The new host gate requires an approved trigger and
  evidence before a semantic write.
- Session artifacts hold local state beside the current `harness/harness_state.json`.
  Global state remains under the Prime Agent agent directory. Exact paths are
  resolved by `getLocalHarnessStateDir()` and `getGlobalHarnessStateDir()`.
- MemPalace 3.7.0 is called through an optional adapter/CLI/MCP boundary. The
  canonical host must not import MemPalace's database internals into the
  required Prime Agent path.

Workflow project profiles, execution preferences, continuity capsules, worker
handoffs, and progress views are control-plane settings or derived session
projections, not canonical how/why/procedure knowledge. They cannot enter this
ledger merely because a workflow paused or a context ended. Conversely,
MemPalace route names `direct|prefer|require` govern only the optional local
index writer; they never select a workflow execution profile or grant effect
authority.

The workflow store and knowledge store are separate store instances with
separate namespaces, journals, leases, snapshots, and reducer instances. Both
instances use the same generic durable-store reducer implementation and the same
host decision/validation/CAS primitive and fencing rules; they do not share one
journal or one mutable reducer state. A workflow event may request a knowledge
mutation through the typed bridge, but workflow state is never reduced into
knowledge state and a knowledge commit cannot mutate workflow state implicitly.

## Architecture

```text
                         ┌─────────────────────────┐
                         │  user / workflow event  │
                         └────────────┬────────────┘
                                      │ candidate
                                      v
┌───────────────┐  read  ┌─────────────────────────────┐
│ canonical     │<───────│ typed ledger + audit journal │
│ ledger        │        │ (Prime Agent authority)      │
└───────┬───────┘        └──────────────┬──────────────┘
        │ commit first                  │ append outbox
        v                               v
┌───────────────┐                ┌───────────────┐
│ durable index │                │ optional local │
│ outbox        │───────────────>│ MemPalace 3.7 │
└───────────────┘                │ adapter/index │
                                 └──────┬────────┘
                                        │ bounded recall only
                                        v
                              ┌─────────────────────┐
                              │ prompt recall with  │
                              │ provenance/limits   │
                              └─────────────────────┘
```

There are two independent persistence planes:

1. The Prime Agent plane contains typed records, audit decisions, evidence
   digests, tombstones, state snapshots, and the index outbox. It is the
   authority and must stay local.
2. The MemPalace plane contains canonical-projection drawers, metadata,
   embeddings, and its own local SQLite/vector index. It is a derived recall
   surface. Its own knowledge graph (`entities`, `triples`, and `attributes`)
   is also derived and non-authoritative. Pre-existing raw drawers live in a
   separate UI-only namespace that semantic recall never queries.

Canonical commit precedes any adapter submission. An adapter failure therefore
creates index lag, not loss of the durable lesson. A canonical write failure
never gets reported as an index-only success.

## Typed canonical ledger

### Knowledge kinds

The durable knowledge vocabulary is deliberately small:

| Kind | Meaning | Minimum evidence | Typical storage |
| --- | --- | --- | --- |
| `how` | A verified way to accomplish or diagnose a task | observable result or user-confirmed fact | `memory` record with `knowledge.kind = "how"` |
| `why` | A durable reason, tradeoff, constraint, or decision behind a behavior | decision evidence and affected scope | `memory` record with `knowledge.kind = "why"` |
| `procedure` | A repeatable ordered method with inputs, outputs, and checks | two audited uses, or explicit user-authored method | `memory` record, or executable `skill` with the same kind |

An executable Python procedure remains a `skill` record because the current
harness requires a `reference` and `arguments` contract. Its typed knowledge
projection is still `procedure`; it does not become a new runtime. A prose
procedure uses a `memory` record and must not pretend to be callable.

Prompt notes and subagent specifications remain valid harness artifacts but
are not automatically promoted as canonical knowledge. A prompt note can
reference a knowledge entry; a subagent spec can consume one. Both remain
subject to their existing refinement rules and the same provenance/authority
gate when persisted globally.

### Typed record contract

The following is the logical contract. Field names are intentionally compatible
with existing `HarnessEntry` names; implementation may store the nested
objects in `metadata` while the schema migration is staged.

```ts
type KnowledgeKind = "how" | "why" | "procedure";
type KnowledgeContentStatus = "active" | "superseded";
type KnowledgeTombstoneStatus = "redacted" | "tombstoned";
type KnowledgeScope = "session" | "workspace" | "user";
type PrivacyClass = "public" | "internal" | "private" | "restricted";
type RetentionClass = "session" | "until-superseded" | "indefinite";
type Confidence = "audited" | "user-confirmed";
type KnowledgeTombstoneReason =
  | "user-forgotten"
  | "retention-expired"
  | "superseded"
  | "secret-detected"
  | "scope-revoked"
  | "corrupt-source"
  | "rollback"
  | "import-rejected";

interface KnowledgeProcedure {
  inputs: Record<string, string>;
  steps: string[];
  successChecks: string[];
  failureChecks: string[];
  callable?: {
    reference: HarnessEntry["reference"];
    arguments: HarnessEntry["arguments"];
    executionEvidence: EvidenceRef[];
    pressureEvidence: EvidenceRef[];
  };
}

interface KnowledgeContentRecord {
  id: string;                         // existing stable harness id
  kind: KnowledgeKind;
  title: string;
  statement: string;                  // one bounded reusable lesson
  procedure?: KnowledgeProcedure;
  scope: KnowledgeScope;
  workspace?: WorkspaceBinding;
  status: KnowledgeContentStatus;
  confidence: Confidence;
  provenance: Provenance;
  binding: KnowledgeRecordBinding;
  recordMode: KnowledgeRecordMode;
  policyResolutionRef: WorkflowArtifactRef | null;
  evidence: EvidenceRef[];
  contentDigest: string;               // SHA-256 canonical form
  sourceDigest: string;                // digest of normalized source evidence
  supersedes?: string[];
  supersededBy?: string;
  retention: { class: RetentionClass; expiresAt?: string };
  privacy: { class: PrivacyClass; secretScan: "passed" | "blocked" };
  taskValueCertificateRef: WorkflowArtifactRef | null;
  taskValueCertificateDigest: string | null;
  taskId: string | null;
  attemptId: string | null;
  resourceLeaseRef: WorkflowLeaseRef | null;
  ownershipLeaseRef: WorkflowLeaseRef | null;
  sourceAdaptiveObservationRefs: readonly WorkflowArtifactRef[];
  sourceAdaptiveReviewRefs: readonly WorkflowArtifactRef[];
  hostValidationRef: WorkflowArtifactRef;
  createdAt: string;
  updatedAt: string;
  entryGeneration: number;
}

interface KnowledgeTombstoneRecord {
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  workspace?: WorkspaceBinding;
  status: KnowledgeTombstoneStatus;
  reason: KnowledgeTombstoneReason;
  deletionFingerprint: string;     // HMAC; never a raw protected digest
  supersededBy?: string;
  retention: { class: RetentionClass; expiresAt?: string };
  createdAt: string;
  updatedAt: string;
  entryGeneration: number;
}

type KnowledgeRecord = KnowledgeContentRecord | KnowledgeTombstoneRecord;

interface KnowledgeCandidateProposal {
  candidateId: string;
  source: "automatic" | "legacy" | "user" | "import_candidate";
  sourcePrincipal: StablePrincipalRef;
  sourceAuthorityRef?: DurableDecisionRef;
  binding: KnowledgeRecordBinding;
  recordMode: KnowledgeRecordMode;
  proposedKind: KnowledgeKind;
  proposedTitle: string;
  proposedStatement: string;
  proposedProcedure?: KnowledgeProcedure;
  requestedScope: KnowledgeScope;
  evidence: EvidenceRef[];
  sourceDigest: string;
  decisionScopeId: string;
  artifactRef: WorkflowArtifactRef;
  taskValueCertificateRef: WorkflowArtifactRef | null;
  taskValueCertificateDigest: string | null;
  taskId: string | null;
  attemptId: string | null;
  resourceLeaseRef: WorkflowLeaseRef | null;
  ownershipLeaseRef: WorkflowLeaseRef | null;
  sourceAdaptiveObservationRefs: readonly WorkflowArtifactRef[];
  sourceAdaptiveReviewRefs: readonly WorkflowArtifactRef[];
  hostValidationRef: WorkflowArtifactRef | null;
  policyResolutionRef: WorkflowArtifactRef | null;
  createdAt: string;
}

type KnowledgeMutationAction =
  | {
      action: "create";
      kind: KnowledgeKind;
      id: string;
      title: string;
      statement: string;
      procedure?: KnowledgeProcedure;
    }
  | {
      action: "update";
      kind: KnowledgeKind;
      id: string;
      expectedGeneration: number;
      expectedContentDigest: string;
      title?: string;
      statement?: string;
      procedure?: KnowledgeProcedure;
    }
  | {
      action: "delete";
      kind: KnowledgeKind;
      id: string;
      expectedGeneration: number;
      expectedContentDigest: string;
      reason: KnowledgeTombstoneReason;
    };

interface KnowledgeMutationProposal {
  proposalId: string;
  trigger:
    | "verified_milestone"
    | "repeated_audited_failure"
    | "completion_audit"
    | "explicit_user_request"
    | "legacy_import";
  requestedScope: KnowledgeScope;
  workspaceId?: string;
  privacyClass: PrivacyClass;
  binding: KnowledgeRecordBinding;
  recordMode: KnowledgeRecordMode;
  policyResolutionRef: WorkflowArtifactRef | null;
  retention: { class: RetentionClass; expiresAt?: string };
  baselineDigest: string;
  evidence: EvidenceRef[];
  actions: KnowledgeMutationAction[];
  expectedOutcome: string;
  decisionRef?: DurableDecisionRef;
  taskValueCertificateRef: WorkflowArtifactRef | null;
  taskValueCertificateDigest: string | null;
  taskId: string | null;
  attemptId: string | null;
  resourceLeaseRef: WorkflowLeaseRef | null;
  ownershipLeaseRef: WorkflowLeaseRef | null;
  sourceAdaptiveObservationRefs: readonly WorkflowArtifactRef[];
  sourceAdaptiveReviewRefs: readonly WorkflowArtifactRef[];
  hostValidationRef: WorkflowArtifactRef | null;
}
```

Native and AutoResearch how/why/procedure learning are producers, not
authorities. Each producer adapter maps its untrusted output into this same
`KnowledgeMutationProposal` shape, preserving the original artifact reference
and leaving authority, provenance, evidence freshness, and decision fields for
the host to assign. A prompt, skill, or reusable-role methodology artifact uses
the separate typed methodology envelope and cannot use the ordinary knowledge
path; it requires the RED/GREEN/REFACTOR evidence below.

The host validates the following invariants:

- `statement` is non-empty, bounded, and contains one claim or one procedure,
  not a transcript or unbounded task history.
- `procedure` is present for an executable method and includes inputs,
  ordered steps, and success/failure checks. An absent procedure is not
  silently treated as callable. A `callable` user-confirmed procedure also
  requires independent execution evidence and independent pressure evidence;
  user confirmation alone can activate only declarative how/why content (or a
  non-callable prose procedure). The callable reference is withheld until
  those evidence references pass the normal freshness and secret checks.
- `scope = workspace` carries a host-assigned stable workspace ID and an
  optional normalized path prefix. Workspace state digests remain decision
  evidence, not identity. A record cannot be promoted to another workspace by
  changing a display path, moving the checkout, or supplying a different root.
- `scope = user` is cross-workspace and requires global authority. It cannot
  contain project-only paths or private project facts unless the user
  explicitly approves that blast radius.
- `contentDigest` covers canonicalized kind, title, statement, procedure,
  scope, workspace binding, and privacy class. It excludes timestamps and
  mutable index metadata.
- `sourceDigest` covers the exact redacted evidence set used for the decision.
  Adding, removing, or changing evidence changes the proposal digest and
  requires a new decision.
- Before retaining any candidate, content, revision, or evidence record, the
  host resolves `taskValueCertificateRef` and its digest, `taskId`/
  `attemptId`, resource and ownership lease refs, source adaptive observation
  and review refs, and `hostValidationRef` against the current journal and
  approved revision registry. Missing, mismatched, stale, or revoked
  certificates, leases, source reviews, or validation artifacts are rejected;
  active content must carry a non-null host validation artifact. Only the
  validated record and pinned source bytes may enter canonical retention or an
  index projection. `recordMode`, `provenance.branch`, and `binding` are closed
  discriminated
  records and their fields must mirror the top-level typed refs. The
  `authority.kind:"preauthorized-policy"` branch additionally requires the
  host to dereference and rehash the exact `policyRef.registryEntryRef` and
  `registryEntryId` at `policyRef.registryEpoch`, require
  `registryStatus:"approved"`, and match policy kind, scope, privacy,
  blast-radius, compatibility closure, expiry, and exact `DurableDecisionRef`
  fields against a current `WorkflowRevisionResolution`. Its
  `policyResolutionRef` must carry a fresh resolver CAS proof for the
  operation; stale, replayed, superseded, revoked, rolled-back, or
  kind/scope-mismatched proof rejects admission, recall, and effects. No
  policy field or scope can widen authority beyond the separately approved
  decision. On a content record the top-level `policyResolutionRef` must
  equal the preauthorized authority's resolver reference, and it is null for
  the closed non-policy authority branches. Candidate, mutation, evidence,
  and revision records use the same rule: a preauthorized policy requires a
  non-null matching resolver reference, while an ordinary or user-explicit
  branch carries null. The
  `user_confirmed` ordinary declarative branch requires a host-validated
  principal and approval plus null task, attempt, resource/ownership lease, and
  adaptive-source refs; it may retain a declarative fact with user-assertion
  evidence. `audited_procedure`, `callable_procedure`, and `adaptive` branches
  require non-null task-value certificate, task/attempt, resource/ownership
  leases, host validation, and independent evidence; adaptive records also
  require non-empty adaptive observation and review refs. No branch may be
  inferred from a nullable field or model-supplied provenance.
- `status = active` requires `confidence = audited` plus independent verifier
  lineage, or `confidence = user-confirmed` with an exact user authority record.
  An observed candidate or legacy entry is never active or injected. The
  `user_confirmed` branch does not waive the callable-procedure
  execution and pressure-evidence requirement; callable/procedure branches
  retain their mandatory binding and evidence fields.
- `status = superseded` points to a replacement; it is not silently deleted.
- `status = redacted` is represented only by `KnowledgeTombstoneRecord`, which
  cannot carry title, statement, procedure, excerpts, protected content, or a
  raw content/source digest. Its closed `reason` enum is the only deletion
  classification, and `deletionFingerprint` is an opaque host-keyed HMAC.
- `entryGeneration` is the single monotonic generation for an entry ID across
  active content, supersession, tombstone, snapshot, outbox, and adapter
  projection. The compatibility `HarnessEntry.version`, if present, mirrors
  this value and is not a second counter. A tombstoned generation suppresses
  resurrection from queued index work or stale snapshots.
- Legal transitions are `active -> superseded`, `active|superseded ->
  redacted|tombstoned`, and a new record generation after an explicit create.
  Direct tombstone resurrection, supersession cycles, scope widening, and
  generation reuse are rejected.

Every `actions` array is evaluated against an immutable clone of the exact
baseline. The host validates and applies all actions to that clone, then
performs one CAS replacement of the canonical state. If any action is invalid,
stale, secret-bearing, unauthorized, or conflicted, the clone is discarded and
the transaction commits zero edits, zero versions/generations, and zero outbox
events. There is no edit-by-edit partial application.

### Legacy mapping

Existing entries are interpreted as follows:

| Existing record | Typed projection | Promotion rule |
| --- | --- | --- |
| `memory` | `how`, `why`, or prose `procedure` based on explicit metadata | legacy records are read-only until classified and provenance is attached |
| `skill` with valid Python reference/arguments | `procedure` | must pass executable pressure tests before methodology promotion |
| `prompt` | no automatic knowledge kind | may reference a knowledge ID; global prompt changes need the same gate |
| `subagent` | no automatic knowledge kind | may be retained as a reusable role, but is not a how/why/procedure claim |

The migration must not invent evidence for old entries. It may publish a
non-injected `KnowledgeCandidateProposal` decision artifact with
`source = "legacy"`, the stable source principal, and the original content digest, then require a
fresh audit before any active typed record is created. Candidate proposals are
outside `KnowledgeRecord`, `HarnessState`, prompt injection, and index
projection. The migration cannot mark an unverified legacy record `audited`
solely because it loaded successfully. Legacy import is fail-closed: parse,
schema, path, digest, or secret-scan failure preserves the original source,
quarantines the import, and publishes no candidate or partial record. It never
falls back to an empty state or allows a damaged snapshot to influence a
prompt. A repair or retry must explicitly select a valid source before a new
typed request is emitted.

### Procedure versus methodology

A procedure describes what to do for a narrow, verified task. A methodology
changes how Prime Agent reasons or executes across tasks. Methodology changes
have a larger blast radius and therefore require all of:

1. an explicit `procedure`/skill change proposal;
2. a fresh independent red team;
3. `writing-skills` RED/GREEN/REFACTOR pressure tests;
4. a user approval or matching preauthorized methodology policy; and
5. a post-change verification run in a fresh context.

The knowledge ledger must not turn a one-off successful command into a global
methodology rule.

## Provenance and evidence

### Provenance contract

```ts
type KnowledgePolicyKind =
  | "retention"
  | "recall"
  | "prompt_projection"
  | "preauthorization"
  | "refinement"
  | "methodology";
type KnowledgePolicyScope =
  | "session"
  | "workflow"
  | "workspace"
  | "user"
  | "global";
type KnowledgePolicyBlastRadius =
  | "record"
  | "session"
  | "workflow"
  | "workspace"
  | "user"
  | "global";
type KnowledgePolicyRegistryStatus = "approved" | "superseded" | "revoked";

interface KnowledgePolicyRef {
  policyId: string;
  revision: number;
  registryEntryId: string;
  registryEntryRef: WorkflowArtifactRef;
  registryEpoch: number;
  registryStatus: KnowledgePolicyRegistryStatus;
  policyKind: KnowledgePolicyKind;
  scope: KnowledgePolicyScope;
  privacyClass: PrivacyClass;
  blastRadius: KnowledgePolicyBlastRadius;
  compatibilityClosure: WorkflowRevisionCompatibilityClosure;
  decisionRef: DurableDecisionRef;
  policyDigest: string;
  expiresAt: string;
  revocationEpoch: number | null;
  revocationEventSequence: number | null;
  rollbackOfRevisionId: string | null;
  rollbackEventSequence: number | null;
  resolverProofRef: WorkflowArtifactRef;
}

interface StablePrincipalRef {
  principalId: string;               // host-issued, opaque, stable identifier
  kind: "user" | "workspace";
  issuer: "local-host";
}

type KnowledgeAuthority =
  | {
      kind: "user-explicit";
      principal: StablePrincipalRef;
      artifactRef: WorkflowArtifactRef;
      policyRef?: never;
      policyResolutionRef?: never;
      authorityDigest: string;
    }
  | {
      kind: "preauthorized-policy";
      principal: StablePrincipalRef;
      artifactRef: WorkflowArtifactRef;
      policyRef: KnowledgePolicyRef;
      policyResolutionRef: WorkflowArtifactRef;
      registryCasExecutionKey: string;
      authorityDigest: string;
    }
  | {
      kind: "local-auto" | "legacy";
      principal: StablePrincipalRef;
      artifactRef: WorkflowArtifactRef;
      policyRef?: never;
      policyResolutionRef?: never;
      authorityDigest: string;
    };

interface KnowledgePolicyResolution {
  policyRef: KnowledgePolicyRef;
  registryEntryRef: WorkflowArtifactRef;
  registryEntryId: string;
  expectedRegistryEpoch: number;
  observedRegistryEpoch: number;
  registryStatus: "approved";
  compatibilityClosureDigest: string;
  revocationEpoch: number | null;
  revocationEventSequence: number | null;
  rollbackOfRevisionId: string | null;
  rollbackEventSequence: number | null;
  casExecutionKey: string;
  operation: "admission" | "recall" | "effect";
  hostVerified: true;
  resolutionDigest: string;
}

interface WorkspaceBinding {
  workspaceId: string;               // host-issued identity, not a path hash
  identityDigest: string;             // host proof for this workspace binding
  pathPrefix?: string;                // read boundary only, never identity
}

type KnowledgeRecordMode = "ordinary" | "adaptive";

type KnowledgeRecordBinding =
  | {
      mode: "ordinary";
      kind: "user_confirmed";
      declarative: true;
      principal: StablePrincipalRef;
      approvalRef: DurableDecisionRef;
      hostValidationRef: WorkflowArtifactRef;
      taskValueCertificateRef: null;
      taskValueCertificateDigest: null;
      taskId: null;
      attemptId: null;
      resourceLeaseRef: null;
      ownershipLeaseRef: null;
      sourceAdaptiveObservationRefs: readonly [];
      sourceAdaptiveReviewRefs: readonly [];
      requiredEvidenceKind: "user-assertion";
      bindingDigest: string;
    }
  | {
      mode: "ordinary";
      kind: "audited_procedure" | "callable_procedure";
      principal: StablePrincipalRef;
      approvalRef: DurableDecisionRef;
      hostValidationRef: WorkflowArtifactRef;
      taskValueCertificateRef: WorkflowArtifactRef;
      taskValueCertificateDigest: string;
      taskId: string;
      attemptId: string;
      resourceLeaseRef: WorkflowLeaseRef;
      ownershipLeaseRef: WorkflowLeaseRef;
      sourceAdaptiveObservationRefs: readonly [];
      sourceAdaptiveReviewRefs: readonly [];
      requiredEvidenceKind: "audit" | "test" | "command";
      bindingDigest: string;
    }
  | {
      mode: "adaptive";
      kind: "adaptive";
      principal: StablePrincipalRef;
      approvalRef: DurableDecisionRef;
      hostValidationRef: WorkflowArtifactRef;
      taskValueCertificateRef: WorkflowArtifactRef;
      taskValueCertificateDigest: string;
      taskId: string;
      attemptId: string;
      resourceLeaseRef: WorkflowLeaseRef;
      ownershipLeaseRef: WorkflowLeaseRef;
      sourceAdaptiveObservationRefs: readonly [WorkflowArtifactRef, ...WorkflowArtifactRef[]];
      sourceAdaptiveReviewRefs: readonly [WorkflowArtifactRef, ...WorkflowArtifactRef[]];
      requiredEvidenceKind: "audit" | "test" | "command";
      bindingDigest: string;
    };

type KnowledgeProvenanceBranch = KnowledgeRecordBinding;

interface Provenance {
  source: "user" | "workflow" | "tool" | "test" | "refine" | "legacy";
  sessionId?: string;
  workflowId?: string;
  turnId?: string;
  messageId?: string;
  refinementId?: string;
  sourcePath?: string;
  sourceDigest?: string;
  authoredAt: string;
  observedAt: string;
  authorLabel: string;              // bounded, non-secret display label
  authority: KnowledgeAuthority;
  authoringContextId: string;
  verifierContextId?: string;
  decisionRef: DurableDecisionRef;
  branch: KnowledgeProvenanceBranch;
}

interface EvidenceRef {
  id: string;
  kind: "test" | "command" | "artifact" | "user-assertion" | "audit" | "index-drawer";
  uri: string;                      // local relative path or redacted session ref
  digest: string;
  excerpt?: string;                 // redacted and bounded; never a secret
  command?: string;
  exitCode?: number;
  capturedAt: string;
  verifier?: string;
  scope: KnowledgeScope;
  redacted: boolean;
  taskValueCertificateRef: WorkflowArtifactRef | null;
  taskValueCertificateDigest: string | null;
  taskId: string | null;
  attemptId: string | null;
  resourceLeaseRef: WorkflowLeaseRef | null;
  ownershipLeaseRef: WorkflowLeaseRef | null;
  sourceAdaptiveObservationRefs: readonly WorkflowArtifactRef[];
  sourceAdaptiveReviewRefs: readonly WorkflowArtifactRef[];
  hostValidationRef: WorkflowArtifactRef | null;
  policyResolutionRef: WorkflowArtifactRef | null;
  binding: KnowledgeRecordBinding;
  recordMode: KnowledgeRecordMode;
}
```

Evidence must be immutable once referenced. Large command output and
transcript fragments live in local evidence artifacts; the ledger stores only
bounded excerpts, relative references, and digests. Evidence files use private
permissions, atomic publication, and content-addressed names. A later read
recomputes the digest before treating evidence as current.

All provenance, authority, context lineage, decision, verifier, scope, and
policy fields are populated or overwritten by the host. Model-supplied values
for those fields are untrusted proposal data. The closed `KnowledgeRecordBinding`
is the host-owned ordinary/adaptive discriminator: a user-confirmed
declarative fact may have null workflow task/lease refs only in its exact branch,
while procedures, callables, and adaptive records retain required evidence and
lease/certificate bindings. Evidence URIs resolve beneath a
host-selected evidence root using normalized real paths with no `..`, absolute
path, or symlink escape. Active evidence is retained while any current record
references it; deletion or expiry transactionally marks dependents stale before
garbage collection. A MemPalace drawer cannot be the sole evidence for a
canonical claim unless its source bytes are verified against a canonical local
artifact.

The proposal and gate distinguish:

- `candidate-observed`: source exists and matches its digest, but no
  independent audit has confirmed the lesson; it remains outside active
  canonical records and prompt injection;
- `audited`: an independent verifier checked the evidence and the lesson's
  scope/meaning;
- `user-confirmed`: the user directly supplied or confirmed the durable
  statement. This is authoritative for the user's stated preference or fact,
  but it is not evidence that an executable procedure works.

A model's rationale, a worker's final message, a successful-looking output,
or a prior memory are not sufficient evidence by themselves. They can be
inputs to a fresh audit.

### Digest rules

The host uses one canonical JSON serialization: UTF-8, sorted object keys,
normalized line endings, no timestamps or local absolute paths in the content
digest, and explicit empty arrays/objects. It computes:

- `sourceDigest`: SHA-256 of the ordered, redacted evidence references and
  their referenced bytes;
- `contentDigest`: SHA-256 of the typed entry's semantic fields;
- `proposalDigest`: SHA-256 of action, target IDs, proposed after-values,
  source digest, requested scope, and expected outcome;
- `baselineDigest`: SHA-256 of the target ledger state read before authoring;
- `decisionDigest`: SHA-256 of proposal, baseline, red-team verdict,
  authority token, and policy revision;
- `ledgerDigest`: SHA-256 of the committed canonical state snapshot plus
  committed journal sequence.

Changing any semantic field, evidence, scope, authority, or merge behavior
creates a new proposal/decision revision and requires a new red-team pass.
Changing only an index cursor or retry timestamp does not.

## Scope, retention, privacy, and secrets

### Scope hierarchy

The public user model is:

| Scope | Storage | Default | Read audience | Global authority |
| --- | --- | --- | --- | --- |
| `session` | session artifact `harness/` | yes for automatic refine | current root session and its permitted children | no; local host gate |
| `workspace` | global harness store, bound to a stable host workspace ID; current root digest is evidence only | no | sessions in that workspace | explicit approval or preauthorized workspace policy |
| `user` | global harness store | no | user-approved workspaces | explicit approval only or narrowly preauthorized user policy |

The existing `HarnessScope` values `local` and `global` remain the storage
compatibility layer: `session` maps to `local`; `workspace` and `user` map to
`global` and carry a typed scope class in metadata. A local entry can shadow a
global entry for the current session without editing or deleting the global
record. A global record cannot be updated by a local refinement proposal.

The host maintains stable workspace IDs and, for user-scoped records, an
explicit allowed-workspace set or `all-user-workspaces` grant bound to the
authorizing user identity. Scope checks use that identity and a fixed lattice:
`session <= workspace <= user`; children may narrow but never widen it. Index
wing/room labels are derived from these IDs and are never accepted as identity
evidence on recall.

`principalId` is a host-issued opaque identity bound to the authenticated local
user or workspace owner; it is not a session ID, display label, model claim, or
filesystem path. `workspaceId` and its `identityDigest` come from a host-owned
workspace identity record and remain stable when a checkout moves. A copied,
unbound, or path-only workspace fails identity verification and cannot read or
write the original workspace scope. Approval tokens, leases, evidence, and
audit records bind the stable principal and workspace identity, not the path
that happened to be used for one invocation.

Children inherit read scope but cannot widen it. A child may write only an
attempt-local artifact; the root decides whether the result becomes a
session/workspace/user entry.

### Retention

Retention is explicit on every accepted entry:

- `session`: retain until the session artifact is deleted or the configured
  session retention window expires. Session cleanup writes a tombstone/index
  delete before removing the content when an index is enabled.
- `until-superseded`: retain the old entry as a non-injected audit/tombstone
  record after a verified replacement is accepted. It remains available for
  rollback and conflict inspection.
- `indefinite`: user or preauthorized policy may retain a workspace/user
  lesson until the user forgets it. Indefinite does not mean immutable.

An expired record is not injected and is not projected during rebuild. The
ledger retains a minimal deletion/tombstone record for the configured rollback
horizon so old outbox work cannot resurrect it. Retention cleanup is
deterministic host execution only when the exact expiry, scope, tombstone
horizon, and projection generation barrier were included in the approved
record. Any discretionary early delete, retention change, or scope effect is a
new semantic decision and receives the universal pipeline. Tombstones remain
until all older outbox generations and retry keys have expired or been
acknowledged impossible.

### Privacy classes

- `public`: safe for the declared scope and intended for indexing if the user
  enabled the adapter.
- `internal`: local project/process information; never sent to a remote
  backend by this design.
- `private`: personal preferences or private project details; user scope
  requires explicit approval and is not indexed by default.
- `restricted`: sensitive information, regulated data, or content whose
  audience is narrower than the current session; it stays session-local and
  is not sent to MemPalace.

The privacy class is ordered from widest to narrowest audience as
`public < internal < private < restricted`. Deterministic projection may only
preserve a class or move rightward to a narrower class. Any leftward move is a
privacy downgrade and requires a new exact semantic decision plus explicit user
approval; the host never infers one. `restricted` has no projection to the
optional index in this release, even under user approval.
An index configuration that lacks scope isolation or verified local storage is
ineligible for `internal`, `private`, or `restricted` records.

### Secret handling

The host runs a versioned deterministic secret scanner before local red-team
review, on every nested proposal/evidence field, on the red-team output itself,
and again before canonical commit and projection. The scanner-policy digest is
bound to the decision. It covers known API-key/token/private-key patterns,
secret manager output, cookies, authorization headers, configured organization
patterns, and encoded canary fixtures. This is a bounded detection policy, not
a proof that arbitrary paraphrases contain no sensitive information. On a hit:

1. the candidate is blocked from canonical commit and index projection;
2. the audit records only `secret_detected` and the scanner rule class;
3. evidence is redacted before any digest or excerpt is persisted;
4. the user is told that the lesson was not stored; and
5. a user cannot bypass the policy with `global_=True` or an approval token.

Hashes of raw secrets, partial secret previews, recognized base64/hex
encodings, and model text that preserves detected credential material are
treated as secret-derived content and are also blocked. Blocked model outputs
are discarded rather than copied into findings. A command can be re-run with
redacted output to produce safe evidence. The original transcript remains
governed by its session storage policy and is not copied to the knowledge
ledger. Late detection quarantines and tombstones every known canonical/index
generation through the normal fenced decision path.

### Local semantic adapter gate

The first-release semantic pipeline accepts only a host-registered local
adapter for each proposer, verifier, and red-team role. Registration records a
stable adapter identity, implementation/version digest, `egress = none`
capability, allowed role, scanner-policy revision, and a successful deny-by-
default network-trap probe. The host checks that attestation at startup and
again for each decision. A missing, stale, role-mismatched, or unverified
adapter blocks before model invocation and leaves the canonical ledger
unchanged. There is no arbitrary provider helper, caller-selected endpoint, or
remote fallback in this release.

Before any semantic model input is assembled, the host scans and redacts the
source trajectory, legacy snapshot, evidence bytes, and request fields. It
then scans every transformed proposal, verification bundle, and red-team
bundle before forwarding it to the next local adapter. The network trap covers
all proposer/verifier/red-team child processes and adapter calls; a denied
connection is durable blocked evidence. This makes `egress = none` an
enforceable prerequisite rather than a configuration claim.

## Decision and red-team protocol

### Decision states

Each semantic mutation has one durable decision state:

```text
proposed -> validating -> red_teaming -> awaiting_authority
          -> applying -> committed -> projected
          -> rejected | blocked | conflicted | rolled_back
```

`projected` means the optional adapter acknowledged the projection; the
canonical state may still be `committed` when indexing is disabled or lagging.
No state is inferred from a missing process or a model final message.

These labels are a knowledge-operation projection of one
`DurableDecisionRecord` plus canonical transaction/outbox evidence, not another
decision reducer. The shared host decision engine owns proposal, authority,
expiry, revision, and disposition. The shared durable-store transaction owns
prepared/committed state. The optional adapter may only add projection status.

The projection is typed and closed:

```ts
type KnowledgeTransactionStatus = "none" | "prepared" | "committed";
type KnowledgeAdapterProjectionStatus =
  | "not_requested"
  | "pending"
  | "acknowledged"
  | "blocked"
  | "uncertain";

interface KnowledgeDecisionProjection {
  label:
    | "proposed"
    | "validating"
    | "red_teaming"
    | "awaiting_authority"
    | "applying"
    | "committed"
    | "projected"
    | "rejected"
    | "blocked"
    | "conflicted"
    | "rolled_back";
  decisionRef: DurableDecisionRef;
  decisionDisposition: DurableDecisionRecord["disposition"];
  transactionStatus: KnowledgeTransactionStatus;
  adapterStatus: KnowledgeAdapterProjectionStatus;
  compensatingDecisionRef?: DurableDecisionRef;
}
```

`proposed|validating|red_teaming` map to decision `proposed` with no
transaction; `awaiting_authority` maps to `awaiting_user`; `applying` maps to
`authorized` plus `prepared`; `committed` maps to `applied` plus `committed`;
and `projected` adds adapter `acknowledged`. `rejected` and `conflicted` map to
the same decision dispositions. `blocked` records either `rejected` or
`awaiting_user` plus a typed blocker artifact; it is not a new disposition.
`rolled_back` never rewrites the original applied decision: it references a
separate applied compensating decision and its committed transaction.

This state is a specialization of the kernel's `DurableDecisionRecord`, not a
second decision engine. An ordinary `/refine` or knowledge operation uses a
session decision scope; an associated durable workflow uses a workflow decision
scope. Every create, update, semantic delete, rollback, or scope change carries
the original objective, decision-scope/decision ID and revision,
contract/scorecard/workspace/baseline/evidence digests, declared read/write set,
host attempt token, nonce, expiry, applicable store/workflow epochs,
authority/policy revision, and one-time execution key. Recon, non-overlapping lenses, an independent
evidence verifier, synthesis, and exactly one fresh red-team pass are all
required before the host gate. The kernel's finite stage/model-call/resource
and unchanged-revision limits apply unchanged.

### Fresh independent red team

The red team receives:

- the original user/workflow objective and current scope policy;
- the exact candidate mutation and action (create/update/delete/rollback);
- current ledger/baseline digest and target entry snapshots;
- evidence references and `sourceDigest`;
- proposed authority and retention/privacy values;
- prior entry and conflict metadata; and
- known index/projection consequences.

It runs in a fresh context, separate from the authoring model and conversation
state. It may read the referenced local evidence and current canonical record,
but it cannot edit the ledger or approve its own verdict. Its structured result
contains `pass`, `reject`, or `needs_user`, findings, checked digests, and a
red-team run ID.

The red-team charter must independently answer:

1. **One-off:** Is this a reusable lesson, or only a transient task detail?
   Automatic one-off content is rejected; an explicit user durability request
   may proceed only with an authority decision.
2. **Poisoning:** Could untrusted retrieved text, tool output, or instructions
   manipulate future behavior, widen authority, or smuggle a prompt?
3. **Privacy/secrets:** Does the content or evidence expose private,
   restricted, or secret-derived material outside its declared scope?
4. **Duplication:** Does a normalized or semantic duplicate already exist? If
   so, should evidence be merged or the proposal be rejected as a no-op?
5. **Scope:** Does the title/content/path and audience match the requested
   session/workspace/user scope? Does a local fact improperly become global?
6. **Blast radius:** Could the entry alter prompts, procedures, delegation,
   tools, or many future sessions beyond what the evidence supports?

The host rejects any verdict with an unverified baseline/proposal digest,
missing charter finding, stale run ID, authoring-context reuse, or missing
scope/authority decision. Red-team success is necessary, not sufficient: the
host still enforces schema, secrets, CAS, and authority.

### Authority rules

Local/session writes may be auto-applied after the full universal gate when the
trigger is approved and the record is within session scope. Global writes are
applied only when one of these is true:

- the user explicitly approves the exact proposal/decision digest and scope;
- a separately user-approved and red-teamed policy matches the exact kind,
  workspace/user scope, retention, privacy class, and blast-radius limits, and
  its bound revision is unexpired and unrevoked; or
- a deterministic rollback is explicitly requested by the user and passes
  CAS plus a fresh red-team review.

An unscoped “remember this,” a model's `global_=True`, an old approval, or a
global metadata field is not sufficient. A preauthorized policy has an ID,
revision, exact registry entry ID/reference, expected registry epoch and
approved status, policy kind/scope/privacy/blast-radius, compatibility closure,
maximum entry count/bytes, privacy ceiling, expiry, exact `DurableDecisionRef`,
and revocation/rollback state. The host resolves and CAS-checks those fields
before admission, recall, or effect; a policy resolver artifact is bound to the
operation and cannot be replayed. It cannot authorize secrets, restricted
index projection, methodology changes, or user-scope changes unless those are
explicitly listed and pressure-tested.

### One-off and repeated evidence

Automatic refinement may promote a lesson only when at least one of these
holds:

- the same reusable pattern appears in two independently audited observations
  with compatible scope and no unresolved contradiction;
- an explicit user request identifies the durable fact/procedure and intended
  scope; or
- a verified workflow milestone or final completion audit identifies a
  reusable lesson with concrete evidence.

Repeated identical model wording is not independent evidence. A single failed
command, single preference mention, or one successful turn is one-off unless
the user explicitly asks for persistence.

## Read routing and recall

### Source order

All memory-relevant reads use this order:

1. **Canonical typed ledger:** filter by status, scope, workspace binding,
   retention, privacy audience, and requested kind; verify the entry digest and
   evidence freshness.
2. **Optional MemPalace index:** only over current canonical projections and
   only when the query concerns past work, projects, prior decisions, or
   temporal/relational facts and the configured read route allows it.
3. **Verification:** if sources conflict, are stale, or have empty results,
   ask for a narrower query, inspect current evidence, or report that no
   trusted record was found. Never fill the gap from model memory while
   claiming recall.

Before any policy-gated recall or prompt projection, the host resolves the
`KnowledgePolicyRef` against the current workflow revision registry and emits
an operation-bound `KnowledgePolicyResolution`. It rehashes the exact entry
reference, checks registry epoch and CAS, requires approved status and a
compatible closure, then checks policy kind, scope, privacy, blast radius,
expiry, exact decision ref, and revocation/rollback state. A stale, replayed,
superseded, revoked, rolled-back, or mismatched resolver blocks the current
recall/effect or marks it degraded; an optional index cannot substitute for
the host proof.

MemPalace's recall protocol is adapted as follows: search canonical-projection
drawers before answering relevant historical questions, use short
natural-language queries, honor workspace/wing scope, return bounded projected
excerpts, and surface empty or unavailable results. Pure greenfield edits do
not trigger reflexive index search, and raw-drawer namespaces are excluded by
host policy before the query reaches the adapter.

### Canonical prompt projection

The canonical prompt projection replaces legacy prompt injection entirely. The
prompt builder reads only the committed canonical ledger, then applies active
status, stable-principal/workspace scope, privacy audience, retention, digest,
and evidence-freshness filters. It does not merge `HarnessState`, legacy
`memory`/`prompt` entries, raw project snapshots, or adapter drawers into the
prompt. A legacy snapshot can influence a prompt only after the host derives a
typed canonical record, completes the decision gate, commits it, and rebuilds
this projection from the committed sequence. A missing, stale, corrupt, or
unfenced projection is omitted or blocks according to the operation; it is
never filled from legacy content.

### Read route modes

The read route is independent from canonical authority:

- `direct`: read the canonical ledger and local evidence directly. Do not
  probe or write an optional daemon/index.
- `prefer`: read canonical first; use a healthy local index for broader
  semantic recall over canonical projections. If the index is unavailable or stale, return the
  canonical result and mark the read `index-degraded`; do not guess.
- `require`: for an operation explicitly requiring semantic index
  recall, use the healthy local index or block with a visible error. There is
  no silent fallback to model memory. Canonical direct reads remain available
  for structured entries unless the caller explicitly asked for index-only
  recall.

`require` is appropriate for an explicitly requested semantic query over
canonical projections, not for ordinary canonical prompt construction. An
explicit raw-drawer view is rendered directly by the local UI without becoming
model input. The UI shows which route and source were used.

### Recall result contract

Every injected or displayed recall has:

```ts
interface RecallItem {
  source: "canonical" | "mempalace";
  entryId?: string;
  drawerId?: string;
  scope: KnowledgeScope | "wing";
  content: string;             // exact, bounded text; untrusted data wrapper
  contentDigest: string;
  evidenceDigests: string[];
  status: "current" | "stale" | "conflict" | "degraded";
  policyResolutionRef: WorkflowArtifactRef | null;
}
```

Retrieved text is inserted under a clearly labeled untrusted-data delimiter.
It cannot change system instructions, tool authority, scope, or approval
state. The model may use it as evidence, but instructions contained in a
drawer are not executable commands.

Default prompt construction injects only `current` canonical records whose
evidence, scope, retention, and digest checks pass. `stale`, `conflict`,
`degraded`, index-only, and orphan-drawer results are display/review candidates
under the untrusted-data wrapper; they cannot silently influence normal prompts
or become canonical authority. If the canonical journal is corrupt or
unavailable, optional index results remain display-only and semantic writes
fail closed.

### Injection limits

The default hard limits are:

- at most 8 canonical entries;
- at most 5 canonical-projection MemPalace drawers;
- at most 2,000 tokens from canonical entries;
- at most 3,000 tokens from projected drawers; and
- at most 4,000 total injected tokens as measured by the current prompt
  model's existing deterministic token counter, or 16,000 UTF-8 bytes,
  whichever limit is reached first. If the token counter is unavailable, the
  byte cap is the sole conservative admission bound and the result is marked.

The caller may lower limits but cannot raise the hard cap without a user
setting and a new prompt-budget review. Truncation happens on drawer/entry
boundaries, not in the middle of a quote. The prompt includes IDs/digests and
one-line source labels, not full transcripts. If a conflict would be hidden by
the cap, inject a conflict marker instead of selecting one silently.

## MemPalace 3.7.0 adapter

### Boundary and license

The inspected clean local checkout at commit
`759b1273d3fc92721596938a57168b1314e77f41` reports version `3.7.0`, Python
`>=3.9`, and an MIT license. Its README describes verbatim storage, pluggable backends,
local-first operation, ChromaDB as the default, optional SQLite-exact and
remote backends, and no required API key for the core path. Prime Agent uses
only the local path in this design. A deployment may choose `chroma` or
`sqlite_exact`; remote `qdrant`, `pgvector`, and Milvus-server backends are
outside this implementation's memory boundary.

The adapter is version-pinned at the integration boundary and reports its
version, backend, palace path, writer ownership, schema/index health, and
privacy configuration at startup. A missing adapter is a normal disabled
state, not a startup failure. Startup rejects remote backends and any local
configuration whose storage path, writer ownership, or scope isolation cannot
be verified; it never treats an unsupported backend as merely degraded.

### Projection shape

Approved active canonical entries project as local MemPalace drawers with:

- a stable projection ID derived from store, scope, workspace ID, and `entryId`,
  plus a monotonically increasing canonical entry generation used for CAS;
- `wing` bound to the workspace/user namespace, never inferred from arbitrary
  retrieved text;
- `room` set to `knowledge/how`, `knowledge/why`, or
  `knowledge/procedure`;
- exact statement/procedure content, not an LLM summary;
- metadata for `source_of_truth=prime-agent`, `entry_id`, `entry_generation`,
  `canonical_sequence`, `entry_digest`, `source_digest`, `scope`,
  `privacy_class`, `retention_class`, `status`, and `redacted`; and
- no secrets, restricted content, or evidence outside the permitted scope.

Raw transcript/project mining and hook ingestion are disabled in the first
release. Existing raw drawers may be shown only through an explicit,
display-only historical recall view, wrapped as untrusted data; they are not
prompt inputs, evidence, canonical records, or authority. No graph row or
drawer may be mined into a proposal until a future release adds an explicit
gate under this design. This keeps raw material a possible future display
feature without giving it a semantic or prompt path now.

MemPalace's `entities`, `triples`, and `attributes` knowledge-graph rows can
help find temporal/relational candidates, but their `confidence`, validity
windows, and source fields do not override a canonical entry. A changed fact
is represented as a canonical supersession/tombstone and, if the adapter is
enabled, an index invalidation plus new projection.

## Write routing, single writer, and idempotency

### Two writer domains

The canonical ledger and MemPalace index have separate writer controls:

1. The Prime Agent host is the logical canonical writer. Kernel calls,
   interactive `/refine`, auto-refine, and child reports enqueue mutations to
   that host. Global writes acquire an inter-process lease around the CAS
   transaction. No child or raw skill writes the global file.
2. MemPalace local backends have a separate palace writer lease. A writable
   daemon owns it for its lifetime; direct CLI/hook writers must not run beside
   that owner. Read-only clients may coexist under the adapter's read-only
   rules.

Serializing individual Chroma/SQLite calls is not enough. A long-lived writer
can retain WAL, FTS, or vector-index state, so the writer lease covers the
whole process lifetime as described by MemPalace's write-routing policy.

### `direct`, `prefer`, `require`

For routine optional-index writes, the shared policy resolves to one concrete
route: `direct`, `daemon`, or `blocked`.

- `direct`: use the existing local direct adapter path, with the palace lease;
  do not probe or start a daemon.
- `prefer`: use a healthy daemon; if it is unavailable and the caller is
  allowed to use the direct path, fall back to direct. This is still safe only
  when the direct writer obtains the same local palace lease.
- `require`: use a healthy daemon, or start it only when the interactive
  caller is explicitly allowed to do so. If unavailable, block the index
  operation; never fall back to a direct ChromaDB writer.

Canonical writes are always direct-to-local Prime Agent storage. Operations
are typed as `canonical_only` or `composite_visibility` before the universal
decision gate. Under `canonical_only`, `require` may block a requested
projection but cannot block or roll back an already-authorized canonical
commit. Under `composite_visibility`, preflight requires a healthy local route
and reserves a bounded projection attempt before canonical commit; after the
canonical commit point, any ambiguous adapter result is reported as committed
canonical state plus quarantined visibility rather than falsely rolling back
the ledger. There is no cross-process claim of atomic canonical-plus-index
storage.

The adapter retains MemPalace's policy names and precedence:

- hooks: `MEMPALACE_HOOK_WRITE_ROUTING`, then
  `MEMPALACE_WRITE_ROUTING`, legacy `MEMPALACE_HOOKS_DAEMON`, hook config,
  default;
- CLI: `MEMPALACE_CLI_WRITE_ROUTING`, then `MEMPALACE_WRITE_ROUTING`, CLI
  config, default; and
- invalid explicit policy values fail closed with a source-specific error.

Hook behavior follows the inspected routing policy:

- hooks normally probe but do not cold-start a daemon;
- one route decision is reused for the whole Stop/SessionEnd/PreCompact write
  burst;
- `require` skips writes, returns a visible system message, and does not
  advance the save marker when the daemon is unavailable; and
- once daemon submission is attempted, an ambiguous submission error never
  triggers direct fallback because the daemon may have accepted the job.

Maintenance operations—repair, migration, and index rebuild—use a separate
exclusive-maintenance policy. They do not reuse routine `prefer` fallback.

### Canonical writer transaction

The canonical writer performs these steps under one store-level lease and its
monotonic store-writer fencing epoch. A workflow-bound mutation must also match
the active workflow coordinator epoch; an ordinary session-scoped mutation has
no invented workflow epoch. Session and global stores have distinct leases;
every snapshot, audit, history, and outbox write is fenced by the same store
epoch for that transaction:

1. Re-read and reduce the authoritative hash-chained journal; verify canonical
   encoding, writer identity, sequence, epoch, and the last committed digest.
2. Verify `baselineDigest`, expected entry generations, authority token,
   red-team digest, and policy revision.
3. Re-run deterministic schema, scope, retention, privacy, and secret checks.
4. Clone the exact baseline into an immutable candidate state. Validate every
   edit and apply every action to that clone only; duplicate/no-op edits are
   rejected or coalesced deterministically. Any failure discards the clone
   without touching canonical records, snapshots, prompt projections, or the
   outbox.
5. Append and flush a `prepared` intent containing the decision/idempotency key,
   baseline digest, expected entry generations, and proposed after-state digest.
6. Publish the complete after-state and audit payload as immutable
   content-addressed artifacts using file and parent-directory flushes.
7. Publish immutable outbox event artifacts for the full projection set and
   include their digests in the prepared transaction.
8. Append and flush one `committed` event referencing the after-state, audit,
   and exact outbox artifacts. This journal event is the only logical commit
   point and yields the resulting `ledgerDigest`; no later step invents an
   unjournaled projection intent.
9. Regenerate and atomically replace the derived `HarnessState`, canonical
   prompt projection, history view, session custom entry, and outbox queue view
   from that exact committed sequence. Each projection carries the source
   ledger sequence/digest and store fencing epoch, and each file/artifact is
   flushed before publication. These views never authorize state, a fence
   mismatch keeps a projection out of model input, and all can be rebuilt after
   a crash.
10. Release the lease exactly once and emit the existing
   refine-complete/failure signal with the committed sequence or exact failure.

A `prepared` event without a committed marker is ignored as a semantic mutation.
A committed event with a missing/stale snapshot or outbox view is replayed to
rebuild those projections. A snapshot ahead of the last valid committed event
is quarantined and regenerated; it is never accepted as an unjournaled mutation.
The prompt and outbox projections are fenced and flushed just like the state
snapshot; neither can be consumed when its source sequence or epoch is stale.
Crash injection at every append, flush, rename, and projection boundary must
recover exactly one committed state and all resulting outbox intent.

### Idempotency

Every mutation has a durable namespaced idempotency key:

```text
idempotencyKey = storeId + ":" + decisionScopeId + ":" + decisionId + ":"
               + operation + ":" + targetGeneration + ":" + proposalDigest
```

The canonical journal stores the key and result. A retry with the same key and
same proposal/baseline returns the original result without another mutation.
A retry with the same decision ID but a different proposal, scope, authority,
or baseline fails with `idempotency_conflict`. Outbox projection uses the
entry digest and source identity as its own idempotency key.

Consumed keys are retained through the configured retry and tombstone horizon.
An adapter submission that times out is `submission-uncertain`; the outbox
retries through the same route and key within a finite retry budget. It never
runs a direct fallback after an attempted daemon submission. Exhaustion
quarantines the projection for manual retry/rebuild while canonical knowledge
remains committed.

## CAS and rollback

### CAS conflict

`planRefinement` captures the target-scope baseline. `_applyRefine` reloads the
state immediately before application, as the current implementation already
does to avoid clobbering kernel writes. The new gate compares the full
`baselineDigest` plus per-entry generations/content digests.

If another writer changed the store journal, any target generation, or the
policy/authority revision, the serialized transaction applies zero edits and
records `conflicted`. The host then replans from the new state. Disjoint
proposals may be prepared concurrently but commit serially against a new full
store baseline; they do not replace the same snapshot concurrently, merge model
text, silently favor one writer, or overwrite a newer entry.

### Rollback

Rollback is a compensating refinement decision, not a file restore. The
original result stores before/after snapshots and digests for each applied
edit. A rollback proposal reverses only those exact edits and includes
`rollbackOf`.

Rollback requires:

- a fresh independent red team using the same six-point charter;
- authority for the target scope;
- a CAS check that the current target still matches the original after-state;
- no active tombstone/supersession conflict; and
- a new idempotency key and audit event.

If a target changed after the original refinement, rollback stops with a
conflict and proposes a fresh corrective update. It never erases subsequent
evidence or unrelated entries. Tombstones and history remain inspectable.

## Outbox, indexing, rebuild, and degraded operation

### Durable outbox

After canonical commit, the host appends one projection event per target to a
local outbox. Each event contains operation (`upsert`/`delete`), scope, entry
ID, stable projection ID, entry generation, canonical journal sequence,
retention/expiry, privacy class, target adapter version, route policy, and
attempt status. An upsert also carries the entry/content/source digests and
every superseded projection ID; a delete carries only its opaque deletion
fingerprint and generation, never a raw protected content/source digest. The
outbox is not allowed to contain secret content; it references the canonical
entry by ID/digest only where that digest is permitted by the privacy policy.

Projection states are `pending`, `submitted`, `acknowledged`, `failed`,
`uncertain`, `blocked`, or `superseded`. A tombstone supersedes all older
upserts for the same entry. The adapter accepts an upsert/delete only when its
generation is not older than the last acknowledged generation; a delayed retry
cannot overwrite or resurrect newer content. Replay is idempotent and
digest-checked. `acknowledged` means the local adapter durably stored the
generation and a read-after-write lookup returned the same digest.

### Rebuild

Prime Agent rebuild enumerates active canonical entries, applies scope/privacy
filters, and produces a canonical projection manifest of stable IDs,
generations, and digests. It upserts the manifest and deletes every
Prime-Agent-owned adapter record absent from it. It does not mine arbitrary
transcripts and does not invent missing canonical records. A rebuild runs
with an exclusive maintenance lease and records the source ledger digest,
adapter version, backend, upsert/delete counts, failures, read-after-write
checks, and final health.

If MemPalace's vector index is corrupt but its SQLite drawer rows are intact,
follow the local protocol inspected in `integrations/shared/recall-protocol.md`:

1. stop the MCP/daemon writer;
2. back up the local palace directory;
3. run `mempalace repair --mode from-sqlite --archive-existing --yes`;
4. verify `mempalace repair-status` reports zero divergence; and
5. restart the local adapter.

Do not re-mine to repair an index because that can omit MCP diary/drawer data.
Do not unlink a live palace lock. Stop the owning process cleanly so the
operating system releases it.

### Degraded reads and writes

The status surface distinguishes:

- adapter disabled/not installed;
- adapter unavailable;
- adapter read-only because another writer owns the lease;
- outbox lagging;
- projection failed/uncertain;
- index corrupt/under repair; and
- canonical ledger healthy.

Canonical prompt construction and local refinement can continue in all of
these states. A caller requesting `require` index recall/projection receives a
visible blocked result. A `prefer` caller receives canonical results plus a
degraded marker. No path claims “memory indexed” until the adapter
acknowledges the digest.

## Refinement lifecycle and triggers

### Trigger classes

The host may start a semantic refinement review for:

1. **Verified milestone:** an independent audit accepted current evidence for
   one or more workflow requirements or a concrete user-visible milestone.
2. **Repeated audited failure:** at least two compatible failed attempts were
   independently audited, have a common cause, and expose a reusable remedy.
3. **Final completion:** independent completion verification passed; a final
   review may capture durable methodology/knowledge before completion is
   reported.
4. **Explicit user request:** `/refine`, `refine.run()`, or a direct user
   request for a specific memory/procedure/rollback.

Current `turn_interval` and `compact` opportunities may ask a fresh reviewer
whether one of the above trigger classes is now supported. They cannot create
durable edits solely because a timer fired or a context was compacted.

### Existing `refine` skill contract

The current Python skill remains:

```python
await refine.status()
await refine.run(instructions=None, global_=False)
```

`refine.run()` validates argument types and schedules host work for the end of
the current turn. The host then:

1. captures the trigger and audited evidence references into a typed host
   request;
2. builds a proposal from trajectory, current typed state, and history without
   granting the Python caller state/path/lease authority;
3. normalizes display-only `local:`/`global:` IDs to bare IDs;
4. runs the fresh red team and authority gate;
5. applies one immutable-clone, all-or-nothing target-scope CAS transaction if
   approved;
6. rebuilds the canonical prompt projection only after canonical commit; and
7. records projection/outbox status without pretending the adapter is
   canonical.

The Python `refine` implementation cannot call an alternate apply path or
inject a legacy snapshot into the prompt. A direct state/path/global mutation,
an untyped request, or a request that skips any decision stage is rejected and
leaves the ledger unchanged.

One request per turn remains enough; a later request replaces instructions
only before the decision revision is created. Once a proposal has entered
red-team review, any changed request creates a new proposal digest and fresh
review.

`global_=True` sets `requestedScope = workspace|user` according to the target
policy. It never supplies the required global approval itself. The host
returns a pending-approval result when necessary, rather than silently
converting the request to local or applying globally.

### Small edit rule

The refiner must choose the smallest relevant artifact:

- declarative how/why/procedure -> typed `memory` knowledge entry;
- repeatable callable procedure -> typed `skill` procedure entry;
- narrow prompt behavior -> `prompt` note, not a broad methodology rewrite;
- repeated delegation role -> `subagent` spec;
- faulty prior edit -> compensating rollback or focused update.

An empty edit set is a successful review outcome when evidence does not justify
persistence. Empty results record the rationale and preserve the current
ledger.

### Methodology changes: RED/GREEN/REFACTOR

Any change to a skill, executable procedure, refinement policy, or reusable
methodology must use the `writing-skills` pressure-test cycle:

**RED — pressure the baseline.** In a fresh context, run a bounded scenario
without the proposed change. Include one-off noise, prompt poisoning, scope
confusion, duplicate memory, stale evidence, rollback conflict, and a normal
successful use. Record the exact violation or rationalization and its evidence
digest. If the baseline already passes, the change needs a different
observable gap or is rejected as unnecessary.

**GREEN — minimal change.** Apply only the smallest skill/policy change that
addresses the observed failure. Re-run the same pressure cases and assert the
new safety behavior as well as the intended positive behavior. The fresh red
team reviews both the skill text and test evidence.

**REFACTOR — close loopholes.** Vary wording, order, stale/duplicate inputs,
scope, and adversarial retrieved text without changing the intended contract.
Re-run all RED/GREEN cases, the focused package tests, and repository checks.
Refactor is not accepted if it merely makes a metric look better or weakens a
failure assertion.

No methodology change is promoted to `workspace` or `user` scope without
pressure-test artifacts, independent audit, and global authority.

## Continuous improvement and adaptive-observation boundary

The knowledge layer receives improvement triggers from the workflow controller
after every phase, incident, and completion gate. A trigger is a bounded
candidate review, not permission to write and not a progress score. It carries
accepted evidence references, baseline revision/digest, affected scope and
authority, an expected measurable observation, and a rollback artifact. A
workflow's resource telemetry may be cited as evidence for a how/why lesson,
but the knowledge writer never chooses the critical path, reallocates a lease,
or consumes the control reserve.

The host, not a knowledge proposer, freezes the host-owned improvement evaluator,
parser, scorecard, and preregistered case manifests. The contract fixes metric
direction, aggregation, variance/repeatability, deterministic risk
classification, and stage-scoped holdout commitments. Risk-relevant changes
require a host-selected hidden holdout with required `heldOutInputDigest`,
required sample sizes, effect/tolerance thresholds, protected-invariant and
non-regression predicates, and explicit cost/latency limits; the proposer cannot
choose, replace, or omit that holdout. Review admission is latest-wins with at
most one pending and one active review, superseded pending work is cancelled,
and a fenced active result cannot apply. Positive finite cadence/duty-cycle,
per-window/phase/workflow limits and a dedicated review reserve disjoint from
planner/verifier/red-team/control capacity are mandatory; invalid or exhausted
bounds fail closed.

The workflow host supplies a reproducible critical-path certificate derived from
the accepted DAG, typed host-derived remaining-work estimates, host-observed
novelty/nonduplicate proofs, and policy digest; its objective is
time-to-genuine-proof, then evidence gap, cost, uncertainty, queue age, and a
deterministic task ID/digest tie-break. Independent host admission is required;
knowledge cannot manufacture that proof. Every task/value lesson must remain
bound to an unproven requirement/evidence gap, typed novelty proof, typed
bounded observable outcome, and finite exploration quota. Adaptive entries
remain bound to task, attempt, discriminated `WorkflowCapacityGrant` backed by
the generic `WorkflowCanonicalPoolLedger`, resource lease, and ownership lease;
claimed/active work is fenced and reconciled before new attempts, while only
unclaimed slots move.

Capacity, usage, billing, and rate-limit evidence is accepted only through
authenticated monotonic TTL-bound snapshot refs with `observedAt`/`expiresAt`;
stale, expired, or unknown state is zero at allocation CAS, including provider
charges. Hard process,
session, model-call/token, and recovery control partitions are outside worker
capacity, and `exclusive_unisolated` work is serialized away from them. The
canonical pool ledger separates instantaneous concurrency from cumulative spend
and accounts for every resource/control component once. The host persists
bounded priority-bucket aging/promotion, aging/last-served fairness,
exploration quota, `benefitThreshold`, `minimumDwellMilliseconds`,
`maxTransitionsPerWindow`, and last decision; every value is finite, positive,
and range-validated.
Knowledge cannot
override those guards or use canonical/MemPalace state to authorize an effect.

All knowledge refinements route through the generic discriminated
`WorkflowImprovementProposal` → `WorkflowImprovementReview` →
`WorkflowImprovementResult` lifecycle and journaled events, retaining baseline/
candidate evidence, verifier/Goodhart/regression/safety results, queue and
crash-fencing state, and rollback/CAS metadata. Allocation/effect intent
precedes any write, lease, or provider charge. A crash
before its applied marker is uncertain until the effect-broker proves
nonexecution or fences/reconciles idempotently. Expired leases require strong
nonexecution proof for reclaim or a finite terminal escalation; knowledge never
keeps an indefinite reap obligation. Adaptive observations coalesce to one
latest pending and one active review, cancelling superseded pending work and
fencing active results that can no longer apply.

```typescript
interface KnowledgeImprovementRevision {
  revisionId: string;
  targetKind: "workflow" | "methodology" | "policy" | "knowledge";
  targetRef: string;
  baselineRevision: number;
  baselineDigest: string;
  sameCaseEvidenceRefs: readonly EvidenceRef[];
  heldOutReplayCanaryEvidenceRefs: readonly EvidenceRef[];
  expectedObservation: string;
  verifierEvidenceRefs: readonly EvidenceRef[];
  goodhartRedTeamRef: EvidenceRef;
  regressionRedTeamRef: EvidenceRef;
  safetyRedTeamRef: EvidenceRef;
  proposedMutationRef: WorkflowArtifactRef;
  rollbackRef: WorkflowArtifactRef;
  decisionRef: DurableDecisionRef;
  binding: KnowledgeRecordBinding;
  recordMode: KnowledgeRecordMode;
  taskValueCertificateRef: WorkflowArtifactRef | null;
  taskValueCertificateDigest: string | null;
  taskId: string | null;
  attemptId: string | null;
  resourceLeaseRef: WorkflowLeaseRef | null;
  ownershipLeaseRef: WorkflowLeaseRef | null;
  sourceAdaptiveObservationRefs: readonly WorkflowArtifactRef[];
  sourceAdaptiveReviewRefs: readonly WorkflowArtifactRef[];
  hostValidationRef: WorkflowArtifactRef | null;
  policyResolutionRef: WorkflowArtifactRef | null;
  improvementScorecardRef: WorkflowArtifactRef;
  revisionRegistryEntryRef: WorkflowArtifactRef;
  compatibilityClosureDigest: string;
  rollbackOfRevisionId: string | null;
  rollbackEventSequence: number | null;
  registryCasExecutionKey: string;
  reloadVerificationRef: WorkflowArtifactRef;
  futureLoadVerificationRef: WorkflowArtifactRef;
  status: "proposed" | "approved" | "rejected" | "rolled_back";
  appliedLedgerSequence: number | null;
  revisionDigest: string;
}
```

The host maps this review into the shared generic
`WorkflowImprovementProposal`/`WorkflowImprovementReview` lifecycle and then
into `KnowledgeMutationProposal` or the separate native methodology envelope;
it does not add a private writer or authority path. The verifier must compare
the candidate with its approved baseline on the same pressure cases and on
held-out, replay, or canary cases when the target admits them. A fresh red team
independently attacks Goodhart optimization, regression, safety/secret leakage,
scope, authority, and resource cost. Only a compatible proposal with current
evidence, exact decision/epoch, and a successful registry CAS can commit. The
transaction writes canonical state, audit, before/after snapshots, rollback-of
revision/event-sequence metadata, and registry state atomically; restart reload
and future-load verification prove that only the approved compatible bytes are
used. It then emits outbox work for optional indexing. A failed comparison,
stale observation, conflicting baseline, or ambiguous crash leaves canonical
state unchanged or restores the last committed revision. There is no partial
promotion.

Future workflows and methodology invocations resolve only the approved
revision registry. Candidate, rejected, unverified, stale, or rolled-back
revisions cannot enter prompt projection, phase contracts, resource policy, or
MemPalace. An explicit objective/scorecard/evaluator/authority/envelope/scope
change returns to the workflow's exact user approval gate. An empty edit set is
recorded as a valid review result and does not create an artificial knowledge
entry.

Before every phase admission or canonical/index effect, the host resolves the
current revision-registry epoch, discriminated scope binding, session/knowledge
decision refs, and compatibility closure. A `revisionKind:"knowledge"` entry
must carry `scope:"knowledge"` with an exact session- or workflow-scoped
`knowledgeDecisionRef` and matching `knowledgeEntryRef`; the shared resolver
rejects a kind/scope mismatch and does not widen authority. For a
preauthorized policy, the host also validates the exact `KnowledgePolicyRef`
registry entry/ref, epoch, approved status, policy kind/scope/privacy/
blast-radius, compatibility, expiry, decision, and revocation/rollback fields
with a fresh CAS-bound `KnowledgePolicyResolution` before admission, recall,
or effect. Superseded or revoked entries fence affected proposals, records,
leases, approvals, and caches; pinned revision bytes and registry events remain
available for audit. Rollback is an atomic registry CAS with
rollback-of/event-sequence metadata, followed by restart reload and future-load
verification.

### Ownership and first-release boundary

| Concern | Owner | First-release boundary |
| --- | --- | --- |
| Critical-path/resource observation and allocation | Durable workflow kernel | Knowledge consumes accepted evidence only; it cannot allocate, self-score, or expand an envelope |
| Recurring `cron` efficiency review | Workflow schedule/window/recovery owner; knowledge receives read-only evidence | One fresh review/window and one restart catch-up; suggestions have zero write, lease, allocation, approval, or completion authority |
| Improvement proposal, canonical how/why/provenance, CAS, and rollback | Prime Agent knowledge/refinement ledger | One local canonical writer, finite review/rollback ceilings, no partial or unverified promotion |
| Typed task-value/lease/adaptive-source/host-validation metadata | Knowledge schema and host retention gate | All proposal/content/revision/evidence records carry typed nullable/validated refs; stale or mismatched source/lease/certificate fields block retention and indexing |
| Host-owned improvement scorecard and canonical revision registry | Workflow decision/refinement/revision owner | Knowledge stores accepted how/why/provenance only; host-selected holdouts, finite review bounds, compatibility closure, and revocation fencing remain outside the ledger |
| Methodology/workflow policy revisions | Native methodology/refinement boundary | Baseline plus held-out/replay/canary and independent Goodhart/regression/safety red team; exact approval for material changes |
| Optional semantic projection | MemPalace outbox/adapter | Local index only; no authority, no raw mining, no memory egress, no writer bypass |

The first release does not infer resource capacity from an index, use index
health as outcome evidence, or run background refinement indefinitely. Unknown
capacity, stale observations, missing no-egress adapter attestations, and
ambiguous index/canonical leases remain blocked or quarantined until a fresh
host decision resolves them.

### Knowledge-layer projection of the recurring efficiency red team (`cron`)

The `cron` schedule is owned by the workflow resource envelope, not by the
knowledge ledger. A fresh independent read-only reviewer consumes one
host-resolved snapshot per approved window: critical path, ready queues,
resource/ownership leases, cost, latency, accepted progress, evidence gaps,
uncertainty, and control reserve. Its charter checks underuse, overuse,
redundancy, safely serializable work, context churn, verifier/red-team
starvation, review overhead, cloud cost, and Goodhart risk. Knowledge may
retain an accepted how/why/provenance lesson about that review, but a raw
suggestion is never a canonical record, prompt input, or authority.

Before invoking `cron`, the host dereferences and re-hashes the immutable
original objective, hardened contract, scorecard/protected invariants, plan,
critical-path certificate, knowledge configuration, evaluator/guard, revision
registry, and authenticated capacity/usage/billing/rate-limit refs. Missing,
stale, mismatched, revoked, or untrusted refs reject the snapshot; the
knowledge layer cannot substitute mutable ledger/index paths or self-generated
progress proof. The host retains the dereference and stale-rejection proof with
the snapshot.

Window CAS enforces exactly one review and rejects overlap; major-transition
triggers coalesce into the same snapshot. Restart permits one validated
catch-up and discards older missed windows. The reviewer has no write, lease,
allocation, approval, or completion authority. Applying a suggestion is a new
full decision/approval, and changing cadence, trusted clock, trigger set,
window, catch-up, or reviewer reserve is a new resource/configuration decision.
A late, failed, stale, malformed, or unavailable review is bounded and
nonblocking, preserves canonical state and the last safe allocation, and cannot
consume verifier/red-team/control reserve. MemPalace can index only the later
accepted canonical how/why record.

The generic `WorkflowEfficiencyRedTeamInvocation` and typed
`WorkflowEfficiencyRedTeamResult` persist a monotonic clock observation and
last-admitted window sequence/id, rejecting backward, duplicate, or replayed
windows. Each knowledge-layer invocation binds the immutable snapshot, reviewer
child identity, independent read-only capability proof, admission and
resource/ownership leases, epoch, execution key, and invocation token. Its
typed success/failure result records actual usage; failed, timed-out, stale,
unavailable, or fenced results are durable nonblocking outcomes and cannot
become canonical knowledge or authorize an effect.

## User controls and UI

### Commands and views

The interactive UI and headless status surface should expose:

- `/knowledge status`: canonical ledger health, scope counts, pending
  decisions, outbox lag, adapter route/backend/version, retention expiry,
  secret blocks, and degraded state;
- `/knowledge search <query>`: canonical-first search with optional
  MemPalace route and explicit source/limit controls;
- `/knowledge show <id>`: exact entry, status, scope, provenance, evidence
  digests, authority, red-team verdict, revisions, and projection status;
- `/knowledge decisions [id]`: proposal, baseline/proposal/decision digests,
  red-team findings, authority request, and host disposition;
- `/knowledge approve <decision-id>` and `/knowledge reject <decision-id>`:
  consume a one-use exact approval token;
- `/knowledge rollback <refinement-id>`: create a CAS-guarded compensating
  decision;
- `/knowledge forget <id|scope>`: create tombstones and index-delete work,
  subject to the current user's authority;
- `/knowledge rebuild`: request an exclusive local index rebuild and show
  progress; and
- `/knowledge export`/`import` (later optional milestone): local, redacted,
  digest-checked transfers
  with explicit scope and secret checks. Import is a proposal, never a
  direct overwrite. Imported records are marked `source = import_candidate`,
  stripped of prior authority/confidence/policy tokens, and require fresh local
  evidence verification, red team, and user scope approval before activation.

Existing `/refine` remains available and shows its decision ID, trigger,
scope, red-team status, applied edit count, canonical commit, and optional
index projection status. Existing `refine_complete` and `refine_failed`
events remain meaningful; richer audit details live in local artifacts so no
daemon protocol shape needs to change.

Only an exact typed approval-card action or the matching approve/reject command
can consume a pending token. Ordinary messages, model-authored commands,
unrelated control commands, and workflow resume actions leave it pending.

### Settings

User settings control:

- auto-refine enabled/disabled;
- eligible trigger classes and cooldowns;
- default local scope and allowed workspace roots;
- retention windows and maximum ledger bytes/entries;
- secret scanner rules and additional organization patterns;
- MemPalace enabled/disabled and local palace path;
- read/write routing (`direct`, `prefer`, `require`) per hooks/CLI/adapter;
- recall injection limits below the hard cap; and
- preauthorized global policy ID/revision/expiry.

The UI clearly labels `session`, `workspace`, and `user` records, warns before
global approval, displays evidence freshness and stale/conflict status, and
offers a single action to disable all semantic writes. Disabling writes does
not delete existing data or disable canonical reads unless the user asks.

### Approval UX

An approval card shows the exact title/content/procedure, proposed scope,
privacy/retention class, affected entries, evidence excerpts/digests,
red-team findings, blast-radius estimate, index projection, and approval
expiry. Its one-use token is host-issued and bound to the authenticated user,
root session, decision/revision, proposal and baseline digests, coordinator
epoch, policy revision, expiry, and response sequence. The user approves the
digest, not a mutable summary. Editing the proposal, changing policy/state, or
replaying it from another session invalidates the token.

## Recovery and failure modes

| Failure | Required behavior | Recovery evidence |
| --- | --- | --- |
| Red-team model unavailable or malformed | no semantic write; record blocked review; continue normal work | red-team failure + no ledger digest change |
| Secret scanner hit | block canonical/index write; store only generic reason class | no scanner-detected protected bytes in ledger/outbox/index |
| One-off/poisoning/duplicate/scope/blast finding | reject or request user clarification | exact finding and proposal digest |
| Global approval missing/expired | remain `awaiting_authority`; never downgrade scope | approval token state |
| Baseline/state CAS conflict | apply zero edits; re-read/replan | old/new ledger digests |
| Duplicate retry | return original result; no second version/index event | idempotency key lookup |
| Crash after prepare | ignore uncommitted prepare; recover last committed snapshot | journal replay log |
| Crash after canonical commit before indexing | replay outbox idempotently | canonical digest + pending outbox |
| Outbox corruption | quarantine malformed event; rebuild projections from canonical | quarantined digest and rebuild report |
| Daemon unavailable under `prefer` | use safe direct adapter route only if lease is acquired | route decision and lease evidence |
| Daemon unavailable under `require` | block optional index operation; no direct fallback | visible blocked result, marker unchanged for hooks |
| Ambiguous daemon submission | retry same route/key; no direct fallback | `submission-uncertain` record |
| MemPalace HNSW/connection corruption | stop writer, back up, repair from SQLite, verify status | repair-status with zero divergence |
| Canonical snapshot corrupt | preserve/quarantine corrupt file; recover last valid journal/snapshot; fail closed for writes | corruption digest and recovery source |
| Stale evidence on read | mark entry stale; do not inject as current; request verification | evidence mismatch digest |
| Retention expiry | stop injection/projection; preserve tombstone for horizon | expiry/tombstone event |
| User forgets entry | canonical tombstone first, then adapter delete; stale queued upsert is suppressed | delete digest and outbox ack |
| Process/session disposal | drain/finish safe pending writes or record cancellation; never report uncommitted work | terminal decision state |
| `cron` schedule/clock/trigger set is missing, untrusted, overlapping, or changed without approval | Reject the review trigger or schedule proposal; keep the approved envelope and canonical state unchanged | trusted-clock, schedule-digest, window-CAS, and approval evidence |
| `cron` reviewer is late, unavailable, malformed, stale, or requests a write/lease/allocation effect | Record a bounded nonblocking failure or reject the suggestion; preserve canonical state and last safe allocation | fresh independent identity, read-only capability proof, failure/suggestion digest, and unchanged ledger digest |
| Restart leaves multiple missed `cron` windows or catch-up already consumed | Admit exactly one validated catch-up and discard older windows without backlog replay | restart epoch, catch-up marker, window state, and bounded review count |
| Adaptive observation is stale, incomplete, or based on an old workflow/config/lease digest | Keep canonical knowledge unchanged, reject the observation, and request a fresh host evidence bundle | stale-observation artifact and unchanged ledger digest |
| Critical-path or task-value certificate is missing, stale, non-reproducible, duplicate, or lacks an evidence gap/bounded outcome/quota | Do not retain it as a knowledge lesson or use it for allocation; keep canonical state unchanged | Host certificate inputs, novelty digest, and rejection artifact |
| Adaptive entry has a task/attempt/resource-lease/ownership-lease mismatch or an active entry is shifted in place | Reject the lesson and require generic fence/reconcile plus a new attempt; knowledge cannot authorize reassignment | Binding, epoch, fence/reconcile, and unchanged ledger evidence |
| Capacity, usage, billing, or rate-limit refs are unauthenticated, non-monotonic, expired, or unknown | Treat capacity/headroom as zero at CAS, quarantine provider charges, and do not infer a how/why claim from them | Authenticated snapshot refs, sequence/TTL validation, and quarantine record |
| A refinement/effect intent lacks an applied marker after crash | Treat the effect as uncertain until broker nonexecution proof or fenced idempotent reconciliation; no canonical write or lease release is inferred | Intent/applied markers, idempotency key, broker result, and recovery record |
| Knowledge work would borrow process/session/model-call/token/recovery control capacity or overlap `exclusive_unisolated` work | Reject or serialize it away from the hard control partition; preserve verifier/red-team/recovery/control reserve | Partition accounting and host disposition |
| Fairness/aging/last-served/exploration quota or numeric hysteresis threshold/dwell/transition cap is absent | Preserve the last safe allocation and do not promote a lesson that would create starvation/thrash; safety stops remain bounded | Persisted fairness/hysteresis state and decision evidence |
| Expired lease lacks strong nonexecution proof by the finite reclaim deadline | Do not treat it as released capacity; retain quarantine and finite terminal escalation, never an indefinite reap obligation | Reclaim decision, process/provider proof, deadline, and terminal record |
| More than one adaptive review is pending/active or a newer observation supersedes one | Keep only latest pending/one active, cancel superseded pending work, fence active result, and prevent it from informing canonical state | Queue/supersession/cancellation digests and unchanged ledger |
| Improvement candidate fails baseline, held-out/replay/canary, or Goodhart/regression/safety review | Reject or atomically roll back; do not load the revision in future prompts/workflows | comparison evidence, red-team disposition, and rollback ref |
| Proposed refinement would change objective, scorecard, evaluator, authority, envelope, or scope | Route to the workflow's exact user approval decision; never treat knowledge persistence as consent | material-change decision and pending approval |
| MemPalace claims a record is current, authoritative, or indexed while canonical state/lease is stale | Show degraded/quarantined index status and trust only the canonical ledger; suppress projection until acknowledged | canonical/index digest and writer-lease evidence |
| Canonical or index controller crashes around a revision/lease/outbox boundary | Replay the last committed canonical state, quarantine uncertain work, and retry only with the same idempotency key or exact rollback CAS | journal boundary, epoch, outbox, and recovery artifacts |
| Resource capacity is unknown or control reserve is threatened during a review | Do not allocate from it; preserve verifier/red-team/host capacity and mark the review blocked or budget-limited | host-derived vector, reserve calculation, and blocker evidence |
| A control-capacity vector is missing, negative, non-finite, over-reserved, or not component-wise reconciled | Reject retention/admission; serialize `exclusive_unisolated` work away from hard control dimensions and preserve verifier/red-team/recovery capacity | Vector, partition, lease/grant sums, and rejection digest |
| A host-owned improvement scorecard lacks a required sample, hidden holdout/digest, effect/tolerance, non-regression, or cost/latency predicate | Reject the proposal and retain the prior canonical revision; a proposer cannot choose or omit holdouts | Frozen scorecard/manifests, host-selection proof, and comparison evidence |
| Revision registry status is stale, revoked, superseded, incompatible, or missing pinned bytes | Reject proposal/content/revision/evidence retention; fence affected records/leases/approvals/caches and retain pinned audit bytes | Registry epoch/event CAS, closure proof, fence set, and pinned refs |
| A preauthorized `KnowledgePolicyRef` has a missing or mismatched registry entry/ref, stale epoch/status, incompatible or expired policy, revoked/superseded/rolled-back revision, or failed resolver CAS | Reject admission, recall, and effect; preserve canonical state and fence affected records, leases, approvals, and caches | Exact policy entry/ref, epoch/status, kind/scope/privacy/blast-radius, compatibility, expiry, decision, revocation/rollback fields, resolver proof, and CAS event |
| `cron` cannot dereference or verify immutable objective/contract/scorecard/plan/critical-path/config/evaluator/guard/registry refs | Reject the snapshot/review and retain canonical state unchanged; mutable ledger/index paths cannot substitute evidence | Host dereference proof, per-ref digests, stale rejection, and unchanged ledger digest |
| Schedule, cadence, duty-cycle, review reserve, or per-window/phase/workflow bounds are zero, negative, non-finite, or over budget | Reject schedule/review CAS; no implicit retry or resident refinement loop | Bound validation, reserve partition, budget digest, and approval evidence |

The current `loadHarnessState` behavior that degrades unreadable state to an
empty in-memory state is insufficient for this design if it can cause a
subsequent write to overwrite the only copy. The implementation must preserve
the current file, consult the journal/last valid snapshot, and fail closed for
writes until recovery is explicit. Optional index failures may degrade to no
index; canonical corruption may not degrade to an invented empty ledger.

## Metrics and observability

Metrics are local aggregates with no raw memory content. They are evidence for
health, never targets that can authorize a write or completion.

### Safety and authority

- red-team coverage: semantic decisions reviewed / semantic decisions
  attempted, with missing-charter count;
- acceptance/rejection/blocked rates by trigger, kind, scope, and reason;
- global approvals, policy matches, expired/revoked tokens, and scope
  widening attempts;
- CAS conflict and idempotency-conflict counts;
- rollback success/conflict rate and maximum affected entry count;
- secret detections, scanner-policy revision, and zero-known-canary-projection audit;
- one-off, poisoning, duplicate, privacy, scope, and blast-radius findings.

### Recall and index

- canonical read latency and stale/conflict rate;
- MemPalace route selection, availability, health, and degraded duration;
- outbox age, pending/uncertain/failed/acknowledged counts, and projection
  lag by digest;
- index rebuild source/target counts, divergence, and repair duration;
- recall hit/empty/error rates for memory-relevant questions;
- source attribution (canonical versus adapter) and user correction rate;
- injected entry/drawer counts, bytes/tokens, truncation, and scope rejects.

### Refinement quality

- verified-milestone, repeated-failure, final-completion, explicit, timer, and
  compaction review counts;
- repeated audited failure signatures and accepted remedy recurrence;
- methodology RED/GREEN/REFACTOR pass/fail counts;
- post-refinement regression findings, rollbacks, and supersessions; and
- percentage of accepted entries with current independently verified evidence.

Every metric record includes a schema revision and measurement interval. A
claim such as “index healthy,” “memory saved,” or “refinement applied” is
rendered only when the corresponding local evidence exists.

## Anti-cheating and adversarial requirements

The host and audits must detect these attempts:

- claiming persistence from a worker message without a canonical commit;
- treating two copies of the same model-generated sentence as independent
  observations;
- embedding a secret in a title, digest, quote, base64 string, or procedure
  argument after the raw-content scanner blocks it;
- replacing a conflicting entry instead of recording supersession;
- changing a path label or scope field to make project knowledge appear global;
- using a MemPalace drawer as authority when its source digest is stale or its
  wing is outside the current workspace;
- hiding a large transcript inside a “single” entry to evade size/recall caps;
- using a retrieved instruction to approve itself, alter tool authority, or
  bypass the red team;
- accepting a duplicate/no-op as a new version merely to improve write-rate
  metrics;
- incrementing a version or timestamp while keeping stale evidence;
- shortening the injected text or removing conflict markers to improve a
  superficial prompt metric;
- reporting an adapter write as acknowledged after an ambiguous submission;
- deleting old entries before confirming a new superseding record;
- calling `global_=True` or setting `metadata.scope="global"` as a substitute
  for user approval/policy; and
- changing a methodology without RED baseline failure, GREEN proof, and
  REFACTOR pressure tests.

Any suspected attempt is a durable audit finding and blocks the affected
decision. It does not automatically poison unrelated local knowledge.

## Acceptance tests

Acceptance requires direct evidence from focused package tests plus local
integration processes. Mock-only red-team, writer-lease, or repair tests are
not sufficient for those boundaries.

### Canonical ledger

C-01. Create valid `how`, `why`, and prose/callable `procedure` records with
   required provenance, evidence, scope, privacy, retention, and digests.
C-02. Reject malformed kind/procedure/reference, unbounded content, missing
   evidence, wrong workspace binding, stale evidence, and secret-derived
   content without changing the ledger digest.
C-03. Load legacy `HarnessEntry` records without inventing evidence; classify them
   before global promotion, and fail closed on malformed/corrupt import without
   replacing the source with an empty state or publishing a partial candidate.
C-04. Keep prompt/base-system immutability and existing skill reference/arguments
   validation intact; prove a legacy snapshot cannot enter a prompt except via
   a committed canonical projection.

### Decision safety

C-05. Record recon, independent lenses, evidence verification, synthesis, and one
   fresh red-team context for every create/update/semantic-delete/rollback;
   assert the authoring context cannot supply its own verdict.
C-06. Reject one-off automatic content; accept an explicit user durability
   request only within approved scope.
C-07. Exercise each red-team charter finding: poisoning, privacy/secrets,
   duplication, scope, blast radius, and stale evidence.
C-08. Require explicit global approval or a matching separately user-approved,
    red-teamed, unexpired, unrevoked policy revision; reject `global_=True`
    without either. The host must resolve the exact policy registry entry/ref,
    epoch, approved status, kind/scope/privacy/blast-radius, compatibility,
    expiry, decision, and revocation/rollback fields with a CAS-bound resolver
    proof before admission, recall, or effect; `global_=True` cannot widen it.
C-09. Verify that changed proposal/evidence/scope/authority digests force a new
   red-team decision.

### Writer/CAS/recovery

C-10. Race two canonical writers and a replacement coordinator; show one
    serialized immutable-clone CAS commit, CAS conflict/replan where required,
    zero partial edits, and rejection of every stale-epoch
    append/snapshot/audit/outbox action.
C-11. Retry the same decision/key after commit and show one entry generation, one
    audit event, and one outbox event; verify a tombstone uses a closed reason
    enum and opaque HMAC deletion fingerprint without a raw protected digest.
C-12. Crash during prepared, committed-before-outbox, and outbox-retry phases;
    replay only committed state and preserve index lag.
C-13. Corrupt the canonical snapshot and verify the original is preserved,
    writes fail closed, and the last valid journal/snapshot is recoverable.
C-14. Roll back an unchanged target successfully; change the target first and
    verify rollback conflicts rather than clobbering the newer edit.
C-15. Confirm local and global stores never cross-edit and child sessions cannot
    acquire the global writer directly; verify workflow and knowledge stores
    are separate journal/reducer instances with isolated mutable state while
    using the same generic durable-store reducer implementation and host
    decision/CAS primitive.

### MemPalace adapter and routing — Milestone B only

Tests 16–21 are not Milestone A release gates and require the optional local
MemPalace runtime. Milestone A proves canonical-only behavior with the adapter
absent; it must not install, launch, or emulate MemPalace.

C-16. Run a local MemPalace 3.7.0 process with the supported local backend and
    project canonical records with stable IDs/generations/digests, then read
    them back with correct scope/privacy metadata and durable acknowledgement.
C-17. Exercise `direct`, `prefer`, and `require`; under `require`, stop the
    daemon and prove no direct writer starts. Under `prefer`, prove the direct
    path is used only after a safe lease decision.
C-18. Fire a hook write burst and prove one route decision/probe is reused,
    markers remain unchanged on a `require` block, and ambiguous submission
    never falls back directly.
C-19. Disable/uninstall the adapter and prove canonical writes/reads/refinement
    remain usable with a visible adapter-disabled status.
C-20. Corrupt the local vector index, preserve SQLite drawer rows, run the
    documented from-SQLite repair, and verify zero divergence before restart.
C-21. Rebuild projections only from active canonical records; tombstones prevent
    stale upserts from resurrecting forgotten entries, and all snapshot/prompt/
    outbox projections reject stale sequence or fencing epochs after restart.

### Recall and privacy

The canonical-only portions of tests 22–29 are Milestone A gates. Any clause
that queries or projects through MemPalace is a Milestone B gate.

C-22. Answer a historical query through canonical-first routing and, when
    enabled, bounded canonical-projection MemPalace excerpts with source/digest
    labels; raw-drawer namespaces are not queried.
C-23. Do not search the optional index for a pure greenfield query.
C-24. Inject only current canonical records and their current index projections,
    and enforce 8-entry/5-drawer/4,000-token/16,000-byte limits, deterministic counting,
    conflict markers, scope filtering, expiry, and untrusted-data delimiters;
    stale/conflict/index-only results remain display-only.
C-25. Return visible empty/error/degraded results rather than guessing when a
    required recall source is unavailable.
C-26. Verify scanner-covered secrets, nested/encoded canaries, and detected
    secret-derived values do not reach canonical files, evidence, outbox,
    embeddings, red-team findings, or recall injection; record the scanner
    revision and bounded coverage rather than claiming universal detection.
C-27. Verify user forget and retention expiry remove injection/projection and
    preserve an anti-resurrection tombstone.

### Refinement and methodology

C-28. Run refinement after a verified milestone, two compatible audited failures,
    final completion, and explicit user request; timer/compaction alone must
    not write a speculative entry.
C-29. Preserve deferred `refine.run()` scheduling, status, prompt rebuild after
    commit, rollback history, and existing completion/failure events; prove the
    Python harness/refine path emits only typed host requests and cannot mutate
    state/path/global storage or bypass the decision gate.
C-30. Run a methodology change through writing-skills RED/GREEN/REFACTOR and
    fail acceptance if any pressure-test phase is missing or weakened.
C-31. Prove an empty edit set and a blocked red-team review leave valid task
    evidence untouched.

### UI and observability

C-32. Show decision digests, red-team status/findings, scope, authority,
    evidence freshness, canonical commit, outbox/index status, and degraded
    reason in status/show/decision views.
C-33. Consume an approval token once through the exact typed action; duplicate
    approvals and changed proposals are rejected, while ordinary messages and
    unrelated resume/control commands leave it pending.
C-34. Forget, retention, disable-write, route, search, and rebuild controls
    produce inspectable local audit records.
C-35. Metrics contain no raw content and never authorize a write based on a
    proxy target.
C-36. Select an otherwise approved cloud resource envelope and prove every
    knowledge/refinement proposer, verifier, red team, evidence read, adapter
    request, and recall payload remains local with `egress = none`; reject an
    arbitrary or unverified provider helper before model input, and capture a
    denied network-trap attempt as blocked evidence.
C-37. Reorder delayed A/B/delete/recreate projection events and restart between
    each boundary; generation CAS and manifest rebuild leave exactly the newest
    canonical record and no orphan drawer.
C-38. Expire or delete evidence referenced by an active record; the same
    transaction marks the record stale/non-injectable before reference-aware
    garbage collection, and an index drawer alone cannot restore it.
C-39. Crash after every prepare/commit/artifact/snapshot/outbox boundary; replay
    yields exactly one authoritative committed journal state and recoverable
    projections, never an unjournaled snapshot.
C-40. Register local proposer, verifier, and red-team adapters with verified
    no-egress attestations; fail closed before any input on missing, stale,
    role-mismatched, or network-escaping adapters, and verify scan/redaction
    precedes every model input.
C-41. Verify the closed `user_confirmed` ordinary declarative provenance/binding
    branch activates only with host-validated principal, exact approval, host
    validation, user-assertion evidence, and null task/attempt/resource/
    ownership/adaptive refs, while user-confirmed callable/procedure branches
    remain blocked until their mandatory certificate/lease and independent
    execution/pressure evidence pass.
C-42. Verify native and AutoResearch how/why/procedure outputs produce the same
    typed `KnowledgeMutationProposal` and closed ordinary/adaptive binding;
    prompt/skill/reusable-role artifacts use the distinct methodology envelope
    and are rejected without writing-skills RED/GREEN/REFACTOR evidence and
    fresh verification.
C-43. Disable first-release raw transcript/project mining and verify existing raw
    drawers are display-only, untrusted, non-injected, and never canonical
    authority or evidence.
C-44. Bind approval, scope, evidence, leases, and audit records to stable opaque
    principal/workspace identities; moving or copying a path alone must not
    widen access or authorize a write. Policy registry entry/ref, epoch/status,
    discriminated kind/scope, exact decision, compatibility, expiry, and
    revocation/rollback resolver proofs are host-verified and CAS-checked
    before any policy-gated admission, recall, or effect.
KAD-01. Each workflow/methodology phase, incident, and completion gate creates a
    bounded generic improvement proposal/review/result/event lifecycle from
    accepted evidence or an explicit empty set; durable, native, AutoResearch,
    and knowledge producers use that lifecycle, and a timer, context compaction,
    queue telemetry, or model self-score alone cannot create canonical
    knowledge.
KAD-02. Improvement candidates compare the current approved revision with the same
    baseline cases and required held-out/replay/canary cases, and preserve exact
    evidence, variance, resource cost, and scope digests. The host-owned
    evaluator/parser and scorecard fix metric direction, aggregation,
    variance/repeatability, deterministic risk, required samples,
    effect/tolerance, mandatory hidden holdout and `heldOutInputDigest`,
    non-regression, and cost/latency predicates; the proposer cannot choose or
    omit a holdout.
KAD-03. An independent verifier plus Goodhart, regression, and safety red teams
    inspect every improvement revision; missing/stale evidence, a changed
    baseline, a secret, a scope/authority increase, or a proxy-only gain blocks
    promotion.
KAD-04. Compatible improvement applies as one registry-epoch CAS transaction
    with before/after snapshots, rollback-of/event-sequence metadata, reload and
    future-load verification, outbox intent, and rollback metadata; rejected,
    conflicting, stale, or regressed proposals produce no partial record or
    projection.
KAD-05. Future workflows, prompts, and methodology invocations load only approved
    compatible revisions from the canonical revision registry; rejected,
    unverified, stale, and rolled-back candidates cannot enter prompt projection
    or optional indexing. Compatibility closure, discriminated scope binding
    with session/knowledge decision refs, status, and epoch/event CAS are checked
    before phase/effect. A `revisionKind:"knowledge"` entry requires
    `scope:"knowledge"` plus an exact session- or workflow-scoped
    `knowledgeDecisionRef`/`knowledgeEntryRef`; kind/scope mismatches cannot
    widen authority. Preauthorized policy admission, recall, and effects also
    require the exact registry entry/ref, epoch/status, policy kind/scope/
    privacy/blast-radius, compatibility, expiry, decision, and
    revocation/rollback fields with host resolver/CAS proof. Superseded or
    revoked entries fence affected records, leases, approvals, and caches while
    pinned bytes remain for audit.
KAD-06. Adaptive resource observations can be stored only as accepted how/why/
    provenance evidence; the knowledge writer cannot choose a critical path,
    allocate/release a lease, consume control reserve, or expand cloud/spend/
    authority/envelope limits.
KAD-07. Optional MemPalace records remain derived indexes: canonical commit precedes
    projection, stale/corrupt/disabled index state is visible and non-authorizing,
    and no drawer can approve memory, allocation, workflow, or completion state.
KAD-08. Crash tests around improvement proposal, canonical CAS, writer/lease fencing,
    reload, rollback, and outbox publication restore the last committed revision
    or quarantine and reconcile the uncertain effect without blind replay.
KAD-09. Unknown capacity, missing no-egress adapter attestations, threatened control
    reserve, and envelope/authority expansion fail closed or request exact user
    approval; no background infinite refinement loop or hidden resource use is
    admitted in the first release.
KAD-10. The approved resource envelope carries the `cron` trusted clock/cadence,
    monotonic clock observation/sequence and persisted last-admitted window,
    major-transition trigger set, exactly-once window, one-catch-up-after-restart
    rule, positive finite cadence/duty-cycle and per-window/phase/workflow
    ceilings, and bounded reviewer overhead/cost reserve; schedule changes
    require a new exact resource/configuration decision and approval.
KAD-11. Each knowledge-layer `cron` review consumes one fresh independent read-only
    snapshot of critical path, queues, leases, cost, latency, accepted progress,
    evidence gaps, uncertainty, and control reserve, including immutable
    objective/contract/scorecard/invariant/plan/critical-path/config/evaluator/
    guard/registry refs and digests. Host dereference and stale rejection
    precede review; invocation binds reviewer child identity, read-only
    capability proof, admission/leases, epoch, execution key, and token, and a
    typed success/failure result records actual usage. It checks underuse,
    overuse, redundancy, serializable work, context churn, verification/red-team
    starvation, review overhead, cloud cost, and Goodhart risk.
KAD-12. `cron` suggestions remain immutable evidence-only artifacts with zero write,
    lease, allocation, approval, or completion authority; applying one requires
    the full decision/red-team/approval pipeline and never writes directly.
KAD-13. Window CAS rejects overlapping, backward, duplicate, or replayed window
    sequences and coalesces major-transition triggers; restart admits exactly
    one validated catch-up and discards older missed windows without backlog
    replay or extra model turns.
KAD-14. A late, failed, stale, malformed, or unavailable reviewer is bounded and
    nonblocking, preserves canonical state and the last safe allocation, and
    cannot consume verifier, red-team, recovery, or control-plane reserve.
KAD-15. Only an accepted how/why/provenance record may retain a `cron` lesson or be
    indexed by MemPalace; raw suggestions cannot enter prompt projection,
    resource policy, workflow authority, or completion state.
KAD-16. Replaying the accepted workflow DAG, typed host-derived remaining-work
    estimates, host-observed novelty proofs, and policy digest yields the same
    independently admitted host critical-path certificate and ordering by
    time-to-genuine-proof, evidence gap, cost, uncertainty, queue age, and
    deterministic task ID/digest.
KAD-17. Knowledge lessons and adaptive entries retain task-value, task, attempt,
    discriminated capacity grant, resource-lease, and ownership-lease bindings;
    claimed/active work is fence/reconciled before a new attempt, and only
    unclaimed slots move.
KAD-18. Authenticated monotonic TTL-bound capacity, usage, billing, and rate-limit
    refs make stale/expired/unknown headroom zero at allocation CAS, including
    provider charges; canonical knowledge never fills the gap with inference.
KAD-19. Process/session/model-call/token/recovery control partitions remain hard,
    and `exclusive_unisolated` work is serialized away from the control plane;
    knowledge and MemPalace cannot borrow or authorize those resources. The
    generic `WorkflowCanonicalPoolLedger` separates instantaneous concurrency
    from cumulative spend with exhaustive components. Every
    `WorkflowControlCapacityVector` component is reconciled in admission,
    leases, grants, partitions, observations, and allocation CAS.
KAD-20. Crash tests around refinement/effect intent and applied markers prove
    nonexecution or fenced idempotent reconciliation before canonical writes,
    lease release, or provider-charge reuse; ambiguous effects remain quarantined.
KAD-21. Persisted aging, last-served, bounded priority-bucket promotion, finite
    exploration quota, numeric benefit threshold, minimum dwell, transition cap,
    positive finite/range-validated fairness/hysteresis values, and safety-only
    override prevent starvation/thrash across restart. Review admission remains
    latest-wins with one pending/one active, superseded cancellation, positive
    finite duty-cycle and per-window/phase/workflow bounds, and a reserve
    disjoint from planner, verifier, red-team, recovery, and control work.
KAD-22. Expired leases reclaim only after strong process/provider nonexecution proof;
    otherwise a finite terminal escalation is recorded without an indefinite
    user-reap dependency.
KAD-23. Rapid adaptive observations maintain one latest pending and one active
    review; superseded pending work is cancelled, active work is fenced, and
    its result cannot enter canonical state.
KAD-24. A retained task/value lesson names an unproven requirement/evidence gap,
    host-observed novelty proof, typed bounded observable outcome, and finite
    exploration quota; proposal/content/revision/evidence schemas retain closed
    ordinary/adaptive binding, typed certificate/digest, task/attempt,
    discriminated capacity grant, resource/ownership lease, adaptive
    observation/review, and host-validation refs, and missing, stale, mismatched,
    or unvalidated fields are rejected before retention or indexing.

## Implementation boundaries and rollout

The implementation should introduce focused modules rather than making
`AgentSession` a knowledge database:

- typed knowledge schema/normalizer and legacy projection;
- evidence store and digest verifier;
- red-team decision contract and authority/policy evaluator;
- canonical writer lease, CAS transaction, idempotency journal, and rollback;
- index outbox/replay and adapter capability contract;
- MemPalace local adapter with explicit routing/maintenance modes;
- recall router and bounded injection formatter;
- status/UI commands over existing local/session control paths; and
- metrics/audit reducer.

The comprehensive target is delivered through two independently verifiable
milestones so optional recall machinery cannot delay or weaken canonical
correctness:

**Milestone A — canonical knowledge and refinement authority**

1. Add typed metadata/provenance/evidence validation while keeping existing
   local refinement behavior observable.
2. Add fresh red-team and authority gates in proposal/apply paths.
3. Add canonical writer CAS/idempotency/rollback journal and recovery tests.

Milestone A is the minimum native release. It includes canonical-only recall,
scope/privacy/retention controls, corruption fail-closed behavior, and no
MemPalace runtime dependency.

**Milestone B — optional local MemPalace projection and recall**

4. Add outbox and disabled/degraded adapter state with no MemPalace dependency
   in the core path.
5. Add the local MemPalace 3.7.0 adapter, lease-aware routing, and repair
   integration.
6. Add canonical-first recall, bounded injection, and user controls.
7. Add event-based refinement triggers and methodology pressure tests.

Milestone B is complete only after generation ordering, manifest rebuild,
local-backend rejection, read-after-write acknowledgement, and degraded-mode
tests pass. Raw transcript mining, knowledge-graph promotion, import/export,
and broad historical UI are not prerequisites for either milestone and may be
added later through the same universal gate and privacy model.

Each stage must preserve non-workflow sessions, existing refine scheduling,
base prompt immutability, local/global separation, and the current daemon
protocol. After code changes, the repository's required `npm run check` and
focused tests run from the package root; adapter/lease/recovery acceptance
also uses real local processes and files.

## Source-grounded constraints

This design was based on the current repository and the local MemPalace
checkout:

- Prime Agent refinement types and behavior: `packages/coding-agent/src/core/refinement/refinement.ts`.
- Kernel refine bridge: `packages/coding-agent/skills/refine/SKILL.md` and
  `packages/coding-agent/skills/refine/src/refine/__init__.py`.
- Existing harness persistence/rollback notes:
  `packages/coding-agent/docs/rlm-runtime.md`.
- MemPalace identity/version/license: local `README.md`, `pyproject.toml`,
  and `LICENSE` under `/Users/nathanballou/.claude/plugins/marketplaces/mempalace`.
- MemPalace write routing and single-writer policy:
  `docs/write-routing-policy.md` and `docs/hook-write-routing.md`.
- MemPalace recall behavior and repair procedure:
  `integrations/shared/recall-protocol.md`.
- MemPalace temporal graph schema:
  `docs/schema.sql`.
- MemPalace hook wiring: the plugin hook manifest, hook launcher, and
  `hooks/README.md`.

The source documents describe MemPalace as local-first, verbatim, pluggable,
and MIT-licensed, but they do not make it a trusted semantic authority for
Prime Agent. That authority boundary is intentional in this design.
