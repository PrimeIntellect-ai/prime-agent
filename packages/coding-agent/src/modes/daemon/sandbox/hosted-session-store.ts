import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import {
	appendGenesis,
	appendTransition,
	inventory,
	type LedgerIdentity,
	type LedgerRecord,
	type LedgerRecordBytes,
	mintRecordBytes,
	reveal,
} from "./hosted-child-ledger.js";
import {
	decodeHostedSessionWalRecord,
	encodeHostedSessionWalRecord,
	type HostedSessionWalRecord,
	verifyHostedSessionWalChain,
} from "./hosted-session-wal.js";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

export type ProviderWalState =
	| "ALLOCATED"
	| "CREATE_DISPATCHED"
	| "PRESENT"
	| "RUNTIME_DISPATCHED"
	| "RUNNING"
	| "DELETE_DISPATCHED"
	| "ABSENT"
	| "RETIRED_ABSENT";

export type FixedStoreResult = { code: "COMMITTED" } | { code: "STALE" } | { code: "INVALID" } | { code: "FAILED" };

export interface HostedSessionStore {
	inventory(): Promise<{ code: "INVENTORIED"; sessions: readonly object[] } | { code: "FAILED" }>;
	allocate(
		identityRaw: unknown,
		digestsRaw: unknown,
	): Promise<{ code: "ALLOCATED"; session: object } | { code: "EXISTS"; session: object } | { code: "FAILED" }>;
	state(
		sessionRaw: unknown,
	): Promise<{ code: "STATE"; state: ProviderWalState } | { code: "INVALID" } | { code: "FAILED" }>;
	createDispatched(sessionRaw: unknown): Promise<FixedStoreResult>;
	present(sessionRaw: unknown): Promise<FixedStoreResult>;
	runtimeDispatched(sessionRaw: unknown): Promise<FixedStoreResult>;
	running(sessionRaw: unknown): Promise<FixedStoreResult>;
	deleteDispatched(sessionRaw: unknown, terminalRaw: unknown): Promise<FixedStoreResult>;
	cleanupUncertain(sessionRaw: unknown): Promise<FixedStoreResult>;
	absent(sessionRaw: unknown): Promise<FixedStoreResult>;
	retireAndAdvance(sessionRaw: unknown): Promise<FixedStoreResult>;
	purge(sessionRaw: unknown): Promise<FixedStoreResult>;
	close(): Promise<{ code: "CLOSED" } | { code: "FAILED" }>;
}

type TerminalStatus = "completed" | "error" | "cancelled";
type TerminalCode =
	| "SUCCESS"
	| "FAILURE"
	| "TIMEOUT"
	| "EVICTED"
	| "USER_STOP"
	| "PARENT_STOP"
	| "REVOKED"
	| "MAX_DEPTH"
	| "INTERNAL"
	| "UNKNOWN";

interface TerminalPair {
	readonly terminalStatus: TerminalStatus;
	readonly terminalCode: TerminalCode;
}

interface SessionSemanticState {
	readonly identity: LedgerIdentity;
	readonly providerState: ProviderWalState;
	readonly generationKey: string;
	readonly releaseDigest: string;
	readonly manifestDigest: string;
	readonly bootstrapDigest: string;
	readonly trustDigest: string;
	readonly runtimeConfigDigest: string;
}

interface RegistryIssueResult {
	readonly code: "ISSUED" | "INVALID";
	readonly session?: object;
}

interface RegistryReadResult {
	readonly code: "KNOWN" | "UNKNOWN";
	readonly state?: SessionSemanticState;
}

interface RegistryReplaceResult {
	readonly code: "REPLACED" | "STALE" | "INVALID";
}

interface RegistryPort {
	receiver: object;
	issueLoaded(identityRaw: unknown, stateRaw: unknown): unknown;
	read(sessionRaw: unknown): unknown;
	replace(sessionRaw: unknown, expectedRaw: unknown, nextRaw: unknown): unknown;
}

interface DigestCopies {
	releaseDigest: Uint8Array;
	manifestDigest: Uint8Array;
	bootstrapDigest: Uint8Array;
	trustDigest: Uint8Array;
	runtimeConfigDigest: Uint8Array;
}

interface GenerationData {
	key: Uint8Array;
	keyHex: string;
	raw: Uint8Array[];
	decoded: HostedSessionWalRecord[];
	headDigest: Uint8Array;
}

interface StoreRow {
	identity: LedgerIdentity;
	lifecycle: Uint8Array;
	lifecycleHex: string;
	identityDigest: Uint8Array;
	digests: DigestCopies;
	generation: GenerationData;
	ledgerWrappers: LedgerRecordBytes[];
	ledgerRecords: LedgerRecord[];
	ledgerDigest: Uint8Array;
	terminal: TerminalPair | undefined;
	session: object | undefined;
	semantic: SessionSemanticState;
}

interface HelperSuccess {
	readonly ok: true;
	readonly payloads: readonly Uint8Array[];
}

interface HelperFailure {
	readonly ok: false;
	readonly errorCode: number;
}

type HelperResult = HelperSuccess | HelperFailure;

interface PendingCommand {
	opcode: number;
	inventory: boolean;
	inspect: boolean;
	payloads: Uint8Array[];
	resolve: (result: HelperResult) => void;
	frame: Uint8Array;
	writeCallback: boolean;
	drain: boolean;
	response: HelperResult | undefined;
	timer: ReturnType<typeof setTimeout>;
}

interface QueuedOperation {
	start: () => void;
}

const _Promise = Promise;
const _promisePrototype = _Promise.prototype;
const _promiseThen = _promisePrototype.then;
const _promiseCatch = _promisePrototype.catch;
const _promiseFinally = _promisePrototype.finally;
const _reflectApply = Reflect.apply;
const _freeze = Object.freeze;
const _getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertyNames = Object.getOwnPropertyNames;
const _getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _isFrozen = Object.isFrozen;
const _isProxy = types.isProxy;
const _createHash = createHash;
const _randomFillSync = randomFillSync;
const _spawn = spawn;
const _openSync = openSync;
const _closeSync = closeSync;
const _fstatSync = fstatSync;
const _lstatSync = lstatSync;
const _readSync = readSync;
const _setTimeout = setTimeout;
const _clearTimeout = clearTimeout;
const _kill = process.kill;
const _hrtimeBigint = process.hrtime.bigint;
const _euid = process.geteuid;
const _ObjectPrototype = Object.prototype;
const _ArrayPrototype = Array.prototype;

const HELPER_NAME = "hosted-session-store-posix-helper.py";
const HELPER_SIZE = 159255;
const HELPER_DIGEST = "3107f2126945a6664875d07c66578ee93fabb097364222b353c40f440918558c";
const MAX_PAYLOAD = 1_048_576;
const MAX_UNPARSED = 1_048_581;
const MAX_STDERR = 65_536;
const HEADER_SIZE = 5;
const WAL_SIZE = 320;
const LEDGER_BOUNDS = _freeze({ maxRecords: 16, maxBytes: 262128, maxRecordBytes: 16384, maxGroups: 1 });
const HEX64 = /^[0-9a-f]{64}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const FORBIDDEN_UNICODE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const OPEN = 0xfe;
const QUIT = 0xff;
const INVENTORY = 0x01;
const CREATE_SESSION = 0x02;
const APPEND_WAL = 0x03;
const APPEND_LEDGER = 0x04;
const PREPARE_GENERATION = 0x05;
const SWITCH_HEAD = 0x06;
const REMOVE_RETIRED = 0x07;
const PURGE = 0x08;
const INSPECT_SESSION = 0x09;
const OK = 0x80;
const SESSION = 0x81;
const DONE = 0x82;
const ERROR = 0xe0;
const ABSENT_ERROR = 0x04;

function failedResult(): { code: "FAILED" } {
	return _freeze({ code: "FAILED" });
}

function committedResult(): { code: "COMMITTED" } {
	return _freeze({ code: "COMMITTED" });
}

function staleResult(): { code: "STALE" } {
	return _freeze({ code: "STALE" });
}

function invalidResult(): { code: "INVALID" } {
	return _freeze({ code: "INVALID" });
}

function closedResult(): { code: "CLOSED" } {
	return _freeze({ code: "CLOSED" });
}

const STATE_NAMES: readonly ProviderWalState[] = _freeze([
	"ALLOCATED",
	"CREATE_DISPATCHED",
	"PRESENT",
	"RUNTIME_DISPATCHED",
	"RUNNING",
	"DELETE_DISPATCHED",
	"ABSENT",
	"RETIRED_ABSENT",
]);

const IDENTITY_KEYS: readonly string[] = _freeze([
	"sessionId",
	"activeSessionId",
	"childId",
	"name",
	"modelSelector",
	"durableParentSessionId",
	"rlmParentNodeId",
	"spawnedByRequestId",
	"thinkingLevel",
	"serviceTier",
	"spawnContextDigest",
	"depth",
]);
const ACCEPTED_IDENTITY_KEYS: readonly string[] = _freeze([
	"schema",
	"lifecycleKeyDigest",
	"sessionId",
	"activeSessionId",
	"childId",
	"name",
	"modelSelector",
	"durableParentSessionId",
	"rlmParentNodeId",
	"spawnedByRequestId",
	"thinkingLevel",
	"serviceTier",
	"spawnContextDigest",
	"depth",
]);
const DIGEST_KEYS: readonly string[] = _freeze([
	"releaseDigest",
	"manifestDigest",
	"bootstrapDigest",
	"trustDigest",
	"runtimeConfigDigest",
]);
const STATE_KEYS: readonly string[] = _freeze([
	"identity",
	"providerState",
	"generationKey",
	"releaseDigest",
	"manifestDigest",
	"bootstrapDigest",
	"trustDigest",
	"runtimeConfigDigest",
]);
const TERMINAL_KEYS: readonly string[] = _freeze(["terminalStatus", "terminalCode"]);
const REGISTRY_KEYS: readonly string[] = _freeze(["issueLoaded", "read", "replace"]);
const THINKING: readonly string[] = _freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TIERS: readonly string[] = _freeze(["auto", "default", "flex", "scale", "priority"]);
const TERMINAL_STATUSES: readonly string[] = _freeze(["completed", "error", "cancelled"]);
const TERMINAL_CODES: readonly string[] = _freeze([
	"SUCCESS",
	"FAILURE",
	"TIMEOUT",
	"EVICTED",
	"USER_STOP",
	"PARENT_STOP",
	"REVOKED",
	"MAX_DEPTH",
	"INTERNAL",
	"UNKNOWN",
]);

function ownedPromise<T>(executor: (resolve: (value: T) => void) => void): Promise<T> {
	return new _Promise<T>((resolve) => executor(resolve));
}

function zeroBytes(value: Uint8Array): void {
	for (let index = 0; index < value.byteLength; index += 1) value[index] = 0;
}

function zeroList(values: Uint8Array[]): void {
	for (let index = 0; index < values.length; index += 1) zeroBytes(values[index]);
	values.length = 0;
}

function copyRange(source: Uint8Array, start: number, end: number): Uint8Array {
	const output = new Uint8Array(end - start);
	for (let index = start; index < end; index += 1) output[index - start] = source[index];
	return output;
}

function copyBytes(source: Uint8Array): Uint8Array {
	return copyRange(source, 0, source.byteLength);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
	return difference === 0;
}

function bytesHex(value: Uint8Array): string {
	let output = "";
	for (let index = 0; index < value.byteLength; index += 1) output += value[index].toString(16).padStart(2, "0");
	return output;
}

function hexBytes(value: string): Uint8Array | undefined {
	if (!HEX64.test(value)) return undefined;
	const output = new Uint8Array(32);
	for (let index = 0; index < 32; index += 1) {
		const parsed = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
		if (!Number.isSafeInteger(parsed)) {
			zeroBytes(output);
			return undefined;
		}
		output[index] = parsed;
	}
	return output;
}

function sha256(value: Uint8Array): Uint8Array | undefined {
	let digest: Buffer | undefined;
	try {
		digest = _createHash("sha256").update(value).digest();
		return copyRange(digest, 0, 32);
	} catch {
		if (digest !== undefined) zeroBytes(digest);
		return undefined;
	} finally {
		if (digest !== undefined) zeroBytes(digest);
	}
}

