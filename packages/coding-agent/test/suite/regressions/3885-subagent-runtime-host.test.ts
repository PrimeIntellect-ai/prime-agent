import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import {
	acquireSessionLease,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
} from "../../../src/core/session-lease.js";
import { SessionManager } from "../../../src/core/session-manager.js";

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(10);
	}
}

describe("ENG-3885 subagent runtime host", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		vi.unstubAllEnvs();
	});

	it("creates explicitly modeled RLM children as tracked AgentSessionRuntime instances", async () => {
		const tempDir = join(tmpdir(), `pi-3885-subagent-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		vi.stubEnv(SESSION_LEASES_ENABLED_ENV, "1");
		vi.stubEnv(SESSION_LEASE_OWNER_ID_ENV, "test-parent");

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-parent", reasoning: true },
				{ id: "faux-child", reasoning: false },
			],
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
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
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
			sessionOptions,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: sessionOptions?.model ?? faux.getModel(),
					thinkingLevel: sessionOptions?.thinkingLevel ?? "off",
					scopedModels: sessionOptions?.scopedModels,
					initialActiveToolNames: sessionOptions?.initialActiveToolNames,
					allowedToolNames: sessionOptions?.allowedToolNames,
					customTools: sessionOptions?.customTools,
					includeGoals: sessionOptions?.includeGoals,
					rlmDepth: sessionOptions?.rlmDepth,
					rlmMaxDepth: sessionOptions?.rlmMaxDepth,
					rlmSessionDir: sessionOptions?.rlmSessionDir,
					rlmParentNodeId: sessionOptions?.rlmParentNodeId,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		let childModelId: string | undefined;
		faux.setResponses([
			async (_context, _options, _state, model) => {
				childStarted = true;
				childModelId = model.id;
				await release;
				return fauxAssistantMessage(`child answer from ${model.id}`);
			},
		]);

		const resultPromise = runtime.session.runRlmChild("inspect child runtime", {
			model: `${faux.getModel("faux-child")!.provider}/faux-child`,
		});

		await waitFor(() => childStarted && runtime.listSubagentRuntimes().length === 1);
		const [childRuntime] = runtime.listSubagentRuntimes();
		expect(childRuntime).toBeInstanceOf(AgentSessionRuntime);
		expect(childRuntime?.session.sessionId).not.toBe(runtime.session.sessionId);
		expect(childRuntime?.session.model?.id).toBe("faux-child");
		expect(childRuntime?.metadata).toEqual(
			expect.objectContaining({
				kind: "subagent",
				parentSessionId: runtime.session.sessionId,
				prompt: "inspect child runtime",
			}),
		);
		expect(childModelId).toBe("faux-child");

		releaseChild();
		const result = await resultPromise;
		await waitFor(() => childRuntime?.session.getLastAssistantText() === "child answer from faux-child");

		expect(result.rlm_child_id).toBe(childRuntime?.metadata.rlmChildId);
		expect(result.session_dir).not.toBeNull();
		const childSessions = await SessionManager.list(tempDir, result.session_dir!);
		expect(childSessions.some((session) => session.parentSessionPath === runtime.session.sessionFile)).toBe(true);
		expect(() => acquireSessionLease(childSessions[0]!.path, tempDir)).toThrow(SessionAlreadyActiveError);
		await runtime.dispose();
		const retainedChildLease = acquireSessionLease(childSessions[0]!.path, tempDir);
		retainedChildLease?.release();
		expect(runtime.listSubagentRuntimes()).toEqual([]);
	});

	it("preserves initial model and thinking entries for inline RLM children", async () => {
		const tempDir = join(tmpdir(), `pi-3885-inline-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-parent", reasoning: true },
				{ id: "faux-child", reasoning: false },
			],
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
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
		});
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			model: faux.getModel("faux-child"),
			thinkingLevel: "off",
		});
		await session.bindExtensions({});

		cleanups.push(async () => {
			session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		faux.setResponses([fauxAssistantMessage("inline child answer")]);

		const result = await session.runRlmChild("inspect inline child persistence");
		expect(result.session_dir).not.toBeNull();
		const childSessions = await SessionManager.list(tempDir, result.session_dir!);
		expect(childSessions).toHaveLength(1);
		const childSessionFile = childSessions[0]!.path;
		const childSession = SessionManager.open(childSessionFile, result.session_dir!);
		const childContext = childSession.buildSessionContext();

		expect(childContext.model).toEqual({
			provider: faux.getModel("faux-child")!.provider,
			modelId: "faux-child",
		});
		expect(childContext.thinkingLevel).toBe("off");
	});
});
