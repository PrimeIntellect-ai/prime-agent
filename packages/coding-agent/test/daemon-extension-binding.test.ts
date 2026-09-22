import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";

import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.js";

import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

describe("daemon extension binding", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-daemon-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-daemon", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
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
					model: faux.getModel(),
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

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return runtime;
	}

	it("strips the duplicated partial message from broadcast message_update events", async () => {
		const runtime = await createRuntimeForTest(() => {}, ["streamed reply"]);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-slim",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-slim",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("hello");

		const updates = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "session_event" }> =>
				message.type === "session_event" && message.event.type === "message_update",
		);
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.event).toHaveProperty("message");
			expect(update.event).toHaveProperty("assistantMessageEvent");
			expect((update.event as { assistantMessageEvent: object }).assistantMessageEvent).not.toHaveProperty(
				"partial",
			);
		}
	});
});
