import { types } from "node:util";

export type CredentialWriteFailureCode = "CANCELLED" | "END_FAILED" | "INVALID_INPUT" | "TIMEOUT" | "WRITE_FAILED";

export type CredentialWriteCompletion =
	| Readonly<{ ok: true; code: "WRITTEN" }>
	| Readonly<{ ok: false; code: Exclude<CredentialWriteFailureCode, "INVALID_INPUT"> }>;

export interface CredentialWriteHandle {
	readonly completion: Promise<CredentialWriteCompletion>;
	readonly cancel: () => void;
}

export type CreateCredentialWriteResult =
	| Readonly<{ ok: true; handle: CredentialWriteHandle }>
	| Readonly<{ ok: false; code: "INVALID_INPUT" }>;

const MAX_PAYLOAD_BYTES = 65_536;
const MAX_TIMEOUT_MS = 300_000;
const INPUT_KEYS = new Set(["payload", "timeoutMs", "writable"]);
const WRITABLE_KEYS = new Set(["end", "release", "write"]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

interface WritableCapability {
	readonly write: (frame: Uint8Array, callback: (result: unknown) => void) => unknown;
	readonly release: (callback: (result: unknown) => void) => unknown;
	readonly end: (callback: (result: unknown) => void) => unknown;
}

interface Snapshot {
	readonly payload: unknown;
	readonly timeoutMs: number;
	readonly writable: WritableCapability;
}

const INVALID = Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });
const WRITTEN = Object.freeze({ ok: true as const, code: "WRITTEN" as const });
const FAILURES = Object.freeze({
	CANCELLED: Object.freeze({ ok: false as const, code: "CANCELLED" as const }),
	END_FAILED: Object.freeze({ ok: false as const, code: "END_FAILED" as const }),
	TIMEOUT: Object.freeze({ ok: false as const, code: "TIMEOUT" as const }),
	WRITE_FAILED: Object.freeze({ ok: false as const, code: "WRITE_FAILED" as const }),
});

function safeErase(value: unknown): void {
	try {
		Uint8Array.prototype.fill.call(value, 0);
	} catch {
		// Invalid, detached, or proxy views cannot be safely erased here.
	}
}

function exactDescriptors(
	raw: unknown,
	keys: ReadonlySet<string>,
): Readonly<Record<string, PropertyDescriptor>> | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return descriptors;
	} catch {
		return null;
	}
}

function snapshotWritable(raw: unknown): WritableCapability | null {
	const descriptors = exactDescriptors(raw, WRITABLE_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const write = descriptors.write?.value;
	const release = descriptors.release?.value;
	const end = descriptors.end?.value;
	if (typeof write !== "function" || typeof release !== "function" || typeof end !== "function") return null;
	return Object.freeze({
		write: (frame: Uint8Array, callback: (result: unknown) => void): unknown =>
			Reflect.apply(write as CallableFunction, raw, [frame, callback]),
		release: (callback: (result: unknown) => void): unknown =>
			Reflect.apply(release as CallableFunction, raw, [callback]),
		end: (callback: (result: unknown) => void): unknown => Reflect.apply(end as CallableFunction, raw, [callback]),
	});
}

function snapshotInput(raw: unknown): Snapshot | null {
	const descriptors = exactDescriptors(raw, INPUT_KEYS);
	if (!descriptors) return null;
	const timeoutMs = descriptors.timeoutMs?.value;
	if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
		return null;
	const writable = snapshotWritable(descriptors.writable?.value);
	if (!writable) return null;
	return Object.freeze({ payload: descriptors.payload?.value, timeoutMs, writable });
}

function exactPayload(raw: unknown): Uint8Array | null {
	if (typeof raw !== "object" || raw === null || !bufferGetter || !byteOffsetGetter || !byteLengthGetter) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Uint8Array.prototype) return null;
		if (
			Object.hasOwn(raw, "buffer") ||
			Object.hasOwn(raw, "byteOffset") ||
			Object.hasOwn(raw, "byteLength") ||
			Object.hasOwn(raw, "length")
		)
			return null;
		const backing = bufferGetter.call(raw) as unknown;
		const offset = byteOffsetGetter.call(raw) as unknown;
		const length = byteLengthGetter.call(raw) as unknown;
		if (typeof backing !== "object" || backing === null || types.isProxy(backing)) return null;
		if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype) return null;
		if (offset !== 0 || typeof length !== "number" || !Number.isSafeInteger(length)) return null;
		if (!arrayBufferByteLengthGetter) return null;
		const backingLength = arrayBufferByteLengthGetter.call(backing) as unknown;
		if (length < 1 || length > MAX_PAYLOAD_BYTES || length !== backingLength) return null;
		ArrayBuffer.prototype.slice.call(backing, 0, 0);
		return raw as Uint8Array;
	} catch {
		return null;
	}
}

function callbackStatus(raw: unknown, allowed: ReadonlySet<string>): string | null {
	const descriptors = exactDescriptors(raw, new Set(["status"]));
	const value = descriptors?.status?.value;
	return typeof value === "string" && allowed.has(value) ? value : null;
}

function operationStatus(raw: unknown, allowed: ReadonlySet<string>): string | null {
	return callbackStatus(raw, allowed);
}

