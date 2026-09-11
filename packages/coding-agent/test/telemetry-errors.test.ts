import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStreamFailureMessage, Type, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryEventName, TelemetrySink } from "../src/core/telemetry.js";
import { getTelemetryErrorRecoveryTracker } from "../src/core/telemetry-error-recovery.js";
import {
	captureTelemetryError,
	initializeTelemetryErrorReporting,
	installTelemetryExceptionMonitor,
	reportTelemetryError,
	reportTelemetryLogEntry,
	type TelemetryErrorContext,
	withTelemetryErrorContext,
} from "../src/core/telemetry-errors.js";
import { deserializeDaemonError } from "../src/modes/daemon/daemon-errors.js";

const SECRET = "private-content-key-path-request-canary";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "10000000-0000-4000-8000-000000000002";

class RecordingSink implements TelemetrySink {
	readonly events: Array<{ name: TelemetryEventName; properties: Record<string, string | number | boolean | null> }> =
		[];
	capture(name: TelemetryEventName, properties: Record<string, string | number | boolean | null>): void {
		this.events.push({ name, properties });
	}
	async flush(): Promise<void> {}
}

describe("application error reporting", () => {
	let agentDir: string;
	let settings: SettingsManager;
	let sink: RecordingSink;
	let context: TelemetryErrorContext;
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prime-telemetry-errors-"));
		settings = SettingsManager.inMemory();
		sink = new RecordingSink();
		context = { agentDir, settingsManager: settings, executionMode: "interactive", sink };
		for (const key of ["PI_OFFLINE", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY"]) vi.stubEnv(key, "");
	});

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("reports errors by default with safe context and readable reviewed messages", () => {
		const error = Object.assign(new Error(SECRET), { status: 402, code: "insufficient_funds", requestID: SECRET });
		const id = captureTelemetryError({
			...context,
			error,
			component: "provider",
			operation: "request",
			stage: "model_request",
			sessionId: SESSION_ID,
			runId: RUN_ID,
		});
		expect(id).toMatch(/^[a-f0-9-]{36}$/);
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]).toMatchObject({
			name: "agent error",
			properties: {
				error_id: id,
				session_id: SESSION_ID,
				run_id: RUN_ID,
				error_subtype: "insufficient_balance",
				http_status: 402,
				diagnostic_message: "The provider reported insufficient balance.",
				error_code_group: "insufficient_funds",
				error_event_kind: "occurrence",
			},
		});
		expect(sink.events[0].properties.error_message).toBeUndefined();
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
	});

	it("omits echoed prompts from provider, tool-validation, and daemon messages at the serialized capture boundary", () => {
		const providerError = Object.assign(new Error(SECRET), {
			status: 401,
			error: { type: "invalid_api_key", message: `Rejected input: ${SECRET}` },
		});
		const providerMessage = formatStreamFailureMessage(providerError);
		expect(providerMessage).toContain(SECRET);
		captureTelemetryError({
			...context,
			error: { errorMessage: providerMessage, status: 401, code: "invalid_api_key" },
			component: "provider",
			operation: "request",
		});
		let toolError: unknown;
		try {
			validateToolArguments(
				{ name: "synthetic", description: "Synthetic test", parameters: Type.Object({ count: Type.Number() }) },
				{ type: "toolCall", id: "synthetic", name: "synthetic", arguments: { count: SECRET } },
			);
		} catch (error) {
			toolError = error;
		}
		expect(toolError).toBeInstanceOf(Error);
		expect((toolError as Error).message).toContain(SECRET);
		captureTelemetryError({ ...context, error: toolError, component: "tools", operation: "execute" });
		const daemonError = deserializeDaemonError({
			type: "response",
			command: "prompt",
			success: false,
			error: SECRET,
		});
		captureTelemetryError({ ...context, error: daemonError, component: "daemon", operation: "request" });
		expect(sink.events).toHaveLength(3);
		expect(sink.events.map((event) => event.properties.component)).toEqual(["provider", "tools", "daemon"]);
		for (const event of sink.events) expect(event.properties.error_message).toBeUndefined();
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
	});

	it("preserves exact Prime literals and independently describes operating-system errors", () => {
		captureTelemetryError({
			...context,
			error: new Error("Prime login challenge expired", { cause: new Error(SECRET) }),
			component: "authentication",
			operation: "login",
		});
		captureTelemetryError({
			...context,
			error: Object.assign(new Error(`ENOENT: open ${SECRET}`), { code: "ENOENT", path: SECRET }),
			component: "session",
			operation: "load",
		});
		expect(sink.events[0].properties).toMatchObject({
			error_message: "Prime login challenge expired",
			error_message_id: "prime_challenge_expired",
			error_message_source: "reviewed_literal",
		});
		expect(sink.events[1].properties).toMatchObject({
			error_message: "A required file or directory was not found.",
			error_message_id: "system_file_missing",
			error_message_source: "system_template",
		});
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
	});

	it.each(["PI_OFFLINE", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY"])(
		"honors %s before touching the error or creating identity",
		(key) => {
			vi.stubEnv(key, key === "PRIME_AGENT_TELEMETRY" ? "0" : "1");
			const message = vi.fn(() => SECRET);
			const error = Object.defineProperty({}, "message", { get: message });
			captureTelemetryError({ ...context, sink: undefined, error, component: "startup", operation: "startup" });
			expect(message).not.toHaveBeenCalled();
			expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
		},
	);

	it("honors setting changes after the fallback reporter is initialized", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		reportTelemetryError({ error: new Error(SECRET), component: "background", operation: "execute" });
		settings.setTelemetryEnabled(false);
		reportTelemetryError({ error: new Error(SECRET), component: "background", operation: "execute" });
		expect(sink.events).toHaveLength(1);
	});

	it("clears pending original messages immediately on settings opt-out", () => {
		captureTelemetryError({
			...context,
			error: new Error("Original synthetic failure"),
			component: "provider",
			operation: "request",
			sessionId: SESSION_ID,
			runId: RUN_ID,
		});
		const tracker = getTelemetryErrorRecoveryTracker(settings, agentDir, {
			isEnabled: () => settings.getTelemetryEnabled(),
		});
		settings.setTelemetryEnabled(false);
		settings.setTelemetryEnabled(true);
		expect(tracker.finishRun({ sessionId: SESSION_ID, runId: RUN_ID, outcome: "success" })).toEqual([]);
	});

	it("does not throw or recursively report a sink failure", () => {
		const broken = {
			capture() {
				throw new Error(SECRET);
			},
			async flush() {},
		};
		expect(() =>
			captureTelemetryError({
				...context,
				sink: broken,
				error: new Error(SECRET),
				component: "background",
				operation: "execute",
			}),
		).not.toThrow();
	});

	it("requires scoped consent for exception monitoring even when global reporting is enabled", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const previousMonitors = process.listeners("uncaughtExceptionMonitor");
		cleanups.push(installTelemetryExceptionMonitor());
		const listener = process
			.listeners("uncaughtExceptionMonitor")
			.find((candidate) => !previousMonitors.includes(candidate));
		const report = () => listener?.(new Error(SECRET), "uncaughtException");
		report();
		withTelemetryErrorContext({ ...context, telemetryDisabled: true }, report);
		withTelemetryErrorContext(
			{ ...context, settingsManager: SettingsManager.inMemory({ telemetry: { enabled: false } }) },
			report,
		);
		expect(sink.events).toHaveLength(0);

		withTelemetryErrorContext(context, report);
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0].properties).toMatchObject({ operation: "uncaught_exception" });

		reportTelemetryError({ error: new Error(SECRET), component: "startup", operation: "startup" });
		expect(sink.events).toHaveLength(2);
		expect(sink.events[1].properties).toMatchObject({ component: "startup" });
	});

	it("keeps asynchronous session opt-outs isolated from the process fallback", async () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const report = () =>
			reportTelemetryError({ error: new Error(SECRET), component: "daemon", operation: "execute" });
		await Promise.all([
			withTelemetryErrorContext({ ...context, telemetryDisabled: true }, async () => {
				await Promise.resolve();
				report();
			}),
			withTelemetryErrorContext(context, async () => {
				await Promise.resolve();
				report();
			}),
		]);
		expect(sink.events).toHaveLength(1);
	});

	it("requires scoped consent for daemon logs even when global reporting is enabled", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const report = () =>
			reportTelemetryLogEntry({
				ts: "private-time",
				level: "error",
				component: "coding-agent.daemon-supervisor",
				msg: `Request failed ${SECRET}`,
			});
		report();
		withTelemetryErrorContext({ ...context, telemetryDisabled: true }, report);
		withTelemetryErrorContext(
			{ ...context, settingsManager: SettingsManager.inMemory({ telemetry: { enabled: false } }) },
			report,
		);
		expect(sink.events).toHaveLength(0);

		withTelemetryErrorContext(context, report);
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0].properties).toMatchObject({ component: "daemon" });
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
	});
});
