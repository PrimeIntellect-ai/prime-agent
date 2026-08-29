import { createSocket, type RemoteInfo } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { createDatadogTokensExtension, createDogStatsDClient } from "../src/core/extensions/builtin/datadog-tokens.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";

interface CapturedPacket {
	metric: string;
	value: number;
	type: string;
	tags: string[];
	raw: string;
}

function parsePacket(raw: string): CapturedPacket {
	const [head, ...rest] = raw.split("|");
	const [name, value] = head.split(":");
	const tags = rest.find((part) => part.startsWith("#"));
	return {
		metric: name,
		value: Number(value),
		type: rest.find((part) => part.startsWith("c") || part.startsWith("h"))?.[0] ?? "",
		tags: tags ? tags.slice(1).split(",") : [],
		raw,
	};
}

function createMockPi() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "anthropic-messages",
		provider: "custom:midagent",
		model: "glm-53-fp8-mi325",
		usage: { input: 100, output: 42, cacheRead: 7, cacheWrite: 3, totalTokens: 152 },
		stopReason: "stop",
		timestamp: Date.now() - 500,
		...overrides,
	};
}

async function startUdpCollector(): Promise<{
	port: number;
	packets: CapturedPacket[];
	waitForPackets: (count: number, timeoutMs?: number) => Promise<void>;
	stop: () => Promise<void>;
}> {
	const packets: CapturedPacket[] = [];
	const socket = createSocket("udp4");
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	let stopped = false;

	socket.on("message", (msg: Buffer, _rinfo: RemoteInfo) => {
		for (const line of msg.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			packets.push(parsePacket(line));
		}
		for (const waiter of [...waiters]) {
			if (packets.length >= waiter.count) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	});

	const port = await new Promise<number>((resolve) => {
		socket.bind(0, "127.0.0.1", () => resolve(socket.address().port));
	});

	return {
		port,
		packets,
		waitForPackets(count: number, timeoutMs = 3000) {
			if (packets.length >= count) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timeout: got ${packets.length}/${count}`)), timeoutMs);
				waiters.push({
					count,
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
				});
			});
		},
		stop: () =>
			new Promise((resolve) => {
				if (stopped) {
					resolve();
					return;
				}
				stopped = true;
				socket.close(() => resolve());
			}),
	};
}

describe("createDogStatsDClient", () => {
	it("returns null when disabled", () => {
		expect(createDogStatsDClient(false, "127.0.0.1", 8125)).toBeNull();
	});
});

describe("datadog-tokens extension", () => {
	let collector: Awaited<ReturnType<typeof startUdpCollector>>;
	const prevEnv = { ...process.env };

	afterEach(async () => {
		process.env = { ...prevEnv };
		if (collector) await collector.stop();
	});

	it("emits token counters and api.call when enabled", async () => {
		collector = await startUdpCollector();
		process.env.PRIME_AGENT_DATADOG_METRICS = "1";
		process.env.PRIME_AGENT_DATADOG_AGENT_HOST = "127.0.0.1";
		process.env.PRIME_AGENT_DATADOG_AGENT_PORT = String(collector.port);

		const { pi, handlers } = createMockPi();
		createDatadogTokensExtension()(pi);

		const messageEndHandlers = handlers.get("message_end") ?? [];
		expect(messageEndHandlers.length).toBe(1);

		for (const handler of messageEndHandlers) {
			await handler({ type: "message_end", message: assistantMessage() }, {} as never);
			// allow the UDP send callback to flush
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		await collector.waitForPackets(7);
		const byMetric = new Map(collector.packets.map((p) => [p.metric, p]));

		expect(byMetric.get("prime.tokens.input")?.value).toBe(100);
		expect(byMetric.get("prime.tokens.output")?.value).toBe(42);
		expect(byMetric.get("prime.tokens.cache_read")?.value).toBe(7);
		expect(byMetric.get("prime.tokens.cache_write")?.value).toBe(3);
		expect(byMetric.get("prime.tokens.total")?.value).toBe(152);
		expect(byMetric.get("prime.api.calls")?.value).toBe(1);
		expect(byMetric.get("prime.api.duration_ms")?.type).toBe("h");

		for (const packet of collector.packets) {
			expect(packet.tags).toContain("model:glm-53-fp8-mi325");
			// ":" is sanitized per the DogStatsD wire format.
			expect(packet.tags).toContain("provider:custom_midagent");
			expect(packet.tags).toContain("api:anthropic-messages");
			const expectedType = packet.metric === "prime.api.duration_ms" ? "h" : "c";
			expect(packet.type).toBe(expectedType);
		}
	});

	it("prefers responseModel over requested model", async () => {
		collector = await startUdpCollector();
		process.env.PRIME_AGENT_DATADOG_METRICS = "1";
		process.env.PRIME_AGENT_DATADOG_AGENT_PORT = String(collector.port);

		const { pi, handlers } = createMockPi();
		createDatadogTokensExtension()(pi);
		const handler = handlers.get("message_end")?.[0];

		await handler?.(
			{
				type: "message_end",
				message: assistantMessage({ responseModel: "anthropic/claude-x" }),
			},
			{} as never,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await collector.waitForPackets(6);

		const input = collector.packets.find((p) => p.metric === "prime.tokens.input");
		expect(input?.tags).toContain("model:anthropic/claude-x");
	});

	it("does not register handlers when disabled", () => {
		delete process.env.PRIME_AGENT_DATADOG_METRICS;
		const { pi, handlers } = createMockPi();
		createDatadogTokensExtension()(pi);
		expect(handlers.size).toBe(0);
	});

	it("skips zero-value counters but still emits api.calls", async () => {
		collector = await startUdpCollector();
		process.env.PRIME_AGENT_DATADOG_METRICS = "1";
		process.env.PRIME_AGENT_DATADOG_AGENT_PORT = String(collector.port);

		const { pi, handlers } = createMockPi();
		createDatadogTokensExtension()(pi);
		const handler = handlers.get("message_end")?.[0];

		await handler?.(
			{
				type: "message_end",
				message: assistantMessage({
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				}),
			},
			{} as never,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await collector.waitForPackets(2);

		// Zero token counters are skipped; api.calls and the (positive) duration
		// histogram still go out.
		expect(collector.packets.map((p) => p.metric).sort()).toEqual(["prime.api.calls", "prime.api.duration_ms"]);
	});

	it("never throws from the message_end handler", async () => {
		process.env.PRIME_AGENT_DATADOG_METRICS = "1";
		const { pi, handlers } = createMockPi();
		createDatadogTokensExtension()(pi);
		const handler = handlers.get("message_end")?.[0];

		// Malformed messages must not break the agent loop (fail-open catch inside).
		expect(() => handler?.({ type: "message_end", message: { role: "assistant" } }, {} as never)).not.toThrow();
		expect(() => handler?.({ type: "message_end", message: null }, {} as never)).not.toThrow();
		expect(() =>
			handler?.({ type: "message_end", message: { role: "assistant", usage: null } }, {} as never),
		).not.toThrow();
	});
});
