# Exact-turn worker recovery authority

## Context

PR #1315 closes unresolved tool calls after an isolated daemon worker dies. The
current recovery request identifies only a session path, active runtime id, and
operation names. The catalog process therefore reopens whichever branch is
active when recovery runs, closes tool calls in its latest assistant turn, and
always appends a recovery marker.

That is unsafe when the session has advanced, branched, or been replaced after
the worker died. It is also not idempotent when persistence succeeds but the
catalog response is lost. A retry can append the marker again, and concurrent
requests can duplicate synthetic results.

## Goals

- Bind recovery mutation authority to the exact persisted session generation,
  branch lineage, branch head, and assistant tool-use turn observed by the dead
  worker.
- Never mutate work produced by a newer or different session owner.
- Make the complete recovery operation idempotent across response loss,
  concurrent duplicate requests, and partial multi-result persistence.
- Preserve the warning that execution and external side effects are unknown.
- Keep the change local to worker recovery rather than adding a general session
  transaction framework.

## Non-goals

- Replaying interrupted model or tool execution.
- Recovering legacy busy journal records that lack mutation authority.
- Making arbitrary direct `SessionManager` writers transactional.
- Changing normal session branching semantics.

## Recovery authority

Worker recovery records move to a validated v2 shape. Each exact-authority busy
epoch has one stable `operationId`, created at its first durable checkpoint and
reused while that authority remains unchanged. An authority change starts a new
epoch even if the worker never reported idle. Every busy checkpoint records:

- `activeSessionId`: runtime identity for diagnostics.
- `sessionId`: persisted session generation from the session header.
- `sessionFile`: canonical target path.
- `agentDir`: the exact session-lease namespace, including custom agent dirs.
- `headEntryId`: exact active branch head, including `null` for an empty branch.
- `assistantEntryId`: latest assistant entry on that branch, when one exists.
- `toolCalls`: the exact unresolved `{ id, name }` set declared by that assistant
  entry at the checkpoint; tool-execution event payloads preserve the active id.
- `lineageDigest`: SHA-256 over the ordered active branch entry identities and
  parent links through `headEntryId`.
- `operationId`, `operation`, `busy`, and `recordedAt`.

The checkpoint is captured from one in-memory `SessionManager` view. Changes to
session generation, path, head, assistant entry, tool calls, or lineage force a
new journal record and operation id even when the event name is unchanged. Idle
records end the busy epoch; the next busy transition also receives a new
operation id. Journal writes use a
journal-local cross-process guard. Recovery completes an epoch with a
compare-and-set on `operationId` after re-reading the latest record, so it
cannot overwrite a newer busy epoch created by a resumed worker.

A journal write failure remains fail-safe: execution may continue, but later
recovery has no valid authority and therefore performs no transcript mutation.
Legacy v1 busy records are likewise classified stale without mutation.

## Catalog recovery protocol

The supervisor sends the complete v2 authority and operation names to the
catalog. The catalog returns one of `applied`, `already_applied`, or `stale`.
Persistence errors remain request failures so the supervisor retains the busy
journal for retry.

Recovery requests are serialized by canonical session path inside the catalog.
While processing a request, the catalog acquires the existing cross-process
session lease with leases explicitly enabled and an owner id derived from the
recovery `operationId`. A lease held by a normal live session owner makes
recovery `stale`; a lease held by another recovery attempt is retryable rather
than stale. A new session owner cannot open the file until recovery releases
its lease.

Under the lease, recovery follows this order:

1. Search all entries for a `prime-agent.worker_recovery` marker carrying the
   same `operationId`. If found, return `already_applied` without writing. This
   is global rather than active-branch-only so later branching cannot cause a
   completed operation to be applied again.
2. Open the session and verify `sessionId`.
3. Verify that the active branch prefix through `headEntryId`, its
   `lineageDigest`, and `assistantEntryId` exactly match the journal authority.
4. Permit only a suffix of synthetic tool results owned by the same
   `operationId`. This is the sole allowed head advance and supports retry after
   partial multi-result persistence. Any ordinary entry, different operation,
   different branch, or different head makes the request `stale` without a new
   write.
5. Close only the journaled tool-call ids declared by the authorized
   assistant entry, without depending on its terminal `stopReason`. Synthetic
   results retain the existing unknown-side-effects wording and include
   recovery metadata with `operationId` and `assistantEntryId`.
6. Append exactly one final recovery marker carrying `operationId`, the
   authority, and operation names. The marker is committed only after all
   synthetic results.

If an append fails after some synthetic results, the request fails. A retry can
recognize the owned suffix and append only the missing results and marker. If
new work appears after that partial suffix, the retry becomes stale instead of
mutating the newer work.

## Supervisor completion

For a worker with several uncertain sessions, catalog calls may partially
succeed. Successful operations are safe to replay because their markers are
idempotency records. The supervisor conditionally clears each busy journal
entry only after its catalog result is `applied`, `already_applied`, or `stale`.
The compare-and-set
succeeds only if the latest on-disk record still has the recovered
`operationId`; a newer worker checkpoint is never clobbered. A request or
persistence failure leaves the original entry busy for retry.

A stale result is logged with its operation id and reason. It intentionally does
not add even a warning marker because the recovery process no longer owns the
active transcript.

## Failure and race behavior

| Scenario | Result |
| --- | --- |
| Exact unchanged interrupted turn | Missing synthetic results and one marker are appended. |
| Session advanced before recovery | `stale`; zero bytes appended. |
| Session branched to another head | `stale`; zero bytes appended. |
| Path replaced by another session generation | `stale`; zero bytes appended. |
| Same path receives a newer tool-use turn | `stale`; newer calls remain untouched. |
| A normal live owner holds the session lease | `stale`; zero bytes appended. |
| Another recovery holds the session lease | Retryable failure; journal stays busy. |
| Response lost after marker commit | Replay returns `already_applied`. |
| Concurrent duplicate requests | Per-path serialization yields one apply and idempotent no-ops. |
| Failure after some synthetic results | Replay resumes only the same operation-owned suffix. |
| New work follows a partial recovery suffix | `stale`; no further mutation. |
| Legacy journal lacks authority | `stale`; zero bytes appended. |

## Tests

Focused tests must prove:

1. v2 parsing, stable operation ids within a busy epoch, new ids after idle, and
   deduplication that includes all authority fields.
2. Exact-authority recovery closes only the authorized assistant turn and
   appends one marker.
3. Advance, alternate branch, session replacement, same-path newer tool-use,
   lineage mismatch, and held-lease cases append no bytes.
4. Response-loss replay and concurrent duplicate requests produce exactly one
   result per tool call and one marker.
5. Injected failure after the first of several results can resume without
   duplicates; a foreign suffix after partial persistence blocks continuation.
6. Supervisor retry retains busy records on request failure but clears them for
   applied, already-applied, and stale outcomes.
7. Existing interrupted-result wording and ordinary session behavior remain
   unchanged.

## Acceptance criteria

- Every recovery mutation is authorized by an exact v2 checkpoint and protected
  by the session lease.
- Any authority mismatch produces a byte-for-byte unchanged session file.
- One operation id can produce at most one recovery marker and one synthetic
  result per authorized tool call.
- Focused tests, type checking, formatting, and linting pass for the exact PR
  head.
