import { types } from "node:util";
import { parseBoundedJson } from "./prime-sandbox-json.js";
import { SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES } from "./prime-sandbox-transport.js";
import { equalBytes, isExactUint8Array as exactBytes } from "./prime-sandbox-validation.js";

const ISSUE = Object.freeze({});
const REQUEST_TAG = 0x03;
const REPLY_TAG = 0x04;
const ACK_TAG = 0x06;
const MAX_REQUEST_ID = 0xffff_ffff_ffff_ffffn;
const METHOD = "rlm.infer";
const MAX_METHOD_BYTES = 1_024;
const MAX_PARAMS_BYTES = SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES - MAX_METHOD_BYTES - 11;

interface RequestState {
	readonly requestId: bigint;
	readonly model: string;
	readonly input: string;
}

export class SandboxInferenceRequest {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

Object.freeze(SandboxInferenceRequest.prototype);
Object.freeze(SandboxInferenceRequest);

const requests = new WeakMap<object, RequestState>();

export interface SandboxInferenceInput {
	readonly model: string;
	readonly input: string;
}

export type SandboxInferencePortResult =
	| Readonly<{ ok: true; text: string }>
	| Readonly<{ ok: false; code: "INFERENCE_FAILED" }>;

export type SandboxInferencePort = (
	request: Readonly<SandboxInferenceInput>,
	signal?: AbortSignal,
) => Promise<SandboxInferencePortResult>;

export type SandboxInferenceCodecResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" | "PROTOCOL_ERROR" }>;

function success<T>(value: T): Readonly<{ ok: true; value: T }> {
	return Object.freeze({ ok: true, value });
}

function failure(code: "INPUT_INVALID" | "PROTOCOL_ERROR"): Readonly<{
	ok: false;
	code: "INPUT_INVALID" | "PROTOCOL_ERROR";
}> {
	return Object.freeze({ ok: false, code });
}

function copyExactBytes(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	if (!exactBytes(value)) return undefined;
	try {
		const buffer = value.buffer;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype || Object.hasOwn(buffer, "resizable"))
			return undefined;
		const resizable = Reflect.get(buffer, "resizable");
		if (typeof resizable !== "boolean" || resizable) return undefined;
		const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
		copy.set(value);
		return copy;
	} catch {
		return undefined;
	}
}

function validUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function validModel(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit < 0x21 || unit > 0x7e) return false;
	}
	return true;
}

export function isSandboxInferenceModel(value: unknown): value is string {
	return validModel(value);
}

function paddedLength(unpadded: number): number | undefined {
	if (!Number.isSafeInteger(unpadded) || unpadded < 1) return undefined;
	const padded = Math.ceil(unpadded / 16) * 16;
	return padded <= SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES ? padded : undefined;
}

function exactDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			types.isProxy(value) ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Object.getOwnPropertySymbols(value).length !== 0
		) {
			return false;
		}
		const actual = Object.keys(value);
		if (actual.length !== keys.length) return false;
		for (let index = 0; index < keys.length; index += 1) {
			if (actual[index] !== keys[index]) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
			if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function decodeCanonicalJson(bytes: Uint8Array<ArrayBuffer>): unknown {
	const parsed = parseBoundedJson(bytes);
	if (!parsed.ok) return undefined;
	let canonical: Uint8Array<ArrayBuffer>;
	try {
		canonical = new TextEncoder().encode(JSON.stringify(parsed.value));
	} catch {
		return undefined;
	}
	const equal = equalBytes(bytes, canonical);
	canonical.fill(0);
	return equal ? parsed.value : undefined;
}

function zeroPadding(bytes: Uint8Array, offset: number): boolean {
	for (let index = offset; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0) return false;
	}
	return true;
}

export function encodeSandboxRequestDeliveryAck(
	requestId: bigint,
): SandboxInferenceCodecResult<Uint8Array<ArrayBuffer>> {
	if (typeof requestId !== "bigint" || requestId < 1n || requestId > MAX_REQUEST_ID) return failure("INPUT_INVALID");
	const plaintext = new Uint8Array(new ArrayBuffer(16));
	plaintext[0] = ACK_TAG;
	new DataView(plaintext.buffer).setBigUint64(1, requestId, false);
	plaintext[9] = 0;
	return success(plaintext);
}

export function decodeSandboxRequestDeliveryAck(value: unknown): SandboxInferenceCodecResult<bigint> {
	const bytes = copyExactBytes(value);
	if (bytes === undefined) return failure("INPUT_INVALID");
	try {
		if (bytes.byteLength !== 16 || bytes[0] !== ACK_TAG || bytes[9] !== 0 || !zeroPadding(bytes, 10)) {
			return failure("PROTOCOL_ERROR");
		}
		const requestId = new DataView(bytes.buffer).getBigUint64(1, false);
		return requestId < 1n ? failure("PROTOCOL_ERROR") : success(requestId);
	} finally {
		bytes.fill(0);
	}
}

