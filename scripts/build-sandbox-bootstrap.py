#!/usr/bin/env python3
"""Deterministic minimal bootstrap zipapp builder.

Packages exactly seven sorted .py source entries (ZIP_STORED).
Sources read as raw binary via O_RDONLY|O_NOFOLLOW in <=64 KiB chunks
with pre/post fstat identity validation.  Decode to UTF-8 only for
compile() syntax validation.  Package original bytes unchanged.
Output created via held parent-directory fd (dir_fd) for atomicity.
All fds closed and claimed output cleaned up in a single finally block.
"""
from __future__ import annotations
import os
import stat
import sys
import zipfile

_MAIN_SOURCE: str = (
    '"""Bootstrap entry point for sandbox runtime."""\n'
    'from bootstrap_runtime.sandbox_bootstrap_main import main\n'
    'import sys\n'
    'sys.exit(main())\n'
)
_EMPTY_INIT: str = ""
_SOURCE_NAMES: tuple[str, ...] = (
    "sandbox_release_archive.py",
    "sandbox_release_extract.py",
    "sandbox_release_manifest.py",
    "sandbox_bootstrap_trust.py",
    "sandbox_bootstrap_main.py",
)
_ZIP_MTIME: tuple[int, ...] = (1980, 1, 1, 0, 0, 0)
_ZIP_CREATE_SYSTEM: int = 3
_ZIP_EXTERNAL_ATTR: int = (stat.S_IFREG | 0o644) << 16
_FAIL_EXIT: int = 99
_MAX_PER_SOURCE: int = 512 * 1024
_MIN_TOTAL: int = 1
_MAX_TOTAL: int = 1024 * 1024
_READ_CHUNK: int = 64 * 1024

def _sclose(fd: int) -> None:
    try:
        os.close(fd)
    except OSError:
        pass

