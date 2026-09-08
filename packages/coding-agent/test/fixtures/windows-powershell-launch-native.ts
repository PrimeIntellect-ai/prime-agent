import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { isProcessAlive, spawnHidden, waitForChildProcess } from "../../src/utils/child-process.js";
import { createWindowsProcessTreeSignal } from "../../src/utils/windows-process-signal.js";
import { visibilityObserverScript } from "./windows-launch-observer.js";
import { observe, waitUntil } from "./windows-process-observation.js";

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const encode = (script: string) => Buffer.from(script, "utf16le").toString("base64");
function safeImage(path: string): string {
	assert(win32.isAbsolute(path) && !/["%!&|<>^\r\n]/.test(path), `Unsafe command image: ${path}`);
	return path;
}
const brokerProgram = String.raw`
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const spec = JSON.parse(process.env.PRIME_AGENT_LAUNCH_PROBE_SPEC);
const report = (event, data) => appendFileSync(spec.trace, JSON.stringify({ event, pid: process.pid, data }) + "\n");
report("start", { runtime: process.execPath, kind: process.versions.bun ? "bun" : "node", revision: globalThis.Bun?.revision, cwd: process.cwd() });
const child = spawn(spec.command, spec.args, { detached: false, windowsHide: true, stdio: "ignore" });
report("spawned", { pid: child.pid });
child.once("error", (error) => { report("error", String(error)); process.exitCode = 1; });
child.once("exit", (code, signal) => {
    report("exit", { code, signal });
    process.exitCode = signal || code === null ? 1 : code;
});
// Do not unref the inner child or exit before its actual exit event.
`;
function runtimeEnvironment(source: NodeJS.ProcessEnv, bun: boolean): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^(BUN|NODE)_/i.test(key)));
	if (bun) env.BUN_BE_BUN = "1";
	return env;
}
function runtimeArguments(bun: boolean, script: string): string[] {
	return bun
		? ["--no-env-file", "--no-install", "--config=broker-empty.toml", "--eval", script]
		: ["--input-type=commonjs", "--eval", script];
}

function isNoConsoleMode(ready: string[] | undefined, observed: string[] | undefined): boolean {
	return Boolean(
		ready &&
			ready[1] === "0" &&
			ready[2] === "False" &&
			(Number(ready[3]) & 1) !== 0 &&
			ready[4] === "0" &&
			ready[5] === "0" &&
			ready[6] === "6" &&
			observed?.[4] === "0" &&
			observed[5] === "False" &&
			observed[6] === "False",
	);
}

function sentinel(directory: string, name: string): string {
	const path = (suffix: string) => quote(join(directory, `${name}-${suffix}`));
	return `
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText(${path("started")}, 'fixed launch sentinel v1 started')
try {
    $metadata = @(([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName), ([Environment]::CommandLine), ([string]$PSVersionTable.PSVersion)) -join [Environment]::NewLine
    [IO.File]::WriteAllText(${path("metadata")}, $metadata)
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SentinelConsole {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [StructLayout(LayoutKind.Sequential)] public struct StartupInfo {
        public uint cb; public IntPtr reserved, desktop, title;
        public uint x, y, width, height, columns, rows, fill, flags;
        public ushort show, reservedLength;
        public IntPtr reservedData, stdin, stdout, stderr;
    }
    [DllImport("kernel32.dll")] public static extern void GetStartupInfo(out StartupInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] ids, uint count);
}
'@
    $info = New-Object SentinelConsole+StartupInfo
    [SentinelConsole]::GetStartupInfo([ref]$info)
    $console = [SentinelConsole]::GetConsoleWindow()
    $consoleCount = [SentinelConsole]::GetConsoleProcessList([uint32[]]@(0), 1)
    $consoleError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [IO.File]::WriteAllText(${path("ready.tmp")}, "$PID|$($console.ToInt64())|$([SentinelConsole]::IsWindowVisible($console))|$($info.flags)|$($info.show)|$consoleCount|$consoleError")
    [IO.File]::Move(${path("ready.tmp")}, ${path("ready")})
    while (![IO.File]::Exists(${path("gate")})) { Start-Sleep -Milliseconds 25 }
    [IO.File]::WriteAllText(${path("done.tmp")}, 'fixed launch sentinel v1 completed')
    [IO.File]::Move(${path("done.tmp")}, ${path("done")})
    exit 37
} catch {
    [IO.File]::WriteAllText(${path("error")}, [string]$_)
    exit 38
}
`;
}

