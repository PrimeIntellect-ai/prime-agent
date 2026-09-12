import { join } from "node:path";
import {
	type Api,
	fauxAssistantMessage,
	getApiProvider,
	getModel,
	type Model,
	registerApiProvider,
} from "@earendil-works/pi-ai";
import { xaiOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { startSideQuestion } from "../../../src/core/side-question.js";
import { InProcessAgentConnection } from "../../../src/modes/agent-connection/in-process-agent-connection.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-6059 xAI subscription dispatch", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	beforeEach(() => {
		vi.stubEnv("XAI_API_KEY", "environment-key");
		vi.stubEnv("PI_OFFLINE", "1");
	});
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function setup(options: { model?: Model<Api>; persist?: boolean } = {}) {
		const harness = await createHarness({
			api: "openai-completions",
			provider: "xai",
			models: [{ id: "grok-4.5" }],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const faux = getApiProvider("openai-completions")!;
		const requests: Array<{ model: Model<Api>; key?: string }> = [];
		const installTransports = () => {
			for (const api of ["openai-completions", "openai-responses"] as const) {
				registerApiProvider({
					api,
					stream: (model, context, options) => {
						requests.push({ model, key: options?.apiKey });
						return faux.stream({ ...model, api: "openai-completions" }, context, options);
					},
					streamSimple: (model, context, options) => {
						requests.push({ model, key: options?.apiKey });
						return faux.streamSimple({ ...model, api: "openai-completions" }, context, options);
					},
				});
			}
		};
		const path = join(harness.tempDir, "auth.json");
		const storage = AuthStorage.create(path);
		const registry = ModelRegistry.inMemory(storage);
		const model = options.model ?? getModel("xai", "grok-4.5")!;
		harness.settingsManager.setCompactionEnabled(false);
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: storage,
			modelRegistry: registry,
			settingsManager: harness.settingsManager,
			sessionManager: options.persist
				? SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"))
				: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			model,
			scopedModels: [{ model, thinkingLevel: "high" }],
			tools: [],
			noTools: "all",
		});
		sessions.push(session);
		const writer = AuthStorage.create(path);
		const login = (expires = Date.now() + 60_000) =>
			writer.set("xai", {
				type: "oauth",
				access: "subscription-key",
				refresh: "refresh-key",
				expires,
			});
		const connection = Object.create(InProcessAgentConnection.prototype) as InProcessAgentConnection;
		Object.defineProperty(connection, "runtimeHost", { value: { session } });
		const refresh = async () => {
			await connection.getModelCatalog();
			installTransports();
		};
		installTransports();
		return { harness, session, registry, storage, writer, requests, login, refresh, installTransports };
	}

	test("switches existing prompt and side-question routes without reselecting the same model", async () => {
		const { harness, session, writer, requests, login, refresh } = await setup();
		harness.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("answer")));
		await session.prompt("API key turn");
		expect(requests.at(-1)).toMatchObject({ key: "environment-key", model: { api: "openai-completions" } });
		login();
		await refresh();
		expect(session.model?.api).toBe("openai-responses");
		expect(session.scopedModels[0]?.model.api).toBe("openai-responses");
		await session.prompt("subscription turn");
		expect(requests.at(-1)).toMatchObject({ key: "subscription-key", model: { api: "openai-responses" } });
		await startSideQuestion(session.agent, "side", "a side question", () => {}).done;
		expect(requests.at(-1)).toMatchObject({ key: "subscription-key", model: { api: "openai-responses" } });
		writer.set("xai", { type: "api_key", key: "saved-key" });
		await refresh();
		expect(session.model?.api).toBe("openai-completions");
		expect(session.scopedModels[0]?.model.api).toBe("openai-completions");
		await session.prompt("key turn again");
		expect(requests.at(-1)).toMatchObject({ key: "saved-key", model: { api: "openai-completions" } });
		writer.logout("xai");
		await refresh();
		await session.prompt("environment turn again");
		expect(requests.at(-1)).toMatchObject({ key: "environment-key", model: { api: "openai-completions" } });
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(4);
	});

	test("resolves fresh auth for a stale active model and refreshes before auxiliary compaction", async () => {
		const { harness, session, storage, requests, login, registry, installTransports } = await setup();
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("turn summary"),
		]);
		await session.prompt("first");
		login();
		registry.refresh();
		installTransports();
		// Deliberately skip metadata reconciliation: dispatch must not trust this old object.
		expect(session.model?.api).toBe("openai-completions");
		await session.prompt("second");
		expect(requests.at(-1)).toMatchObject({ key: "subscription-key", model: { api: "openai-responses" } });
		storage.set("xai", { type: "oauth", access: "expired", refresh: "refresh-key", expires: Date.now() - 1000 });
		vi.spyOn(xaiOAuthProvider, "refreshToken").mockResolvedValue({
			access: "rotated",
			refresh: "rotated-refresh",
			expires: Date.now() + 60_000,
		});
		const before = requests.length;
		await session.compact();
		expect(requests.length).toBeGreaterThan(before);
		for (const request of requests.slice(before)) {
			expect(request).toMatchObject({ key: "rotated", model: { api: "openai-responses" } });
		}
	});

	test("keeps caller SDK model metadata through catalog refresh and subscription switching", async () => {
		const model = {
			...getModel("xai", "grok-4.5")!,
			baseUrl: "https://caller.invalid/v2",
			headers: { "X-Caller": "kept" },
		};
		const { harness, session, requests, login, writer, refresh } = await setup({ model });
		harness.setResponses([
			fauxAssistantMessage("custom"),
			fauxAssistantMessage("subscription"),
			fauxAssistantMessage("restored"),
		]);
		await refresh();
		expect(session.model).toBe(model);
		await session.prompt("custom key route");
		expect(requests.at(-1)?.model).toBe(model);
		login();
		await refresh();
		await session.prompt("subscription route");
		expect(requests.at(-1)?.model.baseUrl).toBe("https://api.x.ai/v1");
		writer.logout("xai");
		await refresh();
		expect(session.model).toBe(model);
		expect(session.scopedModels[0]?.model).toBe(model);
		await session.prompt("restore custom route");
		expect(requests.at(-1)?.model).toBe(model);
	});

	test("restores a persisted subscription session using current API-key model metadata", async () => {
		const { harness, session, writer, requests, login, refresh, installTransports } = await setup({ persist: true });
		harness.setResponses([fauxAssistantMessage("persisted"), fauxAssistantMessage("resumed")]);
		login();
		await refresh();
		await session.prompt("save subscription conversation");
		const file = session.sessionManager.getSessionFile()!;
		session.sessionManager.flushNow();
		writer.logout("xai");
		const storage = AuthStorage.create(join(harness.tempDir, "auth.json"));
		const registry = ModelRegistry.inMemory(storage);
		const { session: resumed } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: storage,
			modelRegistry: registry,
			settingsManager: harness.settingsManager,
			sessionManager: SessionManager.open(file),
			resourceLoader: createTestResourceLoader(),
			tools: [],
			noTools: "all",
		});
		sessions.push(resumed);
		installTransports();
		expect(resumed.model).toMatchObject({ provider: "xai", id: "grok-4.5", api: "openai-completions" });
		await resumed.prompt("continue with current key");
		expect(requests.at(-1)).toMatchObject({ key: "environment-key", model: { api: "openai-completions" } });
	});

	test("rejects final per-request conflicting Authorization before SDK dispatch", async () => {
		const { session, requests, login, refresh } = await setup();
		login();
		await refresh();
		await expect(
			session.agent.streamFn(session.model!, { messages: [] }, { headers: { authorization: "conflicting-secret" } }),
		).rejects.toThrow("Remove the header");
		expect(requests).toHaveLength(0);
	});

	test("makes no provider request when OAuth refresh fails even if XAI_API_KEY is set", async () => {
		const { harness, session, requests, login, refresh } = await setup();
		harness.setResponses([fauxAssistantMessage("must not be sent")]);
		login(Date.now() - 1000);
		await refresh();
		vi.spyOn(xaiOAuthProvider, "refreshToken").mockRejectedValue(new Error("revoked"));
		await session.prompt("do not silently charge API key");
		expect(requests).toHaveLength(0);
		expect(session.state.errorMessage).toContain("/login xai");
	});
});
