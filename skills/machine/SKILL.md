---
name: machine
description: "Run state-machine workflows of spawned child agents: store a validated machine or dag spec as a continual-harness entry (harness kind factory, rlm.harness.create_factory), then run, watch, stop, and resume it through rlm.machine. For the full authoring reference and API guide, call rlm.machine.help() in the kernel."
---

# Machines

A machine runs a state-machine workflow of spawned child agents. A stored
machine entry — harness kind `factory`, written with
`rlm.harness.create_factory` — declares the machine: states, each backed by
a subagent spec, plus guarded transitions between them. The spec validates
at write time (machine form, or `dag` sugar that compiles to one; pass
exactly one), and an invalid spec is never stored.
`await rlm.machine.run('<spec_id>')` then spawns each state's subagent as an
ordinary child, feeds captured outputs into the successors' prompts, and
drives the run to quiescence in a background kernel task — the call
returns immediately and the run continues after the model turn ends. Use
it when a workflow needs shape: fan-out, bounded loops (review/fix until a
verdict approves), joins, or one child per list item.

**For the full authoring reference and API guide — states, ports, guards,
joins, foreach, residents, budgets and policies, and the `rlm.machine`
run/status/stop/resume/graph/watch calls with worked examples — call
`rlm.machine.help()` in the kernel.**

## The opt-in gate

Machines ship disabled. `rlm.machine.help()` answers while they are off
(the authoring guide stays readable before opting in), but every other
`rlm.machine` call and every machine harness write refuses with one
message: `machines are disabled; run /machine on to enable them`. The
user turns them on with `/machine on` in the client (`/machine off`
disables them again — refused while the session still has live runs, and
on a lane-advertising client while the live-run count cannot be read, so
an active machine never loses its stop path; `/machine status` reports
the gate), which persists the `machine.enabled` setting in the agent
dir's settings.json — the same setting the daemon's lane advertisement
reads, so the TUI's machines dock group and page surface only on a
client started while machines are enabled. If a call refuses with that
message, tell the user to run `/machine on` and restart the client.

## Discovering machines

- The machine library: machines are `MACHINE.md` files, one directory
  per machine — the bundled seeds ship inside the runtime package (wheel
  package data, `rlm/machines/<name>/MACHINE.md`; `PRIME_AGENT_MACHINES_DIR`
  redirects that level at a team directory), and the personal library
  lives under the agent dir. `prime-agent machine list | import | export`
  manages them. The seeds are `builder`, `pr-manager`, and `review-sweep`.
- The TUI machines page: the activity dock's `⚙ N machines` group (Enter
  or click) opens one live diagram per run, newest run first. The up/down
  arrows walk the run headers and the states that spawned a child;
  Enter or Right opens the selected state's latest child session, and
  Left or Esc closes the page. Ctrl+X (the agents view's stop key) twice
  stops the selected row: the whole run on its header, or the state's
  running child (that attempt fails under the state's `retries` and
  `failure_policy`). `r` resumes a paused run.
