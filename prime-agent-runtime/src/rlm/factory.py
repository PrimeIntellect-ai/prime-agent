"""Validation and compilation for factory specifications.

A continual-harness ``factory`` entry stores a declarative state machine of
subagent states in ``arguments["machine"]``: entry states (which declare
no inputs), guarded transitions between states, and bounded re-entry
(``max_entries``). The original DAG form in ``arguments["dag"]`` stays as
sugar: it compiles to machine form (each node becomes a state entered
once; a node's full effective dependency set compiles to ONE join
transition that waits for every predecessor, so fan-in nodes never start
after a single parent settles with a blocked second transition). Wait
states are specified for the communication series but gated here:
the watch host handlers (``rlm.watch.*``) do not exist yet, so a state
carrying a ``wait`` block is rejected at write time.

This module implements the write-time dry run for both forms -- the machine
validator, the dag-to-machine compiler, the unified entry point
(``validate_factory_spec`` detects the form), and a canonicalizer that
applies defaults and returns the canonical MACHINE form -- plus the
executor (``FactoryExecutor`` and the ``rlm.factory`` namespace:
run/status/stop/resume) that runs canonicalized machines through the
existing RLM supervisor: states are admitted with ``rlm.spawn``, settled
through ``rlm.collect``, and cancelled with ``rlm.delete_subagent``. The
supervisor owns the children; the executor owns the run state in kernel
memory. Runs do not survive a kernel restart (the registry lives in this
module's state); children are supervisor-owned and keep running, so
``rlm.list_subagents`` can still see them after a restart.

The full agent-facing reference — authoring rules, guards/joins/cycles,
foreach, budgets, stall detectors, and the ``rlm.factory`` API with worked
examples — is embedded in this module as ``FACTORY_HELP``;
``rlm.factory.help()`` returns it with no filesystem resolution, so
packaged kernels (where the repo layout is not adjacent) see the same
guide.

The namespace is opt-in: while the ``factory.enabled`` setting is off (the
default; the user turns it on with ``/factory on``), every ``rlm.factory``
call except ``help()`` and every factory harness write refuses with one
clean message (``FACTORY_DISABLED_MESSAGE``), never a crash.
"""

from __future__ import annotations

import copy
import hashlib
import heapq
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

FAILURE_POLICIES: tuple[str, ...] = ("fail_fast", "continue", "escalate")
PORT_TYPES: tuple[str, ...] = ("text", "json")
LIFECYCLES: tuple[str, ...] = ("task", "resident")
TRANSITION_ON_KINDS: tuple[str, ...] = ("settled",)
GUARD_OPS: tuple[str, ...] = ("eq", "ne", "gt", "gte", "lt", "lte", "exists", "contains")
MAX_NODES = 1024
MAX_STATES = MAX_NODES
MAX_RETRIES = 10
MAX_PARALLEL_MIN = 1
MAX_PARALLEL_MAX = 64
FOREACH_MAX_MIN = 1
FOREACH_MAX_MAX = 256
MAX_TRANSITIONS_CAP = 10_000
MAX_CHILDREN_CAP = 1_000_000
TRANSITIONS_PER_STATE_DEFAULT = 10
RUN_FAILURE_POLICY_DEFAULT = "escalate"
RUN_MAX_PARALLEL_DEFAULT = 8
RUN_MAX_CHILDREN_DEFAULT = 10_000
NODE_LIFECYCLE_DEFAULT = "task"
NODE_RETRIES_DEFAULT = 0
STATE_ENTRY_DEFAULT = False
STATE_MAX_ENTRIES_DEFAULT = 1
#: An inline subagent ``name`` labels the spawned children; the host caps
#: subagent session names at 64 characters (the same limit the generated
#: label stays under), so a longer configured name is rejected at write
#: time instead of failing every spawn admission.
SUBAGENT_NAME_MAX_LENGTH = 64

_NODE_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")


def _is_int(value: Any) -> bool:
    """True for real integers; booleans are not accepted as ints."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    """True for real numbers; booleans are not accepted as numbers."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_scalar(value: Any) -> bool:
    """True for JSON scalars (str, int, float, bool, None); lists and objects are not."""
    return value is None or isinstance(value, (str, int, float, bool))


def _is_positive_int(value: Any) -> bool:
    return _is_int(value) and value > 0


def _is_nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _valid_node_id(value: Any) -> bool:
    return _is_nonempty_str(value) and _NODE_ID_PATTERN.fullmatch(value) is not None


def _port_list(node: dict[str, Any], key: str) -> list[Any]:
    """Return the node's inputs/outputs list, or [] when absent or malformed."""
    raw = node.get(key)
    return raw if isinstance(raw, list) else []


def _declared_port_types(node: dict[str, Any], key: str) -> dict[str, str]:
    """Map port name to type for well-formed entries of the node's port list."""
    ports: dict[str, str] = {}
    for entry in _port_list(node, key):
        if isinstance(entry, dict):
            name, port_type = entry.get("name"), entry.get("type")
            if _is_nonempty_str(name) and port_type in PORT_TYPES:
                ports[name] = port_type
    return ports


def _effective_output_types(state: dict[str, Any]) -> dict[str, str]:
    """Output ports readable from a state: its declared outputs."""
    return _declared_port_types(state, "outputs")


def _input_sources(node: dict[str, Any]) -> list[str]:
    """Source node ids referenced by the node's inputs."""
    sources: list[str] = []
    for inp in _port_list(node, "inputs"):
        if not isinstance(inp, dict):
            continue
        source = inp.get("from")
        if isinstance(source, str) and "." in source:
            sources.append(source.partition(".")[0])
    return sources


def _is_machine_form(spec: Any) -> bool:
    """Machine form wins whenever a states/transitions key is present."""
    return isinstance(spec, dict) and ("states" in spec or "transitions" in spec)


# ---------------------------------------------------------------------------
# Shared field checks (used by both the dag compiler and the machine validator).
# ---------------------------------------------------------------------------


def _validate_run_fields(run: Any, errors: list[str]) -> int | None:
    """Shared run-block checks. Returns the run budget when valid, else None.

    ``run`` must already be a dict or None; the caller reports "run must be
    an object" for other shapes.
    """
    if not isinstance(run, dict):
        return None
    # Typed fields are validated by PRESENCE, not by "is not None": an
    # explicit JSON null (run.max_parallel: null) must be rejected with the
    # field's own message, never silently treated as an omitted default
    # (a null that survived canonicalization reached the executor without a
    # usable typed limit).
    if "budget_ms" in run and not _is_positive_int(run.get("budget_ms")):
        errors.append("run budget_ms must be a positive integer")
    run_budget = run.get("budget_ms") if _is_positive_int(run.get("budget_ms")) else None
    if "failure_policy" in run and run.get("failure_policy") not in FAILURE_POLICIES:
        errors.append(f"run failure_policy must be one of {list(FAILURE_POLICIES)}, got {run.get('failure_policy')!r}")
    max_parallel = run.get("max_parallel")
    if "max_parallel" in run and not (
        _is_int(max_parallel) and MAX_PARALLEL_MIN <= max_parallel <= MAX_PARALLEL_MAX
    ):
        errors.append(f"run max_parallel must be an integer between {MAX_PARALLEL_MIN} and {MAX_PARALLEL_MAX}")
    max_transitions = run.get("max_transitions")
    if "max_transitions" in run and not (
        _is_positive_int(max_transitions) and max_transitions <= MAX_TRANSITIONS_CAP
    ):
        errors.append(f"run max_transitions must be a positive integer no greater than {MAX_TRANSITIONS_CAP}")
    max_children = run.get("max_children")
    if "max_children" in run and not (
        _is_positive_int(max_children) and max_children <= MAX_CHILDREN_CAP
    ):
        errors.append(f"run max_children must be a positive integer no greater than {MAX_CHILDREN_CAP}")
    return run_budget


def _validate_state_fields(
    state: dict[str, Any],
    *,
    run_budget: int | None,
    states_by_id: dict[str, dict[str, Any]],
    noun: str,
    errors: list[str],
) -> None:
    """Field rules shared by dag nodes (noun="node") and machine states
    (noun="state"): subagent forms, lifecycle, budgets, retries, failure
    policies, port lists, foreach, and the resident exclusions."""
    ref = state["id"]
    # Presence-based checks like the run block: an explicit JSON null on a
    # typed field is rejected with the field's own message instead of
    # surviving canonicalization as None.
    lifecycle = state.get("lifecycle", NODE_LIFECYCLE_DEFAULT)
    if "lifecycle" in state and lifecycle not in LIFECYCLES:
        errors.append(f"{noun} {ref} lifecycle must be 'task' or 'resident', got {lifecycle!r}")
    is_resident = lifecycle == "resident"

    if state.get("wait") is not None:
        # Gated: the watch host handlers (rlm.watch.*) arrive with the
        # communication series; a wait block would silently no-op until then.
        errors.append(
            f"{noun} {ref}: wait states require the watch host handlers (rlm.watch.*); "
            "they arrive with the communication series - remove the wait block until then"
        )

    subagent = state.get("subagent")
    if _is_nonempty_str(subagent):
        pass  # Harness subagent entry id or title; resolved at run time.
    elif isinstance(subagent, dict):
        # Runtime resolution strips these fields (_resolve_subagents /
        # _validate_spawn_settings), so whitespace-only values are rejected
        # here too: a persistable factory must be spawnable.
        if not isinstance(subagent.get("prompt"), str) or not subagent.get("prompt").strip():
            errors.append(f"{noun} {ref} inline subagent requires a non-empty prompt")
        for key in ("name", "model", "thinking"):
            value = subagent.get(key)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                errors.append(f"{noun} {ref} inline subagent {key} must be a non-empty string when provided")
        configured_name = subagent.get("name")
        if isinstance(configured_name, str) and len(configured_name.strip()) > SUBAGENT_NAME_MAX_LENGTH:
            errors.append(
                f"{noun} {ref} inline subagent name must be at most "
                f"{SUBAGENT_NAME_MAX_LENGTH} characters, got {len(configured_name.strip())}"
            )
    else:
        errors.append(
            f"{noun} {ref} requires a subagent: a harness subagent id/title string "
            "or an inline object with a prompt"
        )

    if "budget_ms" in state:
        budget = state.get("budget_ms")
        if not _is_positive_int(budget):
            errors.append(f"{noun} {ref} budget_ms must be a positive integer")
        elif run_budget is not None and budget > run_budget:
            errors.append(f"{noun} {ref} budget_ms {budget} exceeds the run budget_ms {run_budget}")

    if "retries" in state and not (_is_int(state.get("retries")) and 0 <= state.get("retries") <= MAX_RETRIES):
        errors.append(f"{noun} {ref} retries must be an integer between 0 and {MAX_RETRIES}")

    if "failure_policy" in state and state.get("failure_policy") not in FAILURE_POLICIES:
        errors.append(
            f"{noun} {ref} failure_policy must be one of {list(FAILURE_POLICIES)}, got {state.get('failure_policy')!r}"
        )

    outputs = state.get("outputs")
    if outputs is not None and not isinstance(outputs, list):
        errors.append(f"{noun} {ref} outputs must be a list")
    elif is_resident and isinstance(outputs, list) and outputs:
        errors.append(f"resident {noun} {ref} cannot declare outputs")
    # Duplicate ports are tracked with seen sets (one pass over the list):
    # a rebuild-and-count scan is quadratic in the port count, and a state
    # with tens of thousands of ports would block write-time validation.
    seen_output_names: set[Any] = set()
    reported_duplicate_outputs: set[Any] = set()
    for index, out in enumerate(_port_list(state, "outputs")):
        if not isinstance(out, dict):
            errors.append(f"{noun} {ref} outputs[{index}] must be an object")
            continue
        name, port_type = out.get("name"), out.get("type")
        if not _is_nonempty_str(name):
            errors.append(f"{noun} {ref} outputs[{index}] requires a non-empty name")
        elif name in seen_output_names:
            if name not in reported_duplicate_outputs:
                reported_duplicate_outputs.add(name)
                errors.append(f"{noun} {ref} declares duplicate output name {name!r}")
        else:
            seen_output_names.add(name)
        if port_type not in PORT_TYPES:
            errors.append(f"{noun} {ref} output {name!r} type must be 'text' or 'json'")

    inputs = state.get("inputs")
    if inputs is not None and not isinstance(inputs, list):
        errors.append(f"{noun} {ref} inputs must be a list")
    seen_input_names: set[Any] = set()
    reported_duplicate_inputs: set[Any] = set()
    # One output-type map per source state (a rebuild per input line would
    # make validating many inputs from one source quadratic in the source's
    # output count).
    output_types_by_source: dict[str, dict[str, str]] = {}
    for index, inp in enumerate(_port_list(state, "inputs")):
        if not isinstance(inp, dict):
            errors.append(f"{noun} {ref} inputs[{index}] must be an object")
            continue
        name, port_type, source = inp.get("name"), inp.get("type"), inp.get("from")
        optional = inp.get("optional")
        if optional is not None and not isinstance(optional, bool):
            errors.append(f"{noun} {ref} input {name!r} optional must be a boolean when provided")
        if not _is_nonempty_str(name):
            errors.append(f"{noun} {ref} inputs[{index}] requires a non-empty name")
        elif name in seen_input_names:
            if name not in reported_duplicate_inputs:
                reported_duplicate_inputs.add(name)
                errors.append(f"{noun} {ref} declares duplicate input name {name!r}")
        else:
            seen_input_names.add(name)
        if port_type not in PORT_TYPES:
            errors.append(f"{noun} {ref} input {name!r} type must be 'text' or 'json'")
        if not isinstance(source, str) or "." not in source:
            errors.append(
                f"{noun} {ref} input {name!r} requires a 'from' reference of the form '<node_id>.<output_name>'"
            )
            continue
        src_id, _, src_output = source.partition(".")
        if src_id not in states_by_id:
            errors.append(f"{noun} {ref} input {name!r} references unknown {noun} {src_id!r}")
            continue
        src = states_by_id[src_id]
        if src.get("lifecycle", NODE_LIFECYCLE_DEFAULT) == "resident":
            errors.append(f"{noun} {ref} input {name!r} cannot read from resident {noun} {src_id!r}")
            continue
        if src_id not in output_types_by_source:
            output_types_by_source[src_id] = _effective_output_types(src)
        src_output_types = output_types_by_source[src_id]
        if src_output not in src_output_types:
            errors.append(
                f"{noun} {ref} input {name!r} references output {src_output!r} "
                f"that {noun} {src_id!r} does not declare"
            )
        elif port_type in PORT_TYPES and src_output_types[src_output] != port_type:
            errors.append(
                f"{noun} {ref} input {name!r} of type {port_type!r} cannot read from "
                f"output {src_output!r} of type {src_output_types[src_output]!r}"
            )

    foreach = state.get("foreach")
    if foreach is not None:
        if is_resident:
            errors.append(f"resident {noun} {ref} cannot use foreach")
        if not isinstance(foreach, dict):
            errors.append(f"{noun} {ref} foreach must be an object")
        else:
            over = foreach.get("over")
            if not _is_nonempty_str(over):
                errors.append(f"{noun} {ref} foreach.over must be a non-empty input name")
            else:
                declared_inputs = _declared_port_types(state, "inputs")
                if over not in declared_inputs:
                    errors.append(
                        f"{noun} {ref} foreach.over must name one of this {noun}'s inputs, got {over!r}"
                    )
                elif declared_inputs[over] != "json":
                    errors.append(f"{noun} {ref} foreach.over input {over!r} must have type 'json'")
            foreach_max = foreach.get("max")
            if not (_is_int(foreach_max) and FOREACH_MAX_MIN <= foreach_max <= FOREACH_MAX_MAX):
                errors.append(
                    f"{noun} {ref} foreach.max must be an integer between {FOREACH_MAX_MIN} and {FOREACH_MAX_MAX}"
                )


# ---------------------------------------------------------------------------
# Machine-form validation.
# ---------------------------------------------------------------------------


def _validate_guard(
    when: Any,
    index: int,
    src_state: dict[str, Any],
    errors: list[str],
) -> None:
    if not isinstance(when, dict):
        errors.append(f"transitions[{index}] when must be an object")
        return
    output = when.get("output")
    src_types = _effective_output_types(src_state)
    if not _is_nonempty_str(output):
        errors.append(f"transitions[{index}] when requires a non-empty output")
    elif output not in src_types:
        errors.append(
            f"transitions[{index}] when.output {output!r} is not a declared "
            f"output of state {src_state.get('id')!r}"
        )
    else:
        path = when.get("path")
        if path is not None:
            if not _is_nonempty_str(path):
                errors.append(f"transitions[{index}] when.path must be a non-empty dotted path")
            elif src_types[output] != "json":
                errors.append(
                    f"transitions[{index}] when.path requires a json output, got text output {output!r}"
                )
    op = when.get("op")
    if op not in GUARD_OPS:
        errors.append(f"transitions[{index}] when.op must be one of {list(GUARD_OPS)}, got {op!r}")
        return
    if op == "exists":
        return  # existence carries no value
    value = when.get("value")
    if op in ("gt", "gte", "lt", "lte"):
        if not _is_number(value):
            errors.append(f"transitions[{index}] when.op {op!r} requires a numeric value")
    elif op == "contains":
        if not isinstance(value, list) or not value:
            errors.append(f"transitions[{index}] when.op 'contains' requires a non-empty list value")
    elif op in ("eq", "ne") and not _is_scalar(value):
        errors.append(f"transitions[{index}] when.op {op!r} requires a scalar value")


