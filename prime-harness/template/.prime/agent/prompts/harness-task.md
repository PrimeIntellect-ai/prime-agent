---
description: Start a harness-disciplined task (task state, branch, goal, plan, verify-to-complete)
argument-hint: <task-id> <objective...>
---

Start task `$1` under the Prime Harness discipline. Objective: ${@:2}

Follow this sequence exactly:

1. `await harness_orchestrator()` — review current state; if a task is already
   active, reconcile or finish it first.
2. Create a working branch `agent/$1` from the current commit (worktree or
   branch — never work on a protected branch), then
   `harness_orchestrator.new_task("$1", objective, working_branch="agent/$1")`.
3. Check prior knowledge: `evidence_ledger.search(...)` for every claim the
   objective depends on; record the relevant evidence ids in the task state.
4. Create the persistent goal with an explicit token budget and falsifiable,
   artifact-driven completion criteria, e.g.
   `await goal.create("<objective>; complete only when python harness/verify.py --profile changed-files passes on the working branch and all critical critic findings are resolved", token_budget=<n>)`.
5. Plan: decompose into small, checkable increments; put the list in
   `task_state.next_actions`; identify which increments justify specialists
   (`admit()` gates each spawn).
6. Implement increment by increment; run `sci_verify.run_suite("quick")`
   frequently; keep the task state and ledger current.
7. Before completion: full gate pass, `external_critic.review()` triage
   (falsify-or-rebut every critical/major), then and only then
   `await goal.complete()`.
