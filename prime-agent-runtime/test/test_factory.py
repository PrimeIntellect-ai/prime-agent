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
- milestone notices go to the host as validated "factory.progress"
  payloads exactly once per kind per run, and a dead bridge leaves the
  milestone in the ledger instead of wedging the run.
"""

from __future__ import annotations

import asyncio
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest.mock import patch

import rlm as rlm_module
from rlm import factory as factory_module
from rlm.factory import (
    ANSWER_CAPTURE_CAP,
    BACKOFF_MAX_ATTEMPTS,
    EVENT_WINDOW,
    POLL_TIMEOUT_MS,
    FactoryExecutor,
    _child_name,
    _guard_passes,
    _parse_json_output,
    canonicalize_factory_spec,
    compile_factory_dag,
    topological_order,
    validate_factory_machine,
    validate_factory_spec,
)
from rlm.harness import HarnessState


# ---------------------------------------------------------------------------
# Spec fixtures
# ---------------------------------------------------------------------------


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
                "run": {"failure_policy": "escalate", "max_parallel": 8, "max_transitions": 10},
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
            "run": {"budget_ms": 5000, "failure_policy": "continue", "max_parallel": 2, "max_transitions": 7},
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
                "run": {"failure_policy": "continue", "max_parallel": 2, "max_transitions": 7, "budget_ms": 5000},
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
                "run": {"failure_policy": "continue", "max_parallel": 2, "max_transitions": 20, "budget_ms": 5000},
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

        inline_ok = {
            "states": [state("a", entry=True, subagent={"prompt": "Do work.", "name": "w", "thinking": "high"})],
            "transitions": [],
        }
        self.assertEqual(validate_factory_machine(inline_ok), [])

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
            "## Run, watch, steer",
            "## Safety",
        ):
            self.assertIn(heading, doc)

        # Prose sections wrap at ~76 columns; flatten before matching phrases.
        flat = " ".join(doc.split())
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

        # The run/status/stop/resume/graph/watch snippet, as the agent types it.
        self.assertIn('result = await rlm.factory.run("pr-manager")', doc)
        self.assertIn('status = await rlm.factory.status(result["run_id"])', doc)
        self.assertIn('snapshot = await rlm.factory.watch(result["run_id"], 30)', doc)
        self.assertIn("runs = await rlm.factory.graph()", doc)
        self.assertIn('live = await rlm.factory.graph(result["run_id"])', doc)
        self.assertIn('spec = await rlm.factory.graph("pr-manager")', doc)

        # The worked examples bound their emitted payloads — captured answers
        # are capped previews (~160-200 chars), so an unbounded json payload
        # would truncate at the cap and fail to bind.
        self.assertIn('findings": ["at most three one-line findings"]', doc)
        self.assertIn("capped at the eight most relevant", doc)
        self.assertIn("an unbounded payload truncates at the cap and fails to bind", flat)


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


class FakeHost:
    """Deterministic async host_request fake that routes by request type.

    Child names carry the node id as their second dash-separated part, so
    node ids in these tests never contain "-". Collect outcomes are
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
        return [p for p in self.calls_of("rlm.run") if p["kwargs"]["name"].split("-")[1] == node_id]

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
            entry["answer_preview"] = answer
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
            node_id = name.split("-")[1]
            attempted = len(
                [
                    p
                    for kind, p in self.calls
                    if kind == "rlm.run" and p["kwargs"]["name"].split("-")[1] == node_id
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
            return {
                "subagent": {
                    "rlm_child_id": target,
                    "session_name": child["name"] if child else "unknown",
                    "session_dir": f"/tmp/{target}",
                    "status": "running",
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


class FactoryExecutorTest(unittest.TestCase):
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

    # -- helpers -------------------------------------------------------------

    def store_factory(self, dag: dict[str, Any], spec_id: str = "sw") -> None:
        self.harness.create_factory("Factory", "Factory content", id=spec_id, dag=dag)

    def store_machine(self, machine: dict[str, Any], spec_id: str = "sw") -> None:
        self.harness.create_factory("Factory", "Factory content", id=spec_id, machine=machine)

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

    def node(self, node_id: str, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {"id": node_id, "subagent": "worker"}
        base.update(overrides)
        return base

    async def start(self, spec_id: str = "sw") -> dict[str, Any]:
        return await rlm_module.rlm.factory.run(spec_id)

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


if __name__ == "__main__":
    unittest.main()
