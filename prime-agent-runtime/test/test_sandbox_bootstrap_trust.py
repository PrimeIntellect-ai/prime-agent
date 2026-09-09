"""Trust-boundary tests for decode_bootstrap_trust and build_launch_config.
ResourceWarning as errors."""

from __future__ import annotations

import base64
import codecs
import json
import unittest
import warnings

from rlm.sandbox_bootstrap_trust import (
    BootstrapTrust,
    BootstrapTrustErrorCode,
    DecodeTrustSuccess,
    DecodeTrustFailure,
    build_launch_config,
    decode_bootstrap_trust,
)

_OK = None
_EC = BootstrapTrustErrorCode


def _vd(**kw):
    obj = {
        "protocol": "prime-sandbox-bootstrap-v1",
        "archiveSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "archiveBytes": 1024,
        "manifestSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "manifestBytes": 512,
        "homePublicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }
    obj.update(kw)
    return json.dumps(obj, separators=(",", ":")).encode()


def _make_cases():
    valid = _vd()
    return [
        ("valid", valid, _OK),
        ("maxArchive", _vd(archiveBytes=96 * 1024 * 1024), _OK),
        ("minArchive", _vd(archiveBytes=1), _OK),
        ("maxManifest", _vd(manifestBytes=1024 * 1024), _OK),
        ("minManifest", _vd(manifestBytes=1), _OK),
        ("badTypeStr", "str", _EC.BAD_ARGUMENT_TYPE),
        ("badTypeInt", 123, _EC.BAD_ARGUMENT_TYPE),
        ("badTypeNone", None, _EC.BAD_ARGUMENT_TYPE),
        ("empty", b"", _EC.BAD_ARGUMENT_TYPE),
        ("tooLarge", b"x" * 4097, _EC.TOO_LARGE),
        ("BOMutf8", codecs.BOM_UTF8 + valid, _EC.BOM_REJECTED),
        ("BOMutf16le", codecs.BOM_UTF16_LE + valid, _EC.BOM_REJECTED),
        ("BOMutf16be", codecs.BOM_UTF16_BE + valid, _EC.BOM_REJECTED),
        ("badUTF8", bytes.fromhex("c328"), _EC.BAD_UTF8),
        ("notJSON", b"not json", _EC.JSON_SYNTAX_ERROR),
        ("trailGarbage", valid + b"x", _EC.JSON_SYNTAX_ERROR),
        ("floatArchive", _vd(archiveBytes=1.5), _EC.FLOAT_REJECTED),
        ("floatManifest", _vd(manifestBytes=2.5), _EC.FLOAT_REJECTED),
        ("NaN", valid.replace(b"1024", b"NaN"), _EC.CONSTANT_REJECTED),
        ("Infinity", valid.replace(b"1024", b"Infinity"), _EC.CONSTANT_REJECTED),
        ("11digitInt", _vd(archiveBytes=12345678901), _EC.OVERSIZED_INT),
        ("dupKey", b'{"x":1,"x":2}', _EC.DUPLICATE_KEY),
        ("protoKey", b'{"__proto__":1}', _EC.PROTO_KEY),
        ("prototypeKey", b'{"prototype":1}', _EC.PROTO_KEY),
        ("constructorKey", b'{"constructor":1}', _EC.PROTO_KEY),
        ("list", b"[]", _EC.NOT_A_DICT),
        ("str", b'"str"', _EC.NOT_A_DICT),
        ("int", b"42", _EC.NOT_A_DICT),
        ("unknownKey", _vd(extra="x"), _EC.UNKNOWN_KEY),
        ("missingKey", b"{}", _EC.MISSING_KEY),
        ("badProto", _vd(protocol="wrong"), _EC.BAD_FIELD_VALUE),
        ("shaNonHex", _vd(archiveSha256="x" * 64), _EC.BAD_FIELD_VALUE),
        ("shaUpper", _vd(archiveSha256="E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"), _EC.BAD_FIELD_VALUE),
        ("shaShort", _vd(archiveSha256="abc"), _EC.BAD_FIELD_VALUE),
        ("abZero", _vd(archiveBytes=0), _EC.BAD_FIELD_VALUE),
        ("abOverflow", _vd(archiveBytes=96 * 1024 * 1024 + 1), _EC.BAD_FIELD_VALUE),
        ("abBool", _vd(archiveBytes=True), _EC.BAD_FIELD_VALUE),
        ("abString", _vd(archiveBytes="256"), _EC.BAD_FIELD_VALUE),
        ("mbZero", _vd(manifestBytes=0), _EC.BAD_FIELD_VALUE),
        ("mbOverflow", _vd(manifestBytes=1024 * 1024 + 1), _EC.BAD_FIELD_VALUE),
        ("mbString", _vd(manifestBytes="128"), _EC.BAD_FIELD_VALUE),
        ("pkBadB64", _vd(homePublicKey="!!!"), _EC.BAD_FIELD_VALUE),
        ("pk16b", _vd(homePublicKey=base64.b64encode(b"x" * 16).decode()), _EC.BAD_FIELD_VALUE),
        ("pk31b", _vd(homePublicKey=base64.b64encode(b"x" * 31).decode()), _EC.BAD_FIELD_VALUE),
    ]


class TestDecodeBootstrapTrust(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter("error", ResourceWarning)

    def test_all_boundaries(self):
        for desc, data, expect in _make_cases():
            with self.subTest(desc):
                r = decode_bootstrap_trust(data)
                if expect is _OK:
                    self.assertIsInstance(r, DecodeTrustSuccess, msg=desc)
                else:
                    self.assertIsInstance(r, DecodeTrustFailure, msg=desc)
                    self.assertIs(r.code, expect, msg=desc)

    def test_forge_and_mutation_rejected(self):
        with self.assertRaises(TypeError):
            BootstrapTrust(protocol="x", archive_sha256="x", archive_bytes=0,
                           manifest_sha256="x", manifest_bytes=0, home_public_key="x")
        with self.assertRaises(ValueError):
            BootstrapTrust(object(), protocol="x", archive_sha256="x",
                           archive_bytes=0, manifest_sha256="x",
                           manifest_bytes=0, home_public_key="x")
        valid = decode_bootstrap_trust(_vd())
        self.assertIsInstance(valid, DecodeTrustSuccess)
        with self.assertRaises((AttributeError, Exception)):
            valid.value.protocol = "other"

    def test_4096_safe(self):
        data = _vd(archiveBytes=1, manifestBytes=1)
        if len(data) < 4096:
            data = data + b" " * (4096 - len(data))
        r = decode_bootstrap_trust(data)
        ec = r.code if isinstance(r, DecodeTrustFailure) else None
        self.assertIsNot(ec, _EC.TOO_LARGE)


class TestBuildLaunchConfig(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter("error", ResourceWarning)

    def _trust(self):
        return decode_bootstrap_trust(_vd()).value

    def test_deterministic(self):
        t = self._trust()
        sha = "efabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        self.assertEqual(build_launch_config(t, sha), build_launch_config(t, sha))

    def test_different_launcher(self):
        t = self._trust()
        c1 = build_launch_config(t, "a" * 64)
        c2 = build_launch_config(t, "b" * 64)
        self.assertIsNotNone(c1)
        self.assertIsNotNone(c2)
        self.assertNotEqual(c1, c2)

    def test_output_format(self):
        t = self._trust()
        config = build_launch_config(t, "a" * 64)
        decoded = json.loads(config.decode("ascii"))
        self.assertEqual(decoded["protocol"], "prime-sandbox-v3")
        self.assertEqual(decoded["homePublicKey"], t.home_public_key)
        self.assertEqual(decoded["archiveSha256"], t.archive_sha256)
        self.assertEqual(decoded["manifestSha256"], t.manifest_sha256)
        self.assertEqual(decoded["launcherSha256"], "a" * 64)
        self.assertEqual(len(decoded), 5)

    def test_under_1024(self):
        t = self._trust()
        self.assertLessEqual(len(build_launch_config(t, "f" * 64)), 1024)

    def test_bad_trust_type(self):
        self.assertIsNone(build_launch_config("bad", "a" * 64))

    def test_bad_trust_none(self):
        self.assertIsNone(build_launch_config(None, "a" * 64))

    def test_bad_launcher_type(self):
        self.assertIsNone(build_launch_config(self._trust(), 123))

    def test_bad_launcher_not_hex(self):
        self.assertIsNone(build_launch_config(self._trust(), "z" * 64))

    def test_bad_launcher_short(self):
        self.assertIsNone(build_launch_config(self._trust(), "abcd"))
