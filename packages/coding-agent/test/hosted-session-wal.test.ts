import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	decodeHostedSessionWalRecord,
	encodeHostedSessionWalRecord,
	type HostedSessionWalChainErrorCode,
	verifyHostedSessionWalChain,
} from "../src/modes/daemon/sandbox/hosted-session-wal.js";

const RECORD_SIZE = 320;
const ALLOCATED = 1;
const CREATE_DISPATCHED = 2;
const PRESENT = 3;
const RUNTIME_DISPATCHED = 4;
const RUNNING = 5;
const DELETE_DISPATCHED = 6;
const ABSENT = 7;
const RETIRED_ABSENT = 8;

function digest(value: number): Uint8Array {
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) bytes[index] = value;
	return bytes;
}

function copyBytes(value: Uint8Array): Uint8Array {
	const output = new Uint8Array(value.length);
	for (let index = 0; index < value.length; index += 1) output[index] = value[index];
	return output;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function hex(value: Uint8Array): string {
	const alphabet = "0123456789abcdef";
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		output += alphabet[(value[index] >> 4) & 15];
		output += alphabet[value[index] & 15];
	}
	return output;
}

function mutableInput(overrides: Record<string, unknown>): Record<string, unknown> {
	const input: Record<string, unknown> = {
		state: ALLOCATED,
		terminalStatus: 0,
		terminalCode: 0,
		revision: 1n,
		lifecycleDigest: digest(0x11),
		generationKey: digest(0x22),
		previousRecordDigest: digest(0),
		identityRecordDigest: digest(0x44),
		releaseDigest: digest(0x55),
		manifestDigest: digest(0x66),
		bootstrapDigest: digest(0x77),
		trustDigest: digest(0x88),
		runtimeConfigDigest: digest(0x99),
	};
	const names = Object.keys(overrides);
	for (let index = 0; index < names.length; index += 1) input[names[index]] = overrides[names[index]];
	return input;
}

function recordInput(overrides: Record<string, unknown>): Record<string, unknown> {
	return Object.freeze(mutableInput(overrides));
}

function encoded(overrides: Record<string, unknown>): Uint8Array | undefined {
	const result = encodeHostedSessionWalRecord(recordInput(overrides));
	expect(result.ok).toBe(true);
	if (result.ok === false) return undefined;
	return result.value;
}

function statusForState(state: number): number {
	return state === DELETE_DISPATCHED ? 1 : 0;
}

function codeForState(state: number): number {
	return state === DELETE_DISPATCHED ? 1 : 0;
}

function chainBytes(states: readonly number[]): Uint8Array[] | undefined {
	const records: Uint8Array[] = [];
	let previous = digest(0);
	for (let index = 0; index < states.length; index += 1) {
		const state = states[index];
		const result = encodeHostedSessionWalRecord(
			recordInput({
				state,
				terminalStatus: statusForState(state),
				terminalCode: codeForState(state),
				revision: BigInt(index + 1),
				previousRecordDigest: previous,
			}),
		);
		expect(result.ok).toBe(true);
		if (result.ok === false) return undefined;
		records[records.length] = result.value;
		previous = new Uint8Array(createHash("sha256").update(result.value).digest());
	}
	return records;
}

function frozenChain(states: readonly number[]): readonly Uint8Array[] | undefined {
	const records = chainBytes(states);
	if (records === undefined) return undefined;
	return Object.freeze(records);
}

function expectChainError(chain: unknown, code: HostedSessionWalChainErrorCode): void {
	const result = verifyHostedSessionWalChain(chain);
	expect(result.ok).toBe(false);
	if (result.ok === false) expect(result.errors).toEqual([code]);
}

function frozenPairWithChangedField(name: string, value: Uint8Array): readonly Uint8Array[] | undefined {
	const first = encoded({ state: ALLOCATED });
	if (first === undefined) return undefined;
	const previous = new Uint8Array(createHash("sha256").update(first).digest());
	const second = encoded({
		state: CREATE_DISPATCHED,
		revision: 2n,
		previousRecordDigest: previous,
		[name]: value,
	});
	if (second === undefined) return undefined;
	return Object.freeze([first, second]);
}

