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
  payloads once per kind per run (resume re-arms the pause notice), and a
  dead bridge leaves the milestone in the ledger instead of wedging the run.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import os
import re
import shutil
import subprocess
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable
from unittest.mock import patch

import rlm as rlm_module
import rlm.repl as repl_module
from rlm.factory import (
    ANSWER_BINDING_CAP,
    FACTORY_OUTPUTS_FILE,
    FactoryEmitError,
    ANSWER_CAPTURE_CAP,
    BACKOFF_MAX_ATTEMPTS,
    EVENT_WINDOW,
    MACHINE_SPEC_FENCE,
    NODE_OUTPUTS_CAP,
    POLL_TIMEOUT_MS,
    RUN_MAX_CHILDREN_DEFAULT,
    RUN_MAX_PARALLEL_DEFAULT,
    SUBAGENT_NAME_MAX_LENGTH,
    FactoryExecutor,
    MachineFile,
    _child_name,
    _guard_passes,
    _parse_json_output,
    _spawn_label,
    canonicalize_factory_spec,
    cli_dispatch,
    compile_factory_dag,
    export_factory_spec,
    export_machine,
    machine_description_errors,
    machine_name_errors,
    render_machine_file,
    topological_order,
    validate_factory_machine,
    validate_factory_spec,
)
from rlm.harness import HarnessState

