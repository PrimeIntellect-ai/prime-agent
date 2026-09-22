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

const waitForStdoutContains = (frontend: ChildProcess, stdout: () => string, needle: string) =>
	new Promise<void>((resolve) => {
		if (stdout().includes(needle)) return resolve();
		frontend.stdout?.on("data", function check() {
			if (stdout().includes(needle)) {
				frontend.stdout?.off("data", check);
				resolve();
			}
		});
	});

async function spawnRpcFrontend(
	args: string[] = ["--mode", "rpc"],
	env: Record<string, string> = {},
	interactive = false,
) {
	const root = mkdtempSync(join(tmpdir(), "prime-owned-worker-test-"));
	tempDirs.push(root);
	const pidPath = join(root, "worker.pid");
	const frontend = spawnFrontend(args, pidPath, interactive, env);
	// Absorb EPIPE from writing into a frontend that a regression crashed.
	frontend.stdin?.on("error", () => {});
	let stdout = "";
	frontend.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	const workerPid = await waitForWorkerPid(pidPath);
	return { frontend, workerPid, pidPath, stdout: () => stdout };
}

const endWithGetState = (frontend: ChildProcess) => {
	frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
};

const uncertainError =
	"The isolated session worker stopped during this command; its result is uncertain and was not replayed";
