#!/usr/bin/env python3
"""Check same-out-dir multi-target decoder metadata and promotion identity."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSEMBLER = HERE / "assemble_artifacts.py"
SPLITTER = HERE / "split_debug.py"
VERIFIER = HERE / "verify_decoders.py"
CATALOG = HERE / "bundle_catalog.py"
TARGETS = (("x86_64-unknown-linux-gnu", "linux-x64"),
           ("aarch64-unknown-linux-gnu", "linux-arm64"))


def run(*args: str, success: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(args, capture_output=True, text=True)
    if success and result.returncode:
        raise AssertionError(f"{' '.join(args)} failed: {result.stderr[-1200:]}")
    return result


class DecoderManifest(unittest.TestCase):
    def test_two_targets_reassemble_and_promote(self) -> None:
        with tempfile.TemporaryDirectory(prefix="decoder-manifest-") as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            for directory in ("prime-agent-runtime", "skills", "docs"):
                (repo / directory).mkdir()
            (repo / "prime-agent-runtime/pyproject.toml").write_text("[project]\nname = 'fixture'\nversion = '0.1.0'\n")
            (repo / "LICENSE").write_text("fixture\n")
            (repo / "README.md").write_text("fixture\n")
            catalog = root / "catalog"
            run(sys.executable, str(CATALOG), "generate", "--fixture", "--out", str(catalog))
            dist = root / "dist"
            binary = root / "unstripped"
            for target, alias in TARGETS:
                source = root / f"{alias}.c"
                source.write_text(f"int main(void) {{ return {len(alias)}; }}\n")
                run("gcc", "-g", "-Wl,--build-id", "-o", str(binary), str(source))
                shipped = root / alias / "prime-agent"
                decoder = dist / f"prime-agent-0.1.0-{alias}.debug.gz"
                run(sys.executable, str(SPLITTER), "--binary", str(binary),
                    "--shipped", str(shipped), "--out", str(dist),
                    "--version", "0.1.0", "--target", target)
                self.assertTrue(decoder.is_file())
                assemble = (sys.executable, str(ASSEMBLER), "--repo-root", str(repo),
                            "--version", "0.1.0", "--target", target,
                            "--binary", str(shipped), "--decoder", str(decoder),
                            "--catalog-assets", str(catalog), "--out-dir", str(dist))
                run(*assemble)
                if target == TARGETS[0][0]:
                    first_assemble = assemble
            manifest = json.loads((dist / "manifest.json").read_text())
            self.assertEqual({entry["target"] for entry in manifest["decoders"]},
                             {t for t, _ in TARGETS})
            self.assertEqual(len(manifest["binaries"]), 2)
            sums = (dist / "SHA256SUMS").read_text().splitlines()
            self.assertEqual(len(sums), 4)
            first_manifest = (dist / "manifest.json").read_bytes()
            first_sums = (dist / "SHA256SUMS").read_bytes()
            run(*first_assemble)
            self.assertEqual((dist / "manifest.json").read_bytes(), first_manifest)
            self.assertEqual((dist / "SHA256SUMS").read_bytes(), first_sums)
            incoming = root / "incoming" / "artifacts-both"
            incoming.mkdir(parents=True)
            for path in (dist / "manifest.json", dist / "SHA256SUMS", *dist.glob("*.tar.gz"), *dist.glob("*.debug.gz")):
                shutil.copy2(path, incoming / path.name)
            # Actual promotion uses one target per artifact. Test that each
            # merged row is independently valid after a shared-out-dir build.
            for target, _ in TARGETS:
                single = root / f"single-{target}" / f"artifacts-{target}"
                single.mkdir(parents=True)
                doc = json.loads((incoming / "manifest.json").read_text())
                doc["binaries"] = [b for b in doc["binaries"] if b["target"] == target]
                doc["decoders"] = [d for d in doc["decoders"] if d["target"] == target]
                (single / "manifest.json").write_text(json.dumps(doc))
                rows = [line for line in sums if any(line.endswith("  " + entry["file"])
                        for entry in doc["binaries"] + doc["decoders"])]
                (single / "SHA256SUMS").write_text("\n".join(rows) + "\n")
                for entry in doc["binaries"] + doc["decoders"]:
                    shutil.copy2(incoming / entry["file"], single / entry["file"])
                run(sys.executable, str(VERIFIER), str(single.parent))
            malformed = json.loads((dist / "manifest.json").read_text())
            duplicate = dict(malformed["decoders"][0])
            duplicate["sha256"] = "0" * 64
            malformed["decoders"].append(duplicate)
            (dist / "manifest.json").write_text(json.dumps(malformed))
            failed = run(*first_assemble, success=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("duplicate decoder target entries", failed.stderr)


if __name__ == "__main__":
    unittest.main()
