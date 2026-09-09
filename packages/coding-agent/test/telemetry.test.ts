import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SessionAction } from "../src/core/session-action-store.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	captureAgentCommandUsed,
	captureOnboardingCompleted,
	getOrCreateTelemetryInstallationId,
	getTelemetrySessionContext,
	installAgentTelemetry,
	isTelemetryEnabled,
	TelemetryClient,
	type TelemetryEvent,
	type TelemetryEventName,
	type TelemetrySink,
	telemetryAuthCategory,
} from "../src/core/telemetry.js";
import { observeTelemetryRequestContext } from "../src/core/telemetry-execution-context.js";
import { observeTelemetryAction, observeTelemetryInput } from "../src/core/telemetry-input.js";
import { saveOnboardingTelemetryContext } from "../src/core/telemetry-journey-state.js";

const base = {
	session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	version: "1.2.3",
	os_family: "darwin",
	architecture: "arm64",
	install_method: "npm",
	execution_mode: "interactive",
};

function uuidGenerator(): () => string {
	let counter = 0;
	return () => {
		counter++;
		return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
	};
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "private response" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 50,
			cacheWrite: 0,
			totalTokens: 170,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0,
				total: 0.0031,
			},
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

class FakeTelemetrySink implements TelemetrySink {
	readonly events: Array<{ name: TelemetryEventName; properties: Record<string, string | number | boolean | null> }> =
		[];
	flushCount = 0;

	capture(name: TelemetryEventName, properties: Record<string, string | number | boolean | null>): void {
		this.events.push({ name, properties });
	}

	async flush(): Promise<void> {
		this.flushCount++;
	}
}

class FakeAgentSession {
	model?: {
		id: string;
		provider: string;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	};
	private listener?: (event: AgentSessionEvent) => void;
	private disposeCallback?: () => void | Promise<void>;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	registerDisposeCallback(callback: () => void | Promise<void>): void {
		this.disposeCallback = callback;
	}

	emit(event: AgentSessionEvent): void {
		this.listener?.(event);
	}

	dispose(): void {
		void this.disposeCallback?.();
	}

	async disposeAsync(): Promise<void> {
		await this.disposeCallback?.();
	}
}

function observeModelRequest(session: FakeAgentSession): void {
	const registry = { authStorage: { get: () => undefined } } as unknown as ModelRegistry;
	observeTelemetryRequestContext(session, registry, getModel("openai", "gpt-5"), {
		ok: true,
		authSource: "runtime",
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("telemetry identity and transport", () => {
	beforeEach(() => vi.stubEnv("DO_NOT_TRACK", "0"));
	it("creates a private stable installation ID", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-telemetry-"));
		const randomId = uuidGenerator();

		const first = getOrCreateTelemetryInstallationId(agentDir, randomId);
		const second = getOrCreateTelemetryInstallationId(agentDir, randomId);

		expect(second).toBe(first);
		const path = join(agentDir, "telemetry.json");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			version: 1,
			installationId: first,
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("replaces invalid persisted installation state", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-telemetry-"));
		const path = join(agentDir, "telemetry.json");
		writeFileSync(path, "not-json");
		const randomId = uuidGenerator();

		const installationId = getOrCreateTelemetryInstallationId(agentDir, randomId);

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			version: 1,
			installationId,
		});
		expect(getOrCreateTelemetryInstallationId(agentDir, randomId)).toBe(installationId);
	});

	it("does not follow a telemetry state symlink", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-telemetry-"));
		const targetPath = join(agentDir, "target.json");
		const telemetryPath = join(agentDir, "telemetry.json");
		writeFileSync(targetPath, "do not overwrite");
		symlinkSync(targetPath, telemetryPath);
		const client = new TelemetryClient({ agentDir, randomId: uuidGenerator() });

		expect(() => client.capture("agent started", base)).not.toThrow();
		await expect(client.flush()).resolves.toBeUndefined();

		expect(readFileSync(targetPath, "utf8")).toBe("do not overwrite");
		expect(lstatSync(telemetryPath).isSymbolicLink()).toBe(true);
	});

	it("batches events through the configured Prime endpoint", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-telemetry-"));
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock: typeof fetch = async (input, init) => {
			if (init?.method === "GET") return new Response(null, { status: 404 });
			requests.push({ url: String(input), init: init ?? {} });
			return new Response(null, { status: 204 });
		};
		const client = new TelemetryClient({
			agentDir,
			endpoint: "https://api.example.test/api/v1/agent-analytics/events",
			fetch: fetchMock,
			randomId: uuidGenerator(),
			now: () => Date.UTC(2026, 6, 23),
		});

		client.capture("agent started", base);
		await client.flush();

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://api.example.test/api/v1/agent-analytics/events");
		const body = JSON.parse(String(requests[0].init.body)) as {
			installation_id: string;
			events: TelemetryEvent[];
		};
		expect(body.installation_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.events).toEqual([
			expect.objectContaining({
				name: "agent started",
				timestamp: "2026-07-23T00:00:00.000Z",
				properties: base,
			}),
		]);
	});

	it("never throws when the analytics endpoint fails", async () => {
		const client = new TelemetryClient({
			agentDir: mkdtempSync(join(tmpdir(), "prime-agent-telemetry-")),
			fetch: async () => {
				throw new Error("network failed");
			},
			randomId: uuidGenerator(),
		});

		client.capture("agent started", base);
		await expect(client.flush()).resolves.toBeUndefined();
	});

	it("drains every queued batch before flush resolves", async () => {
		const batchSizes: number[] = [];
		const client = new TelemetryClient({
			agentDir: mkdtempSync(join(tmpdir(), "prime-agent-telemetry-")),
			fetch: async (_input, init) => {
				if (init?.method === "GET") return new Response(null, { status: 404 });
				const body = JSON.parse(String(init?.body)) as { events: TelemetryEvent[] };
				batchSizes.push(body.events.length);
				return new Response(null, { status: 204 });
			},
			randomId: uuidGenerator(),
			batchSize: 2,
		});

		for (let index = 0; index < 5; index++) {
			client.capture("agent started", { ...base, index });
		}
		await client.flush();

		expect(batchSizes.reduce((total, size) => total + size, 0)).toBe(5);
		expect(batchSizes.every((size) => size <= 2)).toBe(true);
	});

	it("never throws when the local telemetry state cannot be written", async () => {
		const parent = mkdtempSync(join(tmpdir(), "prime-agent-telemetry-"));
		const agentDir = join(parent, "not-a-directory");
		writeFileSync(agentDir, "occupied");
		const client = new TelemetryClient({ agentDir, randomId: uuidGenerator() });

		expect(() => client.capture("agent started", base)).not.toThrow();
		await expect(client.flush()).resolves.toBeUndefined();
	});
});

