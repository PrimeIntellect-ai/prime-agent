import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDelegatedProviderAdapter } from "../src/delegated-provider.js";
import type { AssistantMessage, Model } from "../src/types.js";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	contextWindow: 1000,
	maxTokens: 100,
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const doneMessage: AssistantMessage = {
	role: "assistant",
	content: [],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: Date.now(),
};

describe("delegated provider adapter", () => {
	let server: ReturnType<typeof createServer> | undefined;
	const roots: string[] = [];
	afterEach(async () => {
		if (server?.listening) { server.close(); await once(server, "close"); }
		server = undefined;
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("sends no api key or headers and forwards host stream events", async () => {
		server = createServer((socket) => {
			let request = "";
			socket.on("data", (chunk) => {
				request += chunk.toString();
				const newline = request.indexOf("\n");
				if (newline < 0) return;
				const start = JSON.parse(request.slice(0, newline));
				captured = start;
				socket.end([
					JSON.stringify({ type: "event", id: start.id, event: { type: "start", partial: doneMessage } }),
					JSON.stringify({ type: "event", id: start.id, event: { type: "done", message: doneMessage } }),
				].join("\n") + "\n");
			});
		});
		let captured: Record<string, any> | undefined;
		const root = await mkdtemp(join(tmpdir(), "pi-broker-adapter-")); roots.push(root);
		const socketPath = join(root, "broker.sock");
		server.listen(socketPath);
		await once(server, "listening");
		const adapter = createDelegatedProviderAdapter({ socketPath, capability: "capability-value-that-is-long-enough-1234567890" });
		const events = adapter.stream(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, {
			apiKey: "secret-provider-key-should-not-cross-the-socket",
			headers: { Authorization: "Bearer secret-header-token" },
			maxTokens: 24,
		});
		const received = [];
		for await (const event of events) received.push(event.type);
		expect(received).toEqual(["start", "done"]);
		expect(captured).toMatchObject({ model: { provider: "openai", api: "openai-responses", id: "test-model" }, options: { maxTokens: 24 } });
		expect(JSON.stringify(captured)).not.toContain("secret-provider-key");
		expect(JSON.stringify(captured)).not.toContain("secret-header-token");
		expect(JSON.stringify(captured)).not.toContain("Authorization");
	});

	it("cancels the host request when the caller aborts", async () => {
		let closed: Promise<unknown>;
		server = createServer((socket) => {
			closed = once(socket, "close");
			socket.once("data", () => undefined);
		});
		const root = await mkdtemp(join(tmpdir(), "pi-broker-adapter-")); roots.push(root);
		const socketPath = join(root, "broker.sock");
		server.listen(socketPath);
		await once(server, "listening");
		const controller = new AbortController();
		const adapter = createDelegatedProviderAdapter({ socketPath, capability: "capability-value-that-is-long-enough-1234567890" });
		const events = adapter.stream(model, { messages: [] }, { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		const result = await events.result();
		expect(result.stopReason).toBe("aborted");
		await closed!;
	});
});
