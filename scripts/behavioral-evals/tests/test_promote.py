from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import promote
from evaluation import candidate_fingerprint, compare, make_baseline

from tests.fixtures import make_candidate, make_request

ARTIFACT_NAMES = (
    "prime-agent-0.0.0-benchmark.tgz",
    "prime-agent-ai-0.0.0-benchmark.tgz",
    "prime-agent-core-0.0.0-benchmark.tgz",
    "prime-agent-tui-0.0.0-benchmark.tgz",
)


class PromoteTests(unittest.TestCase):
    def _write_inputs(self, root: Path, baseline=None, baseline_generation=None):
        candidate = make_candidate()
        request = root / "request.json"
        report = root / "report.json"
        artifacts = root / "artifacts"
        artifacts.mkdir()
        request.write_text(json.dumps(make_request()))
        report.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "candidate_fingerprint": candidate_fingerprint(candidate),
                    "candidate": candidate.model_dump(mode="json"),
                    "comparison": compare(candidate, baseline).model_dump(mode="json"),
                    "baseline_generation": baseline_generation,
                    "baseline_source_candidate_fingerprint": (
                        baseline.source_candidate_fingerprint if baseline else None
                    ),
                }
            )
        )
        records = []
        for index, name in enumerate(ARTIFACT_NAMES):
            data = f"artifact-{index}".encode()
            (artifacts / name).write_bytes(data)
            records.append(
                {
                    "name": name,
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        (artifacts / "artifact-manifest.json").write_text(
            json.dumps({"sha": candidate.identity.head_sha, "artifacts": records})
        )
        return candidate, request, report, artifacts

    def _argv(self, request, report, artifacts, output, *extra):
        return [
            "promote.py",
            "--request",
            str(request),
            "--report",
            str(report),
            "--source-run",
            "123",
            "--source-attempt",
            "2",
            "--artifacts",
            str(artifacts),
            "--output",
            str(output),
            *extra,
        ]

    def _write_current(self, root: Path, baseline, run_id=100, attempt=1):
        baseline_path = root / "current-baseline.json"
        provenance_path = root / "current-provenance.json"
        baseline_path.write_text(baseline.model_dump_json())
        provenance_path.write_text(
            json.dumps(
                {
                    "source_run_id": run_id,
                    "source_run_attempt": attempt,
                    "candidate_fingerprint": baseline.source_candidate_fingerprint,
                }
            )
        )
        return baseline_path, provenance_path

    def test_generation_identity_includes_run_attempt(self):
        self.assertEqual(promote.generation(123, 1), "behavioral-eval-reference-123-1")
        self.assertNotEqual(promote.generation(123, 1), promote.generation(123, 2))

    def test_main_validates_and_copies_a_seed_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, request, report, artifacts = self._write_inputs(root)
            output = root / "output"
            with patch.object(sys, "argv", self._argv(request, report, artifacts, output)):
                promote.main()

            for name in ARTIFACT_NAMES:
                self.assertEqual((output / name).read_bytes(), (artifacts / name).read_bytes())
            baseline = json.loads((output / "baseline.json").read_text())
            self.assertEqual(
                baseline["source_candidate_fingerprint"],
                candidate_fingerprint(candidate),
            )
            provenance = json.loads((output / "provenance.json").read_text())
            self.assertEqual(provenance["generation"], "behavioral-eval-reference-123-2")
            self.assertEqual(provenance["source_run_attempt"], 2)
            self.assertIsNone(provenance["baseline_generation"])
            self.assertEqual(
                provenance["evaluator_contract_fingerprint"],
                candidate.identity.evaluator_contract_fingerprint,
            )

    def test_main_accepts_only_the_exact_current_evaluated_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prior = make_baseline(make_candidate())
            candidate, request, report, artifacts = self._write_inputs(
                root, prior, "behavioral-eval-reference-100-1"
            )
            baseline_path, provenance_path = self._write_current(root, prior)
            output = root / "output"
            argv = self._argv(
                request,
                report,
                artifacts,
                output,
                "--current-baseline",
                str(baseline_path),
                "--current-provenance",
                str(provenance_path),
            )
            with patch.object(sys, "argv", argv):
                promote.main()
            provenance = json.loads((output / "provenance.json").read_text())
            self.assertEqual(
                provenance["baseline_generation"],
                "behavioral-eval-reference-100-1",
            )
            self.assertEqual(provenance["head_sha"], candidate.identity.head_sha)

    def test_main_rejects_old_a_after_newer_b_becomes_current(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = make_baseline(make_candidate())
            newer_candidate = make_candidate().model_copy(deep=True)
            newer_candidate.identity.head_sha = "e" * 40
            newer = make_baseline(newer_candidate)
            _, request, report, artifacts = self._write_inputs(root, old, "behavioral-eval-reference-100-1")
            baseline_path, provenance_path = self._write_current(root, newer, run_id=101)
            output = root / "output"
            argv = self._argv(
                request,
                report,
                artifacts,
                output,
                "--current-baseline",
                str(baseline_path),
                "--current-provenance",
                str(provenance_path),
            )
            with (
                patch.object(sys, "argv", argv),
                self.assertRaisesRegex(ValueError, "no longer current"),
            ):
                promote.main()
            self.assertFalse(output.exists())

    def test_main_rejects_changed_content_under_the_reported_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = make_baseline(make_candidate())
            newer_candidate = make_candidate().model_copy(deep=True)
            newer_candidate.identity.head_sha = "e" * 40
            newer = make_baseline(newer_candidate)
            _, request, report, artifacts = self._write_inputs(root, old, "behavioral-eval-reference-101-1")
            baseline_path, provenance_path = self._write_current(root, newer, run_id=101)
            output = root / "output"
            argv = self._argv(
                request,
                report,
                artifacts,
                output,
                "--current-baseline",
                str(baseline_path),
                "--current-provenance",
                str(provenance_path),
            )
            with (
                patch.object(sys, "argv", argv),
                self.assertRaisesRegex(ValueError, "fingerprint is no longer current"),
            ):
                promote.main()
            self.assertFalse(output.exists())

    def test_main_rejects_seed_if_a_reference_now_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, request, report, artifacts = self._write_inputs(root)
            current = make_baseline(make_candidate())
            baseline_path, provenance_path = self._write_current(root, current)
            output = root / "output"
            argv = self._argv(
                request,
                report,
                artifacts,
                output,
                "--current-baseline",
                str(baseline_path),
                "--current-provenance",
                str(provenance_path),
            )
            with (
                patch.object(sys, "argv", argv),
                self.assertRaisesRegex(ValueError, "published after seed"),
            ):
                promote.main()
            self.assertFalse(output.exists())

    def test_main_rejects_a_mismatched_artifact_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, request, report, artifacts = self._write_inputs(root)
            (artifacts / ARTIFACT_NAMES[0]).write_bytes(b"tampered")
            output = root / "output"
            with (
                patch.object(sys, "argv", self._argv(request, report, artifacts, output)),
                self.assertRaisesRegex(ValueError, "artifact size mismatch|artifact digest mismatch"),
            ):
                promote.main()
            self.assertFalse(output.exists())

    def test_main_preserves_the_base_revision_independently_from_the_evaluator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, request, report, artifacts = self._write_inputs(root)
            value = json.loads(request.read_text())
            value["base_sha"] = "f" * 40
            request.write_text(json.dumps(value))
            output = root / "output"
            with patch.object(sys, "argv", self._argv(request, report, artifacts, output)):
                promote.main()
            provenance = json.loads((output / "provenance.json").read_text())
            self.assertEqual(provenance["base_sha"], "f" * 40)
            self.assertEqual(provenance["harness_sha"], value["harness_sha"])


if __name__ == "__main__":
    unittest.main()
