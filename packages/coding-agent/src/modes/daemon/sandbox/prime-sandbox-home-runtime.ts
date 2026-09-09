import { types } from "node:util";
import type {
	HostedRlmRuntimeIdentity,
	HostedRlmRuntimePort,
	HostedRlmRuntimePortFactoryResult,
} from "../../../core/hosted-rlm-runtime-port.js";
import { createHomeStreamRouter } from "./prime-sandbox-home-stream-router.js";
import { createHostedSandboxChildPort } from "./prime-sandbox-hosted-child-port.js";
import { createModelStreamProviderManager } from "./prime-sandbox-model-provider-manager.js";
import { createHomeMultiplexer, type HomeMultiplexer } from "./prime-sandbox-v31-multiplexer.js";

export interface PrimeSandboxHomeRuntimeChildInput {
	readonly identity: unknown;
	readonly controllerDispatcher: unknown;
}

export interface PrimeSandboxHomeRuntime {
	readonly createChild: (input: PrimeSandboxHomeRuntimeChildInput) => HostedRlmRuntimePortFactoryResult;
	readonly close: () => Promise<Readonly<{ code: "CLOSED" | "CLEANUP_UNCERTAIN" }>>;
}

export type PrimeSandboxHomeRuntimeResult =
	| Readonly<{ ok: true; value: PrimeSandboxHomeRuntime }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" | "TRANSPORT_FAILED" }>;

const _freeze: typeof Object.freeze = Object.freeze;
const _Promise: PromiseConstructor = Promise;
const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _getOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _isFrozen: typeof Object.isFrozen = Object.isFrozen;
const _isProxy: (value: unknown) => boolean = types.isProxy;
const _arrayPush: typeof Array.prototype.push = Array.prototype.push;
const _apply: typeof Reflect.apply = Reflect.apply;
const _objectPrototype: object = Object.prototype;
const _inputKeys: readonly string[] = _freeze(["physicalPort", "modelProvider"]);
const _childKeys: readonly string[] = _freeze(["identity", "controllerDispatcher"]);
const _identityKeys: readonly string[] = _freeze(["childId", "sessionId", "sessionName", "modelSelector"]);
const _modelKeys: readonly string[] = _freeze(["provide"]);
const _maxChildren = 32;
const _identityPattern = /^[a-zA-Z0-9_./:-]{1,128}$/;
const _regexpTest: typeof RegExp.prototype.test = RegExp.prototype.test;
const _closed: Readonly<{ code: "CLOSED" }> = _freeze({ code: "CLOSED" });
const _uncertain: Readonly<{ code: "CLEANUP_UNCERTAIN" }> = _freeze({ code: "CLEANUP_UNCERTAIN" });
const _inputInvalid: Readonly<{ ok: false; code: "INPUT_INVALID" }> = _freeze({ ok: false, code: "INPUT_INVALID" });
const _childInvalid: Readonly<{ ok: false; code: "INVALID_INPUT" }> = _freeze({ ok: false, code: "INVALID_INPUT" });

interface ExactValues {
	readonly values: { readonly [key: string]: unknown };
}

function exactValues(raw: unknown, keys: readonly string[]): ExactValues | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (_isProxy(raw) || _getPrototypeOf(raw) !== _objectPrototype || _getOwnPropertySymbols(raw).length !== 0) {
			return null;
		}
		const descriptors = _getOwnPropertyDescriptors(raw);
		const names = _getOwnPropertyNames(descriptors);
		if (names.length !== keys.length) return null;
		const values: { [key: string]: unknown } = {};
		for (let index = 0; index < names.length; index++) {
			const name = names[index];
			if (keys[index] !== name) return null;
			const descriptor = descriptors[name];
			if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return null;
			values[name] = descriptor.value;
		}
		return { values };
	} catch {
		return null;
	}
}

function boundedIdentityValue(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) return false;
	return _apply(_regexpTest, _identityPattern, [raw]) === true;
}

function copyIdentity(raw: unknown): HostedRlmRuntimeIdentity | null {
	const captured = exactValues(raw, _identityKeys);
	if (captured === null) return null;
	const childId = captured.values.childId;
	const sessionId = captured.values.sessionId;
	const sessionName = captured.values.sessionName;
	const modelSelector = captured.values.modelSelector;
	if (
		!boundedIdentityValue(childId) ||
		!boundedIdentityValue(sessionId) ||
		!boundedIdentityValue(sessionName) ||
		!boundedIdentityValue(modelSelector)
	) {
		return null;
	}
	return _freeze({ childId, sessionId, sessionName, modelSelector });
}

