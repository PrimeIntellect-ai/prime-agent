# PA-AGI Composed Contract-Gate Program Plan — Candidate Generation 8, Repair Round 10

**Status:** Non-effective draft. **Candidate generation:** 8. **Repair round:** 10 (non-authority metadata).  
**Admission:** `sha256:e9c74f38208bc105f100108e00e67a0a3a2037bba203eef919121f36f13a18f7`. **Authorization:** `sha256:86b4a1cd4667f48962d0cd045629e4d13a97e373be0ad38d6c6b75e24bb3307f`. **R10 review:** `sha256:185173919f97b2d870716b31d422ce63f01515068129f6cf94a4bd48474cc267` (`P0=0`, `P1=1`, `P2=0`). **R9 post:** `sha256:7a65592b1cc05209d85c124920ed9528bbc4d516f4af4984b0c94ae6fe7a0696` PASS.

## 0. Generation rule

Candidate generation, Parent generation, request generation and Owner decision generation are all exactly **8**. The request remains `ccg-owner-auth-request-2026-08-23-r8`; the future receipt remains `OWNER-DECISION-G8.json`. `repairRound=10` records drafting process only. It does not create generation 9/10 authority, widen scope or change lineage.

## 1. R10 closure

**P1-1 RESOLVED:** Candidate generation is exactly 8 in plan, Parent, package, Owner request and handoff. repairRound=10 is separate non-authority process metadata. G8 request/OWNER-DECISION-G8 remain exact.

All candidate-generation claims use 8. The package and handoff no longer claim generation 9. The prior repair-round-9 bytes are superseded by hash only, not treated as authority generation 9.

## 2. Preserved properties

All R1-R9 fixes remain: zero active lower-than-G8 Owner references; 24 actual-Parent-contained ActionContracts; exact bootstrap path; AGENTS/dashboard gates; mutable DB seams; exact endpoint; sole wrapper; `/opt/homebrew/bin/python3`; observed restart argv with `-u` and no `--out`; future G8 Owner receipt; accepted-source post-final process proof; effects, budget and identities.

## 3. Ordered tasks

### P0 / G0_BASELINE — Freeze baseline and threat model

- Worker `ccg-p0-worker`; Reviewer `ccg-p0-reviewer`; terminal `baseline_frozen`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P0-baseline-gate.py` -> `COMPOSED_P0_G0_BASELINE_GREEN`.
- Rollback: Delete only P0-created staging/design candidates; preserve immutable preimages.

### P1 / G0_SCHEMA — Compile closed schemas and current project policy

- Worker `ccg-p1-worker`; Reviewer `ccg-p1-reviewer`; terminal `schema_policy_compiled`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P1-schema-policy-gate.py` -> `COMPOSED_P1_G0_SCHEMA_GREEN`.
- Rollback: Remove P1 staging candidates and retain P0 baseline.

### P2 / G1_AUTHORITY — Compile authority, lineage, addendum chain and claim containment

- Worker `ccg-p2-worker`; Reviewer `ccg-p2-reviewer`; terminal `authority_chain_compiled`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P2-authority-gate.py` -> `COMPOSED_P2_G1_AUTHORITY_GREEN`.
- Rollback: Discard failed generation; retain prior compiled aggregate append-only.

### P3 / G2_ROLE — Implement visible role admission and pre/post receipts in staging

- Worker `ccg-p3-worker`; Reviewer `ccg-p3-reviewer`; terminal `role_lifecycle_compiled`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P3-role-gate.py` -> `COMPOSED_P3_G2_ROLE_GREEN`.
- Rollback: Revoke nonce, preserve candidate as untrusted, release only after safe handoff.

### P4 / G3_DISPATCH — Compose one staged fail-closed dispatch orchestrator

