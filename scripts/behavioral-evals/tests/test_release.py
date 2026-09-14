from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import release
from evaluation import make_baseline

from tests.fixtures import REPOSITORY, make_candidate


class ReleasePointerTests(unittest.TestCase):
    def test_generation_tag_accepts_only_an_exact_immutable_pointer(self):
        valid = json.dumps({"release_tag": "behavioral-eval-reference-123-2"})
        with patch.object(release, "release", return_value={"body": valid}) as lookup:
            self.assertEqual(
                release.generation_tag(REPOSITORY),
                "behavioral-eval-reference-123-2",
            )
        lookup.assert_called_once_with(REPOSITORY, release.STABLE_TAG)

        invalid_bodies = [
            "not-json",
            json.dumps({}),
            json.dumps(
                {
                    "release_tag": "behavioral-eval-reference-123-2",
                    "mutable": True,
                }
            ),
            json.dumps({"release_tag": "behavioral-eval-reference-123"}),
            json.dumps({"release_tag": "behavioral-eval-reference-latest"}),
            json.dumps({"release_tag": "../behavioral-eval-reference-123-2"}),
        ]
        for body in invalid_bodies:
            with (
                self.subTest(body=body),
                patch.object(release, "release", return_value={"body": body}),
                self.assertRaisesRegex(ValueError, "pointer"),
            ):
                release.generation_tag(REPOSITORY)

    def test_generation_tag_returns_none_when_the_stable_pointer_is_absent(self):
        with patch.object(release, "release", return_value=None):
            self.assertIsNone(release.generation_tag(REPOSITORY))


class ReleaseGenerationTests(unittest.TestCase):
    def _generation(self):
        candidate = make_candidate()
        baseline = make_baseline(candidate)
        tarballs = {name: f"contents:{name}".encode() for name in release.TARBALLS}
        manifest = {
            "sha": candidate.identity.head_sha,
            "artifacts": [
                {
                    "name": name,
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
                for name, data in sorted(tarballs.items())
            ],
        }
        provenance = {
            "schema_version": 1,
            "repository": candidate.identity.repository,
            "pr": candidate.identity.pr,
            "head_sha": candidate.identity.head_sha,
            "base_sha": candidate.identity.harness_sha,
            "harness_sha": candidate.identity.harness_sha,
            "source_run_id": 123,
            "source_run_attempt": 2,
            "generation": "behavioral-eval-reference-123-2",
            "candidate_fingerprint": baseline.source_candidate_fingerprint,
            "evaluator_contract_fingerprint": (baseline.identity.evaluator_contract_fingerprint),
            "baseline_generation": "behavioral-eval-reference-100-1",
        }
        payloads = {
            **tarballs,
            "baseline.json": baseline.model_dump_json().encode(),
            "provenance.json": json.dumps(provenance).encode(),
            "artifact-manifest.json": json.dumps(manifest).encode(),
        }
        selected = {
            "assets": [
                {
                    "name": name,
                    "size": len(data),
                    "url": f"https://api.example/assets/{name}",
                }
                for name, data in sorted(payloads.items())
            ]
        }
        return payloads, selected

    @staticmethod
    def _download(payloads):
        def download(url, **_kwargs):
            return 200, payloads[url.rsplit("/", 1)[-1]]

        return download

    @staticmethod
    def _replace_provenance(payloads, selected, **changes):
        provenance = json.loads(payloads["provenance.json"])
        provenance.update(changes)
        payloads["provenance.json"] = json.dumps(provenance).encode()
        next(asset for asset in selected["assets"] if asset["name"] == "provenance.json")["size"] = len(
            payloads["provenance.json"]
        )

    def test_fetch_downloads_one_generation_and_validates_internal_bindings(self):
        payloads, selected = self._generation()
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "baseline"
            with (
                patch.object(release, "release", return_value=selected) as lookup,
                patch.object(
                    release,
                    "request_json",
                    side_effect=self._download(payloads),
                ),
            ):
                release.fetch(
                    REPOSITORY,
                    "behavioral-eval-reference-123-2",
                    destination,
                )
            self.assertEqual({path.name for path in destination.iterdir()}, release.FILES)
        lookup.assert_called_once_with(REPOSITORY, "behavioral-eval-reference-123-2")

    def test_fetch_rejects_a_tag_that_disagrees_with_run_attempt(self):
        payloads, selected = self._generation()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(release, "release", return_value=selected),
            patch.object(release, "request_json", side_effect=self._download(payloads)),
            self.assertRaisesRegex(ValueError, "generation mismatch"),
        ):
            release.fetch(
                REPOSITORY,
                "behavioral-eval-reference-123-3",
                Path(directory),
            )

    def test_fetch_rejects_a_generation_not_bound_to_its_baseline(self):
        payloads, selected = self._generation()
        self._replace_provenance(
            payloads,
            selected,
            candidate_fingerprint="0" * 64,
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(release, "release", return_value=selected),
            patch.object(release, "request_json", side_effect=self._download(payloads)),
            self.assertRaisesRegex(ValueError, "provenance fingerprint"),
        ):
            release.fetch(
                REPOSITORY,
                "behavioral-eval-reference-123-2",
                Path(directory),
            )

    def test_fetch_rejects_provenance_from_another_identity(self):
        cases = {
            "repository": "other/repository",
            "pr": 7,
            "head_sha": "0" * 40,
            "harness_sha": "1" * 40,
            "base_sha": "2" * 40,
            "evaluator_contract_fingerprint": "3" * 64,
        }
        for field, value in cases.items():
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                payloads, selected = self._generation()
                self._replace_provenance(payloads, selected, **{field: value})
                with (
                    patch.object(release, "release", return_value=selected),
                    patch.object(
                        release,
                        "request_json",
                        side_effect=self._download(payloads),
                    ),
                    self.assertRaisesRegex(ValueError, "provenance"),
                ):
                    release.fetch(
                        REPOSITORY,
                        "behavioral-eval-reference-123-2",
                        Path(directory),
                    )

    def test_fetch_rejects_missing_or_extra_generation_assets(self):
        _, selected = self._generation()
        selected["assets"].pop()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(release, "release", return_value=selected),
            self.assertRaisesRegex(ValueError, "incomplete or extra assets"),
        ):
            release.fetch(
                REPOSITORY,
                "behavioral-eval-reference-123-2",
                Path(directory),
            )


if __name__ == "__main__":
    unittest.main()