describe("telemetry controls", () => {
	it("is enabled by default without an override", () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
		expect(isTelemetryEnabled(SettingsManager.inMemory())).toBe(true);
	});
	it("honors settings and environment opt-outs", () => {
		const settings = SettingsManager.inMemory({ telemetry: { enabled: true } });

		vi.stubEnv("DO_NOT_TRACK", "0");
		expect(isTelemetryEnabled(settings)).toBe(true);

		vi.stubEnv("DO_NOT_TRACK", "1");
		expect(isTelemetryEnabled(settings)).toBe(false);

		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "0");
		expect(isTelemetryEnabled(settings)).toBe(false);

		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		vi.stubEnv("PI_OFFLINE", "true");
		expect(isTelemetryEnabled(settings)).toBe(false);
	});

	it("normalizes malformed telemetry settings before updating them", async () => {
		const settings = SettingsManager.inMemory({ telemetry: true as never });
		const disabledSettings = SettingsManager.inMemory({ telemetry: false as never });

		expect(disabledSettings.getTelemetryEnabled()).toBe(false);
		expect(() => settings.setTelemetryNoticeShown(true)).not.toThrow();
		expect(() => settings.setTelemetryEnabled(false)).not.toThrow();
		await settings.flush();

		expect(settings.getGlobalSettings().telemetry).toEqual({
			noticeShown: true,
			enabled: false,
		});
	});
});

