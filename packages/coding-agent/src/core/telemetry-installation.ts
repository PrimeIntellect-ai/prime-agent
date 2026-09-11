import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { VERSION } from "../config.js";
import type { AgentExecutionMode } from "./agent-session-config.js";
import { SettingsManager } from "./settings-manager.js";
import {
	captureTelemetryEvent,
	clearPendingTelemetry,
	flushTelemetry,
	isTelemetryEnabled,
	TelemetryClient,
	type TelemetryProperties,
	type TelemetrySink,
} from "./telemetry.js";
import type { TELEMETRY_ENUMS } from "./telemetry-contract.js";
import { captureTelemetryError } from "./telemetry-errors.js";
import {
	clearInstallationTelemetryState,
	installationTelemetryContext,
	readInstallationTelemetryState,
	removeInstallationTelemetryState,
	writeInstallationTelemetryState,
} from "./telemetry-installation-state.js";

export const INSTALLATION_TELEMETRY_CONTEXT_ENV = "PRIME_AGENT_TELEMETRY_INSTALLATION_CONTEXT";

type InstallationStage = (typeof TELEMETRY_ENUMS.installationStage)[number];
type InstallationOutcome = (typeof TELEMETRY_ENUMS.installationOutcome)[number];
type InstallationReason = (typeof TELEMETRY_ENUMS.installationReason)[number];

interface InstallationTelemetryOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	source: "cli" | "interactive";
	cwd?: string;
	sink?: TelemetrySink;
	now?: () => number;
}

function installationConsent(options: InstallationTelemetryOptions): boolean {
	if (!isTelemetryEnabled(options.settingsManager)) return false;
	const saved = SettingsManager.create(options.cwd ?? process.cwd(), options.agentDir);
	return saved.drainErrors().length === 0 && isTelemetryEnabled(saved);
}

export class TelemetryInstallationAttempt {
	private disabled = false;
	private completed = false;
	private readonly now: () => number;
	private readonly startedAt: number | undefined;
	private readonly stages = new Map<InstallationStage, number>();
	private readonly unsubscribe: () => void;
	readonly properties: TelemetryProperties;

	constructor(
		private readonly options: InstallationTelemetryOptions,
		inherited?: TelemetryProperties,
	) {
		this.now = options.now ?? (() => performance.now());
		this.startedAt = inherited ? undefined : this.now();
		this.properties = inherited ?? {
			installation_attempt_id: randomUUID(),
			installation_action: "update",
			installation_source: options.source,
			from_version: VERSION,
		};
		this.options = {
			...options,
			sink: options.sink ?? new TelemetryClient({ agentDir: options.agentDir, isEnabled: () => this.enabled() }),
		};
		this.unsubscribe = options.settingsManager.subscribeTelemetryEnabled(() => this.enabled());
		if (!inherited) this.stage("started", "started");
	}

	private enabled(): boolean {
		try {
			if (!this.disabled && installationConsent(this.options)) return true;
		} catch {
			// An unavailable consent context disables this attempt.
		}
		this.disabled = true;
		clearPendingTelemetry(this.options);
		removeInstallationTelemetryState(this.options.agentDir, this.properties.installation_attempt_id);
		return false;
	}

	setTargetVersion(version: string | undefined): void {
		const safe = installationTelemetryContext({ ...this.properties, target_version: version });
		if (safe?.target_version) this.properties.target_version = safe.target_version;
	}

	stage(
		stage: InstallationStage,
		outcome: InstallationOutcome,
		reason?: InstallationReason,
		extra: TelemetryProperties = {},
	): void {
		if (!this.enabled()) return;
		const at = this.now();
		if (outcome === "started") this.stages.set(stage, at);
		const start = stage === "completed" ? this.startedAt : this.stages.get(stage);
		captureTelemetryEvent({
			...this.options,
			executionMode: this.options.source === "interactive" ? "interactive" : undefined,
			name: "agent installation stage",
			properties: {
				...this.properties,
				...extra,
				stage,
				outcome,
				duration_ms: start === undefined ? null : Math.max(0, at - start),
				...(reason ? { reason } : {}),
			},
		});
	}

	fail(stage: InstallationStage, error: unknown, reason: InstallationReason): void {
		if (!this.enabled()) return;
		const errorId = captureTelemetryError({
			...this.options,
			error,
			component: stage === "daemon_restart" || stage === "session_restore" ? "daemon" : "startup",
			operation: "execute",
			stage: "startup",
		});
		this.stage(stage, "failed", reason, errorId ? { error_id: errorId } : {});
	}

	installed(): void {
		if (!this.enabled()) return;
		this.stage("package_install", "success");
		writeInstallationTelemetryState(this.options.agentDir, {
			version: 1,
			createdAt: Date.now(),
			cwd: this.options.cwd ?? process.cwd(),
			properties: this.properties,
			completeOnReady: false,
		});
	}

	refreshInstalledContext(): void {
		if (!this.enabled()) return;
		const state = readInstallationTelemetryState(this.options.agentDir).find(
			(item) => item.properties.installation_attempt_id === this.properties.installation_attempt_id,
		);
		if (state) Object.assign(this.properties, state.properties);
	}

