"""Swarm DAG specification helpers and executor.

A continual-harness ``swarm`` entry stores a declarative DAG of subagent
nodes in ``arguments["dag"]``. The first half of this module implements
the write-time dry run: a validator that checks the whole graph before
anything is stored, a canonicalizer that applies defaults, and a stable
topological sort used for cycle detection.

The second half implements the executor (``SwarmExecutor`` and the
``rlm.swarm`` namespace: run/status/stop/resume). The executor runs a
canonicalized DAG through the existing RLM supervisor: nodes are admitted
with ``rlm.spawn``, settled through ``rlm.collect``, and cancelled with
``rlm.delete_subagent``. The supervisor owns the children; the executor
owns the run state in kernel memory. Runs do not survive a kernel restart
(the registry lives in this module's state); children are supervisor-owned
and keep running, so ``rlm.list_subagents`` can still see them after a
restart.
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
MAX_NODES = 1024
MAX_RETRIES = 10
MAX_PARALLEL_MIN = 1
MAX_PARALLEL_MAX = 64
FOREACH_MAX_MIN = 1
FOREACH_MAX_MAX = 256
RUN_FAILURE_POLICY_DEFAULT = "escalate"
RUN_MAX_PARALLEL_DEFAULT = 8
NODE_LIFECYCLE_DEFAULT = "task"
NODE_RETRIES_DEFAULT = 0

_NODE_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")


def _is_int(value: Any) -> bool:
    """True for real integers; booleans are not accepted as ints."""
    return isinstance(value, int) and not isinstance(value, bool)


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


def _cycle_check_nodes(nodes_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Build a cleaned graph for the cycle check.

    Edges already reported as errors (unknown targets, self edges, and
    resident targets) are dropped so the cycle check reports each problem
    once instead of duplicating those errors.
    """
    def edge_ok(node_id: str, dep: str) -> bool:
        return (
            dep in nodes_by_id
            and dep != node_id
            and nodes_by_id[dep].get("lifecycle", NODE_LIFECYCLE_DEFAULT) != "resident"
        )

    cleaned: list[dict[str, Any]] = []
    for node_id, node in nodes_by_id.items():
        entry: dict[str, Any] = {"id": node_id}
        entry["depends_on"] = [dep for dep in _port_list(node, "depends_on") if edge_ok(node_id, dep)]
        kept_inputs = [
            {"from": inp["from"]}
            for inp in _port_list(node, "inputs")
            if isinstance(inp, dict)
            and isinstance(inp.get("from"), str)
            and "." in inp["from"]
            and edge_ok(node_id, inp["from"].partition(".")[0])
        ]
        if kept_inputs:
            entry["inputs"] = kept_inputs
        cleaned.append(entry)
    return cleaned


