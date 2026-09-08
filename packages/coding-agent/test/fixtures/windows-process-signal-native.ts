import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "../../src/core/exec.js";
import {
	isProcessAlive,
	spawnHidden,
	spawnWindowsProcessTreeSignal,
	waitForChildProcess,
} from "../../src/utils/child-process.js";
import {
	captureWindowsProcessCreationTime,
	createWindowsProcessTreeSignal,
} from "../../src/utils/windows-process-signal.js";
import { cooperativeTreeScript, observe, waitUntil } from "./windows-process-observation.js";

assert.equal(process.platform, "win32", "This fixture requires native Windows");
assert(Reflect.get(globalThis, "Bun"), "This fixture requires Bun");

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const decode = (command: { args: string[] }) => Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
const encode = (command: { args: string[] }, script: string) => {
	command.args[command.args.length - 1] = Buffer.from(script, "utf16le").toString("base64");
};
const gate = (path: string) => `while (!(Test-Path -LiteralPath ${quote(path)})) { Start-Sleep -Milliseconds 25 }`;

const began = Date.now();
const phase = (name: string, detail: unknown = null) =>
	console.error(
		JSON.stringify({
			phase: name,
			ms: Date.now() - began,
			pid: process.pid,
			detail,
		}),
	);
function traceCommand(command: { args: string[] }, path: string): void {
	const emit = (name: string) =>
		`Add-Content -LiteralPath ${quote(path)} -Encoding UTF8 -Value ("$([DateTime]::UtcNow.ToString('o')) ${name}")`;
	const script = decode(command)
		.replace(
			"$null = $process.Handle",
			`${emit("open-start")}\n    $null = $process.Handle\n    ${emit("handle-cached")}`,
		)
		.replace("    if ($actual -eq", `    ${emit("identity=$actual")}\n    if ($actual -eq`)
		.replace("        & ", `        ${emit("taskkill-start")}\n        & `)
		.replace("$code = $LASTEXITCODE", `$code = $LASTEXITCODE\n        ${emit("taskkill-exit=$code")}`)
		.replace("} catch {", `} catch {\n    ${emit("helper-error=$_")}`);
	encode(command, `${emit("helper-start")}\n${script}`);
}

if (process.argv[2] === "--exit-caller") {
	phase("caller-capture-start", { target: process.argv[3] });
	const command = createWindowsProcessTreeSignal(Number(process.argv[3]), "SIGKILL");
	phase("caller-capture-complete");
	traceCommand(command, process.argv[6]!);
	encode(command, `${gate(process.argv[4]!)}\n${decode(command)}`);
	const helper = spawnWindowsProcessTreeSignal(command);
	writeFileSync(process.argv[5]!, String(helper.pid));
	phase("caller-helper-spawned", { helperPid: helper.pid });
	process.exit(0);
}

async function until(condition: () => boolean, label = "native condition"): Promise<void> {
	phase(`${label}:waiting`);
	await waitUntil(condition, 15000, label);
	phase(`${label}:complete`);
}

const directory = mkdtempSync(join(tmpdir(), "prime-agent-identity-native-"));
const stopMarker = join(directory, "stop-owned-tree");
const treeScript = cooperativeTreeScript;
const processes: Array<{ pid: number; identity?: string }> = [];
const gates: string[] = [];
const cleanupErrors: unknown[] = [];
const owners: ChildProcess[] = [];
const traces: string[] = [];
function tracePath(name: string): string {
	const path = join(directory, `${name}.log`);
	traces.push(path);
	return path;
}
function dumpTraces(stage: string): void {
	for (const path of traces) {
		try {
			phase("helper-trace", { stage, path, text: readFileSync(path, "utf8").slice(0, 4096) });
		} catch (error) {
			phase("helper-trace-unavailable", { stage, path, error: String(error) });
		}
	}
}
let execFinished = true;
let testError: unknown;

