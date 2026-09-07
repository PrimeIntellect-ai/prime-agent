import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHostedSessionStore } from "../src/modes/daemon/sandbox/hosted-session-store.js";

const sourcePath = resolve(import.meta.dir, "../src/modes/daemon/sandbox/hosted-session-store.ts");
const helperPath = resolve(import.meta.dir, "../src/modes/daemon/sandbox/hosted-session-store-posix-helper.py");

function expectExactFailure(value: unknown): void {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	if (typeof value !== "object" || value === null) return;
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	expect(Object.getOwnPropertyNames(value)).toEqual(["code"]);
	expect(Object.getOwnPropertySymbols(value)).toEqual([]);
	expect(Object.isFrozen(value)).toBe(true);
	expect(Object.getOwnPropertyDescriptor(value, "code")).toEqual({
		value: "FAILED",
		writable: false,
		enumerable: true,
		configurable: false,
	});
}

function issueLoaded(): object {
	return Object.freeze({ code: "INVALID" });
}

function read(): object {
	return Object.freeze({ code: "UNKNOWN" });
}

function replace(): object {
	return Object.freeze({ code: "INVALID" });
}

async function finiteWait<T>(
	promise: Promise<T>,
	milliseconds: number,
): Promise<{ done: true; value: T } | { done: false }> {
	return await new Promise((resolveWait) => {
		const timer = setTimeout(() => resolveWait({ done: false }), milliseconds);
		promise.then((value) => {
			clearTimeout(timer);
			resolveWait({ done: true, value });
		});
	});
}

function signalDetachedGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (failure) {
		if (!(failure instanceof Error) || !("code" in failure) || failure.code !== "ESRCH") throw failure;
	}
}

function requireDetachedGroupAbsent(pid: number): void {
	let absent = false;
	try {
		process.kill(-pid, 0);
	} catch (failure) {
		absent = failure instanceof Error && "code" in failure && failure.code === "ESRCH";
	}
	if (!absent) throw new Error(`process group ${pid} survived cleanup`);
}

async function collectSpawn(
	executable: string,
	args: string[],
	stdio: ["ignore", "pipe", "pipe", number],
	deadlines: { complete: number; term: number; kill: number } = { complete: 5_000, term: 2_000, kill: 2_000 },
): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	cleanupSignals: NodeJS.Signals[];
}> {
	const child = spawn(executable, args, { cwd: "/", env: {}, detached: true, stdio });
	if (child.pid === undefined || child.stdout === null || child.stderr === null) throw new Error("spawn contract");
	const pid = child.pid;
	let stdout = "";
	let stderr = "";
	let code: number | null = null;
	let signal: NodeJS.Signals | null = null;
	const cleanupSignals: NodeJS.Signals[] = [];
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<void>((resolveExit) => {
		child.once("error", () => resolveExit());
		child.once("exit", (exitCode, exitSignal) => {
			code = exitCode;
			signal = exitSignal;
			resolveExit();
		});
	});
	const stdoutClosed = new Promise<void>((resolveClose) => child.stdout?.once("close", resolveClose));
	const stderrClosed = new Promise<void>((resolveClose) => child.stderr?.once("close", resolveClose));
	const settled = Promise.all([exited, stdoutClosed, stderrClosed]);
	let outcome = await finiteWait(settled, deadlines.complete);
	if (!outcome.done) {
		cleanupSignals.push("SIGTERM");
		signalDetachedGroup(pid, "SIGTERM");
		outcome = await finiteWait(settled, deadlines.term);
		if (!outcome.done) {
			cleanupSignals.push("SIGKILL");
			signalDetachedGroup(pid, "SIGKILL");
			outcome = await finiteWait(settled, deadlines.kill);
			if (!outcome.done) {
				requireDetachedGroupAbsent(pid);
				throw new Error("KILL drain timeout");
			}
		}
	}
	requireDetachedGroupAbsent(pid);
	return { code, signal, stdout, stderr, cleanupSignals };
}

