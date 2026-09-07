#!/usr/bin/env python3
"""Fail-closed deterministic patcher for the one official Bun 1.4.0 linux-x64 ELF."""
from __future__ import annotations

import errno
import hashlib
import json
import os
import struct
import stat
from pathlib import Path

SOURCE_SHA256 = "33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b"
SOURCE_SIZE = 80_761_952
ORIGINAL_ENTRY = 0x17BF400
INTERPRETER = b"/lib64/ld-linux-x86-64.so.2\0"
EHDR = struct.Struct("<16sHHIQQQIHHHHHH")
PHDR = struct.Struct("<IIQQQQQQ")
EXPECTED_EHDR = (
    b"\x7fELF\x02\x01\x01" + b"\0" * 9,
    2, 62, 1, ORIGINAL_ENTRY, 64, 80_759_584, 0, 64, 56, 9, 64, 37, 36,
)
EXPECTED_PHDRS = (
    (6, 4, 64, 2_097_216, 2_097_216, 504, 504, 8),
    (3, 4, 568, 2_097_720, 2_097_720, 28, 28, 1),
    (1, 4, 0, 2_097_152, 2_097_152, 22_769_076, 22_769_076, 4096),
    (1, 5, 22_770_688, 24_900_608, 24_900_608, 57_811_104, 57_811_104, 4096),
    (1, 6, 80_585_888, 82_715_808, 82_715_808, 125_688, 1_894_184, 16_384),
    (7, 4, 80_585_888, 82_715_808, 82_715_808, 9_352, 26_952, 16),
    (2, 6, 80_707_584, 82_837_504, 82_837_504, 496, 496, 8),
    (0x6474E551, 6, 0, 0, 0, 0, 0, 8),
    (4, 4, 596, 2_097_748, 2_097_748, 68, 68, 4),
)
NOTE_INDEX = 8
NOTE_SHA256 = "8bd85888fdfcff87019a27f4c3b072343a504ce8b10c5977aacc1c92f355c298"
PAGE = 4096

class ValidationError(ValueError):
    pass

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def _align(value: int) -> int:
    return (value + PAGE - 1) & -PAGE

def _parse_pinned_notes(note: bytes) -> list[dict]:
    if sha256(note) != NOTE_SHA256:
        raise ValidationError("PT_NOTE bytes mismatch")
    records = []
    offset = 0
    while offset < len(note):
        if len(note) - offset < 12:
            raise ValidationError("truncated ELF note")
        namesz, descsz, kind = struct.unpack_from("<III", note, offset)
        offset += 12
        name_end = offset + namesz
        if name_end > len(note):
            raise ValidationError("truncated ELF note name")
        name = note[offset:name_end]
        offset = (name_end + 3) & -4
        desc_end = offset + descsz
        if desc_end > len(note):
            raise ValidationError("truncated ELF note descriptor")
        descriptor = note[offset:desc_end]
        offset = (desc_end + 3) & -4
        records.append({"descriptor_sha256": sha256(descriptor), "name_hex": name.hex(), "type": kind})
    expected = [
        {"descriptor_sha256": "67fc579de7e859031f4bdebbaf20e4266f2981bb1b8239ff78c685c4e66f91b3", "name_hex": "474e5500", "type": 1},
        {"descriptor_sha256": "f0b9e832a5f8a04ca4c6c610cb5a317ecbcaad05964ca90796d182cb5c0715db", "name_hex": "474e5500", "type": 3},
    ]
    if records != expected:
        raise ValidationError("PT_NOTE record mismatch")
    return records

def parse_and_validate(data: bytes) -> tuple[tuple, tuple[tuple, ...]]:
    if len(data) != SOURCE_SIZE:
        raise ValidationError(f"source size mismatch: {len(data)}")
    if sha256(data) != SOURCE_SHA256:
        raise ValidationError("source SHA-256 mismatch")
    if len(data) < EHDR.size:
        raise ValidationError("truncated ELF header")
    ehdr = EHDR.unpack_from(data)
    if ehdr != EXPECTED_EHDR:
        raise ValidationError("ELF header mismatch")
    phoff, phentsize, phnum = ehdr[5], ehdr[9], ehdr[10]
    if phoff + phentsize * phnum > len(data):
        raise ValidationError("program header table is out of bounds")
    phdrs = tuple(PHDR.unpack_from(data, phoff + i * phentsize) for i in range(phnum))
    if phdrs != EXPECTED_PHDRS:
        raise ValidationError("program header geometry mismatch")
    interp = phdrs[1]
    if data[interp[2]:interp[2] + interp[5]] != INTERPRETER:
        raise ValidationError("PT_INTERP mismatch")
    if [i for i, ph in enumerate(phdrs) if ph[0] == 4] != [NOTE_INDEX]:
        raise ValidationError("safe PT_NOTE is not unique")
    note = phdrs[NOTE_INDEX]
    _parse_pinned_notes(data[note[2]:note[2] + note[5]])
    return ehdr, phdrs

