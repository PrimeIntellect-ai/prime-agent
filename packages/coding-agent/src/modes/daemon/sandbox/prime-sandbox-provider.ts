import { isIP } from "node:net";
import { types } from "node:util";
import { parseBoundedJson } from "./prime-sandbox-json.js";
import {
	type ArchiveUploadBody,
	type ArchiveUploadCompletion,
	isPreparedArchiveUpload,
	type PreparedArchiveUpload,
} from "./prime-sandbox-upload-body.js";

const CONTROL_ORIGIN = "https://api.primeintellect.ai";
const REMOTE_ARCHIVE_PATH = "/tmp/prime-agent-runtime.tar.gz";
const RUNTIME_PORT = 9443;
const EXPOSURE_NAME = "prime-agent-runtime-v1";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MISSING = Symbol("missing");

type Missing = typeof MISSING;
type Method = "GET" | "POST" | "DELETE";

export type SandboxProviderCode =
	| "INPUT_INVALID"
	| "CLOSED"
	| "NOT_SENT"
	| "AMBIGUOUS"
	| "ABORTED"
	| "TIMED_OUT"
	| "CLEANUP_UNCERTAIN"
	| "HTTP_STATUS"
	| "BODY_TOO_LARGE"
	| "INVALID_RESPONSE"
	| "UPLOAD_SOURCE"
	| "EXPOSURE_CONFLICT"
	| "ABSENCE_UNPROVEN";

export type SandboxProviderFailure = Readonly<{ ok: false; code: SandboxProviderCode }>;
export type SandboxProviderResult = Readonly<{ ok: true }> | SandboxProviderFailure;
export type SandboxProviderFactoryResult =
	| Readonly<{ ok: true; value: PrimeSandboxProviderPort }>
	| SandboxProviderFailure;

export type SandboxFetchPort = (url: string, init: RequestInit) => Promise<Response>;

export interface PrimeSandboxProviderPort {
	uploadRelease(source: PreparedArchiveUpload, signal?: AbortSignal): Promise<SandboxProviderResult>;
	exposeRuntime(signal?: AbortSignal): Promise<SandboxProviderResult>;
	unexposeAndProveAbsent(signal?: AbortSignal): Promise<SandboxProviderResult>;
	close(): Promise<SandboxProviderResult>;
}

interface FetchSuccess {
	readonly ok: true;
	readonly status: number;
	readonly body: Uint8Array<ArrayBuffer>;
}

type FetchResult = FetchSuccess | SandboxProviderFailure;
type FetchOutcome = Readonly<{ ok: true; response: Response }> | Readonly<{ ok: false }>;
type CancelCode = "ABORTED" | "TIMED_OUT" | "CLOSED";

interface ActiveRequest {
	readonly abort: AbortController;
	readonly fetchOutcome: Promise<FetchOutcome>;
	readonly body: ArchiveUploadBody | undefined;
	response: Response | undefined;
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	responseDone: boolean;
	cleanup: Promise<boolean> | undefined;
	readonly cancelState: { code: CancelCode | undefined };
	trigger(code: CancelCode): void;
	finishSignals(): void;
}

type InternalResult<T> = Readonly<{ ok: true; value: T }> | SandboxProviderFailure;
type ReaderResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

interface AuthState {
	readonly gatewayBase: string;
	readonly userNs: string;
	readonly jobId: string;
	readonly token: string;
}

interface ExposureState {
	readonly exposureId: string;
	readonly host: string;
	readonly port: number;
}

interface ExposureRow {
	readonly exposureId: string;
	readonly port: number;
	readonly name: string | null;
	readonly protocol: string | null;
	readonly endpoint: Readonly<{ host: string; port: number }> | null;
}

function failure(code: SandboxProviderCode): SandboxProviderFailure {
	return Object.freeze({ ok: false, code });
}

function success(): Readonly<{ ok: true }> {
	return Object.freeze({ ok: true });
}

function ownData(value: object, key: string): unknown | Missing {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return MISSING;
	return descriptor.value;
}

function exactObject(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		if (Object.getPrototypeOf(value) !== Object.prototype) return false;
		const allowed = new Set<string>([...required, ...optional]);
		const keys = Object.keys(value);
		if (keys.length < required.length || keys.length > allowed.size) return false;
		for (const key of keys) {
			if (!allowed.has(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
		}
		for (const key of required) if (!Object.hasOwn(value, key)) return false;
		return true;
	} catch {
		return false;
	}
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
	if (typeof value !== "string" || value.length < minimum || value.length > maximum) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function printableToken(value: unknown, maximum: number): value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) return false;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit < 0x21 || unit > 0x7e) return false;
	}
	return true;
}