def validate_swarm_spec(dag: Any) -> list[str]:
    """Dry-run validation for a swarm DAG.

    Returns a list of human-readable error sentences; an empty list means
    the specification is valid. Every rule checked here is enforced before
    a swarm entry is stored, so an invalid DAG never reaches the store.
    """
    errors: list[str] = []
    if not isinstance(dag, dict):
        return ["swarm dag must be a JSON object"]

    run = dag.get("run")
    if run is not None:
        if not isinstance(run, dict):
            errors.append("run must be an object")
            run = None
    run_budget = run.get("budget_ms") if isinstance(run, dict) else None
    if run_budget is not None and not _is_positive_int(run_budget):
        errors.append("run budget_ms must be a positive integer")
        run_budget = None
    run_policy = run.get("failure_policy") if isinstance(run, dict) else None
    if run_policy is not None and run_policy not in FAILURE_POLICIES:
        errors.append(f"run failure_policy must be one of {list(FAILURE_POLICIES)}, got {run_policy!r}")
    max_parallel = run.get("max_parallel") if isinstance(run, dict) else None
    if max_parallel is not None and not (
        _is_int(max_parallel) and MAX_PARALLEL_MIN <= max_parallel <= MAX_PARALLEL_MAX
    ):
        errors.append(f"run max_parallel must be an integer between {MAX_PARALLEL_MIN} and {MAX_PARALLEL_MAX}")

    nodes = dag.get("nodes")
    if not isinstance(nodes, list):
        errors.append("swarm dag requires a nodes list")
        return errors
    if not 1 <= len(nodes) <= MAX_NODES:
        errors.append(f"swarm dag must declare between 1 and {MAX_NODES} nodes, got {len(nodes)}")
        return errors

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
        ref = node_id
        lifecycle = node.get("lifecycle", NODE_LIFECYCLE_DEFAULT)
        if lifecycle not in LIFECYCLES:
            errors.append(f"node {ref} lifecycle must be 'task' or 'resident', got {lifecycle!r}")
        is_resident = lifecycle == "resident"

        subagent = node.get("subagent")
        if _is_nonempty_str(subagent):
            pass  # Harness subagent entry id or title; resolved at run time.
        elif isinstance(subagent, dict):
            if not _is_nonempty_str(subagent.get("prompt")):
                errors.append(f"node {ref} inline subagent requires a non-empty prompt")
            for key in ("name", "model", "thinking"):
                value = subagent.get(key)
                if value is not None and not _is_nonempty_str(value):
                    errors.append(f"node {ref} inline subagent {key} must be a non-empty string when provided")
        else:
            errors.append(
                f"node {ref} requires a subagent: a harness subagent id/title string "
                "or an inline object with a prompt"
            )

        budget = node.get("budget_ms")
        if budget is not None:
            if not _is_positive_int(budget):
                errors.append(f"node {ref} budget_ms must be a positive integer")
            elif run_budget is not None and budget > run_budget:
                errors.append(f"node {ref} budget_ms {budget} exceeds the run budget_ms {run_budget}")

        retries = node.get("retries")
        if retries is not None and not (_is_int(retries) and 0 <= retries <= MAX_RETRIES):
            errors.append(f"node {ref} retries must be an integer between 0 and {MAX_RETRIES}")

        policy = node.get("failure_policy")
        if policy is not None and policy not in FAILURE_POLICIES:
            errors.append(f"node {ref} failure_policy must be one of {list(FAILURE_POLICIES)}, got {policy!r}")

        outputs = node.get("outputs")
        if outputs is not None and not isinstance(outputs, list):
            errors.append(f"node {ref} outputs must be a list")
        elif is_resident and isinstance(outputs, list) and outputs:
            errors.append(f"resident node {ref} cannot declare outputs")
        reported_duplicate_outputs: set[str] = set()
        for index, out in enumerate(_port_list(node, "outputs")):
            if not isinstance(out, dict):
                errors.append(f"node {ref} outputs[{index}] must be an object")
                continue
            name, port_type = out.get("name"), out.get("type")
            if not _is_nonempty_str(name):
                errors.append(f"node {ref} outputs[{index}] requires a non-empty name")
            elif _port_names(node, "outputs").count(name) > 1 and name not in reported_duplicate_outputs:
                reported_duplicate_outputs.add(name)
                errors.append(f"node {ref} declares duplicate output name {name!r}")
            if port_type not in PORT_TYPES:
                errors.append(f"node {ref} output {name!r} type must be 'text' or 'json'")

        inputs = node.get("inputs")
        if inputs is not None and not isinstance(inputs, list):
            errors.append(f"node {ref} inputs must be a list")
        reported_duplicate_inputs: set[str] = set()
        for index, inp in enumerate(_port_list(node, "inputs")):
            if not isinstance(inp, dict):
                errors.append(f"node {ref} inputs[{index}] must be an object")
                continue
            name, port_type, source = inp.get("name"), inp.get("type"), inp.get("from")
            if not _is_nonempty_str(name):
                errors.append(f"node {ref} inputs[{index}] requires a non-empty name")
            elif _port_names(node, "inputs").count(name) > 1 and name not in reported_duplicate_inputs:
                reported_duplicate_inputs.add(name)
                errors.append(f"node {ref} declares duplicate input name {name!r}")
            if port_type not in PORT_TYPES:
                errors.append(f"node {ref} input {name!r} type must be 'text' or 'json'")
            if not isinstance(source, str) or "." not in source:
                errors.append(
                    f"node {ref} input {name!r} requires a 'from' reference of the form '<node_id>.<output_name>'"
                )
                continue
            src_id, _, src_output = source.partition(".")
            if src_id not in nodes_by_id:
                errors.append(f"node {ref} input {name!r} references unknown node {src_id!r}")
                continue
            src = nodes_by_id[src_id]
            if src.get("lifecycle", NODE_LIFECYCLE_DEFAULT) == "resident":
                errors.append(f"node {ref} input {name!r} cannot read from resident node {src_id!r}")
                continue
            src_output_types = _declared_port_types(src, "outputs")
            if src_output not in src_output_types:
                errors.append(
                    f"node {ref} input {name!r} references output {src_output!r} "
                    f"that node {src_id!r} does not declare"
                )
            elif port_type in PORT_TYPES and src_output_types[src_output] != port_type:
                errors.append(
                    f"node {ref} input {name!r} of type {port_type!r} cannot read from "
                    f"output {src_output!r} of type {src_output_types[src_output]!r}"
                )

        depends_on = node.get("depends_on")
        if depends_on is not None:
            if not isinstance(depends_on, list):
                errors.append(f"node {ref} depends_on must be a list of node ids")
            else:
                for dep in depends_on:
                    if not _is_nonempty_str(dep):
                        errors.append(f"node {ref} depends_on entries must be non-empty node id strings")
                    elif dep == ref:
                        errors.append(f"node {ref} cannot depend on itself")
                    elif dep not in nodes_by_id:
                        errors.append(f"node {ref} depends on unknown node {dep!r}")
                    elif nodes_by_id[dep].get("lifecycle", NODE_LIFECYCLE_DEFAULT) == "resident":
                        errors.append(f"node {ref} cannot depend on resident node {dep!r}")

        foreach = node.get("foreach")
        if foreach is not None:
            if is_resident:
                errors.append(f"resident node {ref} cannot use foreach")
            if not isinstance(foreach, dict):
                errors.append(f"node {ref} foreach must be an object")
            else:
                over = foreach.get("over")
                if not _is_nonempty_str(over):
                    errors.append(f"node {ref} foreach.over must be a non-empty input name")
                else:
                    declared_inputs = _declared_port_types(node, "inputs")
                    if over not in declared_inputs:
                        errors.append(
                            f"node {ref} foreach.over must name one of this node's inputs, got {over!r}"
                        )
                    elif declared_inputs[over] != "json":
                        errors.append(f"node {ref} foreach.over input {over!r} must have type 'json'")
                foreach_max = foreach.get("max")
                if not (_is_int(foreach_max) and FOREACH_MAX_MIN <= foreach_max <= FOREACH_MAX_MAX):
                    errors.append(
                        f"node {ref} foreach.max must be an integer between {FOREACH_MAX_MIN} and {FOREACH_MAX_MAX}"
                    )

    # The graph must be acyclic over effective dependencies (depends_on plus
    # every inputs[].from source); edges already reported above are dropped.
    try:
        topological_order(_cycle_check_nodes(nodes_by_id))
    except ValueError as exc:
        errors.append(str(exc))
    return errors


