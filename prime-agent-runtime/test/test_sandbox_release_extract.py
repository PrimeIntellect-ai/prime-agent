"""Adversarial Phase 2 extraction tests."""

from __future__ import annotations

import hashlib
import io
import os
import shutil
import stat
import tarfile
import tempfile
import unittest
import zlib
from unittest.mock import patch

from rlm.sandbox_release_archive import (
    ArchiveErrorCode,
    ArchiveIdentity,
    Manifest,
    ManifestEntry,
    verify_archive,
)
from rlm.sandbox_release_extract import (
    ExtractArchiveFailure,
    ExtractArchiveSuccess,
    ExtractErrorCode,
    RuntimeRootCapability,
    _ExtractionSink,
    extract_verified_archive,
)

_CANDIDATE = "runtime-0123456789abcdef"
_SKILLS = ("agent-message", "agent-observe", "compact", "goal", "refine", "rlm-heartbeat")


def _elf() -> bytes:
    value = bytearray(64)
    value[0:4] = b"\x7fELF"
    value[4:8] = bytes((2, 1, 1, 0))
    value[16:18] = (3).to_bytes(2, "little")
    value[18:20] = (62).to_bytes(2, "little")
    value[20:24] = (1).to_bytes(4, "little")
    return bytes(value) + b"runtime"


def _release_entries(
    *, bad_elf: bool = False, missing: str | None = None, package_content: bytes = b"{}\n"
):
    entries = [
        {"name": ".", "type": "dir", "mode": 0o755},
        {"name": "install.sh", "type": "file", "mode": 0o755, "content": b"#!/bin/sh\n"},
        {"name": "package.json", "type": "file", "mode": 0o644, "content": package_content},
        {"name": "photon_rs_bg.wasm", "type": "file", "mode": 0o644, "content": b"wasm"},
        {"name": "prime-agent", "type": "file", "mode": 0o755, "content": b"bad" * 30 if bad_elf else _elf()},
        {"name": "prime-agent-runtime", "type": "dir", "mode": 0o755},
        {"name": "prime-agent-runtime/pyproject.toml", "type": "file", "mode": 0o644, "content": b"[project]\n"},
        {"name": "skills", "type": "dir", "mode": 0o755},
    ]
    for name in _SKILLS:
        entries.append({"name": f"skills/{name}", "type": "dir", "mode": 0o755})
        entries.append({"name": f"skills/{name}/SKILL.md", "type": "file", "mode": 0o644, "content": b"# Skill\n"})
    entries = [entry for entry in entries if entry["name"] != missing]
    root = entries[0]
    return [root, *sorted(entries[1:], key=lambda entry: entry["name"].encode("utf-8"))]


def _build(entries):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz", format=tarfile.USTAR_FORMAT) as archive:
        for entry in entries:
            if entry["type"] == "dir":
                name = "./" if entry["name"] == "." else entry["name"] + "/"
                info = tarfile.TarInfo(name)
                info.type = tarfile.DIRTYPE
                info.mode = entry["mode"]
                archive.addfile(info)
            else:
                content = entry["content"]
                info = tarfile.TarInfo(entry["name"])
                info.type = tarfile.REGTYPE
                info.mode = entry["mode"]
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
    compressed = raw.getvalue()
    inflater = zlib.decompressobj(wbits=31)
    tar_bytes = inflater.decompress(compressed) + inflater.flush()
    identity = ArchiveIdentity(hashlib.sha256(compressed).hexdigest(), len(compressed))
    manifest_entries = []
    total = 0
    for entry in entries:
        if entry["type"] == "dir":
            manifest_entries.append(ManifestEntry(entry["name"], "directory", "0755", 0, None))
        else:
            content = entry["content"]
            total += len(content)
            manifest_entries.append(ManifestEntry(
                entry["name"], "file", f"0{entry['mode']:o}", len(content), hashlib.sha256(content).hexdigest()
            ))
    manifest = Manifest(identity, tuple(manifest_entries), total, len(tar_bytes))
    return compressed, identity, manifest


class ExtractionCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.mkdtemp(prefix="release-extract-")
        os.chmod(self.temp, 0o700)
        self.parent_fd = os.open(self.temp, os.O_RDONLY | os.O_DIRECTORY)
        self.archive_path = os.path.join(self.temp, "archive.tar.gz")

    def tearDown(self) -> None:
        try:
            os.close(self.parent_fd)
        except OSError:
            pass
        shutil.rmtree(self.temp, ignore_errors=True)

    def fixture(self, **kwargs):
        compressed, identity, manifest = _build(_release_entries(**kwargs))
        with open(self.archive_path, "wb") as target:
            target.write(compressed)
        os.chmod(self.archive_path, 0o600)
        archive_fd = os.open(self.archive_path, os.O_RDONLY)
        return archive_fd, identity, manifest

    def extract(self, **kwargs):
        archive_fd, identity, manifest = self.fixture(**kwargs)
        try:
            return extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)

    def test_success_exact_tree_modes_and_capability(self) -> None:
        result = self.extract()
        self.assertIs(type(result), ExtractArchiveSuccess)
        self.assertIs(type(result.root), RuntimeRootCapability)
        self.assertTrue(result.root.verify())
        root = os.path.join(self.temp, _CANDIDATE)
        self.assertEqual(stat.S_IMODE(os.lstat(root).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(root, "prime-agent")).st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(root, "package.json")).st_mode), 0o644)
        with open(os.path.join(root, "package.json"), "rb") as package_file:
            self.assertEqual(package_file.read(), b"{}\n")
        self.assertTrue(result.root.close())
        self.assertFalse(result.root.verify())
        self.assertTrue(result.root.close())

    def test_required_entry_missing_rejects_before_claim(self) -> None:
        result = self.extract(missing="package.json")
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.REQUIRED_ENTRY_MISSING))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_bad_elf_is_removed(self) -> None:
        result = self.extract(bad_elf=True)
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.ELF_INVALID))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_candidate_collision_is_preserved(self) -> None:
        target = os.path.join(self.temp, _CANDIDATE)
        os.mkdir(target, 0o700)
        marker = os.path.join(target, "marker")
        with open(marker, "wb") as target_file:
            target_file.write(b"preserve")
        result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CANDIDATE_EXISTS))
        with open(marker, "rb") as target_file:
            self.assertEqual(target_file.read(), b"preserve")

    def test_parent_mode_rejected(self) -> None:
        os.chmod(self.temp, 0o755)
        result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.PARENT_BAD_MODE))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_short_pwrite_loops_to_completion(self) -> None:
        real = os.pwrite
        calls = 0
        def short(fd, data, offset):
            nonlocal calls
            calls += 1
            return real(fd, data[:3], offset)
        with patch("rlm.sandbox_release_extract.os.pwrite", side_effect=short):
            result = self.extract()
        self.assertIs(type(result), ExtractArchiveSuccess)
        self.assertGreater(calls, 10)
        self.assertTrue(result.root.close())

    def test_zero_pwrite_fails_and_cleans(self) -> None:
        with patch("rlm.sandbox_release_extract.os.pwrite", return_value=0):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.FILE_WRITE_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_oversize_pwrite_fails_and_cleans(self) -> None:
        with patch("rlm.sandbox_release_extract.os.pwrite", side_effect=lambda fd, data, offset: len(data) + 1):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.FILE_WRITE_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_throwing_pwrite_fails_and_cleans(self) -> None:
        with patch("rlm.sandbox_release_extract.os.pwrite", side_effect=RuntimeError("private")):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.FILE_WRITE_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_fchmod_fault_makes_cleanup_uncertain(self) -> None:
        with patch("rlm.sandbox_release_extract.os.fchmod", side_effect=OSError("private")):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_fsync_fault_makes_cleanup_uncertain(self) -> None:
        real = os.fsync
        calls = 0
        def fail_once(fd):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("private")
            return real(fd)
        with patch("rlm.sandbox_release_extract.os.fsync", side_effect=fail_once):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.SYNC_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_file_name_swap_refuses_cleanup(self) -> None:
        real = os.pwrite
        swapped = False
        def swap(fd, data, offset):
            nonlocal swapped
            if not swapped:
                swapped = True
                root = os.path.join(self.temp, _CANDIDATE)
                path = os.path.join(root, "install.sh")
                moved = os.path.join(root, "moved")
                os.rename(path, moved)
                os.symlink("moved", path)
            return real(fd, data, offset)
        with patch("rlm.sandbox_release_extract.os.pwrite", side_effect=swap):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue(os.path.islink(os.path.join(self.temp, _CANDIDATE, "install.sh")))

    def test_elf_prefix_buffer_is_erased(self) -> None:
        captured = []
        from rlm import sandbox_release_extract as module
        real = module._verify_elf
        def capture(prefix):
            captured.append(prefix)
            return real(prefix)
        with patch("rlm.sandbox_release_extract._verify_elf", side_effect=capture):
            result = self.extract()
        self.assertIs(type(result), ExtractArchiveSuccess)
        self.assertTrue(captured)
        self.assertTrue(all(value == 0 for value in captured[0]))
        self.assertTrue(result.root.close())

    def test_never_uses_immutable_pread(self) -> None:
        with patch("rlm.sandbox_release_archive.os.pread", side_effect=AssertionError("forbidden"), create=True):
            result = self.extract()
        self.assertIs(type(result), ExtractArchiveSuccess)
        self.assertTrue(result.root.close())

    def test_second_pass_rejects_compressed_identity_swap(self) -> None:
        archive_fd, identity, manifest = self.fixture()
        mutated = False
        def verify_then_mutate(fd, selected, selected_manifest):
            nonlocal mutated
            result = verify_archive(fd, selected, selected_manifest)
            writable = os.open(self.archive_path, os.O_WRONLY)
            try:
                written = os.pwrite(writable, b"\x01", 4)
                self.assertEqual(written, 1)
            finally:
                os.close(writable)
            mutated = True
            return result
        try:
            with patch(
                "rlm.sandbox_release_extract.verify_archive",
                side_effect=verify_then_mutate,
            ):
                result = extract_verified_archive(
                    archive_fd, self.parent_fd, _CANDIDATE, identity, manifest
                )
        finally:
            os.close(archive_fd)
        self.assertTrue(mutated)
        self.assertEqual(result, ExtractArchiveFailure(ArchiveErrorCode.DIGEST_MISMATCH))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_seal_revalidates_each_child_directory(self) -> None:
        real = _ExtractionSink._directory_stable
        skill_checks = 0
        def fail_final_skill_check(sink, record, expected_mode, **kwargs):
            nonlocal skill_checks
            result = real(sink, record, expected_mode, **kwargs)
            if record.path == "skills":
                skill_checks += 1
                if skill_checks == 2:
                    return False
            return result
        with patch.object(
            _ExtractionSink,
            "_directory_stable",
            new=fail_final_skill_check,
        ):
            result = self.extract()
        self.assertEqual(
            result,
            ExtractArchiveFailure(ExtractErrorCode.DIRECTORY_IDENTITY_CHANGED),
        )
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_late_archive_failure_still_cleans_with_open_directory_fds(self) -> None:
        from rlm import sandbox_release_extract as module
        with patch(
            "rlm.sandbox_release_extract._fstat_unchanged",
            return_value=module.ArchiveErrorCode.FD_IDENTITY_CHANGED,
        ):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(module.ArchiveErrorCode.FD_IDENTITY_CHANGED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_capability_owns_all_directory_fds_until_close(self) -> None:
        archive_fd, identity, manifest = self.fixture()
        real_open = os.open
        captured = []
        def capture_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            captured.append(fd)
            return fd
        try:
            with patch("rlm.sandbox_release_extract.os.open", side_effect=capture_open):
                result = extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)
        self.assertIs(type(result), ExtractArchiveSuccess)
        open_fds = []
        for fd in set(captured):
            try:
                os.fstat(fd)
                open_fds.append(fd)
            except OSError:
                pass
        self.assertGreater(len(open_fds), 2)
        self.assertTrue(result.root.close())
        for fd in set(captured):
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_capability_close_retains_failed_fd_for_retry(self) -> None:
        archive_fd, identity, manifest = self.fixture()
        real_open = os.open
        captured = []
        def capture_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            captured.append(fd)
            return fd
        try:
            with patch("rlm.sandbox_release_extract.os.open", side_effect=capture_open):
                result = extract_verified_archive(
                    archive_fd, self.parent_fd, _CANDIDATE, identity, manifest
                )
        finally:
            os.close(archive_fd)
        self.assertIs(type(result), ExtractArchiveSuccess)
        target = captured[0]
        real_close = os.close
        failed = False
        def fail_once(fd):
            nonlocal failed
            if fd == target and not failed:
                failed = True
                raise OSError("private")
            return real_close(fd)
        with patch("rlm.sandbox_release_extract.os.close", side_effect=fail_once):
            self.assertFalse(result.root.close())
        os.fstat(target)
        self.assertFalse(result.root.verify())
        self.assertTrue(result.root.close())
        with self.assertRaises(OSError):
            os.fstat(target)

    def test_large_file_is_written_in_bounded_chunks(self) -> None:
        real = os.pwrite
        largest = 0
        def observe(fd, data, offset):
            nonlocal largest
            largest = max(largest, len(data))
            return real(fd, data, offset)
        archive_fd, identity, manifest = self.fixture(package_content=b"x" * 200_000)
        try:
            with patch("rlm.sandbox_release_extract.os.pwrite", side_effect=observe):
                result = extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)
        self.assertIs(type(result), ExtractArchiveSuccess)
        self.assertLessEqual(largest, 65536)
        self.assertTrue(result.root.close())

    def test_root_mkdir_failure_has_no_claim(self) -> None:
        with patch("rlm.sandbox_release_extract.os.mkdir", side_effect=OSError("private")):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.DIRECTORY_CREATE_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_root_open_failure_removes_empty_claim(self) -> None:
        archive_fd, identity, manifest = self.fixture()
        try:
            with patch("rlm.sandbox_release_extract.os.open", side_effect=OSError("private")):
                result = extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.DIRECTORY_OPEN_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_first_file_open_failure_cleans(self) -> None:
        real = os.open
        calls = 0
        def fail_file(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("private")
            return real(*args, **kwargs)
        archive_fd, identity, manifest = self.fixture()
        try:
            with patch("rlm.sandbox_release_extract.os.open", side_effect=fail_file):
                result = extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.FILE_CREATE_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_one_close_fault_is_retried_during_cleanup(self) -> None:
        real = os.close
        calls = 0
        def fail_once(fd):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("private")
            return real(fd)
        with patch("rlm.sandbox_release_extract.os.close", side_effect=fail_once):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.FILE_CLOSE_FAILED))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_persistent_close_fault_is_cleanup_uncertain(self) -> None:
        archive_fd, identity, manifest = self.fixture()
        try:
            with patch("rlm.sandbox_release_extract.os.close", side_effect=OSError("private")):
                result = extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_parent_mode_swap_dominates_cleanup(self) -> None:
        real = os.pwrite
        changed = False
        def change_parent(fd, data, offset):
            nonlocal changed
            if not changed:
                changed = True
                os.chmod(self.temp, 0o755)
            return real(fd, data, offset)
        with patch("rlm.sandbox_release_extract.os.pwrite", side_effect=change_parent):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))
        os.chmod(self.temp, 0o700)

    def test_hardlink_swap_refuses_cleanup(self) -> None:
        real = os.pwrite
        linked = False
        def add_link(fd, data, offset):
            nonlocal linked
            if not linked:
                linked = True
                root = os.path.join(self.temp, _CANDIDATE)
                os.link(os.path.join(root, "install.sh"), os.path.join(root, "extra-link"))
            return real(fd, data, offset)
        with patch("rlm.sandbox_release_extract.os.pwrite", side_effect=add_link):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue(os.path.exists(os.path.join(self.temp, _CANDIDATE, "extra-link")))

    def test_required_mode_rejects_before_claim(self) -> None:
        entries = _release_entries()
        for entry in entries:
            if entry["name"] == "install.sh":
                entry["mode"] = 0o644
        compressed, identity, manifest = _build(entries)
        with open(self.archive_path, "wb") as target:
            target.write(compressed)
        os.chmod(self.archive_path, 0o600)
        archive_fd = os.open(self.archive_path, os.O_RDONLY)
        try:
            result = extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.REQUIRED_ENTRY_INVALID))
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_stat_failure_after_root_claim_leaves_for_home(self) -> None:
        real = os.stat
        calls = 0
        def fail_claim(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("private")
            return real(*args, **kwargs)
        with patch("rlm.sandbox_release_extract.os.stat", side_effect=fail_claim):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_child_directory_symlink_swap_is_cleanup_uncertain(self) -> None:
        real = os.mkdir
        swapped = False
        def swap_after_mkdir(*args, **kwargs):
            nonlocal swapped
            result = real(*args, **kwargs)
            name = args[0]
            if name == "prime-agent-runtime" and not swapped:
                swapped = True
                root = os.path.join(self.temp, _CANDIDATE)
                original = os.path.join(root, name)
                moved = os.path.join(root, "moved-directory")
                os.rename(original, moved)
                os.symlink("moved-directory", original)
            return result
        with patch("rlm.sandbox_release_extract.os.mkdir", side_effect=swap_after_mkdir):
            result = self.extract()
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.CLEANUP_UNCERTAIN))
        self.assertTrue(os.path.islink(os.path.join(self.temp, _CANDIDATE, "prime-agent-runtime")))

    def test_exact_cleanup_closes_all_extraction_fds(self) -> None:
        archive_fd, identity, manifest = self.fixture()
        real_open = os.open
        captured = []
        def capture_open(*args, **kwargs):
            fd = real_open(*args, **kwargs)
            captured.append(fd)
            return fd
        try:
            with patch("rlm.sandbox_release_extract.os.open", side_effect=capture_open):
                with patch("rlm.sandbox_release_extract.os.pwrite", return_value=0):
                    result = extract_verified_archive(archive_fd, self.parent_fd, _CANDIDATE, identity, manifest)
        finally:
            os.close(archive_fd)
        self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.FILE_WRITE_FAILED))
        for fd in captured:
            with self.assertRaises(OSError):
                os.fstat(fd)
        self.assertFalse(os.path.lexists(os.path.join(self.temp, _CANDIDATE)))

    def test_bad_candidate_rejects_without_claim(self) -> None:
        archive_fd, identity, manifest = self.fixture()
        try:
            for candidate in ("runtime", "../runtime-0123456789", "Runtime-0123456789abcdef", "a" * 65):
                result = extract_verified_archive(archive_fd, self.parent_fd, candidate, identity, manifest)
                self.assertEqual(result, ExtractArchiveFailure(ExtractErrorCode.BAD_CANDIDATE))
        finally:
            os.close(archive_fd)


if __name__ == "__main__":
    unittest.main()
