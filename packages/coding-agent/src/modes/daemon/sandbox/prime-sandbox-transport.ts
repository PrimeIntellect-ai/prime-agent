import { webcrypto } from "node:crypto";
import { types } from "node:util";
import { copyBytes, equalBytes, isExactUint8Array } from "./prime-sandbox-validation.js";

const ISSUE = Object.freeze({});
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const HEADER_BYTES = 32;
const TAG_BYTES = 16;
const MAX_WIRE_BYTES = HEADER_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES;
const MAX_COUNTER = 0xffffffffffffffffn;
const MAX_STREAM = 0xffffffffffffffffn;
const HOME_DIRECTION = 1;
const RUNTIME_DIRECTION = 2;
const BUNDLE_DOMAIN = new TextEncoder().encode("prime-sandbox-v3:bundle");
const RUNTIME_CHALLENGE_DOMAIN = new TextEncoder().encode("prime-sandbox-v3:challenge-runtime");
const HOME_CHALLENGE_DOMAIN = new TextEncoder().encode("prime-sandbox-v3:challenge-home");
const SESSION_DOMAIN = new TextEncoder().encode("prime-sandbox-v3:session-id:");
const HOME_KEY_DOMAIN = new TextEncoder().encode("prime-sandbox-v3:key:home-to-runtime:");
const RUNTIME_KEY_DOMAIN = new TextEncoder().encode("prime-sandbox-v3:key:runtime-to-home:");
const TRANSCRIPT_DOMAIN = new TextEncoder().encode("prime-sandbox-v3:transcript");
const BUNDLE_KEYS = Object.freeze([
	"launcherPublicKey",
	"homePublicKey",
	"archiveSha256",
	"manifestSha256",
	"launcherSha256",
	"protocolNonce",
]);
const TRANSCRIPT_KEYS = Object.freeze([
	"protocolNonce",
	"challenge1",
	"signature1",
	"challenge2",
	"signature2",
	"homeX25519PublicKey",
	"runtimeX25519PublicKey",
	"archiveSha256",
]);

export type SandboxTransportError =
	| "INPUT_INVALID"
	| "CAPABILITY_INVALID"
	| "CRYPTO_FAILURE"
	| "PROTOCOL_ERROR"
	| "AUTHENTICATION_FAILED"
	| "COUNTER_EXHAUSTED";

export type SandboxTransportResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; code: SandboxTransportError }>;

export type SandboxTransportRole = "home" | "runtime";

interface Ed25519Data {
	readonly privateKey: webcrypto.CryptoKey;
	readonly publicKey: Uint8Array<ArrayBuffer>;
}

interface X25519Data {
	readonly privateKey: webcrypto.CryptoKey;
	readonly publicKey: Uint8Array<ArrayBuffer>;
}

interface TransportKeyData {
	readonly role: SandboxTransportRole;
	readonly homeToRuntime: webcrypto.CryptoKey;
	readonly runtimeToHome: webcrypto.CryptoKey;
	readonly sessionId: Uint8Array<ArrayBuffer>;
	readonly transcriptHash: Uint8Array<ArrayBuffer>;
}

interface ChannelData {
	readonly sendKey: webcrypto.CryptoKey;
	readonly receiveKey: webcrypto.CryptoKey;
	readonly sendDirection: number;
	readonly receiveDirection: number;
	readonly sessionId: Uint8Array<ArrayBuffer>;
	readonly transcriptHash: Uint8Array<ArrayBuffer>;
	sendCounter: bigint;
	receiveCounter: bigint;
	sendBusy: boolean;
	receiveBusy: boolean;
}

const ed25519Keys = new WeakMap<object, Ed25519Data>();
const x25519Keys = new WeakMap<object, X25519Data>();
const transportKeys = new WeakMap<object, TransportKeyData>();
const channels = new WeakMap<object, ChannelData>();

