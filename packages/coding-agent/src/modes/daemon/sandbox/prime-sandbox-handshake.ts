import { copyLaunchConfigArchiveSha256, copyLaunchConfigHomePublicKey } from "./prime-sandbox-launch-config.js";
import {
	copyReadinessArchiveSha256,
	copyReadinessHomePublicKey,
	copyReadinessLauncherPublicKey,
	copyReadinessLauncherSha256,
	copyReadinessManifestSha256,
	copyReadinessProtocolNonce,
	copyReadinessSignature,
} from "./prime-sandbox-readiness-bundle.js";
import {
	closeSandboxTransportKeys,
	closeSandboxX25519KeyPair,
	copySandboxEd25519PublicKey,
	copySandboxX25519PublicKey,
	createSandboxTransportChannel,
	deriveSandboxTransportKeys,
	generateSandboxX25519KeyPair,
	randomSandboxHandshakeBytes,
	type SandboxTransportChannel,
	signSandboxHomeChallenge,
	signSandboxRuntimeChallenge,
	verifySandboxHomeChallenge,
	verifySandboxReadinessBundle,
	verifySandboxRuntimeChallenge,
} from "./prime-sandbox-transport.js";
import { copyBytes, equalBytes, isExactUint8Array } from "./prime-sandbox-validation.js";

const MAGIC = new Uint8Array([0x50, 0x33, 0x00]);
const ACK = new Uint8Array([0x01]);
const READY = new Uint8Array([0x02]);
const GREETING_TIMEOUT_MS = 5_000;
const PHASE_TIMEOUT_MS = 3_000;

export interface SandboxHandshakeIo {
	readExact(length: number, timeoutMs: number): Promise<unknown>;
	writeExact(bytes: Uint8Array<ArrayBuffer>, timeoutMs: number): Promise<boolean>;
	/** Must be idempotent because peer loss can race a local failure. */
	close(): void;
}

export type SandboxHandshakeError = "INPUT_INVALID" | "IO_FAILURE" | "AUTHENTICATION_FAILED" | "CRYPTO_FAILURE";

export type SandboxHandshakeResult =
	| Readonly<{ ok: true; channel: SandboxTransportChannel }>
	| Readonly<{ ok: false; code: SandboxHandshakeError }>;

function failure(code: SandboxHandshakeError): Readonly<{ ok: false; code: SandboxHandshakeError }> {
	return Object.freeze({ ok: false, code });
}

function copyExact(value: unknown, length: number): Uint8Array<ArrayBuffer> | undefined {
	try {
		if (!isExactUint8Array(value) || value.byteLength !== length) {
			return undefined;
		}
		const buffer = value.buffer;
		if (
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
			Object.hasOwn(buffer, "resizable") ||
			Object.hasOwn(buffer, "maxByteLength") ||
			Reflect.get(buffer, "resizable") === true
		) {
			return undefined;
		}
		return copyBytes(new Uint8Array(buffer, value.byteOffset, value.byteLength));
	} catch {
		return undefined;
	}
}

function zero(...values: (Uint8Array | undefined)[]): void {
	for (const value of values) value?.fill(0);
}

async function read(
	io: SandboxHandshakeIo,
	length: number,
	timeoutMs: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
	try {
		return copyExact(await io.readExact(length, timeoutMs), length);
	} catch {
		return undefined;
	}
}

async function write(io: SandboxHandshakeIo, value: Uint8Array, timeoutMs = PHASE_TIMEOUT_MS): Promise<boolean> {
	const copy = copyBytes(value);
	try {
		return (await io.writeExact(copy, timeoutMs)) === true;
	} catch {
		return false;
	} finally {
		copy.fill(0);
	}
}

function stop(
	io: SandboxHandshakeIo,
	code: SandboxHandshakeError,
): Readonly<{ ok: false; code: SandboxHandshakeError }> {
	try {
		io.close();
	} catch {
		// The fixed result remains authoritative.
	}
	return failure(code);
}

function random32(): Uint8Array<ArrayBuffer> | undefined {
	const result = randomSandboxHandshakeBytes();
	return result.ok ? result.value : undefined;
}

