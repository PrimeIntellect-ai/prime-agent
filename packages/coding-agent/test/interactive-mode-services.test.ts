import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import type { SessionManager } from "../src/core/session-manager.js";
import {
	createInteractiveModeUiServices,
	createInteractiveModeUiServicesFromServices,
} from "../src/modes/interactive/interactive-mode-services.js";

describe("InteractiveModeUiServices MCP refresh", () => {
	it("wires local sessions through the narrow session refresh method", () => {
		const refreshMcpProviders = vi.fn();
		const session = {
			settingsManager: {},
			modelRegistry: {},
			sessionManager: { getCwd: () => "/local", getSessionName: () => "local-session" },
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			refreshMcpProviders,
		} as unknown as AgentSession;

		const services = createInteractiveModeUiServices(session);
		services.refreshMcpProviders?.();

		expect(refreshMcpProviders).toHaveBeenCalledOnce();
		expect(services.getInitialCwd()).toBe("/local");
	});

	it("wires daemon-backed services directly to the MCP manager", () => {
		const refresh = vi.fn();
		const services = createInteractiveModeUiServicesFromServices({
			services: {
				settingsManager: {},
				modelRegistry: {},
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				mcpManager: { refresh },
			} as unknown as AgentSessionServices,
			sessionManager: {
				getCwd: () => "/daemon",
				getSessionName: () => "daemon-session",
			} as unknown as SessionManager,
		});

		services.refreshMcpProviders?.();

		expect(refresh).toHaveBeenCalledOnce();
		expect(services.getInitialSessionName()).toBe("daemon-session");
	});
});
