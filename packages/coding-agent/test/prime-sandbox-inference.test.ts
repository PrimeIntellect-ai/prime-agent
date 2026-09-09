import { describe, expect, test } from "bun:test";
import {
	closeSandboxInferenceRequest,
	decodeSandboxInferenceReply,
	decodeSandboxInferenceRequest,
	decodeSandboxRequestDeliveryAck,
	encodeSandboxInferenceRequest,
	encodeSandboxRequestDeliveryAck,
	executeSandboxInferenceRequest,
	SandboxInferenceRequest,
} from "../src/modes/daemon/sandbox/prime-sandbox-inference.js";

function copy(value: Uint8Array): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(new ArrayBuffer(value.byteLength));
	result.set(value);
	return result;
}

describe("sandbox provider-neutral inference messages", () => {
	test("round-trips one exact padded request and success reply", async () => {
		const encoded = encodeSandboxInferenceRequest(1n, "prime-inference/test-model", "private prompt");
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) return;
		expect(encoded.value[0]).toBe(0x03);
		expect(encoded.value.byteLength % 16).toBe(0);
		const ack = encodeSandboxRequestDeliveryAck(1n);
		expect(ack.ok).toBe(true);
		if (ack.ok) expect(decodeSandboxRequestDeliveryAck(ack.value)).toEqual({ ok: true, value: 1n });
		const decoded = decodeSandboxInferenceRequest(encoded.value);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		let captured: Readonly<{ model: string; input: string }> = Object.freeze({ model: "", input: "" });
		const reply = await executeSandboxInferenceRequest(
			decoded.value,
			"prime-inference/test-model",
			async (request) => {
				captured = request;
				return Object.freeze({ ok: true, text: "private response" });
			},
		);
		expect(captured).toEqual({ model: "prime-inference/test-model", input: "private prompt" });
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		expect(reply.value[0]).toBe(0x04);
		expect(reply.value.byteLength % 16).toBe(0);
		const parsedReply = decodeSandboxInferenceReply(reply.value);
		expect(parsedReply).toEqual({ ok: true, value: { ok: true, requestId: 1n, text: "private response" } });
		expect(
			await executeSandboxInferenceRequest(decoded.value, "prime-inference/test-model", async () =>
				Object.freeze({ ok: true, text: "x" }),
			),
		).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
	});

	test("maps inference failures to one fixed encrypted-channel-safe error shape", async () => {
		for (const port of [
			async () => Object.freeze({ ok: false as const, code: "INFERENCE_FAILED" as const }),
			async () => {
				throw new Error("secret provider exception");
			},
		]) {
			const encoded = encodeSandboxInferenceRequest(7n, "model", "prompt");
			if (!encoded.ok) throw new Error("encode failed");
			const decoded = decodeSandboxInferenceRequest(encoded.value);
			if (!decoded.ok) throw new Error("decode failed");
			const reply = await executeSandboxInferenceRequest(decoded.value, "model", port);
			expect(reply.ok).toBe(true);
			if (!reply.ok) continue;
			expect(decodeSandboxInferenceReply(reply.value)).toEqual({
				ok: true,
				value: { ok: false, requestId: 7n, code: "INFERENCE_FAILED" },
			});
			expect(new TextDecoder().decode(reply.value)).not.toContain("secret provider exception");
		}
	});

	test("rejects a model outside the Home-bound session before provider dispatch", async () => {
		const encoded = encodeSandboxInferenceRequest(3n, "other-model", "prompt");
		if (!encoded.ok) throw new Error("encode failed");
		const decoded = decodeSandboxInferenceRequest(encoded.value);
		if (!decoded.ok) throw new Error("decode failed");
		let called = false;
		const reply = await executeSandboxInferenceRequest(decoded.value, "allowed-model", async () => {
			called = true;
			return Object.freeze({ ok: true, text: "response" });
		});
		expect(called).toBe(false);
		expect(reply.ok).toBe(true);
		if (reply.ok) {
			expect(decodeSandboxInferenceReply(reply.value)).toEqual({
				ok: true,
				value: { ok: false, requestId: 3n, code: "INFERENCE_FAILED" },
			});
		}
	});

	test("rejects noncanonical framing, JSON, padding, IDs, models, and Unicode", () => {
		expect(encodeSandboxInferenceRequest(0n, "model", "prompt")).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(encodeSandboxInferenceRequest(1n, "model with spaces", "prompt")).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(encodeSandboxInferenceRequest(1n, "model", "\ud800")).toEqual({ ok: false, code: "INPUT_INVALID" });
		const encoded = encodeSandboxInferenceRequest(1n, "model", "prompt");
		if (!encoded.ok) throw new Error("encode failed");
		const wrongType = copy(encoded.value);
		wrongType[0] = 0x04;
		expect(decodeSandboxInferenceRequest(wrongType)).toEqual({ ok: false, code: "PROTOCOL_ERROR" });
		const wrongPadding = copy(encoded.value);
		wrongPadding[wrongPadding.byteLength - 1] = 1;
		expect(decodeSandboxInferenceRequest(wrongPadding)).toEqual({ ok: false, code: "PROTOCOL_ERROR" });
		const noncanonical = copy(encoded.value);
		const methodLength = new DataView(noncanonical.buffer).getUint16(9, false);
		const paramsOffset = 11 + methodLength;
		const paramsLength = new DataView(noncanonical.buffer).getUint32(paramsOffset, false);
		const text = new TextDecoder().decode(noncanonical.subarray(paramsOffset + 4, paramsOffset + 4 + paramsLength));
		const changed = new TextEncoder().encode(text.replace("{", "{ "));
		new DataView(noncanonical.buffer).setUint32(paramsOffset, changed.byteLength, false);
		noncanonical.fill(0, paramsOffset + 4);
		noncanonical.set(changed, paramsOffset + 4);
		expect(decodeSandboxInferenceRequest(noncanonical)).toEqual({ ok: false, code: "PROTOCOL_ERROR" });
	});

	test("bounds large requests and maps oversized or hostile inference results", async () => {
		expect(encodeSandboxInferenceRequest(1n, "model", "x".repeat(300_000))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		for (const port of [
			async () => Object.freeze({ ok: true as const, text: "x".repeat(300_000) }),
			async () =>
				new Proxy(Object.freeze({ ok: true as const, text: "secret" }), {
					get() {
						throw new Error("trap");
					},
				}),
		]) {
			const encoded = encodeSandboxInferenceRequest(1n, "model", "prompt");
			if (!encoded.ok) throw new Error("encode failed");
			const decoded = decodeSandboxInferenceRequest(encoded.value);
			if (!decoded.ok) throw new Error("decode failed");
			const reply = await executeSandboxInferenceRequest(decoded.value, "model", port);
			expect(reply.ok).toBe(true);
			if (reply.ok) {
				expect(decodeSandboxInferenceReply(reply.value)).toEqual({
					ok: true,
					value: { ok: false, requestId: 1n, code: "INFERENCE_FAILED" },
				});
			}
		}
	});

	test("keeps request capabilities unforgeable and rejects hostile byte objects", () => {
		expect(() => new SandboxInferenceRequest({})).toThrow();
		expect(closeSandboxInferenceRequest(Object.freeze({}))).toBe(false);
		let trapped = false;
		const proxy = new Proxy(new Uint8Array(32), {
			get() {
				trapped = true;
				throw new Error("trap");
			},
		});
		expect(decodeSandboxInferenceRequest(proxy)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(trapped).toBe(false);
		const buffer: unknown = Reflect.construct(ArrayBuffer, [64, { maxByteLength: 128 }]);
		if (!(buffer instanceof ArrayBuffer)) throw new Error("setup failed");
		Object.defineProperty(buffer, "resizable", { configurable: true, value: false });
		expect(decodeSandboxInferenceRequest(new Uint8Array(buffer))).toEqual({ ok: false, code: "INPUT_INVALID" });
	});
});
