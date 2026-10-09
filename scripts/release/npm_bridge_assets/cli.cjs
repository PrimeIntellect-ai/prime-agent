#!/usr/bin/env node
"use strict";

// Ship this at dist/bundle/cli.js and cli-node.js: historical updaters relaunch
// their original absolute entrypoint, including the later shim's Node fallback.
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const packageRoot = path.resolve(__dirname, "../..");
const metadata = require(path.join(packageRoot, "package.json"));
const prefix = path.resolve(process.env.PRIME_AGENT_RUST_PREFIX || path.join(os.homedir(), ".local"));
// npm may recreate prefix/bin/prime-agent as this package's symlink on every
// reinstall. Invoke the payload directly, never that mutually managed path.
const executable = path.join(prefix, "share", "prime-agent", "prime-agent");
const args = process.argv.slice(2);
const coordinator = args.includes("--internal-update-restart-coordinator");
const delegatedUpdate = process.env.PRIME_AGENT_INTERNAL_TS_UPDATE === "1";
// A delegated TS updater may spawn the new bridge's restart coordinator. That
// coordinator must perform migration, never delegate back into the TS updater.
delete process.env.PRIME_AGENT_INTERNAL_TS_UPDATE;
let updateRequested = coordinator;
// Recognize updates after leading global options without interpreting prompt
// text such as `--print update` as an update retry. The value options mirror
// the genuine fallback CLI's leading-global-flags contract.
const valueFlags = new Set(["--mode", "--daemon-socket", "--provider", "--model", "--api-key",
  "--cwd", "--system-prompt", "--append-system-prompt", "--fork", "--session-dir", "--models",
  "--tools", "-t", "--thinking", "--extension", "-e", "--skill", "--prompt-template", "--theme",
  "--autonomous-gate", "--autonomous-gate-retries", "--autonomous-gate-timeout-ms",
  "--autonomous-max-continuations", "--autonomous-max-turns", "--autonomous-max-tokens",
  "--autonomous-timeout-ms", "--goal", "--goal-token-budget", "--print", "-p"]);
let promptRun = false;
for (let index = 0; !coordinator && index < args.length; index++) {
  const arg = args[index];
  if (arg === "--") break;
  if (["--print", "-p", "--system-prompt", "--append-system-prompt"].includes(arg)) promptRun = true;
  if (!arg.startsWith("-")) { updateRequested = !promptRun && arg === "update"; break; }
  if (valueFlags.has(arg) && args[index + 1] !== undefined && args[index + 1] !== "--") index++;
  else if ((arg === "--resume" || arg === "-r") && args[index + 1] &&
           !args[index + 1].startsWith("-") && !args[index + 1].startsWith("@")) index++;
}
// Keep migration state outside the payload replaced by native updates.
const receiptDir = path.join(prefix, "share", ".prime-agent-npm-bridge");
const receipt = path.join(receiptDir, metadata.version);
const failedReceipt = `${receipt}.failed`;
const legacySocketMarker = path.join(receiptDir, "legacy-daemon-socket");
const legacySocket = path.join(os.tmpdir(), `prime-agent-${process.getuid()}`, "daemon.sock");
const nativeEnvironment = { ...process.env,
  PRIME_AGENT_CODING_AGENT_DIR: process.env.PRIME_AGENT_CODING_AGENT_DIR || path.join(os.homedir(), ".prime/agent"),
  PRIME_AGENT_DAEMON_SOCKET: process.env.PRIME_AGENT_DAEMON_SOCKET ||
    (coordinator || fs.existsSync(legacySocketMarker) ? legacySocket :
      path.join(process.env.TMPDIR || "/tmp", `prime-agent-rust-${process.getuid()}`, "daemon.sock")),
};
delete nativeEnvironment.PI_PACKAGE_DIR;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    let child;
    let requestedSignal;
    let forceTimer;
    let timeout;
    let timedOut = false;
    const terminate = signal => {
      if (!child?.pid) return;
      if (options.detached) {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    const handlers = signals.map(signal => {
      const handler = () => {
        requestedSignal ||= signal;
        terminate(signal);
        if (options.detached) {
          forceTimer ||= setTimeout(() => terminate("SIGKILL"), 1000);
          forceTimer.unref();
        }
      };
      process.on(signal, handler);
      return handler;
    });
    const cleanup = () => {
      if (options.detached && (requestedSignal || timedOut)) terminate("SIGKILL");
      clearTimeout(forceTimer);
      clearTimeout(timeout);
      signals.forEach((signal, i) => process.removeListener(signal, handlers[i]));
    };
    try {
      child = spawn(command, args, { stdio: "inherit", ...spawnOptions });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      resolve({ code, signal: requestedSignal || signal, timedOut });
    });
    if (timeoutMs) timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      forceTimer ||= setTimeout(() => terminate("SIGKILL"), 1000);
      forceTimer.unref();
    }, timeoutMs);
    if (requestedSignal) terminate(requestedSignal);
  });
}

