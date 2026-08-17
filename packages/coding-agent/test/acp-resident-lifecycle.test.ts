import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { isClientOwnedDaemonSession } from "../src/main.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const temporaryRoots: string[] = [];
const daemonSockets: string[] = [];
const servers: Server[] = [];
const children = new Set<ChildProcess>();

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function residentWorkerDescriptorPath(agentDir: string): string {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const candidate = join(workersRoot, directory);
		const descriptor = readdirSync(candidate).find((name) => name.endsWith(".json"));
		if (descriptor) return join(candidate, descriptor);
	}
	throw new Error("Resident worker descriptor was not persisted");
}

async function waitForFailedResidentWorker(descriptorPath: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as { lifecycle?: unknown };
			if (descriptor.lifecycle === "failed") return;
		} catch {
			// Recovery is still updating the descriptor.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error("Resident ACP worker did not enter the fresh-environment recovery state");
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.stdin?.end();
	const exited = once(child, "exit").then(() => undefined);
	const exitedGracefully = await Promise.race([
		exited.then(() => true),
		new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 15_000)),
	]);
	if (exitedGracefully) return;
	child.kill("SIGTERM");
	const stopped = await Promise.race([
		exited.then(() => true),
		new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
	]);
	if (!stopped) child.kill("SIGKILL");
}

async function shutdownDaemon(socketPath: string): Promise<void> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(250);
		await client.request({ type: "shutdown" }, 5_000);
	} catch {
		// A failed ACP startup may not have created a daemon.
	} finally {
		client.close();
	}
}

afterEach(async () => {
	for (const child of children) await stopChild(child);
	children.clear();
	for (const socketPath of daemonSockets.splice(0)) await shutdownDaemon(socketPath);
	for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
	for (const root of temporaryRoots.splice(0)) {
		// Supervisor shutdown returns before its detached worker has fully released
		// the kernel snapshot directory on every platform.
		rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
	}
});

/** A small JSON-RPC client for a real ACP stdio process. */
class AcpStdioClient {
	private readonly pending = new Map<
		number,
		{ resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
	>();
	private nextId = 1;
	private stdoutBuffer = "";
	private stderr = "";

	constructor(readonly child: ChildProcess) {
		child.stdout?.on("data", (chunk: Buffer) => this.consumeStdout(chunk.toString("utf8")));
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString("utf8");
		});
		child.once("exit", () => {
			for (const pending of this.pending.values()) {
				pending.reject(new Error(`ACP process exited before responding: ${this.stderr}`));
			}
			this.pending.clear();
		});
	}

	async start(cwd: string): Promise<string> {
		await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		const created = await this.request("session/new", { cwd, mcpServers: [] });
		const sessionId = created.sessionId;
		if (typeof sessionId !== "string")
			throw new Error(`ACP did not create a usable session: ${JSON.stringify(created)}`);
		return sessionId;
	}

	async prompt(sessionId: string, text: string): Promise<void> {
		await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
	}

	async close(): Promise<void> {
		this.child.stdin?.end();
		await stopChild(this.child);
	}

	private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolveRequest, rejectRequest) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				rejectRequest(new Error(`ACP ${method} timed out: ${this.stderr}`));
			}, 45_000);
			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timeout);
					resolveRequest(result);
				},
				reject: (error) => {
					clearTimeout(timeout);
					rejectRequest(error);
				},
			});
			this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	private consumeStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		const lines = this.stdoutBuffer.split("\n");
		this.stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			let frame: Record<string, unknown> | undefined;
			try {
				frame = record(JSON.parse(line));
			} catch {
				continue;
			}
			if (!frame || typeof frame.id !== "number") continue;
			const pending = this.pending.get(frame.id);
			if (!pending) continue;
			this.pending.delete(frame.id);
			if (frame.error !== undefined) {
				pending.reject(new Error(`ACP ${String(frame.id)} failed: ${JSON.stringify(frame.error)}`));
			} else {
				pending.resolve(record(frame.result) ?? {});
			}
		}
	}
}

function writeModels(agentDir: string, baseUrl: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					baseUrl,
					api: "openai-completions",
					// Resolve it afresh from the worker's live environment. The value
					// itself never belongs in models.json or a worker descriptor.
					apiKey: "ACP_FIXTURE_API_KEY",
					models: [{ id: "fixture/model", reasoning: false, input: ["text"] }],
				},
			},
		}),
	);
}