def validate_factory_machine(machine: Any) -> list[str]:
    """Dry-run validation for a machine-form factory spec.

    Returns a list of human-readable error sentences; an empty list means
    the machine is valid. Rules: states are 1..1024 with unique slug ids and
    at least one entry state; every state requires a subagent and entry
    states declare no inputs; resident states declare no outputs, foreach,
    or outgoing transitions; wait blocks are rejected (the watch host
    handlers arrive with the communication series); transitions reference
    existing states (self-loops are legal re-entry) and may carry one guard
    over the from-state's latest settle output; a transition with a LIST of
    from-states is a join that fires once every source settled (guards are
    single-source only). There is no acyclicity requirement: arbitrary
    state machines, including cycles, validate.
    """
    if not isinstance(machine, dict):
        return ["factory machine must be a JSON object"]
    errors: list[str] = []
    run = machine.get("run")
    if run is not None and not isinstance(run, dict):
        errors.append("run must be an object")
        run = None
    run_budget = _validate_run_fields(run, errors)

    states = machine.get("states")
    if not isinstance(states, list):
        errors.append("factory machine requires a states list")
        return errors
    if not 1 <= len(states) <= MAX_STATES:
        errors.append(f"factory machine must declare between 1 and {MAX_STATES} states, got {len(states)}")
        return errors

    seen_ids: set[str] = set()
    states_by_id: dict[str, dict[str, Any]] = {}
    for index, state in enumerate(states):
        if not isinstance(state, dict):
            errors.append(f"states[{index}] must be an object")
            continue
        state_id = state.get("id")
        if not _is_nonempty_str(state_id):
            errors.append(f"states[{index}] requires a non-empty id")
        elif not _valid_node_id(state_id):
            errors.append(f"states[{index}] id must match ^[a-z0-9][a-z0-9-]{{0,63}}$, got {state_id!r}")
        elif state_id in seen_ids:
            errors.append(f"states[{index}] duplicates state id {state_id!r}")
        else:
            seen_ids.add(state_id)
            states_by_id[state_id] = state

    # Configured inline subagent names label the spawned children verbatim,
    # so two states sharing one name would collide on the supervisor's
    # unique sibling-name requirement at spawn time; reject the duplicate at
    # write time instead (the same reason duplicate state ids are rejected).
    seen_subagent_names: dict[str, str] = {}
    for state_id, state in states_by_id.items():
        _validate_state_fields(
            state, run_budget=run_budget, states_by_id=states_by_id, noun="state", errors=errors
        )
        subagent = state.get("subagent")
        if isinstance(subagent, dict) and _is_nonempty_str(subagent.get("name")):
            configured_name = subagent["name"].strip()
            base_seen = next(
                (seen for seen in seen_subagent_names if _suffixed_spawn_form(seen, configured_name)),
                None,
            )
            base_current = (
                None
                if base_seen is not None
                else next(
                    (seen for seen in seen_subagent_names if _suffixed_spawn_form(configured_name, seen)),
                    None,
                )
            )
            if configured_name in seen_subagent_names:
                errors.append(
                    f"state {state_id} subagent name {configured_name!r} is already configured "
                    f"by state {seen_subagent_names[configured_name]!r}"
                )
            elif base_seen is not None:
                # One state's suffixed labels are another state's verbatim
                # name (foo vs foo-i1): the supervisor would reject the
                # duplicate sibling name at spawn time, so reject the
                # shadowing name at write time. The seen name generates the
                # labels here.
                errors.append(
                    f"state {state_id} subagent name {configured_name!r} collides with the "
                    f"suffixed spawn labels of state {seen_subagent_names[base_seen]!r} "
                    f"(configured {base_seen!r}): re-entry, foreach, and retries name children "
                    f"{base_seen!r}-i<n> and {base_seen!r}-a<n>"
                )
            elif base_current is not None:
                # The reverse direction: THIS state's name generates the
                # suffixed labels, and an earlier state's name is one of
                # them.
                errors.append(
                    f"state {state_id} subagent name {configured_name!r} suffixed by re-entry, "
                    f"foreach, and retries ({configured_name!r}-i<n>, {configured_name!r}-a<n>) "
                    f"collides with state {seen_subagent_names[base_current]!r} "
                    f"(configured {base_current!r})"
                )
            else:
                seen_subagent_names[configured_name] = state_id
        if "entry" in state and not isinstance(state.get("entry"), bool):
            errors.append(f"state {state_id} entry must be a boolean")
        if "max_entries" in state and not (
            _is_int(state.get("max_entries")) and state.get("max_entries") >= STATE_MAX_ENTRIES_DEFAULT
        ):
            errors.append(f"state {state_id} max_entries must be an integer >= {STATE_MAX_ENTRIES_DEFAULT}")
        if state.get("entry") is True and _port_list(state, "inputs"):
            errors.append(f"entry state {state_id} cannot declare inputs")
        # A REQUIRED self-input can never bind: the state's first entry needs
        # its own prior settle, and no settle exists before an entry settles.
        # Optional self-inputs are the loop form (the first entry binds the
        # null sentinel, re-entries re-bind the previous settle), so only the
        # required variant is rejected -- the machine-form mirror of the dag
        # compiler's "node b cannot depend on itself" rule.
        for inp in _port_list(state, "inputs"):
            if not isinstance(inp, dict) or inp.get("optional"):
                continue
            source = inp.get("from")
            if isinstance(source, str) and "." in source and source.partition(".")[0] == state_id:
                errors.append(
                    f"state {state_id} input {inp.get('name')!r} cannot require itself: "
                    "mark the self-input optional - a required one can never bind on the state's first entry"
                )

    # The entry check needs at least one well-formed state: a machine whose
    # only state failed its id check reports that problem alone, and a flag
    # that is not a boolean never counts as declaring an entry.
    if states_by_id and not any(state.get("entry") is True for state in states_by_id.values()):
        errors.append("factory machine requires at least one entry state")

    transitions = machine.get("transitions")
    if transitions is None:
        transitions = []
    if not isinstance(transitions, list):
        errors.append("factory machine transitions must be a list")
        return errors
    for index, transition in enumerate(transitions):
        if not isinstance(transition, dict):
            errors.append(f"transitions[{index}] must be an object")
            continue
        raw_src = transition.get("from")
        dst = transition.get("to")
        # ``from`` is one state id, or a list of them: a JOIN transition that
        # fires only once every source state has settled (the compiled dag
        # fan-in shape; a join may not carry a guard -- a guard needs exactly
        # one from-state's latest settle output to compare against).
        if isinstance(raw_src, list):
            sources = raw_src
            if not sources:
                errors.append(f"transitions[{index}] from must name at least one state")
            elif not all(_is_nonempty_str(src) for src in sources):
                # Type-check BEFORE the set() dedupe: a malformed entry (a
                # dict, a list) is unhashable and would raise a raw TypeError
                # instead of reporting a validation error.
                errors.append(f"transitions[{index}] from entries must be non-empty state id strings")
            elif len(set(sources)) != len(sources):
                errors.append(f"transitions[{index}] from must not repeat a state")
            elif not all(src in states_by_id for src in sources):
                missing = next(src for src in sources if src not in states_by_id)
                errors.append(f"transitions[{index}] references unknown from-state {missing!r}")
            if transition.get("when") is not None:
                errors.append(
                    f"transitions[{index}] with multiple from-states cannot carry a when guard; "
                    "use single-state transitions for guards"
                )
        elif _is_nonempty_str(raw_src):
            sources = [raw_src]
            if raw_src not in states_by_id:
                errors.append(f"transitions[{index}] references unknown from-state {raw_src!r}")
        else:
            sources = []
            errors.append(f"transitions[{index}] requires a non-empty from")
        if not _is_nonempty_str(dst):
            errors.append(f"transitions[{index}] requires a non-empty to")
        elif dst not in states_by_id:
            errors.append(f"transitions[{index}] references unknown to-state {dst!r}")
        on = transition.get("on", TRANSITION_ON_KINDS[0])
        if on not in TRANSITION_ON_KINDS:
            errors.append(f"transitions[{index}] on must be one of {list(TRANSITION_ON_KINDS)}, got {on!r}")
        for src in sources:
            # Malformed sources already reported their own error above; a
            # non-string entry is unhashable and must never reach the dict
            # lookup (validation reports errors; it never raises).
            if _is_nonempty_str(src) and src in states_by_id:
                src_state = states_by_id[src]
                if src_state.get("lifecycle", NODE_LIFECYCLE_DEFAULT) == "resident":
                    errors.append(f"transitions[{index}] cannot leave resident state {src!r}")
                if len(sources) == 1:
                    when = transition.get("when")
                    if when is not None:
                        _validate_guard(when, index, src_state, errors)
    return errors


# ---------------------------------------------------------------------------
# Dag compatibility: compile the V1 dag form to machine form.
# ---------------------------------------------------------------------------


def _effective_dag_edges(node: dict[str, Any]) -> list[str]:
    """Effective dependency edges: depends_on plus every inputs[].from source,
    deduplicated in first-seen order."""
    edges: list[str] = []
    for dep in _port_list(node, "depends_on"):
        if isinstance(dep, str) and dep and dep not in edges:
            edges.append(dep)
    for source in _input_sources(node):
        if source not in edges:
            edges.append(source)
    return edges


def compile_factory_dag(dag: Any) -> "tuple[dict[str, Any] | None, list[str]]":
    """Compile a dag-form spec into machine form.

    Returns ``(machine, errors)``: on success the machine is a spec-shaped
    dict (defaults are applied later by ``canonicalize_factory_spec``) and the
    error list is empty; on any dag-level error the machine is ``None`` and
    the errors carry the V1 dag wording. Each node becomes a state with
    ``entry`` set when it has no effective dependencies and ``max_entries``
    1; the node's full effective dependency set becomes ONE guard-less join
    transition (a single dependency stays a plain ``from`` string; several
    become a ``from`` list). Wait blocks are rejected by the shared field
    check (they are gated until the communication series); the compiler
    itself has no wait support.
    """
    if not isinstance(dag, dict):
        return None, ["factory dag must be a JSON object"]
    errors: list[str] = []
    run = dag.get("run")
    if run is not None and not isinstance(run, dict):
        errors.append("run must be an object")
        run = None
    run_budget = _validate_run_fields(run, errors)

    nodes = dag.get("nodes")
    if not isinstance(nodes, list):
        return None, errors + ["factory dag requires a nodes list"]
    if not 1 <= len(nodes) <= MAX_NODES:
        return None, errors + [f"factory dag must declare between 1 and {MAX_NODES} nodes, got {len(nodes)}"]

    seen_ids: set[str] = set()
    nodes_by_id: dict[str, dict[str, Any]] = {}
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            errors.append(f"nodes[{index}] must be an object")
            continue
        node_id = node.get("id")
        if not _is_nonempty_str(node_id):
            errors.append(f"nodes[{index}] requires a non-empty id")
        elif not _valid_node_id(node_id):
            errors.append(f"nodes[{index}] id must match ^[a-z0-9][a-z0-9-]{{0,63}}$, got {node_id!r}")
        elif node_id in seen_ids:
            errors.append(f"nodes[{index}] duplicates node id {node_id!r}")
        else:
            seen_ids.add(node_id)
            nodes_by_id[node_id] = node

    for node_id, node in nodes_by_id.items():
        _validate_state_fields(
            node, run_budget=run_budget, states_by_id=nodes_by_id, noun="node", errors=errors
        )
        # The self-dependency rule covers the EFFECTIVE edge set, not only
        # depends_on: a node that reads its own output would compile to a
        # never-reachable self-loop state, so reject it here like
        # depends_on: [self].
        if node_id in _input_sources(node):
            errors.append(f"node {node_id} cannot depend on itself")
        depends_on = node.get("depends_on")
        if depends_on is not None:
            if not isinstance(depends_on, list):
                errors.append(f"node {node_id} depends_on must be a list of node ids")
            else:
                for dep in depends_on:
                    if not _is_nonempty_str(dep):
                        errors.append(f"node {node_id} depends_on entries must be non-empty node id strings")
                    elif dep == node_id:
                        errors.append(f"node {node_id} cannot depend on itself")
                    elif dep not in nodes_by_id:
                        errors.append(f"node {node_id} depends on unknown node {dep!r}")
                    elif nodes_by_id[dep].get("lifecycle", NODE_LIFECYCLE_DEFAULT) == "resident":
                        errors.append(f"node {node_id} cannot depend on resident node {dep!r}")
    if errors:
        return None, errors

    machine: dict[str, Any] = {"states": [], "transitions": []}
    if run is not None:
        machine["run"] = copy.deepcopy(run)
    for node in nodes:
        edges = _effective_dag_edges(node)
        state: dict[str, Any] = {"id": node["id"], "entry": not edges, "max_entries": STATE_MAX_ENTRIES_DEFAULT}
        for key in ("subagent", "lifecycle", "budget_ms", "retries", "failure_policy", "inputs", "outputs", "foreach"):
            if key in node:
                state[key] = copy.deepcopy(node[key])
        machine["states"].append(state)
        # ONE join transition per node with dependencies (not one per
        # edge): a fan-in node waits for ALL its effective predecessors
        # before entering, so it can never start after just one parent
        # settles and then block the other parent's transition at
        # max_entries with a missing input. A single dependency stays a
        # plain ``from`` string; dependency-free nodes are entry states and
        # emit no transition at all.
        if edges:
            machine["transitions"].append({"from": edges[0] if len(edges) == 1 else edges, "to": node["id"]})
    return machine, []


# ---------------------------------------------------------------------------
# Unified entry points.
# ---------------------------------------------------------------------------


def validate_factory_spec(spec: Any) -> list[str]:
    """Dry-run validation for a factory spec in either form.

    Detects the form first: a spec carrying "states" or "transitions" is
    machine form; anything else is dag form and compiles to machine form
    first. A spec carrying both dag and machine keys is rejected outright.
    Returns a list of human-readable error sentences; an empty list means
    the specification is valid. Every rule is enforced before a factory entry
    is stored, so an invalid spec never reaches the store.
    """
    if not isinstance(spec, dict):
        return ["factory dag must be a JSON object"]
    if _is_machine_form(spec) and "nodes" in spec:
        return ["pass either dag or machine form, not both"]
    if _is_machine_form(spec):
        return validate_factory_machine(spec)
    machine, errors = compile_factory_dag(spec)
    if errors:
        return errors
    # Defense in depth: a compiled dag must produce a valid machine.
    return validate_factory_machine(machine)


def _canonicalize_machine(machine: dict[str, Any]) -> dict[str, Any]:
    """Apply defaults to a validated machine and normalize it into a clean dict.

    Defaults: run failure_policy 'escalate', run max_parallel 8, run
    max_transitions 10 per state capped at 10000, run max_children 10000,
    state entry False, state max_entries 1, state lifecycle 'task', state
    retries 0, state failure_policy copied from the run policy, and
    transition on 'settled'.
    """
    run_in = machine.get("run") if isinstance(machine.get("run"), dict) else {}
    run_policy = run_in.get("failure_policy", RUN_FAILURE_POLICY_DEFAULT)
    states_count = len(machine.get("states") or [])
    run: dict[str, Any] = {
        "failure_policy": run_policy,
        "max_parallel": run_in.get("max_parallel", RUN_MAX_PARALLEL_DEFAULT),
        "max_transitions": run_in.get(
            "max_transitions",
            min(TRANSITIONS_PER_STATE_DEFAULT * states_count, MAX_TRANSITIONS_CAP),
        ),
        "max_children": run_in.get("max_children", RUN_MAX_CHILDREN_DEFAULT),
    }
    if "budget_ms" in run_in:
        run["budget_ms"] = run_in["budget_ms"]
    states_out: list[dict[str, Any]] = []
    for state in machine["states"]:
        state_out: dict[str, Any] = {
            "id": state["id"],
            "entry": bool(state.get("entry", STATE_ENTRY_DEFAULT)),
            "max_entries": state.get("max_entries", STATE_MAX_ENTRIES_DEFAULT),
            "lifecycle": state.get("lifecycle", NODE_LIFECYCLE_DEFAULT),
            "retries": state.get("retries", NODE_RETRIES_DEFAULT),
            "failure_policy": state.get("failure_policy", run_policy),
            "subagent": copy.deepcopy(state["subagent"]),
        }
        for key in ("budget_ms", "inputs", "outputs", "foreach"):
            if key in state:
                state_out[key] = copy.deepcopy(state[key])
        states_out.append(state_out)
    transitions_out: list[dict[str, Any]] = []
    for transition in machine.get("transitions") or []:
        transition_out: dict[str, Any] = {
            "from": transition["from"],
            "to": transition["to"],
            "on": transition.get("on", TRANSITION_ON_KINDS[0]),
        }
        if "when" in transition:
            transition_out["when"] = copy.deepcopy(transition["when"])
        transitions_out.append(transition_out)
    return {"run": run, "states": states_out, "transitions": transitions_out}


def canonicalize_factory_spec(spec: Any) -> dict[str, Any]:
    """Validate a spec in either form and return the canonical MACHINE form.

    Raises ``ValueError`` with the joined error list when the spec is
    invalid (including the both-forms rejection). Dag specs compile to
    machine form first, so the executor sees one shape:
    ``{"run": ..., "states": [...], "transitions": [...]}``.
    """
    errors = validate_factory_spec(spec)
    if errors:
        raise ValueError("; ".join(errors))
    assert isinstance(spec, dict)  # validated above
    if _is_machine_form(spec):
        machine = spec
    else:
        machine, compile_errors = compile_factory_dag(spec)
        assert machine is not None and not compile_errors  # validated above
    return _canonicalize_machine(machine)


def topological_order(nodes: list[dict[str, Any]]) -> list[str]:
    """Return node ids in a dependency-respecting order.

    Edges are the effective dependencies: ``depends_on`` plus every
    ``inputs[].from`` source node. Raises ``ValueError`` on a duplicate id,
    an unknown dependency, or a cycle. The order is stable: among ready
    nodes, input order wins. Retained as a public helper for inspecting
    dag-form specs; the machine form has no acyclicity requirement.
    """
    if not isinstance(nodes, list):
        raise ValueError("nodes must be a list")
    index_of: dict[str, int] = {}
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise ValueError(f"nodes[{index}] must be an object")
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id:
            raise ValueError(f"nodes[{index}] requires a non-empty id")
        if node_id in index_of:
            raise ValueError(f"duplicate node id {node_id!r}")
        index_of[node_id] = index

    deps: dict[str, set[str]] = {}
    for node in nodes:
        node_id = node["id"]
        edges: set[str] = set()
        depends_on = node.get("depends_on")
        if depends_on is not None:
            if not isinstance(depends_on, list):
                raise ValueError(f"node {node_id!r} depends_on must be a list of node ids")
            for dep in depends_on:
                if not isinstance(dep, str) or not dep:
                    raise ValueError(f"node {node_id!r} depends_on entries must be non-empty node id strings")
                edges.add(dep)
        inputs = node.get("inputs")
        if inputs is not None:
            if not isinstance(inputs, list):
                raise ValueError(f"node {node_id!r} inputs must be a list")
            for inp in inputs:
                if not isinstance(inp, dict):
                    raise ValueError(f"node {node_id!r} inputs entries must be objects")
                source = inp.get("from")
                if not isinstance(source, str) or "." not in source:
                    raise ValueError(
                        f"node {node_id!r} inputs require a 'from' reference of the form '<node_id>.<output_name>'"
                    )
                edges.add(source.partition(".")[0])
        deps[node_id] = edges

    for node_id, edges in deps.items():
        for dep in edges:
            if dep not in index_of:
                raise ValueError(f"node {node_id!r} depends on unknown node {dep!r}")

    remaining = {node_id: len(edges) for node_id, edges in deps.items()}
    dependents: dict[str, list[str]] = {node_id: [] for node_id in index_of}
    for node_id, edges in deps.items():
        for dep in edges:
            dependents[dep].append(node_id)
    ready = [(index_of[node_id], node_id) for node_id, count in remaining.items() if count == 0]
    heapq.heapify(ready)
    order: list[str] = []
    while ready:
        _, current = heapq.heappop(ready)
        order.append(current)
        for dependent in dependents[current]:
            remaining[dependent] -= 1
            if remaining[dependent] == 0:
                heapq.heappush(ready, (index_of[dependent], dependent))
    if len(order) != len(index_of):
        stuck = sorted(node_id for node_id, count in remaining.items() if count > 0)
        raise ValueError(f"the factory graph contains a cycle involving nodes: {', '.join(stuck)}")
    return order