export function encodeSandboxInferenceRequest(
	requestId: bigint,
	model: unknown,
	input: unknown,
): SandboxInferenceCodecResult<Uint8Array<ArrayBuffer>> {
	if (typeof requestId !== "bigint" || requestId < 1n || requestId > MAX_REQUEST_ID) return failure("INPUT_INVALID");
	if (!validModel(model) || typeof input !== "string" || !validUnicode(input)) return failure("INPUT_INVALID");
	const methodBytes = new TextEncoder().encode(METHOD);
	const paramsBytes = new TextEncoder().encode(JSON.stringify({ model, input }));
	if (methodBytes.byteLength > MAX_METHOD_BYTES || paramsBytes.byteLength > MAX_PARAMS_BYTES) {
		methodBytes.fill(0);
		paramsBytes.fill(0);
		return failure("INPUT_INVALID");
	}
	const unpadded = 1 + 8 + 2 + methodBytes.byteLength + 4 + paramsBytes.byteLength;
	const total = paddedLength(unpadded);
	if (total === undefined) {
		methodBytes.fill(0);
		paramsBytes.fill(0);
		return failure("INPUT_INVALID");
	}
	const plaintext = new Uint8Array(new ArrayBuffer(total));
	const view = new DataView(plaintext.buffer);
	plaintext[0] = REQUEST_TAG;
	view.setBigUint64(1, requestId, false);
	view.setUint16(9, methodBytes.byteLength, false);
	plaintext.set(methodBytes, 11);
	const paramsLengthOffset = 11 + methodBytes.byteLength;
	view.setUint32(paramsLengthOffset, paramsBytes.byteLength, false);
	plaintext.set(paramsBytes, paramsLengthOffset + 4);
	methodBytes.fill(0);
	paramsBytes.fill(0);
	return success(plaintext);
}

export function decodeSandboxInferenceRequest(value: unknown): SandboxInferenceCodecResult<SandboxInferenceRequest> {
	const bytes = copyExactBytes(value);
	if (bytes === undefined) return failure("INPUT_INVALID");
	try {
		if (bytes.byteLength < 32 || bytes.byteLength % 16 !== 0 || bytes[0] !== REQUEST_TAG) {
			return failure("PROTOCOL_ERROR");
		}
		const view = new DataView(bytes.buffer);
		const requestId = view.getBigUint64(1, false);
		const methodLength = view.getUint16(9, false);
		if (requestId < 1n || methodLength < 1 || methodLength > MAX_METHOD_BYTES) return failure("PROTOCOL_ERROR");
		const paramsLengthOffset = 11 + methodLength;
		if (paramsLengthOffset + 4 > bytes.byteLength) return failure("PROTOCOL_ERROR");
		const paramsLength = view.getUint32(paramsLengthOffset, false);
		if (paramsLength > MAX_PARAMS_BYTES) return failure("PROTOCOL_ERROR");
		const end = paramsLengthOffset + 4 + paramsLength;
		if (end > bytes.byteLength || paddedLength(end) !== bytes.byteLength || !zeroPadding(bytes, end)) {
			return failure("PROTOCOL_ERROR");
		}
		let method: string;
		try {
			method = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(11, paramsLengthOffset));
		} catch {
			return failure("PROTOCOL_ERROR");
		}
		if (method !== METHOD) return failure("PROTOCOL_ERROR");
		const paramsCopy = new Uint8Array(new ArrayBuffer(paramsLength));
		paramsCopy.set(bytes.subarray(paramsLengthOffset + 4, end));
		const params = decodeCanonicalJson(paramsCopy);
		paramsCopy.fill(0);
		if (!exactDataObject(params, ["model", "input"])) return failure("PROTOCOL_ERROR");
		const model = params.model;
		const input = params.input;
		if (!validModel(model) || typeof input !== "string" || !validUnicode(input)) return failure("PROTOCOL_ERROR");
		const request = new SandboxInferenceRequest(ISSUE);
		requests.set(request, Object.freeze({ requestId, model, input }));
		return success(request);
	} finally {
		bytes.fill(0);
	}
}

