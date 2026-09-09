import { Buffer } from "node:buffer";
import { types } from "node:util";
import { copyBytes, isExactUint8Array } from "./prime-sandbox-validation.js";

const MAX_READINESS_BYTES = 512;
const ISSUE = Object.freeze({});
const FIELD_KEYS = Object.freeze([
	"launcherPublicKey",
	"homePublicKey",
	"archiveSha256",
	"manifestSha256",
	"launcherSha256",
	"protocolNonce",
	"signature",
]);
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_64 = /^[A-Za-z0-9+/]{86}==$/;

export type SandboxReadinessError = "INPUT_INVALID" | "INPUT_TOO_LARGE" | "INVALID_BUNDLE" | "NON_CANONICAL";

export type SandboxReadinessBuildResult =
	| Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer> }>
	| Readonly<{ ok: false; code: SandboxReadinessError }>;

export type SandboxReadinessDecodeResult =
	| Readonly<{ ok: true; readiness: SandboxReadinessBundle }>
	| Readonly<{ ok: false; code: SandboxReadinessError }>;

interface ReadinessData {
	readonly launcherPublicKey: Uint8Array<ArrayBuffer>;
	readonly homePublicKey: Uint8Array<ArrayBuffer>;
	readonly archiveSha256: Uint8Array<ArrayBuffer>;
	readonly manifestSha256: Uint8Array<ArrayBuffer>;
	readonly launcherSha256: Uint8Array<ArrayBuffer>;
	readonly protocolNonce: Uint8Array<ArrayBuffer>;
	readonly signature: Uint8Array<ArrayBuffer>;
}

const readinessBundles = new WeakMap<object, ReadinessData>();

export class SandboxReadinessBundle {
	constructor(token: unknown) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}
Object.freeze(SandboxReadinessBundle.prototype);
Object.freeze(SandboxReadinessBundle);

function failure(code: SandboxReadinessError): Readonly<{ ok: false; code: SandboxReadinessError }> {
	return Object.freeze({ ok: false, code });
}

function isExactArrayBuffer(value: unknown): value is ArrayBuffer {
	try {
		return (
			typeof value === "object" &&
			value !== null &&
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === ArrayBuffer.prototype &&
			!Object.hasOwn(value, "byteLength") &&
			!Object.hasOwn(value, "resizable") &&
			!Object.hasOwn(value, "maxByteLength")
		);
	} catch {
		return false;
	}
}

function hasResizableBacking(value: ArrayBuffer): boolean {
	try {
		return Reflect.get(value, "resizable") === true;
	} catch {
		return true;
	}
}

function copyExactBytes(
	value: unknown,
	maximum: number,
): Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer> }> | Readonly<{ ok: false; tooLarge: boolean }> {
	try {
		let length: number;
		let source: Uint8Array;
		if (isExactUint8Array(value)) {
			const buffer = value.buffer;
			if (!isExactArrayBuffer(buffer) || hasResizableBacking(buffer)) {
				return Object.freeze({ ok: false, tooLarge: false });
			}
			length = value.byteLength;
			if (!Number.isSafeInteger(value.byteOffset) || value.byteOffset < 0) {
				return Object.freeze({ ok: false, tooLarge: false });
			}
			source = new Uint8Array(buffer, value.byteOffset, length);
		} else if (isExactArrayBuffer(value)) {
			if (hasResizableBacking(value)) return Object.freeze({ ok: false, tooLarge: false });
			length = value.byteLength;
			source = new Uint8Array(value);
		} else {
			return Object.freeze({ ok: false, tooLarge: false });
		}
		if (!Number.isSafeInteger(length) || length < 0) return Object.freeze({ ok: false, tooLarge: false });
		if (length > maximum) return Object.freeze({ ok: false, tooLarge: true });
		return Object.freeze({ ok: true, bytes: copyBytes(source) });
	} catch {
		return Object.freeze({ ok: false, tooLarge: false });
	}
}

function exactPlainDataObject(value: unknown, keys: readonly string[]): value is object {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			types.isProxy(value) ||
			Object.getPrototypeOf(value) !== Object.prototype
		) {
			return false;
		}
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length !== keys.length) return false;
		const found = new Set<string>();
		for (const key of ownKeys) {
			if (typeof key !== "string" || !keys.includes(key) || found.has(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return false;
			found.add(key);
		}
		return found.size === keys.length;
	} catch {
		return false;
	}
}

function ownBytes(value: object, key: string, length: number): Uint8Array<ArrayBuffer> | undefined {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
		const copied = copyExactBytes(descriptor.value, length);
		return copied.ok && copied.bytes.byteLength === length ? copied.bytes : undefined;
	} catch {
		return undefined;
	}
}

function readFields(value: object): ReadinessData | undefined {
	const launcherPublicKey = ownBytes(value, "launcherPublicKey", 32);
	const homePublicKey = ownBytes(value, "homePublicKey", 32);
	const archiveSha256 = ownBytes(value, "archiveSha256", 32);
	const manifestSha256 = ownBytes(value, "manifestSha256", 32);
	const launcherSha256 = ownBytes(value, "launcherSha256", 32);
	const protocolNonce = ownBytes(value, "protocolNonce", 32);
	const signature = ownBytes(value, "signature", 64);
	if (
		launcherPublicKey === undefined ||
		homePublicKey === undefined ||
		archiveSha256 === undefined ||
		manifestSha256 === undefined ||
		launcherSha256 === undefined ||
		protocolNonce === undefined ||
		signature === undefined
	) {
		return undefined;
	}
	return Object.freeze({
		launcherPublicKey,
		homePublicKey,
		archiveSha256,
		manifestSha256,
		launcherSha256,
		protocolNonce,
		signature,
	});
}

