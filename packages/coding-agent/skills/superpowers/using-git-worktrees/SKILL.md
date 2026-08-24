---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - ensures an isolated workspace exists via native tools or git worktree fallback
---

# Using Git Worktrees

## Overview

Ensure substantial work happens in an isolated workspace. Prefer the host's
native worktree tools; use a manual linked worktree only when the host has no
native tool. A substantial task never falls back to the current checkout.

## Prime Agent fork contract

- Contract: `role=worktree-coordinator; authority=methodology-only; capacity=host-assigned-luna; host-authority=commit,stage,push; substantial=branch-from-integration-sha,propose-to-integration`
- Contract: `small=coordinator; merge-base=forbidden; workspace-head=exact-integration-sha; write=none; commit=none; stage=none; push=none; approval=none`
- Contract: `merge=none; completion=none`
- Contract: `acceptance=public-intent-boundary; unit-probes=temporary-debugging-only; mocks=mock-only-inadequate`
- Contract: `integration=caller-supplied-canonical-full-immutable-sha; write-grant=host-explicit`

Substantial independent modules may be isolated only from the caller/host-supplied immutable integration SHA, then proposed back to that same integration target. Small edits remain coordinator-owned in the current checkout and do not require a worktree. Never base a merge on an inferred merge base or moving ref. This skill never chooses a moving branch, writes, commits, approves, merges, or declares completion.

**Core principle:** Detect existing isolation first. Then use native tools. Then fall back to git. Never fight the harness.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

## Immutable Workspace Guard

Resolve the caller-supplied integration input before inspecting or using a
workspace. A mutable ref, abbreviated hash, uppercase hash, missing commit, or
worktree whose `HEAD` is not exactly the integration commit is invalid. The
host runs this read-only guard in the existing linked workspace, after native
creation, and after the manual fallback creation, before any work begins:

```bash
verify_worktree_at_integration() {
  local integration_sha=${1-}
  if ! printf '%s\n' "$integration_sha" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "integration SHA must be a canonical full lowercase hash" >&2
    return 2
  fi
  local resolved
  resolved=$(git rev-parse --verify --end-of-options "${integration_sha}^{commit}") || {
    echo "integration SHA is not an existing commit" >&2
    return 2
  }
  if [ "$resolved" != "$integration_sha" ]; then
    echo "integration SHA is not canonical" >&2
    return 2
  fi
  local head
  head=$(git rev-parse --verify --end-of-options HEAD) || {
    echo "workspace has no commit HEAD" >&2
    return 2
  }
  if [ "$head" != "$integration_sha" ]; then
    echo "workspace HEAD does not equal integration SHA" >&2
    return 2
  fi
}
```

Do not continue with an existing, native, or fallback workspace after this
guard fails. The coordinator keeps small edits in the current checkout; the
host still supplies the exact integration SHA and runs the guard before those
edits too.

## Step 0: Detect Existing Isolation

**Before creating anything, check if you are already in an isolated workspace.**

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

**Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside git submodules. Before concluding "already in a worktree," verify you are not in a submodule:

```bash
# If this returns a path, you're in a submodule, not a worktree — treat as normal repo
git rev-parse --show-superproject-working-tree 2>/dev/null
```

**If `GIT_DIR != GIT_COMMON` (and not a submodule):** You are already in a linked worktree. Run `verify_worktree_at_integration "$INTEGRATION_SHA"` in that workspace, then skip to Step 2 (Project Setup) only when it passes. Do NOT create another worktree.

Report with branch state:
- On a branch: "Already in isolated workspace at `<path>` on branch `<name>`."
- Detached HEAD: "Already in isolated workspace at `<path>` (detached HEAD, externally managed). Branch creation needed at finish time."

**If `GIT_DIR == GIT_COMMON` (or in a submodule):** You are in a normal repo checkout.

Before creating isolation, classify the change. For a small edit, keep the
coordinator in the current checkout and stop after reporting the inline plan.
For a substantial independent module, require the host/caller to provide the
immutable integration SHA; the branch and worktree must be created from that
SHA and the resulting work must be proposed back to that exact SHA. If the
host has not granted the worktree operation or supplied the exact SHA, stop
and report the missing input. Never use an inferred merge base or moving ref
as the integration target.

## Step 1: Create Isolated Workspace

**You have two mechanisms. Try them in this order.**

### 1a. Native Worktree Tools (preferred)

The host has granted an isolated workspace operation. Do you already have a
way to create a worktree? It might be a tool with a name like `EnterWorktree`,
`WorktreeCreate`, a `/worktree` command, or a `--worktree` flag. If you do, use
it and skip to Step 2.

Native tools handle directory placement, branch creation, and cleanup automatically. Using `git worktree add` when you have a native tool creates phantom state your harness can't see or manage. After the native tool returns, run `verify_worktree_at_integration "$INTEGRATION_SHA"` from the created workspace before Step 2.

Only proceed to Step 1b if you have no native worktree tool available.

### 1b. Git Worktree Fallback

**Only use this if Step 1a does not apply** — you have no native worktree tool available. Create a worktree manually using git.

#### Directory Selection

Follow this priority order. Explicit user preference always beats observed filesystem state.

1. **Check your instructions for a declared worktree directory preference.** If the user has already specified one, use it without asking.

2. **Check for an existing project-local worktree directory:**
   ```bash
   ls -d .worktrees 2>/dev/null     # Preferred (hidden)
   ls -d worktrees 2>/dev/null      # Alternative
   ```
   If found, use it. If both exist, `.worktrees` wins.

3. **If there is no other guidance available**, default to `.worktrees/` at the project root.

#### Safety Verification (project-local directories only)

**MUST verify directory is ignored before creating worktree:**

```bash
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

**If NOT ignored:** Stop and report that the host must grant the `.gitignore`
change. Do not modify that file from this skill.

**Why critical:** Prevents accidentally committing worktree contents to repository.

#### Create the Worktree

```bash
# Determine path based on chosen location and the caller-supplied integration SHA
path="$LOCATION/$BRANCH_NAME"

git worktree add "$path" -b "$BRANCH_NAME" "$INTEGRATION_SHA"
cd "$path"
verify_worktree_at_integration "$INTEGRATION_SHA"
```

**Permission failure:** Stop and report that the host must provide a worktree
capability. Do not continue in the current checkout for a substantial task.

## Step 2: Project Setup

Report the repository's setup prerequisites to the host. The host runs any
dependency installation or build command under its explicit write grant; this
skill does not choose or execute mutating setup commands.

## Step 3: Verify Clean Baseline

Ask the host to run its project-specific public acceptance command to ensure
the workspace starts clean. Unit probes are permitted only temporarily for
debugging; unit counts, mock-only output, and coverage are diagnostics and
cannot establish a baseline or completion.

**If the host acceptance command fails:** Report the failure and ask whether to proceed or investigate.

**If the host public intent acceptance command passes:** Report the recorded
baseline and wait for the host to grant implementation authority.

### Report

```
Worktree ready at <full-path>
Host acceptance baseline recorded with no failures.
Ready for the host to grant implementation of <feature-name>
```

## Quick Reference

| Situation | Action |
|-----------|--------|
| Already in linked worktree | Skip creation (Step 0) |
| In a submodule | Treat as normal repo (Step 0 guard) |
| Native worktree tool available | Use it (Step 1a) |
| No native tool | Git worktree fallback (Step 1b) |
| `.worktrees/` exists | Use it (verify ignored) |
| `worktrees/` exists | Use it (verify ignored) |
| Both exist | Use `.worktrees/` |
| Neither exists | Check instruction file, then default `.worktrees/` |
| Directory not ignored | Stop; host must grant the `.gitignore` change |
| Permission error on create | Stop; host must grant a worktree capability |
| Acceptance baseline fails | Report the failure and wait for host direction |
| No package.json/Cargo.toml | Report setup prerequisites to the host |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'm obviously not in a worktree — no need to check" | Run Step 0. Harness-created isolation and submodules both fool eyeballing; the detection commands settle it. |
| "`git worktree add` is quicker than hunting for a native tool" | A native tool (e.g. `EnterWorktree`) owns placement, branching, and cleanup. Bypassing it is the #1 mistake — it creates phantom state your harness can't see or manage. |
| "The worktree directory is surely ignored already" | Run `git check-ignore`. An unignored worktree directory commits the whole tree into the repo. |
| "Any directory name works" | Explicit instructions beat an existing project-local directory, which beats the `.worktrees/` default. |
| "The workspace is fresh — baseline acceptance can wait" | A dirty baseline makes every later failure ambiguous. Run the host public intent acceptance command now; proceeding past failures is the host's call. |
