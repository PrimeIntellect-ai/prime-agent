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
`list[T]`, and record names.

Routing has two forms. `next` is unconditional. `route` switches on one
enum or bool output, and every value needs a target. Any other condition is
a python state that returns an enum. A `join` state waits for every member,
and each member names it in `next`.

## Scope

- Load a machine directory into [`Machine`] with every problem reported as
  a [`Diagnostic`] (`file: key.path: message`).
- Check types (`types::check_value`) with exact value paths, shared by
  params today and typed outputs later.
- Compile to the canonical v1 machine spec (`run`, `params`, `states`,
  `transitions`) the Python executor validates and runs. Prompts gain the
  shared context, the rubric, and a generated Outputs section.
- Convert a stored v1 spec (machine or dag form) into directory files.

## Non-goals

- Running machines, spawning children, or reading sessions.
- Model catalog resolution: roles carry selectors; the session resolves
  them at spawn time.
- Library resolution: callers decide which directories to load.

## Public API

`load_machine_dir`, `compile`, `convert_spec`, `parse_duration_ms`, the
`types` module, and the model types re-exported from the crate root.

## Dependencies

`serde`, `serde_json`, `toml`. No workspace crates; `pa-core` and `pa-cli`
depend on this crate.
