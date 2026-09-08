#!/usr/bin/env python3
"""Private POSIX durability helper for Store V4 and V5 startup protocols."""

import errno
import fcntl
import hashlib
import os
import pwd
import stat
import struct
import sys

_HEADER = 5
_MAX_PAYLOAD = 1048576
_MAX_LEDGER_BYTES = 262128
_MAX_LEDGER_RECORDS = 16
_MAX_GENERATIONS = 2
_MAX_WAL_RECORDS = 7
_WAL_SIZE = 320

_OPEN = 0xFE
_QUIT = 0xFF
_INVENTORY = 0x01
_CREATE = 0x02
_APPEND_WAL = 0x03
_APPEND_LEDGER = 0x04
_PREPARE = 0x05
_SWITCH = 0x06
_REMOVE = 0x07
_PURGE = 0x08
_INSPECT = 0x09

_OK = 0x80
_SESSION = 0x81
_DONE = 0x82
_WS_TRANSACTION = 0x83
_ERROR = 0xE0

_E_INPUT = 0x01
_E_PROTOCOL = 0x02
_E_BOUNDS = 0x03
_E_ABSENT = 0x04
_E_EXISTS = 0x05
_E_BUSY = 0x06
_E_OWNER = 0x07
_E_MODE = 0x08
_E_TYPE = 0x09
_E_NLINK = 0x0A
_E_SYMLINK = 0x0B
_E_DIGEST = 0x0C
_E_HEAD = 0x0D
_E_STATE = 0x0E
_E_FSYNC = 0x0F
_E_IO = 0x10
_E_UNCERTAIN = 0x11

_LOCK = b".lock"
_IDENTITY = b"identity.rec"
_LEDGER = b"ledger"
_GENERATIONS = b"generations"
_WAL = b"wal"
_HEAD = b"head"
_ROOT_NAME = b"sandbox-session-state-v1"
_LEDGER_MAGIC = b"PILEDHD1"
_WAL_HEAD_MAGIC = b"PIWALHD1"
_SESSION_MAGIC = b"PISESHD1"
_WAL_MAGIC = b"PIHOSTWALV1"
_ZERO32 = bytes(32)
_HEX = b"0123456789abcdef"
_CONSTANT_DIGEST_OFFSETS = (128, 160, 192, 224, 256, 288)

_W_ALLOCATED = 1
_W_CREATE_DISPATCHED = 2
_W_PRESENT = 3
_W_RUNTIME_DISPATCHED = 4
_W_RUNNING = 5
_W_DELETE_DISPATCHED = 6
_W_ABSENT = 7
_W_RETIRED_ABSENT = 8
_V5_HELLO = 0xF0
_V5_READY = 0x84
_WS_BEGIN = 0x0A
_WS_WRITE_STREAM = 0x0B
_WS_ABORT_DRAFT = 0x0C
_WS_SEAL_INPUTS = 0x0D
_WS_MARK_START_DISPATCHED = 0x0E
_WS_BEGIN_VECTOR = 0x0F
_WS_SEAL_VECTOR = 0x10
_WS_CONSUME_ATTEMPT = 0x11
_WS_RECORD_RESULT = 0x12
_WS_INSPECT = 0x13
_WS_ACK_RESULT = 0x14
_WS_ACK_AND_PURGE = 0x15
_WS_READ = 0x16
_WS_INVENTORY = 0x17
_MODE_UNSELECTED = 0
_MODE_V4_COMPAT = 1
_MODE_V5_READY = 2
_MODE_V5_BLOCKED = 3

_V5_OPCODES = frozenset((_V5_HELLO, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17))
_WORKSPACE_EVIDENCE = b"workspace-evidence"
_INPUT_MANIFEST = b"\x69nput.manifest"
_INPUT_MANIFEST_TEMP_PREFIX = b".ws-\x69nput-manifest-tmp."
_PLAN_DRAFT_PREFIX = b".ws-plan."
_CONTENT_DRAFT_PREFIX = b".ws-content."
_INPUT_MANIFEST_MAGIC = b"PIWSIMF5"
_PLAN_RECORD_MAGIC = b"PIWSPLN1"
_CONTENT_RECORD_MAGIC = b"PIWSCNT1"
_INPUT_MANIFEST_SIZE = 272
_PLAN_HEADER_SIZE = 12
_CONTENT_HEADER_SIZE = 16
_MAX_PLAN_PAYLOAD = 1048576
_MAX_CONTENT_PAYLOAD = 1073741824
_MAX_V5_ITEMS = 8
_V5_ITEM_RESERVATION = 1100000000
_V5_GLOBAL_RESERVATION = 8800000000
_WS_TRANSACTION_SIZE = 401


class Fatal(Exception):
    __slots__ = ("code",)

    def __init__(self, code):
        self.code = code


class Fds:
    __slots__ = ("items", "uncertain", "recovering")

    def __init__(self):
        self.items = []
        self.uncertain = False
        self.recovering = False

    def add(self, fd):
        self.items.append(fd)
        return fd

    def mark(self):
        return len(self.items)

    def require_certain(self):
        if self.uncertain:
            raise Fatal(_E_UNCERTAIN)

    def begin_recovery(self):
        self.require_certain()
        if self.recovering:
            raise Fatal(_E_UNCERTAIN)
        self.recovering = True

    def end_recovery(self, expected):
        self.require_certain()
        if self.items != expected:
            raise Fatal(_E_UNCERTAIN)
        self.recovering = False

    def close(self, fd):
        found = -1
        index = len(self.items) - 1
        while index >= 0:
            if self.items[index] == fd:
                found = index
                break
            index -= 1
        if found < 0:
            self.uncertain = True
            return
        try:
            os.close(fd)
        except OSError:
            self.uncertain = True
        del self.items[found]

    def close_for_recovery(self, fd):
        self.close(fd)
        self.require_certain()

    def close_after(self, mark):
        while len(self.items) > mark:
            self.close(self.items[-1])

    def close_all(self):
        self.recovering = False
        self.close_after(0)


def _zero(value):
    index = 0
    while index < len(value):
        value[index] = 0
        index += 1


def _same(left, right):
    if len(left) != len(right):
        return False
    difference = 0
    index = 0
    while index < len(left):
        difference |= left[index] ^ right[index]
        index += 1
    return difference == 0


def _same_at(source, offset, expected):
    if offset < 0 or offset + len(expected) > len(source):
        return False
    difference = 0
    index = 0
    while index < len(expected):
        difference |= source[offset + index] ^ expected[index]
        index += 1
    return difference == 0


def _range_zero(source, start, end):
    combined = 0
    index = start
    while index < end:
        combined |= source[index]
        index += 1
    return combined == 0


def _all_zero(value):
    combined = 0
    index = 0
    while index < len(value):
        combined |= value[index]
        index += 1
    return combined == 0


def _digest(value):
    return bytearray(hashlib.sha256(value).digest())


def _hex_name(value):
    return value.hex().encode("ascii")


def _number_name(value):
    return format(value, "016x").encode("ascii")


def _record_name(number, digest, suffix):
    return _number_name(number) + b"-" + _hex_name(digest) + suffix


def _valid_hex_name(value, size):
    if len(value) != size:
        return False
    index = 0
    while index < size:
        if value[index] not in _HEX:
            return False
        index += 1
    return True


def _temp_name():
    random_value = bytearray(os.urandom(32))
    try:
        return b".tmp." + _hex_name(random_value)
    finally:
        _zero(random_value)


def _valid_temp(value):
    return len(value) == 69 and value[:5] == b".tmp." and _valid_hex_name(value[5:], 64)


def _contains_temp(entries):
    index = 0
    while index < len(entries):
        if entries[index].startswith(b".tmp."):
            return True
        index += 1
    return False


def _contains_outside(entries, allowed):
    index = 0
    while index < len(entries):
        if entries[index] not in allowed:
            return True
        index += 1
    return False


def _parse_record_name(value, suffix):
    expected = 16 + 1 + 64 + len(suffix)
    if len(value) != expected or value[16:17] != b"-" or value[-len(suffix):] != suffix:
        return None
    number_part = value[:16]
    digest_part = value[17:81]
    if not _valid_hex_name(number_part, 16) or not _valid_hex_name(digest_part, 64):
        return None
    try:
        number = int(number_part.decode("ascii"), 16)
        digest = bytearray.fromhex(digest_part.decode("ascii"))
    except ValueError:
        return None
    if _number_name(number) != number_part:
        _zero(digest)
        return None
    return number, digest


def _valid_record_name(value, suffix):
    parsed = _parse_record_name(value, suffix)
    if parsed is None:
        return False
    number, digest = parsed
    _zero(digest)
    return True


def _read_exact(fd, size):
    result = bytearray(size)
    view = memoryview(result)
    offset = 0
    try:
        while offset < size:
            try:
                count = os.readv(fd, (view[offset:],))
            except InterruptedError:
                continue
            if count <= 0:
                _zero(result)
                raise Fatal(_E_PROTOCOL)
            offset += count
        return result
    except OSError:
        _zero(result)
        raise Fatal(_E_UNCERTAIN)
    finally:
        view.release()


def _write_frame(fd, opcode, payload):
    if len(payload) > _MAX_PAYLOAD:
        raise Fatal(_E_BOUNDS)
    frame = bytearray(_HEADER + len(payload))
    view = memoryview(frame)
    try:
        struct.pack_into(">BI", frame, 0, opcode, len(payload))
        frame[_HEADER:] = payload
        offset = 0
        while offset < len(frame):
            try:
                count = os.write(fd, view[offset:])
            except InterruptedError:
                continue
            if count <= 0:
                raise Fatal(_E_UNCERTAIN)
            offset += count
    except OSError:
        raise Fatal(_E_UNCERTAIN)
    finally:
        view.release()
        _zero(frame)


def _ok_payload(request, digest=None):
    if digest is None:
        result = bytearray(1)
    else:
        result = bytearray(33)
        result[1:33] = digest
    result[0] = request
    return result


def _error_payload(request, code):
    result = bytearray(2)
    result[0] = request
    result[1] = code
    return result


def _fsync(fd):
    try:
        os.fsync(fd)
    except OSError:
        raise Fatal(_E_FSYNC)


def _fdatasync(fd):
    try:
        os.fdatasync(fd)
    except OSError:
        raise Fatal(_E_FSYNC)


def _entry_bytes(value):
    if isinstance(value, bytes):
        try:
            value.decode("ascii")
        except UnicodeDecodeError:
            raise Fatal(_E_STATE)
        return value
    try:
        return value.encode("ascii")
    except UnicodeEncodeError:
        raise Fatal(_E_STATE)


def _list(fd):
    try:
        raw = os.listdir(fd)
    except OSError:
        raise Fatal(_E_IO)
    result = []
    index = 0
    while index < len(raw):
        result.append(_entry_bytes(raw[index]))
        index += 1
    result.sort()
    return result


def _open_raw(fds, parent, name, flags, mode=None):
    try:
        if mode is None:
            fd = os.open(name, flags, dir_fd=parent)
        else:
            fd = os.open(name, flags, mode, dir_fd=parent)
    except OSError as error:
        return None, error.errno
    return fds.add(fd), None


def _fstat(fd):
    try:
        return os.fstat(fd)
    except OSError:
        raise Fatal(_E_UNCERTAIN)


def _validate_dir_stat(st, uid, device, managed):
    if not stat.S_ISDIR(st.st_mode):
        raise Fatal(_E_TYPE)
    if st.st_uid != uid:
        raise Fatal(_E_OWNER)
    if device is not None and st.st_dev != device:
        raise Fatal(_E_UNCERTAIN)
    if st.st_nlink < 2:
        raise Fatal(_E_NLINK)
    mode = stat.S_IMODE(st.st_mode)
    if managed:
        if mode != 0o700:
            raise Fatal(_E_MODE)
    elif mode & 0o022:
        raise Fatal(_E_MODE)


def _open_dir(fds, parent, name, uid, device, managed=True):
    before, before_error = _lstat(parent, name)
    if before is None:
        return None, before_error
    if stat.S_ISLNK(before.st_mode):
        raise Fatal(_E_SYMLINK)
    _validate_dir_stat(before, uid, device, managed)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd, error = _open_raw(fds, parent, name, flags)
    if fd is None:
        raise Fatal(_E_UNCERTAIN)
    after = _fstat(fd)
    _validate_dir_stat(after, uid, device, managed)
    if before.st_dev != after.st_dev or before.st_ino != after.st_ino:
        raise Fatal(_E_UNCERTAIN)
    return fd, None


def _make_dir(fds, parent, name, uid, device):
    fd, error = _open_dir(fds, parent, name, uid, device)
    if fd is not None:
        return fd, False
    if error != errno.ENOENT:
        if error == errno.ELOOP:
            raise Fatal(_E_SYMLINK)
        raise Fatal(_E_UNCERTAIN)
    created = True
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
    except OSError as create_error:
        if create_error.errno != errno.EEXIST:
            raise Fatal(_E_IO if create_error.errno in (errno.EIO, errno.ENOSPC, errno.EROFS) else _E_UNCERTAIN)
        created = False
    fd, error = _open_dir(fds, parent, name, uid, device)
    if fd is None:
        raise Fatal(_E_UNCERTAIN)
    _fsync(parent)
    return fd, created


def _lstat(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False), None
    except OSError as error:
        return None, error.errno


def _validate_file_stat(st, uid, device, links=1):
    if stat.S_ISLNK(st.st_mode):
        raise Fatal(_E_SYMLINK)
    if not stat.S_ISREG(st.st_mode):
        raise Fatal(_E_TYPE)
    if st.st_uid != uid:
        raise Fatal(_E_OWNER)
    if st.st_dev != device:
        raise Fatal(_E_UNCERTAIN)
    if stat.S_IMODE(st.st_mode) != 0o600:
        raise Fatal(_E_MODE)
    if st.st_nlink != links:
        raise Fatal(_E_NLINK)


def _open_file(fds, parent, name, uid, device, maximum, exact=None, links=1):
    before, error = _lstat(parent, name)
    if before is None:
        return None, error
    _validate_file_stat(before, uid, device, links)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd, error = _open_raw(fds, parent, name, flags)
    if fd is None:
        raise Fatal(_E_UNCERTAIN)
    after = _fstat(fd)
    _validate_file_stat(after, uid, device, links)
    if before.st_dev != after.st_dev or before.st_ino != after.st_ino:
        raise Fatal(_E_UNCERTAIN)
    if after.st_size > maximum or (exact is not None and after.st_size != exact):
        raise Fatal(_E_BOUNDS)
    return fd, None


def _read_file(fds, parent, name, uid, device, maximum, exact=None, links=1):
    mark = fds.mark()
    result = None
    complete = False
    try:
        fd, error = _open_file(fds, parent, name, uid, device, maximum, exact, links)
        if fd is None:
            complete = True
            return None, error
        size = _fstat(fd).st_size
        result = bytearray(size)
        view = memoryview(result)
        try:
            offset = 0
            while offset < size:
                try:
                    count = os.readv(fd, (view[offset:],))
                except InterruptedError:
                    continue
                if count <= 0:
                    raise Fatal(_E_UNCERTAIN)
                offset += count
        finally:
            view.release()
        complete = True
        return result, None
    except OSError:
        raise Fatal(_E_IO)
    finally:
        fds.close_after(mark)
        if fds.uncertain:
            complete = False
        if not complete and result is not None:
            _zero(result)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _fsync_named(fds, parent, name, uid, device, maximum, exact=None):
    mark = fds.mark()
    try:
        fd, error = _open_file(fds, parent, name, uid, device, maximum, exact)
        if fd is None:
            raise Fatal(_E_UNCERTAIN)
        _fdatasync(fd)
    finally:
        fds.close_after(mark)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _write_temp(fds, parent, content, uid, device):
    name = _temp_name()
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    fd, error = _open_raw(fds, parent, name, flags, 0o600)
    if fd is None:
        raise Fatal(_E_IO if error in (errno.EIO, errno.ENOSPC, errno.EROFS) else _E_UNCERTAIN)
    try:
        view = memoryview(content)
        try:
            offset = 0
            while offset < len(content):
                try:
                    count = os.write(fd, view[offset:])
                except InterruptedError:
                    continue
                if count <= 0:
                    raise Fatal(_E_UNCERTAIN)
                offset += count
        finally:
            view.release()
        _fdatasync(fd)
        written = _fstat(fd)
        _validate_file_stat(written, uid, device)
        if written.st_size != len(content):
            raise Fatal(_E_UNCERTAIN)
        named, named_error = _lstat(parent, name)
        if named is None or named_error is not None:
            raise Fatal(_E_UNCERTAIN)
        _validate_file_stat(named, uid, device)
        if named.st_dev != written.st_dev or named.st_ino != written.st_ino:
            raise Fatal(_E_UNCERTAIN)
        return name, fd, written.st_dev, written.st_ino
    except OSError:
        fds.close(fd)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)
        raise Fatal(_E_IO)
    except BaseException:
        fds.close(fd)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)
        raise


def _read_bound_fd(fd, expected):
    result = bytearray(len(expected))
    view = memoryview(result)
    try:
        try:
            os.lseek(fd, 0, os.SEEK_SET)
        except OSError:
            raise Fatal(_E_UNCERTAIN)
        offset = 0
        while offset < len(result):
            try:
                count = os.readv(fd, (view[offset:],))
            except InterruptedError:
                continue
            except OSError:
                raise Fatal(_E_UNCERTAIN)
            if count <= 0:
                raise Fatal(_E_UNCERTAIN)
            offset += count
        try:
            extra = os.read(fd, 1)
        except OSError:
            raise Fatal(_E_UNCERTAIN)
        if len(extra) != 0 or not _same(result, expected):
            raise Fatal(_E_DIGEST)
    finally:
        view.release()
        _zero(result)


def _prove_published(fds, parent, target, temp_fd, temp_device, temp_inode, content, uid, device):
    retained = _fstat(temp_fd)
    _validate_file_stat(retained, uid, device)
    if retained.st_dev != temp_device or retained.st_ino != temp_inode or retained.st_size != len(content):
        raise Fatal(_E_UNCERTAIN)
    final, final_error = _lstat(parent, target)
    if final is None or final_error is not None:
        raise Fatal(_E_UNCERTAIN)
    _validate_file_stat(final, uid, device)
    if final.st_dev != temp_device or final.st_ino != temp_inode or final.st_size != len(content):
        raise Fatal(_E_UNCERTAIN)
    _read_bound_fd(temp_fd, content)
    reopened_mark = fds.mark()
    try:
        reopened, open_error = _open_file(fds, parent, target, uid, device, len(content), len(content))
        if reopened is None or open_error is not None:
            raise Fatal(_E_UNCERTAIN)
        reopened_stat = _fstat(reopened)
        if reopened_stat.st_dev != temp_device or reopened_stat.st_ino != temp_inode:
            raise Fatal(_E_UNCERTAIN)
        _read_bound_fd(reopened, content)
        _fdatasync(reopened)
        final_again, final_again_error = _lstat(parent, target)
        if final_again is None or final_again_error is not None:
            raise Fatal(_E_UNCERTAIN)
        _validate_file_stat(final_again, uid, device)
        if final_again.st_dev != temp_device or final_again.st_ino != temp_inode:
            raise Fatal(_E_UNCERTAIN)
    finally:
        fds.close_after(reopened_mark)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _unlink(parent, name, absent_ok=False):
    try:
        os.unlink(name, dir_fd=parent)
    except OSError as error:
        if absent_ok and error.errno == errno.ENOENT:
            return False
        raise Fatal(_E_IO if error.errno in (errno.EIO, errno.EROFS) else _E_UNCERTAIN)
    return True


def _rmdir(parent, name, absent_ok=False):
    try:
        os.rmdir(name, dir_fd=parent)
    except OSError as error:
        if absent_ok and error.errno == errno.ENOENT:
            return False
        raise Fatal(_E_IO if error.errno in (errno.EIO, errno.EROFS) else _E_UNCERTAIN)
    return True


def _read_matching(fds, parent, name, expected, uid, device):
    data, error = _read_file(fds, parent, name, uid, device, len(expected), len(expected))
    if data is None:
        return False, error
    try:
        return _same(data, expected), None
    finally:
        _zero(data)


