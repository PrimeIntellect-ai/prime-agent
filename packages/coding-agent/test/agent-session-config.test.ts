import { describe, expect, it } from "vitest";
import {
	type AgentSessionRuntimeConfig,
	durableAgentSessionRuntimeConfig,
	mergeAgentSessionRuntimeConfig,
} from "../src/core/agent-session-config.js";

describe("agent session runtime config persistence", () => {
	it("keeps the daemon telemetry opt-out monotonic across config merges", () => {
		expect(mergeAgentSessionRuntimeConfig({ telemetryDisabled: true }, {}).telemetryDisabled).toBe(true);
		expect(mergeAgentSessionRuntimeConfig({}, { telemetryDisabled: true }).telemetryDisabled).toBe(true);
		expect(mergeAgentSessionRuntimeConfig({}, {}).telemetryDisabled).toBeUndefined();
	});

	it("persists only typed daemon host settings", () => {
		const durable = durableAgentSessionRuntimeConfig({
			cwd: "/repo",
			agentDir: "/agent",
			sessionDir: "/sessions",
			telemetryDisabled: true,
			provider: "intercept",
			model: "openai/example",
			apiKey: "secret-api-key",
			extensionFlagValues: { providerSecretKey: "secret-extension-key" },
			initialGoal: { objective: "transient" },
		});

		expect(durable).toEqual({
			cwd: "/repo",
			agentDir: "/agent",
			sessionDir: "/sessions",
			telemetryDisabled: true,
		});
	});

	it("drops daemon host settings with the wrong runtime type", () => {
		expect(
			durableAgentSessionRuntimeConfig({
				cwd: 1,
				agentDir: "/agent",
				sessionDir: false,
				telemetryDisabled: "yes",
			} as unknown as AgentSessionRuntimeConfig),
		).toEqual({ agentDir: "/agent" });
	});
});
