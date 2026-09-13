import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSourceToken } from "../../src/core/auth-storage.js";
import { SessionRetry, type SessionRetryEvent, type SessionRetryHost } from "../../src/session/turns/retry.js";

function failure(kind?: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
		diagnostics: kind ? [{ type: "provider_stream_failure", timestamp: 0, details: { kind } }] : [],
	};
}

function setup() {
	const events: SessionRetryEvent[] = [];
	const order: string[] = [];
	const settings = { enabled: true, maxRetries: 3, baseDelayMs: 10 };
	const host = {
		getRetrySettings: () => settings,
		getMaxRetryDelayMs: () => 1000,
		getContextWindow: () => 10000,
		getAuthSource: vi.fn<SessionRetryHost["getAuthSource"]>(() => undefined),
		markAuthSourceStale: vi.fn((_token: AuthSourceToken) => true),
		markAuthStale: vi.fn(() => true),
		hasPayloadHooks: vi.fn(() => false),
		prepareTurnRetry: vi.fn(() => {
			order.push("prepare");
		}),
		clearTurnRetry: vi.fn(() => {
			order.push("clear");
		}),
		removeLastAssistant: vi.fn(() => {
			order.push("remove");
		}),
		continue: vi.fn<SessionRetryHost["continue"]>(() => Promise.resolve()),
		waitForIdle: vi.fn<SessionRetryHost["waitForIdle"]>(() => Promise.resolve()),
		cancelCompaction: vi.fn(() => {
			order.push("cancel-compaction");
		}),
		emit: vi.fn((event: SessionRetryEvent) => {
			events.push(event);
			order.push(event.type);
		}),
		onResolved: vi.fn(() => {
			order.push("resolved");
		}),
	} satisfies SessionRetryHost;
	return { retry: new SessionRetry(host), host, events, order, settings };
}

async function schedule(retry: SessionRetry, message = failure()): Promise<void> {
	const pending = retry.retryError(message);
	expect(pending).toBeInstanceOf(Promise);
	await vi.advanceTimersByTimeAsync(10);
	expect(await pending).toBe(true);
}

function token(value: string): AuthSourceToken {
	return { provider: "faux", source: "runtime", identityFingerprint: "identity", valueFingerprint: value };
}