function isHomeMultiplexer(raw: ReturnType<typeof createHomeMultiplexer>): raw is HomeMultiplexer {
	return !("code" in raw);
}

interface HomeReady {
	readonly promise: Promise<HomeMultiplexer | null>;
	readonly settle: (value: HomeMultiplexer | null) => void;
}

function createHomeReady(): HomeReady {
	let settle = (_value: HomeMultiplexer | null): void => {};
	const promise = new _Promise<HomeMultiplexer | null>((resolve): void => {
		settle = resolve;
	});
	return _freeze({ promise, settle });
}

function validModelProvider(raw: unknown): boolean {
	const captured = exactValues(raw, _modelKeys);
	if (captured === null || typeof raw !== "object" || raw === null) return false;
	try {
		return _isFrozen(raw) && typeof captured.values.provide === "function" && !_isProxy(captured.values.provide);
	} catch {
		return false;
	}
}

export function createPrimeSandboxHomeRuntime(inputRaw: unknown): PrimeSandboxHomeRuntimeResult {
	const input = exactValues(inputRaw, _inputKeys);
	if (input === null || !validModelProvider(input.values.modelProvider)) return _inputInvalid;

	const homeReady = createHomeReady();
	const physicalShutdown = _freeze({
		shutdown: async (): Promise<Readonly<{ code: "SHUT_DOWN" | "FAILED" }>> => {
			const current = await homeReady.promise;
			if (current === null) return _freeze({ code: "FAILED" });
			try {
				const result = await current.close();
				return result.code === "CLEAN" ? _freeze({ code: "SHUT_DOWN" }) : _freeze({ code: "FAILED" });
			} catch {
				return _freeze({ code: "FAILED" });
			}
		},
	});
	const modelManager = createModelStreamProviderManager(input.values.modelProvider, physicalShutdown);
	const router = createHomeStreamRouter({ modelProvider: modelManager });
	const muxDispatcher = _freeze({ dispatchApplication: router.dispatchApplication });
	const homeResult = createHomeMultiplexer(input.values.physicalPort, muxDispatcher);
	if (!isHomeMultiplexer(homeResult)) {
		homeReady.settle(null);
		router.close();
		return _freeze({ ok: false, code: "TRANSPORT_FAILED" });
	}
	const homeMux = homeResult;
	homeReady.settle(homeMux);

	const children: HostedRlmRuntimePort[] = [];
	let closing = false;
	let closePromise: Promise<Readonly<{ code: "CLOSED" | "CLEANUP_UNCERTAIN" }>> | null = null;

	function createChild(inputValue: PrimeSandboxHomeRuntimeChildInput): HostedRlmRuntimePortFactoryResult {
		if (closing || children.length >= _maxChildren) return _childInvalid;
		const child = exactValues(inputValue, _childKeys);
		if (child === null) return _childInvalid;
		const identity = copyIdentity(child.values.identity);
		if (identity === null) return _childInvalid;
		const created = createHostedSandboxChildPort({
			identity,
			lifecycleOrigin: homeMux.lifecycleToRuntime,
			router,
			controllerDispatcher: child.values.controllerDispatcher,
		});
		if (created.ok) _apply(_arrayPush, children, [created.value]);
		return created;
	}

	async function closeAll(): Promise<Readonly<{ code: "CLOSED" | "CLEANUP_UNCERTAIN" }>> {
		let certain = true;
		for (let index = 0; index < children.length; index++) {
			try {
				const result = await children[index].close();
				if (!result.ok) certain = false;
			} catch {
				certain = false;
			}
		}
		children.length = 0;
		router.close();
		try {
			const modelClosed = await modelManager.shutdown();
			if (modelClosed.code !== "SHUT_DOWN") certain = false;
		} catch {
			certain = false;
		}
		try {
			const transportClosed = await homeMux.close();
			if (transportClosed.code !== "CLEAN") certain = false;
		} catch {
			certain = false;
		}
		return certain ? _closed : _uncertain;
	}

	function close(): Promise<Readonly<{ code: "CLOSED" | "CLEANUP_UNCERTAIN" }>> {
		if (closePromise !== null) return closePromise;
		closing = true;
		closePromise = closeAll();
		return closePromise;
	}

	return _freeze({ ok: true, value: _freeze({ createChild, close }) });
}
