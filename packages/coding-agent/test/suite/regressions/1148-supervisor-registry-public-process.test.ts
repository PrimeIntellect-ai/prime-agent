import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";

const REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const repoRoot = resolve(__dirname, "../../../../..");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const cliPath = resolve(__dirname, "../../../src/cli.ts");
const ownershipContenderPath = resolve(__dirname, "../../fixtures/1148-supervisor-ownership-contender.ts");
const staleDaemonPath = resolve(__dirname, "../../fixtures/1148-stale-daemon-process.ts");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const launcherPath = resolve(repoRoot, "prime-agent.sh");
const sourceBuildId = execFileSync("git", ["-C", repoRoot, "describe", "--tags", "--always", "--dirty"], {
	encoding: "utf8",
}).trim();

const tempDirs: string[] = [];
const supervisors = new Set<ChildProcess>();
const socketPaths = new Set<string>();
const supervisorOutput = new Map<ChildProcess, { stderr: string }>();

afterEach(async () => {
	for (const socketPath of socketPaths) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.request({ type: "shutdown" }, 5000);
		} catch {
			// The supervisor may already have exited after a failed test.
		} finally {
			client.close();
		}
	}
	for (const supervisor of supervisors) {
		if (supervisor.exitCode === null && supervisor.signalCode === null) {
			supervisor.kill("SIGTERM");
		}
	}
	await Promise.all([...supervisors].map((supervisor) => waitForExit(supervisor).catch(() => undefined)));
	supervisors.clear();
	supervisorOutput.clear();
	socketPaths.clear();
	for (const directory of tempDirs.splice(0)) {
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				rmSync(directory, { recursive: true, force: true });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
					throw error;
				}
				await delay(100);
			}
		}
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-regression-1148-public-"));
	tempDirs.push(directory);
	return directory;
}

function spawnSupervisor(agentDir: string, socketPath: string, registryDir: string): ChildProcess {
	socketPaths.add(socketPath);
	const output = { stderr: "" };
	const supervisor = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PRIME_AGENT_BUILD_ID: sourceBuildId,
				PRIME_AGENT_SOURCE_BUILD_ID: sourceBuildId,
				[REGISTRY_DIR_ENV]: registryDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	supervisor.stderr?.on("data", (chunk: Buffer) => {
		output.stderr += chunk.toString("utf8");
	});
	supervisorOutput.set(supervisor, output);
	supervisors.add(supervisor);
	return supervisor;
}

