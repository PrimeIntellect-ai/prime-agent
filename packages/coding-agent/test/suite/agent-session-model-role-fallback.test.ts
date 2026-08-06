import { type AssistantMessage, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

function providerFailure(
	kind: "overloaded" | "rate_limit" | "server_error" | "auth" | "invalid_request" | "refusal" | "safety",
	content = "",
): AssistantMessage {
	return {
		...fauxAssistantMessage(content, {
			stopReason: "error",
			errorMessage:
				kind === "auth" ? "provider authentication failure, status code 401" : `provider ${kind} failure`,
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind, ...(kind === "auth" ? { status: 401 } : {}) },
			},
		],
	};
}

async function waitForChild(harness: Harness, childId: string): Promise<AgentSession> {
	let child: AgentSession | undefined;
	await vi.waitFor(() => {
		child = harness.session.getRlmChildSession(childId);
		expect(child).toBeDefined();
	});
	return child!;
}

async function waitForChildStatus(harness: Harness, childId: string, status: "completed" | "error"): Promise<void> {
	await vi.waitFor(async () => {
		const child = (await harness.session.listRlmSubagents()).subagents.find(
			(candidate) => candidate.rlm_child_id === childId,
		);
		expect(child?.status).toBe(status);
	});
}

describe("native RLM named-role provider fallback", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("advances immediately through ordered candidates without changing global defaults", async () => {
		const provider = "role-fallback";
		const modelCalls: string[] = [];
		let releaseFailure = () => {};
		const failureGate = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		const modelSelects: Array<{ source: string; model: string }> = [];
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			provider,
			models: [
				{ id: "primary", reasoning: true },
				{ id: "fallback", reasoning: true },
			],
			settings: {
				modelRoles: { task: [`${provider}/primary:low`, `${provider}/fallback:high`] },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 },
			},
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => {
						modelSelects.push({ source: event.source, model: event.model.id });
					});
				},
			],
		});
		harnesses.push(harness);
		const originalDefaults = {
			provider: harness.settingsManager.getDefaultProvider(),
			model: harness.settingsManager.getDefaultModel(),
			thinking: harness.settingsManager.getDefaultThinkingLevel(),
		};
		harness.setResponses([
			async (_context, _options, _state, model) => {
				modelCalls.push(model.id);
				await failureGate;
				return providerFailure("server_error");
			},
			(_context, _options, _state, model) => {
				modelCalls.push(model.id);
				return fauxAssistantMessage("recovered");
			},
		]);

		const handle = await harness.session.runRlmChild("use task role");
		const child = await waitForChild(harness, handle.rlm_child_id);
		const retryDelays: number[] = [];
		child.subscribe((event) => {
			if (event.type === "auto_retry_start") retryDelays.push(event.delayMs);
		});
		releaseFailure();
		await waitForChildStatus(harness, handle.rlm_child_id, "completed");

		expect(handle.model).toBe(`${provider}/primary`);
		expect(modelCalls).toEqual(["primary", "fallback"]);
		expect(retryDelays).toEqual([0]);
		expect(child.model?.id).toBe("fallback");
		expect(child.thinkingLevel).toBe("high");
		expect(modelSelects).toContainEqual({ source: "fallback", model: "fallback" });
		expect({
			provider: harness.settingsManager.getDefaultProvider(),
			model: harness.settingsManager.getDefaultModel(),
			thinking: harness.settingsManager.getDefaultThinkingLevel(),
		}).toEqual(originalDefaults);
		expect(
			child.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => entry.modelId),
		).toEqual(["primary", "fallback"]);
	});

	it("re-expands provider-native history before a cross-provider fallback request", async () => {
		const provider = "role-fallback-native-primary";
		const fallbackProvider = "role-fallback-native-secondary";
		let fallbackContextText = "";
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			provider,
			models: [{ id: "primary" }],
			nativeCompact: async () => ({
				provider,
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque-state" }],
				compactionItem: { type: "compaction", encrypted_content: "opaque-state" },
			}),
			settings: {
				compaction: { keepRecentTokens: 1 },
				modelRoles: { task: [`${provider}/primary`, `${fallbackProvider}/fallback`] },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 },
			},
		});
		harnesses.push(harness);
		harness.session.modelRegistry.registerProvider(fallbackProvider, {
			baseUrl: "https://faux.invalid/v1",
			apiKey: "fallback-key",
			api: harness.faux.api,
			models: [
				{
					id: "fallback",
					name: "Fallback",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first response")]);

		const handle = await harness.session.runRlmChild("remember the first request");
		await waitForChildStatus(harness, handle.rlm_child_id, "completed");
		const child = await waitForChild(harness, handle.rlm_child_id);
		child.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "warm up" }],
			timestamp: Date.now(),
		});
		child.sessionManager.appendMessage({
			...fauxAssistantMessage("warmup response"),
			provider,
			model: "primary",
		});
		await child.compact();
		expect(child.messages[0]).toHaveProperty("providerPayload");
		harness.appendResponses([
			providerFailure("server_error"),
			(context) => {
				fallbackContextText = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("recovered");
			},
		]);

		await child.prompt("switch providers");

		expect(child.model?.provider).toBe(fallbackProvider);
		expect(fallbackContextText).toContain("remember the first request");
		expect(fallbackContextText).not.toContain("Provider-native compacted history");
	});

	it("skips candidates that are unavailable or unauthenticated when fallback is attempted", async () => {
		const provider = "role-fallback-skip";
		const modelCalls: string[] = [];
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			provider,
			models: [{ id: "primary" }, { id: "unavailable" }, { id: "unauthenticated" }, { id: "fallback" }],
			settings: {
				modelRoles: {
					task: [
						`${provider}/primary`,
						`${provider}/unavailable`,
						`${provider}/unauthenticated`,
						`${provider}/fallback`,
					],
				},
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 },
			},
		});
		harnesses.push(harness);
		const canUseModel = vi.spyOn(harness.session.modelRegistry, "canUseModel").mockImplementation(async (model) => {
			return model.id !== "unavailable";
		});
		const resolveAuth = harness.session.modelRegistry.getApiKeyAndHeaders.bind(harness.session.modelRegistry);
		const getApiKeyAndHeaders = vi
			.spyOn(harness.session.modelRegistry, "getApiKeyAndHeaders")
			.mockImplementation(async (model) =>
				model.id === "unauthenticated" ? { ok: false, error: "expired test credential" } : resolveAuth(model),
			);
		harness.setResponses([
			(_context, _options, _state, model) => {
				modelCalls.push(model.id);
				return providerFailure("overloaded");
			},
			(_context, _options, _state, model) => {
				modelCalls.push(model.id);
				return fauxAssistantMessage("recovered");
			},
		]);

		const handle = await harness.session.runRlmChild("skip unavailable");
		await waitForChildStatus(harness, handle.rlm_child_id, "completed");
		const child = await waitForChild(harness, handle.rlm_child_id);

		expect(modelCalls).toEqual(["primary", "fallback"]);
		expect(child.model?.id).toBe("fallback");
		expect(canUseModel).toHaveBeenCalledWith(expect.objectContaining({ id: "unavailable" }));
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(expect.objectContaining({ id: "unauthenticated" }));
	});

	it("marks a concrete failed auth source stale before a cross-provider fallback request", async () => {
		const provider = "role-fallback-auth-primary";
		const fallbackProvider = "role-fallback-auth-secondary";
		const modelCalls: string[] = [];
		let primaryAuthSourceAtFallback: string | undefined;
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			provider,
			models: [{ id: "primary" }],
			settings: {
				modelRoles: { task: [`${provider}/primary`, `${fallbackProvider}/fallback`] },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 },
			},
		});
		harnesses.push(harness);
		harness.session.modelRegistry.registerProvider(fallbackProvider, {
			baseUrl: "https://faux.invalid/v1",
			apiKey: "fallback-key",
			api: harness.faux.api,
			models: [
				{
					id: "fallback",
					name: "Fallback",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
		harness.setResponses([
			(_context, _options, _state, model) => {
				modelCalls.push(`${model.provider}/${model.id}`);
				return providerFailure("auth");
			},
			(_context, _options, _state, model) => {
				modelCalls.push(`${model.provider}/${model.id}`);
				primaryAuthSourceAtFallback = harness.authStorage.getAuthStatus(provider).source;
				return fauxAssistantMessage("recovered");
			},
		]);

		const handle = await harness.session.runRlmChild("recover from auth failure");
		await waitForChildStatus(harness, handle.rlm_child_id, "completed");

		expect(modelCalls).toEqual([`${provider}/primary`, `${fallbackProvider}/fallback`]);
		expect(primaryAuthSourceAtFallback).toBe("stale");
		expect(harness.authStorage.getAuthStatus(provider).source).toBe("stale");
	});

	it("gives a fallback candidate a fresh same-model retry budget", async () => {
		const provider = "role-fallback-budget";
		const modelCalls: string[] = [];
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			provider,
			models: [{ id: "primary" }, { id: "fallback" }],
			settings: {
				modelRoles: { task: [`${provider}/primary`, `${provider}/fallback`] },
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: 4 }, () => (_context, _options, _state, model) => {
				modelCalls.push(model.id);
				return providerFailure("server_error");
			}),
		);

		const handle = await harness.session.runRlmChild("use a fresh fallback retry budget");
		await waitForChildStatus(harness, handle.rlm_child_id, "error");

		expect(modelCalls).toEqual(["primary", "fallback", "fallback", "fallback"]);
	});

	it("reports an error when every ordered candidate fails", async () => {
		const provider = "role-fallback-error";
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			provider,
			models: [{ id: "primary" }, { id: "fallback" }],
			settings: {
				modelRoles: { task: [`${provider}/primary`, `${provider}/fallback`] },
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 60_000 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([providerFailure("server_error"), providerFailure("server_error")]);

		const handle = await harness.session.runRlmChild("all candidates fail");
		await waitForChildStatus(harness, handle.rlm_child_id, "error");
		const child = await waitForChild(harness, handle.rlm_child_id);

		expect(child.model?.id).toBe("fallback");
		expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(2);
	});

	for (const kind of ["refusal", "safety", "invalid_request"] as const) {
		it(`does not fallback after a structured ${kind} failure`, async () => {
			const provider = `role-fallback-${kind}`;
			const harness = await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				provider,
				models: [{ id: "primary" }, { id: "fallback" }],
				settings: {
					modelRoles: { task: [`${provider}/primary`, `${provider}/fallback`] },
					retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 },
				},
			});
			harnesses.push(harness);
			harness.setResponses([providerFailure(kind), fauxAssistantMessage("must remain unused")]);

			const handle = await harness.session.runRlmChild(`reject ${kind} fallback`);
			await waitForChildStatus(harness, handle.rlm_child_id, "error");
			const child = await waitForChild(harness, handle.rlm_child_id);

			expect(child.model?.id).toBe("primary");
			expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(1);
		});
	}

	it("does not attach a configured role chain to an exact selector", async () => {
		const provider = "role-fallback-exact";
		const harness = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			provider,
			models: [{ id: "primary" }, { id: "fallback" }],
			settings: {
				modelRoles: { task: [`${provider}/primary`, `${provider}/fallback`] },
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 },
			},
		});
		harnesses.push(harness);
		harness.setResponses([providerFailure("server_error"), fauxAssistantMessage("unused")]);

		const handle = await harness.session.runRlmChild("preserve exact selection", { model: `${provider}/primary` });
		await waitForChildStatus(harness, handle.rlm_child_id, "error");
		const child = await waitForChild(harness, handle.rlm_child_id);

		expect(child.model?.id).toBe("primary");
		expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(1);
	});

	for (const [name, content] of [
		["text", [{ type: "text" as const, text: "partial output" }]],
		["thinking", [fauxThinking("private reasoning")]],
		["tool call", [fauxToolCall("side_effect", {})]],
	] as const) {
		it(`does not fallback after replay-unsafe ${name} output`, async () => {
			const provider = `role-fallback-unsafe-${name.replaceAll(" ", "-")}`;
			const harness = await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				provider,
				models: [{ id: "primary" }, { id: "fallback" }],
				settings: {
					modelRoles: { task: [`${provider}/primary`, `${provider}/fallback`] },
					retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 },
				},
			});
			harnesses.push(harness);
			const failure = providerFailure("server_error");
			failure.content = [...content];
			harness.setResponses([failure, fauxAssistantMessage("unused")]);

			const handle = await harness.session.runRlmChild(`preserve ${name} output`);
			await waitForChildStatus(harness, handle.rlm_child_id, "error");
			const child = await waitForChild(harness, handle.rlm_child_id);

			expect(child.model?.id).toBe("primary");
			expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(1);
		});
	}
});
