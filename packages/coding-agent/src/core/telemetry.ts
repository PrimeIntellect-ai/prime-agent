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

const DEFAULT_TELEMETRY_ENDPOINT = "https://api.primeintellect.ai/api/v1/agent-analytics/events";
const TELEMETRY_STATE_FILE = "telemetry.json";
const TELEMETRY_STATE_VERSION = 1;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 7_000;

export type { TelemetryProperties } from "./telemetry-schema.js";

import { isSessionSlashCommandMessage, isSessionSlashCommandResultMessage } from "./messages.js";
import { TELEMETRY_CONTRACT } from "./telemetry-contract.js";
import { telemetryErrorProperties } from "./telemetry-error-classification.js";
import {
	clearOnboardingTelemetryContext,
	getCurrentOnboardingTelemetryContext,
	type OnboardingTelemetryContext,
} from "./telemetry-journey-state.js";
import {
	isLegacyTelemetryEvent,
	isTelemetryUuid,
	sanitizeTelemetryProperties,
	type TelemetryProperties,
} from "./telemetry-schema.js";

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
	| "agent startup stage";

export type TelemetryExecutionMode = AgentExecutionMode | "unknown";
export type TelemetryOnboardingOutcome = "success" | "error" | "aborted";
export type TelemetryAuthCategory =
	| "oauth"
	| "api_key"
	| "runtime_api_key"
	| "environment"
	| "prime_cli"
	| "models_json"
	| "fallback"
	| "stale"
	| "stored"
	| "none";

export interface TelemetryEvent {
	id: string;
	name: TelemetryEventName;
	timestamp: string;
	properties: TelemetryProperties;
}

export interface TelemetryBatch {
	schema_version?: number;
	installation_id: string;
	events: TelemetryEvent[];
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
	id: string;
	index: number;
	startedAt: number;
	agentEnded: boolean;
	firstTurnStartedAt?: number;
	firstModelEventMs?: number;
	visibleTtftMs?: number;
	currentTurnStartedAt?: number;
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
	tools: Map<string, { calls: number; failures: number; duration: number; measured: number }>;
	pendingTools: Map<string, { category: string; startedAt: number }>;
	failures: Array<{ properties: TelemetryProperties; id: string }>;
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

function addUsage(target: UsageTotals, usage: Usage): void {
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
	target.modelCallCount++;
}

function mergeUsage(target: UsageTotals, usage: UsageTotals): void {
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
	target.modelCallCount += usage.modelCallCount;
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

function isInstallationId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	);
}

function readInstallationId(path: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryState>;
		return parsed.version === TELEMETRY_STATE_VERSION && isInstallationId(parsed.installationId)
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
	if (!isInstallationId(installationId)) {
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
	private queue: Array<{ event: TelemetryEvent; attempts: number; queuedAt: number }> = [];
	private flushTimer?: ReturnType<typeof setTimeout>;
	private flushInFlight?: Promise<void>;
	private discovery?: Promise<void>;
	private nextDiscoveryAt = 0;
	private supportsV2 = false;
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
			this.queue.push({ event, attempts: 0, queuedAt: this.now() });
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
				this.supportsV2 =
					typeof body === "object" &&
					body !== null &&
					"schema_versions" in body &&
					Array.isArray(body.schema_versions) &&
					body.schema_versions.includes(2);
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
			await Promise.race([
				this.discovery,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, Math.min(250, timeoutMs / 2));
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
			const entries = pending
				.splice(0, this.batchSize)
				.filter((entry) => version2 || isLegacyTelemetryEvent(entry.event.name));
			if (!entries.length) continue;
			const events = entries.flatMap(({ event }) => {
				const properties = sanitizeTelemetryProperties(event.name, event.properties, !version2);
				return properties ? [{ ...event, properties }] : [];
			});
			if (!events.length) continue;
			const batch: TelemetryBatch = {
				installation_id: this.installationId,
				events,
				...(version2 ? { schema_version: 2 } : {}),
			};
			while (Buffer.byteLength(JSON.stringify(batch), "utf8") > 30_000 && events.length > 1) {
				events.pop();
				const deferred = entries.pop();
				if (deferred) pending.unshift(deferred);
			}
			for (const entry of entries) entry.attempts++;
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
				this.nextDiscoveryAt = this.now() + 60_000;
				this.delivery.retries += entries.length;
				return;
			}
			if (!response?.ok) {
				this.delivery.unavailable += entries.length;
				this.delivery.retries += entries.length;
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
			this.queue = this.queue.filter(
				(entry) =>
					!events.some(
						(event) => event.id === entry.event.id && (accepted.has(event.id) || rejected.has(event.id)),
					),
			);
			if (events.some((event) => !accepted.has(event.id) && !rejected.has(event.id))) return;
		}
	}
}

