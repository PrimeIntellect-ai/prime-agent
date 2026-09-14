from __future__ import annotations

import json
import unittest

from evaluation import (
    TASK_COUNT,
    BaselineResult,
    CandidateResult,
    ConfirmationRecord,
    FindingConfirmation,
    Identity,
    TaskResult,
    candidate_fingerprint,
    compare,
    make_baseline,
    render_markdown,
)
from pydantic import ValidationError

SHA_A = "a" * 40
SHA_B = "b" * 40
HARNESS_SHA = "c" * 40
MANIFEST = "d" * 64
EVALUATOR_CONTRACT = "e" * 64
ARTIFACTS = "https://example.com/actions/run/1"


def identity(**changes) -> Identity:
    values = {
        "repository": "PrimeIntellect-ai/prime-agent",
        "pr": 42,
        "head_sha": SHA_A,
        "harness_sha": HARNESS_SHA,
        "manifest_fingerprint": MANIFEST,
        "evaluator_contract_fingerprint": EVALUATOR_CONTRACT,
        "model": "provider/model-v1",
        "autonomous": False,
    }
    values.update(changes)
    return Identity(**values)


def task(index: int, **changes) -> TaskResult:
    values = {
        "task_id": f"task-{index:02d}",
        "resolved": True,
        "provider_output_tokens": 100,
        "e2e_seconds": 10.0,
        "model_calls": 2,
        "tool_calls": 4,
        "model_timeout": False,
        "infrastructure_error": False,
        "trace_fact_counts": {},
        "deterministic_critical_safety_violation": False,
    }
    values.update(changes)
    return TaskResult(**values)


def candidate(tasks=None, **changes) -> CandidateResult:
    values = {
        "identity": identity(),
        "tasks": tasks if tasks is not None else [task(index) for index in range(TASK_COUNT)],
        "systemic_failures": [],
    }
    values.update(changes)
    return CandidateResult(**values)


def with_task_changes(result: CandidateResult, changes: dict[int, dict]) -> CandidateResult:
    tasks = []
    for index, original in enumerate(result.tasks):
        update = changes.get(index, {})
        tasks.append(original.model_copy(update=update))
    return result.model_copy(update={"tasks": tasks})