def patch(source: bytes, prelude: bytes) -> tuple[bytes, dict]:
    ehdr, phdrs = parse_and_validate(source)
    if not prelude or len(prelude) > PAGE:
        raise ValidationError("prelude must fit one nonempty page")
    file_offset = _align(len(source))
    loads = [ph for ph in phdrs if ph[0] == 1]
    virtual_address = _align(max(ph[3] + ph[6] for ph in loads))
    if file_offset % PAGE != virtual_address % PAGE:
        raise ValidationError("new load segment is not page-congruent")
    new_end = virtual_address + len(prelude)
    if any(not (new_end <= ph[3] or virtual_address >= ph[3] + ph[6]) for ph in loads):
        raise ValidationError("new load segment overlaps an existing PT_LOAD")

    result = bytearray(source)
    result.extend(b"\0" * (file_offset - len(result)))
    result.extend(prelude)
    new_ehdr = list(ehdr)
    new_ehdr[4] = virtual_address
    EHDR.pack_into(result, 0, *new_ehdr)
    ph_offset = ehdr[5] + NOTE_INDEX * ehdr[9]
    PHDR.pack_into(result, ph_offset, 1, 5, file_offset, virtual_address,
                   virtual_address, len(prelude), len(prelude), PAGE)

    changed_prefix = [i for i, (old, new) in enumerate(zip(source, result)) if old != new]
    allowed = set(range(24, 32)) | set(range(ph_offset, ph_offset + PHDR.size))
    if not changed_prefix or not set(changed_prefix) <= allowed:
        raise AssertionError("patch changed bytes outside e_entry and the selected PT_NOTE")
    if result[len(source):file_offset] != b"\0" * (file_offset - len(source)):
        raise AssertionError("append padding is not zero")
    parsed_output_ehdr = EHDR.unpack_from(result)
    if parsed_output_ehdr[4] != virtual_address:
        raise AssertionError("output entry mismatch")
    new_ph = PHDR.unpack_from(result, ph_offset)
    if new_ph != (1, 5, file_offset, virtual_address, virtual_address,
                  len(prelude), len(prelude), PAGE):
        raise AssertionError("output PT_LOAD mismatch")

    facts = {
        "append_padding_size": file_offset - len(source),
        "entry": {"original": ORIGINAL_ENTRY, "patched": virtual_address},
        "interpreter": INTERPRETER[:-1].decode("ascii"),
        "output": {"sha256": sha256(result), "size": len(result)},
        "replaced_note": {
            "bytes_remain_in_read_only_load": True,
            "records": _parse_pinned_notes(source[phdrs[NOTE_INDEX][2]:phdrs[NOTE_INDEX][2] + phdrs[NOTE_INDEX][5]]),
            "sha256": NOTE_SHA256,
        },
        "program_header": {
            "alignment": PAGE, "file_offset": file_offset, "file_size": len(prelude),
            "flags": 5, "index": NOTE_INDEX, "memory_size": len(prelude),
            "type": "PT_LOAD", "virtual_address": virtual_address,
        },
        "source": {"sha256": SOURCE_SHA256, "size": SOURCE_SIZE},
    }
    return bytes(result), facts

