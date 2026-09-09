import { describe, expect, test } from "bun:test";
import { webcrypto } from "node:crypto";
import {
	buildSandboxReadinessBundle,
	copyReadinessArchiveSha256,
	copyReadinessHomePublicKey,
	copyReadinessLauncherPublicKey,
	copyReadinessLauncherSha256,
	copyReadinessManifestSha256,
	copyReadinessProtocolNonce,
	copyReadinessSignature,
	decodeSandboxReadinessBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-readiness-bundle.js";
import {
	closeSandboxEd25519KeyPair,
	closeSandboxTransportChannel,
	closeSandboxTransportKeys,
	closeSandboxX25519KeyPair,
	copySandboxEd25519PublicKey,
	copySandboxTransportSessionId,
	copySandboxX25519PublicKey,
	createSandboxTransportChannel,
	decryptSandboxTransportFrame,
	deriveSandboxTransportKeys,
	encryptSandboxTransportFrame,
	generateSandboxEd25519KeyPair,
	generateSandboxX25519KeyPair,
	randomSandboxHandshakeBytes,
	SandboxEd25519KeyPair,
	SandboxTransportChannel,
	SandboxTransportKeys,
	SandboxX25519KeyPair,
	signSandboxHomeChallenge,
	signSandboxReadinessBundle,
	signSandboxRuntimeChallenge,
	verifySandboxHomeChallenge,
	verifySandboxReadinessBundle,
	verifySandboxRuntimeChallenge,
} from "../src/modes/daemon/sandbox/prime-sandbox-transport.js";

function sequence(start: number, length: number): Uint8Array<ArrayBuffer> {
	const value = new Uint8Array(new ArrayBuffer(length));
	for (let index = 0; index < length; index += 1) value[index] = (start + index) & 0xff;
	return value;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	let length = 0;
	for (const part of parts) length += part.byteLength;
	const value = new Uint8Array(new ArrayBuffer(length));
	let offset = 0;
	for (const part of parts) {
		value.set(part, offset);
		offset += part.byteLength;
	}
	return value;
}

async function handshake() {
	const runtimeIdentityResult = await generateSandboxEd25519KeyPair();
	const homeIdentityResult = await generateSandboxEd25519KeyPair();
	if (!runtimeIdentityResult.ok || !homeIdentityResult.ok) throw new Error("identity setup failed");
	const runtimeIdentity = runtimeIdentityResult.value;
	const homeIdentity = homeIdentityResult.value;
	const runtimePublic = copySandboxEd25519PublicKey(runtimeIdentity);
	const homePublic = copySandboxEd25519PublicKey(homeIdentity);
	if (runtimePublic === undefined || homePublic === undefined) throw new Error("public key setup failed");
	const protocolNonce = sequence(1, 32);
	const challenge1 = sequence(33, 32);
	const challenge2 = sequence(65, 32);
	const signature1Result = await signSandboxRuntimeChallenge(runtimeIdentity, protocolNonce, challenge1);
	const signature2Result = await signSandboxHomeChallenge(homeIdentity, protocolNonce, challenge2);
	if (!signature1Result.ok || !signature2Result.ok) throw new Error("signature setup failed");
	const homeXResult = await generateSandboxX25519KeyPair();
	const runtimeXResult = await generateSandboxX25519KeyPair();
	if (!homeXResult.ok || !runtimeXResult.ok) throw new Error("x25519 setup failed");
	const homeXPublic = copySandboxX25519PublicKey(homeXResult.value);
	const runtimeXPublic = copySandboxX25519PublicKey(runtimeXResult.value);
	if (homeXPublic === undefined || runtimeXPublic === undefined) throw new Error("x25519 public setup failed");
	const transcript = {
		protocolNonce,
		challenge1,
		signature1: signature1Result.value,
		challenge2,
		signature2: signature2Result.value,
		homeX25519PublicKey: homeXPublic,
		runtimeX25519PublicKey: runtimeXPublic,
		archiveSha256: sequence(97, 32),
	};
	const homeKeysResult = await deriveSandboxTransportKeys(homeXResult.value, "home", transcript);
	const runtimeKeysResult = await deriveSandboxTransportKeys(runtimeXResult.value, "runtime", transcript);
	if (!homeKeysResult.ok || !runtimeKeysResult.ok) throw new Error("key setup failed");
	const homeResult = createSandboxTransportChannel(homeKeysResult.value, "home");
	const runtimeResult = createSandboxTransportChannel(runtimeKeysResult.value, "runtime");
	if (!homeResult.ok || !runtimeResult.ok) throw new Error("channel setup failed");
	return {
		home: homeResult.value,
		runtime: runtimeResult.value,
		runtimeIdentity,
		homeIdentity,
	};
}

function bundleFields(launcherPublicKey: Uint8Array<ArrayBuffer>): object {
	return {
		launcherPublicKey,
		homePublicKey: sequence(32, 32),
		archiveSha256: sequence(64, 32),
		manifestSha256: sequence(96, 32),
		launcherSha256: sequence(128, 32),
		protocolNonce: sequence(160, 32),
	};
}

describe("sandbox transport identity", () => {
	test("signs and verifies the exact readiness domain with copy isolation", async () => {
		const generated = await generateSandboxEd25519KeyPair();
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		const publicKey = copySandboxEd25519PublicKey(generated.value);
		expect(publicKey?.byteLength).toBe(32);
		if (publicKey === undefined) return;
		const fields = bundleFields(publicKey);
		const signed = await signSandboxReadinessBundle(generated.value, fields);
		expect(signed.ok).toBe(true);
		if (!signed.ok) return;
		expect(signed.value.byteLength).toBe(64);
		const verified = await verifySandboxReadinessBundle(fields, signed.value);
		expect(verified).toEqual({ ok: true, value: true });
		publicKey.fill(0);
		expect(copySandboxEd25519PublicKey(generated.value)).not.toEqual(publicKey);
		const changed = bundleFields(copySandboxEd25519PublicKey(generated.value) ?? sequence(0, 32));
		const digest = Object.getOwnPropertyDescriptor(changed, "archiveSha256")?.value;
		if (digest instanceof Uint8Array) digest[0] ^= 1;
		expect(await verifySandboxReadinessBundle(changed, signed.value)).toEqual({ ok: true, value: false });
	});

	test("preserves the signed readiness bundle through the strict wire codec", async () => {
		const generated = await generateSandboxEd25519KeyPair();
		if (!generated.ok) throw new Error("setup failed");
		const launcherPublicKey = copySandboxEd25519PublicKey(generated.value);
		if (launcherPublicKey === undefined) throw new Error("setup failed");
		const fields = bundleFields(launcherPublicKey);
		const signed = await signSandboxReadinessBundle(generated.value, fields);
		if (!signed.ok) throw new Error("setup failed");
		const built = buildSandboxReadinessBundle({ ...fields, signature: signed.value });
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const decoded = decodeSandboxReadinessBundle(built.bytes);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		const decodedFields = {
			launcherPublicKey: copyReadinessLauncherPublicKey(decoded.readiness),
			homePublicKey: copyReadinessHomePublicKey(decoded.readiness),
			archiveSha256: copyReadinessArchiveSha256(decoded.readiness),
			manifestSha256: copyReadinessManifestSha256(decoded.readiness),
			launcherSha256: copyReadinessLauncherSha256(decoded.readiness),
			protocolNonce: copyReadinessProtocolNonce(decoded.readiness),
		};
		const signature = copyReadinessSignature(decoded.readiness);
		expect(await verifySandboxReadinessBundle(decodedFields, signature)).toEqual({ ok: true, value: true });
	});

	test("keeps runtime and Home challenge domains separate", async () => {
		const generated = await generateSandboxEd25519KeyPair();
		if (!generated.ok) throw new Error("setup failed");
		const publicKey = copySandboxEd25519PublicKey(generated.value);
		if (publicKey === undefined) throw new Error("setup failed");
		const nonce = sequence(0, 32);
		const challenge = sequence(32, 32);
		const runtimeSignature = await signSandboxRuntimeChallenge(generated.value, nonce, challenge);
		const homeSignature = await signSandboxHomeChallenge(generated.value, nonce, challenge);
		if (!runtimeSignature.ok || !homeSignature.ok) throw new Error("setup failed");
		expect(await verifySandboxRuntimeChallenge(publicKey, runtimeSignature.value, nonce, challenge)).toEqual({
			ok: true,
			value: true,
		});
		expect(await verifySandboxHomeChallenge(publicKey, runtimeSignature.value, nonce, challenge)).toEqual({
			ok: true,
			value: false,
		});
		expect(await verifySandboxRuntimeChallenge(publicKey, homeSignature.value, nonce, challenge)).toEqual({
			ok: true,
			value: false,
		});
	});

	test("rejects malformed hostile bytes and forged or closed keys", async () => {
		const generated = await generateSandboxEd25519KeyPair();
		if (!generated.ok) throw new Error("setup failed");
		const publicKey = copySandboxEd25519PublicKey(generated.value);
		if (publicKey === undefined) throw new Error("setup failed");
		const fields = bundleFields(publicKey);
		expect((await signSandboxReadinessBundle(Object.create(SandboxEd25519KeyPair.prototype), fields)).ok).toBe(false);
		expect(() => new SandboxEd25519KeyPair(Object.freeze({}))).toThrow();
		expect(
			(await signSandboxReadinessBundle(generated.value, { ...fields, homePublicKey: Buffer.alloc(32) })).ok,
		).toBe(false);
		expect((await signSandboxReadinessBundle(generated.value, new Proxy(fields, {}))).ok).toBe(false);
		expect(
			(await verifySandboxRuntimeChallenge(publicKey, new Uint8Array(63), sequence(0, 32), sequence(0, 32))).ok,
		).toBe(false);
		const resizableSignature: unknown = Reflect.construct(ArrayBuffer, [64, { maxByteLength: 96 }]);
		if (!(resizableSignature instanceof ArrayBuffer)) throw new Error("setup failed");
		Object.defineProperty(resizableSignature, "resizable", { value: false });
		expect(
			(await verifySandboxRuntimeChallenge(publicKey, resizableSignature, sequence(0, 32), sequence(0, 32))).ok,
		).toBe(false);
		const pending = signSandboxReadinessBundle(generated.value, fields);
		expect(closeSandboxEd25519KeyPair(generated.value)).toBe(true);
		expect(closeSandboxEd25519KeyPair(generated.value)).toBe(false);
		expect(await pending).toEqual({ ok: false, code: "CAPABILITY_INVALID" });
		expect((await signSandboxReadinessBundle(generated.value, fields)).ok).toBe(false);
	});

	test("generates fresh exact handshake bytes", () => {
		const first = randomSandboxHandshakeBytes();
		const second = randomSandboxHandshakeBytes();
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.value.byteLength).toBe(32);
		expect(second.value.byteLength).toBe(32);
		expect(first.value).not.toEqual(second.value);
	});
});

