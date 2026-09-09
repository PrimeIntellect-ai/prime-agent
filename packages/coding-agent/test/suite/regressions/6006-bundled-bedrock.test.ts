import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type AssistantMessage, fauxAssistantMessage, type LogEntry } from "@earendil-works/pi-ai";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
const installedCli = process.env.PRIME_AGENT_TEST_BUNDLED_CLI;
const cliPath = installedCli ? resolve(installedCli) : join(packageDir, "dist/bundle/cli.js");
const codec = new EventStreamCodec(
	(bytes) => new TextDecoder().decode(bytes),
	(text) => new TextEncoder().encode(text),
);

function encodeEvent(type: string, body: unknown): Uint8Array {
	return codec.encode({
		headers: {
			":message-type": { type: "string", value: "event" },
			":event-type": { type: "string", value: type },
			":content-type": { type: "string", value: "application/json" },
		},
		body: new TextEncoder().encode(JSON.stringify(body)),
	});
}

describe("ENG-6006 bundled Bedrock provider", () => {
	let harness: Harness | undefined;
	let server: Server | undefined;
	let socketPath: string | undefined;

	beforeAll(async () => {
		if (!installedCli) {
			await run(process.execPath, ["scripts/bundle.mjs"], { cwd: packageDir, timeout: 30_000 });
		}
	});

	afterEach(async () => {
		if (socketPath && existsSync(socketPath)) {
			const client = new DaemonClient(socketPath);
			try {
				await client.connect(1000);
				await client.request({ type: "shutdown" }, 5000);
			} finally {
				client.close();
			}
		}
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((done) => server!.close(() => done()));
		}
		harness?.cleanup();
		harness = undefined;
		server = undefined;
		socketPath = undefined;
	});

	it("keeps Bedrock unloaded when the bundled CLI starts without a request", async () => {
		harness = await createHarness();
		const hookPath = join(harness.tempDir, "reject-bedrock.mjs");
		writeFileSync(
			hookPath,
			`import { registerHooks } from "node:module";
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.includes("amazon-bedrock") || specifier === "@earendil-works/pi-ai/bedrock-provider" || specifier === "@aws-sdk/client-bedrock-runtime") {
			throw new Error("Bedrock loaded before a request");
		}
		return nextResolve(specifier, context);
	},
});`,
		);
		const { stdout, stderr } = await run(process.execPath, ["--import", hookPath, cliPath, "--offline", "--help"], {
			cwd: harness.tempDir,
			timeout: 20_000,
			env: { PATH: process.env.PATH, HOME: harness.tempDir, PRIME_AGENT_CODING_AGENT_DIR: harness.tempDir },
		});
		expect(stdout + stderr).toContain("Usage:");
	});

	it.each([
		{ outcome: "success", transport: "http1" },
		{ outcome: "denied", transport: "http1" },
		{ outcome: "success", transport: "proxy" },
		{ outcome: "denied", transport: "proxy" },
	])("handles a local $outcome response through the bundled CLI with $transport", async ({ outcome, transport }) => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.setResponses([fauxAssistantMessage("bedrock bundle response")]);
		await harness.session.prompt("Reply OK");
		const expectedText = getAssistantTexts(harness)[0]!;
		const requests: Array<{ method: string | undefined; path: string | undefined; body: string }> = [];
		server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks).toString("utf8") });
			if (outcome === "denied") {
				response.writeHead(403, {
					"content-type": "application/json",
					"x-amzn-errortype": "AccessDeniedException",
					"x-amzn-requestid": "bedrock-fixture-request",
				});
				response.end(JSON.stringify({ message: "bedrock fixture denied" }));
				return;
			}
			response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
			response.write(encodeEvent("messageStart", { role: "assistant" }));
			response.write(encodeEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: expectedText } }));
			response.write(encodeEvent("contentBlockStop", { contentBlockIndex: 0 }));
			response.write(encodeEvent("messageStop", { stopReason: "end_turn" }));
			response.end(encodeEvent("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }));
		});
		await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture address");
		writeFileSync(join(harness.tempDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
		writeFileSync(
			join(harness.tempDir, "models.json"),
			JSON.stringify({ providers: { "amazon-bedrock": { baseUrl: `http://127.0.0.1:${address.port}` } } }),
		);
		socketPath = join(harness.tempDir, "d.sock");
		const pending = run(
			process.execPath,
			[
				cliPath,
				"--daemon-socket",
				socketPath,
				"--offline",
				"--mode",
				"json",
				"--no-session",
				"--no-tools",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--provider",
				"amazon-bedrock",
				"--model",
				"amazon.nova-2-lite-v1:0",
				"--api-key",
				"fixture-not-a-real-key",
				"-p",
				"Reply OK",
			],
			{
				cwd: harness.tempDir,
				timeout: 20_000,
				maxBuffer: 2 * 1024 * 1024,
				env: {
					PATH: process.env.PATH,
					HOME: harness.tempDir,
					PRIME_AGENT_CODING_AGENT_DIR: harness.tempDir,
					PI_OFFLINE: "1",
					DO_NOT_TRACK: "1",
					AWS_EC2_METADATA_DISABLED: "true",
					AWS_BEDROCK_SKIP_AUTH: "1",
					AWS_BEDROCK_FORCE_HTTP1: "1",
					...(transport === "proxy" ? { HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1" } : {}),
					AWS_SHARED_CREDENTIALS_FILE: join(harness.tempDir, "no-credentials"),
					AWS_CONFIG_FILE: join(harness.tempDir, "no-config"),
				},
			},
		);
		pending.child.stdin?.end();
		const { stdout, stderr } = await pending;
		expect(stderr).toBe("");
		expect(stdout).not.toContain("Cannot find module");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ method: "POST", path: "/model/amazon.nova-2-lite-v1%3A0/converse-stream" });
		expect(JSON.parse(requests[0]!.body)).toMatchObject({
			messages: [{ role: "user", content: [{ text: "Reply OK" }] }],
		});
		const messages = stdout
			.trim()
			.split("\n")
			.flatMap((line): AssistantMessage[] => {
				const event = JSON.parse(line) as AgentSessionEvent;
				return event.type === "message_end" && event.message.role === "assistant" ? [event.message] : [];
			});
		expect(messages).toHaveLength(1);
		if (outcome === "success") {
			expect(messages[0]).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: expectedText }] });
		} else {
			expect(messages[0]).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("bedrock fixture denied"),
				diagnostics: expect.arrayContaining([
					expect.objectContaining({
						type: "provider_stream_failure",
						details: expect.objectContaining({
							kind: "permission",
							providerErrorType: "AccessDeniedException",
							requestId: "bedrock-fixture-request",
						}),
					}),
				]),
			});
			const logs = readFileSync(join(harness.tempDir, "logs", "agent.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LogEntry);
			const failures = logs.filter((entry) => entry.component === "ai.provider");
			expect(failures).toEqual([
				expect.objectContaining({
					level: "error",
					msg: "provider stream failure",
					provider: "amazon-bedrock",
					model: "amazon.nova-2-lite-v1:0",
					api: "bedrock-converse-stream",
					kind: "permission",
					providerErrorType: "AccessDeniedException",
					requestId: "bedrock-fixture-request",
					message: expect.stringContaining("bedrock fixture denied"),
					pid: expect.any(Number),
					mode: "daemon",
				}),
			]);
			expect(failures[0]!.pid).not.toBe(pending.child.pid);
			expect(
				logs.filter(
					(entry) => entry.component === "coding-agent.daemon-supervisor" && entry.msg.includes("ai.provider"),
				),
			).toEqual([]);
		}
	});
});