__all__ = [
    "FACTORY_DISABLED_MESSAGE",
    "FACTORY_HELP",
    "FactoryExecutor",
    "FactoryRun",
    "MachineFile",
    "MachineResolutionError",
    "canonicalize_factory_spec",
    "cli_dispatch",
    "compile_factory_dag",
    "default_factory_executor",
    "export_factory_spec",
    "export_library_machine",
    "export_machine",
    "factory_enabled",
    "import_machine",
    "list_machines",
    "machine_library_dirs",
    "parse_machine_file",
    "render_machine_file",
    "repo_machines_dir",
    "require_factory_enabled",
    "resolve_machine",
    "resume_factory",
    "run_factory",
    "status_factory",
    "stop_factory",
    "topological_order",
    "user_machines_dir",
    "validate_factory_machine",
    "validate_factory_spec",
]


# Executor: run a canonicalized machine through the RLM supervisor.
# ---------------------------------------------------------------------------

ANSWER_CAPTURE_CAP = 200
"""Local safety cap for captured answers.

``rlm.collect`` already returns previews: the host caps them at 160
characters (``compactRlmText``). Input binding and every rendered prompt
therefore work on capped preview text; full child outputs stay in the
child's own session and are never seen by the executor.
"""

EVENT_WINDOW = 200
"""Number of trailing ledger events returned by ``status()``.

200 (not 50): a state-machine run's ledger grows fast — the pr-manager
happy path alone is ~43 events, and retries or rate-limit backoff would
otherwise push early evidence (a round-1 fix answer) out of the window a
parent or replay checker reads.
"""

POLL_TIMEOUT_MS = 2000
"""How long each control-loop ``rlm.collect`` waits for unsettled children."""

BACKOFF_MAX_ATTEMPTS = 5
"""Spawn admissions per node before a persistent rate limit fails the node."""

BACKOFF_BASE_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 60.0
_RATE_LIMIT_MARKERS = (
    "rate limit",
    "rate-limit",
    "ratelimit",
    "429",
    "too many requests",
    "throttled",
    "quota",
    "usage limit",
)

_FENCED_JSON_RE = re.compile(r"```json\s*(.*?)\s*```", re.DOTALL)
TERMINAL_ENTRY_STATUSES = ("done", "error", "cancelled")


def _is_rate_limit_error(message: str) -> bool:
    """Heuristic: the host reports admission failures as error strings."""
    lowered = message.lower()
    return any(marker in lowered for marker in _RATE_LIMIT_MARKERS)


def _child_name(run_id: str, state_id: str, instance_index: int, attempt: int) -> str:
    """Unique, readable sibling name for one spawned instance (host caps names at 64).

    A long state id is truncated but always disambiguated with a digest of
    the full id: two states sharing a 20-character prefix would otherwise
    produce the same sibling name, and the second admission would fail the
    supervisor's unique-name requirement. The digest is 64-bit (16 hex
    characters), so even a pathological 1024-state run sharing one prefix
    has a negligible collision chance; the longest name stays under the
    host's 64-character cap.
    """
    if len(state_id) <= 20:
        token = state_id
    else:
        digest = hashlib.sha256(state_id.encode("utf-8")).hexdigest()[:16]
        token = f"{state_id[:20]}-{digest}"
    parts = ["sw", token, run_id[:6]]
    if instance_index >= 0:
        parts.append(f"i{instance_index}")
    if attempt > 1:
        parts.append(f"a{attempt}")
    return "-".join(parts)


def _spawn_label(
    configured: str | None, run_id: str, state_id: str, instance_index: int, attempt: int
) -> str:
    """Sibling label for one spawned instance: the state's configured inline
    subagent ``name`` when it has one, else the generated label.

    The configured name is used verbatim for the state's first instance on
    its first attempt (agents message the child by exactly this label); the
    SAME disambiguation suffixes as the generated label -- ``i<n>`` for
    later instances (re-entry, foreach fan-out), ``a<n>`` for retries --
    keep every admission unique: the supervisor rejects duplicate sibling
    names, and one state's settled children stay registered for the
    run's life, so a re-entering state (``max_entries`` > 1) would collide
    with its own earlier child on a verbatim name.

    A suffixed label never exceeds the host's 64-character spawn-name cap:
    an overflowing base shrinks to a digest-suffixed token of the full
    name, exactly like the generated label's state-id token.
    """
    if configured is None:
        return _child_name(run_id, state_id, instance_index, attempt)
    suffix_parts = [f"i{instance_index}"] if instance_index > 0 else []
    if attempt > 1:
        suffix_parts.append(f"a{attempt}")
    suffix = "".join(f"-{part}" for part in suffix_parts)
    base = configured
    if len(base) + len(suffix) > SUBAGENT_NAME_MAX_LENGTH:
        # The host caps spawn names at 64 characters, so a suffixed label
        # that would exceed it shrinks its base first -- and a bare
        # truncation could collide (two long configured names sharing the
        # truncated prefix), so the base keeps a digest of the full name
        # exactly like the generated label's state-id token: distinct
        # names stay distinct, and every admission fits the cap.
        digest = hashlib.sha256(base.encode("utf-8")).hexdigest()[:16]
        room = max(SUBAGENT_NAME_MAX_LENGTH - len(suffix) - len(digest) - 1, 0)
        base = f"{base[:room]}-{digest}"
    return base + suffix


def _suffixed_spawn_form(base: str, candidate: str) -> bool:
    """True when ``candidate`` is a spawn label ``base`` can produce.

    A state configured as ``base`` names its later children ``base-i<n>``
    (re-entry, foreach fan-out) and ``base-a<n>`` (retries, ``n`` >= 2);
    the never-generated ``-i0`` and ``-a1`` do not count, so a candidate
    carrying them cannot collide and stays valid.
    """
    if not candidate.startswith(base + "-"):
        return False
    remainder = candidate[len(base) + 1 :]
    for part in remainder.split("-"):
        if len(part) < 2 or part[0] not in "ia" or not part[1:].isdigit():
            return False
        if part[0] == "i" and int(part[1:]) < 1:
            return False
        if part[0] == "a" and int(part[1:]) < 2:
            return False
    return True


def _parse_json_output(answer: str, output_name: str) -> tuple[Any, str | None]:
    """Extract one named JSON output from an upstream answer.

    Prefers the fenced `````json`` block whose object contains the output
    name, scanning trailing blocks first (an answer with several fences,
    e.g. a verdict block followed by a summary block, binds from whichever
    block carries the port), then falls back to parsing the whole answer.
    Returns ``(value, None)`` or ``(None, error_sentence)``.
    """
    candidates: list[str] = list(reversed(_FENCED_JSON_RE.findall(answer)))
    candidates.append(answer.strip())
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict) and output_name in parsed:
            return parsed[output_name], None
    return None, f"no JSON object containing output {output_name!r} in the upstream answer"


def _render_prompt(template: str, values: dict[str, str]) -> str:
    """Render bound input values into a prompt template.

    Each ``{input_name}`` placeholder is replaced in a single pass (a value
    that itself looks like a placeholder is never re-substituted). Inputs
    without a placeholder are appended in a trailing ``## Inputs`` section,
    so no bound value is dropped.
    """
    if not values:
        return template
    pattern = re.compile("|".join(re.escape("{" + name + "}") for name in values))
    used: set[str] = set()

    def _substitute(match: "re.Match[str]") -> str:
        name = match.group(0)[1:-1]
        used.add(name)
        return values[name]

    rendered = pattern.sub(_substitute, template)
    unplaced = [(name, value) for name, value in values.items() if name not in used]
    if unplaced:
        rendered += "\n\n## Inputs\n" + "".join(f"- {name}: {value}\n" for name, value in unplaced)
    return rendered


def _json_equal(actual: Any, expected: Any) -> bool:
    """JSON-strict equality for eq/ne guards: a boolean never equals a
    number (true != 1, false != 0), numbers compare numerically (1 == 1.0),
    and everything else compares within its own type."""
    if isinstance(actual, bool) or isinstance(expected, bool):
        return isinstance(actual, bool) and isinstance(expected, bool) and actual is expected
    if actual is None or expected is None:
        return actual is None and expected is None
    if _is_number(actual) and _is_number(expected):
        # Exact: Python compares int/int, int/float, and float/float
        # mathematically (no lossy float conversion), so distinct large
        # JSON integers never compare equal (9007199254740993 != 9007199254740992).
        return actual == expected
    if isinstance(actual, str) and isinstance(expected, str):
        return actual == expected
    return False


def _guard_passes(when: dict[str, Any], outputs: dict[str, Any]) -> bool:
    """Evaluate one transition guard over a settle's captured outputs.

    A missing or unparseable port fails every op except ``exists`` (which is
    explicitly false then); ``ne`` needs a found value to compare against.
    ``eq``/``ne`` compare JSON-strictly (bools never equal numbers); an
    empty ``contains`` needle is defensively false.
    """
    port = when.get("output")
    value: Any = None
    found = False
    path = when.get("path")
    if path:
        current = outputs.get(port)
        if isinstance(current, dict):
            found = True
            for part in path.split("."):
                if isinstance(current, dict) and part in current:
                    current = current[part]
                else:
                    found = False
                    break
            value = current
    elif port in outputs:
        found = True
        value = outputs[port]
    op = when.get("op")
    if op == "exists":
        return found
    if not found:
        return False
    if op == "eq":
        return _json_equal(value, when.get("value"))
    if op == "ne":
        return not _json_equal(value, when.get("value"))
    if op in ("gt", "gte", "lt", "lte"):
        bound = when.get("value")
        if not _is_number(value) or not _is_number(bound):
            return False
        if op == "gt":
            return value > bound
        if op == "gte":
            return value >= bound
        if op == "lt":
            return value < bound
        return value <= bound
    if op == "contains":
        needle = when.get("value")
        if not isinstance(needle, list) or not needle:
            return False
        if isinstance(value, list):
            return all(item in value for item in needle)
        if isinstance(value, str):
            return all(isinstance(item, str) and item in value for item in needle)
        return False
    return False


def _validate_spawn_settings(model: Any, thinking: Any) -> str | None:
    for key, value in (("model", model), ("thinking", thinking)):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            return f"subagent {key} must be a non-empty string when provided"
    return None


@dataclass
class _NodeInstance:
    """One spawned child of one state entry (a foreach entry has one per item)."""

    index: int  # per-state running counter; unique within the state
    prompt: str  # fully rendered; re-spawns reuse it verbatim
    status: str = "pending"  # pending | running | done | error | cancelled
    attempt: int = 0  # spawn admissions tried for this instance; a rate-limit
    # deferral counts here too, and ``retries`` compares against this same
    # counter, so one transient 429 admission consumes one declared retry.
    rate_limit_streak: int = 0  # consecutive rate-limited admissions in the
    # control loop's backoff path; a successful spawn resets it, and
    # BACKOFF_MAX_ATTEMPTS in a row fails the node. An admission-phase
    # deferral (run()/resume(), allow_backoff=False) consumes an attempt
    # but never counts toward the backoff episode.
    child_id: str | None = None
    spawned_at: float | None = None
    duration_ms: int | None = None
    answer: str | None = None  # capped collect preview (ANSWER_CAPTURE_CAP)
    error: str | None = None
    tool_uses: int = 0


@dataclass
class _StateEntry:
    """One entry (activation) of a state; re-entry creates a fresh entry.

    An entry settles when all of its instances settle done; the settle
    captures the state's declared outputs, and
    the control loop then evaluates the outgoing transitions once
    (``consumed`` marks that evaluation done).
    """

    index: int  # per-state entry index, 0-based
    status: str = "pending"  # pending | running | done | error | cancelled
    instances: list[_NodeInstance] = field(default_factory=list)
    error: str | None = None
    answer: str | None = None  # joined captured answers of this entry
    outputs: dict[str, Any] | None = None  # captured settle outputs (port name -> value)
    output_errors: dict[str, str] | None = None  # ports whose json capture failed
    is_settle: bool = False  # True once the entry settled (done or error)
    consumed: bool = False  # True once the settle's transitions were evaluated


@dataclass
class _StateRun:
    """Executor-side state for one machine state of one run."""

    state_id: str
    spec: dict[str, Any]  # canonical state spec
    position: int  # stable list position for deterministic ordering
    prompt_template: str | None = None
    name: str | None = None  # configured inline subagent name; labels children
    model: str | None = None
    thinking: str | None = None
    max_entries: int = STATE_MAX_ENTRIES_DEFAULT
    entries_used: int = 0
    entries: list[_StateEntry] = field(default_factory=list)
    instance_counter: int = 0
    error: str | None = None
    cancelled: bool = False  # set by stop()/fail_fast for never-entered states

    @property
    def lifecycle(self) -> str:
        return self.spec.get("lifecycle", NODE_LIFECYCLE_DEFAULT)

    @property
    def status(self) -> str:
        if self.entries:
            return self.entries[-1].status
        return "cancelled" if self.cancelled else "pending"

    def latest_settle(self) -> _StateEntry | None:
        for entry in reversed(self.entries):
            if entry.is_settle:
                return entry
        return None