class SchemaTests(unittest.TestCase):
    def test_candidate_and_baseline_round_trip_as_strict_json(self):
        result = candidate()
        loaded = CandidateResult.model_validate_json(result.model_dump_json())
        self.assertEqual(loaded, result)
        baseline = make_baseline(result)
        self.assertEqual(
            BaselineResult.model_validate_json(baseline.model_dump_json()),
            baseline,
        )
        self.assertEqual(baseline.source_candidate_fingerprint, candidate_fingerprint(result))

    def test_exactly_28_unique_tasks_are_required(self):
        tasks = [task(index) for index in range(TASK_COUNT)]
        for invalid in (tasks[:-1], [*tasks, task(TASK_COUNT)]):
            with self.subTest(count=len(invalid)), self.assertRaises(ValidationError):
                candidate(invalid)
        duplicate = [*tasks[:-1], task(0)]
        with self.assertRaisesRegex(ValidationError, "task_id values must be unique"):
            candidate(duplicate)

    def test_identity_and_metrics_reject_wrong_types_and_values(self):
        with self.assertRaises(ValidationError):
            identity(autonomous=True)
        with self.assertRaises(ValidationError):
            identity(head_sha="not-a-sha")
        with self.assertRaises(ValidationError):
            identity(manifest_fingerprint="short")
        with self.assertRaises(ValidationError):
            identity(evaluator_contract_fingerprint="short")
        with self.assertRaises(ValidationError):
            identity(repository="missing-owner")
        with self.assertRaises(ValidationError):
            identity(pr=0)
        for field, value in (
            ("provider_output_tokens", -1),
            ("e2e_seconds", -0.1),
            ("model_calls", -1),
            ("tool_calls", -1),
            ("trace_fact_counts", {"timeouts": -1}),
        ):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                task(0, **{field: value})
        for field in ("provider_output_tokens", "model_calls", "tool_calls"):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                task(0, **{field: True})
        for value in (float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                task(0, e2e_seconds=value)

    def test_json_does_not_coerce_strings_or_allow_extra_fields(self):
        data = json.loads(candidate().model_dump_json())
        data["tasks"][0]["provider_output_tokens"] = "100"
        with self.assertRaises(ValidationError):
            CandidateResult.model_validate_json(json.dumps(data))
        data = json.loads(candidate().model_dump_json())
        data["identity"]["unexpected"] = "value"
        with self.assertRaises(ValidationError):
            CandidateResult.model_validate_json(json.dumps(data))
        data = json.loads(candidate().model_dump_json())
        del data["tasks"][0]["trace_fact_counts"]
        with self.assertRaises(ValidationError):
            CandidateResult.model_validate_json(json.dumps(data))

    def test_zero_metrics_and_order_independent_aggregates_are_valid(self):
        zero = candidate(
            [
                task(
                    index,
                    resolved=False,
                    provider_output_tokens=0,
                    e2e_seconds=0.0,
                    model_calls=0,
                    tool_calls=0,
                    trace_fact_counts={"timeouts": 0},
                )
                for index in range(TASK_COUNT)
            ]
        )
        baseline = make_baseline(zero)
        shuffled = candidate(list(reversed(zero.tasks)))
        comparison = compare(shuffled, baseline)
        self.assertEqual(comparison.status, "pass")
        self.assertIsNone(comparison.output_token_ratio)
        self.assertIsNone(comparison.e2e_ratio)


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.base_candidate = candidate()
        self.baseline = make_baseline(self.base_candidate)

    def test_seed_mode_never_fails_even_with_absolute_signals(self):
        seeded = with_task_changes(
            self.base_candidate,
            {0: {"deterministic_critical_safety_violation": True}},
        ).model_copy(update={"systemic_failures": ["cleanup"]})
        result = compare(seeded)
        self.assertEqual((result.mode, result.status), ("seed", "seed"))
        self.assertIsNone(result.baseline)

    def test_resolution_loss_boundary(self):
        for losses, status in ((4, "pass"), (5, "needs_confirmation")):
            changes = {index: {"resolved": False} for index in range(losses)}
            with self.subTest(losses=losses):
                result = compare(with_task_changes(self.base_candidate, changes), self.baseline)
                self.assertEqual(result.status, status)
                self.assertEqual(result.resolved_delta, -losses)

    def test_additional_model_timeout_boundary(self):
        for timeouts, status in ((2, "pass"), (3, "needs_confirmation")):
            changes = {index: {"model_timeout": True} for index in range(timeouts)}
            with self.subTest(timeouts=timeouts):
                result = compare(with_task_changes(self.base_candidate, changes), self.baseline)
                self.assertEqual(result.status, status)

    def test_ratio_boundaries_and_zero_baseline(self):
        for field, below, exact in (
            ("provider_output_tokens", 199, 200),
            ("e2e_seconds", 19.99, 20.0),
        ):
            with self.subTest(field=field, boundary="below"):
                changes = {index: {field: below} for index in range(TASK_COUNT)}
                self.assertEqual(
                    compare(with_task_changes(self.base_candidate, changes), self.baseline).status,
                    "pass",
                )
            with self.subTest(field=field, boundary="exact"):
                changes = {index: {field: exact} for index in range(TASK_COUNT)}
                self.assertEqual(
                    compare(with_task_changes(self.base_candidate, changes), self.baseline).status,
                    "needs_confirmation",
                )
        zero = candidate(
            [task(index, provider_output_tokens=0, e2e_seconds=0.0) for index in range(TASK_COUNT)]
        )
        result = compare(self.base_candidate, make_baseline(zero))
        self.assertEqual(result.status, "pass")
        self.assertIsNone(result.output_token_ratio)
        self.assertIsNone(result.e2e_ratio)

    def test_resolution_improvement_suppresses_ratio_findings(self):
        prior = with_task_changes(self.base_candidate, {0: {"resolved": False}})
        expensive = with_task_changes(
            self.base_candidate,
            {index: {"provider_output_tokens": 1000, "e2e_seconds": 100.0} for index in range(TASK_COUNT)},
        )
        result = compare(expensive, make_baseline(prior))
        self.assertEqual(result.resolved_delta, 1)
        self.assertEqual(result.status, "pass")

    def test_critical_safety_and_each_systemic_failure_need_confirmation(self):
        unsafe = with_task_changes(
            self.base_candidate,
            {0: {"deterministic_critical_safety_violation": True}},
        )
        result = compare(unsafe, self.baseline)
        self.assertEqual([finding.code for finding in result.findings], ["critical_safety"])
        for failure in (
            "install",
            "launch",
            "acp",
            "cpython",
            "trace_integrity",
            "cleanup",
        ):
            with self.subTest(failure=failure):
                current = self.base_candidate.model_copy(update={"systemic_failures": [failure]})
                result = compare(current, self.baseline)
                self.assertEqual(result.status, "needs_confirmation")
                self.assertEqual(result.findings[0].code, f"systemic_{failure}_failure")
        with self.assertRaises(ValidationError):
            candidate(systemic_failures=["network"])

    def test_infrastructure_errors_and_trace_facts_are_aggregated_but_not_systemic(
        self,
    ):
        changed = with_task_changes(
            self.base_candidate,
            {
                0: {
                    "infrastructure_error": True,
                    "trace_fact_counts": {"timeouts": 2, "ignored_failures": 1},
                }
            },
        )
        result = compare(changed, self.baseline)
        self.assertEqual(result.status, "pass")
        self.assertEqual(result.candidate.infrastructure_errors, 1)
        self.assertEqual(result.candidate.trace_findings, 3)

    def test_incompatible_identity_or_task_set_is_rejected(self):
        for field, value in (
            ("repository", "other/repository"),
            ("manifest_fingerprint", "f" * 64),
            ("evaluator_contract_fingerprint", "f" * 64),
            ("model", "other/model"),
        ):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                changed_identity = identity(**{field: value})
                changed = self.base_candidate.model_copy(update={"identity": changed_identity})
                compare(changed, self.baseline)
        changed_harness = self.base_candidate.model_copy(update={"identity": identity(harness_sha="e" * 40)})
        self.assertEqual(compare(changed_harness, self.baseline).status, "pass")
        changed_tasks = list(self.base_candidate.tasks)
        changed_tasks[0] = changed_tasks[0].model_copy(update={"task_id": "other-task"})
        with self.assertRaisesRegex(ValueError, "task_id"):
            compare(
                self.base_candidate.model_copy(update={"tasks": changed_tasks}),
                self.baseline,
            )


class ConfirmationTests(unittest.TestCase):
    def setUp(self):
        original = candidate()
        self.baseline = make_baseline(original)
        self.candidate = with_task_changes(
            original,
            {index: {"resolved": False} for index in range(5)},
        )

    def confirmation(self, confirmed: bool, **changes) -> ConfirmationRecord:
        values = {
            "candidate_fingerprint": candidate_fingerprint(self.candidate),
            "findings": [
                FindingConfirmation(
                    code="resolved_losses",
                    confirmed=confirmed,
                    task_ids=[f"task-{index:02}" for index in range(5)],
                    note="Focused rerun reproduced the result.",
                )
            ],
        }
        values.update(changes)
        return ConfirmationRecord(**values)

    def test_first_crossing_needs_confirmation_and_confirmed_second_record_fails(self):
        first = compare(self.candidate, self.baseline)
        self.assertEqual(first.status, "needs_confirmation")
        second = compare(self.candidate, self.baseline, self.confirmation(True))
        self.assertEqual(second.status, "fail")
        self.assertTrue(second.confirmation_applied)

    def test_clean_focused_confirmation_clears_the_finding(self):
        result = compare(self.candidate, self.baseline, self.confirmation(False))
        self.assertEqual(result.status, "pass")

    def test_stale_wrong_or_unknown_confirmation_is_rejected(self):
        stale = self.confirmation(False).model_copy(update={"candidate_fingerprint": "0" * 64})
        with self.assertRaisesRegex(ValueError, "does not match"):
            compare(self.candidate, self.baseline, stale)
        wrong_code = self.confirmation(False).model_copy(
            update={
                "findings": [
                    FindingConfirmation(
                        code="model_timeouts",
                        confirmed=True,
                        task_ids=["task-00"],
                        note="Wrong reason.",
                    )
                ]
            }
        )
        with self.assertRaisesRegex(ValueError, "did not cross"):
            compare(self.candidate, self.baseline, wrong_code)
        unknown_task = self.confirmation(False).findings[0].model_copy(update={"task_ids": ["unknown-task"]})
        record = self.confirmation(False).model_copy(update={"findings": [unknown_task]})
        with self.assertRaisesRegex(ValueError, "unknown task_id"):
            compare(self.candidate, self.baseline, record)
        partial = self.confirmation(False).findings[0].model_copy(update={"task_ids": ["task-00"]})
        record = self.confirmation(False).model_copy(update={"findings": [partial]})
        with self.assertRaisesRegex(ValueError, "must match"):
            compare(self.candidate, self.baseline, record)

    def test_partial_clean_confirmation_keeps_other_finding_pending(self):
        expensive = with_task_changes(
            self.candidate,
            {index: {"provider_output_tokens": 200} for index in range(TASK_COUNT)},
        )
        self.candidate = expensive
        result = compare(expensive, self.baseline, self.confirmation(False))
        self.assertEqual(result.status, "needs_confirmation")


class ReportTests(unittest.TestCase):
    def test_report_is_compact_deterministic_and_uses_neutral_noise_language(self):
        current = candidate()
        result = compare(current, make_baseline(current))
        first = render_markdown(current, result, ARTIFACTS)
        second = render_markdown(current, result, ARTIFACTS)
        self.assertEqual(first, second)
        self.assertIn("| Resolution | 28/28 | 28/28 | 0 |", first)
        self.assertIn("| Provider output tokens | 2,800 | 2,800 | 0 |", first)
        self.assertIn("| E2E | 280.0 s | 280.0 s | 0.0 s |", first)
        self.assertIn("| Model timeouts | 0 | 0 | 0 |", first)
        self.assertIn("| Trace findings | 0 | 0 | 0 |", first)
        self.assertIn("expected run-to-run noise, not wins or regressions", first)
        self.assertIn(f"[Artifacts]({ARTIFACTS})", first)
        self.assertNotIn("regressed", first.lower())

    def test_seed_report_explains_that_it_never_fails(self):
        current = candidate()
        report = render_markdown(current, compare(current), ARTIFACTS)
        self.assertIn("Status: **seed**", report)
        self.assertIn("This run seeds it and does not fail", report)
        self.assertIn("| Resolution | n/a | 28/28 | n/a |", report)

    def test_report_escapes_identity_and_artifact_link_characters(self):
        current = candidate().model_copy(update={"identity": identity(model="model|`<tag>[x](y)\\*_!")})
        report = render_markdown(
            current,
            compare(current),
            "https://example.com/artifacts/(run)[one]",
        )
        self.assertNotIn("<tag>", report)
        self.assertIn("&lt;tag&gt;", report)
        self.assertIn("&#124;", report)
        self.assertIn("%28run%29%5Bone%5D", report)
        for row in [line for line in report.splitlines() if line.startswith("| ")]:
            self.assertEqual(row.count("|"), 5)

    def test_report_rejects_unsafe_or_multiline_artifact_urls(self):
        current = candidate()
        result = compare(current)
        for url in (
            "javascript:alert(1)",
            "http://example.com",
            "https://example.com/x\ny",
        ):
            with (
                self.subTest(url=url),
                self.assertRaisesRegex(ValueError, "absolute HTTPS"),
            ):
                render_markdown(current, result, url)


if __name__ == "__main__":
    unittest.main()