def _publish_record(fds, parent, target, content, uid, device):
    temp, temp_fd, temp_device, temp_inode = _write_temp(fds, parent, content, uid, device)
    linked = False
    try:
        source, source_error = _lstat(parent, temp)
        if source is None or source_error is not None:
            raise Fatal(_E_UNCERTAIN)
        _validate_file_stat(source, uid, device)
        if source.st_dev != temp_device or source.st_ino != temp_inode:
            raise Fatal(_E_UNCERTAIN)
        try:
            os.link(temp, target, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            linked = True
        except OSError as error:
            if error.errno != errno.EEXIST:
                raise Fatal(_E_IO if error.errno in (errno.EIO, errno.EROFS, errno.ENOSPC) else _E_UNCERTAIN)
        if linked:
            left, left_error = _lstat(parent, temp)
            right, right_error = _lstat(parent, target)
            if left is None or right is None or left_error is not None or right_error is not None:
                raise Fatal(_E_UNCERTAIN)
            _validate_file_stat(left, uid, device, 2)
            _validate_file_stat(right, uid, device, 2)
            if left.st_ino != temp_inode or left.st_dev != temp_device or right.st_ino != temp_inode or right.st_dev != temp_device:
                raise Fatal(_E_UNCERTAIN)
            _read_bound_fd(temp_fd, content)
        else:
            matched, match_error = _read_matching(fds, parent, target, content, uid, device)
            if match_error is not None or not matched:
                raise Fatal(_E_DIGEST)
        _unlink(parent, temp)
        _fsync(parent)
        if linked:
            _prove_published(fds, parent, target, temp_fd, temp_device, temp_inode, content, uid, device)
        else:
            final_data, final_error = _read_file(fds, parent, target, uid, device, len(content), len(content))
            if final_data is None or final_error is not None:
                raise Fatal(_E_UNCERTAIN)
            try:
                if not _same(final_data, content):
                    raise Fatal(_E_DIGEST)
            finally:
                _zero(final_data)
            _fsync_named(fds, parent, target, uid, device, len(content), len(content))
        return linked
    finally:
        fds.close(temp_fd)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _publish_head(fds, parent, name, content, uid, device):
    current, current_error = _lstat(parent, name)
    first = current is None and current_error == errno.ENOENT
    if current is None and not first:
        raise Fatal(_E_UNCERTAIN)
    if current is not None:
        _validate_file_stat(current, uid, device)
    temp, temp_fd, temp_device, temp_inode = _write_temp(fds, parent, content, uid, device)
    try:
        source, source_error = _lstat(parent, temp)
        if source is None or source_error is not None:
            raise Fatal(_E_UNCERTAIN)
        _validate_file_stat(source, uid, device)
        if source.st_dev != temp_device or source.st_ino != temp_inode:
            raise Fatal(_E_UNCERTAIN)
        if first:
            try:
                os.link(temp, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except OSError:
                raise Fatal(_E_UNCERTAIN)
            temp_st, temp_error = _lstat(parent, temp)
            head_st, head_error = _lstat(parent, name)
            if temp_st is None or head_st is None or temp_error is not None or head_error is not None:
                raise Fatal(_E_UNCERTAIN)
            _validate_file_stat(temp_st, uid, device, 2)
            _validate_file_stat(head_st, uid, device, 2)
            if temp_st.st_dev != temp_device or temp_st.st_ino != temp_inode or head_st.st_dev != temp_device or head_st.st_ino != temp_inode:
                raise Fatal(_E_UNCERTAIN)
            _read_bound_fd(temp_fd, content)
            _unlink(parent, temp)
        else:
            before, before_error = _lstat(parent, name)
            if before is None or before_error is not None:
                raise Fatal(_E_UNCERTAIN)
            _validate_file_stat(before, uid, device)
            if before.st_dev != current.st_dev or before.st_ino != current.st_ino:
                raise Fatal(_E_UNCERTAIN)
            source_again, source_again_error = _lstat(parent, temp)
            if source_again is None or source_again_error is not None:
                raise Fatal(_E_UNCERTAIN)
            _validate_file_stat(source_again, uid, device)
            if source_again.st_dev != temp_device or source_again.st_ino != temp_inode:
                raise Fatal(_E_UNCERTAIN)
            guard = _temp_name()
            try:
                os.link(name, guard, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except OSError as error:
                raise Fatal(_E_IO if error.errno in (errno.EIO, errno.EROFS, errno.ENOSPC) else _E_UNCERTAIN)
            guarded_name, guarded_name_error = _lstat(parent, name)
            guarded_alias, guarded_alias_error = _lstat(parent, guard)
            if guarded_name is None or guarded_alias is None or guarded_name_error is not None or guarded_alias_error is not None:
                raise Fatal(_E_UNCERTAIN)
            _validate_file_stat(guarded_name, uid, device, 2)
            _validate_file_stat(guarded_alias, uid, device, 2)
            if guarded_name.st_dev != current.st_dev or guarded_name.st_ino != current.st_ino or guarded_alias.st_dev != current.st_dev or guarded_alias.st_ino != current.st_ino:
                raise Fatal(_E_UNCERTAIN)
            try:
                os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
            except OSError as error:
                raise Fatal(_E_IO if error.errno in (errno.EIO, errno.EROFS) else _E_UNCERTAIN)
            displaced, displaced_error = _lstat(parent, guard)
            if displaced is None or displaced_error is not None:
                raise Fatal(_E_UNCERTAIN)
            _validate_file_stat(displaced, uid, device)
            if displaced.st_dev != current.st_dev or displaced.st_ino != current.st_ino:
                raise Fatal(_E_UNCERTAIN)
            _unlink(parent, guard)
        _prove_published(fds, parent, name, temp_fd, temp_device, temp_inode, content, uid, device)
        _fsync(parent)
        _prove_published(fds, parent, name, temp_fd, temp_device, temp_inode, content, uid, device)
    finally:
        fds.close(temp_fd)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _clean_temps(fds, parent, entries, uid, device, record_suffix, fixed_targets=(), deferred_temp=None):
    index = 0
    changed = False
    while index < len(entries):
        name = entries[index]
        if name.startswith(b".tmp."):
            if name == deferred_temp:
                index += 1
                continue
            if not _valid_temp(name):
                raise Fatal(_E_STATE)
            temp_st, temp_error = _lstat(parent, name)
            if temp_st is None or temp_error is not None:
                raise Fatal(_E_UNCERTAIN)
            if temp_st.st_nlink == 1:
                _validate_file_stat(temp_st, uid, device)
                _unlink(parent, name)
                changed = True
            elif temp_st.st_nlink == 2:
                _validate_file_stat(temp_st, uid, device, 2)
                target = None
                second = 0
                while second < len(entries):
                    candidate = entries[second]
                    parsed = _parse_record_name(candidate, record_suffix) if len(record_suffix) > 0 else None
                    if parsed is not None:
                        number_value, digest_value = parsed
                        candidate_st, candidate_error = _lstat(parent, candidate)
                        if candidate_st is not None and candidate_error is None and candidate_st.st_ino == temp_st.st_ino and candidate_st.st_dev == temp_st.st_dev:
                            target = candidate
                        _zero(digest_value)
                    second += 1
                if target is None:
                    second = 0
                    while second < len(fixed_targets):
                        candidate = fixed_targets[second]
                        candidate_st, candidate_error = _lstat(parent, candidate)
                        if candidate_st is not None and candidate_error is None and candidate_st.st_ino == temp_st.st_ino and candidate_st.st_dev == temp_st.st_dev:
                            target = candidate
                        second += 1
                if target is None:
                    raise Fatal(_E_NLINK)
                target_st, target_error = _lstat(parent, target)
                if target_st is None or target_error is not None:
                    raise Fatal(_E_UNCERTAIN)
                _validate_file_stat(target_st, uid, device, 2)
                parsed_target = _parse_record_name(target, record_suffix) if len(record_suffix) > 0 else None
                if parsed_target is not None:
                    unused_number, expected_digest = parsed_target
                    data, data_error = _read_file(fds, parent, target, uid, device, _MAX_PAYLOAD, links=2)
                    if data is None or data_error is not None:
                        _zero(expected_digest)
                        raise Fatal(_E_UNCERTAIN)
                    actual_digest = None
                    try:
                        actual_digest = _digest(data)
                        if not _same(actual_digest, expected_digest):
                            raise Fatal(_E_DIGEST)
                    finally:
                        _zero(data)
                        if actual_digest is not None:
                            _zero(actual_digest)
                        _zero(expected_digest)
                elif target not in fixed_targets:
                    raise Fatal(_E_STATE)
                elif target == _HEAD and record_suffix in (b".rec", b".wal"):
                    magic = _LEDGER_MAGIC if record_suffix == b".rec" else _WAL_HEAD_MAGIC
                    head_data, head_error = _read_head(fds, parent, _HEAD, magic, 48, uid, device, 2)
                    if head_data is None or head_error is not None:
                        raise Fatal(_E_HEAD)
                    head_digest = None
                    try:
                        head_number, head_digest = _parse_head(head_data, magic)
                        record_target = _record_name(head_number, head_digest, record_suffix)
                        record_data, record_error = _read_file(
                            fds,
                            parent,
                            record_target,
                            uid,
                            device,
                            _WAL_SIZE if record_suffix == b".wal" else 16384,
                            _WAL_SIZE if record_suffix == b".wal" else None,
                        )
                        if record_data is None or record_error is not None:
                            raise Fatal(_E_HEAD)
                        actual = None
                        try:
                            actual = _digest(record_data)
                            if len(record_data) < 1 or not _same(actual, head_digest):
                                raise Fatal(_E_DIGEST)
                        finally:
                            if actual is not None:
                                _zero(actual)
                            _zero(record_data)
                    finally:
                        _zero(head_data)
                        if head_digest is not None:
                            _zero(head_digest)
                else:
                    raise Fatal(_E_STATE)
                _unlink(parent, name)
                changed = True
            else:
                raise Fatal(_E_NLINK)
        index += 1
    if changed:
        _fsync(parent)


def _repair_create_identity_link(fds, parent, entries, genesis, identity_digest, uid, device):
    linked_temp = _linked_temp_for_target(parent, entries, _IDENTITY, uid, device)
    if linked_temp is None:
        return False
    if len(entries) != 2 or _IDENTITY not in entries or linked_temp not in entries:
        raise Fatal(_E_STATE)
    mark = fds.mark()
    request_digest = None
    try:
        temp_fd, temp_error = _open_file(fds, parent, linked_temp, uid, device, len(genesis), len(genesis), 2)
        identity_fd, identity_error = _open_file(fds, parent, _IDENTITY, uid, device, len(genesis), len(genesis), 2)
        if temp_fd is None or identity_fd is None or temp_error is not None or identity_error is not None:
            raise Fatal(_E_UNCERTAIN)
        temp_st = _fstat(temp_fd)
        identity_st = _fstat(identity_fd)
        _validate_file_stat(temp_st, uid, device, 2)
        _validate_file_stat(identity_st, uid, device, 2)
        if temp_st.st_dev != identity_st.st_dev or temp_st.st_ino != identity_st.st_ino:
            raise Fatal(_E_NLINK)
        temp_name_st, temp_name_error = _lstat(parent, linked_temp)
        identity_name_st, identity_name_error = _lstat(parent, _IDENTITY)
        if temp_name_st is None or identity_name_st is None or temp_name_error is not None or identity_name_error is not None:
            raise Fatal(_E_UNCERTAIN)
        _validate_file_stat(temp_name_st, uid, device, 2)
        _validate_file_stat(identity_name_st, uid, device, 2)
        if (
            temp_name_st.st_dev != temp_st.st_dev
            or temp_name_st.st_ino != temp_st.st_ino
            or identity_name_st.st_dev != identity_st.st_dev
            or identity_name_st.st_ino != identity_st.st_ino
        ):
            raise Fatal(_E_UNCERTAIN)
        _read_bound_fd(temp_fd, genesis)
        _read_bound_fd(identity_fd, genesis)
        request_digest = _digest(genesis)
        if not _same(request_digest, identity_digest):
            raise Fatal(_E_DIGEST)
        _unlink(parent, linked_temp)
        _fsync(parent)
        _prove_published(fds, parent, _IDENTITY, temp_fd, temp_st.st_dev, temp_st.st_ino, genesis, uid, device)
        retained_identity = _fstat(identity_fd)
        _validate_file_stat(retained_identity, uid, device)
        if retained_identity.st_dev != temp_st.st_dev or retained_identity.st_ino != temp_st.st_ino:
            raise Fatal(_E_UNCERTAIN)
        _read_bound_fd(identity_fd, genesis)
        final_identity, final_identity_error = _lstat(parent, _IDENTITY)
        final_temp, final_temp_error = _lstat(parent, linked_temp)
        if final_identity is None or final_identity_error is not None:
            raise Fatal(_E_UNCERTAIN)
        _validate_file_stat(final_identity, uid, device)
        if final_identity.st_dev != retained_identity.st_dev or final_identity.st_ino != retained_identity.st_ino:
            raise Fatal(_E_UNCERTAIN)
        if final_temp is not None or final_temp_error != errno.ENOENT:
            raise Fatal(_E_UNCERTAIN)
        return True
    finally:
        if request_digest is not None:
            _zero(request_digest)
        fds.close_after(mark)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _validate_create_publication_links(parent, entries, record_target, later_present, uid, device):
    record_temp = _linked_temp_for_target(parent, entries, record_target, uid, device)
    head_temp = _linked_temp_for_target(parent, entries, _HEAD, uid, device)
    if record_temp is not None:
        if later_present or len(entries) != 2 or record_target not in entries or record_temp not in entries:
            raise Fatal(_E_STATE)
    if head_temp is not None:
        if later_present or len(entries) != 3 or record_target not in entries or _HEAD not in entries or head_temp not in entries:
            raise Fatal(_E_STATE)


def _wal_fields(record):
    if len(record) != _WAL_SIZE or record[:11] != _WAL_MAGIC:
        raise Fatal(_E_STATE)
    if not _range_zero(record, 11, 16) or not _range_zero(record, 19, 24):
        raise Fatal(_E_STATE)
    state_value = record[16]
    status_value = record[17]
    code_value = record[18]
    if state_value < 1 or state_value > 8 or status_value > 3 or code_value > 10:
        raise Fatal(_E_STATE)
    if state_value == _W_DELETE_DISPATCHED:
        if status_value == 0 or code_value == 0:
            raise Fatal(_E_STATE)
    elif status_value != 0 or code_value != 0:
        raise Fatal(_E_STATE)
    revision = struct.unpack_from(">Q", record, 24)[0]
    if revision < 1:
        raise Fatal(_E_STATE)
    return state_value, revision


def _wal_transition(left, right):
    if left == _W_ALLOCATED:
        return right == _W_CREATE_DISPATCHED
    if left == _W_CREATE_DISPATCHED:
        return right == _W_PRESENT or right == _W_RETIRED_ABSENT
    if left == _W_PRESENT:
        return right == _W_RUNTIME_DISPATCHED
    if left == _W_RUNTIME_DISPATCHED:
        return right == _W_RUNNING
    if left == _W_RUNNING:
        return right == _W_DELETE_DISPATCHED
    if left == _W_DELETE_DISPATCHED:
        return right == _W_ABSENT
    return False


def _build_ledger_head(ordinal, digest):
    result = bytearray(48)
    result[:8] = _LEDGER_MAGIC
    struct.pack_into(">Q", result, 8, ordinal)
    result[16:48] = digest
    return result


def _build_wal_head(revision, digest):
    result = bytearray(48)
    result[:8] = _WAL_HEAD_MAGIC
    struct.pack_into(">Q", result, 8, revision)
    result[16:48] = digest
    return result


def _build_session_head(generation, revision, wal_digest, identity_digest):
    result = bytearray(112)
    result[:8] = _SESSION_MAGIC
    result[8:40] = generation
    struct.pack_into(">Q", result, 40, revision)
    result[48:80] = wal_digest
    result[80:112] = identity_digest
    return result


def _parse_head(data, magic):
    if len(data) != 48 or not _same_at(data, 0, magic):
        raise Fatal(_E_HEAD)
    result = bytearray(32)
    result[:] = memoryview(data)[16:48]
    return struct.unpack_from(">Q", data, 8)[0], result


def _parse_session_head(data):
    if len(data) != 112 or not _same_at(data, 0, _SESSION_MAGIC):
        raise Fatal(_E_HEAD)
    generation = bytearray(32)
    wal_digest = bytearray(32)
    identity_digest = bytearray(32)
    generation[:] = memoryview(data)[8:40]
    wal_digest[:] = memoryview(data)[48:80]
    identity_digest[:] = memoryview(data)[80:112]
    return generation, struct.unpack_from(">Q", data, 40)[0], wal_digest, identity_digest


def _read_head(fds, parent, name, magic, size, uid, device, links=1):
    data, error = _read_file(fds, parent, name, uid, device, size, size, links)
    if data is None:
        return None, error
    if not _same_at(data, 0, magic):
        _zero(data)
        raise Fatal(_E_HEAD)
    return data, None


def _verify_wal_record(record, lifecycle, generation, revision=None, previous=None, identity=None):
    state_value, found_revision = _wal_fields(record)
    if not _same_at(record, 32, lifecycle) or not _same_at(record, 64, generation):
        raise Fatal(_E_STATE)
    if revision is not None and found_revision != revision:
        raise Fatal(_E_STATE)
    if previous is not None and not _same_at(record, 96, previous):
        raise Fatal(_E_DIGEST)
    if identity is not None and not _same_at(record, 128, identity):
        raise Fatal(_E_DIGEST)
    return state_value, found_revision


def _constant_digests_equal(left, right):
    field_index = 0
    while field_index < len(_CONSTANT_DIGEST_OFFSETS):
        offset = _CONSTANT_DIGEST_OFFSETS[field_index]
        byte_index = 0
        difference = 0
        while byte_index < 32:
            difference |= left[offset + byte_index] ^ right[offset + byte_index]
            byte_index += 1
        if difference != 0:
            return False
        field_index += 1
    return True


def _scan_records(fds, parent, entries, suffix, first_number, maximum_count, maximum_bytes, exact_size, uid, device, minimum_size=1):
    records = []
    total = 0
    data = None
    expected_digest = None
    actual_digest = None
    complete = False
    try:
        index = 0
        while index < len(entries):
            name = entries[index]
            if name == _HEAD or name.startswith(b".tmp."):
                index += 1
                continue
            parsed = _parse_record_name(name, suffix)
            if parsed is None:
                raise Fatal(_E_STATE)
            number, expected_digest = parsed
            data, error = _read_file(fds, parent, name, uid, device, exact_size if exact_size is not None else 16384, exact_size)
            if data is None or error is not None:
                raise Fatal(_E_UNCERTAIN)
            if len(data) < minimum_size:
                raise Fatal(_E_BOUNDS)
            actual_digest = _digest(data)
            if not _same(actual_digest, expected_digest):
                raise Fatal(_E_DIGEST)
            total += len(data)
            records.append((number, name, data, actual_digest))
            data = None
            actual_digest = None
            _zero(expected_digest)
            expected_digest = None
            index += 1
        records.sort(key=lambda item: item[0])
        if len(records) < 1 or len(records) > maximum_count or total > maximum_bytes:
            raise Fatal(_E_BOUNDS)
        index = 0
        while index < len(records):
            if records[index][0] != first_number + index:
                raise Fatal(_E_STATE)
            index += 1
        complete = True
        return records, total
    finally:
        if data is not None:
            _zero(data)
        if expected_digest is not None:
            _zero(expected_digest)
        if actual_digest is not None:
            _zero(actual_digest)
        if not complete:
            _zero_record_rows(records)


def _zero_record_rows(rows):
    index = 0
    while index < len(rows):
        _zero(rows[index][2])
        _zero(rows[index][3])
        index += 1


def _scan_ledger(fds, lifecycle_fd, uid, device, repair, expected_identity=None, expected_identity_digest=None):
    ledger_fd, error = _open_dir(fds, lifecycle_fd, _LEDGER, uid, device)
    if ledger_fd is None:
        raise Fatal(_E_STATE)
    rows = []
    head_data = None
    head_digest = None
    complete = False
    try:
        entries = _list(ledger_fd)
        head_temp = _linked_temp_for_target(ledger_fd, entries, _HEAD, uid, device) if _HEAD in entries else None
        _clean_temps(fds, ledger_fd, entries, uid, device, b".rec", (), head_temp)
        entries = _list(ledger_fd)
        rows, total = _scan_records(fds, ledger_fd, entries, b".rec", 0, _MAX_LEDGER_RECORDS, _MAX_LEDGER_BYTES, None, uid, device)
        if expected_identity is not None and (not _same(rows[0][2], expected_identity) or not _same(rows[0][3], expected_identity_digest)):
            raise Fatal(_E_DIGEST)
        head_data, head_error = _read_head(
            fds, ledger_fd, _HEAD, _LEDGER_MAGIC, 48, uid, device, 2 if head_temp is not None else 1
        )
        if head_data is None:
            raise Fatal(_E_HEAD)
        head_number, head_digest = _parse_head(head_data, _LEDGER_MAGIC)
        _zero(head_data)
        head_data = None
        if head_temp is not None:
            _unlink(ledger_fd, head_temp)
            _fsync(ledger_fd)
        last = rows[-1]
        if head_number == last[0] and _same(head_digest, last[3]):
            _zero(head_digest)
            head_digest = None
            complete = True
            return ledger_fd, rows, total
        if repair and len(rows) >= 2 and head_number == rows[-2][0] and _same(head_digest, rows[-2][3]):
            new_head = _build_ledger_head(last[0], last[3])
            try:
                _publish_head(fds, ledger_fd, _HEAD, new_head, uid, device)
            finally:
                _zero(new_head)
            _zero(head_digest)
            head_digest = None
            complete = True
            return ledger_fd, rows, total
        raise Fatal(_E_HEAD)
    finally:
        if head_data is not None:
            _zero(head_data)
        if head_digest is not None:
            _zero(head_digest)
        if not complete:
            _zero_record_rows(rows)


def _scan_wal(
    fds, generation_fd, lifecycle, generation, uid, device, repair, allow_suffix=False, allow_missing_head_repair=True
):
    wal_fd, error = _open_dir(fds, generation_fd, _WAL, uid, device)
    if wal_fd is None:
        raise Fatal(_E_STATE)
    rows = []
    prior_digest = None
    head_data = None
    head_digest = None
    complete = False
    try:
        entries = _list(wal_fd)
        head_temp = _linked_temp_for_target(wal_fd, entries, _HEAD, uid, device) if _HEAD in entries else None
        _clean_temps(fds, wal_fd, entries, uid, device, b".wal", (), head_temp)
        entries = _list(wal_fd)
        head_present = _HEAD in entries
        record_names = []
        index = 0
        while index < len(entries):
            name = entries[index]
            if name != _HEAD and not name.startswith(b".tmp."):
                record_names.append(name)
            index += 1
        if len(record_names) == 0:
            complete = True
            return wal_fd, [], None, "empty"
        rows, unused_total = _scan_records(fds, wal_fd, entries, b".wal", 1, _MAX_WAL_RECORDS, _WAL_SIZE * _MAX_WAL_RECORDS, _WAL_SIZE, uid, device)
        prior_digest = bytearray(32)
        prior_record = None
        index = 0
        while index < len(rows):
            row = rows[index]
            state_value, revision = _verify_wal_record(row[2], lifecycle, generation, row[0], prior_digest)
            if index == 0:
                if state_value != _W_ALLOCATED:
                    raise Fatal(_E_STATE)
            else:
                prior_state, prior_revision = _wal_fields(prior_record)
                if revision != prior_revision + 1 or not _wal_transition(prior_state, state_value) or not _constant_digests_equal(prior_record, row[2]):
                    raise Fatal(_E_STATE)
            _zero(prior_digest)
            prior_digest = bytearray(row[3])
            prior_record = row[2]
            index += 1
        _zero(prior_digest)
        prior_digest = None
        if not head_present:
            if repair and allow_missing_head_repair and len(rows) == 1 and _wal_fields(rows[0][2])[0] == _W_ALLOCATED:
                head_new = _build_wal_head(rows[0][0], rows[0][3])
                try:
                    _publish_head(fds, wal_fd, _HEAD, head_new, uid, device)
                finally:
                    _zero(head_new)
                complete = True
                return wal_fd, rows, rows[-1], "complete"
            if allow_suffix and len(rows) == 1 and rows[0][0] == 3 and _wal_fields(rows[0][2]) == (_W_RETIRED_ABSENT, 3):
                complete = True
                return wal_fd, rows, rows[-1], "suffix-record"
            raise Fatal(_E_HEAD)
        head_data, head_error = _read_head(
            fds, wal_fd, _HEAD, _WAL_HEAD_MAGIC, 48, uid, device, 2 if head_temp is not None else 1
        )
        if head_data is None:
            raise Fatal(_E_HEAD)
        head_revision, head_digest = _parse_head(head_data, _WAL_HEAD_MAGIC)
        _zero(head_data)
        head_data = None
        if head_temp is not None:
            _unlink(wal_fd, head_temp)
            _fsync(wal_fd)
        last = rows[-1]
        if head_revision == last[0] and _same(head_digest, last[3]):
            _zero(head_digest)
            head_digest = None
            complete = True
            return wal_fd, rows, last, "complete"
        if repair and len(rows) >= 2 and head_revision == rows[-2][0] and _same(head_digest, rows[-2][3]):
            head_new = _build_wal_head(last[0], last[3])
            try:
                _publish_head(fds, wal_fd, _HEAD, head_new, uid, device)
            finally:
                _zero(head_new)
            _zero(head_digest)
            head_digest = None
            complete = True
            return wal_fd, rows, last, "complete"
        raise Fatal(_E_HEAD)
    finally:
        if prior_digest is not None:
            _zero(prior_digest)
        if head_data is not None:
            _zero(head_data)
        if head_digest is not None:
            _zero(head_digest)
        if not complete:
            _zero_record_rows(rows)


def _rollback_empty_generation(fds, generations_fd, generation_name, generation_fd, uid, device):
    entries = _list(generation_fd)
    if len(entries) == 0:
        fds.close_for_recovery(generation_fd)
        _rmdir(generations_fd, generation_name)
        _fsync(generations_fd)
        return True
    if len(entries) == 1 and entries[0] == _WAL:
        wal_fd, error = _open_dir(fds, generation_fd, _WAL, uid, device)
        if wal_fd is None:
            raise Fatal(_E_STATE)
        wal_entries = _list(wal_fd)
        if len(wal_entries) != 0:
            fds.close_for_recovery(wal_fd)
            return False
        fds.close_for_recovery(wal_fd)
        _rmdir(generation_fd, _WAL)
        _fsync(generation_fd)
        fds.close_for_recovery(generation_fd)
        _rmdir(generations_fd, generation_name)
        _fsync(generations_fd)
        return True
    return False


def _scan_generation(
    fds,
    generations_fd,
    generation_name,
    lifecycle,
    uid,
    device,
    repair,
    allow_suffix=False,
    allow_missing_head_repair=True,
    allow_v5_evidence=False,
):
    generation_fd, error = _open_dir(fds, generations_fd, generation_name, uid, device)
    if generation_fd is None:
        raise Fatal(_E_STATE)
    entries = _list(generation_fd)
    index = 0
    while index < len(entries):
        if entries[index] != _WAL and (not allow_v5_evidence or entries[index] != _WORKSPACE_EVIDENCE):
            raise Fatal(_E_STATE)
        index += 1
    if repair and _rollback_empty_generation(fds, generations_fd, generation_name, generation_fd, uid, device):
        return None
    generation_raw = bytearray.fromhex(generation_name.decode("ascii"))
    try:
        wal_fd, rows, last, stage = _scan_wal(
            fds, generation_fd, lifecycle, generation_raw, uid, device, repair, allow_suffix, allow_missing_head_repair
        )
        return generation_fd, wal_fd, rows, last, stage
    finally:
        _zero(generation_raw)


def _remove_generation_suffix(
    fds, generations_fd, generation_name, lifecycle, uid, device, positive_observation, identity_digest, reference_record
):
    generation_fd, error = _open_dir(fds, generations_fd, generation_name, uid, device)
    if generation_fd is None:
        if error == errno.ENOENT and not positive_observation:
            return
        raise Fatal(_E_UNCERTAIN)
    wal_fd = None
    rows = []
    generation_raw = bytearray.fromhex(generation_name.decode("ascii"))
    try:
        entries = _list(generation_fd)
        if len(entries) == 0:
            fds.close_for_recovery(generation_fd)
            generation_fd = None
            _rmdir(generations_fd, generation_name)
            _fsync(generations_fd)
            return
        if entries != [_WAL]:
            raise Fatal(_E_STATE)
        wal_fd, wal_error = _open_dir(fds, generation_fd, _WAL, uid, device)
        if wal_fd is None or wal_error is not None:
            raise Fatal(_E_STATE)
        wal_entries = _list(wal_fd)
        head_temp = _linked_temp_for_target(wal_fd, wal_entries, _HEAD, uid, device) if _HEAD in wal_entries else None
        temp_index = 0
        while temp_index < len(wal_entries):
            if wal_entries[temp_index].startswith(b".tmp.") and wal_entries[temp_index] != head_temp:
                raise Fatal(_E_STATE)
            temp_index += 1
        if len(wal_entries) == 0:
            fds.close_for_recovery(wal_fd)
            wal_fd = None
            _rmdir(generation_fd, _WAL)
            _fsync(generation_fd)
            fds.close_for_recovery(generation_fd)
            generation_fd = None
            _rmdir(generations_fd, generation_name)
            _fsync(generations_fd)
            return
        rows, unused_total = _scan_suffix_records(
            fds,
            wal_fd,
            wal_entries,
            b".wal",
            _MAX_WAL_RECORDS,
            _WAL_SIZE * _MAX_WAL_RECORDS,
            _WAL_SIZE,
            uid,
            device,
        )
        if len(rows) == 0:
            raise Fatal(_E_STATE)
        terminal_state = _validate_wal_suffix(rows, lifecycle, generation_raw, identity_digest)
        if not _constant_digests_equal(rows[-1][2], reference_record):
            raise Fatal(_E_DIGEST)
        unused_terminal_state, terminal_revision = _wal_fields(rows[-1][2])
        if terminal_state != _W_RETIRED_ABSENT or terminal_revision != 3 or rows[-1][0] != 3:
            raise Fatal(_E_STATE)
        if _HEAD in wal_entries:
            head_data, head_error = _read_head(
                fds, wal_fd, _HEAD, _WAL_HEAD_MAGIC, 48, uid, device, 2 if head_temp is not None else 1
            )
            if head_data is None or head_error is not None:
                raise Fatal(_E_HEAD)
            head_digest = None
            try:
                head_revision, head_digest = _parse_head(head_data, _WAL_HEAD_MAGIC)
                if head_revision != rows[-1][0] or not _same(head_digest, rows[-1][3]):
                    raise Fatal(_E_HEAD)
            finally:
                _zero(head_data)
                if head_digest is not None:
                    _zero(head_digest)
            if head_temp is not None:
                _unlink(wal_fd, head_temp)
                _fsync(wal_fd)
            index = 0
            while index + 1 < len(rows):
                _unlink(wal_fd, rows[index][1])
                index += 1
            _fsync(wal_fd)
            _unlink(wal_fd, _HEAD)
            _fsync(wal_fd)
        elif len(rows) != 1:
            raise Fatal(_E_STATE)
        if rows[-1][1] not in _list(wal_fd):
            raise Fatal(_E_UNCERTAIN)
        _unlink(wal_fd, rows[-1][1])
        _fsync(wal_fd)
        if len(_list(wal_fd)) != 0:
            raise Fatal(_E_STATE)
        fds.close_for_recovery(wal_fd)
        wal_fd = None
        _rmdir(generation_fd, _WAL)
        _fsync(generation_fd)
        fds.close_for_recovery(generation_fd)
        generation_fd = None
        _rmdir(generations_fd, generation_name)
        _fsync(generations_fd)
    finally:
        if wal_fd is not None:
            fds.close(wal_fd)
        if generation_fd is not None:
            fds.close(generation_fd)
        _zero_record_rows(rows)
        _zero(generation_raw)


def _scan_suffix_records(fds, parent, entries, suffix, maximum_count, maximum_bytes, exact_size, uid, device):
    record_entries = []
    index = 0
    while index < len(entries):
        if entries[index] != _HEAD and not entries[index].startswith(b".tmp."):
            record_entries.append(entries[index])
        index += 1
    if len(record_entries) == 0:
        return [], 0
    first_parsed = _parse_record_name(record_entries[0], suffix)
    if first_parsed is None:
        raise Fatal(_E_STATE)
    first_number, first_digest = first_parsed
    _zero(first_digest)
    return _scan_records(
        fds,
        parent,
        entries,
        suffix,
        first_number,
        maximum_count,
        maximum_bytes,
        exact_size,
        uid,
        device,
    )


def _validate_wal_suffix(rows, lifecycle, generation, identity_digest):
    if len(rows) == 0:
        raise Fatal(_E_STATE)
    prior = None
    index = 0
    while index < len(rows):
        row = rows[index]
        state_value, revision = _verify_wal_record(
            row[2],
            lifecycle,
            generation,
            row[0],
            None if prior is None else prior[3],
            identity_digest,
        )
        if prior is not None:
            prior_state, prior_revision = _wal_fields(prior[2])
            if revision != prior_revision + 1 or not _wal_transition(prior_state, state_value) or not _constant_digests_equal(prior[2], row[2]):
                raise Fatal(_E_STATE)
        prior = row
        index += 1
    terminal_state, unused_revision = _wal_fields(rows[-1][2])
    return terminal_state


def _root_check(root_fd, device, inode, uid, lock_fd, lock_device, lock_inode):
    st = _fstat(root_fd)
    _validate_dir_stat(st, uid, device, True)
    if st.st_ino != inode:
        raise Fatal(_E_UNCERTAIN)
    lock_entry, lock_error = _lstat(root_fd, _LOCK)
    if lock_entry is None or lock_error is not None:
        raise Fatal(_E_UNCERTAIN)
    _validate_file_stat(lock_entry, uid, device)
    lock_stat = _fstat(lock_fd)
    _validate_file_stat(lock_stat, uid, device)
    if lock_entry.st_dev != lock_device or lock_entry.st_ino != lock_inode:
        raise Fatal(_E_UNCERTAIN)
    if lock_stat.st_dev != lock_device or lock_stat.st_ino != lock_inode:
        raise Fatal(_E_UNCERTAIN)


def _bind_root(fds):
    uid = os.getuid()
    try:
        account = pwd.getpwuid(uid)
    except KeyError:
        raise Fatal(_E_OWNER)
    name = account.pw_name
    home = account.pw_dir
    if len(name) == 0:
        raise Fatal(_E_OWNER)
    try:
        name_bytes = name.encode("ascii")
    except UnicodeEncodeError:
        raise Fatal(_E_OWNER)
    index = 0
    allowed = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
    while index < len(name_bytes):
        if name_bytes[index] not in allowed:
            raise Fatal(_E_OWNER)
        index += 1
    if sys.platform == "darwin":
        if home != "/Users/" + name:
            raise Fatal(_E_OWNER)
        segments = (b"Users", name_bytes, b".prime", b"agent", _ROOT_NAME)
    elif sys.platform.startswith("linux"):
        if uid == 0:
            if name != "root" or home != "/root":
                raise Fatal(_E_OWNER)
            segments = (b"root", b".prime", b"agent", _ROOT_NAME)
        else:
            if home != "/home/" + name:
                raise Fatal(_E_OWNER)
            segments = (b"home", name_bytes, b".prime", b"agent", _ROOT_NAME)
    else:
        raise Fatal(_E_OWNER)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        slash = fds.add(os.open(b"/", flags))
    except OSError:
        raise Fatal(_E_UNCERTAIN)
    root_st = _fstat(slash)
    if not stat.S_ISDIR(root_st.st_mode) or root_st.st_uid != 0 or root_st.st_nlink < 2 or stat.S_IMODE(root_st.st_mode) & 0o022:
        raise Fatal(_E_MODE)
    system_count = 1
    current = slash
    index = 0
    while index < len(segments):
        final = index == len(segments) - 1
        if final:
            next_fd, created = _make_dir(fds, current, segments[index], uid, None)
        else:
            next_fd, error = _open_dir(fds, current, segments[index], 0 if index < system_count else uid, None, False)
            if next_fd is None:
                raise Fatal(_E_ABSENT)
        if current != slash:
            fds.close(current)
            if fds.uncertain:
                raise Fatal(_E_UNCERTAIN)
        current = next_fd
        index += 1
    fds.close(slash)
    if fds.uncertain:
        raise Fatal(_E_UNCERTAIN)
    root_fd = current
    root_final = _fstat(root_fd)
    _validate_dir_stat(root_final, uid, None, True)
    return root_fd, root_final.st_dev, root_final.st_ino, uid


def _bind_lock(fds, root_fd, uid, device):
    try:
        fcntl.flock(root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
            return None, None, None, _E_BUSY
        raise Fatal(_E_UNCERTAIN)
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC
    before, before_error = _lstat(root_fd, _LOCK)
    created = False
    if before is None:
        if before_error != errno.ENOENT:
            raise Fatal(_E_UNCERTAIN)
        fd, open_error = _open_raw(fds, root_fd, _LOCK, flags | os.O_CREAT | os.O_EXCL, 0o600)
        if fd is None:
            if open_error == errno.EEXIST:
                raise Fatal(_E_BUSY)
            raise Fatal(_E_UNCERTAIN)
        created = True
    else:
        _validate_file_stat(before, uid, device)
        fd, open_error = _open_raw(fds, root_fd, _LOCK, flags)
        if fd is None:
            raise Fatal(_E_UNCERTAIN)
    opened = _fstat(fd)
    _validate_file_stat(opened, uid, device)
    entry, entry_error = _lstat(root_fd, _LOCK)
    if entry is None or entry_error is not None:
        raise Fatal(_E_UNCERTAIN)
    _validate_file_stat(entry, uid, device)
    if entry.st_dev != opened.st_dev or entry.st_ino != opened.st_ino:
        raise Fatal(_E_UNCERTAIN)
    if not created and (before.st_dev != opened.st_dev or before.st_ino != opened.st_ino):
        raise Fatal(_E_UNCERTAIN)
    if created:
        _fdatasync(fd)
        _fsync(root_fd)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK) and not created:
            fds.close(fd)
            if fds.uncertain:
                raise Fatal(_E_UNCERTAIN)
            return None, None, None, _E_BUSY
        raise Fatal(_E_BUSY if error.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK) else _E_UNCERTAIN)
    final_entry, final_error = _lstat(root_fd, _LOCK)
    if final_entry is None or final_error is not None:
        raise Fatal(_E_UNCERTAIN)
    _validate_file_stat(final_entry, uid, device)
    if final_entry.st_dev != opened.st_dev or final_entry.st_ino != opened.st_ino:
        raise Fatal(_E_UNCERTAIN)
    return fd, opened.st_dev, opened.st_ino, None


def _validate_lifecycle_entries(entries, head_required, deferred_temp=None):
    allowed = (_IDENTITY, _LEDGER, _GENERATIONS, _HEAD)
    index = 0
    while index < len(entries):
        if entries[index] not in allowed and entries[index] != deferred_temp:
            raise Fatal(_E_STATE)
        index += 1
    if head_required and _HEAD not in entries:
        raise Fatal(_E_HEAD)


def _remove_tree_file_checked(fds, parent, name, uid, device, maximum):
    data, error = _read_file(fds, parent, name, uid, device, maximum)
    if data is None or error is not None:
        raise Fatal(_E_STATE)
    _zero(data)
    _unlink(parent, name)


def _rollback_unpublished(fds, root_fd, lifecycle_name, lifecycle_fd, uid, device):
    lifecycle = bytearray.fromhex(lifecycle_name.decode("ascii"))
    identity = None
    identity_digest = None
    identity_temp = None
    ledger_fd = None
    generations_fd = None
    generation_fd = None
    wal_fd = None
    try:
        entries = _list(lifecycle_fd)
        index = 0
        while index < len(entries):
            candidate = entries[index]
            if candidate not in (_IDENTITY, _LEDGER, _GENERATIONS) and not candidate.startswith(b".tmp."):
                raise Fatal(_E_STATE)
            if candidate.startswith(b".tmp.") and not _valid_temp(candidate):
                raise Fatal(_E_STATE)
            index += 1
        if _HEAD in entries:
            raise Fatal(_E_STATE)
        if _IDENTITY not in entries:
            if _LEDGER in entries or _GENERATIONS in entries:
                raise Fatal(_E_STATE)
            _clean_temps(fds, lifecycle_fd, entries, uid, device, b"")
            if len(_list(lifecycle_fd)) != 0:
                raise Fatal(_E_STATE)
        else:
            identity_temp = _linked_temp_for_target(lifecycle_fd, entries, _IDENTITY, uid, device)
            _clean_temps(fds, lifecycle_fd, entries, uid, device, b"", (), identity_temp)
            entries = _list(lifecycle_fd)
            identity_links = 2 if identity_temp is not None else 1
            identity, identity_error = _read_file(fds, lifecycle_fd, _IDENTITY, uid, device, 16384, links=identity_links)
            if identity is None or identity_error is not None or len(identity) < 1:
                raise Fatal(_E_STATE)
            identity_digest = _digest(identity)
            allowed_lifecycle = (_IDENTITY, _LEDGER, _GENERATIONS, identity_temp)
            index = 0
            while index < len(entries):
                if entries[index] not in allowed_lifecycle:
                    raise Fatal(_E_STATE)
                index += 1
            ledger_complete = False
            if _LEDGER in entries:
                ledger_fd, ledger_error = _open_dir(fds, lifecycle_fd, _LEDGER, uid, device)
                if ledger_fd is None or ledger_error is not None:
                    raise Fatal(_E_STATE)
                ledger_entries = _list(ledger_fd)
                _clean_temps(fds, ledger_fd, ledger_entries, uid, device, b".rec", (_HEAD,))
                ledger_entries = _list(ledger_fd)
                if len(ledger_entries) != 0:
                    genesis_name = _record_name(0, identity_digest, b".rec")
                    allowed_ledger = (genesis_name, _HEAD)
                    index = 0
                    while index < len(ledger_entries):
                        if ledger_entries[index] not in allowed_ledger:
                            raise Fatal(_E_STATE)
                        index += 1
                    if genesis_name not in ledger_entries:
                        raise Fatal(_E_STATE)
                    genesis, genesis_error = _read_file(fds, ledger_fd, genesis_name, uid, device, 16384)
                    if genesis is None or genesis_error is not None:
                        raise Fatal(_E_STATE)
                    try:
                        genesis_digest = _digest(genesis)
                        try:
                            if not _same(genesis, identity) or not _same(genesis_digest, identity_digest):
                                raise Fatal(_E_DIGEST)
                        finally:
                            _zero(genesis_digest)
                    finally:
                        _zero(genesis)
                    if _HEAD in ledger_entries:
                        ledger_head, ledger_head_error = _read_head(fds, ledger_fd, _HEAD, _LEDGER_MAGIC, 48, uid, device)
                        if ledger_head is None or ledger_head_error is not None:
                            raise Fatal(_E_HEAD)
                        ledger_head_digest = None
                        try:
                            ledger_ordinal, ledger_head_digest = _parse_head(ledger_head, _LEDGER_MAGIC)
                            if ledger_ordinal != 0 or not _same(ledger_head_digest, identity_digest):
                                raise Fatal(_E_HEAD)
                            ledger_complete = True
                        finally:
                            _zero(ledger_head)
                            if ledger_head_digest is not None:
                                _zero(ledger_head_digest)
            if _GENERATIONS in entries:
                if not ledger_complete:
                    raise Fatal(_E_STATE)
                generations_fd, generations_error = _open_dir(fds, lifecycle_fd, _GENERATIONS, uid, device)
                if generations_fd is None or generations_error is not None:
                    raise Fatal(_E_STATE)
                generation_names = _list(generations_fd)
                if len(generation_names) > 1:
                    raise Fatal(_E_STATE)
                if len(generation_names) == 1:
                    generation_name = generation_names[0]
                    if not _valid_hex_name(generation_name, 64):
                        raise Fatal(_E_STATE)
                    generation_raw = bytearray.fromhex(generation_name.decode("ascii"))
                    try:
                        generation_fd, generation_error = _open_dir(fds, generations_fd, generation_name, uid, device)
                        if generation_fd is None or generation_error is not None:
                            raise Fatal(_E_STATE)
                        generation_entries = _list(generation_fd)
                        if len(generation_entries) > 1 or (len(generation_entries) == 1 and generation_entries[0] != _WAL):
                            raise Fatal(_E_STATE)
                        if len(generation_entries) == 1:
                            wal_fd, wal_error = _open_dir(fds, generation_fd, _WAL, uid, device)
                            if wal_fd is None or wal_error is not None:
                                raise Fatal(_E_STATE)
                            wal_entries = _list(wal_fd)
                            _clean_temps(fds, wal_fd, wal_entries, uid, device, b".wal", (_HEAD,))
                            wal_entries = _list(wal_fd)
                            if len(wal_entries) != 0:
                                record_names = [item for item in wal_entries if item != _HEAD]
                                if len(record_names) != 1:
                                    raise Fatal(_E_STATE)
                                parsed = _parse_record_name(record_names[0], b".wal")
                                if parsed is None:
                                    raise Fatal(_E_STATE)
                                revision, expected_digest = parsed
                                allocated, allocated_error = _read_file(fds, wal_fd, record_names[0], uid, device, _WAL_SIZE, _WAL_SIZE)
                                if allocated is None or allocated_error is not None:
                                    _zero(expected_digest)
                                    raise Fatal(_E_STATE)
                                actual_digest = _digest(allocated)
                                try:
                                    if revision != 1 or not _same(actual_digest, expected_digest):
                                        raise Fatal(_E_DIGEST)
                                    _validate_allocated(allocated, lifecycle, generation_raw, identity_digest)
                                    if _HEAD in wal_entries:
                                        wal_head, wal_head_error = _read_head(fds, wal_fd, _HEAD, _WAL_HEAD_MAGIC, 48, uid, device)
                                        if wal_head is None or wal_head_error is not None:
                                            raise Fatal(_E_HEAD)
                                        wal_head_digest = None
                                        try:
                                            head_revision, wal_head_digest = _parse_head(wal_head, _WAL_HEAD_MAGIC)
                                            if head_revision != 1 or not _same(wal_head_digest, actual_digest):
                                                raise Fatal(_E_HEAD)
                                        finally:
                                            _zero(wal_head)
                                            if wal_head_digest is not None:
                                                _zero(wal_head_digest)
                                finally:
                                    _zero(actual_digest)
                                    _zero(expected_digest)
                                    _zero(allocated)
                    finally:
                        _zero(generation_raw)
            if identity_temp is not None:
                _unlink(lifecycle_fd, identity_temp)
                _fsync(lifecycle_fd)
        if wal_fd is not None:
            wal_entries = _list(wal_fd)
            index = 0
            while index < len(wal_entries):
                _remove_tree_file_checked(fds, wal_fd, wal_entries[index], uid, device, _WAL_SIZE if wal_entries[index] != _HEAD else 48)
                index += 1
            _fsync(wal_fd)
            fds.close_for_recovery(wal_fd)
            wal_fd = None
            _rmdir(generation_fd, _WAL)
            _fsync(generation_fd)
        if generation_fd is not None:
            generation_name = _list(generations_fd)[0]
            fds.close_for_recovery(generation_fd)
            generation_fd = None
            _rmdir(generations_fd, generation_name)
            _fsync(generations_fd)
        if generations_fd is not None:
            fds.close_for_recovery(generations_fd)
            generations_fd = None
            _rmdir(lifecycle_fd, _GENERATIONS)
            _fsync(lifecycle_fd)
        if ledger_fd is not None:
            ledger_entries = _list(ledger_fd)
            index = 0
            while index < len(ledger_entries):
                _remove_tree_file_checked(fds, ledger_fd, ledger_entries[index], uid, device, 48 if ledger_entries[index] == _HEAD else 16384)
                index += 1
            _fsync(ledger_fd)
            fds.close_for_recovery(ledger_fd)
            ledger_fd = None
            _rmdir(lifecycle_fd, _LEDGER)
            _fsync(lifecycle_fd)
        if _IDENTITY in _list(lifecycle_fd):
            _remove_tree_file_checked(fds, lifecycle_fd, _IDENTITY, uid, device, 16384)
            _fsync(lifecycle_fd)
        if len(_list(lifecycle_fd)) != 0:
            raise Fatal(_E_STATE)
        fds.close_for_recovery(lifecycle_fd)
        _rmdir(root_fd, lifecycle_name)
        _fsync(root_fd)
    finally:
        if wal_fd is not None:
            fds.close(wal_fd)
        if generation_fd is not None:
            fds.close(generation_fd)
        if generations_fd is not None:
            fds.close(generations_fd)
        if ledger_fd is not None:
            fds.close(ledger_fd)
        if identity is not None:
            _zero(identity)
        if identity_digest is not None:
            _zero(identity_digest)
        _zero(lifecycle)


def _open_lifecycle(fds, root_fd, lifecycle, uid, device):
    name = _hex_name(lifecycle)
    fd, error = _open_dir(fds, root_fd, name, uid, device)
    return fd, error, name


def _scan_lifecycle(
    fds,
    lifecycle_fd,
    lifecycle,
    uid,
    device,
    repair,
    lifecycle_head_links=1,
    deferred_temp=None,
    allow_v5_evidence=False,
):
    identity = None
    identity_digest = None
    ledger_rows = []
    generations = []
    current_generation = None
    current_wal_digest = None
    session_data = None
    head_identity = None
    complete = False
    try:
        entries = _list(lifecycle_fd)
        fixed_targets = ()
        _clean_temps(fds, lifecycle_fd, entries, uid, device, b"", fixed_targets, deferred_temp)
        entries = _list(lifecycle_fd)
        _validate_lifecycle_entries(entries, True, deferred_temp)
        if _IDENTITY not in entries or _LEDGER not in entries or _GENERATIONS not in entries:
            raise Fatal(_E_STATE)
        identity, identity_error = _read_file(fds, lifecycle_fd, _IDENTITY, uid, device, 16384)
        if identity is None or identity_error is not None or len(identity) < 1:
            raise Fatal(_E_STATE)
        identity_digest = _digest(identity)
        ledger_fd, ledger_rows, ledger_total = _scan_ledger(fds, lifecycle_fd, uid, device, repair, identity, identity_digest)
        if not _same(identity, ledger_rows[0][2]) or not _same(identity_digest, ledger_rows[0][3]):
            _zero(identity)
            _zero(identity_digest)
            _zero_record_rows(ledger_rows)
            raise Fatal(_E_DIGEST)
        session_data, session_error = _read_head(fds, lifecycle_fd, _HEAD, _SESSION_MAGIC, 112, uid, device, lifecycle_head_links)
        if session_data is None or session_error is not None:
            _zero(identity)
            _zero(identity_digest)
            _zero_record_rows(ledger_rows)
            raise Fatal(_E_HEAD)
        current_generation, current_revision, current_wal_digest, head_identity = _parse_session_head(session_data)
        _zero(session_data)
        if not _same(identity_digest, head_identity):
            _zero(identity)
            _zero(identity_digest)
            _zero(head_identity)
            _zero_record_rows(ledger_rows)
            raise Fatal(_E_DIGEST)
        _zero(head_identity)
        generations_fd, generations_error = _open_dir(fds, lifecycle_fd, _GENERATIONS, uid, device)
        if generations_fd is None:
            raise Fatal(_E_STATE)
        generation_names = _list(generations_fd)
        index = 0
        while index < len(generation_names):
            if not _valid_hex_name(generation_names[index], 64):
                raise Fatal(_E_STATE)
            index += 1
        if len(generation_names) < 1 or len(generation_names) > _MAX_GENERATIONS:
            raise Fatal(_E_BOUNDS)
        generations = []
        index = 0
        while index < len(generation_names):
            generation_name = generation_names[index]
            scanned = _scan_generation(
                fds,
                generations_fd,
                generation_name,
                lifecycle,
                uid,
                device,
                repair,
                allow_v5_evidence=allow_v5_evidence,
            )
            if scanned is not None:
                generation_fd, wal_fd, rows, last, stage = scanned
                generations.append((generation_name, generation_fd, wal_fd, rows, last, stage))
            index += 1
        if len(generations) < 1 or len(generations) > _MAX_GENERATIONS:
            raise Fatal(_E_STATE)
        index = 0
        while index < len(generations):
            if generations[index][4] is None or not _same_at(generations[index][4][2], 128, identity_digest):
                raise Fatal(_E_DIGEST)
            index += 1
        current_name = _hex_name(current_generation)
        current_entry = None
        index = 0
        while index < len(generations):
            if generations[index][0] == current_name:
                current_entry = generations[index]
            index += 1
        if current_entry is None or current_entry[4] is None:
            raise Fatal(_E_HEAD)
        current_last = current_entry[4]
        last_state, last_revision = _wal_fields(current_last[2])
        if current_revision == last_revision and _same(current_wal_digest, current_last[3]):
            current_matches = True
        elif repair and current_revision + 1 == last_revision:
            previous_row = current_entry[3][-2] if len(current_entry[3]) >= 2 else None
            if previous_row is None or previous_row[0] != current_revision or not _same(current_wal_digest, previous_row[3]):
                raise Fatal(_E_HEAD)
            new_session = _build_session_head(current_generation, last_revision, current_last[3], identity_digest)
            try:
                _publish_head(fds, lifecycle_fd, _HEAD, new_session, uid, device)
            finally:
                _zero(new_session)
            _zero(current_wal_digest)
            current_wal_digest = bytearray(current_last[3])
            current_revision = last_revision
            current_matches = True
        else:
            current_matches = False
        if not current_matches:
            raise Fatal(_E_HEAD)
        if len(generations) == 2:
            other = generations[0] if generations[1] is current_entry else generations[1]
            other_state, unused_revision = _wal_fields(other[4][2])
            if other_state == _W_RETIRED_ABSENT and last_state == _W_ALLOCATED:
                if repair:
                    other_generation_fd = other[1]
                    other_wal_fd = other[2]
                    fds.close_for_recovery(other_wal_fd)
                    fds.close_for_recovery(other_generation_fd)
                    _zero_record_rows(other[3])
                    _remove_generation_suffix(
                        fds, generations_fd, other[0], lifecycle, uid, device, True, identity_digest, current_last[2]
                    )
                    generations.remove(other)
            elif other_state == _W_ALLOCATED and last_state == _W_RETIRED_ABSENT:
                if not _same_at(other[4][2], 128, identity_digest) or not _constant_digests_equal(current_last[2], other[4][2]):
                    raise Fatal(_E_DIGEST)
            else:
                raise Fatal(_E_STATE)
        complete = True
        return identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, current_revision, current_wal_digest
    finally:
        if not complete:
            if identity is not None:
                _zero(identity)
            if identity_digest is not None:
                _zero(identity_digest)
            _zero_record_rows(ledger_rows)
            index = 0
            while index < len(generations):
                _zero_record_rows(generations[index][3])
                index += 1
            if current_generation is not None:
                _zero(current_generation)
            if current_wal_digest is not None:
                _zero(current_wal_digest)
            if session_data is not None:
                _zero(session_data)
            if head_identity is not None:
                _zero(head_identity)


def _close_scan(fds, scan):
    identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, current_revision, current_wal_digest = scan
    _zero(identity)
    _zero(identity_digest)
    _zero_record_rows(ledger_rows)
    index = 0
    while index < len(generations):
        generation = generations[index]
        _zero_record_rows(generation[3])
        fds.close(generation[2])
        fds.close(generation[1])
        index += 1
    fds.close(generations_fd)
    fds.close(ledger_fd)
    _zero(current_generation)
    _zero(current_wal_digest)


def _session_payload(lifecycle, scan):
    identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, current_revision, current_wal_digest = scan
    result = bytearray()
    complete = False
    try:
        result.extend(lifecycle)
        result.extend(struct.pack(">I", len(identity)))
        result.extend(identity)
        result.append(len(ledger_rows))
        index = 0
        while index < len(ledger_rows):
            record = ledger_rows[index][2]
            result.extend(struct.pack(">I", len(record)))
            result.extend(record)
            index += 1
        result.extend(current_generation)
        result.append(len(generations))
        ordered = sorted(generations, key=lambda item: item[0])
        index = 0
        while index < len(ordered):
            generation = ordered[index]
            generation_raw = bytearray.fromhex(generation[0].decode("ascii"))
            try:
                result.extend(generation_raw)
            finally:
                _zero(generation_raw)
            result.append(len(generation[3]))
            second = 0
            while second < len(generation[3]):
                result.extend(generation[3][second][2])
                second += 1
            index += 1
        if len(result) > _MAX_PAYLOAD:
            raise Fatal(_E_BOUNDS)
        complete = True
        return result
    finally:
        if not complete:
            _zero(result)


def _peek_generation_state(fds, generations_fd, generation_name, lifecycle, uid, device, allow_v5_evidence=False):
    generation_fd, error = _open_dir(fds, generations_fd, generation_name, uid, device)
    if generation_fd is None:
        raise Fatal(_E_STATE)
    try:
        entries = _list(generation_fd)
        if len(entries) == 0:
            return None, "empty-generation", None
        if len(entries) != 1 or entries[0] != _WAL:
            if not allow_v5_evidence or len(entries) != 2 or _WAL not in entries or _WORKSPACE_EVIDENCE not in entries:
                raise Fatal(_E_STATE)
        wal_fd, wal_error = _open_dir(fds, generation_fd, _WAL, uid, device)
        if wal_fd is None:
            raise Fatal(_E_STATE)
        try:
            wal_entries = _list(wal_fd)
            head_temp = _linked_temp_for_target(wal_fd, wal_entries, _HEAD, uid, device) if _HEAD in wal_entries else None
            _clean_temps(fds, wal_fd, wal_entries, uid, device, b".wal", (), head_temp)
            wal_entries = _list(wal_fd)
            if len(wal_entries) == 0:
                return None, "empty-wal", None
            effective_entries = [item for item in wal_entries if item != head_temp]
            head_data, head_error = _read_head(
                fds, wal_fd, _HEAD, _WAL_HEAD_MAGIC, 48, uid, device, 2 if head_temp is not None else 1
            )
            if head_data is None:
                if head_error != errno.ENOENT or len(effective_entries) != 1:
                    raise Fatal(_E_HEAD)
                parsed = _parse_record_name(effective_entries[0], b".wal")
                if parsed is None:
                    raise Fatal(_E_STATE)
                revision, digest_value = parsed
            else:
                try:
                    revision, digest_value = _parse_head(head_data, _WAL_HEAD_MAGIC)
                finally:
                    _zero(head_data)
            target = _record_name(revision, digest_value, b".wal")
            record, record_error = _read_file(fds, wal_fd, target, uid, device, _WAL_SIZE, _WAL_SIZE)
            if record is None or record_error is not None:
                _zero(digest_value)
                raise Fatal(_E_STATE)
            actual = None
            try:
                actual = _digest(record)
                if not _same(actual, digest_value):
                    raise Fatal(_E_DIGEST)
                generation_raw = bytearray.fromhex(generation_name.decode("ascii"))
                try:
                    state_value, found_revision = _verify_wal_record(record, lifecycle, generation_raw, revision)
                finally:
                    _zero(generation_raw)
                if state_value == _W_ALLOCATED:
                    if found_revision != 1:
                        raise Fatal(_E_STATE)
                elif state_value == _W_RETIRED_ABSENT:
                    if found_revision != 3:
                        raise Fatal(_E_STATE)
                else:
                    raise Fatal(_E_STATE)
                return state_value, "record-no-head" if head_data is None else "complete", head_temp
            finally:
                _zero(record)
                if actual is not None:
                    _zero(actual)
                _zero(digest_value)
        finally:
            fds.close(wal_fd)
    finally:
        fds.close(generation_fd)


def _recover_generation_stages(fds, lifecycle_fd, lifecycle, uid, device, allow_v5_evidence=False):
    session_data, session_error = _read_head(fds, lifecycle_fd, _HEAD, _SESSION_MAGIC, 112, uid, device)
    if session_data is None or session_error is not None:
        raise Fatal(_E_HEAD)
    current_generation = None
    current_digest = None
    identity_digest = None
    identity = None
    ledger_rows = []
    generations_fd = None
    current_generation_fd = None
    current_wal_fd = None
    current_rows = []
    try:
        current_generation, current_revision, current_digest, identity_digest = _parse_session_head(session_data)
        _zero(session_data)
        session_data = None
        identity, identity_error = _read_file(fds, lifecycle_fd, _IDENTITY, uid, device, 16384)
        if identity is None or identity_error is not None or len(identity) < 1:
            raise Fatal(_E_STATE)
        actual_identity = _digest(identity)
        try:
            if not _same(actual_identity, identity_digest):
                raise Fatal(_E_DIGEST)
        finally:
            _zero(actual_identity)
        ledger_fd, ledger_rows, unused_total = _scan_ledger(fds, lifecycle_fd, uid, device, True, identity, identity_digest)
        try:
            if not _same(identity, ledger_rows[0][2]) or not _same(identity_digest, ledger_rows[0][3]):
                raise Fatal(_E_DIGEST)
        finally:
            fds.close(ledger_fd)
        fds.require_certain()
        generations_fd, generations_error = _open_dir(fds, lifecycle_fd, _GENERATIONS, uid, device)
        if generations_fd is None or generations_error is not None:
            raise Fatal(_E_STATE)
        names = _list(generations_fd)
        if len(names) < 1 or len(names) > 2:
            raise Fatal(_E_STATE)
        current_name = _hex_name(current_generation)
        if current_name not in names:
            raise Fatal(_E_HEAD)
        scanned_current = _scan_generation(
            fds, generations_fd, current_name, lifecycle, uid, device, True, False, False,
            allow_v5_evidence,
        )
        if scanned_current is None:
            raise Fatal(_E_STATE)
        current_generation_fd, current_wal_fd, current_rows, current_last, current_stage = scanned_current
        if current_last is None or not _same_at(current_last[2], 128, identity_digest):
            raise Fatal(_E_DIGEST)
        current_state, current_last_revision = _wal_fields(current_last[2])
        if current_state == _W_ALLOCATED and current_last_revision != 1:
            raise Fatal(_E_STATE)
        if current_state == _W_RETIRED_ABSENT and current_last_revision != 3:
            raise Fatal(_E_STATE)
        if current_revision == current_last_revision and _same(current_digest, current_last[3]):
            current_revision = current_last_revision
        elif current_revision + 1 == current_last_revision and len(current_rows) >= 2 and current_rows[-2][0] == current_revision and _same(current_rows[-2][3], current_digest):
            new_session = _build_session_head(current_generation, current_last_revision, current_last[3], identity_digest)
            try:
                _publish_head(fds, lifecycle_fd, _HEAD, new_session, uid, device)
            finally:
                _zero(new_session)
        else:
            raise Fatal(_E_HEAD)
        if len(names) == 1:
            return
        other_name = names[0] if names[1] == current_name else names[1]
        if other_name == current_name or not _valid_hex_name(other_name, 64):
            raise Fatal(_E_STATE)
        other_state, stage, linked_head_temp = _peek_generation_state(fds, generations_fd, other_name, lifecycle, uid, device, allow_v5_evidence)
        fds.require_certain()
        if other_state is None:
            if stage not in ("empty-generation", "empty-wal"):
                raise Fatal(_E_STATE)
            if current_state == _W_ALLOCATED:
                _remove_generation_suffix(
                    fds, generations_fd, other_name, lifecycle, uid, device, True, identity_digest, current_last[2]
                )
                return
            if current_state != _W_RETIRED_ABSENT:
                raise Fatal(_E_STATE)
            other_fd, other_error = _open_dir(fds, generations_fd, other_name, uid, device)
            if other_fd is None or other_error is not None:
                raise Fatal(_E_STATE)
            if not _rollback_empty_generation(fds, generations_fd, other_name, other_fd, uid, device):
                raise Fatal(_E_STATE)
            return
        other_raw = bytearray.fromhex(other_name.decode("ascii"))
        other_fd = None
        other_wal_fd = None
        other_rows = []
        try:
            if other_state == _W_RETIRED_ABSENT:
                if current_state != _W_ALLOCATED:
                    raise Fatal(_E_STATE)
                if stage not in ("complete", "record-no-head"):
                    raise Fatal(_E_STATE)
                _remove_generation_suffix(
                    fds, generations_fd, other_name, lifecycle, uid, device, True, identity_digest, current_last[2]
                )
            elif other_state == _W_ALLOCATED:
                if current_state != _W_RETIRED_ABSENT:
                    raise Fatal(_E_STATE)
                other_fd, other_error = _open_dir(fds, generations_fd, other_name, uid, device)
                if other_fd is None or other_error is not None:
                    raise Fatal(_E_STATE)
                other_wal_fd, other_wal_error = _open_dir(fds, other_fd, _WAL, uid, device)
                if other_wal_fd is None or other_wal_error is not None:
                    raise Fatal(_E_STATE)
                other_entries = _list(other_wal_fd)
                record_names = [item for item in other_entries if item != _HEAD and item != linked_head_temp]
                if len(record_names) != 1:
                    raise Fatal(_E_STATE)
                parsed = _parse_record_name(record_names[0], b".wal")
                if parsed is None:
                    raise Fatal(_E_STATE)
                other_revision, other_digest = parsed
                other_record, other_record_error = _read_file(fds, other_wal_fd, record_names[0], uid, device, _WAL_SIZE, _WAL_SIZE)
                if other_record is None or other_record_error is not None:
                    _zero(other_digest)
                    raise Fatal(_E_STATE)
                actual_other = _digest(other_record)
                try:
                    if other_revision != 1 or not _same(actual_other, other_digest):
                        raise Fatal(_E_DIGEST)
                    _validate_allocated(other_record, lifecycle, other_raw, identity_digest)
                    if not _constant_digests_equal(current_last[2], other_record):
                        raise Fatal(_E_DIGEST)
                finally:
                    _zero(actual_other)
                    _zero(other_digest)
                    _zero(other_record)
                if linked_head_temp is not None:
                    _unlink(other_wal_fd, linked_head_temp)
                    _fsync(other_wal_fd)
                fds.close_for_recovery(other_wal_fd)
                other_wal_fd = None
                fds.close_for_recovery(other_fd)
                other_fd = None
                if stage == "record-no-head":
                    scanned_other = _scan_generation(fds, generations_fd, other_name, lifecycle, uid, device, True)
                    if scanned_other is None:
                        raise Fatal(_E_STATE)
                    finished_fd, finished_wal_fd, finished_rows, unused_last, unused_stage = scanned_other
                    _zero_record_rows(finished_rows)
                    fds.close(finished_wal_fd)
                    fds.close(finished_fd)
                elif stage != "complete":
                    raise Fatal(_E_STATE)
            else:
                raise Fatal(_E_STATE)
        finally:
            if other_wal_fd is not None:
                fds.close(other_wal_fd)
            if other_fd is not None:
                fds.close(other_fd)
            _zero_record_rows(other_rows)
            _zero(other_raw)
    finally:
        if session_data is not None:
            _zero(session_data)
        if current_wal_fd is not None:
            fds.close(current_wal_fd)
        if current_generation_fd is not None:
            fds.close(current_generation_fd)
        if generations_fd is not None:
            fds.close(generations_fd)
        _zero_record_rows(current_rows)
        _zero_record_rows(ledger_rows)
        if identity is not None:
            _zero(identity)
        if current_generation is not None:
            _zero(current_generation)
        if current_digest is not None:
            _zero(current_digest)
        if identity_digest is not None:
            _zero(identity_digest)


def _linked_temp_for_target(parent, entries, target, uid, device):
    target_st, target_error = _lstat(parent, target)
    if target_st is None or target_error is not None:
        return None
    if target_st.st_nlink == 1:
        _validate_file_stat(target_st, uid, device)
        return None
    _validate_file_stat(target_st, uid, device, 2)
    found = None
    index = 0
    while index < len(entries):
        candidate = entries[index]
        if candidate.startswith(b".tmp."):
            if not _valid_temp(candidate):
                raise Fatal(_E_STATE)
            candidate_st, candidate_error = _lstat(parent, candidate)
            if candidate_st is None or candidate_error is not None:
                raise Fatal(_E_UNCERTAIN)
            if candidate_st.st_dev == target_st.st_dev and candidate_st.st_ino == target_st.st_ino:
                _validate_file_stat(candidate_st, uid, device, 2)
                if found is not None:
                    raise Fatal(_E_NLINK)
                found = candidate
        index += 1
    if found is None:
        raise Fatal(_E_NLINK)
    return found


def _repair_lifecycle_head_link(fds, lifecycle_fd, lifecycle, uid, device):
    entries = _list(lifecycle_fd)
    linked_temp = _linked_temp_for_target(lifecycle_fd, entries, _HEAD, uid, device)
    if linked_temp is None:
        return False
    scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False, 2, linked_temp)
    _close_scan(fds, scan)
    fds.require_certain()
    _unlink(lifecycle_fd, linked_temp)
    _fsync(lifecycle_fd)
    final, final_error = _lstat(lifecycle_fd, _HEAD)
    if final is None or final_error is not None:
        raise Fatal(_E_UNCERTAIN)
    _validate_file_stat(final, uid, device)
    return True


def _purge_stage_pair_allowed(generation_stage, ledger_stage, wal_count, ledger_count):
    stage_count_table = (
        ("suffix-head", "full-head", 1, 6, 2, 16),
        ("suffix-head", "suffix-head", 1, 1, 1, 15),
        ("terminal-record", "suffix-head", 1, 1, 1, 1),
        ("empty-wal", "suffix-head", 0, 0, 1, 1),
        ("empty-generation", "suffix-head", 0, 0, 1, 1),
        ("empty-generations", "suffix-head", 0, 0, 1, 1),
        ("absent", "suffix-head", 0, 0, 1, 1),
        ("absent", "terminal-record", 0, 0, 1, 1),
        ("absent", "empty", 0, 0, 0, 0),
        ("absent", "absent", 0, 0, 0, 0),
    )
    index = 0
    while index < len(stage_count_table):
        row = stage_count_table[index]
        if (
            generation_stage == row[0]
            and ledger_stage == row[1]
            and row[2] <= wal_count <= row[3]
            and row[4] <= ledger_count <= row[5]
        ):
            return True
        index += 1
    return False


def _recover_purge_suffix(fds, root_fd, lifecycle_name, lifecycle_fd, lifecycle, uid, device):
    entries = _list(lifecycle_fd)
    if _HEAD not in entries:
        return False
    if _contains_temp(entries):
        return False
    if _IDENTITY not in entries:
        raise Fatal(_E_STATE)
    if _contains_outside(entries, (_IDENTITY, _LEDGER, _GENERATIONS, _HEAD)):
        raise Fatal(_E_STATE)
    session_data, session_error = _read_head(fds, lifecycle_fd, _HEAD, _SESSION_MAGIC, 112, uid, device)
    if session_data is None or session_error is not None:
        raise Fatal(_E_HEAD)
    current_generation = None
    current_digest = None
    head_identity = None
    identity = None
    identity_digest = None
    ledger_fd = None
    generations_fd = None
    generation_fd = None
    wal_fd = None
    ledger_rows = []
    wal_rows = []
    candidate = False
    v5_evidence = False
    try:
        current_generation, current_revision, current_digest, head_identity = _parse_session_head(session_data)
        _zero(session_data)
        session_data = None
        identity, identity_error = _read_file(fds, lifecycle_fd, _IDENTITY, uid, device, 16384)
        if identity is None or identity_error is not None or len(identity) < 1:
            raise Fatal(_E_STATE)
        identity_digest = _digest(identity)
        if not _same(identity_digest, head_identity):
            raise Fatal(_E_DIGEST)
        ledger_stage = "absent"
        if _LEDGER in entries:
            ledger_fd, ledger_error = _open_dir(fds, lifecycle_fd, _LEDGER, uid, device)
            if ledger_fd is None or ledger_error is not None:
                raise Fatal(_E_STATE)
            ledger_entries = _list(ledger_fd)
            if _contains_temp(ledger_entries):
                return False
            ledger_rows, unused_total = _scan_suffix_records(
                fds, ledger_fd, ledger_entries, b".rec", _MAX_LEDGER_RECORDS, _MAX_LEDGER_BYTES, None, uid, device
            )
            ledger_head_present = _HEAD in ledger_entries
            if ledger_head_present:
                if len(ledger_rows) == 0:
                    raise Fatal(_E_HEAD)
                ledger_head, ledger_head_error = _read_head(fds, ledger_fd, _HEAD, _LEDGER_MAGIC, 48, uid, device)
                if ledger_head is None or ledger_head_error is not None:
                    raise Fatal(_E_HEAD)
                ledger_head_digest = None
                try:
                    ledger_number, ledger_head_digest = _parse_head(ledger_head, _LEDGER_MAGIC)
                    if ledger_number != ledger_rows[-1][0] or not _same(ledger_head_digest, ledger_rows[-1][3]):
                        if ledger_rows[0][0] == 0:
                            return False
                        raise Fatal(_E_HEAD)
                finally:
                    _zero(ledger_head)
                    if ledger_head_digest is not None:
                        _zero(ledger_head_digest)
                if ledger_rows[0][0] == 0:
                    if not _same(identity, ledger_rows[0][2]) or not _same(identity_digest, ledger_rows[0][3]):
                        raise Fatal(_E_DIGEST)
                    ledger_stage = "full-head"
                else:
                    ledger_stage = "suffix-head"
                    candidate = True
            elif len(ledger_rows) == 1:
                ledger_stage = "terminal-record"
                candidate = True
            elif len(ledger_rows) == 0:
                ledger_stage = "empty"
                candidate = True
            else:
                raise Fatal(_E_STATE)
        else:
            if _GENERATIONS in entries:
                raise Fatal(_E_STATE)
            ledger_stage = "absent"
            candidate = True
        generation_stage = "absent"
        current_name = _hex_name(current_generation)
        if _GENERATIONS in entries:
            generations_fd, generations_error = _open_dir(fds, lifecycle_fd, _GENERATIONS, uid, device)
            if generations_fd is None or generations_error is not None:
                raise Fatal(_E_STATE)
            generation_names = _list(generations_fd)
            if len(generation_names) == 0:
                generation_stage = "empty-generations"
                candidate = True
            elif len(generation_names) == 2:
                return False
            elif len(generation_names) == 1 and generation_names[0] == current_name:
                generation_fd, generation_error = _open_dir(fds, generations_fd, current_name, uid, device)
                if generation_fd is None or generation_error is not None:
                    raise Fatal(_E_STATE)
                generation_entries = _list(generation_fd)
                if len(generation_entries) == 0:
                    generation_stage = "empty-generation"
                    candidate = True
                elif generation_entries == [_WAL] or _WORKSPACE_EVIDENCE in generation_entries:
                    if _WORKSPACE_EVIDENCE in generation_entries:
                        if len(generation_entries) != 2 or _WAL not in generation_entries:
                            raise Fatal(_E_STATE)
                        v5_evidence = True
                    wal_fd, wal_error = _open_dir(fds, generation_fd, _WAL, uid, device)
                    if wal_fd is None or wal_error is not None:
                        raise Fatal(_E_STATE)
                    wal_entries = _list(wal_fd)
                    if _contains_temp(wal_entries):
                        return False
                    wal_rows, unused_wal_total = _scan_suffix_records(
                        fds, wal_fd, wal_entries, b".wal", _MAX_WAL_RECORDS, _WAL_SIZE * _MAX_WAL_RECORDS, _WAL_SIZE, uid, device
                    )
                    wal_head_present = _HEAD in wal_entries
                    if len(wal_rows) > 0:
                        terminal_state = _validate_wal_suffix(wal_rows, lifecycle, current_generation, identity_digest)
                        if wal_head_present and wal_rows[0][0] == 1 and ledger_stage == "full-head":
                            return False
                        if terminal_state != _W_ABSENT:
                            raise Fatal(_E_STATE)
                        if wal_rows[-1][0] != current_revision or not _same(wal_rows[-1][3], current_digest):
                            raise Fatal(_E_HEAD)
                    if wal_head_present:
                        if len(wal_rows) == 0:
                            raise Fatal(_E_HEAD)
                        wal_head, wal_head_error = _read_head(fds, wal_fd, _HEAD, _WAL_HEAD_MAGIC, 48, uid, device)
                        if wal_head is None or wal_head_error is not None:
                            raise Fatal(_E_HEAD)
                        wal_head_digest = None
                        try:
                            wal_revision, wal_head_digest = _parse_head(wal_head, _WAL_HEAD_MAGIC)
                            if wal_revision != wal_rows[-1][0] or not _same(wal_head_digest, wal_rows[-1][3]):
                                raise Fatal(_E_HEAD)
                        finally:
                            _zero(wal_head)
                            if wal_head_digest is not None:
                                _zero(wal_head_digest)
                        generation_stage = "full-head" if wal_rows[0][0] == 1 else "suffix-head"
                        if generation_stage == "suffix-head":
                            candidate = True
                    elif len(wal_rows) == 1:
                        generation_stage = "terminal-record"
                        candidate = True
                    elif len(wal_rows) == 0:
                        generation_stage = "empty-wal"
                        candidate = True
                    else:
                        raise Fatal(_E_STATE)
                else:
                    raise Fatal(_E_STATE)
            else:
                raise Fatal(_E_STATE)
        else:
            generation_stage = "absent"
            candidate = True
        if v5_evidence:
            raise Fatal(_E_STATE)
        if not candidate:
            return False
        if len(wal_rows) > 0 and wal_rows[-1][0] != _MAX_WAL_RECORDS:
            raise Fatal(_E_STATE)
        if len(ledger_rows) > 0 and (ledger_rows[-1][0] < 1 or ledger_rows[-1][0] >= _MAX_LEDGER_RECORDS):
            raise Fatal(_E_STATE)
        if not _purge_stage_pair_allowed(generation_stage, ledger_stage, len(wal_rows), len(ledger_rows)):
            raise Fatal(_E_STATE)
        if generation_stage == "absent" and ledger_stage == "absent":
            if set(entries) != {_IDENTITY, _HEAD}:
                raise Fatal(_E_STATE)
        if wal_fd is not None and len(wal_rows) > 0:
            index = 0
            while index + 1 < len(wal_rows):
                _unlink(wal_fd, wal_rows[index][1])
                index += 1
            _fsync(wal_fd)
        if ledger_fd is not None and len(ledger_rows) > 0:
            index = 0
            while index + 1 < len(ledger_rows):
                _unlink(ledger_fd, ledger_rows[index][1])
                index += 1
            _fsync(ledger_fd)
        if wal_fd is not None:
            if _HEAD in _list(wal_fd):
                _unlink(wal_fd, _HEAD)
                _fsync(wal_fd)
            if len(wal_rows) > 0 and wal_rows[-1][1] in _list(wal_fd):
                _unlink(wal_fd, wal_rows[-1][1])
                _fsync(wal_fd)
            if len(_list(wal_fd)) != 0:
                raise Fatal(_E_STATE)
            fds.close_for_recovery(wal_fd)
            wal_fd = None
            _rmdir(generation_fd, _WAL)
            _fsync(generation_fd)
        if generation_fd is not None:
            if len(_list(generation_fd)) != 0:
                raise Fatal(_E_STATE)
            fds.close_for_recovery(generation_fd)
            generation_fd = None
            _rmdir(generations_fd, current_name)
            _fsync(generations_fd)
        if generations_fd is not None:
            if len(_list(generations_fd)) != 0:
                raise Fatal(_E_STATE)
            fds.close_for_recovery(generations_fd)
            generations_fd = None
            _rmdir(lifecycle_fd, _GENERATIONS)
            _fsync(lifecycle_fd)
        if ledger_fd is not None:
            if _HEAD in _list(ledger_fd):
                _unlink(ledger_fd, _HEAD)
                _fsync(ledger_fd)
            if len(ledger_rows) > 0 and ledger_rows[-1][1] in _list(ledger_fd):
                _unlink(ledger_fd, ledger_rows[-1][1])
                _fsync(ledger_fd)
            if len(_list(ledger_fd)) != 0:
                raise Fatal(_E_STATE)
            fds.close_for_recovery(ledger_fd)
            ledger_fd = None
            _rmdir(lifecycle_fd, _LEDGER)
            _fsync(lifecycle_fd)
        if _HEAD in _list(lifecycle_fd):
            _unlink(lifecycle_fd, _HEAD)
            _fsync(lifecycle_fd)
        if _IDENTITY in _list(lifecycle_fd):
            _unlink(lifecycle_fd, _IDENTITY)
            _fsync(lifecycle_fd)
        if len(_list(lifecycle_fd)) != 0:
            raise Fatal(_E_STATE)
        fds.close_for_recovery(lifecycle_fd)
        _rmdir(root_fd, lifecycle_name)
        _fsync(root_fd)
        _probe_absent(root_fd, lifecycle_name)
        return True
    finally:
        if session_data is not None:
            _zero(session_data)
        if wal_fd is not None:
            fds.close(wal_fd)
        if generation_fd is not None:
            fds.close(generation_fd)
        if generations_fd is not None:
            fds.close(generations_fd)
        if ledger_fd is not None:
            fds.close(ledger_fd)
        _zero_record_rows(wal_rows)
        _zero_record_rows(ledger_rows)
        if identity is not None:
            _zero(identity)
        if identity_digest is not None:
            _zero(identity_digest)
        if current_generation is not None:
            _zero(current_generation)
        if current_digest is not None:
            _zero(current_digest)
        if head_identity is not None:
            _zero(head_identity)


def _v5_random_suffix(name, prefix):
    if len(name) != len(prefix) + 64 or name[:len(prefix)] != prefix or not _valid_hex_name(name[len(prefix):], 64):
        return None
    suffix = bytearray.fromhex(name[len(prefix):].decode("ascii"))
    if _all_zero(suffix):
        _zero(suffix)
        return None
    return suffix


def _v5_header_prefix(data, magic, width, minimum, maximum):
    expected_size = len(magic) + width
    if len(data) > expected_size:
        return False, False, 0
    fixed = len(data) if len(data) < len(magic) else len(magic)
    difference = 0
    fixed_index = 0
    while fixed_index < fixed:
        difference |= data[fixed_index] ^ magic[fixed_index]
        fixed_index += 1
    if difference != 0:
        return False, False, 0
    if len(data) <= len(magic):
        return True, False, 0
    value = 0
    index = len(magic)
    while index < len(data):
        value = (value << 8) | data[index]
        index += 1
    remaining = expected_size - len(data)
    lower = value << (remaining * 8)
    upper = lower | ((1 << (remaining * 8)) - 1 if remaining > 0 else 0)
    if lower > maximum or upper < minimum:
        return False, False, 0
    if remaining == 0:
        return True, True, value
    return True, False, 0


def _v5_prefix_field(data, offset, expected):
    if len(data) <= offset:
        return True
    available = len(data) - offset
    count = len(expected) if len(expected) < available else available
    difference = 0
    index = 0
    while index < count:
        difference |= data[offset + index] ^ expected[index]
        index += 1
    return difference == 0


def _v5_input_manifest_prefix(data, lifecycle, generation, plan_nonce, content_nonce, plan_length, content_length):
    if len(data) > _INPUT_MANIFEST_SIZE:
        return False
    plan_size = struct.pack(">I", plan_length)
    content_size = struct.pack(">Q", content_length)
    zero_eight = bytes(8)
    zero_twenty = bytes(20)
    if not _v5_prefix_field(data, 0, _INPUT_MANIFEST_MAGIC):
        return False
    if not _v5_prefix_field(data, 8, zero_eight):
        return False
    if not _v5_prefix_field(data, 16, lifecycle):
        return False
    if not _v5_prefix_field(data, 48, generation):
        return False
    if len(data) >= 144 and _range_zero(data, 112, 144):
        return False
    if not _v5_prefix_field(data, 176, plan_size):
        return False
    if not _v5_prefix_field(data, 180, content_size):
        return False
    if not _v5_prefix_field(data, 188, plan_nonce):
        return False
    if not _v5_prefix_field(data, 220, content_nonce):
        return False
    return _v5_prefix_field(data, 252, zero_twenty)


def _v5_require_absent(parent, name):
    found, error = _lstat(parent, name)
    if found is not None or error != errno.ENOENT:
        raise Fatal(_E_UNCERTAIN)


def _v5_read_open_file(fd, size):
    result = bytearray(size)
    complete = False
    view = memoryview(result)
    try:
        offset = 0
        while offset < size:
            try:
                count = os.readv(fd, (view[offset:],))
            except InterruptedError:
                continue
            except OSError:
                raise Fatal(_E_IO)
            if count <= 0:
                raise Fatal(_E_UNCERTAIN)
            offset += count
        complete = True
        return result
    finally:
        view.release()
        if not complete:
            _zero(result)


def _v5_same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _v5_validate_retained_file(fd, expected_stat, uid, device, links):
    found = _fstat(fd)
    _validate_file_stat(found, uid, device, links)
    if not _v5_same_inode(found, expected_stat) or found.st_size != _INPUT_MANIFEST_SIZE:
        raise Fatal(_E_UNCERTAIN)
    return found


def _v5_validate_named_file(parent, name, expected_stat, uid, device, links):
    found, error = _lstat(parent, name)
    if found is None or error is not None:
        raise Fatal(_E_UNCERTAIN)
    _validate_file_stat(found, uid, device, links)
    if not _v5_same_inode(found, expected_stat) or found.st_size != _INPUT_MANIFEST_SIZE:
        raise Fatal(_E_UNCERTAIN)
    return found


def _v5_recover_input_begin_prefix(fds, generation_fd, lifecycle, generation, uid, device):
    mark = fds.mark()
    evidence_fd = None
    manifest_source_fd = None
    manifest_destination_fd = None
    plan_data = None
    content_data = None
    manifest_data = None
    plan_suffix = None
    content_suffix = None
    manifest_suffix = None
    try:
        evidence_fd, error = _open_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)
        if evidence_fd is None:
            if error == errno.ENOENT:
                return False
            raise Fatal(_E_UNCERTAIN)
        entries = _list(evidence_fd)
        plan_name = None
        content_name = None
        manifest_name = None
        canonical_present = False
        index = 0
        while index < len(entries):
            entry = entries[index]
            if entry.startswith(_PLAN_DRAFT_PREFIX):
                suffix = _v5_random_suffix(entry, _PLAN_DRAFT_PREFIX)
                if suffix is None or plan_name is not None:
                    if suffix is not None:
                        _zero(suffix)
                    raise Fatal(_E_STATE)
                plan_name = entry
                plan_suffix = suffix
            elif entry.startswith(_CONTENT_DRAFT_PREFIX):
                suffix = _v5_random_suffix(entry, _CONTENT_DRAFT_PREFIX)
                if suffix is None or content_name is not None:
                    if suffix is not None:
                        _zero(suffix)
                    raise Fatal(_E_STATE)
                content_name = entry
                content_suffix = suffix
            elif entry.startswith(_INPUT_MANIFEST_TEMP_PREFIX):
                suffix = _v5_random_suffix(entry, _INPUT_MANIFEST_TEMP_PREFIX)
                if suffix is None or manifest_name is not None:
                    if suffix is not None:
                        _zero(suffix)
                    raise Fatal(_E_STATE)
                manifest_name = entry
                manifest_suffix = suffix
            elif entry == _INPUT_MANIFEST:
                if canonical_present:
                    raise Fatal(_E_STATE)
                canonical_present = True
            else:
                raise Fatal(_E_STATE)
            index += 1
        if plan_suffix is not None and content_suffix is not None and _same(plan_suffix, content_suffix):
            raise Fatal(_E_STATE)
        if plan_suffix is not None and manifest_suffix is not None and _same(plan_suffix, manifest_suffix):
            raise Fatal(_E_STATE)
        if content_suffix is not None and manifest_suffix is not None and _same(content_suffix, manifest_suffix):
            raise Fatal(_E_STATE)
        plan_complete = False
        plan_length = 0
        if plan_name is None:
            if content_name is not None or manifest_name is not None or canonical_present:
                raise Fatal(_E_STATE)
        else:
            plan_data, plan_error = _read_file(
                fds, evidence_fd, plan_name, uid, device, _PLAN_HEADER_SIZE
            )
            if plan_data is None or plan_error is not None:
                raise Fatal(_E_UNCERTAIN)
            valid, plan_complete, plan_length = _v5_header_prefix(
                plan_data, _PLAN_RECORD_MAGIC, 4, 1, _MAX_PLAN_PAYLOAD
            )
            if not valid:
                raise Fatal(_E_STATE)
        content_complete = False
        content_length = 0
        if content_name is None:
            if manifest_name is not None or canonical_present:
                raise Fatal(_E_STATE)
        else:
            if not plan_complete:
                raise Fatal(_E_STATE)
            content_data, content_error = _read_file(
                fds, evidence_fd, content_name, uid, device, _CONTENT_HEADER_SIZE
            )
            if content_data is None or content_error is not None:
                raise Fatal(_E_UNCERTAIN)
            valid, content_complete, content_length = _v5_header_prefix(
                content_data, _CONTENT_RECORD_MAGIC, 8, 0, _MAX_CONTENT_PAYLOAD
            )
            if not valid:
                raise Fatal(_E_STATE)
        if canonical_present:
            if not plan_complete or not content_complete or plan_suffix is None or content_suffix is None:
                raise Fatal(_E_STATE)
            if manifest_name is not None:
                manifest_source_fd, source_error = _open_file(
                    fds,
                    evidence_fd,
                    manifest_name,
                    uid,
                    device,
                    _INPUT_MANIFEST_SIZE,
                    _INPUT_MANIFEST_SIZE,
                    2,
                )
                if manifest_source_fd is None or source_error is not None:
                    raise Fatal(_E_UNCERTAIN)
                source_stat = _fstat(manifest_source_fd)
                _validate_file_stat(source_stat, uid, device, 2)
                manifest_data = _v5_read_open_file(manifest_source_fd, _INPUT_MANIFEST_SIZE)
                manifest_destination_fd, destination_error = _open_file(
                    fds,
                    evidence_fd,
                    _INPUT_MANIFEST,
                    uid,
                    device,
                    _INPUT_MANIFEST_SIZE,
                    _INPUT_MANIFEST_SIZE,
                    2,
                )
                if manifest_destination_fd is None or destination_error is not None:
                    raise Fatal(_E_UNCERTAIN)
                destination_stat = _fstat(manifest_destination_fd)
                _validate_file_stat(destination_stat, uid, device, 2)
                if not _v5_same_inode(source_stat, destination_stat):
                    raise Fatal(_E_STATE)
            else:
                manifest_destination_fd, destination_error = _open_file(
                    fds,
                    evidence_fd,
                    _INPUT_MANIFEST,
                    uid,
                    device,
                    _INPUT_MANIFEST_SIZE,
                    _INPUT_MANIFEST_SIZE,
                    1,
                )
                if manifest_destination_fd is None or destination_error is not None:
                    raise Fatal(_E_UNCERTAIN)
                destination_stat = _fstat(manifest_destination_fd)
                _validate_file_stat(destination_stat, uid, device, 1)
                manifest_data = _v5_read_open_file(manifest_destination_fd, _INPUT_MANIFEST_SIZE)
            if not _v5_input_manifest_prefix(
                manifest_data,
                lifecycle,
                generation,
                plan_suffix,
                content_suffix,
                plan_length,
                content_length,
            ):
                raise Fatal(_E_STATE)
            if manifest_name is not None:
                _v5_validate_retained_file(
                    manifest_destination_fd, destination_stat, uid, device, 2
                )
                _fsync(evidence_fd)
                _v5_validate_named_file(
                    evidence_fd, manifest_name, destination_stat, uid, device, 2
                )
                _v5_validate_named_file(
                    evidence_fd, _INPUT_MANIFEST, destination_stat, uid, device, 2
                )
                _unlink(evidence_fd, manifest_name)
                _fsync(evidence_fd)
                _v5_require_absent(evidence_fd, manifest_name)
            else:
                _fsync(evidence_fd)
            final_entries = _list(evidence_fd)
            if len(final_entries) != 3 or plan_name not in final_entries or content_name not in final_entries or _INPUT_MANIFEST not in final_entries:
                raise Fatal(_E_STATE)
            final_stat = _v5_validate_retained_file(
                manifest_destination_fd, destination_stat, uid, device, 1
            )
            _v5_validate_named_file(
                evidence_fd, _INPUT_MANIFEST, final_stat, uid, device, 1
            )
            return True
        if manifest_name is not None:
            if not plan_complete or not content_complete or plan_suffix is None or content_suffix is None:
                raise Fatal(_E_STATE)
            manifest_data, manifest_error = _read_file(
                fds, evidence_fd, manifest_name, uid, device, _INPUT_MANIFEST_SIZE
            )
            if manifest_data is None or manifest_error is not None:
                raise Fatal(_E_UNCERTAIN)
            if not _v5_input_manifest_prefix(
                manifest_data,
                lifecycle,
                generation,
                plan_suffix,
                content_suffix,
                plan_length,
                content_length,
            ):
                raise Fatal(_E_STATE)
            _unlink(evidence_fd, manifest_name)
            _fsync(evidence_fd)
            _v5_require_absent(evidence_fd, manifest_name)
        if content_name is not None:
            _unlink(evidence_fd, content_name)
            _fsync(evidence_fd)
            _v5_require_absent(evidence_fd, content_name)
        if plan_name is not None:
            _unlink(evidence_fd, plan_name)
            _fsync(evidence_fd)
            _v5_require_absent(evidence_fd, plan_name)
        if len(_list(evidence_fd)) != 0:
            raise Fatal(_E_STATE)
        if manifest_destination_fd is not None:
            fds.close_for_recovery(manifest_destination_fd)
            manifest_destination_fd = None
        if manifest_source_fd is not None:
            fds.close_for_recovery(manifest_source_fd)
            manifest_source_fd = None
        fds.close_for_recovery(evidence_fd)
        evidence_fd = None
        _rmdir(generation_fd, _WORKSPACE_EVIDENCE)
        _fsync(generation_fd)
        _v5_require_absent(generation_fd, _WORKSPACE_EVIDENCE)
        return True
    finally:
        if manifest_data is not None:
            _zero(manifest_data)
        if content_data is not None:
            _zero(content_data)
        if plan_data is not None:
            _zero(plan_data)
        if manifest_suffix is not None:
            _zero(manifest_suffix)
        if content_suffix is not None:
            _zero(content_suffix)
        if plan_suffix is not None:
            _zero(plan_suffix)
        if manifest_destination_fd is not None:
            fds.close_for_recovery(manifest_destination_fd)
        if manifest_source_fd is not None:
            fds.close_for_recovery(manifest_source_fd)
        if evidence_fd is not None:
            fds.close_for_recovery(evidence_fd)
        fds.close_after(mark)
        if fds.mark() != mark or fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _v5_recover_lifecycle_evidence(fds, scan, lifecycle, uid, device, recover):
    generations = scan[6]
    current_generation = scan[7]
    current_name = _hex_name(current_generation)
    present = False
    index = 0
    while index < len(generations):
        generation = generations[index]
        entries = _list(generation[1])
        if _WORKSPACE_EVIDENCE in entries:
            present = True
            if recover:
                if generation[0] != current_name:
                    raise Fatal(_E_STATE)
                _v5_recover_input_begin_prefix(
                    fds, generation[1], lifecycle, current_generation, uid, device
                )
        index += 1
    return present


