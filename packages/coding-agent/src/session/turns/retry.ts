import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, isContextOverflow } from "@earendil-works/pi-ai";
import { addLoginGuidanceToAuthError } from "../../core/auth-guidance.js";
import type { AuthSourceToken } from "../../core/auth-storage.js";
import {
	isAgentLifecycleFailure,
	isFauxProviderQueueExhausted,
	isPermanentProviderFailureKind,
	providerRetryDelay,
	providerStreamFailureKind,
	providerStreamFailureRetryAfterMs,
} from "../../core/provider-retry.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import { sleep } from "../../utils/sleep.js";

export type SessionRetryEvent =
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| {
			type: "auth_stale";
			provider: string;
			sourceTokens?: readonly AuthSourceToken[];
	  };

export interface SessionRetryHost {
	getRetrySettings(): ReturnType<SettingsManager["getRetrySettings"]>;
	getMaxRetryDelayMs(): number;
	getContextWindow(): number;
	getAuthSource(provider: string): AuthSourceToken | undefined;
	markAuthSourceStale(token: AuthSourceToken): boolean;
	markAuthStale(provider: string): boolean;
	hasPayloadHooks(): boolean;
	prepareTurnRetry(): void;
	clearTurnRetry(): void;
	removeLastAssistant(): void;
	continue(): Promise<void>;
	waitForIdle(): Promise<void>;
	cancelCompaction(): void;
	emit(event: SessionRetryEvent): void;
	onResolved(): void;
}

/** Owns one session's retry chain; callbacks read live collaborators at each boundary. */
export class SessionRetry {
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/** Bumped by every retry resolution; stale scheduled-continue callbacks check it before touching retry state. */
	private _retryGeneration = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _retryAuthFailureSources: AuthSourceToken[] = [];

	constructor(private readonly host: SessionRetryHost) {}

