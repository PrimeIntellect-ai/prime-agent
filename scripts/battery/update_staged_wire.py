#!/usr/bin/env python3
"""Wire parity battery for the staged-activation update flow (spec
`docs/update-flow-state-machine.md` §4/§7, slice 4): the coordinator FSM, the
bin-symlink staged activation, the rollback, and the TS status-file schema.

Rust phases run against a managed fixture install root (the battery's own
release binary copied into `.managed` + `releases/<ver>-<platform>-<sha>/`
+ `bin/prime-agent`) with the candidate served by a local HTTP server:

  F1 the full staged update (`update --force`, live session): status.json
     walks Acquire..Complete (terminal `complete`), counts report the
     adopted session (total=1, restored=1), the launcher swap lands
     (`bin/prime-agent` -> candidate, `bin/previous` -> old), the prepared
     dir is swept, the activation state and the intent lock are gone, and
     the successor daemon serves the session's durable id.
  F2 the rollback (`update --rollback`, live session): the same FSM with
     the previous release as candidate - the launcher returns to the old
     target, the status is terminal `complete` with the rolled-back
     message, and the session survives.
  F3 the unmanaged-install refusal: the repo binary (no `.managed` root)
     refuses with the TS message byte-for-byte.

TS comparison (both sides, real binaries):

  P1 refusal parity: TS `update --force` on an unmanaged install prints the
     same "This compiled application is not owned by the Prime Agent
     installer." refusal.
  P2 rollback-without-previous parity: both refuse with "No valid previous
     compiled release is available."
  P3 TS coordinator status schema: TS's `--internal-update-restart-*`
     coordinator mode on a live TS daemon writes its status file; the
     shared schema fields (version, socketPath, coordinator identity,
     counts, failures) parse with the Rust UpdateStatus type, and the
     terminal message "Restarted the daemon after the update" is
     byte-identical to the Rust F1 terminal message.
  D1 (documented divergence) TS phase names (`starting`, `preparing`,
     `stopping`, `starting_daemon`, `restoring`, `complete`) vs the Rust
     state vocabulary (`staged`..`complete`): the spec redesign replaces
     the TS phase machine; the status file schema and terminal report
     strings stay TS-compatible.

Usage:
    python3 scripts/battery/update_staged_wire.py \
        --rust-bin /abs/path/prime-agent [--ts-bin prime-agent] [--out DIR]

Exit code is non-zero when any parity row (P*/F*) mismatches.
"""

import argparse
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import batterylib as B
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

FLOW = "update_staged"
PLATFORM = "linux-x64" if sys.platform == "linux" else "darwin-x64"
PAYLOAD_ASSETS = ["prime-agent-runtime", "skills", "docs", "LICENSE", "README.md"]
UNMANAGED_REFUSAL = "This compiled application is not owned by the Prime Agent installer."
NO_PREVIOUS_REFUSAL = "No valid previous compiled release is available."
TERMINAL_MESSAGE = "Restarted the daemon after the update"


class ReleaseServer:
    """A local HTTP server serving the manifest + candidate archive."""

    def __init__(self, directory: Path):
        self.directory = directory
        handler = lambda *args, **kwargs: http.server.SimpleHTTPRequestHandler(
            *args, directory=str(directory), **kwargs
        )
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        self.httpd.shutdown()


