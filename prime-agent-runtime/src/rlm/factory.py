"""Validation and compilation for factory specifications.

A continual-harness ``factory`` entry stores a declarative state machine of
subagent states in ``arguments["machine"]``: entry states (whose inputs
are all optional), guarded transitions between states, and bounded re-entry
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
memory, persisted under the session artifact dir
(``$RLM_SESSION_DIR/factory-runs``: one JSON snapshot per run — forced on
state changes and settle evaluations, throttled otherwise — plus a
mutation journal for the instance batches and admissions in between): a
kernel restart loses only the control-loop tasks; the registry rehydrates
on the next factory use and the runs continue — children are
supervisor-owned and never depended on the kernel, so a finished child's
emitted outputs are still collected after any restart.

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
import math
import os
import re
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, Callable
from uuid import uuid4

FAILURE_POLICIES: tuple[str, ...] = ("fail_fast", "continue", "escalate")
PORT_TYPES: tuple[str, ...] = ("text", "json")
LIFECYCLES: tuple[str, ...] = ("task", "resident")
TRANSITION_ON_KINDS: tuple[str, ...] = ("settled",)
GUARD_OPS: tuple[str, ...] = ("eq", "ne", "gt", "gte", "lt", "lte", "exists", "contains")
# The numeric limits (states, retries, max_parallel, foreach.max,
# max_entries, max_transitions, max_children) live only in the Rust
# ``pa_factory::limits``; a run asks for them through the
# ``factory.limits`` host request before it starts (``_check_limits``).
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
_PARAM_NAME_PATTERN = re.compile(r"[a-z_][a-z0-9_]*")


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


MAX_GUARD_VALUE_DEPTH = 256
"""Nesting bound on one guard comparison value (``when.value``). Every
seam the value rides recurses per level — the traversal itself, the
snapshot's ``deepcopy``, the wire conversion, the reply frames' JSON
encoder — so a value deeper than this bound cannot ride any of them and
would exhaust the interpreter's stack on the way to finding out. A
container nested beyond the bound rejects as part of the same
finite-JSON-data rule, with the validation answer instead of the crash."""


def _value_is_finite(
    value: Any, _seen: "frozenset[int] | None" = None, _depth: int = 0
) -> bool:
    """True when a guard comparison value is JSON clean: every nested
    float finite, every object key a string, every leaf a JSON scalar,
    and no cycle.
    JSON carries no NaN/Infinity tokens, so a non-finite float would
    serialize as the non-JSON ``NaN``/``Infinity`` tokens and break every
    strict consumer of the reply frames (the host bridge's parser
    included) — a machine declaring one is invalid at the source. Object
    keys must be strings for the same reason at both ends: a non-finite
    float key carries the token into the frame the same way, and a
    non-string key (an int, a tuple) is either coerced by the encoder —
    so the wire object no longer matches the machine's declared one —
    or rejected by it; either way it is not the declared comparison.
    Leaves outside JSON's scalar set reject the same way: a tuple (or a
    set, bytes, any other container the JSON grammar has no spelling
    for) serializes as something other than the declared shape if the
    encoder accepts it at all, and the non-finite floats it can carry
    would ride that path past this check. A self-referential container
    is rejected too — the encoder refuses circular references outright,
    so it can never be a valid comparison value — and the traversal
    stops at the cycle instead of exhausting the interpreter's stack
    chasing it. ``_seen`` threads the per-branch ancestry (a
    shared-but-acyclic reference appearing twice stays valid: each
    branch checks it independently). Depth bounds the nesting the same
    way: a container nested beyond ``MAX_GUARD_VALUE_DEPTH`` levels
    cannot ride any of the value's downstream seams (the snapshot's
    deep copy, the wire conversion, the reply frames' encoder are each
    recursive per level), so it rejects here with the validation answer
    instead of exhausting the interpreter's stack further down the
    write path.
    """
    if _depth > MAX_GUARD_VALUE_DEPTH:
        return False
    seen = _seen or frozenset()
    if isinstance(value, (list, dict)):
        if id(value) in seen:
            return False
        seen = seen | {id(value)}
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, (bool, int, str)) or value is None:
        return True
    if isinstance(value, list):
        return all(_value_is_finite(item, seen, _depth + 1) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _value_is_finite(item, seen, _depth + 1)
            for key, item in value.items()
        )
    return False


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
    if "python" in state:
        # A pure-Python state runs a callable instead of spawning a child.
        python = state.get("python")
        if "subagent" in state:
            errors.append(f"{noun} {ref} declares both subagent and python; use exactly one")
        if not (
            isinstance(python, dict)
            and _is_nonempty_str(python.get("import"))
            and _is_nonempty_str(python.get("callable"))
        ):
            errors.append(f"{noun} {ref} python requires non-empty 'import' and 'callable' strings")
        elif "path" in python and not (
            _is_nonempty_str(python.get("path")) and os.path.isabs(python["path"])
        ):
            errors.append(f"{noun} {ref} python path must be an absolute directory when provided")
        if is_resident:
            errors.append(f"python {noun} {ref} cannot be resident")
        if "foreach" in state:
            errors.append(f"python {noun} {ref} cannot use foreach")
    elif _is_nonempty_str(subagent):
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
            "or an inline object with a prompt (or a python state: "
            '{"python": {"import": "<module>", "callable": "<function>"}})'
        )

    if "emit" in state:
        # The output contract a machine directory's compiler writes; its
        # types are checked in Rust (factory.emit / factory.check).
        emit = state.get("emit")
        if not (isinstance(emit, dict) and isinstance(emit.get("outputs"), list)):
            errors.append(f"{noun} {ref} emit must be an object with an outputs list")
    if "budget_ms" in state:
        budget = state.get("budget_ms")
        if not _is_positive_int(budget):
            errors.append(f"{noun} {ref} budget_ms must be a positive integer")
        elif run_budget is not None and budget > run_budget:
            errors.append(f"{noun} {ref} budget_ms {budget} exceeds the run budget_ms {run_budget}")

    if is_resident and state.get("retries", NODE_RETRIES_DEFAULT) != 0:
        errors.append(f"resident {noun} {ref} cannot declare retries")

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
    if not _value_is_finite(value):
        errors.append(
            f"transitions[{index}] when.value must be finite JSON data "
            "(JSON carries no NaN or Infinity, and only JSON shapes "
            "serialize: lists, objects, strings, numbers, booleans, null, "
            f"and no container nests deeper than {MAX_GUARD_VALUE_DEPTH} levels)"
        )


def validate_factory_machine(machine: Any) -> list[str]:
    """Dry-run validation for a machine-form factory spec.

    Returns a list of human-readable error sentences; an empty list means
    the machine is valid. Rules: states are 1..1024 with unique slug ids and
    at least one entry state; every state requires a subagent or a python
    callable (not both) and entry states declare only optional inputs;
    resident states declare no outputs, foreach, retries, or outgoing
    transitions; wait blocks are rejected (the watch host handlers arrive
    with the communication series); transitions reference
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
    params = machine.get("params")
    param_names: set[str] = set()
    if params is not None:
        if isinstance(params, dict) and all(
            isinstance(key, str) and _PARAM_NAME_PATTERN.fullmatch(key) for key in params
        ):
            param_names = set(params)
        else:
            errors.append("params must be an object keyed by lowercase identifiers")

    states = machine.get("states")
    if not isinstance(states, list):
        errors.append("factory machine requires a states list")
        return errors
    if not states:
        errors.append("factory machine must declare at least one state")
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

    # Configured inline subagent names label the spawned children
    # run-scoped (the spawn label prefixes the configured name with the run
    # id), so two states sharing one name would still collide within a run
    # on the supervisor's unique sibling-name requirement at spawn time
    # (one common per-run prefix preserves the relative collision shape);
    # reject the duplicate at write time instead (the same reason
    # duplicate state ids are rejected).
    seen_subagent_names: dict[str, str] = {}
    for state_id, state in states_by_id.items():
        _validate_state_fields(
            state, run_budget=run_budget, states_by_id=states_by_id, noun="state", errors=errors
        )
        for inp in state.get("inputs") or []:
            if isinstance(inp, dict) and inp.get("name") in param_names:
                errors.append(f"state {state_id} input {inp['name']!r} is also a param; rename the input")
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
        # A REQUIRED input can never bind on an entry state's first entry
        # (admission has no upstream settle) nor on a self-input's first
        # entry (no settle exists before an entry settles). Optional inputs
        # are the loop form (the first entry binds the null sentinel, a
        # later entry binds the real settle), so only the required variants
        # are rejected -- the self-input check is the machine-form mirror of
        # the dag compiler's "node b cannot depend on itself" rule.
        for inp in _port_list(state, "inputs"):
            if not isinstance(inp, dict) or inp.get("optional"):
                continue
            if state.get("entry") is True:
                errors.append(
                    f"entry state {state_id} input {inp.get('name')!r} must be optional: "
                    "an entry state's first entry has no upstream settle to bind"
                )
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
    if not nodes:
        return None, errors + ["factory dag must declare at least one node"]

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
        for key in (
            "subagent", "python", "lifecycle", "budget_ms", "retries", "failure_policy", "inputs", "outputs", "foreach"
        ):
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
    max_transitions 10 per state, run max_children 10000,
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
            "max_transitions", TRANSITIONS_PER_STATE_DEFAULT * states_count
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
        }
        for key in ("subagent", "python", "budget_ms", "inputs", "outputs", "foreach", "emit"):
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
    canonical: dict[str, Any] = {"run": run}
    if "params" in machine:
        canonical["params"] = copy.deepcopy(machine["params"])
    canonical["states"] = states_out
    canonical["transitions"] = transitions_out
    return canonical


async def _check_limits(spec: dict[str, Any]) -> None:
    """Check a valid spec's declared numeric limits with the host (the
    Rust ``pa_factory::limits``, the one copy of those numbers); raises
    ``ValueError`` with every bound the spec breaks."""
    from . import host_request

    try:
        await host_request("factory.limits", {"spec": spec})
    except RuntimeError as error:
        raise ValueError(str(error)) from None


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
    "canonicalize_factory_spec",
    "cli_dispatch",
    "compile_factory_dag",
    "default_factory_executor",
    "export_factory_spec",
    "export_machine",
    "factory_enabled",
    "render_machine_file",
    "require_factory_enabled",
    "resume_factory",
    "run_factory",
    "FactoryEmitError",
    "emit_factory_outputs",
    "factory_inputs",
    "status_factory",
    "stop_factory",
    "topological_order",
    "validate_factory_machine",
    "validate_factory_spec",
]


# Executor: run a canonicalized machine through the RLM supervisor.
# ---------------------------------------------------------------------------

ANSWER_CAPTURE_CAP = 200
"""Local cap for captured-answer PREVIEWS: the ``answer_captured`` ledger
event and the status node's ``answer_preview`` stay compact (the host's
own roster previews cap at 160 characters, ``compactRlmText``).
"""

ANSWER_BINDING_CAP = 65_536
"""Local cap for the settle-capture binding lane, at parity with the
host's collect bound (the daemon's ANSWER_TEXT_MAX_CHARS: 65,536
characters).

``rlm.collect`` carries the child's full final answer (``answer_text``,
host-bounded at that size): input binding and output capture work on
that text, not the roster preview — a fenced JSON output longer than the
old 200-character preview cap was truncated before the executor ever saw
it, and the downstream bind failed with "no JSON object containing
output" although the child settled with exactly the fenced JSON (the M2
class). The old 8192-character cap failed the same class one lane later:
a valid fenced JSON longer than it (a design node's 26–29 KiB output,
observed three times) was cut mid-object before the parse, so the capture
failed deterministically although the envelope still carried the whole
answer. At parity the slice is a no-op on what the host delivers (it
bounds answer_text at this same size), so a fenced JSON the child kept
within this size binds whole; the cap still bounds each captured answer
the factory stores, and a bind failure names the stored answer's length
when it reaches this cap (a joined multi-instance answer can cross it
with nothing cut). Full child transcripts stay in the child's own
session regardless.
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

WATCH_TIMEOUT_CAP_SECONDS = 60.0
"""Upper bound on one ``factory.watch`` timeout (seconds), the agent-side
streaming monitor's ceiling. The host bridge caps its own lane lower
(``FACTORY_HOST_WATCH_TIMEOUT_MS``); this is the kernel-side bound."""

LAST_FIRED_WINDOW = 10
# The unscoped graph's terminal-history window: the newest terminal runs
# the all-runs reply carries (every live run reports regardless).
GRAPH_RUNS_WINDOW = 20
"""Trailing fired transitions the graph snapshot reports for edge marking."""

GRAPH_EVENTS_TAIL = 40
"""Trailing ledger events a compact (host-lane) graph snapshot carries."""

FACTORY_FRAME_CAP = 262_144
"""Serialized byte cap on one factory_activity reply frame. A graph for the
full 1024-state machine cap fits; a snapshot that cannot shrink under the
cap fails loudly instead of being silently truncated."""

ACTIVITY_ACTIONS = (
    "graph",
    "status",
    "watch",
    "run",
    "stop",
    "resume",
    "library",
    "peek",
    "node",
)
"""The host bridge's actions over the factory surface, the
``factory_activity`` frame's action vocabulary: one run's
``graph``/``status``/``watch``/``stop``/``resume``, a ``run`` by spec id,
``library`` (one library machine's graph for the machines page's drill-in;
the daemon answers the machine list itself), ``peek`` — the unscoped graph
minus the rehydration re-arm, the read another session's display polls
through — and ``node`` (one run state's detail for the node view). The
kernel namespace is the same surface plus ``graph``/``watch`` for agents."""

NODE_PROMPT_CAP = 65_536
"""Byte cap on one ``node`` reply's realized prompt (the exact spawn text
the child received), with ``promptTruncated`` set when it fires."""

NODE_INPUTS_CAP = 16_384
"""Byte cap on one ``node`` reply's serialized bound inputs."""

NODE_OUTPUTS_CAP = 16_384
"""Byte cap on one ``node`` reply's serialized settle outputs."""

ACTIVITY_TIMEOUT_MS_CAP = int(WATCH_TIMEOUT_CAP_SECONDS * 1000)
"""Upper bound on one factory_activity frame's timeoutMs (the watch wait
bound on the wire); the host bridge pins its own lower bound."""

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

INFRA_VERIFY_QUIET_SECONDS = POLL_TIMEOUT_MS / 1000
"""Quiet period before the executor re-reads a worker that settled with an
infra error (one collect-poll slice): the re-check must not race the very
probe streak that reported the death. The sleep is injected, so tests see
no wall-clock wait."""

_INFRA_ERROR_MARKERS = (
    "child worker unreachable",
    "supervisor link",
)

FACTORY_OUTPUTS_FILE = "factory-outputs.json"
"""A factory child's accepted outputs, beside its session file: the
child's ``factory.emit`` host request writes it, the executor reads it."""

RUNS_DIR_NAME = "factory-runs"
#: The append-only tombstone ledger: one line per terminal run (the
#: registry's durable post-mortem record — see _retire_run_files).
RETIRED_RUNS_FILE = "retired.jsonl"
#: The tombstone read bound: status answers the record, not the history.
RETIRED_RUNS_READ_LIMIT = 1_000
"""The run registry's durable home: one subdirectory of the session
artifact dir, one JSON snapshot per run. The host exports the artifact
dir as ``RLM_SESSION_DIR``; an unset value (an in-memory session, a
headless test kernel) keeps the registry kernel-memory-only."""

PERSISTED_EVENTS_CAP = 500
"""How much of the event ledger one run keeps, in memory AND in the
snapshot: ``status`` serves the trailing window, so a long-lived kernel
serves the same recent history a rehydrated one does, bounded by this
cap. The in-memory ledger trims from its front (the oldest end), and
the trim bumps ``seq_base`` so the sequence numbers stay monotonic —
no seq is ever reused, and the graph overlay's last-fired sort keeps
its order (the opus F-12 finding: the memory ledger grew without a
limit while only the snapshot was capped)."""

RETAINED_RUNS_LIMIT = 50
"""How many TERMINAL runs (done/failed/stopped) the registry keeps in
memory: an operator reads a finished run's final status for a while, but
a resident kernel that has run hundreds of machines keeps them all. Past
this limit the OLDEST terminal runs are evicted from the registry —
their files retired at the terminal persist already, so this is memory
bookkeeping only; an evicted run answers ``unknown factory run`` exactly
like a run of a previous boot (F-12's second half)."""

ADMISSIONS_JOURNAL_SUFFIX = ".admissions.jsonl"
"""A run's mutation journal: one ordered line per durable mutation made
between two snapshots — an entry's prepared instance batch
(``kind: "batch"``, one line when ``_prepare_entry`` binds a prompt per
instance) and one admitted child (``kind: "admission"``, appended the
moment the spawn handle lands). The rehydrate replays the lines the
snapshot never absorbed, so entries, pending siblings, and child_ids stay
durable at O(small) per line; a persist failure degrades durability
loudly (a ``persist_failed`` ledger row), never the run itself."""

TERMINAL_RUN_STATES = ("done", "failed", "stopped")
"""The run states past which the durable registry retires a run's files once
it owns no live child: the registry keeps the run in memory for this boot,
and a restart forgets it — the durable archive holds only runs a restart
must continue or stop."""

RUN_LOST_PYTHON_CALL = (
    "the kernel restart lost this state's running python call "
    "(the call runs in a short-lived subprocess the new kernel cannot reattach); "
    "retries re-run it, then the failure policy applies"
)
"""The failure reason a rehydrated run records for a python call that was
mid-flight when the kernel restarted: honest about the loss, routed
through the state's own retry/policy path."""

REPAIR_POLL_SECONDS = 5.0
"""How often a settled child is re-read while its repair turn or its
background work runs (its collect answers at once)."""


class FactoryEmitError(ValueError):
    """``rlm.factory.emit`` refused a value: the message names every wrong
    field (``verdict.findings[0].severity: 'high' is not one of ...``)."""


async def emit_factory_outputs(outputs: dict[str, Any]) -> dict[str, Any]:
    """Hand this factory child's outputs to the factory (``rlm.factory.emit``).

    Every value is checked against the state's declared types before
    anything is kept; a wrong value raises ``FactoryEmitError`` with the
    exact field, so fix it and call again. A ``file`` output takes a path
    (``str`` or ``Path``), relative to the kernel's current directory, and
    the file is copied. Returns ``{"accepted": [...], "missing": [...]}``,
    the required outputs still owed.
    """
    from . import host_request

    values = {name: os.fspath(value) if isinstance(value, os.PathLike) else value for name, value in outputs.items()}
    try:
        return await host_request("factory.emit", {"outputs": values, "cwd": os.getcwd()})
    except RuntimeError as error:
        raise FactoryEmitError(_emit_error_text(str(error))) from None


async def factory_inputs() -> dict[str, Any]:
    """This factory child's bound inputs and the machine's params, as values."""
    from . import host_request

    try:
        reply = await host_request("factory.inputs", {})
    except RuntimeError as error:
        raise FactoryEmitError(_emit_error_text(str(error))) from None
    return reply.get("inputs") or {}


def _emit_error_text(error: str) -> str:
    if "is not available in this session" in error:
        return (
            "rlm.factory.emit and rlm.factory.inputs work only in a child spawned by a "
            "machine directory's state (machine.toml)"
        )
    return error


FACTORY_OWNER_SESSION_ENV = "PRIME_AGENT_FACTORY_OWNER_SESSION"
"""The env var a python state reads the running session's id from (the
call itself sees no ``RLM_*`` variables)."""

PYTHON_STATE_TIMEOUT_MS_DEFAULT = 60_000
"""A python call's time limit when neither the state nor the run sets
``budget_ms``."""

PYTHON_STDERR_TAIL_CAP = 2000
"""How much of a failed python call's stderr its error text carries."""

PYTHON_RUNNER = r"""
import asyncio, importlib, importlib.util, inspect, json, os, sys
sys.path.insert(0, os.getcwd())
if len(sys.argv) > 3:
    sys.path.insert(0, sys.argv[3])
inputs = json.load(sys.stdin.buffer)
result_stream = os.fdopen(os.dup(1), "w")
os.dup2(2, 1)
sys.stdout = sys.stderr
if len(sys.argv) > 3:
    spec = importlib.util.spec_from_file_location(
        sys.argv[1], os.path.join(sys.argv[3], sys.argv[1] + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(sys.argv[1], module)
    spec.loader.exec_module(module)
else:
    module = importlib.import_module(sys.argv[1])
result = getattr(module, sys.argv[2])(inputs)
if inspect.iscoroutine(result):
    result = asyncio.run(result)
json.dump(result, result_stream)
result_stream.close()
"""
"""The ``python -I -c`` program that runs one python state call: inputs
arrive as JSON on stdin, everything the call prints (its own subprocesses
included) goes to stderr, and the returned dict is the only thing written
to stdout. A target with a ``path`` (a machine directory's ``nodes/``)
loads ``<path>/<import>.py`` by file, so a node named like a module the
runner already imported (``select.py``, ``types.py``) still runs; the
``path`` is also searched first, so a node can import its sibling files."""

_FENCED_JSON_RE = re.compile(r"```json\s*(.*?)\s*```", re.DOTALL)
TERMINAL_ENTRY_STATUSES = ("done", "error", "cancelled")


def _is_rate_limit_error(message: str) -> bool:
    """Heuristic: the host reports admission failures as error strings."""
    lowered = message.lower()
    return any(marker in lowered for marker in _RATE_LIMIT_MARKERS)


def _is_infra_error(message: str) -> bool:
    """Heuristic: the supervisor reports worker deaths and lost supervisor
    links as one-shot error settles (``Child worker unreachable`` after the
    daemon's unreachable-probe streak, or a ``supervisor link ...`` error
    from a failed kickoff). Infra, not the task's failure."""
    lowered = message.lower()
    return any(marker in lowered for marker in _INFRA_ERROR_MARKERS)


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


def _run_prefix(run_id: str) -> str:
    """The run-scoped label prefix (the generated label's third part)."""
    return run_id[:6]