def _recover_root(
    fds,
    root_fd,
    uid,
    device,
    root_inode,
    lock_fd,
    lock_device,
    lock_inode,
    recover_v5_evidence=False,
):
    v5_present = False
    fds.begin_recovery()
    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
    fds.require_certain()
    entries = _list(root_fd)
    try:
        _clean_temps(fds, root_fd, entries, uid, device, b"")
    finally:
        _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
        fds.require_certain()
    entries = _list(root_fd)
    lifecycle_count = 0
    index = 0
    while index < len(entries):
        name = entries[index]
        if name == _LOCK:
            index += 1
            continue
        if not _valid_hex_name(name, 64):
            raise Fatal(_E_STATE)
        lifecycle_count += 1
        if lifecycle_count > 1024:
            raise Fatal(_E_BOUNDS)
        lifecycle_fd, error = _open_dir(fds, root_fd, name, uid, device)
        if lifecycle_fd is None:
            raise Fatal(_E_STATE)
        lifecycle_entries = _list(lifecycle_fd)
        lifecycle = bytearray.fromhex(name.decode("ascii"))
        try:
            if _HEAD not in lifecycle_entries:
                _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                fds.require_certain()
                try:
                    _rollback_unpublished(fds, root_fd, name, lifecycle_fd, uid, device)
                    lifecycle_fd = None
                finally:
                    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                    fds.require_certain()
            else:
                _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                fds.require_certain()
                try:
                    _repair_lifecycle_head_link(fds, lifecycle_fd, lifecycle, uid, device)
                finally:
                    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                    fds.require_certain()
                _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                fds.require_certain()
                try:
                    purged = _recover_purge_suffix(fds, root_fd, name, lifecycle_fd, lifecycle, uid, device)
                finally:
                    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                    fds.require_certain()
                if purged:
                    lifecycle_fd = None
                else:
                    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                    fds.require_certain()
                    try:
                        _recover_generation_stages(fds, lifecycle_fd, lifecycle, uid, device, True)
                    finally:
                        _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                        fds.require_certain()
                    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                    fds.require_certain()
                    try:
                        scan = _scan_lifecycle(
                            fds,
                            lifecycle_fd,
                            lifecycle,
                            uid,
                            device,
                            True,
                            allow_v5_evidence=True,
                        )
                        try:
                            if _v5_recover_lifecycle_evidence(
                                fds, scan, lifecycle, uid, device, recover_v5_evidence
                            ):
                                v5_present = True
                        finally:
                            _close_scan(fds, scan)
                    finally:
                        _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                        fds.require_certain()
        finally:
            _zero(lifecycle)
            if lifecycle_fd is not None:
                fds.close(lifecycle_fd)
            fds.require_certain()
        index += 1
    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
    fds.require_certain()
    try:
        _fsync(root_fd)
    finally:
        _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
        fds.require_certain()
    fds.end_recovery([root_fd, lock_fd])
    return v5_present


