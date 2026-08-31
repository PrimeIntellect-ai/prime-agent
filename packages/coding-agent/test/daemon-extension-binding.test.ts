import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.js";
import { createAgentConnectionState } from "../src/modes/agent-connection/snapshot.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

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

	it("keeps extension replacement callbacks daemon-side and rebinds before withSession", async () => {
		const phases: string[] = [];
		let oldSessionFile: string | undefined;
		let replacementSessionFile: string | undefined;

		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("daemon-replace", {
					description: "daemon replace",
					handler: async (_args, ctx) => {
						phases.push("command");
						oldSessionFile = ctx.sessionManager.getSessionFile();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								phases.push("withSession");
								replacementSessionFile = replacedCtx.sessionManager.getSessionFile();
								await replacedCtx.sendUserMessage("daemon replacement message");
							},
						});
					},
				});
			},
			["replacement reply"],
		);

		const outbound: DaemonOutbound[] = [];
		const heartbeat: AgentCronJob = {
			id: "heartbeat-1",
			status: "active",
			source: "heartbeat",
			activeSessionId: "active-test",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			prompt: "check status",
			schedule: { kind: "interval", expression: "every 10s", intervalMs: 10_000 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			nextRunAt: "2026-01-01T00:00:10.000Z",
			runCount: 0,
		};
		const state: ActiveSessionState = {
			activeSessionId: "active-test",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-test",
			lastEventSequence: 0,
			summaryState: { summary: "old recap", taskState: "completed", basedOnMessageCount: 2 },
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
				if (message.type === "session_replaced") {
					phases.push("broadcast:session_replaced");
				}
			},
			createConnectionState: (targetState) => {
				const connectionState = createAgentConnectionState(targetState.runtime, targetState.activeSessionId);
				if (targetState.summaryState?.summary) {
					connectionState.recap = targetState.summaryState.summary;
				}
				connectionState.heartbeat = heartbeat;
				return connectionState;
			},
			sessionReplaced: (targetState) => {
				phases.push("sessionReplaced");
				targetState.summaryState = undefined;
			},
			shutdown: () => {
				phases.push("shutdown");
			},
		});

		await runtime.session.prompt("/daemon-replace");

		const replacementIndex = phases.indexOf("broadcast:session_replaced");
		const withSessionIndex = phases.indexOf("withSession");
		expect(replacementIndex).toBeGreaterThan(-1);
		expect(withSessionIndex).toBeGreaterThan(-1);
		expect(phases.indexOf("sessionReplaced")).toBeLessThan(replacementIndex);
		expect(replacementIndex).toBeLessThan(withSessionIndex);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(outbound).toContainEqual(
			expect.objectContaining({
				type: "session_replaced",
				activeSessionId: "active-test",
				state: expect.objectContaining({
					heartbeat: expect.objectContaining({ id: "heartbeat-1" }),
				}),
			}),
		);
		const replaced = outbound.find(
			(message): message is Extract<DaemonOutbound, { type: "session_replaced" }> =>
				message.type === "session_replaced",
		);
		expect(replaced?.state.recap).toBeUndefined();
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:daemon replacement message",
			"assistant:replacement reply",
		]);
	});
});
