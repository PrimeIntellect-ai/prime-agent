# Prime Agent Runtime Contracts

Prime Agent is a persistent recursive-agent runtime. Coding is one workload; the core repository is responsible for ordering probabilistic work, preserving durable state, recovering from process failure, and reporting completion without losing or duplicating effects.

This document defines the contracts that changes to the scheduler, daemon, kernel bridge, agent messaging, compaction, and continual harness must preserve.

## Runtime model

Represent the runtime state as

\[
X = (C, E, S, K)
\]

where:

- `C` is the control plane: action admission, ordering, cancellation, retry, and quiescence;
- `E` is the execution plane: model streams, tools, IPython kernels, and child agents;
- `S` is the state plane: transcripts, artifacts, checkpoints, budgets, and harness state; and
- `K` is the coordination plane: daemon supervision, workers, clients, schedules, and agent messages.

Each observable event advances one state machine:

\[
X_{n+1} = \delta(X_n, e_n)
\]

Typical events are prompt admission, tool completion, message arrival, abort, worker crash, restart, compaction, refinement commit, and heartbeat delivery.

The implementation should maximize useful progress subject to safety, liveness, and budget constraints:

\[
\max \operatorname{Progress}
\quad \text{subject to} \quad
\operatorname{Safety}=1,
\operatorname{Liveness}=1,
\operatorname{Cost}\le B.
\]

## 1. Single ownership

Every turn-producing input has exactly one authoritative owner.

\[
\forall a,\quad |\operatorname{Owner}(a)| = 1.
\]

`ActionStore` owns session actions. Client, daemon, heartbeat, goal, agent-message, and child-spawn entry points may request admission, but must not create a second direct-dispatch path around the store.

The legal lifecycle is:

```text
queued
  -> selected
  -> preparing
  -> committing
  -> running
  -> completed | failed | cancelled
```

A rollback from `committing` to `queued` is valid only after dispatch has settled and durable transcript evidence proves that no primary message was committed.

## 2. Effectively-once durable effects

Network delivery can be at-least-once. Durable effects must nevertheless be effectively once.

\[
\operatorname{AtLeastOnceTransport}
+
\operatorname{PersistentDeduplication}
=
\operatorname{EffectivelyOnceEffect}.
\]

For each logical command or message:

- its logical identity is stable across transport retries;
- a durable receipt is written before dispatch;
- an uncertain receipt without a result is never replayed automatically;
- a completed result is replayed rather than re-executed; and
- one identity cannot be reused for a different command or payload.

### Daemon command-journal invariant

The current daemon journal key is

\[
K = \operatorname{JSON}([clientId, commandId]).
\]

For a key `K`, exactly one command type is legal:

\[
\operatorname{Received}(K,t_1)
\land
\operatorname{Received}(K,t_2)
\Rightarrow
t_1=t_2.
\]

A durable result must match both the command id and command type in the receipt:

\[
\operatorname{Result}(K,r)
\Rightarrow
r.id=receipt.commandId
\land
r.command=receipt.commandType.
\]

Only one malformed record is tolerated: an unterminated final append produced by a crash. Malformed or inconsistent records before that boundary are ambiguous and recovery must fail closed.

The next protocol revision should add a canonical payload digest:

\[
K' = H(clientId, commandId, commandType, canonicalPayload).
\]

That change requires a daemon protocol migration; the current journal hardening deliberately preserves the wire format.

### Current integration boundary

`CommandRecoveryJournal.lookup()` accepts an optional `commandType` and validates it before returning a pending or completed entry. The current supervisor preflight still calls `lookup(clientId, commandId)` without that third argument, before its later `begin(..., command.type)` call.

The supervisor integration must be changed to:

```ts
this.commandJournal.lookup(
  journalIdentity.clientId,
  journalIdentity.commandId,
  command.type,
)
```

