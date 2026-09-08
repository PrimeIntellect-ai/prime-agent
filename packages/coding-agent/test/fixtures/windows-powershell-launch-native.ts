import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
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
function cmdArguments(image: string, encoded: string): string[] {
	assert(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), "Payload must be one base64 argument");
	return ["/d", "/s", "/c", `""${safeImage(image)}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}"`];
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
}
'@
    $info = New-Object SentinelConsole+StartupInfo
    [SentinelConsole]::GetStartupInfo([ref]$info)
    $console = [SentinelConsole]::GetConsoleWindow()
    [IO.File]::WriteAllText(${path("ready.tmp")}, "$PID|$($console.ToInt64())|$([SentinelConsole]::IsWindowVisible($console))|$($info.flags)|$($info.show)")
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
	const image = "C:\\owned path\\PowerShell junction\\powershell.exe";
	assert.equal(
		cmdArguments(image, encoded)[3],
		`""${image}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}"`,
	);
	for (const bad of ["C:\\%TEMP%\\x.exe", "C:\\x!y.exe", 'C:\\x"y.exe', "C:\\x&y.exe", "relative.exe"]) {
		assert.throws(() => cmdArguments(bad, encoded));
	}
	assert.throws(() => cmdArguments(image, "not-base64&exit"));
	console.log("PASS fixed sentinel roundtrip, quoted space path and unsafe expansion rejection");
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
const cmd = safeImage(win32.join(win32.dirname(win32.dirname(win32.dirname(powershell))), "cmd.exe"));
assert.deepEqual(template.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
function launchSpec(directory: string, name: string, trampoline: boolean, image = powershell) {
	const script = sentinel(directory, name);
	const encoded = encode(script);
	assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);
	assert(!script.toLowerCase().includes("taskkill"));
	const args = trampoline ? cmdArguments(image, encoded) : [...template.args.slice(0, -1), encoded];
	assert(trampoline ? args[3]!.endsWith(` ${encoded}"`) : args.at(-1) === encoded);
	return { command: trampoline ? cmd : image, args, scriptHash: createHash("sha256").update(script).digest("hex") };
}

if (process.argv[2] === "--caller") {
	const directory = process.argv[3]!;
	const spec = launchSpec(directory, "D", true);
	const child = spawnHidden(spec.command, spec.args, {
		detached: true,
		stdio: "ignore",
		windowsVerbatimArguments: true,
		argv0: `"${cmd}"`,
	});
	writeFileSync(join(directory, "D-broker"), String(child.pid));
	child.unref();
	process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "prime-agent launch probe-"));
const junction = join(directory, "PowerShell path with spaces");
let junctionCreated = false;
const owners: ChildProcess[] = [];
const exits: Array<Promise<number | null>> = [];
const errors: unknown[] = [];
const auditErrors: unknown[] = [];
const departedPids: number[] = [];
const trampolineCases = new Set<string>();
let observerResult: Promise<number | null> | undefined;
let observerReady = false;
const observerCode = visibilityObserverScript(directory);
record("provenance", {
	directory,
	runtime: process.execPath,
	node: process.versions.node,
	bun: process.versions.bun,
	powershell,
	powershellHash: hash(powershell),
	cmd,
	cmdHash: hash(cmd),
});
function own(child: ChildProcess): Promise<number | null> {
	owners.push(child);
	const result = waitForChildProcess(child);
	result.catch((error) => record("owned-process-error", String(error)));
	exits.push(result);
	return result;
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
		else if (
			!console ||
			console[4] === "0" ||
			console[5] !== "False" ||
			console[6] !== "True" ||
			console[7] !== "ConsoleWindowClass"
		) {
			auditErrors.push(
				new Error(
					`${name}: visibility INCONCLUSIVE (console not enumerable/classic; terminal handoff not excluded)`,
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
	const options: SpawnOptions = {
		detached,
		stdio: "ignore",
		...(trampoline ? { windowsVerbatimArguments: true, argv0: `"${cmd}"` } : {}),
	};
	record("launch", { name, ...spec, options: { ...options, windowsHide: true } });
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
	assert(c.code === 37 && c.started && c.done, "C trampoline failed; stop without another launcher");
	symlinkSync(win32.dirname(powershell), junction, "junction");
	junctionCreated = true;
	record("owned-junction", { junction, target: win32.dirname(powershell) });
	const spaceImage = safeImage(join(junction, win32.basename(powershell)));
	assert.equal(hash(spaceImage), hash(powershell));
	const space = await run("C-space", true, true, spaceImage);
	assert(space.code === 37 && space.started && space.done, "C-space quoting failed; stop");

	assert(Date.now() < workDeadline, "Launch probe work budget expired");
	await setPhase("D", "armed");
	record("D-launch-plan", launchSpec(directory, "D", true));
	const caller = spawnHidden(process.execPath, [process.argv[1]!, "--caller", directory], { stdio: "ignore" });
	trampolineCases.add("D");
	assert.equal(await observe(own(caller), budget(5000), "D original caller exit"), 0);
	const broker = Number(readFileSync(join(directory, "D-broker"), "utf8"));
	assert(Number.isInteger(broker) && broker > 0);
	departedPids.push(broker);
	record("D-caller-exited-before-gate", { caller: caller.pid, broker });
	assert(!existsSync(join(directory, "D-gate")));
	await waitUntil(() => existsSync(join(directory, "D-ready")), budget(15000), "D sentinel after caller exit");
	const dReady = readFileSync(join(directory, "D-ready"), "utf8");
	const sentinelPid = Number(dReady.split("|")[0]);
	assert(Number.isInteger(sentinelPid) && sentinelPid > 0);
	departedPids.push(sentinelPid);
	record("sentinel-ready", {
		name: "D",
		ready: dReady,
		metadata: readFileSync(join(directory, "D-metadata"), "utf8"),
	});
	await setPhase("D", "audit", dReady.split("|")[1]);
	if (dReady.split("|")[2] === "True") auditErrors.push(new Error("D: sentinel console is visible"));
	writeFileSync(join(directory, "D-gate"), "release");
	await waitUntil(
		() =>
			existsSync(join(directory, "D-done")) &&
			readFileSync(join(directory, "D-done"), "utf8") === "fixed launch sentinel v1 completed",
		budget(15000),
		"D sentinel completion",
	);
	await waitUntil(
		() => departedPids.every((pid) => !isProcessAlive(pid)),
		budget(15000),
		"D broker and sentinel exit",
	);
	assert.equal(readFileSync(join(directory, "D-done"), "utf8"), "fixed launch sentinel v1 completed");
	assert(!existsSync(join(directory, "D-error")), "D sentinel reported an error before exit");
	record("D-completed-after-caller-exit", { departedPids });
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
		for (const suffix of ["started", "metadata", "ready", "ready.tmp", "done", "done.tmp", "error", "broker"]) {
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
record("PASS-launch-and-observed-hidden-console", { directory });
