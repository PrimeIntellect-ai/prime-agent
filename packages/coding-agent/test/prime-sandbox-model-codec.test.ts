import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type DecodeReplyResult,
	type DecodeRequestResult,
	decodeModelReplyBytes,
	decodeModelRequestBytes,
	type EncodeResult,
	encodeModelReply,
	encodeModelRequest,
} from "../src/modes/daemon/sandbox/prime-sandbox-model-codec.js";

function encodeOk(result: EncodeResult): Uint8Array {
	expect(result.ok).toBe(true);
	if (result.ok) return result.bytes;
	return new Uint8Array(0);
}

function encodeFails(result: EncodeResult, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe(code);
}

function requestFails(result: DecodeRequestResult, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe(code);
}

function replyFails(result: DecodeReplyResult, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.code).toBe(code);
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUsage(): object {
	return {
		input: 5,
		output: 10,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 18,
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
	};
}

function validAssistantMessage(): object {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Hello!", textSignature: "text-sig" },
			{ type: "thinking", thinking: "Reasoning", thinkingSignature: "thought-sig", redacted: false },
			{
				type: "toolCall",
				id: "call-1",
				name: "lookup",
				arguments: { query: "weather" },
				thoughtSignature: "opaque",
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		responseModel: "claude-test-2026",
		responseId: "response-1",
		diagnostics: [
			{
				type: "provider_transport_failure",
				timestamp: 1900,
				error: { name: "Error", message: "retry", stack: "redacted", code: "ETIMEDOUT" },
				details: { attempt: 2, recovered: true },
			},
		],
		usage: validUsage(),
		stopReason: "toolUse",
		stopReasonRaw: "tool_calls",
		errorMessage: null,
		timestamp: 2000,
	};
}

function validContext(): object {
	return {
		systemPrompt: "Be concise.",
		messages: [{ role: "user", content: "hello", timestamp: 1000 }],
		tools: [],
	};
}

function validOptions(): object {
	return {
		cacheRetention: "short",
		maxTokens: 1024,
		reasoning: "medium",
		serviceTier: "auto",
		sessionId: "session-1",
		temperature: 0.7,
		thinkingBudgets: { minimal: 128, low: 256, medium: 512, high: 1024 },
	};
}

