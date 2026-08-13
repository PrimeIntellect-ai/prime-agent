# Exact-turn worker recovery implementation plan

**Design:** `docs/superpowers/specs/2026-08-13-exact-turn-worker-recovery-design.md`

## Test seams

The approved design fixes three observable seams:

1. `WorkerRecoveryJournal`: durable v2 authority epochs and conditional completion.
2. `SessionManager`: exact-authority, resumable closure of one assistant tool-use turn.
3. `DaemonCatalogClient.markInterrupted`: lease-fenced, idempotent catalog recovery result consumed by the supervisor.

Tests exercise these public module boundaries and persisted JSONL output rather than private helpers.

## Commit 1 — journal exact recovery authority

Files:

- `packages/coding-agent/src/modes/daemon/worker-recovery-journal.ts`
- `packages/coding-agent/src/modes/daemon/daemon-mode.ts`
- `packages/coding-agent/test/worker-recovery-journal.test.ts`
- focused daemon-mode tests only if needed

Red/green slices:

1. Parse v2 records and ignore legacy busy records for mutation authority.
2. Keep one stable `operationId` during a busy epoch; allocate a new id after idle.
3. Deduplicate only identical authority, including session generation, head, assistant, tool calls, and lineage.
4. Capture authority from one active-branch snapshot without discarding tool event identity.
5. Add compare-and-set completion that cannot overwrite a newer busy epoch.

Focal command:

```bash
npm --prefix packages/coding-agent test -- test/worker-recovery-journal.test.ts
```

## Commit 2 — exact and resumable session mutation

Files:

- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/test/session-manager/interrupted-tool-results.test.ts`

Red/green slices:

1. Accept exact authority and reject generation, head, assistant, lineage, or tool-call mismatch without writing.
2. Append only journaled tool-call ids from the authorized assistant entry.
3. Tag synthetic results with `operationId` and resume an operation-owned partial suffix.
4. Reject foreign/newer suffixes.
5. Make stop reason irrelevant when exact tool calls are journaled.

Focal command:

```bash
npm --prefix packages/coding-agent test -- test/session-manager/interrupted-tool-results.test.ts
```

## Commit 3 — catalog lease, idempotency, and supervisor completion

Files:

- `packages/coding-agent/src/modes/daemon/daemon-catalog-process.ts`
- `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts`
- `packages/coding-agent/test/daemon-catalog-process.test.ts`
- `packages/coding-agent/test/daemon-supervisor-monitor.test.ts`

Red/green slices:

1. Extend the catalog request/response with v2 authority and `applied | already_applied | stale`.
2. Serialize by canonical path and acquire the session lease before open/verify/append.
3. Deduplicate globally by recovery marker `operationId`.
4. Retry partial result persistence and response-loss replay without duplicates.
5. Complete only matching journal operation ids; retain busy state on catalog failure.
6. Cover advance, branch, replacement, live owner, same-path new tool turn, duplicate concurrency, and partial persistence.

Focal commands:

```bash
npm --prefix packages/coding-agent test -- test/daemon-catalog-process.test.ts
npm --prefix packages/coding-agent test -- test/daemon-supervisor-monitor.test.ts -t "worker recovery"
```

## Exact-head verification

Do not run the daemon-capable full repository suite from the live Prime Agent runtime. Run only focal in-process tests, then static gates:

```bash
npm --prefix packages/coding-agent test -- \
  test/worker-recovery-journal.test.ts \
  test/session-manager/interrupted-tool-results.test.ts \
  test/daemon-catalog-process.test.ts
npm --prefix packages/coding-agent test -- \
  test/daemon-supervisor-monitor.test.ts -t "worker recovery"
npx biome check --error-on-warnings <changed files>
npx tsgo --noEmit
```

Finish with independent code/security review over the exact commit and address every P0/P1/P2 finding before push.