export class SandboxEd25519KeyPair {
	constructor(token: unknown) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

export class SandboxX25519KeyPair {
	constructor(token: unknown) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

export class SandboxTransportKeys {
	constructor(token: unknown) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

export class SandboxTransportChannel {
	constructor(token: unknown) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

for (const capabilityClass of [
	SandboxEd25519KeyPair,
	SandboxX25519KeyPair,
	SandboxTransportKeys,
	SandboxTransportChannel,
]) {
	Object.freeze(capabilityClass.prototype);
	Object.freeze(capabilityClass);
}

function failure(code: SandboxTransportError): Readonly<{ ok: false; code: SandboxTransportError }> {
	return Object.freeze({ ok: false, code });
}

function success<T>(value: T): Readonly<{ ok: true; value: T }> {
	return Object.freeze({ ok: true, value });
}

function zero(value: Uint8Array | undefined): void {
	if (value !== undefined) value.fill(0);
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

function resizable(value: ArrayBuffer): boolean {
	try {
		return Reflect.get(value, "resizable") === true;
	} catch {
		return true;
	}
}

function copyInput(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> | undefined {
	try {
		let source: Uint8Array;
		let length: number;
		if (isExactUint8Array(value)) {
			const buffer = value.buffer;
			if (!isExactArrayBuffer(buffer) || resizable(buffer)) return undefined;
			length = value.byteLength;
			if (!Number.isSafeInteger(value.byteOffset) || value.byteOffset < 0) return undefined;
			source = new Uint8Array(buffer, value.byteOffset, length);
		} else if (isExactArrayBuffer(value)) {
			if (resizable(value)) return undefined;
			length = value.byteLength;
			source = new Uint8Array(value);
		} else {
			return undefined;
		}
		if (!Number.isSafeInteger(length) || length < minimum || length > maximum) return undefined;
		return copyBytes(source);
	} catch {
		return undefined;
	}
}

function exactDataObject(value: unknown, keys: readonly string[]): value is object {
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
		const bytes = copyInput(descriptor.value, length, length);
		return bytes?.byteLength === length ? bytes : undefined;
	} catch {
		return undefined;
	}
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> | undefined {
	let length = 0;
	for (const part of parts) {
		if (!Number.isSafeInteger(part.byteLength) || length > 4096 - part.byteLength) return undefined;
		length += part.byteLength;
	}
	const output = new Uint8Array(new ArrayBuffer(length));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function getPrivateEd25519(value: unknown): Ed25519Data | undefined {
	return typeof value === "object" && value !== null ? ed25519Keys.get(value) : undefined;
}

function getPrivateX25519(value: unknown): X25519Data | undefined {
	return typeof value === "object" && value !== null ? x25519Keys.get(value) : undefined;
}

export async function generateSandboxEd25519KeyPair(): Promise<SandboxTransportResult<SandboxEd25519KeyPair>> {
	try {
		const generated = await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
		if (!("privateKey" in generated) || !("publicKey" in generated)) return failure("CRYPTO_FAILURE");
		const raw = await webcrypto.subtle.exportKey("raw", generated.publicKey);
		const publicKey = copyInput(raw, 32, 32);
		if (publicKey === undefined) return failure("CRYPTO_FAILURE");
		const key = new SandboxEd25519KeyPair(ISSUE);
		ed25519Keys.set(key, Object.freeze({ privateKey: generated.privateKey, publicKey }));
		return success(key);
	} catch {
		return failure("CRYPTO_FAILURE");
	}
}

export function copySandboxEd25519PublicKey(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	const data = getPrivateEd25519(value);
	return data === undefined ? undefined : copyBytes(data.publicKey);
}

export function closeSandboxEd25519KeyPair(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const data = ed25519Keys.get(value);
	if (data === undefined) return false;
	ed25519Keys.delete(value);
	zero(data.publicKey);
	return true;
}

interface BundleData {
	readonly launcherPublicKey: Uint8Array<ArrayBuffer>;
	readonly homePublicKey: Uint8Array<ArrayBuffer>;
	readonly archiveSha256: Uint8Array<ArrayBuffer>;
	readonly manifestSha256: Uint8Array<ArrayBuffer>;
	readonly launcherSha256: Uint8Array<ArrayBuffer>;
	readonly protocolNonce: Uint8Array<ArrayBuffer>;
}

function readBundle(value: unknown): BundleData | undefined {
	if (!exactDataObject(value, BUNDLE_KEYS)) return undefined;
	const launcherPublicKey = ownBytes(value, "launcherPublicKey", 32);
	const homePublicKey = ownBytes(value, "homePublicKey", 32);
	const archiveSha256 = ownBytes(value, "archiveSha256", 32);
	const manifestSha256 = ownBytes(value, "manifestSha256", 32);
	const launcherSha256 = ownBytes(value, "launcherSha256", 32);
	const protocolNonce = ownBytes(value, "protocolNonce", 32);
	if (
		launcherPublicKey === undefined ||
		homePublicKey === undefined ||
		archiveSha256 === undefined ||
		manifestSha256 === undefined ||
		launcherSha256 === undefined ||
		protocolNonce === undefined
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
	});
}

function bundleMessage(value: BundleData): Uint8Array<ArrayBuffer> | undefined {
	return concatenate([
		BUNDLE_DOMAIN,
		value.launcherPublicKey,
		value.homePublicKey,
		value.archiveSha256,
		value.manifestSha256,
		value.launcherSha256,
		value.protocolNonce,
	]);
}

function zeroBundle(value: BundleData | undefined): void {
	if (value === undefined) return;
	zero(value.launcherPublicKey);
	zero(value.homePublicKey);
	zero(value.archiveSha256);
	zero(value.manifestSha256);
	zero(value.launcherSha256);
	zero(value.protocolNonce);
}

export async function signSandboxReadinessBundle(
	key: unknown,
	value: unknown,
): Promise<SandboxTransportResult<Uint8Array<ArrayBuffer>>> {
	if (typeof key !== "object" || key === null) return failure("CAPABILITY_INVALID");
	const keyData = ed25519Keys.get(key);
	const fields = readBundle(value);
	if (keyData === undefined || fields === undefined || !equalBytes(keyData.publicKey, fields.launcherPublicKey)) {
		zeroBundle(fields);
		return failure(keyData === undefined ? "CAPABILITY_INVALID" : "INPUT_INVALID");
	}
	const message = bundleMessage(fields);
	zeroBundle(fields);
	if (message === undefined) return failure("INPUT_INVALID");
	try {
		const signed = await webcrypto.subtle.sign({ name: "Ed25519" }, keyData.privateKey, message);
		const signature = copyInput(signed, 64, 64);
		if (ed25519Keys.get(key) !== keyData) {
			zero(signature);
			return failure("CAPABILITY_INVALID");
		}
		return signature === undefined ? failure("CRYPTO_FAILURE") : success(signature);
	} catch {
		return failure("CRYPTO_FAILURE");
	} finally {
		zero(message);
	}
}

export async function verifySandboxReadinessBundle(
	value: unknown,
	signatureValue: unknown,
): Promise<SandboxTransportResult<boolean>> {
	const fields = readBundle(value);
	const signature = copyInput(signatureValue, 64, 64);
	if (fields === undefined || signature === undefined) {
		zeroBundle(fields);
		zero(signature);
		return failure("INPUT_INVALID");
	}
	const message = bundleMessage(fields);
	zeroBundle(fields);
	if (message === undefined) {
		zero(signature);
		return failure("INPUT_INVALID");
	}
	try {
		const publicKey = await webcrypto.subtle.importKey(
			"raw",
			copyBytes(message.subarray(BUNDLE_DOMAIN.byteLength, BUNDLE_DOMAIN.byteLength + 32)),
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return success(await webcrypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message));
	} catch {
		return failure("CRYPTO_FAILURE");
	} finally {
		zero(signature);
		zero(message);
	}
}

async function signChallenge(
	key: unknown,
	domain: Uint8Array,
	protocolNonceValue: unknown,
	challengeValue: unknown,
): Promise<SandboxTransportResult<Uint8Array<ArrayBuffer>>> {
	if (typeof key !== "object" || key === null) return failure("CAPABILITY_INVALID");
	const keyData = ed25519Keys.get(key);
	if (keyData === undefined) return failure("CAPABILITY_INVALID");
	const protocolNonce = copyInput(protocolNonceValue, 32, 32);
	const challenge = copyInput(challengeValue, 32, 32);
	if (protocolNonce === undefined || challenge === undefined) {
		zero(protocolNonce);
		zero(challenge);
		return failure("INPUT_INVALID");
	}
	const message = concatenate([domain, protocolNonce, challenge]);
	zero(protocolNonce);
	zero(challenge);
	if (message === undefined) return failure("INPUT_INVALID");
	try {
		const signed = await webcrypto.subtle.sign({ name: "Ed25519" }, keyData.privateKey, message);
		const signature = copyInput(signed, 64, 64);
		if (ed25519Keys.get(key) !== keyData) {
			zero(signature);
			return failure("CAPABILITY_INVALID");
		}
		return signature === undefined ? failure("CRYPTO_FAILURE") : success(signature);
	} catch {
		return failure("CRYPTO_FAILURE");
	} finally {
		zero(message);
	}
}

async function verifyChallenge(
	publicKeyValue: unknown,
	signatureValue: unknown,
	domain: Uint8Array,
	protocolNonceValue: unknown,
	challengeValue: unknown,
): Promise<SandboxTransportResult<boolean>> {
	const publicKeyBytes = copyInput(publicKeyValue, 32, 32);
	const signature = copyInput(signatureValue, 64, 64);
	const protocolNonce = copyInput(protocolNonceValue, 32, 32);
	const challenge = copyInput(challengeValue, 32, 32);
	if (
		publicKeyBytes === undefined ||
		signature === undefined ||
		protocolNonce === undefined ||
		challenge === undefined
	) {
		zero(publicKeyBytes);
		zero(signature);
		zero(protocolNonce);
		zero(challenge);
		return failure("INPUT_INVALID");
	}
	const message = concatenate([domain, protocolNonce, challenge]);
	zero(protocolNonce);
	zero(challenge);
	if (message === undefined) {
		zero(publicKeyBytes);
		zero(signature);
		return failure("INPUT_INVALID");
	}
	try {
		const publicKey = await webcrypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
		return success(await webcrypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message));
	} catch {
		return failure("CRYPTO_FAILURE");
	} finally {
		zero(publicKeyBytes);
		zero(signature);
		zero(message);
	}
}

export function signSandboxRuntimeChallenge(
	key: unknown,
	protocolNonce: unknown,
	challenge: unknown,
): Promise<SandboxTransportResult<Uint8Array<ArrayBuffer>>> {
	return signChallenge(key, RUNTIME_CHALLENGE_DOMAIN, protocolNonce, challenge);
}

export function signSandboxHomeChallenge(
	key: unknown,
	protocolNonce: unknown,
	challenge: unknown,
): Promise<SandboxTransportResult<Uint8Array<ArrayBuffer>>> {
	return signChallenge(key, HOME_CHALLENGE_DOMAIN, protocolNonce, challenge);
}

export function verifySandboxRuntimeChallenge(
	publicKey: unknown,
	signature: unknown,
	protocolNonce: unknown,
	challenge: unknown,
): Promise<SandboxTransportResult<boolean>> {
	return verifyChallenge(publicKey, signature, RUNTIME_CHALLENGE_DOMAIN, protocolNonce, challenge);
}

export function verifySandboxHomeChallenge(
	publicKey: unknown,
	signature: unknown,
	protocolNonce: unknown,
	challenge: unknown,
): Promise<SandboxTransportResult<boolean>> {
	return verifyChallenge(publicKey, signature, HOME_CHALLENGE_DOMAIN, protocolNonce, challenge);
}

export function randomSandboxHandshakeBytes(): SandboxTransportResult<Uint8Array<ArrayBuffer>> {
	try {
		const value = new Uint8Array(new ArrayBuffer(32));
		webcrypto.getRandomValues(value);
		return success(copyBytes(value));
	} catch {
		return failure("CRYPTO_FAILURE");
	}
}

export async function generateSandboxX25519KeyPair(): Promise<SandboxTransportResult<SandboxX25519KeyPair>> {
	try {
		const generated = await webcrypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
		if (!("privateKey" in generated) || !("publicKey" in generated)) return failure("CRYPTO_FAILURE");
		const raw = await webcrypto.subtle.exportKey("raw", generated.publicKey);
		const publicKey = copyInput(raw, 32, 32);
		if (publicKey === undefined) return failure("CRYPTO_FAILURE");
		const key = new SandboxX25519KeyPair(ISSUE);
		x25519Keys.set(key, Object.freeze({ privateKey: generated.privateKey, publicKey }));
		return success(key);
	} catch {
		return failure("CRYPTO_FAILURE");
	}
}

export function copySandboxX25519PublicKey(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	const data = getPrivateX25519(value);
	return data === undefined ? undefined : copyBytes(data.publicKey);
}

export function closeSandboxX25519KeyPair(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const data = x25519Keys.get(value);
	if (data === undefined) return false;
	x25519Keys.delete(value);
	zero(data.publicKey);
	return true;
}

interface TranscriptData {
	readonly protocolNonce: Uint8Array<ArrayBuffer>;
	readonly challenge1: Uint8Array<ArrayBuffer>;
	readonly signature1: Uint8Array<ArrayBuffer>;
	readonly challenge2: Uint8Array<ArrayBuffer>;
	readonly signature2: Uint8Array<ArrayBuffer>;
	readonly homeX25519PublicKey: Uint8Array<ArrayBuffer>;
	readonly runtimeX25519PublicKey: Uint8Array<ArrayBuffer>;
	readonly archiveSha256: Uint8Array<ArrayBuffer>;
}

function readTranscript(value: unknown): TranscriptData | undefined {
	if (!exactDataObject(value, TRANSCRIPT_KEYS)) return undefined;
	const protocolNonce = ownBytes(value, "protocolNonce", 32);
	const challenge1 = ownBytes(value, "challenge1", 32);
	const signature1 = ownBytes(value, "signature1", 64);
	const challenge2 = ownBytes(value, "challenge2", 32);
	const signature2 = ownBytes(value, "signature2", 64);
	const homeX25519PublicKey = ownBytes(value, "homeX25519PublicKey", 32);
	const runtimeX25519PublicKey = ownBytes(value, "runtimeX25519PublicKey", 32);
	const archiveSha256 = ownBytes(value, "archiveSha256", 32);
	if (
		protocolNonce === undefined ||
		challenge1 === undefined ||
		signature1 === undefined ||
		challenge2 === undefined ||
		signature2 === undefined ||
		homeX25519PublicKey === undefined ||
		runtimeX25519PublicKey === undefined ||
		archiveSha256 === undefined
	) {
		return undefined;
	}
	return Object.freeze({
		protocolNonce,
		challenge1,
		signature1,
		challenge2,
		signature2,
		homeX25519PublicKey,
		runtimeX25519PublicKey,
		archiveSha256,
	});
}

function zeroTranscript(value: TranscriptData | undefined): void {
	if (value === undefined) return;
	zero(value.protocolNonce);
	zero(value.challenge1);
	zero(value.signature1);
	zero(value.challenge2);
	zero(value.signature2);
	zero(value.homeX25519PublicKey);
	zero(value.runtimeX25519PublicKey);
	zero(value.archiveSha256);
}

/** Consumes the X25519 capability after its role and transcript binding validate. */
export async function deriveSandboxTransportKeys(
	keyValue: unknown,
	role: SandboxTransportRole,
	transcriptValue: unknown,
): Promise<SandboxTransportResult<SandboxTransportKeys>> {
	if (typeof keyValue !== "object" || keyValue === null) return failure("CAPABILITY_INVALID");
	const keyData = x25519Keys.get(keyValue);
	const transcript = readTranscript(transcriptValue);
	if (keyData === undefined || transcript === undefined || (role !== "home" && role !== "runtime")) {
		zeroTranscript(transcript);
		return failure(keyData === undefined ? "CAPABILITY_INVALID" : "INPUT_INVALID");
	}
	const localPublicKey = role === "home" ? transcript.homeX25519PublicKey : transcript.runtimeX25519PublicKey;
	const peerPublicKey = role === "home" ? transcript.runtimeX25519PublicKey : transcript.homeX25519PublicKey;
	if (!equalBytes(keyData.publicKey, localPublicKey)) {
		zeroTranscript(transcript);
		return failure("INPUT_INVALID");
	}
	x25519Keys.delete(keyValue);
	let sharedSecret: Uint8Array<ArrayBuffer> | undefined;
	let salt: Uint8Array<ArrayBuffer> | undefined;
	let sessionInfo: Uint8Array<ArrayBuffer> | undefined;
	let homeInfo: Uint8Array<ArrayBuffer> | undefined;
	let runtimeInfo: Uint8Array<ArrayBuffer> | undefined;
	let sessionFull: Uint8Array<ArrayBuffer> | undefined;
	let sessionId: Uint8Array<ArrayBuffer> | undefined;
	let transcriptMessage: Uint8Array<ArrayBuffer> | undefined;
	let transcriptHash: Uint8Array<ArrayBuffer> | undefined;
	try {
		const peerKey = await webcrypto.subtle.importKey("raw", peerPublicKey, { name: "X25519" }, false, []);
		const derived = await webcrypto.subtle.deriveBits({ name: "X25519", public: peerKey }, keyData.privateKey, 256);
		sharedSecret = copyInput(derived, 32, 32);
		if (sharedSecret === undefined || sharedSecret.every((byte) => byte === 0)) return failure("CRYPTO_FAILURE");
		const hkdfKey = await webcrypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits", "deriveKey"]);
		salt = concatenate([transcript.protocolNonce, transcript.challenge1, transcript.challenge2]);
		sessionInfo = concatenate([SESSION_DOMAIN, transcript.archiveSha256]);
		if (salt === undefined || sessionInfo === undefined) return failure("CRYPTO_FAILURE");
		const sessionBits = await webcrypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt, info: sessionInfo },
			hkdfKey,
			256,
		);
		sessionFull = copyInput(sessionBits, 32, 32);
		if (sessionFull === undefined) return failure("CRYPTO_FAILURE");
		sessionId = copyBytes(sessionFull.subarray(0, 8));
		homeInfo = concatenate([HOME_KEY_DOMAIN, transcript.archiveSha256]);
		runtimeInfo = concatenate([RUNTIME_KEY_DOMAIN, transcript.archiveSha256]);
		if (homeInfo === undefined || runtimeInfo === undefined) return failure("CRYPTO_FAILURE");
		const homeToRuntime = await webcrypto.subtle.deriveKey(
			{ name: "HKDF", hash: "SHA-256", salt: sessionId, info: homeInfo },
			hkdfKey,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		);
		const runtimeToHome = await webcrypto.subtle.deriveKey(
			{ name: "HKDF", hash: "SHA-256", salt: sessionId, info: runtimeInfo },
			hkdfKey,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		);
		transcriptMessage = concatenate([
			TRANSCRIPT_DOMAIN,
			transcript.protocolNonce,
			transcript.challenge1,
			transcript.signature1,
			transcript.challenge2,
			transcript.signature2,
			transcript.homeX25519PublicKey,
			transcript.runtimeX25519PublicKey,
			sessionId,
		]);
		if (transcriptMessage === undefined) return failure("CRYPTO_FAILURE");
		transcriptHash = copyInput(await webcrypto.subtle.digest("SHA-256", transcriptMessage), 32, 32);
		if (transcriptHash === undefined) return failure("CRYPTO_FAILURE");
		const keys = new SandboxTransportKeys(ISSUE);
		transportKeys.set(
			keys,
			Object.freeze({
				role,
				homeToRuntime,
				runtimeToHome,
				sessionId: copyBytes(sessionId),
				transcriptHash: copyBytes(transcriptHash),
			}),
		);
		return success(keys);
	} catch {
		return failure("CRYPTO_FAILURE");
	} finally {
		zero(keyData.publicKey);
		zero(sharedSecret);
		zero(salt);
		zero(sessionInfo);
		zero(homeInfo);
		zero(runtimeInfo);
		zero(sessionFull);
		zero(sessionId);
		zero(transcriptMessage);
		zero(transcriptHash);
		zeroTranscript(transcript);
	}
}

export function closeSandboxTransportKeys(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const data = transportKeys.get(value);
	if (data === undefined) return false;
	transportKeys.delete(value);
	zero(data.sessionId);
	zero(data.transcriptHash);
	return true;
}

export function createSandboxTransportChannel(
	keysValue: unknown,
	role: SandboxTransportRole,
): SandboxTransportResult<SandboxTransportChannel> {
	if (typeof keysValue !== "object" || keysValue === null) return failure("CAPABILITY_INVALID");
	const keys = transportKeys.get(keysValue);
	if (keys === undefined) return failure("CAPABILITY_INVALID");
	if ((role !== "home" && role !== "runtime") || keys.role !== role) return failure("INPUT_INVALID");
	transportKeys.delete(keysValue);
	const channel = new SandboxTransportChannel(ISSUE);
	channels.set(channel, {
		sendKey: role === "home" ? keys.homeToRuntime : keys.runtimeToHome,
		receiveKey: role === "home" ? keys.runtimeToHome : keys.homeToRuntime,
		sendDirection: role === "home" ? HOME_DIRECTION : RUNTIME_DIRECTION,
		receiveDirection: role === "home" ? RUNTIME_DIRECTION : HOME_DIRECTION,
		sessionId: keys.sessionId,
		transcriptHash: keys.transcriptHash,
		sendCounter: 1n,
		receiveCounter: 1n,
		sendBusy: false,
		receiveBusy: false,
	});
	return success(channel);
}

function closeChannelData(value: object): boolean {
	const data = channels.get(value);
	if (data === undefined) return false;
	channels.delete(value);
	zero(data.sessionId);
	zero(data.transcriptHash);
	return true;
}

export function closeSandboxTransportChannel(value: unknown): boolean {
	return typeof value === "object" && value !== null ? closeChannelData(value) : false;
}

export function copySandboxTransportSessionId(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = channels.get(value);
	return data === undefined ? undefined : copyBytes(data.sessionId);
}

function header(counter: bigint, streamId: bigint, plaintextBytes: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(new ArrayBuffer(HEADER_BYTES));
	const view = new DataView(bytes.buffer);
	view.setBigUint64(0, counter, false);
	view.setBigUint64(8, streamId, false);
	view.setUint32(16, plaintextBytes, false);
	return bytes;
}

function iv(direction: number, counter: bigint): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(new ArrayBuffer(12));
	const view = new DataView(bytes.buffer);
	view.setUint32(0, direction, false);
	view.setBigUint64(4, counter, false);
	return bytes;
}

export async function encryptSandboxTransportFrame(
	channelValue: unknown,
	streamId: bigint,
	plaintextValue: unknown,
): Promise<SandboxTransportResult<Uint8Array<ArrayBuffer>>> {
	if (typeof channelValue !== "object" || channelValue === null) return failure("CAPABILITY_INVALID");
	const data = channels.get(channelValue);
	if (data === undefined) return failure("CAPABILITY_INVALID");
	if (typeof streamId !== "bigint" || streamId < 0n || streamId > MAX_STREAM) return failure("INPUT_INVALID");
	const plaintext = copyInput(plaintextValue, 0, MAX_PLAINTEXT_BYTES);
	if (plaintext === undefined) return failure("INPUT_INVALID");
	if (data.sendBusy) {
		zero(plaintext);
		closeChannelData(channelValue);
		return failure("PROTOCOL_ERROR");
	}
	if (data.sendCounter >= MAX_COUNTER) {
		zero(plaintext);
		closeChannelData(channelValue);
		return failure("COUNTER_EXHAUSTED");
	}
	data.sendBusy = true;
	const counter = data.sendCounter;
	const frameHeader = header(counter, streamId, plaintext.byteLength);
	const nonce = iv(data.sendDirection, counter);
	const additionalData = concatenate([data.transcriptHash, frameHeader]);
	if (additionalData === undefined) {
		zero(plaintext);
		closeChannelData(channelValue);
		return failure("CRYPTO_FAILURE");
	}
	try {
		const encrypted = await webcrypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
			data.sendKey,
			plaintext,
		);
		if (channels.get(channelValue) !== data) return failure("CAPABILITY_INVALID");
		const ciphertext = copyInput(encrypted, plaintext.byteLength + TAG_BYTES, plaintext.byteLength + TAG_BYTES);
		if (ciphertext === undefined) {
			closeChannelData(channelValue);
			return failure("CRYPTO_FAILURE");
		}
		const wire = new Uint8Array(new ArrayBuffer(HEADER_BYTES + ciphertext.byteLength));
		wire.set(frameHeader, 0);
		wire.set(ciphertext, HEADER_BYTES);
		zero(ciphertext);
		data.sendCounter += 1n;
		return success(wire);
	} catch {
		closeChannelData(channelValue);
		return failure("CRYPTO_FAILURE");
	} finally {
		if (channels.get(channelValue) === data) data.sendBusy = false;
		zero(plaintext);
		zero(nonce);
		zero(additionalData);
	}
}

export interface SandboxDecryptedFrame {
	readonly streamId: bigint;
	readonly plaintext: Uint8Array<ArrayBuffer>;
}

export async function decryptSandboxTransportFrame(
	channelValue: unknown,
	wireValue: unknown,
): Promise<SandboxTransportResult<Readonly<SandboxDecryptedFrame>>> {
	if (typeof channelValue !== "object" || channelValue === null) return failure("CAPABILITY_INVALID");
	const data = channels.get(channelValue);
	if (data === undefined) return failure("CAPABILITY_INVALID");
	const wire = copyInput(wireValue, HEADER_BYTES + TAG_BYTES, MAX_WIRE_BYTES);
	if (wire === undefined) {
		closeChannelData(channelValue);
		return failure("PROTOCOL_ERROR");
	}
	if (data.receiveBusy) {
		zero(wire);
		closeChannelData(channelValue);
		return failure("PROTOCOL_ERROR");
	}
	data.receiveBusy = true;
	let counter: bigint;
	let streamId: bigint;
	let plaintextBytes: number;
	try {
		const view = new DataView(wire.buffer, wire.byteOffset, HEADER_BYTES);
		counter = view.getBigUint64(0, false);
		streamId = view.getBigUint64(8, false);
		plaintextBytes = view.getUint32(16, false);
	} catch {
		zero(wire);
		closeChannelData(channelValue);
		return failure("PROTOCOL_ERROR");
	}
	let invalid = counter !== data.receiveCounter || counter >= MAX_COUNTER || plaintextBytes > MAX_PLAINTEXT_BYTES;
	for (let index = 20; index < HEADER_BYTES; index += 1) invalid ||= wire[index] !== 0;
	if (invalid || wire.byteLength !== HEADER_BYTES + plaintextBytes + TAG_BYTES) {
		zero(wire);
		closeChannelData(channelValue);
		return failure("PROTOCOL_ERROR");
	}
	const frameHeader = copyBytes(wire.subarray(0, HEADER_BYTES));
	const ciphertext = copyBytes(wire.subarray(HEADER_BYTES));
	const nonce = iv(data.receiveDirection, counter);
	const additionalData = concatenate([data.transcriptHash, frameHeader]);
	zero(wire);
	if (additionalData === undefined) {
		zero(ciphertext);
		zero(nonce);
		closeChannelData(channelValue);
		return failure("CRYPTO_FAILURE");
	}
	try {
		const decrypted = await webcrypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
			data.receiveKey,
			ciphertext,
		);
		if (channels.get(channelValue) !== data) return failure("CAPABILITY_INVALID");
		const plaintext = copyInput(decrypted, plaintextBytes, plaintextBytes);
		if (plaintext === undefined) {
			closeChannelData(channelValue);
			return failure("CRYPTO_FAILURE");
		}
		data.receiveCounter += 1n;
		return success(Object.freeze({ streamId, plaintext }));
	} catch {
		closeChannelData(channelValue);
		return failure("AUTHENTICATION_FAILED");
	} finally {
		if (channels.get(channelValue) === data) data.receiveBusy = false;
		zero(ciphertext);
		zero(nonce);
		zero(additionalData);
	}
}

export const SANDBOX_TRANSPORT_HEADER_BYTES = HEADER_BYTES;
export const SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES = MAX_PLAINTEXT_BYTES;
export const SANDBOX_TRANSPORT_TAG_BYTES = TAG_BYTES;