function sandboxId(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 4 || value.length > 128 || !value.startsWith("sb_")) return false;
	for (let index = 3; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x46) || (unit >= 0x61 && unit <= 0x66))) {
			return false;
		}
	}
	return true;
}

function unreserved(value: unknown, maximum: number): value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > maximum) return false;
	return /^[A-Za-z0-9._~-]+$/.test(value);
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validRfc3339(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 20 || value.length > 40) return false;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (year < 1970 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
	const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (day < 1 || day > days) return false;
	const zone = match[8];
	if (zone !== "Z") {
		const zoneHour = Number(zone.slice(1, 3));
		const zoneMinute = Number(zone.slice(4, 6));
		if (zoneHour > 23 || zoneMinute > 59) return false;
	}
	return Number.isFinite(Date.parse(value));
}

function canonicalGateway(value: unknown): string | undefined {
	if (
		!boundedString(value, 9, 1024) ||
		value.trim() !== value ||
		value.includes("\\") ||
		/%2e|%2f|%5c/i.test(value) ||
		/(?:^|\/)\.{1,2}(?:\/|$)/.test(value.slice(8))
	) {
		return undefined;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:" || parsed.hostname.length === 0) return undefined;
	if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return undefined;
	const pathname = parsed.pathname;
	if (pathname !== "/") {
		const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
		if (trimmed.length === 0) return undefined;
		for (const segment of trimmed.slice(1).split("/")) if (!unreserved(segment, 128)) return undefined;
		return `${parsed.origin}${trimmed}`;
	}
	return parsed.origin;
}

function parseEndpoint(value: unknown): Readonly<{ host: string; port: number }> | undefined {
	if (!boundedString(value, 3, 512) || value.includes("/") || value.includes("@")) return undefined;
	let host = "";
	let portText = "";
	if (value.startsWith("[")) {
		const close = value.indexOf("]");
		if (close < 3 || close + 2 >= value.length || value.charCodeAt(close + 1) !== 0x3a) return undefined;
		host = value.slice(1, close);
		portText = value.slice(close + 2);
		if (!/^[0-9A-Fa-f:]+$/.test(host) || isIP(host) !== 6) return undefined;
	} else {
		const colon = value.lastIndexOf(":");
		if (colon < 1 || value.indexOf(":") !== colon) return undefined;
		host = value.slice(0, colon);
		portText = value.slice(colon + 1);
		if (/^[0-9.]+$/.test(host)) {
			const parts = host.split(".");
			if (parts.length !== 4) return undefined;
			for (const part of parts) {
				if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return undefined;
			}
		} else {
			if (host.length > 253) return undefined;
			const labels = host.split(".");
			for (const label of labels) {
				if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) return undefined;
			}
		}
	}
	if (!/^[1-9]\d{0,4}$/.test(portText)) return undefined;
	const port = Number(portText);
	if (!safeInteger(port, 1, 65535)) return undefined;
	return Object.freeze({ host: host.toLowerCase(), port });
}

function parseAuth(bytes: Uint8Array, minimumExpiresAt: number): AuthState | undefined {
	const parsed = parseBoundedJson(bytes);
	if (
		!parsed.ok ||
		!exactObject(parsed.value, ["gateway_url", "user_ns", "job_id", "token", "expires_at"], ["is_vm"])
	) {
		return undefined;
	}
	const gatewayBase = canonicalGateway(ownData(parsed.value, "gateway_url"));
	const userNs = ownData(parsed.value, "user_ns");
	const jobId = ownData(parsed.value, "job_id");
	const token = ownData(parsed.value, "token");
	const expiresAt = ownData(parsed.value, "expires_at");
	const isVm = ownData(parsed.value, "is_vm");
	if (gatewayBase === undefined || !unreserved(userNs, 128) || !unreserved(jobId, 128)) return undefined;
	if (!printableToken(token, 8192) || !validRfc3339(expiresAt)) return undefined;
	if (isVm !== MISSING && isVm !== false) return undefined;
	if (!Number.isFinite(minimumExpiresAt) || Date.parse(expiresAt) <= minimumExpiresAt) return undefined;
	return Object.freeze({ gatewayBase, userNs, jobId, token });
}

