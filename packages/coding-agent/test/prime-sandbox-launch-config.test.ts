import { describe, expect, test } from "bun:test";
import {
	buildSandboxLaunchConfig,
	closeSandboxLaunchConfig,
	copyLaunchConfigArchiveSha256,
	copyLaunchConfigHomePublicKey,
	copyLaunchConfigLauncherSha256,
	copyLaunchConfigManifestSha256,
	decodeSandboxLaunchConfig,
	SandboxLaunchConfig,
} from "../src/modes/daemon/sandbox/prime-sandbox-launch-config.js";

const HOME_KEY = "ArZdi1Kw+TqTeBO4iPjjiTc+ilNPppsFG9YsubtBf1I=";
const ARCHIVE = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MANIFEST = "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a";
const LAUNCHER = "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b";
const PYTHON_FIXTURE = `{"protocol":"prime-sandbox-v3","homePublicKey":"${HOME_KEY}","archiveSha256":"${ARCHIVE}","manifestSha256":"${MANIFEST}","launcherSha256":"${LAUNCHER}"}`;

function validSource(): object {
	return {
		protocol: "prime-sandbox-v3",
		homePublicKey: HOME_KEY,
		archiveSha256: ARCHIVE,
		manifestSha256: MANIFEST,
		launcherSha256: LAUNCHER,
	};
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
	const encoded = new TextEncoder().encode(value);
	const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
	copy.set(encoded);
	return copy;
}

