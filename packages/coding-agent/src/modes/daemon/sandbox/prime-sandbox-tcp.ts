import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { SandboxHandshakeIo } from "./prime-sandbox-handshake.js";
import { readAbortState as abortState, isExactUint8Array as exactUint8Array } from "./prime-sandbox-validation.js";

const ISSUE = Object.freeze({});
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_IO_TIMEOUT_MS = 600_000;
const CLOSE_TIMEOUT_MS = 1_000;
const MAX_BUFFERED_BYTES = 262_512;
const MAX_BUFFERED_CHUNKS = 4_096;
const RUNTIME_PORT = 9_443;

interface PendingRead {
	readonly length: number;
	readonly resolve: (value: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingWrite {
	readonly resolve: (value: boolean) => void;
	readonly bytes: Uint8Array<ArrayBuffer>;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface SocketState {
	readonly socket: Socket;
	readonly closedPromise: Promise<void>;
	readonly resolveClosed: () => void;
	readonly chunks: Uint8Array<ArrayBuffer>[];
	chunkIndex: number;
	bufferedBytes: number;
	closed: boolean;
	pendingRead: PendingRead | undefined;
	pendingWrite: PendingWrite | undefined;
	readonly onClosed: () => void;
}

interface ListenerState {
	readonly server: Server;
	readonly endedPromise: Promise<void>;
	readonly resolveEnded: () => void;
	activeIo: SandboxHandshakeIo | undefined;
	closed: boolean;
	closePromise: Promise<boolean> | undefined;
}

export interface SandboxTcpIo extends SandboxHandshakeIo {
	waitClosed(): Promise<void>;
}

export class SandboxTcpListener {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

Object.freeze(SandboxTcpListener.prototype);
Object.freeze(SandboxTcpListener);

const listenerStates = new WeakMap<object, ListenerState>();

export type SandboxTcpResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" | "CONNECT_FAILED" | "LISTEN_FAILED" | "CLOSE_UNCERTAIN" }>;

function success<T>(value: T): Readonly<{ ok: true; value: T }> {
	return Object.freeze({ ok: true, value });
}

function failure(
	code: "INPUT_INVALID" | "CONNECT_FAILED" | "LISTEN_FAILED" | "CLOSE_UNCERTAIN",
): Readonly<{ ok: false; code: "INPUT_INVALID" | "CONNECT_FAILED" | "LISTEN_FAILED" | "CLOSE_UNCERTAIN" }> {
	return Object.freeze({ ok: false, code });
}

function validHost(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > 255) return false;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x21 || code > 0x7e) return false;
	}
	return true;
}

function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function copyWriteBytes(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	try {
		if (!exactUint8Array(value) || value.byteLength < 1 || value.byteLength > MAX_BUFFERED_BYTES) {
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
		const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
		copy.set(value);
		return copy;
	} catch {
		return undefined;
	}
}

function zeroChunks(state: SocketState): void {
	for (const chunk of state.chunks) chunk.fill(0);
	state.chunks.length = 0;
	state.chunkIndex = 0;
	state.bufferedBytes = 0;
}

function finishRead(state: SocketState, value: unknown): void {
	const pending = state.pendingRead;
	state.pendingRead = undefined;
	if (pending === undefined) return;
	clearTimeout(pending.timer);
	pending.resolve(value);
}

function finishWrite(state: SocketState, value: boolean): void {
	const pending = state.pendingWrite;
	state.pendingWrite = undefined;
	if (pending === undefined) return;
	clearTimeout(pending.timer);
	pending.bytes.fill(0);
	pending.resolve(value);
}

function closeState(state: SocketState): void {
	if (state.closed) return;
	state.closed = true;
	finishRead(state, undefined);
	finishWrite(state, false);
	zeroChunks(state);
	try {
		state.socket.destroy();
	} catch {
		// The state is closed even if the native destroy call fails.
	}
	state.resolveClosed();
	try {
		state.onClosed();
	} catch {
		// The socket authority does not expose callback failures.
	}
}

function take(state: SocketState, length: number): Uint8Array<ArrayBuffer> | undefined {
	if (state.bufferedBytes < length) return undefined;
	const result = new Uint8Array(new ArrayBuffer(length));
	let offset = 0;
	while (offset < length) {
		const chunk = state.chunks[state.chunkIndex];
		if (chunk === undefined) {
			result.fill(0);
			return undefined;
		}
		const count = Math.min(chunk.byteLength, length - offset);
		result.set(chunk.subarray(0, count), offset);
		offset += count;
		state.bufferedBytes -= count;
		if (count === chunk.byteLength) {
			chunk.fill(0);
			state.chunkIndex += 1;
		} else {
			chunk.fill(0, 0, count);
			state.chunks[state.chunkIndex] = chunk.subarray(count);
		}
	}
	if (state.bufferedBytes === 0) {
		state.chunks.length = 0;
		state.chunkIndex = 0;
	} else if (state.chunkIndex > 0 && state.chunkIndex * 2 >= state.chunks.length) {
		state.chunks.splice(0, state.chunkIndex);
		state.chunkIndex = 0;
	}
	return result;
}

function flushRead(state: SocketState): void {
	const pending = state.pendingRead;
	if (pending === undefined) return;
	const value = take(state, pending.length);
	if (value !== undefined) finishRead(state, value);
}

function receive(state: SocketState, value: Uint8Array): void {
	if (state.closed) return;
	if (
		value.byteLength < 1 ||
		state.bufferedBytes > MAX_BUFFERED_BYTES - value.byteLength ||
		state.chunks.length - state.chunkIndex >= MAX_BUFFERED_CHUNKS
	) {
		closeState(state);
		return;
	}
	const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
	copy.set(value);
	state.chunks.push(copy);
	state.bufferedBytes += copy.byteLength;
	flushRead(state);
}

function createSocketIo(socket: Socket, onClosed: () => void): SandboxTcpIo {
	let resolveClosed = (): void => undefined;
	const closedPromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const state: SocketState = {
		socket,
		closedPromise,
		resolveClosed,
		chunks: [],
		chunkIndex: 0,
		bufferedBytes: 0,
		closed: false,
		pendingRead: undefined,
		pendingWrite: undefined,
		onClosed,
	};
	const io: SandboxTcpIo = Object.freeze({
		async readExact(length: number, timeoutMs: number): Promise<unknown> {
			if (
				state.closed ||
				state.pendingRead !== undefined ||
				!Number.isSafeInteger(length) ||
				length < 1 ||
				length > MAX_BUFFERED_BYTES ||
				!Number.isSafeInteger(timeoutMs) ||
				timeoutMs < 1 ||
				timeoutMs > MAX_IO_TIMEOUT_MS
			) {
				closeState(state);
				return undefined;
			}
			const immediate = take(state, length);
			if (immediate !== undefined) return immediate;
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					if (state.pendingRead?.resolve !== resolve) return;
					state.pendingRead = undefined;
					resolve(undefined);
					closeState(state);
				}, timeoutMs);
				state.pendingRead = Object.freeze({ length, resolve, timer });
			});
		},
		async writeExact(bytes: Uint8Array<ArrayBuffer>, timeoutMs: number): Promise<boolean> {
			const copy = copyWriteBytes(bytes);
			if (
				state.closed ||
				state.pendingWrite !== undefined ||
				copy === undefined ||
				!Number.isSafeInteger(timeoutMs) ||
				timeoutMs < 1 ||
				timeoutMs > MAX_IO_TIMEOUT_MS
			) {
				copy?.fill(0);
				closeState(state);
				return false;
			}
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					if (state.pendingWrite?.resolve !== resolve) return;
					state.pendingWrite = undefined;
					copy.fill(0);
					resolve(false);
					closeState(state);
				}, timeoutMs);
				state.pendingWrite = Object.freeze({ resolve, bytes: copy, timer });
				try {
					socket.write(copy, (error) => {
						if (state.pendingWrite?.resolve !== resolve) return;
						finishWrite(state, (error === undefined || error === null) && !state.closed);
					});
				} catch {
					finishWrite(state, false);
					closeState(state);
				}
			});
		},
		close(): void {
			closeState(state);
		},
		async waitClosed(): Promise<void> {
			await state.closedPromise;
		},
	});
	socket.setNoDelay(true);
	socket.on("data", (value: Uint8Array) => receive(state, value));
	socket.once("end", () => closeState(state));
	socket.once("close", () => closeState(state));
	socket.once("error", () => closeState(state));
	socket.resume();
	return io;
}

