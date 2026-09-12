import { join } from "node:path";
import {
	type Api,
	type ApiStreamSimpleFunction,
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

	async function setup() {
		const harness = await createHarness({
			api: "openai-completions",
			provider: "xai",
			models: [{ id: "grok-4.5" }],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const faux = getApiProvider("openai-completions")!;
		const requests: Array<{ model: Model<Api>; key?: string }> = [];
		const stream: ApiStreamSimpleFunction = (model, context, options) => {
			requests.push({ model, key: options?.apiKey });
			return faux.streamSimple({ ...model, api: "openai-completions" }, context, options);
		};
		const installTransports = () => {
			for (const api of ["openai-completions", "openai-responses"] as const) {
				registerApiProvider({ api, stream, streamSimple: stream });
			}
		};
		const path = join(harness.tempDir, "auth.json");
		const registry = ModelRegistry.inMemory(AuthStorage.create(path));
		const model = {
			...getModel("xai", "grok-4.5"),
			baseUrl: "https://caller.invalid/v2",
			headers: { "X-Caller": "kept" },
		};
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRegistry: registry,
			authStorage: registry.authStorage,
			settingsManager: harness.settingsManager,
			sessionManager: SessionManager.inMemory(),
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
		return { harness, session, registry, writer, model, requests, login, refresh, installTransports };
	}

	test("switches an existing custom API-key session to subscription and back, including compaction", async () => {
		const { harness, session, registry, writer, model, requests, login, refresh, installTransports } = await setup();
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("turn summary"),
			fauxAssistantMessage("restored"),
		]);
		await session.prompt("API key turn");
		expect(requests.at(-1)?.model).toBe(model);
		login();
		registry.refresh();
		installTransports();
		// The active object is still the API-key model: dispatch must resolve the new credential and route together.
		expect(session.model).toBe(model);
		await session.prompt("subscription turn");
		expect(requests.at(-1)).toMatchObject({ key: "subscription-key", model: { api: "openai-responses" } });
		login(Date.now() - 1000);
		await refresh();
		expect(session.model?.api).toBe("openai-responses");
		expect(session.scopedModels[0]?.model.api).toBe("openai-responses");
		vi.spyOn(xaiOAuthProvider, "refreshToken").mockResolvedValue({
			access: "rotated",
			refresh: "rotated-refresh",
			expires: Date.now() + 60_000,
		});
		const beforeCompaction = requests.length;
		await session.compact();
		expect(requests.length).toBeGreaterThan(beforeCompaction);
		for (const request of requests.slice(beforeCompaction)) {
			expect(request).toMatchObject({ key: "rotated", model: { api: "openai-responses" } });
		}
		writer.set("xai", { type: "api_key", key: "saved-key" });
		await refresh();
		expect(session.model).toBe(model);
		expect(session.scopedModels[0]?.model).toBe(model);
		await session.prompt("custom API key turn again");
		expect(requests.at(-1)?.model).toBe(model);
		expect(requests.at(-1)?.key).toBe("saved-key");
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

	test("does not silently use XAI_API_KEY after subscription refresh fails", async () => {
		const { session, requests, login, refresh } = await setup();
		login(Date.now() - 1000);
		await refresh();
		vi.spyOn(xaiOAuthProvider, "refreshToken").mockRejectedValue(new Error("revoked"));
		await session.prompt("do not silently charge API key");
		expect(requests).toHaveLength(0);
		expect(session.state.errorMessage).toContain("/login xai");
	});
});
