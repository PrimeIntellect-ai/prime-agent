import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createDelegatedProviderAdapter,
	registerApiProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { startDelegatedProviderBroker } from "../src/core/delegated-provider-broker.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("trusted SDK provider broker", () => {
	let root: string | undefined;
	let broker: Awaited<ReturnType<typeof startDelegatedProviderBroker>> | undefined;
	afterEach(async () => {
		await broker?.close();
		broker = undefined;
		if (root) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	function modelRegistry() {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("broker-test", {
			name: "Broker test",
			api: "broker-test-api",
			apiKey: "host-only-provider-secret-value",
			baseUrl: "https://provider.invalid/v1",
			models: [
				{
					id: "model-1",
					name: "Model 1",
					api: "broker-test-api",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
		});
		return registry;
	}

	it("runs Pi SDK streams on the host and redacts host credentials from events", async () => {
		let hostApiKey: string | undefined;
		const stream = (_model: any, _context: any, options: any): AssistantMessageEventStream => {
			hostApiKey = options.apiKey;
			const result = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `host key: ${options.apiKey}` }],
				api: "broker-test-api",
				provider: "broker-test",
				model: "model-1",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			result.push({ type: "start", partial: message });
			result.push({ type: "done", reason: "stop", message });
			return result;
		};
		registerApiProvider({ api: "broker-test-api", stream, streamSimple: stream });
		root = await mkdtemp(join(tmpdir(), "pi-provider-broker-"));
		const socketPath = join(root, "provider.sock");
		const capability = "broker-capability-that-is-only-valid-for-this-test-123456";
		const registry = modelRegistry();
		broker = await startDelegatedProviderBroker({
			socketPath,
			capability,
			modelRegistry: registry,
			allowedModels: [{ provider: "broker-test", api: "broker-test-api", id: "model-1" }],
		});
		const adapter = createDelegatedProviderAdapter({ socketPath, capability });
		const model = registry.find("broker-test", "model-1")!;
		const result = adapter.stream(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ apiKey: "sandbox-controlled-value", headers: { Authorization: "Bearer sandbox-controlled-value" } },
		);
		const received: string[] = [];
		for await (const event of result) received.push(JSON.stringify(event));
		expect(hostApiKey).toBe("host-only-provider-secret-value");
		expect(received.join("\n")).toContain("host key: [redacted]");
		expect(received.join("\n")).not.toContain("host-only-provider-secret-value");
		expect(received.join("\n")).not.toContain("sandbox-controlled-value");
	});

	it("aborts the host SDK stream when the sandbox disconnects", async () => {
		let hostAborted = false;
		let resolveHostAbort!: () => void;
		const hostAbort = new Promise<void>((resolve) => {
			resolveHostAbort = resolve;
		});
		const stream = (_model: any, _context: any, options: any): AssistantMessageEventStream => {
			const result = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "broker-test-api",
				provider: "broker-test",
				model: "model-1",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				timestamp: Date.now(),
			};
			result.push({ type: "start", partial: message });
			options.signal.addEventListener(
				"abort",
				() => {
					hostAborted = true;
					resolveHostAbort();
					result.push({
						type: "error",
						reason: "aborted",
						error: { ...message, errorMessage: "aborted", stopReason: "aborted" },
					});
				},
				{ once: true },
			);
			return result;
		};
		registerApiProvider({ api: "broker-test-api", stream, streamSimple: stream });
		root = await mkdtemp(join(tmpdir(), "pi-provider-broker-"));
		const socketPath = join(root, "provider.sock");
		const capability = "broker-capability-that-is-only-valid-for-this-test-123456";
		const registry = modelRegistry();
		broker = await startDelegatedProviderBroker({
			socketPath,
			capability,
			modelRegistry: registry,
			allowedModels: [{ provider: "broker-test", api: "broker-test-api", id: "model-1" }],
		});
		const adapter = createDelegatedProviderAdapter({ socketPath, capability });
		const controller = new AbortController();
		const result = adapter.stream(
			registry.find("broker-test", "model-1")!,
			{ messages: [] },
			{ signal: controller.signal },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		const final = await result.result();
		await hostAbort;
		expect(final.stopReason).toBe("aborted");
		expect(hostAborted).toBe(true);
	});

	it("refreshes OAuth only in the host before dispatching the provider stream", async () => {
		const provider = `broker-oauth-${randomUUID()}`;
		let refreshCalls = 0;
		let hostApiKey: string | undefined;
		const authStorage = AuthStorage.inMemory();
		authStorage.set(provider, {
			type: "oauth",
			access: "expired-host-access-token",
			refresh: "old-host-refresh-token",
			expires: Date.now() - 1000,
		});
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider(provider, {
			name: "Broker refresh test",
			api: "broker-oauth-api",
			baseUrl: "https://provider.invalid/v1",
			oauth: {
				name: "Broker refresh test",
				async login() {
					throw new Error("not used");
				},
				async refreshToken(credentials) {
					refreshCalls++;
					return {
						...credentials,
						access: "fresh-host-access-token",
						refresh: "fresh-host-refresh-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			},
			models: [
				{
					id: "model-1",
					name: "Model 1",
					api: "broker-oauth-api",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
		});
		const hostStream = (_model: any, _context: any, options: any): AssistantMessageEventStream => {
			hostApiKey = options.apiKey;
			const result = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: options.apiKey }],
				api: "broker-oauth-api",
				provider,
				model: "model-1",
				usage: {
					input: 0,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			result.push({ type: "start", partial: message });
			result.push({ type: "done", reason: "stop", message });
			return result;
		};
		registerApiProvider({ api: "broker-oauth-api", stream: hostStream, streamSimple: hostStream });
		root = await mkdtemp(join(tmpdir(), "pi-provider-broker-refresh-"));
		const capability = "broker-capability-that-is-only-valid-for-this-test-123456";
		broker = await startDelegatedProviderBroker({
			socketPath: join(root, "provider.sock"),
			capability,
			modelRegistry: registry,
			allowedModels: [{ provider, api: "broker-oauth-api", id: "model-1" }],
		});
		const model = registry.find(provider, "model-1")!;
		const adapter = createDelegatedProviderAdapter({ socketPath: join(root, "provider.sock"), capability });
		const received: string[] = [];
		for await (const event of adapter.stream(model, { messages: [] }, {})) received.push(JSON.stringify(event));
		expect(refreshCalls).toBe(1);
		expect(hostApiKey).toBe("fresh-host-access-token");
		expect(received.join("\n")).not.toContain("fresh-host-access-token");
		expect(received.join("\n")).toContain("[redacted]");
		expect(authStorage.get(provider)).toMatchObject({
			access: "fresh-host-access-token",
			refresh: "fresh-host-refresh-token",
		});
	});
});