def canonical_manifest(*, facts: dict, prelude_template: bytes, prelude: bytes,
                       prelude_source: bytes, patcher_source: bytes,
                       builder_source: bytes, coding_script_expected_sha256: str,
                       coding_script_actual_sha256: str,
                       coding_script_size: int) -> bytes:
    manifest = {
        "build": {
            "algorithm": "bind-coding-digest-and-replace-exact-pt-note-v2",
            "builder_sha256": sha256(builder_source),
            "patcher_sha256": sha256(patcher_source),
            "prelude_consumption": "one exact digest sentinel replaced in an owned template copy",
            "prelude_provenance": {
                "compile_argv": ["clang", "-target", "x86_64-linux-gnu", "-c", "-o", "prelude.o", "prelude.S"],
                "compiler": "Apple clang 21.0.0 (clang-2100.1.1.101)",
                "extractor": "Python 3 struct-based exact ELF .text extraction",
                "relocation_section_types_forbidden": [4, 9],
            },
        },
        "elf": facts,
        "inputs": {
            "audit_sha256": "99111d95849f88da5e5263bf42203a312a9de4de0c0dace90cd966835c0738ef",
            "design_sha256": "ec846e68948e0a8f121efe42003a987a58db7513cfeba6196ad2ef84fde68f71",
            "offline_image": "python@sha256:cec9aa7aa96eea4fa036e9b82be1e6b325f2e3707f462d885868df51ec0a4b47",
            "provenance_audit_sha256": "fe0a425b9f610cd1823be958fcd7814af781b272522c1205ef9058f5d4369790",
        },
        "install": {"gid": 65533, "mode": "2755", "nlink": 1, "uid": 0},
        "prelude": {
            "bound_binary_sha256": sha256(prelude),
            "bound_binary_size": len(prelude),
            "source_sha256": sha256(prelude_source),
            "source_size": len(prelude_source),
            "template_sha256": sha256(prelude_template),
            "template_size": len(prelude_template),
        },
        "protocol": {
            "binary_path": "/opt/prime-agent-sandbox-v26/prime-agent",
            "cap_last_cap": 40,
            "challenge": {"body_size": 64, "frame_size": 112, "header_sha256": "872bfcc61d412a587777df78520c2fe60708509563060431def715eb547093ed"},
            "coding_script": {
                "actual_sha256": coding_script_actual_sha256,
                "expected_sha256": coding_script_expected_sha256,
                "path": "/opt/prime-agent-sandbox-v26/prime-agent-coding-v26.js",
                "size": coding_script_size,
            },
            "framing_magic": "PARIPV25",
            "hello": {"body_size": 128, "frame_size": 176, "header_sha256": "8ff17ac4e2d61224cf4603777cd6487ea65f39398dbfa5f7e89bd2bdb41486de"},
            "ready": {"body_size": 0, "frame_size": 48, "header_sha256": "47aa15654574dddf42b6cb5d41f594e033187be9bb92f484ec2badf5ad1e7ef0"},
            "version": 1,
        },
        "schema": "prime-agent-sandbox-runtime-v26-patched-bun-manifest-v2",
    }
    return (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _existing(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def _fsync_directory(directory: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(directory, flags)
    try:
        try:
            os.fsync(fd)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(fd)


def _create_temp(destination: Path, payload: bytes, mode: int) -> tuple[Path, tuple[int, int]]:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    for counter in range(128):
        temp = destination.with_name(
            f".{destination.name}.tmp-{os.getpid()}-{counter:02x}"
        )
        try:
            fd = os.open(temp, flags, 0o600)
        except FileExistsError:
            continue
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short temporary output write")
                view = view[written:]
            os.fchmod(fd, mode)
            info = os.fstat(fd)
            if info.st_nlink != 1 or not stat.S_ISREG(info.st_mode):
                raise ValidationError("temporary output is not a private regular file")
            os.fsync(fd)
        except BaseException:
            try:
                os.close(fd)
            finally:
                temp.unlink(missing_ok=True)
            raise
        try:
            os.close(fd)
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
        return temp, (info.st_dev, info.st_ino)
    raise ValidationError("could not allocate a bounded unique temporary output")


def _unlink_if_ours(destination: Path, identity: tuple[int, int]) -> None:
    try:
        info = destination.lstat()
        if (info.st_dev, info.st_ino) == identity:
            destination.unlink()
    except FileNotFoundError:
        pass


def _validate_published(destination: Path, identity: tuple[int, int], mode: int) -> None:
    info = destination.lstat()
    if ((info.st_dev, info.st_ino) != identity or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode):
        raise ValidationError("published destination identity or metadata mismatch")


def write_outputs(output: Path, manifest_path: Path, patched: bytes, manifest: bytes) -> None:
    output = Path(output)
    manifest_path = Path(manifest_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    output = output.parent.resolve(strict=True) / output.name
    manifest_path = manifest_path.parent.resolve(strict=True) / manifest_path.name
    if output == manifest_path:
        raise ValidationError("output and manifest destinations alias")
    if _existing(output) or _existing(manifest_path):
        raise ValidationError("output destinations must not exist")

    pairs: list[tuple[Path, Path, tuple[int, int], int]] = []
    published: list[tuple[Path, tuple[int, int]]] = []
    directories = sorted({output.parent, manifest_path.parent}, key=str)
    try:
        output_temp, output_identity = _create_temp(output, patched, 0o755)
        pairs.append((output, output_temp, output_identity, 0o755))
        manifest_temp, manifest_identity = _create_temp(manifest_path, manifest, 0o644)
        pairs.append((manifest_path, manifest_temp, manifest_identity, 0o644))
        if _existing(output) or _existing(manifest_path):
            raise ValidationError("output destination appeared during publication")
        for destination, temp, identity, _ in pairs:
            os.link(temp, destination, follow_symlinks=False)
            published.append((destination, identity))
        for directory in directories:
            _fsync_directory(directory)
        for _, temp, _, _ in pairs:
            temp.unlink()
        for destination, _, identity, mode in pairs:
            _validate_published(destination, identity, mode)
        for directory in directories:
            _fsync_directory(directory)
    except BaseException:
        for destination, identity in reversed(published):
            _unlink_if_ours(destination, identity)
        for _, temp, _, _ in pairs:
            temp.unlink(missing_ok=True)
        for directory in directories:
            try:
                _fsync_directory(directory)
            except OSError:
                pass
        raise