describe("request wire", () => {
	it("roundtrips exact context and seven options", () => {
		const encoded = encodeOk(encodeModelRequest(validContext(), validOptions()));
		const decoded = decodeModelRequestBytes(encoded);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(Object.isFrozen(decoded.request)).toBe(true);
		expect(Object.isFrozen(decoded.request.context)).toBe(true);
		expect(Object.isFrozen(decoded.request.options)).toBe(true);
		if (!isRecord(decoded.request.context) || !isRecord(decoded.request.options)) return;
		expect(decoded.request.context.systemPrompt).toBe("Be concise.");
		expect(decoded.request.context.tools).toEqual([]);
		expect(decoded.request.options.maxTokens).toBe(1024);
		expect(decoded.request.options.thinkingBudgets).toEqual({ high: 1024, low: 256, medium: 512, minimal: 128 });
	});

	it("writes explicit null context and option fields", () => {
		const encoded = encodeOk(encodeModelRequest({ messages: [] }, null));
		const decoded = decodeModelRequestBytes(encoded);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok || !isRecord(decoded.request.context) || !isRecord(decoded.request.options)) return;
		expect(decoded.request.context).toEqual({ messages: [], systemPrompt: null, tools: null });
		expect(decoded.request.options).toEqual({
			cacheRetention: null,
			maxTokens: null,
			reasoning: null,
			serviceTier: null,
			sessionId: null,
			temperature: null,
			thinkingBudgets: null,
		});
	});

	it("rejects extra context and option keys", () => {
		encodeFails(encodeModelRequest({ messages: [], model: "forbidden" }, validOptions()), "INPUT_INVALID");
		const options = validOptions();
		Object.defineProperty(options, "apiKey", { value: "secret", enumerable: true });
		encodeFails(encodeModelRequest(validContext(), options), "INPUT_INVALID");
	});

	it("validates option bounds and finite numbers", () => {
		encodeFails(encodeModelRequest(validContext(), { ...validOptions(), maxTokens: 0 }), "INPUT_INVALID");
		encodeFails(encodeModelRequest(validContext(), { ...validOptions(), temperature: -1 }), "INPUT_INVALID");
		encodeFails(encodeModelRequest(validContext(), { ...validOptions(), temperature: Infinity }), "INPUT_INVALID");
		encodeFails(
			encodeModelRequest(validContext(), { ...validOptions(), thinkingBudgets: { high: -1 } }),
			"INPUT_INVALID",
		);
		encodeFails(
			encodeModelRequest(validContext(), { ...validOptions(), sessionId: "x".repeat(4097) }),
			"INPUT_INVALID",
		);
	});

	it("accepts TypeBox parameters and emits plain schema", () => {
		const context = {
			messages: [],
			tools: [{ name: "lookup", description: "Lookup", parameters: Type.Object({ query: Type.String() }) }],
		};
		const encoded = encodeOk(encodeModelRequest(context, validOptions()));
		const decoded = decodeModelRequestBytes(encoded);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok || !isRecord(decoded.request.context)) return;
		expect(decoded.request.context.tools).toEqual([
			{
				description: "Lookup",
				name: "lookup",
				parameters: {
					properties: { query: { type: "string" } },
					required: ["query"],
					type: "object",
				},
			},
		]);
	});

	it("rejects images everywhere in request messages", () => {
		const user = {
			messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }],
		};
		const tool = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "view",
					content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
					isError: false,
					timestamp: 1,
				},
			],
		};
		encodeFails(encodeModelRequest(user, validOptions()), "INPUT_INVALID");
		encodeFails(encodeModelRequest(tool, validOptions()), "INPUT_INVALID");
	});

	it("preserves exact user and tool-result optional wire fields", () => {
		const context = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "lookup",
					content: [{ type: "text", text: "done" }],
					details: { elapsed: 3 },
					isError: false,
					timestamp: 2,
				},
			],
		};
		const encoded = encodeOk(encodeModelRequest(context, validOptions()));
		const decoded = decodeModelRequestBytes(encoded);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok || !isRecord(decoded.request.context)) return;
		const messages = decoded.request.context.messages;
		expect(messages).toEqual([
			{ content: [{ text: "go", textSignature: null, type: "text" }], role: "user", timestamp: 1 },
			{
				content: [{ text: "done", textSignature: null, type: "text" }],
				details: { elapsed: 3 },
				isError: false,
				role: "toolResult",
				timestamp: 2,
				toolCallId: "call-1",
				toolName: "lookup",
			},
		]);
	});
});

describe("raw ownership", () => {
	it("rejects an alias shared by tool arguments and parameters", () => {
		const shared = { type: "object", properties: {} };
		const context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "1", name: "x", arguments: shared }],
					api: "api",
					provider: "provider",
					model: "model",
					usage: validUsage(),
					stopReason: "toolUse",
					timestamp: 1,
				},
			],
			tools: [{ name: "x", description: "x", parameters: shared }],
		};
		encodeFails(encodeModelRequest(context, validOptions()), "INPUT_INVALID");
	});

	it("rejects aliases across diagnostic details and tool-result details", () => {
		const shared = { retry: true };
		const assistant = validAssistantMessage();
		Object.defineProperty(assistant, "diagnostics", {
			value: [{ type: "retry", timestamp: 1, details: shared }],
			enumerable: true,
			configurable: true,
		});
		const context = {
			messages: [
				assistant,
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "x",
					content: [],
					details: shared,
					isError: false,
					timestamp: 2,
				},
			],
		};
		encodeFails(encodeModelRequest(context, validOptions()), "INPUT_INVALID");
	});

	it("rejects an alias shared by tool-result details and parameters", () => {
		const shared = { type: "object", properties: {} };
		const context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "x",
					content: [],
					details: shared,
					isError: false,
					timestamp: 2,
				},
			],
			tools: [{ name: "x", description: "x", parameters: shared }],
		};
		encodeFails(encodeModelRequest(context, validOptions()), "INPUT_INVALID");
	});
});