describe("sandbox encrypted frames", () => {
	test("round trips both directions with exact header and IV semantics", async () => {
		const pair = await handshake();
		const plaintext = sequence(1, 3);
		const sent = await encryptSandboxTransportFrame(pair.home, 0x0102n, plaintext);
		expect(sent.ok).toBe(true);
		if (!sent.ok) return;
		expect(sent.value.byteLength).toBe(32 + 3 + 16);
		const header = new DataView(sent.value.buffer, sent.value.byteOffset, 32);
		expect(header.getBigUint64(0, false)).toBe(1n);
		expect(header.getBigUint64(8, false)).toBe(0x0102n);
		expect(header.getUint32(16, false)).toBe(3);
		expect(Array.from(sent.value.subarray(20, 32))).toEqual(new Array(12).fill(0));
		const received = await decryptSandboxTransportFrame(pair.runtime, sent.value);
		expect(received).toEqual({ ok: true, value: { streamId: 0x0102n, plaintext } });
		const response = await encryptSandboxTransportFrame(pair.runtime, 9n, sequence(9, 5));
		if (!response.ok) throw new Error("send failed");
		expect(await decryptSandboxTransportFrame(pair.home, response.value)).toEqual({
			ok: true,
			value: { streamId: 9n, plaintext: sequence(9, 5) },
		});
	});

	test("encodes empty plaintext without invented padding", async () => {
		const pair = await handshake();
		const sent = await encryptSandboxTransportFrame(pair.home, 0n, new Uint8Array(0));
		expect(sent.ok).toBe(true);
		if (!sent.ok) return;
		expect(sent.value.byteLength).toBe(48);
		expect(new DataView(sent.value.buffer).getUint32(16, false)).toBe(0);
		expect(await decryptSandboxTransportFrame(pair.runtime, sent.value)).toEqual({
			ok: true,
			value: { streamId: 0n, plaintext: new Uint8Array(0) },
		});
	});

	test("accepts exactly 256 KiB and rejects one byte more before dispatch", async () => {
		const pair = await handshake();
		const tooLarge = await encryptSandboxTransportFrame(pair.home, 0n, new Uint8Array(256 * 1024 + 1));
		expect(tooLarge).toEqual({ ok: false, code: "INPUT_INVALID" });
		const maximum = sequence(0, 256 * 1024);
		const sent = await encryptSandboxTransportFrame(pair.home, 0n, maximum);
		expect(sent.ok).toBe(true);
		if (!sent.ok) return;
		expect(sent.value.byteLength).toBe(32 + 256 * 1024 + 16);
		const received = await decryptSandboxTransportFrame(pair.runtime, sent.value);
		expect(received.ok).toBe(true);
		if (received.ok) expect(received.value.plaintext).toEqual(maximum);
	});

	test("rejects truncated, trailing, reserved, skipped, and exhausted counter frames", async () => {
		for (const mutate of [
			(value: Uint8Array<ArrayBuffer>) => value.slice(0, -1),
			(value: Uint8Array<ArrayBuffer>) => concat([value, new Uint8Array([0])]),
			(value: Uint8Array<ArrayBuffer>) => {
				const copy = value.slice();
				copy[20] = 1;
				return copy;
			},
			(value: Uint8Array<ArrayBuffer>) => {
				const copy = value.slice();
				new DataView(copy.buffer).setBigUint64(0, 2n, false);
				return copy;
			},
			(value: Uint8Array<ArrayBuffer>) => {
				const copy = value.slice();
				new DataView(copy.buffer).setBigUint64(0, 0xffffffffffffffffn, false);
				return copy;
			},
		]) {
			const pair = await handshake();
			const sent = await encryptSandboxTransportFrame(pair.home, 0n, sequence(1, 4));
			if (!sent.ok) throw new Error("setup failed");
			const result = await decryptSandboxTransportFrame(pair.runtime, mutate(sent.value));
			expect(result.ok).toBe(false);
		}
	});

	test("authenticates ciphertext, header, direction, and transcript and closes on failure", async () => {
		const pair = await handshake();
		const sent = await encryptSandboxTransportFrame(pair.home, 3n, sequence(1, 4));
		if (!sent.ok) throw new Error("setup failed");
		const tampered = sent.value.slice();
		tampered[tampered.byteLength - 1] ^= 1;
		expect(await decryptSandboxTransportFrame(pair.runtime, tampered)).toEqual({
			ok: false,
			code: "AUTHENTICATION_FAILED",
		});
		expect(await decryptSandboxTransportFrame(pair.runtime, sent.value)).toEqual({
			ok: false,
			code: "CAPABILITY_INVALID",
		});
		const wrongDirection = await handshake();
		const runtimeSent = await encryptSandboxTransportFrame(wrongDirection.runtime, 0n, sequence(1, 2));
		if (!runtimeSent.ok) throw new Error("setup failed");
		expect((await decryptSandboxTransportFrame(wrongDirection.runtime, runtimeSent.value)).ok).toBe(false);
	});

	test("rejects replay and closes the channel", async () => {
		const pair = await handshake();
		const sent = await encryptSandboxTransportFrame(pair.home, 0n, sequence(1, 2));
		if (!sent.ok) throw new Error("setup failed");
		expect((await decryptSandboxTransportFrame(pair.runtime, sent.value)).ok).toBe(true);
		expect(await decryptSandboxTransportFrame(pair.runtime, sent.value)).toEqual({
			ok: false,
			code: "PROTOCOL_ERROR",
		});
		expect(copySandboxTransportSessionId(pair.runtime)).toBeUndefined();
	});

	test("copies input before await and rejects concurrent use", async () => {
		const isolated = await handshake();
		const plaintext = sequence(1, 32);
		const promise = encryptSandboxTransportFrame(isolated.home, 0n, plaintext);
		plaintext.fill(0);
		const sent = await promise;
		if (!sent.ok) throw new Error("setup failed");
		const received = await decryptSandboxTransportFrame(isolated.runtime, sent.value);
		expect(received.ok).toBe(true);
		if (received.ok) expect(received.value.plaintext).toEqual(sequence(1, 32));
		const concurrent = await handshake();
		const first = encryptSandboxTransportFrame(concurrent.home, 0n, sequence(1, 1));
		const second = encryptSandboxTransportFrame(concurrent.home, 1n, sequence(2, 1));
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
	});

	test("binds frames to the complete handshake transcript", async () => {
		const homeX = await generateSandboxX25519KeyPair();
		const runtimeX = await generateSandboxX25519KeyPair();
		if (!homeX.ok || !runtimeX.ok) throw new Error("setup failed");
		const homePublic = copySandboxX25519PublicKey(homeX.value);
		const runtimePublic = copySandboxX25519PublicKey(runtimeX.value);
		if (homePublic === undefined || runtimePublic === undefined) throw new Error("setup failed");
		const transcript = {
			protocolNonce: sequence(1, 32),
			challenge1: sequence(33, 32),
			signature1: sequence(65, 64),
			challenge2: sequence(129, 32),
			signature2: sequence(161, 64),
			homeX25519PublicKey: homePublic,
			runtimeX25519PublicKey: runtimePublic,
			archiveSha256: sequence(225, 32),
		};
		const homeKeys = await deriveSandboxTransportKeys(homeX.value, "home", transcript);
		const runtimeKeys = await deriveSandboxTransportKeys(runtimeX.value, "runtime", {
			...transcript,
			challenge2: sequence(130, 32),
		});
		if (!homeKeys.ok || !runtimeKeys.ok) throw new Error("setup failed");
		const home = createSandboxTransportChannel(homeKeys.value, "home");
		const runtime = createSandboxTransportChannel(runtimeKeys.value, "runtime");
		if (!home.ok || !runtime.ok) throw new Error("setup failed");
		const sent = await encryptSandboxTransportFrame(home.value, 0n, sequence(1, 4));
		if (!sent.ok) throw new Error("setup failed");
		expect(await decryptSandboxTransportFrame(runtime.value, sent.value)).toEqual({
			ok: false,
			code: "AUTHENTICATION_FAILED",
		});
	});

	test("capabilities are unforgeable, consumed once, and close once", async () => {
		expect(() => new SandboxX25519KeyPair(Object.freeze({}))).toThrow();
		expect(() => new SandboxTransportKeys(Object.freeze({}))).toThrow();
		expect(() => new SandboxTransportChannel(Object.freeze({}))).toThrow();
		const generated = await generateSandboxX25519KeyPair();
		if (!generated.ok) throw new Error("setup failed");
		expect(closeSandboxX25519KeyPair(generated.value)).toBe(true);
		expect(closeSandboxX25519KeyPair(generated.value)).toBe(false);
		const pair = await handshake();
		expect(closeSandboxTransportChannel(pair.home)).toBe(true);
		expect(closeSandboxTransportChannel(pair.home)).toBe(false);
		expect((await encryptSandboxTransportFrame(pair.home, 0n, new Uint8Array(0))).ok).toBe(false);
	});
});