function exactFrozenObject(value: unknown, keys: readonly string[]): value is object {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (_isProxy(value) || _getPrototypeOf(value) !== _ObjectPrototype || !_isFrozen(value)) return false;
		if (_getOwnPropertySymbols(value).length !== 0) return false;
		const names = _getOwnPropertyNames(value);
		if (names.length !== keys.length) return false;
		for (let index = 0; index < keys.length; index += 1) {
			if (names[index] !== keys[index]) return false;
			const descriptor = _getOwnPropertyDescriptor(value, keys[index]);
			if (
				descriptor === undefined ||
				descriptor.get !== undefined ||
				descriptor.set !== undefined ||
				descriptor.enumerable !== true ||
				descriptor.writable !== false ||
				descriptor.configurable !== false
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

function dataValue(value: object, name: string): unknown {
	try {
		const descriptor = _getOwnPropertyDescriptor(value, name);
		if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
		return descriptor.value;
	} catch {
		return undefined;
	}
}

function validAscii(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxBytes && PRINTABLE_ASCII.test(value);
}

function validUnicode(value: unknown, maxBytes: number): value is string {
	if (typeof value !== "string" || value.length === 0 || FORBIDDEN_UNICODE.test(value)) return false;
	try {
		return new TextEncoder().encode(value).byteLength <= maxBytes;
	} catch {
		return false;
	}
}

function hasValidUnicodeScalars(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
	}
	return true;
}

function stringMember(value: string, choices: readonly string[]): boolean {
	for (let index = 0; index < choices.length; index += 1) if (choices[index] === value) return true;
	return false;
}

function isThinking(value: unknown): value is LedgerIdentity["thinkingLevel"] {
	return typeof value === "string" && stringMember(value, THINKING);
}

function isTier(value: unknown): value is LedgerIdentity["serviceTier"] {
	return value === null || (typeof value === "string" && stringMember(value, TIERS));
}

function isProviderState(value: unknown): value is ProviderWalState {
	if (typeof value !== "string") return false;
	for (let index = 0; index < STATE_NAMES.length; index += 1) if (STATE_NAMES[index] === value) return true;
	return false;
}

function isTerminalStatus(value: unknown): value is TerminalStatus {
	return typeof value === "string" && stringMember(value, TERMINAL_STATUSES);
}

function isTerminalCode(value: unknown): value is TerminalCode {
	return typeof value === "string" && stringMember(value, TERMINAL_CODES);
}

function validIdentityInput(value: unknown): value is object {
	if (!exactFrozenObject(value, IDENTITY_KEYS)) return false;
	const sessionId = dataValue(value, "sessionId");
	const activeSessionId = dataValue(value, "activeSessionId");
	const childId = dataValue(value, "childId");
	const name = dataValue(value, "name");
	const modelSelector = dataValue(value, "modelSelector");
	const durableParentSessionId = dataValue(value, "durableParentSessionId");
	const rlmParentNodeId = dataValue(value, "rlmParentNodeId");
	const spawnedByRequestId = dataValue(value, "spawnedByRequestId");
	const thinkingLevel = dataValue(value, "thinkingLevel");
	const serviceTier = dataValue(value, "serviceTier");
	const spawnContextDigest = dataValue(value, "spawnContextDigest");
	const depth = dataValue(value, "depth");
	if (
		!validAscii(sessionId, 1024) ||
		!validAscii(activeSessionId, 1024) ||
		!validAscii(childId, 1024) ||
		!validUnicode(name, 2048) ||
		!hasValidUnicodeScalars(name) ||
		!validUnicode(modelSelector, 4096) ||
		!hasValidUnicodeScalars(modelSelector) ||
		!validAscii(durableParentSessionId, 1024) ||
		!validAscii(rlmParentNodeId, 1024)
	)
		return false;
	if (spawnedByRequestId !== null && !validAscii(spawnedByRequestId, 1024)) return false;
	if (!isThinking(thinkingLevel)) return false;
	if (!isTier(serviceTier)) return false;
	if (typeof spawnContextDigest !== "string" || !HEX64.test(spawnContextDigest)) return false;
	return typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0;
}

function copyAcceptedIdentity(value: unknown): LedgerIdentity | undefined {
	if (!exactFrozenObject(value, ACCEPTED_IDENTITY_KEYS)) return undefined;
	const schema = dataValue(value, "schema");
	const lifecycleKeyDigest = dataValue(value, "lifecycleKeyDigest");
	const sessionId = dataValue(value, "sessionId");
	const activeSessionId = dataValue(value, "activeSessionId");
	const childId = dataValue(value, "childId");
	const name = dataValue(value, "name");
	const modelSelector = dataValue(value, "modelSelector");
	const durableParentSessionId = dataValue(value, "durableParentSessionId");
	const rlmParentNodeId = dataValue(value, "rlmParentNodeId");
	const spawnedByRequestId = dataValue(value, "spawnedByRequestId");
	const thinkingLevel = dataValue(value, "thinkingLevel");
	const serviceTier = dataValue(value, "serviceTier");
	const spawnContextDigest = dataValue(value, "spawnContextDigest");
	const depth = dataValue(value, "depth");
	if (
		schema !== "hosted-child-ledger-v1" ||
		typeof lifecycleKeyDigest !== "string" ||
		!HEX64.test(lifecycleKeyDigest)
	) {
		return undefined;
	}
	if (
		!validAscii(sessionId, 1024) ||
		!validAscii(activeSessionId, 1024) ||
		!validAscii(childId, 1024) ||
		!validUnicode(name, 2048) ||
		!hasValidUnicodeScalars(name) ||
		!validUnicode(modelSelector, 4096) ||
		!hasValidUnicodeScalars(modelSelector) ||
		!validAscii(durableParentSessionId, 1024) ||
		!validAscii(rlmParentNodeId, 1024)
	)
		return undefined;
	if (spawnedByRequestId !== null && !validAscii(spawnedByRequestId, 1024)) return undefined;
	if (!isThinking(thinkingLevel)) return undefined;
	if (!isTier(serviceTier)) return undefined;
	if (typeof spawnContextDigest !== "string" || !HEX64.test(spawnContextDigest)) return undefined;
	if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0) return undefined;
	return _freeze({
		schema,
		lifecycleKeyDigest,
		sessionId,
		activeSessionId,
		childId,
		name,
		modelSelector,
		durableParentSessionId,
		rlmParentNodeId,
		spawnedByRequestId,
		thinkingLevel,
		serviceTier,
		spawnContextDigest,
		depth,
	});
}

function sameIdentity(left: LedgerIdentity, right: LedgerIdentity): boolean {
	return (
		left.schema === right.schema &&
		left.lifecycleKeyDigest === right.lifecycleKeyDigest &&
		left.sessionId === right.sessionId &&
		left.activeSessionId === right.activeSessionId &&
		left.childId === right.childId &&
		left.name === right.name &&
		left.modelSelector === right.modelSelector &&
		left.durableParentSessionId === right.durableParentSessionId &&
		left.rlmParentNodeId === right.rlmParentNodeId &&
		left.spawnedByRequestId === right.spawnedByRequestId &&
		left.thinkingLevel === right.thinkingLevel &&
		left.serviceTier === right.serviceTier &&
		left.spawnContextDigest === right.spawnContextDigest &&
		left.depth === right.depth
	);
}

function copyDigestInput(value: unknown): DigestCopies | undefined {
	if (!exactFrozenObject(value, DIGEST_KEYS)) return undefined;
	const owned: Uint8Array[] = [];
	for (let index = 0; index < DIGEST_KEYS.length; index += 1) {
		const copied = copySandboxStrictBytes(dataValue(value, DIGEST_KEYS[index]), 32);
		if (copied.ok === false || copied.value.byteLength !== 32) {
			zeroList(owned);
			return undefined;
		}
		owned[owned.length] = copied.value;
	}
	return {
		releaseDigest: owned[0],
		manifestDigest: owned[1],
		bootstrapDigest: owned[2],
		trustDigest: owned[3],
		runtimeConfigDigest: owned[4],
	};
}

function zeroDigests(value: DigestCopies): void {
	zeroBytes(value.releaseDigest);
	zeroBytes(value.manifestDigest);
	zeroBytes(value.bootstrapDigest);
	zeroBytes(value.trustDigest);
	zeroBytes(value.runtimeConfigDigest);
}

function sameDigests(left: DigestCopies, right: DigestCopies): boolean {
	return (
		sameBytes(left.releaseDigest, right.releaseDigest) &&
		sameBytes(left.manifestDigest, right.manifestDigest) &&
		sameBytes(left.bootstrapDigest, right.bootstrapDigest) &&
		sameBytes(left.trustDigest, right.trustDigest) &&
		sameBytes(left.runtimeConfigDigest, right.runtimeConfigDigest)
	);
}

function makeSemantic(
	identity: LedgerIdentity,
	providerState: ProviderWalState,
	generationKey: string,
	digests: DigestCopies,
): SessionSemanticState {
	const identityCopy = copyAcceptedIdentity(identity);
	if (identityCopy === undefined)
		return _freeze({
			identity,
			providerState,
			generationKey,
			releaseDigest: bytesHex(digests.releaseDigest),
			manifestDigest: bytesHex(digests.manifestDigest),
			bootstrapDigest: bytesHex(digests.bootstrapDigest),
			trustDigest: bytesHex(digests.trustDigest),
			runtimeConfigDigest: bytesHex(digests.runtimeConfigDigest),
		});
	return _freeze({
		identity: identityCopy,
		providerState,
		generationKey,
		releaseDigest: bytesHex(digests.releaseDigest),
		manifestDigest: bytesHex(digests.manifestDigest),
		bootstrapDigest: bytesHex(digests.bootstrapDigest),
		trustDigest: bytesHex(digests.trustDigest),
		runtimeConfigDigest: bytesHex(digests.runtimeConfigDigest),
	});
}

function copySemantic(value: unknown): SessionSemanticState | undefined {
	if (!exactFrozenObject(value, STATE_KEYS)) return undefined;
	const identity = copyAcceptedIdentity(dataValue(value, "identity"));
	const providerState = dataValue(value, "providerState");
	const generationKey = dataValue(value, "generationKey");
	const releaseDigest = dataValue(value, "releaseDigest");
	const manifestDigest = dataValue(value, "manifestDigest");
	const bootstrapDigest = dataValue(value, "bootstrapDigest");
	const trustDigest = dataValue(value, "trustDigest");
	const runtimeConfigDigest = dataValue(value, "runtimeConfigDigest");
	if (identity === undefined || !isProviderState(providerState)) return undefined;
	if (typeof generationKey !== "string" || !HEX64.test(generationKey)) return undefined;
	if (
		typeof releaseDigest !== "string" ||
		!HEX64.test(releaseDigest) ||
		typeof manifestDigest !== "string" ||
		!HEX64.test(manifestDigest) ||
		typeof bootstrapDigest !== "string" ||
		!HEX64.test(bootstrapDigest) ||
		typeof trustDigest !== "string" ||
		!HEX64.test(trustDigest) ||
		typeof runtimeConfigDigest !== "string" ||
		!HEX64.test(runtimeConfigDigest)
	)
		return undefined;
	return _freeze({
		identity,
		providerState,
		generationKey,
		releaseDigest,
		manifestDigest,
		bootstrapDigest,
		trustDigest,
		runtimeConfigDigest,
	});
}

function sameSemantic(left: SessionSemanticState, right: SessionSemanticState): boolean {
	return (
		sameIdentity(left.identity, right.identity) &&
		left.providerState === right.providerState &&
		left.generationKey === right.generationKey &&
		left.releaseDigest === right.releaseDigest &&
		left.manifestDigest === right.manifestDigest &&
		left.bootstrapDigest === right.bootstrapDigest &&
		left.trustDigest === right.trustDigest &&
		left.runtimeConfigDigest === right.runtimeConfigDigest
	);
}

function validTerminal(value: unknown): TerminalPair | undefined {
	if (!exactFrozenObject(value, TERMINAL_KEYS)) return undefined;
	const status = dataValue(value, "terminalStatus");
	const code = dataValue(value, "terminalCode");
	if (!isTerminalStatus(status)) return undefined;
	if (!isTerminalCode(code)) return undefined;
	return _freeze({ terminalStatus: status, terminalCode: code });
}

function validateRegistry(value: unknown): RegistryPort | undefined {
	if (!exactFrozenObject(value, REGISTRY_KEYS)) return undefined;
	const issueLoaded = dataValue(value, "issueLoaded");
	const read = dataValue(value, "read");
	const replace = dataValue(value, "replace");
	if (typeof issueLoaded !== "function" || typeof read !== "function" || typeof replace !== "function")
		return undefined;
	return _freeze({
		receiver: value,
		issueLoaded: (identityRaw: unknown, stateRaw: unknown): unknown =>
			_reflectApply(issueLoaded, value, [identityRaw, stateRaw]),
		read: (sessionRaw: unknown): unknown => _reflectApply(read, value, [sessionRaw]),
		replace: (sessionRaw: unknown, expectedRaw: unknown, nextRaw: unknown): unknown =>
			_reflectApply(replace, value, [sessionRaw, expectedRaw, nextRaw]),
	});
}

function nativePromise(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	try {
		return !_isProxy(value) && _getPrototypeOf(value) === _promisePrototype;
	} catch {
		return false;
	}
}

function registryIssueShape(value: unknown): RegistryIssueResult | undefined {
	if (exactFrozenObject(value, _freeze(["code"]))) {
		if (dataValue(value, "code") === "INVALID") return _freeze({ code: "INVALID" });
		return undefined;
	}
	if (!exactFrozenObject(value, _freeze(["code", "session"]))) return undefined;
	if (dataValue(value, "code") !== "ISSUED") return undefined;
	const session = dataValue(value, "session");
	if (typeof session !== "object" || session === null) return undefined;
	return _freeze({ code: "ISSUED", session });
}

function registryReadShape(value: unknown): RegistryReadResult | undefined {
	if (exactFrozenObject(value, _freeze(["code"]))) {
		if (dataValue(value, "code") === "UNKNOWN") return _freeze({ code: "UNKNOWN" });
		return undefined;
	}
	if (!exactFrozenObject(value, _freeze(["code", "state"]))) return undefined;
	if (dataValue(value, "code") !== "KNOWN") return undefined;
	const state = copySemantic(dataValue(value, "state"));
	if (state === undefined) return undefined;
	return _freeze({ code: "KNOWN", state });
}

function registryReplaceShape(value: unknown): RegistryReplaceResult | undefined {
	if (!exactFrozenObject(value, _freeze(["code"]))) return undefined;
	const code = dataValue(value, "code");
	if (code !== "REPLACED" && code !== "STALE" && code !== "INVALID") return undefined;
	return _freeze({ code });
}

interface ValidatedHelper {
	fd: number;
	scriptName: string;
}

function sameStat(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.isFile() === right.isFile()
	);
}

