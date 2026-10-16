import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import { stream, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "./model-registry.js";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_REQUESTS_PER_BROKER = 64;

export interface DelegatedProviderBrokerOptions {
	socketPath: string;
	capability: string;
	modelRegistry: ModelRegistry;
	allowedModels: Array<{ provider: string; api: string; id: string }>;
	maxRequests?: number;
	maxOutputTokens?: number;
}

interface StartFrame {
	type: "start";
	id: string;
	capability: string;
	model: { provider: string; api: string; id: string };
	context: Context;
	options: Pick<SimpleStreamOptions, "temperature" | "maxTokens" | "transport" | "serviceTier" | "cacheRetention" | "sessionId" | "reasoning" | "thinkingBudgets">;
}

/**
 * Serves SDK provider requests from a trusted host. The API key is resolved
 * and consumed only in this process; the socket protocol only carries model
 * identity, prompt context, bounded options, and a short-lived capability.
 */
export async function startDelegatedProviderBroker(options: DelegatedProviderBrokerOptions): Promise<{ close(): Promise<void> }> {
	if (Buffer.byteLength(options.capability) < 32) throw new Error("Broker capability must contain at least 32 bytes");
	const maxRequests = options.maxRequests ?? MAX_REQUESTS_PER_BROKER;
	const maxOutputTokens = options.maxOutputTokens ?? 8192;
	let requestCount = 0;
	const allowed = new Set(options.allowedModels.map((model) => `${model.provider}\0${model.api}\0${model.id}`));
	if (allowed.size === 0) throw new Error("Broker requires at least one allowed model");

	await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
	await rm(options.socketPath, { force: true });
	const server = createServer((socket) => {
		void serveRequest(socket).catch((error) => {
			writeFrame(socket, { type: "error", id: "", message: safeError(error) }).catch(() => {});
			socket.destroy();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => { server.off("error", reject); resolve(); });
	});
	await chmod(options.socketPath, 0o600);

	async function serveRequest(socket: Socket): Promise<void> {
		const abort = new AbortController();
		socket.once("close", () => abort.abort());
		const line = await readFirstLine(socket, MAX_REQUEST_BYTES, abort.signal);
		const request = JSON.parse(line) as StartFrame;
		if (request.type !== "start" || typeof request.id !== "string" || request.id.length > 80) throw new Error("Invalid broker request");
		if (!equalCapability(request.capability, options.capability)) throw new Error("Invalid broker capability");
		if (++requestCount > maxRequests) throw new Error("Broker request limit reached");
		const key = `${request.model?.provider}\0${request.model?.api}\0${request.model?.id}`;
		if (!allowed.has(key)) throw new Error("Model is outside this run's broker capability");
		if (!request.context || !Array.isArray(request.context.messages)) throw new Error("Invalid broker context");
		const model = options.modelRegistry.find(request.model.provider, request.model.id) as Model<any> | undefined;
		if (!model || model.api !== request.model.api) throw new Error("Requested model is unavailable");
		const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "Provider is not authenticated" : auth.error);
		const maxTokens = Math.max(1, Math.min(Number.isInteger(request.options?.maxTokens) ? request.options!.maxTokens! : maxOutputTokens, maxOutputTokens, model.maxTokens));
		const providerStream = stream(model, request.context, {
			...request.options,
			maxTokens,
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: abort.signal,
		});
		for await (const event of providerStream) {
			if (abort.signal.aborted) break;
			await writeFrame(socket, { type: "event", id: request.id, event: redactSecrets(event, [auth.apiKey, ...Object.values(auth.headers ?? {})]) });
			if (event.type === "done" || event.type === "error") break;
		}
	}

	return {
		close: async () => {
			server.close();
			await rm(options.socketPath, { force: true });
		},
	};
}

function equalCapability(candidate: unknown, expected: string): boolean {
	if (typeof candidate !== "string") return false;
	const left = Buffer.from(candidate);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_.-]{20,})\b/g, "[redacted]").slice(0, 500);
}

function redactSecrets(value: unknown, secrets: string[]): unknown {
	if (typeof value === "string") {
		let safe = value;
		for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redacted]");
		return safe;
	}
	if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, secrets));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSecrets(entry, secrets)]));
	}
	return value;
}

function readFirstLine(socket: Socket, maxBytes: number, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
			signal.removeEventListener("abort", onAbort);
		};
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			if (Buffer.byteLength(buffer) > maxBytes) { cleanup(); reject(new Error("Broker request is too large")); return; }
			const newline = buffer.indexOf("\n");
			if (newline >= 0) { cleanup(); resolve(buffer.slice(0, newline)); }
		};
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onAbort = () => { cleanup(); reject(new Error("Broker client disconnected")); };
		socket.on("data", onData);
		socket.once("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function writeFrame(socket: Socket, frame: unknown): Promise<void> {
	if (socket.destroyed) return;
	const line = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw new Error("Broker response is too large");
	if (socket.write(line)) return;
	await new Promise<void>((resolve, reject) => {
		socket.once("drain", resolve);
		socket.once("error", reject);
	});
}