@dataclass
class FactoryRun:
    """Executor-side state for one run. Kernel memory only: it does not
    survive a kernel restart; the children (supervisor-owned) keep running."""

    run_id: str
    spec_id: str
    name: str | None
    # The canonicalized machine this run executes: a stored entry's spec or a
    # library machine's template, kept so export_machine can serialize the
    # exact machine a run is running (byte-pretty, stable formatting).
    machine: "dict[str, Any]" = field(default_factory=dict)
    state: str = "running"  # running | stopping | paused | done | failed | stopped
    started_at: float = 0.0
    max_parallel: int = RUN_MAX_PARALLEL_DEFAULT
    max_transitions: int = MAX_TRANSITIONS_CAP
    max_children: int = RUN_MAX_CHILDREN_DEFAULT
    max_transitions_reported: bool = False
    max_children_reported: bool = False
    run_budget_ms: int | None = None
    budget_reported: bool = False
    pause_reason: str | None = None
    states: dict[str, _StateRun] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    transitions_from: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    pending_evaluations: list[tuple[str, int, int]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    milestones: set[str] = field(default_factory=set)
    spawn_count: int = 0
    settle_count: int = 0
    transitions_fired: int = 0
    tool_use_total: int = 0
    task: "Any | None" = None
    # The control loop's generation: resume() bumps it so a pause-path task
    # that is still winding down (an in-flight milestone await) can never
    # continue as a second concurrent control loop. The task captures its
    # generation at start and re-checks it after every await.
    loop_generation: int = 0
    # Rate-limit backoff deadline (seconds on the injected clock): admission
    # defers instead of sleeping inside the loop, so the loop can keep
    # collecting children while admission waits out the deadline.
    admission_backoff_until: float | None = None
    # Join-transition bookkeeping: the last-fired (source id, settle index)
    # signature per join (keyed by the transition object), so a join whose
    # sources settle in one collect batch fires once, not once per source
    # settle, and re-fires only when a source settles again.
    join_fired: dict[tuple[int, str], frozenset[tuple[str, int]]] = field(default_factory=dict)


class FactoryExecutor:
    """Runs canonicalized state-machine factories through the existing RLM supervisor.

    Ownership split: the supervisor owns the children (admission via
    ``rlm.spawn``, settlement via ``rlm.collect``, cancellation via
    ``rlm.delete_subagent``); this executor owns the run state in kernel
    memory. Every host call resolves through the module-level ``rlm``
    functions and ``host_request`` at call time, so tests can patch
    ``rlm.host_request``. ``now`` (default ``time.monotonic``) and ``sleep``
    (default ``asyncio.sleep``) are injectable: budgets measure admission
    to settlement and rate-limit backoff is testable with fake sleeps.

    Machine semantics: admission enters every entry state; each settle is
    queued and its outgoing transitions evaluated once -- every guard that
    passes fires (fan-out is legal), a fire enters the target unless it is
    out of ``max_entries`` (recorded as ``transition_blocked``), and a
    self-loop or back-edge re-enters its target with freshly re-bound
    inputs. A run completes at quiescence: no state entry in flight
    (pending/running/waiting) and no unevaluated settle.

    Runs do not survive a kernel restart (the registry lives in kernel
    memory); children are supervisor-owned and keep running, so
    ``rlm.list_subagents`` can still see and stop them after a restart.
    """

    def __init__(
        self,
        *,
        now: "Callable[[], float] | None" = None,
        sleep: "Callable[[float], Any] | None" = None,
        harness: Any = None,
    ) -> None:
        import asyncio

        self._now_fn: Callable[[], float] = now or time.monotonic
        self._sleep_fn: Callable[[float], Any] = sleep or asyncio.sleep
        self._harness = harness
        self._runs: dict[str, FactoryRun] = {}

    # -- public API ---------------------------------------------------------

    async def run(self, spec_id: str, *, name: str | None = None) -> dict[str, Any]:
        """Validate a stored factory spec and start a run of it.

        The dry run happens in two halves. Write time (``create_factory``)
        validated the machine; here ``run`` re-validates and canonicalizes
        it (dag sugar compiles to machine form), then resolves every state's
        subagent reference, reporting ALL failures in one ``ValueError`` and
        starting nothing on any failure. The resolved state count and
        ``max_parallel`` are reported in the result; actual admission limits
        (concurrency, tree depth, provider rate limits) are enforced at
        spawn time through the backoff path. Admission enters every entry
        state up to ``max_parallel``, records handles, and returns; a
        background asyncio task continues the run, so the calling model turn
        ends immediately (nonblocking).
        """
        harness = self._resolve_harness()
        entry = harness.get("factory", spec_id)
        if entry is None:
            raise ValueError(f"unknown factory spec {spec_id!r}")
        arguments = entry.arguments if isinstance(entry.arguments, dict) else {}
        spec = arguments.get("machine")
        if spec is None:
            spec = arguments.get("dag")
        canonical = canonicalize_factory_spec(spec)
        resolved, reference_errors = self._resolve_subagents(harness, canonical)
        if reference_errors:
            raise ValueError("; ".join(reference_errors))
        run = self._create_run(entry.id, canonical, resolved, name=name)
        return await self._launch_run(run)

    async def run_machine(
        self, machine: MachineFile, *, machine_path: Path | None = None, name: str | None = None
    ) -> dict[str, Any]:
        """Validate a library machine and start a run of it.

        Harness entries remain runtime instances; machines in the library
        are templates, so a library run never creates one. The machine's
        spec goes through the same validation and canonicalization as a
        stored entry's (``canonicalize_factory_spec``), the run records the
        machine's name as its spec id, and the result reports the machine
        fields so a caller can trace the run back to the library file.
        """
        canonical = canonicalize_factory_spec(machine.spec)
        harness = self._resolve_harness()
        resolved, reference_errors = self._resolve_subagents(harness, canonical)
        if reference_errors:
            raise ValueError("; ".join(reference_errors))
        run = self._create_run(machine.name, canonical, resolved, name=name)
        result = await self._launch_run(run)
        result["machine"] = machine.name
        if machine_path is not None:
            result["machine_path"] = str(machine_path)
        return result

    async def _launch_run(self, run: FactoryRun) -> dict[str, Any]:
        """Register a run, enter its entry states, and start the control loop.

        Shared by ``run`` (stored entries) and ``run_machine`` (library
        machines): both validate first, so this never sees an invalid
        spec. Nonblocking: admission enters every entry state up to
        ``max_parallel`` and returns; a background task continues the run.
        """
        self._runs[run.run_id] = run
        self._event(
            run, "run_started", detail=f"{len(run.states)} states, max_parallel {run.max_parallel}"
        )
        for state_id in run.order:
            state = run.states[state_id]
            if state.spec.get("entry"):
                self._enter_state(run, state, from_state=None)
        started = await self._spawn_ready(run, generation=run.loop_generation, allow_backoff=False)
        if self._run_complete(run):
            await self._finalize(run)
        elif run.state == "running":
            # A budget pause during the initial admission leaves the run
            # paused with no loop: resuming is the operator's decision.
            self._start_loop(run)
        return {
            "run_id": run.run_id,
            "spec_id": run.spec_id,
            "name": run.name,
            "nodes": len(run.states),
            "max_parallel": run.max_parallel,
            "started": started,
            "pending": self._pending_state_ids(run),
        }

    async def status(self, run_id: str) -> dict[str, Any]:
        """State states, the trailing event window, elapsed time, and usage.

        Each call marks the events the parent has not seen yet
        (``recorded``/``arrived``) ``delivered``; ``shown`` events keep their
        stage because their notice already reached the parent conversation,
        so the stage taxonomy stays observable. The returned window is the
        last ``EVENT_WINDOW`` events.
        Raises ``ValueError`` for an unknown run id.
        """
        run = self._require_run(run_id)
        nodes: list[dict[str, Any]] = []
        for state_id in run.order:
            state = run.states[state_id]
            entry_report: dict[str, Any] = {
                "id": state.state_id,
                "status": state.status,
                "lifecycle": state.lifecycle,
                "attempts": sum(
                    instance.attempt for entry in state.entries for instance in entry.instances
                ),
                "entries_used": state.entries_used,
                "max_entries": state.max_entries,
                "entries": [
                    {"index": entry.index, "status": entry.status, "error": entry.error}
                    for entry in state.entries
                ],
                "instances": [
                    {
                        "index": instance.index,
                        "entry": entry.index,
                        "status": instance.status,
                        "attempt": instance.attempt,
                        "child": instance.child_id,
                        "duration_ms": instance.duration_ms,
                        "error": instance.error,
                    }
                    for entry in state.entries
                    for instance in entry.instances
                ],
            }
            latest = state.latest_settle()
            if latest is not None and latest.answer:
                entry_report["answer_preview"] = latest.answer
            if state.error is not None:
                entry_report["error"] = state.error
            nodes.append(entry_report)
        for event in run.events:
            if event["stage"] in ("recorded", "arrived"):
                event["stage"] = "delivered"
        return {
            "run_id": run.run_id,
            "spec_id": run.spec_id,
            "name": run.name,
            "state": run.state,
            "nodes": nodes,
            "events": [dict(event) for event in run.events[-EVENT_WINDOW:]],
            "elapsed_ms": int((self._now_fn() - run.started_at) * 1000),
            "usage": {
                "spawns": run.spawn_count,
                "settled": run.settle_count,
                "tool_uses": run.tool_use_total,
                "max_parallel": run.max_parallel,
                "max_children": run.max_children,
                "running": self._running_instance_count(run),
                "transitions_fired": run.transitions_fired,
            },
        }

    async def stop(self, run_id: str) -> dict[str, Any]:
        """Cancel every running child of the run and mark it stopped.

        Sets the transitional ``stopping`` state before the first await so
        the control loop cannot admit new children or finalize the run while
        the cancellations are in flight. Idempotent: a second stop returns
        the same result without another ledger event.
        """
        run = self._require_run(run_id)
        # The transitional "stopping" state is guarded as well: two
        # concurrent stop() calls would otherwise both pass a bare
        # "stopped" check, both enter the cancellation pass, and issue
        # duplicate delete_subagent requests plus a second run_stopped
        # ledger event.
        if run.state in ("stopping", "stopped"):
            return {"run_id": run.run_id, "state": run.state, "cancelled": []}
        run.state = "stopping"
        stopped = await self._halt_nonterminal(run, "run stopped")
        run.state = "stopped"
        self._event(run, "run_stopped", detail=f"stopped; {len(stopped)} state(s) cancelled")
        return {"run_id": run.run_id, "state": "stopped", "cancelled": stopped}

    async def resume(self, run_id: str) -> dict[str, Any]:
        """Resume a paused run (escalate, budget, or max_transitions pause).

        A budget or max_transitions pause is reported once per run:
        resuming after it is an explicit operator decision and no further
        budget pauses fire. Raises ``ValueError`` when the run is not paused.
        """
        run = self._require_run(run_id)
        if run.state != "paused":
            raise ValueError(f"factory run {run_id!r} is {run.state!r}, not paused")
        # Bump the loop generation FIRST: the pause-path control-loop task
        # may still be winding down (an in-flight milestone await). Its
        # state re-checks would otherwise see "running" again and continue
        # as a SECOND loop, admitting and settling the same instances
        # alongside the loop started below.
        run.loop_generation += 1
        run.state = "running"
        run.pause_reason = None
        self._event(run, "resumed", detail="resumed by caller")
        # Evaluate settles first: paused runs may still carry transitions to
        # fire (escalate) before anything can be admitted.
        await self._evaluate_settles(run)
        # allow_backoff=False: like run(), resume() must never sleep inside
        # the calling model turn; rate-limited admissions defer to the loop.
        started = await self._spawn_ready(run, generation=run.loop_generation, allow_backoff=False)
        if self._run_complete(run):
            await self._finalize(run)
        elif run.state == "running":
            self._start_loop(run)
        return {
            "run_id": run.run_id,
            "state": run.state,
            "started": started,
            "pending": self._pending_state_ids(run),
        }

    # -- setup --------------------------------------------------------------

    def _resolve_harness(self) -> Any:
        if self._harness is not None:
            return self._harness
        from . import rlm as rlm_namespace

        return rlm_namespace.harness

    def _require_run(self, run_id: str) -> FactoryRun:
        run = self._runs.get(run_id)
        if run is None:
            raise ValueError(f"unknown factory run {run_id!r}")
        return run

    def _resolve_subagents(
        self, harness: Any, canonical: dict[str, Any]
    ) -> tuple[dict[str, tuple[str, str | None, str | None, str | None]], list[str]]:
        """Resolve every state's subagent reference; collect ALL failures.

        A string reference is a harness subagent entry id or title: its
        content is the prompt template and ``metadata.model``/``metadata.thinking``
        carry optional spawn settings. An inline object uses its own fields;
        its ``name`` (stripped the way the host strips spawn names) labels
        the spawned children.
        """
        resolved: dict[str, tuple[str, str | None, str | None, str | None]] = {}
        errors: list[str] = []
        for state_spec in canonical["states"]:
            state_id = state_spec["id"]
            reference = state_spec["subagent"]
            if isinstance(reference, dict):
                prompt = reference.get("prompt")
                raw_name = reference.get("name")
                name = raw_name.strip() if isinstance(raw_name, str) else None
                model = reference.get("model")
                thinking = reference.get("thinking")
            else:
                entry = harness.get("subagent", reference)
                if entry is None:
                    entry = next((row for row in harness.list("subagent") if row.title == reference), None)
                if entry is None:
                    errors.append(f"state {state_id!r} references unknown subagent {reference!r}")
                    continue
                prompt = entry.content
                name = None
                metadata = entry.metadata if isinstance(entry.metadata, dict) else {}
                model = metadata.get("model")
                thinking = metadata.get("thinking")
            if not isinstance(prompt, str) or not prompt.strip():
                errors.append(f"state {state_id!r} has an empty subagent prompt")
                continue
            settings_error = _validate_spawn_settings(model, thinking)
            if settings_error is not None:
                errors.append(f"state {state_id!r} {settings_error}")
                continue
            resolved[state_id] = (prompt, name or None, model, thinking)
        return resolved, errors

    def _create_run(
        self,
        spec_id: str,
        canonical: dict[str, Any],
        resolved: dict[str, tuple[str, str | None, str | None, str | None]],
        *,
        name: str | None,
    ) -> FactoryRun:
        run_spec = canonical["run"]
        run = FactoryRun(
            run_id=uuid4().hex,
            spec_id=spec_id,
            name=name,
            machine=canonical,
            started_at=self._now_fn(),
            max_parallel=run_spec["max_parallel"],
            max_transitions=run_spec["max_transitions"],
            max_children=run_spec["max_children"],
            run_budget_ms=run_spec.get("budget_ms"),
        )
        position_of: dict[str, int] = {}
        for position, state_spec in enumerate(canonical["states"]):
            position_of[state_spec["id"]] = position
            state_id = state_spec["id"]
            prompt, name, model, thinking = resolved.get(state_id, (None, None, None, None))
            run.states[state_id] = _StateRun(
                state_id=state_id,
                spec=state_spec,
                position=position,
                prompt_template=prompt,
                name=name,
                model=model,
                thinking=thinking,
                max_entries=state_spec.get("max_entries", STATE_MAX_ENTRIES_DEFAULT),
            )
            run.order.append(state_id)
        for transition in canonical.get("transitions") or []:
            raw_from = transition["from"]
            # A join (from is a list) is visible from EVERY source state's
            # settle evaluation; a single-source transition registers once.
            sources = raw_from if isinstance(raw_from, list) else [raw_from]
            for source in sources:
                run.transitions_from.setdefault(source, []).append(transition)
        return run

    # -- event ledger -------------------------------------------------------

    def _event(
        self,
        run: FactoryRun,
        kind: str,
        *,
        node: str | None = None,
        entry: int | None = None,
        instance: int | None = None,
        detail: str | None = None,
        stage: str = "recorded",
        **extra: Any,
    ) -> dict[str, Any]:
        """Append one ledger entry.

        Stages follow the spec: ``arrived`` (a child answer settled and was
        captured), ``recorded`` (everything else), ``shown`` (a milestone
        notice was injected into the parent conversation), and ``delivered``
        (the parent read the ledger via ``status()``).
        """
        event: dict[str, Any] = {"seq": len(run.events) + 1, "kind": kind, "stage": stage}
        if node is not None:
            event["node"] = node
        if entry is not None:
            event["entry"] = entry
        if instance is not None:
            event["instance"] = instance
        if detail is not None:
            event["detail"] = detail
        event.update(extra)
        run.events.append(event)
        return event

    async def _milestone(self, run: FactoryRun, kind: str, detail: str, *, node: str | None = None) -> None:
        """Record a run milestone and inject one quiet notice (one per kind).

        Every milestone lands in the ledger, repeats included: a run that
        pauses twice must still show the second pause to the parent reading
        ``status()``. Only the parent-visible notice is deduped per kind.
        """
        event = self._event(run, "milestone", milestone=kind, detail=detail, node=node)
        if kind in run.milestones:
            return  # the kind was announced once; the ledger keeps this repeat
        run.milestones.add(kind)
        try:
            from . import host_request

            payload: dict[str, Any] = {"run_id": run.run_id, "kind": kind, "detail": detail}
            if node is not None:
                payload["node"] = node
            await host_request("factory.progress", payload)
            event["stage"] = "shown"
        except Exception:
            # A dead bridge cannot be told; the ledger keeps the milestone and
            # status() still surfaces it to the parent.
            pass

    # -- entries, transitions -------------------------------------------------

    def _enter_state(self, run: FactoryRun, state: _StateRun, *, from_state: str | None) -> _StateEntry:
        """Create one new entry of a state (bounded by max_entries upstream)."""
        entry = _StateEntry(index=len(state.entries))
        state.entries.append(entry)
        state.entries_used += 1
        detail = "entry state" if from_state is None else f"entered from {from_state}"
        self._event(run, "state_entry", node=state.state_id, entry=entry.index, detail=detail)
        return entry

    def _queue_settle(self, run: FactoryRun, state: _StateRun, entry: _StateEntry) -> None:
        entry.is_settle = True
        # The third element is the transition index to resume from: 0 for a
        # fresh settle, or the paused index after a max_transitions pause.
        run.pending_evaluations.append((state.state_id, entry.index, 0))

    async def _evaluate_settles(self, run: FactoryRun) -> None:
        """Evaluate every queued settle's outgoing transitions once.

        ALL transitions whose guards pass fire (fan-out is legal); a join
        transition (from is a list) fires once per source-settle completion;
        a fire enters the target unless it is out of max_entries (recorded
        as transition_blocked). Exceeding max_transitions pauses the run once
        (max_transitions_exceeded milestone, resume-able) with the settle
        left unconsumed AND the transition index where the pause landed, so
        a resume continues after the transitions that already fired instead
        of re-firing them.
        """
        while run.pending_evaluations and run.state == "running":
            state_id, entry_index, resume_from = run.pending_evaluations.pop(0)
            state = run.states[state_id]
            entry = state.entries[entry_index]
            if entry.consumed or not entry.is_settle:
                continue
            entry.consumed = True
            outputs = entry.outputs or {}
            for transition_index, transition in enumerate(run.transitions_from.get(state_id, [])):
                if transition_index < resume_from:
                    continue  # already fired before the pause; do not re-fire
                raw_from = transition["from"]
                join_signature: "frozenset[tuple[str, int]] | None" = None
                if isinstance(raw_from, list):
                    # A join fires from this settle only when every source
                    # state has a settle, and only once per source-settle
                    # combination: both sources settling in one collect
                    # batch must produce ONE entry of the target, not two.
                    sources = raw_from
                    signature_parts = []
                    for source_id in sources:
                        source_state = run.states.get(source_id)
                        latest = source_state.latest_settle() if source_state is not None else None
                        if latest is None:
                            signature_parts = None
                            break
                        signature_parts.append((source_id, latest.index))
                    if signature_parts is None:
                        continue  # a join source never settled yet; not firable
                    signature = frozenset(signature_parts)
                    # Keyed by the transition object's identity: duplicate
                    # transitions (same sources, same target) are legal
                    # machine syntax and stay independent.
                    key = (id(transition), transition["to"])
                    if run.join_fired.get(key) == signature:
                        continue  # this completion already fired (or was blocked)
                    # The signature is CLAIMED only below, when the
                    # transition actually fires or is blocked: a
                    # max_transitions pause that re-queues this transition
                    # must not leave a stale mark, or the resume would skip
                    # the join forever.
                    join_signature = (key, signature)
                else:
                    sources = [raw_from]
                    when = transition.get("when")
                    if when is not None and not _guard_passes(when, outputs):
                        continue
                target = run.states[transition["to"]]
                from_field = transition["from"]
                if target.entries_used >= target.max_entries:
                    if join_signature is not None:
                        # Blocked: this source-settle combination is consumed
                        # even though the target had no entries left.
                        run.join_fired[join_signature[0]] = join_signature[1]
                    self._event(
                        run,
                        "transition_blocked",
                        detail=(
                            f"state {target.state_id!r} is at max_entries "
                            f"{target.max_entries}; transition {from_field!r} -> {target.state_id!r} blocked"
                        ),
                        **{"from": from_field, "to": target.state_id},
                    )
                    continue
                if run.transitions_fired >= run.max_transitions and not run.max_transitions_reported:
                    run.max_transitions_reported = True
                    entry.consumed = False
                    run.pending_evaluations.insert(0, (state_id, entry_index, transition_index))
                    run.state = "paused"
                    run.pause_reason = "max_transitions exceeded"
                    await self._milestone(
                        run,
                        "max_transitions_exceeded",
                        f"max_transitions {run.max_transitions} exceeded; no new entries; "
                        f"resume with await rlm.factory.resume('{run.run_id}')",
                    )
                    return
                if join_signature is not None:
                    run.join_fired[join_signature[0]] = join_signature[1]
                run.transitions_fired += 1
                self._event(
                    run,
                    "transition_fired",
                    detail=f"{from_field!r} -> {target.state_id!r}",
                    **{"from": from_field, "to": target.state_id},
                )
                self._enter_state(run, target, from_state=state_id)

    # -- readiness, binding, admission --------------------------------------

    async def _spawn_ready(self, run: FactoryRun, *, generation: int, allow_backoff: bool) -> list[str]:
        """Prepare ready entries and admit pending instances up to max_parallel.

        The run budget is enforced BEFORE each admission (this phase runs
        from run() and resume() too, not only the control loop): a slow
        initial admission must not keep launching instances after
        run_budget_ms expired. The run-wide child budget (max_children:
        every admission over the run's life, foreach expansions and retry
        re-spawns included) is enforced the same way — the next admission
        over it pauses the run instead of launching the child.
        Admission is also skipped while a
        rate-limit backoff deadline is outstanding. Returns the state ids
        that had at least one instance admitted here.
        """
        started: list[str] = []
        while self._loop_alive(run, generation):
            await self._prepare_ready_entries(run)
            if not self._loop_alive(run, generation):
                break
            if self._run_budget_exceeded(run):
                await self._pause_for_budget(run)
                break
            if run.admission_backoff_until is not None and self._now_fn() < run.admission_backoff_until:
                break  # the loop waits out the deadline in bounded slices
            if self._running_instance_count(run) >= run.max_parallel:
                break
            pair = self._next_pending_instance(run)
            if pair is None:
                break
            if self._children_budget_exceeded(run):
                await self._pause_for_children(run)
                break
            state, entry, instance = pair
            outcome = await self._admit(run, state, entry, instance, allow_backoff=allow_backoff)
            if outcome == "admitted" and state.state_id not in started:
                started.append(state.state_id)
            if outcome == "stopped":
                break  # the run left "running" mid-admission; nothing to admit
            if outcome == "deferred":
                # A rate limit is usually global, so stop admitting in this
                # phase; the control loop waits out the deadline and retries.
                break
            # "failed": the failure policy owns the run state now; the
            # loop condition re-checks it before the next admission.
        return started

    def _loop_alive(self, run: FactoryRun, generation: int) -> bool:
        """One control-lane pass is current: the run is running AND its
        generation still owns the state (a resume bumped it)."""
        return run.state == "running" and run.loop_generation == generation

    def _run_budget_exceeded(self, run: FactoryRun) -> bool:
        if run.run_budget_ms is None or run.budget_reported:
            return False
        return (self._now_fn() - run.started_at) * 1000 > run.run_budget_ms

    async def _pause_for_budget(self, run: FactoryRun) -> None:
        """Pause the run at the budget boundary (milestone fires once).

        Children already in flight keep running; they settle normally once
        the run resumes. Resuming after the milestone is an explicit operator
        decision, so no further budget pauses fire (budget_reported)."""
        elapsed_ms = (self._now_fn() - run.started_at) * 1000
        run.state = "paused"
        run.pause_reason = "run budget exceeded"
        run.budget_reported = True
        await self._milestone(
            run,
            "budget_exceeded",
            f"run budget_ms {run.run_budget_ms} exceeded after {int(elapsed_ms)}ms; no new spawns; "
            f"resume with await rlm.factory.resume('{run.run_id}')",
        )

    def _children_budget_exceeded(self, run: FactoryRun) -> bool:
        if run.max_children_reported:
            return False
        return run.spawn_count >= run.max_children

    async def _pause_for_children(self, run: FactoryRun) -> None:
        """Pause the run at the child-budget boundary (milestone fires once).

        max_children is the TOTAL-admission budget over the run's life:
        spawn_count counts every admission, foreach expansions and retry
        re-spawns included (max_parallel bounds concurrency only, and
        max_transitions bounds transitions — neither bounds children).
        Children already in flight keep running. Resuming after the
        milestone is an explicit operator decision, so no further
        child-budget pauses fire (max_children_reported)."""
        run.state = "paused"
        run.pause_reason = "max_children exceeded"
        run.max_children_reported = True
        await self._milestone(
            run,
            "max_children_exceeded",
            f"run max_children {run.max_children} exceeded after {run.spawn_count} children; "
            f"no new spawns; resume with await rlm.factory.resume('{run.run_id}')",
        )

    async def _prepare_ready_entries(self, run: FactoryRun) -> None:
        """Bind inputs and create instances for every entry whose input
        sources have settles."""
        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                if entry.status != "pending":
                    continue
                instances, reason = self._prepare_entry(run, state, entry)
                if reason is not None:
                    await self._apply_entry_failure_policy(run, state, entry, reason)
                    if run.state != "running":
                        return
                    continue
                if instances is None:
                    continue  # an input source has not settled yet; stay pending
                entry.instances = instances
                if instances:
                    entry.status = "running"
                    self._event(
                        run, "node_ready", node=state_id, entry=entry.index,
                        detail=f"{len(instances)} instance(s) prepared",
                    )
                else:
                    entry.status = "done"
                    self._event(
                        run, "node_ready", node=state_id, entry=entry.index,
                        detail="foreach expanded to zero items; nothing to run",
                    )
                    self._queue_settle(run, state, entry)

    def _prepare_entry(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry
    ) -> "tuple[list[_NodeInstance] | None, str | None]":
        """Bind inputs, expand foreach, and render one prompt per instance.

        Returns ``(instances, None)`` on success, ``(None, None)`` while an
        input source has not settled yet (the entry stays pending), or
        ``(None, reason)`` on a binding failure. Binding failures never
        retry: a deterministic binding error would recur on every re-render,
        so the entry fails and its failure_policy applies directly.
        """
        values: dict[str, str] = {}
        foreach = state.spec.get("foreach")
        items: list[Any] | None = None
        for inp in state.spec.get("inputs") or []:
            name, port_type, source = inp["name"], inp["type"], inp["from"]
            src_id, _, src_output = source.partition(".")
            source_state = run.states.get(src_id)
            latest = source_state.latest_settle() if source_state is not None else None
            value: Any = None
            failure: str | None = None
            if latest is not None:
                # One settled source classifies into a captured value or a
                # binding failure. An errored settle, a port whose JSON
                # capture failed, and a declared port the settle captured
                # no value for are all no-value conditions of a source
                # that HAS settled -- the dependent sees none of them as a
                # value.
                if latest.status == "error":
                    failure = f"input {name!r} from state {src_id!r} is unavailable (latest settle status 'error')"
                else:
                    outputs = latest.outputs or {}
                    output_errors = latest.output_errors or {}
                    if src_output in output_errors:
                        failure = f"input {name!r}: {output_errors[src_output]}"
                    elif src_output not in outputs:
                        failure = f"input {name!r} from state {src_id!r} has no captured output {src_output!r}"
                    else:
                        value = outputs[src_output]
            if latest is None or failure is not None:
                if inp.get("optional"):
                    # Optional inputs bind a null sentinel whenever their
                    # source offers no value -- never settled, errored
                    # settle, or a settled source that captured nothing
                    # for the port -- so loop states can re-enter before
                    # their upstream partner has run and after it failed
                    # or produced nothing usable (a compiled dag never
                    # sets optional: its input edges are transitions, so
                    # the wait-for-the-source semantics stay V1-exact).
                    # Only a REQUIRED input over a settled-but-valueless
                    # source fails the dependent: the guard-less
                    # transition still fires from the error settle, and
                    # the authoring reference pins the required form as
                    # the failing one. The foreach.over input is the one
                    # optional that cannot bind a sentinel: expansion
                    # would hit "did not resolve its over input" -- a
                    # hard failure where the required form only waits --
                    # so a value-less optional over expands to zero items
                    # (the same done-with-no-instances path as a settled
                    # empty list) and a later re-entry binds the real
                    # list.
                    if foreach is not None and foreach.get("over") == name:
                        items = []
                        continue
                    values[name] = "null" if port_type == "json" else "None"
                    continue
                if latest is None:
                    return None, None  # wait for the source's first settle
                return None, failure
            if port_type == "text":
                values[name] = value if isinstance(value, str) else json.dumps(value)
                continue
            if foreach is not None and foreach.get("over") == name:
                if not isinstance(value, list):
                    return None, f"foreach.over input {name!r} is not a JSON list"
                items = value
                continue
            values[name] = json.dumps(value)
        if foreach is None:
            assert state.prompt_template is not None
            instance = _NodeInstance(index=state.instance_counter, prompt=_render_prompt(state.prompt_template, values))
            state.instance_counter += 1
            return [instance], None
        if items is None:
            return None, "foreach entry did not resolve its over input"
        instances = []
        for item in items[: foreach["max"]]:
            instance_value = item if isinstance(item, str) else json.dumps(item)
            instances.append(
                _NodeInstance(
                    index=state.instance_counter + len(instances),
                    prompt=_render_prompt(state.prompt_template, {**values, foreach["over"]: instance_value}),
                )
            )
        state.instance_counter += len(instances)
        return instances, None

    def _next_pending_instance(self, run: FactoryRun) -> "tuple[_StateRun, _StateEntry, _NodeInstance] | None":
        # Pending instances are admitted ONLY for running entries: a foreach
        # entry that already failed (continue/escalate) must never run its
        # queued siblings -- that would spend max_parallel slots on child
        # work for an entry that is already terminal.
        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                if entry.status != "running":
                    continue
                for instance in entry.instances:
                    if instance.status == "pending":
                        return state, entry, instance
        return None

    async def _admit(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, *, allow_backoff: bool
    ) -> str:
        """Spawn one instance. Returns "admitted", "deferred", "failed", or
        "stopped".

        Rate-limited admissions never sleep inside this call: the loop path
        records an exponential backoff deadline on the run (doubling delays
        capped at 60s) and defers; the control loop waits out the deadline
        in bounded slices capped at the collect poll timeout, so children
        keep being collected and budgets keep being checked while admission
        backs off -- a rate-limit retry never blocks the sole control lane
        (a blocking backoff starved collection for the whole sleep). In the
        admission phase (``allow_backoff=False``, run()/resume()) a rate
        limit defers without recording a deadline: the loop's own retry
        records it. At most ``BACKOFF_MAX_ATTEMPTS`` consecutive rate-limited
        admissions of one instance fail the node through its failure_policy;
        a successful admission resets the streak. Any other admission error
        fails the entry immediately.

        Every await re-checks the run state: a spawn that lands after
        ``stop()`` is retracted (deleted and cancelled) instead of
        registered running.
        """
        from . import spawn

        instance.attempt += 1
        child_name = _spawn_label(state.name, run.run_id, state.state_id, instance.index, instance.attempt)
        try:
            handle = await spawn(
                instance.prompt, name=child_name, model=state.model, thinking=state.thinking
            )
        except RuntimeError as exc:
            last_error = str(exc)
            if _is_rate_limit_error(last_error):
                if allow_backoff:
                    instance.rate_limit_streak += 1
                    if instance.rate_limit_streak >= BACKOFF_MAX_ATTEMPTS:
                        await self._apply_instance_failure(
                            run, state, entry, instance, f"spawn admission failed: {last_error}", retry=False
                        )
                        return "failed"
                    delay = min(
                        BACKOFF_BASE_SECONDS * (2 ** (instance.rate_limit_streak - 1)),
                        BACKOFF_CAP_SECONDS,
                    )
                    deadline = self._now_fn() + delay
                    if run.admission_backoff_until is None or deadline > run.admission_backoff_until:
                        run.admission_backoff_until = deadline
                    self._event(
                        run,
                        "spawn_backoff",
                        node=state.state_id,
                        entry=entry.index,
                        instance=instance.index,
                        detail=f"rate limited; retrying in {delay:g}s",
                    )
                else:
                    self._event(
                        run,
                        "spawn_deferred",
                        node=state.state_id,
                        entry=entry.index,
                        instance=instance.index,
                        detail=f"rate limited at admission: {last_error}",
                    )
                return "deferred"
            await self._apply_instance_failure(
                run, state, entry, instance, f"spawn admission failed: {last_error}", retry=False
            )
            return "failed"
        if run.state != "running":
            # stop() ran while the spawn was in flight: its cancellation
            # pass could not see this child yet, so retract it here or it
            # would outlive the stopped run under the supervisor.
            instance.child_id = handle.rlm_child_id
            await self._retract_admission(run, state, entry, instance)
            return "stopped"
        instance.child_id = handle.rlm_child_id
        instance.spawned_at = self._now_fn()
        instance.status = "running"
        instance.rate_limit_streak = 0
        run.spawn_count += 1
        self._event(
            run,
            "spawned",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            attempt=instance.attempt,
            child=handle.rlm_child_id,
            name=child_name,
        )
        return "admitted"

    # -- settlement, retries, policies ---------------------------------------

    async def _apply_settlement(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, result: Any
    ) -> None:
        if instance.status != "running":
            return  # cancelled (stop/fail_fast) while the collect was in flight
        instance.duration_ms = result.duration_ms
        instance.tool_uses = result.tool_use_count or 0
        run.settle_count += 1
        run.tool_use_total += instance.tool_uses
        child_reason: str | None = None
        if result.status == "error":
            child_reason = result.error or f"child settled with status {result.status!r}"
        elif result.status == "cancelled":
            child_reason = "child was cancelled"
        elif result.status != "done":
            child_reason = f"child settled with unexpected status {result.status!r}"
        if child_reason is not None:
            # Child failures retry (same rendered prompt, attempts+1) while
            # attempts remain; then the entry failure_policy applies.
            await self._apply_instance_failure(run, state, entry, instance, child_reason, retry=True)
            return
        budget_ms = state.spec.get("budget_ms")
        if budget_ms is not None and instance.spawned_at is not None:
            elapsed_ms = (self._now_fn() - instance.spawned_at) * 1000
            if elapsed_ms > budget_ms:
                # Wall-clock budget (admission to settlement) exceeded: the
                # budget is spent, so no retry; the failure_policy applies.
                await self._apply_instance_failure(
                    run,
                    state,
                    entry,
                    instance,
                    f"state budget_ms {budget_ms} exceeded ({int(elapsed_ms)}ms from admission to settlement)",
                    retry=False,
                )
                return
        instance.status = "done"
        instance.answer = (result.answer_preview or "")[:ANSWER_CAPTURE_CAP] or None
        self._event(
            run,
            "settled",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            status="done",
            duration_ms=instance.duration_ms,
        )
        if instance.answer:
            self._event(
                run,
                "answer_captured",
                node=state.state_id,
                entry=entry.index,
                instance=instance.index,
                answer=instance.answer,
                stage="arrived",
            )
        if entry.status == "running" and entry.instances and all(i.status == "done" for i in entry.instances):
            entry.status = "done"
            entry.answer = self._entry_answer(entry)
            self._capture_outputs(state, entry)
            self._queue_settle(run, state, entry)

    def _entry_answer(self, entry: _StateEntry) -> str | None:
        """Captured answer for binding: one preview, or all instances joined."""
        answers = [instance.answer for instance in entry.instances if instance.status == "done" and instance.answer]
        if not answers:
            return None
        return "\n\n".join(answers)

    def _capture_outputs(self, state: _StateRun, entry: _StateEntry) -> None:
        """Capture the state's declared output ports from the entry's answer.

        Text ports keep the captured string; json ports parse as in V1
        binding, with the parse error recorded on the settle so a reader
        (guard or input binding) fails deterministically instead of
        re-parsing.
        """
        outputs: dict[str, Any] = {}
        errors: dict[str, str] = {}
        for out in state.spec.get("outputs") or []:
            name, port_type = out.get("name"), out.get("type")
            if port_type == "text":
                if entry.answer is not None:
                    outputs[name] = entry.answer
                continue
            if entry.answer is None:
                continue
            parsed, error = _parse_json_output(entry.answer, name)
            if error is None:
                outputs[name] = parsed
            else:
                errors[name] = error
        entry.outputs = outputs
        entry.output_errors = errors

    async def _apply_instance_failure(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, reason: str, *, retry: bool
    ) -> None:
        instance.status = "error"
        instance.error = reason
        self._event(
            run,
            "settled",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            status="error",
            error=reason,
            duration_ms=instance.duration_ms,
        )
        retries = state.spec.get("retries", NODE_RETRIES_DEFAULT)
        # A retry is only queued when the entry can re-admit it: a foreach
        # sibling failing with retries left after its entry already went
        # terminal (a sibling failed it permanently first) would otherwise
        # sit pending forever -- _next_pending_instance serves running
        # entries only, while _run_complete and the stall detector both
        # count the pending instance as in-flight, so the control loop
        # would never finish the run. The failed instance settles as an
        # error instead; the policy call below is a no-op on a terminal
        # entry.
        if retry and instance.attempt <= retries and entry.status == "running":
            instance.status = "pending"
            instance.error = None
            self._event(
                run,
                "retry",
                node=state.state_id,
                entry=entry.index,
                instance=instance.index,
                detail=f"attempt {instance.attempt} failed; re-spawning (retries {retries})",
            )
            return
        # The instance failed permanently, so the entry fails NOW. A foreach
        # entry does not wait for its remaining instances: without this, a
        # failure that settles before its siblings leaves the entry stuck in
        # running with every instance terminal, and fail_fast could never
        # cancel in-flight siblings. The policy guard makes the second and
        # later permanent failures no-ops.
        await self._apply_entry_failure_policy(run, state, entry, reason)

    async def _apply_entry_failure_policy(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, reason: str
    ) -> None:
        if entry.status in TERMINAL_ENTRY_STATUSES:
            return  # the policy already ran for this entry
        policy = state.spec.get("failure_policy", RUN_FAILURE_POLICY_DEFAULT)
        entry.status = "error"
        entry.error = reason
        state.error = reason
        self._event(run, "node_error", node=state.state_id, entry=entry.index, error=reason, detail=f"failure_policy {policy}")
        # The entry is terminal: its prepared-but-never-admitted instances
        # (a foreach queue behind max_parallel, or a rate-limit deferral)
        # can never run now, so mark them cancelled with their own ledger
        # event instead of leaving them pending forever.
        for instance in entry.instances:
            if instance.status == "pending":
                instance.status = "cancelled"
                self._event(
                    run,
                    "cancelled",
                    node=state.state_id,
                    entry=entry.index,
                    instance=instance.index,
                    detail="entry failed before admission",
                )
        # The failed entry settles too: guard-less transitions (the compiled
        # dag's depends_on edges) fire from error settles so dependents run.
        self._queue_settle(run, state, entry)
        if run.state != "running":
            # stop() (or another transition) owns the run state now; keep the
            # entry's error but do not overwrite the final state.
            return
        if policy == "fail_fast":
            await self._halt_nonterminal(run, "run failed (fail_fast)")
            if run.state != "running":
                return  # stop() landed during the cancellations; it wins
            cancelled_children = sum(
                1
                for other in run.states.values()
                for other_entry in other.entries
                for i in other_entry.instances
                if i.status == "cancelled"
            )
            run.state = "failed"
            await self._milestone(
                run,
                "failed",
                f"state {state.state_id} failed: {reason}; cancelled {cancelled_children} in-flight child(ren)",
                node=state.state_id,
            )
        elif policy == "continue":
            pass  # the entry stays error; dependents see the error settle at binding
        else:  # escalate (default)
            run.state = "paused"
            run.pause_reason = reason
            await self._milestone(
                run,
                "paused",
                f"state {state.state_id} failed: {reason}; resume with await rlm.factory.resume('{run.run_id}')",
                node=state.state_id,
            )

    async def _halt_nonterminal(self, run: FactoryRun, reason: str) -> list[str]:
        """Delete every running child and cancel every non-terminal entry;
        never-entered states are marked cancelled.

        A state participates when ANY entry is non-terminal, not only the
        latest one: a re-entered state can keep an earlier entry in flight
        while its latest entry settled, and that entry must be cancelled too
        (state.status reports the latest entry only).
        """
        stopped = [
            state_id
            for state_id in run.order
            if any(entry.status in ("pending", "running") for entry in run.states[state_id].entries)
            or (not run.states[state_id].entries and run.states[state_id].status == "pending")
        ]
        await self._cancel_running(run)
        for state_id in stopped:
            state = run.states[state_id]
            if any(entry.status in ("pending", "running") for entry in state.entries) or not state.entries:
                state.cancelled = True
                for entry in state.entries:
                    if entry.status in ("pending", "running"):
                        entry.status = "cancelled"
                        self._event(run, "node_cancelled", node=state_id, entry=entry.index, detail=reason)
                        for instance in entry.instances:
                            if instance.status == "pending":
                                # Prepared but never admitted (or still in
                                # flight inside _admit): the cancelled entry
                                # owns it, so it reads cancelled, not pending,
                                # in the stopped/failed ledger.
                                instance.status = "cancelled"
                                self._event(
                                    run,
                                    "cancelled",
                                    node=state_id,
                                    entry=entry.index,
                                    instance=instance.index,
                                    detail="cancelled before admission",
                                )
        return stopped

    async def _retract_admission(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance
    ) -> None:
        """Cancel an admission that landed after the run left "running".

        ``stop()`` cancels every child it can see before it returns; a spawn
        that was still in flight during that pass is invisible to it, so the
        just-returned child is deleted here and the instance is marked
        cancelled instead of registered running. Without this the child
        would keep running under the supervisor after a "stopped" run.
        """
        from . import delete_subagent

        child_id = instance.child_id or ""
        try:
            await delete_subagent(child_id)
        except Exception as exc:
            self._event(run, "cancel_failed", node=state.state_id, entry=entry.index, instance=instance.index, child=child_id, error=str(exc))
            # The slot is released either way, so the ledger must record the
            # cancellation next to the failure (the eval replay checker keys
            # off cancelled events, and the instance below reads cancelled).
            self._event(run, "cancelled", node=state.state_id, entry=entry.index, instance=instance.index, child=child_id, detail="slot released despite the failed delete")
        else:
            self._event(run, "cancelled", node=state.state_id, entry=entry.index, instance=instance.index, child=child_id)
        # The child is supervisor-owned; a failed delete leaves it running
        # there, but the executor treats its slot as released.
        instance.status = "cancelled"

    async def _cancel_running(self, run: FactoryRun) -> None:
        from . import delete_subagent

        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                for instance in entry.instances:
                    if instance.status != "running" or instance.child_id is None:
                        continue
                    child_id = instance.child_id
                    # Claim the instance BEFORE the await: a concurrent
                    # cancellation pass (stop() racing fail_fast's cascade, or a
                    # repeated stop) must never issue a duplicate delete for a
                    # child this pass already owns. A failed delete still
                    # releases the slot, so the terminal status is the same
                    # either way, and a settle landing inside the delete window
                    # is dropped instead of applying to a child being torn down.
                    instance.status = "cancelled"
                    try:
                        await delete_subagent(child_id)
                    except Exception as exc:
                        self._event(run, "cancel_failed", node=state_id, entry=entry.index, instance=instance.index, child=child_id, error=str(exc))
                        # The slot is released either way, so the ledger also
                        # records the cancellation next to the failure (the
                        # eval replay checker keys off cancelled events, and
                        # the instance above already reads cancelled).
                        self._event(run, "cancelled", node=state_id, entry=entry.index, instance=instance.index, child=child_id, detail="slot released despite the failed delete")
                    else:
                        self._event(run, "cancelled", node=state_id, entry=entry.index, instance=instance.index, child=child_id)
                    # The child is supervisor-owned; a failed delete leaves it
                    # running there, but the executor treats its slot as released.

    # -- completion ----------------------------------------------------------

    def _run_complete(self, run: FactoryRun) -> bool:
        """Quiescence: no unevaluated settle, no entry in flight, and no
        instance still queued for admission or awaiting settlement.

        The INSTANCE layer matters too: a failed foreach entry whose
        siblings are still running (continue policy) is terminal at the
        entry layer, but the run is not quiescent until those children
        settle -- finalizing earlier orphaned them under the supervisor
        with no collector. Admitted resident instances are the one
        exception: they stay alive under the parent session until
        rlm.factory.stop() or session teardown, so a resident entry's
        running instances never block completion -- but its still-queued
        (pending) instances do: the admission queue must drain before the
        run can end, or a resident left pending by max_parallel was
        misreported as quiescent and never admitted."""
        if run.pending_evaluations:
            return False
        for state in run.states.values():
            resident = state.lifecycle == "resident"
            for entry in state.entries:
                if entry.status in ("pending", "running"):
                    if not (resident and entry.status == "running"):
                        return False
                for instance in entry.instances:
                    if instance.status == "pending":
                        return False
                    if instance.status == "running" and not (resident and entry.status == "running"):
                        return False
        return True

    async def _finalize(self, run: FactoryRun) -> None:
        if run.state != "running":
            return  # stop() or a failure policy owns the final state
        errors = [
            state
            for state in run.states.values()
            if any(entry.status == "error" for entry in state.entries)
        ]
        if errors:
            run.state = "failed"
            await self._milestone(
                run,
                "failed",
                "completed with state error(s): " + ", ".join(state.state_id for state in errors),
            )
            return
        run.state = "done"
        residents = [
            state
            for state in run.states.values()
            if state.lifecycle == "resident"
            and any(entry.status == "running" for entry in state.entries)
        ]
        detail = f"run complete: {len(run.states)} state(s), {run.transitions_fired} transition(s) fired"
        if residents:
            detail += f"; {len(residents)} resident state(s) still running (stop with await rlm.factory.stop('{run.run_id}'))"
        await self._milestone(run, "finished", detail)

    # -- control loop --------------------------------------------------------

    def _start_loop(self, run: FactoryRun) -> None:
        # Called only from run()/resume(), both awaited inside a running
        # asyncio loop, so get_running_loop() always finds it.
        import asyncio

        run.task = asyncio.get_running_loop().create_task(
            self._control_loop(run, run.loop_generation)
        )

    async def _control_loop(self, run: FactoryRun, generation: int) -> None:
        import asyncio

        try:
            await self._loop_body(run, generation)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A dead bridge or host failure must not wedge the run silently;
            # children stay alive under the supervisor either way. A stop()
            # that landed concurrently keeps ownership of the final state.
            self._event(run, "executor_error", error=f"{type(exc).__name__}: {exc}")
            if run.state == "running":
                run.state = "failed"
                try:
                    await self._milestone(run, "failed", f"executor error: {exc}")
                except Exception:
                    pass

    async def _loop_body(self, run: FactoryRun, generation: int) -> None:
        import asyncio

        from . import collect

        # The generation re-checks after every await are the resume-race
        # fix: a resume() that lands while this task is suspended at an
        # await (an in-flight collect or milestone) bumps the generation,
        # so this task exits at its next check instead of continuing as a
        # second concurrent control loop.
        while self._loop_alive(run, generation):
            in_flight = [
                (run.states[state_id], entry, instance)
                for state_id in run.order
                for entry in run.states[state_id].entries
                for instance in entry.instances
                if instance.status == "running" and instance.child_id is not None
            ]
            if in_flight:
                results = await collect(
                    [instance.child_id for _, _, instance in in_flight], timeout_ms=POLL_TIMEOUT_MS
                )
                settled = {entry.rlm_child_id: entry for entry in results if entry.settled}
                for state, entry, instance in in_flight:
                    # A GENERATION bump mid-batch drops this collect's
                    # results: the resumed loop re-collects the children
                    # (they stay running supervisor-side), so no settle is
                    # applied by two lanes. A pause or stop that this very
                    # batch triggered does NOT drop the rest of the batch:
                    # the old design (and its tests) finish applying the
                    # batch's settlements, and a policy pause must not
                    # strand the siblings' statuses.
                    if run.loop_generation != generation:
                        return
                    result = settled.get(instance.child_id or "")
                    if result is not None:
                        await self._apply_settlement(run, state, entry, instance, result)
            # Re-check state before completion: stop() (or a policy transition)
            # can land while the collect above was in flight, and a run that
            # was stopped must never finalize as done.
            if not self._loop_alive(run, generation):
                return
            await self._evaluate_settles(run)
            if not self._loop_alive(run, generation):
                return
            if self._run_complete(run):
                await self._finalize(run)
                return
            if self._run_budget_exceeded(run):
                await self._pause_for_budget(run)
                return
            started = await self._spawn_ready(run, generation=generation, allow_backoff=True)
            if not self._loop_alive(run, generation):
                return
            if run.admission_backoff_until is not None and self._now_fn() < run.admission_backoff_until:
                # Admission is backed off: wait out the deadline in bounded
                # slices (capped at the collect poll timeout) instead of
                # hot-spinning -- and instead of blocking the lane with one
                # long sleep: children that settle during the slice are
                # collected on the next iteration, within the same bound a
                # normal collect wait already has.
                remaining = run.admission_backoff_until - self._now_fn()
                await self._sleep_fn(min(remaining, POLL_TIMEOUT_MS / 1000))
                continue
            if not run.pending_evaluations and self._resident_cap_starved(run):
                # Residents never settle, so a max_parallel cap held entirely
                # by resident instances never frees a slot: the queued work
                # would wait forever, and the no-in-flight stall check below
                # never fires because the residents keep children in flight.
                # End the run instead of polling a dead end; stop() still
                # tears the resident children down.
                reason = (
                    f"control loop stalled: resident instances hold every max_parallel {run.max_parallel} slot; "
                    "queued instances can never be admitted"
                )
                self._event(run, "executor_error", error=reason)
                run.state = "failed"
                try:
                    await self._milestone(run, "failed", reason)
                except Exception:
                    pass
                return
            resident_only_in_flight = all(
                state.lifecycle == "resident" for state, _, _ in in_flight
            )
            if (
                (not in_flight or resident_only_in_flight)
                and not started
                and not self._has_pending_instance(run)
                and not run.pending_evaluations
            ):
                # Defensive: nothing in flight, nothing admitted, nothing
                # pending -- or only resident instances in flight, which
                # never settle and can never unblock anything (residents
                # declare no outputs and no outgoing transitions, so a
                # pending entry's input source can only stay unsettled).
                # The one reachable shape is a pending entry whose input
                # source never settled; end the run instead of spinning.
                stuck = [
                    state_id
                    for state_id in run.order
                    for entry in run.states[state_id].entries
                    if entry.status == "pending" and not entry.instances
                ]
                if stuck:
                    reason = (
                        "control loop stalled: pending entry of state "
                        + ", ".join(repr(state_id) for state_id in stuck)
                        + " is waiting for an input source that never settled"
                    )
                else:
                    reason = "control loop stalled: no in-flight or pending work"
                self._event(run, "executor_error", error=reason)
                run.state = "failed"
                try:
                    await self._milestone(run, "failed", reason)
                except Exception:
                    pass
                return
            # Yield once per iteration. A real collect already waits up to
            # POLL_TIMEOUT_MS, but an instantly-settling host (tests, a fast
            # supervisor) must not hot-spin the loop and starve other tasks.
            await asyncio.sleep(0)

    # -- small helpers --------------------------------------------------------

    def _running_instance_count(self, run: FactoryRun) -> int:
        return sum(
            1
            for state in run.states.values()
            for entry in state.entries
            for instance in entry.instances
            if instance.status == "running"
        )

    def _resident_cap_starved(self, run: FactoryRun) -> bool:
        """True when queued instances can never be admitted: every
        ``max_parallel`` slot is held by a never-settling resident instance.

        Residents stay running until ``stop()`` tears them down, so a cap
        held entirely by resident instances never frees a slot and pending
        instances behind that cap would wait forever. One task instance in
        flight means a slot can still open on its settle, so that is not a
        dead end.
        """
        running = [
            state.lifecycle == "resident"
            for state in run.states.values()
            for entry in state.entries
            for instance in entry.instances
            if instance.status == "running"
        ]
        if len(running) < run.max_parallel or not self._has_pending_instance(run):
            return False
        return all(running)

    def _has_pending_instance(self, run: FactoryRun) -> bool:
        return any(
            instance.status == "pending"
            for state in run.states.values()
            for entry in state.entries
            for instance in entry.instances
        )

    def _pending_state_ids(self, run: FactoryRun) -> list[str]:
        return [state_id for state_id in run.order if run.states[state_id].status == "pending"]


# ---------------------------------------------------------------------------
# The opt-in gate: `factory.enabled` in the agent-dir settings file.
# ---------------------------------------------------------------------------

#: The single refusal every gated factory call raises while the setting is
#: off. One exact message, so agents and tests can pin the refusal.
FACTORY_DISABLED_MESSAGE = "the factory is disabled; run /factory on to enable it"

_SETTINGS_FILE_NAME = "settings.json"


def factory_enabled() -> bool:
    """Read the ``factory.enabled`` opt-in setting (default off).

    The factory is opt-in: it ships disabled, and the user turns it on with
    ``/factory on`` (the persisted setting is ``factory.enabled`` in the
    agent dir's ``settings.json`` -- the same nested-camelCase document the
    daemon and TUI settings surface write, e.g. ``{"factory": {"enabled":
    true}}`` beside ``compaction``/``agentTraces``). The read mirrors the
    lenient settings loading on the Rust side: a missing file or key, a
    wrong-typed value, or a corrupt document all read as unset, and unset
    means disabled -- the opt-in default is fail-closed, so an unreadable
    settings file refuses the factory instead of silently enabling it.
    """
    # One home for the agent-dir resolution (harness.py owns it); imported
    # lazily because harness imports this module at its own top.
    from .harness import _agent_dir

    path = _agent_dir() / _SETTINGS_FILE_NAME
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError):
        return False
    if not isinstance(document, dict):
        return False
    factory = document.get("factory")
    if not isinstance(factory, dict):
        return False
    return factory.get("enabled") is True


