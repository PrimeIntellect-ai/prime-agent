import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getDaemonUpdateRestartManifestPath, VERSION } from "../src/config.js";
import { DaemonClient, type DaemonHello } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	type DaemonCommand,
	failure,
	isDaemonCommandEnvelope,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";
import { prepareDaemonUpdateRestart, runDaemonUpdateRestartCoordinator } from "../src/package-manager-cli.js";

describe("update restart owner validation", () => {
	let root: string;
	let agentDir: string;
	let registryDir: string;
	let socketPath: string;
	let server: Server;
	let owner: Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;
	let hello: DaemonHello;
	let helloDelayMs: number;
	let prepared: boolean;
	const sockets = new Set<Socket>();
	const commands: DaemonCommand["type"][] = [];
	const manifest = { formatVersion: 1, createdAt: "2026-09-09T00:00:00.000Z", sessions: [] };

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "update-owner-"));
		agentDir = join(root, "agent");
		registryDir = join(root, "registry");
		socketPath =
			process.platform === "win32" ? `\\\\.\\pipe\\update-owner-${randomUUID()}` : join(root, "daemon.sock");
		mkdirSync(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", registryDir);
		owner = await acquireDaemonSupervisorOwnership({
			socketPath,
			agentDir,
			descriptorDir: join(root, "workers"),
			registryDir,
			generation: randomUUID(),
			appVersion: VERSION,
		});
		expect(owner.record.processStartId).toBeDefined();
		hello = {
			type: "daemon_hello",
			socketPath,
			protocol: DAEMON_PROTOCOL_INFO,
			schemaId: DAEMON_SCHEMA_ID,
			appVersion: VERSION,
			clientId: "owner-validation-test",
			serverCapabilities: [...DAEMON_DEFAULT_SERVER_CAPABILITIES],
			supervisorGeneration: owner.record.generation,
			supervisorOwnerToken: owner.record.token,
			supervisorPid: owner.record.pid,
			supervisorProcessStartId: owner.record.processStartId,
			supervisorSocketPath: socketPath,
		};
		helloDelayMs = 0;
		prepared = false;
		commands.length = 0;
		server = createServer((socket) => {
			sockets.add(socket);
			const timer = setTimeout(() => socket.write(serializeJsonLine(hello)), helloDelayMs);
			const detach = attachJsonlLineReader(socket, (line) => {
				const envelope: unknown = JSON.parse(line);
				if (!isDaemonCommandEnvelope(envelope)) return;
				const command = envelope.command;
				if (command.type === "ack_result") return;
				commands.push(command.type);
				if (command.type === "prepare_update_restart") {
					prepared = true;
					socket.write(serializeJsonLine(success(envelope.id, command.type, manifest)));
				} else if (command.type === "list") {
					socket.write(
						serializeJsonLine(
							success(envelope.id, command.type, { sessions: prepared ? [] : [{ id: "active" }] }),
						),
					);
				} else {
					socket.write(serializeJsonLine(failure(envelope.id, command.type, "Unexpected test command")));
				}
			});
			socket.on("close", () => {
				clearTimeout(timer);
				detach();
				sockets.delete(socket);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
	});

	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
		await owner?.release();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function expectDaemonUnchanged(): Promise<void> {
		expect(commands).not.toContain("prepare_update_restart");
		expect(commands).not.toContain("shutdown");
		expect(existsSync(join(registryDir, "startup-fences"))).toBe(false);
		helloDelayMs = 0;
		const observer = new DaemonClient(socketPath);
		try {
			await observer.connect();
			await expect(observer.request({ type: "list" })).resolves.toMatchObject({
				success: true,
				data: { sessions: [{ id: "active" }] },
			});
		} finally {
			observer.close();
		}
	}

	it.each([0, 2100])(
		"rejects an owner outside the updater registry before preparation (hello delay %i ms)",
		async (delayMs) => {
			helloDelayMs = delayMs;
			vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", join(root, "other-registry"));
			await expect(prepareDaemonUpdateRestart(socketPath, agentDir)).rejects.toThrow(/owner does not match/);
			await expectDaemonUnchanged();
		},
	);

	it("rejects a different agent directory without stopping its sessions", async () => {
		await expect(prepareDaemonUpdateRestart(socketPath, join(root, "other-agent"))).rejects.toThrow(
			/agent directory/,
		);
		await expectDaemonUnchanged();
	});

	it.each(["valid", "malformed"])("rejects a mismatched hello before consuming %s recovery data", async (state) => {
		hello.supervisorOwnerToken = "wrong-owner";
		const manifestPath = getDaemonUpdateRestartManifestPath(socketPath, agentDir);
		mkdirSync(join(agentDir, "daemon-update-restarts"));
		const contents = state === "valid" ? `${JSON.stringify(manifest)}\n` : "{incomplete";
		writeFileSync(manifestPath, contents);
		await expect(prepareDaemonUpdateRestart(socketPath, agentDir)).rejects.toThrow(/hello does not match/);
		expect(readFileSync(manifestPath, "utf8")).toBe(contents);
		await expectDaemonUnchanged();
	});

	it("leaves a foreign daemon untouched when the restart coordinator runs", async () => {
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", join(root, "other-registry"));
		await expect(
			runDaemonUpdateRestartCoordinator({ socketPath, agentDir, statusPath: join(root, "status.json") }),
		).resolves.toMatchObject({ phase: "failed", message: expect.stringContaining("owner does not match") });
		await expectDaemonUnchanged();
	});

	it("allows the matching owner when the agent directory uses a filesystem alias", async () => {
		const alias = join(root, "agent-alias");
		symlinkSync(agentDir, alias, process.platform === "win32" ? "junction" : "dir");
		await expect(prepareDaemonUpdateRestart(socketPath, alias)).resolves.toEqual(manifest);
		expect(commands).toEqual(["prepare_update_restart"]);
		expect(existsSync(join(registryDir, "startup-fences"))).toBe(true);
	});
});