def _real_dir(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    if os.path.islink(path):
        return False
    return stat.S_ISDIR(st.st_mode)

def _syntax_valid(source: str, filename: str) -> bool:
    try:
        compile(source, filename, "exec")
        return True
    except (SyntaxError, ValueError, OverflowError):
        return False

def _read_source_binary(path: str) -> bytes | None:
    """Read source in <=64 KiB chunks with pre/post fstat identity check."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
    except OSError:
        _sclose(fd)
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        _sclose(fd)
        return None
    if st.st_size > _MAX_PER_SOURCE:
        _sclose(fd)
        return None
    chunks: list[bytes] = []
    remaining = st.st_size
    while remaining > 0:
        to_read = min(_READ_CHUNK, remaining)
        try:
            chunk = os.read(fd, to_read)
        except OSError:
            _sclose(fd)
            return None
        if len(chunk) == 0:
            _sclose(fd)
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    try:
        extra = os.read(fd, 1)
    except OSError:
        _sclose(fd)
        return None
    if len(extra) != 0:
        _sclose(fd)
        return None
    raw = b"".join(chunks)
    if len(raw) != st.st_size:
        _sclose(fd)
        return None
    try:
        st2 = os.fstat(fd)
    except OSError:
        _sclose(fd)
        return None
    if (
        not stat.S_ISREG(st2.st_mode)
        or st2.st_nlink != 1
        or st2.st_dev != st.st_dev
        or st2.st_ino != st.st_ino
        or st2.st_uid != st.st_uid
        or st2.st_gid != st.st_gid
        or st2.st_mode != st.st_mode
        or st2.st_size != st.st_size
    ):
        _sclose(fd)
        return None
    _sclose(fd)
    return raw

def _cleanup_claimed(
    parent_fd: int, basename: str, claimed_dev: int, claimed_ino: int,
) -> None:
    try:
        st = os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)
        if st.st_dev == claimed_dev and st.st_ino == claimed_ino:
            os.unlink(basename, dir_fd=parent_fd)
    except OSError:
        pass

def build(source_root: str, output_path: str) -> bool:
    if not _real_dir(source_root):
        return False
    parent_path = os.path.dirname(output_path)
    if not parent_path or not _real_dir(parent_path):
        return False
    src_dir = os.path.join(source_root, "prime-agent-runtime", "src", "rlm")
    if not _real_dir(src_dir):
        return False
    basename = os.path.basename(output_path)
    if not basename or basename in (".", "..") or "/" in basename:
        return False
    try:
        pls = os.lstat(parent_path)
    except OSError:
        return False
    if os.path.islink(parent_path) or not stat.S_ISDIR(pls.st_mode):
        return False
    pls_dev: int = pls.st_dev
    pls_ino: int = pls.st_ino
    success: bool = False
    parent_fd: int = -1
    out_fd: int = -1
    out_own: bool = False
    c_dev: int = 0
    c_ino: int = 0
    try:
        try:
            parent_fd = os.open(parent_path,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            return False
        try:
            pf_st = os.fstat(parent_fd)
        except OSError:
            return False
        if (not stat.S_ISDIR(pf_st.st_mode)
                or pf_st.st_dev != pls_dev
                or pf_st.st_ino != pls_ino):
            return False
        entries: list[tuple[str, bytes]] = []
        total: int = 0
        for arcname, source_text in (
            ("__main__.py", _MAIN_SOURCE),
            ("bootstrap_runtime/__init__.py", _EMPTY_INIT),
        ):
            if not _syntax_valid(source_text, arcname):
                return False
            raw = source_text.encode("utf-8")
            if total + len(raw) > _MAX_TOTAL:
                return False
            entries.append((arcname, raw))
            total += len(raw)
        for src_name in _SOURCE_NAMES:
            src_path = os.path.join(src_dir, src_name)
            raw = _read_source_binary(src_path)
            if raw is None:
                return False
            try:
                text = raw.decode("utf-8")
            except (UnicodeDecodeError, LookupError):
                return False
            if not _syntax_valid(text, src_name):
                return False
            if total + len(raw) > _MAX_TOTAL:
                return False
            entries.append((f"bootstrap_runtime/{src_name}", raw))
            total += len(raw)
        if total < _MIN_TOTAL:
            return False
        entries.sort(key=lambda pair: pair[0])
        try:
            out_fd = os.open(basename,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                0o600, dir_fd=parent_fd)
        except OSError:
            return False
        out_own = True
        try:
            cs = os.fstat(out_fd)
        except OSError:
            return False
        c_dev = cs.st_dev
        c_ino = cs.st_ino
        if not stat.S_ISREG(cs.st_mode) or cs.st_nlink != 1:
            return False
        if stat.S_IMODE(cs.st_mode) != 0o600 or cs.st_size != 0:
            return False
        try:
            fobj = os.fdopen(out_fd, "wb")
        except OSError:
            return False
        out_own = False
        with fobj:
            with zipfile.ZipFile(fobj, "w", zipfile.ZIP_STORED) as zf:
                for arcname, data in entries:
                    info = zipfile.ZipInfo(arcname, _ZIP_MTIME)
                    info.create_system = _ZIP_CREATE_SYSTEM
                    info.external_attr = _ZIP_EXTERNAL_ATTR
                    info.compress_type = zipfile.ZIP_STORED
                    zf.writestr(info, data)
            fobj.flush()
            os.fsync(fobj.fileno())
            st = os.fstat(out_fd)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                return False
            if st.st_dev != c_dev or st.st_ino != c_ino:
                return False
            if not (_MIN_TOTAL <= st.st_size <= _MAX_TOTAL):
                return False
            os.fchmod(out_fd, 0o644)
            os.fsync(out_fd)
            st2 = os.fstat(out_fd)
            if not stat.S_ISREG(st2.st_mode) or st2.st_nlink != 1:
                return False
            if st2.st_dev != c_dev or st2.st_ino != c_ino:
                return False
            try:
                nst = os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)
            except OSError:
                return False
            if (not stat.S_ISREG(nst.st_mode) or nst.st_nlink != 1
                    or nst.st_dev != c_dev or nst.st_ino != c_ino
                    or nst.st_uid != st2.st_uid or nst.st_gid != st2.st_gid
                    or stat.S_IMODE(nst.st_mode) != 0o644
                    or nst.st_size != st2.st_size):
                return False
        os.fsync(parent_fd)
        success = True
    except BaseException:
        pass
    finally:
        if out_own and out_fd >= 0:
            _sclose(out_fd)
        if not success and c_ino != 0:
            _cleanup_claimed(parent_fd, basename, c_dev, c_ino)
            try:
                os.fsync(parent_fd)
            except OSError:
                pass
        if parent_fd >= 0:
            _sclose(parent_fd)
    return success

def _parse_argv(argv: list[str]) -> tuple[str | None, str | None, int | None]:
    src: str | None = None
    out: str | None = None
    i: int = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--source-root":
            if src is not None:
                return (None, None, 2)
            i += 1
            if i >= len(argv):
                return (None, None, 2)
            src = argv[i]
        elif arg == "--output":
            if out is not None:
                return (None, None, 2)
            i += 1
            if i >= len(argv):
                return (None, None, 2)
            out = argv[i]
        else:
            return (None, None, 2)
        i += 1
    if src is None or out is None:
        return (None, None, 2)
    if not os.path.isabs(src) or not os.path.isabs(out):
        return (None, None, 2)
    return (src, out, None)

def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    src, out, ec = _parse_argv(argv)
    if ec is not None:
        return ec
    if build(src, out):
        return 0
    return _FAIL_EXIT

if __name__ == "__main__":
    sys.exit(main())