- Worker `ccg-p4-worker`; Reviewer `ccg-p4-reviewer`; terminal `dispatch_orchestrator_compiled`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P4-dispatch-gate.py` -> `COMPOSED_P4_G3_DISPATCH_GREEN`.
- Rollback: Invalidate dispatch nonce and registration before any dispatch message.

### P5 / G4_G5_RUNTIME — Implement executor pre-work and runtime containment in staging

- Worker `ccg-p5-worker`; Reviewer `ccg-p5-reviewer`; terminal `runtime_containment_compiled`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P5-runtime-gate.py` -> `COMPOSED_P5_G4_G5_RUNTIME_GREEN`.
- Rollback: Stop new effects, freeze observations, revoke nonce and enter cancellation flow.

### P6 / G6_TERMINAL — Implement terminal evidence, self-review and post gate in staging

- Worker `ccg-p6-worker`; Reviewer `ccg-p6-reviewer`; terminal `terminal_chain_compiled`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P6-terminal-gate.py` -> `COMPOSED_P6_G6_TERMINAL_GREEN`.
- Rollback: Keep candidate inert and enter repair/cancel; never emit accepted or terminal success.

### P7 / G7_REVIEW — Implement Reviewer, conditional RvB and Controller-acceptance policy in staging

- Worker `ccg-p7-worker`; Reviewer `ccg-p7-reviewer`; terminal `review_policy_compiled`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P7-review-policy-gate.py` -> `COMPOSED_P7_G7_REVIEW_GREEN`.
- Rollback: Preserve findings append-only and return candidate to a new repair generation.

### P8 / G9_STAGING_INTEGRATION — Integrate migration, TaskEvent/TaskKanban, dashboard repair and inert activation tooling in staging

- Worker `ccg-p8-worker`; Reviewer `ccg-p8-reviewer`; terminal `staging_integration_candidate_frozen`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P8-staging-integration-gate.py` -> `COMPOSED_P8_G9_STAGING_INTEGRATION_GREEN`.
- Rollback: Delete/rebuild staging projection from immutable events; restore staging snapshot; live assets remain untouched.

### P9 / G9_INDEPENDENT_ACCEPTANCE — Freeze candidate, obtain independent read-only review, then Controller gate decision

- Worker `ccg-p9-worker`; Reviewer `ccg-p9-reviewer`; terminal `controller_gate_decision_pass_inert`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P9-acceptance-input-gate.py` -> `COMPOSED_P9_G9_INDEPENDENT_ACCEPTANCE_GREEN`.
- Rollback: Acceptance is not emitted; return to repair generation and keep staging inert.

### P10 / G8_ACTIVATION_G9_CLOSE — Perform final bounded local activation, forced rollback proof and safe closure

- Worker `ccg-p10-worker`; Reviewer `ccg-p10-reviewer`; terminal `active_on_exact_accepted_dashboard_process_steady_state_proved`.
- Gate: `/Users/ZGH/projects/PA-AGI/worktrees/prime-agent/composed-contract-gate-plan/.ccg-staging/gates/P10-activation-close-gate.py` -> `COMPOSED_P10_G8_ACTIVATION_G9_CLOSE_GREEN`.
- Owner authority: generation 8 request `ccg-owner-auth-request-2026-08-23-r8`, receipt `/Users/ZGH/.prime/agent/session-artifacts/01a01acd-32d6-711c-ba3f-15b1aab84c10/token-optimization/composed-contract-gate/OWNER-DECISION-G8.json`.
- First activation step: `verify exact G8 Owner receipt/request and P9 gate-decision/accepted manifest`.
- Rollback: At any failed step, stop new effects and atomically restore the original pre-P10 bytes/modes/owners/DB/pointer; prove exact aggregate before terminal BLOCK. The successful rollback drill is followed by final activation and does not define the success terminal.

## 4. Closeout

Machine closeout requires `generation == 8` in Parent/package/request/handoff and no candidate-generation 9/10 claim. `repairRound == 10` may appear only as non-authority metadata. Recompile 24 ActionContracts, rerun actual-Parent containment and stale-authority scan, then recompute all hashes. Draft remains non-effective.
