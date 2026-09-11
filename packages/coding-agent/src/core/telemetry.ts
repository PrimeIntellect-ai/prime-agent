import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { detectInstallMethod, VERSION } from "../config.js";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";
import type { AgentExecutionMode } from "./agent-session-config.js";
import type { AuthCredential, AuthStatus } from "./auth-storage.js";
import type { SettingsManager } from "./settings-manager.js";
import { isBuiltinSlashCommandName, resolveBuiltinSlashCommandName } from "./slash-commands.js";
import {
	telemetryModelCategory as modelCategory,
	telemetryAuthCategory,
	telemetryProviderCategory,
} from "./telemetry-categories.js";

export type { TelemetryAuthCategory } from "./telemetry-categories.js";
export { telemetryAuthCategory, telemetryProviderCategory } from "./telemetry-categories.js";

const DEFAULT_TELEMETRY_ENDPOINT = "https://api.primeintellect.ai/api/v1/agent-analytics/events";
const TELEMETRY_STATE_FILE = "telemetry.json";
const TELEMETRY_STATE_VERSION = 1;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 7_000;

export type { TelemetryProperties } from "./telemetry-schema.js";

import { isSessionSlashCommandMessage, isSessionSlashCommandResultMessage } from "./messages.js";
import { TELEMETRY_CONTRACT } from "./telemetry-contract.js";
import {
	classifyTelemetryError,
	type TelemetryErrorComponent,
	type TelemetryErrorOperation,
	type TelemetryErrorStage,
	telemetryLegacyErrorCategory,
} from "./telemetry-error-classification.js";
import { getTelemetryErrorRecoveryTracker } from "./telemetry-error-recovery.js";
import {
	getTelemetryExecutionContext,
	subscribeTelemetryExecutionContexts,
	type TelemetryExecutionContextCategories,
} from "./telemetry-execution-context.js";
import { clearTelemetryInputs, subscribeTelemetryInputs } from "./telemetry-input.js";
import { type ObservedTelemetryInput, TelemetryInputTracker } from "./telemetry-input-tracker.js";
import { clearInstallationTelemetryState } from "./telemetry-installation-state.js";
import {
	clearOnboardingTelemetryContext,
	getCurrentOnboardingTelemetryContext,
	type OnboardingTelemetryContext,
} from "./telemetry-journey-state.js";
import { createPostHogException, type PostHogExceptionEvent } from "./telemetry-posthog.js";
import {
	isLegacyTelemetryEvent,
	isTelemetryUuid,
	sanitizeTelemetryProperties,
	TELEMETRY_ERROR_MESSAGE_PROPERTIES,
	type TelemetryProperties,
} from "./telemetry-schema.js";

import { type TelemetryOperation, TelemetryScope } from "./telemetry-scope.js";

export type TelemetryEventName =
	| "agent started"
	| "onboarding completed"
	| "agent command used"
	| "agent run completed"
	| "agent session ended"
	| "agent run started"
	| "agent error"
	| "agent timing"
	| "agent tool summary"
	| "onboarding stage"
	| "agent feature outcome"
	| "agent startup stage"
	| "agent input stage"
	| "agent installation stage";

export type TelemetryExecutionMode = AgentExecutionMode | "unknown";
export type TelemetryOnboardingOutcome = "success" | "error" | "aborted";

export interface TelemetryEvent {
	id: string;
	name: TelemetryEventName;
	timestamp: string;
	properties: TelemetryProperties;
}

export interface TelemetryBatch {
	schema_version?: number;
	installation_id: string;
	events: Array<TelemetryEvent | PostHogExceptionEvent>;
}

export interface TelemetrySink {
	capture(name: TelemetryEventName, properties: TelemetryProperties): void;
	flush(options?: { timeoutMs?: number }): Promise<void>;
}

interface TelemetryState {
	version: number;
	installationId: string;
}

interface TelemetryClientOptions {
	isEnabled?: () => boolean;
	agentDir: string;
	endpoint?: string;
	fetch?: typeof fetch;
	now?: () => number;
	randomId?: () => string;
	batchSize?: number;
	flushIntervalMs?: number;
	requestTimeoutMs?: number;
}

interface InstallAgentTelemetryOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	executionMode?: AgentExecutionMode;
	sink?: TelemetrySink;
	now?: () => number;
	randomId?: () => string;
}

export interface CaptureOnboardingCompletedOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	durationMs: number;
	outcome: TelemetryOnboardingOutcome;
	provider?: string;
	authSource?: AuthStatus["source"];
	storedCredentialType?: AuthCredential["type"];
	sink?: TelemetrySink;
	now?: () => number;
	randomId?: () => string;
}

export interface CaptureAgentCommandUsedOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	commandName: string;
	sink?: TelemetrySink;
	now?: () => number;
	randomId?: () => string;
}

interface UsageTotals extends Usage {
	modelCallCount: number;
}

interface ActiveRun {
	onboarding?: OnboardingTelemetryContext;
	input?: ObservedTelemetryInput;
	executionContext?: TelemetryExecutionContextCategories;
	contextSource?: "configured" | "request";
	firstProviderDispatchAt?: number;
	id: string;
	index: number;
	startedAt: number;
	agentEnded: boolean;
	actionOutcome?: "failed" | "cancelled";
	firstTurnStartedAt?: number;
	firstModelEventMs?: number;
	visibleTtftMs?: number;
	currentTurnStartedAt?: number;
	currentModelRequestObserved: boolean;
	successfulModelCallCount: number;
	modelLatencyMs: number;
	maxModelLatencyMs: number;
	turnCount: number;
	toolCallCount: number;
	toolErrorCount: number;
	compactionCount: number;
	retryCount: number;
	usage: UsageTotals;
	lastAssistant?: AssistantMessage;
	firstReasoningMs?: number;
	runToFirstTextMs?: number;
	lastStreamEventAt?: number;
	maxStreamGapMs?: number;
	retryStartedAt?: number;
	retryWaitMs: number;
	compactionStartedAt?: number;
	compactionDurationMs: number;
	usageComplete: boolean;
	pricingComplete: boolean;
	cancelled: boolean;
	tools: Map<string, { calls: number; failures: number; duration: number; measured: number; recovered: number }>;
	unrecoveredTools: Map<string, { count: number; errorIds: string[] }>;
	pendingTools: Map<string, { category: string; startedAt: number }>;
}

interface SessionTotals {
	startedAt: number;
	runCount: number;
	successfulRunCount: number;
	failedRunCount: number;
	abortedRunCount: number;
	promptCount: number;
	toolCallCount: number;
	compactionCount: number;
	usage: UsageTotals;
}