const GOLDEN_HEX =
	"5049484f535457414c5631000000000001000000000000000102030405060708" +
	"1111111111111111111111111111111111111111111111111111111111111111" +
	"2222222222222222222222222222222222222222222222222222222222222222" +
	"3333333333333333333333333333333333333333333333333333333333333333" +
	"4444444444444444444444444444444444444444444444444444444444444444" +
	"5555555555555555555555555555555555555555555555555555555555555555" +
	"6666666666666666666666666666666666666666666666666666666666666666" +
	"7777777777777777777777777777777777777777777777777777777777777777" +
	"8888888888888888888888888888888888888888888888888888888888888888" +
	"9999999999999999999999999999999999999999999999999999999999999999";

describe("canonical record", () => {
	it("matches the independent 320-byte vector", () => {
		const result = encodeHostedSessionWalRecord(
			recordInput({
				revision: 0x0102030405060708n,
				lifecycleDigest: digest(0x11),
				generationKey: digest(0x22),
				previousRecordDigest: digest(0x33),
				identityRecordDigest: digest(0x44),
				releaseDigest: digest(0x55),
				manifestDigest: digest(0x66),
				bootstrapDigest: digest(0x77),
				trustDigest: digest(0x88),
				runtimeConfigDigest: digest(0x99),
			}),
		);
		expect(result.ok).toBe(true);
		if (result.ok === false) return;
		expect(result.value.length).toBe(RECORD_SIZE);
		expect(hex(result.value)).toBe(GOLDEN_HEX);
		expect(createHash("sha256").update(result.value).digest("hex")).toBe(
			"9c24927f45a4e579281d2c14984e9070d14c9845ea081e5ff08af238a1eeb60c",
		);
	});

	it("round trips every state", () => {
		for (let state = ALLOCATED; state <= RETIRED_ABSENT; state += 1) {
			const raw = encoded({
				state,
				terminalStatus: statusForState(state),
				terminalCode: codeForState(state),
			});
			if (raw === undefined) return;
			const result = decodeHostedSessionWalRecord(raw);
			expect(result.ok).toBe(true);
			if (result.ok === false) return;
			expect(result.value.state).toBe(state);
			expect(result.value.revision).toBe(1n);
		}
	});

	it("accepts both revision limits", () => {
		const low = encodeHostedSessionWalRecord(recordInput({ revision: 1n }));
		const high = encodeHostedSessionWalRecord(recordInput({ revision: 0xffffffffffffffffn }));
		expect(low.ok).toBe(true);
		expect(high.ok).toBe(true);
		if (high.ok === false) return;
		const decoded = decodeHostedSessionWalRecord(high.value);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.value.revision).toBe(0xffffffffffffffffn);
	});

	it("rejects revisions outside uint64", () => {
		const zero = encodeHostedSessionWalRecord(recordInput({ revision: 0n }));
		const negative = encodeHostedSessionWalRecord(recordInput({ revision: -1n }));
		const overflow = encodeHostedSessionWalRecord(recordInput({ revision: 0x10000000000000000n }));
		const numberValue = encodeHostedSessionWalRecord(recordInput({ revision: 1 }));
		expect(zero).toEqual({ ok: false, code: "REVISION_INVALID" });
		expect(negative).toEqual({ ok: false, code: "REVISION_INVALID" });
		expect(overflow).toEqual({ ok: false, code: "REVISION_INVALID" });
		expect(numberValue).toEqual({ ok: false, code: "REVISION_INVALID" });
	});

	it("accepts every defined terminal pair only on delete dispatch", () => {
		for (let status = 1; status <= 3; status += 1) {
			for (let code = 1; code <= 10; code += 1) {
				const result = encodeHostedSessionWalRecord(
					recordInput({ state: DELETE_DISPATCHED, terminalStatus: status, terminalCode: code }),
				);
				expect(result.ok).toBe(true);
			}
		}
		const zeroStatus = encodeHostedSessionWalRecord(
			recordInput({ state: DELETE_DISPATCHED, terminalStatus: 0, terminalCode: 1 }),
		);
		const zeroCode = encodeHostedSessionWalRecord(
			recordInput({ state: DELETE_DISPATCHED, terminalStatus: 1, terminalCode: 0 }),
		);
		const otherState = encodeHostedSessionWalRecord(
			recordInput({ state: RUNNING, terminalStatus: 1, terminalCode: 1 }),
		);
		expect(zeroStatus).toEqual({ ok: false, code: "TERMINAL_PAIR_INVALID" });
		expect(zeroCode).toEqual({ ok: false, code: "TERMINAL_PAIR_INVALID" });
		expect(otherState).toEqual({ ok: false, code: "TERMINAL_PAIR_INVALID" });
	});
});

