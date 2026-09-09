import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStreamFailureMessage, Type, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryEventName, TelemetrySink } from "../src/core/telemetry.js";
import { getTelemetryErrorRecoveryTracker } from "../src/core/telemetry-error-recovery.js";
import {
	captureTelemetryError,
	flushTelemetryErrorReporting,
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

	it("inherits the current UI client scope without deduplicating another client's failure", () => {
		const error = new Error("Prime login challenge expired");
		const report = () => reportTelemetryError({ error, component: "authentication", operation: "validate" });
		withTelemetryErrorContext({ ...context, clientSessionId: SESSION_ID }, () => {
			report();
			report();
		});
		withTelemetryErrorContext({ ...context, clientSessionId: RUN_ID }, report);
		expect(sink.events.map((event) => event.properties.client_session_id)).toEqual([SESSION_ID, RUN_ID]);
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
	it("checks fallback consent before copying lazy error details", () => {
		cleanups.push(initializeTelemetryErrorReporting({ ...context, telemetryDisabled: true }));
		const getter = vi.fn(() => new Error("private lazy message"));
		const details = Object.defineProperty(
			{ component: "startup" as const, operation: "startup" as const, error: undefined },
			"error",
			{ enumerable: true, get: getter },
		);
		expect(reportTelemetryError(details)).toBeUndefined();
		expect(getter).not.toHaveBeenCalled();
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

	it("flushes controlled startup errors with a bounded budget and preserves opt-out", async () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const flush = vi.spyOn(sink, "flush");
		reportTelemetryError({ error: new Error(SECRET), component: "startup", operation: "startup" });
		await flushTelemetryErrorReporting();
		expect(flush).toHaveBeenCalledWith({ timeoutMs: 1_500 });
		settings.setTelemetryEnabled(false);
		await flushTelemetryErrorReporting();
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("keeps the original failure available when shutdown delivery fails", async () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		vi.spyOn(sink, "flush").mockRejectedValue(new Error(SECRET));
		await expect(flushTelemetryErrorReporting()).resolves.toBeUndefined();
	});

	it("deduplicates propagated causes but preserves repeated failure occurrences", () => {
		const error = new Error(SECRET);
		const details = { ...context, error, component: "authentication" as const, operation: "load" as const };
		captureTelemetryError(details);
		captureTelemetryError({ ...details, error: new Error("Wrapper", { cause: error }) });
		captureTelemetryError({ ...details, occurrence: {} });
		captureTelemetryError({ ...details, retryAttempt: 1 });
		expect(sink.events).toHaveLength(3);
		expect(new Set(sink.events.map((event) => event.properties.error_id)).size).toBe(3);
	});

	it("bounds counters, rejects external identifiers, and handles unknown failures", () => {
		captureTelemetryError({
			...context,
			error: { message: SECRET, code: SECRET },
			component: "tools",
			operation: "execute",
			sessionId: SECRET,
			runId: SECRET,
			provider: SECRET,
			retryAttempt: Infinity,
			consecutiveFailureCount: 1e20,
		});
		expect(sink.events[0].properties).toMatchObject({
			error_subtype: "unknown",
			error_code: "unknown",
			consecutive_failure_count: 1_000_000,
		});
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
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

	it("contains fallback metadata getters and permits the next report", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const details = Object.defineProperty(
			{ error: new Error(SECRET), component: "background" as const, operation: "execute" as const },
			"provider",
			{
				enumerable: true,
				get() {
					throw new Error(SECRET);
				},
			},
		);
		expect(() => reportTelemetryError(details)).not.toThrow();
		expect(sink.events).toHaveLength(0);
		reportTelemetryError({ error: new Error(SECRET), component: "background", operation: "execute" });
		expect(sink.events).toHaveLength(1);
	});

	it("keeps the local log write reachable when telemetry consent lookup fails", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const consent = vi.spyOn(settings, "getTelemetryEnabled").mockImplementation(() => {
			throw new Error(SECRET);
		});
		const entry = { ts: "private-time", level: "error" as const, component: "coding-agent.daemon", msg: SECRET };
		const localWrite = vi.fn();
		expect(() => {
			withTelemetryErrorContext(context, () => reportTelemetryLogEntry(entry));
			localWrite(entry);
		}).not.toThrow();
		expect(localWrite).toHaveBeenCalledWith(entry);
		expect(sink.events).toHaveLength(0);
		consent.mockRestore();
		withTelemetryErrorContext(context, () => reportTelemetryLogEntry(entry));
		expect(sink.events).toHaveLength(1);
	});

	it("contains log field accessors and ignores inherited component names", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const entry = Object.defineProperty(
			{ ts: "private-time", level: "error" as const, component: "coding-agent.daemon", msg: SECRET },
			"code",
			{
				get() {
					throw new Error(SECRET);
				},
			},
		);
		expect(() => withTelemetryErrorContext(context, () => reportTelemetryLogEntry(entry))).not.toThrow();
		withTelemetryErrorContext(context, () =>
			reportTelemetryLogEntry({ ts: "private-time", level: "error", component: "constructor", msg: SECRET }),
		);
		expect(sink.events).toHaveLength(0);
	});

	it("captures recovered auth-storage errors at their source", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const failure = Object.assign(new Error(SECRET), { code: "EACCES" });
		let fails = true;
		const backend: AuthStorageBackend = {
			withLock(fn) {
				if (fails) throw failure;
				return fn("{}").result;
			},
			async withLockAsync(fn) {
				return (await fn("{}")).result;
			},
		};
		const storage = AuthStorage.fromStorage(backend);
		fails = false;
		storage.reload();
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0].properties).toMatchObject({
			component: "authentication",
			operation: "load",
			error_code: "EACCES",
		});
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
	});

	it("installs a monitor without taking over uncaught exception behavior", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const existing = process.listenerCount("uncaughtException");
		const rejectionListeners = process.listenerCount("unhandledRejection");
		const previousMonitors = process.listeners("uncaughtExceptionMonitor");
		const cleanup = installTelemetryExceptionMonitor();
		cleanups.push(cleanup);
		const listener = process
			.listeners("uncaughtExceptionMonitor")
			.find((candidate) => !previousMonitors.includes(candidate));
		withTelemetryErrorContext(context, () => listener?.(new Error(SECRET), "unhandledRejection"));
		expect(process.listenerCount("uncaughtException")).toBe(existing);
		expect(process.listenerCount("unhandledRejection")).toBe(rejectionListeners);
		expect(sink.events[0].properties).toMatchObject({ operation: "unhandled_rejection" });
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

	it("keeps auth-storage opt-outs scoped after process fallback changes", () => {
		const storage = AuthStorage.inMemory({}, { telemetryErrorContext: { ...context, telemetryDisabled: true } });
		cleanups.push(initializeTelemetryErrorReporting(context));
		vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw new Error(SECRET);
		});
		storage.reload();
		expect(sink.events).toHaveLength(0);
	});

	it("observes MCP host failures without sending arguments or server names", async () => {
		const failure = Object.assign(new Error(SECRET), { code: "ECONNRESET" });
		const manager = new McpManager({
			authStorage: AuthStorage.inMemory(),
			beginLogin: async () => {
				throw failure;
			},
			telemetryErrorContext: context,
		});
		await expect(manager.hostHandlers()["mcp.begin_login"]({ server: SECRET, content: SECRET })).rejects.toBe(
			failure,
		);
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0].properties).toMatchObject({
			component: "mcp",
			operation: "login",
			error_code: "ECONNRESET",
		});
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
	});

	it("observes daemon failures while excluding provider logs and ordinary notices", () => {
		cleanups.push(initializeTelemetryErrorReporting(context));
		const base = {
			ts: "private-time",
			level: "warn" as const,
			component: "coding-agent.daemon",
			socketPath: SECRET,
			requestId: SECRET,
		};
		withTelemetryErrorContext(context, () => {
			reportTelemetryLogEntry({ ...base, msg: "Session attached" });
			reportTelemetryLogEntry({ ...base, msg: `Connection failed ${SECRET}` });
			reportTelemetryLogEntry({ ...base, component: "ai.provider", msg: `Request failed ${SECRET}` });
		});
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0].properties).toMatchObject({ component: "daemon", error_subtype: "unknown" });
		expect(JSON.stringify(sink.events)).not.toContain(SECRET);
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