function finish(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

function versionAtLeast(actual, wanted) {
  const valid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (!valid.test(actual) || !valid.test(wanted)) return false;
  const [haveCore, havePre] = actual.split(/-(.*)/s);
  const [wantCore, wantPre] = wanted.split(/-(.*)/s);
  const have = haveCore.split(".").map(Number), want = wantCore.split(".").map(Number);
  let ordering = 0;
  for (let i = 0; i < 3 && !ordering; i++) ordering = Math.sign(have[i] - want[i]);
  if (!ordering && havePre !== wantPre) {
    if (havePre === undefined) ordering = 1;
    else if (wantPre === undefined) ordering = -1;
    else {
      const a = havePre.split("."), b = wantPre.split(".");
      for (let i = 0; i < Math.max(a.length, b.length) && !ordering; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] === undefined) ordering = -1;
        else if (b[i] === undefined) ordering = 1;
        else if (/^\d+$/.test(a[i]) && /^\d+$/.test(b[i])) ordering = Math.sign(Number(a[i]) - Number(b[i]));
        else if (/^\d+$/.test(a[i]) !== /^\d+$/.test(b[i])) ordering = /^\d+$/.test(a[i]) ? -1 : 1;
        else ordering = a[i] > b[i] ? 1 : -1;
      }
    }
  }
  return ordering >= 0;
}

async function launchFallback(reason) {
  const fallback = metadata.primeAgentTypeScriptFallback;
  if (!fallback) throw new Error("The TypeScript recovery payload is missing from this package");
  const fallbackRoot = path.join(packageRoot, fallback.directory);
  const fallbackMetadata = JSON.parse(fs.readFileSync(path.join(fallbackRoot, "package.json"), "utf8"));
  if (fallbackMetadata.name !== "prime-agent" || fallbackMetadata.version !== fallback.version) {
    throw new Error("The TypeScript recovery payload has an unexpected package identity");
  }
  if (delegatedUpdate) console.error("prime-agent: Checking the latest release with the preserved TypeScript updater.");
  else {
    console.error(`prime-agent: Rust ${metadata.version} migration failed: ${reason}`);
    console.error(`prime-agent: Continuing with TypeScript ${fallback.version}. Run prime-agent update to retry the Rust upgrade.`);
  }
  const environment = { ...process.env, PI_PACKAGE_DIR: fallbackRoot, PRIME_AGENT_INSTALL_METHOD: "node" };
  const modules = path.dirname(packageRoot);
  if (path.basename(modules) === "node_modules" && path.basename(path.dirname(modules)) === "lib") {
    // The immutable fallback is nested below the real global package. Restore
    // the prefix inference its updater would have had at the original location.
    delete environment.NPM_CONFIG_PREFIX;
    delete process.env.NPM_CONFIG_PREFIX;
    environment.npm_config_prefix = path.dirname(path.dirname(modules));
  }
  // TS daemon workers can arrive through Node's fork IPC channel. Import the
  // immutable fallback in this process so process.channel and inherited file
  // descriptors survive. A second node subprocess would sever that contract.
  Object.assign(process.env, environment);
  process.argv[1] = path.join(packageRoot, "dist/bundle/cli.js");
  await import(pathToFileURL(path.join(fallbackRoot, "dist/bundle/cli-node.js")).href);
}