export function createCredentialFrameWrite(raw: unknown): CreateCredentialWriteResult {
	let discoveredPayload: unknown;
	try {
		if (typeof raw === "object" && raw !== null && !types.isProxy(raw)) {
			const descriptor = Object.getOwnPropertyDescriptor(raw, "payload");
			if (descriptor && "value" in descriptor) discoveredPayload = descriptor.value;
		}
	} catch {
		return INVALID;
	}

	let frame: Uint8Array | null = null;
	let snapshot: Snapshot | null = null;
	try {
		snapshot = snapshotInput(raw);
		const payload = exactPayload(snapshot?.payload);
		if (!snapshot || !payload) return INVALID;
		frame = new Uint8Array(payload.byteLength + 4);
		new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
		frame.set(payload, 4);
	} catch {
		if (frame) safeErase(frame);
		return INVALID;
	} finally {
		safeErase(discoveredPayload);
	}
	if (!snapshot || !frame) return INVALID;
	const accepted = snapshot;

	let phase: "writing" | "ending" | "terminal" = "writing";
	let ownsFrame = true;
	let releaseStarted = false;
	let writeReturnSeen = false;
	let writeCallback: "error" | "written" | "malformed" | null = null;
	let endReturnSeen = false;
	let endCallback: "ended" | "error" | "malformed" | null = null;
	let failure: Exclude<CredentialWriteFailureCode, "INVALID_INPUT"> | null = null;
	let completionResolve: ((value: CredentialWriteCompletion) => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const completion = new Promise<CredentialWriteCompletion>((resolve) => {
		completionResolve = resolve;
	});

	function eraseFrame(): void {
		if (!ownsFrame) return;
		ownsFrame = false;
		safeErase(frame);
		frame = null;
	}
	function latch(code: Exclude<CredentialWriteFailureCode, "INVALID_INPUT">): void {
		failure ??= code;
	}
	function finish(value: CredentialWriteCompletion): void {
		if (phase === "terminal") return;
		phase = "terminal";
		if (timer) clearTimeout(timer);
		timer = null;
		const resolve = completionResolve;
		completionResolve = null;
		resolve?.(value);
	}
	function finishFailureWhenReleased(): void {
		if (!ownsFrame && failure) finish(FAILURES[failure]);
	}

	function onRelease(rawResult: unknown): void {
		if (!ownsFrame) return;
		const status = callbackStatus(rawResult, new Set(["error", "released"]));
		if (status === "released") {
			eraseFrame();
			finishFailureWhenReleased();
		}
	}
	function beginRelease(): void {
		if (!ownsFrame || releaseStarted || phase === "terminal") {
			finishFailureWhenReleased();
			return;
		}
		releaseStarted = true;
		let returned: unknown;
		try {
			returned = accepted.writable.release(onRelease);
		} catch {
			return;
		}
		if (!ownsFrame) return;
		const status = operationStatus(returned, new Set(["error", "released", "started"]));
		if (status === "released") {
			eraseFrame();
			finishFailureWhenReleased();
		}
	}

	function decideEnd(): void {
		if (phase !== "ending" || !endReturnSeen) return;
		if (endCallback === "error" || endCallback === "malformed") {
			latch("END_FAILED");
			finish(FAILURES.END_FAILED);
			return;
		}
		if (endCallback === "ended") finish(WRITTEN);
	}
	function onEnd(rawResult: unknown): void {
		if (phase !== "ending" || endCallback !== null) return;
		const status = callbackStatus(rawResult, new Set(["ended", "error"]));
		endCallback = status === "ended" || status === "error" ? status : "malformed";
		decideEnd();
	}
	function beginEnd(): void {
		if (phase !== "writing" || failure || ownsFrame) return;
		phase = "ending";
		let returned: unknown;
		try {
			returned = accepted.writable.end(onEnd);
		} catch {
			latch("END_FAILED");
			finish(FAILURES.END_FAILED);
			return;
		}
		endReturnSeen = true;
		const status = operationStatus(returned, new Set(["ended", "error", "started"]));
		if (status === "ended") {
			if (endCallback === "error" || endCallback === "malformed") {
				latch("END_FAILED");
				finish(FAILURES.END_FAILED);
			} else {
				finish(WRITTEN);
			}
			return;
		}
		if (status !== "started") {
			latch("END_FAILED");
			finish(FAILURES.END_FAILED);
			return;
		}
		decideEnd();
	}
	function decideWrite(): void {
		if (!writeReturnSeen || phase === "terminal") return;
		if (failure) {
			if (ownsFrame) beginRelease();
			else finishFailureWhenReleased();
			return;
		}
		if (writeCallback === "written") beginEnd();
		else if (writeCallback === "error" || writeCallback === "malformed") {
			latch("WRITE_FAILED");
			if (ownsFrame) beginRelease();
			else finishFailureWhenReleased();
		}
	}
	function onWrite(rawResult: unknown): void {
		if (writeCallback !== null || phase === "terminal") return;
		const status = callbackStatus(rawResult, new Set(["error", "written"]));
		writeCallback = status === "written" || status === "error" ? status : "malformed";
		if (writeCallback !== "malformed") eraseFrame();
		if (writeCallback !== "written") latch("WRITE_FAILED");
		decideWrite();
	}
	function cancel(): void {
		if (phase === "terminal" || failure) return;
		latch("CANCELLED");
		if (phase === "ending") finish(FAILURES.CANCELLED);
		else if (writeReturnSeen) beginRelease();
	}

	const handle = Object.freeze({ completion, cancel });
	timer = setTimeout(() => {
		timer = null;
		if (phase === "terminal" || failure) return;
		latch("TIMEOUT");
		if (phase === "ending") finish(FAILURES.TIMEOUT);
		else if (writeReturnSeen) beginRelease();
	}, accepted.timeoutMs);

	let returned: unknown;
	try {
		returned = accepted.writable.write(frame, onWrite);
	} catch {
		writeReturnSeen = true;
		latch("WRITE_FAILED");
		beginRelease();
		return Object.freeze({ ok: true as const, handle });
	}
	writeReturnSeen = true;
	const status = operationStatus(returned, new Set(["error", "started"]));
	if (status !== "started") latch("WRITE_FAILED");
	decideWrite();
	return Object.freeze({ ok: true as const, handle });
}