const failedResponse = (id: string) =>
	`${JSON.stringify({ id, type: "response", command: "get_state", success: false, error: uncertainError })}\n`;

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
		const { frontend, workerPid, stdout } = await spawnRpcFrontend();
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout()).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("correlates overlapping anonymous RPC commands without exposing internal ids", async () => {
		const { frontend, workerPid, stdout } = await spawnRpcFrontend(undefined, {
			PRIME_AGENT_TEST_REVERSE_RPC_RESPONSES: "1",
		});
		frontend.stdin?.end(
			`${JSON.stringify({ type: "get_state", marker: "first" })}\n${JSON.stringify({ type: "get_state", marker: "second" })}\n`,
		);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout()).toBe(
			`${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "second" })}\n${JSON.stringify({ type: "response", command: "get_state", success: true, marker: "first" })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("drops malformed worker output instead of corrupting public RPC JSONL", async () => {
		const { frontend, workerPid, stdout } = await spawnRpcFrontend(undefined, {
			PRIME_AGENT_TEST_INVALID_RPC_OUTPUT: "1",
		});
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout()).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
	});

	it("does not fabricate a recovery response for response-less acknowledgements", async () => {
		const { frontend, workerPid, pidPath, stdout } = await spawnRpcFrontend(undefined, {
			PRIME_AGENT_TEST_CRASH_ON_ACK: "1",
		});
		frontend.stdin?.write(`${JSON.stringify({ type: "ack_result", commandId: "command-1" })}\n`);
		const replacementPid = await waitForReplacementWorkerPid(pidPath, workerPid);
		frontend.stdin?.end(`${JSON.stringify({ id: "request-1", type: "get_state" })}\n`);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout()).toBe(
			`${JSON.stringify({ id: "request-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
		await waitForProcessGone(replacementPid);
	});

	it.each([
		["crashes mid-command", { PRIME_AGENT_TEST_CRASH_ON_COMMAND: "get_state" }, endWithGetState, "", "request-1"],
		[
			"exits successfully without responding",
			{ PRIME_AGENT_TEST_EXIT_ZERO_ON_COMMAND: "get_state" },
			endWithGetState,
			"",
			"request-1",
		],
	] as Array<[string, Record<string, string>, (frontend: ChildProcess) => void, string, string]>)(
		"fails pending RPC commands when the worker %s",
		async (_label, env, drive, prefix, failedId) => {
			const { frontend, workerPid, stdout } = await spawnRpcFrontend(undefined, env);
			drive(frontend);
			const exit = await waitForExit(frontend);
			children.delete(frontend);

			expect(exit).toEqual({ code: 1, signal: null });
			expect(stdout()).toBe(prefix + failedResponse(failedId));
			await waitForProcessGone(workerPid);
		},
	);

	it("absorbs a bridge write EPIPE and replays buffered follow-ups exactly once", async () => {
		const { frontend, workerPid, pidPath, stdout } = await spawnRpcFrontend(undefined, {
			PRIME_AGENT_TEST_CLOSE_STDIN_ON_COMMAND: "close_stdin",
		});
		// The worker acks close_stdin and closes its stdin read end (marked
		// via the .deaf file): the next bridge write EPIPEs and the frontend
		// kills the deaf worker so recovery can replay later arrivals.
		frontend.stdin?.write(`${JSON.stringify({ id: "close-1", type: "close_stdin" })}\n`);
		await waitForStdoutContains(frontend, stdout, "close_stdin");
		while (!existsSync(`${pidPath}.deaf`)) await new Promise((r) => setImmediate(r));
		frontend.stdin?.write(`${JSON.stringify({ type: "ack_result" })}\n`);
		// The absorbed EPIPE kills the worker with no observable signal, so
		// yield before the follow-up: after-1 must land in bufferedRpcInput
		// during the recovery delay, never in a racing write into the dead pipe.
		await new Promise((resolveDelay) =>
			// test-policy: allow wall-clock-timer -- no observable exists for the frontend's absorbed EPIPE teardown; this only selects the buffered interleaving
			setTimeout(resolveDelay, 150),
		);
		frontend.stdin?.write(`${JSON.stringify({ id: "after-1", type: "get_state" })}\n`);
		const replacementPid = await waitForReplacementWorkerPid(pidPath, workerPid);
		await waitForStdoutContains(frontend, stdout, '"after-1"');
		frontend.stdin?.end();
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		expect(exit).toEqual({ code: 0, signal: null });
		expect(stdout()).toBe(
			`${JSON.stringify({ id: "close-1", type: "response", command: "close_stdin", success: true })}\n${JSON.stringify({ id: "after-1", type: "response", command: "get_state", success: true })}\n`,
		);
		await waitForProcessGone(workerPid);
		await waitForProcessGone(replacementPid);
	});

	it("fails buffered follow-ups when recovery cannot replay them", async () => {
		const { frontend, workerPid, pidPath, stdout } = await spawnRpcFrontend(undefined, {
			PRIME_AGENT_TEST_CLOSE_STDIN_ON_COMMAND: "close_stdin",
		});
		// Same deaf worker, but the client ends stdin with the follow-up in
		// flight: it must be failed, not silently dropped.
		frontend.stdin?.write(`${JSON.stringify({ id: "close-1", type: "close_stdin" })}\n`);
		await waitForStdoutContains(frontend, stdout, "close_stdin");
		while (!existsSync(`${pidPath}.deaf`)) await new Promise((r) => setImmediate(r));
		const epipeChunk = `${JSON.stringify({ type: "ack_result" })}\n${JSON.stringify({ id: "after-1", type: "get_state" })}\n`;
		frontend.stdin?.end(epipeChunk);
		const exit = await waitForExit(frontend);
		children.delete(frontend);

		const ackLine = `${JSON.stringify({ id: "close-1", type: "response", command: "close_stdin", success: true })}\n`;
		expect(exit).toEqual({ code: 1, signal: null });
		expect(stdout()).toBe(ackLine + failedResponse("after-1"));
		await waitForProcessGone(workerPid);
	});

	it("terminates the owned worker when its frontend is killed", async () => {
		const { frontend, workerPid, pidPath } = await spawnRpcFrontend(["-p", "hello"], {}, true);
		const frontendPid = Number(readFileSync(`${pidPath}.frontend`, "utf8").trim());
		frontendPids.add(frontendPid);
		expect(Number(readFileSync(`${pidPath}.ppid`, "utf8").trim())).toBe(frontendPid);
		process.kill(frontendPid, "SIGKILL");
		await waitForExit(frontend);
		children.delete(frontend);
		frontendPids.delete(frontendPid);
		// Owner watch: the orphaned worker writes .terminated as it shuts down.
		// Polling yields via setImmediate (no wall-clock timer; hang = vitest timeout).
		while (!existsSync(`${pidPath}.terminated`)) {
			await new Promise((resolveTick) => setImmediate(resolveTick));
		}
		expect(existsSync(`${pidPath}.terminated`)).toBe(true);
		await waitForProcessGone(workerPid);
	});
});