describe("agent telemetry aggregation", () => {
	beforeEach(() => {
		vi.stubEnv("DO_NOT_TRACK", "0");
	});

	it.each(["interactive", "rpc", "print", "unknown"] as const)(
		"does not infer workload origin from %s execution",
		(executionMode) => {
			vi.stubEnv("PRIME_AGENT_TELEMETRY_ORIGIN", "");
			const sink = new FakeTelemetrySink();
			installAgentTelemetry(new FakeAgentSession() as unknown as AgentSession, {
				agentDir: "/not-used",
				settingsManager: SettingsManager.inMemory(),
				...(executionMode === "unknown" ? {} : { executionMode }),
				sink,
			});
			expect(sink.events.find((event) => event.name === "agent started")?.properties).toMatchObject({
				execution_mode: executionMode,
				workload_origin: "unknown",
			});
		},
	);
	it.each([
		["internal", "internal"],
		["test", "test"],
		["private-workload-name", "unknown"],
	])("reports only an explicitly approved origin for %s", (origin, expectedOrigin) => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY_ORIGIN", origin);
		const sink = new FakeTelemetrySink();
		installAgentTelemetry(new FakeAgentSession() as unknown as AgentSession, {
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			executionMode: "interactive",
			sink,
		});
		expect(sink.events.find((event) => event.name === "agent started")?.properties.workload_origin).toBe(
			expectedOrigin,
		);
		expect(JSON.stringify(sink.events)).not.toContain("private-workload-name");
	});

	it("captures only allowlisted built-in command names", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const sink = new FakeTelemetrySink();

		await captureAgentCommandUsed({
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			commandName: "model",
			sink,
		});
		await captureAgentCommandUsed({
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			commandName: "private-extension-command",
			sink,
		});

		expect(sink.events).toContainEqual({
			name: "agent command used",
			properties: expect.objectContaining({
				execution_mode: "interactive",
				command_name: "model",
			}),
		});
		expect(sink.events).toHaveLength(1);
	});

	it("captures onboarding completion with categorized auth and provider data", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const sink = new FakeTelemetrySink();

		await captureOnboardingCompleted({
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			durationMs: 250,
			outcome: "success",
			provider: "prime",
			authSource: "stored",
			storedCredentialType: "oauth",
			sink,
		});

		expect(sink.events).toContainEqual({
			name: "onboarding completed",
			properties: expect.objectContaining({
				execution_mode: "interactive",
				duration_ms: 250,
				outcome: "success",
				auth_category: "oauth",
				provider_category: "prime",
			}),
		});
		expect(sink.flushCount).toBe(1);
		expect(telemetryAuthCategory("models_json_command")).toBe("models_json");
	});

	it("emits aggregate metrics without message or tool content", () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		let timestamp = 1_000;
		const now = () => timestamp;
		const randomId = uuidGenerator();
		const sink = new FakeTelemetrySink();
		const fakeSession = new FakeAgentSession();

		installAgentTelemetry(fakeSession as unknown as AgentSession, {
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			executionMode: "interactive",
			sink,
			now,
			randomId,
		});

		const assistant = assistantMessage();
		fakeSession.emit({
			type: "session_action_update",
			actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } },
		});
		fakeSession.emit({ type: "agent_start" });
		fakeSession.emit({
			type: "message_start",
			message: {
				role: "user",
				content: "private prompt",
				timestamp,
			},
		});
		timestamp = 1_010;
		fakeSession.emit({ type: "turn_start" });
		timestamp = 1_035;
		fakeSession.emit({
			type: "message_update",
			message: assistant,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "private streamed text",
				partial: assistant,
			},
		});
		timestamp = 1_050;
		fakeSession.emit({
			type: "tool_execution_end",
			toolCallId: "private-tool-id",
			toolName: "bash",
			result: { private: "tool output" },
			isError: false,
		});
		timestamp = 1_100;
		fakeSession.emit({ type: "message_end", message: assistant });
		fakeSession.emit({ type: "turn_end", message: assistant, toolResults: [] });
		timestamp = 1_125;
		fakeSession.emit({ type: "agent_end", messages: [assistant] });
		fakeSession.emit({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });

		const run = sink.events.find((event) => event.name === "agent run completed");
		expect(run?.properties).toMatchObject({
			execution_mode: "interactive",
			outcome: "success",
			duration_ms: 125,
			visible_ttft_ms: 25,
			first_model_event_ms: 25,
			model_latency_ms: 90,
			turn_count: 1,
			tool_call_count: 1,
			tool_error_count: 0,
			input_tokens: 100,
			output_tokens: 20,
			cache_read_tokens: 50,
			total_tokens: 170,
			retry_count: 0,
			provider_category: "openai",
			model_category: "gpt",
		});
		expect(JSON.stringify(run)).not.toContain("private");

		timestamp = 1_200;
		fakeSession.dispose();
		const ended = sink.events.find((event) => event.name === "agent session ended");
		expect(ended?.properties).toMatchObject({
			duration_ms: 200,
			prompt_count: 1,
			run_count: 1,
			successful_run_count: 1,
			total_tokens: 170,
		});
		expect(sink.flushCount).toBe(1);
	});

	it("waits for post-run compaction before finalizing run metrics", () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const sink = new FakeTelemetrySink();
		const fakeSession = new FakeAgentSession();

		installAgentTelemetry(fakeSession as unknown as AgentSession, {
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			sink,
		});

		const assistant = assistantMessage();
		fakeSession.emit({
			type: "session_action_update",
			actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } },
		});
		fakeSession.emit({ type: "agent_start" });
		fakeSession.emit({ type: "message_end", message: assistant });
		fakeSession.emit({ type: "agent_end", messages: [assistant] });
		expect(sink.events.find((event) => event.name === "agent run completed")).toBeUndefined();

		fakeSession.emit({
			type: "compaction_end",
			reason: "threshold",
			result: { summary: "private", firstKeptEntryId: "private", tokensBefore: 100 },
			aborted: false,
			willRetry: false,
		});
		fakeSession.emit({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });

		expect(sink.events.find((event) => event.name === "agent run completed")?.properties.compaction_count).toBe(1);
	});

	it("keeps automatic retries in one completed run", () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const sink = new FakeTelemetrySink();
		const fakeSession = new FakeAgentSession();

		installAgentTelemetry(fakeSession as unknown as AgentSession, {
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			sink,
		});

		const failed = assistantMessage({ stopReason: "error", errorMessage: "rate limit" });
		const succeeded = assistantMessage();
		fakeSession.emit({
			type: "session_action_update",
			actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } },
		});
		fakeSession.emit({ type: "agent_start" });
		fakeSession.emit({ type: "message_end", message: failed });
		fakeSession.emit({ type: "agent_end", messages: [failed] });
		fakeSession.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "rate limit",
		});
		fakeSession.emit({ type: "agent_start" });
		fakeSession.emit({ type: "message_end", message: succeeded });
		fakeSession.emit({ type: "agent_end", messages: [succeeded] });
		fakeSession.emit({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });

		const runs = sink.events.filter((event) => event.name === "agent run completed");
		expect(runs).toHaveLength(1);
		expect(runs[0].properties).toMatchObject({ outcome: "success", retry_count: 1, model_call_count: 2 });
	});

	it("awaits the final telemetry flush during async session disposal", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const sink = new FakeTelemetrySink();
		const fakeSession = new FakeAgentSession();
		let releaseFlush: () => void = () => {};
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		let flushStarted = false;
		vi.spyOn(sink, "flush").mockImplementation(async () => {
			flushStarted = true;
			await flushGate;
		});

		installAgentTelemetry(fakeSession as unknown as AgentSession, {
			agentDir: "/not-used",
			settingsManager: SettingsManager.inMemory(),
			sink,
		});

		let disposed = false;
		const disposal = fakeSession.disposeAsync().then(() => {
			disposed = true;
		});
		await vi.waitFor(() => expect(flushStarted).toBe(true));
		expect(disposed).toBe(false);
		releaseFlush();
		await disposal;
		expect(disposed).toBe(true);
	});
});