function encodeReply(
	requestId: bigint,
	status: 0 | 1 | 2,
	data: unknown,
): SandboxInferenceCodecResult<Uint8Array<ArrayBuffer>> {
	let dataBytes: Uint8Array<ArrayBuffer>;
	try {
		dataBytes = new TextEncoder().encode(JSON.stringify(data));
	} catch {
		return failure("INPUT_INVALID");
	}
	const unpadded = 1 + 8 + 1 + 4 + dataBytes.byteLength;
	const total = paddedLength(unpadded);
	if (total === undefined) {
		dataBytes.fill(0);
		return failure("INPUT_INVALID");
	}
	const plaintext = new Uint8Array(new ArrayBuffer(total));
	const view = new DataView(plaintext.buffer);
	plaintext[0] = REPLY_TAG;
	view.setBigUint64(1, requestId, false);
	plaintext[9] = status;
	view.setUint32(10, dataBytes.byteLength, false);
	plaintext.set(dataBytes, 14);
	dataBytes.fill(0);
	return success(plaintext);
}

export async function executeSandboxInferenceRequest(
	value: unknown,
	allowedModel: unknown,
	port: SandboxInferencePort,
	signal?: AbortSignal,
): Promise<SandboxInferenceCodecResult<Uint8Array<ArrayBuffer>>> {
	if (typeof value !== "object" || value === null || !validModel(allowedModel) || typeof port !== "function") {
		return failure("INPUT_INVALID");
	}
	const state = requests.get(value);
	if (state === undefined) return failure("INPUT_INVALID");
	requests.delete(value);
	if (state.model !== allowedModel) {
		return encodeReply(state.requestId, 1, { code: "MODEL_NOT_ALLOWED", message: "Model not allowed" });
	}
	let result: unknown;
	try {
		result = await port(Object.freeze({ model: state.model, input: state.input }), signal);
	} catch {
		return encodeReply(state.requestId, 1, { code: "INFERENCE_FAILED", message: "Inference failed" });
	}
	if (exactDataObject(result, ["ok", "text"])) {
		if (result.ok === true && typeof result.text === "string" && validUnicode(result.text)) {
			const reply = encodeReply(state.requestId, 0, { text: result.text });
			return reply.ok
				? reply
				: encodeReply(state.requestId, 1, { code: "INFERENCE_FAILED", message: "Inference failed" });
		}
		return encodeReply(state.requestId, 1, { code: "INFERENCE_FAILED", message: "Inference failed" });
	}
	if (!exactDataObject(result, ["ok", "code"])) {
		return encodeReply(state.requestId, 1, { code: "INFERENCE_FAILED", message: "Inference failed" });
	}
	return encodeReply(state.requestId, 1, { code: "INFERENCE_FAILED", message: "Inference failed" });
}

export type SandboxInferenceReply =
	| Readonly<{ ok: true; requestId: bigint; text: string }>
	| Readonly<{ ok: false; requestId: bigint; code: "INFERENCE_FAILED" | "NOT_FOUND" }>;

export function decodeSandboxInferenceReply(value: unknown): SandboxInferenceCodecResult<SandboxInferenceReply> {
	const bytes = copyExactBytes(value);
	if (bytes === undefined) return failure("INPUT_INVALID");
	try {
		if (bytes.byteLength < 16 || bytes.byteLength % 16 !== 0 || bytes[0] !== REPLY_TAG) {
			return failure("PROTOCOL_ERROR");
		}
		const view = new DataView(bytes.buffer);
		const requestId = view.getBigUint64(1, false);
		const status = bytes[9];
		const dataLength = view.getUint32(10, false);
		const end = 14 + dataLength;
		if (
			requestId < 1n ||
			status > 2 ||
			end > bytes.byteLength ||
			paddedLength(end) !== bytes.byteLength ||
			!zeroPadding(bytes, end)
		) {
			return failure("PROTOCOL_ERROR");
		}
		const dataCopy = new Uint8Array(new ArrayBuffer(dataLength));
		dataCopy.set(bytes.subarray(14, end));
		const data = decodeCanonicalJson(dataCopy);
		dataCopy.fill(0);
		if (status === 0) {
			if (!exactDataObject(data, ["text"]) || typeof data.text !== "string" || !validUnicode(data.text)) {
				return failure("PROTOCOL_ERROR");
			}
			return success(Object.freeze({ ok: true, requestId, text: data.text }));
		}
		if (
			!exactDataObject(data, ["code", "message"]) ||
			typeof data.code !== "string" ||
			typeof data.message !== "string"
		) {
			return failure("PROTOCOL_ERROR");
		}
		return success(
			Object.freeze({
				ok: false,
				requestId,
				code: status === 2 ? "NOT_FOUND" : "INFERENCE_FAILED",
			}),
		);
	} finally {
		bytes.fill(0);
	}
}

export function copySandboxInferenceRequestId(value: unknown): bigint | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return requests.get(value)?.requestId;
}

export function closeSandboxInferenceRequest(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	return requests.delete(value);
}
