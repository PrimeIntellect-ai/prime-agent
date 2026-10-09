"""The factory capability eval's reference specs validate against the kernel.

Port of the TS-era factory-eval harness's runtime-side check
(packages/coding-agent/test/factory-eval.test.ts verified the five seeded
dags directly against the runtime): every reference spec the eval seeds
into a session's harness store must pass the kernel's own write-time
validator and canonicalizer - the eval driver never gets to build a spec
the runtime would reject, and the dag arms must compile to machine form.
The spec shapes are the same ones crates/pa-core/src/factory_eval/mod.rs
builds (kept in sync by the shape tests on both sides).
"""

import unittest

from rlm.factory import (
    canonicalize_factory_spec,
    topological_order,
    validate_factory_spec,
)

NODE_BUDGET_MS = 240_000
RUN_BUDGET_MS = 900_000
REVIEW_FOREACH_MAX = 8
MINI_REPO_AUDIT = "audit"

REVIEW_FILES = [
    ("fa", "AUDIT-A1"),
    ("fb", "AUDIT-B1"),
    ("fc", "AUDIT-C1"),
    ("fd", "AUDIT-D1"),
]


def review_sweep_dag() -> dict:
    return {
        "run": {"budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": REVIEW_FOREACH_MAX},
        "nodes": [
            {
                "id": "files",
                "subagent": {"prompt": "source node prompt", "name": "files-source"},
                "outputs": [{"name": "files", "type": "json"}],
                "budget_ms": NODE_BUDGET_MS,
            },
            {
                "id": "review",
                "subagent": {"prompt": "reviewer prompt with {files}", "name": "file-reviewer"},
                "inputs": [{"name": "files", "type": "json", "from": "files.files"}],
                "outputs": [{"name": "found", "type": "text"}],
                "foreach": {"over": "files", "max": REVIEW_FOREACH_MAX},
                "budget_ms": NODE_BUDGET_MS,
            },
            {
                "id": "report",
                "subagent": {"prompt": "aggregator prompt", "name": "review-aggregator"},
                "inputs": [
                    {"name": "file_list", "type": "json", "from": "files.files"},
                    {"name": "found", "type": "text", "from": "review.found"},
                ],
                "outputs": [{"name": "issues", "type": "json"}],
                "budget_ms": NODE_BUDGET_MS,
            },
        ],
    }


def review_sweep_fail_dag() -> dict:
    dag = review_sweep_dag()
    nodes = list(dag["nodes"])
    nodes.insert(
        2,
        {
            "id": "review-broken",
            "subagent": {
                "prompt": "broken reviewer prompt",
                "model": "internal/no-such-model-for-eval",
                "name": "broken-reviewer",
            },
            "depends_on": ["files"],
            "budget_ms": NODE_BUDGET_MS,
            "failure_policy": "escalate",
        },
    )
    return {**dag, "nodes": nodes}


def builder_dag(width: int = 6) -> dict:
    nodes = [
        {
            "id": f"builder-{i}",
            "subagent": {"prompt": f"builder prompt {i}", "name": f"builder-{i}"},
            "outputs": [{"name": "line", "type": "text"}],
            "budget_ms": NODE_BUDGET_MS,
        }
        for i in range(1, width + 1)
    ]
    nodes.append(
        {
            "id": "collector",
            "subagent": {"prompt": "collector prompt", "name": "build-collector"},
            "inputs": [
                {"name": f"line-{i}", "type": "text", "from": f"builder-{i}.line"}
                for i in range(1, width + 1)
            ],
            "outputs": [{"name": "merged", "type": "text"}],
            "budget_ms": NODE_BUDGET_MS,
        }
    )
    return {"run": {"budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": 8}, "nodes": nodes}


def resident_watcher_dag() -> dict:
    return {
        "run": {"budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": 8},
        "nodes": [
            {
                "id": "watcher",
                "subagent": {"prompt": "resident watcher prompt", "name": "resident-watcher"},
                "lifecycle": "resident",
            },
            {
                "id": "task-a",
                "subagent": {"prompt": "task a prompt", "name": "chain-step-a"},
                "outputs": [{"name": "step", "type": "text"}],
                "budget_ms": NODE_BUDGET_MS,
            },
            {
                "id": "task-b",
                "subagent": {"prompt": "task b prompt over {prev}", "name": "chain-step-b"},
                "inputs": [{"name": "prev", "type": "text", "from": "task-a.step"}],
                "outputs": [{"name": "step", "type": "text"}],
                "budget_ms": NODE_BUDGET_MS,
            },
        ],
    }


def broken_dag() -> dict:
    return {
        "run": {"budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": 8},
        "nodes": [{"id": "broken-source", "subagent": "no-such-subagent-entry"}],
    }


