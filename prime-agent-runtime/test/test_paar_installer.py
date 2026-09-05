from __future__ import annotations

import ctypes
import hashlib
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import rlm.paar.paar_installer as installer
from rlm.paar.paar_installer import (
    InstallErrorCode,
    PaarInstallErr,
    PaarInstallOk,
    install_paar,
)
from rlm.paar.paar_manifest_codec import PaarEncodeResult, PaarOk, encode_paar_manifest

SOURCE = "0123456789abcdef0123456789abcdef01234567"


def _archive(file_values: list[tuple[str, int, bytes]]) -> tuple[bytes, PaarEncodeResult]:
    offset = 0
    files: list[dict[str, object]] = []
    payload = bytearray()
    for path, mode, content in sorted(file_values):
        files.append(
            {
                "path": path,
                "mode": mode,
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "offset": offset,
            }
        )
        payload.extend(content)
        offset += len(content)
    encoded_raw = encode_paar_manifest(SOURCE, "linux-x64", 7, 25, files)
    if not isinstance(encoded_raw, PaarOk) or not isinstance(encoded_raw.value, PaarEncodeResult):
        raise AssertionError(encoded_raw)
    encoded = encoded_raw.value
    return encoded.header + bytes(payload), encoded


def _expected(archive: bytes, encoded: PaarEncodeResult) -> dict[str, object]:
    return {
        "expected_archive_size": len(archive),
        "expected_archive_sha256": hashlib.sha256(archive).hexdigest(),
        "expected_build_id": encoded.manifest.buildId,
        "expected_source_commit": SOURCE,
        "expected_target": "linux-x64",
        "expected_protocol_name": "prime-agent.remote-host",
        "expected_protocol_version": 1,
        "expected_daemon_protocol_version": 7,
        "expected_daemon_schema_revision": 25,
    }


def _rename_for_test(old_fd: int, old_name: str, new_fd: int, new_name: str) -> None:
    os.rename(old_name, new_name, src_dir_fd=old_fd, dst_dir_fd=new_fd)


class PaarInstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.destination = self.root / "destination"
        self.destination.mkdir(mode=0o700)
        self.archive, self.encoded = _archive(
            [
                ("bin/runtime", 0o755, b"runtime-bytes"),
                ("lib/empty", 0o644, b""),
                ("lib/kernel.py", 0o644, b"print('kernel')\n"),
            ]
        )
        self.archive_path = self.root / "runtime.paar"
        self.archive_path.write_bytes(self.archive)
        self.expected = _expected(self.archive, self.encoded)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def install(self, **overrides: object) -> PaarInstallOk | PaarInstallErr:
        expected = dict(self.expected)
        expected.update(overrides)
        with mock.patch("rlm.paar.paar_installer._rename_no_replace", _rename_for_test):
            return install_paar(self.archive_path.as_posix(), self.destination.as_posix(), **expected)

    def staging_entries(self) -> list[str]:
        return sorted(path.name for path in self.destination.iterdir() if path.name.startswith(".prime-agent-staging-"))

    def test_installs_verified_nested_files_with_exact_modes(self) -> None:
        old_umask = os.umask(0o077)
        try:
            result = self.install()
        finally:
            os.umask(old_umask)
        self.assertEqual(result, PaarInstallOk(ok=True, value="INSTALL_OK"))
        final = self.destination / self.encoded.manifest.buildId
        self.assertEqual((final / "bin/runtime").read_bytes(), b"runtime-bytes")
        self.assertEqual((final / "lib/empty").read_bytes(), b"")
        self.assertEqual((final / "lib/kernel.py").read_bytes(), b"print('kernel')\n")
        self.assertEqual(stat.S_IMODE((final / "bin/runtime").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((final / "lib/kernel.py").stat().st_mode), 0o644)
        self.assertEqual(self.staging_entries(), [])

    def test_supports_short_reads_and_partial_writes(self) -> None:
        real_pread = os.pread
        real_write = os.write

        def short_read(fd: int, size: int, offset: int) -> bytes:
            return real_pread(fd, min(size, 3), offset)

        def short_write(fd: int, value: bytes) -> int:
            return real_write(fd, value[:2])

        with (
            mock.patch("rlm.paar.paar_installer.os.pread", side_effect=short_read),
            mock.patch("rlm.paar.paar_installer.os.write", side_effect=short_write),
        ):
            result = self.install()
        self.assertEqual(result, PaarInstallOk(ok=True, value="INSTALL_OK"))

    def test_rejects_wrong_archive_hash_before_staging(self) -> None:
        result = self.install(expected_archive_sha256="f" * 64)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_HASH))
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_rejects_complete_expected_tuple_mismatch(self) -> None:
        result = self.install(expected_daemon_schema_revision=26)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.MANIFEST_MISMATCH))
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_rejects_bool_as_integer_without_opening_archive(self) -> None:
        with mock.patch("rlm.paar.paar_installer.os.open") as opened:
            result = self.install(expected_archive_size=True)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.INPUT_INVALID))
        opened.assert_not_called()

    def test_rejects_archive_symlink(self) -> None:
        link = self.root / "archive-link"
        link.symlink_to(self.archive_path)
        result = install_paar(link.as_posix(), self.destination.as_posix(), **self.expected)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_OPEN))

    def test_rejects_destination_symlink(self) -> None:
        link = self.root / "destination-link"
        link.symlink_to(self.destination, target_is_directory=True)
        result = install_paar(self.archive_path.as_posix(), link.as_posix(), **self.expected)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.DEST_OPEN))

    def test_linux_publication_uses_renameat2_no_replace_and_errno(self) -> None:
        calls: list[tuple[object, ...]] = []

        def fail(*args: object) -> int:
            calls.append(args)
            ctypes.set_errno(17)
            return -1

        with mock.patch("rlm.paar.paar_installer._RENAMEAT2", fail):
            with self.assertRaises(OSError) as raised:
                installer._linux_rename_no_replace(3, "old", 4, "new")
        self.assertEqual(raised.exception.errno, 17)
        self.assertEqual(calls, [(3, b"old", 4, b"new", 1)])

    def test_refuses_existing_final_directory_and_removes_owned_staging(self) -> None:
        final = self.destination / self.encoded.manifest.buildId
        final.mkdir()
        marker = final / "marker"
        marker.write_text("preserve")

        def refuse(*_args: object) -> None:
            raise FileExistsError()

        with mock.patch("rlm.paar.paar_installer._rename_no_replace", refuse):
            result = install_paar(self.archive_path.as_posix(), self.destination.as_posix(), **self.expected)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.PUBLISH))
        self.assertEqual(marker.read_text(), "preserve")
        self.assertEqual(self.staging_entries(), [])

    def test_destination_fsync_failure_preserves_published_tree(self) -> None:
        real_fsync = os.fsync
        destination_inode = self.destination.stat().st_ino

        def fail_final_destination_fsync(fd: int) -> None:
            raw = os.fstat(fd)
            final = self.destination / self.encoded.manifest.buildId
            if raw.st_ino == destination_inode and final.exists():
                raise OSError("dest fsync failed")
            real_fsync(fd)

        with mock.patch("rlm.paar.paar_installer.os.fsync", side_effect=fail_final_destination_fsync):
            result = self.install()
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.DEST_FSYNC))
        self.assertTrue((self.destination / self.encoded.manifest.buildId / "bin/runtime").is_file())
        self.assertEqual(self.staging_entries(), [])

    def test_staging_close_uncertainty_after_publish_preserves_final_tree(self) -> None:
        original_close = installer._close
        injected = False

        def uncertain_final_directory_close(fd: int) -> bool:
            nonlocal injected
            raw = os.fstat(fd)
            final = self.destination / self.encoded.manifest.buildId
            closed = original_close(fd)
            if final.exists() and raw.st_ino == final.stat().st_ino and not injected:
                injected = True
                return False
            return closed

        with mock.patch("rlm.paar.paar_installer._close", side_effect=uncertain_final_directory_close):
            result = self.install()
        self.assertTrue(injected)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue((self.destination / self.encoded.manifest.buildId / "lib/kernel.py").is_file())

    def test_file_hash_failure_cleans_nested_staging_tree(self) -> None:
        mutated = bytearray(self.archive)
        mutated[-1] ^= 1
        self.archive_path.write_bytes(mutated)
        expected = dict(self.expected)
        expected["expected_archive_sha256"] = hashlib.sha256(mutated).hexdigest()
        with mock.patch("rlm.paar.paar_installer._rename_no_replace", _rename_for_test):
            result = install_paar(self.archive_path.as_posix(), self.destination.as_posix(), **expected)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.FILE_HASH))
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_write_failure_closes_file_and_cleans_staging(self) -> None:
        with mock.patch("rlm.paar.paar_installer.os.write", side_effect=OSError("write failed")):
            result = self.install()
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.FILE_WRITE))
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_output_close_uncertainty_dominates_and_other_handles_are_closed(self) -> None:
        archive_inode = self.archive_path.stat().st_ino
        real_close = os.close
        injected = False

        def uncertain_output_close(fd: int) -> None:
            nonlocal injected
            raw = os.fstat(fd)
            real_close(fd)
            if stat.S_ISREG(raw.st_mode) and raw.st_ino != archive_inode and not injected:
                injected = True
                raise OSError("uncertain close")

        with mock.patch("rlm.paar.paar_installer.os.close", side_effect=uncertain_output_close):
            result = self.install()
        self.assertTrue(injected)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.CLEANUP_UNCERTAIN))
        self.assertEqual(len(self.staging_entries()), 1)

    def test_staging_name_collision_is_preserved(self) -> None:
        staging = self.destination / f".prime-agent-staging-{self.encoded.manifest.buildId}"
        staging.mkdir()
        marker = staging / "foreign"
        marker.write_text("preserve")
        result = self.install()
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.STAGING_CREATE))
        self.assertEqual(marker.read_text(), "preserve")

    def test_root_close_uncertainty_prevents_success_and_preserves_publication(self) -> None:
        archive_inode = self.archive_path.stat().st_ino
        original_close = installer._close
        injected = False

        def uncertain_archive_close(fd: int) -> bool:
            nonlocal injected
            raw = os.fstat(fd)
            closed = original_close(fd)
            if raw.st_ino == archive_inode and not injected:
                injected = True
                return False
            return closed

        with mock.patch("rlm.paar.paar_installer._close", side_effect=uncertain_archive_close):
            result = self.install()
        self.assertTrue(injected)
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue((self.destination / self.encoded.manifest.buildId).is_dir())

    def test_archive_mutation_during_install_blocks_publication_and_cleans(self) -> None:
        original_write_file = installer._write_file
        mutated = False

        def mutate_after_file(*args: object, **kwargs: object) -> None:
            nonlocal mutated
            original_write_file(*args, **kwargs)
            if not mutated:
                with self.archive_path.open("r+b") as archive_file:
                    archive_file.seek(-1, os.SEEK_END)
                    value = archive_file.read(1)
                    archive_file.seek(-1, os.SEEK_END)
                    archive_file.write(bytes((value[0] ^ 1,)))
                    archive_file.flush()
                    os.fsync(archive_file.fileno())
                mutated = True

        with mock.patch("rlm.paar.paar_installer._write_file", side_effect=mutate_after_file):
            result = self.install()
        self.assertTrue(mutated)
        self.assertIn(
            result,
            (
                PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_IDENTITY),
                PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_HASH),
                PaarInstallErr(ok=False, error=InstallErrorCode.FILE_HASH),
            ),
        )
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_archive_size_change_is_rejected_before_reading(self) -> None:
        self.archive_path.write_bytes(self.archive + b"x")
        result = self.install()
        self.assertEqual(result, PaarInstallErr(ok=False, error=InstallErrorCode.ARCHIVE_IDENTITY))

    def test_directory_component_conflict_cleans_staging(self) -> None:
        original_mkdir = os.mkdir
        calls = 0

        def mkdir_with_conflict(path: str, mode: int = 0o777, *, dir_fd: int | None = None) -> None:
            nonlocal calls
            original_mkdir(path, mode, dir_fd=dir_fd)
            calls += 1
            if calls == 2 and dir_fd is not None:
                os.rmdir(path, dir_fd=dir_fd)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dir_fd)
                os.close(fd)

        with mock.patch("rlm.paar.paar_installer.os.mkdir", side_effect=mkdir_with_conflict):
            result = self.install()
        self.assertIn(
            result,
            (
                PaarInstallErr(ok=False, error=InstallErrorCode.DIRECTORY_CREATE),
                PaarInstallErr(ok=False, error=InstallErrorCode.CLEANUP_UNCERTAIN),
            ),
        )
        self.assertEqual(self.staging_entries(), [])


if __name__ == "__main__":
    unittest.main()
