import { webcrypto } from "node:crypto";
import {
	closeSandboxTransportChannel,
	decryptSandboxTransportFrame,
	encryptSandboxTransportFrame,
	randomSandboxHandshakeBytes,
} from "./prime-sandbox-transport.js";
import { copyBytes, equalBytes } from "./prime-sandbox-validation.js";

const ISSUE = Object.freeze({});
const MESSAGE_BYTES = 48;
const TOKEN_BYTES = 32;
const ACTIVATE = 0x01;
const ACTIVATE_ACK = 0x02;

interface HomeActivationState {
	token: Uint8Array<ArrayBuffer> | undefined;
	expectedHash: Uint8Array<ArrayBuffer> | undefined;
}

interface RuntimeActivationState {
	readonly token: Uint8Array<ArrayBuffer>;
}

export class SandboxHomeActivation {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

export class SandboxRuntimeActivation {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

Object.freeze(SandboxHomeActivation.prototype);
Object.freeze(SandboxHomeActivation);
Object.freeze(SandboxRuntimeActivation.prototype);
Object.freeze(SandboxRuntimeActivation);

const homeActivations = new WeakMap<object, HomeActivationState>();
const runtimeActivations = new WeakMap<object, RuntimeActivationState>();

export type SandboxActivationResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; code: "CAPABILITY_INVALID" | "PROTOCOL_ERROR" | "CRYPTO_FAILURE" }>;

function success<T>(value: T): Readonly<{ ok: true; value: T }> {
	return Object.freeze({ ok: true, value });
}

function failure(
	code: "CAPABILITY_INVALID" | "PROTOCOL_ERROR" | "CRYPTO_FAILURE",
): Readonly<{ ok: false; code: "CAPABILITY_INVALID" | "PROTOCOL_ERROR" | "CRYPTO_FAILURE" }> {
	return Object.freeze({ ok: false, code });
}

function decodeMessage(value: Uint8Array, type: number): Uint8Array<ArrayBuffer> | undefined {
	if (value.byteLength !== MESSAGE_BYTES || value[0] !== type) return undefined;
	let padding = 0;
	for (let index = 1 + TOKEN_BYTES; index < MESSAGE_BYTES; index += 1) padding |= value[index];
	if (padding !== 0) return undefined;
	return copyBytes(value.subarray(1, 1 + TOKEN_BYTES));
}

async function hash(value: Uint8Array): Promise<Uint8Array<ArrayBuffer> | undefined> {
	try {
		return copyBytes(new Uint8Array(await webcrypto.subtle.digest("SHA-256", value)));
	} catch {
		return undefined;
	}
}

export function createSandboxHomeActivation(): SandboxActivationResult<SandboxHomeActivation> {
	const token = randomSandboxHandshakeBytes();
	if (!token.ok) return failure("CRYPTO_FAILURE");
	const activation = new SandboxHomeActivation(ISSUE);
	homeActivations.set(activation, { token: token.value, expectedHash: undefined });
	return success(activation);
}

export async function encryptSandboxHomeActivation(
	channel: unknown,
	activation: unknown,
): Promise<SandboxActivationResult<Uint8Array<ArrayBuffer>>> {
	if (typeof activation !== "object" || activation === null) return failure("CAPABILITY_INVALID");
	const state = homeActivations.get(activation);
	if (state === undefined || state.token === undefined || state.expectedHash !== undefined) {
		return failure("CAPABILITY_INVALID");
	}
	const token = state.token;
	const expectedHash = await hash(token);
	if (homeActivations.get(activation) !== state || state.token !== token) {
		expectedHash?.fill(0);
		return failure("CAPABILITY_INVALID");
	}
	if (expectedHash === undefined) {
		token.fill(0);
		homeActivations.delete(activation);
		return failure("CRYPTO_FAILURE");
	}
	const plaintext = new Uint8Array(new ArrayBuffer(MESSAGE_BYTES));
	plaintext[0] = ACTIVATE;
	plaintext.set(token, 1);
	token.fill(0);
	state.token = undefined;
	let encrypted: Awaited<ReturnType<typeof encryptSandboxTransportFrame>>;
	try {
		encrypted = await encryptSandboxTransportFrame(channel, 0n, plaintext);
	} catch {
		expectedHash.fill(0);
		homeActivations.delete(activation);
		closeSandboxTransportChannel(channel);
		return failure("CRYPTO_FAILURE");
	} finally {
		plaintext.fill(0);
	}
	if (homeActivations.get(activation) !== state) {
		expectedHash.fill(0);
		closeSandboxTransportChannel(channel);
		return failure("CAPABILITY_INVALID");
	}
	if (!encrypted.ok) {
		expectedHash.fill(0);
		homeActivations.delete(activation);
		return failure(encrypted.code === "CAPABILITY_INVALID" ? "CAPABILITY_INVALID" : "CRYPTO_FAILURE");
	}
	state.expectedHash = expectedHash;
	return success(encrypted.value);
}

export async function acceptSandboxRuntimeActivation(
	channel: unknown,
	wire: unknown,
): Promise<
	SandboxActivationResult<Readonly<{ activation: SandboxRuntimeActivation; ackFrame: Uint8Array<ArrayBuffer> }>>
> {
	let decrypted: Awaited<ReturnType<typeof decryptSandboxTransportFrame>>;
	try {
		decrypted = await decryptSandboxTransportFrame(channel, wire);
	} catch {
		closeSandboxTransportChannel(channel);
		return failure("CRYPTO_FAILURE");
	}
	if (!decrypted.ok) return failure(decrypted.code === "CAPABILITY_INVALID" ? "CAPABILITY_INVALID" : "PROTOCOL_ERROR");
	const token = decrypted.value.streamId === 0n ? decodeMessage(decrypted.value.plaintext, ACTIVATE) : undefined;
	decrypted.value.plaintext.fill(0);
	if (token === undefined) {
		closeSandboxTransportChannel(channel);
		return failure("PROTOCOL_ERROR");
	}
	const tokenHash = await hash(token);
	if (tokenHash === undefined) {
		token.fill(0);
		closeSandboxTransportChannel(channel);
		return failure("CRYPTO_FAILURE");
	}
	const ackPlaintext = new Uint8Array(new ArrayBuffer(MESSAGE_BYTES));
	ackPlaintext[0] = ACTIVATE_ACK;
	ackPlaintext.set(tokenHash, 1);
	tokenHash.fill(0);
	let encrypted: Awaited<ReturnType<typeof encryptSandboxTransportFrame>>;
	try {
		encrypted = await encryptSandboxTransportFrame(channel, 0n, ackPlaintext);
	} catch {
		token.fill(0);
		closeSandboxTransportChannel(channel);
		return failure("CRYPTO_FAILURE");
	} finally {
		ackPlaintext.fill(0);
	}
	if (!encrypted.ok) {
		token.fill(0);
		closeSandboxTransportChannel(channel);
		return failure(encrypted.code === "CAPABILITY_INVALID" ? "CAPABILITY_INVALID" : "CRYPTO_FAILURE");
	}
	const activation = new SandboxRuntimeActivation(ISSUE);
	runtimeActivations.set(activation, Object.freeze({ token }));
	return success(Object.freeze({ activation, ackFrame: encrypted.value }));
}

export async function confirmSandboxHomeActivation(
	channel: unknown,
	activation: unknown,
	wire: unknown,
): Promise<SandboxActivationResult<true>> {
	if (typeof activation !== "object" || activation === null) return failure("CAPABILITY_INVALID");
	const state = homeActivations.get(activation);
	const expectedHash = state?.expectedHash;
	if (state === undefined || expectedHash === undefined || state.token !== undefined) {
		return failure("CAPABILITY_INVALID");
	}
	homeActivations.delete(activation);
	let decrypted: Awaited<ReturnType<typeof decryptSandboxTransportFrame>>;
	try {
		decrypted = await decryptSandboxTransportFrame(channel, wire);
	} catch {
		expectedHash.fill(0);
		closeSandboxTransportChannel(channel);
		return failure("CRYPTO_FAILURE");
	}
	if (!decrypted.ok) {
		expectedHash.fill(0);
		return failure(decrypted.code === "CAPABILITY_INVALID" ? "CAPABILITY_INVALID" : "PROTOCOL_ERROR");
	}
	const receivedHash =
		decrypted.value.streamId === 0n ? decodeMessage(decrypted.value.plaintext, ACTIVATE_ACK) : undefined;
	decrypted.value.plaintext.fill(0);
	const valid = receivedHash !== undefined && equalBytes(expectedHash, receivedHash);
	expectedHash.fill(0);
	receivedHash?.fill(0);
	if (!valid) {
		closeSandboxTransportChannel(channel);
		return failure("PROTOCOL_ERROR");
	}
	return success(true);
}

export function closeSandboxHomeActivation(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const state = homeActivations.get(value);
	if (state === undefined) return false;
	homeActivations.delete(value);
	state.token?.fill(0);
	state.expectedHash?.fill(0);
	return true;
}

export function closeSandboxRuntimeActivation(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const state = runtimeActivations.get(value);
	if (state === undefined) return false;
	runtimeActivations.delete(value);
	state.token.fill(0);
	return true;
}
