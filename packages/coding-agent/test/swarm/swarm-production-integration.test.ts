/** Production-path coverage for the B00B test-only scripted provider. */
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentOptions } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { convertToLlm } from "../../src/core/messages.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import {
	verifySignedProductionEvidenceFreshProcess,
	writeSignedProductionEvidence,
} from "./production-evidence-adapter.js";
import { createBarrier, createBarrierScriptedProvider, type ProviderScript } from "./production-scripted-provider.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: {
		input: input * 0.000001,
		output: output * 0.000002,
		cacheRead: cacheRead * 0.0000001,
		cacheWrite: cacheWrite * 0.0000002,
		total: input * 0.000001 + output * 0.000002 + cacheRead * 0.0000001 + cacheWrite * 0.0000002,
	},
});
const canaries = [
	"B00B-system-秘密",
	"B00B-user-secret",
	"B00B-thinking-secret",
	"B00B-tool-args-secret",
	"B00B-tool-result-secret",
	"B00B-error-secret",
];

function provider(scripts: Record<string, readonly ProviderScript[]>, expected: readonly string[]) {
	const registered = createBarrierScriptedProvider({
		api: "b00b-scripted",
		provider: "b00b-scripted",
		barrier: { expected, timeoutMs: 10_000 },
		models: [
			{
				id: "fixture-a",
				responseModel: "fixture-a-resolved",
				cost: { input: 1.1, output: 2.2, cacheRead: 0.1, cacheWrite: 0.2 },
			},
			{
				id: "fixture-b",
				responseModel: "fixture-b-resolved",
				cost: { input: 3.3, output: 4.4, cacheRead: 0.3, cacheWrite: 0.4 },
			},
			{
				id: "fixture-zero",
				responseModel: "fixture-zero-resolved",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		scripts,
	});
	cleanups.push(() => registered.unregister());
	return registered;
}
function simple(requestId: string, options: Partial<ProviderScript> = {}): ProviderScript {
	return {
		requestId,
		blocks: [{ type: "text", chunks: ["safe-", "output"] }],
		usage: usage(11, 7),
		responseModel: "fixture-a-resolved",
		...options,
	};
}
function agentFor(
	model: ReturnType<typeof provider>["models"][number],
	tools: NonNullable<AgentOptions["initialState"]>["tools"] = [],
) {
	return new Agent({ getApiKey: () => "fixture-key", initialState: { model, systemPrompt: canaries[0], tools } });
}

async function readTree(directory: string): Promise<string> {
	const names = await readdir(directory);
	return (await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")))).join("\n");
}

function providerRegistration(models: ReturnType<typeof provider>["models"]) {
	return {
		baseUrl: models[0]!.baseUrl,
		apiKey: "fixture-key",
		api: models[0]!.api,
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	};
}

/**
 * Builds the same in-process runtime host used by production sessions.  In
 * particular, children are created by AgentSessionRuntime rather than injected
 * AgentSession fixtures, so this reaches runRlmChild -> runtime -> agent-loop.
 */
async function runtimeForRlmFixture(
	fixture: ReturnType<typeof provider>,
	directory: string,
	settings: Parameters<typeof SettingsManager.inMemory>[0] = {},
): Promise<AgentSessionRuntime> {
	const authStorage = AuthStorage.inMemory();
	const rootModel = fixture.models[0]!;
	authStorage.setRuntimeApiKey(rootModel.provider, "fixture-key");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, ...settings });
	const registration = providerRegistration(fixture.models);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: directory,
			authStorage,
			settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.registerProvider(rootModel.provider, registration);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			...runtimeOptions.sessionOptions,
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};
	return createAgentSessionRuntime(createRuntime, {
		cwd: directory,
		agentDir: directory,
		sessionManager: SessionManager.create(directory, join(directory, "sessions")),
		sessionOptions: {
			model: rootModel,
			noTools: "all",
			includeGoals: false,
			rlmDepth: 0,
			rlmMaxDepth: 1,
		},
	});
}

function requestIds(fanout: number, offset = 10): string[] {
	return Array.from({ length: fanout }, (_, index) => `request-${String(index + offset).padStart(4, "0")}`);
}

