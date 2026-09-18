"""Validation and compilation for swarm specifications.

A continual-harness ``swarm`` entry stores a declarative state machine of
subagent states in ``arguments["machine"]``: entry states (which declare
no inputs), guarded transitions between states, and bounded re-entry
(``max_entries``). The original DAG form in ``arguments["dag"]`` stays as
sugar: it compiles to machine form (each node becomes a state entered
once; each effective dependency edge becomes a guard-less transition).
Wait states are specified for the communication series but gated here:
the watch host handlers (``rlm.watch.*``) do not exist yet, so a state
carrying a ``wait`` block is rejected at write time.

This module implements the write-time dry run for both forms -- the machine
validator, the dag-to-machine compiler, the unified entry point
(``validate_swarm_spec`` detects the form), and a canonicalizer that
applies defaults and returns the canonical MACHINE form -- plus the
executor (``SwarmExecutor`` and the ``rlm.swarm`` namespace:
run/status/stop/resume) that runs canonicalized machines through the
existing RLM supervisor: states are admitted with ``rlm.spawn``, settled
through ``rlm.collect``, and cancelled with ``rlm.delete_subagent``. The
supervisor owns the children; the executor owns the run state in kernel
memory. Runs do not survive a kernel restart (the registry lives in this
module's state); children are supervisor-owned and keep running, so
``rlm.list_subagents`` can still see them after a restart.
"""

from __future__ import annotations

import copy
import heapq
import json
import re
import time
from dataclasses import dataclass, field
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
TRANSITIONS_PER_STATE_DEFAULT = 10
RUN_FAILURE_POLICY_DEFAULT = "escalate"
RUN_MAX_PARALLEL_DEFAULT = 8
NODE_LIFECYCLE_DEFAULT = "task"
NODE_RETRIES_DEFAULT = 0
STATE_ENTRY_DEFAULT = False
STATE_MAX_ENTRIES_DEFAULT = 1

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


def _port_names(node: dict[str, Any], key: str) -> list[Any]:
    return [entry.get("name") if isinstance(entry, dict) else None for entry in _port_list(node, key)]


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
    run_budget = run.get("budget_ms")
    if run_budget is not None and not _is_positive_int(run_budget):
        errors.append("run budget_ms must be a positive integer")
        run_budget = None
    run_policy = run.get("failure_policy")
    if run_policy is not None and run_policy not in FAILURE_POLICIES:
        errors.append(f"run failure_policy must be one of {list(FAILURE_POLICIES)}, got {run_policy!r}")
    max_parallel = run.get("max_parallel")
    if max_parallel is not None and not (
        _is_int(max_parallel) and MAX_PARALLEL_MIN <= max_parallel <= MAX_PARALLEL_MAX
    ):
        errors.append(f"run max_parallel must be an integer between {MAX_PARALLEL_MIN} and {MAX_PARALLEL_MAX}")
    max_transitions = run.get("max_transitions")
    if max_transitions is not None and not (
        _is_positive_int(max_transitions) and max_transitions <= MAX_TRANSITIONS_CAP
    ):
        errors.append(f"run max_transitions must be a positive integer no greater than {MAX_TRANSITIONS_CAP}")
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
    lifecycle = state.get("lifecycle", NODE_LIFECYCLE_DEFAULT)
    if lifecycle not in LIFECYCLES:
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
        if not _is_nonempty_str(subagent.get("prompt")):
            errors.append(f"{noun} {ref} inline subagent requires a non-empty prompt")
        for key in ("name", "model", "thinking"):
            value = subagent.get(key)
            if value is not None and not _is_nonempty_str(value):
                errors.append(f"{noun} {ref} inline subagent {key} must be a non-empty string when provided")
    else:
        errors.append(
            f"{noun} {ref} requires a subagent: a harness subagent id/title string "
            "or an inline object with a prompt"
        )

    budget = state.get("budget_ms")
    if budget is not None:
        if not _is_positive_int(budget):
            errors.append(f"{noun} {ref} budget_ms must be a positive integer")
        elif run_budget is not None and budget > run_budget:
            errors.append(f"{noun} {ref} budget_ms {budget} exceeds the run budget_ms {run_budget}")

    retries = state.get("retries")
    if retries is not None and not (_is_int(retries) and 0 <= retries <= MAX_RETRIES):
        errors.append(f"{noun} {ref} retries must be an integer between 0 and {MAX_RETRIES}")

    policy = state.get("failure_policy")
    if policy is not None and policy not in FAILURE_POLICIES:
        errors.append(f"{noun} {ref} failure_policy must be one of {list(FAILURE_POLICIES)}, got {policy!r}")

    outputs = state.get("outputs")
    if outputs is not None and not isinstance(outputs, list):
        errors.append(f"{noun} {ref} outputs must be a list")
    elif is_resident and isinstance(outputs, list) and outputs:
        errors.append(f"resident {noun} {ref} cannot declare outputs")
    reported_duplicate_outputs: set[str] = set()
    for index, out in enumerate(_port_list(state, "outputs")):
        if not isinstance(out, dict):
            errors.append(f"{noun} {ref} outputs[{index}] must be an object")
            continue
        name, port_type = out.get("name"), out.get("type")
        if not _is_nonempty_str(name):
            errors.append(f"{noun} {ref} outputs[{index}] requires a non-empty name")
        elif _port_names(state, "outputs").count(name) > 1 and name not in reported_duplicate_outputs:
            reported_duplicate_outputs.add(name)
            errors.append(f"{noun} {ref} declares duplicate output name {name!r}")
        if port_type not in PORT_TYPES:
            errors.append(f"{noun} {ref} output {name!r} type must be 'text' or 'json'")

    inputs = state.get("inputs")
    if inputs is not None and not isinstance(inputs, list):
        errors.append(f"{noun} {ref} inputs must be a list")
    reported_duplicate_inputs: set[str] = set()
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
        elif _port_names(state, "inputs").count(name) > 1 and name not in reported_duplicate_inputs:
            reported_duplicate_inputs.add(name)
            errors.append(f"{noun} {ref} declares duplicate input name {name!r}")
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
        src_output_types = _effective_output_types(src)
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