function validUpload(bytes: Uint8Array, expectedSize: number): boolean {
	const parsed = parseBoundedJson(bytes);
	if (!parsed.ok || !exactObject(parsed.value, ["success", "path", "size", "timestamp"])) return false;
	return (
		ownData(parsed.value, "success") === true &&
		ownData(parsed.value, "path") === REMOTE_ARCHIVE_PATH &&
		ownData(parsed.value, "size") === expectedSize &&
		validRfc3339(ownData(parsed.value, "timestamp"))
	);
}

function parseExposureRow(value: unknown, expectedSandboxId: string): ExposureRow | undefined {
	if (
		!exactObject(
			value,
			["exposure_id", "sandbox_id", "port", "name", "url", "tls_socket"],
			["protocol", "external_port", "external_endpoint", "created_at"],
		)
	) {
		return undefined;
	}
	const exposureId = ownData(value, "exposure_id");
	const rowSandboxId = ownData(value, "sandbox_id");
	const port = ownData(value, "port");
	const name = ownData(value, "name");
	const url = ownData(value, "url");
	const tlsSocket = ownData(value, "tls_socket");
	const protocol = ownData(value, "protocol");
	const externalPort = ownData(value, "external_port");
	const externalEndpoint = ownData(value, "external_endpoint");
	const createdAt = ownData(value, "created_at");
	if (!unreserved(exposureId, 256) || rowSandboxId !== expectedSandboxId || !safeInteger(port, 1, 65535))
		return undefined;
	if (name !== null && !boundedString(name, 1, 128)) return undefined;
	if (!boundedString(url, 0, 2048) || !boundedString(tlsSocket, 0, 2048)) return undefined;
	if (protocol !== MISSING && protocol !== null && protocol !== "HTTP" && protocol !== "TCP") return undefined;
	if (externalPort !== MISSING && externalPort !== null && !safeInteger(externalPort, 1, 65535)) return undefined;
	if (createdAt !== MISSING && createdAt !== null && !validRfc3339(createdAt)) return undefined;
	let endpoint: Readonly<{ host: string; port: number }> | null = null;
	if (externalEndpoint !== MISSING && externalEndpoint !== null) {
		const parsedEndpoint = parseEndpoint(externalEndpoint);
		if (parsedEndpoint === undefined) return undefined;
		endpoint = parsedEndpoint;
	}
	return Object.freeze({
		exposureId,
		port,
		name,
		protocol: protocol === MISSING ? null : protocol,
		endpoint,
	});
}

function parseExposure(
	bytes: Uint8Array,
	expectedSandboxId: string,
): Readonly<{ row: ExposureRow; state: ExposureState }> | undefined {
	const parsed = parseBoundedJson(bytes);
	if (!parsed.ok) return undefined;
	const row = parseExposureRow(parsed.value, expectedSandboxId);
	if (row === undefined || row.port !== RUNTIME_PORT || row.name !== EXPOSURE_NAME) return undefined;
	if (row.protocol !== null && row.protocol !== "TCP") return undefined;
	if (row.endpoint === null) return undefined;
	return Object.freeze({
		row,
		state: Object.freeze({ exposureId: row.exposureId, host: row.endpoint.host, port: row.endpoint.port }),
	});
}

function parseExposureList(bytes: Uint8Array, expectedSandboxId: string): readonly ExposureRow[] | undefined {
	const parsed = parseBoundedJson(bytes);
	if (!parsed.ok || !exactObject(parsed.value, ["exposures"])) return undefined;
	const rows = ownData(parsed.value, "exposures");
	if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > 64) return undefined;
	const output: ExposureRow[] = [];
	for (const value of rows) {
		const row = parseExposureRow(value, expectedSandboxId);
		if (row === undefined) return undefined;
		output.push(row);
	}
	return Object.freeze(output);
}

function encodeJson(value: string): Uint8Array<ArrayBuffer> {
	const raw = new TextEncoder().encode(value);
	const copy = new Uint8Array(new ArrayBuffer(raw.byteLength));
	copy.set(raw);
	return copy;
}

function exactResponse(value: Response): boolean {
	try {
		return (
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === Response.prototype &&
			!Object.hasOwn(value, "status") &&
			!Object.hasOwn(value, "headers") &&
			!Object.hasOwn(value, "body")
		);
	} catch {
		return false;
	}
}