def pr_manager_machine() -> dict:
    return {
        "run": {
            "budget_ms": RUN_BUDGET_MS,
            "failure_policy": "escalate",
            "max_parallel": 8,
            "max_transitions": 24,
        },
        "states": [
            {
                "id": "entry",
                "entry": True,
                "subagent": {"prompt": "entry prompt", "name": "pr-entry"},
                "outputs": [{"name": "pr_url", "type": "text"}],
                "budget_ms": NODE_BUDGET_MS,
            },
            {
                "id": "reviewing",
                "subagent": {"prompt": "reviewing prompt over {pr_url} and {fix_report}", "name": "pr-reviewing"},
                "inputs": [
                    {"name": "pr_url", "type": "text", "from": "entry.pr_url"},
                    {"name": "fix_report", "type": "json", "from": "fixing.fix_report", "optional": True},
                ],
                "outputs": [{"name": "verdict", "type": "json"}],
                "max_entries": 4,
                "budget_ms": NODE_BUDGET_MS,
            },
            {
                "id": "fixing",
                "subagent": {"prompt": "fixing prompt over {verdict}", "name": "pr-fixing"},
                "inputs": [{"name": "verdict", "type": "json", "from": "reviewing.verdict"}],
                "outputs": [{"name": "fix_report", "type": "json"}],
                "max_entries": 3,
                "budget_ms": NODE_BUDGET_MS,
            },
            {
                "id": "monitoring",
                "subagent": {"prompt": "resident monitoring prompt", "name": "pr-monitoring"},
                "lifecycle": "resident",
            },
        ],
        "transitions": [
            {"from": "entry", "to": "reviewing"},
            {
                "from": "reviewing",
                "to": "fixing",
                "when": {"output": "verdict", "path": "approved", "op": "eq", "value": False},
            },
            {
                "from": "reviewing",
                "to": "monitoring",
                "when": {"output": "verdict", "path": "approved", "op": "eq", "value": True},
            },
            {"from": "fixing", "to": "reviewing"},
        ],
    }


class FactoryEvalSpecsValidateTest(unittest.TestCase):
    """Every reference spec the eval seeds validates and canonicalizes."""

    def test_reference_dags_validate_clean(self) -> None:
        for spec in (review_sweep_dag(), review_sweep_fail_dag(), builder_dag(), resident_watcher_dag()):
            errors = validate_factory_spec(spec)
            self.assertEqual(errors, [], f"spec must validate clean: {errors}")

    def test_the_broken_dag_is_structurally_valid(self) -> None:
        # The dry-run probe fails at RUN-time subagent resolution, not at
        # write-time validation: it must stay structurally valid so the
        # executor's reference check is what rejects it.
        self.assertEqual(validate_factory_spec(broken_dag()), [])

    def test_reference_dags_compile_to_machine_form(self) -> None:
        for spec in (review_sweep_dag(), builder_dag(4), resident_watcher_dag()):
            canonical = canonicalize_factory_spec(spec)
            self.assertIn("states", canonical)
            self.assertIn("transitions", canonical)
            self.assertNotIn("nodes", canonical)
            self.assertEqual(validate_factory_spec(canonical), [], "the compiled machine re-validates")

    def test_the_pr_manager_machine_validates_as_machine_form(self) -> None:
        errors = validate_factory_spec(pr_manager_machine())
        self.assertEqual(errors, [], f"the pr-manager machine validates: {errors}")
        canonical = canonicalize_factory_spec(pr_manager_machine())
        self.assertEqual(canonicalize_factory_spec(canonical), canonical, "canonicalization is idempotent")

    def test_reference_dags_topologically_order(self) -> None:
        order = topological_order(review_sweep_dag()["nodes"])
        self.assertEqual(order[0], "files")
        self.assertIn(order.index("files") < order.index("review"), [True])
        self.assertIn(order.index("review") < order.index("report"), [True])
        collector_last = topological_order(builder_dag(3)["nodes"])
        self.assertEqual(collector_last[-1], "collector")

    def test_seeded_arguments_shapes_match_the_store_contract(self) -> None:
        # The eval seeds machine specs under arguments.machine and dag specs
        # under arguments.dag (never both). The stored payloads are the raw
        # specs themselves: each validates clean on its own, while a spec
        # dict carrying BOTH forms is rejected outright.
        self.assertEqual(validate_factory_spec(pr_manager_machine()), [])
        self.assertEqual(validate_factory_spec(review_sweep_dag()), [])
        mixed = {
            "run": {"budget_ms": RUN_BUDGET_MS},
            "nodes": review_sweep_dag()["nodes"],
            "states": pr_manager_machine()["states"],
            "transitions": pr_manager_machine()["transitions"],
        }
        errors = validate_factory_spec(mixed)
        self.assertTrue(any("not both" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