export async function connectSandboxRuntimeTcp(
	host: unknown,
	port: unknown,
	signal?: AbortSignal,
): Promise<SandboxTcpResult<SandboxTcpIo>> {
	const initialAbortState = abortState(signal);
	if (!validHost(host) || !validPort(port) || initialAbortState === undefined || initialAbortState) {
		return failure("INPUT_INVALID");
	}
	let socket: Socket;
	try {
		socket = createConnection({ host, port });
	} catch {
		return failure("CONNECT_FAILED");
	}
	let connected = false;
	try {
		connected = await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					signal?.removeEventListener("abort", aborted);
				} catch {
					value = false;
				}
				socket.removeListener("connect", onConnect);
				socket.removeListener("error", onError);
				resolve(value);
			};
			const onConnect = (): void => finish(true);
			const onError = (): void => finish(false);
			const aborted = (): void => finish(false);
			const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
			socket.once("connect", onConnect);
			socket.once("error", onError);
			try {
				signal?.addEventListener("abort", aborted, { once: true });
				if (signal?.aborted === true) finish(false);
			} catch {
				finish(false);
			}
		});
	} catch {
		connected = false;
	}
	if (!connected) {
		try {
			socket.destroy();
		} catch {
			// The fixed failure is authoritative.
		}
		return failure("CONNECT_FAILED");
	}
	return success(createSocketIo(socket, () => undefined));
}

