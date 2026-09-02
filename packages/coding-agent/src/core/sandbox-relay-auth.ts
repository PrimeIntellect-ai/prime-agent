import { createHash, timingSafeEqual } from "node:crypto";
import { types } from "node:util";

export type UpgradeAuthFailureCode =
	| "ALREADY_USED"
	| "BAD_CONNECTION"
	| "BAD_METHOD"
	| "BAD_UPGRADE"
	| "BAD_URL"
	| "FORBIDDEN_HEADER"
	| "GRANT_MISMATCH"
	| "MALFORMED"
	| "SCRUB_FAILED";

export type UpgradeAuthResult =
	| Readonly<{ ok: true; code: "AUTHENTICATED" }>
	| Readonly<{ ok: false; code: UpgradeAuthFailureCode }>;
export type AuthErrorCode = UpgradeAuthFailureCode | "AUTHENTICATED";
export type AuthenticateResult = UpgradeAuthResult;
export interface AuthenticateRequest {
	readonly method: string;
	readonly url: string;
	readonly rawHeaders: string[];
	readonly headers: Record<string, string | string[] | undefined>;
}
export type UpgradeAuthStatus = Readonly<{
	status: "PENDING" | "AUTHENTICATED" | "REJECTED" | "DISPOSED";
	used: boolean;
}>;
export interface WebSocketUpgradeRequestAuthenticator {
	readonly authenticate: (request: unknown) => UpgradeAuthResult;
	readonly dispose: () => void;
	readonly status: UpgradeAuthStatus;
}
export type RequestAuthenticator = WebSocketUpgradeRequestAuthenticator;
export type CreateWebSocketUpgradeRequestAuthResult =
	| Readonly<{ ok: true; authenticator: WebSocketUpgradeRequestAuthenticator }>
	| Readonly<{ ok: false; error: Readonly<{ code: "REJECTED" }> }>;
export type CreateAuthResult = CreateWebSocketUpgradeRequestAuthResult;

const GRANT_HEADER = "x-prime-grant";
const PATH_RE = /^\/sandbox-relay\/[0-9a-f]{32}$/;
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_HEADER_PAIRS = 256;
const MAX_HEADER_CHARS = 65_536;
const MIN_GRANT_BYTES = 32;
const MAX_GRANT_BYTES = 128;
const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "forwarded", "origin", "proxy-authorization"]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

interface RawSnapshot {
	readonly ref: unknown[];
	readonly values: readonly string[] | null;
	readonly grantPairs: readonly number[];
	readonly structurallyValid: boolean;
}
interface HeaderSnapshotEntry {
	readonly key: string;
	readonly value: string;
}
interface HeaderSnapshot {
	readonly ref: object;
	readonly values: readonly HeaderSnapshotEntry[] | null;
	readonly grantKeys: readonly string[];
	readonly structurallyValid: boolean;
}

function failure(code: UpgradeAuthFailureCode): UpgradeAuthResult {
	return Object.freeze({ ok: false as const, code });
}
function rejectedFactory(): CreateWebSocketUpgradeRequestAuthResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code: "REJECTED" as const }) });
}
function status(value: "PENDING" | "AUTHENTICATED" | "REJECTED" | "DISPOSED", used: boolean): UpgradeAuthStatus {
	return Object.freeze({ status: value, used });
}
function eraseUint8View(value: unknown): void {
	try {
		Uint8Array.prototype.fill.call(value, 0);
	} catch {
		// A proxy, detached view, or non-Uint8Array is not safely writable here.
	}
}
function exactGrant(value: unknown): Uint8Array | null {
	try {
		if (typeof value !== "object" || value === null || types.isProxy(value)) return null;
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) return null;
		if (
			Object.hasOwn(value, "buffer") ||
			Object.hasOwn(value, "byteOffset") ||
			Object.hasOwn(value, "byteLength") ||
			Object.hasOwn(value, "length")
		)
			return null;
		if (!bufferGetter || !byteOffsetGetter || !byteLengthGetter) return null;
		const backing = bufferGetter.call(value) as unknown;
		const offset = byteOffsetGetter.call(value) as unknown;
		const length = byteLengthGetter.call(value) as unknown;
		if (typeof backing !== "object" || backing === null) return null;
		if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype) return null;
		if (typeof offset !== "number" || offset !== 0 || typeof length !== "number") return null;
		if (length !== (backing as ArrayBuffer).byteLength) return null;
		ArrayBuffer.prototype.slice.call(backing, 0, 0);
		if (length < MIN_GRANT_BYTES || length > MAX_GRANT_BYTES) return null;
		const bytes = value as Uint8Array;
		for (let index = 0; index < length; index += 1) {
			const byte = bytes[index];
			if (byte < 0x21 || byte > 0x7e) return null;
		}
		return bytes;
	} catch {
		return null;
	}
}
function visibleAscii(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}
function ownDataDescriptors(value: unknown): {
	readonly names: readonly string[];
	readonly symbols: readonly symbol[];
	readonly descriptors: Readonly<Record<string, PropertyDescriptor>>;
	readonly prototype: object | null;
} | null {
	if (typeof value !== "object" || value === null) return null;
	try {
		if (types.isProxy(value)) return null;
		return {
			names: Object.getOwnPropertyNames(value),
			symbols: Object.getOwnPropertySymbols(value),
			descriptors: Object.getOwnPropertyDescriptors(value),
			prototype: Object.getPrototypeOf(value),
		};
	} catch {
		return null;
	}
}