function writeSse(res: import("node:http").ServerResponse, body: Record<string, unknown>): void {
	res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function startIpythonFixture(): Promise<{
	baseUrl: string;
	sawLiveNamespace: () => boolean;
	authenticatedRequestCount: (secret: string) => number;
}> {
	let sawLiveNamespace = false;
	const authenticatedRequests = new Map<string, number>();
	const server = createServer(async (req, res) => {
		const authorization = req.headers.authorization;
		if (typeof authorization === "string") {
			authenticatedRequests.set(authorization, (authenticatedRequests.get(authorization) ?? 0) + 1);
		}
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		const request = record(JSON.parse(body));
		const messages = Array.isArray(request?.messages) ? request.messages.map(record).filter(Boolean) : [];
		const toolOutputs = messages
			.filter((message): message is Record<string, unknown> => message?.role === "tool")
			.map((message) => JSON.stringify(message.content));
		const readingAfterReconnect = JSON.stringify(messages).includes("read reconnect state");
		const hasCurrentToolOutput = readingAfterReconnect
			? toolOutputs.some((output) => output.includes("True"))
			: toolOutputs.some((output) => output.includes("kernel state initialized"));
		if (readingAfterReconnect && hasCurrentToolOutput) sawLiveNamespace = true;

		res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
		if (hasCurrentToolOutput) {
			writeSse(res, {
				id: "fixture-final",
				object: "chat.completion.chunk",
				created: 0,
				model: "fixture/model",
				choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
			});
			writeSse(res, {
				id: "fixture-final",
				object: "chat.completion.chunk",
				created: 0,
				model: "fixture/model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			});
		} else {
			const code = readingAfterReconnect
				? "print(id(acp_reconnect_marker) == acp_reconnect_marker_identity)"
				: "acp_reconnect_marker = object()\nacp_reconnect_marker_identity = id(acp_reconnect_marker)\nprint('kernel state initialized')";
			writeSse(res, {
				id: "fixture-tool",
				object: "chat.completion.chunk",
				created: 0,
				model: "fixture/model",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: readingAfterReconnect ? "read-kernel" : "set-kernel",
									type: "function",
									function: { name: "ipython", arguments: JSON.stringify({ code }) },
								},
							],
						},
						finish_reason: null,
					},
				],
			});
			writeSse(res, {
				id: "fixture-tool",
				object: "chat.completion.chunk",
				created: 0,
				model: "fixture/model",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			});
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
	servers.push(server);
	await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		sawLiveNamespace: () => sawLiveNamespace,
		authenticatedRequestCount: (secret) => authenticatedRequests.get(`Bearer ${secret}`) ?? 0,
	};
}

function launchAcp(
	agentDir: string,
	projectDir: string,
	daemonSocket: string,
	resume: boolean,
	fixtureApiKey = "acp-initial-fixture-secret",
): AcpStdioClient {
	const child = spawn(
		process.execPath,
		[
			tsxPath,
			cliPath,
			"--mode",
			"acp",
			"--provider",
			"fixture",
			"--model",
			"fixture/model",
			...(resume ? ["--continue"] : []),
			"--offline",
			"--daemon-socket",
			daemonSocket,
		],
		{
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				HOME: agentDir,
				// This is intentionally runtime-only. Recovery reacquires it from the
				// fresh ACP client's environment rather than serializing a descriptor.
				ACP_FIXTURE_API_KEY: fixtureApiKey,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.add(child);
	return new AcpStdioClient(child);
}

describe("ACP daemon lifecycle negotiation", () => {
	it("keeps only reattachable ACP sessions resident", () => {
		// Resident workers survive ACP stdio disconnect only when a later
		// --continue can find their session file. All ephemeral or non-ACP modes
		// are completed by their creating client.
		expect(isClientOwnedDaemonSession("acp", false)).toBe(false);
		expect(isClientOwnedDaemonSession("acp", true)).toBe(true);
		expect(isClientOwnedDaemonSession("rpc", false)).toBe(true);
		expect(isClientOwnedDaemonSession("print", false)).toBe(true);
	});

	it("recovers a crashed resident ACP worker only with fresh environment-backed model authentication", {
		tags: ["kernel-heavy"],
		timeout: 240_000,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-acp-resident-"));
		temporaryRoots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const daemonSocket = join(root, "daemon.sock");
		daemonSockets.push(daemonSocket);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const fixture = await startIpythonFixture();
		writeModels(agentDir, fixture.baseUrl);

		const initialSecret = "acp-initial-fixture-secret";
		const recoveredSecret = "acp-fresh-recovery-secret";
		const first = launchAcp(agentDir, projectDir, daemonSocket, false, initialSecret);
		const firstSession = await first.start(projectDir);
		await first.prompt(firstSession, "set reconnect state");
		await first.close();
		children.delete(first.child);

		const reattached = launchAcp(agentDir, projectDir, daemonSocket, true, initialSecret);
		const reattachedSession = await reattached.start(projectDir);
		await reattached.prompt(reattachedSession, "read reconnect state");
		await reattached.close();
		children.delete(reattached.child);

		// `object()` restores as a distinct object, so True proves this was the
		// live kernel namespace rather than a replacement kernel revived from disk.
		expect(fixture.sawLiveNamespace()).toBe(true);

		const descriptorPath = residentWorkerDescriptorPath(agentDir);
		const descriptorText = readFileSync(descriptorPath, "utf8");
		expect(descriptorText).not.toContain(initialSecret);
		expect(descriptorText).not.toContain(recoveredSecret);
		expect(descriptorText).not.toContain("ACP_FIXTURE_API_KEY");
		const descriptor = JSON.parse(descriptorText) as { pid?: number };
		if (typeof descriptor.pid !== "number") throw new Error("Resident ACP worker did not expose its pid");
		const authenticatedBeforeCrash = fixture.authenticatedRequestCount(initialSecret);
		expect(authenticatedBeforeCrash).toBeGreaterThan(0);

		process.kill(-descriptor.pid, "SIGKILL");
		await waitForFailedResidentWorker(descriptorPath);

		const recovered = launchAcp(agentDir, projectDir, daemonSocket, true, recoveredSecret);
		const recoveredSession = await recovered.start(projectDir);
		await recovered.prompt(recoveredSession, "recover authenticated model access");
		await recovered.close();
		children.delete(recovered.child);

		expect(fixture.authenticatedRequestCount(recoveredSecret)).toBeGreaterThan(0);
		expect(fixture.authenticatedRequestCount(initialSecret)).toBe(authenticatedBeforeCrash);
		const recoveredDescriptorText = readFileSync(descriptorPath, "utf8");
		expect(recoveredDescriptorText).not.toContain(initialSecret);
		expect(recoveredDescriptorText).not.toContain(recoveredSecret);
	});
});
