from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

import evaluator_contract
import prepare


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((prepare.ROOT / "short-swe.json").read_text())

    def _write_taskset_sources(self, verifiers: Path, environments: Path) -> dict[str, Path]:
        by_id = {item["id"]: item for item in self.manifest["tasksets"]}
        paths = {}
        for taskset_id, module in (
            ("swebench-verified", "swebench_verified"),
            ("swebench-pro", "swebench_pro"),
        ):
            item = by_id[taskset_id]
            path = environments / item["package"] / module / "taskset.py"
            path.parent.mkdir(parents=True)
            unpinned = item["dataset"].split("@", 1)[0]
            path.write_text(f'first = "{unpinned}"\nsecond = "{unpinned}"\n')
            paths[taskset_id] = path

        scale = environments / by_id["scaleswe"]["package"] / "scaleswe/taskset.py"
        scale.parent.mkdir(parents=True)
        scale.write_text("dataset = load_dataset(self.config.dataset_name, split=self.config.split)\n")
        paths["scaleswe"] = scale

        init = verifiers / "verifiers/v1/tasksets/__init__.py"
        init.parent.mkdir(parents=True)
        init.write_text(
            "from verifiers.v1.tasksets.nemo_gym import NeMoGymConfig, NeMoGymTaskset\n"
            "__all__ = [\n"
            '    "NeMoGymConfig",\n'
            '    "NeMoGymTaskset",\n'
            "]\n"
        )
        paths["init"] = init
        return paths

    def test_main_pins_sources_and_writes_parseable_configs_and_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script_root = root / "script"
            verifiers = root / "verifiers"
            environments = root / "environments"
            artifacts = root / "artifacts"
            output = root / "output"
            script_root.mkdir()
            artifacts.mkdir()
            manifest_path = script_root / "short-swe.json"
            manifest_path.write_text(json.dumps(self.manifest, sort_keys=True))
            paths = self._write_taskset_sources(verifiers, environments)
            commit = "f" * 40
            argv = [
                "prepare.py",
                "--verifiers",
                str(verifiers),
                "--environments",
                str(environments),
                "--artifacts",
                str(artifacts),
                "--commit",
                commit,
                "--output",
                str(output),
            ]
            revisions = [
                self.manifest["verifiers_commit"],
                self.manifest["environments_commit"],
            ]
            env = {
                "GITHUB_REPOSITORY": "owner/repository",
                "GITHUB_RUN_ID": "77",
                "GITHUB_RUN_ATTEMPT": "2",
            }
            with (
                patch.object(sys, "argv", argv),
                patch.object(prepare, "ROOT", script_root),
                patch.object(prepare, "revision", side_effect=revisions),
                patch.dict(os.environ, env, clear=False),
            ):
                prepare.main()

            configs = sorted(output.glob("*.toml"))
            self.assertEqual(
                [path.name for path in configs],
                ["scaleswe.toml", "swebench-pro.toml", "swebench-verified.toml"],
            )
            verified = tomllib.loads((output / "swebench-verified.toml").read_text())
            self.assertEqual(
                verified["env"]["taskset"]["tasks"],
                self.manifest["tasksets"][0]["tasks"],
            )
            self.assertEqual(verified["env"]["agent"]["harness"]["commit"], commit)
            self.assertEqual(verified["env"]["agent"]["max_turns"], 128)
            self.assertEqual(verified["env"]["agent"]["max_output_tokens"], 100_000)
            self.assertEqual(verified["env"]["agent"]["max_total_tokens"], 5_000_000)
            self.assertEqual(verified["env"]["agent"]["timeout"]["rollout"], 3_600)
            self.assertEqual(
                verified["env"]["agent"]["runtime"]["labels"],
                [
                    "prime-agent-behavioral-v1",
                    "repository:owner/repository",
                    "run:77",
                    "attempt:2",
                    "role:task",
                ],
            )
            scaleswe = tomllib.loads((output / "scaleswe.toml").read_text())
            self.assertIn(
                self.manifest["tasksets"][2]["tasks"][0],
                scaleswe["env"]["taskset"]["filter_fn"],
            )
            for taskset_id in ("swebench-verified", "swebench-pro"):
                item = next(item for item in self.manifest["tasksets"] if item["id"] == taskset_id)
                text = paths[taskset_id].read_text()
                self.assertEqual(text.count(item["dataset"]), 2)
            self.assertIn(
                f'revision="{self.manifest["scaleswe_dataset_revision"]}"',
                paths["scaleswe"].read_text(),
            )
            self.assertNotIn("NeMoGym", paths["init"].read_text())
            expected_fingerprint = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            self.assertEqual(
                (output / "manifest-fingerprint").read_text(),
                expected_fingerprint + "\n",
            )
            self.assertEqual(
                (output / "evaluator-contract-fingerprint").read_text(),
                evaluator_contract.evaluator_contract_fingerprint() + "\n",
            )

    def test_validate_manifest_rejects_changed_limits(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["limits"]["max_turns"] += 1
        with self.assertRaisesRegex(ValueError, "unsupported Short SWE manifest"):
            prepare.validate_manifest(manifest)

    def test_validate_manifest_rejects_duplicate_task_keys(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["tasksets"][2]["tasks"][-1] = manifest["tasksets"][0]["tasks"][0]
        with self.assertRaisesRegex(ValueError, "28 unique"):
            prepare.validate_manifest(manifest)

    def test_replace_once_rejects_zero_or_multiple_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file.py"
            for text in ("no match", "target target"):
                with self.subTest(text=text):
                    path.write_text(text)
                    with self.assertRaisesRegex(ValueError, "did not match"):
                        prepare.replace_once(path, "target", "replacement")


if __name__ == "__main__":
    unittest.main()