const EMPTY_USAGE_TOTALS: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
	modelCallCount: 0,
};

function newUsageTotals(): UsageTotals {
	return structuredClone(EMPTY_USAGE_TOTALS);
}

function addUsage(target: UsageTotals, usage: Usage, modelCallCount = 1): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
	target.modelCallCount += modelCallCount;
}

function parseBooleanOverride(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return undefined;
}

export function isTelemetryEnabled(settingsManager: SettingsManager): boolean {
	if (parseBooleanOverride(process.env.PI_OFFLINE) === true) {
		return false;
	}
	if (parseBooleanOverride(process.env.DO_NOT_TRACK) === true) {
		return false;
	}
	const override = parseBooleanOverride(process.env.PRIME_AGENT_TELEMETRY);
	if (override !== undefined) {
		return override;
	}
	return settingsManager.getTelemetryEnabled();
}

function readInstallationId(path: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryState>;
		return parsed.version === TELEMETRY_STATE_VERSION && isTelemetryUuid(parsed.installationId)
			? parsed.installationId
			: undefined;
	} catch {
		return undefined;
	}
}

function writeTelemetryStateAtomically(path: string, state: TelemetryState): void {
	writeFileAtomicSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function getOrCreateTelemetryInstallationId(agentDir: string, randomId: () => string = randomUUID): string {
	const path = join(agentDir, TELEMETRY_STATE_FILE);
	let replaceInvalidState = false;
	try {
		const stats = lstatSync(path);
		if (!stats.isFile()) {
			throw new Error("Telemetry state path must be a regular file");
		}
		const existing = readInstallationId(path);
		if (existing) {
			return existing;
		}
		replaceInvalidState = true;
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code !== "ENOENT") {
			throw error;
		}
	}

	const installationId = randomId();
	if (!isTelemetryUuid(installationId)) {
		throw new Error("Telemetry installation ID generator returned an invalid UUID");
	}
	mkdirSync(agentDir, { recursive: true });
	const state: TelemetryState = {
		version: TELEMETRY_STATE_VERSION,
		installationId,
	};
	try {
		if (replaceInvalidState) {
			writeTelemetryStateAtomically(path, state);
		} else {
			writeFileSync(path, JSON.stringify(state, null, 2), {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
		}
		return installationId;
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		if (code !== "EEXIST") {
			throw error;
		}
		return readInstallationId(path) ?? installationId;
	}
}

export class TelemetryClient implements TelemetrySink {
	private readonly endpoint: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly batchSize: number;
	private readonly flushIntervalMs: number;
	private readonly requestTimeoutMs: number;
	private installationId?: string;
	private queue: Array<{ event: TelemetryEvent; attempts: number; queuedAt: number; acknowledgedIds: Set<string> }> =
		[];
	private flushTimer?: ReturnType<typeof setTimeout>;
	private flushInFlight?: Promise<void>;
	private discovery?: Promise<void>;
	private nextDiscoveryAt = 0;
	private supportsV2 = false;
	private supportsInstallationOutcomes = false;
	private supportsOriginalErrorMessages = false;
	private supportsPostHogExceptions = false;
	private disabled = false;
	private queueGeneration = 0;
	private readonly requests = new Set<AbortController>();
	readonly delivery = { accepted: 0, rejected: 0, expired: 0, overflow: 0, retries: 0, unavailable: 0 };

	constructor(private readonly options: TelemetryClientOptions) {
		this.endpoint = options.endpoint ?? process.env.PRIME_AGENT_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT;
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.randomId = options.randomId ?? randomUUID;
		this.batchSize = Math.max(1, Math.min(20, options.batchSize ?? DEFAULT_BATCH_SIZE));
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	private enabled(): boolean {
		let enabled = false;
		try {
			enabled =
				!this.disabled &&
				this.options.isEnabled?.() !== false &&
				parseBooleanOverride(process.env.DO_NOT_TRACK) !== true &&
				parseBooleanOverride(process.env.PI_OFFLINE) !== true &&
				parseBooleanOverride(process.env.PRIME_AGENT_TELEMETRY) !== false;
		} catch {
			/* A failed consent check is an opt-out. */
		}
		if (!enabled) {
			this.clear();
			return false;
		}
		return true;
	}

	private clear(): void {
		this.queueGeneration++;
		this.queue = [];
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		for (const controller of this.requests) controller.abort();
	}

	clearPending(): void {
		this.clear();
		this.supportsV2 = false;
		this.supportsInstallationOutcomes = false;
		this.supportsOriginalErrorMessages = false;
		this.supportsPostHogExceptions = false;
		this.nextDiscoveryAt = 0;
	}

	capture(name: TelemetryEventName, properties: TelemetryProperties): void {
		if (!this.enabled()) return;
		let safe: TelemetryProperties | undefined;
		try {
			safe = sanitizeTelemetryProperties(name, properties);
		} catch {
			this.delivery.rejected++;
			return;
		}
		if (!safe) {
			this.delivery.rejected++;
			return;
		}
		try {
			this.installationId ??= getOrCreateTelemetryInstallationId(this.options.agentDir, this.randomId);
			const event = { id: this.randomId(), name, timestamp: new Date(this.now()).toISOString(), properties: safe };
			if (!isTelemetryUuid(event.id)) return;
			if (this.queue.length >= 256) {
				this.queue.shift();
				this.delivery.overflow++;
			}
			this.queue.push({ event, attempts: 0, queuedAt: this.now(), acknowledgedIds: new Set() });
		} catch {
			this.disabled = true;
			this.clear();
			return;
		}
		this.discover();
		this.scheduleFlush(this.queue.length >= this.batchSize ? 0 : this.flushIntervalMs);
	}

	private scheduleFlush(delay: number): void {
		if (this.flushTimer || !this.queue.length || !this.enabled()) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, delay);
		this.flushTimer.unref?.();
	}

	private async request(
		url: string,
		init: RequestInit,
		timeoutMs = this.requestTimeoutMs,
	): Promise<Response | undefined> {
		if (!this.enabled()) return undefined;
		const controller = new AbortController();
		this.requests.add(controller);
		const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
		timer.unref?.();
		try {
			const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
			const reader = response.body?.getReader();
			let text = "";
			const decoder = new TextDecoder();
			if (reader) {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					text += decoder.decode(value, { stream: true });
					if (text.length > 16_384) {
						await reader.cancel();
						return undefined;
					}
				}
				text += decoder.decode();
			}
			return new Response(response.status === 204 ? null : text, { status: response.status });
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
			this.requests.delete(controller);
		}
	}

	private discover(): void {
		if (this.discovery || this.now() < this.nextDiscoveryAt || !this.enabled()) return;
		this.nextDiscoveryAt = this.now() + 60_000;
		this.supportsOriginalErrorMessages = false;
		this.supportsPostHogExceptions = false;
		this.supportsInstallationOutcomes = false;
		this.discovery = (async () => {
			try {
				const url = new URL(this.endpoint);
				url.pathname = url.pathname.replace(/\/events\/?$/, "/capabilities");
				url.search = "";
				const response = await this.request(url.toString(), { method: "GET" });
				if (!response?.ok) return;
				const text = await response.text();
				if (text.length > 4096 || !this.enabled()) return;
				const body: unknown = JSON.parse(text);
				this.supportsV2 = false;
				if (typeof body !== "object" || body === null) return;
				this.supportsV2 =
					"schema_versions" in body && Array.isArray(body.schema_versions) && body.schema_versions.includes(2);
				this.supportsInstallationOutcomes =
					this.supportsV2 &&
					"schema_revision" in body &&
					typeof body.schema_revision === "number" &&
					Number.isInteger(body.schema_revision) &&
					body.schema_revision >= 3;
				this.supportsPostHogExceptions =
					this.supportsV2 && "posthog_exception_events" in body && body.posthog_exception_events === true;
				this.supportsOriginalErrorMessages =
					this.supportsV2 &&
					"original_error_messages" in body &&
					body.original_error_messages === true &&
					"error_message_policy_revision" in body &&
					body.error_message_policy_revision === TELEMETRY_CONTRACT.error_message_policy_revision;
			} catch {
				// Discovery is optional; unavailable collectors retain legacy telemetry.
			} finally {
				this.discovery = undefined;
			}
		})();
	}

	async flush(options: { timeoutMs?: number } = {}): Promise<void> {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (!this.enabled()) return;
		const timeoutMs = Math.max(1, options.timeoutMs ?? this.requestTimeoutMs);
		if (this.flushInFlight) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					this.flushInFlight,
					new Promise<void>((resolve) => {
						timer = setTimeout(() => {
							for (const controller of this.requests) controller.abort();
							resolve();
						}, timeoutMs);
						timer.unref?.();
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			return;
		}
		this.discover();
		this.flushInFlight = this.drainQueue(timeoutMs);
		try {
			await this.flushInFlight;
		} finally {
			this.flushInFlight = undefined;
			const attempts = Math.max(0, ...this.queue.map((entry) => entry.attempts));
			this.scheduleFlush(Math.min(60_000, this.flushIntervalMs * 2 ** attempts));
		}
	}

	private async drainQueue(timeoutMs: number): Promise<void> {
		const generation = this.queueGeneration;
		const deadline = performance.now() + timeoutMs;
		if (this.discovery) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const needsDiscovery = this.queue.some(
				(entry) =>
					entry.event.name === "agent installation stage" ||
					(entry.event.name === "agent error" && entry.event.properties.error_event_kind === "occurrence"),
			);
			await Promise.race([
				this.discovery,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, needsDiscovery ? timeoutMs : Math.min(250, timeoutMs / 2));
					timer.unref?.();
				}),
			]);
			if (timer) clearTimeout(timer);
		}
		if (generation !== this.queueGeneration) return;
		this.queue = this.queue.filter((entry) => {
			if (this.now() - entry.queuedAt > 86_400_000 || entry.attempts >= 5) {
				this.delivery.expired++;
				return false;
			}
			return true;
		});
		// Bound each flush, including shutdown, independently of newly queued work.
		const pending = [...this.queue];
		while (
			pending.length &&
			this.enabled() &&
			generation === this.queueGeneration &&
			performance.now() < deadline &&
			this.installationId
		) {
			const version2 = this.supportsV2;
			const installationId = this.installationId;
			const entries = pending.splice(0, this.batchSize).filter((entry) => {
				// An unresolved capability refresh must not retire an unsent exception.
				if (
					this.discovery &&
					entry.event.name === "agent error" &&
					entry.event.properties.error_event_kind === "occurrence"
				)
					return false;
				return entry.event.name === "agent installation stage"
					? version2 && this.supportsInstallationOutcomes
					: version2 || isLegacyTelemetryEvent(entry.event.name);
			});
			if (!entries.length) continue;
			const groups = entries.map((entry) => {
				const event = entry.event;
				const properties = sanitizeTelemetryProperties(event.name, event.properties, !version2);
				if (properties && !this.supportsOriginalErrorMessages)
					for (const key of TELEMETRY_ERROR_MESSAGE_PROPERTIES) delete properties[key];
				const events: TelemetryBatch["events"] = properties ? [{ ...event, properties }] : [];
				if (properties && version2 && this.supportsPostHogExceptions) {
					const exception = createPostHogException(installationId, { ...event, properties });
					if (exception) events.push(exception);
				}
				return { entry, events: events.filter((event) => !entry.acknowledgedIds.has(event.id)) };
			});
			const batch: TelemetryBatch = {
				installation_id: this.installationId,
				events: groups.flatMap((group) => group.events),
				...(version2 ? { schema_version: 2 } : {}),
			};
			while (
				(batch.events.length > 20 || Buffer.byteLength(JSON.stringify(batch), "utf8") > 30_000) &&
				groups.length > 1
			) {
				const deferred = groups.pop();
				if (deferred) pending.unshift(deferred.entry);
				batch.events = groups.flatMap((group) => group.events);
			}
			const events = batch.events;
			if (!events.length) {
				this.queue = this.queue.filter((entry) => !groups.some((group) => group.entry === entry));
				continue;
			}
			for (const { entry } of groups) entry.attempts++;
			const response = await this.request(
				this.endpoint,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(batch),
				},
				deadline - performance.now(),
			);
			if (!this.enabled() || generation !== this.queueGeneration) return;
			if (version2 && response && [400, 404, 422].includes(response.status)) {
				this.supportsV2 = false;
				this.supportsInstallationOutcomes = false;
				this.supportsOriginalErrorMessages = false;
				this.supportsPostHogExceptions = false;
				this.nextDiscoveryAt = this.now() + 60_000;
				this.delivery.retries += events.length;
				return;
			}
			if (!response?.ok) {
				this.delivery.unavailable += events.length;
				this.delivery.retries += events.length;
				return;
			}
			const accepted = new Set<string>();
			const rejected = new Set<string>();
			try {
				if (response.status === 204 && !version2) for (const event of events) accepted.add(event.id);
				else {
					const text = await response.text();
					if (text.length > 16_384) return;
					const body: unknown = JSON.parse(text);
					if (typeof body !== "object" || body === null) return;
					if ("accepted_ids" in body && Array.isArray(body.accepted_ids)) {
						for (const id of body.accepted_ids) if (isTelemetryUuid(id)) accepted.add(id);
						if ("dropped_ids" in body && Array.isArray(body.dropped_ids))
							for (const id of body.dropped_ids) if (isTelemetryUuid(id)) rejected.add(id);
					} else if ("accepted" in body && body.accepted === events.length) {
						for (const event of events) accepted.add(event.id);
					}
				}
			} catch {
				return;
			}
			for (const event of events) {
				if (accepted.has(event.id)) this.delivery.accepted++;
				else if (rejected.has(event.id)) this.delivery.rejected++;
				else this.delivery.retries++;
			}
			for (const { entry, events: sent } of groups)
				for (const event of sent)
					if (accepted.has(event.id) || rejected.has(event.id)) entry.acknowledgedIds.add(event.id);
			this.queue = this.queue.filter(
				(entry) =>
					!groups.some(
						(group) =>
							group.entry === entry && group.events.every((event) => entry.acknowledgedIds.has(event.id)),
					),
			);
			if (events.some((event) => !accepted.has(event.id) && !rejected.has(event.id))) return;
		}
	}
}