function validateHelper(): ValidatedHelper | undefined {
	let modulePath: string | undefined;
	let anchorPath: string | undefined;
	let candidate: string | undefined;
	let scriptName: string | undefined;
	const url = import.meta.url;
	const virtual = url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
	try {
		if (virtual) {
			anchorPath = process.execPath;
			candidate = resolve(dirname(process.execPath), HELPER_NAME);
		} else {
			modulePath = fileURLToPath(url);
			anchorPath = modulePath;
			const directory = normalize(dirname(modulePath));
			const slashDirectory = directory.replaceAll("\\", "/");
			let modes = 0;
			if (slashDirectory.endsWith("/src/modes/daemon/sandbox")) modes += 1;
			if (slashDirectory.endsWith("/dist/modes/daemon/sandbox")) modes += 1;
			if (slashDirectory.endsWith("/dist/bundle")) modes += 1;
			if (modes !== 1) return undefined;
			candidate = resolve(directory, HELPER_NAME);
		}
		scriptName =
			process.platform === "darwin" ? "/dev/fd/3" : process.platform === "linux" ? "/proc/self/fd/3" : undefined;
		if (anchorPath === undefined || candidate === undefined || scriptName === undefined) return undefined;
		const anchor = _lstatSync(anchorPath, { bigint: false });
		const pathStat = _lstatSync(candidate, { bigint: false });
		if (typeof _euid !== "function") return undefined;
		const closeOnExec = process.platform === "darwin" ? 0x01000000 : 0x00080000;
		const flags = constants.O_RDONLY | constants.O_NOFOLLOW | closeOnExec;
		const fd = _openSync(candidate, flags);
		let keep = false;
		try {
			const before = _fstatSync(fd, { bigint: false });
			if (pathStat.dev !== before.dev || pathStat.ino !== before.ino) return undefined;
			if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o644) return undefined;
			if ((before.mode & 0o7000) !== 0 || (before.mode & 0o022) !== 0) return undefined;
			const euid = _euid();
			if ((before.uid !== euid && before.uid !== 0) || before.uid !== anchor.uid || before.gid !== anchor.gid)
				return undefined;
			if (before.size !== HELPER_SIZE) return undefined;
			const hash = _createHash("sha256");
			const buffer = new Uint8Array(65_536);
			let position = 0;
			try {
				while (position < before.size) {
					const wanted = Math.min(buffer.byteLength, before.size - position);
					const count = _readSync(fd, buffer, 0, wanted, position);
					if (count <= 0 || count > wanted) return undefined;
					const chunk = copyRange(buffer, 0, count);
					try {
						hash.update(chunk);
					} finally {
						zeroBytes(chunk);
					}
					position += count;
				}
				if (position !== before.size || hash.digest("hex") !== HELPER_DIGEST) return undefined;
			} finally {
				zeroBytes(buffer);
			}
			const after = _fstatSync(fd, { bigint: false });
			if (!sameStat(before, after)) return undefined;
			keep = true;
			return { fd, scriptName };
		} finally {
			if (!keep) {
				try {
					_closeSync(fd);
				} catch {
					keep = false;
				}
			}
		}
	} catch {
		return undefined;
	}
}

function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array | undefined {
	if (payload.byteLength > MAX_PAYLOAD) return undefined;
	const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
	frame[0] = opcode;
	const view = new DataView(frame.buffer);
	view.setUint32(1, payload.byteLength, false);
	for (let index = 0; index < payload.byteLength; index += 1) frame[HEADER_SIZE + index] = payload[index];
	return frame;
}