function base64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

function encodeBundle(fields: ReadinessData): Uint8Array<ArrayBuffer> {
	const line = [
		"BUNDLE",
		"v3",
		base64(fields.launcherPublicKey),
		base64(fields.homePublicKey),
		base64(fields.archiveSha256),
		base64(fields.manifestSha256),
		base64(fields.launcherSha256),
		base64(fields.protocolNonce),
		base64(fields.signature),
	].join(" ");
	return copyBytes(
		new TextEncoder().encode(`${line}
`),
	);
}

export function buildSandboxReadinessBundle(value: unknown): SandboxReadinessBuildResult {
	if (!exactPlainDataObject(value, FIELD_KEYS)) return failure("INPUT_INVALID");
	const fields = readFields(value);
	if (fields === undefined) return failure("INPUT_INVALID");
	const bytes = encodeBundle(fields);
	if (bytes.byteLength > MAX_READINESS_BYTES) return failure("INPUT_TOO_LARGE");
	return Object.freeze({ ok: true, bytes });
}

function canonicalBase64(value: string, length: 32 | 64): Uint8Array<ArrayBuffer> | undefined {
	if (!(length === 32 ? BASE64_32 : BASE64_64).test(value)) return undefined;
	try {
		const decoded = Buffer.from(value, "base64");
		if (decoded.byteLength !== length || decoded.toString("base64") !== value) return undefined;
		return copyBytes(new Uint8Array(decoded));
	} catch {
		return undefined;
	}
}

export function decodeSandboxReadinessBundle(value: unknown): SandboxReadinessDecodeResult {
	const copied = copyExactBytes(value, MAX_READINESS_BYTES);
	if (!copied.ok) return failure(copied.tooLarge ? "INPUT_TOO_LARGE" : "INPUT_INVALID");
	const bytes = copied.bytes;
	if (bytes.byteLength < 2 || bytes[bytes.byteLength - 1] !== 0x0a) return failure("INVALID_BUNDLE");
	for (let index = 0; index < bytes.byteLength - 1; index += 1) {
		if (bytes[index] < 0x20 || bytes[index] > 0x7e) return failure("INVALID_BUNDLE");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return failure("INVALID_BUNDLE");
	}
	const parts = text.slice(0, -1).split(" ");
	if (parts.length !== 9 || parts[0] !== "BUNDLE" || parts[1] !== "v3") return failure("INVALID_BUNDLE");
	const launcherPublicKey = canonicalBase64(parts[2], 32);
	const homePublicKey = canonicalBase64(parts[3], 32);
	const archiveSha256 = canonicalBase64(parts[4], 32);
	const manifestSha256 = canonicalBase64(parts[5], 32);
	const launcherSha256 = canonicalBase64(parts[6], 32);
	const protocolNonce = canonicalBase64(parts[7], 32);
	const signature = canonicalBase64(parts[8], 64);
	if (
		launcherPublicKey === undefined ||
		homePublicKey === undefined ||
		archiveSha256 === undefined ||
		manifestSha256 === undefined ||
		launcherSha256 === undefined ||
		protocolNonce === undefined ||
		signature === undefined
	) {
		return failure("INVALID_BUNDLE");
	}
	const data = Object.freeze({
		launcherPublicKey,
		homePublicKey,
		archiveSha256,
		manifestSha256,
		launcherSha256,
		protocolNonce,
		signature,
	});
	const canonical = encodeBundle(data);
	if (canonical.byteLength !== bytes.byteLength) return failure("NON_CANONICAL");
	let difference = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) difference |= canonical[index] ^ bytes[index];
	if (difference !== 0) return failure("NON_CANONICAL");
	const readiness = new SandboxReadinessBundle(ISSUE);
	readinessBundles.set(readiness, data);
	return Object.freeze({ ok: true, readiness });
}

function copyField(value: unknown, field: keyof ReadinessData): Uint8Array<ArrayBuffer> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = readinessBundles.get(value);
	return data === undefined ? undefined : copyBytes(data[field]);
}

export function copyReadinessLauncherPublicKey(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyField(value, "launcherPublicKey");
}

export function copyReadinessHomePublicKey(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyField(value, "homePublicKey");
}

export function copyReadinessArchiveSha256(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyField(value, "archiveSha256");
}

export function copyReadinessManifestSha256(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyField(value, "manifestSha256");
}

export function copyReadinessLauncherSha256(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyField(value, "launcherSha256");
}

export function copyReadinessProtocolNonce(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyField(value, "protocolNonce");
}

export function copyReadinessSignature(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyField(value, "signature");
}

export function closeSandboxReadinessBundle(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const data = readinessBundles.get(value);
	if (data === undefined) return false;
	readinessBundles.delete(value);
	data.launcherPublicKey.fill(0);
	data.homePublicKey.fill(0);
	data.archiveSha256.fill(0);
	data.manifestSha256.fill(0);
	data.launcherSha256.fill(0);
	data.protocolNonce.fill(0);
	data.signature.fill(0);
	return true;
}
