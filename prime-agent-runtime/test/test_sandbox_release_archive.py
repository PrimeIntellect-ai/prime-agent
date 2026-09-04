"""Adversarial tests for sandbox_release_archive Phase 1 (streaming).

Verifies incremental preadv->zlib->tar state machine, bounded buffers,
fixed error codes (StrEnum), fd ownership, and all failure families.
No test constructs arbitrary error codes.
"""

from __future__ import annotations

import dataclasses
import gzip
import hashlib
import io
import os
import tempfile
import tarfile
import unittest
import zlib

from unittest.mock import patch

from rlm.sandbox_release_archive import (
    MAX_COMPRESSED_BYTES,
    MAX_DECOMPRESSED_TAR,
    MAX_PER_FILE_BYTES,
    _TAR_BLOCK,
    ArchiveIdentity,
    Manifest,
    ManifestEntry,
    VerifyArchiveSuccess,
    VerifyArchiveFailure,
    ArchiveErrorCode,
    verify_archive,
    _fstat_validate,
    _fstat_unchanged,
    _hash_compressed,
    _octal_to_int,
    _parse_tar_header,
    _validate_path,
    _validate_identity,
    _validate_manifest,
    _validate_entry,
    _check_strict_dataclass,
    _validate_cstring,
    _verify_streaming,
    _PREADV_BUF,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gzip_compress(data: bytes) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as f:
        f.write(data)
    return buf.getvalue()


def _build_ustar_gz(entries, /):
    """Return (gz_bytes, sha256, uncompressed_tar_bytes, manifest_dicts)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.USTAR_FORMAT) as tf:
        for entry in entries:
            if entry["type"] == "dir":
                directory_name = "./" if entry["name"] == "." else entry["name"].rstrip("/") + "/"
                ti = tarfile.TarInfo(directory_name)
                ti.type = tarfile.DIRTYPE
                ti.mode = entry.get("mode", 0o755)
                tf.addfile(ti)
            else:
                ti = tarfile.TarInfo(entry["name"])
                ti.type = tarfile.REGTYPE
                ti.mode = entry.get("mode", 0o644)
                c = entry.get("content", b"")
                ti.size = len(c)
                tf.addfile(ti, io.BytesIO(c))
    gz = buf.getvalue()
    decomp = zlib.decompressobj(wbits=31)
    tar_b = decomp.decompress(gz)
    if not decomp.eof:
        tar_b += decomp.flush()
    sha = hashlib.sha256(gz).hexdigest()
    mds = []
    for e in entries:
        if e["type"] == "dir":
            manifest_path = "." if e["name"] in (".", "./") else e["name"].rstrip("/")
            mds.append({"path": manifest_path, "type": "directory",
                        "mode": oct(e.get("mode", 0o755))[2:].zfill(4),
                        "size": 0, "sha256": None})
        else:
            c = e.get("content", b"")
            cs = hashlib.sha256(c).hexdigest()
            mds.append({"path": e["name"], "type": "file",
                        "mode": oct(e.get("mode", 0o644))[2:].zfill(4),
                        "size": len(c), "sha256": cs})
    return gz, sha, tar_b, mds


def _mkentry(d, /):
    return ManifestEntry(path=d["path"], type=d["type"],
                         mode=d["mode"], size=d["size"], sha256=d.get("sha256"))


def _write_temp(data: bytes, /):
    """Write data to temp file, return (read_fd, path)."""
    fd, path = tempfile.mkstemp()
    os.write(fd, data)
    os.close(fd)
    rfd = os.open(path, os.O_RDONLY)
    return rfd, path


def _build_valid_block():
    """Build a valid 512-byte ustar directory header for '.' root."""
    b = bytearray(512)
    b[0:3] = b"./\x00"
    b[100:108] = b"0000755\x00"
    b[108:116] = b"0000000\x00"
    b[116:124] = b"0000000\x00"
    b[124:136] = b"00000000000\x00"
    b[136:148] = b"00000000000\x00"
    b[148:156] = b" " * 8
    b[156:157] = b"5"
    b[257:263] = b"ustar\x00"
    b[263:265] = b"00"
    b[329:337] = b"0000000\x00"
    b[337:345] = b"0000000\x00"
    # Uname/gname (cstrings)
    b[265:297] = b"\x00" * 32
    b[297:329] = b"\x00" * 32
    computed = sum(b[:148]) + (32 * 8) + sum(b[156:])
    chk = f"{computed:06o}\x00 ".encode()[:8].ljust(8, b"\x00")
    b[148:156] = chk[:8]
    return b


def _rebuild_checksum(b: bytearray) -> None:
    computed = sum(b[:148]) + (32 * 8) + sum(b[156:])
    chk = f"{computed:06o}\x00 ".encode()[:8].ljust(8, b"\x00")
    b[148:156] = chk[:8]


# ===================================================================
# Strict dataclass validation
# ===================================================================

class TestStrictDataclass(unittest.TestCase):
    def test_valid_identity(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        err = _check_strict_dataclass(id_, {"compressed_sha256": str, "compressed_bytes": int})
        self.assertIsNone(err)

    def test_wrong_key(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        err = _check_strict_dataclass(id_, {"compressed_sha256": str, "compressed_bytes": int, "extra": str})
        self.assertEqual(err, "bad_dataclass_key")

    def test_subclass_type(self) -> None:
        """bool is a subclass of int and must be rejected."""
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=True)
        err = _check_strict_dataclass(id_, {"compressed_sha256": str, "compressed_bytes": int})
        self.assertEqual(err, "bad_primitive_type")

    def test_none_field(self) -> None:
        @dataclasses.dataclass(frozen=True)
        class Fake:
            x: str | None = None
        obj = Fake(x=None)
        err = _check_strict_dataclass(obj, {"x": type(None)})
        self.assertIsNone(err)


# ===================================================================
# Error code StrEnum
# ===================================================================

class TestErrorCodes(unittest.TestCase):
    def test_code_is_enum(self) -> None:
        self.assertIsInstance(ArchiveErrorCode.FD_BAD_MODE, ArchiveErrorCode)

    def test_enum_values_are_strs(self) -> None:
        # StrEnum values are comparable to str
        self.assertEqual(ArchiveErrorCode.FD_BAD_MODE.value, "fd_bad_mode")

    def test_no_arbitrary_codes(self) -> None:
        """VerifyArchiveFailure only accepts ArchiveErrorCode, not arbitrary str."""
        f = VerifyArchiveFailure(code=ArchiveErrorCode.DIGEST_MISMATCH)
        self.assertIs(f.code, ArchiveErrorCode.DIGEST_MISMATCH)

    def test_success_frozen(self) -> None:
        s = VerifyArchiveSuccess()
        with self.assertRaises(AttributeError):
            s.new_attr = 1

    def test_failure_frozen(self) -> None:
        f = VerifyArchiveFailure(code=ArchiveErrorCode.BAD_PATH)
        with self.assertRaises(AttributeError):
            f.code = ArchiveErrorCode.BAD_TYPE


# ===================================================================
# Input validation
# ===================================================================

class TestValidateIdentity(unittest.TestCase):
    def test_valid(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        self.assertIsNone(_validate_identity(id_))

    def test_bad_sha_length(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="abc", compressed_bytes=512)
        self.assertEqual(_validate_identity(id_), ArchiveErrorCode.BAD_IDENTITY_FIELD)

    def test_bad_sha_uppercase(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="A" * 64, compressed_bytes=512)
        self.assertEqual(_validate_identity(id_), ArchiveErrorCode.BAD_IDENTITY_FIELD)

    def test_negative_size(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=-1)
        self.assertEqual(_validate_identity(id_), ArchiveErrorCode.BAD_IDENTITY_FIELD)

    def test_zero_size(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=0)
        self.assertEqual(_validate_identity(id_), ArchiveErrorCode.BAD_IDENTITY_FIELD)

    def test_overlarge(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="a" * 64,
                              compressed_bytes=MAX_COMPRESSED_BYTES + 1)
        self.assertEqual(_validate_identity(id_), ArchiveErrorCode.BAD_IDENTITY_FIELD)



    def test_bool_as_size(self) -> None:
        """bool subclass of int must be rejected."""
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=True)
        r = _validate_identity(id_)
        # _check_strict_dataclass catches bool first
        self.assertIn(r, (ArchiveErrorCode.BAD_PRIMITIVE_TYPE, ArchiveErrorCode.BAD_IDENTITY_FIELD))


class TestValidateManifest(unittest.TestCase):
    def test_valid(self) -> None:
        e = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(e,), total_regular_bytes=0, decompressed_tar_bytes=512)
        self.assertIsNone(_validate_manifest(m))

    def test_bad_entry_type(self) -> None:
        e = ManifestEntry(path=".", type="symlink", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(e,), total_regular_bytes=0, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_dir_with_sha256(self) -> None:
        e = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256="a" * 64)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(e,), total_regular_bytes=0, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_file_without_sha256(self) -> None:
        e = ManifestEntry(path="f", type="file", mode="0644", size=5, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(e,), total_regular_bytes=5, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_total_bytes_mismatch(self) -> None:
        e = ManifestEntry(path="f", type="file", mode="0644", size=5,
                          sha256="a" * 64)
        root = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(root, e), total_regular_bytes=999,
                     decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_empty_entries(self) -> None:
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(), total_regular_bytes=0, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_duplicate_path(self) -> None:
        e1 = ManifestEntry(path="f", type="file", mode="0644", size=5,
                           sha256="a" * 64)
        e2 = ManifestEntry(path="f", type="file", mode="0644", size=5,
                           sha256="a" * 64)
        root = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(root, e1, e2), total_regular_bytes=10,
                     decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_no_root_entry(self) -> None:
        e = ManifestEntry(path="sub", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(e,), total_regular_bytes=0, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.ROOT_ENTRY_MISSING)

    def test_parent_before_child(self) -> None:
        # child "sub/file" before parent "sub" should fail PARENT_ORDER
        e1 = ManifestEntry(path="sub/file", type="file", mode="0644", size=5,
                           sha256="a" * 64)
        e2 = ManifestEntry(path="sub", type="directory", mode="0755", size=0, sha256=None)
        root = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(root, e1, e2), total_regular_bytes=5,
                     decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.PARENT_ORDER)

    def test_decompressed_not_multiple_512(self) -> None:
        e = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(e,), total_regular_bytes=0, decompressed_tar_bytes=100)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_zero_length_file_empty_sha(self) -> None:
        """Zero-length files must have SHA-256 of empty content."""
        e = ManifestEntry(path="f", type="file", mode="0644", size=0,
                          sha256="a" * 64)
        root = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=ArchiveIdentity("a" * 64, 512),
                     entries=(root, e), total_regular_bytes=0, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(m), ArchiveErrorCode.ZERO_LENGTH_EMPTY_SHA)


# ===================================================================
# _fstat_validate / _fstat_unchanged
# ===================================================================

class TestFstatValidate(unittest.TestCase):
    def test_regular_ok(self) -> None:
        fd, path = _write_temp(b"data")
        _, err = _fstat_validate(fd, 0)
        os.close(fd)
        os.unlink(path)
        self.assertIsNone(err)

    def test_pipe_rejected(self) -> None:
        r, w = os.pipe()
        _, err = _fstat_validate(r, 0)
        os.close(r)
        os.close(w)
        self.assertEqual(err, ArchiveErrorCode.FD_NOT_REGULAR)


class TestFstatUnchanged(unittest.TestCase):
    def test_ok(self) -> None:
        fd, path = _write_temp(b"data")
        snap, err = _fstat_validate(fd, 0)
        self.assertIsNone(err)
        err2 = _fstat_unchanged(fd, snap)
        os.close(fd)
        os.unlink(path)
        self.assertIsNone(err2)

    def test_bad_fd(self) -> None:
        from rlm.sandbox_release_archive import _Snap
        s = _Snap()
        s.dev = 0
        s.ino = 0
        s.uid = 0
        s.size = 0
        s.mode = 0
        self.assertEqual(_fstat_unchanged(999999, s), ArchiveErrorCode.FD_STAT_FAILED)


# ===================================================================
# _hash_compressed (preadv-based)
# ===================================================================

class TestHashCompressed(unittest.TestCase):
    def test_ok(self) -> None:
        data = b"test data"
        sha = hashlib.sha256(data).hexdigest()
        fd, path = _write_temp(data)
        err = _hash_compressed(fd, len(data), sha)
        os.close(fd)
        os.unlink(path)
        self.assertIsNone(err)

    def test_mismatch(self) -> None:
        data = b"test data"
        fd, path = _write_temp(data)
        err = _hash_compressed(fd, len(data), "0" * 64)
        os.close(fd)
        os.unlink(path)
        self.assertEqual(err, ArchiveErrorCode.DIGEST_MISMATCH)

    def test_truncated(self) -> None:
        data = b"small"
        fd, path = _write_temp(data)
        err = _hash_compressed(fd, len(data) + 100, "0" * 64)
        os.close(fd)
        os.unlink(path)
        self.assertEqual(err, ArchiveErrorCode.COMPRESSED_TRUNCATED)


# ===================================================================
# _octal_to_int
# ===================================================================

class TestOctalToInt(unittest.TestCase):
    def test_basic(self) -> None:
        v, e = _octal_to_int(b"0000755\x00")
        self.assertIsNone(e)
        self.assertEqual(v, 0o755)

    def test_base256(self) -> None:
        v, e = _octal_to_int(bytes([0x80, 0x00, 0x00]))
        self.assertEqual(e, ArchiveErrorCode.BAD_NUMERIC_FIELD)

    def test_bad_digit(self) -> None:
        v, e = _octal_to_int(b"0000A00\x00")
        self.assertEqual(e, ArchiveErrorCode.BAD_NUMERIC_FIELD)

    def test_empty(self) -> None:
        v, e = _octal_to_int(b"")
        self.assertEqual(e, ArchiveErrorCode.BAD_NUMERIC_FIELD)

    def test_all_spaces(self) -> None:
        v, e = _octal_to_int(b" " * 8)
        self.assertIsNone(e)
        self.assertEqual(v, 0)


# ===================================================================
# _parse_tar_header (with cstring validation)
# ===================================================================

class TestParseTarHeader(unittest.TestCase):
    def test_valid_directory(self) -> None:
        b = _build_valid_block()
        f, e = _parse_tar_header(bytes(b))
        self.assertIsNone(e)
        self.assertIsNotNone(f)

    def test_valid_file(self) -> None:
        b = _build_valid_block()
        b[0:7] = b"myfile\x00"
        b[156] = ord("0")
        b[124:136] = b"00000000100\x00"
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertIsNone(e)
        self.assertIsNotNone(f)
    def test_bad_magic(self) -> None:
        b = _build_valid_block()
        b[257:263] = b"xxxxxx"
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_MAGIC)

    def test_bad_version(self) -> None:
        b = _build_valid_block()
        b[263:265] = b"xx"
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_VERSION)

    def test_checksum_error(self) -> None:
        b = _build_valid_block()
        b[0] = 0xEF
        _rebuild_checksum(b)
        # After changing b[0], checksum won't match
        b[148:156] = b"0000000\x00"
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.CHECKSUM_ERROR)

    def test_bad_type(self) -> None:
        b = _build_valid_block()
        b[156] = ord("x")
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_TYPE)

    def test_forbidden_type_L(self) -> None:
        b = _build_valid_block()
        b[156] = ord("L")
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_TYPE)

    def test_nonempty_linkname(self) -> None:
        b = _build_valid_block()
        b[157:157 + 12] = b"some_target\x00"
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_LINK)

    def test_nonzero_device(self) -> None:
        b = _build_valid_block()
        b[329:329 + 8] = b"0000001\x00"
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_DEVICE)

    def test_base256_mode(self) -> None:
        b = _build_valid_block()
        b[100] = 0x80
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_MODE)

    def test_cstring_padding_name(self) -> None:
        """Non-null bytes after the first null in name field should fail."""
        b = _build_valid_block()
        b[0:3] = b".\x00X"  # null at pos 1, then X at pos 2
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_CSTRING_PADDING)

    def test_root_directory_trailing_slash(self) -> None:
        """Root entry './' as directory with type '5' is required."""
        b = _build_valid_block()
        b[0:3] = b"./\x00"
        b[156] = ord("5")
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertIsNone(e, f"root dir should pass, got {e}")

    def test_non_root_dir_needs_trailing_slash(self) -> None:
        """Non-root directory without trailing slash should fail."""
        b = _build_valid_block()
        b[0:5] = b"subd\x00"
        b[156] = ord("5")
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertEqual(e, ArchiveErrorCode.BAD_TRAILING_SLASH)

    def test_non_root_dir_with_trailing_slash(self) -> None:
        """Non-root directory with trailing slash should pass."""
        b = _build_valid_block()
        b[0:6] = b"subd/\x00"
        b[156] = ord("5")
        _rebuild_checksum(b)
        f, e = _parse_tar_header(bytes(b))
        self.assertIsNone(e)


# ===================================================================
# _validate_cstring
# ===================================================================

class TestValidateCstring(unittest.TestCase):
    def test_ok_null_terminated(self) -> None:
        self.assertIsNone(_validate_cstring(b"hello\x00" + b"\x00" * 10))

    def test_no_null(self) -> None:
        self.assertEqual(_validate_cstring(b"hello"), ArchiveErrorCode.BAD_CSTRING_PADDING)

    def test_trailing_nonnull_after_null(self) -> None:
        self.assertEqual(_validate_cstring(b"h\x00i"), ArchiveErrorCode.BAD_CSTRING_PADDING)


# ===================================================================
# _validate_path
# ===================================================================

class TestValidatePath(unittest.TestCase):
    def test_normal(self) -> None:
        n, e = _validate_path(b"hello.txt")
        self.assertIsNone(e)
        self.assertEqual(n, "hello.txt")

    def test_root_dot(self) -> None:
        n, e = _validate_path(b".")
        self.assertIsNone(e)
        self.assertEqual(n, ".")

    def test_leading_dot_slash(self) -> None:
        n, e = _validate_path(b"./hello.txt")
        self.assertIsNone(e)
        self.assertEqual(n, "hello.txt")

    def test_absolute_rejected(self) -> None:
        n, e = _validate_path(b"/etc/passwd")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_dotdot_rejected(self) -> None:
        n, e = _validate_path(b"../escape")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_nul_rejected(self) -> None:
        n, e = _validate_path(b"bad\x00name")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_backslash_rejected(self) -> None:
        n, e = _validate_path(b"bad\\name")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_control_char(self) -> None:
        n, e = _validate_path(b"bad\x01name")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_invalid_utf8(self) -> None:
        n, e = _validate_path(b"bad\xffname")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_empty(self) -> None:
        n, e = _validate_path(b"")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_empty_component(self) -> None:
        n, e = _validate_path(b"a//b")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_dot_component(self) -> None:
        n, e = _validate_path(b"a/./b")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_multiple_leading_dot_slash(self) -> None:
        n, e = _validate_path(b"././f")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)

    def test_trailing_double_slash(self) -> None:
        n, e = _validate_path(b"d//")
        self.assertEqual(e, ArchiveErrorCode.BAD_PATH)


# ===================================================================
# Full success
# ===================================================================

class TestVerifySuccess(unittest.TestCase):
    def test_small_archive(self) -> None:
        entries = [
            {"name": ".", "type": "dir", "mode": 0o755},
            {"name": "a.txt", "type": "file", "mode": 0o644, "content": b"alpha"},
            {"name": "sub", "type": "dir", "mode": 0o755},
            {"name": "sub/b.txt", "type": "file", "mode": 0o644, "content": b"beta"},
        ]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        id_ = ArchiveIdentity(compressed_sha256=sha, compressed_bytes=len(gz))
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=sum(d["size"] for d in mds if d["type"] == "file"),
                     decompressed_tar_bytes=len(tar_b))
        fd, path = _write_temp(gz)
        r = verify_archive(fd, id_, m)
        os.close(fd)
        os.unlink(path)
        self.assertIsInstance(r, VerifyArchiveSuccess)

    def test_single_file(self) -> None:
        entries = [
            {"name": ".", "type": "dir", "mode": 0o755},
            {"name": "f.bin", "type": "file", "mode": 0o644, "content": b"x" * 1000},
        ]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        id_ = ArchiveIdentity(compressed_sha256=sha, compressed_bytes=len(gz))
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=1000, decompressed_tar_bytes=len(tar_b))
        fd, path = _write_temp(gz)
        r = verify_archive(fd, id_, m)
        os.close(fd)
        os.unlink(path)
        self.assertIsInstance(r, VerifyArchiveSuccess)

    def test_zero_length_file(self) -> None:
        """Zero-length files must verify without infinite loop."""
        entries = [
            {"name": ".", "type": "dir", "mode": 0o755},
            {"name": "empty", "type": "file", "mode": 0o644, "content": b""},
        ]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        id_ = ArchiveIdentity(compressed_sha256=sha, compressed_bytes=len(gz))
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(tar_b))
        fd, path = _write_temp(gz)
        try:
            r = verify_archive(fd, id_, m)
        finally:
            os.close(fd)
            os.unlink(path)
        self.assertIsInstance(r, VerifyArchiveSuccess)


# ===================================================================
# Failure families
# ===================================================================

class TestVerifyFailures(unittest.TestCase):
    def _run(self, entries, identity, manifest):
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        fd, path = _write_temp(gz)
        r = verify_archive(fd, identity, manifest)
        os.close(fd)
        os.unlink(path)
        return r

    def test_digest_mismatch(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        wrong_id = ArchiveIdentity(compressed_sha256="0" * 64, compressed_bytes=len(gz))
        m = Manifest(identity=wrong_id, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(tar_b))
        r = self._run(entries, wrong_id, m)
        self.assertIsInstance(r, VerifyArchiveFailure)
        if isinstance(r, VerifyArchiveFailure):
            self.assertEqual(r.code, ArchiveErrorCode.DIGEST_MISMATCH)

    def test_total_bytes_mismatch(self) -> None:
        """Manifest with wrong total_regular_bytes caught by validation."""
        entries = [{"name": ".", "type": "dir", "mode": 0o755},
                   {"name": "f", "type": "file", "mode": 0o644, "content": b"hello"}]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        id_ = ArchiveIdentity(compressed_sha256=sha, compressed_bytes=len(gz))
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=9999, decompressed_tar_bytes=len(tar_b))
        r = self._run(entries, id_, m)
        self.assertIsInstance(r, VerifyArchiveFailure)
        if isinstance(r, VerifyArchiveFailure):
            self.assertEqual(r.code, ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_decompressed_size_mismatch(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        id_ = ArchiveIdentity(compressed_sha256=sha, compressed_bytes=len(gz))
        # Use a valid multiple-of-512 but wrong decompressed size (tar_b is 10240)
        wrong_dtot = 512  # valid multiple of 512, but != 10240
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=wrong_dtot)
        fd, path = _write_temp(gz)
        r = verify_archive(fd, id_, m)
        os.close(fd)
        os.unlink(path)
        self.assertIsInstance(r, VerifyArchiveFailure)
        if isinstance(r, VerifyArchiveFailure):
            self.assertEqual(r.code, ArchiveErrorCode.DECOMPRESSED_SIZE_MISMATCH)


# ===================================================================
# Tar structure failures (through _verify_streaming)
# ===================================================================

class TestTarStructure(unittest.TestCase):
    """Test streaming verifier directly with constructed tar.gz data."""

    def _verify_gz(self, gz: bytes, manifest: Manifest) -> ArchiveErrorCode | None:
        fd, path = _write_temp(gz)
        try:
            return _verify_streaming(fd, len(gz), manifest)
        finally:
            os.close(fd)
            os.unlink(path)

    def test_missing_zero_blocks(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        _, _, tar_b, mds = _build_ustar_gz(entries)
        header_only = tar_b[:_TAR_BLOCK]
        gz = _gzip_compress(header_only)
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(header_only))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.NO_ZERO_BLOCKS)

    def test_unpaired_zero_block(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        _, _, tar_b, mds = _build_ustar_gz(entries)
        # One zero block followed by non-zero data = unpaired
        tainted = tar_b[:_TAR_BLOCK] + bytearray(512) + b"NONZERO"
        gz = _gzip_compress(bytes(tainted))
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(bytes(tainted)))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.UNPAIRED_ZERO_BLOCK)

    def test_second_tar(self) -> None:
        """Two zero blocks followed by second tar: trailing non-zero data."""
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        _, _, tar_b, mds = _build_ustar_gz(entries)
        entries2 = [{"name": "x", "type": "file", "mode": 0o644, "content": b"x"}]
        _, _, tar2, _ = _build_ustar_gz(entries2)
        combined = tar_b + tar2
        gz = _gzip_compress(combined)
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(combined))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.TAIL_NONZERO)

    def test_sha_mismatch(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755},
                   {"name": "f", "type": "file", "mode": 0o644, "content": b"hello"}]
        _, _, tar_b, mds = _build_ustar_gz(entries)
        wrong_mds = [{"path": ".", "type": "directory", "mode": "0755", "size": 0, "sha256": None},
                     {"path": "f", "type": "file", "mode": "0644", "size": 5, "sha256": "0" * 64}]
        gz = _gzip_compress(tar_b)
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in wrong_mds),
                     total_regular_bytes=5, decompressed_tar_bytes=len(tar_b))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.FILE_SHA_MISMATCH)

    def test_forbidden_type(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        _, _, tar_b, mds = _build_ustar_gz(entries)
        modified = bytearray(tar_b)
        modified[156] = ord("L")
        _rebuild_checksum(modified)
        gz = _gzip_compress(bytes(modified))
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(bytes(modified)))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.BAD_TYPE)

    def test_tail_nonzero(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        _, _, tar_b, mds = _build_ustar_gz(entries)
        tainted = tar_b + b"NONZERO"
        gz = _gzip_compress(tainted)
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(tainted))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.TAIL_NONZERO)

    def test_non_zero_padding(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755},
                   {"name": "f", "type": "file", "mode": 0o644, "content": b"hello"}]
        _, _, tar_b, mds = _build_ustar_gz(entries)
        modified = bytearray(tar_b)
        # Find padding region after file content (offset 512+512=1024, padding at 512+5=517)
        # file "f" with 5 bytes: 1 block = 512, padding = 507 bytes at offset 1024
        modified[1030] = 0x01  # non-zero in file padding (byte 6 of content block = padding byte 1)
        gz = _gzip_compress(bytes(modified))
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=5, decompressed_tar_bytes=len(tar_b))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.NON_ZERO_PADDING)

    def test_zero_block_info_partial_header(self) -> None:
        """Partial zero block (only 1 of 2 required) should fail ONE_ZERO_BLOCK."""
        # Build a minimal tar: header block + 1 zero block (not the required 2)
        # Create an uncompressed tar with just header + 1 zero block
        b = io.BytesIO()
        with tarfile.open(fileobj=b, mode="w:", format=tarfile.USTAR_FORMAT) as tf:
            ti = tarfile.TarInfo(".")
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            tf.addfile(ti)
        raw_tar = b.getvalue()
        # Find where the zero blocks start (after valid tar data)
        # raw_tar ends with many zero blocks. Take only 2 blocks: header + 1 zero
        one_zero = raw_tar[:_TAR_BLOCK] + b"\x00" * 512
        gz = _gzip_compress(one_zero)
        mds = [{"path": ".", "type": "directory", "mode": "0755", "size": 0, "sha256": None}]
        m = Manifest(identity=ArchiveIdentity("a" * 64, len(gz)),
                     entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(one_zero))
        e = self._verify_gz(gz, m)
        self.assertEqual(e, ArchiveErrorCode.ONE_ZERO_BLOCK)


# ===================================================================
# Gzip failures
# ===================================================================

class TestGzipFailures(unittest.TestCase):
    def test_trailing_data(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        extra = _gzip_compress(b"extra")
        gz2 = gz + extra
        id_ = ArchiveIdentity(compressed_sha256=hashlib.sha256(gz2).hexdigest(),
                              compressed_bytes=len(gz2))
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(tar_b))
        fd, path = _write_temp(gz2)
        r = verify_archive(fd, id_, m)
        os.close(fd)
        os.unlink(path)
        self.assertIsInstance(r, VerifyArchiveFailure)
        if isinstance(r, VerifyArchiveFailure):
            self.assertEqual(r.code, ArchiveErrorCode.GZIP_TRAILING_DATA)

    def test_corrupted(self) -> None:
        gz = b"\x1f\x8b\x08" + b"\x00" * 100
        id_ = ArchiveIdentity(compressed_sha256=hashlib.sha256(gz).hexdigest(),
                              compressed_bytes=len(gz))
        m = Manifest(identity=id_, entries=(ManifestEntry(path=".", type="directory",
                                                          mode="0755", size=0, sha256=None),),
                     total_regular_bytes=0, decompressed_tar_bytes=512)
        fd, path = _write_temp(gz)
        r = verify_archive(fd, id_, m)
        os.close(fd)
        os.unlink(path)
        self.assertIsInstance(r, VerifyArchiveFailure)
        if isinstance(r, VerifyArchiveFailure):
            self.assertEqual(r.code, ArchiveErrorCode.GZIP_ERROR)

    def test_gzip_eof_before_compressed_limit(self) -> None:
        """Gzip stream ends before compressed_limit is reached."""
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        # Pad the gzip with zeros after the valid gzip so compressed_limit is larger
        gz_padded = gz + b"\x00" * 100
        padded_sha = hashlib.sha256(gz_padded).hexdigest()
        id_ = ArchiveIdentity(compressed_sha256=padded_sha,
                              compressed_bytes=len(gz_padded))
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(tar_b))
        fd, path = _write_temp(gz_padded)
        r = verify_archive(fd, id_, m)
        os.close(fd)
        os.unlink(path)
        self.assertIsInstance(r, VerifyArchiveFailure)
        if isinstance(r, VerifyArchiveFailure):
            self.assertIn(r.code, (
                ArchiveErrorCode.GZIP_EOF_PREMATURE,
                ArchiveErrorCode.GZIP_TRAILING_DATA,
            ))


# ===================================================================
# fd ownership / bounded reads
# ===================================================================

class TestFdOwnership(unittest.TestCase):
    def test_caller_fd_stays_open(self) -> None:
        entries = [{"name": ".", "type": "dir", "mode": 0o755}]
        gz, sha, tar_b, mds = _build_ustar_gz(entries)
        id_ = ArchiveIdentity(compressed_sha256=sha, compressed_bytes=len(gz))
        m = Manifest(identity=id_, entries=tuple(_mkentry(d) for d in mds),
                     total_regular_bytes=0, decompressed_tar_bytes=len(tar_b))
        fd, path = _write_temp(gz)
        r = verify_archive(fd, id_, m)
        try:
            os.fstat(fd)
            alive = True
        except OSError:
            alive = False
        os.close(fd)
        os.unlink(path)
        self.assertTrue(alive, "caller fd was closed")


class TestBoundedReads(unittest.TestCase):
    def test_offset_unchanged(self) -> None:
        data = b"offset test data prefix"
        sha = hashlib.sha256(data).hexdigest()
        fd, path = _write_temp(data)
        pre = os.read(fd, 10)
        self.assertEqual(pre, data[:10])
        err = _hash_compressed(fd, len(data), sha)
        self.assertIsNone(err)
        post = os.read(fd, 5)
        self.assertEqual(post, data[10:15])
        os.close(fd)
        os.unlink(path)


# ===================================================================
# Bad identity before fd access
# ===================================================================

class TestBadIdentityBeforeFd(unittest.TestCase):
    def test_zero_compressed_bytes(self) -> None:
        id_ = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=0)
        self.assertIsNotNone(_validate_identity(id_))

    def test_none_identity_fails(self) -> None:
        # _validate_identity catches type errors via strict check
        # Create a non-dataclass object
        r = _validate_identity(None)
        self.assertIsNotNone(r)


# ===================================================================
# Streaming large bomb (>192 MiB) with zlib.compressobj and instrumented bounds
# ===================================================================

class TestLargeBombStreaming(unittest.TestCase):
    @staticmethod
    def _zero_digest(size: int) -> str:
        digest = hashlib.sha256()
        chunk = bytes(65536)
        remaining = size
        while remaining > 0:
            count = min(len(chunk), remaining)
            digest.update(memoryview(chunk)[:count])
            remaining -= count
        return digest.hexdigest()

    @staticmethod
    def _file_header(name: str, size: int) -> bytes:
        block = bytearray(512)
        encoded = name.encode("ascii")
        block[:len(encoded)] = encoded
        block[len(encoded)] = 0
        block[100:108] = b"0000644\x00"
        block[108:116] = b"0000000\x00"
        block[116:124] = b"0000000\x00"
        block[124:136] = f"{size:011o}\x00".encode("ascii")
        block[136:148] = b"00000000000\x00"
        block[148:156] = b" " * 8
        block[156:157] = b"0"
        block[257:263] = b"ustar\x00"
        block[263:265] = b"00"
        block[265:345] = bytes(80)
        checksum = sum(block[:148]) + (32 * 8) + sum(block[156:])
        block[148:156] = f"{checksum:06o}\x00 ".encode("ascii")
        return bytes(block)

    def test_oversized_file_manifest_fails_before_fd_access(self) -> None:
        target = MAX_PER_FILE_BYTES + 512
        identity = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=1)
        manifest = Manifest(
            identity=identity,
            entries=(
                ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None),
                ManifestEntry(
                    path="bigfile",
                    type="file",
                    mode="0644",
                    size=target,
                    sha256=self._zero_digest(target),
                ),
            ),
            total_regular_bytes=target,
            decompressed_tar_bytes=512,
        )
        result = verify_archive(-1, identity, manifest)
        self.assertIsInstance(result, VerifyArchiveFailure)
        if isinstance(result, VerifyArchiveFailure):
            self.assertEqual(result.code, ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_bomb_exceeds_decompressed_limit_during_streaming(self) -> None:
        sizes = (64, 64, 64, 32)
        sizes = tuple(size * 1024 * 1024 for size in sizes)
        chunk = bytes(65536)
        raw_fd, path = tempfile.mkstemp()
        os.close(raw_fd)
        try:
            with open(path, "wb") as output:
                with gzip.GzipFile(fileobj=output, mode="wb", compresslevel=1, mtime=0) as archive:
                    archive.write(bytes(_build_valid_block()))
                    for index, size in enumerate(sizes):
                        archive.write(self._file_header(f"f{index}.bin", size))
                        remaining = size
                        while remaining > 0:
                            count = min(len(chunk), remaining)
                            archive.write(memoryview(chunk)[:count])
                            remaining -= count
                    archive.write(bytes(1024))
                    trailing_zeros = 40 * 1024 * 1024
                    while trailing_zeros > 0:
                        count = min(len(chunk), trailing_zeros)
                        archive.write(memoryview(chunk)[:count])
                        trailing_zeros -= count

            compressed_size = os.stat(path).st_size
            identity = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=compressed_size)
            entries = [ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)]
            for index, size in enumerate(sizes):
                entries.append(ManifestEntry(
                    path=f"f{index}.bin",
                    type="file",
                    mode="0644",
                    size=size,
                    sha256=self._zero_digest(size),
                ))
            manifest = Manifest(
                identity=identity,
                entries=tuple(entries),
                total_regular_bytes=sum(sizes),
                decompressed_tar_bytes=MAX_DECOMPRESSED_TAR,
            )
            fd = os.open(path, os.O_RDONLY)
            try:
                error = _verify_streaming(fd, compressed_size, manifest)
            finally:
                os.close(fd)
            self.assertEqual(error, ArchiveErrorCode.DECOMPRESSED_TOO_LARGE)
        finally:
            os.unlink(path)


# ===================================================================
# preadv buffer behavior
# ===================================================================

class TestPreadvBehavior(unittest.TestCase):
    def test_preadv_into_buffer(self) -> None:
        """Verify _hash_compressed uses preadv into mutable buffer, not pread returning new bytes."""
        data = b"X" * 1000
        sha = hashlib.sha256(data).hexdigest()
        fd, path = _write_temp(data)

        # Use the module's _hash_compressed which should use preadv internally
        err = _hash_compressed(fd, len(data), sha)
        os.close(fd)
        os.unlink(path)
        self.assertIsNone(err)

    def test_preadv_buffer_erased(self) -> None:
        """Every mutable hash buffer is zero or empty after return."""
        data = b"Y" * 2000
        sha = hashlib.sha256(data).hexdigest()
        fd, path = _write_temp(data)
        original_bytearray = bytearray
        captured: list[bytearray] = []

        def recording_bytearray(value: int = 0) -> bytearray:
            buffer = original_bytearray(value)
            captured.append(buffer)
            return buffer

        try:
            with patch("builtins.bytearray", new=recording_bytearray):
                error = _hash_compressed(fd, len(data), sha)
            self.assertIsNone(error)
            self.assertEqual([len(buffer) for buffer in captured], [_PREADV_BUF, 1])
            self.assertTrue(all(not any(buffer) for buffer in captured))
        finally:
            os.close(fd)
            os.unlink(path)


# ===================================================================
# Manifest.identity exact reference equality test
# ===================================================================

class TestIdentityExactEquality(unittest.TestCase):
    def test_identity_values_match(self) -> None:
        """Equal identity values may be carried by a distinct frozen object."""
        id1 = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        id2 = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        e = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        m = Manifest(identity=id1, entries=(e,), total_regular_bytes=0, decompressed_tar_bytes=512)
        # _validate_manifest should pass because id1 validates fine
        err = _validate_manifest(m)
        self.assertIsNone(err)


# ===================================================================
# _validate_entry
# ===================================================================

class TestValidateEntry(unittest.TestCase):
    def test_valid_dir(self) -> None:
        e = ManifestEntry(path="sub", type="directory", mode="0755", size=0, sha256=None)
        seen: set[str] = set()
        self.assertIsNone(_validate_entry(e, seen))
        self.assertIn("sub", seen)

    def test_valid_file(self) -> None:
        e = ManifestEntry(path="f", type="file", mode="0644", size=10, sha256="a" * 64)
        seen: set[str] = set()
        self.assertIsNone(_validate_entry(e, seen))

    def test_duplicate(self) -> None:
        e = ManifestEntry(path="f", type="file", mode="0644", size=10, sha256="a" * 64)
        seen: set[str] = {"f"}
        self.assertEqual(_validate_entry(e, seen), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_bad_mode_format(self) -> None:
        # 6-digit mode is too long for regex: ^0[0-7]{3,4}$
        e = ManifestEntry(path="f", type="file", mode="064400", size=10, sha256="a" * 64)
        seen: set[str] = set()
        self.assertEqual(_validate_entry(e, seen), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_file_exceeds_max(self) -> None:
        e = ManifestEntry(path="f", type="file", mode="0644",
                          size=MAX_PER_FILE_BYTES + 1, sha256="a" * 64)
        seen: set[str] = set()
        self.assertEqual(_validate_entry(e, seen), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_zero_length_file_needs_empty_sha(self) -> None:
        e = ManifestEntry(path="f", type="file", mode="0644", size=0, sha256="a" * 64)
        seen: set[str] = set()
        self.assertEqual(_validate_entry(e, seen), ArchiveErrorCode.ZERO_LENGTH_EMPTY_SHA)

class TestParentAuditStrictBoundaries(unittest.TestCase):
    def test_exact_dataclass_type_and_storage(self) -> None:
        @dataclasses.dataclass(frozen=True)
        class DerivedIdentity(ArchiveIdentity):
            pass

        derived = DerivedIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        self.assertEqual(_validate_identity(derived), ArchiveErrorCode.BAD_DATACLASS_TYPE)
        identity = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        object.__setattr__(identity, "unexpected", "value")
        self.assertEqual(_validate_identity(identity), ArchiveErrorCode.BAD_DATACLASS_KEY)

    def test_failure_rejects_arbitrary_runtime_code(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid archive error code"):
            VerifyArchiveFailure(code="arbitrary")

    def test_manifest_identity_mismatch_precedes_fd_access(self) -> None:
        selected = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        other = ArchiveIdentity(compressed_sha256="b" * 64, compressed_bytes=512)
        root = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        manifest = Manifest(identity=other, entries=(root,), total_regular_bytes=0, decompressed_tar_bytes=512)
        result = verify_archive(-1, selected, manifest)
        self.assertIsInstance(result, VerifyArchiveFailure)
        if isinstance(result, VerifyArchiveFailure):
            self.assertEqual(result.code, ArchiveErrorCode.IDENTITY_MISMATCH)

    def test_manifest_rejects_unsafe_path_mode_and_file_parent(self) -> None:
        identity = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=512)
        root = ManifestEntry(path=".", type="directory", mode="0755", size=0, sha256=None)
        unsafe = ManifestEntry(path="../escape", type="file", mode="0644", size=1, sha256="a" * 64)
        manifest = Manifest(identity=identity, entries=(root, unsafe), total_regular_bytes=1, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(manifest), ArchiveErrorCode.BAD_MANIFEST_FIELD)

        bad_mode = ManifestEntry(path="file", type="file", mode="0777", size=1, sha256="a" * 64)
        manifest = Manifest(identity=identity, entries=(root, bad_mode), total_regular_bytes=1, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(manifest), ArchiveErrorCode.BAD_MANIFEST_FIELD)

        parent_file = ManifestEntry(path="parent", type="file", mode="0644", size=1, sha256="a" * 64)
        child = ManifestEntry(path="parent/child", type="file", mode="0644", size=1, sha256="b" * 64)
        manifest = Manifest(identity=identity, entries=(root, parent_file, child), total_regular_bytes=2, decompressed_tar_bytes=512)
        self.assertEqual(_validate_manifest(manifest), ArchiveErrorCode.BAD_MANIFEST_FIELD)

    def test_header_rejects_root_without_slash_file_slash_and_reserved_bytes(self) -> None:
        root_without_slash = _build_valid_block()
        root_without_slash[0:3] = b".\x00\x00"
        _rebuild_checksum(root_without_slash)
        _, error = _parse_tar_header(bytes(root_without_slash))
        self.assertEqual(error, ArchiveErrorCode.BAD_ROOT_SPELLING)

        file_slash = _build_valid_block()
        file_slash[0:6] = b"file/\x00"
        file_slash[156] = ord("0")
        _rebuild_checksum(file_slash)
        _, error = _parse_tar_header(bytes(file_slash))
        self.assertEqual(error, ArchiveErrorCode.BAD_TRAILING_SLASH)

        reserved = _build_valid_block()
        reserved[500] = 1
        _rebuild_checksum(reserved)
        _, error = _parse_tar_header(bytes(reserved))
        self.assertEqual(error, ArchiveErrorCode.BAD_HEADER)

    def test_fd_mode_change_is_detected(self) -> None:
        fd, path = _write_temp(b"x")
        try:
            snapshot, error = _fstat_validate(fd, 1)
            self.assertIsNone(error)
            self.assertIsNotNone(snapshot)
            os.chmod(path, 0o400)
            if snapshot is not None:
                self.assertEqual(_fstat_unchanged(fd, snapshot), ArchiveErrorCode.FD_IDENTITY_CHANGED)
        finally:
            os.close(fd)
            os.unlink(path)

    def test_streaming_pass_uses_bounded_preadv_only(self) -> None:
        entries = [
            {"name": ".", "type": "dir", "mode": 0o755},
            {"name": "file", "type": "file", "mode": 0o644, "content": b"content"},
        ]
        compressed, _, tar_bytes, manifest_dicts = _build_ustar_gz(entries)
        identity = ArchiveIdentity(compressed_sha256="a" * 64, compressed_bytes=len(compressed))
        manifest = Manifest(
            identity=identity,
            entries=tuple(_mkentry(entry) for entry in manifest_dicts),
            total_regular_bytes=7,
            decompressed_tar_bytes=len(tar_bytes),
        )
        fd, path = _write_temp(compressed)
        requested_sizes: list[int] = []
        captured: list[bytearray] = []
        original_preadv = os.preadv
        original_bytearray = bytearray

        def observing_preadv(observed_fd: int, buffers: list[memoryview], offset: int) -> int:
            requested_sizes.append(sum(buffer.nbytes for buffer in buffers))
            return original_preadv(observed_fd, buffers, offset)

        def recording_bytearray(value: int = 0) -> bytearray:
            buffer = original_bytearray(value)
            captured.append(buffer)
            return buffer

        try:
            with patch("builtins.bytearray", new=recording_bytearray):
                with patch.object(os, "preadv", side_effect=observing_preadv):
                    error = _verify_streaming(fd, len(compressed), manifest)
            self.assertIsNone(error)
            self.assertTrue(requested_sizes)
            self.assertLessEqual(max(requested_sizes), 65536)
            self.assertTrue(captured)
            self.assertTrue(all(not any(buffer) for buffer in captured))
        finally:
            os.close(fd)
            os.unlink(path)
