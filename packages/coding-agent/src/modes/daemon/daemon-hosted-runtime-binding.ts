import { types } from "node:util";
import type {
	CreateHostedRlmSubagentRuntimeOptions,
	HostedRlmAllocationSettlement,
	SubagentRuntimeHost,
} from "../../core/rlm-runtime.js";

export interface DaemonHostedRuntimeActivation {
	readonly createHostedRlmSubagentRuntime: (
		parentRuntime: unknown,
		options: CreateHostedRlmSubagentRuntimeOptions,
		settle: HostedRlmAllocationSettlement,
	) => void;
	readonly releaseHostedRlmSubagentRuntime: (
		parentRuntime: unknown,
		runtime: unknown,
		options: CreateHostedRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	readonly deleteHostedRlmSubagentRuntime: (
		parentRuntime: unknown,
		childId: string,
		runtime?: unknown,
	) => Promise<void>;
	readonly disposeHostedRlmSubagentRuntimes: (parentRuntime: unknown) => Promise<void>;
}

type CreateHostedRuntime = DaemonHostedRuntimeActivation["createHostedRlmSubagentRuntime"];
type ReleaseHostedRuntime = DaemonHostedRuntimeActivation["releaseHostedRlmSubagentRuntime"];
type DeleteHostedRuntime = DaemonHostedRuntimeActivation["deleteHostedRlmSubagentRuntime"];

interface CapturedActivation {
	readonly receiver: DaemonHostedRuntimeActivation;
	readonly createHosted: CreateHostedRuntime;
	readonly releaseHosted: ReleaseHostedRuntime;
	readonly deleteHosted: DeleteHostedRuntime;
	readonly disposeHosted: (parentRuntime: unknown) => Promise<void>;
}

const _Promise: PromiseConstructor = Promise;
const _apply: typeof Reflect.apply = Reflect.apply;
const _freeze: typeof Object.freeze = Object.freeze;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _getOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _isFrozen: typeof Object.isFrozen = Object.isFrozen;
const _isProxy: (value: unknown) => boolean = types.isProxy;
const _isPromise: (value: unknown) => boolean = types.isPromise;
const _objectPrototype: object = Object.prototype;
const _invalidDisposalResult = _freeze(new Error("Hosted runtime disposal did not return a Promise"));
const _activationKeys: readonly string[] = _freeze([
	"createHostedRlmSubagentRuntime",
	"releaseHostedRlmSubagentRuntime",
	"deleteHostedRlmSubagentRuntime",
	"disposeHostedRlmSubagentRuntimes",
]);

function isCreateHosted(value: unknown): value is CreateHostedRuntime {
	return typeof value === "function" && !_isProxy(value);
}

function isReleaseHosted(value: unknown): value is ReleaseHostedRuntime {
	return typeof value === "function" && !_isProxy(value);
}

function isDeleteHosted(value: unknown): value is DeleteHostedRuntime {
	return typeof value === "function" && !_isProxy(value);
}

function isDisposeHosted(value: unknown): value is (parentRuntime: unknown) => Promise<void> {
	return typeof value === "function" && !_isProxy(value);
}

function captureActivation(raw: DaemonHostedRuntimeActivation): CapturedActivation | null {
	try {
		if (
			_isProxy(raw) ||
			_getPrototypeOf(raw) !== _objectPrototype ||
			!_isFrozen(raw) ||
			_getOwnPropertySymbols(raw).length !== 0
		) {
			return null;
		}
		const descriptors = _getOwnPropertyDescriptors(raw);
		const names = _getOwnPropertyNames(descriptors);
		if (names.length !== _activationKeys.length) return null;
		for (let index = 0; index < names.length; index++) {
			if (names[index] !== _activationKeys[index]) return null;
		}
		const createDescriptor = descriptors.createHostedRlmSubagentRuntime;
		const releaseDescriptor = descriptors.releaseHostedRlmSubagentRuntime;
		const deleteDescriptor = descriptors.deleteHostedRlmSubagentRuntime;
		const disposeDescriptor = descriptors.disposeHostedRlmSubagentRuntimes;
		if (
			createDescriptor === undefined ||
			releaseDescriptor === undefined ||
			deleteDescriptor === undefined ||
			disposeDescriptor === undefined ||
			!("value" in createDescriptor) ||
			!("value" in releaseDescriptor) ||
			!("value" in deleteDescriptor) ||
			!("value" in disposeDescriptor) ||
			createDescriptor.enumerable !== true ||
			releaseDescriptor.enumerable !== true ||
			deleteDescriptor.enumerable !== true ||
			disposeDescriptor.enumerable !== true ||
			!isCreateHosted(createDescriptor.value) ||
			!isReleaseHosted(releaseDescriptor.value) ||
			!isDeleteHosted(deleteDescriptor.value) ||
			!isDisposeHosted(disposeDescriptor.value)
		) {
			return null;
		}
		return _freeze({
			receiver: raw,
			createHosted: createDescriptor.value,
			releaseHosted: releaseDescriptor.value,
			deleteHosted: deleteDescriptor.value,
			disposeHosted: disposeDescriptor.value,
		});
	} catch {
		return null;
	}
}

function isHostedDisposalPromise(raw: unknown): raw is Promise<void> {
	return typeof raw === "object" && raw !== null && !_isProxy(raw) && _isPromise(raw);
}

function rejected(reason: unknown): Promise<never> {
	return new _Promise<never>((_resolve, reject): void => reject(reason));
}

export function bindDaemonHostedRuntime(
	host: SubagentRuntimeHost,
	activation: DaemonHostedRuntimeActivation | undefined,
	parentRuntime: unknown,
): SubagentRuntimeHost {
	if (activation === undefined) return host;
	const captured = captureActivation(activation);
	if (captured === null) return host;
	const activationReceiver = captured.receiver;
	const createHosted = captured.createHosted;
	const releaseHosted = captured.releaseHosted;
	const deleteHosted = captured.deleteHosted;
	const disposeHosted = captured.disposeHosted;
	const disposeLocal = host.disposeRlmSubagentRuntimes;
	let disposePromise: Promise<void> | null = null;

	host.createHostedRlmSubagentRuntime = (options, settle): void => {
		_apply(createHosted, activationReceiver, [parentRuntime, options, settle]);
	};
	host.releaseHostedRlmSubagentRuntime = (runtime, options, status): Promise<void> =>
		_apply(releaseHosted, activationReceiver, [parentRuntime, runtime, options, status]);
	host.deleteHostedRlmSubagentRuntime = (childId, runtime): Promise<void> =>
		_apply(deleteHosted, activationReceiver, [parentRuntime, childId, runtime]);

	async function disposeAll(): Promise<void> {
		let failed = false;
		let firstError: unknown;
		if (disposeLocal !== undefined) {
			try {
				await _apply(disposeLocal, host, []);
			} catch (error) {
				failed = true;
				firstError = error;
			}
		}
		let hostedDisposal: unknown;
		try {
			hostedDisposal = _apply(disposeHosted, activationReceiver, [parentRuntime]);
		} catch (error) {
			if (!failed) firstError = error;
			failed = true;
		}
		if (!isHostedDisposalPromise(hostedDisposal)) {
			if (!failed) firstError = _invalidDisposalResult;
			failed = true;
		} else {
			try {
				await hostedDisposal;
			} catch (error) {
				if (!failed) firstError = error;
				failed = true;
			}
		}
		if (failed) await rejected(firstError);
	}

	host.disposeRlmSubagentRuntimes = (): Promise<void> => {
		if (disposePromise !== null) return disposePromise;
		disposePromise = disposeAll();
		return disposePromise;
	};
	return host;
}
