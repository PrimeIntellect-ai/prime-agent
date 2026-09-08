import { types } from "node:util";
import type { AgentFamilyRelationship } from "../../../core/agent-messages.js";
import { copySandboxStrictBytes, type SandboxStrictByteCopyResult } from "./prime-sandbox-strict-bytes.js";
import {
	decodeReply,
	encodeReply,
	type V16ReplyEncodeResult,
	type V16WireIdentity,
} from "./prime-sandbox-v16-reply-codec.js";
import {
	decodeRequest,
	utf8ByteCount,
	type V16DecodeCorrelated,
	type V16Method,
	validateUtf8String,
} from "./prime-sandbox-v16-request-codec.js";
import type { ApplicationBundle, ComposedReplyResult } from "./prime-sandbox-v31-multiplexer.js";

const MAX_MESSAGE_BYTES: number = 16_384;
const MAX_NAME_BYTES: number = 256;
const MAX_SELECTOR_BYTES: number = 128;
const MAX_REQUEST_BYTES: number = 262128;
const MAX_RECORDS: number = 64;

const _freeze: typeof Object.freeze = Object.freeze;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _keys: typeof Object.keys = Object.keys;
const _ReflectApply: typeof Reflect.apply = Reflect.apply;
const _isSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _is: typeof Object.is = Object.is;
const _isProxy: (value: object) => boolean = types.isProxy;
const _isPromise: (value: unknown) => boolean = types.isPromise;
const _Promise: PromiseConstructor = Promise;
const _promisePrototype: object = Promise.prototype;
const _promiseThen: typeof Promise.prototype.then = Promise.prototype.then;
const _create: typeof Object.create = Object.create;
const _defineProperty: typeof Object.defineProperty = Object.defineProperty;
let _abortSignalAborted: ((this: AbortSignal) => boolean) | undefined;
try {
	const desc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
	if (desc !== undefined && typeof desc.get === "function") {
		_abortSignalAborted = desc.get;
	}
} catch {
	_abortSignalAborted = undefined;
}
const _queueMicrotask: (fn: () => void) => void = queueMicrotask;

interface DescriptorTable {
	readonly names: ReadonlyArray<string>;
	readonly table: Record<string, TypedPropertyDescriptor<unknown>>;
}

interface CapturedMessageController {
	readonly receiver: object;
	readonly listAgents: CallableFunction;
	readonly roster?: CallableFunction;
	readonly awaitPendingChildPublication?: CallableFunction;
	readonly assertSessionNameAvailable?: CallableFunction;
	readonly setSessionName?: CallableFunction;
	readonly sendAgentMessage: CallableFunction;
}

interface CapturedObserveController {
	readonly receiver: object;
	readonly listAgents: CallableFunction;
	readonly getAgent: CallableFunction;
	readonly recentMessages: CallableFunction;
}