	observeAgentEnd(event: AgentEvent): void {
		if (event.type !== "agent_end" || this._retryPromise) {
			return;
		}

		const settings = this.host.getRetrySettings();
		if (!settings.enabled) {
			return;
		}

		let lastAssistant: AssistantMessage | undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				lastAssistant = message as AssistantMessage;
				break;
			}
		}
		const concreteAuthFailure = lastAssistant ? this._isConcreteProviderAuthFailure(lastAssistant) : false;
		if (!lastAssistant || (!this._isRetryableError(lastAssistant) && !concreteAuthFailure)) {
			return;
		}
		if (concreteAuthFailure) {
			this._captureRetryAuthFailureSource(lastAssistant);
		}

		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	observeAssistantEnd(assistantMsg: AssistantMessage): void {
		if (this._isConcreteProviderAuthFailure(assistantMsg)) {
			this._captureRetryAuthFailureSource(assistantMsg);
		}

		// Reset retry counter immediately on successful assistant response
		// This prevents accumulation across multiple LLM calls within a turn
		if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
			this.host.emit({
				type: "auto_retry_end",
				success: true,
				attempt: this._retryAttempt,
			});
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
		}
	}

	/** Undefined preserves the caller's synchronous fallthrough when no retry applies. */
	retryError(msg: AssistantMessage): Promise<boolean> | undefined {
		const concreteAuthFailure = this._isConcreteProviderAuthFailure(msg);
		const retryConcreteAuthFailure = concreteAuthFailure && !this._isStructuredPermanentProviderRetryExhausted(msg);
		if (this._isRetryableError(msg) || retryConcreteAuthFailure) {
			if (retryConcreteAuthFailure) {
				this._captureRetryAuthFailureSource(msg);
			}
			return this._handleRetryableError(msg, {
				markAuthStaleOnFailure: retryConcreteAuthFailure,
				authSourceTokens: retryConcreteAuthFailure ? this._retryAuthFailureSources : undefined,
			});
		}
	}

	resolve(): void {
		this._retryGeneration += 1;
		this.host.clearTurnRetry();
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
			this.host.onResolved();
		}
	}

	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		const contextWindow = this.host.getContextWindow();
		if (isContextOverflow(message, contextWindow)) return false;

		if (this._isFauxProviderQueueExhausted(message)) {
			return false;
		}

		if (this._isAgentLifecycleFailure(message)) {
			return false;
		}

		if (this._isStructuredPermanentProviderRetryExhausted(message)) {
			return false;
		}

		return true;
	}

	private _isFauxProviderQueueExhausted(message: AssistantMessage): boolean {
		return isFauxProviderQueueExhausted(message);
	}

	private _isAgentLifecycleFailure(message: AssistantMessage): boolean {
		return isAgentLifecycleFailure(message);
	}

	private _getProviderStreamFailureKind(message: AssistantMessage): string | undefined {
		return providerStreamFailureKind(message);
	}

	private _isStructuredPermanentProviderRetryExhausted(message: AssistantMessage): boolean {
		return isPermanentProviderFailureKind(this._getProviderStreamFailureKind(message), this._retryAttempt);
	}

	private _isConcreteProviderAuthFailure(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;
		// Only the provider's structured classification counts as an auth failure.
		return this._getProviderStreamFailureKind(message) === "auth";
	}

	private _captureRetryAuthFailureSource(message: AssistantMessage): AuthSourceToken | undefined {
		const token = this.host.getAuthSource(message.provider);
		if (!token) {
			return undefined;
		}
		if (
			!this._retryAuthFailureSources.some(
				(existing) =>
					existing.provider === token.provider &&
					existing.source === token.source &&
					existing.identityFingerprint === token.identityFingerprint &&
					existing.valueFingerprint === token.valueFingerprint,
			)
		) {
			this._retryAuthFailureSources.push(token);
		}
		return token;
	}

	private _markProviderAuthStale(message: AssistantMessage, authSourceTokens?: readonly AuthSourceToken[]): boolean {
		if (authSourceTokens && authSourceTokens.length > 0) {
			let marked = false;
			for (const token of authSourceTokens) {
				marked = this.host.markAuthSourceStale(token) || marked;
			}
			if (marked) {
				this.host.emit({
					type: "auth_stale",
					provider: message.provider,
					sourceTokens: authSourceTokens,
				});
			}
			return marked;
		}
		const marked = this.host.markAuthStale(message.provider);
		if (marked) {
			this.host.emit({ type: "auth_stale", provider: message.provider });
		}
		return marked;
	}

	private _markProviderAuthStaleForRetryFailure(
		message: AssistantMessage,
		options?: {
			markAuthStaleOnFailure?: boolean;
			authSourceTokens?: readonly AuthSourceToken[];
		},
	): boolean {
		const authSourceTokens =
			this._retryAuthFailureSources.length > 0 ? this._retryAuthFailureSources : options?.authSourceTokens;
		if ((authSourceTokens?.length ?? 0) > 0 || options?.markAuthStaleOnFailure) {
			const marked = this._markProviderAuthStale(message, authSourceTokens);
			if (marked && message.errorMessage) {
				message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
			}
			return marked;
		}
		return false;
	}

	finishActiveRetryWithFailure(message: AssistantMessage): void {
		if (this._retryAttempt === 0) {
			return;
		}
		this._markProviderAuthStaleForRetryFailure(message);
		this.host.emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt,
			finalError: message.errorMessage,
		});
		this._retryAttempt = 0;
		this._retryAuthFailureSources = [];
	}

	private async _handleRetryableError(
		message: AssistantMessage,
		options?: {
			markAuthStaleOnFailure?: boolean;
			authSourceTokens?: readonly AuthSourceToken[];
		},
	): Promise<boolean> {
		const settings = this.host.getRetrySettings();
		if (!settings.enabled) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAuthFailureSources = [];
			this.resolve();
			return false;
		}

		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			this.host.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
			this.resolve(); // Resolve so waitForRetry() completes
			return false;
		}

		// Server-requested waits are honored, capped by retry.provider.maxRetryDelayMs (0 disables).
		const maxRetryDelayMs = this.host.getMaxRetryDelayMs();
		const delay = providerRetryDelay(this._retryAttempt, providerStreamFailureRetryAfterMs(message), {
			baseDelayMs: settings.baseDelayMs,
			maxRetryDelayMs,
		});
		if (delay.kind === "exceeds-cap") {
			this._markProviderAuthStaleForRetryFailure(message, options);
			this.host.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: `Provider requested a ${Math.ceil(delay.retryAfterMs / 1000)}s wait before retrying (above retry.provider.maxRetryDelayMs=${maxRetryDelayMs}ms): ${message.errorMessage || "unknown error"}`,
			});
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
			this.resolve();
			return false;
		}

		const delayMs = delay.delayMs;
		// Park now: the retry re-issues the failed call and must reuse its Idempotency-Key.
		// Payload hooks mutate the wire body after the hash point, so reuse is forfeited.
		if (!this.host.hasPayloadHooks()) {
			this.host.prepareTurnRetry();
		}

		this.host.emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		this.host.removeLastAssistant();

		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			const attempt = this._retryAttempt;
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAttempt = 0;
			this._retryAbortController = undefined;
			this.host.emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.resolve();
			this._retryAuthFailureSources = [];
			return false;
		}
		this._retryAbortController = undefined;

		const retryGeneration = this._retryGeneration;
		setTimeout(() => {
			this.host.continue().catch((error: unknown) => {
				// A continue that never starts must still resolve the retry (else isRetrying
				// sticks forever) — unless a newer retry owns the state by now.
				if (this._retryGeneration !== retryGeneration || !this.isRetrying) return;
				this._markProviderAuthStaleForRetryFailure(message, options);
				const attempt = this._retryAttempt;
				this._retryAttempt = 0;
				this._retryAuthFailureSources = [];
				this.host.emit({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: error instanceof Error ? error.message : String(error),
				});
				this.resolve();
			});
		}, 0);

		return true;
	}

	abortRetry(): void {
		if (this._retryAbortController) {
			this._retryAbortController.abort();
			return;
		}
		if (this._retryAttempt > 0) {
			this.host.cancelCompaction();
			this.host.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: "Retry cancelled",
			});
			this._retryAttempt = 0;
		}
		this._retryAuthFailureSources = [];
		this.resolve();
	}

	async waitForRetry(): Promise<void> {
		if (!this._retryPromise) {
			return;
		}

		await this._retryPromise;
		await this.host.waitForIdle();
	}

	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	get attempt(): number {
		return this._retryAttempt;
	}
}
