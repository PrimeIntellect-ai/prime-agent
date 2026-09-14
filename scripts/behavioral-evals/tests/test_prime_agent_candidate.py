import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prime_agent_candidate as candidate

COMMIT = "a" * 40


class FakeRuntime:
    def __init__(self):
        self.writes = {}
        self.runs = []

    async def write(self, path, data):
        self.writes[path] = data

    async def run(self, command, env):
        self.runs.append((command, env))
        return SimpleNamespace(exit_code=0, stdout="", stderr="")


def make_artifacts(root: Path):
    blobs = {}
    for index, name in enumerate(candidate.TARBALLS):
        blobs[name] = f"tarball-{index}".encode()
        (root / name).write_bytes(blobs[name])
    (root / "artifact-manifest.json").write_text("{}")
    return blobs


def digests(blobs):
    return {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()}


class CandidateConfigTests(unittest.TestCase):
    def test_exports_one_prime_agent_subclass(self):
        self.assertEqual(candidate.__all__, ["PrimeAgentCandidateHarness"])
        self.assertEqual(
            candidate.interception_server.MAX_REQUEST_BODY,
            candidate.MAX_MODEL_REQUEST_BYTES,
        )
        manifest = json.loads((Path(candidate.__file__).parent / "short-swe.json").read_text())
        self.assertEqual(
            manifest["limits"]["max_inflight_model_calls"],
            candidate.MAX_INFLIGHT_MODEL_CALLS,
        )
        self.assertEqual(
            manifest["limits"]["max_model_request_bytes"],
            candidate.MAX_MODEL_REQUEST_BYTES,
        )
        self.assertTrue(issubclass(candidate.PrimeAgentCandidateHarness, candidate.PrimeAgentHarness))

    def test_rejects_non_sha_commit_and_autonomous_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            for kwargs in (
                {"commit": "not-a-sha"},
                {"commit": COMMIT, "autonomous": True},
            ):
                with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                    candidate.PrimeAgentCandidateHarnessConfig(artifact_dir=directory, **kwargs)

    def test_rejects_bad_checksum_config(self):
        with tempfile.TemporaryDirectory() as directory:
            checksums = {name: "0" * 64 for name in candidate.TARBALLS}
            for bad in (
                {next(iter(checksums)): "0" * 64},
                {**checksums, "unexpected.tgz": "0" * 64},
                {**checksums, candidate.TARBALLS[0]: "A" * 64},
            ):
                with self.subTest(checksums=bad), self.assertRaises(ValueError):
                    candidate.PrimeAgentCandidateHarnessConfig(
                        artifact_dir=directory, commit=COMMIT, checksums=bad
                    )


class InterceptionBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_model_request_stops_rollout(self):
        session = SimpleNamespace(trace=SimpleNamespace(stop=Mock()))
        setattr(session, candidate._INFLIGHT_ATTRIBUTE, 1)
        server = SimpleNamespace(sessions={"secret": session})
        request = SimpleNamespace(headers={"x-api-key": "secret"})
        dialect = SimpleNamespace(
            secret=lambda headers: headers["x-api-key"],
            error_body=lambda message: {"error": message},
        )

        response = await candidate.InterceptionServer.handle_request(server, request, dialect)

        self.assertEqual(response.status, 400)
        session.trace.stop.assert_called_once_with("max_inflight_model_calls")


class CandidateSetupTests(unittest.IsolatedAsyncioTestCase):
    async def _setup(self, directory, checksums=None, env=None):
        config = candidate.PrimeAgentCandidateHarnessConfig(
            artifact_dir=directory,
            commit=COMMIT,
            checksums=checksums,
            env=env or {},
        )
        harness = candidate.PrimeAgentCandidateHarness(config)
        runtime = FakeRuntime()
        ensure_node = AsyncMock()
        ensure_installed = AsyncMock()
        acp_setup = AsyncMock()
        with (
            patch.object(candidate, "ensure_node", ensure_node),
            patch.object(candidate, "ensure_installed", ensure_installed),
            patch.object(candidate.ACPHarness, "setup", acp_setup),
        ):
            await harness.setup(runtime)
        return harness, runtime, ensure_node, ensure_installed, acp_setup

    async def test_uploads_local_bytes_and_computed_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            blobs = make_artifacts(Path(directory))
            _, runtime, ensure_node, ensure_installed, acp_setup = await self._setup(directory)

        self.assertEqual({Path(path).name: data for path, data in runtime.writes.items()}, blobs)
        self.assertEqual(len({str(Path(path).parent) for path in runtime.writes}), 1)
        ensure_node.assert_awaited_once_with(runtime)
        acp_setup.assert_awaited_once_with(unittest.mock.ANY, runtime)
        kwargs = ensure_installed.await_args.kwargs
        self.assertEqual(kwargs["env"]["PRIME_AGENT_COMMIT"], COMMIT)
        expected = "\n".join(f"{digests(blobs)[name]}  {name}" for name in candidate.TARBALLS)
        self.assertEqual(kwargs["env"]["VF_PRIME_AGENT_SHA256SUMS"], expected)
        self.assertNotIn("curl", kwargs["install"])
        self.assertIn("sha256sum -c", kwargs["install"])
        self.assertIn("npm install -g", kwargs["install"])

    async def test_accepts_matching_checksums_and_strips_prime_api_key(self):
        with tempfile.TemporaryDirectory() as directory:
            blobs = make_artifacts(Path(directory))
            expected = digests(blobs)
            harness, _, _, installed, _ = await self._setup(
                directory, checksums=expected, env={"PRIME_API_KEY": "must-not-leak"}
            )
        self.assertNotIn("PRIME_API_KEY", installed.await_args.kwargs["env"])
        process_env = harness._env(SimpleNamespace(id="trace"), "intercept-secret")
        self.assertNotIn("PRIME_API_KEY", process_env)
        self.assertEqual(process_env["PRIME_AGENT_INTERCEPT_KEY"], "intercept-secret")

    async def test_rejects_changed_bytes_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            blobs = make_artifacts(Path(directory))
            expected = digests(blobs)
            (Path(directory) / candidate.TARBALLS[0]).write_bytes(b"changed")
            config = candidate.PrimeAgentCandidateHarnessConfig(
                artifact_dir=directory, commit=COMMIT, checksums=expected
            )
            runtime = FakeRuntime()
            with (
                patch.object(candidate, "ensure_node", AsyncMock()) as ensure_node,
                self.assertRaisesRegex(ValueError, "checksum mismatch"),
            ):
                await candidate.PrimeAgentCandidateHarness(config).setup(runtime)
        self.assertEqual(runtime.writes, {})
        ensure_node.assert_not_awaited()

    async def test_rejects_missing_or_extra_tarball(self):
        for change in ("missing", "extra"):
            with (
                self.subTest(change=change),
                tempfile.TemporaryDirectory() as directory,
            ):
                make_artifacts(Path(directory))
                if change == "missing":
                    (Path(directory) / candidate.TARBALLS[0]).unlink()
                else:
                    (Path(directory) / "unexpected.tgz").write_text("no")
                config = candidate.PrimeAgentCandidateHarnessConfig(artifact_dir=directory, commit=COMMIT)
                with self.assertRaisesRegex(ValueError, "exactly the four"):
                    await candidate.PrimeAgentCandidateHarness(config).setup(FakeRuntime())


if __name__ == "__main__":
    unittest.main()