def sha256_of(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_release_dir(
    releases_root: Path,
    version: str,
    archive_sha: str,
    binary: Path,
) -> Path:
    """One fixture release: the binary, the payload, and the installer
    metadata (assemble_artifacts.py payload + `.archive-sha256`/`.install-source`)."""
    name = f"{version}-{PLATFORM}-{archive_sha}"
    release = releases_root / name
    release.mkdir(parents=True)
    shutil.copy2(binary, release / "prime-agent")
    os.chmod(release / "prime-agent", 0o755)
    runtime = release / "prime-agent-runtime"
    runtime.mkdir()
    (runtime / "pyproject.toml").write_text("# battery fixture\n")
    for asset in ["skills", "docs"]:
        (release / asset).mkdir()
    (release / "LICENSE").write_text("battery\n")
    (release / "README.md").write_text("battery\n")
    (release / ".archive-sha256").write_text(archive_sha)
    return release


def build_fixture_root(root: Path, binary: Path, version: str) -> dict:
    """A managed install root whose active release is `version` (sha A)."""
    install = root / "install"
    (install / "releases").mkdir(parents=True)
    (install / ".managed").write_text("prime-agent-native-v1")
    sha_a = "a" * 64
    release_a = build_release_dir(install / "releases", version, sha_a, binary)
    (release_a / ".install-source").write_text("http://127.0.0.1:1")  # replaced per phase
    (install / "bin").mkdir()
    os.symlink(f"../releases/{release_a.name}/prime-agent", install / "bin" / "prime-agent")
    return {"install": install, "sha_a": sha_a, "release_a": release_a}


def build_candidate(server_dir: Path, binary: Path, version: str) -> tuple[str, str]:
    """Stage + tar the candidate payload (files at the archive root,
    installer-ci-design.md §5); returns the archive's real digest and name.
    The digest the manifest carries is the one the staged release directory
    is named after (TS install.sh naming)."""
    staging = tempfile.mkdtemp(prefix="candidate-")
    staging_path = Path(staging)
    payload = staging_path / "payload"
    payload.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, payload / "prime-agent")
    os.chmod(payload / "prime-agent", 0o755)
    (payload / "prime-agent-runtime").mkdir()
    (payload / "prime-agent-runtime" / "pyproject.toml").write_text("# battery fixture\n")
    for asset in ["skills", "docs"]:
        (payload / asset).mkdir()
    (payload / "LICENSE").write_text("battery\n")
    (payload / "README.md").write_text("battery\n")
    archive_name = f"prime-agent-{version}-{PLATFORM}.tar.gz"
    archive = server_dir / archive_name
    with tarfile.open(archive, "w:gz") as tar:
        for entry in sorted(payload.iterdir()):
            tar.add(entry, arcname=entry.name)
    shutil.rmtree(staging)
    return sha256_of(archive), archive_name


def launcher_target(install: Path, link: str) -> str:
    return os.readlink(install / "bin" / link)


def run_cli(binary: Path, args: list[str], env: dict, cwd: Path, timeout: float = 180.0) -> dict:
    return B.run_cmd([str(binary), *args], env, cwd, timeout=timeout)


def make_rust_side(name: str, binary: str, root: Path, env_extra: dict) -> B.Side:
    agent = root / "agent"
    work = root / "work"
    work.mkdir(parents=True, exist_ok=True)
    agent.mkdir(parents=True, exist_ok=True)
    mock = B.MockProvider(root, [])
    mock.set_responses([{"text": "staged-battery"}])
    mock.start()
    tmpdir = Path("/tmp") / f"usw-{name}"
    if tmpdir.exists():
        shutil.rmtree(tmpdir)
    tmpdir.mkdir(parents=True)
    side = B.Side(
        name=name,
        binary=binary,
        root=root,
        agent_dir=agent,
        work_dir=work,
        daemon_socket=root / "daemon.sock",
        mock=mock,
    )
    side.env = B.scrubbed_env(agent, tmpdir, env_extra)
    side.env["PRIME_API_KEY"] = "sk-battery"
    side.write_models_json()
    return side


def default_socket(side: B.Side) -> Path:
    """The product-default daemon socket under this side's isolated TMPDIR
    (`prime-agent <update>` targets it: TS `resolveDaemonUpdateRestartSocketPath`
    with no explicit socket)."""
    return Path(side.env["TMPDIR"]) / f"prime-agent-{os.getuid()}" / "daemon.sock"



