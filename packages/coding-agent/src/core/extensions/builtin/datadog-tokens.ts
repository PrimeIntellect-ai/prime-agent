/**
 * Built-in Datadog token-metrics extension.
 *
 * Emits per-API-call token counts as DogStatsD metrics labeled by model,
 * provider, and API type — the Prime Agent equivalent of Hermes'
 * `plugins/observability/datadog_tokens` plugin. Uses non-blocking UDP to
 * a local DogStatsD agent (default 127.0.0.1:8125).
 *
 * Metrics emitted (all counters, Datadog auto-rollups by time window):
 *
 *   prime.tokens.input        — prompt/input tokens per API call
 *   prime.tokens.output       — completion/output tokens per API call
 *   prime.tokens.cache_read   — cache-read tokens (cached prefix replay)
 *   prime.tokens.cache_write  — cache-write tokens (newly cached prefix)
 *   prime.tokens.total        — total tokens per API call
 *   prime.api.calls           — 1 per assistant message (request counter)
 *   prime.api.duration_ms     — request-to-message-end duration (HISTOGRAM)
 *
 * All metrics tagged with:
 *   model     — the model that served the request (responseModel preferred)
 *   provider  — the provider string (openai, anthropic, custom:midagent, ...)
 *   api       — the API protocol (openai-completions, anthropic-messages, ...)
 *
 * Disabled by default. Enable with PRIME_AGENT_DATADOG_METRICS=1.
 * Optional env vars:
 *   PRIME_AGENT_DATADOG_AGENT_HOST  — DogStatsD host (default: 127.0.0.1)
 *   PRIME_AGENT_DATADOG_AGENT_PORT  — DogStatsD port (default: 8125)
 *
 * Fail-open: UDP sends never block the agent loop and never throw into it.
 */

import { createSocket } from "node:dgram";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "../types.js";

/** Characters that break the DogStatsD wire format (pipe, comma, colon, whitespace). */
const TAG_SANITIZE_RE = /[|:,\s\r\n]/g;

interface DogStatsDClient {
	send(metric: string, value: number, type: "c" | "h", tags: string[]): void;
	close(): void;
}

/** Parse a positive-int env value, falling back when absent or malformed. */
function parsePortEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Create a lazily-initialized DogStatsD client over a UDP socket.
 * Returns null when metrics are disabled via env. The socket is unref'd so
 * it never keeps the process alive, and send failures are swallowed —
 * observability must never break the agent.
 */
export function createDogStatsDClient(enabled: boolean, host: string, port: number): DogStatsDClient | null {
	if (!enabled) return null;

	let socket: import("node:dgram").Socket | undefined;
	let closed = false;

	function ensureSocket(): import("node:dgram").Socket {
		if (!socket) {
			socket = createSocket("udp4");
			socket.unref();
		}
		return socket;
	}

	return {
		send(metric, value, type, tags) {
			if (closed) return;
			try {
				const tagSuffix = tags.length > 0 ? `|#${tags.join(",")}` : "";
				const packet = `${metric}:${value}|${type}${tagSuffix}`;
				const buf = Buffer.from(packet, "utf8");
				ensureSocket().send(buf, port, host, () => {
					// Fire-and-forget: ignore DNS/send errors, UDP is best-effort.
				});
			} catch {
				// Fail-open: metrics are best-effort.
			}
		},
		close() {
			closed = true;
			try {
				socket?.close();
			} catch {
				// already closed
			}
			socket = undefined;
		},
	};
}

/** Build a sorted tag list, sanitizing values for the DogStatsD wire format. */
function safeTags(values: Record<string, string>): string[] {
	const tags: string[] = [];
	for (const key of Object.keys(values).sort()) {
		const raw = values[key] || "unknown";
		tags.push(`${key}:${String(raw).replace(TAG_SANITIZE_RE, "_")}`);
	}
	return tags;
}

export interface DatadogTokensResult {
	metrics: string[];
}

function datadogTokensExtensionImpl(pi: ExtensionAPI, client: DogStatsDClient): void {
	pi.on("message_end", (event) => {
		try {
			const message = event.message;
			if (message.role !== "assistant") return;
			const msg = message as AssistantMessage;

			const tags = safeTags({
				model: msg.responseModel || msg.model,
				provider: msg.provider,
				api: msg.api,
			});

			// Counter metrics — skip zero values to avoid empty timeseries.
			const counts: Array<[string, number]> = [
				["prime.tokens.input", msg.usage?.input ?? 0],
				["prime.tokens.output", msg.usage?.output ?? 0],
				["prime.tokens.cache_read", msg.usage?.cacheRead ?? 0],
				["prime.tokens.cache_write", msg.usage?.cacheWrite ?? 0],
				["prime.tokens.total", msg.usage?.totalTokens ?? 0],
			];
			for (const [metric, value] of counts) {
				if (value > 0) {
					client.send(metric, value, "c", tags);
				}
			}

			// Request counter: 1 per assistant message (i.e. per API call).
			client.send("prime.api.calls", 1, "c", tags);

			// Duration histogram (ms), from request start to message end.
			const durationMs = Date.now() - msg.timestamp;
			if (Number.isFinite(durationMs) && durationMs > 0) {
				client.send("prime.api.duration_ms", durationMs, "h", tags);
			}
		} catch {
			// Fail-open: never block or crash the agent loop from a metrics hook.
		}
	});
}

/**
 * Extension factory for Datadog token metrics. Self-disables when
 * PRIME_AGENT_DATADOG_METRICS is not "1", so it is safe to always load.
 */
export function createDatadogTokensExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const enabled = process.env.PRIME_AGENT_DATADOG_METRICS === "1";
		if (!enabled) return;
		const host = process.env.PRIME_AGENT_DATADOG_AGENT_HOST || "127.0.0.1";
		const port = parsePortEnv("PRIME_AGENT_DATADOG_AGENT_PORT", 8125);
		const client = createDogStatsDClient(enabled, host, port);
		if (!client) return;
		datadogTokensExtensionImpl(pi, client);
	};
}
