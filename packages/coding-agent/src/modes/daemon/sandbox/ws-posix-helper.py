#!/usr/bin/env python3
"""POSIX helper for workspace root verification."""

import errno as errno_module
import fcntl
import os
import stat as stat_module
import struct
import sys

SEM_OPEN_ROOT = 0xFE
SEM_FLOCK_EX_NB = 0x40
SEM_QUIT = 0xFF
RESP_OK = 0x00
RESP_ERR = 0x01
HEADER_SIZE = 5
MAX_PAYLOAD = 1048576


def _zero(buffer):
    for index in range(len(buffer)):
        buffer[index] = 0


def _read_exact(fd, length):
    owned = bytearray(length)
    view = memoryview(owned)
    offset = 0
    try:
        while offset < length:
            try:
                count = os.readv(fd, [view[offset:]])
            except InterruptedError:
                continue
            if count == 0:
                _zero(owned)
                return None
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
            try:
                count = os.write(fd, view[offset:])
            except InterruptedError:
                continue
            if count == 0:
                raise OSError(errno_module.EIO, "zero-byte write")
            offset += count
    finally:
        view.release()
        _zero(data)


def _response(fd, status, payload):
    frame = bytearray(HEADER_SIZE + len(payload))
    try:
        struct.pack_into(">BI", frame, 0, status, len(payload))
        frame[HEADER_SIZE:] = payload
        _write_all(fd, frame)
    finally:
        _zero(frame)


def _resp_ok(fd, payload=None):
    if payload is None:
        payload = bytearray()
    _response(fd, RESP_OK, payload)


def _resp_err(fd, errno_value):
    payload = bytearray(4)
    try:
        struct.pack_into(">i", payload, 0, errno_value)
        _response(fd, RESP_ERR, payload)
    finally:
        _zero(payload)


def _stat_pack(st):
    payload = bytearray(72)
    struct.pack_into(
        ">QQiiIIqiiqqq",
        payload,
        0,
        st.st_dev,
        st.st_ino,
        st.st_mode,
        st.st_nlink,
        st.st_uid,
        st.st_gid,
        st.st_size,
        getattr(st, "st_blksize", 0),
        getattr(st, "st_flags", 0),
        getattr(st, "st_atime_ns", int(st.st_atime) * 1000000000),
        getattr(st, "st_mtime_ns", int(st.st_mtime) * 1000000000),
        getattr(st, "st_ctime_ns", int(st.st_ctime) * 1000000000),
    )
    return payload


def _valid_segment(segment):
    if not segment or segment == "." or segment == "..":
        return False
    if len(segment.encode("utf-8")) > 255:
        return False
    if "/" in segment or "\x00" in segment:
        return False
    return True


