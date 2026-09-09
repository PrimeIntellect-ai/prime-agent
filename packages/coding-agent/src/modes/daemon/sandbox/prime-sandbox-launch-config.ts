import { Buffer } from "node:buffer";
import { types } from "node:util";
import { parseBoundedJson } from "./prime-sandbox-json.js";
import { copyBytes, equalBytes, isExactUint8Array } from "./prime-sandbox-validation.js";

const MAX_LAUNCH_CONFIG_BYTES = 1024;
const ISSUE = Object.freeze({});
const REQUIRED_KEYS = Object.freeze(["protocol", "homePublicKey", "archiveSha256", "manifestSha256", "launcherSha256"]);
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

export type SandboxLaunchConfigError = "INPUT_INVALID" | "INPUT_TOO_LARGE" | "INVALID_CONFIG" | "NON_CANONICAL";

export type SandboxLaunchConfigBuildResult =
	| Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer> }>
	| Readonly<{ ok: false; code: SandboxLaunchConfigError }>;

export type SandboxLaunchConfigDecodeResult =
	| Readonly<{ ok: true; config: SandboxLaunchConfig }>
	| Readonly<{ ok: false; code: SandboxLaunchConfigError }>;

interface LaunchConfigData {
	readonly homePublicKey: Uint8Array<ArrayBuffer>;
	readonly archiveSha256: Uint8Array<ArrayBuffer>;
	readonly manifestSha256: Uint8Array<ArrayBuffer>;
	readonly launcherSha256: Uint8Array<ArrayBuffer>;
}

const launchConfigs = new WeakMap<object, LaunchConfigData>();

export class SandboxLaunchConfig {
	constructor(token: unknown) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}
Object.freeze(SandboxLaunchConfig.prototype);
Object.freeze(SandboxLaunchConfig);