async function descriptorExecutionGate(python: string, descriptorPath: string): Promise<void> {
	const temporary = mkdtempSync(resolve(tmpdir(), "hosted-store-v22-fd-"));
	const candidate = resolve(temporary, "descriptor-gate.py");
	const validated = resolve(temporary, "descriptor-gate.validated.py");
	const original = Buffer.from(
		"import os,sys\n" + "assert os.getpid() > 1\n" + "assert sys.version_info.major == 3\n" + "print('BOUND')\n",
	);
	try {
		writeFileSync(candidate, original, { mode: 0o644 });
		const closeOnExec = process.platform === "darwin" ? 0x01000000 : 0x00080000;
		const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | closeOnExec);
		try {
			const before = fstatSync(fd);
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(257);
			const ranges: Array<readonly [number, number]> = [];
			let position = 0;
			while (position < before.size) {
				const wanted = Math.min(buffer.byteLength, before.size - position);
				const count = readSync(fd, buffer, 0, wanted, position);
				expect(count).toBeGreaterThan(0);
				ranges.push([position, position + count]);
				hash.update(buffer.subarray(0, count));
				position += count;
			}
			expect(ranges[0]?.[0]).toBe(0);
			for (let index = 1; index < ranges.length; index += 1) expect(ranges[index]?.[0]).toBe(ranges[index - 1]?.[1]);
			expect(ranges.at(-1)?.[1]).toBe(before.size);
			expect(position).toBe(before.size);
			expect(hash.digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
			const after = fstatSync(fd);
			for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size"] as const)
				expect(after[key]).toBe(before[key]);
			expect(after.isFile()).toBe(before.isFile());

			// This probe shares the open file description with fd 3. lseek reads but does not change its offset.
			const offsetProbe = await collectSpawn(
				python,
				["-c", "import os;print(os.lseek(3,0,1))"],
				["ignore", "pipe", "pipe", fd],
			);
			expect(offsetProbe).toEqual({
				code: 0,
				signal: null,
				stdout: "0\n",
				stderr: "",
				cleanupSignals: [],
			});
			const escalated = await collectSpawn(
				python,
				[
					"-c",
					"import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('READY',flush=True);time.sleep(30)",
				],
				["ignore", "pipe", "pipe", fd],
				{ complete: 500, term: 200, kill: 2_000 },
			);
			expect(escalated).toEqual({
				code: null,
				signal: "SIGKILL",
				stdout: "READY\n",
				stderr: "",
				cleanupSignals: ["SIGTERM", "SIGKILL"],
			});

			// Synchronization is complete. Replace the hostile pathname only now, before asynchronous spawn.
			renameSync(candidate, validated);
			writeFileSync(candidate, "raise SystemExit(99)\n", { mode: 0o644 });
			const executed = await collectSpawn(python, [descriptorPath], ["ignore", "pipe", "pipe", fd]);
			expect(executed.code, executed.stderr).toBe(0);
			expect(executed.signal).toBeNull();
			expect(executed.stderr).toBe("");
			expect(executed.stdout).toBe("BOUND\n");
			expect(executed.cleanupSignals).toEqual([]);
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

async function expectRejectedRegistry(value: unknown): Promise<object> {
	const result = await createHostedSessionStore(value);
	expectExactFailure(result);
	return result;
}

describe("hosted session store V22 boundary", () => {
	test("has one runtime export", async () => {
		const module = await import("../src/modes/daemon/sandbox/hosted-session-store.js");
		expect(Object.keys(module)).toEqual(["createHostedSessionStore"]);
		expect(module.createHostedSessionStore).toBe(createHostedSessionStore);
	});

	test("rejects primitive registry values without starting the helper", async () => {
		const values: unknown[] = [undefined, null, false, 0, "", Symbol("registry"), issueLoaded];
		for (let index = 0; index < values.length; index += 1) await expectRejectedRegistry(values[index]);
	});

	test("rejects registry prototype, order, key, and freeze deviations", async () => {
		const nullPrototype = Object.create(null);
		Object.defineProperties(nullPrototype, {
			issueLoaded: { value: issueLoaded, enumerable: true },
			read: { value: read, enumerable: true },
			replace: { value: replace, enumerable: true },
		});
		Object.freeze(nullPrototype);
		const inherited = Object.create(Object.freeze({ issueLoaded, read, replace }));
		Object.freeze(inherited);
		const wrongOrder = Object.freeze({ read, issueLoaded, replace });
		const missing = Object.freeze({ issueLoaded, read });
		const extra = Object.freeze({ issueLoaded, read, replace, extra: true });
		const unfrozen = { issueLoaded, read, replace };
		const values: unknown[] = [nullPrototype, inherited, wrongOrder, missing, extra, unfrozen];
		for (let index = 0; index < values.length; index += 1) await expectRejectedRegistry(values[index]);
	});

	test("rejects symbols, accessors, proxies, and non-method fields", async () => {
		const withSymbol = { issueLoaded, read, replace };
		Object.defineProperty(withSymbol, Symbol("extra"), { value: true });
		Object.freeze(withSymbol);
		const accessor = {};
		Object.defineProperties(accessor, {
			issueLoaded: { get: issueLoaded, enumerable: true, configurable: false },
			read: { value: read, enumerable: true, writable: false, configurable: false },
			replace: { value: replace, enumerable: true, writable: false, configurable: false },
		});
		Object.freeze(accessor);
		const proxy = new Proxy(Object.freeze({ issueLoaded, read, replace }), {});
		const wrongMethod = Object.freeze({ issueLoaded, read, replace: 1 });
		const values: unknown[] = [withSymbol, accessor, proxy, wrongMethod];
		for (let index = 0; index < values.length; index += 1) await expectRejectedRegistry(values[index]);
	});

	test("returns a fresh exact failure for each invalid construction", async () => {
		const first = await createHostedSessionStore(null);
		const second = await createHostedSessionStore(null);
		expectExactFailure(first);
		expectExactFailure(second);
		expect(first).not.toBe(second);
	});
});

describe("hosted session store source constraints", () => {
	test("binds the accepted helper bytes and file invariant", () => {
		const bytes = readFileSync(helperPath);
		const stat = lstatSync(helperPath);
		expect(bytes.byteLength).toBe(159255);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			"3107f2126945a6664875d07c66578ee93fabb097364222b353c40f440918558c",
		);
		expect(stat.isFile()).toBe(true);
		expect(stat.nlink).toBe(1);
		expect(stat.mode & 0o7777).toBe(0o644);
	});

	test("uses the fd-bound positional asynchronous spawn path", () => {
		const source = readFileSync(sourcePath, "utf8");
		const positionalRead = source.indexOf("_readSync(fd, buffer, 0, wanted, position)");
		const completedRange = source.indexOf("position !== before.size", positionalRead);
		const secondStat = source.indexOf("const after = _fstatSync(fd", completedRange);
		const equalSecondStat = source.indexOf("sameStat(before, after)", secondStat);
		const asynchronousSpawn = source.indexOf("child = _spawn(", equalSecondStat);
		expect(positionalRead).toBeGreaterThan(0);
		expect(completedRange).toBeGreaterThan(positionalRead);
		expect(secondStat).toBeGreaterThan(completedRange);
		expect(equalSecondStat).toBeGreaterThan(secondStat);
		expect(asynchronousSpawn).toBeGreaterThan(equalSecondStat);
		expect(source).toContain('process.platform === "darwin" ? "/dev/fd/3"');
		expect(source).toContain('process.platform === "linux" ? "/proc/self/fd/3"');
		expect(source).toContain('cwd: "/"');
		expect(source).toContain("env: {}");
		expect(source).toContain("detached: true");
		expect(source).toContain('stdio: ["pipe", "pipe", "pipe", validated.fd]');
		expect(source).not.toContain("spawn" + "Sync");
		expect(source).not.toContain("lseek");
	});

	test("runs the combined Darwin descriptor gate on the authoritative Bun and Python", async () => {
		expect(process.platform).toBe("darwin");
		expect(Bun.version).toBe("1.4.0");
		await descriptorExecutionGate("/opt/homebrew/bin/python3", "/dev/fd/3");
	});

	test("keeps caller validation ahead of every allocation effect", () => {
		const source = readFileSync(sourcePath, "utf8");
		const start = source.indexOf("async allocateOperation(");
		const end = source.indexOf("async simpleTransitionOperation(", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const operation = source.slice(start, end);
		const identity = operation.indexOf("if (!validIdentityInput(identityRaw)) return failedResult()");
		const digests = operation.indexOf("if (digests === undefined) return failedResult()");
		expect(identity).toBeGreaterThanOrEqual(0);
		expect(digests).toBeGreaterThan(identity);
		for (const effect of [
			"this.poisoned",
			"appendGenesis(",
			"sha256(",
			"this.lifecycle.get(",
			"this.drawGeneration(",
			"makeWal(",
			"await this.helper(",
			"this.issueRegistry(",
			"this.rows.set(",
		])
			expect(operation.indexOf(effect), effect).toBeGreaterThan(digests);
	});

	test("binds the complete owner fault, recovery, and cleanup matrix", () => {
		const source = readFileSync(sourcePath, "utf8");
		for (const exact of [
			"const MAX_PAYLOAD = 1_048_576;",
			"const MAX_UNPARSED = 1_048_581;",
			"const MAX_STDERR = 65_536;",
			"this.command(OPEN, new Uint8Array(0), 30_000, false)",
			"this.helper(INVENTORY, new Uint8Array(0), 120_000, true)",
			"this.command(QUIT, new Uint8Array(0), 30_000, false)",
			'this.signal("SIGTERM")',
			'this.signal("SIGKILL")',
			'errorCode(failure) === "ESRCH"',
			"this.exited && this.stdoutClosed && this.stderrClosed && this.stdinClosed",
			"const fullWait = this.waitSettledFully()",
			"const settled = await this.waitSettled(30_000)",
			"if (pending === undefined || pending.response !== undefined)",
			"if (opcode !== DONE || payload.byteLength !== 0",
			"if (pending.inspect && pending.payloads.length !== 0)",
			"this.stdout.byteLength + chunk.byteLength > MAX_UNPARSED",
			"if (this.stderrBytes > MAX_STDERR) this.fatal()",
			"if (parsed.rolloverCase === 2)",
			"} else if (parsed.rolloverCase === 3)",
			"const removed = await this.helper(REMOVE_RETIRED",
			'if (ledger.status === "running")',
			'if (ledger.status === "cleanup-uncertain"',
		])
			expect(source, exact).toContain(exact);
		expect(source.match(/this\.signal\("SIGTERM"\)/g)?.length).toBe(1);
		expect(source.match(/this\.signal\("SIGKILL"\)/g)?.length).toBe(1);
		expect(source).not.toMatch(/process\.env|process\.argv/);
	});

	test("keeps the hardened TypeScript source forms", () => {
		const source = readFileSync(sourcePath, "utf8");
		expect(source.match(/export function /g)).toEqual(["export function "]);
		expect(source).not.toMatch(/\bany\b/);
		expect(source).not.toMatch(/\bthrow\b/);
		expect(source).not.toContain("...");
		expect(source).not.toMatch(/\sas\s/);
		expect(source).not.toMatch(/TODO|placeholder/i);
	});
});

const externalTest = process.env.PRIME_HOSTED_STORE_EXTERNAL_TEST === "1" ? test : test.skip;

externalTest(
	"runs the exact cached Linux x64 Store against a chroot-local tmpfs root",
	async () => {
		const temporary = mkdtempSync(resolve(tmpdir(), "hosted-store-v22-"));
		const harnessPath = resolve(temporary, "integration.ts");
		writeFileSync(
			harnessPath,
			`import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, closeSync, constants, cpSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHostedSessionStore } from "./src/modes/daemon/sandbox/hosted-session-store.js";
import { types as utilTypes } from "node:util";

interface State {
	identity: object;
	providerState: string;
	generationKey: string;
	releaseDigest: string;
	manifestDigest: string;
	bootstrapDigest: string;
	trustDigest: string;
	runtimeConfigDigest: string;
}

class Capability {
	constructor() {
		Object.freeze(this);
	}
}
const states = new WeakMap<object, State>();
let replaceCalls = 0;
let forceInvalidReplace = false;
const registryEffects = { issueLoaded: 0, read: 0, replace: 0 };
function copyIdentity(raw: object): object {
	const value = raw;
	return Object.freeze({
		schema: value.schema,
		lifecycleKeyDigest: value.lifecycleKeyDigest,
		sessionId: value.sessionId,
		activeSessionId: value.activeSessionId,
		childId: value.childId,
		name: value.name,
		modelSelector: value.modelSelector,
		durableParentSessionId: value.durableParentSessionId,
		rlmParentNodeId: value.rlmParentNodeId,
		spawnedByRequestId: value.spawnedByRequestId,
		thinkingLevel: value.thinkingLevel,
		serviceTier: value.serviceTier,
		spawnContextDigest: value.spawnContextDigest,
		depth: value.depth,
	});
}
function copyState(raw: State): State {
	return Object.freeze({
		identity: copyIdentity(raw.identity),
		providerState: raw.providerState,
		generationKey: raw.generationKey,
		releaseDigest: raw.releaseDigest,
		manifestDigest: raw.manifestDigest,
		bootstrapDigest: raw.bootstrapDigest,
		trustDigest: raw.trustDigest,
		runtimeConfigDigest: raw.runtimeConfigDigest,
	});
}
function equal(left: State, right: State): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
const registry = Object.freeze({
	issueLoaded(identityRaw: object, stateRaw: State): object {
		registryEffects.issueLoaded += 1;
		if (JSON.stringify(identityRaw) !== JSON.stringify(stateRaw.identity)) return Object.freeze({ code: "INVALID" });
		const cap = new Capability();
		states.set(cap, copyState(stateRaw));
		return Object.freeze({ code: "ISSUED", session: cap });
	},
	read(sessionRaw: object): object {
		registryEffects.read += 1;
		const state = states.get(sessionRaw);
		return state === undefined ? Object.freeze({ code: "UNKNOWN" }) : Object.freeze({ code: "KNOWN", state: copyState(state) });
	},
	replace(sessionRaw: object, expectedRaw: State, nextRaw: State): object {
		registryEffects.replace += 1;
		const state = states.get(sessionRaw);
		if (state === undefined) return Object.freeze({ code: "INVALID" });
		if (!equal(state, expectedRaw)) return Object.freeze({ code: "STALE" });
		if (forceInvalidReplace) {
			forceInvalidReplace = false;
			return Object.freeze({ code: "INVALID" });
		}
		if (replaceCalls === 0) {
			replaceCalls += 1;
			return Object.freeze({ code: "STALE" });
		}
		if (replaceCalls === 2) {
			replaceCalls += 1;
			states.set(sessionRaw, copyState(nextRaw));
			return Object.freeze({ code: "STALE" });
		}
		replaceCalls += 1;
		states.set(sessionRaw, copyState(nextRaw));
		return Object.freeze({ code: "REPLACED" });
	},
});
function check(condition: boolean, label: string): void {
	if (!condition) throw new Error(label);
}
async function fdGate(): Promise<void> {
	const candidate = "/tmp/descriptor-gate.py";
	const validated = "/tmp/descriptor-gate.validated.py";
	const original = Buffer.from("import os,sys\\nassert os.getpid()>1\\nassert sys.version_info.major==3\\nprint('BOUND')\\n");
	writeFileSync(candidate, original, { mode: 0o644 });
	const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | 0x00080000);
	try {
		const before = fstatSync(fd);
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(17);
		let position = 0;
		let priorEnd = 0;
		while (position < before.size) {
			const wanted = Math.min(buffer.byteLength, before.size - position);
			const count = readSync(fd, buffer, 0, wanted, position);
			check(count > 0 && position === priorEnd, "linux positional range");
			hash.update(buffer.subarray(0, count));
			position += count;
			priorEnd = position;
		}
		check(position === before.size, "linux full positional range");
		check(hash.digest("hex") === createHash("sha256").update(original).digest("hex"), "linux positional digest");
		const after = fstatSync(fd);
		for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size"] as const)
			check(after[key] === before[key], "linux second fstat " + key);
		check(after.isFile() === before.isFile(), "linux second fstat type");
		const finite = <T>(promise: Promise<T>, milliseconds: number): Promise<{done:true;value:T}|{done:false}> => new Promise((resolveWait) => {
			const timer = setTimeout(() => resolveWait({ done: false }), milliseconds);
			promise.then((value) => { clearTimeout(timer); resolveWait({ done: true, value }); });
		});
		const run = async (args: string[], deadlines = { complete: 5_000, term: 2_000, kill: 2_000 }): Promise<{code:number|null;out:string;err:string;cleanupSignals:string[]}> => {
			const child = spawn("/usr/local/bin/python3", args, { cwd: "/", env: {}, detached: true, stdio: ["ignore", "pipe", "pipe", fd] });
			check(child.pid !== undefined && child.stdout !== null && child.stderr !== null, "linux spawn contract");
			const pid = child.pid;
			let out = "";
			let err = "";
			let code: number | null = null;
			const cleanupSignals: string[] = [];
			child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => { out += chunk; });
			child.stderr.on("data", (chunk: string) => { err += chunk; });
			const exited = new Promise<void>((resolveExit) => {
				child.once("error", () => resolveExit());
				child.once("exit", (exitCode) => { code = exitCode; resolveExit(); });
			});
			const stdoutClosed = new Promise<void>((resolveClose) => child.stdout.once("close", resolveClose));
			const stderrClosed = new Promise<void>((resolveClose) => child.stderr.once("close", resolveClose));
			const settled = Promise.all([exited, stdoutClosed, stderrClosed]);
			let outcome = await finite(settled, deadlines.complete);
			if (!outcome.done) {
				cleanupSignals.push("SIGTERM");
				try { process.kill(-pid, "SIGTERM"); } catch (failure) { if (failure.code !== "ESRCH") throw failure; }
				outcome = await finite(settled, deadlines.term);
				if (!outcome.done) {
					cleanupSignals.push("SIGKILL");
					try { process.kill(-pid, "SIGKILL"); } catch (failure) { if (failure.code !== "ESRCH") throw failure; }
					outcome = await finite(settled, deadlines.kill);
				}
			}
			let absent = false;
			try { process.kill(-pid, 0); } catch (failure) { absent = failure.code === "ESRCH"; }
			check(absent, "linux spawned group ESRCH");
			check(outcome.done, "linux KILL drain deadline");
			return { code, out, err, cleanupSignals };
		};
		const probe = await run(["-c", "import os;print(os.lseek(3,0,1))"]);
		check(probe.code === 0 && probe.out === "0\\n" && probe.err === "" && probe.cleanupSignals.length === 0, "linux shared offset zero");
		const escalated = await run(
			["-c", "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('READY',flush=True);time.sleep(30)"],
			{ complete: 500, term: 200, kill: 2_000 },
		);
		check(escalated.code === null && escalated.out === "READY\\n" && escalated.err === "", "linux escalated result");
		check(JSON.stringify(escalated.cleanupSignals) === '["SIGTERM","SIGKILL"]', "linux TERM KILL exercise");
		renameSync(candidate, validated);
		writeFileSync(candidate, "raise SystemExit(99)\\n", { mode: 0o644 });
		const executed = await run(["/proc/self/fd/3"]);
		check(executed.code === 0 && executed.out === "BOUND\\n" && executed.err === "" && executed.cleanupSignals.length === 0, "linux bound full execution");
	} finally {
		closeSync(fd);
		rmSync(candidate, { force: true });
		rmSync(validated, { force: true });
	}
}
if (process.argv[2] === undefined || process.argv[2] === "timeout") await fdGate();
if (process.argv[2]?.startsWith("rollover-verify")) {
	const verifyFactory = await createHostedSessionStore(registry);
	check(verifyFactory.code === "READY", "rollover verify factory");
	if (verifyFactory.code !== "READY") process.exit(90);
	const verifyInventory1 = await verifyFactory.store.inventory();
	const verifyInventory2 = await verifyFactory.store.inventory();
	check(verifyInventory1.code === "INVENTORIED" && verifyInventory2.code === "INVENTORIED", "rollover verify inventory");
	if (verifyInventory1.code !== "INVENTORIED" || verifyInventory2.code !== "INVENTORIED") process.exit(91);
	check(verifyInventory1.sessions.length === 1 && verifyInventory2.sessions.length === 1 && verifyInventory1.sessions[0] === verifyInventory2.sessions[0], "rollover verify one retained cap");
	const verifyState = await verifyFactory.store.state(verifyInventory1.sessions[0]);
	check(verifyState.code === "STATE" && verifyState.state === "ALLOCATED", "rollover verify state");
	check((await verifyFactory.store.close()).code === "CLOSED", "rollover verify close");
	console.log("ROLLOVER_VERIFY_OK " + process.argv[2]);
	process.exit(0);
}
if (process.argv[2]?.startsWith("rollover-cut")) {
	const cutFactory = await createHostedSessionStore(registry);
	check(cutFactory.code === "READY", "rollover cut factory");
	if (cutFactory.code !== "READY") process.exit(92);
	check((await cutFactory.store.inventory()).code === "INVENTORIED", "rollover cut inventory");
	const cutIdentity = Object.freeze({ sessionId: "cut-s", activeSessionId: "cut-a", childId: "cut-c", name: "cut", modelSelector: "model", durableParentSessionId: "cut-p", rlmParentNodeId: "cut-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "44".repeat(32), depth: 1 });
	const cutDigests = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
	const cutAllocation = await cutFactory.store.allocate(cutIdentity, cutDigests);
	check(cutAllocation.code === "ALLOCATED", "rollover cut allocate");
	if (cutAllocation.code !== "ALLOCATED") process.exit(93);
	check((await cutFactory.store.createDispatched(cutAllocation.session)).code === "COMMITTED", "rollover cut create");
	check((await cutFactory.store.retireAndAdvance(cutAllocation.session)).code === "FAILED", "rollover publication cut failed current Store");
	check((await cutFactory.store.inventory()).code === "FAILED", "rollover cut poison reuse");
	check((await cutFactory.store.close()).code === "FAILED", "rollover cut close");
	console.log("ROLLOVER_CUT_OK " + process.argv[2]);
	process.exit(0);
}
if (process.argv[2]?.startsWith("fault-")) {
	const scenario = process.argv[2].slice("fault-".length);
	const faultFactory = await createHostedSessionStore(registry);
	check(faultFactory.code === "READY", "fault factory " + scenario);
	if (faultFactory.code !== "READY") process.exit(80);
	const first = await faultFactory.store.inventory();
	let failure = first;
	if (first.code === "INVENTORIED") {
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
		failure = await faultFactory.store.inventory();
	}
	function exactFaultFailed(value: object, label: string): void {
		const descriptor = Object.getOwnPropertyDescriptor(value, "code");
		check(Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertyNames(value).join(",") === "code" && Object.getOwnPropertySymbols(value).length === 0 && Object.isFrozen(value), label + " ordinary");
		check(descriptor?.value === "FAILED" && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " descriptor");
	}
	exactFaultFailed(failure, "fault exact FAILED " + scenario);
	exactFaultFailed(await faultFactory.store.inventory(), "fault reuse " + scenario);
	exactFaultFailed(await faultFactory.store.close(), "fault close " + scenario);
	console.log("FAULT_OK " + scenario);
	process.exit(0);
}
if (process.argv[2] === "timeout") {
	const timeoutFactory = await createHostedSessionStore(registry);
	check(timeoutFactory.code === "READY", "timeout factory");
	if (timeoutFactory.code !== "READY") process.exit(70);
	check((await timeoutFactory.store.inventory()).code === "INVENTORIED", "timeout inventory");
	const timeoutIdentity = Object.freeze({ sessionId: "timeout-s", activeSessionId: "timeout-a", childId: "timeout-c", name: "timeout", modelSelector: "model", durableParentSessionId: "timeout-p", rlmParentNodeId: "timeout-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "33".repeat(32), depth: 1 });
	const timeoutDigests = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
	const timeoutAllocation = await timeoutFactory.store.allocate(timeoutIdentity, timeoutDigests);
	check(timeoutAllocation.code === "ALLOCATED", "timeout allocate");
	if (timeoutAllocation.code !== "ALLOCATED") process.exit(71);
	const proceed = new Promise<void>((resolveProceed) => process.once("SIGUSR1", () => resolveProceed()));
	process.kill(process.ppid, "SIGUSR1");
	await proceed;
	const timed = await timeoutFactory.store.createDispatched(timeoutAllocation.session);
	check(timed.code === "FAILED", "Store-owned command timeout");
	check((await timeoutFactory.store.inventory()).code === "FAILED", "timeout poison reuse");
	check((await timeoutFactory.store.close()).code === "FAILED", "timeout failed close");
	console.log("TIMEOUT_OK");
	process.exit(0);
}
const integrationStarted = Date.now();
function milestone(label: string): void { console.log("MILESTONE " + label + " " + (Date.now() - integrationStarted)); }
const ready = await createHostedSessionStore(registry);
check(ready.code === "READY", "ready");
if (ready.code !== "READY") process.exit(2);
const store = ready.store;
const methodNames = ["inventory", "allocate", "state", "createDispatched", "present", "runtimeDispatched", "running", "deleteDispatched", "cleanupUncertain", "absent", "retireAndAdvance", "purge", "close"];
check(Object.getPrototypeOf(ready) === Object.prototype && Object.isFrozen(ready) && Object.getOwnPropertyNames(ready).join(",") === "code,store", "factory result exact");
check(Object.getPrototypeOf(store) === Object.prototype && Object.isFrozen(store), "Store exact ordinary");
check(Object.getOwnPropertyNames(store).join(",") === methodNames.join(",") && Object.getOwnPropertySymbols(store).length === 0, "Store keys");
for (const name of methodNames) {
	const descriptor = Object.getOwnPropertyDescriptor(store, name);
	check(typeof descriptor?.value === "function" && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false, "Store method descriptor " + name);
}
function exactInventoryResult(value: object, expectedLength: number, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype && !utilTypes.isProxy(value) && Object.isFrozen(value), label + " outer");
	check(Object.getOwnPropertyNames(value).join(",") === "code,sessions" && Object.getOwnPropertySymbols(value).length === 0, label + " outer names");
	for (const name of ["code", "sessions"]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		check(descriptor?.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " outer descriptor " + name);
	}
	check(value.code === "INVENTORIED" && Array.isArray(value.sessions) && !utilTypes.isProxy(value.sessions), label + " array brand");
	check(Object.getPrototypeOf(value.sessions) === Array.prototype && Object.isFrozen(value.sessions), label + " array prototype/frozen");
	const expectedNames = Array.from({ length: expectedLength }, (_, index) => String(index)).concat("length");
	check(Object.getOwnPropertyNames(value.sessions).join(",") === expectedNames.join(",") && Object.getOwnPropertySymbols(value.sessions).length === 0, label + " dense names");
	for (let index = 0; index < expectedLength; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value.sessions, String(index));
		check(descriptor?.value === value.sessions[index] && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false, label + " element " + index);
		check(Object.isFrozen(value.sessions[index]) && Object.getOwnPropertyNames(value.sessions[index]).length === 0 && Object.getOwnPropertySymbols(value.sessions[index]).length === 0, label + " opaque " + index);
	}
	const length = Object.getOwnPropertyDescriptor(value.sessions, "length");
	check(length?.value === expectedLength && length.enumerable === false && length.writable === false && length.configurable === false, label + " length descriptor");
}
const inventoryPromise = store.inventory();
check(inventoryPromise instanceof Promise && Object.getPrototypeOf(inventoryPromise) === Promise.prototype, "inventory owned native Promise");
const inv1 = await inventoryPromise;
const inv2 = await store.inventory();
check(inv1.code === "INVENTORIED" && inv2.code === "INVENTORIED", "inventory");
if (inv1.code !== "INVENTORIED" || inv2.code !== "INVENTORIED") process.exit(3);
exactInventoryResult(inv1, 0, "empty inventory one");
exactInventoryResult(inv2, 0, "empty inventory two");
check(inv1.sessions !== inv2.sessions && inv1 !== inv2, "inventory fresh");
const identity = Object.freeze({
	sessionId: "s1",
	activeSessionId: "a1",
	childId: "c1",
	name: "child",
	modelSelector: "model",
	durableParentSessionId: "p1",
	rlmParentNodeId: "n1",
	spawnedByRequestId: null,
	thinkingLevel: "medium",
	serviceTier: null,
	spawnContextDigest: "11".repeat(32),
	depth: 1,
});
const digests = Object.freeze({
	releaseDigest: new Uint8Array(32).fill(1),
	manifestDigest: new Uint8Array(32).fill(2),
	bootstrapDigest: new Uint8Array(32).fill(3),
	trustDigest: new Uint8Array(32).fill(4),
	runtimeConfigDigest: new Uint8Array(32).fill(5),
});
function changedIdentity(key: string, value: unknown): object {
	const candidate = Object.assign({}, identity);
	Reflect.set(candidate, key, value);
	return Object.freeze(candidate);
}
function omitIdentity(key: string): object {
	const candidate: Record<string, unknown> = {};
	for (const name of Object.getOwnPropertyNames(identity)) if (name !== key) candidate[name] = identity[name];
	return Object.freeze(candidate);
}
function changedDigests(key: string, value: unknown): object {
	const candidate = Object.assign({}, digests);
	Reflect.set(candidate, key, value);
	return Object.freeze(candidate);
}
function omitDigests(key: string): object {
	const candidate: Record<string, unknown> = {};
	for (const name of Object.getOwnPropertyNames(digests)) if (name !== key) candidate[name] = digests[name];
	return Object.freeze(candidate);
}
function exactFailed(value: object, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype, label + " prototype");
	check(Object.getOwnPropertyNames(value).join(",") === "code", label + " names");
	check(Object.getOwnPropertySymbols(value).length === 0, label + " symbols");
	check(Object.isFrozen(value), label + " frozen");
	const descriptor = Object.getOwnPropertyDescriptor(value, "code");
	check(descriptor?.value === "FAILED" && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " descriptor");
}
function exactOne(value: object, code: string, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype && !utilTypes.isProxy(value) && Object.isFrozen(value), label + " exact ordinary");
	check(Object.getOwnPropertyNames(value).join(",") === "code" && Object.getOwnPropertySymbols(value).length === 0, label + " names");
	const descriptor = Object.getOwnPropertyDescriptor(value, "code");
	check(descriptor?.value === code && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " code descriptor");
}
function exactTwo(value: object, names: string, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype && !utilTypes.isProxy(value) && Object.isFrozen(value), label + " exact ordinary");
	check(Object.getOwnPropertyNames(value).join(",") === names && Object.getOwnPropertySymbols(value).length === 0, label + " names");
	for (const name of names.split(",")) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		check(descriptor?.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " descriptor " + name);
	}
}
function tree(path: string): string {
	const rows: string[] = [];
	function visit(current: string, relative: string): void {
		for (const name of readdirSync(current).sort()) {
			const full = current + "/" + name;
			const child = relative + "/" + name;
			const stat = lstatSync(full);
			if (stat.isDirectory()) {
				rows.push("d:" + child + ":" + stat.mode + ":" + stat.uid + ":" + stat.gid + ":" + stat.nlink);
				visit(full, child);
			} else if (stat.isFile()) {
				rows.push("f:" + child + ":" + stat.mode + ":" + stat.uid + ":" + stat.gid + ":" + stat.nlink + ":" + createHash("sha256").update(readFileSync(full)).digest("hex"));
			} else rows.push("x:" + child + ":" + stat.mode);
		}
	}
	visit(path, "");
	return rows.join("\\n");
}
const identityNames = Object.getOwnPropertyNames(identity);
const wrongIdentityOrder = Object.freeze({ activeSessionId: identity.activeSessionId, sessionId: identity.sessionId, childId: identity.childId, name: identity.name, modelSelector: identity.modelSelector, durableParentSessionId: identity.durableParentSessionId, rlmParentNodeId: identity.rlmParentNodeId, spawnedByRequestId: identity.spawnedByRequestId, thinkingLevel: identity.thinkingLevel, serviceTier: identity.serviceTier, spawnContextDigest: identity.spawnContextDigest, depth: identity.depth });
const nullIdentity = Object.create(null);
for (const name of identityNames) Object.defineProperty(nullIdentity, name, { value: identity[name], enumerable: true, writable: false, configurable: false });
Object.freeze(nullIdentity);
const inheritedIdentity = Object.create(identity);
Object.freeze(inheritedIdentity);
const identityWithExtra = Object.assign({}, identity, { extra: true });
const identityWithSymbol = Object.assign({}, identity);
Reflect.set(identityWithSymbol, Symbol("extra"), true);
const identityWithAccessor = Object.assign({}, identity);
Object.defineProperty(identityWithAccessor, "sessionId", { get: () => "s1", enumerable: true });
const invalidIdentities: unknown[] = [
	undefined, null, false, 0, "", Symbol("identity"), Object.freeze({}), Object.assign({}, identity), wrongIdentityOrder,
	...identityNames.map(omitIdentity), Object.freeze(identityWithExtra), Object.freeze(identityWithSymbol), Object.freeze(identityWithAccessor),
	nullIdentity, inheritedIdentity, new Proxy(identity, {}), new Proxy(identity, { ownKeys() { throw new Error("trap"); } }),
];
for (const key of ["sessionId", "activeSessionId", "childId", "durableParentSessionId", "rlmParentNodeId"])
	for (const value of ["", "x".repeat(1_025), "x\\n", "é", 1, null]) invalidIdentities.push(changedIdentity(key, value));
for (const value of ["", "x".repeat(2_049), "x\\u0001", "\\ud800", 1, null]) invalidIdentities.push(changedIdentity("name", value));
for (const value of ["", "x".repeat(4_097), "x\\u0001", "\\ud800", 1, null]) invalidIdentities.push(changedIdentity("modelSelector", value));
for (const value of ["", "x".repeat(1_025), "x\\n", "é", 1, false]) invalidIdentities.push(changedIdentity("spawnedByRequestId", value));
for (const value of ["", "extreme", null, 1, false]) invalidIdentities.push(changedIdentity("thinkingLevel", value));
for (const value of ["", "invalid", 1, false, undefined]) invalidIdentities.push(changedIdentity("serviceTier", value));
for (const value of ["", "0".repeat(63), "0".repeat(65), "AA".repeat(32), "g".repeat(64), 1, null]) invalidIdentities.push(changedIdentity("spawnContextDigest", value));
for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) invalidIdentities.push(changedIdentity("depth", value));

const digestNames = Object.getOwnPropertyNames(digests);
const wrongDigestOrder = Object.freeze({ manifestDigest: digests.manifestDigest, releaseDigest: digests.releaseDigest, bootstrapDigest: digests.bootstrapDigest, trustDigest: digests.trustDigest, runtimeConfigDigest: digests.runtimeConfigDigest });
const nullDigests = Object.create(null);
for (const name of digestNames) Object.defineProperty(nullDigests, name, { value: digests[name], enumerable: true, writable: false, configurable: false });
Object.freeze(nullDigests);
const inheritedDigests = Object.create(digests);
Object.freeze(inheritedDigests);
const digestsWithExtra = Object.assign({}, digests, { extra: new Uint8Array(32) });
const digestsWithSymbol = Object.assign({}, digests);
Reflect.set(digestsWithSymbol, Symbol("extra"), true);
const digestsWithAccessor = Object.assign({}, digests);
Object.defineProperty(digestsWithAccessor, "releaseDigest", { get: () => new Uint8Array(32), enumerable: true });
class DigestSubclass extends Uint8Array {}
const offsetBuffer = new ArrayBuffer(33);
const resizableBuffer = new ArrayBuffer(32, { maxByteLength: 64 });
check(resizableBuffer.resizable, "authoritative resizable buffer support");
const detachedBuffer = new ArrayBuffer(32);
const detachedView = new Uint8Array(detachedBuffer);
structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
const extraView = new Uint8Array(32);
Reflect.set(extraView, "extra", true);
const invalidDigests: unknown[] = [
	undefined, null, false, 0, "", Object.assign({}, digests), wrongDigestOrder, ...digestNames.map(omitDigests),
	Object.freeze(digestsWithExtra), Object.freeze(digestsWithSymbol), Object.freeze(digestsWithAccessor), nullDigests,
	inheritedDigests, new Proxy(digests, {}), new Proxy(digests, { ownKeys() { throw new Error("trap"); } }),
];
for (const key of digestNames) {
	invalidDigests.push(changedDigests(key, new Uint8Array(31)));
	invalidDigests.push(changedDigests(key, new Uint8Array(33)));
	invalidDigests.push(changedDigests(key, "not-bytes"));
}
for (const value of [
	new DigestSubclass(32), new Proxy(new Uint8Array(32), {}), new Uint8Array(resizableBuffer), detachedView,
	new Uint8Array(offsetBuffer, 1, 32), Buffer.alloc(32), new Uint8Array(new SharedArrayBuffer(32)), extraView,
	new DataView(new ArrayBuffer(32)), {}, null,
]) invalidDigests.push(changedDigests("releaseDigest", value));

const validationIdentity = Object.freeze(Object.assign({}, identity, { sessionId: "validation-s", activeSessionId: "validation-a", childId: "validation-c" }));
let validationSession: object | undefined;
async function invalidThenValid(identityRaw: unknown, digestsRaw: unknown, label: string): Promise<void> {
	const root = "/root/.prime/agent/sandbox-session-state-v1";
	const beforeTree = tree(root);
	const beforeEffects = JSON.stringify(registryEffects);
	const beforeInventory = await store.inventory();
	check(beforeInventory.code === "INVENTORIED", label + " inventory before");
	const failure = await store.allocate(identityRaw, digestsRaw);
	exactFailed(failure, label);
	const afterInventory = await store.inventory();
	check(afterInventory.code === "INVENTORIED", label + " inventory after");
	if (beforeInventory.code !== "INVENTORIED" || afterInventory.code !== "INVENTORIED") process.exit(30);
	check(afterInventory.sessions.length === beforeInventory.sessions.length, label + " map length");
	for (let index = 0; index < beforeInventory.sessions.length; index += 1)
		check(afterInventory.sessions[index] === beforeInventory.sessions[index], label + " map refs " + index);
	check(tree(root) === beforeTree, label + " helper/filesystem zero effect");
	check(JSON.stringify(registryEffects) === beforeEffects, label + " registry zero effect");
	const accepted = await store.allocate(validationIdentity, digests);
	check(accepted.code === (validationSession === undefined ? "ALLOCATED" : "EXISTS"), label + " same Store reusable valid allocation");
	if (accepted.code === "ALLOCATED" || accepted.code === "EXISTS") {
		if (validationSession === undefined) validationSession = accepted.session;
		else check(accepted.session === validationSession, label + " valid retained capability");
	}
}
for (let index = 0; index < invalidIdentities.length; index += 1)
	await invalidThenValid(invalidIdentities[index], digests, "invalid identity " + index);
for (let index = 0; index < invalidDigests.length; index += 1)
	await invalidThenValid(identity, invalidDigests[index], "invalid digests " + index);
milestone("invalid-matrix");
const afterInvalid = await store.inventory();
check(afterInvalid.code === "INVENTORIED" && afterInvalid.sessions.length === 1, "invalid allocation exact map effects");
if (afterInvalid.code !== "INVENTORIED") process.exit(31);
exactInventoryResult(afterInvalid, 1, "populated inventory");
const copiedInventory = await store.inventory();
check(copiedInventory.code === "INVENTORIED", "populated copied inventory");
if (copiedInventory.code !== "INVENTORIED") process.exit(32);
check(copiedInventory !== afterInvalid && copiedInventory.sessions !== afterInvalid.sessions, "populated fresh copies");
for (let index = 0; index < afterInvalid.sessions.length; index += 1)
	check(copiedInventory.sessions[index] === afterInvalid.sessions[index], "populated retained opaque reference " + index);
check(validationSession !== undefined, "validation capability retained");
if (validationSession === undefined) process.exit(33);
check((await store.createDispatched(validationSession)).code === "COMMITTED", "validation cleanup create");
check((await store.present(validationSession)).code === "COMMITTED", "validation cleanup present");
check((await store.runtimeDispatched(validationSession)).code === "COMMITTED", "validation cleanup runtime");
check((await store.running(validationSession)).code === "COMMITTED", "validation cleanup running");
const validationTerminal = Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" });
check((await store.deleteDispatched(validationSession, validationTerminal)).code === "COMMITTED", "validation cleanup delete");
check((await store.absent(validationSession)).code === "COMMITTED", "validation cleanup absent");
check((await store.purge(validationSession)).code === "COMMITTED", "validation cleanup purge");
const allocationPromise = store.allocate(identity, digests);
check(allocationPromise instanceof Promise && Object.getPrototypeOf(allocationPromise) === Promise.prototype, "allocate owned native Promise");
const allocated = await allocationPromise;
check(allocated.code === "ALLOCATED", "allocate");
if (allocated.code !== "ALLOCATED") process.exit(4);
exactTwo(allocated, "code,session", "allocate result");
const session = allocated.session;
const exists = await store.allocate(identity, digests);
check(exists.code === "EXISTS" && exists.session === session, "exists");
exactTwo(exists, "code,session", "exists result");
const unknown = Object.freeze({});
for (const [label, result] of [
	["state", await store.state(unknown)],
	["create", await store.createDispatched(unknown)],
	["present", await store.present(unknown)],
	["runtime", await store.runtimeDispatched(unknown)],
	["running", await store.running(unknown)],
	["delete", await store.deleteDispatched(unknown, Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" }))],
	["uncertain", await store.cleanupUncertain(unknown)],
	["absent", await store.absent(unknown)],
	["retire", await store.retireAndAdvance(unknown)],
	["purge", await store.purge(unknown)],
] as const) exactOne(result, "INVALID", "unknown " + label);
exactOne(await store.present(session), "STALE", "present before create");
exactOne(await store.runtimeDispatched(session), "STALE", "runtime before present");
exactOne(await store.running(session), "STALE", "running before runtime");
exactOne(await store.cleanupUncertain(session), "STALE", "uncertain before delete");
exactOne(await store.absent(session), "STALE", "absent before delete");
exactOne(await store.retireAndAdvance(session), "STALE", "retire before create");
exactOne(await store.purge(session), "STALE", "purge before absent");
const stateAllocated = await store.state(session);
exactTwo(stateAllocated, "code,state", "state allocated");
check(stateAllocated.code === "STATE" && stateAllocated.state === "ALLOCATED", "state allocated value");
const createResult = await store.createDispatched(session);
exactOne(createResult, "COMMITTED", "create");
exactOne(await store.createDispatched(session), "STALE", "create repeated");
exactOne(await store.present(session), "COMMITTED", "present");
exactOne(await store.present(session), "STALE", "present repeated");
exactOne(await store.runtimeDispatched(session), "COMMITTED", "runtime");
exactOne(await store.runtimeDispatched(session), "STALE", "runtime repeated");
exactOne(await store.running(session), "COMMITTED", "running");
exactOne(await store.running(session), "STALE", "running repeated");
const terminalInvalids: unknown[] = [
	undefined, null, {}, Object.freeze({ terminalStatus: "completed" }), Object.freeze({ terminalCode: "SUCCESS" }),
	Object.freeze({ terminalCode: "SUCCESS", terminalStatus: "completed" }),
	Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS", extra: true }),
	Object.freeze({ terminalStatus: "done", terminalCode: "SUCCESS" }),
	Object.freeze({ terminalStatus: "completed", terminalCode: "OK" }),
	new Proxy(Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" }), {}),
];
for (let index = 0; index < terminalInvalids.length; index += 1)
	exactOne(await store.deleteDispatched(session, terminalInvalids[index]), "INVALID", "terminal invalid " + index);
const terminal = Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" });
exactOne(await store.deleteDispatched(session, terminal), "COMMITTED", "delete");
exactOne(await store.deleteDispatched(session, terminal), "STALE", "delete repeated");
exactOne(await store.cleanupUncertain(session), "COMMITTED", "uncertain");
exactOne(await store.cleanupUncertain(session), "STALE", "uncertain repeated");
exactOne(await store.absent(session), "COMMITTED", "absent");
exactOne(await store.absent(session), "STALE", "absent repeated");
const finalState = await store.state(session);
exactTwo(finalState, "code,state", "state absent");
check(finalState.code === "STATE" && finalState.state === "ABSENT", "state absent value");
exactOne(await store.purge(session), "COMMITTED", "purge");
exactOne(await store.state(session), "INVALID", "purged invalid");
exactOne(await store.purge(session), "INVALID", "purge repeated");
const inv3 = await store.inventory();
check(inv3.code === "INVENTORIED" && inv3.sessions.length === 0, "inventory purged");
milestone("method-matrix");
const identity2 = Object.freeze({
	sessionId: "s2",
	activeSessionId: "a2",
	childId: "c2",
	name: "child-two",
	modelSelector: "model",
	durableParentSessionId: "p1",
	rlmParentNodeId: "n1",
	spawnedByRequestId: "request-2",
	thinkingLevel: "high",
	serviceTier: "priority",
	spawnContextDigest: "22".repeat(32),
	depth: 2,
});
const allocated2 = await store.allocate(identity2, digests);
check(allocated2.code === "ALLOCATED", "allocate rollover");
if (allocated2.code !== "ALLOCATED") process.exit(5);
const session2 = allocated2.session;
check((await store.createDispatched(session2)).code === "COMMITTED", "rollover create");
exactOne(await store.retireAndAdvance(session2), "COMMITTED", "rollover retire");
const afterRollover = await store.state(session2);
check(afterRollover.code === "STATE" && afterRollover.state === "ALLOCATED", "rollover state");
exactTwo(afterRollover, "code,state", "rollover state result");
exactOne(await store.retireAndAdvance(session2), "STALE", "rollover repeated");
const closing1 = store.close();
const closing2 = store.close();
check(closing1 instanceof Promise && Object.getPrototypeOf(closing1) === Promise.prototype, "close owned native Promise");
check(closing1 === closing2, "close cached");
const afterCloseAdmission = [
	store.inventory(), store.allocate(identity, digests), store.state(session2), store.createDispatched(session2), store.present(session2),
	store.runtimeDispatched(session2), store.running(session2), store.deleteDispatched(session2, terminal), store.cleanupUncertain(session2),
	store.absent(session2), store.retireAndAdvance(session2), store.purge(session2),
];
for (let index = 0; index < afterCloseAdmission.length; index += 1)
	exactOne(await afterCloseAdmission[index], "FAILED", "post-close admission " + index);
const closed = await closing1;
exactOne(closed, "CLOSED", "closed");
check(await store.close() === closed, "close cached result identity");
const ready2 = await createHostedSessionStore(registry);
check(ready2.code === "READY", "restart ready");
if (ready2.code !== "READY") process.exit(6);
const store2 = ready2.store;
const restarted = await store2.inventory();
check(restarted.code === "INVENTORIED" && restarted.sessions.length === 1, "restart inventory");
if (restarted.code !== "INVENTORIED") process.exit(7);
const restartedSession = restarted.sessions[0];
const restartState = await store2.state(restartedSession);
check(restartState.code === "STATE" && restartState.state === "ALLOCATED", "restart state");
check((await store2.createDispatched(restartedSession)).code === "COMMITTED", "restart create");
check((await store2.present(restartedSession)).code === "COMMITTED", "restart present");
check((await store2.runtimeDispatched(restartedSession)).code === "COMMITTED", "restart runtime");
check((await store2.running(restartedSession)).code === "COMMITTED", "restart running");
check((await store2.deleteDispatched(restartedSession, terminal)).code === "COMMITTED", "restart delete");
check((await store2.absent(restartedSession)).code === "COMMITTED", "restart absent");
check((await store2.purge(restartedSession)).code === "COMMITTED", "restart purge");
check((await store2.close()).code === "CLOSED", "restart close");
const ready3 = await createHostedSessionStore(registry);
check(ready3.code === "READY", "poison factory");
if (ready3.code !== "READY") process.exit(8);
const store3 = ready3.store;
check((await store3.inventory()).code === "INVENTORIED", "poison inventory");
const poisonAllocation = await store3.allocate(identity2, digests);
check(poisonAllocation.code === "ALLOCATED", "poison allocate");
if (poisonAllocation.code !== "ALLOCATED") process.exit(9);
forceInvalidReplace = true;
exactOne(await store3.createDispatched(poisonAllocation.session), "FAILED", "post-durable CAS poison");
for (const [label, poisoned] of [
	["inventory", store3.inventory()], ["allocate", store3.allocate(identity, digests)], ["state", store3.state(poisonAllocation.session)],
	["create", store3.createDispatched(poisonAllocation.session)], ["present", store3.present(poisonAllocation.session)],
	["runtime", store3.runtimeDispatched(poisonAllocation.session)], ["running", store3.running(poisonAllocation.session)],
	["delete", store3.deleteDispatched(poisonAllocation.session, terminal)], ["uncertain", store3.cleanupUncertain(poisonAllocation.session)],
	["absent", store3.absent(poisonAllocation.session)], ["retire", store3.retireAndAdvance(poisonAllocation.session)],
	["purge", store3.purge(poisonAllocation.session)],
] as const) exactOne(await poisoned, "FAILED", "poisoned reuse " + label);
const poisonClose1 = store3.close();
const poisonClose2 = store3.close();
check(poisonClose1 === poisonClose2, "poison close cached");
const poisonClosed = await poisonClose1;
exactOne(poisonClosed, "FAILED", "poison close result");
check(await store3.close() === poisonClosed, "poison close result cached identity");
const ready4 = await createHostedSessionStore(registry);
check(ready4.code === "READY", "poison recovery factory");
if (ready4.code !== "READY") process.exit(10);
const store4 = ready4.store;
const recovered = await store4.inventory();
check(recovered.code === "INVENTORIED" && recovered.sessions.length === 1, "post-CAS recovery inventory");
if (recovered.code !== "INVENTORIED") process.exit(11);
const recoveredSession = recovered.sessions[0];
const recoveredState = await store4.state(recoveredSession);
check(recoveredState.code === "STATE" && recoveredState.state === "CREATE_DISPATCHED", "post-CAS recovery state");
check((await store4.present(recoveredSession)).code === "COMMITTED", "recovery present");
check((await store4.runtimeDispatched(recoveredSession)).code === "COMMITTED", "recovery runtime");
check((await store4.running(recoveredSession)).code === "COMMITTED", "recovery running");
check((await store4.deleteDispatched(recoveredSession, terminal)).code === "COMMITTED", "recovery delete");
check((await store4.absent(recoveredSession)).code === "COMMITTED", "recovery absent");
check((await store4.purge(recoveredSession)).code === "COMMITTED", "recovery purge");
check((await store4.close()).code === "CLOSED", "recovery close");
const ready5 = await createHostedSessionStore(registry);
check(ready5.code === "READY", "rollover lag factory");
if (ready5.code !== "READY") process.exit(12);
const store5 = ready5.store;
check((await store5.inventory()).code === "INVENTORIED", "rollover lag inventory");
const lagAllocation = await store5.allocate(identity, digests);
check(lagAllocation.code === "ALLOCATED", "rollover lag allocate");
if (lagAllocation.code !== "ALLOCATED") process.exit(13);
const lagSession = lagAllocation.session;
check((await store5.createDispatched(lagSession)).code === "COMMITTED", "rollover lag create");
forceInvalidReplace = true;
check((await store5.retireAndAdvance(lagSession)).code === "FAILED", "retired-head CAS poison");
check((await store5.close()).code === "FAILED", "retired-head poisoned close");
const ready6 = await createHostedSessionStore(registry);
check(ready6.code === "READY", "retired-head recovery factory");
if (ready6.code !== "READY") process.exit(14);
const store6 = ready6.store;
const rolloverRecovered = await store6.inventory();
check(rolloverRecovered.code === "INVENTORIED" && rolloverRecovered.sessions.length === 1, "retired-head recovery inventory");
if (rolloverRecovered.code !== "INVENTORIED") process.exit(15);
const rolloverSession = rolloverRecovered.sessions[0];
const rolloverRecoveredState = await store6.state(rolloverSession);
check(rolloverRecoveredState.code === "STATE" && rolloverRecoveredState.state === "ALLOCATED", "retired-head recovery state");
check((await store6.createDispatched(rolloverSession)).code === "COMMITTED", "retired-head recovery create");
check((await store6.present(rolloverSession)).code === "COMMITTED", "retired-head recovery present");
check((await store6.runtimeDispatched(rolloverSession)).code === "COMMITTED", "retired-head recovery runtime");
check((await store6.running(rolloverSession)).code === "COMMITTED", "retired-head recovery running");
check((await store6.deleteDispatched(rolloverSession, terminal)).code === "COMMITTED", "retired-head recovery delete");
check((await store6.absent(rolloverSession)).code === "COMMITTED", "retired-head recovery absent");
check((await store6.purge(rolloverSession)).code === "COMMITTED", "retired-head recovery purge");
check((await store6.close()).code === "CLOSED", "retired-head recovery close");
milestone("existing-recovery");
const roguePath = "/root/.prime/agent/sandbox-session-state-v1/rogue";
writeFileSync(roguePath, "hostile");
check((await createHostedSessionStore(registry)).code === "FAILED", "hostile filesystem rejected");
unlinkSync(roguePath);
const ready7 = await createHostedSessionStore(registry);
check(ready7.code === "READY", "post-hostile factory");
if (ready7.code !== "READY") process.exit(16);
const store7 = ready7.store;
check((await store7.inventory()).code === "INVENTORIED", "post-hostile inventory");
const fixedRoot = "/root/.prime/agent/sandbox-session-state-v1";
const snapshotRoot = "/tmp/store-v22-snapshots";
rmSync(snapshotRoot, { recursive: true, force: true });
mkdirSync(snapshotRoot, { mode: 0o700 });
function snapshot(name: string): void {
	const destination = snapshotRoot + "/" + name;
	rmSync(destination, { recursive: true, force: true });
	cpSync(fixedRoot, destination, { recursive: true, preserveTimestamps: true });
}
function restore(name: string): void {
	rmSync(fixedRoot, { recursive: true, force: true });
	cpSync(snapshotRoot + "/" + name, fixedRoot, { recursive: true, preserveTimestamps: true });
}
function lifecycleDirectory(base: string): string {
	const names = readdirSync(base).filter((name) => /^[0-9a-f]{64}$/.test(name));
	check(names.length === 1, "one lifecycle in " + base);
	return base + "/" + names[0];
}
function ledgerDirectory(base: string): string {
	return lifecycleDirectory(base) + "/ledger";
}
function walDirectory(base: string): string {
	const lifecycle = lifecycleDirectory(base);
	const generations = readdirSync(lifecycle + "/generations").filter((name) => /^[0-9a-f]{64}$/.test(name));
	check(generations.length === 1, "one generation in " + base);
	return lifecycle + "/generations/" + generations[0] + "/wal";
}
function mix(name: string, durableName: string, ledgerName: string): void {
	const destination = snapshotRoot + "/" + name;
	rmSync(destination, { recursive: true, force: true });
	cpSync(snapshotRoot + "/" + durableName, destination, { recursive: true, preserveTimestamps: true });
	const ledger = ledgerDirectory(destination);
	rmSync(ledger, { recursive: true, force: true });
	cpSync(ledgerDirectory(snapshotRoot + "/" + ledgerName), ledger, { recursive: true, preserveTimestamps: true });
}
function truncateLastLedger(name: string): void {
	const ledger = ledgerDirectory(snapshotRoot + "/" + name);
	const records = readdirSync(ledger).filter((entry) => entry.endsWith(".rec")).sort();
	check(records.length >= 2, "truncate ledger input");
	unlinkSync(ledger + "/" + records.pop());
	const last = records[records.length - 1];
	const head = Buffer.alloc(48);
	head.write("PILEDHD1", 0, "ascii");
	head.writeBigUInt64BE(BigInt("0x" + last.slice(0, 16)), 8);
	Buffer.from(last.slice(17, 81), "hex").copy(head, 16);
	writeFileSync(ledger + "/head", head, { mode: 0o600 });
}
const recoveryIdentity = Object.freeze(Object.assign({}, identity, { sessionId: "recovery-s", activeSessionId: "recovery-a", childId: "recovery-c" }));
const recoveryAllocation = await store7.allocate(recoveryIdentity, digests);
check(recoveryAllocation.code === "ALLOCATED", "recovery seed allocate");
if (recoveryAllocation.code !== "ALLOCATED") process.exit(40);
const recoverySession = recoveryAllocation.session;
snapshot("allocated");
exactOne(await store7.createDispatched(recoverySession), "COMMITTED", "recovery seed create"); snapshot("create");
exactOne(await store7.present(recoverySession), "COMMITTED", "recovery seed present"); snapshot("present");
exactOne(await store7.runtimeDispatched(recoverySession), "COMMITTED", "recovery seed runtime"); snapshot("runtime");
exactOne(await store7.running(recoverySession), "COMMITTED", "recovery seed running"); snapshot("running");
exactOne(await store7.deleteDispatched(recoverySession, terminal), "COMMITTED", "recovery seed delete"); snapshot("delete");
exactOne(await store7.cleanupUncertain(recoverySession), "COMMITTED", "recovery seed cleanup"); snapshot("cleanup");
exactOne(await store7.absent(recoverySession), "COMMITTED", "recovery seed absent cleanup"); snapshot("absent-cleanup");
exactOne(await store7.close(), "CLOSED", "recovery seed close");

restore("delete");
const directFactory = await createHostedSessionStore(registry);
check(directFactory.code === "READY", "direct absent factory");
if (directFactory.code !== "READY") process.exit(41);
const directInventory = await directFactory.store.inventory();
check(directInventory.code === "INVENTORIED" && directInventory.sessions.length === 1, "direct absent inventory");
if (directInventory.code !== "INVENTORIED") process.exit(42);
exactOne(await directFactory.store.absent(directInventory.sessions[0]), "COMMITTED", "direct absent");
snapshot("absent-direct");
exactOne(await directFactory.store.close(), "CLOSED", "direct absent close");

cpSync(snapshotRoot + "/delete", snapshotRoot + "/delete-terminal", { recursive: true, preserveTimestamps: true });
truncateLastLedger("delete-terminal");
milestone("recovery-seed");
mix("create-lag-1", "create", "allocated");
mix("present-lag-1", "present", "create");
mix("runtime-lag-1", "runtime", "present");
mix("running-lag-1", "running", "runtime");
mix("delete-lag-2", "delete", "running");
mix("delete-lag-1", "delete", "delete-terminal");
mix("absent-normal-lag-1", "absent-direct", "delete");
mix("absent-cleanup-lag-2", "absent-cleanup", "cleanup");
mix("absent-cleanup-lag-1", "absent-cleanup", "delete");
async function verifySnapshot(name: string, expectedState: string): Promise<void> {
	restore(name);
	const factory = await createHostedSessionStore(registry);
	check(factory.code === "READY", name + " factory");
	if (factory.code !== "READY") process.exit(43);
	const inventory = await factory.store.inventory();
	check(inventory.code === "INVENTORIED" && inventory.sessions.length === 1, name + " inventory");
	if (inventory.code !== "INVENTORIED") process.exit(44);
	const recoveredState = await factory.store.state(inventory.sessions[0]);
	check(recoveredState.code === "STATE" && recoveredState.state === expectedState, name + " repaired state");
	exactOne(await factory.store.close(), "CLOSED", name + " close");
}
for (const [name, state] of [
	["create-lag-1", "CREATE_DISPATCHED"], ["present-lag-1", "PRESENT"], ["runtime-lag-1", "RUNTIME_DISPATCHED"],
	["running-lag-1", "RUNNING"], ["delete-lag-2", "DELETE_DISPATCHED"], ["delete-lag-1", "DELETE_DISPATCHED"],
	["absent-normal-lag-1", "ABSENT"], ["absent-cleanup-lag-2", "ABSENT"], ["absent-cleanup-lag-1", "ABSENT"],
] as const) await verifySnapshot(name, state);
milestone("lag-matrix");

restore("running");
const otherTerminalFactory = await createHostedSessionStore(registry);
check(otherTerminalFactory.code === "READY", "other terminal factory");
if (otherTerminalFactory.code !== "READY") process.exit(45);
const otherTerminalInventory = await otherTerminalFactory.store.inventory();
check(otherTerminalInventory.code === "INVENTORIED", "other terminal inventory");
if (otherTerminalInventory.code !== "INVENTORIED") process.exit(46);
exactOne(await otherTerminalFactory.store.deleteDispatched(otherTerminalInventory.sessions[0], Object.freeze({ terminalStatus: "error", terminalCode: "FAILURE" })), "COMMITTED", "other terminal delete");
snapshot("delete-other-terminal");
exactOne(await otherTerminalFactory.store.close(), "CLOSED", "other terminal close");

mix("forbidden-ledger-lead", "create", "present");
mix("forbidden-excess-lag", "running", "allocated");
mix("forbidden-terminal-disagreement", "delete", "delete-other-terminal");
cpSync(snapshotRoot + "/running", snapshotRoot + "/forbidden-head-contradiction", { recursive: true, preserveTimestamps: true });
const contradictionHead = lifecycleDirectory(snapshotRoot + "/forbidden-head-contradiction") + "/head";
const contradictionBytes = readFileSync(contradictionHead);
contradictionBytes[8] ^= 0xff;
writeFileSync(contradictionHead, contradictionBytes, { mode: 0o600 });
async function expectInventoryFailure(name: string): Promise<void> {
	restore(name);
	const factory = await createHostedSessionStore(registry);
	if (factory.code === "FAILED") {
		exactOne(factory, "FAILED", name + " factory failure");
		return;
	}
	exactOne(await factory.store.inventory(), "FAILED", name + " inventory failure");
	exactOne(await factory.store.close(), "FAILED", name + " failed close");
}
for (const name of ["forbidden-ledger-lead", "forbidden-excess-lag", "forbidden-terminal-disagreement", "forbidden-head-contradiction"])
	await expectInventoryFailure(name);
milestone("forbidden-matrix");

cpSync(snapshotRoot + "/absent-direct", snapshotRoot + "/interrupted-purge", { recursive: true, preserveTimestamps: true });
for (const directory of [ledgerDirectory(snapshotRoot + "/interrupted-purge"), walDirectory(snapshotRoot + "/interrupted-purge")]) {
	const suffix = directory.endsWith("/ledger") ? ".rec" : ".wal";
	const records = readdirSync(directory).filter((entry) => entry.endsWith(suffix)).sort();
	for (let index = 0; index + 1 < records.length; index += 1) unlinkSync(directory + "/" + records[index]);
}
restore("interrupted-purge");
const purgeRecoveryFactory = await createHostedSessionStore(registry);
check(purgeRecoveryFactory.code === "READY", "interrupted purge factory");
if (purgeRecoveryFactory.code !== "READY") process.exit(47);
const purgeRecoveryInventory = await purgeRecoveryFactory.store.inventory();
check(purgeRecoveryInventory.code === "INVENTORIED" && purgeRecoveryInventory.sessions.length === 0, "interrupted purge completed");
exactOne(await purgeRecoveryFactory.store.close(), "CLOSED", "interrupted purge close");

async function expectHostileLock(label: string, mutate: (lock: string) => void): Promise<void> {
	restore("allocated");
	const lock = fixedRoot + "/.lock";
	mutate(lock);
	const result = await createHostedSessionStore(registry);
	exactOne(result, "FAILED", "hostile lock " + label);
}
await expectHostileLock("mode", (lock) => chmodSync(lock, 0o644));
await expectHostileLock("owner", (lock) => chownSync(lock, 65534, 65534));
await expectHostileLock("link", (lock) => { const other = "/tmp/hostile-lock-link"; rmSync(other, { force: true }); linkSync(lock, other); });
await expectHostileLock("type", (lock) => { unlinkSync(lock); mkdirSync(lock, { mode: 0o600 }); });
rmSync(fixedRoot, { recursive: true, force: true });
milestone("hostile-and-purge");
console.log("INTEGRATION_OK");
`,
		);
		const controllerPath = resolve(temporary, "timeout-controller.py");
		writeFileSync(
			controllerPath,
			`import errno,os,signal,subprocess,threading
ready=threading.Event()
signal.signal(signal.SIGUSR1,lambda unused_signal,unused_frame:ready.set())
p=subprocess.Popen(["chroot","/chroot","/bun","/app/integration.ts","timeout"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
helper=None
try:
 if not ready.wait(5): raise RuntimeError("Store timeout harness readiness")
 children=open(f"/proc/{p.pid}/task/{p.pid}/children",encoding="ascii").read().split()
 if len(children)!=1: raise RuntimeError(f"helper children {children}")
 helper=int(children[0])
 os.kill(helper,signal.SIGSTOP)
 os.kill(p.pid,signal.SIGUSR1)
 threading.Event().wait(30.75)
 status=open(f"/proc/{helper}/status",encoding="ascii").read().splitlines()
 pending=0
 for line in status:
  if line.startswith("SigPnd:") or line.startswith("ShdPnd:"): pending|=int(line.split()[1],16)
 if pending & (1 << (signal.SIGTERM-1)) == 0: raise RuntimeError("real SIGTERM not pending during grace")
 out,err=p.communicate(timeout=5)
 absent=False
 try: os.killpg(helper,0)
 except OSError as failure: absent=failure.errno==errno.ESRCH
 if p.returncode!=0 or b"TIMEOUT_OK" not in out or not absent: raise RuntimeError(f"timeout result rc={p.returncode} absent={absent} out={out!r} err={err!r}")
 print("STORE_TIMEOUT_TERM_KILL_ESRCH_OK")
except BaseException as original:
 try: os.killpg(p.pid,signal.SIGKILL)
 except OSError: pass
 try: p.communicate(timeout=2)
 except BaseException as failure:
  absent=False
  try: os.killpg(p.pid,0)
  except OSError as probe: absent=probe.errno==errno.ESRCH
  raise RuntimeError(f"timeout controller KILL drain timeout absent={absent}") from failure
 raise original
`,
		);
		const faultInterpreterPath = resolve(temporary, "fault-python3");
		writeFileSync(
			faultInterpreterPath,
			`#!/usr/local/bin/python3.real
import os,signal,struct,threading
scenario=open("/tmp/fault-scenario",encoding="ascii").read().strip()
with open("/tmp/fault-pid-"+scenario,"w",encoding="ascii") as stream: stream.write(str(os.getpid()))
term_count=0
def term(unused_signal,unused_frame):
 global term_count
 term_count+=1
 with open("/tmp/fault-term-"+scenario,"w",encoding="ascii") as stream: stream.write(str(term_count))
signal.signal(signal.SIGTERM,term)
def read_exact(size):
 data=bytearray()
 while len(data)<size:
  chunk=os.read(0,size-len(data))
  if not chunk: raise SystemExit(2)
  data.extend(chunk)
 return bytes(data)
def request():
 header=read_exact(5); length=struct.unpack(">I",header[1:])[0]; return header[0],read_exact(length)
def emit(data,fd=1):
 view=memoryview(data)
 while len(view):
  try: count=os.write(fd,view)
  except BrokenPipeError: return
  view=view[count:]
def frame(opcode,payload=b""): return bytes([opcode])+struct.pack(">I",len(payload))+payload
opcode,payload=request()
if opcode!=0xFE or payload: raise SystemExit(3)
emit(frame(0x80,b"\\xfe"))
opcode,payload=request()
if opcode!=0x01 or payload: raise SystemExit(4)
if scenario=="malformed-length": emit(bytes([0x82])+struct.pack(">I",1048577))
elif scenario=="malformed-payload": emit(frame(0xE0,b"\\x01"))
elif scenario=="trailing": emit(frame(0x82)+bytes([0x82])+struct.pack(">I",1048577))
elif scenario=="duplicate": emit(frame(0x82)+frame(0x82))
elif scenario=="reordered": emit(frame(0x82)+frame(0x81))
elif scenario=="late":
 emit(frame(0x82)); threading.Event().wait(0.05); emit(frame(0x82))
elif scenario=="wrong-opcode": emit(frame(0x80,b"\\x01"))
elif scenario=="stdout-overflow": emit(frame(0x81,b"x"*1048576)+b"x")
elif scenario=="stderr-overflow": emit(b"x"*65537,2)
else: raise SystemExit(5)
while True:
 try: request()
 except (EOFError,SystemExit): threading.Event().wait(4)
`,
			{ mode: 0o755 },
		);
		const faultControllerPath = resolve(temporary, "fault-controller.py");
		writeFileSync(
			faultControllerPath,
			`import errno,os,signal,subprocess,time
cases=("malformed-length","malformed-payload","trailing","duplicate","reordered","late","wrong-opcode","stdout-overflow","stderr-overflow")
for scenario in cases:
 open("/chroot/tmp/fault-scenario","w",encoding="ascii").write(scenario)
 term_path="/chroot/tmp/fault-term-"+scenario
 pid_path="/chroot/tmp/fault-pid-"+scenario
 for path in (term_path,pid_path):
  try: os.unlink(path)
  except FileNotFoundError: pass
 started=time.monotonic()
 p=subprocess.Popen(["chroot","/chroot","/bun","/app/integration.ts","fault-"+scenario],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try: out,err=p.communicate(timeout=7)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try: out,err=p.communicate(timeout=2)
  except subprocess.TimeoutExpired:
   os.killpg(p.pid,signal.SIGKILL)
   try: out,err=p.communicate(timeout=2)
   except subprocess.TimeoutExpired as failure:
    absent=False
    try: os.killpg(p.pid,0)
    except OSError as probe: absent=probe.errno==errno.ESRCH
    raise RuntimeError(f"fault KILL drain timeout {scenario} absent={absent}") from failure
  raise RuntimeError("fault timeout "+scenario)
 absent=False
 try: os.killpg(p.pid,0)
 except OSError as failure: absent=failure.errno==errno.ESRCH
 term=open(term_path,encoding="ascii").read() if os.path.exists(term_path) else ""
 helper=int(open(pid_path,encoding="ascii").read()) if os.path.exists(pid_path) else 0
 helper_absent=False
 try: os.killpg(helper,0)
 except OSError as failure: helper_absent=failure.errno==errno.ESRCH
 elapsed=time.monotonic()-started
 if p.returncode!=0 or ("FAULT_OK "+scenario).encode() not in out or term!="1" or not absent or not helper_absent or elapsed>5:
  raise RuntimeError(f"fault {scenario} rc={p.returncode} term={term!r} absent={absent} helper_absent={helper_absent} elapsed={elapsed} out={out!r} err={err!r}")
 print("FAULT_CASE_OK "+scenario)
`,
		);
		const rolloverInterpreterPath = resolve(temporary, "rollover-python3");
		writeFileSync(
			rolloverInterpreterPath,
			`#!/usr/local/bin/python3.real
import os,signal,struct,subprocess,sys,threading
scenario=open("/tmp/rollover-scenario",encoding="ascii").read().strip()
signal.signal(signal.SIGTERM,signal.SIG_IGN)
child=subprocess.Popen(["/usr/local/bin/python3.real",sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(3,))
def drain_stderr():
 while True:
  chunk=child.stderr.read(65536)
  if not chunk:return
  try:os.write(2,chunk)
  except BrokenPipeError:return
threading.Thread(target=drain_stderr,daemon=True).start()
def read_exact(stream,size):
 data=bytearray()
 while len(data)<size:
  chunk=stream.read(size-len(data))
  if not chunk:raise EOFError
  data.extend(chunk)
 return bytes(data)
def frame_from(stream):
 header=read_exact(stream,5);length=struct.unpack(">I",header[1:])[0];return header+read_exact(stream,length)
def emit(data):
 view=memoryview(data)
 while len(view):
  count=os.write(1,view);view=view[count:]
while True:
 request=frame_from(sys.stdin.buffer);opcode=request[0]
 child.stdin.write(request);child.stdin.flush()
 while True:
  response=frame_from(child.stdout)
  if (scenario=="case3" and opcode==0x05) or (scenario=="case4" and opcode==0x06): os._exit(97)
  emit(response)
  if opcode!=0x01 or response[0] in (0x82,0xE0):break
`,
			{ mode: 0o755 },
		);
		const rolloverControllerPath = resolve(temporary, "rollover-controller.py");
		writeFileSync(
			rolloverControllerPath,
			`import errno,os,shutil,signal,struct,subprocess
root="/chroot/root/.prime/agent/sandbox-session-state-v1"
def run(args,label):
 p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 try:out,err=p.communicate(timeout=8)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:out,err=p.communicate(timeout=2)
  except subprocess.TimeoutExpired:
   os.killpg(p.pid,signal.SIGKILL)
   try:out,err=p.communicate(timeout=2)
   except subprocess.TimeoutExpired as failure:
    absent=False
    try:os.killpg(p.pid,0)
    except OSError as probe:absent=probe.errno==errno.ESRCH
    raise RuntimeError(f"{label} KILL drain timeout absent={absent}") from failure
  raise RuntimeError(label+" timeout")
 absent=False
 try:os.killpg(p.pid,0)
 except OSError as failure:absent=failure.errno==errno.ESRCH
 if p.returncode!=0 or not absent:raise RuntimeError(f"{label} rc={p.returncode} absent={absent} out={out!r} err={err!r}")
 return out
for scenario in ("case3","case4"):
 open("/chroot/tmp/rollover-scenario","w",encoding="ascii").write(scenario)
 out=run(["chroot","/chroot","/bun","/app/integration.ts","rollover-cut"+scenario[-1]],"cut "+scenario)
 if b"ROLLOVER_CUT_OK" not in out:raise RuntimeError("missing cut marker "+scenario)
 lifecycle_names=[name for name in os.listdir(root) if len(name)==64 and all(c in "0123456789abcdef" for c in name)]
 if len(lifecycle_names)!=1:raise RuntimeError("cut lifecycle count")
 lifecycle=root+"/"+lifecycle_names[0]
 head=open(lifecycle+"/head","rb").read();selected=head[8:40].hex();revision=struct.unpack(">Q",head[40:48])[0]
 generations=sorted(os.listdir(lifecycle+"/generations"))
 if len(generations)!=2:raise RuntimeError(f"{scenario} generations {generations}")
 wal_counts={name:len([entry for entry in os.listdir(lifecycle+"/generations/"+name+"/wal") if entry.endswith(".wal")]) for name in generations}
 fresh=[name for name,count in wal_counts.items() if count==1]
 retired=[name for name,count in wal_counts.items() if count==3]
 if len(fresh)!=1 or len(retired)!=1:raise RuntimeError(f"{scenario} wal counts {wal_counts}")
 if scenario=="case3" and (selected!=retired[0] or revision!=3):raise RuntimeError("case3 publication boundary")
 if scenario=="case4" and (selected!=fresh[0] or revision!=1):raise RuntimeError("case4 publication boundary")
 ledger_before=sorted(entry for entry in os.listdir(lifecycle+"/ledger") if entry.endswith(".rec"))
 if len(ledger_before)!=2:raise RuntimeError("rollover ledger before")
 os.unlink("/chroot/usr/local/bin/python3");os.rename("/chroot/usr/local/bin/python3.real","/chroot/usr/local/bin/python3")
 out=run(["chroot","/chroot","/bun","/app/integration.ts","rollover-verify"+scenario[-1]],"verify "+scenario)
 if b"ROLLOVER_VERIFY_OK" not in out:raise RuntimeError("missing verify marker "+scenario)
 lifecycle_names=[name for name in os.listdir(root) if len(name)==64 and all(c in "0123456789abcdef" for c in name)]
 lifecycle=root+"/"+lifecycle_names[0];head=open(lifecycle+"/head","rb").read()
 generations=sorted(os.listdir(lifecycle+"/generations"));ledger_after=sorted(entry for entry in os.listdir(lifecycle+"/ledger") if entry.endswith(".rec"))
 if generations!=fresh or head[8:40].hex()!=fresh[0] or struct.unpack(">Q",head[40:48])[0]!=1 or ledger_after!=ledger_before:raise RuntimeError("repair continuity/duplicate effect "+scenario)
 print("ROLLOVER_PUBLICATION_CUT_OK "+scenario)
 if scenario=="case3":
  shutil.rmtree(root)
  os.rename("/chroot/usr/local/bin/python3","/chroot/usr/local/bin/python3.real")
  shutil.copyfile("/input-rollover-python3","/chroot/usr/local/bin/python3");os.chmod("/chroot/usr/local/bin/python3",0o755)
`,
		);
		const sandboxDirectory = resolve(import.meta.dir, "../src/modes/daemon/sandbox");
		const bunPath =
			"/Users/milkkarten/.prime/agent/session-artifacts/01a05fe9-d2a4-71a9-9556-da16f3cdef55/bun-linux-x64-1.4.0-input/extracted/bun";
		expect(createHash("sha256").update(readFileSync(bunPath)).digest("hex")).toBe(
			"33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b",
		);
		expect(createHash("sha256").update(readFileSync(sourcePath)).digest("hex")).toBe(
			"cba24db4ab698da54013ab912725efd5ae891e72cabaf890ef87c8833bbb2d1f",
		);
		expect(createHash("sha256").update(readFileSync(harnessPath)).digest("hex")).toBe(
			"8d93c47d0720918630b7582593ca7e84c5ad1b128d5b0dee8c2358d60e140620",
		);
		expect(createHash("sha256").update(readFileSync(controllerPath)).digest("hex")).toBe(
			"fcaba4bae87233625e3936d07e12b7a8baa2adb93c2e02e6882ef9f913642512",
		);
		expect(createHash("sha256").update(readFileSync(faultInterpreterPath)).digest("hex")).toBe(
			"88d49b69d61814c92e5239491501cdab96c374ce941d38c553879783a3b234bd",
		);
		expect(createHash("sha256").update(readFileSync(faultControllerPath)).digest("hex")).toBe(
			"d38017e3962556401093b2318bf4616952b8132e9d8ac3f9c758fc063da432d8",
		);
		expect(createHash("sha256").update(readFileSync(rolloverInterpreterPath)).digest("hex")).toBe(
			"0f791c80ecea328500be5ddf4baa12ad1cdb15685c85b2b1eadb36f207918464",
		);
		expect(createHash("sha256").update(readFileSync(rolloverControllerPath)).digest("hex")).toBe(
			"4283d727ac18eb14940c4229a90681ef50a685a68420b5650ac93ffe7a220153",
		);
		const image = "sha256:cec9aa7aa96eea4fa036e9b82be1e6b325f2e3707f462d885868df51ec0a4b47";
		const runId = `${process.pid}-${Date.now()}`;
		const containerName = `hosted-store-v22-${runId}`;
		const timeoutContainerName = `hosted-store-v22-timeout-${runId}`;
		const faultContainerName = `hosted-store-v22-fault-${runId}`;
		const rolloverContainerName = `hosted-store-v22-rollover-${runId}`;
		const setup =
			"mkdir -p /chroot/tmp /chroot/usr /chroot/lib /chroot/lib64 /chroot/etc /chroot/proc /chroot/dev /chroot/app/src/modes/daemon/sandbox /chroot/root/.prime/agent /chroot/home; " +
			"cp -a /usr/local /chroot/usr/; cp -a /usr/lib /chroot/usr/; cp -a /lib/x86_64-linux-gnu /chroot/lib/; cp -a /lib64/ld-linux-x86-64.so.2 /chroot/lib64/; " +
			"cp /etc/passwd /etc/group /etc/nsswitch.conf /chroot/etc/; cp /input-bun /chroot/bun; chmod 755 /chroot/bun; " +
			"install -m0644 /input/hosted-session-store.ts /chroot/app/src/modes/daemon/sandbox/hosted-session-store.ts; " +
			"install -m0644 /input/hosted-child-ledger.ts /chroot/app/src/modes/daemon/sandbox/hosted-child-ledger.ts; " +
			"install -m0644 /input/hosted-session-wal.ts /chroot/app/src/modes/daemon/sandbox/hosted-session-wal.ts; " +
			"install -m0644 /input/prime-sandbox-strict-bytes.ts /chroot/app/src/modes/daemon/sandbox/prime-sandbox-strict-bytes.ts; " +
			"install -m0644 /input/hosted-session-store-posix-helper.py /chroot/app/src/modes/daemon/sandbox/hosted-session-store-posix-helper.py; " +
			"install -m0644 /input-harness.ts /chroot/app/integration.ts; chmod 700 /chroot/root /chroot/root/.prime /chroot/root/.prime/agent; chmod 755 /chroot/home; chmod 1777 /chroot/tmp; " +
			'mount -t proc proc /chroot/proc; mount --rbind /dev /chroot/dev; test "$(chroot /chroot /bun --revision)" = "1.4.0+34cbb9a40"; chroot /chroot /bun /app/integration.ts';
		const dockerArguments = [
			"docker",
			"run",
			"--rm",
			"--name",
			containerName,
			"--pull",
			"never",
			"--network",
			"none",
			"--platform",
			"linux/amd64",
			"--privileged",
			"--tmpfs",
			"/chroot:rw,nosuid,nodev,exec,mode=0755,size=768m",
			"-v",
			`${sandboxDirectory}:/input:ro`,
			"-v",
			`${bunPath}:/input-bun:ro`,
			"-v",
			`${harnessPath}:/input-harness.ts:ro`,
			"-v",
			`${controllerPath}:/input-controller.py:ro`,
			"-v",
			`${faultInterpreterPath}:/input-fault-python3:ro`,
			"-v",
			`${faultControllerPath}:/input-fault-controller.py:ro`,
			"-v",
			`${rolloverInterpreterPath}:/input-rollover-python3:ro`,
			"-v",
			`${rolloverControllerPath}:/input-rollover-controller.py:ro`,
			image,
			"/bin/sh",
			"-c",
			setup,
		];
		const boundedRunner =
			"import errno,json,os,signal,subprocess,sys\n" +
			"args=json.loads(sys.argv[1]); name=sys.argv[2]\n" +
			"def bounded(command,limit):\n q=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)\n expired=False; failed=False\n try: out,err=q.communicate(timeout=limit)\n except subprocess.TimeoutExpired:\n  expired=True\n  try: os.killpg(q.pid,signal.SIGTERM)\n  except OSError as e: failed=e.errno!=errno.ESRCH\n  try: out,err=q.communicate(timeout=2)\n  except subprocess.TimeoutExpired:\n   try: os.killpg(q.pid,signal.SIGKILL)\n   except OSError as e: failed=failed or e.errno!=errno.ESRCH\n   try: out,err=q.communicate(timeout=2)\n   except subprocess.TimeoutExpired as final: failed=True; out=final.output or b''; err=final.stderr or b''\n absent=False\n try: os.killpg(q.pid,0)\n except OSError as e: absent=e.errno==errno.ESRCH\n return q.returncode,out,err,expired,failed,absent\n" +
			"returncode,out,err,timed,failed,absent=bounded(args,30)\n" +
			"cleanup_failed=False\ntry: unused_rc,unused_out,unused_err,rm_timed,rm_failed,rm_absent=bounded(['docker','rm','-f',name],10); cleanup_failed=rm_timed or rm_failed or not rm_absent\nexcept BaseException: cleanup_failed=True\n" +
			"try: ps_rc,ps_out,unused_err,ps_timed,ps_failed,ps_absent=bounded(['docker','ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}'],10); cleanup_failed=cleanup_failed or ps_rc!=0 or ps_out.strip()!=b'' or ps_timed or ps_failed or not ps_absent\nexcept BaseException: cleanup_failed=True\n" +
			"sys.stdout.buffer.write(out); sys.stderr.buffer.write(err); sys.exit(124 if timed or failed or not absent or cleanup_failed else returncode)\n";
		try {
			const child = Bun.spawn(
				["/usr/bin/python3", "-c", boundedRunner, JSON.stringify(dockerArguments), containerName],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const stdoutPromise = new Response(child.stdout).text();
			const stderrPromise = new Response(child.stderr).text();
			const exitCode = await child.exited;
			const stdout = await stdoutPromise;
			const stderr = await stderrPromise;
			console.log(stdout);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("INTEGRATION_OK");

			const faultSetup = setup.replace(
				"chroot /chroot /bun /app/integration.ts",
				"mv /chroot/usr/local/bin/python3 /chroot/usr/local/bin/python3.real; install -m0755 /input-fault-python3 /chroot/usr/local/bin/python3; /usr/local/bin/python3 /input-fault-controller.py",
			);
			const faultArguments = dockerArguments.map((value) => {
				if (value === containerName) return faultContainerName;
				if (value === setup) return faultSetup;
				return value;
			});
			const faultChild = Bun.spawn(
				["/usr/bin/python3", "-c", boundedRunner, JSON.stringify(faultArguments), faultContainerName],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const faultStdoutPromise = new Response(faultChild.stdout).text();
			const faultStderrPromise = new Response(faultChild.stderr).text();
			const faultExitCode = await faultChild.exited;
			const faultStdout = await faultStdoutPromise;
			const faultStderr = await faultStderrPromise;
			expect(faultExitCode, faultStderr).toBe(0);
			for (const scenario of [
				"malformed-length",
				"malformed-payload",
				"trailing",
				"duplicate",
				"reordered",
				"late",
				"wrong-opcode",
				"stdout-overflow",
				"stderr-overflow",
			])
				expect(faultStdout).toContain(`FAULT_CASE_OK ${scenario}`);

			const rolloverSetup = setup.replace(
				"chroot /chroot /bun /app/integration.ts",
				"mv /chroot/usr/local/bin/python3 /chroot/usr/local/bin/python3.real; install -m0755 /input-rollover-python3 /chroot/usr/local/bin/python3; /usr/local/bin/python3 /input-rollover-controller.py",
			);
			const rolloverArguments = dockerArguments.map((value) => {
				if (value === containerName) return rolloverContainerName;
				if (value === setup) return rolloverSetup;
				return value;
			});
			const rolloverChild = Bun.spawn(
				["/usr/bin/python3", "-c", boundedRunner, JSON.stringify(rolloverArguments), rolloverContainerName],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const rolloverStdoutPromise = new Response(rolloverChild.stdout).text();
			const rolloverStderrPromise = new Response(rolloverChild.stderr).text();
			const rolloverExitCode = await rolloverChild.exited;
			const rolloverStdout = await rolloverStdoutPromise;
			const rolloverStderr = await rolloverStderrPromise;
			expect(rolloverExitCode, rolloverStderr).toBe(0);
			expect(rolloverStdout).toContain("ROLLOVER_PUBLICATION_CUT_OK case3");
			expect(rolloverStdout).toContain("ROLLOVER_PUBLICATION_CUT_OK case4");

			const timeoutSetup = setup.replace(
				"chroot /chroot /bun /app/integration.ts",
				"/usr/local/bin/python3 /input-controller.py",
			);
			const timeoutArguments = dockerArguments.map((value) => {
				if (value === containerName) return timeoutContainerName;
				if (value === setup) return timeoutSetup;
				return value;
			});
			const timeoutRunner = boundedRunner.replace("bounded(args,30)", "bounded(args,45)");
			const timeoutChild = Bun.spawn(
				["/usr/bin/python3", "-c", timeoutRunner, JSON.stringify(timeoutArguments), timeoutContainerName],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const timeoutStdoutPromise = new Response(timeoutChild.stdout).text();
			const timeoutStderrPromise = new Response(timeoutChild.stderr).text();
			const timeoutExitCode = await timeoutChild.exited;
			const timeoutStdout = await timeoutStdoutPromise;
			const timeoutStderr = await timeoutStderrPromise;
			expect(timeoutExitCode, timeoutStderr).toBe(0);
			expect(timeoutStdout).toContain("STORE_TIMEOUT_TERM_KILL_ESRCH_OK");
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
	120_000,
);