function errorCode(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		const descriptor = _getOwnPropertyDescriptor(value, "code");
		return descriptor !== undefined && typeof descriptor.value === "string" ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function delay(milliseconds: number): Promise<void> {
	return new _Promise<void>((resolveDelay) => {
		_setTimeout(resolveDelay, milliseconds);
	});
}

class HelperOwner {
	private child: ChildProcess | undefined;
	private pending: PendingCommand | undefined;
	private stdout: Uint8Array = new Uint8Array(0);
	private stderrBytes = 0;
	private poisoned = false;
	private quitting = false;
	private spawned = false;
	private exited = false;
	private exitCode: number | null = null;
	private exitSignal: NodeJS.Signals | null = null;
	private stdoutClosed = false;
	private stderrClosed = false;
	private stdinClosed = false;
	private revokePromise: Promise<boolean> | undefined;
	private retainedPromises = new Set<object>();
	private retainedWrites: PendingCommand[] = [];

	isPoisoned(): boolean {
		return this.poisoned;
	}

	start(validated: ValidatedHelper): Promise<boolean> {
		return new _Promise<boolean>((resolveStart) => {
			let child: ChildProcess | undefined;
			try {
				const executable = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
				child = _spawn(executable, [validated.scriptName], {
					cwd: "/",
					env: {},
					detached: true,
					stdio: ["pipe", "pipe", "pipe", validated.fd],
				});
			} catch {
				try {
					_closeSync(validated.fd);
				} catch {
					this.poisoned = true;
				}
				resolveStart(false);
				return;
			}
			if (child.stdin === null || child.stdout === null || child.stderr === null) {
				try {
					_closeSync(validated.fd);
				} catch {
					this.poisoned = true;
				}
				resolveStart(false);
				return;
			}
			const spawnedChild = child;
			this.child = spawnedChild;
			this.bindChild(spawnedChild);
			let settled = false;
			spawnedChild.once("spawn", () => {
				if (settled) return;
				settled = true;
				this.spawned = true;
				let descriptorClosed = true;
				try {
					_closeSync(validated.fd);
				} catch {
					descriptorClosed = false;
				}
				if (!descriptorClosed) {
					this.fatal();
					resolveStart(false);
					return;
				}
				const opened = this.command(OPEN, new Uint8Array(0), 30_000, false);
				this.retain(opened);
				const observer = _reflectApply(_promiseThen, opened, [
					(result: HelperResult) => resolveStart(result.ok),
					() => {
						this.fatal();
						resolveStart(false);
					},
				]);
				this.retain(observer);
			});
			spawnedChild.once("error", () => {
				if (!settled) {
					settled = true;
					try {
						_closeSync(validated.fd);
					} catch {
						this.poisoned = true;
					}
					resolveStart(false);
				}
				this.fatal();
			});
		});
	}

	private retain(value: unknown): void {
		if (typeof value === "object" && value !== null) this.retainedPromises.add(value);
	}

	private bindChild(child: ChildProcess): void {
		if (child.stdin === null || child.stdout === null || child.stderr === null) {
			this.fatal();
			return;
		}
		child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
		child.stdout.on("end", () => {
			this.stdoutClosed = true;
			if (!this.poisoned && (!this.quitting || this.pending !== undefined)) this.fatal();
		});
		child.stdout.on("error", () => this.fatal());
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrBytes += chunk.byteLength;
			zeroBytes(chunk);
			if (this.stderrBytes > MAX_STDERR) this.fatal();
		});
		child.stderr.on("end", () => {
			this.stderrClosed = true;
		});
		child.stderr.on("error", () => this.fatal());
		child.stdin.on("close", () => {
			this.stdinClosed = true;
			if (!this.poisoned && this.pending !== undefined) this.fatal();
			for (let index = 0; index < this.retainedWrites.length; index += 1) {
				this.retainedWrites[index].writeCallback = true;
				this.retainedWrites[index].drain = true;
			}
			this.releaseWrites();
		});
		child.stdin.on("error", () => this.fatal());
		child.on("exit", (code, signal) => {
			this.exited = true;
			this.exitCode = code;
			this.exitSignal = signal;
			const pendingQuit = this.pending !== undefined && this.pending.opcode === QUIT;
			if (!this.poisoned && (!this.quitting || pendingQuit)) this.fatal();
		});
	}

	private consumeStdout(chunk: Uint8Array): void {
		if (this.poisoned) {
			zeroBytes(chunk);
			return;
		}
		if (this.stdout.byteLength + chunk.byteLength > MAX_UNPARSED) {
			zeroBytes(chunk);
			this.fatal();
			return;
		}
		const combined = new Uint8Array(this.stdout.byteLength + chunk.byteLength);
		for (let index = 0; index < this.stdout.byteLength; index += 1) combined[index] = this.stdout[index];
		for (let index = 0; index < chunk.byteLength; index += 1) combined[this.stdout.byteLength + index] = chunk[index];
		zeroBytes(this.stdout);
		zeroBytes(chunk);
		this.stdout = combined;
		while (this.stdout.byteLength >= HEADER_SIZE && !this.poisoned) {
			const length = new DataView(this.stdout.buffer).getUint32(1, false);
			if (length > MAX_PAYLOAD) {
				this.fatal();
				return;
			}
			const frameLength = HEADER_SIZE + length;
			if (this.stdout.byteLength < frameLength) return;
			const opcode = this.stdout[0];
			const payload = copyRange(this.stdout, HEADER_SIZE, frameLength);
			const remainder = copyRange(this.stdout, frameLength, this.stdout.byteLength);
			zeroBytes(this.stdout);
			this.stdout = remainder;
			this.acceptFrame(opcode, payload);
		}
	}

	private acceptFrame(opcode: number, payload: Uint8Array): void {
		const pending = this.pending;
		if (pending === undefined || pending.response !== undefined) {
			zeroBytes(payload);
			this.fatal();
			return;
		}
		if (opcode === ERROR) {
			if (payload.byteLength !== 2 || payload[0] !== pending.opcode) {
				zeroBytes(payload);
				this.fatal();
				return;
			}
			const code = payload[1];
			if (pending.inventory || (pending.inspect && (code !== ABSENT_ERROR || pending.payloads.length !== 0))) {
				zeroBytes(payload);
				this.fatal();
				return;
			}
			zeroBytes(payload);
			zeroList(pending.payloads);
			pending.response = _freeze({ ok: false, errorCode: code });
			this.finishPending();
			return;
		}
		if (pending.inventory || pending.inspect) {
			if (opcode === SESSION) {
				if (pending.inspect && pending.payloads.length !== 0) {
					zeroBytes(payload);
					this.fatal();
					return;
				}
				pending.payloads[pending.payloads.length] = payload;
				return;
			}
			if (opcode !== DONE || payload.byteLength !== 0 || (pending.inspect && pending.payloads.length !== 1)) {
				zeroBytes(payload);
				this.fatal();
				return;
			}
			zeroBytes(payload);
			pending.response = _freeze({ ok: true, payloads: pending.payloads });
			this.finishPending();
			return;
		}
		const expectsDigest =
			pending.opcode === CREATE_SESSION ||
			pending.opcode === APPEND_WAL ||
			pending.opcode === APPEND_LEDGER ||
			pending.opcode === PREPARE_GENERATION ||
			pending.opcode === SWITCH_HEAD;
		const expectedLength = expectsDigest ? 33 : 1;
		if (opcode !== OK || payload.byteLength !== expectedLength || payload[0] !== pending.opcode) {
			zeroBytes(payload);
			this.fatal();
			return;
		}
		const responsePayloads: Uint8Array[] = [];
		if (expectsDigest) responsePayloads[0] = copyRange(payload, 1, 33);
		zeroBytes(payload);
		pending.response = _freeze({ ok: true, payloads: _freeze(responsePayloads) });
		this.finishPending();
	}

	command(
		opcode: number,
		payload: Uint8Array,
		timeout: number,
		inventory: boolean,
		inspect = false,
	): Promise<HelperResult> {
		return new _Promise<HelperResult>((resolveCommand) => {
			if (this.poisoned || this.pending !== undefined || this.child === undefined || this.child.stdin === null) {
				resolveCommand(_freeze({ ok: false, errorCode: 0 }));
				return;
			}
			const frame = encodeFrame(opcode, payload);
			if (frame === undefined) {
				this.fatal();
				resolveCommand(_freeze({ ok: false, errorCode: 0 }));
				return;
			}
			const timer = _setTimeout(() => this.fatal(), timeout);
			const pending: PendingCommand = {
				opcode,
				inventory,
				inspect,
				payloads: [],
				resolve: resolveCommand,
				frame,
				writeCallback: false,
				drain: false,
				response: undefined,
				timer,
			};
			this.pending = pending;
			let accepted = false;
			try {
				accepted = this.child.stdin.write(frame, (failure) => {
					if (failure !== undefined && failure !== null) {
						this.fatal();
						return;
					}
					pending.writeCallback = true;
					this.finishPending();
					this.releaseWrites();
				});
			} catch {
				this.fatal();
				return;
			}
			if (accepted) pending.drain = true;
			else
				this.child.stdin.once("drain", () => {
					pending.drain = true;
					this.finishPending();
					this.releaseWrites();
				});
			this.finishPending();
		});
	}

	inspectSession(lifecycle: Uint8Array): Promise<HelperResult> {
		if (lifecycle.byteLength !== 32)
			return ownedPromise((resolveResult) => resolveResult(_freeze({ ok: false, errorCode: 0 })));
		return this.command(INSPECT_SESSION, lifecycle, 30_000, false, true);
	}

	private releaseWrites(): void {
		let index = 0;
		while (index < this.retainedWrites.length) {
			const retained = this.retainedWrites[index];
			if (retained.writeCallback && retained.drain) {
				zeroBytes(retained.frame);
				this.retainedWrites.splice(index, 1);
			} else index += 1;
		}
	}

	private finishPending(): void {
		const pending = this.pending;
		if (pending === undefined || !pending.writeCallback || !pending.drain || pending.response === undefined) return;
		_clearTimeout(pending.timer);
		this.pending = undefined;
		zeroBytes(pending.frame);
		pending.resolve(pending.response);
	}

	private fatal(): void {
		if (this.poisoned) return;
		this.poisoned = true;
		zeroBytes(this.stdout);
		this.stdout = new Uint8Array(0);
		const pending = this.pending;
		if (pending !== undefined) {
			_clearTimeout(pending.timer);
			this.pending = undefined;
			zeroList(pending.payloads);
			this.retainedWrites[this.retainedWrites.length] = pending;
			this.releaseWrites();
			pending.resolve(_freeze({ ok: false, errorCode: 0 }));
		}
		this.revoke();
	}

	poison(): Promise<boolean> {
		this.fatal();
		return this.revoke();
	}

	private signal(signal: NodeJS.Signals): boolean {
		const child = this.child;
		if (child === undefined || child.pid === undefined) return false;
		try {
			_reflectApply(_kill, process, [-child.pid, signal]);
			return true;
		} catch (failure) {
			return errorCode(failure) === "ESRCH";
		}
	}

	private groupAbsent(): boolean {
		const child = this.child;
		if (child === undefined || child.pid === undefined) return true;
		try {
			_reflectApply(_kill, process, [-child.pid, 0]);
			return false;
		} catch (failure) {
			return errorCode(failure) === "ESRCH";
		}
	}

	private waitSettled(limit: number): Promise<boolean> {
		return new _Promise<boolean>((resolveWait) => {
			const start = _hrtimeBigint();
			const inspect = () => {
				if (this.exited && this.stdoutClosed && this.stderrClosed && this.stdinClosed) {
					resolveWait(true);
					return;
				}
				if (Number(_hrtimeBigint() - start) / 1_000_000 >= limit) {
					resolveWait(false);
					return;
				}
				_setTimeout(inspect, 25);
			};
			inspect();
		});
	}

	private waitSettledFully(): Promise<void> {
		return new _Promise<void>((resolveWait) => {
			const inspect = () => {
				if (this.exited && this.stdoutClosed && this.stderrClosed && this.stdinClosed) {
					resolveWait();
					return;
				}
				_setTimeout(inspect, 25);
			};
			inspect();
		});
	}

	private waitFinal(limit: number): Promise<{ absent: boolean; settled: boolean }> {
		return new _Promise<{ absent: boolean; settled: boolean }>((resolveWait) => {
			const start = _hrtimeBigint();
			const inspect = () => {
				const absent = this.groupAbsent();
				const settled = this.exited && this.stdoutClosed && this.stderrClosed && this.stdinClosed;
				if ((absent && settled) || Number(_hrtimeBigint() - start) / 1_000_000 >= limit) {
					resolveWait(_freeze({ absent, settled }));
					return;
				}
				_setTimeout(inspect, 25);
			};
			inspect();
		});
	}

	private waitAbsent(limit: number): Promise<boolean> {
		return new _Promise<boolean>((resolveWait) => {
			const start = _hrtimeBigint();
			const inspect = () => {
				if (this.groupAbsent()) {
					resolveWait(true);
					return;
				}
				if (Number(_hrtimeBigint() - start) / 1_000_000 >= limit) {
					resolveWait(false);
					return;
				}
				_setTimeout(inspect, 25);
			};
			inspect();
		});
	}

	revoke(): Promise<boolean> {
		if (this.revokePromise !== undefined) return this.revokePromise;
		this.revokePromise = new _Promise<boolean>((resolveRevoke) => {
			const run = async (): Promise<void> => {
				if (!this.spawned || this.child === undefined) {
					resolveRevoke(false);
					return;
				}
				this.signal("SIGTERM");
				const termDelay = delay(2_000);
				this.retain(termDelay);
				await termDelay;
				if (!this.groupAbsent()) this.signal("SIGKILL");
				const finalWait = this.waitFinal(2_000);
				this.retain(finalWait);
				const finalState = await finalWait;
				if (!finalState.settled) {
					const fullWait = this.waitSettledFully();
					this.retain(fullWait);
					await fullWait;
				}
				resolveRevoke(finalState.absent && finalState.settled);
			};
			const running = run();
			this.retain(running);
		});
		this.retain(this.revokePromise);
		return this.revokePromise;
	}

	dropResources(): void {
		zeroBytes(this.stdout);
		this.stdout = new Uint8Array(0);
		for (let index = 0; index < this.retainedWrites.length; index += 1) zeroBytes(this.retainedWrites[index].frame);
		this.retainedWrites.length = 0;
		this.pending = undefined;
		this.child = undefined;
		this.retainedPromises.clear();
	}

	closeHealthy(): Promise<boolean> {
		return new _Promise<boolean>((resolveClose) => {
			const run = async (): Promise<void> => {
				if (this.poisoned) {
					await this.revoke();
					resolveClose(false);
					return;
				}
				this.quitting = true;
				const result = await this.command(QUIT, new Uint8Array(0), 30_000, false);
				if (!result.ok) {
					this.fatal();
					await this.revoke();
					resolveClose(false);
					return;
				}
				const settled = await this.waitSettled(30_000);
				const absent = await this.waitAbsent(2_000);
				if (
					!settled ||
					!absent ||
					this.exitCode !== 0 ||
					this.exitSignal !== null ||
					this.stdout.byteLength !== 0
				) {
					this.poisoned = true;
					await this.revoke();
					resolveClose(false);
					return;
				}
				resolveClose(true);
			};
			const running = run();
			this.retain(running);
		});
	}
}

function stateName(value: number): ProviderWalState | undefined {
	return value >= 1 && value <= STATE_NAMES.length ? STATE_NAMES[value - 1] : undefined;
}

function terminalFromNumbers(status: number, code: number): TerminalPair | undefined {
	const statuses: readonly TerminalStatus[] = _freeze(["completed", "error", "cancelled"]);
	const codes: readonly TerminalCode[] = _freeze([
		"SUCCESS",
		"FAILURE",
		"TIMEOUT",
		"EVICTED",
		"USER_STOP",
		"PARENT_STOP",
		"REVOKED",
		"MAX_DEPTH",
		"INTERNAL",
		"UNKNOWN",
	]);
	if (status < 1 || status > statuses.length || code < 1 || code > codes.length) return undefined;
	return _freeze({ terminalStatus: statuses[status - 1], terminalCode: codes[code - 1] });
}

function terminalNumbers(pair: TerminalPair): readonly number[] {
	const statuses: readonly string[] = _freeze(["completed", "error", "cancelled"]);
	const codes: readonly string[] = _freeze([
		"SUCCESS",
		"FAILURE",
		"TIMEOUT",
		"EVICTED",
		"USER_STOP",
		"PARENT_STOP",
		"REVOKED",
		"MAX_DEPTH",
		"INTERNAL",
		"UNKNOWN",
	]);
	return _freeze([statuses.indexOf(pair.terminalStatus) + 1, codes.indexOf(pair.terminalCode) + 1]);
}

function digestCopiesFromRecord(record: HostedSessionWalRecord): DigestCopies {
	return {
		releaseDigest: copyBytes(record.releaseDigest),
		manifestDigest: copyBytes(record.manifestDigest),
		bootstrapDigest: copyBytes(record.bootstrapDigest),
		trustDigest: copyBytes(record.trustDigest),
		runtimeConfigDigest: copyBytes(record.runtimeConfigDigest),
	};
}

function zeroWalRecord(record: HostedSessionWalRecord): void {
	zeroBytes(record.lifecycleDigest);
	zeroBytes(record.generationKey);
	zeroBytes(record.previousRecordDigest);
	zeroBytes(record.identityRecordDigest);
	zeroBytes(record.releaseDigest);
	zeroBytes(record.manifestDigest);
	zeroBytes(record.bootstrapDigest);
	zeroBytes(record.trustDigest);
	zeroBytes(record.runtimeConfigDigest);
}

function zeroGeneration(generation: GenerationData): void {
	zeroBytes(generation.key);
	zeroBytes(generation.headDigest);
	zeroList(generation.raw);
	for (let index = 0; index < generation.decoded.length; index += 1) zeroWalRecord(generation.decoded[index]);
	generation.decoded.length = 0;
}

function zeroRow(row: StoreRow): void {
	zeroBytes(row.lifecycle);
	zeroBytes(row.identityDigest);
	zeroBytes(row.ledgerDigest);
	zeroDigests(row.digests);
	zeroGeneration(row.generation);
	row.ledgerWrappers.length = 0;
	row.ledgerRecords.length = 0;
	row.session = undefined;
}

function appendBytes(target: Uint8Array, offset: number, source: Uint8Array): number {
	for (let index = 0; index < source.byteLength; index += 1) target[offset + index] = source[index];
	return offset + source.byteLength;
}

function writeU32(target: Uint8Array, offset: number, value: number): number {
	new DataView(target.buffer).setUint32(offset, value, false);
	return offset + 4;
}

function writeU64(target: Uint8Array, offset: number, value: bigint): number {
	new DataView(target.buffer).setBigUint64(offset, value, false);
	return offset + 8;
}

function buildCreatePayload(
	lifecycle: Uint8Array,
	generation: Uint8Array,
	genesis: Uint8Array,
	wal: Uint8Array,
): Uint8Array {
	const output = new Uint8Array(32 + 32 + 4 + genesis.byteLength + WAL_SIZE);
	let offset = appendBytes(output, 0, lifecycle);
	offset = appendBytes(output, offset, generation);
	offset = writeU32(output, offset, genesis.byteLength);
	offset = appendBytes(output, offset, genesis);
	appendBytes(output, offset, wal);
	return output;
}

