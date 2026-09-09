"""Decode bootstrap trust JSON. Pure-Python-3.11 strict decoder. Never raises."""
from __future__ import annotations

import base64
import codecs
import dataclasses
import enum
import json
import re
from typing import Final

_MAX_BYTES: Final[int] = 4096
_MAX_INT_DIGITS: Final[int] = 10
_MAX_ARCHIVE_BYTES: Final[int] = 96 * 1024 * 1024
_MAX_MANIFEST_BYTES: Final[int] = 1 * 1024 * 1024
_HEX64_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{64}$")
_PROTO_KEYS: Final[frozenset[str]] = frozenset(
    {"__proto__", "prototype", "constructor"}
)
_BOOTSTRAP_TRUST_TOKEN: Final[object] = object()
_REQUIRED_KEYS: Final[frozenset[str]] = frozenset({
    "protocol", "archiveSha256", "archiveBytes",
    "manifestSha256", "manifestBytes", "homePublicKey",
})


class BootstrapTrustErrorCode(enum.StrEnum):
    BAD_ARGUMENT_TYPE = "bad_argument_type"
    TOO_LARGE = "too_large"
    BOM_REJECTED = "bom_rejected"
    BAD_UTF8 = "bad_utf8"
    JSON_SYNTAX_ERROR = "json_syntax_error"
    FLOAT_REJECTED = "float_rejected"
    CONSTANT_REJECTED = "constant_rejected"
    OVERSIZED_INT = "oversized_int"
    DUPLICATE_KEY = "duplicate_key"
    PROTO_KEY = "proto_key"
    NOT_A_DICT = "not_a_dict"
    UNKNOWN_KEY = "unknown_key"
    MISSING_KEY = "missing_key"
    BAD_FIELD_VALUE = "bad_field_value"


@dataclasses.dataclass(frozen=True, slots=True, init=False)
class BootstrapTrust:
    protocol: str
    archive_sha256: str
    archive_bytes: int
    manifest_sha256: str
    manifest_bytes: int
    home_public_key: str

    def __init__(self, token: object, protocol: str, archive_sha256: str,
                 archive_bytes: int, manifest_sha256: str, manifest_bytes: int,
                 home_public_key: str) -> None:
        if token is not _BOOTSTRAP_TRUST_TOKEN:
            raise ValueError("cannot forge BootstrapTrust")
        object.__setattr__(self, "protocol", protocol)
        object.__setattr__(self, "archive_sha256", archive_sha256)
        object.__setattr__(self, "archive_bytes", archive_bytes)
        object.__setattr__(self, "manifest_sha256", manifest_sha256)
        object.__setattr__(self, "manifest_bytes", manifest_bytes)
        object.__setattr__(self, "home_public_key", home_public_key)


@dataclasses.dataclass(frozen=True)
class DecodeTrustSuccess:
    value: BootstrapTrust


@dataclasses.dataclass(frozen=True)
class DecodeTrustFailure:
    code: BootstrapTrustErrorCode


DecodeTrustResult = DecodeTrustSuccess | DecodeTrustFailure
_EC = BootstrapTrustErrorCode


def _fields_ok(ash: object, ab: object, msh: object, mb: object, pk: object) -> bool:
    if not (type(ash) is str and type(msh) is str
            and _HEX64_RE.fullmatch(ash) and _HEX64_RE.fullmatch(msh)):
        return False
    if not (type(ab) is int and type(mb) is int
            and 1 <= ab <= _MAX_ARCHIVE_BYTES and 1 <= mb <= _MAX_MANIFEST_BYTES):
        return False
    if type(pk) is not str:
        return False
    try:
        d = base64.b64decode(pk, validate=True)
    except Exception:
        return False
    return len(d) == 32 and base64.b64encode(d).decode("ascii") == pk