def require_factory_enabled() -> None:
    """Refuse with one clean error while the factory is disabled.

    Every gated surface funnels through here -- the ``rlm.factory``
    namespace calls (``run``/``status``/``stop``/``resume``, and the later
    ``graph``/``watch``) and the factory harness writes -- so the refusal is
    one message at every seam. ``help()`` is deliberately exempt: the
    authoring reference must stay readable before opting in.
    """
    if not factory_enabled():
        raise ValueError(FACTORY_DISABLED_MESSAGE)


_DEFAULT_EXECUTOR: FactoryExecutor | None = None


def default_factory_executor() -> FactoryExecutor:
    """The process-wide executor behind the ``rlm.factory`` namespace.

    Tests that need an injected clock or sleep assign their own
    ``FactoryExecutor`` to ``factory._DEFAULT_EXECUTOR``; the namespace then
    routes through it.
    """
    global _DEFAULT_EXECUTOR
    if _DEFAULT_EXECUTOR is None:
        _DEFAULT_EXECUTOR = FactoryExecutor()
    return _DEFAULT_EXECUTOR


async def run_factory(spec_id: str, *, name: str | None = None) -> dict[str, Any]:
    """Validate a factory spec and start a nonblocking run of it.

    The argument names a stored factory entry (a runtime instance) first;
    when no entry carries that id, it resolves a machine from the library
    (repo directory first, user second) and runs the template directly:
    ``await rlm.factory.run("review-sweep")`` starts the library machine
    without creating a harness entry. Harness entries remain runtime
    instances; machines are templates.
    """
    require_factory_enabled()
    executor = default_factory_executor()
    harness = executor._resolve_harness()
    if harness.get("factory", spec_id) is None:
        try:
            machine, path = resolve_machine(spec_id)
        except MachineResolutionError as error:
            if error.broken:
                raise ValueError(
                    f"the library machine {spec_id!r} exists but is broken ({error})"
                ) from None
            raise ValueError(
                f"unknown factory spec {spec_id!r}: no stored factory entry and "
                f"no library machine with that name ({error})"
            ) from None
        except ValueError as error:
            # An id that is not a legal machine name (spaces, capitals) can
            # never resolve from the library either; the unknown-spec frame
            # must not lose the lookup to the name-rule sentence. Only the
            # name-rule error can arrive here: every library-file failure
            # (unreadable, non-UTF-8, unparseable, spec-invalid) is a
            # MachineResolutionError in the first except arm.
            raise ValueError(
                f"unknown factory spec {spec_id!r}: no stored factory entry, and "
                f"the id is not a valid machine name either ({error})"
            ) from None
        return await executor.run_machine(machine, machine_path=path, name=name)
    return await executor.run(spec_id, name=name)


async def status_factory(run_id: str) -> dict[str, Any]:
    """Return state states, the event window, elapsed time, and usage."""
    require_factory_enabled()
    return await default_factory_executor().status(run_id)


async def stop_factory(run_id: str) -> dict[str, Any]:
    """Cancel every running child of the run and mark it stopped."""
    require_factory_enabled()
    return await default_factory_executor().stop(run_id)


async def resume_factory(run_id: str) -> dict[str, Any]:
    """Resume a paused run (escalate, budget, or max_transitions pause)."""
    require_factory_enabled()
    return await default_factory_executor().resume(run_id)


# ---------------------------------------------------------------------------
# Machine library: MACHINE.md files (import, export, share).
#
# A MACHINE.md is the shareable unit of the machine library, mirroring the
# SKILL.md/skills conventions: YAML frontmatter (name, description, version,
# author) followed by one fenced ``machine-spec`` block whose payload is a
# JSON factory spec in the exact schema ``validate_factory_spec`` accepts
# (machine form, or dag sugar that compiles to one) -- no new spec parser.
# The library resolves from two levels, repo first, user second:
#
# - repo: the bundled machines shipped INSIDE the runtime package
#   (``src/rlm/machines/<name>/MACHINE.md``, wheel package data, so every
#   installed kernel sees the same seeds a checkout does);
#   ``PRIME_AGENT_MACHINES_DIR`` redirects the level at a team directory.
# - user: ``<agent dir>/machines/<name>/MACHINE.md`` (personal machines).
#
# ``import_machine`` is the library's gate: it parses the file, passes the
# spec through the SAME write-time validator as every factory write (an
# invalid spec never persists, with exact user-correctable errors), then
# writes the file verbatim into the user library so its documentation
# travels with the spec. ``export_machine`` serializes a library machine, a
# stored factory entry's spec, or a run's canonical machine back to
# MACHINE.md (byte-pretty, stable formatting for diffs). Harness entries
# remain runtime instances; machines in the library are templates, so
# ``run_factory`` falls back to the library when its argument names no
# stored entry: ``await rlm.factory.run("review-sweep")``.
# ---------------------------------------------------------------------------

MACHINE_FILE_NAME = "MACHINE.md"
MACHINE_SPEC_FENCE = "machine-spec"
MACHINES_DIR_NAME = "machines"
MACHINE_NAME_MAX_LENGTH = 64
MACHINE_DESCRIPTION_MAX_LENGTH = 1024
MACHINE_FRONTMATTER_FIELDS: tuple[str, ...] = ("name", "description", "version", "author")

_MACHINE_NAME_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]*")
_PLAIN_FRONTMATTER_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._/@+~-]*")


def machine_name_errors(name: Any) -> list[str]:
    """Name rules mirrored from the skill library (validate_name)."""
    if not isinstance(name, str) or not name:
        return ["machine name must be a non-empty string"]
    errors: list[str] = []
    if len(name) > MACHINE_NAME_MAX_LENGTH:
        errors.append(f"machine name exceeds {MACHINE_NAME_MAX_LENGTH} characters ({len(name)})")
    if _MACHINE_NAME_PATTERN.fullmatch(name) is None:
        errors.append(
            "machine name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)"
        )
    if name.endswith("-"):
        errors.append("machine name must not end with a hyphen")
    return errors


def machine_description_errors(description: Any) -> list[str]:
    """Description rules mirrored from the skill library (validate_description).

    One rule is the library's own: the description is one listing row, so
    embedded line breaks are a format error.
    """
    if not isinstance(description, str) or not description.strip():
        return ["frontmatter description is required"]
    if len(description) > MACHINE_DESCRIPTION_MAX_LENGTH:
        return [
            "frontmatter description exceeds "
            f"{MACHINE_DESCRIPTION_MAX_LENGTH} characters ({len(description)})"
        ]
    if "\n" in description or "\r" in description:
        return ["frontmatter description must be a single line"]
    return []


def _unquote_frontmatter_value(raw: str, field: str) -> "tuple[str | None, str | None]":
    """Unquote one frontmatter value: plain, single-quoted, or double-quoted.

    Plain values must stay YAML-safe (no colon anywhere), so a rendered
    value always parses back identically.
    """
    value = raw.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        try:
            unquoted = json.loads(value)
        except ValueError as error:
            return None, f"frontmatter {field} has an invalid double-quoted value ({error})"
        if not isinstance(unquoted, str):
            return None, f"frontmatter {field} must be a string scalar"
        return unquoted, None
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'"), None
    if ":" in value:
        return (
            None,
            f"frontmatter {field} is not a plain scalar (quote the value to include ':' characters)",
        )
    return value, None


def _parse_machine_frontmatter(
    text: str, *, source: str
) -> "tuple[dict[str, str] | None, str, list[str]]":
    """Parse the strict frontmatter subset MACHINE.md allows.

    The subset is deliberately narrower than full YAML: one ``key: value``
    line per field, the four machine fields only, quoted values for
    anything that is not a plain scalar. The error sentences are the
    import gate's user-correctable surface. Returns
    ``(fields, body, [])`` on success or ``(None, "", errors)``.
    """
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    if not lines or lines[0].rstrip() != "---":
        return None, "", [f"{source}: MACHINE.md must start with a `---` frontmatter block"]
    fields: dict[str, str] = {}
    errors: list[str] = []
    close_index: int | None = None
    for index in range(1, len(lines)):
        line = lines[index].rstrip()
        if line == "---":
            close_index = index
            break
        if not line.strip():
            errors.append(f"{source}: frontmatter line {index + 1} is empty (one `key: value` line per field)")
            continue
        key, separator, raw_value = line.partition(":")
        if not separator:
            errors.append(f"{source}: frontmatter line {index + 1} must be `key: value`")
            continue
        key = key.strip()
        if key not in MACHINE_FRONTMATTER_FIELDS:
            errors.append(
                f"{source}: unknown frontmatter key {key!r} "
                f"(allowed: {', '.join(MACHINE_FRONTMATTER_FIELDS)})"
            )
            continue
        if key in fields:
            errors.append(f"{source}: frontmatter field {key!r} is declared more than once")
            continue
        if not raw_value.strip():
            errors.append(f"{source}: frontmatter field {key!r} requires a value")
            continue
        unquoted, error = _unquote_frontmatter_value(raw_value, key)
        if error is not None:
            errors.append(f"{source}: {error}")
            continue
        assert unquoted is not None
        fields[key] = unquoted
    if close_index is None:
        return None, "", [f"{source}: frontmatter is not closed (end it with a `---` line)"]
    body = "\n".join(lines[close_index + 1 :])
    if errors:
        return None, "", errors
    return fields, body, []