def _cmd_inventory(fds, root_fd, uid, device, output_fd, root_inode, lock_fd, lock_device, lock_inode):
    entries = _list(root_fd)
    lifecycle_names = []
    index = 0
    while index < len(entries):
        name = entries[index]
        if name != _LOCK:
            if not _valid_hex_name(name, 64):
                raise Fatal(_E_STATE)
            lifecycle_names.append(name)
        index += 1
    if len(lifecycle_names) > 1024:
        raise Fatal(_E_BOUNDS)
    index = 0
    while index < len(lifecycle_names):
        lifecycle_name = lifecycle_names[index]
        lifecycle = bytearray.fromhex(lifecycle_name.decode("ascii"))
        lifecycle_fd, error = _open_dir(fds, root_fd, lifecycle_name, uid, device)
        if lifecycle_fd is None:
            _zero(lifecycle)
            raise Fatal(_E_UNCERTAIN)
        scan = None
        try:
            scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
            session_response = _session_payload(lifecycle, scan)
            try:
                _close_scan(fds, scan)
                scan = None
                fds.close(lifecycle_fd)
                lifecycle_fd = None
                if fds.uncertain:
                    raise Fatal(_E_UNCERTAIN)
                _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
                _write_frame(output_fd, _SESSION, session_response)
            finally:
                _zero(session_response)
        finally:
            if scan is not None:
                _close_scan(fds, scan)
            if lifecycle_fd is not None:
                fds.close(lifecycle_fd)
            _zero(lifecycle)
        index += 1
    _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
    _write_frame(output_fd, _DONE, bytearray())