function modelCategory(model: string): string {
	const normalized = model.toLowerCase();
	const categories = [
		"claude",
		"gpt",
		"o1",
		"o3",
		"o4",
		"gemini",
		"glm",
		"kimi",
		"qwen",
		"deepseek",
		"llama",
		"mistral",
	];
	return categories.find((category) => normalized.includes(category)) ?? "custom";
}

export function telemetryProviderCategory(provider: string | undefined): string {
	if (!provider) {
		return "unknown";
	}
	const normalized = provider.toLowerCase();
	const categories = [
		"anthropic",
		"openai",
		"google",
		"prime",
		"openrouter",
		"bedrock",
		"vertex",
		"mistral",
		"groq",
		"xai",
	];
	return categories.find((category) => normalized.includes(category)) ?? "custom";
}

export function telemetryAuthCategory(
	source: AuthStatus["source"],
	storedCredentialType?: AuthCredential["type"],
): TelemetryAuthCategory {
	switch (source) {
		case "stored":
			return storedCredentialType ?? "stored";
		case "runtime":
			return "runtime_api_key";
		case "environment":
			return "environment";
		case "prime_cli":
			return "prime_cli";
		case "models_json_key":
		case "models_json_command":
			return "models_json";
		case "fallback":
			return "fallback";
		case "stale":
			return "stale";
		default:
			return "none";
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
			: executionMode === "interactive"
				? "interactive"
				: executionMode === "unknown"
					? "unknown"
					: "automated",
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
	try {
		if (isTelemetryEnabled(options.settingsManager))
			void telemetryClient(options)
				.flush()
				.catch(() => {});
	} catch {
		// Optional telemetry delivery must not interrupt onboarding.
	}
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
	try {
		if (isTelemetryEnabled(options.settingsManager))
			void telemetryClient(options)
				.flush()
				.catch(() => {});
	} catch {
		// Optional telemetry delivery must not interrupt the command.
	}
}

function errorCategory(message: AssistantMessage | undefined): string | null {
	if (!message || message.stopReason !== "error") {
		return null;
	}
	const error = message.errorMessage?.toLowerCase() ?? "";
	if (/\b401\b|\b403\b|auth|api.?key|credential|unauthori[sz]ed|forbidden/.test(error)) {
		return "authentication";
	}
	if (/\b429\b|rate.?limit|quota/.test(error)) {
		return "rate_limit";
	}
	if (/timeout|timed out/.test(error)) {
		return "timeout";
	}
	if (/context|token.*limit|too long|maximum.*length/.test(error)) {
		return "context_limit";
	}
	if (/network|socket|connection|fetch/.test(error)) {
		return "network";
	}
	if (/\b5\d\d\b|overload|unavailable/.test(error)) {
		return "provider_unavailable";
	}
	return "other";
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
		pendingTools: new Map(),
		failures: [],
	};
}

const instrumentedSessions = new WeakSet<AgentSession>();

function toolCategory(name: string): string {
	if (["read", "write", "edit", "bash", "grep", "find", "ls", "ipython"].includes(name)) return name;
	return name.startsWith("mcp__") ? "mcp" : "custom";
}