function baseProperties(executionMode: TelemetryExecutionMode): TelemetryProperties {
	return {
		version: VERSION,
		os_family: platform(),
		architecture: arch(),
		install_method: detectInstallMethod(),
		execution_mode: executionMode,
		schema_revision: TELEMETRY_CONTRACT.schema_revision,
		build_channel: VERSION.includes("-") ? "prerelease" : "release",
		workload_origin: ["internal", "test"].includes(process.env.PRIME_AGENT_TELEMETRY_ORIGIN ?? "")
			? (process.env.PRIME_AGENT_TELEMETRY_ORIGIN ?? "unknown")
			: "unknown",
	};
}

const telemetryClients = new WeakMap<SettingsManager, Map<string, TelemetryClient>>();

function telemetryClient(options: InstallAgentTelemetryOptions): TelemetrySink {
	if (options.sink) return options.sink;
	let clients = telemetryClients.get(options.settingsManager);
	if (!clients) {
		clients = new Map();
		telemetryClients.set(options.settingsManager, clients);
	}
	let client = clients.get(options.agentDir);
	if (!client) {
		client = new TelemetryClient({
			agentDir: options.agentDir,
			randomId: options.randomId,
			isEnabled: () => isTelemetryEnabled(options.settingsManager),
		});
		clients.set(options.agentDir, client);
		const activeClient = client;
		options.settingsManager.subscribeTelemetryEnabled(() => {
			if (!isTelemetryEnabled(options.settingsManager)) {
				activeClient.clearPending();
				clearOnboardingTelemetryContext(options.agentDir);
				clearInstallationTelemetryState(options.agentDir);
			}
		});
	}
	return client;
}

