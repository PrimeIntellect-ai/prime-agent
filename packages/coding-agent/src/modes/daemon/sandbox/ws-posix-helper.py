#!/usr/bin/env python3
"""Fd-relative POSIX implementation of the Workspace Authority V21 protocol."""

import ctypes
import errno
import fcntl
import hashlib
import os
import resource
import stat
import struct
import sys

OPEN_ROOT = 0xFE
BEGIN_PLAN = 0x01
PLAN_ENTRY = 0x02
SEAL_PLAN = 0x03
BEGIN_STAGE = 0x04
CONTENT = 0x05
PREFLIGHT = 0x06
BACKUP = 0x07
PREPARE = 0x08
COMMIT = 0x09
APPLY = 0x0A
VERIFY = 0x0B
CLEANUP = 0x0C
FINALIZE = 0x0D
RECOVER = 0x0E
SUPPLY_EVIDENCE = 0x0F
REPLAY_PLAN = 0x10
QUIT = 0xFF

OK = 0x00
UNCERTAIN = 0x01
ERROR = 0x02
READY = 0x03
STAGED = 0x04
SEALED = 0x05
PREPARED = 0x06
COMMIT_ACK = 0x07
APPLIED = 0x08
VERIFIED = 0x09
CLEANUP_DONE = 0x0A
FINALIZED = 0x0B
COMMIT_PENDING = 0x0C
ABSENT = 0x0D
NEED_EVIDENCE = 0x0E

REASON_LOCK = 0x01
REASON_PATH = 0x02
REASON_PLAN = 0x03
REASON_PREIMAGE = 0x04
REASON_STAGE = 0x05
REASON_BACKUP = 0x06
REASON_IO = 0x07
REASON_VERIFY = 0x08
REASON_JOURNAL = 0x09
REASON_PRIVATE_DIR = 0x0A
REASON_COLLISION = 0x0B
REASON_EVIDENCE = 0x0C
REASON_TOMBSTONE = 0x0D
REASON_INTERNAL = 0x0E
REASON_QUIESCENCE = 0x0F
REASON_UNKNOWN = 0xFF

ERR_ORDER = 0x01
ERR_FORMAT = 0x02
ERR_LIMIT = 0x03
ERR_CRYPTO = 0x04
ERR_NOT_FOUND = 0x05

HEADER_SIZE = 5
MAX_PAYLOAD = 1_048_576
MAX_CHUNK = 262_144
MAX_ENTRIES = 1024
MAX_TOTAL_BYTES = 1 << 30
MAX_DIRS = 4096
MAX_JOURNAL_BYTES = 32 << 20
MAX_CHAIN = 32763
PRIVATE_ROOT = b"\x01prime-agent-ws-v1"
TOMBSTONE = b"\x01prime-agent-ws-tombstone"
TOMBSTONE_TEMP = b".tmp-prime-agent-ws-tombstone"
SUBDIRS = (b"journal", b"stage", b"install", b"backup")
MAX_SEALED_STAGES = MAX_CHAIN
FIXED_TRANSACTION_FDS = 3 + 1 + len(SUBDIRS) + 3
ZERO32 = b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
DOMAIN_PLAN = b"PLN\x00"
DOMAIN_PLAN_ENTRY = b"PEN\x00"
DOMAIN_ENTRY_AGG = b"EAG\x00"
DOMAIN_EVIDENCE_VEC = b"EVV\x00"
DOMAIN_ABSENT = b"ABS\x00"


class Failure(Exception):
    def __init__(self, status_code, detail_code):
        super().__init__()
        self.status_code = status_code
        self.detail_code = detail_code


class Missing(Exception):
    """An exact ENOENT during a retained descriptor walk."""


_LIBC = ctypes.CDLL(None, use_errno=True)
_OPENAT = _LIBC.openat
_OPENAT.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int)
_OPENAT.restype = ctypes.c_int
_MKDIRAT = _LIBC.mkdirat
_MKDIRAT.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
_MKDIRAT.restype = ctypes.c_int
_UNLINKAT = _LIBC.unlinkat
_UNLINKAT.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int)
_UNLINKAT.restype = ctypes.c_int
_LINKAT = _LIBC.linkat
_LINKAT.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int)
_LINKAT.restype = ctypes.c_int
_RENAMEAT = _LIBC.renameat
_RENAMEAT.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p)
_RENAMEAT.restype = ctypes.c_int


def _zero(buffer):
    if not isinstance(buffer, bytearray) or not buffer:
        return
    pointer = (ctypes.c_char * len(buffer)).from_buffer(buffer)
    try:
        ctypes.memset(ctypes.addressof(pointer), 0, len(buffer))
    finally:
        del pointer


def _zero_region(buffer, start, length):
    if length <= 0:
        return
    pointer = (ctypes.c_char * len(buffer)).from_buffer(buffer)
    try:
        ctypes.memset(ctypes.addressof(pointer) + start, 0, length)
    finally:
        del pointer


def _zero_owned(value, seen=None):
    owners = set() if seen is None else seen
    identity = id(value)
    if identity in owners:
        return
    owners.add(identity)
    if isinstance(value, memoryview):
        owner = value.obj
        value.release()
        _zero_owned(owner, owners)
    elif isinstance(value, bytearray):
        _zero(value)
    elif isinstance(value, dict):
        for item in tuple(value.values()):
            _zero_owned(item, owners)
        value.clear()
    elif isinstance(value, (list, tuple)):
        for item in value:
            _zero_owned(item, owners)
        if isinstance(value, list):
            value.clear()
    elif isinstance(value, set):
        value.clear()


def _zero_transaction_state(fds, state, phase):
    stages_closed = _release_stage_fds(fds, state)
    preserved = {
        "phase": phase,
        "terminal": True,
        "root_fd": state.get("root_fd"),
        "root_dev": state.get("root_dev"),
        "root_identity": state.get("root_identity"),
        "root_chain": state.get("root_chain"),
    }
    for key, value in list(state.items()):
        if key not in ("root_fd", "root_dev", "root_identity", "root_chain"):
            _zero_owned(value)
    state.clear()
    state.update(preserved)
    return stages_closed


def _read_exact(fd, length):
    owned = bytearray(length)
    view = memoryview(owned)
    offset = 0
    try:
        while offset < length:
            piece = view[offset:]
            try:
                try:
                    count = os.readv(fd, [piece])
                except InterruptedError:
                    continue
            finally:
                piece.release()
            if count == 0:
                _zero(owned)
                return None if offset == 0 else False
            offset += count
        return owned
    except BaseException:
        _zero(owned)
        raise
    finally:
        view.release()


def _write_all(fd, data):
    view = memoryview(data)
    offset = 0
    try:
        while offset < len(data):
            piece = view[offset:]
            try:
                try:
                    count = os.write(fd, piece)
                except InterruptedError:
                    continue
            finally:
                piece.release()
            if count <= 0:
                raise Failure(UNCERTAIN, REASON_IO)
            offset += count
    finally:
        view.release()


def _response(fd, status_code, payload=None):
    payload_view = memoryview(bytearray() if payload is None else payload)
    frame = bytearray(HEADER_SIZE + len(payload_view))
    try:
        struct.pack_into(">BI", frame, 0, status_code, len(payload_view))
        frame[HEADER_SIZE:] = payload_view
        _write_all(fd, frame)
    finally:
        payload_view.release()
        _zero(frame)


def _failure_response(fd, failure):
    detail = bytearray(1)
    try:
        detail[0] = failure.detail_code
        _response(fd, failure.status_code, detail)
    finally:
        _zero(detail)


def _sha256(data):
    # CPython returns an immutable digest; copy it immediately and retain only the mutable owner.
    return bytearray(hashlib.sha256(data).digest())


def _sha256_hex(data):
    digest = _sha256(data)
    alphabet = b"0123456789abcdef"
    result = bytearray(64)
    try:
        for index, value in enumerate(digest):
            result[index * 2] = alphabet[value >> 4]
            result[index * 2 + 1] = alphabet[value & 0x0F]
        return result
    finally:
        _zero(digest)


def _u16(value):
    result = bytearray(2)
    struct.pack_into(">H", result, 0, value)
    return result


def _u32(value):
    result = bytearray(4)
    struct.pack_into(">I", result, 0, value)
    return result


def _u64(value):
    result = bytearray(8)
    struct.pack_into(">Q", result, 0, value)
    return result


def _concat(parts):
    total = 0
    for part in parts:
        total += len(part)
    result = bytearray(total)
    offset = 0
    for part in parts:
        result[offset:offset + len(part)] = part
        offset += len(part)
    return result


def _concat_with_separator(parts, separator):
    result = bytearray()
    for index, part in enumerate(parts):
        if index:
            result.extend(separator)
        result.extend(part)
    return result


def _domain_hash(prefix, parts):
    digest = hashlib.sha256()
    digest.update(prefix)
    size = bytearray(8)
    try:
        for part in parts:
            struct.pack_into(">Q", size, 0, len(part))
            digest.update(size)
            digest.update(part)
        # CPython returns an immutable digest; copy it immediately and retain only the mutable owner.
        return bytearray(digest.digest())
    finally:
        _zero(size)


def _absence(path):
    size = _u16(len(path))
    try:
        return _domain_hash(DOMAIN_ABSENT, (size, path))
    finally:
        _zero(size)


def _entry_digest(entry):
    kind = bytearray((entry["kind"],))
    path_size = _u16(len(entry["path"]))
    pre_size = _u32(entry["pre_size"])
    pre_mode = _u16(entry["pre_mode"])
    post_size = _u32(entry["post_size"])
    post_mode = _u16(entry["post_mode"])
    owners = (kind, path_size, pre_size, pre_mode, post_size, post_mode)
    try:
        return _domain_hash(DOMAIN_PLAN_ENTRY, (
            kind, path_size, entry["path"], entry["pre_digest"], pre_size,
            pre_mode, entry["post_digest"], post_size, post_mode,
        ))
    finally:
        for owner in owners:
            _zero(owner)


def _valid_absolute_path(raw):
    if len(raw) < 2 or len(raw) > 4096 or raw[0] != 0x2F or raw[-1] == 0x2F:
        return None
    try:
        # CPython's UTF-8 validator returns a momentary immutable string; it is not bound or retained.
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    spans = []
    start = 1
    for index in range(1, len(raw) + 1):
        if index != len(raw) and raw[index] != 0x2F:
            if raw[index] == 0:
                return None
            continue
        length = index - start
        if length < 1 or length > 255:
            return None
        if length == 1 and raw[start] == 0x2E:
            return None
        if length == 2 and raw[start] == 0x2E and raw[start + 1] == 0x2E:
            return None
        spans.append((start, index))
        start = index + 1
    parts = []
    view = memoryview(raw)
    try:
        for begin, finish in spans:
            component = view[begin:finish]
            try:
                parts.append(bytearray(component))
            finally:
                component.release()
        return parts
    except BaseException:
        _zero_owned(parts)
        raise
    finally:
        view.release()
        spans.clear()


def _validate_workspace_path(raw):
    if not raw or len(raw) > 4096 or raw[0] == 0x2F or raw[-1] == 0x2F:
        raise Failure(UNCERTAIN, REASON_PATH)
    component_length = 0
    component_count = 1
    component_start = 0
    for index, value in enumerate(raw):
        if value == 0x2F:
            if component_length == 0 or component_length > 255:
                raise Failure(UNCERTAIN, REASON_PATH)
            if component_length == 1 and raw[component_start] == 0x2E:
                raise Failure(UNCERTAIN, REASON_PATH)
            if component_length == 2 and raw[component_start] == 0x2E and raw[component_start + 1] == 0x2E:
                raise Failure(UNCERTAIN, REASON_PATH)
            component_count += 1
            component_length = 0
            component_start = index + 1
        else:
            if value < 0x21 or value > 0x7E or value in (0x5C, 0x60):
                raise Failure(UNCERTAIN, REASON_PATH)
            component_length += 1
    if component_count > 64 or component_length == 0 or component_length > 255:
        raise Failure(UNCERTAIN, REASON_PATH)
    if component_length == 1 and raw[component_start] == 0x2E:
        raise Failure(UNCERTAIN, REASON_PATH)
    if component_length == 2 and raw[component_start] == 0x2E and raw[component_start + 1] == 0x2E:
        raise Failure(UNCERTAIN, REASON_PATH)


def _workspace_parts(raw):
    _validate_workspace_path(raw)
    spans = []
    start = 0
    for index in range(len(raw) + 1):
        if index == len(raw) or raw[index] == 0x2F:
            spans.append((start, index))
            start = index + 1
    parts = []
    view = memoryview(raw)
    try:
        for begin, finish in spans:
            component = view[begin:finish]
            try:
                parts.append(bytearray(component))
            finally:
                component.release()
        return parts
    except BaseException:
        _zero_owned(parts)
        raise
    finally:
        view.release()
        spans.clear()


def _validate_component(path):
    length = len(path)
    if length < 1 or length > 255:
        raise OSError(errno.EINVAL, "invalid path component")
    if length == 1 and path[0] == 0x2E:
        raise OSError(errno.EINVAL, "invalid path component")
    if length == 2 and path[0] == 0x2E and path[1] == 0x2E:
        raise OSError(errno.EINVAL, "invalid path component")
    for value in path:
        if value in (0, 0x2F):
            raise OSError(errno.EINVAL, "invalid path component")


def _with_path_buffer(path, operation):
    _validate_component(path)
    owned = bytearray(len(path) + 1)
    owned[:len(path)] = path
    array_type = ctypes.c_char * len(owned)
    pointer = array_type.from_buffer(owned)
    try:
        return operation(pointer)
    finally:
        del pointer
        _zero(owned)


def _openat(dir_fd, path, flags, mode=0):
    if flags & os.O_CREAT:
        if mode != 0o600:
            raise OSError(errno.EINVAL, "invalid openat mode")
    elif mode != 0:
        raise OSError(errno.EINVAL, "invalid openat mode")

    def invoke(pointer):
        if flags & os.O_CREAT:
            result = _OPENAT(dir_fd, pointer, flags, ctypes.c_uint(mode))
        else:
            result = _OPENAT(dir_fd, pointer, flags)
        if result < 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, "openat failed")
        return result
    return _with_path_buffer(path, invoke)


def _mkdirat(dir_fd, path, mode):
    if mode != 0o700:
        raise OSError(errno.EINVAL, "invalid mkdirat mode")

    def invoke(pointer):
        result = _MKDIRAT(dir_fd, pointer, mode)
        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, "mkdirat failed")
    _with_path_buffer(path, invoke)


def _unlinkat(dir_fd, path, flags=0):
    if flags != 0:
        raise OSError(errno.EINVAL, "invalid unlinkat flags")

    def invoke(pointer):
        result = _UNLINKAT(dir_fd, pointer, flags)
        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, "unlinkat failed")
    _with_path_buffer(path, invoke)


def _linkat(source_fd, source, target_fd, target):
    _validate_component(source)
    _validate_component(target)
    source_owned = bytearray(len(source) + 1)
    target_owned = bytearray(len(target) + 1)
    source_owned[:len(source)] = source
    target_owned[:len(target)] = target
    source_type = ctypes.c_char * len(source_owned)
    target_type = ctypes.c_char * len(target_owned)
    source_pointer = source_type.from_buffer(source_owned)
    target_pointer = target_type.from_buffer(target_owned)
    try:
        result = _LINKAT(source_fd, source_pointer, target_fd, target_pointer, 0)
        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, "linkat failed")
    finally:
        del source_pointer
        del target_pointer
        _zero(source_owned)
        _zero(target_owned)


def _renameat(source_fd, source, target_fd, target):
    _validate_component(source)
    _validate_component(target)
    source_owned = bytearray(len(source) + 1)
    target_owned = bytearray(len(target) + 1)
    source_owned[:len(source)] = source
    target_owned[:len(target)] = target
    source_type = ctypes.c_char * len(source_owned)
    target_type = ctypes.c_char * len(target_owned)
    source_pointer = source_type.from_buffer(source_owned)
    target_pointer = target_type.from_buffer(target_owned)
    try:
        result = _RENAMEAT(source_fd, source_pointer, target_fd, target_pointer)
        if result != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, "renameat failed")
    finally:
        del source_pointer
        del target_pointer
        _zero(source_owned)
        _zero(target_owned)


def _track(fds, fd):
    fds[fd] = fd
    return fd