def _spawn_label(
    configured: str | None, run_id: str, state_id: str, instance_index: int, attempt: int
) -> str:
    """Sibling label for one spawned instance: the state's configured inline
    subagent ``name`` prefixed with the run id, else the generated label.

    Every machine child label is run-scoped: the supervisor's sibling
    names are per-parent-session, and a parent session outlives its runs,
    so a verbatim configured name would collide with a prior run's
    settled children (they stay registered for the run's life) or with a
    live agent of the same name -- the M1 unresolvable-pause class.
    The ``<run6>-`` prefix (the same run slug the generated label
    carries) keeps cross-run admissions unique; agents message the child
    by the label the run reports (the ``spawned`` event's ``name`` and
    the status node's instance rows), not by the configured name alone.

    The SAME disambiguation suffixes as the generated label -- ``i<n>``
    for later instances (re-entry, foreach fan-out), ``a<n>`` for retries
    -- keep every admission within a run unique: the supervisor rejects
    duplicate sibling names, and one state's settled children stay
    registered for the run's life, so a re-entering state
    (``max_entries`` > 1) would collide with its own earlier child on an
    unprefixed repeat.

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
    base = f"{_run_prefix(run_id)}-{configured}"
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


def _terminal_json_object(answer: str) -> str | None:
    """The bare JSON object that terminates the answer, if one does.

    A string-aware balanced-brace scan walks the answer's top-level object
    spans (braces inside string literals never count); the terminal object
    is the last balanced span that only benign residue -- whitespace or
    punctuation such as fence fragments, dashes, or dots, never letters,
    digits, quotes, or more brackets -- follows. That is the settle shape
    the strict fence contract rejected: a JSON tail emitted as plain text
    after prose, an unclosed fence, or a dirty tail. Prose is never JSON
    syntax: quotes outside an object do not open strings, and a brace in
    prose only opens a candidate where it starts a string key -- so a
    settle that mentions a block or leaves a quote open still finds its
    terminal object. An object followed by prose or by a later incomplete
    emit stays non-terminal -- the whole-answer fallback and the
    truncation error own those cases -- an unterminated candidate owns the
    tail (a truncated emit never binds), and the output-name check applies
    to this candidate exactly as to a fence.
    """
    length = len(answer)
    last: tuple[int, int] | None = None
    index = 0
    while index < length:
        if answer[index] != "{":
            index += 1
            continue
        # a candidate opens only where its brace starts a string key; a
        # stray brace in prose is not syntax and hides nothing
        cursor = index + 1
        while cursor < length and answer[cursor].isspace():
            cursor += 1
        if cursor == length or answer[cursor] != '"':
            index += 1
            continue
        depth = 1
        in_string = False
        escaped = False
        while cursor < length:
            char = answer[cursor]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            elif char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    last = (index, cursor + 1)
                    cursor += 1
                    break
            cursor += 1
        if depth:
            # an unterminated candidate is a truncated emit: it owns the
            # tail, so nothing later binds
            return None
        index = cursor
    if last is None:
        return None
    if any(char.isalnum() or char in "\"'{}[]\\" for char in answer[last[1] :]):
        return None
    return answer[last[0] : last[1]]


def _parse_json_output(
    answer: str, output_name: str, *, truncated_at: int | None = None
) -> tuple[Any, str | None]:
    """Extract one named JSON output from an upstream answer.

    Prefers the fenced `````json`` block whose object contains the output
    name, scanning trailing blocks first (an answer with several fences,
    e.g. a verdict block followed by a summary block, binds from whichever
    block carries the port), then the answer's terminal bare JSON object
    (``_terminal_json_object``), then falls back to parsing the whole
    answer. The output-name requirement is the same for every shape: only
    an object that contains the port binds, so widening the accepted
    shapes never widens the contract. Returns ``(value, None)`` or
    ``(None, error_sentence)``. A capture cut at the binding cap
    (``truncated_at``) names the size and the cap in the error, so a
    too-large fenced JSON reads as a size problem, not a missing output.
    """
    candidates: list[str] = list(reversed(_FENCED_JSON_RE.findall(answer)))
    terminal = _terminal_json_object(answer)
    if terminal is not None:
        candidates.append(terminal)
    candidates.append(answer.strip())
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict) and output_name in parsed:
            # A child's JSON output may carry a lone-surrogate escape (a
            # text cut mid-emoji, a Linux file name json.dumps'd by the
            # child): clean it at the decode point (round-10 R10-01) or
            # the binding flows into every downstream spawn request and
            # frame — and the host's parser rejects the frame.
            return _clean_surrogates(parsed[output_name]), None
    error = f"no JSON object containing output {output_name!r} in the upstream answer"
    if truncated_at is not None:
        error += (
            f"; the captured answer is truncated at {truncated_at} characters"
            " - keep the fenced JSON block compact"
        )
    return None, error


def _render_prompt(
    template: str, values: dict[str, str], params: "dict[str, str] | None" = None
) -> str:
    """Render bound input values (and the run's params) into a prompt template.

    Each ``{input_name}`` or ``{param_name}`` placeholder is replaced in a
    single pass (a value that itself looks like a placeholder is never
    re-substituted). Inputs without a placeholder are appended in a
    trailing ``## Inputs`` section, so no bound value is dropped; a param
    without one is simply not used by this prompt.
    """
    combined = {**(params or {}), **values}
    if not combined:
        return template
    pattern = re.compile("|".join(re.escape("{" + name + "}") for name in combined))
    used: set[str] = set()

    def _substitute(match: "re.Match[str]") -> str:
        name = match.group(0)[1:-1]
        used.add(name)
        return combined[name]

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


class _PythonProcess:
    """One python state call: a short-lived isolated subprocess.

    stdout and stderr go to temp files, so a large output never blocks the
    child on a full pipe and the kernel needs no reader task.
    """

    def __init__(self, proc: Any, stdout: IO[bytes], stderr: IO[bytes]) -> None:
        self.proc = proc
        self._stdout = stdout
        self._stderr = stderr

    @classmethod
    async def start(cls, target: dict[str, str], inputs: dict[str, Any]) -> "_PythonProcess":
        import asyncio
        import sys
        import tempfile

        from .bash import _child_env

        env = {key: value for key, value in _child_env().items() if not key.startswith("RLM_")}
        # The session running the machine, for states that act on its behalf
        # (a Discord gate asks from the owner's help thread).
        if os.environ.get("RLM_SESSION_ID"):
            env[FACTORY_OWNER_SESSION_ENV] = os.environ["RLM_SESSION_ID"]
        stdout, stderr = tempfile.TemporaryFile(), tempfile.TemporaryFile()
        try:
            with tempfile.TemporaryFile() as stdin:
                stdin.write(json.dumps(inputs).encode("utf-8"))
                stdin.seek(0)
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, "-I", "-c", PYTHON_RUNNER, target["import"], target["callable"],
                    *([target["path"]] if target.get("path") else []),
                    stdin=stdin, stdout=stdout, stderr=stderr,
                    cwd=os.getcwd(), env=env, start_new_session=True,
                )
        except BaseException:
            stdout.close()
            stderr.close()
            raise
        return cls(proc, stdout, stderr)

    def _kill(self) -> None:
        """Kill the call's whole process group (the process alone on Windows)."""
        if os.name == "posix":
            from .bash import _signal_group

            _signal_group(self.proc.pid, signal.SIGKILL)
        else:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass  # already exited

    async def stop(self) -> None:
        """Kill a running call, wait for it to exit, and release its files."""
        self._kill()
        await self.proc.wait()
        self.finish()

    def finish(self) -> tuple[str, str]:
        """Read stdout and the stderr tail of an exited call, then close both.
        A call lives no longer than its exit: anything it left running in its
        process group is killed."""
        self._kill()
        self._stdout.seek(0)
        stdout = self._stdout.read().decode("utf-8", "replace")
        self._stderr.seek(0, os.SEEK_END)
        self._stderr.seek(max(self._stderr.tell() - PYTHON_STDERR_TAIL_CAP, 0))
        stderr = self._stderr.read().decode("utf-8", "replace").strip()
        self._stdout.close()
        self._stderr.close()
        return stdout, stderr


def _python_outputs(state_spec: dict[str, Any], stdout: str) -> "dict[str, Any] | str":
    """A python call's outputs from its stdout, or the error sentence when
    stdout is not one object whose keys are exactly the declared outputs."""
    try:
        # The python-call decode point cleans too (round-11 probe
        # R11-02): a lone surrogate in a python state's emitted output
        # was re-sent once per remaining retry across boots (the
        # factory.check frame carrying it, rejected by the host every
        # time).
        outputs = _clean_surrogates(json.loads(stdout))
    except ValueError:
        return "python state did not write one JSON object to stdout"
    if not isinstance(outputs, dict):
        return f"python state returned {type(outputs).__name__}, not a dict"
    declared = _declared_port_types(state_spec, "outputs")
    optional = {out.get("name") for out in state_spec.get("outputs") or [] if out.get("optional")}
    if not set(declared) - optional <= set(outputs) <= set(declared):
        return f"python state returned keys {sorted(outputs)} but declares outputs {sorted(declared)}"
    for name, port_type in declared.items():
        if name in outputs and port_type == "text" and not isinstance(outputs[name], str):
            return f"python state output {name!r} is text but the call returned {type(outputs[name]).__name__}"
    return outputs


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
    # deferral counts here too, and charged retries compare against
    # ``attempt - retry_base``, so one transient 429 admission consumes one
    # declared retry.
    retry_base: int = 0  # the attempt count at the last retry-budget reset:
    # an infra respawn or a resume's re-admission grants fresh ``retries``
    # by moving this base instead of zeroing ``attempt`` (spawn labels
    # count on it staying monotonic).
    infra_respawned: bool = False  # the instance's one free worker-death
    # respawn is spent; a resume's re-admission grants a fresh one.
    capture_failed: bool = False  # this settle completed its entry but a
    # declared output never bound; the preserved answer stays provisional
    # until the capture is redone or the entry fails permanently.
    rate_limit_streak: int = 0  # consecutive rate-limited admissions in the
    # control loop's backoff path; a successful spawn resets it, and
    # BACKOFF_MAX_ATTEMPTS in a row fails the node. An admission-phase
    # deferral (run()/resume(), allow_backoff=False) consumes an attempt
    # but never counts toward the backoff episode.
    child_id: str | None = None
    spawned_at: float | None = None
    duration_ms: int | None = None
    answer: str | None = None  # the binding lane's captured answer (ANSWER_BINDING_CAP)
    provisional: bool = False  # the answer came from a child EXIT, not a
    # settle: the state reads needs-verify instead of silently counting the
    # exit's last assistant text as delivered work (the M4 class).
    error: str | None = None
    tool_uses: int = 0
    inputs: dict[str, Any] | None = None  # the bound inputs (plus params); a python
    # call receives them, an emit child gets them from rlm.factory.inputs(), re-runs reuse them
    session_dir: str | None = None  # the child's session dir: its emitted outputs live there
    child_name: str | None = None  # the child's session name (the repair message's receiver)
    repair_sent: bool = False  # the one "you still owe ..." message went to this child;
    # while the instance is running again, the repair turn decides it
    ownership_change_in_progress: bool = False  # an admission or deletion owns the actor slot
    factory_task_activity: str | None = None  # busy, idle, or unverified for factory children
    process: "_PythonProcess | None" = None  # a python state's running call
    deadline: float | None = None  # a python call's time limit (seconds on the injected clock)


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
    needs_verify: bool = False  # a child exit carried a provisional answer
    # (the M4 oversight mark): the entry failed, but the child's last
    # assistant text is preserved as a provisional answer and the run
    # surfaces the state in status()["needs_verify"].


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
    """Executor-side state for one run: kernel memory while the kernel
    lives, one JSON snapshot under ``$RLM_SESSION_DIR/factory-runs``
    across a kernel restart (the loop tasks die with the kernel; the
    registry rehydrates and re-arms; the children, supervisor-owned, run
    straight through)."""

    run_id: str
    spec_id: str
    name: str | None
    # The canonicalized machine this run executes: a stored entry's spec or
    # a library machine's template, kept read-only. The graph snapshot's
    # static structure (states, transitions, run block) reads it, so
    # agents and the TUI see the machine the run validated, and
    # export_machine serializes the exact machine a run is running
    # (byte-pretty, stable formatting).
    machine: "dict[str, Any]" = field(default_factory=dict)
    state: str = "running"  # running | stopping | paused | done | failed | stopped
    started_at: float = 0.0
    max_parallel: int = RUN_MAX_PARALLEL_DEFAULT
    max_transitions: int = 0
    max_children: int = RUN_MAX_CHILDREN_DEFAULT
    max_transitions_reported: bool = False
    max_children_reported: bool = False
    run_budget_ms: int | None = None
    budget_reported: bool = False
    pause_reason: str | None = None
    # The last entry-failure reason (admission or binding): a paused run's
    # status payload carries it with a one-line remedy (the M6 class), so
    # an operator reads WHAT failed from status() instead of archaeology.
    last_error: str | None = None
    states: dict[str, _StateRun] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    transitions_from: dict[str, list[tuple[int, dict[str, Any]]]] = field(default_factory=dict)
    pending_evaluations: list[tuple[str, int, int]] = field(default_factory=list)
    # Joins held on a queued arrival by an evaluation pass that a
    # max_transitions pause interrupted (probe R3B): the holds ride the
    # run so the next pass's drain recheck re-reaches them — the resume's
    # replay of the paused settle starts PAST the join position, so the
    # join itself would otherwise be skipped forever. Runtime-only state:
    # a restart drops it with the process (a snapshot mid-hold loses the
    # defer; the run's own settles re-reach the join on their next fire).
    deferred_join_rechecks: list[tuple[str, int, int]] = field(default_factory=list)
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
    # signature per join, keyed by the transition's canonical index and
    # target, so a join whose sources settle in one collect batch fires
    # once, not once per source settle, re-fires only when a source
    # settles again, keeps ONE key across the source states that share the
    # transition object, and survives the registry snapshot verbatim (an
    # in-memory object id() key would not).
    join_fired: dict[tuple[int, str], frozenset[tuple[str, int]]] = field(default_factory=dict)
    # Watch bookkeeping: bumped on every ledger event (every observable
    # mutation emits one), and every registered watch future resolves with
    # the new revision. ``factory.watch`` compares signatures, so a bump
    # that leaves the run's state/instance shape unchanged just re-arms.
    revision: int = 0
    watchers: list = field(default_factory=list)
    # The event ledger's seq watermark: rehydrated events keep their seqs,
    # so this boot's events number above them (``_event`` numbers from
    # here; the snapshot keeps the trailing window, whose seqs can be high).
    seq_base: int = 0
    # The run budget's paused-time accounting: the total wall time the run
    # has spent paused (waiting for the owner), which the budget excludes
    # (``elapsed = now - started_at - paused_ms``) so an escalate pause
    # does not spend the budget, and the pause in flight's start moment
    # (folded into paused_ms at the resume; rebased with the other clock
    # fields after a host restart).
    paused_ms: float = 0.0
    pause_started_at: float | None = None


_LONE_SURROGATE_RE = re.compile("[\ud800-\udfff]")


def _frame_has_lone_surrogate(value: Any) -> bool:
    """Whether the structure carries a lone surrogate anywhere — a KEY or
    a value (round-11 probe R11-01: the recursive shape skipped dict keys,
    and a lone surrogate in a KEY rode the contract inputs into every
    spawn frame, persisting across boots).

    One json.dumps scan, no Python recursion (round-11 probe R11-03: the
    recursive cleaner blew the interpreter stack on 500-level legal JSON;
    json's own C encoder carries the depth).
    """
    return _LONE_SURROGATE_RE.search(json.dumps(value, ensure_ascii=False)) is not None


def _clean_surrogates(value: Any) -> Any:
    r"""Render lone surrogates in decoded content protocol-safe — a KEY
    or a value (round-11 probe R11-01, fix shape C).

    Python's json decoder accepts a lone ``\udXXX`` escape and returns a
    lone surrogate code point; the kernel's ``_send`` re-encodes it as the
    same escape, and the host's serde_json rejects that frame — "Kernel
    protocol error" for the session. The round-10 shape cleaned values but
    skipped dict KEYS (a lone surrogate in a key rode the contract inputs
    into every spawn frame and persisted across boots), and its recursion
    blew the interpreter stack on deep legal JSON.

    One json.dumps(ensure_ascii=False) scan carries the depth in C and
    surfaces any lone surrogate — key or value — as a raw code point in
    the text. The common case returns the original object untouched. A
    dirty structure round-trips once through the regex: each lone
    surrogate becomes a literal backslash-escape TEXT (json.loads keeps
    it as text — the rendered escape), while valid astral characters are
    single code points and pass untouched.
    """
    text = json.dumps(value, ensure_ascii=False)
    if _LONE_SURROGATE_RE.search(text) is None:
        return value
    return json.loads(
        _LONE_SURROGATE_RE.sub(lambda m: "\\\\u" + f"{ord(m.group()):04x}", text)
    )


def _shown(name: str) -> str:
    """A file name safe to print through the kernel protocol (round-9
    probe R9-01).

    On Linux, an undecodable name byte from os.listdir arrives as a lone
    surrogate (surrogateescape); printing it raw puts the escape into
    the kernel's stderr frame, and the host's serde_json rejects a lone
    surrogate escape — "Kernel protocol error" for every cell of the
    session, every boot, until a human deletes the file. backslashreplace
    turns the byte into printable text; normal names are unchanged.
    """
    return name.encode("utf-8", "backslashreplace").decode("utf-8")


def _runs_dir() -> Path | None:
    """The run registry directory, or ``None`` without a session artifact dir
    or on a daemonless host (a ``--print`` run's children die with its
    process, so its runs are never saved).

    Set-but-empty env values behave as unset (mirrors ``harness._env_dir``).
    """
    if _daemonless_host():
        return None
    value = (os.environ.get("RLM_SESSION_DIR") or "").strip()
    return Path(value).expanduser() / RUNS_DIR_NAME if value else None


PRINT_RUNS_NOT_DURABLE = (
    "--print runs are not durable; run machines under the daemon for restart safety"
)
"""The refusal ``resume`` gives on a daemonless host for a run this kernel did
not start: a ``--print`` session's children live in its own process, so the
runs they served cannot outlive it."""


def _daemonless_host() -> bool:
    """Whether the session runs without a daemon (the host sets
    ``RLM_DAEMONLESS=1`` for ``--print`` sessions)."""
    return os.environ.get("RLM_DAEMONLESS") == "1"


def _transitions_index(machine: dict[str, Any]) -> dict[str, list[tuple[int, dict[str, Any]]]]:
    """Every transition visible from each source state, paired with its
    canonical index: a join (``from`` is a list) is visible from EVERY
    source state's settle evaluation and is ONE transition object — the
    canonical index is the identity the join bookkeeping keys, stable
    across the source states that share it and across the registry
    snapshot; a single-source transition registers once."""
    transitions_from: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for canonical_index, transition in enumerate(machine.get("transitions") or []):
        raw_from = transition["from"]
        sources = raw_from if isinstance(raw_from, list) else [raw_from]
        for source in sources:
            transitions_from.setdefault(source, []).append((canonical_index, transition))
    return transitions_from


def _instance_json(instance: _NodeInstance) -> dict[str, Any]:
    """One instance's persisted fields: everything but ``process`` (a live
    subprocess handle dies with the kernel; the rehydrated run fails such
    a call through its state's retry/policy path)."""
    return {
        "index": instance.index,
        "prompt": instance.prompt,
        "status": instance.status,
        "attempt": instance.attempt,
        "retry_base": instance.retry_base,
        "infra_respawned": instance.infra_respawned,
        "capture_failed": instance.capture_failed,
        "rate_limit_streak": instance.rate_limit_streak,
        "child_id": instance.child_id,
        "spawned_at": instance.spawned_at,
        "duration_ms": instance.duration_ms,
        "answer": instance.answer,
        "provisional": instance.provisional,
        "error": instance.error,
        "tool_uses": instance.tool_uses,
        "inputs": instance.inputs,
        "session_dir": instance.session_dir,
        "child_name": instance.child_name,
        "factory_task_activity": instance.factory_task_activity,
        "repair_sent": instance.repair_sent,
        "deadline": instance.deadline,
    }


def _instance_from_json(data: dict[str, Any]) -> _NodeInstance:
    instance = _NodeInstance(index=data["index"], prompt=data["prompt"])
    for field in (
        "status", "attempt", "retry_base", "infra_respawned", "capture_failed",
        "rate_limit_streak", "child_id", "spawned_at", "duration_ms", "answer",
        "provisional", "error", "tool_uses", "inputs", "session_dir",
        "child_name", "factory_task_activity", "repair_sent", "deadline",
    ):
        setattr(instance, field, data.get(field))
    instance.attempt = data.get("attempt") or 0
    instance.tool_uses = data.get("tool_uses") or 0
    if instance.child_id is not None and instance.status != "running" and instance.factory_task_activity is None:
        instance.factory_task_activity = "unverified"
    return instance


def _entry_json(entry: _StateEntry) -> dict[str, Any]:
    return {
        "index": entry.index,
        "status": entry.status,
        "instances": [_instance_json(instance) for instance in entry.instances],
        "error": entry.error,
        "answer": entry.answer,
        "outputs": entry.outputs,
        "output_errors": entry.output_errors,
        "is_settle": entry.is_settle,
        "consumed": entry.consumed,
        "needs_verify": entry.needs_verify,
    }


def _entry_from_json(data: dict[str, Any]) -> _StateEntry:
    entry = _StateEntry(index=data["index"])
    entry.status = data["status"]
    entry.instances = [_instance_from_json(row) for row in data["instances"]]
    entry.error = data.get("error")
    entry.answer = data.get("answer")
    entry.outputs = data.get("outputs")
    entry.output_errors = data.get("output_errors")
    entry.is_settle = data.get("is_settle", False)
    entry.consumed = data.get("consumed", False)
    entry.needs_verify = data.get("needs_verify", False)
    return entry


def _state_json(state: _StateRun) -> dict[str, Any]:
    return {
        "state_id": state.state_id,
        "spec": state.spec,
        "position": state.position,
        "prompt_template": state.prompt_template,
        "name": state.name,
        "model": state.model,
        "thinking": state.thinking,
        "max_entries": state.max_entries,
        "entries_used": state.entries_used,
        "instance_counter": state.instance_counter,
        "error": state.error,
        "cancelled": state.cancelled,
        "entries": [_entry_json(entry) for entry in state.entries],
    }


def _state_from_json(data: dict[str, Any]) -> _StateRun:
    state = _StateRun(
        state_id=data["state_id"], spec=data["spec"], position=data["position"]
    )
    state.prompt_template = data.get("prompt_template")
    state.name = data.get("name")
    state.model = data.get("model")
    state.thinking = data.get("thinking")
    state.max_entries = data.get("max_entries", STATE_MAX_ENTRIES_DEFAULT)
    state.entries_used = data.get("entries_used", 0)
    state.instance_counter = data.get("instance_counter", 0)
    state.error = data.get("error")
    state.cancelled = data.get("cancelled", False)
    state.entries = [_entry_from_json(row) for row in data["entries"]]
    return state


def rebase_run_clocks(
    run: FactoryRun, clock: "dict[str, float] | None", now: float
) -> None:
    """Rebase one run's stored time fields onto the CURRENT monotonic clock.

    The snapshot's ``clock`` pair records the snapshot moment on both the
    monotonic clock (every stored field lives on it) and the wall clock.
    A stored field's real remaining time is ``field - mono`` minus the
    wall time that walked since the snapshot; on the CURRENT clock that
    reads as ``now + (field - mono) - wall_elapsed``, so every field
    shifts by ``(now - mono) - wall_elapsed``. With no restart the two
    terms cancel and the shift is zero; a host reboot or a cloud-sandbox
    checkpoint restore collapses ``now`` far below ``mono``, and the
    shift maps each deadline onto the new clock with its REAL remaining
    time instead of the old boot's uptime (probe D: the rebooted
    executor waited 11.5 days to reach a pre-reboot backoff deadline).
    A suspend is NOT a restart (round-1 probe D3): on Linux the
    monotonic clock pauses through a suspend while the wall clock walks,
    which produces the same negative drift — but the deadlines still
    sit on the same clock, and shifting them would charge the budget
    the suspend time. Only a RESTART shifts: ``now < mono`` is the
    restart signature (a suspend never rewinds the monotonic clock
    below the snapshot's reading; a reboot or a checkpoint restore
    does).
    A snapshot without the pair predates the field and stays untouched
    (the shift would be a guess without the wall reference).
    """
    if clock is None:
        return
    wall = clock.get("wall")
    mono = clock.get("mono")
    if not _is_number(wall) or not _is_number(mono):
        return
    if now >= mono:
        return  # no restart: the stored fields already sit on this clock
    drift = (now - mono) - max(0.0, time.time() - wall)

    def shift(value: float | None) -> float | None:
        return None if value is None else value + drift

    run.started_at += drift
    run.admission_backoff_until = shift(run.admission_backoff_until)
    run.pause_started_at = shift(run.pause_started_at)
    for state in run.states.values():
        for entry in state.entries:
            for instance in entry.instances:
                instance.spawned_at = shift(instance.spawned_at)
                instance.deadline = shift(instance.deadline)


def _run_json(run: FactoryRun, clock: dict[str, float] | None = None) -> dict[str, Any]:
    """One run's registry snapshot: the full executor-side state minus the
    kernel-bound members (the control-loop task, in-flight watch futures,
    python subprocess handles) and with the event ledger capped to its
    trailing window.

    ``clock`` records the snapshot moment on BOTH clocks — the executor's
    monotonic clock (every stored time field lives on it) and the wall
    clock — so a rehydrate can rebase the fields after a host reboot or a
    cloud-sandbox checkpoint restore restarts the monotonic clock (see
    ``rebase_run_clocks``): without the pair, a rebooted executor reads
    every pre-reboot deadline as far future, waits out the old boot's
    uptime before admitting, and freezes repair waits forever.
    """
    if clock is None:
        clock = {"wall": time.time(), "mono": time.monotonic()}
    return {
        "clock": clock,
        "run_id": run.run_id,
        "spec_id": run.spec_id,
        "name": run.name,
        "machine": run.machine,
        "state": run.state,
        "started_at": run.started_at,
        "max_parallel": run.max_parallel,
        "max_transitions": run.max_transitions,
        "max_children": run.max_children,
        "max_transitions_reported": run.max_transitions_reported,
        "max_children_reported": run.max_children_reported,
        "run_budget_ms": run.run_budget_ms,
        "budget_reported": run.budget_reported,
        "pause_reason": run.pause_reason,
        "last_error": run.last_error,
        "order": run.order,
        "pending_evaluations": [
            [state_id, entry_index, resume_from]
            for state_id, entry_index, resume_from in run.pending_evaluations
        ],
        # The join holds a paused pass stashed on the run (round-3 R3B /
        # round-4 R4-01): a restart inside the pause window must not lose
        # them — the resume's replay starts past the join position, so the
        # stash is the join's only re-entry.
        "deferred_join_rechecks": [
            [state_id, entry_index, position]
            for state_id, entry_index, position in run.deferred_join_rechecks
        ],

        "events": run.events[-PERSISTED_EVENTS_CAP:],
        "milestones": sorted(run.milestones),
        "spawn_count": run.spawn_count,
        "settle_count": run.settle_count,
        "transitions_fired": run.transitions_fired,
        "tool_use_total": run.tool_use_total,
        "loop_generation": run.loop_generation,
        "admission_backoff_until": run.admission_backoff_until,
        "paused_ms": run.paused_ms,
        "pause_started_at": run.pause_started_at,
        "join_fired": {
            f"{key[0]}|{key[1]}": [list(signature) for signature in value]
            for key, value in run.join_fired.items()
        },
        "revision": run.revision,
        "states": {state_id: _state_json(state) for state_id, state in run.states.items()},
    }


def _run_from_json(data: dict[str, Any]) -> FactoryRun:
    run = FactoryRun(
        run_id=data["run_id"],
        spec_id=data["spec_id"],
        name=data.get("name"),
        machine=data["machine"],
    )
    run.state = data.get("state", "running")
    run.started_at = data.get("started_at", 0.0)
    for field in (
        "max_parallel", "max_transitions", "max_children",
        "max_transitions_reported", "max_children_reported",
        "budget_reported", "spawn_count", "settle_count",
        "transitions_fired", "tool_use_total", "loop_generation", "revision",
    ):
        setattr(run, field, data.get(field) or 0)
    # A budget rides verbatim: JSON null is no budget (a 0 default is the
    # canonical machine's own zero, not this loader's).
    run.run_budget_ms = data.get("run_budget_ms")
    run.pause_reason = data.get("pause_reason")
    run.last_error = data.get("last_error")
    run.order = list(data.get("order") or [])
    run.pending_evaluations = [
        (row[0], row[1], row[2]) for row in data.get("pending_evaluations") or []
    ]
    run.deferred_join_rechecks = [
        (row[0], row[1], row[2]) for row in data.get("deferred_join_rechecks") or []
    ]
    run.events = list(data.get("events") or [])
    run.milestones = set(data.get("milestones") or [])
    run.admission_backoff_until = data.get("admission_backoff_until")
    run.paused_ms = float(data.get("paused_ms") or 0.0)
    run.pause_started_at = data.get("pause_started_at")
    if not _is_number(run.pause_started_at):
        run.pause_started_at = None
    run.join_fired = {}
    for key, value in (data.get("join_fired") or {}).items():
        canonical_index, target = key.split("|")
        run.join_fired[(int(canonical_index), target)] = frozenset(
            (source_id, entry_index) for source_id, entry_index in value
        )
    run.states = {
        state_id: _state_from_json(row) for state_id, row in (data.get("states") or {}).items()
    }
    return run


class FactoryExecutor:
    """Runs canonicalized state-machine factories through the existing RLM supervisor.

    Ownership split: the supervisor owns the children (admission via
    ``rlm.spawn``, settlement via ``rlm.collect``, cancellation via
    ``rlm.delete_subagent``); this executor owns the run state in kernel
    memory, snapshotted to the session artifact dir
    (``$RLM_SESSION_DIR/factory-runs/<run id>.json``, atomic writes at
    the control loop's consistent points) with
    a mutation journal for the batches and admissions between snapshots,
    so a kernel restart loses only the control-loop tasks: the registry
    rehydrates on the next factory use and the runs continue. Every host
    call resolves through the module-level ``rlm`` functions and
    ``host_request`` at call time, so tests can patch
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

    A kernel restart does not orphan the runs: the registry rehydrates,
    a run that was stopping finishes its cancellations, a running run
    restarts its control loop (children kept running under the
    supervisor, and a finished child's emitted outputs are read from its
    session dir, never from kernel memory), and a python call the restart
    orphaned fails through its state's retry/policy path.
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
        # Run ids whose snapshots this executor loaded off disk: the
        # boot-once arming queue (each id is armed exactly once per boot).
        self._rehydrated: set[str] = set()
        # (run id, writer) pairs whose write already failed once: a dead
        # disk must not wedge the loop with a ledger row per event, and a
        # writer that recovers clears its own mark.
        self._persist_failed: set[tuple[str, str]] = set()
        # Run id -> the run revision the last write persisted.
        self._persist_marks: dict[str, int] = {}
        # Run ids the unscoped graph's per-run guard already reported this
        # boot (round-9 probe R9-03): the TUI polls every 2 seconds, and
        # a line per poll filled the kernel's background buffer with one
        # repeated line in minutes. Once per run per boot is the contract.
        self._graph_guard_reported: set[str] = set()

    # -- registry persistence -----------------------------------------------

    def _persist_run(self, run: FactoryRun) -> None:
        """Snapshot one run to the session artifact dir (atomic write) when it
        changed since the last write; a finished run retires its files instead.

        Callers persist only at consistent points: the control loop's
        iteration boundary (before it waits on its children), a fired
        transition, the loop's exit, and the run/stop/arm entry points. A
        snapshot therefore never holds a half-applied settle; the mutations
        made inside one iteration replay from the journal (prepared batches,
        admissions) or re-derive (a settle re-collects a child that stayed
        settled under the supervisor). A terminal run (done, failed,
        stopped) that owns no live actor retires the snapshot and the
        journal: the registry keeps the run in memory for this boot, and a
        restart forgets it, so the durable archive holds only runs that can
        still act. A terminal run with a live resident or in-flight child
        keeps its snapshot, so ``stop`` still finds it after a restart.
        Best-effort, exactly once per run and writer when it fails: the run
        keeps running (the registry's memory copy is the truth the loop
        reads); the durability loss is a ledger row, never a wedge.
        """
        directory = _runs_dir()
        if directory is None:
            return  # no session artifact dir, or a daemonless host: memory only
        if self._persist_marks.get(run.run_id) == run.revision:
            return  # nothing changed since the last write
        if run.state in TERMINAL_RUN_STATES and not self._has_unresolved_actor(run):
            self._persist_marks[run.run_id] = run.revision
            self._retire_run_files(run, directory)
            return
        staging = directory / f".{run.run_id}.json.tmp"
        try:
            payload = _run_json(run, {"wall": time.time(), "mono": self._now_fn()})
            os.makedirs(directory, exist_ok=True)
            with open(staging, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            os.replace(staging, directory / f"{run.run_id}.json")
            self._persist_marks[run.run_id] = run.revision
            self._persist_failed.discard((run.run_id, "snapshot"))
            # A recovered write clears any stale persist-failed marker.
            try:
                (directory / f"{run.run_id}.persist-failed").unlink(missing_ok=True)
            except OSError:
                pass
            # The snapshot absorbed every journal line written before it;
            # the journal restarts empty for the mutations still to come.
            journal = directory / f"{run.run_id}{ADMISSIONS_JOURNAL_SUFFIX}"
            with open(journal, "w", encoding="utf-8"):
                pass
        except (OSError, TypeError) as error:
            # TypeError: a snapshot field json.dump cannot serialize
            # (round-4 belt note) — the same durability loss as a disk
            # error, not a crash through the persist path. The staging
            # file never litters: an unlinked .tmp would be invisible to
            # the dot-file-skipping rehydrate and hide the failure. The
            # cleanup is itself guarded: the fault being handled may BE
            # the staging path (a directory or a permission wall), and
            # unlink would just raise again through the failure path.
            try:
                staging.unlink(missing_ok=True)
            except OSError:
                pass
            if (run.run_id, "snapshot") in self._persist_failed:
                return
            self._persist_failed.add((run.run_id, "snapshot"))
            # One DURABLE marker, exactly once per run and writer
            # (round-4 probe R4-04): the in-memory row warns "a kernel
            # restart would lose it" and is itself lost to the restart it
            # warns about — the marker survives it and names the loss.
            try:
                marker = directory / f"{run.run_id}.persist-failed"
                marker.write_text(
                    f"the run registry snapshot could not be written: {error}\n",
                    encoding="utf-8",
                )
            except OSError:
                pass  # the disk that lost the snapshot loses the marker too
            # One direct ledger row, NOT via _event: this row must not
            # re-enter the persist path that just failed.
            run.events.append(
                {
                    "seq": run.seq_base + len(run.events) + 1,
                    "kind": "persist_failed",
                    "stage": "recorded",
                    "detail": f"the run registry snapshot could not be written; the run keeps running but a kernel restart would lose it: {error}",
                }
            )
            run.revision += 1

    def _retire_run_files(self, run: FactoryRun, directory: Path) -> None:
        """Retire a terminal run's snapshot and journal, and tombstone it.

        The tombstone (round-4 probe R4-03) is one append-only line in
        ``retired.jsonl``: after ANY restart, ``status`` answers a
        tombstoned run's id with the record instead of ``unknown factory
        run`` — an owner can tell a by-design retirement (the state, the
        end time, the reason) from a lost registry. Without it, the two
        are indistinguishable on disk (the incident that steered a false
        "Part B failed" verdict).
        """
        try:
            tombstone = {
                "run_id": run.run_id,
                "spec_id": run.spec_id,
                "name": run.name,
                "state": run.state,
                "ended_at": time.time(),
                "pause_reason": run.pause_reason,
                "last_error": run.last_error,
            }
            # The ledger compacts to its read window (round-5 probe
            # R5-02): append-only growth read whole on every status miss
            # would cost unbounded memory and time, and records silently
            # answer 'unknown' past the window anyway — the file itself
            # keeps only the trailing RETIRED_RUNS_READ_LIMIT lines, so
            # the durable post-mortem matches the readable one.
            # The prior-ledger read and the rewrite are FAULT-TOLERANT
            # (round-6 findings): the read decodes with replacement — one
            # invalid byte must never crash the retire path
            # (UnicodeDecodeError is a ValueError, not an OSError, and a
            # crash here kills the loop task AFTER the snapshot unlink:
            # the run would leave NO durable trace at all) — and the
            # rewrite lands through a staging file + os.replace, atomic
            # like the snapshot path: an in-place truncate+write would
            # wipe every prior tombstone on a mid-write fault.
            ledger_path = directory / RETIRED_RUNS_FILE
            staging_path = directory / f".{RETIRED_RUNS_FILE}.tmp"
            prior: list[str] = []
            try:
                prior = [
                    line
                    for line in ledger_path.read_text(encoding="utf-8", errors="replace").splitlines()
                    if line.strip()
                ][-max(0, RETIRED_RUNS_READ_LIMIT - 1):]
            except OSError:
                pass  # no ledger yet: this append starts it
            with open(staging_path, "w", encoding="utf-8") as handle:
                for line in prior:
                    handle.write(line + "\n")
                handle.write(json.dumps(tombstone) + "\n")
            os.replace(staging_path, ledger_path)
        except OSError:
            pass  # the tombstone is best-effort, like every retire step

        for path in (
            directory / f"{run.run_id}.json",
            directory / f"{run.run_id}{ADMISSIONS_JOURNAL_SUFFIX}",
            directory / f"{run.run_id}.persist-failed",
        ):
            try:
                os.unlink(path)
            except OSError:
                pass  # already gone, or never written: nothing to retire

    def _retired_record(self, run_id: str) -> dict[str, Any] | None:
        """The tombstone ledger's record for a run id, or None.

        ``status`` answers this record for a run the live registry does
        not hold when an earlier boot retired it (round-4 R4-03). The
        scan is bounded (the trailing ``RETIRED_RUNS_READ_LIMIT`` lines)
        and read-only.
        """
        directory = _runs_dir()
        if directory is None:
            return None
        try:
            # errors="replace" (round-6): an invalid byte in the ledger
            # must skip its line like any other corrupt row, not raise the
            # raw decode error through the status surface.
            lines = (directory / RETIRED_RUNS_FILE).read_text(
                encoding="utf-8", errors="replace"
            ).splitlines()
        except OSError:
            return None
        record = None
        for line in lines[-RETIRED_RUNS_READ_LIMIT:]:
            try:
                # The ledger's decode point cleans too (round-11 probe
                # R11-02): a lone surrogate in a tombstone's name or
                # reason returned through status — a model print of it
                # was rejected by the host on the real kernel.
                row = _clean_surrogates(json.loads(line))
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            if row.get("run_id") == run_id:
                # The LAST match wins (round-5 probe R5-03): a terminal
                # transition can tombstone twice (done -> stop() re-tombs
                # as stopped); the trailing record is the run's final
                # truth, and the post-restart answer must match the
                # in-boot one.
                record = row
        if record is not None:
            row = record
            return {
                    "run_id": run_id,
                    "spec_id": row.get("spec_id"),
                    "name": row.get("name"),
                    "state": row.get("state"),
                    "retired": True,
                    "ended_at": row.get("ended_at"),
                    "pause_reason": row.get("pause_reason"),
                    "last_error": row.get("last_error"),
                    "events": [],
                    "states": [],
                }
        return None

    def _journal_line(self, run: FactoryRun, line: dict[str, Any]) -> None:
        """Append one mutation line to the run's journal.

        The line is the mutation the snapshot may not carry yet (the
        throttle window): a prepared instance batch or an admitted child
        must never exist only in kernel memory, or a restart loses pending
        siblings or orphans the child under the supervisor. One small line
        per mutation, O(1) whatever the machine's size.
        """
        directory = _runs_dir()
        if directory is None:
            return
        try:
            os.makedirs(directory, exist_ok=True)
            with open(
                directory / f"{run.run_id}{ADMISSIONS_JOURNAL_SUFFIX}", "a", encoding="utf-8"
            ) as handle:
                handle.write(json.dumps(line) + "\n")
        except OSError as error:
            if (run.run_id, "journal") in self._persist_failed:
                return
            self._persist_failed.add((run.run_id, "journal"))
            # One direct ledger row, NOT via _event: this row must not
            # re-enter the persist path that just failed.
            run.events.append(
                {
                    "seq": run.seq_base + len(run.events) + 1,
                    "kind": "persist_failed",
                    "stage": "recorded",
                    "detail": f"the run's mutation journal could not be written; the run keeps running but a kernel restart would lose its un-snapshotted mutations: {error}",
                }
            )
            run.revision += 1

    def _journal_batch(
        self, run: FactoryRun, state: "_StateRun", entry: "_StateEntry"
    ) -> None:
        """Journal an entry's prepared instance batch (the prompt, inputs,
        and pending status of every instance the prepare bound)."""
        self._journal_line(
            run,
            {
                "kind": "batch",
                "state": state.state_id,
                "entries_used": state.entries_used,
                "entry": entry.index,
                "entry_status": entry.status,
                "instances": [_instance_json(instance) for instance in entry.instances],
            },
        )

    def _journal_admission(
        self, run: FactoryRun, state: "_StateRun", entry: "_StateEntry", instance: "_NodeInstance"
    ) -> None:
        """Journal one admitted child: its child_id must be durable the
        moment the spawn handle lands."""
        self._journal_line(
            run,
            {
                "kind": "admission",
                "state": state.state_id,
                "entries_used": state.entries_used,
                "entry": entry.index,
                "entry_status": entry.status,
                "instance": _instance_json(instance),
            },
        )

    def rehydrate_registry(self) -> None:
        """Load the run registry off the session artifact dir (kernel boot).

        The snapshots this kernel's predecessors wrote are the registry:
        ``run_id`` keys, ``FactoryRun`` values, with each run's admissions
        journal adopted on top (the admissions a throttle window kept out
        of the snapshot). An unreadable snapshot is skipped loudly (its
        children stay visible on the supervisor lane); the rest of the
        registry never depends on it.
        """
        import sys

        directory = _runs_dir()
        if directory is None:
            return
        try:
            names = sorted(os.listdir(directory))
        except FileNotFoundError:
            return  # nothing persisted yet: a fresh session's first boot
        except OSError as error:
            # A runs dir that EXISTS but cannot be listed (round-9 probe
            # R9-08: a permission change, an I/O error, checksummed
            # metadata damage) read as "no runs" with no line — every run
            # lost for the boot, nothing said so. The line names it.
            import sys

            print(
                f"the factory runs directory could not be read; every persisted "
                f"run is lost for this boot (its children stay visible under the "
                f"supervisor): {error}",
                file=sys.stderr,
            )
            return
        for name in names:
            if not name.endswith(".json") or name.startswith("."):
                continue
            try:
                with open(directory / name, encoding="utf-8") as handle:
                    payload = _clean_surrogates(json.load(handle))
                run = _run_from_json(payload)
                # The registry is keyed by FILE NAME (round-8 probes
                # R8-02/R8-04): the writer always names a snapshot
                # <run_id>.json, so a payload id that disagrees with the
                # file stem is a stray copy (an operator backup left in
                # the live runs dir — it would silently REPLACE the live
                # run) or a hand edit. Refusing it also keeps an
                # unhashable payload id from raising at the registry
                # insert below, outside every recovery unit.
                if run.run_id != name[: -len(".json")]:
                    raise ValueError(
                        f"payload run_id {run.run_id!r} is not the file stem {name!r}"
                    )
            except Exception as error:  # noqa: BLE001 - a corrupt input
                # file at a disk boundary: the run is skipped loudly, and
                # the registry never depends on it. The tuple would have
                # to enumerate every exception a malformed machine,
                # journal, or clock pair can raise (round-3 probe R3D:
                # a non-dict journal line slipped past ValueError/
                # KeyError/TypeError as AttributeError and killed the arm).
                print(
                    f"factory run snapshot {_shown(name)} is unreadable; the run is not "
                    f"rehydrated (its children stay visible under the supervisor): {error}",
                    file=sys.stderr,
                )
                continue
            # A stale .persist-failed marker names a snapshot this boot's
            # predecessor could not write (round-5 probe R5-01: the r4
            # marker was write-only — after a restart the model's status
            # read clean while the loss rode a file only a human ls saw).
            # The read is FAULT-TOLERANT (round-7 probe R7-01): the marker
            # exists precisely BECAUSE this disk already failed once, and a
            # strict-UTF-8 read raised UnicodeDecodeError (a ValueError)
            # PAST the recovery units — killing the whole rehydrate mid-
            # loop, with the corrupt run AND every later run silently
            # never loading and the boot arm arming nothing. errors=
            # 'replace' costs the corrupt byte its own line; the belt
            # (r6 A4) prints the marker's EXISTENCE even when its text
            # cannot be read at all (chmod 000 says so instead of
            # silence).
            marker_path = directory / f"{run.run_id}.persist-failed"
            try:
                # The stat AND the read sit inside the try (round-8 probe
                # R8-02): on the repo floor (3.11), Path.exists() re-raises
                # every OSError outside its ENOENT/ENOTDIR/EBADF/ELOOP set
                # — a metadata read error on exactly the marker's inode
                # (EIO, or a checksumming filesystem's EBADMSG) escaped
                # the loop one line above the r7 read fix, with the same
                # whole-boot blast. (OSError, ValueError) routes stat
                # faults and any decode shape to the belt line.
                if marker_path.exists():
                    marker_text = marker_path.read_text(
                        encoding="utf-8", errors="replace"
                    ).strip()
                else:
                    marker_text = None
            except (OSError, ValueError):
                marker_text = "(the marker's text is unreadable)"
            if marker_text is not None:
                print(
                    f"factory run {_shown(name)}: a previous kernel could not persist "
                    f"its registry snapshot — {marker_text or '(the marker is empty)'}",
                    file=sys.stderr,
                )
            # The whole post-parse load is one recovery unit (round-2
            # probe Q5): one corrupt journal line inside _adopt_mutations
            # (or a malformed machine in _transitions_index) used to
            # kill the WHOLE boot arm — every later run never loaded and
            # the loaded ones stayed frozen with no loop and no log. One
            # run's corruption now costs that run alone, loudly.
            try:
                # The machine's shape is internally consistent (round-8
                # probe R8-01): a snapshot whose JSON stays VALID but whose
                # fields disagree (a bit flip inside an identifier —
                # order ["b"] -> ["c"] — or a hand edit that renames a
                # state in one place) loads with no skip line and then
                # raises a raw KeyError inside the arm loop and the
                # unscoped graph, breaking EVERY shared surface for the
                # whole boot. The check refuses it HERE, at the same
                # recovery unit, loudly, costing that run alone.
                if set(run.order) != set(run.states):
                    raise ValueError(
                        f"order {run.order} disagrees with the states "
                        f"{sorted(run.states)}"
                    )
                run.transitions_from = _transitions_index(run.machine)
                # Every stored time field rides the executor's monotonic
                # clock, which a host reboot or a cloud-sandbox checkpoint
                # restore restarts: rebase the fields onto THIS boot's
                # clock before any budget, backoff, or repair wait reads
                # them.
                rebase_run_clocks(run, payload.get("clock"), self._now_fn())
                # The trailing event window keeps its seqs; this boot
                # numbers its events above them so the ledger never reuses
                # a seq.
                run.seq_base = max((event.get("seq") or 0) for event in run.events) if run.events else 0
                self._adopt_mutations(run, directory)
            except Exception as error:  # noqa: BLE001 - the same disk boundary
                print(
                    f"factory run snapshot {_shown(name)} is unreadable; the run is not "
                    f"rehydrated (its children stay visible under the supervisor): {error}",
                    file=sys.stderr,
                )
                continue
            self._runs[run.run_id] = run
            self._rehydrated.add(run.run_id)
        # A marker whose snapshot is ABSENT names the run's FIRST write
        # (round-8 probe R8-03): the marker exists because the snapshot
        # does not, so no snapshot walk ever surfaces it — the run is
        # lost entirely (its children run on under the supervisor with no
        # owner), and the marker was read only by a human ls. One line
        # at the end of the load names every such loss.
        for marker_name in names:
            if not marker_name.endswith(".persist-failed"):
                continue
            if marker_name.startswith("."):
                continue  # a hidden stray: nothing the writer names
            stem = marker_name[: -len(".persist-failed")]
            try:
                # The stat sits inside its own try (round-9 probe R9-02):
                # this scan runs OUTSIDE every recovery unit, and a stat
                # fault here (EIO/EBADMSG on a disk that already failed
                # for this run, ESTALE, EACCES through a symlink) killed
                # the rehydrate AFTER the registry loaded — the executor
                # was already assigned, so the boot arm caught it, armed
                # NOTHING, and the first lazy call raised the raw OSError.
                if (directory / f"{stem}.json").exists():
                    continue  # the run loaded; its marker line printed above
            except OSError:
                continue  # the run's own skip line already named its snapshot
            # A run the retired ledger holds is not LOST (round-9 probe
            # R9-05): its marker unlink failed (a crash between the
            # retire's unlinks, or a directory at the marker path), and
            # status answers its tombstone — the loss line would call a
            # finished run lost, every boot, forever.
            if self._retired_record(stem) is not None:
                continue
            print(
                f"factory run {_shown(stem)}: a previous kernel could not write its first "
                f"registry snapshot; the run is lost (its children stay visible "
                f"under the supervisor; remove {_shown(marker_name)} "
                f"to acknowledge the loss)",
                file=sys.stderr,
            )

    def _adopt_mutations(self, run: FactoryRun, directory: Path) -> None:
        """Replay the journal lines the snapshot never absorbed.

        Batches replay in order (an entry's prepared instances append by
        their per-state index — a state-unique counter, so the lookup is
        by index attribute, never by list position: a re-entered state's
        second entry carries its instance at position 0); the LAST
        admission per instance wins (a retry's new child, not the
        attempt that failed) and applies only where the snapshot's
        instance is missing or still childless — a snapshot that already
        carries the mutation, or one whose entry went terminal past it, is
        fresher than the journal and stands.
        """
        try:
            journal = (directory / f"{run.run_id}{ADMISSIONS_JOURNAL_SUFFIX}").read_text(
                encoding="utf-8"
            )
        except OSError:
            return  # no journal: the snapshot is the whole truth
        batches: list[dict[str, Any]] = []
        admissions: dict[tuple[str, int, int], dict[str, Any]] = {}
        for line in journal.splitlines():
            if not line.strip():
                continue
            try:
                # The replay decode point cleans (round-11 R11-02 /
                # round-12 R12-01): this loop re-decodes the journal the
                # intent reader cleaned — a lone surrogate in a replayed
                # batch's content flowed into the rehydrated run and the
                # boot arm's first act was the poisoned rlm.run frame,
                # every boot (a mid-spawn SIGKILL leaves the journal the
                # only record).
                row = _clean_surrogates(json.loads(line))
                instance = row["instance"] if row.get("kind") == "admission" else None
            except (ValueError, KeyError, TypeError, AttributeError):
                continue  # a torn tail line: the mutations before it stand
            if row.get("kind") == "batch":
                batches.append(row)
            elif instance is not None:
                admissions[(row["state"], row["entry"], instance["index"])] = row
        for row in batches:
            state = run.states.get(row.get("state"))
            if state is None:
                continue
            entry = self._entry_at(state, row.get("entry"))
            if entry is None or entry.status in TERMINAL_ENTRY_STATUSES:
                continue  # the snapshot moved past this batch
            for data in row.get("instances") or []:
                if self._instance_at(entry, data.get("index")) is None:
                    entry.instances.append(_instance_from_json(data))
            self._state_counters_from_lines(run, state, entry, row)
        for (_, entry_index, _), row in admissions.items():
            state = run.states.get(row.get("state"))
            if state is None:
                continue
            entry = self._entry_at(state, entry_index)
            if entry is None or entry.status in TERMINAL_ENTRY_STATUSES:
                continue  # the snapshot moved past this admission
            data = row["instance"]
            instance = self._instance_at(entry, data.get("index"))
            if instance is None:
                instance = _instance_from_json(data)
                entry.instances.append(instance)
            elif instance.child_id is not None or instance.status != "pending":
                # The snapshot's instance carries an EARLIER state of the
                # same attempt. The journal is TRUNCATED at every snapshot
                # write, so each surviving line is NEWER than the snapshot:
                # a retry's admission line (at or above the snapshot's
                # attempt — `_admit` increments the attempt BEFORE the
                # spawn, so a snapshot taken mid-spawn already carries the
                # new attempt without the child) replaces the failed
                # attempt's child (probe E — the orphaned retry: the old
                # attempt's child was adopted and the retry ran on with no
                # owner). A line BELOW the snapshot's attempt predates it:
                # skip it.
                line_attempt = data.get("attempt") or 0
                if not (_is_int(line_attempt) and line_attempt >= instance.attempt):
                    continue  # the snapshot already carries this admission
            entry.instances[entry.instances.index(instance)] = _instance_from_json(data)
            self._state_counters_from_lines(run, state, entry, row)

    async def _resolve_admission_intents(self, run: FactoryRun) -> None:
        """Resolve mid-spawn kernel deaths (probe F): an ``admitting`` intent
        line whose admission never landed named a child the supervisor
        created while the kernel died before the reply. Delete that child
        so the re-admission does not collide with its name (the collision
        paused the run) and it does not run on with no owner. The
        snapshot's instance stays at the old attempt — the loop's own
        re-admission is the clean retry.
        """
        from . import delete_subagent, list_subagents

        intents: dict[tuple[Any, Any, Any, Any], str] = {}
        for line in self._journal_lines(run):
            kind = line.get("kind")
            if kind == "admitting":
                key = (line.get("state"), line.get("entry"), line.get("index"), line.get("attempt"))
                intents[key] = line.get("label") or ""
            elif kind == "admission":
                # The admission line carries the instance's index and
                # attempt inside ``instance`` (the shape `_journal_admission`
                # writes): the intent is spent when the instance the spawn
                # created was admitted — reading the fields from the top
                # level (where the INTENT carries them) would never match
                # and every arm would resolve a LIVE admission as an
                # unresolved intent and delete its child.
                instance = line.get("instance") or {}
                key = (
                    line.get("state"),
                    line.get("entry"),
                    instance.get("index"),
                    instance.get("attempt"),
                )
                intents.pop(key, None)  # the admission landed; the intent is spent
        labels = {label for label in intents.values() if label}
        if not labels:
            return
        try:
            roster = await list_subagents()
        except Exception:
            return  # an unreachable roster: the loop's own retry surfaces it
        for row in roster:
            name = getattr(row, "session_name", None) or ""
            child_id = getattr(row, "rlm_child_id", None) or ""
            if name not in labels:
                continue
            try:
                await delete_subagent(child_id)
                self._event(
                    run,
                    "orphan_reclaimed",
                    child=child_id,
                    detail=f"deleted the child a mid-spawn kernel death orphaned (label {name!r})",
                )
            except Exception:
                pass  # already gone, or the supervisor refuses: the re-admission's name error names it

    def _journal_lines(self, run: FactoryRun) -> "list[dict[str, Any]]":
        """The run's journal lines, parsed and skipped-tail tolerant."""
        directory = _runs_dir()
        if directory is None:
            return []
        try:
            journal = (directory / f"{run.run_id}{ADMISSIONS_JOURNAL_SUFFIX}").read_text(
                encoding="utf-8"
            )
        except OSError:
            return []
        lines = []
        for line in journal.splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            # A line that is valid JSON but NOT an object (round-4 probe
            # R4-02: `12345`, `[1,2]`) would parse fine and kill the ARM
            # door's consumer — _resolve_admission_intents' line.get
            # raises AttributeError, freezing every rehydrated run and
            # hard-failing every later factory call. The corrupt line
            # costs its own skip, like every other reader of this journal.
            if not isinstance(row, dict):
                continue
            lines.append(_clean_surrogates(row))
        return lines

    def _entry_at(self, state: "_StateRun", index: Any) -> "_StateEntry | None":
        """The state's entry at a journal line's index: entries append
        positionally (the index IS the position), so a line for an entry
        the snapshot predates materializes it."""
        if not _is_int(index) or index < 0:
            return None
        while len(state.entries) <= index:
            state.entries.append(_StateEntry(index=len(state.entries)))
        return state.entries[index]

    @staticmethod
    def _instance_at(entry: "_StateEntry", index: Any) -> "_NodeInstance | None":
        """The entry's instance carrying a per-state index (indexes are
        state-unique, not positions: locate by attribute)."""
        if not _is_int(index):
            return None
        return next((i for i in entry.instances if i.index == index), None)

    @staticmethod
    def _state_counters_from_lines(
        run: FactoryRun, state: "_StateRun", entry: "_StateEntry", row: dict[str, Any]
    ) -> None:
        """Carry a journal line's bookkeeping onto the rehydrated state: the
        entry's status at the mutation, the state's entries_used, and the
        instance counter (an adopted index must never be reused — a reused
        index collides the spawn label with a still-registered child)."""
        if entry.status == "pending" and row.get("entry_status"):
            entry.status = row["entry_status"]
        state.entries_used = max(state.entries_used, int(row.get("entries_used") or 0))
        state.instance_counter = max(
            state.instance_counter,
            max((i.index for i in entry.instances), default=0) + 1,
        )
        run.revision += 1

    async def arm_persisted_runs(self) -> None:
        """Re-arm the runs a previous kernel left behind (idempotent).

        A kernel restart lost this executor's control-loop tasks; the
        rehydrated registry keeps the runs and their child membership.
        The first factory use after the restart completes the interrupted
        flows, then this boot's loops own the runs from here on: a run
        that was stopping finishes its cancellations, a running run
        restarts its control loop (the children kept running under the
        supervisor; a finished child's emitted outputs are read from its
        session dir), and a python call the restart orphaned fails through
        its state's retry/policy path. The queue drains once per boot; the
        iterations walk copies so an awaited failure policy mutating an
        entry mid-pass cannot corrupt the walk.
        """
        while self._rehydrated:
            run_id = self._rehydrated.pop()
            run = self._runs.get(run_id)
            if run is None:
                continue  # a concurrent arm of this boot already took it
            # Per-run isolation (round-8 probe R8-01): a corrupt durable
            # input that loaded without raising (a wrong-but-valid shape
            # the load-time checks missed) must cost ITS run one loud
            # line, never the shared loop — an escape here froze every
            # run popped after it and killed the boot arm arming nothing.
            try:
                await self._resolve_admission_intents(run)
                if run.state == "stopping":
                    await self._complete_stop(run, "stopped; rehydrated after a kernel restart")
                    self._persist_run(run)
                    continue
                for state_id in list(run.order):
                    state = run.states[state_id]
                    python_state = "python" in state.spec
                    for entry in list(state.entries):
                        for instance in list(entry.instances):
                            if instance.status != "running" or instance.child_id is not None:
                                continue  # an admitted child re-collects
                            if python_state:
                                await self._apply_instance_failure(
                                    run, state, entry, instance, RUN_LOST_PYTHON_CALL, retry=True
                                )
                if run.state == "running":
                    self._start_loop(run)
                self._persist_run(run)
            except Exception as error:  # noqa: BLE001 - the last shared loop
                import sys

                # The frozen run keeps its child on the supervisor and
                # reads "running" with no loop (round-9 probe R9-06):
                # once the single stderr line has scrolled away, nothing
                # tells the model the run is frozen. One ledger row keeps
                # the failure visible in status() forever.
                run.events.append(
                    {
                        "seq": run.seq_base + len(run.events) + 1,
                        "kind": "executor_error",
                        "stage": "recorded",
                        # The `error` key matches the control loop's three
                        # other executor_error rows (round-10 probe R10-05):
                        # the lane and the status surface read one shape.
                        "error": f"the run could not be re-armed after a kernel "
                        f"restart (its children stay visible under the "
                        f"supervisor): {error}",
                    }
                )
                run.revision += 1
                print(
                    f"factory run {run_id} could not be re-armed after a kernel "
                    f"restart (its children stay visible under the supervisor): {error}",
                    file=sys.stderr,
                )

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
        await _check_limits(spec)
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
        await _check_limits(machine.spec)
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
        self._persist_run(run)
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
        run = self._runs.get(run_id)
        if run is None:
            # A run this kernel never hosted may be a TOMBSTONED terminal
            # run of an earlier boot (round-4 probe R4-03): status answers
            # the retirement record instead of pretending the run never
            # existed — an owner must tell by-design retirement from a
            # lost registry.
            retired = self._retired_record(run_id)
            if retired is not None:
                return retired
            raise ValueError(f"unknown factory run {run_id!r}")
        nodes = [self._state_report(run.states[state_id]) for state_id in run.order]
        for event in run.events:
            if event["stage"] in ("recorded", "arrived"):
                event["stage"] = "delivered"
        payload: dict[str, Any] = {
            "run_id": run.run_id,
            "spec_id": run.spec_id,
            "name": run.name,
            "state": run.state,
            "nodes": nodes,
            "events": [dict(event) for event in run.events[-EVENT_WINDOW:]],
            # The budget's clock: wall time minus paused time (and an open
            # pause), so the number the operator reads is the same one
            # the budget charges (round-1 probe B2: a 2h pause read as a
            # blown 60s budget's worth of elapsed).
            "elapsed_ms": int(self._run_budget_active_ms(run)),
            "usage": self._usage_report(run),
        }
        # The M4 oversight signal: every state whose latest terminal entry
        # carried a provisional answer (a child exit, or a settle whose
        # declared output never bound) needs verification — root-visible
        # without ledger archaeology.
        needs_verify = [
            state_id
            for state_id in run.order
            if any(entry.needs_verify for entry in run.states[state_id].entries)
        ]
        if needs_verify:
            payload["needs_verify"] = needs_verify
        # A paused run carries the LAST failed admission/bind error and a
        # one-line remedy (the M6 class), so the operator reads WHAT failed
        # and what to do next from status() alone.
        if run.state == "paused":
            payload["pause_reason"] = run.pause_reason
            if run.last_error is not None:
                payload["last_error"] = run.last_error
                payload["remedy"] = (
                    f"resume with await rlm.factory.resume('{run.run_id}') to re-admit the "
                    "failed state's entry as a fresh attempt (same rendered prompt, no extra "
                    "max_entries); author the state with failure_policy 'continue' to run its "
                    "dependents past a failure instead"
                )
        return payload

    async def stop(self, run_id: str) -> dict[str, Any]:
        """Cancel the run's live children, reporting stopped only after deletion succeeds."""
        run = self._require_run(run_id)
        if run.state == "stopped":
            return {"run_id": run.run_id, "state": run.state, "cancelled": []}
        if run.state == "stopping" and any(
            instance.ownership_change_in_progress
            for state in run.states.values()
            for entry in state.entries
            for instance in entry.instances
        ):
            return {"run_id": run.run_id, "state": run.state, "cancelled": []}
        if run.state != "stopping":
            run.state = "stopping"
            self._touch(run)
            self._persist_run(run)
        stopped = await self._complete_stop(run, "stopped")
        self._persist_run(run)
        return {"run_id": run.run_id, "state": run.state, "cancelled": stopped}

    async def resume(self, run_id: str) -> dict[str, Any]:
        """Resume a paused run (escalate, budget, or max_transitions pause).

        An escalate pause holds its failed entry unsettled, so resume
        re-admits that entry first: a fresh attempt of the same rendered
        prompt in the same entry slot -- no extra ``max_entries`` spend,
        fresh ``retries``. The failure only ever propagates to dependents
        under ``failure_policy: "continue"``. A budget or max_transitions
        pause is reported once per run: resuming after it is an explicit
        operator decision and no further budget pauses fire. Raises
        ``ValueError`` when the run is not paused, and on a daemonless
        (``--print``) host for any run this kernel did not start.
        """
        if _daemonless_host() and run_id not in self._runs:
            raise ValueError(
                f"factory run {run_id!r} did not start in this process: {PRINT_RUNS_NOT_DURABLE}"
            )
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
        # The budget's paused-time fold: the pause no longer counts
        # against the run budget (the owner's decision latency is not
        # machine work).
        self._fold_paused(run)
        # Re-arm the pause notice: the escalate -> resume -> fail-again
        # retry flow must tell the parent about every pause, not only the
        # first. The budget and max_* notices stay one per run.
        run.milestones.discard("paused")
        self._touch(run)
        self._event(run, "resumed", detail="resumed by caller")
        # An escalate pause holds its failed entry unsettled: re-admit it
        # BEFORE anything evaluates or admits, so the retry -- not the
        # failure's propagation -- is what resume runs.
        self._readmit_held_entries(run)
        # Evaluate settles next: a max_transitions pause left transitions
        # mid-settle, and resume continues after the ones that fired.
        await self._evaluate_settles(run)
        # allow_backoff=False: like run(), resume() must never sleep inside
        # the calling model turn; rate-limited admissions defer to the loop.
        started = await self._spawn_ready(run, generation=run.loop_generation, allow_backoff=False)
        if self._run_complete(run):
            await self._finalize(run)
        elif run.state == "running":
            self._start_loop(run)
        self._persist_run(run)
        return {
            "run_id": run.run_id,
            "state": run.state,
            "started": started,
            "pending": self._pending_state_ids(run),
        }

    def _readmit_held_entries(self, run: FactoryRun) -> None:
        """Re-admit every entry an escalate pause holds unsettled.

        An escalate failure never queues its settle (the pause lands before
        the failure propagates), so a held entry is exactly ``error`` with
        ``is_settle`` unset -- that predicate is the one held-entry
        definition. Resume turns each held entry back into a fresh attempt
        of the SAME entry slot: the errored and cancelled instances re-run
        their rendered prompt (``attempt`` keeps counting, so spawn labels
        stay unique), ``max_entries`` is not spent again, and the
        ``retries`` budget restarts (``retry_base`` moves to the current
        attempt count). A binding-failure entry has no instances: it
        re-binds through the readiness pass, and a still-broken upstream
        settles it into the same pause again.
        """
        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                if entry.status != "error" or entry.is_settle:
                    continue
                entry.status = "running" if entry.instances else "pending"
                entry.error = None
                entry.needs_verify = False
                state.error = None
                for instance in entry.instances:
                    if instance.status not in ("error", "cancelled"):
                        continue  # running and done siblings keep their state
                    instance.status = "pending"
                    instance.error = None
                    instance.answer = None
                    instance.provisional = False
                    instance.capture_failed = False
                    instance.rate_limit_streak = 0
                    instance.retry_base = instance.attempt
                    instance.infra_respawned = False
                self._event(
                    run,
                    "readmitted",
                    node=state_id,
                    entry=entry.index,
                    detail="resume re-admits the failed entry (same rendered prompt)",
                )

    # -- graph, watch, host activity ------------------------------------------

    def _state_report(
        self, state: _StateRun, *, include_answer: bool = True
    ) -> dict[str, Any]:
        """One state's live report, the exact ``status()`` node shape.

        The graph snapshot reuses it verbatim so the fused view is
        ``status()``'s data plus the static graph (``include_answer=False``
        drops the settle answer preview on the compact host lane, where
        nothing renders answers). The report carries the stage's agent
        occupancy — ``running`` (admitted children in flight) and
        ``queued`` (prepared instances waiting for a parallel slot) —
        so every surface reads "how many agents are at this stage"
        without re-deriving it from the instance rows; both keys are
        single words, so the wire's camelCase conversion carries them
        unchanged.
        """
        report: dict[str, Any] = {
            "id": state.state_id,
            "status": state.status,
            "lifecycle": state.lifecycle,
            "attempts": sum(
                instance.attempt for entry in state.entries for instance in entry.instances
            ),
            "entries_used": state.entries_used,
            "max_entries": state.max_entries,
            "entries": [
                self._entry_report(entry) for entry in state.entries
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
                    **(
                        {"factory_task_activity": instance.factory_task_activity}
                        if instance.factory_task_activity is not None
                        else {}
                    ),
                }
                for entry in state.entries
                for instance in entry.instances
            ],
            "running": sum(
                1
                for entry in state.entries
                for instance in entry.instances
                if instance.status == "running"
            ),
            "queued": sum(
                1
                for entry in state.entries
                for instance in entry.instances
                if instance.status == "pending"
            ),
        }
        if include_answer:
            latest = state.latest_settle()
            if latest is not None and latest.answer:
                # The report previews the settle answer compactly; the
                # full binding text stays on the entry.
                report["answer_preview"] = latest.answer[:ANSWER_CAPTURE_CAP]
        if state.error is not None:
            report["error"] = state.error
        if any(entry.needs_verify for entry in state.entries):
            report["needs_verify"] = True
        return report

    def _entry_report(self, entry: _StateEntry) -> dict[str, Any]:
        """One entry's report row: its status/error plus, for a needs-verify
        entry, the provisional answer the child exit captured (compacted)."""
        row: dict[str, Any] = {"index": entry.index, "status": entry.status, "error": entry.error}
        if entry.needs_verify:
            row["needs_verify"] = True
            provisional = next(
                (
                    instance.answer
                    for instance in reversed(entry.instances)
                    if instance.provisional and instance.answer
                ),
                None,
            )
            if provisional is not None:
                row["provisional_answer"] = provisional[:ANSWER_CAPTURE_CAP]
        return row

    def _node_report(
        self,
        run_id: str,
        state_id: str,
        entry_at: int | None = None,
        instance_at: int | None = None,
    ) -> dict[str, Any]:
        """One state's node document (the ``node`` lane's reply): the
        state's live report (the instance list), the selected entry's
        settle-output preview, and the selected instance's realized prompt,
        inputs, and answer — capped and flagged, never silently truncated.
        Stored settle outputs remain full. The default selection is the
        latest entry and its latest instance, or no instance for an empty
        entry, or neither for a state never entered; selectors pick any
        other."""
        run = self._require_run(run_id)
        state = run.states.get(state_id)
        if state is None:
            raise ValueError(f"unknown state {state_id!r} in run {run_id!r}")
        entries = state.entries
        if not entries:
            if entry_at is not None:
                raise ValueError(
                    f"unknown entry {entry_at!r} for state {state_id!r} in run {run_id!r}"
                )
            return {
                "run_id": run.run_id,
                "spec_id": run.spec_id,
                "name": run.name,
                "state": self._state_report(state, include_answer=False),
                "entry": None,
                "instance": None,
            }
        entry = (
            next((row for row in entries if row.index == entry_at), None)
            if entry_at is not None
            else entries[-1]
        )
        if entry is None:
            raise ValueError(
                f"unknown entry {entry_at!r} for state {state_id!r} in run {run_id!r}"
            )
        instances = entry.instances
        if instance_at is not None:
            instance = next((row for row in instances if row.index == instance_at), None)
            if instance is None:
                raise ValueError(
                    f"unknown instance {instance_at!r} for state {state_id!r} in run {run_id!r}"
                )
        else:
            instance = instances[-1] if instances else None
        prompt = (instance.prompt if instance is not None else None) or ""
        prompt_truncated = len(prompt.encode("utf-8")) > NODE_PROMPT_CAP
        if prompt_truncated:
            prompt = prompt.encode("utf-8")[:NODE_PROMPT_CAP].decode(
                "utf-8", errors="ignore"
            )
        inputs_text = None
        inputs_truncated = False
        if instance is not None and instance.inputs is not None:
            inputs_text = json.dumps(instance.inputs, indent=2, default=str)
            inputs_truncated = len(inputs_text.encode("utf-8")) > NODE_INPUTS_CAP
            if inputs_truncated:
                inputs_text = inputs_text.encode("utf-8")[:NODE_INPUTS_CAP].decode(
                    "utf-8", errors="ignore"
                )
        answer = instance.answer if instance is not None else None
        answer_truncated = bool(
            answer and len(answer.encode("utf-8")) > ANSWER_BINDING_CAP
        )
        if answer_truncated and answer is not None:
            answer = answer.encode("utf-8")[:ANSWER_BINDING_CAP].decode(
                "utf-8", errors="ignore"
            )
        outputs_text = None
        outputs_truncated = False
        if entry.outputs is not None:
            outputs_text = json.dumps(entry.outputs, indent=2, default=str)
            outputs_truncated = len(outputs_text.encode("utf-8")) > NODE_OUTPUTS_CAP
            if outputs_truncated:
                outputs_text = outputs_text.encode("utf-8")[:NODE_OUTPUTS_CAP].decode(
                    "utf-8", errors="ignore"
                )
        instance_report = None
        if instance is not None:
            instance_report = {
                "index": instance.index,
                "entry": entry.index,
                "status": instance.status,
                "attempt": instance.attempt,
                "child": instance.child_id,
                "child_name": instance.child_name,
                "session_dir": instance.session_dir,
                "duration_ms": instance.duration_ms,
                "error": instance.error,
                "prompt": prompt,
                "prompt_truncated": prompt_truncated,
                "inputs": inputs_text,
                "inputs_truncated": inputs_truncated,
                "answer": answer,
                "answer_truncated": answer_truncated,
                "provisional": instance.provisional,
                "capture_failed": instance.capture_failed,
            }
        return {
            "run_id": run.run_id,
            "spec_id": run.spec_id,
            "name": run.name,
            "state": self._state_report(state, include_answer=False),
            "entry": {
                "index": entry.index,
                "status": entry.status,
                "outputs": outputs_text,
                "outputs_truncated": outputs_truncated,
                "output_errors": entry.output_errors,
                "output_errors_truncated": False,
            },
            "instance": instance_report,
        }

    def _usage_report(self, run: FactoryRun) -> dict[str, Any]:
        """The usage block ``status()`` returns; the graph snapshot reuses it."""
        return {
            "spawns": run.spawn_count,
            "settled": run.settle_count,
            "tool_uses": run.tool_use_total,
            "max_parallel": run.max_parallel,
            "max_children": run.max_children,
            "running": self._running_instance_count(run),
            "transitions_fired": run.transitions_fired,
        }

    def _last_fired(self, run: FactoryRun) -> list[dict[str, Any]]:
        """The trailing fired transitions (newest firing first, at most
        ``LAST_FIRED_WINDOW`` edges) for the diagram's edge marking. The
        ledger is the authority: an edge that fired twice keeps its latest
        firing only."""
        latest: dict[str, dict[str, Any]] = {}
        for event in run.events:
            if event.get("kind") != "transition_fired":
                continue
            from_field = event.get("from")
            # The guard rides the edge's identity: two guarded transitions
            # may share one from+to pair, and the diagram's fired marking
            # needs the one that actually fired (the event's ``when``).
            edge = {
                "from": from_field,
                "to": event.get("to"),
                "seq": event.get("seq"),
                "when": event.get("when"),
            }
            latest[
                f"{json.dumps(from_field, sort_keys=True)}->{event.get('to')}"
                f"@{json.dumps(event.get('when'), sort_keys=True, default=str)}"
            ] = edge
        ordered = sorted(latest.values(), key=lambda edge: edge["seq"], reverse=True)
        return ordered[:LAST_FIRED_WINDOW]

    def _graph_events(self, run: FactoryRun, *, compact: bool) -> list[dict[str, Any]]:
        """The trailing event window. The compact host lane sheds answer
        payloads (the ``answer_captured`` rows) and carries the shorter
        ``GRAPH_EVENTS_TAIL`` tail; the agent lane sees ``status()``'s full
        ``EVENT_WINDOW`` window with stages untouched (``graph`` is a pure
        read; only ``status()`` marks events delivered)."""
        window = run.events[-(GRAPH_EVENTS_TAIL if compact else EVENT_WINDOW) :]
        events = [dict(event) for event in window]
        if compact:
            events = [event for event in events if event.get("kind") != "answer_captured"]
        return events

    def _graph_snapshot(self, run: FactoryRun, *, compact: bool) -> dict[str, Any]:
        """One live run's fused snapshot: the machine structure plus the
        live overlay (nodes, active nodes, last-fired edges, events tail,
        usage, budget consumed)."""
        elapsed_ms = int((self._now_fn() - run.started_at) * 1000)
        return {
            "run_id": run.run_id,
            "spec_id": run.spec_id,
            "name": run.name,
            "state": run.state,
            "pause_reason": run.pause_reason,
            "elapsed_ms": elapsed_ms,
            "machine": _machine_structure(
                run.machine,
                {
                    state_id: (run.states[state_id].model, run.states[state_id].thinking)
                    for state_id in run.order
                },
            ),
            "nodes": [
                self._state_report(run.states[state_id], include_answer=not compact)
                for state_id in run.order
            ],
            # Activity is children-shaped, not entry-shaped alone: a
            # foreach entry that failed permanently (failure_policy
            # continue) is terminal at the entry layer while its
            # admitted siblings still run -- the quiescence contract
            # (_run_complete) counts those instances, and the node report
            # carries them as the stage's occupancy, so a stage with
            # live children stays in the overlay exactly while its
            # occupancy label can be nonzero.
            "active_nodes": [
                state_id
                for state_id in run.order
                if any(
                    entry.status in ("pending", "running")
                    or any(
                        instance.status in ("pending", "running")
                        for instance in entry.instances
                    )
                    for entry in run.states[state_id].entries
                )
            ],
            "last_fired": self._last_fired(run),
            "events": self._graph_events(run, compact=compact),
            "usage": self._usage_report(run),
            "budget": {"limit_ms": run.run_budget_ms, "consumed_ms": elapsed_ms},
        }

    def _spec_snapshot(
        self, spec_id: str, canonical: dict[str, Any], *, compact: bool
    ) -> dict[str, Any]:
        """A stored spec's static graph: no live run exists, so the overlay
        reports the shape a fresh run starts from (nothing entered, nothing
        consumed). The compact flag is accepted for lane symmetry; a spec
        graph carries no answers to shed."""
        run_block = canonical["run"]
        return {
            "run_id": None,
            "spec_id": spec_id,
            "name": None,
            "state": None,
            "pause_reason": None,
            "elapsed_ms": 0,
            "machine": _machine_structure(canonical),
            "nodes": [],
            "active_nodes": [],
            "last_fired": [],
            "events": [],
            "usage": None,
            "budget": {"limit_ms": run_block.get("budget_ms"), "consumed_ms": 0},
        }

    def graph(self, ref: str | None = None, *, compact: bool = False) -> dict[str, Any]:
        """One machine's structure fused with live runtime state.

        ``ref`` naming a live run id returns that run's fused snapshot
        (``status()``'s data plus the static graph and the diagram overlay);
        ``ref`` naming a stored factory spec id returns the static
        structure with no live overlay. ``ref=None`` returns every live
        run's snapshot, oldest run first, as ``{"runs": [...]}`` (the view
        lane's polling shape). Raises ``ValueError`` when ``ref`` names
        neither a live run nor a stored spec, or a stored spec fails its
        own validation.
        """
        if ref is None:
            # Insertion order is start order (runs append to the registry),
            # so the oldest run reports first; a clock tie between two
            # starts never shuffles the panels. The unscoped list is
            # BOUNDED: every live run reports (the dock's count and the
            # view's panels stay exact), and the terminal history keeps
            # at most the newest ``GRAPH_RUNS_WINDOW`` runs — the wire cap
            # would drop older terminal runs anyway, and the bound keeps
            # one polling reply's construction O(window), not
            # O(registry) (the registry retains every run it ever
            # hosted; by-ref snapshots stay available for all of them).
            # Liveness is children-shaped, not state-shaped alone: a
            # ``done``/``failed`` run whose instances are still in
            # flight (the resident lifecycle — admitted residents never
            # block completion, and the finished milestone tells the
            # operator to ``rlm.factory.stop()`` them) is LIVE, so the
            # page keeps the run and its stop control while any child
            # runs; the terminal history window holds only runs with no
            # child in flight.
            live_states = ("running", "stopping", "paused")
            # The registry's insertion order is start order, so the list's
            # tail is the newest terminal history.
            terminal_ids = [
                run.run_id
                for run in self._runs.values()
                if run.state not in live_states and self._running_instance_count(run) == 0
            ]
            newest_terminal_ids = set(terminal_ids[-GRAPH_RUNS_WINDOW:])
            snapshots: list[dict[str, Any]] = []
            for run in self._runs.values():
                if not (
                    run.state in live_states
                    or self._running_instance_count(run) > 0
                    or run.run_id in newest_terminal_ids
                ):
                    continue
                # Per-run isolation (round-8 probe R8-01): a corrupt
                # durable input that loaded without raising must cost its
                # own panel one loud line, never the whole unscoped poll
                # (the view lane polls this shape; a raw error here broke
                # the factory page for every run, all boot). ONCE per run
                # per boot (round-9 probe R9-03): the TUI polls this
                # shape every 2 seconds, and a line-per-poll filled the
                # kernel's 64 KiB background buffer — and then every
                # model cell — with one repeated line in minutes.
                try:
                    snapshots.append(self._graph_snapshot(run, compact=compact))
                except Exception as error:  # noqa: BLE001 - the view lane's poll
                    import sys

                    if run.run_id not in self._graph_guard_reported:
                        self._graph_guard_reported.add(run.run_id)
                        print(
                            f"factory run {run.run_id} cannot render in the factory "
                            f"view (its children stay visible under the supervisor): {error}",
                            file=sys.stderr,
                        )
            return {"runs": snapshots}
        run = self._runs.get(ref)
        if run is not None:
            return self._graph_snapshot(run, compact=compact)
        harness = self._resolve_harness()
        entry = harness.get("factory", ref)
        if entry is None:
            raise ValueError(f"unknown factory run or spec {ref!r}")
        arguments = entry.arguments if isinstance(entry.arguments, dict) else {}
        spec = arguments.get("machine")
        if spec is None:
            spec = arguments.get("dag")
        try:
            canonical = canonicalize_factory_spec(spec)
        except ValueError as exc:
            raise ValueError(f"factory spec {ref!r} does not validate: {exc}") from exc
        return self._spec_snapshot(entry.id, canonical, compact=compact)

    def _signature(self, run: FactoryRun) -> tuple[Any, ...]:
        """The run's live shape a watch treats as a change: the run state,
        every state's entries and per-instance statuses, and the transition
        counter. Ledger-only movement (backoff notices, repeated
        milestones) leaves the shape unchanged, so the wait re-arms instead
        of waking the caller with an identical graph (no per-transition
        spam at the watch surface either).
        """

        def state_shape(state: _StateRun) -> tuple[Any, ...]:
            return (
                state.status,
                state.entries_used,
                tuple(
                    (entry.index, entry.status, tuple(i.status for i in entry.instances))
                    for entry in state.entries
                ),
            )

        return (
            run.state,
            run.pause_reason,
            run.transitions_fired,
            tuple((state_id, state_shape(run.states[state_id])) for state_id in run.order),
        )

    async def watch(
        self, run_id: str, timeout: float = 0.0, *, compact: bool = False
    ) -> dict[str, Any]:
        """Block until the run's state/instance shape changes or the bounded
        ``timeout`` (seconds, capped at ``WATCH_TIMEOUT_CAP_SECONDS``)
        elapses, then return the same fused snapshot ``graph()`` returns
        with one extra ``changed`` key: whether a change ended the wait or
        the deadline did. An already-changed run returns immediately; the
        clock and sleep are the executor's injected pair, so the wait is
        testable and bounded on the same lane the control loop uses.
        Raises ``ValueError`` for an unknown run id or a negative or
        non-numeric timeout.
        """
        import asyncio

        run = self._require_run(run_id)
        # NaN passes every arithmetic check (every comparison is false), so
        # it must be rejected by identity: a NaN deadline would reach
        # asyncio.sleep, which raises instead of returning the bounded
        # snapshot (a NaN timeout is not a number here).
        if not _is_number(timeout) or math.isnan(float(timeout)):
            raise ValueError("timeout must be a non-negative number of seconds")
        if timeout < 0:
            raise ValueError("timeout must be a non-negative number of seconds")
        timeout = min(float(timeout), WATCH_TIMEOUT_CAP_SECONDS)
        deadline = self._now_fn() + timeout
        baseline = self._signature(run)
        changed = False
        while True:
            if self._signature(run) != baseline:
                changed = True
                break
            remaining = deadline - self._now_fn()
            if remaining <= 0:
                break
            waiter = asyncio.get_running_loop().create_future()
            run.watchers.append(waiter)
            sleeper = asyncio.ensure_future(self._sleep_fn(remaining))
            try:
                await asyncio.wait({sleeper, waiter}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                if waiter in run.watchers:
                    run.watchers.remove(waiter)
                sleeper.cancel()
                try:
                    await sleeper
                except asyncio.CancelledError:
                    pass
        snapshot = self._graph_snapshot(run, compact=compact)
        return {"changed": changed, **snapshot}

    async def activity(self, request: dict[str, Any]) -> Any:
        """Handle one out-of-band ``factory_activity`` request frame (the
        host bridge's lane): route the action to ``graph``/``status``/
        ``watch``/``run``/``stop``/``resume``/``library``/``peek`` and
        return the reply's result payload. Raises ``ValueError`` for malformed
        requests and unknown runs/specs (the reply carries it as the error
        reason). ``library`` serves the machine library: the list with no
        target, or one machine's graph payload when ``specId`` names it.
        ``graph``
        and ``watch`` answer with the compact snapshots (the host lane
        renders diagrams, not answers); ``run`` is the lane that starts a
        run from the daemon or TUI, so it rides the full ``run()``
        validation. The reply's result payload carries the WIRE's
        camelCase keys (``_wire_payload`` re-keys the snake_case rows: the
        protocol's request frame is camelCase end to end) — the
        conversation API (``rlm.factory.graph()`` in-kernel) stays
        snake_case.
        """
        # The lane rides the same opt-in gate as the namespace: while
        # ``factory.enabled`` is off, every activity action -- ``run``
        # included, which would otherwise bypass the namespace's gate --
        # refuses with the one refusal message.
        require_factory_enabled()
        # The lane is the factory page's poll: the first frame after a
        # kernel restart re-arms the rehydrated runs here. ``peek`` is
        # the one exception: it is the cross-session overview's
        # read-only live poll, and a display refresh in one session must
        # never complete another owner's interrupted flows.
        action = request.get("action")
        if action != "peek":
            await self.arm_persisted_runs()
        if action not in ACTIVITY_ACTIONS:
            raise ValueError(f"unknown factory activity action {action!r}")
        run_id = request.get("runId")
        spec_id = request.get("specId")
        for key, value in (("runId", run_id), ("specId", spec_id)):
            if value is not None and not isinstance(value, str):
                raise ValueError(f"factory activity {key} must be a string when provided")
        timeout_ms = request.get("timeoutMs")
        if timeout_ms is None:
            timeout_ms = 0
        if not _is_int(timeout_ms) or not 0 <= timeout_ms <= ACTIVITY_TIMEOUT_MS_CAP:
            raise ValueError(
                f"factory activity timeoutMs must be an integer between 0 and {ACTIVITY_TIMEOUT_MS_CAP}"
            )
        if action == "library":
            # One library machine's graph for the machines page's drill-in
            # (the daemon answers the machine list itself, from its scan):
            # the Rust loader describes the machine by name — the same
            # resolution a run uses — and the reply is the snapshot shape a
            # stored spec's ``graph`` answers, plus the machine's fields.
            if spec_id is None:
                raise ValueError("factory activity library requires specId")
            from . import host_request

            described = await host_request("factory.describe", {"name": spec_id})
            canonical = canonicalize_factory_spec(described["spec"])
            snapshot = self._spec_snapshot(described["name"], canonical, compact=True)
            snapshot["description"] = described["description"]
            snapshot["version"] = str(described["version"])
            snapshot["author"] = described.get("author") or ""
            snapshot["params"] = described.get("params") or []
            snapshot["files"] = described.get("files") or []
            snapshot["state_files"] = described.get("state_files") or []
            return _wire_payload(snapshot)
        if action == "node":
            # The node lane: one state's inspection document — the
            # instance list (the node report's own rows), the selected
            # entry's settle outputs, and the selected instance's
            # REALIZED prompt (the exact text the executor handed the
            # child: the template with params and bound inputs
            # substituted), inputs, and answer. Selectors pick one
            # instance (both or neither); without them the latest entry
            # and its latest instance answer.
            if not run_id:
                raise ValueError("factory activity node requires runId")
            if not spec_id:
                raise ValueError("factory activity node requires specId")
            # The kernel frame always carries both keys, null meaning "no
            # selector" (the daemon adapter rejects a client's explicit
            # null). Any other value is validated as given, never read as
            # "the latest".
            entry_at = request.get("entry")
            instance_at = request.get("instance")
            if (entry_at is None) != (instance_at is None):
                raise ValueError(
                    "factory activity node entry and instance selectors must be provided together"
                )
            for key, value in (("entry", entry_at), ("instance", instance_at)):
                if value is not None and (not _is_int(value) or value < 0):
                    raise ValueError(f"factory activity node {key} must be a non-negative integer")
            node_report = self._node_report(run_id, spec_id, entry_at, instance_at)
            wire_report = _wire_payload(node_report)
            # Port names are user-authored identifiers, not schema fields;
            # keep their spelling verbatim through the wire conversion.
            if node_report["entry"] is not None:
                wire_report["entry"]["outputErrors"] = copy.deepcopy(
                    node_report["entry"]["output_errors"]
                )
            return wire_report
        if action in ("graph", "peek"):
            # ``peek`` and ``graph`` answer the same compact snapshot; only
            # the re-arm above differs between them. A run the peek lists
            # while it still awaits its re-arm is displayed but NOT
            # executing: the overview's assembly reads the marker and
            # paints the row with the saved marker, never a ticking age
            # for a run no loop drives.
            payload = self.graph(run_id or spec_id, compact=True)
            if action == "peek" and isinstance(payload, dict):
                for row in payload.get("runs") or []:
                    if row.get("run_id") in self._rehydrated:
                        row["armed"] = False
            return _wire_payload(payload)
        if action == "status":
            if not run_id:
                raise ValueError("factory activity status requires runId")
            return _wire_payload(await self.status(run_id))
        if action == "watch":
            if not run_id:
                raise ValueError("factory activity watch requires runId")
            return _wire_payload(
                await self.watch(run_id, timeout_ms / 1000.0, compact=True)
            )
        if action == "run":
            if not spec_id:
                raise ValueError("factory activity run requires specId")
            return _wire_payload(await self.run(spec_id))
        if not run_id:
            raise ValueError(f"factory activity {action} requires runId")
        if action == "stop":
            return _wire_payload(await self.stop(run_id))
        return _wire_payload(await self.resume(run_id))

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
            if "python" in state_spec:
                continue  # python states spawn no child
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
        run.transitions_from = _transitions_index(canonical)
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
        notice was handed to the parent, as a direct row or an inbox
        message), and ``delivered``
        (the parent read the ledger via ``status()``).
        """
        event: dict[str, Any] = {
            "seq": run.seq_base + len(run.events) + 1,
            "kind": kind,
            "stage": stage,
        }
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
        if len(run.events) > PERSISTED_EVENTS_CAP:
            # The trailing window: the oldest events leave, the seq
            # watermark moves up by the same count, so no seq is ever
            # reused and the next event still numbers above every one
            # that left (``seq`` reads seq_base + len + 1).
            trimmed = run.events[: len(run.events) - PERSISTED_EVENTS_CAP]
            run.events = run.events[len(run.events) - PERSISTED_EVENTS_CAP :]
            run.seq_base += len(trimmed)
        # Every ledger event is an observable mutation, so the watch
        # bookkeeping and the registry snapshot ride the same seam: bump
        # the revision, resolve every registered watcher, persist the run.
        # ``watch`` re-checks its signature, so an event that leaves the
        # state/instance shape unchanged (a backoff notice, a repeated
        # milestone) just re-arms the wait.
        self._touch(run)
        return event

    def _evict_terminal_runs(self) -> None:
        """Past ``RETAINED_RUNS_LIMIT`` terminal runs, evict the oldest.

        The terminal runs' files retired at their terminal persist, so
        this is registry bookkeeping only: an evicted run answers
        ``unknown factory run`` exactly like a run of a previous boot.
        Live runs are never touched; the newest terminal runs stay (the
        operator reads the just-finished run's final status).
        """
        terminal = [
            (run.started_at, run_id)
            for run_id, run in self._runs.items()
            if run.state in TERMINAL_RUN_STATES
        ]
        if len(terminal) <= RETAINED_RUNS_LIMIT:
            return
        terminal.sort()
        for _, run_id in terminal[: len(terminal) - RETAINED_RUNS_LIMIT]:
            del self._runs[run_id]

    def _touch(self, run: FactoryRun) -> None:
        """Bump the run's watch revision and wake every registered watcher.
        The revision also tells ``_persist_run`` the run changed."""
        run.revision += 1
        for waiter in run.watchers:
            if not waiter.done():
                waiter.set_result(run.revision)
        run.watchers = []

    async def _pause(
        self, run: FactoryRun, reason: str, kind: str, detail: str, *, node: str | None = None
    ) -> None:
        """Pause the run and tell the parent. The budget excludes paused time
        (elapsed = now - started_at - paused_ms), so every pause records its
        start; the resume folds it into ``paused_ms``."""
        run.state = "paused"
        if run.pause_started_at is None:
            run.pause_started_at = self._now_fn()
        run.pause_reason = reason
        await self._milestone(run, kind, detail, node=node)

    def _fold_paused(self, run: FactoryRun) -> None:
        """Fold the completed pause into the budget's paused total."""
        if run.pause_started_at is not None:
            run.paused_ms += (self._now_fn() - run.pause_started_at) * 1000.0
            run.pause_started_at = None

    async def _milestone(self, run: FactoryRun, kind: str, detail: str, *, node: str | None = None) -> None:
        """Record a run milestone and inject one quiet notice (one per kind).

        Every milestone lands in the ledger, repeats included. Only the
        parent-visible notice is deduped per kind; ``resume()`` re-arms the
        ``paused`` notice, so each pause after a resume notifies again.
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

    async def _evaluate_join(
        self,
        run: FactoryRun,
        state: _StateRun,
        entry: _StateEntry,
        position: int,
        canonical_index: int,
        transition: dict[str, Any],
    ) -> str:
        """Evaluate ONE join transition of a settled state; return its outcome.

        ``unsettled`` — a source has no settle yet (the fire waits).
        ``live`` — a source's current-round entry is still pending or
        running; that source's own settle re-reaches this join.
        ``arrival-queued`` — every source settled, but a queued evaluation
        will fire a transition into a source: the arrival is this round's
        work for it (round-1 probe A3). The caller DEFERS the join: the
        promise may never land (its guard fails against the queued settle's
        own captured outputs, its target sits at max_entries, or a feeding
        join cannot complete), and a skipped join is never re-reached — so
        the hold must re-run after the queue drains (round-2 probe Q1).
        ``stale`` / ``blocked`` / ``fired`` / ``paused`` — the signature
        already fired, the target is at max_entries, the fire happened, or
        the max_transitions pause landed (the caller must stop the pass).
        """
        sources = transition["from"]
        signature_parts: list[tuple[str, int]] = []
        for source_id in sources:
            source_state = run.states.get(source_id)
            if source_state is not None and any(
                source_entry.status in ("pending", "running")
                for source_entry in source_state.entries
            ):
                return "live"
            if run.pending_evaluations:
                for pending_state_id, _, _ in run.pending_evaluations:
                    if pending_state_id == source_id:
                        continue
                    for _, pending_transition in run.transitions_from.get(pending_state_id, []):
                        if pending_transition.get("to") == source_id:
                            return "arrival-queued"
            latest = source_state.latest_settle() if source_state is not None else None
            if latest is None:
                return "unsettled"
            signature_parts.append((source_id, latest.index))
        signature = frozenset(signature_parts)
        # Keyed by the transition's canonical index in the machine's
        # transitions list: duplicate transitions (same sources, same
        # target) are legal machine syntax and stay independent, the ONE
        # join object shared by every source state's list keeps ONE key (a
        # join fired from one source's settle must not re-fire from
        # another's), and the key rides the registry snapshot verbatim
        # where an object id() would not.
        key = (canonical_index, transition["to"])
        if run.join_fired.get(key) == signature:
            return "stale"  # this completion already fired (or was blocked)
        # The signature is CLAIMED only in _fire_transition, when the
        # transition actually fires or is blocked: a max_transitions pause
        # that re-queues this transition must not leave a stale mark, or
        # the resume would skip the join forever.
        return await self._fire_transition(run, state, entry, position, transition, (key, signature))

    async def _fire_transition(
        self,
        run: FactoryRun,
        state: _StateRun,
        entry: _StateEntry,
        position: int,
        transition: dict[str, Any],
        join_signature: "tuple[tuple[int, str], frozenset[tuple[str, int]]] | None",
    ) -> str:
        """Fire or block ONE transition of a settled state; return the outcome.

        Shared by the single-source path and the join path. ``blocked``
        records the target at max_entries; ``paused`` lands the
        max_transitions pause (the caller must stop the pass; the settle is
        re-queued un-consumed at this transition's position).
        """
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
            return "blocked"
        if run.transitions_fired >= run.max_transitions and not run.max_transitions_reported:
            run.max_transitions_reported = True
            entry.consumed = False
            run.pending_evaluations.insert(0, (state.state_id, entry.index, position))
            await self._pause(
                run,
                "max_transitions exceeded",
                "max_transitions_exceeded",
                f"max_transitions {run.max_transitions} exceeded; no new entries; "
                f"resume with await rlm.factory.resume('{run.run_id}')",
            )
            return "paused"
        if join_signature is not None:
            run.join_fired[join_signature[0]] = join_signature[1]
        run.transitions_fired += 1
        # The guard rides the fired event (and the ``last_fired`` edge the
        # graph overlay reads): two guarded transitions may share one
        # from+to pair, so the guard is the only identity that tells the
        # diagram WHICH of them fired.
        when = transition.get("when")
        fired_fields: dict[str, Any] = {"from": from_field, "to": target.state_id}
        if when is not None:
            fired_fields["when"] = copy.deepcopy(when)
        self._event(
            run,
            "transition_fired",
            detail=f"{from_field!r} -> {target.state_id!r}",
            **fired_fields,
        )
        self._enter_state(run, target, from_state=state.state_id)
        return "fired"

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
        fired = False
        # Joins held on a QUEUED arrival (round-1 probe A3) defer instead of
        # skipping: the promise may never land, so each one re-runs once the
        # queue drains (round-2 probe Q1).
        deferred_joins: list[tuple[str, int, int]] = []
        while run.pending_evaluations and run.state == "running":
            state_id, entry_index, resume_from = run.pending_evaluations.pop(0)
            state = run.states[state_id]
            entry = state.entries[entry_index]
            if entry.consumed or not entry.is_settle:
                continue
            entry.consumed = True
            outputs = entry.outputs or {}
            for position, (canonical_index, transition) in enumerate(
                run.transitions_from.get(state_id, [])
            ):
                if position < resume_from:
                    continue  # already fired before the pause; do not re-fire
                raw_from = transition["from"]
                if isinstance(raw_from, list):
                    outcome = await self._evaluate_join(
                        run, state, entry, position, canonical_index, transition
                    )
                    if outcome == "arrival-queued":
                        # The hold defers (round-2 probe Q1): the queued
                        # promise may never land (its guard fails, its
                        # target sits at max_entries, or a feeding join
                        # cannot complete), and nothing else re-reaches
                        # this join. The drain recheck below re-runs it.
                        deferred_joins.append((state_id, entry_index, position))
                    elif outcome == "paused":
                        # A pause mid-pass drops the pass's un-rechecked
                        # holds — the resume's replay starts at the paused
                        # settle's position, past the earlier joins. The
                        # holds ride the run (probe R3B: the next pass's
                        # drain recheck re-reaches them).
                        run.deferred_join_rechecks = list(deferred_joins)
                        return
                    fired = fired or outcome == "fired"
                    continue
                when = transition.get("when")
                if when is not None and not _guard_passes(when, outputs):
                    continue
                outcome = await self._fire_transition(
                    run, state, entry, position, transition, None
                )
                if outcome == "paused":
                    run.deferred_join_rechecks = list(deferred_joins)
                    return
                fired = fired or outcome == "fired"
        if deferred_joins or run.deferred_join_rechecks:
            # Holds a paused pass stashed on the run re-enter first
            # (probe R3B: the resume's replay of the paused settle starts
            # past the join position, so the stash is the join's only
            # re-entry).
            deferred_joins = run.deferred_join_rechecks + deferred_joins
            run.deferred_join_rechecks = []
        while deferred_joins and run.state == "running":
            # The queue drained: re-reach every join the queued-arrival
            # hold deferred. A REAL arrival left a live entry (the live
            # rule still waits for that source's own settle); a promise
            # that never landed (a guard that failed, a max_entries block,
            # an incomplete feeding join) left no live entry, so the join
            # fires with the sources' current settles (round-2 probe Q1 —
            # the alternative is the run silently finalizing a round
            # early).
            state_id, entry_index, position = deferred_joins.pop(0)
            indexed = run.transitions_from.get(state_id, [])
            if position >= len(indexed):
                continue  # a later mutation re-shaped the settle's list
            canonical_index, transition = indexed[position]
            if not isinstance(transition.get("from"), list):
                continue  # the transition is no longer a join
            outcome = await self._evaluate_join(
                run, run.states[state_id], run.states[state_id].entries[entry_index],
                position, canonical_index, transition,
            )
            if outcome == "paused":
                run.deferred_join_rechecks = list(deferred_joins)
                return
            fired = fired or outcome == "fired"
        if fired:
            # A fired transition consumed a settle and entered a target:
            # both must be durable before the iteration's next await, or a
            # restart replays the settle and re-fires — a max_entries guard
            # would self-heal, a multi-entry target would double-work.
            self._persist_run(run)

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
            state, entry, instance = pair
            if self._factory_task_owners(run):
                break  # a settled child still owns shared task work on this checkout
            python = "python" in state.spec
            if not python and self._children_budget_exceeded(run):
                await self._pause_for_children(run)
                break
            if python:
                outcome = await self._start_python(run, state, entry, instance)
            else:
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

    def _run_budget_active_ms(self, run: FactoryRun) -> float:
        """The run's ACTIVE time: wall time minus paused time (the owner's
        decision latency never spends the machine's budget)."""
        elapsed = (self._now_fn() - run.started_at) * 1000.0 - run.paused_ms
        if run.pause_started_at is not None:
            elapsed -= (self._now_fn() - run.pause_started_at) * 1000.0
        return max(0.0, elapsed)

    def _run_budget_exceeded(self, run: FactoryRun) -> bool:
        if run.run_budget_ms is None or run.budget_reported:
            return False
        return self._run_budget_active_ms(run) > run.run_budget_ms

    async def _pause_for_budget(self, run: FactoryRun) -> None:
        """Pause the run at the budget boundary (milestone fires once).

        Children already in flight keep running; they settle normally once
        the run resumes. Resuming after the milestone is an explicit operator
        decision, so no further budget pauses fire (budget_reported)."""
        elapsed_ms = self._run_budget_active_ms(run)
        run.budget_reported = True
        await self._pause(
            run,
            "run budget exceeded",
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
        run.max_children_reported = True
        await self._pause(
            run,
            "max_children exceeded",
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
                    # The batch is durable before the loop can lose it: a
                    # restart inside the throttle window replays the pending
                    # siblings (the foreach fan that has not been admitted
                    # yet) instead of silently dropping them.
                    self._journal_batch(run, state, entry)
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
        """Bind inputs, expand foreach, and render one prompt per instance
        (a python state gets one instance carrying the bound values instead).

        Returns ``(instances, None)`` on success, ``(None, None)`` while an
        input source has not settled yet (the entry stays pending), or
        ``(None, reason)`` on a binding failure. Binding failures never
        retry: a deterministic binding error would recur on every re-render,
        so the entry fails and its failure_policy applies directly.
        """
        # Raw bound values first: a python state receives them as-is, and an
        # agent state renders them into its prompt below.
        bound: dict[str, Any] = {}
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
                    # An optional input over a DIFFERENT state that has a
                    # live entry (pending or running) waits: the source is
                    # about to settle, and a sentinel here would spawn the
                    # dependent while its upstream is still running (the
                    # M3 premature-spawn class -- the children exited
                    # "waiting" and the bookkeeping counted them). The
                    # sentinel still binds for the self-input loop form and
                    # for a source with no live entry, so loop states keep
                    # re-entering before their upstream partner has RUN.
                    if latest is None and src_id != state.state_id:
                        source_state_live = source_state is not None and any(
                            other.status in ("pending", "running") for other in source_state.entries
                        )
                        if source_state_live:
                            return None, None  # wait for the in-flight source's settle
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
                    bound[name] = None
                    continue
                if latest is None:
                    return None, None  # wait for the source's first settle
                return None, failure
            if port_type == "text":
                bound[name] = value if isinstance(value, str) else json.dumps(value)
                continue
            if foreach is not None and foreach.get("over") == name:
                if not isinstance(value, list):
                    return None, f"foreach.over input {name!r} is not a JSON list"
                items = value
                continue
            bound[name] = value
        params = run.machine.get("params") or {}
        if "python" in state.spec:
            instance = _NodeInstance(
                index=state.instance_counter, prompt="", inputs={**params, **bound}
            )
            state.instance_counter += 1
            return [instance], None
        rendered_params = {
            name: value if isinstance(value, str) else json.dumps(value)
            for name, value in params.items()
        }
        # The prompt form of a bound value: json inputs as JSON text (a
        # missing optional one reads "null"), text inputs verbatim (a
        # missing optional one reads "None").
        port_types = {inp["name"]: inp["type"] for inp in state.spec.get("inputs") or []}
        values = {
            name: json.dumps(value) if port_types[name] == "json" else ("None" if value is None else value)
            for name, value in bound.items()
        }
        if foreach is None:
            assert state.prompt_template is not None
            instance = _NodeInstance(
                index=state.instance_counter,
                prompt=_render_prompt(state.prompt_template, values, rendered_params),
                inputs={**params, **bound},
            )
            state.instance_counter += 1
            return [instance], None
        if items is None:
            return None, "foreach entry did not resolve its over input"
        if len(items) > foreach["max"]:
            # The silent drop (probe H): 7 items with max 3 spawned 3
            # with no ledger event, so the run's answer count could not be
            # explained from status() alone. One event carries both counts.
            self._event(
                run,
                "foreach_truncated",
                node=state.state_id,
                entry=entry.index,
                detail=f"foreach over {len(items)} items; max {foreach['max']} spawns the first {foreach['max']}",
            )
        instances = []
        for item in items[: foreach["max"]]:
            instance_value = item if isinstance(item, str) else json.dumps(item)
            instances.append(
                _NodeInstance(
                    index=state.instance_counter + len(instances),
                    prompt=_render_prompt(
                        state.prompt_template,
                        {**values, foreach["over"]: instance_value},
                        rendered_params,
                    ),
                    inputs={**params, **bound, foreach["over"]: item},
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
        from . import _spawn, delete_subagent

        if instance.child_id is not None:
            old_child = instance.child_id
            instance.ownership_change_in_progress = True
            try:
                await delete_subagent(old_child)
            except Exception as exc:
                instance.ownership_change_in_progress = False
                self._event(
                    run,
                    "cancel_failed",
                    node=state.state_id,
                    entry=entry.index,
                    instance=instance.index,
                    child=old_child,
                    error=str(exc),
                )
                await self._apply_instance_failure(
                    run,
                    state,
                    entry,
                    instance,
                    f"could not retire child {old_child} before replacement: {exc}",
                    retry=False,
                )
                if run.state == "stopping":
                    await self._finish_stop_if_quiescent(run, "stopped")
                return "failed"
            instance.ownership_change_in_progress = False
            instance.child_id = None
            instance.session_dir = None
            instance.child_name = None
            instance.factory_task_activity = "idle"
            if run.state != "running":
                if run.state == "stopping":
                    await self._finish_stop_if_quiescent(run, "stopped")
                return "stopped"

        instance.attempt += 1
        child_name = _spawn_label(state.name, run.run_id, state.state_id, instance.index, instance.attempt)
        # The admission intent: the child is about to exist under this
        # label. A kernel death between the supervisor creating the child
        # and the reply leaves an orphan the snapshot cannot know (the
        # instance is still pending at the OLD attempt). The rehydrate
        # resolves an unresolved intent line by deleting the child it
        # names (probe F — the re-admission collided with the orphan's
        # name and paused the run). The admission line that follows
        # replaces the intent; the snapshot absorbs both at the next
        # write.
        self._journal_line(
            run,
            {
                "kind": "admitting",
                "state": state.state_id,
                "entry": entry.index,
                "index": instance.index,
                "attempt": instance.attempt,
                "label": child_name,
            },
        )
        instance.ownership_change_in_progress = True
        try:
            contract = state.spec.get("emit")
            handle = await _spawn(
                instance.prompt,
                name=child_name,
                model=state.model,
                thinking=state.thinking,
                factory={"runId": run.run_id, "specId": run.spec_id, "stateId": state.state_id},
                factory_contract=(
                    None if contract is None else {**contract, "inputs": instance.inputs or {}}
                ),
            )
        except RuntimeError as exc:
            instance.ownership_change_in_progress = False
            if run.state != "running":
                # stop() ran while the spawn was in flight and waited for it;
                # no child came of it, so the stop can finish now.
                if run.state == "stopping":
                    await self._finish_stop_if_quiescent(run, "stopped")
                return "stopped"
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
        except Exception:
            instance.ownership_change_in_progress = False
            raise
        if run.state != "running":
            # stop() ran while the spawn was in flight: its cancellation
            # pass could not see this child yet, so retract it here or it
            # would outlive the stopped run under the supervisor.
            instance.child_id = handle.rlm_child_id
            await self._retract_admission(run, state, entry, instance)
            return "stopped"
        instance.ownership_change_in_progress = False
        instance.child_id = handle.rlm_child_id
        instance.session_dir = str(handle.session_dir)
        instance.child_name = handle.name
        instance.factory_task_activity = None
        instance.repair_sent = False
        instance.spawned_at = self._now_fn()
        instance.status = "running"
        instance.rate_limit_streak = 0
        run.spawn_count += 1
        # The admission is durable before anything else can happen to it:
        # the journal line lands now (a snapshot may sit the throttle
        # window out), so a restart adopts the child instead of orphaning
        # it under the supervisor.
        self._journal_admission(run, state, entry, instance)
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

    async def _start_python(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance
    ) -> str:
        """Start one python state call. Returns "admitted", "failed", or
        "stopped" like ``_admit``. The call holds a max_parallel slot but is
        no child: it never counts toward ``max_children``."""
        instance.attempt += 1
        instance.ownership_change_in_progress = True
        try:
            process = await _PythonProcess.start(state.spec["python"], instance.inputs)
        except OSError as exc:
            instance.ownership_change_in_progress = False
            await self._apply_instance_failure(
                run, state, entry, instance, f"python state could not start: {exc}", retry=False
            )
            if run.state == "stopping":
                await self._finish_stop_if_quiescent(run, "stopped")
            return "failed"
        except Exception:
            instance.ownership_change_in_progress = False
            raise
        if run.state != "running":
            # stop() ran while the process was starting; its pass could not see it.
            try:
                await process.stop()
            except Exception as exc:
                instance.ownership_change_in_progress = False
                instance.process = process
                instance.status = "running"
                self._event(
                    run,
                    "cancel_failed",
                    node=state.state_id,
                    entry=entry.index,
                    instance=instance.index,
                    error=str(exc),
                )
            else:
                instance.ownership_change_in_progress = False
                instance.status = "cancelled"
                self._event(run, "cancelled", node=state.state_id, entry=entry.index, instance=instance.index)
                if run.state == "stopping":
                    await self._finish_stop_if_quiescent(run, "stopped")
            return "stopped"
        instance.ownership_change_in_progress = False
        instance.process = process
        instance.spawned_at = self._now_fn()
        instance.deadline = instance.spawned_at + self._python_limit_ms(run, state) / 1000
        instance.status = "running"
        self._event(
            run,
            "started",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            attempt=instance.attempt,
        )
        return "admitted"

    def _python_limit_ms(self, run: FactoryRun, state: _StateRun) -> int:
        """A python call's time limit: the state's budget_ms, else the run's,
        else the default."""
        return state.spec.get("budget_ms") or run.run_budget_ms or PYTHON_STATE_TIMEOUT_MS_DEFAULT

    async def _wait_python(self, calls: list[_NodeInstance]) -> None:
        """Wait for the first python call to exit, bounded by the nearest
        time limit and the collect poll timeout."""
        import asyncio

        nearest = min(instance.deadline for instance in calls)
        timeout = min(max(nearest - self._now_fn(), 0.0), POLL_TIMEOUT_MS / 1000)
        waits = [asyncio.ensure_future(instance.process.proc.wait()) for instance in calls]
        _, pending = await asyncio.wait(waits, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        for wait in pending:
            wait.cancel()

    async def _apply_python_exit(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance
    ) -> None:
        """Settle one python call that exited or ran past its time limit."""
        process = instance.process
        if instance.status != "running" or process is None or instance.ownership_change_in_progress:
            return
        assert instance.spawned_at is not None
        instance.duration_ms = int((self._now_fn() - instance.spawned_at) * 1000)
        if process.proc.returncode is None:
            # Past its time limit: the limit is spent, but ownership stays
            # here if stopping the process cannot be confirmed.
            instance.ownership_change_in_progress = True
            try:
                await process.stop()
            except Exception as exc:
                instance.ownership_change_in_progress = False
                self._event(
                    run,
                    "cancel_failed",
                    node=state.state_id,
                    entry=entry.index,
                    instance=instance.index,
                    error=str(exc),
                )
                if run.state == "stopping":
                    await self._finish_stop_if_quiescent(run, "stopped")
                return
            instance.ownership_change_in_progress = False
            instance.process = None
            await self._apply_instance_failure(
                run,
                state,
                entry,
                instance,
                f"python state time limit {self._python_limit_ms(run, state)}ms exceeded",
                retry=False,
            )
            if run.state == "stopping":
                await self._finish_stop_if_quiescent(run, "stopped")
            return
        instance.process = None
        stdout, stderr = process.finish()
        run.settle_count += 1
        returncode = process.proc.returncode
        if returncode != 0:
            detail = f": {stderr}" if stderr else ""
            await self._apply_instance_failure(
                run, state, entry, instance, f"python state exited with code {returncode}{detail}", retry=True
            )
            return
        outputs = _python_outputs(state.spec, stdout)
        if isinstance(outputs, str):
            await self._apply_instance_failure(run, state, entry, instance, outputs, retry=True)
            return
        if "emit" in state.spec:
            # The same Rust check a child's emit passes through.
            from . import host_request

            try:
                await host_request("factory.check", {"contract": state.spec["emit"], "outputs": outputs})
            except RuntimeError as error:
                if entry.status != "running":
                    return
                await self._apply_instance_failure(
                    run, state, entry, instance, f"python state output: {error}", retry=True
                )
                return
            if entry.status != "running":
                return
        instance.status = "done"
        instance.answer = json.dumps(outputs, separators=(",", ":"))[:ANSWER_BINDING_CAP]
        self._event(
            run,
            "settled",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            status="done",
            duration_ms=instance.duration_ms,
        )
        self._event(
            run,
            "answer_captured",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            answer=instance.answer[:ANSWER_CAPTURE_CAP],
            stage="arrived",
        )
        entry.answer = instance.answer
        entry.outputs = outputs
        entry.output_errors = {}
        entry.status = "done"
        self._queue_settle(run, state, entry)

    # -- settlement, retries, policies ---------------------------------------

    async def _apply_settlement(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, result: Any
    ) -> None:
        if instance.status != "running" or instance.ownership_change_in_progress or run.state in ("stopping", "stopped"):
            return  # retirement or cancellation claimed the child while collect was in flight
        if result.status == "error" and _is_infra_error(result.error or ""):
            # A worker death or a lost supervisor link is infra, not the
            # task's failure: the executor verifies it itself (a short
            # quiet period, then one re-read through the supervisor)
            # instead of failing the entry on the first error row and
            # flagging the parent to do the verifying.
            fresh = await self._recheck_infra_death(instance, result)
            if fresh is None:
                return  # a stop/fail_fast pass claimed it, or the worker answered
            result = fresh
            if result.factory_task_busy is not None:
                instance.factory_task_activity = "busy" if result.factory_task_busy else "idle"
            if (
                entry.status == "running"
                and not instance.infra_respawned
                and result.status == "error"
                and _is_infra_error(result.error or "")
            ):
                await self._respawn_infra_dead(run, state, entry, instance, result)
                return
            # otherwise: a second verified death (or an entry a sibling
            # failed first) takes the normal retries/policy path below
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
            # The exit capture (the M4 class): an exited child's last
            # assistant text — whatever the exit envelope carried — is a
            # PROVISIONAL answer. The child may have finished its work and
            # died without reporting; the answer is preserved on the
            # instance and the state reads needs-verify instead of silently
            # counting the exit as settled work.
            exit_answer = (
                (result.answer_text or result.answer_preview or "")[:ANSWER_BINDING_CAP] or None
            )
            if exit_answer:
                instance.answer = exit_answer
                instance.provisional = True
                instance.capture_failed = False  # the preserved text is an exit now
            # Child failures retry (same rendered prompt, attempts+1) while
            # attempts remain; then the entry failure_policy applies.
            await self._apply_instance_failure(run, state, entry, instance, child_reason, retry=True)
            return
        budget_ms = state.spec.get("budget_ms")
        if budget_ms is not None:
            # The budget measures the CHILD'S OWN run time (the collect
            # result's duration), not the wall between admission and the
            # executor seeing the settle: a paused run does not collect,
            # so a child that finished inside its budget while the run
            # waited on the owner must not lose finished work to a wall
            # reading that includes the pause (probe C: a 20-minute
            # review that sat out a 2-hour escalate pause read 140
            # minutes against a 60-minute budget and was thrown away).
            # A zero/absent duration (an infra-dead re-read) falls back
            # to the wall reading.
            elapsed_ms = instance.duration_ms
            if not elapsed_ms and instance.spawned_at is not None:
                elapsed_ms = (self._now_fn() - instance.spawned_at) * 1000
            if elapsed_ms and elapsed_ms > budget_ms:
                # The child's own run time exceeded: the budget is spent,
                # so no retry; the failure_policy applies.
                await self._apply_instance_failure(
                    run,
                    state,
                    entry,
                    instance,
                    f"state budget_ms {budget_ms} exceeded ({int(elapsed_ms)}ms of child run time)",
                    retry=False,
                )
                return
        instance.status = "done"
        # The binding lane first: the collect envelope's full final answer
        # keeps the whole fenced JSON; the 160-character roster preview is
        # the fallback (older hosts, a capture that raced a worker
        # teardown). Both are capped locally at ANSWER_BINDING_CAP.
        instance.answer = (
            (result.answer_text or result.answer_preview or "")[:ANSWER_BINDING_CAP] or None
        )
        instance.provisional = False  # a real settle supersedes any exit capture
        instance.capture_failed = False
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
                answer=instance.answer[:ANSWER_CAPTURE_CAP],
                stage="arrived",
            )
        if entry.status == "running" and entry.instances and all(i.status == "done" for i in entry.instances):
            entry.answer = self._entry_answer(entry)
            if "emit" in state.spec:
                await self._settle_emitted(run, state, entry)
                return
            capture_failure = await self._capture_outputs(run, state, entry)
            failed = [instance]
            if entry.status != "running":
                return  # a stop()/fail_fast pass claimed the entry mid-capture
            if capture_failure is not None:
                # A declared output that never bound after the capture
                # retry is the producing entry's task failure, not a silent
                # valueless settle: no settle is queued (a dependent never
                # enters on an unbound required input), retries then
                # failure_policy apply, and the answer stays provisional
                # for needs_verify if the entry fails permanently. A
                # foreach entry retries each instance that omitted a
                # required port, not only the last one to settle.
                # Every omitted instance is error before the first failure
                # can publish an escalate pause: a resume() during that
                # pause notice re-admits all of them, not only the first.
                for failed_instance in failed:
                    failed_instance.status = "error"
                    failed_instance.provisional = True
                    failed_instance.capture_failed = True
                generation = run.loop_generation
                for failed_instance in failed:
                    await self._apply_instance_failure(
                        run, state, entry, failed_instance, capture_failure, retry=True
                    )
                    if run.loop_generation != generation:
                        return  # resume() re-admitted the entry; this list is stale
                    # Once one instance spent its retries and failed the
                    # entry, the other omitted instances still settle as
                    # errors under the same failure.
                    if entry.status not in ("running", "error"):
                        return
                return
            entry.status = "done"
            self._queue_settle(run, state, entry)

    async def _recheck_infra_death(self, instance: _NodeInstance, result: Any) -> Any:
        """Liveness-verify one infra-flavoured error settle before it is
        applied.

        The supervisor reports a dead worker as a one-shot error settle, so
        the executor re-reads the worker after a short quiet period instead
        of trusting the first row. Returns the fresh result to apply -- a
        settle that landed meanwhile supersedes the error, and the same
        error read back means the death is verified -- or ``None`` when a
        concurrent pass (stop(), fail_fast) claimed the instance or the
        worker answered alive (the loop keeps collecting it).
        """
        from . import collect

        child_id = instance.child_id
        await self._sleep_fn(INFRA_VERIFY_QUIET_SECONDS)
        if instance.status != "running" or instance.child_id != child_id:
            return None  # a stop, fail_fast, or resumed lane claimed the instance
        results = await collect([child_id], timeout_ms=0)
        if instance.status != "running" or instance.child_id != child_id:
            return None
        row = next((r for r in results if r.rlm_child_id == child_id), None)
        if row is not None and not row.settled:
            return None  # the worker answered: alive, keep collecting it
        # No fresh row at all means the child vanished from the supervisor
        # (a hand delete): as dead as the error said, so the original
        # settle applies through the normal failure path.
        return row or result

    async def _respawn_infra_dead(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, result: Any
    ) -> None:
        """Re-spawn one worker the executor verified dead, free of charge.

        Infra is not the task's failure: the dead attempt counts as a
        settle (its ledger row keeps the error), but the instance is
        re-queued with the same rendered prompt -- spending neither a
        ``retries`` slot nor a fresh ``max_entries`` entry -- and the dead
        attempt's exit text is dropped, so no needs-verify mark is raised
        for work the respawn redoes. ``infra_respawned`` keeps this to ONE
        free respawn; a second verified death falls through to the normal
        retries/failure_policy path.
        """
        from . import delete_subagent

        old_child = instance.child_id or ""
        instance.ownership_change_in_progress = True
        try:
            await delete_subagent(old_child)
        except Exception as exc:
            instance.ownership_change_in_progress = False
            self._event(
                run,
                "cancel_failed",
                node=state.state_id,
                entry=entry.index,
                instance=instance.index,
                child=old_child,
                error=str(exc),
            )
            await self._apply_instance_failure(
                run,
                state,
                entry,
                instance,
                f"worker retirement failed before infra respawn: {exc}",
                retry=False,
            )
            if run.state == "stopping":
                await self._finish_stop_if_quiescent(run, "stopped")
            return
        instance.ownership_change_in_progress = False
        instance.child_id = None
        instance.session_dir = None
        instance.child_name = None
        instance.factory_task_activity = "idle"
        if instance.status != "running" or run.state not in ("running", "paused"):
            if run.state == "stopping":
                await self._finish_stop_if_quiescent(run, "stopped")
            return  # a stop()/fail_fast pass claimed the instance mid-delete
        # A sibling may have paused the run in this same collect batch.
        # Preserve the verified death as pending; resume admits it for free
        # instead of collecting the deleted child again.
        instance.duration_ms = result.duration_ms
        instance.tool_uses = result.tool_use_count or 0
        run.settle_count += 1
        run.tool_use_total += instance.tool_uses
        instance.infra_respawned = True
        instance.retry_base += 1
        instance.status = "pending"
        instance.error = None
        instance.answer = None
        instance.provisional = False
        instance.capture_failed = False
        reason = result.error or "child worker unreachable"
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
        self._event(
            run,
            "infra_respawn",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            detail=(
                f"worker verified dead ({reason}); re-spawning the same rendered prompt "
                "once (no retry, no max_entries)"
            ),
        )

    def _entry_answer(self, entry: _StateEntry) -> str | None:
        """Captured answer for binding: one preview, or all instances joined."""
        answers = [instance.answer for instance in entry.instances if instance.status == "done" and instance.answer]
        if not answers:
            return None
        return "\n\n".join(answers)

    def _emitted_outputs(self, state: _StateRun, entry: _StateEntry) -> "dict[int, list[str]]":
        """Read each instance's emitted outputs into ``entry.outputs``;
        answer the required ports each instance still owes.

        A foreach entry gathers one value per item: text ports join with
        blank lines, every other port becomes a list in item order.
        """
        declared = state.spec["emit"].get("outputs") or []
        required = [out["name"] for out in declared if not str(out.get("type", "")).endswith("?")]
        kinds = _declared_port_types(state.spec, "outputs")
        per_instance: list[dict[str, Any]] = []
        owed: dict[int, list[str]] = {}
        for instance in entry.instances:
            emitted: dict[str, Any] = {}
            if instance.session_dir is not None:
                try:
                    loaded = json.loads((Path(instance.session_dir) / FACTORY_OUTPUTS_FILE).read_text("utf-8"))
                    emitted = loaded if isinstance(loaded, dict) else {}
                except (OSError, ValueError):
                    emitted = {}
            per_instance.append(emitted)
            missing = [name for name in required if name not in emitted]
            if missing:
                owed[instance.index] = missing
        if state.spec.get("foreach") is None:
            entry.outputs = per_instance[0] if per_instance else {}
        else:
            entry.outputs = {}
            for out in declared:
                values = [emitted[out["name"]] for emitted in per_instance if out["name"] in emitted]
                if values:
                    entry.outputs[out["name"]] = (
                        "\n\n".join(str(value) for value in values)
                        if kinds.get(out["name"]) == "text"
                        else values
                    )
        entry.output_errors = {}
        return owed

    async def _settle_emitted(self, run: FactoryRun, state: _StateRun, entry: _StateEntry) -> None:
        """Settle an emit state's entry from what its children emitted.

        Settled means told: every required port carries an accepted value.
        A child that ended its turn still owing a port gets one repair
        message in the same session; it is never replaced by a fresh child
        (two writers in one worktree). When that repair turn ends, a child
        that still owes a port fails the entry with ``missing_output``,
        without a retry.
        """
        owed = self._emitted_outputs(state, entry)
        if not owed:
            entry.status = "done"
            self._queue_settle(run, state, entry)
            return
        for instance in entry.instances:
            missing = owed.get(instance.index)
            if missing is None:
                continue
            if instance.repair_sent:
                await self._apply_instance_failure(
                    run,
                    state,
                    entry,
                    instance,
                    f"missing_output: the child still owes {', '.join(missing)} after a repair request",
                    retry=False,
                )
                return
            reason = await self._request_repair(run, state, entry, instance, missing)
            if reason is not None:
                await self._apply_instance_failure(run, state, entry, instance, reason, retry=False)
                return

    async def _request_repair(
        self,
        run: FactoryRun,
        state: _StateRun,
        entry: _StateEntry,
        instance: _NodeInstance,
        missing: list[str],
    ) -> str | None:
        """Steer the settled child once to emit what it owes; ``None`` when
        the message went out, else the failure reason."""
        from . import host_request

        calls = ", ".join(f"{name}=..." for name in missing)
        message = (
            f"You ended your turn without handing back {', '.join(missing)}. "
            f"Call `await rlm.factory.emit({calls})` from your Python REPL now; "
            "the call checks each value and names any field to fix."
        )
        child_id = instance.child_id
        try:
            await host_request(
                "agent_message.send",
                {"message": message, "receiver_role": "child", "receiver_name": instance.child_name},
            )
        except RuntimeError as error:
            if (
                instance.child_id != child_id
                or instance.ownership_change_in_progress
                or run.state != "running"
            ):
                return None
            return f"missing_output: {', '.join(missing)}, and the repair message failed: {error}"
        if (
            instance.child_id != child_id
            or instance.ownership_change_in_progress
            or run.state != "running"
        ):
            return None
        instance.repair_sent = True
        instance.status = "running"
        self._event(
            run,
            "repair_requested",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            detail=f"owes {', '.join(missing)}",
        )
        return None

    async def _pause_for_unverified_task_activity(
        self, run: FactoryRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance
    ) -> None:
        if run.state != "running":
            return
        instance.factory_task_activity = "unverified"
        reason = (
            f"factory task activity UNVERIFIED for {state.state_id}; "
            f"child ownership remains with {instance.child_id or 'this instance'}"
        )
        self._event(
            run,
            "factory_task_activity_unverified",
            node=state.state_id,
            entry=entry.index,
            instance=instance.index,
            child=instance.child_id,
            detail=reason,
        )
        await self._pause(
            run,
            reason,
            "paused",
            f"{reason}; resume with await rlm.factory.resume('{run.run_id}')",
            node=state.state_id,
        )

    async def _poll_repair(
        self,
        run: FactoryRun,
        state: _StateRun,
        entry: _StateEntry,
        instance: _NodeInstance,
        *,
        task_busy: bool | None,
    ) -> None:
        """Decide a repair when its turn ends: the child reads idle again
        (the queued repair message keeps it busy until its turn starts).
        Emitted means done; anything still owed fails with ``missing_output``."""
        if (
            instance.status != "running"
            or instance.ownership_change_in_progress
            or run.state in ("stopping", "stopped")
        ):
            return
        instance.factory_task_activity = (
            "busy" if task_busy is True else "idle" if task_busy is False else "unverified"
        )
        owed = self._emitted_outputs(state, entry).get(instance.index)
        if owed is None:
            instance.status = "done"
            self._event(run, "repaired", node=state.state_id, entry=entry.index, instance=instance.index)
            if entry.status == "running" and all(i.status == "done" for i in entry.instances):
                await self._settle_emitted(run, state, entry)
            return
        if task_busy is None:
            await self._pause_for_unverified_task_activity(run, state, entry, instance)
            return
        if not task_busy:
            await self._apply_instance_failure(
                run,
                state,
                entry,
                instance,
                f"missing_output: the child still owes {', '.join(owed)} after a repair request",
                retry=False,
            )

    def _capture_ports(self, state: _StateRun, entry: _StateEntry) -> None:
        """Capture the state's declared output ports from the entry's answer.

        Text ports keep the captured string; json ports parse as in V1
        binding, with the parse error recorded on the settle so a reader
        (guard or input binding) fails deterministically instead of
        re-parsing. A capture cut at the binding cap names the size and the
        cap in the parse error.
        """
        outputs: dict[str, Any] = {}
        errors: dict[str, str] = {}
        truncated_at = (
            len(entry.answer) if entry.answer is not None and len(entry.answer) >= ANSWER_BINDING_CAP else None
        )
        for out in state.spec.get("outputs") or []:
            name, port_type = out.get("name"), out.get("type")
            if port_type == "text":
                if entry.answer is not None:
                    outputs[name] = entry.answer
                continue
            if entry.answer is None:
                continue
            parsed, error = _parse_json_output(entry.answer, name, truncated_at=truncated_at)
            if error is None:
                outputs[name] = parsed
            else:
                errors[name] = error
        entry.outputs = outputs
        entry.output_errors = errors

    async def _capture_outputs(self, run: FactoryRun, state: _StateRun, entry: _StateEntry) -> str | None:
        """Capture the settle's outputs, retrying the capture once.

        A settle can race the child's answer capture on the host side (a
        ``None`` answer recovers on a later refresh), and a declared port
        that binds no value from the first capture is exactly the M2
        silent-failure class: the downstream would run on nothing. When a
        declared output binds no value, the settled children are
        refreshed in one bounded capture window (a settled child keeps its
        result until deleted; missing text waits for the worker hand-off),
        and the capture re-runs over the refreshed answers; a port that
        still binds nothing records a deterministic capture failure in the
        ledger (``output_capture_failed``) and fails the entry -- its
        joined port errors return as the task-failure reason, ``None``
        when every declared port bound a value.
        """
        self._capture_ports(state, entry)
        declared = state.spec.get("outputs") or []
        # Presence, not truthiness: a port that parsed as JSON null is a
        # captured value (a downstream binding reads null from it), so the
        # retry condition and the failure report check the KEY, never the
        # value — a null output never reads as unbound.
        if not declared or not any(
            out.get("name") not in (entry.outputs or {}) for out in declared
        ):
            return None  # every declared port bound a value
        refreshed = await self._refresh_entry_answers(run, state, entry)
        if refreshed:
            self._capture_ports(state, entry)
        failures = []
        for out in declared:
            name = out.get("name")
            error = (entry.output_errors or {}).get(name)
            if error is None and name not in (entry.outputs or {}):
                error = f"output {name!r} captured no value from the upstream answer"
            if error is not None:
                self._event(
                    run,
                    "output_capture_failed",
                    node=state.state_id,
                    entry=entry.index,
                    port=name,
                    error=error,
                    detail=f"output {name!r} did not bind after one capture retry",
                )
                failures.append(error)
        return "; ".join(failures) or None

    async def _refresh_entry_answers(self, run: FactoryRun, state: _StateRun, entry: _StateEntry) -> bool:
        """Refresh settled answers, waiting one bounded poll window for a
        missing hand-off. Returns whether any answer changed."""
        from . import collect

        child_ids = [
            instance.child_id
            for instance in entry.instances
            if instance.child_id is not None and instance.status == "done"
        ]
        if not child_ids:
            return False
        # An idle worker may expose its settle before handing off its final
        # assistant text. Give that missing capture one bounded poll window;
        # existing nonempty (but invalid) output still gets only one refresh.
        deadline = self._now_fn() + POLL_TIMEOUT_MS / 1000
        changed = False
        while entry.status == "running":
            try:
                results = await collect(child_ids, timeout_ms=0)
            except Exception as exc:
                self._event(
                    run,
                    "output_capture_failed",
                    node=state.state_id,
                    entry=entry.index,
                    error=f"capture retry could not re-collect the settled children: {exc}",
                    detail="the first capture stands",
                )
                return changed
            if entry.status != "running":
                return changed  # stop/fail_fast claimed the entry during collect
            by_child = {result.rlm_child_id: result for result in results}
            for instance in entry.instances:
                result = by_child.get(instance.child_id or "")
                if result is None:
                    continue
                answer = (result.answer_text or result.answer_preview or "")[:ANSWER_BINDING_CAP] or None
                if answer and (instance.answer is None or len(answer) > len(instance.answer)):
                    instance.answer = answer
                    changed = True
            if changed:
                entry.answer = self._entry_answer(entry)
            missing = any(
                instance.status == "done" and instance.child_id is not None and not instance.answer
                for instance in entry.instances
            )
            remaining = deadline - self._now_fn()
            if not missing or remaining <= 0:
                return changed
            await self._sleep_fn(min(0.05, remaining))
        return changed

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
        # entry. ``attempt - retry_base`` charges only the admissions
        # since the last budget reset: an infra respawn and a resume's
        # re-admission restart the declared retries without zeroing the
        # spawn counter the labels count on.
        if (
            retry
            and instance.attempt - instance.retry_base <= retries
            and entry.status == "running"
        ):
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
        # The verify mark is oversight, not failure-policy bookkeeping: a
        # later foreach sibling can exit with a provisional answer AFTER
        # the entry already went terminal (a sibling failed it first), so
        # the check runs BEFORE the terminal guard -- the guard would
        # otherwise swallow the late exit's signal, leaving the captured
        # answer invisible in every needs_verify surface.
        # entry.needs_verify keeps the mark and its event one-shot per entry.
        if not entry.needs_verify and any(
            instance.provisional and instance.answer for instance in entry.instances
        ):
            # An exit with a provisional answer is distinguishable from
            # completed work only through the verify mark: the entry keeps
            # its error verdict, but the preserved answer and the
            # status-level needs_verify signal hand the operator the
            # revival-race decision instead of a silent drop.
            entry.needs_verify = True
            # The detail names what the mark preserves: a settle whose
            # declared output never bound, a respawned worker's last words
            # after its own death, or a plain child exit. The capture mark
            # is checked first: ``infra_respawned`` outlives its respawn,
            # so a respawned attempt that later settles and fails capture
            # preserves the capture's provenance, not the old death's.
            respawned = any(instance.infra_respawned for instance in entry.instances)
            capture_failed = any(instance.capture_failed for instance in entry.instances)
            if capture_failed:
                detail = (
                    "output capture failed; the settled answer is preserved as a "
                    "provisional answer - fix the declared output or verify by hand"
                )
            elif respawned:
                detail = (
                    "worker verified dead by the executor after its automatic respawn; "
                    "last assistant text preserved as a provisional answer"
                )
            else:
                detail = "child exit captured a provisional answer - verify the remote state"
            self._event(run, "needs_verify", node=state.state_id, entry=entry.index, detail=detail)
        if entry.status in TERMINAL_ENTRY_STATUSES:
            return  # the policy already ran for this entry
        policy = state.spec.get("failure_policy", RUN_FAILURE_POLICY_DEFAULT)
        entry.status = "error"
        entry.error = reason
        state.error = reason
        run.last_error = f"state {state.state_id!r} failed: {reason}"
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
        if policy != "escalate":
            # The failed entry settles: guard-less transitions (the compiled
            # dag's depends_on edges) fire from error settles so dependents
            # run. Escalate instead HOLDS the failed entry unsettled -- the
            # pause lands before the failure propagates, no downstream entry
            # budget is spent on it, and resume() re-admits the entry as a
            # fresh attempt.
            self._queue_settle(run, state, entry)
        if run.state != "running":
            # stop() (or another transition) owns the run state now; keep the
            # entry's error but do not overwrite the final state.
            return
        if policy == "fail_fast":
            await self._halt_nonterminal(run, "run failed (fail_fast)")
            if run.state != "running":
                return  # stop() landed during the cancellations; it wins
            if self._has_unresolved_actor(run):
                await self._pause(
                    run,
                    "child retirement failed; the actor remains owned by this run",
                    "paused",
                    "failure cascade could not confirm child retirement; resume after the child is safe to replace",
                    node=state.state_id,
                )
                return
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
            await self._pause(
                run,
                reason,
                "paused",
                f"state {state.state_id} failed: {reason}; resume with await rlm.factory.resume('{run.run_id}') "
                "to re-admit the failed entry as a fresh attempt",
                node=state.state_id,
            )

    async def _complete_stop(self, run: FactoryRun, detail: str) -> list[str]:
        """Cancel non-terminal actors and report stopped only after retirement."""
        return await self._halt_nonterminal(run, "run stopped", detail=detail)

    def _has_unresolved_actor(self, run: FactoryRun) -> bool:
        return any(
            instance.ownership_change_in_progress
            or instance.process is not None and instance.status == "running"
            or instance.child_id is not None
            and (
                instance.status in ("pending", "running")
                or instance.factory_task_activity in ("busy", "unverified")
            )
            for state in run.states.values()
            for entry in state.entries
            for instance in entry.instances
        )

    def _factory_task_owners(
        self, run: FactoryRun
    ) -> list[tuple[_StateRun, _StateEntry, _NodeInstance]]:
        owners = []
        for state_id in run.order:
            state = run.states[state_id]
            if state.lifecycle == "resident":
                continue
            owners.extend(
                (state, entry, instance)
                for entry in state.entries
                for instance in entry.instances
                if instance.status != "running"
                and instance.child_id is not None
                and instance.factory_task_activity in ("busy", "unverified")
            )
        return owners

    def _mark_stopped_entries(self, run: FactoryRun, reason: str) -> list[str]:
        stopped: list[str] = []
        for state_id in run.order:
            state = run.states[state_id]
            was_nonterminal = any(entry.status in ("pending", "running") for entry in state.entries) or (
                not state.entries and state.status == "pending"
            )
            for entry in state.entries:
                if entry.status not in ("pending", "running"):
                    continue
                for instance in entry.instances:
                    if (
                        instance.status == "pending"
                        and instance.child_id is None
                        and instance.process is None
                        and not instance.ownership_change_in_progress
                    ):
                        instance.status = "cancelled"
                        self._event(
                            run,
                            "cancelled",
                            node=state_id,
                            entry=entry.index,
                            instance=instance.index,
                            detail="cancelled before admission",
                        )
                if any(
                    instance.ownership_change_in_progress
                    or instance.process is not None and instance.status == "running"
                    or instance.child_id is not None
                    and (
                        instance.status in ("pending", "running")
                        or instance.factory_task_activity in ("busy", "unverified")
                    )
                    for instance in entry.instances
                ):
                    continue
                entry.status = "cancelled"
                self._event(run, "node_cancelled", node=state_id, entry=entry.index, detail=reason)
            if was_nonterminal and all(entry.status not in ("pending", "running") for entry in state.entries):
                state.cancelled = True
                stopped.append(state_id)
        return stopped

    async def _finish_stop_if_quiescent(
        self, run: FactoryRun, detail: str, *, stopped: list[str] | None = None
    ) -> bool:
        if run.state != "stopping" or self._has_unresolved_actor(run):
            return False
        stopped = self._mark_stopped_entries(run, "run stopped") if stopped is None else stopped
        if self._has_unresolved_actor(run):
            return False
        run.state = "stopped"
        self._event(run, "run_stopped", detail=f"{detail}; {len(stopped)} state(s) cancelled")
        self._touch(run)
        self._evict_terminal_runs()
        return True

    async def _halt_nonterminal(
        self, run: FactoryRun, reason: str, *, detail: str = "stopped"
    ) -> list[str]:
        """Retire every owned actor, preserving entries whose deletion failed."""
        await self._cancel_running(run)
        stopped = self._mark_stopped_entries(run, reason)
        if run.state == "stopping":
            await self._finish_stop_if_quiescent(run, detail, stopped=stopped)
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
        instance.ownership_change_in_progress = True
        try:
            await delete_subagent(child_id)
        except Exception as exc:
            instance.ownership_change_in_progress = False
            self._event(
                run,
                "cancel_failed",
                node=state.state_id,
                entry=entry.index,
                instance=instance.index,
                child=child_id,
                error=str(exc),
            )
            instance.status = "running"
        else:
            instance.ownership_change_in_progress = False
            instance.factory_task_activity = "idle"
            instance.status = "cancelled"
            self._event(run, "cancelled", node=state.state_id, entry=entry.index, instance=instance.index, child=child_id)
            if run.state == "stopping":
                await self._finish_stop_if_quiescent(run, "stopped")

    async def _cancel_python(self, run: FactoryRun) -> None:
        """Stop executor-owned calls when the run stops or its control lane fails."""
        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                for instance in entry.instances:
                    if (
                        instance.status != "running"
                        or instance.process is None
                        or instance.ownership_change_in_progress
                    ):
                        continue
                    process = instance.process
                    instance.ownership_change_in_progress = True
                    try:
                        await process.stop()
                    except Exception as exc:
                        instance.ownership_change_in_progress = False
                        self._event(
                            run,
                            "cancel_failed",
                            node=state_id,
                            entry=entry.index,
                            instance=instance.index,
                            error=str(exc),
                        )
                    else:
                        instance.ownership_change_in_progress = False
                        instance.process = None
                        instance.status = "cancelled"
                        if entry.status == "running" and all(
                            other.status not in ("pending", "running", "error")
                            and other.process is None
                            and other.child_id is None
                            and not other.ownership_change_in_progress
                            for other in entry.instances
                        ):
                            entry.status = "cancelled"
                        self._event(run, "cancelled", node=state_id, entry=entry.index, instance=instance.index)

    async def _cancel_running(self, run: FactoryRun) -> None:
        from . import delete_subagent

        await self._cancel_python(run)
        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                for instance in entry.instances:
                    if (
                        instance.child_id is None
                        or (
                            instance.status not in ("pending", "running")
                            and instance.factory_task_activity not in ("busy", "unverified")
                        )
                        or instance.ownership_change_in_progress
                    ):
                        continue
                    child_id = instance.child_id
                    instance.ownership_change_in_progress = True
                    try:
                        await delete_subagent(child_id)
                    except Exception as exc:
                        instance.ownership_change_in_progress = False
                        self._event(
                            run,
                            "cancel_failed",
                            node=state_id,
                            entry=entry.index,
                            instance=instance.index,
                            child=child_id,
                            error=str(exc),
                        )
                    else:
                        instance.ownership_change_in_progress = False
                        instance.factory_task_activity = "idle"
                        instance.status = "cancelled"
                        self._event(run, "cancelled", node=state_id, entry=entry.index, instance=instance.index, child=child_id)

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
        if run.pending_evaluations or self._factory_task_owners(run):
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
            self._evict_terminal_runs()
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
        self._evict_terminal_runs()

    # -- control loop --------------------------------------------------------

    def _start_loop(self, run: FactoryRun) -> None:
        # Called from run()/resume() and the rehydrated re-arm, all awaited
        # inside a running asyncio loop, so get_running_loop() always finds
        # it.
        import asyncio

        run.task = asyncio.get_running_loop().create_task(
            self._control_loop(run, run.loop_generation)
        )

    async def _control_loop(self, run: FactoryRun, generation: int) -> None:
        import asyncio

        try:
            await self._loop_body(run, generation)
            self._persist_run(run)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A dead bridge or host failure must not wedge the run silently;
            # children stay alive under the supervisor either way. A stop()
            # that landed concurrently keeps ownership of the final state.
            from .repl import teardown_started

            self._event(run, "executor_error", error=f"{type(exc).__name__}: {exc}")
            if teardown_started():
                # The kernel's own shutdown tore the host bridge down while
                # the run was in flight: an interruption, not a verdict. The
                # run stays nonterminal — its durable snapshot keeps the last
                # true state and the boot arm re-arms it at the next kernel
                # boot — exactly what a hard SIGKILL leaves behind, so a
                # graceful shutdown is never worse than a kill.
                return
            if run.state == "running":
                run.state = "failed"
                # Child agents remain supervisor-owned; these subprocesses
                # have no owner or deadline enforcer after this lane exits.
                await self._cancel_python(run)
                try:
                    await self._milestone(run, "failed", f"executor error: {exc}")
                except Exception:
                    pass
                self._persist_run(run)

    async def _loop_body(self, run: FactoryRun, generation: int) -> None:
        import asyncio

        from . import collect

        # The generation re-checks after every await are the resume-race
        # fix: a resume() that lands while this task is suspended at an
        # await (an in-flight collect or milestone) bumps the generation,
        # so this task exits at its next check instead of continuing as a
        # second concurrent control loop.
        while self._loop_alive(run, generation):
            # The iteration boundary is a consistent point: every settle the
            # last iteration applied is complete before the loop waits again.
            self._persist_run(run)
            in_flight = [
                (run.states[state_id], entry, instance)
                for state_id in run.order
                for entry in run.states[state_id].entries
                for instance in entry.instances
                if instance.status == "running"
            ]
            task_owners = self._factory_task_owners(run)
            owner_polls = [item for item in task_owners if item[2].status != "running"]
            active_work = in_flight + owner_polls
            repairing = [item for item in in_flight if item[2].repair_sent]
            children = [
                item for item in in_flight if item[2].child_id is not None and not item[2].repair_sent
            ]
            python_calls = [item for item in in_flight if item[2].process is not None]
            results_by_child: dict[str, Any] = {}
            task_work_waiting = False
            if children or owner_polls:
                # A child poll must not postpone a concurrent Python call's deadline.
                timeout_ms = POLL_TIMEOUT_MS
                if repairing:
                    timeout_ms = min(timeout_ms, int(REPAIR_POLL_SECONDS * 1000))
                if python_calls:
                    nearest = min(instance.deadline for _, _, instance in python_calls)
                    timeout_ms = min(timeout_ms, max(0, math.ceil((nearest - self._now_fn()) * 1000)))
                results = await collect(
                    [instance.child_id for _, _, instance in children + repairing + owner_polls],
                    timeout_ms=timeout_ms,
                )
                results_by_child = {result.rlm_child_id: result for result in results}
            elif python_calls:
                await self._wait_python([instance for _, _, instance in python_calls])
                if repairing:
                    results = await collect(
                        [instance.child_id for _, _, instance in repairing], timeout_ms=0
                    )
                    results_by_child = {result.rlm_child_id: result for result in results}
            elif repairing:
                await self._sleep_fn(REPAIR_POLL_SECONDS)
                results = await collect([instance.child_id for _, _, instance in repairing], timeout_ms=0)
                results_by_child = {result.rlm_child_id: result for result in results}
            for state, entry, instance in children:
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
                result = results_by_child.get(instance.child_id or "")
                if result is None:
                    continue
                if not result.settled:
                    if result.factory_task_busy is not None:
                        instance.factory_task_activity = "busy" if result.factory_task_busy else "idle"
                    continue
                instance.factory_task_activity = (
                    "busy" if result.factory_task_busy is True else
                    "idle" if result.factory_task_busy is False else
                    "unverified"
                )
                missing = (
                    self._emitted_outputs(state, entry).get(instance.index)
                    if state.spec.get("emit") is not None
                    else None
                )
                if state.spec.get("emit") is not None and missing:
                    if result.factory_task_busy is None and state.lifecycle != "resident":
                        await self._pause_for_unverified_task_activity(run, state, entry, instance)
                        return
                    if result.factory_task_busy is True:
                        task_work_waiting = True
                        continue
                await self._apply_settlement(run, state, entry, instance, result)
                if result.factory_task_busy is True and state.lifecycle != "resident":
                    task_work_waiting = True
                if instance.factory_task_activity == "unverified" and state.lifecycle != "resident":
                    await self._pause_for_unverified_task_activity(run, state, entry, instance)
                    return
            for state, entry, instance in owner_polls:
                if run.loop_generation != generation:
                    return
                result = results_by_child.get(instance.child_id or "")
                if result is None or not result.settled or result.factory_task_busy is None:
                    instance.factory_task_activity = "unverified"
                    await self._pause_for_unverified_task_activity(run, state, entry, instance)
                    return
                instance.factory_task_activity = "busy" if result.factory_task_busy else "idle"
                task_work_waiting = task_work_waiting or result.factory_task_busy
            child_still_running = any(
                not result.settled
                for _, _, instance in children
                if (result := results_by_child.get(instance.child_id or "")) is not None
            )
            if task_work_waiting and not child_still_running and not python_calls and not repairing:
                # Every collected child read settled, so the collect returned
                # without waiting; a still-running child's collect already waited.
                await self._sleep_fn(REPAIR_POLL_SECONDS)
            for state, entry, instance in repairing:
                if run.loop_generation != generation:
                    return
                result = results_by_child.get(instance.child_id or "")
                await self._poll_repair(
                    run,
                    state,
                    entry,
                    instance,
                    task_busy=None if result is None else result.factory_task_busy,
                )
            for state, entry, instance in python_calls:
                if run.loop_generation != generation:
                    return
                process = instance.process
                if instance.status != "running" or process is None:
                    continue  # stop()/fail_fast claimed it during the wait
                if process.proc.returncode is not None or self._now_fn() >= instance.deadline:
                    await self._apply_python_exit(run, state, entry, instance)
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
            if run.admission_backoff_until is not None:
                if self._now_fn() >= run.admission_backoff_until:
                    # The deadline passed (possibly on the old clock,
                    # rebased at the rehydrate): clear it so the run's
                    # status and snapshot stop carrying a dead backoff.
                    run.admission_backoff_until = None
                else:
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
            resident_only_in_flight = bool(active_work) and all(
                state.lifecycle == "resident" for state, _, _ in active_work
            )
            if (
                (not active_work or resident_only_in_flight)
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

#: The cached ``factory_enabled()`` read: (stat key, verdict). The key is
#: the resolved settings path with its size and nanosecond mtime (or
#: ``None`` markers when the file cannot be stat-ed), so any rewrite
#: re-reads while an unchanged document costs one ``stat``.
_SETTINGS_READ_CACHE: tuple[tuple, bool] | None = None


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

    The read is cached by the document's stat identity (the resolved
    path, its size, and its nanosecond mtime): the boot arm asks on every
    executed command while it keeps declining, and every cell must not
    re-open and re-parse the file. Any rewrite -- ``/factory on`` or
    ``off`` -- moves the stat key, so the next call re-reads the new
    document; the cache holds no verdict across an observable change.
    """
    # One home for the agent-dir resolution (harness.py owns it); imported
    # lazily because harness imports this module at its own top.
    from .harness import _agent_dir

    path = _agent_dir() / _SETTINGS_FILE_NAME
    try:
        stat = os.stat(path)
    except OSError:
        stat = None
    key = (str(path), stat.st_size, stat.st_mtime_ns) if stat is not None else (str(path), None, None)
    global _SETTINGS_READ_CACHE
    if _SETTINGS_READ_CACHE is not None and _SETTINGS_READ_CACHE[0] == key:
        return _SETTINGS_READ_CACHE[1]
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError):
        enabled = False
    else:
        if not isinstance(document, dict):
            enabled = False
        else:
            factory = document.get("factory")
            if not isinstance(factory, dict):
                enabled = False
            else:
                enabled = factory.get("enabled") is True
    _SETTINGS_READ_CACHE = (key, enabled)
    return enabled


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

    Constructed once per kernel boot, and its registry rehydrated off the
    session artifact dir: runs this kernel's predecessors left behind are
    this kernel's runs. Tests that need an injected clock or sleep assign
    their own ``FactoryExecutor`` to ``factory._DEFAULT_EXECUTOR``; the
    namespace then routes through it.
    """
    global _DEFAULT_EXECUTOR
    if _DEFAULT_EXECUTOR is None:
        _DEFAULT_EXECUTOR = FactoryExecutor()
        _DEFAULT_EXECUTOR.rehydrate_registry()
    return _DEFAULT_EXECUTOR


_BOOT_ARM_TASK: "asyncio.Task[None] | None" = None
"""The boot arm's task handle: keeps a reference so the loop does not
garbage-collect the task mid-flight (the kernel's boot arm runs detached
by design — a kernel that dies takes it along)."""


def boot_arm_persisted_runs() -> bool:
    """Arm the rehydrated runs when execution is proven permitted.

    Without this, a kernel restart leaves every persisted run frozen until
    some factory API call happens: the children settle under the
    supervisor and nobody collects them, and a parent waiting on
    ``factory.progress`` milestones waits forever (probe I — the run
    moved only after a manual ``status`` call). The daemon lane answers
    ``runs: []`` while the kernel is down, so it cannot substitute either.

    The arm is a RELEASE, not a boot fact: ``rlm.repl`` fires it on a
    clean restore completion (every saved name revived) or on the first
    executed command the HOST dispatches — never at kernel boot, and
    never on the provisioner's own runtime-bootstrap execute (the host
    sends it after every restore attempt, a refused restore included,
    so it is not a gate's permission), because a kernel booted to READ
    a payload (a hosted guest's reader prewarm, a blocked resume) must
    not collect or advance its persisted runs before the read is
    proven; the host only dispatches commands past the gates it owns.
    Returns whether the arm was scheduled; a plain import (a CLI, a
    test process) stays on the lazy first-call path.
    """
    global _BOOT_ARM_TASK
    if _BOOT_ARM_TASK is not None:
        return False  # already armed
    if not factory_enabled():
        return False  # the opt-in gate stays authoritative, even at boot
    if not _runs_dir_snapshots():
        return False  # nothing persisted: a fresh session's first boot
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False

    async def _arm() -> None:
        try:
            await default_factory_executor().arm_persisted_runs()
        except Exception as error:  # noqa: BLE001 - a dead boot arm is the F-03
            # failure mode in miniature: children settle uncollected and no
            # log names it. The arm is detached by design (a kernel that
            # dies takes it along), so this is the one place its failure
            # can reach a human.
            import sys

            print(f"factory boot arm failed: {error}", file=sys.stderr)

    _BOOT_ARM_TASK = loop.create_task(_arm())
    return True


def _runs_dir_snapshots() -> bool:
    """Whether the runs dir holds at least one snapshot or loss marker.

    A .persist-failed marker counts (round-9 probe R9-04): a session whose
    only run's FIRST write failed holds no snapshot at all — the boot
    gate stayed closed, no executor ever existed, and the load-end line
    naming the loss never printed. The marker is the run's only durable
    trace; boot must surface it.
    """
    directory = _runs_dir()
    if directory is None:
        return False
    try:
        return any(
            (name.endswith(".json") or name.endswith(".persist-failed"))
            and not name.startswith(".")
            for name in os.listdir(directory)
        )
    except FileNotFoundError:
        return False  # nothing persisted yet: a fresh session's first boot
    except OSError:
        # A runs dir that EXISTS but cannot be listed (round-10 probe
        # R10-03): the gate stayed closed, no executor existed at boot,
        # and the R9-08 listdir line never printed — the loss was silent
        # at boot. The gate opens so the executor reports it.
        return True


async def _armed_executor() -> FactoryExecutor:
    """The namespace executor with rehydrated runs re-armed for this boot.

    The re-arm completes the flows a kernel restart interrupted; the first
    factory use after the restart is the natural seam (the lane polls, the
    model asks, either arms it).
    """
    executor = default_factory_executor()
    await executor.arm_persisted_runs()
    return executor


async def run_factory(
    spec_id: str, *, name: str | None = None, params: "dict[str, Any] | None" = None
) -> dict[str, Any]:
    """Validate a factory spec and start a nonblocking run of it.

    A path to a machine directory (``machine.toml``) runs that directory.
    Otherwise the argument names a stored factory entry (a runtime
    instance) first; when no entry carries that id, the session's Rust
    library scan resolves the name (the ``factory.compile`` host request,
    the same scan ``prime-agent factory list`` shows) and the template runs
    directly: ``await rlm.factory.run("review-sweep")`` starts the library
    machine without creating a harness entry. Harness entries remain
    runtime instances; machines are templates.

    A machine directory is loaded, checked, and compiled by the Rust loader
    with ``params`` bound; params apply to machine directories only.
    """
    require_factory_enabled()
    if params is not None and not isinstance(params, dict):
        raise TypeError(f"params must be a dict, got {type(params).__name__}")
    executor = await _armed_executor()
    directory = _machine_dir_argument(spec_id)
    if directory is None and executor._resolve_harness().get("factory", spec_id) is not None:
        if params:
            raise ValueError(
                f"params apply to machine directories (machine.toml); {spec_id!r} is a stored "
                "factory entry, which takes none"
            )
        return await executor.run(spec_id, name=name)
    from . import host_request

    target = {"path": str(directory)} if directory is not None else {"name": spec_id}
    try:
        compiled = await host_request("factory.compile", {**target, "params": params or {}})
    except RuntimeError as error:
        if directory is not None:
            raise ValueError(str(error)) from None
        raise ValueError(
            f"unknown factory spec {spec_id!r}: no stored factory entry, and {error}"
        ) from None
    machine = MachineFile(
        name=compiled["name"],
        description=compiled["description"] or "",
        version=str(compiled["version"]),
        author=compiled.get("author") or "",
        spec=compiled["spec"],
    )
    return await executor.run_machine(machine, machine_path=Path(compiled["path"]), name=name)


async def status_factory(run_id: str) -> dict[str, Any]:
    """Return state states, the event window, elapsed time, and usage."""
    require_factory_enabled()
    return await (await _armed_executor()).status(run_id)


async def stop_factory(run_id: str) -> dict[str, Any]:
    """Cancel every running child of the run and mark it stopped."""
    require_factory_enabled()
    return await (await _armed_executor()).stop(run_id)


async def resume_factory(run_id: str) -> dict[str, Any]:
    """Resume a paused run (escalate, budget, or max_transitions pause).

    An escalate pause re-admits the failed entry as a fresh attempt of the
    same rendered prompt first; see ``FactoryExecutor.resume``.
    """
    require_factory_enabled()
    return await (await _armed_executor()).resume(run_id)


def _schedule_rearm(executor: FactoryExecutor) -> None:
    """Arm rehydrated runs from a sync seam: a loop task when a loop is
    running (the kernel's sync calls always run inside one), nothing
    otherwise — the next async seam arms."""
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no loop: a sync CLI context; the async seams own arming
    loop.create_task(executor.arm_persisted_runs())


def graph_factory(ref: str | None = None, *, compact: bool = False) -> dict[str, Any]:
    """Return one machine's structure fused with live state (see
    ``FactoryExecutor.graph``): a live run id, a stored spec id, or no ref
    for every live run."""
    require_factory_enabled()
    executor = default_factory_executor()
    _schedule_rearm(executor)
    return executor.graph(ref, compact=compact)


async def watch_factory(
    run_id: str, timeout: float = 0.0, *, compact: bool = False
) -> dict[str, Any]:
    """Block until the run's state/instance shape changes or the bounded
    timeout elapses, then return the same fused snapshot ``graph()``
    returns plus ``changed``."""
    require_factory_enabled()
    return await (await _armed_executor()).watch(run_id, timeout, compact=compact)


def _machine_structure(
    machine: dict[str, Any],
    resolved: "dict[str, tuple[str | None, str | None]] | None" = None,
) -> dict[str, Any]:
    """One canonical machine's static graph structure: the run block, every
    state's declared shape (id, entry, lifecycle, caps, spawn settings), the
    transitions with their guards, and the declared state order. Live runs
    pass their resolved spawn settings (``resolved``); spec graphs pass none
    and surface the inline-declared ones only. The diagram layers read the
    declared order, and edge identity pairs ``from`` (a state id, or a join's
    id list) with ``to``.
    """
    run_block = machine.get("run") if isinstance(machine.get("run"), dict) else {}
    run_out: dict[str, Any] = {
        "max_parallel": run_block.get("max_parallel", RUN_MAX_PARALLEL_DEFAULT),
        "max_transitions": run_block.get("max_transitions"),
        "failure_policy": run_block.get("failure_policy", RUN_FAILURE_POLICY_DEFAULT),
        "max_children": run_block.get("max_children", RUN_MAX_CHILDREN_DEFAULT),
    }
    if "budget_ms" in run_block:
        run_out["budget_ms"] = run_block["budget_ms"]
    states_out: list[dict[str, Any]] = []
    for state in machine["states"]:
        row: dict[str, Any] = {
            "id": state["id"],
            "entry": bool(state.get("entry", STATE_ENTRY_DEFAULT)),
            "lifecycle": state.get("lifecycle", NODE_LIFECYCLE_DEFAULT),
            "max_entries": state.get("max_entries", STATE_MAX_ENTRIES_DEFAULT),
            "retries": state.get("retries", NODE_RETRIES_DEFAULT),
        }
        model, thinking = (resolved or {}).get(state["id"], (None, None))
        subagent = state.get("subagent")
        if "python" in state:
            row["python"] = f"{state['python']['import']}.{state['python']['callable']}"
        elif isinstance(subagent, dict):
            # A resolved live run carries the executor's spawn settings for
            # both subagent forms; a spec graph surfaces the inline-declared
            # ones only (a reference form's settings resolve at run time).
            if model is None and subagent.get("model") is not None:
                model = subagent["model"]
            if thinking is None and subagent.get("thinking") is not None:
                thinking = subagent["thinking"]
            if subagent.get("name"):
                row["subagent"] = subagent["name"]
        else:
            row["subagent"] = subagent
        if model is not None:
            row["model"] = model
        if thinking is not None:
            row["thinking"] = thinking
        states_out.append(row)
    transitions_out: list[dict[str, Any]] = []
    for transition in machine.get("transitions") or []:
        # The snapshot owns its mutable rows: a join's ``from`` list is
        # deep-copied like ``when`` so a consumer mutating the snapshot
        # (appending an unknown source) can never corrupt the active run's
        # machine — a corrupted join would wait for a state that never
        # settles and the transition would never fire.
        row_transition: dict[str, Any] = {
            "from": copy.deepcopy(transition["from"]),
            "to": transition["to"],
            "on": transition.get("on", TRANSITION_ON_KINDS[0]),
        }
        if "when" in transition:
            row_transition["when"] = copy.deepcopy(transition["when"])
        transitions_out.append(row_transition)
    return {
        "run": run_out,
        "states": states_out,
        "transitions": transitions_out,
        "order": [state["id"] for state in machine["states"]],
    }


def _wire_keys(key: str) -> str:
    """snake_case -> the wire's camelCase (``run_id`` -> ``runId``)."""
    head, *rest = key.split("_")
    return head + "".join(part.capitalize() for part in rest)


def _wire_payload(value: Any) -> Any:
    """The activity lane's wire conversion: the ``factory_activity``
    protocol is camelCase end to end (the request frame's ``runId``/
    ``specId``/``timeoutMs``), so the reply's result payload re-keys its
    own snake_case rows to the same wire spelling. Only dict KEYS convert
    (values ride verbatim: state ids, milestone text). A guard dict
    (``output`` + ``op`` — the validated guard signature) rides the wire
    VERBATIM: its structure keys are single words already, and its
    comparison ``value`` mirrors the executor's declared condition
    exactly, so re-keying it would display a condition that no longer
    matches the machine. The in-kernel conversation API
    (``rlm.factory.graph()`` and friends) stays snake_case.
    """
    if isinstance(value, dict):
        if "output" in value and "op" in value:
            return copy.deepcopy(value)
        return {_wire_keys(key): _wire_payload(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_wire_payload(item) for item in value]
    return value


def schedule_activity(request: dict[str, Any]) -> None:
    """Schedule one out-of-band ``factory_activity`` request on the running
    loop. The kernel's reader thread calls this (the frame bypasses the
    cell FIFO like ``bash_activity``); the activity runs as a loop task so
    a busy cell never delays the host bridge, and the reply frame lands
    when the activity settles."""
    import asyncio

    asyncio.get_running_loop().create_task(_run_activity(request))


def _cap_node_presentation_frame(frame: dict[str, Any]) -> None:
    """Trim node preview text against the actual serialized activity frame.

    The field caps bound each preview separately, but JSON escaping makes
    their combined wire representation larger than their UTF-8 source. Keep
    the displayed prefixes and their flags while fitting the final wrapper
    under the unchanged factory frame cap; stored outputs are untouched.
    """
    result = frame.get("result")
    if not isinstance(result, dict):
        return
    candidates: list[tuple[dict[str, Any], str, dict[str, Any], str]] = []
    entry = result.get("entry")
    if isinstance(entry, dict):
        outputs = entry.get("outputs")
        if isinstance(outputs, str) and outputs:
            candidates.append((entry, "outputs", entry, "outputsTruncated"))
        errors = entry.get("outputErrors")
        if isinstance(errors, dict):
            candidates.extend(
                (errors, port, entry, "outputErrorsTruncated")
                for port, error in errors.items()
                if isinstance(error, str) and error
            )
    instance = result.get("instance")
    if isinstance(instance, dict):
        candidates.extend(
            (instance, field, instance, truncated)
            for field, truncated in (
                ("prompt", "promptTruncated"),
                ("inputs", "inputsTruncated"),
                ("answer", "answerTruncated"),
            )
            if isinstance(instance.get(field), str) and instance[field]
        )
    while len(json.dumps(frame)) > FACTORY_FRAME_CAP:
        candidates = [
            candidate
            for candidate in candidates
            if isinstance(candidate[0].get(candidate[1]), str)
            and candidate[0][candidate[1]]
        ]
        if not candidates:
            return
        container, field, flags, flag = max(
            candidates,
            key=lambda candidate: len(json.dumps(candidate[0][candidate[1]])) - 2,
        )
        value = container[field]
        encoded_size = len(json.dumps(value)) - 2
        excess = len(json.dumps(frame)) - FACTORY_FRAME_CAP
        target_size = max(0, encoded_size - excess)
        low, high = 0, len(value)
        while low < high:
            middle = (low + high + 1) // 2
            if len(json.dumps(value[:middle])) - 2 <= target_size:
                low = middle
            else:
                high = middle - 1
        container[field] = value[:low]
        flags[flag] = True


async def _run_activity(request: dict[str, Any]) -> None:
    """Run one factory_activity request to completion and emit its reply."""
    from .repl import _send

    rid = request["id"]
    try:
        result = await default_factory_executor().activity(request)
    except Exception as exc:  # noqa: BLE001 - the reply lane must never hang
        # An internal executor error still answers: a dropped reply would
        # leave the host waiter on its timeout instead of the reason. The
        # error frame rides the same wire cap as the success frame — a
        # multi-megabyte reason (an unknown id carrying a huge value) must
        # never exceed the transport bound; the cap's fallback replaces it
        # with the loud wire-cap message when it cannot fit.
        frame: dict[str, Any] = {"event": "done", "id": rid, "status": "error", "reason": str(exc)}
        _cap_factory_frame(frame)
        _send(frame)
        return
    frame: dict[str, Any] = {"event": "done", "id": rid, "status": "ok", "result": result}
    if request.get("action") == "node":
        _cap_node_presentation_frame(frame)
    _cap_factory_frame(frame)
    _send(frame)


_WIRE_LIVE_RUN_STATES = ("running", "stopping", "paused")


def _wire_run_row_is_live(row: Any) -> bool:
    """Whether a wire run row is LIVE in the dock/page sense — the same
    rule the TUI's ``is_live`` reads and the unscoped list builds (a live
    state, or children still in flight): the wire cap's eviction must
    never silently drop a row the dock counts and the ``/factory off``
    guard trusts (every live run reports — the live-exactness contract)."""
    if not isinstance(row, dict):
        return False
    if row.get("state") in _WIRE_LIVE_RUN_STATES:
        return True
    usage = row.get("usage")
    return isinstance(usage, dict) and usage.get("running", 0) > 0


def _shed_runs_frame(runs: list[Any]) -> bool:
    """One shed step for an all-runs reply under the wire cap, newest data
    kept longest: a run row's event tail trims from its oldest end first
    (the by-ref reply's own trim rule, applied per row, oldest row first),
    then the oldest DROPPABLE row drops — a live row never silently drops
    (the count and panels read it; the honest answer for a frame only
    live rows cannot fit is the loud failure). At least one row always
    stays, so a reply never claims a registry it did not read. Returns
    whether one step shed; ``False`` means only unsheddable rows remain."""
    for row in runs:
        if not isinstance(row, dict):
            continue
        tail = row.get("events")
        if isinstance(tail, list) and len(tail) > 1:
            tail.pop(0)
            return True
    if len(runs) > 1:
        for index, row in enumerate(runs):
            if not _wire_run_row_is_live(row):
                runs.pop(index)
                return True
    return False


def _cap_factory_frame(frame: dict[str, Any]) -> None:
    """Keep one reply under the ``FACTORY_FRAME_CAP`` wire cap. Compacted
    snapshots already shed answer payloads, so the events tail trims from
    the oldest end first; an all-runs reply sheds the same way — each
    row's event tail floors before any whole row drops, and the drop
    takes the oldest DROPPABLE row (a live row never silently drops: the
    dock's count, the page's panels, and the ``/factory off`` guard read
    this list, and every live run reports). A frame that still cannot fit
    fails loudly (a graph must never truncate silently)."""
    while len(json.dumps(frame)) > FACTORY_FRAME_CAP:
        result = frame.get("result")
        events = result.get("events") if isinstance(result, dict) else None
        if isinstance(events, list) and len(events) > 1:
            events.pop(0)
            continue
        runs = result.get("runs") if isinstance(result, dict) else None
        if isinstance(runs, list) and _shed_runs_frame(runs):
            continue
        frame.pop("result", None)
        frame["status"] = "error"
        frame["reason"] = "factory activity reply exceeds the wire cap"
        return
    # A non-finite float anywhere in the frame would serialize as the
    # non-JSON tokens NaN/Infinity and break every strict consumer of
    # the reply (the host bridge's parser included) — validation blocks
    # them at the machine's source; this belt fails loudly if one ever
    # slips through, instead of emitting the token.
    try:
        json.dumps(frame, allow_nan=False)
    except ValueError:
        frame.pop("result", None)
        frame["status"] = "error"
        frame["reason"] = "factory activity reply contains non-finite values"
    # The same belt for lone surrogates (round-10 probe R10-01): a lone
    # \\udXXX escape in the reply's text would pass every earlier check,
    # serialize as the escape, and the host's serde_json rejects the whole
    # frame — "Kernel protocol error" for the session. A belt trip names
    # the fault instead of emitting it; the decode-point cleaners should
    # make it unreachable.
    if _frame_has_lone_surrogate(frame):
        frame.pop("result", None)
        frame["status"] = "error"
        frame["reason"] = "factory activity reply contains a lone surrogate escape"


# ---------------------------------------------------------------------------
# Machine library: MACHINE.md files (import, export, share).
#
# A MACHINE.md is a v1 machine file: YAML frontmatter (name, description,
# version, author) followed by one fenced ``machine-spec`` block whose
# payload is a JSON factory spec in the schema ``validate_factory_spec``
# accepts. The machine library (MACHINE.md files and machine directories)
# belongs to the Rust ``pa_factory`` scan: ``prime-agent factory list |
# import | export`` and ``run_factory``'s name lookup (the
# ``factory.compile`` host request) all read it. This module renders
# MACHINE.md for ``export_machine`` (a stored entry or a live run).
# ---------------------------------------------------------------------------

MACHINE_DIR_FILE_NAME = "machine.toml"
"""The file that makes a directory a machine directory (the format
``prime-agent factory validate`` checks; loaded by the session's Rust
loader through the ``factory.compile`` host request)."""
MACHINE_SPEC_FENCE = "machine-spec"
MACHINE_NAME_MAX_LENGTH = 64
MACHINE_DESCRIPTION_MAX_LENGTH = 1024

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


@dataclass(frozen=True)
class MachineFile:
    """A parsed MACHINE.md: strict frontmatter plus the machine-spec payload."""

    name: str
    description: str
    version: str
    author: str
    spec: "dict[str, Any]"


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
        python = state.get("python")
        if isinstance(python, dict):
            lines.append(f"  python: {python.get('import')}.{python.get('callable')}")
        elif isinstance(subagent, dict):
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
    formatting for diffs), and the Rust ``parse_machine_md`` of the output
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



def _machine_dir_argument(spec_id: str) -> "Path | None":
    """The machine directory an explicit path names (``~/machines/rsi``,
    ``./rsi``, an absolute path), or ``None`` for a plain name."""
    if not (spec_id.startswith(("~", ".", "/")) or os.sep in spec_id):
        return None
    directory = Path(spec_id).expanduser().resolve()
    if not (directory / MACHINE_DIR_FILE_NAME).is_file():
        raise ValueError(f"{spec_id!r} is not a machine directory (no {MACHINE_DIR_FILE_NAME} in it)")
    return directory


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


def export_machine(target: str, out_path: "str | Path", *, overwrite: bool = False) -> "dict[str, Any]":
    """Export a stored factory entry's spec, or a live run's canonical
    machine, to MACHINE.md at ``out_path`` (byte-pretty). Library machines
    export with ``prime-agent factory export``, which copies the file."""
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
    raise ValueError(
        f"no stored factory entry or live run {target!r}; export a library machine with "
        "`prime-agent factory export`"
    )


def cli_dispatch(payload: Any) -> "dict[str, Any]":
    """JSON facade for ``prime-agent factory import``: the ``validate`` op
    checks a spec's structure with the write-time validator and answers
    ``{"ok": true}`` or ``{"ok": false, "errors": [...]}`` (the exact
    sentences reach the command's output verbatim). The CLI owns the rest
    of the library (parsing, limits, listing, files) through ``pa-factory``.
    """
    if not isinstance(payload, dict) or payload.get("op") != "validate":
        return {"ok": False, "errors": ["factory cli payload must be {\"op\": \"validate\", \"spec\": ...}"]}
    errors = validate_factory_spec(payload.get("spec"))
    return {"ok": False, "errors": errors} if errors else {"ok": True}


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
                    "Address the review findings in the verdict below. First "
                    "reconcile any changes an earlier attempt left in the working "
                    "tree. Make the smallest targeted fixes, run the relevant "
                    "tests, and return a fenced json block of the form "
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
file list in the review-sweep example — because the executor's capture
cap still bounds very large payloads: an unbounded payload truncates at
the cap, fails to capture, and fails the producing state through its
`retries` and `failure_policy` instead of settling valueless.

## Authoring reference

- **States**: 1 to 1024, unique ids matching `^[a-z0-9][a-z0-9-]{0,63}$`; at
  least one state carries `"entry": true`. An entry state's inputs must all
  be optional: its first entry binds the null sentinel, and a later entry
  through a transition (a verify loop back into it) binds the real
  settle. A state runs either a `python` callable (see Python states) or
  a subagent. A state's `subagent` is a harness subagent entry id or title (its
  content is the prompt template; `metadata.model`/`metadata.thinking` are
  spawn settings) or an inline `{"prompt": ...}` object with optional
  `name`/`model`/`thinking`. The optional `name` labels the spawned
  children run-scoped (at most 64 characters, unique across the
  machine's states — a name another state's name can suffix onto, `foo`
  vs `foo-i1`, is rejected at write time): the spawn label is
  `<run6>-name` — the supervisor's sibling names are per-parent-session,
  and a parent session outlives its runs, so the run prefix keeps two
  runs of one machine from colliding; read the exact label from the
  `spawned` event's `name` or the status node's instance rows — and
  re-entries, foreach fan-out, and retries disambiguate with the same
  `-i<n>`/`-a<n>` suffixes the generated labels use; a suffixed label
  that would pass the host's 64-character cap shrinks its base with a
  digest of the full name, like the generated labels do.
- **Ports**: inputs and outputs of type `text` or `json`. An input binds
  `"from": "<state_id>.<output_name>"`; types must match, duplicates are
  rejected, and nothing can read from a resident. Bound values render into
  `{input_name}` placeholders (one pass; inputs without a placeholder are
  appended in a trailing `## Inputs` section). A required input whose source
  has not settled yet keeps the entry pending; over a settled source that
  offers no value (an errored settle, or a settle that captured nothing for
  the port) it fails the dependent entry, while
  `"optional": true` binds a null sentinel in every no-value case (a
  source that offers no value is not a value, so the dependent that
  declared the input optional proceeds). A state's own declared outputs
  capture from its settle's full answer: a declared port that binds no
  value — no parseable JSON for it (a fenced ```json block, or a bare
  JSON object ending the answer), or a payload past the executor's
  capture cap — is retried once and then FAILS the producing
  entry as a task failure (`retries`, then `failure_policy`, apply, and
  the answer stays preserved under `needs_verify`), so a valueless
  settle never reaches a dependent's bind. A required self-input is
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
  unparseable port fails every op except `exists`. Under `continue` a
  failed settle still fires guard-less transitions, so dependents run;
  their required input over the failed source then fails the dependent
  entry, while an optional input over the failed source binds the null
  sentinel and the dependent proceeds. Under the default `escalate` the
  failure never propagates that far (see bounds and policies).
- **Cycles are legal**: there is no acyclicity requirement — self-loops and
  back edges validate. The one rule is an entry state somewhere; a dag
  whose every node depends on another compiles to no entry states and is
  rejected.
- **foreach**: `{"over": "<input>", "max": 1..256}` expands one entry into
  one child per item of the named `json` input (clamped at `max`), each
  child rendered with its item bound as that input; an empty list settles
  the entry with no children.
- **Residents**: `"lifecycle": "resident"` states declare no outputs, no
  foreach, no retries, and no outgoing transitions, nothing reads from
  them, and their instance stays alive under the parent session after the
  run completes (stop the run to retire it).
- **Bounds and policies**: `run.max_parallel` (1..64, default 8) is the
  run's global budget of simultaneously running instances — not a
  per-node limit. `run.max_children` (default 10,000, capped at
  1,000,000) is the run's global budget of total admissions over its
  life — foreach expansions and retry re-spawns included (neither
  `max_parallel` nor `max_transitions` bounds children); reaching it
  pauses the run once, and `resume` continues past it as an explicit
  operator decision. `run.max_transitions` (default 10 per state, at
  most 10,000) pauses the run once at the boundary, mid-settle; `resume`
  continues after the transitions that already fired without re-firing
  them. `run.budget_ms` pauses the run once when exceeded (in-flight
  children keep running). Per state: `max_entries` (default 1), `retries`
  (0..10, same rendered prompt), `budget_ms` (admission to settlement;
  exceeding it fails the attempt without a retry), and `failure_policy` —
  `fail_fast` (cancel every child, run failed), `continue` (entry stays
  errored; the run finishes and reports failed if any state errored; its
  failed settle fires guard-less transitions so dependents run), or
  `escalate` (the default: pause the run BEFORE the failed settle
  propagates — no transition fires and no downstream entry is spent — and
  `resume` re-admits the failed entry as a fresh attempt: same rendered
  prompt, same entry slot, fresh `retries`; a binding failure over a
  broken upstream re-binds and pauses again, so stop and fix the upstream
  or author the dependent's state with `continue`). A child whose worker
  died or whose supervisor link was lost is infra, not the task's
  failure: the executor re-checks it after a short quiet period, then
  re-spawns the same prompt once without spending `retries` or
  `max_entries`; a second death fails through `retries`/`failure_policy`
  like any task failure.
- **Retry re-renders the same prompt into a changed world**: a retry runs
  the same prompt after an earlier attempt already changed the external
  state it works on, so a prompt that mutates external state — a fixing
  state's worktree, a tracker, a remote API — states its recovery posture:
  reconcile (start from what the earlier attempt left with `git status`
  and `git diff`, keep the changes that already serve the task, revert
  half-finished edits) or reset to a clean baseline, never fail on the
  old state or duplicate finished work. Retries with no recovery note
  still validate: validation cannot judge prose.
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

## Python states

A state can run a Python function instead of spawning a child: it carries
`"python": {"import": "<module>", "callable": "<function>"}` in place of
`subagent` (exactly one of the two). Use it for deterministic routing and
data shaping — listing work items, filtering, reshaping one state's output
for the next — where a child agent would only spend budget.

- **Contract**: the executor calls `fn(inputs)` with a dict of the state's
  declared inputs (plus the machine's params, when it has any) bound to raw values (a `text` input as a string, a `json`
  input as the parsed value, an optional input with no value as `None`;
  entry states with no declared inputs get `{}`). The function returns a
  dict whose keys are exactly the declared output names (a `text` output must be a string);
  that dict is the settle's outputs, so guards and downstream inputs read
  it like any other state's. An `async def` function is awaited.
- **Isolation**: every call runs in a fresh, short-lived Python subprocess
  (the kernel's interpreter, isolated mode) in the session's working
  directory, which is on the import path, so a module next to your work
  imports. It has no `rlm`, no harness, no kernel globals, and cannot spawn
  agents. `PRIME_AGENT_FACTORY_OWNER_SESSION` carries the id of the session
  running the machine. Prints go to stderr; only the returned dict goes to stdout.
- **Failures**: an exception (its stderr tail is the error), output that is
  not a dict, or keys that do not match the declared outputs fail the
  attempt: `retries` re-runs the call with the same inputs, then
  `failure_policy` applies. A bad import fails at run time the same way.
- **Time limit**: the state's `budget_ms`, else the run's `budget_ms`, else
  60 seconds. A call past its limit is killed and fails without a retry.
  `stop` and `fail_fast` kill running calls.
- **Pure functions**: calls are re-run on retry, on resume after an
  escalate pause, and after a kernel restart orphaned the running call
  (the rehydrated run fails it through `retries`/`failure_policy`), so a
  python state should depend only on its inputs.
- Python states cannot be `resident` and cannot use `foreach`. A call holds
  a `max_parallel` slot but is no child: it does not count toward
  `max_children`.

A python state lists the work, then an agent state fans out over it:

```python
# my_tools.py in the session's working directory
def changed_files(inputs):
    import subprocess
    out = subprocess.run(["git", "diff", "--name-only", "main"],
                         capture_output=True, text=True, check=True).stdout
    return {"files": out.split()[:8]}
```

```python
rlm.harness.create_factory(
    "file-review",
    "Review each changed file.",
    id="file-review",
    machine={
        "states": [
            {"id": "files", "entry": True,
             "python": {"import": "my_tools", "callable": "changed_files"},
             "outputs": [{"name": "files", "type": "json"}]},
            {"id": "review",
             "subagent": {"prompt": "Review {file}; reply one line: `<path>: <problem or clean>`."},
             "inputs": [{"name": "file", "type": "json", "from": "files.files"}],
             "foreach": {"over": "file", "max": 8}},
        ],
        "transitions": [{"from": "files", "to": "review"}],
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
status["needs_verify"]  # (when set) states whose entry keeps a
                        # provisional answer: a child exit with text, or a
                        # settled answer whose declared output failed to
                        # capture (worker deaths are liveness-checked and
                        # re-spawned by the executor first) - the entry row
                        # carries the provisional_answer preview
status["pause_reason"]  # (paused) why the run paused; with "last_error" (the
status["last_error"]    # last admission/bind failure) and a one-line "remedy"
```

`graph()` and `watch()` are the live monitoring views this namespace
ships alongside the stacked live-view PR's TUI page:

```python
graph = await rlm.factory.graph(result["run_id"])
# {"run_id": "...", "spec_id": "pr-manager", "state": "running",
#  "machine": {"order": [...], "states": [...],
#              "transitions": [...], "run": {...}},
#  "nodes": [...], "active_nodes": [...], "last_fired": [...],
#  "events": [...], "usage": {...}, "budget": {"limit_ms": ...,
#  "consumed_ms": ...}}  — structure fused with live state.

every = await rlm.factory.graph()        # every live run ({"runs": [...]})
spec = await rlm.factory.graph("pr-manager")  # a stored spec's static graph

watched = await rlm.factory.watch(result["run_id"], 30)
# the same fused snapshot plus "changed" — the call blocks until the
# run's state/instance shape changes or the bounded timeout elapses,
# so one call streams a run's progress without polling `status()`.
```

- `graph(ref)` fuses the machine's structure (states, guarded
  transitions, the declared order) with the live run's overlay (the
  node reports, active nodes, recently fired edges, the event tail,
  usage, budget consumed); a stored spec id answers the static
  structure, and no ref answers every live run.
- `watch(run_id, timeout)` returns immediately with the snapshot when
  nothing changed, blocks until the run's state/instance shape changes,
  and answers `"changed": false` on the bounded timeout.

- `run` re-validates the spec and resolves every subagent reference first,
  reporting all failures in one `ValueError` and starting nothing on any
  failure; `name=` labels the run in status and the TUI.
- Pause and failure notices (escalate, budget, max_transitions,
  max_children, failed, finished) arrive as quiet notices in the
  conversation, or as `factory-progress` inbox messages in sessions with
  the agent inbox, once per kind per run (an escalate pause notifies again
  after each resume), the pause notices with the resume call spelled
  out — a paused run does not need polling to be noticed.
- `stop(run_id)` cancels every running child of the run (idempotent);
  `resume(run_id)` continues a paused run and raises on a non-paused one;
  after an escalate pause it first re-admits the failed entry.
- The activity lane the daemon and TUI speak is camelCase on the wire
  (`runId`, `specId`, `timeoutMs`); the kernel API here
  (`rlm.factory.*`) is snake_case.

## Machine directories

A machine can also be a directory: `machine.toml` for the graph, Markdown
prompts, TOML rubrics, and `nodes/*.py` for python states. Nothing in it is
generated, so it shares as-is. `prime-agent factory validate <dir>` checks
it (types, ports, routes, joins, reachability, prompt placeholders) with
the same Rust loader a session uses; `prime-agent factory convert <name>
--out <dir>` turns a MACHINE.md machine into one.

```toml
format = 1
name = "review-loop"
version = 1
description = "Plan, judge, and route"

[params]
task = { type = "text" }          # given at start: run(..., params={"task": ...})

[roles]
judge = { model = "<provider>/<model>", thinking = "max" }

[types.verdict]
decision = "enum(approve, rework)"
findings = "list[text]"

[states.plan]
entry = true
agent = { prompt = "prompts/plan.md" }      # the prompt inserts {{task}}
inputs = { verdict = "review.verdict?" }    # ? = optional
outputs = { plan = "text" }
max_entries = 3
next = "review"

[states.review]
agent = { role = "judge", prompt = "prompts/review.md", rubric = "rubrics/quality.toml" }
inputs = { plan = "plan.plan" }
outputs = { verdict = "verdict" }
route = { on = "verdict.decision", approve = "ship", rework = "plan" }
```

- Prompts insert params and inputs with `{{name}}`; `prompts/_context.md`
  is prepended to every agent state. The loader appends a generated
  Outputs section that spells out each port's type.
- A child hands back its outputs with `await rlm.factory.emit(port=value,
  ...)` from its REPL, never in its answer text. Each value is checked
  against the port's type before it is kept; a wrong one raises
  `FactoryEmitError` with the exact field (`verdict.findings[0].severity:
  'high' is not one of ...`), so the child fixes it in the same turn. A
  `file` port takes a path and the file is copied beside the child's
  session. `await rlm.factory.inputs()` returns the bound inputs and params
  as values. A child that ends its turn still owing a required output gets
  one message in its own session asking for it; if it still owes one when
  that turn ends, the entry fails with `missing_output`. No fresh child is
  started for a missing output. A python state's returned dict goes
  through the same check. `text?` marks an optional output, and an input
  that reads one must be optional too.
- Routing is `next` (a state, or a list to fan out) or `route`, a switch
  on one enum or bool output where every value needs a target. A state
  with `join = [...]` waits for every member, and each member names it in
  `next`. Any other condition is a python state that returns an enum.
- A python state is `kind = "python"` with `run = "nodes/<file>.py:<fn>"`;
  the function receives the declared inputs plus the params.
- `await rlm.factory.run("<name or path>", params={...})` runs one; a
  required param with no default must be given.

## Discovering machines

- The machine library: one folder per machine, either a machine directory
  (`machine.toml`) or a `MACHINE.md` file (frontmatter plus one fenced
  `machine-spec` block), resolved from two levels — the bundled seeds
  shipped inside the runtime (visible in every install;
  `PRIME_AGENT_MACHINES_DIR` redirects the level at a team directory)
  first, the personal `machines/` library under the agent dir second; the
  earlier level wins on name conflicts, and within a level a machine
  directory wins. `prime-agent factory list | import | export` manages
  them: list shows what loads (broken folders print as warnings), import
  checks the spec like a stored one so an invalid machine never persists,
  and export copies a library MACHINE.md verbatim to a fresh path (an
  existing target is refused, never overwritten). `rlm.factory.run('<name>')`
  runs a library machine directly without creating a harness entry; a
  machine that exists but is broken names its errors
  instead of pretending the name is unknown. The bundled seeds are
  `builder`, `pr-manager`, and `review-sweep`; the worked examples above
  derive from their shapes.
- The TUI machines page lists every library machine (MACHINE.md files and
  machine directories, with their source) and nests every session's
  active runs under their machine, machines with a live run first, like
  the agents view nests subagents; runs of stored specs list in their
  own group. Open it from any session with the
  activity dock's `⚙ N machines` group or a bare `/factory`, or from the
  agents view with Ctrl+F (through the selected session). Enter on a
  machine shows its diagram, params, and each state's files (a mermaid
  fence in a node's Markdown renders as a diagram; types the page cannot
  draw collapse to a one-line placeholder); Enter
  on this session's run opens the run page: one live diagram, where
  the up/down arrows walk the run header and the states that spawned a
  child, Enter or Right opens a state's latest child session, Ctrl+X (the
  agents view's stop key) twice stops the selected row (the whole run on
  its header, or the state's running child), and `r` resumes a paused
  run; another session's run names its owner instead, and a row of this
  session's that no live read backs names its read-only state (both
  report on the page; no run page mounts for either). Esc steps back:
  run page to machines page to wherever you came from.

## Safety

- Every subagent state spawns real children that spend budget. Bound loops with
  `max_entries`, `max_transitions`, and `run.max_children` (total
  admissions); the default `escalate` policy pauses
  instead of failing, so read `status` (or the notice) before resuming.
- Outputs bind from the child's full final answer (the collect envelope
  carries it; the executor caps its own capture at 65,536 characters,
  the same bound the daemon puts on the envelope's answer text): a
  fenced json output block binds whole as long as it fits that cap (a
  bare JSON object that ends the answer binds too), so keep declared
  outputs compact — the rosters and ledger previews stay ~160 characters
  — and let the full answer live in the child's session.
- Runs survive kernel restarts: the registry snapshots to the session
  artifact dir (at the control loop's consistent points, with a mutation
  journal for batches and admissions in between), a restarted kernel rehydrates it on the next factory use, and
  the runs continue (a run that was stopping
  finishes its cancellations; a python call the restart orphaned fails
  through its state's `retries` and `failure_policy`; children, supervisor-
  owned, run straight through — a finished child's emitted outputs are
  read from its session dir, never from kernel memory). While the kernel
  is down the status lane answers the no-kernel refusal, never `running`.
  That durability is the daemon's: a `--print` session hosts its children
  in its own process, so its runs end with it, and `resume` of a run that
  process did not start refuses with "--print runs are not durable; run
  machines under the daemon for restart safety".
- Residents outlive their run; stop the run (or tear down the session) to
  retire them. Prefer `rlm.factory.stop(run_id)` over deleting a factory
  child by hand — the executor claims and cancels children itself, and a
  hand deletion surfaces as a child failure through the state's policy.
"""
