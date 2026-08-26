import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { AGENT_RUN_MODEL_SCOPE_VERSION, createAgentRunModelScope } from "../../../src/core/run-model-scope.js";
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
		const authCalls: string[] = [];
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
			resolveRequestAuth(model) {
				authCalls.push(`${model.provider}/${model.id}`);
				return {
					apiKey: `secret-key-${model.provider}`,
					headers: { "x-run-secret": `secret-header-${model.provider}` },
				};
			},
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
		expect(authCalls).toContain("native-provider-one/root-a");
		expect(authCalls).toContain("native-provider-two/worker-b");
		expect(authCalls).toContain("native-provider-one/worker-a");
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
			resolveRequestAuth: () => ({ apiKey: "second-run-key" }),
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
			resolveRequestAuth: () => {
				void failedAuth;
				throw new Error("run auth unavailable");
			},
		});
		await expect(harness.session.promptAndWait("fail", { modelScope: failed })).rejects.toThrow(
			"run auth unavailable",
		);
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
			resolveRequestAuth: () => ({
				apiKey: "secret-key-cancelled-run",
				headers: { "x-run-secret": "secret-header-cancelled-run" },
			}),
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