def canonicalize_swarm_spec(dag: Any) -> dict[str, Any]:
    """Apply defaults and normalize a validated DAG into a clean dict.

    Raises ``ValueError`` with the joined error list when the DAG is
    invalid. Defaults: run failure_policy 'escalate', run max_parallel 8,
    node lifecycle 'task', node retries 0, and node failure_policy copied
    from the run policy.
    """
    errors = validate_swarm_spec(dag)
    if errors:
        raise ValueError("; ".join(errors))
    assert isinstance(dag, dict)  # validated above
    run_in = dag.get("run") if isinstance(dag.get("run"), dict) else {}
    run_policy = run_in.get("failure_policy", RUN_FAILURE_POLICY_DEFAULT)
    run: dict[str, Any] = {
        "failure_policy": run_policy,
        "max_parallel": run_in.get("max_parallel", RUN_MAX_PARALLEL_DEFAULT),
    }
    if "budget_ms" in run_in:
        run["budget_ms"] = run_in["budget_ms"]
    nodes_out: list[dict[str, Any]] = []
    for node in dag["nodes"]:
        node_out: dict[str, Any] = {
            "id": node["id"],
            "subagent": copy.deepcopy(node["subagent"]),
            "lifecycle": node.get("lifecycle", NODE_LIFECYCLE_DEFAULT),
            "retries": node.get("retries", NODE_RETRIES_DEFAULT),
            "failure_policy": node.get("failure_policy", run_policy),
        }
        if "budget_ms" in node:
            node_out["budget_ms"] = node["budget_ms"]
        if "depends_on" in node:
            # Deduplicate while preserving order.
            node_out["depends_on"] = list(dict.fromkeys(node.get("depends_on") or []))
        if "inputs" in node:
            node_out["inputs"] = copy.deepcopy(node["inputs"])
        if "outputs" in node:
            node_out["outputs"] = copy.deepcopy(node["outputs"])
        if "foreach" in node:
            node_out["foreach"] = copy.deepcopy(node["foreach"])
        nodes_out.append(node_out)
    return {"run": run, "nodes": nodes_out}


def topological_order(nodes: list[dict[str, Any]]) -> list[str]:
    """Return node ids in a dependency-respecting order.

    Edges are the effective dependencies: ``depends_on`` plus every
    ``inputs[].from`` source node. Raises ``ValueError`` on a duplicate id,
    an unknown dependency, or a cycle. The order is stable: among ready
    nodes, input order wins.
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
    "default_swarm_executor",
    "resume_swarm",
    "run_swarm",
    "status_swarm",
    "stop_swarm",
    "topological_order",
    "validate_swarm_spec",
]


# ---------------------------------------------------------------------------
# Executor: run a canonicalized DAG through the RLM supervisor.
# ---------------------------------------------------------------------------

ANSWER_CAPTURE_CAP = 200
"""Local safety cap for captured answers.

