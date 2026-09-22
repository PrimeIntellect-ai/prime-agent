"""Harbor environment that preserves specialized tasks in a separate verifier."""

import json
import time
from pathlib import Path

import verifiers.v1 as vf
from offline_swebench_grader import grade
from verified_verifier import MAX_PATCH_BYTES, filter_test_control, rewrite_test_script, trusted_base_commit
from verifiers.v1.runtimes import Runtime
from verifiers.v1.tasksets.harbor import HarborEnv, HarborEnvConfig, HarborTask
from verifiers.v1.tasksets.harbor.taskset import verifier_box_data


class SecureVerifiedMixin:
    async def setup(self, runtime: Runtime) -> None:
        await super().setup(runtime)
        if not self.data.name.endswith(" (verifier)"):
            return
        base = trusted_base_commit(Path(self.data.task_dir))
        result = await runtime.run(
            ["sh", "-c", f"git reset --hard {base} && git clean -fd"],
            {},
        )
        if result.exit_code:
            detail = (result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeError(f"could not reset SWE-bench verifier to its trusted base: {detail}")

    async def stage_verifier(self, runtime: Runtime) -> None:
        await super().stage_verifier(runtime)
        raw = await runtime.read("/tmp/prime-agent.patch", max_bytes=MAX_PATCH_BYTES + 1)
        if isinstance(raw, bytes) and len(raw) > MAX_PATCH_BYTES:
            raise RuntimeError(
                "candidate patch exceeds the filtering cap; refusing to apply an unfiltered tail"
            )
        if not raw:
            return
        filtered = filter_test_control(raw)
        if filtered.encode("utf-8") != raw:
            await runtime.write("/tmp/prime-agent.patch", filtered.encode("utf-8"))
        result = await runtime.run(
            ["sh", "-c", "test ! -s /tmp/prime-agent.patch || git apply --binary /tmp/prime-agent.patch"],
            {},
        )
        if result.exit_code:
            detail = (result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeError(f"candidate patch did not apply in verifier: {detail}")

    async def run_verifier(self, runtime: Runtime, trace: vf.Trace) -> float:
        script = rewrite_test_script((await runtime.read("/tests/test.sh", max_bytes=2_000_000)).decode())
        await runtime.write("/tests/test.sh", script.encode())
        removed = await runtime.run(
            ["rm", "-f", "/tests/config.json", "/tmp/tests.tgz"],
            {},
        )
        if removed.exit_code:
            raise RuntimeError("could not remove verifier-only metadata before tests")
        result = await runtime.run(
            [
                "bash",
                "-c",
                "set -o pipefail; bash /tests/test.sh 2>&1 | head -c 16000001",
            ],
            {"PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_INDEX": "1"},
        )
        log = result.stdout
        try:
            if len(log.encode()) > 16_000_000:
                raise ValueError("verifier output exceeds its size limit")
            config = json.loads((Path(self.data.task_dir) / "tests" / "config.json").read_text())
            instance = config["instance_id"]
            record = grade(config, log)[instance]
            resolved = record["resolved"]
            if not isinstance(resolved, bool) or result.exit_code not in (0, 1):
                raise ValueError("inconsistent verifier result")
        except (KeyError, OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            detail = (log or result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeError(f"SWE-bench verifier failed closed: {detail}") from exc
        trace.info["swebench_verifier"] = record
        trace.info["swebench_verifier_log_tail"] = log[-100_000:]
        return float(resolved)


class SecureHarborConfig(HarborEnvConfig):
    pass


class SecureHarbor(HarborEnv):
    async def finalize(self, task: vf.Task, episode: vf.Episode) -> None:
        if not isinstance(task, HarborTask) or task.data.verifier is None:
            return
        solution = episode.traces[0]
        if not solution.ok:
            return
        artifacts = solution.state.artifacts
        expected = {"/logs/artifacts", "/tmp/prime-agent.patch"}
        if set(artifacts) != expected or artifacts["/logs/artifacts"] is not None:
            raise RuntimeError("solver produced undeclared verifier artifacts")
        grader = type(task)(verifier_box_data(task.data), task.config)
        started = time.monotonic()
        scores, solution = await self.grade(
            self.verifier_config(task),
            grader,
            solution,
            scoring_timeout_covers_attempt=True,
        )
        solution.info["isolated_verifier_seconds"] = time.monotonic() - started
        items = scores.items() if isinstance(scores, dict) else [("solved", scores)]
        for name, value in items:
            solution.record_reward(name, value)
        episode.traces[0] = solution


__all__ = ["SecureHarbor"]