def decode_bootstrap_trust(data: bytes) -> DecodeTrustResult:
    if type(data) is not bytes:
        return DecodeTrustFailure(_EC.BAD_ARGUMENT_TYPE)
    if len(data) < 1:
        return DecodeTrustFailure(_EC.BAD_ARGUMENT_TYPE)
    if len(data) > _MAX_BYTES:
        return DecodeTrustFailure(_EC.TOO_LARGE)
    if data[:3] == codecs.BOM_UTF8 or data[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return DecodeTrustFailure(_EC.BOM_REJECTED)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return DecodeTrustFailure(_EC.BAD_UTF8)

    errors: list[str] = []

    def _pair(pairs: list[tuple[str, object]]) -> dict[str, object]:
        seen: set[str] = set()
        out: dict[str, object] = {}
        for k, v in pairs:
            if k in _PROTO_KEYS:
                if not errors:
                    errors.append("proto")
                return {}
            if k in seen:
                if not errors:
                    errors.append("dup")
                return {}
            seen.add(k)
            out[k] = v
        return out

    def _pf(_: str) -> float:
        if not errors:
            errors.append("float")
        return 0.0

    def _pi(s: str) -> int:
        digits = s[1:] if s.startswith("-") else s
        if len(digits) > _MAX_INT_DIGITS:
            if not errors:
                errors.append("big")
            return 0
        v = int(s, 10)
        if v > 9999999999:
            if not errors:
                errors.append("big")
        return v

    def _pc(_: str) -> object:
        if not errors:
            errors.append("const")
        return None

    try:
        decoder = json.JSONDecoder(
            object_pairs_hook=_pair,
            parse_float=_pf,
            parse_int=_pi,
            parse_constant=_pc,
        )
        obj: object = decoder.decode(text)
    except (json.JSONDecodeError, RecursionError, ValueError):
        return DecodeTrustFailure(_EC.JSON_SYNTAX_ERROR)

    if errors:
        _em = {"float": _EC.FLOAT_REJECTED, "const": _EC.CONSTANT_REJECTED,
               "big": _EC.OVERSIZED_INT, "dup": _EC.DUPLICATE_KEY,
               "proto": _EC.PROTO_KEY}
        return DecodeTrustFailure(_em.get(errors[0], _EC.JSON_SYNTAX_ERROR))

    if type(obj) is not dict:
        return DecodeTrustFailure(_EC.NOT_A_DICT)

    keys = frozenset(obj.keys())
    missing = _REQUIRED_KEYS - keys
    if missing:
        return DecodeTrustFailure(_EC.MISSING_KEY)
    extra = keys - _REQUIRED_KEYS
    if extra:
        return DecodeTrustFailure(_EC.UNKNOWN_KEY)

    if obj["protocol"] != "prime-sandbox-bootstrap-v1":
        return DecodeTrustFailure(_EC.BAD_FIELD_VALUE)

    if not _fields_ok(
        obj["archiveSha256"], obj["archiveBytes"],
        obj["manifestSha256"], obj["manifestBytes"],
        obj["homePublicKey"],
    ):
        return DecodeTrustFailure(_EC.BAD_FIELD_VALUE)

    try:
        trust = BootstrapTrust(
            _BOOTSTRAP_TRUST_TOKEN,
            protocol="prime-sandbox-bootstrap-v1",
            archive_sha256=obj["archiveSha256"],
            archive_bytes=obj["archiveBytes"],
            manifest_sha256=obj["manifestSha256"],
            manifest_bytes=obj["manifestBytes"],
            home_public_key=obj["homePublicKey"],
        )
    except ValueError:
        return DecodeTrustFailure(_EC.BAD_FIELD_VALUE)

    return DecodeTrustSuccess(trust)


def build_launch_config(trust: BootstrapTrust, launcher_sha256: str) -> bytes | None:
    if type(trust) is not BootstrapTrust:
        return None
    if type(launcher_sha256) is not str or not _HEX64_RE.fullmatch(launcher_sha256):
        return None
    try:
        ash = trust.archive_sha256
        ab = trust.archive_bytes
        msh = trust.manifest_sha256
        mb = trust.manifest_bytes
        pk = trust.home_public_key
    except AttributeError:
        return None
    if trust.protocol != "prime-sandbox-bootstrap-v1":
        return None
    if not _fields_ok(ash, ab, msh, mb, pk):
        return None
    obj = {
        "protocol": "prime-sandbox-v3",
        "homePublicKey": pk,
        "archiveSha256": ash,
        "manifestSha256": msh,
        "launcherSha256": launcher_sha256,
    }
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(raw) > 1024:
        return None
    return raw