def _cmd_inspect(fds, root_fd, payload, uid, device):
    if len(payload) != 32:
        return None, _E_INPUT
    lifecycle = memoryview(payload)
    lifecycle_fd, error, lifecycle_name = _open_lifecycle(fds, root_fd, lifecycle, uid, device)
    if lifecycle_fd is None:
        lifecycle.release()
        if error == errno.ENOENT:
            return None, _E_ABSENT
        raise Fatal(_E_UNCERTAIN)
    try:
        scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
        try:
            result = _session_payload(lifecycle, scan)
        finally:
            _close_scan(fds, scan)
    finally:
        fds.close(lifecycle_fd)
        lifecycle.release()
    return result, None


def _validate_allocated(record, lifecycle, generation, identity_digest):
    state_value, revision = _verify_wal_record(record, lifecycle, generation, 1, _ZERO32, identity_digest)
    if state_value != _W_ALLOCATED or revision != 1:
        raise Fatal(_E_STATE)


def _published_create_has_temp(fds, lifecycle_fd, uid, device):
    entries = _list(lifecycle_fd)
    if _contains_temp(entries):
        return True
    ledger_fd = None
    generations_fd = None
    generation_fd = None
    wal_fd = None
    try:
        if _LEDGER in entries:
            ledger_fd, ledger_error = _open_dir(fds, lifecycle_fd, _LEDGER, uid, device)
            if ledger_fd is None or ledger_error is not None:
                raise Fatal(_E_STATE)
            if _contains_temp(_list(ledger_fd)):
                return True
            fds.close_for_recovery(ledger_fd)
            ledger_fd = None
        if _GENERATIONS in entries:
            generations_fd, generations_error = _open_dir(fds, lifecycle_fd, _GENERATIONS, uid, device)
            if generations_fd is None or generations_error is not None:
                raise Fatal(_E_STATE)
            generation_names = _list(generations_fd)
            index = 0
            while index < len(generation_names):
                generation_name = generation_names[index]
                if not _valid_hex_name(generation_name, 64):
                    raise Fatal(_E_STATE)
                generation_fd, generation_error = _open_dir(fds, generations_fd, generation_name, uid, device)
                if generation_fd is None or generation_error is not None:
                    raise Fatal(_E_STATE)
                generation_entries = _list(generation_fd)
                if _WAL in generation_entries:
                    wal_fd, wal_error = _open_dir(fds, generation_fd, _WAL, uid, device)
                    if wal_fd is None or wal_error is not None:
                        raise Fatal(_E_STATE)
                    if _contains_temp(_list(wal_fd)):
                        return True
                    fds.close_for_recovery(wal_fd)
                    wal_fd = None
                fds.close_for_recovery(generation_fd)
                generation_fd = None
                index += 1
            fds.close_for_recovery(generations_fd)
            generations_fd = None
        return False
    finally:
        if wal_fd is not None:
            fds.close(wal_fd)
        if generation_fd is not None:
            fds.close(generation_fd)
        if generations_fd is not None:
            fds.close(generations_fd)
        if ledger_fd is not None:
            fds.close(ledger_fd)