function failure(code: SandboxLaunchConfigError): Readonly<{ ok: false; code: SandboxLaunchConfigError }> {
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

function copyInput(
	value: unknown,
): Readonly<{ ok: true; bytes: Uint8Array<ArrayBuffer> }> | Readonly<{ ok: false; tooLarge: boolean }> {
	try {
		let length: number;
		let source: Uint8Array;
		if (isExactUint8Array(value)) {
			const buffer = value.buffer;
			if (!isExactArrayBuffer(buffer) || Reflect.get(buffer, "resizable") === true) {
				return Object.freeze({ ok: false, tooLarge: false });
			}
			length = value.byteLength;
			if (!Number.isSafeInteger(value.byteOffset) || value.byteOffset < 0) {
				return Object.freeze({ ok: false, tooLarge: false });
			}
			source = new Uint8Array(buffer, value.byteOffset, length);
		} else if (isExactArrayBuffer(value)) {
			if (Reflect.get(value, "resizable") === true) return Object.freeze({ ok: false, tooLarge: false });
			length = value.byteLength;
			source = new Uint8Array(value);
		} else {
			return Object.freeze({ ok: false, tooLarge: false });
		}
		if (!Number.isSafeInteger(length) || length < 1) return Object.freeze({ ok: false, tooLarge: false });
		if (length > MAX_LAUNCH_CONFIG_BYTES) return Object.freeze({ ok: false, tooLarge: true });
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

function ownString(value: object, key: string): string | undefined {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
		return typeof descriptor.value === "string" ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function canonicalBase64(value: string, bytes: number): boolean {
	if (bytes !== 32 || !BASE64_32.test(value)) return false;
	try {
		const decoded = Buffer.from(value, "base64");
		return decoded.byteLength === bytes && decoded.toString("base64") === value;
	} catch {
		return false;
	}
}

function encodeConfig(
	homePublicKey: string,
	archiveSha256: string,
	manifestSha256: string,
	launcherSha256: string,
): Uint8Array<ArrayBuffer> {
	return copyBytes(
		new TextEncoder().encode(
			`{"protocol":"prime-sandbox-v3","homePublicKey":"${homePublicKey}","archiveSha256":"${archiveSha256}","manifestSha256":"${manifestSha256}","launcherSha256":"${launcherSha256}"}`,
		),
	);
}

function readFields(value: object):
	| Readonly<{
			homePublicKey: string;
			archiveSha256: string;
			manifestSha256: string;
			launcherSha256: string;
	  }>
	| undefined {
	if (ownString(value, "protocol") !== "prime-sandbox-v3") return undefined;
	const homePublicKey = ownString(value, "homePublicKey");
	const archiveSha256 = ownString(value, "archiveSha256");
	const manifestSha256 = ownString(value, "manifestSha256");
	const launcherSha256 = ownString(value, "launcherSha256");
	if (
		homePublicKey === undefined ||
		archiveSha256 === undefined ||
		manifestSha256 === undefined ||
		launcherSha256 === undefined ||
		!canonicalBase64(homePublicKey, 32) ||
		!HEX_SHA256.test(archiveSha256) ||
		!HEX_SHA256.test(manifestSha256) ||
		!HEX_SHA256.test(launcherSha256)
	) {
		return undefined;
	}
	return Object.freeze({ homePublicKey, archiveSha256, manifestSha256, launcherSha256 });
}

export function buildSandboxLaunchConfig(value: unknown): SandboxLaunchConfigBuildResult {
	if (!exactPlainDataObject(value, REQUIRED_KEYS)) return failure("INPUT_INVALID");
	const fields = readFields(value);
	if (fields === undefined) return failure("INVALID_CONFIG");
	const bytes = encodeConfig(fields.homePublicKey, fields.archiveSha256, fields.manifestSha256, fields.launcherSha256);
	return Object.freeze({ ok: true, bytes });
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
	return copyBytes(new Uint8Array(Buffer.from(value, "base64")));
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
	return copyBytes(new Uint8Array(Buffer.from(value, "hex")));
}

export function decodeSandboxLaunchConfig(value: unknown): SandboxLaunchConfigDecodeResult {
	const copied = copyInput(value);
	if (!copied.ok) return failure(copied.tooLarge ? "INPUT_TOO_LARGE" : "INPUT_INVALID");
	const parsed = parseBoundedJson(copied.bytes);
	if (!parsed.ok || !exactPlainDataObject(parsed.value, REQUIRED_KEYS)) return failure("INVALID_CONFIG");
	const orderedKeys = Object.keys(parsed.value);
	for (let index = 0; index < REQUIRED_KEYS.length; index += 1) {
		if (orderedKeys[index] !== REQUIRED_KEYS[index]) return failure("NON_CANONICAL");
	}
	const fields = readFields(parsed.value);
	if (fields === undefined) return failure("INVALID_CONFIG");
	const canonical = encodeConfig(
		fields.homePublicKey,
		fields.archiveSha256,
		fields.manifestSha256,
		fields.launcherSha256,
	);
	if (!equalBytes(copied.bytes, canonical)) return failure("NON_CANONICAL");
	const config = new SandboxLaunchConfig(ISSUE);
	launchConfigs.set(
		config,
		Object.freeze({
			homePublicKey: decodeBase64(fields.homePublicKey),
			archiveSha256: decodeHex(fields.archiveSha256),
			manifestSha256: decodeHex(fields.manifestSha256),
			launcherSha256: decodeHex(fields.launcherSha256),
		}),
	);
	return Object.freeze({ ok: true, config });
}

function copyConfigField(value: unknown, field: keyof LaunchConfigData): Uint8Array<ArrayBuffer> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = launchConfigs.get(value);
	return data === undefined ? undefined : copyBytes(data[field]);
}

export function copyLaunchConfigHomePublicKey(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyConfigField(value, "homePublicKey");
}

export function copyLaunchConfigArchiveSha256(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyConfigField(value, "archiveSha256");
}

export function copyLaunchConfigManifestSha256(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyConfigField(value, "manifestSha256");
}

export function copyLaunchConfigLauncherSha256(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	return copyConfigField(value, "launcherSha256");
}

export function closeSandboxLaunchConfig(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const data = launchConfigs.get(value);
	if (data === undefined) return false;
	launchConfigs.delete(value);
	data.homePublicKey.fill(0);
	data.archiveSha256.fill(0);
	data.manifestSha256.fill(0);
	data.launcherSha256.fill(0);
	return true;
}
