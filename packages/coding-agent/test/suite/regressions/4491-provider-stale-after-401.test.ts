import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

function provider401Message(): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "401 Unauthorized: invalid API key",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "auth", status: 401 },
			},
		],
	};
}

function unstructured401Message(): AssistantMessage {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "401 status code (no body)",
	});
}

function provider500Message(): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "500 Internal Server Error",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "server_error", status: 500 },
			},
		],
	};
}

describe("issue #4491 provider stale after repeated 401", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries structured provider auth failures once, then marks current auth stale", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider401Message(), provider401Message()]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
		expect(harness.eventsOfType("auth_stale")).toHaveLength(1);

		const provider = harness.getModel().provider;
		expect(harness.authStorage.hasAuth(provider)).toBe(false);
		expect(harness.authStorage.getAuthStatus(provider)).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});

		const assistantMessages = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const finalAssistant = assistantMessages[assistantMessages.length - 1];
		expect(finalAssistant?.errorMessage).toContain("401 Unauthorized");
		expect(finalAssistant?.errorMessage).toContain("Run /login to update credentials.");
	});

	it("emits stale auth source tokens for daemon clients after structured 401 auth failures", async () => {
		const harness = await createHarness({
			provider: "prime-inference",
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message()]);

		await harness.session.prompt("hello");

		const authStaleEvents = harness.eventsOfType("auth_stale");
		expect(authStaleEvents).toHaveLength(1);
		expect(authStaleEvents[0]?.provider).toBe("prime-inference");
		expect(authStaleEvents[0]?.sourceTokens).toMatchObject([
			{
				provider: "prime-inference",
				source: "runtime",
			},
		]);
		expect(harness.authStorage.getAuthStatus("prime-inference")).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});
	});

	it("does not mark auth stale from unstructured 401 error text", async () => {
		const harness = await createHarness({
			provider: "prime-inference",
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([unstructured401Message()]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("auth_stale")).toHaveLength(0);
		expect(harness.authStorage.hasAuth("prime-inference")).toBe(true);
	});

	it("explicit model selection clears a stale-auth lockout", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message()]);

		await harness.session.prompt("hello");

		const provider = harness.getModel().provider;
		expect(harness.authStorage.hasAuth(provider)).toBe(false);

		await harness.session.setModel(harness.getModel());

		expect(harness.authStorage.hasAuth(provider)).toBe(true);
		expect(harness.authStorage.getAuthStatus(provider).source).not.toBe("stale");
	});

	it("creates retry promises for exhausted structured auth failures so cleanup is awaited", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const event = { type: "agent_end", messages: [provider401Message()] } as AgentEvent;
		const session = harness.session as unknown as {
			_retryAttempt: number;
			_createRetryPromiseForAgentEnd(event: AgentEvent): void;
		};
		session._retryAttempt = 1;

		session._createRetryPromiseForAgentEnd(event);

		expect(harness.session.isRetrying).toBe(true);
		harness.session.abortRetry();
	});

	it("marks captured auth failures stale when retry backoff is cancelled", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider401Message()]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hello");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auth_stale")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		expect(harness.authStorage.hasAuth(harness.getModel().provider)).toBe(false);
		await expect(harness.authStorage.getApiKey(harness.getModel().provider)).resolves.toBeUndefined();
	});

	it("marks each failed auth source stale when credentials change during retry backoff", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider401Message()]);

		let changedCredentials = false;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && !changedCredentials) {
				changedCredentials = true;
				harness.authStorage.setRuntimeApiKey(harness.getModel().provider, "fresh-key");
			}
		});

		await harness.session.prompt("hello");

		expect(changedCredentials).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.authStorage.hasAuth(harness.getModel().provider)).toBe(false);
		await expect(harness.authStorage.getApiKey(harness.getModel().provider)).resolves.toBeUndefined();
		expect(harness.authStorage.getAuthStatus(harness.getModel().provider)).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});
	});

	it("marks captured auth failures stale when the final retryable error is not auth", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider500Message(), provider500Message()]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
		expect(harness.authStorage.hasAuth(harness.getModel().provider)).toBe(false);
		await expect(harness.authStorage.getApiKey(harness.getModel().provider)).resolves.toBeUndefined();

		const assistantMessages = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const finalAssistant = assistantMessages[assistantMessages.length - 1];
		expect(finalAssistant?.errorMessage).toContain("500 Internal Server Error");
		expect(finalAssistant?.errorMessage).toContain("Run /login to update credentials.");
	});

	it("marks concrete auth failures stale when retry is disabled", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message()]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.authStorage.hasAuth(harness.getModel().provider)).toBe(false);
		await expect(harness.authStorage.getApiKey(harness.getModel().provider)).resolves.toBeUndefined();
	});

	it("resolves retry state for auth failures surfaced only on agent_end", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const message = provider401Message();
		const event = { type: "agent_end", messages: [message] } as AgentEvent;
		const session = harness.session as unknown as {
			_createRetryPromiseForAgentEnd(event: AgentEvent): void;
			_processAgentEvent(event: AgentEvent): Promise<void>;
		};

		session._createRetryPromiseForAgentEnd(event);
		await session._processAgentEvent(event);

		expect(harness.session.isRetrying).toBe(false);
		expect(harness.eventsOfType("auto_retry_end").map((retryEvent) => retryEvent.success)).toEqual([false]);
		expect(harness.authStorage.hasAuth(harness.getModel().provider)).toBe(false);
		expect(message.errorMessage).toContain("Run /login to update credentials.");
	});
});
