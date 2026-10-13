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

## The opt-in gate

The factory ships disabled. `rlm.factory.help()` answers while it is off
(the authoring guide stays readable before opting in), but every other
`rlm.factory` call and every factory harness write refuses with one
message: `the factory is disabled; run /factory on to enable it`. The
user turns it on with `/factory on` in the client (`/factory off`
disables it again — refused while the session still has live runs, and
on a lane-advertising client while the live-run count cannot be read, so
an active factory never loses its stop path, `/factory status` reports
it), which persists the
`factory.enabled` setting in the agent dir's settings.json — the same
setting the daemon's `factory_activity` lane advertisement reads, so the
TUI's factory dock group and page surface only on a client started while
the factory is enabled. If a call refuses with that message, tell the
user to run `/factory on` and restart the client.

## Discovering machines

- The machine library: machines are `MACHINE.md` files, one directory
  per machine — the bundled seeds ship inside the runtime package (wheel
  package data, `rlm/machines/<name>/MACHINE.md`; `PRIME_AGENT_MACHINES_DIR`
  redirects that level at a team directory), and the personal library
  lives under the agent dir. `prime-agent factory list | import | export`
  manages them. The seeds are `builder`, `pr-manager`, and `review-sweep`.
- The TUI factory page: the activity dock's `⚙ N factory` group (Enter or
  click) opens one live diagram per run, newest run first. The up/down
  arrows move the selection, Enter opens the selected run's action rows
  (stop, or resume while it is paused — arrows to walk, Enter to run),
  Esc closes.
