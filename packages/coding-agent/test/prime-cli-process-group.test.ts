import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquirePrimeCliProvisioningLock,
	PrimeCliProvisioningLock,
	primeCliProvisioningLockAlive,
	releasePrimeCliProvisioningLock,
	runPrimeCliExecutable,
	runPrimeCliProcess,
} from "../src/modes/daemon/sandbox/prime-cli-process-group.js";

const ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });

function python311(): string {
	const located311 = spawnSync("/usr/bin/which", ["python3.11"], { encoding: "utf8" });
	const located3 = spawnSync("/usr/bin/which", ["python3"], { encoding: "utf8" });
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		located311.status === 0 ? realpathSync(located311.stdout.trim()) : undefined,
		located3.status === 0 ? realpathSync(located3.stdout.trim()) : undefined,
	];
	for (const candidate of candidates) {
		if (candidate === null || candidate === undefined || candidate.charCodeAt(0) !== 0x2f) continue;
		const checked = spawnSync(candidate, [
			"-I",
			"-S",
			"-c",
			"import sys;raise SystemExit(sys.version_info[:2] != (3,11))",
		]);
		if (checked.status === 0) return candidate;
	}
	throw new Error("Python 3.11 is required for this test");
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("Prime CLI POSIX process groups", () => {
	test("captures bounded exact output with an explicit minimal environment", async () => {
		const result = await runPrimeCliProcess(
			[process.execPath, "-e", 'process.stdout.write("out");process.stderr.write("err")'],
			ENVIRONMENT,
			"/",
			5_000,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.stdout).toBe("out");
			expect(result.value.stderr).toBe("err");
			expect(result.value.exitCode).toBe(0);
			expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	test("kills and settles the complete process group on timeout", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-cli-group-"));
		chmodSync(root, 0o700);
		const pidFile = join(root, "descendant.pid");
		const script = [
			`const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"})`,
			`await Bun.write(${JSON.stringify(pidFile)},String(child.pid))`,
			"setInterval(()=>{},1000)",
		].join(";");
		const result = await runPrimeCliProcess([process.execPath, "-e", script], ENVIRONMENT, "/", 150);
		expect(result).toEqual({ ok: false, code: "TIMED_OUT" });
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(Number.isSafeInteger(pid)).toBe(true);
		expect(alive(pid)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	test("rejects a successful parent that leaves descendants and removes the group", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-cli-descendant-"));
		chmodSync(root, 0o700);
		const pidFile = join(root, "descendant.pid");
		const script = [
			`const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"})`,
			`await Bun.write(${JSON.stringify(pidFile)},String(child.pid))`,
			"child.unref()",
		].join(";");
		const result = await runPrimeCliProcess([process.execPath, "-e", script], ENVIRONMENT, "/", 3_000);
		expect(result).toEqual({ ok: false, code: "DESCENDANTS_FOUND" });
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(alive(pid)).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	test("kills immediately on output overflow and settles caller abort", async () => {
		const overflow = await runPrimeCliProcess(
			[process.execPath, "-e", 'process.stdout.write("x".repeat(70000));setInterval(()=>{},1000)'],
			ENVIRONMENT,
			"/",
			5_000,
		);
		expect(overflow).toEqual({ ok: false, code: "OUTPUT_OVERFLOW" });
		const controller = new AbortController();
		const pending = runPrimeCliProcess(
			[process.execPath, "-e", "setInterval(()=>{},1000)"],
			ENVIRONMENT,
			"/",
			5_000,
			controller.signal,
		);
		controller.abort();
		expect(await pending).toEqual({ ok: false, code: "ABORTED" });
	});

	test("rejects hostile argv and AbortSignal values without invoking traps", async () => {
		let trapped = false;
		const argv = new Proxy([process.execPath, "--version"], {
			get() {
				trapped = true;
				throw new Error("trap");
			},
		});
		expect(await runPrimeCliProcess(argv, ENVIRONMENT, "/", 1_000)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(trapped).toBe(false);
		expect(
			await runPrimeCliProcess(
				[process.execPath, "--version"],
				ENVIRONMENT,
				"/",
				1_000,
				new Proxy(new AbortController().signal, {}),
			),
		).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		let argumentTrap = false;
		const argumentsProxy = new Proxy(["--version"], {
			get() {
				argumentTrap = true;
				throw new Error("trap");
			},
		});
		expect(await runPrimeCliExecutable(process.execPath, argumentsProxy, ENVIRONMENT, "/", 1_000)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(argumentTrap).toBe(false);
	});
});

describe("Prime CLI kernel-owned flock helper", () => {
	test("serializes holders, releases through stdin, and rejects forged authority", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-cli-lock-"));
		chmodSync(root, 0o700);
		const lockPath = join(root, "provision.lock");
		const python = python311();
		const first = await acquirePrimeCliProvisioningLock(python, lockPath, ENVIRONMENT, 5_000);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(primeCliProvisioningLockAlive(first.value)).toBe(true);
		const controller = new AbortController();
		const secondPending = acquirePrimeCliProvisioningLock(python, lockPath, ENVIRONMENT, 5_000, controller.signal);
		setTimeout(() => controller.abort(), 25);
		expect(await secondPending).toEqual({ ok: false, code: "ABORTED" });
		expect(await releasePrimeCliProvisioningLock(first.value)).toEqual({ ok: true, value: first.value });
		expect(primeCliProvisioningLockAlive(first.value)).toBe(false);
		const third = await acquirePrimeCliProvisioningLock(python, lockPath, ENVIRONMENT, 5_000);
		expect(third.ok).toBe(true);
		if (third.ok)
			expect(await releasePrimeCliProvisioningLock(third.value)).toEqual({ ok: true, value: third.value });
		expect(() => new PrimeCliProvisioningLock({})).toThrow();
		rmSync(root, { recursive: true, force: true });
	});
});