factory_module = importlib.import_module("rlm.factory")


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

    def test_node_failure_policy(self) -> None:
        for good in ("fail_fast", "continue", "escalate"):
            self.assertEqual(validate_factory_spec({"nodes": [node("a", failure_policy=good)]}), [])
        errors = validate_factory_spec({"nodes": [node("a", failure_policy="retry")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("node a failure_policy must be one of", errors[0])

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
            validate_factory_spec({"run": {"budget_ms": None}, "nodes": [node("a")]}),
            ["run budget_ms must be a positive integer"],
        )
        self.assertEqual(
            validate_factory_spec({"run": {"failure_policy": None}, "nodes": [node("a")]}),
            ["run failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got None"],
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

        declares_retries = {"nodes": [node("watcher", lifecycle="resident", retries=2)]}
        errors = validate_factory_spec(declares_retries)
        self.assertEqual(errors, ["resident node watcher cannot declare retries"])

        # Retries 0 is the canonical default, so nothing is declared.
        zero_retries = {"nodes": [node("watcher", lifecycle="resident", retries=0)]}
        self.assertEqual(validate_factory_spec(zero_retries), [])

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
                "node a depends on unknown node 'ghost'",
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

    def test_max_transitions_defaults_to_ten_per_state(self) -> None:
        ten_states = {"nodes": [node(f"n{i}") for i in range(10)]}
        self.assertEqual(canonicalize_factory_spec(ten_states)["run"]["max_transitions"], 100)

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
        empty = {"states": [], "transitions": []}
        self.assertEqual(validate_factory_machine(empty), ["factory machine must declare at least one state"])

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

    def test_entry_state_inputs_must_be_optional(self) -> None:
        absent = object()  # sentinel: the optional key is omitted entirely

        def with_inputs(optional: Any) -> dict[str, Any]:
            inp: dict[str, Any] = {"name": "i", "type": "text", "from": "peer.o"}
            if optional is not absent:
                inp["optional"] = optional
            return {
                "states": [
                    state("src", entry=True, inputs=[inp]),
                    state("peer", outputs=[{"name": "o", "type": "text"}]),
                ],
                "transitions": [{"from": "src", "to": "peer"}, {"from": "peer", "to": "src"}],
            }

        self.assertEqual(validate_factory_machine(with_inputs(True)), [])
        for required in (False, absent):
            self.assertEqual(
                validate_factory_machine(with_inputs(required)),
                ["entry state src input 'i' must be optional: an entry state's first entry has no upstream settle to bind"],
                repr(required),
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

    def test_python_states(self) -> None:
        python = {"import": "tools", "callable": "plan"}
        machine = {
            "states": [
                {"id": "plan", "entry": True, "python": python, "outputs": [{"name": "items", "type": "json"}]},
                state("work", inputs=[{"name": "items", "type": "json", "from": "plan.items"}]),
            ],
            "transitions": [{"from": "plan", "to": "work"}],
        }
        self.assertEqual(validate_factory_machine(machine), [])
        canonical = canonicalize_factory_spec(machine)
        self.assertEqual(canonical["states"][0]["python"], python)
        self.assertNotIn("subagent", canonical["states"][0])
        # The dag form compiles python nodes to python states.
        dag = {"nodes": [{"id": "plan", "python": python}, node("work", depends_on=["plan"])]}
        self.assertEqual(canonicalize_factory_spec(dag)["states"][0]["python"], python)

        cases = {
            "declares both subagent and python": {"python": python, "subagent": "worker"},
            "python requires non-empty 'import' and 'callable' strings": {"python": {"import": "tools"}},
            "python state a cannot be resident": {"python": python, "lifecycle": "resident"},
            "state a python path must be an absolute directory when provided": {
                "python": {**python, "path": "nodes"}
            },
            "python state a cannot use foreach": {
                "python": python,
                "inputs": [{"name": "xs", "type": "json", "from": "b.xs"}],
                "foreach": {"over": "xs", "max": 2},
            },
        }
        for expected, fields in cases.items():
            machine = {
                "states": [
                    {"id": "a", "entry": not fields.get("inputs"), **fields},
                    state("b", entry=True, outputs=[{"name": "xs", "type": "json"}]),
                ],
                "transitions": [],
            }
            errors = validate_factory_machine(machine)
            self.assertTrue(any(expected in error for error in errors), (expected, errors))

    def test_params(self) -> None:
        machine = {
            "params": {"task": "ship it", "max_loc": 400},
            "states": [state("a", entry=True)],
            "transitions": [],
        }
        self.assertEqual(validate_factory_machine(machine), [])
        self.assertEqual(canonicalize_factory_spec(machine)["params"], {"task": "ship it", "max_loc": 400})
        self.assertNotIn("params", canonicalize_factory_spec({"states": [state("a", entry=True)]}))
        for params in (["task"], {"Task": "x"}, {"1x": 1}):
            self.assertEqual(
                validate_factory_machine({**machine, "params": params}),
                ["params must be an object keyed by lowercase identifiers"],
                repr(params),
            )
        colliding = {
            "params": {"items": []},
            "states": [
                state("a", entry=True, outputs=[{"name": "items", "type": "json"}]),
                state("b", inputs=[{"name": "items", "type": "json", "from": "a.items"}]),
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        self.assertEqual(
            validate_factory_machine(colliding),
            ["state b input 'items' is also a param; rename the input"],
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
        declares_retries = {
            "states": [state("watcher", entry=True, lifecycle="resident", retries=1)],
            "transitions": [],
        }
        self.assertEqual(
            validate_factory_machine(declares_retries),
            ["resident state watcher cannot declare retries"],
        )
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
            ({"nodes": []}, "factory dag must declare at least one node"),
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
            {"states": [{"id": "a", "entry": True, "subagent": "w", "failure_policy": {}}]},
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
        # would truncate at the cap, fail to capture, and fail its state.
        self.assertIn('findings": ["at most three one-line findings"]', doc)
        self.assertIn("capped at the eight most relevant", doc)
        self.assertIn(
            "an unbounded payload truncates at the cap, fails to capture, "
            "and fails the producing state",
            flat,
        )
        # The output-capture contract: a declared port that never binds
        # fails the producing entry as a task failure.
        self.assertIn("is retried once and then FAILS the producing", flat)
        self.assertIn("the answer stays preserved under `needs_verify`", flat)

        # The Discovery section ships the machine library as present (this
        # branch merges it): the bundled location, the seed names, the CLI
        # surface, and the run-from-library fallback — every phrase
        # fact-checked against the machine-library code (parse/import
        # gate/run fallback).
        self.assertIn(
            "The machine library: one folder per machine, either a machine directory "
            "(`machine.toml`) or a `MACHINE.md` file (frontmatter plus one fenced "
            "`machine-spec` block), resolved from two levels — the bundled seeds "
            "shipped inside the runtime (visible in every install; "
            "`PRIME_AGENT_MACHINES_DIR` redirects the level at a team directory) "
            "first, the personal `machines/` library under the agent dir second",
            flat,
        )
        self.assertIn(
            "`prime-agent factory list | import | export` manages them: list shows "
            "what loads (broken folders print as warnings), import checks the spec "
            "like a stored one so an invalid machine never persists, and export "
            "copies a library MACHINE.md verbatim to a fresh path (an existing "
            "target is refused, never overwritten)",
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

    def test_the_read_survives_its_first_call_and_rereads_on_a_rewrite(self):
        # The stat-keyed cache behind the boot arm's per-execute read:
        # the FIRST call (a missing settings file, an empty cache) must
        # answer, never crash — the arm asks on every executed command
        # while it keeps declining — and a rewrite moves the stat key so
        # the next call re-reads the new document (an unconditional
        # cache would serve the stale verdict forever).
        self.assertFalse(factory_module.factory_enabled())
        self.write_settings({"factory": {"enabled": True}})
        self.assertTrue(factory_module.factory_enabled())
        self.write_settings({"factory": {"enabled": False}})
        self.assertFalse(factory_module.factory_enabled())
        # The unchanged-document re-read: repeated calls stay consistent.
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
        # factory.compile replies by machine directory path or library
        # name (the Rust loader's answer, scripted).
        self.compiled: dict[str, dict[str, Any]] = {}
        # factory.describe replies by library name (the drill-in's template).
        self.described: dict[str, dict[str, Any]] = {}
        # Emit-state children: with session_root set, each spawn gets a real
        # session dir; ``emitted[node]`` is written there as the child's
        # accepted outputs at spawn, and ``on_message`` runs on every
        # agent_message.send (a child answering a repair request).
        self.session_root: Path | None = None
        self.emitted: dict[str, dict[str, Any]] = {}
        self.on_message: Callable[[dict[str, Any]], None] | None = None
        self.check_errors: dict[str, str] = {}
        self.factory_task_busy_until_collect: dict[str, int] = {}
        # factory.limits answers {} unless a test scripts its error.
        self.limits_error: str | None = None

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
        duration_ms: int = 5,
        factory_task_busy: bool | None = False,
    ) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "rlm_child_id": child_id,
            "session_name": name,
            "session_dir": f"/tmp/{child_id}",
            "status": status,
            "settled": settled,
            "tool_use_count": 1,
            "duration_ms": duration_ms,
        }
        if factory_task_busy is not None:
            entry["factory_task_busy"] = factory_task_busy
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
        if request_type in ("rlm.collect", "rlm.delete_subagent", "rlm.run", "factory.progress", "factory.check"):
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
            session_dir = f"/tmp/{child_id}"
            if self.session_root is not None:
                session_dir = str(self.session_root / child_id)
                Path(session_dir).mkdir(parents=True, exist_ok=True)
                if node_id in self.emitted:
                    Path(session_dir, FACTORY_OUTPUTS_FILE).write_text(
                        json.dumps(self.emitted[node_id]), encoding="utf-8"
                    )
            return {
                "rlm_child_id": child_id,
                "name": name,
                "session_dir": session_dir,
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
                factory_task_busy = outcome.get(
                    "factory_task_busy",
                    self.collects <= self.factory_task_busy_until_collect.get(child["node"], 0),
                )
                if outcome["status"] == "running":
                    results.append(
                        self._entry(
                            child_id=target,
                            name=child["name"],
                            status="running",
                            settled=False,
                            factory_task_busy=factory_task_busy,
                        )
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
                        duration_ms=outcome.get("duration_ms", 5),
                        factory_task_busy=factory_task_busy,
                    )
                )
            return {"results": results}
        if request_type == "rlm.list_subagents":
            return {
                "subagents": [
                    {
                        "rlm_child_id": child_id,
                        "session_name": child["name"],
                        "session_dir": f"/tmp/{child_id}",
                        "status": "running",
                    }
                    for child_id, child in self.children.items()
                ]
            }
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
        if request_type == "factory.compile":
            key = (payload or {}).get("path") or (payload or {}).get("name")
            if key not in self.compiled:
                raise RuntimeError(f"no library machine named {key!r} (machines: none)")
            return self.compiled[key]
        if request_type == "factory.describe":
            name = (payload or {}).get("name")
            if name not in self.described:
                raise RuntimeError(f"no library machine named {name!r} (machines: none)")
            return self.described[name]
        if request_type == "factory.limits":
            if self.limits_error is not None:
                raise RuntimeError(self.limits_error)
            return {}
        if request_type == "agent_message.send":
            if self.on_message is not None:
                self.on_message(payload or {})
            return {"deliveryStatus": "delivered"}
        if request_type == "factory.check":
            error = self.check_errors.get(json.dumps((payload or {}).get("outputs"), sort_keys=True))
            if error is not None:
                raise RuntimeError(error)
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

    async def wait_until(self, predicate, *, max_polls: int = 50_000) -> None:
        for _ in range(max_polls):
            if predicate():
                return
            await yield_loop_turn()
        self.fail("condition never became true")

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
            # The run tag the host records on the child's ledger spawn edge.
            self.assertEqual(
                spawn[0]["kwargs"]["factory"],
                {"runId": result["run_id"], "specId": "sw", "stateId": node_id},
            )

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
    async def test_unparseable_output_fails_the_producer_and_never_spawns_the_dependent(self) -> None:
        # a's declared json output never parses: the capture failure fails a
        # itself (defect C) instead of settling it valueless, so b's required
        # input over the errored source fails at binding without ever
        # spawning; c still ran and finished, so the run completes but
        # reports failed.
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
        self.assertEqual(self.host.spawn_calls("b"), [])
        a = self.node_status(status, "a")
        self.assertEqual(a["status"], "error")
        self.assertIn("no JSON object containing output 'result'", a["error"])
        b = self.node_status(status, "b")
        self.assertEqual(b["status"], "error")
        self.assertIn("is unavailable (latest settle status 'error')", b["error"])
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
    async def test_a_fenced_json_output_at_the_binding_cap_binds(self) -> None:
        # The binding lane stores a settled child's answer capped at
        # ANSWER_BINDING_CAP, which sits at parity with the host's collect
        # bound: the daemon's ANSWER_TEXT_MAX_CHARS
        # (crates/pa-daemon/src/rlm_child_model.rs), 65,536 characters —
        # the hard-coded literal below, not the factory constant, so a cap
        # below the host bound fails the test. The old 8192 cap sat below
        # that bound, so a valid fenced JSON between the two (a design
        # node's ~27 KiB output, observed three times) was cut mid-object
        # BEFORE the parse and failed capture deterministically. A fenced
        # JSON exactly the host bound long binds whole; any smaller cap
        # cuts it and fails.
        body = {"design": {"plan": "p"}}
        long_json = f"```json\n{json.dumps(body)}\n```"
        body["design"]["plan"] = "p" * (1 + 65_536 - len(long_json))
        long_json = f"```json\n{json.dumps(body)}\n```"
        assert len(long_json) == 65_536
        self.host.outcomes["design"] = {"status": "done", "answer": long_json}
        self.host.outcomes["build"] = {"status": "done", "answer": "DONE"}
        self.store_machine(
            {
                "run": {"failure_policy": "escalate", "max_parallel": 4},
                "states": [
                    {
                        "id": "design",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "design", "type": "json"}],
                    },
                    {
                        "id": "build",
                        "subagent": "worker",
                        "inputs": [{"name": "design", "type": "json", "from": "design.design"}],
                    },
                ],
                "transitions": [{"from": "design", "to": "build"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.all_events_of(result, "output_capture_failed"), [])
        # The port value bound whole: the dependent's prompt carries the
        # entire cap-sized design, not a cut.
        build_prompt = self.host.spawn_calls("build")[0]["prompt"]
        self.assertIn(f"- design: {json.dumps(body['design'])}", build_prompt)

    @async_test
    async def test_json_output_binds_from_a_plain_text_tail_settle(self) -> None:
        # The dogfooding parser-pause class (runs 55a2c852, 9ad9e794): a
        # child settles after real work with its terminal JSON emitted as a
        # plain-text tail after prose, no fence anywhere. The capture binds
        # the declared port from the terminal object, so the run proceeds
        # instead of failing the settle and burning a re-admission.
        self.host.outcomes["src"] = {
            "status": "done",
            "answer": 'Gate ran: fmt, the touched suites, and clippy are green.\n\n{"verdict": "pass", "head": "abc12345"}',
        }
        self.host.outcomes["dep"] = {"status": "done", "answer": "DONE"}
        self.store_machine(
            {
                "run": {"failure_policy": "escalate", "max_parallel": 4},
                "states": [
                    {
                        "id": "src",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "verdict", "type": "json"}],
                    },
                    {
                        "id": "dep",
                        "subagent": {"prompt": "Ship the {verdict} head."},
                        "inputs": [{"name": "verdict", "type": "json", "from": "src.verdict"}],
                    },
                ],
                "transitions": [{"from": "src", "to": "dep"}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("dep")],
            ['Ship the "pass" head.'],
        )
        self.assertEqual(self.all_events_of(result, "output_capture_failed"), [])

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
    async def test_uncaptured_output_fails_the_producing_entry_instead_of_the_dependent(self) -> None:
        # Defect C: a done settle whose declared output never bound (no
        # parseable value after the one capture retry) used to settle the
        # entry done and queue the settle -- the dependent's required input
        # then failed over the valueless source, spending its entry budget
        # on the producer's failure. The capture failure now fails the
        # PRODUCING entry as a task failure at the origin: retries, then
        # failure_policy, apply; no settle is queued, so escalate pauses at
        # the producer and the dependent never enters.
        self.host.outcomes["setup"] = {"status": "done", "answer": "no json here"}
        self.store_machine(
            {
                "states": [
                    {
                        "id": "setup",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "config", "type": "json"}],
                        "retries": 1,
                    },
                    {
                        "id": "build",
                        "subagent": "worker",
                        "inputs": [{"name": "config", "type": "json", "from": "setup.config"}],
                        "max_entries": 4,
                    },
                ],
                "transitions": [{"from": "setup", "to": "build"}],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        setup = self.state_report(paused, "setup")
        self.assertEqual(setup["status"], "error")
        self.assertIn("config", setup["error"])
        # the failed capture spent the one retry re-spawning the same
        # prompt; the second capture failure is permanent
        self.assertEqual(len(self.host.spawn_calls("setup")), 2)
        self.assertEqual(len(self.all_events_of(result, "retry")), 1)
        self.assertEqual(len(self.all_events_of(result, "output_capture_failed")), 2)
        # the dependent never entered on the unbound required input
        self.assertEqual(self.state_report(paused, "build")["entries_used"], 0)
        self.assertEqual(self.host.spawn_calls("build"), [])
        self.assertEqual(self.all_events_of(result, "transition_fired"), [])
        # the settled answer is preserved as provisional, so the permanent
        # failure surfaces needs_verify with the answer for review
        self.assertEqual(paused["needs_verify"], ["setup"])
        self.assertIn("no json here", setup["entries"][0]["provisional_answer"])
        # the paused milestone tells the operator resume re-admits the entry
        paused_notice = next(n for n in self.host.notices if n["kind"] == "paused")
        self.assertIn("state setup failed", paused_notice["detail"])
        self.assertIn("re-admit", paused_notice["detail"])

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
    async def test_a_busy_owner_adds_no_poll_sleep_while_another_child_runs(self) -> None:
        # The collect of the running child already waits, so the owner's
        # background work adds no extra sleep on top of it.
        self.host.outcomes["a"] = {"status": "done", "answer": "a", "factory_task_busy": True}
        self.host.outcomes["b"] = {"status": "running"}
        self.store_factory(
            {"nodes": [{"id": "a", "subagent": "worker"}, {"id": "b", "subagent": "worker"}]}
        )
        held = self.host.gate("rlm.collect", 4)
        result = await self.start()
        await self.host.gate_entered("rlm.collect", 4).wait()
        self.host.outcomes["a"]["factory_task_busy"] = False
        self.host.outcomes["b"] = {"status": "done", "answer": "b"}
        held.set()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertNotIn(factory_module.REPAIR_POLL_SECONDS, self.sleeps.sleeps)

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
    async def test_escalate_resume_readmits_the_failed_entry(self) -> None:
        # Defect A (live run fa1a8f1c): resume after an escalate pause fired
        # the ERRORED settle forward -- the guard-less transition entered the
        # dependent, its required input failed to bind over the errored
        # source, and it spent one of its max_entries entries on nothing.
        # The escalate pause now lands BEFORE the failure propagates, and
        # resume re-admits the failed entry as a fresh attempt of the same
        # rendered prompt in the same entry slot.
        self.host.child_outcomes["child-1"] = {"status": "error", "error": "boom"}
        self.host.child_outcomes["child-2"] = {"status": "done", "answer": "impl-done"}
        self.store_machine(
            {
                "states": [
                    {
                        "id": "implement",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "result", "type": "text"}],
                    },
                    {
                        "id": "review",
                        "subagent": "worker",
                        "inputs": [{"name": "result", "type": "text", "from": "implement.result"}],
                        "max_entries": 4,
                    },
                ],
                "transitions": [{"from": "implement", "to": "review"}],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        self.assertEqual(self.node_status(paused, "implement")["status"], "error")
        self.assertEqual(self.node_status(paused, "review")["entries_used"], 0)
        self.assertIn("paused", self.host.notice_kinds())
        # resume re-admits the failed entry: a fresh attempt of the same
        # rendered prompt, the same entry slot -- no extra max_entries.
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(resumed["state"], "running")
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        implement = self.node_status(final, "implement")
        self.assertEqual(implement["status"], "done")
        self.assertEqual(implement["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in implement["entries"]], ["done"])
        self.assertEqual(len(self.host.spawn_calls("implement")), 2)
        review = self.node_status(final, "review")
        self.assertEqual(review["status"], "done")
        self.assertEqual(review["entries_used"], 1)
        self.assertIn("impl-done", self.host.spawn_calls("review")[0]["prompt"])
        self.assertEqual(self.host.notice_kinds(), ["paused", "finished"])
        # a second resume on the finished run must refuse
        with self.assertRaisesRegex(ValueError, "not paused"):
            await rlm_module.rlm.factory.resume(result["run_id"])

    @async_test
    async def test_escalate_pause_spends_no_downstream_entry(self) -> None:
        # The pre-propagation pause: the errored settle never fires the
        # guard-less transition, so the dependent's entry budget is never
        # spent on the failure. Resume re-admits the failed entry, and its
        # own failure re-pauses the run with the same reason.
        self.host.outcomes["implement"] = {"status": "error", "error": "boom"}
        self.store_machine(
            {
                "states": [
                    {
                        "id": "implement",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "result", "type": "text"}],
                    },
                    {
                        "id": "review",
                        "subagent": "worker",
                        "inputs": [{"name": "result", "type": "text", "from": "implement.result"}],
                        "max_entries": 4,
                    },
                ],
                "transitions": [{"from": "implement", "to": "review"}],
            }
        )
        result = await self.start()
        paused = await self.settle(result)
        self.assertEqual(paused["state"], "paused")
        await rlm_module.rlm.factory.resume(result["run_id"])
        second = await self.settle(result)
        self.assertEqual(second["state"], "paused")
        self.assertEqual(second["pause_reason"], "boom")
        self.assertEqual(self.node_status(second, "review")["entries_used"], 0)
        self.assertEqual(self.all_events_of(result, "transition_fired"), [])
        implement = self.node_status(second, "implement")
        self.assertEqual(implement["entries_used"], 1)
        self.assertEqual(len(self.host.spawn_calls("implement")), 2)

    @async_test
    async def test_resume_defers_rate_limited_admissions(self) -> None:
        self.host.child_outcomes["child-1"] = {"status": "error", "error": "boom"}
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
        # The rate limit hits a's re-admission, not b: escalate holds the
        # failed entry unsettled and resume() re-admits it first.
        self.host.rate_limit_first["a"] = 3
        sleep_mark = len(self.sleeps.sleeps)
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        # resume() must not sleep in the calling turn: the rate-limited
        # admission defers to the control loop's backoff, exactly like run()
        self.assertEqual(resumed["started"], [])
        self.assertEqual(self.sleeps.sleeps[sleep_mark:], [])
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")  # a redone, b done
        self.assertEqual(self.node_status(final, "a")["status"], "done")
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        # a needed 4 admissions total: the failed first, one deferred at
        # resume, one rate-limited retry inside the loop's backoff, then
        # the success; b then runs once.
        self.assertEqual(len(self.host.spawn_calls("a")), 4)
        self.assertEqual(len(self.host.spawn_calls("b")), 1)
        self.assertEqual(self.sleeps.sleeps[sleep_mark:], [1.0])

    @async_test
    async def test_a_pause_after_resume_notifies_the_parent_again(self) -> None:
        # A run that pauses, resumes, and pauses again (the escalate retry
        # flow) records both pauses in the ledger AND tells the parent about
        # both: resume() re-arms the paused notice.
        # a fails once and its re-admitted retry succeeds, so the second
        # pause is b's own failure.
        self.host.child_outcomes["child-1"] = {"status": "error", "error": "a boom"}
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
        milestones = [event for event in second["events"] if event["kind"] == "milestone"]
        self.assertEqual([event["milestone"] for event in milestones], ["paused", "paused"])
        self.assertIn("a boom", milestones[0]["detail"])
        self.assertIn("b boom", milestones[1]["detail"])
        self.assertEqual(self.host.notice_kinds(), ["paused", "paused"])
        self.assertEqual([event["stage"] for event in milestones], ["shown", "shown"])

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

    # -- worker deaths (infra) --------------------------------------------------------

    @async_test
    async def test_worker_death_respawns_once_without_spending_retries_or_max_entries(self) -> None:
        # Defect B (live run fa1a8f1c): "Child worker unreachable" consumed
        # the entry and, with default retries=0, escalated into a pause --
        # twenty minutes of child work discarded on an infra hiccup. A
        # verified worker death is infra, not the task's failure: the
        # executor liveness-verifies it itself (a short quiet period, then
        # one re-collect) and re-spawns the same rendered prompt once,
        # spending neither retries nor a fresh max_entries slot.
        self.host.child_outcomes["child-1"] = {
            "status": "error",
            "error": "Child worker unreachable",
            "answer": "partial work",
        }
        self.store_factory({"nodes": [{"id": "work", "subagent": "worker"}]})
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.host.notice_kinds(), ["finished"])
        work = self.node_status(status, "work")
        self.assertEqual(work["status"], "done")
        self.assertEqual(work["entries_used"], 1)
        self.assertEqual(len(self.host.spawn_calls("work")), 2)
        # the dead attempt's exit text was dropped, not marked for verify:
        # the respawn redid the work and the entry settled for real
        self.assertNotIn("needs_verify", status)
        self.assertNotIn("needs_verify", work)
        # the executor verified the death itself before re-spawning
        self.assertIn(factory_module.INFRA_VERIFY_QUIET_SECONDS, self.sleeps.sleeps)

    @async_test
    async def test_failed_infra_retirement_blocks_resume_replacement(self) -> None:
        failing = DeleteFailsHost(clock=self.clock)
        patcher = patch.object(rlm_module, "host_request", failing)
        patcher.start()
        self.addCleanup(patcher.stop)
        failing.child_outcomes["child-1"] = {
            "status": "error",
            "error": "Child worker unreachable",
        }
        self.store_factory({"nodes": [{"id": "work", "subagent": "worker"}]})
        result = await self.start()
        paused = await self.settle(result)

        self.assertEqual(paused["state"], "paused")
        self.assertEqual(len(failing.spawn_calls("work")), 1)
        instance = self.node_status(paused, "work")["instances"][0]
        self.assertEqual(instance["child"], "child-1")
        self.assertIn("child-1", failing.children)
        self.assertEqual(len(self.all_events_of(result, "infra_respawn")), 0)

        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(resumed["state"], "paused")
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(len(failing.spawn_calls("work")), 1)
        self.assertEqual(self.node_status(status, "work")["instances"][0]["child"], "child-1")
        self.assertIn("child-1", failing.children)
        self.assertEqual(len(failing.deleted_targets()), 2)

    @async_test
    async def test_second_worker_death_falls_through_retries_and_policy(self) -> None:
        # Only ONE free respawn: a second verified death charges the normal
        # retries budget (the free respawn consumed none) and then the
        # failure_policy applies like any task failure.
        self.host.outcomes["work"] = {"status": "error", "error": "Child worker unreachable"}
        self.store_factory(
            {
                "run": {"failure_policy": "continue"},
                "nodes": [{"id": "work", "subagent": "worker", "retries": 1}],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "failed")
        work = self.node_status(status, "work")
        self.assertEqual(work["status"], "error")
        # initial spawn, free respawn, one charged retry: three admissions
        self.assertEqual(len(self.host.spawn_calls("work")), 3)
        self.assertEqual(work["attempts"], 3)
        self.assertEqual(len(self.all_events_of(result, "infra_respawn")), 1)
        self.assertEqual(len(self.all_events_of(result, "retry")), 1)

    @async_test
    async def test_paused_collect_batch_preserves_the_free_infra_respawn(self) -> None:
        self.host.child_outcomes["child-1"] = {"status": "error", "error": "task failed"}
        self.host.child_outcomes["child-2"] = {
            "status": "error", "error": "Child worker unreachable"
        }
        self.store_factory({"nodes": [
            {"id": "a", "subagent": "worker"},
            {"id": "b", "subagent": "worker"},
        ]})
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        await run.task  # finish the whole batch, including b after a pauses it
        self.assertEqual(run.state, "paused")
        instance = run.states["b"].entries[0].instances[0]
        self.assertEqual(instance.status, "pending")
        self.assertTrue(instance.infra_respawned)
        self.assertEqual(self.host.deleted_targets(), ["child-2"])
        await rlm_module.rlm.factory.resume(result["run_id"])
        status = await self.settle(result, max_polls=1000)
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("b")), 2)
        self.assertEqual(self.node_status(status, "b")["entries_used"], 1)
        self.assertEqual(self.all_events_of(result, "retry"), [])
        self.assertEqual(len(self.all_events_of(result, "infra_respawn")), 1)

    @async_test
    async def test_stop_during_output_capture_preserves_cancelled_entry(self) -> None:
        self.host.outcomes["work"] = {"status": "done", "answer": "no JSON"}
        capture_gate = self.host.gate("rlm.collect", 2)
        capture_entered = self.host.gate_entered("rlm.collect", 2)
        self.store_factory({"nodes": [{
            "id": "work", "subagent": "worker",
            "outputs": [{"name": "data", "type": "json"}],
        }]})
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        await capture_entered.wait()
        await rlm_module.rlm.factory.stop(result["run_id"])
        entry = run.states["work"].entries[0]
        self.assertEqual(entry.status, "cancelled")
        capture_gate.set()
        await run.task
        self.assertEqual(run.state, "stopped")
        self.assertEqual(entry.status, "cancelled")
        self.assertFalse(entry.instances[0].provisional)
        self.assertEqual(self.all_events_of(result, "retry"), [])

    @async_test
    async def test_worker_death_recheck_adopts_a_live_settle(self) -> None:
        # The liveness re-check is not a rubber stamp: when the worker
        # answers again during the quiet period, its fresh settle supersedes
        # the error row and nothing is re-spawned.
        self.host.child_outcomes["child-1"] = {
            "status": "error",
            "error": "Child worker unreachable",
        }
        host = self.host

        class ReviveSleep(ClockSleep):
            """The executor's quiet-period sleep revives child-1: the
            worker was never dead, and the re-read must see it settled."""

            async def __call__(self, seconds: float) -> None:
                await super().__call__(seconds)
                host.child_outcomes["child-1"] = {"status": "done", "answer": "late done"}

        self.executor._sleep_fn = ReviveSleep(self.clock)
        self.store_factory({"nodes": [{"id": "work", "subagent": "worker"}]})
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("work")), 1)
        self.assertEqual(self.all_events_of(result, "infra_respawn"), [])
        self.assertEqual(self.node_status(status, "work")["answer_preview"], "late done")

    @async_test
    async def test_resume_grants_fresh_retries_and_a_fresh_respawn(self) -> None:
        # The approved resume semantics: a re-admitted entry restarts both
        # budgets. The charged retry after the free respawn must be granted
        # again, and an infra death of the re-admitted attempt must get its
        # own free respawn instead of failing through a spent one.
        self.host.child_outcomes["child-1"] = {"status": "error", "error": "Child worker unreachable"}
        self.host.child_outcomes["child-2"] = {"status": "error", "error": "boom"}
        self.host.child_outcomes["child-3"] = {"status": "error", "error": "boom"}
        self.host.child_outcomes["child-4"] = {"status": "error", "error": "Child worker unreachable"}
        self.store_factory({"nodes": [{"id": "work", "subagent": "worker", "retries": 1}]})
        result = await self.start()
        paused = await self.settle(result)
        # infra death -> free respawn; the respawn's own task failure spent
        # the one charged retry; the retry failed too -> escalate pause.
        self.assertEqual(paused["state"], "paused")
        self.assertEqual(len(self.host.spawn_calls("work")), 3)
        self.assertEqual(len(self.all_events_of(result, "infra_respawn")), 1)
        self.assertEqual(len(self.all_events_of(result, "retry")), 1)
        # resume re-admits the entry with fresh budgets: the re-admitted
        # attempt's infra death respawns free again, and this time it
        # settles done.
        await rlm_module.rlm.factory.resume(result["run_id"])
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.node_status(final, "work")["entries_used"], 1)
        self.assertEqual(len(self.host.spawn_calls("work")), 5)
        self.assertEqual(len(self.all_events_of(result, "infra_respawn")), 2)
        self.assertEqual(len(self.all_events_of(result, "retry")), 1)
        self.assertEqual(self.host.notice_kinds(), ["paused", "finished"])

    # -- budgets ----------------------------------------------------------------------

    @async_test
    async def test_node_budget_marks_attempt_failed(self) -> None:
        # The budget measures the CHILD'S OWN run time (the collect
        # result's duration): a's child ran 2000ms against the node's
        # 1000ms budget. The wall clock no longer drives the check (a
        # pause between admission and settlement must not reject
        # finished work).
        self.clock.advance_per_collect = 2.0
        self.host.outcomes["a"] = {"status": "done", "duration_ms": 2000}
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
        self.assertEqual(stopped["state"], "stopping")
        self.assertEqual(stopped["cancelled"], [])
        spawn_gate.set()  # the admission returns a child into a stopping run
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
        # The child is retracted before the run can be reported stopped.
        kinds = [event["kind"] for event in status["events"]]
        self.assertLess(kinds.index("cancelled"), kinds.index("run_stopped"))
        self.assertNotIn("spawned", kinds[kinds.index("run_stopped") + 1 :])

    @async_test
    async def test_stop_during_an_in_flight_admission_that_fails_finishes_the_stop(self) -> None:
        # stop() waits for the in-flight spawn; when that spawn fails, no
        # child exists and the run must not stay stopping.
        self.host.rate_limit_first["a"] = 2
        spawn_gate = self.host.gate("rlm.run", 2)
        gate_entered = self.host.gate_entered("rlm.run", 2)
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        await gate_entered.wait()
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["state"], "stopping")
        spawn_gate.set()  # the admission fails into a stopping run
        await self.executor._runs[result["run_id"]].task
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(self.host.deleted_targets(), [])

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
        self.assertEqual(stopped["state"], "stopping")
        delete_gate.set()
        # The gated delete resumes after the stop pass: the fail_fast
        # cascade finishes inside the control-loop task, so the task-done
        # barrier waits for BOTH deletions deterministically (an assert on
        # the delete list alone could race the released call).
        run = self.executor._runs[result["run_id"]]
        await self.wait_until(lambda: run.task.done())
        final = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(final["state"], "stopped")
        # every child deleted exactly once, in one pass each
        self.assertEqual(sorted(self.host.deleted_targets()), ["child-2", "child-3"])
        self.assertEqual(
            len([event for event in self.all_events_of(result, "cancel_failed")]), 0
        )

    @async_test
    async def test_failed_delete_keeps_stop_incomplete_and_actor_owned(self) -> None:
        failing = DeleteFailsHost(clock=self.clock)
        patcher = patch.object(rlm_module, "host_request", failing)
        patcher.start()
        self.addCleanup(patcher.stop)
        failing.outcomes["a"] = {"status": "running"}
        self.store_factory({"nodes": [{"id": "a", "subagent": "worker"}]})
        result = await self.start()
        await self.wait_until(lambda: failing.collects >= 1)

        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["state"], "stopping")
        self.assertEqual(stopped["cancelled"], [])
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "stopping")
        instance = self.node_status(status, "a")["instances"][0]
        self.assertEqual(instance["status"], "running")
        self.assertEqual(instance["child"], "child-1")
        self.assertIn("child-1", failing.children)
        kinds = [event["kind"] for event in status["events"]]
        self.assertIn("cancel_failed", kinds)
        self.assertNotIn("run_stopped", kinds)
        self.assertFalse(any(event["kind"] == "cancelled" and event.get("child") == "child-1" for event in status["events"]))

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
        self.host.child_outcomes["child-1"] = {"status": "error", "error": "boom"}
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
        self.assertEqual(final["state"], "done")
        kinds = self.host.notice_kinds()
        self.assertEqual(kinds, ["paused", "finished"])
        paused_notice, finished_notice = self.host.notices
        self.assertEqual(paused_notice["kind"], "paused")
        self.assertEqual(paused_notice["run_id"], result["run_id"])
        self.assertIn("state a failed", paused_notice["detail"])
        self.assertIn("resume", paused_notice["detail"])
        self.assertEqual(paused_notice.get("node"), "a")  # node-level milestone
        self.assertEqual(finished_notice["kind"], "finished")
        self.assertEqual(finished_notice["run_id"], result["run_id"])
        self.assertIsNone(finished_notice.get("node"))  # run-level milestone
        self.assertEqual(set(paused_notice.keys()), {"run_id", "kind", "detail", "node"})
        self.assertEqual(set(finished_notice.keys()), {"run_id", "kind", "detail"})
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
        failing.child_outcomes["child-1"] = {"status": "error", "error": "boom"}
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
        self.assertEqual(final["state"], "done")
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

    def test_json_output_binds_from_terminal_bare_and_dirty_tails(self) -> None:
        # the settle shapes the strict fence rejected, every one binding the
        # same declared port with the same output-name requirement: a JSON
        # tail emitted as plain text after prose (the validate-class parser
        # pause), a fence that lost its closing markers, and benign
        # punctuation residue around the emit
        plain_tail = 'Gate ran clean on the worktree.\n\n{"verdict": "pass", "head": "abc"}'
        self.assertEqual(_parse_json_output(plain_tail, "verdict"), ("pass", None))
        unclosed = '```json\n{"verdict": "pass"}'
        self.assertEqual(_parse_json_output(unclosed, "verdict"), ("pass", None))
        dirty = '---\n{"verdict": "pass"}\n``` --'
        self.assertEqual(_parse_json_output(dirty, "verdict"), ("pass", None))
        # braces inside string literals never break the balanced scan
        braces = 'note: {"verdict": "pass", "detail": "quoted } and { inside"}'
        self.assertEqual(_parse_json_output(braces, "verdict"), ("pass", None))
        # a fence still wins over the bare tail (the authored contract), and
        # the terminal emit is the LAST object when several are bare
        fenced_then_bare = '```json\n{"verdict": "fenced"}\n```\n\n{"verdict": "bare"}'
        self.assertEqual(_parse_json_output(fenced_then_bare, "verdict"), ("fenced", None))
        two_bare = '{"verdict": "stale"}\n.\n{"verdict": "last"}'
        self.assertEqual(_parse_json_output(two_bare, "verdict"), ("last", None))
        # an object that trailing prose follows is not terminal and does not
        # bind; a terminal object without the declared port fails; no JSON
        # anywhere keeps the same failure sentence
        not_terminal = '{"verdict": "pass"}\n\nAll checks green, done.'
        value, error = _parse_json_output(not_terminal, "verdict")
        self.assertIsNone(value)
        self.assertIn("no JSON object containing output 'verdict'", error)
        wrong_port = 'gate done\n\n{"status": "done"}'
        value, error = _parse_json_output(wrong_port, "verdict")
        self.assertIsNone(value)
        self.assertIn("no JSON object containing output 'verdict'", error)
        prose_only = "The gate ran clean; there is nothing to bind."
        value, error = _parse_json_output(prose_only, "verdict")
        self.assertIsNone(value)
        self.assertEqual(
            error, "no JSON object containing output 'verdict' in the upstream answer"
        )

    def test_terminal_object_survives_prose_delimiters(self) -> None:
        # Macroscope + Bugbot (PR #3906): the scan applied JSON quote and
        # brace rules from the start of the answer, so prose that left a
        # quote or a brace open nested or hid a valid tail object; syntax
        # tracks within candidate objects only, so a settle that mentions a
        # block or leaves a quote open still binds
        stray_quote = 'The gate said "all green, and\n\n{"verdict": "pass"}'
        self.assertEqual(_parse_json_output(stray_quote, "verdict"), ("pass", None))
        stray_brace = 'here is the { stray brace in prose\n\n{"verdict": "pass"}'
        self.assertEqual(_parse_json_output(stray_brace, "verdict"), ("pass", None))
        between = '{"verdict": "stale"} and "so on\n\n{"verdict": "last"}'
        self.assertEqual(_parse_json_output(between, "verdict"), ("last", None))
        # a truncated emit owns the tail: an unterminated object never
        # binds its nested spans, and the same failure sentence reads
        truncated = '{"outer": {"verdict": "x"}'
        value, error = _parse_json_output(truncated, "verdict")
        self.assertIsNone(value)
        self.assertIn("no JSON object containing output 'verdict'", error)
        # prose delimiters change nothing for the non-terminal contract
        not_terminal = '{"verdict": "pass"}\nAll checks green, "done."'
        value, error = _parse_json_output(not_terminal, "verdict")
        self.assertIsNone(value)
        self.assertIn("no JSON object containing output 'verdict'", error)

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
    async def test_machine_loop_back_into_entry_state_binds_null_then_the_real_settle(self) -> None:
        # investigate -> check -> investigate: the entry state's optional
        # input binds null on admission and the checker's objections on the
        # loop-back entry.
        self.host.child_outcomes["child-1"] = {"status": "done", "answer": "FINDINGS-1"}
        self.host.child_outcomes["child-2"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": false, "objections": ["OBJ-A1"]}}\n```',
        }
        self.host.child_outcomes["child-3"] = {"status": "done", "answer": "FINDINGS-2"}
        self.host.child_outcomes["child-4"] = {
            "status": "done",
            "answer": '```json\n{"verdict": {"approved": true, "objections": []}}\n```',
        }
        self.store_machine(
            {
                "states": [
                    {
                        "id": "investigate",
                        "entry": True,
                        "subagent": "worker",
                        "inputs": [{"name": "verdict", "type": "json", "from": "check.verdict", "optional": True}],
                        "outputs": [{"name": "findings", "type": "text"}],
                        "max_entries": 3,
                    },
                    {
                        "id": "check",
                        "subagent": "worker",
                        "inputs": [{"name": "findings", "type": "text", "from": "investigate.findings"}],
                        "outputs": [{"name": "verdict", "type": "json"}],
                        "max_entries": 3,
                    },
                ],
                "transitions": [
                    {"from": "investigate", "to": "check"},
                    {
                        "from": "check",
                        "to": "investigate",
                        "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False},
                    },
                ],
            }
        )
        result = await self.start()
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        prompts = [call["prompt"] for call in self.host.spawn_calls("investigate")]
        self.assertEqual(len(prompts), 2)
        self.assertIn("null", prompts[0])
        self.assertNotIn("OBJ-A1", prompts[0])
        self.assertIn("OBJ-A1", prompts[1])
        self.assertEqual(self.state_report(status, "check")["entries_used"], 2)

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
        node_reply = self.executor._node_report(result["run_id"], "fan")
        self.assertEqual(node_reply["state"]["id"], "fan")
        self.assertEqual(node_reply["entry"]["status"], "done")
        self.assertIn("outputs", node_reply["entry"])
        self.assertIn("output_errors", node_reply["entry"])
        self.assertIsNone(node_reply["instance"])

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
    async def test_missing_answer_capture_has_a_bounded_poll_window(self) -> None:
        self.host.outcomes["work"] = {"status": "done"}
        self.store_factory({"nodes": [{"id": "work", "subagent": "worker",
                                      "outputs": [{"name": "data", "type": "json"}]}]})
        before = self.clock()
        result = await self.start()
        status = await self.settle(result)
        elapsed = self.clock() - before
        self.assertEqual(status["state"], "paused")
        self.assertGreater(elapsed, 0)
        self.assertLessEqual(elapsed, factory_module.POLL_TIMEOUT_MS / 1000 + 1e-9)
        self.assertEqual(len(self.host.spawn_calls("work")), 1)
        self.assertIn("captured no value", self.node_status(status, "work")["error"])

    @async_test
    async def test_stop_during_missing_answer_poll_preserves_cancellation(self) -> None:
        self.host.outcomes["work"] = {"status": "done"}
        sleeps = GatedSleep()
        self.executor._sleep_fn = sleeps
        self.store_factory({"nodes": [{"id": "work", "subagent": "worker",
                                      "outputs": [{"name": "data", "type": "json"}]}]})
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        await self.wait_until(sleeps.entered.is_set)
        await rlm_module.rlm.factory.stop(result["run_id"])
        sleeps.release.set()
        await run.task
        entry = run.states["work"].entries[0]
        self.assertEqual(run.state, "stopped")
        self.assertEqual(entry.status, "cancelled")
        self.assertFalse(entry.instances[0].provisional)
        self.assertEqual(self.all_events_of(result, "retry"), [])
        self.assertEqual(len(self.host.spawn_calls("work")), 1)

    @async_test
    async def test_capture_waits_for_the_settled_workers_answer_handoff(self) -> None:
        handoff_requested = asyncio.Event()
        answer_ready = asyncio.Event()

        class HandoffHost(FakeHost):
            empty_reads = 0

            async def __call__(self, request_type, payload=None):
                response = await super().__call__(request_type, payload)
                if request_type == "rlm.collect" and not answer_ready.is_set():
                    for row in response["results"]:
                        if row["rlm_child_id"] == "child-1":
                            row.pop("answer_text", None)
                            row.pop("answer_preview", None)
                            self.empty_reads += 1
                            if self.empty_reads >= 2:
                                handoff_requested.set()
                return response

        class YieldingSleep(ClockSleep):
            async def __call__(self, seconds):
                await super().__call__(seconds)
                await yield_loop_turn()

        self.host = HandoffHost(clock=self.clock)
        self.host.outcomes["work"] = {"status": "done", "answer": '{"data": {"ok": true}}'}
        repatch = patch.object(rlm_module, "host_request", self.host)
        repatch.start()
        self.addCleanup(repatch.stop)
        self.executor._sleep_fn = YieldingSleep(self.clock)

        async def finish_handoff():
            await handoff_requested.wait()
            answer_ready.set()

        handoff = asyncio.create_task(finish_handoff())
        self.store_factory({"nodes": [{"id": "work", "subagent": "worker",
                                      "outputs": [{"name": "data", "type": "json"}]}]})
        result = await self.start()
        status = await self.settle(result)
        await handoff
        self.assertEqual(status["state"], "done")
        self.assertEqual(self.node_status(status, "work")["entries_used"], 1)
        self.assertEqual(len(self.host.spawn_calls("work")), 1)
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
        # archaeology over pending-state lists to learn what failed. The
        # pause here is src's own failed output capture (defect C): the
        # failure lands at the producer, before the dependent's bind.
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
            "no JSON object containing output 'data' in the upstream answer",
        )
        self.assertIn("state 'src' failed", status["last_error"])
        self.assertIn("no JSON object containing output 'data'", status["last_error"])
        self.assertIn(f"rlm.factory.resume('{result['run_id']}')", status["remedy"])
        self.assertEqual(status["needs_verify"], ["src"])

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
        node = await self.executor.activity(
            {"action": "node", "runId": result["run_id"], "specId": "dep"}
        )
        self.assertEqual(node["entry"]["error"], dep["entries"][0]["error"])

    @async_test
    async def test_machine_optional_input_over_a_settled_source_with_no_captured_value_binds_the_null_sentinel(self) -> None:
        # Review finding (PR #3199), second no-value condition: the source
        # settled but captured no value for the declared port (an empty
        # answer). The optional dependent proceeds on the null sentinel;
        # only the required dependent over the same valueless settle fails
        # its entry.
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
        # the empty answer never captured the text port, so the capture
        # failure failed the source entry itself (defect C) instead of
        # settling it valueless
        src = self.state_report(status, "src")
        self.assertEqual([entry["status"] for entry in src["entries"]], ["error"])
        self.assertIn("captured no value", src["entries"][0]["error"])
        opt = self.state_report(status, "opt")
        self.assertEqual(opt["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in opt["entries"]], ["done"])
        self.assertIn("- go: None", self.host.spawn_calls("opt")[0]["prompt"])
        req = self.state_report(status, "req")
        self.assertEqual(req["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in req["entries"]], ["error"])
        self.assertIn(
            "input 'go' from state 'src' is unavailable (latest settle status 'error')",
            req["entries"][0]["error"],
        )
        self.assertEqual(self.host.spawn_calls("req"), [])

    @async_test
    async def test_machine_optional_input_over_a_failed_json_capture_binds_the_null_sentinel(self) -> None:
        # Review finding (PR #3199), third no-value condition: the source
        # settled, declared a json port, but its answer never parsed for
        # that port (a JSON capture failure). The optional dependent
        # proceeds on the null sentinel; only the required dependent over
        # the same failed capture fails its entry.
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
        # the failed json capture failed the source entry itself (defect C),
        # and its settled answer stays preserved for review
        src = self.state_report(status, "src")
        self.assertEqual([entry["status"] for entry in src["entries"]], ["error"])
        self.assertIn("no JSON object containing output 'data'", src["entries"][0]["error"])
        self.assertEqual(status["needs_verify"], ["src"])
        self.assertIn("no json here", src["entries"][0]["provisional_answer"])
        opt = self.state_report(status, "opt")
        self.assertEqual(opt["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in opt["entries"]], ["done"])
        self.assertIn("- data: null", self.host.spawn_calls("opt")[0]["prompt"])
        req = self.state_report(status, "req")
        self.assertEqual(req["entries_used"], 1)
        self.assertEqual([entry["status"] for entry in req["entries"]], ["error"])
        self.assertIn(
            "input 'data' from state 'src' is unavailable (latest settle status 'error')",
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
        self.host.child_outcomes["child-1"] = {"status": "error", "error": "boom"}
        progress_gate = self.host.gate("factory.progress", 1)
        progress_entered = self.host.gate_entered("factory.progress", 1)
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
        # The rate limit hits a's re-admission: resume()'s admission defers
        # once, and the new loop's retry is the gated mid-spawn.
        self.host.rate_limit_first["a"] = 2
        # rlm.run call #1 is a's admission at run(); #2 is a's re-admission
        # at resume() (rate limited, deferred nonblockingly); the gate holds
        # call #3 -- the NEW loop's retry admission -- mid-spawn.
        spawn_gate = self.host.gate("rlm.run", 3)
        # resume() bumps the generation, re-admits a's failed entry (the
        # admission defers, rate limited, nonblocking), and starts the new
        # loop.
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(resumed["state"], "running")
        self.assertEqual(resumed["started"], [])
        self.assertIsNot(run.task, old_task)
        # Releasing the milestone lets the old loop continue: with the
        # generation bump it must exit without admitting anything (the new
        # loop owns a's retry, suspended mid-admission at the spawn gate).
        progress_gate.set()
        await old_task
        self.assertTrue(old_task.done())
        spawn_gate.set()
        final = await self.settle(result)
        self.assertEqual(final["state"], "done")
        self.assertEqual(self.node_status(final, "b")["status"], "done")
        # a has exactly three admissions: the failed first, the deferred
        # one at resume() and the new loop's successful retry. A stale
        # second loop would admit it once more while the gated spawn was
        # in flight.
        self.assertEqual(len(self.host.spawn_calls("a")), 3)
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
# Python states (a real isolated subprocess per call)
# ---------------------------------------------------------------------------

_PYTHON_TOOLS = """
import time

def plan(inputs):
    print("planning")  # prints go to stderr, never into the outputs
    return {"items": ["a", "b"], "mode": "go"}

async def echo(inputs):
    return {"echo": inputs}

def owner(inputs):
    import os
    return {"owner": os.environ.get("PRIME_AGENT_FACTORY_OWNER_SESSION"), "rlm": sorted(k for k in os.environ if k.startswith("RLM_"))}


def boom(inputs):
    raise ValueError("boom")

def wrong_keys(inputs):
    return {"other": 1}

def slow(inputs):
    time.sleep(60)
    return {}
"""


class FactoryPythonStateTest(_ExecutorTestCase):
    def setUp(self) -> None:
        super().setUp()
        workdir = TemporaryDirectory()
        self.addCleanup(workdir.cleanup)
        Path(workdir.name, "factory_py_tools.py").write_text(_PYTHON_TOOLS, encoding="utf-8")
        previous_cwd = os.getcwd()
        os.chdir(workdir.name)
        self.addCleanup(os.chdir, previous_cwd)

    @staticmethod
    def py(callable_name: str) -> dict[str, str]:
        return {"import": "factory_py_tools", "callable": callable_name}

    async def finish(self, result: dict[str, Any]) -> dict[str, Any]:
        await self.executor._runs[result["run_id"]].task
        return await rlm_module.rlm.factory.status(result["run_id"])

    def node_status(self, status: dict[str, Any], node_id: str) -> dict[str, Any]:
        return next(entry for entry in status["nodes"] if entry["id"] == node_id)

    @async_test
    async def test_python_states_route_and_bind_like_agent_states(self) -> None:
        self.host.outcomes["work"] = {"status": "done", "answer": '```json\n{"count": 2}\n```'}
        self.store_machine(
            {
                "states": [
                    {
                        "id": "plan",
                        "entry": True,
                        "python": self.py("plan"),
                        "outputs": [{"name": "items", "type": "json"}, {"name": "mode", "type": "text"}],
                    },
                    state(
                        "work",
                        inputs=[{"name": "items", "type": "json", "from": "plan.items"}],
                        outputs=[{"name": "count", "type": "json"}],
                    ),
                    state("halt"),
                    {
                        "id": "check",
                        "python": self.py("echo"),
                        "inputs": [
                            {"name": "count", "type": "json", "from": "work.count"},
                            {"name": "mode", "type": "text", "from": "plan.mode"},
                        ],
                        "outputs": [{"name": "echo", "type": "json"}],
                    },
                ],
                "transitions": [
                    {"from": "plan", "to": "work", "when": {"output": "mode", "op": "eq", "value": "go"}},
                    {"from": "plan", "to": "halt", "when": {"output": "mode", "op": "eq", "value": "stop"}},
                    {"from": "work", "to": "check"},
                ],
            }
        )
        result = await self.start()
        status = await self.finish(result)

        self.assertEqual(status["state"], "done")
        # Only the agent state spawned a child.
        self.assertEqual(self.host.calls_of("rlm.run"), self.host.spawn_calls("work"))
        self.assertEqual(len(self.host.spawn_calls("work")), 1)
        self.assertIn('["a", "b"]', self.host.spawn_calls("work")[0]["prompt"])
        self.assertEqual(self.node_status(status, "halt")["status"], "pending")
        run = self.executor._runs[result["run_id"]]
        self.assertEqual(run.states["check"].entries[0].outputs, {"echo": {"count": 2, "mode": "go"}})
        plan = self.node_status(status, "plan")
        self.assertIsNone(plan["instances"][0]["child"])
        self.assertEqual(plan["answer_preview"], '{"items":["a","b"],"mode":"go"}')
        graph_states = {row["id"]: row for row in self.executor.graph(result["run_id"])["machine"]["states"]}
        self.assertEqual(graph_states["plan"]["python"], "factory_py_tools.plan")
        self.assertNotIn("subagent", graph_states["plan"])

    @async_test
    async def test_a_python_state_sees_the_owner_session_and_no_rlm_env(self) -> None:
        self.store_machine(
            {
                "states": [
                    {
                        "id": "who",
                        "entry": True,
                        "python": self.py("owner"),
                        "outputs": [{"name": "owner", "type": "json"}, {"name": "rlm", "type": "json"}],
                    }
                ]
            }
        )
        with patch.dict(os.environ, {"RLM_SESSION_ID": "owner-session"}):
            result = await self.start()
            status = await self.finish(result)
        self.assertEqual(status["state"], "done")
        run = self.executor._runs[result["run_id"]]
        self.assertEqual(run.states["who"].entries[0].outputs, {"owner": "owner-session", "rlm": []})

    @async_test
    async def test_emit_python_states_pass_the_contract_check(self) -> None:
        self.host.check_errors[json.dumps({"items": ["a", "b"], "mode": "go"}, sort_keys=True)] = (
            'mode: "go" is not one of fast, slow'
        )
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {
                        "id": "plan",
                        "entry": True,
                        "python": self.py("plan"),
                        "outputs": [{"name": "items", "type": "json"}, {"name": "mode", "type": "text"}],
                        "emit": {
                            "outputs": [{"name": "items", "type": "list[text]"}, {"name": "mode", "type": "enum(fast, slow)"}],
                            "records": {},
                        },
                    }
                ],
            }
        )
        status = await self.finish(await self.start())
        self.assertEqual(status["state"], "failed")
        self.assertIn('python state output: mode: "go" is not one of fast, slow', self.node_status(status, "plan")["error"])

    @async_test
    async def test_a_stop_during_the_python_output_check_keeps_the_entry_cancelled(self) -> None:
        self.store_machine(
            {
                "states": [
                    {
                        "id": "plan",
                        "entry": True,
                        "python": self.py("plan"),
                        "outputs": [{"name": "items", "type": "json"}, {"name": "mode", "type": "text"}],
                        "emit": {
                            "outputs": [{"name": "items", "type": "list[text]"}, {"name": "mode", "type": "enum(go, stop)"}],
                            "records": {},
                        },
                    },
                    state("build", inputs=[{"name": "items", "type": "json", "from": "plan.items"}]),
                ],
                "transitions": [{"from": "plan", "to": "build"}],
            }
        )
        check_gate = self.host.gate("factory.check", 1)
        result = await self.start()
        await self.host.gate_entered("factory.check", 1).wait()  # the python call exited; its check is in flight
        stopping = asyncio.create_task(rlm_module.rlm.factory.stop(result["run_id"]))
        for _ in range(50):
            await yield_loop_turn()
        check_gate.set()
        await stopping
        status = await self.finish(result)

        self.assertEqual(status["state"], "stopped")
        self.assertEqual(self.node_status(status, "plan")["status"], "cancelled")
        self.assertEqual(self.host.spawn_calls("build"), [])

    @async_test
    async def test_a_node_file_named_like_a_loaded_stdlib_module_runs(self) -> None:
        nodes = Path(os.getcwd(), "nodes")
        nodes.mkdir()
        (nodes / "select.py").write_text("def pick(inputs):\n    return {'picked': 'a'}\n", encoding="utf-8")
        self.store_machine(
            {
                "states": [
                    {
                        "id": "pick",
                        "entry": True,
                        "python": {"import": "select", "callable": "pick", "path": str(nodes)},
                        "outputs": [{"name": "picked", "type": "text"}],
                    }
                ],
            }
        )
        result = await self.start()
        status = await self.finish(result)

        self.assertEqual(status["state"], "done")
        self.assertEqual(self.executor._runs[result["run_id"]].states["pick"].entries[0].outputs, {"picked": "a"})

    @async_test
    async def test_failed_calls_retry_then_apply_the_failure_policy(self) -> None:
        for callable_name, expected in (
            ("boom", "python state exited with code 1: "),
            ("wrong_keys", "python state returned keys ['other'] but declares outputs ['out']"),
        ):
            with self.subTest(callable_name):
                self.store_machine(
                    {
                        "run": {"failure_policy": "continue"},
                        "states": [
                            {
                                "id": "call",
                                "entry": True,
                                "python": self.py(callable_name),
                                "retries": 1,
                                "outputs": [{"name": "out", "type": "json"}],
                            }
                        ],
                    },
                    spec_id=callable_name.replace("_", "-"),
                )
                status = await self.finish(await self.start(callable_name.replace("_", "-")))
                self.assertEqual(status["state"], "failed")
                call = self.node_status(status, "call")
                self.assertEqual(call["attempts"], 2)
                self.assertIn(expected, call["error"])
                if callable_name == "boom":
                    self.assertIn("ValueError: boom", call["error"])

    @async_test
    async def test_a_call_past_its_time_limit_is_killed_without_a_retry(self) -> None:
        self.executor = FactoryExecutor(harness=self.harness)
        factory_module._DEFAULT_EXECUTOR = self.executor
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [{"id": "slow", "entry": True, "python": self.py("slow"), "retries": 2, "budget_ms": 300}],
            }
        )
        result = await self.start()
        process = self.executor._runs[result["run_id"]].states["slow"].entries[0].instances[0].process
        status = await self.finish(result)
        self.assertIsNotNone(process.proc.returncode)
        slow = self.node_status(status, "slow")
        self.assertEqual(slow["attempts"], 1)
        self.assertEqual(slow["error"], "python state time limit 300ms exceeded")

    @async_test
    async def test_stop_kills_a_running_call(self) -> None:
        self.store_machine({"states": [{"id": "slow", "entry": True, "python": self.py("slow")}]})
        result = await self.start()
        instance = self.executor._runs[result["run_id"]].states["slow"].entries[0].instances[0]
        process = instance.process
        stopped = await rlm_module.rlm.factory.stop(result["run_id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertIsNotNone(process.proc.returncode)
        self.assertEqual(instance.status, "cancelled")

    @async_test
    async def test_a_python_deadline_is_not_delayed_by_a_running_child(self) -> None:
        self.executor = FactoryExecutor(harness=self.harness)
        factory_module._DEFAULT_EXECUTOR = self.executor
        self.store_machine({
            "run": {"failure_policy": "continue"},
            "states": [
                state("work", entry=True),
                {"id": "slow", "entry": True, "python": self.py("slow"), "budget_ms": 300},
            ],
        })
        collecting = asyncio.Event()
        never_settles = asyncio.Event()

        async def collect_running_child(targets, *, timeout_ms):
            collecting.set()
            try:
                await asyncio.wait_for(never_settles.wait(), timeout_ms / 1000)
            except asyncio.TimeoutError:
                return []
            raise AssertionError("the child never settles")

        with patch.object(rlm_module, "collect", collect_running_child):
            result = await self.start()
            process = self.executor._runs[result["run_id"]].states["slow"].entries[0].instances[0].process
            try:
                await asyncio.wait_for(collecting.wait(), 1)
                # Bound failure well below the ordinary 2-second child poll.
                await asyncio.wait_for(process.proc.wait(), 1)
                self.assertIsNotNone(process.proc.returncode)
            finally:
                await rlm_module.rlm.factory.stop(result["run_id"])

    @async_test
    async def test_executor_failure_stops_its_python_processes(self) -> None:
        self.store_machine({"states": [{"id": "slow", "entry": True, "python": self.py("slow")}]})
        with patch.object(self.executor, "_wait_python", side_effect=RuntimeError("host failed")):
            result = await self.start()
            run = self.executor._runs[result["run_id"]]
            instance = run.states["slow"].entries[0].instances[0]
            process = instance.process
            try:
                await run.task
                self.assertEqual(
                    (run.state, run.states["slow"].entries[0].status, instance.status, process.proc.returncode is not None),
                    ("failed", "cancelled", "cancelled", True),
                )
            finally:
                if process.proc.returncode is None:
                    await process.stop()


# ---------------------------------------------------------------------------
# Graph and watch (the fused machine view + the bounded wait)
# ---------------------------------------------------------------------------


class FactoryMachineDirectoryTest(_ExecutorTestCase):
    """Machine directories (machine.toml) run through the factory.compile
    host request: the Rust loader's spec, with params bound into prompts and
    python inputs, and python states imported from the directory."""

    def setUp(self) -> None:
        super().setUp()
        self.machine_dir = Path(os.environ["PRIME_AGENT_CODING_AGENT_DIR"]) / "machines" / "review"
        (self.machine_dir / "nodes").mkdir(parents=True)
        (self.machine_dir / "machine.toml").write_text("format = 1\n", encoding="utf-8")
        (self.machine_dir / "nodes" / "review_nodes.py").write_text(
            "def plan(inputs):\n    return {'items': [inputs['task'], inputs['max_loc']]}\n",
            encoding="utf-8",
        )
        self.host.compiled["review"] = {
            "name": "review",
            "path": str(self.machine_dir),
            "version": 3,
            "description": "Plan and review",
            "author": None,
            "spec": {
                "run": {},
                "params": {"task": "ship it", "max_loc": 400},
                "states": [
                    {
                        "id": "plan",
                        "entry": True,
                        "python": {
                            "import": "review_nodes",
                            "callable": "plan",
                            "path": str(self.machine_dir / "nodes"),
                        },
                        "outputs": [{"name": "items", "type": "json"}],
                    },
                    {
                        "id": "work",
                        "subagent": {"prompt": "Do {items} for {task}, at most {max_loc} lines."},
                        "inputs": [{"name": "items", "type": "json", "from": "plan.items"}],
                    },
                ],
                "transitions": [{"from": "plan", "to": "work"}],
            },
        }

    @async_test
    async def test_a_machine_directory_runs_with_its_params(self) -> None:
        self.host.outcomes["work"] = {"status": "done", "answer": "done"}
        result = await rlm_module.rlm.factory.run("review", params={"task": "ship it"})
        await self.executor._runs[result["run_id"]].task
        status = await rlm_module.rlm.factory.status(result["run_id"])

        self.assertEqual(status["state"], "done")
        self.assertEqual(result["machine_path"], str(self.machine_dir))
        self.assertEqual(
            self.host.calls_of("factory.compile"),
            [{"name": "review", "params": {"task": "ship it"}}],
        )
        # The python state imported from the directory and received the
        # params; the prompt rendered both, and no unused param was
        # appended as an input.
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("work")],
            ['Do ["ship it", 400] for ship it, at most 400 lines.'],
        )

    @async_test
    async def test_params_need_a_machine_directory(self) -> None:
        self.store_machine({"states": [state("a", entry=True)]})
        with self.assertRaisesRegex(ValueError, "params apply to machine directories"):
            await rlm_module.rlm.factory.run("sw", params={"task": "x"})

    @async_test
    async def test_a_run_asks_the_host_for_the_limits_before_it_starts(self) -> None:
        spec = {"run": {"max_parallel": 65}, "states": [state("a", entry=True)]}
        self.store_machine(spec)
        self.host.limits_error = "run max_parallel must be an integer between 1 and 64"
        with self.assertRaisesRegex(ValueError, "run max_parallel must be an integer between 1 and 64"):
            await rlm_module.rlm.factory.run("sw")
        self.assertEqual(self.host.calls_of("factory.limits"), [{"spec": spec}])
        self.assertEqual(self.host.calls_of("rlm.run"), [])


class FactoryEmitTest(_ExecutorTestCase):
    """Emit states (a machine directory's compiled states): outputs come
    from what the child emitted, never from its answer text, and a child
    that owes an output is steered once in its own session, never replaced."""

    EMIT = {
        "outputs": [{"name": "design", "type": "text"}, {"name": "risk", "type": "enum(low, high)"}],
        "records": {},
    }

    def setUp(self) -> None:
        super().setUp()
        root = TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.host.session_root = Path(root.name)
        self.store_machine(
            {
                "states": [
                    {
                        "id": "design",
                        "entry": True,
                        "subagent": {"prompt": "Design."},
                        "outputs": [{"name": "design", "type": "text"}, {"name": "risk", "type": "json"}],
                        "emit": self.EMIT,
                    },
                    state(
                        "build",
                        inputs=[
                            {"name": "design", "type": "text", "from": "design.design"},
                            {"name": "risk", "type": "json", "from": "design.risk"},
                        ],
                    ),
                ],
                "transitions": [{"from": "design", "to": "build"}],
            }
        )
        # The answer carries a JSON block a scraper would bind: emit
        # states must ignore it.
        self.host.outcomes["design"] = {
            "status": "done",
            "answer": 'Done.\n```json\n{"design": "SCRAPED", "risk": "high"}\n```',
        }
        self.host.outcomes["build"] = {"status": "done", "answer": "built"}

    async def finish(self) -> dict[str, Any]:
        result = await self.start()
        await self.executor._runs[result["run_id"]].task
        return await rlm_module.rlm.factory.status(result["run_id"])

    async def settle(self, run_result: dict[str, Any]) -> dict[str, Any]:
        run_id = run_result["run_id"]
        for _ in range(50_000):
            if self.executor._runs[run_id].state != "running":
                return await rlm_module.rlm.factory.status(run_id)
            await yield_loop_turn()
        self.fail(f"run {run_id} never left the running state")

    def node_status(self, status: dict[str, Any], node_id: str) -> dict[str, Any]:
        return next(entry for entry in status["nodes"] if entry["id"] == node_id)

    def contract_of(self, node_id: str) -> Any:
        return [call["kwargs"].get("factoryContract") for call in self.host.spawn_calls(node_id)]

    @async_test
    async def test_outputs_come_from_emit_and_reach_the_next_state(self) -> None:
        self.host.emitted["design"] = {"design": "the design", "risk": "low"}
        status = await self.finish()

        self.assertEqual(status["state"], "done")
        self.assertEqual(self.contract_of("design"), [{**self.EMIT, "inputs": {}}])
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("build")],
            ['Do the work carefully.\n\n## Inputs\n- design: the design\n- risk: "low"\n'],
        )
        self.assertEqual(self.host.calls_of("agent_message.send"), [])

    @async_test
    async def test_node_report_caps_large_outputs_without_changing_the_settle(self) -> None:
        large_output = "x" * 300_000
        self.host.emitted["report"] = {"result": large_output}
        self.store_machine(
            {
                "states": [
                    {
                        "id": "report",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "result", "type": "text"}],
                        "emit": {"outputs": [{"name": "result", "type": "text"}], "records": {}},
                    }
                ]
            },
            spec_id="node-report",
        )
        result = await self.start("node-report")
        await self.executor._runs[result["run_id"]].task
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "done")

        run = self.executor._require_run(result["run_id"])
        stored = run.states["report"].entries[-1].outputs
        self.assertEqual(stored, {"result": large_output})
        node = self.executor._node_report(result["run_id"], "report")
        preview = node["entry"]["outputs"]
        self.assertTrue(node["entry"]["outputs_truncated"])
        self.assertEqual(len(preview.encode("utf-8")), NODE_OUTPUTS_CAP)
        self.assertLess(len(json.dumps(node).encode("utf-8")), 262_144)

    @async_test
    async def test_node_activity_caps_aggregate_previews_in_the_final_frame(self) -> None:
        backslashes = "\\" * 65_536
        self.store_machine(
            {
                "states": [
                    {
                        "id": "report",
                        "entry": True,
                        "subagent": {"prompt": backslashes},
                        "outputs": [{"name": "result", "type": "text"}],
                        "emit": {"outputs": [{"name": "result", "type": "text"}], "records": {}},
                    }
                ]
            },
            spec_id="node-frame",
        )
        self.host.emitted["report"] = {"result": backslashes}
        self.host.outcomes["report"] = {"status": "done", "answer": backslashes}
        started = await self.start("node-frame")
        await self.executor._runs[started["run_id"]].task
        entry = self.executor._require_run(started["run_id"]).states["report"].entries[-1]
        self.assertEqual(entry.outputs, {"result": backslashes})
        entry.output_errors = {"risk_score": backslashes}

        sent: list[dict[str, Any]] = []
        with patch("rlm.repl._send", sent.append):
            await factory_module._run_activity(
                {
                    "id": "node-frame",
                    "action": "node",
                    "runId": started["run_id"],
                    "specId": "report",
                }
            )
        self.assertEqual(len(sent), 1)
        frame = sent[0]
        self.assertEqual(frame["event"], "done")
        self.assertEqual(frame["id"], "node-frame")
        self.assertEqual(frame["status"], "ok")
        self.assertIn("result", frame, "the bounded Node result stays available")
        self.assertLessEqual(
            len(json.dumps(frame).encode("utf-8")),
            factory_module.FACTORY_FRAME_CAP,
            "the actual event/id/status/result frame stays under the existing cap",
        )
        self.assertTrue(
            frame["result"]["instance"]["promptTruncated"]
            or frame["result"]["instance"]["answerTruncated"]
            or frame["result"]["entry"]["outputErrorsTruncated"],
            "the aggregate preview reduction is visible",
        )
        self.assertTrue(frame["result"]["entry"]["outputsTruncated"])
        self.assertTrue(frame["result"]["entry"]["outputErrorsTruncated"])
        self.assertEqual(set(frame["result"]["entry"]["outputErrors"]), {"risk_score"})
        self.assertEqual(
            self.executor._require_run(started["run_id"]).states["report"].entries[-1].outputs,
            {"result": backslashes},
            "wire preview reduction never mutates stored outputs",
        )

    @async_test
    async def test_node_wire_preserves_output_error_port_names(self) -> None:
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {
                        "id": "report",
                        "entry": True,
                        "subagent": {"prompt": "Capture the result."},
                        "outputs": [{"name": "risk_score", "type": "json"}],
                    }
                ],
            },
            spec_id="node-errors",
        )
        self.host.outcomes["report"] = {"status": "done", "answer": "not json"}
        started = await self.start("node-errors")
        await self.executor._runs[started["run_id"]].task

        node = await self.executor.activity(
            {"action": "node", "runId": started["run_id"], "specId": "report"}
        )
        errors = node["entry"]["outputErrors"]
        self.assertEqual(set(errors), {"risk_score"})
        self.assertIn("no JSON object containing output 'risk_score'", errors["risk_score"])

    async def _run_with_a_never_entered_state(self) -> str:
        self.store_machine(
            {
                "states": [
                    {
                        "id": "report",
                        "entry": True,
                        "subagent": {"prompt": "Report."},
                        "outputs": [{"name": "verdict", "type": "json"}],
                    },
                    {"id": "fix", "subagent": {"prompt": "Fix."}},
                ],
                "transitions": [
                    {
                        "from": "report",
                        "to": "fix",
                        "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False},
                    }
                ],
            },
            spec_id="node-unentered",
        )
        self.host.outcomes["report"] = {"status": "done", "answer": '{"verdict": {"approved": true}}'}
        started = await self.start("node-unentered")
        await self.executor._runs[started["run_id"]].task
        self.assertEqual(self.executor._require_run(started["run_id"]).states["fix"].entries, [])
        return started["run_id"]

    @async_test
    async def test_a_never_entered_node_state_reports_no_entry(self) -> None:
        run_id = await self._run_with_a_never_entered_state()

        node = await self.executor.activity({"action": "node", "runId": run_id, "specId": "fix"})
        self.assertIsNone(node["entry"])
        self.assertIsNone(node["instance"])
        self.assertEqual(node["state"]["instances"], [])
        with self.assertRaisesRegex(ValueError, "unknown entry 0"):
            await self.executor.activity(
                {"action": "node", "runId": run_id, "specId": "fix", "entry": 0, "instance": 0}
            )

    @async_test
    async def test_present_malformed_node_selectors_are_rejected_without_defaulting_to_latest(
        self,
    ) -> None:
        run_id = await self._run_with_a_never_entered_state()
        base = {"action": "node", "runId": run_id, "specId": "report"}
        latest = await self.executor.activity(base)
        self.assertEqual(latest["entry"]["index"], 0)
        # The kernel frame's own "no selector" shape: both keys null.
        framed = await self.executor.activity({**base, "entry": None, "instance": None})
        self.assertEqual(framed["entry"], latest["entry"])

        for selectors in (
            {"entry": 0, "instance": None},
            {"entry": True, "instance": 0},
            {"entry": "0", "instance": 0},
            {"entry": -1, "instance": 0},
            {"entry": 0},
        ):
            with self.subTest(selectors=selectors):
                with self.assertRaises(ValueError):
                    await self.executor.activity({**base, **selectors})

    @async_test
    async def test_a_successful_emit_waits_for_background_quiescence_before_dependent_writer(self) -> None:
        self.host.emitted["design"] = {"design": "the design", "risk": "low"}
        self.host.outcomes["design"]["factory_task_busy"] = True
        owner_poll = self.host.gate("rlm.collect", 2)
        started = await self.start()
        run = self.executor._runs[started["run_id"]]

        await asyncio.wait_for(self.host.gate_entered("rlm.collect", 2).wait(), 1)
        status = await rlm_module.rlm.factory.status(started["run_id"])
        self.assertEqual(status["state"], "running")
        self.assertEqual(self.node_status(status, "design")["status"], "done")
        self.assertEqual(self.node_status(status, "build")["instances"][0]["status"], "pending", status)
        self.assertEqual(self.host.spawn_calls("build"), [])
        self.assertEqual(
            self.node_status(status, "design")["instances"][0]["factory_task_activity"],
            "busy",
        )

        self.host.outcomes["design"]["factory_task_busy"] = False
        owner_poll.set()
        await run.task
        final = await rlm_module.rlm.factory.status(started["run_id"])
        self.assertEqual(final["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("build")), 1)

    @async_test
    async def test_valid_emit_with_unverified_activity_is_stored_but_holds_successor(self) -> None:
        self.host.emitted["design"] = {"design": "the design", "risk": "low"}
        self.host.outcomes["design"]["factory_task_busy"] = None
        started = await self.start()
        status = await self.settle(started)

        self.assertEqual(status["state"], "paused")
        self.assertIn("UNVERIFIED", status["pause_reason"])
        design = self.node_status(status, "design")
        self.assertEqual(design["status"], "done")
        run = self.executor._runs[started["run_id"]]
        self.assertEqual(run.states["design"].entries[0].outputs, {"design": "the design", "risk": "low"})
        self.assertEqual(design["instances"][0]["factory_task_activity"], "unverified")
        self.assertEqual(self.node_status(status, "build")["status"], "pending")
        self.assertEqual(self.host.spawn_calls("build"), [])
        self.assertIn("child-1", self.host.children)

    @async_test
    async def test_a_child_owing_an_output_is_steered_once_and_settles(self) -> None:
        self.host.emitted["design"] = {"design": "the design"}

        def repair(payload: dict[str, Any]) -> None:
            child_dir = self.host.session_root / "child-1"
            (child_dir / FACTORY_OUTPUTS_FILE).write_text(
                json.dumps({"design": "the design", "risk": "high"}), encoding="utf-8"
            )

        self.host.on_message = repair
        status = await self.finish()

        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("design")), 1)
        [message] = self.host.calls_of("agent_message.send")
        self.assertEqual(message["receiver_role"], "child")
        self.assertEqual(message["receiver_name"], self.host.children["child-1"]["name"])
        self.assertIn("await rlm.factory.emit(risk=...)", message["message"])
        kinds = [event["kind"] for event in status["events"]]
        self.assertIn("repair_requested", kinds)
        self.assertIn("repaired", kinds)

    @async_test
    async def test_output_repair_waits_for_background_task_work(self) -> None:
        self.host.emitted["design"] = {"design": "the design"}
        self.host.factory_task_busy_until_collect["design"] = 2
        repair_sent_after_collect = []
        sleeps_before_repair = []

        def repair(payload: dict[str, Any]) -> None:
            repair_sent_after_collect.append(self.host.collects)
            sleeps_before_repair.append(list(self.sleeps.sleeps))
            child_dir = self.host.session_root / "child-1"
            (child_dir / FACTORY_OUTPUTS_FILE).write_text(
                json.dumps({"design": "the design", "risk": "high"}), encoding="utf-8"
            )

        self.host.on_message = repair
        status = await self.finish()

        self.assertEqual(status["state"], "done", status)
        self.assertGreaterEqual(repair_sent_after_collect[0], 3)
        self.assertEqual(len(self.host.spawn_calls("design")), 1)
        # The settled child's collect returned at once, so the wait for its
        # background work is a poll interval, never a tight loop.
        self.assertEqual(sleeps_before_repair[0], [factory_module.REPAIR_POLL_SECONDS] * 2)

    @async_test
    async def test_unknown_task_activity_pauses_unverified_without_replacing_child(self) -> None:
        self.host.emitted["design"] = {"design": "the design"}
        self.host.outcomes["design"] = {"status": "done", "factory_task_busy": False}

        def lose_task_observation(payload: dict[str, Any]) -> None:
            self.host.outcomes["design"]["factory_task_busy"] = None

        self.host.on_message = lose_task_observation
        started = await self.start()
        status = await self.settle(started)

        self.assertEqual(status["state"], "paused")
        self.assertIn("UNVERIFIED", status["pause_reason"])
        design = self.node_status(status, "design")
        self.assertEqual(design["instances"][0]["factory_task_activity"], "unverified")
        self.assertEqual(design["instances"][0]["child"], "child-1")
        self.assertIn("child-1", self.host.children)
        self.assertEqual(len(self.host.spawn_calls("design")), 1)
        self.assertEqual(len(self.host.deleted_targets()), 0)
        self.assertEqual(len(self.host.calls_of("agent_message.send")), 1)
        self.assertIn("factory_task_activity_unverified", [event["kind"] for event in status["events"]])
        notices = self.host.calls_of("factory.progress")
        self.assertEqual([notice["kind"] for notice in notices], ["paused"])
        self.assertIn("UNVERIFIED", notices[0]["detail"])

        stopped = await rlm_module.rlm.factory.stop(started["run_id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertNotIn("child-1", self.host.children)

    @async_test
    async def test_a_repair_turn_that_runs_long_is_decided_only_when_it_ends(self) -> None:
        self.host.emitted["design"] = {"design": "the design"}
        self.host.outcomes["design"] = {"status": "done", "factory_task_busy": False}

        def repair(payload: dict[str, Any]) -> None:
            self.host.outcomes["design"]["factory_task_busy"] = True  # the repair turn runs

        self.host.on_message = repair
        started = await self.start()
        run = self.executor._runs[started["run_id"]]
        hour_later = self.clock.now + 3600
        await self.wait_until(lambda: self.clock.now >= hour_later or run.state != "running")

        self.assertEqual(run.state, "running", run.last_error)
        self.assertEqual(len(self.host.spawn_calls("design")), 1)
        self.host.outcomes["design"]["factory_task_busy"] = False  # the repair turn ended
        await run.task
        status = await rlm_module.rlm.factory.status(started["run_id"])
        self.assertEqual(status["state"], "paused")
        self.assertIn("missing_output", status["last_error"])
        self.assertEqual(len(self.host.spawn_calls("design")), 1)

    @async_test
    async def test_a_child_still_owing_after_the_repair_fails_without_a_new_child(self) -> None:
        self.host.emitted["design"] = {"design": "the design"}
        started_at = self.clock.now
        status = await self.finish()

        # The repair turn ended (the child reads idle), so the verdict
        # comes at the next read, not after a fixed wait.
        self.assertLess(self.clock.now - started_at, 2 * factory_module.REPAIR_POLL_SECONDS)

        self.assertEqual(status["state"], "paused")
        self.assertEqual(len(self.host.spawn_calls("design")), 1)
        self.assertEqual(len(self.host.calls_of("agent_message.send")), 1)
        self.assertIn(
            "missing_output: the child still owes risk after a repair request", status["last_error"]
        )

    @async_test
    async def test_resume_deletes_the_failed_emit_actor_before_replacement(self) -> None:
        self.host.emitted["design"] = {"design": "the design"}
        first = await self.finish()
        self.assertEqual(first["state"], "paused")
        self.assertIn("child-1", self.host.children)

        await rlm_module.rlm.factory.resume(first["run_id"])
        await self.executor._runs[first["run_id"]].task
        status = await rlm_module.rlm.factory.status(first["run_id"])

        self.assertEqual(status["state"], "paused")
        self.assertEqual(self.host.deleted_targets(), ["child-1"])
        self.assertNotIn("child-1", self.host.children)
        self.assertEqual(len(self.host.spawn_calls("design")), 2)


class FactoryKernelRestartTest(_ExecutorTestCase):
    """A kernel restart must not orphan a run: the registry snapshot
    rehydrates, the finished child's emitted outputs still route, and the
    run continues to completion on the new kernel's executor."""

    EMIT = {"outputs": [{"name": "design", "type": "text"}], "records": {}}

    def setUp(self) -> None:
        super().setUp()
        root = TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.host.session_root = Path(root.name)
        self.host.emitted["design"] = {"design": "the design"}
        self.store_machine(
            {
                # A generous run budget: the restarted scenario advances the
                # clock per admission, and the run must still complete.
                "run": {"budget_ms": 3_600_000},
                "states": [
                    {
                        "id": "design",
                        "entry": True,
                        "subagent": {"prompt": "Design."},
                        "outputs": [{"name": "design", "type": "text"}],
                        "emit": self.EMIT,
                    },
                    state(
                        "build",
                        inputs=[{"name": "design", "type": "text", "from": "design.design"}],
                    ),
                ],
                "transitions": [{"from": "design", "to": "build"}],
            }
        )
        # The registry's durable home: the session artifact dir the host
        # exports. A kernel restart is the executor swap below; the
        # snapshot on disk is all the new kernel recovers.
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        self.runs_dir = Path(artifact_temp.name) / "factory-runs"
        previous = os.environ.get("RLM_SESSION_DIR")
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)

    @async_test
    async def test_resume_saves_the_running_state_before_it_returns(self) -> None:
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.store_machine({"states": [state("a", entry=True)]}, spec_id="resume")
        result = await self.start("resume")
        run_id = result["run_id"]
        await self.wait_until(lambda: self.executor._runs[run_id].state == "paused")
        snapshot = factory_module._runs_dir() / f"{run_id}.json"
        self.assertEqual(json.loads(snapshot.read_text())["state"], "paused")
        self.host.outcomes["a"] = {"status": "running"}
        await rlm_module.rlm.factory.resume(run_id)
        self.assertEqual(json.loads(snapshot.read_text())["state"], "running")
        self.executor._runs[run_id].task.cancel()

    @async_test
    async def test_a_restart_after_one_join_source_settled_still_fires_the_join(self) -> None:
        # The snapshot never holds a half-applied settle: a restart while
        # the join waits on its other source continues the run.
        self.store_machine(
            {
                "run": {"max_parallel": 4},
                "states": [state("a", entry=True), state("b", entry=True), state("c")],
                "transitions": [{"from": ["a", "b"], "to": "c"}],
            },
            spec_id="join",
        )
        self.host.outcomes["a"] = {"status": "done", "answer": "a"}
        self.host.outcomes["b"] = {"status": "running"}
        first = self.host.gate("rlm.collect", 1)
        second = self.host.gate("rlm.collect", 2)
        result = await self.start("join")
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 1).wait()
        self.clock.advance(5.0)  # the loop sat in its collect for a while
        first.set()
        await self.host.gate_entered("rlm.collect", 2).wait()
        run = self.executor._runs[run_id]
        self.assertEqual(run.states["a"].entries[0].status, "done")
        run.task.cancel()

        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        self.host.outcomes["b"] = {"status": "done", "answer": "b"}
        second.set()
        await rlm_module.rlm.factory.status(run_id)
        await restarted._runs[run_id].task
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("c")), 1)

    @async_test
    async def test_a_done_run_with_a_running_resident_stays_stoppable_after_a_restart(self) -> None:
        self.host.outcomes["watcher"] = {"status": "running"}
        self.store_factory(
            {
                "nodes": [
                    {"id": "t", "subagent": "worker"},
                    {"id": "watcher", "subagent": "worker", "lifecycle": "resident"},
                ],
            },
            spec_id="resident",
        )
        result = await self.start("resident")
        run_id = result["run_id"]
        await self.executor._runs[run_id].task
        self.assertEqual(self.executor._runs[run_id].state, "done")

        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        stopped = await rlm_module.rlm.factory.stop(run_id)
        self.assertEqual(stopped["state"], "stopped")
        self.assertEqual(stopped["cancelled"], ["watcher"])
        self.assertEqual(self.host.deleted_targets(), ["child-2"])
        self.assertFalse((factory_module._runs_dir() / f"{run_id}.json").exists(), "the stopped run retires its files")

    @async_test
    async def test_a_snapshotted_run_rehydrates_and_the_childs_emit_still_routes(self) -> None:
        # Advance the clock per admission: the spawn's ledger touch lands
        # past the persist throttle, so the snapshot itself carries the
        # running child. Suspend the loop inside its first collect: the
        # design child is admitted and its emit landed, but the settle
        # never applied.
        self.host.advance_per_run = 2.0
        gate = self.host.gate("rlm.collect", 1)
        result = await self.start()
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 1).wait()
        run = self.executor._runs[run_id]
        [design] = run.states["design"].entries[0].instances
        self.assertEqual(design.status, "running")
        self.assertIsNotNone(design.child_id)
        self.assertTrue((Path(design.session_dir) / FACTORY_OUTPUTS_FILE).exists())

        # The kernel restart: the old loop task dies with the kernel, a
        # fresh executor (the new kernel's module state) rehydrates the
        # registry off the artifact dir, and the namespace routes to it.
        run.task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        gate.set()

        # The first status after the restart arms the rehydrated run: the
        # status answers the run id (never "unknown factory run"), and the
        # re-armed loop collects the child that stayed alive under the
        # supervisor, reads its emitted outputs, and the run continues.
        [adopted] = restarted._runs[run_id].states["design"].entries[0].instances
        self.assertEqual(adopted.status, "running")
        self.assertEqual(adopted.child_id, design.child_id)
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "running")
        self.assertIsNotNone(restarted._runs[run_id].task)
        await restarted._runs[run_id].task
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "done")
        self.assertEqual(
            [call["prompt"] for call in self.host.spawn_calls("build")],
            ["Do the work carefully.\n\n## Inputs\n- design: the design\n"],
        )
        self.assertEqual(len(self.host.spawn_calls("design")), 1)

    @async_test
    async def test_an_admission_inside_the_throttle_window_survives_via_its_journal(self) -> None:
        # The frozen clock keeps the spawn's ledger touch inside the
        # persist throttle: the last snapshot predates the admission, and
        # the admissions journal is the only durable record of the child.
        gate = self.host.gate("rlm.collect", 1)
        result = await self.start()
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 1).wait()
        run = self.executor._runs[run_id]
        run.task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        gate.set()

        # The journal line rebuilds the entry around its admitted child:
        # never orphaned, never re-admitted.
        rehydrated = restarted._runs[run_id]
        self.assertEqual(rehydrated.states["design"].entries_used, 1)
        [adopted] = rehydrated.states["design"].entries[0].instances
        self.assertEqual(adopted.status, "running")
        self.assertEqual(adopted.child_id, "child-1")
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "running")
        await rehydrated.task
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("design")), 1)

    @async_test
    async def test_a_stop_the_restart_interrupted_completes(self) -> None:
        collect_gate = self.host.gate("rlm.collect", 1)
        delete_gate = self.host.gate("rlm.delete_subagent", 1)
        result = await self.start()
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 1).wait()
        # stop() lands and its first child cancellation suspends on the
        # delete gate; the kernel dies mid-stop. The snapshot must say
        # "stopping" (the touch persists it), never "running".
        stop_task = asyncio.ensure_future(rlm_module.rlm.factory.stop(run_id))
        run = self.executor._runs[run_id]
        await self.host.gate_entered("rlm.delete_subagent", 1).wait()
        self.assertEqual(run.state, "stopping")
        stop_task.cancel()
        run.task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        self.assertEqual(restarted._runs[run_id].state, "stopping")

        # The first factory use after the restart completes the stop.
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "stopped")
        self.assertIn("child-1", self.host.deleted_targets())
        collect_gate.set()
        delete_gate.set()

        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "stopped")
        self.assertIn("child-1", self.host.deleted_targets())
        collect_gate.set()
        delete_gate.set()

    @async_test
    async def test_a_re_entered_states_second_entry_keeps_its_own_instance(self) -> None:
        # The instance index is per-STATE, not per-entry: a cycle's second
        # entry carries index 1 at list position 0. The journal replay must
        # locate by index attribute (never pad by position), and the
        # adopted index must never be reused (the next spawn label would
        # collide with the still-registered earlier child).
        self.store_machine(
            {
                "run": {"budget_ms": 3_600_000},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker", "max_entries": 3},
                    {"id": "b", "subagent": "worker", "max_entries": 2},
                ],
                "transitions": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}],
            },
            spec_id="cycle",
        )
        gate = self.host.gate("rlm.collect", 3)
        result = await self.start("cycle")
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 3).wait()
        # a1 settled, b1 settled, a2 admitted: the third collect is the
        # restart point, inside the throttle window for a2's admission.
        self.executor._runs[run_id].task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        gate.set()

        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "running")
        rehydrated = restarted._runs[run_id]
        a_entries = rehydrated.states["a"].entries
        self.assertEqual([entry.instances[0].index for entry in a_entries[:2]], [0, 1])
        self.assertEqual(a_entries[1].instances[0].status, "running")
        self.assertGreaterEqual(rehydrated.states["a"].instance_counter, 2)
        await rehydrated.task
        status = await rlm_module.rlm.factory.status(run_id)
        # The cycle runs to its caps without a duplicate instance, a
        # reused index, or a refused re-admission.
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("a")), 3)
        self.assertEqual(len(self.host.spawn_calls("b")), 2)
        for state_id, count in (("a", 3), ("b", 2)):
            entries = restarted._runs[run_id].states[state_id].entries
            self.assertEqual(len(entries), count)
            for entry in entries:
                self.assertEqual(len(entry.instances), 1)
                self.assertEqual(entry.status, "done")

    @async_test
    async def test_a_foreachs_pending_siblings_survive_the_throttle_window(self) -> None:
        # The prepare batch (the instances not admitted yet) is memory-only
        # between snapshots: a restart inside the throttle window must
        # replay the batch, not silently drop the pending fan items and
        # complete having run one of four.
        self.store_factory(
            {
                "run": {"max_parallel": 1},
                "nodes": [
                    {
                        "id": "src",
                        "subagent": "worker",
                        "outputs": [{"name": "items", "type": "json"}],
                    },
                    {
                        "id": "fan",
                        "subagent": "worker",
                        "foreach": {"over": "item", "max": 4},
                        "inputs": [{"name": "item", "type": "json", "from": "src.items"}],
                    },
                ],
            },
            spec_id="fan",
        )
        self.host.outcomes["src"] = {"status": "done", "answer": '```json\n{"items": [1, 2, 3, 4]}\n```'}
        gate = self.host.gate("rlm.collect", 2)
        result = await self.start("fan")
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 2).wait()
        # src settled and the fan's first child is admitted; the other
        # three instances are prepared and pending.
        self.executor._runs[run_id].task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        gate.set()

        fan = restarted._runs[run_id].states["fan"].entries[0]
        self.assertEqual(len(fan.instances), 4)
        self.assertEqual([instance.status for instance in fan.instances], ["running", "pending", "pending", "pending"])
        status = await rlm_module.rlm.factory.status(run_id)
        await restarted._runs[run_id].task
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("fan")), 4)
        self.assertTrue(all(instance.status == "done" for instance in restarted._runs[run_id].states["fan"].entries[0].instances))

    @async_test
    async def test_a_fired_join_does_not_refire_after_the_restart(self) -> None:
        # The join's last-fired signature rides the forced settle snapshot;
        # the rehydrated run must not re-enter the join target.
        self.store_machine(
            {
                "run": {"budget_ms": 3_600_000},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "entry": True, "subagent": "worker"},
                    {"id": "c", "subagent": "worker", "max_entries": 1},
                ],
                "transitions": [{"from": ["a", "b"], "to": "c"}],
            },
            spec_id="joined",
        )
        # Both sources settle in ONE collect (the batch the join waits
        # for), the join fires, c is admitted: the second collect is the
        # restart point.
        gate = self.host.gate("rlm.collect", 2)
        result = await self.start("joined")
        await self.host.gate_entered("rlm.collect", 2).wait()
        run_id = result["run_id"]
        # Both sources settled in one batch, the join fired, c is admitted.
        self.executor._runs[run_id].task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        self.assertTrue(restarted._runs[run_id].join_fired)
        gate.set()

        status = await rlm_module.rlm.factory.status(run_id)
        await restarted._runs[run_id].task
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("c")), 1)
        self.assertEqual(restarted._runs[run_id].states["c"].entries_used, 1)

    @async_test
    async def test_the_status_lane_rehydrates_through_the_default_executor(self) -> None:
        # The production seam is default_factory_executor(): a fresh module
        # state must load the registry itself, not a pre-assigned executor.
        # The default executor keeps the REAL clock while the run's
        # started_at came from the frozen one, so the budget must be
        # generous enough to span both epochs.
        self.store_machine(
            {
                "run": {"budget_ms": 10_000_000_000},
                "states": [
                    {
                        "id": "design",
                        "entry": True,
                        "subagent": {"prompt": "Design."},
                        "outputs": [{"name": "design", "type": "text"}],
                        "emit": self.EMIT,
                    },
                    state(
                        "build",
                        inputs=[{"name": "design", "type": "text", "from": "design.design"}],
                    ),
                ],
                "transitions": [{"from": "design", "to": "build"}],
            },
            spec_id="lane",
        )
        self.host.advance_per_run = 2.0
        gate = self.host.gate("rlm.collect", 1)
        result = await self.start("lane")
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 1).wait()
        self.executor._runs[run_id].task.cancel()
        factory_module._DEFAULT_EXECUTOR = None
        gate.set()
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "running")
        awaited = factory_module._DEFAULT_EXECUTOR._runs[run_id]
        self.assertIsNotNone(awaited.task)
        await awaited.task
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "done")

    @async_test
    async def test_a_persist_failure_is_one_ledger_row_and_never_a_wedge(self) -> None:
        # An unwritable registry dir must not stop the run: one
        # persist_failed row, the run keeps going and completes.
        blocked = TemporaryDirectory()
        self.addCleanup(blocked.cleanup)
        Path(blocked.name, "occupied").write_text("not a directory", encoding="utf-8")
        os.environ["RLM_SESSION_DIR"] = str(Path(blocked.name, "occupied"))
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        await run.task
        status = await rlm_module.rlm.factory.status(result["run_id"])
        self.assertEqual(status["state"], "done")
        failures = [event for event in status["events"] if event["kind"] == "persist_failed"]
        self.assertEqual(len(failures), 2)
        details = " ".join(event["detail"] for event in failures)
        self.assertIn("the run registry snapshot could not be written", details)
        self.assertIn("the run's mutation journal could not be written", details)

    @async_test
    async def test_an_unreadable_snapshot_is_skipped_loudly(self) -> None:
        runs_dir = Path(os.environ["RLM_SESSION_DIR"], factory_module.RUNS_DIR_NAME)
        runs_dir.mkdir(parents=True)
        (runs_dir / "not-json.json").write_text("{not json", encoding="utf-8")
        (runs_dir / "torn-rows.json").write_text(
            json.dumps({"run_id": "torn", "spec_id": "sw", "machine": {}, "pending_evaluations": [[1]]}),
            encoding="utf-8",
        )
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()  # neither file may crash the boot
        self.assertEqual(restarted._runs, {})

    @async_test
    async def test_a_python_call_lost_with_the_kernel_fails_through_its_policy(self) -> None:
        workdir = TemporaryDirectory()
        self.addCleanup(workdir.cleanup)
        Path(workdir.name, "restart_tools.py").write_text(
            "import time\n\ndef slow(inputs):\n    time.sleep(60)\n    return {}\n",
            encoding="utf-8",
        )
        previous_cwd = os.getcwd()
        os.chdir(workdir.name)
        self.addCleanup(os.chdir, previous_cwd)
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [
                    {"id": "call", "entry": True, "python": {"import": "restart_tools", "callable": "slow"}}
                ],
            },
            spec_id="pycall",
        )
        result = await self.start("pycall")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        while run.states["call"].entries[0].instances[0].process is None:
            await asyncio.sleep(0)
        process = run.states["call"].entries[0].instances[0].process
        self.addCleanup(process._kill)
        # The call is mid-flight and durable as running: the snapshot is
        # the state the restart recovers.
        self.executor._persist_run(run)
        run.task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "running")
        [instance] = restarted._runs[run_id].states["call"].entries[0].instances
        self.assertEqual(instance.status, "error")
        self.assertIn(factory_module.RUN_LOST_PYTHON_CALL, instance.error)
        await restarted._runs[run_id].task
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertEqual(status["state"], "failed")

    @async_test
    async def test_the_snapshot_codec_round_trips_the_run_verbatim(self) -> None:
        self.store_machine(
            {
                "run": {"budget_ms": 3_600_000},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "entry": True, "subagent": "worker"},
                    {"id": "c", "subagent": "worker", "max_entries": 1},
                ],
                "transitions": [{"from": ["a", "b"], "to": "c"}],
            },
            spec_id="codec",
        )
        result = await self.start("codec")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        await run.task
        loaded = factory_module._run_from_json(json.loads(json.dumps(factory_module._run_json(run))))
        self.assertEqual(loaded.run_id, run.run_id)
        self.assertEqual(loaded.join_fired, run.join_fired)
        # The keys are the transition's CANONICAL machine position — a
        # memory-bound id() key would "round-trip" as a dead number no
        # future evaluation can ever match again.
        self.assertEqual(list(loaded.join_fired), [(0, "c")])
        self.assertEqual(loaded.transitions_fired, run.transitions_fired)
        self.assertEqual(loaded.order, run.order)
        self.assertEqual(loaded.states["c"].entries_used, run.states["c"].entries_used)
        self.assertEqual(loaded.machine, run.machine)

    @async_test
    async def test_the_peek_lane_reads_a_rehydrated_run_without_arming_it(self) -> None:
        # The all-session overview polls each owner's live runs through the
        # ``peek`` action: the same compact unscoped graph ``graph``
        # answers, minus the rehydration re-arm. A display refresh in one
        # session must never complete another owner's interrupted flows,
        # so the read leaves the rehydrated queue and the control loop
        # untouched (the ``graph`` poll's arm is the first-use seam the
        # owner's own surfaces keep).
        self.host.advance_per_run = 2.0
        gate = self.host.gate("rlm.collect", 1)
        result = await self.start()
        run_id = result["run_id"]
        await self.host.gate_entered("rlm.collect", 1).wait()
        # While the run executes under its own control loop, the peek row
        # carries no not-armed marker: only a run still queued for its
        # re-arm does.
        healthy = await self.executor.activity({"action": "peek"})
        self.assertIsNone(
            healthy["runs"][0].get("armed"),
            "an executing run carries no not-armed marker",
        )
        run = self.executor._runs[run_id]
        run.task.cancel()

        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        gate.set()
        self.assertIn(run_id, restarted._rehydrated, "the run awaits its re-arm")

        peeked = await restarted.activity({"action": "peek"})
        self.assertEqual(
            [row["runId"] for row in peeked["runs"]], [run_id], "the wire row lists"
        )
        self.assertEqual(peeked["runs"][0]["state"], "running")
        self.assertEqual(peeked["runs"][0]["specId"], "sw")
        self.assertFalse(
            peeked["runs"][0]["armed"],
            "a run still queued for its re-arm is marked not armed: the "
            "overview paints the saved marker, never a live ticking age "
            "for a run no loop drives",
        )
        self.assertIn(
            run_id,
            restarted._rehydrated,
            "the peek read never drains the re-arm queue",
        )
        self.assertIsNone(
            restarted._runs[run_id].task,
            "the peek read never starts the re-armed control loop",
        )
        # The peek created the executor; the next executed command still
        # releases the boot arm.
        factory_module._BOOT_ARM_TASK = None
        try:
            self.assertTrue(factory_module.boot_arm_persisted_runs(), "a peek disabled the boot arm")
            await factory_module._BOOT_ARM_TASK
            self.assertNotIn(run_id, restarted._rehydrated)
            self.assertIsNotNone(restarted._runs[run_id].task)
            restarted._runs[run_id].task.cancel()
        finally:
            factory_module._BOOT_ARM_TASK = None