export interface CaptureTelemetryEventOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	executionMode?: AgentExecutionMode;
	name: TelemetryEventName;
	properties: TelemetryProperties;
	sink?: TelemetrySink;
}

export async function flushTelemetry(
	options: Pick<CaptureTelemetryEventOptions, "agentDir" | "settingsManager" | "sink">,
	timeoutMs = 1_500,
): Promise<void> {
	try {
		const sink = options.sink ?? telemetryClients.get(options.settingsManager)?.get(options.agentDir);
		if (!isTelemetryEnabled(options.settingsManager)) {
			if (sink instanceof TelemetryClient) sink.clearPending();
			return;
		}
		await sink?.flush({ timeoutMs });
	} catch {
		/* Controlled shutdown is bounded and must preserve its original result. */
	}
}

export function clearPendingTelemetry(
	options: Pick<CaptureTelemetryEventOptions, "agentDir" | "settingsManager" | "sink">,
): void {
	const sink = options.sink ?? telemetryClients.get(options.settingsManager)?.get(options.agentDir);
	if (sink instanceof TelemetryClient) sink.clearPending();
}

export function captureTelemetryEvent(options: CaptureTelemetryEventOptions): void {
	try {
		if (!isTelemetryEnabled(options.settingsManager)) return;
		const properties = sanitizeTelemetryProperties(options.name, {
			...baseProperties(options.executionMode ?? "unknown"),
			...options.properties,
		});
		if (properties) telemetryClient(options).capture(options.name, properties);
	} catch {
		/* Analytics must not interrupt the operation being measured. */
	}
}

const sessionContexts = new WeakMap<AgentSession, { sessionId: string; runId?: string }>();

export function getTelemetrySessionContext(session: AgentSession): { sessionId: string; runId?: string } | undefined {
	const context = sessionContexts.get(session);
	return context ? { ...context } : undefined;
}

export async function captureOnboardingCompleted(options: CaptureOnboardingCompletedOptions): Promise<void> {
	captureTelemetryEvent({
		...options,
		executionMode: "interactive",
		name: "onboarding completed",
		properties: {
			duration_ms: Math.max(0, options.durationMs),
			outcome: options.outcome,
			auth_category: telemetryAuthCategory(options.authSource, options.storedCredentialType),
			provider_category: telemetryProviderCategory(options.provider),
		},
	});
	void flushTelemetry(options, DEFAULT_REQUEST_TIMEOUT_MS);
}

export async function captureAgentCommandUsed(options: CaptureAgentCommandUsedOptions): Promise<void> {
	if (!isBuiltinSlashCommandName(options.commandName)) return;
	captureTelemetryEvent({
		...options,
		executionMode: "interactive",
		name: "agent command used",
		properties: {
			command_name: resolveBuiltinSlashCommandName(options.commandName),
		},
	});
	void flushTelemetry(options, DEFAULT_REQUEST_TIMEOUT_MS);
}

function runOutcome(message: AssistantMessage | undefined): "success" | "error" | "aborted" {
	if (message?.stopReason === "aborted") {
		return "aborted";
	}
	if (!message || message.stopReason === "error") {
		return "error";
	}
	return "success";
}

function assistantMessage(event: AgentSessionEvent): AssistantMessage | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") {
		return undefined;
	}
	return event.message;
}

function createActiveRun(now: () => number, id: string, index: number): ActiveRun {
	return {
		id,
		index,
		startedAt: now(),
		agentEnded: false,
		currentModelRequestObserved: false,
		successfulModelCallCount: 0,
		modelLatencyMs: 0,
		maxModelLatencyMs: 0,
		turnCount: 0,
		toolCallCount: 0,
		toolErrorCount: 0,
		compactionCount: 0,
		retryCount: 0,
		usage: newUsageTotals(),
		retryWaitMs: 0,
		compactionDurationMs: 0,
		usageComplete: true,
		pricingComplete: true,
		cancelled: false,
		tools: new Map(),
		unrecoveredTools: new Map(),
		pendingTools: new Map(),
	};
}