async function readTree(path: string): Promise<[number, number]> {
	await until(() => existsSync(path));
	const pids = JSON.parse(readFileSync(path, "utf8")) as [number, number];
	const records = pids.map((pid) => ({ pid, identity: undefined as string | undefined }));
	processes.push(...records);
	for (const record of records) {
		assert(isProcessAlive(record.pid));
		phase("capture-start", record);
		record.identity = captureWindowsProcessCreationTime(record.pid);
		phase("capture-complete", record);
	}
	return pids;
}

async function liveTree(name: string): Promise<{ root: ChildProcess; pids: [number, number] }> {
	const path = join(directory, name);
	const root = spawnHidden(process.execPath, ["-e", treeScript, path, stopMarker], { stdio: "ignore" });
	owners.push(root);
	root.once("error", (error) => cleanupErrors.push(error));
	return { root, pids: await readTree(path) };
}

async function runHelper(command: { command: string; args: string[] }): Promise<number | null> {
	const log = tracePath(`helper-${traces.length}`);
	traceCommand(command, log);
	const helper = spawnWindowsProcessTreeSignal(command);
	owners.push(helper);
	phase("helper-spawned", { helperPid: helper.pid, log });
	helper.once("error", (error) => phase("helper-error", String(error)));
	helper.once("exit", (code, signal) => phase("helper-exit", { code, signal }));
	return observe(waitForChildProcess(helper), 15000, "helper completion");
}

