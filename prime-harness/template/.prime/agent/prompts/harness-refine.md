---
description: Governed Continual Harness refinement (snapshot, behavioral replay, evaluate, keep-or-rollback)
argument-hint: [refinement instructions...]
---

Run a governed refinement cycle (local scope; global requires the human):

1. Run `harness_orchestrator.harness_snapshot("before-refine")`. Export a
   **fresh** schema-v1 baseline containing that exact local+global harness state
   and its real refinement history; snapshots must never contain responses.
   Select a reviewed behavior adapter under `harness/replay_adapters/` that
   actually instantiates behavior from the supplied frozen state. Bind its file
   SHA-256 in the snapshot. Run the same baseline twice:

   `python -S harness/replay.py --executor <trusted-adapter.py> --snapshot <before.json> --output <run-1.json>`

   Repeat to `<run-2.json>` and require byte-identical reports. The checked-in
   reference oracle is not a refinement adapter; its path and exact digest are
   rejected. An edited semantic copy is still forbidden and must be caught by
   adapter review/private holdouts because the public corpus cannot detect it.
   If a trustworthy state-applying adapter is unavailable, stop inconclusive;
   the refinement cannot be promoted.
2. Identify the evidence: which repeated failure/friction pattern (2+
   occurrences in this session or the ledger) motivates a durable change?
   One anomaly justifies at most a narrowly scoped factual memory.
3. Run `await refine.run("$ARGUMENTS")` — it schedules the refinement for the
   turn boundary (this path skips the auto-refine review gate, which is why
   steps 1–2 and 4–5 are mandatory).
4. After it applies, print `harness_orchestrator.harness_diff()` and verify the
   change is the SMALLEST edit addressing the evidence: no broad prompt
   rewrites and no unverified claims promoted to memory.
5. Note the refinement id and immediately record it in the ledger as
   `status="unverified"`. Export a fresh candidate with the changed local+global
   state. It must preserve baseline history, append exactly one concrete local
   event with that id, leave global state unchanged, use the same executor
   digest, contain no prepared-response bundle at any nesting
   depth, and bind both the exact baseline bundle and baseline state through
   `parent_snapshot_sha256` and
   `parent_harness_state_sha256`. Never add caller-supplied responses. Run:

   `python -S harness/replay.py --executor <trusted-adapter.py> --baseline <before.json> --candidate <after.json> --output <comparison.json>`

   A nonzero exit, unstable/erroring behavior, threshold failure, regression,
   identical state, missing history/provenance, or lower score blocks
   promotion. Keep the record `unverified` and report the id so the operator
   can run `/refine rollback <refinement-id>`. A passing behavioral replay is
   necessary but not sufficient to leave `unverified`: attach the comparison,
   then require subsequent held-out/gate-passing work. Only after both pass may
   the ledger status become `verified`. Later contradiction requires
   invalidation and an operator rollback request; rollback remains human-only.
