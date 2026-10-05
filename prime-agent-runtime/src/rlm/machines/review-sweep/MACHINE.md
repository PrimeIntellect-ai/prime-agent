---
name: review-sweep
description: Sweep the changed files of a branch for review findings and merge them into one issue list.
version: 1
author: Prime Agent
---

# review-sweep

## What this machine does

Sweeps the current branch for review findings. One source child lists the
changed files, a reviewer child reviews each file in parallel (up to eight
at a time), and one aggregator child merges the per-file verdicts into a
single issue list.

The review state is a `foreach`: the `files` input (a JSON list) expands to
one reviewer instance per changed file (the `foreach.max` cap of 256 only
bounds pathological diffs; `run.max_parallel: 8` is what bounds how many
reviewers run at once), and every reviewer's one-line verdict joins into
the `found` text port the aggregator reads.

## How to run it

Store a copy of this machine as a runtime instance and run it, or run the
template directly from the library:

    result = await rlm.factory.run("review-sweep")

Then watch progress with `await rlm.factory.status(result["run_id"])`. The
run finishes at quiescence; the aggregator's `issues` JSON is the latest
settle answer of the `report` state.

```machine-spec
{
  "run": {
    "budget_ms": 900000,
    "failure_policy": "escalate",
    "max_parallel": 8
  },
  "nodes": [
    {
      "id": "files",
      "subagent": {
        "prompt": "List every file the current branch changes relative to the base branch. Run `git merge-base HEAD origin/main` first; when it resolves, list the changed files with `git diff --name-only <merge-base>`; when it does not, fall back to `git diff --name-only HEAD~1`. Return a fenced json block of the form {\\\"files\\\": [\\\"path/to/file\\\", ...]} with one entry per changed file. Output only the json block.",
        "name": "files-source"
      },
      "outputs": [
        {
          "name": "files",
          "type": "json"
        }
      ],
      "budget_ms": 240000
    },
    {
      "id": "review",
      "subagent": {
        "prompt": "Review the changed file {files} for merge-blocking defects: correctness bugs, regressions, unhandled error paths, and missing tests. Read the file in the working tree and judge the change itself. Reply with one short line: `<path>: <the most serious problem, or 'clean'>`.",
        "name": "file-reviewer"
      },
      "inputs": [
        {
          "name": "files",
          "type": "json",
          "from": "files.files"
        }
      ],
      "outputs": [
        {
          "name": "found",
          "type": "text"
        }
      ],
      "foreach": {
        "over": "files",
        "max": 256
      },
      "budget_ms": 240000
    },
    {
      "id": "report",
      "subagent": {
        "prompt": "You are given the list of changed files and one review line per file below. Merge them into a fenced json block of the form {\\\"issues\\\": [{\\\"file\\\": \\\"path\\\", \\\"finding\\\": \\\"...\"}]} that lists every file whose review line is not clean, and add a `clean` count. Output only the json block.",
        "name": "review-aggregator"
      },
      "inputs": [
        {
          "name": "file_list",
          "type": "json",
          "from": "files.files"
        },
        {
          "name": "found",
          "type": "text",
          "from": "review.found"
        }
      ],
      "outputs": [
        {
          "name": "issues",
          "type": "json"
        }
      ],
      "budget_ms": 240000
    }
  ]
}
```

