/**
 * Package-internal workspace process lifecycle implementation.
 * Extracted from prime-workspace-authority.ts for process-core separation.
 *
 * This file MUST NOT be imported by any file except the two authorized
 * wrapper modules: prime-workspace-authority.ts and prime-workspace-sync-v21.ts.
 *
 * @packageDocumentation
 * @internal
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { platform } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { WorkspaceVerificationCode, WorkspaceVerificationResult } from "./prime-workspace-authority-types.js";

const CAPTURED_PERFORMANCE_NOW = performance.now.bind(performance);
const CAPTURED_OBJECT_HAS_OWN = Object.hasOwn;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const CAPTURED_PROCESS_KILL = process.kill.bind(process);

const HEADER_SIZE = 5;
const MAX_PAYLOAD = 1_048_576;
const MAX_STREAM_BYTES = 1_048_576;
const OP_DEADLINE_MS = 3000;
const QUIT_GRACE_MS = 3000;
const TERM_GRACE_MS = 2000;
const KILL_GRACE_MS = 2000;
const GROUP_POLL_MS = 200;
const GROUP_POLL_COUNT = 10;
const DRAIN_GRACE_MS = 2000;

const OPEN_ROOT = 0x01;
const FLOCK_EX_NB = 0x40;
const QUIT = 0xff;
const RESPONSE_OK = 0x00;
const RESPONSE_ERROR = 0x01;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SAFE_USERNAME_RE = /^[a-zA-Z0-9._-]+$/;

type WaitResult = "event" | "error" | "close" | "timeout";

function boundedEventWait(
	source: NodeJS.EventEmitter | null,
	eventName: string,
	timeoutMs: number,
	errorName?: string,
	closeName?: string,
): Promise<WaitResult> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		function cleanup(): void {
			if (timer !== undefined) clearTimeout(timer);
			if (source !== null) {
				source.off(eventName, onEvent);
				if (errorName !== undefined) source.off(errorName, onError);
				if (closeName !== undefined) source.off(closeName, onClose);
			}
		}

		function finish(result: WaitResult): void {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		}

		function onEvent(): void {
			finish("event");
		}
		function onError(): void {
			finish("error");
		}
		function onClose(): void {
			finish("close");
		}
		function onTimeout(): void {
			finish("timeout");
		}

		if (source !== null) {
			source.once(eventName, onEvent);
			if (errorName !== undefined) source.once(errorName, onError);
			if (closeName !== undefined) source.once(closeName, onClose);
		}
		timer = setTimeout(onTimeout, Math.max(0, timeoutMs));
	});
}

function isSessionRoot(raw: unknown): raw is string {
	if (typeof raw !== "string") return false;
	if (raw.length === 0 || raw.length > 4096) return false;
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		if (code < 0x20 || code > 0x7e || code === 0x5c) return false;
	}
	if (raw.includes("//")) return false;
	const normalized = normalize(raw);
	if (normalized !== raw || !isAbsolute(normalized)) return false;
	const segments = normalized.split("/");
	if (segments[0] !== "") return false;
	if (segments.length === 6) {
		if (segments[1] === "root") {
			return (
				segments[2] === ".prime" &&
				segments[3] === "agent" &&
				segments[4] === "sandbox-sessions" &&
				HEX64_RE.test(segments[5])
			);
		}
		return false;
	}
	if (segments.length !== 7) return false;
	if (segments[1] !== "Users" && segments[1] !== "home") return false;
	if (!SAFE_USERNAME_RE.test(segments[2])) return false;
	return (
		segments[3] === ".prime" &&
		segments[4] === "agent" &&
		segments[5] === "sandbox-sessions" &&
		HEX64_RE.test(segments[6])
	);
}

function okResult(): WorkspaceVerificationResult {
	return Object.freeze({ ok: true });
}

function failResult(code: WorkspaceVerificationCode): WorkspaceVerificationResult {
	return Object.freeze({ ok: false, code });
}

function zeroBuffer(buffer: Uint8Array): void {
	buffer.fill(0);
}

interface OutputCollector {
	available(): number;
	take(length: number): Uint8Array | null;
	isTerminal(): boolean;
	hasFailed(): boolean;
	generation(): number;
	waitForChange(observedGeneration: number, deadline: number): Promise<boolean>;
	dispose(): void;
}

function startOutputCollector(stream: NodeJS.ReadableStream): OutputCollector {
	const notifier = new EventEmitter();
	const chunks: Uint8Array[] = [];
	let firstOffset = 0;
	let queued = 0;
	let observedBytes = 0;
	let changeGeneration = 0;
	let terminal = false;
	let failed = false;

	function signal(): void {
		changeGeneration += 1;
		notifier.emit("change");
	}

	function onData(chunk: unknown): void {
		if (!(chunk instanceof Uint8Array)) {
			failed = true;
			signal();
			return;
		}
		if (chunk.byteLength > MAX_STREAM_BYTES - observedBytes) {
			failed = true;
			zeroBuffer(chunk);
			signal();
			return;
		}
		observedBytes += chunk.byteLength;
		const owned = new Uint8Array(chunk.byteLength);
		owned.set(chunk);
		zeroBuffer(chunk);
		chunks.push(owned);
		queued += owned.byteLength;
		signal();
	}

	function onError(): void {
		failed = true;
		signal();
	}

	function onTerminal(): void {
		terminal = true;
		stream.off("data", onData);
		stream.off("error", onError);
		stream.off("end", onTerminal);
		stream.off("close", onTerminal);
		signal();
	}

	stream.on("data", onData);
	stream.on("error", onError);
	stream.on("end", onTerminal);
	stream.on("close", onTerminal);

	return {
		available(): number {
			return queued;
		},
		take(length: number): Uint8Array | null {
			if (length < 0 || queued < length) return null;
			const result = new Uint8Array(length);
			let resultOffset = 0;
			while (resultOffset < length) {
				const first = chunks[0];
				if (first === undefined) {
					zeroBuffer(result);
					return null;
				}
				const count = Math.min(length - resultOffset, first.byteLength - firstOffset);
				result.set(first.subarray(firstOffset, firstOffset + count), resultOffset);
				resultOffset += count;
				firstOffset += count;
				queued -= count;
				if (firstOffset === first.byteLength) {
					zeroBuffer(first);
					chunks.shift();
					firstOffset = 0;
				}
			}
			return result;
		},
		isTerminal(): boolean {
			return terminal;
		},
		hasFailed(): boolean {
			return failed;
		},
		generation(): number {
			return changeGeneration;
		},
		waitForChange(observedGeneration: number, deadline: number): Promise<boolean> {
			return new Promise((resolve) => {
				let settled = false;
				let timer: ReturnType<typeof setTimeout> | undefined;

				function cleanup(): void {
					if (timer !== undefined) clearTimeout(timer);
					notifier.off("change", onChange);
				}

				function finish(changed: boolean): void {
					if (settled) return;
					settled = true;
					cleanup();
					resolve(changed);
				}

				function onChange(): void {
					finish(true);
				}

				function onTimeout(): void {
					finish(false);
				}

				notifier.once("change", onChange);
				if (changeGeneration !== observedGeneration || terminal || failed) {
					finish(true);
					return;
				}
				const remaining = deadline - CAPTURED_PERFORMANCE_NOW();
				if (remaining <= 0) {
					finish(false);
					return;
				}
				timer = setTimeout(onTimeout, remaining);
			});
		},
		dispose(): void {
			stream.off("data", onData);
			stream.off("error", onError);
			stream.off("end", onTerminal);
			stream.off("close", onTerminal);
			for (const chunk of chunks) zeroBuffer(chunk);
			chunks.length = 0;
			queued = 0;
			notifier.removeAllListeners();
		},
	};
}

async function readExactBytes(
	collector: OutputCollector,
	length: number,
	deadline: number,
): Promise<Uint8Array | null> {
	while (collector.available() < length) {
		if (collector.hasFailed() || collector.isTerminal()) return null;
		const observedGeneration = collector.generation();
		if (!(await collector.waitForChange(observedGeneration, deadline))) return null;
	}
	return collector.take(length);
}

interface HelperFrame {
	readonly status: number;
	readonly payload: Uint8Array;
}

async function readFrame(
	collector: OutputCollector,
	deadline: number,
	expectedPayload?: number,
): Promise<HelperFrame | null> {
	const header = await readExactBytes(collector, HEADER_SIZE, deadline);
	if (header === null) return null;
	let status = 0;
	let payloadLength = 0;
	try {
		status = header[0];
		payloadLength = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false);
	} finally {
		zeroBuffer(header);
	}
	if (payloadLength > MAX_PAYLOAD) return null;
	if (expectedPayload !== undefined && status === RESPONSE_OK && payloadLength !== expectedPayload) return null;
	if (payloadLength === 0) return Object.freeze({ status, payload: new Uint8Array(0) });
	const payload = await readExactBytes(collector, payloadLength, deadline);
	if (payload === null) return null;
	return Object.freeze({ status, payload });
}

interface WriteState {
	failed: boolean;
	closed: boolean;
	dispose(): void;
}

function watchWritable(stream: Writable): WriteState {
	const state: WriteState = {
		failed: false,
		closed: false,
		dispose(): void {
			stream.off("error", onError);
			stream.off("close", onClose);
		},
	};
	function onError(): void {
		state.failed = true;
	}
	function onClose(): void {
		state.closed = true;
	}
	stream.on("error", onError);
	stream.on("close", onClose);
	return state;
}

function writeFrame(
	stdin: Writable,
	writeState: WriteState,
	opcode: number,
	payload: Uint8Array,
	deadline: number,
): Promise<boolean> {
	const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
	frame[0] = opcode;
	new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(1, payload.byteLength, false);
	frame.set(payload, HEADER_SIZE);

	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		function cleanup(): void {
			if (timer !== undefined) clearTimeout(timer);
			stdin.off("error", onError);
			stdin.off("close", onClose);
		}

		function finish(completed: boolean): void {
			if (settled) return;
			settled = true;
			cleanup();
			zeroBuffer(frame);
			resolve(completed && !timedOut && !writeState.failed && !writeState.closed);
		}

		function onComplete(error?: Error | null): void {
			finish(error === undefined || error === null);
		}

		function onError(): void {
			finish(false);
		}

		function onClose(): void {
			finish(false);
		}

		function onTimeout(): void {
			timedOut = true;
			stdin.destroy();
		}

		stdin.once("error", onError);
		stdin.once("close", onClose);
		if (writeState.failed || writeState.closed) {
			finish(false);
			return;
		}
		const remaining = deadline - CAPTURED_PERFORMANCE_NOW();
		if (remaining <= 0) {
			timedOut = true;
			stdin.destroy();
			return;
		}
		timer = setTimeout(onTimeout, remaining);
		try {
			stdin.write(frame, onComplete);
		} catch {
			finish(false);
		}
	});
}

interface ErrnoResult {
	readonly errno: number;
}

async function sendForResult(
	stdin: Writable,
	stdout: OutputCollector,
	writeState: WriteState,
	opcode: number,
	payload: Uint8Array,
	deadlineMs: number,
	expectedPayload?: number,
): Promise<Uint8Array | ErrnoResult | null> {
	const deadline = CAPTURED_PERFORMANCE_NOW() + deadlineMs;
	if (!(await writeFrame(stdin, writeState, opcode, payload, deadline))) return null;
	const response = await readFrame(stdout, deadline, expectedPayload);
	if (response === null) return null;
	if (response.status === RESPONSE_ERROR) {
		if (response.payload.byteLength !== 4) {
			zeroBuffer(response.payload);
			return null;
		}
		const errno = new DataView(
			response.payload.buffer,
			response.payload.byteOffset,
			response.payload.byteLength,
		).getInt32(0, false);
		zeroBuffer(response.payload);
		return Object.freeze({ errno });
	}
	if (response.status !== RESPONSE_OK) {
		zeroBuffer(response.payload);
		return null;
	}
	return response.payload;
}

interface ChildState {
	spawned: boolean;
	closed: boolean;
	spawnError: boolean;
	code: number | null;
	signal: NodeJS.Signals | null;
	dispose(): void;
}

function watchChild(child: ChildProcess): ChildState {
	const state: ChildState = {
		spawned: false,
		closed: false,
		spawnError: false,
		code: null,
		signal: null,
		dispose(): void {
			child.off("spawn", onSpawn);
			child.off("error", onError);
			child.off("close", onClose);
		},
	};
	function onSpawn(): void {
		state.spawned = true;
	}
	function onError(): void {
		state.spawnError = true;
	}
	function onClose(code: number | null, signal: NodeJS.Signals | null): void {
		state.closed = true;
		state.code = code;
		state.signal = signal;
	}
	child.once("spawn", onSpawn);
	child.once("error", onError);
	child.once("close", onClose);
	return state;
}

interface HelperProcess {
	readonly child: ChildProcess;
	readonly childState: ChildState;
	readonly stdin: Writable;
	readonly writeState: WriteState;
	readonly stdout: OutputCollector;
	readonly stderr: OutputCollector;
	readonly pgid: number;
}

function resolvedPythonPath(): string {
	return platform() === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
}

function resolvedHelperPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "ws-posix-helper.py");
}

function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	if (!CAPTURED_OBJECT_HAS_OWN(error, "code")) return null;
	const descriptor = CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(error, "code");
	if (descriptor === undefined || !CAPTURED_OBJECT_HAS_OWN(descriptor, "value")) return null;
	return typeof descriptor.value === "string" ? descriptor.value : null;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
	if (pgid <= 0) return false;
	try {
		CAPTURED_PROCESS_KILL(-pgid, signal);
		return true;
	} catch {
		return false;
	}
}

function groupIsGone(pgid: number): boolean {
	if (pgid <= 0) return false;
	try {
		CAPTURED_PROCESS_KILL(-pgid, 0);
		return false;
	} catch (error: unknown) {
		return errorCode(error) === "ESRCH";
	}
}

async function waitForChildClose(processState: HelperProcess, timeoutMs: number): Promise<boolean> {
	if (processState.childState.closed) return true;
	const result = await boundedEventWait(processState.child, "close", timeoutMs);
	return result === "event" && processState.childState.closed;
}

async function waitForCollectorClose(collector: OutputCollector, timeoutMs: number): Promise<boolean> {
	const deadline = CAPTURED_PERFORMANCE_NOW() + timeoutMs;
	while (!collector.isTerminal()) {
		const observedGeneration = collector.generation();
		if (!(await collector.waitForChange(observedGeneration, deadline))) return false;
	}
	return true;
}

async function pollGroupGone(pgid: number): Promise<boolean> {
	for (let attempt = 0; attempt < GROUP_POLL_COUNT; attempt++) {
		if (groupIsGone(pgid)) return true;
		await boundedEventWait(null, "scheduled", GROUP_POLL_MS);
	}
	return groupIsGone(pgid);
}

async function finishFailedSpawn(
	child: ChildProcess,
	childState: ChildState,
	stdin: Writable | null,
	writeState: WriteState | null,
	stdout: OutputCollector | null,
	stderr: OutputCollector | null,
	pgid: number,
): Promise<boolean> {
	if (stdin !== null) {
		try {
			stdin.end();
		} catch {
			if (writeState !== null) writeState.failed = true;
		}
	}
	if (pgid > 0) signalGroup(pgid, "SIGTERM");
	let closed = childState.closed;
	if (!closed) {
		const result = await boundedEventWait(child, "close", TERM_GRACE_MS);
		closed = result === "event" && childState.closed;
	}
	if (!closed) {
		signalGroup(pgid, "SIGKILL");
		const result = await boundedEventWait(child, "close", KILL_GRACE_MS);
		closed = result === "event" && childState.closed;
	}
	let groupGone = pgid <= 0;
	if (pgid > 0) {
		groupGone = await pollGroupGone(pgid);
		if (!groupGone) {
			signalGroup(pgid, "SIGKILL");
			groupGone = await pollGroupGone(pgid);
		}
	}
	const stdoutDrained = stdout === null ? true : await waitForCollectorClose(stdout, DRAIN_GRACE_MS);
	const stderrDrained = stderr === null ? true : await waitForCollectorClose(stderr, DRAIN_GRACE_MS);
	if (stdout !== null) stdout.dispose();
	if (stderr !== null) stderr.dispose();
	if (writeState !== null) writeState.dispose();
	childState.dispose();
	return closed && stdoutDrained && stderrDrained && groupGone;
}

interface SpawnAttempt {
	readonly processState: HelperProcess | null;
	readonly cleanupComplete: boolean;
}

async function spawnHelper(): Promise<SpawnAttempt> {
	let child: ChildProcess;
	try {
		child = spawn(resolvedPythonPath(), [resolvedHelperPath()], {
			cwd: "/",
			detached: true,
			env: {},
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		return Object.freeze({ processState: null, cleanupComplete: true });
	}
	const childState = watchChild(child);
	const stdin = child.stdin;
	const rawStdout = child.stdout;
	const rawStderr = child.stderr;
	const stdout = rawStdout === null ? null : startOutputCollector(rawStdout);
	const stderr = rawStderr === null ? null : startOutputCollector(rawStderr);
	const writeState = stdin === null ? null : watchWritable(stdin);
	const pgid = child.pid === undefined ? 0 : child.pid;

	if (!childState.spawned && !childState.spawnError && !childState.closed) {
		await boundedEventWait(child, "spawn", OP_DEADLINE_MS, "error", "close");
	}

	if (
		childState.spawnError ||
		childState.closed ||
		pgid <= 0 ||
		stdin === null ||
		rawStdout === null ||
		rawStderr === null ||
		stdout === null ||
		stderr === null ||
		writeState === null
	) {
		const cleanupComplete = await finishFailedSpawn(child, childState, stdin, writeState, stdout, stderr, pgid);
		return Object.freeze({ processState: null, cleanupComplete });
	}

	const processState = Object.freeze({ child, childState, stdin, writeState, stdout, stderr, pgid });
	return Object.freeze({ processState, cleanupComplete: true });
}

async function cleanupProcess(processState: HelperProcess): Promise<boolean> {
	let quitResponseOk = false;
	let usedSignals = false;
	const empty = new Uint8Array(0);
	if (!processState.stdout.hasFailed() && !processState.stderr.hasFailed()) {
		const quitDeadline = CAPTURED_PERFORMANCE_NOW() + OP_DEADLINE_MS;
		const quitWritten = await writeFrame(processState.stdin, processState.writeState, QUIT, empty, quitDeadline);
		if (quitWritten) {
			const response = await readFrame(processState.stdout, quitDeadline, 0);
			if (response !== null) {
				quitResponseOk = response.status === RESPONSE_OK && response.payload.byteLength === 0;
				zeroBuffer(response.payload);
			}
		}
	}
	try {
		processState.stdin.end();
	} catch {
		processState.writeState.failed = true;
	}

	let closed = await waitForChildClose(processState, QUIT_GRACE_MS);
	if (!closed) {
		usedSignals = true;
		signalGroup(processState.pgid, "SIGTERM");
		closed = await waitForChildClose(processState, TERM_GRACE_MS);
	}
	if (!closed) {
		usedSignals = true;
		signalGroup(processState.pgid, "SIGKILL");
		closed = await waitForChildClose(processState, KILL_GRACE_MS);
	}

	let groupGone = await pollGroupGone(processState.pgid);
	if (!groupGone) {
		usedSignals = true;
		signalGroup(processState.pgid, "SIGTERM");
		groupGone = await pollGroupGone(processState.pgid);
	}
	if (!groupGone) {
		usedSignals = true;
		signalGroup(processState.pgid, "SIGKILL");
		groupGone = await pollGroupGone(processState.pgid);
	}

	const stdoutDrained = await waitForCollectorClose(processState.stdout, DRAIN_GRACE_MS);
	const stderrDrained = await waitForCollectorClose(processState.stderr, DRAIN_GRACE_MS);
	const clean =
		quitResponseOk &&
		closed &&
		processState.childState.code === 0 &&
		processState.childState.signal === null &&
		groupGone &&
		!usedSignals &&
		stdoutDrained &&
		stderrDrained &&
		!processState.stdout.hasFailed() &&
		!processState.stderr.hasFailed() &&
		processState.stdout.available() === 0 &&
		processState.stderr.available() === 0 &&
		!processState.writeState.failed;
	processState.stdout.dispose();
	processState.stderr.dispose();
	processState.writeState.dispose();
	processState.childState.dispose();
	return clean;
}

interface RootStat {
	readonly mode: number;
	readonly nlink: number;
	readonly uid: number;
}

function parseRootStat(data: Uint8Array): RootStat | null {
	if (data.byteLength !== 72) return null;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const mode = view.getUint32(16, false);
	if ((mode & 0o170000) !== 0o40000) return null;
	return Object.freeze({ mode, nlink: view.getUint32(20, false), uid: view.getUint32(24, false) });
}

export async function verifyWorkspaceRootLifecycleInternal(rootPathRaw: unknown): Promise<WorkspaceVerificationResult> {
	if (!isSessionRoot(rootPathRaw)) return failResult("OPEN_ROOT_FAILED");
	const spawnAttempt = await spawnHelper();
	const processState = spawnAttempt.processState;
	if (processState === null) {
		return failResult(spawnAttempt.cleanupComplete ? "HELPER_FAILED" : "INTERNAL_ERROR");
	}

	const pathBytes = new TextEncoder().encode(rootPathRaw);
	let openResult: Uint8Array | ErrnoResult | null;
	try {
		openResult = await sendForResult(
			processState.stdin,
			processState.stdout,
			processState.writeState,
			OPEN_ROOT,
			pathBytes,
			OP_DEADLINE_MS,
			72,
		);
	} finally {
		zeroBuffer(pathBytes);
	}
	if (openResult === null || !(openResult instanceof Uint8Array)) {
		return (await cleanupProcess(processState)) ? failResult("OPEN_ROOT_FAILED") : failResult("HELPER_FAILED");
	}
	const rootStat = parseRootStat(openResult);
	zeroBuffer(openResult);
	if (rootStat === null || (rootStat.mode & 0o777) !== 0o700 || rootStat.nlink < 2) {
		return (await cleanupProcess(processState)) ? failResult("OPEN_ROOT_FAILED") : failResult("HELPER_FAILED");
	}
	const getuid = process.getuid;
	if (getuid === undefined) {
		return (await cleanupProcess(processState)) ? failResult("INTERNAL_ERROR") : failResult("HELPER_FAILED");
	}
	if (rootStat.uid !== getuid()) {
		return (await cleanupProcess(processState)) ? failResult("OPEN_ROOT_FAILED") : failResult("HELPER_FAILED");
	}

	const flockPayload = new Uint8Array(4);
	let lockResult: Uint8Array | ErrnoResult | null;
	try {
		new DataView(flockPayload.buffer).setUint32(0, 0, false);
		lockResult = await sendForResult(
			processState.stdin,
			processState.stdout,
			processState.writeState,
			FLOCK_EX_NB,
			flockPayload,
			OP_DEADLINE_MS,
			0,
		);
	} finally {
		zeroBuffer(flockPayload);
	}
	if (lockResult === null || !(lockResult instanceof Uint8Array)) {
		return (await cleanupProcess(processState)) ? failResult("LOCK_FAILED") : failResult("HELPER_FAILED");
	}
	zeroBuffer(lockResult);
	return (await cleanupProcess(processState)) ? okResult() : failResult("HELPER_FAILED");
}