export async function listenSandboxRuntimeTcp(
	onConnection: (io: SandboxTcpIo) => void | Promise<void>,
): Promise<SandboxTcpResult<SandboxTcpListener>> {
	if (typeof onConnection !== "function") return failure("INPUT_INVALID");
	let state: ListenerState | undefined;
	let server: Server;
	try {
		server = createServer({ pauseOnConnect: true }, (socket) => {
			const currentState = state;
			if (currentState === undefined || currentState.closed || currentState.activeIo !== undefined) {
				socket.destroy();
				return;
			}
			let io: SandboxTcpIo | undefined;
			io = createSocketIo(socket, () => {
				if (currentState.activeIo === io) currentState.activeIo = undefined;
			});
			currentState.activeIo = io;
			try {
				Promise.resolve(onConnection(io)).catch(() => io?.close());
			} catch {
				io.close();
			}
		});
	} catch {
		return failure("LISTEN_FAILED");
	}
	let resolveEnded = (): void => undefined;
	const endedPromise = new Promise<void>((resolve) => {
		resolveEnded = resolve;
	});
	state = {
		server,
		endedPromise,
		resolveEnded,
		activeIo: undefined,
		closed: false,
		closePromise: undefined,
	};
	const listenAbort = new AbortController();
	const listening = await new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			server.removeListener("listening", onListening);
			server.removeListener("error", onError);
			if (!value) listenAbort.abort();
			resolve(value);
		};
		const onListening = (): void => finish(true);
		const onError = (): void => finish(false);
		const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
		server.once("listening", onListening);
		server.once("error", onError);
		try {
			// The provider cannot expose container loopback; authentication starts immediately after accept.
			server.listen({ host: "0.0.0.0", port: RUNTIME_PORT, exclusive: true, signal: listenAbort.signal });
		} catch {
			finish(false);
		}
	});
	if (!listening) {
		state.closed = true;
		try {
			server.close();
		} catch {
			// The listener never became an authority.
		}
		return failure("LISTEN_FAILED");
	}
	server.once("error", () => {
		if (state === undefined) return;
		state.closed = true;
		state.activeIo?.close();
		state.activeIo = undefined;
		state.resolveEnded();
	});
	const listener = new SandboxTcpListener(ISSUE);
	listenerStates.set(listener, state);
	return success(listener);
}

export async function waitSandboxTcpListenerClosed(value: unknown): Promise<SandboxTcpResult<true>> {
	if (typeof value !== "object" || value === null) return failure("INPUT_INVALID");
	const state = listenerStates.get(value);
	if (state === undefined) return failure("INPUT_INVALID");
	await state.endedPromise;
	return success(true);
}

export async function closeSandboxTcpListener(value: unknown): Promise<SandboxTcpResult<true>> {
	if (typeof value !== "object" || value === null) return failure("INPUT_INVALID");
	const state = listenerStates.get(value);
	if (state === undefined) return failure("INPUT_INVALID");
	state.closed = true;
	state.activeIo?.close();
	state.activeIo = undefined;
	if (state.closePromise === undefined) {
		if (!state.server.listening) {
			state.closePromise = Promise.resolve(true);
		} else {
			const operation = new Promise<boolean>((resolve) => {
				try {
					state.server.close(() => resolve(true));
				} catch {
					resolve(false);
				}
			});
			state.closePromise = operation;
			operation.then((closed) => {
				if (!closed && state.closePromise === operation) state.closePromise = undefined;
			});
		}
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
	});
	const closed = await Promise.race([state.closePromise, timeout]);
	if (timer !== undefined) clearTimeout(timer);
	if (!closed) return failure("CLOSE_UNCERTAIN");
	state.resolveEnded();
	listenerStates.delete(value);
	return success(true);
}