describe("canonical decoder", () => {
	it("rejects duplicate object keys before semantic parsing", () => {
		replyFails(
			decodeModelReplyBytes(bytes('{"code":"INTERNAL_ERROR","code":"INTERNAL_ERROR","ok":false}')),
			"PROTOCOL_ERROR",
		);
		replyFails(
			decodeModelReplyBytes(bytes('{"\\u006f\\u006b":false,"code":"INTERNAL_ERROR","ok":false}')),
			"PROTOCOL_ERROR",
		);
	});

	it("rejects whitespace, key order, and alternate escapes", () => {
		replyFails(decodeModelReplyBytes(bytes('{"code":"INTERNAL_ERROR", "ok":false}')), "PROTOCOL_ERROR");
		replyFails(decodeModelReplyBytes(bytes('{"ok":false,"code":"INTERNAL_ERROR"}')), "PROTOCOL_ERROR");
		replyFails(decodeModelReplyBytes(bytes('{"code":"INTERNAL_\\u0045RROR","ok":false}')), "PROTOCOL_ERROR");
	});

	it("rejects excessive scanner nesting before semantic parsing", () => {
		const deep = `${"[".repeat(40)}0${"]".repeat(40)}`;
		replyFails(decodeModelReplyBytes(bytes(deep)), "PROTOCOL_ERROR");
	});

	it("rejects malformed JSON and malformed UTF-8", () => {
		replyFails(decodeModelReplyBytes(bytes('{"ok":')), "FRAME_ERROR");
		replyFails(decodeModelReplyBytes(new Uint8Array([0xff])), "UTF8_ERROR");
	});

	it("rejects request roots with missing, extra, or noncanonical bytes", () => {
		requestFails(decodeModelRequestBytes(bytes('{"context":{}}')), "PROTOCOL_ERROR");
		requestFails(decodeModelRequestBytes(bytes('{"context":{},"extra":0,"options":{}}')), "PROTOCOL_ERROR");
		const canonical = encodeOk(encodeModelRequest(validContext(), validOptions()));
		const text = new TextDecoder().decode(canonical);
		requestFails(decodeModelRequestBytes(bytes(` ${text}`)), "PROTOCOL_ERROR");
	});
});