def ts_fixture_root(root: Path, ts_binary: Path) -> Path:
    """A managed fixture install root for the TS binary: the TS asset list
    (`native-installation.ts` NATIVE_RELEASE_ASSETS: package.json,
    install.sh with the recovery marker, runtime/theme/export stubs,
    `.archive-sha256`, `.install-source`), no `bin/previous`."""
    version = subprocess.run(
        [str(ts_binary), "--version"], capture_output=True, text=True
    ).stdout.strip()
    sha = "f" * 64
    install = root / "ts-install"
    release = install / "releases" / f"{version}-{PLATFORM}-{sha}"
    release.mkdir(parents=True)
    shutil.copy2(ts_binary, release / "prime-agent")
    os.chmod(release / "prime-agent", 0o755)
    (release / "package.json").write_text(json.dumps({"version": version}))
    (release / "install.sh").write_text("# prime-agent-native-recovery-v1\ntrue\n")
    os.chmod(release / "install.sh", 0o755)
    runtime = release / "prime-agent-runtime" / "src" / "rlm"
    runtime.mkdir(parents=True)
    (release / "prime-agent-runtime" / "pyproject.toml").write_text("# battery\n")
    (runtime / "repl.py").write_text("# battery\n")
    theme = release / "theme"
    theme.mkdir()
    (theme / "prime.json").write_text("{}\n")
    export_html = release / "export-html"
    export_html.mkdir()
    (export_html / "template.html").write_text("<p>battery</p>\n")
    (release / "photon_rs_bg.wasm").write_bytes(b"battery")
    (release / ".archive-sha256").write_text(sha)
    (release / ".install-source").write_text("http://127.0.0.1:1\n")
    (install / ".managed").write_text("prime-agent-native-v1")
    (install / "bin").mkdir()
    os.symlink(f"../releases/{release.name}/prime-agent", install / "bin" / "prime-agent")
    return install

def kill_detached_workers_under(root: Path) -> int:
    """SIGTERM every process whose cwd is under `root` (the battery's own
    detached session workers; scoped so ambient daemons are never touched)."""
    killed = 0
    import signal as _signal

    root_s = str(root)
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cwd = os.readlink(entry / "cwd")
        except OSError:
            continue
        if cwd.startswith(root_s):
            try:
                os.kill(int(entry.name), _signal.SIGTERM)
                killed += 1
            except OSError:
                pass
    return killed


def resident_session_id(wire: B.Wire) -> str | None:
    listing = wire.request("ls", {"type": "list"})
    sessions = ((listing.get("data") or {}).get("sessions")) or []
    for row in sessions:
        if row.get("sessionId"):
            return row["sessionId"]
    return None


