---
name: factory
description: Run state-machine workflows of spawned child agents: store a validated machine or dag spec as a continual-harness factory entry (rlm.harness.create_factory), then run, watch, stop, and resume it through rlm.factory. For the full authoring reference and API guide, call rlm.factory.help() in the kernel.
---

# Factory

The factory runs state-machine workflows of spawned child agents. A stored
factory entry — harness kind `factory`, written with
`rlm.harness.create_factory` — declares the machine: states, each backed by
a subagent spec, plus guarded transitions between them. The spec validates
at write time (machine form, or `dag` sugar that compiles to one; pass
exactly one), and an invalid spec is never stored.
`await rlm.factory.run('<spec_id>')` then spawns each state's subagent as an
ordinary child, feeds captured outputs into the successors' prompts, and
drives the run to quiescence in a background kernel task — the call
returns immediately and the run continues after the model turn ends. Use
it when a workflow needs shape: fan-out, bounded loops (review/fix until a
verdict approves), joins, or one child per list item.

**For the full authoring reference and API guide — states, ports, guards,
joins, foreach, residents, budgets and policies, and the `rlm.factory`
run/status/stop/resume/graph/watch calls with worked examples — call
`rlm.factory.help()` in the kernel.** The guide lands with the factory-core
PR; on builds without it, the module docstring in
`prime-agent-runtime/src/rlm/factory.py` is the source of truth.

## Discovering machines

- The machine library (arriving on the stacked machine-library PR):
  machines are `MACHINE.md` files, one directory per machine under the
  repository's `machines/` and a personal `machines/` library under the
  agent dir; `prime-agent factory list | import | export` manages them. The
  seeds are `builder`, `pr-manager`, and `review-sweep`.
- The TUI factory page: the activity dock's `⚙ N factory` group (Enter or
  click) opens one live diagram per run, newest run first. `j`/`k` move the
  selection, `s` stops the selected run, `r` resumes it, `m` copies it as
  Mermaid source, Esc closes.
