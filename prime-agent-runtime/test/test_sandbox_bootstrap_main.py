"""Tests for sandbox_bootstrap_main.  ResourceWarning as errors."""

from __future__ import annotations

import fcntl
import hashlib
import os
import shutil
import stat
import sys
import tempfile
import unittest
import warnings

from rlm.sandbox_bootstrap_main import main, _FdId, _Id, _Claim, _FdReg
from rlm.sandbox_bootstrap_main import _open_dir, _open_artifact, _pread, _hash
from rlm.sandbox_bootstrap_main import _remove_clm, _write_cfg, _check_pe, _env_ok
from rlm.sandbox_bootstrap_main import _verify_sp, _mk_ws, _mk_sb
from rlm.sandbox_bootstrap_main import _EXIT, _SP_PATH, _SAND_EXEC, _LAUNCH_JSON
from rlm.sandbox_bootstrap_main import _WORKSPACE, _SAND_DIR
from rlm.sandbox_release_archive import Manifest, ManifestEntry, ArchiveIdentity


class T(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter("error", ResourceWarning)
        self.t = tempfile.mkdtemp()
        os.chmod(self.t, 0o700)

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def _w(self, n, c=b"x", m=0o600):
        p = os.path.join(self.t, n)
        with open(p, "wb") as f:
            f.write(c)
        os.chmod(p, m)
        return p

    def _fd(self, n):
        return os.open(
            os.path.join(self.t, n),
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )

    def _dfd(self):
        return os.open(
            self.t,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )


class TestMain(T):
    def test_returns_91(self):
        self.assertEqual(main(), 91)

    def test_no_output(self):
        import io
        so, se = io.StringIO(), io.StringIO()
        old = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = so, se
        try:
            main()
        finally:
            sys.stdout, sys.stderr = old
        self.assertEqual(so.getvalue() + se.getvalue(), "")

    def test_no_raise(self):
        try:
            main()
        except BaseException:
            self.fail("raised")

    @unittest.skipUnless(sys.platform == "linux", "requires Linux")
    def test_tmp_mode_contract(self):
        reg = _FdReg()
        try:
            temporary = _open_dir(b"/tmp", reg)
            self.assertEqual(temporary.id.mode, 0o1777)
        finally:
            reg.close_all()

    def test_constants(self):
        self.assertEqual(_EXIT, 91)
        self.assertEqual(_SP_PATH, "/usr/bin/setpriv")
        self.assertEqual(
            _SAND_EXEC,
            "/opt/prime-agent-sandbox-v1/prime-agent-runtime-v1/prime-agent",
        )
        self.assertEqual(_LAUNCH_JSON, "prime-agent-launch.json")
        self.assertEqual(_WORKSPACE, "prime-agent-workspace-v1")
        self.assertEqual(_SAND_DIR, "prime-agent-sandbox-v1")


class TestFdReg(T):
    def test_release_unowned_noop(self):
        reg = _FdReg()
        r, w = os.pipe()
        reg.release(w)
        os.write(w, b"x")
        os.close(w)
        os.close(r)

    def test_release_once(self):
        reg = _FdReg()
        r, w = os.pipe()
        reg.take(w)
        reg.release(w)
        reg.release(w)
        os.close(r)

    def test_close_all(self):
        reg = _FdReg()
        r, w = os.pipe()
        reg.take(r)
        reg.take(w)
        reg.close_all()

    def test_duplicate_take_raises(self):
        reg = _FdReg()
        r, w = os.pipe()
        reg.take(w)
        with self.assertRaises(RuntimeError):
            reg.take(w)
        os.close(r)
        reg.release(w)


class TestFrozen(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter("error", ResourceWarning)

    def test_id_immutable(self):
        i = _Id(1, 2, 3, 4, 0o644, 1, 5)
        with self.assertRaises(AttributeError):
            i.dev = 99
        with self.assertRaises(AttributeError):
            i.ino = 99

    def test_claim_immutable(self):
        c = _Claim(1, 2, is_dir=True)
        with self.assertRaises(AttributeError):
            c.dev = 99
        with self.assertRaises(AttributeError):
            c.ino = 99
        with self.assertRaises(AttributeError):
            c.is_dir = False


class TestFdIdSnaps(T):
    def test_fd_ok(self):
        fd = self._fd(self._w("f"))
        try:
            self.assertTrue(_FdId(fd).fd_ok())
        finally:
            os.close(fd)

    def test_fd_not_ok_closed(self):
        fd = self._fd(self._w("fc"))
        s = _FdId(fd)
        os.close(fd)
        self.assertFalse(s.fd_ok())

    def test_name_ok(self):
        dfd = self._dfd()
        try:
            fd = self._fd(self._w("nk"))
            s = _FdId(fd)
            os.close(fd)
            self.assertTrue(s.name_ok(b"nk", dfd))
            self.assertFalse(s.name_ok(b"x", dfd))
        finally:
            os.close(dfd)

    def test_both(self):
        dfd = self._dfd()
        try:
            fd = self._fd(self._w("b"))
            s = _FdId(fd)
            self.assertTrue(s.both_ok(b"b", dfd))
        finally:
            os.close(fd)
            os.close(dfd)

    def test_name_fails_on_mutate(self):
        dfd = self._dfd()
        try:
            p = self._w("nm", b"before")
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            s = _FdId(fd)
            os.close(fd)
            with open(p, "wb") as f:
                f.write(b"after")
            self.assertFalse(s.name_ok(b"nm", dfd))
        finally:
            os.close(dfd)

    def test_open_dir_rejects_symlink(self):
        reg = _FdReg()
        t2 = tempfile.mkdtemp()
        try:
            os.mkdir(os.path.join(t2, "rl"), 0o755)
            os.symlink(os.path.join(t2, "rl"), os.path.join(t2, "lk"))
            with self.assertRaises(OSError):
                _open_dir(os.path.join(t2, "lk").encode(), reg)
        finally:
            shutil.rmtree(t2, ignore_errors=True)

    def test_open_artifact_rejects_symlink(self):
        dfd = self._dfd()
        reg = _FdReg()
        os.symlink("/etc/passwd", os.path.join(self.t, "link"))
        with self.assertRaises(OSError):
            _open_artifact(dfd, "link", 4096, reg)
        os.close(dfd)


class TestIO(T):
    def test_pread(self):
        p = self._w("pr", b"hello")
        fd = os.open(p, os.O_RDONLY)
        try:
            self.assertEqual(_pread(fd, 5), b"hello")
            with self.assertRaises(OSError):
                _pread(fd, 3)
        finally:
            os.close(fd)

    def test_hash(self):
        data = b"hash this"
        p = self._w("h", data)
        fd = os.open(p, os.O_RDONLY)
        try:
            self.assertEqual(
                _hash(fd, len(data)),
                hashlib.sha256(data).hexdigest(),
            )
        finally:
            os.close(fd)


class TestCleanup(T):
    def test_remove_file(self):
        dfd = self._dfd()
        p = self._w("f")
        st = os.stat(p, follow_symlinks=False)
        claim = _Claim(st.st_dev, st.st_ino, is_dir=False)
        _remove_clm(dfd, "f", claim)
        self.assertFalse(os.path.exists(p))
        os.close(dfd)

    def test_remove_dir(self):
        dfd = self._dfd()
        os.mkdir(os.path.join(self.t, "d"), 0o700)
        st = os.stat(os.path.join(self.t, "d"), follow_symlinks=False)
        claim = _Claim(st.st_dev, st.st_ino, is_dir=True)
        _remove_clm(dfd, "d", claim)
        self.assertFalse(os.path.exists(os.path.join(self.t, "d")))
        os.close(dfd)

    def test_remove_noop_on_type_mismatch(self):
        """_remove_clm must not remove a regular file when is_dir=True."""
        dfd = self._dfd()
        p = self._w("f")
        st = os.stat(p, follow_symlinks=False)
        claim = _Claim(st.st_dev, st.st_ino, is_dir=True)
        _remove_clm(dfd, "f", claim)
        self.assertTrue(os.path.exists(p))
        os.close(dfd)

    def test_remove_noop_on_dev_ino_mismatch(self):
        dfd = self._dfd()
        self._w("f")
        _remove_clm(dfd, "f", _Claim(0, 0, is_dir=False))
        self.assertTrue(os.path.exists(os.path.join(self.t, "f")))
        os.close(dfd)

    def test_remove_never_raises(self):
        _remove_clm(9999, "x", _Claim(0, 0, is_dir=False))

    def test_claim_matches_after_mutation(self):
        """_Claim captures only dev+ino, so mode/size mutations do not affect it."""
        dfd = self._dfd()
        p = os.path.join(self.t, _LAUNCH_JSON)
        fd = os.open(_LAUNCH_JSON, os.O_RDWR | os.O_CREAT | os.O_EXCL
                      | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        st = os.fstat(fd)
        claim = _Claim(st.st_dev, st.st_ino, is_dir=False)
        os.write(fd, b'{"test":1}')
        os.fsync(fd)
        os.fchmod(fd, 0o444)
        os.fsync(fd)
        os.close(fd)
        st2 = os.stat(p, follow_symlinks=False)
        self.assertEqual(st2.st_dev, claim.dev)
        self.assertEqual(st2.st_ino, claim.ino)
        self.assertEqual(stat.S_IMODE(st2.st_mode), 0o444)
        _remove_clm(dfd, _LAUNCH_JSON, claim)
        self.assertFalse(os.path.exists(p))
        os.close(dfd)



    def test_write_cfg_cleanup_on_existing_prevents_reuse(self):
        """Pre-existing file prevents O_EXCL from creating a new one."""
        dfd = self._dfd()
        self._w(_LAUNCH_JSON, b"existing")
        reg = _FdReg()
        with self.assertRaises(OSError):
            _write_cfg(dfd, b"data", reg)
        os.close(dfd)


class TestExactResultTypes(unittest.TestCase):
    """Verify unit-level type checks used in main()."""

    def setUp(self):
        warnings.simplefilter("error", ResourceWarning)

    def test_type_check_trust(self):
        from rlm.sandbox_bootstrap_trust import (
            DecodeTrustSuccess,
            DecodeTrustFailure,
            decode_bootstrap_trust,
        )
        s = decode_bootstrap_trust(
            b'{"protocol":"prime-sandbox-bootstrap-v1",'
            b'"archiveSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",'
            b'"archiveBytes":1024,'
            b'"manifestSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",'
            b'"manifestBytes":512,'
            b'"homePublicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}'
        )
        self.assertTrue(type(s) is DecodeTrustSuccess)
        f = decode_bootstrap_trust(b"{}")
        self.assertTrue(type(f) is DecodeTrustFailure)

    def test_type_check_manifest(self):
        from rlm.sandbox_release_manifest import (
            DecodeManifestSuccess,
            DecodeManifestFailure,
            decode_release_manifest,
        )
        from rlm.sandbox_release_archive import ArchiveIdentity
        aid = ArchiveIdentity(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            1024,
        )
        s = decode_release_manifest(
            b'{"manifestVersion":1,"version":"1.2.3","platform":"linux-x64",'
            b'"archive":"prime-agent-1.2.3-linux-x64.tar.gz",'
            b'"totalFiles":0,"totalDirectories":1,"totalSize":0,'
            b'"decompressedTarBytes":512,'
            b'"entries":[{"path":".","type":"directory","mode":"0755","size":0}]}',
            aid,
        )
        self.assertTrue(type(s) is DecodeManifestSuccess)
        f = decode_release_manifest(b"{}", aid)
        self.assertTrue(type(f) is DecodeManifestFailure)

    def test_type_check_extract(self):
        from rlm.sandbox_release_extract import (
            ExtractArchiveSuccess,
            ExtractArchiveFailure,
        )
        self.assertTrue(isinstance(ExtractArchiveSuccess, type))
        self.assertTrue(isinstance(ExtractArchiveFailure, type))


class TestCreatedEntries(T):
    @unittest.skipUnless(os.geteuid() == 0, "requires root")
    def test_write_cfg_is_readable_and_cleanup_claim_survives(self):
        dfd = self._dfd()
        reg = _FdReg()
        data = b'{"protocol":"test"}'
        try:
            snap, claim = _write_cfg(dfd, data, reg)
            self.assertEqual(_pread(snap.fd, snap.id.size), data)
            self.assertEqual(snap.id.mode, 0o444)
            flags = fcntl.fcntl(snap.fd, fcntl.F_GETFL)
            self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
            reg.release(snap.fd)
            _remove_clm(dfd, _LAUNCH_JSON, claim)
            self.assertFalse(os.path.exists(os.path.join(self.t, _LAUNCH_JSON)))
        finally:
            reg.close_all()
            os.close(dfd)

    @unittest.skipUnless(os.geteuid() == 0, "requires root")
    def test_workspace_final_identity_and_cleanup(self):
        dfd = self._dfd()
        reg = _FdReg()
        try:
            workspace, temporary, workspace_claim, temporary_claim = _mk_ws(dfd, reg)
            self.assertTrue(workspace.both_ok(_WORKSPACE.encode(), dfd))
            self.assertTrue(temporary.both_ok(b"tmp", workspace.fd))
            self.assertEqual(workspace.id.uid, 65534)
            self.assertEqual(temporary.id.uid, 65534)
            reg.release(temporary.fd)
            _remove_clm(workspace.fd, "tmp", temporary_claim)
            reg.release(workspace.fd)
            _remove_clm(dfd, _WORKSPACE, workspace_claim)
            self.assertFalse(os.path.exists(os.path.join(self.t, _WORKSPACE)))
        finally:
            reg.close_all()
            os.close(dfd)

    @unittest.skipUnless(os.geteuid() == 0, "requires root")
    def test_sandbox_directory_identity_and_cleanup(self):
        dfd = self._dfd()
        reg = _FdReg()
        try:
            sandbox, claim = _mk_sb(dfd, reg)
            self.assertTrue(sandbox.both_ok(_SAND_DIR.encode(), dfd))
            reg.release(sandbox.fd)
            _remove_clm(dfd, _SAND_DIR, claim)
            self.assertFalse(os.path.exists(os.path.join(self.t, _SAND_DIR)))
        finally:
            reg.close_all()
            os.close(dfd)


class TestCheckPE(T):
    def _man(self, e):
        return Manifest(ArchiveIdentity("a" * 64, 100), tuple(e), 100, 512)

    def test_valid(self):
        e = [
            ManifestEntry(".", "directory", "0755", 0, None),
            ManifestEntry(
                "prime-agent", "file", "0755", 100, "abcd" + "a" * 60
            ),
        ]
        self.assertEqual(_check_pe(self._man(e)), "abcd" + "a" * 60)

    def test_missing(self):
        e = [ManifestEntry(".", "directory", "0755", 0, None)]
        with self.assertRaises(OSError):
            _check_pe(self._man(e))

    def test_wrong_mode(self):
        e = [
            ManifestEntry(".", "directory", "0755", 0, None),
            ManifestEntry(
                "prime-agent", "file", "0644", 100, "abcd" + "a" * 60
            ),
        ]
        with self.assertRaises(OSError):
            _check_pe(self._man(e))


class TestEnv(T):
    def test_fails_on_non_linux(self):
        if sys.platform == "linux":
            self.skipTest("linux only")
        with self.assertRaises(OSError):
            _env_ok()


if __name__ == "__main__":
    unittest.main()