function spawnOwnershipContender(
	agentDir: string,
	socketPath: string,
	descriptorDir: string,
	generation: string,
	registryDir: string,
): ChildProcess {
	const contender = spawn(process.execPath, [tsxPath, ownershipContenderPath], {
		cwd: repoRoot,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
			[REGISTRY_DIR_ENV]: registryDir,
			ENG_1148_AGENT_DIR: agentDir,
			ENG_1148_DESCRIPTOR_DIR: descriptorDir,
			ENG_1148_GENERATION: generation,
			ENG_1148_SOCKET_PATH: socketPath,
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: tsconfigPath,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	const output = { stderr: "" };
	contender.stderr?.on("data", (chunk: Buffer) => {
		output.stderr += chunk.toString("utf8");
	});
	supervisorOutput.set(contender, output);
	supervisors.add(contender);
	return contender;
}

function spawnStaleDaemon(runtimeTempDir: string, socketPath: string, resultPath: string): ChildProcess {
	const staleDaemon = spawn(process.execPath, [tsxPath, staleDaemonPath], {
		cwd: repoRoot,
		env: {
			...process.env,
			ENG_1148_RESULT_PATH: resultPath,
			ENG_1148_SOCKET_PATH: socketPath,
			TMPDIR: runtimeTempDir,
			TSX_TSCONFIG_PATH: tsconfigPath,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	const output = { stderr: "" };
	staleDaemon.stderr?.on("data", (chunk: Buffer) => {
		output.stderr += chunk.toString("utf8");
	});
	supervisorOutput.set(staleDaemon, output);
	socketPaths.add(socketPath);
	supervisors.add(staleDaemon);
	return staleDaemon;
}

async function connectEventually(socketPath: string, supervisor: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
			throw new Error(`Supervisor exited before readiness: ${supervisor.exitCode}/${supervisor.signalCode}`);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.waitForHello(2000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await delay(25);
		}
	}
	throw new Error(`Timed out connecting to supervisor: ${String(lastError)}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runPublicList(
	agentDir: string,
	registryDir: string,
	socketPath: string,
): Promise<{
	code: number | null;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolveResult) => {
		const command = spawn(launcherPath, ["list", "--json", "--daemon-socket", socketPath], {
			cwd: repoRoot,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				[REGISTRY_DIR_ENV]: registryDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		command.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		command.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		command.once("close", (code) => resolveResult({ code, stdout, stderr }));
	});
}

async function runPublicListWithDefaultSocket(
	agentDir: string,
	runtimeTempDir: string,
	registryDir: string,
): Promise<{
	code: number | null;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolveResult) => {
		const command = spawn(launcherPath, ["list", "--json"], {
			cwd: repoRoot,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				[REGISTRY_DIR_ENV]: registryDir,
				PI_OFFLINE: "1",
				TMPDIR: runtimeTempDir,
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		command.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		command.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		command.once("close", (code) => resolveResult({ code, stdout, stderr }));
	});
}

function ownerDirectory(registryDir: string): string {
	const ownerName = readdirSync(registryDir).find((name) => name.endsWith(".owner"));
	if (!ownerName) throw new Error("Supervisor owner record was not published");
	return join(registryDir, ownerName);
}

function requireResponseData(response: DaemonResponse): unknown {
	if (!response.success) {
		throw new Error(response.error);
	}
	return response.data;
}

describe("public supervisor registry recovery", () => {
	it("fails public default list with an actionable stale-daemon transition", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const runtimeTempDir = mkdtempSync(join("/tmp", "pa1148-runtime-"));
		tempDirs.push(runtimeTempDir);
		const registryDir = join(root, "registry");
		const socketPath = join(runtimeTempDir, `prime-agent-${process.getuid?.() ?? "user"}`, "daemon.sock");
		const resultPath = join(root, "stale-result.json");
		mkdirSync(runtimeTempDir, { recursive: true });

		const staleDaemon = spawnStaleDaemon(runtimeTempDir, socketPath, resultPath);
		let readinessClient: DaemonClient;
		try {
			readinessClient = await connectEventually(socketPath, staleDaemon);
		} catch (error) {
			throw new Error(`${String(error)}\n${supervisorOutput.get(staleDaemon)?.stderr ?? ""}`);
		}
		readinessClient.close();

		const listed = await runPublicListWithDefaultSocket(agentDir, runtimeTempDir, registryDir);
		expect(listed.code, listed.stderr).toBe(1);
		expect(listed.stderr).toContain("An incompatible Prime Agent daemon is running.");
		expect(listed.stderr).toContain("shutdown --force");
		expect(listed.stderr).not.toContain("no longer owns its registry entry");
		const result = JSON.parse(readFileSync(resultPath, "utf8")) as { listRequests?: number };
		expect(result.listRequests).toBe(0);
	});

	it("recovers public list after a live supervisor owner entry is pruned", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const registryDir = join(root, "registry");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, registryDir);
		const client = await connectEventually(socketPath, supervisor);
		try {
			const created = await client.request({
				type: "create",
				name: "registry-recovery",
				config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true, noSkills: true },
			});
			expect(created.success).toBe(true);

			const directory = ownerDirectory(registryDir);
			rmSync(directory, { recursive: true, force: true });
			expect(existsSync(directory)).toBe(false);

			const listed = await runPublicList(agentDir, registryDir, socketPath);
			expect(listed.code, listed.stderr).toBe(0);
			expect(listed.stderr).toBe("");
			const data = JSON.parse(listed.stdout) as { sessions?: Array<{ sessionName?: string }> };
			expect(data.sessions).toEqual(
				expect.arrayContaining([expect.objectContaining({ sessionName: "registry-recovery" })]),
			);
			expect(existsSync(join(ownerDirectory(registryDir), "owner.json"))).toBe(true);
		} finally {
			client.close();
		}
	});

	it("reclaims a partial owner record after the exact owner exits", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const registryDir = join(root, "registry");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, registryDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			name: "partial-owner-recovery",
			config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true, noSkills: true },
		});
		expect(created.success).toBe(true);
		const directory = ownerDirectory(registryDir);
		const ownerPath = join(directory, "owner.json");
		const scopePath = join(directory, "scope.json");
		expect(existsSync(ownerPath)).toBe(true);
		expect(existsSync(scopePath)).toBe(true);
		const scope = JSON.parse(readFileSync(scopePath, "utf8")) as { pid?: number; processStartId?: string };
		expect(scope.pid).toBe(client.hello?.supervisorPid);
		expect(scope.processStartId).toBeDefined();
		rmSync(ownerPath);
		client.close();
		supervisor.kill("SIGKILL");
		await waitForExit(supervisor);

		const listed = await runPublicList(agentDir, registryDir, socketPath);
		expect(listed.code, listed.stderr).toBe(0);
		expect(listed.stderr).toBe("");
		const data = JSON.parse(listed.stdout) as { sessions?: Array<{ sessionName?: string }> };
		expect(data.sessions).toEqual(
			expect.arrayContaining([expect.objectContaining({ sessionName: "partial-owner-recovery" })]),
		);
		expect(existsSync(join(ownerDirectory(registryDir), "owner.json"))).toBe(true);
	});

	it("does not steal a partial owner record from a live supervisor", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const registryDir = join(root, "registry");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, registryDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			name: "partial-owner-live",
			config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true, noSkills: true },
		});
		expect(created.success).toBe(true);
		const directory = ownerDirectory(registryDir);
		const ownerPath = join(directory, "owner.json");
		const scope = JSON.parse(readFileSync(join(directory, "scope.json"), "utf8")) as {
			pid: number;
			processStartId?: string;
			token: string;
			descriptorDir: string;
		};
		rmSync(ownerPath);

		const contender = spawnOwnershipContender(
			agentDir,
			join(root, "contender.sock"),
			scope.descriptorDir,
			`${scope.token}-contender`,
			registryDir,
		);
		await waitForExit(contender);
		expect(contender.exitCode).not.toBe(0);
		expect(contender.signalCode).toBeNull();
		expect(supervisorOutput.get(contender)?.stderr).toContain('"code":"daemon_supervisor_already_running"');
		expect(supervisorOutput.get(contender)?.stderr).toContain("already owns");
		if (existsSync(ownerPath)) {
			const repaired = JSON.parse(readFileSync(ownerPath, "utf8")) as { token: string };
			expect(repaired.token).toBe(scope.token);
		}
		const listed = await client.request({ type: "list" });
		expect(listed.success, listed.success ? undefined : listed.error).toBe(true);
		const restored = JSON.parse(readFileSync(ownerPath, "utf8")) as {
			pid: number;
			processStartId?: string;
			token: string;
		};
		expect(restored).toMatchObject(scope);
		expect(restored.pid).toBe(scope.pid);
		expect(restored.processStartId).toBe(scope.processStartId);
		expect(restored.token).toBe(scope.token);
	});

	it("fences a partial owner when a verified live contender is present", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const registryDir = join(root, "registry");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, registryDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			name: "partial-owner-contender",
			config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true, noSkills: true },
		});
		expect(created.success).toBe(true);
		const directory = ownerDirectory(registryDir);
		const ownerPath = join(directory, "owner.json");
		const originalOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as {
			version: 1;
			role: "supervisor";
			token: string;
			generation: string;
			socketPath: string;
			descriptorDir: string;
			agentDir: string;
			appVersion: string;
			phase: "starting" | "owner" | "stopping";
			createdAt: string;
			updatedAt: string;
		};
		const scope = JSON.parse(readFileSync(join(directory, "scope.json"), "utf8")) as {
			version: 1;
			role: "supervisor";
			token: string;
			generation: string;
			pid: number;
			processStartId?: string;
			socketPath: string;
			descriptorDir: string;
		};
		rmSync(ownerPath);

		const contenderGeneration = `${scope.generation}z-contender`;
		const contenderToken = "verified-live-contender";
		const processStartId = getProcessStartId(process.pid);
		const contenderDirectory = join(registryDir, `${contenderGeneration}.owner`);
		const contenderScope = {
			version: scope.version,
			role: scope.role,
			token: contenderToken,
			generation: contenderGeneration,
			pid: process.pid,
			...(processStartId ? { processStartId } : {}),
			socketPath: scope.socketPath,
			descriptorDir: scope.descriptorDir,
		};
		const contenderOwner = {
			...originalOwner,
			token: contenderToken,
			generation: contenderGeneration,
			pid: process.pid,
			...(processStartId ? { processStartId } : {}),
			phase: "owner" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		mkdirSync(contenderDirectory, { mode: 0o700 });
		writeFileSync(join(contenderDirectory, "scope.json"), `${JSON.stringify(contenderScope)}\n`);
		writeFileSync(join(contenderDirectory, "owner.json"), `${JSON.stringify(contenderOwner)}\n`);
		try {
			const fenced = await client.request({ type: "list" });
			expect(fenced).toMatchObject({
				success: false,
				error: `Daemon supervisor generation ${scope.generation} no longer owns its registry entry`,
			});
			expect(existsSync(ownerPath)).toBe(false);
			expect(existsSync(join(contenderDirectory, "owner.json"))).toBe(true);
		} finally {
			client.close();
			rmSync(contenderDirectory, { recursive: true, force: true });
		}
	});

	it("attaches after a live supervisor owner directory is pruned", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const registryDir = join(root, "registry");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, registryDir);
		const client = await connectEventually(socketPath, supervisor);
		try {
			const created = await client.request({
				type: "create",
				name: "attach-after-prune",
				config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true, noSkills: true },
			});
			expect(created.success).toBe(true);
			const createdData = requireResponseData(created) as { activeSessionId?: string; id?: string };
			const activeSessionId = createdData.activeSessionId ?? createdData.id;
			expect(activeSessionId).toBeDefined();
			rmSync(ownerDirectory(registryDir), { recursive: true, force: true });

			const attached = await client.request({ type: "attach", activeSessionId: activeSessionId! });
			expect(attached.success).toBe(true);
		} finally {
			client.close();
		}
	});

	it("replays an attach cursor after a live supervisor owner directory is pruned", async () => {
		if (process.platform === "win32") return;
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const registryDir = join(root, "registry");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, registryDir);
		const client = await connectEventually(socketPath, supervisor);
		try {
			const created = await client.request({
				type: "create",
				name: "replay-after-prune",
				config: { cwd: projectDir, agentDir, noTools: true, noExtensions: true, noSkills: true },
			});
			expect(created.success).toBe(true);
			const createdData = requireResponseData(created) as { activeSessionId?: string; id?: string };
			const activeSessionId = createdData.activeSessionId ?? createdData.id;
			expect(activeSessionId).toBeDefined();
			const initial = await client.request({
				type: "attach",
				activeSessionId: activeSessionId!,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
			});
			expect(initial.success).toBe(true);
			const initialData = requireResponseData(initial) as {
				lastEventCursor?: { generation: string; sequence: number };
			};
			expect(initialData.lastEventCursor).toBeDefined();
			rmSync(ownerDirectory(registryDir), { recursive: true, force: true });

			const replayed = await client.request({
				type: "attach",
				activeSessionId: activeSessionId!,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach"],
				resumeCursor: { activeSessionId: activeSessionId!, ...initialData.lastEventCursor! },
			});
			expect(replayed.success).toBe(true);
			const replayData = requireResponseData(replayed) as { replay?: { status?: string; toCursor?: unknown } };
			expect(replayData.replay?.status).toBe("complete");
			expect(replayData.replay?.toCursor).toBeDefined();
		} finally {
			client.close();
		}
	});
});
