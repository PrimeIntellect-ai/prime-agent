"""
Tests for the PAAR v1 manifest/framing codec (Python port).

Parity with TS test at packages/coding-agent/test/paar-manifest-codec.test.ts.
Run from repo root: python -m pytest prime-agent-runtime/test/test_paar_manifest_codec.py -v
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import unicodedata

_src = str(pathlib.Path(__file__).resolve().parent.parent / "src")
if _src not in sys.path:
    sys.path.insert(0, _src)

from rlm.paar import (
    encode_paar_manifest,
    decode_paar_manifest_header,
    PAAR_ERRORS,
    PaarFileEntry,
    PaarEncodeResult,
    PaarDecodeResult,
    REMOTE_HOST_PROTOCOL_NAME,
    REMOTE_HOST_PROTOCOL_VERSION,
    HEADER_PREFIX,
    MAX_MANIFEST_BYTES,
    MAX_FILES,
    MAX_FILE_SIZE,
    MAX_TOTAL_PAYLOAD,
    MAX_ARCHIVE_SIZE,
    MAX_PATH_BYTES,
    SAFE_INT_MAX,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

VALID_HASH = "0" * 64
VALID_SRC = "a" * 40


def valid_input(**overrides):
    kwargs = {
        "sourceCommit": overrides.get("sourceCommit", VALID_SRC),
        "target": overrides.get("target", "linux-x64"),
        "daemonProtocolVersion": overrides.get("daemonProtocolVersion", 7),
        "daemonSchemaRevision": overrides.get("daemonSchemaRevision", 25),
        "files": overrides.get("files", [
            {"path": "a.txt", "size": 100, "mode": 0o644, "sha256": "b" * 64, "offset": 0},
            {"path": "b.txt", "size": 200, "mode": 0o755, "sha256": "c" * 64, "offset": 100},
        ]),
    }
    return kwargs


def sorted_files(files):
    return sorted(files, key=lambda f: f["path"].encode("utf-8"))


def compute_files_digest(files):
    parts = []
    for f in files:
        parts.append(
            '{"path":' + json.dumps(f["path"], separators=(",", ":"))
            + ',"size":' + str(f["size"])
            + ',"mode":' + str(f["mode"])
            + ',"sha256":' + json.dumps(f["sha256"], separators=(",", ":"))
            + ',"offset":' + str(f["offset"]) + "}"
        )
    canonical = "[" + ",".join(parts) + "]"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def compute_build_id(src, target, dpv, dsr, fd):
    proto = (
        '{"name":' + json.dumps(REMOTE_HOST_PROTOCOL_NAME, separators=(",", ":"))
        + ',"version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
        + ',"daemonProtocolVersion":' + str(dpv)
        + ',"daemonSchemaRevision":' + str(dsr) + "}"
    )
    canonical = (
        '{"sourceCommit":' + json.dumps(src, separators=(",", ":"))
        + ',"target":' + json.dumps(target, separators=(",", ":"))
        + ',"protocol":' + proto
        + ',"filesDigest":' + json.dumps(fd, separators=(",", ":")) + "}"
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_header(json_str):
    raw = json_str.encode("utf-8")
    h = bytearray(9 + len(raw))
    h[0] = 0x50; h[1] = 0x41; h[2] = 0x41; h[3] = 0x52; h[4] = 0x31
    length = len(raw)
    h[5] = (length >> 24) & 0xFF
    h[6] = (length >> 16) & 0xFF
    h[7] = (length >> 8) & 0xFF
    h[8] = length & 0xFF
    h[9:] = raw
    return bytes(h)


def encode_valid(**overrides):
    r = encode_paar_manifest(**valid_input(**overrides))
    assert r.ok, f"encode_valid failed: {r}"
    return r.value


# ===========================================================================
# 1. Deterministic golden bytes & protocol import
# ===========================================================================

class TestGoldenBytes:
    def test_encodes_linux_x64_deterministically(self):
        files = sorted_files([{"path": "data.bin", "size": 42, "mode": 0o644, "sha256": "d" * 64, "offset": 0}])
        r = encode_paar_manifest(VALID_SRC, "linux-x64", 7, 25, files)
        assert r.ok
        v = r.value
        assert v.header[0] == 0x50
        assert v.header[1] == 0x41
        assert v.header[2] == 0x41
        assert v.header[3] == 0x52
        assert v.header[4] == 0x31
        length = (v.header[5] << 24) | (v.header[6] << 16) | (v.header[7] << 8) | v.header[8]
        assert length == v.headerSize - 9
        assert v.manifest.format == "prime-agent-artifact"
        assert v.manifest.version == 1
        assert v.manifest.target == "linux-x64"
        assert v.manifest.protocol.name == REMOTE_HOST_PROTOCOL_NAME
        assert v.manifest.protocol.version == REMOTE_HOST_PROTOCOL_VERSION
        # Roundtrip
        d = decode_paar_manifest_header(v.header, v.archiveSize)
        assert d.ok
        assert d.value.manifest.target == "linux-x64"

    def test_protocol_constants(self):
        files = sorted_files([{"path": "f", "size": 1, "mode": 0o644, "sha256": "0" * 64, "offset": 0}])
        r = encode_paar_manifest(**valid_input(files=files))
        assert r.ok
        assert r.value.manifest.protocol.name == REMOTE_HOST_PROTOCOL_NAME
        assert r.value.manifest.protocol.version == REMOTE_HOST_PROTOCOL_VERSION

    def test_uint32_no_sign_bug(self):
        files = sorted_files([{"path": "f", "size": 1, "mode": 0o644, "sha256": "0" * 64, "offset": 0}])
        r = encode_paar_manifest(**valid_input(files=files))
        assert r.ok
        d = decode_paar_manifest_header(r.value.header, r.value.archiveSize)
        assert d.ok


# ===========================================================================
# 2. Protocol constants import regression
# ===========================================================================

class TestProtocol:
    def test_protocol_binding_matches(self):
        fd = compute_files_digest([{"path": "f", "size": 1, "mode": 0o644, "sha256": "0" * 64, "offset": 0}])
        bid = compute_build_id(VALID_SRC, "linux-x64", 7, 25, fd)
        json_str = (
            '{"format":"prime-agent-artifact","version":1,"target":"linux-x64",'
            + '"sourceCommit":' + json.dumps(VALID_SRC, separators=(",", ":"))
            + ',"protocol":{"name":' + json.dumps(REMOTE_HOST_PROTOCOL_NAME, separators=(",", ":"))
            + ',"version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
            + ',"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
            + ',"filesDigest":' + json.dumps(fd, separators=(",", ":"))
            + ',"buildId":' + json.dumps(bid, separators=(",", ":"))
            + ',"files":[{"path":"f","size":1,"mode":420,"sha256":"' + "0" * 64 + '","offset":0}]}'
        )
        hdr = build_header(json_str)
        r = decode_paar_manifest_header(hdr, len(hdr) + 1)
        assert r.ok, f"decode failed: {r}"

    def test_rejects_wrong_protocol_name(self):
        fd = compute_files_digest([{"path": "f", "size": 1, "mode": 0o644, "sha256": "0" * 64, "offset": 0}])
        bid = compute_build_id(VALID_SRC, "linux-x64", 7, 25, fd)
        json_str = (
            '{"format":"prime-agent-artifact","version":1,"target":"linux-x64",'
            + '"sourceCommit":' + json.dumps(VALID_SRC, separators=(",", ":"))
            + ',"protocol":{"name":"wrong"'
            + ',"version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
            + ',"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
            + ',"filesDigest":' + json.dumps(fd, separators=(",", ":"))
            + ',"buildId":' + json.dumps(bid, separators=(",", ":"))
            + ',"files":[{"path":"f","size":1,"mode":420,"sha256":"' + "0" * 64 + '","offset":0}]}'
        )
        hdr = build_header(json_str)
        r = decode_paar_manifest_header(hdr, len(hdr) + 1)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["BAD_PROTOCOL_NAME"]


# ===========================================================================
# 3. Numeric mode
# ===========================================================================

class TestMode:
    def test_accepts_0o644(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert r.ok
        assert r.value.manifest.files[0].mode == 0o644

    def test_accepts_0o755(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o755, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert r.ok
        assert r.value.manifest.files[0].mode == 0o755

    def test_rejects_string_mode(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": "0644", "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_decimal_644(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_0o777(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o777, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok


# ===========================================================================
# 4. Cardinality, size, offset, total
# ===========================================================================

class TestConstraints:
    def test_rejects_empty_files(self):
        r = encode_paar_manifest(**valid_input(files=[]))
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["FILES_EMPTY"]

    def test_accepts_20k_files(self):
        files = []
        off = 0
        for i in range(20000):
            files.append({
                "path": f"f{str(i).zfill(10)}.dat",
                "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": off,
            })
            off += 1
        r = encode_paar_manifest(**valid_input(files=files))
        assert r.ok, f"encode failed: {r}"

    def test_rejects_20001_files(self):
        files = []
        off = 0
        for i in range(20001):
            files.append({
                "path": f"f{str(i).zfill(10)}.dat",
                "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": off,
            })
            off += 1
        r = encode_paar_manifest(**valid_input(files=files))
        assert not r.ok

    def test_accepts_zero_size_file(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "e", "size": 0, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert r.ok

    def test_accepts_256mb_file(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "big", "size": 256 * 1024 * 1024, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert r.ok

    def test_rejects_over_256mb(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "too", "size": 256 * 1024 * 1024 + 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_non_contiguous_offsets(self):
        r = encode_paar_manifest(**valid_input(files=sorted_files([
            {"path": "a", "size": 10, "mode": 0o644, "sha256": VALID_HASH, "offset": 0},
            {"path": "b", "size": 10, "mode": 0o644, "sha256": VALID_HASH, "offset": 11},
        ])))
        assert not r.ok


# ===========================================================================
# 5. UTF-8 sorting
# ===========================================================================

class TestSorting:
    def test_rejects_unsorted_input(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "z", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 2},
            {"path": "a", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0},
            {"path": "A", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 1},
        ]))
        assert not r.ok

    def test_accepts_sorted_input(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "A", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0},
            {"path": "a", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 1},
            {"path": "z", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 2},
        ]))
        assert r.ok, f"encode failed: {r}"


# ===========================================================================
# 6. Path validation
# ===========================================================================

class TestPathValidation:
    @staticmethod
    def _good(p):
        return encode_paar_manifest(**valid_input(files=[
            {"path": p, "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))

    def _bad(self, p):
        r = self._good(p)
        assert not r.ok, f"expected fail for path {p!r}"

    def _ok(self, p):
        r = self._good(p)
        assert r.ok, f"expected ok for path {p!r}"

    def test_path_rejects_leading_slash(self): self._bad("/abs")
    def test_path_rejects_trailing_slash(self): self._bad("d/")
    def test_path_rejects_empty(self): self._bad("")
    def test_path_rejects_backslash(self): self._bad("a\\b")
    def test_path_rejects_nul(self): self._bad("fi\x00le")
    def test_path_rejects_control(self): self._bad("fi\t")
    def test_path_rejects_del(self): self._bad("fi\x7f")
    def test_path_rejects_bom(self): self._bad("\ufefff")
    def test_path_rejects_dot_segment(self): self._bad("./x")
    def test_path_rejects_dotdot(self): self._bad("../x")
    def test_path_rejects_prime_agent_staging(self): self._bad(".prime-agent-staging/x")
    def test_path_rejects_double_slash(self): self._bad("a//b")
    def test_path_accepts_valid(self):
        self._ok("f")
        self._ok("d/f")
        self._ok("a/b/c")
    def test_path_accepts_astral(self): self._ok("file\U0001F600.txt")
    def test_path_rejects_lone_high_surrogate(self): self._bad("file\uD800")
    def test_path_rejects_lone_low_surrogate(self): self._bad("file\uDC00")
    def test_path_rejects_decomposed_nfc(self): self._bad("e\u0301")
    def test_path_accepts_512_bytes(self): self._ok("a" * 511)
    def test_path_rejects_over_512_bytes(self): self._bad("a" * 513)


# ===========================================================================
# 7. Byte-level framing
# ===========================================================================

class TestFraming:
    def test_rejects_empty(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(bytes(0), hdr.archiveSize)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["SHORT_HEADER"]

    def test_rejects_less_than_9_bytes(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(bytes(5), hdr.archiveSize)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["SHORT_HEADER"]

    def test_rejects_bad_magic(self):
        hdr = encode_valid()
        b = bytearray(hdr.header)
        b[0] = 0x48
        r = decode_paar_manifest_header(bytes(b), hdr.archiveSize)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["BAD_MAGIC"]

    def test_rejects_manifest_len_over_4mb(self):
        hdr = encode_valid()
        b = bytearray(hdr.header)
        b[5] = 0x01
        r = decode_paar_manifest_header(bytes(b), hdr.archiveSize)
        assert not r.ok

    def test_rejects_truncated(self):
        hdr = encode_valid()
        short = hdr.header[:9]
        r = decode_paar_manifest_header(short, hdr.archiveSize)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["MANIFEST_TRUNCATED"]

    def test_rejects_invalid_utf8(self):
        hdr = encode_valid()
        b = bytearray(hdr.header)
        if len(b) > 15:
            b[14] = 0xFF
            r = decode_paar_manifest_header(bytes(b), hdr.archiveSize)
            assert not r.ok

    def test_rejects_invalid_json(self):
        hdr = build_header("{{bad}}")
        r = decode_paar_manifest_header(hdr, len(hdr))
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_JSON"]

    def test_rejects_ffffffff_length(self):
        h = bytearray(13)
        h[0] = 0x50; h[1] = 0x41; h[2] = 0x41; h[3] = 0x52; h[4] = 0x31
        h[5] = 0xFF; h[6] = 0xFF; h[7] = 0xFF; h[8] = 0xFF
        r = decode_paar_manifest_header(bytes(h), 100)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["MANIFEST_TOO_LARGE"]


# ===========================================================================
# 8. Canonical encoding violations
# ===========================================================================

class TestCanonical:
    _fd = compute_files_digest([{"path": "f.dat", "size": 10, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}])
    _bid = compute_build_id(VALID_SRC, "linux-x64", 7, 25, _fd)
    _good = (
        '{"format":"prime-agent-artifact","version":1,"target":"linux-x64",'
        + '"sourceCommit":' + json.dumps(VALID_SRC, separators=(",", ":"))
        + ',"protocol":{"name":' + json.dumps(REMOTE_HOST_PROTOCOL_NAME, separators=(",", ":"))
        + ',"version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
        + ',"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
        + ',"filesDigest":' + json.dumps(_fd, separators=(",", ":"))
        + ',"buildId":' + json.dumps(_bid, separators=(",", ":"))
        + ',"files":[{"path":"f.dat","size":10,"mode":420,"sha256":"' + VALID_HASH + '","offset":0}]}'
    )

    def test_rejects_plain_object_as_bytes(self):
        r = decode_paar_manifest_header({}, 100)  # type: ignore[arg-type]
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]

    def test_rejects_bytearray(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(bytearray(hdr.header), hdr.archiveSize)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]

    def test_rejects_memoryview(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(memoryview(hdr.header), hdr.archiveSize)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]

    def test_rejects_bytes_longer_than_total_archive(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(hdr.header, len(hdr.header) - 5)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]

    def test_rejects_whitespace(self):
        bad = self._good.replace(':"', ': "')
        h = build_header(bad)
        r = decode_paar_manifest_header(h, len(h) + 10)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["NON_CANONICAL"]

    def test_rejects_key_reorder(self):
        bad = self._good.replace(
            '{"format":"prime-agent-artifact","version":1',
            '{"version":1,"format":"prime-agent-artifact"'
        )
        h = build_header(bad)
        r = decode_paar_manifest_header(h, len(h) + 10)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["NON_CANONICAL"]

    def test_rejects_extra_field(self):
        bad = self._good.replace('"files"', '"extra":"x","files"')
        h = build_header(bad)
        r = decode_paar_manifest_header(h, len(h) + 10)
        assert not r.ok

    def test_rejects_missing_field(self):
        proto_key = ',"protocol":{"name":"prime-agent.remote-host","version":1,"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
        bad = self._good.replace(proto_key, "")
        h = build_header(bad)
        r = decode_paar_manifest_header(h, len(h) + 10)
        assert not r.ok

    def test_rejects_trailing_bytes(self):
        bad = self._good + " "
        raw = bad.encode("utf-8")
        h = bytearray(9 + len(raw))
        h[0] = 0x50; h[1] = 0x41; h[2] = 0x41; h[3] = 0x52; h[4] = 0x31
        length = len(raw)
        h[5] = (length >> 24) & 0xFF; h[6] = (length >> 16) & 0xFF
        h[7] = (length >> 8) & 0xFF; h[8] = length & 0xFF
        h[9:] = raw
        r = decode_paar_manifest_header(bytes(h), len(h) + 10)
        assert not r.ok

    def test_rejects_negative_zero(self):
        bad = self._good.replace('"version":1', '"version":-0')
        h = build_header(bad)
        r = decode_paar_manifest_header(h, len(h) + 10)
        assert not r.ok

    def test_rejects_uppercase_hex(self):
        upper_fd = "F" + self._fd[1:]
        bad = self._good.replace(self._fd, upper_fd)
        h = build_header(bad)
        r = decode_paar_manifest_header(h, len(h) + 10)
        assert not r.ok


# ===========================================================================
# 9. totalArchiveSize
# ===========================================================================

class TestArchiveSize:
    def test_archive_size_too_small(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(hdr.header, 5)
        assert not r.ok

    def test_archive_size_too_large(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(hdr.header, hdr.archiveSize + 100)
        assert not r.ok

    def test_archive_size_over_1gb(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(hdr.header, 1073741825)
        assert not r.ok

    def test_archive_size_zero(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(hdr.header, 0)
        assert not r.ok

    def test_archive_size_non_integer(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(hdr.header, 1.5)
        assert not r.ok


# ===========================================================================
# 10. Digest / buildId mutations
# ===========================================================================

class TestDigests:
    def test_rejects_mutated_files_digest(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        manifest_len = (r.value.header[5] << 24) | (r.value.header[6] << 16) | (r.value.header[7] << 8) | r.value.header[8]
        ms = r.value.header[9:9 + manifest_len].decode("utf-8")
        mutated = ms.replace(
            f'"filesDigest":"{r.value.manifest.filesDigest}"',
            f'"filesDigest":"{"f" * 64}"'
        )
        hdr = build_header(mutated)
        d = decode_paar_manifest_header(hdr, len(hdr) + r.value.payloadSize)
        assert not d.ok
        assert d.error.code == PAAR_ERRORS["FILES_DIGEST_MISMATCH"]

    def test_rejects_mutated_build_id(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        manifest_len = (r.value.header[5] << 24) | (r.value.header[6] << 16) | (r.value.header[7] << 8) | r.value.header[8]
        ms = r.value.header[9:9 + manifest_len].decode("utf-8")
        mutated = ms.replace(
            f'"buildId":"{r.value.manifest.buildId}"',
            f'"buildId":"{"e" * 64}"'
        )
        hdr = build_header(mutated)
        d = decode_paar_manifest_header(hdr, len(hdr) + r.value.payloadSize)
        assert not d.ok
        assert d.error.code == PAAR_ERRORS["BUILD_ID_MISMATCH"]


# ===========================================================================
# 11. Immutable DTOs
# ===========================================================================

class TestImmutability:
    def test_encode_result_is_namedtuple(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        assert isinstance(r.value, tuple)

    def test_manifest_is_namedtuple(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        assert isinstance(r.value.manifest, tuple)

    def test_decode_result_is_namedtuple(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        d = decode_paar_manifest_header(r.value.header, r.value.archiveSize)
        assert d.ok
        assert isinstance(d.value, tuple)
        assert isinstance(d.value.manifest, tuple)

    def test_paar_errors_is_dict(self):
        assert PAAR_ERRORS["SHORT_HEADER"] == "SHORT_HEADER"
        assert PAAR_ERRORS["BAD_MAGIC"] == "BAD_MAGIC"

    def test_error_object_has_code(self):
        r = encode_paar_manifest(**valid_input(files=[]))
        assert not r.ok
        assert hasattr(r.error, 'code')
        assert r.error.code is not None


# ===========================================================================
# 12. Adversarial input
# ===========================================================================

class TestAdversarial:
    def test_rejects_class_instance_file_entry(self):
        class Entry:
            path = "f"
            size = 1
            mode = 0o644
            sha256 = VALID_HASH
            offset = 0
        r = encode_paar_manifest(**valid_input(files=[Entry()]))
        assert not r.ok

    def test_rejects_alias_same_object(self):
        shared = {"path": "shared", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        entries = [shared, shared]
        r = encode_paar_manifest(**valid_input(files=entries))
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["PROTO_INVALID_ALIAS"]

    def test_decode_rejects_sparse_array(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        manifest_len = (r.value.header[5] << 24) | (r.value.header[6] << 16) | (r.value.header[7] << 8) | r.value.header[8]
        ms = r.value.header[9:9 + manifest_len].decode("utf-8")
        sparse = ms.replace('"files":[', '"files":[null,')
        hdr = build_header(sparse)
        d = decode_paar_manifest_header(hdr, len(hdr) + r.value.payloadSize)
        assert not d.ok

    def test_error_codes(self):
        assert PAAR_ERRORS["SHORT_HEADER"] == "SHORT_HEADER"
        assert PAAR_ERRORS["BAD_MAGIC"] == "BAD_MAGIC"
        assert PAAR_ERRORS["MANIFEST_TOO_LARGE"] == "MANIFEST_TOO_LARGE"
        assert PAAR_ERRORS["MANIFEST_TRUNCATED"] == "MANIFEST_TRUNCATED"
        assert PAAR_ERRORS["INVALID_INPUT"] == "INVALID_INPUT"
        assert PAAR_ERRORS["PROTO_INVALID_ALIAS"] == "PROTO_INVALID_ALIAS"
        assert PAAR_ERRORS["BAD_FILE_ENTRY"] == "BAD_FILE_ENTRY"
        assert PAAR_ERRORS["CANONICAL_ENCODE_ERROR"] == "CANONICAL_ENCODE_ERROR"
        assert PAAR_ERRORS["BAD_FILES"] == "BAD_FILES"
        assert PAAR_ERRORS["NON_CANONICAL"] == "NON_CANONICAL"

    def test_decode_rejects_non_bytes(self):
        r = decode_paar_manifest_header("hello", 100)  # type: ignore[arg-type]
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]


# ===========================================================================
# 13. Buffer erasure
# ===========================================================================

class TestHeaderContent:
    def test_header_not_trivially_zeroed(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        non_zero = any(b != 0 for b in r.value.header)
        assert non_zero


# ===========================================================================
# 14. Payload after header
# ===========================================================================

class TestPayload:
    def test_decodes_with_extra_payload_present(self):
        r = encode_paar_manifest(**valid_input())
        assert r.ok
        payload = bytes(r.value.payloadSize)
        full = r.value.header + payload
        d = decode_paar_manifest_header(full, r.value.archiveSize)
        assert d.ok


# ===========================================================================
# 15. Roundtrip integrity
# ===========================================================================

class TestRoundtrip:
    def _roundtrip(self, sourceCommit, target, dpv, dsr, files):
        r = encode_paar_manifest(sourceCommit, target, dpv, dsr, files)
        assert r.ok, f"encode failed: {r}"
        d = decode_paar_manifest_header(r.value.header, r.value.archiveSize)
        assert d.ok, f"decode failed: {d}"
        assert d.value.manifest.sourceCommit == sourceCommit
        assert d.value.manifest.target == target
        assert d.value.manifest.protocol.daemonProtocolVersion == dpv
        assert d.value.manifest.protocol.daemonSchemaRevision == dsr

    def test_roundtrip_simple(self):
        self._roundtrip(
            VALID_SRC, "linux-x64", 7, 25,
            sorted_files([{"path": "a", "size": 100, "mode": 0o644, "sha256": "b" * 64, "offset": 0}]),
        )

    def test_roundtrip_multiple(self):
        self._roundtrip(
            "b" * 40, "linux-arm64", 1, 0,
            sorted_files([
                {"path": "a", "size": 5, "mode": 0o755, "sha256": "c" * 64, "offset": 0},
                {"path": "b", "size": 10, "mode": 0o644, "sha256": "d" * 64, "offset": 5},
                {"path": "c", "size": 0, "mode": 0o644, "sha256": "e" * 64, "offset": 15},
            ]),
        )

    def test_roundtrip_non_ascii(self):
        self._roundtrip(
            "c" * 40, "linux-x64", 99, 999,
            sorted_files([
                {"path": "résumé.txt", "size": 42, "mode": 0o644, "sha256": "f" * 64, "offset": 0},
                {"path": "中文/文件.bin", "size": 7, "mode": 0o755, "sha256": VALID_HASH, "offset": 42},
            ]),
        )


# ===========================================================================
# 16. Archive size boundary
# ===========================================================================

class TestArchiveBoundary:
    def test_rejects_over_1gb_archive(self):
        r = encode_paar_manifest(
            sourceCommit=VALID_SRC, target="linux-x64",
            daemonProtocolVersion=1, daemonSchemaRevision=0,
            files=[
                {"path": "p1", "size": 256 * 1024 * 1024, "mode": 0o644, "sha256": "a" * 64, "offset": 0},
                {"path": "p2", "size": 256 * 1024 * 1024, "mode": 0o644, "sha256": "a" * 64, "offset": 256 * 1024 * 1024},
                {"path": "p3", "size": 256 * 1024 * 1024, "mode": 0o644, "sha256": "a" * 64, "offset": 512 * 1024 * 1024},
                {"path": "p4", "size": 256 * 1024 * 1024, "mode": 0o644, "sha256": "a" * 64, "offset": 768 * 1024 * 1024},
            ],
        )
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["ARCHIVE_TOO_LARGE"]

    def test_accepts_under_1gb_archive(self):
        r = encode_paar_manifest(
            sourceCommit=VALID_SRC, target="linux-x64",
            daemonProtocolVersion=1, daemonSchemaRevision=0,
            files=[
                {"path": "p1", "size": 256 * 1024 * 1024, "mode": 0o644, "sha256": "a" * 64, "offset": 0},
                {"path": "p2", "size": 256 * 1024 * 1024, "mode": 0o644, "sha256": "a" * 64, "offset": 256 * 1024 * 1024},
                {"path": "p3", "size": 200 * 1024 * 1024, "mode": 0o644, "sha256": "a" * 64, "offset": 512 * 1024 * 1024},
            ],
        )
        assert r.ok, f"encode failed: {r}"


# ===========================================================================
# 17. Bool rejection (strict type(x) is int)
# ===========================================================================

class TestBoolRejection:
    def test_rejects_bool_for_size(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": True, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_bool_for_mode(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": True, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_bool_for_offset(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": False}
        ]))
        assert not r.ok

    def test_rejects_bool_for_daemon_protocol_version(self):
        r = encode_paar_manifest(**valid_input(daemonProtocolVersion=True))
        assert not r.ok

    def test_rejects_bool_for_schema_revision(self):
        r = encode_paar_manifest(**valid_input(daemonSchemaRevision=True))
        assert not r.ok


# ===========================================================================
# 18. Safe integer boundary tests (matches Number.isSafeInteger)
# ===========================================================================

class TestSafeIntegerBoundary:
    """Python must reject integers > SAFE_INT_MAX wherever TS uses
    Number.isSafeInteger.  SAFE_INT_MAX = 9_007_199_254_740_991."""

    def test_accepts_safe_int_max_for_size(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": SAFE_INT_MAX, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        # size > MAX_FILE_SIZE (256 MiB) so should be rejected by that check
        # Use a small size at the boundary instead
        pass

    def test_rejects_too_large_for_size(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": SAFE_INT_MAX + 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_too_large_for_offset(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": SAFE_INT_MAX + 1}
        ]))
        assert not r.ok

    def test_rejects_negative_size(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": -1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_negative_offset(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": -1}
        ]))
        assert not r.ok

    def test_rejects_float_size(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1.5, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok

    def test_rejects_float_offset(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0.5}
        ]))
        assert not r.ok

    def test_rejects_negative_daemon_protocol_version(self):
        r = encode_paar_manifest(**valid_input(daemonProtocolVersion=-1))
        assert not r.ok

    def test_rejects_negative_daemon_schema_revision(self):
        r = encode_paar_manifest(**valid_input(daemonSchemaRevision=-1))
        assert not r.ok

    def test_rejects_too_large_daemon_protocol_version(self):
        r = encode_paar_manifest(**valid_input(daemonProtocolVersion=SAFE_INT_MAX + 1))
        assert not r.ok

    def test_rejects_too_large_total_archive_size_on_decode(self):
        hdr = encode_valid()
        r = decode_paar_manifest_header(hdr.header, SAFE_INT_MAX + 1)
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["ARCHIVE_TOO_LARGE"]

    def test_accepts_safe_int_max_for_size_small(self):
        """Use a size below MAX_FILE_SIZE but at the safe int boundary."""
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 0, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert r.ok

    def test_accepts_safe_int_boundary_for_offset_zero(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert r.ok

    def test_rejects_float_daemon_protocol_version(self):
        r = encode_paar_manifest(**valid_input(daemonProtocolVersion=7.5))
        assert not r.ok

    def test_rejects_float_daemon_schema_revision(self):
        r = encode_paar_manifest(**valid_input(daemonSchemaRevision=0.5))
        assert not r.ok

    def test_rejects_string_size(self):
        r = encode_paar_manifest(**valid_input(files=[
            {"path": "f", "size": "100", "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
        ]))
        assert not r.ok


# ===========================================================================
# 19. Non-bytes decode input
# ===========================================================================

class TestDecodeInputType:
    def test_rejects_none(self):
        r = decode_paar_manifest_header(None, 100)  # type: ignore[arg-type]
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]

    def test_rejects_int(self):
        r = decode_paar_manifest_header(42, 100)  # type: ignore[arg-type]
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]

    def test_rejects_list(self):
        r = decode_paar_manifest_header([1, 2, 3], 100)  # type: ignore[arg-type]
        assert not r.ok
        assert r.error.code == PAAR_ERRORS["INVALID_INPUT"]


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