and covered by a socket-level regression for both pending and completed entries. Until that call site is updated, command-type consistency is enforced during journal admission, result recording, and recovery loading, but not at the supervisor's earliest replay/uncertain-result branch. This limitation is recorded explicitly rather than presenting the journal-only change as an end-to-end exactly-once proof.

## 3. Linearizable quiescence

A session may report idle only when there is no queued, committing, running, or already-scheduled future work.

\[
\operatorname{Idle}
\Rightarrow
Q=C=R=F=\varnothing,
\]

where:

- `Q` is queued work;
- `C` is preparing or committing work;
- `R` is active provider, tool, kernel, or child work; and
- `F` is owned future work such as a post-compaction continuation.

A correct external `end_turn` needs a quiescence epoch or lease. Repeating `waitForIdle()` reduces races but is not a linearization point if new work can be admitted between the final check and response publication.

## 4. Recovery XOR

After a crash, every accepted action is either durable or restorable, never both and never neither.

\[
\operatorname{Durable}(a)
\oplus
\operatorname{Restorable}(a).
\]

The recovery implementation must reject states that would make the following true:

\[
\operatorname{Durable}(a)
\land
\operatorname{Restorable}(a),
\]

because that permits duplicate effects.

## 5. Monotonic cancellation

Cancellation flows from a parent operation to all descendants.

\[
\operatorname{Cancel}(p)
\Rightarrow
\forall d\in Desc(p),\quad
\Diamond\operatorname{Terminal}(d).
\]

Abort listeners remain installed until the child run reaches `done`, `error`, or `cancelled`. Publishing a child session is not terminal settlement and must not detach cancellation propagation.

## 6. Harness view consistency

The harness visible in the system prompt and the harness reachable through the kernel must describe the same logical revision.

\[
H_{prompt}=H_{query}.
\]

A child view should be explicit:

\[
H_{view}=G_r\oplus P_r^{RO}\oplus C_r^{RW},
\]

where global state and parent-local state are read-only snapshots and child-local state is writable. The view should carry an opaque revision id. Refinement apply is a compare-and-swap operation against that revision.

A preview approval contract requires canonical equivalence:

\[
Canonical(Preview(plan))=Canonical(Applied(plan)).
\]

Preview output therefore must include every field that apply may mutate, including path, reference, arguments, and metadata.

## 7. Provider checkpoints are adapter state

Opaque provider checkpoints belong behind a generic provider-checkpoint interface. Core session messages should not acquire one field per provider.

Context knowledge is not just a nullable integer. Prefer an explicit epistemic type:

```ts
type ContextKnowledge =
  | { kind: "known"; tokens: number }
  | { kind: "lower_bound"; tokens: number }
  | { kind: "bounded"; lower: number; upper: number }
  | { kind: "unknown"; reason: string };
```

## 8. Required verification

Changes to the runtime core should include tests for:

- duplicate, delayed, and reordered messages;
- abort at each await boundary;
- worker crash before and after durable append;
- supervisor restart after command receipt and after result persistence;
- repeated result recording;
- corrupted interior journal records;
- false-idle and scheduled-continuation races;
- parent disposal with live child model/tool execution; and
- harness preview/apply revision conflicts.

The minimum properties are:

\[
\forall a,\quad TranscriptCount(a)\le1,
\]

\[
Admitted(a)\land Fair\land\neg Cancelled(a)
\Rightarrow
\Diamond Terminal(a),
\]

and

\[
ReportedIdle(e)
\Rightarrow
PendingAtEpoch(e)=0.
\]

## Upstream integration order

For this fork, integrate upstream work by contract rather than by feature surface:

1. provider accounting and narrow adapter fixes;
2. daemon startup and retry idempotency;
3. scheduler liveness and heartbeat cadence;
4. ACP quiescence as one stacked change;
5. revisioned harness views followed by canonical preview/apply;
6. generic provider checkpoints; and
7. a structured cancellation tree.

Do not combine competing semantics in one integration. In particular, heartbeat phase-preserving coalescing and fixed one-minute retries are alternative scheduling policies and require one explicit decision.