def _close(fds, fd):
    if fd not in fds:
        return
    del fds[fd]
    try:
        os.close(fd)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)


def _close_all(fds):
    good = True
    for fd in list(fds):
        del fds[fd]
        try:
            os.close(fd)
        except OSError:
            good = False
    return good


def _release_stage_fds(fds, state):
    stages = state.get("staged")
    current = state.get("stage")
    owners = []
    if isinstance(current, dict):
        owners.append(current)
    if isinstance(stages, list):
        owners.extend(stages)
    good = True
    seen = set()
    for owner in owners:
        identity = id(owner)
        if identity in seen:
            continue
        seen.add(identity)
        fd = owner.get("fd")
        owner["fd"] = None
        if isinstance(fd, int):
            try:
                _close(fds, fd)
            except Failure:
                good = False
        _zero_owned(owner)
    owners.clear()
    seen.clear()
    if isinstance(stages, list):
        stages.clear()
    state["stage"] = None
    return good


def _preflight_descriptor_capacity(fds, count):
    if count < 1 or count > MAX_SEALED_STAGES:
        raise Failure(ERROR, ERR_LIMIT)
    required = len(fds) + FIXED_TRANSACTION_FDS + count
    try:
        soft_limit, hard_limit = resource.getrlimit(resource.RLIMIT_NOFILE)
    except (OSError, ValueError):
        raise Failure(UNCERTAIN, REASON_IO)
    infinite = resource.RLIM_INFINITY
    if (soft_limit != infinite and required > soft_limit) or (hard_limit != infinite and required > hard_limit):
        raise Failure(ERROR, ERR_LIMIT)


def _verify_dir(st_value, state, mode=0o700, root_prefix=False):
    valid_owner = st_value.st_uid in (0, os.getuid()) if root_prefix else st_value.st_uid == os.getuid()
    valid_mode = (stat.S_IMODE(st_value.st_mode) & 0o022) == 0 if root_prefix else stat.S_IMODE(st_value.st_mode) == mode
    if (
        not stat.S_ISDIR(st_value.st_mode)
        or not valid_owner
        or not valid_mode
        or st_value.st_nlink < 2
        or (state.get("root_dev") is not None and not root_prefix and st_value.st_dev != state["root_dev"])
    ):
        raise Failure(UNCERTAIN, REASON_INTERNAL)


def _verify_file(st_value, state, nlinks=(1,), reason=REASON_INTERNAL):
    if (
        not stat.S_ISREG(st_value.st_mode)
        or st_value.st_uid != os.getuid()
        or stat.S_IMODE(st_value.st_mode) != 0o600
        or st_value.st_nlink not in nlinks
        or st_value.st_dev != state["root_dev"]
    ):
        raise Failure(UNCERTAIN, reason)


