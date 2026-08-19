---
name: finishing-a-development-branch
description: Use when implementation has host acceptance evidence and you need to decide how to integrate the work
---

# Finishing a Development Branch

## Prime Agent fork contract

- Contract: `role=integrator; authority=methodology-only; capacity=host-assigned-luna; host-authority=commit,stage,push; write=none; commit=none; stage=none; push=none; approval=none; merge=none; completion=none`
- Contract: `acceptance=public-intent-boundary; unit-probes=temporary-debugging-only; mocks=mock-only-inadequate`

This skill produces an evidence and integration recommendation only. The host/coordinator owns all file writes, commits, branch deletion, pushes, approvals, merges, and completion claims.

## Overview

Verify the exact candidate range, inspect the real acceptance evidence, identify the immutable integration target, and present options for the host to execute. Never mutate repository state from this skill.

## Step 1: Verify evidence

Require fresh output for the candidate's public intent suite, adversarial regressions, and any real store/process/restart or integration checks. Unit probes are permitted only temporarily for debugging; unit counts, coverage percentages, and mock-only checks are supplemental diagnostics and cannot establish GREEN or completion.

Record:

- User intent and forbidden outcomes.
- The caller-supplied immutable base, candidate, and integration SHAs.
- The observed RED before implementation and GREEN after implementation.
- Independent verification and adversarial review results for exactly that SHA range.
- Any unresolved findings or evidence gaps.

If a required check fails, report the failure and stop the integration recommendation.

## Step 2: Determine the integration target

Use only the caller/host-supplied immutable integration SHA. Do not infer a
moving branch, parent ref, or mutable remote ref. For substantial independent
modules, the worktree policy already requires a branch pinned to that SHA and
a proposal back to the same target. Small edits remain coordinator-owned in
the current checkout.

## Step 3: Present a recommendation

Report the candidate SHAs, evidence, findings, and one of these host actions:

1. Propose the exact candidate range for host-approved integration into the supplied target.
2. Propose preserving the branch/worktree for more review or follow-up.
3. Propose explicit discard only after the caller separately authorizes it.

Do not execute any option, ask for approval on behalf of the host, or state that the work is complete. The host must make and record the integration decision.

## Verification checklist

- [ ] Intent and forbidden outcomes are visible.
- [ ] Acceptance runs through the public host/store/process/integration boundary.
- [ ] RED was observed and recorded before implementation.
- [ ] Adversarial probes are durable public-boundary regressions, not one-off unit debugging checks.
- [ ] Real durability/authority evidence exists where applicable.
- [ ] Metamorphic, race, caller-mutation, locale, and stale-replay checks were considered.
- [ ] Anti-cheating probes fail when enforcement is bypassed.
- [ ] GREEN is followed by independent verification and adversarial review.
- [ ] Candidate base, candidate, and integration target are immutable and caller supplied.

## Common rationalizations

| Excuse | Reality |
| --- | --- |
| "Tests passed earlier" | Require fresh evidence for the exact immutable candidate range. |
| "Coverage is high enough" | Counts and percentages are diagnostics; intent scenarios decide acceptance. |
| "The reviewer already approved it" | Re-read the review evidence and exact SHAs independently. |
| "The branch obviously belongs on a particular target" | The host supplies and confirms the exact immutable integration target. |
| "I can merge or clean up now" | This skill has no merge, deletion, push, approval, or completion authority. |
