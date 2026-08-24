---
name: workflow-builder
description: Use when implementing or reviewing Prime Agent's automatic `/workflow` command, durable completeness preflight, trusted activation, or restart recovery, especially when incomplete prompts could otherwise start work.
---

# Workflow Builder

## Overview

Build `/workflow` as a durable, host-owned completeness preflight. Express
behavior through public intent tests; never commit an implementation-shaped
design document or second executor.

**REQUIRED SUB-SKILLS:** Use `superpowers:brainstorming` before implementation
and `superpowers:test-driven-development` before production code. During every
workflow preflight, automatically run bounded brainstorming whenever a
material field is unknown; this phase is mandatory, not optional.

## Contract

Required behavior:

| Input or state | Required outcome |
| --- | --- |
| `/workflow <prompt>` | First persist one durable preflight draft from the prompt plus current task context. |
| Bare `/workflow`, including no recoverable context | First persist one durable preflight draft from available context, record the missing objective/context as a material-unknown question, and never invent an objective. |
| Material unknowns | Automatically run bounded brainstorming. Persist the draft and every question/answer; execute nothing while questions remain. |
| Complete inputs | Run read-only adversarial review for guards, failure/restart paths, authority, budgets, and selected resource/cloud assumptions. |
| Reviewed proposal | Seal objective/source, metrics, guards, non-goals, budgets, any selected resource decision, graph digest, capsule policy, revision, and next action. |
| Approval | Activate only after structured trusted approval bound to the sealed revision; chat “yes”, status/resume, plan, and worker output do not approve. |
| Restart | Replay draft, questions, proposal, approval, and next action; reject stale approval and never replay effects. |

Every invocation, including bare `/workflow` with no recoverable context, first
persists a durable preflight draft and a material-unknown question when the
objective or any required context is missing. Automatically and mandatorily
run bounded brainstorming whenever any material field is unknown. While
questions remain, persist each question/answer and do not build a graph, issue
a capsule, start a worker, or perform an effect.

## Task graph and capsules

After preflight, the host constructs one finite task graph (DAG). Every node
declares its objective, dependencies, inputs/evidence, outputs, acceptance
checks, write set, authority scope, budget, and recovery policy. Reject
duplicate/unknown IDs, cycles, missing references, and unbounded fan-out, then
seal a canonical graph digest. Workers cannot add, reorder, broaden, or
dispatch graph nodes.

After approval, the host issues a signed task capsule bound to the workflow,
task, attempt, graph digest/revision, epoch, authority scope, inputs, checks,
budgets, and exact next action. A continuation capsule adds the durable
checkpoint and evidence references. Verify signature, digest, epoch, revision,
expiry, and replay state before dispatch/resume; reject stale, forged, foreign,
or mismatched capsules. An agent-to-agent (A2A) worker returns only capsule-scoped
output/evidence; it cannot grant authority, change the graph, approve work, or
claim completion. Apply A2A, cloud, and remote-resource rules only when those
capabilities are selected for this workflow; never add them or broaden
authority merely because this skill documents their guards.

## Authority firewall

Before authority exists, only preflight dialogue, durable
draft/proposal state, and read-only review are allowed. No worker, raw child,
executor/process, kernel start or prewarm, effect, refinement, durable
learning, mutation, or other side effect may occur. Host alone admits the
first action.

Planning and review roles are read-only. Implementation agents name exact
code/test write sets; reviewers inspect and report only. Keep the public name
`workflow-builder` and do not change unrelated authority code.

## Implementation workflow

1. Persist prompt/bare-session context and brainstorm material questions.
2. Review the complete contract, validate the DAG, and seal its digest/capsule policy.
3. Await exact structured approval before host dispatch of signed capsules.
4. Reconcile outputs and continuation capsules after process/restart; resume only
   from current durable state, then run public verification.

## Acceptance method

Write public intent tests first; record the RED. At the
slash-command/session host boundary, cover:

- complete prompted and bare-context starts, including an empty-context draft/question;
- material unknowns causing durable questions and no execution;
- adversarial review, sealed proposal, and structured approval activation;
- chat/status/resume/forged/expired/stale approval bypasses;
- DAG validation (duplicate/unknown IDs, cycles, dependencies, ready-set order,
  and sealed graph digest);
- signed task/continuation capsules across restart and A2A handoff, including
  foreign workflow/task/epoch, stale, forged, duplicate, and changed-graph
  rejection;
- restart recovery with the same exact next action; and
- accepted paths plus every bypass proving zero executor/process/mutation calls
  before authority.

Use real store/process/restart evidence; source inspection, private helpers,
mock counts, and coverage are diagnostic. Turn each bypass into a durable
public regression. Run the targeted test from package root, then `npm run check`.

## Red flags

- Filling an unknown field “reasonably” instead of asking the user.
- Starting any worker, executor, kernel, prewarm, effect, or mutation during preflight.
- Treating natural-language acknowledgment as approval, or replaying an effect after restart.
- Letting planners/reviewers write outside an explicit set or hide a file-by-file plan in a committed design document.

On any red flag, stop at the host boundary, add the missing public intent
test, and resume only from durable state.