def _same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _stat_via_open(dir_fd, name):
    fd = _openat(dir_fd, name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        return os.fstat(fd)
    finally:
        try:
            os.close(fd)
        except OSError:
            raise Failure(UNCERTAIN, REASON_IO)


def _stat_name(dir_fd, name, missing=False, reason=REASON_IO):
    try:
        return _stat_via_open(dir_fd, name)
    except FileNotFoundError:
        if missing:
            return None
        raise Missing()
    except OSError:
        raise Failure(UNCERTAIN, reason)


def _bind_name(dir_fd, name, fd, state, nlinks=(1,), reason=REASON_INTERNAL, directory=False, root_prefix=False):
    fd_stat = os.fstat(fd)
    name_stat = _stat_name(dir_fd, name, reason=reason)
    if not _same_inode(fd_stat, name_stat):
        raise Failure(UNCERTAIN, reason)
    if directory:
        _verify_dir(fd_stat, state, root_prefix=root_prefix)
        _verify_dir(name_stat, state, root_prefix=root_prefix)
    else:
        _verify_file(fd_stat, state, nlinks=nlinks, reason=reason)
        _verify_file(name_stat, state, nlinks=nlinks, reason=reason)
    return fd_stat


def _dir_metadata(st_value):
    return (st_value.st_uid, stat.S_IFMT(st_value.st_mode), stat.S_IMODE(st_value.st_mode))


def _stage_metadata(st_value):
    return (
        st_value.st_uid,
        stat.S_IFMT(st_value.st_mode),
        stat.S_IMODE(st_value.st_mode),
        st_value.st_nlink,
        st_value.st_size,
    )


def _bind_sealed_stage(state, owner):
    fd = owner.get("fd")
    if not isinstance(fd, int):
        raise Failure(UNCERTAIN, REASON_STAGE)
    try:
        found = _bind_name(state["dir_fds"]["stage"], owner["name"], fd, state, reason=REASON_STAGE)
    except Missing:
        raise Failure(UNCERTAIN, REASON_STAGE)
    if found.st_dev != owner.get("dev") or found.st_ino != owner.get("ino"):
        raise Failure(UNCERTAIN, REASON_STAGE)
    if _stage_metadata(found) != owner.get("metadata"):
        raise Failure(UNCERTAIN, REASON_STAGE)
    return found


def _verify_stage_bindings(state):
    current = state.get("stage")
    if isinstance(current, dict) and "dev" in current:
        _bind_sealed_stage(state, current)
    stages = state.get("staged")
    if isinstance(stages, list):
        if len(stages) > MAX_SEALED_STAGES:
            raise Failure(ERROR, ERR_LIMIT)
        for owner in stages:
            _bind_sealed_stage(state, owner)


def _verify_root_chain(chain, state):
    if not chain:
        raise Failure(UNCERTAIN, REASON_PATH)
    slash = chain[0]
    slash_stat = os.fstat(slash["fd"])
    _verify_dir(slash_stat, state, root_prefix=True)
    if (slash_stat.st_dev, slash_stat.st_ino) != slash["identity"] or _dir_metadata(slash_stat) != slash["metadata"]:
        raise Failure(UNCERTAIN, REASON_PATH)
    for index in range(1, len(chain)):
        parent = chain[index - 1]
        child = chain[index]
        try:
            child_stat = _bind_name(
                parent["fd"], child["name"], child["fd"], state,
                reason=REASON_PATH, directory=True, root_prefix=child["root_prefix"],
            )
        except Missing:
            raise Failure(UNCERTAIN, REASON_PATH)
        if (child_stat.st_dev, child_stat.st_ino) != child["identity"] or _dir_metadata(child_stat) != child["metadata"]:
            raise Failure(UNCERTAIN, REASON_PATH)
    final = chain[-1]
    final_stat = os.fstat(final["fd"])
    if (final_stat.st_dev, final_stat.st_ino) != state["root_identity"]:
        raise Failure(UNCERTAIN, REASON_PATH)


def _open_root(fds, state, raw):
    parts = _valid_absolute_path(raw)
    if parts is None:
        raise Failure(ERROR, ERR_FORMAT)
    chain = []
    installed = False
    try:
        slash_fd = _track(fds, os.open(b"/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
        slash_stat = os.fstat(slash_fd)
        _verify_dir(slash_stat, state, root_prefix=True)
        chain.append({
            "fd": slash_fd,
            "name": None,
            "identity": (slash_stat.st_dev, slash_stat.st_ino),
            "metadata": _dir_metadata(slash_stat),
            "root_prefix": True,
        })
        current = slash_fd
        for index, part in enumerate(parts):
            try:
                child_fd = _track(
                    fds,
                    _openat(current, part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC),
                )
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT, errno.EACCES):
                    raise Failure(ERROR, ERR_FORMAT)
                raise Failure(UNCERTAIN, REASON_IO)
            final = index == len(parts) - 1
            child_stat = _bind_name(
                current, part, child_fd, state,
                reason=REASON_PATH, directory=True, root_prefix=not final,
            )
            chain.append({
                "fd": child_fd,
                "name": part,
                "identity": (child_stat.st_dev, child_stat.st_ino),
                "metadata": _dir_metadata(child_stat),
                "root_prefix": not final,
            })
            parts[index] = None
            current = child_fd
        root_stat = os.fstat(current)
        state["root_dev"] = root_stat.st_dev
        _verify_dir(root_stat, state)
        state["root_identity"] = (root_stat.st_dev, root_stat.st_ino)
        state["root_fd"] = current
        state["root_chain"] = chain
        try:
            fcntl.flock(current, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            raise Failure(UNCERTAIN, REASON_LOCK)
        _verify_root_chain(chain, state)
        state["phase"] = "READY"
        state["recover_unused"] = True
        installed = True
    except Failure:
        raise
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        _zero_owned(parts)
        if not installed:
            _zero_owned(chain)
            state.pop("root_chain", None)
            state["root_fd"] = None
            state["root_dev"] = None
            state["root_identity"] = None


def _verify_root_binding(state):
    _verify_root_chain(state["root_chain"], state)


def _guard_mutation(state):
    _verify_root_binding(state)
    _verify_stage_bindings(state)


def _dup(fds, fd):
    return _track(fds, os.dup(fd))


def _walk_parent(fds, state, path, reason=REASON_INTERNAL):
    parts = _workspace_parts(path)
    current = _dup(fds, state["root_fd"])
    try:
        for part in parts[:-1]:
            try:
                next_fd = _track(
                    fds,
                    _openat(current, part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC),
                )
            except FileNotFoundError:
                raise Missing()
            except OSError:
                raise Failure(UNCERTAIN, reason)
            _bind_name(current, part, next_fd, state, reason=reason, directory=True)
            _close(fds, current)
            current = next_fd
        result = current
        current = None
        return result, bytearray(parts[-1])
    finally:
        _zero_owned(parts)
        if current is not None:
            _close(fds, current)


def _lstat(dir_fd, name, reason=REASON_IO):
    return _stat_name(dir_fd, name, missing=True, reason=reason)


def _read_fd(fd, limit=MAX_PAYLOAD):
    result = bytearray()
    chunk = bytearray(min(65536, limit + 1))
    view = memoryview(chunk)
    try:
        while True:
            allowed = min(len(chunk), limit + 1 - len(result))
            piece = view[:allowed]
            try:
                try:
                    count = os.readv(fd, [piece])
                except InterruptedError:
                    continue
                except OSError:
                    _zero(result)
                    raise Failure(UNCERTAIN, REASON_IO)
            finally:
                piece.release()
            if count == 0:
                return result
            copied = memoryview(chunk)[:count]
            try:
                result.extend(copied)
            finally:
                copied.release()
            _zero_region(chunk, 0, count)
            if len(result) > limit:
                _zero(result)
                raise Failure(ERROR, ERR_LIMIT)
    finally:
        view.release()
        _zero(chunk)


def _open_bound_leaf(fds, state, dir_fd, name, nlinks=(1,), reason=REASON_INTERNAL, flags=None):
    actual_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC if flags is None else flags
    try:
        fd = _track(fds, _openat(dir_fd, name, actual_flags))
    except OSError:
        raise Failure(UNCERTAIN, reason)
    try:
        _bind_name(dir_fd, name, fd, state, nlinks=nlinks, reason=reason)
        return fd
    except BaseException:
        _close(fds, fd)
        raise


def _read_leaf(fds, state, dir_fd, name, limit=MAX_PAYLOAD, reason=REASON_INTERNAL, nlinks=(1,)):
    fd = _open_bound_leaf(fds, state, dir_fd, name, nlinks=nlinks, reason=reason)
    try:
        data = _read_fd(fd, limit)
        _bind_name(dir_fd, name, fd, state, nlinks=nlinks, reason=reason)
        return data
    finally:
        _close(fds, fd)


def _sync_file(state, fd):
    _guard_mutation(state)
    try:
        if hasattr(os, "fdatasync"):
            os.fdatasync(fd)
        else:
            os.fsync(fd)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)


def _make_record(tag, revision, previous, payload):
    result = bytearray(73 + len(payload))
    result[0] = tag
    struct.pack_into(">I", result, 1, revision)
    result[5:37] = previous
    payload_digest = _sha256(payload)
    try:
        result[37:69] = payload_digest
    finally:
        _zero(payload_digest)
    struct.pack_into(">I", result, 69, len(payload))
    result[73:] = payload
    return result


def _validate_journal_path(path):
    try:
        _validate_workspace_path(path)
    except Failure:
        raise Failure(UNCERTAIN, REASON_JOURNAL)


def _validate_entry_schema(payload, journal=False):
    try:
        if len(payload) < 79:
            raise Failure(ERROR, ERR_FORMAT)
        path_length = struct.unpack_from(">H", payload, 1)[0]
        if len(payload) != 79 + path_length:
            raise Failure(ERROR, ERR_FORMAT)
        offset = 3 + path_length
        view = memoryview(payload)
        path_view = view[3:offset]
        pre_view = view[offset:offset + 32]
        post_view = view[offset + 38:offset + 70]
        absent = None
        try:
            _validate_workspace_path(path_view)
            kind = payload[0]
            pre_size = struct.unpack_from(">I", payload, offset + 32)[0]
            pre_mode = struct.unpack_from(">H", payload, offset + 36)[0]
            post_size = struct.unpack_from(">I", payload, offset + 70)[0]
            post_mode = struct.unpack_from(">H", payload, offset + 74)[0]
            absent = _absence(path_view)
            if kind == 0:
                valid = pre_view == absent and pre_size == 0 and pre_mode == 0 and post_mode == 0o600
            elif kind == 1:
                valid = pre_mode == 0o600 and post_view == absent and post_size == 0 and post_mode == 0
            elif kind == 2:
                valid = pre_mode == 0o600 and post_mode == 0o600
            else:
                valid = False
            if not valid or pre_view == ZERO32 or post_view == ZERO32 or pre_view == post_view:
                raise Failure(UNCERTAIN, REASON_PLAN)
            return kind, path_length, pre_size, pre_mode, post_size, post_mode
        finally:
            if absent is not None:
                _zero(absent)
            post_view.release()
            pre_view.release()
            path_view.release()
            view.release()
    except Failure:
        if journal:
            raise Failure(UNCERTAIN, REASON_JOURNAL)
        raise


def _validate_record_payload(tag, payload):
    length = len(payload)
    path_view = None
    try:
        if tag == 0x01:
            valid = length == 104
            if valid:
                count, total = struct.unpack_from(">II", payload, 0)
                header_view = payload[8:104]
                try:
                    valid = count > 0 and count <= MAX_ENTRIES and total <= MAX_TOTAL_BYTES
                    for offset in (0, 32, 64):
                        field = header_view[offset:offset + 32]
                        try:
                            if field == ZERO32:
                                valid = False
                        finally:
                            field.release()
                finally:
                    header_view.release()
        elif tag == 0x02:
            _validate_entry_schema(payload, journal=True)
            valid = True
        elif tag in (0x03, 0x07, 0x0A):
            tail = 1 if tag in (0x07, 0x0A) else 0
            valid = length >= 2 + tail
            if valid:
                path_length = struct.unpack_from(">H", payload, 0)[0]
                valid = length == 2 + path_length + tail
                if valid:
                    path_view = payload[2:2 + path_length]
                    _validate_journal_path(path_view)
                    if tail and payload[2 + path_length] not in (0, 1):
                        valid = False
        elif tag == 0x04:
            valid = length == 40
        elif tag in (0x05, 0x06):
            valid = length == 68
        elif tag in (0x08, 0x09, 0x0C, 0x0D):
            valid = length == 32
        elif tag == 0x0B:
            valid = length == 35 and payload[34] in (1, 2, 3)
        elif tag == 0x0E:
            valid = length == 136
        elif tag == 0x0F:
            valid = length == 32
        else:
            valid = False
        if not valid:
            raise Failure(UNCERTAIN, REASON_JOURNAL)
    finally:
        if path_view is not None:
            path_view.release()


def _parse_record(raw):
    if len(raw) < 73:
        raise Failure(UNCERTAIN, REASON_JOURNAL)
    payload_length = struct.unpack_from(">I", raw, 69)[0]
    if len(raw) != 73 + payload_length:
        raise Failure(UNCERTAIN, REASON_JOURNAL)
    tag = raw[0]
    revision = struct.unpack_from(">I", raw, 1)[0]
    view = memoryview(raw)
    previous = view[5:37]
    expected_hash = view[37:69]
    payload_view = view[73:]
    actual_hash = _sha256(payload_view)
    try:
        if actual_hash != expected_hash:
            raise Failure(UNCERTAIN, REASON_JOURNAL)
        _validate_record_payload(tag, payload_view)
        return tag, revision
    finally:
        _zero(actual_hash)
        payload_view.release()
        expected_hash.release()
        previous.release()
        view.release()


def _rewrite_leaf(fds, state, dir_fd, name, content, reason):
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = _open_bound_leaf(fds, state, dir_fd, name, reason=reason, flags=flags)
    try:
        _bind_name(dir_fd, name, fd, state, reason=reason)
        _guard_mutation(state)
        os.ftruncate(fd, 0)
        _bind_name(dir_fd, name, fd, state, reason=reason)
        _guard_mutation(state)
        _write_all(fd, content)
        _bind_name(dir_fd, name, fd, state, reason=reason)
        _sync_file(state, fd)
        _bind_name(dir_fd, name, fd, state, reason=reason)
        return fd
    except OSError:
        _close(fds, fd)
        raise Failure(UNCERTAIN, reason)
    except BaseException:
        _close(fds, fd)
        raise


def _create_leaf(fds, state, dir_fd, name, content, reason):
    try:
        _guard_mutation(state)
        fd = _track(
            fds,
            _openat(dir_fd, name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600),
        )
    except FileExistsError:
        return _rewrite_leaf(fds, state, dir_fd, name, content, reason)
    except OSError:
        raise Failure(UNCERTAIN, reason)
    try:
        _bind_name(dir_fd, name, fd, state, reason=reason)
        _guard_mutation(state)
        _write_all(fd, content)
        _bind_name(dir_fd, name, fd, state, reason=reason)
        _sync_file(state, fd)
        _bind_name(dir_fd, name, fd, state, reason=reason)
        return fd
    except BaseException:
        _close(fds, fd)
        raise


def _try_open_joint(fds, state, dir_fd, name, reason):
    try:
        fd = _track(fds, _openat(dir_fd, name, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC))
    except FileNotFoundError:
        return None
    except OSError:
        raise Failure(UNCERTAIN, reason)
    try:
        _bind_name(dir_fd, name, fd, state, nlinks=(1, 2), reason=reason)
        return fd
    except BaseException:
        _close(fds, fd)
        raise


def _fd_bytes(fd, limit, reason):
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        return _read_fd(fd, limit)
    except OSError:
        raise Failure(UNCERTAIN, reason)


def _match_fd_content(fd, content, reason):
    actual = _fd_bytes(fd, MAX_TOTAL_BYTES, reason)
    try:
        if actual != content:
            raise Failure(UNCERTAIN, reason)
    finally:
        _zero(actual)


def _publish(fds, state, dir_fd, canonical, content, reason, fixed=False):
    prefix = bytearray(b".tmp-")
    try:
        temporary = bytearray(TOMBSTONE_TEMP) if fixed else _concat((prefix, canonical))
    finally:
        _zero(prefix)
    temp_fd = None
    canon_fd = None
    try:
        temp_fd = _try_open_joint(fds, state, dir_fd, temporary, REASON_INTERNAL)
        canon_fd = _try_open_joint(fds, state, dir_fd, canonical, REASON_INTERNAL)
        if temp_fd is not None and canon_fd is not None:
            temp_stat = _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
            canon_stat = _bind_name(dir_fd, canonical, canon_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
            if not _same_inode(temp_stat, canon_stat):
                raise Failure(UNCERTAIN, reason)
            _match_fd_content(canon_fd, content, reason)
            _guard_mutation(state)
            os.fsync(dir_fd)
            _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
            _bind_name(dir_fd, canonical, canon_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
            _guard_mutation(state)
            _unlinkat(dir_fd, temporary)
            _guard_mutation(state)
            os.fsync(dir_fd)
            if os.fstat(temp_fd).st_nlink != 1:
                raise Failure(UNCERTAIN, reason)
            _bind_name(dir_fd, canonical, canon_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
            return
        if canon_fd is not None:
            _bind_name(dir_fd, canonical, canon_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
            _match_fd_content(canon_fd, content, reason)
            return
        if temp_fd is None:
            temp_fd = _create_leaf(fds, state, dir_fd, temporary, content, reason)
        else:
            _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
            _guard_mutation(state)
            os.ftruncate(temp_fd, 0)
            _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
            _guard_mutation(state)
            _write_all(temp_fd, content)
            _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
            _sync_file(state, temp_fd)
            _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
        _match_fd_content(temp_fd, content, reason)
        _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
        try:
            _guard_mutation(state)
            _linkat(dir_fd, temporary, dir_fd, canonical)
        except FileExistsError:
            raise Failure(UNCERTAIN, REASON_COLLISION)
        canon_fd = _try_open_joint(fds, state, dir_fd, canonical, REASON_INTERNAL)
        if canon_fd is None:
            raise Failure(UNCERTAIN, reason)
        temp_stat = _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
        canon_stat = _bind_name(dir_fd, canonical, canon_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
        _guard_mutation(state)
        os.fsync(dir_fd)
        temp_stat = _bind_name(dir_fd, temporary, temp_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
        canon_stat = _bind_name(dir_fd, canonical, canon_fd, state, nlinks=(2,), reason=REASON_INTERNAL)
        if not _same_inode(temp_stat, canon_stat):
            raise Failure(UNCERTAIN, reason)
        _guard_mutation(state)
        _unlinkat(dir_fd, temporary)
        _guard_mutation(state)
        os.fsync(dir_fd)
        if os.fstat(temp_fd).st_nlink != 1:
            raise Failure(UNCERTAIN, reason)
        _bind_name(dir_fd, canonical, canon_fd, state, nlinks=(1,), reason=REASON_INTERNAL)
        _match_fd_content(canon_fd, content, reason)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        if temp_fd is not None:
            _close(fds, temp_fd)
        if canon_fd is not None:
            _close(fds, canon_fd)
        _zero(temporary)


def _setup_private(fds, state):
    root = state["root_fd"]
    private_name = bytearray(PRIVATE_ROOT)
    try:
        try:
            _guard_mutation(state)
            _mkdirat(root, private_name, 0o700)
        except FileExistsError:
            existing_private = _lstat(root, private_name, REASON_PRIVATE_DIR)
            if existing_private is None:
                raise Failure(UNCERTAIN, REASON_PRIVATE_DIR)
        except OSError:
            raise Failure(UNCERTAIN, REASON_IO)
        try:
            private_fd = _track(fds, _openat(root, private_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
            _bind_name(root, private_name, private_fd, state, reason=REASON_PRIVATE_DIR, directory=True)
            _guard_mutation(state)
            os.fsync(root)
            state["private_fd"] = private_fd
            names = {}
            for subdir_index, name in enumerate(SUBDIRS):
                child_name = bytearray(name)
                try:
                    try:
                        _guard_mutation(state)
                        _mkdirat(private_fd, child_name, 0o700)
                    except FileExistsError:
                        existing_child = _lstat(private_fd, child_name, REASON_PRIVATE_DIR)
                        if existing_child is None:
                            raise Failure(UNCERTAIN, REASON_PRIVATE_DIR)
                    child = _track(fds, _openat(private_fd, child_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
                    _bind_name(private_fd, child_name, child, state, reason=REASON_PRIVATE_DIR, directory=True)
                    _guard_mutation(state)
                    os.fsync(private_fd)
                    names[("journal", "stage", "install", "backup")[subdir_index]] = child
                finally:
                    _zero(child_name)
            state["dir_fds"] = names
        except Failure:
            raise
        except OSError:
            raise Failure(UNCERTAIN, REASON_PRIVATE_DIR)
    finally:
        _zero(private_name)


def _publish_record(fds, state, tag, payload):
    if state["journal_bytes"] + 73 + len(payload) > MAX_JOURNAL_BYTES:
        raise Failure(ERROR, ERR_LIMIT)
    raw = _make_record(tag, len(state["records"]), state["previous_record"], payload)
    digest = _sha256(raw)
    name = _sha256_hex(raw)
    try:
        _publish(fds, state, state["dir_fds"]["journal"], name, raw, REASON_JOURNAL)
        state["records"].append(bytearray(raw))
        _zero(state["previous_record"])
        state["previous_record"] = bytearray(digest)
        state["journal_bytes"] += len(raw)
    finally:
        _zero(name)
        _zero(digest)
        _zero(raw)


def _entry_payload(entry):
    kind = bytearray((entry["kind"],))
    values = (
        kind, _u16(len(entry["path"])), entry["path"], entry["pre_digest"],
        _u32(entry["pre_size"]), _u16(entry["pre_mode"]), entry["post_digest"],
        _u32(entry["post_size"]), _u16(entry["post_mode"]),
    )
    try:
        return _concat(values)
    finally:
        _zero(kind)
        for index in (1, 4, 5, 7, 8):
            _zero(values[index])


def _begin_plan(fds, state, payload):
    state["recover_unused"] = False
    if len(payload) != 104:
        raise Failure(ERROR, ERR_FORMAT)
    count, total = struct.unpack_from(">II", payload, 0)
    if count > MAX_ENTRIES or total > MAX_TOTAL_BYTES:
        raise Failure(ERROR, ERR_LIMIT)
    if count == 0:
        raise Failure(UNCERTAIN, REASON_PLAN)
    view = memoryview(payload)
    tx_view = view[8:40]
    digest_view = view[40:72]
    aggregate_view = view[72:104]
    retained = None
    try:
        if tx_view == ZERO32 or digest_view == ZERO32 or aggregate_view == ZERO32:
            raise Failure(ERROR, ERR_CRYPTO)
        _preflight_descriptor_capacity(fds, count)
        _setup_private(fds, state)
        retained = {"entry_count": count, "total_bytes": total}
        retained["tx_id"] = bytearray(tx_view)
        retained["tx_digest"] = bytearray(digest_view)
        retained["declared_aggregate"] = bytearray(aggregate_view)
        retained["entries"] = []
        retained["paths"] = []
        retained["records"] = []
        retained["previous_record"] = bytearray(32)
        retained["journal_bytes"] = 0
        retained["staged"] = []
        retained["stage"] = None
        state.update(retained)
        retained = None
        _publish_record(fds, state, 0x01, payload)
        state["phase"] = "PLAN"
    finally:
        aggregate_view.release()
        digest_view.release()
        tx_view.release()
        view.release()
        if retained is not None:
            _zero_owned(retained)


def _parse_entry(payload):
    kind, path_length, pre_size, pre_mode, post_size, post_mode = _validate_entry_schema(payload)
    offset = 3 + path_length
    view = memoryview(payload)
    path_view = view[3:offset]
    pre_view = view[offset:offset + 32]
    post_view = view[offset + 38:offset + 70]
    entry = {"kind": kind, "pre_size": pre_size, "pre_mode": pre_mode, "post_size": post_size, "post_mode": post_mode}
    try:
        entry["path"] = bytearray(path_view)
        entry["pre_digest"] = bytearray(pre_view)
        entry["post_digest"] = bytearray(post_view)
        result = entry
        entry = None
        return result
    finally:
        if entry is not None:
            _zero_owned(entry)
        post_view.release()
        pre_view.release()
        path_view.release()
        view.release()


def _plan_entry(fds, state, payload):
    if len(state["entries"]) >= state["entry_count"]:
        raise Failure(ERROR, ERR_LIMIT)
    entry = _parse_entry(payload)
    path = entry["path"]
    slash = bytearray(b"/")
    try:
        for previous in state["paths"]:
            previous_prefix = _concat((previous, slash))
            path_prefix = _concat((path, slash))
            try:
                if previous == path or previous.startswith(path_prefix) or path.startswith(previous_prefix):
                    _zero_owned(entry)
                    raise Failure(UNCERTAIN, REASON_PLAN)
            finally:
                _zero(previous_prefix)
                _zero(path_prefix)
    finally:
        _zero(slash)
    state["paths"].append(bytearray(path))
    entry["digest"] = _entry_digest(entry)
    state["entries"].append(entry)
    _publish_record(fds, state, 0x02, payload)


def _seal_plan(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    if len(state["entries"]) != state["entry_count"]:
        raise Failure(UNCERTAIN, REASON_PLAN)
    total = sum(entry["post_size"] for entry in state["entries"] if entry["kind"] in (0, 2))
    if total != state["total_bytes"]:
        raise Failure(UNCERTAIN, REASON_PLAN)
    ordered = sorted((bytearray(entry["digest"]) for entry in state["entries"]))
    computed_aggregate = _domain_hash(DOMAIN_ENTRY_AGG, ordered)
    _zero_owned(ordered)
    if computed_aggregate != state["declared_aggregate"]:
        _zero(computed_aggregate)
        raise Failure(ERROR, ERR_CRYPTO)
    state["plan_digest"] = _domain_hash(DOMAIN_PLAN, (computed_aggregate,))
    _zero(computed_aggregate)
    directory_set = []
    for entry in state["entries"]:
        path_view = memoryview(entry["path"])
        try:
            for index, value in enumerate(path_view):
                if value != 0x2F:
                    continue
                prefix = path_view[:index]
                try:
                    directory = bytearray(prefix)
                finally:
                    prefix.release()
                if not any(existing == directory for existing in directory_set):
                    directory_set.append(directory)
                else:
                    _zero(directory)
        finally:
            path_view.release()
    directories = sorted(directory_set, key=lambda item: (item.count(b"/"), item))
    if len(directories) > MAX_DIRS:
        _zero_owned(directories)
        raise Failure(ERROR, ERR_LIMIT)
    state["directories"] = directories
    for directory in directories:
        size = _u16(len(directory))
        record_payload = _concat((size, directory))
        try:
            _publish_record(fds, state, 0x03, record_payload)
        finally:
            _zero(size)
            _zero(record_payload)
    counts = bytearray(8)
    struct.pack_into(">II", counts, 0, len(state["entries"]), len(directories))
    sealed = _concat((counts, state["plan_digest"]))
    try:
        _publish_record(fds, state, 0x04, sealed)
    finally:
        _zero(counts)
        _zero(sealed)
    state["phase"] = "SEALED"
    return bytearray(state["plan_digest"])


def _find_stage_entry(state, path, total, digest):
    matches = []
    for entry in state["entries"]:
        if entry["path"] == path and entry["kind"] in (0, 2):
            matches.append(entry)
    if len(matches) != 1:
        raise Failure(UNCERTAIN, REASON_INTERNAL)
    entry = matches[0]
    if total != entry["post_size"] or digest != entry["post_digest"]:
        raise Failure(ERROR, ERR_CRYPTO)
    return entry


def _finish_stage(fds, state):
    current = state["stage"]
    fd = current["fd"]
    stage_fd = state["dir_fds"]["stage"]
    _bind_name(stage_fd, current["name"], fd, state, reason=REASON_STAGE)
    _sync_file(state, fd)
    _bind_name(stage_fd, current["name"], fd, state, reason=REASON_STAGE)
    data = _fd_bytes(fd, MAX_TOTAL_BYTES, REASON_STAGE)
    _bind_name(stage_fd, current["name"], fd, state, reason=REASON_STAGE)
    digest = _sha256(data)
    try:
        if len(data) != current["total"] or digest != current["digest"]:
            raise Failure(UNCERTAIN, REASON_STAGE)
        _guard_mutation(state)
        os.fsync(stage_fd)
        found = _bind_name(stage_fd, current["name"], fd, state, reason=REASON_STAGE)
        current["dev"] = found.st_dev
        current["ino"] = found.st_ino
        current["metadata"] = _stage_metadata(found)
        if len(state["staged"]) >= MAX_SEALED_STAGES:
            raise Failure(ERROR, ERR_LIMIT)
        size = _u32(current["total"])
        record_payload = _concat((current["path_sha"], digest, size))
        try:
            _publish_record(fds, state, 0x05, record_payload)
        finally:
            _zero(size)
            _zero(record_payload)
        _bind_sealed_stage(state, current)
        state["staged"].append(current)
        state["stage"] = None
        state["phase"] = "SEALED"
        return _concat((current["path_sha"], digest))
    finally:
        _zero(digest)
        _zero(data)


def _begin_stage(fds, state, payload):
    if len(payload) < 38:
        raise Failure(ERROR, ERR_FORMAT)
    path_length = struct.unpack_from(">H", payload, 0)[0]
    if len(payload) != 38 + path_length:
        raise Failure(ERROR, ERR_FORMAT)
    total = struct.unpack_from(">I", payload, 2 + path_length)[0]
    view = memoryview(payload)
    path_view = view[2:2 + path_length]
    digest_view = view[6 + path_length:38 + path_length]
    retained = None
    fd = None
    try:
        _validate_workspace_path(path_view)
        _find_stage_entry(state, path_view, total, digest_view)
        if len(state["staged"]) >= MAX_SEALED_STAGES:
            raise Failure(ERROR, ERR_LIMIT)
        if any(path_view == staged["path"] for staged in state["staged"]):
            raise Failure(UNCERTAIN, REASON_COLLISION)
        retained = {"total": total, "offset": 0, "fd": None}
        retained["path"] = bytearray(path_view)
        retained["digest"] = bytearray(digest_view)
        retained["name"] = _sha256_hex(path_view)
        retained["path_sha"] = _sha256(path_view)
        name = retained["name"]
        stage_fd = state["dir_fds"]["stage"]
        try:
            _guard_mutation(state)
            fd = _track(fds, _openat(stage_fd, name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600))
        except FileExistsError:
            empty = bytearray()
            try:
                fd = _rewrite_leaf(fds, state, stage_fd, name, empty, REASON_STAGE)
            finally:
                _zero(empty)
        except OSError:
            raise Failure(UNCERTAIN, REASON_IO)
        _bind_name(stage_fd, name, fd, state, reason=REASON_STAGE)
        retained["fd"] = fd
        state["stage"] = retained
        retained = None
        state["phase"] = "STAGING"
        if total == 0:
            return _finish_stage(fds, state)
        return None
    finally:
        digest_view.release()
        path_view.release()
        view.release()
        if retained is not None:
            _zero_owned(retained)


def _content(fds, state, payload):
    if len(payload) < 36:
        raise Failure(ERROR, ERR_FORMAT)
    view = memoryview(payload)
    path_sha = view[:32]
    chunk = view[36:]
    try:
        if len(chunk) > MAX_CHUNK:
            raise Failure(ERROR, ERR_LIMIT)
        current = state["stage"]
        offset = struct.unpack_from(">I", payload, 32)[0]
        if path_sha != current["path_sha"]:
            raise Failure(ERROR, ERR_CRYPTO)
        if offset != current["offset"] or offset + len(chunk) > current["total"]:
            raise Failure(ERROR, ERR_FORMAT)
        stage_fd = state["dir_fds"]["stage"]
        _bind_name(stage_fd, current["name"], current["fd"], state, reason=REASON_STAGE)
        _guard_mutation(state)
        _write_all(current["fd"], chunk)
        _bind_name(stage_fd, current["name"], current["fd"], state, reason=REASON_STAGE)
        _sync_file(state, current["fd"])
        _bind_name(stage_fd, current["name"], current["fd"], state, reason=REASON_STAGE)
        current["offset"] += len(chunk)
        if current["offset"] == current["total"]:
            return _finish_stage(fds, state)
        if not chunk:
            raise Failure(ERROR, ERR_FORMAT)
        return None
    finally:
        chunk.release()
        path_sha.release()
        view.release()


def _read_target(fds, state, entry, reason):
    try:
        parent, leaf = _walk_parent(fds, state, entry["path"], reason)
    except Missing:
        raise Failure(UNCERTAIN, reason)
    try:
        return _read_leaf(fds, state, parent, leaf, MAX_TOTAL_BYTES, reason)
    finally:
        _zero(leaf)
        _close(fds, parent)


def _preflight(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    required = []
    for entry in state["entries"]:
        if entry["kind"] in (0, 2):
            required.append(entry["path"])
    if len(required) != len(state["staged"]) or any(
        not any(path == staged["path"] for staged in state["staged"]) for path in required
    ):
        raise Failure(UNCERTAIN, REASON_STAGE)
    _verify_stage_bindings(state)
    for entry in state["entries"]:
        if entry["kind"] not in (1, 2):
            continue
        data = _read_target(fds, state, entry, REASON_PREIMAGE)
        digest = _sha256(data)
        try:
            if len(data) != entry["pre_size"] or digest != entry["pre_digest"]:
                raise Failure(UNCERTAIN, REASON_PREIMAGE)
        finally:
            _zero(digest)
            _zero(data)
    _verify_stage_bindings(state)
    state["phase"] = "PREFLIGHT"


def _publish_artifact(fds, state, directory, name, content, reason):
    _publish(fds, state, state["dir_fds"][directory], name, content, reason)


def _backup(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    for entry in state["entries"]:
        if entry["kind"] not in (1, 2):
            continue
        data = _read_target(fds, state, entry, REASON_BACKUP)
        digest = _sha256(data)
        path_sha = _sha256(entry["path"])
        name = _sha256_hex(entry["path"])
        size = _u32(len(data))
        record_payload = _concat((path_sha, digest, size))
        try:
            if len(data) != entry["pre_size"] or digest != entry["pre_digest"]:
                raise Failure(UNCERTAIN, REASON_BACKUP)
            _publish_artifact(fds, state, "backup", name, data, REASON_BACKUP)
            _publish_record(fds, state, 0x06, record_payload)
        finally:
            _zero(data)
            _zero(digest)
            _zero(path_sha)
            _zero(name)
            _zero(size)
            _zero(record_payload)
    _verify_stage_bindings(state)
    state["phase"] = "BACKUP_DONE"


def _prepare(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    for directory in state["directories"]:
        leaf = None
        try:
            parent, leaf = _walk_parent(fds, state, directory, REASON_INTERNAL)
        except Missing:
            parent = None
            exists = 0
        else:
            try:
                found = _lstat(parent, leaf, REASON_INTERNAL)
                if found is None:
                    exists = 0
                else:
                    _verify_dir(found, state)
                    verify_fd = _track(fds, _openat(parent, leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
                    try:
                        _bind_name(parent, leaf, verify_fd, state, reason=REASON_INTERNAL, directory=True)
                    finally:
                        _close(fds, verify_fd)
                    exists = 1
            finally:
                _zero(leaf)
                _close(fds, parent)
        size = _u16(len(directory))
        marker = bytearray((exists,))
        record_payload = _concat((size, directory, marker))
        try:
            _publish_record(fds, state, 0x07, record_payload)
        finally:
            _zero(size)
            _zero(marker)
            _zero(record_payload)
    _publish_record(fds, state, 0x08, state["plan_digest"])
    _verify_stage_bindings(state)
    state["phase"] = "PREPARED"
    return bytearray(state["plan_digest"])


def _commit(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    _publish_record(fds, state, 0x09, state["plan_digest"])
    _verify_stage_bindings(state)
    state["phase"] = "COMMIT_DECIDED"
    return bytearray(state["plan_digest"])


def _ensure_directories(fds, state):
    for directory in state["directories"]:
        try:
            parent, leaf = _walk_parent(fds, state, directory, REASON_IO)
        except Missing:
            raise Failure(UNCERTAIN, REASON_IO)
        child = None
        try:
            created = 0
            try:
                _guard_mutation(state)
                _mkdirat(parent, leaf, 0o700)
                created = 1
            except FileExistsError:
                found = _lstat(parent, leaf, REASON_IO)
                if found is None:
                    raise Failure(UNCERTAIN, REASON_IO)
            except OSError:
                raise Failure(UNCERTAIN, REASON_IO)
            child = _track(fds, _openat(parent, leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
            _bind_name(parent, leaf, child, state, reason=REASON_INTERNAL, directory=True)
            _guard_mutation(state)
            os.fsync(parent)
            _bind_name(parent, leaf, child, state, reason=REASON_INTERNAL, directory=True)
            size = _u16(len(directory))
            marker = bytearray((created,))
            record_payload = _concat((size, directory, marker))
            try:
                _publish_record(fds, state, 0x0A, record_payload)
            finally:
                _zero(size)
                _zero(marker)
                _zero(record_payload)
        finally:
            if child is not None:
                _close(fds, child)
            _zero(leaf)
            _close(fds, parent)


def _stage_bytes(fds, state, entry):
    matches = [owner for owner in state["staged"] if owner["path"] == entry["path"]]
    if len(matches) != 1:
        raise Failure(UNCERTAIN, REASON_STAGE)
    owner = matches[0]
    _bind_sealed_stage(state, owner)
    data = _fd_bytes(owner["fd"], MAX_TOTAL_BYTES, REASON_STAGE)
    _bind_sealed_stage(state, owner)
    digest = _sha256(data)
    try:
        if len(data) != entry["post_size"] or digest != entry["post_digest"] or digest != owner["digest"]:
            _zero(data)
            raise Failure(UNCERTAIN, REASON_STAGE)
        _bind_sealed_stage(state, owner)
    finally:
        _zero(digest)
    return data


def _apply_create(fds, state, entry):
    try:
        parent, leaf = _walk_parent(fds, state, entry["path"], REASON_QUIESCENCE)
    except Missing:
        raise Failure(UNCERTAIN, REASON_QUIESCENCE)
    name = _sha256_hex(entry["path"])
    install_fd = state["dir_fds"]["install"]
    data = _stage_bytes(fds, state, entry)
    artifact_fd = None
    try:
        artifact_fd = _create_leaf(fds, state, install_fd, name, data, REASON_STAGE)
        _bind_name(install_fd, name, artifact_fd, state, reason=REASON_STAGE)
        try:
            _guard_mutation(state)
            _linkat(install_fd, name, parent, leaf)
        except FileExistsError:
            raise Failure(UNCERTAIN, REASON_COLLISION)
        _bind_name(install_fd, name, artifact_fd, state, nlinks=(2,), reason=REASON_QUIESCENCE)
        _bind_name(parent, leaf, artifact_fd, state, nlinks=(2,), reason=REASON_QUIESCENCE)
        _guard_mutation(state)
        os.fsync(parent)
        _bind_name(install_fd, name, artifact_fd, state, nlinks=(2,), reason=REASON_QUIESCENCE)
        _bind_name(parent, leaf, artifact_fd, state, nlinks=(2,), reason=REASON_QUIESCENCE)
        _guard_mutation(state)
        _unlinkat(install_fd, name)
        if os.fstat(artifact_fd).st_nlink != 1:
            raise Failure(UNCERTAIN, REASON_QUIESCENCE)
        _bind_name(parent, leaf, artifact_fd, state, nlinks=(1,), reason=REASON_QUIESCENCE)
        _guard_mutation(state)
        os.fsync(install_fd)
        _bind_name(parent, leaf, artifact_fd, state, nlinks=(1,), reason=REASON_QUIESCENCE)
    except Failure:
        raise
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        if artifact_fd is not None:
            _close(fds, artifact_fd)
        _zero(data)
        _zero(name)
        _zero(leaf)
        _close(fds, parent)


def _apply_delete(fds, state, entry):
    try:
        parent, leaf = _walk_parent(fds, state, entry["path"], REASON_QUIESCENCE)
    except Missing:
        raise Failure(UNCERTAIN, REASON_QUIESCENCE)
    target_fd = None
    data = None
    digest = None
    try:
        target_fd = _open_bound_leaf(fds, state, parent, leaf, reason=REASON_QUIESCENCE)
        data = _fd_bytes(target_fd, MAX_TOTAL_BYTES, REASON_PREIMAGE)
        digest = _sha256(data)
        if len(data) != entry["pre_size"] or digest != entry["pre_digest"]:
            raise Failure(UNCERTAIN, REASON_PREIMAGE)
        _bind_name(parent, leaf, target_fd, state, reason=REASON_QUIESCENCE)
        _guard_mutation(state)
        _unlinkat(parent, leaf)
        if os.fstat(target_fd).st_nlink != 0 or _lstat(parent, leaf, REASON_QUIESCENCE) is not None:
            raise Failure(UNCERTAIN, REASON_QUIESCENCE)
        _guard_mutation(state)
        os.fsync(parent)
        if os.fstat(target_fd).st_nlink != 0 or _lstat(parent, leaf, REASON_QUIESCENCE) is not None:
            raise Failure(UNCERTAIN, REASON_QUIESCENCE)
    except Failure:
        raise
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        if target_fd is not None:
            _close(fds, target_fd)
        if data is not None:
            _zero(data)
        if digest is not None:
            _zero(digest)
        _zero(leaf)
        _close(fds, parent)


def _apply_update(fds, state, entry):
    try:
        parent, leaf = _walk_parent(fds, state, entry["path"], REASON_QUIESCENCE)
    except Missing:
        raise Failure(UNCERTAIN, REASON_QUIESCENCE)
    path_name = _sha256_hex(entry["path"])
    prefix = bytearray(b"\x01wa-upd-")
    try:
        temporary = _concat((prefix, path_name))
    finally:
        _zero(prefix)
        _zero(path_name)
    data = _stage_bytes(fds, state, entry)
    temp_fd = None
    target_fd = None
    current = None
    current_digest = None
    final = None
    final_digest = None
    try:
        temp_fd = _create_leaf(fds, state, parent, temporary, data, REASON_STAGE)
        target_fd = _open_bound_leaf(fds, state, parent, leaf, reason=REASON_QUIESCENCE)
        current = _fd_bytes(target_fd, MAX_TOTAL_BYTES, REASON_QUIESCENCE)
        current_digest = _sha256(current)
        if len(current) != entry["pre_size"] or current_digest != entry["pre_digest"]:
            raise Failure(UNCERTAIN, REASON_QUIESCENCE)
        _bind_name(parent, temporary, temp_fd, state, reason=REASON_STAGE)
        _bind_name(parent, leaf, target_fd, state, reason=REASON_QUIESCENCE)
        _guard_mutation(state)
        _renameat(parent, temporary, parent, leaf)
        if os.fstat(target_fd).st_nlink != 0:
            raise Failure(UNCERTAIN, REASON_QUIESCENCE)
        _bind_name(parent, leaf, temp_fd, state, reason=REASON_VERIFY)
        _guard_mutation(state)
        os.fsync(parent)
        if os.fstat(target_fd).st_nlink != 0:
            raise Failure(UNCERTAIN, REASON_QUIESCENCE)
        _bind_name(parent, leaf, temp_fd, state, reason=REASON_VERIFY)
        final = _fd_bytes(temp_fd, MAX_TOTAL_BYTES, REASON_VERIFY)
        final_digest = _sha256(final)
        if len(final) != entry["post_size"] or final_digest != entry["post_digest"]:
            raise Failure(UNCERTAIN, REASON_VERIFY)
    except Failure:
        raise
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        if temp_fd is not None:
            _close(fds, temp_fd)
        if target_fd is not None:
            _close(fds, target_fd)
        for owner in (data, current, current_digest, final, final_digest, temporary, leaf):
            if owner is not None:
                _zero(owner)
        _close(fds, parent)


def _apply(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    _ensure_directories(fds, state)
    for index, entry in enumerate(state["entries"]):
        if entry["kind"] == 0:
            _apply_create(fds, state, entry)
            post_state = 1
        elif entry["kind"] == 1:
            _apply_delete(fds, state, entry)
            post_state = 2
        else:
            _apply_update(fds, state, entry)
            post_state = 3
        index_bytes = _u16(index)
        marker = bytearray((post_state,))
        record_payload = _concat((index_bytes, entry["digest"], marker))
        try:
            _publish_record(fds, state, 0x0B, record_payload)
        finally:
            _zero(index_bytes)
            _zero(marker)
            _zero(record_payload)
    _verify_stage_bindings(state)
    state["phase"] = "APPLIED"
    return _u32(len(state["entries"]))


def _verify(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    for entry in state["entries"]:
        try:
            parent, leaf = _walk_parent(fds, state, entry["path"], REASON_VERIFY)
        except Missing:
            if entry["kind"] == 1:
                continue
            raise Failure(UNCERTAIN, REASON_VERIFY)
        try:
            if entry["kind"] == 1:
                if _lstat(parent, leaf, REASON_VERIFY) is not None:
                    raise Failure(UNCERTAIN, REASON_VERIFY)
                continue
            data = _read_leaf(fds, state, parent, leaf, MAX_TOTAL_BYTES, REASON_VERIFY)
            digest = _sha256(data)
            try:
                if len(data) != entry["post_size"] or digest != entry["post_digest"]:
                    raise Failure(UNCERTAIN, REASON_VERIFY)
            finally:
                _zero(digest)
                _zero(data)
        finally:
            _zero(leaf)
            _close(fds, parent)
    _publish_record(fds, state, 0x0C, state["plan_digest"])
    _verify_stage_bindings(state)
    state["phase"] = "VERIFIED"
    return bytearray(state["plan_digest"])


def _list_hash_names(fd, reason):
    try:
        names = os.listdir(fd)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    result = []
    try:
        for name in names:
            if len(name) != 64:
                raise Failure(UNCERTAIN, reason)
            owned = bytearray(64)
            for index, character in enumerate(name):
                code = ord(character)
                if not (0x30 <= code <= 0x39 or 0x61 <= code <= 0x66):
                    _zero(owned)
                    raise Failure(UNCERTAIN, reason)
                owned[index] = code
            result.append(owned)
        return result
    except BaseException:
        _zero_owned(result)
        raise
    finally:
        names.clear()


def _private_dir_empty(fd):
    try:
        names = os.listdir(fd)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    try:
        for name in names:
            if len(name) != 64:
                return False
            for character in name:
                code = ord(character)
                if not (0x30 <= code <= 0x39 or 0x61 <= code <= 0x66):
                    return False
        return not names
    finally:
        names.clear()


def _unlink_bound_leaf(fds, state, dir_fd, name, reason):
    fd = _open_bound_leaf(fds, state, dir_fd, name, reason=reason)
    try:
        _bind_name(dir_fd, name, fd, state, reason=reason)
        _guard_mutation(state)
        _unlinkat(dir_fd, name)
        if os.fstat(fd).st_nlink != 0 or _lstat(dir_fd, name, reason) is not None:
            raise Failure(UNCERTAIN, reason)
        _guard_mutation(state)
        os.fsync(dir_fd)
        if os.fstat(fd).st_nlink != 0 or _lstat(dir_fd, name, reason) is not None:
            raise Failure(UNCERTAIN, reason)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        _close(fds, fd)


def _cleanup_stages(fds, state):
    stage_fd = state["dir_fds"]["stage"]
    stages = state["staged"]
    while stages:
        owner = stages[-1]
        fd = owner["fd"]
        removed = False
        try:
            _bind_sealed_stage(state, owner)
            _guard_mutation(state)
            _unlinkat(stage_fd, owner["name"])
            if os.fstat(fd).st_nlink != 0 or _lstat(stage_fd, owner["name"], REASON_STAGE) is not None:
                raise Failure(UNCERTAIN, REASON_STAGE)
            stages.pop()
            removed = True
            _guard_mutation(state)
            os.fsync(stage_fd)
            if os.fstat(fd).st_nlink != 0 or _lstat(stage_fd, owner["name"], REASON_STAGE) is not None:
                raise Failure(UNCERTAIN, REASON_STAGE)
        except OSError:
            raise Failure(UNCERTAIN, REASON_IO)
        finally:
            if removed:
                owner["fd"] = None
                try:
                    _close(fds, fd)
                finally:
                    _zero_owned(owner)


def _cleanup(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    _cleanup_stages(fds, state)
    for directory in ("install", "backup"):
        fd = state["dir_fds"][directory]
        names = sorted(_list_hash_names(fd, REASON_INTERNAL), reverse=True)
        try:
            for name in names:
                _unlink_bound_leaf(fds, state, fd, name, REASON_INTERNAL)
        finally:
            _zero_owned(names)
    _publish_record(fds, state, 0x0D, state["plan_digest"])
    state["phase"] = "CLEANUP_DONE"


def _validate_journal_grammar(raw_records, state):
    if not raw_records or not state.get("records") or len(raw_records) > len(state["records"]):
        raise Failure(UNCERTAIN, REASON_JOURNAL)
    expected_previous = bytearray(32)
    try:
        for revision, raw in enumerate(raw_records):
            tag, actual_revision = _parse_record(raw)
            if actual_revision != revision:
                raise Failure(UNCERTAIN, REASON_JOURNAL)
            view = memoryview(raw)
            previous = view[5:37]
            try:
                if previous != expected_previous:
                    raise Failure(UNCERTAIN, REASON_JOURNAL)
            finally:
                previous.release()
                view.release()
            if raw != state["records"][revision] or tag != state["records"][revision][0]:
                raise Failure(UNCERTAIN, REASON_JOURNAL)
            _zero(expected_previous)
            expected_previous = _sha256(raw)
        first = raw_records[0]
        declared_entries = struct.unpack_from(">I", first, 73)[0]
        declared_total = struct.unpack_from(">I", first, 77)[0]
        if declared_entries != state["entry_count"] or declared_total != state["total_bytes"]:
            raise Failure(UNCERTAIN, REASON_JOURNAL)
        if len(raw_records) == len(state["records"]):
            expected_tags = [record[0] for record in state["records"]]
            actual_tags = [record[0] for record in raw_records]
            try:
                if actual_tags != expected_tags:
                    raise Failure(UNCERTAIN, REASON_JOURNAL)
            finally:
                actual_tags.clear()
                expected_tags.clear()
    except Failure as failure:
        if failure.detail_code == REASON_JOURNAL:
            raise
        raise Failure(UNCERTAIN, REASON_JOURNAL)
    finally:
        _zero(expected_previous)


def _read_journal(fds, state):
    journal_fd = state["dir_fds"]["journal"]
    raw_records = []
    total = 0
    names = _list_hash_names(journal_fd, REASON_JOURNAL)
    try:
        for name in names:
            raw = _read_leaf(fds, state, journal_fd, name, MAX_PAYLOAD, REASON_JOURNAL)
            actual_name = _sha256_hex(raw)
            try:
                _parse_record(raw)
                if actual_name != name:
                    raise Failure(UNCERTAIN, REASON_JOURNAL)
                total += len(raw)
                if total > MAX_JOURNAL_BYTES:
                    raise Failure(ERROR, ERR_LIMIT)
                raw_records.append(raw)
                raw = None
            finally:
                _zero(actual_name)
                if raw is not None:
                    _zero(raw)
    finally:
        _zero_owned(names)
    raw_records.sort(key=lambda raw: struct.unpack_from(">I", raw, 1)[0])
    records = []
    try:
        if len(raw_records) > MAX_CHAIN:
            raise Failure(ERROR, ERR_LIMIT)
        _validate_journal_grammar(raw_records, state)
        for raw in raw_records:
            records.append({"tag": raw[0], "revision": struct.unpack_from(">I", raw, 1)[0], "raw": raw})
        raw_records.clear()
        return records
    except BaseException:
        _zero_owned(records)
        _zero_owned(raw_records)
        raise


def _record_vector(fds, state):
    disk_records = _read_journal(fds, state)
    vector = []
    try:
        if not disk_records or len(disk_records) != len(state["records"]):
            raise Failure(UNCERTAIN, REASON_JOURNAL)
        for index, record_item in enumerate(disk_records):
            if record_item["raw"] != state["records"][index]:
                raise Failure(UNCERTAIN, REASON_JOURNAL)
            vector.append(_sha256(record_item["raw"]))
        result = vector
        vector = []
        return result
    finally:
        _zero_owned(vector)
        _zero_owned(disk_records)


def _vector_commitment(vector):
    count = _u32(len(vector))
    try:
        parts = [count]
        parts.extend(vector)
        return _domain_hash(DOMAIN_EVIDENCE_VEC, parts)
    finally:
        _zero(count)


def _recover_names(fd, reason):
    try:
        names = os.listdir(fd)
    except OSError:
        raise Failure(UNCERTAIN, reason)
    result = []
    try:
        for name in names:
            encoded = bytearray(os.fsencode(name))
            if not encoded or b"/" in encoded or b"\x00" in encoded:
                _zero(encoded)
                raise Failure(UNCERTAIN, reason)
            result.append(encoded)
        return result
    except BaseException:
        _zero_owned(result)
        raise
    finally:
        names.clear()


def _recover_open_dir(fds, state, parent_fd, name):
    try:
        fd = _track(fds, _openat(parent_fd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC))
        _bind_name(parent_fd, name, fd, state, reason=REASON_EVIDENCE, directory=True)
        return fd
    except Failure:
        raise
    except OSError:
        raise Failure(UNCERTAIN, REASON_EVIDENCE)


def _recover_joint_leaf(fds, state, parent_fd, canonical, temporary, limit):
    opened = []
    try:
        for name in (canonical, temporary):
            try:
                fd = _track(fds, _openat(parent_fd, name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC))
            except FileNotFoundError:
                opened.append(None)
                continue
            except OSError:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            opened.append(fd)
        canonical_fd, temporary_fd = opened
        if canonical_fd is None and temporary_fd is None:
            return None
        if canonical_fd is not None and temporary_fd is not None:
            canonical_stat = _bind_name(parent_fd, canonical, canonical_fd, state, nlinks=(2,), reason=REASON_EVIDENCE)
            temporary_stat = _bind_name(parent_fd, temporary, temporary_fd, state, nlinks=(2,), reason=REASON_EVIDENCE)
            if not _same_inode(canonical_stat, temporary_stat):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            raw = _fd_bytes(canonical_fd, limit, REASON_EVIDENCE)
            duplicate = _fd_bytes(temporary_fd, limit, REASON_EVIDENCE)
            try:
                if raw != duplicate:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            finally:
                _zero(duplicate)
            return {"raw": raw, "canonical": True, "temporary": True}
        selected_fd = canonical_fd if canonical_fd is not None else temporary_fd
        selected_name = canonical if canonical_fd is not None else temporary
        _bind_name(parent_fd, selected_name, selected_fd, state, nlinks=(1,), reason=REASON_EVIDENCE)
        return {
            "raw": _fd_bytes(selected_fd, limit, REASON_EVIDENCE),
            "canonical": canonical_fd is not None,
            "temporary": temporary_fd is not None,
        }
    finally:
        for fd in opened:
            if fd is not None:
                _close(fds, fd)


def _recover_tombstone(fds, state):
    captured = _recover_joint_leaf(fds, state, state["root_fd"], bytearray(TOMBSTONE), bytearray(TOMBSTONE_TEMP), 209)
    if captured is None:
        return None
    raw = captured["raw"]
    try:
        tag, revision = _parse_record(raw)
        expected = 209 if tag == 0x0E else 105 if tag == 0x0F else 0
        if expected == 0 or len(raw) != expected or revision == 0 or revision > MAX_CHAIN:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        payload = memoryview(raw)[73:]
        try:
            tx_id = bytearray(payload[:32])
            if tx_id == ZERO32:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            result = {
                "tag": tag,
                "revision": revision,
                "terminal_digest": bytearray(raw[5:37]),
                "tx_id": tx_id,
                "canonical": captured["canonical"],
                "temporary": captured["temporary"],
            }
            if tag == 0x0E:
                result["plan_digest"] = bytearray(payload[32:64])
                result["commitment"] = bytearray(payload[64:96])
                result["vector_len"] = struct.unpack_from(">Q", payload, 96)[0]
                result["ticket"] = bytearray(payload[104:136])
                if (
                    result["plan_digest"] == ZERO32
                    or result["commitment"] == ZERO32
                    or result["ticket"] == ZERO32
                    or result["vector_len"] < 1
                    or result["vector_len"] > MAX_CHAIN
                    or result["revision"] != result["vector_len"]
                ):
                    _zero_owned(result)
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            return result
        finally:
            payload.release()
    except Failure:
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    finally:
        _zero(raw)


def _recover_records(fds, state, journal_fd):
    names = _recover_names(journal_fd, REASON_EVIDENCE)
    records = []
    total = 0
    grouped = {}
    try:
        for name in names:
            temporary = len(name) == 69 and name.startswith(b".tmp-")
            base = bytearray(name[5:]) if temporary else bytearray(name)
            try:
                if len(base) != 64 or any(not (0x30 <= value <= 0x39 or 0x61 <= value <= 0x66) for value in base):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                key = base.decode("ascii")
                kinds = grouped.setdefault(key, set())
                kind = "temporary" if temporary else "canonical"
                if kind in kinds:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                kinds.add(kind)
            finally:
                _zero(base)
        for key in grouped:
            canonical = bytearray(key.encode("ascii"))
            prefix = bytearray(b".tmp-")
            temporary = _concat((prefix, canonical))
            raw = None
            actual_name = None
            try:
                captured = _recover_joint_leaf(fds, state, journal_fd, canonical, temporary, MAX_PAYLOAD)
                if captured is None:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                raw = captured["raw"]
                actual_name = _sha256_hex(raw)
                tag, revision = _parse_record(raw)
                if actual_name != canonical:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                total += len(raw)
                if total > MAX_JOURNAL_BYTES:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                records.append({
                    "tag": tag,
                    "revision": revision,
                    "raw": raw,
                    "canonical": captured["canonical"],
                    "temporary": captured["temporary"],
                })
                raw = None
            finally:
                _zero(canonical)
                _zero(prefix)
                _zero(temporary)
                if actual_name is not None:
                    _zero(actual_name)
                if raw is not None:
                    _zero(raw)
        records.sort(key=lambda item: item["revision"])
        if len(records) > MAX_CHAIN:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        previous = bytearray(32)
        try:
            for revision, record_item in enumerate(records):
                raw = record_item["raw"]
                if (
                    record_item["revision"] != revision
                    or memoryview(raw)[5:37] != previous
                    or (record_item["temporary"] and revision != len(records) - 1)
                ):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                _zero(previous)
                previous = _sha256(raw)
        finally:
            _zero(previous)
        return records
    except (UnicodeError, Failure):
        _zero_owned(records)
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    finally:
        grouped.clear()
        _zero_owned(names)


def _recover_plan_from_records(records):
    if not records:
        return {"plan_present": False, "tx_id": None, "plan_digest": None, "entries": [], "directories": [], "commit": False}
    if records[0]["tag"] != 0x01:
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    header = records[0]["raw"]
    payload = memoryview(header)[73:]
    try:
        entry_count, total_bytes = struct.unpack_from(">II", payload, 0)
        tx_id = bytearray(payload[8:40])
        tx_digest = bytearray(payload[40:72])
        aggregate = bytearray(payload[72:104])
    finally:
        payload.release()
    result = {
        "entry_count": entry_count,
        "total_bytes": total_bytes,
        "tx_id": tx_id,
        "tx_digest": tx_digest,
        "declared_aggregate": aggregate,
        "entries": [],
        "directories": [],
        "plan_present": False,
        "plan_digest": None,
        "commit": False,
    }
    try:
        if entry_count < 1 or entry_count > MAX_ENTRIES or total_bytes > MAX_TOTAL_BYTES:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        index = 1
        while index < len(records) and records[index]["tag"] == 0x02 and len(result["entries"]) < entry_count:
            raw = records[index]["raw"]
            entry = _parse_entry(memoryview(raw)[73:])
            entry["digest"] = _entry_digest(entry)
            for previous_entry in result["entries"]:
                slash = bytearray(b"/")
                left = _concat((previous_entry["path"], slash))
                right = _concat((entry["path"], slash))
                try:
                    if previous_entry["path"] == entry["path"] or previous_entry["path"].startswith(right) or entry["path"].startswith(left):
                        raise Failure(UNCERTAIN, REASON_EVIDENCE)
                finally:
                    _zero(slash)
                    _zero(left)
                    _zero(right)
            result["entries"].append(entry)
            index += 1
        if len(result["entries"]) < entry_count:
            if index != len(records):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            return result
        expected_directories = []
        for entry in result["entries"]:
            for position, value in enumerate(entry["path"]):
                if value == 0x2F:
                    candidate = bytearray(entry["path"][:position])
                    if not any(candidate == existing for existing in expected_directories):
                        expected_directories.append(candidate)
                    else:
                        _zero(candidate)
        expected_directories.sort(key=lambda item: (item.count(b"/"), item))
        while index < len(records) and records[index]["tag"] == 0x03:
            raw = records[index]["raw"]
            record_payload = memoryview(raw)[73:]
            try:
                size = struct.unpack_from(">H", record_payload, 0)[0]
                directory = bytearray(record_payload[2:])
            finally:
                record_payload.release()
            position = len(result["directories"])
            if size != len(directory) or position >= len(expected_directories) or directory != expected_directories[position]:
                _zero(directory)
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            result["directories"].append(directory)
            index += 1
        if len(result["directories"]) != len(expected_directories):
            _zero_owned(expected_directories)
            if index != len(records):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            return result
        _zero_owned(expected_directories)
        if index >= len(records):
            return result
        if records[index]["tag"] != 0x04:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        ordered = sorted((bytearray(entry["digest"]) for entry in result["entries"]))
        computed_aggregate = _domain_hash(DOMAIN_ENTRY_AGG, ordered)
        computed_plan = _domain_hash(DOMAIN_PLAN, (computed_aggregate,))
        _zero_owned(ordered)
        raw = records[index]["raw"]
        sealed = memoryview(raw)[73:]
        try:
            sealed_entries, sealed_dirs = struct.unpack_from(">II", sealed, 0)
            sealed_digest = bytearray(sealed[8:40])
        finally:
            sealed.release()
        if (
            sealed_entries != entry_count
            or sealed_dirs != len(result["directories"])
            or computed_aggregate != result["declared_aggregate"]
            or sealed_digest != computed_plan
            or sum(entry["post_size"] for entry in result["entries"] if entry["kind"] in (0, 2)) != total_bytes
        ):
            _zero(computed_aggregate)
            _zero(computed_plan)
            _zero(sealed_digest)
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        _zero(computed_aggregate)
        _zero(sealed_digest)
        result["plan_present"] = True
        result["plan_digest"] = computed_plan
        index += 1

        def consume_repeated(tag, maximum, validator):
            nonlocal index
            count = 0
            while index < len(records) and records[index]["tag"] == tag:
                if count >= maximum:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                validator(count, memoryview(records[index]["raw"])[73:])
                count += 1
                index += 1
            return count

        staged_paths = []
        def validate_stage(unused, item):
            try:
                path_sha = bytearray(item[:32])
                digest = bytearray(item[32:64])
                size = struct.unpack_from(">I", item, 64)[0]
                matches = [entry for entry in result["entries"] if entry["kind"] in (0, 2) and _sha256(entry["path"]) == path_sha]
                if len(matches) != 1 or digest != matches[0]["post_digest"] or size != matches[0]["post_size"] or any(path_sha == prior for prior in staged_paths):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                staged_paths.append(path_sha)
                path_sha = None
            finally:
                if path_sha is not None:
                    _zero(path_sha)
                _zero(digest)
                item.release()
        result["stage_count"] = consume_repeated(0x05, entry_count, validate_stage)
        result["staged_paths"] = staged_paths
        staged_paths = []
        expected_stage_count = sum(1 for entry in result["entries"] if entry["kind"] in (0, 2))
        if index < len(records) and result["stage_count"] != expected_stage_count:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)

        backup_paths = []
        expected_backups = [entry for entry in result["entries"] if entry["kind"] in (1, 2)]
        def validate_backup(unused, item):
            try:
                path_sha = bytearray(item[:32])
                digest = bytearray(item[32:64])
                size = struct.unpack_from(">I", item, 64)[0]
                matches = [entry for entry in result["entries"] if entry["kind"] in (1, 2) and _sha256(entry["path"]) == path_sha]
                if (
                    len(matches) != 1
                    or unused >= len(expected_backups)
                    or matches[0] is not expected_backups[unused]
                    or digest != matches[0]["pre_digest"]
                    or size != matches[0]["pre_size"]
                    or any(path_sha == prior for prior in backup_paths)
                ):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                backup_paths.append(path_sha)
                path_sha = None
            finally:
                if path_sha is not None:
                    _zero(path_sha)
                _zero(digest)
                item.release()
        result["backup_count"] = consume_repeated(0x06, entry_count, validate_backup)
        result["backup_paths"] = backup_paths
        backup_paths = []
        if index < len(records) and result["backup_count"] != len(expected_backups):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)

        prepared = 0
        prepared_states = []
        while index < len(records) and records[index]["tag"] == 0x07:
            item = memoryview(records[index]["raw"])[73:]
            try:
                size = struct.unpack_from(">H", item, 0)[0]
                directory = item[2:2 + size]
                if prepared >= len(result["directories"]) or directory != result["directories"][prepared] or item[-1] not in (0, 1):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            finally:
                directory.release()
                item.release()
            prepared_states.append(records[index]["raw"][-1])
            prepared += 1
            index += 1
        result["prepared_count"] = prepared
        result["prepared_states"] = prepared_states
        if prepared not in (0, len(result["directories"])):
            if index != len(records):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            return result
        if index < len(records) and records[index]["tag"] == 0x08:
            if memoryview(records[index]["raw"])[73:] != result["plan_digest"] or prepared != len(result["directories"]):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            result["prepare_done"] = True
            index += 1
        else:
            result["prepare_done"] = False
            if index != len(records):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            return result
        if index < len(records) and records[index]["tag"] == 0x09:
            if memoryview(records[index]["raw"])[73:] != result["plan_digest"]:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            result["commit"] = True
            index += 1
        else:
            if index != len(records):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            return result
        applied_dirs = 0
        applied_directory_states = []
        while index < len(records) and records[index]["tag"] == 0x0A:
            item = memoryview(records[index]["raw"])[73:]
            try:
                size = struct.unpack_from(">H", item, 0)[0]
                directory = item[2:2 + size]
                if applied_dirs >= len(result["directories"]) or directory != result["directories"][applied_dirs] or item[-1] not in (0, 1):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            finally:
                directory.release()
                item.release()
            applied_directory_states.append(records[index]["raw"][-1])
            applied_dirs += 1
            index += 1
        result["applied_dirs"] = applied_dirs
        result["applied_directory_states"] = applied_directory_states
        applied_entries = 0
        while index < len(records) and records[index]["tag"] == 0x0B:
            item = memoryview(records[index]["raw"])[73:]
            try:
                entry_index = struct.unpack_from(">H", item, 0)[0]
                if entry_index != applied_entries or entry_index >= len(result["entries"]) or item[2:34] != result["entries"][entry_index]["digest"] or item[34] != result["entries"][entry_index]["kind"] + 1:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            finally:
                item.release()
            applied_entries += 1
            index += 1
        result["applied_entries"] = applied_entries
        if applied_entries > 0 and applied_dirs != len(result["directories"]):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        result["verified"] = False
        result["cleanup_done"] = False
        if index < len(records) and records[index]["tag"] == 0x0C:
            if applied_dirs != len(result["directories"]) or applied_entries != len(result["entries"]) or memoryview(records[index]["raw"])[73:] != result["plan_digest"]:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            result["verified"] = True
            index += 1
        if index < len(records) and records[index]["tag"] == 0x0D:
            if not result["verified"] or memoryview(records[index]["raw"])[73:] != result["plan_digest"]:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            result["cleanup_done"] = True
            index += 1
        if index != len(records):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        _zero_owned(staged_paths)
        _zero_owned(backup_paths)
        return result
    except BaseException:
        _zero_owned(result)
        raise


def _recover_workspace_leaf(fds, state, entry):
    try:
        parent, leaf = _walk_parent(fds, state, entry["path"], REASON_EVIDENCE)
    except Missing:
        return None, None, None, None, None
    fd = None
    try:
        found = _lstat(parent, leaf, REASON_EVIDENCE)
        if found is None:
            return None, None, None, parent, leaf
        fd = _open_bound_leaf(fds, state, parent, leaf, nlinks=(1, 2), reason=REASON_EVIDENCE)
        found = _bind_name(parent, leaf, fd, state, nlinks=(1, 2), reason=REASON_EVIDENCE)
        raw = _fd_bytes(fd, MAX_TOTAL_BYTES, REASON_EVIDENCE)
        digest = _sha256(raw)
        size = len(raw)
        _zero(raw)
        result = ((size, digest), found, fd, parent, leaf)
        fd = None
        return result
    except BaseException:
        if fd is not None:
            _close(fds, fd)
        _zero(leaf)
        _close(fds, parent)
        raise


def _recover_directory_present(fds, state, path):
    try:
        parent, leaf = _walk_parent(fds, state, path, REASON_EVIDENCE)
    except Missing:
        return False
    try:
        found = _lstat(parent, leaf, REASON_EVIDENCE)
        if found is None:
            return False
        directory_fd = _recover_open_dir(fds, state, parent, leaf)
        _close(fds, directory_fd)
        return True
    finally:
        _zero(leaf)
        _close(fds, parent)


def _recover_matches_postimage_or_prefix(fds, state, entry, candidate, stage_fd):
    if len(candidate) > entry["post_size"]:
        return False
    if len(candidate) == entry["post_size"]:
        digest = _sha256(candidate)
        try:
            return digest == entry["post_digest"]
        finally:
            _zero(digest)
    if stage_fd is None:
        return False
    name = _sha256_hex(entry["path"])
    staged = None
    digest = None
    try:
        staged = _read_leaf(fds, state, stage_fd, name, MAX_TOTAL_BYTES, REASON_EVIDENCE)
        digest = _sha256(staged)
        if len(staged) != entry["post_size"] or digest != entry["post_digest"]:
            return False
        prefix = memoryview(staged)[:len(candidate)]
        try:
            return candidate == prefix
        finally:
            prefix.release()
    finally:
        _zero(name)
        if staged is not None:
            _zero(staged)
        if digest is not None:
            _zero(digest)


def _recover_install_inventory(fds, state, plan, install_fd, stage_fd):
    names = _recover_names(install_fd, REASON_EVIDENCE)
    try:
        if not plan["plan_present"]:
            for name in names:
                if len(name) != 64 or any(not (0x30 <= value <= 0x39 or 0x61 <= value <= 0x66) for value in name):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                raw = _read_leaf(fds, state, install_fd, name, MAX_TOTAL_BYTES, REASON_EVIDENCE)
                _zero(raw)
            return {"has_artifacts": bool(names), "key": None, "stat": None, "fd": None, "dir_fd": install_fd}
        if len(names) > 1:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        if not names:
            return {"has_artifacts": False, "key": None, "stat": None, "fd": None, "dir_fd": install_fd}
        name = names[0]
        if len(name) != 64 or any(not (0x30 <= value <= 0x39 or 0x61 <= value <= 0x66) for value in name):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        applied_entries = plan.get("applied_entries", 0)
        if (
            not plan.get("commit", False)
            or applied_entries >= len(plan["entries"])
            or plan.get("applied_dirs", 0) != len(plan["directories"])
        ):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        entry = plan["entries"][applied_entries]
        expected_name = _sha256_hex(entry["path"])
        fd = None
        raw = None
        try:
            if entry["kind"] != 0 or name != expected_name:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            fd = _open_bound_leaf(fds, state, install_fd, name, nlinks=(1, 2), reason=REASON_EVIDENCE)
            found = _bind_name(install_fd, name, fd, state, nlinks=(1, 2), reason=REASON_EVIDENCE)
            raw = _fd_bytes(fd, MAX_TOTAL_BYTES, REASON_EVIDENCE)
            if not _recover_matches_postimage_or_prefix(fds, state, entry, raw, stage_fd):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            if len(raw) < entry["post_size"] and found.st_nlink != 1:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            result = {
                "has_artifacts": True,
                "key": name.decode("ascii"),
                "stat": found,
                "fd": fd,
                "dir_fd": install_fd,
            }
            fd = None
            return result
        finally:
            if fd is not None:
                _close(fds, fd)
            if raw is not None:
                _zero(raw)
            _zero(expected_name)
    except (UnicodeError, Failure):
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    finally:
        _zero_owned(names)


def _recover_validate_workspace(fds, state, plan, tombstone, install, stage_fd):
    force_old = not plan.get("commit", False) and (tombstone is None or tombstone["tag"] == 0x0F)
    force_new = tombstone is not None and tombstone["tag"] == 0x0E
    prepared_states = plan.get("prepared_states", [])
    applied_dirs = plan.get("applied_dirs", 0)
    for index, directory in enumerate(plan["directories"] if plan["plan_present"] else []):
        if force_new:
            allowed = _recover_directory_present(fds, state, directory)
        elif index >= len(prepared_states):
            continue
        else:
            old_present = prepared_states[index] == 1
            present = _recover_directory_present(fds, state, directory)
            if force_old or index > applied_dirs:
                allowed = present == old_present
            elif index < applied_dirs:
                allowed = present
            else:
                allowed = present == old_present or present
        if not allowed:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
    applied_entries = plan.get("applied_entries", 0)
    for index, entry in enumerate(plan["entries"]):
        observed, observed_stat, observed_fd, parent, leaf = _recover_workspace_leaf(fds, state, entry)
        temporary = None
        temporary_raw = None
        try:
            if parent is not None and entry["kind"] == 2:
                path_name = _sha256_hex(entry["path"])
                prefix = bytearray(b"\x01wa-upd-")
                temporary = _concat((prefix, path_name))
                parent_names = _recover_names(parent, REASON_EVIDENCE)
                try:
                    if any(name.startswith(prefix) and name != temporary for name in parent_names):
                        raise Failure(UNCERTAIN, REASON_EVIDENCE)
                finally:
                    _zero_owned(parent_names)
                    _zero(path_name)
                    _zero(prefix)
                temporary_found = _lstat(parent, temporary, REASON_EVIDENCE)
                if temporary_found is not None:
                    temporary_raw = _read_leaf(
                        fds, state, parent, temporary, MAX_TOTAL_BYTES, REASON_EVIDENCE, nlinks=(1,)
                    )
                    if observed_fd is not None:
                        observed_stat = _bind_name(
                            parent, leaf, observed_fd, state, nlinks=(1,), reason=REASON_EVIDENCE
                        )
                    if (
                        tombstone is not None
                        or not plan.get("commit", False)
                        or applied_dirs != len(plan["directories"])
                        or index != applied_entries
                        or not _recover_matches_postimage_or_prefix(
                            fds, state, entry, temporary_raw, stage_fd
                        )
                        or observed is None
                        or observed_stat.st_nlink != 1
                        or observed[0] != entry["pre_size"]
                        or observed[1] != entry["pre_digest"]
                    ):
                        raise Failure(UNCERTAIN, REASON_EVIDENCE)
            is_pre = observed is not None and observed[0] == entry["pre_size"] and observed[1] == entry["pre_digest"]
            is_post = observed is not None and observed[0] == entry["post_size"] and observed[1] == entry["post_digest"]
            if entry["kind"] == 0:
                old_ok = observed is None
                new_ok = is_post
                expected_name = _sha256_hex(entry["path"])
                try:
                    install_for_entry = install["key"] == expected_name.decode("ascii")
                finally:
                    _zero(expected_name)
                if install_for_entry:
                    install_name = bytearray(install["key"].encode("ascii"))
                    try:
                        install_stat = _bind_name(
                            install["dir_fd"], install_name, install["fd"], state,
                            nlinks=(1, 2), reason=REASON_EVIDENCE,
                        )
                        if observed is None:
                            if install_stat.st_nlink != 1:
                                raise Failure(UNCERTAIN, REASON_EVIDENCE)
                        else:
                            observed_stat = _bind_name(
                                parent, leaf, observed_fd, state, nlinks=(1, 2), reason=REASON_EVIDENCE
                            )
                            if (
                                not is_post
                                or observed_stat.st_nlink != 2
                                or install_stat.st_nlink != 2
                                or not _same_inode(observed_stat, install_stat)
                            ):
                                raise Failure(UNCERTAIN, REASON_EVIDENCE)
                    finally:
                        _zero(install_name)
                elif observed_stat is not None and observed_stat.st_nlink != 1:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            elif entry["kind"] == 1:
                old_ok = is_pre
                new_ok = observed is None
                if observed_stat is not None and observed_stat.st_nlink != 1:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            else:
                old_ok = is_pre
                new_ok = is_post
                if observed_stat is not None and observed_stat.st_nlink != 1:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            if force_old:
                allowed = old_ok
            elif force_new:
                allowed = new_ok
            elif applied_dirs < len(plan["directories"]):
                allowed = old_ok
            elif index < applied_entries:
                allowed = new_ok
            elif index == applied_entries:
                allowed = old_ok or new_ok
            else:
                allowed = old_ok
            if not allowed:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
        finally:
            if observed is not None:
                _zero(observed[1])
            if temporary is not None:
                _zero(temporary)
            if temporary_raw is not None:
                _zero(temporary_raw)
            if observed_fd is not None:
                _close(fds, observed_fd)
            if leaf is not None:
                _zero(leaf)
            if parent is not None:
                _close(fds, parent)
    if install["fd"] is not None:
        _close(fds, install["fd"])
        install["fd"] = None


def _recover_artifact_inventory(fds, state, plan, directory_name, fd):
    names = _recover_names(fd, REASON_EVIDENCE)
    expected = {}
    try:
        if not plan["plan_present"]:
            grouped = set()
            for name in names:
                temporary_name = len(name) == 69 and name.startswith(b".tmp-")
                base = bytearray(name[5:]) if temporary_name else bytearray(name)
                try:
                    if (
                        len(base) != 64
                        or any(not (0x30 <= value <= 0x39 or 0x61 <= value <= 0x66) for value in base)
                        or (directory_name == "stage" and temporary_name)
                    ):
                        raise Failure(UNCERTAIN, REASON_EVIDENCE)
                    grouped.add(base.decode("ascii"))
                finally:
                    _zero(base)
            for key in grouped:
                canonical = bytearray(key.encode("ascii"))
                raw = None
                try:
                    if directory_name == "stage":
                        raw = _read_leaf(fds, state, fd, canonical, MAX_TOTAL_BYTES, REASON_EVIDENCE)
                    else:
                        prefix = bytearray(b".tmp-")
                        temporary = _concat((prefix, canonical))
                        try:
                            captured = _recover_joint_leaf(fds, state, fd, canonical, temporary, MAX_TOTAL_BYTES)
                            if captured is None:
                                raise Failure(UNCERTAIN, REASON_EVIDENCE)
                            raw = captured["raw"]
                        finally:
                            _zero(prefix)
                            _zero(temporary)
                finally:
                    if raw is not None:
                        _zero(raw)
                    _zero(canonical)
            grouped.clear()
            return {"has_artifacts": bool(names), "present": set(), "recorded": set()}
        recorded = plan.get("staged_paths", []) if directory_name == "stage" else plan.get("backup_paths", [])
        for entry in plan["entries"]:
            wanted = None
            if directory_name == "stage" and entry["kind"] in (0, 2):
                wanted = (entry["post_size"], entry["post_digest"])
            elif directory_name == "backup" and entry["kind"] in (1, 2):
                wanted = (entry["pre_size"], entry["pre_digest"])
            if wanted is not None:
                digest = _sha256(entry["path"])
                name = _sha256_hex(entry["path"])
                try:
                    expected[name.decode("ascii")] = (wanted[0], wanted[1], any(digest == item for item in recorded))
                finally:
                    _zero(digest)
                    _zero(name)
        present = set()
        kinds = {}
        for name in names:
            temporary = len(name) == 69 and name.startswith(b".tmp-")
            base = bytearray(name[5:]) if temporary else bytearray(name)
            try:
                if len(base) != 64 or any(not (0x30 <= value <= 0x39 or 0x61 <= value <= 0x66) for value in base):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                key = base.decode("ascii")
                if key not in expected or (directory_name == "stage" and temporary):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                kind = "temporary" if temporary else "canonical"
                key_kinds = kinds.setdefault(key, set())
                if kind in key_kinds:
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
                key_kinds.add(kind)
                present.add(key)
            finally:
                _zero(base)
        unrecorded = [key for key in present if not expected[key][2]]
        if len(unrecorded) > 1:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        if directory_name == "backup" and unrecorded:
            expected_stage_count = sum(1 for entry in plan["entries"] if entry["kind"] in (0, 2))
            if plan.get("stage_count", 0) != expected_stage_count:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            backup_entries = [entry for entry in plan["entries"] if entry["kind"] in (1, 2)]
            next_index = len(plan.get("backup_paths", []))
            if next_index >= len(backup_entries):
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            next_name = _sha256_hex(backup_entries[next_index]["path"])
            try:
                if unrecorded[0] != next_name.decode("ascii"):
                    raise Failure(UNCERTAIN, REASON_EVIDENCE)
            finally:
                _zero(next_name)
        for key in present:
            canonical = bytearray(key.encode("ascii"))
            raw = None
            try:
                if directory_name == "stage":
                    raw = _read_leaf(fds, state, fd, canonical, MAX_TOTAL_BYTES, REASON_EVIDENCE)
                else:
                    prefix = bytearray(b".tmp-")
                    temporary = _concat((prefix, canonical))
                    try:
                        captured = _recover_joint_leaf(fds, state, fd, canonical, temporary, MAX_TOTAL_BYTES)
                        if captured is None:
                            raise Failure(UNCERTAIN, REASON_EVIDENCE)
                        if expected[key][2] and captured["temporary"]:
                            raise Failure(UNCERTAIN, REASON_EVIDENCE)
                        raw = captured["raw"]
                    finally:
                        _zero(prefix)
                        _zero(temporary)
                wanted_size, wanted_digest, is_recorded = expected[key]
                digest = _sha256(raw)
                try:
                    if len(raw) > wanted_size:
                        raise Failure(UNCERTAIN, REASON_EVIDENCE)
                    if is_recorded and (len(raw) != wanted_size or digest != wanted_digest):
                        raise Failure(UNCERTAIN, REASON_EVIDENCE)
                    if not is_recorded and len(raw) == wanted_size and digest != wanted_digest:
                        raise Failure(UNCERTAIN, REASON_EVIDENCE)
                finally:
                    _zero(digest)
            finally:
                if raw is not None:
                    _zero(raw)
                _zero(canonical)
        return {
            "has_artifacts": bool(names),
            "present": present,
            "recorded": {key for key, value in expected.items() if value[2]},
        }
    finally:
        _zero_owned(names)
        expected.clear()


def _recover_validate_artifact_cleanup(plan, tombstone, inventories):
    if not plan["plan_present"]:
        return
    stage = inventories.get("stage", {"present": set(), "recorded": set()})
    backup = inventories.get("backup", {"present": set(), "recorded": set()})
    cleanup_authorized = tombstone is not None or plan.get("verified", False)
    if not cleanup_authorized:
        if not stage["recorded"].issubset(stage["present"]) or not backup["recorded"].issubset(backup["present"]):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        return
    if not stage["present"].issubset(stage["recorded"]) or not backup["present"].issubset(backup["recorded"]):
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    staged_order = [item.hex() for item in plan.get("staged_paths", [])]
    stage_prefixes = [set(staged_order[:length]) for length in range(len(staged_order) + 1)]
    matching_stage = [length for length, prefix in enumerate(stage_prefixes) if prefix == stage["present"]]
    backup_order = sorted(item.hex() for item in plan.get("backup_paths", []))
    backup_prefixes = [set(backup_order[:length]) for length in range(len(backup_order) + 1)]
    matching_backup = [length for length, prefix in enumerate(backup_prefixes) if prefix == backup["present"]]
    if len(matching_stage) != 1 or len(matching_backup) != 1:
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    stage_length = matching_stage[0]
    backup_length = matching_backup[0]
    if plan.get("cleanup_done", False):
        if stage_length != 0 or backup_length != 0:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
    elif stage_length > 0 and backup_length != len(backup_order):
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    elif stage_length == len(staged_order) and backup_length != len(backup_order):
        raise Failure(UNCERTAIN, REASON_EVIDENCE)

def _recover_private(fds, state, tombstone):
    private_name = bytearray(PRIVATE_ROOT)
    try:
        private_stat = _lstat(state["root_fd"], private_name, REASON_EVIDENCE)
        if private_stat is None:
            return None
        private_fd = _recover_open_dir(fds, state, state["root_fd"], private_name)
    finally:
        _zero(private_name)
    names = _recover_names(private_fd, REASON_EVIDENCE)
    directory_fds = {}
    records = None
    plan = None
    try:
        encoded_names = {name.decode("ascii", "strict") for name in names}
        if any(name not in ("journal", "stage", "install", "backup") for name in encoded_names):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        if tombstone is None and encoded_names != {"journal", "stage", "install", "backup"}:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        if tombstone is not None:
            present_order = [name for name in ("journal", "stage", "install", "backup") if name in encoded_names]
            valid_suffixes = [list(("journal", "stage", "install", "backup")[index:]) for index in range(5)]
            if present_order not in valid_suffixes and encoded_names != {"journal", "stage", "install", "backup"}:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
        for name in ("journal", "stage", "install", "backup"):
            if name in encoded_names:
                directory_fds[name] = _recover_open_dir(fds, state, private_fd, bytearray(name.encode("ascii")))
        records = _recover_records(fds, state, directory_fds["journal"]) if "journal" in directory_fds else []
        plan = _recover_plan_from_records(records)
        if plan["tx_id"] is None:
            if tombstone is None:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            plan["tx_id"] = bytearray(tombstone["tx_id"])
        if tombstone is not None and plan["tx_id"] != tombstone["tx_id"]:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        inventories = {}
        has_artifacts = False
        for name in ("stage", "backup"):
            if name in directory_fds:
                inventory = _recover_artifact_inventory(fds, state, plan, name, directory_fds[name])
                inventories[name] = inventory
                has_artifacts = inventory["has_artifacts"] or has_artifacts
        if "install" in directory_fds:
            install = _recover_install_inventory(
                fds, state, plan, directory_fds["install"], directory_fds.get("stage")
            )
            has_artifacts = install["has_artifacts"] or has_artifacts
        else:
            install = {"has_artifacts": False, "key": None, "stat": None, "fd": None, "dir_fd": None}
        if tombstone is None and not plan["plan_present"] and has_artifacts:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        _recover_validate_artifact_cleanup(plan, tombstone, inventories)
        _recover_validate_workspace(fds, state, plan, tombstone, install, directory_fds.get("stage"))
        state["private_fd"] = private_fd
        state["dir_fds"] = directory_fds
        state["records"] = [bytearray(item["raw"]) for item in records]
        state["previous_record"] = _sha256(state["records"][-1]) if state["records"] else bytearray(32)
        state["journal_bytes"] = sum(len(raw) for raw in state["records"])
        state.update(plan)
        state["paths"] = [bytearray(entry["path"]) for entry in plan["entries"]]
        state["staged"] = []
        state["stage"] = None
        result = {"records": records, "plan": plan, "has_artifacts": has_artifacts}
        private_fd = None
        directory_fds = {}
        plan = None
        records = None
        return result
    except (UnicodeError, Failure):
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    finally:
        _zero_owned(names)
        if records is not None:
            _zero_owned(records)
        if plan is not None:
            _zero_owned(plan)
        for fd in directory_fds.values():
            _close(fds, fd)
        if private_fd is not None:
            _close(fds, private_fd)


def _recover_vector(records):
    return [_sha256(item["raw"]) for item in records]


def _recover_phase_two_payload(state, tombstone, private):
    records = private["records"]
    vector = _recover_vector(records)
    prefix_len = len(vector)
    source = 1 if tombstone is not None else 0
    plan_present = 1 if private["plan"]["plan_present"] else 0
    continuation = 1 if tombstone is not None and not plan_present and private["has_artifacts"] else 0
    if tombstone is None:
        if prefix_len < 1 or not private["plan"]["commit"]:
            _zero_owned(vector)
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        commitment = _vector_commitment(vector)
        vector_len = prefix_len
        ticket = bytearray(32)
        terminal = prefix_len - 1
        plan_digest = bytearray(private["plan"]["plan_digest"])
    else:
        if tombstone["tag"] != 0x0E:
            _zero_owned(vector)
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        commitment = bytearray(tombstone["commitment"])
        vector_len = tombstone["vector_len"]
        ticket = bytearray(tombstone["ticket"])
        terminal = vector_len - 1
        plan_digest = bytearray(tombstone["plan_digest"])
        locally_complete = prefix_len == vector_len
        local_commitment = _vector_commitment(vector) if locally_complete else None
        if (
            prefix_len > vector_len
            or (plan_present and private["plan"]["plan_digest"] != plan_digest)
            or (locally_complete and vector[-1] != tombstone["terminal_digest"])
            or (locally_complete and local_commitment != commitment)
        ):
            if local_commitment is not None:
                _zero(local_commitment)
            _zero_owned(vector)
            _zero(commitment)
            _zero(ticket)
            _zero(plan_digest)
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        if local_commitment is not None:
            _zero(local_commitment)
    phase = bytearray((2, source, continuation, plan_present, 1 if source else 0))
    vector_length = _u64(vector_len)
    prefix_length = _u32(prefix_len)
    terminal_revision = _u32(terminal)
    decision = bytearray((2,))
    parts = [phase, state["tx_id"], plan_digest, commitment, vector_length, ticket, prefix_length]
    parts.extend(vector)
    parts.extend((terminal_revision, decision))
    try:
        payload = _concat(parts)
        if len(payload) > MAX_PAYLOAD:
            _zero(payload)
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        state["evidence"] = {
            "phase": 2,
            "consumed": False,
            "source": source,
            "continuation": continuation,
            "vector": vector,
            "vector_len": vector_len,
            "terminal": terminal,
            "ticket": bytearray(ticket),
            "commitment": bytearray(commitment),
            "tombstone": tombstone,
        }
        vector = []
        return payload
    finally:
        _zero(phase)
        _zero(vector_length)
        _zero(prefix_length)
        _zero(terminal_revision)
        _zero(decision)
        _zero(commitment)
        _zero(ticket)
        _zero(plan_digest)
        _zero_owned(vector)


def _recover_phase_four_payload(state, tombstone, private):
    records = private["records"]
    vector = _recover_vector(records)
    prefix_len = len(vector)
    plan_present = 1 if private["plan"]["plan_present"] else 0
    source = 1 if tombstone is not None else 0
    if tombstone is not None and (
        prefix_len > tombstone["revision"]
        or (prefix_len == tombstone["revision"] and vector[-1] != tombstone["terminal_digest"])
    ):
        _zero_owned(vector)
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    continuation = 1 if source and not plan_present and private["has_artifacts"] else 0
    phase = bytearray((4, source, continuation, plan_present))
    prefix_length = _u32(prefix_len)
    terminal = prefix_len - 1 if prefix_len else 0
    terminal_revision = _u32(terminal)
    decision = bytearray((3,))
    parts = [phase, state["tx_id"]]
    if plan_present:
        parts.append(state["plan_digest"])
    parts.append(prefix_length)
    parts.extend(vector)
    parts.extend((terminal_revision, decision))
    try:
        payload = _concat(parts)
        if len(payload) > MAX_PAYLOAD:
            _zero(payload)
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        state["evidence"] = {
            "phase": 4,
            "consumed": False,
            "source": source,
            "continuation": continuation,
            "vector": vector,
            "terminal": terminal,
            "tombstone": tombstone,
        }
        vector = []
        return payload
    finally:
        _zero(phase)
        _zero(prefix_length)
        _zero(terminal_revision)
        _zero(decision)
        _zero_owned(vector)


def _recover_tombstone_only_payload(state, tombstone):
    state["tx_id"] = bytearray(tombstone["tx_id"])
    state["tombstone_record"] = tombstone
    if tombstone["tag"] == 0x0E:
        state["plan_digest"] = bytearray(tombstone["plan_digest"])
        state["tombstone"] = {
            "ticket": bytearray(tombstone["ticket"]),
            "commitment": bytearray(tombstone["commitment"]),
            "length": tombstone["vector_len"],
        }
        state["evidence"] = {"phase": 3, "consumed": False}
        phase = bytearray((3,))
        length = _u64(tombstone["vector_len"])
        kind = bytearray((0,))
        try:
            return _concat((phase, state["tx_id"], state["plan_digest"], tombstone["commitment"], length, tombstone["ticket"], kind))
        finally:
            _zero(phase)
            _zero(length)
            _zero(kind)
    state["evidence"] = {"phase": 5, "consumed": False}
    phase = bytearray((5,))
    kind = bytearray((1,))
    try:
        return _concat((phase, state["tx_id"], kind))
    finally:
        _zero(phase)
        _zero(kind)


def _recover(fds, state, payload):
    if payload:
        raise Failure(ERROR, ERR_FORMAT)
    state["recovery_classifier_only"] = True
    try:
        tombstone = _recover_tombstone(fds, state)
        private = _recover_private(fds, state, tombstone)
        if tombstone is None and private is None:
            state["phase"] = "READY_RECOVERED"
            state["recover_unused"] = False
            state["recovery_classifier_only"] = False
            return ABSENT, bytearray()
        if tombstone is not None and private is None:
            state["phase"] = "NEEDS_EVIDENCE"
            state["recover_unused"] = False
            return NEED_EVIDENCE, _recover_tombstone_only_payload(state, tombstone)
        if private is None:
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        state["recover_unused"] = False
        if tombstone is not None and tombstone["tag"] == 0x0E:
            state["phase"] = "NEEDS_EVIDENCE"
            return NEED_EVIDENCE, _recover_phase_two_payload(state, tombstone, private)
        if tombstone is not None and tombstone["tag"] == 0x0F:
            if private["plan"]["commit"]:
                raise Failure(UNCERTAIN, REASON_EVIDENCE)
            state["phase"] = "NEEDS_EVIDENCE"
            return NEED_EVIDENCE, _recover_phase_four_payload(state, tombstone, private)
        if private["plan"]["commit"]:
            state["phase"] = "NEEDS_EVIDENCE"
            return NEED_EVIDENCE, _recover_phase_two_payload(state, None, private)
        state["phase"] = "NEEDS_EVIDENCE"
        return NEED_EVIDENCE, _recover_phase_four_payload(state, None, private)
    except Failure:
        raise Failure(UNCERTAIN, REASON_EVIDENCE)


def _need_vector(fds, state):
    vector = _record_vector(fds, state)
    state["evidence"] = {"phase": 1, "consumed": False, "vector": vector}
    terminal = len(vector) - 1
    phase = bytearray((1,))
    count = _u32(len(vector))
    terminal_bytes = _u32(terminal)
    kind = bytearray((2,))
    parts = [phase, state["tx_id"], state["plan_digest"], count]
    parts.extend(vector)
    parts.extend((terminal_bytes, kind))
    try:
        return _concat(parts)
    finally:
        _zero(phase)
        _zero(count)
        _zero(terminal_bytes)
        _zero(kind)


def _finalize(fds, state, payload):
    if len(payload) != 64:
        raise Failure(ERROR, ERR_FORMAT)
    view = memoryview(payload)
    tx_view = view[:32]
    plan_view = view[32:]
    try:
        if tx_view != state["tx_id"] or plan_view != state["plan_digest"]:
            raise Failure(ERROR, ERR_CRYPTO)
    finally:
        plan_view.release()
        tx_view.release()
        view.release()
    state["phase"] = "FINALIZING"
    return _need_vector(fds, state)


def _delete_records(fds, state, vector):
    journal_fd = state["dir_fds"]["journal"]
    records = []
    try:
        for raw in state["records"]:
            records.append((struct.unpack_from(">I", raw, 1)[0], _sha256_hex(raw)))
        records.sort(key=lambda item: item[0], reverse=True)
        for revision, name in records:
            del revision
            _unlink_bound_leaf(fds, state, journal_fd, name, REASON_JOURNAL)
            removed = state["records"].pop()
            _zero(removed)
            disk_remaining = _read_journal(fds, state) if state["records"] else []
            try:
                if len(disk_remaining) != len(state["records"]):
                    raise Failure(UNCERTAIN, REASON_JOURNAL)
                for index, raw in enumerate(state["records"]):
                    digest = _sha256(raw)
                    try:
                        if digest != vector[index] or disk_remaining[index]["raw"] != raw:
                            raise Failure(UNCERTAIN, REASON_JOURNAL)
                    finally:
                        _zero(digest)
            finally:
                _zero_owned(disk_remaining)
    finally:
        for item in records:
            _zero(item[1])
        records.clear()


def _publish_commit_tombstone(fds, state, ticket, vector):
    commitment = _vector_commitment(vector)
    length = _u64(len(vector))
    payload = _concat((state["tx_id"], state["plan_digest"], commitment, length, ticket))
    raw = _make_record(0x0E, len(vector), vector[-1], payload)
    try:
        if len(raw) != 209:
            raise Failure(UNCERTAIN, REASON_INTERNAL)
        _publish(fds, state, state["root_fd"], bytearray(TOMBSTONE), raw, REASON_TOMBSTONE, True)
        state["tombstone"] = {"ticket": bytearray(ticket), "commitment": bytearray(commitment), "length": len(vector)}
    finally:
        _zero(commitment)
        _zero(length)
        _zero(payload)
        _zero(raw)


def _remove_private(fds, state):
    private_fd = state["private_fd"]
    private_name = bytearray(PRIVATE_ROOT)
    try:
        for subdir_index, name in enumerate(SUBDIRS):
            child_name = bytearray(name)
            child = state["dir_fds"][("journal", "stage", "install", "backup")[subdir_index]]
            try:
                if not _private_dir_empty(child):
                    raise Failure(UNCERTAIN, REASON_INTERNAL)
                _bind_name(private_fd, child_name, child, state, reason=REASON_PRIVATE_DIR, directory=True)
                _guard_mutation(state)
                os.rmdir(name, dir_fd=private_fd)
                _guard_mutation(state)
                os.fsync(private_fd)
                if _lstat(private_fd, child_name, REASON_PRIVATE_DIR) is not None:
                    raise Failure(UNCERTAIN, REASON_PRIVATE_DIR)
            except OSError:
                raise Failure(UNCERTAIN, REASON_IO)
            finally:
                _zero(child_name)
                _close(fds, child)
        _bind_name(state["root_fd"], private_name, private_fd, state, reason=REASON_PRIVATE_DIR, directory=True)
        _guard_mutation(state)
        os.rmdir(PRIVATE_ROOT, dir_fd=state["root_fd"])
        _guard_mutation(state)
        os.fsync(state["root_fd"])
        if _lstat(state["root_fd"], private_name, REASON_PRIVATE_DIR) is not None:
            raise Failure(UNCERTAIN, REASON_PRIVATE_DIR)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        _zero(private_name)
        _close(fds, private_fd)


def _supply_phase_one(fds, state, payload, evidence):
    if len(payload) < 106:
        raise Failure(ERROR, ERR_FORMAT)
    count = struct.unpack_from(">I", payload, 97)[0]
    if count > MAX_CHAIN or len(payload) != 106 + count * 32:
        raise Failure(ERROR, ERR_FORMAT)
    terminal_offset = 101 + count * 32
    view = memoryview(payload)
    tx_view = view[1:33]
    plan_view = view[33:65]
    ticket_view = view[65:97]
    vector_view = view[101:terminal_offset]
    try:
        valid_vector = count == len(evidence["vector"])
        if valid_vector:
            for index, expected in enumerate(evidence["vector"]):
                item = vector_view[index * 32:(index + 1) * 32]
                try:
                    if item != expected:
                        valid_vector = False
                        break
                finally:
                    item.release()
        terminal = struct.unpack_from(">I", payload, terminal_offset)[0]
        kind = payload[terminal_offset + 4]
        if (
            tx_view != state["tx_id"] or plan_view != state["plan_digest"]
            or not valid_vector or terminal != count - 1 or kind != 2 or ticket_view == ZERO32
        ):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
        _publish_commit_tombstone(fds, state, ticket_view, evidence["vector"])
        _delete_records(fds, state, evidence["vector"])
        _remove_private(fds, state)
        tomb = state["tombstone"]
        state["evidence"] = {"phase": 3, "consumed": False}
        phase = bytearray((3,))
        length = _u64(tomb["length"])
        response_kind = bytearray((0,))
        try:
            return _concat((phase, state["tx_id"], state["plan_digest"], tomb["commitment"], length, tomb["ticket"], response_kind))
        finally:
            _zero(phase)
            _zero(length)
            _zero(response_kind)
    finally:
        vector_view.release()
        ticket_view.release()
        plan_view.release()
        tx_view.release()
        view.release()
        _zero_owned(evidence["vector"])


def _supply_phase_three(fds, state, payload):
    if len(payload) != 170:
        raise Failure(ERROR, ERR_FORMAT)
    tomb = state["tombstone"]
    view = memoryview(payload)
    tx_view = view[1:33]
    plan_view = view[33:65]
    fresh_ticket_view = view[65:97]
    commitment_view = view[97:129]
    prior_ticket_view = view[137:169]
    try:
        if (
            payload[0] != 3 or tx_view != state["tx_id"] or plan_view != state["plan_digest"]
            or commitment_view != tomb["commitment"] or struct.unpack_from(">Q", payload, 129)[0] != tomb["length"]
            or prior_ticket_view != tomb["ticket"] or payload[169] != 0 or fresh_ticket_view == ZERO32
        ):
            raise Failure(UNCERTAIN, REASON_EVIDENCE)
    finally:
        prior_ticket_view.release()
        commitment_view.release()
        fresh_ticket_view.release()
        plan_view.release()
        tx_view.release()
        view.release()
    tomb_name = bytearray(TOMBSTONE)
    tomb_fd = None
    try:
        tomb_fd = _open_bound_leaf(fds, state, state["root_fd"], tomb_name, reason=REASON_TOMBSTONE)
        _bind_name(state["root_fd"], tomb_name, tomb_fd, state, reason=REASON_TOMBSTONE)
        _guard_mutation(state)
        _unlinkat(state["root_fd"], tomb_name)
        if os.fstat(tomb_fd).st_nlink != 0 or _lstat(state["root_fd"], tomb_name, REASON_TOMBSTONE) is not None:
            raise Failure(UNCERTAIN, REASON_TOMBSTONE)
        _guard_mutation(state)
        os.fsync(state["root_fd"])
        if os.fstat(tomb_fd).st_nlink != 0 or _lstat(state["root_fd"], tomb_name, REASON_TOMBSTONE) is not None:
            raise Failure(UNCERTAIN, REASON_TOMBSTONE)
    except OSError:
        raise Failure(UNCERTAIN, REASON_IO)
    finally:
        if tomb_fd is not None:
            _close(fds, tomb_fd)
        _zero(tomb_name)
    if (
        _lstat(state["root_fd"], TOMBSTONE, REASON_VERIFY) is not None
        or _lstat(state["root_fd"], TOMBSTONE_TEMP, REASON_VERIFY) is not None
        or _lstat(state["root_fd"], PRIVATE_ROOT, REASON_VERIFY) is not None
    ):
        raise Failure(UNCERTAIN, REASON_VERIFY)
    for entry in state["entries"]:
        if entry["kind"] != 2:
            continue
        try:
            parent, leaf = _walk_parent(fds, state, entry["path"], REASON_VERIFY)
        except Missing:
            raise Failure(UNCERTAIN, REASON_VERIFY)
        temporary_name = _sha256_hex(entry["path"])
        prefix = bytearray(b"\x01wa-upd-")
        try:
            temporary = _concat((prefix, temporary_name))
        finally:
            _zero(prefix)
        try:
            if _lstat(parent, temporary, REASON_VERIFY) is not None:
                raise Failure(UNCERTAIN, REASON_VERIFY)
        finally:
            _zero(leaf)
            _zero(temporary_name)
            _zero(temporary)
            _close(fds, parent)
    if not _zero_transaction_state(fds, state, "FINALIZED"):
        raise Failure(UNCERTAIN, REASON_IO)


def _supply(fds, state, payload):
    evidence = state.get("evidence")
    if evidence is None or evidence["consumed"]:
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    evidence["consumed"] = True
    if state.get("recovery_classifier_only", False):
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    if not payload or payload[0] != evidence["phase"]:
        raise Failure(UNCERTAIN, REASON_EVIDENCE)
    if evidence["phase"] == 1:
        return NEED_EVIDENCE, _supply_phase_one(fds, state, payload, evidence)
    if evidence["phase"] == 3:
        _supply_phase_three(fds, state, payload)
        return FINALIZED, bytearray()
    raise Failure(UNCERTAIN, REASON_EVIDENCE)


def _quit(fds, state):
    root = state.get("root_fd")
    if root is not None and root in fds:
        try:
            fcntl.flock(root, fcntl.LOCK_UN)
        except OSError:
            _close_all(fds)
            _zero_owned(state)
            raise Failure(UNCERTAIN, REASON_IO)
    stages_good = _release_stage_fds(fds, state)
    good = _close_all(fds)
    _zero_owned(state)
    if not stages_good or not good:
        raise Failure(UNCERTAIN, REASON_IO)


def _dispatch(fds, state, opcode, payload):
    phase = state["phase"]
    if opcode == RECOVER and payload:
        raise Failure(ERROR, ERR_FORMAT)
    if opcode == OPEN_ROOT:
        if phase != "INIT":
            raise Failure(ERROR, ERR_ORDER)
        _open_root(fds, state, payload)
        return READY, bytearray()
    if phase == "INIT":
        raise Failure(ERROR, ERR_ORDER)
    _verify_root_binding(state)
    _verify_stage_bindings(state)
    if opcode == RECOVER:
        if phase != "READY" or not state.get("recover_unused", False):
            raise Failure(ERROR, ERR_ORDER)
        return _recover(fds, state, payload)
    if opcode == SUPPLY_EVIDENCE:
        return _supply(fds, state, payload)
    if opcode == REPLAY_PLAN:
        raise Failure(ERROR, ERR_ORDER)
    table = {
        "READY": (BEGIN_PLAN, _begin_plan, OK),
        "READY_RECOVERED": (BEGIN_PLAN, _begin_plan, OK),
        "PLAN": (PLAN_ENTRY, _plan_entry, OK),
        "PREFLIGHT": (BACKUP, _backup, OK),
        "BACKUP_DONE": (PREPARE, _prepare, PREPARED),
        "PREPARED": (COMMIT, _commit, COMMIT_ACK),
        "COMMIT_DECIDED": (APPLY, _apply, APPLIED),
        "APPLIED": (VERIFY, _verify, VERIFIED),
        "VERIFIED": (CLEANUP, _cleanup, CLEANUP_DONE),
        "CLEANUP_DONE": (FINALIZE, _finalize, NEED_EVIDENCE),
    }
    if phase == "PLAN" and opcode == SEAL_PLAN:
        return SEALED, _seal_plan(fds, state, payload)
    if phase == "SEALED" and opcode == BEGIN_STAGE:
        result = _begin_stage(fds, state, payload)
        return (STAGED, result) if result is not None else (OK, bytearray())
    if phase == "SEALED" and opcode == PREFLIGHT:
        _preflight(fds, state, payload)
        return OK, bytearray()
    if phase == "STAGING" and opcode == CONTENT:
        result = _content(fds, state, payload)
        return (STAGED, result) if result is not None else (OK, bytearray())
    expected = table.get(phase)
    if expected is None or opcode != expected[0]:
        raise Failure(ERROR, ERR_ORDER)
    result = expected[1](fds, state, payload)
    return expected[2], bytearray() if result is None else result


def _main():
    fds = {}
    state = {"phase": "INIT", "root_fd": None, "root_dev": None, "terminal": False}
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    exit_code = 0
    try:
        while True:
            header = _read_exact(stdin_fd, HEADER_SIZE)
            if header is None:
                break
            if header is False:
                _failure_response(stdout_fd, Failure(UNCERTAIN, REASON_IO))
                exit_code = 1
                break
            payload = None
            response_payload = None
            try:
                opcode = header[0]
                payload_length = struct.unpack_from(">I", header, 1)[0]
                if payload_length > MAX_PAYLOAD:
                    _failure_response(stdout_fd, Failure(ERROR, ERR_FORMAT))
                    exit_code = 1
                    break
                payload = _read_exact(stdin_fd, payload_length)
                if payload is None or payload is False:
                    _failure_response(stdout_fd, Failure(UNCERTAIN, REASON_IO))
                    exit_code = 1
                    break
                if opcode == QUIT:
                    if payload:
                        raise Failure(ERROR, ERR_FORMAT)
                    try:
                        if state.get("root_fd") is not None:
                            _verify_root_binding(state)
                            _verify_stage_bindings(state)
                        _quit(fds, state)
                    except Failure as failure:
                        _failure_response(stdout_fd, failure)
                        return 2
                    _response(stdout_fd, OK)
                    return 0
                if state.get("root_fd") is not None:
                    _verify_root_binding(state)
                if state["terminal"]:
                    raise Failure(ERROR, ERR_ORDER)
                try:
                    status_code, response_payload = _dispatch(fds, state, opcode, payload)
                    _response(stdout_fd, status_code, response_payload)
                except Failure as failure:
                    if not _zero_transaction_state(fds, state, "TERMINAL_UNCERTAIN"):
                        failure = Failure(UNCERTAIN, REASON_IO)
                    _failure_response(stdout_fd, failure)
                except (OSError, ValueError, OverflowError, struct.error):
                    failure = Failure(UNCERTAIN, REASON_IO)
                    if not _zero_transaction_state(fds, state, "TERMINAL_UNCERTAIN"):
                        failure = Failure(UNCERTAIN, REASON_IO)
                    _failure_response(stdout_fd, failure)
            except Failure as failure:
                if not _zero_transaction_state(fds, state, "TERMINAL_UNCERTAIN"):
                    failure = Failure(UNCERTAIN, REASON_IO)
                _failure_response(stdout_fd, failure)
            finally:
                _zero(header)
                if payload is not None:
                    _zero(payload)
                if response_payload is not None:
                    _zero(response_payload)
    finally:
        if not _close_all(fds):
            exit_code = 1
        _zero_owned(state)
    return exit_code


def main():
    try:
        return _main()
    except BaseException:
        return 2


if __name__ == "__main__":
    sys.exit(main())
