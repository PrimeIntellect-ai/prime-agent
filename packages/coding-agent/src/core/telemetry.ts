import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { detectInstallMethod, VERSION } from "../config.js";
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
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;

type TelemetryPrimitive = string | number | boolean | null;
type TelemetryProperties = Record<string, TelemetryPrimitive>;

export type TelemetryEventName =
	| "agent started"
	| "onboarding completed"
	| "agent command used"
	| "agent run completed"
	| "agent session ended";

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
	installation_id: string;
	events: TelemetryEvent[];
}

export interface TelemetrySink {
	capture(name: TelemetryEventName, properties: TelemetryProperties): void;
	flush(): Promise<void>;
}

interface TelemetryState {
	version: number;
	installationId: string;
}

interface TelemetryClientOptions {
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
	if (process.env.NODE_ENV === "test") {
		return false;
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
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(state, null, 2), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporaryPath, path);
	} finally {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// The rename succeeded or the temporary file was never created.
		}
	}
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
	private queue: TelemetryEvent[] = [];
	private flushTimer?: ReturnType<typeof setTimeout>;
	private flushInFlight?: Promise<void>;
	private disabled = false;

	constructor(private readonly options: TelemetryClientOptions) {
		this.endpoint = options.endpoint ?? process.env.PRIME_AGENT_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT;
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.randomId = options.randomId ?? randomUUID;
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	capture(name: TelemetryEventName, properties: TelemetryProperties): void {
		if (this.disabled) {
			return;
		}
		try {
			this.installationId ??= getOrCreateTelemetryInstallationId(this.options.agentDir, this.randomId);
			this.queue.push({
				id: this.randomId(),
				name,
				timestamp: new Date(this.now()).toISOString(),
				properties,
			});
		} catch {
			this.disabled = true;
			this.queue = [];
			return;
		}
		if (this.queue.length >= this.batchSize) {
			void this.flush();
			return;
		}
		this.scheduleFlush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, this.flushIntervalMs);
		this.flushTimer.unref?.();
	}

	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.flushInFlight) {
			await this.flushInFlight;
			if (this.queue.length > 0) {
				await this.flush();
			}
			return;
		}
		if (this.queue.length === 0 || !this.installationId) {
			return;
		}

		const drain = this.drainQueue();
		this.flushInFlight = drain;
		try {
			await drain;
		} finally {
			if (this.flushInFlight === drain) {
				this.flushInFlight = undefined;
			}
		}
		if (this.queue.length > 0) {
			await this.flush();
		}
	}

	private async drainQueue(): Promise<void> {
		while (this.queue.length > 0 && this.installationId) {
			const events = this.queue.splice(0, this.batchSize);
			const batch: TelemetryBatch = {
				installation_id: this.installationId,
				events,
			};
			await this.send(batch);
		}
	}

	private async send(batch: TelemetryBatch): Promise<void> {
		try {
			await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"user-agent": `prime-agent/${VERSION}`,
				},
				body: JSON.stringify(batch),
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch {
			// Product analytics is best-effort and must never affect the agent.
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
	};
}

export async function captureOnboardingCompleted(options: CaptureOnboardingCompletedOptions): Promise<void> {
	if (!isTelemetryEnabled(options.settingsManager)) {
		return;
	}

	const now = options.now ?? Date.now;
	const randomId = options.randomId ?? randomUUID;
	const sink =
		options.sink ??
		new TelemetryClient({
			agentDir: options.agentDir,
			now,
			randomId,
		});
	sink.capture("onboarding completed", {
		...baseProperties("interactive"),
		duration_ms: Math.max(0, options.durationMs),
		outcome: options.outcome,
		auth_category: telemetryAuthCategory(options.authSource, options.storedCredentialType),
		provider_category: telemetryProviderCategory(options.provider),
	});
	await sink.flush();
}