describe("assistant reply", () => {
	it("preserves safe provider output fields", () => {
		const encoded = encodeOk(encodeModelReply(validAssistantMessage()));
		const decoded = decodeModelReplyBytes(encoded);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok || !decoded.reply.ok) return;
		const message = decoded.reply.message;
		expect(Object.isFrozen(decoded.reply)).toBe(true);
		expect(Object.isFrozen(message)).toBe(true);
		expect(message.api).toBe("anthropic-messages");
		expect(message.provider).toBe("anthropic");
		expect(message.model).toBe("claude-test");
		expect(message.responseModel).toBe("claude-test-2026");
		expect(message.responseId).toBe("response-1");
		expect(message.diagnostics).toBeNull();
		expect(message.content).toEqual([
			{ text: "Hello!", textSignature: "text-sig", type: "text" },
			{ redacted: false, thinking: "Reasoning", thinkingSignature: "thought-sig", type: "thinking" },
			{
				arguments: { query: "weather" },
				id: "call-1",
				name: "lookup",
				thoughtSignature: "opaque",
				type: "toolCall",
			},
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.stopReasonRaw).toBe("tool_calls");
		expect(message.errorMessage).toBeNull();
		expect(message.timestamp).toBe(2000);
	});

	it("fills only actual optional assistant fields with null", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "api",
			provider: "provider",
			model: "model",
			usage: validUsage(),
			stopReason: "stop",
			timestamp: 1,
		};
		const decoded = decodeModelReplyBytes(encodeOk(encodeModelReply(message)));
		expect(decoded.ok).toBe(true);
		if (!decoded.ok || !decoded.reply.ok) return;
		expect(decoded.reply.message.responseModel).toBeNull();
		expect(decoded.reply.message.responseId).toBeNull();
		expect(decoded.reply.message.diagnostics).toBeNull();
		expect(decoded.reply.message.stopReasonRaw).toBeNull();
		expect(decoded.reply.message.errorMessage).toBeNull();
	});

	it("requires api, provider, model, exact usage, and exact stop reason", () => {
		const base = validAssistantMessage();
		const missingApi = { ...base };
		Reflect.deleteProperty(missingApi, "api");
		encodeFails(encodeModelReply(missingApi), "FRAME_ERROR");
		encodeFails(encodeModelReply({ ...base, provider: null }), "FRAME_ERROR");
		encodeFails(encodeModelReply({ ...base, usage: { input: 1 } }), "FRAME_ERROR");
		encodeFails(encodeModelReply({ ...base, stopReason: "other" }), "FRAME_ERROR");
		encodeFails(encodeModelReply({ ...base, extra: true }), "FRAME_ERROR");
	});

	it("removes dynamic diagnostic and error text from successful replies", () => {
		const message = validAssistantMessage();
		Object.defineProperty(message, "diagnostics", {
			value: [
				{
					type: "provider_transport_failure",
					timestamp: 1,
					error: {
						name: "Error",
						message: "SECRET_MESSAGE https://provider.invalid/token",
						stack: "SECRET_STACK /Users/private/key.txt",
						code: "SECRET_CODE",
					},
					details: { path: "/Users/private", url: "https://provider.invalid/secret" },
				},
			],
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(message, "errorMessage", {
			value: "SECRET_ERROR_MESSAGE",
			enumerable: true,
			configurable: true,
		});
		const encoded = encodeOk(encodeModelReply(message));
		const wire = new TextDecoder().decode(encoded);
		expect(wire).not.toContain("SECRET");
		expect(wire).not.toContain("/Users/private");
		expect(wire).not.toContain("provider.invalid");
		const decoded = decodeModelReplyBytes(encoded);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok || !decoded.reply.ok) return;
		expect(decoded.reply.message.diagnostics).toBeNull();
		expect(decoded.reply.message.errorMessage).toBeNull();

		const injected = wire.replace(
			'"diagnostics":null',
			'"diagnostics":[{"details":{"path":"/Users/private"},"error":{"code":"SECRET_CODE","message":"SECRET_MESSAGE","name":"Error","stack":"SECRET_STACK"},"timestamp":1,"type":"failure"}]',
		);
		replyFails(decodeModelReplyBytes(bytes(injected)), "PROTOCOL_ERROR");
	});

	it("maps provider errors to INTERNAL_ERROR and rejects aborted serialization", () => {
		const failed = validAssistantMessage();
		Object.defineProperty(failed, "stopReason", { value: "error", enumerable: true, configurable: true });
		Object.defineProperty(failed, "errorMessage", {
			value: "SECRET_PROVIDER_FAILURE",
			enumerable: true,
			configurable: true,
		});
		const encoded = encodeOk(encodeModelReply(failed));
		expect(new TextDecoder().decode(encoded)).toBe('{"code":"INTERNAL_ERROR","ok":false}');
		expect(decodeModelReplyBytes(encoded)).toEqual({ ok: true, reply: { ok: false, code: "INTERNAL_ERROR" } });

		const aborted = validAssistantMessage();
		Object.defineProperty(aborted, "stopReason", { value: "aborted", enumerable: true, configurable: true });
		encodeFails(encodeModelReply(aborted), "FRAME_ERROR");

		const successful = new TextDecoder().decode(encodeOk(encodeModelReply(validAssistantMessage())));
		replyFails(
			decodeModelReplyBytes(bytes(successful.replace('"stopReason":"toolUse"', '"stopReason":"error"'))),
			"PROTOCOL_ERROR",
		);
		replyFails(
			decodeModelReplyBytes(bytes(successful.replace('"stopReason":"toolUse"', '"stopReason":"aborted"'))),
			"PROTOCOL_ERROR",
		);
	});

	it("accepts only the fixed semantic failure input and returns fresh bytes", () => {
		const first = encodeOk(encodeModelReply({ ok: false, code: "INTERNAL_ERROR" }));
		const second = encodeOk(encodeModelReply({ ok: false, code: "INTERNAL_ERROR" }));
		expect(first).not.toBe(second);
		expect(new TextDecoder().decode(first)).toBe('{"code":"INTERNAL_ERROR","ok":false}');
		const decoded = decodeModelReplyBytes(first);
		expect(decoded).toEqual({ ok: true, reply: { ok: false, code: "INTERNAL_ERROR" } });
		encodeFails(encodeModelReply({ ok: false, code: "INTERNAL_ERROR", details: "no" }), "FRAME_ERROR");
		encodeFails(encodeModelReply({ ok: false, code: "OTHER" }), "FRAME_ERROR");
	});

	it("rejects extra keys in both reply branches", () => {
		replyFails(decodeModelReplyBytes(bytes('{"code":"INTERNAL_ERROR","extra":0,"ok":false}')), "PROTOCOL_ERROR");
		const encoded = encodeOk(encodeModelReply(validAssistantMessage()));
		const text = new TextDecoder().decode(encoded);
		const changed = `${text.slice(0, -1)},"extra":0}`;
		replyFails(decodeModelReplyBytes(bytes(changed)), "PROTOCOL_ERROR");
	});
});