describe("sandbox key derivation", () => {
	test("rejects an all-zero peer key and consumes the one-shot private key", async () => {
		const runtime = await generateSandboxX25519KeyPair();
		if (!runtime.ok) throw new Error("setup failed");
		const runtimePublic = copySandboxX25519PublicKey(runtime.value);
		if (runtimePublic === undefined) throw new Error("setup failed");
		const result = await deriveSandboxTransportKeys(runtime.value, "runtime", {
			protocolNonce: sequence(1, 32),
			challenge1: sequence(33, 32),
			signature1: sequence(65, 64),
			challenge2: sequence(129, 32),
			signature2: sequence(161, 64),
			homeX25519PublicKey: new Uint8Array(32),
			runtimeX25519PublicKey: runtimePublic,
			archiveSha256: sequence(225, 32),
		});
		expect(result).toEqual({ ok: false, code: "CRYPTO_FAILURE" });
		expect(copySandboxX25519PublicKey(runtime.value)).toBeUndefined();
	});

	test("matches an independent HKDF session-id derivation", async () => {
		const runtimeResult = await generateSandboxX25519KeyPair();
		if (!runtimeResult.ok) throw new Error("setup failed");
		const runtimePublic = copySandboxX25519PublicKey(runtimeResult.value);
		if (runtimePublic === undefined) throw new Error("setup failed");
		const external = await webcrypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
		if (!("privateKey" in external) || !("publicKey" in external)) throw new Error("setup failed");
		const homePublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", external.publicKey));
		const protocolNonce = sequence(1, 32);
		const challenge1 = sequence(33, 32);
		const challenge2 = sequence(65, 32);
		const archiveSha256 = sequence(97, 32);
		const signature1 = sequence(129, 64);
		const signature2 = sequence(193, 64);
		const transcript = {
			protocolNonce,
			challenge1,
			signature1,
			challenge2,
			signature2,
			homeX25519PublicKey: homePublic,
			runtimeX25519PublicKey: runtimePublic,
			archiveSha256,
		};
		const keys = await deriveSandboxTransportKeys(runtimeResult.value, "runtime", transcript);
		expect(keys.ok).toBe(true);
		if (!keys.ok) return;
		expect(createSandboxTransportChannel(keys.value, "home")).toEqual({ ok: false, code: "INPUT_INVALID" });
		const channel = createSandboxTransportChannel(keys.value, "runtime");
		if (!channel.ok) throw new Error("setup failed");
		const importedRuntime = await webcrypto.subtle.importKey("raw", runtimePublic, { name: "X25519" }, false, []);
		const shared = new Uint8Array(
			await webcrypto.subtle.deriveBits({ name: "X25519", public: importedRuntime }, external.privateKey, 256),
		);
		const hkdf = await webcrypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits", "deriveKey"]);
		const salt = concat([protocolNonce, challenge1, challenge2]);
		const info = concat([new TextEncoder().encode("prime-sandbox-v3:session-id:"), archiveSha256]);
		const full = new Uint8Array(
			await webcrypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, hkdf, 256),
		);
		const sessionId = full.slice(0, 8);
		expect(copySandboxTransportSessionId(channel.value)).toEqual(sessionId);
		const runtimeInfo = concat([new TextEncoder().encode("prime-sandbox-v3:key:runtime-to-home:"), archiveSha256]);
		const runtimeKey = await webcrypto.subtle.deriveKey(
			{ name: "HKDF", hash: "SHA-256", salt: sessionId, info: runtimeInfo },
			hkdf,
			{ name: "AES-GCM", length: 256 },
			false,
			["decrypt"],
		);
		const transcriptMessage = concat([
			new TextEncoder().encode("prime-sandbox-v3:transcript"),
			protocolNonce,
			challenge1,
			signature1,
			challenge2,
			signature2,
			homePublic,
			runtimePublic,
			sessionId,
		]);
		const transcriptHash = new Uint8Array(await webcrypto.subtle.digest("SHA-256", transcriptMessage));
		const plaintext = sequence(7, 11);
		const sent = await encryptSandboxTransportFrame(channel.value, 7n, plaintext);
		if (!sent.ok) throw new Error("send failed");
		const frameHeader = sent.value.slice(0, 32);
		const nonce = new Uint8Array(12);
		const nonceView = new DataView(nonce.buffer);
		nonceView.setUint32(0, 2, false);
		nonceView.setBigUint64(4, 1n, false);
		const decrypted = await webcrypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: concat([transcriptHash, frameHeader]), tagLength: 128 },
			runtimeKey,
			sent.value.slice(32),
		);
		expect(new Uint8Array(decrypted)).toEqual(plaintext);
		expect(closeSandboxTransportKeys(keys.value)).toBe(false);
	});
});
