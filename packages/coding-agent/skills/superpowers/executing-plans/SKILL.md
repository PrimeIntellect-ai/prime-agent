---
name: executing-plans
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
---

# Executing Plans

## Prime Agent fork contract

- Contract: `role=implementer; authority=methodology-only; capacity=host-assigned-luna; host-authority=commit,stage,push; acceptance=public-intent-boundary; unit-probes=temporary-debugging-only`
- Contract: `authority=methodology-only; write=none; commit=none; stage=none; push=none; approval=none; merge=none; completion=none`
- Contract: `mocks=mock-only-inadequate`
- Contract: `intent=required; forbidden-outcomes=required; red=observed-recorded-before-implementation; adversarial-probes=regression-before-fix`
- Contract: `durability=real-store-process-restart; adversarial=metamorphic,race,caller-mutation,locale,stale-replay; anti-cheating=required; green=independent-verification-adversarial-review`

This skill describes checkpoints. The host recipe selects approved capacity and performs or authorizes writes, commits, approvals, merges, and completion. Product changes and durable intent tests belong to the implementation worker; unit probes are permitted only temporarily for debugging, and mock-only checks cannot promote a task.

## Overview

Load the plan, review it critically, execute each task through its public acceptance boundary, and report evidence to the host. Do not claim completion from unit counts or coverage.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Note:** Tell your human partner that Superpowers works much better with access to subagents (Claude Code, Codex CLI, Codex App, Copilot CLI, and Gemini CLI all qualify; see the per-platform tool refs in `../using-superpowers/references/`). If subagents are available, use superpowers:subagent-driven-development instead of this skill.

## The Process

### Step 1: Load and Review Plan
1. Ensure an isolated workspace: use superpowers:using-git-worktrees to create one or verify the existing one
2. Read plan file
3. Review critically - identify any questions or concerns about the plan
4. If concerns: Raise them with your human partner before starting
5. If no concerns: Create todos for the plan items and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Confirm user intent and forbidden outcomes, then follow each step exactly (the plan has bite-sized steps)
3. Run and record the black-box acceptance RED before implementation
4. Preserve every adversarial probe as a public-boundary regression before fixing it
5. Collect real store/process/restart/integration evidence where durability or authority matters; label mock-only evidence inadequate
6. Prove anti-cheating by exercising a bypass of the public enforcement path and recording its failure
7. Run GREEN, then independent verification and adversarial review on immutable candidate inputs
8. Mark as completed only after the host records the required evidence

### Step 3: Complete Development

After all tasks complete and verified:
- Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- **REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch
- Follow that skill to verify tests and present host-owned options; the host executes any authorized choice

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Stop when blocked, don't guess
- For substantial work, require a host-pinned worktree from the exact immutable integration SHA; small edits remain coordinator-owned in the current checkout
