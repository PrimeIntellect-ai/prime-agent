#!/usr/bin/env python3
"""Exercise the packed bridge at the historical npm entrypoint.

The installer fixture isolates launcher behavior; the legacy-update end-to-end
suite separately exercises the real Rust installer and published TS clients.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import npm_bridge
from npm_bridge import assemble


@unittest.skipUnless(sys.platform in ("darwin", "linux") and shutil.which("node") and shutil.which("npm"),
                     "requires Node and npm on a historical TypeScript platform")
class NpmBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.fallback_tarball = self.root / "fallback.tgz"
        fallback_files = {
            "package/package.json": json.dumps({"name": "prime-agent", "version": "0.9.8",
                "dependencies": {}, "scripts": {"postinstall": "exit 91"}}).encode(),
            "package/dist/bundle/cli-node.js": b'''#!/usr/bin/env node
if (process.argv[2] === "--version") console.log("0.9.8");
else if (process.argv[2] === "entrypoint") console.log(process.argv[1]);
else if (process.argv[2] === "prefix") console.log(process.env.npm_config_prefix);
else if (process.argv[2] === "descriptor") console.log(require("node:fs").readFileSync(Number(process.env.TEST_DESCRIPTOR), "utf8"));
else if (process.argv[2] === "ipc") { process.send({fallback:true}); process.disconnect(); }
else if (process.argv.includes("update") && !process.argv.includes("--print")) {
  if (process.env.PRIME_AGENT_INTERNAL_TS_UPDATE) throw new Error("delegation flag leaked into the TS updater");
  const {spawnSync}=require("node:child_process");
  let installed={status:0};
  if (process.env.FUTURE_BRIDGE_TARBALL) {
    installed=spawnSync("npm",["install","--global","--ignore-scripts","--no-audit","--no-fund",
      "--prefix",process.env.npm_config_prefix,process.env.FUTURE_BRIDGE_TARBALL],{encoding:"utf8"});
  }
  if (installed.status !== 0) { console.error(installed.stderr); process.exitCode=installed.status || 1; }
  else {
    // Historical TS CLI warns on a failed coordinator but can still exit zero.
    // The outer bridge must verify activation instead of trusting that status.
    const result=spawnSync(process.execPath,[process.argv[1],"update","--internal-update-restart-coordinator"],
      {env:{...process.env,EXPECT_DEFER:"1"},stdio:"ignore"});
    if (result.status !== 0) console.error("TypeScript coordinator warning: native migration failed");
    process.exitCode=0;
  }
}
else console.log(JSON.stringify({fallback:true,args:process.argv.slice(2)}));
''',
        }
        with tarfile.open(self.fallback_tarball, "w:gz") as archive:
            for name, data in fallback_files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = 0o755
                archive.addfile(member, io.BytesIO(data))
        # Unit tests use an offline synthetic payload; release code has no
        # checksum override and only accepts the immutable published archive.
        fallback_pin = patch.object(npm_bridge, "FALLBACK_SHA256",
                                    hashlib.sha256(self.fallback_tarball.read_bytes()).hexdigest())
        fallback_pin.start()
        self.addCleanup(fallback_pin.stop)
        self.prefix = self.root / "native prefix"
        self.npm_prefix = self.root / "npm prefix"
        self.installs = self.root / "installs"
        self.fixture = self.root / "native.js"
        self.fixture.write_text('''#!/usr/bin/env node
if (process.argv[2] === "wait") { console.log("ready"); setInterval(() => {}, 1000); }
else if (process.argv[2] === "--version") console.log(require("node:fs").readFileSync(require("node:path").join(__dirname,"version"),"utf8").trim());
else if (process.argv[2] === "socket") console.log(process.env.PRIME_AGENT_DAEMON_SOCKET);
else if (process.argv[2] === "signal") process.kill(process.pid, "SIGTERM");
else { console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.NATIVE_EXIT || 0); }
''')
        self.fixture.chmod(0o755)
        (self.repo / "install-rust.sh").write_text('''#!/bin/sh
set -eu
test "$PRIME_AGENT_VERSION" = "${EXPECT_VERSION:-1.0.0}"
test "$PRIME_AGENT_RELEASE_CHANNEL" = "stable"
test "$PRIME_AGENT_PRESERVE_NPM_BRIDGE" = "1"
test -f "$PRIME_AGENT_NPM_BRIDGE_ENTRYPOINT"
echo install >> "$INSTALL_LOG"
echo "installer output stays on stderr"
if [ "${FAIL_INSTALL:-0}" = 1 ]; then exit 23; fi
test "$PRIME_AGENT_DEFER_DAEMON_STOP" = "${EXPECT_DEFER:-0}"
test "$PRIME_AGENT_USE_LEGACY_DAEMON_SOCKET" = 1
mkdir -p "$PRIME_AGENT_RUST_PREFIX/share/prime-agent"
cp "$FIXTURE_NATIVE" "$PRIME_AGENT_RUST_PREFIX/share/prime-agent/prime-agent"
printf '%s\\n' "$PRIME_AGENT_VERSION" > "$PRIME_AGENT_RUST_PREFIX/share/prime-agent/version"
mkdir -p "$PRIME_AGENT_RUST_PREFIX/share/.prime-agent-npm-bridge"
touch "$PRIME_AGENT_RUST_PREFIX/share/.prime-agent-npm-bridge/legacy-daemon-socket"
''')
        self.out = self.root / "out"
        self.metadata = assemble(self.repo, self.out, "1.0.0", "stable", self.fallback_tarball)
        self.env = {**os.environ, "PRIME_AGENT_RUST_PREFIX": str(self.prefix),
                    "INSTALL_LOG": str(self.installs), "FIXTURE_NATIVE": str(self.fixture),
                    "npm_config_cache": str(self.root / "npm-cache")}
        self.env.pop("NODE_OPTIONS", None)
        installed = subprocess.run(["npm", "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund",
                        "--prefix", str(self.npm_prefix), str(self.out / self.metadata["tarball"])],
                       env=self.env, capture_output=True, text=True)
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.entrypoint = self.npm_prefix / "lib/node_modules/prime-agent/dist/bundle/cli.js"

    def launch(self, *args, **environment):
        return subprocess.run(["node", str(self.entrypoint), *args],
                              env={**self.env, **environment}, capture_output=True, text=True, timeout=10)

    def test_npm_install_does_not_migrate_until_old_entrypoint_relaunches(self):
        self.assertFalse(self.installs.exists())
        args = ("--internal-update-restart-coordinator", "a space", "line\nbreak", "--", "-x")
        result = self.launch(*args, NATIVE_EXIT="37", EXPECT_DEFER="1")
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertEqual(json.loads(result.stdout), list(args))
        self.assertIn("installer output stays on stderr", result.stderr)
        self.assertTrue(self.entrypoint.exists(), "migration must preserve the active npm package")

    def test_later_ts_node_fallback_entrypoint_survives_npm_replacement(self):
        # v0.9.5+ cli.js shims spawn cli-node.js. Their update coordinator
        # retains that absolute filename after npm replaces the package.
        self.entrypoint = self.entrypoint.with_name("cli-node.js")
        args = ("update", "--internal-update-restart-coordinator", "a space", "--", "-x")
        result = self.launch(*args, NATIVE_EXIT="37", EXPECT_DEFER="1")
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertEqual(json.loads(result.stdout), list(args))
        self.assertTrue(self.entrypoint.exists())

    def test_earliest_ts_entrypoint_resolves_package_root_after_replacement(self):
        # Early published packages capture dist/cli.js. Its compatibility shim
        # must resolve the bundled installer from the actual package root.
        self.entrypoint = self.entrypoint.parents[1] / "cli.js"
        args = ("update", "--internal-update-restart-coordinator", "a space", "--", "-x")
        result = self.launch(*args, NATIVE_EXIT="37", EXPECT_DEFER="1")
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertEqual(json.loads(result.stdout), list(args))
        self.assertTrue(self.entrypoint.exists())

    def test_native_self_update_does_not_trigger_pinned_downgrade(self):
        self.assertEqual(self.launch("first").returncode, 0)
        # A subsequent native update replaces its payload, but the npm shim
        # must keep forwarding to it without reinstalling the old pinned release.
        payload = self.prefix / "share/prime-agent"
        shutil.rmtree(payload)
        payload.mkdir()
        shutil.copy2(self.fixture, payload / "prime-agent")
        result = self.launch("after-native-update")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installs.read_text(), "install\n")

    def test_completed_migration_launch_does_not_wait_for_migration_lock(self):
        self.assertEqual(self.launch("first").returncode, 0)
        lock = self.prefix / "share/.prime-agent-npm-bridge/migration.lock"
        lock.write_text(json.dumps({"pid": os.getpid(), "token": "another-install"}))
        result = self.launch("already-installed")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ["already-installed"])
        self.assertEqual(self.installs.read_text(), "install\n")
        self.assertTrue(lock.exists(), "ordinary launch must not modify another install's lock")

    def test_new_npm_package_version_does_not_reuse_previous_migration_receipt(self):
        self.assertEqual(self.launch("first").returncode, 0)
        package_path = self.entrypoint.parents[2] / "package.json"
        package = json.loads(package_path.read_text())
        package["version"] = "1.1.0"
        package_path.write_text(json.dumps(package))
        result = self.launch("upgraded-package", EXPECT_VERSION="1.1.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ["upgraded-package"])
        self.assertEqual(self.installs.read_text(), "install\ninstall\n")

    def test_failed_install_does_not_activate_or_record_success(self):
        result = self.launch("update", FAIL_INSTALL="1")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse((self.prefix / "share/.prime-agent-npm-bridge/1.0.0").exists())
        self.assertEqual(self.launch("update").returncode, 0)
        self.assertEqual(self.installs.read_text(), "install\ninstall\n")

    def test_failed_native_install_keeps_working_typescript_without_repeated_attempts(self):
        result = self.launch("a prompt", FAIL_INSTALL="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"fallback": True, "args": ["a prompt"]})
        self.assertIn("Rust 1.0.0 migration failed", result.stderr)
        self.assertIn("Continuing with TypeScript 0.9.8", result.stderr)
        again = self.launch("--version", FAIL_INSTALL="1")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(again.stdout.strip(), "0.9.8")
        self.assertEqual(self.installs.read_text(), "install\n")
        retry = self.launch("update", FAIL_INSTALL="1")
        self.assertNotEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(retry.stdout, "", "failed update must not recurse through the TS updater")
        self.assertEqual(self.installs.read_text(), "install\ninstall\n")

    def test_explicit_update_after_fallback_fetches_new_bridge_and_installer(self):
        self.assertEqual(self.launch("--version", FAIL_INSTALL="1").stdout.strip(), "0.9.8")
        future = assemble(self.repo, self.root / "future", "1.1.0", "stable", self.fallback_tarball)
        result = self.launch("--offline", "--daemon-socket", str(self.root / "socket"), "update",
                             FUTURE_BRIDGE_TARBALL=str(self.root / "future" / future["tarball"]),
                             EXPECT_VERSION="1.1.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        package = json.loads((self.entrypoint.parents[2] / "package.json").read_text())
        self.assertEqual(package["version"], "1.1.0")
        self.assertTrue((self.prefix / "share/.prime-agent-npm-bridge/1.1.0").exists())
        self.assertEqual(self.launch("--version").stdout.strip(), "1.1.0")

    def test_new_bridge_that_still_cannot_install_rust_is_not_reported_as_success(self):
        self.assertEqual(self.launch("--version", FAIL_INSTALL="1").stdout.strip(), "0.9.8")
        future = assemble(self.repo, self.root / "future", "1.1.0", "stable", self.fallback_tarball)
        result = self.launch("update", FUTURE_BRIDGE_TARBALL=str(self.root / "future" / future["tarball"]),
                             EXPECT_VERSION="1.1.0", FAIL_INSTALL="1")
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("did not activate a working Rust release", result.stderr)
        self.assertEqual(self.launch("--version").stdout.strip(), "0.9.8")

    def test_update_after_global_options_fails_honestly_but_update_prompt_can_fallback(self):
        result = self.launch("--offline", "--daemon-socket", str(self.root / "socket"),
                             "update", FAIL_INSTALL="1")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(result.stdout, "")
        prompt = self.launch("--print", "update")
        self.assertEqual(prompt.returncode, 0, prompt.stderr)
        self.assertEqual(json.loads(prompt.stdout), {"fallback": True, "args": ["--print", "update"]})

    def test_coordinator_failure_remains_failed_while_later_commands_use_typescript(self):
        status = self.root / "agent/update-restarts/failed.json"
        result = self.launch("update", "--internal-update-restart-coordinator",
                             "--internal-update-restart-status", str(status),
                             FAIL_INSTALL="1", EXPECT_DEFER="1")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(json.loads(status.read_text())["phase"], "failed")
        self.assertEqual(result.stdout, "")
        self.assertEqual(self.launch("--version").stdout.strip(), "0.9.8")

    def test_fallback_self_update_captures_public_bridge_entrypoint(self):
        result = self.launch("entrypoint", FAIL_INSTALL="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(self.entrypoint))
        self.assertEqual(self.launch("prefix").stdout.strip(), str(self.npm_prefix))

    def test_fallback_preserves_inherited_worker_descriptor(self):
        channel = self.root / "worker-channel"
        channel.write_text("worker ready")
        descriptor = os.open(channel, os.O_RDONLY)
        try:
            result = subprocess.run(["node", str(self.entrypoint), "descriptor"],
                                    env={**self.env, "FAIL_INSTALL": "1", "TEST_DESCRIPTOR": str(descriptor)},
                                    pass_fds=(descriptor,), capture_output=True, text=True, timeout=10)
        finally:
            os.close(descriptor)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "worker ready")

    def test_fallback_preserves_node_catalog_ipc_channel(self):
        driver = '''
const {fork}=require("node:child_process");
const child=fork(process.argv[1],["ipc"],{execArgv:[],stdio:["ignore","pipe","pipe","ipc"]});
child.stderr.pipe(process.stderr);
child.on("message",value=>console.log(JSON.stringify(value)));
child.on("exit",code=>{process.exitCode=code;});
'''
        result = subprocess.run(["node", "-e", driver, str(self.entrypoint)],
                                env={**self.env, "FAIL_INSTALL": "1"},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"fallback": True})

    def test_native_signal_status_is_preserved(self):
        result = self.launch("signal")
        self.assertEqual(result.returncode, -signal.SIGTERM, result.stderr)

    def test_signal_to_npm_launcher_reaches_native_child(self):
        with subprocess.Popen(["node", str(self.entrypoint), "wait"], env=self.env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as child:
            self.assertEqual(child.stdout.readline(), "ready\n")
            child.send_signal(signal.SIGTERM)
            _, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, -signal.SIGTERM, stderr)

    def test_missing_native_install_is_repaired(self):
        self.assertEqual(self.launch().returncode, 0)
        (self.prefix / "share/prime-agent/prime-agent").unlink()
        self.assertEqual(self.launch().returncode, 0)
        self.assertEqual(self.installs.read_text(), "install\ninstall\n")

    def test_npm_and_native_prefix_overlap_does_not_recurse(self):
        self.prefix = self.npm_prefix
        self.env["PRIME_AGENT_RUST_PREFIX"] = str(self.prefix)
        self.assertEqual(self.launch("first").returncode, 0)
        # npm owns this link and may replace it during npm install at any time.
        command = self.prefix / "bin/prime-agent"
        self.assertEqual(command.resolve(), self.entrypoint.resolve())
        result = subprocess.run([str(command), "after-npm-reinstall"], env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), ["after-npm-reinstall"])
        self.assertEqual(self.installs.read_text(), "install\n")

    def test_later_launch_keeps_migrated_daemon_socket_namespace(self):
        self.env.pop("PRIME_AGENT_DAEMON_SOCKET", None)
        self.env["TMPDIR"] = str(self.root / "sockets")
        self.assertEqual(self.launch("--internal-update-restart-coordinator", EXPECT_DEFER="1").returncode, 0)
        expected = str(self.root / "sockets" / f"prime-agent-{os.getuid()}" / "daemon.sock")
        result = self.launch("socket")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), expected)
        custom = self.launch("socket", PRIME_AGENT_DAEMON_SOCKET=str(self.root / "custom.sock"))
        self.assertEqual(custom.stdout.strip(), str(self.root / "custom.sock"))

    def test_real_installer_preserves_node_relaunch_only_for_its_npm_bridge(self):
        installer = (Path(__file__).resolve().parents[2] / "install-rust.sh").read_text()
        section = installer.split("# --- the launcher (the takeover lives here)", 1)[1]
        section = section.split("# The cmd/PowerShell launcher twin", 1)[0]
        # Reuse the real published launcher section, not the fixture installer:
        # an old TUI captures the public symlink path in Node's argv before npm
        # replaces the package. That path must still contain JavaScript later.
        section = "# --- the launcher (the takeover lives here)" + section
        self.env["PRIME_AGENT_RUST_PREFIX"] = str(self.npm_prefix)
        payload = self.npm_prefix / "share/prime-agent"
        payload.mkdir(parents=True)
        shutil.copyfile(self.fixture, payload / "prime-agent")
        (payload / "prime-agent").chmod(0o755)
        (payload / "version").write_text("1.0.0\n")
        receipt_dir = self.npm_prefix / "share/.prime-agent-npm-bridge"
        receipt_dir.mkdir()
        (receipt_dir / "1.0.0").write_text("installed\n")
        command = self.npm_prefix / "bin/prime-agent"
        foreign_entry = self.root / "unrelated.js"
        foreign_entry.write_text(self.entrypoint.read_text())
        for flag, target, preserved in (("1", self.entrypoint, True),
                                        ("1", foreign_entry, False),
                                        ("0", self.entrypoint, False)):
            with self.subTest(flag=flag, target=target):
                command.unlink(missing_ok=True)
                command.symlink_to(target)
                result = subprocess.run(["sh", "-eu"], input='''
PREFIX="$PRIME_AGENT_RUST_PREFIX"
bin_dir="$PREFIX/bin"
launcher="$bin_dir/prime-agent"
WINDOWS=no
say() { :; }; note() { :; }; die() { echo "$*" >&2; exit 1; }
trap '[ -z "${launcher_tmp:-}" ] || rm -f "$launcher_tmp"' EXIT
''' + section + '\n"$install_probe_launcher" --version\n',
                    text=True, capture_output=True, timeout=10, env={**self.env,
                        "PRIME_AGENT_PRESERVE_NPM_BRIDGE": flag,
                        "PRIME_AGENT_NPM_BRIDGE_ENTRYPOINT": str(self.entrypoint),
                        "PRIME_AGENT_USE_LEGACY_DAEMON_SOCKET": "1"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "1.0.0")
                self.assertEqual(command.is_symlink(), preserved)
                invocation = ["node", str(command)] if preserved else [str(command)]
                relaunched = subprocess.run([*invocation, "--version"], env=self.env,
                                            text=True, capture_output=True, timeout=10)
                self.assertEqual(relaunched.returncode, 0, relaunched.stderr)
                self.assertEqual(relaunched.stdout.strip(), "1.0.0")
                self.assertEqual(list(command.parent.glob(".prime-agent.*")), [])

    def test_stale_bridge_does_not_downgrade_newer_native_without_receipt(self):
        payload = self.prefix / "share/prime-agent"
        payload.mkdir(parents=True)
        executable = payload / "prime-agent"
        executable.write_text('''#!/usr/bin/env node
if (process.argv[2] === "--version") console.log("prime-agent 1.2.0");
else if (process.argv[2] === "socket") console.log(process.env.PRIME_AGENT_DAEMON_SOCKET);
else console.log(JSON.stringify(process.argv.slice(2)));
''')
        executable.chmod(0o755)
        result = self.launch("keep-newer")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.installs.exists())
        self.assertEqual(json.loads(result.stdout), ["keep-newer"])
        self.env.pop("PRIME_AGENT_DAEMON_SOCKET", None)
        self.env["TMPDIR"] = str(self.root / "sockets")
        expected = str(self.root / "sockets" / f"prime-agent-rust-{os.getuid()}" / "daemon.sock")
        self.assertEqual(self.launch("socket").stdout.strip(), expected)

    def test_concurrent_first_launches_install_once(self):
        processes = [subprocess.Popen(["node", str(self.entrypoint), str(i)], env=self.env,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for i in range(4)]
        try:
            for i, child in enumerate(processes):
                stdout, stderr = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, stderr)
                self.assertEqual(json.loads(stdout), [str(i)])
        finally:
            for child in processes:
                if child.poll() is None:
                    child.kill()
                child.wait()
        self.assertEqual(self.installs.read_text(), "install\n")

    def test_coordinator_status_exists_before_install_and_defers_daemon_stop(self):
        status = self.root / "agent/update-restarts/status.json"
        installer = self.repo / "install-rust.sh"
        installer.write_text(installer.read_text() + '\ntest -s "$TEST_RESTART_STATUS"\n')
        assemble(self.repo, self.out, "1.0.0", "stable", self.fallback_tarball)
        # Replace the installed fixture, preserving the real npm entrypoint.
        shutil.copy2(installer, self.entrypoint.parents[2] / "install-rust.sh")
        args = ["update", "--internal-update-restart-coordinator", "--internal-update-restart-status",
                str(status), "--daemon-socket", str(self.root / "old.sock")]
        result = self.launch(*args, EXPECT_DEFER="1", TEST_RESTART_STATUS=str(status))
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(status.read_text())
        self.assertEqual(value["phase"], "starting")
        self.assertEqual(value["socketPath"], str(self.root / "old.sock"))
        self.assertEqual(json.loads(result.stdout), args)

    def test_archive_is_deterministic_and_has_no_lifecycle_scripts(self):
        other = assemble(self.repo, self.root / "other", "1.0.0", "stable", self.fallback_tarball)
        self.assertEqual(other, self.metadata)
        with tarfile.open(self.out / self.metadata["tarball"]) as archive:
            package = json.load(archive.extractfile("package/package.json"))
        self.assertNotIn("scripts", package)
        self.assertTrue(package["primeAgentRustBridge"])

    def test_real_installer_keeps_bridge_but_retires_ts_package(self):
        installer = (Path(__file__).resolve().parents[2] / "install-rust.sh").read_text()
        retirement = installer.split("# The TS npm package:", 1)[1].split(
            "# --- the kernel pre-warm:", 1)[0]
        retirement = "# The TS npm package:" + retirement
        fake_bin = self.root / "fake-bin"
        fake_bin.mkdir()
        npm_root = self.root / "npm-root"
        package_dir = npm_root / "prime-agent"
        package_dir.mkdir(parents=True)
        uninstalls = self.root / "uninstalls"
        fake_npm = fake_bin / "npm"
        fake_npm.write_text('''#!/bin/sh
if [ "$1" = root ]; then echo "$TEST_NPM_ROOT"; else echo uninstall >> "$TEST_UNINSTALL_LOG"; fi
''')
        fake_npm.chmod(0o755)
        for flag, bridge, expected in (("1", False, False), ("", True, False), ("", False, True)):
            with self.subTest(flag=flag, bridge=bridge):
                uninstalls.unlink(missing_ok=True)
                (package_dir / "package.json").write_text(json.dumps({
                    "name": "prime-agent", "version": "1.0.0" if bridge else "0.9.8",
                    "primeAgentRustBridge": bridge}))
                result = subprocess.run(["sh", "-eu"], input='''
WINDOWS=no
step_start() { :; }; step_ok() { :; }; step_fail() { :; }; note() { :; }; todo() { :; }
''' + retirement, text=True, capture_output=True, env={**self.env,
                    "PATH": str(fake_bin) + os.pathsep + self.env["PATH"],
                    "UVPY": sys.executable, "TEST_NPM_ROOT": str(npm_root),
                    "TEST_UNINSTALL_LOG": str(uninstalls), "PRIME_AGENT_PRESERVE_NPM_BRIDGE": flag})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(uninstalls.exists(), expected)


if __name__ == "__main__":
    unittest.main()