// Local construction checks execute no native factory, subprocess or sentinel.
if (process.argv[2] === "--construction-check") {
	const script = sentinel("C:\\owned probe's directory", "C");
	const encoded = encode(script);
	assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);
	assert(!script.toLowerCase().includes("taskkill"));
	assert(script.includes("exit 37"));
	const inherited = {
		NODE_OPTIONS: "bad",
		nOdE_InSpEcT: "bad",
		BUN_OPTIONS: "bad",
		bun_inspect: "bad",
		HOME: "owned-home",
	};
	assert.deepEqual(runtimeEnvironment(inherited, false), { HOME: "owned-home" });
	assert.deepEqual(runtimeEnvironment(inherited, true), { HOME: "owned-home", BUN_BE_BUN: "1" });
	assert.equal(inherited.NODE_OPTIONS, "bad");
	assert.deepEqual(runtimeArguments(false, brokerProgram), ["--input-type=commonjs", "--eval", brokerProgram]);
	assert.deepEqual(runtimeArguments(true, brokerProgram).slice(0, 3), [
		"--no-env-file",
		"--no-install",
		"--config=broker-empty.toml",
	]);
	const data = { command: "C:\\owned space path\\powershell.exe", args: ["-EncodedCommand", encoded] };
	assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
	const observed = ["C|audit", "time", "console", "0", "0", "False", "False", ""];
	assert(isNoConsoleMode("1|0|False|257|0|0|6".split("|"), observed));
	for (const incomplete of ["1|0|False|0|1|0|6", "1|0|False|257|0|1|0", "1|0|False|257|0", "1|0|False|257|0|0|0"]) {
		assert(!isNoConsoleMode(incomplete.split("|"), observed));
	}
	assert(!isNoConsoleMode("1|0|False|257|0|0|6".split("|"), undefined));
	console.log(
		"PASS sentinel/transport, runtime argv, startup-env scrub, parent-env preservation and no-console guards",
	);
	process.exit(0);
}

assert.equal(process.platform, "win32", "Native launch probe requires Windows");
const version = process.versions.node.split(".").map(Number);
assert(version[0]! > 22 || (version[0] === 22 && version[1]! >= 8));
const began = Date.now();
const workDeadline = began + 135000; // Reserve owned cleanup and reporting inside the 3-minute step.
const budget = (milliseconds: number) => Math.max(0, Math.min(milliseconds, workDeadline - Date.now()));
const record = (phase: string, data: unknown = null) =>
	console.error(JSON.stringify({ ms: Date.now() - began, phase, data }));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Obtain canonical paths/flags, but NEVER launch the factory's original target-signal payload.
const template = createWindowsProcessTreeSignal(process.pid, "SIGKILL");
const powershell = safeImage(template.command);
const isBun = Boolean(process.versions.bun);
const bunRevision = (Reflect.get(globalThis, "Bun") as { revision?: string } | undefined)?.revision;
if (isBun) assert.equal(bunRevision, "34cbb9a40b4bd1bd767d134a7065e66c2432a676");
if (process.argv[2] === "--expect-runtime") {
	assert.equal(process.argv[4], "--expect-sha256");
	assert.equal(process.argv[6], "--expect-kind");
	assert.equal(process.argv.length, 8);
	assert(win32.isAbsolute(process.argv[3]!));
	assert.equal(win32.normalize(process.execPath).toLowerCase(), win32.normalize(process.argv[3]!).toLowerCase());
	assert.equal(hash(process.execPath), process.argv[5]!.toLowerCase());
	assert.equal(isBun ? "bun" : "node", process.argv[7]);
}
assert.deepEqual(template.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
function launchSpec(directory: string, name: string, broker: boolean, image = powershell) {
	const script = sentinel(directory, name);
	const encoded = encode(script);
	assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);
	assert(!script.toLowerCase().includes("taskkill"));
	const args = [...template.args.slice(0, -1), encoded];
	assert.equal(args.at(-1), encoded);
	const options: SpawnOptions = {};
	if (broker) {
		options.cwd = join(directory, "runtime-cwd");
		assert.equal(readFileSync(join(options.cwd, "broker-empty.toml"), "utf8"), "");
		options.env = runtimeEnvironment(process.env, isBun);
		options.env.PRIME_AGENT_LAUNCH_PROBE_SPEC = JSON.stringify({
			command: image,
			args,
			trace: join(directory, `${name}-runtime.jsonl`),
		});
	}
	return {
		command: broker ? process.execPath : image,
		args: broker ? runtimeArguments(isBun, brokerProgram) : args,
		options,
		payload: { command: image, args },
		scriptHash: createHash("sha256").update(script).digest("hex"),
	};
}