describe("SessionRetry ownership", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("creates the wait boundary synchronously and waits for lower-agent idle after resolution", async () => {
		const { retry, host, order } = setup();
		retry.observeAgentEnd({ type: "agent_end", messages: [failure()] });
		expect(retry.isRetrying).toBe(true);
		expect(retry.attempt).toBe(0);
		let releaseIdle = () => {};
		host.waitForIdle.mockReturnValue(
			new Promise<void>((resolve) => {
				releaseIdle = resolve;
			}),
		);
		let done = false;
		const waiting = retry.waitForRetry().then(() => {
			done = true;
		});
		retry.resolve();
		expect(order).toEqual(["clear", "resolved"]);
		expect(host.waitForIdle).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(host.waitForIdle).toHaveBeenCalledOnce();
		expect(done).toBe(false);
		releaseIdle();
		await waiting;
		expect(done).toBe(true);
		retry.resolve();
		expect(host.clearTurnRetry).toHaveBeenCalledTimes(2);
		expect(host.onResolved).toHaveBeenCalledOnce();
	});

	it.each(["invalid_request", "refusal", "permission"])("falls through synchronously for %s", (kind) => {
		const { retry, host } = setup();
		retry.observeAgentEnd({ type: "agent_end", messages: [failure(kind)] });
		expect(retry.retryError(failure(kind))).toBeUndefined();
		expect(retry.isRetrying).toBe(false);
		expect(host.prepareTurnRetry).not.toHaveBeenCalled();
	});

	it("retains the promise after an aborted assistant resets the attempt as a success", async () => {
		const { retry, events } = setup();
		await schedule(retry);
		retry.observeAssistantEnd(fauxAssistantMessage("", { stopReason: "aborted" }));
		expect(retry.attempt).toBe(0);
		expect(retry.isRetrying).toBe(true);
		expect(events.at(-1)).toEqual({ type: "auto_retry_end", success: true, attempt: 1 });
		retry.resolve();
	});

	it("preserves captured source identity and auth/event order on backoff cancellation", async () => {
		const { retry, host, events, order } = setup();
		const old = token("old");
		host.getAuthSource.mockReturnValue(old);
		const message = failure("auth");
		retry.observeAgentEnd({ type: "agent_end", messages: [message] });
		retry.observeAssistantEnd(message);
		const pending = retry.retryError(message);
		host.getAuthSource.mockReturnValue(token("fresh"));
		retry.abortRetry();
		expect(retry.attempt).toBe(1);
		expect(retry.isRetrying).toBe(true);
		expect(await pending).toBe(false);
		expect(host.markAuthSourceStale).toHaveBeenCalledExactlyOnceWith(old);
		expect(host.markAuthStale).not.toHaveBeenCalled();
		expect(order).toEqual([
			"prepare",
			"auto_retry_start",
			"remove",
			"auth_stale",
			"auto_retry_end",
			"clear",
			"resolved",
		]);
		expect(events.at(-1)).toMatchObject({ attempt: 1, finalError: "Retry cancelled" });
		expect(message.errorMessage).toContain("Run /login");
	});

	it("deduplicates captured tokens while retaining changed values across failures", async () => {
		const { retry, host, events } = setup();
		const old = token("old"),
			fresh = token("fresh");
		host.getAuthSource.mockReturnValue(old);
		await schedule(retry, failure("auth"));
		host.getAuthSource.mockReturnValue(fresh);
		const message = failure("auth");
		retry.observeAssistantEnd(message);
		retry.observeAssistantEnd(message);
		expect(retry.retryError(message)).toBeUndefined();
		retry.finishActiveRetryWithFailure(message);
		expect(host.markAuthSourceStale.mock.calls).toEqual([[old], [fresh]]);
		expect(events.at(-2)).toMatchObject({ type: "auth_stale", sourceTokens: [old, fresh] });
		retry.resolve();
	});

	it("clears successful auth history before a later unrelated failure", async () => {
		const { retry, host } = setup();
		host.getAuthSource.mockReturnValue(token("old"));
		await schedule(retry, failure("auth"));
		retry.observeAssistantEnd(fauxAssistantMessage("recovered"));
		retry.resolve();
		await schedule(retry);
		retry.finishActiveRetryWithFailure(failure("permission"));
		expect(host.markAuthSourceStale).not.toHaveBeenCalled();
		retry.resolve();
	});

	it("leaves a newer retry untouched when an old scheduled continuation rejects", async () => {
		const { retry, host, events } = setup();
		let rejectOld = (_error: Error) => {};
		host.continue.mockReturnValueOnce(
			new Promise<void>((_resolve, reject) => {
				rejectOld = reject;
			}),
		);
		await schedule(retry);
		await vi.advanceTimersByTimeAsync(1);
		retry.abortRetry();
		await schedule(retry);
		rejectOld(new Error("old failure"));
		await Promise.resolve();
		expect(retry.isRetrying).toBe(true);
		expect(retry.attempt).toBe(1);
		expect(events.filter((event) => event.type === "auto_retry_end")).toHaveLength(1);
		retry.abortRetry();
	});

	it("still invokes an already scheduled continuation after abort, ignoring its rejection", async () => {
		const { retry, host, events } = setup();
		host.continue.mockRejectedValue(new Error("late failure"));
		await schedule(retry);
		expect(host.continue).not.toHaveBeenCalled();
		retry.abortRetry();
		await vi.advanceTimersByTimeAsync(1);
		expect(host.continue).toHaveBeenCalledOnce();
		expect(events.filter((event) => event.type === "auto_retry_end")).toEqual([
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		]);
	});

	it("uses live payload hooks and preserves exceptions before emitting the start", async () => {
		const { retry, host, events } = setup();
		host.prepareTurnRetry.mockImplementationOnce(() => {
			throw new Error("ledger failed");
		});
		await expect(retry.retryError(failure())).rejects.toThrow("ledger failed");
		expect(retry.attempt).toBe(1);
		expect(retry.isRetrying).toBe(true);
		expect(events).toEqual([]);
		retry.abortRetry();
		host.hasPayloadHooks.mockReturnValue(true);
		await schedule(retry);
		expect(host.prepareTurnRetry).toHaveBeenCalledOnce();
		retry.abortRetry();
	});

	it("reads disabled settings at the next error without resetting the active attempt early", async () => {
		const { retry, settings, events } = setup();
		await schedule(retry);
		settings.enabled = false;
		expect(await retry.retryError(failure())).toBe(false);
		expect(retry.isRetrying).toBe(false);
		expect(retry.attempt).toBe(1);
		retry.finishActiveRetryWithFailure(failure());
		expect(events.at(-1)).toMatchObject({ type: "auto_retry_end", success: false, attempt: 1 });
	});
});