def _complete_create(fds, lifecycle_fd, lifecycle, generation, genesis, allocated, identity_digest, wal_digest, uid, device):
    ledger_fd = None
    generations_fd = None
    generation_fd = None
    wal_fd = None
    ledger_record = _record_name(0, identity_digest, b".rec")
    generation_name = _hex_name(generation)
    wal_record = _record_name(1, wal_digest, b".wal")
    identity_present = False
    ledger_present = False
    ledger_record_present = False
    ledger_head_present = False
    generations_present = False
    generation_present = False
    wal_present = False
    wal_record_present = False
    wal_head_present = False
    try:
        lifecycle_entries = _list(lifecycle_fd)
        if _HEAD in lifecycle_entries:
            raise Fatal(_E_STATE)
        index = 0
        while index < len(lifecycle_entries):
            candidate = lifecycle_entries[index]
            if candidate not in (_IDENTITY, _LEDGER, _GENERATIONS) and not candidate.startswith(b".tmp."):
                raise Fatal(_E_STATE)
            index += 1
        _repair_create_identity_link(fds, lifecycle_fd, lifecycle_entries, genesis, identity_digest, uid, device)
        lifecycle_entries = _list(lifecycle_fd)
        _clean_temps(fds, lifecycle_fd, lifecycle_entries, uid, device, b"", (_IDENTITY,))
        lifecycle_entries = _list(lifecycle_fd)
        identity_present = _IDENTITY in lifecycle_entries
        ledger_present = _LEDGER in lifecycle_entries
        generations_present = _GENERATIONS in lifecycle_entries
        if identity_present:
            matched, match_error = _read_matching(fds, lifecycle_fd, _IDENTITY, genesis, uid, device)
            if match_error is not None or not matched:
                raise Fatal(_E_DIGEST)
        if ledger_present:
            ledger_fd, ledger_error = _open_dir(fds, lifecycle_fd, _LEDGER, uid, device)
            if ledger_fd is None or ledger_error is not None:
                raise Fatal(_E_STATE)
            ledger_entries = _list(ledger_fd)
            index = 0
            while index < len(ledger_entries):
                candidate = ledger_entries[index]
                if candidate not in (ledger_record, _HEAD) and not candidate.startswith(b".tmp."):
                    raise Fatal(_E_STATE)
                index += 1
            _validate_create_publication_links(ledger_fd, ledger_entries, ledger_record, generations_present, uid, device)
            _clean_temps(fds, ledger_fd, ledger_entries, uid, device, b".rec", (_HEAD,))
            ledger_entries = _list(ledger_fd)
            ledger_record_present = ledger_record in ledger_entries
            ledger_head_present = _HEAD in ledger_entries
            if ledger_head_present and not ledger_record_present:
                raise Fatal(_E_STATE)
            if ledger_record_present:
                matched, match_error = _read_matching(fds, ledger_fd, ledger_record, genesis, uid, device)
                if match_error is not None or not matched:
                    raise Fatal(_E_DIGEST)
            if ledger_head_present:
                ledger_head = _build_ledger_head(0, identity_digest)
                try:
                    matched, match_error = _read_matching(fds, ledger_fd, _HEAD, ledger_head, uid, device)
                    if match_error is not None or not matched:
                        raise Fatal(_E_HEAD)
                finally:
                    _zero(ledger_head)
        if generations_present:
            generations_fd, generations_error = _open_dir(fds, lifecycle_fd, _GENERATIONS, uid, device)
            if generations_fd is None or generations_error is not None:
                raise Fatal(_E_STATE)
            generation_entries = _list(generations_fd)
            if len(generation_entries) > 1 or (len(generation_entries) == 1 and generation_entries[0] != generation_name):
                raise Fatal(_E_STATE)
            generation_present = generation_name in generation_entries
            if generation_present:
                generation_fd, generation_error = _open_dir(fds, generations_fd, generation_name, uid, device)
                if generation_fd is None or generation_error is not None:
                    raise Fatal(_E_STATE)
                generation_contents = _list(generation_fd)
                if len(generation_contents) > 1 or (len(generation_contents) == 1 and generation_contents[0] != _WAL):
                    raise Fatal(_E_STATE)
                wal_present = _WAL in generation_contents
                if wal_present:
                    wal_fd, wal_error = _open_dir(fds, generation_fd, _WAL, uid, device)
                    if wal_fd is None or wal_error is not None:
                        raise Fatal(_E_STATE)
                    wal_entries = _list(wal_fd)
                    index = 0
                    while index < len(wal_entries):
                        candidate = wal_entries[index]
                        if candidate not in (wal_record, _HEAD) and not candidate.startswith(b".tmp."):
                            raise Fatal(_E_STATE)
                        index += 1
                    _validate_create_publication_links(wal_fd, wal_entries, wal_record, False, uid, device)
                    _clean_temps(fds, wal_fd, wal_entries, uid, device, b".wal", (_HEAD,))
                    wal_entries = _list(wal_fd)
                    wal_record_present = wal_record in wal_entries
                    wal_head_present = _HEAD in wal_entries
                    if wal_head_present and not wal_record_present:
                        raise Fatal(_E_STATE)
                    if wal_record_present:
                        matched, match_error = _read_matching(fds, wal_fd, wal_record, allocated, uid, device)
                        if match_error is not None or not matched:
                            raise Fatal(_E_DIGEST)
                    if wal_head_present:
                        wal_head = _build_wal_head(1, wal_digest)
                        try:
                            matched, match_error = _read_matching(fds, wal_fd, _HEAD, wal_head, uid, device)
                            if match_error is not None or not matched:
                                raise Fatal(_E_HEAD)
                        finally:
                            _zero(wal_head)
        stages = (
            identity_present,
            ledger_present,
            ledger_record_present,
            ledger_head_present,
            generations_present,
            generation_present,
            wal_present,
            wal_record_present,
            wal_head_present,
        )
        missing = False
        index = 0
        while index < len(stages):
            if not stages[index]:
                missing = True
            elif missing:
                raise Fatal(_E_STATE)
            index += 1
        if not identity_present:
            _publish_record(fds, lifecycle_fd, _IDENTITY, genesis, uid, device)
        else:
            _fsync_named(fds, lifecycle_fd, _IDENTITY, uid, device, len(genesis), len(genesis))
        if not ledger_present:
            ledger_fd, created = _make_dir(fds, lifecycle_fd, _LEDGER, uid, device)
            if not created:
                raise Fatal(_E_UNCERTAIN)
        if not ledger_record_present:
            _publish_record(fds, ledger_fd, ledger_record, genesis, uid, device)
        else:
            _fsync_named(fds, ledger_fd, ledger_record, uid, device, len(genesis), len(genesis))
        if not ledger_head_present:
            ledger_head = _build_ledger_head(0, identity_digest)
            try:
                _publish_head(fds, ledger_fd, _HEAD, ledger_head, uid, device)
            finally:
                _zero(ledger_head)
        else:
            _fsync_named(fds, ledger_fd, _HEAD, uid, device, 48, 48)
        _fsync(ledger_fd)
        fds.close_for_recovery(ledger_fd)
        ledger_fd = None
        if not generations_present:
            generations_fd, created = _make_dir(fds, lifecycle_fd, _GENERATIONS, uid, device)
            if not created:
                raise Fatal(_E_UNCERTAIN)
        if not generation_present:
            generation_fd, created = _make_dir(fds, generations_fd, generation_name, uid, device)
            if not created:
                raise Fatal(_E_UNCERTAIN)
        if not wal_present:
            wal_fd, created = _make_dir(fds, generation_fd, _WAL, uid, device)
            if not created:
                raise Fatal(_E_UNCERTAIN)
        if not wal_record_present:
            _publish_record(fds, wal_fd, wal_record, allocated, uid, device)
        else:
            _fsync_named(fds, wal_fd, wal_record, uid, device, _WAL_SIZE, _WAL_SIZE)
        if not wal_head_present:
            wal_head = _build_wal_head(1, wal_digest)
            try:
                _publish_head(fds, wal_fd, _HEAD, wal_head, uid, device)
            finally:
                _zero(wal_head)
        else:
            _fsync_named(fds, wal_fd, _HEAD, uid, device, 48, 48)
        _fsync(wal_fd)
        fds.close_for_recovery(wal_fd)
        wal_fd = None
        _fsync(generation_fd)
        fds.close_for_recovery(generation_fd)
        generation_fd = None
        _fsync(generations_fd)
        fds.close_for_recovery(generations_fd)
        generations_fd = None
        session_head = _build_session_head(generation, 1, wal_digest, identity_digest)
        try:
            head_entry, head_error = _lstat(lifecycle_fd, _HEAD)
            if head_entry is not None or head_error != errno.ENOENT:
                raise Fatal(_E_UNCERTAIN)
            _publish_head(fds, lifecycle_fd, _HEAD, session_head, uid, device)
        finally:
            _zero(session_head)
        _fsync(lifecycle_fd)
    finally:
        if wal_fd is not None:
            fds.close(wal_fd)
        if generation_fd is not None:
            fds.close(generation_fd)
        if generations_fd is not None:
            fds.close(generations_fd)
        if ledger_fd is not None:
            fds.close(ledger_fd)


def _cmd_create(fds, root_fd, payload, uid, device):
    if len(payload) < 68 + _WAL_SIZE:
        return None, _E_INPUT
    genesis_length = struct.unpack_from(">I", payload, 64)[0]
    if genesis_length < 1 or genesis_length > 16384:
        return None, _E_BOUNDS
    if len(payload) != 68 + genesis_length + _WAL_SIZE:
        return None, _E_INPUT
    lifecycle = memoryview(payload)[0:32]
    generation = memoryview(payload)[32:64]
    genesis = memoryview(payload)[68:68 + genesis_length]
    allocated = memoryview(payload)[68 + genesis_length:]
    identity_digest = _digest(genesis)
    wal_digest = _digest(allocated)
    lifecycle_fd = None
    scan = None
    recovery_expected = list(fds.items)
    try:
        lifecycle_name = _hex_name(lifecycle)
        lifecycle_fd, error = _open_dir(fds, root_fd, lifecycle_name, uid, device)
        if lifecycle_fd is not None:
            fds.begin_recovery()
            existing_entries = _list(lifecycle_fd)
            if _HEAD in existing_entries:
                if _published_create_has_temp(fds, lifecycle_fd, uid, device):
                    raise Fatal(_E_STATE)
                scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
                _close_scan(fds, scan)
                scan = None
                fds.require_certain()
                fds.close_for_recovery(lifecycle_fd)
                lifecycle_fd = None
                fds.end_recovery(recovery_expected)
                return None, _E_EXISTS
            _validate_allocated(allocated, lifecycle, generation, identity_digest)
            _complete_create(
                fds,
                lifecycle_fd,
                lifecycle,
                generation,
                genesis,
                allocated,
                identity_digest,
                wal_digest,
                uid,
                device,
            )
            fds.close_for_recovery(lifecycle_fd)
            lifecycle_fd = None
            fds.end_recovery(recovery_expected)
            return bytearray(wal_digest), None
        if error != errno.ENOENT:
            raise Fatal(_E_UNCERTAIN)
        _validate_allocated(allocated, lifecycle, generation, identity_digest)
        root_entries = _list(root_fd)
        lifecycle_count = 0
        root_index = 0
        while root_index < len(root_entries):
            root_entry = root_entries[root_index]
            if root_entry != _LOCK:
                if not _valid_hex_name(root_entry, 64):
                    raise Fatal(_E_STATE)
                if root_entry == lifecycle_name:
                    raise Fatal(_E_UNCERTAIN)
                lifecycle_count += 1
            root_index += 1
        if lifecycle_count >= 1024:
            return None, _E_BOUNDS
        lifecycle_fd, created = _make_dir(fds, root_fd, lifecycle_name, uid, device)
        if not created:
            raise Fatal(_E_UNCERTAIN)
        fds.begin_recovery()
        _complete_create(
            fds,
            lifecycle_fd,
            lifecycle,
            generation,
            genesis,
            allocated,
            identity_digest,
            wal_digest,
            uid,
            device,
        )
        fds.close_for_recovery(lifecycle_fd)
        lifecycle_fd = None
        fds.end_recovery(recovery_expected)
        return bytearray(wal_digest), None
    finally:
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_fd is not None:
            fds.close(lifecycle_fd)
        _zero(identity_digest)
        _zero(wal_digest)
        lifecycle.release()
        generation.release()
        genesis.release()
        allocated.release()


