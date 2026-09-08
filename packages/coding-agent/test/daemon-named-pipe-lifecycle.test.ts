import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { windowsNamedPipeUserScope } from "../src/modes/daemon/daemon-socket.js";
import { isProcessAlive, signalProcessGroupOrProcess } from "../src/utils/child-process.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const OPERATION_BUDGET_MS = 300_000;

function operationTimeout(deadline: number, maximum: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("Daemon lifecycle operation deadline exceeded");
	return Math.min(remaining, maximum);
}

// Exercises the full supervisor→worker handshake: daemon start → client
// connect/hello → session create (worker spawn → socket/named-pipe connect →
// hello → auth → ready) → list → shutdown → process exit. On win32 both the
// daemon and its session workers communicate over named pipes; elsewhere they
// use unix sockets, so the test runs on every platform.

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
let lifecycleCompleted = false;
const workerIdentities = new Map<number, string | undefined>();
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();
const childStartIds = new WeakMap<ChildProcess, string | undefined>();
const lifecyclePaths: Array<{
	root: string;
	agentDir: string;
	sessionDir: string;
	cwd: string;
	socketPath: string;
}> = [];

/** Unique per-run socket: a named pipe on win32, a unix socket under the temp dir elsewhere. */
function uniqueSocketPath(root: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-lifecycle-${windowsNamedPipeUserScope()}-${process.pid}-${Date.now()}`;
	}
	return join(root, `daemon-lifecycle-${process.pid}.sock`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveExit, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			child.removeListener("exit", onExit);
		};
		const onExit = () => {
			cleanup();
			resolveExit();
		};
		const timer = setTimeout(
			() => {
				cleanup();
				reject(new Error(`Timed out waiting for process ${child.pid ?? "unknown"} exit`));
			},
			Math.max(0, timeoutMs),
		);
		child.once("exit", onExit);
	});
}

async function connectDaemon(
	client: DaemonClient,
	daemon: ChildProcess,
	socketPath: string,
	deadline: number,
): Promise<void> {
	while (Date.now() < deadline) {
		if (daemon.exitCode !== null || daemon.signalCode !== null) {
			const diag = childDiagnostics.get(daemon);
			throw new Error(
				`Daemon exited during startup (code ${daemon.exitCode}, signal ${daemon.signalCode})\n` +
					`stdout:\n${diag?.stdout ?? ""}\nstderr:\n${diag?.stderr ?? ""}`,
			);
		}
		try {
			await client.connect(operationTimeout(deadline, 3_000));
			await client.waitForHello(operationTimeout(deadline, 5_000));
			return;
		} catch {
			client.close();
			if (Date.now() < deadline) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, operationTimeout(deadline, 100)));
			}
		}
	}
	throw new Error(`Timed out connecting to daemon at ${socketPath}`);
}

describe("daemon lifecycle through the supervisor-worker handshake", () => {
	it("starts a daemon, creates a session through the worker pipe handshake, and shuts down", async () => {
		const deadline = Date.now() + OPERATION_BUDGET_MS;
		const root = mkdtempSync(join(tmpdir(), "prime-daemon-lifecycle-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const cwd = join(root, "cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const socketPath = uniqueSocketPath(root);
		lifecyclePaths.push({ root, agentDir, sessionDir, cwd, socketPath });

		// 1. Start a real daemon supervisor.
		const daemon = spawn(
			process.execPath,
			[cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
			{
				cwd,
				env: {
					...process.env,
					PI_OFFLINE: "1",
					[ENV_AGENT_DIR]: agentDir,
				},
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: process.platform === "win32",
			},
		);
		children.push(daemon);
		childStartIds.set(daemon, daemon.pid === undefined ? undefined : getProcessStartId(daemon.pid));
		const diag = { stdout: "", stderr: "" };
		childDiagnostics.set(daemon, diag);
		daemon.stdout?.on("data", (chunk: Buffer) => (diag.stdout += chunk.toString("utf8")));
		daemon.stderr?.on("data", (chunk: Buffer) => (diag.stderr += chunk.toString("utf8")));

		const client = new DaemonClient(socketPath);
		try {
			// 2. Connect and receive the daemon hello over the socket/named pipe.
			await connectDaemon(client, daemon, socketPath, Math.min(deadline, Date.now() + 60_000));
			expect(client.hello?.type).toBe("daemon_hello");

			// 3. Create a session. The supervisor spawns a worker that opens its
			//    own socket/named pipe and completes connect → hello → auth.
			const created = await client.request(
				{
					type: "create",
					config: { cwd, agentDir, sessionDir, noTools: true, noExtensions: true },
				},
				operationTimeout(deadline, 120_000),
			);
			expect(created.success).toBe(true);
			if (!created.success) {
				throw new Error(created.error);
			}
			const summary = created.data as { activeSessionId?: string; id?: string; workerPid?: number } | undefined;
			expect(summary).toBeTruthy();
			const activeSessionId = summary?.activeSessionId ?? summary?.id;
			expect(activeSessionId).toBeTruthy();
			if (summary?.workerPid) {
				workerIdentities.set(summary.workerPid, getProcessStartId(summary.workerPid));
			}

			// 4. List sessions and confirm the created session is visible.
			const listed = await client.request({ type: "list" }, operationTimeout(deadline, 15_000));
			expect(listed.success).toBe(true);
			if (!listed.success) {
				throw new Error(listed.error);
			}
			const sessions =
				(listed.data as { sessions?: Array<{ id?: string; activeSessionId?: string }> }).sessions ?? [];
			expect(
				sessions.some((session) => session.id === activeSessionId || session.activeSessionId === activeSessionId),
			).toBe(true);

			// 5. Shut the daemon down gracefully.
			const shutdown = await client.request({ type: "shutdown" }, operationTimeout(deadline, 20_000));
			expect(shutdown.success).toBe(true);
		} finally {
			client.close();
		}

		// 6. The daemon process exits cleanly after shutdown.
		const daemonExitTimeoutMs = process.platform === "win32" ? 60_000 : 15_000;
		await waitForExit(daemon, operationTimeout(deadline, daemonExitTimeoutMs));
		expect(daemon.signalCode).toBeNull();
		expect(daemon.exitCode).toBe(0);
		lifecycleCompleted = true;
	}, 340_000);
});

afterEach(async () => {
	// Cooperative bound: synchronous canonical identity probes can overrun it.
	const deadline = Date.now() + 30_000;
	const failures: Error[] = [];
	const recordFailure = (error: unknown) => {
		failures.push(error instanceof Error ? error : new Error(String(error)));
	};
	// Keep the file outside fixture deletion; captured output also retains the full record.
	let evidenceDir: string | undefined;
	try {
		evidenceDir = mkdtempSync(join(tmpdir(), "prime-lifecycle-evidence-"));
	} catch (error) {
		recordFailure(error);
	}
	const saveEvidence = (stage: string) => {
		let record: string;
		try {
			record = JSON.stringify(
				{
					stage,
					recordedAt: new Date().toISOString(),
					deadline: new Date(deadline).toISOString(),
					lifecycleCompleted,
					paths: lifecyclePaths,
					tempDirs,
					children: children.map((child) => ({
						pid: child.pid,
						startId: childStartIds.get(child) ?? null,
						exitCode: child.exitCode,
						signalCode: child.signalCode,
						...childDiagnostics.get(child),
					})),
					workers: [...workerIdentities].map(([pid, startId]) => ({ pid, startId: startId ?? null })),
					failures: failures.map((error) => error.stack ?? error.message),
				},
				null,
				2,
			);
		} catch (error) {
			recordFailure(error);
			return;
		}
		try {
			console.error(`Lifecycle ${stage} evidence:\n${record}`);
		} catch (error) {
			recordFailure(error);
		}
		if (evidenceDir) {
			try {
				writeFileSync(join(evidenceDir, `${stage}.json`), record, { mode: 0o600 });
			} catch (error) {
				recordFailure(error);
			}
		}
	};
	// Store PIDs, captured identities, streams and paths before any signal/removal.
	saveEvidence("before-cleanup");

	const termSent = new Set<number>();
	const killSent = new Set<number>();
	const inspectAndSignal = (pid: number, startId: string | undefined): boolean => {
		if (!isProcessAlive(pid)) return false;
		const observed = getProcessStartId(pid);
		// A different known identity means the recorded process is gone. Do not signal its successor.
		if (startId !== undefined && observed !== undefined && observed !== startId) return false;
		// Unknown ownership stays pending; never infer ownership from a fresh PID lookup.
		if (startId === undefined || observed === undefined || Date.now() >= deadline) return true;
		const force = process.platform === "win32" || Date.now() >= deadline - 10_000;
		const sent = force ? killSent : termSent;
		if (!sent.has(pid)) {
			sent.add(pid);
			signalProcessGroupOrProcess(pid, force ? "SIGKILL" : "SIGTERM", (error) => {
				failures.push(error);
				saveEvidence("signal-failure");
			});
		}
		return true;
	};

	try {
		while (true) {
			let pending = false;
			for (const child of children) {
				if (child.exitCode !== null || child.signalCode !== null) continue;
				// Even if its PID is gone/reused, require the direct child's exit to be observed.
				pending = true;
				if (child.pid !== undefined) inspectAndSignal(child.pid, childStartIds.get(child));
			}
			for (const [pid, startId] of workerIdentities) {
				if (inspectAndSignal(pid, startId)) pending = true;
			}
			if (!pending) break;
			const remaining = deadline - Date.now();
			if (remaining <= 0)
				throw new Error("Lifecycle cleanup timed out; retained process tracking and fixture directories");
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(500, remaining)));
		}
		saveEvidence("processes-stopped");
		if (!lifecycleCompleted || failures.length > 0) {
			throw new AggregateError(
				failures,
				"Lifecycle or cleanup incomplete; retained fixture directories and ownership records",
			);
		}
		for (const directory of tempDirs) {
			rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	} catch (error) {
		failures.push(error instanceof Error ? error : new Error(String(error)));
		saveEvidence("cleanup-failed");
		throw error;
	}
	children.length = 0;
	workerIdentities.clear();
	tempDirs.length = 0;
	lifecyclePaths.length = 0;
}, 35_000);
