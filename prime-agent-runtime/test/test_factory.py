"""Factory harness entry kind: spec validation, dag compilation, and executor.

Consolidated port of TS-era PRs #2397 (factory entry kind, validator, dag
compiler) and #2401 (the executor: run/status/stop/resume, guarded
transitions, re-entry, failure policies, budgets, rate-limit backoff, stop
races) plus the accepted review findings from both:

- a fan-in dag node's full dependency set compiles to ONE join transition
  (never per-edge transitions that would let the node start after a single
  parent settles);
- a node reading its own output is rejected like depends_on: [self];
- explicit JSON null on typed fields (run.max_parallel, state.retries,
  state.max_entries, ...) is rejected with the field's own message instead
  of surviving canonicalization as None;
- port validation is linear in the port count (seen-sets and one
  output-type map per source), so thousands of ports stay write-time cheap;
- quiescence counts the INSTANCE layer: a failed foreach entry's still
  running siblings are collected before the run ends, and a resident
  entry's queued instances are admitted before completion is reported;
  admitted resident instances alone never block completion;
- queued siblings of a terminal (failed/cancelled) entry are never
  admitted (_next_pending_instance serves running entries only);
- the run budget is enforced before each admission, including run()'s and
  resume()'s admission phase;
- rate-limit backoff never blocks the sole control lane: admission defers
  to a deadline and the loop waits it out in bounded slices while children
  keep being collected;
- concurrent stop() calls run one cancellation pass (the transitional
  "stopping" state is guarded too);
- resume() bumps the control-loop generation so the pause-path loop can
  never continue as a second concurrent control loop;
- long state ids disambiguate their spawn names with a digest, so two
  states sharing a 20-character prefix never collide on the supervisor's
  unique sibling-name requirement;
- a configured inline subagent name labels the spawned children
  run-scoped: the spawn label prefixes the configured name with the run
  id (the supervisor's sibling names are per-parent-session and a parent
  outlives its runs, so a verbatim name would collide with a prior run's
  children), with the generated label's -i<n>/-a<n> suffixes on
  re-entry, foreach fan-out, and retries; over-length names and names
  duplicated across states are rejected at write time (Macroscope review
  finding: the name was dropped, so children always got the generated
  label);
- milestone notices go to the host as validated "factory.progress"
  payloads exactly once per kind per run, and a dead bridge leaves the
  milestone in the ledger instead of wedging the run.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest.mock import patch

import rlm as rlm_module
from rlm import factory as factory_module
from rlm.factory import (
    ANSWER_BINDING_CAP,
    ANSWER_CAPTURE_CAP,
    BACKOFF_MAX_ATTEMPTS,
    EVENT_WINDOW,
    MACHINE_FILE_NAME,
    MACHINE_SPEC_FENCE,
    POLL_TIMEOUT_MS,
    RUN_MAX_CHILDREN_DEFAULT,
    RUN_MAX_PARALLEL_DEFAULT,
    SUBAGENT_NAME_MAX_LENGTH,
    FactoryExecutor,
    MachineFile,
    MachineResolutionError,
    _child_name,
    _guard_passes,
    _parse_json_output,
    _scan_machine_library,
    _spawn_label,
    canonicalize_factory_spec,
    cli_dispatch,
    compile_factory_dag,
    export_factory_spec,
    export_library_machine,
    export_machine,
    import_machine,
    list_machines,
    machine_description_errors,
    machine_name_errors,
    parse_machine_file,
    render_machine_file,
    repo_machines_dir,
    resolve_machine,
    topological_order,
    user_machines_dir,
    validate_factory_machine,
    validate_factory_spec,
)
from rlm.harness import HarnessState


# ---------------------------------------------------------------------------
# Spec fixtures
# ---------------------------------------------------------------------------

#: The host's roster-preview cap (the daemon's ANSWER_PREVIEW_MAX_CHARS):
#: the fake host mirrors it so the binding lane's full text is what
#: distinguishes a binding that survives truncation from one that does not.
HOST_ANSWER_PREVIEW_CHARS = 160


def state(state_id: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"id": state_id, "subagent": "worker"}
    base.update(overrides)
    return base


def valid_machine() -> dict[str, Any]:
    """Review-loop machine: collect -> reviewing (max 4 entries) with a
    guarded switch to fixing (max 3 entries) and a self-loop, fixing re-enters
    reviewing."""
    return {
        "run": {"budget_ms": 600_000, "failure_policy": "continue", "max_parallel": 4, "max_transitions": 40},
        "states": [
            {
                "id": "collect",
                "entry": True,
                "subagent": "researcher",
                "outputs": [{"name": "findings", "type": "text"}],
            },
            {
                "id": "reviewing",
                "subagent": {"prompt": "Review the draft."},
                "inputs": [{"name": "draft", "type": "text", "from": "collect.findings"}],
                "outputs": [{"name": "verdict", "type": "json"}],
                "max_entries": 4,
                "retries": 1,
            },
            {"id": "fixing", "subagent": {"prompt": "Fix the findings."}, "max_entries": 3},
        ],
        "transitions": [
            {"from": "collect", "to": "reviewing"},
            {
                "from": "reviewing",
                "to": "fixing",
                "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False},
            },
            {"from": "reviewing", "to": "reviewing", "when": {"output": "verdict", "op": "exists"}},
            {"from": "fixing", "to": "reviewing"},
        ],
    }


def node(node_id: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"id": node_id, "subagent": "worker"}
    base.update(overrides)
    return base


def valid_dag() -> dict[str, Any]:
    return {
        "run": {"budget_ms": 600_000, "failure_policy": "continue", "max_parallel": 4},
        "nodes": [
            {
                "id": "collect",
                "subagent": "researcher",
                "outputs": [{"name": "findings", "type": "text"}],
            },
            {
                "id": "fan-out",
                "subagent": {"prompt": "Expand each item.", "name": "expander", "model": "m1", "thinking": "low"},
                "depends_on": ["collect"],
                "inputs": [{"name": "items", "type": "text", "from": "collect.findings"}],
            },
            {
                "id": "review",
                "subagent": {"prompt": "Review the fan-out."},
                "depends_on": ["collect", "fan-out"],
                "inputs": [{"name": "draft", "type": "text", "from": "collect.findings"}],
                "retries": 2,
                "budget_ms": 100_000,
                "failure_policy": "fail_fast",
            },
        ],
    }


# ---------------------------------------------------------------------------
# Dag-form validation (write-time dry run)
# ---------------------------------------------------------------------------


class ValidateFactorySpecTest(unittest.TestCase):
    def test_valid_spec_has_no_errors(self) -> None:
        self.assertEqual(validate_factory_spec(valid_dag()), [])

    def test_dag_must_be_an_object(self) -> None:
        for bad in (None, [], "nodes", 42):
            errors = validate_factory_spec(bad)
            self.assertEqual(len(errors), 1)
            self.assertIn("factory dag must be a JSON object", errors[0])

    def test_nodes_required_and_must_be_a_list(self) -> None:
        self.assertEqual(
            validate_factory_spec({"nodes": "nope"}),
            ["factory dag requires a nodes list"],
        )
        self.assertEqual(
            validate_factory_spec({"run": "bad", "nodes": "nope"}),
            ["run must be an object", "factory dag requires a nodes list"],
        )

    def test_node_cap(self) -> None:
        at_cap = {"nodes": [node(f"n{i}") for i in range(1024)]}
        self.assertEqual(validate_factory_spec(at_cap), [])
        over_cap = {"nodes": [node(f"n{i}") for i in range(1025)]}
        errors = validate_factory_spec(over_cap)
        self.assertEqual(len(errors), 1)
        self.assertIn("between 1 and 1024 nodes", errors[0])

    def test_node_ids(self) -> None:
        for good in ("a", "node-1", "1st-node", "a" * 64):
            self.assertEqual(validate_factory_spec({"nodes": [node(good)]}), [], good)
        for bad in ("-abc", "ABC", "a_b", "a.b", "a" * 65):
            errors = validate_factory_spec({"nodes": [{"id": bad, "subagent": "w"}]})
            self.assertEqual(len(errors), 1, bad)
            self.assertIn("id must match", errors[0])
        for bad in ("", None, 5):
            errors = validate_factory_spec({"nodes": [{"id": bad, "subagent": "w"}]})
            self.assertEqual(errors, ["nodes[0] requires a non-empty id"], repr(bad))

    def test_duplicate_node_ids(self) -> None:
        errors = validate_factory_spec({"nodes": [node("dup"), node("dup")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("duplicates node id 'dup'", errors[0])

    def test_subagent_forms(self) -> None:
        by_ref = {"nodes": [node("a", subagent="reviewer")]}
        self.assertEqual(validate_factory_spec(by_ref), [])
        inline = {"nodes": [node("a", subagent={"prompt": "Do work."})]}
        self.assertEqual(validate_factory_spec(inline), [])
        inline_full = {
            "nodes": [
                node("a", subagent={"prompt": "Do work.", "name": "w", "model": "m", "thinking": "high"})
            ]
        }
        self.assertEqual(validate_factory_spec(inline_full), [])

        missing = {"nodes": [{"id": "a"}]}
        errors = validate_factory_spec(missing)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])

        empty_ref = {"nodes": [node("a", subagent="")]}
        errors = validate_factory_spec(empty_ref)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])

        empty_prompt = {"nodes": [node("a", subagent={"prompt": ""})]}
        errors = validate_factory_spec(empty_prompt)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a non-empty prompt", errors[0])

        bad_name = {"nodes": [node("a", subagent={"prompt": "p", "model": 5})]}
        errors = validate_factory_spec(bad_name)
        self.assertEqual(len(errors), 1)
        self.assertIn("model must be a non-empty string", errors[0])

        bad_thinking = {"nodes": [node("a", subagent={"prompt": "p", "thinking": ""})]}
        errors = validate_factory_spec(bad_thinking)
        self.assertEqual(len(errors), 1)
        self.assertIn("thinking must be a non-empty string", errors[0])

        # Whitespace-only values are rejected at write time: runtime
        # resolution strips them (_resolve_subagents /
        # _validate_spawn_settings), so a whitespace-only field is a
        # persistable factory that can never spawn.
        whitespace_prompt = {"nodes": [node("a", subagent={"prompt": "  \t "})]}
        errors = validate_factory_spec(whitespace_prompt)
        self.assertEqual(errors, ["node a inline subagent requires a non-empty prompt"])
        for key in ("name", "model", "thinking"):
            whitespace_field = {"nodes": [node("a", subagent={"prompt": "p", key: "  \t "})]}
            errors = validate_factory_spec(whitespace_field)
            self.assertEqual(
                errors, [f"node a inline subagent {key} must be a non-empty string when provided"], key
            )

        # The dag form compiles to machine form first, so the name rules
        # (length, cross-state uniqueness) apply to nodes too.
        dag_duplicate = {
            "nodes": [
                node("a", subagent={"prompt": "p", "name": "w"}),
                node("b", subagent={"prompt": "p", "name": "w"}, depends_on=["a"]),
            ]
        }
        errors = validate_factory_spec(dag_duplicate)
        self.assertEqual(errors, ["state b subagent name 'w' is already configured by state 'a'"])

    def test_lifecycle(self) -> None:
        for good in ("task", "resident"):
            self.assertEqual(validate_factory_spec({"nodes": [node("a", lifecycle=good)]}), [])
        errors = validate_factory_spec({"nodes": [node("a", lifecycle="daemon")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("lifecycle must be 'task' or 'resident'", errors[0])

    def test_run_budget_and_node_budget(self) -> None:
        ok = {
            "run": {"budget_ms": 1000},
            "nodes": [node("a", budget_ms=1000)],
        }
        self.assertEqual(validate_factory_spec(ok), [])

        over = {
            "run": {"budget_ms": 1000},
            "nodes": [node("a", budget_ms=1001)],
        }
        errors = validate_factory_spec(over)
        self.assertEqual(len(errors), 1)
        self.assertIn("exceeds the run budget_ms", errors[0])

        for bad in (0, -5, 1.5, "10", True):
            errors = validate_factory_spec({"run": {"budget_ms": bad}, "nodes": [node("a")]})
            self.assertEqual(errors, ["run budget_ms must be a positive integer"], bad)
            errors = validate_factory_spec({"nodes": [node("a", budget_ms=bad)]})
            self.assertEqual(errors, ["node a budget_ms must be a positive integer"], bad)

        # No run budget set: any positive node budget is fine.
        self.assertEqual(validate_factory_spec({"nodes": [node("a", budget_ms=999_999)]}), [])

    def test_run_budget_invalid(self) -> None:
        errors = validate_factory_spec({"run": "bad", "nodes": [node("a")]})
        self.assertEqual(errors, ["run must be an object"])

    def test_run_failure_policy(self) -> None:
        for good in ("fail_fast", "continue", "escalate"):
            self.assertEqual(validate_factory_spec({"run": {"failure_policy": good}, "nodes": [node("a")]}), [])
        errors = validate_factory_spec({"run": {"failure_policy": "stop"}, "nodes": [node("a")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("run failure_policy must be one of", errors[0])

    def test_run_max_parallel(self) -> None:
        for good in (1, 8, 64):
            self.assertEqual(validate_factory_spec({"run": {"max_parallel": good}, "nodes": [node("a")]}), [])
        for bad in (0, 65, -1, 1.5, "8", True):
            errors = validate_factory_spec({"run": {"max_parallel": bad}, "nodes": [node("a")]})
            self.assertEqual(errors, ["run max_parallel must be an integer between 1 and 64"], bad)

    def test_run_max_transitions(self) -> None:
        for good in (1, 40, 10_000):
            self.assertEqual(validate_factory_spec({"run": {"max_transitions": good}, "nodes": [node("a")]}), [])
        for bad in (0, -1, 10_001, 1.5, "5", True):
            errors = validate_factory_spec({"run": {"max_transitions": bad}, "nodes": [node("a")]})
            self.assertEqual(errors, ["run max_transitions must be a positive integer no greater than 10000"], bad)

    def test_run_max_children(self) -> None:
        # The run-wide child budget: total admissions over the run's life.
        for good in (1, 40, 1_000_000):
            self.assertEqual(validate_factory_spec({"run": {"max_children": good}, "nodes": [node("a")]}), [])
        for bad in (0, -1, 1_000_001, 1.5, "5", True):
            errors = validate_factory_spec({"run": {"max_children": bad}, "nodes": [node("a")]})
            self.assertEqual(errors, ["run max_children must be a positive integer no greater than 1000000"], bad)

    def test_node_failure_policy(self) -> None:
        for good in ("fail_fast", "continue", "escalate"):
            self.assertEqual(validate_factory_spec({"nodes": [node("a", failure_policy=good)]}), [])
        errors = validate_factory_spec({"nodes": [node("a", failure_policy="retry")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("node a failure_policy must be one of", errors[0])

    def test_retries(self) -> None:
        for good in (0, 5, 10):
            self.assertEqual(validate_factory_spec({"nodes": [node("a", retries=good)]}), [])
        for bad in (-1, 11, 1.5, "2", True):
            errors = validate_factory_spec({"nodes": [node("a", retries=bad)]})
            self.assertEqual(errors, ["node a retries must be an integer between 0 and 10"], bad)

    def test_depends_on(self) -> None:
        ok = {"nodes": [node("a"), node("b", depends_on=["a"])]}
        self.assertEqual(validate_factory_spec(ok), [])

        self_dep = {"nodes": [node("a", depends_on=["a"])]}
        errors = validate_factory_spec(self_dep)
        self.assertEqual(errors, ["node a cannot depend on itself"])

        unknown = {"nodes": [node("a", depends_on=["ghost"])]}
        errors = validate_factory_spec(unknown)
        self.assertEqual(errors, ["node a depends on unknown node 'ghost'"])

        not_list = {"nodes": [node("a", depends_on="b")]}
        errors = validate_factory_spec(not_list)
        self.assertEqual(errors, ["node a depends_on must be a list of node ids"])

        bad_entry = {"nodes": [node("a", depends_on=[5])]}
        errors = validate_factory_spec(bad_entry)
        self.assertEqual(errors, ["node a depends_on entries must be non-empty node id strings"])

    def test_self_input_edge_is_rejected_like_a_self_dependency(self) -> None:
        # Review finding: a node reading its own output would compile to a
        # never-reachable self-loop state, so the self-dependency rule covers
        # the EFFECTIVE edge set (depends_on union inputs[].from), not only
        # depends_on.
        self_output = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", inputs=[{"name": "i", "type": "text", "from": "b.o"}]),
            ]
        }
        errors = validate_factory_spec(self_output)
        self.assertIn("node b cannot depend on itself", errors)
        machine, compile_errors = compile_factory_dag(self_output)
        self.assertIsNone(machine)
        self.assertIn("node b cannot depend on itself", compile_errors)

        # A cross-node input edge is of course fine.
        ok = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", inputs=[{"name": "i", "type": "text", "from": "a.o"}]),
            ]
        }
        self.assertEqual(validate_factory_spec(ok), [])

    def test_explicit_null_typed_fields_are_rejected_not_defaulted(self) -> None:
        # Review finding: explicit JSON null on a typed field used to survive
        # canonicalization as None and reach the executor without a usable
        # limit. Presence-based checks reject null with the field's own
        # message instead of treating it as an omitted default.
        self.assertEqual(
            validate_factory_spec({"run": {"max_parallel": None}, "nodes": [node("a")]}),
            ["run max_parallel must be an integer between 1 and 64"],
        )
        self.assertEqual(
            validate_factory_spec({"run": {"max_transitions": None}, "nodes": [node("a")]}),
            ["run max_transitions must be a positive integer no greater than 10000"],
        )
        self.assertEqual(
            validate_factory_spec({"run": {"max_children": None}, "nodes": [node("a")]}),
            ["run max_children must be a positive integer no greater than 1000000"],
        )
        self.assertEqual(
            validate_factory_spec({"run": {"budget_ms": None}, "nodes": [node("a")]}),
            ["run budget_ms must be a positive integer"],
        )
        self.assertEqual(
            validate_factory_spec({"run": {"failure_policy": None}, "nodes": [node("a")]}),
            ["run failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got None"],
        )
        self.assertEqual(
            validate_factory_spec({"nodes": [node("a", retries=None)]}),
            ["node a retries must be an integer between 0 and 10"],
        )
        self.assertEqual(
            validate_factory_spec({"nodes": [node("a", budget_ms=None)]}),
            ["node a budget_ms must be a positive integer"],
        )
        self.assertEqual(
            validate_factory_spec({"nodes": [node("a", failure_policy=None)]}),
            ["node a failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got None"],
        )
        self.assertEqual(
            validate_factory_spec({"nodes": [node("a", lifecycle=None)]}),
            ["node a lifecycle must be 'task' or 'resident', got None"],
        )
        machine_nulls = {
            "states": [
                {
                    "id": "a",
                    "entry": True,
                    "subagent": "w",
                    "max_entries": None,
                    "retries": None,
                }
            ],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(machine_nulls),
            [
                "state a retries must be an integer between 0 and 10",
                "state a max_entries must be an integer >= 1",
            ],
        )
        self.assertEqual(
            validate_factory_machine({"states": [{"id": "a", "entry": None, "subagent": "w"}], "transitions": []}),
            [
                "state a entry must be a boolean",
                "factory machine requires at least one entry state",
            ],
        )

    def test_data_edges(self) -> None:
        ok = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "text"}]),
                node("b", inputs=[{"name": "in", "type": "text", "from": "a.out"}]),
            ]
        }
        self.assertEqual(validate_factory_spec(ok), [])

        # A data edge implies ordering even without depends_on.
        no_declared_dep = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "json"}]),
                node("b", inputs=[{"name": "in", "type": "json", "from": "a.out"}]),
            ]
        }
        self.assertEqual(validate_factory_spec(no_declared_dep), [])

        unknown_source = {
            "nodes": [node("b", inputs=[{"name": "in", "type": "text", "from": "ghost.out"}])]
        }
        errors = validate_factory_spec(unknown_source)
        self.assertEqual(len(errors), 1)
        self.assertIn("references unknown node 'ghost'", errors[0])

        undeclared_output = {
            "nodes": [
                node("a"),
                node("b", inputs=[{"name": "in", "type": "text", "from": "a.missing"}]),
            ]
        }
        errors = validate_factory_spec(undeclared_output)
        self.assertEqual(len(errors), 1)
        self.assertIn("does not declare", errors[0])

        type_mismatch = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "text"}]),
                node("b", inputs=[{"name": "in", "type": "json", "from": "a.out"}]),
            ]
        }
        errors = validate_factory_spec(type_mismatch)
        self.assertEqual(len(errors), 1)
        self.assertIn("cannot read from output", errors[0])
        self.assertIn("of type 'text'", errors[0])

        malformed_from = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "text"}]),
                node("b", inputs=[{"name": "in", "type": "text", "from": "no-dot"}]),
            ]
        }
        errors = validate_factory_spec(malformed_from)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a 'from' reference", errors[0])

    def test_input_output_ports(self) -> None:
        ok = {
            "nodes": [
                node(
                    "a",
                    outputs=[{"name": "o1", "type": "text"}, {"name": "o2", "type": "json"}],
                )
            ]
        }
        self.assertEqual(validate_factory_spec(ok), [])

        bad_output_type = {"nodes": [node("a", outputs=[{"name": "o", "type": "yaml"}])]}
        errors = validate_factory_spec(bad_output_type)
        self.assertEqual(len(errors), 1)
        self.assertIn("output 'o' type must be 'text' or 'json'", errors[0])

        dup_output = {
            "nodes": [node("a", outputs=[{"name": "o", "type": "text"}, {"name": "o", "type": "json"}])]
        }
        errors = validate_factory_spec(dup_output)
        self.assertEqual(errors, ["node a declares duplicate output name 'o'"])

        bad_input_type = {
            "nodes": [
                node("b", outputs=[{"name": "o", "type": "text"}]),
                node("a", inputs=[{"name": "i", "type": "yaml", "from": "b.o"}]),
            ]
        }
        errors = validate_factory_spec(bad_input_type)
        self.assertEqual(errors, ["node a input 'i' type must be 'text' or 'json'"])

        dup_input = {
            "nodes": [
                node(
                    "a",
                    inputs=[
                        {"name": "i", "type": "text", "from": "b.o1"},
                        {"name": "i", "type": "text", "from": "b.o2"},
                    ],
                ),
                node("b", outputs=[{"name": "o1", "type": "text"}, {"name": "o2", "type": "text"}]),
            ]
        }
        errors = validate_factory_spec(dup_input)
        self.assertEqual(errors, ["node a declares duplicate input name 'i'"])

        missing_name = {"nodes": [node("a", outputs=[{"type": "text"}])]}
        errors = validate_factory_spec(missing_name)
        self.assertEqual(errors, ["node a outputs[0] requires a non-empty name"])

        not_a_list = {"nodes": [node("a", outputs="nope")]}
        errors = validate_factory_spec(not_a_list)
        self.assertEqual(errors, ["node a outputs must be a list"])
        not_a_list = {"nodes": [node("a", inputs="nope")]}
        errors = validate_factory_spec(not_a_list)
        self.assertEqual(errors, ["node a inputs must be a list"])

    def test_resident_rules(self) -> None:
        resident_ok = {"nodes": [node("watcher", lifecycle="resident")]}
        self.assertEqual(validate_factory_spec(resident_ok), [])

        depended_on = {
            "nodes": [node("watcher", lifecycle="resident"), node("task", depends_on=["watcher"])]
        }
        errors = validate_factory_spec(depended_on)
        self.assertEqual(errors, ["node task cannot depend on resident node 'watcher'"])

        read_from = {
            "nodes": [
                node("watcher", lifecycle="resident"),
                node("task", inputs=[{"name": "i", "type": "text", "from": "watcher.o"}]),
            ]
        }
        errors = validate_factory_spec(read_from)
        self.assertEqual(errors, ["node task input 'i' cannot read from resident node 'watcher'"])

        declares_outputs = {"nodes": [node("watcher", lifecycle="resident", outputs=[{"name": "o", "type": "text"}])]}
        errors = validate_factory_spec(declares_outputs)
        self.assertEqual(errors, ["resident node watcher cannot declare outputs"])

        uses_foreach = {
            "nodes": [
                node("src", outputs=[{"name": "items", "type": "json"}]),
                node(
                    "watcher",
                    lifecycle="resident",
                    inputs=[{"name": "items", "type": "json", "from": "src.items"}],
                    foreach={"over": "items", "max": 4},
                ),
            ]
        }
        errors = validate_factory_spec(uses_foreach)
        self.assertEqual(errors, ["resident node watcher cannot use foreach"])

        # Empty outputs list on a resident node is fine: nothing is declared.
        empty_outputs = {"nodes": [node("watcher", lifecycle="resident", outputs=[])]}
        self.assertEqual(validate_factory_spec(empty_outputs), [])

    def test_foreach(self) -> None:
        ok = {
            "nodes": [
                node("a", outputs=[{"name": "items", "type": "json"}]),
                node(
                    "b",
                    inputs=[{"name": "items", "type": "json", "from": "a.items"}],
                    foreach={"over": "items", "max": 16},
                ),
            ]
        }
        self.assertEqual(validate_factory_spec(ok), [])

        for good_max in (1, 256):
            ok_max = {
                "nodes": [
                    node("a", outputs=[{"name": "items", "type": "json"}]),
                    node(
                        "b",
                        inputs=[{"name": "items", "type": "json", "from": "a.items"}],
                        foreach={"over": "items", "max": good_max},
                    ),
                ]
            }
            self.assertEqual(validate_factory_spec(ok_max), [])

        for bad_max in (0, 257, -1, 1.5, "8", True):
            bad = {
                "nodes": [
                    node("a", outputs=[{"name": "items", "type": "json"}]),
                    node(
                        "b",
                        inputs=[{"name": "items", "type": "json", "from": "a.items"}],
                        foreach={"over": "items", "max": bad_max},
                    ),
                ]
            }
            errors = validate_factory_spec(bad)
            self.assertEqual(errors, ["node b foreach.max must be an integer between 1 and 256"], bad_max)

        wrong_port = {
            "nodes": [
                node("a", outputs=[{"name": "items", "type": "json"}]),
                node(
                    "b",
                    inputs=[{"name": "items", "type": "json", "from": "a.items"}],
                    foreach={"over": "not-an-input", "max": 4},
                ),
            ]
        }
        errors = validate_factory_spec(wrong_port)
        self.assertEqual(
            errors, ["node b foreach.over must name one of this node's inputs, got 'not-an-input'"]
        )

        text_port = {
            "nodes": [
                node("a", outputs=[{"name": "draft", "type": "text"}]),
                node(
                    "b",
                    inputs=[{"name": "draft", "type": "text", "from": "a.draft"}],
                    foreach={"over": "draft", "max": 4},
                ),
            ]
        }
        errors = validate_factory_spec(text_port)
        self.assertEqual(errors, ["node b foreach.over input 'draft' must have type 'json'"])

        not_object = {"nodes": [node("a", foreach=["bad"])]}
        errors = validate_factory_spec(not_object)
        self.assertEqual(errors, ["node a foreach must be an object"])

    def test_cycles_are_legal_when_an_entry_state_exists(self) -> None:
        # A cycle that does not cover the whole dag compiles to a machine with
        # an entry state; cycles are legal in machine form, so this validates.
        cycle_with_entry = {
            "nodes": [
                node("a"),
                node("b", depends_on=["c"]),
                node("c", depends_on=["b"]),
            ]
        }
        self.assertEqual(validate_factory_spec(cycle_with_entry), [])

        data_cycle_with_entry = {
            "nodes": [
                node("a"),
                node("b", depends_on=["a"], outputs=[{"name": "o", "type": "json"}]),
                node("c", inputs=[{"name": "i", "type": "json", "from": "b.o"}]),
            ]
        }
        self.assertEqual(validate_factory_spec(data_cycle_with_entry), [])

    def test_fully_cyclic_dag_compiles_to_a_machine_without_entry_states(self) -> None:
        depends_cycle = {
            "nodes": [
                node("a", depends_on=["b"]),
                node("b", depends_on=["a"]),
            ]
        }
        self.assertEqual(
            validate_factory_spec(depends_cycle),
            ["factory machine requires at least one entry state"],
        )

        data_cycle = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "json"}], inputs=[
                    {"name": "i", "type": "json", "from": "b.o"}
                ]),
                node("b", outputs=[{"name": "o", "type": "json"}], inputs=[
                    {"name": "i", "type": "json", "from": "a.o"}
                ]),
            ]
        }
        self.assertEqual(
            validate_factory_spec(data_cycle),
            ["factory machine requires at least one entry state"],
        )

        three_cycle = {
            "nodes": [
                node("a", depends_on=["c"]),
                node("b", depends_on=["a"]),
                node("c", depends_on=["b"]),
            ]
        }
        self.assertEqual(
            validate_factory_spec(three_cycle),
            ["factory machine requires at least one entry state"],
        )

    def test_collects_multiple_errors(self) -> None:
        dag = {
            "run": {"max_parallel": 99, "failure_policy": "nope"},
            "nodes": [
                node("a", depends_on=["ghost"]),
                node("b", retries=99),
                node("c", failure_policy="retry"),
            ],
        }
        errors = validate_factory_spec(dag)
        self.assertEqual(
            errors,
            [
                "run failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got 'nope'",
                "run max_parallel must be an integer between 1 and 64",
                "node a depends on unknown node 'ghost'",
                "node b retries must be an integer between 0 and 10",
                "node c failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got 'retry'",
            ],
        )


# ---------------------------------------------------------------------------
# Canonicalization
# ---------------------------------------------------------------------------


class CanonicalizeFactorySpecTest(unittest.TestCase):
    def test_applies_defaults(self) -> None:
        dag = {"nodes": [{"id": "a", "subagent": "worker"}]}
        self.assertEqual(
            canonicalize_factory_spec(dag),
            {
                "run": {
                    "failure_policy": "escalate",
                    "max_parallel": 8,
                    "max_transitions": 10,
                    "max_children": 10_000,
                },
                "states": [
                    {
                        "id": "a",
                        "entry": True,
                        "max_entries": 1,
                        "subagent": "worker",
                        "lifecycle": "task",
                        "retries": 0,
                        "failure_policy": "escalate",
                    }
                ],
                "transitions": [],
            },
        )

    def test_preserves_explicit_values(self) -> None:
        dag = {
            "run": {
                "budget_ms": 5000,
                "failure_policy": "continue",
                "max_parallel": 2,
                "max_transitions": 7,
                "max_children": 5,
            },
            "nodes": [
                {
                    "id": "a",
                    "subagent": {"prompt": "Work."},
                    "lifecycle": "task",
                    "retries": 3,
                    "failure_policy": "fail_fast",
                    "budget_ms": 4000,
                    "depends_on": [],
                    "outputs": [{"name": "o", "type": "text"}],
                }
            ],
        }
        self.assertEqual(
            canonicalize_factory_spec(dag),
            {
                "run": {
                    "failure_policy": "continue",
                    "max_parallel": 2,
                    "max_transitions": 7,
                    "max_children": 5,
                    "budget_ms": 5000,
                },
                "states": [
                    {
                        "id": "a",
                        "entry": True,
                        "max_entries": 1,
                        "subagent": {"prompt": "Work."},
                        "lifecycle": "task",
                        "retries": 3,
                        "failure_policy": "fail_fast",
                        "budget_ms": 4000,
                        "outputs": [{"name": "o", "type": "text"}],
                    }
                ],
                "transitions": [],
            },
        )

    def test_state_failure_policy_defaults_to_run_policy(self) -> None:
        dag = {
            "run": {"failure_policy": "continue"},
            "nodes": [{"id": "a", "subagent": "w"}, {"id": "b", "subagent": "w", "failure_policy": "escalate"}],
        }
        result = canonicalize_factory_spec(dag)
        self.assertEqual(result["states"][0]["failure_policy"], "continue")
        self.assertEqual(result["states"][1]["failure_policy"], "escalate")

    def test_max_transitions_defaults_to_ten_per_state_capped(self) -> None:
        ten_states = {"nodes": [node(f"n{i}") for i in range(10)]}
        self.assertEqual(canonicalize_factory_spec(ten_states)["run"]["max_transitions"], 100)
        many_states = {"nodes": [node(f"n{i}") for i in range(1024)]}
        self.assertEqual(canonicalize_factory_spec(many_states)["run"]["max_transitions"], 10_000)

    def test_deduplicates_depends_on_into_one_transition(self) -> None:
        dag = {
            "nodes": [
                {"id": "a", "subagent": "w"},
                {"id": "b", "subagent": "w", "depends_on": ["a", "a", "a"]},
            ]
        }
        result = canonicalize_factory_spec(dag)
        self.assertEqual(result["transitions"], [{"from": "a", "to": "b", "on": "settled"}])

    def test_machine_form_canonicalization(self) -> None:
        machine = {
            "run": {"failure_policy": "continue", "max_parallel": 2, "budget_ms": 5000},
            "states": [
                {"id": "seed", "entry": True, "subagent": {"prompt": "Seed."}, "outputs": [{"name": "o", "type": "json"}]},
                {
                    "id": "act",
                    "subagent": {"prompt": "Act."},
                    "inputs": [{"name": "data", "type": "json", "from": "seed.o"}],
                    "max_entries": 2,
                },
            ],
            "transitions": [
                {"from": "seed", "to": "act", "when": {"output": "o", "path": "ready", "op": "eq", "value": False}},
            ],
        }
        self.assertEqual(
            canonicalize_factory_spec(machine),
            {
                "run": {
                    "failure_policy": "continue",
                    "max_parallel": 2,
                    "max_transitions": 20,
                    "max_children": 10_000,
                    "budget_ms": 5000,
                },
                "states": [
                    {
                        "id": "seed",
                        "entry": True,
                        "max_entries": 1,
                        "lifecycle": "task",
                        "retries": 0,
                        "failure_policy": "continue",
                        "subagent": {"prompt": "Seed."},
                        "outputs": [{"name": "o", "type": "json"}],
                    },
                    {
                        "id": "act",
                        "entry": False,
                        "max_entries": 2,
                        "subagent": {"prompt": "Act."},
                        "lifecycle": "task",
                        "retries": 0,
                        "failure_policy": "continue",
                        "inputs": [{"name": "data", "type": "json", "from": "seed.o"}],
                    }
                ],
                "transitions": [
                    {
                        "from": "seed",
                        "to": "act",
                        "on": "settled",
                        "when": {"output": "o", "path": "ready", "op": "eq", "value": False},
                    }
                ],
            },
        )

    def test_raises_with_joined_errors_on_invalid_input(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            canonicalize_factory_spec({"nodes": [node("a", depends_on=["ghost"])]})
        message = str(ctx.exception)
        self.assertIn("depends on unknown node", message)

        with self.assertRaises(ValueError) as ctx:
            canonicalize_factory_spec("not a dag")
        self.assertIn("factory dag must be a JSON object", str(ctx.exception))

        with self.assertRaises(ValueError) as ctx:
            canonicalize_factory_spec({"states": [state("a")], "transitions": [{"from": "a", "to": "ghost"}]})
        self.assertIn("references unknown to-state", str(ctx.exception))

    def test_does_not_mutate_input(self) -> None:
        dag = {"nodes": [{"id": "a", "subagent": {"prompt": "p"}, "outputs": [{"name": "o", "type": "json"}]}]}
        snapshot = {"nodes": [dict(dag["nodes"][0])]}
        result = canonicalize_factory_spec(dag)
        result["states"][0]["subagent"]["prompt"] = "mutated"
        result["states"][0]["outputs"][0]["type"] = "text"
        self.assertEqual(dag["nodes"][0]["subagent"]["prompt"], "p")
        self.assertEqual(dag["nodes"][0]["outputs"][0]["type"], "json")
        self.assertEqual(snapshot["nodes"][0]["id"], "a")

        machine = {
            "states": [
                state("a", entry=True, outputs=[{"name": "o", "type": "json"}]),
                state("b", inputs=[{"name": "i", "type": "json", "from": "a.o"}]),
            ],
            "transitions": [{"from": "a", "to": "b", "when": {"output": "o", "op": "exists"}}],
        }
        result = canonicalize_factory_spec(machine)
        result["states"][0]["outputs"][0]["type"] = "mutated"
        result["transitions"][0]["when"]["output"] = "mutated"
        self.assertEqual(machine["states"][0]["outputs"][0]["type"], "json")
        self.assertEqual(machine["transitions"][0]["when"]["output"], "o")


# ---------------------------------------------------------------------------
# Machine-form validation
# ---------------------------------------------------------------------------


class ValidateFactoryMachineTest(unittest.TestCase):
    """Every machine-form validator rule, valid and invalid."""

    def test_valid_machine_has_no_errors(self) -> None:
        # Includes an entry state, a guard switch, a self-loop, re-entry
        # bounds, and a reviewing<->fixing cycle: all legal in machine form.
        self.assertEqual(validate_factory_spec(valid_machine()), [])
        self.assertEqual(validate_factory_machine(valid_machine()), [])

    def test_machine_must_be_an_object(self) -> None:
        for bad in (None, [], "states", 42):
            self.assertEqual(validate_factory_machine(bad), ["factory machine must be a JSON object"], repr(bad))

    def test_states_required_and_must_be_a_list(self) -> None:
        self.assertEqual(
            validate_factory_machine({"transitions": []}),
            ["factory machine requires a states list"],
        )
        self.assertEqual(
            validate_factory_machine({"states": "nope"}),
            ["factory machine requires a states list"],
        )
        self.assertEqual(
            validate_factory_machine({"run": "bad", "states": "nope"}),
            ["run must be an object", "factory machine requires a states list"],
        )

    def test_state_cap(self) -> None:
        at_cap = {"states": [state(f"s{i}") for i in range(1024)], "transitions": []}
        at_cap["states"][0]["entry"] = True
        self.assertEqual(validate_factory_machine(at_cap), [])
        over_cap = {"states": [state(f"s{i}") for i in range(1025)], "transitions": []}
        over_cap["states"][0]["entry"] = True
        self.assertEqual(
            validate_factory_machine(over_cap),
            [f"factory machine must declare between 1 and 1024 states, got 1025"],
        )
        empty = {"states": [], "transitions": []}
        self.assertEqual(
            validate_factory_machine(empty),
            ["factory machine must declare between 1 and 1024 states, got 0"],
        )

    def test_state_ids(self) -> None:
        for good in ("a", "state-1", "1st-state", "a" * 64):
            machine = {"states": [{"id": good, "entry": True, "subagent": "w"}], "transitions": []}
            self.assertEqual(validate_factory_machine(machine), [], good)
        for bad in ("-abc", "ABC", "a_b", "a.b", "a" * 65):
            machine = {"states": [{"id": bad, "entry": True, "subagent": "w"}], "transitions": []}
            errors = validate_factory_machine(machine)
            self.assertEqual(len(errors), 1, bad)
            self.assertIn("id must match", errors[0])
        for bad in ("", None, 5):
            machine = {"states": [{"id": bad, "subagent": "w"}], "transitions": []}
            self.assertEqual(
                validate_factory_machine(machine),
                ["states[0] requires a non-empty id"],
                repr(bad),
            )

    def test_duplicate_state_ids(self) -> None:
        machine = {"states": [state("dup"), state("dup")], "transitions": []}
        machine["states"][0]["entry"] = True
        errors = validate_factory_machine(machine)
        self.assertEqual(len(errors), 1)
        self.assertIn("duplicates state id 'dup'", errors[0])

    def test_entry_state_required(self) -> None:
        no_entry = {"states": [state("a"), state("b")], "transitions": [{"from": "a", "to": "b"}]}
        self.assertEqual(
            validate_factory_machine(no_entry),
            ["factory machine requires at least one entry state"],
        )
        explicit_false = {"states": [state("a", entry=False)], "transitions": []}
        self.assertEqual(
            validate_factory_machine(explicit_false),
            ["factory machine requires at least one entry state"],
        )
        bad_flag = {"states": [state("a", entry="yes")], "transitions": []}
        self.assertEqual(
            validate_factory_machine(bad_flag),
            ["state a entry must be a boolean", "factory machine requires at least one entry state"],
        )

    def test_optional_input_flag(self) -> None:
        ok = {
            "states": [
                {"id": "seed", "entry": True, "subagent": "w", "outputs": [{"name": "o", "type": "json"}]},
                {
                    "id": "loop",
                    "subagent": "w",
                    "inputs": [{"name": "o", "type": "json", "from": "seed.o", "optional": True}],
                },
            ],
            "transitions": [{"from": "seed", "to": "loop"}],
        }
        self.assertEqual(validate_factory_machine(ok), [])
        for bad in ("yes", 1, []):
            machine = {
                "states": [
                    state("seed", entry=True, outputs=[{"name": "o", "type": "json"}]),
                    {
                        "id": "loop",
                        "subagent": "w",
                        "inputs": [{"name": "o", "type": "json", "from": "seed.o", "optional": bad}],
                    },
                ],
                "transitions": [{"from": "seed", "to": "loop"}],
            }
            self.assertEqual(
                validate_factory_machine(machine),
                ["state loop input 'o' optional must be a boolean when provided"],
                repr(bad),
            )

    def test_required_self_input_is_rejected_optional_stays_the_loop_form(self) -> None:
        # A required self-input can never bind: the first entry waits for its
        # own prior settle, which cannot exist yet -- the entry stays pending
        # until the stall detector fails the run naming the state. Optional
        # self-inputs are the designed loop form (first entry binds the null
        # sentinel) and stay valid; the rule is the machine-form mirror of
        # the dag compiler's "cannot depend on itself" rejection.
        absent = object()  # sentinel: the optional key is omitted entirely

        def machine(optional: Any = absent) -> dict[str, Any]:
            loop_inputs: list[dict[str, Any]] = [{"name": "last", "type": "text", "from": "loop.last"}]
            if optional is not absent:
                loop_inputs[0]["optional"] = optional
            return {
                "states": [
                    {"id": "seed", "entry": True, "subagent": "w", "outputs": [{"name": "go", "type": "text"}]},
                    {
                        "id": "loop",
                        "subagent": "w",
                        "inputs": loop_inputs,
                        "outputs": [{"name": "last", "type": "text"}],
                        "max_entries": 3,
                    },
                ],
                "transitions": [{"from": "seed", "to": "loop"}, {"from": "loop", "to": "loop"}],
            }

        self.assertEqual(validate_factory_machine(machine(True)), [])
        for required in (False, absent):
            self.assertEqual(
                validate_factory_machine(machine(required)),
                [
                    "state loop input 'last' cannot require itself: mark the self-input optional - "
                    "a required one can never bind on the state's first entry"
                ],
                repr(required),
            )

    def test_entry_states_cannot_declare_inputs(self) -> None:
        with_inputs = {
            "states": [
                state("src", entry=True, inputs=[{"name": "i", "type": "text", "from": "peer.o"}]),
                state("peer", outputs=[{"name": "o", "type": "text"}]),
            ],
            "transitions": [{"from": "peer", "to": "src"}],
        }
        self.assertEqual(
            validate_factory_machine(with_inputs),
            ["entry state src cannot declare inputs"],
        )
        entry_without_inputs = {"states": [state("a", entry=True)], "transitions": []}
        self.assertEqual(validate_factory_machine(entry_without_inputs), [])
        # Compiled dags only mark dep-free nodes as entry states, so the rule
        # never fires on the dag path.
        dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a"], inputs=[{"name": "i", "type": "text", "from": "a.o"}]),
            ]
        }
        self.assertEqual(validate_factory_spec(dag), [])

    def test_max_entries(self) -> None:
        for good in (1, 2, 99):
            machine = {"states": [state("a", entry=True, max_entries=good)], "transitions": []}
            self.assertEqual(validate_factory_machine(machine), [], good)
        for bad in (0, -1, 1.5, "2", True):
            machine = {"states": [state("a", entry=True, max_entries=bad)], "transitions": []}
            self.assertEqual(
                validate_factory_machine(machine),
                ["state a max_entries must be an integer >= 1"],
                repr(bad),
            )

    def test_subagent_required(self) -> None:
        missing = {"states": [{"id": "a", "entry": True}], "transitions": []}
        errors = validate_factory_machine(missing)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])
        self.assertIn("state a", errors[0])

        empty_ref = {"states": [state("a", entry=True, subagent="")], "transitions": []}
        errors = validate_factory_machine(empty_ref)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])

        empty_prompt = {"states": [state("a", entry=True, subagent={"prompt": ""})], "transitions": []}
        errors = validate_factory_machine(empty_prompt)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a non-empty prompt", errors[0])

        bad_model = {"states": [state("a", entry=True, subagent={"prompt": "p", "model": 5})], "transitions": []}
        errors = validate_factory_machine(bad_model)
        self.assertEqual(len(errors), 1)
        self.assertIn("model must be a non-empty string", errors[0])

        # Whitespace-only inline fields are write-time invalid in machine
        # form too (the shared state validation strips like the runtime
        # resolvers do), so no persistable machine can be unspawnable.
        whitespace = {
            "states": [state("a", entry=True, subagent={"prompt": "  ", "model": " \t "})],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(whitespace),
            [
                "state a inline subagent requires a non-empty prompt",
                "state a inline subagent model must be a non-empty string when provided",
            ],
        )

        inline_ok = {
            "states": [state("a", entry=True, subagent={"prompt": "Do work.", "name": "w", "thinking": "high"})],
            "transitions": [],
        }
        self.assertEqual(validate_factory_machine(inline_ok), [])

    def test_inline_subagent_name_length_and_uniqueness(self) -> None:
        # The configured name labels spawned children, and the host caps
        # subagent session names at 64 characters: reject an over-length
        # name at write time (a persistable factory must be spawnable)
        # instead of failing every spawn admission.
        too_long = {
            "states": [state("a", entry=True, subagent={"prompt": "p", "name": "x" * (SUBAGENT_NAME_MAX_LENGTH + 1)})],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(too_long),
            [
                f"state a inline subagent name must be at most {SUBAGENT_NAME_MAX_LENGTH} characters, "
                f"got {SUBAGENT_NAME_MAX_LENGTH + 1}"
            ],
        )

        # Two states configured with one name would collide on the
        # supervisor's unique sibling-name requirement at spawn time: reject
        # the duplicate at write time, like duplicate state ids.
        duplicate = {
            "states": [
                {"id": "a", "entry": True, "subagent": {"prompt": "p", "name": "reviewer"}},
                {"id": "b", "subagent": {"prompt": "p", "name": "reviewer"}},
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        self.assertEqual(
            validate_factory_machine(duplicate),
            ["state b subagent name 'reviewer' is already configured by state 'a'"],
        )
        # Distinct configured names are fine, and string references never
        # carry a name.
        distinct = {
            "states": [
                {"id": "a", "entry": True, "subagent": {"prompt": "p", "name": "reviewer"}},
                {"id": "b", "subagent": {"prompt": "p", "name": "fixer"}},
                {"id": "c", "subagent": "worker"},
            ],
            "transitions": [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}],
        }
        self.assertEqual(validate_factory_machine(distinct), [])

        # A name another state's name can suffix onto (Macroscope review
        # finding: foo's later instances spawn foo-i1, so a state configured
        # foo-i1 collides at spawn time) is rejected at write time, in
        # either order; the attempt chain form is caught too.
        shadowing = {
            "states": [
                {"id": "a", "entry": True, "subagent": {"prompt": "p", "name": "foo"}},
                {"id": "b", "subagent": {"prompt": "p", "name": "foo-i1"}},
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        errors = validate_factory_machine(shadowing)
        self.assertEqual(len(errors), 1)
        self.assertIn("collides with the suffixed spawn labels of state 'a'", errors[0])
        self.assertIn("re-entry, foreach, and retries name children 'foo'-i<n> and 'foo'-a<n>", errors[0])
        # Reversed declaration order: the CURRENT state's name generates the
        # suffixed labels, and the message must attribute them to it, not to
        # the earlier state (Cursor review finding).
        reversed_shadowing = {
            "states": [
                {"id": "a", "entry": True, "subagent": {"prompt": "p", "name": "foo-i1"}},
                {"id": "b", "subagent": {"prompt": "p", "name": "foo"}},
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        errors = validate_factory_machine(reversed_shadowing)
        self.assertEqual(len(errors), 1)
        self.assertEqual(
            errors[0],
            "state b subagent name 'foo' suffixed by re-entry, foreach, and retries "
            "('foo'-i<n>, 'foo'-a<n>) collides with state 'a' (configured 'foo-i1')",
        )
        for shadowed_name in ("foo-a2", "foo-i1-a2", "foo-i9"):
            machine = {
                "states": [
                    {"id": "a", "entry": True, "subagent": {"prompt": "p", "name": "foo"}},
                    {"id": "b", "subagent": {"prompt": "p", "name": shadowed_name}},
                ],
                "transitions": [{"from": "a", "to": "b"}],
            }
            self.assertEqual(len(validate_factory_machine(machine)), 1, shadowed_name)
        # The never-generated -i0/-a1 do not shadow, and unrelated names pass.
        no_shadow = {
            "states": [
                {"id": "a", "entry": True, "subagent": {"prompt": "p", "name": "foo"}},
                {"id": "b", "subagent": {"prompt": "p", "name": "foo-i0"}},
                {"id": "c", "subagent": {"prompt": "p", "name": "foo-a1"}},
                {"id": "d", "subagent": {"prompt": "p", "name": "bar-i1"}},
            ],
            "transitions": [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}, {"from": "c", "to": "d"}],
        }
        self.assertEqual(validate_factory_machine(no_shadow), [])

    def test_wait_states_are_gated_until_the_communication_series(self) -> None:
        # The rlm.watch.* host handlers do not exist on this stack, so wait
        # blocks are rejected outright (machine form and dag form alike).
        machine = {
            "states": [
                {"id": "watch", "entry": True, "subagent": "w", "wait": {"kind": "path", "target": "/tmp/x", "timeout_ms": 5}},
                state("act"),
            ],
            "transitions": [{"from": "watch", "to": "act"}],
        }
        errors = validate_factory_machine(machine)
        self.assertEqual(
            errors,
            [
                "state watch: wait states require the watch host handlers (rlm.watch.*); "
                "they arrive with the communication series - remove the wait block until then"
            ],
        )
        self.assertEqual(validate_factory_spec(machine), errors)

        dag_wait = {"nodes": [node("a", wait={"kind": "path", "target": "t", "timeout_ms": 5})]}
        errors = validate_factory_spec(dag_wait)
        self.assertEqual(
            errors,
            [
                "node a: wait states require the watch host handlers (rlm.watch.*); "
                "they arrive with the communication series - remove the wait block until then"
            ],
        )

    def test_resident_states(self) -> None:
        resident_ok = {
            "states": [
                {"id": "entry", "entry": True, "subagent": "w", "outputs": [{"name": "o", "type": "text"}]},
                {"id": "watcher", "subagent": "w", "lifecycle": "resident"},
            ],
            "transitions": [{"from": "entry", "to": "watcher"}],
        }
        self.assertEqual(validate_factory_machine(resident_ok), [])

        declares_outputs = {
            "states": [state("watcher", entry=True, lifecycle="resident", outputs=[{"name": "o", "type": "text"}])],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(declares_outputs),
            ["resident state watcher cannot declare outputs"],
        )
        uses_foreach = {
            "states": [
                state("src", entry=True, outputs=[{"name": "items", "type": "json"}]),
                {
                    "id": "watcher",
                    "subagent": "w",
                    "lifecycle": "resident",
                    "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                    "foreach": {"over": "items", "max": 4},
                },
            ],
            "transitions": [{"from": "src", "to": "watcher"}],
        }
        self.assertEqual(validate_factory_machine(uses_foreach), ["resident state watcher cannot use foreach"])
        leaves_resident = {
            "states": [
                {"id": "entry", "entry": True, "subagent": "w"},
                {"id": "watcher", "subagent": "w", "lifecycle": "resident"},
            ],
            "transitions": [{"from": "watcher", "to": "entry"}],
        }
        self.assertEqual(
            validate_factory_machine(leaves_resident),
            ["transitions[0] cannot leave resident state 'watcher'"],
        )

    def test_input_cannot_read_from_resident_state(self) -> None:
        machine = {
            "states": [
                state("watcher", lifecycle="resident"),
                state("task", inputs=[{"name": "i", "type": "text", "from": "watcher.o"}]),
                state("seed", entry=True),
            ],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(machine),
            ["state task input 'i' cannot read from resident state 'watcher'"],
        )

    def test_port_rules(self) -> None:
        dup_output = {"states": [state("a", entry=True, outputs=[{"name": "o", "type": "text"}, {"name": "o", "type": "json"}])], "transitions": []}
        self.assertEqual(validate_factory_machine(dup_output), ["state a declares duplicate output name 'o'"])
        bad_type = {"states": [state("a", entry=True, outputs=[{"name": "o", "type": "yaml"}])], "transitions": []}
        self.assertEqual(validate_factory_machine(bad_type), ["state a output 'o' type must be 'text' or 'json'"])
        unknown_source = {
            "states": [state("a", entry=True), state("b", inputs=[{"name": "i", "type": "text", "from": "ghost.o"}])],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(unknown_source),
            ["state b input 'i' references unknown state 'ghost'"],
        )
        undeclared_output = {
            "states": [
                state("a", entry=True),
                state("b", inputs=[{"name": "i", "type": "text", "from": "a.missing"}]),
            ],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(undeclared_output),
            ["state b input 'i' references output 'missing' that state 'a' does not declare"],
        )
        type_mismatch = {
            "states": [
                state("a", entry=True, outputs=[{"name": "o", "type": "text"}]),
                state("b", inputs=[{"name": "i", "type": "json", "from": "a.o"}]),
            ],
            "transitions": [],
        }
        errors = validate_factory_machine(type_mismatch)
        self.assertEqual(len(errors), 1)
        self.assertIn("cannot read from output", errors[0])
        malformed = {
            "states": [
                state("a", entry=True, outputs=[{"name": "o", "type": "text"}]),
                state("b", inputs=[{"name": "i", "type": "text", "from": "nodot"}]),
            ],
            "transitions": [],
        }
        errors = validate_factory_machine(malformed)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a 'from' reference", errors[0])

    def test_budgets_and_retries_and_policies(self) -> None:
        over = {
            "run": {"budget_ms": 1000},
            "states": [state("a", entry=True, budget_ms=1001)],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(over),
            ["state a budget_ms 1001 exceeds the run budget_ms 1000"],
        )
        for bad in (0, -5, 1.5, "10", True):
            machine = {"run": {"budget_ms": bad}, "states": [state("a", entry=True)], "transitions": []}
            self.assertEqual(validate_factory_machine(machine), ["run budget_ms must be a positive integer"], bad)
            machine = {"states": [state("a", entry=True, budget_ms=bad)], "transitions": []}
            self.assertEqual(validate_factory_machine(machine), ["state a budget_ms must be a positive integer"], bad)
        for bad in (-1, 11, 1.5, "2", True):
            machine = {"states": [state("a", entry=True, retries=bad)], "transitions": []}
            self.assertEqual(
                validate_factory_machine(machine),
                ["state a retries must be an integer between 0 and 10"],
                bad,
            )
        bad_policy = {"states": [state("a", entry=True, failure_policy="retry")], "transitions": []}
        self.assertEqual(
            validate_factory_machine(bad_policy),
            ["state a failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got 'retry'"],
        )
        bad_lifecycle = {"states": [state("a", entry=True, lifecycle="daemon")], "transitions": []}
        self.assertEqual(
            validate_factory_machine(bad_lifecycle),
            ["state a lifecycle must be 'task' or 'resident', got 'daemon'"],
        )

    def test_run_max_transitions(self) -> None:
        for good in (1, 40, 10_000):
            machine = {"run": {"max_transitions": good}, "states": [state("a", entry=True)], "transitions": []}
            self.assertEqual(validate_factory_machine(machine), [], good)
        for bad in (0, -1, 10_001, 1.5, "5", True):
            machine = {"run": {"max_transitions": bad}, "states": [state("a", entry=True)], "transitions": []}
            self.assertEqual(
                validate_factory_machine(machine),
                ["run max_transitions must be a positive integer no greater than 10000"],
                bad,
            )

    def test_foreach_rules(self) -> None:
        ok = {
            "states": [
                state("a", entry=True, outputs=[{"name": "items", "type": "json"}]),
                state(
                    "b",
                    inputs=[{"name": "items", "type": "json", "from": "a.items"}],
                    foreach={"over": "items", "max": 16},
                ),
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        self.assertEqual(validate_factory_machine(ok), [])
        wrong_port = {
            "states": [
                state("a", entry=True, outputs=[{"name": "items", "type": "json"}]),
                state(
                    "b",
                    inputs=[{"name": "items", "type": "json", "from": "a.items"}],
                    foreach={"over": "not-an-input", "max": 4},
                ),
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        self.assertEqual(
            validate_factory_machine(wrong_port),
            ["state b foreach.over must name one of this state's inputs, got 'not-an-input'"],
        )
        text_port = {
            "states": [
                state("a", entry=True, outputs=[{"name": "draft", "type": "text"}]),
                state(
                    "b",
                    inputs=[{"name": "draft", "type": "text", "from": "a.draft"}],
                    foreach={"over": "draft", "max": 4},
                ),
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        self.assertEqual(validate_factory_machine(text_port), ["state b foreach.over input 'draft' must have type 'json'"])
        bad_max = {
            "states": [
                state("a", entry=True, outputs=[{"name": "items", "type": "json"}]),
                state(
                    "b",
                    inputs=[{"name": "items", "type": "json", "from": "a.items"}],
                    foreach={"over": "items", "max": 257},
                ),
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        self.assertEqual(validate_factory_machine(bad_max), ["state b foreach.max must be an integer between 1 and 256"])
        not_object = {"states": [state("a", entry=True, foreach=["bad"])], "transitions": []}
        self.assertEqual(validate_factory_machine(not_object), ["state a foreach must be an object"])

    def test_transitions_reference_existing_states(self) -> None:
        unknown_from = {
            "states": [state("a", entry=True)],
            "transitions": [{"from": "ghost", "to": "a"}],
        }
        self.assertEqual(
            validate_factory_machine(unknown_from),
            ["transitions[0] references unknown from-state 'ghost'"],
        )
        unknown_to = {"states": [state("a", entry=True)], "transitions": [{"from": "a", "to": "ghost"}]}
        self.assertEqual(
            validate_factory_machine(unknown_to),
            ["transitions[0] references unknown to-state 'ghost'"],
        )
        not_object = {"states": [state("a", entry=True)], "transitions": ["bad"]}
        self.assertEqual(validate_factory_machine(not_object), ["transitions[0] must be an object"])
        not_a_list = {"states": [state("a", entry=True)], "transitions": "bad"}
        self.assertEqual(validate_factory_machine(not_a_list), ["factory machine transitions must be a list"])
        bad_on = {"states": [state("a", entry=True)], "transitions": [{"from": "a", "to": "a", "on": "manual"}]}
        self.assertEqual(
            validate_factory_machine(bad_on),
            ["transitions[0] on must be one of ['settled'], got 'manual'"],
        )

    def test_join_transitions_from_a_list(self) -> None:
        # A ``from`` LIST is a join transition: it fires once every source
        # state settled (the compiled dag fan-in shape).
        ok = {
            "states": [
                state("a", entry=True),
                state("b", entry=True),
                state("d"),
            ],
            "transitions": [{"from": ["a", "b"], "to": "d"}],
        }
        self.assertEqual(validate_factory_machine(ok), [])

        unknown_source = {
            "states": [state("a", entry=True), state("d")],
            "transitions": [{"from": ["a", "ghost"], "to": "d"}],
        }
        self.assertEqual(
            validate_factory_machine(unknown_source),
            ["transitions[0] references unknown from-state 'ghost'"],
        )
        repeated_source = {
            "states": [state("a", entry=True), state("d")],
            "transitions": [{"from": ["a", "a"], "to": "d"}],
        }
        self.assertEqual(
            validate_factory_machine(repeated_source),
            ["transitions[0] from must not repeat a state"],
        )
        empty_source = {
            "states": [state("a", entry=True), state("d")],
            "transitions": [{"from": [], "to": "d"}],
        }
        self.assertEqual(
            validate_factory_machine(empty_source),
            ["transitions[0] from must name at least one state"],
        )
        non_string_entry = {
            "states": [state("a", entry=True), state("d")],
            "transitions": [{"from": ["a", 5], "to": "d"}],
        }
        self.assertEqual(
            validate_factory_machine(non_string_entry),
            ["transitions[0] from entries must be non-empty state id strings"],
        )
        # A guard needs exactly one from-state's latest settle output.
        guard_on_join = {
            "states": [
                state("a", entry=True),
                state("b", entry=True),
                state("d"),
            ],
            "transitions": [
                {"from": ["a", "b"], "to": "d", "when": {"output": "o", "op": "exists"}},
            ],
        }
        self.assertEqual(
            validate_factory_machine(guard_on_join),
            [
                "transitions[0] with multiple from-states cannot carry a when guard; "
                "use single-state transitions for guards"
            ],
        )
        resident_source = {
            "states": [
                state("a", entry=True),
                {"id": "watcher", "subagent": "w", "lifecycle": "resident"},
                state("d"),
            ],
            "transitions": [{"from": ["a", "watcher"], "to": "d"}],
        }
        self.assertEqual(
            validate_factory_machine(resident_source),
            ["transitions[0] cannot leave resident state 'watcher'"],
        )
        # Regression (bot review): UNHASHABLE malformed entries (a dict, a
        # list) used to raise a raw TypeError from the set() dedupe before
        # the type check; validation must report an error instead.
        for bad_from in ([{}], [[1]], ["a", {}]):
            malformed = {
                "states": [state("a", entry=True), state("d")],
                "transitions": [{"from": bad_from, "to": "d"}],
            }
            self.assertEqual(
                validate_factory_machine(malformed),
                ["transitions[0] from entries must be non-empty state id strings"],
            )
            self.assertEqual(
                validate_factory_spec(
                    {
                        "states": [state("a", entry=True), state("d")],
                        "transitions": [{"from": bad_from, "to": "d"}],
                    }
                ),
                ["transitions[0] from entries must be non-empty state id strings"],
            )

    def test_self_loop_is_legal_re_entry(self) -> None:
        machine = {
            "states": [state("a", entry=True, max_entries=5, outputs=[{"name": "o", "type": "json"}])],
            "transitions": [{"from": "a", "to": "a"}],
        }
        self.assertEqual(validate_factory_machine(machine), [])

    def test_cyclic_machine_validates(self) -> None:
        machine = {
            "states": [
                state("seed", entry=True, outputs=[{"name": "o", "type": "text"}]),
                state("b"),
                state("c"),
            ],
            "transitions": [
                {"from": "seed", "to": "b"},
                {"from": "b", "to": "c"},
                {"from": "c", "to": "b"},
            ],
        }
        self.assertEqual(validate_factory_machine(machine), [])
        self.assertEqual(validate_factory_spec(machine), [])

    def test_guard_values_must_be_finite(self) -> None:
        # Regression (bot review): a non-finite float in a guard comparison
        # value serializes as the non-JSON NaN/Infinity tokens and breaks
        # every strict consumer of the activity reply frames (the host
        # bridge's parser included) — validation rejects them at the
        # machine's source, deeply (a contains needle list carries the
        # same rule).
        def machine_with(when: Any) -> dict[str, Any]:
            return {
                "states": [
                    state("a", entry=True, outputs=[{"name": "verdict", "type": "json"}]),
                    state("b"),
                ],
                "transitions": [{"from": "a", "to": "b", "when": when}],
            }

        for bad in (float("nan"), float("inf"), float("-inf")):
            self.assertEqual(
                validate_factory_machine(
                    machine_with({"output": "verdict", "op": "eq", "value": bad})
                ),
                ["transitions[0] when.value must be finite JSON data (JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, and no container nests deeper than 256 levels)"],
                repr(bad),
            )
        nested = machine_with(
            {"output": "verdict", "op": "contains", "value": ["ok", {"x": float("nan")}]}
        )
        self.assertEqual(
            validate_factory_machine(nested),
            ["transitions[0] when.value must be finite JSON data (JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, and no container nests deeper than 256 levels)"],
        )

    def test_guard_value_object_keys_must_be_strings(self) -> None:
        # The same wire-cleanliness rule at the object's keys: a
        # non-finite float key serializes as the non-JSON ``NaN`` token
        # and breaks the strict consumers, and a non-string key is either
        # coerced by the encoder (the wire object no longer matches the
        # declared machine) or rejected by it — a guard declaring one
        # never survives the reply frames.
        def machine_with(value: Any) -> dict[str, Any]:
            return {
                "states": [
                    state("a", entry=True, outputs=[{"name": "verdict", "type": "json"}]),
                    state("b"),
                ],
                "transitions": [
                    {"from": "a", "to": "b", "when": {"output": "verdict", "op": "contains", "value": value}}
                ],
            }

        for bad in (
            {float("nan"): 1},
            {1: "x"},
            {"ok": {("tuple",): 2}},
            # Non-JSON container leaves reject at the source: a tuple
            # serializes as something other than the declared shape (an
            # array) if the encoder accepts it at all, and the floats it
            # carries would ride past the finiteness traversal.
            (float("nan"),),
            ("plain", "tuple"),
            {"set", "of", "strings"},
            b"bytes",
        ):
            self.assertEqual(
                validate_factory_machine(machine_with(["ok", bad])),
                ["transitions[0] when.value must be finite JSON data (JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, and no container nests deeper than 256 levels)"],
                repr(bad),
            )
        # String keys with finite values stay valid.
        self.assertEqual(
            validate_factory_machine(machine_with(["ok", {"flag": True, "nested": {"count": 2}}])),
            [],
        )

    def test_guard_value_cycles_reject_without_exhausting_the_stack(self) -> None:
        # A self-referential container can never serialize (the encoder
        # refuses circular references outright), so it is not a valid
        # comparison value: the traversal must reject it at the cycle
        # instead of chasing it to a RecursionError, and the write path
        # must answer the validation error, not crash.
        def machine_with(value: Any) -> dict[str, Any]:
            return {
                "states": [
                    state("a", entry=True, outputs=[{"name": "verdict", "type": "json"}]),
                    state("b"),
                ],
                "transitions": [
                    {"from": "a", "to": "b", "when": {"output": "verdict", "op": "contains", "value": value}}
                ],
            }

        cycle: list[Any] = ["ok"]
        cycle.append(cycle)
        self.assertEqual(
            validate_factory_machine(machine_with(cycle)),
            ["transitions[0] when.value must be finite JSON data (JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, and no container nests deeper than 256 levels)"],
        )
        nested: dict[str, Any] = {"flag": True}
        nested["self"] = nested
        self.assertEqual(
            validate_factory_machine(machine_with([nested])),
            ["transitions[0] when.value must be finite JSON data (JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, and no container nests deeper than 256 levels)"],
        )
        # A shared-but-acyclic reference is NOT a cycle: the same object
        # appearing twice (a diamond) stays a valid comparison value.
        shared = {"flag": True}
        self.assertEqual(validate_factory_machine(machine_with([shared, shared])), [])

    def test_guard_value_depth_rejects_without_exhausting_the_stack(self) -> None:
        # Deep-but-ACYCLIC nesting is the cycle rule's other half: the
        # traversal descends one level per recursion, so a value nested
        # past the interpreter's stack would raise RecursionError on the
        # write path instead of answering the validation error. Every
        # downstream seam recurses per level the same way (the snapshot's
        # deep copy, the wire conversion, the reply frames' encoder), so
        # the nesting rejects at the bound with the same message — and a
        # value under the bound (realistic guard values nest a handful of
        # levels) stays valid.
        def machine_with(value: Any) -> dict[str, Any]:
            return {
                "states": [
                    state("a", entry=True, outputs=[{"name": "verdict", "type": "json"}]),
                    state("b"),
                ],
                "transitions": [
                    {"from": "a", "to": "b", "when": {"output": "verdict", "op": "contains", "value": value}}
                ],
            }

        deep: list[Any] = []
        node = deep
        for _ in range(factory_module.MAX_GUARD_VALUE_DEPTH + 50):
            child: list[Any] = []
            node.append(child)
            node = child
        self.assertEqual(
            validate_factory_machine(machine_with(deep)),
            ["transitions[0] when.value must be finite JSON data (JSON carries no NaN or Infinity, and only JSON shapes serialize: lists, objects, strings, numbers, booleans, null, and no container nests deeper than 256 levels)"],
        )
        within: list[Any] = ["verdict"]
        for _ in range(10):
            within = [within]
        self.assertEqual(validate_factory_machine(machine_with(within)), [])

    def test_guard_rules(self) -> None:
        def machine_with(when: Any) -> dict[str, Any]:
            return {
                "states": [state("a", entry=True, outputs=[{"name": "verdict", "type": "json"}]), state("b")],
                "transitions": [{"from": "a", "to": "b", "when": when}],
            }

        unknown_output = machine_with({"output": "missing", "op": "exists"})
        self.assertEqual(
            validate_factory_machine(unknown_output),
            ["transitions[0] when.output 'missing' is not a declared output of state 'a'"],
        )
        empty_output = machine_with({"output": "", "op": "exists"})
        self.assertEqual(
            validate_factory_machine(empty_output),
            ["transitions[0] when requires a non-empty output"],
        )
        not_object = machine_with("nope")
        self.assertEqual(validate_factory_machine(not_object), ["transitions[0] when must be an object"])
        path_on_text = {
            "states": [
                state("a", entry=True, outputs=[{"name": "note", "type": "text"}]),
                state("b"),
            ],
            "transitions": [{"from": "a", "to": "b", "when": {"output": "note", "path": "x", "op": "eq", "value": 1}}],
        }
        self.assertEqual(
            validate_factory_machine(path_on_text),
            ["transitions[0] when.path requires a json output, got text output 'note'"],
        )
        bad_op = machine_with({"output": "verdict", "op": "matches", "value": 1})
        self.assertEqual(
            validate_factory_machine(bad_op),
            ["transitions[0] when.op must be one of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'], got 'matches'"],
        )
        for op in ("gt", "gte", "lt", "lte"):
            non_numeric = machine_with({"output": "verdict", "op": op, "value": "1"})
            self.assertEqual(
                validate_factory_machine(non_numeric),
                [f"transitions[0] when.op {op!r} requires a numeric value"],
                op,
            )
        contains_needs_list = machine_with({"output": "verdict", "op": "contains", "value": "x"})
        self.assertEqual(
            validate_factory_machine(contains_needs_list),
            ["transitions[0] when.op 'contains' requires a non-empty list value"],
        )
        # Review finding: an empty list is not a legal contains needle.
        contains_empty_list = machine_with({"output": "verdict", "op": "contains", "value": []})
        self.assertEqual(
            validate_factory_machine(contains_empty_list),
            ["transitions[0] when.op 'contains' requires a non-empty list value"],
        )
        eq_rejects_list = machine_with({"output": "verdict", "op": "eq", "value": [1]})
        self.assertEqual(
            validate_factory_machine(eq_rejects_list),
            ["transitions[0] when.op 'eq' requires a scalar value"],
        )
        ne_rejects_list = machine_with({"output": "verdict", "op": "ne", "value": [1]})
        self.assertEqual(
            validate_factory_machine(ne_rejects_list),
            ["transitions[0] when.op 'ne' requires a scalar value"],
        )
        empty_path = machine_with({"output": "verdict", "path": "", "op": "exists"})
        self.assertEqual(
            validate_factory_machine(empty_path),
            ["transitions[0] when.path must be a non-empty dotted path"],
        )
        # Valid guard shapes across every op.
        for when in (
            {"output": "verdict", "path": "approved", "op": "eq", "value": False},
            {"output": "verdict", "path": "approved", "op": "ne", "value": True},
            {"output": "verdict", "path": "score", "op": "gt", "value": 1.5},
            {"output": "verdict", "path": "score", "op": "gte", "value": 2},
            {"output": "verdict", "path": "score", "op": "lt", "value": 0},
            {"output": "verdict", "path": "score", "op": "lte", "value": -3},
            {"output": "verdict", "path": "findings", "op": "exists"},
            {"output": "verdict", "path": "tags", "op": "contains", "value": ["a", "b"]},
            {"output": "verdict", "op": "exists"},
        ):
            self.assertEqual(validate_factory_machine(machine_with(when)), [], repr(when))

    def test_collects_multiple_errors(self) -> None:
        machine = {
            "run": {"max_parallel": 99, "failure_policy": "nope"},
            "states": [
                {"id": "a", "entry": True, "subagent": "w", "retries": 99},
                {"id": "b", "subagent": "w", "max_entries": 0},
            ],
            "transitions": [{"from": "a", "to": "ghost"}],
        }
        self.assertEqual(
            validate_factory_machine(machine),
            [
                "run failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got 'nope'",
                "run max_parallel must be an integer between 1 and 64",
                "state a retries must be an integer between 0 and 10",
                "state b max_entries must be an integer >= 1",
                "transitions[0] references unknown to-state 'ghost'",
            ],
        )


# ---------------------------------------------------------------------------
# Dag compilation: the dag sugar compiles to machine form
# ---------------------------------------------------------------------------


class CompileFactoryDagTest(unittest.TestCase):
    def test_chain_compiles(self) -> None:
        dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a"]),
                node("c", depends_on=["b"]),
            ]
        }
        machine, errors = compile_factory_dag(dag)
        self.assertEqual(errors, [])
        self.assertEqual(
            machine,
            {
                "states": [
                    {"id": "a", "entry": True, "max_entries": 1, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                    {"id": "b", "entry": False, "max_entries": 1, "subagent": "worker"},
                    {"id": "c", "entry": False, "max_entries": 1, "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "a", "to": "b"},
                    {"from": "b", "to": "c"},
                ],
            },
        )
        self.assertEqual(validate_factory_machine(machine), [])

    def test_diamond_compiles_the_fan_in_to_one_join_transition(self) -> None:
        # Review finding: a fan-in node's full effective dependency set
        # compiles to ONE join transition that waits for every predecessor.
        # Per-edge transitions would let d start after only b (or c) settled
        # and then block the other transition at max_entries, so d could run
        # with a missing input.
        dag = {
            "run": {"failure_policy": "continue", "max_parallel": 3, "budget_ms": 5000},
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a"], outputs=[{"name": "o", "type": "text"}]),
                node("c", depends_on=["a"], outputs=[{"name": "o", "type": "text"}]),
                node(
                    "d",
                    depends_on=["b", "c"],
                    inputs=[{"name": "left", "type": "text", "from": "b.o"}, {"name": "right", "type": "text", "from": "c.o"}],
                    budget_ms=4000,
                ),
            ],
        }
        machine, errors = compile_factory_dag(dag)
        self.assertEqual(errors, [])
        self.assertEqual(
            machine,
            {
                "run": {"failure_policy": "continue", "max_parallel": 3, "budget_ms": 5000},
                "states": [
                    {"id": "a", "entry": True, "max_entries": 1, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                    {"id": "b", "entry": False, "max_entries": 1, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                    {"id": "c", "entry": False, "max_entries": 1, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                    {
                        "id": "d",
                        "entry": False,
                        "max_entries": 1,
                        "subagent": "worker",
                        "budget_ms": 4000,
                        "inputs": [
                            {"name": "left", "type": "text", "from": "b.o"},
                            {"name": "right", "type": "text", "from": "c.o"},
                        ],
                    },
                ],
                "transitions": [
                    {"from": "a", "to": "b"},
                    {"from": "a", "to": "c"},
                    {"from": ["b", "c"], "to": "d"},
                ],
            },
        )
        self.assertEqual(validate_factory_machine(machine), [])

    def test_wide_fan_in_stays_one_join_per_target(self) -> None:
        # 300 predecessors, data edges plus depends_on: the target's compiled
        # machine carries exactly ONE join transition listing them all.
        sources = [node(f"s{i}", outputs=[{"name": "o", "type": "text"}]) for i in range(300)]
        target = node(
            "t",
            depends_on=[f"s{i}" for i in range(0, 300, 2)],
            inputs=[{"name": f"i{i}", "type": "text", "from": f"s{i}.o"} for i in range(1, 300, 2)],
        )
        machine, errors = compile_factory_dag({"nodes": [*sources, target]})
        self.assertEqual(errors, [])
        self.assertEqual(len(machine["transitions"]), 1)
        join = machine["transitions"][0]
        self.assertEqual(join["to"], "t")
        self.assertEqual(set(join["from"]), {f"s{i}" for i in range(300)})
        self.assertEqual(validate_factory_machine(machine), [])

    def test_control_only_dependency_waits_too(self) -> None:
        # The join carries depends_on-only edges as well: a node with a
        # control-only parent must still wait for that parent's settle.
        dag = {
            "nodes": [
                node("b", outputs=[{"name": "o", "type": "text"}]),
                node("c"),
                node("d", depends_on=["b", "c"], inputs=[{"name": "l", "type": "text", "from": "b.o"}]),
            ]
        }
        machine, errors = compile_factory_dag(dag)
        self.assertEqual(errors, [])
        # c contributes no data (d reads nothing from it), so the join waits
        # for it as a pure control-only parent.
        self.assertEqual(machine["transitions"], [{"from": ["b", "c"], "to": "d"}])

    def test_data_edge_alone_creates_a_transition(self) -> None:
        dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", inputs=[{"name": "i", "type": "text", "from": "a.o"}]),
            ]
        }
        machine, errors = compile_factory_dag(dag)
        self.assertEqual(errors, [])
        self.assertEqual(machine["states"][1]["entry"], False)
        self.assertEqual(machine["transitions"], [{"from": "a", "to": "b"}])

    def test_depends_on_and_input_edge_dedupe_into_one_transition(self) -> None:
        dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a", "a"], inputs=[{"name": "i", "type": "text", "from": "a.o"}]),
            ]
        }
        machine, errors = compile_factory_dag(dag)
        self.assertEqual(errors, [])
        self.assertEqual(machine["transitions"], [{"from": "a", "to": "b"}])

    def test_explicit_empty_depends_on_still_enters(self) -> None:
        dag = {"nodes": [node("a", depends_on=[])]}
        machine, errors = compile_factory_dag(dag)
        self.assertEqual(errors, [])
        self.assertEqual(machine["states"][0]["entry"], True)
        self.assertEqual(machine["transitions"], [])

    def test_invalid_dag_returns_errors_without_a_machine(self) -> None:
        for bad, expected in (
            ("nope", "factory dag must be a JSON object"),
            ({"nodes": "nope"}, "factory dag requires a nodes list"),
            ({"nodes": []}, "factory dag must declare between 1 and 1024 nodes, got 0"),
            ({"nodes": [node("a", depends_on=["ghost"])]}, "node a depends on unknown node 'ghost'"),
        ):
            machine, errors = compile_factory_dag(bad)
            self.assertIsNone(machine, repr(bad))
            self.assertEqual(len(errors), 1, repr(bad))
            self.assertIn(expected, errors[0])

    def test_compiled_dag_and_handwritten_machine_canonicalize_identically(self) -> None:
        dag = {
            "run": {"failure_policy": "continue", "max_parallel": 2},
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a"], budget_ms=1000),
            ],
        }
        machine = {
            "run": {"failure_policy": "continue", "max_parallel": 2},
            "states": [
                {"id": "a", "entry": True, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                {"id": "b", "subagent": "worker", "max_entries": 1, "budget_ms": 1000},
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        self.assertEqual(canonicalize_factory_spec(dag), canonicalize_factory_spec(machine))

        # The join form compiles identically too.
        diamond_dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a"]),
                node("c", depends_on=["a"]),
                node("d", depends_on=["b", "c"]),
            ]
        }
        diamond_machine = {
            "states": [
                {"id": "a", "entry": True, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                {"id": "b", "subagent": "worker", "max_entries": 1},
                {"id": "c", "subagent": "worker", "max_entries": 1},
                {"id": "d", "subagent": "worker", "max_entries": 1},
            ],
            "transitions": [
                {"from": "a", "to": "b"},
                {"from": "a", "to": "c"},
                {"from": ["b", "c"], "to": "d"},
            ],
        }
        self.assertEqual(canonicalize_factory_spec(diamond_dag), canonicalize_factory_spec(diamond_machine))


class ValidateFactorySpecFormTest(unittest.TestCase):
    """The unified entry point detects the form first."""

    def test_both_forms_are_rejected_together(self) -> None:
        both = {"nodes": [node("a")], "states": [state("a", entry=True)]}
        self.assertEqual(validate_factory_spec(both), ["pass either dag or machine form, not both"])
        with self.assertRaisesRegex(ValueError, "not both"):
            canonicalize_factory_spec(both)

    def test_machine_wins_when_states_or_transitions_present(self) -> None:
        transitions_only = {"transitions": [{"from": "a", "to": "b"}]}
        self.assertEqual(
            validate_factory_spec(transitions_only),
            ["factory machine requires a states list"],
        )

    def test_dag_wording_without_machine_keys(self) -> None:
        self.assertEqual(
            validate_factory_spec({"nodes": "nope"}),
            ["factory dag requires a nodes list"],
        )

    def test_validation_reports_errors_and_never_raises(self) -> None:
        # The write-time dry run touches arbitrary caller JSON: malformed
        # shapes (unhashable entries, wrong types everywhere) must surface
        # as error lists, never as raw exceptions (regression: the join
        # set() dedupe used to raise TypeError on unhashable from entries).
        hostile = [
            "str",
            12,
            None,
            {"nodes": "nope"},
            {"nodes": [None, 5, "str"]},
            {"nodes": [{"id": {}, "subagent": "w"}]},
            {"nodes": [{"id": ["x"], "subagent": "w"}]},
            {"nodes": [{"id": "a", "subagent": {"prompt": 1}}]},
            {"nodes": [{"id": "a", "subagent": "w", "depends_on": "a"}]},
            {"nodes": [{"id": "a", "subagent": "w", "depends_on": [{}]}]},
            {"nodes": [{"id": "a", "subagent": "w", "inputs": "nope"}]},
            {"nodes": [{"id": "a", "subagent": "w", "inputs": [{"from": 5}]}]},
            {"nodes": [{"id": "a", "subagent": "w", "outputs": [{"name": {}, "type": "text"}]}]},
            {"nodes": [{"id": "a", "subagent": "w", "foreach": {"over": 5, "max": "x"}}]},
            {"states": [{"id": "a", "entry": True, "subagent": "w"}], "transitions": [{"from": {}, "to": "a"}]},
            {"states": [{"id": "a", "entry": True, "subagent": "w"}], "transitions": [{"from": [{}], "to": "a"}]},
            {"states": [{"id": "a", "entry": True, "subagent": "w"}], "transitions": [{"from": ["a", {}], "to": "a"}]},
            {"states": [{"id": "a", "entry": True, "subagent": "w"}], "transitions": [{"from": ["a"], "to": {}}]},
            {"states": [{"id": "a", "entry": True, "subagent": "w"}], "transitions": [{"from": "a", "to": "a", "when": {"op": "eq", "value": [1]}}]},
            {"states": [{"id": "a", "entry": True, "subagent": "w", "max_entries": {}}]},
            {"states": [{"id": "a", "entry": True, "subagent": "w"}], "transitions": {"from": "a"}},
            {"nodes": [{"id": "a", "subagent": "w"}], "states": [{"id": "b", "entry": True, "subagent": "w"}]},
        ]
        for index, spec in enumerate(hostile):
            result = validate_factory_spec(spec)
            self.assertIsInstance(result, list, f"spec #{index}")
            self.assertTrue(all(isinstance(error, str) and error for error in result), f"spec #{index}")
            self.assertTrue(result, f"hostile spec #{index} must report errors")


    def test_non_object_specs_reject_with_dag_wording(self) -> None:
        for bad in (None, [], "nodes", 42):
            self.assertEqual(validate_factory_spec(bad), ["factory dag must be a JSON object"], repr(bad))


class TopologicalOrderTest(unittest.TestCase):
    def test_happy_path_respects_effective_dependencies(self) -> None:
        nodes = [
            node("z", inputs=[{"name": "i", "type": "text", "from": "m.o"}]),
            node("a"),
            node("m", outputs=[{"name": "o", "type": "text"}], depends_on=["a"]),
        ]
        self.assertEqual(topological_order(nodes), ["a", "m", "z"])

    def test_chain(self) -> None:
        nodes = [
            node("c", depends_on=["b"]),
            node("b", depends_on=["a"]),
            node("a"),
        ]
        self.assertEqual(topological_order(nodes), ["a", "b", "c"])

    def test_cycle_raises(self) -> None:
        nodes = [node("a", depends_on=["b"]), node("b", depends_on=["a"])]
        with self.assertRaises(ValueError) as ctx:
            topological_order(nodes)
        self.assertIn("contains a cycle", str(ctx.exception))

        self_cycle = [node("a", depends_on=["a"])]
        with self.assertRaises(ValueError) as ctx:
            topological_order(self_cycle)
        self.assertIn("contains a cycle", str(ctx.exception))

    def test_missing_dependency_raises(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            topological_order([node("a", depends_on=["ghost"])])
        self.assertIn("depends on unknown node 'ghost'", str(ctx.exception))

    def test_duplicate_id_raises(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            topological_order([node("a"), node("a")])
        self.assertIn("duplicate node id 'a'", str(ctx.exception))

    def test_malformed_nodes_raise(self) -> None:
        with self.assertRaises(ValueError):
            topological_order(["not an object"])  # type: ignore[list-item]
        with self.assertRaises(ValueError):
            topological_order([{"subagent": "w"}])
        with self.assertRaises(ValueError):
            topological_order([node("a", depends_on="b")])  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            topological_order([node("a", inputs="b")])  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            topological_order([node("a", inputs=["not an object"])])  # type: ignore[list-item]
        with self.assertRaises(ValueError):
            topological_order([node("a", inputs=[{"name": "i", "type": "text", "from": "nodot"}])])

    def test_stable_order_uses_input_position(self) -> None:
        nodes = [node("b"), node("c"), node("a"), node("d")]
        self.assertEqual(topological_order(nodes), ["b", "c", "a", "d"])


class NonQuadraticValidationTest(unittest.TestCase):
    """Review finding: write-time validation must stay linear in the port
    count. A rebuild-and-count duplicate check is quadratic, so a state with
    tens of thousands of ports would block the write."""

    def test_many_outputs_validate_in_linear_time(self) -> None:
        outputs = [{"name": f"o{i}", "type": "text"} for i in range(8000)]
        outputs.append({"name": "o1", "type": "json"})  # a duplicate at the end
        dag = {"nodes": [node("a", outputs=outputs)]}
        started = time.monotonic()
        errors = validate_factory_spec(dag)
        elapsed = time.monotonic() - started
        self.assertEqual(errors, ["node a declares duplicate output name 'o1'"])
        self.assertLess(elapsed, 2.0)

    def test_many_inputs_from_one_source_validate_in_linear_time(self) -> None:
        source = node("src", outputs=[{"name": f"o{i}", "type": "text"} for i in range(3000)])
        inputs = [{"name": f"i{i}", "type": "text", "from": f"src.o{i}"} for i in range(3000)]
        inputs.append({"name": "i1", "type": "text", "from": "src.o1"})  # duplicate input name
        dag = {"nodes": [source, node("dst", inputs=inputs)]}
        started = time.monotonic()
        errors = validate_factory_spec(dag)
        elapsed = time.monotonic() - started
        self.assertEqual(errors, ["node dst declares duplicate input name 'i1'"])
        self.assertLess(elapsed, 2.0)

    def test_many_duplicate_outputs_report_once(self) -> None:
        # The duplicate report is deduplicated too: every repeat of one
        # name produces exactly one error sentence.
        outputs = [{"name": "dup", "type": "text"} for _ in range(500)]
        dag = {"nodes": [node("a", outputs=outputs)]}
        self.assertEqual(validate_factory_spec(dag), ["node a declares duplicate output name 'dup'"])


class ChildNameTest(unittest.TestCase):
    def test_short_state_ids_keep_their_slug(self) -> None:
        name = _child_name("0123456789abcdef", "collect", 0, 1)
        self.assertEqual(name, "sw-collect-012345-i0")
        self.assertLessEqual(len(name), 64)

    def test_long_state_ids_disambiguate_with_a_digest(self) -> None:
        # Review finding: truncating the state id to 20 characters made two
        # states sharing a prefix collide on the supervisor's unique
        # sibling-name requirement; the token now carries a digest of the
        # full id.
        one = _child_name("0123456789abcdef", "collect-findings-pass-one", 0, 1)
        two = _child_name("0123456789abcdef", "collect-findings-pass-two", 0, 1)
        self.assertNotEqual(one, two)
        self.assertLessEqual(len(one), 64)
        self.assertLessEqual(len(two), 64)
        # The instance index and the attempt disambiguate re-spawns.
        self.assertNotEqual(_child_name("r", "collect", 0, 1), _child_name("r", "collect", 1, 1))
        self.assertTrue(_child_name("r", "collect", 0, 2).endswith("-a2"))


class SpawnLabelTest(unittest.TestCase):
    """The configured inline subagent name labels spawned children run-scoped.

    Every machine child label carries the run id prefix: the supervisor's
    sibling names are per-parent-session, and a parent session outlives
    its runs, so a verbatim configured name would collide with a prior
    run's settled children (they stay registered for the run's life) —
    the M1 unresolvable-pause class. Later instances and retries keep the
    generated label's -i<n>/-a<n> suffixes, because the supervisor rejects
    duplicate sibling names. (Macroscope review finding: the name was
    dropped, so every child got the generated label.)
    """

    def test_configured_name_labels_the_first_instance_run_scoped(self) -> None:
        self.assertEqual(
            _spawn_label("reviewer", "0123456789abcdef", "reviewing", 0, 1),
            "012345-reviewer",
        )

    def test_two_runs_of_one_machine_never_share_a_label(self) -> None:
        # M1: machine child names are supervisor-global across runs; the
        # run prefix keeps two runs of the same machine from colliding on
        # the supervisor's unique sibling-name requirement.
        one = _spawn_label("impl-build", "0123456789abcdef", "implement", 0, 1)
        two = _spawn_label("impl-build", "fedcba9876543210", "implement", 0, 1)
        self.assertEqual(one, "012345-impl-build")
        self.assertEqual(two, "fedcba-impl-build")
        self.assertNotEqual(one, two)

    def test_configured_name_keeps_the_generated_suffixes_when_disambiguating(self) -> None:
        self.assertEqual(_spawn_label("reviewer", "r", "reviewing", 1, 1), "r-reviewer-i1")
        self.assertEqual(_spawn_label("reviewer", "r", "reviewing", 0, 2), "r-reviewer-a2")
        self.assertEqual(_spawn_label("reviewer", "r", "reviewing", 2, 3), "r-reviewer-i2-a3")
        self.assertNotEqual(
            _spawn_label("reviewer", "r", "reviewing", 0, 1), _spawn_label("reviewer", "r", "reviewing", 1, 1)
        )

    def test_absent_configured_name_falls_back_to_the_generated_label(self) -> None:
        self.assertEqual(
            _spawn_label(None, "0123456789abcdef", "collect", 0, 1),
            _child_name("0123456789abcdef", "collect", 0, 1),
        )

    def test_suffixed_labels_stay_within_the_host_cap(self) -> None:
        # The run prefix costs 7 characters of the 64-character cap, so a
        # long configured name never appears verbatim: a label that would
        # pass the cap shrinks its base with a digest of the full prefixed
        # name, like the generated labels do (Macroscope and Cursor review
        # findings: the overflow would fail every later spawn admission).
        long_name = "x" * SUBAGENT_NAME_MAX_LENGTH
        prefixed_base = f"r-{long_name}"
        digest = hashlib.sha256(prefixed_base.encode("utf-8")).hexdigest()[:16]
        first = _spawn_label(long_name, "r", "a", 0, 1)
        self.assertLessEqual(len(first), SUBAGENT_NAME_MAX_LENGTH)
        self.assertIn(digest, first)
        second = _spawn_label(long_name, "r", "a", 1, 1)
        self.assertLessEqual(len(second), SUBAGENT_NAME_MAX_LENGTH)
        self.assertTrue(second.endswith("-i1"))
        self.assertIn(digest, second)
        # Truncation alone could collide (two long names sharing the
        # prefix): the digest keeps them distinct.
        sharing_prefix = "x" * (SUBAGENT_NAME_MAX_LENGTH - 1) + "y"
        other = _spawn_label(sharing_prefix, "r", "a", 1, 1)
        self.assertNotEqual(second, other)
        self.assertLessEqual(len(other), SUBAGENT_NAME_MAX_LENGTH)
        # Retry suffixes and both suffixes together fit as well.
        for instance_index, attempt in ((0, 2), (9, 12), (1000000, 99)):
            self.assertLessEqual(
                len(_spawn_label(long_name, "r", "a", instance_index, attempt)),
                SUBAGENT_NAME_MAX_LENGTH,
                (instance_index, attempt),
            )


class FactoryHelpTest(unittest.TestCase):
    """rlm.factory.help(): the embedded authoring reference (PR #3199).

    The full agent-facing reference — authoring rules, guards/joins/cycles,
    foreach, budgets, stall detectors, and the API with worked examples —
    is a module-level constant in rlm/factory.py; ``help()`` returns it
    with no filesystem resolution, so packaged kernels (where the repo
    layout is not adjacent) see the same guide.
    """

    def test_factory_help_returns_the_full_reference(self) -> None:
        doc = rlm_module.rlm.factory.help()
        self.assertIsInstance(doc, str)
        # help() returns the embedded constant, never a filesystem read.
        self.assertEqual(doc, factory_module.FACTORY_HELP)

        # The shipped section structure: store, author, dag sugar, run, safety.
        for heading in (
            "# Factory",
            "## Store the spec",
            "## Authoring reference",
            "## Dag form",
            "## Run and steer",
            "## Safety",
        ):
            self.assertIn(heading, doc)

        # Prose sections wrap at ~76 columns; flatten before matching phrases.
        flat = " ".join(doc.split())
        # The opt-in contract in the opening: disabled by default, the
        # /factory on|off|status pointer, the exact refusal, and help()
        # readable while disabled.
        self.assertIn("The factory is opt-in: it ships disabled", flat)
        self.assertIn("`/factory on` (`/factory off` disables it again, `/factory status` reports it;", flat)
        self.assertIn("the persisted setting is `factory.enabled` in the agent dir's settings.json", flat)
        self.assertIn("every `rlm.factory` call except `help()`", flat)
        self.assertIn("every factory harness write (`create_factory` and updates of factory entries)", flat)
        self.assertIn(factory_module.FACTORY_DISABLED_MESSAGE, flat)
        self.assertIn("`help()` answers while disabled", flat)
        # Guards: the op set evaluated over the from-state's latest settle.
        self.assertIn("`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`", flat)
        self.assertIn("over the from-state's latest settle", flat)
        # foreach: one child per item of the named json input, clamped at max.
        self.assertIn('**foreach**: `{"over": "<input>", "max": 1..256}`', flat)
        self.assertIn("expands one entry into one child per item of the named `json` input", flat)
        # max_parallel is the run's global budget, not a per-node limit.
        self.assertIn(
            "`run.max_parallel` (1..64, default 8) is the run's global budget of "
            "simultaneously running instances",
            flat,
        )
        self.assertIn("not a per-node limit", flat)
        # Stall detectors: dead configurations fail loudly, never wedge.
        self.assertIn("Dead configurations fail loudly, never wedge", flat)
        self.assertIn("nothing in flight and nothing pending", flat)
        # The stop/resume contract.
        self.assertIn("`stop(run_id)` cancels every running child of the run (idempotent)", flat)
        self.assertIn("`resume(run_id)` continues a paused run and raises on a non-paused one", flat)

        # The run/status snippet, as the agent types it.
        self.assertIn('result = await rlm.factory.run("pr-manager")', doc)
        self.assertIn('status = await rlm.factory.status(result["run_id"])', doc)

        # The worked examples bound their emitted payloads — captured answers
        # are capped previews (~160-200 chars), so an unbounded json payload
        # would truncate at the cap and fail to bind.
        self.assertIn('findings": ["at most three one-line findings"]', doc)
        self.assertIn("capped at the eight most relevant", doc)
        self.assertIn("an unbounded payload truncates at the cap and fails to bind", flat)

        # The Discovery section ships the machine library as present (this
        # branch merges it): the bundled location, the seed names, the CLI
        # surface, and the run-from-library fallback — every phrase
        # fact-checked against the machine-library code (parse/import
        # gate/run fallback).
        self.assertIn(
            "The machine library: machines are `MACHINE.md` files (frontmatter plus "
            "one fenced `machine-spec` block), one directory per machine, resolved "
            "from two levels — the bundled seeds shipped inside the runtime "
            "(visible in every install; `PRIME_AGENT_MACHINES_DIR` redirects the "
            "level at a team directory) first, the personal `machines/` library "
            "under the agent dir second",
            flat,
        )
        self.assertIn(
            "`prime-agent factory list | import | export` manages them: list shows "
            "only what parses and validates (broken files print as warnings), "
            "import runs the same write-time validation as a stored spec so an "
            "invalid machine never persists, and export copies a library machine "
            "verbatim to a fresh path (an existing target is refused, never "
            "overwritten)",
            flat,
        )
        self.assertIn(
            "`rlm.factory.run('<name>')` runs a library machine directly without "
            "creating a harness entry; a machine that exists but is broken names "
            "its errors instead of pretending the name is unknown",
            flat,
        )
        self.assertIn(
            "The bundled seeds are `builder`, `pr-manager`, and `review-sweep`", flat
        )

        # The configured inline subagent name contract.
        self.assertIn("The optional `name` labels the spawned children", flat)
        self.assertIn("the spawn label is `<run6>-name`", flat)
        self.assertIn("unique across the machine's states", flat)
        self.assertIn("a name another state's name can suffix onto, `foo` vs `foo-i1`, is rejected at write time", flat)

    def test_help_advertises_only_calls_the_namespace_has(self) -> None:
        # The guide and the namespace MUST agree exactly: every dotted
        # `rlm.factory.<call>(...)` example the guide teaches must exist as
        # an attribute on the namespace, or an agent following the returned
        # reference hits an AttributeError (Macroscope review finding: the
        # guide advertised watch()/graph() that the namespace did not carry;
        # they arrive with the stacked live-view PR).
        doc = rlm_module.rlm.factory.help()
        flat = " ".join(doc.split())
        advertised = sorted(set(re.findall(r"rlm\.factory\.(\w+)\(", doc)))
        namespace = rlm_module.rlm.factory
        missing = [name for name in advertised if not hasattr(namespace, name)]
        self.assertEqual(missing, [])
        # The core calls stay advertised (dotted examples) and the whole
        # namespace surface stays implemented. This branch IS the stacked
        # live-view PR: it ships the graph()/watch() implementations, so
        # the guide teaches them as call examples and the namespace
        # carries them (the same invariant the core pins on its own tree,
        # which trims them because its namespace stops at resume()).
        for name in ("run", "status", "stop", "graph", "watch"):
            self.assertIn(name, advertised)
        for name in ("run", "status", "stop", "resume", "help", "graph", "watch"):
            self.assertTrue(hasattr(namespace, name), name)


# ---------------------------------------------------------------------------
# The opt-in settings seam: `factory.enabled` in the agent-dir settings file
# ---------------------------------------------------------------------------


class FactorySettingReadTest(unittest.TestCase):
    """The settings seam behind the opt-in gate.

    The gate resolves the agent dir the way the rest of the runtime does and
    reads the same nested-camelCase settings document the daemon and TUI
    settings surface write. The read is lenient like the Rust loader
    (wrong-typed values read as unset) and fail-closed (a missing or corrupt
    document leaves the factory disabled, never a crash).
    """

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.settings_path = Path(temp.name) / "settings.json"
        previous = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = str(Path(temp.name))

        def restore() -> None:
            if previous is None:
                os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
            else:
                os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = previous

        self.addCleanup(restore)

    def write_settings(self, document: Any) -> None:
        self.settings_path.write_text(json.dumps(document), encoding="utf-8")

    def test_round_trips_the_real_settings_document_shape(self) -> None:
        # A settings file as the daemon writes it: flat camelCase keys and
        # nested feature objects (agentTraces/telemetry/terminal); the
        # factory key is shaped exactly like the other feature toggles.
        # /factory on writes enabled true over the same document...
        document = {
            "defaultProvider": "prime-inference",
            "defaultModel": "internal/glm-5.3-fast",
            "rlmMaxDepth": 2,
            "theme": "dark",
            "agentTraces": {"enabled": False},
            "telemetry": {"enabled": None, "noticeShown": True},
            "terminal": {"showImages": True},
            "factory": {"enabled": True},
        }
        self.write_settings(document)
        self.assertTrue(factory_module.factory_enabled())
        # ...and /factory off writes enabled false, leaving the rest intact.
        document["factory"] = {"enabled": False}
        self.write_settings(document)
        self.assertFalse(factory_module.factory_enabled())

    def test_missing_or_wrong_typed_settings_read_as_disabled(self) -> None:
        # No settings file at all: the shipped default is off.
        self.assertFalse(factory_module.factory_enabled())
        # A settings document without the factory key is the same default.
        self.write_settings({})
        self.assertFalse(factory_module.factory_enabled())
        # Wrong-typed values read as unset, like the lenient Rust loader.
        for document in (
            {"factory": None},
            {"factory": "enabled"},
            {"factory": {"enabled": None}},
            {"factory": {"enabled": "true"}},
            {"factory": {"enabled": 1}},
        ):
            self.write_settings(document)
            self.assertFalse(factory_module.factory_enabled(), str(document))
        # An enabled object with unknown sibling keys still reads enabled.
        self.write_settings({"factory": {"enabled": True, "extra": "ignored"}})
        self.assertTrue(factory_module.factory_enabled())
        # A corrupt document fails closed: a clean refusal, never a crash.
        self.settings_path.write_text("{ not json", encoding="utf-8")
        self.assertFalse(factory_module.factory_enabled())


# ---------------------------------------------------------------------------
# Executor test infrastructure
# ---------------------------------------------------------------------------


def async_test(coroutine):
    """Run one async test method on a fresh event loop."""

    def wrapper(self):
        return asyncio.run(coroutine(self))

    wrapper.__name__ = coroutine.__name__
    return wrapper


async def yield_loop_turn() -> None:
    """Yield one event-loop turn: cooperative, with no wall-clock wait."""
    resumed = asyncio.Event()
    asyncio.get_running_loop().call_soon(resumed.set)
    await resumed.wait()


class FakeClock:
    """Injectable monotonic clock with optional per-collect advancement."""

    def __init__(self, start: float = 1000.0, advance_per_collect: float = 0.0) -> None:
        self.now = start
        self.advance_per_collect = advance_per_collect

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class ClockSleep:
    """Injectable sleep that records delays and advances the fake clock.

    Real sleep passes wall-clock time, so a recorded backoff slice also moves
    the injected clock: a control loop waiting out a backoff deadline makes
    progress without a real wait.
    """

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.sleeps: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.clock.advance(seconds)


async def turn_sleep(seconds: float) -> None:
    """Injectable sleep that really waits (10ms slices, never advancing the
    injected clock): a watch's re-arm loop yields to the event loop between
    slices, so a concurrent mutation lands mid-wait."""
    await asyncio.sleep(0.01)


class GatedSleep:
    """Injectable sleep that suspends every call until released."""

    def __init__(self) -> None:
        self.sleeps: list[float] = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.entered.set()
        await self.release.wait()


def _node_of_name(name: str) -> str:
    """The factory node a spawn name belongs to.

    Generated labels are "sw-<node id>-<run>-..."; a state with a
    configured inline subagent name spawns children labeled
    "<run6>-<configured>" (run-scoped), so a leading 6-hex run prefix keys
    the node by the configured base with any trailing -i<n>/-a<n>
    disambiguation parts stripped (the test machines' configured names
    never end in those shapes).
    """
    parts = name.split("-")
    if parts[0] == "sw" and len(parts) > 2:
        return parts[1]
    if len(parts[0]) == 6 and all(char in "0123456789abcdef" for char in parts[0]):
        base = parts[1:]
        while len(base) > 1 and re.fullmatch(r"i[1-9][0-9]*|a[2-9][0-9]*", base[-1]):
            base = base[:-1]
        return "-".join(base)
    return name


class FakeHost:
    """Deterministic async host_request fake that routes by request type.

    Child names carry the node id as their second dash-separated part (or
    are a state's configured inline subagent name verbatim), so node ids
    in these tests never contain "-". Collect outcomes are
    scripted per child id first (``child_outcomes``), then per node id
    (``outcomes``); a "running" outcome never settles. ``rate_limit_first``
    / ``rate_limit_forever`` make spawn admissions for a node fail with a
    429-style RuntimeError. ``gate("rlm.collect"|"rlm.delete_subagent"|"rlm.run"|"factory.progress", n)``
    suspends the n-th call of that type on an asyncio.Event so tests can
    reproduce races between the control loop and stop()/resume().
    ``advance_per_run`` advances the injected clock on every admission (a
    slow spawn), and ``advance_per_collect`` on every collect poll.
    """

    def __init__(self, clock: FakeClock | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.notices: list[dict[str, Any]] = []
        self.children: dict[str, dict[str, Any]] = {}
        self.counter = 0
        self.collects = 0
        self.clock = clock
        self.advance_per_run: float = 0.0
        self.outcomes: dict[str, dict[str, Any]] = {}
        self.child_outcomes: dict[str, dict[str, Any]] = {}
        self.rate_limit_first: dict[str, int] = {}
        self.rate_limit_forever: set[str] = set()
        self.gates: dict[tuple[str, int], asyncio.Event] = {}
        self.gate_entries: dict[tuple[str, int], asyncio.Event] = {}
        self._call_indices: dict[str, int] = {}

    def gate(self, request_type: str, call_number: int) -> asyncio.Event:
        """Suspend the call_number-th call of that type on a returned event."""
        event = asyncio.Event()
        self.gates[(request_type, call_number)] = event
        self.gate_entries[(request_type, call_number)] = asyncio.Event()
        return event

    def gate_entered(self, request_type: str, call_number: int) -> asyncio.Event:
        return self.gate_entries[(request_type, call_number)]

    def calls_of(self, request_type: str) -> list[dict[str, Any]]:
        return [payload for kind, payload in self.calls if kind == request_type]

    def spawn_calls(self, node_id: str) -> list[dict[str, Any]]:
        return [p for p in self.calls_of("rlm.run") if _node_of_name(p["kwargs"]["name"]) == node_id]

    def deleted_targets(self) -> list[str]:
        return [p["target"] for p in self.calls_of("rlm.delete_subagent")]

    def notice_kinds(self) -> list[str]:
        return [notice["kind"] for notice in self.notices]

    @staticmethod
    def _entry(
        *,
        child_id: str,
        name: str,
        status: str,
        settled: bool,
        answer: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "rlm_child_id": child_id,
            "session_name": name,
            "session_dir": f"/tmp/{child_id}",
            "status": status,
            "settled": settled,
            "tool_use_count": 1,
            "duration_ms": 5,
        }
        if answer is not None:
            # The real host hands the kernel a compact preview (about 160
            # characters, whitespace-collapsed, ellipsis tail) plus the
            # FULL final answer as the collect envelope's binding lane;
            # the fake mirrors both, so a long fenced JSON binds from the
            # full lane exactly like production.
            compact = " ".join(answer.split())
            entry["answer_preview"] = (
                compact[:HOST_ANSWER_PREVIEW_CHARS - 3] + "..."
                if len(compact) > HOST_ANSWER_PREVIEW_CHARS
                else compact
            )
            entry["answer_text"] = answer
        if error is not None:
            entry["error"] = error
        return entry

    async def __call__(self, request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        gate = None
        if request_type in ("rlm.collect", "rlm.delete_subagent", "rlm.run", "factory.progress"):
            index = self._call_indices.get(request_type, 0) + 1
            self._call_indices[request_type] = index
            gate = self.gates.pop((request_type, index), None)
            if gate is not None:
                entry_event = self.gate_entries.pop((request_type, index), None)
                if entry_event is not None:
                    entry_event.set()
        if gate is not None:
            await gate.wait()
        if request_type == "rlm.run":
            # Count this node's prior admission calls before recording the
            # current one, so rate_limit_first<n> fails exactly the first n.
            name = payload["kwargs"]["name"]
            node_id = _node_of_name(name)
            # The supervisor rejects duplicate sibling names: a prior run's
            # settled children stay registered, so a same-name admission
            # fails exactly like the real host (the M1 class).
            if any(child["name"] == name for child in self.children.values()):
                raise RuntimeError(
                    f'Agent name "{name}" is unavailable: an agent of that '
                    "name already exists at depth 1 under this parent"
                )
            attempted = len(
                [
                    p
                    for kind, p in self.calls
                    if kind == "rlm.run" and _node_of_name(p["kwargs"]["name"]) == node_id
                ]
            )
            self.calls.append((request_type, payload))
            if self.clock is not None:
                self.clock.advance(self.advance_per_run)
            limit = self.rate_limit_first.get(node_id, 0) + (999 if node_id in self.rate_limit_forever else 0)
            if attempted < limit:
                raise RuntimeError("429 rate limit exceeded")
            self.counter += 1
            child_id = f"child-{self.counter}"
            self.children[child_id] = {"name": name, "node": node_id}
            return {
                "rlm_child_id": child_id,
                "name": name,
                "session_dir": f"/tmp/{child_id}",
                "model": "fake-model",
            }
        self.calls.append((request_type, payload))
        if request_type == "rlm.collect":
            self.collects += 1
            if self.clock is not None:
                self.clock.advance(self.clock.advance_per_collect)
            results = []
            for target in payload["targets"]:
                child = self.children.get(target)
                if child is None:
                    continue  # deleted children vanish from collect results
                outcome = (
                    self.child_outcomes.get(target)
                    or self.outcomes.get(child["node"])
                    or {"status": "done", "answer": f"answer-{child['node']}"}
                )
                if outcome["status"] == "running":
                    results.append(
                        self._entry(child_id=target, name=child["name"], status="running", settled=False)
                    )
                    continue
                results.append(
                    self._entry(
                        child_id=target,
                        name=child["name"],
                        status=outcome["status"],
                        settled=True,
                        answer=outcome.get("answer"),
                        error=outcome.get("error"),
                    )
                )
            return {"results": results}
        if request_type == "rlm.delete_subagent":
            target = payload["target"]
            child = self.children.pop(target, None)
            # The real host's delete receipt reports the row as cancelled
            # (a live child's delete settles it cancelled), so the kernel's
            # payload validation sees the same shape it sees in production.
            return {
                "subagent": {
                    "rlm_child_id": target,
                    "session_name": child["name"] if child else "unknown",
                    "session_dir": f"/tmp/{target}",
                    "status": "cancelled",
                },
                "outcome": "deleted",
            }
        if request_type == "factory.progress":
            self.notices.append(payload)
            return {}
        raise AssertionError(f"unexpected host request type {request_type!r}")


class DeleteFailsHost(FakeHost):
    """FakeHost whose rlm.delete_subagent always raises."""

    async def __call__(self, request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if request_type == "rlm.delete_subagent":
            self.calls.append((request_type, payload or {}))
            raise RuntimeError("delete_subagent: child already gone")
        return await super().__call__(request_type, payload)


class LateAnswerHost(FakeHost):
    """FakeHost whose FIRST collect of a late child settles it with no
    captured answer (the host-side capture race); later collects return
    the real answer."""

    def __init__(self, clock: "FakeClock | None" = None, late_children: "set[str] | frozenset[str]" = frozenset()):
        super().__init__(clock=clock)
        self.late_children = set(late_children)
        self.collects_of: dict[str, int] = {}

    async def __call__(self, request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        if request_type == "rlm.collect":
            late = [t for t in payload["targets"] if t in self.late_children and self.collects_of.get(t, 0) == 0]
            if late:
                for target in late:
                    self.collects_of[target] = self.collects_of.get(target, 0) + 1
                self.calls.append((request_type, payload))
                self.collects += 1
                if self.clock is not None:
                    self.clock.advance(self.clock.advance_per_collect)
                return {
                    "results": [
                        self._entry(
                            child_id=target,
                            name=self.children[target]["name"],
                            status="done",
                            settled=True,
                        )
                        for target in late
                    ]
                }
        return await super().__call__(request_type, payload)


class DeadNoticeHost(FakeHost):
    """FakeHost whose factory.progress bridge is dead (every call raises)."""

    async def __call__(self, request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if request_type == "factory.progress":
            self.calls.append((request_type, payload or {}))
            raise RuntimeError("bridge dead")
        return await super().__call__(request_type, payload)


# ---------------------------------------------------------------------------
# Executor tests
# ---------------------------------------------------------------------------


class _ExecutorTestCase(unittest.TestCase):
    """The scripted in-memory kernel every executor test runs against.

    A temp-dir harness with a real subagent entry, an injected clock and
    sleeps, a ``FakeHost`` behind the ``host_request`` patch seam, and the
    per-test default executor. The factory opt-in gate reads the
    ``factory.enabled`` setting from the agent dir's settings file, so the
    agent dir points at a temp dir whose settings file the tests write in
    the real document shape the daemon writes (``{"factory": {"enabled":
    true}}``); every executor test then runs through the live gate with the
    setting on, and the opt-in gate tests flip the file per case.
    """

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.harness = HarnessState(Path(temp.name) / "harness_state.json")
        self.harness.create_subagent("Worker", "Do the work carefully.", id="worker")
        self.clock = FakeClock()
        self.host = FakeHost(clock=self.clock)
        self.sleeps = ClockSleep(self.clock)
        self.executor = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        previous_executor = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = self.executor
        self.addCleanup(lambda: setattr(factory_module, "_DEFAULT_EXECUTOR", previous_executor))
        # The fake is an async callable: patch it in directly (AsyncMock does
        # not await async side effects), which preserves the patch seam.
        patcher = patch.object(rlm_module, "host_request", self.host)
        patcher.start()
        self.addCleanup(patcher.stop)
        agent_temp = TemporaryDirectory()
        self.addCleanup(agent_temp.cleanup)
        self.settings_path = Path(agent_temp.name) / "settings.json"
        self.write_settings({"factory": {"enabled": True}})
        self._isolate_agent_dir(agent_temp.name)

    def write_settings(self, document: Any) -> None:
        """Write the agent-dir settings document (the real file shape)."""
        self.settings_path.write_text(json.dumps(document), encoding="utf-8")

    def _isolate_agent_dir(self, agent_dir: str) -> None:
        previous = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = agent_dir

        def restore() -> None:
            if previous is None:
                os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
            else:
                os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = previous

        self.addCleanup(restore)

    def disable_factory(self) -> None:
        """Flip the settings file to the disabled default."""
        self.write_settings({"factory": {"enabled": False}})

    # -- helpers shared with the opt-in gate tests ----------------------------

    def store_factory(self, dag: dict[str, Any], spec_id: str = "sw") -> None:
        self.harness.create_factory("Factory", "Factory content", id=spec_id, dag=dag)

    def store_machine(self, machine: dict[str, Any], spec_id: str = "sw") -> None:
        self.harness.create_factory("Factory", "Factory content", id=spec_id, machine=machine)

    def node(self, node_id: str, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {"id": node_id, "subagent": "worker"}
        base.update(overrides)
        return base

    async def start(self, spec_id: str = "sw") -> dict[str, Any]:
        return await rlm_module.rlm.factory.run(spec_id)


class FactoryOptInGateTest(_ExecutorTestCase):
    """The opt-in gate: `factory.enabled` (default off) closes the namespace.

    The factory ships disabled; the user turns it on with /factory on (the
    persisted `factory.enabled` setting in the agent dir's settings.json).
    While it is off, every rlm.factory call except help() and every factory
    harness write refuses with ONE exact message, and nothing starts or
    persists behind the refusal.
    """

    # -- namespace gate --------------------------------------------------------

    @async_test
    async def test_run_proceeds_when_the_enabled_setting_is_written(self) -> None:
        self.store_factory({"nodes": [self.node("a")]}, spec_id="sw")
        result = await self.start()
        self.assertIn("run_id", result)
        self.assertEqual(result["started"], ["a"])
        self.assertTrue(self.host.calls)

    @async_test
    async def test_empty_settings_refuse_run_with_the_exact_message(self) -> None:
        self.store_factory({"nodes": [self.node("a")]}, spec_id="sw")
        # An empty settings document: the factory key absent reads as the
        # disabled default, and the refusal precedes any spec resolution.
        self.write_settings({})
        with self.assertRaises(ValueError) as raised:
            await self.start()
        self.assertEqual(str(raised.exception), "the factory is disabled; run /factory on to enable it")
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        self.assertEqual(self.host.calls, [])
        # No settings file at all is the same disabled default.
        self.settings_path.unlink()
        with self.assertRaises(ValueError) as raised:
            await self.start()
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_status_stop_and_resume_refuse_with_the_exact_message(self) -> None:
        self.store_factory({"nodes": [self.node("a")]}, spec_id="sw")
        result = await self.start()
        run_id = result["run_id"]
        self.disable_factory()
        for call in (
            rlm_module.rlm.factory.status(run_id),
            rlm_module.rlm.factory.stop(run_id),
            rlm_module.rlm.factory.resume(run_id),
        ):
            with self.assertRaises(ValueError) as raised:
                await call
            self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)

    @async_test
    async def test_graph_and_watch_refuse_with_the_exact_message(self) -> None:
        self.store_factory({"nodes": [self.node("a")]}, spec_id="sw")
        result = await self.start()
        run_id = result["run_id"]
        self.disable_factory()
        for call in (
            rlm_module.rlm.factory.graph(run_id),
            rlm_module.rlm.factory.graph(),
            rlm_module.rlm.factory.graph("sw"),
            rlm_module.rlm.factory.watch(run_id, 0.5),
        ):
            with self.assertRaises(ValueError) as raised:
                await call
            self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)

    @async_test
    async def test_the_activity_lane_refuses_while_disabled(self) -> None:
        # The daemon stops advertising the lane while the factory is off;
        # the kernel seam fails closed behind the advertisement: a stale
        # client that still speaks the lane gets the one refusal on every
        # action -- run included, which would otherwise bypass the
        # namespace's gate.
        self.store_factory({"nodes": [self.node("a")]}, spec_id="sw")
        result = await self.start()
        run_id = result["run_id"]
        self.disable_factory()
        for action in ("graph", "watch", "status", "run", "stop", "resume"):
            request: dict[str, Any] = {"action": action}
            if action in ("graph", "watch", "status", "stop", "resume"):
                request["runId"] = run_id
            if action == "run":
                request["specId"] = "sw"
            with self.assertRaises(ValueError) as raised:
                await self.executor.activity(request)
            self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)

    def test_help_answers_while_disabled(self) -> None:
        self.disable_factory()
        doc = rlm_module.rlm.factory.help()
        self.assertEqual(doc, factory_module.FACTORY_HELP)
        self.assertIn("The factory is opt-in", doc)

    # -- harness write gate ----------------------------------------------------

    def test_create_factory_refuses_while_disabled(self) -> None:
        self.disable_factory()
        with self.assertRaises(ValueError) as raised:
            self.harness.create_factory("Factory", "Never stores.", id="sw", dag={"nodes": [self.node("a")]})
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        self.assertEqual(self.harness.list("factory"), [])
        # The refusal precedes spec validation: an invalid spec never gets
        # the spec error while the factory is off, only the one message.
        with self.assertRaises(ValueError) as raised:
            self.harness.create_factory("Broken", "Never stores.", id="bad", dag={"nodes": []})
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        self.assertEqual(self.harness.list("factory"), [])
        # The generic create path refuses identically.
        with self.assertRaises(ValueError) as raised:
            self.harness.create(
                "factory",
                "Generic",
                "content",
                id="generic",
                arguments={"dag": {"nodes": [self.node("a")]}},
            )
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        self.assertEqual(self.harness.list("factory"), [])

    def test_factory_entry_updates_refuse_while_disabled(self) -> None:
        self.store_factory({"nodes": [self.node("a")]}, spec_id="sw")
        self.disable_factory()
        with self.assertRaises(ValueError) as raised:
            self.harness.update_factory("sw", "Factory", "content updated")
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        with self.assertRaises(ValueError) as raised:
            self.harness.update("factory", "sw", "Factory", "content updated")
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        with self.assertRaises(ValueError) as raised:
            self.harness.upsert(
                "factory",
                "Factory",
                "content",
                id="upserted",
                arguments={"dag": {"nodes": [self.node("a")]}},
            )
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        # The stored entry is untouched behind the refusals.
        self.assertEqual(self.harness.get("factory", "sw").content, "Factory content")
        self.assertEqual(self.harness.list("factory"), [self.harness.get("factory", "sw")])

    def test_delete_stays_available_while_disabled(self) -> None:
        # Deleting is cleanup, not authoring or execution: the gate list is
        # run/status/stop/resume (and the later graph/watch) plus creates and
        # updates, so an operator can still clear stale entries while off.
        self.store_factory({"nodes": [self.node("a")]}, spec_id="sw")
        self.disable_factory()
        self.assertTrue(self.harness.delete_factory("sw"))
        self.assertIsNone(self.harness.get("factory", "sw"))


class FactoryExecutorTest(_ExecutorTestCase):

    # -- helpers -------------------------------------------------------------

    def corrupt_stored_spec(self, spec_id: str, spec: Any, *, key: str = "dag") -> None:
        """Bypass write-time validation the way a hand-edited or foreign
        store would: mutate the stored entry's spec in memory."""
        entry = self.harness.get("factory", spec_id)
        entry.arguments = {key: spec}

    def state_report(self, status: dict[str, Any], state_id: str) -> dict[str, Any]:
        return next(entry for entry in status["nodes"] if entry["id"] == state_id)

    def events_of(self, status: dict[str, Any], kind: str) -> list[dict[str, Any]]:
        return [event for event in status["events"] if event["kind"] == kind]

    def all_events_of(self, run_result: dict[str, Any], kind: str) -> list[dict[str, Any]]:
        run = self.executor._runs[run_result["run_id"]]
        return [event for event in run.events if event["kind"] == kind]

    async def settle(self, run_result: dict[str, Any], *, max_polls: int = 50_000) -> dict[str, Any]:
        """Yield to the control loop until the run leaves the running state."""
        run_id = run_result["run_id"]
        for _ in range(max_polls):
            run = self.executor._runs[run_id]
            if run.state != "running":
                return await rlm_module.rlm.factory.status(run_id)
            await yield_loop_turn()
        self.fail(f"run {run_id} never left the running state")

    async def wait_until(self, predicate, *, max_polls: int = 50_000) -> None:
        for _ in range(max_polls):
            if predicate():
                return
            await yield_loop_turn()
        self.fail("condition never became true")

    def node_status(self, status: dict[str, Any], node_id: str) -> dict[str, Any]:
        return next(entry for entry in status["nodes"] if entry["id"] == node_id)

    # -- dry run ---------------------------------------------------------------

    @async_test
    async def test_run_rejects_invalid_dag_and_starts_nothing(self) -> None:
        # Write-time validation blocks create_factory, so corrupt the stored
        # spec in memory (a hand-edited or foreign store) to prove run()
        # re-validates on its own and starts nothing on any failure.
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]}, spec_id="empty")
        self.corrupt_stored_spec("empty", {"nodes": []})
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]}, spec_id="cyclic")
        self.corrupt_stored_spec(
            "cyclic",
            {
                "nodes": [
                    {"id": "a", "subagent": "worker", "depends_on": ["b"]},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ]
            },
        )
        for spec_id in ("empty", "cyclic"):
            with self.assertRaisesRegex(ValueError, "factory"):
                await self.start(spec_id)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_run_lists_all_missing_subagent_references(self) -> None:
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "ghost-a"},
                    {"id": "b", "subagent": "ghost-b"},
                ],
            }
        )
        with self.assertRaises(ValueError) as ctx:
            await self.start()
        self.assertIn("ghost-a", str(ctx.exception))
        self.assertIn("ghost-b", str(ctx.exception))
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_run_rejects_unknown_spec(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown factory spec"):
            await self.start("missing-spec")

    @async_test
    async def test_resolves_subagent_by_id_and_title_with_model_settings(self) -> None:
        self.harness.create_subagent(
            "The Worker",
            "Template by title.",
            id="worker-md",
            metadata={"model": "pi/test-model", "thinking": "low"},
        )
        self.store_factory(
            {
                "run": {"max_parallel": 2},
                "nodes": [
                    {"id": "x", "subagent": "The Worker"},
                    {"id": "y", "subagent": "worker-md"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        for node_id in ("x", "y"):
            spawn = self.host.spawn_calls(node_id)
            self.assertEqual(len(spawn), 1, node_id)
            self.assertEqual(spawn[0]["prompt"], "Template by title.")
            self.assertEqual(spawn[0]["kwargs"]["model"], "pi/test-model")
            self.assertEqual(spawn[0]["kwargs"]["thinking"], "low")

    @async_test
    async def test_inline_subagent_name_labels_the_spawned_child(self) -> None:
        # Macroscope review finding: the inline subagent name was dropped by
        # _resolve_subagents, so the child spawned with the generated label
        # instead of the configured name. The name rides through run creation
        # to the spawn call (run-scoped: prefixed with the run id), and the
        # spawned event's ledger entry carries the same label — the label
        # agents message the child by.
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": {"prompt": "Do the review.", "name": "reviewer"}},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        label = f"{result['run_id'][:6]}-reviewer"
        self.assertEqual(
            [p["kwargs"]["name"] for p in self.host.calls_of("rlm.run")],
            [label],
        )
        self.assertEqual(
            [event["name"] for event in self.all_events_of(result, "spawned")],
            [label],
        )

    @async_test
    async def test_two_runs_of_one_machine_do_not_collide_on_child_names(self) -> None:
        # M1: machine child names are supervisor-global across runs — a
        # prior run's settled children stay registered for the run's life
        # (and forever when their delete failed), so a verbatim configured
        # name made a fresh run's spawn admission fail with "Agent name ...
        # is unavailable" and the machine paused at spawn-zero. The
        # run-scoped label prefix keeps run 2's admissions unique; the
        # FakeHost rejects duplicate sibling names exactly like the real
        # supervisor, so this test fails without the prefix.
        self.host.outcomes["impl"] = {"status": "done", "answer": "IMPL"}
        self.host.outcomes["check"] = {"status": "done", "answer": "CHECK"}
        self.store_machine(
            {
                "run": {"failure_policy": "escalate", "max_parallel": 4},
                "states": [
                    {
                        "id": "impl",
                        "entry": True,
                        "subagent": {"prompt": "Build.", "name": "impl-build"},
                        "outputs": [{"name": "built", "type": "text"}],
                    },
                    {
                        "id": "check",
                        "subagent": "worker",
                        "inputs": [{"name": "built", "type": "text", "from": "impl.built"}],
                    },
                ],
                "transitions": [{"from": "impl", "to": "check"}],
            }
        )
        first = await self.start()
        first_status = await self.settle(first)
        self.assertEqual(first_status["state"], "done")
        second = await self.start()
        second_status = await self.settle(second)
        self.assertEqual(second_status["state"], "done")
        # Run 2's children spawn with distinct, run-scoped labels; neither
        # admission collided with run 1's still-registered children.
        first_label = f"{first['run_id'][:6]}-impl-build"
        second_label = f"{second['run_id'][:6]}-impl-build"
        self.assertNotEqual(first_label, second_label)
        self.assertEqual(
            [event["name"] for event in self.all_events_of(first, "spawned") if event["node"] == "impl"],
            [first_label],
        )
        self.assertEqual(
            [event["name"] for event in self.all_events_of(second, "spawned") if event["node"] == "impl"],
            [second_label],
        )
        self.assertEqual(self.all_events_of(second, "node_error"), [])

    @async_test
    async def test_inline_subagent_name_disambiguates_reentry_and_foreach(self) -> None:
        # One state's settled children stay registered for the run's life,
        # and the supervisor rejects duplicate sibling names, so re-entry
        # (max_entries > 1) and foreach fan-out keep the configured prefix
        # with the same -i<n> suffix the generated labels use.
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {
                        "id": "loop",
                        "entry": True,
                        "subagent": {"prompt": "Work.", "name": "worker"},
                        "max_entries": 2,
                    },
                ],
                "transitions": [{"from": "loop", "to": "loop"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        run_prefix = result["run_id"][:6]
        self.assertEqual(
            [p["kwargs"]["name"] for p in self.host.calls_of("rlm.run")],
            [f"{run_prefix}-worker", f"{run_prefix}-worker-i1"],
        )

        self.host.outcomes["src"] = {
            "status": "done",
            "answer": 'Here.\n```json\n{"items": ["one", "two"]}\n```',
        }
        self.host.calls.clear()
        self.host.children.clear()
        self.host.counter = 0
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": {"prompt": "Expand item {items}.", "name": "expander"},
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 4},
                    },
                ],
            },
            spec_id="fan",
        )
        fan_result = await self.start("fan")
        status = await self.settle(fan_result)
        self.assertEqual(status["state"], "done")
        # The first foreach instance keeps the configured name; the second
        # disambiguates with the instance suffix.
        fan_prefix = fan_result["run_id"][:6]
        self.assertEqual(
            [
                p["kwargs"]["name"]
                for p in self.host.calls_of("rlm.run")
                if f"-expander" in p["kwargs"]["name"]
            ],
            [f"{fan_prefix}-expander", f"{fan_prefix}-expander-i1"],
        )

    @async_test
    async def test_run_starts_ready_nodes_and_reports_counts(self) -> None:
        self.store_factory(
            {
                "run": {"max_parallel": 2},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                    {"id": "c", "subagent": "worker", "depends_on": ["b"]},
                    {"id": "d", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        self.assertIn("run_id", result)
        self.assertEqual(result["spec_id"], "sw")
        self.assertEqual(result["nodes"], 4)
        self.assertEqual(result["max_parallel"], 2)
        self.assertEqual(result["started"], ["a", "d"])
        self.assertEqual(result["pending"], ["b", "c"])
        self.assertEqual(len(self.host.calls_of("rlm.run")), 2)
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertTrue(all(entry["status"] == "done" for entry in status["nodes"]))
        self.assertEqual(self.host.notice_kinds(), ["finished"])
        self.assertEqual(status["usage"]["spawns"], 4)
        self.assertEqual(status["usage"]["settled"], 4)

    # -- propagation and binding ------------------------------------------------

    @async_test
    async def test_propagation_binds_answer_into_prompt(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": "ANSWER-A"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Summarize: {draft}"},
                        "depends_on": ["a"],
                        "inputs": [{"name": "draft", "type": "text", "from": "a.out"}],
                    },
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["a"])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        prompts = [call["prompt"] for call in self.host.spawn_calls("b")]
        self.assertEqual(prompts, ["Summarize: ANSWER-A"])
        self.assertEqual(self.node_status(status, "b")["answer_preview"], "answer-b")

    @async_test
    async def test_json_input_prefers_fenced_block(self) -> None:
        self.host.outcomes["a"] = {
            "status": "done",
            "answer": 'Verdict text.\n```json\n{"result": {"x": 1}}\n```',
        }
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "result", "type": "json"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Process {data}."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "data", "type": "json", "from": "a.result"}],
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        prompts = [call["prompt"] for call in self.host.spawn_calls("b")]
        self.assertEqual(prompts, ['Process {"x": 1}.'])

    @async_test
    async def test_json_input_falls_back_to_whole_text(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": '{"result": 7}'}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "result", "type": "json"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Process {data}."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "data", "type": "json", "from": "a.result"}],
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual([call["prompt"] for call in self.host.spawn_calls("b")], ["Process 7."])

    @async_test
    async def test_bad_json_input_fails_node_without_spawning(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": "not json at all"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "result", "type": "json"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Process {data}."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "data", "type": "json", "from": "a.result"}],
                    },
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # b failed at binding (continue policy): never spawned, marked error;
        # c still ran and finished, so the run completes but reports failed.
        self.assertEqual(self.host.spawn_calls("b"), [])
        b = self.node_status(status, "b")
        self.assertEqual(b["status"], "error")
        self.assertIn("no JSON object containing output", b["error"])
        self.assertEqual(self.node_status(status, "c")["status"], "done")
        self.assertEqual(status["state"], "failed")

    @async_test
    async def test_unplaced_inputs_are_appended(self) -> None:
        self.host.outcomes["a"] = {"status": "done", "answer": "ANSWER-A"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "No placeholders here."},
                        "depends_on": ["a"],
                        "inputs": [{"name": "draft", "type": "text", "from": "a.out"}],
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("b")],
            ["No placeholders here.\n\n## Inputs\n- draft: ANSWER-A\n"],
        )

    @async_test
    async def test_two_parent_fan_in_binds_both_answers(self) -> None:
        # Both parents settle in one collect batch; the join must fire ONCE
        # (not once per source settle) and bind both captured answers into a
        # single prompt.
        self.host.outcomes["a"] = {"status": "done", "answer": "ANSWER-A"}
        self.host.outcomes["b"] = {"status": "done", "answer": "ANSWER-B"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {"id": "b", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {
                        "id": "c",
                        "subagent": {"prompt": "Combine {left} and {right}."},
                        "depends_on": ["a", "b"],
                        "inputs": [
                            {"name": "left", "type": "text", "from": "a.out"},
                            {"name": "right", "type": "text", "from": "b.out"},
                        ],
                    },
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["a", "b"])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("c")],
            ["Combine ANSWER-A and ANSWER-B."],
        )
        # the join fired exactly once: one entry, one spawn, nothing blocked
        self.assertEqual(self.state_report(status, "c")["entries_used"], 1)
        self.assertEqual(len(self.host.spawn_calls("c")), 1)
        self.assertEqual(self.all_events_of(result, "transition_blocked"), [])

    @async_test
    async def test_fan_in_waits_for_every_parent_across_batches(self) -> None:
        # Review finding (fan-in compiled as independent transitions): a
        # control-only parent must hold the fan-in node back too. b settles
        # first; d must not enter (nor spawn) until c settles, and it must
        # never run with a missing input.
        self.host.child_outcomes["child-1"] = {"status": "done", "answer": "go"}
        self.host.child_outcomes["child-2"] = {"status": "done", "answer": "ANSWER-B"}
        self.host.child_outcomes["child-3"] = {"status": "running"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {
                        "id": "b",
                        "subagent": "worker",
                        "depends_on": ["a"],
                        "outputs": [{"name": "out", "type": "text"}],
                    },
                    {"id": "c", "subagent": "worker", "depends_on": ["a"]},
                    {
                        "id": "d",
                        "subagent": {"prompt": "Combine {left}."},
                        "depends_on": ["b", "c"],
                        "inputs": [{"name": "left", "type": "text", "from": "b.out"}],
                    },
                ],
            }
        )
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        # b settled, c still running: d must never be entered or spawned.
        await self.wait_until(
            lambda: any(entry.is_settle for entry in run.states["b"].entries)
            and len(self.host.calls_of("rlm.collect")) >= 2
        )
        self.assertEqual(self.host.spawn_calls("d"), [])
        self.assertEqual(
            [e for e in self.all_events_of(result, "state_entry") if e.get("node") == "d"], []
        )
        # c settles now; only then may d run.
        self.host.child_outcomes["child-3"] = {"status": "done", "answer": "ANSWER-C"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("d")],
            ["Combine ANSWER-B."],
        )
        self.assertEqual(self.all_events_of(result, "transition_blocked"), [])
        self.assertEqual(self.state_report(status, "d")["entries_used"], 1)

    @async_test
    async def test_answer_capture_cap_slices_previews(self) -> None:
        long_answer = "x" * 300
        self.host.outcomes["a"] = {"status": "done", "answer": long_answer}
        self.store_factory(
            {
                "nodes": [{"id": "a", "subagent": "worker"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        captured = self.node_status(status, "a")["answer_preview"]
        self.assertEqual(len(captured), ANSWER_CAPTURE_CAP)
        self.assertEqual(captured, long_answer[:ANSWER_CAPTURE_CAP])

    @async_test
    async def test_json_output_longer_than_the_preview_cap_binds_from_the_full_answer(self) -> None:
        # M2: the settle's declared fenced JSON was longer than the host's
        # ~160-character roster preview, so the old preview-only capture
        # truncated it mid-object and the downstream bind failed with "no
        # JSON object containing output" although the child settled with
        # exactly the fenced JSON. The collect envelope's full answer is
        # the binding lane; the preview stays a preview.
        worktree = "/Users/x/Research/pa-worktrees/rp-3354-the-very-long-worktree-name"
        payload = {"worktree": worktree, "notes": "y" * 150}
        long_json = f"Intro prose.\n\n```json\n{json.dumps(payload)}\n```\n\nOutro."
        assert len(long_json) > HOST_ANSWER_PREVIEW_CHARS
        self.host.outcomes["setup"] = {"status": "done", "answer": long_json}
        self.host.outcomes["impl"] = {"status": "done", "answer": "DONE"}
        self.store_machine(
            {
                "run": {"failure_policy": "escalate", "max_parallel": 4},
                "states": [
                    {
                        "id": "setup",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "worktree", "type": "json"}],
                    },
                    {
                        "id": "impl",
                        "subagent": "worker",
                        "inputs": [{"name": "worktree", "type": "json", "from": "setup.worktree"}],
                    },
                ],
                "transitions": [{"from": "setup", "to": "impl"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        impl_prompt = self.host.spawn_calls("impl")[0]["prompt"]
        self.assertIn(f"- worktree: {json.dumps(worktree)}", impl_prompt)
        self.assertEqual(self.all_events_of(result, "output_capture_failed"), [])
        # The event ledger previews compactly; the binding lane stays full:
        # the captured answer is the raw final text (newlines intact), not
        # the host's whitespace-collapsed roster preview.
        captured_event = self.all_events_of(result, "answer_captured")[0]
        self.assertLessEqual(len(captured_event["answer"]), ANSWER_CAPTURE_CAP)
        self.assertIn("```json\n", captured_event["answer"])
        self.assertNotIn("...", captured_event["answer"])

    @async_test
    async def test_a_json_null_output_is_a_captured_value_not_a_failure(self) -> None:
        # Review finding (PR #3462): the capture-complete check conflated a
        # port that parsed as JSON null with a missing port — a legit null
        # output triggered the capture retry and recorded
        # output_capture_failed although the bind succeeded. Presence of
        # the key is the captured test, never the value.
        self.host.outcomes["src"] = {"status": "done", "answer": '```json\n{"data": null}\n```'}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {
                        "id": "src",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "data", "type": "json"}],
                    },
                    {
                        "id": "dep",
                        "subagent": {"prompt": "Proceed."},
                        "inputs": [{"name": "data", "type": "json", "from": "src.data", "optional": True}],
                    },
                ],
                "transitions": [{"from": "src", "to": "dep"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.all_events_of(result, "output_capture_failed"), [])
        # The null was captured and bound: the dependent renders the JSON
        # null, not the no-value sentinel path.
        self.assertIn("- data: null", self.host.spawn_calls("dep")[0]["prompt"])

    @async_test
    async def test_capture_failure_names_the_binding_cap_and_records_the_event(self) -> None:
        # A declared json output bigger than the executor's binding cap
        # fails to parse with the SIZE named in the error (not a bare
        # missing-output sentence), and the settle records the failure in
        # the ledger instead of passing silently.
        huge = f'{{"blob": "{"z" * (ANSWER_BINDING_CAP + 50)}"}}'
        self.host.outcomes["src"] = {"status": "done", "answer": f"```json\n{huge}\n```"}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {
                        "id": "src",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "blob", "type": "json"}],
                    },
                    {
                        "id": "dep",
                        "subagent": {"prompt": "Use {blob}."},
                        "inputs": [{"name": "blob", "type": "json", "from": "src.blob", "optional": True}],
                    },
                ],
                "transitions": [{"from": "src", "to": "dep"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # The optional dependent still proceeds on the sentinel (the
        # authored contract), but the source's capture failure is recorded.
        capture_failures = self.all_events_of(result, "output_capture_failed")
        self.assertEqual(len(capture_failures), 1)
        self.assertIn(str(ANSWER_BINDING_CAP), capture_failures[0]["error"])
        self.assertIn("keep the fenced JSON block compact", capture_failures[0]["error"])


    # -- foreach ----------------------------------------------------------------

    def store_fan_factory(self, *, policy: str) -> None:
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": ["a", "b", "c", "d", "e"]}'}
        self.store_factory(
            {
                "run": {"failure_policy": policy, "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 5},
                    },
                ],
            }
        )

    @async_test
    async def test_foreach_expands_clamped_instances(self) -> None:
        self.host.outcomes["src"] = {
            "status": "done",
            "answer": 'Here.\n```json\n{"items": [1, 2, 3, 4, 5]}\n```',
        }
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": {"prompt": "Expand item {items}."},
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 3},
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "done")
        # 5 items clamped to foreach.max 3; all instances settle -> node done.
        self.assertEqual(len(fan["instances"]), 3)
        self.assertEqual(
            sorted(call["prompt"] for call in self.host.spawn_calls("fan")),
            ["Expand item 1.", "Expand item 2.", "Expand item 3."],
        )

    @async_test
    async def test_foreach_zero_items_marks_node_done(self) -> None:
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": []}'}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 4},
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.node_status(status, "fan")["status"], "done")
        self.assertEqual(self.host.spawn_calls("fan"), [])

    @async_test
    async def test_foreach_mixed_instances_escalate_pauses(self) -> None:
        self.store_fan_factory(policy="escalate")
        result = await self.start()
        # src is child-1; the five fan instances are child-2..child-6.
        # Instances 0-1 fail permanently; 2-4 succeed in the same collect
        # batch. The node must reach error and the policy must apply even
        # though the failures did not settle last.
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom-1"}
        self.host.child_outcomes["child-3"] = {"status": "error", "error": "boom-2"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "paused")
        self.assertEqual(self.host.notice_kinds(), ["paused"])
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual([i["status"] for i in fan["instances"]], ["error", "error", "done", "done", "done"])

    @async_test
    async def test_foreach_mixed_instances_fail_fast_cancels_siblings(self) -> None:
        self.store_fan_factory(policy="fail_fast")
        result = await self.start()
        # instance 0 (child-2) fails first while its siblings are still in
        # flight: fail_fast must cancel those siblings now, not after they
        # settle.
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom"}
        for child_id in ("child-3", "child-4", "child-5", "child-6"):
            self.host.child_outcomes[child_id] = {"status": "running"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.host.notice_kinds(), ["failed"])
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual(
            [i["status"] for i in fan["instances"]],
            ["error", "cancelled", "cancelled", "cancelled", "cancelled"],
        )
        self.assertEqual(len(self.host.deleted_targets()), 4)

    @async_test
    async def test_foreach_mixed_instances_continue_finishes_with_node_error(self) -> None:
        self.store_fan_factory(policy="continue")
        result = await self.start()
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom-1"}
        self.host.child_outcomes["child-3"] = {"status": "error", "error": "boom-2"}
        status = await self.settle(result)
        # the node fails on the first permanent instance failure, the rest
        # still settle, and the run finishes with the node error recorded
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.host.notice_kinds(), ["failed"])
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual([i["status"] for i in fan["instances"]], ["error", "error", "done", "done", "done"])
        self.assertEqual(self.host.deleted_targets(), [])

    @async_test
    async def test_foreach_failure_never_admits_queued_siblings_and_waits_for_running_ones(self) -> None:
        # Review findings (two): (1) a terminal entry's queued instances are
        # never admitted (_next_pending_instance serves running entries
        # only), and (2) quiescence counts the INSTANCE layer, so a failed
        # foreach entry's still-running siblings are collected before the
        # run ends -- finalizing earlier would orphan them under the
        # supervisor with no collector.
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": ["a", "b", "c", "d", "e"]}'}
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_parallel": 2},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 5},
                    },
                ],
            }
        )
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        # src is child-1; max_parallel 2 admits fan instances child-2 and
        # child-3 first (child-2 fails permanently, child-3 stays running),
        # leaving three instances queued behind the cap.
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom"}
        self.host.child_outcomes["child-3"] = {"status": "running"}
        await self.wait_until(
            lambda: any(entry.status == "error" for entry in run.states["fan"].entries)
        )
        # The entry is terminal error with a running sibling: the run is NOT
        # complete yet, and nothing new may be admitted.
        self.assertEqual(run.state, "running")
        self.assertEqual(len(self.host.spawn_calls("fan")), 2)
        # The running sibling settles now; the run ends only after applying
        # its result, and the queued instances were cancelled, never run.
        self.host.child_outcomes["child-3"] = {"status": "done", "answer": "ok"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual(
            [i["status"] for i in fan["instances"]],
            ["error", "done", "cancelled", "cancelled", "cancelled"],
        )
        self.assertEqual(len(self.host.spawn_calls("fan")), 2)
        self.assertEqual(self.host.deleted_targets(), [])
        # the never-admitted siblings carry their own cancelled ledger events
        cancelled = [e for e in self.all_events_of(result, "cancelled") if e.get("node") == "fan"]
        self.assertEqual(len(cancelled), 3)
        self.assertTrue(all(e.get("detail") == "entry failed before admission" for e in cancelled))

    @async_test
    async def test_foreach_sibling_failure_after_terminal_entry_settles_without_retry(self) -> None:
        # Review finding (Cursor Bugbot): a foreach sibling failing with
        # retries left AFTER its entry is already terminal was reset to
        # pending -- _next_pending_instance serves running entries only, so
        # the instance was never re-admitted, while _run_complete and the
        # stall detector both counted it as in-flight: the control loop
        # never finished the run. A terminal entry cannot re-admit a
        # retry, so the sibling settles error instead.
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": ["a", "b"]}'}
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 2},
                        "retries": 1,
                    },
                ],
            }
        )
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        # src is child-1; fan instances are child-2 (i0) and child-3 (i1).
        # i0 fails (attempt 1 <= retries 1 -> retry), is re-admitted as
        # child-4, and fails again (attempt 2 > retries 1 -> the entry is
        # terminal error while i1 is still running).
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom-1"}
        self.host.child_outcomes["child-4"] = {"status": "error", "error": "boom-2"}
        self.host.child_outcomes["child-3"] = {"status": "running"}
        await self.wait_until(
            lambda: any(entry.status == "error" for entry in run.states["fan"].entries)
        )
        self.assertEqual(len(self.host.spawn_calls("fan")), 3)
        # i1 fails now with retries remaining, but the entry is terminal:
        # no retry is queued, the run finishes instead of hanging.
        self.host.child_outcomes["child-3"] = {"status": "error", "error": "boom-3"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        fan = self.node_status(status, "fan")
        self.assertEqual(fan["status"], "error")
        self.assertEqual([i["status"] for i in fan["instances"]], ["error", "error"])
        self.assertEqual([i["attempt"] for i in fan["instances"]], [2, 1])
        # only i0's failure was ever retried; i1 settled without a re-spawn
        self.assertEqual(len(self.host.spawn_calls("fan")), 3)
        retries = [e for e in self.all_events_of(result, "retry") if e.get("node") == "fan"]
        self.assertEqual([e["instance"] for e in retries], [0])

    # -- failure policies ---------------------------------------------------------

    @async_test
    async def test_fail_fast_cancels_running_children(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.host.outcomes["b"] = {"status": "running"}
        self.host.outcomes["c"] = {"status": "running"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_parallel": 8},
                "nodes": [
                    {"id": "a", "subagent": "worker", "failure_policy": "fail_fast"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.node_status(status, "a")["status"], "error")
        self.assertEqual(self.node_status(status, "b")["status"], "cancelled")
        self.assertEqual(self.node_status(status, "c")["status"], "cancelled")
        # delete_subagent cascaded to both running children
        self.assertEqual(len(self.host.deleted_targets()), 2)
        self.assertEqual(self.host.notice_kinds(), ["failed"])

    @async_test
    async def test_continue_policy_finishes_remaining_nodes(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # a failed; b (depends_on a, no data edge) still ran and finished; c ran.
        self.assertEqual(self.node_status(status, "a")["status"], "error")
        self.assertEqual(self.node_status(status, "b")["status"], "done")
        self.assertEqual(self.node_status(status, "c")["status"], "done")
        self.assertEqual(self.host.deleted_targets(), [])
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.host.notice_kinds(), ["failed"])

    @async_test
    async def test_escalate_pauses_notifies_and_resume_continues(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        self.assertEqual(self.node_status(paused, "a")["status"], "error")
        self.assertEqual(self.node_status(paused, "b")["status"], "pending")
        self.assertEqual(self.host.spawn_calls("b"), [])
        self.assertIn("paused", self.host.notice_kinds())
        # resume() restarts the run: b is ready (a is terminal) and finishes.
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(resumed["state"], "running")
        final = await self.settle(result)
        self.assertEqual(final["state"], "failed")  # a errored, b done
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        self.assertEqual(self.host.notice_kinds(), ["paused", "failed"])
        # a second resume on the finished run must refuse
        with self.assertRaisesRegex(ValueError, "not paused"):
            await rlm_module.rlm.factory.resume(result["run_id"])

    @async_test
    async def test_resume_defers_rate_limited_admissions(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.host.rate_limit_first["b"] = 2
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        sleep_mark = len(self.sleeps.sleeps)
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        # resume() must not sleep in the calling turn: the rate-limited
        # admission defers to the control loop's backoff, exactly like run()
        self.assertEqual(resumed["started"], [])
        self.assertEqual(self.sleeps.sleeps[sleep_mark:], [])
        final = await self.settle(result)
        self.assertEqual(final["state"], "failed")  # a errored, b done
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        # b needed 3 admissions total: one deferred at resume, then one
        # rate-limited retry inside the loop's backoff, then the success.
        self.assertEqual(len(self.host.spawn_calls("b")), 3)
        self.assertEqual(self.sleeps.sleeps[sleep_mark:], [1.0])

    @async_test
    async def test_repeated_pause_records_every_milestone_in_the_ledger(self) -> None:
        # A run that pauses, resumes, and pauses again must record the second
        # pause in the ledger even though the parent notice fires once per
        # kind: status() is the only reader of the repeat.
        self.host.outcomes["a"] = {"status": "error", "error": "a boom"}
        self.host.outcomes["b"] = {"status": "error", "error": "b boom"}
        self.store_machine(
            {
                "run": {"failure_policy": "escalate"},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                ],
                "transitions": [{"from": "a", "to": "b"}],
            }
        )
        result = await self.start()
        first = await self.settle(result)
        self.assertEqual(first["state"], "paused")
        self.assertEqual(len(self.events_of(first, "milestone")), 1)  # one pause so far
        await rlm_module.rlm.factory.resume(result["run_id"])
        second = await self.settle(result)
        self.assertEqual(second["state"], "paused")
        self.assertEqual(self.executor._runs[result["run_id"]].pause_reason, "b boom")
        # the second pause is in the ledger with its own event, notice-free
        milestones = [event for event in second["events"] if event["kind"] == "milestone"]
        self.assertEqual([event["milestone"] for event in milestones], ["paused", "paused"])
        self.assertIn("a boom", milestones[0]["detail"])
        self.assertIn("b boom", milestones[1]["detail"])
        self.assertEqual(self.host.notice_kinds(), ["paused"])  # one notice per kind
        # the announced pause keeps "shown"; the repeat (no second notice)
        # was only ever read through status(), so it reads "delivered"
        self.assertEqual(milestones[0]["stage"], "shown")
        self.assertEqual(milestones[1]["stage"], "delivered")

    # -- retries --------------------------------------------------------------------

    @async_test
    async def test_retries_respawn_until_attempts_exhausted(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [{"id": "a", "subagent": "worker", "retries": 2}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # retries=2 -> 3 admissions total, then the policy applies
        self.assertEqual(len(self.host.spawn_calls("a")), 3)
        self.assertEqual(self.node_status(status, "a")["attempts"], 3)
        self.assertEqual(self.node_status(status, "a")["status"], "error")
        self.assertEqual(status["state"], "failed")

    # -- budgets ----------------------------------------------------------------------

    @async_test
    async def test_node_budget_marks_attempt_failed(self) -> None:
        # The fake clock advances 2s per collect, so the node's 1000ms budget
        # (admission to settlement) is exceeded when the child settles.
        self.clock.advance_per_collect = 2.0
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker", "budget_ms": 1000},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        a = self.node_status(status, "a")
        self.assertEqual(a["status"], "error")
        self.assertIn("budget", a["error"])
        # budget failures do not retry: exactly one admission for a
        self.assertEqual(len(self.host.spawn_calls("a")), 1)
        # b (depends_on a, no data edge) still ran and finished
        self.assertEqual(self.node_status(status, "b")["status"], "done")
        self.assertEqual(status["state"], "failed")

    @async_test
    async def test_run_budget_pauses_and_notifies_then_resume_completes(self) -> None:
        self.clock.advance_per_collect = 2.0
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "budget_ms": 1500},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        self.assertIn("budget_exceeded", self.host.notice_kinds())
        self.assertEqual(self.host.spawn_calls("b"), [])
        # the pause reports the overshoot accounting: elapsed time past the
        # budget, and that only new spawns stop.
        milestone = next(
            event for event in self.events_of(paused, "milestone") if event["milestone"] == "budget_exceeded"
        )
        self.assertIn("no new spawns", milestone["detail"])
        self.assertIn("2000ms", milestone["detail"])
        self.assertEqual(self.executor._runs[result["run_id"]].pause_reason, "run budget exceeded")
        # resume continues despite the spent budget (reported once per run)
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        self.assertEqual(self.host.notice_kinds(), ["budget_exceeded", "finished"])

    @async_test
    async def test_admission_phase_stops_at_the_run_budget_boundary(self) -> None:
        # Review finding: the run budget must be enforced before EACH
        # admission, including run()'s own admission phase -- a slow spawn
        # must not fill max_parallel with instances launched after the
        # budget expired.
        self.host.advance_per_run = 2.0  # every admission costs two seconds
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "budget_ms": 3000, "max_parallel": 8},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        # Admissions at t=1000 and t=1002 pass the budget check; the third
        # would launch at t=1004 (4000ms elapsed > 3000ms budget), so the
        # run pauses BEFORE admitting it.
        self.assertEqual(result["started"], ["a", "b"])
        self.assertEqual(len(self.host.calls_of("rlm.run")), 2)
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "paused")
        self.assertIn("budget_exceeded", self.host.notice_kinds())
        # c was prepared but never admitted: its entry reports running, its
        # instance is still pending, and no spawn call was made for it.
        c_report = self.node_status(status, "c")
        self.assertEqual(c_report["status"], "running")
        self.assertEqual(c_report["instances"][0]["status"], "pending")
        self.assertEqual(self.host.spawn_calls("c"), [])
        # resume is the explicit operator decision: c runs, no second pause
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.node_status(final, "c")["status"], "done")
        self.assertEqual(self.host.notice_kinds(), ["budget_exceeded", "finished"])

    @async_test
    async def test_run_max_children_pauses_at_admission_then_resume_completes(self) -> None:
        # Macroscope finding: foreach.max bounds per-entry expansion,
        # max_transitions bounds transitions, and max_parallel bounds
        # concurrency — nothing bounded TOTAL admissions over the run's
        # life. run.max_children is that budget: enforced before each
        # admission (run()'s own phase included), pause once at the
        # boundary, resume continues past it (explicit operator decision).
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_children": 2},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        # run()'s admission phase admits a and b; c's spawn is refused.
        self.assertEqual(result["started"], ["a", "b"])
        self.assertEqual(len(self.host.calls_of("rlm.run")), 2)
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "paused")
        # its OWN milestone kind, distinct from the run-budget pause
        self.assertIn("max_children_exceeded", self.host.notice_kinds())
        self.assertNotIn("budget_exceeded", self.host.notice_kinds())
        milestone = next(
            event for event in self.events_of(status, "milestone") if event["milestone"] == "max_children_exceeded"
        )
        self.assertIn("run max_children 2 exceeded after 2 children", milestone["detail"])
        self.assertIn("no new spawns", milestone["detail"])
        self.assertIn("resume with await rlm.factory.resume", milestone["detail"])
        self.assertEqual(self.executor._runs[result["run_id"]].pause_reason, "max_children exceeded")
        self.assertEqual(status["usage"]["spawns"], 2)
        self.assertEqual(status["usage"]["max_children"], 2)
        # c was prepared but never admitted: entry running, instance pending.
        c_report = self.node_status(status, "c")
        self.assertEqual(c_report["status"], "running")
        self.assertEqual(c_report["instances"][0]["status"], "pending")
        self.assertEqual(self.host.spawn_calls("c"), [])
        # resume is the explicit operator decision: c runs, no second pause
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.node_status(final, "c")["status"], "done")
        self.assertEqual(final["usage"]["spawns"], 3)
        self.assertEqual(self.host.notice_kinds(), ["max_children_exceeded", "finished"])

    @async_test
    async def test_foreach_children_count_against_the_run_max_children_budget(self) -> None:
        # The finding's scenario, pinned: nothing bounded the total
        # children of repeated foreach expansion (10,000 transitions x
        # foreach.max 256 = 2.56M admissions with no run budget). foreach
        # expansions count against run.max_children: the run pauses
        # mid-expansion with the exact error, and resume finishes the
        # expansion exactly once past it.
        self.host.outcomes["src"] = {
            "status": "done",
            "answer": '```json\n{"items": ["w", "x", "y", "z"]}\n```',
        }
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_children": 2, "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": {"prompt": "Expand item {items}."},
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 256},
                    },
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        # src plus fan instance 0 hit the budget; the remaining fan
        # instances wait: the executor refuses their spawns, it never
        # wedges and never spends them.
        self.assertEqual(paused["state"], "paused")
        self.assertIn("max_children_exceeded", self.host.notice_kinds())
        self.assertEqual(self.executor._runs[result["run_id"]].pause_reason, "max_children exceeded")
        self.assertEqual(paused["usage"]["spawns"], 2)
        fan = self.node_status(paused, "fan")
        self.assertEqual(len(fan["instances"]), 4)
        self.assertEqual([instance["status"] for instance in fan["instances"]], ["running", "pending", "pending", "pending"])
        self.assertEqual(len(self.host.spawn_calls("fan")), 1)
        # resume finishes the expansion: all four fan children run, no
        # second child-budget pause fires.
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.node_status(final, "fan")["status"], "done")
        self.assertEqual(final["usage"]["spawns"], 5)
        self.assertEqual(
            sorted(call["prompt"] for call in self.host.spawn_calls("fan")),
            ["Expand item w.", "Expand item x.", "Expand item y.", "Expand item z."],
        )
        self.assertEqual(self.host.notice_kinds(), ["max_children_exceeded", "finished"])


    # -- stop and rate limits -------------------------------------------------------------

    @async_test
    async def test_stop_cancels_children_and_pending_nodes(self) -> None:
        self.host.outcomes["a"] = {"status": "running"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["a"])
        await self.wait_until(lambda: self.host.collects >= 1)
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["run_id"], result["run_id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(stopped["cancelled"], ["a", "b"])
        self.assertEqual(self.host.deleted_targets(), ["child-1"])
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(self.node_status(status, "a")["status"], "cancelled")
        self.assertEqual(self.node_status(status, "b")["status"], "cancelled")
        # repeated stop is idempotent: same result, no duplicate ledger event
        again = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(again, {"run_id": result["run_id"], "state": "stopped", "cancelled": []})
        run_stopped_events = [e for e in self.executor._runs[result["run_id"]].events if e["kind"] == "run_stopped"]
        self.assertEqual(len(run_stopped_events), 1)

    @async_test
    async def test_stop_delete_receipts_with_cancelled_status_complete_cleanly(self) -> None:
        # M5: the host's delete receipt reports a cancelled row (a live
        # child's delete settles it cancelled; a previously-cancelled
        # settled child keeps the status verbatim), and the kernel's
        # payload validation must accept it — the receipt raising
        # "entry has invalid status" used to turn every factory stop into
        # cancel_failed bookkeeping and make retirement look failed.
        self.host.outcomes["a"] = {"status": "running"}
        self.host.outcomes["b"] = {"status": "running"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        await self.wait_until(lambda: self.host.collects >= 1)
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(sorted(stopped["cancelled"]), ["a", "b"])
        # The delete receipts were accepted: no cancel_failed ledger rows,
        # and both children released their name slots on the fake host.
        self.assertEqual(self.all_events_of(result, "cancel_failed"), [])
        self.assertEqual(
            [event.get("detail") for event in self.all_events_of(result, "cancelled")],
            [None, None],
        )
        # A retire of the already-cancelled children (the operator's
        # delete_subagent on a settled/cancelled row) does not raise.
        for child_id in ("child-1", "child-2"):
            deleted = await rlm_module.rlm.delete_subagent(child_id)
            self.assertEqual(deleted.status, "cancelled")

    @async_test
    async def test_concurrent_stop_runs_one_cancellation_pass(self) -> None:
        # Review finding: two concurrent stop() calls would both pass a bare
        # "stopped" check, issue duplicate delete_subagent requests, and
        # record a second run_stopped event. The transitional "stopping"
        # state is guarded too.
        self.host.outcomes["a"] = {"status": "running"}
        self.host.outcomes["b"] = {"status": "running"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        await self.wait_until(lambda: self.host.collects >= 1)
        delete_gate = self.host.gate("rlm.delete_subagent", 1)
        stop_one = asyncio.ensure_future(rlm_module.rlm.factory.stop(result["run_id"]))
        await self.wait_until(lambda: self.executor._runs[result["run_id"]].state == "stopping")
        # stop #2 lands while stop #1 is suspended mid-cancellation: it must
        # early-return without starting a second pass.
        stop_two = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stop_two, {"run_id": result["run_id"], "state": "stopping", "cancelled": []})
        delete_gate.set()
        stopped = await stop_one
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(sorted(stopped["cancelled"]), ["a", "b"])
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        # one cancellation pass: each child deleted exactly once, one event
        self.assertEqual(sorted(self.host.deleted_targets()), ["child-1", "child-2"])
        self.assertEqual(len(self.host.deleted_targets()), 2)
        run_stopped_events = [e for e in self.executor._runs[result["run_id"]].events if e["kind"] == "run_stopped"]
        self.assertEqual(len(run_stopped_events), 1)

    @async_test
    async def test_stop_window_admits_no_new_spawns_and_never_finalizes(self) -> None:
        # max_parallel 2 with three ready nodes: c waits for a slot. The
        # loop's first collect and stop()'s first delete are gated so the
        # stop window opens mid-collect with free-able slots and a ready
        # pending node: the loop must neither admit c nor finalize the run.
        self.store_factory(
            {
                "run": {"max_parallel": 2},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        collect_gate = self.host.gate("rlm.collect", 1)
        delete_gate = self.host.gate("rlm.delete_subagent", 1)
        result = await self.start()
        self.assertEqual(result["started"], ["a", "b"])  # c waits for a slot
        run = self.executor._runs[result["run_id"]]
        await yield_loop_turn()  # the loop reaches collect#1 and suspends
        stop_task = asyncio.ensure_future(rlm_module.rlm.factory.stop(result["run_id"]))
        for _ in range(1000):
            if run.state == "stopping":
                break
            await yield_loop_turn()
        self.assertEqual(run.state, "stopping")
        # release the collect: the loop settles a and b inside the stop window
        collect_gate.set()
        await run.task  # the loop must exit on "stopping" without admitting c
        delete_gate.set()
        stopped = await stop_task
        self.assertEqual(stopped["state"], "stopped")
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        # never finalized: no finished notice, and c was never admitted
        self.assertEqual(self.host.notice_kinds(), [])
        self.assertEqual(len(self.host.calls_of("rlm.run")), 2)

    @async_test
    async def test_stop_during_in_flight_admission_deletes_the_child(self) -> None:
        # run() admission is deferred by a 429, the control loop retries, and
        # stop() lands while that retry is still in flight: the child the
        # suspended spawn returns must be deleted and never registered running.
        self.host.rate_limit_first["a"] = 1
        spawn_gate = self.host.gate("rlm.run", 2)
        gate_entered = self.host.gate_entered("rlm.run", 2)
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        self.assertEqual(result["started"], [])
        await gate_entered.wait()  # the loop is suspended mid-spawn
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["a"])
        spawn_gate.set()  # the admission returns a child into a stopped run
        run = self.executor._runs[result["run_id"]]
        await run.task
        status = await rlm_module.rlm.factory.status(result["run_id"])
        instance = self.node_status(status, "a")["instances"][0]
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(instance["status"], "cancelled")
        self.assertEqual(instance["child"], "child-1")
        self.assertEqual(self.host.deleted_targets(), ["child-1"])  # retracted
        self.assertEqual(status["usage"]["spawns"], 0)  # never registered
        self.assertEqual(len(self.host.spawn_calls("a")), 2)  # no re-admission
        # the retraction is recorded after run_stopped: a cancelled ledger
        # entry for the retracted child, and no spawned event after it.
        kinds = [event["kind"] for event in status["events"]]
        self.assertEqual(kinds[kinds.index("run_stopped"):], ["run_stopped", "cancelled"])

    @async_test
    async def test_stop_during_admission_backoff_cancels_the_instance(self) -> None:
        # stop() lands while the loop waits out a rate-limit backoff
        # deadline: waking must not retry the spawn; the instance is
        # cancelled instead.
        self.sleeps = GatedSleep()
        self.executor = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        factory_module._DEFAULT_EXECUTOR = self.executor
        self.host.rate_limit_first["a"] = 2
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        self.assertEqual(result["started"], [])
        await self.sleeps.entered.wait()  # the loop waits out the backoff slice
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["a"])
        self.sleeps.release.set()  # the backoff wakes into a stopped run
        run = self.executor._runs[result["run_id"]]
        await run.task
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(self.node_status(status, "a")["instances"][0]["status"], "cancelled")
        # the retry never happened: two admissions, both before the stop
        self.assertEqual(len(self.host.spawn_calls("a")), 2)
        self.assertEqual(self.host.deleted_targets(), [])  # no child existed
        self.assertEqual(status["usage"]["spawns"], 0)

    @async_test
    async def test_stop_cancels_an_in_flight_earlier_entry_of_a_reentered_state(self) -> None:
        # x re-enters (max_entries 2): entry 1 settles while entry 0 is still
        # running, so the state's latest entry reads done. stop() must still
        # report and cancel the in-flight entry 0, not read the state as done.
        self.host.child_outcomes["child-3"] = {"status": "running"}
        self.host.child_outcomes["child-4"] = {"status": "done", "answer": "x-two"}
        self.store_machine(
            {
                "run": {"max_parallel": 4},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "entry": True, "subagent": "worker"},
                    {"id": "x", "subagent": "worker", "max_entries": 2},
                ],
                "transitions": [{"from": "a", "to": "x"}, {"from": "b", "to": "x"}],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["a", "b"])
        run = self.executor._runs[result["run_id"]]
        # entry 1 settles while entry 0's child stays running forever
        await self.wait_until(lambda: any(entry.status == "done" for entry in run.states["x"].entries))
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["x"])  # not []: entry 0 is in flight
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        node = self.node_status(status, "x")
        self.assertEqual([(e["index"], e["status"]) for e in node["entries"]], [(0, "cancelled"), (1, "done")])
        self.assertEqual([(i["index"], i["status"]) for i in node["instances"]], [(0, "cancelled"), (1, "done")])
        self.assertEqual(self.host.deleted_targets(), ["child-3"])

    @async_test
    async def test_concurrent_stop_during_fail_fast_deletes_each_child_once(self) -> None:
        # Regression (bot review): fail_fast's cancellation cascade runs while
        # the run is still "running", so a concurrent stop() started its own
        # pass mid-cascade and issued a duplicate delete_subagent for a child
        # the first pass already owned. The pass CLAIMS each instance before
        # its await, so every child is deleted exactly once.
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        delete_gate = self.host.gate("rlm.delete_subagent", 1)
        delete_entered = self.host.gate_entered("rlm.delete_subagent", 1)
        self.store_factory(
            {
                "run": {"failure_policy": "fail_fast"},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        # a settles error -> fail_fast cancels b; the first delete is gated.
        await delete_entered.wait()
        # stop() lands while the run is still "running" (fail_fast sets
        # "failed" only after its cascade): its pass must skip b (claimed)
        # and cancel c itself.
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["state"], "stopped")
        delete_gate.set()
        final = await self.settle(result)
        self.assertEqual(final["state"], "stopped")
        # The gated delete resumes after the stop pass: the fail_fast
        # cascade finishes inside the control-loop task, so the task-done
        # barrier waits for BOTH deletions deterministically (an assert on
        # the delete list alone could race the released call).
        run = self.executor._runs[result["run_id"]]
        await self.wait_until(lambda: run.task.done())
        # every child deleted exactly once, in one pass each
        self.assertEqual(sorted(self.host.deleted_targets()), ["child-2", "child-3"])
        self.assertEqual(
            len([event for event in self.all_events_of(result, "cancel_failed")]), 0
        )

    @async_test
    async def test_failed_delete_records_cancel_failed_and_cancelled(self) -> None:
        # A delete that raises still releases the executor's slot, so the
        # ledger records the failure AND the cancellation (the eval replay
        # checker keys off cancelled events) while the instance reads
        # cancelled in the stopped run.
        failing = DeleteFailsHost(clock=self.clock)
        patcher = patch.object(rlm_module, "host_request", failing)
        patcher.start()
        self.addCleanup(patcher.stop)
        failing.outcomes["a"] = {"status": "running"}
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        await self.wait_until(lambda: failing.collects >= 1)
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["a"])
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        instance = self.node_status(status, "a")["instances"][0]
        self.assertEqual(instance["status"], "cancelled")
        kinds = [(event["kind"], event.get("detail")) for event in status["events"]]
        self.assertIn(("cancel_failed", None), kinds)
        self.assertIn(("cancelled", "slot released despite the failed delete"), kinds)
        # the failure is recorded before the cancellation it explains
        self.assertLess(kinds.index(("cancel_failed", None)), kinds.index(("cancelled", "slot released despite the failed delete")))

    @async_test
    async def test_rate_limit_at_admission_defers_to_backoff(self) -> None:
        # First two admissions for a fail with a 429: one at run() admission
        # (deferred, no sleep in the calling turn), one inside the loop
        # (records the backoff deadline), then the loop waits out the
        # deadline in bounded slices and the retry succeeds.
        self.host.rate_limit_first["a"] = 2
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        self.assertEqual(result["started"], [])
        # run() itself never slept: the deferral is nonblocking.
        self.assertEqual(self.sleeps.sleeps, [])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        # three host admissions in total: one deferred at run(), then one
        # rate-limited retry inside the loop's backoff, then success
        self.assertEqual(len(self.host.spawn_calls("a")), 3)
        self.assertEqual(self.node_status(status, "a")["attempts"], 3)
        self.assertEqual(self.sleeps.sleeps, [1.0])

    @async_test
    async def test_rate_limit_backoff_exhaustion_fails_node(self) -> None:
        self.host.rate_limit_forever.add("b")
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # BACKOFF_MAX_ATTEMPTS consecutive rate-limited admissions fail the
        # node through its failure_policy.
        self.assertEqual(BACKOFF_MAX_ATTEMPTS, 5)
        self.assertEqual(len(self.host.spawn_calls("b")), 5)
        b = self.node_status(status, "b")
        self.assertEqual(b["status"], "error")
        self.assertIn("spawn admission failed", b["error"])
        self.assertEqual(status["state"], "failed")
        # The backoff waits out its deadlines in bounded slices (each capped
        # at the collect poll timeout), never one blocking sleep per delay:
        # the sole control lane stays free for collection while admission
        # backs off.
        self.assertTrue(self.sleeps.sleeps)
        self.assertTrue(all(delay <= POLL_TIMEOUT_MS / 1000 for delay in self.sleeps.sleeps))
        self.assertEqual(sum(self.sleeps.sleeps), 1.0 + 2.0 + 4.0 + 8.0)  # 1,2,4,8s delays
        # (Children keep being collected during a backoff when some are
        # running -- test_backoff_keeps_collecting_running_children proves
        # that property; here b backs off with nothing in flight.)

    @async_test
    async def test_backoff_keeps_collecting_running_children(self) -> None:
        # Review finding: a blocking backoff (one long sleep per retry)
        # starves collection for the whole delay, so a sibling that
        # completes during the backoff is observed late and can be
        # misclassified against its own budget. The loop must keep polling
        # children while admission waits out its deadline.
        self.host.outcomes["a"] = {"status": "running"}
        self.host.rate_limit_first["b"] = 3
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                ],
            }
        )
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        self.assertEqual(result["started"], ["a"])  # b deferred at admission
        # b's loop retry records the first backoff deadline.
        await self.wait_until(lambda: any(e["kind"] == "spawn_backoff" for e in run.events))
        collects_at_backoff = self.host.collects
        # a completes while b is still backed off (its 1s+2s+4s delays are
        # waited out in slices, with collects between them).
        self.host.outcomes["a"] = {"status": "done", "answer": "late-but-collected"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.node_status(status, "a")["status"], "done")
        self.assertEqual(self.node_status(status, "b")["status"], "done")
        # a settled during the backoff window: collects continued past the
        # deadline the loop was waiting out.
        self.assertGreater(self.host.collects, collects_at_backoff)
        settled = [e for e in self.all_events_of(result, "settled") if e.get("node") == "a" and e.get("status") == "done"]
        self.assertEqual(len(settled), 1)

    # -- scale -----------------------------------------------------------------------------

    @async_test
    async def test_scale_chain_100_completes(self) -> None:
        nodes = [{"id": "n0", "subagent": {"prompt": "step"}}]
        for index in range(1, 100):
            nodes.append({"id": f"n{index}", "subagent": {"prompt": "step"}, "depends_on": [f"n{index - 1}"]})
        self.store_factory({"run": {"max_parallel": 8}, "nodes": nodes})
        started = time.monotonic()
        result = await self.start()
        status = await self.settle(result)
        elapsed = time.monotonic() - started
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(status["nodes"]), 100)
        self.assertTrue(all(entry["status"] == "done" for entry in status["nodes"]))
        self.assertLess(elapsed, 10.0)

    @async_test
    async def test_scale_fan_1000_completes(self) -> None:
        nodes = [{"id": "n0", "subagent": {"prompt": "step"}}]
        for index in range(1, 1000):
            nodes.append({"id": f"n{index}", "subagent": {"prompt": "step"}, "depends_on": ["n0"]})
        self.store_factory({"run": {"max_parallel": 64}, "nodes": nodes})
        started = time.monotonic()
        result = await self.start()
        status = await self.settle(result)
        elapsed = time.monotonic() - started
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(status["nodes"]), 1000)
        self.assertTrue(all(entry["status"] == "done" for entry in status["nodes"]))
        self.assertLess(elapsed, 10.0)

    # -- status, ledger, notices ----------------------------------------------------------

    @async_test
    async def test_status_marks_events_delivered_and_unknown_run_raises(self) -> None:
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        await self.wait_until(lambda: run.state != "running")
        # Before any status() read: answers are arrived, the milestone is shown.
        stages = {event["kind"]: event["stage"] for event in run.events}
        self.assertEqual(stages["answer_captured"], "arrived")
        self.assertEqual(stages["milestone"], "shown")
        status = await rlm_module.rlm.factory.status(result["run_id"])
        # Reading the ledger marks the unseen events delivered; the milestone
        # keeps "shown" because its notice already reached the parent, so the
        # stage taxonomy stays observable through status().
        after = {event["kind"]: event["stage"] for event in run.events}
        self.assertEqual(after["milestone"], "shown")
        self.assertEqual(after["answer_captured"], "delivered")
        self.assertEqual(status["events"][-1]["stage"], "shown")  # the milestone
        # EVENT_WINDOW: a state-machine run's ledger grows fast (the
        # pr-manager happy path is ~43 events before any retry).
        self.assertEqual(EVENT_WINDOW, 200)
        self.assertLessEqual(len(status["events"]), EVENT_WINDOW)
        # exactly one notice for the one milestone
        self.assertEqual(self.host.notice_kinds(), ["finished"])
        for call in ("status", "stop", "resume"):
            with self.assertRaisesRegex(ValueError, "unknown factory run"):
                await getattr(rlm_module.rlm.factory, call)("no-such-run")

    @async_test
    async def test_milestone_notices_carry_validated_payloads(self) -> None:
        # The TS-era host handler validated the payload; the kernel-side
        # contract it validated is pinned here: run-level milestones send
        # {run_id, kind, detail} (no node), node-level ones add "node", and
        # every notice goes through one "factory.progress" host request.
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        resume = await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "failed")
        kinds = self.host.notice_kinds()
        self.assertEqual(kinds, ["paused", "failed"])
        paused_notice, failed_notice = self.host.notices
        self.assertEqual(paused_notice["kind"], "paused")
        self.assertEqual(paused_notice["run_id"], result["run_id"])
        self.assertIn("state a failed", paused_notice["detail"])
        self.assertIn("resume", paused_notice["detail"])
        self.assertEqual(paused_notice.get("node"), "a")  # node-level milestone
        self.assertEqual(failed_notice["kind"], "failed")
        self.assertEqual(failed_notice["run_id"], result["run_id"])
        self.assertIsNone(failed_notice.get("node"))  # run-level milestone
        self.assertEqual(set(paused_notice.keys()), {"run_id", "kind", "detail", "node"})
        self.assertEqual(set(failed_notice.keys()), {"run_id", "kind", "detail"})
        # one host request per notice, typed factory.progress
        self.assertEqual(len(self.host.calls_of("factory.progress")), 2)

    @async_test
    async def test_dead_bridge_keeps_the_milestone_in_the_ledger(self) -> None:
        # A dead bridge cannot be told: the milestone stays in the ledger
        # (stage "recorded") and status() still surfaces it to the parent.
        failing = DeadNoticeHost(clock=self.clock)
        patcher = patch.object(rlm_module, "host_request", failing)
        patcher.start()
        self.addCleanup(patcher.stop)
        failing.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        # a fails: escalate pauses the run while the bridge is dead, so the
        # milestone lands in the ledger without ever being shown.
        await self.wait_until(lambda: run.state == "paused")
        await self.wait_until(lambda: any(event["kind"] == "milestone" for event in run.events))
        raw = [event for event in run.events if event["kind"] == "milestone"]
        self.assertEqual(len(raw), 1)
        self.assertEqual(raw[0]["stage"], "recorded")  # never shown: bridge dead
        self.assertIn("state a failed", raw[0]["detail"])
        # status() still surfaces the milestone to the parent: the read marks
        # the unread ("recorded") event delivered, like any other ledger read.
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        milestones = [event for event in paused["events"] if event["kind"] == "milestone"]
        self.assertEqual(len(milestones), 1)
        self.assertEqual(milestones[0]["milestone"], "paused")
        self.assertEqual(milestones[0]["stage"], "delivered")  # read via status()
        self.assertIn("state a failed", milestones[0]["detail"])
        # the run is not wedged: resume still works end to end.
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "failed")
        self.assertEqual(self.node_status(final, "b")["status"], "done")


    # -- machine form: transitions, guards, re-entry, residents ---------------------

    @async_test
    async def test_machine_three_round_review_loop(self) -> None:
        # review verdict approved=false twice, then true: the guarded switch
        # alternates reviewing/fixing until approved, then quiesces as done.
        self.host.child_outcomes["child-1"] = {"status": "done", "answer": "DRAFT-1"}
        self.host.child_outcomes["child-2"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": false, "findings": ["AUDIT-A1"]}}\n```',
        }
        self.host.child_outcomes["child-3"] = {"status": "done", "answer": "fixed round 1"}
        self.host.child_outcomes["child-4"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": false, "findings": ["AUDIT-B1"]}}\n```',
        }
        self.host.child_outcomes["child-5"] = {"status": "done", "answer": "fixed round 2"}
        self.host.child_outcomes["child-6"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": true, "findings": []}}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {
                        "id": "draft",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "draft", "type": "text"}],
                    },
                    {
                        "id": "reviewing",
                        "subagent": "worker",
                        "inputs": [{"name": "draft", "type": "text", "from": "draft.draft"}],
                        "outputs": [{"name": "verdict", "type": "json"}],
                        "max_entries": 4,
                    },
                    {"id": "fixing", "subagent": "worker", "max_entries": 3},
                ],
                "transitions": [
                    {"from": "draft", "to": "reviewing"},
                    {
                        "from": "reviewing",
                        "to": "fixing",
                        "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False},
                    },
                    {"from": "fixing", "to": "reviewing"},
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["draft"])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        reviewing = self.state_report(status, "reviewing")
        fixing = self.state_report(status, "fixing")
        self.assertEqual(reviewing["status"], "done")
        self.assertEqual(reviewing["entries_used"], 3)
        self.assertEqual(len(reviewing["entries"]), 3)
        self.assertEqual(len(reviewing["instances"]), 3)
        self.assertEqual(fixing["status"], "done")
        self.assertEqual(fixing["entries_used"], 2)
        self.assertEqual(len(self.host.spawn_calls("reviewing")), 3)
        self.assertEqual(len(self.host.spawn_calls("fixing")), 2)
        self.assertEqual(status["usage"]["transitions_fired"], 5)
        # the final approved verdict never fires the guarded transition
        fired = self.all_events_of(result, "transition_fired")
        self.assertEqual(len(fired), 5)
        self.assertEqual(self.all_events_of(result, "transition_blocked"), [])

    @async_test
    async def test_machine_guard_switch_fires_only_the_matching_branch(self) -> None:
        self.host.outcomes["pick"] = {
            "status": "done",
            "answer": '```json\n{"pick": {"choice": "left"}}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {
                        "id": "pick",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "pick", "type": "json"}],
                    },
                    {"id": "left", "subagent": "worker"},
                    {"id": "right", "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "pick", "to": "left", "when": {"output": "pick", "path": "choice", "op": "eq", "value": "left"}},
                    {"from": "pick", "to": "right", "when": {"output": "pick", "path": "choice", "op": "eq", "value": "right"}},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        left = self.state_report(status, "left")
        right = self.state_report(status, "right")
        self.assertEqual(left["status"], "done")
        self.assertEqual(left["entries_used"], 1)
        # the exclusive guard never entered "right": quiescence ignores it
        self.assertEqual(right["entries_used"], 0)
        self.assertEqual(right["status"], "pending")
        self.assertEqual(self.host.spawn_calls("right"), [])
        self.assertEqual(status["usage"]["transitions_fired"], 1)
        # The fired event and the last_fired edge carry the guard that
        # fired: two guarded transitions may share one from+to pair, so
        # the guard is the identity the diagram's fired marking reads.
        fired = self.all_events_of(result, "transition_fired")
        self.assertEqual(len(fired), 1)
        self.assertEqual(
            fired[0]["when"],
            {"output": "pick", "path": "choice", "op": "eq", "value": "left"},
        )
        graph = await rlm_module.rlm.factory.graph(result["run_id"])
        self.assertEqual(len(graph["last_fired"]), 1)
        self.assertEqual(
            graph["last_fired"][0]["when"],
            {"output": "pick", "path": "choice", "op": "eq", "value": "left"},
        )

    @async_test
    async def test_machine_fan_out_from_one_settle_fires_all(self) -> None:
        self.host.outcomes["fan"] = {"status": "done", "answer": "go"}
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "fan", "entry": True, "subagent": "worker", "outputs": [{"name": "go", "type": "text"}]},
                    {"id": "left", "subagent": "worker"},
                    {"id": "right", "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "fan", "to": "left"},
                    {"from": "fan", "to": "right"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.state_report(status, "left")["status"], "done")
        self.assertEqual(self.state_report(status, "right")["status"], "done")
        self.assertEqual(status["usage"]["transitions_fired"], 2)
        fired = self.all_events_of(result, "transition_fired")
        self.assertEqual([event["to"] for event in fired], ["left", "right"])

    @async_test
    async def test_machine_max_entries_blocked_transition_quiesces_done(self) -> None:
        self.store_machine(
            {
                "states": [
                    {"id": "once", "entry": True, "subagent": "worker", "max_entries": 1},
                    {"id": "sink", "subagent": "worker", "max_entries": 1},
                ],
                "transitions": [
                    {"from": "once", "to": "sink"},
                    {"from": "once", "to": "sink"},
                    {"from": "once", "to": "once"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # once settles once: sink is entered (one fire), the duplicate edge and
        # the self-loop are blocked by max_entries, and the run quiesces done.
        self.assertEqual(status["state"], "done")
        once = self.state_report(status, "once")
        self.assertEqual(once["entries_used"], 1)
        self.assertEqual(once["max_entries"], 1)
        sink = self.state_report(status, "sink")
        self.assertEqual(sink["entries_used"], 1)
        self.assertEqual(status["usage"]["transitions_fired"], 1)
        blocked = self.all_events_of(result, "transition_blocked")
        self.assertEqual(len(blocked), 2)
        self.assertTrue(all(event["to"] in ("once", "sink") for event in blocked))

    @async_test
    async def test_machine_self_loop_reenters_until_guard_fails(self) -> None:
        self.host.child_outcomes["child-1"] = {
            "status": "done",
            "answer": '```json\n{"count": {"value": 1}}\n```',
        }
        self.host.child_outcomes["child-2"] = {
            "status": "done",
            "answer": '```json\n{"count": {"value": 2}}\n```',
        }
        self.host.child_outcomes["child-3"] = {
            "status": "done",
            "answer": '```json\n{"count": {"value": 3}}\n```',
        }
        self.store_machine(
            {
                "states": [
                    {
                        "id": "tick",
                        "entry": True,
                        "subagent": "worker",
                        "max_entries": 4,
                        "outputs": [{"name": "count", "type": "json"}],
                    }
                ],
                "transitions": [
                    {"from": "tick", "to": "tick", "when": {"output": "count", "path": "value", "op": "lt", "value": 3}},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        tick = self.state_report(status, "tick")
        self.assertEqual(tick["entries_used"], 3)
        self.assertEqual(len(self.host.spawn_calls("tick")), 3)
        self.assertEqual(status["usage"]["transitions_fired"], 2)

    @async_test
    async def test_machine_max_transitions_pauses_once_then_resumes(self) -> None:
        self.store_machine(
            {
                "run": {"max_transitions": 1, "failure_policy": "continue"},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "a", "to": "b"},
                    {"from": "b", "to": "c"},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        # a->b fired (cap 1); b's settle pauses the run before b->c
        self.assertEqual(paused["state"], "paused")
        # the max_transitions pause uses its OWN milestone kind, distinct from
        # the run-budget pause's budget_exceeded (no kind collision)
        self.assertIn("max_transitions_exceeded", self.host.notice_kinds())
        self.assertNotIn("budget_exceeded", self.host.notice_kinds())
        self.assertEqual(paused["usage"]["transitions_fired"], 1)
        self.assertEqual(self.state_report(paused, "b")["status"], "done")
        self.assertEqual(self.state_report(paused, "c")["entries_used"], 0)
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(resumed["state"], "running")
        final = await self.settle(result)
        # resume is the explicit operator override: the remaining transition fires
        self.assertEqual(final["state"], "done")
        self.assertEqual(final["usage"]["transitions_fired"], 2)
        self.assertEqual(self.state_report(final, "c")["status"], "done")

    @async_test
    async def test_machine_max_transitions_pause_mid_settle_does_not_refire_on_resume(self) -> None:
        # Regression (review finding): cap=1 with a fan-out settle
        # [a->b, a->c]. The pause lands AFTER a->b fired; resume must
        # continue with a->c only — a->b must never fire twice.
        self.store_machine(
            {
                "run": {"max_transitions": 1, "failure_policy": "continue"},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "a", "to": "b"},
                    {"from": "a", "to": "c"},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        self.assertIn("max_transitions_exceeded", self.host.notice_kinds())
        # a->b fired before the pause; a->c is the paused transition
        self.assertEqual(self.state_report(paused, "b")["entries_used"], 1)
        self.assertEqual(self.state_report(paused, "c")["entries_used"], 0)
        self.assertEqual(paused["usage"]["transitions_fired"], 1)
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        # exactly one entry of each target: the pre-pause fire is not repeated
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.state_report(final, "b")["entries_used"], 1)
        self.assertEqual(self.state_report(final, "c")["entries_used"], 1)
        self.assertEqual(len(self.host.spawn_calls("b")), 1)
        self.assertEqual(final["usage"]["transitions_fired"], 2)

    @async_test
    async def test_machine_join_paused_at_max_transitions_fires_after_resume(self) -> None:
        # Regression (bot review): a join transition that reaches the
        # max_transitions boundary was marked fired BEFORE the pause, so
        # the resume skipped it forever and the join target never entered.
        # The provisional mark must be cleared when the settle is re-queued.
        self.store_machine(
            {
                "run": {"max_transitions": 1, "failure_policy": "continue"},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "entry": True, "subagent": "worker"},
                    {"id": "c", "subagent": "worker", "max_entries": 2},
                ],
                "transitions": [
                    {"from": "a", "to": "c"},
                    {"from": ["a", "b"], "to": "c"},
                ],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        self.assertIn("max_transitions_exceeded", self.host.notice_kinds())
        # a->c fired before the pause; the join is the paused transition
        self.assertEqual(self.state_report(paused, "c")["entries_used"], 1)
        self.assertEqual(paused["usage"]["transitions_fired"], 1)
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        # the join fired after the resume: c has TWO entries, never one
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.state_report(final, "c")["entries_used"], 2)
        joins = [e for e in self.all_events_of(result, "transition_fired") if e.get("from") == ["a", "b"]]
        self.assertEqual(len(joins), 1)
        self.assertEqual(len(self.host.spawn_calls("c")), 2)
        self.assertEqual(final["usage"]["transitions_fired"], 2)

    @async_test
    async def test_machine_guards_compare_json_strictly(self) -> None:
        # eq: a bool never equals a number (true != 1) and a number never
        # equals a string; numbers compare numerically (1 == 1.0).
        self.host.outcomes["pick"] = {
            "status": "done",
            "answer": '```json\n{"pick": {"approved": true}}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "pick", "entry": True, "subagent": "worker", "outputs": [{"name": "pick", "type": "json"}]},
                    {"id": "boolish", "subagent": "worker"},
                    {"id": "numish", "subagent": "worker"},
                    {"id": "strish", "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "pick", "to": "boolish", "when": {"output": "pick", "path": "approved", "op": "eq", "value": True}},
                    {"from": "pick", "to": "numish", "when": {"output": "pick", "path": "approved", "op": "eq", "value": 1}},
                    {"from": "pick", "to": "strish", "when": {"output": "pick", "path": "approved", "op": "eq", "value": "true"}},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.state_report(status, "boolish")["status"], "done")
        self.assertEqual(self.state_report(status, "numish")["entries_used"], 0)
        self.assertEqual(self.state_report(status, "strish")["entries_used"], 0)

        self.host.outcomes["num"] = {
            "status": "done",
            "answer": '```json\n{"num": {"value": 1.0}}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "num", "entry": True, "subagent": "worker", "outputs": [{"name": "num", "type": "json"}]},
                    {"id": "floats", "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "num", "to": "floats", "when": {"output": "num", "path": "value", "op": "eq", "value": 1}},
                ],
            },
            spec_id="numeric",
        )
        result = await self.start("numeric")
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.state_report(status, "floats")["status"], "done")

        # ne is the strict complement: true != 1 fires.
        self.host.outcomes["flag"] = {
            "status": "done",
            "answer": '```json\n{"flag": {"on": true}}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "flag", "entry": True, "subagent": "worker", "outputs": [{"name": "flag", "type": "json"}]},
                    {"id": "notone", "subagent": "worker"},
                ],
                "transitions": [
                    {"from": "flag", "to": "notone", "when": {"output": "flag", "path": "on", "op": "ne", "value": 1}},
                ],
            },
            spec_id="necheck",
        )
        result = await self.start("necheck")
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.state_report(status, "notone")["status"], "done")

    def test_json_output_binds_from_the_fence_that_carries_the_port(self) -> None:
        # several fences: the port rides whichever block carries it, so a
        # verdict fence followed by a summary fence still binds the port
        two_fences = '```json\n{"o": 1}\n```\n\n```json\n{"summary": "s"}\n```'
        self.assertEqual(_parse_json_output(two_fences, "o"), (1, None))
        self.assertEqual(_parse_json_output(two_fences, "summary"), ("s", None))
        # a port in several fences binds from the trailing block
        both = '```json\n{"o": "first"}\n```\n\n```json\n{"o": "last"}\n```'
        self.assertEqual(_parse_json_output(both, "o"), ("last", None))
        # no fence carries the port: fall back to the whole answer, then fail
        self.assertEqual(_parse_json_output('{"o": 2}', "o"), (2, None))
        value, error = _parse_json_output(two_fences, "missing")
        self.assertIsNone(value)
        self.assertIn("no JSON object containing output 'missing'", error)

    def test_guard_primitives_json_strict_and_defensive(self) -> None:
        outputs = {"verdict": {"approved": True, "count": 1.0, "tags": ["a"]}}
        when = lambda **kw: {"output": "verdict", **kw}  # noqa: E731
        # bool vs number never equal, either way
        self.assertFalse(_guard_passes(when(path="approved", op="eq", value=1), outputs))
        self.assertFalse(_guard_passes(when(path="approved", op="eq", value=0), outputs))
        self.assertTrue(_guard_passes(when(path="approved", op="ne", value=1), outputs))
        # numbers compare numerically
        self.assertTrue(_guard_passes(when(path="count", op="eq", value=1), outputs))
        self.assertTrue(_guard_passes(when(path="count", op="lte", value=1.5), outputs))
        # contains works on lists; an empty needle is defensively False
        self.assertTrue(_guard_passes(when(path="tags", op="contains", value=["a"]), outputs))
        self.assertFalse(_guard_passes(when(path="tags", op="contains", value=[]), outputs))
        # a missing port fails every op except exists (explicitly false)
        self.assertFalse(_guard_passes(when(path="gone", op="ne", value=1), outputs))
        self.assertFalse(_guard_passes(when(path="gone", op="exists"), outputs))
        self.assertTrue(_guard_passes(when(path="approved", op="exists"), outputs))
        # large JSON integers compare exactly: no lossy float conversion
        # (9007199254740993 and 9007199254740992 are distinct under eq/ne)
        big = {"verdict": {"n": 9007199254740993}}
        self.assertTrue(_guard_passes(when(path="n", op="eq", value=9007199254740993), big))
        self.assertFalse(_guard_passes(when(path="n", op="eq", value=9007199254740992), big))
        self.assertTrue(_guard_passes(when(path="n", op="ne", value=9007199254740992), big))
        # numeric cross-type equality stays exact too
        self.assertTrue(_guard_passes(when(path="count", op="eq", value=1.0), outputs))

    @async_test
    async def test_machine_stall_fails_with_the_pending_entry_reason(self) -> None:
        # An entry whose input source is never entered cannot bind: the loop
        # must end the run failed naming the stuck state, not hang or misreport.
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                    {"id": "b", "subagent": "worker", "inputs": [{"name": "i", "type": "text", "from": "c.o"}]},
                    {"id": "c", "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                ],
                "transitions": [{"from": "a", "to": "b"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        b = self.state_report(status, "b")
        self.assertEqual(b["status"], "pending")
        stall_events = self.events_of(status, "executor_error")
        self.assertEqual(len(stall_events), 1)
        self.assertIn("pending entry of state 'b'", stall_events[0]["error"])
        self.assertIn("never settled", stall_events[0]["error"])
        self.assertIn("failed", self.host.notice_kinds())

    @async_test
    async def test_machine_optional_input_binds_null_then_the_real_settle(self) -> None:
        # The closed review/fix loop shape: reviewing's fix-report input is
        # optional, so its first entry binds the null sentinel before the
        # fixer ever runs; the re-entry re-binds the real fix report.
        self.host.child_outcomes["child-1"] = {"status": "done", "answer": "GO"}
        self.host.child_outcomes["child-2"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": false, "findings": ["AUDIT-A1"]}}\n```',
        }
        self.host.child_outcomes["child-3"] = {
            "status": "done",
            "answer": '```json\n{"fix": {"fixed": ["AUDIT-A1"]}}\n```',
        }
        self.host.child_outcomes["child-4"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": true, "findings": []}}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker", "outputs": [{"name": "go", "type": "text"}]},
                    {
                        "id": "rev",
                        "subagent": "worker",
                        "inputs": [
                            {"name": "go", "type": "text", "from": "seed.go"},
                            {"name": "fix", "type": "json", "from": "fixer.fix", "optional": True},
                        ],
                        "outputs": [{"name": "verdict", "type": "json"}],
                        "max_entries": 4,
                    },
                    {
                        "id": "fixer",
                        "subagent": "worker",
                        "inputs": [{"name": "verdict", "type": "json", "from": "rev.verdict"}],
                        "outputs": [{"name": "fix", "type": "json"}],
                        "max_entries": 2,
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "rev"},
                    {"from": "rev", "to": "fixer", "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False}},
                    {"from": "fixer", "to": "rev"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        rev_prompts = [call["prompt"] for call in self.host.spawn_calls("rev")]
        self.assertEqual(len(rev_prompts), 2)
        # round 1: the fixer never settled, so the optional input bound null
        self.assertIn("null", rev_prompts[0])
        self.assertNotIn("AUDIT-A1", rev_prompts[0])
        # round 2: the re-entry re-bound the fixer's captured fix report
        self.assertIn("AUDIT-A1", rev_prompts[1])
        rev = self.state_report(status, "rev")
        self.assertEqual(rev["entries_used"], 2)
        self.assertEqual(self.state_report(status, "fixer")["entries_used"], 1)
        self.assertEqual(status["usage"]["transitions_fired"], 3)

    @async_test
    async def test_machine_optional_foreach_over_expands_empty_then_the_real_settle(self) -> None:
        # Review finding (PR #3199): marking the foreach.over input
        # optional used to hit "foreach entry did not resolve its over
        # input" -- a hard failure where the required form only waits. The
        # optional over input now expands to zero items when its source
        # never settled (the same done-with-no-instances path as a settled
        # empty list), and the re-entry binds the real list.
        self.host.outcomes["src"] = {
            "status": "done",
            "answer": '```json\n{"items": ["a", "b", "c"]}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker"},
                    {
                        "id": "fan",
                        "subagent": {"prompt": "Process item {items}."},
                        "inputs": [{"name": "items", "type": "json", "from": "src.items", "optional": True}],
                        "foreach": {"over": "items", "max": 4},
                        "max_entries": 2,
                    },
                    {
                        "id": "src",
                        "subagent": "worker",
                        "outputs": [{"name": "items", "type": "json"}],
                        "max_entries": 1,
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "fan"},
                    {"from": "fan", "to": "src"},
                    {"from": "src", "to": "fan"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        # round 1: src never settled, so the optional over input expanded to
        # zero items -- the entry settled done with NO spawn and NO error.
        fan = self.state_report(status, "fan")
        self.assertEqual(fan["entries_used"], 2)
        self.assertEqual([entry["status"] for entry in fan["entries"]], ["done", "done"])
        self.assertEqual(self.all_events_of(result, "node_error"), [])
        self.assertEqual(
            [
                e["detail"]
                for e in self.all_events_of(result, "node_ready")
                if e.get("node") == "fan" and e.get("entry") == 0
            ],
            ["foreach expanded to zero items; nothing to run"],
        )
        # round 2: the re-entry bound the real list and ran one instance
        # per item (the fan->src transition after it is blocked by
        # src's max_entries).
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("fan")],
            ["Process item a.", "Process item b.", "Process item c."],
        )
        self.assertEqual(self.state_report(status, "src")["entries_used"], 1)
        self.assertEqual(status["usage"]["transitions_fired"], 3)

    @async_test
    async def test_machine_optional_input_over_an_errored_source_binds_the_null_sentinel(self) -> None:
        # Review finding (PR #3199): an optional input bound the null
        # sentinel only while its source had NO settle. Once the source
        # settled with an error, _prepare_entry still failed the dependent
        # entry ("... unavailable (latest settle status 'error')"), so one
        # failed fixer iteration killed the review/fix loop that the
        # optional input exists to enable. An errored settle is not a
        # value: the optional input binds the sentinel exactly like the
        # never-settled case and the dependent re-enters.
        self.host.child_outcomes["child-1"] = {"status": "done", "answer": "GO"}
        self.host.child_outcomes["child-2"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": false, "findings": ["AUDIT-A1"]}}\n```',
        }
        self.host.child_outcomes["child-3"] = {"status": "error", "error": "fixer exploded"}
        self.host.child_outcomes["child-4"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": true, "findings": []}}\n```',
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker", "outputs": [{"name": "go", "type": "text"}]},
                    {
                        "id": "rev",
                        "subagent": "worker",
                        "inputs": [
                            {"name": "go", "type": "text", "from": "seed.go"},
                            {"name": "fix", "type": "json", "from": "fixer.fix", "optional": True},
                        ],
                        "outputs": [{"name": "verdict", "type": "json"}],
                        "max_entries": 4,
                    },
                    {
                        "id": "fixer",
                        "subagent": "worker",
                        "inputs": [{"name": "verdict", "type": "json", "from": "rev.verdict"}],
                        "outputs": [{"name": "fix", "type": "json"}],
                        "max_entries": 2,
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "rev"},
                    {"from": "rev", "to": "fixer", "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False}},
                    {"from": "fixer", "to": "rev"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        # The fixer failed, so the continue-policy run still reports
        # failed -- but the reviewer RE-ENTERED and completed instead of
        # dying at input binding over the errored source.
        self.assertEqual(status["state"], "failed")
        rev = self.state_report(status, "rev")
        self.assertEqual(rev["entries_used"], 2)
        self.assertEqual([entry["status"] for entry in rev["entries"]], ["done", "done"])
        self.assertNotIn("error", rev)
        fixer = self.state_report(status, "fixer")
        self.assertEqual(fixer["entries_used"], 1)
        self.assertEqual(fixer["error"], "fixer exploded")
        # Round 1 bound the sentinel (the fixer had not settled); round 2
        # bound the sentinel AGAIN over the errored settle.
        rev_prompts = [call["prompt"] for call in self.host.spawn_calls("rev")]
        self.assertEqual(len(rev_prompts), 2)
        self.assertIn("- fix: null", rev_prompts[0])
        self.assertIn("- fix: null", rev_prompts[1])
        self.assertEqual(len(self.host.spawn_calls("fixer")), 1)

    @async_test
    async def test_machine_optional_foreach_over_an_errored_source_expands_empty(self) -> None:
        # The errored-settle sentinel carries to the optional foreach.over
        # input: an errored source expands to zero items, the same
        # done-with-no-instances path as the never-settled optional over --
        # the entry proceeds instead of failing at binding.
        self.host.outcomes["src"] = {"status": "error", "error": "src exploded"}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker"},
                    {
                        "id": "fan",
                        "subagent": {"prompt": "Process item {items}."},
                        "inputs": [{"name": "items", "type": "json", "from": "src.items", "optional": True}],
                        "foreach": {"over": "items", "max": 4},
                        "max_entries": 2,
                    },
                    {
                        "id": "src",
                        "subagent": "worker",
                        "outputs": [{"name": "items", "type": "json"}],
                        "max_entries": 1,
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "fan"},
                    {"from": "fan", "to": "src"},
                    {"from": "src", "to": "fan"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        # Round 1: src never settled -> empty expansion. Round 2: src
        # settled with an ERROR -> empty expansion again, never a spawn
        # and never a binding failure on the fan entries.
        fan = self.state_report(status, "fan")
        self.assertEqual(fan["entries_used"], 2)
        self.assertEqual([entry["status"] for entry in fan["entries"]], ["done", "done"])
        self.assertNotIn("error", fan)
        self.assertEqual(self.host.spawn_calls("fan"), [])
        self.assertEqual(
            [e for e in self.all_events_of(result, "node_error") if e.get("node") == "fan"],
            [],
        )
        self.assertEqual(
            [e["detail"] for e in self.all_events_of(result, "node_ready") if e.get("node") == "fan"],
            ["foreach expanded to zero items; nothing to run"] * 2,
        )

    @async_test
    async def test_optional_input_waits_for_a_live_upstream_before_spawning(self) -> None:
        # M3: an optional input over ANOTHER state that is still running
        # must not bind its null sentinel yet — the sentinel spawned the
        # dependent while its upstream was in flight (the children exited
        # "waiting" and the state bookkeeping counted them). The entry
        # waits for the in-flight source's settle, then binds the real
        # value; a source with no live entry keeps the loop-form sentinel.
        self.host.outcomes["impl"] = {"status": "running"}
        self.host.outcomes["validate"] = {"status": "done", "answer": "VALIDATED"}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker"},
                    {
                        "id": "impl",
                        "subagent": "worker",
                        "outputs": [{"name": "result", "type": "text"}],
                    },
                    {
                        "id": "validate",
                        "subagent": {"prompt": "Validate the build at {result}."},
                        "inputs": [
                            {"name": "result", "type": "text", "from": "impl.result", "optional": True}
                        ],
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "impl"},
                    {"from": "seed", "to": "validate"},
                ],
            }
        )
        result = await self.start()
        # impl is admitted and still running; the loop must prepare nothing.
        await self.wait_until(lambda: len(self.host.spawn_calls("impl")) == 1)
        await self.wait_until(lambda: self.host.collects >= 3)
        self.assertEqual(self.host.spawn_calls("validate"), [])
        # The upstream settles with a real value; validate spawns with it
        # bound, never the null sentinel.
        self.host.outcomes["impl"] = {"status": "done", "answer": "WTREE-A1"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        validate_calls = self.host.spawn_calls("validate")
        self.assertEqual(len(validate_calls), 1)
        self.assertIn("WTREE-A1", validate_calls[0]["prompt"])
        self.assertNotIn("None", validate_calls[0]["prompt"])

    @async_test
    async def test_capture_retry_rebinds_a_settle_that_raced_the_answer_capture(self) -> None:
        # M2: the host can settle a child with no captured answer yet (the
        # capture recovers on a later refresh). The settle-capture retry
        # re-collects the settled child once and re-runs the capture, so
        # the declared output binds instead of leaving the settle empty
        # and failing the downstream bind.
        self.host = LateAnswerHost(clock=self.clock, late_children={"child-2"})
        repatch = patch.object(rlm_module, "host_request", self.host)
        repatch.start()
        self.addCleanup(repatch.stop)
        self.host.outcomes["build"] = {
            "status": "done",
            "answer": '```json\n{"built": "BIN-A1"}\n```',
        }
        self.host.outcomes["use"] = {"status": "done", "answer": "USED"}
        self.store_machine(
            {
                "run": {"failure_policy": "escalate", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker"},
                    {
                        "id": "build",
                        "subagent": "worker",
                        "outputs": [{"name": "built", "type": "json"}],
                    },
                    {
                        "id": "use",
                        "subagent": {"prompt": "Use {built}."},
                        "inputs": [{"name": "built", "type": "json", "from": "build.built"}],
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "build"},
                    {"from": "build", "to": "use"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        # The first collect of the build child settled it with no answer;
        # the capture retry re-collected and the port bound.
        self.assertEqual(self.host.collects_of.get("child-2"), 1)
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("use")],
            ['Use "BIN-A1".'],
        )
        self.assertEqual(self.all_events_of(result, "output_capture_failed"), [])

    @async_test
    async def test_child_exit_captures_a_provisional_answer_and_marks_needs_verify(self) -> None:
        # M4: a child that dies without reporting is distinguishable from
        # completed work. The exit envelope's last assistant text is
        # captured as a PROVISIONAL answer, the state's entry row reports
        # needs_verify with that answer, and status() carries the
        # root-visible needs_verify signal — the exit never silently
        # counts as settled work.
        self.host.child_outcomes["child-1"] = {
            "status": "error",
            "error": "worker exited mid-flight",
            "answer": "The CI gate ran clean on lane A; the report is at /tmp/report.md.",
        }
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "work", "entry": True, "subagent": "worker"},
                ],
                "transitions": [],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["needs_verify"], ["work"])
        work = self.state_report(status, "work")
        self.assertEqual(work["needs_verify"], True)
        entry_row = work["entries"][0]
        self.assertEqual(entry_row["status"], "error")
        self.assertEqual(entry_row["needs_verify"], True)
        self.assertIn("report is at /tmp/report.md", entry_row["provisional_answer"])
        self.assertEqual(
            [event["node"] for event in self.all_events_of(result, "needs_verify")],
            ["work"],
        )
        # The exit is not silently counted as a settled answer: the usage
        # stays a plain error settle and no answer_captured row lands.
        self.assertEqual(self.all_events_of(result, "answer_captured"), [])
        self.assertEqual(status["usage"]["settled"], 1)

    @async_test
    async def test_late_sibling_exit_after_terminal_entry_still_marks_needs_verify(self) -> None:
        # Review finding (Macroscope): a foreach sibling exiting with a
        # provisional answer AFTER its entry already went terminal (a
        # sibling failed it first) hit _apply_entry_failure_policy's
        # terminal guard before the needs_verify mark: the exit capture
        # kept the answer on the instance, but entry.needs_verify stayed
        # unset and no needs_verify event fired -- the late exit's work
        # vanished from every verify surface. The mark now runs before the
        # terminal guard, independently of the entry's failure policy.
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": ["a", "b"]}'}
        self.store_factory(
            {
                "run": {"failure_policy": "continue", "max_parallel": 8},
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "items", "type": "json"}]},
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "depends_on": ["src"],
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 2},
                    },
                ],
            }
        )
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        # src is child-1; the fan instances are child-2 (i0) and child-3
        # (i1). i0 fails permanently with no answer: the entry goes error
        # while i1 is still running.
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom-1"}
        self.host.child_outcomes["child-3"] = {"status": "running"}
        await self.wait_until(
            lambda: any(entry.status == "error" for entry in run.states["fan"].entries)
        )
        # i1 exits NOW with a provisional answer; the entry is already
        # terminal, so only a pre-guard verify mark can surface it.
        self.host.child_outcomes["child-3"] = {
            "status": "error",
            "error": "worker exited mid-flight",
            "answer": "Lane B finished; results staged at /tmp/lane-b.md.",
        }
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["needs_verify"], ["fan"])
        fan = self.state_report(status, "fan")
        self.assertEqual(fan["needs_verify"], True)
        entry_row = fan["entries"][0]
        self.assertEqual(entry_row["status"], "error")
        self.assertEqual(entry_row["needs_verify"], True)
        self.assertIn("results staged at /tmp/lane-b.md", entry_row["provisional_answer"])
        self.assertEqual(
            [event["node"] for event in self.all_events_of(result, "needs_verify")],
            ["fan"],
        )
        # i0 failed with no answer; the entry failed exactly once, so the
        # needs_verify event stays one-shot and no retry was queued.
        self.assertEqual(len(self.host.spawn_calls("fan")), 2)
        self.assertEqual(self.all_events_of(result, "retry"), [])

    @async_test
    async def test_paused_run_status_carries_the_last_error_and_remedy(self) -> None:
        # M6: a paused run carries the LAST failed admission/bind error and
        # a one-line remedy in its status payload — no root-side
        # archaeology over pending-state lists to learn what failed.
        self.host.outcomes["src"] = {"status": "done", "answer": "no json here"}
        self.store_machine(
            {
                "run": {"failure_policy": "escalate", "max_parallel": 4},
                "states": [
                    {
                        "id": "src",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "data", "type": "json"}],
                    },
                    {
                        "id": "dep",
                        "subagent": "worker",
                        "inputs": [{"name": "data", "type": "json", "from": "src.data"}],
                    },
                ],
                "transitions": [{"from": "src", "to": "dep"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "paused")
        self.assertEqual(
            status["pause_reason"],
            "input 'data': no JSON object containing output 'data' in the upstream answer",
        )
        self.assertIn("state 'dep' failed", status["last_error"])
        self.assertIn("no JSON object containing output 'data'", status["last_error"])
        self.assertIn(f"rlm.factory.resume('{result['run_id']}')", status["remedy"])

    @async_test
    async def test_machine_required_input_over_an_errored_source_fails_the_dependent_entry(self) -> None:
        # The boundary the authoring reference pins: "their required input
        # over the failed source then fails the dependent entry". Only the
        # optional form binds the sentinel; a required input over an
        # errored source is a hard binding failure (binding failures never
        # retry), so the dependent fails without ever spawning.
        self.host.outcomes["src"] = {"status": "error", "error": "src exploded"}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker"},
                    {
                        "id": "src",
                        "subagent": "worker",
                        "outputs": [{"name": "items", "type": "json"}],
                        "max_entries": 1,
                    },
                    {
                        "id": "dep",
                        "subagent": "worker",
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "max_entries": 1,
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "src"},
                    {"from": "src", "to": "dep"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        dep = self.state_report(status, "dep")
        self.assertEqual(dep["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in dep["entries"]], ["error"])
        self.assertIn(
            "input 'items' from state 'src' is unavailable (latest settle status 'error')",
            dep["entries"][0]["error"],
        )
        self.assertEqual(self.host.spawn_calls("dep"), [])

    @async_test
    async def test_machine_optional_input_over_a_settled_source_with_no_captured_value_binds_the_null_sentinel(self) -> None:
        # Review finding (PR #3199), second no-value condition: the source
        # settled done but captured no value for the declared port (an
        # empty answer). The optional dependent proceeds on the null
        # sentinel; only the required dependent over the same valueless
        # settle fails its entry.
        self.host.outcomes["src"] = {"status": "done", "answer": ""}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker"},
                    {
                        "id": "src",
                        "subagent": "worker",
                        "outputs": [{"name": "go", "type": "text"}],
                        "max_entries": 1,
                    },
                    {
                        "id": "opt",
                        "subagent": {"prompt": "Proceed."},
                        "inputs": [{"name": "go", "type": "text", "from": "src.go", "optional": True}],
                        "max_entries": 1,
                    },
                    {
                        "id": "req",
                        "subagent": {"prompt": "Proceed."},
                        "inputs": [{"name": "go", "type": "text", "from": "src.go"}],
                        "max_entries": 1,
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "src"},
                    {"from": "src", "to": "opt"},
                    {"from": "src", "to": "req"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        opt = self.state_report(status, "opt")
        self.assertEqual(opt["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in opt["entries"]], ["done"])
        self.assertIn("- go: None", self.host.spawn_calls("opt")[0]["prompt"])
        req = self.state_report(status, "req")
        self.assertEqual(req["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in req["entries"]], ["error"])
        self.assertIn(
            "input 'go' from state 'src' has no captured output 'go'",
            req["entries"][0]["error"],
        )
        self.assertEqual(self.host.spawn_calls("req"), [])

    @async_test
    async def test_machine_optional_input_over_a_failed_json_capture_binds_the_null_sentinel(self) -> None:
        # Review finding (PR #3199), third no-value condition: the source
        # settled done, declared a json port, but its answer never parsed
        # for that port (a JSON capture failure recorded on the settle).
        # The optional dependent proceeds on the null sentinel; only the
        # required dependent over the same failed capture fails its entry.
        self.host.outcomes["src"] = {"status": "done", "answer": "no json here"}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 4},
                "states": [
                    {"id": "seed", "entry": True, "subagent": "worker"},
                    {
                        "id": "src",
                        "subagent": "worker",
                        "outputs": [{"name": "data", "type": "json"}],
                        "max_entries": 1,
                    },
                    {
                        "id": "opt",
                        "subagent": {"prompt": "Proceed."},
                        "inputs": [{"name": "data", "type": "json", "from": "src.data", "optional": True}],
                        "max_entries": 1,
                    },
                    {
                        "id": "req",
                        "subagent": {"prompt": "Proceed."},
                        "inputs": [{"name": "data", "type": "json", "from": "src.data"}],
                        "max_entries": 1,
                    },
                ],
                "transitions": [
                    {"from": "seed", "to": "src"},
                    {"from": "src", "to": "opt"},
                    {"from": "src", "to": "req"},
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        opt = self.state_report(status, "opt")
        self.assertEqual(opt["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in opt["entries"]], ["done"])
        self.assertIn("- data: null", self.host.spawn_calls("opt")[0]["prompt"])
        req = self.state_report(status, "req")
        self.assertEqual(req["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in req["entries"]], ["error"])
        self.assertIn(
            "input 'data': no JSON object containing output 'data' in the upstream answer",
            req["entries"][0]["error"],
        )
        self.assertEqual(self.host.spawn_calls("req"), [])

    @async_test
    async def test_resident_node_spawns_stays_alive_and_stops(self) -> None:
        self.host.outcomes["watcher"] = {"status": "running"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "t", "subagent": "worker"},
                    {"id": "watcher", "subagent": "worker", "lifecycle": "resident"},
                ],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["t", "watcher"])
        status = await self.settle(result)
        # The task node settled; the run reports done while the resident stays
        # alive under the supervisor (V1 wake source: its own prompt/tooling).
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.node_status(status, "t")["status"], "done")
        resident = self.node_status(status, "watcher")
        self.assertEqual(resident["status"], "running")
        self.assertEqual(resident["lifecycle"], "resident")
        self.assertIn("finished", self.host.notice_kinds())
        # stop() tears the resident child down.
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["watcher"])
        self.assertEqual(self.host.deleted_targets(), ["child-2"])
        self.assertEqual((await rlm_module.rlm.factory.status(result["run_id"]))["state"], "stopped")

    @async_test
    async def test_resident_queued_instance_is_admitted_before_completion(self) -> None:
        # Review finding: _run_complete reported quiescence while a resident
        # running entry still had a PENDING instance (queued behind
        # max_parallel), so the run finalized and the resident child was
        # never admitted. A resident entry's pending instances block
        # completion; its admitted running instances never do.
        self.host.outcomes["go"] = {"status": "running"}
        # A resident child never settles: it stays alive under the parent
        # session until stop() tears it down.
        self.host.outcomes["watcher"] = {"status": "running"}
        self.store_machine(
            {
                "run": {"max_parallel": 1},
                "states": [
                    {"id": "go", "entry": True, "subagent": "worker"},
                    {"id": "watcher", "entry": True, "subagent": "worker", "lifecycle": "resident"},
                ],
                "transitions": [],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["go"])  # the resident queues behind the cap
        run = self.executor._runs[result["run_id"]]
        await self.wait_until(lambda: self.host.collects >= 2)
        watcher = run.states["watcher"]
        self.assertEqual(watcher.entries[-1].status, "running")
        self.assertEqual(watcher.entries[-1].instances[-1].status, "pending")
        # The task settles; the resident instance must be admitted next, and
        # only then may the run report completion.
        self.host.outcomes["go"] = {"status": "done", "answer": "go-done"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        resident = self.node_status(status, "watcher")
        self.assertEqual(resident["status"], "running")  # admitted, still alive
        self.assertEqual(status["usage"]["spawns"], 2)
        self.assertEqual(len(self.host.spawn_calls("watcher")), 1)
        self.assertIn("finished", self.host.notice_kinds())
        # the resident child is torn down by stop()
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["watcher"])
        self.assertEqual(self.host.deleted_targets(), ["child-2"])

    @async_test
    async def test_resident_saturated_cap_fails_the_run_instead_of_wedging(self) -> None:
        # Cursor review finding (PR #3199): with every max_parallel slot held
        # by resident instances, queued work can never be admitted -- a
        # resident never settles, so no slot ever frees, _run_complete stays
        # false, and the residents keep children in flight so the no-in-flight
        # stall detector never fires. The loop would poll forever; it now
        # fails the run with a deterministic executor error instead.
        self.host.outcomes["r1"] = {"status": "running"}  # residents never settle
        self.host.outcomes["r2"] = {"status": "running"}
        self.store_machine(
            {
                "run": {"max_parallel": 1},
                "states": [
                    {"id": "r1", "entry": True, "subagent": "worker", "lifecycle": "resident"},
                    {"id": "r2", "entry": True, "subagent": "worker", "lifecycle": "resident"},
                ],
                "transitions": [],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["r1"])  # the second resident queues behind the cap
        status = await self.settle(result)  # never leaves "running" without the fix
        self.assertEqual(status["state"], "failed")
        errors = self.events_of(status, "executor_error")
        self.assertEqual(len(errors), 1)
        self.assertEqual(
            errors[0]["error"],
            "control loop stalled: resident instances hold every max_parallel 1 slot; "
            "queued instances can never be admitted",
        )
        self.assertIn("failed", self.host.notice_kinds())
        # The queued resident was never admitted; stop() still cancels its
        # queued entry and tears the admitted child down.
        self.assertEqual(self.host.spawn_calls("r2"), [])
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["r1", "r2"])
        self.assertEqual(self.host.deleted_targets(), ["child-1"])

    @async_test
    async def test_resident_in_flight_stall_fails_the_run_instead_of_wedging(self) -> None:
        # Bugbot review finding (PR #3199): the dead-end stall check only ran
        # with NOTHING in flight, but an admitted resident never settles, so a
        # pending entry waiting on an input source that never settled kept the
        # loop polling collect forever (in_flight true, _run_complete false,
        # _resident_cap_starved false: it sees queued instances, not
        # unprepared entries). Residents can never unblock a pending entry
        # (no outputs, no outgoing transitions), so the stall detection must
        # fire with only resident instances in flight too.
        self.host.outcomes["watcher"] = {"status": "running"}  # residents never settle
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "watcher", "entry": True, "subagent": "worker", "lifecycle": "resident"},
                    {"id": "a", "entry": True, "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                    {"id": "b", "subagent": "worker", "inputs": [{"name": "i", "type": "text", "from": "c.o"}]},
                    {"id": "c", "subagent": "worker", "outputs": [{"name": "o", "type": "text"}]},
                ],
                "transitions": [{"from": "a", "to": "b"}],
            }
        )
        result = await self.start()
        self.assertEqual(result["started"], ["watcher", "a"])
        status = await self.settle(result)  # never leaves "running" without the fix
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.state_report(status, "b")["status"], "pending")
        stall_events = self.events_of(status, "executor_error")
        self.assertEqual(len(stall_events), 1)
        self.assertIn("pending entry of state 'b'", stall_events[0]["error"])
        self.assertIn("never settled", stall_events[0]["error"])
        self.assertIn("failed", self.host.notice_kinds())
        # stop() still tears the resident child down and cancels the stuck
        # entries; the never-entered source state c reads cancelled too.
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["cancelled"], ["watcher", "b", "c"])
        self.assertEqual(self.host.deleted_targets(), ["child-1"])

    @async_test
    async def test_resume_bumps_the_loop_generation_no_double_admission(self) -> None:
        # Review finding (resume race): the pause-path control loop can still
        # be winding down (an in-flight milestone await) when resume() lands.
        # resume() bumps the loop generation FIRST, so the old loop exits at
        # its next check instead of continuing as a SECOND concurrent loop.
        # The admission below is gated mid-spawn so a stale loop that wrongly
        # continued would re-admit the SAME pending instance (a duplicate
        # child) while the new loop's admission is still in flight.
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.host.rate_limit_first["b"] = 1  # resume()'s admission defers once
        progress_gate = self.host.gate("factory.progress", 1)
        progress_entered = self.host.gate_entered("factory.progress", 1)
        # rlm.run call #1 is a's admission at run(); #2 is b's first admission
        # at resume() (rate limited, deferred nonblockingly); the gate holds
        # call #3 -- the NEW loop's retry admission -- mid-spawn.
        spawn_gate = self.host.gate("rlm.run", 3)
        self.store_factory(
            {
                "nodes": [
                    {"id": "a", "subagent": "worker"},
                    {"id": "b", "subagent": "worker", "depends_on": ["a"]},
                ],
            }
        )
        result = await self.start()
        # a fails: escalate pauses, and the pause-path loop suspends inside
        # the gated milestone host request (still winding down).
        await progress_entered.wait()
        run = self.executor._runs[result["run_id"]]
        self.assertEqual(run.state, "paused")
        old_task = run.task
        self.assertIsNotNone(old_task)
        self.assertFalse(old_task.done())
        # resume() bumps the generation, fires a->b, defers b's first
        # admission (rate limited, nonblocking), and starts the new loop.
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(resumed["state"], "running")
        self.assertEqual(resumed["started"], [])
        self.assertIsNot(run.task, old_task)
        # Releasing the milestone lets the old loop continue: with the
        # generation bump it must exit without admitting anything (the new
        # loop owns b, suspended mid-admission at the spawn gate).
        progress_gate.set()
        await old_task
        self.assertTrue(old_task.done())
        spawn_gate.set()
        final = await self.settle(result)
        self.assertEqual(final["state"], "failed")
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        # b has exactly two admissions: the deferred one at resume() and
        # the new loop's successful retry. A stale second loop would admit
        # it once more while the gated spawn was in flight.
        self.assertEqual(len(self.host.spawn_calls("b")), 2)
        self.assertEqual(self.all_events_of(result, "executor_error"), [])
        self.assertEqual(
            len([e for e in self.all_events_of(result, "state_entry") if e.get("node") == "b"]), 1
        )

    @async_test
    async def test_long_state_ids_spawn_distinct_sibling_names(self) -> None:
        # Review finding: truncating the state id to 20 characters made two
        # states sharing a prefix produce the same sibling name, and the
        # second admission failed the supervisor's unique-name requirement.
        # The digest token keeps every admission name unique.
        self.store_machine(
            {
                "run": {"max_parallel": 8},
                "states": [
                    {"id": "collect-findings-pass-one", "entry": True, "subagent": "worker"},
                    {"id": "collect-findings-pass-two", "entry": True, "subagent": "worker"},
                ],
                "transitions": [],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        names = [call["kwargs"]["name"] for call in self.host.calls_of("rlm.run")]
        self.assertEqual(len(names), 2)
        self.assertNotEqual(names[0], names[1])
        self.assertTrue(all(name.startswith("sw-collect-findings-") for name in names))
        self.assertTrue(all(len(name) <= 64 for name in names))
        # both states ran to completion: neither admission failed
        self.assertEqual(self.node_status(status, "collect-findings-pass-one")["status"], "done")
        self.assertEqual(self.node_status(status, "collect-findings-pass-two")["status"], "done")


# ---------------------------------------------------------------------------
# Graph and watch (the fused machine view + the bounded wait)
# ---------------------------------------------------------------------------


class FactoryGraphWatchTest(_ExecutorTestCase):
    """The graph snapshot (structure fused with live state), the bounded
    watch, and the host bridge's out-of-band activity handler. The shared
    executor setUp isolates the agent dir and writes the enabled setting,
    so every graph/watch/activity test runs through the live opt-in gate."""

    def setUp(self) -> None:
        super().setUp()
        self.harness.create_subagent("Researcher", "Collect the findings.", id="researcher")
        self.harness.create_factory("Factory", "Factory content", id="sw", machine=valid_machine())

    # -- helpers -------------------------------------------------------------

    async def settle(self, run_result: dict[str, Any], *, max_polls: int = 50_000) -> dict[str, Any]:
        run_id = run_result["run_id"]
        for _ in range(max_polls):
            run = self.executor._runs[run_id]
            if run.state != "running":
                return await rlm_module.rlm.factory.status(run_id)
            await yield_loop_turn()
        self.fail(f"run {run_id} never left the running state")

    # -- graph: structure fusion ---------------------------------------------

    @async_test
    async def test_graph_fuses_structure_and_live_state(self) -> None:
        result = await self.start()
        run_id = result["run_id"]
        self.clock.advance(12.0)
        graph = await rlm_module.rlm.factory.graph(run_id)
        # identity + live run state
        self.assertEqual(graph["run_id"], run_id)
        self.assertEqual(graph["spec_id"], "sw")
        self.assertEqual(graph["state"], "running")
        self.assertEqual(graph["elapsed_ms"], 12_000)
        self.assertEqual(graph["budget"], {"limit_ms": 600_000, "consumed_ms": 12_000})
        # the static structure: states, transitions, order, run block
        machine = graph["machine"]
        self.assertEqual(machine["order"], ["collect", "reviewing", "fixing"])
        collect = next(s for s in machine["states"] if s["id"] == "collect")
        self.assertTrue(collect["entry"])
        self.assertEqual(collect["lifecycle"], "task")
        self.assertEqual(machine["run"]["max_parallel"], 4)
        self.assertEqual(machine["run"]["failure_policy"], "continue")
        self.assertEqual(machine["run"]["budget_ms"], 600_000)
        # the machine block is the validated configuration: the declared
        # run limits ride it (the fixture declares none, so the canonical
        # default surfaces).
        self.assertEqual(machine["run"]["max_transitions"], 40)
        self.assertEqual(machine["run"]["max_children"], RUN_MAX_CHILDREN_DEFAULT)
        guarded = next(
            t for t in machine["transitions"] if t["to"] == "fixing"
        )
        self.assertEqual(guarded["from"], "reviewing")
        self.assertEqual(guarded["when"]["output"], "verdict")
        # the live overlay rides the status() node shape
        self.assertEqual([n["id"] for n in graph["nodes"]], ["collect", "reviewing", "fixing"])
        self.assertIn("collect", graph["active_nodes"])
        self.assertEqual(graph["usage"]["spawns"], len(result["started"]))
        self.assertTrue(graph["events"], "the ledger tail rides the snapshot")

    @async_test
    async def test_graph_machine_carries_the_declared_run_limits(self) -> None:
        # Macroscope review finding: the machine block omitted the
        # canonical `run.max_children` — the total-admission limit that
        # governs execution — so a consumer could not reconstruct the
        # validated configuration from the graph. The declared value
        # rides beside max_parallel/max_transitions.
        self.store_machine(
            {
                "run": {"max_children": 2},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                ],
                "transitions": [{"from": "a", "to": "b"}],
            },
            spec_id="limits",
        )
        result = await self.start("limits")
        graph = await rlm_module.rlm.factory.graph(result["run_id"])
        self.assertEqual(graph["machine"]["run"]["max_children"], 2)
        self.assertEqual(
            graph["machine"]["run"]["max_parallel"], RUN_MAX_PARALLEL_DEFAULT
        )

    @async_test
    async def test_graph_nodes_carry_per_stage_agent_counts(self) -> None:
        # The factory page reads as a page of machine diagrams with
        # PER-STAGE AGENT COUNTS (how many agents run at each stage and
        # how many queue behind them), so the graph reply's node rows
        # carry the stage occupancy at the seam: ``running`` (admitted
        # children in flight) and ``queued`` (prepared instances
        # waiting for a parallel slot). Both keys are single words, so
        # the activity lane's camelCase conversion carries them
        # unchanged, and ``status()`` shares the same node shape.
        self.host.outcomes["collect"] = {"status": "running"}
        result = await self.start()
        run_id = result["run_id"]
        graph = await rlm_module.rlm.factory.graph(run_id)
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["collect"]["running"], 1, "the admitted instance is in flight")
        self.assertEqual(nodes["collect"]["queued"], 0)
        self.assertEqual(nodes["reviewing"]["running"], 0)
        self.assertEqual(
            nodes["reviewing"]["queued"], 0, "the state waits on its input; nothing is prepared"
        )
        # The wire lane carries the same counts under the same keys.
        listed = await factory_module.default_factory_executor().activity({"action": "graph"})
        wire_nodes = {node["id"]: node for node in listed["runs"][0]["nodes"]}
        self.assertEqual(wire_nodes["collect"]["running"], 1, "the count rides the wire")
        self.assertEqual(wire_nodes["collect"]["queued"], 0)
        # A saturated run leaves prepared instances queued: two entry
        # states under a one-slot cap admit one and queue the other.
        self.harness.create_factory(
            "Saturated",
            "Two entry states under a one-slot cap.",
            id="sat",
            machine={
                "run": {"max_parallel": 1},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "entry": True, "subagent": "worker"},
                ],
            },
        )
        self.host.outcomes["a"] = {"status": "running"}
        self.host.outcomes["b"] = {"status": "running"}
        sat = await rlm_module.rlm.factory.run("sat")
        sat_id = sat["run_id"]
        graph = await rlm_module.rlm.factory.graph(sat_id)
        nodes = {node["id"]: node for node in graph["nodes"]}
        self.assertEqual(nodes["a"]["running"], 1, "the single slot runs a's instance")
        self.assertEqual(nodes["a"]["queued"], 0)
        self.assertEqual(nodes["b"]["running"], 0)
        self.assertEqual(nodes["b"]["queued"], 1, "b's prepared instance waits for the slot")
        # Stopping the run drains every stage: no agent stays at a node.
        await rlm_module.rlm.factory.stop(sat_id)
        graph = await rlm_module.rlm.factory.graph(sat_id)
        nodes = {node["id"]: node for node in graph["nodes"]}
        for node in nodes.values():
            self.assertEqual(node["running"], 0, "a stopped run has no agent at any stage")
            self.assertEqual(node["queued"], 0)

    @async_test
    async def test_graph_transition_from_lists_are_snapshot_owned(self) -> None:
        # Regression (bot review): ``graph()`` exposed each transition's
        # ``from`` list by reference, so a consumer mutating the snapshot's
        # join row corrupted the active run's machine — an appended source
        # made the join wait for a state that never settles, so the
        # transition never fired. The snapshot owns its ``from``, exactly
        # like the already-copied ``when`` guard.
        self.harness.create_factory(
            "Join",
            "Join content",
            id="join",
            machine={
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "entry": True, "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
                "transitions": [{"from": ["a", "b"], "to": "c"}],
            },
        )
        result = await self.start("join")
        run_id = result["run_id"]
        graph = await rlm_module.rlm.factory.graph(run_id)
        join = next(t for t in graph["machine"]["transitions"] if t["to"] == "c")
        self.assertEqual(join["from"], ["a", "b"])
        # A consumer corrupting the snapshot never touches the run.
        join["from"].append("ghost")
        self.assertEqual(
            self.executor._runs[run_id].machine["transitions"][0]["from"], ["a", "b"]
        )
        graph_again = await rlm_module.rlm.factory.graph(run_id)
        join_again = next(
            t for t in graph_again["machine"]["transitions"] if t["to"] == "c"
        )
        self.assertEqual(join_again["from"], ["a", "b"])

    @async_test
    async def test_graph_is_status_data_plus_the_static_graph(self) -> None:
        result = await self.start()
        run_id = result["run_id"]
        status = await self.settle(result)
        graph = await rlm_module.rlm.factory.graph(run_id)
        # the fused snapshot reports exactly the status() node reports
        self.assertEqual(graph["nodes"], status["nodes"])
        self.assertEqual(graph["usage"], status["usage"])
        self.assertEqual(graph["state"], status["state"])
        # ...but graph is a pure read: status() marks recorded events
        # delivered, and a graph call must not consume that marking.
        self.executor._runs[run_id].events[0]["stage"] = "recorded"
        graph_again = await rlm_module.rlm.factory.graph(run_id)
        self.assertEqual(graph_again["events"][0]["stage"], "recorded")
        marked = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(marked["events"][0]["stage"], "delivered")

    @async_test
    async def test_graph_lists_every_live_run_and_marks_active_nodes(self) -> None:
        first = await self.start()
        await self.settle(first)
        second = await self.start()
        listing = await rlm_module.rlm.factory.graph()
        self.assertEqual([run["run_id"] for run in listing["runs"]], [first["run_id"], second["run_id"]])
        # the settled run has no active nodes; the fresh one has its entry
        # state in flight
        self.assertEqual(listing["runs"][0]["active_nodes"], [])
        self.assertIn("collect", listing["runs"][1]["active_nodes"])

    @async_test
    async def test_graph_keeps_a_failed_foreach_entrys_stage_active_while_siblings_run(self) -> None:
        # Macroscope review finding: active_nodes keyed on the aggregate
        # entry status, so a foreach entry that failed permanently
        # (failure_policy continue) while sibling instances still run
        # dropped the stage from the overlay -- the snapshot claimed no
        # node was active while its own node report carried the in-flight
        # sibling (the occupancy keys) and the run stayed live to collect
        # it. Activity rides the INSTANCE layer too, exactly like the
        # occupancy counts, so a stage with a terminal entry but live
        # children stays active.
        self.host.outcomes["src"] = {"status": "done", "answer": '{"items": ["a", "b", "c", "d", "e"]}'}
        self.store_machine(
            {
                "run": {"failure_policy": "continue", "max_parallel": 2},
                "states": [
                    {
                        "id": "src",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "items", "type": "json"}],
                    },
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "inputs": [{"name": "items", "type": "json", "from": "src.items"}],
                        "foreach": {"over": "items", "max": 5},
                    },
                ],
                "transitions": [{"from": "src", "to": "fan"}],
            },
            spec_id="fan",
        )
        result = await self.start("fan")
        run = self.executor._runs[result["run_id"]]
        # src is child-1; the two parallel slots admit fan's child-2 (fails
        # permanently) and child-3 (stays running), leaving three queued
        # behind the cap.
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom"}
        self.host.child_outcomes["child-3"] = {"status": "running"}
        for _ in range(50_000):
            if any(entry.status == "error" for entry in run.states["fan"].entries):
                break
            await yield_loop_turn()
        else:
            self.fail("the fan entry never failed")
        graph = await rlm_module.rlm.factory.graph(result["run_id"])
        fan = next(node for node in graph["nodes"] if node["id"] == "fan")
        self.assertEqual([entry["status"] for entry in fan["entries"]], ["error"])
        self.assertEqual(fan["running"], 1, "the sibling instance is still in flight")
        self.assertEqual(fan["queued"], 0)
        self.assertEqual(graph["state"], "running")
        self.assertEqual(graph["usage"]["running"], 1)
        # the stage with only a terminal entry but live children is active
        self.assertIn("fan", graph["active_nodes"])

    @async_test
    async def test_graph_of_a_stored_spec_returns_the_static_structure(self) -> None:
        graph = await rlm_module.rlm.factory.graph("sw")
        self.assertIsNone(graph["run_id"])
        self.assertEqual(graph["spec_id"], "sw")
        self.assertIsNone(graph["state"])
        self.assertEqual(graph["machine"]["order"], ["collect", "reviewing", "fixing"])
        self.assertEqual(graph["nodes"], [])
        self.assertEqual(graph["active_nodes"], [])
        self.assertEqual(graph["budget"], {"limit_ms": 600_000, "consumed_ms": 0})
        # a dag spec compiles to machine form for the graph too
        self.harness.create_factory("Dag factory", "content", id="dag", dag=valid_dag())
        dag_graph = await rlm_module.rlm.factory.graph("dag")
        self.assertEqual(dag_graph["machine"]["order"], ["collect", "fan-out", "review"])
        # unknown refs fail loudly; a corrupt spec names itself
        with self.assertRaisesRegex(ValueError, "unknown factory run or spec 'missing'"):
            await rlm_module.rlm.factory.graph("missing")
        self.harness.create_factory("Broken", "content", id="broken", dag={"nodes": [node("a")]})
        self.corrupt_spec("broken", {"nodes": []})
        with self.assertRaisesRegex(ValueError, "does not validate"):
            await rlm_module.rlm.factory.graph("broken")

    @async_test
    async def test_compact_snapshot_sheds_answers_and_carries_the_short_tail(self) -> None:
        result = await self.start()
        run_id = result["run_id"]
        await self.settle(result)
        run = self.executor._runs[run_id]
        self.assertGreaterEqual(len(run.events), 3)
        full = self.executor.graph(run_id)
        compact = self.executor.graph(run_id, compact=True)
        self.assertLessEqual(len(compact["events"]), factory_module.GRAPH_EVENTS_TAIL)
        self.assertNotIn("answer_captured", [e["kind"] for e in compact["events"]])
        self.assertIn(
            "answer_captured", [e["kind"] for e in full["events"]]
        )
        self.assertFalse(
            any("answer_preview" in node for node in compact["nodes"])
        )
        self.assertTrue(
            any("answer_preview" in node for node in full["nodes"])
        )

    @async_test
    async def test_last_fired_marks_the_recently_fired_edges(self) -> None:
        result = await self.start()
        run_id = result["run_id"]
        await self.settle(result)
        graph = await rlm_module.rlm.factory.graph(run_id)
        fired = {(tuple(e["from"]) if isinstance(e["from"], list) else e["from"], e["to"]) for e in graph["last_fired"]}
        self.assertIn(("collect", "reviewing"), fired)
        # the window bounds the report at LAST_FIRED_WINDOW edges
        self.assertLessEqual(len(graph["last_fired"]), factory_module.LAST_FIRED_WINDOW)

    # -- watch: bounded change detection --------------------------------------

    @async_test
    async def test_watch_returns_the_snapshot_when_nothing_changes(self) -> None:
        result = await self.start()
        run_id = result["run_id"]
        await self.settle(result)  # the run settles while no watcher waits
        watched = await rlm_module.rlm.factory.watch(run_id, 0)
        # the baseline is captured at watch entry, so an unchanged run
        # reports changed=False and still returns the full snapshot
        self.assertFalse(watched["changed"])
        self.assertEqual(watched["run_id"], run_id)
        self.assertIn("machine", watched)
        self.assertIn("nodes", watched)
        graph = await rlm_module.rlm.factory.graph(run_id)
        del watched["changed"]
        self.assertEqual(watched, graph)


    @async_test
    async def test_watch_blocks_until_the_run_changes(self) -> None:
        # A sleep that really waits (10ms slices, no clock advance): the
        # watch's re-arm loop yields to the loop, so the stop lands mid-wait
        # and the waiter resolves before the deadline could matter.
        self.executor._sleep_fn = turn_sleep
        result = await self.start_held_run()
        run_id = result["run_id"]
        # a real change: stop the running child while the watch waits.
        async def stopper() -> None:
            for _ in range(5):
                await yield_loop_turn()
            await rlm_module.rlm.factory.stop(run_id)

        stop_task = asyncio.ensure_future(stopper())
        watched = await rlm_module.rlm.factory.watch(run_id, 30.0)
        await stop_task
        self.assertTrue(watched["changed"])
        self.assertEqual(watched["state"], "stopped")

    @async_test
    async def test_watch_times_out_without_a_change(self) -> None:
        result = await self.start_held_run()
        run_id = result["run_id"]
        # The injected sleep advances the injected clock, so the bounded
        # timeout expires on the test lane without a wall-clock wait.
        watched = await rlm_module.rlm.factory.watch(run_id, 0.05)
        self.assertFalse(watched["changed"])
        self.assertEqual(watched["run_id"], run_id)
        self.assertEqual(watched["state"], "running")

    async def start_held_run(self) -> dict[str, Any]:
        """A run whose single child never settles (the FakeHost keeps it
        `running`), so the machine stays in flight until the test acts. The
        state id carries no dash: the fake host routes outcomes by the
        dash-split spawn name."""
        self.harness.create_subagent("Sleeper", "Never settles.", id="sleeper")
        self.harness.create_factory(
            "Held",
            "content",
            id="held",
            machine={"states": [{"id": "heldstate", "entry": True, "subagent": "sleeper"}]},
        )
        self.host.outcomes["heldstate"] = {"status": "running"}
        return await rlm_module.rlm.factory.run("held")

    @async_test
    async def test_watch_rejects_unknown_runs_and_bad_timeouts(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown factory run 'nope'"):
            await rlm_module.rlm.factory.watch("nope", 1.0)
        result = await self.start()
        with self.assertRaisesRegex(ValueError, "timeout must be a non-negative number"):
            await rlm_module.rlm.factory.watch(result["run_id"], -1)
        with self.assertRaisesRegex(ValueError, "timeout must be a non-negative number"):
            await rlm_module.rlm.factory.watch(result["run_id"], "soon")
        # NaN passes every comparison (the arithmetic checks never trip),
        # so it must be rejected by identity: a NaN deadline would reach
        # asyncio.sleep, which raises instead of returning the bounded
        # snapshot.
        with self.assertRaisesRegex(ValueError, "timeout must be a non-negative number"):
            await rlm_module.rlm.factory.watch(result["run_id"], float("nan"))

    # -- the host bridge's activity handler ------------------------------------

    @async_test
    async def test_activity_routes_every_action(self) -> None:
        result = await self.start()
        run_id = result["run_id"]
        # graph (all runs) / graph (one run) / graph (spec) — the reply
        # carries the wire's camelCase keys (_wire_payload's contract)
        listed = await factory_module.default_factory_executor().activity(
            {"action": "graph"}
        )
        self.assertEqual([run["runId"] for run in listed["runs"]], [run_id])
        one = await factory_module.default_factory_executor().activity(
            {"action": "graph", "runId": run_id}
        )
        self.assertEqual(one["runId"], run_id)
        spec_graph = await factory_module.default_factory_executor().activity(
            {"action": "graph", "specId": "sw"}
        )
        self.assertEqual(spec_graph["specId"], "sw")
        # status
        status = await factory_module.default_factory_executor().activity(
            {"action": "status", "runId": run_id}
        )
        self.assertEqual(status["runId"], run_id)
        await self.settle(result)
        # a fresh run through the activity lane, then stop it and prove
        # resume's paused-only contract from the same lane
        second = await factory_module.default_factory_executor().activity(
            {"action": "run", "specId": "sw"}
        )
        self.assertIn("runId", second)
        stopped = await factory_module.default_factory_executor().activity(
            {"action": "stop", "runId": second["runId"]}
        )
        self.assertEqual(stopped["state"], "stopped")
        with self.assertRaisesRegex(ValueError, "not paused"):
            await factory_module.default_factory_executor().activity(
                {"action": "resume", "runId": second["runId"]}
            )
        # watch through the activity lane answers with `changed` + snapshot
        watched = await factory_module.default_factory_executor().activity(
            {"action": "watch", "runId": second["runId"], "timeoutMs": 5}
        )
        self.assertIn("changed", watched)
        self.assertEqual(watched["runId"], second["runId"])

    @async_test
    async def test_activity_reply_carries_the_wire_keys(self) -> None:
        # Regression (live probe): the activity lane's replies once
        # carried the conversation API's snake_case keys while the TUI
        # parsed camelCase wire keys, so every run row dropped at the
        # identity guard and the factory view stayed empty regardless of
        # live runs. The factory_activity protocol is camelCase end to
        # end (the request frame's runId/specId/timeoutMs): the reply's
        # result payload converts every nested key to the wire spelling,
        # while the in-kernel conversation API stays snake_case.
        result = await self.start()
        run_id = result["run_id"]
        self.clock.advance(3.0)
        listed = await factory_module.default_factory_executor().activity(
            {"action": "graph"}
        )
        row = listed["runs"][0]
        self.assertEqual(row["runId"], run_id, "the wire row key is runId")
        self.assertEqual(row["specId"], "sw")
        self.assertEqual(row["state"], "running")
        self.assertEqual(row["elapsedMs"], 3_000, "elapsed_ms -> elapsedMs")
        self.assertEqual(row["budget"]["limitMs"], 600_000, "limit_ms -> limitMs")
        self.assertIn("toolUses", row["usage"], "tool_uses -> toolUses")
        self.assertIn("maxParallel", row["usage"], "max_parallel -> maxParallel")
        self.assertIn(
            "transitionsFired", row["usage"], "transitions_fired -> transitionsFired"
        )
        node = row["nodes"][0]
        self.assertIn("entriesUsed", node, "entries_used -> entriesUsed")
        self.assertIn("maxEntries", node, "max_entries -> maxEntries")
        self.assertEqual(
            row["machine"]["run"]["maxParallel"],
            4,
            "the machine run block rides the wire too",
        )
        self.assertNotIn("run_id", row, "no snake_case keys ride the wire")
        self.assertNotIn("elapsed_ms", row)
        self.assertNotIn("tool_uses", row["usage"])
        # watch and status answers ride the same wire conversion.
        watched = await factory_module.default_factory_executor().activity(
            {"action": "watch", "runId": run_id, "timeoutMs": 0}
        )
        self.assertIn("changed", watched)
        self.assertEqual(watched["runId"], run_id)
        self.assertNotIn("run_id", watched)
        status = await factory_module.default_factory_executor().activity(
            {"action": "status", "runId": run_id}
        )
        self.assertEqual(status["runId"], run_id)
        self.assertNotIn("run_id", status)
        # The conversation API keeps its snake_case keys: only the wire
        # lane converts.
        graph = await rlm_module.rlm.factory.graph(run_id)
        self.assertEqual(graph["run_id"], run_id)
        self.assertEqual(graph["elapsed_ms"], 3_000)
        self.assertIn("tool_uses", graph["usage"])
        self.assertNotIn("runId", graph)

    @async_test
    async def test_run_activity_caps_the_error_reply(self) -> None:
        # The error lane's reply rides the same wire cap as the success
        # lane: a validation error joining thousands of rows (a stored spec
        # corrupted the way a hand-edited store would be) must never
        # exceed the transport bound — the cap's fallback names the wire
        # cap (the mutation check: an uncapped error frame would carry
        # the multi-hundred-kilobyte reason raw).
        self.harness.create_factory(
            "Good", "content", id="big-spec", machine=valid_machine()
        )
        entry = self.harness.get("factory", "big-spec")
        entry.arguments["machine"] = {
            "run": {"failure_policy": "continue"},
            "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            "transitions": [{"from": "a", "to": f"missing{i}"} for i in range(6_000)],
        }
        sent: list[dict[str, Any]] = []
        patcher = patch("rlm.repl._send", sent.append)
        patcher.start()
        self.addCleanup(patcher.stop)
        await factory_module._run_activity(
            {"id": "big", "action": "run", "specId": "big-spec"}
        )
        self.assertEqual(len(sent), 1)
        frame = sent[0]
        self.assertEqual(frame["status"], "error")
        self.assertLess(
            len(json.dumps(frame)),
            factory_module.FACTORY_FRAME_CAP,
            "the error reply stays under the wire cap",
        )
        self.assertIn("wire cap", frame["reason"])

    @async_test
    async def test_activity_reply_carries_guards_verbatim(self) -> None:
        # Regression (bot review): the wire conversion re-keyed EVERY dict,
        # including a guard's comparison value — `when: {"value":
        # {"snake_key": 1}}` came back as `{"snakeKey": 1}`, displaying a
        # condition that no longer matches the executor's declared one. A
        # guard dict (``output`` + ``op``) rides the wire verbatim.
        self.harness.create_factory(
            "Guarded",
            "Guarded content",
            id="guarded",
            machine={
                "run": {"failure_policy": "continue"},
                "states": [
                    {
                        "id": "a",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "verdict", "type": "json"}],
                    },
                    {"id": "b", "subagent": "worker"},
                ],
                "transitions": [
                    {
                        "from": "a",
                        "to": "b",
                        "when": {
                            "output": "verdict",
                            "op": "contains",
                            "value": [{"snake_key": 1}],
                        },
                    },
                ],
            },
        )
        result = await self.start("guarded")
        reply = await factory_module.default_factory_executor().activity(
            {"action": "graph", "runId": result["run_id"]}
        )
        transition = reply["machine"]["transitions"][0]
        self.assertEqual(
            transition["when"],
            {"output": "verdict", "op": "contains", "value": [{"snake_key": 1}]},
            "the guard's comparison value rides the wire verbatim",
        )

    @async_test
    async def test_unscoped_graph_bounds_the_terminal_history(self) -> None:
        # Regression (bot review): the all-runs reply once constructed a
        # snapshot for EVERY run the registry retained — completed runs
        # accumulate forever, so one polling reply built an unbounded
        # payload before the wire cap could trim it. Every live run
        # reports; the terminal history keeps the newest
        # GRAPH_RUNS_WINDOW runs (by-ref snapshots stay available for
        # all of them).
        self.harness.create_factory(
            "Solo",
            "Solo content",
            id="solo",
            machine={
                "run": {"failure_policy": "continue"},
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
                "transitions": [],
            },
        )
        started = [await self.start("solo") for _ in range(25)]
        for result in started:
            await self.settle(result)
        listed = await factory_module.default_factory_executor().activity({"action": "graph"})
        ids = [run["runId"] for run in listed["runs"]]
        self.assertEqual(len(ids), factory_module.GRAPH_RUNS_WINDOW)
        newest = {run["run_id"] for run in started[-factory_module.GRAPH_RUNS_WINDOW:]}
        self.assertEqual(set(ids), newest, "the newest terminal runs report")
        # A live run reports regardless of the terminal window's bound.
        self.host.outcomes["a"] = {"status": "running"}
        live = await self.start("solo")
        listed = await factory_module.default_factory_executor().activity({"action": "graph"})
        ids = [run["runId"] for run in listed["runs"]]
        self.assertIn(live["run_id"], ids, "every live run reports")
        self.assertEqual(len(ids), factory_module.GRAPH_RUNS_WINDOW + 1)

    @async_test
    async def test_a_done_run_with_children_in_flight_reports_live(self) -> None:
        # Regression (bot review): liveness in the unscoped graph was
        # state-shaped alone, so a ``done`` run whose resident child is
        # still in flight (residents never block completion — the
        # finished milestone tells the operator to ``rlm.factory.stop()``
        # them) dropped out of the reply once it left the terminal-history
        # window: the page lost the run and its stop control while the
        # child kept running. A run with a child in flight is live: it
        # reports regardless of the window, and the window holds only
        # runs with no child in flight.
        self.harness.create_factory(
            "Resident",
            "One resident entry state.",
            id="resident",
            machine={
                "states": [
                    {"id": "watcher", "entry": True, "subagent": "worker", "lifecycle": "resident"},
                ],
                "transitions": [],
            },
        )
        self.host.outcomes["watcher"] = {"status": "running"}
        resident = await self.start("resident")
        resident_id = resident["run_id"]
        status = await self.settle(resident)
        self.assertEqual(status["state"], "done", "the resident never blocks completion")
        nodes = {node["id"]: node for node in status["nodes"]}
        self.assertEqual(nodes["watcher"]["running"], 1, "the resident child is still in flight")
        # GRAPH_RUNS_WINDOW newer drained runs push the done run outside
        # the terminal-history window; the in-flight child keeps it live.
        self.harness.create_factory(
            "Solo",
            "Solo content",
            id="solo",
            machine={
                "run": {"failure_policy": "continue"},
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
                "transitions": [],
            },
        )
        for _ in range(factory_module.GRAPH_RUNS_WINDOW):
            await self.settle(await self.start("solo"))
        listed = await factory_module.default_factory_executor().activity({"action": "graph"})
        ids = [run["runId"] for run in listed["runs"]]
        self.assertIn(resident_id, ids, "a run with a child in flight reports regardless of the window")
        self.assertEqual(len(ids), factory_module.GRAPH_RUNS_WINDOW + 1)
        resident_row = next(run for run in listed["runs"] if run["runId"] == resident_id)
        self.assertEqual(resident_row["state"], "done")
        wire_nodes = {node["id"]: node for node in resident_row["nodes"]}
        self.assertEqual(wire_nodes["watcher"]["running"], 1, "the in-flight count rides the wire")
        # Stopping drains the run: no child in flight, so the genuinely
        # terminal run (older than the window's runs) leaves the reply.
        await rlm_module.rlm.factory.stop(resident_id)
        listed = await factory_module.default_factory_executor().activity({"action": "graph"})
        ids = [run["runId"] for run in listed["runs"]]
        self.assertNotIn(resident_id, ids, "a drained run outside the window leaves the reply")
        self.assertEqual(len(ids), factory_module.GRAPH_RUNS_WINDOW)

    @async_test
    async def test_activity_validates_its_request_shape(self) -> None:
        for bad in (
            {"action": "bogus"},
            {"action": "status"},
            {"action": "watch", "runId": 5},
            {"action": "watch"},
            {"action": "graph", "specId": 5},
            {"action": "watch", "runId": "x", "timeoutMs": -1},
            {"action": "watch", "runId": "x", "timeoutMs": "soon"},
            {"action": "watch", "runId": "x", "timeoutMs": 10**9},
            {"action": "run"},
        ):
            with self.assertRaises(ValueError, msg=repr(bad)):
                await factory_module.default_factory_executor().activity(bad)

    def corrupt_spec(self, spec_id: str, spec: Any) -> None:
        entry = self.harness.get("factory", spec_id)
        entry.arguments = {"dag": spec}


# ---------------------------------------------------------------------------
# Out-of-band frame plumbing
# ---------------------------------------------------------------------------


class FactoryFrameCapTest(unittest.TestCase):
    """The reply frame's wire cap: event tails trim from the oldest end
    first (one reply's tail, or each run row's), the all-runs drop takes
    the oldest DROPPABLE row — never a live one — and a frame that cannot
    fit fails loudly."""

    def test_a_non_finite_frame_fails_loudly(self) -> None:
        # The belt: validation blocks non-finite guard values at the
        # machine's source; a frame that ever carries one anyway fails
        # loudly instead of emitting the non-JSON NaN/Infinity tokens
        # (every strict consumer of the reply would choke on them).
        frame = {
            "event": "done",
            "id": "r",
            "status": "ok",
            "result": {
                "machine": {
                    "transitions": [{"when": {"op": "eq", "value": float("nan")}}]
                }
            },
        }
        factory_module._cap_factory_frame(frame)
        self.assertEqual(frame["status"], "error")
        self.assertIn("non-finite", frame["reason"])
        clean = {"event": "done", "id": "r", "status": "ok", "result": {"runs": []}}
        factory_module._cap_factory_frame(clean)
        self.assertEqual(clean["status"], "ok")

    def test_an_oversized_error_frame_fails_loudly(self) -> None:
        # The error lane rides the same wire cap: a multi-megabyte reason
        # (an unknown id carrying a huge value) never exceeds the
        # transport bound; the cap's fallback names the wire cap, and a
        # small reason passes through untouched.
        huge_reason = "unknown factory run '" + "x" * 300_000 + "'"
        frame = {"event": "done", "id": "r", "status": "error", "reason": huge_reason}
        factory_module._cap_factory_frame(frame)
        self.assertLess(len(frame["reason"]), 10_000)
        self.assertIn("wire cap", frame["reason"])
        small = {"event": "done", "id": "r", "status": "error", "reason": "boom"}
        factory_module._cap_factory_frame(small)
        self.assertEqual(small["reason"], "boom")

    def test_an_oversized_reply_is_trimmed_then_failed(self) -> None:
        events = [
            {"kind": "settled", "seq": i, "stage": "recorded", "big": "y" * 12_000}
            for i in range(50)
        ]
        frame = {"event": "done", "id": "r", "status": "ok", "result": {"events": list(events)}}
        factory_module._cap_factory_frame(frame)
        self.assertEqual(frame["status"], "ok")
        self.assertLess(len(frame["result"]["events"]), 50)
        self.assertEqual(frame["result"]["events"][-1]["seq"], 49)
        # a single run that cannot fit under the cap keeps exactly one
        # event before failing loudly (never a silent graph truncation)
        single = {"events": [{"big": "y" * 300_000}]}
        frame = {"event": "done", "id": "r", "status": "ok", "result": dict(single)}
        factory_module._cap_factory_frame(frame)
        self.assertEqual(frame["status"], "error")
        self.assertIn("wire cap", frame["reason"])
        # a single-run graph that cannot fit under the cap fails loudly
        huge = {"result": {"machine": {"states": [{"id": "x" * 200}] * 2000}}}
        frame = {"event": "done", "id": "r", "status": "ok", **huge}
        factory_module._cap_factory_frame(frame)
        self.assertEqual(frame["status"], "error")
        self.assertIn("wire cap", frame["reason"])
        # the all-runs reply sheds its own ladder: every row's event tail
        # floors from the oldest end BEFORE any whole row drops (the
        # by-ref trim rule applied per row), so this frame keeps all 40
        # rows with their newest event instead of losing the oldest runs
        run = {"run_id": "r1", "events": [{"big": "y" * 4000}] * 20, "machine": {}}
        frame = {
            "event": "done",
            "id": "r",
            "status": "ok",
            "result": {"runs": [dict(run, run_id=f"r{i}") for i in range(40)]},
        }
        factory_module._cap_factory_frame(frame)
        self.assertEqual(frame["status"], "ok")
        rows = frame["result"]["runs"]
        self.assertEqual(len(rows), 40)
        self.assertEqual(rows[-1]["run_id"], "r39")
        self.assertTrue(all(len(row["events"]) == 1 for row in rows))

    def test_the_cap_drops_terminal_rows_before_live_ones(self) -> None:
        # The live-exactness contract under the wire cap: the oldest row
        # is LIVE (a resident run with children in flight, started before
        # the terminal history), and the bulk is structural (the machine
        # payload, not the event tail), so the tail lever cannot save the
        # frame — the drop must take terminal rows oldest-first and keep
        # the live row, never the blind oldest-first drop that would
        # strand the live run's dock count, panel, and off-guard read.
        live = {
            "runId": "r-live",
            "state": "running",
            "usage": {"running": 1},
            "events": [{"kind": "settled"}],
            "machine": {},
        }
        terminal = {
            "runId": "t1",
            "state": "done",
            "usage": {"running": 0},
            "events": [{"kind": "settled"}],
            "machine": {"states": [{"id": "s" * 2000}] * 8},
        }
        frame = {
            "event": "done",
            "id": "r",
            "status": "ok",
            "result": {
                "runs": [live] + [
                    dict(terminal, runId=f"t{i}") for i in range(1, 31)
                ]
            },
        }
        factory_module._cap_factory_frame(frame)
        self.assertEqual(frame["status"], "ok")
        rows = frame["result"]["runs"]
        self.assertEqual(rows[0]["runId"], "r-live", "the live row survived the cap")
        self.assertEqual(rows[-1]["runId"], "t30", "the newest terminal row survived")
        self.assertLess(len(rows), 31, "terminal rows dropped oldest-first to fit")

    def test_a_live_row_never_silently_drops(self) -> None:
        # The endgame: only live rows remain and the frame still cannot
        # fit — the cap fails loudly instead of silently dropping a live
        # row (a trimmed success would undercount the dock and lie to the
        # `/factory off` guard; the honest answer is the loud failure).
        live_big = {
            "runId": "r-big",
            "state": "running",
            "usage": {"running": 2},
            "events": [{"big": "y" * 300_000}],
            "machine": {},
        }
        live_small = {
            "runId": "r-small",
            "state": "paused",
            "usage": {"running": 1},
            "events": [{"kind": "settled"}],
            "machine": {},
        }
        frame = {
            "event": "done",
            "id": "r",
            "status": "ok",
            "result": {"runs": [live_big, live_small]},
        }
        factory_module._cap_factory_frame(frame)
        self.assertEqual(frame["status"], "error")
        self.assertIn("wire cap", frame["reason"])
        self.assertNotIn("result", frame)



if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# Machine library: MACHINE.md parse, render, gate, resolution, run.
#
# New-feature coverage (the machine library): the file format round-trips
# (export -> import -> identical validated spec), the import gate refuses
# invalid specs with the write-time validator's exact errors and never
# persists, library resolution is repo-first/user-second, and
# rlm.factory.run falls back to the library for machine names.
# ---------------------------------------------------------------------------


def machine_file_text(
    *,
    name: str = "sweep",
    description: str = "A machine that sweeps.",
    version: str = "1",
    author: str = "Tester",
    spec_json: str | None = None,
    frontmatter: str | None = None,
    body: str | None = None,
) -> str:
    """Build MACHINE.md text; ``frontmatter``/``body`` override the defaults."""
    if frontmatter is None:
        frontmatter = (
            "---\n"
            f"name: {name}\n"
            f"description: {description}\n"
            f"version: {version}\n"
            f"author: {author}\n"
            "---"
        )
    if body is None:
        spec_json = spec_json or json.dumps({"run": {"failure_policy": "continue"}, "states": [
            {"id": "a", "entry": True, "subagent": {"prompt": "Do the work."}}
        ]})
        body = f"# {name}\n\n```machine-spec\n{spec_json}\n```"
    return f"{frontmatter}\n\n{body}"


class MachineFileParseTest(unittest.TestCase):
    """The strict MACHINE.md format: frontmatter + one machine-spec fence."""

    def parse(self, text: str) -> "tuple[MachineFile | None, list[str]]":
        return parse_machine_file(text, source="test-MACHINE.md")

    def test_parses_frontmatter_and_spec(self) -> None:
        machine, errors = self.parse(machine_file_text())
        self.assertEqual(errors, [])
        assert machine is not None
        self.assertEqual(machine.name, "sweep")
        self.assertEqual(machine.description, "A machine that sweeps.")
        self.assertEqual(machine.version, "1")
        self.assertEqual(machine.author, "Tester")
        self.assertEqual(machine.spec["states"][0]["id"], "a")

    def test_parses_quoted_frontmatter_values(self) -> None:
        text = machine_file_text(
            frontmatter=(
                "---\n"
                'name: "sweep"\n'
                "description: 'It: reviews things.'\n"
                "version: 1\n"
                "author: Prime Agent\n"
                "---"
            )
        )
        machine, errors = self.parse(text)
        self.assertEqual(errors, [])
        assert machine is not None
        self.assertEqual(machine.name, "sweep")
        self.assertEqual(machine.description, "It: reviews things.")

    def test_missing_frontmatter_is_an_exact_error(self) -> None:
        machine, errors = self.parse("# just prose\n\n```machine-spec\n{}\n```")
        self.assertIsNone(machine)
        self.assertEqual(
            errors, ["test-MACHINE.md: MACHINE.md must start with a `---` frontmatter block"]
        )

    def test_unclosed_frontmatter_is_an_exact_error(self) -> None:
        machine, errors = self.parse("---\nname: sweep\nno close")
        self.assertIsNone(machine)
        self.assertEqual(
            errors, ["test-MACHINE.md: frontmatter is not closed (end it with a `---` line)"]
        )

    def test_unknown_and_duplicate_frontmatter_keys_are_exact_errors(self) -> None:
        machine, errors = self.parse(
            machine_file_text(frontmatter="---\nname: sweep\ndescription: A machine.\n---", body="x")
        )
        # Missing the spec fence is reported too, but the frontmatter still parsed:
        self.assertIsNone(machine)
        machine2, errors2 = self.parse(
            machine_file_text(frontmatter="---\nname: sweep\nname: again\ndescription: A machine.\n---")
        )
        self.assertIsNone(machine2)
        self.assertTrue(any("declared more than once" in error for error in errors2), errors2)
        machine3, errors3 = self.parse(
            machine_file_text(frontmatter="---\nname: sweep\ndescription: A machine.\nlicense: MIT\n---")
        )
        self.assertIsNone(machine3)
        self.assertTrue(any("unknown frontmatter key 'license'" in error for error in errors3), errors3)

    def test_missing_name_and_description_are_exact_errors(self) -> None:
        machine, errors = self.parse(
            machine_file_text(frontmatter="---\nversion: 1\nauthor: Tester\n---")
        )
        self.assertIsNone(machine)
        self.assertTrue(any("machine name must be a non-empty string" in error for error in errors), errors)
        self.assertTrue(any("frontmatter description is required" in error for error in errors), errors)

    def test_multiline_descriptions_are_rejected(self) -> None:
        # The description is one listing row by contract, so a quoted
        # frontmatter value that decodes an embedded line break is a format
        # error with its own sentence — not a machine whose listing renders
        # across several terminal lines.
        for description in ('"A machine that\\nsweeps."', '"A machine that\\rsweeps."'):
            machine, errors = self.parse(machine_file_text(frontmatter=(
                "---\nname: sweep\n"
                f"description: {description}\n"
                "version: 1\nauthor: Tester\n---"
            )))
            self.assertIsNone(machine, description)
            self.assertEqual(
                errors, ["frontmatter description must be a single line"]
            )
        self.assertEqual(
            machine_description_errors("One line, as the format requires."), []
        )

    def test_name_rules_mirror_the_skill_library(self) -> None:
        for bad in ("Sweep", "sweep x", "-sweep", "sweep-", "a" * 65):
            machine, errors = self.parse(machine_file_text(name=bad))
            self.assertIsNone(machine, bad)
            self.assertTrue(errors, bad)
        self.assertEqual(machine_name_errors("sweep-2"), [])
        self.assertEqual(machine_name_errors(""), ["machine name must be a non-empty string"])
        self.assertEqual(machine_name_errors(7), ["machine name must be a non-empty string"])
        self.assertIn("must not end with a hyphen", machine_name_errors("sweep-")[0])

    def test_plain_value_with_colon_demands_quotes(self) -> None:
        machine, errors = self.parse(
            machine_file_text(
                frontmatter="---\nname: sweep\ndescription: Reviews: everything\n---",
                body="# sweep\n\n```machine-spec\n{\"run\": {}}\n```",
            )
        )
        self.assertIsNone(machine)
        self.assertTrue(any("quote the value" in error for error in errors), errors)

    def test_no_fence_is_an_exact_error(self) -> None:
        machine, errors = self.parse(machine_file_text(body="# sweep\n\nNo spec here."))
        self.assertIsNone(machine)
        self.assertEqual(
            errors,
            ["test-MACHINE.md: MACHINE.md requires exactly one fenced ```machine-spec block; found none"],
        )

    def test_multiple_fences_are_an_exact_error(self) -> None:
        spec_json = '{"run": {"failure_policy": "continue"}, "states": [{"id": "a", "entry": true, "subagent": {"prompt": "P."}}]}'
        text = machine_file_text(body=f"# sweep\n\n```machine-spec\n{spec_json}\n```\n\n```machine-spec\n{spec_json}\n```")
        machine, errors = self.parse(text)
        self.assertIsNone(machine)
        self.assertEqual(
            errors,
            ["test-MACHINE.md: MACHINE.md requires exactly one fenced ```machine-spec block; found 2"],
        )

    def test_unterminated_fence_is_an_exact_error(self) -> None:
        text = machine_file_text(body="# sweep\n\n```machine-spec\n{\"run\": {}}")
        machine, errors = self.parse(text)
        self.assertIsNone(machine)
        self.assertEqual(errors, ["test-MACHINE.md: the ```machine-spec fence is never closed"])

    def test_fence_payload_must_be_a_json_object(self) -> None:
        machine, errors = self.parse(machine_file_text(body="# sweep\n\n```machine-spec\n[1, 2]\n```"))
        self.assertIsNone(machine)
        self.assertIn(
            "must contain a JSON object, got a list", errors[0]
        )
        machine2, errors2 = self.parse(machine_file_text(body="# sweep\n\n```machine-spec\nnot json\n```"))
        self.assertIsNone(machine2)
        self.assertTrue(errors2[0].startswith("test-MACHINE.md: the ```machine-spec block must contain a JSON object"), errors2)

    def test_other_fenced_blocks_do_not_confuse_the_scan(self) -> None:
        spec_json = '{"run": {"failure_policy": "continue"}, "states": [{"id": "a", "entry": true, "subagent": {"prompt": "P."}}]}'
        text = machine_file_text(
            body=(
                "# sweep\n\n"
                "Example prose with a json block:\n\n"
                "```json\n{\"not\": \"a machine\"}\n```\n\n"
                "```text\nplain text\n```\n\n"
                f"```machine-spec\n{spec_json}\n```"
            )
        )
        machine, errors = self.parse(text)
        self.assertEqual(errors, [])
        assert machine is not None
        self.assertEqual(machine.spec["run"]["failure_policy"], "continue")

    def test_crlf_and_bom_are_normalized(self) -> None:
        text = machine_file_text().replace("\n", "\r\n")
        machine, errors = self.parse("\ufeff" + text)
        self.assertEqual(errors, [])
        assert machine is not None
        self.assertEqual(machine.name, "sweep")


class MachineFileRenderTest(unittest.TestCase):
    """render_machine_file is byte-stable and parse-identical."""

    def render(self, spec: dict[str, Any]) -> str:
        machine = MachineFile(
            name="sweep",
            description="A machine that sweeps.",
            version="1",
            author="Tester",
            spec=spec,
        )
        return render_machine_file(machine)

    def test_render_is_byte_stable_and_round_trips(self) -> None:
        text = self.render(valid_machine())
        self.assertEqual(text, self.render(valid_machine()))
        machine, errors = parse_machine_file(text, source="rendered")
        self.assertEqual(errors, [])
        assert machine is not None
        self.assertEqual(machine.name, "sweep")
        self.assertEqual(machine.description, "A machine that sweeps.")
        self.assertEqual(machine.version, "1")
        self.assertEqual(machine.author, "Tester")
        self.assertEqual(machine.spec, valid_machine())

    def test_render_quotes_non_plain_values(self) -> None:
        machine = MachineFile(
            name="sweep",
            description="Reviews: everything, carefully.",
            version="1",
            author="Tester",
            spec={"states": [{"id": "a", "entry": True, "subagent": {"prompt": "P."}}]},
        )
        text = render_machine_file(machine)
        self.assertIn('description: "Reviews: everything, carefully."', text)
        reparsed, errors = parse_machine_file(text, source="rendered")
        self.assertEqual(errors, [])
        assert reparsed is not None
        self.assertEqual(reparsed.description, "Reviews: everything, carefully.")

    def test_render_generates_contract_prose_from_both_forms(self) -> None:
        machine_text = self.render(valid_machine())
        self.assertIn("Run: failure_policy=continue, max_parallel=4", machine_text)
        self.assertIn("States:", machine_text)
        self.assertIn("- collect (entry)", machine_text)
        self.assertIn("  input: draft (text) <- collect.findings", machine_text)
        self.assertIn("Transitions:", machine_text)
        self.assertIn("- reviewing -> fixing when verdict.approved eq false", machine_text)
        dag_text = self.render(valid_dag())
        self.assertIn("- fan-out", dag_text)
        self.assertIn("  input: items (text) <- collect.findings", dag_text)
        self.assertIn("```machine-spec", machine_text)

    def test_render_pretty_json_is_two_space_indented(self) -> None:
        text = self.render({"run": {"failure_policy": "continue"}, "states": [
            {"id": "a", "entry": True, "subagent": {"prompt": "P."}}
        ]})
        fence = text.split("```machine-spec\n", 1)[1].rsplit("```", 1)[0]
        self.assertIn('\n  "run": {\n    "failure_policy": "continue"\n  },', fence)


class MachineFileRoundTripTest(unittest.TestCase):
    """export -> import -> identical validated spec (the format round-trip)."""

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.library = root / "machines"
        self.out_dir = root / "out"

    def test_exported_file_imports_to_the_identical_spec(self) -> None:
        spec = valid_dag()
        out = self.out_dir / "shared.MACHINE.md"
        export_factory_spec(spec, out, name="sweep", description="A machine that sweeps.")
        imported = import_machine(out, target_dir=self.library)
        self.assertEqual(imported["name"], "sweep")
        self.assertTrue(imported["created"])
        stored, errors = parse_machine_file(
            (self.library / "sweep" / "MACHINE.md").read_text(encoding="utf-8"), source="stored"
        )
        self.assertEqual(errors, [])
        assert stored is not None
        self.assertEqual(validate_factory_spec(stored.spec), [])
        self.assertEqual(
            canonicalize_factory_spec(stored.spec), canonicalize_factory_spec(spec)
        )

    def test_library_export_import_export_is_byte_identical(self) -> None:
        spec = valid_machine()
        first = self.out_dir / "first.MACHINE.md"
        export_factory_spec(spec, first, name="sweep", description="A machine that sweeps.")
        import_machine(first, target_dir=self.library)
        # Export the imported library machine (verbatim copy) and re-import: bytes never move.
        second = self.out_dir / "second.MACHINE.md"
        export_machine("sweep", second, repo_dir=None, user_dir=self.library)
        self.assertEqual(first.read_text(encoding="utf-8"), second.read_text(encoding="utf-8"))
        imported = import_machine(second, target_dir=self.library)
        self.assertFalse(imported["created"])


class ImportGateTest(unittest.TestCase):
    """The import gate: invalid specs never persist, with exact errors."""

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.library = Path(temp.name) / "machines"
        self.sources = Path(temp.name) / "sources"

    def write_source(self, text: str) -> Path:
        self.sources.mkdir(parents=True, exist_ok=True)
        path = self.sources / "machine.MACHINE.md"
        path.write_text(text, encoding="utf-8")
        return path

    def test_import_persists_valid_files_verbatim(self) -> None:
        text = machine_file_text(
            description="A machine that sweeps.",
            spec_json=json.dumps(valid_dag()),
        )
        path = self.write_source(text)
        result = import_machine(path, target_dir=self.library)
        self.assertEqual(result["name"], "sweep")
        stored = self.library / "sweep" / "MACHINE.md"
        self.assertTrue(stored.is_file())
        self.assertEqual(stored.read_text(encoding="utf-8"), text)

    def test_import_preserves_crlf_and_cr_files_byte_for_byte(self) -> None:
        # The import persists the SUPPLIED file: a valid CRLF or CR machine
        # keeps its exact bytes (a read_text/write_text round trip would
        # silently rewrite every line ending), and the stored copy still
        # parses.
        text = machine_file_text(spec_json=json.dumps(valid_dag()))
        self.sources.mkdir(parents=True, exist_ok=True)
        for line_ending in ("\r\n", "\r"):
            source = self.sources / f"{len(line_ending)}-byte-newline.MACHINE.md"
            source.write_bytes(text.replace("\n", line_ending).encode("utf-8"))
            result = import_machine(source, target_dir=self.library)
            stored = Path(result["path"])
            self.assertEqual(stored.read_bytes(), source.read_bytes())
            stored_machine, errors = parse_machine_file(
                stored.read_text(encoding="utf-8"), source=str(stored)
            )
            self.assertEqual(errors, [])
            assert stored_machine is not None
            self.assertEqual(stored_machine.name, "sweep")

    def test_import_rejects_invalid_spec_with_exact_errors_and_persists_nothing(self) -> None:
        invalid_spec = {
            "run": {"max_parallel": None},
            "states": [{"id": "a", "entry": True, "subagent": {"prompt": "P."}}],
        }
        path = self.write_source(machine_file_text(spec_json=json.dumps(invalid_spec)))
        with self.assertRaises(ValueError) as ctx:
            import_machine(path, target_dir=self.library)
        self.assertIn(
            "run max_parallel must be an integer between 1 and 64", str(ctx.exception)
        )
        self.assertFalse(self.library.exists())

    def test_import_rejects_both_forms_and_guaranteed_dead_specs(self) -> None:
        both_forms = {
            "nodes": [{"id": "a", "subagent": {"prompt": "P."}}],
            "states": [{"id": "s", "subagent": {"prompt": "P."}}],
        }
        path = self.write_source(machine_file_text(spec_json=json.dumps(both_forms)))
        with self.assertRaises(ValueError) as ctx:
            import_machine(path, target_dir=self.library)
        self.assertIn("pass either dag or machine form, not both", str(ctx.exception))
        dead = {"states": [
            {"id": "start", "entry": True, "subagent": {"prompt": "P."}},
            {
                "id": "loop",
                "subagent": {"prompt": "P."},
                "inputs": [{"name": "v", "type": "text", "from": "loop.v"}],
                "outputs": [{"name": "v", "type": "text"}],
            },
        ]}
        path = self.write_source(machine_file_text(spec_json=json.dumps(dead)))
        with self.assertRaises(ValueError) as ctx:
            import_machine(path, target_dir=self.library)
        self.assertIn("cannot require itself", str(ctx.exception))
        self.assertFalse(self.library.exists())

    def test_import_rejects_malformed_files_with_format_errors(self) -> None:
        path = self.write_source("# no frontmatter here")
        with self.assertRaises(ValueError) as ctx:
            import_machine(path, target_dir=self.library)
        self.assertIn("must start with a `---` frontmatter block", str(ctx.exception))
        self.assertFalse(self.library.exists())

    def test_import_rejects_multiline_descriptions_and_persists_nothing(self) -> None:
        # A quoted description decoding an embedded newline renders the
        # machine across several listing rows: the import gate refuses it
        # with the format's own sentence, exactly like any other parse
        # failure.
        path = self.write_source(machine_file_text(frontmatter=(
            "---\nname: multiline\n"
            'description: "A machine that\\nsweeps the branch."\n'
            "version: 1\nauthor: Tester\n---"
        )))
        with self.assertRaises(ValueError) as ctx:
            import_machine(path, target_dir=self.library)
        self.assertIn("frontmatter description must be a single line", str(ctx.exception))
        self.assertFalse(self.library.exists())

    def test_import_rejects_missing_files_and_overwrites_renamed(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            import_machine(self.sources / "nope.MACHINE.md", target_dir=self.library)
        self.assertIn("machine file not found", str(ctx.exception))
        text = machine_file_text()
        first = self.write_source(text)
        import_machine(first, target_dir=self.library)
        result = import_machine(first, target_dir=self.library)
        self.assertFalse(result["created"])

    def test_import_gate_is_the_write_time_validator(self) -> None:
        # The exact sentences import_machine raises are the write-time
        # validator's: bypassing the gate must fail the reject test above.
        invalid_spec = {"states": [{"id": "a", "entry": True, "subagent": 5}]}
        path = self.write_source(machine_file_text(spec_json=json.dumps(invalid_spec)))
        with self.assertRaises(ValueError) as ctx:
            import_machine(path, target_dir=self.library)
        self.assertIn(
            "state a requires a subagent", str(ctx.exception)
        )
        self.assertFalse(self.library.exists())


class MachineLibraryResolutionTest(unittest.TestCase):
    """Repo directory first, user directory second."""

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.repo = root / "repo-machines"
        self.user = root / "user-machines"

    def store(self, root: Path, name: str, description: str, spec: dict[str, Any] | None = None) -> Path:
        directory = root / name
        directory.mkdir(parents=True, exist_ok=True)
        spec = spec if spec is not None else {"states": [
            {"id": "a", "entry": True, "subagent": {"prompt": "P."}}
        ]}
        text = machine_file_text(name=name, description=description, spec_json=json.dumps(spec))
        path = directory / "MACHINE.md"
        path.write_text(text, encoding="utf-8")
        return path

    def test_repo_dir_wins_over_user_dir(self) -> None:
        repo_path = self.store(self.repo, "sweep", "The repo machine.")
        user_path = self.store(self.user, "sweep", "The user machine.")
        machine, path = resolve_machine("sweep", repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(path, repo_path)
        self.assertEqual(machine.description, "The repo machine.")

    def test_frontmatter_name_wins_over_the_directory_name(self) -> None:
        # Mirrors the skill library: the declared name is the machine's
        # name even when its directory is named differently.
        directory = self.user / "renamed-dir"
        directory.mkdir(parents=True)
        (directory / "MACHINE.md").write_text(
            machine_file_text(name="sweep", description="The renamed machine."),
            encoding="utf-8",
        )
        machine, path = resolve_machine("sweep", repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(path, directory / "MACHINE.md")
        self.assertEqual(machine.description, "The renamed machine.")
        listed = list_machines(repo_dir=self.repo, user_dir=self.user)
        self.assertEqual([entry["name"] for entry in listed], ["sweep"])

    def test_the_declared_name_wins_over_the_directory_name(self) -> None:
        # The fast path reads <dir>/<name>/MACHINE.md but only returns it
        # when its DECLARED name matches: a directory named `misdir`
        # holding `name: actual` is not the machine `misdir` — it resolves
        # as `actual` (and a repo machine declared `sweep` is never
        # shadowed by a `sweep/` directory that declares another name).
        directory = self.user / "misdir"
        directory.mkdir(parents=True)
        (directory / "MACHINE.md").write_text(
            machine_file_text(name="actual", description="Declared, not directory-named."),
            encoding="utf-8",
        )
        machine, path = resolve_machine("actual", repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(path, directory / "MACHINE.md")
        with self.assertRaises(ValueError) as raised:
            resolve_machine("misdir", repo_dir=self.repo, user_dir=self.user)
        self.assertIn("unknown machine 'misdir'", str(raised.exception))

    def test_a_directory_named_machine_shadowing_is_refused(self) -> None:
        # repo/sweep/ declares `other`: asking for `sweep` must not return
        # that file, and a user machine legitimately named `sweep` wins.
        misnamed = self.repo / "sweep"
        misnamed.mkdir(parents=True)
        (misnamed / "MACHINE.md").write_text(
            machine_file_text(name="other", description="Not sweep."),
            encoding="utf-8",
        )
        self.store(self.user, "sweep", "The real sweep.")
        machine, path = resolve_machine("sweep", repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(path, self.user / "sweep" / "MACHINE.md")
        self.assertEqual(machine.description, "The real sweep.")

    def test_user_dir_serves_names_the_repo_does_not_have(self) -> None:
        self.store(self.repo, "repo-only", "The repo machine.")
        user_path = self.store(self.user, "mine", "The user machine.")
        machine, path = resolve_machine("mine", repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(path, user_path)
        self.assertEqual(machine.description, "The user machine.")

    def test_unknown_name_lists_available_machines(self) -> None:
        self.store(self.repo, "builder", "Builds.")
        self.store(self.user, "sweep", "Sweeps.")
        with self.assertRaises(ValueError) as ctx:
            resolve_machine("missing", repo_dir=self.repo, user_dir=self.user)
        self.assertIn("unknown machine 'missing'", str(ctx.exception))
        self.assertIn("builder", str(ctx.exception))
        self.assertIn("sweep", str(ctx.exception))

    def test_invalid_machine_name_is_rejected_before_scanning(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            resolve_machine("Not A Name", repo_dir=self.repo, user_dir=self.user)
        self.assertIn("invalid characters", str(ctx.exception))

    def test_list_machines_dedupes_repo_first_and_sorts_by_name(self) -> None:
        self.store(self.repo, "sweep", "The repo machine.")
        self.store(self.user, "sweep", "The user machine.")
        self.store(self.user, "alpha", "An early machine.")
        listed = list_machines(repo_dir=self.repo, user_dir=self.user)
        self.assertEqual([entry["name"] for entry in listed], ["alpha", "sweep"])
        sweep = next(entry for entry in listed if entry["name"] == "sweep")
        self.assertEqual(sweep["source"], "repo")
        self.assertEqual(sweep["description"], "The repo machine.")
        self.assertEqual(listed[0]["source"], "user")

    def test_list_machines_skips_broken_files(self) -> None:
        good = self.store(self.user, "good", "Good machine.")
        broken = self.user / "broken" / "MACHINE.md"
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("no frontmatter", encoding="utf-8")
        listed = list_machines(repo_dir=self.repo, user_dir=self.user)
        self.assertEqual([entry["name"] for entry in listed], ["good"])

    def test_list_machines_excludes_spec_invalid_files_with_their_errors(self) -> None:
        # The listing reports only machines resolve/run can use: a repo
        # file whose spec fails the write-time validator never wins the
        # name, a valid user machine shows instead, and the exact
        # validator sentences ride the scan warnings (the CLI list
        # surface) naming the broken file.
        invalid = self.store(self.repo, "sweep", "The broken repo machine.", spec={"states": []})
        self.store(self.user, "sweep", "The user machine.")
        listed, warnings = _scan_machine_library(repo_dir=self.repo, user_dir=self.user)
        self.assertEqual([entry["name"] for entry in listed], ["sweep"])
        self.assertEqual(listed[0]["source"], "user")
        self.assertEqual(listed[0]["description"], "The user machine.")
        self.assertEqual(
            warnings,
            [f"{invalid}: factory machine must declare between 1 and 1024 states, got 0"],
        )
        self.assertEqual(list_machines(repo_dir=self.repo, user_dir=self.user)[0]["source"], "user")

    def test_resolve_machine_raises_exact_parse_errors_for_broken_files(self) -> None:
        broken = self.user / "broken" / "MACHINE.md"
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("---\nname: broken\n---\n\n```machine-spec\n{}\n```\n", encoding="utf-8")
        with self.assertRaises(ValueError) as ctx:
            resolve_machine("broken", repo_dir=self.repo, user_dir=self.user)
        self.assertIn("frontmatter description is required", str(ctx.exception))

    def test_resolve_machine_reports_non_utf8_files_as_broken(self) -> None:
        # A machine file that exists but does not decode is a broken library
        # file, exactly like one that fails to parse: the decode error rides
        # the broken frame with the SAME sentence the listing scan warns
        # with (the shared verdict's wording, path-prefixed).
        # (UnicodeDecodeError is a ValueError, so an unguarded read would
        # instead surface through run_factory's name-rule arm as an
        # invalid id.)
        corrupt = self.user / "broken" / "MACHINE.md"
        corrupt.parent.mkdir(parents=True, exist_ok=True)
        corrupt.write_bytes(b"\xff\xfe\xff not utf-8")
        with self.assertRaises(MachineResolutionError) as ctx:
            resolve_machine("broken", repo_dir=self.repo, user_dir=self.user)
        self.assertTrue(ctx.exception.broken)
        self.assertIn("not valid UTF-8", str(ctx.exception))
        self.assertIn(str(corrupt), str(ctx.exception))

    def test_resolve_machine_reports_spec_invalid_files_as_broken(self) -> None:
        # A file that parses but carries a spec the write-time validator
        # rejects is the exists-but-broken case at resolve time when it is
        # the name's only carrier — the exact broken frame naming the file,
        # never a usable machine the run rejects late, and never a missing
        # frame. The scan path below skips one in a differently-named
        # directory, so an unknown name keeps the missing frame instead of
        # resolving a spec-invalid file, and a file at the name's directory
        # that DECLARES another name never carried the requested one: the
        # invalid file claims no name on either surface.
        invalid = self.store(self.repo, "sweep", "The broken repo machine.", spec={"states": []})
        with self.assertRaises(MachineResolutionError) as ctx:
            resolve_machine("sweep", repo_dir=self.repo, user_dir=self.user)
        self.assertTrue(ctx.exception.broken)
        message = str(ctx.exception)
        self.assertIn(str(invalid), message)
        self.assertIn("factory machine must declare between 1 and 1024 states, got 0", message)
        renamed = self.repo / "renamed-dir"
        renamed.mkdir(parents=True)
        (renamed / "MACHINE.md").write_text(
            machine_file_text(
                name="ghost", description="Ghost.", spec_json=json.dumps({"states": []})
            ),
            encoding="utf-8",
        )
        with self.assertRaises(MachineResolutionError) as scan_ctx:
            resolve_machine("ghost", repo_dir=self.repo, user_dir=self.user)
        self.assertFalse(scan_ctx.exception.broken)
        self.assertIn("unknown machine 'ghost'", str(scan_ctx.exception))
        misnamed = self.repo / "warp"
        misnamed.mkdir(parents=True)
        (misnamed / "MACHINE.md").write_text(
            machine_file_text(
                name="other", description="Not warp.", spec_json=json.dumps({"states": []})
            ),
            encoding="utf-8",
        )
        with self.assertRaises(MachineResolutionError) as misnamed_ctx:
            resolve_machine("warp", repo_dir=self.repo, user_dir=self.user)
        self.assertFalse(misnamed_ctx.exception.broken)
        self.assertIn("unknown machine 'warp'", str(misnamed_ctx.exception))

    def test_list_and_resolve_agree_on_spec_invalid_files(self) -> None:
        # Cursor's finding: the scan skips a spec-invalid repo machine so
        # the listing surfaces a valid user machine of the same name, but
        # resolve still raised broken on the repo file — `factory list`
        # advertised a machine that run and export refused. Both surfaces
        # now share _read_library_machine's verdict: an invalid file never
        # claims its name, so the valid user machine serves exactly where
        # the listing shows it, and export copies it verbatim.
        self.store(self.repo, "sweep", "The broken repo machine.", spec={"states": []})
        user_path = self.store(self.user, "sweep", "The user machine.")
        listed = list_machines(repo_dir=self.repo, user_dir=self.user)
        self.assertEqual([entry["name"] for entry in listed], ["sweep"])
        self.assertEqual(listed[0]["source"], "user")
        machine, path = resolve_machine("sweep", repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(path, user_path)
        self.assertEqual(machine.description, "The user machine.")
        self.assertEqual(validate_factory_spec(machine.spec), [])
        out = self.user.parent / "exported.MACHINE.md"
        result = export_library_machine("sweep", out, repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(result["source"], "library")
        self.assertEqual(out.read_text(encoding="utf-8"), user_path.read_text(encoding="utf-8"))

    def test_resolve_falls_through_parse_broken_files_to_valid_user_machines(self) -> None:
        # The shared verdict covers every invalidity class: a repo file
        # that fails to parse claims its name no more than a spec-invalid
        # one, so the valid user machine serves on both surfaces (the
        # listing always skipped it) instead of resolve raising broken on
        # the repo file.
        broken = self.repo / "sweep" / "MACHINE.md"
        broken.parent.mkdir(parents=True)
        broken.write_text("no frontmatter", encoding="utf-8")
        user_path = self.store(self.user, "sweep", "The user machine.")
        listed = list_machines(repo_dir=self.repo, user_dir=self.user)
        self.assertEqual([entry["name"] for entry in listed], ["sweep"])
        machine, path = resolve_machine("sweep", repo_dir=self.repo, user_dir=self.user)
        self.assertEqual(path, user_path)
        self.assertEqual(machine.description, "The user machine.")

    def test_one_non_utf8_file_never_poisons_the_listing_scan(self) -> None:
        # The shared scan skips a non-decodable file like any other broken
        # one (its warning rides the CLI list surface), so it can neither
        # break the listing nor reframe an unrelated unknown name.
        self.store(self.repo, "builder", "Builds.")
        corrupt = self.user / "zz-corrupt" / "MACHINE.md"
        corrupt.parent.mkdir(parents=True, exist_ok=True)
        corrupt.write_bytes(b"\xff\xfe")
        listed, warnings = _scan_machine_library(repo_dir=self.repo, user_dir=self.user)
        self.assertEqual([entry["name"] for entry in listed], ["builder"])
        self.assertTrue(any("not valid UTF-8" in warning for warning in warnings), warnings)
        with self.assertRaises(MachineResolutionError) as ctx:
            resolve_machine("missing", repo_dir=self.repo, user_dir=self.user)
        self.assertFalse(ctx.exception.broken)
        self.assertIn("unknown machine 'missing'", str(ctx.exception))
        self.assertIn("builder", str(ctx.exception))

    def test_env_overrides_drive_the_production_dirs(self) -> None:
        env = patch.dict(os.environ, {
            "PRIME_AGENT_MACHINES_DIR": str(self.repo),
            "PRIME_AGENT_CODING_AGENT_DIR": str(Path(self.repo).parent / "agent-home"),
        })
        env.start()
        self.addCleanup(env.stop)
        self.store(self.repo, "sweep", "The repo machine.")
        self.assertEqual(repo_machines_dir(), self.repo)
        self.assertEqual(user_machines_dir(), Path(self.repo).parent / "agent-home" / "machines")
        machine, path = resolve_machine("sweep")
        self.assertEqual(path, self.repo / "sweep" / "MACHINE.md")

    def test_the_bundled_library_ships_inside_the_runtime_package(self) -> None:
        # The repo level is the packaged library: the machines directory
        # beside this module (site-packages/rlm/machines in an installed
        # kernel, src/rlm/machines in a checkout), so an installed kernel
        # resolves the seeds a checkout does. The env override still wins.
        packaged = Path(factory_module.__file__).resolve().parent / "machines"
        repo_dir = repo_machines_dir()
        self.assertEqual(repo_dir, packaged)
        self.assertTrue(packaged.is_dir())
        with patch.dict(os.environ, {"PRIME_AGENT_MACHINES_DIR": str(self.repo)}):
            self.assertEqual(repo_machines_dir(), self.repo)

    def test_the_shipped_seed_machines_validate_clean(self) -> None:
        # The repo-level library resolves as the packaged directory and the
        # shipped examples parse, validate, and canonicalize: a broken seed
        # fails here before it can ship.
        repo_dir = repo_machines_dir()
        names = {entry["name"] for entry in list_machines(repo_dir=repo_dir, user_dir=Path("/nonexistent-user-machines"))}
        self.assertIn("review-sweep", names)
        self.assertIn("builder", names)
        self.assertIn("pr-manager", names)
        for name in ("review-sweep", "builder", "pr-manager"):
            machine, path = resolve_machine(name, repo_dir=repo_dir, user_dir=Path("/nonexistent-user-machines"))
            self.assertEqual(machine.name, name)
            self.assertEqual(validate_factory_spec(machine.spec), [], name)
            self.assertEqual(validate_factory_spec(canonicalize_factory_spec(machine.spec)), [], name)
            machine_two = parse_machine_file(path.read_text(encoding="utf-8"), source=str(path))[0]
            assert machine_two is not None
            self.assertEqual(machine_two.spec, machine.spec, name)


class MachineCliDispatchTest(unittest.TestCase):
    """The JSON facade the CLI's factory subcommands drive.

    The payload carries only what the user typed (an op, a path, a name, an
    out target); the dispatch process resolves every library directory
    itself through the production env seams (`PRIME_AGENT_MACHINES_DIR`,
    `PRIME_AGENT_CODING_AGENT_DIR`), so these tests exercise the same
    resolution a real CLI invocation runs.
    """

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.repo = root / "repo-machines"
        self.agent_home = root / "agent-home"
        self.sources = root / "sources"
        self.out_dir = root / "out"
        self.source_text = machine_file_text(
            description="A machine that sweeps.", spec_json=json.dumps(valid_dag())
        )
        self.sources.mkdir(parents=True, exist_ok=True)
        self.source_path = self.sources / "machine.MACHINE.md"
        self.source_path.write_text(self.source_text, encoding="utf-8")
        env = patch.dict(os.environ, {
            "PRIME_AGENT_MACHINES_DIR": str(self.repo),
            "PRIME_AGENT_CODING_AGENT_DIR": str(self.agent_home),
        })
        env.start()
        self.addCleanup(env.stop)

    def test_import_dispatch_persists_into_the_user_library(self) -> None:
        result = cli_dispatch({"op": "import", "path": str(self.source_path)})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["name"], "sweep")
        destination = self.agent_home / "machines" / "sweep" / "MACHINE.md"
        self.assertEqual(Path(result["path"]), destination)
        self.assertEqual(destination.read_text(encoding="utf-8"), self.source_text)

    def test_import_dispatch_surfaces_gate_errors_as_data(self) -> None:
        bad = self.sources / "bad.MACHINE.md"
        bad.write_text(
            machine_file_text(spec_json=json.dumps({"run": {"max_parallel": None}, "states": [
                {"id": "a", "entry": True, "subagent": {"prompt": "P."}}
            ]})),
            encoding="utf-8",
        )
        result = cli_dispatch({"op": "import", "path": str(bad)})
        self.assertFalse(result["ok"])
        self.assertFalse((self.agent_home / "machines").exists())
        self.assertTrue(any("max_parallel must be an integer between 1 and 64" in e for e in result["errors"]), result)

    def test_export_dispatch_resolves_library_machines(self) -> None:
        import_machine(self.source_path, target_dir=self.repo)
        result = cli_dispatch({
            "op": "export",
            "name": "sweep",
            "out": str(self.out_dir / "shared.MACHINE.md"),
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["source"], "library")
        self.assertEqual(
            Path(result["path"]).read_text(encoding="utf-8"), self.source_text
        )

    def test_export_dispatch_refuses_to_overwrite_the_target(self) -> None:
        import_machine(self.source_path, target_dir=self.repo)
        target = self.out_dir / "shared.MACHINE.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("keep me", encoding="utf-8")
        result = cli_dispatch({
            "op": "export",
            "name": "sweep",
            "out": str(target),
        })
        self.assertFalse(result["ok"])
        self.assertTrue(any("already exists" in e for e in result["errors"]), result)
        self.assertEqual(target.read_text(encoding="utf-8"), "keep me")

    def test_export_dispatch_resolves_the_library_only(self) -> None:
        # A fresh CLI process has no session state, so the dispatch resolves
        # library machines only: a stored factory entry never intercepts
        # the CLI's export, even when one exists.
        self.agent_home.mkdir(parents=True, exist_ok=True)
        (self.agent_home / "settings.json").write_text(
            json.dumps({"factory": {"enabled": True}}), encoding="utf-8"
        )
        harness = HarnessState(Path(self.agent_home) / "harness_state.json")
        previous_executor = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = FactoryExecutor(harness=harness)
        self.addCleanup(lambda: setattr(factory_module, "_DEFAULT_EXECUTOR", previous_executor))
        harness.create_factory(
            "sweep", "Stored.",
            machine={"states": [{"id": "a", "entry": True, "subagent": {"prompt": "P."}}]},
        )
        result = cli_dispatch({"op": "export", "name": "sweep", "out": str(self.out_dir / "s.MACHINE.md")})
        self.assertFalse(result["ok"])
        self.assertTrue(any("unknown machine 'sweep'" in e for e in result["errors"]), result)

    def test_export_dispatch_reports_unknown_machines(self) -> None:
        result = cli_dispatch({
            "op": "export",
            "name": "ghost",
            "out": str(self.out_dir / "ghost.MACHINE.md"),
        })
        self.assertFalse(result["ok"])
        self.assertTrue(any("unknown machine 'ghost'" in e for e in result["errors"]), result)

    def test_list_dispatch_lists_the_library_with_warnings(self) -> None:
        (self.repo / "sweep").mkdir(parents=True)
        (self.repo / "sweep" / "MACHINE.md").write_text(self.source_text, encoding="utf-8")
        broken = self.agent_home / "machines" / "broken"
        broken.mkdir(parents=True)
        (broken / "MACHINE.md").write_text("no frontmatter", encoding="utf-8")
        result = cli_dispatch({"op": "list"})
        self.assertTrue(result["ok"], result)
        self.assertEqual([m["name"] for m in result["machines"]], ["sweep"])
        self.assertEqual(result["machines"][0]["source"], "repo")
        self.assertTrue(any("broken" in warning for warning in result["warnings"]), result)

    def test_dispatch_rejects_bad_payloads(self) -> None:
        self.assertEqual(cli_dispatch("nope")["ok"], False)
        missing = cli_dispatch({"op": "import"})
        self.assertFalse(missing["ok"])
        self.assertIn("requires a `path` string", missing["errors"][0])
        unknown_op = cli_dispatch({"op": "wat"})
        self.assertFalse(unknown_op["ok"])
        self.assertIn("unknown factory cli op", unknown_op["errors"][0])
        self.assertIn("'list'", unknown_op["errors"][0])


class ExportMachineTest(unittest.TestCase):
    """export_machine serializes library machines, entries, and runs."""

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.library = root / "machines"
        self.out_dir = root / "out"
        self.out_dir.mkdir(parents=True)
        self.harness = HarnessState(root / "harness_state.json")
        self.previous_executor = factory_module._DEFAULT_EXECUTOR
        self.executor = FactoryExecutor(harness=self.harness)
        factory_module._DEFAULT_EXECUTOR = self.executor
        self.addCleanup(lambda: setattr(factory_module, "_DEFAULT_EXECUTOR", self.previous_executor))
        # The opt-in gate: create_factory (below) refuses while the
        # `factory.enabled` setting is off, so the agent dir points at an
        # isolated temp dir whose settings file writes the real document
        # shape the daemon writes -- the core's enabled-fixture pattern.
        agent_temp = TemporaryDirectory()
        self.addCleanup(agent_temp.cleanup)
        self._isolate_agent_dir(agent_temp.name)
        self.write_settings({"factory": {"enabled": True}})

    def write_settings(self, document: Any) -> None:
        """Write the agent-dir settings document (the real file shape)."""
        settings_path = Path(os.environ["PRIME_AGENT_CODING_AGENT_DIR"]) / "settings.json"
        settings_path.write_text(json.dumps(document), encoding="utf-8")

    def _isolate_agent_dir(self, agent_dir: str) -> None:
        previous = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = agent_dir

        def restore() -> None:
            if previous is None:
                os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
            else:
                os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = previous

        self.addCleanup(restore)

    def test_exports_a_library_machine_verbatim(self) -> None:
        text = machine_file_text(description="A machine that sweeps.", spec_json=json.dumps(valid_dag()))
        directory = self.library / "sweep"
        directory.mkdir(parents=True)
        (directory / "MACHINE.md").write_text(text, encoding="utf-8")
        out = self.out_dir / "shared.MACHINE.md"
        result = export_machine("sweep", out, repo_dir=None, user_dir=self.library)
        self.assertEqual(result["source"], "library")
        self.assertEqual(out.read_text(encoding="utf-8"), text)

    def test_export_refuses_to_silently_overwrite_the_target(self) -> None:
        # A fresh target only: an existing file refuses (overwrite=True is
        # the explicit opt-in), so an export never clobbers a user file.
        text = machine_file_text(description="A machine that sweeps.", spec_json=json.dumps(valid_dag()))
        directory = self.library / "sweep"
        directory.mkdir(parents=True)
        (directory / "MACHINE.md").write_text(text, encoding="utf-8")
        out = self.out_dir / "shared.MACHINE.md"
        out.write_text("keep me", encoding="utf-8")
        with self.assertRaises(ValueError) as raised:
            export_machine("sweep", out, repo_dir=None, user_dir=self.library)
        self.assertIn("already exists", str(raised.exception))
        self.assertEqual(out.read_text(encoding="utf-8"), "keep me")
        result = export_machine("sweep", out, repo_dir=None, user_dir=self.library, overwrite=True)
        self.assertEqual(result["source"], "library")
        self.assertEqual(out.read_text(encoding="utf-8"), text)

    def test_export_refuses_a_symlinked_target_without_following_it(self) -> None:
        # The no-overwrite path creates the file exclusively, so a symlink
        # planted at the target refuses instead of being followed and its
        # victim keeps its bytes.
        text = machine_file_text(description="A machine that sweeps.", spec_json=json.dumps(valid_dag()))
        directory = self.library / "sweep"
        directory.mkdir(parents=True)
        (directory / "MACHINE.md").write_text(text, encoding="utf-8")
        victim = self.out_dir / "victim.txt"
        victim.write_text("keep me", encoding="utf-8")
        link = self.out_dir / "link.MACHINE.md"
        link.symlink_to(victim)
        with self.assertRaises(ValueError) as raised:
            export_machine("sweep", link, repo_dir=None, user_dir=self.library)
        self.assertIn("already exists", str(raised.exception))
        self.assertEqual(victim.read_text(encoding="utf-8"), "keep me")
        self.assertTrue(link.is_symlink())

    def test_multiline_entry_content_exports_as_one_line(self) -> None:
        # A stored entry's content is free prose; a machine description
        # must be a single line, so the export collapses it instead of
        # refusing a perfectly ordinary entry.
        self.harness.create_factory(
            "multiline", "First line of prose.\nSecond line of prose.\n\nThird paragraph.",
            machine={"states": [{"id": "a", "entry": True, "subagent": {"prompt": "P."}}]},
        )
        out = self.out_dir / "multiline.MACHINE.md"
        result = export_machine("multiline", out)
        self.assertEqual(result["source"], "spec")
        rendered = out.read_text(encoding="utf-8")
        self.assertIn(
            "description: First line of prose. Second line of prose. Third paragraph.",
            rendered,
        )

    def test_spec_export_refuses_to_silently_overwrite_the_target(self) -> None:
        out = self.out_dir / "spec.MACHINE.md"
        export_factory_spec(valid_machine(), out, name="sweep", description="A machine that sweeps.")
        out.write_text("keep me", encoding="utf-8")
        with self.assertRaises(ValueError) as raised:
            export_factory_spec(valid_machine(), out, name="sweep", description="Overwrite.")
        self.assertIn("already exists", str(raised.exception))
        self.assertEqual(out.read_text(encoding="utf-8"), "keep me")
        export_factory_spec(valid_machine(), out, name="sweep", description="Overwrite.", overwrite=True)
        self.assertIn("Overwrite.", out.read_text(encoding="utf-8"))

    def test_spec_export_multiline_description_is_one_sentence(self) -> None:
        # The single-line rule lives in machine_description_errors alone:
        # one defect, one sentence, whether the description arrives as a
        # parsed frontmatter value or an export argument.
        with self.assertRaises(ValueError) as raised:
            export_factory_spec(
                valid_machine(),
                self.out_dir / "x.MACHINE.md",
                name="sweep",
                description="A machine that\nsweeps.",
            )
        self.assertEqual(
            str(raised.exception), "frontmatter description must be a single line"
        )

    def test_exports_a_stored_entry_spec_byte_pretty(self) -> None:
        self.harness.create_factory("Sweep", "A machine that sweeps.", id="sweep", dag=valid_dag())
        out = self.out_dir / "sweep.MACHINE.md"
        result = export_machine("sweep", out, repo_dir=None, user_dir=self.library)
        self.assertEqual(result["source"], "spec")
        machine, errors = parse_machine_file(out.read_text(encoding="utf-8"), source=str(out))
        self.assertEqual(errors, [])
        assert machine is not None
        self.assertEqual(machine.name, "sweep")
        self.assertEqual(validate_factory_spec(machine.spec), [])
        self.assertEqual(canonicalize_factory_spec(machine.spec), canonicalize_factory_spec(valid_dag()))

    def test_entry_ids_that_are_not_machine_names_are_rejected(self) -> None:
        self.harness.create_factory("Sweep", "A machine that sweeps.", id="Sweep Entry", dag=valid_dag())
        with self.assertRaises(ValueError) as ctx:
            export_machine("Sweep Entry", self.out_dir / "x.MACHINE.md", repo_dir=None, user_dir=self.library)
        self.assertIn("invalid characters", str(ctx.exception))

    def test_exports_a_runs_canonical_machine(self) -> None:
        self.harness.create_factory("Sweep", "A machine that sweeps.", id="sweep", machine=valid_machine())
        run = self.executor._create_run(
            "sweep", canonicalize_factory_spec(valid_machine()), {}, name="the run"
        )
        self.executor._runs[run.run_id] = run
        self.assertEqual(run.machine, canonicalize_factory_spec(valid_machine()))
        out = self.out_dir / "run-machine.MACHINE.md"
        result = export_machine(run.run_id, out, repo_dir=None, user_dir=self.library)
        self.assertEqual(result["source"], "spec")
        machine, errors = parse_machine_file(out.read_text(encoding="utf-8"), source=str(out))
        self.assertEqual(errors, [])
        assert machine is not None
        self.assertEqual(machine.spec, canonicalize_factory_spec(valid_machine()))

    def test_unknown_targets_list_every_source(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            export_machine("ghost", self.out_dir / "ghost.MACHINE.md", repo_dir=None, user_dir=self.library)
        self.assertIn("unknown machine 'ghost'", str(ctx.exception))

    def test_out_path_must_not_be_a_directory(self) -> None:
        directory = self.library / "sweep"
        directory.mkdir(parents=True)
        (directory / "MACHINE.md").write_text(
            machine_file_text(description="A machine that sweeps."), encoding="utf-8"
        )
        with self.assertRaises(ValueError) as ctx:
            export_machine("sweep", self.out_dir, repo_dir=None, user_dir=self.library)
        self.assertIn("is a directory", str(ctx.exception))

    def test_export_rejects_invalid_specs(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            export_factory_spec(
                {"run": {"max_parallel": None}, "states": [{"id": "a", "entry": True, "subagent": {"prompt": "P."}}]},
                self.out_dir / "bad.MACHINE.md",
                name="sweep",
                description="A machine that sweeps.",
            )
        self.assertIn("max_parallel must be an integer between 1 and 64", str(ctx.exception))
        self.assertFalse((self.out_dir / "bad.MACHINE.md").exists())


class FactoryRunFromLibraryTest(unittest.TestCase):
    """rlm.factory.run falls back to the machine library for machine names."""

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.library = root / "machines"
        self.harness = HarnessState(root / "harness_state.json")
        self.harness.create_subagent("Worker", "Do the work carefully.", id="worker")
        self.clock = FakeClock()
        self.host = FakeHost(clock=self.clock)
        self.sleeps = ClockSleep(self.clock)
        self.executor = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        previous_executor = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = self.executor
        self.addCleanup(lambda: setattr(factory_module, "_DEFAULT_EXECUTOR", previous_executor))
        patcher = patch.object(rlm_module, "host_request", self.host)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Isolate the library resolution from this machine's real home dir.
        agent_home = root / "agent-home"
        # The library run routes through rlm.factory.run, so it inherits the
        # opt-in gate: the isolated agent dir carries the same enabled
        # settings document the core's executor tests write (the real file
        # shape the daemon writes), or the disabled default refuses the run.
        agent_home.mkdir(parents=True, exist_ok=True)
        (agent_home / "settings.json").write_text(
            json.dumps({"factory": {"enabled": True}}), encoding="utf-8"
        )
        env = patch.dict(os.environ, {
            "PRIME_AGENT_MACHINES_DIR": str(self.library),
            "PRIME_AGENT_CODING_AGENT_DIR": str(agent_home),
        })
        env.start()
        self.addCleanup(env.stop)

    def store_machine_file(self, name: str, spec: dict[str, Any]) -> Path:
        directory = self.library / name
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "MACHINE.md"
        path.write_text(
            machine_file_text(name=name, description="A machine that sweeps.", spec_json=json.dumps(spec)),
            encoding="utf-8",
        )
        return path

    @async_test
    async def test_run_resolves_machine_names_from_the_library(self) -> None:
        path = self.store_machine_file(
            "sweep",
            {
                "run": {"failure_policy": "continue", "max_parallel": 2},
                "nodes": [
                    {"id": "a", "subagent": "worker", "outputs": [{"name": "out", "type": "text"}]},
                    {
                        "id": "b",
                        "subagent": {"prompt": "Use {draft}"},
                        "depends_on": ["a"],
                        "inputs": [{"name": "draft", "type": "text", "from": "a.out"}],
                    },
                ],
            },
        )
        result = await rlm_module.rlm.factory.run("sweep")
        self.assertEqual(result["spec_id"], "sweep")
        self.assertEqual(result["machine"], "sweep")
        self.assertEqual(result["machine_path"], str(path))
        self.assertEqual(result["started"], ["a"])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["spec_id"], "sweep")
        self.assertEqual(len(self.host.calls_of("rlm.run")), 2)

    @async_test
    async def test_stored_entries_win_over_library_machines(self) -> None:
        self.store_machine_file(
            "sweep",
            {"nodes": [{"id": "only-a", "subagent": "worker"}]},
        )
        self.harness.create_factory(
            "Sweep", "A stored instance.", id="sweep", dag={"nodes": [
                {"id": "entry-a", "subagent": "worker"},
                {"id": "entry-b", "subagent": "worker"},
            ]}
        )
        result = await rlm_module.rlm.factory.run("sweep")
        self.assertNotIn("machine", result)
        self.assertEqual(result["nodes"], 2)
        self.assertEqual(sorted(result["started"]), ["entry-a", "entry-b"])

    @async_test
    async def test_unknown_names_report_the_library(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown factory spec 'missing-spec'"):
            await rlm_module.rlm.factory.run("missing-spec")
        try:
            await rlm_module.rlm.factory.run("missing-spec")
        except ValueError as error:
            self.assertIn("no stored factory entry", str(error))
            self.assertIn("no library machine with that name", str(error))

    @async_test
    async def test_an_invalid_name_still_reports_the_unknown_spec_frame(self) -> None:
        # A stored-entry id that is not a legal machine name (spaces,
        # capitals) can never resolve from the library: the lookup must
        # not surface the bare name-rule sentence, losing the unknown-spec
        # frame.
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.run("My Spec")
        message = str(raised.exception)
        self.assertIn("unknown factory spec 'My Spec'", message)
        self.assertIn("not a valid machine name", message)
        self.assertIn("lowercase a-z, 0-9, hyphens", message)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_a_broken_library_file_names_its_errors_not_a_missing_name(self) -> None:
        # A file that exists but fails to parse reports the exact parse
        # errors; it never pretends the name is unknown.
        directory = self.library / "broken"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "MACHINE.md").write_text(
            "---\nname: broken\n---\n\n```machine-spec\n{}\n```\n", encoding="utf-8"
        )
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.run("broken")
        self.assertIn("exists but is broken", str(raised.exception))
        self.assertIn("frontmatter description is required", str(raised.exception))
        self.assertNotIn("no library machine with that name", str(raised.exception))
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_a_spec_invalid_library_file_is_broken_not_a_late_rejection(self) -> None:
        # A file that parses but carries a spec the write-time validator
        # rejects is the exists-but-broken case at resolve time: the run
        # refuses with the exact validator sentences naming the file,
        # never a late canonicalize error after resolution, and nothing
        # spawns.
        path = self.store_machine_file("sweep", {"states": []})
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.run("sweep")
        message = str(raised.exception)
        self.assertIn("exists but is broken", message)
        self.assertIn("factory machine must declare between 1 and 1024 states, got 0", message)
        self.assertIn(str(path), message)
        self.assertNotIn("no library machine with that name", message)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_an_invalid_repo_machine_never_shadows_a_valid_user_machine(self) -> None:
        # Cursor's follow-up finding: the listing scan skips a spec-invalid
        # repo machine so a valid user machine of the same name surfaces,
        # but the run still raised exists-but-broken on the repo file —
        # `factory list` advertised a machine the run refused. Run, resolve,
        # and export share the listing's verdict, so the run serves the
        # user machine the listing advertises; the invalid repo file never
        # shadows it and never masquerades as usable.
        self.store_machine_file("sweep", {"states": []})
        agent_home = Path(os.environ["PRIME_AGENT_CODING_AGENT_DIR"])
        user_file = agent_home / "machines" / "sweep" / "MACHINE.md"
        user_file.parent.mkdir(parents=True)
        user_file.write_text(
            machine_file_text(
                name="sweep",
                description="The user machine.",
                spec_json=json.dumps({"nodes": [{"id": "a", "subagent": "worker"}]}),
            ),
            encoding="utf-8",
        )
        listed = list_machines()
        self.assertEqual([entry["name"] for entry in listed], ["sweep"])
        self.assertEqual(listed[0]["source"], "user")
        result = await rlm_module.rlm.factory.run("sweep")
        self.assertEqual(result["spec_id"], "sweep")
        self.assertEqual(result["machine"], "sweep")
        self.assertEqual(result["machine_path"], str(user_file))
        self.assertEqual(result["started"], ["a"])
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["spec_id"], "sweep")

    @async_test
    async def test_a_non_utf8_library_file_is_broken_not_an_invalid_name(self) -> None:
        # A machine file that exists but does not decode is a broken library
        # file: the run reports it in the exists-but-broken frame, never as
        # an invalid machine name (the name-rule arm must not swallow the
        # decode error).
        directory = self.library / "sweep"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "MACHINE.md").write_bytes(b"\xff\xfe\xff not utf-8")
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.run("sweep")
        message = str(raised.exception)
        self.assertIn("exists but is broken", message)
        self.assertIn("not valid UTF-8", message)
        self.assertNotIn("not a valid machine name", message)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_one_corrupt_library_file_never_reframes_unknown_names(self) -> None:
        # One non-decodable file skips in the listing scan like any broken
        # file: an unrelated unknown name keeps the unknown-spec frame, never
        # the name-rule arm the decode error would otherwise reach.
        corrupt = self.library / "zz-corrupt"
        corrupt.mkdir(parents=True, exist_ok=True)
        (corrupt / "MACHINE.md").write_bytes(b"\xff\xfe")
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.run("missing-spec")
        message = str(raised.exception)
        self.assertIn("unknown factory spec 'missing-spec'", message)
        self.assertIn("no library machine with that name", message)
        self.assertNotIn("not a valid machine name", message)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_the_opt_in_gate_refuses_library_runs_while_disabled(self) -> None:
        # The library run routes through rlm.factory.run, so it inherits the
        # opt-in gate and the refusal precedes library resolution: while the
        # setting is off, a stored library machine name is refused with the
        # one disabled message -- never an unknown-spec error, never a run
        # -- and nothing spawns.
        self.store_machine_file("sweep", {"nodes": [{"id": "a", "subagent": "worker"}]})
        agent_home = Path(os.environ["PRIME_AGENT_CODING_AGENT_DIR"])
        (agent_home / "settings.json").write_text(
            json.dumps({"factory": {"enabled": False}}), encoding="utf-8"
        )
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.run("sweep")
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        self.assertEqual(self.host.calls, [])
        # No settings file at all is the same disabled default.
        (agent_home / "settings.json").unlink()
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.run("sweep")
        self.assertEqual(str(raised.exception), factory_module.FACTORY_DISABLED_MESSAGE)
        self.assertEqual(self.host.calls, [])

    @async_test
    async def test_run_from_library_compiles_dag_sugar(self) -> None:
        self.store_machine_file(
            "pipeline",
            {
                "nodes": [
                    {"id": "src", "subagent": "worker", "outputs": [{"name": "v", "type": "text"}]},
                    {
                        "id": "fan-in",
                        "subagent": {"prompt": "Merge {v}."},
                        "depends_on": ["src"],
                        "inputs": [{"name": "v", "type": "text", "from": "src.v"}],
                    },
                ],
            },
        )
        result = await rlm_module.rlm.factory.run("pipeline")
        self.assertEqual(result["machine"], "pipeline")
        run = self.executor._runs[result["run_id"]]
        # The run executes the compiled machine, and the run's stashed
        # machine is exactly the canonicalized template.
        self.assertIn("states", run.machine)
        self.assertNotIn("nodes", run.machine)
        self.assertEqual(validate_factory_spec(run.machine), [])
        self.assertEqual(run.machine, canonicalize_factory_spec(run.machine))

    # helpers ------------------------------------------------------------------

    async def settle(self, run_result: dict[str, Any], *, max_polls: int = 50_000) -> dict[str, Any]:
        run_id = run_result["run_id"]
        for _ in range(max_polls):
            run = self.executor._runs[run_id]
            if run.state != "running":
                return await rlm_module.rlm.factory.status(run_id)
            await yield_loop_turn()
        self.fail(f"run {run_id} never left the running state")


# ---------------------------------------------------------------------------
# The installed-runtime library: the wheel a kernel venv actually installs.
# ---------------------------------------------------------------------------

_INSTALLED_LIBRARY_RUNNER = r"""
import asyncio
import json


class ScriptedHost:
    # Deterministic fake for the rlm host bridge: spawn registers a child,
    # collect settles it with the review-sweep node's scripted answer.
    def __init__(self):
        self.children = {}
        self.counter = 0

    @staticmethod
    def answer_for(name):
        # The spawn labels are run-prefixed (run-scoped names), so the
        # configured name matches anywhere in the label.
        if "files-source" in name:
            return "```json\n{\"files\": [\"sample.ts\"]}\n```"
        if "file-reviewer" in name:
            return "sample.ts: clean"
        if "review-aggregator" in name:
            return "```json\n{\"issues\": [], \"clean\": 1}\n```"
        return "done"

    async def __call__(self, request_type, payload=None):
        payload = payload or {}
        if request_type == "rlm.run":
            self.counter += 1
            child_id = f"child-{self.counter}"
            name = payload["kwargs"]["name"]
            self.children[child_id] = name
            return {
                "rlm_child_id": child_id,
                "name": name,
                "session_dir": f"/tmp/{child_id}",
                "model": "test/worker",
            }
        if request_type == "rlm.collect":
            results = []
            for target in payload["targets"]:
                name = self.children.get(target)
                if name is None:
                    continue
                results.append({
                    "rlm_child_id": target,
                    "session_name": name,
                    "session_dir": f"/tmp/{target}",
                    "status": "done",
                    "settled": True,
                    "answer_preview": self.answer_for(name),
                    "tool_use_count": 1,
                    "duration_ms": 5,
                })
            return {"results": results}
        if request_type == "rlm.delete_subagent":
            self.children.pop(payload["target"], None)
            return {"outcome": "deleted"}
        return {}


async def main():
    import rlm as rlm_module
    import rlm.factory as factory_module
    from rlm.factory import FactoryExecutor

    rlm_module.host_request = ScriptedHost()

    async def instant_sleep(_seconds):
        await asyncio.sleep(0)

    factory_module._DEFAULT_EXECUTOR = FactoryExecutor(sleep=instant_sleep)
    factory = rlm_module.rlm.factory
    result = await factory.run("review-sweep")
    status = None
    for _ in range(500):
        status = await factory.status(result["run_id"])
        if status["state"] != "running":
            break
        await asyncio.sleep(0.02)
    print(json.dumps({
        "state": status["state"],
        "spec_id": result["spec_id"],
        "machine": result["machine"],
        "machine_path": result["machine_path"],
        "nodes": sorted(node["id"] for node in status["nodes"]),
        "events": status["events"][-8:],
    }))


asyncio.run(main())
"""


class InstalledRuntimeLibraryTest(unittest.TestCase):
    """A kernel venv built from a staged runtime runs the bundled machines.

    The kernel installs prime-agent-runtime non-editably into its venv (the
    bootstrap's ``uv pip install <staged runtime>`` builds the hatchling
    wheel, whose target package is ``src/rlm``), so the machine library
    must resolve from the installed package — ``site-packages/rlm/
    machines`` — not from any source-checkout path. This stages the
    runtime the way the release does, installs it into a fresh venv, and
    runs ``rlm.factory.run("review-sweep")`` end-to-end in that interpreter
    against a scripted host, asserting the machine came from the installed
    wheel.
    """

    # Names the release staging drops from the runtime tree (the assemble
    # script's RUNTIME_EXCLUDED_NAMES): the venv bootstrap installs the
    # staged layout, so the test stages the same way.
    STAGING_EXCLUDED = frozenset({"test", "uv.lock", ".venv", "__pycache__", ".pytest_cache"})

    def setUp(self) -> None:
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()

    def stage_runtime(self) -> Path:
        """Copy the runtime tree the release-staging way, minus its excludes."""
        runtime_dir = Path(__file__).resolve().parents[1]
        staged = self.root / "payload" / "prime-agent-runtime"
        for source in runtime_dir.rglob("*"):
            relative = source.relative_to(runtime_dir)
            if any(part in self.STAGING_EXCLUDED for part in relative.parts):
                continue
            target = staged / relative
            if source.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
        return staged

    def test_kernel_venv_runs_review_sweep_from_the_installed_wheel(self) -> None:
        if os.name != "posix":
            self.skipTest("the staged kernel-venv path is POSIX-shaped")
        uv = shutil.which("uv")
        if uv is None:
            self.skipTest("uv is not available to build the kernel venv")
        staged = self.stage_runtime()
        venv = self.root / "kernel-venv"
        agent_home = self.root / "agent-home"
        agent_home.mkdir(parents=True)
        (agent_home / "settings.json").write_text(
            json.dumps({"factory": {"enabled": True}}), encoding="utf-8"
        )
        for args in (
            [uv, "venv", str(venv)],
            [uv, "pip", "install", "--python", str(venv / "bin" / "python"), "--no-deps", str(staged)],
        ):
            install = subprocess.run(
                args, capture_output=True, text=True, timeout=240, check=False
            )
            self.assertEqual(
                install.returncode, 0,
                f"{' '.join(args)} failed:\n{install.stdout}\n{install.stderr}",
            )
        run_result = subprocess.run(
            [
                str(venv / "bin" / "python"), "-I", "-c", _INSTALLED_LIBRARY_RUNNER,
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            env={**os.environ, "PRIME_AGENT_CODING_AGENT_DIR": str(agent_home)},
        )
        self.assertEqual(
            run_result.returncode, 0,
            f"the installed-runtime run failed:\n{run_result.stdout}\n{run_result.stderr}",
        )
        payload = json.loads(run_result.stdout)
        self.assertEqual(payload["state"], "done", payload)
        self.assertEqual(payload["spec_id"], "review-sweep")
        self.assertEqual(payload["machine"], "review-sweep")
        machine_path = Path(payload["machine_path"])
        self.assertTrue(machine_path.is_file(), machine_path)
        self.assertIn("site-packages", str(machine_path), machine_path)
        self.assertIn(os.path.join("rlm", "machines"), str(machine_path), machine_path)
        # The installed package is the wheel copy, not this checkout's source.
        self.assertNotIn("prime-agent-runtime", str(machine_path), machine_path)
        self.assertEqual(payload["nodes"], ["files", "report", "review"])
