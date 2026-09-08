import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LogEntry } from "@earendil-works/pi-ai";
import type { AgentExecutionMode } from "./agent-session-config.js";
import type { SettingsManager } from "./settings-manager.js";
import { captureTelemetryEvent, flushTelemetry, isTelemetryEnabled, type TelemetrySink } from "./telemetry.js";
import { telemetryProviderCategory } from "./telemetry-categories.js";
import {
	TELEMETRY_ERROR_COMPONENTS,
	TELEMETRY_ERROR_OPERATIONS,
	TELEMETRY_ERROR_RECOVERY_ACTIONS,
	TELEMETRY_ERROR_RECOVERY_OUTCOMES,
	TELEMETRY_ERROR_STAGES,
	type TelemetryErrorComponent,
	type TelemetryErrorOperation,
	type TelemetryErrorRecoveryAction,
	type TelemetryErrorRecoveryOutcome,
	type TelemetryErrorStage,
	telemetryErrorProperties,
} from "./telemetry-error-classification.js";
import { getTelemetryErrorRecoveryTracker, type TelemetryErrorRecoveryTracker } from "./telemetry-error-recovery.js";

export interface TelemetryErrorContext {
	agentDir: string;
	settingsManager: SettingsManager;
	executionMode?: AgentExecutionMode;
	telemetryDisabled?: true;
	sink?: TelemetrySink;
}

export interface TelemetryErrorDetails {
	error: unknown;
	component: TelemetryErrorComponent;
	operation: TelemetryErrorOperation;
	stage?: TelemetryErrorStage;
	provider?: string;
	sessionId?: string;
	runId?: string;
	inputId?: string;
	clientSessionId?: string;
	retryAttempt?: number;
	retryBackoffMs?: number;
	consecutiveFailureCount?: number;
	recoveryAction?: TelemetryErrorRecoveryAction;
	recoveryOutcome?: TelemetryErrorRecoveryOutcome;
	/** Supply a new token when the same Error instance represents a genuinely new failure. */
	occurrence?: object;
}

export type CaptureTelemetryErrorOptions = TelemetryErrorContext & TelemetryErrorDetails;
type ErrorReport = Record<string, string | number | boolean | null>;
type ErrorReporter = (properties: ErrorReport) => void;

const DEDUPLICATION_WINDOW_MS = 1_000;
const MAX_COUNTER = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const seenErrors = new WeakMap<object, { id: string; scope: string; capturedAt: number }>();
const watchedSettings = new WeakMap<SettingsManager, Set<TelemetryErrorRecoveryTracker>>();
const scopedContext = new AsyncLocalStorage<TelemetryErrorContext>();
let activeContext: TelemetryErrorContext | undefined;
let customReporter: ErrorReporter | undefined;
let reporting = false;

function counter(value: number | undefined, maximum = MAX_COUNTER): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(Math.round(value), maximum)
		: null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function analyticsId(value: unknown): string | null {
	return typeof value === "string" && UUID.test(value) ? value : null;
}

function errorKeys(details: TelemetryErrorDetails): object[] {
	if (details.occurrence) return [details.occurrence];
	const keys: object[] = [];
	let value = details.error;
	while (value && typeof value === "object" && keys.length < 5 && !keys.includes(value)) {
		keys.push(value);
		try {
			value = (value as { cause?: unknown }).cause;
		} catch {
			break;
		}
	}
	return keys;
}

function makeReport(details: TelemetryErrorDetails): ErrorReport | undefined {
	const keys = errorKeys(details);
	const sessionId = analyticsId(details.sessionId);
	const runId = analyticsId(details.runId);
	const scope = `${sessionId ?? ""}:${runId ?? ""}:${counter(details.retryAttempt) ?? ""}`;
	const now = Date.now();
	for (const key of keys) {
		const previous = seenErrors.get(key);
		if (previous?.scope === scope && now - previous.capturedAt < DEDUPLICATION_WINDOW_MS) return undefined;
	}
	const id = randomUUID();
	for (const key of keys) seenErrors.set(key, { id, scope, capturedAt: now });
	return {
		...telemetryErrorProperties(details.error),
		error_id: id,
		component: enumValue(details.component, TELEMETRY_ERROR_COMPONENTS, "unknown"),
		operation: enumValue(details.operation, TELEMETRY_ERROR_OPERATIONS, "unknown"),
		stage: enumValue(details.stage, TELEMETRY_ERROR_STAGES, "unknown"),
		provider_category: telemetryProviderCategory(details.provider),
		session_id: sessionId,
		run_id: runId,
		input_id: analyticsId(details.inputId),
		client_session_id: analyticsId(details.clientSessionId),
		retry_attempt: counter(details.retryAttempt),
		retry_backoff_ms: counter(details.retryBackoffMs, 86_400_000),
		consecutive_failure_count: counter(details.consecutiveFailureCount),
		recovery_action: enumValue(details.recoveryAction, TELEMETRY_ERROR_RECOVERY_ACTIONS, "none"),
		recovery_outcome: enumValue(details.recoveryOutcome, TELEMETRY_ERROR_RECOVERY_OUTCOMES, "not_observed"),
	};
}

