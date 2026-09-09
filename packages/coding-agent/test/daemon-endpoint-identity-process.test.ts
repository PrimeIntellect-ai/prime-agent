import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { DaemonClient, DaemonPeerIdentityError } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV,
	daemonEndpointSecretPath,
	loadDaemonEndpointSecret,
} from "../src/modes/daemon/daemon-endpoint-identity.js";
import { createDaemonCommandEnvelope, type DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";

// ENG-5340 end to end against a real supervisor process with the Windows
// endpoint policy switched on through the environment.

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const sockets = new Set<string>();

afterEach(async () => {
	for (const socketPath of sockets) {
		const client = new DaemonClient(socketPath, { requirePeerIdentity: false });
		try {
			await client.connect(250);
			await client.request({ type: "shutdown", force: true }, 2000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	sockets.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
	await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
	children.clear();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function spawnSupervisor(agentDir: string, socketPath: string, cwd: string): ChildProcess {
	sockets.add(socketPath);
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				[DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV]: "1",
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for process exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function waitForHello(socketPath: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Supervisor exited early with code ${child.exitCode}`);
		const probe = new DaemonClient(socketPath, { requirePeerIdentity: false });
		try {
			await probe.connect(250);
			await probe.waitForHello(1000);
			return;
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		} finally {
			probe.close();
		}
	}
	throw new Error("Timed out waiting for the supervisor hello");
}

/** An old client: speaks the protocol but never sends endpoint_handshake. */
function legacyList(socketPath: string): Promise<{ response: DaemonResponse; closed: boolean }> {
	return new Promise((resolveResult, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let response: DaemonResponse | undefined;
		socket.on("error", reject);
		socket.on("close", () => {
			if (response) resolveResult({ response, closed: true });
			else reject(new Error("Socket closed without a response"));
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			for (const line of buffer.split("\n")) {
				if (!line.trim()) continue;
				const message = JSON.parse(line) as { type: string };
				if (message.type === "daemon_hello") {
					socket.write(`${JSON.stringify(createDaemonCommandEnvelope({ type: "list" }, "legacy-1", "legacy"))}\n`);
				} else if (message.type === "response") {
					response = message as DaemonResponse;
				}
			}
			buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
		});
	});
}

describe("daemon supervisor endpoint identity (process)", () => {
	it("admits only clients that prove the shared endpoint secret", async () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "pa-endpoint-process-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const socketPath = join(root, "daemon.sock");
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		await waitForHello(socketPath, supervisor);

		// The supervisor created the owner-only secret in its agent dir.
		expect(statSync(daemonEndpointSecretPath(agentDir)).mode & 0o777).toBe(0o600);

		const current = new DaemonClient(socketPath, {
			requirePeerIdentity: true,
			loadEndpointSecret: () => loadDaemonEndpointSecret(agentDir),
		});
		await current.connect(1000);
		const hello = await current.waitForHello(5000);
		expect(hello.serverCapabilities).toContain("endpoint_identity");
		expect(hello.endpointChallenge).toMatch(/^[0-9a-f]{64}$/);
		expect(hello.endpointHandshakeRequired).toBe(true);
		const listed = await current.request({ type: "list" });
		expect(listed.success).toBe(true);
		current.close();

		// Old client, new daemon: explicit rejection and disconnect, no silent hang.
		const legacy = await legacyList(socketPath);
		expect(legacy.response).toMatchObject({
			id: "legacy-1",
			command: "list",
			success: false,
			error: expect.stringMatching(/Endpoint handshake required/),
		});
		expect(legacy.closed).toBe(true);

		// Another account's secret never verifies.
		const impostor = new DaemonClient(socketPath, {
			requirePeerIdentity: true,
			loadEndpointSecret: () => "ff".repeat(32),
		});
		await impostor.connect(1000);
		await impostor.waitForHello(5000);
		await expect(impostor.request({ type: "list" })).rejects.toBeInstanceOf(DaemonPeerIdentityError);
		impostor.close();
	}, 90_000);
});