try {
	const mismatched = await liveTree("mismatched");
	const mismatchCommand = createWindowsProcessTreeSignal(mismatched.pids[0], "SIGKILL");
	encode(mismatchCommand, decode(mismatchCommand).replace(/\$actual -eq '\d+'/, "$actual -eq '1'"));
	assert.equal(await runHelper(mismatchCommand), 3);
	assert(mismatched.pids.every(isProcessAlive));
	console.log("PASS mismatched identity leaves the whole tree alive");

	// A real abort must remove both live processes; a root-only fallback would cancel escalation.
	const ready = join(directory, "exec-tree");
	const controller = new AbortController();
	execFinished = false;
	const result = execCommand(process.execPath, ["-e", treeScript, ready, stopMarker], process.cwd(), {
		signal: controller.signal,
	});
	result.then(
		(value) => {
			execFinished = true;
			phase("owned-exec-result", { code: value.code, killed: value.killed, stderr: value.stderr.slice(0, 4096) });
		},
		(error) => {
			execFinished = true;
			phase("owned-exec-error", String(error));
		},
	);
	const owned = await readTree(ready);
	phase("owned-exec-abort", owned);
	controller.abort();
	assert.equal((await observe(result, 15000, "owned exec result")).killed, true);
	await until(() => owned.every((pid) => !isProcessAlive(pid)));
	console.log("PASS owned exec removes a live whole tree");

	const departing = await liveTree("departing");
	const release = join(directory, "caller-exit-gate");
	const helperPidFile = join(directory, "caller-exit-helper");
	const callerLog = tracePath("caller-exit-helper");
	gates.push(release);
	const caller = spawnHidden(
		process.execPath,
		[process.argv[1]!, "--exit-caller", String(departing.pids[0]), release, helperPidFile, callerLog],
		{ stdio: "ignore" },
	);
	owners.push(caller);
	assert.equal(await observe(waitForChildProcess(caller), 15000, "original caller exit"), 0);
	phase("original-caller-exited");
	assert(departing.pids.every(isProcessAlive));
	const helperPid = Number(readFileSync(helperPidFile, "utf8"));
	assert(isProcessAlive(helperPid));
	processes.push({ pid: helperPid, identity: captureWindowsProcessCreationTime(helperPid) });
	phase("caller-gate-release", { helperPid, alive: isProcessAlive(helperPid) });
	writeFileSync(release, "release");
	await until(() => departing.pids.every((pid) => !isProcessAlive(pid)) && !isProcessAlive(helperPid));
	console.log("PASS verification and tree kill after the original caller exits");

	// Delay after .Handle acquisition, then exit the target before .StartTime is read.
	const held = await liveTree("held");
	const identity = captureWindowsProcessCreationTime(held.pids[0]);
	const pinReady = join(directory, "pin-ready");
	const pinRelease = join(directory, "pin-release");
	const verified = join(directory, "verified-identity");
	gates.push(pinRelease);
	const heldCommand = createWindowsProcessTreeSignal(held.pids[0], "SIGKILL");
	const heldScript = decode(heldCommand)
		.replace(
			"$null = $process.Handle",
			`$null = $process.Handle\n    $pin = $process.SafeHandle\n    [IO.File]::WriteAllText(${quote(pinReady)}, 'ready')\n    ${gate(pinRelease)}`,
		)
		.replace("    if ($actual -eq", `    [IO.File]::WriteAllText(${quote(verified)}, $actual)\n    if ($actual -eq`)
		.replace("exit $code", "if (!$pin.IsClosed) { exit 97 }\nexit $code");
	encode(heldCommand, heldScript);
	traceCommand(heldCommand, tracePath("held-helper"));
	const heldHelper = spawnWindowsProcessTreeSignal(heldCommand);
	owners.push(heldHelper);
	const heldResult = waitForChildProcess(heldHelper);
	heldResult.catch((error) => cleanupErrors.push(error));
	processes.push({ pid: heldHelper.pid!, identity: captureWindowsProcessCreationTime(heldHelper.pid!) });
	await until(() => existsSync(pinReady), "helper pin ready");
	phase("helper-pin-held", { helperPid: heldHelper.pid, target: held.pids[0], identity });
	held.root.kill("SIGKILL");
	await observe(waitForChildProcess(held.root), 15000, "held target exit");
	writeFileSync(pinRelease, "release");
	assert.notEqual(
		await observe(heldResult, 15000, "held helper completion"),
		97,
		"Process.Dispose must close the helper's own pin",
	);
	assert.equal(readFileSync(verified, "utf8"), identity, "StartTime must query the pinned object after its exit");
	console.log("PASS cached HANDLE lifetime and exact FILETIME after target exit");

	const gone = await liveTree("gone");
	const goneCommand = createWindowsProcessTreeSignal(gone.pids[0], "SIGKILL");
	gone.root.kill("SIGKILL");
	await observe(waitForChildProcess(gone.root), 15000, "gone target exit");
	assert.notEqual(await runHelper(goneCommand), 0);
	assert(isProcessAlive(gone.pids[1]));
	console.log("PASS target gone before verification fails closed");
} catch (error) {
	testError = error;
} finally {
	const recorded = JSON.stringify(processes.map(({ pid, identity }) => ({ pid, identity: identity ?? null })));
	phase("before-cleanup", { directory, records: processes, alive: processes.map(({ pid }) => isProcessAlive(pid)) });
	dumpTraces("before-cleanup");
	try {
		writeFileSync(join(directory, "process-records.json"), recorded);
	} catch (error) {
		cleanupErrors.push(error);
	}
	// Only these fixture processes observe this unique marker, including orphaned leaves.
	for (const path of [...gates, stopMarker]) {
		try {
			writeFileSync(path, "release");
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		await until(
			() =>
				execFinished &&
				owners.every((child) => child.exitCode !== null || child.signalCode !== null) &&
				processes.every(({ pid }) => !isProcessAlive(pid)),
		);
	} catch (error) {
		cleanupErrors.push(error);
	}
	dumpTraces("after-cleanup");
	// Preserve the marker and records: a late-starting descendant must still stop itself.
	for (const error of cleanupErrors) console.error("Native fixture cleanup error:", error);
}
if (testError !== undefined || cleanupErrors.length) {
	throw new AggregateError(
		testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
		"Native fixture failed",
	);
}
console.log(`PASS native identity-pinned signals under Bun ${process.versions.bun}`);