function buildWalPayload(row: StoreRow, wal: Uint8Array): Uint8Array {
	const output = new Uint8Array(32 + 32 + 8 + 32 + WAL_SIZE);
	let offset = appendBytes(output, 0, row.lifecycle);
	offset = appendBytes(output, offset, row.generation.key);
	offset = writeU64(output, offset, row.generation.decoded[row.generation.decoded.length - 1].revision);
	offset = appendBytes(output, offset, row.generation.headDigest);
	appendBytes(output, offset, wal);
	return output;
}

function buildLedgerPayload(row: StoreRow, record: Uint8Array): Uint8Array {
	const output = new Uint8Array(32 + 8 + 32 + 4 + record.byteLength);
	let offset = appendBytes(output, 0, row.lifecycle);
	offset = writeU64(output, offset, BigInt(row.ledgerRecords.length - 1));
	offset = appendBytes(output, offset, row.ledgerDigest);
	offset = writeU32(output, offset, record.byteLength);
	appendBytes(output, offset, record);
	return output;
}

function buildPreparePayload(row: StoreRow, retired: GenerationData, fresh: GenerationData): Uint8Array {
	const output = new Uint8Array(32 + 32 + 32 + 32 + WAL_SIZE);
	let offset = appendBytes(output, 0, row.lifecycle);
	offset = appendBytes(output, offset, retired.key);
	offset = appendBytes(output, offset, retired.headDigest);
	offset = appendBytes(output, offset, fresh.key);
	appendBytes(output, offset, fresh.raw[0]);
	return output;
}

function buildSwitchPayload(row: StoreRow, retired: GenerationData, fresh: GenerationData): Uint8Array {
	const output = new Uint8Array(32 * 5);
	let offset = appendBytes(output, 0, row.lifecycle);
	offset = appendBytes(output, offset, retired.key);
	offset = appendBytes(output, offset, retired.headDigest);
	offset = appendBytes(output, offset, fresh.key);
	appendBytes(output, offset, fresh.headDigest);
	return output;
}

function buildRemovePayload(row: StoreRow, retired: GenerationData): Uint8Array {
	const output = new Uint8Array(96);
	let offset = appendBytes(output, 0, row.lifecycle);
	offset = appendBytes(output, offset, retired.key);
	appendBytes(output, offset, retired.headDigest);
	return output;
}

function buildPurgePayload(row: StoreRow): Uint8Array {
	const output = new Uint8Array(160);
	let offset = appendBytes(output, 0, row.lifecycle);
	offset = appendBytes(output, offset, row.generation.key);
	offset = appendBytes(output, offset, row.generation.headDigest);
	offset = appendBytes(output, offset, row.ledgerDigest);
	appendBytes(output, offset, row.identityDigest);
	return output;
}

function makeWal(
	state: number,
	terminalStatus: number,
	terminalCode: number,
	revision: bigint,
	lifecycle: Uint8Array,
	generation: Uint8Array,
	previous: Uint8Array,
	identityDigest: Uint8Array,
	digests: DigestCopies,
): Uint8Array | undefined {
	const encoded = encodeHostedSessionWalRecord(
		_freeze({
			state,
			terminalStatus,
			terminalCode,
			revision,
			lifecycleDigest: lifecycle,
			generationKey: generation,
			previousRecordDigest: previous,
			identityRecordDigest: identityDigest,
			releaseDigest: digests.releaseDigest,
			manifestDigest: digests.manifestDigest,
			bootstrapDigest: digests.bootstrapDigest,
			trustDigest: digests.trustDigest,
			runtimeConfigDigest: digests.runtimeConfigDigest,
		}),
	);
	return encoded.ok ? encoded.value : undefined;
}

function decodeGeneration(key: Uint8Array, records: Uint8Array[], lifecycle: Uint8Array): GenerationData | undefined {
	if (records.length < 1 || records.length > 7) return undefined;
	const chain: Uint8Array[] = [];
	for (let index = 0; index < records.length; index += 1) chain[index] = records[index];
	_freeze(chain);
	const verified = verifyHostedSessionWalChain(chain);
	if (!verified.ok) return undefined;
	const decoded: HostedSessionWalRecord[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const result = decodeHostedSessionWalRecord(records[index]);
		if (
			!result.ok ||
			!sameBytes(result.value.lifecycleDigest, lifecycle) ||
			!sameBytes(result.value.generationKey, key)
		) {
			if (result.ok) zeroWalRecord(result.value);
			for (let prior = 0; prior < decoded.length; prior += 1) zeroWalRecord(decoded[prior]);
			return undefined;
		}
		decoded[decoded.length] = result.value;
	}
	const headDigest = sha256(records[records.length - 1]);
	if (headDigest === undefined) {
		for (let index = 0; index < decoded.length; index += 1) zeroWalRecord(decoded[index]);
		return undefined;
	}
	return { key, keyHex: bytesHex(key), raw: records, decoded, headDigest };
}

interface ParsedSession {
	row: StoreRow;
	other: GenerationData | undefined;
	rolloverCase: number;
}

function parseSession(payloadRaw: Uint8Array): ParsedSession | undefined {
	const copied = copySandboxStrictBytes(payloadRaw, MAX_PAYLOAD);
	zeroBytes(payloadRaw);
	if (copied.ok === false) return undefined;
	const payload = copied.value;
	const slices: Uint8Array[] = [];
	const generations: GenerationData[] = [];
	let identityDigestOwned: Uint8Array | undefined;
	let ledgerDigestOwned: Uint8Array | undefined;
	let transferred = false;
	try {
		let offset = 0;
		const take = (length: number): Uint8Array | undefined => {
			if (!Number.isSafeInteger(length) || length < 0 || offset + length > payload.byteLength) return undefined;
			const value = copyRange(payload, offset, offset + length);
			offset += length;
			slices[slices.length] = value;
			return value;
		};
		const number32 = (): number | undefined => {
			if (offset + 4 > payload.byteLength) return undefined;
			const value = new DataView(payload.buffer).getUint32(offset, false);
			offset += 4;
			return value;
		};
		const lifecycle = take(32);
		const identityLength = number32();
		if (lifecycle === undefined || identityLength === undefined || identityLength < 1 || identityLength > 16_384)
			return undefined;
		const identityBytes = take(identityLength);
		if (identityBytes === undefined || offset >= payload.byteLength) return undefined;
		const ledgerCount = payload[offset];
		offset += 1;
		if (ledgerCount < 1 || ledgerCount > 16) return undefined;
		const wrappers: LedgerRecordBytes[] = [];
		const records: LedgerRecord[] = [];
		const ledgerRaw: Uint8Array[] = [];
		let totalBytes = 0;
		for (let index = 0; index < ledgerCount; index += 1) {
			const length = number32();
			if (length === undefined || length < 1 || length > 16_384) return undefined;
			totalBytes += length;
			if (totalBytes > 262_128) return undefined;
			const raw = take(length);
			if (raw === undefined) return undefined;
			ledgerRaw[ledgerRaw.length] = raw;
			const minted = mintRecordBytes(raw);
			if (minted.code !== "OK") return undefined;
			wrappers[wrappers.length] = minted.bytes;
			records[records.length] = minted.record;
		}
		if (!sameBytes(identityBytes, ledgerRaw[0])) return undefined;
		const chain: LedgerRecordBytes[] = [];
		for (let index = 0; index < wrappers.length; index += 1) chain[index] = wrappers[index];
		const ledgerInventory = inventory(chain, LEDGER_BOUNDS);
		if (ledgerInventory.code !== "OK" || ledgerInventory.groups.length !== 1) return undefined;
		const group = ledgerInventory.groups[0];
		if (group.chain.length !== ledgerCount || group.totalBytes !== totalBytes) return undefined;
		for (let index = 0; index < records.length; index += 1) {
			if (group.chain[index].contentDigest !== records[index].contentDigest || group.chain[index].rev !== index)
				return undefined;
		}
		const identity = copyAcceptedIdentity(records[0].identity);
		if (identity === undefined || identity.lifecycleKeyDigest !== bytesHex(lifecycle)) return undefined;
		for (let index = 0; index < records.length; index += 1)
			if (!sameIdentity(identity, records[index].identity)) return undefined;
		identityDigestOwned = sha256(identityBytes);
		ledgerDigestOwned = sha256(ledgerRaw[ledgerRaw.length - 1]);
		if (identityDigestOwned === undefined || ledgerDigestOwned === undefined) return undefined;
		const identityDigest = identityDigestOwned;
		const ledgerDigest = ledgerDigestOwned;
		const currentKey = take(32);
		if (currentKey === undefined || offset >= payload.byteLength) return undefined;
		const generationCount = payload[offset];
		offset += 1;
		if (generationCount < 1 || generationCount > 2) return undefined;
		let priorKey: Uint8Array | undefined;
		for (let index = 0; index < generationCount; index += 1) {
			const key = take(32);
			if (key === undefined || offset >= payload.byteLength) return undefined;
			if (priorKey !== undefined && compareBytes(priorKey, key) >= 0) return undefined;
			priorKey = key;
			const count = payload[offset];
			offset += 1;
			if (count < 1 || count > 7) return undefined;
			const walRaw: Uint8Array[] = [];
			for (let walIndex = 0; walIndex < count; walIndex += 1) {
				const raw = take(WAL_SIZE);
				if (raw === undefined) return undefined;
				walRaw[walRaw.length] = raw;
			}
			const generation = decodeGeneration(key, walRaw, lifecycle);
			if (generation === undefined) return undefined;
			generations[generations.length] = generation;
		}
		if (offset !== payload.byteLength) return undefined;
		let selected: GenerationData | undefined;
		let other: GenerationData | undefined;
		for (let index = 0; index < generations.length; index += 1) {
			if (sameBytes(generations[index].key, currentKey)) selected = generations[index];
			else other = generations[index];
		}
		if (selected === undefined) return undefined;
		const selectedHead = selected.decoded[selected.decoded.length - 1];
		if (!sameBytes(selectedHead.identityRecordDigest, identityDigest)) return undefined;
		for (let index = 0; index < generations.length; index += 1) {
			const head = generations[index].decoded[generations[index].decoded.length - 1];
			if (!sameBytes(head.identityRecordDigest, identityDigest)) return undefined;
			if (
				!sameBytes(head.releaseDigest, selectedHead.releaseDigest) ||
				!sameBytes(head.manifestDigest, selectedHead.manifestDigest) ||
				!sameBytes(head.bootstrapDigest, selectedHead.bootstrapDigest) ||
				!sameBytes(head.trustDigest, selectedHead.trustDigest) ||
				!sameBytes(head.runtimeConfigDigest, selectedHead.runtimeConfigDigest)
			)
				return undefined;
		}
		const selectedState = stateName(selectedHead.state);
		if (selectedState === undefined) return undefined;
		let rolloverCase = 0;
		if (selectedState === "RETIRED_ABSENT") {
			if (records[records.length - 1].status !== "allocating") return undefined;
			if (other === undefined) rolloverCase = 2;
			else {
				const otherHead = other.decoded[other.decoded.length - 1];
				if (other.decoded.length !== 1 || otherHead.state !== 1 || otherHead.revision !== 1n) return undefined;
				rolloverCase = 3;
			}
		} else if (other !== undefined) {
			if (
				selected.decoded.length !== 1 ||
				selectedHead.state !== 1 ||
				selectedHead.revision !== 1n ||
				records[records.length - 1].status !== "allocating"
			)
				return undefined;
			const otherHead = other.decoded[other.decoded.length - 1];
			if (otherHead.state !== 8) return undefined;
			rolloverCase = 4;
		} else if (selectedState === "ALLOCATED" && records[records.length - 1].status === "allocating") rolloverCase = 5;
		const terminal = findTerminal(selected.decoded);
		const digests = digestCopiesFromRecord(selectedHead);
		const semantic = makeSemantic(identity, selectedState, selected.keyHex, digests);
		const row: StoreRow = {
			identity,
			lifecycle,
			lifecycleHex: bytesHex(lifecycle),
			identityDigest,
			digests,
			generation: selected,
			ledgerWrappers: wrappers,
			ledgerRecords: records,
			ledgerDigest,
			terminal,
			session: undefined,
			semantic,
		};
		transferred = true;
		for (let index = 0; index < ledgerRaw.length; index += 1) zeroBytes(ledgerRaw[index]);
		zeroBytes(identityBytes);
		zeroBytes(currentKey);
		return { row, other, rolloverCase };
	} finally {
		zeroBytes(payload);
		if (!transferred) {
			for (let index = 0; index < generations.length; index += 1) zeroGeneration(generations[index]);
			if (identityDigestOwned !== undefined) zeroBytes(identityDigestOwned);
			if (ledgerDigestOwned !== undefined) zeroBytes(ledgerDigestOwned);
			zeroList(slices);
		}
	}
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] < right[index]) return -1;
		if (left[index] > right[index]) return 1;
	}
	return 0;
}