function trackReport(context: TelemetryErrorContext, report: ErrorReport): ErrorReport | undefined {
	const tracker = getTelemetryErrorRecoveryTracker(context.settingsManager, context.agentDir, {
		isEnabled: () => isTelemetryEnabled(context.settingsManager),
	});
	let trackers = watchedSettings.get(context.settingsManager);
	if (!trackers) {
		trackers = new Set();
		watchedSettings.set(context.settingsManager, trackers);
		context.settingsManager.subscribeTelemetryEnabled(() => {
			for (const item of watchedSettings.get(context.settingsManager) ?? []) item.clear();
		});
	}
	trackers.add(tracker);
	return tracker.recordFailure(report);
}

/** Register only after effective settings (including opt-outs) have been loaded. */
export function initializeTelemetryErrorReporting(context: TelemetryErrorContext): () => void {
	const previous = activeContext;
	activeContext = context;
	return () => {
		if (activeContext === context) activeContext = previous;
	};
}

export function withTelemetryErrorContext<T>(context: TelemetryErrorContext, callback: () => T): T {
	return scopedContext.run(context, callback);
}

export async function flushTelemetryErrorReporting(): Promise<void> {
	try {
		const context = scopedContext.getStore() ?? activeContext;
		if (!context || context.telemetryDisabled) return;
		await flushTelemetry(context);
	} catch {
		/* Error reporting cannot replace the original startup failure. */
	}
}

/** Receives sanitized properties only; intended for hosts that own their telemetry transport. */
export function registerTelemetryErrorReporter(reporter: ErrorReporter): () => void {
	const previous = customReporter;
	customReporter = reporter;
	return () => {
		if (customReporter === reporter) customReporter = previous;
	};
}

export function captureTelemetryError(options: CaptureTelemetryErrorOptions): string | undefined {
	if (reporting) return undefined;
	try {
		if (options.telemetryDisabled || !isTelemetryEnabled(options.settingsManager)) return undefined;
		reporting = true;
		const prepared = makeReport(options);
		const report = prepared ? trackReport(options, prepared) : undefined;
		if (!report) return undefined;
		captureTelemetryEvent({
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
			executionMode: options.executionMode,
			sink: options.sink,
			name: "agent error",
			properties: report,
		});
		return report.error_id as string;
	} catch {
		return undefined;
	} finally {
		reporting = false;
	}
}

/** Application-level fallback for failures before a session exists. */
export function reportTelemetryError(details: TelemetryErrorDetails): string | undefined {
	if (reporting) return undefined;
	try {
		const context = scopedContext.getStore() ?? activeContext;
		if (!context) return undefined;
		if (context.telemetryDisabled || !isTelemetryEnabled(context.settingsManager)) return undefined;
		if (!customReporter) return captureTelemetryError({ ...context, ...details });
		reporting = true;
		const prepared = makeReport(details);
		const report = prepared ? trackReport(context, prepared) : undefined;
		if (!report) return undefined;
		customReporter(report);
		return report.error_id as string;
	} catch {
		return undefined;
	} finally {
		reporting = false;
	}
}

/** Observe selected scoped failure messages without forwarding arbitrary log fields. */
export function reportTelemetryLogEntry(entry: LogEntry): void {
	if (reporting) return;
	try {
		// Shared daemon logs must not inherit another project's process-level consent.
		const context = scopedContext.getStore();
		if (!context || context.telemetryDisabled || !isTelemetryEnabled(context.settingsManager)) return;
		if (entry.level !== "error" && entry.level !== "warn") return;
		const components: Readonly<Record<string, TelemetryErrorComponent>> = {
			"coding-agent.daemon": "daemon",
			"coding-agent.daemon-supervisor": "daemon",
			"coding-agent.model-resolver": "configuration",
			"coding-agent.skills": "configuration",
		};
		const component = Object.hasOwn(components, entry.component) ? components[entry.component] : undefined;
		if (!component) return;
		// Daemon's legacy logger uses warn for lifecycle notices as well as failures.
		if (entry.level === "warn" && !/\b(?:error|failed|failure|timed out|unexpected|crashed)\b/i.test(entry.msg))
			return;
		reportTelemetryError({
			error: { message: entry.msg, code: entry.code, status: entry.status },
			component,
			operation: component === "configuration" ? "load" : "execute",
			stage: component === "configuration" ? "configuration" : "background",
		});
	} catch {
		// Analytics failure must not prevent the shared logger from writing the local entry.
	}
}

/** Monitoring does not consume exceptions or change Node's normal exit behavior. */
export function installTelemetryExceptionMonitor(): () => void {
	const onException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
		if (!scopedContext.getStore()) return;
		reportTelemetryError({
			error,
			component: "background",
			operation: origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
			stage: "background",
		});
	};
	process.on("uncaughtExceptionMonitor", onException);
	return () => process.off("uncaughtExceptionMonitor", onException);
}
