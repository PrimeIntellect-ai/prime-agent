import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import {
	AGENT_RUN_MODEL_SCOPE_VERSION,
	createAgentRunModelScope,
	getAgentRunRequestAccess,
	revokeAgentRunModelScope,
} from "../../../src/core/run-model-scope.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

describe("issue 171 run-scoped model overlay", () => {
	const harnesses: Harness[] = [];
	const providers: Array<ReturnType<typeof registerFauxProvider>> = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (providers.length > 0) providers.pop()?.unregister();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("uses an exact three-model roster across isolated providers without persisting the run root", async () => {
		const sharedAdapter = registerFauxProvider({
			api: "faux-run-shared-adapter",
			provider: "adapter-template",
			models: [
				{ id: "root-a", name: "Root A" },
				{ id: "worker-a", name: "Worker A" },
				{ id: "worker-b", name: "Worker B" },
			],
		});
		const outsiderProvider = registerFauxProvider({
			api: "faux-run-outsider",
			provider: "ambient-outsider",
			models: [{ id: "outsider", name: "Outsider" }],
		});
		providers.push(sharedAdapter, outsiderProvider);
		const harness = await createHarness({ rlmMaxDepth: 1 });
		harnesses.push(harness);
		const modelFor = (modelId: string, provider: string): Model<string> => ({
			...sharedAdapter.getModel(modelId)!,
			provider,
		});
		const rootModel = modelFor("root-a", "native-provider-one");
		const workerBModel = modelFor("worker-b", "native-provider-two");
		const workerAModel = modelFor("worker-a", "native-provider-one");
		const durableModel = harness.session.model;
		const modelChangesBefore = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "model_change").length;
		let releaseRootRequest!: () => void;
		const rootRequestReleased = new Promise<void>((resolve) => {
			releaseRootRequest = resolve;
		});
		let rootRequestStarted!: () => void;
		const rootStarted = new Promise<void>((resolve) => {
			rootRequestStarted = resolve;
		});
		const childStarted = new Map<string, () => void>();
		const childCalls = ["native-provider-two/worker-b", "native-provider-one/worker-a"].map(
			(selector) =>
				new Promise<void>((resolve) => {
					childStarted.set(selector, resolve);
				}),
		);
		const requestAuth = new Map<string, Array<{ apiKey?: string; headers?: Record<string, string> }>>();
		let rootCalls = 0;
		const respond = async (
			_context: Context,
			options: SimpleStreamOptions | undefined,
			_state: unknown,
			model: Model<string>,
		) => {
			const selector = `${model.provider}/${model.id}`;
			const calls = requestAuth.get(selector) ?? [];
			calls.push({ apiKey: options?.apiKey, headers: options?.headers });
			requestAuth.set(selector, calls);
			if (selector !== "native-provider-one/root-a") {
				childStarted.get(selector)?.();
				return fauxAssistantMessage(`child done: ${selector}`);
			}
			rootCalls++;
			if (rootCalls === 1) {
				rootRequestStarted();
				await rootRequestReleased;
				return fauxAssistantMessage(
					fauxToolCall("ipython", {
						code: [
							'await rlm("allowed child b", name="allowed-child-b", model="native-provider-two/worker-b")',
							'await rlm("allowed child a", name="allowed-child-a", model="native-provider-one/worker-a")',
							"try:",
							'    await rlm("outsider", name="outsider", model="ambient-outsider/outsider")',
							"except Exception:",
							"    pass",
						].join("\n"),
					}),
					{ stopReason: "toolUse" },
				);
			}
			await Promise.all(childCalls);
			return fauxAssistantMessage("root done");
		};
		sharedAdapter.setResponses([respond, respond, respond, respond, respond, respond]);
		const secrets = [
			"secret-key-native-provider-one",
			"secret-key-native-provider-two",
			"secret-header-native-provider-one",
			"secret-header-native-provider-two",
		];
		const scope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: rootModel,
			models: [rootModel, workerBModel, workerAModel],
			requestAccess: [rootModel, workerBModel, workerAModel].map((model) => ({
				model,
				access: {
					kind: "secret" as const,
					contract: "secret@1" as const,
					apiKey: `secret-key-${model.provider}`,
					headers: { "x-run-secret": `secret-header-${model.provider}` },
				},
			})),
		});

		const runOne = harness.session.promptAndWait("run one", { modelScope: scope });
		await rootStarted;
		await expect(harness.session.findRlmModels("", 20)).resolves.toEqual({
			models: [
				{ provider: "native-provider-one", id: "root-a", name: "Root A", selector: "native-provider-one/root-a" },
				{
					provider: "native-provider-two",
					id: "worker-b",
					name: "Worker B",
					selector: "native-provider-two/worker-b",
				},
				{
					provider: "native-provider-one",
					id: "worker-a",
					name: "Worker A",
					selector: "native-provider-one/worker-a",
				},
			],
		});
		releaseRootRequest();
		await runOne;
		await vi.waitFor(() => expect(sharedAdapter.state.callCount).toBe(6));
		await harness.session.waitForSessionInputIdle();
		expect(outsiderProvider.state.callCount).toBe(0);
		expect(requestAuth.get("native-provider-one/root-a")).toEqual([
			{
				apiKey: "secret-key-native-provider-one",
				headers: { "x-run-secret": "secret-header-native-provider-one" },
			},
			{
				apiKey: "secret-key-native-provider-one",
				headers: { "x-run-secret": "secret-header-native-provider-one" },
			},
			{
				apiKey: "secret-key-native-provider-one",
				headers: { "x-run-secret": "secret-header-native-provider-one" },
			},
			{
				apiKey: "secret-key-native-provider-one",
				headers: { "x-run-secret": "secret-header-native-provider-one" },
			},
		]);
		expect(requestAuth.get("native-provider-two/worker-b")).toEqual([
			{
				apiKey: "secret-key-native-provider-two",
				headers: { "x-run-secret": "secret-header-native-provider-two" },
			},
		]);
		expect(requestAuth.get("native-provider-one/worker-a")).toEqual([
			{
				apiKey: "secret-key-native-provider-one",
				headers: { "x-run-secret": "secret-header-native-provider-one" },
			},
		]);
		expect(harness.session.model).toEqual(durableModel);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(
			modelChangesBefore,
		);
		const persistedAfterSuccess = JSON.stringify({
			entries: harness.sessionManager.getEntries(),
			state: harness.session.agent.state,
		});
		for (const secret of secrets) expect(persistedAfterSuccess).not.toContain(secret);
		await expect(harness.session.promptAndWait("reuse", { modelScope: scope })).rejects.toThrow("revoked");

		sharedAdapter.setResponses([respond]);
		const secondScope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: workerBModel,
			models: [workerBModel],
			requestAccess: [
				{
					model: workerBModel,
					access: { kind: "secret", contract: "secret@1", apiKey: "second-run-key" },
				},
			],
		});
		await harness.session.promptAndWait("run two", { modelScope: secondScope });
		expect(sharedAdapter.state.callCount).toBe(7);
		expect(harness.session.model).toEqual(durableModel);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(
			modelChangesBefore,
		);
		expect(
			JSON.stringify({ entries: harness.sessionManager.getEntries(), state: harness.session.agent.state }),
		).not.toContain("second-run-key");
	});

	it("requires a complete versioned access bundle before the run starts", () => {
		vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://hostile-azure.invalid");
		vi.stubEnv("AZURE_OPENAI_API_VERSION", "hostile-version");
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "hostile-project");
		vi.stubEnv("GOOGLE_CLOUD_LOCATION", "hostile-location");
		const model: Model<string> = {
			id: "root",
			name: "Root",
			api: "openai-responses",
			provider: "provider-one",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		};
		const outsider = { ...model, provider: "provider-two" };

		expect(() =>
			createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: model,
				models: [model],
				requestAccess: [],
			}),
		).toThrow("exactly cover");
		expect(() =>
			createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: model,
				models: [model],
				requestAccess: [
					{ model: outsider, access: { kind: "secret", contract: "secret@1", apiKey: "outsider-key" } },
				],
			}),
		).toThrow("outside the ordered roster");
		expect(() =>
			createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: model,
				models: [model],
				requestAccess: [
					{
						model,
						access: { kind: "managed-runtime", contract: "managed-runtime@1", environment: {} },
					},
				],
			}),
		).toThrow("does not support managed-runtime@1");
		expect(() =>
			createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: { ...model, api: "future-api" },
				models: [{ ...model, api: "future-api" }],
				requestAccess: [
					{
						model: { ...model, api: "future-api" },
						access: { kind: "secret", contract: "secret@1", apiKey: "future-key" },
					},
				],
			}),
		).toThrow("does not support secret@1");
		for (const api of ["azure-openai-responses", "google-vertex"] as const) {
			const ambientConfigModel = { ...model, api };
			expect(() =>
				createAgentRunModelScope({
					version: AGENT_RUN_MODEL_SCOPE_VERSION,
					root: ambientConfigModel,
					models: [ambientConfigModel],
					requestAccess: [
						{
							model: ambientConfigModel,
							access: { kind: "secret", contract: "secret@1", apiKey: "explicit-key" },
						},
					],
				}),
			).toThrow(`Agent run api ${api} does not support secret@1 access`);
		}
		expect(() => {
			const missingEndpoint = { ...model, baseUrl: "" };
			return createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: missingEndpoint,
				models: [missingEndpoint],
				requestAccess: [
					{
						model: missingEndpoint,
						access: { kind: "secret", contract: "secret@1", apiKey: "explicit-key" },
					},
				],
			});
		}).toThrow("requires an explicit HTTP endpoint");
		expect(() => {
			const unresolvedCloudflare = {
				...model,
				provider: "cloudflare-ai-gateway",
				baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
			};
			return createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: unresolvedCloudflare,
				models: [unresolvedCloudflare],
				requestAccess: [
					{
						model: unresolvedCloudflare,
						access: { kind: "secret", contract: "secret@1", apiKey: "explicit-key" },
					},
				],
			});
		}).toThrow("requires a resolved Cloudflare endpoint");
		for (const baseUrl of [
			"https://example.invalid/v1#fragment",
			"https://example.invalid/v1#",
			"https://gateway.ai.cloudflare.com/v1/%7BACCOUNT%7D/gateway/openai",
			"https://gateway.ai.cloudflare.com/v1/%257BACCOUNT%257D/gateway/openai",
		]) {
			const endpointModel = { ...model, baseUrl };
			expect(() =>
				createAgentRunModelScope({
					version: AGENT_RUN_MODEL_SCOPE_VERSION,
					root: endpointModel,
					models: [endpointModel],
					requestAccess: [
						{
							model: endpointModel,
							access: { kind: "secret", contract: "secret@1", apiKey: "explicit-key" },
						},
					],
				}),
			).toThrow(baseUrl.includes("#") ? "explicit HTTP endpoint" : "resolved Cloudflare endpoint");
		}
		expect(() =>
			createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: model,
				models: [model],
				requestAccess: [
					{
						model,
						access: { kind: "secret", contract: "secret@2", apiKey: "wrong-version" } as never,
					},
				],
			}),
		).toThrow("Unsupported agent run request access contract");

		const supplied = { kind: "secret" as const, contract: "secret@1" as const, apiKey: "original-key" };
		const scope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [{ model, access: supplied }],
		});
		supplied.apiKey = "mutated-key";
		const first = getAgentRunRequestAccess(scope, model);
		const second = getAgentRunRequestAccess(scope, model);
		expect(first).toBe(second);
		expect(first.apiKey).toBe("original-key");
		expect(Object.isFrozen(first)).toBe(true);
		expect(() => getAgentRunRequestAccess(scope, { ...model, baseUrl: "https://other.invalid/v1" })).toThrow(
			"does not match its admitted api and endpoint",
		);
	});

	it("revokes request auth after failure and cancellation", async () => {
		const provider = registerFauxProvider({
			api: "faux-run-terminal",
			provider: "native-terminal",
			models: [{ id: "terminal", name: "Terminal" }],
		});
		providers.push(provider);
		const harness = await createHarness();
		harnesses.push(harness);
		const model = provider.getModel("terminal")!;
		const failedAuth = {
			apiKey: "secret-key-failed-run",
			headers: { "x-run-secret": "secret-header-failed-run" },
		};
		const failed = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [{ model, access: { kind: "secret", contract: "secret@1", ...failedAuth } }],
		});
		provider.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);
		await harness.session.promptAndWait("fail", { modelScope: failed });
		await expect(harness.session.promptAndWait("reuse failed", { modelScope: failed })).rejects.toThrow("revoked");
		const persistedAfterFailure = JSON.stringify({
			entries: harness.sessionManager.getEntries(),
			state: harness.session.agent.state,
		});
		expect(persistedAfterFailure).not.toContain(failedAuth.apiKey);
		expect(persistedAfterFailure).not.toContain(failedAuth.headers["x-run-secret"]);

		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		provider.setResponses([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					requestStarted();
					const abort = () => reject(options?.signal?.reason ?? new Error("cancelled"));
					options?.signal?.addEventListener("abort", abort, { once: true });
					if (options?.signal?.aborted) abort();
				}),
		]);
		const cancelled = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [
				{
					model,
					access: {
						kind: "secret",
						contract: "secret@1",
						apiKey: "secret-key-cancelled-run",
						headers: { "x-run-secret": "secret-header-cancelled-run" },
					},
				},
			],
		});
		const run = harness.session.prompt("cancel", { modelScope: cancelled });
		await started;
		await harness.session.abort();
		await Promise.allSettled([run]);
		await expect(harness.session.promptAndWait("reuse cancelled", { modelScope: cancelled })).rejects.toThrow(
			"revoked",
		);
		const persistedAfterCancellation = JSON.stringify({
			entries: harness.sessionManager.getEntries(),
			state: harness.session.agent.state,
		});
		expect(persistedAfterCancellation).not.toContain("secret-key-cancelled-run");
		expect(persistedAfterCancellation).not.toContain("secret-header-cancelled-run");
	});

	it("keeps hostile environment configuration disabled during scoped automatic compaction", async () => {
		vi.stubEnv("PI_CACHE_RETENTION", "long");
		vi.stubEnv("PRIME_TEAM_ID", "hostile-team");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "hostile-account");
		vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "hostile-gateway");
		const provider = registerFauxProvider({
			api: "faux-run-compaction",
			provider: "native-compaction",
			models: [{ id: "compaction", name: "Compaction" }],
		});
		providers.push(provider);
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `old turn ${"x".repeat(10_000)}` }],
			timestamp: Date.now() - 3,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("old answer", { timestamp: Date.now() - 2 }));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "recent turn" }],
			timestamp: Date.now() - 1,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("recent answer"));
		const model = { ...provider.getModel("compaction")!, provider: "native-compaction" };
		const scope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [
				{
					model,
					access: { kind: "secret", contract: "secret@1", apiKey: "scoped-compaction-key" },
				},
			],
		});
		let observedOptions: SimpleStreamOptions | undefined;
		provider.setResponses([
			(_context, options) => {
				observedOptions = options;
				return fauxAssistantMessage("scoped summary");
			},
		]);
		const internals = harness.session as unknown as {
			_runAutoCompaction: (reason: "threshold", willRetry: boolean, runScope: unknown) => Promise<boolean>;
		};
		const compacted = await internals._runAutoCompaction("threshold", false, {
			modelScope: scope,
			selectedModel: model,
		});
		expect(observedOptions).toMatchObject({
			apiKey: "scoped-compaction-key",
			disableEnvApiKey: true,
		});
		expect(compacted).toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: false });
	});

	it("uses exact scoped access for interval review and explicit refine.run planning", async () => {
		vi.stubEnv("OPENAI_API_KEY", "hostile-openai");
		vi.stubEnv("PI_CACHE_RETENTION", "long");
		vi.stubEnv("PRIME_TEAM_ID", "hostile-team");
		for (const mode of ["interval", "explicit"] as const) {
			const harness = await createHarness({
				api: `faux-run-refine-${mode}`,
				provider: `native-refine-${mode}`,
				persistSession: true,
				serializedRefine: true,
				settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			});
			harnesses.push(harness);
			const model = harness.getModel();
			const scope = createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: model,
				models: [model],
				requestAccess: [
					{
						model,
						access: { kind: "secret", contract: "secret@1", apiKey: `scoped-${mode}-key` },
					},
				],
			});
			let auxiliaryOptions: SimpleStreamOptions | undefined;
			if (mode === "interval") {
				harness.setResponses([
					fauxAssistantMessage("root complete"),
					(_context, options) => {
						auxiliaryOptions = options;
						return fauxAssistantMessage('{"shouldRefine":false,"rationale":"nothing durable"}');
					},
				]);
			} else {
				harness.setResponses([
					() => {
						harness.session.handleRefineHostRequest("refine.run", { global: true });
						return fauxAssistantMessage("root complete");
					},
					(_context, options) => {
						auxiliaryOptions = options;
						return fauxAssistantMessage('{"edits":[],"rationale":"nothing durable"}');
					},
				]);
			}
			if (mode === "interval") harness.session.agent.state.model = undefined as never;
			await harness.session.promptAndWait(`run ${mode}`, { modelScope: scope });
			expect(auxiliaryOptions).toMatchObject({
				apiKey: `scoped-${mode}-key`,
				disableEnvApiKey: true,
			});
		}
	});

	it("atomically excludes side questions and scoped runs in both admission orders", async () => {
		const harness = await createHarness({ api: "faux-run-side-question", provider: "native-side-question" });
		harnesses.push(harness);
		const model = harness.getModel();
		const scope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [
				{
					model,
					access: { kind: "secret", contract: "secret@1", apiKey: "scoped-side-key" },
				},
			],
		});
		let releaseScoped!: () => void;
		const scopedBlocked = new Promise<void>((resolve) => {
			releaseScoped = resolve;
		});
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		harness.setResponses([
			async () => {
				started();
				await scopedBlocked;
				return fauxAssistantMessage("done");
			},
		]);
		const run = harness.session.promptAndWait("hold", { modelScope: scope });
		await requestStarted;
		expect(() => harness.session.startSideQuestion("blocked-side", "question", () => {})).toThrow(
			"Side questions are unavailable while a scoped model run is active",
		);
		releaseScoped();
		await run;

		let releaseSide!: () => void;
		const sideBlocked = new Promise<void>((resolve) => {
			releaseSide = resolve;
		});
		let sideStarted!: () => void;
		const sideRequestStarted = new Promise<void>((resolve) => {
			sideStarted = resolve;
		});
		harness.setResponses([
			async () => {
				sideStarted();
				await sideBlocked;
				return fauxAssistantMessage("side done");
			},
		]);
		const sideRun = harness.session.startSideQuestion("active-side", "question", () => {});
		await sideRequestStarted;
		const secondScope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [
				{
					model,
					access: { kind: "secret", contract: "secret@1", apiKey: "second-scoped-side-key" },
				},
			],
		});
		await expect(harness.session.promptAndWait("blocked scoped", { modelScope: secondScope })).rejects.toThrow(
			"Scoped model runs are unavailable while an auxiliary model request is active",
		);
		releaseSide();
		await sideRun.done;
	});

	it("atomically excludes branch summaries and scoped runs in both admission orders", async () => {
		const harness = await createHarness({ api: "faux-run-branch-summary", provider: "native-branch-summary" });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.promptAndWait("first prompt");
		await harness.session.promptAndWait("second prompt");
		const targetId = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
		const model = harness.getModel();
		const makeScope = () =>
			createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: model,
				models: [model],
				requestAccess: [
					{
						model,
						access: { kind: "secret", contract: "secret@1", apiKey: "branch-scope-key" },
					},
				],
			});

		let releaseScoped!: () => void;
		const scopedBlocked = new Promise<void>((resolve) => {
			releaseScoped = resolve;
		});
		let scopedStarted!: () => void;
		const scopedRequestStarted = new Promise<void>((resolve) => {
			scopedStarted = resolve;
		});
		harness.setResponses([
			async () => {
				scopedStarted();
				await scopedBlocked;
				return fauxAssistantMessage("scoped done");
			},
		]);
		const scopedRun = harness.session.promptAndWait("scoped hold", { modelScope: makeScope() });
		await scopedRequestStarted;
		await expect(harness.session.navigateTree(targetId, { summarize: true })).rejects.toThrow(
			"Branch summarization is unavailable while a scoped model run is active",
		);
		releaseScoped();
		await scopedRun;

		let releaseSummary!: () => void;
		const summaryBlocked = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		let summaryStarted!: () => void;
		const summaryRequestStarted = new Promise<void>((resolve) => {
			summaryStarted = resolve;
		});
		harness.setResponses([
			async () => {
				summaryStarted();
				await summaryBlocked;
				return fauxAssistantMessage("branch summary");
			},
		]);
		const navigation = harness.session.navigateTree(targetId, { summarize: true });
		await expect(harness.session.promptAndWait("blocked scoped", { modelScope: makeScope() })).rejects.toThrow(
			"Scoped model runs are unavailable while an auxiliary model request is active",
		);
		await summaryRequestStarted;
		releaseSummary();
		await navigation;
	});

	it("validates scope before normalization and fails scoped commands closed", async () => {
		let inputEffects = 0;
		let commandEffects = 0;
		const harness = await createHarness({
			api: "faux-run-normalization",
			provider: "native-normalization",
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputEffects++;
					});
					pi.registerCommand("mutate", {
						description: "mutate test state",
						handler: async () => {
							commandEffects++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const makeScope = () =>
			createAgentRunModelScope({
				version: AGENT_RUN_MODEL_SCOPE_VERSION,
				root: model,
				models: [model],
				requestAccess: [
					{
						model,
						access: { kind: "secret", contract: "secret@1", apiKey: "normalization-key" },
					},
				],
			});

		const revoked = makeScope();
		revokeAgentRunModelScope(revoked);
		await expect(harness.session.promptAndWait("ordinary input", { modelScope: revoked })).rejects.toThrow("revoked");
		for (const command of ["/mutate", "/compact", "/refine"]) {
			await expect(harness.session.promptAndWait(command, { modelScope: makeScope() })).rejects.toThrow(
				"Scoped model runs accept prompts only; slash commands are unavailable",
			);
		}
		expect(inputEffects).toBe(0);
		expect(commandEffects).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("does not accept a lookalike stream option as run-scoped auth authority", async () => {
		const provider = registerFauxProvider({
			api: "faux-run-forgery",
			provider: "native-forgery",
			models: [{ id: "forgery", name: "Forgery" }],
		});
		providers.push(provider);
		const model = provider.getModel("forgery")!;
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			authHeader: true,
		});
		const { session } = await createAgentSession({
			model,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
		});
		try {
			await expect(
				session.agent.streamFn(model, { messages: [] }, {
					apiKey: "forged-key",
					agentRunModelAuth: true,
				} as SimpleStreamOptions & { agentRunModelAuth: true }),
			).rejects.toThrow("No API key found");
			expect(provider.state.callCount).toBe(0);
		} finally {
			await session.disposeAsync();
		}
	});
});