``rlm.collect`` already returns previews: the host caps them at 160
characters (``compactRlmText``). Input binding and every rendered prompt
therefore work on capped preview text; full child outputs stay in the
child's own session and are never seen by the executor.
"""

EVENT_WINDOW = 50
"""Number of trailing ledger events returned by ``status()``."""

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
TERMINAL_NODE_STATUSES = ("done", "error", "cancelled")


def _is_rate_limit_error(message: str) -> bool:
    """Heuristic: the host reports admission failures as error strings."""
    lowered = message.lower()
    return any(marker in lowered for marker in _RATE_LIMIT_MARKERS)


def _effective_deps(node_spec: dict[str, Any]) -> set[str]:
    """Dependencies that gate a node: depends_on plus every inputs[].from source."""
    deps = set(node_spec.get("depends_on") or [])
    for inp in node_spec.get("inputs") or []:
        source = inp.get("from")
        if isinstance(source, str) and "." in source:
            deps.add(source.partition(".")[0])
    return deps


def _child_name(run_id: str, node_id: str, instance_index: int, attempt: int) -> str:
    """Unique, readable sibling name for one spawned instance (host caps names at 64)."""
    parts = ["sw", node_id[:20], run_id[:6]]
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


@dataclass
class _NodeInstance:
    """One spawned child of one node (a foreach node has one per item)."""

    index: int  # -1 for plain nodes, 0..K-1 for foreach items
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
class _NodeRun:
    """Executor-side state for one node of one run."""

    node_id: str
    spec: dict[str, Any]  # canonical node spec
    position: int  # stable topological position for deterministic ordering
    prompt_template: str
    model: str | None = None
    thinking: str | None = None
    status: str = "pending"  # pending | running | done | error | cancelled
    instances: list[_NodeInstance] = field(default_factory=list)
    error: str | None = None

    @property
    def lifecycle(self) -> str:
        return self.spec.get("lifecycle", NODE_LIFECYCLE_DEFAULT)


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
    run_budget_ms: int | None = None
    budget_reported: bool = False
    pause_reason: str | None = None
    nodes: dict[str, _NodeRun] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    milestones: set[str] = field(default_factory=set)
    spawn_count: int = 0
    settle_count: int = 0
    tool_use_total: int = 0
    task: "asyncio.Task[None] | None" = None


def _validate_spawn_settings(model: Any, thinking: Any) -> str | None:
    for key, value in (("model", model), ("thinking", thinking)):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            return f"subagent {key} must be a non-empty string when provided"
    return None


class SwarmExecutor:
    """Runs canonicalized swarm DAGs through the existing RLM supervisor.

    Ownership split: the supervisor owns the children (admission via
    ``rlm.spawn``, settlement via ``rlm.collect``, cancellation via
    ``rlm.delete_subagent``); this executor owns the run state in kernel
    memory. Every host call resolves through the module-level ``rlm``
    functions and ``host_request`` at call time, so tests can patch
    ``rlm.host_request``. ``now`` (default ``time.monotonic``) and ``sleep``
    (default ``asyncio.sleep``) are injectable: budgets measure admission
    to settlement, and rate-limit backoff is testable with fake sleeps.

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
        validated the graph; here ``run`` re-validates and canonicalizes it,
        then resolves every node's subagent reference, reporting ALL
        failures in one ``ValueError`` and starting nothing on any failure.
        The resolved node count and ``max_parallel`` are reported in the
        result; actual admission limits (concurrency, tree depth, provider
        rate limits) are enforced at spawn time through the backoff path.
        Admission spawns every ready node up to ``max_parallel``, records
        handles, and returns; a background asyncio task continues the run, so
        the calling model turn ends immediately (nonblocking).
        """
        harness = self._resolve_harness()
        entry = harness.get("swarm", spec_id)
        if entry is None:
            raise ValueError(f"unknown swarm spec {spec_id!r}")
        dag = entry.arguments.get("dag") if isinstance(entry.arguments, dict) else None
        canonical = canonicalize_swarm_spec(dag)
        resolved, reference_errors = self._resolve_subagents(harness, canonical)
        if reference_errors:
            raise ValueError("; ".join(reference_errors))
        run = self._create_run(entry.id, canonical, resolved, name=name)
        self._runs[run.run_id] = run
        self._event(run, "run_started", detail=f"{len(run.nodes)} nodes, max_parallel {run.max_parallel}")
        started = await self._spawn_ready(run, allow_backoff=False)
        if self._run_complete(run):
            await self._finalize(run)
        else:
            self._start_loop(run)
        return {
            "run_id": run.run_id,
            "spec_id": entry.id,
            "name": name,
            "nodes": len(run.nodes),
            "max_parallel": run.max_parallel,
            "started": started,
            "pending": self._pending_node_ids(run),
        }

    async def status(self, run_id: str) -> dict[str, Any]:
        """Node states, the trailing event window, elapsed time, and usage.

        Every call marks the whole ledger ``delivered`` (the parent read
        it); the returned window is the last ``EVENT_WINDOW`` events.
        Raises ``ValueError`` for an unknown run id.
        """
        run = self._require_run(run_id)
        nodes: list[dict[str, Any]] = []
        for node_id in run.order:
            node = run.nodes[node_id]
            entry: dict[str, Any] = {
                "id": node.node_id,
                "status": node.status,
                "lifecycle": node.lifecycle,
                "attempts": sum(instance.attempt for instance in node.instances),
                "instances": [
                    {
                        "index": instance.index,
                        "status": instance.status,
                        "attempt": instance.attempt,
                        "child": instance.child_id,
                        "duration_ms": instance.duration_ms,
                        "error": instance.error,
                    }
                    for instance in node.instances
                ],
            }
            answer = self._node_answer(node)
            if answer is not None:
                entry["answer_preview"] = answer
            if node.error is not None:
                entry["error"] = node.error
            nodes.append(entry)
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
            },
        }

    async def stop(self, run_id: str) -> dict[str, Any]:
        """Cancel every running child of the run and mark it stopped.

        Sets the transitional ``stopping`` state before the first await so
        the control loop cannot admit new children or finalize the run
        while the cancellations are in flight. Idempotent: a second stop
        returns the same result without another ledger event.
        """
        run = self._require_run(run_id)
        if run.state == "stopped":
            return {"run_id": run.run_id, "state": "stopped", "cancelled": []}
        run.state = "stopping"
        stopped = await self._halt_nonterminal(run, "run stopped")
        run.state = "stopped"
        self._event(run, "run_stopped", detail=f"stopped; {len(stopped)} node(s) cancelled")
        return {"run_id": run.run_id, "state": "stopped", "cancelled": stopped}

    async def resume(self, run_id: str) -> dict[str, Any]:
        """Resume a paused run (escalate or budget pause) and restart the loop.

        A budget pause is reported once per run: resuming after it is an
        explicit operator decision and no further budget pauses fire.
        Raises ``ValueError`` when the run is not paused.
        """
        run = self._require_run(run_id)
        if run.state != "paused":
            raise ValueError(f"swarm run {run_id!r} is {run.state!r}, not paused")
        run.state = "running"
        run.pause_reason = None
        self._event(run, "resumed", detail="resumed by caller")
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
            "pending": self._pending_node_ids(run),
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
        """Resolve every node's subagent reference; collect ALL failures.

        A string reference is a harness subagent entry id or title: its
        content is the prompt template and ``metadata.model``/``metadata.thinking``
        carry optional spawn settings. An inline object uses its own fields.
        """
        resolved: dict[str, tuple[str, str | None, str | None]] = {}
        errors: list[str] = []
        for node_spec in canonical["nodes"]:
            node_id = node_spec["id"]
            reference = node_spec["subagent"]
            if isinstance(reference, dict):
                prompt = reference.get("prompt")
                model = reference.get("model")
                thinking = reference.get("thinking")
            else:
                entry = harness.get("subagent", reference)
                if entry is None:
                    entry = next((row for row in harness.list("subagent") if row.title == reference), None)
                if entry is None:
                    errors.append(f"node {node_id!r} references unknown subagent {reference!r}")
                    continue
                prompt = entry.content
                metadata = entry.metadata if isinstance(entry.metadata, dict) else {}
                model = metadata.get("model")
                thinking = metadata.get("thinking")
            if not isinstance(prompt, str) or not prompt.strip():
                errors.append(f"node {node_id!r} has an empty subagent prompt")
                continue
            settings_error = _validate_spawn_settings(model, thinking)
            if settings_error is not None:
                errors.append(f"node {node_id!r} {settings_error}")
                continue
            resolved[node_id] = (prompt, model, thinking)
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
            run_budget_ms=run_spec.get("budget_ms"),
        )
        run.order = topological_order(canonical["nodes"])
        position_of = {node_id: index for index, node_id in enumerate(run.order)}
        for node_spec in canonical["nodes"]:
            node_id = node_spec["id"]
            prompt, model, thinking = resolved[node_id]
            run.nodes[node_id] = _NodeRun(
                node_id=node_id,
                spec=node_spec,
                position=position_of[node_id],
                prompt_template=prompt,
                model=model,
                thinking=thinking,
            )
        return run

    # -- event ledger -------------------------------------------------------

    def _event(
        self,
        run: SwarmRun,
        kind: str,
        *,
        node: str | None = None,
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

    # -- readiness, binding, admission --------------------------------------

    async def _spawn_ready(self, run: SwarmRun, *, allow_backoff: bool) -> list[str]:
        """Initialize ready nodes and admit pending instances up to max_parallel.

        Returns the node ids that had at least one instance admitted here.
        """
        started: list[str] = []
        while run.state == "running":
            await self._initialize_ready_nodes(run)
            if run.state != "running":
                break
            if self._running_instance_count(run) >= run.max_parallel:
                break
            pair = self._next_pending_instance(run)
            if pair is None:
                break
            node, instance = pair
            outcome = await self._admit(run, node, instance, allow_backoff=allow_backoff)
            if outcome == "admitted" and node.node_id not in started:
                started.append(node.node_id)
            if outcome == "deferred":
                # A rate limit is usually global, so stop admitting in this
                # phase; the control loop retries with exponential backoff.
                break
        return started

    async def _initialize_ready_nodes(self, run: SwarmRun) -> None:
        """Bind inputs and create instances for every node whose deps are terminal."""
        for node_id in run.order:
            node = run.nodes[node_id]
            if node.status != "pending":
                continue
            deps = _effective_deps(node.spec)
            if not all(run.nodes[dep].status in TERMINAL_NODE_STATUSES for dep in deps):
                continue
            instances, reason = self._prepare_instances(run, node)
            if reason is not None:
                await self._apply_node_failure_policy(run, node, reason)
                if run.state != "running":
                    return
                continue
            node.instances = instances
            if instances:
                node.status = "running"
                self._event(run, "node_ready", node=node_id, detail=f"{len(instances)} instance(s) prepared")
            else:
                node.status = "done"
                self._event(run, "node_ready", node=node_id, detail="foreach expanded to zero items; nothing to run")

    def _prepare_instances(self, run: SwarmRun, node: _NodeRun) -> "tuple[list[_NodeInstance] | None, str | None]":
        """Bind inputs, expand foreach, and render one prompt per instance.

        Returns ``(instances, None)`` or ``(None, reason)`` on a binding
        failure. Binding failures never retry: a deterministic binding
        error would recur on every re-render, so the node fails and its
        failure_policy applies directly.
        """
        values: dict[str, str] = {}
        foreach = node.spec.get("foreach")
        items: list[Any] | None = None
        for inp in node.spec.get("inputs") or []:
            name, port_type, source = inp["name"], inp["type"], inp["from"]
            src_id, _, src_output = source.partition(".")
            source_node = run.nodes.get(src_id)
            if source_node is None or source_node.status != "done":
                status = source_node.status if source_node is not None else "missing"
                return None, f"input {name!r} from node {src_id!r} is unavailable (status {status!r})"
            answer = self._node_answer(source_node)
            if answer is None:
                return None, f"input {name!r} from node {src_id!r} has no captured answer"
            if port_type == "text":
                values[name] = answer
                continue
            parsed, error = _parse_json_output(answer, src_output)
            if error is not None:
                return None, f"input {name!r}: {error}"
            if foreach is not None and foreach.get("over") == name:
                if not isinstance(parsed, list):
                    return None, f"foreach.over input {name!r} is not a JSON list"
                items = parsed
                continue
            values[name] = json.dumps(parsed)
        if foreach is None:
            return [_NodeInstance(index=-1, prompt=_render_prompt(node.prompt_template, values))], None
        if items is None:
            return None, "foreach node did not resolve its over input"
        instances = [
            _NodeInstance(
                index=index,
                prompt=_render_prompt(
                    node.prompt_template,
                    {**values, foreach["over"]: item if isinstance(item, str) else json.dumps(item)},
                ),
            )
            for index, item in enumerate(items[: foreach["max"]])
        ]
        return instances, None

    def _next_pending_instance(self, run: SwarmRun) -> "tuple[_NodeRun, _NodeInstance] | None":
        for node_id in run.order:
            for instance in run.nodes[node_id].instances:
                if instance.status == "pending":
                    return run.nodes[node_id], instance
        return None

    async def _admit(
        self, run: SwarmRun, node: _NodeRun, instance: _NodeInstance, *, allow_backoff: bool
    ) -> str:
        """Spawn one instance. Returns "admitted", "deferred", or "failed".

        Rate-limited admissions back off and retry: doubling delays capped
        at 60s, at most ``BACKOFF_MAX_ATTEMPTS`` admissions per call, then
        the node fails through its failure_policy. In the admission phase
        (``allow_backoff=False``) a rate limit does not sleep inside
        ``run()``: the instance stays pending ("deferred") and the control
        loop retries it with backoff. Any other admission error fails the
        node immediately.
        """
        from . import spawn

        instance.attempt += 1
        child_name = _child_name(run.run_id, node.node_id, instance.index, instance.attempt)
        tries = BACKOFF_MAX_ATTEMPTS if allow_backoff else 1
        delay = BACKOFF_BASE_SECONDS
        last_error = "spawn admission failed"
        for try_index in range(tries):
            try:
                handle = await spawn(instance.prompt, name=child_name, model=node.model, thinking=node.thinking)
            except RuntimeError as exc:
                last_error = str(exc)
                if not _is_rate_limit_error(last_error):
                    break
                if try_index < tries - 1:
                    self._event(
                        run,
                        "spawn_backoff",
                        node=node.node_id,
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
                node=node.node_id,
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
                node=node.node_id,
                instance=instance.index,
                detail=f"rate limited at admission: {last_error}",
            )
            return "deferred"
        await self._apply_instance_failure(run, node, instance, f"spawn admission failed: {last_error}", retry=False)
        return "failed"

    # -- settlement, retries, policies ---------------------------------------

    async def _apply_settlement(self, run: SwarmRun, node: _NodeRun, instance: _NodeInstance, result: Any) -> None:
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
            # attempts remain; then the node failure_policy applies.
            await self._apply_instance_failure(run, node, instance, child_reason, retry=True)
            return
        budget_ms = node.spec.get("budget_ms")
        if budget_ms is not None and instance.spawned_at is not None:
            elapsed_ms = (self._now_fn() - instance.spawned_at) * 1000
            if elapsed_ms > budget_ms:
                # Wall-clock budget (admission to settlement) exceeded: the
                # budget is spent, so no retry; the failure_policy applies.
                await self._apply_instance_failure(
                    run,
                    node,
                    instance,
                    f"node budget_ms {budget_ms} exceeded ({int(elapsed_ms)}ms from admission to settlement)",
                    retry=False,
                )
                return
        instance.status = "done"
        instance.answer = (result.answer_preview or "")[:ANSWER_CAPTURE_CAP] or None
        self._event(
            run,
            "settled",
            node=node.node_id,
            instance=instance.index,
            status="done",
            duration_ms=instance.duration_ms,
        )
        if instance.answer:
            self._event(
                run,
                "answer_captured",
                node=node.node_id,
                instance=instance.index,
                answer=instance.answer,
                stage="arrived",
            )
        if node.status == "running" and node.instances and all(i.status == "done" for i in node.instances):
            node.status = "done"

    async def _apply_instance_failure(
        self, run: SwarmRun, node: _NodeRun, instance: _NodeInstance, reason: str, *, retry: bool
    ) -> None:
        instance.status = "error"
        instance.error = reason
        self._event(
            run,
            "settled",
            node=node.node_id,
            instance=instance.index,
            status="error",
            error=reason,
            duration_ms=instance.duration_ms,
        )
        retries = node.spec.get("retries", NODE_RETRIES_DEFAULT)
        if retry and instance.attempt <= retries:
            instance.status = "pending"
            instance.error = None
            self._event(
                run,
                "retry",
                node=node.node_id,
                instance=instance.index,
                detail=f"attempt {instance.attempt} failed; re-spawning (retries {retries})",
            )
            return
        # The instance failed permanently, so the node fails NOW. A foreach
        # node does not wait for its remaining instances: without this, a
        # failure that settles before its siblings leaves the node stuck in
        # running with every instance terminal, and fail_fast could never
        # cancel in-flight siblings. The policy guard makes the second and
        # later permanent failures no-ops.
        await self._apply_node_failure_policy(run, node, reason)

    async def _apply_node_failure_policy(self, run: SwarmRun, node: _NodeRun, reason: str) -> None:
        if node.status in ("error", "done", "cancelled"):
            return  # the policy already ran for this node
        policy = node.spec.get("failure_policy", RUN_FAILURE_POLICY_DEFAULT)
        node.status = "error"
        node.error = reason
        self._event(run, "node_error", node=node.node_id, error=reason, detail=f"failure_policy {policy}")
        if run.state != "running":
            # stop() (or another transition) owns the run state now; keep the
            # node's error but do not overwrite the final state.
            return
        if policy == "fail_fast":
            await self._halt_nonterminal(run, "run failed (fail_fast)")
            if run.state != "running":
                return  # stop() landed during the cancellations; it wins
            cancelled_children = sum(
                1 for other in run.nodes.values() for i in other.instances if i.status == "cancelled"
            )
            run.state = "failed"
            await self._milestone(
                run,
                "failed",
                f"node {node.node_id} failed: {reason}; cancelled {cancelled_children} in-flight child(ren)",
                node=node.node_id,
            )
        elif policy == "continue":
            pass  # the node stays error; dependents see a terminal dep and fail at binding
        else:  # escalate (default)
            run.state = "paused"
            run.pause_reason = reason
            await self._milestone(
                run,
                "paused",
                f"node {node.node_id} failed: {reason}; resume with await rlm.swarm.resume('{run.run_id}')",
                node=node.node_id,
            )

    async def _halt_nonterminal(self, run: SwarmRun, reason: str) -> list[str]:
        """Delete every running child and cancel every non-terminal node."""
        stopped = [node_id for node_id in run.order if run.nodes[node_id].status in ("pending", "running")]
        await self._cancel_running(run)
        for node_id in stopped:
            node = run.nodes[node_id]
            if node.status in ("pending", "running"):
                node.status = "cancelled"
                self._event(run, "node_cancelled", node=node_id, detail=reason)
        return stopped

    async def _cancel_running(self, run: SwarmRun) -> None:
        from . import delete_subagent

        for node_id in run.order:
            node = run.nodes[node_id]
            for instance in node.instances:
                if instance.status != "running" or instance.child_id is None:
                    continue
                child_id = instance.child_id
                try:
                    await delete_subagent(child_id)
                except Exception as exc:
                    self._event(run, "cancel_failed", node=node_id, instance=instance.index, child=child_id, error=str(exc))
                else:
                    self._event(run, "cancelled", node=node_id, instance=instance.index, child=child_id)
                # The child is supervisor-owned; a failed delete leaves it
                # running there, but the executor treats its slot as released.
                instance.status = "cancelled"

    # -- completion ----------------------------------------------------------

    def _run_complete(self, run: SwarmRun) -> bool:
        for node in run.nodes.values():
            if node.lifecycle == "resident":
                # A resident node finishes the run's declarative work once it
                # is admitted (or terminally failed); it then stays alive under
                # the parent session until rlm.swarm.stop() or session teardown.
                if node.status == "pending":
                    return False
                if any(instance.status == "pending" for instance in node.instances):
                    return False
                continue
            if node.status not in TERMINAL_NODE_STATUSES:
                return False
        return True

    async def _finalize(self, run: SwarmRun) -> None:
        if run.state != "running":
            return  # stop() or a failure policy owns the final state
        errors = [node for node in run.nodes.values() if node.status == "error"]
        if errors:
            run.state = "failed"
            await self._milestone(
                run,
                "failed",
                "completed with node error(s): " + ", ".join(node.node_id for node in errors),
            )
            return
        run.state = "done"
        residents = [node for node in run.nodes.values() if node.lifecycle == "resident" and node.status == "running"]
        detail = f"run complete: {len(run.nodes)} node(s)"
        if residents:
            detail += f"; {len(residents)} resident node(s) still running (stop with await rlm.swarm.stop('{run.run_id}'))"
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
                (run.nodes[node_id], instance)
                for node_id in run.order
                for instance in run.nodes[node_id].instances
                if instance.status == "running" and instance.child_id is not None
            ]
            if in_flight:
                results = await collect([instance.child_id for _, instance in in_flight], timeout_ms=POLL_TIMEOUT_MS)
                settled = {entry.rlm_child_id: entry for entry in results if entry.settled}
                for node, instance in in_flight:
                    entry = settled.get(instance.child_id or "")
                    if entry is not None:
                        await self._apply_settlement(run, node, instance, entry)
            # Re-check state before completion: stop() (or a policy transition)
            # can land while the collect above was in flight, and a run that
            # was stopped must never finalize as done.
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
            if not in_flight and not started and not self._has_pending_instance(run):
                # Defensive: nothing in flight, nothing admitted, nothing
                # pending. A validated DAG cannot reach this state; end the
                # run instead of spinning.
                self._event(run, "executor_error", error="control loop stalled: no in-flight or pending instances")
                run.state = "failed"
                try:
                    await self._milestone(run, "failed", "control loop stalled")
                except Exception:
                    pass
                return
            # Yield once per iteration. A real collect already waits up to
            # POLL_TIMEOUT_MS, but an instantly-settling host (tests, a fast
            # supervisor) must not hot-spin the loop and starve other tasks.
            await asyncio.sleep(0)

    # -- small helpers --------------------------------------------------------

    def _node_answer(self, node: _NodeRun) -> str | None:
        """Captured answer for binding: one preview, or all instances joined."""
        answers = [instance.answer for instance in node.instances if instance.status == "done" and instance.answer]
        if not answers:
            return None
        return "\n\n".join(answers)

    def _running_instance_count(self, run: SwarmRun) -> int:
        return sum(1 for node in run.nodes.values() for instance in node.instances if instance.status == "running")

    def _has_pending_instance(self, run: SwarmRun) -> bool:
        return any(instance.status == "pending" for node in run.nodes.values() for instance in node.instances)

    def _pending_node_ids(self, run: SwarmRun) -> list[str]:
        return [node_id for node_id in run.order if run.nodes[node_id].status == "pending"]


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
    """Return node states, the event window, elapsed time, and usage."""
    return await default_swarm_executor().status(run_id)


async def stop_swarm(run_id: str) -> dict[str, Any]:
    """Cancel every running child of the run and mark it stopped."""
    return await default_swarm_executor().stop(run_id)


async def resume_swarm(run_id: str) -> dict[str, Any]:
    """Resume a paused run (escalate or budget pause)."""
    return await default_swarm_executor().resume(run_id)
