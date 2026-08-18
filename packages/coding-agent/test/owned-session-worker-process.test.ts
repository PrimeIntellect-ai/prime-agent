import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = resolve(__dirname, "fixtures/owned-session-worker-fixture.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const frontendPids = new Set<number>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	for (const pid of frontendPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	frontendPids.clear();
	for (const pid of workerPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	workerPids.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function spawnFrontend(
	args: string[],
	pidPath: string,
	keepAlive = false,
	environment: NodeJS.ProcessEnv = {},
): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, fixturePath, ...args], {
		env: {
			...process.env,
			...environment,
			PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1",
			PRIME_AGENT_TEST_OWNED_PID_PATH: pidPath,
			...(keepAlive ? { PRIME_AGENT_TEST_KEEP_ALIVE: "1" } : {}),
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

async function waitForWorkerPid(path: string): Promise<number> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const pid = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				workerPids.add(pid);
				return pid;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Owned worker did not publish its pid");
}

async function waitForReplacementWorkerPid(path: string, previousPid: number): Promise<number> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const pid = Number(readFileSync(path, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0 && pid !== previousPid) {
				workerPids.add(pid);
				return pid;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error("Owned replacement worker did not publish its pid");
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	}
	return new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for frontend exit")), 10_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				workerPids.delete(pid);
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`Owned worker ${pid} remained alive`);
}

describe("owned session worker processes", () => {
	it("routes every headless surface through its real worker profile", async () => {
		const cases: Array<[string[], string | undefined, string, boolean?]> = [
			[["-p", "hello"], undefined, "print"],
			[[], "hello", "print", false],
			[["--mode", "json"], "", "json"],
			[["--mode", "rpc"], `${JSON.stringify({ id: "state", type: "get_state" })}\n`, "rpc"],
			[["--no-session"], undefined, "interactive-ephemeral", true],
		];
		for (const [args, stdin, profile, tty] of cases) {
			const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-routing-"));
			tempDirs.push(root);
			const pidPath = join(root, "worker.pid");
			const frontend = spawnFrontend(
				args,
				pidPath,
				tty === false,
				tty === undefined ? {} : { PRIME_AGENT_TEST_STDIN_TTY: tty ? "1" : "0" },
			);
			if (stdin !== undefined) frontend.stdin?.write(stdin);
			const workerPid = await waitForWorkerPid(pidPath);
			expect(readFileSync(`${pidPath}.profile`, "utf8").trim()).toBe(profile);
			frontend.stdin?.end();
			if (tty === false) process.kill(workerPid, "SIGKILL");
			await waitForExit(frontend);
			children.delete(frontend);
			await waitForProcessGone(workerPid);
		}
	});

	it("keeps RPC framing in the frontend and exits its worker on stdin EOF", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath);
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("correlates overlapping anonymous RPC commands without exposing internal ids", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_REVERSE_RPC_RESPONSES: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(
			`${JSON.stringify({ type: "get_state", marker: "first" })}\n${JSON.stringify({ type: "get_state", marker: "second" })}\n`,
		);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "second" })}\n${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "first" })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("drops malformed worker output instead of corrupting public RPC JSONL", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_INVALID_RPC_OUTPUT: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("does not fabricate a recovery response for response-less acknowledgements", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_CRASH_ON_ACK: "1",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		const workerPid = await waitForWorkerPid(pidPath);
		frontend.stdin?.write(`${JSON.stringify({ type: "ack_result", commandId: "command-1" })}\n`);
		const replacementPid = await waitForReplacementWorkerPid(pidPath, workerPid);
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
		await waitForProcessGone(replacementPid);
	});

	it("fails pending RPC commands when stdin closes before the worker crashes", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_CRASH_ON_COMMAND: "get_state",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 1, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({
				id: "request-1",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			})}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("fails pending RPC commands when the worker exits successfully without responding", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["--mode", "rpc"], pidPath, false, {
			PRIME_AGENT_TEST_EXIT_ZERO_ON_COMMAND: "get_state",
		});
		let stdout = "";
		frontend.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const workerPid = await waitForWorkerPid(pidPath);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 1, signal: null });
		expect(stdout).toBe(
			`${JSON.stringify({
				id: "request-1",
				type: "response",
				command: "get_state",
				success: false,
				error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
			})}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("terminates the owned worker when its frontend is killed", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
		tempDirs.push(root);
		const pidPath = join(root, "worker.pid");
		const frontend = spawnFrontend(["-p", "hello"], pidPath, true);
		const workerPid = await waitForWorkerPid(pidPath);
		const frontendPid = Number(readFileSync(`${pidPath}.frontend`, "utf8").trim());
		frontendPids.add(frontendPid);
		expect(Number(readFileSync(`${pidPath}.ppid`, "utf8").trim())).toBe(frontendPid);

		process.kill(frontendPid, "SIGKILL");
		await waitForExit(frontend);
		children.delete(frontend);
		frontendPids.delete(frontendPid);
		const terminationDeadline = Date.now() + 5000;
		while (!existsSync(`${pidPath}.terminated`) && Date.now() < terminationDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(existsSync(`${pidPath}.terminated`)).toBe(true);
		await waitForProcessGone(workerPid);
	});
});