describe("run lifecycle observations", () => {
	beforeEach(() => vi.stubEnv("DO_NOT_TRACK", "0"));
	function setup(settingsManager = SettingsManager.inMemory()) {
		let time = 0;
		const sink = new FakeTelemetrySink();
		const session = new FakeAgentSession();
		const agentDir = mkdtempSync(join(tmpdir(), "telemetry-runs-"));
		const options = {
			agentDir,
			settingsManager,
			sink,
			now: () => time,
			randomId: uuidGenerator(),
		};
		installAgentTelemetry(session as unknown as AgentSession, options);
		return {
			sink,
			session,
			options,
			advance: (value: number) => {
				time += value;
			},
		};
	}
	it("begins fresh observations when a session starts opted out and is later enabled", async () => {
		const { session, options, sink } = setup(SettingsManager.inMemory({ telemetry: { enabled: false } }));
		expect(getTelemetrySessionContext(session as unknown as AgentSession)).toBeUndefined();
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		expect(sink.events).toEqual([]);
		options.settingsManager.setTelemetryEnabled(true);
		session.emit({ type: "agent_end", messages: [] });
		expect(sink.events.filter((event) => event.name === "agent run completed")).toHaveLength(0);
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		await session.disposeAsync();
		expect(sink.events.filter((event) => event.name === "agent started")).toHaveLength(1);
		expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			run_index: 1,
			model_call_count: 1,
		});
	});
	it.each(["failed", "cancelled"] as const)(
		"keeps an outer action %s after a successful assistant turn",
		async (state) => {
			const { session, sink } = setup();
			const inputId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
			const action: SessionAction = {
				id: "local-action",
				source: "interactive",
				delivery: "when_run_idle",
				wake: "immediate",
				payload: { kind: "turn", records: [], text: "private prompt" },
				lifecycle: { state: "queued" },
			};
			await observeTelemetryInput(session, { inputId }, async () => {
				observeTelemetryAction(session, action);
				action.lifecycle = { state: "committing" };
				observeTelemetryAction(session, action, "preparing");
				session.emit({
					type: "session_action_update",
					actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } },
				});
				session.emit({ type: "agent_start" });
				session.emit({ type: "turn_start" });
				observeModelRequest(session);
				session.emit({ type: "message_end", message: assistantMessage() });
				session.emit({ type: "agent_end", messages: [] });
				action.lifecycle =
					state === "failed" ? { state, error: new Error("Session persistence failed") } : { state };
				observeTelemetryAction(session, action, "running");
				session.emit({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
			});
			expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
				input_id: inputId,
				terminal_outcome: state === "failed" ? "error" : "cancelled",
				successful_model_call_count: 1,
			});
			expect(
				sink.events
					.filter((event) => event.name === "agent error")
					.some((event) => event.properties.recovery_outcome === "success"),
			).toBe(false);
		},
	);
	it.each(["stop", "length", "toolUse", "error", "aborted"] as const)(
		"counts observed successful inference separately for %s responses",
		(stopReason) => {
			const { session, sink } = setup();
			session.emit({ type: "agent_start" });
			session.emit({ type: "turn_start" });
			observeModelRequest(session);
			session.emit({ type: "message_end", message: assistantMessage({ stopReason }) });
			session.emit({ type: "agent_end", messages: [] });
			expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
				successful_model_call_count: ["stop", "length", "toolUse"].includes(stopReason) ? 1 : 0,
			});
		},
	);
	it("consumes each request observation without counting later synthetic assistant messages", () => {
		const { session, sink } = setup();
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "turn_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "turn_start" });
		observeModelRequest(session);
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "turn_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		expect(
			sink.events.find((event) => event.name === "agent run completed")?.properties.successful_model_call_count,
		).toBe(1);
	});
	it("does not infer successful model access from a run without a model call", () => {
		const { session, sink } = setup();
		session.emit({ type: "agent_start" });
		session.emit({ type: "agent_end", messages: [] });
		expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			model_call_count: 0,
			successful_model_call_count: 0,
			terminal_outcome: "unknown",
		});
	});
	it("installs one observer and pairs one run terminal with its start", async () => {
		const { sink, session, options } = setup();
		installAgentTelemetry(session as unknown as AgentSession, options);
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		session.emit({ type: "agent_end", messages: [] });
		await session.disposeAsync();
		await session.disposeAsync();
		const starts = sink.events.filter((event) => event.name === "agent run started");
		const ends = sink.events.filter((event) => event.name === "agent run completed");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(ends[0].properties).toMatchObject({
			run_id: starts[0].properties.run_id,
			run_index: 1,
			terminal_outcome: "success",
		});
		expect(sink.events.filter((event) => event.name === "agent session ended")).toHaveLength(1);
	});
	it.each(["success", "error", "cancelled"] as const)(
		"measures standalone compaction %s without creating a run",
		(outcome) => {
			const { sink, session, advance } = setup();
			session.emit({ type: "compaction_start", reason: "manual", customInstructions: "private instructions" });
			advance(75);
			session.emit({
				type: "compaction_end",
				reason: "manual",
				result:
					outcome === "success"
						? { summary: "private summary", firstKeptEntryId: "private-entry", tokensBefore: 100 }
						: undefined,
				aborted: outcome === "cancelled",
				willRetry: false,
				...(outcome === "error" ? { errorMessage: "Compaction failed" } : {}),
			});
			const timing = sink.events.find((event) => event.name === "agent timing");
			expect(timing?.properties).toMatchObject({
				stage: "compaction",
				timing_origin: "worker_action",
				duration_ms: 75,
				outcome,
				session_id: expect.any(String),
			});
			expect(timing?.properties).not.toHaveProperty("run_id");
			expect(sink.events.some((event) => event.name === "agent run started")).toBe(false);
			for (const content of ["private instructions", "private summary", "private-entry"])
				expect(JSON.stringify(sink.events)).not.toContain(content);
		},
	);
	it("does not attach an earlier standalone compaction to a later run", () => {
		const { sink, session, advance } = setup();
		session.emit({ type: "compaction_start", reason: "threshold" });
		advance(10);
		session.emit({ type: "agent_start" });
		advance(15);
		session.emit({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false, result: undefined });
		const timing = sink.events.find(
			(event) => event.name === "agent timing" && event.properties.stage === "compaction",
		);
		expect(timing?.properties).toMatchObject({ timing_origin: "worker_action", duration_ms: 25 });
		expect(timing?.properties).not.toHaveProperty("run_id");
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			compaction_count: 0,
			compaction_duration_ms: 0,
		});
	});
	it("records interrupted standalone compaction time during controlled shutdown", async () => {
		const { sink, session, advance } = setup();
		session.emit({ type: "compaction_start", reason: "threshold" });
		advance(40);
		await session.disposeAsync();
		expect(sink.events.find((event) => event.name === "agent timing")?.properties).toMatchObject({
			stage: "compaction",
			timing_origin: "worker_action",
			duration_ms: 40,
			outcome: "shutdown_interrupted",
		});
		expect(sink.events.find((event) => event.name === "agent session ended")?.properties.terminal_outcome).toBe(
			"shutdown_interrupted",
		);
	});
	it("does not replay standalone compaction timing after consent is withdrawn", () => {
		const { sink, session, options, advance } = setup();
		session.emit({ type: "compaction_start", reason: "manual" });
		advance(10);
		options.settingsManager.setTelemetryEnabled(false);
		options.settingsManager.setTelemetryEnabled(true);
		session.emit({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: undefined });
		expect(sink.events.some((event) => event.name === "agent timing")).toBe(false);
		session.emit({ type: "compaction_start", reason: "manual" });
		advance(15);
		session.emit({ type: "compaction_end", reason: "manual", aborted: true, willRetry: false, result: undefined });
		expect(sink.events.find((event) => event.name === "agent timing")?.properties.duration_ms).toBe(15);
	});
	it("keeps missing completion distinct from a crash or a successful earlier turn", async () => {
		const { sink, session } = setup();
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage({ stopReason: "toolUse" }) });
		await session.disposeAsync();
		expect(sink.events.find((event) => event.name === "agent run completed")?.properties.terminal_outcome).toBe(
			"shutdown_interrupted",
		);
		const unknown = setup();
		unknown.session.emit({ type: "agent_start" });
		unknown.session.emit({ type: "agent_end", messages: [] });
		expect(
			unknown.sink.events.find((event) => event.name === "agent run completed")?.properties.terminal_outcome,
		).toBe("unknown");
	});
	it("preserves a provider failure after retry cancellation without treating cancellation as another failure", () => {
		const { sink, session, advance } = setup();
		session.emit({
			type: "session_action_update",
			actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } },
		});
		session.emit({ type: "agent_start" });
		session.emit({
			type: "message_end",
			message: assistantMessage({
				stopReason: "error",
				errorMessage: "Provider server error",
				diagnostics: [{ type: "provider_stream_failure", timestamp: 0, details: { status: 503 } }],
			}),
		});
		session.emit({ type: "agent_end", messages: [] });
		session.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "Provider server error",
		});
		advance(40);
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage({ stopReason: "aborted" }) });
		session.emit({ type: "agent_end", messages: [] });
		session.emit({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
		const errors = sink.events.filter((event) => event.name === "agent error");
		expect(new Set(errors.map((event) => event.properties.error_id)).size).toBe(1);
		expect(errors.at(-1)?.properties).toMatchObject({
			error_subtype: "provider_unavailable",
			recovery_outcome: "cancelled",
		});
		expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			terminal_outcome: "cancelled",
			retry_wait_ms: 40,
		});
		expect(JSON.stringify(sink.events)).not.toContain("private tool output");
		expect(JSON.stringify(sink.events)).not.toContain("private.custom");
		expect(errors[0].properties).toMatchObject({
			error_message: "Provider server error",
			error_message_id: "provider_server_error",
		});
		expect(
			sink.events.find((event) => event.name === "agent timing" && event.properties.stage === "time_to_error")
				?.properties.provider_category,
		).toBe("openai");
		expect(JSON.stringify(sink.events.filter((event) => event.name !== "agent error"))).not.toContain(
			"Provider server error",
		);
	});
	it("keeps cancellation during retry backoff separate from the preceding error", () => {
		const { sink, session, advance } = setup();
		session.emit({
			type: "session_action_update",
			actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } },
		});
		session.emit({ type: "agent_start" });
		session.emit({
			type: "message_end",
			message: assistantMessage({ stopReason: "error", errorMessage: "rate limit" }),
		});
		session.emit({ type: "agent_end", messages: [] });
		session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "rate limit" });
		advance(25);
		session.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
		session.emit({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
		expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			terminal_outcome: "cancelled",
			retry_wait_ms: 25,
		});
		expect(sink.events.filter((event) => event.name === "agent error").at(-1)?.properties).toMatchObject({
			recovery_outcome: "cancelled",
			retry_backoff_ms: 100,
		});
	});
	it("discards in-progress aggregates when telemetry toggles off and on between events", async () => {
		const { sink, session, options } = setup();
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		options.settingsManager.setTelemetryEnabled(false);
		options.settingsManager.setTelemetryEnabled(true);
		session.emit({ type: "agent_end", messages: [] });
		await session.disposeAsync();
		expect(sink.events.filter((event) => event.name === "agent run completed")).toHaveLength(0);
		expect(sink.events.find((event) => event.name === "agent session ended")?.properties).toMatchObject({
			run_count: 0,
			total_tokens: 0,
		});
	});
	it("honors an environment opt-out at disposal before inspecting retained error details", async () => {
		const { sink, session } = setup();
		const message = vi.fn(() => "Original provider failure");
		const failed = Object.defineProperty(assistantMessage({ stopReason: "error" }), "errorMessage", { get: message });
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: failed });
		const inspections = message.mock.calls.length;
		vi.stubEnv("DO_NOT_TRACK", "1");
		await session.disposeAsync();
		expect(message).toHaveBeenCalledTimes(inspections);
		expect(sink.events.filter((event) => event.name === "agent run completed")).toHaveLength(0);
		expect(getTelemetrySessionContext(session as unknown as AgentSession)).toBeUndefined();
	});

	it("reports missing tool timing and unknown pricing as null, not zero", () => {
		const { sink, session } = setup();
		session.emit({ type: "agent_start" });
		session.emit({
			type: "tool_execution_end",
			toolCallId: "private",
			toolName: "private.custom",
			isError: true,
			result: { content: [{ type: "text", text: "private tool output" }] },
		});
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		expect(sink.events.find((event) => event.name === "agent tool summary")?.properties).toMatchObject({
			tool_category: "custom",
			call_count: 1,
			failure_count: 1,
			duration_ms: null,
		});
		expect(sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			tool_duration_ms: null,
			estimated_cost_usd: null,
			first_reasoning_ms: null,
			run_to_first_text_ms: null,
		});
		expect(JSON.stringify(sink.events)).not.toContain("private tool output");
		expect(JSON.stringify(sink.events)).not.toContain("private.custom");
		expect(JSON.stringify(sink.events)).not.toContain("private provider output");
	});
	it("links same-tool later success to its errors without resolving another tool or coupling provider retries", () => {
		const { sink, session } = setup();
		session.emit({
			type: "session_action_update",
			actions: { queuedCount: 0, steering: [], followUps: [], active: { kind: "turn", phase: "running" } },
		});
		session.emit({ type: "agent_start" });
		const repeatedError = { message: "Tool unavailable", code: "ECONNRESET" };
		for (const toolCallId of ["private-call-one", "private-call-two"])
			session.emit({
				type: "tool_execution_end",
				toolCallId,
				toolName: "mcp__private_a",
				result: repeatedError,
				isError: true,
			});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "private-call-three",
			toolName: "mcp__private_b",
			result: { message: "Tool unavailable", code: "ECONNRESET" },
			isError: true,
		});
		const toolErrors = sink.events.filter((event) => event.name === "agent error");
		expect(toolErrors).toHaveLength(3);
		expect(new Set(toolErrors.map((event) => event.properties.error_id)).size).toBe(3);
		session.emit({
			type: "message_end",
			message: assistantMessage({ stopReason: "error", errorMessage: "Provider unavailable" }),
		});
		session.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 2,
			delayMs: 10,
			errorMessage: "Provider unavailable",
		});
		expect(
			sink.events.filter((event) => event.name === "agent error" && event.properties.component === "mcp"),
		).toHaveLength(3);
		session.emit({
			type: "tool_execution_end",
			toolCallId: "private-call-four",
			toolName: "mcp__private_a",
			result: {},
			isError: false,
		});
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		session.emit({ type: "session_action_update", actions: { queuedCount: 0, steering: [], followUps: [] } });
		const recovered = sink.events.filter(
			(event) =>
				event.name === "agent error" &&
				event.properties.component === "mcp" &&
				event.properties.recovery_outcome === "success",
		);
		expect(recovered.map((event) => event.properties.error_id)).toEqual(
			toolErrors.slice(0, 2).map((event) => event.properties.error_id),
		);
		expect(recovered.every((event) => event.properties.error_event_kind === "recovery_update")).toBe(true);
		expect(sink.events.find((event) => event.name === "agent tool summary")?.properties).toMatchObject({
			call_count: 4,
			failure_count: 3,
			recovered_count: 2,
		});
		expect(JSON.stringify(sink.events)).not.toContain("mcp__private_");
	});
	it("retains failed-run error IDs for a later successful run only in their originating session", () => {
		const { sink, session, options } = setup();
		const other = new FakeAgentSession();
		installAgentTelemetry(other as unknown as AgentSession, { ...options, randomId: undefined });
		session.emit({ type: "agent_start" });
		session.emit({
			type: "message_end",
			message: assistantMessage({ stopReason: "error", errorMessage: "Provider unavailable" }),
		});
		session.emit({ type: "agent_end", messages: [] });
		const original = sink.events.find((event) => event.name === "agent error")!.properties;
		other.emit({ type: "agent_start" });
		other.emit({ type: "message_end", message: assistantMessage() });
		other.emit({ type: "agent_end", messages: [] });
		expect(sink.events.filter((event) => event.name === "agent error")).toHaveLength(1);
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		const recovered = sink.events.filter((event) => event.name === "agent error").at(-1)!.properties;
		expect(recovered).toMatchObject({
			error_id: original.error_id,
			run_id: original.run_id,
			session_id: original.session_id,
			error_event_kind: "recovery_update",
			recovery_outcome: "success",
		});
	});
	it("requires pricing for every model call and terminal usage for active requests", async () => {
		const { sink, session } = setup();
		session.emit({ type: "agent_start" });
		session.emit({ type: "message_end", message: assistantMessage() });
		session.model = { id: "gpt-5", provider: "openai", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 } };
		session.emit({ type: "message_end", message: assistantMessage() });
		session.emit({ type: "agent_end", messages: [] });
		expect(
			sink.events.find((event) => event.name === "agent run completed")?.properties.estimated_cost_usd,
		).toBeNull();
		const pending = setup();
		pending.session.emit({ type: "agent_start" });
		pending.session.emit({ type: "message_end", message: assistantMessage() });
		pending.session.emit({ type: "turn_start" });
		pending.session.emit({ type: "tool_execution_start", toolCallId: "private", toolName: "read", args: {} });
		await pending.session.disposeAsync();
		expect(pending.sink.events.find((event) => event.name === "agent run completed")?.properties).toMatchObject({
			usage_complete: false,
			estimated_cost_usd: null,
			tool_duration_ms: null,
		});
	});

	it("carries explicit onboarding correlation and increasing run indices without copying session content", () => {
		const { sink, session, options } = setup();
		saveOnboardingTelemetryContext(options.agentDir, {
			onboardingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			clientSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			startedAt: Date.now() - 1000,
		});
		for (let i = 0; i < 2; i++) {
			session.emit({ type: "agent_start" });
			session.emit({ type: "message_end", message: assistantMessage() });
			session.emit({ type: "agent_end", messages: [] });
		}
		const starts = sink.events.filter((event) => event.name === "agent run started");
		expect(starts.map((event) => event.properties.run_index)).toEqual([1, 2]);
		expect(starts[1].properties).toMatchObject({
			onboarding_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			client_session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		});
		expect(starts[1].properties.elapsed_since_onboarding_ms).toBeGreaterThanOrEqual(1000);
	});

	it.each([false, true])(
		"uses setup elapsed time only from the input's own attempt (persisted attempt replaced: %s)",
		async (replacePersistedAttempt) => {
			const { sink, session, options } = setup();
			const input = {
				inputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				onboardingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				clientSessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			};
			const onboarding = {
				onboardingId: input.onboardingId,
				clientSessionId: input.clientSessionId,
				startedAt: Date.now() - 1000,
			};
			saveOnboardingTelemetryContext(options.agentDir, onboarding);
			await observeTelemetryInput(session, input, async () => {
				const action: SessionAction = {
					id: "local-action",
					source: "interactive",
					delivery: "when_run_idle",
					wake: "immediate",
					payload: { kind: "turn", records: [], text: "private prompt" },
					lifecycle: { state: "queued" },
				};
				observeTelemetryAction(session, action);
				if (replacePersistedAttempt)
					saveOnboardingTelemetryContext(options.agentDir, {
						...onboarding,
						onboardingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
						clientSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
					});
				action.lifecycle = { state: "committing" };
				observeTelemetryAction(session, action, "preparing");
				session.emit({ type: "agent_start" });
				session.emit({ type: "message_end", message: assistantMessage() });
				session.emit({ type: "agent_end", messages: [] });
			});
			const events = sink.events.filter((event) =>
				["agent run started", "agent run completed"].includes(event.name),
			);
			expect(events).toHaveLength(2);
			for (const event of events) {
				expect(event.properties).toMatchObject({
					input_id: input.inputId,
					onboarding_id: input.onboardingId,
					client_session_id: input.clientSessionId,
				});
				if (replacePersistedAttempt) expect(event.properties).not.toHaveProperty("elapsed_since_onboarding_ms");
				else expect(event.properties.elapsed_since_onboarding_ms).toBeGreaterThanOrEqual(1000);
			}
		},
	);
});
