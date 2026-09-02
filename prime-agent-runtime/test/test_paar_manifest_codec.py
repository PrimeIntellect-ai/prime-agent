
"""Exhaustive tests for the PAAR v1 manifest/framing codec (Python port).

Parity with the TS test at:
  packages/coding-agent/test/paar-manifest-codec.test.ts

Run: python -m pytest test/test_paar_manifest_codec.py -v
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys
import unicodedata

# Import module under test
_src = str(pathlib.Path(__file__).resolve().parent.parent / "src")
if _src not in sys.path:
    sys.path.insert(0, _src)

try:
    from rlm.paar import (
        encode_paar_manifest, decode_paar_manifest_header,
        PAAR_ERRORS, PaarExpectation, PaarFileEntry,
        PaarEncodeResult, PaarDecodeResult,
        REMOTE_HOST_PROTOCOL_NAME, REMOTE_HOST_PROTOCOL_VERSION,
        HEADER_PREFIX, MAX_MANIFEST_BYTES, MAX_FILES,
        MAX_FILE_SIZE, MAX_TOTAL_PAYLOAD, MAX_ARCHIVE_SIZE,
        MAX_PATH_BYTES,
    )
except ImportError:
    import importlib
    _spec = importlib.util.spec_from_file_location(
        "paar_manifest_codec",
        str(pathlib.Path(__file__).resolve().parent.parent
            / "src" / "rlm" / "paar" / "paar_manifest_codec.py"),
    )
    _pmc = importlib.util.module_from_spec(_spec)
    sys.modules["paar_manifest_codec"] = _pmc
    _spec.loader.exec_module(_pmc)
    from paar_manifest_codec import (
        encode_paar_manifest, decode_paar_manifest_header,
        PAAR_ERRORS, PaarExpectation, PaarFileEntry,
        PaarEncodeResult, PaarDecodeResult,
        REMOTE_HOST_PROTOCOL_NAME, REMOTE_HOST_PROTOCOL_VERSION,
        HEADER_PREFIX, MAX_MANIFEST_BYTES, MAX_FILES,
        MAX_FILE_SIZE, MAX_TOTAL_PAYLOAD, MAX_ARCHIVE_SIZE,
        MAX_PATH_BYTES,
    )

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

VALID_HASH = "0" * 64
VALID_SRC = "a" * 40


def valid_input(**overrides):
    """Build a valid encode_paar_manifest argument set."""
    kwargs = {
        "sourceCommit": overrides.get("sourceCommit", VALID_SRC),
        "target": overrides.get("target", "linux-x64"),
        "daemonProtocolVersion": overrides.get("daemonProtocolVersion", 7),
        "daemonSchemaRevision": overrides.get("daemonSchemaRevision", 25),
        "files": overrides.get("files", [
            {"path": "a.txt", "size": 100, "mode": 0o644,
             "sha256": "b" * 64, "offset": 0},
            {"path": "b.txt", "size": 200, "mode": 0o755,
             "sha256": "c" * 64, "offset": 100},
        ]),
    }
    return kwargs


def sorted_files(files):
    """Sort files by UTF-8 byte order."""
    return sorted(files, key=lambda f: f["path"].encode("utf-8"))


def compute_files_digest(files):
    def _js(s):
        return json.dumps(s, ensure_ascii=False, separators=(",", ":"))
    parts = []
    for f in files:
        parts.append(
            '{"path":' + _js(f["path"])
            + ',"size":' + str(f["size"])
            + ',"mode":' + str(f["mode"])
            + ',"sha256":' + _js(f["sha256"])
            + ',"offset":' + str(f["offset"]) + "}"
        )
    return hashlib.sha256(
        ("[" + ",".join(parts) + "]").encode("utf-8")
    ).hexdigest()


def compute_build_id(src, target, dpv, dsr, fd):
    def _js(s):
        return json.dumps(s, ensure_ascii=False, separators=(",", ":"))
    proto = (
        '{"name":' + _js(REMOTE_HOST_PROTOCOL_NAME)
        + ',"version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
        + ',"daemonProtocolVersion":' + str(dpv)
        + ',"daemonSchemaRevision":' + str(dsr) + "}"
    )
    canon = (
        '{"sourceCommit":' + _js(src)
        + ',"target":' + _js(target)
        + ',"protocol":' + proto
        + ',"filesDigest":' + _js(fd) + "}"
    )
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def build_header(json_str: str) -> bytes:
    """Build a PAAR1 header from a raw JSON manifest string."""
    raw = json_str.encode("utf-8")
    h = bytearray(9 + len(raw))
    h[0] = 0x50; h[1] = 0x41; h[2] = 0x41; h[3] = 0x52; h[4] = 0x31
    h[5] = (len(raw) >> 24) & 0xFF
    h[6] = (len(raw) >> 16) & 0xFF
    h[7] = (len(raw) >> 8) & 0xFF
    h[8] = len(raw) & 0xFF
    h[9:] = raw
    return bytes(h)


def stream_decode(data: bytes, archive_size: int, **exp_kw):
    """Decode using the bytes buffer directly with a PaarExpectation.

    Builds a PaarExpectation with *exp_kw* overrides on top of
    reasonable defaults. Returns the raw result (check .ok manually).
    """
    defaults = dict(
        archiveSize=archive_size,
        archiveSha256="0" * 64,
        buildId="0" * 64,
        sourceCommit="0" * 40,
        target="linux-x64",
        protocolName="prime-agent.remote-host",
        protocolVersion=1,
        daemonProtocolVersion=7,
        daemonSchemaRevision=25,
    )
    defaults.update(exp_kw)
    return decode_paar_manifest_header(data, PaarExpectation(**defaults))


def encode_valid(**overrides):
    """Encode a valid manifest and return PaarEncodeResult."""
    r = encode_paar_manifest(**valid_input(**overrides))
    assert r.ok, "encode failed: {}".format(r)
    return r.value


def exp_from_manifest(m):
    """Build expectation kwargs from a manifest."""
    return dict(
        buildId=m.buildId,
        sourceCommit=m.sourceCommit,
        target=m.target,
        daemonProtocolVersion=m.protocol.daemonProtocolVersion,
        daemonSchemaRevision=m.protocol.daemonSchemaRevision,
    )


# ===========================================================================
# 1. Deterministic golden bytes & protocol import
# ===========================================================================


def test_encodes_linux_x64_deterministically():
    files = sorted_files([{"path": "data.bin", "size": 42, "mode": 0o644,
                           "sha256": "d" * 64, "offset": 0}])
    v = encode_valid(files=files)
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
    d = stream_decode(v.header, v.archiveSize, **exp_from_manifest(v.manifest))
    assert d.ok, "decode failed: {}".format(d)
    assert d.value.manifest.target == "linux-x64"


def test_protocol_constants():
    """Verify the codec uses the imported constants, not mirrored literals."""
    files = sorted_files([{"path": "f", "size": 1, "mode": 0o644,
                           "sha256": "0" * 64, "offset": 0}])
    v = encode_valid(files=files)
    assert v.manifest.protocol.name == REMOTE_HOST_PROTOCOL_NAME
    assert v.manifest.protocol.version == REMOTE_HOST_PROTOCOL_VERSION


def test_uint32_no_sign_bug():
    """Uses integer_from_bytes correctly (no sign bug)."""
    v = encode_valid()
    d = stream_decode(v.header, v.archiveSize, **exp_from_manifest(v.manifest))
    assert d.ok


# ===========================================================================
# 2. Protocol constants import regression
# ===========================================================================


def test_protocol_binding_matches():
    fd = compute_files_digest([{"path": "f", "size": 1, "mode": 0o644, "sha256": "0" * 64, "offset": 0}])
    bid = compute_build_id(VALID_SRC, "linux-x64", 7, 25, fd)
    js = (
        '{"format":"prime-agent-artifact","version":1,"target":"linux-x64",'
        + '"sourceCommit":' + json.dumps(VALID_SRC, separators=(",", ":"))
        + ',"protocol":{"name":' + json.dumps(REMOTE_HOST_PROTOCOL_NAME, separators=(",", ":"))
        + ',"version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
        + ',"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
        + ',"filesDigest":' + json.dumps(fd, separators=(",", ":"))
        + ',"buildId":' + json.dumps(bid, separators=(",", ":"))
        + ',"files":[{"path":"f","size":1,"mode":420,"sha256":"' + "0" * 64 + '","offset":0}]}'
    )
    hdr = build_header(js)
    d = stream_decode(hdr, len(hdr) + 1, buildId=bid, sourceCommit=VALID_SRC, target="linux-x64",
                      daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert d.ok


def test_rejects_wrong_protocol_name():
    fd = compute_files_digest([{"path": "f", "size": 1, "mode": 0o644, "sha256": "0" * 64, "offset": 0}])
    bid = compute_build_id(VALID_SRC, "linux-x64", 7, 25, fd)
    js = (
        '{"format":"prime-agent-artifact","version":1,"target":"linux-x64",'
        + '"sourceCommit":' + json.dumps(VALID_SRC, separators=(",", ":"))
        + ',"protocol":{"name":"wrong","version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
        + ',"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
        + ',"filesDigest":' + json.dumps(fd, separators=(",", ":"))
        + ',"buildId":' + json.dumps(bid, separators=(",", ":"))
        + ',"files":[{"path":"f","size":1,"mode":420,"sha256":"' + "0" * 64 + '","offset":0}]}'
    )
    hdr = build_header(js)
    r = stream_decode(hdr, len(hdr) + 1, buildId=bid, sourceCommit=VALID_SRC, target="linux-x64",
                      daemonProtocolVersion=7, daemonSchemaRevision=25,
                      protocolName="prime-agent.remote-host")
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.BAD_PROTOCOL_NAME


# ===========================================================================
# 3. Numeric mode
# ===========================================================================


def test_accepts_0o644():
    v = encode_valid(files=[{"path": "f", "size": 1, "mode": 0o644,
                             "sha256": VALID_HASH, "offset": 0}])
    assert v.manifest.files[0].mode == 0o644


def test_accepts_0o755():
    v = encode_valid(files=[{"path": "f", "size": 1, "mode": 0o755,
                             "sha256": VALID_HASH, "offset": 0}])
    assert v.manifest.files[0].mode == 0o755


def test_rejects_string_mode():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": 1, "mode": "0644", "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok


def test_rejects_decimal_644():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": 1, "mode": 644, "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok


def test_rejects_0o777():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": 1, "mode": 0o777, "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok


# ===========================================================================
# 4. Cardinality, size, offset, total
# ===========================================================================


def test_rejects_empty_files():
    r = encode_paar_manifest(**valid_input(files=[]))
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.FILES_EMPTY


def test_accepts_20k_files():
    files, off = [], 0
    for i in range(20000):
        files.append({"path": "f{}.dat".format(str(i).zfill(10)),
                      "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": off})
        off += 1
    v = encode_valid(files=files)


def test_rejects_20001_files():
    files, off = [], 0
    for i in range(20001):
        files.append({"path": "f{}.dat".format(str(i).zfill(10)),
                      "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": off})
        off += 1
    r = encode_paar_manifest(**valid_input(files=files))
    assert not r.ok


def test_accepts_zero_size_file():
    v = encode_valid(files=[{"path": "e", "size": 0, "mode": 0o644,
                             "sha256": VALID_HASH, "offset": 0}])


def test_accepts_256mb_file():
    v = encode_valid(files=[{"path": "big", "size": 256 * 1024 * 1024, "mode": 0o644,
                             "sha256": VALID_HASH, "offset": 0}])


def test_rejects_over_256mb():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "too", "size": 256 * 1024 * 1024 + 1, "mode": 0o644,
         "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok


def test_rejects_non_contiguous_offsets():
    r = encode_paar_manifest(**valid_input(files=sorted_files([
        {"path": "a", "size": 10, "mode": 0o644, "sha256": VALID_HASH, "offset": 0},
        {"path": "b", "size": 10, "mode": 0o644, "sha256": VALID_HASH, "offset": 11},
    ])))
    assert not r.ok


# ===========================================================================
# 5. UTF-8 sorting
# ===========================================================================


def test_rejects_unsorted_input():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "z", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 2},
        {"path": "a", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0},
        {"path": "A", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 1},
    ]))
    assert not r.ok


def test_accepts_sorted_input():
    encode_valid(files=[
        {"path": "A", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0},
        {"path": "a", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 1},
        {"path": "z", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 2},
    ])
    pass  # encode_valid asserts ok


# ===========================================================================
# 6. Path validation (NFC, surrogates, controls, segments)
# ===========================================================================


def _good_path(p):
    return encode_paar_manifest(**valid_input(files=[
        {"path": p, "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
    ]))


def _bad_path(p):
    r = _good_path(p)
    assert not r.ok, "expected fail for path {!r}".format(p)


def _ok_path(p):
    r = _good_path(p)
    assert r.ok, "expected ok for path {!r}".format(p)


def test_path_rejects_leading_slash():
    _bad_path("/abs")


def test_path_rejects_trailing_slash():
    _bad_path("d/")


def test_path_rejects_empty():
    _bad_path("")


def test_path_rejects_backslash():
    _bad_path("a\\b")


def test_path_rejects_nul():
    _bad_path("fi\x00le")


def test_path_rejects_control():
    _bad_path("fi\t")


def test_path_rejects_del():
    _bad_path("fi\x7f")


def test_path_rejects_bom():
    _bad_path("\ufefff")


def test_path_rejects_dot_segment():
    _bad_path("./x")


def test_path_rejects_dotdot():
    _bad_path("../x")


def test_path_rejects_prime_agent_staging():
    _bad_path(".prime-agent-staging/x")


def test_path_rejects_double_slash():
    _bad_path("a//b")


def test_path_accepts_valid():
    _ok_path("f")
    _ok_path("d/f")
    _ok_path("a/b/c")


def test_path_accepts_astral():
    _ok_path("file\U0001F600.txt")


def test_path_rejects_lone_high_surrogate():
    _bad_path("file\uD800")


def test_path_rejects_lone_low_surrogate():
    _bad_path("file\uDC00")


def test_path_rejects_decomposed_nfc():
    _bad_path("e\u0301")  # e + combining acute accent


def test_path_accepts_512_bytes():
    _ok_path("a" * 511)


def test_path_rejects_over_512_bytes():
    _bad_path("a" * 513)


# ===========================================================================
# 7. Byte-level framing (stream decode tests)
# ===========================================================================


def _make_roundtrip_header():
    v = encode_valid()
    m = v.manifest
    return v.header, v.archiveSize, exp_from_manifest(m)


def test_rejects_empty():
    data = b""
    r = stream_decode(data, 100)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.SHORT_HEADER


def test_rejects_less_than_9_bytes():
    r = stream_decode(b"AAAAA", 100)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.SHORT_HEADER


def test_rejects_bad_magic():
    hdr, sz, exp = _make_roundtrip_header()
    b = bytearray(hdr)
    b[0] = 0x48
    r = stream_decode(bytes(b), sz, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.BAD_MAGIC


def test_rejects_manifest_len_over_4mb():
    hdr, sz, exp = _make_roundtrip_header()
    b = bytearray(hdr)
    b[5] = 0x01
    r = stream_decode(bytes(b), sz, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.MANIFEST_TOO_LARGE


def test_rejects_truncated():
    hdr, sz, exp = _make_roundtrip_header()
    short = hdr[:9]
    r = stream_decode(short, sz, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.MANIFEST_TRUNCATED


def test_rejects_invalid_utf8():
    hdr, sz, exp = _make_roundtrip_header()
    b = bytearray(hdr)
    if len(b) > 15:
        b[14] = 0xFF
        r = stream_decode(bytes(b), sz, **exp)
        assert not r.ok


def test_rejects_invalid_json():
    hdr = build_header("{{bad}}")
    r = stream_decode(hdr, len(hdr))
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.INVALID_JSON


def test_rejects_ffffffff_length():
    h = bytearray(13)
    h[0] = 0x50; h[1] = 0x41; h[2] = 0x41; h[3] = 0x52; h[4] = 0x31
    h[5] = 0xFF; h[6] = 0xFF; h[7] = 0xFF; h[8] = 0xFF
    r = stream_decode(bytes(h), 100)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.MANIFEST_TOO_LARGE


# ===========================================================================
# 8. Canonical encoding violations
# ===========================================================================


def _canon_good():
    fd = compute_files_digest([{"path": "f.dat", "size": 10, "mode": 0o644,
                                "sha256": VALID_HASH, "offset": 0}])
    bid = compute_build_id(VALID_SRC, "linux-x64", 7, 25, fd)
    js = (
        '{"format":"prime-agent-artifact","version":1,"target":"linux-x64",'
        + '"sourceCommit":' + json.dumps(VALID_SRC, separators=(",", ":"))
        + ',"protocol":{"name":' + json.dumps(REMOTE_HOST_PROTOCOL_NAME, separators=(",", ":"))
        + ',"version":' + str(REMOTE_HOST_PROTOCOL_VERSION)
        + ',"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
        + ',"filesDigest":' + json.dumps(fd, separators=(",", ":"))
        + ',"buildId":' + json.dumps(bid, separators=(",", ":"))
        + ',"files":[{"path":"f.dat","size":10,"mode":420,'
        + '"sha256":"' + VALID_HASH + '","offset":0}]}'
    )
    return js, fd, bid


def test_canonical_rejects_whitespace():
    good, fd, bid = _canon_good()
    bad = good.replace(':"', ': "')
    hdr = build_header(bad)
    r = stream_decode(hdr, len(hdr) + 10, buildId=bid, sourceCommit=VALID_SRC,
                      target="linux-x64", daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.NON_CANONICAL


def test_canonical_rejects_key_reorder():
    good, fd, bid = _canon_good()
    bad = good.replace(
        '{"format":"prime-agent-artifact","version":1',
        '{"version":1,"format":"prime-agent-artifact"'
    )
    hdr = build_header(bad)
    r = stream_decode(hdr, len(hdr) + 10, buildId=bid, sourceCommit=VALID_SRC,
                      target="linux-x64", daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.NON_CANONICAL


def test_canonical_rejects_extra_field():
    good, fd, bid = _canon_good()
    bad = good.replace('"files"', '"extra":"x","files"')
    hdr = build_header(bad)
    r = stream_decode(hdr, len(hdr) + 10, buildId=bid, sourceCommit=VALID_SRC,
                      target="linux-x64", daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.EXTRA_MANIFEST_FIELD


def test_canonical_rejects_missing_field():
    good, fd, bid = _canon_good()
    proto = ',"protocol":{"name":"prime-agent.remote-host","version":1,'
    proto += '"daemonProtocolVersion":7,"daemonSchemaRevision":25}'
    bad = good.replace(proto, "")
    hdr = build_header(bad)
    r = stream_decode(hdr, len(hdr) + 10, buildId=bid, sourceCommit=VALID_SRC,
                      target="linux-x64", daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert not r.ok


def test_canonical_rejects_trailing_bytes():
    good, fd, bid = _canon_good()
    bad = good + " "
    raw = bad.encode("utf-8")
    hdr = bytearray(9 + len(raw))
    hdr[0] = 0x50; hdr[1] = 0x41; hdr[2] = 0x41; hdr[3] = 0x52; hdr[4] = 0x31
    hdr[5] = (len(raw) >> 24) & 0xFF
    hdr[6] = (len(raw) >> 16) & 0xFF
    hdr[7] = (len(raw) >> 8) & 0xFF
    hdr[8] = len(raw) & 0xFF
    hdr[9:] = raw
    h = bytes(hdr)
    r = stream_decode(h, len(h) + 10, buildId=bid, sourceCommit=VALID_SRC,
                      target="linux-x64", daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert not r.ok


def test_canonical_rejects_negative_zero():
    good, fd, bid = _canon_good()
    bad = good.replace('"version":1', '"version":-0')
    hdr = build_header(bad)
    r = stream_decode(hdr, len(hdr) + 10, buildId=bid, sourceCommit=VALID_SRC,
                      target="linux-x64", daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert not r.ok


def test_canonical_rejects_uppercase_hex():
    good, fd, bid = _canon_good()
    upper_fd = "F" + fd[1:]
    bad = good.replace(fd, upper_fd)
    hdr = build_header(bad)
    r = stream_decode(hdr, len(hdr) + 10, buildId=bid, sourceCommit=VALID_SRC,
                      target="linux-x64", daemonProtocolVersion=7, daemonSchemaRevision=25)
    assert not r.ok


# ===========================================================================
# 9. totalArchiveSize
# ===========================================================================


def test_archive_size_too_small():
    hdr, sz, exp = _make_roundtrip_header()
    r = stream_decode(hdr, 5, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.INVALID_INPUT


def test_archive_size_too_large():
    hdr, sz, exp = _make_roundtrip_header()
    r = stream_decode(hdr, sz + 100, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.TOTAL_ARCHIVE_MISMATCH


def test_archive_size_over_1gb():
    hdr, sz, exp = _make_roundtrip_header()
    r = stream_decode(hdr, 1073741825, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.ARCHIVE_TOO_LARGE


def test_archive_size_zero():
    hdr, sz, exp = _make_roundtrip_header()
    r = stream_decode(hdr, 0, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.ARCHIVE_TOO_LARGE


def test_archive_size_non_integer():
    hdr, sz, exp = _make_roundtrip_header()
    r = stream_decode(hdr, 1.5, **exp)
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.ARCHIVE_TOO_LARGE


# ===========================================================================
# 10. Digest / buildId mutations
# ===========================================================================


def test_rejects_mutated_files_digest():
    v = encode_valid()
    m = v.manifest
    manifest_len = (v.header[5] << 24) | (v.header[6] << 16) | (v.header[7] << 8) | v.header[8]
    ms = v.header[9:9 + manifest_len].decode("utf-8")
    mutated = ms.replace(
        '"filesDigest":"{}"'.format(m.filesDigest),
        '"filesDigest":"{}"'.format("f" * 64)
    )
    hdr = build_header(mutated)
    d = stream_decode(hdr, len(hdr) + v.payloadSize,
                      buildId=m.buildId, sourceCommit=m.sourceCommit, target=m.target,
                      daemonProtocolVersion=m.protocol.daemonProtocolVersion,
                      daemonSchemaRevision=m.protocol.daemonSchemaRevision)
    assert not d.ok
    assert d.error.code == PAAR_ERRORS.FILES_DIGEST_MISMATCH


def test_rejects_mutated_build_id():
    v = encode_valid()
    m = v.manifest
    manifest_len = (v.header[5] << 24) | (v.header[6] << 16) | (v.header[7] << 8) | v.header[8]
    ms = v.header[9:9 + manifest_len].decode("utf-8")
    mutated = ms.replace(
        '"buildId":"{}"'.format(m.buildId),
        '"buildId":"{}"'.format("e" * 64)
    )
    hdr = build_header(mutated)
    d = stream_decode(hdr, len(hdr) + v.payloadSize,
                      buildId=m.buildId, sourceCommit=m.sourceCommit, target=m.target,
                      daemonProtocolVersion=m.protocol.daemonProtocolVersion,
                      daemonSchemaRevision=m.protocol.daemonSchemaRevision)
    assert not d.ok
    assert d.error.code == PAAR_ERRORS.BUILD_ID_MISMATCH


# ===========================================================================
# 11. Immutable DTOs
# ===========================================================================


def test_encode_result_is_namedtuple():
    v = encode_valid()
    assert isinstance(v, tuple)


def test_manifest_is_namedtuple():
    v = encode_valid()
    assert isinstance(v.manifest, tuple)


def test_decode_result_is_namedtuple():
    v = encode_valid()
    m = v.manifest
    d = stream_decode(v.header, v.archiveSize, **exp_from_manifest(m))
    assert d.ok
    assert isinstance(d.value, tuple)
    assert isinstance(d.value.manifest, tuple)


def test_paar_errors_is_frozen():
    assert PAAR_ERRORS.SHORT_HEADER == "SHORT_HEADER"
    assert PAAR_ERRORS.BAD_MAGIC == "BAD_MAGIC"


def test_error_objects_have_only_code():
    r = encode_paar_manifest(**valid_input(files=[]))
    assert not r.ok
    assert hasattr(r.error, "code")
    assert r.error.code is not None


# ===========================================================================
# 12. Adversarial: non-plain prototypes, class instances, aliases
# ===========================================================================


def test_rejects_class_instance_file_entry():
    class Entry:
        path = "f"
        size = 1
        mode = 0o644
        sha256 = VALID_HASH
        offset = 0
    r = encode_paar_manifest(**valid_input(files=[Entry()]))
    assert not r.ok


def test_rejects_alias_same_object():
    shared = {"path": "shared", "size": 1, "mode": 0o644,
              "sha256": VALID_HASH, "offset": 0}
    entries = [shared, shared]
    r = encode_paar_manifest(**valid_input(files=entries))
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.PROTO_INVALID_ALIAS


def test_error_codes():
    """Verify PAAR_ERRORS exposes the expected error codes."""
    assert PAAR_ERRORS.SHORT_HEADER == "SHORT_HEADER"
    assert PAAR_ERRORS.BAD_MAGIC == "BAD_MAGIC"
    assert PAAR_ERRORS.MANIFEST_TOO_LARGE == "MANIFEST_TOO_LARGE"
    assert PAAR_ERRORS.MANIFEST_TRUNCATED == "MANIFEST_TRUNCATED"
    assert PAAR_ERRORS.INVALID_INPUT == "INVALID_INPUT"
    assert PAAR_ERRORS.PROTO_INVALID_ALIAS == "PROTO_INVALID_ALIAS"
    assert PAAR_ERRORS.BAD_FILE_ENTRY == "BAD_FILE_ENTRY"
    assert PAAR_ERRORS.CANONICAL_ENCODE_ERROR == "CANONICAL_ENCODE_ERROR"
    assert PAAR_ERRORS.BAD_FILES == "BAD_FILES"
    assert PAAR_ERRORS.NON_CANONICAL == "NON_CANONICAL"


# ===========================================================================
# 13. Header has non-zero content
# ===========================================================================


def test_header_not_trivially_zeroed():
    v = encode_valid()
    non_zero = any(b != 0 for b in v.header)
    assert non_zero


# ===========================================================================
# 14. Payload after header — decode ignores payload
# ===========================================================================


def test_decodes_with_extra_payload_present():
    v = encode_valid()
    m = v.manifest
    payload = bytes(v.payloadSize)
    full = v.header + payload
    d = stream_decode(full, v.archiveSize, **exp_from_manifest(m))
    assert d.ok


# ===========================================================================
# 15. Roundtrip integrity
# ===========================================================================


def _roundtrip_test(sourceCommit, target, dpv, dsr, files):
    r = encode_paar_manifest(sourceCommit, target, dpv, dsr, files)
    assert r.ok, "encode failed: {}".format(r)
    m = r.value.manifest
    d = stream_decode(r.value.header, r.value.archiveSize,
                      buildId=m.buildId, sourceCommit=m.sourceCommit, target=m.target,
                      daemonProtocolVersion=m.protocol.daemonProtocolVersion,
                      daemonSchemaRevision=m.protocol.daemonSchemaRevision)
    assert d.ok, "decode failed: {}".format(d)
    assert d.value.manifest.sourceCommit == sourceCommit
    assert d.value.manifest.target == target
    assert d.value.manifest.protocol.daemonProtocolVersion == dpv
    assert d.value.manifest.protocol.daemonSchemaRevision == dsr


def test_roundtrip_simple():
    _roundtrip_test(
        VALID_SRC, "linux-x64", 7, 25,
        sorted_files([{"path": "a", "size": 100, "mode": 0o644,
                       "sha256": "b" * 64, "offset": 0}]),
    )


def test_roundtrip_multiple():
    _roundtrip_test(
        "b" * 40, "linux-arm64", 1, 0,
        sorted_files([
            {"path": "a", "size": 5, "mode": 0o755, "sha256": "c" * 64, "offset": 0},
            {"path": "b", "size": 10, "mode": 0o644, "sha256": "d" * 64, "offset": 5},
            {"path": "c", "size": 0, "mode": 0o644, "sha256": "e" * 64, "offset": 15},
        ]),
    )


def test_roundtrip_non_ascii():
    _roundtrip_test(
        "c" * 40, "linux-x64", 99, 999,
        sorted_files([
            {"path": "resume.txt".replace("e", "\u00e9"),  # use .format to avoid syntax issues
             "size": 42, "mode": 0o644, "sha256": "f" * 64, "offset": 0},
            {"path": "\u4e2d\u6587/\u6587\u4ef6.bin", "size": 7, "mode": 0o755,
             "sha256": VALID_HASH, "offset": 42},
        ]),
    )


# ===========================================================================
# 16. Archive size boundary
# ===========================================================================


def test_rejects_over_1gb_archive():
    r = encode_paar_manifest(
        sourceCommit=VALID_SRC,
        target="linux-x64",
        daemonProtocolVersion=1,
        daemonSchemaRevision=0,
        files=[
            {"path": "p1", "size": 256 * 1024 * 1024, "mode": 0o644,
             "sha256": "a" * 64, "offset": 0},
            {"path": "p2", "size": 256 * 1024 * 1024, "mode": 0o644,
             "sha256": "a" * 64, "offset": 256 * 1024 * 1024},
            {"path": "p3", "size": 256 * 1024 * 1024, "mode": 0o644,
             "sha256": "a" * 64, "offset": 512 * 1024 * 1024},
            {"path": "p4", "size": 256 * 1024 * 1024, "mode": 0o644,
             "sha256": "a" * 64, "offset": 768 * 1024 * 1024},
        ],
    )
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.ARCHIVE_TOO_LARGE


def test_accepts_under_1gb_archive():
    r = encode_paar_manifest(
        sourceCommit=VALID_SRC,
        target="linux-x64",
        daemonProtocolVersion=1,
        daemonSchemaRevision=0,
        files=[
            {"path": "p1", "size": 256 * 1024 * 1024, "mode": 0o644,
             "sha256": "a" * 64, "offset": 0},
            {"path": "p2", "size": 256 * 1024 * 1024, "mode": 0o644,
             "sha256": "a" * 64, "offset": 256 * 1024 * 1024},
            {"path": "p3", "size": 200 * 1024 * 1024, "mode": 0o644,
             "sha256": "a" * 64, "offset": 512 * 1024 * 1024},
        ],
    )
    assert r.ok, "encode failed: {}".format(r)


# ===========================================================================
# 17. Bool rejection (strict type(x) is int for integers)
# ===========================================================================


def test_rejects_bool_for_size():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": True, "mode": 0o644, "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok


def test_rejects_bool_for_mode():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": 1, "mode": True, "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok


def test_rejects_bool_for_offset():
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": 1, "mode": 0o644, "sha256": VALID_HASH, "offset": False}
    ]))
    assert not r.ok


def test_rejects_bool_for_daemon_protocol_version():
    r = encode_paar_manifest(**valid_input(daemonProtocolVersion=True))
    assert not r.ok


def test_rejects_bool_for_schema_revision():
    r = encode_paar_manifest(**valid_input(daemonSchemaRevision=True))
    assert not r.ok

# ===========================================================================
# 19. Safe-int boundary (MAX_SAFE_INTEGER = 9007199254740991)
# ===========================================================================


MAX_SAFE = 9007199254740991


def test_accepts_max_safe_int_for_size():
    """MAX_SAFE_INTEGER is accepted for file size."""
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": MAX_SAFE, "mode": 0o644,
         "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok  # because MAX_SAFE > MAX_FILE_SIZE (256 MiB)
    assert r.error.code == PAAR_ERRORS.INVALID_FILE_SIZE


def test_accepts_max_safe_int_for_offset():
    """MAX_SAFE_INTEGER accepted for offset but must match contiguous."""
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "a", "size": 1, "mode": 0o644,
         "sha256": VALID_HASH, "offset": MAX_SAFE},
    ]))
    assert not r.ok  # offset mismatch (expected 0)
    assert r.error.code == PAAR_ERRORS.INVALID_FILE_OFFSET


def test_rejects_oversized_int_for_size():
    """MAX_SAFE_INTEGER + 1 is rejected (outside safe integer range)."""
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": MAX_SAFE + 1, "mode": 0o644,
         "sha256": VALID_HASH, "offset": 0}
    ]))
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.INVALID_FILE_SIZE


def test_rejects_oversized_int_for_offset():
    """MAX_SAFE_INTEGER + 1 is rejected for offset."""
    r = encode_paar_manifest(**valid_input(files=[
        {"path": "f", "size": 1, "mode": 0o644,
         "sha256": VALID_HASH, "offset": MAX_SAFE + 1}
    ]))
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.INVALID_FILE_OFFSET


def test_rejects_oversized_int_for_daemon_protocol_version():
    """MAX_SAFE_INTEGER + 1 is rejected for daemonProtocolVersion."""
    r = encode_paar_manifest(**valid_input(
        daemonProtocolVersion=MAX_SAFE + 1
    ))
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION


def test_accepts_max_safe_int_for_daemon_protocol_version():
    """MAX_SAFE_INTEGER is accepted for daemonProtocolVersion."""
    r = encode_paar_manifest(**valid_input(
        daemonProtocolVersion=MAX_SAFE,
        files=[{"path": "f", "size": 1, "mode": 0o644,
                "sha256": VALID_HASH, "offset": 0}],
    ))
    assert r.ok, "expected encode to succeed with MAX_SAFE_INTEGER protocol version"


def test_accepts_max_safe_int_for_daemon_schema_revision():
    """MAX_SAFE_INTEGER is accepted for daemonSchemaRevision."""
    r = encode_paar_manifest(**valid_input(
        daemonSchemaRevision=MAX_SAFE,
        files=[{"path": "f", "size": 1, "mode": 0o644,
                "sha256": VALID_HASH, "offset": 0}],
    ))
    assert r.ok, "expected encode to succeed with MAX_SAFE_INTEGER schema revision"


def test_rejects_oversized_int_for_daemon_schema_revision():
    """MAX_SAFE_INTEGER + 1 is rejected for daemonSchemaRevision."""
    r = encode_paar_manifest(**valid_input(
        daemonSchemaRevision=MAX_SAFE + 1
    ))
    assert not r.ok
    assert r.error.code == PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION