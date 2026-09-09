"""Bootstrap executor: validate env, read artifacts, extract, exec setpriv.

Returns one fixed nonzero code on every failure.  On success os.execve replaces
itself.  No raw path or fd leaks.  No logging, printing, errors, env reads,
shell, proc, ctypes, or network.
"""

from __future__ import annotations

import hashlib
import os
import stat
import sys

from .sandbox_bootstrap_trust import (
    BootstrapTrust,
    DecodeTrustSuccess,
    build_launch_config,
    decode_bootstrap_trust,
)
from .sandbox_release_archive import ArchiveIdentity, Manifest
from .sandbox_release_extract import (
    ExtractArchiveSuccess,
    extract_verified_archive,
)
from .sandbox_release_manifest import DecodeManifestSuccess, decode_release_manifest

_EXIT: int = 91
_CHUNK: int = 65536
_SP_HASH: str = (
    "d5839b20edb0d77222b1e11be7d155c7122d381dbfad40876b0def7dd710f5bd"
)
_SP_PATH: str = "/usr/bin/setpriv"
_SAND_EXEC: str = (
    "/opt/prime-agent-sandbox-v1/"
    "prime-agent-runtime-v1/"
    "prime-agent"
)
_LAUNCH_JSON: str = "prime-agent-launch.json"
_WORKSPACE: str = "prime-agent-workspace-v1"
_SAND_DIR: str = "prime-agent-sandbox-v1"
_TRUST_JSON: str = "prime-agent-bootstrap-trust.json"
_MANIFEST_JSON: str = "prime-agent-runtime.manifest.json"
_ARCHIVE_GZ: str = "prime-agent-runtime.tar.gz"
_CANDIDATE: str = "prime-agent-runtime-v1"
_MAX_TRUST: int = 4096
_ROOT_OWNER_MODE: int = 0o600
_OWNER_READ_MODE: int = 0o644


class _FdReg:
    """Tracks owned fd numbers so each fd is closed exactly once."""

    def __init__(self) -> None:
        self._owned: set[int] = set()

    def take(self, fd: int) -> None:
        if fd < 0:
            raise ValueError
        if fd in self._owned:
            raise RuntimeError("fd already owned")
        self._owned.add(fd)

    def release(self, fd: int) -> None:
        if fd in self._owned:
            self._owned.discard(fd)
            try:
                os.close(fd)
            except OSError:
                pass

    def close_all(self) -> None:
        for fd in list(self._owned):
            self._owned.discard(fd)
            try:
                os.close(fd)
            except OSError:
                pass


class _Id:
    """Frozen identity record.  No live fd.  Safe for verification."""

    __slots__ = ("dev", "ino", "uid", "gid", "mode", "nlink", "size")

    def __init__(self, dev: int, ino: int, uid: int, gid: int,
                 mode: int, nlink: int, size: int = 0) -> None:
        object.__setattr__(self, "dev", dev)
        object.__setattr__(self, "ino", ino)
        object.__setattr__(self, "uid", uid)
        object.__setattr__(self, "gid", gid)
        object.__setattr__(self, "mode", mode)
        object.__setattr__(self, "nlink", nlink)
        object.__setattr__(self, "size", size)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("_Id is immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("_Id is immutable")

    @classmethod
    def from_stat(cls, st: os.stat_result) -> _Id:
        return cls(
            st.st_dev,
            st.st_ino,
            st.st_uid,
            st.st_gid,
            stat.S_IMODE(st.st_mode),
            st.st_nlink,
            st.st_size,
        )

    def matches(self, st: os.stat_result) -> bool:
        return (
            st.st_dev == self.dev
            and st.st_ino == self.ino
            and st.st_uid == self.uid
            and st.st_gid == self.gid
            and stat.S_IMODE(st.st_mode) == self.mode
            and st.st_nlink == self.nlink
            and st.st_size == self.size
        )


class _Claim:
    """Frozen cleanup claim: dev+ino+type for safe unlink/rmdir.

    Captured immediately after exclusive create.  Ignores uid/mode/nlink/size
    because the bootstrap mutates those before cleanup is ever needed.
    """

    __slots__ = ("dev", "ino", "is_dir")

    def __init__(self, dev: int, ino: int, is_dir: bool) -> None:
        object.__setattr__(self, "dev", dev)
        object.__setattr__(self, "ino", ino)
        object.__setattr__(self, "is_dir", is_dir)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("_Claim is immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("_Claim is immutable")


class _FdId:
    """Identity snapshot tied to a live fd.  For fd and name verification."""

    __slots__ = ("fd", "id")

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.id = _Id.from_stat(os.fstat(fd))

    def fd_ok(self) -> bool:
        try:
            return self.id.matches(os.fstat(self.fd))
        except OSError:
            return False

    def name_ok(self, name: bytes, dir_fd: int | None) -> bool:
        try:
            return self.id.matches(
                os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            )
        except OSError:
            return False

    def both_ok(self, name: bytes, dir_fd: int | None) -> bool:
        return self.fd_ok() and self.name_ok(name, dir_fd)


def _open_dir(path: bytes, reg: _FdReg) -> _FdId:
    fd = os.open(
        path,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    reg.take(fd)
    try:
        snap = _FdId(fd)
        st = os.stat(path, follow_symlinks=False)
        if not _Id.from_stat(st).matches(os.fstat(fd)):
            raise OSError
        return snap
    except BaseException:
        reg.release(fd)
        raise


def _open_artifact(dfd: int, name: str, mx: int, reg: _FdReg) -> _FdId:
    fd = os.open(
        name,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=dfd,
    )
    reg.take(fd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise OSError
        if st.st_uid != 0 or st.st_gid != 0 or st.st_nlink != 1:
            raise OSError
        mb = stat.S_IMODE(st.st_mode)
        if mb not in (_ROOT_OWNER_MODE, _OWNER_READ_MODE):
            raise OSError
        if st.st_size < 1 or st.st_size > mx:
            raise OSError
        nst = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        if (
            nst.st_dev != st.st_dev
            or nst.st_ino != st.st_ino
            or nst.st_uid != st.st_uid
            or nst.st_gid != st.st_gid
            or nst.st_nlink != st.st_nlink
            or nst.st_size != st.st_size
        ):
            raise OSError
        return _FdId(fd)
    except BaseException:
        reg.release(fd)
        raise


def _pread(fd: int, sz: int) -> bytes:
    parts: list[bytes] = []
    offset = 0
    while offset < sz:
        chunk = os.pread(fd, min(_CHUNK, sz - offset), offset)
        if not chunk:
            raise OSError
        parts.append(chunk)
        offset += len(chunk)
    if os.pread(fd, 1, sz):
        raise OSError
    return b"".join(parts)


def _hash(fd: int, sz: int) -> str:
    hasher = hashlib.sha256()
    offset = 0
    while offset < sz:
        chunk = os.pread(fd, min(_CHUNK, sz - offset), offset)
        if not chunk:
            raise OSError
        hasher.update(chunk)
        offset += len(chunk)
    if os.pread(fd, 1, sz):
        raise OSError
    return hasher.hexdigest()


def _remove_clm(dfd: int, name: str, claim: _Claim) -> None:
    """Best-effort remove entry at *name* under *dfd* if dev+ino match.

    Checks the named entry type matches claim.is_dir before removal.
    Never raises.
    """
    try:
        st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        if st.st_dev != claim.dev or st.st_ino != claim.ino:
            return
        is_dir = stat.S_ISDIR(st.st_mode)
        if is_dir != claim.is_dir:
            return
        if claim.is_dir:
            os.rmdir(name, dir_fd=dfd)
        else:
            os.unlink(name, dir_fd=dfd)
        os.fsync(dfd)
    except OSError:
        pass


def _env_ok() -> None:
    if sys.platform != "linux":
        raise OSError
    machine = os.uname().machine
    if machine not in ("x86_64", "amd64"):
        raise OSError
    if sys.version_info[:3] != (3, 11, 13):
        raise OSError
    if os.getuid() != 0 or os.geteuid() != 0:
        raise OSError
    if os.getgid() != 0 or os.getegid() != 0:
        raise OSError


def _verify_sp(dfd: int, reg: _FdReg) -> _FdId:
    fd = os.open(
        "setpriv",
        os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=dfd,
    )
    reg.take(fd)
    try:
        st = os.fstat(fd)
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_uid != 0
            or st.st_gid != 0
            or st.st_nlink != 1
            or stat.S_IMODE(st.st_mode) != 0o755
        ):
            raise OSError
        nst = os.stat("setpriv", dir_fd=dfd, follow_symlinks=False)
        if (
            nst.st_dev != st.st_dev
            or nst.st_ino != st.st_ino
            or nst.st_uid != st.st_uid
            or nst.st_gid != st.st_gid
            or nst.st_nlink != st.st_nlink
            or nst.st_size != st.st_size
            or stat.S_IMODE(nst.st_mode) != 0o755
        ):
            raise OSError
        if _hash(fd, st.st_size) != _SP_HASH:
            raise OSError
        st2 = os.fstat(fd)
        if (
            st2.st_dev != st.st_dev
            or st2.st_ino != st.st_ino
            or st2.st_uid != st.st_uid
            or st2.st_gid != st.st_gid
            or stat.S_IMODE(st2.st_mode) != 0o755
            or st2.st_nlink != st.st_nlink
            or st2.st_size != st.st_size
        ):
            raise OSError
        nst2 = os.stat("setpriv", dir_fd=dfd, follow_symlinks=False)
        if (
            nst2.st_dev != st.st_dev
            or nst2.st_ino != st.st_ino
            or nst2.st_uid != st.st_uid
            or nst2.st_gid != st.st_gid
            or nst2.st_nlink != st.st_nlink
            or stat.S_IMODE(nst2.st_mode) != 0o755
            or nst2.st_size != st.st_size
        ):
            raise OSError
        return _FdId(fd)
    except BaseException:
        reg.release(fd)
        raise


def _claim_fd(fd: int, is_dir: bool) -> _Claim | None:
    try:
        st = os.fstat(fd)
    except OSError:
        return None
    if stat.S_ISDIR(st.st_mode) != is_dir:
        return None
    return _Claim(st.st_dev, st.st_ino, is_dir)


def _claim_created_dir(
    dfd: int,
    name: str,
    reg: _FdReg,
) -> tuple[_FdId, _Claim]:
    os.mkdir(name, 0o700, dir_fd=dfd)
    fd = -1
    tracked = False
    claim: _Claim | None = None
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=dfd,
        )
        reg.take(fd)
        tracked = True
        st = os.fstat(fd)
        claim = _Claim(st.st_dev, st.st_ino, is_dir=True)
        if (
            not stat.S_ISDIR(st.st_mode)
            or st.st_uid != 0
            or st.st_gid != 0
            or st.st_nlink != 2
            or stat.S_IMODE(st.st_mode) != 0o700
            or st.st_size < 0
        ):
            raise OSError
        snap = _FdId(fd)
        if not snap.both_ok(name.encode(), dfd):
            raise OSError
        return (snap, claim)
    except BaseException:
        if claim is None and fd >= 0:
            claim = _claim_fd(fd, is_dir=True)
        if tracked:
            reg.release(fd)
        elif fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        if claim is not None:
            _remove_clm(dfd, name, claim)
        raise


def _write_cfg(
    dfd: int,
    data: bytes,
    reg: _FdReg,
) -> tuple[_FdId, _Claim]:
    fd = os.open(
        _LAUNCH_JSON,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=dfd,
    )
    tracked = False
    claim: _Claim | None = None
    try:
        reg.take(fd)
        tracked = True
        st = os.fstat(fd)
        claim = _Claim(st.st_dev, st.st_ino, is_dir=False)
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_uid != 0
            or st.st_gid != 0
            or st.st_nlink != 1
            or stat.S_IMODE(st.st_mode) != 0o600
            or st.st_size != 0
        ):
            raise OSError
        initial = _FdId(fd)
        if not initial.both_ok(_LAUNCH_JSON.encode(), dfd):
            raise OSError
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            if written <= 0:
                raise OSError
            offset += written
        os.fsync(fd)
        os.fchmod(fd, 0o444)
        os.fsync(fd)
        written_snap = _FdId(fd)
        if not written_snap.both_ok(_LAUNCH_JSON.encode(), dfd):
            raise OSError
        if written_snap.id.size != len(data) or written_snap.id.mode != 0o444:
            raise OSError

        reg.release(fd)
        tracked = False
        fd = -1
        fd = os.open(
            _LAUNCH_JSON,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=dfd,
        )
        reg.take(fd)
        tracked = True
        read_snap = _FdId(fd)
        if (
            read_snap.id.dev != claim.dev
            or read_snap.id.ino != claim.ino
            or read_snap.id.uid != 0
            or read_snap.id.gid != 0
            or read_snap.id.mode != 0o444
            or read_snap.id.nlink != 1
            or read_snap.id.size != len(data)
            or not read_snap.both_ok(_LAUNCH_JSON.encode(), dfd)
            or _pread(fd, read_snap.id.size) != data
        ):
            raise OSError
        return (read_snap, claim)
    except BaseException:
        if claim is None:
            claim = _claim_fd(fd, is_dir=False)
        if tracked:
            reg.release(fd)
        elif fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        if claim is not None:
            _remove_clm(dfd, _LAUNCH_JSON, claim)
        raise


def _mk_ws(
    dfd: int,
    reg: _FdReg,
) -> tuple[_FdId, _FdId, _Claim, _Claim]:
    ws, ws_claim = _claim_created_dir(dfd, _WORKSPACE, reg)
    tmp: _FdId | None = None
    tmp_claim: _Claim | None = None
    try:
        os.fchown(ws.fd, 65534, 65534)
        os.fchmod(ws.fd, 0o700)
        tmp, tmp_claim = _claim_created_dir(ws.fd, "tmp", reg)
        os.fchown(tmp.fd, 65534, 65534)
        os.fchmod(tmp.fd, 0o700)
        ws_final = _FdId(ws.fd)
        tmp_final = _FdId(tmp.fd)
        if not ws_final.both_ok(_WORKSPACE.encode(), dfd):
            raise OSError
        if not tmp_final.both_ok(b"tmp", ws.fd):
            raise OSError
        return (ws_final, tmp_final, ws_claim, tmp_claim)
    except BaseException:
        if tmp is not None:
            reg.release(tmp.fd)
        if tmp_claim is not None:
            _remove_clm(ws.fd, "tmp", tmp_claim)
        reg.release(ws.fd)
        _remove_clm(dfd, _WORKSPACE, ws_claim)
        raise


def _mk_sb(dfd: int, reg: _FdReg) -> tuple[_FdId, _Claim]:
    return _claim_created_dir(dfd, _SAND_DIR, reg)


def _check_pe(manifest: Manifest) -> str:
    for entry in manifest.entries:
        if entry.path == "prime-agent":
            if entry.type != "file" or entry.mode != "0755":
                raise OSError
            if entry.sha256 is None or len(entry.sha256) != 64:
                raise OSError
            int(entry.sha256, 16)
            return entry.sha256
    raise OSError


def main() -> int:
    reg = _FdReg()
    t = o = ub = tr = mr = sp = cf = ws = wt = sb = None
    afd = -1
    xr = None
    lc = None
    wc = None
    tc = None
    sc = None
    trust_raw = None
    manifest_raw = None
    launch_raw = None

    def _cln() -> None:
        nonlocal xr
        if xr is not None:
            try:
                xr.close()
            except BaseException:
                pass
            xr = None
        if lc is not None and t is not None:
            _remove_clm(t.fd, _LAUNCH_JSON, lc)
        if tc is not None and ws is not None:
            _remove_clm(ws.fd, "tmp", tc)
        if wc is not None and t is not None:
            _remove_clm(t.fd, _WORKSPACE, wc)
        if sc is not None and o is not None:
            _remove_clm(o.fd, _SAND_DIR, sc)
        reg.close_all()

    try:
        _env_ok()
        t = _open_dir(b"/tmp", reg)
        if t.id.uid != 0 or t.id.gid != 0 or t.id.mode != 0o1777:
            raise OSError
        o = _open_dir(b"/opt", reg)
        if o.id.uid != 0 or o.id.gid != 0 or o.id.mode != 0o755:
            raise OSError

        # Read and decode trust
        tr = _open_artifact(t.fd, _TRUST_JSON, _MAX_TRUST, reg)
        trust_raw = _pread(tr.fd, tr.id.size)
        if not tr.both_ok(_TRUST_JSON.encode(), t.fd):
            raise OSError
        dr = decode_bootstrap_trust(trust_raw)
        if type(dr) is not DecodeTrustSuccess:
            raise OSError
        tw = dr.value

        # Read manifest
        mr = _open_artifact(t.fd, _MANIFEST_JSON, tw.manifest_bytes, reg)
        manifest_raw = _pread(mr.fd, tw.manifest_bytes)
        if not mr.both_ok(_MANIFEST_JSON.encode(), t.fd):
            raise OSError
        if hashlib.sha256(manifest_raw).hexdigest() != tw.manifest_sha256:
            raise OSError

        # Decode manifest
        aid = ArchiveIdentity(
            compressed_sha256=tw.archive_sha256,
            compressed_bytes=tw.archive_bytes,
        )
        mr2 = decode_release_manifest(manifest_raw, aid)
        if type(mr2) is not DecodeManifestSuccess:
            raise OSError
        ld = _check_pe(mr2.manifest)

        # Build launch config
        launch_raw = build_launch_config(tw, ld)
        if launch_raw is None:
            raise OSError

        # Create directories
        cf, lc = _write_cfg(t.fd, launch_raw, reg)
        ws, wt, wc, tc = _mk_ws(t.fd, reg)
        t = _FdId(t.fd)
        sb, sc = _mk_sb(o.fd, reg)
        o = _FdId(o.fd)

        # Verify setpriv
        ub = _open_dir(b"/usr/bin", reg)
        if ub.id.uid != 0 or ub.id.gid != 0 or ub.id.mode != 0o755:
            raise OSError
        sp = _verify_sp(ub.fd, reg)

        # Open archive
        afd = os.open(
            _ARCHIVE_GZ,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=t.fd,
        )
        reg.take(afd)
        try:
            ast = os.fstat(afd)
            if (
                not stat.S_ISREG(ast.st_mode)
                or ast.st_uid != 0
                or ast.st_gid != 0
                or ast.st_nlink != 1
            ):
                raise OSError
            amb = stat.S_IMODE(ast.st_mode)
            if amb not in (_ROOT_OWNER_MODE, _OWNER_READ_MODE):
                raise OSError
            if ast.st_size != tw.archive_bytes:
                raise OSError
            anst = os.stat(
                _ARCHIVE_GZ, dir_fd=t.fd, follow_symlinks=False,
            )
            if (
                anst.st_dev != ast.st_dev
                or anst.st_ino != ast.st_ino
                or anst.st_uid != ast.st_uid
                or anst.st_gid != ast.st_gid
                or anst.st_nlink != ast.st_nlink
                or anst.st_size != ast.st_size
            ):
                raise OSError
            ap = _FdId(afd)
        except BaseException:
            reg.release(afd)
            raise

        # Extract
        er = extract_verified_archive(
            afd, sb.fd, _CANDIDATE, aid, mr2.manifest,
        )
        if type(er) is not ExtractArchiveSuccess:
            raise OSError
        xr = er.root
        if not xr.freeze_for_launch():
            raise OSError
        sb = _FdId(sb.fd)
        if sb.id.uid != 0 or sb.id.gid != 0 or sb.id.mode != 0o555:
            raise OSError
        if not sb.both_ok(_SAND_DIR.encode(), o.fd):
            raise OSError
        if not xr.verify():
            raise OSError
        if not xr.close():
            raise OSError
        xr = None

        # Re-verify every artifact identity and content before exec
        # Trust: re-read and exact-compare bytes
        if not tr.both_ok(_TRUST_JSON.encode(), t.fd):
            raise OSError
        if _pread(tr.fd, tr.id.size) != trust_raw:
            raise OSError
        if not tr.both_ok(_TRUST_JSON.encode(), t.fd):
            raise OSError
        # Manifest: re-hash
        if not mr.both_ok(_MANIFEST_JSON.encode(), t.fd):
            raise OSError
        if hashlib.sha256(_pread(mr.fd, mr.id.size)).hexdigest() != tw.manifest_sha256:
            raise OSError
        if not mr.both_ok(_MANIFEST_JSON.encode(), t.fd):
            raise OSError
        # Launch config: re-read and exact-compare
        if not cf.both_ok(_LAUNCH_JSON.encode(), t.fd):
            raise OSError
        if _pread(cf.fd, cf.id.size) != launch_raw:
            raise OSError
        if not cf.both_ok(_LAUNCH_JSON.encode(), t.fd):
            raise OSError
        # Archive: re-hash
        if not ap.both_ok(_ARCHIVE_GZ.encode(), t.fd):
            raise OSError
        if _hash(afd, tw.archive_bytes) != tw.archive_sha256:
            raise OSError
        if not ap.both_ok(_ARCHIVE_GZ.encode(), t.fd):
            raise OSError
        # Setpriv: re-hash
        if not sp.both_ok(b"setpriv", ub.fd):
            raise OSError
        if _hash(sp.fd, sp.id.size) != _SP_HASH:
            raise OSError
        if not sp.both_ok(b"setpriv", ub.fd):
            raise OSError
        # Directory identities
        if not t.both_ok(b"/tmp", None):
            raise OSError
        if not o.both_ok(b"/opt", None):
            raise OSError
        if not ub.both_ok(b"/usr/bin", None):
            raise OSError
        if not ws.both_ok(_WORKSPACE.encode(), t.fd):
            raise OSError
        if not wt.both_ok(b"tmp", ws.fd):
            raise OSError
        if not sb.both_ok(_SAND_DIR.encode(), o.fd):
            raise OSError

        # fchdir to workspace. CLOEXEC closes every tracked fd on success.
        os.fchdir(ws.fd)

        # Execve.  CLOEXEC closes all owned fds on success.
        # On failure, _cln() handles cleanup.
        os.execve(
            _SP_PATH,
            [
                _SP_PATH,
                "--no-new-privs",
                "--bounding-set=-all",
                "--inh-caps=-all",
                "--ambient-caps=-all",
                "--reuid=65534",
                "--regid=65534",
                "--clear-groups",
                "--",
                _SAND_EXEC,
                "--internal-sandbox-launcher",
            ],
            {
                "HOME": "/tmp/prime-agent-workspace-v1",
                "TMPDIR": "/tmp/prime-agent-workspace-v1/tmp",
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            },
        )
        raise OSError
    except BaseException:
        _cln()
        return _EXIT


if __name__ == "__main__":
    sys.exit(main())