export async function captureAgentCommandUsed(options: CaptureAgentCommandUsedOptions): Promise<void> {
	if (!isBuiltinSlashCommandName(options.commandName) || !isTelemetryEnabled(options.settingsManager)) {
		return;
	}
	const commandName = resolveBuiltinSlashCommandName(options.commandName);

	const now = options.now ?? Date.now;
	const randomId = options.randomId ?? randomUUID;
	const sink =
		options.sink ??
		new TelemetryClient({
			agentDir: options.agentDir,
			now,
			randomId,
		});
	sink.capture("agent command used", {
		...baseProperties("interactive"),
		command_name: commandName,
	});
	await sink.flush();
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

function createActiveRun(now: () => number): ActiveRun {
	return {
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
	};
}

export function installAgentTelemetry(session: AgentSession, options: InstallAgentTelemetryOptions): void {
	if (!isTelemetryEnabled(options.settingsManager)) {
		return;
	}

	const now = options.now ?? Date.now;
	const randomId = options.randomId ?? randomUUID;
	const sink =
		options.sink ??
		new TelemetryClient({
			agentDir: options.agentDir,
			now,
			randomId,
		});
	const sessionId = randomId();
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
	let turnActionActive = false;

	const commonProperties = (): TelemetryProperties => ({
		...baseProperties(options.executionMode ?? "unknown"),
		session_id: sessionId,
	});

	const finalizeRun = (): void => {
		const run = activeRun;
		if (!run) {
			return;
		}
		activeRun = undefined;
		const outcome = runOutcome(run.lastAssistant);
		sessionTotals.runCount++;
		sessionTotals.toolCallCount += run.toolCallCount;
		sessionTotals.compactionCount += run.compactionCount;
		if (outcome === "success") {
			sessionTotals.successfulRunCount++;
		} else if (outcome === "aborted") {
			sessionTotals.abortedRunCount++;
		} else {
			sessionTotals.failedRunCount++;
		}
		mergeUsage(sessionTotals.usage, run.usage);
		const lastAssistant = run.lastAssistant;
		sink.capture("agent run completed", {
			...commonProperties(),
			outcome,
			duration_ms: Math.max(0, now() - run.startedAt),
			visible_ttft_ms: run.visibleTtftMs ?? null,
			first_model_event_ms: run.firstModelEventMs ?? null,
			model_latency_ms: run.modelLatencyMs,
			max_model_latency_ms: run.maxModelLatencyMs,
			model_call_count: run.usage.modelCallCount,
			turn_count: run.turnCount,
			tool_call_count: run.toolCallCount,
			tool_error_count: run.toolErrorCount,
			input_tokens: run.usage.input,
			output_tokens: run.usage.output,
			cache_read_tokens: run.usage.cacheRead,
			cache_write_tokens: run.usage.cacheWrite,
			total_tokens: run.usage.totalTokens,
			compaction_count: run.compactionCount,
			retry_count: run.retryCount,
			provider_category: telemetryProviderCategory(lastAssistant?.provider),
			model_category: lastAssistant ? modelCategory(lastAssistant.model) : "unknown",
			error_category: errorCategory(lastAssistant),
		});
	};

	sink.capture("agent started", commonProperties());

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "session_action_update":
				turnActionActive = event.actions.active?.kind === "turn";
				if (!turnActionActive && activeRun?.agentEnded) {
					finalizeRun();
				}
				break;
			case "agent_start":
				if (activeRun?.agentEnded && !turnActionActive) {
					finalizeRun();
				}
				activeRun ??= createActiveRun(now);
				activeRun.agentEnded = false;
				break;
			case "message_start":
				if (event.message.role === "user") {
					sessionTotals.promptCount++;
				}
				break;
			case "turn_start":
				if (activeRun) {
					activeRun.currentTurnStartedAt = now();
					activeRun.firstTurnStartedAt ??= activeRun.currentTurnStartedAt;
					activeRun.turnCount++;
				}
				break;
			case "message_update":
				if (!activeRun) {
					break;
				}
				if (activeRun.firstModelEventMs === undefined && activeRun.firstTurnStartedAt !== undefined) {
					activeRun.firstModelEventMs = Math.max(0, now() - activeRun.firstTurnStartedAt);
				}
				if (
					activeRun.visibleTtftMs === undefined &&
					activeRun.firstTurnStartedAt !== undefined &&
					event.assistantMessageEvent.type === "text_delta" &&
					event.assistantMessageEvent.delta.length > 0
				) {
					activeRun.visibleTtftMs = Math.max(0, now() - activeRun.firstTurnStartedAt);
				}
				break;
			case "message_end": {
				const message = assistantMessage(event);
				if (!activeRun || !message) {
					break;
				}
				activeRun.lastAssistant = message;
				addUsage(activeRun.usage, message.usage);
				if (activeRun.currentTurnStartedAt !== undefined) {
					const latency = Math.max(0, now() - activeRun.currentTurnStartedAt);
					activeRun.modelLatencyMs += latency;
					activeRun.maxModelLatencyMs = Math.max(activeRun.maxModelLatencyMs, latency);
					activeRun.currentTurnStartedAt = undefined;
				}
				break;
			}
			case "tool_execution_end":
				if (activeRun) {
					activeRun.toolCallCount++;
					if (event.isError) {
						activeRun.toolErrorCount++;
					}
				}
				break;
			case "compaction_end":
				if (activeRun && event.result && !event.aborted) {
					activeRun.compactionCount++;
				}
				break;
			case "auto_retry_start":
				if (activeRun) {
					activeRun.retryCount++;
				}
				break;
			case "agent_end":
				if (!activeRun) {
					break;
				}
				activeRun.agentEnded = true;
				if (!turnActionActive) {
					finalizeRun();
				}
				break;
		}
	});

	session.registerDisposeCallback(async () => {
		unsubscribe();
		finalizeRun();
		sink.capture("agent session ended", {
			...commonProperties(),
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
		await sink.flush();
	});
}
