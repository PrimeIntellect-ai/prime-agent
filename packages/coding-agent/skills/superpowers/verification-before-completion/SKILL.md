---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

# Verification Before Completion

## Prime Agent fork contract

- Contract: `role=verifier; authority=methodology-only; capacity=host-assigned-luna; host-authority=commit,stage,push; write=none; commit=none; stage=none; push=none; approval=none; merge=none; completion=none`
- Contract: `acceptance=public-intent-boundary; mocks=mock-only-inadequate; review=adversarial-independent`
- Contract: `unit-probes=temporary-debugging-only`

This skill supplies evidence requirements only. The host/coordinator owns writes, approvals, integration, and completion claims. Unit probes are permitted only temporarily for debugging; unit counts, coverage percentages, and mock-only checks are diagnostic and cannot promote work.

## Overview

**Core principle:** Public intent evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

Acceptance must exercise the public host/store/process/integration boundary. Where persistence or authority is involved, require real store/process/restart evidence. Check relevant metamorphic, race, caller-mutation, locale, stale-replay, and anti-cheating cases; a temporary debugging unit probe can isolate a cause but cannot substitute for the intent scenario.

Reject permanent evidence that calls private symbols, inspects source text, or depends on production `*_for_test` hooks. These are temporary, nonauthorizing debugging probes and must be removed before terminal review. Explicitly test the cheating mutation: if a test hook makes the private test pass while the public outcome remains wrong, completion must still fail.

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
✅ [Host acceptance command] [Recorded public-boundary GREEN evidence]
❌ "Should pass now" / "Looks correct"
```

The pass claim above is valid only when the command includes the required public-boundary intent suite. Mock-only or unit-only output is inadequate; unit-only output is allowed only as temporary debugging evidence.

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

Do not treat test counts or coverage as workflow progress. Require observed RED before implementation, durable adversarial regressions, GREEN, independent verification, and adversarial review against the exact candidate SHAs.

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness
