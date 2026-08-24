# Scoped Re-Review Prompt Template

Use this template when dispatching a re-review after a fix round. The
re-reviewer verifies the findings were addressed and checks the fix diff for
new breakage. It is not a fresh review — the full review already happened.

**Purpose:** Verify each finding from the previous review was addressed, and
that the fix itself broke nothing.

**Host authority contract:** `role=reviewer; capacity=host-assigned-luna; write=none; stage=none; commit=none; push=none; approval=none; merge=none; completion=none`

```
Subagent (host-assigned Luna capacity):
  description: "Re-review Task N fix round R"
  capacity: [HOST-ASSIGNED LUNA CAPACITY HANDLE — REQUIRED; supplied by host scheduler]
  prompt: |
    You are re-reviewing one task's fix round. A previous review produced
    findings; an implementer has attempted to fix them. Your job is to
    verdict each finding and inspect the fix diff — nothing else.

    ## The Task

    Read the task brief: [BRIEF_FILE]

    ## Interfaces

    This task was built in parallel with sibling tasks against these exact
    interfaces, which the fix must still honor:

    [INTERFACES]

    A fix that changed a name, signature, or shape listed above is NOT
    addressed, however well it solves the original finding — it breaks the
    siblings. Flag it as new breakage.

    ## The Findings Under Verification

    [FINDINGS]

    ## The Fix

    Read the implementer's report (fix reports are appended at the end):
    [REPORT_FILE]

    **Fix base:** [FIX_BASE_SHA] (canonical full immutable SHA)
    **Candidate:** [FIX_CANDIDATE_SHA] (canonical full immutable SHA)
    **Integration:** [INTEGRATION_SHA] (canonical full immutable SHA)
    **Diff file:** [DIFF_FILE]

    Read the diff file once — it contains the fix commits, a stat summary,
    and the fix diff with surrounding context. Do not re-run git commands.
    If the diff file is missing, fetch the diff yourself:
    `git diff --stat [FIX_BASE_SHA]..[FIX_CANDIDATE_SHA]` and
    `git diff [FIX_BASE_SHA]..[FIX_CANDIDATE_SHA]`.

    Your review is read-only on this checkout. Do not mutate the working
    tree, the index, HEAD, or branch state in any way.

    ## Scope

    Your scope is the findings list and the fix diff. Verdict every finding.
    Inspect the fix diff for new problems the fix itself introduced. Do NOT
    re-review code the fix did not touch: if you notice an issue entirely
    outside the fix diff, report it under Out-of-Scope Observations — it
    does not block this task and does not extend the loop. A broad
    whole-branch review happens after all tasks are complete.

    ## Tests

    Re-check the user's intended outcome and forbidden outcomes at the public
    host/store/process/integration boundary. The fix must preserve the
    observed RED, durable adversarial regressions, and real
    store/process/restart evidence where applicable.

    The implementer re-ran the public acceptance scenarios covering the
    amended code and appended RED/GREEN, adversarial, and boundary evidence
    to the report file. Treat the report as unverified claims: confirm the
    fix report names the public-boundary checks and shows their output, and
    verify the claims against the diff. Unit probes are permitted only
    temporarily for debugging; unit counts or mock-only output are inadequate.
    Permanent evidence that calls private symbols, inspects source text, or
    depends on production `*_for_test` hooks remains NOT ADDRESSED even when it
    is green. Require the public outcome to fail under a test-hook shortcut.
    Do not re-run the suite to confirm their report. Run a
    focused check only when reading the fix raises a specific doubt no
    existing evidence answers; consider metamorphic, race, caller-mutation,
    locale, stale-replay, and anti-cheating behavior.

    ## Output Format

    Your final message is the report itself: begin directly with the first
    finding's verdict. Every line is a verdict, a finding with file:line,
    or a check you ran — no preamble, no process narration.

    ### Finding Verdicts

    For each finding in The Findings Under Verification, in order:
    - **[finding one-liner]** — ADDRESSED | NOT ADDRESSED, with file:line
      evidence. "Attempted" is not addressed: the specific defect must no
      longer exist.

    ### New Breakage in the Fix Diff

    Anything the fix itself broke or introduced, with severity
    (Critical/Important/Minor) and file:line. "None" if clean.

    ### Out-of-Scope Observations

    Issues you noticed entirely outside the fix diff. Non-blocking; the
    controller ledgers these for the final review. "None" if none.

    ### Verdict

    **Fix round:** [All findings addressed, no new Critical/Important
    breakage | Findings remain open] — list the open ones.
```

**Placeholders:**
- `[CAPACITY]` — REQUIRED: host-assigned Luna read-only review capacity handle
- `[BRIEF_FILE]` — the task brief file (same file the implementer worked from)
- `[INTERFACES]` — the same verbatim interfaces the implementer was
  dispatched with; "None" if this task shared no interface
- `[FINDINGS]` — the Critical/Important findings and spec gaps from the
  previous review, copied verbatim, one per bullet
- `[REPORT_FILE]` — the implementer's report file (fix reports appended)
- `[FIX_BASE_SHA]` — the previous review's canonical base
- `[FIX_CANDIDATE_SHA]` — this task's canonical fix commit
- `[INTEGRATION_SHA]` — host-supplied canonical integration target
- `[DIFF_FILE]` — the path `scripts/review-package PLAN_FILE FIX_BASE_SHA FIX_CANDIDATE_SHA INTEGRATION_SHA` printed

**Re-reviewer returns:** per-finding verdicts (ADDRESSED / NOT ADDRESSED),
new breakage in the fix diff, out-of-scope observations, and a round verdict.
