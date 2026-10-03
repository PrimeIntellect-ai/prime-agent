---
name: pr-manager
description: Drive a pull request through review and fix cycles, then keep a resident watcher on it.
version: 1
author: Prime Agent
---

# pr-manager

## What this machine does

Drives a pull request through review and fix cycles. One entry child
resolves the pull request URL, a reviewer child judges the diff, and a
fixer child addresses the findings; the guarded loop alternates until the
verdict approves or the bounded re-entries run out, then a resident
watcher stays available for follow-ups.

This is the machine-form example: guarded transitions select the next
state (`approved` true or false), `max_entries` bounds each loop state,
the fixer's `fix_report` is an optional input on the reviewer's next
re-entry (it binds only after the fixer settled at least once), and
`monitoring` uses the `resident` lifecycle so its instance stays alive
after approval instead of ending the run.

## How to run it

    result = await rlm.factory.run("pr-manager")

Then watch progress with `await rlm.factory.status(result["run_id"])`.
The alternation count is bounded by `max_transitions` and by each loop
state's `max_entries`; the run pauses (escalates) instead of spinning.

```machine-spec
{
  "run": {
    "budget_ms": 1800000,
    "failure_policy": "escalate",
    "max_parallel": 8,
    "max_transitions": 24
  },
  "states": [
    {
      "id": "entry",
      "entry": true,
      "subagent": {
        "prompt": "Identify the pull request under review for the current branch. Run `gh pr view --json url,title` for the current branch and return a fenced json block of the form {\\\"pr_url\\\": \\\"https://github.com/owner/repo/pull/N\\\"}. Output only the json block.",
        "name": "pr-entry"
      },
      "outputs": [
        {
          "name": "pr_url",
          "type": "json"
        }
      ],
      "budget_ms": 240000
    },
    {
      "id": "reviewing",
      "subagent": {
        "prompt": "Review the pull request at {pr_url} for merge-blocking defects. Fetch the diff with `gh pr diff` and judge correctness, regressions, and test gaps. When a fix report is bound below, verify the described fixes landed instead. Return a fenced json block of the form {\\\"verdict\\\": {\\\"approved\\\": <true|false>, \\\"findings\\\": [\\\"one sentence per finding\\\"]}}. Output only the json block.",
        "name": "pr-reviewing"
      },
      "inputs": [
        {
          "name": "pr_url",
          "type": "json",
          "from": "entry.pr_url"
        },
        {
          "name": "fix_report",
          "type": "json",
          "from": "fixing.fix_report",
          "optional": true
        }
      ],
      "outputs": [
        {
          "name": "verdict",
          "type": "json"
        }
      ],
      "max_entries": 4,
      "budget_ms": 240000
    },
    {
      "id": "fixing",
      "subagent": {
        "prompt": "Address the review findings in the verdict below. Make the smallest targeted fixes in the working tree, run the relevant tests, and reply with a fenced json block of the form {\\\"fix_report\\\": {\\\"fixed\\\": [\\\"finding that was addressed\\\"], \\\"skipped\\\": [\\\"finding left alone and why\\\"]}}. Output only the json block.\\n\\n{verdict}",
        "name": "pr-fixing"
      },
      "inputs": [
        {
          "name": "verdict",
          "type": "json",
          "from": "reviewing.verdict"
        }
      ],
      "outputs": [
        {
          "name": "fix_report",
          "type": "json"
        }
      ],
      "max_entries": 3,
      "budget_ms": 480000
    },
    {
      "id": "monitoring",
      "subagent": {
        "prompt": "Stay resident as the pull-request watcher for {pr_url}: inspect the checks with `gh pr checks` once, report their state in one line, and remain available for follow-up questions about the pull request.",
        "name": "pr-monitoring"
      },
      "inputs": [
        {
          "name": "pr_url",
          "type": "json",
          "from": "entry.pr_url"
        }
      ],
      "lifecycle": "resident"
    }
  ],
  "transitions": [
    {
      "from": "entry",
      "to": "reviewing"
    },
    {
      "from": "reviewing",
      "to": "fixing",
      "when": {
        "output": "verdict",
        "path": "approved",
        "op": "eq",
        "value": false
      }
    },
    {
      "from": "reviewing",
      "to": "monitoring",
      "when": {
        "output": "verdict",
        "path": "approved",
        "op": "eq",
        "value": true
      }
    },
    {
      "from": "fixing",
      "to": "reviewing"
    }
  ]
}
```