describe("hostile values", () => {
	it("rejects proxies and revoked proxies", () => {
		const proxy = new Proxy(validContext(), {});
		encodeFails(encodeModelRequest(proxy, validOptions()), "INPUT_INVALID");
		const pair = Proxy.revocable(validContext(), {});
		pair.revoke();
		encodeFails(encodeModelRequest(pair.proxy, validOptions()), "INPUT_INVALID");
	});

	it("uses prototypes captured before global constructor rebinding", () => {
		const defineProperty = Object.defineProperty;
		const setPrototypeOf = Object.setPrototypeOf;
		const originalObject = globalThis.Object;
		const originalArray = globalThis.Array;
		function ReplacementObject(): void {}
		function ReplacementArray(): void {}
		const fakeContext = setPrototypeOf({ messages: [] }, ReplacementObject.prototype);
		const fakeMessages: object[] = [];
		setPrototypeOf(fakeMessages, ReplacementArray.prototype);
		let fakeObjectRejected = false;
		let fakeArrayRejected = false;
		try {
			defineProperty(globalThis, "Object", { value: ReplacementObject, writable: true, configurable: true });
			defineProperty(globalThis, "Array", { value: ReplacementArray, writable: true, configurable: true });
			fakeObjectRejected = !encodeModelRequest(fakeContext, validOptions()).ok;
			fakeArrayRejected = !encodeModelRequest({ messages: fakeMessages }, validOptions()).ok;
		} finally {
			defineProperty(globalThis, "Object", { value: originalObject, writable: true, configurable: true });
			defineProperty(globalThis, "Array", { value: originalArray, writable: true, configurable: true });
		}
		expect(fakeObjectRejected).toBe(true);
		expect(fakeArrayRejected).toBe(true);
	});

	it("rejects accessors, symbol keys, sparse arrays, and repeated references", () => {
		const accessor = Object.defineProperty({}, "messages", { get: () => [], enumerable: true });
		encodeFails(encodeModelRequest(accessor, validOptions()), "INPUT_INVALID");
		const symbolContext = { messages: [] };
		Object.defineProperty(symbolContext, Symbol("hidden"), { value: true });
		encodeFails(encodeModelRequest(symbolContext, validOptions()), "INPUT_INVALID");
		const sparse = new Array(1);
		encodeFails(encodeModelRequest({ messages: sparse }, validOptions()), "INPUT_INVALID");
		const message = { role: "user", content: "same", timestamp: 1 };
		encodeFails(encodeModelRequest({ messages: [message, message] }, validOptions()), "INPUT_INVALID");
	});

	it("rejects and disposes an oversized encoded result", () => {
		const content = "x".repeat(65536);
		const context = {
			messages: [
				{ role: "user", content, timestamp: 1 },
				{ role: "user", content, timestamp: 2 },
				{ role: "user", content, timestamp: 3 },
				{ role: "user", content, timestamp: 4 },
				{ role: "user", content, timestamp: 5 },
			],
		};
		encodeFails(encodeModelRequest(context, validOptions()), "INPUT_TOO_LARGE");
	});

	it("rejects non-byte inputs and oversized input", () => {
		requestFails(decodeModelRequestBytes("text"), "INPUT_INVALID");
		requestFails(decodeModelRequestBytes(new Proxy(new Uint8Array(1), {})), "INPUT_INVALID");
		requestFails(decodeModelRequestBytes(new Uint8Array(262129)), "INPUT_TOO_LARGE");
	});
});
