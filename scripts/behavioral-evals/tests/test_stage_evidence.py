from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import stage_evidence


class StageEvidenceTests(unittest.TestCase):
    def test_stage_preserves_roots_and_tails_large_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "raw-eval"
            source.mkdir()
            (source / "trace.jsonl").write_text("trace")
            (source / "eval.log").write_bytes(b"prefix" + b"x" * 20)
            with patch.object(stage_evidence, "LOG_LIMIT", 20):
                stage_evidence.stage([source], root / "upload")
            self.assertEqual((root / "upload/raw-eval/trace.jsonl").read_text(), "trace")
            self.assertEqual((root / "upload/raw-eval/eval.log").read_bytes(), b"x" * 20)

    def test_stage_rejects_symlinks_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "results"
            source.mkdir()
            target = source / "target"
            target.write_text("data")
            link = source / "link"
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "symlinks"):
                stage_evidence.stage([source], root / "links")
            self.assertFalse((root / "links").exists())
            link.unlink()
            with (
                patch.object(stage_evidence, "FILE_LIMIT", 2),
                self.assertRaisesRegex(ValueError, "size limit"),
            ):
                stage_evidence.stage([source], root / "large")
            self.assertFalse((root / "large").exists())

    def test_stage_prechecks_total_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "results"
            source.mkdir()
            (source / "first.txt").write_bytes(b"12")
            (source / "second.txt").write_bytes(b"34")
            output = root / "upload"
            with (
                patch.object(stage_evidence, "TOTAL_LIMIT", 3),
                patch.object(stage_evidence, "_copy_file") as copy_file,
                self.assertRaisesRegex(ValueError, "total size limit"),
            ):
                stage_evidence.stage([source], output)
            copy_file.assert_not_called()
            self.assertFalse(output.exists())

    def test_stage_publishes_only_after_copying(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "results"
            source.mkdir()
            (source / "result.json").write_text("result")
            output = root / "upload"
            copy_file = stage_evidence._copy_file

            def copy_while_hidden(source_path, target, size):
                self.assertFalse(output.exists())
                copy_file(source_path, target, size)

            with patch.object(stage_evidence, "_copy_file", side_effect=copy_while_hidden):
                stage_evidence.stage([source], output)
            self.assertEqual((output / "results/result.json").read_text(), "result")

    def test_stage_cleans_temporary_tree_when_copying_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "results"
            source.mkdir()
            (source / "result.json").write_text("result")
            output = root / "upload"
            with (
                patch.object(stage_evidence, "_copy_file", side_effect=OSError("copy failed")),
                self.assertRaisesRegex(OSError, "copy failed"),
            ):
                stage_evidence.stage([source], output)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".upload-*")), [])


if __name__ == "__main__":
    unittest.main()