function findTerminal(records: HostedSessionWalRecord[]): TerminalPair | undefined {
	for (let index = 0; index < records.length; index += 1) {
		if (records[index].state === 6)
			return terminalFromNumbers(records[index].terminalStatus, records[index].terminalCode);
	}
	return undefined;
}

class StoreCore {
	private registry: RegistryPort | undefined;
	private owner: HelperOwner;
	private rows = new Map<object, StoreRow>();
	private lifecycle = new Map<string, StoreRow>();
	private generations = new Set<string>();
	private generationBytes: Uint8Array[] = [];
	private order: object[] = [];
	private queue: QueuedOperation[] = [];
	private active = false;
	private closing = false;
	private poisoned = false;
	private inventoried = false;
	private retainedPromises = new Set<object>();

	constructor(registry: RegistryPort, owner: HelperOwner) {
		this.registry = registry;
		this.owner = owner;
	}

	isClosing(): boolean {
		return this.closing;
	}

	beginClose(): boolean {
		if (this.closing) return false;
		this.closing = true;
		return true;
	}

	retain(value: unknown): void {
		if (typeof value === "object" && value !== null) this.retainedPromises.add(value);
	}

	private release(value: unknown): void {
		if (typeof value === "object" && value !== null) this.retainedPromises.delete(value);
	}

	enqueue<T>(operation: () => Promise<T>, revoked: T): Promise<T> {
		if (this.closing) return ownedPromise<T>((resolveResult) => resolveResult(revoked));
		return this.enqueueAdmitted(operation, revoked);
	}

	enqueueClose(
		operation: () => Promise<{ code: "CLOSED" } | { code: "FAILED" }>,
	): Promise<{ code: "CLOSED" } | { code: "FAILED" }> {
		return this.enqueueAdmitted(operation, failedResult());
	}

	private enqueueAdmitted<T>(operation: () => Promise<T>, failed: T): Promise<T> {
		const returned = new _Promise<T>((resolveResult) => {
			const queued: QueuedOperation = {
				start: () => {
					let actual: Promise<T> | undefined;
					try {
						actual = operation();
					} catch {
						this.poisonSync();
						resolveResult(failed);
						this.finishQueue();
						return;
					}
					if (!nativePromise(actual)) {
						this.poisonSync();
						resolveResult(failed);
						this.finishQueue();
						return;
					}
					this.retain(actual);
					const observer = _reflectApply(_promiseThen, actual, [
						(value: T) => {
							this.release(actual);
							resolveResult(value);
							this.release(returned);
							this.finishQueue();
							if (this.closing && this.queue.length === 0) _setTimeout(() => this.retainedPromises.clear(), 0);
						},
						() => {
							this.release(actual);
							this.poisonSync();
							resolveResult(failed);
							this.release(returned);
							this.finishQueue();
							if (this.closing && this.queue.length === 0) _setTimeout(() => this.retainedPromises.clear(), 0);
						},
					]);
					this.retain(observer);
				},
			};
			this.queue[this.queue.length] = queued;
			this.startQueue();
		});
		this.retain(returned);
		return returned;
	}

	private startQueue(): void {
		if (this.active || this.queue.length === 0) return;
		this.active = true;
		this.queue[0].start();
	}

	private finishQueue(): void {
		this.queue.shift();
		this.active = false;
		this.startQueue();
	}

	private poisonSync(): void {
		if (this.poisoned) return;
		this.poisoned = true;
		const cleanup = this.owner.poison();
		this.retain(cleanup);
	}

	private async fatal<T>(result: T): Promise<T> {
		this.poisonSync();
		await this.owner.poison();
		return result;
	}

	private async helper(
		opcode: number,
		payload: Uint8Array,
		timeout = 30_000,
		inventory = false,
	): Promise<HelperResult> {
		try {
			const result = await this.owner.command(opcode, payload, timeout, inventory);
			if (this.owner.isPoisoned()) {
				if (result.ok) zeroListResult(result.payloads);
				this.poisoned = true;
				return _freeze({ ok: false, errorCode: 0 });
			}
			return result;
		} finally {
			zeroBytes(payload);
		}
	}

	private readRegistry(session: object): RegistryReadResult | undefined {
		const registry = this.registry;
		if (registry === undefined) return undefined;
		try {
			const raw = _reflectApply(registry.read, registry.receiver, [session]);
			if (nativePromise(raw)) return undefined;
			return registryReadShape(raw);
		} catch {
			return undefined;
		}
	}

	private issueRegistry(row: StoreRow): object | undefined {
		const registry = this.registry;
		if (registry === undefined) return undefined;
		try {
			const raw = _reflectApply(registry.issueLoaded, registry.receiver, [row.identity, row.semantic]);
			if (nativePromise(raw)) return undefined;
			const issued = registryIssueShape(raw);
			if (issued === undefined || issued.code !== "ISSUED" || issued.session === undefined) return undefined;
			const session = issued.session;
			if (
				_isProxy(session) ||
				!_isFrozen(session) ||
				_getOwnPropertyNames(session).length !== 0 ||
				_getOwnPropertySymbols(session).length !== 0
			) {
				return undefined;
			}
			const read = this.readRegistry(session);
			if (
				read === undefined ||
				read.code !== "KNOWN" ||
				read.state === undefined ||
				!sameSemantic(read.state, row.semantic)
			)
				return undefined;
			return session;
		} catch {
			return undefined;
		}
	}

	private async replaceRegistry(
		row: StoreRow,
		expected: SessionSemanticState,
		next: SessionSemanticState,
	): Promise<boolean> {
		const registry = this.registry;
		const session = row.session;
		if (registry === undefined || session === undefined) return false;
		const replaceOnce = (): RegistryReplaceResult | undefined => {
			try {
				const raw = _reflectApply(registry.replace, registry.receiver, [session, expected, next]);
				if (nativePromise(raw)) return undefined;
				return registryReplaceShape(raw);
			} catch {
				return undefined;
			}
		};
		let replaced = replaceOnce();
		if (replaced === undefined || replaced.code === "INVALID") return false;
		if (replaced.code === "REPLACED") {
			row.semantic = next;
			return true;
		}
		const read = this.readRegistry(session);
		if (read === undefined || read.code !== "KNOWN" || read.state === undefined) return false;
		if (sameSemantic(read.state, next)) {
			row.semantic = next;
			return true;
		}
		if (!sameSemantic(read.state, expected)) return false;
		replaced = replaceOnce();
		if (replaced === undefined || replaced.code !== "REPLACED") return false;
		row.semantic = next;
		return true;
	}