def _open_path_segments(path):
    segments = path.split("/")[1:]
    owned_fds = []
    try:
        root_fd = os.open(
            "/",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
        owned_fds.append(root_fd)
        for segment in segments:
            if not _valid_segment(segment):
                return None, errno_module.ENOENT
            next_fd = os.open(
                segment,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=owned_fds[-1],
            )
            owned_fds.append(next_fd)
            previous_fd = owned_fds[-2]
            try:
                os.close(previous_fd)
            except OSError:
                return None, errno_module.EIO
            del owned_fds[-2]
        final_fd = owned_fds[-1]
        st = os.fstat(final_fd)
        if not stat_module.S_ISDIR(st.st_mode):
            return None, errno_module.ENOTDIR
        del owned_fds[-1]
        return final_fd, st
    except OSError as error:
        return None, error.errno
    finally:
        while owned_fds:
            fd_value = owned_fds.pop()
            try:
                os.close(fd_value)
            except OSError:
                pass


def _is_safe_username(username):
    if not username:
        return False
    for character in username:
        if not (character.isascii() and (character.isalnum() or character in "._-")):
            return False
    return True


def _is_hex64(value):
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _validate_allowed_path(path):
    if not isinstance(path, str) or not path or len(path) > 4096:
        return False
    for character in path:
        code = ord(character)
        if code < 0x20 or code > 0x7E or code == 0x5C:
            return False
    if "//" in path:
        return False
    segments = path.split("/")
    if len(segments) == 6:
        return (
            segments[0] == ""
            and segments[1] == "root"
            and segments[2] == ".prime"
            and segments[3] == "agent"
            and segments[4] == "sandbox-sessions"
            and _is_hex64(segments[5])
        )
    if len(segments) != 7:
        return False
    return (
        segments[0] == ""
        and segments[1] in ("home", "Users")
        and _is_safe_username(segments[2])
        and segments[3] == ".prime"
        and segments[4] == "agent"
        and segments[5] == "sandbox-sessions"
        and _is_hex64(segments[6])
    )


def _cmd_open_root(fds, stdout_fd, payload):
    if 0 in fds:
        _resp_err(stdout_fd, errno_module.EBUSY)
        return
    try:
        path = payload.decode("utf-8")
    except UnicodeDecodeError:
        _resp_err(stdout_fd, errno_module.EINVAL)
        return
    if not _validate_allowed_path(path):
        _resp_err(stdout_fd, errno_module.EACCES)
        return
    fd, stat_or_errno = _open_path_segments(path)
    if fd is None:
        _resp_err(stdout_fd, stat_or_errno)
        return
    fds[0] = fd
    stat_payload = _stat_pack(stat_or_errno)
    try:
        _resp_ok(stdout_fd, stat_payload)
    finally:
        _zero(stat_payload)


def _cmd_flock_ex_nb(fds, stdout_fd, payload):
    if len(payload) != 4:
        _resp_err(stdout_fd, errno_module.EINVAL)
        return
    fd_id = struct.unpack_from(">i", payload, 0)[0]
    fd = fds.get(fd_id)
    if fd is None:
        _resp_err(stdout_fd, errno_module.EBADF)
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError) as error:
        errno_value = error.errno
        if errno_value is None:
            errno_value = errno_module.EAGAIN
        _resp_err(stdout_fd, errno_value)
        return
    _resp_ok(stdout_fd)


def _close_fd_table(fds):
    close_ok = True
    while fds:
        fd_id, fd_value = fds.popitem()
        del fd_id
        try:
            os.close(fd_value)
        except OSError:
            close_ok = False
    return close_ok


def _cmd_quit(fds, stdout_fd):
    if not _close_fd_table(fds):
        _resp_err(stdout_fd, errno_module.EIO)
        return False
    _resp_ok(stdout_fd)
    return True


def main():
    fds = {}
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    try:
        while True:
            header = _read_exact(stdin_fd, HEADER_SIZE)
            if header is None:
                return 0
            payload = None
            try:
                opcode = header[0]
                payload_length = struct.unpack_from(">I", header, 1)[0]
                if payload_length > MAX_PAYLOAD:
                    _resp_err(stdout_fd, errno_module.EMSGSIZE)
                    return 1
                payload = _read_exact(stdin_fd, payload_length)
                if payload is None:
                    return 1
                if opcode == SEM_QUIT:
                    if payload_length != 0:
                        _resp_err(stdout_fd, errno_module.EINVAL)
                        return 1
                    return 0 if _cmd_quit(fds, stdout_fd) else 1
                try:
                    if opcode == SEM_OPEN_ROOT:
                        _cmd_open_root(fds, stdout_fd, payload)
                    elif opcode == SEM_FLOCK_EX_NB:
                        _cmd_flock_ex_nb(fds, stdout_fd, payload)
                    else:
                        _resp_err(stdout_fd, errno_module.EOPNOTSUPP)
                except Exception:
                    _resp_err(stdout_fd, errno_module.EIO)
            finally:
                _zero(header)
                if payload is not None:
                    _zero(payload)
    finally:
        _close_fd_table(fds)


if __name__ == "__main__":
    sys.exit(main())