def _extract_machine_spec_blocks(body: str, *, source: str) -> "tuple[str | None, list[str]]":
    """Return the single fenced ``machine-spec`` payload from the body.

    Other fenced blocks (prose examples, JSON listings) are skipped as
    opaque units: their content never participates in the fence scan.
    """
    lines = body.split("\n")
    contents: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        if not line.lstrip().startswith("```"):
            index += 1
            continue
        open_index = index
        info = line.strip()[3:].strip()
        index += 1
        content_lines: list[str] = []
        closed = False
        while index < len(lines):
            fence_line = lines[index].rstrip()
            if fence_line == "```":
                closed = True
                index += 1
                break
            content_lines.append(lines[index])
            index += 1
        if info != MACHINE_SPEC_FENCE:
            if not closed:
                return None, [f"{source}: the ```{info} fence opened at line {open_index + 1} is never closed"]
            continue
        if not closed:
            return None, [f"{source}: the ```{MACHINE_SPEC_FENCE} fence is never closed"]
        contents.append("\n".join(content_lines))
    if not contents:
        return None, [
            f"{source}: MACHINE.md requires exactly one fenced ```{MACHINE_SPEC_FENCE} block; found none"
        ]
    if len(contents) > 1:
        return None, [
            f"{source}: MACHINE.md requires exactly one fenced ```{MACHINE_SPEC_FENCE} block; "
            f"found {len(contents)}"
        ]
    return contents[0], []


@dataclass(frozen=True)
class MachineFile:
    """A parsed MACHINE.md: strict frontmatter plus the machine-spec payload."""

    name: str
    description: str
    version: str
    author: str
    spec: "dict[str, Any]"


def parse_machine_file(text: str, *, source: str = "machine file") -> "tuple[MachineFile | None, list[str]]":
    """Parse one MACHINE.md. Returns ``(machine, [])`` or ``(None, errors)``.

    This owns the FILE format only (frontmatter, fence, JSON payload); the
    spec stays in the existing validated schema, and the import and run
    gates pass it through ``validate_factory_spec`` separately.
    """
    fields, body, errors = _parse_machine_frontmatter(text, source=source)
    if fields is None:
        return None, errors
    payload, errors = _extract_machine_spec_blocks(body, source=source)
    if errors:
        return None, errors
    assert payload is not None
    try:
        spec = json.loads(payload)
    except ValueError as error:
        return None, [
            f"{source}: the ```{MACHINE_SPEC_FENCE} block must contain a JSON object ({error})"
        ]
    if not isinstance(spec, dict):
        return None, [
            f"{source}: the ```{MACHINE_SPEC_FENCE} block must contain a JSON object, "
            f"got a {type(spec).__name__}"
        ]
    name = fields.get("name", "")
    errors = machine_name_errors(name)
    errors.extend(machine_description_errors(fields.get("description")))
    if errors:
        return None, errors
    return (
        MachineFile(
            name=name,
            description=fields["description"],
            version=fields.get("version", ""),
            author=fields.get("author", ""),
            spec=spec,
        ),
        [],
    )


def _render_frontmatter_value(value: str) -> str:
    """Render one frontmatter value: plain when YAML-safe, else double-quoted."""
    if _PLAIN_FRONTMATTER_VALUE.fullmatch(value) is not None:
        return value
    return json.dumps(value, ensure_ascii=False)


def _machine_contract_lines(spec: "dict[str, Any]") -> list[str]:
    """Deterministic contract prose generated from the spec (both forms)."""
    lines: list[str] = []
    run = spec.get("run")
    if isinstance(run, dict):
        parts = [
            f"failure_policy={run.get('failure_policy')}",
            f"max_parallel={run.get('max_parallel')}",
        ]
        if "budget_ms" in run:
            parts.append(f"budget_ms={run['budget_ms']}")
        if "max_transitions" in run:
            parts.append(f"max_transitions={run['max_transitions']}")
        lines.append("Run: " + ", ".join(parts))
    states = spec.get("states") if isinstance(spec.get("states"), list) else spec.get("nodes")
    if not isinstance(states, list):
        return lines
    lines.append("")
    lines.append("States:")
    for state in states:
        if not isinstance(state, dict):
            continue
        flags = []
        if state.get("entry"):
            flags.append("entry")
        for key in ("lifecycle", "max_entries", "retries", "failure_policy", "budget_ms"):
            if key in state:
                flags.append(f"{key}={state[key]}")
        label = f"- {state.get('id')}"
        if flags:
            label += f" ({', '.join(flags)})"
        lines.append(label)
        subagent = state.get("subagent")
        if isinstance(subagent, dict):
            settings = subagent.get("name") or subagent.get("prompt", "")[:60]
            lines.append(f"  subagent: inline ({settings})")
        elif isinstance(subagent, str):
            lines.append(f"  subagent: {subagent}")
        for inp in state.get("inputs") or []:
            if isinstance(inp, dict):
                optional = " [optional]" if inp.get("optional") else ""
                lines.append(
                    f"  input: {inp.get('name')} ({inp.get('type')}) <- {inp.get('from')}{optional}"
                )
        for out in state.get("outputs") or []:
            if isinstance(out, dict):
                lines.append(f"  output: {out.get('name')} ({out.get('type')})")
        foreach = state.get("foreach")
        if isinstance(foreach, dict):
            lines.append(f"  foreach: over {foreach.get('over')}, max {foreach.get('max')}")
    transitions = spec.get("transitions")
    if isinstance(transitions, list):
        lines.append("")
        lines.append("Transitions:")
        for transition in transitions:
            if not isinstance(transition, dict):
                continue
            raw_from = transition.get("from")
            if isinstance(raw_from, list):
                source_text = "[" + ", ".join(str(item) for item in raw_from) + "]"
            else:
                source_text = str(raw_from)
            guard = transition.get("when")
            guard_text = ""
            if isinstance(guard, dict):
                port = guard.get("output")
                path = guard.get("path")
                target = f"{port}.{path}" if path else str(port)
                guard_text = f" when {target} {guard.get('op')} {json.dumps(guard.get('value'))}"
            lines.append(f"- {source_text} -> {transition.get('to')}{guard_text}")
    return lines


def render_machine_file(machine: MachineFile) -> str:
    """Render a MachineFile back to canonical MACHINE.md text.

    Byte-stable: the same machine always renders to the same bytes (stable
    formatting for diffs), and ``parse_machine_file`` of the output
    recovers the same machine.
    """
    frontmatter = [
        "---",
        f"name: {_render_frontmatter_value(machine.name)}",
        f"description: {_render_frontmatter_value(machine.description)}",
        f"version: {_render_frontmatter_value(machine.version)}",
        f"author: {_render_frontmatter_value(machine.author)}",
        "---",
    ]
    sections = [
        "\n".join(frontmatter),
        "",
        f"# {machine.name}",
        "",
        "## Machine contract",
        "",
    ]
    sections.extend(_machine_contract_lines(machine.spec))
    sections.append("")
    sections.append(f"```{MACHINE_SPEC_FENCE}")
    sections.append(json.dumps(machine.spec, indent=2, ensure_ascii=False))
    sections.append("```")
    return "\n".join(sections) + "\n"


def _machine_env_dir(name: str) -> str | None:
    # Set-but-empty env values behave as unset (mirrors harness._env_dir).
    value = (os.environ.get(name) or "").strip()
    return value or None


