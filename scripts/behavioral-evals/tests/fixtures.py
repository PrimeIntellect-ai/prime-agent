from __future__ import annotations

from evaluation import CandidateResult, Identity, TaskResult

SHA_A = "a" * 40
HARNESS_SHA = "b" * 40
MANIFEST_FINGERPRINT = "c" * 64
EVALUATOR_CONTRACT_FINGERPRINT = "d" * 64
REPOSITORY = "PrimeIntellect-ai/prime-agent"


def make_identity() -> Identity:
    return Identity(
        repository=REPOSITORY,
        pr=42,
        head_sha=SHA_A,
        harness_sha=HARNESS_SHA,
        manifest_fingerprint=MANIFEST_FINGERPRINT,
        evaluator_contract_fingerprint=EVALUATOR_CONTRACT_FINGERPRINT,
        model="provider/model",
        autonomous=False,
    )


def make_candidate() -> CandidateResult:
    return CandidateResult(
        identity=make_identity(),
        tasks=[
            TaskResult(
                task_id=f"suite/task-{index:02d}",
                resolved=True,
                provider_output_tokens=100 + index,
                e2e_seconds=10.0 + index,
                model_calls=2,
                tool_calls=4,
                model_timeout=False,
                infrastructure_error=False,
                trace_fact_counts={},
            )
            for index in range(28)
        ],
    )


def make_request() -> dict:
    identity = make_identity()
    return {
        "repository": identity.repository,
        "pr": identity.pr,
        "head_sha": identity.head_sha,
        "harness_sha": identity.harness_sha,
        "base_sha": identity.harness_sha,
        "manifest_fingerprint": identity.manifest_fingerprint,
        "evaluator_contract_fingerprint": identity.evaluator_contract_fingerprint,
        "model": identity.model,
        "autonomous": identity.autonomous,
        "run_id": 123,
        "attempt": 2,
    }


def make_extracted(*, all_infrastructure_errors: bool = False) -> dict:
    return {
        "tasks": [
            {
                "taskset": "suite",
                "task": f"task-{index:02d}",
                "resolved": not all_infrastructure_errors,
                "output_tokens": 100 + index,
                "e2e_seconds": 10.0 + index,
                "model_calls": 2,
                "tool_calls": 4,
                "model_timeout": False,
                "infrastructure_error": all_infrastructure_errors,
                "failure_stage": "launch" if all_infrastructure_errors else None,
                "trace_facts": {"repeated_commands": index % 2},
            }
            for index in range(28)
        ]
    }