describe("sandbox launch config", () => {
	test("builder exactly matches the Python producer fixture", () => {
		const result = buildSandboxLaunchConfig(validSource());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(new TextDecoder().decode(result.bytes)).toBe(PYTHON_FIXTURE);
	});

	test("builder accepts exact keys in a different insertion order", () => {
		const result = buildSandboxLaunchConfig({
			launcherSha256: LAUNCHER,
			archiveSha256: ARCHIVE,
			protocol: "prime-sandbox-v3",
			manifestSha256: MANIFEST,
			homePublicKey: HOME_KEY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(new TextDecoder().decode(result.bytes)).toBe(PYTHON_FIXTURE);
	});

	test("decoder accepts the literal Python fixture and isolates copies", () => {
		const input = bytes(PYTHON_FIXTURE);
		const result = decodeSandboxLaunchConfig(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		input.fill(0);
		const home = copyLaunchConfigHomePublicKey(result.config);
		expect(home).toBeDefined();
		if (home === undefined) return;
		expect(Buffer.from(home).toString("base64")).toBe(HOME_KEY);
		home.fill(0);
		expect(Buffer.from(copyLaunchConfigHomePublicKey(result.config) ?? []).toString("base64")).toBe(HOME_KEY);
		expect(Buffer.from(copyLaunchConfigArchiveSha256(result.config) ?? []).toString("hex")).toBe(ARCHIVE);
		expect(Buffer.from(copyLaunchConfigManifestSha256(result.config) ?? []).toString("hex")).toBe(MANIFEST);
		expect(Buffer.from(copyLaunchConfigLauncherSha256(result.config) ?? []).toString("hex")).toBe(LAUNCHER);
	});

	test("decoder accepts an exact ArrayBuffer", () => {
		const input = bytes(PYTHON_FIXTURE);
		const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
		expect(decodeSandboxLaunchConfig(buffer).ok).toBe(true);
	});

	test("rejects duplicate keys, different order, and whitespace", () => {
		const duplicate = PYTHON_FIXTURE.replace(
			'{"protocol":"prime-sandbox-v3",',
			'{"protocol":"prime-sandbox-v3","protocol":"prime-sandbox-v3",',
		);
		const reordered = `{"homePublicKey":"${HOME_KEY}","protocol":"prime-sandbox-v3","archiveSha256":"${ARCHIVE}","manifestSha256":"${MANIFEST}","launcherSha256":"${LAUNCHER}"}`;
		expect(decodeSandboxLaunchConfig(bytes(duplicate)).ok).toBe(false);
		expect(decodeSandboxLaunchConfig(bytes(reordered)).ok).toBe(false);
		expect(decodeSandboxLaunchConfig(bytes(` ${PYTHON_FIXTURE}`)).ok).toBe(false);
		expect(
			decodeSandboxLaunchConfig(
				bytes(`${PYTHON_FIXTURE}
`),
			).ok,
		).toBe(false);
	});

	test("rejects noncanonical base64 unused bits", () => {
		const zeroKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
		const invalidKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=";
		expect(buildSandboxLaunchConfig({ ...validSource(), homePublicKey: zeroKey }).ok).toBe(true);
		expect(buildSandboxLaunchConfig({ ...validSource(), homePublicKey: invalidKey }).ok).toBe(false);
	});

	test("rejects unknown, missing, symbol, accessor, class, and null-prototype inputs", () => {
		expect(buildSandboxLaunchConfig({ ...validSource(), extra: "x" }).ok).toBe(false);
		const missing = {
			protocol: "prime-sandbox-v3",
			homePublicKey: HOME_KEY,
			archiveSha256: ARCHIVE,
			manifestSha256: MANIFEST,
		};
		expect(buildSandboxLaunchConfig(missing).ok).toBe(false);
		const symbol = validSource();
		Object.defineProperty(symbol, Symbol("hidden"), { value: true, enumerable: true });
		expect(buildSandboxLaunchConfig(symbol).ok).toBe(false);
		let getterReads = 0;
		const accessor = validSource();
		Object.defineProperty(accessor, "protocol", {
			get() {
				getterReads += 1;
				return "prime-sandbox-v3";
			},
			enumerable: true,
		});
		expect(buildSandboxLaunchConfig(accessor).ok).toBe(false);
		expect(getterReads).toBe(0);
		class Config {
			protocol = "prime-sandbox-v3";
			homePublicKey = HOME_KEY;
			archiveSha256 = ARCHIVE;
			manifestSha256 = MANIFEST;
			launcherSha256 = LAUNCHER;
		}
		expect(buildSandboxLaunchConfig(new Config()).ok).toBe(false);
		const nullPrototype = Object.create(null);
		Object.assign(nullPrototype, validSource());
		expect(buildSandboxLaunchConfig(nullPrototype).ok).toBe(false);
	});

	test("rejects proxies without invoking traps", () => {
		let traps = 0;
		const proxy = new Proxy(validSource(), {
			ownKeys() {
				traps += 1;
				return [];
			},
		});
		expect(buildSandboxLaunchConfig(proxy).ok).toBe(false);
		expect(traps).toBe(0);
		expect(decodeSandboxLaunchConfig(new Proxy(bytes(PYTHON_FIXTURE), {})).ok).toBe(false);
	});

	test("rejects Buffer, typed-array subclasses, SharedArrayBuffer, empty, and oversized input", () => {
		expect(decodeSandboxLaunchConfig(Buffer.from(PYTHON_FIXTURE)).ok).toBe(false);
		class Bytes extends Uint8Array {}
		expect(decodeSandboxLaunchConfig(new Bytes(bytes(PYTHON_FIXTURE))).ok).toBe(false);
		if (typeof SharedArrayBuffer !== "undefined") {
			expect(decodeSandboxLaunchConfig(new SharedArrayBuffer(64)).ok).toBe(false);
		}
		expect(decodeSandboxLaunchConfig(new Uint8Array(0)).ok).toBe(false);
		const oversized = decodeSandboxLaunchConfig(new Uint8Array(1025));
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
		expect(decodeSandboxLaunchConfig(buffer).ok).toBe(false);
		Object.defineProperty(buffer, "resizable", { value: false });
		expect(decodeSandboxLaunchConfig(buffer).ok).toBe(false);
	});

	test("rejects detached input", () => {
		const buffer = bytes(PYTHON_FIXTURE).buffer;
		structuredClone(buffer, { transfer: [buffer] });
		expect(decodeSandboxLaunchConfig(buffer).ok).toBe(false);
	});

	test("capability cannot be forged and build output is isolated", () => {
		expect(() => new SandboxLaunchConfig(Object.freeze({}))).toThrow();
		expect(copyLaunchConfigHomePublicKey(Object.create(SandboxLaunchConfig.prototype))).toBeUndefined();
		const first = buildSandboxLaunchConfig(validSource());
		const second = buildSandboxLaunchConfig(validSource());
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		first.bytes.fill(0);
		expect(new TextDecoder().decode(second.bytes)).toBe(PYTHON_FIXTURE);
	});
});

test("closes decoded launch config capabilities", () => {
	const decoded = decodeSandboxLaunchConfig(new TextEncoder().encode(PYTHON_FIXTURE));
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) return;
	expect(closeSandboxLaunchConfig(decoded.config)).toBe(true);
	expect(copyLaunchConfigHomePublicKey(decoded.config)).toBeUndefined();
	expect(closeSandboxLaunchConfig(decoded.config)).toBe(false);
});
