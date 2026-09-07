#!/usr/bin/env python3
"""Build one digest-authorized deterministic V26 Bun entry artifact."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import types

REPO_ROOT = Path(__file__).resolve().parents[1]
NATIVE = REPO_ROOT / "prime-agent-runtime/native/sandbox-runtime-v26"
PATCHER = NATIVE / "patch_bun_elf.py"
PRELUDE_TEMPLATE = NATIVE / "prelude.bin"
PRELUDE_SOURCE = NATIVE / "prelude.S"
EXPECTED_TEMPLATE_SHA256 = "fbd1ddfc861cd85b8040de063ea6305f1a1396dc7a7ead78af2d9f24360bb60f"
EXPECTED_PRELUDE_SOURCE_SHA256 = "8d5f272256f925e37cf1811473cede1dd706b0647b1942721d7c35beeffc9eb5"
CODING_DIGEST_SENTINEL = b"PA_V26_CODING_DIGEST_PLACEHOLDER"
LOWER_SHA256 = re.compile(r"[0-9a-f]{64}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_patcher(source: bytes):
    module = types.ModuleType("sandbox_runtime_v26_patcher")
    module.__file__ = str(PATCHER)
    exec(compile(source, str(PATCHER), "exec"), module.__dict__)
    return module


def normalized(path: Path) -> Path:
    return path.parent.resolve(strict=False) / path.name


def bind_prelude(template: bytes, authorized_digest: bytes) -> bytes:
    if len(authorized_digest) != 32:
        raise ValueError("authorized coding digest must be exactly 32 bytes")
    if authorized_digest == CODING_DIGEST_SENTINEL:
        raise ValueError("authorized digest collides with the prelude template sentinel")
    if template.count(CODING_DIGEST_SENTINEL) != 1:
        raise ValueError("prelude template must contain its digest sentinel exactly once")
    if template.count(authorized_digest) != 0:
        raise ValueError("authorized digest collides with another prelude template location")
    offset = template.index(CODING_DIGEST_SENTINEL)
    owned_prelude = bytearray(template)
    owned_prelude[offset:offset + len(CODING_DIGEST_SENTINEL)] = authorized_digest
    prelude = bytes(owned_prelude)
    if prelude.count(CODING_DIGEST_SENTINEL) != 0:
        raise ValueError("digest sentinel remains after prelude binding")
    return prelude


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--coding-script", type=Path, required=True)
    parser.add_argument("--coding-script-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()

    if LOWER_SHA256.fullmatch(args.coding_script_sha256) is None:
        raise SystemExit("--coding-script-sha256 must be exactly 64 lowercase hexadecimal characters")
    authorized_digest = bytes.fromhex(args.coding_script_sha256)

    protected = [args.input, args.coding_script, PATCHER, PRELUDE_TEMPLATE,
                 PRELUDE_SOURCE, Path(__file__)]
    destinations = [args.output, args.manifest]
    if normalized(args.output) == normalized(args.manifest):
        raise SystemExit("output and manifest paths alias")
    for destination in destinations:
        if os.path.lexists(destination):
            raise SystemExit("output destinations must not exist, including links")
        if any(normalized(destination) == normalized(source) for source in protected):
            raise SystemExit("output path aliases an input or protected build source")

    builder_source = Path(__file__).read_bytes()
    patcher_source = PATCHER.read_bytes()
    patcher = load_patcher(patcher_source)
    prelude_template = PRELUDE_TEMPLATE.read_bytes()
    prelude_source = PRELUDE_SOURCE.read_bytes()
    if sha256(prelude_template) != EXPECTED_TEMPLATE_SHA256:
        raise SystemExit("checked-in prelude template SHA-256 mismatch")
    if sha256(prelude_source) != EXPECTED_PRELUDE_SOURCE_SHA256:
        raise SystemExit("checked-in prelude source SHA-256 mismatch")

    coding_script = args.coding_script.read_bytes()
    actual_digest = sha256(coding_script)
    if actual_digest != args.coding_script_sha256:
        raise SystemExit("coding script SHA-256 does not match release authority input")

    try:
        prelude = bind_prelude(prelude_template, authorized_digest)
    except ValueError as error:
        raise SystemExit(str(error)) from error

    source = args.input.read_bytes()
    patched, facts = patcher.patch(source, prelude)
    manifest = patcher.canonical_manifest(
        facts=facts,
        prelude_template=prelude_template,
        prelude=prelude,
        prelude_source=prelude_source,
        patcher_source=patcher_source,
        builder_source=builder_source,
        coding_script_expected_sha256=args.coding_script_sha256,
        coding_script_actual_sha256=actual_digest,
        coding_script_size=len(coding_script),
    )
    patcher.write_outputs(args.output, args.manifest, patched, manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
