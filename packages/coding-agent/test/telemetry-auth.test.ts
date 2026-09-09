import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryEventName, TelemetryProperties, TelemetrySink } from "../src/core/telemetry.js";
import { beginTelemetryAuthentication } from "../src/core/telemetry-auth.js";
import type { TelemetryErrorOperation } from "../src/core/telemetry-error-classification.js";
import { captureTelemetryError, reportTelemetryError } from "../src/core/telemetry-errors.js";

const CLIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CLIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup() {
	const events: Array<{ name: TelemetryEventName; properties: TelemetryProperties }> = [];
	const sink: TelemetrySink = {
		capture: (name, properties) => events.push({ name, properties }),
		flush: async () => {},
	};
	const context = {
		agentDir: "/not-used",
		settingsManager: SettingsManager.inMemory(),
		executionMode: "interactive" as const,
		sink,
		clientSessionId: CLIENT,
	};
	return { context, events };
}

describe("UI authentication recovery", () => {
	beforeEach(() => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("correlates source and UI reports, then recovers the same failure after a successful validation", async () => {
		const { context, events } = setup();
		const first = beginTelemetryAuthentication({ ...context, provider: "prime-inference" });
		const error = new Error("Prime token is missing inference permissions");
		await first.run(async () => {
			await Promise.resolve();
			reportTelemetryError({
				error,
				component: "authentication",
				operation: "validate",
				provider: "prime-inference",
			});
			first.reportError(error, "login");
		});
		first.finish("failed");
		expect(events).toHaveLength(1);
		expect(events[0].properties).toMatchObject({ client_session_id: CLIENT, error_event_kind: "occurrence" });
		const second = beginTelemetryAuthentication({ ...context, provider: "prime-inference" });
		second.validation("completed");
		expect(second.finish("completed")).toBe(true);
		expect(second.finish("completed")).toBe(false);
		expect(events).toHaveLength(2);
		expect(events[1].properties).toMatchObject({
			error_id: events[0].properties.error_id,
			client_session_id: CLIENT,
			error_event_kind: "recovery_update",
			recovery_action: "credentials_updated",
			recovery_outcome: "success",
		});
	});

	it.each([
		["prime-inference", "prime-agent-traces"],
		["openai", "openai-codex"],
	])("keeps %s failures separate from %s authentication", (failedProvider, successfulProvider) => {
		const { context, events } = setup();
		captureTelemetryError({
			...context,
			error: new Error("Provider authentication failed"),
			component: "authentication",
			operation: "validate",
			provider: failedProvider,
		});
		const attempt = beginTelemetryAuthentication({ ...context, provider: successfulProvider });
		attempt.validation("completed");
		attempt.finish("completed");
		expect(events).toHaveLength(1);
		expect(events[0].properties).not.toHaveProperty("providerIdentity");
	});

	it("does not resolve another UI's errors, storage failures, or unrelated authentication operations", () => {
		const { context, events } = setup();
		const cases: Array<{ clientSessionId?: string; operation: TelemetryErrorOperation }> = [
			{ operation: "login", clientSessionId: OTHER_CLIENT },
			{ operation: "logout" },
			{ operation: "discover" },
			{ operation: "save" },
			{ operation: "load" },
			{ operation: "refresh" },
		];
		for (const entry of cases)
			captureTelemetryError({
				...context,
				...entry,
				error: new Error("Provider authentication failed"),
				component: "authentication",
				provider: "prime-inference",
			});
		const attempt = beginTelemetryAuthentication({ ...context, provider: "prime-inference" });
		attempt.validation("completed");
		attempt.finish("completed");
		expect(events).toHaveLength(cases.length);
		expect(events.every((event) => event.properties.error_event_kind === "occurrence")).toBe(true);
	});

	it("keeps unchecked credential saves pending without claiming recovery", () => {
		const { context, events } = setup();
		const attempt = beginTelemetryAuthentication({ ...context, provider: "openai" });
		attempt.reportError(new Error("Provider authentication failed"), "login");
		attempt.finish("completed");
		expect(events.at(-1)?.properties).toMatchObject({
			recovery_action: "credentials_updated",
			recovery_outcome: "pending",
		});
		expect(events.some((event) => event.properties.recovery_outcome === "success")).toBe(false);
	});

	it.each(["failed", "canceled"] as const)("does not infer recovery when the auth attempt is %s", (outcome) => {
		const { context, events } = setup();
		const attempt = beginTelemetryAuthentication({ ...context, provider: "openai" });
		attempt.reportError(new Error("Provider authentication failed"), "login");
		attempt.validation("completed");
		expect(attempt.finish(outcome)).toBe(false);
		expect(events).toHaveLength(1);
	});

	it("never inspects errors for an attempt begun while opted out, even after re-enabling", () => {
		const { context, events } = setup();
		context.settingsManager.setTelemetryEnabled(false);
		const attempt = beginTelemetryAuthentication({ ...context, provider: "openai" });
		context.settingsManager.setTelemetryEnabled(true);
		const message = vi.fn(() => "private prompt echoed in failure");
		const error = Object.defineProperty({}, "message", { get: message });
		attempt.run(() => {
			reportTelemetryError({ error, component: "authentication", operation: "login", provider: "openai" });
			attempt.reportError(error, "login");
		});
		attempt.validation("completed");
		expect(attempt.finish("completed")).toBe(false);
		expect(message).not.toHaveBeenCalled();
		expect(events).toEqual([]);
	});

	it("discards a live attempt and recovery after consent is withdrawn and restored", () => {
		const { context, events } = setup();
		const attempt = beginTelemetryAuthentication({ ...context, provider: "openai" });
		attempt.reportError(new Error("Provider authentication failed"), "login");
		context.settingsManager.setTelemetryEnabled(false);
		context.settingsManager.setTelemetryEnabled(true);
		attempt.run(() =>
			reportTelemetryError({
				error: new Error("Provider authentication failed"),
				component: "authentication",
				operation: "login",
				provider: "openai",
			}),
		);
		attempt.validation("completed");
		expect(attempt.finish("completed")).toBe(false);
		expect(events).toHaveLength(1);
	});
});