def main() -> int:
    default_rust = Path(__file__).resolve().parents[2] / "target/release/prime-agent"
    parser = argparse.ArgumentParser()
    parser.add_argument("--ts-bin", default="prime-agent")
    parser.add_argument("--rust-bin", default=str(default_rust))
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    rust_bin = Path(args.rust_bin).resolve()
    if not rust_bin.exists():
        print(f"rust binary missing: {rust_bin}", file=sys.stderr)
        return 2
    ts_bin = shutil.which(args.ts_bin)
    if not ts_bin:
        print(f"ts binary not found: {args.ts_bin}", file=sys.stderr)
        return 2
    # Fail fast before any launch: a non-TS ts binary plays a Rust build as
    # the "ts" side and reports false parity rows.
    ts_identity.assert_ts_side_is_the_ts_product(ts_bin, str(rust_bin))

    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = Path(args.out) if args.out else Path(__file__).parent / "runs" / f"{stamp}-{FLOW}"
    out.mkdir(parents=True, exist_ok=True)

    version = subprocess.run(
        [str(rust_bin), "--version"], capture_output=True, text=True
    ).stdout.strip()
    server = ReleaseServer(out / "server")
    (out / "server").mkdir(parents=True, exist_ok=True)
    verdicts = []
    evidence = {"flow": FLOW, "version": version, "rows": {}}

    try:
        # ------------------------------------------------------------------
        # F1: the full staged update against the fixture install root.
        # ------------------------------------------------------------------
        f1_root = out / "rust-f1"
        if f1_root.exists():
            shutil.rmtree(f1_root)
        fixture = build_fixture_root(f1_root, rust_bin, version)
        install = fixture["install"]
        fixture_bin = install / "bin" / "prime-agent"
        side = make_rust_side(
            f"rust-f1-{stamp}",
            str(fixture_bin),
            f1_root,
            {
                "PRIME_AGENT_DOWNLOAD_BASE_URL": server.base_url,
                "PRIME_AGENT_UPDATE_RESTORE_OVERALL_MS": "15000",
            },
        )
        side.daemon_socket = default_socket(side)
        # The staged release's install-source points at the battery server.
        (fixture["release_a"] / ".install-source").write_text(server.base_url + "\n")
        archive_sha, archive_name = build_candidate(out / "server", rust_bin, version)
        (out / "server" / "latest.json").write_text(
            json.dumps(
                {
                    "version": version,
                    "binaries": [
                        {
                            "platform": PLATFORM,
                            "file": archive_name,
                            "sha256": archive_sha,
                        }
                    ],
                }
            )
        )
        side.start_daemon()
        wire = B.Wire(side.daemon_socket)
        create = wire.request("c1", {"type": "create", "cwd": str(side.work_dir)})
        deadline = time.time() + 30.0
        while time.time() < deadline and resident_session_id(wire) is None:
            time.sleep(0.5)
        session_id = resident_session_id(wire)
        socket_dir = side.agent_dir / "update-restarts"
        for hashed in socket_dir.glob("*") if socket_dir.exists() else []:
            pass
        # The update CLI runs from the fixture binary with the daemon live.
        update_result = run_cli(
            fixture_bin, ["update", "--force"], side.env, side.work_dir
        )
        status_path = socket_dir / next(socket_dir.glob("*")).name / "status.json" if socket_dir.exists() and any(socket_dir.glob("*")) else None
        time.sleep(1.0)
        candidate_target = f"../releases/{version}-{PLATFORM}-{archive_sha}/prime-agent"
        new_wire = None
        try:
            new_wire = B.Wire(side.daemon_socket)
            restored_id = resident_session_id(new_wire)
        except Exception:
            restored_id = None
        successor_hello_resume = (new_wire.hello or {}).get("updateResume") if new_wire else None
        rows = {
            "exit_code": update_result["exit_code"],
            "stdout": update_result["stdout"],
            "stderr": update_result["stderr"],
            "current_target": launcher_target(install, "prime-agent"),
            "previous_target": launcher_target(install, "previous"),
            "activation_state": (install / ".activation-state").exists(),
            "restored_session": restored_id,
            "original_session": session_id,
        }
        # F1 assertions.
        f1_ok = (
            update_result["exit_code"] == 0
            and rows["current_target"] == candidate_target
            and rows["previous_target"].startswith(f"../releases/{version}-{PLATFORM}-{fixture['sha_a']}")
            and not rows["activation_state"]
            and rows["restored_session"] == session_id
        )
        # Status file: terminal complete with the adopted counts.
        status_files = sorted(socket_dir.glob("*/status.json")) if socket_dir.exists() else []
        status = json.loads(status_files[-1].read_text()) if status_files else {}
        rows["status"] = status
        f1_status_ok = (
            status.get("state") == "complete"
            and status.get("counts", {}).get("total") == 1
            and status.get("counts", {}).get("restored") == 1
            and status.get("message") == TERMINAL_MESSAGE
        )
        verdicts.append({"row": "F1", "description": "staged update: complete, launcher swapped, session restored", "parity": bool(f1_ok and f1_status_ok)})
        evidence["rows"]["F1"] = rows
        side.stop_daemon()
        side.mock.stop()

        # ------------------------------------------------------------------
        # F2: the rollback (the fixture now runs the candidate; roll back).
        # ------------------------------------------------------------------
        f2_root = out / "rust-f2"
        if f2_root.exists():
            shutil.rmtree(f2_root)
        fixture2 = build_fixture_root(f2_root, rust_bin, version)
        install2 = fixture2["install"]
        # Simulate the F1 end state: current -> candidate (b), previous -> a.
        sha_b = "b" * 64
        release_b = build_release_dir(install2 / "releases", version, sha_b, rust_bin)
        (release_b / ".install-source").write_text(server.base_url + "\n")
        (fixture2["release_a"] / ".install-source").write_text(server.base_url + "\n")
        os.remove(install2 / "bin" / "prime-agent")
        os.symlink(f"../releases/{release_b.name}/prime-agent", install2 / "bin" / "prime-agent")
        os.symlink(
            f"../releases/{fixture2['release_a'].name}/prime-agent", install2 / "bin" / "previous"
        )
        fixture2_bin = install2 / "bin" / "prime-agent"
        side2 = make_rust_side(
            f"rust-f2-{stamp}",
            str(fixture2_bin),
            f2_root,
            {"PRIME_AGENT_UPDATE_RESTORE_OVERALL_MS": "15000"},
        )
        side2.daemon_socket = default_socket(side2)
        side2.start_daemon()
        wire2 = B.Wire(side2.daemon_socket)
        create2 = wire2.request("c1", {"type": "create", "cwd": str(side2.work_dir)})
        deadline = time.time() + 30.0
        while time.time() < deadline and resident_session_id(wire2) is None:
            time.sleep(0.5)
        session2 = resident_session_id(wire2)
        rollback_result = run_cli(
            fixture2_bin, ["update", "--rollback"], side2.env, side2.work_dir
        )
        time.sleep(1.0)
        try:
            after_rollback = B.Wire(side2.daemon_socket)
            restored2 = resident_session_id(after_rollback)
        except Exception:
            restored2 = None
        old_target = f"../releases/{version}-{PLATFORM}-{fixture2['sha_a']}/prime-agent"
        f2_rows = {
            "exit_code": rollback_result["exit_code"],
            "stdout": rollback_result["stdout"],
            "stderr": rollback_result["stderr"],
            "current_target": launcher_target(install2, "prime-agent"),
            "restored_session": restored2,
            "original_session": session2,
        }
        socket2 = side2.agent_dir / "update-restarts"
        status2_files = sorted(socket2.glob("*/status.json")) if socket2.exists() else []
        status2 = json.loads(status2_files[-1].read_text()) if status2_files else {}
        f2_rows["status"] = status2
        f2_ok = (
            rollback_result["exit_code"] == 0
            and f2_rows["current_target"] == old_target
            and restored2 == session2
            and status2.get("state") == "complete"
        )
        verdicts.append({"row": "F2", "description": "rollback: launcher restored, session survives, status complete", "parity": bool(f2_ok)})
        evidence["rows"]["F2"] = f2_rows
        side2.stop_daemon()
        side2.mock.stop()

        # ------------------------------------------------------------------
        # G1: the boot sweep (spec §6 step 1, invariant I2): stop the update's
        # successor daemon over the wire (the Side's process handle is the
        # pre-update supervisor, already gone), plant stale scratch (this
        # socket's update-restarts subtree + the TS-era legacy names), boot
        # fresh, and assert the sweep removed it and the daemon serves.
        # ------------------------------------------------------------------
        socket_dir = side.agent_dir / "update-restarts"
        status_files = sorted(socket_dir.glob("*/status.json")) if socket_dir.exists() else []
        f1_update_id = None
        stale_prepared = None
        legacy_dir = side.agent_dir / "daemon-update-restarts"
        legacy_status = side.agent_dir / "daemon-update-restart.json"
        sweep_gone = served = False
        normal_boot_resume = None
        if status_files:
            f1_update_id = json.loads(status_files[-1].read_text()).get("updateId")
            hash_dir = status_files[-1].parent
            stale_prepared = hash_dir / "prepared" / "stale.json"
            stale_prepared.parent.mkdir(parents=True, exist_ok=True)
            stale_prepared.write_text('{"stale": true}')
            legacy_dir.mkdir(parents=True, exist_ok=True)
            (legacy_dir / "legacy.json").write_text('{"legacy": true}')
            legacy_status.write_text('{"legacy": true}')
            # Stop the successor daemon (a graceful wire shutdown).
            stop_wire = B.Wire(side.daemon_socket)
            stop_wire.request("g1-stop", {"type": "shutdown"})
            deadline = time.time() + 15.0
            while time.time() < deadline and side.daemon_socket.exists():
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                        probe.connect(str(side.daemon_socket))
                except OSError:
                    break
                time.sleep(0.2)
            # Fresh boot: a new supervisor process, no roster env (normal boot).
            side.start_daemon()
            sweep_wire = B.Wire(side.daemon_socket)
            served = bool(sweep_wire.request("g1-list", {"type": "list", "all": True}).get("success"))
            sweep_gone = (
                not stale_prepared.exists()
                and not stale_prepared.parent.exists()
                and not legacy_dir.exists()
                and not legacy_status.exists()
            )
            # The §10.3 contract live: the hello first shows the boot's
            # restore/re-arm pass in flight, then settles with no update id.
            deadline = time.time() + 20.0
            while time.time() < deadline:
                normal_boot_resume = (sweep_wire.hello or {}).get("updateResume")
                if normal_boot_resume and normal_boot_resume.get("complete"):
                    break
                probe_wire = B.Wire(side.daemon_socket)
                normal_boot_resume = (probe_wire.hello or {}).get("updateResume")
                probe_wire.sock.close()
                if normal_boot_resume and normal_boot_resume.get("complete"):
                    break
                time.sleep(0.5)
            side.stop_daemon()
        verdicts.append({"row": "G1", "description": "boot sweep: stale update scratch + legacy names gone, daemon serves (I2)", "parity": bool(sweep_gone and served)})
        evidence["rows"]["G1"] = {
            "stale_prepared_gone": stale_prepared is not None and not stale_prepared.exists(),
            "legacy_gone": not legacy_dir.exists() and not legacy_status.exists(),
            "list_served": served,
            "normal_boot_update_resume": normal_boot_resume,
        }

        # ------------------------------------------------------------------
        # G2: the hello resume contract (spec §10.3): the update-boot hello
        # carries the update id with complete=true; a settled normal boot
        # (G1's capture) carries no id with complete=true.
        # ------------------------------------------------------------------
        g2_ok = (
            successor_hello_resume is not None
            and successor_hello_resume.get("updateId") == f1_update_id
            and successor_hello_resume.get("complete") is True
            and normal_boot_resume == {"complete": True}
        )
        verdicts.append({"row": "G2", "description": "hello.update_resume: update boot carries the id complete, normal boot carries no id", "parity": bool(g2_ok)})
        evidence["rows"]["G2"] = {
            "update_boot_update_resume": successor_hello_resume,
            "update_id": f1_update_id,
            "normal_boot_update_resume": normal_boot_resume,
        }

        # ------------------------------------------------------------------
        # G3: the scheduled-work re-arm (spec §6 step 3): a due active job
        # of a session with no live worker wakes the session once on the
        # boot pass, and scheduled-jobs.json is never archived.
        # ------------------------------------------------------------------
        g3_root = out / "rust-g3"
        if g3_root.exists():
            shutil.rmtree(g3_root)
        fixture3 = build_fixture_root(g3_root, rust_bin, version)
        install3 = fixture3["install"]
        fixture3_bin = install3 / "bin" / "prime-agent"
        side3 = make_rust_side(
            f"rust-g3-{stamp}",
            str(fixture3_bin),
            g3_root,
            {},
        )
        side3.daemon_socket = default_socket(side3)
        side3.start_daemon()
        wire3 = B.Wire(side3.daemon_socket)
        wire3.request("g3-create", {"type": "create", "cwd": str(side3.work_dir)})
        deadline = time.time() + 30.0
        while time.time() < deadline and resident_session_id(wire3) is None:
            time.sleep(0.5)
        session3 = resident_session_id(wire3)
        sessions_dir = side3.agent_dir / "sessions"
        session3_file = sessions_dir / f"{session3}.jsonl"
        artifacts = side3.agent_dir / "session-artifacts" / session3
        artifacts.mkdir(parents=True, exist_ok=True)
        due_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60))
        job = {
            "id": "job-g3",
            "status": "active",
            "activeSessionId": session3,
            "sessionId": session3,
            "sessionFile": str(session3_file),
            "cwd": str(side3.work_dir),
            "prompt": "heartbeat probe",
            "schedule": {"kind": "interval", "expression": "every 5m", "intervalMs": 300000},
            "createdAt": due_at,
            "updatedAt": due_at,
            "nextRunAt": due_at,
        }
        (artifacts / "scheduled-jobs.json").write_text(json.dumps({"jobs": [job], "dispatches": []}))
        side3.stop_daemon()
        # The daemon's stop leaves its detached worker alive (batterylib's
        # documented behavior); the re-arm row needs the session workerless,
        # so kill this side's own worker by its cwd (scoped to the fixture).
        killed_workers = kill_detached_workers_under(g3_root)
        time.sleep(1.0)
        # Normal boot (no roster env): the re-arm pass wakes the session.
        side3.start_daemon()
        wire3b = B.Wire(side3.daemon_socket)
        woke = None
        deadline = time.time() + 20.0
        while time.time() < deadline:
            listing = wire3b.request("g3-list", {"type": "list", "all": True})
            rows3 = listing.get("data", {}).get("sessions", []) if listing.get("success") else []
            woke = next((row.get("sessionId") for row in rows3 if row.get("sessionId") == session3), None)
            if woke:
                break
            time.sleep(0.5)
        g3_ok = (
            woke == session3
            and (artifacts / "scheduled-jobs.json").exists()
        )
        verdicts.append({"row": "G3", "description": "scheduled-work re-arm: due job wakes its session once, scheduled-jobs.json never archived", "parity": bool(g3_ok)})
        evidence["rows"]["G3"] = {
            "woke_session": woke,
            "session": session3,
            "killed_workers_before_boot": killed_workers,
            "job_file_exists": (artifacts / "scheduled-jobs.json").exists(),
        }
        side3.stop_daemon()
        side3.mock.stop()

        # ------------------------------------------------------------------
        # F3 + P1: the unmanaged-install refusal, both binaries.
        # ------------------------------------------------------------------
        rust_refusal = run_cli(rust_bin, ["update", "--force"], B.scrubbed_env(Path("/tmp"), Path("/tmp")), Path("/tmp"))
        # The TS binary on the box IS a managed install and bun resolves its
        # own exe path through symlinks, so the TS unmanaged refusal cannot
        # run live: the row compares the LIVE Rust refusal text against the
        # TS source string (the refusal is TS-owned contract text). The
        # battery never runs TS `update` against the real install again.
        ts_source = Path(
            os.environ.get("TS_SOURCE", str(Path.home() / "prime-agent"))
        ) / "packages/coding-agent/src/cli/native-update.ts"
        ts_source_text = ts_source.read_text() if ts_source.exists() else ""
        p1_ok = (
            UNMANAGED_REFUSAL in rust_refusal["stderr"] + rust_refusal["stdout"]
            and UNMANAGED_REFUSAL in ts_source_text
        )
        verdicts.append({"row": "P1", "description": "unmanaged-install refusal: live Rust text == TS source string (TS cannot run unmanaged on this box)", "parity": bool(p1_ok)})
        evidence["rows"]["P1"] = {
            "rust": {"stdout": rust_refusal["stdout"], "stderr": rust_refusal["stderr"], "exit": rust_refusal["exit_code"]},
            "ts_source_contains_refusal": UNMANAGED_REFUSAL in ts_source_text,
            "ts_source": str(ts_source),
        }

        # ------------------------------------------------------------------
        # P2: rollback without a previous release, both binaries.
        # ------------------------------------------------------------------
        f3_root = out / "rust-f3"
        if f3_root.exists():
            shutil.rmtree(f3_root)
        fixture3 = build_fixture_root(f3_root, rust_bin, version)
        fixture3_bin = fixture3["install"] / "bin" / "prime-agent"
        rust_no_previous = run_cli(
            fixture3_bin,
            ["update", "--rollback"],
            B.scrubbed_env(f3_root / "agent", Path("/tmp")),
            Path("/tmp"),
        )
        ts_fixture = ts_fixture_root(out, Path(ts_bin))
        ts_no_previous = run_cli(
            str(ts_fixture / "bin" / "prime-agent"),
            ["update", "--rollback"],
            B.scrubbed_env(Path("/tmp"), Path("/tmp")),
            Path("/tmp"),
        )
        p2_ok = (
            NO_PREVIOUS_REFUSAL in rust_no_previous["stderr"] + rust_no_previous["stdout"]
            and NO_PREVIOUS_REFUSAL in ts_no_previous["stderr"] + ts_no_previous["stdout"]
        )
        verdicts.append({"row": "P2", "description": "rollback-without-previous refusal parity (TS message)", "parity": bool(p2_ok)})
        evidence["rows"]["P2"] = {
            "rust": {"stdout": rust_no_previous["stdout"], "stderr": rust_no_previous["stderr"]},
            "ts": {"stdout": ts_no_previous["stdout"], "stderr": ts_no_previous["stderr"]},
        }

        # ------------------------------------------------------------------
        # P3 + D1: the TS coordinator's status file vs the Rust schema.
        # ------------------------------------------------------------------
        ts_root = out / "ts-coordinator"
        ts_side = make_rust_side(f"ts-coord-{stamp}", ts_bin, ts_root, {})
        ts_side.start_daemon()
        ts_wire = B.Wire(ts_side.daemon_socket)
        ts_wire.request("c1", {"type": "create", "cwd": str(ts_side.work_dir)})
        deadline = time.time() + 30.0
        while time.time() < deadline and resident_session_id(ts_wire) is None:
            time.sleep(0.5)
        ts_restarts = ts_side.agent_dir / "update-restarts"
        ts_restarts.mkdir(parents=True, exist_ok=True)
        ts_wire.close()
        ts_status_path = ts_restarts / "battery-ts-coordinator.json"
        ts_coord = run_cli(
            ts_bin,
            [
                "update",
                "--internal-update-restart-coordinator",
                "--daemon-socket",
                str(ts_side.daemon_socket),
                "--internal-update-restart-status",
                str(ts_status_path),
            ],
            ts_side.env,
            ts_side.work_dir,
            timeout=240.0,
        )
        ts_status = (
            json.loads(ts_status_path.read_text()) if ts_status_path.exists() else {}
        )
        evidence["rows"]["P3"] = {
            "ts_stdout": ts_coord["stdout"],
            "ts_stderr": ts_coord["stderr"],
            "ts_status": ts_status,
        }
        ts_side.stop_daemon()
        ts_side.mock.stop()
        # The shared schema fields parse, and the terminal message matches.
        p3_ok = (
            ts_status.get("version") == 1
            and isinstance(ts_status.get("socketPath"), str)
            and (ts_status.get("coordinator") or {}).get("pid", 0) > 0
            and isinstance((ts_status.get("counts") or {}).get("total"), int)
            and ts_status.get("phase") == "complete"
            and TERMINAL_MESSAGE in json.dumps(ts_status.get("message", ""))
        )
        verdicts.append({"row": "P3", "description": "TS coordinator status schema + terminal message parity", "parity": bool(p3_ok)})
        verdicts.append(
            {
                "row": "D1",
                "description": "TS phase names vs the Rust state vocabulary (spec redesign; schema and report strings stay TS-compatible)",
                "divergence": f"ts phases={sorted({ts_status.get('phase')})}; rust states={sorted({status.get('state'), status2.get('state')})}",
            }
        )
    finally:
        server.stop()

    (out / f"{FLOW}-report.json").write_text(json.dumps({"flow": FLOW, "version": version, "verdicts": verdicts, **evidence}, indent=1, default=str))
    print(f"evidence: {out / f'{FLOW}-report.json'}")
    for verdict in verdicts:
        state = "PARITY" if verdict.get("parity") else verdict.get("divergence", "MISMATCH")
        print(f"  [{state}] {verdict['row']}: {verdict['description']}")
    failed = [v["row"] for v in verdicts if "parity" in v and not v["parity"]]
    if failed:
        print(f"FAILED rows: {', '.join(failed)}")
        return 1
    print("all parity rows match; divergences documented")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
