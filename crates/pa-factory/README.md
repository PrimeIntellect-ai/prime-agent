# pa-factory

The factory machine directory format: the loader, type checker, validator,
compiler, and v1 converter. One implementation serves the CLI
(`prime-agent factory validate|compile|convert|list`) and the session's
`factory.compile` host request, so they cannot disagree about a machine.

## Format

A machine is a directory that can be shared as-is (git, a tarball, a team
machines dir). Nothing in it is generated.

```
rsi/
  machine.toml        format, name, version, params, run, roles, types, states
  prompts/
    _context.md       optional; prepended to every agent state's prompt
    design.md
  rubrics/
    pr-quality.toml   [[rule]] id, check, default severity
  nodes/
    triage.py         python states: plain functions
```

`machine.toml` keys:

- `format = 1` first. A newer format is refused with a clear message.
- `name`, `version` (positive integer), `description`, optional `author`.
- `[params]`: `name = { type = "...", default = ..., description = "..." }`.
  A param with no default is required when the live machine starts.
  Prompts insert params and inputs with `{{name}}`.
- `[run]`: `budget` ("6h"), `max_parallel`, `max_children`,
  `max_transitions`, `failure_policy`.
- `[roles]`: `name = { model = "...", thinking = "..." }`. Agent states
  name a role or a model.
- `[types.<record>]`: `field = "type"`; a trailing `?` makes a field optional.
- `[states.<id>]`: an agent state has `agent = { prompt = "prompts/x.md",
  role = "...", rubric = "rubrics/x.toml", name = "label" }`; a python state
  has `kind = "python"` and `run = "nodes/x.py:function"`. Both take
  `entry`, `inputs = { name = "state.port" }` (`?` when optional),
  `outputs = { port = "type" }`, `next` (a state or a list), `route = { on =
  "port" | "port.field", <value> = "<state>" }`, `join = [...]`,
  `max_entries`, `retries`, `budget`, `failure_policy`, `foreach = { over,
  max }`, and `resident`.

Types: `text`, `int`, `float`, `bool`, `file`, `json`, `enum(a, b)`,
`list[T]`, and record names. A `file` output must be top-level, and only an
agent state can declare one: the loader refuses a `file` inside a list or a
record field, and a `file` output on a python state, because the emit copies
only top-level file ports and a python state has no emit.

Routing has two forms. `next` is unconditional. `route` switches on one
enum or bool output, and every value needs a target. Any other condition is
a python state that returns an enum. A `join` state waits for every member,
and each member names it in `next`.

## Run model

The `run` module holds the rules of a live run. The executor owns the
clock, the children, and the files; it gives the time to each call.

- Status: `running`, `paused` (escalate, budget, `max_transitions`,
  `max_children`), `stopping`, `done`, `failed`, `stopped`. Only a
  `RunEvent` changes the status. An event that the status does not accept
  returns an `IllegalTransition` and changes nothing.
- Joins: a join fires when every member has a settle. Each combination of
  member settles fires one time. A blocked fire (the target has no entries
  left) consumes the combination. A `max_transitions` pause does not.
- Run budget: active time is wall time less paused time. When active time
  is more than `budget`, the next admission pauses the run one time.
- Child budget: agent children count against `max_children`; python
  states do not. The run pauses one time.
- `max_transitions`: the next fire after the limit pauses the run one
  time. The default is 10 for each state, up to 10,000.
- State budget: the child's own run time, else the wall time, is measured
  against the state's `budget`. A python call's time limit is the state's
  budget, then the run's, then 60 s.
- Owner: a run has one owner session (`OwnedRun`). All sessions can read
  the run. Only the owner can change it; another session gets
  `OwnershipError::NotOwner` with the owner's name. When the owner ends,
  the executor calls `abandon`. The run is then `Abandoned` and claimable
  until a session calls `take_over`. A takeover cannot remove a live
  owner.
- Quiescence: an entry settles only when every child it admitted settled
  and the executor committed its result (outputs or failure). No clock
  settles an entry. A run is quiescent when no settle waits for
  evaluation and every entry settled.
- Selector: an input's `from` is `"<state>.<port>"`. It picks that port
  from the latest settle of the state. A reference with more than one
  `.` is ambiguous and is an error.
- Payload: `plan_payloads` checks every input of a canonical spec before
  the run starts. A reference to a state or port that does not exist, a
  resident source, or a type mismatch fails there with the port named.
  `PayloadPlan::bind` copies the selected values into a typed `Payload`
  record. A required input waits for its source and fails when the
  settled source has no value. An optional input binds `null`, but waits
  for another state that is live. A foreach input gives one record for
  each item, up to `max`.

## Scope

- Load a machine directory into [`Machine`] with every problem reported as
  a [`Diagnostic`] (`file: key.path: message`).
- Check types (`types::check_value`) with exact value paths, for params
  and for outputs: each state's [`Contract`] (written into the canonical
  spec as `emit`) is what a child's `rlm.factory.emit` and a python
  state's returned dict are checked against.
- Compile to the canonical v1 machine spec (`run`, `params`, `states`,
  `transitions`) the Python executor validates and runs. Prompts gain the
  shared context, the rubric, and a generated Outputs section.
- Convert a stored v1 spec (machine or dag form) into directory files.

## Non-goals

- Spawning children, reading sessions, or reading a clock. The run model
  decides; the executor acts.
- Model catalog resolution: roles carry selectors; the session resolves
  them at spawn time.
- Library resolution: callers decide which directories to load.

## Public API

`load_machine_dir`, `compile`, `convert_spec`, `Contract`,
`parse_duration_ms`, the `types` module, and the model types re-exported
from the crate root.

## Dependencies

`serde`, `serde_json`, `toml`. No workspace crates; `pa-core` and `pa-cli`
depend on this crate.
