import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

describe("daemon custom model switching", () => {
	it("keeps an uncatalogued model id on the current provider", async () => {
		const daemon = new AgentDaemon("/tmp/unused-custom-model.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const base = getModel("openai", "gpt-5.1");
		if (!base) throw new Error("Missing OpenAI test model");
		const currentModel = {
			...base,
			provider: "cline",
			id: "anthropic/claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.cline.bot/api/v1",
		};
		const setModel = vi.fn(async () => {});
		const state = {
			activeSessionId: "active",
			runtime: {
				metadata: { kind: "top-level", createdAt: 1 },
				session: {
					model: currentModel,
					isStreaming: false,
					isCompacting: false,
					modelRegistry: { refreshAvailableModels: async () => [currentModel] },
					setModel,
				},
			},
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
			scheduleRosterFlush(): void;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.scheduleRosterFlush = vi.fn();

		const response = await internals.handleCommand({} as DaemonSocketClient, {
			id: "switch-custom",
			type: "set_model",
			activeSessionId: state.activeSessionId,
			provider: "cline",
			modelId: "z-ai/glm-5.3-flash",
		});

		expect(response).toMatchObject({
			success: true,
			data: { provider: "cline", id: "z-ai/glm-5.3-flash", baseUrl: "https://api.cline.bot/api/v1" },
		});
		expect(setModel).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "cline", id: "z-ai/glm-5.3-flash" }),
			expect.objectContaining({ waitForExtensions: true }),
		);
	});
});