	restartResult(status: {
		phase: string;
		counts: { total: number; failed: number };
		incompleteRestores?: number;
	}): void {
		const outcome = status.phase === "complete" ? "success" : status.phase === "skipped" ? "skipped" : "failed";
		this.stage("daemon_restart", outcome, outcome === "failed" ? "daemon_restart_failed" : undefined);
		if (status.counts.total > 0) {
			const incomplete = status.incompleteRestores;
			const knownIncomplete =
				typeof incomplete === "number" &&
				Number.isInteger(incomplete) &&
				incomplete >= 0 &&
				incomplete <= status.counts.total - status.counts.failed;
			const failed = status.counts.failed + (knownIncomplete ? incomplete : 0);
			this.stage(
				"session_restore",
				failed > 0 || outcome === "failed" ? "failed" : knownIncomplete ? "success" : "unavailable",
				failed > 0 ? "session_restore_failed" : undefined,
				{
					session_restore_total: status.counts.total,
					...(failed > 0 || knownIncomplete ? { session_restore_failed: failed } : {}),
				},
			);
		}
	}

	finish(outcome: Exclude<InstallationOutcome, "started">, reason?: InstallationReason): void {
		if (this.completed) return;
		this.completed = true;
		this.stage("completed", outcome, reason);
		if (outcome !== "success")
			removeInstallationTelemetryState(this.options.agentDir, this.properties.installation_attempt_id);
	}

	environment(): NodeJS.ProcessEnv {
		return this.enabled()
			? { [INSTALLATION_TELEMETRY_CONTEXT_ENV]: JSON.stringify(this.properties) }
			: { PRIME_AGENT_TELEMETRY: "0", [INSTALLATION_TELEMETRY_CONTEXT_ENV]: undefined };
	}

	async flush(): Promise<void> {
		try {
			if (this.enabled()) await flushTelemetry(this.options);
		} finally {
			clearPendingTelemetry(this.options);
		}
	}

	dispose(): void {
		this.unsubscribe();
		clearPendingTelemetry(this.options);
	}
}

export function beginInstallationTelemetry(
	options: InstallationTelemetryOptions,
): TelemetryInstallationAttempt | undefined {
	try {
		const raw = process.env[INSTALLATION_TELEMETRY_CONTEXT_ENV];
		if (options.source === "cli") delete process.env[INSTALLATION_TELEMETRY_CONTEXT_ENV];
		if (!installationConsent(options)) {
			clearInstallationTelemetryState(options.agentDir);
			return undefined;
		}
		let inherited: TelemetryProperties | undefined;
		if (options.source === "cli" && raw && raw.length <= 2_048) {
			try {
				const context = installationTelemetryContext(JSON.parse(raw));
				if (context?.installation_action === "update" && context.installation_source === "interactive")
					inherited = context;
			} catch {
				// Invalid optional context cannot interfere with an update.
			}
		}
		return new TelemetryInstallationAttempt(options, inherited);
	} catch {
		return undefined;
	}
}

export function installationTelemetryEnvironment(attempt: TelemetryInstallationAttempt | undefined): NodeJS.ProcessEnv {
	return attempt?.environment() ?? { PRIME_AGENT_TELEMETRY: "0", [INSTALLATION_TELEMETRY_CONTEXT_ENV]: undefined };
}

export async function observeInstalledRuntimeReady(options: {
	agentDir: string;
	settingsManager: SettingsManager;
	readyKind: "interactive" | "headless";
	executionMode?: AgentExecutionMode;
	cwd?: string;
	sink?: TelemetrySink;
	version?: string;
	runtimeStartedAt?: number;
	telemetryDisabled?: boolean;
}): Promise<void> {
	let deliverySink: TelemetrySink | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		const consentOptions = { ...options, source: "cli" as const };
		if (options.telemetryDisabled || !installationConsent(consentOptions)) {
			clearInstallationTelemetryState(options.agentDir);
			return;
		}
		const sourceDirectories = new Set<string>();
		let disabled = false;
		const enabled = () => {
			if (disabled) return false;
			disabled =
				!installationConsent(consentOptions) ||
				![...sourceDirectories].every((cwd) => installationConsent({ ...consentOptions, cwd }));
			return !disabled;
		};
		deliverySink =
			options.sink ??
			new TelemetryClient({
				agentDir: options.agentDir,
				isEnabled: enabled,
			});
		unsubscribe = options.settingsManager.subscribeTelemetryEnabled(() => {
			if (!enabled() && deliverySink instanceof TelemetryClient) deliverySink.clearPending();
		});
		let captured = false;
		for (const state of readInstallationTelemetryState(options.agentDir)) {
			if (state.createdAt > (options.runtimeStartedAt ?? performance.timeOrigin)) continue;
			if (!removeInstallationTelemetryState(options.agentDir, state.properties.installation_attempt_id)) continue;
			const sourceSettings = SettingsManager.create(state.cwd, options.agentDir);
			if (sourceSettings.drainErrors().length > 0 || !isTelemetryEnabled(sourceSettings)) continue;
			sourceDirectories.add(state.cwd);
			const version = options.version ?? VERSION;
			const observedVersion = installationTelemetryContext({
				...state.properties,
				target_version: version,
			})?.target_version;
			const targetVersion = state.properties.target_version;
			const mismatch =
				targetVersion !== undefined &&
				targetVersion !== "0.0.0" &&
				observedVersion !== undefined &&
				observedVersion !== "0.0.0" &&
				targetVersion !== observedVersion;
			captureTelemetryEvent({
				...options,
				sink: deliverySink,
				name: "agent installation stage",
				properties: {
					...state.properties,
					stage: "ready",
					outcome: mismatch ? "failed" : "success",
					...(mismatch ? { reason: "version_mismatch" } : {}),
					observed_version: version,
					ready_kind: options.readyKind,
					duration_ms: null,
				},
			});
			captured = true;
		}
		if (captured) await flushTelemetry({ ...options, sink: deliverySink });
	} catch {
		// Installation analytics are never a startup dependency.
	} finally {
		if (deliverySink instanceof TelemetryClient) deliverySink.clearPending();
		unsubscribe?.();
	}
}
