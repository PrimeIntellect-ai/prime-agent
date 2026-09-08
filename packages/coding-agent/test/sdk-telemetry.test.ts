import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { installAgentTelemetry, type TelemetryEventName, type TelemetryProperties } from "../src/core/telemetry.js";
import { createHarness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

afterEach(() => vi.unstubAllEnvs());

it("captures actual SDK request context and dispatch for a normal faux-provider prompt", async () => {
	vi.stubEnv("DO_NOT_TRACK", "0");
	vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
	vi.stubEnv("PI_OFFLINE", "0");
	const harness = await createHarness({ settings: { retry: { enabled: false }, compaction: { enabled: false } } });
	const events: Array<{ name: TelemetryEventName; properties: TelemetryProperties }> = [];
	const { session } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		model: harness.getModel(),
		authStorage: harness.authStorage,
		modelRegistry: harness.session.modelRegistry,
		sessionManager: SessionManager.inMemory(harness.tempDir),
		settingsManager: harness.settingsManager,
		resourceLoader: createTestResourceLoader(),
		noTools: "all",
		prewarmIpythonKernel: false,
	});
	try {
		const auth = vi.spyOn(harness.session.modelRegistry, "getApiKeyAndHeaders");
		installAgentTelemetry(session, {
			agentDir: harness.tempDir,
			settingsManager: harness.settingsManager,
			sink: {
				capture: (name, properties) => {
					events.push({ name, properties });
				},
				flush: async () => {},
			},
		});
		harness.setResponses([fauxAssistantMessage("synthetic private response")]);
		await session.prompt("synthetic private prompt");
		expect(harness.faux.state.callCount).toBe(1);
		expect(auth).toHaveBeenCalledTimes(1);
		expect(events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			context_source: "request",
			auth_source: "runtime_api_key",
			provider_category: "custom",
			endpoint_category: "custom",
			terminal_outcome: "success",
		});
		expect(
			events.filter((event) => event.name === "agent timing" && event.properties.stage === "provider_dispatch"),
		).toHaveLength(1);
		expect(JSON.stringify(events)).not.toMatch(/synthetic private|faux-key/);
	} finally {
		await session.disposeAsync();
		harness.cleanup();
	}
});