async function main() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("This migration package supports existing macOS and Linux installations only.");
  }
  if (delegatedUpdate && updateRequested && !coordinator) {
    await launchFallback("retrying the release update");
    return;
  }
  // A completed migration needs no lock or disk writes on subsequent launches.
  // Receipts are per package version: upgrading this npm bridge still enters
  // the native-version probe and migration path below. Coordinators retain
  // their status/namespace handoff even when the payload already exists.
  if (!coordinator && fs.existsSync(receipt) && fs.existsSync(executable)) {
    finish(await run(executable, args, { env: nativeEnvironment }));
    return;
  }
  if (!updateRequested && fs.existsSync(failedReceipt)) {
    await launchFallback(fs.readFileSync(failedReceipt, "utf8").trim());
    return;
  }
  if (updateRequested && !coordinator && fs.existsSync(failedReceipt)) {
    // A pinned installer cannot acquire future platform support. Let the
    // genuine updater fetch the current bridge package (and its installer),
    // then verify native activation instead of trusting TS's warning-only exit.
    const result = await run(process.execPath, [path.join(packageRoot, "dist/bundle/cli.js"), ...args], {
      env: { ...process.env, PRIME_AGENT_INTERNAL_TS_UPDATE: "1" },
      detached: true, timeoutMs: 600000,
    });
    if (result.timedOut) throw new Error("The TypeScript release updater timed out before Rust activation");
    if (result.signal || result.code !== 0) { finish(result); return; }
    const current = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const probe = spawnSync(executable, ["--version"], { env: nativeEnvironment,
      stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
    const found = probe.status === 0 && probe.stdout.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    if (!current.primeAgentRustBridge || !fs.existsSync(path.join(receiptDir, current.version)) ||
        !found || !versionAtLeast(found[1], current.version)) {
      throw new Error("The release updater did not activate a working Rust release; TypeScript recovery remains available");
    }
    finish(result);
    return;
  }
  fs.mkdirSync(receiptDir, { recursive: true });
  const statusIndex = args.indexOf("--internal-update-restart-status");
  let statusPath = coordinator && statusIndex >= 0 ? args[statusIndex + 1] : undefined;
  if (statusPath && fs.existsSync(statusPath)) {
    const existing = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    // A native staged transaction owns its record; only the legacy status
    // format can be heartbeated while the migration installer runs.
    if (existing.state !== undefined || existing.updateId !== undefined) statusPath = undefined;
  }
  const socketIndex = args.indexOf("--daemon-socket");
  const now = new Date().toISOString();
  const status = { version: 1, requestId: randomUUID(),
    socketPath: socketIndex >= 0 ? args[socketIndex + 1] : nativeEnvironment.PRIME_AGENT_DAEMON_SOCKET,
    phase: "starting", coordinator: { pid: process.pid },
    counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
    startedAt: now, updatedAt: now, heartbeatAt: now };
  const persist = () => {
    if (!statusPath) return;
    status.heartbeatAt = new Date().toISOString();
    status.updatedAt = status.heartbeatAt;
    const temporary = `${statusPath}.npm-${process.pid}`;
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(status));
    fs.renameSync(temporary, statusPath);
  };
  persist();
  let heartbeatError;
  const heartbeat = statusPath ? setInterval(() => {
    try { persist(); } catch (error) { heartbeatError = error; }
  }, 5000) : undefined;
  const lockPath = path.join(receiptDir, "migration.lock");
  const lockOwner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let ownsLock = false;
  try {
    const deadline = Date.now() + 600000;
    while (!ownsLock) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(fd, lockOwner);
        fs.closeSync(fd);
        ownsLock = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const previous = fs.readFileSync(lockPath, "utf8");
          const owner = JSON.parse(previous);
          try { process.kill(owner.pid, 0); }
          catch (probe) {
            if (probe.code === "ESRCH" && fs.readFileSync(lockPath, "utf8") === previous) {
              fs.unlinkSync(lockPath);
              continue;
            }
          }
        } catch (read) {
          if (read.code === "ENOENT") continue;
          if (!(read instanceof SyntaxError)) throw read;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for migration lock ${lockPath}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    let installed = fs.existsSync(receipt) && fs.existsSync(executable);
    if (!installed && fs.existsSync(executable)) {
      const probe = spawnSync(executable, ["--version"], { env: nativeEnvironment,
        stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
      const found = probe.status === 0 && probe.stdout.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      if (found) installed = versionAtLeast(found[1], metadata.version);
    }
    if (!installed) {
      // The TS restart coordinator restores sessions in the TS namespace.
      // Persist that choice in the native installer so both entrypoints agree.
      if (!process.env.PRIME_AGENT_DAEMON_SOCKET) nativeEnvironment.PRIME_AGENT_DAEMON_SOCKET = legacySocket;
      const result = await run("sh", [path.join(packageRoot, "install-rust.sh")], {
        // Never remove the npm package while its updater/restart coordinator is running.
        env: { ...nativeEnvironment, PRIME_AGENT_VERSION: metadata.version,
          PRIME_AGENT_RELEASE_CHANNEL: metadata.primeAgentReleaseChannel,
          PRIME_AGENT_RUST_PREFIX: prefix, PRIME_AGENT_PRESERVE_NPM_BRIDGE: "1",
          PRIME_AGENT_NPM_BRIDGE_ENTRYPOINT: path.join(packageRoot, "dist", "bundle", "cli.js"),
          PRIME_AGENT_USE_LEGACY_DAEMON_SOCKET: "1",
          PRIME_AGENT_DEFER_DAEMON_STOP: coordinator ? "1" : "0" },
        stdio: ["ignore", process.stderr, process.stderr],
        detached: true,
      });
      if (result.signal || result.code !== 0) {
        status.phase = "failed";
        status.message = "The Rust installer failed; retry the update.";
        persist();
        if (result.signal) { finish(result); return; }
        const failure = new Error(`Rust installer exited with status ${result.code ?? 1}`);
        failure.exitCode = result.code ?? 1;
        throw failure;
      }
    }
    if (!fs.existsSync(executable)) throw new Error(`Installer did not create ${executable}`);
    fs.writeFileSync(receipt, "installed\n");
    if (coordinator) fs.writeFileSync(legacySocketMarker, "legacy\n");
    if (heartbeatError) throw heartbeatError;
  } catch (error) {
    status.phase = "failed";
    status.message = error.message;
    persist();
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (ownsLock && fs.readFileSync(lockPath, "utf8") === lockOwner) fs.unlinkSync(lockPath);
  }
  if (!process.env.PRIME_AGENT_DAEMON_SOCKET && fs.existsSync(legacySocketMarker)) {
    nativeEnvironment.PRIME_AGENT_DAEMON_SOCKET = legacySocket;
  }
  finish(await run(executable, args, { env: nativeEnvironment }));
}

main().catch(async error => {
  try {
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(failedReceipt, `${error.message}\n`);
  } catch (recordError) {
    console.error(`prime-agent: Could not record the failed migration: ${recordError.message}`);
  }
  if (updateRequested) {
    console.error(`prime-agent: Rust migration failed: ${error.message}. TypeScript recovery remains available on the next launch.`);
    process.exitCode = error.exitCode || 1;
    return;
  }
  try { await launchFallback(error.message); }
  catch (fallbackError) {
    console.error(`prime-agent: TypeScript recovery could not start: ${fallbackError.message}`);
    process.exitCode = 1;
  }
});
