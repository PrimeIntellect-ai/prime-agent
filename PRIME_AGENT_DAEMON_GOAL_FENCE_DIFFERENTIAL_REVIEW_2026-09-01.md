# Prime Agent conditional-goal differential review

## Executive summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

**Overall risk:** high-impact control-plane change, mitigated by exact fences and
failure-injection coverage. **Recommendation:** APPROVE after rebasing the one
new `origin/main` commit and repeating the full gate.

Thirteen changed files were reviewed (7 production/docs, 6 test), with 1,579
additions and 107 deletions against `9f5edc192`. The change affects persisted
goal state, daemon admission, cron recovery, session restore, and the public
daemon protocol. No validation removal or prior security-fix regression was
found.

## What changed

- A conditional `/goal` admission persists a bounded receipt and phase before
  provider execution (`agent-session.ts:5374`, `agent-session.ts:6138`).
- Recovery commits its counter before queueing; the fifth failure terminalizes
  both goal and cron receipt (`daemon-mode.ts:1538`, `cron-jobs.ts:716`).
- Restores rebind conditional jobs only for the exact stable session file, while
  rotating the daemon-local active ID (`cron-jobs.ts:292`).
- Sanitized session summaries expose only receipt/phase metadata needed by CTO;
  protocol schema/capability negotiation rejects mixed-version guarded calls.

## Adversarial analysis

Attacker model: a stale or racing local coordinator able to issue daemon cron
requests, but unable to alter the private session file. The relevant attacks
are duplicate `/goal` delivery, cross-root delivery after `switch_session`, and
crash-after-receipt loss.

All three paths fail closed: admission compares the exact idle-root fence;
conditional rebind requires the same resolved session file; recovery recognizes
only the exact receipt and refuses unfinished actions; the provider boundary
requires active status, matching receipt, and `receipt` phase. Retry exhaustion
produces a terminal durable marker instead of unbounded replay.

## Test coverage and blast radius

The five new/modified critical methods occur in 2–4 source/test files each,
giving a low direct caller count but high operational impact. Coverage includes
receipt persistence failure, provider-boundary invalidation, daemon death,
counter-write failure, fifth-attempt exhaustion, queued fifth-attempt guard,
same-file restore, and cross-file switch-session refusal.

Validation observed before compatibility rebase:

- `npm run check`: pass.
- Six focused Vitest files: 386/386 pass.
- Biome formatting/lint and TypeScript checks: pass.

## Historical context

`rebindSessionJobs` originated in `ce095e9fc` (session/heartbeat support). The
review preserves its generic live-session migration behavior while narrowing
only conditional jobs to stable-file identity. Removed persistence code was
replaced by persist-before-memory/side-effect logic; no security-motivated
guard was removed without replacement.

## Recommendations

- Rebase `origin/main`, inspect the combined diff, and repeat all gates.
- Install Prime before the dependent CTO skill so schema 24 and
  `conditional_cron_delivery` negotiate atomically.
- Keep the 72-hour soak and injected daemon/session failures as the production
  acceptance gate.

## Methodology

FOCUSED differential review: all changed files, one-hop callers, removed-check
scan, history search, state-flow tracing, adversarial race/crash scenarios, and
independent Sol/xhigh review. Confidence is high for the changed control-plane
scope; external provider behavior and the pending 72-hour soak remain outside
this pre-merge proof.
