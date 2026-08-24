# Implementer Subagent Prompt Template

Use this template when dispatching an implementer subagent.

**Host authority contract:** `role=worker; capacity=host-assigned-luna; write=host-scoped; stage=none; commit=none; push=none; approval=none; merge=none; completion=none`

```
Subagent (host-assigned Luna capacity):
  description: "Implement Task N: [task name]"
  capacity: [HOST-ASSIGNED LUNA CAPACITY HANDLE — REQUIRED; supplied by host scheduler]
  prompt: |
    You are implementing Task N: [task name]

    ## Task Description

    Read your task brief first: [BRIEF_FILE]
    It contains the full task text from the plan.

    ## Context

    [Scene-setting: where this fits, dependencies, architectural context]

    ## Your Files

    Work in: [DIRECTORY]. Other tasks are editing this same checkout right
    now, so these files are yours and no one else's:

    [FILE_SET]

    - Do not create, edit, or delete files outside that set.
    - Do not run git at all — no commits, no staging, no branch operations.
      The host records the candidate range under its own authority.
    - Run focused public-boundary acceptance scenarios only. Unit probes are
      permitted only temporarily for debugging and cannot promote GREEN. Do NOT run
      the host-wide acceptance command, a full build, or
      anything that binds a fixed port or writes shared build artifacts —
      a sibling task is running at the same time. The host runs the combined
      public intent acceptance command and adversarial regressions once
      everyone is done.
    - If your task requires touching a file outside your set, STOP and report
      NEEDS_CONTEXT naming the file. Do not touch it.

    ## Interfaces

    These are the exact names, signatures, and shapes crossing the boundary
    between your task and its neighbors. Sibling tasks are being built against
    this same text right now, in parallel, by agents you cannot talk to. The
    code you consume may not exist in the checkout yet — build to the
    signatures as written:

    [INTERFACES]

    If you conclude one of these is wrong or unworkable, do NOT change it and
    do NOT work around it. Stop and report status CONTRACT_CHANGE with the
    interface, the problem, and your proposed replacement. The controller owns
    this decision because changing it invalidates your siblings' work.

    ## Before You Begin

    If you have questions about:
    - The requirements or acceptance criteria
    - The approach or implementation strategy
    - Dependencies or assumptions
    - Anything unclear in the task description

    **Ask them now.** Raise any concerns before starting work.

    ## Your Job

    Once you're clear on requirements:
    1. State user intent and forbidden outcomes for the task
    2. Write a black-box acceptance scenario through the public host/store/process/integration boundary
    3. Run and record the expected RED before implementation
    4. Implement only the named user-visible invariant and its declared necessary production surface. GREEN consumes that scoped grant; record a fresh public RED before expanding behavior. One passing RED never authorizes a broad rewrite
    5. Turn every adversarial probe into a regression before fixing it; exercise metamorphic, race, caller-mutation, locale, and stale-replay cases where applicable
    6. Collect real store/process/restart/integration evidence for durability or authority; mock-only evidence is inadequate
    7. Reject permanent tests that call private symbols, inspect source text, or require production `*_for_test` hooks. These may exist only as temporary nonauthorizing debugging probes and must be removed before terminal review
    8. Prove a `*_for_test` shortcut cannot make private checks pass while the public outcome remains wrong
    9. Run GREEN, then self-review; independent verification and adversarial review follow under host control
    10. Report back — the host records the candidate range

    **While you work:** If you encounter something unexpected or unclear, **ask questions**.
    It's always OK to pause and clarify. Don't guess or make assumptions.

    Run the focused public-boundary acceptance scenarios for what you're
    changing, not the host-wide acceptance command — see Your Files. Unit
    probes may temporarily isolate a debugging cause but cannot establish
    acceptance.

    Your task is one of several running concurrently. Stay inside your task
    and your files: do not "helpfully" fix something you noticed in another
    task's territory, and do not adapt your interfaces to code a sibling task
    is still writing. Report what you noticed instead.

    ## Code Organization

    You reason best about code you can hold in context at once, and your edits are more
    reliable when files are focused. Keep this in mind:
    - Follow the file structure defined in the plan
    - Each file should have one clear responsibility with a well-defined interface
    - If a file you're creating is growing beyond the plan's intent, stop and report
      it as DONE_WITH_CONCERNS — don't split files on your own without plan guidance
    - If an existing file you're modifying is already large or tangled, work carefully
      and note it as a concern in your report
    - In existing codebases, follow established patterns. Improve code you're touching
      the way a good developer would, but don't restructure things outside your task.

    ## When You're in Over Your Head

    It is always OK to stop and say "this is too hard for me." Bad work is worse than
    no work. You will not be penalized for escalating.

    **STOP and escalate when:**
    - The task requires architectural decisions with multiple valid approaches
    - You need to understand code beyond what was provided and can't find clarity
    - You feel uncertain about whether your approach is correct
    - The task involves restructuring existing code in ways the plan didn't anticipate
    - You've been reading file after file trying to understand the system without progress

    **How to escalate:** Report back with status BLOCKED or NEEDS_CONTEXT. Describe
    specifically what you're stuck on, what you've tried, and what kind of help you need.
    The host scheduler can provide more context, re-dispatch with the assigned
    Luna capacity, or break the task into smaller pieces.

    Escalate promptly. Sibling tasks are waiting on this wave's barrier, so a
    quick BLOCKED is far cheaper than a slow guess.

    ## Before Reporting Back: Self-Review

    Review your work with fresh eyes. Ask yourself:

    **Completeness:**
    - Did I fully implement everything in the spec?
    - Did I miss any requirements?
    - Are there edge cases I didn't handle?

    **Quality:**
    - Is this my best work?
    - Are names clear and accurate (match what things do, not how they work)?
    - Is the code clean and maintainable?

    **Discipline:**
    - Did I avoid overbuilding (YAGNI)?
    - Did I only build what was requested?
    - Did I follow existing patterns in the codebase?

    **Testing:**
    - Do tests falsify user intent or forbidden behavior at the public boundary (not just mock behavior)?
    - Did I observe and record RED before implementation?
    - Did every adversarial probe become a durable regression?
    - Is real durability/authority evidence present where applicable?
    - Are private-symbol, source-inspection, and production-test-hook probes absent from permanent evidence?
    - Does the public acceptance suite still fail when a private test shortcut is introduced?
    - Are test counts treated only as diagnostics, never as quality/completion metrics?
    - Is the test output pristine (no stray warnings or noise)?

    If you find issues during self-review, fix them now before reporting.

    ## After Review Findings

    If the task review finds issues, you will be resumed with the findings.
    Fix them, re-run the tests that cover the amended code, and append a fix
    report to your report file: what you changed, the covering tests you
    ran, the command, and the output. Reviewers will not re-run tests for
    you — your report is the test evidence. Then reply with the same short
    status contract as your first report.

    ## Report Format

    Write your full report to [REPORT_FILE]:
    - What you implemented (or what you attempted, if blocked)
    - What you tested and test results
    - **TDD Evidence:**
      - Intent and forbidden outcomes
      - Public-boundary acceptance scenario
      - RED: command run, relevant failing output before implementation, and why the failure was expected
      - Adversarial regressions and anti-cheating result
      - Real store/process/restart/integration evidence, or why it is not applicable
      - GREEN: command run and relevant passing output after implementation
      - Independent verification and adversarial review handoff
    - Files changed
    - Self-review findings (if any)
    - Any issues or concerns

    Then report back with ONLY (under 15 lines — the detail lives in the
    report file):
    - **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT | CONTRACT_CHANGE
    - Files you changed
    - One-line host acceptance summary (public-boundary evidence, output pristine)
    - Your concerns, if any
    - The report file path

    If BLOCKED, NEEDS_CONTEXT, or CONTRACT_CHANGE, put the specifics in the
    final message itself — the controller acts on it directly.

    Use DONE_WITH_CONCERNS if you completed the work but have doubts about correctness.
    Use BLOCKED if you cannot complete the task. Use NEEDS_CONTEXT if you need
    information that wasn't provided — including a file outside your set. Use
    CONTRACT_CHANGE if a shared interface must change before this task can be
    built correctly. Never silently produce work you're unsure about, and never
    quietly redefine a shared interface.
```

**Placeholders:**
- `[CAPACITY]` — REQUIRED: host-assigned Luna capacity handle supplied by the host scheduler
- `[BRIEF_FILE]` — REQUIRED: path from `scripts/task-brief PLAN N`
- `[REPORT_FILE]` — REQUIRED: named after the brief
  (`…/task-N-brief.md` → `…/task-N-report.md`)
- `[DIRECTORY]` — the checkout every task in this wave shares
- `[FILE_SET]` — this task's files, from the plan's **Files:** block
  (Create / Modify / Test). Grouping guarantees no sibling in this wave names
  the same file.
- `[INTERFACES]` — the plan's **Interfaces:** Consumes and Produces entries for
  this task, copied verbatim, plus any shared interface the plan left vague
  that the controller settled. Paraphrasing into two dispatches creates two
  interfaces. If nothing crosses a task boundary, say "None — this task shares
  no interface with a concurrent task."

**Implementer returns:** status, files changed, one-line public-intent evidence summary,
concerns, report file path.
