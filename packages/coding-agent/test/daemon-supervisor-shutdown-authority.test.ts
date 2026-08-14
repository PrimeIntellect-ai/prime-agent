/**
 * Focused supervisor shutdown-authority regressions.
 *
 * Design: docs/superpowers/specs/2026-08-14-supervisor-shutdown-authority-design.md
 *
 * Spawns a real daemon supervisor per suite with an isolated socket,
 * descriptor, agent, and supervisor-registry namespace, then exercises the
 * public shutdown command contract: missing or mismatched authority is
 * fail-closed and side-effect free, exact handshake identity terminates the
 * supervisor, and force never bypasses authority.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { createDaemonShutdownCommand, DaemonClient, type DaemonHello } from "../src/modes/daemon/daemon-client.js";
import type { DaemonCommand, DaemonShutdownAuthority } from "../src/modes/daemon/daemon-protocol.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const registryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const daemonSockets = new Set<string>();
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

afterEach(async () => {
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			const hello = await client.waitForHello(1000).catch(() => undefined);
			await client.request(createDaemonShutdownCommand(hello), 2000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-daemon-shutdown-authority-test-"));
	tempDirs.push(directory);
	return directory;
}

function spawnSupervisor(agentDir: string, socketPath: string, cwd: string, registryDir: string): ChildProcess {
	daemonSockets.add(socketPath);
	// Scrub inherited daemon worker/supervisor role vars so the spawned CLI
	// starts in supervisor mode (not worker mode) and sends daemon_hello. A
	// test running inside a Prime Agent daemon worker would otherwise spawn a
	// worker-shaped process that listens but never greets.
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PRIME_AGENT_INTERNAL_")) {
			continue;
		}
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	environment[ENV_AGENT_DIR] = agentDir;
	environment[registryDirEnv] = registryDir;
	environment.PI_OFFLINE = "1";
	environment.TSX_TSCONFIG_PATH = resolve(__dirname, "../../../tsconfig.json");
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{
			cwd,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	const diagnostics = { stdout: "", stderr: "" };
	childDiagnostics.set(child, diagnostics);
	child.stdout?.on("data", (chunk: Buffer) => {
		diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		diagnostics.stderr += chunk.toString("utf8");
	});
	return child;
}

async function connectEventually(socketPath: string, child?: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 20_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			const diagnostics = childDiagnostics.get(child);
			throw new Error(
				`Supervisor exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})\n` +
					`stdout:\n${diagnostics?.stdout ?? ""}\nstderr:\n${diagnostics?.stderr ?? ""}`,
			);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`Timed out waiting for supervisor: ${String(lastError)}`);
}

async function waitForSocketGone(socketPath: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(100);
		} catch {
			client.close();
			return;
		}
		client.close();
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error("Daemon supervisor socket remained available after shutdown");
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for process exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

interface SpawnedSupervisor {
	child: ChildProcess;
	socketPath: string;
	registryDir: string;
	agentDir: string;
	projectDir: string;
}

function spawnIsolatedSupervisor(): SpawnedSupervisor {
	const root = tempDir();
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const registryDir = join(root, "registry");
	const socketPath = join(root, `d-${randomUUID().slice(0, 8)}.sock`);
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(registryDir, { recursive: true });
	const child = spawnSupervisor(agentDir, socketPath, projectDir, registryDir);
	return { child, socketPath, registryDir, agentDir, projectDir };
}

function shutdownCommand(
	hello: DaemonHello | undefined,
	force?: boolean,
	override?: Partial<DaemonShutdownAuthority>,
): DaemonCommand {
	const command = createDaemonShutdownCommand(hello, force);
	if (!override || !command.authority) {
		return command;
	}
	return { ...command, authority: { ...command.authority, ...override } };
}

describe("supervisor shutdown authority", () => {
	it("rejects a legacy shutdown without authority and keeps the same supervisor reachable", async () => {
		const { child, socketPath } = spawnIsolatedSupervisor();
		const client = await connectEventually(socketPath, child);

		const rejected = await client.request({ type: "shutdown" }, 5000);
		expect(rejected.success).toBe(false);
		expect(rejected.success ? undefined : rejected.errorInfo?.code).toBe("shutdown_authority_rejected");

		// The same supervisor identity remains reachable and answers commands.
		const listed = await client.request({ type: "list" }, 5000);
		expect(listed.success).toBe(true);
		expect(client.hello?.supervisorGeneration).toBeTypeOf("string");

		// A proper shutdown still terminates it for cleanup.
		const accepted = await client.request(shutdownCommand(client.hello), 10_000);
		expect(accepted.success).toBe(true);
		client.close();
		await waitForSocketGone(socketPath);
		await waitForExit(child);
	});

	it("accepts a shutdown echoing the exact handshake identity and terminates that supervisor", async () => {
		const { child, socketPath } = spawnIsolatedSupervisor();
		const client = await connectEventually(socketPath, child);
		const hello = client.hello;
		expect(hello?.supervisorGeneration).toBeTypeOf("string");
		expect(hello?.supervisorOwnerToken).toBeTypeOf("string");
		expect(hello?.supervisorPid).toBeGreaterThan(0);
		expect(hello?.supervisorSocketPath).toBeTypeOf("string");

		const response = await client.request(shutdownCommand(hello), 10_000);
		expect(response.success).toBe(true);
		client.close();
		await waitForSocketGone(socketPath);
		await waitForExit(child);
	});

	it("rejects each mismatched identity component independently without shutdown", async () => {
		const { child, socketPath } = spawnIsolatedSupervisor();
		const client = await connectEventually(socketPath, child);
		const hello = client.hello;
		if (!hello) throw new Error("Missing supervisor hello");

		const otherSocketPath = `${hello.supervisorSocketPath}.other`;
		const mismatches: Array<{ name: string; command: DaemonCommand }> = [
			{
				name: "generation",
				command: shutdownCommand(hello, false, { supervisorGeneration: "other-generation" }),
			},
			{
				name: "owner token",
				command: shutdownCommand(hello, false, { supervisorOwnerToken: "other-token" }),
			},
			{
				name: "pid",
				command: shutdownCommand(hello, false, { supervisorPid: (hello.supervisorPid ?? 0) + 1 }),
			},
			{
				name: "process start",
				command: shutdownCommand(hello, false, { supervisorProcessStartId: "other-start-id" }),
			},
			{
				name: "socket path",
				command: shutdownCommand(hello, false, { supervisorSocketPath: otherSocketPath }),
			},
		];

		for (const { name, command } of mismatches) {
			const rejected = await client.request(command, 5000);
			expect(rejected.success, `expected rejection for mismatched ${name}`).toBe(false);
			expect(rejected.success ? undefined : rejected.errorInfo?.code).toBe("shutdown_authority_rejected");
			// Fail-closed and side-effect free: the same supervisor still answers.
			const listed = await client.request({ type: "list" }, 5000);
			expect(listed.success, `expected supervisor reachable after mismatched ${name}`).toBe(true);
		}

		const accepted = await client.request(shutdownCommand(hello), 10_000);
		expect(accepted.success).toBe(true);
		client.close();
		await waitForSocketGone(socketPath);
		await waitForExit(child);
	});

	it("never lets force bypass missing or mismatched authority", async () => {
		const { child, socketPath } = spawnIsolatedSupervisor();
		const client = await connectEventually(socketPath, child);
		const hello = client.hello;
		if (!hello) throw new Error("Missing supervisor hello");

		const missing = await client.request({ type: "shutdown", force: true }, 5000);
		expect(missing.success).toBe(false);
		expect(missing.success ? undefined : missing.errorInfo?.code).toBe("shutdown_authority_rejected");

		const mismatched = await client.request(
			shutdownCommand(hello, true, { supervisorOwnerToken: "other-token" }),
			5000,
		);
		expect(mismatched.success).toBe(false);
		expect(mismatched.success ? undefined : mismatched.errorInfo?.code).toBe("shutdown_authority_rejected");

		const listed = await client.request({ type: "list" }, 5000);
		expect(listed.success).toBe(true);

		const accepted = await client.request(shutdownCommand(hello, true), 10_000);
		expect(accepted.success).toBe(true);
		client.close();
		await waitForSocketGone(socketPath);
		await waitForExit(child);
	});
});