export async function performSandboxHomeHandshake(
	io: SandboxHandshakeIo,
	homeIdentity: unknown,
	readiness: unknown,
): Promise<SandboxHandshakeResult> {
	let challenge1: Uint8Array<ArrayBuffer> | undefined;
	let challenge2: Uint8Array<ArrayBuffer> | undefined;
	let protocolNonce: Uint8Array<ArrayBuffer> | undefined;
	let signature1: Uint8Array<ArrayBuffer> | undefined;
	let signature2: Uint8Array<ArrayBuffer> | undefined;
	let homeXPublic: Uint8Array<ArrayBuffer> | undefined;
	let runtimeXPublic: Uint8Array<ArrayBuffer> | undefined;
	let archiveSha256: Uint8Array<ArrayBuffer> | undefined;
	let homeX: unknown;
	try {
		const launcherPublicKey = copyReadinessLauncherPublicKey(readiness);
		const expectedHomePublicKey = copyReadinessHomePublicKey(readiness);
		archiveSha256 = copyReadinessArchiveSha256(readiness);
		const manifestSha256 = copyReadinessManifestSha256(readiness);
		const launcherSha256 = copyReadinessLauncherSha256(readiness);
		const expectedProtocolNonce = copyReadinessProtocolNonce(readiness);
		const bundleSignature = copyReadinessSignature(readiness);
		const actualHomePublicKey = copySandboxEd25519PublicKey(homeIdentity);
		if (
			launcherPublicKey === undefined ||
			expectedHomePublicKey === undefined ||
			archiveSha256 === undefined ||
			manifestSha256 === undefined ||
			launcherSha256 === undefined ||
			expectedProtocolNonce === undefined ||
			bundleSignature === undefined ||
			actualHomePublicKey === undefined ||
			!equalBytes(expectedHomePublicKey, actualHomePublicKey)
		) {
			zero(
				launcherPublicKey,
				expectedHomePublicKey,
				archiveSha256,
				manifestSha256,
				launcherSha256,
				expectedProtocolNonce,
				bundleSignature,
				actualHomePublicKey,
			);
			return stop(io, "INPUT_INVALID");
		}
		const bundleVerified = await verifySandboxReadinessBundle(
			{
				launcherPublicKey,
				homePublicKey: expectedHomePublicKey,
				archiveSha256,
				manifestSha256,
				launcherSha256,
				protocolNonce: expectedProtocolNonce,
			},
			bundleSignature,
		);
		zero(manifestSha256, launcherSha256, bundleSignature, actualHomePublicKey);
		if (!bundleVerified.ok || !bundleVerified.value) {
			zero(launcherPublicKey, expectedHomePublicKey, archiveSha256, expectedProtocolNonce);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		const greeting = await read(io, 3, GREETING_TIMEOUT_MS);
		if (greeting === undefined) {
			zero(launcherPublicKey, expectedHomePublicKey, archiveSha256, expectedProtocolNonce);
			return stop(io, "IO_FAILURE");
		}
		if (!equalBytes(greeting, MAGIC)) {
			zero(greeting, launcherPublicKey, expectedHomePublicKey, archiveSha256, expectedProtocolNonce);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		zero(greeting);
		if (!(await write(io, MAGIC))) {
			zero(launcherPublicKey, expectedHomePublicKey, archiveSha256, expectedProtocolNonce);
			return stop(io, "IO_FAILURE");
		}
		protocolNonce = await read(io, 32, PHASE_TIMEOUT_MS);
		if (protocolNonce === undefined) {
			zero(launcherPublicKey, expectedHomePublicKey, archiveSha256, expectedProtocolNonce);
			return stop(io, "IO_FAILURE");
		}
		if (!equalBytes(protocolNonce, expectedProtocolNonce)) {
			zero(launcherPublicKey, expectedHomePublicKey, archiveSha256, expectedProtocolNonce);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		zero(expectedProtocolNonce, expectedHomePublicKey);
		challenge1 = random32();
		if (challenge1 === undefined) {
			zero(launcherPublicKey, archiveSha256);
			return stop(io, "CRYPTO_FAILURE");
		}
		if (!(await write(io, challenge1))) {
			zero(launcherPublicKey, archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		signature1 = await read(io, 64, PHASE_TIMEOUT_MS);
		if (signature1 === undefined) {
			zero(launcherPublicKey, archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		const runtimeVerified = await verifySandboxRuntimeChallenge(
			launcherPublicKey,
			signature1,
			protocolNonce,
			challenge1,
		);
		zero(launcherPublicKey);
		if (!runtimeVerified.ok || !runtimeVerified.value) {
			zero(archiveSha256);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		if (!(await write(io, ACK))) {
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		challenge2 = random32();
		if (challenge2 === undefined) {
			zero(archiveSha256);
			return stop(io, "CRYPTO_FAILURE");
		}
		if (!(await write(io, challenge2))) {
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		const signed = await signSandboxHomeChallenge(homeIdentity, protocolNonce, challenge2);
		if (!signed.ok) {
			zero(archiveSha256);
			return stop(io, "CRYPTO_FAILURE");
		}
		signature2 = signed.value;
		if (!(await write(io, signature2))) {
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		const homeAck = await read(io, 1, PHASE_TIMEOUT_MS);
		if (homeAck === undefined) {
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		if (!equalBytes(homeAck, ACK)) {
			zero(homeAck, archiveSha256);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		zero(homeAck);
		if (!(await write(io, READY))) {
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		const readyEcho = await read(io, 1, PHASE_TIMEOUT_MS);
		if (readyEcho === undefined) {
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		if (!equalBytes(readyEcho, READY)) {
			zero(readyEcho, archiveSha256);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		zero(readyEcho);
		const generatedX = await generateSandboxX25519KeyPair();
		if (!generatedX.ok) {
			zero(archiveSha256);
			return stop(io, "CRYPTO_FAILURE");
		}
		homeX = generatedX.value;
		homeXPublic = copySandboxX25519PublicKey(homeX);
		if (homeXPublic === undefined || !(await write(io, homeXPublic))) {
			closeSandboxX25519KeyPair(homeX);
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		runtimeXPublic = await read(io, 32, PHASE_TIMEOUT_MS);
		if (runtimeXPublic === undefined) {
			closeSandboxX25519KeyPair(homeX);
			zero(archiveSha256);
			return stop(io, "IO_FAILURE");
		}
		const derived = await deriveSandboxTransportKeys(homeX, "home", {
			protocolNonce,
			challenge1,
			signature1,
			challenge2,
			signature2,
			homeX25519PublicKey: homeXPublic,
			runtimeX25519PublicKey: runtimeXPublic,
			archiveSha256,
		});
		closeSandboxX25519KeyPair(homeX);
		homeX = undefined;
		if (!derived.ok) return stop(io, "CRYPTO_FAILURE");
		const channel = createSandboxTransportChannel(derived.value, "home");
		if (!channel.ok) {
			closeSandboxTransportKeys(derived.value);
			return stop(io, "CRYPTO_FAILURE");
		}
		return Object.freeze({ ok: true, channel: channel.value });
	} catch {
		if (homeX !== undefined) closeSandboxX25519KeyPair(homeX);
		return stop(io, "CRYPTO_FAILURE");
	} finally {
		zero(challenge1, challenge2, protocolNonce, signature1, signature2, homeXPublic, runtimeXPublic, archiveSha256);
	}
}

export async function performSandboxRuntimeHandshake(
	io: SandboxHandshakeIo,
	runtimeIdentity: unknown,
	launchConfig: unknown,
	protocolNonceValue: unknown,
): Promise<SandboxHandshakeResult> {
	let protocolNonce = copyExact(protocolNonceValue, 32);
	let challenge1: Uint8Array<ArrayBuffer> | undefined;
	let challenge2: Uint8Array<ArrayBuffer> | undefined;
	let signature1: Uint8Array<ArrayBuffer> | undefined;
	let signature2: Uint8Array<ArrayBuffer> | undefined;
	let homeXPublic: Uint8Array<ArrayBuffer> | undefined;
	let runtimeXPublic: Uint8Array<ArrayBuffer> | undefined;
	let runtimeX: unknown;
	const homePublicKey = copyLaunchConfigHomePublicKey(launchConfig);
	const archiveSha256 = copyLaunchConfigArchiveSha256(launchConfig);
	const runtimePublicKey = copySandboxEd25519PublicKey(runtimeIdentity);
	try {
		if (
			protocolNonce === undefined ||
			homePublicKey === undefined ||
			archiveSha256 === undefined ||
			runtimePublicKey === undefined
		) {
			return stop(io, "INPUT_INVALID");
		}
		if (!(await write(io, MAGIC, GREETING_TIMEOUT_MS))) return stop(io, "IO_FAILURE");
		const echo = await read(io, 3, GREETING_TIMEOUT_MS);
		if (echo === undefined) return stop(io, "IO_FAILURE");
		if (!equalBytes(echo, MAGIC)) {
			zero(echo);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		zero(echo);
		if (!(await write(io, protocolNonce))) return stop(io, "IO_FAILURE");
		challenge1 = await read(io, 32, PHASE_TIMEOUT_MS);
		if (challenge1 === undefined) return stop(io, "IO_FAILURE");
		const runtimeSigned = await signSandboxRuntimeChallenge(runtimeIdentity, protocolNonce, challenge1);
		if (!runtimeSigned.ok) return stop(io, "CRYPTO_FAILURE");
		signature1 = runtimeSigned.value;
		if (!(await write(io, signature1))) return stop(io, "IO_FAILURE");
		const runtimeAck = await read(io, 1, PHASE_TIMEOUT_MS);
		if (runtimeAck === undefined) return stop(io, "IO_FAILURE");
		if (!equalBytes(runtimeAck, ACK)) {
			zero(runtimeAck);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		zero(runtimeAck);
		challenge2 = await read(io, 32, PHASE_TIMEOUT_MS);
		signature2 = await read(io, 64, PHASE_TIMEOUT_MS);
		if (challenge2 === undefined || signature2 === undefined) return stop(io, "IO_FAILURE");
		const homeVerified = await verifySandboxHomeChallenge(homePublicKey, signature2, protocolNonce, challenge2);
		if (!homeVerified.ok || !homeVerified.value) return stop(io, "AUTHENTICATION_FAILED");
		if (!(await write(io, ACK))) return stop(io, "IO_FAILURE");
		const ready = await read(io, 1, PHASE_TIMEOUT_MS);
		if (ready === undefined) return stop(io, "IO_FAILURE");
		if (!equalBytes(ready, READY)) {
			zero(ready);
			return stop(io, "AUTHENTICATION_FAILED");
		}
		zero(ready);
		if (!(await write(io, READY))) return stop(io, "IO_FAILURE");
		homeXPublic = await read(io, 32, PHASE_TIMEOUT_MS);
		if (homeXPublic === undefined) return stop(io, "IO_FAILURE");
		const generatedX = await generateSandboxX25519KeyPair();
		if (!generatedX.ok) return stop(io, "CRYPTO_FAILURE");
		runtimeX = generatedX.value;
		runtimeXPublic = copySandboxX25519PublicKey(runtimeX);
		if (runtimeXPublic === undefined || !(await write(io, runtimeXPublic))) {
			closeSandboxX25519KeyPair(runtimeX);
			return stop(io, "IO_FAILURE");
		}
		const derived = await deriveSandboxTransportKeys(runtimeX, "runtime", {
			protocolNonce,
			challenge1,
			signature1,
			challenge2,
			signature2,
			homeX25519PublicKey: homeXPublic,
			runtimeX25519PublicKey: runtimeXPublic,
			archiveSha256,
		});
		closeSandboxX25519KeyPair(runtimeX);
		runtimeX = undefined;
		if (!derived.ok) return stop(io, "CRYPTO_FAILURE");
		const channel = createSandboxTransportChannel(derived.value, "runtime");
		if (!channel.ok) {
			closeSandboxTransportKeys(derived.value);
			return stop(io, "CRYPTO_FAILURE");
		}
		return Object.freeze({ ok: true, channel: channel.value });
	} catch {
		if (runtimeX !== undefined) closeSandboxX25519KeyPair(runtimeX);
		return stop(io, "CRYPTO_FAILURE");
	} finally {
		zero(
			protocolNonce,
			challenge1,
			challenge2,
			signature1,
			signature2,
			homeXPublic,
			runtimeXPublic,
			homePublicKey,
			archiveSha256,
			runtimePublicKey,
		);
		protocolNonce = undefined;
	}
}
