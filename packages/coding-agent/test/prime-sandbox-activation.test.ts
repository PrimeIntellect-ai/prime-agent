import { describe, expect, test } from "bun:test";
import {
	acceptSandboxRuntimeActivation,
	closeSandboxHomeActivation,
	closeSandboxRuntimeActivation,
	confirmSandboxHomeActivation,
	createSandboxHomeActivation,
	encryptSandboxHomeActivation,
	SandboxHomeActivation,
	SandboxRuntimeActivation,
} from "../src/modes/daemon/sandbox/prime-sandbox-activation.js";
import {
	copySandboxEd25519PublicKey,
	copySandboxX25519PublicKey,
	createSandboxTransportChannel,
	decryptSandboxTransportFrame,
	deriveSandboxTransportKeys,
	encryptSandboxTransportFrame,
	generateSandboxEd25519KeyPair,
	generateSandboxX25519KeyPair,
	signSandboxHomeChallenge,
	signSandboxRuntimeChallenge,
} from "../src/modes/daemon/sandbox/prime-sandbox-transport.js";

function sequence(start: number, length: number): Uint8Array<ArrayBuffer> {
	const value = new Uint8Array(new ArrayBuffer(length));
	for (let index = 0; index < length; index += 1) value[index] = (start + index) & 0xff;
	return value;
}

async function channels() {
	const runtimeIdentity = await generateSandboxEd25519KeyPair();
	const homeIdentity = await generateSandboxEd25519KeyPair();
	if (!runtimeIdentity.ok || !homeIdentity.ok) throw new Error("setup failed");
	if (
		copySandboxEd25519PublicKey(runtimeIdentity.value) === undefined ||
		copySandboxEd25519PublicKey(homeIdentity.value) === undefined
	) {
		throw new Error("setup failed");
	}
	const protocolNonce = sequence(1, 32);
	const challenge1 = sequence(33, 32);
	const challenge2 = sequence(65, 32);
	const signature1 = await signSandboxRuntimeChallenge(runtimeIdentity.value, protocolNonce, challenge1);
	const signature2 = await signSandboxHomeChallenge(homeIdentity.value, protocolNonce, challenge2);
	const homeX = await generateSandboxX25519KeyPair();
	const runtimeX = await generateSandboxX25519KeyPair();
	if (!signature1.ok || !signature2.ok || !homeX.ok || !runtimeX.ok) throw new Error("setup failed");
	const homeXPublic = copySandboxX25519PublicKey(homeX.value);
	const runtimeXPublic = copySandboxX25519PublicKey(runtimeX.value);
	if (homeXPublic === undefined || runtimeXPublic === undefined) throw new Error("setup failed");
	const transcript = {
		protocolNonce,
		challenge1,
		signature1: signature1.value,
		challenge2,
		signature2: signature2.value,
		homeX25519PublicKey: homeXPublic,
		runtimeX25519PublicKey: runtimeXPublic,
		archiveSha256: sequence(97, 32),
	};
	const homeKeys = await deriveSandboxTransportKeys(homeX.value, "home", transcript);
	const runtimeKeys = await deriveSandboxTransportKeys(runtimeX.value, "runtime", transcript);
	if (!homeKeys.ok || !runtimeKeys.ok) throw new Error("setup failed");
	const home = createSandboxTransportChannel(homeKeys.value, "home");
	const runtime = createSandboxTransportChannel(runtimeKeys.value, "runtime");
	if (!home.ok || !runtime.ok) throw new Error("setup failed");
	return { home: home.value, runtime: runtime.value };
}