def _find_generation(generations, generation_name):
    index = 0
    while index < len(generations):
        if generations[index][0] == generation_name:
            return generations[index]
        index += 1
    return None


def _cmd_append_wal(fds, root_fd, payload, uid, device):
    if len(payload) != 32 + 32 + 8 + 32 + _WAL_SIZE:
        return None, _E_INPUT
    lifecycle = memoryview(payload)[0:32]
    generation = memoryview(payload)[32:64]
    expected_revision = struct.unpack_from(">Q", payload, 64)[0]
    expected_digest = memoryview(payload)[72:104]
    record = memoryview(payload)[104:424]
    target_digest = _digest(record)
    lifecycle_fd = None
    scan = None
    response = None
    try:
        if expected_revision == 0xffffffffffffffff:
            return None, _E_BOUNDS
        lifecycle_fd, error, lifecycle_name = _open_lifecycle(fds, root_fd, lifecycle, uid, device)
        if lifecycle_fd is None:
            if error == errno.ENOENT:
                return None, _E_ABSENT
            raise Fatal(_E_UNCERTAIN)
        scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
        identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, session_revision, session_digest = scan
        if not _same(current_generation, generation):
            return None, _E_STATE
        generation_entry = _find_generation(generations, _hex_name(generation))
        if generation_entry is None:
            raise Fatal(_E_STATE)
        wal_fd = generation_entry[2]
        last = generation_entry[4]
        wal_revision = last[0]
        wal_digest = last[3]
        target_revision = expected_revision + 1
        target_state, found_revision = _verify_wal_record(record, lifecycle, generation, target_revision, expected_digest, identity_digest)
        if not _constant_digests_equal(last[2], record) and wal_revision == expected_revision:
            return None, _E_DIGEST
        before = wal_revision == expected_revision and _same(wal_digest, expected_digest) and session_revision == expected_revision and _same(session_digest, expected_digest)
        after = wal_revision == target_revision and _same(wal_digest, target_digest) and session_revision == target_revision and _same(session_digest, target_digest)
        mixed = wal_revision == target_revision and _same(wal_digest, target_digest) and session_revision == expected_revision and _same(session_digest, expected_digest)
        if before:
            old_state, old_revision = _wal_fields(last[2])
            if not _wal_transition(old_state, target_state):
                return None, _E_STATE
            target_name = _record_name(target_revision, target_digest, b".wal")
            _publish_record(fds, wal_fd, target_name, record, uid, device)
            target_head = _build_wal_head(target_revision, target_digest)
            try:
                _publish_head(fds, wal_fd, _HEAD, target_head, uid, device)
            finally:
                _zero(target_head)
            mixed = True
        elif not after and not mixed:
            return None, _E_HEAD
        if mixed:
            target_name = _record_name(target_revision, target_digest, b".wal")
            target_data, target_error = _read_file(fds, wal_fd, target_name, uid, device, _WAL_SIZE, _WAL_SIZE)
            if target_data is None or target_error is not None:
                raise Fatal(_E_UNCERTAIN)
            try:
                actual = _digest(target_data)
                try:
                    if not _same(actual, target_digest):
                        raise Fatal(_E_DIGEST)
                    _verify_wal_record(target_data, lifecycle, generation, target_revision, expected_digest, identity_digest)
                finally:
                    _zero(actual)
            finally:
                _zero(target_data)
            new_session = _build_session_head(generation, target_revision, target_digest, identity_digest)
            try:
                _publish_head(fds, lifecycle_fd, _HEAD, new_session, uid, device)
            finally:
                _zero(new_session)
        target_name = _record_name(target_revision, target_digest, b".wal")
        _fsync_named(fds, wal_fd, target_name, uid, device, _WAL_SIZE, _WAL_SIZE)
        _fsync_named(fds, wal_fd, _HEAD, uid, device, 48, 48)
        _fsync(wal_fd)
        _fsync(generation_entry[1])
        _fsync(generations_fd)
        _fsync_named(fds, lifecycle_fd, _HEAD, uid, device, 112, 112)
        _fsync(lifecycle_fd)
        response = bytearray(target_digest)
        return response, None
    finally:
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_fd is not None:
            fds.close(lifecycle_fd)
        _zero(target_digest)
        lifecycle.release()
        generation.release()
        expected_digest.release()
        record.release()


def _cmd_append_ledger(fds, root_fd, payload, uid, device):
    if len(payload) < 76:
        return None, _E_INPUT
    record_length = struct.unpack_from(">I", payload, 72)[0]
    if record_length < 1 or record_length > 16384:
        return None, _E_BOUNDS
    if len(payload) != 76 + record_length:
        return None, _E_INPUT
    lifecycle = memoryview(payload)[0:32]
    expected_ordinal = struct.unpack_from(">Q", payload, 32)[0]
    expected_digest = memoryview(payload)[40:72]
    record = memoryview(payload)[76:]
    target_digest = _digest(record)
    lifecycle_fd = None
    scan = None
    try:
        if expected_ordinal == 0xffffffffffffffff:
            return None, _E_BOUNDS
        lifecycle_fd, error, lifecycle_name = _open_lifecycle(fds, root_fd, lifecycle, uid, device)
        if lifecycle_fd is None:
            if error == errno.ENOENT:
                return None, _E_ABSENT
            raise Fatal(_E_UNCERTAIN)
        scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
        identity, identity_digest, ledger_fd, rows, total, generations_fd, generations, current_generation, current_revision, current_wal_digest = scan
        target_ordinal = expected_ordinal + 1
        last = rows[-1]
        before = last[0] == expected_ordinal and _same(last[3], expected_digest)
        after = last[0] == target_ordinal and _same(last[3], target_digest)
        if before:
            if len(rows) >= _MAX_LEDGER_RECORDS or total + record_length > _MAX_LEDGER_BYTES:
                return None, _E_BOUNDS
            target_name = _record_name(target_ordinal, target_digest, b".rec")
            _publish_record(fds, ledger_fd, target_name, record, uid, device)
            new_head = _build_ledger_head(target_ordinal, target_digest)
            try:
                _publish_head(fds, ledger_fd, _HEAD, new_head, uid, device)
            finally:
                _zero(new_head)
        elif not after:
            return None, _E_HEAD
        target_name = _record_name(target_ordinal, target_digest, b".rec")
        target_data, target_error = _read_file(fds, ledger_fd, target_name, uid, device, record_length, record_length)
        if target_data is None or target_error is not None:
            raise Fatal(_E_UNCERTAIN)
        actual = _digest(target_data)
        _zero(target_data)
        if not _same(actual, target_digest):
            _zero(actual)
            raise Fatal(_E_DIGEST)
        _zero(actual)
        _fsync_named(fds, ledger_fd, target_name, uid, device, record_length, record_length)
        _fsync_named(fds, ledger_fd, _HEAD, uid, device, 48, 48)
        _fsync(ledger_fd)
        _fsync(lifecycle_fd)
        return bytearray(target_digest), None
    finally:
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_fd is not None:
            fds.close(lifecycle_fd)
        _zero(target_digest)
        lifecycle.release()
        expected_digest.release()
        record.release()


def _cmd_prepare(fds, root_fd, payload, uid, device):
    if len(payload) != 32 + 32 + 32 + 32 + _WAL_SIZE:
        return None, _E_INPUT
    lifecycle = memoryview(payload)[0:32]
    retired_generation = memoryview(payload)[32:64]
    retired_digest = memoryview(payload)[64:96]
    fresh_generation = memoryview(payload)[96:128]
    allocated = memoryview(payload)[128:448]
    fresh_digest = _digest(allocated)
    lifecycle_fd = None
    scan = None
    try:
        if _same(retired_generation, fresh_generation):
            return None, _E_INPUT
        lifecycle_fd, error, lifecycle_name = _open_lifecycle(fds, root_fd, lifecycle, uid, device)
        if lifecycle_fd is None:
            if error == errno.ENOENT:
                return None, _E_ABSENT
            raise Fatal(_E_UNCERTAIN)
        scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
        identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, current_revision, current_wal_digest = scan
        if not _same(current_generation, retired_generation) or not _same(current_wal_digest, retired_digest):
            return None, _E_HEAD
        retired_entry = _find_generation(generations, _hex_name(retired_generation))
        if retired_entry is None:
            raise Fatal(_E_STATE)
        retired_state, retired_revision = _wal_fields(retired_entry[4][2])
        if retired_state != _W_RETIRED_ABSENT or retired_revision != 3:
            return None, _E_STATE
        _validate_allocated(allocated, lifecycle, fresh_generation, identity_digest)
        if not _constant_digests_equal(retired_entry[4][2], allocated):
            return None, _E_DIGEST
        fresh_name = _hex_name(fresh_generation)
        fresh_entry = _find_generation(generations, fresh_name)
        if fresh_entry is not None:
            fresh_state, fresh_revision = _wal_fields(fresh_entry[4][2])
            if fresh_state != _W_ALLOCATED or fresh_revision != 1 or not _same(fresh_entry[4][3], fresh_digest):
                return None, _E_STATE
            _fsync_named(fds, fresh_entry[2], fresh_entry[4][1], uid, device, _WAL_SIZE, _WAL_SIZE)
            _fsync_named(fds, fresh_entry[2], _HEAD, uid, device, 48, 48)
            _fsync(fresh_entry[2])
            _fsync(fresh_entry[1])
            _fsync(generations_fd)
            _fsync(lifecycle_fd)
            return bytearray(fresh_digest), None
        if len(generations) >= _MAX_GENERATIONS:
            return None, _E_BOUNDS
        fresh_fd, created_fresh = _make_dir(fds, generations_fd, fresh_name, uid, device)
        fresh_entries = _list(fresh_fd)
        index = 0
        while index < len(fresh_entries):
            if fresh_entries[index] != _WAL:
                raise Fatal(_E_STATE)
            index += 1
        fresh_wal_fd, created_wal = _make_dir(fds, fresh_fd, _WAL, uid, device)
        fresh_wal_entries = _list(fresh_wal_fd)
        index = 0
        while index < len(fresh_wal_entries):
            candidate = fresh_wal_entries[index]
            if candidate != _HEAD and candidate != _record_name(1, fresh_digest, b".wal") and not candidate.startswith(b".tmp."):
                raise Fatal(_E_STATE)
            index += 1
        fresh_record_name = _record_name(1, fresh_digest, b".wal")
        _publish_record(fds, fresh_wal_fd, fresh_record_name, allocated, uid, device)
        existing_head, existing_error = _read_head(fds, fresh_wal_fd, _HEAD, _WAL_HEAD_MAGIC, 48, uid, device)
        if existing_head is None:
            if existing_error != errno.ENOENT:
                raise Fatal(_E_STATE)
            fresh_head = _build_wal_head(1, fresh_digest)
            try:
                _publish_head(fds, fresh_wal_fd, _HEAD, fresh_head, uid, device)
            finally:
                _zero(fresh_head)
        else:
            head_revision, head_digest = _parse_head(existing_head, _WAL_HEAD_MAGIC)
            _zero(existing_head)
            if head_revision != 1 or not _same(head_digest, fresh_digest):
                _zero(head_digest)
                return None, _E_STATE
            _zero(head_digest)
        _fsync_named(fds, fresh_wal_fd, fresh_record_name, uid, device, _WAL_SIZE, _WAL_SIZE)
        _fsync_named(fds, fresh_wal_fd, _HEAD, uid, device, 48, 48)
        _fsync(fresh_wal_fd)
        fds.close_for_recovery(fresh_wal_fd)
        _fsync(fresh_fd)
        fds.close_for_recovery(fresh_fd)
        _fsync(generations_fd)
        _fsync(lifecycle_fd)
        return bytearray(fresh_digest), None
    finally:
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_fd is not None:
            fds.close(lifecycle_fd)
        _zero(fresh_digest)
        lifecycle.release()
        retired_generation.release()
        retired_digest.release()
        fresh_generation.release()
        allocated.release()


def _cmd_switch(fds, root_fd, payload, uid, device):
    if len(payload) != 160:
        return None, _E_INPUT
    lifecycle = memoryview(payload)[0:32]
    retired_generation = memoryview(payload)[32:64]
    retired_digest = memoryview(payload)[64:96]
    fresh_generation = memoryview(payload)[96:128]
    fresh_digest = memoryview(payload)[128:160]
    lifecycle_fd = None
    scan = None
    try:
        lifecycle_fd, error, lifecycle_name = _open_lifecycle(fds, root_fd, lifecycle, uid, device)
        if lifecycle_fd is None:
            if error == errno.ENOENT:
                return None, _E_ABSENT
            raise Fatal(_E_UNCERTAIN)
        scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
        identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, current_revision, current_wal_digest = scan
        fresh_entry = _find_generation(generations, _hex_name(fresh_generation))
        retired_entry = _find_generation(generations, _hex_name(retired_generation))
        if fresh_entry is None or retired_entry is None:
            return None, _E_STATE
        fresh_state, fresh_revision = _wal_fields(fresh_entry[4][2])
        retired_state, retired_revision = _wal_fields(retired_entry[4][2])
        if fresh_state != _W_ALLOCATED or fresh_revision != 1 or retired_state != _W_RETIRED_ABSENT or retired_revision != 3:
            return None, _E_STATE
        if not _same(fresh_entry[4][3], fresh_digest) or not _same(retired_entry[4][3], retired_digest):
            return None, _E_DIGEST
        before = _same(current_generation, retired_generation) and _same(current_wal_digest, retired_digest)
        after = _same(current_generation, fresh_generation) and _same(current_wal_digest, fresh_digest)
        if not before and not after:
            return None, _E_HEAD
        _fsync_named(fds, fresh_entry[2], fresh_entry[4][1], uid, device, _WAL_SIZE, _WAL_SIZE)
        _fsync_named(fds, fresh_entry[2], _HEAD, uid, device, 48, 48)
        _fsync(fresh_entry[2])
        _fsync(fresh_entry[1])
        _fsync(generations_fd)
        if before:
            new_session = _build_session_head(fresh_generation, 1, fresh_digest, identity_digest)
            try:
                _publish_head(fds, lifecycle_fd, _HEAD, new_session, uid, device)
            finally:
                _zero(new_session)
        _fsync_named(fds, lifecycle_fd, _HEAD, uid, device, 112, 112)
        _fsync(lifecycle_fd)
        return bytearray(fresh_digest), None
    finally:
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_fd is not None:
            fds.close(lifecycle_fd)
        lifecycle.release()
        retired_generation.release()
        retired_digest.release()
        fresh_generation.release()
        fresh_digest.release()


def _cmd_remove(fds, root_fd, payload, uid, device):
    if len(payload) != 96:
        return None, _E_INPUT
    lifecycle = memoryview(payload)[0:32]
    retired_generation = memoryview(payload)[32:64]
    retired_digest = memoryview(payload)[64:96]
    lifecycle_fd = None
    scan = None
    try:
        lifecycle_fd, error, lifecycle_name = _open_lifecycle(fds, root_fd, lifecycle, uid, device)
        if lifecycle_fd is None:
            if error == errno.ENOENT:
                return None, _E_ABSENT
            raise Fatal(_E_UNCERTAIN)
        scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
        identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, current_revision, current_wal_digest = scan
        if _same(current_generation, retired_generation):
            return None, _E_STATE
        retired_name = _hex_name(retired_generation)
        retired_entry = _find_generation(generations, retired_name)
        if retired_entry is None:
            return None, None
        retired_state, retired_revision = _wal_fields(retired_entry[4][2])
        if retired_state != _W_RETIRED_ABSENT or retired_revision != 3:
            return None, _E_STATE
        if not _same(retired_entry[4][3], retired_digest):
            return None, _E_DIGEST
        current_entry = _find_generation(generations, _hex_name(current_generation))
        if current_entry is None or current_entry[4] is None:
            raise Fatal(_E_HEAD)
        retired_wal_fd = retired_entry[2]
        retired_generation_fd = retired_entry[1]
        fds.close_for_recovery(retired_wal_fd)
        fds.close_for_recovery(retired_generation_fd)
        _zero_record_rows(retired_entry[3])
        generations.remove(retired_entry)
        _remove_generation_suffix(
            fds, generations_fd, retired_name, lifecycle, uid, device, True, identity_digest, current_entry[4][2]
        )
        _fsync(generations_fd)
        _fsync(lifecycle_fd)
        return None, None
    finally:
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_fd is not None:
            fds.close(lifecycle_fd)
        lifecycle.release()
        retired_generation.release()
        retired_digest.release()


def _remove_older_records(parent, rows, terminal_name):
    index = 0
    while index < len(rows):
        name = rows[index][1]
        if name != terminal_name:
            _unlink(parent, name)
        index += 1
    _fsync(parent)


def _probe_absent(parent, name):
    st, error = _lstat(parent, name)
    if st is None and error == errno.ENOENT:
        return
    raise Fatal(_E_UNCERTAIN)


def _cmd_purge(fds, root_fd, payload, uid, device):
    if len(payload) != 160:
        return None, _E_INPUT
    lifecycle = memoryview(payload)[0:32]
    current_generation_arg = memoryview(payload)[32:64]
    absent_digest = memoryview(payload)[64:96]
    deleted_digest = memoryview(payload)[96:128]
    identity_digest_arg = memoryview(payload)[128:160]
    lifecycle_fd = None
    scan = None
    lifecycle_name = _hex_name(lifecycle)
    try:
        lifecycle_fd, error, unused_name = _open_lifecycle(fds, root_fd, lifecycle, uid, device)
        if lifecycle_fd is None:
            if error == errno.ENOENT:
                return None, None
            raise Fatal(_E_UNCERTAIN)
        scan = _scan_lifecycle(fds, lifecycle_fd, lifecycle, uid, device, False)
        identity, identity_digest, ledger_fd, ledger_rows, ledger_total, generations_fd, generations, current_generation, current_revision, current_wal_digest = scan
        if len(generations) != 1:
            return None, _E_STATE
        if not _same(current_generation, current_generation_arg) or not _same(current_wal_digest, absent_digest) or not _same(identity_digest, identity_digest_arg):
            return None, _E_DIGEST
        generation = generations[0]
        terminal = generation[4]
        state_value, terminal_revision = _wal_fields(terminal[2])
        if state_value != _W_ABSENT:
            return None, _E_STATE
        ledger_terminal = ledger_rows[-1]
        if not _same(ledger_terminal[3], deleted_digest):
            return None, _E_DIGEST
        wal_fd = generation[2]
        generation_fd = generation[1]
        wal_terminal_name = terminal[1]
        ledger_terminal_name = ledger_terminal[1]
        _remove_older_records(wal_fd, generation[3], wal_terminal_name)
        _remove_older_records(ledger_fd, ledger_rows, ledger_terminal_name)
        _unlink(wal_fd, _HEAD)
        _fsync(wal_fd)
        _unlink(wal_fd, wal_terminal_name)
        _fsync(wal_fd)
        _zero_record_rows(generation[3])
        generation[3].clear()
        fds.close_for_recovery(wal_fd)
        _rmdir(generation_fd, _WAL)
        _fsync(generation_fd)
        fds.close_for_recovery(generation_fd)
        _rmdir(generations_fd, generation[0])
        _fsync(generations_fd)
        fds.close_for_recovery(generations_fd)
        _rmdir(lifecycle_fd, _GENERATIONS)
        _fsync(lifecycle_fd)
        _unlink(ledger_fd, _HEAD)
        _fsync(ledger_fd)
        _unlink(ledger_fd, ledger_terminal_name)
        _fsync(ledger_fd)
        _zero_record_rows(ledger_rows)
        ledger_rows.clear()
        fds.close_for_recovery(ledger_fd)
        _rmdir(lifecycle_fd, _LEDGER)
        _fsync(lifecycle_fd)
        _unlink(lifecycle_fd, _HEAD)
        _fsync(lifecycle_fd)
        _unlink(lifecycle_fd, _IDENTITY)
        _fsync(lifecycle_fd)
        _zero(identity)
        _zero(identity_digest)
        _zero(current_generation)
        _zero(current_wal_digest)
        scan = None
        fds.close_for_recovery(lifecycle_fd)
        lifecycle_fd = None
        _rmdir(root_fd, lifecycle_name)
        _fsync(root_fd)
        _probe_absent(root_fd, lifecycle_name)
        return None, None
    finally:
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_fd is not None:
            fds.close(lifecycle_fd)
        lifecycle.release()
        current_generation_arg.release()
        absent_digest.release()
        deleted_digest.release()
        identity_digest_arg.release()


def _dispatch_v4(fds, root_fd, uid, device, root_inode, lock_fd, lock_device, lock_inode, opcode, payload):
    if opcode == _INVENTORY:
        if len(payload) != 0:
            return "error", _E_INPUT
        _cmd_inventory(fds, root_fd, uid, device, 1, root_inode, lock_fd, lock_device, lock_inode)
        return "emitted", None
    if opcode == _INSPECT:
        result, error = _cmd_inspect(fds, root_fd, payload, uid, device)
        if error is not None:
            return "error", error
        return "session", result
    if opcode == _CREATE:
        result, error = _cmd_create(fds, root_fd, payload, uid, device)
    elif opcode == _APPEND_WAL:
        result, error = _cmd_append_wal(fds, root_fd, payload, uid, device)
    elif opcode == _APPEND_LEDGER:
        result, error = _cmd_append_ledger(fds, root_fd, payload, uid, device)
    elif opcode == _PREPARE:
        result, error = _cmd_prepare(fds, root_fd, payload, uid, device)
    elif opcode == _SWITCH:
        result, error = _cmd_switch(fds, root_fd, payload, uid, device)
    elif opcode == _REMOVE:
        result, error = _cmd_remove(fds, root_fd, payload, uid, device)
    elif opcode == _PURGE:
        result, error = _cmd_purge(fds, root_fd, payload, uid, device)
    else:
        raise Fatal(_E_PROTOCOL)
    if error is not None:
        if error in (_E_INPUT, _E_BOUNDS, _E_ABSENT, _E_EXISTS, _E_BUSY):
            return "error", error
        raise Fatal(error)
    return "ok", result


def _v5_validate_inventory_name(parent, name, expected, uid, device, size):
    found, error = _lstat(parent, name)
    if found is None or error is not None:
        raise Fatal(_E_UNCERTAIN)
    _validate_file_stat(found, uid, device)
    if not _v5_same_inode(found, expected) or found.st_size != size:
        raise Fatal(_E_UNCERTAIN)