def validate_swarm_machine(machine: Any) -> list[str]:
    """Dry-run validation for a machine-form swarm spec.

    Returns a list of human-readable error sentences; an empty list means
    the machine is valid. Rules: states are 1..1024 with unique slug ids and
    at least one entry state; every state requires a subagent and entry
    states declare no inputs; resident states declare no outputs, foreach,
    or outgoing transitions; wait blocks are rejected (the watch host
    handlers arrive with the communication series); transitions reference
    existing states (self-loops are legal re-entry) and may carry one guard
    over the from-state's latest settle output. There is no acyclicity
    requirement: arbitrary state machines, including cycles, validate.
    """
    if not isinstance(machine, dict):
        return ["swarm machine must be a JSON object"]
    errors: list[str] = []
    run = machine.get("run")
    if run is not None and not isinstance(run, dict):
        errors.append("run must be an object")
        run = None
    run_budget = _validate_run_fields(run, errors)

    states = machine.get("states")
    if not isinstance(states, list):
        errors.append("swarm machine requires a states list")
        return errors
    if not 1 <= len(states) <= MAX_STATES:
        errors.append(f"swarm machine must declare between 1 and {MAX_STATES} states, got {len(states)}")
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

    for state_id, state in states_by_id.items():
        _validate_state_fields(
            state, run_budget=run_budget, states_by_id=states_by_id, noun="state", errors=errors
        )
        entry = state.get("entry", STATE_ENTRY_DEFAULT)
        if entry is not None and not isinstance(entry, bool):
            errors.append(f"state {state_id} entry must be a boolean")
        max_entries = state.get("max_entries")
        if max_entries is not None and not (_is_int(max_entries) and max_entries >= STATE_MAX_ENTRIES_DEFAULT):
            errors.append(f"state {state_id} max_entries must be an integer >= {STATE_MAX_ENTRIES_DEFAULT}")
        if entry is True and _port_list(state, "inputs"):
            errors.append(f"entry state {state_id} cannot declare inputs")

    # The entry check needs at least one well-formed state: a machine whose
    # only state failed its id check reports that problem alone, and a flag
    # that is not a boolean never counts as declaring an entry.
    if states_by_id and not any(state.get("entry") is True for state in states_by_id.values()):
        errors.append("swarm machine requires at least one entry state")

    transitions = machine.get("transitions")
    if transitions is None:
        transitions = []
    if not isinstance(transitions, list):
        errors.append("swarm machine transitions must be a list")
        return errors
    for index, transition in enumerate(transitions):
        if not isinstance(transition, dict):
            errors.append(f"transitions[{index}] must be an object")
            continue
        src = transition.get("from")
        dst = transition.get("to")
        if not _is_nonempty_str(src):
            errors.append(f"transitions[{index}] requires a non-empty from")
        elif src not in states_by_id:
            errors.append(f"transitions[{index}] references unknown from-state {src!r}")
        if not _is_nonempty_str(dst):
            errors.append(f"transitions[{index}] requires a non-empty to")
        elif dst not in states_by_id:
            errors.append(f"transitions[{index}] references unknown to-state {dst!r}")
        on = transition.get("on", TRANSITION_ON_KINDS[0])
        if on not in TRANSITION_ON_KINDS:
            errors.append(f"transitions[{index}] on must be one of {list(TRANSITION_ON_KINDS)}, got {on!r}")
        if isinstance(src, str) and src in states_by_id:
            src_state = states_by_id[src]
            if src_state.get("lifecycle", NODE_LIFECYCLE_DEFAULT) == "resident":
                errors.append(f"transitions[{index}] cannot leave resident state {src!r}")
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