const instrumentedSessions = new WeakSet<AgentSession>();

function toolCategory(name: string): string {
	if (["read", "write", "edit", "bash", "grep", "find", "ls", "ipython"].includes(name)) return name;
	return name.startsWith("mcp__") ? "mcp" : "custom";
}

export function installAgentTelemetry(session: AgentSession, options: InstallAgentTelemetryOptions): void {
	if (instrumentedSessions.has(session)) return;
	instrumentedSessions.add(session);
	const now = options.now ?? (() => performance.now());
	const randomId = options.randomId ?? randomUUID;
	const sink = telemetryClient(options);
	let trackingEnabled = isTelemetryEnabled(options.settingsManager);
	let sessionId = trackingEnabled ? randomId() : undefined;
	if (sessionId) sessionContexts.set(session, { sessionId });
	const recovery = getTelemetryErrorRecoveryTracker(options.settingsManager, options.agentDir, {
		isEnabled: () => isTelemetryEnabled(options.settingsManager),
	});
	const sessionTotals: SessionTotals = {
		startedAt: now(),
		runCount: 0,
		successfulRunCount: 0,
		failedRunCount: 0,
		abortedRunCount: 0,
		promptCount: 0,
		toolCallCount: 0,
		compactionCount: 0,
		usage: newUsageTotals(),
	};
	let activeRun: ActiveRun | undefined;
	let standaloneCompaction: TelemetryOperation | undefined;
	let nextRunIndex = 0;
	let turnActionActive = false;
	let disposed = false;
	let lastProviderCategory: string | undefined;
	const goals = new Map<string, TelemetryOperation>();
	const childFailures = new Map<string, string>();
	const telemetry = new TelemetryScope({
		...options,
		sink,
		now,
		properties: (): TelemetryProperties => (sessionId ? { session_id: sessionId } : {}),
	});
	const capture = (name: TelemetryEventName, properties: TelemetryProperties): void => {
		telemetry.capture(name, properties);
	};
	const runProperties = (run = activeRun): TelemetryProperties => {
		const onboarding = run?.onboarding;
		const input = run?.input?.metadata;
		return {
			...(run ? { run_id: run.id, run_index: run.index } : {}),
			...(onboarding
				? {
						onboarding_id: onboarding.onboardingId,
						client_session_id: onboarding.clientSessionId,
						...(!input?.onboardingId || input.onboardingId === onboarding.onboardingId
							? { elapsed_since_onboarding_ms: Math.max(0, Date.now() - onboarding.startedAt) }
							: {}),
					}
				: {}),
			...(input
				? {
						input_id: input.inputId,
						...(input.clientSessionId ? { client_session_id: input.clientSessionId } : {}),
						...(input.onboardingId ? { onboarding_id: input.onboardingId } : {}),
					}
				: {}),
		};
	};
	const executionProperties = (run: ActiveRun): TelemetryProperties => {
		const context = run.executionContext;
		if (!context) return { context_source: "unknown" };
		const properties: TelemetryProperties = {
			provider_category: context.providerCategory,
			model_category: context.modelCategory,
			auth_source: context.authSource,
			team_scope: context.teamScope,
			endpoint_category: context.endpointCategory,
			context_source: run.contextSource ?? "unknown",
		};
		const comparisons = {
			setup: run.input?.metadata.setupContext ?? run.onboarding?.setupContext,
			ui: run.input?.metadata.uiContext,
		};
		const fields = {
			auth_source: "authSource",
			provider: "providerCategory",
			model: "modelCategory",
			team_scope: "teamScope",
			endpoint: "endpointCategory",
		} as const;
		for (const [prefix, previous] of Object.entries(comparisons)) {
			for (const [name, field] of Object.entries(fields)) {
				const before = previous?.[field];
				properties[`${prefix}_${name}_changed`] =
					before && before !== "unknown" && context[field] !== "unknown" ? before !== context[field] : null;
			}
		}
		return properties;
	};
	const timing = (stage: string, duration: number, outcome = "success", extra: TelemetryProperties = {}): void => {
		const provider = activeRun?.executionContext?.providerCategory;
		capture("agent timing", {
			...runProperties(),
			provider_category:
				provider && provider !== "unknown"
					? provider
					: telemetryProviderCategory(activeRun?.lastAssistant?.provider ?? session.model?.provider),
			stage,
			duration_ms: Math.max(0, duration),
			outcome,
			timing_origin: "worker_run",
			...extra,
		});
	};
	const finishStandaloneCompaction = (outcome: string): void => {
		standaloneCompaction?.finish("agent timing", { outcome });
		standaloneCompaction = undefined;
	};
	const reportError = (
		error: unknown,
		component: TelemetryErrorComponent,
		operation: TelemetryErrorOperation,
		stage: TelemetryErrorStage,
		occurrence?: object,
	): string | undefined => {
		const id = telemetry.error(error, {
			component,
			operation,
			stage,
			sessionId,
			occurrence,
			runId: activeRun?.id,
			inputId: activeRun?.input?.metadata.inputId,
			clientSessionId: activeRun?.input?.metadata.clientSessionId,
			retryAttempt: activeRun?.retryCount ?? 0,
			provider: activeRun?.lastAssistant?.provider ?? session.model?.provider,
		});
		if (id && activeRun) timing("time_to_error", now() - activeRun.startedAt, "error");
		return id;
	};
	const inputs = new TelemetryInputTracker({
		capture,
		onError: (error, input, runId) =>
			telemetry.error(error, {
				component: "session",
				operation: "execute",
				stage: "unknown",
				sessionId,
				runId,
				inputId: input.inputId,
				clientSessionId: input.clientSessionId,
				provider: session.model?.provider,
			}),
	});
	const finishRetryWait = (outcome = "success"): void => {
		if (activeRun?.retryStartedAt === undefined) return;
		const duration = Math.max(0, now() - activeRun.retryStartedAt);
		activeRun.retryWaitMs += duration;
		activeRun.retryStartedAt = undefined;
		timing("retry_wait", duration, outcome);
	};
	const finalizeRun = (shutdown = false): void => {
		const run = activeRun;
		if (!run) return;
		if (run.currentTurnStartedAt !== undefined) run.usageComplete = false;
		finishRetryWait(shutdown ? "shutdown_interrupted" : run.cancelled ? "cancelled" : "success");
		const terminal =
			run.actionOutcome === "failed"
				? "error"
				: run.actionOutcome === "cancelled"
					? "cancelled"
					: shutdown && (!run.agentEnded || turnActionActive)
						? "shutdown_interrupted"
						: run.cancelled || run.lastAssistant?.stopReason === "aborted"
							? "cancelled"
							: !run.lastAssistant
								? "unknown"
								: run.lastAssistant.stopReason === "error"
									? "error"
									: "success";
		const outcome = runOutcome(run.lastAssistant);
		const context = runProperties(run);
		const duration = Math.max(0, now() - run.startedAt);
		if (run.compactionStartedAt !== undefined) {
			run.compactionDurationMs += Math.max(0, now() - run.compactionStartedAt);
			timing("compaction", now() - run.compactionStartedAt, shutdown ? "shutdown_interrupted" : "unknown");
		}
		const lastAssistant = run.lastAssistant;
		const error = lastAssistant?.stopReason === "error" ? classifyTelemetryError(lastAssistant) : undefined;
		sessionTotals.runCount++;
		sessionTotals.toolCallCount += run.toolCallCount;
		sessionTotals.compactionCount += run.compactionCount;
		if (outcome === "success") sessionTotals.successfulRunCount++;
		else if (outcome === "aborted") sessionTotals.abortedRunCount++;
		else sessionTotals.failedRunCount++;
		addUsage(sessionTotals.usage, run.usage, run.usage.modelCallCount);
		const costKnown = run.pricingComplete && run.usageComplete && run.usage.modelCallCount > 0;
		capture("agent run completed", {
			...context,
			...executionProperties(run),
			outcome,
			terminal_outcome: terminal,
			duration_ms: duration,
			visible_ttft_ms: run.visibleTtftMs ?? null,
			first_model_event_ms: run.firstModelEventMs ?? null,
			first_status_ms: null,
			queue_wait_ms: run.input?.queueWaitMs ?? null,
			local_preparation_ms: run.input?.preparationMs ?? null,
			input_to_run_ms: run.input?.inputToRunMs ?? null,
			first_reasoning_ms: run.firstReasoningMs ?? null,
			run_to_first_text_ms: run.runToFirstTextMs ?? null,
			max_stream_gap_ms: run.maxStreamGapMs ?? null,
			model_latency_ms: run.modelLatencyMs,
			max_model_latency_ms: run.maxModelLatencyMs,
			model_call_count: run.usage.modelCallCount,
			successful_model_call_count: run.successfulModelCallCount,
			turn_count: run.turnCount,
			tool_call_count: run.toolCallCount,
			tool_error_count: run.toolErrorCount,
			tool_duration_ms:
				run.pendingTools.size === 0 && [...run.tools.values()].every((tool) => tool.measured === tool.calls)
					? [...run.tools.values()].reduce((total, tool) => total + tool.duration, 0)
					: null,
			retry_wait_ms: run.retryWaitMs,
			compaction_duration_ms: run.compactionDurationMs,
			input_tokens: run.usage.input,
			output_tokens: run.usage.output,
			cache_read_tokens: run.usage.cacheRead,
			cache_write_tokens: run.usage.cacheWrite,
			total_tokens: run.usage.totalTokens,
			usage_complete: run.usageComplete && run.usage.modelCallCount > 0,
			estimated_cost_usd: costKnown ? run.usage.cost.total : null,
			cost_revision: 1,
			compaction_count: run.compactionCount,
			retry_count: run.retryCount,
			provider_category: telemetryProviderCategory(lastAssistant?.provider),
			model_category: lastAssistant ? modelCategory(lastAssistant.model) : "unknown",
			error_category: error ? telemetryLegacyErrorCategory(lastAssistant?.errorMessage ?? "") : null,
			error_subtype: error?.error_subtype ?? "unknown",
			stop_reason: lastAssistant?.stopReason ?? "unknown",
		});
		for (const [category, tool] of run.tools)
			capture("agent tool summary", {
				...context,
				tool_category: category,
				call_count: tool.calls,
				failure_count: tool.failures,
				recovered_count: tool.recovered,
				duration_ms: tool.measured === tool.calls ? tool.duration : null,
			});
		lastProviderCategory = telemetryProviderCategory(lastAssistant?.provider ?? session.model?.provider);
		for (const properties of recovery.finishRun({
			sessionId,
			runId: run.id,
			providerCategory: lastProviderCategory,
			outcome: terminal,
		}))
			capture("agent error", properties);
		timing("terminal", duration, terminal);
		activeRun = undefined;
		if (sessionId) sessionContexts.set(session, { sessionId });
	};
	if (trackingEnabled) capture("agent started", {});
	const refreshConsent = (): boolean => {
		if (!isTelemetryEnabled(options.settingsManager)) {
			activeRun = undefined;
			standaloneCompaction = undefined;
			turnActionActive = false;
			goals.clear();
			childFailures.clear();
			inputs.clear();
			clearTelemetryInputs(session);
			recovery.clear();
			lastProviderCategory = undefined;
			sessionId = undefined;
			clearOnboardingTelemetryContext(options.agentDir);
			sessionContexts.delete(session);
			Object.assign(sessionTotals, {
				startedAt: now(),
				runCount: 0,
				successfulRunCount: 0,
				failedRunCount: 0,
				abortedRunCount: 0,
				promptCount: 0,
				toolCallCount: 0,
				compactionCount: 0,
				usage: newUsageTotals(),
			});
			trackingEnabled = false;
			void sink.flush().catch(() => {});
			return false;
		}
		if (!trackingEnabled) {
			trackingEnabled = true;
			sessionId = randomId();
			nextRunIndex = 0;
			sessionTotals.startedAt = now();
			sessionContexts.set(session, { sessionId });
			capture("agent started", {});
		}
		return true;
	};
	const unsubscribeConsent = options.settingsManager.subscribeTelemetryEnabled(refreshConsent);
	const unsubscribeInputs = subscribeTelemetryInputs(
		session,
		(observation) => {
			if (!refreshConsent()) return;
			if (
				activeRun?.input?.metadata.inputId === observation.input.inputId &&
				observation.action?.kind === "turn" &&
				(observation.action.state === "failed" || observation.action.state === "cancelled")
			)
				activeRun.actionOutcome = observation.action.state;
			inputs.observe(observation);
		},
		{ isEnabled: () => isTelemetryEnabled(options.settingsManager), now, randomId },
	);
	const unsubscribeContext = subscribeTelemetryExecutionContexts(
		session,
		(context) => {
			if (!refreshConsent() || !activeRun) return;
			activeRun.executionContext = context;
			activeRun.contextSource = "request";
			activeRun.currentModelRequestObserved = activeRun.currentTurnStartedAt !== undefined;
			if (activeRun.firstProviderDispatchAt === undefined) {
				activeRun.firstProviderDispatchAt = now();
				timing("provider_dispatch", now() - activeRun.startedAt, "success");
			}
		},
		() => isTelemetryEnabled(options.settingsManager),
	);
	const unsubscribe = session.subscribe((event) => {
		try {
			if (!refreshConsent()) return;
			switch (event.type) {
				case "session_action_update":
					turnActionActive = event.actions.active?.kind === "turn";
					if (!turnActionActive && activeRun && (activeRun.agentEnded || activeRun.actionOutcome)) finalizeRun();
					break;
				case "agent_start":
					if (activeRun?.agentEnded && !turnActionActive) finalizeRun();
					if (!activeRun) {
						activeRun = createActiveRun(now, randomId(), ++nextRunIndex);
						activeRun.onboarding = getCurrentOnboardingTelemetryContext(options.agentDir);
						activeRun.input = inputs.attachRun(activeRun.id, activeRun.startedAt);
						activeRun.executionContext = getTelemetryExecutionContext(session.modelRegistry, session.model);
						activeRun.contextSource = "configured";
						const recoveryAction = activeRun.input?.metadata.recoveryAction;
						if (recoveryAction)
							for (const properties of recovery.noteRecoveryAction(recoveryAction, {
								sessionId,
								providerCategory: lastProviderCategory,
								components: ["provider", "authentication", "session"],
								targetProviderCategory: activeRun.executionContext.providerCategory,
							}))
								capture("agent error", properties);
						if (sessionId) sessionContexts.set(session, { sessionId, runId: activeRun.id });
						capture("agent run started", {
							...runProperties(),
							...executionProperties(activeRun),
							trigger: "unknown",
						});
					}
					finishRetryWait();
					activeRun.agentEnded = false;
					break;
				case "message_start":
					if (event.message.role === "user") sessionTotals.promptCount++;
					break;
				case "turn_start":
					if (activeRun) {
						activeRun.currentTurnStartedAt = now();
						activeRun.currentModelRequestObserved = false;
						activeRun.firstTurnStartedAt ??= activeRun.currentTurnStartedAt;
						activeRun.lastStreamEventAt = undefined;
						activeRun.turnCount++;
					}
					break;
				case "message_update": {
					if (!activeRun) break;
					const at = now();
					if (activeRun.firstModelEventMs === undefined && activeRun.firstTurnStartedAt !== undefined) {
						activeRun.firstModelEventMs = Math.max(0, at - activeRun.firstTurnStartedAt);
						timing("first_model_event", at - activeRun.startedAt);
					}
					if (activeRun.lastStreamEventAt !== undefined)
						activeRun.maxStreamGapMs = Math.max(activeRun.maxStreamGapMs ?? 0, at - activeRun.lastStreamEventAt);
					activeRun.lastStreamEventAt = at;
					const delta = event.assistantMessageEvent;
					if (delta.type === "thinking_delta" && delta.delta.length && activeRun.firstReasoningMs === undefined) {
						activeRun.firstReasoningMs = Math.max(0, at - activeRun.startedAt);
						timing("first_reasoning", activeRun.firstReasoningMs);
					}
					if (delta.type === "text_delta" && delta.delta.length && activeRun.runToFirstTextMs === undefined) {
						activeRun.runToFirstTextMs = Math.max(0, at - activeRun.startedAt);
						activeRun.visibleTtftMs =
							activeRun.firstTurnStartedAt === undefined
								? undefined
								: Math.max(0, at - activeRun.firstTurnStartedAt);
						timing("first_text", activeRun.runToFirstTextMs);
					}
					break;
				}
				case "message_end": {
					if (isSessionSlashCommandMessage(event.message) && event.message.details.command.name === "goal") {
						const key = event.message.details.commandEntryId;
						if (key && !goals.has(key)) {
							const args = event.message.details.command.args.trim();
							const goal = telemetry.start({
								...runProperties(),
								feature_id: randomId(),
								feature_name: "goal",
								configuration_choice: ["status", "pause", "resume", "clear"].includes(args)
									? args
									: args
										? "create"
										: "status",
							});
							if (goals.size >= 64) goals.delete(goals.keys().next().value ?? "");
							goals.set(key, goal);
							goal.record("agent feature outcome", { outcome: "initiated" });
						}
					} else if (
						isSessionSlashCommandResultMessage(event.message) &&
						event.message.details.command.name === "goal"
					) {
						const key = event.message.details.commandEntryId;
						const goal = key ? goals.get(key) : undefined;
						if (key && goal) {
							goals.delete(key);
							goal.finish("agent feature outcome", {
								...runProperties(),
								outcome: event.message.details.success ? "completed" : "failed",
							});
						}
					}
					const message = assistantMessage(event);
					if (!activeRun || !message) break;
					if (activeRun.currentModelRequestObserved && ["stop", "length", "toolUse"].includes(message.stopReason))
						activeRun.successfulModelCallCount++;
					activeRun.currentModelRequestObserved = false;
					activeRun.lastAssistant = message;
					const usage = message.usage;
					const valid = [
						usage.input,
						usage.output,
						usage.cacheRead,
						usage.cacheWrite,
						usage.totalTokens,
						...Object.values(usage.cost),
					].every((value) => Number.isFinite(value) && value >= 0);
					if (valid) addUsage(activeRun.usage, usage);
					else activeRun.usage.modelCallCount++;
					activeRun.usageComplete &&=
						valid && usage.totalTokens > 0 && message.stopReason !== "error" && message.stopReason !== "aborted";
					const model = session.model;
					activeRun.pricingComplete &&=
						model?.id === message.model &&
						model.provider === message.provider &&
						Object.values(model.cost).every((value) => Number.isFinite(value) && value >= 0) &&
						Object.values(model.cost).some((value) => value > 0);
					if (message.stopReason === "error") reportError(message, "provider", "stream", "model_stream");
					if (activeRun.currentTurnStartedAt !== undefined) {
						const latency = Math.max(0, now() - activeRun.currentTurnStartedAt);
						activeRun.modelLatencyMs += latency;
						activeRun.maxModelLatencyMs = Math.max(activeRun.maxModelLatencyMs, latency);
						activeRun.currentTurnStartedAt = undefined;
					}
					if (activeRun.lastStreamEventAt !== undefined)
						activeRun.maxStreamGapMs = Math.max(
							activeRun.maxStreamGapMs ?? 0,
							now() - activeRun.lastStreamEventAt,
						);
					activeRun.lastStreamEventAt = undefined;
					break;
				}
				case "tool_execution_start":
					if (activeRun && activeRun.pendingTools.size < 256)
						activeRun.pendingTools.set(event.toolCallId, {
							category: toolCategory(event.toolName),
							startedAt: now(),
						});
					break;
				case "tool_execution_end":
					if (activeRun) {
						const pending = activeRun.pendingTools.get(event.toolCallId);
						activeRun.pendingTools.delete(event.toolCallId);
						const category = pending?.category ?? toolCategory(event.toolName);
						const tool = activeRun.tools.get(category) ?? {
							calls: 0,
							failures: 0,
							duration: 0,
							measured: 0,
							recovered: 0,
						};
						tool.calls++;
						activeRun.toolCallCount++;
						if (pending) {
							const duration = Math.max(0, now() - pending.startedAt);
							tool.duration += duration;
							tool.measured++;
							timing("tool", duration, event.isError ? "error" : "success", { tool_category: category });
						}
						if (event.isError) {
							tool.failures++;
							activeRun.toolErrorCount++;
							const id = reportError(
								event.result,
								category === "mcp" ? "mcp" : "tools",
								"execute",
								"tool_execution",
								{},
							);
							if (activeRun.unrecoveredTools.size < 256 || activeRun.unrecoveredTools.has(event.toolName)) {
								const failures = activeRun.unrecoveredTools.get(event.toolName) ?? { count: 0, errorIds: [] };
								failures.count++;
								if (id && failures.errorIds.length < 128) failures.errorIds.push(id);
								activeRun.unrecoveredTools.set(event.toolName, failures);
							}
						} else {
							const failures = activeRun.unrecoveredTools.get(event.toolName);
							tool.recovered += failures?.count ?? 0;
							if (failures)
								for (const properties of recovery.finishErrors(failures.errorIds, {
									sessionId,
									runId: activeRun.id,
									components: ["tools", "mcp"],
								}))
									capture("agent error", properties);
							activeRun.unrecoveredTools.delete(event.toolName);
						}
						activeRun.tools.set(category, tool);
					}
					break;
				case "compaction_start":
					if (activeRun) activeRun.compactionStartedAt = now();
					else
						standaloneCompaction = telemetry.start({
							stage: "compaction",
							timing_origin: "worker_action",
							provider_category: telemetryProviderCategory(session.model?.provider),
						});
					break;
				case "compaction_end":
					if (standaloneCompaction)
						finishStandaloneCompaction(event.aborted ? "cancelled" : event.errorMessage ? "error" : "success");
					else if (activeRun) {
						if (event.result && !event.aborted) activeRun.compactionCount++;
						if (activeRun.compactionStartedAt !== undefined) {
							const duration = Math.max(0, now() - activeRun.compactionStartedAt);
							activeRun.compactionDurationMs += duration;
							activeRun.compactionStartedAt = undefined;
							timing(
								"compaction",
								duration,
								event.aborted ? "cancelled" : event.errorMessage ? "error" : "success",
							);
						}
					}
					if (event.errorMessage) reportError(event.errorMessage, "compaction", "compact", "compaction");
					break;
				case "auto_retry_start":
					if (activeRun) {
						activeRun.retryCount++;
						activeRun.retryStartedAt = now();
						for (const properties of recovery.noteRecoveryAction("automatic_retry", {
							sessionId,
							runId: activeRun.id,
							providerCategory: telemetryProviderCategory(activeRun.lastAssistant?.provider),
							components: ["provider", "authentication"],
							retryBackoffMs: event.delayMs,
						}))
							capture("agent error", properties);
					}
					break;
				case "auto_retry_end":
					if (!event.success && event.finalError === "Retry cancelled" && activeRun) activeRun.cancelled = true;
					else if (
						!event.success &&
						event.finalError &&
						event.finalError !== activeRun?.lastAssistant?.errorMessage
					)
						reportError(event.finalError, "provider", "retry", "model_request");
					finishRetryWait(activeRun?.cancelled ? "cancelled" : event.success ? "success" : "error");
					break;
				case "rlm_child_update":
					if (event.child.status !== "error") childFailures.delete(event.child.id);
					else if (!childFailures.has(event.child.id)) {
						if (childFailures.size >= 256) childFailures.delete(childFailures.keys().next().value ?? "");
						childFailures.set(event.child.id, "error");
						reportError(event.child.error, "background", "execute", "background");
					}
					break;
				case "refine_failed":
					reportError(event.error, "background", "execute", "background");
					break;
				case "bash_end":
					if (event.errorMessage && !event.cancelled)
						reportError(event.errorMessage, "tools", "execute", "tool_execution");
					break;
				case "agent_end":
					if (activeRun) {
						activeRun.agentEnded = true;
						if (!turnActionActive) finalizeRun();
					}
					break;
			}
		} catch {
			/* Malformed analytics input must not change runtime behavior. */
		}
	});
	session.registerDisposeCallback(async () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		unsubscribeConsent();
		unsubscribeInputs();
		unsubscribeContext();
		inputs.clear();
		if (!refreshConsent()) {
			telemetry.dispose();
			return;
		}
		const interrupted =
			standaloneCompaction !== undefined || (activeRun !== undefined && (!activeRun.agentEnded || turnActionActive));
		finalizeRun(true);
		if (standaloneCompaction) finishStandaloneCompaction("shutdown_interrupted");
		sessionContexts.delete(session);
		capture("agent session ended", {
			terminal_outcome: interrupted ? "shutdown_interrupted" : "success",
			duration_ms: Math.max(0, now() - sessionTotals.startedAt),
			prompt_count: sessionTotals.promptCount,
			run_count: sessionTotals.runCount,
			successful_run_count: sessionTotals.successfulRunCount,
			failed_run_count: sessionTotals.failedRunCount,
			aborted_run_count: sessionTotals.abortedRunCount,
			tool_call_count: sessionTotals.toolCallCount,
			compaction_count: sessionTotals.compactionCount,
			model_call_count: sessionTotals.usage.modelCallCount,
			input_tokens: sessionTotals.usage.input,
			output_tokens: sessionTotals.usage.output,
			cache_read_tokens: sessionTotals.usage.cacheRead,
			cache_write_tokens: sessionTotals.usage.cacheWrite,
			total_tokens: sessionTotals.usage.totalTokens,
		});
		telemetry.dispose();
		try {
			await sink.flush({ timeoutMs: 1_500 });
		} catch {
			/* Shutdown remains best-effort. */
		}
	});
}
