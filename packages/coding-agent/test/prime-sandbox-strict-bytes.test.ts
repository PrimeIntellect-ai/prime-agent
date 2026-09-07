import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { copySandboxStrictBytes } from "../src/modes/daemon/sandbox/prime-sandbox-strict-bytes.js";

describe("sandbox strict byte copying", () => {
	it("copies a full fixed Uint8Array into caller-owned storage", () => {
		const source = new Uint8Array([1, 2, 255]);
		const result = copySandboxStrictBytes(source, 3);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Array.from(result.value)).toEqual([1, 2, 255]);
		expect(result.value).not.toBe(source);
		expect(result.value.buffer).not.toBe(source.buffer);
		source[0] = 9;
		expect(result.value[0]).toBe(1);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.value)).toBe(false);
	});

	it("accepts an empty fixed Uint8Array", () => {
		const result = copySandboxStrictBytes(new Uint8Array(0), 0);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.byteLength).toBe(0);
	});

	it("rejects non-objects and invalid limits", () => {
		for (const value of [null, undefined, true, 1, "bytes", {}, []]) {
			expect(copySandboxStrictBytes(value, 16)).toEqual({ ok: false, code: "INPUT_INVALID" });
		}
		expect(copySandboxStrictBytes(new Uint8Array(0), -1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(copySandboxStrictBytes(new Uint8Array(0), 0.5)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(copySandboxStrictBytes(new Uint8Array(0), 1_048_577)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
	});

	it("enforces the byte bound before copying", () => {
		expect(copySandboxStrictBytes(new Uint8Array(2), 1)).toEqual({ ok: false, code: "INPUT_TOO_LARGE" });
	});

	it("rejects sliced and nonzero-offset views", () => {
		const storage = new ArrayBuffer(8);
		expect(copySandboxStrictBytes(new Uint8Array(storage, 0, 4), 8)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(copySandboxStrictBytes(new Uint8Array(storage, 1, 7), 8)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
	});

	it("rejects shared and resizable backing storage", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(4));
		expect(copySandboxStrictBytes(shared, 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const resizable: unknown = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]);
		const resizableView: unknown = Reflect.construct(Uint8Array, [resizable]);
		expect(copySandboxStrictBytes(resizableView, 8)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects detached storage including a zero-length view", () => {
		for (const length of [0, 4]) {
			const storage = new ArrayBuffer(length);
			const view = new Uint8Array(storage);
			structuredClone(storage, { transfer: [storage] });
			expect(copySandboxStrictBytes(view, 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
		}
	});

	it("rejects proxy and revoked-proxy values before reflection", () => {
		let prototypeTrapCalls = 0;
		const proxy = new Proxy(new Uint8Array([1]), {
			getPrototypeOf(target): object | null {
				prototypeTrapCalls += 1;
				return Reflect.getPrototypeOf(target);
			},
		});
		expect(copySandboxStrictBytes(proxy, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(prototypeTrapCalls).toBe(0);
		const revoked = Proxy.revocable(new Uint8Array([1]), {});
		revoked.revoke();
		expect(copySandboxStrictBytes(revoked.proxy, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects fake and alternate typed-array prototypes", () => {
		const fake = Object.create(Uint8Array.prototype);
		expect(copySandboxStrictBytes(fake, 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(copySandboxStrictBytes(new Uint16Array([1]), 4)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects own fields and symbols on the view", () => {
		const named = new Uint8Array([1]);
		Object.defineProperty(named, "length", { value: 1, enumerable: false, configurable: true });
		expect(copySandboxStrictBytes(named, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const accessor = new Uint8Array([1]);
		Object.defineProperty(accessor, "extra", { get: () => 1, enumerable: true, configurable: true });
		expect(copySandboxStrictBytes(accessor, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const symbolic = new Uint8Array([1]);
		Object.defineProperty(symbolic, Symbol("extra"), { value: 1, enumerable: true, configurable: true });
		expect(copySandboxStrictBytes(symbolic, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects shadow fields on the backing ArrayBuffer", () => {
		for (const name of ["byteLength", "detached", "resizable", "extra"]) {
			const storage = new ArrayBuffer(1);
			const view = new Uint8Array(storage);
			Object.defineProperty(storage, name, { value: 1, enumerable: true, configurable: true });
			expect(copySandboxStrictBytes(view, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
		}
		const symbolStorage = new ArrayBuffer(1);
		const symbolView = new Uint8Array(symbolStorage);
		Object.defineProperty(symbolStorage, Symbol("extra"), { value: 1, configurable: true });
		expect(copySandboxStrictBytes(symbolView, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("requires Bun's exact typed-array index descriptor flags", () => {
		const view = new Uint8Array([1]);
		const descriptor = Object.getOwnPropertyDescriptor(view, "0");
		expect(descriptor).toEqual({ value: 1, writable: true, enumerable: true, configurable: true });
		const fake = Object.create(Uint8Array.prototype);
		Object.defineProperty(fake, "0", { value: 1, writable: true, enumerable: true, configurable: false });
		expect(copySandboxStrictBytes(fake, 1)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("copies a non-empty exact-maximum input into authentic fresh storage", () => {
		const size = 1_048_576;
		const source = new Uint8Array(size);
		for (let index = 0; index < size; index += 1) source[index] = (index * 31 + 7) & 0xff;

		const result = copySandboxStrictBytes(source, size);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.byteLength).toBe(size);
		expect(Object.getPrototypeOf(result.value)).toBe(Uint8Array.prototype);
		expect(Object.getPrototypeOf(result.value.buffer)).toBe(ArrayBuffer.prototype);
		expect(result.value).not.toBe(source);
		expect(result.value.buffer).not.toBe(source.buffer);
		let mismatch = -1;
		for (let index = 0; index < size; index += 1) {
			if (result.value[index] !== source[index]) {
				mismatch = index;
				break;
			}
		}
		expect(mismatch).toBe(-1);
		source[0] = 255;
		source[size - 1] = 0;
		expect(result.value[0]).toBe(7);
		expect(result.value[size - 1]).toBe(232);
	});

	it("uses only captured intrinsics after module initialization", () => {
		const script = `import { types } from "node:util";
const NativeObject = globalThis.Object;
const NativeReflect = globalThis.Reflect;
const nativeApply = NativeReflect.apply;
const nativeDefineProperty = NativeObject.defineProperty;
const nativeGetOwnPropertyDescriptor = NativeObject.getOwnPropertyDescriptor;
const nativeGetPrototypeOf = NativeObject.getPrototypeOf;
const nativeIsFrozen = NativeObject.isFrozen;
const NativeBytes = globalThis.Uint8Array;
const NativeArrayBuffer = globalThis.ArrayBuffer;
const NativeNumber = globalThis.Number;
const NativeString = globalThis.String;
const nativeBytesPrototype = NativeBytes.prototype;
const nativeArrayBufferPrototype = NativeArrayBuffer.prototype;
const nativeTypedArrayPrototype = nativeApply(nativeGetPrototypeOf, NativeObject, [nativeBytesPrototype]);
const globalBytesDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "Uint8Array"]);
const globalArrayBufferDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "ArrayBuffer"]);
const globalNumberDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "Number"]);
const globalStringDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "String"]);
const reflectApplyDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeReflect, "apply"]);
const objectFreezeDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "freeze"]);
const objectGetPrototypeDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "getPrototypeOf"]);
const objectGetDescriptorDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "getOwnPropertyDescriptor"]);
const objectGetNamesDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "getOwnPropertyNames"]);
const objectGetSymbolsDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "getOwnPropertySymbols"]);
const numberSafeDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeNumber, "isSafeInteger"]);
const numberIntegerDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeNumber, "isInteger"]);
const typedBufferDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeTypedArrayPrototype, "buffer"]);
const typedOffsetDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeTypedArrayPrototype, "byteOffset"]);
const typedByteLengthDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeTypedArrayPrototype, "byteLength"]);
const typedLengthDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeTypedArrayPrototype, "length"]);
const typedFillDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeTypedArrayPrototype, "fill"]);
const bufferByteLengthDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeArrayBufferPrototype, "byteLength"]);
const bufferDetachedDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeArrayBufferPrototype, "detached"]);
const bufferResizableDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeArrayBufferPrototype, "resizable"]);
const proxyCheckDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [types, "isProxy"]);
const source = new NativeBytes([7, 8, 255]);
const empty = new NativeBytes(0);
const hostileProxy = new Proxy(source, {});
const hostileFake = NativeObject.create(nativeBytesPrototype);
const codec = await import("./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-strict-bytes.ts?captured-intrinsics");
function poison() { return undefined; }
function poisonString() { return "hostile"; }
function poisonGetter() { return undefined; }
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "Uint8Array", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "ArrayBuffer", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "Number", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "String", { value: poisonString, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeReflect, "apply", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "freeze", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getPrototypeOf", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyDescriptor", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyNames", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertySymbols", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeNumber, "isSafeInteger", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeNumber, "isInteger", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "buffer", { get: poisonGetter, configurable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "byteOffset", { get: poisonGetter, configurable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "byteLength", { get: poisonGetter, configurable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "length", { get: poisonGetter, configurable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "fill", { value: poison, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeArrayBufferPrototype, "byteLength", { get: poisonGetter, configurable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeArrayBufferPrototype, "detached", { get: poisonGetter, configurable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [nativeArrayBufferPrototype, "resizable", { get: poisonGetter, configurable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [types, "isProxy", { value: poison, configurable: true, writable: true }]);
const copied = codec.copySandboxStrictBytes(source, 3);
const proxyResult = codec.copySandboxStrictBytes(hostileProxy, 3);
const fakeResult = codec.copySandboxStrictBytes(hostileFake, 3);
const exactLimit = codec.copySandboxStrictBytes(empty, 1_048_576);
const excessiveLimit = codec.copySandboxStrictBytes(empty, 1_048_577);
const copiedBuffer = copied.ok ? nativeApply(typedBufferDescriptor.get, copied.value, []) : undefined;
const sourceBuffer = nativeApply(typedBufferDescriptor.get, source, []);
const validCopy = copied.ok && copied.value[0] === 7 && copied.value[1] === 8 && copied.value[2] === 255;
const authenticCopy = copied.ok && nativeApply(nativeGetPrototypeOf, NativeObject, [copied.value]) === nativeBytesPrototype && nativeApply(nativeGetPrototypeOf, NativeObject, [copiedBuffer]) === nativeArrayBufferPrototype;
const freshCopy = copied.ok && copied.value !== source && copiedBuffer !== sourceBuffer && nativeApply(nativeIsFrozen, NativeObject, [copied]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "Uint8Array", globalBytesDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "ArrayBuffer", globalArrayBufferDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "Number", globalNumberDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "String", globalStringDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeReflect, "apply", reflectApplyDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "freeze", objectFreezeDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getPrototypeOf", objectGetPrototypeDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyDescriptor", objectGetDescriptorDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyNames", objectGetNamesDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertySymbols", objectGetSymbolsDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeNumber, "isSafeInteger", numberSafeDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeNumber, "isInteger", numberIntegerDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "buffer", typedBufferDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "byteOffset", typedOffsetDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "byteLength", typedByteLengthDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "length", typedLengthDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "fill", typedFillDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeArrayBufferPrototype, "byteLength", bufferByteLengthDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeArrayBufferPrototype, "detached", bufferDetachedDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeArrayBufferPrototype, "resizable", bufferResizableDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [types, "isProxy", proxyCheckDescriptor]);
process.stdout.write(JSON.stringify({ validCopy, authenticCopy, freshCopy, proxyRejected: !proxyResult.ok, fakeRejected: !fakeResult.ok, exactLimitAccepted: exactLimit.ok, excessiveLimitRejected: !excessiveLimit.ok }));`;
		const repositoryRoot = resolve(import.meta.dirname, "../../..");
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(
			'{"validCopy":true,"authenticCopy":true,"freshCopy":true,"proxyRejected":true,"fakeRejected":true,"exactLimitAccepted":true,"excessiveLimitRejected":true}',
		);
	});

	it("performs one canonical name read and descriptor read per byte", () => {
		const script = `const NativeObject = globalThis.Object;
const NativeReflect = globalThis.Reflect;
const nativeApply = NativeReflect.apply;
const nativeDefineProperty = NativeObject.defineProperty;
const nativeGetOwnPropertyDescriptor = NativeObject.getOwnPropertyDescriptor;
const nativeGetOwnPropertyNames = NativeObject.getOwnPropertyNames;
const NativeBytes = globalThis.Uint8Array;
const objectGetDescriptorDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "getOwnPropertyDescriptor"]);
const objectGetNamesDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "getOwnPropertyNames"]);
const source = new NativeBytes(2_048);
const state = { armed: false, nameReads: 0, descriptorReads: 0 };
function instrumentedDescriptor(target, name) {
 if (state.armed && target === source) state.descriptorReads += 1;
 return nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [target, name]);
}
function instrumentedNames(target) {
 const names = nativeApply(nativeGetOwnPropertyNames, NativeObject, [target]);
 if (!state.armed || target !== source) return names;
 return new Proxy(names, { get(target, name) {
  if (typeof name === "string" && name !== "length") state.nameReads += 1;
  return NativeReflect.get(target, name);
 } });
}
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyDescriptor", { value: instrumentedDescriptor, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyNames", { value: instrumentedNames, configurable: true, writable: true }]);
const codec = await import("./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-strict-bytes.ts?linear-work-bound");
state.armed = true;
const result = codec.copySandboxStrictBytes(source, source.length);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyDescriptor", objectGetDescriptorDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyNames", objectGetNamesDescriptor]);
process.stdout.write(JSON.stringify({ accepted: result.ok, nameReads: state.nameReads, descriptorReads: state.descriptorReads, length: source.length }));`;
		const repositoryRoot = resolve(import.meta.dirname, "../../..");
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe('{"accepted":true,"nameReads":2048,"descriptorReads":2048,"length":2048}');
	});

	it("zeros a non-returned allocation after a late descriptor failure", () => {
		const script = `const NativeObject = globalThis.Object;
const NativeReflect = globalThis.Reflect;
const nativeApply = NativeReflect.apply;
const nativeDefineProperty = NativeObject.defineProperty;
const nativeGetOwnPropertyDescriptor = NativeObject.getOwnPropertyDescriptor;
const nativeGetPrototypeOf = NativeObject.getPrototypeOf;
const NativeBytes = globalThis.Uint8Array;
const nativeBytesPrototype = NativeBytes.prototype;
const nativeTypedArrayPrototype = nativeApply(nativeGetPrototypeOf, NativeObject, [nativeBytesPrototype]);
const globalBytesDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [globalThis, "Uint8Array"]);
const objectDescriptorDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [NativeObject, "getOwnPropertyDescriptor"]);
const typedFillDescriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [nativeTypedArrayPrototype, "fill"]);
const allocations = [];
const state = { armed: false };
const source = new NativeBytes([7, 8, 9]);
function TrackedBytes(length) {
 const value = new NativeBytes(length);
 allocations.push(value);
 return value;
}
function instrumentedDescriptor(target, name) {
 const descriptor = nativeApply(nativeGetOwnPropertyDescriptor, NativeObject, [target, name]);
 if (state.armed && target === source && name === "2") return { value: 999, writable: true, enumerable: true, configurable: true };
 return descriptor;
}
function poisonFill() { return undefined; }
nativeApply(nativeDefineProperty, NativeObject, [TrackedBytes, "prototype", { value: nativeBytesPrototype }]);
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "Uint8Array", { value: TrackedBytes, configurable: true, writable: true }]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyDescriptor", { value: instrumentedDescriptor, configurable: true, writable: true }]);
const codec = await import("./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-strict-bytes.ts?late-failure-cleanup");
state.armed = true;
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "fill", { value: poisonFill, configurable: true, writable: true }]);
const result = codec.copySandboxStrictBytes(source, 3);
const allocation = allocations[0];
const rejected = !result.ok && result.code === "INPUT_INVALID";
const oneAllocation = allocations.length === 1;
const cleared = allocation !== undefined && allocation[0] === 0 && allocation[1] === 0 && allocation[2] === 0;
nativeApply(nativeDefineProperty, NativeObject, [globalThis, "Uint8Array", globalBytesDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [NativeObject, "getOwnPropertyDescriptor", objectDescriptorDescriptor]);
nativeApply(nativeDefineProperty, NativeObject, [nativeTypedArrayPrototype, "fill", typedFillDescriptor]);
process.stdout.write(JSON.stringify({ rejected, oneAllocation, cleared }));`;
		const repositoryRoot = resolve(import.meta.dirname, "../../..");
		const result = spawnSync(process.execPath, ["-e", script], {
			cwd: repositoryRoot,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe('{"rejected":true,"oneAllocation":true,"cleared":true}');
	});
});