describe("sandbox encrypted activation", () => {
	test("activates once with exact padded messages while the token stays capability-private", async () => {
		const pair = await channels();
		const homeActivation = createSandboxHomeActivation();
		if (!homeActivation.ok) throw new Error("setup failed");
		expect(Object.keys(homeActivation.value)).toEqual([]);
		const frame = await encryptSandboxHomeActivation(pair.home, homeActivation.value);
		expect(frame.ok).toBe(true);
		if (!frame.ok) return;
		expect(frame.value.byteLength).toBe(96);
		const runtimeActivation = await acceptSandboxRuntimeActivation(pair.runtime, frame.value);
		expect(runtimeActivation.ok).toBe(true);
		if (!runtimeActivation.ok) return;
		expect(Object.keys(runtimeActivation.value.activation)).toEqual([]);
		expect(runtimeActivation.value.ackFrame.byteLength).toBe(96);
		expect(
			await confirmSandboxHomeActivation(pair.home, homeActivation.value, runtimeActivation.value.ackFrame),
		).toEqual({ ok: true, value: true });
		expect(closeSandboxHomeActivation(homeActivation.value)).toBe(false);
		expect(closeSandboxRuntimeActivation(runtimeActivation.value.activation)).toBe(true);
		expect(closeSandboxRuntimeActivation(runtimeActivation.value.activation)).toBe(false);
	});

	test("rejects wrong tag, stream, padding, and token hash and closes the channel", async () => {
		const invalidMessages: ReadonlyArray<readonly [bigint, number]> = [
			[0n, 0],
			[1n, -1],
			[0n, 47],
		];
		for (const [streamId, changedIndex] of invalidMessages) {
			const pair = await channels();
			const plaintext = new Uint8Array(48);
			plaintext[0] = 0x01;
			plaintext.set(sequence(1, 32), 1);
			if (changedIndex >= 0) plaintext[changedIndex] ^= 1;
			const frame = await encryptSandboxTransportFrame(pair.home, streamId, plaintext);
			if (!frame.ok) throw new Error("setup failed");
			expect(await acceptSandboxRuntimeActivation(pair.runtime, frame.value)).toEqual({
				ok: false,
				code: "PROTOCOL_ERROR",
			});
			expect(await encryptSandboxTransportFrame(pair.runtime, 0n, new Uint8Array(1))).toEqual({
				ok: false,
				code: "CAPABILITY_INVALID",
			});
		}

		const pair = await channels();
		const activation = createSandboxHomeActivation();
		if (!activation.ok) throw new Error("setup failed");
		const sent = await encryptSandboxHomeActivation(pair.home, activation.value);
		if (!sent.ok) throw new Error("setup failed");
		const received = await decryptSandboxTransportFrame(pair.runtime, sent.value);
		if (!received.ok) throw new Error("setup failed");
		const falseAck = new Uint8Array(48);
		falseAck[0] = 0x02;
		falseAck.set(sequence(0, 32), 1);
		const falseAckFrame = await encryptSandboxTransportFrame(pair.runtime, 0n, falseAck);
		if (!falseAckFrame.ok) throw new Error("setup failed");
		expect(await confirmSandboxHomeActivation(pair.home, activation.value, falseAckFrame.value)).toEqual({
			ok: false,
			code: "PROTOCOL_ERROR",
		});
		expect(await encryptSandboxTransportFrame(pair.home, 0n, new Uint8Array(1))).toEqual({
			ok: false,
			code: "CAPABILITY_INVALID",
		});
	});

	test("keeps activation authorities unforgeable and one-shot", async () => {
		expect(() => new SandboxHomeActivation({})).toThrow();
		expect(() => new SandboxRuntimeActivation({})).toThrow();
		expect(closeSandboxHomeActivation(Object.freeze({}))).toBe(false);
		expect(closeSandboxRuntimeActivation(Object.freeze({}))).toBe(false);
		const pair = await channels();
		const activation = createSandboxHomeActivation();
		if (!activation.ok) throw new Error("setup failed");
		expect((await encryptSandboxHomeActivation(pair.home, activation.value)).ok).toBe(true);
		expect(await encryptSandboxHomeActivation(pair.home, activation.value)).toEqual({
			ok: false,
			code: "CAPABILITY_INVALID",
		});
	});

	test("allows exactly one overlapping activation send and preserves its confirmation state", async () => {
		const pair = await channels();
		const activation = createSandboxHomeActivation();
		if (!activation.ok) throw new Error("setup failed");
		const results = await Promise.all([
			encryptSandboxHomeActivation(pair.home, activation.value),
			encryptSandboxHomeActivation(pair.home, activation.value),
		]);
		const sent = results.filter((result) => result.ok);
		const rejected = results.filter((result) => !result.ok);
		expect(sent).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		const frame = sent[0];
		if (frame === undefined || !frame.ok) return;
		const accepted = await acceptSandboxRuntimeActivation(pair.runtime, frame.value);
		if (!accepted.ok) throw new Error("activation failed");
		expect(await confirmSandboxHomeActivation(pair.home, activation.value, accepted.value.ackFrame)).toEqual({
			ok: true,
			value: true,
		});
		closeSandboxRuntimeActivation(accepted.value.activation);
	});

	test("rejects non-capability close arguments", () => {
		for (const value of [null, undefined, 42, "value", [], {}]) {
			expect(closeSandboxHomeActivation(value)).toBe(false);
			expect(closeSandboxRuntimeActivation(value)).toBe(false);
		}
	});
});