class FactoryEmitRetryTest(_ExecutorTestCase):
    """Typed emit outputs a child left out: the failure is the producing
    entry's, retried per instance, and resume re-admits every omitted one."""

    def setUp(self) -> None:
        super().setUp()
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.host.session_root = Path(temp.name)

    def emitted(self, child_id: str, outputs: dict[str, Any]) -> None:
        child_dir = self.host.session_root / child_id
        child_dir.mkdir(parents=True, exist_ok=True)
        (child_dir / factory_module.FACTORY_OUTPUTS_FILE).write_text(json.dumps(outputs), encoding="utf-8")

    def machine(self) -> dict[str, Any]:
        return {
            "params": {"task": "ship it"},
            "states": [
                state(
                    "plan",
                    entry=True,
                    subagent={"prompt": "Plan {task}."},
                    outputs=[{"name": "plan", "type": "json"}],
                    emit={"outputs": [{"name": "plan", "type": "plan"}], "records": {"plan": [["steps", "int"]]}},
                    retries=0,
                ),
                state(
                    "build",
                    subagent={"prompt": "Build {plan}."},
                    inputs=[{"name": "plan", "type": "json", "from": "plan.plan"}],
                    outputs=[{"name": "report", "type": "text"}],
                    emit={"outputs": [{"name": "report", "type": "text"}], "records": {}},
                    retries=0,
                ),
            ],
            "transitions": [{"from": "plan", "to": "build"}],
        }

    async def run_to_end(self) -> dict[str, Any]:
        result = await self.start()
        await self.executor._runs[result["run_id"]].task
        return await rlm_module.rlm.factory.status(result["run_id"])

    async def settle(self, run_result: dict[str, Any]) -> dict[str, Any]:
        """Yield to the control loop until the run leaves the running state."""
        run_id = run_result["run_id"]
        for _ in range(50_000):
            run = self.executor._runs[run_id]
            if run.state != "running":
                return await rlm_module.rlm.factory.status(run_id)
            await yield_loop_turn()
        self.fail(f"run {run_id} never left the running state")

    @async_test
    async def test_an_optional_output_may_be_left_out(self) -> None:
        machine = self.machine()
        machine["states"][0]["outputs"].append({"name": "note", "type": "text"})
        machine["states"][0]["emit"]["outputs"].append({"name": "note", "type": "text?"})
        self.emitted("child-1", {"plan": {"steps": 2}})
        self.emitted("child-2", {"report": "built"})
        self.store_machine(machine)
        status = await self.run_to_end()

        self.assertEqual(status["state"], "done")

    @async_test
    async def test_resume_readmits_every_foreach_instance_that_omitted_its_port(self) -> None:
        # Cursor finding: with retries=0, the first omitted instance failed
        # the entry and the other omitted instances stayed done, so resume
        # re-admitted only the first and the entry failed again on the rest.
        self.emitted("child-1", {"items": ["a", "b"]})
        self.emitted("child-4", {"report": "a"})  # fan i0 resume emit
        self.emitted("child-5", {"report": "b"})  # fan i1 resume emit
        self.store_machine(
            {
                "params": {"task": "ship it"},
                "states": [
                    state(
                        "plan",
                        entry=True,
                        subagent={"prompt": "Plan {task}."},
                        outputs=[{"name": "items", "type": "json"}],
                        emit={"outputs": [{"name": "items", "type": "json"}], "records": {}},
                    ),
                    state(
                        "fan",
                        subagent={"prompt": "Do {items}."},
                        inputs=[{"name": "items", "type": "json", "from": "plan.items"}],
                        outputs=[{"name": "report", "type": "text"}],
                        emit={"outputs": [{"name": "report", "type": "text"}], "records": {}},
                        foreach={"over": "items", "max": 2},
                        retries=0,
                    ),
                ],
                "transitions": [{"from": "plan", "to": "fan"}],
            }
        )
        result = await self.start()
        paused = await self.settle(result)

        self.assertEqual(paused["state"], "paused")
        fan = next(node for node in paused["nodes"] if node["id"] == "fan")
        self.assertEqual([instance["status"] for instance in fan["instances"]], ["error", "error"])
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(resumed["state"], "running")
        final = await self.settle(result)

        self.assertEqual(final["state"], "done")
        names = [call["kwargs"]["name"] for call in self.host.spawn_calls("fan")]
        self.assertEqual(len(names), 4)
        self.assertEqual(sum("-i0-a2" in name for name in names), 1)
        self.assertEqual(sum("-i1-a2" in name for name in names), 1)

    @async_test
    async def test_a_python_state_output_goes_through_the_contract_check(self) -> None:
        nodes = Path(self.host.session_root) / "nodes"
        nodes.mkdir()
        (nodes / "plan_nodes.py").write_text("def plan(inputs):\n    return {'plan': {'steps': 'two'}}\n", encoding="utf-8")
        machine = self.machine()
        machine["states"][0] = {
            **machine["states"][0],
            "python": {"import": "plan_nodes", "callable": "plan", "path": str(nodes)},
        }
        del machine["states"][0]["subagent"]
        self.host.check_errors[json.dumps({"plan": {"steps": "two"}}, sort_keys=True)] = (
            "plan.steps: expected int, got text \"two\""
        )
        self.store_machine(machine)
        status = await self.run_to_end()

        plan = next(entry for entry in status["nodes"] if entry["id"] == "plan")
        self.assertEqual(plan["error"], 'python state output: plan.steps: expected int, got text "two"')

    @async_test
    async def test_a_stop_during_the_python_output_check_keeps_the_entry_cancelled(self) -> None:
        nodes = Path(self.host.session_root) / "nodes"
        nodes.mkdir()
        (nodes / "plan_nodes.py").write_text("def plan(inputs):\n    return {'plan': {'steps': 2}}\n", encoding="utf-8")
        machine = self.machine()
        machine["states"][0] = {
            **machine["states"][0],
            "python": {"import": "plan_nodes", "callable": "plan", "path": str(nodes)},
        }
        del machine["states"][0]["subagent"]
        check_gate = self.host.gate("factory.check", 1)
        self.store_machine(machine)
        result = await self.start()
        await self.host.gate_entered("factory.check", 1).wait()  # the python call exited; its check is in flight
        await rlm_module.rlm.factory.stop(result["run_id"])
        check_gate.set()
        await self.executor._runs[result["run_id"]].task
        status = await rlm_module.rlm.factory.status(result["run_id"])

        plan = next(entry for entry in status["nodes"] if entry["id"] == "plan")
        self.assertEqual(status["state"], "stopped")
        self.assertEqual(plan["status"], "cancelled")
        self.assertEqual(self.host.spawn_calls("build"), [])


