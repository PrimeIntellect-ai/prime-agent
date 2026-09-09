"""Tests for bootstrap zipapp builder. ResourceWarning as errors."""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile


_BUILDER: str = os.path.normpath(os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "..", "scripts", "build-sandbox-bootstrap.py",
))


_FIXTURE: dict[str, str] = {
    "sandbox_release_archive.py": "# archive\ndef f(): pass\n",
    "sandbox_release_extract.py": "# extract\ndef g(): pass\n",
    "sandbox_release_manifest.py": "# manifest\ndef h(): pass\n",
    "sandbox_bootstrap_trust.py": "# trust\ndef t(): pass\n",
    "sandbox_bootstrap_main.py": "# main\ndef main(): return 0\n",
}


_EXPECTED: list[str] = [
    "__main__.py",
    "bootstrap_runtime/__init__.py",
    "bootstrap_runtime/sandbox_bootstrap_main.py",
    "bootstrap_runtime/sandbox_bootstrap_trust.py",
    "bootstrap_runtime/sandbox_release_archive.py",
    "bootstrap_runtime/sandbox_release_extract.py",
    "bootstrap_runtime/sandbox_release_manifest.py",
]


_FIXTURE_CRLF: dict[str, str] = {
    "sandbox_release_archive.py": "# archive\r\ndef f(): pass\r\n",
    "sandbox_release_extract.py": "# extract\r\ndef g(): pass\r\n",
    "sandbox_release_manifest.py": "# manifest\r\ndef h(): pass\r\n",
    "sandbox_bootstrap_trust.py": "# trust\r\ndef t(): pass\r\n",
    "sandbox_bootstrap_main.py": "# main\r\ndef main(): return 0\r\n",
}


def _make(root: str, sources: dict[str, str]) -> str:
    """Write sources under a synthetic repo tree and return root."""
    d = os.path.join(root, "prime-agent-runtime", "src", "rlm")
    os.makedirs(d)
    for n, c in sources.items():
        p = os.path.join(d, n)
        with open(p, "w") as fh:
            fh.write(c)
        os.chmod(p, 0o644)
    return root


def _run(root: str):
    """Run builder on *root*, return (result, output_path)."""
    out = os.path.join(root, "out", "b.pyz")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    r = subprocess.run(
        [sys.executable, _BUILDER, "--source-root", root, "--output", out],
        capture_output=True,
    )
    return r, out


def _builder_mod() -> object:
    """Import the builder module for unit-testing internal helpers."""
    import importlib.util as _iu
    s = _iu.spec_from_file_location("_builder_mod", _BUILDER)
    m = _iu.module_from_spec(s)
    s.loader.exec_module(m)
    return m