function inspectRawHeaders(value: unknown): RawSnapshot | null {
	if (!Array.isArray(value)) return null;
	const inspected = ownDataDescriptors(value);
	if (!inspected) return null;
	const ref = value as unknown[];
	const lengthDescriptor = inspected.descriptors.length;
	const length = lengthDescriptor?.value;
	const grantPairs: number[] = [];
	for (const propertyName of inspected.names) {
		if (propertyName === "length" || !/^(?:0|[1-9]\d*)$/.test(propertyName)) continue;
		const index = Number(propertyName);
		if (!Number.isSafeInteger(index) || index < 0 || index % 2 !== 0) continue;
		const nameDescriptor = inspected.descriptors[propertyName];
		const valueDescriptor = inspected.descriptors[String(index + 1)];
		if (
			nameDescriptor &&
			"value" in nameDescriptor &&
			typeof nameDescriptor.value === "string" &&
			nameDescriptor.value.toLowerCase() === GRANT_HEADER &&
			valueDescriptor &&
			"value" in valueDescriptor
		)
			grantPairs.push(index);
	}
	let structurallyValid =
		inspected.prototype === Array.prototype &&
		inspected.symbols.length === 0 &&
		typeof length === "number" &&
		Number.isSafeInteger(length) &&
		length >= 0 &&
		length <= MAX_HEADER_PAIRS * 2 &&
		length % 2 === 0 &&
		inspected.names.length === length + 1;
	const values: string[] = [];
	let chars = 0;
	if (structurallyValid) {
		for (let index = 0; index < length; index += 1) {
			const descriptor = inspected.descriptors[String(index)];
			if (
				!descriptor ||
				!("value" in descriptor) ||
				!descriptor.enumerable ||
				typeof descriptor.value !== "string"
			) {
				structurallyValid = false;
				break;
			}
			chars += descriptor.value.length;
			if (chars > MAX_HEADER_CHARS) {
				structurallyValid = false;
				break;
			}
			values.push(descriptor.value);
		}
	}
	return Object.freeze({
		ref,
		values: structurallyValid ? Object.freeze(values) : null,
		grantPairs: Object.freeze(grantPairs),
		structurallyValid,
	});
}

function inspectHeaders(value: unknown): HeaderSnapshot | null {
	const inspected = ownDataDescriptors(value);
	if (!inspected) return null;
	const grantKeys = inspected.names.filter((key) => key.toLowerCase() === GRANT_HEADER);
	let structurallyValid =
		(inspected.prototype === Object.prototype || inspected.prototype === null) &&
		inspected.symbols.length === 0 &&
		inspected.names.length <= MAX_HEADER_PAIRS;
	const values: HeaderSnapshotEntry[] = [];
	let chars = 0;
	if (structurallyValid) {
		for (const key of inspected.names) {
			const descriptor = inspected.descriptors[key];
			if (
				!descriptor ||
				!("value" in descriptor) ||
				!descriptor.enumerable ||
				typeof descriptor.value !== "string"
			) {
				structurallyValid = false;
				break;
			}
			chars += key.length + descriptor.value.length;
			if (chars > MAX_HEADER_CHARS) {
				structurallyValid = false;
				break;
			}
			values.push(Object.freeze({ key, value: descriptor.value }));
		}
	}
	return Object.freeze({
		ref: value as object,
		values: structurallyValid ? Object.freeze(values) : null,
		grantKeys: Object.freeze(grantKeys),
		structurallyValid,
	});
}

