import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryEventName, TelemetrySink } from "../src/core/telemetry.js";
import { getCurrentOnboardingTelemetryContext } from "../src/core/telemetry-journey-state.js";
import { TelemetryJourneys } from "../src/core/telemetry-journeys.js";

class RecordingSink implements TelemetrySink {
	readonly events: Array<{ name: TelemetryEventName; properties: Record<string, string | number | boolean | null> }> =
		[];
	capture(name: TelemetryEventName, properties: Record<string, string | number | boolean | null>): void {
		this.events.push({ name, properties });
	}
	async flush(): Promise<void> {}
}

describe("telemetry journeys", () => {
	let agentDir: string;
	let settingsManager: SettingsManager;
	let sink: RecordingSink;
	let time: number;
	let journeys: TelemetryJourneys;
	let allocatedIds: number;
	const wallTime = Date.UTC(2026, 8, 8);

	beforeEach(() => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
		vi.stubEnv("PI_OFFLINE", "0");
		agentDir = mkdtempSync(join(tmpdir(), "prime-telemetry-journeys-"));
		settingsManager = SettingsManager.inMemory();
		sink = new RecordingSink();
		time = 100;
		allocatedIds = 0;
		journeys = new TelemetryJourneys({
			agentDir,
			settingsManager,
			sink,
			now: () => time,
			wallNow: () => wallTime,
			randomId: () => `00000000-0000-4000-8000-${String(++allocatedIds).padStart(12, "0")}`,
		});
	});

	afterEach(() => {
		journeys.dispose();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("correlates an initiated feature with one terminal result and a measured duration", () => {
		const feature = journeys.beginFeature("effort");
		time = 325;
		feature.finish("completed", "high");
		feature.finish("failed");
		const clientSessionId = journeys.clientSessionId;
		journeys.dispose();

		expect(sink.events).toHaveLength(2);
		const [started, completed] = sink.events;
		expect(started.properties).toMatchObject({
			feature_name: "effort",
			outcome: "initiated",
			previous_success: false,
		});
		expect(completed.properties).toMatchObject({
			feature_id: started.properties.feature_id,
			client_session_id: clientSessionId,
			outcome: "completed",
			configuration_choice: "high",
			duration_ms: 225,
		});
		expect(completed.properties).not.toHaveProperty("session_id");
		expect(completed.properties).not.toHaveProperty("run_id");
	});

	it("distinguishes prior successful use from previous failures in the current client session", () => {
		journeys.beginFeature("model").finish("failed");
		journeys.beginFeature("model").finish("completed");
		journeys.beginFeature("model").finish("canceled");
		expect(
			sink.events
				.filter((event) => event.properties.outcome === "initiated")
				.map((event) => event.properties.previous_success),
		).toEqual([false, false, true]);
	});

	it("closes pending scopes once when the UI exits", () => {
		journeys.beginFeature("resume");
		journeys.beginOnboarding("first_setup");
		journeys.dispose();
		journeys.dispose();
		expect(sink.events.filter((event) => event.properties.outcome === "canceled")).toHaveLength(2);
	});

	it("keeps credential configuration separate from actual validation and model access", () => {
		const attempt = journeys.beginOnboarding("first_setup");
		time = 4100;
		attempt.stage("credential_discovery", "configured", {
			provider: "private-customer-provider",
			authSource: "stored",
			storedCredentialType: "api_key",
			acquisitionMethod: "api_key_entry",
			validationScope: "configuration",
		});
		attempt.stage("credential_validation", "unavailable", { validationScope: "unchecked" });
		attempt.stage("model_access", "unavailable", { validationScope: "unchecked" });
		attempt.finish("completed");

		const discovery = sink.events.find((event) => event.properties.stage === "credential_discovery");
		expect(discovery?.properties).toMatchObject({
			provider_category: "custom",
			outcome: "configured",
			validation_scope: "configuration",
			duration_ms: 4000,
			timing_scope: "elapsed_including_user_wait",
		});
		expect(sink.events.find((event) => event.properties.stage === "model_access")?.properties).toMatchObject({
			outcome: "unavailable",
			validation_scope: "unchecked",
		});
		expect(JSON.stringify(sink.events)).not.toContain("private-customer-provider");
		expect(sink.events.every((event) => event.properties.onboarding_id === attempt.context.onboardingId)).toBe(true);
	});

	it("records measured identity checks separately from elapsed user wait", () => {
		const attempt = journeys.beginOnboarding("reentered");
		time = 10100;
		attempt.stage("credential_validation", "completed", {
			acquisitionMethod: "prime_browser",
			validationScope: "identity_scope",
			durationMs: 35,
			systemWork: true,
		});
		journeys.startupStage("ui_ready", "completed", 10000, "cold", "elapsed_including_user_wait");
		journeys.startupStage("credential_validation", "completed", 35);
		expect(
			sink.events.find(
				(event) => event.name === "onboarding stage" && event.properties.stage === "credential_validation",
			)?.properties,
		).toMatchObject({ duration_ms: 35, timing_scope: "system_work", validation_scope: "identity_scope" });
		expect(sink.events.find((event) => event.properties.stage === "ui_ready")?.properties).toMatchObject({
			duration_ms: 10000,
			timing_scope: "elapsed_including_user_wait",
			startup_kind: "cold",
		});
	});

	it("uses private random attempt state that expires after seven days", () => {
		const attempt = journeys.beginOnboarding("first_setup");
		attempt.finish("completed");
		const path = join(agentDir, "telemetry-onboarding.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(attempt.context);
		expect(getCurrentOnboardingTelemetryContext(agentDir, wallTime + 86400000)).toEqual(attempt.context);
		expect(getCurrentOnboardingTelemetryContext(agentDir, wallTime + 7 * 86400000 + 1)).toBeUndefined();
		expect(existsSync(path)).toBe(false);
	});

	it("does not replace activation context for a previously shown skipped flow", () => {
		const first = journeys.beginOnboarding("first_setup");
		first.finish("canceled");
		const skipped = journeys.beginOnboarding("previously_shown", false);
		skipped.finish("skipped");
		expect(skipped.context.onboardingId).not.toBe(first.context.onboardingId);
		expect(getCurrentOnboardingTelemetryContext(agentDir, wallTime)).toEqual(first.context);
	});

	it("rejects unsafe or future-dated saved context without exposing local data", () => {
		const path = join(agentDir, "telemetry-onboarding.json");
		const attempt = journeys.beginOnboarding("first_setup");
		writeFileSync(path, JSON.stringify({ ...attempt.context, startedAt: wallTime + 1, apiKey: "private-key" }));
		expect(getCurrentOnboardingTelemetryContext(agentDir, wallTime)).toBeUndefined();
		expect(existsSync(path)).toBe(false);
		writeFileSync(path, JSON.stringify({ ...attempt.context, apiKey: "private-key" }));
		expect(getCurrentOnboardingTelemetryContext(agentDir, wallTime)).toEqual(attempt.context);
	});

	it("does not read through an onboarding state symlink", () => {
		const path = join(agentDir, "telemetry-onboarding.json");
		const target = join(agentDir, "target.json");
		writeFileSync(target, "private content");
		symlinkSync(target, path);
		expect(getCurrentOnboardingTelemetryContext(agentDir, wallTime)).toBeUndefined();
		expect(readFileSync(target, "utf8")).toBe("private content");
	});

	it.each(["setting", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY", "PI_OFFLINE"])(
		"honors the %s opt-out before creating state or events",
		(control) => {
			if (control === "setting") settingsManager.setTelemetryEnabled(false);
			else vi.stubEnv(control, control === "PRIME_AGENT_TELEMETRY" ? "0" : "1");
			journeys.beginOnboarding("first_setup").finish("completed");
			journeys.beginFeature("login").finish("completed");
			journeys.feedback("helpful");
			journeys.startupStage("ui_ready", "completed", 10);
			expect(sink.events).toEqual([]);
			expect(existsSync(join(agentDir, "telemetry-onboarding.json"))).toBe(false);
			expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
		},
	);

	it("clears correlation and suppresses completion if telemetry is disabled during a flow", () => {
		const attempt = journeys.beginOnboarding("first_setup");
		const feature = journeys.beginFeature("login");
		settingsManager.setTelemetryEnabled(false);
		expect(existsSync(join(agentDir, "telemetry-onboarding.json"))).toBe(false);
		feature.finish("completed");
		attempt.finish("completed");
		expect(sink.events).toHaveLength(2);
		expect(existsSync(join(agentDir, "telemetry-onboarding.json"))).toBe(false);
	});

	it("does not allocate IDs or retain attempts begun while telemetry is disabled", () => {
		expect(allocatedIds).toBe(0);
		settingsManager.setTelemetryEnabled(false);
		const feature = journeys.beginFeature("login");
		const onboarding = journeys.beginOnboarding("first_setup");
		expect(allocatedIds).toBe(0);
		expect(journeys.clientSessionId).toBe("");
		expect(onboarding.context).toEqual({ onboardingId: "", clientSessionId: "", startedAt: 0 });
		settingsManager.setTelemetryEnabled(true);
		feature.finish("completed");
		onboarding.stage("ready", "configured");
		onboarding.finish("completed");
		expect(allocatedIds).toBe(0);
		expect(sink.events).toEqual([]);
	});

	it("discards all prior state across opt-out and re-enable", () => {
		journeys.beginFeature("model").finish("completed");
		const pendingFeature = journeys.beginFeature("login");
		const pendingOnboarding = journeys.beginOnboarding("first_setup");
		const previousClientSessionId = journeys.clientSessionId;
		const priorEventCount = sink.events.length;
		settingsManager.setTelemetryEnabled(false);
		settingsManager.setTelemetryEnabled(true);
		pendingFeature.finish("completed");
		pendingOnboarding.finish("completed");
		expect(sink.events).toHaveLength(priorEventCount);
		journeys.beginFeature("model").finish("completed");
		expect(sink.events.at(-1)?.properties).toMatchObject({ previous_success: false });
		expect(sink.events.at(-1)?.properties.client_session_id).not.toBe(previousClientSessionId);
		expect(existsSync(join(agentDir, "telemetry-onboarding.json"))).toBe(false);
	});

	it("sends fixed-choice feedback without inferring task correctness", () => {
		journeys.feedback("partly_helpful");
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0].properties).toMatchObject({
			feature_name: "feedback",
			outcome: "completed",
			feedback: "partly_helpful",
		});
		expect(sink.events[0].properties).not.toHaveProperty("task_success");
	});

	it("does not let a failing telemetry sink interrupt a feature or onboarding", () => {
		vi.spyOn(sink, "capture").mockImplementation(() => {
			throw new Error("sink unavailable");
		});
		expect(() => journeys.beginFeature("model").finish("completed")).not.toThrow();
		expect(() => journeys.beginOnboarding("first_setup").finish("completed")).not.toThrow();
	});
});
