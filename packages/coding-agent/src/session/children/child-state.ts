import type { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { RlmMaxDepthSource, RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./max-depth.js";

interface PersistedRlmMaxDepthState {
	maxDepth: number;
}
const RLM_MAX_DEPTH_STATE_CUSTOM_TYPE = "rlm_max_depth_state";
function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseDepth(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") {
		return fallback;
	}
	if (!/^\d+$/.test(value)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	const parsed = Number(value);
	if (!isNonNegativeInteger(parsed)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return parsed;
}

function isPersistedRlmMaxDepthState(value: unknown): value is PersistedRlmMaxDepthState {
	return (
		typeof value === "object" && value !== null && isNonNegativeInteger((value as PersistedRlmMaxDepthState).maxDepth)
	);
}

export interface SessionChildStateHost {
	sessionManager: Pick<SessionManager, "getHeader" | "getBranch" | "appendCustomEntryWithRollback">;
	settingsManager: Pick<SettingsManager, "getRlmMaxDepth" | "setRlmMaxDepth" | "flush" | "drainErrors">;
	getRlmMaxDepthStatus(): RlmMaxDepthStatus;
	refreshPrompt(preserveExtensionPrompt: boolean): void;
	emitRecap(recap: string | undefined): void;
}
export class SessionChildState {
	readonly depth: number;
	private readonly configuredMaxDepth: number | undefined;
	private _maxDepth: number;
	private _maxDepthSource: RlmMaxDepthSource;
	private _repliedSinceTask: boolean | undefined;
	private _replyCount = 0;
	private recap: string | undefined;
	constructor(
		private readonly host: SessionChildStateHost,
		config: { rlmDepth?: number; rlmMaxDepth?: number },
	) {
		const headerRlmDepth = this.host.sessionManager.getHeader()?.rlmDepth;
		this.depth =
			config.rlmDepth ??
			(isNonNegativeInteger(headerRlmDepth) ? headerRlmDepth : parseDepth(process.env.RLM_DEPTH, 0, "RLM_DEPTH"));
		this.configuredMaxDepth = config.rlmMaxDepth;
		if (this.configuredMaxDepth !== undefined && !isNonNegativeInteger(this.configuredMaxDepth)) {
			throw new Error("rlmMaxDepth must be a non-negative integer");
		}
		const resolvedRlmMaxDepth = this._resolveRlmMaxDepth();
		this._maxDepth = resolvedRlmMaxDepth.maxDepth;
		this._maxDepthSource = resolvedRlmMaxDepth.source;
	}
	get maxDepth(): number {
		return this._maxDepth;
	}
	get repliedSinceTask(): boolean | undefined {
		return this._repliedSinceTask;
	}
	get replyCount(): number {
		return this._replyCount;
	}
	initializeParentReply(): void {
		// Resumed transcripts do not prove whether the child already replied.
		this._repliedSinceTask =
			this.depth > 0 && this.host.sessionManager.getBranch().some((entry) => entry.type === "message")
				? undefined
				: false;
	}
	recordReply(): void {
		this._repliedSinceTask = true;
		this._replyCount += 1;
	}
	resetReply(): void {
		this._repliedSinceTask = false;
	}
	getCurrentRecap(): string | undefined {
		return this.recap;
	}
	setCurrentRecap(recap: string | undefined): void {
		if (this.recap === recap) return;
		this.recap = recap;
		this.host.emitRecap(recap);
	}
	reloadFromBranch(): void {
		const previousMaxDepth = this._maxDepth;
		const resolved = this._resolveRlmMaxDepth();
		this._maxDepth = resolved.maxDepth;
		this._maxDepthSource = resolved.source;
		if (resolved.maxDepth !== previousMaxDepth) this.host.refreshPrompt(false);
	}
	private _loadPersistedRlmMaxDepthState(): PersistedRlmMaxDepthState | undefined {
		const branch = this.host.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === RLM_MAX_DEPTH_STATE_CUSTOM_TYPE &&
				isPersistedRlmMaxDepthState(entry.data)
			) {
				return entry.data;
			}
		}
		return undefined;
	}
	private _resolveRlmMaxDepth(): {
		maxDepth: number;
		source: RlmMaxDepthSource;
	} {
		const persisted = this._loadPersistedRlmMaxDepthState();
		if (persisted) {
			return { maxDepth: persisted.maxDepth, source: "chat" };
		}
		if (this.configuredMaxDepth !== undefined) {
			return { maxDepth: this.configuredMaxDepth, source: "inherited" };
		}
		const global = this.host.settingsManager.getRlmMaxDepth();
		if (global !== undefined && isNonNegativeInteger(global)) {
			return { maxDepth: global, source: "global" };
		}
		const env = process.env.RLM_MAX_DEPTH;
		if (env !== undefined && env !== "") {
			return { maxDepth: parseDepth(env, 1, "RLM_MAX_DEPTH"), source: "env" };
		}
		return { maxDepth: 2, source: "default" };
	}

	getRlmMaxDepthStatus(): RlmMaxDepthStatus {
		return { maxDepth: this._maxDepth, source: this._maxDepthSource };
	}
	async setRlmMaxDepth(maxDepth: number, options: { global?: boolean } = {}): Promise<SetRlmMaxDepthResult> {
		if (!isNonNegativeInteger(maxDepth)) {
			throw new Error("RLM max depth must be a non-negative integer.");
		}

		this.host.sessionManager.appendCustomEntryWithRollback(RLM_MAX_DEPTH_STATE_CUSTOM_TYPE, { maxDepth });
		this._maxDepth = maxDepth;
		this._maxDepthSource = "chat";
		this.host.refreshPrompt(true);

		let globalError: string | undefined;
		if (options.global) {
			await this.host.settingsManager.flush();
			const staleErrors = this.host.settingsManager.drainErrors("global");
			for (const { error } of staleErrors) {
				console.warn(`Warning: Earlier global settings write failed: ${error.message}`);
			}
			this.host.settingsManager.setRlmMaxDepth(maxDepth);
			await this.host.settingsManager.flush();
			const errors = this.host.settingsManager.drainErrors("global");
			globalError = errors.map(({ error }) => error.message).join("; ") || undefined;
		}

		return {
			...this.host.getRlmMaxDepthStatus(),
			globalSaved: options.global === true && globalError === undefined,
			...(globalError ? { globalError } : {}),
		};
	}
}
