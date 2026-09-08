import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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
report("start", { runtime: process.execPath, kind: process.versions.bun ? "bun" : "unsupported", revision: globalThis.Bun?.revision, cwd: process.cwd() });
const child = spawn(spec.command, spec.args, { detached: false, windowsHide: true, stdio: "ignore" });
report("spawned", { pid: child.pid });
child.once("error", (error) => { report("error", String(error)); process.exitCode = 1; });
child.once("exit", (code, signal) => {
    report("exit", { code, signal });
    process.exitCode = signal || code === null ? 1 : code;
});
// Do not unref the inner child or exit before its actual exit event.
`;
function runtimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^(BUN|NODE)_/i.test(key)));
	env.BUN_BE_BUN = "1";
	return env;
}
function runtimeArguments(script: string): string[] {
	return ["--no-env-file", "--no-install", "--config=broker-empty.toml", "--eval", script];
}

const sentinelReadyPattern = /^\d+\|-?\d+\|(True|False)\|\d+\|\d+\|\d+\|\d+\|\d+$/;

function isWindowlessConsole(ready: string[] | undefined, observed: string[] | undefined): boolean {
	return Boolean(
		ready &&
			/^[1-9]\d*$/.test(ready[0] ?? "") &&
			ready[1] === "0" &&
			ready[2] === "False" &&
			(Number(ready[3]) & 1) !== 0 &&
			ready[4] === "0" &&
			// The query has one slot; success must identify this sentinel.
			ready[5] === "1" &&
			ready[7] === ready[0] &&
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
    $consoleIds = [uint32[]]@(0)
    $consoleCount = [SentinelConsole]::GetConsoleProcessList($consoleIds, $consoleIds.Length)
    $consoleError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [IO.File]::WriteAllText(${path("ready.tmp")}, "$PID|$($console.ToInt64())|$([SentinelConsole]::IsWindowVisible($console))|$($info.flags)|$($info.show)|$consoleCount|$consoleError|$($consoleIds[0])")
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
	assert.deepEqual(runtimeEnvironment(inherited), { HOME: "owned-home", BUN_BE_BUN: "1" });
	assert.equal(inherited.NODE_OPTIONS, "bad");
	assert.deepEqual(runtimeArguments(brokerProgram).slice(0, 3), [
		"--no-env-file",
		"--no-install",
		"--config=broker-empty.toml",
	]);
	const data = { command: "C:\\owned space path\\powershell.exe", args: ["-EncodedCommand", encoded] };
	assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
	const observed = ["C|audit", "time", "console", "0", "0", "False", "False", ""];
	for (const error of ["0", "6", "203"]) {
		const ready = `1|0|False|257|0|1|${error}|1`;
		assert(sentinelReadyPattern.test(ready));
		assert(isWindowlessConsole(ready.split("|"), observed));
	}
	assert(!sentinelReadyPattern.test("1|0|False|257|0|1|203"));
	assert(!sentinelReadyPattern.test("1|0|False|257|0|1|203|invalid"));
	for (const invalid of [
		"1|0|False|0|1|1|203|1",
		"1|0|False|257|0|1|203|2",
		"0|0|False|257|0|1|203|0",
		"1|0|False|257|0|2|203|1",
		"1|0|False|257|0|0|6|0",
		"1|0|False|257|0|0|0|0",
		"1|0|False|257|0|1|203",
		"1|0|False|257|0",
	]) {
		assert(!isWindowlessConsole(invalid.split("|"), observed));
	}
	assert(!isWindowlessConsole("1|0|False|257|0|1|203|1".split("|"), undefined));
	console.log(
		"PASS sentinel/transport, runtime argv, startup-env scrub, parent-env preservation and windowless-console guards",
	);
	process.exit(0);
}

assert.equal(process.platform, "win32", "Native launch probe requires Windows");
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
assert(isBun, "Native launch probe requires Bun");
const bunRevision = (Reflect.get(globalThis, "Bun") as { revision?: string } | undefined)?.revision;
assert.equal(bunRevision, "34cbb9a40b4bd1bd767d134a7065e66c2432a676");
if (process.argv[2] === "--null-config-startup") {
	const deadline = Date.now() + 30000;
	const remaining = () => Math.max(0, deadline - Date.now());
	const failures: unknown[] = [];
	const outputLimit = 64 * 1024;
	const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	const bytes = { stdout: 0, stderr: 0 };
	let child: ChildProcess | undefined;
	let completion: Promise<number | null> | undefined;
	let spawned = false;
	let exited = false;
	let closed = false;
	let hadError = false;
	let forced = false;
	let stdoutEnded = false;
	let stderrEnded = false;
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	let imageHash: string | undefined;
	let finalImageHash: string | undefined;
	const cwd = win32.dirname(template.command);
	const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
		bytes[stream] += chunk.length;
		const space = outputLimit - output[stream].length;
		if (space > 0) output[stream] = Buffer.concat([output[stream], chunk.subarray(0, space)]);
	};
	const onStdout = (chunk: Buffer) => capture("stdout", chunk);
	const onStderr = (chunk: Buffer) => capture("stderr", chunk);
	const onStdoutEnd = () => {
		stdoutEnded = true;
	};
	const onStderrEnd = () => {
		stderrEnded = true;
	};
	const onSpawn = () => {
		spawned = true;
		record("null-config-spawn", { pid: child?.pid });
	};
	const onError = (error: Error) => {
		hadError = true;
		record("null-config-child-error", String(error));
	};
	const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
		exited = true;
		exitCode = code;
		exitSignal = signal;
		record("null-config-exit", { code, signal });
	};
	const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
		closed = true;
		record("null-config-close", { code, signal });
	};
	try {
		assert(isBun, "Null-config control requires Bun or the actual Bun-compiled app");
		assert.equal(process.versions.bun, "1.4.0");
		assert.equal(process.argv.length, 5);
		const expectedImage = process.argv[3]!;
		const expectedHash = process.argv[4]!;
		assert(win32.isAbsolute(expectedImage));
		assert(/^[0-9a-f]{64}$/.test(expectedHash));
		assert.equal(win32.normalize(process.execPath).toLowerCase(), win32.normalize(expectedImage).toLowerCase());
		imageHash = hash(process.execPath);
		assert.equal(imageHash, expectedHash);
		const program = String.raw`
