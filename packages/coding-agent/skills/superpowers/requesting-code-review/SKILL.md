---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before host integration to verify work meets requirements
---

# Requesting Code Review

Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history.

## Prime Agent fork contract

- Contract: `role=reviewer; authority=methodology-only; capacity=host-assigned-luna; host-authority=commit,stage,push; sha-input=caller-supplied-canonical-full-base-candidate-integration`
- Contract: `moving-head-default=forbidden; sha-validation=existence-and-ancestry; receipt=exact-candidate-integration`
- Contract: `integration=exact-sha-review-before; write=none; commit=none; stage=none; push=none; approval=none`
- Contract: `merge=none; completion=none; acceptance=public-intent-boundary; mocks=mock-only-inadequate`
- Contract: `unit-probes=temporary-debugging-only`

This skill prepares a review request and evidence checklist. The host/coordinator supplies canonical full immutable base, candidate, and integration SHAs plus a named Luna capacity handle. The host owns all writes, approvals, merges, and completion decisions.

Capacity input: `HOST-ASSIGNED LUNA CAPACITY HANDLE` is required; this skill
never selects capacity.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before host integration into the approved integration branch/worktree

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Receive and validate immutable review inputs:**
```bash
set -euo pipefail
BASE_SHA=<caller-supplied-immutable-base-sha>
CANDIDATE_SHA=<caller-supplied-immutable-candidate-sha>
INTEGRATION_SHA=<caller-supplied-immutable-integration-sha>

for SHA in "$BASE_SHA" "$CANDIDATE_SHA" "$INTEGRATION_SHA"; do
  if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "review SHAs must be canonical full lowercase hashes" >&2
    exit 2
  fi
  RESOLVED=$(git rev-parse --verify --end-of-options "${SHA}^{commit}") || exit 2
  [ "$RESOLVED" = "$SHA" ] || { echo "review SHA is not canonical: $SHA" >&2; exit 2; }
done
git merge-base --is-ancestor "$INTEGRATION_SHA" "$BASE_SHA"
git merge-base --is-ancestor "$BASE_SHA" "$CANDIDATE_SHA"
git merge-base --is-ancestor "$INTEGRATION_SHA" "$CANDIDATE_SHA"
```

Reject refs, truncated hashes, unrelated commits, sibling integration histories, and any moving default. Review exactly `${BASE_SHA}..${CANDIDATE_SHA}` and bind the receipt to both `${CANDIDATE_SHA}` and `${INTEGRATION_SHA}` before any integration decision.

**2. Dispatch code reviewer subagent:**

Ask the host scheduler to assign the named Luna capacity handle, then fill the read-only template at [code-reviewer.md](code-reviewer.md). This skill never selects capacity.

**Placeholders:**
- `{DESCRIPTION}` - Brief summary of what you built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{CANDIDATE_SHA}` - Ending commit under review
- `{INTEGRATION_SHA}` - Exact target commit for the proposed integration
- `{CAPACITY}` - Host-assigned Luna capacity handle

**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=<caller-supplied-immutable-base-sha>
CANDIDATE_SHA=<caller-supplied-immutable-candidate-sha>
INTEGRATION_SHA=<caller-supplied-immutable-integration-sha>

[Host assigns named Luna capacity; dispatch read-only reviewer]
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types
  PLAN_OR_REQUIREMENTS: Task 2 from docs/superpowers/plans/deployment-plan.md
  BASE_SHA: <full immutable SHA>
  CANDIDATE_SHA: <full immutable SHA>
  INTEGRATION_SHA: <full immutable SHA>
  CAPACITY: <host-assigned Luna capacity handle>

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```

The acceptance surface is the public intent scenario, including relevant adversarial regressions and real store/process/restart evidence. Unit probes are permitted only temporarily for debugging; unit counts or mock-only checks are supplemental diagnostics and cannot promote a candidate to GREEN or integration-ready.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just review the diff myself instead of dispatching a reviewer" | You're the coordinator — reviewing the diff inline burns the context window you need to keep driving the work. Dispatch a reviewer subagent: the diff and the evaluation live in its context, and only the findings come back to you. |
| "The reviewer needs my whole session history to understand the change" | Hand it precisely crafted context, never your session's history. That keeps the reviewer on the work product, not your thought process. |

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: [code-reviewer.md](code-reviewer.md)