if (process.argv[2] === "--caller") {
	const directory = process.argv[3]!;
	const name = process.argv[4]!;
	assert(["D", "D-stderr"].includes(name));
	const stage = (text: string) => {
		if (name === "D-stderr") appendFileSync(join(directory, `${name}-caller-stages`), `${text}\n`);
	};
	stage("after native factory");
	const spec = launchSpec(directory, name, true);
	stage("before spawn");
	const child = spawnHidden(spec.command, spec.args, { ...spec.options, detached: true, stdio: "ignore" });
	writeFileSync(join(directory, `${name}-broker`), String(child.pid));
	stage("after spawn; before immediate unref + process.exit(0)");
	child.unref();
	process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "prime-agent launch probe-"));
mkdirSync(join(directory, "runtime-cwd"));
writeFileSync(join(directory, "runtime-cwd", "broker-empty.toml"), "");
const junction = join(directory, "PowerShell path with spaces");
let junctionCreated = false;
const owners: ChildProcess[] = [];
const exits: Array<Promise<number | null>> = [];
const errors: unknown[] = [];
const auditErrors: unknown[] = [];
const departedPids: number[] = [];
const trampolineCases = new Set<string>();
const readyByCase = new Map<string, string[]>();
let observerResult: Promise<number | null> | undefined;
let observerReady = false;
const observerCode = visibilityObserverScript(directory);
record("provenance", {
	directory,
	runtime: process.execPath,
	node: process.versions.node,
	bun: process.versions.bun,
	bunRevision,
	powershell,
	powershellHash: hash(powershell),
	runtimeHash: hash(process.execPath),
	startupCwd: join(directory, "runtime-cwd"),
});
function own(child: ChildProcess): Promise<number | null> {
	owners.push(child);
	const result = waitForChildProcess(child);
	result.catch((error) => record("owned-process-error", String(error)));
	exits.push(result);
	return result;
}
function verifyBroker(name: string): void {
	const events = readFileSync(join(directory, `${name}-runtime.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const started = events.find((event) => event.event === "start");
	assert.equal(win32.normalize(started?.data.runtime).toLowerCase(), win32.normalize(process.execPath).toLowerCase());
	assert.equal(started.data.kind, isBun ? "bun" : "node");
	if (isBun) assert.equal(started.data.revision, bunRevision);
	assert.equal(realpathSync(started.data.cwd), realpathSync(join(directory, "runtime-cwd")));
	assert(!events.some((event) => event.event === "error"), `${name}: runtime broker reported an error`);
	assert.deepEqual(events.filter((event) => event.event === "exit").at(-1)?.data, { code: 37, signal: null });
}
async function setPhase(name: string, kind: "armed" | "audit", console = "0"): Promise<void> {
	const request = `${name}|${kind}|${console}`;
	try {
		writeFileSync(join(directory, "phase"), request);
	} catch (error) {
		observerReady = false;
		auditErrors.push(error);
	}
	if (!observerReady) return;
	try {
		await waitUntil(
			() =>
				existsSync(join(directory, "phase-ack")) && readFileSync(join(directory, "phase-ack"), "utf8") === request,
			budget(5000),
			"visibility observer acknowledgement",
		);
	} catch (error) {
		observerReady = false;
		auditErrors.push(error);
	}
}
function audit(name: string): void {
	try {
		if (!observerReady) {
			auditErrors.push(new Error(`${name}: visibility INCONCLUSIVE (observer/control/station unavailable)`));
			return;
		}
		const rows = readFileSync(join(directory, "windows.tsv"), "utf8")
			.split(/\r?\n/)
			.map((line) => line.split("\t"));
		const relevant = rows.filter((row) => row[0]?.startsWith(`${name}|`));
		const visible = relevant.filter((row) => ["show", "foreground", "visible-snapshot"].includes(row[2]!));
		const console = relevant.filter((row) => row[2] === "console").at(-1);
		record("visibility-audit", { name, rows: relevant });
		if (visible.length)
			auditErrors.push(
				new Error(`${name}: visible window/foreground event observed; hidden startup not established`),
			);
		else {
			const ready = readyByCase.get(name);
			const noConsole = isNoConsoleMode(ready, console);
			const hiddenClassic =
				console?.[4] !== "0" &&
				console?.[5] === "False" &&
				console?.[6] === "True" &&
				console?.[7] === "ConsoleWindowClass";
			record("console-mode", { name, ready, noConsole, hiddenClassic });
			if (!noConsole && !hiddenClassic)
				auditErrors.push(
					new Error(`${name}: visibility INCONCLUSIVE (no validated no-console mode or hidden classic console)`),
				);
		}
	} catch (error) {
		auditErrors.push(new Error(`${name}: visibility INCONCLUSIVE: ${String(error)}`));
	}
}
async function run(name: string, detached: boolean, trampoline: boolean, image = powershell, payloadName = name) {
	assert(Date.now() < workDeadline, "Launch probe work budget expired");
	await setPhase(name, "armed");
	const spec = launchSpec(directory, payloadName, trampoline, image);
	const options: SpawnOptions = { ...spec.options, detached, stdio: "ignore" };
	record("launch", {
		name,
		command: spec.command,
		args: spec.args,
		payload: spec.payload,
		scriptHash: spec.scriptHash,
		options: { detached, stdio: "ignore", windowsHide: true, cwd: options.cwd },
	});
	const child = spawnHidden(spec.command, spec.args, options);
	const result = own(child);
	if (trampoline) trampolineCases.add(name);
	let completed = false;
	result.then(
		() => {
			completed = true;
		},
		() => {
			completed = true;
		},
	);
	try {
		await waitUntil(
			() => completed || existsSync(join(directory, `${payloadName}-ready`)),
			budget(15000),
			`${name} sentinel start`,
		);
		if (existsSync(join(directory, `${payloadName}-ready`))) {
			const ready = readFileSync(join(directory, `${payloadName}-ready`), "utf8");
			assert(/^\d+\|-?\d+\|(True|False)\|\d+\|\d+\|\d+\|\d+$/.test(ready));
			readyByCase.set(name, ready.split("|"));
			record("sentinel-ready", {
				name,
				ready,
				metadata: readFileSync(join(directory, `${payloadName}-metadata`), "utf8"),
			});
			await setPhase(name, "audit", ready.split("|")[1]);
			if (trampoline) {
				if (ready.split("|")[2] === "True") auditErrors.push(new Error(`${name}: sentinel console is visible`));
				// Audit the complete event log after the observer exits, not at gate release.
			}
		}
	} finally {
		writeFileSync(join(directory, `${payloadName}-gate`), "release");
	}
	const code = await observe(result, budget(15000), `${name} sentinel exit`);
	const started = existsSync(join(directory, `${payloadName}-started`));
	const done =
		existsSync(join(directory, `${payloadName}-done`)) &&
		readFileSync(join(directory, `${payloadName}-done`), "utf8") === "fixed launch sentinel v1 completed" &&
		!existsSync(join(directory, `${payloadName}-error`));
	record("result", { name, pid: child.pid, code, started, done });
	if (trampoline) verifyBroker(name);
	if (payloadName !== name) {
		for (const suffix of ["started", "metadata", "ready", "ready.tmp", "gate", "done", "done.tmp", "error"]) {
			const path = join(directory, `${payloadName}-${suffix}`);
			if (existsSync(path)) renameSync(path, join(directory, `${name}-${suffix}`));
		}
	}
	return { code, started, done };
}

try {
	try {
		assert.equal(Buffer.from(encode(observerCode), "base64").toString("utf16le"), observerCode);
		const observer = spawnHidden(powershell, [...template.args.slice(0, -1), encode(observerCode)], {
			stdio: ["ignore", "ignore", "pipe"],
			detached: false,
		});
		let observerStderr = "";
		observer.stderr?.on("data", (data: Buffer) => {
			observerStderr += data.toString().slice(0, Math.max(0, 4096 - observerStderr.length));
		});
		observer.once("exit", (code, signal) => record("observer-exit", { code, signal, stderr: observerStderr }));
		const observerExit = own(observer);
		observerResult = observerExit;
		let observerExited = false;
		observerExit.then(
			() => {
				observerExited = true;
			},
			() => {
				observerExited = true;
			},
		);
		try {
			await waitUntil(
				() => observerExited || existsSync(join(directory, "observer-ready")),
				budget(15000),
				"visibility observer control",
			);
			observerReady =
				existsSync(join(directory, "observer-ready")) &&
				readFileSync(join(directory, "observer-ready"), "utf8") === "True|True";
		} catch (error) {
			auditErrors.push(error);
		}
		record("observer-control", {
			ready: observerReady,
			exited: observerExited,
			control: existsSync(join(directory, "observer-ready"))
				? readFileSync(join(directory, "observer-ready"), "utf8")
				: null,
		});
	} catch (error) {
		observerReady = false;
		auditErrors.push(error);
		record("observer-unavailable", String(error));
	}

	// Identical image, argv, payload and stdio. Archive A's owned files before reusing AB paths.
	const a = await run("A", true, false, powershell, "AB");
	const b = await run("B", false, false, powershell, "AB");
	if (a.code !== 0 || a.started || a.done) errors.push(new Error("A did not reproduce detached non-execution"));
	if (b.code !== 37 || !b.started || !b.done) errors.push(new Error("B did not execute the identical sentinel"));

	const c = await run("C", true, true);
	assert(c.code === 37 && c.started && c.done, "C runtime broker failed; stop");
	symlinkSync(win32.dirname(powershell), junction, "junction");
	junctionCreated = true;
	record("owned-junction", { junction, target: win32.dirname(powershell) });
	const spaceImage = safeImage(join(junction, win32.basename(powershell)));
	assert.equal(hash(spaceImage), hash(powershell));
	const space = await run("C-space", true, true, spaceImage);
	assert(space.code === 37 && space.started && space.done, "C-space quoting failed; stop");

	for (const name of ["D", "D-stderr"]) {
		let stderrFd: number | undefined;
		try {
			assert(Date.now() < workDeadline, "Launch probe work budget expired");
			await setPhase(name, "armed");
			if (name === "D-stderr") stderrFd = openSync(join(directory, `${name}-caller-stderr`), "w");
			const args = isBun ? runtimeArguments(true, "").slice(0, 3) : [];
			args.push(resolve(process.argv[1]!), "--caller", directory, name);
			const caller = spawnHidden(process.execPath, args, {
				cwd: join(directory, "runtime-cwd"),
				env: runtimeEnvironment(process.env, isBun),
				stdio: stderrFd === undefined ? "ignore" : ["ignore", "ignore", stderrFd],
			});
			trampolineCases.add(name);
			const code = await observe(own(caller), budget(5000), `${name} original caller exit`);
			const callerSucceeded = code === 0;
			record("original-caller-exit", {
				name,
				pid: caller.pid,
				code,
				stdio: name === "D" ? "ignore" : "stderr-file",
			});
			if (!callerSucceeded) errors.push(new Error(`${name}: explicit original caller exit failed: ${code}`));
			const broker = Number(readFileSync(join(directory, `${name}-broker`), "utf8"));
			assert(Number.isInteger(broker) && broker > 0);
			departedPids.push(broker);
			assert(!existsSync(join(directory, `${name}-gate`)));
			await waitUntil(
				() => existsSync(join(directory, `${name}-ready`)),
				budget(15000),
				`${name} sentinel after caller exit`,
			);
			const ready = readFileSync(join(directory, `${name}-ready`), "utf8");
			assert(/^\d+\|-?\d+\|(True|False)\|\d+\|\d+\|\d+\|\d+$/.test(ready));
			const fields = ready.split("|");
			readyByCase.set(name, fields);
			const sentinelPid = Number(fields[0]);
			assert(Number.isInteger(sentinelPid) && sentinelPid > 0);
			departedPids.push(sentinelPid);
			record("sentinel-ready", { name, ready, metadata: readFileSync(join(directory, `${name}-metadata`), "utf8") });
			await setPhase(name, "audit", fields[1]);
			if (fields[2] === "True") auditErrors.push(new Error(`${name}: sentinel console is visible`));
			writeFileSync(join(directory, `${name}-gate`), "release");
			await waitUntil(
				() => !isProcessAlive(broker) && !isProcessAlive(sentinelPid),
				budget(15000),
				`${name} broker and sentinel exit`,
			);
			assert.equal(readFileSync(join(directory, `${name}-done`), "utf8"), "fixed launch sentinel v1 completed");
			assert(!existsSync(join(directory, `${name}-error`)), `${name} sentinel reported an error before exit`);
			verifyBroker(name);
			record(callerSucceeded ? "D-completed-after-caller-exit" : "D-cleanup-completion-NOT-survival-proof", {
				name,
				broker,
				sentinelPid,
			});
		} catch (error) {
			errors.push(error);
		} finally {
			writeFileSync(join(directory, `${name}-gate`), "release");
			if (stderrFd !== undefined) closeSync(stderrFd);
		}
	}
} catch (error) {
	errors.push(error);
} finally {
	record("before-cleanup", {
		directory,
		owners: owners.map((child) => ({ pid: child.pid, exit: child.exitCode, signal: child.signalCode })),
		errors: [...errors, ...auditErrors].map(String),
	});
	for (const name of ["AB", "A", "B", "C", "C-space", "D", "D-stderr"]) {
		try {
			writeFileSync(join(directory, `${name}-gate`), "release");
		} catch (error) {
			errors.push(error);
		}
	}
	const cleanupDeadline = Date.now() + 15000;
	const cleanupBudget = () => Math.max(0, cleanupDeadline - Date.now());
	try {
		await observe(
			Promise.all([
				Promise.all(exits.filter((result) => result !== observerResult)),
				waitUntil(
					() => departedPids.every((pid) => !isProcessAlive(pid)),
					cleanupBudget(),
					"departed probe cleanup",
				),
			]),
			cleanupBudget(),
			"owned probe cleanup",
		);
	} catch (error) {
		errors.push(error);
	}
	try {
		// Keep observing through sentinel exits, then drain queued events before closing.
		writeFileSync(join(directory, "observer-stop"), "stop");
		assert(observerResult, "Visibility observer was not started");
		assert.equal(await observe(observerResult, cleanupBudget(), "visibility observer exit"), 0);
		assert.equal(readFileSync(join(directory, "observer-drained"), "utf8"), "drained");
	} catch (error) {
		observerReady = false;
		auditErrors.push(error);
	}
	for (const name of trampolineCases) audit(name);
	for (const name of ["AB", "A", "B", "C", "C-space", "D", "D-stderr"]) {
		for (const suffix of [
			"started",
			"metadata",
			"ready",
			"ready.tmp",
			"done",
			"done.tmp",
			"error",
			"broker",
			"runtime.jsonl",
			"caller-stages",
			"caller-stderr",
		]) {
			const path = join(directory, `${name}-${suffix}`);
			if (existsSync(path))
				record("preserved-sentinel-artifact", { name, suffix, text: readFileSync(path, "utf8") });
		}
	}
	if (junctionCreated) {
		try {
			rmdirSync(junction);
			record("owned-junction-removed", junction);
		} catch (error) {
			errors.push(error);
		} // Never recurse into the system directory.
	}
	const events = join(directory, "windows.tsv");
	if (existsSync(events)) record("preserved-window-events", readFileSync(events, "utf8"));
	for (const error of [...errors, ...auditErrors]) record("probe-failure-or-inconclusive", String(error));
}
if (errors.length || auditErrors.length)
	throw new AggregateError([...errors, ...auditErrors], "Launch probe failed or visibility is inconclusive");
record("PASS-runtime-broker-hidden-startup", { directory });