function replaceOwnWithEmpty(target: object, key: string): boolean {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (!descriptor || !("value" in descriptor)) return false;
		if (!descriptor.writable && !descriptor.configurable) return false;
		if (!Reflect.defineProperty(target, key, { ...descriptor, value: "" })) return false;
		return Object.getOwnPropertyDescriptor(target, key)?.value === "";
	} catch {
		return false;
	}
}
function scrubCredentials(raw: RawSnapshot | null, headers: HeaderSnapshot | null): boolean {
	let scrubbed = true;
	if (raw) {
		for (const index of raw.grantPairs) {
			if (!replaceOwnWithEmpty(raw.ref, String(index))) scrubbed = false;
			if (!replaceOwnWithEmpty(raw.ref, String(index + 1))) scrubbed = false;
		}
	}
	if (headers) {
		for (const key of headers.grantKeys) {
			try {
				if (!Reflect.deleteProperty(headers.ref, key) || Object.hasOwn(headers.ref, key)) scrubbed = false;
			} catch {
				scrubbed = false;
			}
		}
	}
	return scrubbed;
}

function validateHeaders(
	rawValues: readonly string[],
	headerValues: readonly HeaderSnapshotEntry[],
): UpgradeAuthFailureCode | null {
	const raw = new Map<string, string>();
	for (let index = 0; index < rawValues.length; index += 2) {
		const name = rawValues[index];
		const value = rawValues[index + 1];
		if (!TOKEN_RE.test(name) || !visibleAscii(value)) return "MALFORMED";
		const lowerName = name.toLowerCase();
		if (raw.has(lowerName)) return "MALFORMED";
		raw.set(lowerName, value);
	}
	const normalized = new Map<string, string>();
	for (const { key, value } of headerValues) {
		if (key !== key.toLowerCase() || !TOKEN_RE.test(key) || !visibleAscii(value)) return "MALFORMED";
		if (normalized.has(key)) return "MALFORMED";
		normalized.set(key, value);
	}
	if (raw.size !== normalized.size) return "MALFORMED";
	for (const [key, value] of raw) if (normalized.get(key) !== value) return "MALFORMED";
	for (const name of raw.keys()) {
		if (FORBIDDEN_HEADERS.has(name) || name.startsWith("x-forwarded-")) return "FORBIDDEN_HEADER";
	}
	const upgrade = raw.get("upgrade");
	if (upgrade === undefined || upgrade.trim().toLowerCase() !== "websocket") return "BAD_UPGRADE";
	const connection = raw.get("connection");
	if (connection === undefined) return "BAD_CONNECTION";
	const connectionTokens = connection.split(",").map((part) => part.trim().toLowerCase());
	if (connectionTokens.length === 0 || connectionTokens.some((part) => !TOKEN_RE.test(part))) return "BAD_CONNECTION";
	if (new Set(connectionTokens).size !== connectionTokens.length) return "BAD_CONNECTION";
	if (connectionTokens.filter((part) => part === "upgrade").length !== 1) return "BAD_CONNECTION";
	return null;
}

function compareGrant(expected: Uint8Array, candidate: string): boolean {
	const candidateBytes = new Uint8Array(candidate.length);
	let expectedDigest: Buffer | null = null;
	let candidateDigest: Buffer | null = null;
	try {
		for (let index = 0; index < candidate.length; index += 1) {
			const code = candidate.charCodeAt(index);
			if (code < 0x21 || code > 0x7e) return false;
			candidateBytes[index] = code;
		}
		expectedDigest = createHash("sha256").update(expected).digest();
		candidateDigest = createHash("sha256").update(candidateBytes).digest();
		return timingSafeEqual(expectedDigest, candidateDigest);
	} catch {
		return false;
	} finally {
		eraseUint8View(candidateBytes);
		eraseUint8View(expectedDigest);
		eraseUint8View(candidateDigest);
	}
}