def compile_swarm_dag(dag: Any) -> "tuple[dict[str, Any] | None, list[str]]":
    """Compile a dag-form spec into machine form.

    Returns ``(machine, errors)``: on success the machine is a spec-shaped
    dict (defaults are applied later by ``canonicalize_swarm_spec``) and the
    error list is empty; on any dag-level error the machine is ``None`` and
    the errors carry the V1 dag wording. Each node becomes a state with
    ``entry`` set when it has no effective dependencies and ``max_entries``
    1; each effective dependency edge becomes one guard-less transition.
    Wait blocks are rejected by the shared field check (they are gated until
    the communication series); the compiler itself has no wait support.
    """
    if not isinstance(dag, dict):
        return None, ["swarm dag must be a JSON object"]
    errors: list[str] = []
    run = dag.get("run")
    if run is not None and not isinstance(run, dict):
        errors.append("run must be an object")
        run = None
    run_budget = _validate_run_fields(run, errors)

    nodes = dag.get("nodes")
    if not isinstance(nodes, list):
        return None, errors + ["swarm dag requires a nodes list"]
    if not 1 <= len(nodes) <= MAX_NODES:
        return None, errors + [f"swarm dag must declare between 1 and {MAX_NODES} nodes, got {len(nodes)}"]

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
        for dep in edges:
            machine["transitions"].append({"from": dep, "to": node["id"]})
    return machine, []


# ---------------------------------------------------------------------------
# Unified entry points.
# ---------------------------------------------------------------------------


def validate_swarm_spec(spec: Any) -> list[str]:
    """Dry-run validation for a swarm spec in either form.

    Detects the form first: a spec carrying "states" or "transitions" is
    machine form; anything else is dag form and compiles to machine form
    first. A spec carrying both dag and machine keys is rejected outright.
    Returns a list of human-readable error sentences; an empty list means
    the specification is valid. Every rule is enforced before a swarm entry
    is stored, so an invalid spec never reaches the store.
    """
    if not isinstance(spec, dict):
        return ["swarm dag must be a JSON object"]
    if _is_machine_form(spec) and "nodes" in spec:
        return ["pass either dag or machine form, not both"]
    if _is_machine_form(spec):
        return validate_swarm_machine(spec)
    machine, errors = compile_swarm_dag(spec)
    if errors:
        return errors
    # Defense in depth: a compiled dag must produce a valid machine.
    return validate_swarm_machine(machine)


