from __future__ import annotations

import unittest
from typing import Any

from rlm.swarm import (
    canonicalize_swarm_spec,
    compile_swarm_dag,
    topological_order,
    validate_swarm_machine,
    validate_swarm_spec,
)


def state(state_id: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"id": state_id, "subagent": "worker"}
    base.update(overrides)
    return base


def valid_machine() -> dict[str, Any]:
    """Review-loop machine: collect -> reviewing (max 4 entries) with a guarded
    switch to fixing (max 3 entries) and a self-loop, fixing re-enters reviewing."""
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


class ValidateSwarmSpecTest(unittest.TestCase):
    def test_valid_spec_has_no_errors(self) -> None:
        self.assertEqual(validate_swarm_spec(valid_dag()), [])

    def test_dag_must_be_an_object(self) -> None:
        for bad in (None, [], "nodes", 42):
            errors = validate_swarm_spec(bad)
            self.assertEqual(len(errors), 1)
            self.assertIn("swarm dag must be a JSON object", errors[0])

    def test_nodes_required_and_must_be_a_list(self) -> None:
        self.assertEqual(
            validate_swarm_spec({"nodes": "nope"}),
            ["swarm dag requires a nodes list"],
        )
        self.assertEqual(
            validate_swarm_spec({"run": "bad", "nodes": "nope"}),
            ["run must be an object", "swarm dag requires a nodes list"],
        )

    def test_node_cap(self) -> None:
        at_cap = {"nodes": [node(f"n{i}") for i in range(1024)]}
        self.assertEqual(validate_swarm_spec(at_cap), [])
        over_cap = {"nodes": [node(f"n{i}") for i in range(1025)]}
        errors = validate_swarm_spec(over_cap)
        self.assertEqual(len(errors), 1)
        self.assertIn("between 1 and 1024 nodes", errors[0])

    def test_node_ids(self) -> None:
        for good in ("a", "node-1", "1st-node", "a" * 64):
            self.assertEqual(validate_swarm_spec({"nodes": [node(good)]}), [], good)
        for bad in ("-abc", "ABC", "a_b", "a.b", "a" * 65):
            errors = validate_swarm_spec({"nodes": [{"id": bad, "subagent": "w"}]})
            self.assertEqual(len(errors), 1, bad)
            self.assertIn("id must match", errors[0])
        for bad in ("", None, 5):
            errors = validate_swarm_spec({"nodes": [{"id": bad, "subagent": "w"}]})
            self.assertEqual(errors, ["nodes[0] requires a non-empty id"], repr(bad))

    def test_duplicate_node_ids(self) -> None:
        errors = validate_swarm_spec({"nodes": [node("dup"), node("dup")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("duplicates node id 'dup'", errors[0])

    def test_subagent_forms(self) -> None:
        by_ref = {"nodes": [node("a", subagent="reviewer")]}
        self.assertEqual(validate_swarm_spec(by_ref), [])
        inline = {"nodes": [node("a", subagent={"prompt": "Do work."})]}
        self.assertEqual(validate_swarm_spec(inline), [])
        inline_full = {
            "nodes": [
                node("a", subagent={"prompt": "Do work.", "name": "w", "model": "m", "thinking": "high"})
            ]
        }
        self.assertEqual(validate_swarm_spec(inline_full), [])

        missing = {"nodes": [{"id": "a"}]}
        errors = validate_swarm_spec(missing)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])

        empty_ref = {"nodes": [node("a", subagent="")]}
        errors = validate_swarm_spec(empty_ref)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])

        empty_prompt = {"nodes": [node("a", subagent={"prompt": ""})]}
        errors = validate_swarm_spec(empty_prompt)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a non-empty prompt", errors[0])

        bad_name = {"nodes": [node("a", subagent={"prompt": "p", "model": 5})]}
        errors = validate_swarm_spec(bad_name)
        self.assertEqual(len(errors), 1)
        self.assertIn("model must be a non-empty string", errors[0])

        bad_thinking = {"nodes": [node("a", subagent={"prompt": "p", "thinking": ""})]}
        errors = validate_swarm_spec(bad_thinking)
        self.assertEqual(len(errors), 1)
        self.assertIn("thinking must be a non-empty string", errors[0])

    def test_lifecycle(self) -> None:
        for good in ("task", "resident"):
            self.assertEqual(validate_swarm_spec({"nodes": [node("a", lifecycle=good)]}), [])
        errors = validate_swarm_spec({"nodes": [node("a", lifecycle="daemon")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("lifecycle must be 'task' or 'resident'", errors[0])

    def test_run_budget_and_node_budget(self) -> None:
        ok = {
            "run": {"budget_ms": 1000},
            "nodes": [node("a", budget_ms=1000)],
        }
        self.assertEqual(validate_swarm_spec(ok), [])

        over = {
            "run": {"budget_ms": 1000},
            "nodes": [node("a", budget_ms=1001)],
        }
        errors = validate_swarm_spec(over)
        self.assertEqual(len(errors), 1)
        self.assertIn("exceeds the run budget_ms", errors[0])

        for bad in (0, -5, 1.5, "10", True):
            errors = validate_swarm_spec({"run": {"budget_ms": bad}, "nodes": [node("a")]})
            self.assertEqual(errors, ["run budget_ms must be a positive integer"], bad)
            errors = validate_swarm_spec({"nodes": [node("a", budget_ms=bad)]})
            self.assertEqual(errors, ["node a budget_ms must be a positive integer"], bad)

        # No run budget set: any positive node budget is fine.
        self.assertEqual(validate_swarm_spec({"nodes": [node("a", budget_ms=999_999)]}), [])

    def test_run_budget_invalid(self) -> None:
        errors = validate_swarm_spec({"run": "bad", "nodes": [node("a")]})
        self.assertEqual(errors, ["run must be an object"])

    def test_run_failure_policy(self) -> None:
        for good in ("fail_fast", "continue", "escalate"):
            self.assertEqual(validate_swarm_spec({"run": {"failure_policy": good}, "nodes": [node("a")]}), [])
        errors = validate_swarm_spec({"run": {"failure_policy": "stop"}, "nodes": [node("a")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("run failure_policy must be one of", errors[0])

    def test_run_max_parallel(self) -> None:
        for good in (1, 8, 64):
            self.assertEqual(validate_swarm_spec({"run": {"max_parallel": good}, "nodes": [node("a")]}), [])
        for bad in (0, 65, -1, 1.5, "8", True):
            errors = validate_swarm_spec({"run": {"max_parallel": bad}, "nodes": [node("a")]})
            self.assertEqual(errors, ["run max_parallel must be an integer between 1 and 64"], bad)

    def test_node_failure_policy(self) -> None:
        for good in ("fail_fast", "continue", "escalate"):
            self.assertEqual(validate_swarm_spec({"nodes": [node("a", failure_policy=good)]}), [])
        errors = validate_swarm_spec({"nodes": [node("a", failure_policy="retry")]})
        self.assertEqual(len(errors), 1)
        self.assertIn("node a failure_policy must be one of", errors[0])

    def test_retries(self) -> None:
        for good in (0, 5, 10):
            self.assertEqual(validate_swarm_spec({"nodes": [node("a", retries=good)]}), [])
        for bad in (-1, 11, 1.5, "2", True):
            errors = validate_swarm_spec({"nodes": [node("a", retries=bad)]})
            self.assertEqual(errors, ["node a retries must be an integer between 0 and 10"], bad)

    def test_depends_on(self) -> None:
        ok = {"nodes": [node("a"), node("b", depends_on=["a"])]}
        self.assertEqual(validate_swarm_spec(ok), [])

        self_dep = {"nodes": [node("a", depends_on=["a"])]}
        errors = validate_swarm_spec(self_dep)
        self.assertEqual(errors, ["node a cannot depend on itself"])

        unknown = {"nodes": [node("a", depends_on=["ghost"])]}
        errors = validate_swarm_spec(unknown)
        self.assertEqual(errors, ["node a depends on unknown node 'ghost'"])

        not_list = {"nodes": [node("a", depends_on="b")]}
        errors = validate_swarm_spec(not_list)
        self.assertEqual(errors, ["node a depends_on must be a list of node ids"])

        bad_entry = {"nodes": [node("a", depends_on=[5])]}
        errors = validate_swarm_spec(bad_entry)
        self.assertEqual(errors, ["node a depends_on entries must be non-empty node id strings"])

    def test_data_edges(self) -> None:
        ok = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "text"}]),
                node("b", inputs=[{"name": "in", "type": "text", "from": "a.out"}]),
            ]
        }
        self.assertEqual(validate_swarm_spec(ok), [])

        # A data edge implies ordering even without depends_on.
        no_declared_dep = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "json"}]),
                node("b", inputs=[{"name": "in", "type": "json", "from": "a.out"}]),
            ]
        }
        self.assertEqual(validate_swarm_spec(no_declared_dep), [])

        unknown_source = {
            "nodes": [node("b", inputs=[{"name": "in", "type": "text", "from": "ghost.out"}])]
        }
        errors = validate_swarm_spec(unknown_source)
        self.assertEqual(len(errors), 1)
        self.assertIn("references unknown node 'ghost'", errors[0])

        undeclared_output = {
            "nodes": [
                node("a"),
                node("b", inputs=[{"name": "in", "type": "text", "from": "a.missing"}]),
            ]
        }
        errors = validate_swarm_spec(undeclared_output)
        self.assertEqual(len(errors), 1)
        self.assertIn("does not declare", errors[0])

        type_mismatch = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "text"}]),
                node("b", inputs=[{"name": "in", "type": "json", "from": "a.out"}]),
            ]
        }
        errors = validate_swarm_spec(type_mismatch)
        self.assertEqual(len(errors), 1)
        self.assertIn("cannot read from output", errors[0])
        self.assertIn("of type 'text'", errors[0])

        malformed_from = {
            "nodes": [
                node("a", outputs=[{"name": "out", "type": "text"}]),
                node("b", inputs=[{"name": "in", "type": "text", "from": "no-dot"}]),
            ]
        }
        errors = validate_swarm_spec(malformed_from)
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
        self.assertEqual(validate_swarm_spec(ok), [])

        bad_output_type = {"nodes": [node("a", outputs=[{"name": "o", "type": "yaml"}])]}
        errors = validate_swarm_spec(bad_output_type)
        self.assertEqual(len(errors), 1)
        self.assertIn("output 'o' type must be 'text' or 'json'", errors[0])

        dup_output = {
            "nodes": [node("a", outputs=[{"name": "o", "type": "text"}, {"name": "o", "type": "json"}])]
        }
        errors = validate_swarm_spec(dup_output)
        self.assertEqual(errors, ["node a declares duplicate output name 'o'"])

        bad_input_type = {
            "nodes": [
                node("b", outputs=[{"name": "o", "type": "text"}]),
                node("a", inputs=[{"name": "i", "type": "yaml", "from": "b.o"}]),
            ]
        }
        errors = validate_swarm_spec(bad_input_type)
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
        errors = validate_swarm_spec(dup_input)
        self.assertEqual(errors, ["node a declares duplicate input name 'i'"])

        missing_name = {"nodes": [node("a", outputs=[{"type": "text"}])]}
        errors = validate_swarm_spec(missing_name)
        self.assertEqual(errors, ["node a outputs[0] requires a non-empty name"])

        not_a_list = {"nodes": [node("a", outputs="nope")]}
        errors = validate_swarm_spec(not_a_list)
        self.assertEqual(errors, ["node a outputs must be a list"])
        not_a_list = {"nodes": [node("a", inputs="nope")]}
        errors = validate_swarm_spec(not_a_list)
        self.assertEqual(errors, ["node a inputs must be a list"])

    def test_resident_rules(self) -> None:
        resident_ok = {"nodes": [node("watcher", lifecycle="resident")]}
        self.assertEqual(validate_swarm_spec(resident_ok), [])

        depended_on = {
            "nodes": [node("watcher", lifecycle="resident"), node("task", depends_on=["watcher"])]
        }
        errors = validate_swarm_spec(depended_on)
        self.assertEqual(errors, ["node task cannot depend on resident node 'watcher'"])

        read_from = {
            "nodes": [
                node("watcher", lifecycle="resident"),
                node("task", inputs=[{"name": "i", "type": "text", "from": "watcher.o"}]),
            ]
        }
        errors = validate_swarm_spec(read_from)
        self.assertEqual(errors, ["node task input 'i' cannot read from resident node 'watcher'"])

        declares_outputs = {"nodes": [node("watcher", lifecycle="resident", outputs=[{"name": "o", "type": "text"}])]}
        errors = validate_swarm_spec(declares_outputs)
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
        errors = validate_swarm_spec(uses_foreach)
        self.assertEqual(errors, ["resident node watcher cannot use foreach"])

        # Empty outputs list on a resident node is fine: nothing is declared.
        empty_outputs = {"nodes": [node("watcher", lifecycle="resident", outputs=[])]}
        self.assertEqual(validate_swarm_spec(empty_outputs), [])

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
        self.assertEqual(validate_swarm_spec(ok), [])

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
            self.assertEqual(validate_swarm_spec(ok_max), [])

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
            errors = validate_swarm_spec(bad)
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
        errors = validate_swarm_spec(wrong_port)
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
        errors = validate_swarm_spec(text_port)
        self.assertEqual(errors, ["node b foreach.over input 'draft' must have type 'json'"])

        not_object = {"nodes": [node("a", foreach=["bad"])]}
        errors = validate_swarm_spec(not_object)
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
        self.assertEqual(validate_swarm_spec(cycle_with_entry), [])

        data_cycle_with_entry = {
            "nodes": [
                node("a"),
                node("b", depends_on=["a"], outputs=[{"name": "o", "type": "json"}]),
                node("c", inputs=[{"name": "i", "type": "json", "from": "b.o"}]),
            ]
        }
        self.assertEqual(validate_swarm_spec(data_cycle_with_entry), [])

    def test_fully_cyclic_dag_compiles_to_a_machine_without_entry_states(self) -> None:
        depends_cycle = {
            "nodes": [
                node("a", depends_on=["b"]),
                node("b", depends_on=["a"]),
            ]
        }
        self.assertEqual(
            validate_swarm_spec(depends_cycle),
            ["swarm machine requires at least one entry state"],
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
            validate_swarm_spec(data_cycle),
            ["swarm machine requires at least one entry state"],
        )

        three_cycle = {
            "nodes": [
                node("a", depends_on=["c"]),
                node("b", depends_on=["a"]),
                node("c", depends_on=["b"]),
            ]
        }
        self.assertEqual(
            validate_swarm_spec(three_cycle),
            ["swarm machine requires at least one entry state"],
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
        errors = validate_swarm_spec(dag)
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


class CanonicalizeSwarmSpecTest(unittest.TestCase):
    def test_applies_defaults(self) -> None:
        dag = {"nodes": [{"id": "a", "subagent": "worker"}]}
        self.assertEqual(
            canonicalize_swarm_spec(dag),
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
            canonicalize_swarm_spec(dag),
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
        result = canonicalize_swarm_spec(dag)
        self.assertEqual(result["states"][0]["failure_policy"], "continue")
        self.assertEqual(result["states"][1]["failure_policy"], "escalate")

    def test_deduplicates_depends_on_into_unique_transitions(self) -> None:
        dag = {
            "nodes": [
                {"id": "a", "subagent": "w"},
                {"id": "b", "subagent": "w", "depends_on": ["a", "a", "a"]},
            ]
        }
        result = canonicalize_swarm_spec(dag)
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
            canonicalize_swarm_spec(machine),
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
                    },
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
            canonicalize_swarm_spec({"nodes": [node("a", depends_on=["ghost"])]})
        message = str(ctx.exception)
        self.assertIn("depends on unknown node", message)

        with self.assertRaises(ValueError) as ctx:
            canonicalize_swarm_spec("not a dag")
        self.assertIn("swarm dag must be a JSON object", str(ctx.exception))

        with self.assertRaises(ValueError) as ctx:
            canonicalize_swarm_spec({"states": [state("a")], "transitions": [{"from": "a", "to": "ghost"}]})
        self.assertIn("references unknown to-state", str(ctx.exception))

    def test_does_not_mutate_input(self) -> None:
        dag = {"nodes": [{"id": "a", "subagent": {"prompt": "p"}, "outputs": [{"name": "o", "type": "json"}]}]}
        snapshot = {"nodes": [dict(dag["nodes"][0])]}
        result = canonicalize_swarm_spec(dag)
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
        result = canonicalize_swarm_spec(machine)
        result["states"][0]["outputs"][0]["type"] = "mutated"
        result["transitions"][0]["when"]["output"] = "mutated"
        self.assertEqual(machine["states"][0]["outputs"][0]["type"], "json")
        self.assertEqual(machine["transitions"][0]["when"]["output"], "o")



class ValidateSwarmMachineTest(unittest.TestCase):
    """Every machine-form validator rule, valid and invalid."""

    def test_valid_machine_has_no_errors(self) -> None:
        # Includes an entry state, a guard switch, a self-loop, re-entry
        # bounds, and a reviewing<->fixing cycle: all legal in machine form.
        self.assertEqual(validate_swarm_spec(valid_machine()), [])
        self.assertEqual(validate_swarm_machine(valid_machine()), [])

    def test_machine_must_be_an_object(self) -> None:
        for bad in (None, [], "states", 42):
            self.assertEqual(validate_swarm_machine(bad), ["swarm machine must be a JSON object"], repr(bad))

    def test_states_required_and_must_be_a_list(self) -> None:
        self.assertEqual(
            validate_swarm_machine({"transitions": []}),
            ["swarm machine requires a states list"],
        )
        self.assertEqual(
            validate_swarm_machine({"states": "nope"}),
            ["swarm machine requires a states list"],
        )
        self.assertEqual(
            validate_swarm_machine({"run": "bad", "states": "nope"}),
            ["run must be an object", "swarm machine requires a states list"],
        )

    def test_state_cap(self) -> None:
        at_cap = {"states": [state(f"s{i}") for i in range(1024)], "transitions": []}
        at_cap["states"][0]["entry"] = True
        self.assertEqual(validate_swarm_machine(at_cap), [])
        over_cap = {"states": [state(f"s{i}") for i in range(1025)], "transitions": []}
        over_cap["states"][0]["entry"] = True
        self.assertEqual(
            validate_swarm_machine(over_cap),
            [f"swarm machine must declare between 1 and 1024 states, got 1025"],
        )
        empty = {"states": [], "transitions": []}
        self.assertEqual(
            validate_swarm_machine(empty),
            ["swarm machine must declare between 1 and 1024 states, got 0"],
        )

    def test_state_ids(self) -> None:
        for good in ("a", "state-1", "1st-state", "a" * 64):
            machine = {"states": [{"id": good, "entry": True, "subagent": "w"}], "transitions": []}
            self.assertEqual(validate_swarm_machine(machine), [], good)
        for bad in ("-abc", "ABC", "a_b", "a.b", "a" * 65):
            machine = {"states": [{"id": bad, "entry": True, "subagent": "w"}], "transitions": []}
            errors = validate_swarm_machine(machine)
            self.assertEqual(len(errors), 1, bad)
            self.assertIn("id must match", errors[0])
        for bad in ("", None, 5):
            machine = {"states": [{"id": bad, "subagent": "w"}], "transitions": []}
            self.assertEqual(
                validate_swarm_machine(machine),
                ["states[0] requires a non-empty id"],
                repr(bad),
            )

    def test_duplicate_state_ids(self) -> None:
        machine = {"states": [state("dup"), state("dup")], "transitions": []}
        machine["states"][0]["entry"] = True
        errors = validate_swarm_machine(machine)
        self.assertEqual(len(errors), 1)
        self.assertIn("duplicates state id 'dup'", errors[0])

    def test_entry_state_required(self) -> None:
        no_entry = {"states": [state("a"), state("b")], "transitions": [{"from": "a", "to": "b"}]}
        self.assertEqual(
            validate_swarm_machine(no_entry),
            ["swarm machine requires at least one entry state"],
        )
        explicit_false = {"states": [state("a", entry=False)], "transitions": []}
        self.assertEqual(
            validate_swarm_machine(explicit_false),
            ["swarm machine requires at least one entry state"],
        )
        bad_flag = {"states": [state("a", entry="yes")], "transitions": []}
        self.assertEqual(
            validate_swarm_machine(bad_flag),
            ["state a entry must be a boolean", "swarm machine requires at least one entry state"],
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
        self.assertEqual(validate_swarm_machine(ok), [])
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
                validate_swarm_machine(machine),
                ["state loop input 'o' optional must be a boolean when provided"],
                repr(bad),
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
            validate_swarm_machine(with_inputs),
            ["entry state src cannot declare inputs"],
        )
        entry_without_inputs = {"states": [state("a", entry=True)], "transitions": []}
        self.assertEqual(validate_swarm_machine(entry_without_inputs), [])
        # Compiled dags only mark dep-free nodes as entry states, so the rule
        # never fires on the dag path.
        dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a"], inputs=[{"name": "i", "type": "text", "from": "a.o"}]),
            ]
        }
        self.assertEqual(validate_swarm_spec(dag), [])

    def test_max_entries(self) -> None:
        for good in (1, 2, 99):
            machine = {"states": [state("a", entry=True, max_entries=good)], "transitions": []}
            self.assertEqual(validate_swarm_machine(machine), [], good)
        for bad in (0, -1, 1.5, "2", True):
            machine = {"states": [state("a", entry=True, max_entries=bad)], "transitions": []}
            self.assertEqual(
                validate_swarm_machine(machine),
                ["state a max_entries must be an integer >= 1"],
                repr(bad),
            )

    def test_subagent_required(self) -> None:
        missing = {"states": [{"id": "a", "entry": True}], "transitions": []}
        errors = validate_swarm_machine(missing)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])
        self.assertIn("state a", errors[0])

        empty_ref = {"states": [state("a", entry=True, subagent="")], "transitions": []}
        errors = validate_swarm_machine(empty_ref)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a subagent", errors[0])

        empty_prompt = {"states": [state("a", entry=True, subagent={"prompt": ""})], "transitions": []}
        errors = validate_swarm_machine(empty_prompt)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a non-empty prompt", errors[0])

        bad_model = {"states": [state("a", entry=True, subagent={"prompt": "p", "model": 5})], "transitions": []}
        errors = validate_swarm_machine(bad_model)
        self.assertEqual(len(errors), 1)
        self.assertIn("model must be a non-empty string", errors[0])

        inline_ok = {
            "states": [state("a", entry=True, subagent={"prompt": "Do work.", "name": "w", "thinking": "high"})],
            "transitions": [],
        }
        self.assertEqual(validate_swarm_machine(inline_ok), [])

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
        errors = validate_swarm_machine(machine)
        self.assertEqual(
            errors,
            [
                "state watch: wait states require the watch host handlers (rlm.watch.*); "
                "they arrive with the communication series - remove the wait block until then"
            ],
        )
        self.assertEqual(validate_swarm_spec(machine), errors)

        dag_wait = {"nodes": [node("a", wait={"kind": "path", "target": "t", "timeout_ms": 5})]}
        errors = validate_swarm_spec(dag_wait)
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
        self.assertEqual(validate_swarm_machine(resident_ok), [])

        declares_outputs = {
            "states": [state("watcher", entry=True, lifecycle="resident", outputs=[{"name": "o", "type": "text"}])],
            "transitions": [],
        }
        self.assertEqual(
            validate_swarm_machine(declares_outputs),
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
        self.assertEqual(validate_swarm_machine(uses_foreach), ["resident state watcher cannot use foreach"])
        leaves_resident = {
            "states": [
                {"id": "entry", "entry": True, "subagent": "w"},
                {"id": "watcher", "subagent": "w", "lifecycle": "resident"},
            ],
            "transitions": [{"from": "watcher", "to": "entry"}],
        }
        self.assertEqual(
            validate_swarm_machine(leaves_resident),
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
            validate_swarm_machine(machine),
            ["state task input 'i' cannot read from resident state 'watcher'"],
        )

    def test_port_rules(self) -> None:
        dup_output = {"states": [state("a", entry=True, outputs=[{"name": "o", "type": "text"}, {"name": "o", "type": "json"}])], "transitions": []}
        self.assertEqual(validate_swarm_machine(dup_output), ["state a declares duplicate output name 'o'"])
        bad_type = {"states": [state("a", entry=True, outputs=[{"name": "o", "type": "yaml"}])], "transitions": []}
        self.assertEqual(validate_swarm_machine(bad_type), ["state a output 'o' type must be 'text' or 'json'"])
        unknown_source = {
            "states": [state("a", entry=True), state("b", inputs=[{"name": "i", "type": "text", "from": "ghost.o"}])],
            "transitions": [],
        }
        self.assertEqual(
            validate_swarm_machine(unknown_source),
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
            validate_swarm_machine(undeclared_output),
            ["state b input 'i' references output 'missing' that state 'a' does not declare"],
        )
        type_mismatch = {
            "states": [
                state("a", entry=True, outputs=[{"name": "o", "type": "text"}]),
                state("b", inputs=[{"name": "i", "type": "json", "from": "a.o"}]),
            ],
            "transitions": [],
        }
        errors = validate_swarm_machine(type_mismatch)
        self.assertEqual(len(errors), 1)
        self.assertIn("cannot read from output", errors[0])
        malformed = {
            "states": [
                state("a", entry=True, outputs=[{"name": "o", "type": "text"}]),
                state("b", inputs=[{"name": "i", "type": "text", "from": "nodot"}]),
            ],
            "transitions": [],
        }
        errors = validate_swarm_machine(malformed)
        self.assertEqual(len(errors), 1)
        self.assertIn("requires a 'from' reference", errors[0])

    def test_budgets_and_retries_and_policies(self) -> None:
        over = {
            "run": {"budget_ms": 1000},
            "states": [state("a", entry=True, budget_ms=1001)],
            "transitions": [],
        }
        self.assertEqual(
            validate_swarm_machine(over),
            ["state a budget_ms 1001 exceeds the run budget_ms 1000"],
        )
        for bad in (0, -5, 1.5, "10", True):
            machine = {"run": {"budget_ms": bad}, "states": [state("a", entry=True)], "transitions": []}
            self.assertEqual(validate_swarm_machine(machine), ["run budget_ms must be a positive integer"], bad)
            machine = {"states": [state("a", entry=True, budget_ms=bad)], "transitions": []}
            self.assertEqual(validate_swarm_machine(machine), ["state a budget_ms must be a positive integer"], bad)
        for bad in (-1, 11, 1.5, "2", True):
            machine = {"states": [state("a", entry=True, retries=bad)], "transitions": []}
            self.assertEqual(
                validate_swarm_machine(machine),
                ["state a retries must be an integer between 0 and 10"],
                bad,
            )
        bad_policy = {"states": [state("a", entry=True, failure_policy="retry")], "transitions": []}
        self.assertEqual(
            validate_swarm_machine(bad_policy),
            ["state a failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got 'retry'"],
        )
        bad_lifecycle = {"states": [state("a", entry=True, lifecycle="daemon")], "transitions": []}
        self.assertEqual(
            validate_swarm_machine(bad_lifecycle),
            ["state a lifecycle must be 'task' or 'resident', got 'daemon'"],
        )

    def test_run_max_transitions(self) -> None:
        for good in (1, 40, 10_000):
            machine = {"run": {"max_transitions": good}, "states": [state("a", entry=True)], "transitions": []}
            self.assertEqual(validate_swarm_machine(machine), [], good)
        for bad in (0, -1, 10_001, 1.5, "5", True):
            machine = {"run": {"max_transitions": bad}, "states": [state("a", entry=True)], "transitions": []}
            self.assertEqual(
                validate_swarm_machine(machine),
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
        self.assertEqual(validate_swarm_machine(ok), [])
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
            validate_swarm_machine(wrong_port),
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
        self.assertEqual(validate_swarm_machine(text_port), ["state b foreach.over input 'draft' must have type 'json'"])
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
        self.assertEqual(validate_swarm_machine(bad_max), ["state b foreach.max must be an integer between 1 and 256"])
        not_object = {"states": [state("a", entry=True, foreach=["bad"])], "transitions": []}
        self.assertEqual(validate_swarm_machine(not_object), ["state a foreach must be an object"])

    def test_transitions_reference_existing_states(self) -> None:
        unknown_from = {
            "states": [state("a", entry=True)],
            "transitions": [{"from": "ghost", "to": "a"}],
        }
        self.assertEqual(
            validate_swarm_machine(unknown_from),
            ["transitions[0] references unknown from-state 'ghost'"],
        )
        unknown_to = {"states": [state("a", entry=True)], "transitions": [{"from": "a", "to": "ghost"}]}
        self.assertEqual(
            validate_swarm_machine(unknown_to),
            ["transitions[0] references unknown to-state 'ghost'"],
        )
        not_object = {"states": [state("a", entry=True)], "transitions": ["bad"]}
        self.assertEqual(validate_swarm_machine(not_object), ["transitions[0] must be an object"])
        not_a_list = {"states": [state("a", entry=True)], "transitions": "bad"}
        self.assertEqual(validate_swarm_machine(not_a_list), ["swarm machine transitions must be a list"])
        bad_on = {"states": [state("a", entry=True)], "transitions": [{"from": "a", "to": "a", "on": "manual"}]}
        self.assertEqual(
            validate_swarm_machine(bad_on),
            ["transitions[0] on must be one of ['settled'], got 'manual'"],
        )

    def test_self_loop_is_legal_re_entry(self) -> None:
        machine = {
            "states": [state("a", entry=True, max_entries=5, outputs=[{"name": "o", "type": "json"}])],
            "transitions": [{"from": "a", "to": "a"}],
        }
        self.assertEqual(validate_swarm_machine(machine), [])

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
        self.assertEqual(validate_swarm_machine(machine), [])
        self.assertEqual(validate_swarm_spec(machine), [])

    def test_guard_rules(self) -> None:
        def machine_with(when: Any) -> dict[str, Any]:
            return {
                "states": [state("a", entry=True, outputs=[{"name": "verdict", "type": "json"}]), state("b")],
                "transitions": [{"from": "a", "to": "b", "when": when}],
            }

        unknown_output = machine_with({"output": "missing", "op": "exists"})
        self.assertEqual(
            validate_swarm_machine(unknown_output),
            ["transitions[0] when.output 'missing' is not a declared output of state 'a'"],
        )
        empty_output = machine_with({"output": "", "op": "exists"})
        self.assertEqual(
            validate_swarm_machine(empty_output),
            ["transitions[0] when requires a non-empty output"],
        )
        not_object = machine_with("nope")
        self.assertEqual(validate_swarm_machine(not_object), ["transitions[0] when must be an object"])
        path_on_text = {
            "states": [
                state("a", entry=True, outputs=[{"name": "note", "type": "text"}]),
                state("b"),
            ],
            "transitions": [{"from": "a", "to": "b", "when": {"output": "note", "path": "x", "op": "eq", "value": 1}}],
        }
        self.assertEqual(
            validate_swarm_machine(path_on_text),
            ["transitions[0] when.path requires a json output, got text output 'note'"],
        )
        bad_op = machine_with({"output": "verdict", "op": "matches", "value": 1})
        self.assertEqual(
            validate_swarm_machine(bad_op),
            ["transitions[0] when.op must be one of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'], got 'matches'"],
        )
        for op in ("gt", "gte", "lt", "lte"):
            non_numeric = machine_with({"output": "verdict", "op": op, "value": "1"})
            self.assertEqual(
                validate_swarm_machine(non_numeric),
                [f"transitions[0] when.op {op!r} requires a numeric value"],
                op,
            )
        contains_needs_list = machine_with({"output": "verdict", "op": "contains", "value": "x"})
        self.assertEqual(
            validate_swarm_machine(contains_needs_list),
            ["transitions[0] when.op 'contains' requires a non-empty list value"],
        )
        contains_empty_list = machine_with({"output": "verdict", "op": "contains", "value": []})
        self.assertEqual(
            validate_swarm_machine(contains_empty_list),
            ["transitions[0] when.op 'contains' requires a non-empty list value"],
        )
        eq_rejects_list = machine_with({"output": "verdict", "op": "eq", "value": [1]})
        self.assertEqual(
            validate_swarm_machine(eq_rejects_list),
            ["transitions[0] when.op 'eq' requires a scalar value"],
        )
        ne_rejects_list = machine_with({"output": "verdict", "op": "ne", "value": [1]})
        self.assertEqual(
            validate_swarm_machine(ne_rejects_list),
            ["transitions[0] when.op 'ne' requires a scalar value"],
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
            self.assertEqual(validate_swarm_machine(machine_with(when)), [], repr(when))

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
            validate_swarm_machine(machine),
            [
                "run failure_policy must be one of ['fail_fast', 'continue', 'escalate'], got 'nope'",
                "run max_parallel must be an integer between 1 and 64",
                "state a retries must be an integer between 0 and 10",
                "state b max_entries must be an integer >= 1",
                "transitions[0] references unknown to-state 'ghost'",
            ],
        )


class CompileSwarmDagTest(unittest.TestCase):
    """The dag sugar compiles to machine form."""

    def test_chain_compiles(self) -> None:
        dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", depends_on=["a"]),
                node("c", depends_on=["b"]),
            ]
        }
        machine, errors = compile_swarm_dag(dag)
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
        self.assertEqual(validate_swarm_machine(machine), [])

    def test_diamond_compiles(self) -> None:
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
        machine, errors = compile_swarm_dag(dag)
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
                    {"from": "b", "to": "d"},
                    {"from": "c", "to": "d"},
                ],
            },
        )
        self.assertEqual(validate_swarm_machine(machine), [])

    def test_data_edge_alone_creates_a_transition(self) -> None:
        dag = {
            "nodes": [
                node("a", outputs=[{"name": "o", "type": "text"}]),
                node("b", inputs=[{"name": "i", "type": "text", "from": "a.o"}]),
            ]
        }
        machine, errors = compile_swarm_dag(dag)
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
        machine, errors = compile_swarm_dag(dag)
        self.assertEqual(errors, [])
        self.assertEqual(machine["transitions"], [{"from": "a", "to": "b"}])

    def test_explicit_empty_depends_on_still_enters(self) -> None:
        dag = {"nodes": [node("a", depends_on=[])]}
        machine, errors = compile_swarm_dag(dag)
        self.assertEqual(errors, [])
        self.assertEqual(machine["states"][0]["entry"], True)
        self.assertEqual(machine["transitions"], [])

    def test_invalid_dag_returns_errors_without_a_machine(self) -> None:
        for bad, expected in (
            ("nope", "swarm dag must be a JSON object"),
            ({"nodes": "nope"}, "swarm dag requires a nodes list"),
            ({"nodes": []}, "swarm dag must declare between 1 and 1024 nodes, got 0"),
            ({"nodes": [node("a", depends_on=["ghost"])]}, "node a depends on unknown node 'ghost'"),
        ):
            machine, errors = compile_swarm_dag(bad)
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
        self.assertEqual(canonicalize_swarm_spec(dag), canonicalize_swarm_spec(machine))


class ValidateSwarmSpecFormTest(unittest.TestCase):
    """The unified entry point detects the form first."""

    def test_both_forms_are_rejected_together(self) -> None:
        both = {"nodes": [node("a")], "states": [state("a", entry=True)]}
        self.assertEqual(validate_swarm_spec(both), ["pass either dag or machine form, not both"])
        with self.assertRaisesRegex(ValueError, "not both"):
            canonicalize_swarm_spec(both)

    def test_machine_wins_when_states_or_transitions_present(self) -> None:
        transitions_only = {"transitions": [{"from": "a", "to": "b"}]}
        self.assertEqual(
            validate_swarm_spec(transitions_only),
            ["swarm machine requires a states list"],
        )

    def test_dag_wording_without_machine_keys(self) -> None:
        self.assertEqual(
            validate_swarm_spec({"nodes": "nope"}),
            ["swarm dag requires a nodes list"],
        )

    def test_non_object_specs_reject_with_dag_wording(self) -> None:
        for bad in (None, [], "nodes", 42):
            self.assertEqual(validate_swarm_spec(bad), ["swarm dag must be a JSON object"], repr(bad))


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


if __name__ == "__main__":
    unittest.main()