class FactoryEmitApiTest(unittest.TestCase):
    """The child-side API: rlm.factory.emit / rlm.factory.inputs."""

    @async_test
    async def test_emit_sends_paths_as_strings_and_names_wrong_fields(self) -> None:
        sent: list[tuple[str, dict[str, Any]]] = []

        async def host(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
            sent.append((request_type, payload or {}))
            if (payload or {}).get("outputs", {}).get("risk") == "medium":
                raise RuntimeError("risk: \"medium\" is not one of low, high")
            return {"accepted": ["design", "risk"], "missing": []}

        with patch.object(rlm_module, "host_request", host):
            reply = await rlm_module.rlm.factory.emit(design=Path("DESIGN.md"), risk="low")
            with self.assertRaisesRegex(FactoryEmitError, 'risk: "medium" is not one of low, high'):
                await rlm_module.rlm.factory.emit(risk="medium")
        self.assertEqual(reply, {"accepted": ["design", "risk"], "missing": []})
        self.assertEqual(
            sent[0], ("factory.emit", {"outputs": {"design": "DESIGN.md", "risk": "low"}, "cwd": os.getcwd()})
        )

    @async_test
    async def test_outside_a_factory_child_the_error_says_so(self) -> None:
        async def host(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
            raise RuntimeError(f'host request type "{request_type}" is not available in this session')

        with patch.object(rlm_module, "host_request", host):
            for call in (rlm_module.rlm.factory.emit(x=1), rlm_module.rlm.factory.inputs()):
                with self.assertRaisesRegex(FactoryEmitError, "work only in a child spawned by a machine"):
                    await call

    @async_test
    async def test_emit_sends_the_kernel_current_directory(self) -> None:
        sent: list[dict[str, Any]] = []

        async def record(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
            sent.append(payload or {})
            return {"accepted": ["design"], "missing": []}

        previous = os.getcwd()
        with TemporaryDirectory() as moved, patch.object(rlm_module, "host_request", record):
            os.chdir(moved)
            try:
                await rlm_module.rlm.factory.emit(design=Path("PLAN.md"))
            finally:
                os.chdir(previous)
            self.assertEqual(sent, [{"outputs": {"design": "PLAN.md"}, "cwd": os.path.realpath(moved)}])


class FactoryLibraryDrillInTest(_ExecutorTestCase):
    """The machines page's drill-in: ``library`` with a machine name answers
    the Rust loader's template in a stored spec's graph shape."""

    @async_test
    async def test_library_answers_one_machines_graph_from_the_rust_loader(self) -> None:
        self.host.described["sweep"] = {
            "name": "sweep",
            "description": "Sweep a branch.",
            "version": 2,
            "author": None,
            "params": [{"name": "task", "type": "text"}],
            "files": [{"path": "MACHINE.md \u00b7 plan", "text": "Plan {task}."}],
            "state_files": [{"state": "plan", "paths": ["MACHINE.md \u00b7 plan"]}],
            "spec": {"states": [{"id": "plan", "entry": True, "subagent": {"prompt": "Plan {task}."}}]},
        }
        graph = await self.executor.activity({"action": "library", "specId": "sweep"})
        self.assertIn(("factory.describe", {"name": "sweep"}), self.host.calls)
        self.assertIsNone(graph["runId"])
        self.assertEqual(graph["specId"], "sweep")
        self.assertEqual([state["id"] for state in graph["machine"]["states"]], ["plan"])
        self.assertEqual(graph["version"], "2")
        self.assertEqual(graph["author"], "")
        self.assertEqual(graph["params"], [{"name": "task", "type": "text"}])
        self.assertEqual(graph["stateFiles"], [{"state": "plan", "paths": ["MACHINE.md \u00b7 plan"]}])
        self.assertEqual(len(graph["files"]), 1)

    @async_test
    async def test_library_keeps_json_param_defaults_verbatim(self) -> None:
        self.host.described["sweep"] = {
            "name": "sweep",
            "description": "Sweep a branch.",
            "version": 1,
            "params": [{"name": "weights", "type": "json", "default": {"risk_score": 1}}],
            "spec": {"states": [{"id": "plan", "entry": True, "subagent": {"prompt": "Plan."}}]},
        }
        graph = await self.executor.activity({"action": "library", "specId": "sweep"})
        self.assertEqual(graph["params"][0]["default"], {"risk_score": 1})

    @async_test
    async def test_library_needs_a_machine_name(self) -> None:
        with self.assertRaises(ValueError):
            await self.executor.activity({"action": "library"})


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
        # peek is the overview's non-arming unscoped read: the same rows,
        # with no target.
        peeked = await factory_module.default_factory_executor().activity(
            {"action": "peek"}
        )
        self.assertEqual([run["runId"] for run in peeked["runs"]], [run_id])
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
# The library lane: the machine list and one machine's graph payload.
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



# ---------------------------------------------------------------------------
# MACHINE.md render, export, the import gate's spec check, and running a
# library machine by name (the Rust scan answers through factory.compile).
# ---------------------------------------------------------------------------


def rendered_spec(text: str) -> dict[str, Any]:
    """The JSON spec inside a rendered MACHINE.md's machine-spec fence."""
    return json.loads(text.split(f"```{MACHINE_SPEC_FENCE}\n", 1)[1].rsplit("\n```", 1)[0])


class MachineFileRenderTest(unittest.TestCase):
    """render_machine_file is byte-stable (the Rust parser reads it back)."""

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
        self.assertTrue(
            text.startswith(
                "---\nname: sweep\ndescription: A machine that sweeps.\nversion: 1\nauthor: Tester\n---\n"
            )
        )
        self.assertEqual(rendered_spec(text), valid_machine())

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


class MachineCliDispatchTest(unittest.TestCase):
    """cli_dispatch's one op: the import gate's structural spec check."""

    def test_validate_answers_ok_or_the_exact_errors(self) -> None:
        self.assertEqual(cli_dispatch({"op": "validate", "spec": valid_machine()}), {"ok": True})
        result = cli_dispatch({"op": "validate", "spec": {"states": []}})
        self.assertEqual(result["ok"], False)
        self.assertEqual(result["errors"], validate_factory_spec({"states": []}))

    def test_dispatch_rejects_other_payloads(self) -> None:
        for payload in ([], {"op": "list"}, {"op": "import", "path": "/x"}):
            self.assertEqual(cli_dispatch(payload)["ok"], False, payload)


# ---------------------------------------------------------------------------
# The mermaid renderer and the library graph seam (the TUI library view's
# kernel surface).
# ---------------------------------------------------------------------------


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

    def test_export_refuses_a_symlinked_target_without_following_it(self) -> None:
        # The no-overwrite path creates the file exclusively, so a symlink
        # planted at the target refuses instead of being followed and its
        # victim keeps its bytes.
        self.harness.create_factory("Sweep", "A machine that sweeps.", id="sweep", dag=valid_dag())
        victim = self.out_dir / "victim.txt"
        victim.write_text("keep me", encoding="utf-8")
        link = self.out_dir / "link.MACHINE.md"
        link.symlink_to(victim)
        with self.assertRaises(ValueError) as raised:
            export_machine("sweep", link)
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
        result = export_machine("sweep", out)
        self.assertEqual(result["source"], "spec")
        text = out.read_text(encoding="utf-8")
        self.assertIn("name: sweep\n", text)
        spec = rendered_spec(text)
        self.assertEqual(validate_factory_spec(spec), [])
        self.assertEqual(canonicalize_factory_spec(spec), canonicalize_factory_spec(valid_dag()))

    def test_entry_ids_that_are_not_machine_names_are_rejected(self) -> None:
        self.harness.create_factory("Sweep", "A machine that sweeps.", id="Sweep Entry", dag=valid_dag())
        with self.assertRaises(ValueError) as ctx:
            export_machine("Sweep Entry", self.out_dir / "x.MACHINE.md")
        self.assertIn("invalid characters", str(ctx.exception))

    def test_exports_a_runs_canonical_machine(self) -> None:
        self.harness.create_factory("Sweep", "A machine that sweeps.", id="sweep", machine=valid_machine())
        run = self.executor._create_run(
            "sweep", canonicalize_factory_spec(valid_machine()), {}, name="the run"
        )
        self.executor._runs[run.run_id] = run
        self.assertEqual(run.machine, canonicalize_factory_spec(valid_machine()))
        out = self.out_dir / "run-machine.MACHINE.md"
        result = export_machine(run.run_id, out)
        self.assertEqual(result["source"], "spec")
        self.assertEqual(
            rendered_spec(out.read_text(encoding="utf-8")), canonicalize_factory_spec(valid_machine())
        )

    def test_unknown_targets_list_every_source(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            export_machine("ghost", self.out_dir / "ghost.MACHINE.md")
        self.assertIn("no stored factory entry or live run 'ghost'", str(ctx.exception))

    def test_export_rejects_invalid_specs(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            export_factory_spec(
                {"run": {"failure_policy": "sometimes"}, "states": [{"id": "a", "entry": True, "subagent": {"prompt": "P."}}]},
                self.out_dir / "bad.MACHINE.md",
                name="sweep",
                description="A machine that sweeps.",
            )
        self.assertIn("run failure_policy must be one of", str(ctx.exception))
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
        """Script the host's library scan: ``factory.compile`` by name
        answers this MACHINE.md machine."""
        path = self.library / name / "MACHINE.md"
        self.host.compiled[name] = {
            "name": name,
            "description": "A machine that sweeps.",
            "version": "1",
            "author": "Tester",
            "spec": spec,
            "path": str(path),
        }
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
        self.assertEqual(self.host.calls_of("factory.compile"), [{"name": "sweep", "params": {}}])

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
            self.assertIn("no library machine named 'missing-spec'", str(error))

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



class FactoryJoinLiveSourcesTest(_ExecutorTestCase):
    """A join waits for every source's CURRENT round: no firing while a
    source state has a live entry (the review-loop shape — one fresh
    review plus stale siblings feeding the escalation)."""






class FactoryClockRebaseTest(_ExecutorTestCase):
    """A host reboot restarts the monotonic clock; the snapshot's wall+mono
    pair rebases every stored time field so a pre-reboot deadline reads as
    passed exactly when its wall-clock moment passed (probe D: the rebooted
    executor must not wait out the old boot's uptime)."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = os.environ.get("RLM_SESSION_DIR")

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)

    async def settle(self, run_result: dict[str, Any], *, max_polls: int = 50_000) -> dict[str, Any]:
        run_id = run_result["run_id"]
        for _ in range(max_polls):
            run = self.executor._runs[run_id]
            if run.state != "running":
                return await rlm_module.rlm.factory.status(run_id)
            await asyncio.sleep(0)
        return await rlm_module.rlm.factory.status(run_id)

    @async_test
    async def test_a_join_waits_for_a_source_still_running_its_round(self) -> None:
        # The probe-A machine: a fans out to b and c, the join [b, c]
        # enters d, and d loops back to a. Two rounds total (a's
        # max_entries 2).
        self.store_machine(
            {
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker", "max_entries": 2},
                    {
                        "id": "b", "subagent": "worker", "max_entries": 2,
                        "outputs": [{"name": "out", "type": "text"}],
                    },
                    {
                        "id": "c", "subagent": "worker", "max_entries": 2,
                        "outputs": [{"name": "out", "type": "text"}],
                    },
                    {
                        "id": "d", "subagent": "worker", "max_entries": 2,
                        "inputs": [
                            {"name": "rb", "type": "text", "from": "b.out"},
                            {"name": "rc", "type": "text", "from": "c.out"},
                        ],
                    },
                ],
                "transitions": [
                    {"from": "a", "to": "b"},
                    {"from": "a", "to": "c"},
                    {"from": ["b", "c"], "to": "d"},
                    {"from": "d", "to": "a"},
                ],
            },
            spec_id="joinlive",
        )
        # Round 2's c (child-7 by admission order) never settles until
        # the test says so: the run stalls in round 2 with b settled and
        # c live — exactly the window the join must not fire in.
        self.host.outcomes["b"] = {"status": "done", "answer": "B-ROUND-2"}
        self.host.outcomes["c"] = {"status": "done", "answer": "C-ROUND-1"}
        self.host.child_outcomes["child-7"] = {"status": "running"}
        result = await self.start("joinlive")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        # Wait for round 2's b to settle (the stall point: c live).
        deadline = time.monotonic() + 30
        while True:
            b_entries = run.states["b"].entries
            if len(b_entries) >= 2 and b_entries[1].status == "done":
                break
            assert time.monotonic() < deadline, "round 2's b never settled"
            await asyncio.sleep(0)
        # THE PIN: the join has NOT fired while c's round-2 entry runs —
        # d stays at its single round-1 entry, and the run keeps running
        # (the join waits for c, it does not bind c's stale round-1
        # output).
        self.assertEqual(len(self.host.spawn_calls("d")), 1)
        self.assertEqual(run.state, "running")
        # c's round-2 answer lands: NOW the join fires, once, with BOTH
        # fresh round-2 outputs bound.
        self.host.child_outcomes["child-7"] = {"status": "done", "answer": "C-ROUND-2"}
        status = await self.settle(result)
        self.assertEqual(status["state"], "done")
        self.assertEqual(len(self.host.spawn_calls("d")), 2)
        d_calls = self.host.spawn_calls("d")
        self.assertIn("B-ROUND-2", d_calls[1]["prompt"])
        self.assertIn("C-ROUND-2", d_calls[1]["prompt"])
        self.assertNotIn("C-ROUND-1", d_calls[1]["prompt"])

    @async_test
    async def test_a_rebooted_executor_rebases_pre_reboot_deadlines(self) -> None:
        # A failing state with the escalate policy pauses the run: the
        # snapshot persists (a terminal run retires its files).
        self.store_machine(
            {
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            },
            spec_id="clock",
        )
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        result = await self.start("clock")
        run = self.executor._runs[result["run_id"]]
        status = await self.settle(result)
        self.assertEqual(status["state"], "paused")
        # The old boot's clock: 600s of real backoff remain (the deadline
        # sits 600s past the snapshot's mono moment); snapshot; then the
        # host reboots (the new clock starts at 50).
        old_mono = self.executor._runs[result["run_id"]].revision  # noqa: F841 — read for clarity
        run.admission_backoff_until = 1_600.0
        run.revision += 1
        self.executor._persist_run(run)
        # The reboot: a NEW executor with a fresh clock at 50 (the fake
        # clock's base is 1000; the wall walked ~0 since the snapshot, so
        # the deadline's real remaining is ~600s).
        rebooted = FactoryExecutor(now=FakeClock(50.0), sleep=self.sleeps, harness=self.harness)
        rebooted.rehydrate_registry()
        run_id = result["run_id"]
        rebased = rebooted._runs[run_id]
        self.assertIsNotNone(rebased)
        self.assertIsNotNone(rebased.admission_backoff_until)
        # THE PIN: the rebased deadline carries its REAL remaining time
        # (~600s past the new clock's 50), not the old boot's uptime (the
        # un-rebased deadline would read ~1,550s out — the old base).
        self.assertLess(
            (rebased.admission_backoff_until or 0) - 50.0,
            700.0,
            f"the deadline was not rebased onto the new clock: {rebased.admission_backoff_until}",
        )




class FactoryBudgetActiveTimeTest(_ExecutorTestCase):
    """The run budget excludes paused time; the state budget measures the
    child's OWN run time (probes B and C: the owner's decision latency and
    a pause window must not throw away finished work or spend the budget)."""

    async def settle(self, run_result: dict[str, Any], *, max_polls: int = 50_000) -> dict[str, Any]:
        run_id = run_result["run_id"]
        for _ in range(max_polls):
            run = self.executor._runs[run_id]
            if run.state != "running":
                return await rlm_module.rlm.factory.status(run_id)
            await asyncio.sleep(0)
        return await rlm_module.rlm.factory.status(run_id)

    @async_test
    async def test_a_resume_after_a_long_pause_does_not_re_pause_on_the_budget(self) -> None:
        # Probe B: the run budget (60s) must not count the 2 hours the run
        # sat paused waiting for the owner.
        self.store_machine(
            {
                "run": {"budget_ms": 60_000},
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            },
            spec_id="budgetpause",
        )
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        result = await self.start("budgetpause")
        status = await self.settle(result)
        self.assertEqual(status["state"], "paused")
        # The owner waits 2 hours.
        self.clock.advance(7_200.0)
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        self.assertEqual(
            resumed["state"],
            "running",
            f"the resume re-paused on the budget: {resumed}",
        )
        # The fold: the 2-hour pause landed in paused_ms and the open
        # marker cleared — so post-resume time counts as ACTIVE again.
        # Without the fold the open marker would exclude every later
        # second and the budget could never fire again.
        run = self.executor._runs[result["run_id"]]
        self.assertIsNone(run.pause_started_at)
        self.assertGreater(run.paused_ms, 7_000_000.0)

    @async_test
    async def test_unverified_task_activity_pause_excludes_time_from_run_budget(self) -> None:
        self.store_machine(
            {
                "run": {"budget_ms": 60_000},
                "states": [
                    {
                        "id": "design",
                        "entry": True,
                        "subagent": "worker",
                        "outputs": [{"name": "design", "type": "text"}],
                    }
                ],
            },
            spec_id="budgetunverified",
        )
        self.host.emitted["design"] = {"design": "the design"}
        self.host.outcomes["design"] = {"status": "done", "factory_task_busy": False}

        def lose_task_observation(payload: dict[str, Any]) -> None:
            self.host.outcomes["design"]["factory_task_busy"] = None

        self.host.on_message = lose_task_observation
        started = await self.start("budgetunverified")
        status = await self.settle(started)
        self.assertEqual(status["state"], "paused")

        run = self.executor._runs[started["run_id"]]
        self.assertIsNotNone(run.pause_started_at)
        active_before_pause = self.executor._run_budget_active_ms(run)
        self.clock.advance(7_200.0)
        self.assertEqual(self.executor._run_budget_active_ms(run), active_before_pause)
        self.assertFalse(self.executor._run_budget_exceeded(run))

    @async_test
    async def test_a_finished_child_keeps_its_work_after_a_long_pause(self) -> None:
        # Probe C: a fails (escalate pause) while b (budget 1h) is still
        # in flight; b finishes in 20 minutes of its OWN run time; the
        # owner resumes 2 hours later. b's done settle must NOT be thrown
        # away by a wall reading that includes the pause.
        self.store_machine(
            {
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {
                        "id": "b",
                        "entry": True,
                        "subagent": "worker",
                        "budget_ms": 3_600_000,
                        "outputs": [{"name": "y", "type": "text"}],
                    },
                ],
            },
            spec_id="budgetwork",
        )
        # a errors immediately (the escalate pause lands) while b is still
        # running its review; the owner resumes 2 hours later and b
        # finishes 20 minutes later — its own duration — but 2h20m on the
        # wall.
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        self.host.outcomes["b"] = {"status": "running"}
        result = await self.start("budgetwork")
        status = await self.settle(result)
        self.assertEqual(status["state"], "paused")
        self.clock.advance(7_200.0)
        # Post-resume: a's re-admission succeeds, b finishes with 20
        # minutes of its OWN run time.
        self.host.outcomes["a"] = {"status": "done", "answer": "fine"}
        self.host.outcomes["b"] = {"status": "done", "answer": "done", "duration_ms": 1_200_000}
        resumed = await rlm_module.rlm.factory.resume(result["run_id"])
        status = await self.settle(result)
        # b's entry: done, output captured, never budget-rejected.
        run = self.executor._runs[result["run_id"]]
        b_entry = run.states["b"].entries[0]
        self.assertEqual(
            b_entry.status,
            "done",
            f"b's finished work was thrown away: {b_entry.error}",
        )
        self.assertEqual(b_entry.outputs, {"y": "done"})




class FactoryBootRearmTest(_ExecutorTestCase):
    """Persisted runs re-arm at KERNEL BOOT, not at the first factory call
    (probe I: after a restart with no factory call, the run sat frozen and
    the children settled uncollected)."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = os.environ.get("RLM_SESSION_DIR")

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)

    @async_test
    async def test_persisted_runs_rearm_at_boot_without_a_factory_call(self) -> None:
        self.store_machine(
            {
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            },
            spec_id="bootarm",
        )
        # Executor A starts the run; the child is held running.
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("bootarm")
        run_id = result["run_id"]
        old = self.executor._runs[run_id]
        # Wait for the admission, then "restart the kernel": the old loop
        # task dies, the snapshot holds a running child.
        deadline = time.monotonic() + 30
        while not old.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        old.task.cancel()
        self.executor._persist_run(old)
        # The new kernel: a FRESH executor (the module import shape) with
        # no factory call made — the boot arm alone re-arms the run.
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        try:
            self.assertTrue(
                factory_module.boot_arm_persisted_runs(),
                "the boot arm did not schedule (no snapshots?)",
            )
            boot_task = factory_module._BOOT_ARM_TASK
            self.assertIsNotNone(boot_task)
            await boot_task
            restarted = factory_module.default_factory_executor()
            self.assertIn(run_id, restarted._runs)
            self.assertIsNotNone(restarted._runs[run_id].task)
            # The child (still settled-done under the fake host) is
            # collected by the re-armed loop alone: the run completes with
            # no factory API call.
            self.host.outcomes["a"] = {"status": "done", "answer": "done"}
            await restarted._runs[run_id].task
            status = await rlm_module.rlm.factory.status(run_id)
            self.assertEqual(status["state"], "done")
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None

    @async_test
    async def test_a_graceful_kernel_teardown_leaves_an_in_flight_run_rearmable(self) -> None:
        # The shutdown inversion: a graceful daemon shutdown closes the
        # host bridge while a run is in flight, and the control loop's
        # except arm used to write state "failed" — the boot arm then
        # skipped the run at the next kernel boot, while a hard SIGKILL
        # (which writes nothing) left the run re-armable. Graceful
        # shutdown must never be worse than a kill: teardown-time bridge
        # loss keeps the run nonterminal and the boot arm re-arms it.
        self.store_machine(
            {
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            },
            spec_id="teardown",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("teardown")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        # The graceful shutdown's shape: the kernel's teardown flag is
        # already set (its shutdown path sets it before the bridge goes),
        # then the bridge raises inside the loop — the RuntimeError a
        # closed bridge produces on every host request.
        async def closed_bridge(*_args, **_kwargs):
            raise RuntimeError(
                "host connection closed; host_request cannot be answered"
            )

        with patch.object(repl_module, "_host_closed", True), patch.object(
            rlm_module, "host_request", closed_bridge
        ):
            await self.wait_until(
                lambda: any(
                    event["kind"] == "executor_error" for event in run.events
                )
            )
        # The interruption is evidence, not a verdict: no failed write.
        self.assertEqual(run.state, "running")
        errors = [event for event in run.events if event["kind"] == "executor_error"]
        self.assertEqual(len(errors), 1)
        # The kill-restart control's outcome on the graceful path: the
        # persisted run re-arms at the next kernel boot.
        run.task.cancel()
        self.executor._persist_run(run)
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        factory_module._BOOT_ARM_TASK = None
        try:
            self.assertTrue(factory_module.boot_arm_persisted_runs())
            await factory_module._BOOT_ARM_TASK
            restarted = factory_module.default_factory_executor()
            self.assertIn(run_id, restarted._runs)
            self.assertIsNotNone(
                restarted._runs[run_id].task,
                "the teardown-time loss must re-arm like a kill",
            )
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None

    @async_test
    async def test_a_teardown_time_loss_never_neuters_an_explicit_stop(self) -> None:
        # The paired control: the teardown branch only declines the
        # INVARIANT write; an explicit stop() still owns its terminal
        # state after a teardown-time bridge loss.
        self.store_machine(
            {
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            },
            spec_id="teardown-stop",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("teardown-stop")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)

        async def closed_bridge(*_args, **_kwargs):
            raise RuntimeError(
                "host connection closed; host_request cannot be answered"
            )

        with patch.object(repl_module, "_host_closed", True), patch.object(
            rlm_module, "host_request", closed_bridge
        ):
            await self.wait_until(
                lambda: any(
                    event["kind"] == "executor_error" for event in run.events
                )
            )
        stopped = await rlm_module.rlm.factory.stop(run_id)
        self.assertEqual(stopped["state"], "stopped")


class FactoryAdmissionIntentTest(_ExecutorTestCase):
    """The journal's retry admission REPLACES the snapshot's failed attempt
    (probe E), and a mid-spawn kernel death's intent line names a child the
    rehydrate deletes before the re-admission (probe F) - no orphaned child,
    no name-collision pause."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = os.environ.get("RLM_SESSION_DIR")

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)

    @async_test
    async def test_a_retry_admission_replaces_the_snapshots_failed_attempt(self) -> None:
        # Probe E: attempt 1's child is in the snapshot (it failed); the
        # retry's admission (child-2, attempt 2) lands inside the persist
        # throttle - the journal holds it, the snapshot does not.
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
                "states": [{"id": "a", "entry": True, "subagent": "worker", "retries": 1}],
            },
            spec_id="retryadmit",
        )
        # Attempt 1: the child fails; the retry's spawn is GATED so the
        # instance sits pending at attempt 1 while the snapshot is written
        # (the snapshot predates the retry). Releasing the gate lets the
        # retry admit (attempt 2, child-2, running) with only its
        # journal line carrying it.
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        retry_gate = self.host.gate("rlm.run", 2)
        result = await self.start("retryadmit")
        run = self.executor._runs[result["run_id"]]
        await self.host.gate_entered("rlm.run", 2).wait()
        instance = run.states["a"].entries[0].instances[0]
        self.assertEqual(instance.status, "pending")
        # `_admit` increments the attempt before the spawn: the gated
        # retry already carries attempt 2, still holding the failed
        # attempt's child id.
        self.assertEqual(instance.attempt, 2)
        self.executor._persist_run(run)
        retry_gate.set()
        deadline = time.monotonic() + 30
        while True:
            instance = run.states["a"].entries[0].instances[0]
            if instance.status == "running" and instance.attempt == 2:
                break
            assert time.monotonic() < deadline, "the retry never admitted"
            await asyncio.sleep(0)
        run.task.cancel()
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        instance = restarted._runs[result["run_id"]].states["a"].entries[0].instances[0]
        self.assertEqual(instance.attempt, 2)
        self.assertEqual(instance.child_id, "child-2")
        self.assertEqual(instance.status, "running")

    @async_test
    async def test_a_mid_spawn_death_orphan_is_deleted_before_the_readmission(self) -> None:
        # Probe F: an admitting intent line with no admission names a child
        # the supervisor created while the kernel died before the reply.
        # The rehydrate deletes it; the re-admission does not collide.
        self.store_machine(
            {
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            },
            spec_id="midspawn",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("midspawn")
        run = self.executor._runs[result["run_id"]]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        # The child admitted (the intent + the admission lines both
        # journaled). Now simulate the mid-spawn death SHAPE: rewrite the
        # journal with an intent line whose admission never landed.
        import json as _json

        from rlm.factory import ADMISSIONS_JOURNAL_SUFFIX, _runs_dir

        directory = _runs_dir()
        journal = directory / f"{result['run_id']}{ADMISSIONS_JOURNAL_SUFFIX}"
        # Keep the batch line + the intent, DROP the admission line: the
        # death-before-reply shape.
        rows = [_json.loads(line) for line in journal.read_text().splitlines() if line.strip()]
        kept = [row for row in rows if row.get("kind") != "admission"]
        kept.append(
            {
                "kind": "admitting",
                "state": "a",
                "entry": 0,
                "index": 0,
                "attempt": 2,
                "label": "sw-midspawn-child-99",
            }
        )
        # A live child carrying that label (the supervisor created it).
        self.host.children["child-99"] = {"name": "sw-midspawn-child-99", "node": "a"}
        run.task.cancel()
        # The snapshot FIRST (the persist absorbs the journal), then the
        # orphan intent rides a fresh journal — the death-before-reply
        # shape: the snapshot predates the intent, the admission never
        # landed.
        self.executor._persist_run(run)
        journal.write_text("\n".join(_json.dumps(row) for row in kept))
        # The fresh kernel: the resolver deletes the orphan before the
        # re-admission can collide with its name.
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = restarted
        try:
            await restarted.arm_persisted_runs()
            self.assertNotIn("child-99", self.host.children, "the orphan was not deleted")
            events = await rlm_module.rlm.factory.status(result["run_id"])
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
        kinds = [e["kind"] for e in events["events"]]
        self.assertIn("orphan_reclaimed", kinds)

class PerAttemptHost(FakeHost):
    """Every child's collect answer carries its attempt number, so stale
    round-1 bindings are distinguishable from fresh round-2 ones."""

    async def __call__(self, request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if request_type == "rlm.collect":
            for target in (payload or {}).get("targets", []):
                child = self.children.get(target)
                if child is None:
                    continue
                suffix = child["name"].split("-", 1)[1]
                node = _node_of_name(child["name"])
                self.child_outcomes.setdefault(
                    target, {"status": "done", "answer": f"answer-{node}+{suffix}"}
                )
        return await super().__call__(request_type, payload)


class FactoryJoinQueuedArrivalTest(_ExecutorTestCase):
    """Round-1 probe A3: a join source fed by TWO upstreams. In one
    collect batch the second source settles before the arrival state,
    so the join sees the source with no LIVE entry but a QUEUED
    arrival — it must wait for the arrival's own round, not bind the
    previous round's stale outputs."""

    @async_test
    async def test_a_join_waits_for_a_queued_arrival_into_its_source(self) -> None:
        # The A3 machine: a join source (b) fed by TWO upstreams - the
        # cycle's own a->z->b leg. In one collect batch c#2 settles
        # before z#2 (the state that refreshes b), so the join sees b
        # with no LIVE entry but a QUEUED arrival.
        self.host = PerAttemptHost(clock=self.clock)
        patcher = patch.object(rlm_module, "host_request", self.host)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store_machine(
            {
                # state order matters: c before z, so one collect batch
                # queues c's settle ahead of z's.
                "states": [
                    state("a", entry=True, max_entries=4),
                    state("c", max_entries=4, outputs=[{"name": "answer", "type": "text"}]),
                    state("z", max_entries=4),
                    state("b", max_entries=4, outputs=[{"name": "answer", "type": "text"}]),
                    state(
                        "j",
                        max_entries=4,
                        inputs=[
                            {"name": "rb", "type": "text", "from": "b.answer"},
                            {"name": "rc", "type": "text", "from": "c.answer"},
                        ],
                    ),
                ],
                "transitions": [
                    {"from": "a", "to": "c"},
                    {"from": "a", "to": "z"},
                    {"from": "z", "to": "b"},
                    {"from": ["b", "c"], "to": "j"},
                    {"from": "j", "to": "a"},
                ],
            },
        )
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        deadline = time.monotonic() + 30
        while True:
            if run.state in ("done", "failed", "paused", "stopped"):
                break
            assert time.monotonic() < deadline, f"the run never settled: {await rlm_module.rlm.factory.status(result['run_id'])}"
            await asyncio.sleep(0)
        j_spawns = self.host.spawn_calls("j")
        # ONE j entry per round, every rb binding FRESH (the attempt
        # suffix of the b child that round), never a stale round-1
        # binding ahead of the fresh one.
        for call in j_spawns:
            body = call["prompt"]
            rc_binding = re.findall(r"rc: (answer-c\+[^\n\s]+)", body)
            self.assertTrue(rc_binding, f"a j entry must bind rc: {body[:200]}")
            attempt = rc_binding[0].rsplit("-i", 1)[-1]
            rb_binding = re.findall(r"rb: (answer-b\+[^\n\s]+)", body)
            self.assertTrue(rb_binding, f"a j entry must bind rb: {body[:200]}")
            self.assertEqual(
                rb_binding[0].rsplit("-i", 1)[-1],
                attempt,
                f"rb must be round-{attempt}'s b answer (the queued arrival waited): {body[:200]}",
            )


def _instance_index(name: str) -> int:
    m = re.search(r"-i(\d+)(?:-a\d+)?$", name)
    return int(m.group(1)) if m else 0


class GuardedSettlesHost(FakeHost):
    """Per-instance tagged answers, a scripted z answer, and per-(node,
    instance) first-collect delays, so one collect batch can split one
    state's settle from another's (round-2 probe Q1's timing)."""

    def __init__(self, clock=None, delays=None, z_answer="stay"):
        super().__init__(clock=clock)
        self.delays = dict(delays or {})
        self.seen_collects = {}
        self.z_answer = z_answer

    async def __call__(self, request_type, payload=None):
        payload = payload or {}
        if request_type == "rlm.collect":
            for target in payload.get("targets", []):
                child = self.children.get(target)
                if child is None:
                    continue
                node = child["node"]
                inst = _instance_index(child["name"])
                n = self.seen_collects.get(target, 0)
                if (node, inst) in self.delays and n < self.delays[(node, inst)]:
                    self.seen_collects[target] = n + 1
                    self.child_outcomes[target] = {"status": "running"}
                elif node == "z":
                    fence = "```json\n" + json.dumps({"reentry": self.z_answer}) + "\n```"
                    self.child_outcomes[target] = {"status": "done", "answer": fence}
                else:
                    self.child_outcomes[target] = {
                        "status": "done",
                        "answer": "answer-" + node + "-i" + str(inst),
                    }
        return await super().__call__(request_type, payload)


class FactoryJoinDeferredTest(_ExecutorTestCase):
    """Round-2 probe Q1: a queued-arrival hold DEFERS, it does not skip.
    The promise may never land (the guard fails, the target sits at
    max_entries, a feeding join cannot complete) — the join re-runs once
    the queue drains, so the machine runs its full rounds instead of
    silently finalizing early."""

    def _install(self, host):
        self.host = host
        patcher = patch.object(rlm_module, "host_request", self.host)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def _drive(self, run, settle_limit=25.0):
        deadline = time.monotonic() + settle_limit
        while True:
            if run.state in ("done", "failed", "paused", "stopped"):
                break
            assert time.monotonic() < deadline, "the run never settled"
            await asyncio.sleep(0)
        return run.state

    def _guarded_machine(self) -> dict:
        return {
            "states": [
                state("a", entry=True, max_entries=8),
                state("c", max_entries=8, outputs=[{"name": "answer", "type": "text"}]),
                state("z", max_entries=8, outputs=[{"name": "reentry", "type": "json"}]),
                state("b", max_entries=8, outputs=[{"name": "answer", "type": "text"}]),
                state(
                    "j",
                    max_entries=8,
                    inputs=[
                        {"name": "rb", "type": "text", "from": "b.answer"},
                        {"name": "rc", "type": "text", "from": "c.answer"},
                    ],
                ),
            ],
            "transitions": [
                {"from": "a", "to": "c"},
                {"from": "a", "to": "b"},
                {"from": "b", "to": "z"},
                {"from": "z", "to": "b", "when": {"output": "reentry", "op": "eq", "value": "go"}},
                {"from": ["b", "c"], "to": "j"},
                {"from": "j", "to": "a"},
            ],
        }


    @async_test
    async def test_a_pause_after_a_defer_still_escalates(self) -> None:
        # Round-3 probe R3B: c's round-2 settle defers the join (z's
        # queued settle promises z->b), then c->d's fire hits the
        # max_transitions cap and pauses the pass. The deferred hold is
        # no longer call-local: the resume re-collects it at the next
        # pass's drain, so the join still fires and the machine runs its
        # full rounds (the resume's replay of the paused settle starts
        # at c->d's position — PAST the join — so the stash is the join's
        # only re-entry).
        self._install(GuardedSettlesHost(clock=self.clock, delays={("c", 1): 1}, z_answer="stay"))
        machine = self._guarded_machine()
        # c's settle list gains a second transition AFTER the join, so a
        # defer at the join leaves it to fire in the same main pass.
        machine["states"].append(
            {"id": "d", "subagent": "worker", "max_entries": 8,
             "outputs": [{"name": "answer", "type": "text"}]}
        )
        machine["transitions"].insert(5, {"from": "c", "to": "d"})
        machine["run"] = {"max_transitions": 9}
        self.store_machine(machine)
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        pauses = 0
        state = await self._drive(run)
        while state == "paused" and pauses < 4:
            pauses += 1
            await rlm_module.rlm.factory.resume(result["run_id"])
            state = await self._drive(run)
        # THE PIN: the full 8 rounds ran (the join fired every round —
        # including the round whose defer straddled the pause).
        self.assertEqual(state, "done")
        self.assertEqual(len(run.states["a"].entries), 8)
        self.assertEqual(len(self.host.spawn_calls("j")), 8)

    @async_test
    async def test_a_guard_that_never_passes_does_not_strand_the_join(self) -> None:
        # z always answers reentry: "stay", so z->b never fires — but the
        # queued z settle still "promises" an arrival into b at scan time.
        # c's round-2 settle shares a batch with z's (c first via the
        # one-collect delay), the exact probe-Q1 timing.
        self._install(GuardedSettlesHost(clock=self.clock, delays={("c", 1): 1}, z_answer="stay"))
        self.store_machine(self._guarded_machine())
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        final = await self._drive(run)
        # THE PIN: the machine runs its FULL 8 rounds — the join fires
        # every round with fresh bindings (the deferred hold re-runs after
        # the queue drains; the dead promise does not strand it).
        self.assertEqual(final, "done")
        self.assertEqual(len(run.states["a"].entries), 8)
        j_prompts = [c.get("prompt", "") for c in self.host.spawn_calls("j")]
        self.assertEqual(len(j_prompts), 8)
        for prompt in j_prompts:
            rb = re.findall(r"rb: (answer-b-\S+)", prompt)
            rc = re.findall(r"rc: (answer-c-\S+)", prompt)
            self.assertTrue(rb and rc, f"a j entry must bind both sources: {prompt[:200]}")
            self.assertEqual(rb[0][-2:], rc[0][-2:], f"rb and rc must be the same round: {prompt[:200]}")

    @async_test
    async def test_a_passing_guard_arrival_still_waits_for_the_fresh_source(self) -> None:
        # The control: z answers reentry: "go" — the arrival really fires,
        # b re-enters, and the join waits for the FRESH b round (the live
        # rule; the defer must not weaken it).
        self._install(GuardedSettlesHost(clock=self.clock, delays={("c", 1): 1}, z_answer="go"))
        self.store_machine(self._guarded_machine())
        result = await self.start()
        run = self.executor._runs[result["run_id"]]
        final = await self._drive(run)
        self.assertEqual(final, "done")
        self.assertEqual(len(run.states["a"].entries), 8)
        j_prompts = [c.get("prompt", "") for c in self.host.spawn_calls("j")]
        self.assertEqual(len(j_prompts), 8)
        for prompt in j_prompts:
            rb = re.findall(r"rb: (answer-b-\S+)", prompt)
            rc = re.findall(r"rc: (answer-c-\S+)", prompt)
            self.assertTrue(rb and rc, f"a j entry must bind both sources: {prompt[:200]}")


class FactoryJoinDeferredRestartTest(_ExecutorTestCase):
    """Round-4 probe R4-01: the deferred-join stash must ride the SNAPSHOT.
    A restart inside a max_transitions pause window (the wifi-outage shape)
    rehydrates the run with its pending replay — which starts PAST the join
    position — so the stash is the join's only re-entry."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = os.environ.get("RLM_SESSION_DIR")

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)
        self.artifacts = Path(artifact_temp.name)

    async def _drive(self, run, settle_limit: float = 25.0) -> str:
        deadline = time.monotonic() + settle_limit
        while True:
            if run.state in ("done", "failed", "paused", "stopped"):
                return run.state
            assert time.monotonic() < deadline, "the run never settled"
            await asyncio.sleep(0)

    def _deferred_machine(self) -> dict:
        machine = {
            "states": [
                {"id": "a", "entry": True, "subagent": "worker", "max_entries": 8},
                {"id": "c", "subagent": "worker", "max_entries": 8,
                 "outputs": [{"name": "answer", "type": "text"}]},
                {"id": "z", "subagent": "worker", "max_entries": 8,
                 "outputs": [{"name": "reentry", "type": "json"}]},
                {"id": "b", "subagent": "worker", "max_entries": 8,
                 "outputs": [{"name": "answer", "type": "text"}]},
                {"id": "d", "subagent": "worker", "max_entries": 8,
                 "outputs": [{"name": "answer", "type": "text"}]},
                {
                    "id": "j", "subagent": "worker", "max_entries": 8,
                    "inputs": [
                        {"name": "rb", "type": "text", "from": "b.answer"},
                        {"name": "rc", "type": "text", "from": "c.answer"},
                    ],
                },
            ],
            "transitions": [
                {"from": "a", "to": "c"},
                {"from": "a", "to": "b"},
                {"from": "b", "to": "z"},
                {"from": "z", "to": "b", "when": {"output": "reentry", "op": "eq", "value": "go"}},
                {"from": ["b", "c"], "to": "j"},
                {"from": "c", "to": "d"},
                {"from": "j", "to": "a"},
            ],
            "run": {"max_transitions": 9},
        }
        return machine

    @async_test
    async def test_the_restarted_resume_keeps_the_stashed_holds(self) -> None:
        self.host = GuardedSettlesHost(clock=self.clock, delays={("c", 1): 1}, z_answer="stay")
        patcher = patch.object(rlm_module, "host_request", self.host)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store_machine(self._deferred_machine(), spec_id="r4r")
        result = await self.start("r4r")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        first_state = await self._drive(run)
        # THE PIN SHAPE: the pause lands with the stash non-empty (the
        # defer preceded the max_transitions pause in the same pass).
        self.assertEqual(first_state, "paused")
        self.assertTrue(run.deferred_join_rechecks, "the pause must have stashed the join holds")
        self.executor._persist_run(run)
        snapshot = self.artifacts / "factory-runs" / f"{run_id}.json"
        self.assertTrue(snapshot.exists())
        # THE STASH RIDE: the snapshot carries the holds.
        payload = json.loads(snapshot.read_text())
        self.assertTrue(payload.get("deferred_join_rechecks"), "the stash did not ride the snapshot")
        # The restart: a new executor against the same registry.
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        rebooted.rehydrate_registry()
        reread = rebooted._runs[run_id]
        self.assertEqual(reread.state, "paused")
        self.assertTrue(reread.deferred_join_rechecks, "the stash did not survive the restart")
        # Resume on the REBOOTED executor.
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = rebooted
        try:
            pauses = 0
            await rlm_module.rlm.factory.resume(run_id)
            state_ = await self._drive(reread)
            while state_ == "paused" and pauses < 4:
                pauses += 1
                await rlm_module.rlm.factory.resume(run_id)
                state_ = await self._drive(reread)
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
        j_spawns = self.host.spawn_calls("j")
        # THE PIN: 8 rounds, 8 escalations — the straddled round's join
        # fired after the restart.
        self.assertEqual(
            (state_, len(reread.states["a"].entries), len(j_spawns)),
            ("done", 8, 8),
            "the restart lost the deferred-join stash: the straddled round's join never fired",
        )

class FactoryForeachTruncationEventTest(_ExecutorTestCase):
    """A foreach over more items than `max` spawns reports the drop (probe
    H): one `foreach_truncated` ledger event with both counts — never a
    silent 3-of-7."""

    @async_test
    async def test_a_foreach_over_max_items_emits_one_truncation_event(self) -> None:
        self.store_machine(
            {
                "run": {"failure_policy": "continue"},
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
                        "foreach": {"over": "item", "max": 3},
                        "inputs": [{"name": "item", "type": "json", "from": "src.items"}],
                    },
                ],
                "transitions": [{"from": "src", "to": "fan"}],
            },
            spec_id="trunc",
        )
        self.host.outcomes["src"] = {
            "status": "done",
            "answer": '```json\n{"items": [1, 2, 3, 4, 5, 6, 7]}\n```',
        }
        result = await self.start("trunc")
        run = self.executor._runs[result["run_id"]]
        deadline = time.monotonic() + 30
        while run.state == "running":
            assert time.monotonic() < deadline, f"the run never settled: {await rlm_module.rlm.factory.status(result['run_id'])}"
            await asyncio.sleep(0)
        status = await rlm_module.rlm.factory.status(result["run_id"])
        truncated = [e for e in status["events"] if e["kind"] == "foreach_truncated"]
        self.assertEqual(len(truncated), 1)
        self.assertIn("over 7 items", truncated[0]["detail"])
        self.assertIn("max 3", truncated[0]["detail"])
        self.assertEqual(len(self.host.spawn_calls("fan")), 3)


from rlm.factory import FactoryRun


class FactoryLedgerBoundsTest(_ExecutorTestCase):
    """The in-memory ledger is capped (F-12): no unbounded event growth
    on long runs, seqs never reuse, and the registry evicts the oldest
    terminal runs past its bound."""

    async def settle(self, run_result: dict[str, Any], *, max_polls: int = 50_000) -> dict[str, Any]:
        run_id = run_result["run_id"]
        for _ in range(max_polls):
            run = self.executor._runs[run_id]
            if run.state != "running":
                break
            await asyncio.sleep(0)
        else:
            return await rlm_module.rlm.factory.status(run_id)
        # Wait the loop task out: the finalize (its milestone) and the
        # terminal-run eviction land after the state flips, inside the
        # still-running task.
        run = self.executor._runs[run_id]
        if run.task is not None:
            await run.task
        return await rlm_module.rlm.factory.status(run_id)

    @async_test
    async def test_the_ledger_caps_and_never_reuses_a_seq(self) -> None:
        run = FactoryRun(run_id="r", spec_id="sw", name=None, machine={"states": []})
        for i in range(factory_module.PERSISTED_EVENTS_CAP + 120):
            self.executor._event(run, "tick", detail=f"event {i}")
        self.assertLessEqual(len(run.events), factory_module.PERSISTED_EVENTS_CAP)
        seqs = [event["seq"] for event in run.events]
        self.assertEqual(seqs, sorted(seqs), "the window stays in order")
        self.assertEqual(len(set(seqs)), len(seqs), "no seq is ever reused")
        self.assertEqual(seqs[-1], factory_module.PERSISTED_EVENTS_CAP + 120)
        # The watermark moved with the trim: the next event numbers above
        # every event that ever existed.
        last_seq = seqs[-1]
        self.executor._event(run, "tick", detail="after the cap")
        self.assertEqual(run.events[-1]["seq"], last_seq + 1)
        # The status window serves the trailing events with live stages.
        self.assertEqual(run.events[0]["detail"], f"event {121}")

    @async_test
    async def test_terminal_runs_evict_past_the_bound_oldest_first(self) -> None:
        limit = factory_module.RETAINED_RUNS_LIMIT
        factory_module.RETAINED_RUNS_LIMIT = 2
        try:
            self.store_machine(
                {
                    "states": [{"id": "a", "entry": True, "subagent": "worker"}],
                },
                spec_id="short",
            )
            ids = []
            for _ in range(4):
                result = await self.start("short")
                status = await self.settle(result)
                self.assertEqual(status["state"], "done")
                ids.append(result["run_id"])
                # Distinct started_at stamps: the eviction orders by start
                # time, and the frozen clock would give every run the
                # same stamp.
                self.clock.advance(1.0)
            # The registry keeps only the two newest terminal runs: the
            # older two answer unknown, exactly like a previous boot's.
            self.assertIn(ids[3], self.executor._runs)
            self.assertIn(ids[2], self.executor._runs)
            self.assertNotIn(ids[0], self.executor._runs)
            self.assertNotIn(ids[1], self.executor._runs)
        finally:
            factory_module.RETAINED_RUNS_LIMIT = limit


class FactoryRound1PinsTest(_ExecutorTestCase):
    """The round-1 re-inspection pins: a suspend does not rebase onto
    the wall clock (probe D3), status elapsed is the budget's active
    clock (probe B2), and the boot arm runs where the loop lives (the
    repl's main, not a module import hook)."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = os.environ.get("RLM_SESSION_DIR")

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)






    @async_test
    async def test_a_corrupt_marker_byte_costs_its_own_line_not_the_rehydrate(self) -> None:
        # Round-7 probe R7-01: a marker with an invalid byte raised
        # UnicodeDecodeError (a ValueError) past the recovery units — the
        # corrupt run AND every run after it silently never loaded, and
        # the boot arm armed nothing. errors='replace' costs the byte its
        # own diagnostic; every run loads.
        import sys
        from io import StringIO

        from rlm.factory import _runs_dir

        runs = []
        for spec_id, node in (("bootb1", "a"), ("bootb2", "b"), ("bootb3", "c")):
            self.store_machine(
                {"states": [{"id": node, "entry": True, "subagent": "worker"}]},
                spec_id=spec_id,
            )
            self.host.outcomes[node] = {"status": "running"}
            result = await self.start(spec_id)
            run = self.executor._runs[result["run_id"]]
            deadline = time.monotonic() + 30
            while not run.states[node].entries[0].instances:
                assert time.monotonic() < deadline, "the child never admitted"
                await asyncio.sleep(0)
            run.task.cancel()
            self.executor._persist_run(run)
            runs.append(result["run_id"])
        self.host.outcomes = {}
        names = sorted(p.name for p in _runs_dir().glob("*.json"))
        self.assertEqual(len(names), 3)
        middle_run = names[1][: -len(".json")]
        marker = _runs_dir() / f"{middle_run}.persist-failed"
        marker.write_bytes(b"the disk was full: \xff\xfe\n")
        stderr = StringIO()
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        with patch.object(sys, "stderr", stderr):
            rebooted.rehydrate_registry()
        # EVERY run loads; the corrupt marker costs its own diagnostic.
        self.assertEqual(set(rebooted._runs), set(runs))
        self.assertIn("could not persist", stderr.getvalue())

    @async_test
    async def test_the_boot_arm_arms_everything_past_a_corrupt_marker(self) -> None:
        # Round-7 probe R7-01's production shape (b2): the boot arm wired
        # as the repl does, past a corrupt marker — the arm must survive
        # and every run's registry entry must load (pre-fix: the arm died
        # and later calls silently served a one-run partial registry
        # forever).
        from rlm.factory import _runs_dir

        runs = []
        for spec_id, node in (("bootc1", "a"), ("bootc2", "b"), ("bootc3", "c")):
            self.store_machine(
                {"states": [{"id": node, "entry": True, "subagent": "worker"}]},
                spec_id=spec_id,
            )
            self.host.outcomes[node] = {"status": "running"}
            result = await self.start(spec_id)
            run = self.executor._runs[result["run_id"]]
            deadline = time.monotonic() + 30
            while not run.states[node].entries[0].instances:
                assert time.monotonic() < deadline, "the child never admitted"
                await asyncio.sleep(0)
            run.task.cancel()
            self.executor._persist_run(run)
            runs.append(result["run_id"])
        self.host.outcomes = {}
        names = sorted(p.name for p in _runs_dir().glob("*.json"))
        middle_run = names[1][: -len(".json")]
        (_runs_dir() / f"{middle_run}.persist-failed").write_bytes(b"\xff\n")
        factory_module._BOOT_ARM_TASK = None
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        try:
            self.assertTrue(factory_module.boot_arm_persisted_runs(), "the arm refused to schedule")
            task = factory_module._BOOT_ARM_TASK
            assert task is not None
            await asyncio.wait([task], timeout=10)
            executor = factory_module._DEFAULT_EXECUTOR
            assert executor is not None
            # The FULL registry loaded — the partial-registry shape is gone.
            self.assertEqual(set(executor._runs), set(runs))
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None

    @async_test
    async def test_the_rehydrate_surfaces_a_stale_persist_failed_marker(self) -> None:
        # Round-5 probe R5-01: the durable marker was write-only — nothing
        # read it, so after a restart the loss was visible only to a human
        # ls. The rehydrate path surfaces it loudly now.
        import sys
        from io import StringIO

        from rlm.factory import _runs_dir

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="marker",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("marker")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        run.task.cancel()
        self.executor._persist_run(run)
        marker = _runs_dir() / f"{run_id}.persist-failed"
        marker.write_text("the disk was full\n", encoding="utf-8")
        stderr = StringIO()
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        with patch.object(sys, "stderr", stderr):
            rebooted.rehydrate_registry()
        self.assertIn("could not persist", stderr.getvalue())
        self.assertIn("the disk was full", stderr.getvalue())

    @async_test
    async def test_the_arm_door_survives_a_non_object_journal_line(self) -> None:
        # Round-4 probe R4-02: the ARM reads the journal through
        # _journal_lines (only ValueError skipped there), so a valid-JSON
        # non-object line reached _resolve_admission_intents' line.get and
        # killed the boot arm AND every later factory call (the raw
        # AttributeError through _armed_executor). The hardening covers
        # all three journal readers now.
        from rlm.factory import ADMISSIONS_JOURNAL_SUFFIX, _runs_dir

        runs = []
        for spec_id, node in (("bootarm", "a"), ("bootarm2", "b")):
            self.store_machine(
                {"states": [{"id": node, "entry": True, "subagent": "worker"}]},
                spec_id=spec_id,
            )
            self.host.outcomes[node] = {"status": "running"}
            result = await self.start(spec_id)
            run = self.executor._runs[result["run_id"]]
            deadline = time.monotonic() + 30
            while not run.states[node].entries[0].instances:
                assert time.monotonic() < deadline, "the child never admitted"
                await asyncio.sleep(0)
            run.task.cancel()
            self.executor._persist_run(run)
            runs.append(result["run_id"])
        self.host.outcomes = {}
        names = sorted(p.name for p in _runs_dir().glob("*.json"))
        self.assertEqual(len(names), 2)
        first_run_file = names[0][: -len(".json")]
        journal_path = _runs_dir() / f"{first_run_file}{ADMISSIONS_JOURNAL_SUFFIX}"
        with open(journal_path, "a", encoding="utf-8") as handle:
            handle.write("12345\n")
        factory_module._BOOT_ARM_TASK = None
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        try:
            # THE DOOR: the lazy first-call path — _armed_executor
            # constructs, rehydrates, and arms INSIDE the namespace call
            # (no boot task first). The corrupt line in the journal is
            # read by the arm's intent resolver; unhardened, it raises
            # AttributeError THROUGH the call (the inspector's red);
            # hardened, both runs load and the status answers.
            status = await rlm_module.rlm.factory.status(runs[0])
            self.assertEqual(status["run_id"], runs[0])
            executor = factory_module._DEFAULT_EXECUTOR
            assert executor is not None
            loaded = [rid for rid in runs if rid in executor._runs]
            self.assertEqual(len(loaded), 2, "the corrupt journal cost the OTHER run")
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None

    @async_test
    async def test_a_dead_disk_leaves_a_durable_persist_failed_marker(self) -> None:
        # Round-4 probe R4-04: the in-memory persist_failed row warns "a
        # kernel restart would lose it" and is itself lost to the restart
        # it warns about. The marker survives it and names the loss — and a
        # recovered write clears it.
        from rlm.factory import _runs_dir

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="disk",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("disk")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        run.task.cancel()
        runs_dir = _runs_dir()
        # Block ONLY the snapshot write (the staging path as a directory
        # makes the open raise IsADirectoryError), so the runs dir stays
        # writable for the durable marker — the real disk-fault shape.
        blocker = runs_dir / f".{run_id}.json.tmp"
        blocker.mkdir()
        try:
            run.revision += 1
            self.executor._persist_run(run)
            kinds = [e["kind"] for e in run.events]
            self.assertIn("persist_failed", kinds, "the failure left no ledger row")
            marker = runs_dir / f"{run_id}.persist-failed"
            self.assertTrue(marker.exists(), "the failure left no durable marker")
            # A recovered write clears the stale marker.
            shutil.rmtree(blocker)
            self.executor._persist_failed.discard((run_id, "snapshot"))
            self.executor._persist_run(run)
            self.assertFalse((runs_dir / f"{run_id}.persist-failed").exists(), "the marker outlived its failure")
            self.assertTrue((runs_dir / f"{run_id}.json").exists(), "the recovered write did not land")
        finally:
            shutil.rmtree(blocker, ignore_errors=True)

    @async_test
    async def test_a_non_dict_journal_line_costs_one_run_not_the_arm(self) -> None:
        # Round-3 probe R3D: a journal line that is valid JSON but NOT an
        # object (`12345`) makes `row.get("kind")` raise AttributeError —
        # in neither the per-line nor the per-run recovery tuple, so it
        # escaped the widened try and killed the whole boot arm (the
        # stderr guard named it, but no run loaded). The recovery boundary
        # catches every exception a corrupt input file can raise now.
        import sys
        from io import StringIO

        from rlm.factory import ADMISSIONS_JOURNAL_SUFFIX, _runs_dir

        runs = []
        for spec_id, node in (("bootd", "a"), ("bootd2", "b")):
            self.store_machine(
                {"states": [{"id": node, "entry": True, "subagent": "worker"}]},
                spec_id=spec_id,
            )
            self.host.outcomes[node] = {"status": "running"}
            result = await self.start(spec_id)
            run = self.executor._runs[result["run_id"]]
            deadline = time.monotonic() + 30
            while not run.states[node].entries[0].instances:
                assert time.monotonic() < deadline, "the child never admitted"
                await asyncio.sleep(0)
            run.task.cancel()
            self.executor._persist_run(run)
            runs.append(result["run_id"])
        self.host.outcomes = {}
        names = sorted(p.name for p in _runs_dir().glob("*.json"))
        self.assertEqual(len(names), 2)
        # Corrupt the FIRST-sorted run's journal with a non-object line.
        first_run_file = names[0][: -len(".json")]
        journal_path = _runs_dir() / f"{first_run_file}{ADMISSIONS_JOURNAL_SUFFIX}"
        with open(journal_path, "a", encoding="utf-8") as handle:
            handle.write("12345\n")
        factory_module._BOOT_ARM_TASK = None
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        stderr = StringIO()
        try:
            armed = factory_module.boot_arm_persisted_runs()
            self.assertTrue(armed, "the boot arm refused to schedule")
            task = factory_module._BOOT_ARM_TASK
            assert task is not None
            with patch.object(sys, "stderr", stderr):
                await asyncio.wait([task], timeout=10)
            executor = factory_module._DEFAULT_EXECUTOR
            assert executor is not None
            # The corrupt LINE is skipped per-line (the run's own
            # mutations stand): BOTH runs load, and the arm survives —
            # the probe's pre-fix behavior was the arm dying with
            # 'int' object has no attribute 'get' and NOTHING loading.
            loaded = [rid for rid in runs if rid in executor._runs]
            self.assertEqual(len(loaded), 2)
            for rid in loaded:
                # Every loaded run got its arm outcome: a running run
                # holds a loop task; a stopping run completed its stop.
                rehydrated = executor._runs[rid]
                self.assertIn(rehydrated.state, ("running", "stopped", "done"))
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None

    @async_test
    async def test_a_corrupt_journal_line_costs_one_run_not_the_arm(self) -> None:
        # Round-2 probe Q5: one runs dir, TWO live runs, one journal with
        # a valid-JSON but wrong-typed line. The boot arm must load the
        # OTHER run and arm it (one run's corruption costs that run alone)
        # instead of dying inside rehydrate_registry with the registry
        # empty and nothing logged.
        import sys
        from io import StringIO

        runs = []
        for spec_id, node in (("bootarm", "a"), ("bootarm2", "b")):
            self.store_machine(
                {"states": [{"id": node, "entry": True, "subagent": "worker"}]},
                spec_id=spec_id,
            )
            self.host.outcomes[node] = {"status": "running"}
            result = await self.start(spec_id)
            run = self.executor._runs[result["run_id"]]
            deadline = time.monotonic() + 30
            while not run.states[node].entries[0].instances:
                assert time.monotonic() < deadline, "the child never admitted"
                await asyncio.sleep(0)
            run.task.cancel()
            self.executor._persist_run(run)
            runs.append(result["run_id"])
        self.host.outcomes = {}
        # Corrupt the FIRST run's journal: a parsed line whose counters
        # are the wrong type (no legal writer emits it; a torn tail is
        # already skipped as invalid JSON).
        from rlm.factory import ADMISSIONS_JOURNAL_SUFFIX, _runs_dir

        journal_path = _runs_dir() / f"{runs[0]}{ADMISSIONS_JOURNAL_SUFFIX}"
        with open(journal_path, "a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "kind": "batch",
                        "state": "a",
                        "entry": 0,
                        "instances": [],
                        "entries_used": "not-an-int",
                    }
                )
                + "\n"
            )
        # Boot the arm the way the repl wires it; the failure of the
        # corrupt run must not take the healthy one down.
        factory_module._BOOT_ARM_TASK = None
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        stderr = StringIO()
        try:
            armed = factory_module.boot_arm_persisted_runs()
            self.assertTrue(armed, "the boot arm refused to schedule")
            task = factory_module._BOOT_ARM_TASK
            assert task is not None
            # The patch must span the AWAIT: the arm schedules a detached
            # task, and the print happens inside it.
            with patch.object(sys, "stderr", stderr):
                await asyncio.wait([task], timeout=10)
            executor = factory_module._DEFAULT_EXECUTOR
            assert executor is not None
            # The corrupt run is skipped LOUDLY; the healthy run loaded
            # and armed (its loop task exists — the arm did not die at
            # the corrupt journal).
            self.assertIn(runs[1], executor._runs)
            self.assertNotIn(runs[0], executor._runs)
            self.assertIsNotNone(executor._runs[runs[1]].task)
            self.assertIn("is unreadable", stderr.getvalue())
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None

    @async_test
    async def test_the_real_kernel_arms_persisted_runs_at_boot(self) -> None:
        # R1-01 (probe I, round 1), reworked to the round-9 release
        # contract: the arm NEVER fires at the boot of the REAL kernel
        # process (`python -m rlm.repl`, no IPython, no factory call) —
        # a persisted live run stays frozen through a quiet boot window,
        # and the FIRST EXECUTED COMMAND releases the arm, so its
        # children collect and the snapshot moves with no factory call.
        import sys
        import tempfile

        from rlm.harness import HarnessState

        agent_dir = Path(tempfile.mkdtemp(prefix="r1-boot-agent-"))
        session_dir = Path(tempfile.mkdtemp(prefix="r1-boot-session-"))
        (agent_dir / "settings.json").write_text(json.dumps({"factory": {"enabled": True}}))
        # Phase 1 — write a live run snapshot the way a real kernel would:
        # a->b with b's child still running, then the kernel dies.
        os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = str(agent_dir)
        os.environ["RLM_SESSION_DIR"] = str(session_dir)
        harness = HarnessState(session_dir / "harness_state.json")
        harness.create_subagent("Worker", "Do the work.", id="worker")
        harness.create_factory(
            "Factory", "content", id="sw",
            machine={
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                ],
                "transitions": [{"from": "a", "to": "b"}],
            },
        )
        host = FakeHost(clock=self.clock)
        host.advance_per_run = 0.0
        host.outcomes["b"] = {"status": "running"}
        rlm_module.host_request = host
        executor = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=harness)
        factory_module._DEFAULT_EXECUTOR = executor
        try:
            result = await executor.run("sw")
            run_id = result["run_id"]
            run = executor._runs[run_id]
            deadline = time.monotonic() + 30
            while True:
                if run.states["b"].entries:
                    break
                assert time.monotonic() < deadline, "b never entered"
                await asyncio.sleep(0)
            snapshot = session_dir / "factory-runs" / f"{run_id}.json"
            self.assertTrue(snapshot.exists(), "no snapshot persisted")
            frozen = snapshot.read_text()
            run.task.cancel()
        finally:
            factory_module._DEFAULT_EXECUTOR = None
            rlm_module.host_request = self.host
        # Phase 2 — boot the REAL kernel against the same session dir; the
        # bridge answers the executor's collect with a done child. No
        # factory call: the boot arm must do the collecting.
        env = {
            **{k: v for k, v in os.environ.items() if k.upper().startswith("RLM_")},
            "PRIME_AGENT_CODING_AGENT_DIR": str(agent_dir),
            "RLM_SESSION_DIR": str(session_dir),
            # The kernel's harness state resolves through
            # RLM_HARNESS_STATE_DIR FIRST (rlm.harness._state_file), so
            # an outer session's value must never leak in: the run's
            # machine resolves its subagent specs against the harness
            # state beside the persisted run, in the session dir.
            "RLM_HARNESS_STATE_DIR": str(session_dir),
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(Path(__file__).resolve().parent.parent / "src"),
        }
        proc = subprocess.Popen(
            [sys.executable, "-m", "rlm.repl"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(session_dir),
            text=True,
            bufsize=1,
        )

        answered: list[str] = []

        async def read_frame() -> dict[str, Any]:
            while True:
                line = await asyncio.to_thread(proc.stdout.readline)
                if not line:
                    raise RuntimeError(f"kernel stdout closed: {proc.stderr.read()[:500]}")
                frame = json.loads(line)
                if frame.get("event") == "host_request":
                    data = frame.get("data") or {}
                    answered.append(str(data.get("type")))
                    reply_data: dict[str, Any] = {}
                    if data.get("type") == "rlm.collect":
                        # The collect envelope's row shape (FakeHost._entry):
                        # the executor matches rows by rlm_child_id. The
                        # frame spreads the payload at the top level
                        # ({**payload, "type": ...}), not under "payload".
                        targets = data.get("targets", [])
                        reply_data = {
                            "results": [
                                {
                                    "rlm_child_id": target,
                                    "session_name": f"child-{target[-4:]}",
                                    "session_dir": f"/tmp/{target}",
                                    "status": "done",
                                    "settled": True,
                                    "tool_use_count": 1,
                                    "duration_ms": 5,
                                    "answer_text": "boot arm collected me",
                                }
                                for target in targets
                            ]
                        }
                    elif data.get("type") == "rlm.list_subagents":
                        reply_data = {"subagents": []}
                    proc.stdin.write(
                        json.dumps(
                            {"type": "host_reply", "id": frame["id"],
                             "data": {"status": "ok", "result": reply_data}}
                        )
                        + "\n"
                    )
                    proc.stdin.flush()
                    continue
                return frame

        try:
            ready = await read_frame()
            self.assertEqual(ready.get("event"), "ready")

            async def drain_frames() -> None:
                while not drained.is_set():
                    await read_frame()

            # ONE drain lives for the whole phase: a cancelled drain leaves
            # an orphaned `to_thread` reader that can swallow a frame
            # nobody else can answer, so the quiet window and the execute
            # window share this task (it is cancelled only after the
            # movement polling ends, when no answer matters anymore).
            drained = asyncio.Event()
            drain_task = asyncio.get_running_loop().create_task(drain_frames())
            # The boot NEVER arms (the round-9 release contract): a quiet
            # window — no restore, no executed command, no factory call —
            # leaves the persisted run exactly frozen. A boot-time arm
            # (the reverted pattern) collects within this window and the
            # frozen-snapshot assertion goes red.
            await asyncio.sleep(4)
            self.assertTrue(snapshot.exists(), "the run snapshot vanished before any release")
            self.assertEqual(
                snapshot.read_text(),
                frozen,
                "the boot armed the persisted run before any execute or proven restore",
            )

            # The FIRST EXECUTED COMMAND is the release: no factory API
            # call, no restore — the arm fires from the execute and the
            # run advances while the kernel idles. The snapshot MOVES (a
            # re-persist) or RETIRES (a terminal run's file); either
            # proves the execute-released arm collected the child. The
            # drain keeps answering the executor's collect frames while
            # this side only polls the file: nobody else reads the
            # kernel's stdout, and an unanswered host request wedges the
            # arm's control loop.
            proc.stdin.write(json.dumps({"type": "execute", "id": "release", "code": "1 + 1"}) + "\n")
            proc.stdin.flush()
            moved = False
            retired = False
            try:
                for _ in range(300):
                    await asyncio.sleep(0.05)
                    if not snapshot.exists():
                        moved, retired = True, True
                        break
                    if snapshot.read_text() != frozen:
                        moved = True
                        break
                    if proc.poll() is not None:
                        break
            finally:
                drained.set()
                drain_task.cancel()
            # Shut the kernel down and read its stderr BEFORE the
            # verdict: the arm's detached task prints its failures
            # there ("factory boot arm failed: ..."), and an unread
            # stderr pipe would block this read against a live kernel.
            proc.stdin.write(json.dumps({"type": "shutdown", "id": "bye"}) + "\n")
            proc.stdin.flush()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            kernel_stderr = proc.stderr.read()[-500:] if proc.stderr else ""
            self.assertTrue(
                moved,
                f"the execute never released the persisted run's arm; answered: {answered}; kernel stderr: {kernel_stderr!r}",
            )
            if retired:
                return  # the run finalized and retired its snapshot
            arm_state = json.loads(snapshot.read_text())
            self.assertNotEqual(arm_state["state"], "running", "the run never advanced after the execute released the arm")
        finally:
            pass

    @async_test
    async def test_a_suspend_does_not_charge_the_budget(self) -> None:
        # Round-1 probe D3: a snapshot whose WALL clock reads 2h behind
        # the real one while the monotonic reading barely advanced is a
        # suspend (Linux pauses CLOCK_MONOTONIC through sleep; the wall
        # clock walks) — NOT a restart. The budget keeps the snapshot's
        # monotonic reading; only now < mono (a reboot/restore) shifts.
        self.store_machine(
            {
                "run": {"budget_ms": 60_000},
                "states": [{"id": "a", "entry": True, "subagent": "worker"}],
            },
            spec_id="clock",
        )
        self.host.outcomes["a"] = {"status": "error", "error": "boom"}
        result = await self.start("clock")
        run = self.executor._runs[result["run_id"]]
        run_id = result["run_id"]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "paused":
                break
            assert time.monotonic() < deadline, "the run never paused"
            await asyncio.sleep(0)
        # The paused run persisted its snapshot (with the clock pair).
        self.executor._persist_run(run)
        from rlm.factory import _runs_dir

        snapshot_path = _runs_dir() / f"{run_id}.json"
        snapshot = json.loads(snapshot_path.read_text())
        snapshot_mono = snapshot["clock"]["mono"]
        # The suspend shape at rehydrate: the wall clock reads 7200s
        # ahead of the snapshot's wall, but the new monotonic base sits
        # only 1s past the snapshot's mono (the clock paused through the
        # sleep). The wall pair is crafted: the real wall walked 7200s
        # since the snapshot moment.
        snapshot["clock"]["wall"] = time.time() - 7200.0
        snapshot_path.write_text(json.dumps(snapshot))
        resumed = FactoryExecutor(
            now=FakeClock(snapshot_mono + 1.0), sleep=self.sleeps, harness=self.harness
        )
        resumed.rehydrate_registry()
        rehydrated = resumed._runs[run_id]
        self.assertIsNotNone(rehydrated)
        # THE PIN: the suspend shifted nothing — started_at keeps the
        # snapshot's reading (the old drift guard moved it by the 7200s
        # of wall time and blew the 60s budget).
        self.assertAlmostEqual(rehydrated.started_at, snapshot["started_at"], delta=1.0)
        self.assertFalse(resumed._run_budget_exceeded(rehydrated), "a suspend charged the run budget")

    @async_test
    async def test_status_elapsed_excludes_paused_time(self) -> None:
        # Round-1 probe B2/R1-05: a 2h escalate pause must not read as
        # elapsed budget. status()'s elapsed_ms is the budget's own
        # active-time clock.
        self.store_machine(
            {
                "run": {"budget_ms": 60_000},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker", "failure_policy": "escalate"},
                    {"id": "b", "subagent": "worker"},
                ],
                "transitions": [{"from": "a", "to": "b"}],
            },
        )
        self.host.outcomes["a"] = {"status": "error", "error": "needs the owner"}
        result = await self.start()
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "paused":
                break
            assert time.monotonic() < deadline, "the run never paused"
            await asyncio.sleep(0)
        self.clock.advance(7200.0)
        status = await rlm_module.rlm.factory.status(run_id)
        self.assertLess(status["elapsed_ms"], 60_000, "a long pause reads as elapsed budget")