export function createWebSocketUpgradeRequestAuth(input: unknown): CreateWebSocketUpgradeRequestAuthResult {
	let discoveredGrant: unknown;
	try {
		if (typeof input === "object" && input !== null && !types.isProxy(input)) {
			const descriptor = Object.getOwnPropertyDescriptor(input, "grant");
			if (descriptor && "value" in descriptor) discoveredGrant = descriptor.value;
		}
	} catch {
		return rejectedFactory();
	}
	let ownedGrant: Uint8Array | null = null;
	let transferred = false;
	try {
		const inspected = ownDataDescriptors(input);
		if (!inspected || inspected.prototype !== Object.prototype || inspected.symbols.length !== 0)
			return rejectedFactory();
		if (inspected.names.length !== 2 || !inspected.names.includes("grant") || !inspected.names.includes("path"))
			return rejectedFactory();
		const grantDescriptor = inspected.descriptors.grant;
		const pathDescriptor = inspected.descriptors.path;
		if (
			!grantDescriptor ||
			!("value" in grantDescriptor) ||
			!grantDescriptor.enumerable ||
			!pathDescriptor ||
			!("value" in pathDescriptor) ||
			!pathDescriptor.enumerable ||
			typeof pathDescriptor.value !== "string" ||
			!PATH_RE.test(pathDescriptor.value)
		)
			return rejectedFactory();
		const grant = exactGrant(grantDescriptor.value);
		if (!grant) return rejectedFactory();
		ownedGrant = new Uint8Array(grant.byteLength);
		ownedGrant.set(grant);
		const expectedPath = pathDescriptor.value;
		let state: "LIVE" | "USED" | "DISPOSED" = "LIVE";
		let terminalStatus: "PENDING" | "AUTHENTICATED" | "REJECTED" | "DISPOSED" = "PENDING";
		const consumeFailure = (code: UpgradeAuthFailureCode): UpgradeAuthResult => {
			state = "USED";
			terminalStatus = "REJECTED";
			eraseUint8View(ownedGrant);
			return failure(code);
		};
		const authenticator = Object.freeze({
			authenticate(request: unknown): UpgradeAuthResult {
				if (state !== "LIVE") return failure("ALREADY_USED");
				try {
					const requestInspection = ownDataDescriptors(request);
					const descriptors = requestInspection?.descriptors;
					const raw = inspectRawHeaders(descriptors?.rawHeaders?.value);
					const headers = inspectHeaders(descriptors?.headers?.value);
					const scrubbed = scrubCredentials(raw, headers);
					if (!scrubbed) return consumeFailure("SCRUB_FAILED");
					if (
						!requestInspection ||
						requestInspection.prototype !== Object.prototype ||
						requestInspection.symbols.length !== 0 ||
						requestInspection.names.length !== 4 ||
						!requestInspection.names.every((name) => ["headers", "method", "rawHeaders", "url"].includes(name))
					)
						return consumeFailure("MALFORMED");
					for (const name of requestInspection.names) {
						const descriptor = descriptors?.[name];
						if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
							return consumeFailure("MALFORMED");
					}
					if (!raw?.structurallyValid || !raw.values || !headers?.structurallyValid || !headers.values)
						return consumeFailure("MALFORMED");
					const method = descriptors?.method?.value;
					const url = descriptors?.url?.value;
					if (typeof method !== "string") return consumeFailure("MALFORMED");
					if (typeof url !== "string") return consumeFailure("MALFORMED");
					if (method !== "GET") return consumeFailure("BAD_METHOD");
					if (url !== expectedPath) return consumeFailure("BAD_URL");
					if (raw.grantPairs.length !== 1 || headers.grantKeys.length !== 1)
						return consumeFailure("GRANT_MISMATCH");
					const rawGrant = raw.values[raw.grantPairs[0] + 1];
					const headerGrant = headers.values.find(({ key }) => key === GRANT_HEADER)?.value;
					if (headerGrant === undefined || rawGrant !== headerGrant) return consumeFailure("GRANT_MISMATCH");
					const headerError = validateHeaders(raw.values, headers.values);
					if (headerError) return consumeFailure(headerError);
					if (rawGrant.length < MIN_GRANT_BYTES || rawGrant.length > MAX_GRANT_BYTES)
						return consumeFailure("GRANT_MISMATCH");
					if (!ownedGrant || !compareGrant(ownedGrant, rawGrant)) return consumeFailure("GRANT_MISMATCH");
					state = "USED";
					terminalStatus = "AUTHENTICATED";
					eraseUint8View(ownedGrant);
					return Object.freeze({ ok: true as const, code: "AUTHENTICATED" as const });
				} catch {
					return consumeFailure("MALFORMED");
				}
			},
			dispose(): void {
				if (state === "LIVE") {
					state = "DISPOSED";
					terminalStatus = "DISPOSED";
				}
				eraseUint8View(ownedGrant);
			},
			get status(): UpgradeAuthStatus {
				return status(terminalStatus, state !== "LIVE");
			},
		}) satisfies WebSocketUpgradeRequestAuthenticator;
		transferred = true;
		return Object.freeze({ ok: true as const, authenticator });
	} catch {
		return rejectedFactory();
	} finally {
		if (!transferred) eraseUint8View(ownedGrant);
		eraseUint8View(discoveredGrant);
	}
}