async function waitForTerminals(fixture: ReturnType<typeof provider>, count: number): Promise<void> {
	await vi.waitFor(
		() =>
			expect(fixture.observations().filter((observation) => observation.eventKinds.length > 0)).toHaveLength(count),
		{ timeout: 10_000, interval: 10 },
	);
}

describe("B00B production scripted provider", () => {
	test("settles every held waiter as aborted on barrier timeout and removes its abort listeners", async () => {
		vi.useFakeTimers();
		try {
			const barrier = createBarrier(["request-0091", "request-0092"], 100);
			const first = new AbortController();
			const second = new AbortController();
			const firstWait = barrier.wait("request-0091", first.signal);
			const secondWait = barrier.wait("request-0092", second.signal);
			const rejectedOpen = expect(barrier.open).rejects.toThrow("B00B_BARRIER_TIMEOUT");
			await vi.advanceTimersByTimeAsync(100);
			await expect(Promise.all([firstWait, secondWait])).resolves.toEqual(["aborted", "aborted"]);
			await rejectedOpen;
			// A stale abort listener would have a second settlement path after timeout.
			first.abort();
			second.abort();
		} finally {
			vi.useRealTimers();
		}
	});

	test("settles every held waiter as aborted when the provider closes", async () => {
		const barrier = createBarrier(["request-0093", "request-0094"], 10_000);
		const first = new AbortController();
		const second = new AbortController();
		const firstWait = barrier.wait("request-0093", first.signal);
		const secondWait = barrier.wait("request-0094", second.signal);
		const rejectedOpen = expect(barrier.open).rejects.toThrow("B00B_BARRIER_CLOSED");
		barrier.close();
		await expect(Promise.all([firstWait, secondWait])).resolves.toEqual(["aborted", "aborted"]);
		await rejectedOpen;
		first.abort();
		second.abort();
	});
	test("settles wait calls made after release, close, or pre-abort without throwing", async () => {
		const barrier = createBarrier(["request-0095", "request-0096"], 10_000);
		const rejectedOpen = expect(barrier.open).rejects.toThrow("B00B_BARRIER_CLOSED");
		barrier.release(["request-0095"]);
		await expect(barrier.wait("request-0095", undefined)).resolves.toBe("released");
		barrier.close();
		await rejectedOpen;
		await expect(barrier.wait("request-0096", undefined)).resolves.toBe("aborted");

		const preAborted = createBarrier(["request-0097"], 10_000);
		const preAbortedOpen = expect(preAborted.open).rejects.toThrow("B00B_BARRIER_CLOSED");
		const controller = new AbortController();
		controller.abort();
		await expect(preAborted.wait("request-0097", controller.signal)).resolves.toBe("aborted");
		preAborted.close();
		await preAbortedOpen;
	});
	test("registers through the real AI registry and holds a 1/4 fanout only as an observation barrier", async () => {
		const ids = ["request-0001", "request-0002", "request-0003", "request-0004"] as const;
		const fixture = provider(Object.fromEntries(ids.map((id) => [id, [simple(id, { waitForRelease: true })]])), ids);
		const agents = ids.map((_id, index) => agentFor(fixture.models[index % 3]!));
		const events = agents.map(() => [] as string[]);
		for (const [index, agent] of agents.entries()) {
			agent.subscribe((event) => {
				events[index]!.push(event.type);
			});
		}
		const runs = agents.map((agent, index) =>
			agent.prompt(`request-${String(index + 1).padStart(4, "0")} ${canaries[1]}`),
		);
		await fixture.open;
		const entries = fixture.observations();
		expect(entries).toHaveLength(4);
		expect(entries.map((entry) => entry.requestId).sort()).toEqual([...ids]);
		expect(entries.every((entry) => entry.eventKinds.length === 0)).toBe(true);
		// This releases 2..4 while 1 remains held: no semaphore/queue sits before provider entry.
		fixture.release(ids.slice(1));
		await Promise.all(runs.slice(1));
		expect(fixture.observations().find((entry) => entry.requestId === "request-0001")?.eventKinds).toEqual([]);
		fixture.release([ids[0]]);
		await runs[0];
		for (const types of events) {
			expect(types.indexOf("message_start")).toBeLessThan(types.indexOf("message_update"));
			expect(types.filter((type) => type === "message_end")).toHaveLength(2); // user plus one assistant terminal
		}
		expect(
			fixture.observations().every((entry) => entry.terminal === "done" && entry.eventKinds.at(-1) === "done"),
		).toBe(true);
	});

	test("uses exact thinking/text/tool stream events, executes one tool turn, and attributes resolved model and terminal usage", async () => {
		const id = "request-0005";
		const fixture = provider(
			{
				[id]: [
					{
						requestId: id,
						waitForRelease: true,
						responseId: "response-safe-0005",
						responseModel: "fixture-b-resolved",
						stopReason: "toolUse",
						usage: usage(101, 17, 0, 101),
						blocks: [
							{ type: "thinking", chunks: [canaries[2].slice(0, 8), canaries[2].slice(8)] },
							{ type: "text", chunks: ["call-", "tool"] },
							{
								type: "toolCall",
								id: "tool-0005",
								name: "fixture_tool",
								argumentChunks: [`{"value":"${canaries[3]}"}`],
							},
						],
					},
					{
						requestId: id,
						responseModel: "fixture-b-resolved",
						usage: usage(102, 9, 101, 1),
						blocks: [{ type: "text", chunks: ["final-", "safe"] }],
					},
				],
			},
			[id],
		);
		let toolCalls = 0;
		const tool = {
			name: "fixture_tool",
			label: "fixture tool",
			description: "test-only",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				toolCalls++;
				return { content: [{ type: "text" as const, text: canaries[4] }], details: {}, terminate: false };
			},
		};
		const agent = agentFor(fixture.models[1]!, [tool]);
		const lifecycle: string[] = [];
		agent.subscribe((event) => {
			lifecycle.push(event.type);
		});
		const run = agent.prompt(`${id} ${canaries[1]}`);
		await fixture.open;
		fixture.release([id]);
		await run;
		expect(toolCalls).toBe(1);
		const observed = fixture.observations();
		expect(observed).toHaveLength(2);
		expect(observed[0]?.eventKinds).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(observed[1]?.eventKinds).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		expect(observed.map((item) => item.responseModel)).toEqual(["fixture-b-resolved", "fixture-b-resolved"]);
		expect(observed.map((item) => item.usage?.cacheRead)).toEqual([0, 101]);
		expect(lifecycle.filter((type) => type === "message_end")).toHaveLength(4); // user, assistant, tool result, assistant
		const final = agent.state.messages.at(-1);
		expect(final).toMatchObject({
			role: "assistant",
			responseModel: "fixture-b-resolved",
			usage: usage(102, 9, 101, 1),
		});
	});

	test("isolates abort and upstream 429 from released siblings without client-side rate limiting", async () => {
		const ids = ["request-0006", "request-0007", "request-0008"] as const;
		const fixture = provider(
			{
				[ids[0]]: [simple(ids[0], { waitForRelease: true })],
				[ids[1]]: [
					{
						requestId: ids[1],
						waitForRelease: true,
						upstreamStatus: 429,
						errorCode: "upstream-429",
						usage: usage(23, 0, 5, 0),
					},
				],
				[ids[2]]: [
					simple(ids[2], { waitForRelease: true, responseModel: "fixture-zero-resolved", usage: usage(3, 2) }),
				],
			},
			ids,
		);
		const agents = [agentFor(fixture.models[0]!), agentFor(fixture.models[1]!), agentFor(fixture.models[2]!)];
		const runs = agents.map((agent, index) => agent.prompt(ids[index]!));
		await fixture.open;
		agents[0]!.abort();
		fixture.release([ids[1], ids[2]]);
		await Promise.all(runs);
		const observed = fixture.observations();
		expect(observed.find((item) => item.requestId === ids[0])).toMatchObject({
			terminal: "aborted",
			signalAborted: true,
			eventKinds: ["error"],
		});
		expect(observed.find((item) => item.requestId === ids[1])).toMatchObject({
			upstreamStatus: 429,
			terminal: "error",
			eventKinds: ["error"],
		});
		expect(observed.find((item) => item.requestId === ids[2])).toMatchObject({
			terminal: "done",
			responseModel: "fixture-zero-resolved",
		});
		expect(observed.filter((item) => item.requestId === ids[0])[0]?.eventKinds).toHaveLength(1);
	});

	test.each([1, 4, 16, 64])(
		"admits a real RLM fanout of %i children before the provider barrier opens",
		async (fanout) => {
			const ids = requestIds(fanout, fanout === 1 ? 20 : fanout * 100);
			const fixture = provider(
				Object.fromEntries(ids.map((id) => [id, [simple(id, { waitForRelease: true })]])),
				ids,
			);
			const directory = await mkdtemp(join(tmpdir(), `b00b-rlm-${fanout}-`));
			const runtime = await runtimeForRlmFixture(fixture, directory);
			cleanups.push(async () => {
				await runtime.dispose();
				await rm(directory, { recursive: true, force: true });
			});

			const handles = await Promise.all(
				ids.map((id, index) =>
					runtime.session.runRlmChild(id, {
						name: `worker-${String(index + 1).padStart(4, "0")}`,
						model: `${fixture.models[index % fixture.models.length]!.provider}/${fixture.models[index % fixture.models.length]!.id}`,
					}),
				),
			);
			// Admission is detached: every handle returns before an entry is allowed
			// to leave its observation latch.  This is deliberately not a fanout
			// semaphore or permit queue.
			expect(handles).toHaveLength(fanout);
			expect(new Set(handles.map((handle) => handle.rlm_child_id)).size).toBe(fanout);
			await fixture.open;
			const entered = fixture.observations();
			expect(entered).toHaveLength(fanout);
			expect(entered.map((entry) => entry.requestId).sort()).toEqual([...ids].sort());
			expect(entered.every((entry) => entry.eventKinds.length === 0 && entry.attempt === 1)).toBe(true);
			expect(entered.map((entry) => entry.sequence)).toEqual(
				Array.from({ length: fanout }, (_, index) => index + 1),
			);

			// Fast siblings complete while the held first request has not emitted a
			// provider event.  This proves the latch observes independently admitted
			// streams rather than serializing their execution.
			fixture.release(ids.slice(1));
			if (fanout > 1) await waitForTerminals(fixture, fanout - 1);
			expect(fixture.observations().find((entry) => entry.requestId === ids[0])?.eventKinds).toEqual([]);
			fixture.release([ids[0]!]);
			await waitForTerminals(fixture, fanout);
			expect(fixture.observations().every((entry) => entry.terminal === "done")).toBe(true);
		},
		20_000,
	);

	test("uses the RLM runtime child host for cancel, real scripted 429, and sibling isolation", async () => {
		const ids = ["request-0701", "request-0702", "request-0703"] as const;
		const fixture = provider(
			{
				[ids[0]]: [simple(ids[0], { waitForRelease: true })],
				[ids[1]]: [
					{
						requestId: ids[1],
						waitForRelease: true,
						upstreamStatus: 429,
						errorCode: "upstream-429",
						usage: usage(23, 0, 5, 0),
					},
				],
				[ids[2]]: [
					simple(ids[2], { waitForRelease: true, responseModel: "fixture-zero-resolved", usage: usage(3, 2) }),
				],
			},
			ids,
		);
		const directory = await mkdtemp(join(tmpdir(), "b00b-rlm-isolation-"));
		const runtime = await runtimeForRlmFixture(fixture, directory);
		cleanups.push(async () => {
			await runtime.dispose();
			await rm(directory, { recursive: true, force: true });
		});
		const handles = await Promise.all(
			ids.map((id, index) =>
				runtime.session.runRlmChild(id, {
					name: `worker-${String(index + 701).padStart(4, "0")}`,
					model: `${fixture.models[index]!.provider}/${fixture.models[index]!.id}`,
				}),
			),
		);
		await fixture.open;
		expect(fixture.observations().every((entry) => entry.eventKinds.length === 0)).toBe(true);
		await vi.waitFor(() => expect(runtime.session.getRlmChildSession(handles[0]!.rlm_child_id)).toBeDefined());
		expect(runtime.session.cancelRlmChildRun(handles[0]!.rlm_child_id, "B00B_CANCELLED")).toBe(true);
		fixture.release([ids[1], ids[2]]);
		await waitForTerminals(fixture, 3);
		const observed = fixture.observations();
		expect(observed.find((entry) => entry.requestId === ids[0])).toMatchObject({
			terminal: "aborted",
			signalAborted: true,
			eventKinds: ["error"],
		});
		expect(observed.find((entry) => entry.requestId === ids[1])).toMatchObject({
			upstreamStatus: 429,
			terminal: "error",
			eventKinds: ["error"],
		});
		expect(observed.find((entry) => entry.requestId === ids[2])).toMatchObject({
			terminal: "done",
			responseModel: "fixture-zero-resolved",
		});
		// The fixture’s disabled retry setting is an explicit per-child policy:
		// no synthetic local 429 and no shared client-side limiter intervene.
		expect(observed.filter((entry) => entry.requestId === ids[1])).toHaveLength(1);
	});

	test("projects immutable real RLM observations into signed B00A evidence and verifies in a fresh process", async () => {
		const id = "request-0801";
		const fixture = provider(
			{
				[id]: [
					simple(id, { waitForRelease: true, responseModel: "fixture-b-resolved", usage: usage(101, 13, 7, 3) }),
				],
			},
			[id],
		);
		const directory = await mkdtemp(join(tmpdir(), "b00b-rlm-evidence-"));
		const artifactDirectory = await mkdtemp(join(tmpdir(), "b00b-rlm-artifact-"));
		const trustDirectory = await mkdtemp(join(tmpdir(), "b00b-rlm-trust-"));
		const runtime = await runtimeForRlmFixture(fixture, directory);
		cleanups.push(async () => {
			await runtime.dispose();
			await rm(directory, { recursive: true, force: true });
			await rm(artifactDirectory, { recursive: true, force: true });
			await rm(trustDirectory, { recursive: true, force: true });
		});
		const [handle] = await Promise.all([
			runtime.session.runRlmChild(id, { name: "worker-0801", model: `${fixture.models[1]!.provider}/fixture-b` }),
		]);
		expect(handle).toMatchObject({ model: `${fixture.models[1]!.provider}/fixture-b` });
		await fixture.open;
		fixture.release([id]);
		await waitForTerminals(fixture, 1);
		const observation = fixture.observations()[0]!;
		expect(observation.requested).toMatchObject({ provider: "b00b-scripted", model: "fixture-b" });
		expect(observation.responseModel).toBe("fixture-b-resolved");
		expect(observation.usage).toMatchObject({ input: 101, output: 13, cacheRead: 7, cacheWrite: 3 });
		const keys = generateKeyPairSync("ed25519");
		const written = await writeSignedProductionEvidence(
			artifactDirectory,
			trustDirectory,
			{
				scenario: "rlm-real-path",
				priceCard: {
					version: "fixture-price-card-v1",
					inputMicroCurrencyPerMillionMicroTokens: 17,
					outputMicroCurrencyPerMillionMicroTokens: 29,
				},
				attempts: [
					{
						requestId: observation.requestId as `request-${string}`,
						attempt: observation.attempt,
						requested: { provider: observation.requested.provider, model: observation.requested.model },
						resolved: {
							api: "b00b-scripted",
							provider: observation.requested.provider,
							model: observation.requested.model,
							responseModel: observation.responseModel!,
						},
						terminal: observation.terminal,
						usage: {
							inputMicroTokens: observation.usage!.input,
							outputMicroTokens: observation.usage!.output,
							cacheReadMicroTokens: observation.usage!.cacheRead,
							cacheWriteMicroTokens: observation.usage!.cacheWrite,
						},
					},
				],
			},
			keys.privateKey,
		);
		await verifySignedProductionEvidenceFreshProcess(
			artifactDirectory,
			written.commitmentPath,
			keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
		);
		expect(written.artifactBundleId).toMatch(/^[a-f0-9]{64}$/);
	});

	test("dispatches two policy-role siblings through the production runtime without a serial local gate", async () => {
		const ids = ["request-0901", "request-0902"] as const;
		const fixture = provider(
			{
				[ids[0]]: [simple(ids[0], { waitForRelease: true, responseModel: "fixture-a-resolved" })],
				[ids[1]]: [simple(ids[1], { waitForRelease: true, responseModel: "fixture-b-resolved" })],
			},
			ids,
		);
		const directory = await mkdtemp(join(tmpdir(), "b00b-policy-role-siblings-"));
		const runtime = await runtimeForRlmFixture(fixture, directory, {
			swarmRolePolicy: {
				version: 1,
				modelProfiles: {
					profile_a: { model: "b00b-scripted/fixture-a" },
					profile_b: { model: "b00b-scripted/fixture-b" },
				},
				roles: {
					analyst: {
						modelProfile: "profile_a",
						decisionScopes: ["analyze"],
						implementationScopes: [],
						allowedToolNames: [],
						sharedContext: { maxItems: 0, maxBytes: 2 },
					},
					reviewer: {
						modelProfile: "profile_b",
						decisionScopes: ["review"],
						implementationScopes: [],
						allowedToolNames: [],
						sharedContext: { maxItems: 0, maxBytes: 2 },
					},
				},
			},
		});
		cleanups.push(async () => {
			await runtime.dispose();
			await rm(directory, { recursive: true, force: true });
		});
		try {
			vi.stubEnv("PRIME_AGENT_ENABLE_SWARM_ROLE_POLICY", "1");
			const handles = await Promise.all([
				runtime.session.runRlmChild(ids[0], {
					name: "policy-analyst",
					role: "analyst",
					decision_scopes: ["analyze"],
				}),
				runtime.session.runRlmChild(ids[1], {
					name: "policy-reviewer",
					role: "reviewer",
					decision_scopes: ["review"],
				}),
			]);
			expect(handles.map((handle) => handle.model).sort()).toEqual([
				"b00b-scripted/fixture-a",
				"b00b-scripted/fixture-b",
			]);
			await fixture.open;
			// Both provider entries precede release. The barrier observes concurrent
			// production runtime dispatch; it is not an admission queue or limiter.
			expect(
				fixture
					.observations()
					.map((entry) => entry.requestId)
					.sort(),
			).toEqual([...ids]);
			expect(fixture.observations().every((entry) => entry.eventKinds.length === 0)).toBe(true);
			fixture.release(ids);
			await waitForTerminals(fixture, 2);
			expect(
				fixture
					.observations()
					.map((entry) => entry.requested.model)
					.sort(),
			).toEqual(["fixture-a", "fixture-b"]);
		} finally {
			vi.unstubAllEnvs();
		}
	}, 20_000);

	test("runs through AgentSession.promptAndWait with a registered provider and writes no canary or network fixture", async () => {
		const id = "request-0009";
		const fixture = provider({ [id]: [simple(id, { waitForRelease: true, responseModel: "fixture-a-resolved" })] }, [
			id,
		]);
		const directory = await mkdtemp(join(tmpdir(), "b00b-session-"));
		const auth = AuthStorage.inMemory();
		const model = fixture.models[0]!;
		auth.setRuntimeApiKey(model.provider, "fixture-key");
		const registry = ModelRegistry.inMemory(auth);
		registry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "fixture-key",
			api: model.api,
			models: fixture.models.map((candidate) => ({
				id: candidate.id,
				name: candidate.name,
				api: candidate.api,
				reasoning: candidate.reasoning,
				input: candidate.input,
				cost: candidate.cost,
				contextWindow: candidate.contextWindow,
				maxTokens: candidate.maxTokens,
				baseUrl: candidate.baseUrl,
			})),
		});
		const agent = new Agent({
			getApiKey: () => "fixture-key",
			initialState: { model, systemPrompt: canaries[0], tools: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			cwd: directory,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});
		cleanups.push(async () => {
			session.dispose();
			await rm(directory, { recursive: true, force: true });
		});
		const run = session.promptAndWait(`${id} ${canaries[1]}`);
		await fixture.open;
		fixture.release([id]);
		await run;
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", responseModel: "fixture-a-resolved" });
		const disk = await readTree(directory);
		for (const canary of canaries) expect(disk).not.toContain(canary);
	});
});
