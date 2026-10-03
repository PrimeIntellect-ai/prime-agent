---
name: builder
description: Build a documented status report from parallel section writers and merge their drafts.
version: 1
author: Prime Agent
---

# builder

## What this machine does

Builds a documented status report from parallel section writers. One source
child inspects the working tree and produces a short outline, one writer
child drafts a section per outline line (up to eight in parallel), and a
collector child assembles the sections into a single markdown report.

This is the fan-in example: `collect` waits on the joined `sections` text
port until every writer settles, then merges them. No guards, no loops -
the simplest multi-child shape the factory runs.

## How to run it

    result = await rlm.factory.run("builder")

Then watch progress with `await rlm.factory.status(result["run_id"])`. The
collector's `merged` text is the latest settle answer of the `collect`
state.

```machine-spec
{
  "run": {
    "budget_ms": 900000,
    "failure_policy": "escalate",
    "max_parallel": 8
  },
  "nodes": [
    {
      "id": "scope",
      "subagent": {
        "prompt": "Inspect the current working tree and produce a status outline. Count the changed files with `git status --porcelain`, the failing checks by reading the latest CI artifacts if present, and open questions worth flagging. Return a fenced json block of the form {\\\"outline\\\": [\\\"one short line about scope\\\", ...]} with at most five lines. Output only the json block.",
        "name": "builder-scope"
      },
      "outputs": [
        {
          "name": "outline",
          "type": "json"
        }
      ],
      "budget_ms": 240000
    },
    {
      "id": "notes",
      "subagent": {
        "prompt": "Draft one section of a status report for the current working tree using the outline below. Reply with the section text only: one short paragraph, no heading, no closing remarks.\\n\\n{outline}",
        "name": "builder-notes"
      },
      "inputs": [
        {
          "name": "outline",
          "type": "json",
          "from": "scope.outline"
        }
      ],
      "outputs": [
        {
          "name": "section",
          "type": "text"
        }
      ],
      "foreach": {
        "over": "outline",
        "max": 8
      },
      "budget_ms": 240000
    },
    {
      "id": "collect",
      "subagent": {
        "prompt": "You are given the joined section drafts below. Assemble them into one markdown report: add a `## Status` heading, keep each section as its own paragraph in the given order, and append a `## Follow-ups` list with the open questions. Reply with the final markdown only.",
        "name": "build-collector"
      },
      "inputs": [
        {
          "name": "sections",
          "type": "text",
          "from": "notes.section"
        }
      ],
      "outputs": [
        {
          "name": "merged",
          "type": "text"
        }
      ],
      "budget_ms": 240000
    }
  ]
}
```