def _v5_collect_draft_transaction(fds, generation_fd, lifecycle, generation, uid, device):
    mark = fds.mark()
    evidence_fd = None
    plan_fd = None
    content_fd = None
    manifest_fd = None
    plan_data = None
    content_data = None
    manifest_data = None
    plan_suffix = None
    content_suffix = None
    result = None
    complete = False
    try:
        evidence_fd, error = _open_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)
        if evidence_fd is None:
            if error == errno.ENOENT:
                complete = True
                return None, 0
            raise Fatal(_E_UNCERTAIN)
        entries = _list(evidence_fd)
        if len(entries) != 3 or _INPUT_MANIFEST not in entries:
            raise Fatal(_E_STATE)
        plan_name = None
        content_name = None
        index = 0
        while index < len(entries):
            entry = entries[index]
            if entry.startswith(_PLAN_DRAFT_PREFIX):
                suffix = _v5_random_suffix(entry, _PLAN_DRAFT_PREFIX)
                if suffix is None or plan_name is not None:
                    if suffix is not None:
                        _zero(suffix)
                    raise Fatal(_E_STATE)
                plan_name = entry
                plan_suffix = suffix
            elif entry.startswith(_CONTENT_DRAFT_PREFIX):
                suffix = _v5_random_suffix(entry, _CONTENT_DRAFT_PREFIX)
                if suffix is None or content_name is not None:
                    if suffix is not None:
                        _zero(suffix)
                    raise Fatal(_E_STATE)
                content_name = entry
                content_suffix = suffix
            elif entry != _INPUT_MANIFEST:
                raise Fatal(_E_STATE)
            index += 1
        if plan_name is None or content_name is None or plan_suffix is None or content_suffix is None:
            raise Fatal(_E_STATE)
        if _same(plan_suffix, content_suffix):
            raise Fatal(_E_STATE)
        plan_fd, plan_error = _open_file(
            fds, evidence_fd, plan_name, uid, device, _PLAN_HEADER_SIZE, _PLAN_HEADER_SIZE
        )
        content_fd, content_error = _open_file(
            fds,
            evidence_fd,
            content_name,
            uid,
            device,
            _CONTENT_HEADER_SIZE,
            _CONTENT_HEADER_SIZE,
        )
        manifest_fd, manifest_error = _open_file(
            fds,
            evidence_fd,
            _INPUT_MANIFEST,
            uid,
            device,
            _INPUT_MANIFEST_SIZE,
            _INPUT_MANIFEST_SIZE,
        )
        if plan_fd is None or content_fd is None or manifest_fd is None:
            raise Fatal(_E_UNCERTAIN)
        if plan_error is not None or content_error is not None or manifest_error is not None:
            raise Fatal(_E_UNCERTAIN)
        plan_stat = _fstat(plan_fd)
        content_stat = _fstat(content_fd)
        manifest_stat = _fstat(manifest_fd)
        _validate_file_stat(plan_stat, uid, device)
        _validate_file_stat(content_stat, uid, device)
        _validate_file_stat(manifest_stat, uid, device)
        if _v5_same_inode(plan_stat, content_stat) or _v5_same_inode(plan_stat, manifest_stat) or _v5_same_inode(content_stat, manifest_stat):
            raise Fatal(_E_IO)
        plan_data = _v5_read_open_file(plan_fd, _PLAN_HEADER_SIZE)
        content_data = _v5_read_open_file(content_fd, _CONTENT_HEADER_SIZE)
        manifest_data = _v5_read_open_file(manifest_fd, _INPUT_MANIFEST_SIZE)
        plan_valid, plan_complete, plan_length = _v5_header_prefix(
            plan_data, _PLAN_RECORD_MAGIC, 4, 1, _MAX_PLAN_PAYLOAD
        )
        content_valid, content_complete, content_length = _v5_header_prefix(
            content_data, _CONTENT_RECORD_MAGIC, 8, 0, _MAX_CONTENT_PAYLOAD
        )
        if not plan_valid or not plan_complete or not content_valid or not content_complete:
            raise Fatal(_E_STATE)
        if not _v5_input_manifest_prefix(
            manifest_data,
            lifecycle,
            generation,
            plan_suffix,
            content_suffix,
            plan_length,
            content_length,
        ):
            raise Fatal(_E_STATE)
        allocated = plan_stat.st_size + content_stat.st_size + manifest_stat.st_size
        if allocated > _V5_ITEM_RESERVATION:
            raise Fatal(_E_IO)
        result = bytearray(_WS_TRANSACTION_SIZE)
        result[0:32] = lifecycle
        result[32:64] = generation
        result[64:96] = manifest_data[80:112]
        result[96:128] = manifest_data[112:144]
        result[128:160] = manifest_data[144:176]
        result[160:164] = plan_data[8:12]
        result[164:172] = content_data[8:16]
        result[180:188] = manifest_data[252:260]
        result[188:196] = manifest_data[260:268]
        result[204:212] = manifest_data[8:16]
        result[216:224] = b"\xff" * 8
        result[384:392] = b"\xff" * 8
        struct.pack_into(">Q", result, 392, _V5_ITEM_RESERVATION)
        result[400] = 1
        _v5_validate_inventory_name(
            evidence_fd, plan_name, plan_stat, uid, device, _PLAN_HEADER_SIZE
        )
        _v5_validate_inventory_name(
            evidence_fd, content_name, content_stat, uid, device, _CONTENT_HEADER_SIZE
        )
        _v5_validate_inventory_name(
            evidence_fd, _INPUT_MANIFEST, manifest_stat, uid, device, _INPUT_MANIFEST_SIZE
        )
        final_entries = _list(evidence_fd)
        if final_entries != entries:
            raise Fatal(_E_UNCERTAIN)
        complete = True
        return result, allocated
    finally:
        if manifest_data is not None:
            _zero(manifest_data)
        if content_data is not None:
            _zero(content_data)
        if plan_data is not None:
            _zero(plan_data)
        if content_suffix is not None:
            _zero(content_suffix)
        if plan_suffix is not None:
            _zero(plan_suffix)
        if manifest_fd is not None:
            fds.close(manifest_fd)
        if content_fd is not None:
            fds.close(content_fd)
        if plan_fd is not None:
            fds.close(plan_fd)
        if evidence_fd is not None:
            fds.close(evidence_fd)
        fds.close_after(mark)
        if fds.mark() != mark or fds.uncertain:
            complete = False
        if not complete and result is not None:
            _zero(result)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _v5_zero_transactions(items):
    index = 0
    while index < len(items):
        _zero(items[index])
        index += 1


def _v5_collect_inventory(
    fds, root_fd, uid, device, root_inode, lock_fd, lock_device, lock_inode
):
    mark = fds.mark()
    items = []
    outstanding = 0
    complete = False
    try:
        _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
        entries = _list(root_fd)
        lifecycle_count = 0
        index = 0
        while index < len(entries):
            name = entries[index]
            index += 1
            if name == _LOCK:
                continue
            if not _valid_hex_name(name, 64):
                raise Fatal(_E_STATE)
            lifecycle_count += 1
            if lifecycle_count > 1024:
                raise Fatal(_E_BOUNDS)
            lifecycle_fd = None
            lifecycle = None
            scan = None
            try:
                lifecycle_fd, lifecycle_error = _open_dir(fds, root_fd, name, uid, device)
                if lifecycle_fd is None or lifecycle_error is not None:
                    raise Fatal(_E_UNCERTAIN)
                lifecycle = bytearray.fromhex(name.decode("ascii"))
                scan = _scan_lifecycle(
                    fds,
                    lifecycle_fd,
                    lifecycle,
                    uid,
                    device,
                    False,
                    allow_v5_evidence=True,
                )
                current_name = _hex_name(scan[7])
                current = _find_generation(scan[6], current_name)
                if current is None:
                    raise Fatal(_E_STATE)
                generation_index = 0
                while generation_index < len(scan[6]):
                    generation = scan[6][generation_index]
                    generation_entries = _list(generation[1])
                    if _WORKSPACE_EVIDENCE in generation_entries and generation[0] != current_name:
                        raise Fatal(_E_STATE)
                    generation_index += 1
                item, allocated = _v5_collect_draft_transaction(
                    fds, current[1], lifecycle, scan[7], uid, device
                )
                if item is not None:
                    items.append(item)
                    if len(items) > _MAX_V5_ITEMS:
                        raise Fatal(_E_IO)
                    if allocated > _V5_ITEM_RESERVATION:
                        raise Fatal(_E_IO)
                    outstanding += _V5_ITEM_RESERVATION - allocated
                    if len(items) * _V5_ITEM_RESERVATION > _V5_GLOBAL_RESERVATION:
                        raise Fatal(_E_IO)
                    if outstanding > _V5_GLOBAL_RESERVATION:
                        raise Fatal(_E_IO)
            finally:
                if scan is not None:
                    _close_scan(fds, scan)
                if lifecycle is not None:
                    _zero(lifecycle)
                if lifecycle_fd is not None:
                    fds.close(lifecycle_fd)
                if fds.uncertain:
                    raise Fatal(_E_UNCERTAIN)
        _root_check(root_fd, device, root_inode, uid, lock_fd, lock_device, lock_inode)
        complete = True
        return items, outstanding
    finally:
        fds.close_after(mark)
        if fds.mark() != mark or fds.uncertain:
            complete = False
        if not complete:
            _v5_zero_transactions(items)
        if fds.uncertain:
            raise Fatal(_E_UNCERTAIN)


def _cmd_v5_inventory(
    fds, root_fd, uid, device, root_inode, lock_fd, lock_device, lock_inode
):
    items = None
    try:
        items, unused_outstanding = _v5_collect_inventory(
            fds, root_fd, uid, device, root_inode, lock_fd, lock_device, lock_inode
        )
        index = 0
        while index < len(items):
            _write_frame(1, _WS_TRANSACTION, items[index])
            index += 1
    finally:
        if items is not None:
            _v5_zero_transactions(items)


def _v5_validate_request(opcode, payload):
    if opcode == _WS_INVENTORY:
        if len(payload) != 0:
            raise Fatal(_E_PROTOCOL)
        return None
    if opcode == _WS_BEGIN:
        if len(payload) != 172:
            return _E_INPUT
        plan_payload_len = struct.unpack_from(">I", payload, 160)[0]
        content_len = struct.unpack_from(">Q", payload, 164)[0]
        if plan_payload_len < 1 or plan_payload_len > 1048576:
            return _E_BOUNDS
        if content_len > 1073741824:
            return _E_BOUNDS
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_WRITE_STREAM:
        if len(payload) < 169:
            return _E_INPUT
        if len(payload) == 169:
            return _E_BOUNDS
        if len(payload) > 1048576:
            return _E_BOUNDS
        stream_kind = payload[128]
        if stream_kind not in (1, 2, 3):
            return _E_INPUT
        data_len = len(payload) - 169
        if data_len < 1 or data_len > 1048407:
            return _E_BOUNDS
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        data_view = memoryview(payload)[169:]
        try:
            computed = _digest(data_view)
        finally:
            data_view.release()
        try:
            if not _same_at(payload, 137, computed):
                return _E_INPUT
        finally:
            _zero(computed)
        return None
    if opcode == _WS_ABORT_DRAFT:
        if len(payload) != 137:
            return _E_INPUT
        stream_kind = payload[128]
        if stream_kind not in (1, 3):
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_SEAL_INPUTS:
        if len(payload) != 192:
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_MARK_START_DISPATCHED:
        if len(payload) != 168:
            raise Fatal(_E_PROTOCOL)
        if _range_zero(payload, 96, 128):
            raise Fatal(_E_PROTOCOL)
        return None
    if opcode == _WS_BEGIN_VECTOR:
        if len(payload) != 201:
            return _E_INPUT
        decision_kind = payload[128]
        if decision_kind not in (2, 3):
            return _E_INPUT
        vector_len = struct.unpack_from(">I", payload, 129)[0]
        if vector_len > 32763:
            return _E_BOUNDS
        terminal_revision = struct.unpack_from(">I", payload, 133)[0]
        expected_terminal = 0 if vector_len == 0 else vector_len - 1
        if terminal_revision != expected_terminal:
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_SEAL_VECTOR:
        if len(payload) != 200:
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_CONSUME_ATTEMPT:
        if len(payload) != 307:
            return _E_INPUT
        phase = payload[208]
        if phase < 1 or phase > 5:
            return _E_INPUT
        decision_kind = payload[209]
        if decision_kind not in (2, 3):
            return _E_INPUT
        if phase in (1, 2, 3) and decision_kind != 2:
            return _E_INPUT
        if phase in (4, 5) and decision_kind != 3:
            return _E_INPUT
        plan_present = payload[210]
        if plan_present not in (0, 1):
            return _E_INPUT
        if phase in (1, 2, 3, 5) and plan_present != 0:
            return _E_INPUT
        if phase == 1:
            if not _range_zero(payload, 211, 243):
                return _E_INPUT
        elif phase in (2, 3):
            if _range_zero(payload, 211, 243):
                return _E_INPUT
        elif phase in (4, 5):
            if not _range_zero(payload, 211, 243):
                return _E_INPUT
        attempt_ordinal = struct.unpack_from(">Q", payload, 168)[0]
        if attempt_ordinal < 1 or attempt_ordinal > 1024:
            return _E_BOUNDS
        if _range_zero(payload, 176, 208):
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_RECORD_RESULT:
        if len(payload) != 173:
            return _E_INPUT
        result_kind = payload[172]
        if result_kind not in (1, 2):
            return _E_INPUT
        dispatch_ordinal = struct.unpack_from(">I", payload, 168)[0]
        if dispatch_ordinal < 1 or dispatch_ordinal > 1024:
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_INSPECT:
        if len(payload) != 128:
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_ACK_RESULT:
        if len(payload) != 169:
            return _E_INPUT
        result_kind = payload[168]
        if result_kind not in (1, 2):
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_ACK_AND_PURGE:
        if len(payload) != 168:
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    if opcode == _WS_READ:
        if len(payload) != 173:
            return _E_INPUT
        record_kind = payload[128]
        if record_kind not in (1, 2, 3):
            return _E_INPUT
        requested_len = struct.unpack_from(">I", payload, 137)[0]
        if requested_len < 1 or requested_len > 1048562:
            return _E_BOUNDS
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None
    raise Fatal(_E_PROTOCOL)


def _v5_handle_hello(fds, root_fd, uid, root_device, root_inode, lock_fd, lock_device, lock_inode, payload):
    if len(payload) != 8 or payload != b"PISTOV05":
        return (_MODE_UNSELECTED, "error", _E_PROTOCOL)
    _recover_root(
        fds,
        root_fd,
        uid,
        root_device,
        root_inode,
        lock_fd,
        lock_device,
        lock_inode,
        recover_v5_evidence=True,
    )
    items = None
    try:
        items, reconstructed = _v5_collect_inventory(
            fds,
            root_fd,
            uid,
            root_device,
            root_inode,
            lock_fd,
            lock_device,
            lock_inode,
        )
        if len(items) > _MAX_V5_ITEMS or reconstructed > _V5_GLOBAL_RESERVATION:
            raise Fatal(_E_IO)
    finally:
        if items is not None:
            _v5_zero_transactions(items)
    _root_check(root_fd, root_device, root_inode, uid, lock_fd, lock_device, lock_inode)
    if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:
        raise Fatal(_E_UNCERTAIN)
    return (_MODE_V5_READY, "v5_ready", None)


def _dispatch_v5(
    fds,
    root_fd,
    uid,
    device,
    root_inode,
    lock_fd,
    lock_device,
    lock_inode,
    opcode,
    payload,
    v5_mode,
):
    if opcode == _V5_HELLO:
        return (v5_mode, "error", _E_PROTOCOL)
    err = _v5_validate_request(opcode, payload)
    if err is not None:
        return (v5_mode, "error", err)
    if opcode == _WS_INVENTORY:
        _cmd_v5_inventory(
            fds,
            root_fd,
            uid,
            device,
            root_inode,
            lock_fd,
            lock_device,
            lock_inode,
        )
        return (v5_mode, "done", None)
    if opcode == _WS_BEGIN:
        return (v5_mode, "error", _E_BUSY)
    return (v5_mode, "error", _E_ABSENT)


def main():
    fds = Fds()
    root_fd = None
    lock_fd = None
    root_device = None
    root_inode = None
    lock_device = None
    lock_inode = None
    uid = None
    opened = False
    current_opcode = 0
    exit_code = 2
    v5_mode = _MODE_UNSELECTED
    v5_tree_present = False
    try:
        while True:
            current_opcode = 0
            header = _read_exact(0, _HEADER)
            try:
                current_opcode = header[0]
                payload_length = struct.unpack_from(">I", header, 1)[0]
            finally:
                _zero(header)
            if payload_length > _MAX_PAYLOAD:
                raise Fatal(_E_BOUNDS)
            payload = _read_exact(0, payload_length)
            response = None
            kind = None
            value = None
            try:
                if not opened:
                    if current_opcode != _OPEN or payload_length != 0:
                        raise Fatal(_E_PROTOCOL)
                    root_fd, root_device, root_inode, uid = _bind_root(fds)
                    lock_fd, lock_device, lock_inode, open_error = _bind_lock(fds, root_fd, uid, root_device)
                    if open_error == _E_BUSY:
                        fds.close(root_fd)
                        root_fd = None
                        if fds.uncertain:
                            raise Fatal(_E_UNCERTAIN)
                        response = _error_payload(_OPEN, _E_BUSY)
                        _write_frame(1, _ERROR, response)
                        continue
                    v5_tree_present = _recover_root(
                        fds, root_fd, uid, root_device, root_inode, lock_fd, lock_device, lock_inode
                    )
                    _root_check(root_fd, root_device, root_inode, uid, lock_fd, lock_device, lock_inode)
                    if fds.uncertain or fds.recovering or fds.items != [root_fd, lock_fd]:
                        raise Fatal(_E_UNCERTAIN)
                    opened = True
                    response = _ok_payload(_OPEN)
                    _write_frame(1, _OK, response)
                    continue
                _root_check(root_fd, root_device, root_inode, uid, lock_fd, lock_device, lock_inode)
                if current_opcode == _OPEN:
                    raise Fatal(_E_PROTOCOL)
                if current_opcode == _QUIT:
                    if payload_length != 0:
                        raise Fatal(_E_PROTOCOL)
                    _fsync(root_fd)
                    command_mark = fds.mark()
                    if command_mark != 2:
                        raise Fatal(_E_UNCERTAIN)
                    response = _ok_payload(_QUIT)
                    _write_frame(1, _OK, response)
                    fds.close(lock_fd)
                    lock_fd = None
                    fds.close(root_fd)
                    root_fd = None
                    if fds.uncertain or len(fds.items) != 0:
                        exit_code = 2
                    else:
                        exit_code = 0
                    break
                command_mark = fds.mark()
                try:
                    next_mode = None
                    kind = None
                    value = None
                    if v5_mode == _MODE_UNSELECTED:
                        if current_opcode == _V5_HELLO:
                            next_mode, kind, value = _v5_handle_hello(fds, root_fd, uid, root_device, root_inode, lock_fd, lock_device, lock_inode, payload)
                        elif current_opcode in _V5_OPCODES:
                            raise Fatal(_E_PROTOCOL)
                        elif v5_tree_present:
                            kind = "error"
                            value = _E_PROTOCOL
                            next_mode = _MODE_V5_BLOCKED
                        else:
                            kind, value = _dispatch_v4(fds, root_fd, uid, root_device, root_inode, lock_fd, lock_device, lock_inode, current_opcode, payload)
                            next_mode = _MODE_V4_COMPAT
                    elif v5_mode == _MODE_V4_COMPAT:
                        if current_opcode in _V5_OPCODES:
                            raise Fatal(_E_PROTOCOL)
                        kind, value = _dispatch_v4(fds, root_fd, uid, root_device, root_inode, lock_fd, lock_device, lock_inode, current_opcode, payload)
                    elif v5_mode == _MODE_V5_BLOCKED:
                        if current_opcode != _V5_HELLO:
                            raise Fatal(_E_PROTOCOL)
                        next_mode = _MODE_V5_BLOCKED
                        kind = "error"
                        value = _E_PROTOCOL
                    elif v5_mode == _MODE_V5_READY:
                        if current_opcode not in _V5_OPCODES:
                            raise Fatal(_E_PROTOCOL)
                        next_mode, kind, value = _dispatch_v5(
                            fds,
                            root_fd,
                            uid,
                            root_device,
                            root_inode,
                            lock_fd,
                            lock_device,
                            lock_inode,
                            current_opcode,
                            payload,
                            v5_mode,
                        )
                    else:
                        raise Fatal(_E_PROTOCOL)
                except Fatal:
                    fds.close_after(command_mark)
                    if fds.uncertain:
                        raise Fatal(_E_UNCERTAIN)
                    raise
                fds.close_after(command_mark)
                if fds.mark() != command_mark or fds.uncertain:
                    raise Fatal(_E_UNCERTAIN)
                _root_check(root_fd, root_device, root_inode, uid, lock_fd, lock_device, lock_inode)
                if next_mode is not None:
                    v5_mode = next_mode
                if kind == "error":
                    response = _error_payload(current_opcode, value)
                    _write_frame(1, _ERROR, response)
                elif kind == "ok":
                    try:
                        response = _ok_payload(current_opcode, value)
                    finally:
                        if value is not None:
                            _zero(value)
                            value = None
                    _write_frame(1, _OK, response)
                elif kind == "session":
                    try:
                        _write_frame(1, _SESSION, value)
                    finally:
                        _zero(value)
                        value = None
                    _write_frame(1, _DONE, bytearray())
                elif kind == "v5_ready":
                    response = bytearray(9)
                    response[0] = _V5_HELLO
                    response[1:9] = b"PISTOV05"
                    _write_frame(1, _V5_READY, response)
                elif kind == "done":
                    response = bytearray()
                    _write_frame(1, _DONE, response)
                elif kind != "emitted":
                    raise Fatal(_E_PROTOCOL)
            finally:
                if kind in ("ok", "session") and value is not None:
                    _zero(value)
                if response is not None:
                    _zero(response)
                _zero(payload)
        fds.close_all()
    except Fatal as fatal:
        try:
            if current_opcode != 0:
                fixed = _error_payload(current_opcode, fatal.code)
                try:
                    _write_frame(1, _ERROR, fixed)
                finally:
                    _zero(fixed)
        except Fatal:
            exit_code = 2
        fds.close_all()
        exit_code = 2
    except BaseException:
        fds.close_all()
        exit_code = 2
    if fds.uncertain:
        exit_code = 2
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