	private drawGeneration(): Uint8Array | undefined {
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const candidate = new Uint8Array(32);
			try {
				const returned = _randomFillSync(candidate);
				if (
					returned !== candidate ||
					candidate.byteLength !== 32 ||
					candidate.byteOffset !== 0 ||
					candidate.buffer.byteLength !== 32
				) {
					zeroBytes(candidate);
					return undefined;
				}
			} catch {
				zeroBytes(candidate);
				return undefined;
			}
			const hex = bytesHex(candidate);
			let collision = false;
			for (let index = 0; index < this.generationBytes.length; index += 1) {
				if (sameBytes(candidate, this.generationBytes[index])) collision = true;
			}
			if (!collision) {
				this.generations.add(hex);
				this.generationBytes[this.generationBytes.length] = copyBytes(candidate);
				return candidate;
			}
			zeroBytes(candidate);
		}
		return undefined;
	}

	private rememberGeneration(key: Uint8Array): boolean {
		for (let index = 0; index < this.generationBytes.length; index += 1) {
			if (sameBytes(key, this.generationBytes[index])) return false;
		}
		this.generations.add(bytesHex(key));
		this.generationBytes[this.generationBytes.length] = copyBytes(key);
		return true;
	}

	private allocatedGeneration(row: StoreRow, key: Uint8Array): GenerationData | undefined {
		const zero = new Uint8Array(32);
		const raw = makeWal(1, 0, 0, 1n, row.lifecycle, key, zero, row.identityDigest, row.digests);
		zeroBytes(zero);
		if (raw === undefined) return undefined;
		const records = [raw];
		const generation = decodeGeneration(key, records, row.lifecycle);
		if (generation === undefined) {
			zeroBytes(raw);
			zeroBytes(key);
		}
		return generation;
	}

	private async appendWal(row: StoreRow, nextState: number, terminal: TerminalPair | undefined): Promise<boolean> {
		const head = row.generation.decoded[row.generation.decoded.length - 1];
		if (head.revision >= 0xffffffffffffffffn) return false;
		let status = 0;
		let code = 0;
		if (terminal !== undefined) {
			const numbers = terminalNumbers(terminal);
			status = numbers[0];
			code = numbers[1];
		}
		const raw = makeWal(
			nextState,
			status,
			code,
			head.revision + 1n,
			row.lifecycle,
			row.generation.key,
			row.generation.headDigest,
			row.identityDigest,
			row.digests,
		);
		if (raw === undefined) return false;
		const chain: Uint8Array[] = [];
		for (let index = 0; index < row.generation.raw.length; index += 1) chain[index] = row.generation.raw[index];
		chain[chain.length] = raw;
		_freeze(chain);
		if (!verifyHostedSessionWalChain(chain).ok) {
			zeroBytes(raw);
			return false;
		}
		const decodedResult = decodeHostedSessionWalRecord(raw);
		const digest = sha256(raw);
		if (!decodedResult.ok || digest === undefined) {
			if (decodedResult.ok) zeroWalRecord(decodedResult.value);
			zeroBytes(raw);
			if (digest !== undefined) zeroBytes(digest);
			return false;
		}
		const payload = buildWalPayload(row, raw);
		const result = await this.helper(APPEND_WAL, payload);
		if (!result.ok || result.payloads.length !== 1 || !sameBytes(result.payloads[0], digest)) {
			if (result.ok) zeroListResult(result.payloads);
			zeroWalRecord(decodedResult.value);
			zeroBytes(raw);
			zeroBytes(digest);
			return false;
		}
		zeroListResult(result.payloads);
		zeroBytes(row.generation.headDigest);
		row.generation.headDigest = digest;
		row.generation.raw[row.generation.raw.length] = raw;
		row.generation.decoded[row.generation.decoded.length] = decodedResult.value;
		if (nextState === 6 && terminal !== undefined) row.terminal = terminal;
		return true;
	}

	private async appendLedger(row: StoreRow, status: string, terminal: TerminalPair | undefined): Promise<boolean> {
		const chain: LedgerRecordBytes[] = [];
		for (let index = 0; index < row.ledgerWrappers.length; index += 1) chain[index] = row.ledgerWrappers[index];
		const transition = _freeze({
			status,
			terminalStatus: terminal === undefined ? null : terminal.terminalStatus,
			terminalCode: terminal === undefined ? null : terminal.terminalCode,
		});
		const appended = appendTransition(chain, transition, LEDGER_BOUNDS);
		if (appended.code !== "OK" || !sameIdentity(row.identity, appended.record.identity)) return false;
		const revealed = reveal(appended.bytes);
		if (revealed.code !== "OK") return false;
		const digest = sha256(revealed.data);
		if (digest === undefined) {
			zeroBytes(revealed.data);
			return false;
		}
		const payload = buildLedgerPayload(row, revealed.data);
		const result = await this.helper(APPEND_LEDGER, payload);
		zeroBytes(revealed.data);
		if (!result.ok || result.payloads.length !== 1 || !sameBytes(result.payloads[0], digest)) {
			if (result.ok) zeroListResult(result.payloads);
			zeroBytes(digest);
			return false;
		}
		zeroListResult(result.payloads);
		zeroBytes(row.ledgerDigest);
		row.ledgerDigest = digest;
		row.ledgerWrappers[row.ledgerWrappers.length] = appended.bytes;
		row.ledgerRecords[row.ledgerRecords.length] = appended.record;
		return true;
	}

	private ledgerPairMatches(record: LedgerRecord, pair: TerminalPair): boolean {
		return record.terminalStatus === pair.terminalStatus && record.terminalCode === pair.terminalCode;
	}

	private async reconcile(row: StoreRow): Promise<boolean> {
		const state = stateName(row.generation.decoded[row.generation.decoded.length - 1].state);
		const ledger = row.ledgerRecords[row.ledgerRecords.length - 1];
		if (state === undefined) return false;
		if (state === "ALLOCATED") return ledger.status === "reserved" || ledger.status === "allocating";
		if (state === "CREATE_DISPATCHED") {
			if (ledger.status === "reserved") return this.appendLedger(row, "allocating", undefined);
			return ledger.status === "allocating" && ledger.terminalStatus === null && ledger.terminalCode === null;
		}
		if (state === "PRESENT") {
			if (ledger.status === "allocating") return this.appendLedger(row, "allocated", undefined);
			return ledger.status === "allocated" && ledger.terminalStatus === null && ledger.terminalCode === null;
		}
		if (state === "RUNTIME_DISPATCHED") {
			if (ledger.status === "allocated") return this.appendLedger(row, "starting", undefined);
			return ledger.status === "starting" && ledger.terminalStatus === null && ledger.terminalCode === null;
		}
		if (state === "RUNNING") {
			if (ledger.status === "starting") return this.appendLedger(row, "running", undefined);
			return ledger.status === "running" && ledger.terminalStatus === null && ledger.terminalCode === null;
		}
		const terminal = row.terminal;
		if (terminal === undefined) return false;
		if (state === "DELETE_DISPATCHED") {
			if (ledger.status === "running") {
				if (!(await this.appendLedger(row, terminal.terminalStatus, terminal))) return false;
				return this.appendLedger(row, "deleting", terminal);
			}
			if (ledger.status === terminal.terminalStatus && this.ledgerPairMatches(ledger, terminal)) {
				return this.appendLedger(row, "deleting", terminal);
			}
			return (
				(ledger.status === "deleting" || ledger.status === "cleanup-uncertain") &&
				this.ledgerPairMatches(ledger, terminal)
			);
		}
		if (state === "ABSENT") {
			if (ledger.status === "cleanup-uncertain" && this.ledgerPairMatches(ledger, terminal)) {
				if (!(await this.appendLedger(row, "deleting", terminal))) return false;
				return this.appendLedger(row, "deleted", terminal);
			}
			if (ledger.status === "deleting" && this.ledgerPairMatches(ledger, terminal)) {
				return this.appendLedger(row, "deleted", terminal);
			}
			return ledger.status === "deleted" && this.ledgerPairMatches(ledger, terminal);
		}
		return false;
	}

	private async completeRollover(parsed: ParsedSession): Promise<boolean> {
		if (parsed.rolloverCase === 0 || parsed.rolloverCase === 5) return true;
		const row = parsed.row;
		let retired: GenerationData;
		let fresh: GenerationData | undefined;
		let prepare = false;
		let switchHead = false;
		if (parsed.rolloverCase === 2) {
			retired = row.generation;
			const key = this.drawGeneration();
			if (key === undefined) return false;
			fresh = this.allocatedGeneration(row, key);
			if (fresh === undefined) return false;
			parsed.other = fresh;
			prepare = true;
			switchHead = true;
		} else if (parsed.rolloverCase === 3) {
			retired = row.generation;
			fresh = parsed.other;
			switchHead = true;
		} else {
			fresh = row.generation;
			retired = parsed.other === undefined ? row.generation : parsed.other;
		}
		if (fresh === undefined || retired === fresh) return false;
		if (prepare) {
			const prepared = await this.helper(PREPARE_GENERATION, buildPreparePayload(row, retired, fresh));
			if (!(await consumeHelperDigest(prepared, fresh.headDigest))) return false;
		}
		if (switchHead) {
			const switched = await this.helper(SWITCH_HEAD, buildSwitchPayload(row, retired, fresh));
			if (!(await consumeHelperDigest(switched, fresh.headDigest))) return false;
		}
		const removed = await this.helper(REMOVE_RETIRED, buildRemovePayload(row, retired));
		if (!removed.ok || removed.payloads.length !== 0) {
			if (removed.ok) zeroListResult(removed.payloads);
			return false;
		}
		row.generation = fresh;
		row.terminal = undefined;
		row.semantic = makeSemantic(row.identity, "ALLOCATED", fresh.keyHex, row.digests);
		zeroGeneration(retired);
		parsed.other = undefined;
		return true;
	}

	private insertOrder(row: StoreRow, session: object): void {
		let index = 0;
		while (index < this.order.length) {
			const existing = this.rows.get(this.order[index]);
			if (existing === undefined || compareBytes(row.lifecycle, existing.lifecycle) < 0) break;
			index += 1;
		}
		this.order.splice(index, 0, session);
	}

	async inventoryOperation(): Promise<{ code: "INVENTORIED"; sessions: readonly object[] } | { code: "FAILED" }> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		if (this.inventoried) return freshInventory(this.order);
		const response = await this.helper(INVENTORY, new Uint8Array(0), 120_000, true);
		if (!response.ok) return this.fatal(failedResult());
		if (response.payloads.length > 1024) {
			zeroListResult(response.payloads);
			return this.fatal(failedResult());
		}
		const parsedRows: ParsedSession[] = [];
		let prior: Uint8Array | undefined;
		let valid = true;
		for (let index = 0; index < response.payloads.length; index += 1) {
			const parsed = parseSession(response.payloads[index]);
			if (parsed === undefined) {
				valid = false;
				break;
			}
			if (prior !== undefined && compareBytes(prior, parsed.row.lifecycle) >= 0) valid = false;
			prior = parsed.row.lifecycle;
			if (this.lifecycle.has(parsed.row.lifecycleHex)) valid = false;
			if (!this.rememberGeneration(parsed.row.generation.key)) valid = false;
			if (parsed.other !== undefined && !this.rememberGeneration(parsed.other.key)) valid = false;
			parsedRows[parsedRows.length] = parsed;
			if (!valid) break;
		}
		for (let index = parsedRows.length; index < response.payloads.length; index += 1)
			zeroBytes(response.payloads[index]);
		if (!valid || parsedRows.length !== response.payloads.length) {
			for (let index = 0; index < parsedRows.length; index += 1) {
				zeroRow(parsedRows[index].row);
				const other = parsedRows[index].other;
				if (other !== undefined) zeroGeneration(other);
			}
			return this.fatal(failedResult());
		}
		for (let index = 0; index < parsedRows.length; index += 1) {
			const parsed = parsedRows[index];
			if (!(await this.completeRollover(parsed)) || !(await this.reconcile(parsed.row))) {
				for (let cleanup = 0; cleanup < parsedRows.length; cleanup += 1) {
					zeroRow(parsedRows[cleanup].row);
					const other = parsedRows[cleanup].other;
					if (other !== undefined) zeroGeneration(other);
				}
				return this.fatal(failedResult());
			}
			const state = stateName(parsed.row.generation.decoded[parsed.row.generation.decoded.length - 1].state);
			if (state === undefined || state === "RETIRED_ABSENT") {
				for (let cleanup = 0; cleanup < parsedRows.length; cleanup += 1) zeroRow(parsedRows[cleanup].row);
				return this.fatal(failedResult());
			}
			parsed.row.semantic = makeSemantic(
				parsed.row.identity,
				state,
				parsed.row.generation.keyHex,
				parsed.row.digests,
			);
		}
		for (let index = 0; index < parsedRows.length; index += 1) {
			const session = this.issueRegistry(parsedRows[index].row);
			if (session === undefined) {
				for (let cleanup = 0; cleanup < parsedRows.length; cleanup += 1) zeroRow(parsedRows[cleanup].row);
				this.rows.clear();
				this.lifecycle.clear();
				this.order.length = 0;
				return this.fatal(failedResult());
			}
			parsedRows[index].row.session = session;
		}
		for (let index = 0; index < parsedRows.length; index += 1) {
			const row = parsedRows[index].row;
			const session = row.session;
			if (session === undefined) return this.fatal(failedResult());
			this.rows.set(session, row);
			this.lifecycle.set(row.lifecycleHex, row);
			this.order[this.order.length] = session;
		}
		this.inventoried = true;
		return freshInventory(this.order);
	}

	async allocateOperation(identityRaw: unknown, digestsRaw: unknown): Promise<AllocateSuccess | { code: "FAILED" }> {
		if (!validIdentityInput(identityRaw)) return failedResult();
		const digests = copyDigestInput(digestsRaw);
		if (digests === undefined) return failedResult();
		if (this.poisoned || this.owner.isPoisoned() || !this.inventoried) {
			zeroDigests(digests);
			if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
			return failedResult();
		}
		const empty: LedgerRecordBytes[] = [];
		const genesis = appendGenesis(empty, identityRaw, LEDGER_BOUNDS);
		if (genesis.code !== "OK") {
			zeroDigests(digests);
			return this.fatal(failedResult());
		}
		const identity = copyAcceptedIdentity(genesis.record.identity);
		const revealed = reveal(genesis.bytes);
		if (identity === undefined || revealed.code !== "OK") {
			zeroDigests(digests);
			if (revealed.code === "OK") zeroBytes(revealed.data);
			return this.fatal(failedResult());
		}
		const lifecycle = hexBytes(identity.lifecycleKeyDigest);
		const identityDigest = sha256(revealed.data);
		if (lifecycle === undefined || identityDigest === undefined) {
			zeroDigests(digests);
			zeroBytes(revealed.data);
			if (lifecycle !== undefined) zeroBytes(lifecycle);
			if (identityDigest !== undefined) zeroBytes(identityDigest);
			return this.fatal(failedResult());
		}
		const existing = this.lifecycle.get(identity.lifecycleKeyDigest);
		if (existing !== undefined) {
			zeroBytes(revealed.data);
			zeroBytes(lifecycle);
			zeroBytes(identityDigest);
			if (
				sameIdentity(existing.identity, identity) &&
				sameDigests(existing.digests, digests) &&
				existing.session !== undefined
			) {
				zeroDigests(digests);
				return freshAllocation("EXISTS", existing.session);
			}
			zeroDigests(digests);
			return this.fatal(failedResult());
		}
		const key = this.drawGeneration();
		if (key === undefined) {
			zeroBytes(revealed.data);
			zeroBytes(lifecycle);
			zeroBytes(identityDigest);
			zeroDigests(digests);
			return this.fatal(failedResult());
		}
		const previous = new Uint8Array(32);
		const wal = makeWal(1, 0, 0, 1n, lifecycle, key, previous, identityDigest, digests);
		zeroBytes(previous);
		if (wal === undefined) {
			zeroBytes(revealed.data);
			zeroBytes(lifecycle);
			zeroBytes(identityDigest);
			zeroBytes(key);
			zeroDigests(digests);
			return this.fatal(failedResult());
		}
		const walDigest = sha256(wal);
		const generation = decodeGeneration(key, [wal], lifecycle);
		if (walDigest === undefined || generation === undefined) {
			zeroBytes(revealed.data);
			zeroBytes(lifecycle);
			zeroBytes(identityDigest);
			zeroBytes(wal);
			if (walDigest !== undefined) zeroBytes(walDigest);
			if (generation !== undefined) zeroGeneration(generation);
			zeroDigests(digests);
			return this.fatal(failedResult());
		}
		zeroBytes(walDigest);
		const created = await this.helper(CREATE_SESSION, buildCreatePayload(lifecycle, key, revealed.data, wal));
		zeroBytes(revealed.data);
		if (!created.ok || created.payloads.length !== 1 || !sameBytes(created.payloads[0], generation.headDigest)) {
			if (created.ok) zeroListResult(created.payloads);
			zeroGeneration(generation);
			zeroBytes(lifecycle);
			zeroBytes(identityDigest);
			zeroDigests(digests);
			return this.fatal(failedResult());
		}
		zeroListResult(created.payloads);
		const ledgerDigest = copyBytes(identityDigest);
		const semantic = makeSemantic(identity, "ALLOCATED", generation.keyHex, digests);
		const row: StoreRow = {
			identity,
			lifecycle,
			lifecycleHex: identity.lifecycleKeyDigest,
			identityDigest,
			digests,
			generation,
			ledgerWrappers: [genesis.bytes],
			ledgerRecords: [genesis.record],
			ledgerDigest,
			terminal: undefined,
			session: undefined,
			semantic,
		};
		const session = this.issueRegistry(row);
		if (session === undefined) {
			zeroRow(row);
			return this.fatal(failedResult());
		}
		row.session = session;
		this.rows.set(session, row);
		this.lifecycle.set(row.lifecycleHex, row);
		this.insertOrder(row, session);
		return freshAllocation("ALLOCATED", session);
	}

	private rowFor(value: unknown): StoreRow | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		try {
			if (_isProxy(value)) return undefined;
			return this.rows.get(value);
		} catch {
			return undefined;
		}
	}

	async stateOperation(
		sessionRaw: unknown,
	): Promise<{ code: "STATE"; state: ProviderWalState } | { code: "INVALID" } | { code: "FAILED" }> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		const row = this.rowFor(sessionRaw);
		if (row === undefined) return invalidResult();
		if (!(await this.reconcile(row))) return this.fatal(failedResult());
		const state = stateName(row.generation.decoded[row.generation.decoded.length - 1].state);
		if (state === undefined || state === "RETIRED_ABSENT") return this.fatal(failedResult());
		return freshState(state);
	}

	private async commitTransition(
		row: StoreRow,
		before: ProviderWalState,
		next: ProviderWalState,
		ledgerStatuses: readonly string[],
		terminal: TerminalPair | undefined,
	): Promise<FixedStoreResult> {
		if (!(await this.reconcile(row))) return this.fatal(failedResult());
		const current = stateName(row.generation.decoded[row.generation.decoded.length - 1].state);
		if (current !== before) return staleResult();
		const expected = row.semantic;
		const numeric = STATE_NAMES.indexOf(next) + 1;
		if (!(await this.appendWal(row, numeric, next === "DELETE_DISPATCHED" ? terminal : undefined)))
			return this.fatal(failedResult());
		for (let index = 0; index < ledgerStatuses.length; index += 1) {
			if (!(await this.appendLedger(row, ledgerStatuses[index], terminal))) return this.fatal(failedResult());
		}
		const nextSemantic = makeSemantic(row.identity, next, row.generation.keyHex, row.digests);
		if (!(await this.replaceRegistry(row, expected, nextSemantic))) return this.fatal(failedResult());
		return committedResult();
	}

	async simpleTransitionOperation(
		sessionRaw: unknown,
		before: ProviderWalState,
		next: ProviderWalState,
		status: string,
	): Promise<FixedStoreResult> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		const row = this.rowFor(sessionRaw);
		if (row === undefined) return invalidResult();
		const statuses: string[] = [];
		if (!(before === "ALLOCATED" && row.ledgerRecords[row.ledgerRecords.length - 1].status === "allocating"))
			statuses[0] = status;
		return this.commitTransition(row, before, next, statuses, undefined);
	}

	async deleteOperation(sessionRaw: unknown, terminalRaw: unknown): Promise<FixedStoreResult> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		const row = this.rowFor(sessionRaw);
		const terminal = validTerminal(terminalRaw);
		if (row === undefined || terminal === undefined) return invalidResult();
		return this.commitTransition(
			row,
			"RUNNING",
			"DELETE_DISPATCHED",
			[terminal.terminalStatus, "deleting"],
			terminal,
		);
	}

	async cleanupOperation(sessionRaw: unknown): Promise<FixedStoreResult> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		const row = this.rowFor(sessionRaw);
		if (row === undefined) return invalidResult();
		if (!(await this.reconcile(row))) return this.fatal(failedResult());
		const current = stateName(row.generation.decoded[row.generation.decoded.length - 1].state);
		const ledger = row.ledgerRecords[row.ledgerRecords.length - 1];
		if (current !== "DELETE_DISPATCHED" || ledger.status !== "deleting") return staleResult();
		if (row.terminal === undefined || !(await this.appendLedger(row, "cleanup-uncertain", row.terminal)))
			return this.fatal(failedResult());
		return committedResult();
	}

	async absentOperation(sessionRaw: unknown): Promise<FixedStoreResult> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		const row = this.rowFor(sessionRaw);
		if (row === undefined) return invalidResult();
		if (!(await this.reconcile(row))) return this.fatal(failedResult());
		const current = stateName(row.generation.decoded[row.generation.decoded.length - 1].state);
		if (current !== "DELETE_DISPATCHED") return staleResult();
		const terminal = row.terminal;
		if (terminal === undefined) return this.fatal(failedResult());
		const cleanup = row.ledgerRecords[row.ledgerRecords.length - 1].status === "cleanup-uncertain";
		const statuses: string[] = [];
		if (cleanup) statuses[statuses.length] = "deleting";
		statuses[statuses.length] = "deleted";
		return this.commitTransition(row, "DELETE_DISPATCHED", "ABSENT", statuses, terminal);
	}

	async retireOperation(sessionRaw: unknown): Promise<FixedStoreResult> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		const row = this.rowFor(sessionRaw);
		if (row === undefined) return invalidResult();
		if (!(await this.reconcile(row))) return this.fatal(failedResult());
		const current = stateName(row.generation.decoded[row.generation.decoded.length - 1].state);
		const ledger = row.ledgerRecords[row.ledgerRecords.length - 1];
		if (current !== "CREATE_DISPATCHED" || ledger.status !== "allocating") return staleResult();
		const expected = row.semantic;
		if (!(await this.appendWal(row, 8, undefined))) return this.fatal(failedResult());
		const retired = row.generation;
		const key = this.drawGeneration();
		if (key === undefined) return this.fatal(failedResult());
		const fresh = this.allocatedGeneration(row, key);
		if (fresh === undefined) return this.fatal(failedResult());
		const prepared = await this.helper(PREPARE_GENERATION, buildPreparePayload(row, retired, fresh));
		if (!(await consumeHelperDigest(prepared, fresh.headDigest))) {
			zeroGeneration(fresh);
			return this.fatal(failedResult());
		}
		const switched = await this.helper(SWITCH_HEAD, buildSwitchPayload(row, retired, fresh));
		if (!(await consumeHelperDigest(switched, fresh.headDigest))) {
			zeroGeneration(fresh);
			return this.fatal(failedResult());
		}
		const removed = await this.helper(REMOVE_RETIRED, buildRemovePayload(row, retired));
		if (!removed.ok || removed.payloads.length !== 0) {
			zeroGeneration(fresh);
			return this.fatal(failedResult());
		}
		row.generation = fresh;
		row.terminal = undefined;
		zeroGeneration(retired);
		const next = makeSemantic(row.identity, "ALLOCATED", fresh.keyHex, row.digests);
		if (!(await this.replaceRegistry(row, expected, next))) return this.fatal(failedResult());
		return committedResult();
	}

	async purgeOperation(sessionRaw: unknown): Promise<FixedStoreResult> {
		if (this.poisoned || this.owner.isPoisoned()) return this.fatal(failedResult());
		const row = this.rowFor(sessionRaw);
		if (row === undefined) return invalidResult();
		if (!(await this.reconcile(row))) return this.fatal(failedResult());
		const current = stateName(row.generation.decoded[row.generation.decoded.length - 1].state);
		const ledger = row.ledgerRecords[row.ledgerRecords.length - 1];
		if (current !== "ABSENT" || ledger.status !== "deleted") return staleResult();
		const result = await this.helper(PURGE, buildPurgePayload(row));
		if (!result.ok || result.payloads.length !== 0) return this.fatal(failedResult());
		const session = row.session;
		if (session === undefined) return this.fatal(failedResult());
		this.rows.delete(session);
		this.lifecycle.delete(row.lifecycleHex);
		const index = this.order.indexOf(session);
		if (index >= 0) this.order.splice(index, 1);
		zeroRow(row);
		return committedResult();
	}

	async closeOperation(): Promise<{ code: "CLOSED" } | { code: "FAILED" }> {
		let healthy = false;
		if (this.poisoned) await this.owner.poison();
		else healthy = await this.owner.closeHealthy();
		this.owner.dropResources();
		for (const row of this.rows.values()) zeroRow(row);
		this.rows.clear();
		this.lifecycle.clear();
		this.generations.clear();
		zeroList(this.generationBytes);
		this.order.length = 0;
		this.queue.length = 0;
		this.registry = undefined;
		return healthy ? closedResult() : failedResult();
	}
}

