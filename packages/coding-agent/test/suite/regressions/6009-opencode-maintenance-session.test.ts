import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { type AutoRefineReview, type HarnessState, refineHarness } from "../../../src/core/refinement/refinement.js";
import { createHarness, type Harness } from "../harness.js";

const proposal = { summary: "No change", rationale: "Fixture", expectedOutcome: "No change", edits: [] };
const missingSession =
	"Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently.";
let server: Server;
let baseUrl: string;
let agentDir: string;
let responseText: string;
let transientFailures: number;
let operation: string;
let requests: { operation: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
const harnesses: Harness[] = [];

beforeEach(async () => {
	agentDir = mkdtempSync(join(tmpdir(), "6009-agent-"));
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	requests = [];
	responseText = "OK";
	transientFailures = 0;
	operation = "ordinary";
	server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk.toString();
		const body = JSON.parse(raw) as Record<string, unknown>;
		requests.push({ operation, headers: req.headers, body });
		if (!req.headers["x-opencode-session"]) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: missingSession, type: "invalid_request_error" } }));
			return;
		}
		if (transientFailures > 0) {
			transientFailures--;
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Temporarily unavailable" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(
			`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: "stop" }] })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
	while (harnesses.length) harnesses.pop()!.cleanup();
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

async function setup(provider: string, existingSessionFile?: string, reasoning = false) {
	const harness = await createHarness({
		provider,
		models: [{ id: "routing-fixture", reasoning }],
		persistSession: true,
		existingSessionFile,
		settings: {
			compaction: { enabled: false, keepRecentTokens: 1 },
			autoRefine: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		},
	});
	harnesses.push(harness);
	// Match createAgentSession: the low-level suite harness does not bind the Agent's ID.
	harness.session.agent.sessionId = harness.sessionManager.getSessionId();
	// Keep the faux provider as the suite boundary, but serialize its actual options
	// through the real OpenAI-compatible adapter to an entirely local faux endpoint.
	const forward: FauxResponseFactory = (context, options, _state, model) =>
		completeSimple({ ...model, api: "openai-completions", baseUrl }, context, {
			...options,
			apiKey: "fixture-not-a-real-key",
			signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(5000)]),
		});
	harness.setResponses(Array.from({ length: 20 }, () => forward));
	return harness;
}

async function ordinary(harness: Harness, text = "remember this request") {
	operation = "ordinary";
	await harness.session.prompt(text);
	expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	expect(requests.at(-1)?.headers["x-opencode-session"]).toBe(harness.sessionManager.getSessionId());
}

function expectIdentity(harness: Harness, count: number) {
	const calls = requests.filter((request) => request.operation !== "ordinary");
	expect(calls).toHaveLength(count);
	for (const call of calls) {
		expect(call.headers["x-opencode-session"]).toBe(harness.sessionManager.getSessionId());
		expect(call.headers["user-agent"]).toMatch(/^prime-agent(?:\/|$)/);
	}
}

describe.each(["opencode", "opencode-go"])("ENG-6009 %s maintenance identity", (provider) => {
	it("ordinary request control", async () => {
		await ordinary(await setup(provider));
	});
	it("routes turn-prefix compaction", async () => {
		const harness = await setup(provider);
		await ordinary(harness);
		operation = "turn-prefix";
		await expect(harness.session.compact()).resolves.toMatchObject({ summary: expect.stringContaining("OK") });
		expectIdentity(harness, 1);
	});
	it.each(["off", "high"] as const)("routes both split-turn summaries with thinking %s", async (thinking) => {
		const harness = await setup(provider, undefined, true);
		harness.session.setThinkingLevel(thinking);
		await ordinary(harness);
		await ordinary(harness, "second request");
		operation = "split-compaction";
		await expect(harness.session.compact()).resolves.toMatchObject({ summary: expect.stringContaining("OK") });
		expectIdentity(harness, 2);
		const summaries = requests.filter((request) => request.operation === "split-compaction");
		expect(new Set(summaries.map((request) => request.headers["idempotency-key"])).size).toBe(2);
		expect(summaries.every((request) => request.headers["idempotency-key"])).toBe(true);
	});
	it("routes a history-only summary", async () => {
		const harness = await setup(provider);
		await ordinary(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "retained request", timestamp: Date.now() });
		operation = "history";
		await expect(harness.session.compact()).resolves.toMatchObject({ summary: "OK" });
		expectIdentity(harness, 1);
	});
	it("routes refinement planning", async () => {
		const harness = await setup(provider);
		await ordinary(harness);
		operation = "refinement-plan";
		responseText = JSON.stringify(proposal);
		await expect(harness.session.refine()).resolves.toMatchObject({ summary: "No change" });
		expectIdentity(harness, 1);
	});
	it("routes the auto-refine review gate", async () => {
		const harness = await setup(provider);
		await ordinary(harness);
		operation = "refinement-review";
		responseText = JSON.stringify({ shouldRefine: false, rationale: "No lesson" });
		const internal = harness.session as unknown as {
			_reviewAutoRefine(context: {
				reason: "turn_interval";
				turnsSinceLastReview: number;
			}): Promise<AutoRefineReview>;
		};
		await expect(
			internal._reviewAutoRefine({ reason: "turn_interval", turnsSinceLastReview: 5 }),
		).resolves.toMatchObject({ shouldRefine: false });
		expectIdentity(harness, 1);
	});
	it("routes a tree branch summary", async () => {
		const harness = await setup(provider);
		await ordinary(harness);
		const target = harness.sessionManager.getLeafId()!;
		await ordinary(harness, "explore a branch");
		operation = "branch-summary";
		await expect(harness.session.navigateTree(target, { summarize: true })).resolves.toMatchObject({
			cancelled: false,
			summaryEntry: { summary: expect.stringContaining("OK") },
		});
		expectIdentity(harness, 1);
	});
	it("keeps the owning session identity across a resume", async () => {
		const original = await setup(provider);
		await ordinary(original);
		const resumed = await setup(provider, original.sessionManager.getSessionFile());
		expect(resumed.session.sessionId).toBe(original.session.sessionId);
		await ordinary(resumed, "continue resumed session");
		operation = "resumed-compaction";
		await resumed.session.compact();
		expectIdentity(resumed, 2);
		operation = "resumed-refinement";
		responseText = JSON.stringify(proposal);
		await resumed.session.refine();
		expectIdentity(resumed, 3);
	});
	it("does not reuse another session's routing identity", async () => {
		const first = await setup(provider);
		await ordinary(first);
		operation = "first-compaction";
		await first.session.compact();
		expectIdentity(first, 1);
		const firstId = first.session.sessionId;
		requests = [];
		const second = await setup(provider);
		expect(second.session.sessionId).not.toBe(firstId);
		await ordinary(second);
		operation = "second-compaction";
		await second.session.compact();
		expectIdentity(second, 1);
	});
	it("retains session and request identity when retrying a summary", async () => {
		const harness = await setup(provider);
		await ordinary(harness);
		operation = "retry-compaction";
		transientFailures = 1;
		await harness.session.compact();
		expectIdentity(harness, 2);
		const calls = requests.filter((request) => request.operation === "retry-compaction");
		expect(calls[0].headers["idempotency-key"]).toBeTruthy();
		expect(calls[1].headers["idempotency-key"]).toBe(calls[0].headers["idempotency-key"]);
		expect(calls[1].body).toEqual(calls[0].body);
	});
	it("routes automatic compaction through the same owning session", async () => {
		const harness = await setup(provider);
		await ordinary(harness);
		operation = "automatic-compaction";
		const internal = harness.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<void>;
		};
		await internal._runAutoCompaction("threshold", false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			result: { summary: expect.stringContaining("OK") },
		});
		expectIdentity(harness, 1);
	});
	it.each([false, true])("forwards refineHarness identity with explicit headers=%s", async (explicit) => {
		const harness = await setup(provider);
		await ordinary(harness);
		operation = "refineHarness";
		responseText = JSON.stringify(proposal);
		const state: HarnessState = {
			schema: 1,
			entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
			refinements: [],
		};
		const headers: Record<string, string> = { "X-Fixture": "retained" };
		if (explicit) headers["X-OpenCode-Session"] = "explicit-conversation";
		const originalHeaders = { ...headers };
		await expect(
			refineHarness(
				harness.session.messages,
				state,
				[],
				harness.getModel(),
				"faux-key",
				{},
				headers,
				undefined,
				undefined,
				harness.session.sessionId,
			),
		).resolves.toMatchObject({ summary: "No change" });
		expect(requests.at(-1)?.headers["x-opencode-session"]).toBe(
			explicit ? "explicit-conversation" : harness.session.sessionId,
		);
		expect(requests.at(-1)?.headers["x-fixture"]).toBe("retained");
		expect(headers).toEqual(originalHeaders);
	});
});