export function installAgentTelemetry(session: AgentSession, options: InstallAgentTelemetryOptions): void {
	if (!isTelemetryEnabled(options.settingsManager) || instrumentedSessions.has(session)) return;
	instrumentedSessions.add(session);
	const now = options.now ?? (() => performance.now());
	const randomId = options.randomId ?? randomUUID;
	const sink = telemetryClient(options);
	let sessionId = randomId();
	sessionContexts.set(session, { sessionId });
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
	let nextRunIndex = 0;
	let turnActionActive = false;
	let disposed = false;
	let trackingEnabled = true;
	const goals = new Map<string, { id: string; startedAt: number; choice: string }>();
	const childFailures = new Map<string, string>();
	const commonProperties = (): TelemetryProperties => ({
		...baseProperties(options.executionMode ?? "unknown"),
		session_id: sessionId,
	});
	const capture = (name: TelemetryEventName, properties: TelemetryProperties): void => {
		try {
			if (!isTelemetryEnabled(options.settingsManager)) return;
			const safe = sanitizeTelemetryProperties(name, { ...commonProperties(), ...properties });
			if (safe) sink.capture(name, safe);
		} catch {
			/* Telemetry observers cannot interrupt a session. */
		}
	};
	const runProperties = (run = activeRun): TelemetryProperties => {
		const onboarding = run?.onboarding;
		return {
			...(run ? { run_id: run.id, run_index: run.index } : {}),
			...(onboarding
				? {
						onboarding_id: onboarding.onboardingId,
						client_session_id: onboarding.clientSessionId,
						elapsed_since_onboarding_ms: Math.max(0, Date.now() - onboarding.startedAt),
					}
				: {}),
		};
	};
	const timing = (stage: string, duration: number, outcome = "success", extra: TelemetryProperties = {}): void => {
		capture("agent timing", { ...runProperties(), stage, duration_ms: Math.max(0, duration), outcome, ...extra });
	};
	const reportError = (error: unknown, component: string, operation: string, stage: string): void => {
		const properties = {
			...runProperties(),
			...telemetryErrorProperties(error),
			component,
			operation,
			stage,
			retry_attempt: activeRun?.retryCount ?? 0,
			provider_category: telemetryProviderCategory(activeRun?.lastAssistant?.provider),
		};
		const id = randomId();
		capture("agent error", {
			...properties,
			error_id: id,
			recovery_action: "none",
			recovery_outcome: "not_observed",
		});
		if (activeRun && component === "provider" && activeRun.failures.length < 64)
			activeRun.failures.push({ properties, id });
	};
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
			shutdown && (!run.agentEnded || turnActionActive)
				? "shutdown_interrupted"
				: run.cancelled || run.lastAssistant?.stopReason === "aborted"
					? "cancelled"
					: !run.lastAssistant
						? "unknown"
						: runOutcome(run.lastAssistant);
		const outcome = runOutcome(run.lastAssistant);
		const context = runProperties(run);
		const duration = Math.max(0, now() - run.startedAt);
		if (run.compactionStartedAt !== undefined) {
			run.compactionDurationMs += Math.max(0, now() - run.compactionStartedAt);
			timing("compaction", now() - run.compactionStartedAt, shutdown ? "shutdown_interrupted" : "unknown");
		}
		const lastAssistant = run.lastAssistant;
		sessionTotals.runCount++;
		sessionTotals.toolCallCount += run.toolCallCount;
		sessionTotals.compactionCount += run.compactionCount;
		if (outcome === "success") sessionTotals.successfulRunCount++;
		else if (outcome === "aborted") sessionTotals.abortedRunCount++;
		else sessionTotals.failedRunCount++;
		mergeUsage(sessionTotals.usage, run.usage);
		const costKnown = run.pricingComplete && run.usageComplete && run.usage.modelCallCount > 0;
		capture("agent run completed", {
			...context,
			outcome,
			terminal_outcome: terminal,
			duration_ms: duration,
			visible_ttft_ms: run.visibleTtftMs ?? null,
			first_model_event_ms: run.firstModelEventMs ?? null,
			first_status_ms: null,
			first_reasoning_ms: run.firstReasoningMs ?? null,
			run_to_first_text_ms: run.runToFirstTextMs ?? null,
			max_stream_gap_ms: run.maxStreamGapMs ?? null,
			model_latency_ms: run.modelLatencyMs,
			max_model_latency_ms: run.maxModelLatencyMs,
			model_call_count: run.usage.modelCallCount,
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
			error_category: errorCategory(lastAssistant),
			error_subtype:
				lastAssistant?.stopReason === "error" ? telemetryErrorProperties(lastAssistant).error_subtype : "unknown",
			stop_reason: lastAssistant?.stopReason ?? "unknown",
		});
		for (const [category, tool] of run.tools)
			capture("agent tool summary", {
				...context,
				tool_category: category,
				call_count: tool.calls,
				failure_count: tool.failures,
				duration_ms: tool.measured === tool.calls ? tool.duration : null,
			});
		for (const failure of run.failures)
			capture("agent error", {
				...failure.properties,
				error_id: failure.id,
				recovery_action: run.retryCount > 0 ? "automatic_retry" : terminal === "cancelled" ? "cancelled" : "none",
				recovery_outcome:
					terminal === "success"
						? "success"
						: terminal === "cancelled"
							? "cancelled"
							: terminal === "error"
								? "failed"
								: "not_observed",
			});
		timing("terminal", duration, terminal);
		activeRun = undefined;
		sessionContexts.set(session, { sessionId });
	};
	capture("agent started", {});
	const refreshConsent = (): boolean => {
		if (!isTelemetryEnabled(options.settingsManager)) {
			activeRun = undefined;
			turnActionActive = false;
			goals.clear();
			childFailures.clear();
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
	const unsubscribe = session.subscribe((event) => {
		try {
			if (!refreshConsent()) return;
			switch (event.type) {
				case "session_action_update":
					turnActionActive = event.actions.active?.kind === "turn";
					if (!turnActionActive && activeRun?.agentEnded) finalizeRun();
					break;
				case "agent_start":
					if (activeRun?.agentEnded && !turnActionActive) finalizeRun();
					if (!activeRun) {
						activeRun = createActiveRun(now, randomId(), ++nextRunIndex);
						activeRun.onboarding = getCurrentOnboardingTelemetryContext(options.agentDir);
						sessionContexts.set(session, { sessionId, runId: activeRun.id });
						capture("agent run started", { ...runProperties(), trigger: "unknown" });
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
							const goal = {
								id: randomId(),
								startedAt: now(),
								choice: ["status", "pause", "resume", "clear"].includes(args)
									? args
									: args
										? "create"
										: "status",
							};
							if (goals.size >= 64) goals.delete(goals.keys().next().value ?? "");
							goals.set(key, goal);
							capture("agent feature outcome", {
								...runProperties(),
								feature_id: goal.id,
								feature_name: "goal",
								outcome: "initiated",
								configuration_choice: goal.choice,
							});
						}
					} else if (
						isSessionSlashCommandResultMessage(event.message) &&
						event.message.details.command.name === "goal"
					) {
						const key = event.message.details.commandEntryId;
						const goal = key ? goals.get(key) : undefined;
						if (key && goal) {
							goals.delete(key);
							capture("agent feature outcome", {
								...runProperties(),
								feature_id: goal.id,
								feature_name: "goal",
								outcome: event.message.details.success ? "completed" : "failed",
								configuration_choice: goal.choice,
								duration_ms: Math.max(0, now() - goal.startedAt),
							});
						}
					}
					const message = assistantMessage(event);
					if (!activeRun || !message) break;
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
						const tool = activeRun.tools.get(category) ?? { calls: 0, failures: 0, duration: 0, measured: 0 };
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
							reportError(event.result, category === "mcp" ? "mcp" : "tools", "execute", "tool_execution");
						}
						activeRun.tools.set(category, tool);
					}
					break;
				case "compaction_start":
					if (activeRun) activeRun.compactionStartedAt = now();
					break;
				case "compaction_end":
					if (activeRun) {
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
						const previous = activeRun.failures.at(-1);
						if (previous) previous.properties.retry_backoff_ms = event.delayMs;
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
		const interrupted = activeRun !== undefined && (!activeRun.agentEnded || turnActionActive);
		finalizeRun(true);
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
		try {
			await sink.flush({ timeoutMs: 1_500 });
		} catch {
			/* Shutdown remains best-effort. */
		}
	});
}