interface PrimeSandboxHostedControllerAdapter {
	readonly invoke: (method: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
}

interface CreateHostedControllerAdapterSuccess {
	readonly ok: true;
	readonly adapter: PrimeSandboxHostedControllerAdapter;
}

interface CreateHostedControllerAdapterFailure {
	readonly ok: false;
	readonly code: "INPUT_INVALID" | "WRONG_OWNER";
}

type CreateHostedControllerAdapterResult = CreateHostedControllerAdapterSuccess | CreateHostedControllerAdapterFailure;

function inputFailure(): CreateHostedControllerAdapterFailure {
	return _freeze({ ok: false, code: "INPUT_INVALID" });
}

function ownerFailure(): CreateHostedControllerAdapterFailure {
	return _freeze({ ok: false, code: "WRONG_OWNER" });
}

// INPUT_INVALID and WRONG_OWNER are local adapter diagnostics. V16 does not
// admit them on the wire, so the invocation authority canonicalizes either to
// CONTROLLER_FAILURE before a sandbox can observe the reply.
function operationFailure(
	code: "INPUT_INVALID" | "WRONG_OWNER" | "CONTROLLER_FAILURE" | "METHOD_UNAVAILABLE",
): unknown {
	return _freeze({ error: code });
}

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function safeIsProxy(value: object): boolean {
	try {
		return _isProxy(value);
	} catch {
		return true;
	}
}

function captureDescriptors(value: object): DescriptorTable | undefined {
	if (safeIsProxy(value)) return undefined;
	let prototype: object | null;
	let symbols: ReadonlyArray<symbol>;
	let table: Record<string, TypedPropertyDescriptor<unknown>>;
	try {
		prototype = _getPrototypeOf(value);
		symbols = _getOwnPropertySymbols(value);
		table = _getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
	if (prototype !== Object.prototype) return undefined;
	if (symbols.length !== 0) return undefined;
	const names: ReadonlyArray<string> = _keys(table);
	for (let index: number = 0; index < names.length; index++) {
		const descriptor: TypedPropertyDescriptor<unknown> | undefined = table[names[index]];
		if (descriptor === undefined) return undefined;
		if (!("value" in descriptor)) return undefined;
		if (descriptor.enumerable !== true) return undefined;
		if (descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
	}
	return { names: names, table: table };
}

function captureExact(value: unknown, expected: ReadonlyArray<string>): DescriptorTable | undefined {
	if (!isRecord(value)) return undefined;
	const captured: DescriptorTable | undefined = captureDescriptors(value);
	if (captured === undefined) return undefined;
	if (captured.names.length !== expected.length) return undefined;
	for (let index: number = 0; index < captured.names.length; index++) {
		if (expected.indexOf(captured.names[index]) < 0) return undefined;
	}
	return captured;
}

function hasOnlyKnownKeys(captured: DescriptorTable, known: ReadonlyArray<string>): boolean {
	for (let index: number = 0; index < captured.names.length; index++) {
		if (known.indexOf(captured.names[index]) < 0) return false;
	}
	return true;
}

function captureCallable(captured: DescriptorTable, name: string): CallableFunction | undefined {
	const descriptor: TypedPropertyDescriptor<unknown> | undefined = captured.table[name];
	if (descriptor === undefined) return undefined;
	const value: unknown = descriptor.value;
	if (typeof value !== "function") return undefined;
	if (safeIsProxy(value)) return undefined;
	return value;
}

function captureMessageController(raw: unknown): CapturedMessageController | undefined {
	if (!isRecord(raw)) return undefined;
	const captured: DescriptorTable | undefined = captureDescriptors(raw);
	if (captured === undefined) return undefined;
	const known: ReadonlyArray<string> = _freeze([
		"listAgents",
		"roster",
		"awaitPendingChildPublication",
		"assertSessionNameAvailable",
		"setSessionName",
		"sendAgentMessage",
	]);
	if (!hasOnlyKnownKeys(captured, known)) return undefined;
	const listAgents = captureCallable(captured, "listAgents");
	const roster = captureCallable(captured, "roster");
	const awaitPendingChildPublication = captureCallable(captured, "awaitPendingChildPublication");
	const assertSessionNameAvailable = captureCallable(captured, "assertSessionNameAvailable");
	const setSessionName = captureCallable(captured, "setSessionName");
	const sendAgentMessage = captureCallable(captured, "sendAgentMessage");
	if (listAgents === undefined || sendAgentMessage === undefined) return undefined;
	for (let index: number = 0; index < captured.names.length; index++) {
		const descriptor: TypedPropertyDescriptor<unknown> | undefined = captured.table[captured.names[index]];
		if (descriptor === undefined) return undefined;
		if (descriptor.value !== undefined && captureCallable(captured, captured.names[index]) === undefined)
			return undefined;
	}
	return {
		receiver: raw,
		listAgents: listAgents,
		roster: roster,
		awaitPendingChildPublication: awaitPendingChildPublication,
		assertSessionNameAvailable: assertSessionNameAvailable,
		setSessionName: setSessionName,
		sendAgentMessage: sendAgentMessage,
	};
}

function captureObserveController(raw: unknown): CapturedObserveController | undefined {
	if (!isRecord(raw)) return undefined;
	const captured: DescriptorTable | undefined = captureDescriptors(raw);
	if (captured === undefined) return undefined;
	const expected: ReadonlyArray<string> = _freeze(["listAgents", "getAgent", "recentMessages"]);
	if (!hasOnlyKnownKeys(captured, expected)) return undefined;
	if (captured.names.length !== expected.length) return undefined;
	const listAgents = captureCallable(captured, "listAgents");
	const getAgent = captureCallable(captured, "getAgent");
	const recentMessages = captureCallable(captured, "recentMessages");
	if (listAgents === undefined || getAgent === undefined || recentMessages === undefined) return undefined;
	return {
		receiver: raw,
		listAgents: listAgents,
		getAgent: getAgent,
		recentMessages: recentMessages,
	};
}

function isIdentifier(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length < 1 || value.length > 128) return false;
	for (let index: number = 0; index < value.length; index++) {
		const code: number = value.charCodeAt(index);
		const letter: boolean = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		const digit: boolean = code >= 48 && code <= 57;
		if (index === 0) {
			if (!letter && !digit) return false;
		} else if (!letter && !digit && code !== 95 && code !== 45) {
			return false;
		}
	}
	return true;
}

function captureIdentity(raw: unknown): V16WireIdentity | undefined {
	const captured: DescriptorTable | undefined = captureExact(
		raw,
		_freeze(["activeSessionId", "sessionId", "rlmChildId", "depth", "sessionName"]),
	);
	if (captured === undefined) return undefined;
	const activeSessionId: unknown = captured.table.activeSessionId.value;
	const sessionId: unknown = captured.table.sessionId.value;
	const rlmChildId: unknown = captured.table.rlmChildId.value;
	const depth: unknown = captured.table.depth.value;
	const sessionName: unknown = captured.table.sessionName.value;
	if (!isIdentifier(activeSessionId)) return undefined;
	if (!isIdentifier(sessionId)) return undefined;
	if (!isIdentifier(rlmChildId)) return undefined;
	if (typeof depth !== "number" || !_isSafeInteger(depth) || depth < 0 || depth > 255) return undefined;
	if (typeof sessionName !== "string" || utf8ByteCount(sessionName) > MAX_NAME_BYTES) return undefined;
	return _freeze({
		activeSessionId: activeSessionId,
		sessionId: sessionId,
		rlmChildId: rlmChildId,
		depth: depth,
		sessionName: sessionName,
	});
}

function signalAborted(signal: unknown): boolean | undefined {
	if (!isRecord(signal)) return undefined;
	if (_abortSignalAborted === undefined) return undefined;
	if (safeIsProxy(signal)) return undefined;
	try {
		return _ReflectApply(_abortSignalAborted, signal, []);
	} catch {
		return undefined;
	}
}

function isMethod(value: string): value is V16Method {
	if (value === "list_agents") return true;
	if (value === "roster") return true;
	if (value === "await_pending") return true;
	if (value === "assert_name") return true;
	if (value === "set_name") return true;
	if (value === "send_message") return true;
	if (value === "observe_list") return true;
	if (value === "observe_get") return true;
	if (value === "observe_recent") return true;
	return false;
}

function hasNoKeys(raw: unknown): boolean {
	const captured: DescriptorTable | undefined = captureExact(raw, _freeze([]));
	return captured !== undefined;
}

function validDepth(value: unknown): value is number {
	return typeof value === "number" && _isSafeInteger(value) && !_is(value, -0) && value >= 0 && value <= 100;
}

function validOptionalId(value: unknown): value is string | null {
	return value === null || isIdentifier(value);
}

function validRole(value: unknown): value is AgentFamilyRelationship | null {
	return value === null || value === "parent" || value === "sibling" || value === "child";
}

function validRequestBody(method: V16Method, body: unknown): DescriptorTable | undefined {
	if (method === "list_agents" || method === "roster" || method === "observe_list") {
		return hasNoKeys(body) ? captureExact(body, _freeze([])) : undefined;
	}
	if (method === "await_pending") {
		const captured = captureExact(body, _freeze(["selector"]));
		if (captured === undefined) return undefined;
		return validateUtf8String(captured.table.selector.value, MAX_SELECTOR_BYTES) === undefined ? undefined : captured;
	}
	if (method === "assert_name") {
		const captured = captureExact(body, _freeze(["name", "depth", "parentSessionId", "ignoreSessionId"]));
		if (captured === undefined) return undefined;
		if (validateUtf8String(captured.table.name.value, MAX_NAME_BYTES) === undefined) return undefined;
		if (!validDepth(captured.table.depth.value)) return undefined;
		if (!validOptionalId(captured.table.parentSessionId.value)) return undefined;
		if (!validOptionalId(captured.table.ignoreSessionId.value)) return undefined;
		return captured;
	}
	if (method === "set_name") {
		const captured = captureExact(body, _freeze(["name"]));
		if (captured === undefined) return undefined;
		return validateUtf8String(captured.table.name.value, MAX_NAME_BYTES) === undefined ? undefined : captured;
	}
	if (method === "send_message") {
		const captured = captureExact(body, _freeze(["target", "message", "receiverRole"]));
		if (captured === undefined) return undefined;
		if (!isIdentifier(captured.table.target.value)) return undefined;
		const message: unknown = captured.table.message.value;
		if (typeof message !== "string" || message.length < 1 || utf8ByteCount(message) > MAX_MESSAGE_BYTES)
			return undefined;
		if (!validRole(captured.table.receiverRole.value)) return undefined;
		return captured;
	}
	if (method === "observe_get") {
		const captured = captureExact(body, _freeze(["target"]));
		if (captured === undefined || !isIdentifier(captured.table.target.value)) return undefined;
		return captured;
	}
	const captured = captureExact(body, _freeze(["target", "limit", "maxChars"]));
	if (captured === undefined || !isIdentifier(captured.table.target.value)) return undefined;
	const limit: unknown = captured.table.limit.value;
	const maxChars: unknown = captured.table.maxChars.value;
	if (
		limit !== null &&
		(typeof limit !== "number" || !_isSafeInteger(limit) || _is(limit, -0) || limit < 1 || limit > 50)
	) {
		return undefined;
	}
	if (
		maxChars !== null &&
		(typeof maxChars !== "number" ||
			!_isSafeInteger(maxChars) ||
			_is(maxChars, -0) ||
			maxChars < 80 ||
			maxChars > 2000)
	) {
		return undefined;
	}
	return captured;
}

function isNativePromise(value: unknown): value is Promise<unknown> {
	if (!isRecord(value) || safeIsProxy(value)) return false;
	if (!_isPromise(value)) return false;
	try {
		return _getPrototypeOf(value) === _promisePrototype;
	} catch {
		return false;
	}
}

function withoutOwnThen(raw: unknown): unknown {
	if (!isRecord(raw) || safeIsProxy(raw)) return raw;
	let prototype: object | null;
	let symbols: ReadonlyArray<symbol>;
	let descriptors: Record<string, TypedPropertyDescriptor<unknown>>;
	try {
		prototype = _getPrototypeOf(raw);
		symbols = _getOwnPropertySymbols(raw);
		descriptors = _getOwnPropertyDescriptors(raw);
	} catch {
		return raw;
	}
	if (prototype !== Object.prototype && prototype !== null) return raw;
	if (symbols.length !== 0) return raw;
	if (descriptors.then === undefined) return raw;
	const copy: object = _create(prototype);
	const names: ReadonlyArray<string> = _keys(descriptors);
	for (let index: number = 0; index < names.length; index++) {
		const name: string = names[index];
		if (name === "then") continue;
		const descriptor: TypedPropertyDescriptor<unknown> | undefined = descriptors[name];
		if (descriptor === undefined) return raw;
		_defineProperty(copy, name, descriptor);
	}
	return copy;
}

function hasDynamicError(raw: unknown): boolean {
	if (!isRecord(raw)) return false;
	const captured: DescriptorTable | undefined = captureDescriptors(raw);
	if (captured === undefined) return false;
	return captured.table.error !== undefined;
}

function isIdentityField(name: string): boolean {
	if (name === "id") return true;
	if (name === "activeSessionId") return true;
	if (name === "sessionId") return true;
	if (name === "parentActiveSessionId") return true;
	if (name === "parentSessionId") return true;
	if (name === "rlmChildId") return true;
	if (name === "rlmParentNodeId") return true;
	return false;
}

function isBoundedMetadataField(name: string): boolean {
	if (name === "name") return true;
	if (name === "sessionName") return true;
	if (name === "status") return true;
	if (name === "role") return true;
	if (name === "customType") return true;
	if (name === "deliveredAt") return true;
	if (name === "queuedAt") return true;
	return false;
}

function safeExportedMetadata(value: unknown, seen: WeakSet<object>): boolean {
	if (!isRecord(value)) return true;
	if (seen.has(value)) return false;
	seen.add(value);
	const descriptors: Record<string, TypedPropertyDescriptor<unknown>> = _getOwnPropertyDescriptors(value);
	const names: ReadonlyArray<string> = _keys(descriptors);
	for (let index: number = 0; index < names.length; index++) {
		const name: string = names[index];
		const descriptor: TypedPropertyDescriptor<unknown> | undefined = descriptors[name];
		if (descriptor === undefined || !("value" in descriptor)) return false;
		const field: unknown = descriptor.value;
		if (name === "clientId") return false;
		if (isIdentityField(name) && !isIdentifier(field)) return false;
		if (isBoundedMetadataField(name)) {
			if (validateUtf8String(field, MAX_NAME_BYTES) === undefined) return false;
		}
		if (isRecord(field) && !safeExportedMetadata(field, seen)) return false;
	}
	return true;
}

function deepFreezeTrusted(value: unknown, seen: WeakSet<object>): unknown {
	if (!isRecord(value)) return value;
	if (seen.has(value)) return value;
	seen.add(value);
	const descriptors: Record<string, TypedPropertyDescriptor<unknown>> = _getOwnPropertyDescriptors(value);
	const names: ReadonlyArray<string> = _keys(descriptors);
	for (let index: number = 0; index < names.length; index++) {
		const descriptor: TypedPropertyDescriptor<unknown> | undefined = descriptors[names[index]];
		if (descriptor !== undefined && "value" in descriptor) deepFreezeTrusted(descriptor.value, seen);
	}
	return _freeze(value);
}

function sanitizeControllerOutput(method: V16Method, raw: unknown, identity: V16WireIdentity): unknown | undefined {
	const candidate: unknown = withoutOwnThen(raw);
	if (hasDynamicError(candidate)) return undefined;
	let encodedBytes: Uint8Array | null = null;
	try {
		const encoded = encodeReply(method, candidate, identity);
		if (!encoded.ok) return undefined;
		encodedBytes = encoded.bytes;
		const decoded = decodeReply(encodedBytes, method, identity);
		if (!decoded.ok) return undefined;
		if (!safeExportedMetadata(decoded.reply.body, new WeakSet())) return undefined;
		return deepFreezeTrusted(decoded.reply.body, new WeakSet());
	} catch {
		return undefined;
	} finally {
		if (encodedBytes !== null) {
			for (let index: number = 0; index < encodedBytes.length; index++) encodedBytes[index] = 0;
		}
	}
}

function safeBodyTable(body: unknown): DescriptorTable | undefined {
	if (!isRecord(body) || safeIsProxy(body)) return undefined;
	let prototype: object | null;
	let symbols: ReadonlyArray<symbol>;
	let table: Record<string, TypedPropertyDescriptor<unknown>>;
	try {
		prototype = _getPrototypeOf(body);
		symbols = _getOwnPropertySymbols(body);
		table = _getOwnPropertyDescriptors(body);
	} catch {
		return undefined;
	}
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	if (symbols.length !== 0) return undefined;
	const names: ReadonlyArray<string> = _keys(table);
	for (let index: number = 0; index < names.length; index++) {
		const descriptor: TypedPropertyDescriptor<unknown> | undefined = table[names[index]];
		if (descriptor === undefined || !("value" in descriptor)) return undefined;
	}
	return { names: names, table: table };
}

function endpointMatchesTarget(raw: unknown, target: string): boolean {
	const captured: DescriptorTable | undefined = safeBodyTable(raw);
	if (captured === undefined) return false;
	const candidates: ReadonlyArray<string> = _freeze(["activeSessionId", "sessionId", "rlmChildId", "sessionName"]);
	for (let index: number = 0; index < candidates.length; index++) {
		const descriptor: TypedPropertyDescriptor<unknown> | undefined = captured.table[candidates[index]];
		if (descriptor !== undefined && descriptor.value === target) return true;
	}
	return false;
}

function endpointMatchesIdentity(raw: unknown, identity: V16WireIdentity): boolean {
	const captured: DescriptorTable | undefined = safeBodyTable(raw);
	if (captured === undefined) return false;
	if (captured.table.activeSessionId?.value !== identity.activeSessionId) return false;
	if (captured.table.sessionId?.value !== identity.sessionId) return false;
	const child: TypedPropertyDescriptor<unknown> | undefined = captured.table.rlmChildId;
	if (child !== undefined && child.value !== identity.rlmChildId) return false;
	return true;
}

function outputIsOwned(method: V16Method, body: unknown, request: DescriptorTable, identity: V16WireIdentity): boolean {
	const outer: DescriptorTable | undefined = safeBodyTable(body);
	if (outer === undefined) return method === "await_pending" || method === "assert_name" || method === "set_name";
	if (method === "list_agents") {
		const current: TypedPropertyDescriptor<unknown> | undefined = outer.table.current;
		return current !== undefined && endpointMatchesIdentity(current.value, identity);
	}
	if (method === "roster") {
		const current: TypedPropertyDescriptor<unknown> | undefined = outer.table.current;
		const captured: DescriptorTable | undefined = current === undefined ? undefined : safeBodyTable(current.value);
		if (captured === undefined) return false;
		const id: unknown = captured.table.id?.value;
		return (
			captured.table.depth?.value === identity.depth &&
			(id === identity.rlmChildId || id === identity.sessionId || id === identity.activeSessionId)
		);
	}
	if (method === "send_message") {
		const target: TypedPropertyDescriptor<unknown> | undefined = outer.table.target;
		const requestedTarget: unknown = request.table.target.value;
		if (typeof requestedTarget !== "string") return false;
		if (target === undefined || !endpointMatchesTarget(target.value, requestedTarget)) return false;
		if (outer.table.message?.value !== request.table.message.value) return false;
		const sender: TypedPropertyDescriptor<unknown> | undefined = outer.table.from;
		if (sender !== undefined) {
			const senderTable: DescriptorTable | undefined = safeBodyTable(sender.value);
			if (senderTable === undefined) return false;
			const active = senderTable.table.activeSessionId;
			const session = senderTable.table.sessionId;
			if (active !== undefined && active.value !== identity.activeSessionId) return false;
			if (session !== undefined && session.value !== identity.sessionId) return false;
		}
		return true;
	}
	if (method === "observe_list") {
		const current: TypedPropertyDescriptor<unknown> | undefined = outer.table.current;
		if (current === undefined || !endpointMatchesIdentity(current.value, identity)) return false;
		const captured: DescriptorTable | undefined = safeBodyTable(current.value);
		return captured !== undefined && captured.table.isCurrent?.value === true;
	}
	if (method === "observe_get" || method === "observe_recent") {
		const agent: TypedPropertyDescriptor<unknown> | undefined = outer.table.agent;
		const requestedTarget: unknown = request.table.target.value;
		return (
			typeof requestedTarget === "string" &&
			agent !== undefined &&
			endpointMatchesTarget(agent.value, requestedTarget)
		);
	}
	return true;
}

interface MessageControllerInput {
	readonly target: string;
	readonly message: string;
	readonly receiverRole?: AgentFamilyRelationship;
}

function createMessageInput(request: DescriptorTable): MessageControllerInput | undefined {
	const target: unknown = request.table.target.value;
	const message: unknown = request.table.message.value;
	const role: unknown = request.table.receiverRole.value;
	if (typeof target !== "string" || typeof message !== "string") return undefined;
	const input: { target: string; message: string; receiverRole?: AgentFamilyRelationship } = {
		target: target,
		message: message,
	};
	if (role === "parent" || role === "sibling" || role === "child") input.receiverRole = role;
	return _freeze(input);
}

interface NameControllerInput {
	readonly name: string;
	readonly depth: number;
	readonly parentSessionId?: string;
	readonly ignoreSessionId?: string;
}

function createNameInput(request: DescriptorTable): NameControllerInput | undefined {
	const name: unknown = request.table.name.value;
	const depth: unknown = request.table.depth.value;
	if (typeof name !== "string" || typeof depth !== "number") return undefined;
	const input: { name: string; depth: number; parentSessionId?: string; ignoreSessionId?: string } = {
		name: name,
		depth: depth,
	};
	const parent: unknown = request.table.parentSessionId.value;
	const ignored: unknown = request.table.ignoreSessionId.value;
	if (typeof parent === "string") input.parentSessionId = parent;
	if (typeof ignored === "string") input.ignoreSessionId = ignored;
	return _freeze(input);
}

interface RecentControllerInput {
	readonly target: string;
	readonly limit?: number;
	readonly maxChars?: number;
}

function createRecentInput(request: DescriptorTable): RecentControllerInput | undefined {
	const target: unknown = request.table.target.value;
	if (typeof target !== "string") return undefined;
	const input: { target: string; limit?: number; maxChars?: number } = { target: target };
	const limit: unknown = request.table.limit.value;
	const maxChars: unknown = request.table.maxChars.value;
	if (typeof limit === "number") input.limit = limit;
	if (typeof maxChars === "number") input.maxChars = maxChars;
	return _freeze(input);
}

function dispatch(
	method: V16Method,
	request: DescriptorTable,
	message: CapturedMessageController,
	observe: CapturedObserveController,
	signal: AbortSignal,
): { readonly available: boolean; readonly value?: unknown } {
	if (method === "list_agents")
		return { available: true, value: _ReflectApply(message.listAgents, message.receiver, [signal]) };
	if (method === "roster") {
		if (message.roster === undefined) return { available: false };
		return { available: true, value: _ReflectApply(message.roster, message.receiver, [signal]) };
	}
	if (method === "await_pending") {
		if (message.awaitPendingChildPublication === undefined) return { available: false };
		return {
			available: true,
			value: _ReflectApply(message.awaitPendingChildPublication, message.receiver, [
				request.table.selector.value,
				signal,
			]),
		};
	}
	if (method === "assert_name") {
		if (message.assertSessionNameAvailable === undefined) return { available: false };
		const input: NameControllerInput | undefined = createNameInput(request);
		if (input === undefined) return { available: true };
		return {
			available: true,
			value: _ReflectApply(message.assertSessionNameAvailable, message.receiver, [input, signal]),
		};
	}
	if (method === "set_name") {
		if (message.setSessionName === undefined) return { available: false };
		return {
			available: true,
			value: _ReflectApply(message.setSessionName, message.receiver, [request.table.name.value, signal]),
		};
	}
	if (method === "send_message") {
		const input: MessageControllerInput | undefined = createMessageInput(request);
		if (input === undefined) return { available: true };
		return { available: true, value: _ReflectApply(message.sendAgentMessage, message.receiver, [input, signal]) };
	}
	if (method === "observe_list")
		return { available: true, value: _ReflectApply(observe.listAgents, observe.receiver, [signal]) };
	if (method === "observe_get") {
		return {
			available: true,
			value: _ReflectApply(observe.getAgent, observe.receiver, [request.table.target.value, signal]),
		};
	}
	const input: RecentControllerInput | undefined = createRecentInput(request);
	if (input === undefined) return { available: true };
	return { available: true, value: _ReflectApply(observe.recentMessages, observe.receiver, [input, signal]) };
}

function resolvedOperation(value: unknown): Promise<unknown> {
	return new _Promise<unknown>((resolve: (result: unknown) => void): void => resolve(value));
}

/**
 * The composer supplies one lexical authorization callback. That callback owns
 * the private session capability and returns identity plus both Home controllers
 * atomically. Callers cannot combine controllers and identity from different
 * accepted owners through this factory input.
 */

interface CapturedBundle {
	readonly identity: V16WireIdentity;
	readonly messageController: CapturedMessageController;
	readonly observeController: CapturedObserveController;
}

type CapturedBundleResult =
	| Readonly<{ ok: true; value: CapturedBundle }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" | "WRONG_OWNER" }>;

function _captureIdentityAndControllers(raw: unknown): CapturedBundleResult {
	const factory: DescriptorTable | undefined = captureExact(raw, _freeze(["sessionOwner", "authorizeIdentity"]));
	if (factory === undefined) {
		const result: CapturedBundleResult = _freeze({ ok: false, code: "INPUT_INVALID" });
		return result;
	}
	const owner: unknown = factory.table.sessionOwner.value;
	const authorizeIdentity: unknown = factory.table.authorizeIdentity.value;
	if (!isRecord(owner) || safeIsProxy(owner)) {
		const result: CapturedBundleResult = _freeze({ ok: false, code: "INPUT_INVALID" });
		return result;
	}
	if (typeof authorizeIdentity !== "function" || safeIsProxy(authorizeIdentity)) {
		const result: CapturedBundleResult = _freeze({ ok: false, code: "INPUT_INVALID" });
		return result;
	}
	let bundleRaw: unknown;
	try {
		bundleRaw = _ReflectApply(authorizeIdentity, null, [owner]);
	} catch {
		const result: CapturedBundleResult = _freeze({ ok: false, code: "WRONG_OWNER" });
		return result;
	}
	const bundle: DescriptorTable | undefined = captureExact(
		bundleRaw,
		_freeze(["identity", "messageController", "observeController"]),
	);
	if (bundle === undefined) {
		const result: CapturedBundleResult = _freeze({ ok: false, code: "WRONG_OWNER" });
		return result;
	}
	const identity: V16WireIdentity | undefined = captureIdentity(bundle.table.identity.value);
	const message: CapturedMessageController | undefined = captureMessageController(
		bundle.table.messageController.value,
	);
	const observe: CapturedObserveController | undefined = captureObserveController(
		bundle.table.observeController.value,
	);
	if (identity === undefined || message === undefined || observe === undefined) {
		const result: CapturedBundleResult = _freeze({ ok: false, code: "WRONG_OWNER" });
		return result;
	}
	const result: CapturedBundleResult = _freeze({
		ok: true,
		value: _freeze({
			identity: identity,
			messageController: message,
			observeController: observe,
		}),
	});
	return result;
}

function _makeInvokeCaptured(
	identity: V16WireIdentity,
	message: CapturedMessageController,
	observe: CapturedObserveController,
): (methodRaw: string, body: unknown, signal: AbortSignal) => Promise<unknown> {
	const invokeCaptured = (methodRaw: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
		if (typeof methodRaw !== "string" || !isMethod(methodRaw)) {
			return resolvedOperation(operationFailure("INPUT_INVALID"));
		}
		const request: DescriptorTable | undefined = validRequestBody(methodRaw, body);
		const abortedBefore: boolean | undefined = signalAborted(signal);
		if (request === undefined || abortedBefore === undefined) {
			return resolvedOperation(operationFailure("INPUT_INVALID"));
		}
		if (abortedBefore) return resolvedOperation(operationFailure("CONTROLLER_FAILURE"));
		let dispatched: { readonly available: boolean; readonly value?: unknown };
		try {
			dispatched = dispatch(methodRaw, request, message, observe, signal);
		} catch {
			return resolvedOperation(operationFailure("CONTROLLER_FAILURE"));
		}
		if (!dispatched.available) return resolvedOperation(operationFailure("METHOD_UNAVAILABLE"));
		const settled = function settled(rawOutput: unknown): unknown {
			if (signalAborted(signal) !== false) return operationFailure("CONTROLLER_FAILURE");
			const normalizedOutput: unknown = methodRaw === "await_pending" && rawOutput === undefined ? null : rawOutput;
			const sanitized: unknown | undefined = sanitizeControllerOutput(methodRaw, normalizedOutput, identity);
			if (sanitized === undefined) return operationFailure("CONTROLLER_FAILURE");
			if (!outputIsOwned(methodRaw, sanitized, request, identity)) return operationFailure("WRONG_OWNER");
			return sanitized;
		};
		const rejected = function rejected(): unknown {
			return operationFailure("CONTROLLER_FAILURE");
		};
		if (!isNativePromise(dispatched.value)) return resolvedOperation(settled(dispatched.value));
		const operationPromise: Promise<unknown> = _ReflectApply(_promiseThen, dispatched.value, [settled, rejected]);
		return operationPromise;
	};
	return invokeCaptured;
}

function createPrimeSandboxHostedControllerAdapter(raw: unknown): CreateHostedControllerAdapterResult {
	const capture: CapturedBundleResult = _captureIdentityAndControllers(raw);
	if (!capture.ok) {
		if (capture.code === "INPUT_INVALID") return inputFailure();
		return ownerFailure();
	}
	const invoke: (methodRaw: string, body: unknown, signal: AbortSignal) => Promise<unknown> = _makeInvokeCaptured(
		capture.value.identity,
		capture.value.messageController,
		capture.value.observeController,
	);
	return _freeze({ ok: true, adapter: _freeze({ invoke: invoke }) });
}

// ---------- dispatcher types ----------

type RouteResult = "HANDLED" | "NOT_HANDLED" | "CLOSED" | "INVALID" | "NO_CAPACITY";

interface HostedControllerDispatcher {
	readonly route: (bundle: ApplicationBundle) => RouteResult;
	readonly close: () => void;
}

interface CreateHostedControllerDispatcherSuccess {
	readonly ok: true;
	readonly value: HostedControllerDispatcher;
}

interface CreateHostedControllerDispatcherFailure {
	readonly ok: false;
	readonly code: "INPUT_INVALID" | "WRONG_OWNER";
}

type CreateHostedControllerDispatcherResult =
	| CreateHostedControllerDispatcherSuccess
	| CreateHostedControllerDispatcherFailure;

interface PerFlowRecord {
	operationPromise: Promise<unknown> | null;
	dispatchThenPromise: Promise<unknown> | null;
	replyPromise: Promise<ComposedReplyResult> | null;
	replyThenPromise: Promise<unknown> | null;
	replyBytes: Uint8Array | null;
}

// ---------- dispatcher factory ----------

function createPrimeSandboxHostedControllerDispatcher(raw: unknown): CreateHostedControllerDispatcherResult {
	const capture: CapturedBundleResult = _captureIdentityAndControllers(raw);
	if (!capture.ok) {
		if (capture.code === "INPUT_INVALID") {
			const result: CreateHostedControllerDispatcherFailure = _freeze({ ok: false, code: "INPUT_INVALID" });
			return result;
		}
		const result: CreateHostedControllerDispatcherFailure = _freeze({ ok: false, code: "WRONG_OWNER" });
		return result;
	}
	const { identity, messageController, observeController } = capture.value;
	const invokeCaptured: (methodRaw: string, body: unknown, signal: AbortSignal) => Promise<unknown> =
		_makeInvokeCaptured(identity, messageController, observeController);

	// ---- per-instance mutable routing state ----
	const records: Array<PerFlowRecord | null> = new Array(MAX_RECORDS).fill(null);
	let closed: boolean = false;
	let generation: number = 0;

	function checkAborted(signal: AbortSignal): boolean {
		if (_abortSignalAborted === undefined) return false;
		return _ReflectApply(_abortSignalAborted, signal, []) === true;
	}

	function allocateCell(): number | null {
		for (let i: number = 0; i < MAX_RECORDS; i++) {
			if (records[i] === null) return i;
		}
		return null;
	}

	function maybeFree(cellIndex: number): void {
		const record: PerFlowRecord | null = records[cellIndex];
		if (record === null) return;
		if (record.operationPromise !== null) return;
		if (record.dispatchThenPromise !== null) return;
		if (record.replyPromise !== null) return;
		if (record.replyThenPromise !== null) return;
		if (record.replyBytes !== null) return;
		records[cellIndex] = null;
	}

	function makeZeroAndClear(cellIndex: number, replyBytes: Uint8Array | null): () => void {
		function zeroAndClear(): void {
			const record: PerFlowRecord | null = records[cellIndex];
			if (record === null) return;
			if (replyBytes !== null) {
				for (let i: number = 0; i < replyBytes.length; i++) replyBytes[i] = 0;
			}
			record.replyBytes = null;
			record.replyPromise = null;
			function clearReplyThen(): void {
				const r: PerFlowRecord | null = records[cellIndex];
				if (r !== null) {
					r.replyThenPromise = null;
					maybeFree(cellIndex);
				}
			}
			_queueMicrotask(clearReplyThen);
		}
		return zeroAndClear;
	}

	function retainedReply(
		cellIndex: number,
		reply: (payloadRaw: unknown) => Promise<ComposedReplyResult>,
		payloadRaw: unknown,
		replyBytes: Uint8Array | null,
	): void {
		const record: PerFlowRecord | null = records[cellIndex];
		if (record === null) return;
		const replyPromise: Promise<ComposedReplyResult> = reply(payloadRaw);
		record.replyPromise = replyPromise;
		record.replyBytes = replyBytes;
		const zc: () => void = makeZeroAndClear(cellIndex, replyBytes);
		const replyThenPromise: Promise<unknown> = _ReflectApply(_promiseThen, replyPromise, [zc, zc]);
		record.replyThenPromise = replyThenPromise;
	}

	function makeDispatchSettled(
		cellIndex: number,
		method: string,
		signal: AbortSignal,
		generationAtDispatch: number,
		reply: (payloadRaw: unknown) => Promise<ComposedReplyResult>,
	): (rawOutput: unknown) => void {
		return function settled(rawOutput: unknown): void {
			const record: PerFlowRecord | null = records[cellIndex];
			if (record === null) return;
			function clearDispatchRefs(): void {
				const r: PerFlowRecord | null = records[cellIndex];
				if (r !== null) {
					r.operationPromise = null;
					r.dispatchThenPromise = null;
					maybeFree(cellIndex);
				}
			}
			_queueMicrotask(clearDispatchRefs);
			if (generation !== generationAtDispatch) return;
			if (checkAborted(signal)) return;
			const encoded: V16ReplyEncodeResult = encodeReply(method, rawOutput, identity);
			if (!encoded.ok) {
				retainedReply(cellIndex, reply, new Uint8Array(0), null);
				return;
			}
			retainedReply(cellIndex, reply, encoded.bytes, encoded.bytes);
		};
	}

	function makeDispatchRejected(
		cellIndex: number,
		method: string,
		signal: AbortSignal,
		generationAtDispatch: number,
		reply: (payloadRaw: unknown) => Promise<ComposedReplyResult>,
	): () => void {
		return function rejected(): void {
			const record: PerFlowRecord | null = records[cellIndex];
			if (record === null) return;
			function clearDispatchRefs(): void {
				const r: PerFlowRecord | null = records[cellIndex];
				if (r !== null) {
					r.operationPromise = null;
					r.dispatchThenPromise = null;
					maybeFree(cellIndex);
				}
			}
			_queueMicrotask(clearDispatchRefs);
			if (generation !== generationAtDispatch) return;
			if (checkAborted(signal)) return;
			const encoded: V16ReplyEncodeResult = encodeReply(method, { error: "CONTROLLER_FAILURE" }, identity);
			if (!encoded.ok) {
				retainedReply(cellIndex, reply, new Uint8Array(0), null);
				return;
			}
			retainedReply(cellIndex, reply, encoded.bytes, encoded.bytes);
		};
	}

	function route(bundle: ApplicationBundle): RouteResult {
		if (closed) return "CLOSED";
		if (bundle.origin !== "Runtime") return "NOT_HANDLED";
		if (bundle.stream === 0) return "NOT_HANDLED";
		if (bundle.stream === 1) return "NOT_HANDLED";
		if (bundle.stream === 4) return "NOT_HANDLED";
		if (bundle.stream !== 2 && bundle.stream !== 3) return "NOT_HANDLED";

		const rawCellIndex: number | null = allocateCell();
		if (rawCellIndex === null) return "NO_CAPACITY";
		const cellIndex: number = rawCellIndex;
		records[cellIndex] = {
			operationPromise: null,
			dispatchThenPromise: null,
			replyPromise: null,
			replyThenPromise: null,
			replyBytes: null,
		};

		const copyResult: SandboxStrictByteCopyResult = copySandboxStrictBytes(bundle.payload, MAX_REQUEST_BYTES);
		if (!copyResult.ok) {
			for (let i: number = 0; i < bundle.payload.length; i++) bundle.payload[i] = 0;
			retainedReply(cellIndex, bundle.reply, new Uint8Array(0), null);
			return "INVALID";
		}
		const requestBytes: Uint8Array = copyResult.value;
		for (let i: number = 0; i < bundle.payload.length; i++) bundle.payload[i] = 0;

		const generationAtDispatch: number = generation;

		const decodeResult: V16DecodeCorrelated = decodeRequest(requestBytes);
		if (!decodeResult.ok) {
			for (let i: number = 0; i < requestBytes.length; i++) requestBytes[i] = 0;
			retainedReply(cellIndex, bundle.reply, new Uint8Array(0), null);
			return "INVALID";
		}
		const method: string = decodeResult.request.method;

		const validStream2: boolean =
			method === "list_agents" ||
			method === "roster" ||
			method === "await_pending" ||
			method === "assert_name" ||
			method === "set_name" ||
			method === "send_message";
		const validStream3: boolean =
			method === "observe_list" || method === "observe_get" || method === "observe_recent";
		if (!((bundle.stream === 2 && validStream2) || (bundle.stream === 3 && validStream3))) {
			for (let i: number = 0; i < requestBytes.length; i++) requestBytes[i] = 0;
			retainedReply(cellIndex, bundle.reply, new Uint8Array(0), null);
			return "INVALID";
		}

		for (let i: number = 0; i < requestBytes.length; i++) requestBytes[i] = 0;

		if (checkAborted(bundle.signal)) {
			const idx: number = cellIndex;
			function freeCell(): void {
				if (records[idx] !== null) records[idx] = null;
			}
			_queueMicrotask(freeCell);
			return "HANDLED";
		}

		const operationPromise: Promise<unknown> = invokeCaptured(method, decodeResult.request.body, bundle.signal);
		records[cellIndex].operationPromise = operationPromise;

		const settled: (rawOutput: unknown) => void = makeDispatchSettled(
			cellIndex,
			method,
			bundle.signal,
			generationAtDispatch,
			bundle.reply,
		);
		const rejected: () => void = makeDispatchRejected(
			cellIndex,
			method,
			bundle.signal,
			generationAtDispatch,
			bundle.reply,
		);
		const dispatchThenPromise: Promise<unknown> = _ReflectApply(_promiseThen, operationPromise, [settled, rejected]);
		records[cellIndex].dispatchThenPromise = dispatchThenPromise;

		return "HANDLED";
	}

	function closeHandler(): void {
		if (closed) return;
		closed = true;
		generation += 1;
	}

	const dispatcher: HostedControllerDispatcher = _freeze({
		route: route,
		close: closeHandler,
	});
	const result: CreateHostedControllerDispatcherSuccess = _freeze({ ok: true, value: dispatcher });
	return result;
}

export type {
	CreateHostedControllerAdapterFailure,
	CreateHostedControllerAdapterResult,
	CreateHostedControllerAdapterSuccess,
	CreateHostedControllerDispatcherFailure,
	CreateHostedControllerDispatcherResult,
	CreateHostedControllerDispatcherSuccess,
	HostedControllerDispatcher,
	PrimeSandboxHostedControllerAdapter,
	RouteResult,
};
export { createPrimeSandboxHostedControllerAdapter, createPrimeSandboxHostedControllerDispatcher };
