import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	captureAgentCommandUsed,
	captureOnboardingCompleted,
	getOrCreateTelemetryInstallationId,
	installAgentTelemetry,
	isTelemetryEnabled,
	TelemetryClient,
	type TelemetryEvent,
	type TelemetryEventName,
	type TelemetrySink,
	telemetryAuthCategory,
} from "../src/core/telemetry.js";

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

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("telemetry identity and transport", () => {
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

		expect(() => client.capture("agent started", {})).not.toThrow();
		await expect(client.flush()).resolves.toBeUndefined();

		expect(readFileSync(targetPath, "utf8")).toBe("do not overwrite");
		expect(lstatSync(telemetryPath).isSymbolicLink()).toBe(true);
	});

	it("batches events through the configured Prime endpoint", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-telemetry-"));
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock: typeof fetch = async (input, init) => {
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

		client.capture("agent started", {
			version: "1.2.3",
			os_family: "darwin",
		});
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
				properties: {
					version: "1.2.3",
					os_family: "darwin",
				},
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

		client.capture("agent started", {});
		await expect(client.flush()).resolves.toBeUndefined();
	});

	it("drains every queued batch before flush resolves", async () => {
		const batchSizes: number[] = [];
		const client = new TelemetryClient({
			agentDir: mkdtempSync(join(tmpdir(), "prime-agent-telemetry-")),
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { events: TelemetryEvent[] };
				batchSizes.push(body.events.length);
				return new Response(null, { status: 204 });
			},
			randomId: uuidGenerator(),
			batchSize: 2,
		});

		for (let index = 0; index < 5; index++) {
			client.capture("agent started", { index });
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

		expect(() => client.capture("agent started", {})).not.toThrow();
		await expect(client.flush()).resolves.toBeUndefined();
	});
});

describe("telemetry controls", () => {
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
