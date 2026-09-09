import { describe, expect, test } from "bun:test";
import {
	buildSandboxReadinessBundle,
	closeSandboxReadinessBundle,
	copyReadinessArchiveSha256,
	copyReadinessHomePublicKey,
	copyReadinessLauncherPublicKey,
	copyReadinessLauncherSha256,
	copyReadinessManifestSha256,
	copyReadinessProtocolNonce,
	copyReadinessSignature,
	decodeSandboxReadinessBundle,
	SandboxReadinessBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-readiness-bundle.js";

const PYTHON_FIXTURE =
	"BUNDLE v3 AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8= QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8= YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8= gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8= oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8= wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w==\n";

function sequence(start: number, length: number): Uint8Array<ArrayBuffer> {
	const value = new Uint8Array(new ArrayBuffer(length));
	for (let index = 0; index < length; index += 1) value[index] = (start + index) & 0xff;
	return value;
}

function validFields(): object {
	return {
		launcherPublicKey: sequence(0x00, 32),
		homePublicKey: sequence(0x20, 32),
		archiveSha256: sequence(0x40, 32),
		manifestSha256: sequence(0x60, 32),
		launcherSha256: sequence(0x80, 32),
		protocolNonce: sequence(0xa0, 32),
		signature: sequence(0xc0, 64),
	};
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
	const encoded = new TextEncoder().encode(value);
	const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
	copy.set(encoded);
	return copy;
}

describe("sandbox readiness bundle", () => {
	test("builder exactly matches the Python fixture", () => {
		const result = buildSandboxReadinessBundle(validFields());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(new TextDecoder().decode(result.bytes)).toBe(PYTHON_FIXTURE);
		expect(result.bytes.byteLength).toBe(369);
	});

	test("builder accepts exact fields in another insertion order", () => {
		const fields = validFields();
		const first = Object.getOwnPropertyDescriptor(fields, "launcherPublicKey")?.value;
		const second = Object.getOwnPropertyDescriptor(fields, "homePublicKey")?.value;
		const third = Object.getOwnPropertyDescriptor(fields, "archiveSha256")?.value;
		const fourth = Object.getOwnPropertyDescriptor(fields, "manifestSha256")?.value;
		const fifth = Object.getOwnPropertyDescriptor(fields, "launcherSha256")?.value;
		const sixth = Object.getOwnPropertyDescriptor(fields, "protocolNonce")?.value;
		const seventh = Object.getOwnPropertyDescriptor(fields, "signature")?.value;
		const reordered = {
			signature: seventh,
			protocolNonce: sixth,
			archiveSha256: third,
			launcherPublicKey: first,
			launcherSha256: fifth,
			homePublicKey: second,
			manifestSha256: fourth,
		};
		expect(buildSandboxReadinessBundle(reordered).ok).toBe(true);
	});

	test("decoder accepts the fixture and isolates input and output copies", () => {
		const input = bytes(PYTHON_FIXTURE);
		const result = decodeSandboxReadinessBundle(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		input.fill(0);
		const launcher = copyReadinessLauncherPublicKey(result.readiness);
		expect(launcher).toEqual(sequence(0, 32));
		launcher?.fill(0);
		expect(copyReadinessLauncherPublicKey(result.readiness)).toEqual(sequence(0, 32));
		expect(copyReadinessHomePublicKey(result.readiness)).toEqual(sequence(0x20, 32));
		expect(copyReadinessArchiveSha256(result.readiness)).toEqual(sequence(0x40, 32));
		expect(copyReadinessManifestSha256(result.readiness)).toEqual(sequence(0x60, 32));
		expect(copyReadinessLauncherSha256(result.readiness)).toEqual(sequence(0x80, 32));
		expect(copyReadinessProtocolNonce(result.readiness)).toEqual(sequence(0xa0, 32));
		expect(copyReadinessSignature(result.readiness)).toEqual(sequence(0xc0, 64));
	});

	test("decoder accepts exact ArrayBuffer", () => {
		const input = bytes(PYTHON_FIXTURE);
		const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
		expect(decodeSandboxReadinessBundle(buffer).ok).toBe(true);
	});

	test("rejects missing, duplicate, or nonterminal newlines and trailing data", () => {
		expect(decodeSandboxReadinessBundle(bytes(PYTHON_FIXTURE.slice(0, -1))).ok).toBe(false);
		expect(decodeSandboxReadinessBundle(bytes(`${PYTHON_FIXTURE}\n`)).ok).toBe(false);
		expect(decodeSandboxReadinessBundle(bytes(PYTHON_FIXTURE.replace(" v3 ", "\n v3 "))).ok).toBe(false);
		expect(decodeSandboxReadinessBundle(bytes(`${PYTHON_FIXTURE}x`)).ok).toBe(false);
	});

	test("rejects noncanonical base64 unused bits", () => {
		const invalid = PYTHON_FIXTURE.replace("GBkaGxwdHh8=", "GBkaGxwdHh9=");
		expect(decodeSandboxReadinessBundle(bytes(invalid)).ok).toBe(false);
	});

	test("rejects wrong prefix, version, part count, and field length", () => {
		expect(decodeSandboxReadinessBundle(bytes(PYTHON_FIXTURE.replace("BUNDLE", "READY!"))).ok).toBe(false);
		expect(decodeSandboxReadinessBundle(bytes(PYTHON_FIXTURE.replace(" v3 ", " v2 "))).ok).toBe(false);
		expect(decodeSandboxReadinessBundle(bytes(PYTHON_FIXTURE.replace(" ICEi", "  ICEi"))).ok).toBe(false);
		expect(decodeSandboxReadinessBundle(bytes(PYTHON_FIXTURE.replace("AAECA", "AECA"))).ok).toBe(false);
	});

	test("builder rejects wrong shapes without invoking accessors or proxy traps", () => {
		expect(buildSandboxReadinessBundle({ ...validFields(), extra: sequence(0, 1) }).ok).toBe(false);
		const missing = validFields();
		Reflect.deleteProperty(missing, "signature");
		expect(buildSandboxReadinessBundle(missing).ok).toBe(false);
		const symbol = validFields();
		Object.defineProperty(symbol, Symbol("hidden"), { value: true, enumerable: true });
		expect(buildSandboxReadinessBundle(symbol).ok).toBe(false);
		let getterReads = 0;
		const accessor = validFields();
		Object.defineProperty(accessor, "signature", {
			get() {
				getterReads += 1;
				return sequence(0, 64);
			},
			enumerable: true,
		});
		expect(buildSandboxReadinessBundle(accessor).ok).toBe(false);
		expect(getterReads).toBe(0);
		let traps = 0;
		const proxy = new Proxy(validFields(), {
			ownKeys() {
				traps += 1;
				return [];
			},
		});
		expect(buildSandboxReadinessBundle(proxy).ok).toBe(false);
		expect(traps).toBe(0);
	});

	test("builder rejects class, null prototype, Buffer, subclass, SharedArrayBuffer, and wrong lengths", () => {
		class Fields {
			launcherPublicKey = sequence(0, 32);
			homePublicKey = sequence(0x20, 32);
			archiveSha256 = sequence(0x40, 32);
			manifestSha256 = sequence(0x60, 32);
			launcherSha256 = sequence(0x80, 32);
			protocolNonce = sequence(0xa0, 32);
			signature = sequence(0xc0, 64);
		}
		expect(buildSandboxReadinessBundle(new Fields()).ok).toBe(false);
		const nullPrototype = Object.create(null);
		Object.assign(nullPrototype, validFields());
		expect(buildSandboxReadinessBundle(nullPrototype).ok).toBe(false);
		expect(buildSandboxReadinessBundle({ ...validFields(), launcherPublicKey: Buffer.alloc(32) }).ok).toBe(false);
		class Bytes extends Uint8Array {}
		expect(buildSandboxReadinessBundle({ ...validFields(), launcherPublicKey: new Bytes(32) }).ok).toBe(false);
		expect(buildSandboxReadinessBundle({ ...validFields(), launcherPublicKey: sequence(0, 31) }).ok).toBe(false);
		if (typeof SharedArrayBuffer !== "undefined") {
			expect(
				buildSandboxReadinessBundle({
					...validFields(),
					launcherPublicKey: new Uint8Array(new SharedArrayBuffer(32)),
				}).ok,
			).toBe(false);
		}
	});

	test("decoder rejects proxy, Buffer, subclass, SharedArrayBuffer, detached, and oversized input", () => {
		expect(decodeSandboxReadinessBundle(new Proxy(bytes(PYTHON_FIXTURE), {})).ok).toBe(false);
		expect(decodeSandboxReadinessBundle(Buffer.from(PYTHON_FIXTURE)).ok).toBe(false);
		class Bytes extends Uint8Array {}
		expect(decodeSandboxReadinessBundle(new Bytes(bytes(PYTHON_FIXTURE))).ok).toBe(false);
		if (typeof SharedArrayBuffer !== "undefined") {
			expect(decodeSandboxReadinessBundle(new SharedArrayBuffer(64)).ok).toBe(false);
		}
		const buffer = bytes(PYTHON_FIXTURE).buffer;
		structuredClone(buffer, { transfer: [buffer] });
		expect(decodeSandboxReadinessBundle(buffer).ok).toBe(false);
		const oversized = decodeSandboxReadinessBundle(new Uint8Array(513));
		expect(oversized.ok).toBe(false);
		if (!oversized.ok) expect(oversized.code).toBe("INPUT_TOO_LARGE");
	});

	test("rejects resizable buffers even when the flag is shadowed", () => {
		const source = bytes(PYTHON_FIXTURE);
		const buffer: unknown = Reflect.construct(ArrayBuffer, [
			source.byteLength,
			{ maxByteLength: source.byteLength + 32 },
		]);
		if (!(buffer instanceof ArrayBuffer)) throw new Error("setup failed");
		new Uint8Array(buffer).set(source);
		expect(decodeSandboxReadinessBundle(buffer).ok).toBe(false);
		Object.defineProperty(buffer, "resizable", { value: false });
		expect(decodeSandboxReadinessBundle(buffer).ok).toBe(false);
	});

	test("capability cannot be forged and builder isolates output", () => {
		expect(() => new SandboxReadinessBundle(Object.freeze({}))).toThrow();
		expect(copyReadinessSignature(Object.create(SandboxReadinessBundle.prototype))).toBeUndefined();
		const fields = validFields();
		const result = buildSandboxReadinessBundle(fields);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const signature = Object.getOwnPropertyDescriptor(fields, "signature")?.value;
		if (signature instanceof Uint8Array) signature.fill(0);
		expect(new TextDecoder().decode(result.bytes)).toBe(PYTHON_FIXTURE);
	});
});

test("closes decoded readiness capabilities", () => {
	const decoded = decodeSandboxReadinessBundle(new TextEncoder().encode(PYTHON_FIXTURE));
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) return;
	expect(closeSandboxReadinessBundle(decoded.readiness)).toBe(true);
	expect(copyReadinessLauncherPublicKey(decoded.readiness)).toBeUndefined();
	expect(closeSandboxReadinessBundle(decoded.readiness)).toBe(false);
});
