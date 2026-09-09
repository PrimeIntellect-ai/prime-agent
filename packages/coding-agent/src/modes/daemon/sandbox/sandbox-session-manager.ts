import { types } from "node:util";
import {
	bindPrimeSandboxProviderWithCredential,
	closePrimeCliAuthority,
	closePrimeCliCredentialAuthority,
	createPrimeCliCredentialAuthority,
	createPrimeCliRunCommand,
	MANAGED_PRIME_CLI_LIFECYCLE_EXECUTABLE,
	type PrimeCliAuthority,
	type PrimeCliCredentialAuthority,
	provisionPrimeCliV1,
} from "./prime-cli-provisioner.js";
import {
	closeSandboxHomeRuntimeConnection,
	connectAndActivateSandboxRuntime,
	proxyNextSandboxInference,
	type SandboxHomeRuntimeConnection,
	type SandboxInferenceProxyResult,
} from "./prime-sandbox-home-connection.js";
import { isSandboxInferenceModel, type SandboxInferencePort } from "./prime-sandbox-inference.js";
import { createSandboxLifecycle, type SandboxHandle, type SandboxLifecycleBundle } from "./prime-sandbox-lifecycle.js";
import type {
	PrimeSandboxProviderPort,
	SandboxFetchPort,
	SandboxRuntimeConnectPort,
} from "./prime-sandbox-provider.js";
import { copySandboxEd25519PublicKey } from "./prime-sandbox-transport.js";
import { isPreparedFileUpload, type PreparedFileUpload } from "./prime-sandbox-upload-body.js";
import { readAbortState as signalState } from "./prime-sandbox-validation.js";

const ISSUE = Object.freeze({});
const FIXED_IMAGE = "python:3.11.13-slim-bookworm";
const FIXED_CPU_CORES = 1;
const FIXED_MEMORY_GB = 1;
const FIXED_DISK_GB = 10;
const FIXED_TIMEOUT_MINUTES = 60;
const FIXED_OPERATION_TIMEOUT_MS = 600_000;
const FIXED_POLL_INTERVAL_MS = 1_000;
const MAX_BINDING_BYTES = 512;

export type PrimeSandboxSessionManagerCode =
	| "INPUT_INVALID"
	| "SETUP_FAILED"
	| "START_FAILED"
	| "ABORTED"
	| "ALREADY_STARTED"
	| "NOT_ACTIVE"
	| "INFERENCE_ALREADY_CLAIMED"
	| "BUSY"
	| "CLEANUP_UNCERTAIN";

export type PrimeSandboxSessionManagerFailure = Readonly<{
	ok: false;
	code: PrimeSandboxSessionManagerCode;
}>;

export type PrimeSandboxSessionManagerResult<T> = Readonly<{ ok: true; value: T }> | PrimeSandboxSessionManagerFailure;

export type PrimeSandboxSessionArtifacts = Readonly<{
	release: PreparedFileUpload;
	manifest: PreparedFileUpload;
	bootstrap: PreparedFileUpload;
	trust: PreparedFileUpload;
}>;

export type PrimeSandboxInternalBinding = Readonly<{
	label: string;
	name: string;
}>;

interface SessionManagerState {
	readonly lifecycleBundle: SandboxLifecycleBundle;
	readonly credential: PrimeCliCredentialAuthority;
	readonly cliAuthority: PrimeCliAuthority | undefined;
	readonly ownsAuthorities: boolean;
	credentialClosed: boolean;
	cliClosed: boolean;
	readonly dispatch: SandboxFetchPort | undefined;
	readonly connectRuntime: SandboxRuntimeConnectPort | undefined;
	phase: "idle" | "starting" | "active" | "cleaning" | "closed";
	effectPossible: boolean;
	handle: SandboxHandle | undefined;
	provider: PrimeSandboxProviderPort | undefined;
	connection: SandboxHomeRuntimeConnection | undefined;
	artifacts: PrimeSandboxSessionArtifacts | undefined;
	connectionClosed: boolean;
	exposureAbsent: boolean;
	providerClosed: boolean;
	sandboxAbsent: boolean;
	inferenceClaimed: boolean;
	proxyBusy: boolean;
	checkpointCompleted: boolean;
}