def _canonicalize_machine(machine: dict[str, Any]) -> dict[str, Any]:
    """Apply defaults to a validated machine and normalize it into a clean dict.

    Defaults: run failure_policy 'escalate', run max_parallel 8, run
    max_transitions 10 per state capped at 10000, state entry False, state
    max_entries 1, state lifecycle 'task', state retries 0, state
    failure_policy copied from the run policy, and transition on 'settled'.
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


def canonicalize_swarm_spec(spec: Any) -> dict[str, Any]:
    """Validate a spec in either form and return the canonical MACHINE form.

    Raises ``ValueError`` with the joined error list when the spec is
    invalid (including the both-forms rejection). Dag specs compile to
    machine form first, so the executor sees one shape:
    ``{"run": ..., "states": [...], "transitions": [...]}``.
    """
    errors = validate_swarm_spec(spec)
    if errors:
        raise ValueError("; ".join(errors))
    assert isinstance(spec, dict)  # validated above
    if _is_machine_form(spec):
        machine = spec
    else:
        machine, compile_errors = compile_swarm_dag(spec)
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
        raise ValueError(f"the swarm graph contains a cycle involving nodes: {', '.join(stuck)}")
    return order


__all__ = [
    "SwarmExecutor",
    "SwarmRun",
    "canonicalize_swarm_spec",
    "compile_swarm_dag",
    "default_swarm_executor",
    "resume_swarm",
    "run_swarm",
    "status_swarm",
    "stop_swarm",
    "topological_order",
    "validate_swarm_machine",
    "validate_swarm_spec",
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
    """Unique, readable sibling name for one spawned instance (host caps names at 64)."""
    parts = ["sw", state_id[:20], run_id[:6]]
    if instance_index >= 0:
        parts.append(f"i{instance_index}")
    if attempt > 1:
        parts.append(f"a{attempt}")
    return "-".join(parts)


def _parse_json_output(answer: str, output_name: str) -> tuple[Any, str | None]:
    """Extract one named JSON output from an upstream answer.

    Prefers the trailing fenced `````json`` block whose object contains the
    output name, then falls back to parsing the whole answer. Returns
    ``(value, None)`` or ``(None, error_sentence)``.
    """
    candidates: list[str] = []
    fenced = _FENCED_JSON_RE.findall(answer)
    if fenced:
        candidates.append(fenced[-1])
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
        return float(actual) == float(expected)
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
    attempt: int = 0  # spawn admissions tried for this instance
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
    status: str = "pending"  # pending | running | waiting | done | error | cancelled
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
class SwarmRun:
    """Executor-side state for one run. Kernel memory only: it does not
    survive a kernel restart; the children (supervisor-owned) keep running."""

    run_id: str
    spec_id: str
    name: str | None
    state: str = "running"  # running | stopping | paused | done | failed | stopped
    started_at: float = 0.0
    max_parallel: int = RUN_MAX_PARALLEL_DEFAULT
    max_transitions: int = MAX_TRANSITIONS_CAP
    max_transitions_reported: bool = False
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


class SwarmExecutor:
    """Runs canonicalized state-machine swarms through the existing RLM supervisor.

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
        self._runs: dict[str, SwarmRun] = {}

    # -- public API ---------------------------------------------------------

    async def run(self, spec_id: str, *, name: str | None = None) -> dict[str, Any]:
        """Validate a stored swarm spec and start a run of it.

        The dry run happens in two halves. Write time (``create_swarm``)
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
        entry = harness.get("swarm", spec_id)
        if entry is None:
            raise ValueError(f"unknown swarm spec {spec_id!r}")
        arguments = entry.arguments if isinstance(entry.arguments, dict) else {}
        spec = arguments.get("machine")
        if spec is None:
            spec = arguments.get("dag")
        canonical = canonicalize_swarm_spec(spec)
        resolved, reference_errors = self._resolve_subagents(harness, canonical)
        if reference_errors:
            raise ValueError("; ".join(reference_errors))
        run = self._create_run(entry.id, canonical, resolved, name=name)
        self._runs[run.run_id] = run
        self._event(
            run, "run_started", detail=f"{len(run.states)} states, max_parallel {run.max_parallel}"
        )
        for state_id in run.order:
            state = run.states[state_id]
            if state.spec.get("entry"):
                self._enter_state(run, state, from_state=None)
        started = await self._spawn_ready(run, allow_backoff=False)
        if self._run_complete(run):
            await self._finalize(run)
        else:
            self._start_loop(run)
        return {
            "run_id": run.run_id,
            "spec_id": entry.id,
            "name": name,
            "nodes": len(run.states),
            "max_parallel": run.max_parallel,
            "started": started,
            "pending": self._pending_state_ids(run),
        }

    async def status(self, run_id: str) -> dict[str, Any]:
        """State states, the trailing event window, elapsed time, and usage.

        Every call marks the whole ledger ``delivered`` (the parent read
        it); the returned window is the last ``EVENT_WINDOW`` events.
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
        if run.state == "stopped":
            return {"run_id": run.run_id, "state": "stopped", "cancelled": []}
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
            raise ValueError(f"swarm run {run_id!r} is {run.state!r}, not paused")
        run.state = "running"
        run.pause_reason = None
        self._event(run, "resumed", detail="resumed by caller")
        # Evaluate settles first: paused runs may still carry transitions to
        # fire (escalate) before anything can be admitted.
        await self._evaluate_settles(run)
        # allow_backoff=False: like run(), resume() must never sleep inside
        # the calling model turn; rate-limited admissions defer to the loop.
        started = await self._spawn_ready(run, allow_backoff=False)
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

    def _require_run(self, run_id: str) -> SwarmRun:
        run = self._runs.get(run_id)
        if run is None:
            raise ValueError(f"unknown swarm run {run_id!r}")
        return run

    def _resolve_subagents(
        self, harness: Any, canonical: dict[str, Any]
    ) -> tuple[dict[str, tuple[str, str | None, str | None]], list[str]]:
        """Resolve every state's subagent reference; collect ALL failures.

        A string reference is a harness subagent entry id or title: its
        content is the prompt template and ``metadata.model``/``metadata.thinking``
        carry optional spawn settings. An inline object uses its own fields.
        """
        resolved: dict[str, tuple[str, str | None, str | None]] = {}
        errors: list[str] = []
        for state_spec in canonical["states"]:
            state_id = state_spec["id"]
            reference = state_spec["subagent"]
            if isinstance(reference, dict):
                prompt = reference.get("prompt")
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
            resolved[state_id] = (prompt, model, thinking)
        return resolved, errors

    def _create_run(
        self,
        spec_id: str,
        canonical: dict[str, Any],
        resolved: dict[str, tuple[str, str | None, str | None]],
        *,
        name: str | None,
    ) -> SwarmRun:
        run_spec = canonical["run"]
        run = SwarmRun(
            run_id=uuid4().hex,
            spec_id=spec_id,
            name=name,
            started_at=self._now_fn(),
            max_parallel=run_spec["max_parallel"],
            max_transitions=run_spec["max_transitions"],
            run_budget_ms=run_spec.get("budget_ms"),
        )
        position_of: dict[str, int] = {}
        for position, state_spec in enumerate(canonical["states"]):
            position_of[state_spec["id"]] = position
            state_id = state_spec["id"]
            prompt, model, thinking = resolved.get(state_id, (None, None, None))
            run.states[state_id] = _StateRun(
                state_id=state_id,
                spec=state_spec,
                position=position,
                prompt_template=prompt,
                model=model,
                thinking=thinking,
                max_entries=state_spec.get("max_entries", STATE_MAX_ENTRIES_DEFAULT),
            )
            run.order.append(state_id)
        for transition in canonical.get("transitions") or []:
            run.transitions_from.setdefault(transition["from"], []).append(transition)
        return run

    # -- event ledger -------------------------------------------------------

    def _event(
        self,
        run: SwarmRun,
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

    async def _milestone(self, run: SwarmRun, kind: str, detail: str, *, node: str | None = None) -> None:
        """Record a run milestone and inject one quiet notice (one per kind)."""
        if kind in run.milestones:
            return
        run.milestones.add(kind)
        event = self._event(run, "milestone", milestone=kind, detail=detail, node=node)
        try:
            from . import host_request

            payload: dict[str, Any] = {"run_id": run.run_id, "kind": kind, "detail": detail}
            if node is not None:
                payload["node"] = node
            await host_request("swarm.progress", payload)
            event["stage"] = "shown"
        except Exception:
            # A dead bridge cannot be told; the ledger keeps the milestone and
            # status() still surfaces it to the parent.
            pass

    # -- entries, transitions -------------------------------------------------

    def _enter_state(self, run: SwarmRun, state: _StateRun, *, from_state: str | None) -> _StateEntry:
        """Create one new entry of a state (bounded by max_entries upstream)."""
        entry = _StateEntry(index=len(state.entries))
        state.entries.append(entry)
        state.entries_used += 1
        detail = "entry state" if from_state is None else f"entered from {from_state}"
        self._event(run, "state_entry", node=state.state_id, entry=entry.index, detail=detail)
        return entry

    def _queue_settle(self, run: SwarmRun, state: _StateRun, entry: _StateEntry) -> None:
        entry.is_settle = True
        # The third element is the transition index to resume from: 0 for a
        # fresh settle, or the paused index after a max_transitions pause.
        run.pending_evaluations.append((state.state_id, entry.index, 0))

    async def _evaluate_settles(self, run: SwarmRun) -> None:
        """Evaluate every queued settle's outgoing transitions once.

        ALL transitions whose guards pass fire (fan-out is legal); a fire
        enters the target unless it is out of max_entries (recorded as
        transition_blocked). Exceeding max_transitions pauses the run once
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
                when = transition.get("when")
                if when is not None and not _guard_passes(when, outputs):
                    continue
                target = run.states[transition["to"]]
                if target.entries_used >= target.max_entries:
                    self._event(
                        run,
                        "transition_blocked",
                        detail=(
                            f"state {target.state_id!r} is at max_entries "
                            f"{target.max_entries}; transition {state_id!r} -> {target.state_id!r} blocked"
                        ),
                        **{"from": state_id, "to": target.state_id},
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
                        f"resume with await rlm.swarm.resume('{run.run_id}')",
                    )
                    return
                run.transitions_fired += 1
                self._event(
                    run,
                    "transition_fired",
                    detail=f"{state_id!r} -> {target.state_id!r}",
                    **{"from": state_id, "to": target.state_id},
                )
                self._enter_state(run, target, from_state=state_id)

    # -- readiness, binding, admission --------------------------------------

    async def _spawn_ready(self, run: SwarmRun, *, allow_backoff: bool) -> list[str]:
        """Prepare ready entries and admit pending instances up to max_parallel.

        Returns the state ids that had at least one instance admitted here.
        """
        started: list[str] = []
        while run.state == "running":
            await self._prepare_ready_entries(run)
            if run.state != "running":
                break
            if self._running_instance_count(run) >= run.max_parallel:
                break
            pair = self._next_pending_instance(run)
            if pair is None:
                break
            state, entry, instance = pair
            outcome = await self._admit(run, state, entry, instance, allow_backoff=allow_backoff)
            if outcome == "admitted" and state.state_id not in started:
                started.append(state.state_id)
            if outcome == "deferred":
                # A rate limit is usually global, so stop admitting in this
                # phase; the control loop retries with exponential backoff.
                break
        return started

    async def _prepare_ready_entries(self, run: SwarmRun) -> None:
        """Bind inputs and create instances for every entry whose input
        sources have settles; wait entries register their watch instead."""
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
        self, run: SwarmRun, state: _StateRun, entry: _StateEntry
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
            if latest is None:
                if inp.get("optional"):
                    # Optional inputs bind a null sentinel when their source
                    # never settled, so loop states can re-enter before their
                    # upstream partner has run (a compiled dag never sets
                    # optional: its input edges are transitions, so the
                    # wait-for-the-source semantics stay V1-exact).
                    values[name] = "null" if port_type == "json" else "None"
                    continue
                return None, None  # wait for the source's first settle
            if latest.status == "error":
                return None, f"input {name!r} from state {src_id!r} is unavailable (latest settle status 'error')"
            outputs = latest.outputs or {}
            output_errors = latest.output_errors or {}
            if src_output in output_errors:
                return None, f"input {name!r}: {output_errors[src_output]}"
            if src_output not in outputs:
                return None, f"input {name!r} from state {src_id!r} has no captured output {src_output!r}"
            value = outputs[src_output]
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

    def _next_pending_instance(self, run: SwarmRun) -> "tuple[_StateRun, _StateEntry, _NodeInstance] | None":
        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                for instance in entry.instances:
                    if instance.status == "pending":
                        return state, entry, instance
        return None

    async def _admit(
        self, run: SwarmRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, *, allow_backoff: bool
    ) -> str:
        """Spawn one instance. Returns "admitted", "deferred", or "failed".

        Rate-limited admissions back off and retry: doubling delays capped
        at 60s, at most ``BACKOFF_MAX_ATTEMPTS`` admissions per call, then
        the entry fails through its failure_policy. In the admission phase
        (``allow_backoff=False``) a rate limit does not sleep inside
        ``run()``/``resume()``: the instance stays pending ("deferred") and
        the control loop retries it with backoff. Any other admission error
        fails the entry immediately.
        """
        from . import spawn

        instance.attempt += 1
        child_name = _child_name(run.run_id, state.state_id, instance.index, instance.attempt)
        tries = BACKOFF_MAX_ATTEMPTS if allow_backoff else 1
        delay = BACKOFF_BASE_SECONDS
        last_error = "spawn admission failed"
        for try_index in range(tries):
            try:
                handle = await spawn(
                    instance.prompt, name=child_name, model=state.model, thinking=state.thinking
                )
            except RuntimeError as exc:
                last_error = str(exc)
                if not _is_rate_limit_error(last_error):
                    break
                if try_index < tries - 1:
                    self._event(
                        run,
                        "spawn_backoff",
                        node=state.state_id,
                        entry=entry.index,
                        instance=instance.index,
                        detail=f"rate limited; retrying in {delay:g}s",
                    )
                    await self._sleep_fn(delay)
                    delay = min(delay * 2, BACKOFF_CAP_SECONDS)
                continue
            instance.child_id = handle.rlm_child_id
            instance.spawned_at = self._now_fn()
            instance.status = "running"
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
        if not allow_backoff and _is_rate_limit_error(last_error):
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

    # -- settlement, retries, policies ---------------------------------------

    async def _apply_settlement(
        self, run: SwarmRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, result: Any
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
        self, run: SwarmRun, state: _StateRun, entry: _StateEntry, instance: _NodeInstance, reason: str, *, retry: bool
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
        if retry and instance.attempt <= retries:
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
        self, run: SwarmRun, state: _StateRun, entry: _StateEntry, reason: str
    ) -> None:
        if entry.status in TERMINAL_ENTRY_STATUSES:
            return  # the policy already ran for this entry
        policy = state.spec.get("failure_policy", RUN_FAILURE_POLICY_DEFAULT)
        entry.status = "error"
        entry.error = reason
        state.error = reason
        self._event(run, "node_error", node=state.state_id, entry=entry.index, error=reason, detail=f"failure_policy {policy}")
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
                f"state {state.state_id} failed: {reason}; resume with await rlm.swarm.resume('{run.run_id}')",
                node=state.state_id,
            )

    async def _halt_nonterminal(self, run: SwarmRun, reason: str) -> list[str]:
        """Delete every running child, cancel every active watch, and cancel
        every non-terminal entry; never-entered states are marked cancelled."""
        stopped = [
            state_id
            for state_id in run.order
            if run.states[state_id].status in ("pending", "running", "waiting")
        ]
        await self._cancel_running(run)
        for state_id in stopped:
            state = run.states[state_id]
            if state.status in ("pending", "running", "waiting"):
                state.cancelled = True
                for entry in state.entries:
                    if entry.status in ("pending", "running", "waiting"):
                        entry.status = "cancelled"
                        self._event(run, "node_cancelled", node=state_id, entry=entry.index, detail=reason)
        return stopped

    async def _cancel_running(self, run: SwarmRun) -> None:
        from . import delete_subagent

        for state_id in run.order:
            state = run.states[state_id]
            for entry in state.entries:
                for instance in entry.instances:
                    if instance.status != "running" or instance.child_id is None:
                        continue
                    child_id = instance.child_id
                    try:
                        await delete_subagent(child_id)
                    except Exception as exc:
                        self._event(run, "cancel_failed", node=state_id, entry=entry.index, instance=instance.index, child=child_id, error=str(exc))
                    else:
                        self._event(run, "cancelled", node=state_id, entry=entry.index, instance=instance.index, child=child_id)
                    # The child is supervisor-owned; a failed delete leaves it
                    # running there, but the executor treats its slot as released.
                    instance.status = "cancelled"

    # -- completion ----------------------------------------------------------

    def _run_complete(self, run: SwarmRun) -> bool:
        """Quiescence: nothing in flight (no pending/running/waiting entry,
        and no unevaluated settle). Admitted resident entries are not in
        flight: they stay alive under the parent session until
        rlm.swarm.stop() or session teardown."""
        if run.pending_evaluations:
            return False
        for state in run.states.values():
            for entry in state.entries:
                if entry.status in ("pending", "running", "waiting"):
                    if state.lifecycle == "resident" and entry.status == "running":
                        continue
                    return False
        return True

    async def _finalize(self, run: SwarmRun) -> None:
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
            detail += f"; {len(residents)} resident state(s) still running (stop with await rlm.swarm.stop('{run.run_id}'))"
        await self._milestone(run, "finished", detail)

    # -- control loop --------------------------------------------------------

    def _start_loop(self, run: SwarmRun) -> None:
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            run.state = "failed"
            self._event(run, "executor_error", error="no running asyncio loop; the swarm control loop needs one")
            return
        run.task = loop.create_task(self._control_loop(run))

    async def _control_loop(self, run: SwarmRun) -> None:
        import asyncio

        try:
            await self._loop_body(run)
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

    async def _loop_body(self, run: SwarmRun) -> None:
        import asyncio

        from . import collect

        while run.state == "running":
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
                    result = settled.get(instance.child_id or "")
                    if result is not None:
                        await self._apply_settlement(run, state, entry, instance, result)
            # Re-check state before completion: stop() (or a policy transition)
            # can land while the collect above was in flight, and a run that
            # was stopped must never finalize as done.
            if run.state != "running":
                return
            await self._evaluate_settles(run)
            if run.state != "running":
                return
            if self._run_complete(run):
                await self._finalize(run)
                return
            if run.run_budget_ms is not None and not run.budget_reported:
                elapsed_ms = (self._now_fn() - run.started_at) * 1000
                if elapsed_ms > run.run_budget_ms:
                    # Run budget: pause new spawns only; children already in
                    # flight keep running and settle normally.
                    run.state = "paused"
                    run.pause_reason = "run budget exceeded"
                    run.budget_reported = True
                    await self._milestone(
                        run,
                        "budget_exceeded",
                        f"run budget_ms {run.run_budget_ms} exceeded after {int(elapsed_ms)}ms; no new spawns; "
                        f"resume with await rlm.swarm.resume('{run.run_id}')",
                    )
                    return
            started = await self._spawn_ready(run, allow_backoff=True)
            if run.state != "running":
                return
            if (
                not in_flight
                and not started
                and not self._has_pending_instance(run)
                and not run.pending_evaluations
            ):
                # Defensive: nothing in flight, nothing admitted, nothing
                # pending. The one reachable shape is a pending entry whose
                # input source never settled; end the run instead of spinning.
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

    def _running_instance_count(self, run: SwarmRun) -> int:
        return sum(
            1
            for state in run.states.values()
            for entry in state.entries
            for instance in entry.instances
            if instance.status == "running"
        )

    def _has_pending_instance(self, run: SwarmRun) -> bool:
        return any(
            instance.status == "pending"
            for state in run.states.values()
            for entry in state.entries
            for instance in entry.instances
        )

    def _pending_state_ids(self, run: SwarmRun) -> list[str]:
        return [state_id for state_id in run.order if run.states[state_id].status == "pending"]


_DEFAULT_EXECUTOR: SwarmExecutor | None = None


def default_swarm_executor() -> SwarmExecutor:
    """The process-wide executor behind the ``rlm.swarm`` namespace.

    Tests that need an injected clock or sleep assign their own
    ``SwarmExecutor`` to ``swarm._DEFAULT_EXECUTOR``; the namespace then
    routes through it.
    """
    global _DEFAULT_EXECUTOR
    if _DEFAULT_EXECUTOR is None:
        _DEFAULT_EXECUTOR = SwarmExecutor()
    return _DEFAULT_EXECUTOR


async def run_swarm(spec_id: str, *, name: str | None = None) -> dict[str, Any]:
    """Validate a stored swarm spec and start a nonblocking run of it."""
    return await default_swarm_executor().run(spec_id, name=name)


async def status_swarm(run_id: str) -> dict[str, Any]:
    """Return state states, the event window, elapsed time, and usage."""
    return await default_swarm_executor().status(run_id)


async def stop_swarm(run_id: str) -> dict[str, Any]:
    """Cancel every running child of the run and mark it stopped."""
    return await default_swarm_executor().stop(run_id)


async def resume_swarm(run_id: str) -> dict[str, Any]:
    """Resume a paused run (escalate, budget, or max_transitions pause)."""
    return await default_swarm_executor().resume(run_id)
