import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

/**
 * Cold real-CLI ACP coverage.
 *
 * Every other ACP test drives an in-process session with a faux provider already
 * wired up. That is exactly why a failed turn could report `end_turn` with no
 * updates: the failure mode only appears when a real `--mode acp` process talks
 * to a provider that rejects it. This spawns the real CLI over real stdio and
 * points it at a local server that answers 401.
 */

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((done) => server.close(() => done()));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A provider endpoint that always rejects, so the turn fails for a real reason. */
async function startRejectingProvider(): Promise<string> {
	const server = createServer((_req, res) => {
		res.writeHead(401, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "unauthorized in test" } }));
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return `http://127.0.0.1:${port}/v1`;
}

interface AcpResult {
	responses: Record<string, unknown>[];
	updates: number;
}

async function driveAcpTurn(baseUrl: string): Promise<AcpResult> {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-acp-cold-"));
	tempDirs.push(tempRoot);
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				intercept: {
					baseUrl,
					api: "openai-completions",
					apiKey: "test-key",
					models: [{ id: "cold/test-model", reasoning: false, input: ["text"] }],
				},
			},
		}),
		"utf-8",
	);

	const child = spawn(
		process.execPath,
		[
			tsxPath,
			cliPath,
			"--mode",
			"acp",
			"--provider",
			"intercept",
			"--model",
			"cold/test-model",
			"--no-session",
			"--offline",
			"--daemon-socket",
			join(tempRoot, "d.sock"),
		],
		{
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				HOME: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	const responses: Record<string, unknown>[] = [];
	let updates = 0;
	let buffer = "";

	const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`);

	const done = new Promise<void>((resolveDone) => {
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			// ACP frames are newline delimited; keep any partial trailing line.
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim().startsWith("{")) continue;
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (frame.method === "session/update") {
					updates++;
					continue;
				}
				responses.push(frame);
				if (frame.id === 1) {
					send({
						jsonrpc: "2.0",
						id: 2,
						method: "session/new",
						params: { cwd: projectDir, mcpServers: [] },
					});
				} else if (frame.id === 2) {
					const sessionId = (frame.result as { sessionId?: string } | undefined)?.sessionId;
					send({
						jsonrpc: "2.0",
						id: 3,
						method: "session/prompt",
						params: { sessionId, prompt: [{ type: "text", text: "say hi" }] },
					});
				} else if (frame.id === 3) {
					resolveDone();
				}
			}
		});
	});

	send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: 1, clientCapabilities: {} },
	});

	try {
		await Promise.race([
			done,
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error("ACP turn timed out")), 150_000)),
		]);
	} finally {
		// SIGKILL alone would strand whatever the CLI started for this socket (a
		// daemon supervisor, a Python kernel). Close stdin so the agent sees EOF and
		// unwinds its own children, then escalate only if it does not exit.
		child.stdin.end();
		// An already-dead child never emits "exit" again, so waiting on the event
		// alone would burn the full escalation budget after a crash.
		const alreadyExited = child.exitCode !== null || child.signalCode !== null;
		const exited = alreadyExited
			? Promise.resolve()
			: new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		const exitedInTime = await Promise.race([
			exited.then(() => true),
			new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 10_000)),
		]);
		if (!exitedInTime) {
			child.kill("SIGTERM");
			const stoppedInTime = await Promise.race([
				exited.then(() => true),
				new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
			]);
			if (!stoppedInTime) child.kill("SIGKILL");
		}
	}
	return { responses, updates };
}

describe("ACP mode over a cold real CLI process", () => {
	it("reports a provider failure instead of a silent end_turn", {
		tags: ["kernel-heavy"],
		timeout: 180_000,
	}, async () => {
		const baseUrl = await startRejectingProvider();
		const { responses, updates } = await driveAcpTurn(baseUrl);

		const initialize = responses.find((frame) => frame.id === 1);
		expect(initialize, "the real CLI must answer initialize on stdout").toBeDefined();

		const prompt = responses.find((frame) => frame.id === 3);
		expect(prompt, "session/prompt must answer").toBeDefined();

		// The provider rejected, so the turn must not claim a clean completion.
		// Before this was fixed the answer was {stopReason: "end_turn"} with
		// updates === 0, which a client reads as a successful empty turn.
		const result = (prompt as { result?: { stopReason?: string } }).result;
		const error = (prompt as { error?: unknown }).error;
		expect(
			error !== undefined || result?.stopReason !== "end_turn",
			`a failed turn must not report end_turn (updates=${updates}, frame=${JSON.stringify(prompt)})`,
		).toBe(true);

		// Failing loudly is only half of it: the client also has to be able to
		// tell *why*. Assert the provider's own rejection reaches the client
		// rather than a bare "Internal error".
		expect(JSON.stringify(error)).toContain("unauthorized in test");
	});
});