interface SessionState {
	readonly manager: PrimeSandboxSessionManager;
}

export class PrimeSandboxSession {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

export class PrimeSandboxSessionManager {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

Object.freeze(PrimeSandboxSession.prototype);
Object.freeze(PrimeSandboxSession);
Object.freeze(PrimeSandboxSessionManager.prototype);
Object.freeze(PrimeSandboxSessionManager);

const managers = new WeakMap<object, SessionManagerState>();
const sessions = new WeakMap<object, SessionState>();

function failure(code: PrimeSandboxSessionManagerCode): PrimeSandboxSessionManagerFailure {
	return Object.freeze({ ok: false, code });
}

function success<T>(value: T): Readonly<{ ok: true; value: T }> {
	return Object.freeze({ ok: true, value });
}

function exactOwnDataObject(value: unknown, keys: readonly string[]): value is object {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			types.isProxy(value) ||
			Object.getPrototypeOf(value) !== Object.prototype ||
			Object.getOwnPropertySymbols(value).length !== 0
		) {
			return false;
		}
		const actual = Object.keys(value);
		if (actual.length !== keys.length) return false;
		for (const key of actual) {
			if (!keys.includes(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !("value" in descriptor)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function ownValue(value: object, key: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function printable(value: unknown, maximum: number): value is string {
	if (typeof value !== "string" || value.length < 1) return false;
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
		if (unit <= 0x7f) bytes += 1;
		else if (unit <= 0x7ff) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			bytes += 4;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
		else bytes += 3;
		if (bytes > maximum) return false;
	}
	return true;
}

function copyBinding(value: unknown): PrimeSandboxInternalBinding | undefined {
	if (!exactOwnDataObject(value, ["label", "name"])) return undefined;
	const label = ownValue(value, "label");
	const name = ownValue(value, "name");
	if (!printable(label, MAX_BINDING_BYTES) || !printable(name, MAX_BINDING_BYTES)) return undefined;
	return Object.freeze({ label, name });
}

function copyArtifacts(value: unknown): PrimeSandboxSessionArtifacts | undefined {
	if (!exactOwnDataObject(value, ["release", "manifest", "bootstrap", "trust"])) return undefined;
	const release = ownValue(value, "release");
	const manifest = ownValue(value, "manifest");
	const bootstrap = ownValue(value, "bootstrap");
	const trust = ownValue(value, "trust");
	if (
		!isPreparedFileUpload(release, "release") ||
		!isPreparedFileUpload(manifest, "manifest") ||
		!isPreparedFileUpload(bootstrap, "bootstrap") ||
		!isPreparedFileUpload(trust, "trust")
	) {
		return undefined;
	}
	return Object.freeze({ release, manifest, bootstrap, trust });
}

async function closeArtifacts(state: SessionManagerState): Promise<boolean> {
	const artifacts = state.artifacts;
	if (artifacts === undefined) return true;
	let certain = true;
	for (const source of [artifacts.release, artifacts.manifest, artifacts.bootstrap, artifacts.trust]) {
		try {
			const closed = await source.close();
			if (!closed.ok) certain = false;
		} catch {
			certain = false;
		}
	}
	if (certain) state.artifacts = undefined;
	return certain;
}

function closeOwnedAuthorities(state: SessionManagerState): boolean {
	if (!state.ownsAuthorities) return true;
	if (!state.credentialClosed) state.credentialClosed = closePrimeCliCredentialAuthority(state.credential);
	if (!state.cliClosed) {
		state.cliClosed = state.cliAuthority !== undefined && closePrimeCliAuthority(state.cliAuthority);
	}
	return state.credentialClosed && state.cliClosed;
}

async function proveSandboxAbsent(state: SessionManagerState): Promise<boolean> {
	if (state.sandboxAbsent) return true;
	let handle = state.handle;
	if (handle === undefined) {
		let inspected: Awaited<ReturnType<SandboxLifecycleBundle["lifecycle"]["inspect"]>>;
		try {
			inspected = await state.lifecycleBundle.lifecycle.inspect();
		} catch {
			return false;
		}
		if (!inspected.ok) return false;
		if (inspected.kind === "empty") {
			const consumed = state.lifecycleBundle.proofConsumer.consumeProof(inspected.value.absenceProof);
			if (!consumed.ok) return false;
			state.sandboxAbsent = true;
			return true;
		}
		handle = inspected.value;
		state.handle = handle;
	}
	let deleted: Awaited<ReturnType<SandboxLifecycleBundle["lifecycle"]["deleteAndProveAbsent"]>>;
	try {
		deleted = await state.lifecycleBundle.lifecycle.deleteAndProveAbsent(handle);
	} catch {
		state.handle = undefined;
		return false;
	}
	if (deleted.ok) {
		const consumed = state.lifecycleBundle.proofConsumer.consumeProof(deleted.value);
		if (!consumed.ok) return false;
		state.sandboxAbsent = true;
		return true;
	}
	state.handle = undefined;
	let recovery: Awaited<ReturnType<SandboxLifecycleBundle["lifecycle"]["inspect"]>>;
	try {
		recovery = await state.lifecycleBundle.lifecycle.inspect();
	} catch {
		return false;
	}
	if (!recovery.ok) return false;
	if (recovery.kind === "empty") {
		const consumed = state.lifecycleBundle.proofConsumer.consumeProof(recovery.value.absenceProof);
		if (!consumed.ok) return false;
		state.sandboxAbsent = true;
		return true;
	}
	state.handle = recovery.value;
	return false;
}

async function cleanupState(state: SessionManagerState): Promise<boolean> {
	state.phase = "cleaning";
	let artifactsClosed = await closeArtifacts(state);
	if (!state.connectionClosed) {
		const connection = state.connection;
		if (connection === undefined) state.connectionClosed = true;
		else {
			try {
				const closed = await closeSandboxHomeRuntimeConnection(connection);
				if (closed.ok) {
					state.connectionClosed = true;
					state.connection = undefined;
				}
			} catch {
				// Retry retains the connection authority.
			}
		}
	}
	if (!state.connectionClosed) return false;
	const provider = state.provider;
	if (!state.exposureAbsent) {
		if (provider === undefined) state.exposureAbsent = true;
		else {
			try {
				const absent = await provider.unexposeAndProveAbsent();
				if (absent.ok) state.exposureAbsent = true;
			} catch {
				// Retry retains provider authority.
			}
		}
	}
	if (!state.exposureAbsent) return false;
	if (!state.providerClosed) {
		if (provider === undefined) state.providerClosed = true;
		else {
			try {
				const closed = await provider.close();
				if (closed.ok) {
					state.providerClosed = true;
					state.provider = undefined;
				}
			} catch {
				// Retry retains provider authority.
			}
		}
	}
	if (!state.providerClosed) return false;
	if (state.effectPossible && !(await proveSandboxAbsent(state))) return false;
	state.sandboxAbsent = true;
	if (!artifactsClosed) artifactsClosed = await closeArtifacts(state);
	if (!artifactsClosed) return false;
	if (!closeOwnedAuthorities(state)) return false;
	state.handle = undefined;
	state.phase = "closed";
	return true;
}

function createManagerState(
	lifecycleBundle: SandboxLifecycleBundle,
	credential: PrimeCliCredentialAuthority,
	cliAuthority: PrimeCliAuthority | undefined,
	ownsAuthorities: boolean,
	dispatch?: SandboxFetchPort,
	connectRuntime?: SandboxRuntimeConnectPort,
): PrimeSandboxSessionManager {
	const manager = new PrimeSandboxSessionManager(ISSUE);
	managers.set(manager, {
		lifecycleBundle,
		credential,
		cliAuthority,
		ownsAuthorities,
		credentialClosed: !ownsAuthorities,
		cliClosed: !ownsAuthorities,
		dispatch,
		connectRuntime,
		phase: "idle",
		effectPossible: false,
		handle: undefined,
		provider: undefined,
		connection: undefined,
		artifacts: undefined,
		connectionClosed: false,
		exposureAbsent: false,
		providerClosed: false,
		sandboxAbsent: false,
		inferenceClaimed: false,
		proxyBusy: false,
		checkpointCompleted: false,
	});
	return manager;
}

export function createPrimeSandboxSessionManagerForTesting(
	lifecycleBundle: SandboxLifecycleBundle,
	credential: PrimeCliCredentialAuthority,
	dispatch: SandboxFetchPort,
	connectRuntime: SandboxRuntimeConnectPort,
): PrimeSandboxSessionManager {
	return createManagerState(lifecycleBundle, credential, undefined, false, dispatch, connectRuntime);
}

export async function createManagedPrimeSandboxSessionManager(
	agentHome: unknown,
	basePython: unknown,
	apiKeyBytes: unknown,
	bindingValue: unknown,
	signal?: AbortSignal,
): Promise<PrimeSandboxSessionManagerResult<PrimeSandboxSessionManager>> {
	const initialSignal = signalState(signal);
	const binding = copyBinding(bindingValue);
	if (initialSignal === undefined || binding === undefined) return failure("INPUT_INVALID");
	if (initialSignal) return failure("ABORTED");
	const credentialResult = createPrimeCliCredentialAuthority(apiKeyBytes);
	if (!credentialResult.ok) return failure("INPUT_INVALID");
	const credential = credentialResult.value;
	let provisioned: Awaited<ReturnType<typeof provisionPrimeCliV1>>;
	try {
		provisioned = await provisionPrimeCliV1(agentHome, basePython, signal);
	} catch {
		closePrimeCliCredentialAuthority(credential);
		return failure("SETUP_FAILED");
	}
	if (!provisioned.ok) {
		closePrimeCliCredentialAuthority(credential);
		return failure(provisioned.code === "ABORTED" ? "ABORTED" : "SETUP_FAILED");
	}
	const cliAuthority = provisioned.value;
	if (signalState(signal)) {
		closePrimeCliCredentialAuthority(credential);
		closePrimeCliAuthority(cliAuthority);
		return failure("ABORTED");
	}
	const run = createPrimeCliRunCommand(cliAuthority, credential);
	if (run === undefined) {
		closePrimeCliCredentialAuthority(credential);
		closePrimeCliAuthority(cliAuthority);
		return failure("SETUP_FAILED");
	}
	let lifecycle: Awaited<ReturnType<typeof createSandboxLifecycle>>;
	try {
		lifecycle = await createSandboxLifecycle(
			run,
			Object.freeze({
				primeCliPath: MANAGED_PRIME_CLI_LIFECYCLE_EXECUTABLE,
				label: binding.label,
				image: FIXED_IMAGE,
				name: binding.name,
				cpuCores: FIXED_CPU_CORES,
				memoryGb: FIXED_MEMORY_GB,
				diskSizeGb: FIXED_DISK_GB,
				sandboxTimeoutMinutes: FIXED_TIMEOUT_MINUTES,
				operationTimeoutMs: FIXED_OPERATION_TIMEOUT_MS,
				pollIntervalMs: FIXED_POLL_INTERVAL_MS,
			}),
		);
	} catch {
		closePrimeCliCredentialAuthority(credential);
		closePrimeCliAuthority(cliAuthority);
		return failure("SETUP_FAILED");
	}
	if (!lifecycle.ok) {
		closePrimeCliCredentialAuthority(credential);
		closePrimeCliAuthority(cliAuthority);
		return failure("SETUP_FAILED");
	}
	if (signalState(signal)) {
		closePrimeCliCredentialAuthority(credential);
		closePrimeCliAuthority(cliAuthority);
		return failure("ABORTED");
	}
	return success(createManagerState(lifecycle.value, credential, cliAuthority, true));
}

async function failStart(
	state: SessionManagerState,
	code: "ABORTED" | "START_FAILED",
	signal?: AbortSignal,
): Promise<PrimeSandboxSessionManagerFailure> {
	const effectiveCode = signalState(signal) ? "ABORTED" : code;
	const cleaned = await cleanupState(state);
	return cleaned ? failure(effectiveCode) : failure("CLEANUP_UNCERTAIN");
}

export async function startPrimeSandboxSession(
	managerValue: unknown,
	artifactsValue: unknown,
	homeIdentity: unknown,
	allowedModel: unknown,
	signal?: AbortSignal,
): Promise<PrimeSandboxSessionManagerResult<PrimeSandboxSession>> {
	if (typeof managerValue !== "object" || managerValue === null) return failure("INPUT_INVALID");
	const state = managers.get(managerValue);
	const artifacts = copyArtifacts(artifactsValue);
	const initialSignal = signalState(signal);
	if (
		state === undefined ||
		artifacts === undefined ||
		!isSandboxInferenceModel(allowedModel) ||
		initialSignal === undefined
	) {
		return failure("INPUT_INVALID");
	}
	const publicKey = copySandboxEd25519PublicKey(homeIdentity);
	if (publicKey === undefined) return failure("INPUT_INVALID");
	publicKey.fill(0);
	if (initialSignal) return failure("ABORTED");
	if (state.phase !== "idle") return failure("ALREADY_STARTED");
	state.phase = "starting";
	state.artifacts = artifacts;
	let inspected: Awaited<ReturnType<SandboxLifecycleBundle["lifecycle"]["inspect"]>>;
	try {
		inspected = await state.lifecycleBundle.lifecycle.inspect(signal);
	} catch {
		return await failStart(state, "START_FAILED", signal);
	}
	if (!inspected.ok) return await failStart(state, inspected.code === "ABORTED" ? "ABORTED" : "START_FAILED", signal);
	if (inspected.kind === "empty") {
		state.effectPossible = true;
		let created: Awaited<ReturnType<SandboxLifecycleBundle["lifecycle"]["create"]>>;
		try {
			created = await state.lifecycleBundle.lifecycle.create(inspected.value.createPermission, signal);
		} catch {
			return await failStart(state, "START_FAILED", signal);
		}
		if (!created.ok) return await failStart(state, created.code === "ABORTED" ? "ABORTED" : "START_FAILED", signal);
		state.handle = created.value;
	} else {
		state.effectPossible = true;
		state.handle = inspected.value;
	}
	const handle = state.handle;
	if (handle === undefined) return await failStart(state, "START_FAILED", signal);
	let ready: Awaited<ReturnType<SandboxLifecycleBundle["lifecycle"]["waitUntilReady"]>>;
	try {
		ready = await state.lifecycleBundle.lifecycle.waitUntilReady(handle, signal);
	} catch {
		return await failStart(state, "START_FAILED", signal);
	}
	if (!ready.ok) return await failStart(state, ready.code === "ABORTED" ? "ABORTED" : "START_FAILED", signal);
	const bound = bindPrimeSandboxProviderWithCredential(
		state.lifecycleBundle.providerBinder,
		handle,
		state.credential,
		state.dispatch,
		state.connectRuntime,
	);
	if (!bound.ok) return await failStart(state, "START_FAILED", signal);
	const provider = bound.value;
	state.provider = provider;
	const uploads = [
		() => provider.uploadRelease(artifacts.release, signal),
		() => provider.uploadManifest(artifacts.manifest, signal),
		() => provider.uploadBootstrap(artifacts.bootstrap, signal),
		() => provider.uploadTrust(artifacts.trust, signal),
	];
	for (const upload of uploads) {
		let uploaded: Awaited<ReturnType<typeof upload>>;
		try {
			uploaded = await upload();
		} catch {
			return await failStart(state, "START_FAILED", signal);
		}
		if (!uploaded.ok) return await failStart(state, uploaded.code === "ABORTED" ? "ABORTED" : "START_FAILED", signal);
	}
	if (!(await closeArtifacts(state))) return await failStart(state, "START_FAILED", signal);
	let launched: Awaited<ReturnType<PrimeSandboxProviderPort["bootstrapAndLaunch"]>>;
	try {
		launched = await provider.bootstrapAndLaunch(signal);
	} catch {
		return await failStart(state, "START_FAILED", signal);
	}
	if (!launched.ok) return await failStart(state, launched.code === "ABORTED" ? "ABORTED" : "START_FAILED", signal);
	let exposed: Awaited<ReturnType<PrimeSandboxProviderPort["exposeRuntime"]>>;
	try {
		exposed = await provider.exposeRuntime(signal);
	} catch {
		return await failStart(state, "START_FAILED", signal);
	}
	if (!exposed.ok) return await failStart(state, exposed.code === "ABORTED" ? "ABORTED" : "START_FAILED", signal);
	const connected = await connectAndActivateSandboxRuntime(
		provider,
		homeIdentity,
		launched.value,
		allowedModel,
		signal,
	);
	if (!connected.ok) return await failStart(state, connected.code === "ABORTED" ? "ABORTED" : "START_FAILED", signal);
	state.connection = connected.value;
	state.phase = "active";
	const session = new PrimeSandboxSession(ISSUE);
	sessions.set(session, Object.freeze({ manager: managerValue }));
	return success(session);
}

export async function proxyPrimeSandboxSessionInference(
	managerValue: unknown,
	sessionValue: unknown,
	inferencePort: SandboxInferencePort,
	signal?: AbortSignal,
): Promise<SandboxInferenceProxyResult | PrimeSandboxSessionManagerFailure> {
	if (
		typeof managerValue !== "object" ||
		managerValue === null ||
		typeof sessionValue !== "object" ||
		sessionValue === null
	) {
		return failure("INPUT_INVALID");
	}
	const state = managers.get(managerValue);
	const session = sessions.get(sessionValue);
	const initialSignal = signalState(signal);
	if (
		state === undefined ||
		session === undefined ||
		session.manager !== managerValue ||
		typeof inferencePort !== "function" ||
		initialSignal === undefined
	) {
		return failure("INPUT_INVALID");
	}
	if (initialSignal) return failure("ABORTED");
	if (state.phase !== "active" || state.connection === undefined) return failure("NOT_ACTIVE");
	if (state.proxyBusy) return failure("BUSY");
	if (state.inferenceClaimed) return failure("INFERENCE_ALREADY_CLAIMED");
	state.inferenceClaimed = true;
	state.proxyBusy = true;
	try {
		return await proxyNextSandboxInference(state.connection, inferencePort, signal);
	} finally {
		state.proxyBusy = false;
	}
}

export async function deletePrimeSandboxSession(
	managerValue: unknown,
	sessionValue: unknown,
): Promise<PrimeSandboxSessionManagerResult<true>> {
	if (
		typeof managerValue !== "object" ||
		managerValue === null ||
		typeof sessionValue !== "object" ||
		sessionValue === null
	) {
		return failure("INPUT_INVALID");
	}
	const state = managers.get(managerValue);
	const session = sessions.get(sessionValue);
	if (state === undefined || session === undefined || session.manager !== managerValue)
		return failure("INPUT_INVALID");
	if (state.proxyBusy) return failure("BUSY");
	if (state.phase !== "active" && state.phase !== "cleaning") return failure("NOT_ACTIVE");
	// PR A has no mutable remote workspace yet. Record its no-op checkpoint
	// before runtime shutdown; PR C replaces this boundary with PAWS commit.
	if (state.phase === "active") state.checkpointCompleted = true;
	if (!state.checkpointCompleted) return failure("CLEANUP_UNCERTAIN");
	const cleaned = await cleanupState(state);
	if (!cleaned) return failure("CLEANUP_UNCERTAIN");
	sessions.delete(sessionValue);
	return success(true);
}

export async function retryPrimeSandboxSessionCleanup(
	managerValue: unknown,
): Promise<PrimeSandboxSessionManagerResult<true>> {
	if (typeof managerValue !== "object" || managerValue === null) return failure("INPUT_INVALID");
	const state = managers.get(managerValue);
	if (state === undefined) return failure("INPUT_INVALID");
	if (state.proxyBusy || state.phase === "starting") return failure("BUSY");
	if (state.phase === "closed") return success(true);
	if (state.phase === "active") return failure("NOT_ACTIVE");
	const cleaned = await cleanupState(state);
	return cleaned ? success(true) : failure("CLEANUP_UNCERTAIN");
}