const { spawn } = require("node:child_process");
process.stdout.write(JSON.stringify({ type: "prime-agent-nul-config-startup-v1", pid: process.pid, runtime: process.execPath, bun: process.versions.bun, revision: Bun.revision, cwd: process.cwd(), builtinLoaded: typeof spawn === "function" }) + "\n");
`;
		const args = ["--no-env-file", "--no-install", String.raw`--config=\\.\NUL`, "--eval", program];
		record("null-config-launch", {
			runtime: process.execPath,
			expectedImage,
			imageHash,
			cwd,
			args,
			detached: true,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		assert(remaining() > 0, "Null-config setup exceeded the work deadline");
		child = spawnHidden(process.execPath, args, {
			cwd,
			env: runtimeEnvironment(process.env),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.once("spawn", onSpawn);
		child.on("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("error", onError);
		child.stderr?.on("error", onError);
		completion = waitForChildProcess(child);
		void completion.catch(() => {});
		assert(child.stdout && child.stderr, "Null-config capture pipes are missing");
		const code = await observe(completion, remaining(), "null-config startup");
		await waitUntil(() => closed, remaining(), "null-config output close");
		assert(spawned && exited && !hadError, "Null-config child did not complete normally");
		assert.equal(code, 0);
		assert.equal(exitCode, 0);
		assert.equal(exitSignal, null);
		assert(stdoutEnded && stderrEnded, "Null-config output did not drain naturally");
		assert(
			bytes.stdout <= outputLimit && bytes.stderr <= outputLimit,
			"Null-config output exceeded the capture bound",
		);
		const lines = output.stdout.toString("utf8").split("\n");
		assert.equal(lines.length, 2, "Expected exactly one null-config result line");
		assert.equal(lines[1], "");
		const data = JSON.parse(lines[0]!) as Record<string, unknown>;
		assert(data && typeof data === "object" && !Array.isArray(data));
		const { runtime, cwd: actualCwd, ...result } = data;
		assert.deepEqual(result, {
			type: "prime-agent-nul-config-startup-v1",
			pid: child.pid,
			bun: "1.4.0",
			revision: bunRevision,
			builtinLoaded: true,
		});
		assert(typeof runtime === "string" && win32.isAbsolute(runtime));
		assert.equal(win32.normalize(runtime).toLowerCase(), win32.normalize(expectedImage).toLowerCase());
		assert(typeof actualCwd === "string" && win32.isAbsolute(actualCwd));
		assert.equal(realpathSync(actualCwd).toLowerCase(), realpathSync(cwd).toLowerCase());
		finalImageHash = hash(process.execPath);
		assert.equal(finalImageHash, expectedHash);
		assert(remaining() > 0, "Null-config verification exceeded the work deadline");
	} catch (error) {
		failures.push(error);
	} finally {
		if (child) {
			record("null-config-before-cleanup", { pid: child.pid, runtime: process.execPath, spawned, exited, closed });
			const cleanupDeadline = Date.now() + 10000;
			const cleanupRemaining = () => Math.max(0, cleanupDeadline - Date.now());
			if (!exited && child.pid) {
				forced = true;
				try {
					const accepted = child.kill("SIGKILL");
					record("null-config-owned-kill", { pid: child.pid, accepted });
					if (!accepted) failures.push(new Error("Null-config owned child rejected SIGKILL"));
				} catch (error) {
					failures.push(error);
				}
			}
			try {
				await waitUntil(
					() => closed && (exited || (!spawned && !child?.pid)),
					cleanupRemaining(),
					"null-config owned exit",
				);
				if (completion) await observe(completion, cleanupRemaining(), "null-config owned completion");
			} catch (error) {
				if (!failures.includes(error)) failures.push(error);
			}
		}
		if (forced) failures.push(new Error("Null-config forced termination is not a startup pass"));
		if (hadError && !failures.length) failures.push(new Error("Null-config child reported an error"));
		record("null-config-result", {
			pid: child?.pid,
			runtime: process.execPath,
			imageHash,
			finalImageHash,
			cwd,
			spawned,
			exited,
			closed,
			exitCode,
			exitSignal,
			forced,
			hadError,
			stdoutEnded,
			stderrEnded,
			cleanupConfirmed: !child || (closed && (exited || (!spawned && !child.pid))),
			bytes,
			outputLimit,
			outputTruncated: bytes.stdout > outputLimit || bytes.stderr > outputLimit,
			stdout: output.stdout.toString("utf8"),
			stderr: output.stderr.toString("utf8"),
			failures: failures.map(String),
		});
		if (child && closed && (exited || (!spawned && !child.pid))) {
			child.removeListener("spawn", onSpawn);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("data", onStdout);
			child.stderr?.removeListener("data", onStderr);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("error", onError);
			child.stderr?.removeListener("error", onError);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Null-config startup failed or cleanup is unconfirmed");
	record("PASS-NUL-CONFIG-STARTUP", { runtime: process.execPath, imageHash, cwd, diagnosticPipes: true });
	process.exit(0);
}
if (process.argv[2] === "--expect-runtime") {
	assert.equal(process.argv[4], "--expect-sha256");
	assert.equal(process.argv[6], "--expect-kind");
	assert.equal(process.argv.length, 8);
	assert(win32.isAbsolute(process.argv[3]!));
	assert.equal(win32.normalize(process.execPath).toLowerCase(), win32.normalize(process.argv[3]!).toLowerCase());
	assert.equal(hash(process.execPath), process.argv[5]!.toLowerCase());
	assert.equal("bun", process.argv[7]);
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
		options.env = runtimeEnvironment(process.env);
		options.env.PRIME_AGENT_LAUNCH_PROBE_SPEC = JSON.stringify({
			command: image,
			args,
			trace: join(directory, `${name}-runtime.jsonl`),
		});
	}
	return {
		command: broker ? process.execPath : image,
		args: broker ? runtimeArguments(brokerProgram) : args,
		options,
		payload: { command: image, args },
		scriptHash: createHash("sha256").update(script).digest("hex"),
	};
}

if (process.argv[2] === "--caller") {
	const directory = process.argv[3]!;
	const name = process.argv[4]!;
	assert.equal(name, "D");
	const spec = launchSpec(directory, name, true);
	const child = spawnHidden(spec.command, spec.args, { ...spec.options, detached: true, stdio: "ignore" });
	writeFileSync(join(directory, `${name}-broker`), String(child.pid));
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
	assert.equal(started.data.kind, "bun");
	assert.equal(started.data.revision, bunRevision);
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
			const windowlessConsole = isWindowlessConsole(ready, console);
			const hiddenClassic =
				console?.[4] !== "0" &&
				console?.[5] === "False" &&
				console?.[6] === "True" &&
				console?.[7] === "ConsoleWindowClass";
			record("console-mode", { name, ready, windowlessConsole, hiddenClassic });
			if (!windowlessConsole && !hiddenClassic)
				auditErrors.push(
					new Error(
						`${name}: visibility INCONCLUSIVE (no validated windowless console or hidden classic console)`,
					),
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
			assert(sentinelReadyPattern.test(ready));
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

	{
		const name = "D";
		try {
			assert(Date.now() < workDeadline, "Launch probe work budget expired");
			await setPhase(name, "armed");
			const args = runtimeArguments("").slice(0, 3);
			args.push(resolve(process.argv[1]!), "--caller", directory, name);
			const caller = spawnHidden(process.execPath, args, {
				cwd: join(directory, "runtime-cwd"),
				env: runtimeEnvironment(process.env),
				stdio: "ignore",
			});
			trampolineCases.add(name);
			const code = await observe(own(caller), budget(5000), `${name} original caller exit`);
			const callerSucceeded = code === 0;
			record("original-caller-exit", {
				name,
				pid: caller.pid,
				code,
				stdio: "ignore",
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
			assert(sentinelReadyPattern.test(ready));
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
	for (const name of ["AB", "A", "B", "C", "C-space", "D"]) {
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
	for (const name of ["AB", "A", "B", "C", "C-space", "D"]) {
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