class TestBuilder(unittest.TestCase):
    """Deterministic bootstrap zipapp builder tests."""

    def setUp(self):
        warnings.simplefilter("error", ResourceWarning)
        self._tmp = tempfile.mkdtemp()
        self._root = _make(self._tmp, _FIXTURE)

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _build_ok(self):
        r, out = _run(self._root)
        self.assertEqual(r.returncode, 0)
        with open(out, "rb") as fh:
            return fh.read()

    def test_repeat_builds_byte_identical(self):
        r, out = _run(self._root)
        self.assertEqual(r.returncode, 0)
        with open(out, "rb") as fh:
            data1 = fh.read()
        os.unlink(out)
        r2, out2 = _run(self._root)
        self.assertEqual(r2.returncode, 0)
        with open(out2, "rb") as fh:
            data2 = fh.read()
        self.assertEqual(data1, data2)
        self.assertEqual(
            hashlib.sha256(data1).hexdigest(),
            hashlib.sha256(data2).hexdigest(),
        )

    def test_exact_seven_names(self):
        data = self._build_ok()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            self.assertEqual(zf.namelist(), _EXPECTED)

    def test_exact_source_bytes(self):
        data = self._build_ok()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            main_src = zf.read("__main__.py")
            self.assertEqual(
                main_src.decode(),
                '"""Bootstrap entry point for sandbox runtime."""\n'
                "from bootstrap_runtime.sandbox_bootstrap_main import main\n"
                "import sys\n"
                "sys.exit(main())\n",
            )
            self.assertEqual(
                zf.read("bootstrap_runtime/__init__.py"), b"",
            )
            self.assertEqual(
                zf.read("bootstrap_runtime/sandbox_bootstrap_main.py"),
                b"# main\ndef main(): return 0\n",
            )

    def test_crlf_bytes_preserved(self):
        tmp = tempfile.mkdtemp()
        try:
            root = _make(tmp, _FIXTURE_CRLF)
            r, out = _run(root)
            self.assertEqual(r.returncode, 0)
            with open(out, "rb") as fh:
                data = fh.read()
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                self.assertEqual(
                    zf.read(
                        "bootstrap_runtime/sandbox_bootstrap_main.py",
                    ),
                    b"# main\r\ndef main(): return 0\r\n",
                )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_large_file_chunked_read(self):
        """Verify a source >64 KiB (READ_CHUNK) is read correctly."""
        d = os.path.join(self._root, "prime-agent-runtime", "src", "rlm")
        p = os.path.join(d, "sandbox_bootstrap_main.py")
        with open(p, "w") as fh:
            fh.write("# large\ndef main(): return 0\n")
            fh.write("#" * (200 * 1024))
        data = self._build_ok()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            raw = zf.read("bootstrap_runtime/sandbox_bootstrap_main.py")
        self.assertGreater(len(raw), 64 * 1024)
        self.assertEqual(raw[:8], b"# large\n")

    def test_regular_file_metadata(self):
        data = self._build_ok()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(info.create_system, 3)
                self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(
                    info.external_attr, (stat.S_IFREG | 0o644) << 16,
                )

    def test_size_within_limits(self):
        data = self._build_ok()
        self.assertGreater(len(data), 0)
        self.assertLessEqual(len(data), 1024 * 1024)

    def test_silence_on_failure(self):
        r = subprocess.run(
            [sys.executable, _BUILDER,
             "--source-root", "rel", "--output", "/x/y"],
            capture_output=True,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")
        r = subprocess.run(
            [sys.executable, _BUILDER,
             "--source-root", "/nonexistent_x1",
             "--output", "/nonexistent_x2.pyz"],
            capture_output=True,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")

    def test_cleanup_claimed_identity_mismatch(self):
        """_cleanup_claimed must not unlink when dev/ino do not match."""
        mod = _builder_mod()
        tmp2 = tempfile.mkdtemp()
        try:
            legit = os.path.join(tmp2, "target")
            with open(legit, "w") as fh:
                fh.write("data")
            ls = os.lstat(legit)
            parent_fd = os.open(
                tmp2, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
            mod._cleanup_claimed(
                parent_fd, "target", ls.st_dev, ls.st_ino + 1,
            )
            os.close(parent_fd)
            self.assertTrue(os.path.isfile(legit))
            with open(legit) as fh:
                self.assertEqual(fh.read(), "data")
        finally:
            shutil.rmtree(tmp2, ignore_errors=True)

    def test_exclusive_output_refusal(self):
        self._build_ok()
        r, out = _run(self._root)
        self.assertEqual(r.returncode, 99)
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")

    def test_missing_source_rejected(self):
        os.unlink(os.path.join(
            self._root, "prime-agent-runtime", "src", "rlm",
            "sandbox_bootstrap_main.py",
        ))
        r, out = _run(self._root)
        self.assertEqual(r.returncode, 99)
        self.assertFalse(os.path.isfile(out))
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")

    def test_symlink_source_rejected(self):
        d = os.path.join(self._root, "prime-agent-runtime", "src", "rlm")
        t = os.path.join(d, "sandbox_bootstrap_main.py")
        os.unlink(t)
        os.symlink(os.path.join(d, "sandbox_release_archive.py"), t)
        r, out = _run(self._root)
        self.assertEqual(r.returncode, 99)
        self.assertFalse(os.path.isfile(out))
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")

    def test_oversized_source_rejected(self):
        d = os.path.join(self._root, "prime-agent-runtime", "src", "rlm")
        p = os.path.join(d, "sandbox_bootstrap_main.py")
        with open(p, "wb") as fh:
            fh.write(b"# " + b"x" * (512 * 1024))
        r, out = _run(self._root)
        self.assertEqual(r.returncode, 99)
        self.assertFalse(os.path.isfile(out))
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")

    def test_compile_failure_cleans_up(self):
        d = os.path.join(self._root, "prime-agent-runtime", "src", "rlm")
        p = os.path.join(d, "sandbox_bootstrap_main.py")
        with open(p, "w") as fh:
            fh.write("def main(: ")
        r, out = _run(self._root)
        self.assertEqual(r.returncode, 99)
        self.assertFalse(os.path.isfile(out))
        self.assertEqual(r.stdout, b"")
        self.assertEqual(r.stderr, b"")


if __name__ == "__main__":
    unittest.main()