function zeroListResult(values: readonly Uint8Array[]): void {
	for (let index = 0; index < values.length; index += 1) zeroBytes(values[index]);
}

function freshInventory(sessions: object[]): { code: "INVENTORIED"; sessions: readonly object[] } {
	const copied: object[] = [];
	for (let index = 0; index < sessions.length; index += 1) copied[index] = sessions[index];
	_freeze(copied);
	return _freeze({ code: "INVENTORIED", sessions: copied });
}

interface AllocateSuccess {
	readonly code: "ALLOCATED" | "EXISTS";
	readonly session: object;
}

function freshAllocation(code: "ALLOCATED" | "EXISTS", session: object): AllocateSuccess {
	return _freeze({ code, session });
}

function freshState(state: ProviderWalState): { code: "STATE"; state: ProviderWalState } {
	return _freeze({ code: "STATE", state });
}

async function consumeHelperDigest(result: HelperResult, expected: Uint8Array): Promise<boolean> {
	if (!result.ok || result.payloads.length !== 1) return false;
	const equal = sameBytes(result.payloads[0], expected);
	zeroListResult(result.payloads);
	return equal;
}

function buildStore(core: StoreCore): HostedSessionStore {
	let closePromise: Promise<{ code: "CLOSED" } | { code: "FAILED" }> | undefined;
	const store: HostedSessionStore = {
		inventory: () => core.enqueue(() => core.inventoryOperation(), failedResult()),
		allocate: (identityRaw: unknown, digestsRaw: unknown) =>
			core.enqueue(() => core.allocateOperation(identityRaw, digestsRaw), failedResult()),
		state: (sessionRaw: unknown) => core.enqueue(() => core.stateOperation(sessionRaw), failedResult()),
		createDispatched: (sessionRaw: unknown) =>
			core.enqueue(
				() => core.simpleTransitionOperation(sessionRaw, "ALLOCATED", "CREATE_DISPATCHED", "allocating"),
				failedResult(),
			),
		present: (sessionRaw: unknown) =>
			core.enqueue(
				() => core.simpleTransitionOperation(sessionRaw, "CREATE_DISPATCHED", "PRESENT", "allocated"),
				failedResult(),
			),
		runtimeDispatched: (sessionRaw: unknown) =>
			core.enqueue(
				() => core.simpleTransitionOperation(sessionRaw, "PRESENT", "RUNTIME_DISPATCHED", "starting"),
				failedResult(),
			),
		running: (sessionRaw: unknown) =>
			core.enqueue(
				() => core.simpleTransitionOperation(sessionRaw, "RUNTIME_DISPATCHED", "RUNNING", "running"),
				failedResult(),
			),
		deleteDispatched: (sessionRaw: unknown, terminalRaw: unknown) =>
			core.enqueue(() => core.deleteOperation(sessionRaw, terminalRaw), failedResult()),
		cleanupUncertain: (sessionRaw: unknown) => core.enqueue(() => core.cleanupOperation(sessionRaw), failedResult()),
		absent: (sessionRaw: unknown) => core.enqueue(() => core.absentOperation(sessionRaw), failedResult()),
		retireAndAdvance: (sessionRaw: unknown) => core.enqueue(() => core.retireOperation(sessionRaw), failedResult()),
		purge: (sessionRaw: unknown) => core.enqueue(() => core.purgeOperation(sessionRaw), failedResult()),
		close: () => {
			if (closePromise !== undefined) return closePromise;
			core.beginClose();
			closePromise = core.enqueueClose(() => core.closeOperation());
			core.retain(closePromise);
			return closePromise;
		},
	};
	return _freeze(store);
}

export function createHostedSessionStore(
	registryViewRaw: unknown,
): Promise<{ code: "READY"; store: HostedSessionStore } | { code: "FAILED" }> {
	return new _Promise<{ code: "READY"; store: HostedSessionStore } | { code: "FAILED" }>((resolveFactory) => {
		const retained: object[] = [];
		const registry = validateRegistry(registryViewRaw);
		if (registry === undefined) {
			resolveFactory(failedResult());
			return;
		}
		const helper = validateHelper();
		if (helper === undefined) {
			resolveFactory(failedResult());
			return;
		}
		const owner = new HelperOwner();
		const started = owner.start(helper);
		retained[retained.length] = started;
		const finishFailure = () => {
			const cleanup = owner.poison();
			retained[retained.length] = cleanup;
			const cleanupObserver = _reflectApply(_promiseThen, cleanup, [
				() => resolveFactory(failedResult()),
				() => resolveFactory(failedResult()),
			]);
			if (typeof cleanupObserver === "object" && cleanupObserver !== null)
				retained[retained.length] = cleanupObserver;
		};
		const observer = _reflectApply(_promiseThen, started, [
			(ready: boolean) => {
				if (!ready) {
					finishFailure();
					return;
				}
				const core = new StoreCore(registry, owner);
				const store = buildStore(core);
				resolveFactory(_freeze({ code: "READY", store }));
			},
			() => finishFailure(),
		]);
		if (typeof observer === "object" && observer !== null) retained[retained.length] = observer;
	});
}