class FactoryRegistryCorruptionTest(_ExecutorTestCase):
    """Round-8 probes R8-01/R8-02 + their fixes: corruption that still
    PARSES (a flipped bit, a stray copy, a hand-edited id) must cost its
    own run one loud line at the shared surfaces — the arm loop, the
    unscoped graph, the rehydrate — never the whole boot."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = os.environ.get("RLM_SESSION_DIR")

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)
        self.artifacts = Path(artifact_temp.name)

    def _runs_dir(self) -> Path:
        from rlm.factory import _runs_dir

        directory = _runs_dir()
        assert directory is not None
        return directory

    async def _three_paused_runs(self) -> tuple[str, str, str]:
        runs = []
        for spec_id, node in (("bootp1", "a"), ("bootp2", "b"), ("bootp3", "c")):
            self.store_machine(
                {"states": [{"id": node, "entry": True, "subagent": "worker"}]},
                spec_id=spec_id,
            )
            self.host.outcomes[node] = {"status": "running"}
            result = await self.start(spec_id)
            run = self.executor._runs[result["run_id"]]
            deadline = time.monotonic() + 30
            while not run.states[node].entries[0].instances:
                assert time.monotonic() < deadline, "the child never admitted"
                await asyncio.sleep(0)
            run.task.cancel()
            self.executor._persist_run(run)
            runs.append(result["run_id"])
        self.host.outcomes = {}
        return runs[0], runs[1], runs[2]

    def _fresh(self) -> FactoryExecutor:
        return FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)


    @async_test
    async def test_a_lone_lost_run_names_the_loss_at_boot(self) -> None:
        # Round-9 probe R9-04: when the lost run is the session's ONLY
        # run, the boot gate counted only *.json — no executor existed at
        # boot and the loss line never printed (the R1-01 pattern small
        # scale). The gate counts .persist-failed markers now.
        import sys
        from io import StringIO

        from rlm.factory import _runs_dir_snapshots

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="lone",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("lone")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        run.task.cancel()
        blocker = self._runs_dir() / f".{run_id}.json.tmp"
        blocker.mkdir()
        for suffix in (".json", ".admissions.jsonl"):
            (self._runs_dir() / f"{run_id}{suffix}").unlink(missing_ok=True)
        run.revision += 1
        self.executor._persist_run(run)
        self.host.outcomes = {}
        # The gate now opens on the marker alone.
        self.assertTrue(_runs_dir_snapshots(), "the boot gate stayed closed on a lone marker")
        factory_module._BOOT_ARM_TASK = None
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        captured = StringIO()
        try:
            self.assertTrue(factory_module.boot_arm_persisted_runs(), "the arm refused to schedule")
            task = factory_module._BOOT_ARM_TASK
            assert task is not None
            with patch.object(sys, "stderr", captured):
                await asyncio.wait([task], timeout=10)
            self.assertIn("could not write its first registry snapshot", captured.getvalue())
        finally:
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None
            shutil.rmtree(blocker, ignore_errors=True)

    def test_the_loss_line_survives_an_undecodable_marker_name(self) -> None:
        # Round-9 probe R9-01's sibling: every diagnostic the registry
        # prints must ENCODE as UTF-8 — on Linux a flipped bit in a file
        # NAME arrives as a lone surrogate (surrogateescape), and printing
        # it raw put the escape into the kernel's stderr frame, which the
        # host's serde_json rejects: "Kernel protocol error" for every
        # cell, every boot. _shown renders the byte as printable text.
        import sys
        from io import StringIO

        from rlm.factory import _shown

        undecodable_name = "\udcb5 lone.json"  # a Linux listing's surrogateescape
        # THE PIN: the printed diagnostic must ENCODE as UTF-8 — the raw
        # name cannot (the exact mechanism: the kernel frame carries the
        # lone-surrogate escape and the host's serde_json rejects it —
        # "Kernel protocol error" for every cell of the session).
        _shown(undecodable_name).encode("utf-8")
        self.assertIn("lone.json", _shown(undecodable_name))
        # The raw form really is undecodable (the flip the fix renders).
        with self.assertRaises(UnicodeEncodeError):
            undecodable_name.encode("utf-8")

    @async_test
    async def test_a_scan_stat_fault_costs_nothing(self) -> None:
        # Round-9 probe R9-02: the load-end marker scan ran OUTSIDE every
        # recovery unit — a stat fault on a snapshot path killed the
        # rehydrate AFTER the registry loaded (the boot arm armed nothing;
        # the first lazy call raised raw).
        import errno

        first, middle, last = await self._three_paused_runs()
        (self._runs_dir() / f"{middle}.persist-failed").write_text("x\n", encoding="utf-8")
        real_exists = Path.exists

        def exists(path: Path) -> bool:
            if path.name == f"{middle}.json":
                # The scan stats the (absent) snapshot next to the marker.
                raise OSError(errno.EIO, "Input/output error", str(path))
            return real_exists(path)

        import sys
        from io import StringIO

        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(Path, "exists", exists), patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        # All three runs load; the boot arm works afterwards.
        self.assertEqual(set(rebooted._runs), {first, middle, last})

    def test_an_unlistable_runs_dir_names_the_loss(self) -> None:
        # Round-9 probe R9-08: a runs dir that cannot be listed read as
        # "no runs" with no line — every run lost for the boot, nothing
        # said so.
        import sys
        from io import StringIO

        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(sys.modules["os"], "listdir", side_effect=OSError(5, "Input/output error")), \
                patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertIn("could not be read", captured.getvalue())



    @async_test
    async def test_the_graph_guard_prints_once_per_run_per_boot(self) -> None:
        # Round-9 probe R9-03: the guard printed one line per POLL — a 2s
        # TUI poll filled the kernel's 64 KiB background buffer with one
        # repeated line in about 12 minutes. Once per run per boot now.
        import sys
        from io import StringIO

        first, _, last = await self._three_paused_runs()
        # A chained run holds transition_fired events; the seq->sep flip
        # is a parseable corruption that reaches the graph guard.
        self.store_machine(
            {
                "states": [state("p", entry=True), state("q"), state("r")],
                "transitions": [{"from": "p", "to": "q"}, {"from": "q", "to": "r"}],
            },
            spec_id="chainr3",
        )
        self.host.outcomes["r"] = {"status": "running"}
        result = await self.start("chainr3")
        chained = result["run_id"]
        run = self.executor._runs[chained]
        deadline = time.monotonic() + 30
        while run.transitions_fired < 2 or not run.states["r"].entries:
            assert time.monotonic() < deadline, "the chain never ran"
            await asyncio.sleep(0)
        run.task.cancel()
        self.executor._persist_run(run)
        self.host.outcomes = {}
        snapshot = self._runs_dir() / f"{chained}.json"
        raw = snapshot.read_bytes()
        at = raw.index(b'"kind": "transition_fired"') if b'"kind": "transition_fired"' in raw else raw.index(b'"kind":"transition_fired"')
        seq_at = raw.rindex(b'"seq"', 0, at)
        snapshot.write_bytes(raw[:seq_at] + b'"sep"' + raw[seq_at + 5:])
        captured = StringIO()
        rebooted = self._fresh()
        rebooted.rehydrate_registry()
        with patch.object(sys, "stderr", captured):
            for _ in range(5):
                rebooted.graph()
        line = "cannot render in the factory"
        self.assertEqual(captured.getvalue().count(line), 1, "the guard printed per poll")




    def test_the_lane_belt_refuses_a_lone_surrogate_frame(self) -> None:
        # Round-11 R11-04 (MD): the belt had no pin. A frame carrying a
        # lone surrogate — in a value OR a key — must trip the belt and
        # refuse its result.
        from rlm.factory import _cap_factory_frame

        frame = {"status": "ok", "result": {"runs": [{"runId": "x", "label": "\udc55"}]}}
        _cap_factory_frame(frame)
        self.assertEqual(frame["status"], "error")
        self.assertIn("lone surrogate", frame["reason"])
        clean = {"status": "ok", "result": {"runs": [{"runId": "x", "label": "fine"}]}}
        _cap_factory_frame(clean)
        self.assertEqual(clean["status"], "ok")
        key_frame = {"status": "ok", "result": {"runs": [{"\udc55key": "v"}]}}
        _cap_factory_frame(key_frame)
        self.assertEqual(key_frame["status"], "error", "the belt skipped a KEY")

    def test_the_cleaner_survives_deep_legal_json(self) -> None:
        # Round-11 probe R11-03: the recursive cleaner blew the stack on
        # 500-level legal JSON. The shape-C cleaner carries the depth in C.
        from rlm.factory import _clean_surrogates

        deep = json.loads("[" * 500 + "1" + "]" * 500)
        self.assertIs(_clean_surrogates(deep), deep)

    def test_a_surrogate_snapshot_name_prints_safe_at_the_site(self) -> None:
        # Round-11 R11-04 (M1): R9-01 had only a helper-level pin. The
        # SITE: a rehydrate whose listing carries an undecodable name
        # (a Linux surrogateescape) prints its skip line through _shown —
        # the text is UTF-8 encodable (the protocol-safe shape).
        import sys
        from io import StringIO

        undecodable = "\udcb5 lone.json"
        captured = StringIO()
        with patch.object(sys.modules["os"], "listdir", return_value=[undecodable]), \
                patch.object(sys, "stderr", captured):
            from rlm.factory import FactoryExecutor
            executor = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
            executor.rehydrate_registry()
        line = captured.getvalue()
        self.assertIn("is unreadable", line)
        line.encode("utf-8")  # the site's print is protocol-safe


    @async_test
    async def test_a_childs_surrogate_json_output_binds_clean_at_the_decode_point(self) -> None:
        # Round-13 pin MB (the honest decode-point pin, the child's
        # verified shape): a child's JSON output with a lone-surrogate
        # KEY (R11-01's channel) — through the REAL _parse_json_output
        # path — must bind as rendered text in the downstream spawn.
        # (The earlier "child-output" pin tested the helper directly and
        # its mutation left the suite green.)
        # An EMIT-CONTRACT state: the input rides factoryContract.inputs
        # in the rlm.run frame — the structured payload channel a lone
        # surrogate KEY rides (R11-01's shape; a plain prompt-only
        # binding renders through json.dumps and is dumps-safe).
        machine = {
            "states": [
                {
                    "id": "a",
                    "entry": True,
                    "subagent": "worker",
                    "outputs": [{"name": "sizes", "type": "json"}],
                },
                {
                    "id": "b",
                    "subagent": {"prompt": "Summarize the sizes."},
                    "inputs": [{"name": "sizes", "type": "json", "from": "a.sizes"}],
                    "outputs": [{"name": "summary", "type": "text"}],
                    "emit": {"outputs": [{"name": "summary", "type": "text"}], "records": {}},
                },
            ],
            "transitions": [{"from": "a", "to": "b"}],
        }
        key_answer = (
            "Sizes per file.\n```json\n"
            + json.dumps({"sizes": {"report\udcb5.txt": 1234, "notes.txt": 7}})
            + "\n```"
        )
        self.host.outcomes["a"] = {"status": "done", "answer": key_answer}
        self.host.outcomes["b"] = {"status": "running"}
        self.store_machine(machine, spec_id="decodepoint")
        result = await self.start("decodepoint")
        run = self.executor._runs[result["run_id"]]
        deadline = time.monotonic() + 30
        while not self.host.spawn_calls("b"):
            assert time.monotonic() < deadline, "b never spawned"
            await asyncio.sleep(0)
        run.task.cancel()
        from rlm.factory import _frame_has_lone_surrogate

        b_payload = self.host.spawn_calls("b")[0]
        self.assertFalse(
            _frame_has_lone_surrogate(b_payload),
            "a lone surrogate key rode the contract inputs into the rlm.run frame",
        )

    @async_test
    async def test_a_flipped_emoji_bit_costs_its_own_line_not_the_protocol(self) -> None:
        # Round-10 probe R10-01 (trigger 1): one flipped bit in a persisted
        # emoji escape keeps the JSON valid and leaves a LONE SURROGATE in
        # the decoded snapshot — the kernel frame then carried the escape
        # and the host's serde_json rejected it: "Kernel protocol error"
        # for the session, every boot. The decode point cleans it now:
        # the run loads, the status answer renders safe.
        import sys
        from io import StringIO

        first, middle, last = await self._three_paused_runs()
        snapshot = self._runs_dir() / f"{middle}.json"
        payload = json.loads(snapshot.read_text(encoding="utf-8"))
        # Seed a rocket emoji into the run's name, persist, then flip one
        # bit in its low escape (0x5c -> 0x7c breaks the pair).
        payload["name"] = "review 🚀 sweep"
        raw = json.dumps(payload)
        flipped = raw.replace("\\ud83d\\ude80", "\\ud83d|\\ude80", 1)
        snapshot.write_text(flipped, encoding="utf-8")
        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertEqual(set(rebooted._runs), {first, middle, last})
        status = await rebooted.status(middle)
        # THE PIN: the decoded value carries no lone surrogate CODE POINT
        # (the host's parser rejects the frame; the belt would trip, but
        # the decode-point cleaner keeps the value itself safe).
        def _has_lone(value: Any) -> bool:
            if isinstance(value, str):
                return any(0xD800 <= ord(ch) <= 0xDFFF for ch in value)
            if isinstance(value, list):
                return any(_has_lone(item) for item in value)
            if isinstance(value, dict):
                return any(_has_lone(item) for item in value.values())
            return False

        self.assertFalse(_has_lone(status), "a lone surrogate survived the decode point")

    @async_test
    async def test_a_childs_lone_surrogate_output_binds_safely(self) -> None:
        # Round-10 probe R10-01 (trigger 2) + round-11 R11-01 (the KEY
        # channel): a child's JSON output carrying a lone-surrogate escape
        # — in a VALUE or a KEY — used to flow raw into the binding and
        # every downstream spawn request. The decode point cleans both.
        from rlm.factory import _clean_surrogates, _frame_has_lone_surrogate

        dirty = {"\udc55finding": "cut mid \ud83d emoji"}
        self.assertTrue(_frame_has_lone_surrogate(dirty), "the belt must see the dirty shape")
        value = _clean_surrogates(dirty)
        self.assertFalse(_frame_has_lone_surrogate(value), "a lone surrogate survived the decode point (key or value)")
        self.assertIn("\\udc55finding", value, "the key rendered as escape text")

    @async_test
    async def test_an_unlistable_runs_dir_names_the_loss_at_boot(self) -> None:
        # Round-10 probe R10-03: the boot gate mapped every listdir
        # OSError to False, so the R9-08 line never printed at boot. The
        # gate opens for a listing fault now (except the fresh-session
        # FileNotFoundError).
        import sys
        from io import StringIO

        from rlm.factory import _runs_dir_snapshots

        captured = StringIO()
        with patch.object(sys.modules["os"], "listdir", side_effect=OSError(5, "Input/output error")):
            with patch.object(sys, "stderr", captured):
                self.assertTrue(_runs_dir_snapshots(), "the gate stayed closed on a listing fault")

    def test_the_arm_guard_row_reads_the_error_key(self) -> None:
        # Round-10 probe R10-05: the arm-guard row stored its failure
        # under `detail` while the control loop's three other
        # executor_error rows use `error` — the lane and status read one
        # shape now.
        src_text = factory_module.__dict__.get("__file__") or __import__("inspect").getsourcefile(factory_module)
        src_text = open(src_text, encoding="utf-8").read()
        guard_at = src_text.find("could not be re-armed after a kernel")
        self.assertNotEqual(guard_at, -1, "the arm guard's row is gone")
        row_block = src_text[max(0, guard_at - 500):guard_at]
        self.assertIn('"error":', row_block)
        self.assertNotIn('"detail":', row_block)


    @async_test
    async def test_the_journal_replay_cleans_a_pending_batch(self) -> None:
        # Round-12 probe J2: a settle's batch lives ONLY in the journal
        # (the snapshot predates it). One bit flip in its persisted emoji
        # escape left a lone surrogate that the replay carried into the
        # rehydrated run — the boot arm's first act was the poisoned
        # rlm.run frame, every boot (a mid-spawn SIGKILL leaves the
        # journal the only record). The replay decode point cleans.
        import sys
        from io import StringIO

        from rlm.factory import ADMISSIONS_JOURNAL_SUFFIX, _runs_dir

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="replay",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("replay")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        run.task.cancel()
        self.executor._persist_run(run)
        # Seed the journal with a batch row whose content carries a lone
        # surrogate (one flipped bit in an emoji escape).
        journal = _runs_dir() / f"{run_id}{ADMISSIONS_JOURNAL_SUFFIX}"
        row = json.dumps(
            {
                "kind": "batch",
                "state": "a",
                "entry": 0,
                "instances": [
                    {"index": 1, "status": "pending", "prompt": "plan \ud83d|\ude80 now"}
                ],
                "entries_used": 1,
            }
        )
        with open(journal, "a", encoding="utf-8") as handle:
            handle.write(row + "\n")
        self.host.outcomes = {}
        captured = StringIO()
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        with patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        reread = rebooted._runs[run_id]
        from rlm.factory import _frame_has_lone_surrogate

        for st in reread.states.values():
            for entry in st.entries:
                for inst in entry.instances:
                    self.assertFalse(
                        _frame_has_lone_surrogate(inst.prompt),
                        "a lone surrogate rode the replayed batch",
                    )

    def test_a_python_states_surrogate_output_binds_clean(self) -> None:
        # Round-12 pin MP: the _python_outputs cleaner had no pin. A
        # python state's stdout JSON carrying a lone surrogate (a key or a
        # value) renders safe at the decode point.
        from rlm.factory import _frame_has_lone_surrogate, _python_outputs

        spec = {"outputs": [{"name": "plan", "type": "text"}]}
        stdout = json.dumps({"plan": "go \ud83d|\ude80 now"})
        outputs = _python_outputs(spec, stdout)
        self.assertIsInstance(outputs, dict)
        self.assertFalse(_frame_has_lone_surrogate(outputs), "the python outputs rode the surrogate")

    @async_test
    async def test_a_marker_stat_error_costs_its_own_line(self) -> None:
        # R8-02/F1: on the repo floor (3.11), Path.exists() re-raises
        # every OSError outside ENOENT/ENOTDIR/EBADF/ELOOP — a metadata
        # read error on exactly the marker's inode escaped the loop one
        # line above the r7 read fix, killing the whole rehydrate.
        import errno
        import pathlib

        first, middle, last = await self._three_paused_runs()
        marker = self._runs_dir() / f"{middle}.persist-failed"
        marker.write_text("x\n", encoding="utf-8")

        real_exists = pathlib.Path.exists

        def exists(path: pathlib.Path) -> bool:
            if path.name == f"{middle}.persist-failed":
                # The repo floor's shape (3.11): Path.exists() re-raises
                # OSError outside its ENOENT/ENOTDIR/EBADF/ELOOP set — a
                # metadata read error on exactly the marker's inode. (On
                # 3.13+ pathlib swallows it, so the raise is injected at
                # the seam the guard actually owns.)
                raise OSError(errno.EIO, "Input/output error", str(path))
            return real_exists(path)

        import sys
        from io import StringIO

        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(pathlib.Path, "exists", exists), patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertEqual(set(rebooted._runs), {first, middle, last})
        self.assertIn("(the marker's text is unreadable)", captured.getvalue())

    @async_test
    async def test_an_unhashable_run_id_costs_its_run_alone(self) -> None:
        # R8-02/F2: a payload run_id that is not a string raised TypeError
        # at the registry insert, OUTSIDE every recovery unit.
        import sys
        from io import StringIO

        first, middle, last = await self._three_paused_runs()
        snapshot = self._runs_dir() / f"{middle}.json"
        payload = json.loads(snapshot.read_text(encoding="utf-8"))
        payload["run_id"] = ["x"]
        snapshot.write_text(json.dumps(payload), encoding="utf-8")
        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertEqual(set(rebooted._runs), {first, last})
        self.assertIn(f"factory run snapshot {middle}.json is unreadable", captured.getvalue())

    @async_test
    async def test_a_flipped_order_bit_costs_its_run_alone(self) -> None:
        # R8-01/F3: a snapshot whose JSON stays valid but whose order
        # names a state that does not exist loads with no skip line and
        # then raised a raw KeyError in the arm loop and the unscoped
        # graph — the boot arm died arming NOTHING and the factory page
        # errored for every run, all boot.
        import sys
        from io import StringIO

        first, middle, last = await self._three_paused_runs()
        snapshot = self._runs_dir() / f"{middle}.json"
        payload = json.loads(snapshot.read_text(encoding="utf-8"))
        payload["order"] = ["not-a-state"]
        snapshot.write_text(json.dumps(payload), encoding="utf-8")
        captured = StringIO()
        factory_module._BOOT_ARM_TASK = None
        previous = factory_module._DEFAULT_EXECUTOR
        factory_module._DEFAULT_EXECUTOR = None
        try:
            with patch.object(sys, "stderr", captured):
                self.assertTrue(factory_module.boot_arm_persisted_runs())
                await factory_module._BOOT_ARM_TASK
            armed = factory_module._DEFAULT_EXECUTOR
            assert armed is not None
            self.assertNotIn("factory boot arm failed", captured.getvalue())
            # The corrupt run was REFUSED AT LOAD (the order/states check
            # fires inside the recovery unit — a louder, earlier outcome
            # than the arm-loop guard); the healthy runs still armed.
            self.assertNotIn(middle, armed._runs)
            self.assertIn(f"factory run snapshot {middle}.json is unreadable", captured.getvalue())
            for rid in (first, last):
                self.assertIsNotNone(armed._runs[rid].task, f"{rid} not armed")
            # The unscoped graph and the view lane answer the healthy runs.
            graph = armed.graph()
            self.assertTrue({first, last} <= {row["run_id"] for row in graph["runs"]})
            lane = await armed.activity({"action": "graph"})
            self.assertTrue({first, last} <= {row["runId"] for row in lane["runs"]})
        finally:
            for run in (factory_module._DEFAULT_EXECUTOR or self.executor)._runs.values():
                if run.task is not None:
                    run.task.cancel()
            factory_module._DEFAULT_EXECUTOR = previous
            factory_module._BOOT_ARM_TASK = None

    @async_test
    async def test_a_flipped_event_key_bit_costs_its_run_alone(self) -> None:
        # R8-01/F4: a "seq" -> "sep" flip in one event makes the unscoped
        # graph's edge sort raise TypeError for the WHOLE poll; with the
        # per-run guard the healthy run still answers.
        import sys
        from io import StringIO

        # A healthy paused run on both sides.
        first, _, last = await self._three_paused_runs()
        # A chained run in the middle (it holds transition_fired events).
        self.store_machine(
            {
                "states": [state("p", entry=True), state("q"), state("r")],
                "transitions": [{"from": "p", "to": "q"}, {"from": "q", "to": "r"}],
            },
            spec_id="chain",
        )
        self.host.outcomes["r"] = {"status": "running"}
        result = await self.start("chain")
        chained = result["run_id"]
        run = self.executor._runs[chained]
        deadline = time.monotonic() + 30
        while run.transitions_fired < 2 or not run.states["r"].entries:
            assert time.monotonic() < deadline, "the chain never ran"
            await asyncio.sleep(0)
        run.task.cancel()
        self.executor._persist_run(run)
        self.host.outcomes = {}
        snapshot = self._runs_dir() / f"{chained}.json"
        raw = snapshot.read_bytes()
        at = raw.index(b'"kind": "transition_fired"') if b'"kind": "transition_fired"' in raw else raw.index(b'"kind":"transition_fired"')
        seq_at = raw.rindex(b'"seq"', 0, at)
        snapshot.write_bytes(raw[:seq_at] + b'"sep"' + raw[seq_at + 5:])
        captured = StringIO()
        rebooted = self._fresh()
        rebooted.rehydrate_registry()
        with patch.object(sys, "stderr", captured):
            graph = rebooted.graph()
        self.assertIn(first, {row["run_id"] for row in graph["runs"]})
        self.assertIn(last, {row["run_id"] for row in graph["runs"]})

    @async_test
    async def test_a_stray_json_copy_does_not_shadow_the_live_snapshot(self) -> None:
        # R8-04/C4: an operator backup left in the runs dir under a
        # .json name used to silently REPLACE the live run (the registry
        # keys by the payload id, not the file name). The stem check
        # refuses it loudly.
        import sys
        from io import StringIO

        first, middle, last = await self._three_paused_runs()
        snapshot = self._runs_dir() / f"{middle}.json"
        payload = json.loads(snapshot.read_text(encoding="utf-8"))
        payload["name"] = "STALE-COPY"
        (self._runs_dir() / "zz-backup.json").write_text(json.dumps(payload), encoding="utf-8")
        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertEqual(set(rebooted._runs), {first, middle, last})
        self.assertNotEqual(rebooted._runs[middle].name, "STALE-COPY")
        self.assertIn("zz-backup.json is unreadable", captured.getvalue())

    @async_test
    async def test_the_belt_names_an_unreadable_marker(self) -> None:
        # R8-05/a2: the belt (the existence line) had no test — removing
        # it kept the suite green. chmod 000 must print the exact line
        # and never block the load.
        import sys
        from io import StringIO

        first, middle, last = await self._three_paused_runs()
        # A marker that cannot be read (a directory at the path raises
        # IsADirectoryError for ANY user — chmod 000 alone does not stop
        # a root-owned container kernel).
        marker = self._runs_dir() / f"{middle}.persist-failed"
        marker.mkdir()
        self.addCleanup(lambda: shutil.rmtree(marker, ignore_errors=True))
        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertEqual(set(rebooted._runs), {first, middle, last})
        self.assertIn("(the marker's text is unreadable)", captured.getvalue())

    @async_test
    async def test_a_first_write_failure_names_the_lost_run(self) -> None:
        # R8-03/C3: when the failed write is the run's FIRST, there is
        # no snapshot to walk — the marker was read only by a human ls
        # and the run was lost entirely (its children under the
        # supervisor, no owner). The load-end scan names every such loss.
        import sys
        from io import StringIO

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="firstwrite",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("firstwrite")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries[0].instances:
            assert time.monotonic() < deadline, "the child never admitted"
            await asyncio.sleep(0)
        run.task.cancel()
        # The FIRST write fails: the staging path is a directory.
        blocker = self._runs_dir() / f".{run_id}.json.tmp"
        blocker.mkdir()
        # Remove the run's earlier snapshots/journals so this persist is
        # the FIRST (the marker then names a run with no snapshot at all).
        for suffix in (".json", ".admissions.jsonl"):
            path = self._runs_dir() / f"{run_id}{suffix}"
            path.unlink(missing_ok=True)
        run.revision += 1
        self.executor._persist_run(run)
        self.host.outcomes = {}
        captured = StringIO()
        rebooted = self._fresh()
        with patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertNotIn(run_id, rebooted._runs)
        self.assertIn("could not write its first registry snapshot", captured.getvalue())
        shutil.rmtree(blocker, ignore_errors=True)


class FactoryCrossLanePauseBudgetTest(_ExecutorTestCase):
    """Round-3 probe R3A: the join refactor moved the max_transitions
    pause into _fire_transition and silently dropped the budget layer's
    _mark_paused call — a cross-lane regression only the merged shape
    exposes (the join lane's base predates the budget layer)."""

    @async_test
    async def test_a_max_transitions_pause_excludes_its_wait_from_the_budget(self) -> None:
        self.store_machine(
            {
                "run": {"max_transitions": 1, "budget_ms": 60_000},
                "states": [
                    {"id": "a", "entry": True, "subagent": "worker"},
                    {"id": "b", "subagent": "worker"},
                    {"id": "c", "subagent": "worker"},
                ],
                "transitions": [{"from": "a", "to": "b"}, {"from": "a", "to": "c"}],
            },
            spec_id="r3a",
        )
        result = await self.start("r3a")
        run = self.executor._runs[result["run_id"]]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "paused":
                break
            assert time.monotonic() < deadline, "the run never paused"
            await asyncio.sleep(0)
        self.assertEqual(run.pause_reason, "max_transitions exceeded")
        self.assertIsNotNone(run.pause_started_at, "the pause was never marked")
        # The operator waits 2 hours.
        self.clock.advance(7_200.0)
        await rlm_module.rlm.factory.resume(result["run_id"])
        deadline = time.monotonic() + 30
        while True:
            if run.state in ("done", "failed", "paused", "stopped"):
                break
            assert time.monotonic() < deadline, "the run never settled"
            await asyncio.sleep(0)
        # THE PIN: the 2h pause never folded into the budget — the run
        # completes, not re-paused on the budget.
        self.assertEqual(run.state, "done")


class FactoryRunTombstoneTest(_ExecutorTestCase):
    """Round-4 probe R4-03: a terminal run leaves a durable tombstone —
    after any restart, status answers the retirement record instead of
    'unknown factory run', so an owner can tell by-design retirement from
    a lost registry (the incident that steered the false 'Part B failed'
    verdict)."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = os.environ.get("RLM_SESSION_DIR")

        def restore() -> None:
            if previous is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)
        self.artifacts = Path(artifact_temp.name)

    def _runs_dir(self) -> Path:
        from rlm.factory import _runs_dir

        directory = _runs_dir()
        assert directory is not None
        return directory

    @async_test
    async def test_a_terminal_run_answers_its_tombstone_after_a_restart(self) -> None:
        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="tomb",
        )
        self.host.outcomes["a"] = {"status": "done", "answer": "ok"}
        result = await self.start("tomb")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "done":
                break
            assert time.monotonic() < deadline, "the run never finished"
            await asyncio.sleep(0)
        # The runs dir holds no live snapshot (terminal runs retire) —
        # but the tombstone ledger holds the record.
        runs_dir = self.artifacts / "factory-runs"
        self.assertFalse((runs_dir / f"{run_id}.json").exists())
        ledger = runs_dir / "retired.jsonl"
        self.assertTrue(ledger.exists(), "the terminal run left no tombstone")
        # The restart: a new executor; status must answer the RECORD, not
        # 'unknown factory run'.
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        rebooted.rehydrate_registry()
        self.assertNotIn(run_id, rebooted._runs)
        status = await rebooted.status(run_id)
        self.assertEqual(status["run_id"], run_id)
        self.assertEqual(status["state"], "done")
        self.assertTrue(status["retired"], "status did not answer the tombstone")
        # A genuinely unknown id still raises.
        with self.assertRaises(ValueError):
            await rebooted.status("no-such-run")

    @async_test
    async def test_a_stopped_run_tombstones_its_reason(self) -> None:
        # A run stopped MID-flight (the runner-t0013 shape: an owner stops
        # a live run): the stop's terminal retire tombstones the state and
        # the reason, so a post-restart status can answer it.
        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="tomb2",
        )
        self.host.outcomes["a"] = {"status": "running"}
        result = await self.start("tomb2")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while not run.states["a"].entries:
            assert time.monotonic() < deadline, "the run never started"
            await asyncio.sleep(0)
        await rlm_module.rlm.factory.stop(run_id)
        deadline = time.monotonic() + 30
        while True:
            if run.state == "stopped":
                break
            assert time.monotonic() < deadline, "the run never stopped"
            await asyncio.sleep(0)
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        rebooted.rehydrate_registry()
        status = await rebooted.status(run_id)
        self.assertEqual(status["state"], "stopped")
        self.assertTrue(status["retired"])

    @async_test
    async def test_the_retired_ledger_stays_bounded_and_answers_the_latest(self) -> None:
        # Round-5 probes R5-02 + R5-03: the ledger compacts to its read
        # window (no unbounded growth, no whole-file reads past the
        # window), and the LAST tombstone line wins (a done -> stop()
        # re-tombstone answers 'stopped' after the restart, matching the
        # in-boot answer).
        from rlm.factory import RETIRED_RUNS_READ_LIMIT

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="ledger",
        )
        self.host.outcomes["a"] = {"status": "done", "answer": "ok"}
        result = await self.start("ledger")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "done":
                break
            assert time.monotonic() < deadline, "the run never finished"
            await asyncio.sleep(0)
        # THE BOUND: retire more runs than the read window; the ledger
        # keeps only its trailing lines.
        for i in range(RETIRED_RUNS_READ_LIMIT + 50):
            self.executor._retire_run_files(run, self.artifacts / "factory-runs")
        ledger = (self.artifacts / "factory-runs" / "retired.jsonl").read_text(encoding="utf-8")
        line_count = len([line for line in ledger.splitlines() if line.strip()])
        self.assertLessEqual(line_count, RETIRED_RUNS_READ_LIMIT, "the ledger grew past its window")
        # THE LATEST WINS: stop() on the done run re-tombstones 'stopped';
        # a post-restart status answers the trailing record.
        await rlm_module.rlm.factory.stop(run_id)
        deadline = time.monotonic() + 30
        while True:
            if run.state == "stopped":
                break
            assert time.monotonic() < deadline, "the run never stopped"
            await asyncio.sleep(0)
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        status = await rebooted.status(run_id)
        self.assertEqual(status["state"], "stopped", "the trailing tombstone must win")
        self.assertTrue(status["retired"])

    @async_test
    async def test_a_corrupt_ledger_byte_never_kills_the_retire_path(self) -> None:
        # Round-6 finding 1: one invalid-UTF-8 byte in retired.jsonl
        # escaped the compaction's except OSError (UnicodeDecodeError is a
        # ValueError) — every FUTURE terminal transition crashed with the
        # snapshot already unlinked: no milestone, no tombstone, NO
        # durable trace. The read decodes with replacement now.
        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="utf8",
        )
        self.host.outcomes["a"] = {"status": "done", "answer": "ok"}
        result = await self.start("utf8")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "done":
                break
            assert time.monotonic() < deadline, "the run never finished"
            await asyncio.sleep(0)
        # Seed the ledger with an invalid byte, then retire AGAIN: the
        # retire must survive and tombstone.
        ledger = self.artifacts / "factory-runs" / "retired.jsonl"
        ledger.write_bytes(b'{"run_id": "seed", "state": "done"}\n\xff\xfe\n')
        self.executor._retire_run_files(run, self.artifacts / "factory-runs")
        text = ledger.read_text(encoding="utf-8", errors="replace")
        self.assertIn(run_id, text, "the retire crashed or lost the tombstone")

    def test_a_midwrite_fault_keeps_the_prior_tombstones(self) -> None:
        # Round-6 finding 2: the ledger rewrite was an in-place
        # truncate+write — a mid-write fault wiped prior tombstones and a
        # mid-window reader saw an empty ledger. The rewrite stages and
        # os.replace's now, atomic like the snapshot path.
        import unittest.mock as mock_mod

        ledger = self.artifacts / "factory-runs" / "retired.jsonl"
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text(
            "\n".join(json.dumps({"run_id": f"r{i}", "state": "done"}) for i in range(5)) + "\n",
            encoding="utf-8",
        )
        run = FactoryRun(run_id="r9", spec_id="s", name=None, machine={"states": [], "transitions": []})
        # A write that faults mid-rewrite: os.replace raises.
        with mock_mod.patch("rlm.factory.os.replace", side_effect=OSError("disk full")):
            self.executor._retire_run_files(run, self.artifacts / "factory-runs")
        # The prior ledger stands (the staging file was the only victim).
        text = ledger.read_text(encoding="utf-8")
        self.assertEqual(len([l for l in text.splitlines() if l.strip()]), 5,
                         "the mid-write fault wiped the prior tombstones")

    @async_test
    async def test_a_finished_run_whose_marker_outlived_it_is_not_called_lost(self) -> None:
        # Round-9 probe R9-05: a run FINISHED but its marker unlink
        # failed (a crash between the retire's unlinks, or a directory at
        # the marker path). The next boot must not call a finished run
        # lost — status answers its tombstone.
        import sys
        from io import StringIO

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="outlived",
        )
        self.host.outcomes["a"] = {"status": "done", "answer": "ok"}
        result = await self.start("outlived")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "done":
                break
            assert time.monotonic() < deadline, "the run never finished"
            await asyncio.sleep(0)
        # The retire tombstoned the run; the marker unlink "failed" (a
        # directory at the marker path).
        marker = self._runs_dir() / f"{run_id}.persist-failed"
        marker.mkdir()
        self.addCleanup(lambda: shutil.rmtree(marker, ignore_errors=True))
        captured = StringIO()
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        with patch.object(sys, "stderr", captured):
            rebooted.rehydrate_registry()
        self.assertNotIn("is lost", captured.getvalue())
        status = await rebooted.status(run_id)
        self.assertEqual((status["state"], status["retired"]), ("done", True))

    def _runs_dir(self) -> Path:
        from rlm.factory import _runs_dir

        directory = _runs_dir()
        assert directory is not None
        return directory

    @async_test
    async def test_a_crashed_unlink_keeps_the_tombstone(self) -> None:
        # Round-10 probe R10-04: the tombstone used to write AFTER the
        # unlinks — a crash between them left a FINISHED run with no
        # durable record, and the load-end loss line called it lost at
        # every boot. The tombstone writes FIRST now: a crashed unlink
        # leaves it standing, and status answers the retirement.
        import sys
        from io import StringIO

        self.store_machine(
            {"states": [{"id": "a", "entry": True, "subagent": "worker"}]},
            spec_id="crashunlink",
        )
        self.host.outcomes["a"] = {"status": "done", "answer": "ok"}
        result = await self.start("crashunlink")
        run_id = result["run_id"]
        run = self.executor._runs[run_id]
        deadline = time.monotonic() + 30
        while True:
            if run.state == "done":
                break
            assert time.monotonic() < deadline, "the run never finished"
            await asyncio.sleep(0)
        # A retire whose unlinks all crash (the tombstone must have
        # written FIRST): mock the unlink to raise.
        runs_dir = self._runs_dir()
        runs_dir_leg = runs_dir / "retired.jsonl"
        # The finalize's own retire already tombstoned the run; clear the
        # ledger so the pinned retire is the ONLY writer.
        runs_dir_leg.unlink(missing_ok=True)
        captured = StringIO()
        # A process crash mid-retire (the power-loss shape): an
        # UNcaught interruption between the first unlink and the rest.
        # Tombstone-first keeps the record; unlinks-first loses it.
        os_module = __import__("os")

        def crashing_unlink(path, *args, **kwargs):
            raise KeyboardInterrupt

        with patch.object(sys, "stderr", captured), patch.object(
            os_module, "unlink", side_effect=crashing_unlink
        ):
            try:
                self.executor._retire_run_files(run, runs_dir)
            except KeyboardInterrupt:
                pass  # the crash the retire must survive in its ORDERING
        self.assertTrue(runs_dir_leg.exists(), "the crashed unlinks lost the tombstone")
        rebooted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        status = await rebooted.status(run_id)
        self.assertEqual((status["state"], status["retired"]), ("done", True))

    @async_test
    async def test_a_lone_surrogate_in_a_tombstone_answers_safe(self) -> None:
        # Round-11 probe R11-02 (the ledger decode point): a lone
        # surrogate in a tombstone's name returned through status — a
        # model print of it was rejected on the real kernel. The scan
        # cleans its rows.
        from rlm.factory import RETIRED_RUNS_FILE, _runs_dir

        ledger = _runs_dir() / RETIRED_RUNS_FILE
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text(
            json.dumps({"run_id": "lead", "spec_id": "s", "state": "done"}) + "\n"
            + json.dumps({"run_id": "lead", "spec_id": "s\udc55", "state": "done"}) + "\n",
            encoding="utf-8",
        )
        record = self.executor._retired_record("lead")
        assert record is not None
        from rlm.factory import _frame_has_lone_surrogate

        self.assertFalse(_frame_has_lone_surrogate(record), "a lone surrogate rode the status answer")


class FactoryPrintDurabilityTest(_ExecutorTestCase):
    """A daemonless (``--print``) host keeps its children in its own process,
    so ``resume`` refuses any run that process did not start and names the
    daemon as the durable path."""

    def setUp(self) -> None:
        super().setUp()
        artifact_temp = TemporaryDirectory()
        self.addCleanup(artifact_temp.cleanup)
        previous = {name: os.environ.get(name) for name in ("RLM_SESSION_DIR", "RLM_DAEMONLESS")}

        def restore() -> None:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.addCleanup(restore)
        os.environ["RLM_SESSION_DIR"] = str(artifact_temp.name)
        os.environ["RLM_DAEMONLESS"] = "1"

    async def paused_run(self) -> str:
        self.host.outcomes["implement"] = {"status": "error", "error": "boom"}
        self.store_machine({"states": [{"id": "implement", "entry": True, "subagent": "worker"}]})
        run_id = (await self.start())["run_id"]
        run = self.executor._runs[run_id]
        await self.wait_until(lambda: run.state != "running")
        self.assertEqual(run.state, "paused")
        self.executor._persist_run(run)
        return run_id

    @async_test
    async def test_a_print_run_is_never_saved_and_a_later_process_refuses_it(self) -> None:
        run_id = await self.paused_run()
        self.assertFalse((Path(os.environ["RLM_SESSION_DIR"]) / factory_module.RUNS_DIR_NAME).exists())
        restarted = FactoryExecutor(now=self.clock, sleep=self.sleeps, harness=self.harness)
        restarted.rehydrate_registry()
        factory_module._DEFAULT_EXECUTOR = restarted
        self.assertNotIn(run_id, restarted._runs)
        with self.assertRaises(ValueError) as raised:
            await rlm_module.rlm.factory.resume(run_id)
        self.assertIn("run machines under the daemon", str(raised.exception))

    @async_test
    async def test_resume_continues_a_run_this_print_process_started(self) -> None:
        run_id = await self.paused_run()
        resumed = await rlm_module.rlm.factory.resume(run_id)
        self.assertEqual(resumed["state"], "running")

    @async_test
    async def test_daemon_resume_of_an_unknown_run_is_not_a_print_refusal(self) -> None:
        os.environ["RLM_DAEMONLESS"] = ""
        with self.assertRaisesRegex(ValueError, "unknown factory run 'never-started'"):
            await rlm_module.rlm.factory.resume("never-started")


if __name__ == "__main__":
    unittest.main()
