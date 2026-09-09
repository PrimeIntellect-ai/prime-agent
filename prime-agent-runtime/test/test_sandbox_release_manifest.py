"""Trust-boundary tests for decode_release_manifest.  ResourceWarning as errors."""

from __future__ import annotations

import codecs
import json
import unittest
import warnings

from rlm.sandbox_release_archive import ArchiveIdentity
from rlm.sandbox_release_manifest import (
    DecodeManifestFailure,
    DecodeManifestSuccess,
    ManifestErrorCode,
    decode_release_manifest,
)

_ID = ArchiveIdentity(
    compressed_sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    compressed_bytes=1024,
)


def _min(entries=None):
    if entries is None:
        entries = [{"path": ".", "type": "directory", "mode": "0755", "size": 0}]
    return json.dumps(
        {
            "manifestVersion": 1,
            "version": "1.2.3",
            "platform": "linux-x64",
            "archive": "prime-agent-1.2.3-linux-x64.tar.gz",
            "totalFiles": 0,
            "totalDirectories": 1,
            "totalSize": 0,
            "decompressedTarBytes": 512,
            "entries": entries,
        },
        separators=(",", ":"),
    ).encode()


def _r(data):
    return decode_release_manifest(data, _ID).code


class TestDecode(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter("error", ResourceWarning)

    # valid
    def test_valid(self):
        r = decode_release_manifest(_min(), _ID)
        self.assertIsInstance(r, DecodeManifestSuccess)
        self.assertIs(r.manifest.identity, _ID)
        self.assertEqual(len(r.manifest.entries), 1)

    # argument types
    def test_data_not_bytes(self):
        self.assertIs(_r("str"), ManifestErrorCode.BAD_ARGUMENT_TYPE)

    def test_identity_not_archiveidentity(self):
        self.assertIs(decode_release_manifest(b"{}", "x").code, ManifestErrorCode.BAD_ARGUMENT_TYPE)

    # size
    def test_too_large(self):
        self.assertIs(_r(b"x" * 1048577), ManifestErrorCode.MANIFEST_TOO_LARGE)

    # BOM
    def test_bom_utf8(self):
        self.assertIs(_r(codecs.BOM_UTF8 + _min()), ManifestErrorCode.BOM_REJECTED)

    def test_bom_utf16le(self):
        self.assertIs(_r(codecs.BOM_UTF16_LE + _min()), ManifestErrorCode.BOM_REJECTED)

    def test_bom_utf16be(self):
        self.assertIs(_r(codecs.BOM_UTF16_BE + _min()), ManifestErrorCode.BOM_REJECTED)

    # UTF-8
    def test_bad_utf8(self):
        self.assertIs(_r(b'{"x":\xff}'), ManifestErrorCode.BAD_UTF8)

    # JSON hooks
    def test_float(self):
        self.assertIs(_r(_min().replace(b'"linux-x64"', b"3.14")), ManifestErrorCode.FLOAT_REJECTED)

    def test_nan(self):
        self.assertIs(_r(_min().replace(b'"linux-x64"', b"NaN")), ManifestErrorCode.CONSTANT_REJECTED)

    def test_oversized_int(self):
        self.assertIs(_r(_min().replace(b'"prime-agent-1.2.3-linux-x64.tar.gz"', b"10000000000")), ManifestErrorCode.OVERSIZED_INT)

    def test_duplicate_key(self):
        parts = _min().decode().split("{", 1)
        raw = ("{" + '"totalFiles":0,' * 2 + parts[1]).encode()
        self.assertIs(_r(raw), ManifestErrorCode.DUPLICATE_KEY)

    def test_proto_key_proto(self):
        raw = _min().replace(b'"manifestVersion"', b'"__proto__"').replace(b"1,", b'"x",')
        self.assertIs(_r(raw), ManifestErrorCode.PROTO_KEY)

    def test_proto_key_prototype(self):
        raw = _min().replace(b'"manifestVersion"', b'"prototype"').replace(b"1,", b'"x",')
        self.assertIs(_r(raw), ManifestErrorCode.PROTO_KEY)

    def test_proto_key_constructor(self):
        raw = _min().replace(b'"manifestVersion"', b'"constructor"').replace(b"1,", b'"x",')
        self.assertIs(_r(raw), ManifestErrorCode.PROTO_KEY)

    # deep nesting -> RecursionError caught by JSON_SYNTAX_ERROR
    def test_deeply_nested(self):
        deep = "[" * 50000 + "1" + "]" * 50000
        raw = b'{"x":' + deep.encode() + b"}".replace(b'"x"', b'"missing"')
        self.assertIs(_r(raw), ManifestErrorCode.JSON_SYNTAX_ERROR)

    # top-level keys
    def test_unknown_key(self):
        self.assertIs(_r(_min().replace(b'"archive"', b'"extra":0,"archive"')), ManifestErrorCode.UNKNOWN_TOP_KEY)

    def test_missing_required(self):
        # Remove archive key entirely
        raw = _min().replace(b'"archive":"prime-agent-1.2.3-linux-x64.tar.gz",', b"")
        self.assertIs(_r(raw), ManifestErrorCode.MISSING_REQUIRED_KEY)

    def test_missing_decompressed(self):
        self.assertIs(_r(_min().replace(b',"decompressedTarBytes":512', b"")), ManifestErrorCode.MISSING_REQUIRED_KEY)

    # producer metadata
    def test_bad_manifest_version(self):
        self.assertIs(_r(_min().replace(b"1,", b"2,")), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_bad_platform(self):
        self.assertIs(_r(_min().replace(b'"linux-x64"', b'"darwin-arm64"')), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_version_empty(self):
        self.assertIs(_r(_min().replace(b'"1.2.3"', b'""')), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_version_too_long(self):
        self.assertIs(_r(_min().replace(b'"1.2.3"', b'"' + b"a" * 65 + b'"')), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_version_not_string(self):
        self.assertIs(_r(_min().replace(b'"1.2.3"', b"42")), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_version_bad_chars(self):
        self.assertIs(_r(_min().replace(b'"1.2.3"', b'"1.2.3/"')), ManifestErrorCode.BAD_FIELD_VALUE)
        self.assertIs(_r(_min().replace(b'"1.2.3"', b'"1.2.3\\n"')), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_archive_wrong_pattern(self):
        raw = _min().replace(b'"prime-agent-1.2.3-linux-x64.tar.gz"', b'"custom-1.2.3-linux-x64.tar.gz"')
        self.assertIs(_r(raw), ManifestErrorCode.BAD_FIELD_VALUE)

    # totals
    def test_total_files_neg(self):
        self.assertIs(_r(_min().replace(b'"totalFiles":0', b'"totalFiles":-1')), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_total_files_over(self):
        self.assertIs(_r(_min().replace(b'"totalFiles":0', b'"totalFiles":513')), ManifestErrorCode.BAD_FIELD_VALUE)

    def test_total_size_neg(self):
        self.assertIs(_r(_min().replace(b'"totalSize":0', b'"totalSize":-1')), ManifestErrorCode.BAD_FIELD_VALUE)

    # entries
    def test_entries_not_list(self):
        raw = _min().replace(b'"entries":[{"path":".","type":"directory","mode":"0755","size":0}]', b'"entries":"bad"')
        self.assertIs(_r(raw), ManifestErrorCode.BAD_ENTRY)

    def test_entries_empty(self):
        self.assertIs(_r(_min([])), ManifestErrorCode.BAD_ENTRY_COUNT)

    def test_entry_unknown_type(self):
        self.assertIs(_r(_min([{"path": ".", "type": "symlink", "mode": "0755", "size": 0}])), ManifestErrorCode.BAD_ENTRY)

    def test_entry_extra_key_on_dir(self):
        self.assertIs(_r(_min([{"path": ".", "type": "directory", "mode": "0755", "size": 0, "sha256": None}])), ManifestErrorCode.BAD_ENTRY)

    def test_entry_missing_path(self):
        self.assertIs(_r(_min([{"type": "directory", "mode": "0755", "size": 0}])), ManifestErrorCode.BAD_ENTRY)

    def test_file_bad_mode(self):
        e = [{"path": ".", "type": "directory", "mode": "0755", "size": 0},
             {"path": "f", "type": "file", "mode": "0777", "size": 10,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]
        self.assertIs(_r(_min(e)), ManifestErrorCode.BAD_ENTRY)

    def test_dir_has_sha256(self):
        e = [{"path": ".", "type": "directory", "mode": "0755", "size": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]
        self.assertIs(_r(_min(e)), ManifestErrorCode.BAD_ENTRY)

    def test_dir_bad_mode(self):
        self.assertIs(_r(_min([{"path": ".", "type": "directory", "mode": "0644", "size": 0}])), ManifestErrorCode.BAD_ENTRY)

    # totals mismatch
    def test_total_mismatch(self):
        e = [{"path": ".", "type": "directory", "mode": "0755", "size": 0},
             {"path": "a", "type": "file", "mode": "0644", "size": 10,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]
        self.assertIs(_r(_min(e)), ManifestErrorCode.BAD_TOTAL)


if __name__ == "__main__":
    unittest.main()
