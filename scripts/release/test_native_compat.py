#!/usr/bin/env python3
"""Packaging and installer archive regressions.

Old-installer execution lives in test_legacy_upgrade.
"""

import argparse
import io
import json
import platform
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from assemble_artifacts import BUNDLED_CATALOG_FILES, pack_tarball, stage_tree
from native_compat import validate_compatibility_archive


class NativeCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "skills").mkdir()
        for name in ("LICENSE", "README.md"):
            (self.root / name).write_text("test fixture\n")
        runtime = self.root / "prime-agent-runtime"
        (runtime / "src/rlm").mkdir(parents=True)
        (runtime / "src/rlm/repl.py").write_text("# runtime fixture\n")
        (runtime / "pyproject.toml").write_text('[project]\nname = "fixture"\n')
        for name in BUNDLED_CATALOG_FILES:
            (self.root / name).write_text("{}\n")
        self.binary = self.root / "binary"
        self.binary.write_text("#!/bin/sh\nprintf '1.0.0\\n'\n")
        self.binary.chmod(0o755)

    def assemble(self, target="aarch64-apple-darwin", stamp=None):
        staging = self.root / "stage"
        staging.mkdir()
        args = argparse.Namespace(
            repo_root=self.root, target=target, binary=self.binary,
            runtime_dir=None, catalog_assets=self.root, version="1.0.0", sha="a" * 40,
        )
        # Catalog validation has its own integration suite; this test exercises
        # packaging with a minimal payload to isolate the migration regression.
        with patch("assemble_artifacts.validate_bundled_catalog_dir", return_value={}):
            facts = stage_tree(staging, args, stamp)
        archive = self.root / "release.tar.gz"
        pack_tarball(staging, archive, facts["payload"])
        return staging, archive, facts

    def test_stable_archive_satisfies_old_installer_contract(self):
        staging, archive, _ = self.assemble()
        validate_compatibility_archive(archive)
        self.assertEqual(json.loads((staging / "package.json").read_text())["version"], "1.0.0")
        self.assertEqual((staging / "prime-agent").read_bytes(), self.binary.read_bytes())
        repo = Path(__file__).resolve().parents[2]
        self.assertEqual((staging / "install.sh").read_bytes(), (repo / "install-rust.sh").read_bytes())

    def test_continuous_stamp_survives_compatibility_packaging(self):
        stamp = "1.0.0-continuous." + "a" * 40
        staging, archive, _ = self.assemble(stamp=stamp)
        validate_compatibility_archive(archive)
        self.assertEqual(json.loads((staging / "package.json").read_text())["version"], stamp)

    def test_missing_legacy_file_rejects_archive(self):
        staging, archive, facts = self.assemble()
        (staging / "theme/prime.json").unlink()
        pack_tarball(staging, archive, facts["payload"])
        with self.assertRaisesRegex(ValueError, "theme/prime.json"):
            validate_compatibility_archive(archive)

    def test_placeholder_wasm_rejects_archive(self):
        staging, archive, facts = self.assemble()
        (staging / "photon_rs_bg.wasm").write_bytes(b"placeholder")
        pack_tarball(staging, archive, facts["payload"])
        with self.assertRaisesRegex(ValueError, "Photon.*checksum"):
            validate_compatibility_archive(archive)

    def test_windows_retains_common_metadata_without_posix_legacy_assets(self):
        staging, archive, _ = self.assemble(target="x86_64-pc-windows-msvc")
        validate_compatibility_archive(archive)
        self.assertTrue((staging / "prime-agent.exe").is_file())
        self.assertFalse((staging / "photon_rs_bg.wasm").exists())

    def test_promotion_validates_native_archives_beside_source_distribution(self):
        _, archive, _ = self.assemble()
        repo = Path(__file__).resolve().parents[2]
        workflow = (repo / ".github/workflows/release.yml").read_text()
        step = workflow.split(
            "      - name: Verify historical native updater compatibility\n", 1
        )[1].split("      - name:", 1)[0]
        script = "\n".join(
            line[10:] for line in step.split("        run: |\n", 1)[1].splitlines()
        )
        native = self.root / "incoming/artifacts-native"
        source = self.root / "incoming/artifacts-source"
        native.mkdir(parents=True)
        source.mkdir()
        shutil.copyfile(archive, native / "prime-agent-1.0.0-darwin-arm64.tar.gz")
        source_archive = source / "prime-agent-1.0.0-src.tar.gz"
        with tarfile.open(source_archive, "w:gz") as tar:
            tar.add(self.root / "README.md", arcname="README.md")
        with self.assertRaisesRegex(ValueError, "missing regular compatibility asset"):
            validate_compatibility_archive(source_archive)
        verification = self.root / "verification-source/scripts"
        verification.mkdir(parents=True)
        (verification / "release").symlink_to(repo / "scripts/release", target_is_directory=True)
        result = subprocess.run(
            ["bash", "-c", script], cwd=self.root, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Native compatibility verified:", result.stdout)
        self.assertNotIn("src.tar.gz", result.stdout)


class InstallerArchiveSecurityTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux" and platform.machine() == "x86_64",
                         "exercises the Linux x64 archive installer")
    def test_archive_metadata_symlink_cannot_overwrite_file_outside_stage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix = root / "prefix"
            share = prefix / "share"
            share.mkdir(parents=True)
            victim = share / "victim.txt"
            victim.write_text("keep this")
            archive = root / "prime-agent-9.9.9-linux-x64.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                binary = b"#!/bin/sh\nprintf '9.9.9\\n'\n"
                member = tarfile.TarInfo("prime-agent")
                member.mode = 0o755
                member.size = len(binary)
                tar.addfile(member, io.BytesIO(binary))
                marker = tarfile.TarInfo(".prime-agent-install")
                marker.type = tarfile.SYMTYPE
                marker.linkname = "../victim.txt"
                tar.addfile(marker)

            fake_bin = root / "fake-bin"
            fake_bin.mkdir()
            uv = fake_bin / "uv"
            uv.write_text("#!/bin/sh\n[ \"$1 $2\" = 'python find' ] && printf '%s\\n' "
                          + shlex.quote(sys.executable) + "\n")
            uv.chmod(0o755)
            user = root / "user"
            user.mkdir()
            (root / "tmp").mkdir()
            env = {
                "PATH": f"{fake_bin}:/usr/bin:/bin",
                "HOME": str(user),
                "TMPDIR": str(root / "tmp"),
                "PRIME_AGENT_RUST_PREFIX": str(prefix),
                "PRIME_AGENT_UV_BIN_DIR": str(fake_bin),
                "PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL": "0",
                "PRIME_AGENT_INSTALLER_NONINTERACTIVE": "1",
                "PRIME_AGENT_INSTALLER_PLAIN": "1",
                "DO_NOT_TRACK": "1",
                "npm_config_prefix": str(root / "npm"),
            }
            installer = Path(__file__).resolve().parents[2] / "install-rust.sh"
            result = subprocess.run(["sh", str(installer), "--archive", str(archive)],
                                    env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(victim.read_text(), "keep this", result.stderr)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(list(share.glob("prime-agent.stage.*")), [])

            safe = root / "safe" / archive.name
            safe.parent.mkdir()
            with tarfile.open(safe, "w:gz") as tar:
                member = tarfile.TarInfo("prime-agent")
                member.mode = 0o755
                member.size = len(binary)
                tar.addfile(member, io.BytesIO(binary))
            installed = subprocess.run(["sh", str(installer), "--archive", str(safe)],
                                       env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(installed.returncode, 0, installed.stderr)
            self.assertEqual((share / "prime-agent/.prime-agent-install").read_text(),
                             "install-rust.sh channel stable\nversion 9.9.9\n")


if __name__ == "__main__":
    unittest.main()