describe("exact input boundaries", () => {
	it("rejects non-object, mutable, proxy, wrong prototype, missing, and extra shapes", () => {
		expect(encodeHostedSessionWalRecord(null)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(encodeHostedSessionWalRecord("record")).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(encodeHostedSessionWalRecord(mutableInput({}))).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(encodeHostedSessionWalRecord(new Proxy(recordInput({}), {}))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		const nullPrototype: Record<string, unknown> = Object.create(null);
		const standard = mutableInput({});
		const names = Object.keys(standard);
		for (let index = 0; index < names.length; index += 1) nullPrototype[names[index]] = standard[names[index]];
		expect(encodeHostedSessionWalRecord(Object.freeze(nullPrototype))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		const missing = mutableInput({});
		Reflect.deleteProperty(missing, "trustDigest");
		expect(encodeHostedSessionWalRecord(Object.freeze(missing))).toEqual({ ok: false, code: "INPUT_INVALID" });
		const extra = mutableInput({ extra: 1 });
		expect(encodeHostedSessionWalRecord(Object.freeze(extra))).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects accessor, symbol, and altered descriptor shapes", () => {
		const accessor = mutableInput({});
		Object.defineProperty(accessor, "state", {
			get: () => ALLOCATED,
			enumerable: true,
			configurable: true,
		});
		expect(encodeHostedSessionWalRecord(Object.freeze(accessor))).toEqual({ ok: false, code: "INPUT_INVALID" });
		const symbolInput = mutableInput({});
		Object.defineProperty(symbolInput, Symbol("field"), { value: 1, configurable: true });
		expect(encodeHostedSessionWalRecord(Object.freeze(symbolInput))).toEqual({ ok: false, code: "INPUT_INVALID" });
		const hidden = mutableInput({});
		Object.defineProperty(hidden, "state", { value: ALLOCATED, enumerable: false, configurable: true });
		expect(encodeHostedSessionWalRecord(Object.freeze(hidden))).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("rejects invalid scalar fields and strict byte violations", () => {
		expect(encodeHostedSessionWalRecord(recordInput({ state: 9 }))).toEqual({ ok: false, code: "STATE_INVALID" });
		expect(encodeHostedSessionWalRecord(recordInput({ terminalStatus: 4 }))).toEqual({
			ok: false,
			code: "TERMINAL_STATUS_INVALID",
		});
		expect(encodeHostedSessionWalRecord(recordInput({ terminalCode: 11 }))).toEqual({
			ok: false,
			code: "TERMINAL_CODE_INVALID",
		});
		expect(encodeHostedSessionWalRecord(recordInput({ lifecycleDigest: new Uint8Array(31) }))).toEqual({
			ok: false,
			code: "DIGEST_INVALID",
		});
		expect(encodeHostedSessionWalRecord(recordInput({ lifecycleDigest: new Proxy(digest(1), {}) }))).toEqual({
			ok: false,
			code: "DIGEST_INVALID",
		});
		const offsetView = new Uint8Array(new ArrayBuffer(33), 1, 32);
		expect(encodeHostedSessionWalRecord(recordInput({ lifecycleDigest: offsetView }))).toEqual({
			ok: false,
			code: "DIGEST_INVALID",
		});
	});

	it("does not retain or modify encode inputs", () => {
		const lifecycle = digest(0x2a);
		const input = recordInput({ lifecycleDigest: lifecycle });
		const result = encodeHostedSessionWalRecord(input);
		expect(result.ok).toBe(true);
		if (result.ok === false) return;
		lifecycle[0] = 0xff;
		expect(result.value[32]).toBe(0x2a);
		for (let index = 1; index < lifecycle.length; index += 1) expect(lifecycle[index]).toBe(0x2a);
	});
});

describe("decode validation", () => {
	it("returns exact errors for size and magic", () => {
		expect(decodeHostedSessionWalRecord(null)).toEqual({ ok: false, code: "HOSTILE_INPUT" });
		expect(decodeHostedSessionWalRecord(new Uint8Array(321))).toEqual({ ok: false, code: "TOO_LARGE" });
		expect(decodeHostedSessionWalRecord(new Uint8Array(319))).toEqual({ ok: false, code: "TRUNCATED" });
		const raw = encoded({});
		if (raw === undefined) return;
		for (let index = 0; index < 16; index += 1) {
			const changed = copyBytes(raw);
			changed[index] ^= 1;
			expect(decodeHostedSessionWalRecord(changed)).toEqual({ ok: false, code: "MAGIC_MISMATCH" });
		}
	});

	it("returns exact errors for state, terminal fields, reserved bytes, and revision", () => {
		const raw = encoded({});
		if (raw === undefined) return;
		const state = copyBytes(raw);
		state[16] = 9;
		expect(decodeHostedSessionWalRecord(state)).toEqual({ ok: false, code: "STATE_UNKNOWN" });
		const status = copyBytes(raw);
		status[17] = 4;
		expect(decodeHostedSessionWalRecord(status)).toEqual({ ok: false, code: "TERMINAL_STATUS_UNKNOWN" });
		const code = copyBytes(raw);
		code[18] = 11;
		expect(decodeHostedSessionWalRecord(code)).toEqual({ ok: false, code: "TERMINAL_CODE_UNKNOWN" });
		for (let index = 19; index < 24; index += 1) {
			const reserved = copyBytes(raw);
			reserved[index] = 1;
			expect(decodeHostedSessionWalRecord(reserved)).toEqual({ ok: false, code: "RESERVED_NONZERO" });
		}
		const badPair = copyBytes(raw);
		badPair[17] = 1;
		badPair[18] = 1;
		expect(decodeHostedSessionWalRecord(badPair)).toEqual({ ok: false, code: "TERMINAL_PAIR_INVALID" });
		const zeroRevision = copyBytes(raw);
		for (let index = 24; index < 32; index += 1) zeroRevision[index] = 0;
		expect(decodeHostedSessionWalRecord(zeroRevision)).toEqual({ ok: false, code: "HOSTILE_INPUT" });
	});

	it("returns independent digest buffers and leaves raw input unchanged", () => {
		const raw = encoded({ lifecycleDigest: digest(0x35) });
		if (raw === undefined) return;
		const before = copyBytes(raw);
		const result = decodeHostedSessionWalRecord(raw);
		expect(result.ok).toBe(true);
		if (result.ok === false) return;
		expect(bytesEqual(raw, before)).toBe(true);
		raw[32] = 0xaa;
		expect(result.value.lifecycleDigest[0]).toBe(0x35);
		result.value.lifecycleDigest[1] = 0xbb;
		expect(raw[33]).toBe(0x35);
	});

	it("rejects proxy and nonzero-offset byte views", () => {
		const raw = encoded({});
		if (raw === undefined) return;
		expect(decodeHostedSessionWalRecord(new Proxy(raw, {}))).toEqual({ ok: false, code: "HOSTILE_INPUT" });
		const largerBuffer = new ArrayBuffer(321);
		const larger = new Uint8Array(largerBuffer);
		for (let index = 0; index < raw.length; index += 1) larger[index + 1] = raw[index];
		const offsetView = new Uint8Array(largerBuffer, 1, 320);
		expect(decodeHostedSessionWalRecord(offsetView)).toEqual({ ok: false, code: "HOSTILE_INPUT" });
	});
});

describe("chain rules", () => {
	it("accepts the seven-record lifecycle", () => {
		const chain = frozenChain([
			ALLOCATED,
			CREATE_DISPATCHED,
			PRESENT,
			RUNTIME_DISPATCHED,
			RUNNING,
			DELETE_DISPATCHED,
			ABSENT,
		]);
		if (chain === undefined) return;
		expect(verifyHostedSessionWalChain(chain)).toEqual({ ok: true });
	});

	it("accepts the uncertain-create retirement edge", () => {
		const chain = frozenChain([ALLOCATED, CREATE_DISPATCHED, RETIRED_ABSENT]);
		if (chain === undefined) return;
		expect(verifyHostedSessionWalChain(chain)).toEqual({ ok: true });
	});

	it("rejects noncanonical transitions", () => {
		const fromAllocated = frozenChain([ALLOCATED, PRESENT]);
		const fromPresent = frozenChain([ALLOCATED, CREATE_DISPATCHED, PRESENT, RUNNING]);
		const afterRetired = frozenChain([ALLOCATED, CREATE_DISPATCHED, RETIRED_ABSENT, ALLOCATED]);
		if (fromAllocated === undefined || fromPresent === undefined || afterRetired === undefined) return;
		expectChainError(fromAllocated, "INVALID_TRANSITION");
		expectChainError(fromPresent, "INVALID_TRANSITION");
		expectChainError(afterRetired, "INVALID_TRANSITION");
	});

	it("requires initial allocated revision one with zero previous digest", () => {
		const wrongState = encoded({ state: PRESENT });
		const wrongRevision = encoded({ revision: 2n });
		const wrongPrevious = encoded({ previousRecordDigest: digest(1) });
		if (wrongState === undefined || wrongRevision === undefined || wrongPrevious === undefined) return;
		expectChainError(Object.freeze([wrongState]), "STATE_INVALID");
		expectChainError(Object.freeze([wrongRevision]), "NON_MONOTONIC_REVISION");
		expectChainError(Object.freeze([wrongPrevious]), "PREV_DIGEST_MISMATCH");
	});

	it("detects fork, gap, and prior digest mismatch", () => {
		const first = encoded({});
		if (first === undefined) return;
		const priorDigest = new Uint8Array(createHash("sha256").update(first).digest());
		const fork = encoded({ state: CREATE_DISPATCHED, revision: 1n, previousRecordDigest: priorDigest });
		const gap = encoded({ state: CREATE_DISPATCHED, revision: 3n, previousRecordDigest: priorDigest });
		const mismatch = encoded({ state: CREATE_DISPATCHED, revision: 2n, previousRecordDigest: digest(4) });
		if (fork === undefined || gap === undefined || mismatch === undefined) return;
		expectChainError(Object.freeze([first, fork]), "FORK_DETECTED");
		expectChainError(Object.freeze([first, gap]), "GAP_DETECTED");
		expectChainError(Object.freeze([first, mismatch]), "PREV_DIGEST_MISMATCH");
	});

	it("enforces each constant digest", () => {
		const names = [
			"lifecycleDigest",
			"generationKey",
			"identityRecordDigest",
			"releaseDigest",
			"manifestDigest",
			"bootstrapDigest",
			"trustDigest",
			"runtimeConfigDigest",
		];
		const errors: HostedSessionWalChainErrorCode[] = [
			"LIFECYCLE_DIGEST_CHANGED",
			"GENERATION_DIGEST_CHANGED",
			"IDENTITY_DIGEST_CHANGED",
			"ARTIFACT_DIGEST_CHANGED",
			"ARTIFACT_DIGEST_CHANGED",
			"ARTIFACT_DIGEST_CHANGED",
			"CONFIG_DIGEST_CHANGED",
			"CONFIG_DIGEST_CHANGED",
		];
		for (let index = 0; index < names.length; index += 1) {
			const chain = frozenPairWithChangedField(names[index], digest(0xee));
			if (chain === undefined) return;
			expectChainError(chain, errors[index]);
		}
	});

	it("rejects hostile array shapes and more than seven records", () => {
		expectChainError(null, "HOSTILE_INPUT");
		expectChainError(Object.freeze({}), "HOSTILE_INPUT");
		expectChainError([], "HOSTILE_INPUT");
		expectChainError(Object.freeze([]), "EMPTY_CHAIN");
		const raw = encoded({});
		if (raw === undefined) return;
		const proxyArray = new Proxy(Object.freeze([raw]), {});
		expectChainError(proxyArray, "HOSTILE_INPUT");
		const extra: Uint8Array[] = [raw];
		Object.defineProperty(extra, "extra", { value: 1, configurable: true });
		expectChainError(Object.freeze(extra), "HOSTILE_INPUT");
		const symbolArray: Uint8Array[] = [raw];
		Object.defineProperty(symbolArray, Symbol("entry"), { value: 1, configurable: true });
		expectChainError(Object.freeze(symbolArray), "HOSTILE_INPUT");
		const tooLong: Uint8Array[] = [];
		for (let index = 0; index < 8; index += 1) tooLong[index] = raw;
		expectChainError(Object.freeze(tooLong), "CHAIN_TOO_LONG");
	});

	it("rejects hostile chain elements", () => {
		const raw = encoded({});
		if (raw === undefined) return;
		expectChainError(Object.freeze([new Proxy(raw, {})]), "HOSTILE_INPUT");
		const largerBuffer = new ArrayBuffer(321);
		const larger = new Uint8Array(largerBuffer);
		for (let index = 0; index < raw.length; index += 1) larger[index + 1] = raw[index];
		expectChainError(Object.freeze([new Uint8Array(largerBuffer, 1, 320)]), "HOSTILE_INPUT");
	});
});

describe("captured intrinsics", () => {
	it("keeps object and array inspection after globals change", () => {
		const input = recordInput({});
		const chain = frozenChain([ALLOCATED]);
		if (chain === undefined) return;
		const getPrototypeOf = Object.getPrototypeOf;
		const getOwnPropertyNames = Object.getOwnPropertyNames;
		const getOwnPropertySymbols = Object.getOwnPropertySymbols;
		const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
		const isFrozen = Object.isFrozen;
		const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, "freeze");
		const isArrayDescriptor = Object.getOwnPropertyDescriptor(Array, "isArray");
		let encodeOk = false;
		let chainOk = false;
		try {
			Object.getPrototypeOf = () => null;
			Object.getOwnPropertyNames = () => [];
			Object.getOwnPropertySymbols = () => [Symbol("changed")];
			Object.getOwnPropertyDescriptor = () => undefined;
			Object.isFrozen = () => false;
			Object.defineProperty(Object, "freeze", { value: (value: unknown) => value, configurable: true });
			Object.defineProperty(Array, "isArray", { value: () => false, configurable: true });
			encodeOk = encodeHostedSessionWalRecord(input).ok;
			chainOk = verifyHostedSessionWalChain(chain).ok;
		} finally {
			Object.getPrototypeOf = getPrototypeOf;
			Object.getOwnPropertyNames = getOwnPropertyNames;
			Object.getOwnPropertySymbols = getOwnPropertySymbols;
			Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
			Object.isFrozen = isFrozen;
			if (freezeDescriptor !== undefined) Object.defineProperty(Object, "freeze", freezeDescriptor);
			if (isArrayDescriptor !== undefined) Object.defineProperty(Array, "isArray", isArrayDescriptor);
		}
		expect(encodeOk).toBe(true);
		expect(chainOk).toBe(true);
	});

	it("keeps number checks after the global method changes", () => {
		const input = recordInput({ state: 1.5 });
		const isSafeInteger = Number.isSafeInteger;
		let code = "";
		try {
			Number.isSafeInteger = () => true;
			const result = encodeHostedSessionWalRecord(input);
			if (result.ok === false) code = result.code;
		} finally {
			Number.isSafeInteger = isSafeInteger;
		}
		expect(code).toBe("STATE_INVALID");
	});

	it("keeps reflection after the global method changes", () => {
		const input = recordInput({ revision: 0x0102030405060708n });
		const apply = Reflect.apply;
		let encodeOk = false;
		try {
			Reflect.apply = () => undefined;
			encodeOk = encodeHostedSessionWalRecord(input).ok;
		} finally {
			Reflect.apply = apply;
		}
		expect(encodeOk).toBe(true);
	});

	it("keeps bigint conversion after the global constructor changes", () => {
		const raw = encoded({ revision: 0x0102030405060708n });
		if (raw === undefined) return;
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "BigInt");
		let revision = 0n;
		try {
			Object.defineProperty(globalThis, "BigInt", { value: () => 0n, configurable: true });
			const result = decodeHostedSessionWalRecord(raw);
			if (result.ok) revision = result.value.revision;
		} finally {
			if (descriptor !== undefined) Object.defineProperty(globalThis, "BigInt", descriptor);
		}
		expect(revision).toBe(0x0102030405060708n);
	});

	it("keeps index conversion after the global constructor changes", () => {
		const raw = encoded({});
		if (raw === undefined) return;
		const malformed: Uint8Array[] = [];
		malformed.length = 1;
		Object.defineProperty(malformed, "bad", { value: raw, enumerable: true, configurable: true });
		const chain = Object.freeze(malformed);
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "String");
		let code = "";
		try {
			Object.defineProperty(globalThis, "String", { value: () => "bad", configurable: true });
			const result = verifyHostedSessionWalChain(chain);
			if (result.ok === false) code = result.errors[0];
		} finally {
			if (descriptor !== undefined) Object.defineProperty(globalThis, "String", descriptor);
		}
		expect(code).toBe("HOSTILE_INPUT");
	});

	it("keeps DataView construction and writes after globals change", () => {
		const input = recordInput({ revision: 0x0102030405060708n });
		const viewDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DataView");
		const prototype = DataView.prototype;
		const setDescriptor = Object.getOwnPropertyDescriptor(prototype, "setBigUint64");
		let raw: Uint8Array | undefined;
		try {
			Object.defineProperty(globalThis, "DataView", { value: function ChangedDataView() {}, configurable: true });
			Object.defineProperty(prototype, "setBigUint64", { value: () => undefined, configurable: true });
			const result = encodeHostedSessionWalRecord(input);
			if (result.ok) raw = result.value;
		} finally {
			if (viewDescriptor !== undefined) Object.defineProperty(globalThis, "DataView", viewDescriptor);
			if (setDescriptor !== undefined) Object.defineProperty(prototype, "setBigUint64", setDescriptor);
		}
		expect(raw).toBeDefined();
		if (raw !== undefined) expect(hex(raw).slice(48, 64)).toBe("0102030405060708");
	});

	it("keeps typed-array getters after their descriptors change", () => {
		const raw = encoded({});
		const chain = frozenChain([ALLOCATED, CREATE_DISPATCHED]);
		if (raw === undefined || chain === undefined) return;
		const prototype = Object.getPrototypeOf(Uint8Array.prototype);
		const names = ["length", "byteLength", "buffer", "byteOffset"];
		const descriptors: Array<PropertyDescriptor | undefined> = [];
		for (let index = 0; index < names.length; index += 1) {
			descriptors[index] = Object.getOwnPropertyDescriptor(prototype, names[index]);
		}
		let decodeOk = false;
		let chainOk = false;
		try {
			for (let index = 0; index < names.length; index += 1) {
				Object.defineProperty(prototype, names[index], { get: () => 0, configurable: true });
			}
			decodeOk = decodeHostedSessionWalRecord(raw).ok;
			chainOk = verifyHostedSessionWalChain(chain).ok;
		} finally {
			for (let index = 0; index < names.length; index += 1) {
				const descriptor = descriptors[index];
				if (descriptor !== undefined) Object.defineProperty(prototype, names[index], descriptor);
			}
		}
		expect(decodeOk).toBe(true);
		expect(chainOk).toBe(true);
	});

	it("keeps hash methods after prototype methods change", () => {
		const chain = frozenChain([ALLOCATED, CREATE_DISPATCHED]);
		if (chain === undefined) return;
		const prototype = Object.getPrototypeOf(createHash("sha256"));
		const updateDescriptor = Object.getOwnPropertyDescriptor(prototype, "update");
		const digestDescriptor = Object.getOwnPropertyDescriptor(prototype, "digest");
		let chainOk = false;
		try {
			Object.defineProperty(prototype, "update", { value: () => undefined, configurable: true });
			Object.defineProperty(prototype, "digest", { value: () => new Uint8Array(1), configurable: true });
			chainOk = verifyHostedSessionWalChain(chain).ok;
		} finally {
			if (updateDescriptor !== undefined) Object.defineProperty(prototype, "update", updateDescriptor);
			if (digestDescriptor !== undefined) Object.defineProperty(prototype, "digest", digestDescriptor);
		}
		expect(chainOk).toBe(true);
	});

	it("does not consume the array iterator", () => {
		const chain = frozenChain([ALLOCATED, CREATE_DISPATCHED]);
		if (chain === undefined) return;
		const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
		let chainOk = false;
		try {
			Object.defineProperty(Array.prototype, Symbol.iterator, { value: undefined, configurable: true });
			chainOk = verifyHostedSessionWalChain(chain).ok;
		} finally {
			if (descriptor !== undefined) Object.defineProperty(Array.prototype, Symbol.iterator, descriptor);
		}
		expect(chainOk).toBe(true);
	});
});

describe("result ownership", () => {
	it("freezes public result objects and chain error lists", () => {
		const encodedResult = encodeHostedSessionWalRecord(recordInput({}));
		expect(Object.isFrozen(encodedResult)).toBe(true);
		if (encodedResult.ok === false) return;
		const decodedResult = decodeHostedSessionWalRecord(encodedResult.value);
		expect(Object.isFrozen(decodedResult)).toBe(true);
		if (decodedResult.ok) expect(Object.isFrozen(decodedResult.value)).toBe(true);
		const goodChain = verifyHostedSessionWalChain(Object.freeze([encodedResult.value]));
		expect(Object.isFrozen(goodChain)).toBe(true);
		const badChain = verifyHostedSessionWalChain(Object.freeze([]));
		expect(Object.isFrozen(badChain)).toBe(true);
		if (badChain.ok === false) expect(Object.isFrozen(badChain.errors)).toBe(true);
	});
});