function exactHeaders(value: Headers): boolean {
	try {
		return (
			!types.isProxy(value) && Object.getPrototypeOf(value) === Headers.prototype && !Object.hasOwn(value, "get")
		);
	} catch {
		return false;
	}
}

function exactResponseStream(value: ReadableStream<Uint8Array>): boolean {
	try {
		return (
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === ReadableStream.prototype &&
			!Object.hasOwn(value, "getReader")
		);
	} catch {
		return false;
	}
}

function exactResponseReader(value: ReadableStreamDefaultReader<Uint8Array>): boolean {
	try {
		return (
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === ReadableStreamDefaultReader.prototype &&
			!Object.hasOwn(value, "read") &&
			!Object.hasOwn(value, "cancel") &&
			!Object.hasOwn(value, "releaseLock")
		);
	} catch {
		return false;
	}
}

function copyResponseChunk(value: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
	try {
		if (types.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return undefined;
		const buffer = value.buffer;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return undefined;
		const source = new Uint8Array(buffer, value.byteOffset, value.byteLength);
		const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
		copy.set(source);
		return copy;
	} catch {
		return undefined;
	}
}

function eraseChunks(chunks: readonly Uint8Array<ArrayBuffer>[]): void {
	for (const chunk of chunks) chunk.fill(0);
}

async function settleWithin(operation: Promise<boolean>, milliseconds: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), milliseconds);
	});
	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function createPrimeSandboxProviderPort(
	apiKey: string,
	expectedSandboxId: string,
	dispatch: SandboxFetchPort = fetch,
): SandboxProviderFactoryResult {
	if (!printableToken(apiKey, 8192) || !sandboxId(expectedSandboxId) || typeof dispatch !== "function") {
		return failure("INPUT_INVALID");
	}
	const records = new Set<ActiveRequest>();
	const bodyCleanups = new Set<ArchiveUploadBody>();
	let closed = false;
	let exposure: ExposureState | undefined;
	let exposureAbsenceProven = false;

	async function settleUploadBody(body: ArchiveUploadBody | undefined): Promise<boolean> {
		if (body === undefined) return true;
		try {
			const result = await body.cancelAndSettle();
			if (result.ok || result.code !== "CLEANUP_UNCERTAIN") return true;
			return (await body.retryCleanup()).ok;
		} catch {
			return false;
		}
	}

	async function cleanupRecord(record: ActiveRequest): Promise<boolean> {
		record.abort.abort();
		const bodyCleanup = settleUploadBody(record.body);
		const responseCleanup = record.fetchOutcome
			.then(async (outcome): Promise<boolean> => {
				if (!outcome.ok || record.responseDone) return true;
				const reader = record.reader;
				if (reader !== undefined) {
					try {
						await reader.cancel();
						reader.releaseLock();
						record.reader = undefined;
						record.responseDone = true;
						return true;
					} catch {
						return false;
					}
				}
				const stream = outcome.response.body;
				if (stream === null) {
					record.responseDone = true;
					return true;
				}
				try {
					await stream.cancel();
					record.responseDone = true;
					return true;
				} catch {
					return false;
				}
			})
			.catch(() => false);
		const settled = await Promise.all([bodyCleanup, responseCleanup]);
		return settled[0] && settled[1];
	}

	function startCleanup(record: ActiveRequest): Promise<boolean> {
		if (record.cleanup !== undefined) return record.cleanup;
		const operation = cleanupRecord(record);
		record.cleanup = operation;
		operation
			.then((ok) => {
				if (ok) records.delete(record);
				else record.cleanup = undefined;
			})
			.catch(() => {
				record.cleanup = undefined;
			});
		return operation;
	}

	async function cleanupWithin(record: ActiveRequest): Promise<boolean> {
		return settleWithin(startCleanup(record), CLEANUP_TIMEOUT_MS);
	}

	async function failedAfterDispatch(
		record: ActiveRequest,
		code: SandboxProviderCode,
	): Promise<SandboxProviderFailure> {
		record.finishSignals();
		return (await cleanupWithin(record)) ? failure(code) : failure("CLEANUP_UNCERTAIN");
	}

	async function failedBeforeDispatch(
		body: ArchiveUploadBody | undefined,
		code: SandboxProviderCode,
	): Promise<SandboxProviderFailure> {
		if (body === undefined) return failure(code);
		bodyCleanups.add(body);
		const operation = settleUploadBody(body);
		operation
			.then((ok) => {
				if (ok) bodyCleanups.delete(body);
			})
			.catch(() => {});
		return (await settleWithin(operation, CLEANUP_TIMEOUT_MS)) ? failure(code) : failure("CLEANUP_UNCERTAIN");
	}

	async function request(
		method: Method,
		url: string,
		headers: Headers,
		bodyBytes: Uint8Array<ArrayBuffer> | undefined,
		uploadBody: ArchiveUploadBody | undefined,
		timeoutMs: number,
		responseLimit: number,
		signal: AbortSignal | undefined,
	): Promise<FetchResult> {
		if (closed) return failedBeforeDispatch(uploadBody, "CLOSED");
		if (signal !== undefined) {
			try {
				if (
					types.isProxy(signal) ||
					Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
					Object.hasOwn(signal, "aborted") ||
					Object.hasOwn(signal, "addEventListener") ||
					Object.hasOwn(signal, "removeEventListener")
				) {
					return failedBeforeDispatch(uploadBody, "INPUT_INVALID");
				}
				if (signal.aborted) return failedBeforeDispatch(uploadBody, "NOT_SENT");
			} catch {
				return failedBeforeDispatch(uploadBody, "INPUT_INVALID");
			}
		}
		const abort = new AbortController();
		let resolveCancel: (code: CancelCode) => void = () => {};
		const cancelled = new Promise<CancelCode>((resolve) => {
			resolveCancel = resolve;
		});
		const cancelState: { code: CancelCode | undefined } = { code: undefined };
		const trigger = (code: CancelCode): void => {
			if (cancelState.code !== undefined) return;
			cancelState.code = code;
			resolveCancel(code);
			abort.abort();
		};
		const timer = setTimeout(() => trigger("TIMED_OUT"), timeoutMs);
		let callerAbort: (() => void) | undefined;
		if (signal !== undefined) {
			callerAbort = () => trigger("ABORTED");
			try {
				signal.addEventListener("abort", callerAbort, { once: true });
			} catch {
				clearTimeout(timer);
				return failedBeforeDispatch(uploadBody, "INPUT_INVALID");
			}
		}
		let signalsFinished = false;
		const finishSignals = (): void => {
			if (signalsFinished) return;
			signalsFinished = true;
			clearTimeout(timer);
			if (signal !== undefined && callerAbort !== undefined) {
				try {
					signal.removeEventListener("abort", callerAbort);
				} catch {
					// The request no longer retains caller data.
				}
			}
		};
		if (signal !== undefined) {
			try {
				if (signal.aborted) {
					finishSignals();
					return failedBeforeDispatch(uploadBody, "NOT_SENT");
				}
			} catch {
				finishSignals();
				return failedBeforeDispatch(uploadBody, "INPUT_INVALID");
			}
		}
		const init: RequestInit = Object.freeze({
			method,
			headers,
			body: uploadBody === undefined ? bodyBytes : uploadBody.stream,
			redirect: "error",
			signal: abort.signal,
		});
		let rawFetch: Promise<Response>;
		try {
			rawFetch = dispatch(url, init);
		} catch {
			const placeholder: ActiveRequest = {
				abort,
				fetchOutcome: Promise.resolve(Object.freeze({ ok: false })),
				body: uploadBody,
				response: undefined,
				reader: undefined,
				responseDone: true,
				cleanup: undefined,
				cancelState,
				trigger,
				finishSignals,
			};
			records.add(placeholder);
			return failedAfterDispatch(placeholder, "AMBIGUOUS");
		}
		let fetchOutcome: Promise<FetchOutcome>;
		try {
			if (
				types.isProxy(rawFetch) ||
				Object.getPrototypeOf(rawFetch) !== Promise.prototype ||
				Object.hasOwn(rawFetch, "then")
			) {
				throw new Error("invalid fetch promise");
			}
			fetchOutcome = rawFetch.then(
				(response): FetchOutcome => Object.freeze({ ok: true, response }),
				(): FetchOutcome => Object.freeze({ ok: false }),
			);
		} catch {
			const placeholder: ActiveRequest = {
				abort,
				fetchOutcome: Promise.resolve(Object.freeze({ ok: false })),
				body: uploadBody,
				response: undefined,
				reader: undefined,
				responseDone: true,
				cleanup: undefined,
				cancelState,
				trigger,
				finishSignals,
			};
			records.add(placeholder);
			return failedAfterDispatch(placeholder, "AMBIGUOUS");
		}
		const record: ActiveRequest = {
			abort,
			fetchOutcome,
			body: uploadBody,
			response: undefined,
			reader: undefined,
			responseDone: false,
			cleanup: undefined,
			cancelState,
			trigger,
			finishSignals,
		};
		records.add(record);

		const first = await Promise.race([
			fetchOutcome.then(
				(outcome): Readonly<{ kind: "fetch"; outcome: FetchOutcome }> => Object.freeze({ kind: "fetch", outcome }),
			),
			cancelled.then(
				(code): Readonly<{ kind: "cancel"; code: CancelCode }> => Object.freeze({ kind: "cancel", code }),
			),
		]);
		if (first.kind === "cancel") return failedAfterDispatch(record, first.code);
		if (!first.outcome.ok) return failedAfterDispatch(record, "AMBIGUOUS");
		const response = first.outcome.response;
		record.response = response;
		if (!exactResponse(response)) return failedAfterDispatch(record, "INVALID_RESPONSE");

		if (uploadBody !== undefined) {
			const bodyState = await Promise.race([
				uploadBody.completion.then(
					(result): Readonly<{ kind: "body"; result: ArchiveUploadCompletion }> =>
						Object.freeze({ kind: "body", result }),
				),
				cancelled.then(
					(code): Readonly<{ kind: "cancel"; code: CancelCode }> => Object.freeze({ kind: "cancel", code }),
				),
			]);
			if (bodyState.kind === "cancel") return failedAfterDispatch(record, bodyState.code);
			if (!bodyState.result.ok) return failedAfterDispatch(record, "UPLOAD_SOURCE");
		}
		if (record.cancelState.code !== undefined) return failedAfterDispatch(record, record.cancelState.code);

		if (response.status < 200 || response.status > 299) return failedAfterDispatch(record, "HTTP_STATUS");
		if (!exactHeaders(response.headers)) return failedAfterDispatch(record, "INVALID_RESPONSE");
		const contentLength = response.headers.get("content-length");
		let declaredLength: number | undefined;
		if (contentLength !== null) {
			if (!/^(0|[1-9]\d*)$/.test(contentLength)) return failedAfterDispatch(record, "INVALID_RESPONSE");
			const declared = Number(contentLength);
			if (!safeInteger(declared, 0, responseLimit)) return failedAfterDispatch(record, "BODY_TOO_LARGE");
			declaredLength = declared;
		}
		const stream = response.body;
		if (stream === null) {
			if (declaredLength !== undefined && declaredLength !== 0) {
				return failedAfterDispatch(record, "INVALID_RESPONSE");
			}
			record.responseDone = true;
			record.finishSignals();
			records.delete(record);
			return Object.freeze({ ok: true, status: response.status, body: new Uint8Array(new ArrayBuffer(0)) });
		}
		if (!exactResponseStream(stream)) return failedAfterDispatch(record, "INVALID_RESPONSE");
		let reader: ReadableStreamDefaultReader<Uint8Array>;
		try {
			reader = stream.getReader();
		} catch {
			return failedAfterDispatch(record, "INVALID_RESPONSE");
		}
		if (!exactResponseReader(reader)) {
			record.reader = reader;
			return failedAfterDispatch(record, "INVALID_RESPONSE");
		}
		record.reader = reader;
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let total = 0;
		while (true) {
			let pendingRead: Promise<ReaderResult>;
			try {
				pendingRead = reader.read();
			} catch {
				eraseChunks(chunks);
				return failedAfterDispatch(record, "INVALID_RESPONSE");
			}
			const next = await Promise.race([
				pendingRead.then(
					(value): Readonly<{ kind: "read"; value: ReaderResult }> => Object.freeze({ kind: "read", value }),
					(): Readonly<{ kind: "failed" }> => Object.freeze({ kind: "failed" }),
				),
				cancelled.then(
					(code): Readonly<{ kind: "cancel"; code: CancelCode }> => Object.freeze({ kind: "cancel", code }),
				),
			]);
			if (next.kind === "cancel") {
				eraseChunks(chunks);
				return failedAfterDispatch(record, next.code);
			}
			if (next.kind === "failed") {
				eraseChunks(chunks);
				return failedAfterDispatch(record, "AMBIGUOUS");
			}
			if (next.value.done) break;
			const chunk = copyResponseChunk(next.value.value);
			if (chunk === undefined) {
				eraseChunks(chunks);
				return failedAfterDispatch(record, "INVALID_RESPONSE");
			}
			total += chunk.byteLength;
			if (!Number.isSafeInteger(total) || total > responseLimit) {
				chunk.fill(0);
				eraseChunks(chunks);
				return failedAfterDispatch(record, "BODY_TOO_LARGE");
			}
			chunks.push(chunk);
		}
		try {
			reader.releaseLock();
		} catch {
			eraseChunks(chunks);
			return failedAfterDispatch(record, "CLEANUP_UNCERTAIN");
		}
		record.reader = undefined;
		record.responseDone = true;
		if (declaredLength !== undefined && declaredLength !== total) {
			eraseChunks(chunks);
			return failedAfterDispatch(record, "INVALID_RESPONSE");
		}
		if (record.cancelState.code !== undefined) {
			eraseChunks(chunks);
			return failedAfterDispatch(record, record.cancelState.code);
		}
		const output = new Uint8Array(new ArrayBuffer(total));
		let offset = 0;
		for (const chunk of chunks) {
			output.set(chunk, offset);
			offset += chunk.byteLength;
			chunk.fill(0);
		}
		record.finishSignals();
		records.delete(record);
		return Object.freeze({ ok: true, status: response.status, body: output });
	}

	function controlHeaders(includeJson: boolean): Headers {
		const headers = new Headers();
		headers.set("accept", "application/json");
		headers.set("authorization", `Bearer ${apiKey}`);
		if (includeJson) headers.set("content-type", "application/json");
		return headers;
	}

	async function authenticate(signal: AbortSignal | undefined): Promise<InternalResult<AuthState>> {
		const url = `${CONTROL_ORIGIN}/api/v1/sandbox/${expectedSandboxId}/auth`;
		const result = await request(
			"POST",
			url,
			controlHeaders(false),
			undefined,
			undefined,
			REQUEST_TIMEOUT_MS,
			MAX_RESPONSE_BYTES,
			signal,
		);
		if (!result.ok) return result;
		const auth = parseAuth(result.body, Date.now() + UPLOAD_TIMEOUT_MS + 5_000);
		result.body.fill(0);
		return auth === undefined ? failure("INVALID_RESPONSE") : Object.freeze({ ok: true, value: auth });
	}

	async function listExposures(signal: AbortSignal | undefined): Promise<InternalResult<readonly ExposureRow[]>> {
		const url = `${CONTROL_ORIGIN}/api/v1/sandbox/${expectedSandboxId}/expose`;
		const result = await request(
			"GET",
			url,
			controlHeaders(false),
			undefined,
			undefined,
			REQUEST_TIMEOUT_MS,
			MAX_RESPONSE_BYTES,
			signal,
		);
		if (!result.ok) return result;
		const rows = parseExposureList(result.body, expectedSandboxId);
		result.body.fill(0);
		return rows === undefined ? failure("INVALID_RESPONSE") : Object.freeze({ ok: true, value: rows });
	}

	const port: PrimeSandboxProviderPort = Object.freeze({
		async uploadRelease(source: PreparedArchiveUpload, signal?: AbortSignal): Promise<SandboxProviderResult> {
			if (closed) return failure("CLOSED");
			if (!isPreparedArchiveUpload(source)) return failure("INPUT_INVALID");
			let taken: ReturnType<PreparedArchiveUpload["take"]>;
			try {
				taken = source.take();
			} catch {
				return failure("INPUT_INVALID");
			}
			if (!taken.ok) return failure("UPLOAD_SOURCE");
			const body = taken.value;
			if (
				!safeInteger(body.archiveSize, 1, MAX_ARCHIVE_BYTES) ||
				!safeInteger(body.contentLength, body.archiveSize + 1, MAX_ARCHIVE_BYTES + 4096)
			) {
				return failedBeforeDispatch(body, "UPLOAD_SOURCE");
			}
			const authResult = await authenticate(signal);
			if (!authResult.ok) return failedBeforeDispatch(body, authResult.code);
			const auth = authResult.value;
			const url = new URL(`${auth.gatewayBase}/${auth.userNs}/${auth.jobId}/upload`);
			url.searchParams.set("path", REMOTE_ARCHIVE_PATH);
			url.searchParams.set("sandbox_id", expectedSandboxId);
			const headers = new Headers();
			headers.set("accept", "application/json");
			headers.set("authorization", `Bearer ${auth.token}`);
			headers.set("content-type", body.contentType);
			headers.set("content-length", String(body.contentLength));
			const result = await request(
				"POST",
				url.href,
				headers,
				undefined,
				body,
				UPLOAD_TIMEOUT_MS,
				MAX_RESPONSE_BYTES,
				signal,
			);
			if (!result.ok) return result;
			const valid = validUpload(result.body, body.archiveSize);
			result.body.fill(0);
			return valid ? success() : failure("INVALID_RESPONSE");
		},

		async exposeRuntime(signal?: AbortSignal): Promise<SandboxProviderResult> {
			if (closed) return failure("CLOSED");
			const before = await listExposures(signal);
			if (!before.ok) return before;
			for (const row of before.value) {
				if (row.port === RUNTIME_PORT || row.name === EXPOSURE_NAME) return failure("EXPOSURE_CONFLICT");
			}
			exposureAbsenceProven = true;
			const body = encodeJson('{"port":9443,"name":"prime-agent-runtime-v1","protocol":"TCP"}');
			const headers = controlHeaders(true);
			headers.set("content-length", String(body.byteLength));
			const url = `${CONTROL_ORIGIN}/api/v1/sandbox/${expectedSandboxId}/expose`;
			exposureAbsenceProven = false;
			const result = await request(
				"POST",
				url,
				headers,
				body,
				undefined,
				REQUEST_TIMEOUT_MS,
				MAX_RESPONSE_BYTES,
				signal,
			);
			body.fill(0);
			if (!result.ok) return result;
			const parsed = parseExposure(result.body, expectedSandboxId);
			result.body.fill(0);
			if (parsed === undefined) return failure("INVALID_RESPONSE");
			exposure = parsed.state;
			return success();
		},

		async unexposeAndProveAbsent(signal?: AbortSignal): Promise<SandboxProviderResult> {
			if (closed) return failure("CLOSED");
			let currentId = exposure?.exposureId;
			if (currentId === undefined) {
				const before = await listExposures(signal);
				if (!before.ok) return before;
				let owned: ExposureRow | undefined;
				for (const row of before.value) {
					const exact = row.port === RUNTIME_PORT && row.name === EXPOSURE_NAME;
					const blocks = row.port === RUNTIME_PORT || row.name === EXPOSURE_NAME;
					if (exact && owned === undefined) owned = row;
					else if (blocks) return failure("ABSENCE_UNPROVEN");
				}
				if (owned === undefined) {
					exposure = undefined;
					exposureAbsenceProven = true;
					return success();
				}
				currentId = owned.exposureId;
			}
			const url = `${CONTROL_ORIGIN}/api/v1/sandbox/${expectedSandboxId}/expose/${currentId}`;
			const removed = await request(
				"DELETE",
				url,
				controlHeaders(false),
				undefined,
				undefined,
				REQUEST_TIMEOUT_MS,
				64 * 1024,
				signal,
			);
			if (!removed.ok) return removed;
			removed.body.fill(0);
			const rows = await listExposures(signal);
			if (!rows.ok) return rows;
			for (const row of rows.value) {
				if (row.exposureId === currentId || row.port === RUNTIME_PORT || row.name === EXPOSURE_NAME) {
					return failure("ABSENCE_UNPROVEN");
				}
			}
			exposure = undefined;
			exposureAbsenceProven = true;
			return success();
		},

		async close(): Promise<SandboxProviderResult> {
			const mayFinalize = exposure === undefined && exposureAbsenceProven;
			const pending: Promise<boolean>[] = [];
			for (const body of bodyCleanups) {
				const operation = settleUploadBody(body);
				operation
					.then((ok) => {
						if (ok) bodyCleanups.delete(body);
					})
					.catch(() => {});
				pending.push(settleWithin(operation, CLEANUP_TIMEOUT_MS));
			}
			for (const record of records) {
				record.trigger("CLOSED");
				record.finishSignals();
				pending.push(cleanupWithin(record));
			}
			const results = await Promise.all(pending);
			for (const result of results) if (!result) return failure("CLEANUP_UNCERTAIN");
			if (records.size !== 0 || bodyCleanups.size !== 0) return failure("CLEANUP_UNCERTAIN");
			if (!mayFinalize) return failure("ABSENCE_UNPROVEN");
			closed = true;
			return success();
		},
	});
	return Object.freeze({ ok: true, value: port });
}