def repo_machines_dir() -> Path:
    """The bundled machine library shipped inside the runtime package.

    An explicit ``PRIME_AGENT_MACHINES_DIR`` wins (a team can point the
    shared level at their own directory); otherwise the library resolves
    relative to this module — ``src/rlm/machines`` in a checkout, exactly
    the wheel-package data a kernel venv installs into
    ``site-packages/rlm/machines`` — so an installed kernel sees the same
    seeds a checkout does, with no source-tree walk-up that could pick up
    a stray directory above an installed venv.
    """
    override = _machine_env_dir("PRIME_AGENT_MACHINES_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parent / MACHINES_DIR_NAME


def user_machines_dir() -> Path:
    """The personal machines directory (``<agent dir>/machines``)."""
    raw = (
        _machine_env_dir("PRIME_AGENT_CODING_AGENT_DIR")
        or _machine_env_dir("PI_CODING_AGENT_DIR")
        or str(Path.home() / ".prime" / "agent")
    )
    return Path(raw).expanduser().resolve() / MACHINES_DIR_NAME


def machine_library_dirs(
    *, repo_dir: "str | Path | None" = None, user_dir: "str | Path | None" = None
) -> "list[tuple[str, Path]]":
    """Library levels in resolution order: repo first, user second.

    Both levels always exist (the repo level is the packaged library;
    the user level is the personal directory under the agent dir); a
    missing directory is simply empty, so listing and resolving skip it.
    """
    repo = Path(repo_dir).expanduser() if repo_dir is not None else repo_machines_dir()
    user = Path(user_dir).expanduser() if user_dir is not None else user_machines_dir()
    return [("repo", repo), ("user", user)]


def _read_library_machine(path: Path) -> "tuple[MachineFile | None, str]":
    """One library file's validity verdict, shared by scan and resolve.

    The four gates both surfaces apply — read, decode, the file format's
    strict parser, the write-time spec validator — in one helper, so
    `factory list` and `resolve_machine` can never disagree: a file
    invalid here is never listed as usable and never claims its name at
    resolve time. Returns ``(machine, "")`` when the file parses and
    validates, ``(None, "<path>: <exact errors>")`` when it fails to read,
    decode, or parse, and ``(machine, "<path>: <exact spec errors>")``
    when it parses but its spec fails the validator (the machine rides
    along so resolve can tell which name the file carries).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        return None, f"{path}: unreadable ({error})"
    except UnicodeDecodeError as error:
        return None, f"{path}: not valid UTF-8 ({error})"
    machine, errors = parse_machine_file(text, source=str(path))
    if machine is None or errors:
        return None, f"{path}: {'; '.join(errors)}"
    spec_errors = validate_factory_spec(machine.spec)
    if spec_errors:
        return machine, f"{path}: {'; '.join(spec_errors)}"
    return machine, ""


def _scan_machine_library(
    *, repo_dir: "str | Path | None" = None, user_dir: "str | Path | None" = None
) -> "tuple[list[dict[str, Any]], list[str]]":
    """One pass over both levels: the listed machines and broken-file
    warnings (``<path>: <errors>``).

    The shared scan behind ``list_machines`` and the CLI's ``factory list``:
    both levels resolve identically, repo wins on name conflicts, and the
    gates are ``_read_library_machine`` — the same verdict
    ``resolve_machine`` applies, so a machine the listing shows always
    parses and validates for resolve/run/import, while the files it skips
    surface as warnings here and never claim their name on the resolve
    surface either (their exact errors surface there only when no valid
    machine carries the name).
    """
    machines: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    for source, directory in machine_library_dirs(repo_dir=repo_dir, user_dir=user_dir):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob(f"*/{MACHINE_FILE_NAME}")):
            machine, error = _read_library_machine(path)
            if error:
                warnings.append(error)
                continue
            if machine.name in machines:
                continue  # repo first: the earlier level keeps the name
            machines[machine.name] = {
                "name": machine.name,
                "description": machine.description,
                "version": machine.version,
                "author": machine.author,
                "source": source,
                "path": str(path),
            }
    return [machines[name] for name in sorted(machines)], warnings


def list_machines(
    *, repo_dir: "str | Path | None" = None, user_dir: "str | Path | None" = None
) -> "list[dict[str, Any]]":
    """Library contents with descriptions, resolution-deduped (repo wins).

    Broken files are skipped silently here (the agent-facing list);
    ``cli_dispatch``'s ``list`` op surfaces them as warnings so the CLI's
    ``factory list`` can say why a machine does not show.
    """
    return _scan_machine_library(repo_dir=repo_dir, user_dir=user_dir)[0]


class MachineResolutionError(ValueError):
    """One library lookup failure, with its kind.

    ``broken`` distinguishes the two outcomes a caller must not blur: the
    name's only carriers are machine files that failed to parse or
    validate (the first file's errors say why) versus no machine carrying
    the name at all.
    """

    def __init__(self, message: str, *, broken: bool) -> None:
        super().__init__(message)
        self.broken = broken


def resolve_machine(
    name: str,
    *,
    repo_dir: "str | Path | None" = None,
    user_dir: "str | Path | None" = None,
) -> "tuple[MachineFile, Path]":
    """Resolve one machine by name: repo directory first, user second.

    The fast path reads ``<dir>/<name>/MACHINE.md`` directly, but only
    serves what passes ``_read_library_machine`` — the SAME validity
    verdict the listing scan applies — and only when its DECLARED name
    matches: a directory named ``x`` holding ``name: y`` is not the
    machine ``x`` (the declared name is the machine's name); such a file
    resolves only through the scan below, under its declared name like it
    does in the skill library. A file that fails to read, decode, or
    parse, or carries a spec the write-time validator rejects, never
    claims its name on either surface: resolution falls through to the
    next level exactly like the listing does, so `factory list`,
    ``rlm.factory.run``, and export can never disagree about a name. A
    name whose only carriers are invalid files raises
    ``MachineResolutionError`` with ``broken=True`` and the first file's
    exact errors (in repo-to-user order) — broken, never missing; a name
    no machine carries raises it with ``broken=False``.
    """
    errors = machine_name_errors(name)
    if errors:
        raise ValueError("; ".join(errors))
    broken: str | None = None
    for _source, directory in machine_library_dirs(repo_dir=repo_dir, user_dir=user_dir):
        path = directory / str(name) / MACHINE_FILE_NAME
        if not path.is_file():
            continue
        machine, file_error = _read_library_machine(path)
        if file_error:
            # The same verdict the listing scan applied: an invalid file
            # does not claim the name, so the next level gets its chance.
            # Keep the broken frame only for a file that carries the name
            # — one that fails outright (machine is None) or declares
            # this name — because a file declaring another name never
            # carried this one.
            if broken is None and (machine is None or machine.name == name):
                broken = file_error
            continue
        if machine.name == name:
            return machine, path
    listed = list_machines(repo_dir=repo_dir, user_dir=user_dir)
    for entry in listed:
        if entry["name"] == name:
            machine, parse_errors = parse_machine_file(
                Path(entry["path"]).read_text(encoding="utf-8"), source=entry["path"]
            )
            if machine is None or parse_errors:
                raise MachineResolutionError("; ".join(parse_errors), broken=True)
            return machine, Path(entry["path"])
    if broken is not None:
        raise MachineResolutionError(broken, broken=True)
    listing = ", ".join(entry["name"] for entry in listed)
    raise MachineResolutionError(
        f"unknown machine {name!r}: no MACHINE.md for it in the machine library (machines: {listing or 'none'})",
        broken=False,
    )


def import_machine(path: "str | Path", *, target_dir: "str | Path | None" = None) -> "dict[str, Any]":
    """The library gate: parse a MACHINE.md, validate its spec, persist it.

    The spec goes through the SAME write-time validator as every factory
    write (``validate_factory_spec``): an invalid spec never persists, and
    the ``ValueError`` carries every error sentence, so the surface stays
    user-correctable. Valid files persist byte-for-byte (their own prose,
    formatting, and line endings travel with the machine) into the user
    library.
    """
    source_path = Path(path).expanduser()
    if not source_path.is_file():
        raise ValueError(f"machine file not found: {source_path}")
    raw = source_path.read_bytes()
    text = raw.decode("utf-8")
    machine, errors = parse_machine_file(text, source=str(source_path))
    if machine is None or errors:
        raise ValueError("; ".join(errors))
    spec_errors = validate_factory_spec(machine.spec)
    if spec_errors:
        raise ValueError("; ".join(spec_errors))
    destination_root = Path(target_dir).expanduser() if target_dir is not None else user_machines_dir()
    destination = destination_root / machine.name / MACHINE_FILE_NAME
    destination.parent.mkdir(parents=True, exist_ok=True)
    created = not destination.exists()
    destination.write_bytes(raw)
    return {"name": machine.name, "path": str(destination), "created": created}


def _single_line(text: Any) -> str:
    """Collapse free prose onto one line (whitespace runs become spaces).

    A stored entry's ``content`` is free prose while a machine description
    must be a single line, so exports collapse rather than refuse.
    """
    if not isinstance(text, str):
        return ""
    return " ".join(text.split())


def _write_export_target(destination: Path, text: str, *, overwrite: bool) -> None:
    """Write an export target, never silently clobbering one.

    The no-overwrite path creates the file exclusively (``open(..., "x"``):
    the existence check and the creation are one atomic step, so a file
    created concurrently after a plain ``exists()`` check cannot slip past
    the refusal, and a symlink planted at the target refuses instead of
    being followed); ``overwrite=True`` is the explicit opt-in that
    replaces whatever is there.
    """
    if overwrite:
        destination.write_text(text, encoding="utf-8")
        return
    try:
        with open(destination, "x", encoding="utf-8") as handle:
            handle.write(text)
    except FileExistsError:
        raise ValueError(
            f"export path {destination} already exists (pass overwrite=True to replace it)"
        ) from None


def export_factory_spec(
    spec: Any,
    out_path: "str | Path",
    *,
    name: str,
    description: str,
    version: str = "1",
    author: str = "",
    overwrite: bool = False,
) -> "dict[str, Any]":
    """Serialize any spec (stored entry or run machine) to MACHINE.md.

    Byte-pretty and stable: the same spec always renders to the same bytes.
    The spec passes through the write-time validator first, so an exported
    file always re-imports. The out target is never overwritten silently: an
    existing file refuses unless ``overwrite=True`` says otherwise.
    """
    errors = validate_factory_spec(spec)
    errors.extend(machine_name_errors(name))
    errors.extend(machine_description_errors(description))
    if errors:
        raise ValueError("; ".join(errors))
    machine = MachineFile(
        name=name,
        description=description,
        version=version,
        author=author,
        spec=copy.deepcopy(spec),
    )
    destination = Path(out_path).expanduser()
    if destination.is_dir():
        raise ValueError(f"export path {destination} is a directory (pass a file path)")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _write_export_target(destination, render_machine_file(machine), overwrite=overwrite)
    return {"name": name, "path": str(destination), "source": "spec"}


def export_library_machine(
    name: str,
    out_path: "str | Path",
    *,
    repo_dir: "str | Path | None" = None,
    user_dir: "str | Path | None" = None,
    overwrite: bool = False,
) -> "dict[str, Any]":
    """Export one library machine to MACHINE.md at ``out_path``.

    Resolution is the library contract only (repo directory first, user
    second); the file copies verbatim so the shared documentation travels
    with the spec. The out target is never overwritten silently: an
    existing file refuses unless ``overwrite=True`` says otherwise. The
    CLI dispatches here because a fresh CLI process has no session state
    (stored entries and live runs) to resolve from.
    """
    machine, path = resolve_machine(name, repo_dir=repo_dir, user_dir=user_dir)
    destination = Path(out_path).expanduser()
    if destination.is_dir():
        raise ValueError(f"export path {destination} is a directory (pass a file path)")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _write_export_target(
        destination, path.read_text(encoding="utf-8"), overwrite=overwrite
    )
    return {"name": machine.name, "path": str(destination), "source": "library"}


def export_machine(
    target: str,
    out_path: "str | Path",
    *,
    repo_dir: "str | Path | None" = None,
    user_dir: "str | Path | None" = None,
    overwrite: bool = False,
) -> "dict[str, Any]":
    """Export one machine to MACHINE.md at ``out_path``.

    Resolution mirrors ``run_factory``: a stored factory entry first, a
    live run's canonical machine second, then the library machine (repo
    directory first, user second). Library machines copy their file
    verbatim so the shared documentation travels with the spec; entry and
    run specs render byte-pretty.
    """
    executor = default_factory_executor()
    harness = executor._resolve_harness()
    entry = harness.get("factory", target)
    if entry is not None:
        arguments = entry.arguments if isinstance(entry.arguments, dict) else {}
        spec = arguments.get("machine")
        if spec is None:
            spec = arguments.get("dag")
        if spec is None:
            raise ValueError(f"factory entry {target!r} carries no machine or dag spec")
        errors = machine_name_errors(target)
        if errors:
            raise ValueError(
                "; ".join(errors + [f"the stored entry id {target!r} cannot become a machine name"])
            )
        description = _single_line(entry.content) or _single_line(entry.title)
        return export_factory_spec(
            spec, out_path, name=target, description=description, overwrite=overwrite
        )
    run = executor._runs.get(target)
    if run is not None and run.machine:
        errors = machine_name_errors(run.spec_id)
        if errors:
            raise ValueError(
                "; ".join(errors + [f"the run's spec id {run.spec_id!r} cannot become a machine name"])
            )
        description = _single_line(run.name) or f"factory run {run.run_id}"
        return export_factory_spec(
            run.machine, out_path, name=run.spec_id, description=description, overwrite=overwrite
        )
    return export_library_machine(
        target, out_path, repo_dir=repo_dir, user_dir=user_dir, overwrite=overwrite
    )


def cli_dispatch(payload: Any) -> "dict[str, Any]":
    """JSON facade for the ``prime-agent factory`` subcommands.

    The CLI resolves the kernel Python, feeds one JSON payload on stdin,
    and reads one JSON result from stdout: ``{"ok": true, ...}`` or
    ``{"ok": false, "errors": [...]}``. Every error surfaces as data, so
    the exact validator sentences reach the command's output verbatim.
    The payload carries only what the user typed (an op, a path, a name,
    an out target); this process resolves every library directory itself,
    so the kernel is the single resolution contract for list, import, and
    export alike — a fresh CLI process has no session state (stored
    entries, live runs), so export resolves the library only.
    """
    if not isinstance(payload, dict):
        return {"ok": False, "errors": ["factory cli payload must be a JSON object"]}
    op = payload.get("op")
    if op == "list":
        machines, warnings = _scan_machine_library()
        return {"ok": True, "machines": machines, "warnings": warnings}
    if op == "import":
        if not isinstance(payload.get("path"), str) or not payload["path"]:
            return {"ok": False, "errors": ["factory import requires a `path` string"]}
        try:
            result = import_machine(payload["path"])
        except (ValueError, OSError) as error:
            return {"ok": False, "errors": [str(error)]}
        return {"ok": True, **result}
    if op == "export":
        if not isinstance(payload.get("name"), str) or not payload["name"]:
            return {"ok": False, "errors": ["factory export requires a `name` string"]}
        if not isinstance(payload.get("out"), str) or not payload["out"]:
            return {"ok": False, "errors": ["factory export requires an `out` string"]}
        try:
            result = export_library_machine(payload["name"], payload["out"])
        except (ValueError, OSError) as error:
            return {"ok": False, "errors": [str(error)]}
        return {"ok": True, **result}
    return {
        "ok": False,
        "errors": [f"unknown factory cli op {op!r} (expected 'list', 'import' or 'export')"],
    }


FACTORY_HELP: str = r"""# Factory

The factory runs state-machine workflows of spawned child agents. A stored
factory entry declares the machine — states, each backed by a subagent
spec, plus guarded transitions between them. `await rlm.factory.run('<spec_id>')`
spawns each state's subagent as an ordinary child, feeds captured outputs
into the successors' prompts, and drives the run to quiescence in a
background kernel task; the call returns immediately and the run continues
after the model turn ends. Use it when a workflow needs shape: fan-out,
bounded loops (review/fix until a verdict approves), joins, or one child
per list item.

The factory is opt-in: it ships disabled, and the user turns it on with
`/factory on` (`/factory off` disables it again, `/factory status` reports
it; the persisted setting is `factory.enabled` in the agent dir's
settings.json). While it is disabled, every `rlm.factory` call except
`help()` — run, status, stop, and resume — plus every factory harness
write (`create_factory` and updates of factory entries) refuses with one
clean error:
"the factory is disabled; run /factory on to enable it". `help()` answers
while disabled, so this guide stays readable before opting in.

## Store the spec

A factory spec is a continual-harness entry of kind `factory`.
`rlm.harness.create_factory(...)` validates at write time; an invalid spec
is never stored (generic `create`/`update` funnel through the same check).
The spec rides `machine=` (the native form) or `dag=` (sugar that compiles
to machine form) — pass exactly one. This review/fix loop is the shipped
pr-manager shape:

```python
rlm.harness.create_factory(
    "pr-manager",
    "Drive a PR through review/fix cycles, then keep a resident watcher on it.",
    id="pr-manager",
    machine={
        "run": {"budget_ms": 1_800_000, "max_parallel": 8, "max_transitions": 24},
        "states": [
            {
                "id": "entry", "entry": True,
                "subagent": {"prompt": (
                    "Identify the pull request for the current branch with "
                    "`gh pr view --json url`. Return a fenced json block of the form "
                    '{"pr_url": "https://github.com/owner/repo/pull/N"}. '
                    "Output only the json block.")},
                "outputs": [{"name": "pr_url", "type": "json"}],
            },
            {
                "id": "reviewing",
                "subagent": {"prompt": (
                    "Review the pull request at {pr_url} for merge-blocking "
                    "defects with `gh pr diff`. When a fix report is bound below, "
                    "verify the described fixes landed. Return a fenced json block "
                    'of the form {"verdict": {"approved": <true|false>, '
                    '"findings": ["at most three one-line findings"]}}. '
                    "Output only the json block.")},
                "inputs": [
                    {"name": "pr_url", "type": "json", "from": "entry.pr_url"},
                    {"name": "fix_report", "type": "json", "from": "fixing.fix_report", "optional": True},
                ],
                "outputs": [{"name": "verdict", "type": "json"}],
                "max_entries": 4,
            },
            {
                "id": "fixing",
                "subagent": {"prompt": (
                    "Address the review findings in the verdict below. Make the "
                    "smallest targeted fixes, run the relevant tests, and return a "
                    "fenced json block of the form "
                    '{"fix_report": {"fixed": ["finding that was addressed"], '
                    '"skipped": ["finding left alone and why"]}}. '
                    "Output only the json block.\n\n{verdict}")},
                "inputs": [{"name": "verdict", "type": "json", "from": "reviewing.verdict"}],
                "outputs": [{"name": "fix_report", "type": "json"}],
                "max_entries": 3,
            },
            {
                "id": "monitoring",
                "subagent": {"prompt": "Stay resident as the watcher for {pr_url}: "
                    "report the `gh pr checks` state once, then remain available for "
                    "follow-up questions."},
                "inputs": [{"name": "pr_url", "type": "json", "from": "entry.pr_url"}],
                "lifecycle": "resident",
            },
        ],
        "transitions": [
            {"from": "entry", "to": "reviewing"},
            {"from": "reviewing", "to": "fixing",
             "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False}},
            {"from": "reviewing", "to": "monitoring",
             "when": {"output": "verdict", "path": "approved", "op": "eq", "value": True}},
            {"from": "fixing", "to": "reviewing"},
        ],
    },
)
```

The example exercises the core forms: `entry` is an entry state; the two
guards select the next state from the reviewer's `verdict`; `fix_report` is
optional, so the reviewer's first entry binds a null sentinel before the
fixer ever runs and its re-entry re-binds the real report; `max_entries`
bounds the loop; `monitoring` is a `resident` that stays alive under the
parent session after the run ends. Both worked examples bound their
emitted payloads in the prompt — a capped findings list here, a capped
file list in the review-sweep example — because captured answers are
capped previews: an unbounded payload truncates at the cap and fails to
bind.

## Authoring reference

- **States**: 1 to 1024, unique ids matching `^[a-z0-9][a-z0-9-]{0,63}$`; at
  least one state carries `"entry": true`, and entry states declare no
  inputs. A state's `subagent` is a harness subagent entry id or title (its
  content is the prompt template; `metadata.model`/`metadata.thinking` are
  spawn settings) or an inline `{"prompt": ...}` object with optional
  `name`/`model`/`thinking`. The optional `name` labels the spawned
  children (at most 64 characters, unique across the machine's states —
  a name another state's name can suffix onto, `foo` vs `foo-i1`, is
  rejected at write time): the first instance is named exactly `name` —
  the label to message the child by — and re-entries, foreach fan-out,
  and retries disambiguate with the same `-i<n>`/`-a<n>` suffixes the
  generated labels use; a suffixed label that would pass the host's
  64-character cap shrinks its base with a digest of the full name, like
  the generated labels do.
- **Ports**: inputs and outputs of type `text` or `json`. An input binds
  `"from": "<state_id>.<output_name>"`; types must match, duplicates are
  rejected, and nothing can read from a resident. Bound values render into
  `{input_name}` placeholders (one pass; inputs without a placeholder are
  appended in a trailing `## Inputs` section). A required input whose source
  has not settled yet keeps the entry pending; over a settled source that
  offers no value (an errored settle, a port the settle captured no value
  for, or a JSON capture failure) it fails the dependent entry, while
  `"optional": true` binds a null sentinel in every no-value case (a
  source that offers no value is not a value, so the dependent that
  declared the input optional proceeds). A required self-input is
  rejected at validation —
  `state X input 'name' cannot require itself: mark the self-input optional
  - a required one can never bind on the state's first entry` — while an
  optional self-input is the designed self-loop form (first entry binds
  null, re-entries bind the previous settle).
- **Transitions**: `{"from": ..., "to": ..., "on": "settled", "when": ...}`.
  Each settle is evaluated exactly once and every guard that passes fires
  (fan-out is legal); a fire onto a state at `max_entries` is recorded as a
  blocked transition. `from` may be a list of states: a join that fires
  once every source settled — once per source-settle combination — and may
  not carry a guard. Guards are `{"output": ..., "path": ..., "op": ...,
  "value": ...}` over the from-state's latest settle: `op` is one of `eq`,
  `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`; `path` drills a
  dotted path into a `json` output; `eq`/`ne` compare JSON-strictly (a
  boolean never equals a number), comparison ops need a numeric value,
  `contains` a non-empty list, `exists` no value, and a missing or
  unparseable port fails every op except `exists`. A failed settle still
  fires guard-less transitions, so dependents under `continue` run; their
  required input over the failed source then fails the dependent entry,
  while an optional input over the failed source binds the null sentinel
  and the dependent proceeds.
- **Cycles are legal**: there is no acyclicity requirement — self-loops and
  back edges validate. The one rule is an entry state somewhere; a dag
  whose every node depends on another compiles to no entry states and is
  rejected.
- **foreach**: `{"over": "<input>", "max": 1..256}` expands one entry into
  one child per item of the named `json` input (clamped at `max`), each
  child rendered with its item bound as that input; an empty list settles
  the entry with no children.
- **Residents**: `"lifecycle": "resident"` states declare no outputs, no
  foreach, and no outgoing transitions, nothing reads from them, and their
  instance stays alive under the parent session after the run completes
  (stop the run to retire it).
- **Bounds and policies**: `run.max_parallel` (1..64, default 8) is the
  run's global budget of simultaneously running instances — not a
  per-node limit. `run.max_children` (default 10,000, capped at
  1,000,000) is the run's global budget of total admissions over its
  life — foreach expansions and retry re-spawns included (neither
  `max_parallel` nor `max_transitions` bounds children); reaching it
  pauses the run once, and `resume` continues past it as an explicit
  operator decision. `run.max_transitions` (default 10 per state, capped
  at 10,000) pauses the run once at the boundary, mid-settle; `resume`
  continues after the transitions that already fired without re-firing
  them. `run.budget_ms` pauses the run once when exceeded (in-flight
  children keep running). Per state: `max_entries` (default 1), `retries`
  (0..10, same rendered prompt), `budget_ms` (admission to settlement;
  exceeding it fails the attempt without a retry), and `failure_policy` —
  `fail_fast` (cancel every child, run failed), `continue` (entry stays
  errored; the run finishes and reports failed if any state errored), or
  `escalate` (the default: pause the run; resuming is the operator's
  decision).
- **Dead configurations fail loudly, never wedge**: a pending entry whose
  input source never settled, a `max_parallel` cap held entirely by
  never-settling residents with work queued, or nothing in flight and
  nothing pending each end the run as failed with the reason in the
  ledger. `wait` blocks on states are rejected at validation (not
  supported yet).

## Dag form

Sugar, not a second semantics: each node becomes a state entered once, a
node with no effective dependencies becomes an entry state, and the full
dependency set — `depends_on` plus every `inputs[].from` source — compiles
to ONE join transition, so a fan-in node waits for every parent. The
shipped review-sweep shape:

```python
rlm.harness.create_factory(
    "review-sweep",
    "Sweep the branch's changed files for findings, then merge them into one list.",
    id="review-sweep",
    dag={
        "run": {"budget_ms": 900_000, "max_parallel": 8},
        "nodes": [
            {
                "id": "files",
                "subagent": {"prompt": (
                    "List the files the current branch changes relative to the "
                    "base branch, capped at the eight most relevant. Return "
                    'a fenced json block of the form {"files": ["path/to/file", ...]}. '
                    "Output only the json block.")},
                "outputs": [{"name": "files", "type": "json"}],
            },
            {
                "id": "review",
                "subagent": {"prompt": (
                    "Review the changed file {files} for merge-blocking defects: "
                    "correctness bugs, regressions, unhandled error paths, missing "
                    "tests. Reply one short line: `<path>: <the most serious "
                    "problem, or 'clean'>`.")},
                "inputs": [{"name": "files", "type": "json", "from": "files.files"}],
                "outputs": [{"name": "found", "type": "text"}],
                "foreach": {"over": "files", "max": 8},
            },
            {
                "id": "report",
                "subagent": {"prompt": (
                    "Merge the review lines below into one fenced json block of "
                    'the form {"issues": [{"file": "path", "finding": "..."}]} '
                    "listing every file that is not clean. Output only the json "
                    "block.\n\n{found}")},
                "inputs": [{"name": "found", "type": "text", "from": "review.found"}],
            },
        ],
    },
)
```

## Run and steer

```python
result = await rlm.factory.run("pr-manager")
# {"run_id": "...", "spec_id": "pr-manager", "nodes": 4, "max_parallel": 8,
#  "started": ["entry"], "pending": []}  — returns immediately.

status = await rlm.factory.status(result["run_id"])
status["state"]    # running | stopping | paused | done | failed | stopped
status["nodes"]    # per state: status, entries_used/max_entries, instances,
                   # latest answer_preview, error
status["events"]   # trailing ledger: spawned, settled, answer_captured,
                   # transition_fired, node_error, milestone, ...
status["usage"]    # spawns, settled, tool_uses, max_parallel, max_children, running,
                    # transitions_fired
```

The live monitoring views (`graph()` and a bounded `watch()`) arrive
with the stacked live-view PR; `status()` covers the run state, node
detail, and the event ledger until then.

- `run` re-validates the spec and resolves every subagent reference first,
  reporting all failures in one `ValueError` and starting nothing on any
  failure; `name=` labels the run in status and the TUI.
- Pause and failure milestones (escalate, budget, max_transitions,
  max_children, failed, finished) are recorded in the run's event
  ledger, every repeat included, the pause milestones with the resume
  call spelled out — read `status()`'s trailing events to see them.
  Quiet conversation notices for the milestones (one per kind per run)
  arrive with the stacked live-view PR, which adds the host side that
  renders them.
- `stop(run_id)` cancels every running child of the run (idempotent);
  `resume(run_id)` continues a paused run and raises on a non-paused one.
- The activity lane the daemon and TUI speak arrives with the stacked
  live-view PR, camelCase on the wire (`runId`, `specId`, `timeoutMs`);
  the kernel API here (`rlm.factory.*`) is snake_case.

## Discovering machines

- The machine library: machines are `MACHINE.md` files (frontmatter plus
  one fenced `machine-spec` block), one directory per machine, resolved
  from two levels — the bundled seeds shipped inside the runtime (visible
  in every install; `PRIME_AGENT_MACHINES_DIR` redirects the level at a
  team directory) first, the personal `machines/` library under the agent
  dir second; the earlier level wins on name conflicts. `prime-agent
  factory list | import | export` manages them: list shows only what
  parses and validates (broken files print as warnings), import runs the same
  write-time validation as a stored spec so an invalid machine never
  persists, and export copies a library machine verbatim to a fresh path
  (an existing target is refused, never overwritten). `rlm.factory.run('<name>')`
  runs a library machine directly without creating a harness entry; a
  machine that exists but is broken names its errors
  instead of pretending the name is unknown. The bundled seeds are
  `builder`, `pr-manager`, and `review-sweep`; the worked examples above
  derive from their shapes.
- The TUI factory page: the activity dock's `⚙ N factory` group (Enter or
  click) opens one live diagram per run, newest run first. `j`/`k` move the
  selection, `s` stops the selected run, `r` resumes it, `m` copies it as
  Mermaid source, Esc closes.

## Safety

- Every state spawns real children that spend budget. Bound loops with
  `max_entries`, `max_transitions`, and `run.max_children` (total
  admissions); the default `escalate` policy pauses
  instead of failing, so read `status` (or the notice) before resuming.
- Captured answers are capped previews (about 160 characters) and outputs
  bind from them: keep declared outputs compact — a small fenced json
  block or one short line — and let the full answer live in the child's
  session.
- Run registries live in kernel memory: a kernel restart loses `status`
  for old runs, but the children keep running under the supervisor
  (`rlm.list_subagents` sees them). Stop runs before restarting, or
  delete the children by hand afterwards.
- Residents outlive their run; stop the run (or tear down the session) to
  retire them. Prefer `rlm.factory.stop(run_id)` over deleting a factory
  child by hand — the executor claims and cancels children itself, and a
  hand deletion surfaces as a child failure through the state's policy.
"""
