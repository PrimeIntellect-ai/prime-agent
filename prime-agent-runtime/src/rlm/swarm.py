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

This module implements the write-time dry run for both forms: the machine
validator, the dag-to-machine compiler, the unified entry point
(``validate_swarm_spec`` detects the form), and a canonicalizer that
applies defaults and returns the canonical MACHINE form. Execution
(run/status/stop) lands in a follow-up PR; nothing here spawns states.
"""

from __future__ import annotations

import copy
import heapq
import re
from typing import Any

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
    policies, port lists, foreach, and the wait/resident exclusions."""
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
        if not isinstance(value, list):
            errors.append(f"transitions[{index}] when.op 'contains' requires a list value")
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
    "canonicalize_swarm_spec",
    "compile_swarm_dag",
    "topological_order",
    "validate_swarm_machine",
    "validate_swarm_spec",
]
