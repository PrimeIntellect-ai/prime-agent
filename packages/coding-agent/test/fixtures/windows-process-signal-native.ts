import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand } from "../../src/core/exec.js";
import { isProcessAlive, spawnHidden, waitForChildProcess } from "../../src/utils/child-process.js";
import {
	captureWindowsProcessCreationTime,
	createWindowsProcessTreeSignal,
} from "../../src/utils/windows-process-signal.js";

assert.equal(process.platform, "win32", "This fixture requires native Windows");
const nodeVersion = process.versions.node.split(".").map(Number);
assert(nodeVersion[0]! > 22 || (nodeVersion[0] === 22 && nodeVersion[1]! >= 8));

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const decode = (command: { args: string[] }) => Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
const encode = (command: { args: string[] }, script: string) => {
	command.args[command.args.length - 1] = Buffer.from(script, "utf16le").toString("base64");
};
const gate = (path: string) => `while (!(Test-Path -LiteralPath ${quote(path)})) { Start-Sleep -Milliseconds 25 }`;

if (process.argv[2] === "--exit-caller") {
	const command = createWindowsProcessTreeSignal(Number(process.argv[3]), "SIGKILL");
	encode(command, `${gate(process.argv[4]!)}\n${decode(command)}`);
	const helper = spawnHidden(command.command, command.args, { detached: true, stdio: "ignore" });
	writeFileSync(process.argv[5]!, String(helper.pid));
	process.exit(0);
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 15000;
	while (!condition()) {
		assert(Date.now() < deadline, "Native process condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const directory = mkdtempSync(join(tmpdir(), "prime-agent-identity-native-"));
const stopMarker = join(directory, "stop-owned-tree");
const leafScript = `const { existsSync } = require("node:fs"); setInterval(() => { if (existsSync(process.argv[1])) process.exit(0); }, 25);`;
const treeScript = `const { spawn } = require("node:child_process"); const { existsSync, writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(leafScript)}, process.argv[2]], { stdio: "ignore" }); child.on("spawn", () => writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]))); setInterval(() => { if (existsSync(process.argv[2])) process.exit(0); }, 25);`;
const processes: Array<{ pid: number; identity?: string }> = [];
const gates: string[] = [];
const cleanupErrors: unknown[] = [];
const owners: ChildProcess[] = [];
let execFinished = true;
let testError: unknown;

async function readTree(path: string): Promise<[number, number]> {
	await until(() => existsSync(path));
	const pids = JSON.parse(readFileSync(path, "utf8")) as [number, number];
	const records = pids.map((pid) => ({ pid, identity: undefined as string | undefined }));
	processes.push(...records);
	for (const record of records) {
		assert(isProcessAlive(record.pid));
		record.identity = captureWindowsProcessCreationTime(record.pid);
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
	return waitForChildProcess(spawnHidden(command.command, command.args, { stdio: "ignore", detached: true }));
}

try {
	// A real abort must remove both live processes; a root-only fallback would cancel escalation.
	const ready = join(directory, "exec-tree");
	const controller = new AbortController();
	execFinished = false;
	const result = execCommand(process.execPath, ["-e", treeScript, ready, stopMarker], process.cwd(), {
		signal: controller.signal,
	});
	result.then(
		() => {
			execFinished = true;
		},
		() => {
			execFinished = true;
		},
	);
	const owned = await readTree(ready);
	controller.abort();
	assert.equal((await result).killed, true);
	await until(() => owned.every((pid) => !isProcessAlive(pid)));
	console.log("PASS owned exec removes a live whole tree");

	const mismatched = await liveTree("mismatched");
	const mismatchCommand = createWindowsProcessTreeSignal(mismatched.pids[0], "SIGKILL");
	encode(mismatchCommand, decode(mismatchCommand).replace(/\$actual -eq '\d+'/, "$actual -eq '1'"));
	assert.equal(await runHelper(mismatchCommand), 3);
	assert(mismatched.pids.every(isProcessAlive));
	console.log("PASS mismatched identity leaves the whole tree alive");

	const departing = await liveTree("departing");
	const release = join(directory, "caller-exit-gate");
	const helperPidFile = join(directory, "caller-exit-helper");
	gates.push(release);
	const caller = spawnHidden(
		process.execPath,
		[process.argv[1]!, "--exit-caller", String(departing.pids[0]), release, helperPidFile],
		{ stdio: "ignore" },
	);
	owners.push(caller);
	assert.equal(await waitForChildProcess(caller), 0);
	assert(departing.pids.every(isProcessAlive));
	const helperPid = Number(readFileSync(helperPidFile, "utf8"));
	assert(isProcessAlive(helperPid));
	processes.push({ pid: helperPid, identity: captureWindowsProcessCreationTime(helperPid) });
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
	const heldHelper = spawnHidden(heldCommand.command, heldCommand.args, { stdio: "ignore", detached: true });
	owners.push(heldHelper);
	const heldResult = waitForChildProcess(heldHelper);
	heldResult.catch((error) => cleanupErrors.push(error));
	processes.push({ pid: heldHelper.pid!, identity: captureWindowsProcessCreationTime(heldHelper.pid!) });
	await until(() => existsSync(pinReady));
	held.root.kill("SIGKILL");
	await waitForChildProcess(held.root);
	writeFileSync(pinRelease, "release");
	assert.notEqual(await heldResult, 97, "Process.Dispose must close the helper's own pin");
	assert.equal(readFileSync(verified, "utf8"), identity, "StartTime must query the pinned object after its exit");
	console.log("PASS cached HANDLE lifetime and exact FILETIME after target exit");

	const gone = await liveTree("gone");
	const goneCommand = createWindowsProcessTreeSignal(gone.pids[0], "SIGKILL");
	gone.root.kill("SIGKILL");
	await waitForChildProcess(gone.root);
	assert.notEqual(await runHelper(goneCommand), 0);
	assert(isProcessAlive(gone.pids[1]));
	console.log("PASS target gone before verification fails closed");
} catch (error) {
	testError = error;
} finally {
	const recorded = JSON.stringify(processes.map(({ pid, identity }) => ({ pid, identity: identity ?? null })));
	console.error(`Native fixture records before cleanup (${directory}): ${recorded}`);
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
	// Preserve the marker and records: a late-starting descendant must still stop itself.
	for (const error of cleanupErrors) console.error("Native fixture cleanup error:", error);
}
if (testError !== undefined || cleanupErrors.length) {
	throw new AggregateError(
		testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
		"Native fixture failed",
	);
}
console.log(
	`PASS native identity-pinned signals under ${Reflect.get(globalThis, "Bun") ? "Bun" : "Node"} ${process.version}`,
);
