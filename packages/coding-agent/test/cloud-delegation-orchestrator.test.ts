import { describe, expect, it } from "vitest";
import type {
	CloudCleanupState,
	CloudDesiredLifecycle,
	CloudObservedLifecycle,
	CloudResultImportState,
	CloudSessionBaseline,
	CloudSessionCreateInput,
	CloudSessionRecord,
} from "../src/core/cloud/cloud-session-store.js";
import {
	CLOUD_DELEGATION_BOOTSTRAP_SCRIPT,
	CLOUD_DELEGATION_START_COMMAND,
	CLOUD_GUEST_ARCHIVE_PATH,
	CLOUD_GUEST_AUTH_PATH,
	CLOUD_GUEST_BOOTSTRAP_PATH,
	CLOUD_GUEST_MANIFEST_PATH,
	CLOUD_GUEST_PROMPT_PATH,
	type CloudDelegationCapturedWorkspace,
	CloudDelegationError,
	type CloudDelegationErrorCode,
	CloudDelegationOrchestrator,
	type CloudDelegationOrchestratorOptions,
	type CloudDelegationPlatformClient,
	type CloudDelegationProgress,
	type CloudDelegationReadiness,
	type CloudDelegationRecordStore,
	type CloudDelegationRequest,
	type CloudDelegationResultsClient,
	type CloudDelegationSandboxSpec,
	type CloudDelegationTaskResult,
	type CloudDelegationVmProcessClient,
	type CloudDelegationVmProcessStartRequest,
	type CloudDelegationVmProcessState,
	type CloudDelegationWorkspaceTransfer,
	cloudDelegationPhaseOf,
} from "../src/core/cloud/delegation-orchestrator.js";
import {
	MAX_TRANSFER_BYTES,
	type PrimeSandbox,
	type PrimeSandboxAuth,
	type PrimeSandboxStatus,
	type PrimeSandboxUploadRequest,
	type PrimeSandboxUploadResult,
	type PrimeSandboxVmCreateRequest,
} from "../src/core/cloud/prime-sandbox-client.js";
import { CLOUD_MAX_PROMPT_CHARS } from "../src/core/cloud/protocol.js";

const GATEWAY_TOKEN = "gtw-secret-token-1234";
const CREDENTIAL = "sk-cloud-inference-secret";
const PROMPT = "fix the failing test";

function fakeSandbox(id: string, status: PrimeSandboxStatus = "RUNNING"): PrimeSandbox {
	const now = new Date().toISOString();
	return {
		id,
		name: `sbx-${id}`,
		dockerImage: "image",
		startCommand: null,
		cpuCores: 4,
		memoryGb: 8,
		diskSizeGb: 40,
		gpuCount: 0,
		gpuType: null,
		vm: true,
		networkAllowlist: null,
		networkDenylist: null,
		status,
		timeoutMinutes: 60,
		idleTimeoutMinutes: null,
		terminationReason: null,
		labels: [],
		createdAt: now,
		updatedAt: now,
		startedAt: null,
		terminatedAt: null,
		exitCode: null,
		errorType: null,
		errorMessage: null,
		userId: null,
		teamId: null,
		kubernetesJobId: null,
		region: null,
		registryCredentialsId: null,
		pendingImageBuildId: null,
	};
}

/** In-memory record store with the real store's set-once and monotonic rules. */
class FakeRecordStore implements CloudDelegationRecordStore {
	readonly records = new Map<string, CloudSessionRecord>();

	constructor(private readonly calls: string[]) {}

	create(input: CloudSessionCreateInput): CloudSessionRecord {
		this.calls.push("store.create");
		const sessionId = input.sessionId ?? `sess_${crypto.randomUUID()}`;
		if (this.records.has(sessionId)) {
			throw new Error(`cloud session already exists: ${sessionId}`);
		}
		const now = new Date().toISOString();
		const record: CloudSessionRecord = {
			version: 1,
			sessionId,
			...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
			generation: 1,
			residentProcessUuid: input.residentProcessUuid,
			desiredLifecycle: "provisioning",
			observedLifecycle: "provisioning",
			eventCursor: { generation: 1, sequence: 0 },
			ackCursor: { generation: 1, sequence: 0 },
			cleanupState: "none",
			resultImportState: "pending",
			createdAt: now,
			updatedAt: now,
		};
		this.records.set(sessionId, record);
		return structuredClone(record);
	}

	get(sessionId: string): CloudSessionRecord | undefined {
		const record = this.records.get(sessionId);
		return record === undefined ? undefined : structuredClone(record);
	}

	setCreateIdempotencyKey(sessionId: string, idempotencyKey: string): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			if (record.createIdempotencyKey !== undefined && record.createIdempotencyKey !== idempotencyKey) {
				throw new Error("create idempotency key is immutable");
			}
			record.createIdempotencyKey = idempotencyKey;
		});
	}

	setSandbox(sessionId: string, sandboxId: string, sandboxStatus?: PrimeSandboxStatus): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			if (record.sandboxId !== undefined && record.sandboxId !== sandboxId) {
				throw new Error("sandbox id is immutable");
			}
			record.sandboxId = sandboxId;
			record.sandboxStatus = sandboxStatus ?? record.sandboxStatus;
		});
	}

	setBaseline(sessionId: string, baseline: CloudSessionBaseline): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			if (record.baseline !== undefined) {
				throw new Error("baseline is immutable");
			}
			record.baseline = { ...baseline };
		});
	}

	setDeadline(sessionId: string, deadlineAt: string): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			if (record.deadlineAt !== undefined) {
				throw new Error("deadline is immutable");
			}
			record.deadlineAt = deadlineAt;
		});
	}

	setDesiredLifecycle(sessionId: string, desired: CloudDesiredLifecycle): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			record.desiredLifecycle = desired;
		});
	}

	setObservedLifecycle(sessionId: string, observed: CloudObservedLifecycle): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			record.observedLifecycle = observed;
		});
	}

	setLastError(sessionId: string, error?: string): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			record.lastError = error;
		});
	}

	setCleanupState(sessionId: string, state: CloudCleanupState): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			record.cleanupState = state;
		});
	}

	setResultImportState(sessionId: string, state: CloudResultImportState): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			record.resultImportState = state;
		});
	}

	private mutate(sessionId: string, apply: (record: CloudSessionRecord) => void): CloudSessionRecord {
		const record = this.records.get(sessionId);
		if (record === undefined) {
			throw new Error(`unknown cloud session: ${sessionId}`);
		}
		apply(record);
		record.updatedAt = new Date().toISOString();
		return structuredClone(record);
	}
}

class FakePlatform implements CloudDelegationPlatformClient {
	readonly createKeys: (string | undefined)[] = [];
	readonly uploads = new Map<string, Uint8Array>();
	readonly deleted: string[] = [];
	sandboxCount = 0;
	failCreate?: Error;
	failUpload?: Error;
	private readonly byId = new Map<string, PrimeSandbox>();
	private readonly byKey = new Map<string, PrimeSandbox>();
	private nextId = 0;

	constructor(private readonly calls: string[]) {}

	createVmSandbox(request: PrimeSandboxVmCreateRequest): Promise<PrimeSandbox> {
		this.calls.push("platform.createVmSandbox");
		this.createKeys.push(request.idempotencyKey);
		if (this.failCreate !== undefined) {
			const error = this.failCreate;
			this.failCreate = undefined;
			return Promise.reject(error);
		}
		const key = request.idempotencyKey ?? `auto-${this.nextId}`;
		const existing = this.byKey.get(key);
		if (existing !== undefined) {
			this.calls.push("platform.createVmSandbox.idempotent-reuse");
			return Promise.resolve(existing);
		}
		const sandbox = fakeSandbox(`sbx-${this.nextId++}`);
		this.sandboxCount += 1;
		this.byId.set(sandbox.id, sandbox);
		this.byKey.set(key, sandbox);
		return Promise.resolve(sandbox);
	}

	getSandbox(sandboxId: string): Promise<PrimeSandbox> {
		this.calls.push("platform.getSandbox");
		const sandbox = this.byId.get(sandboxId);
		return Promise.resolve(sandbox ?? fakeSandbox(sandboxId, "TERMINATED"));
	}

	deleteSandbox(sandboxId: string): Promise<void> {
		this.calls.push("platform.deleteSandbox");
		this.deleted.push(sandboxId);
		return Promise.resolve();
	}

	getSandboxAuth(sandboxId: string): Promise<PrimeSandboxAuth> {
		this.calls.push("platform.getSandboxAuth");
		return Promise.resolve({
			sandboxId,
			gatewayUrl: "https://gateway.example.com",
			userNamespace: "ns",
			jobId: sandboxId,
			token: GATEWAY_TOKEN,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
	}

	uploadFile(_sandboxId: string, request: PrimeSandboxUploadRequest): Promise<PrimeSandboxUploadResult> {
		this.calls.push(`platform.uploadFile ${request.path}`);
		if (this.failUpload !== undefined) {
			const error = this.failUpload;
			this.failUpload = undefined;
			return Promise.reject(error);
		}
		this.uploads.set(request.path, request.content);
		return Promise.resolve({
			success: true,
			path: request.path,
			size: request.content.byteLength,
			timestamp: new Date().toISOString(),
		});
	}
}

class FakeVmProcess implements CloudDelegationVmProcessClient {
	readonly starts: CloudDelegationVmProcessStartRequest[] = [];
	signalCount = 0;
	ignoreSignal = false;
	onSignal?: () => void;
	failStart?: Error;
	private state: CloudDelegationVmProcessState = { state: "unknown" };
	private readonly startedUuids = new Set<string>();

	constructor(private readonly calls: string[]) {}

	setState(state: CloudDelegationVmProcessState): void {
		this.state = state;
	}

	start(request: CloudDelegationVmProcessStartRequest): Promise<{ sessionUuid: string; created: boolean }> {
		this.calls.push("process.start");
		this.starts.push(request);
		if (this.failStart !== undefined) {
			const error = this.failStart;
			this.failStart = undefined;
			return Promise.reject(error);
		}
		const created = !this.startedUuids.has(request.sessionUuid);
		this.startedUuids.add(request.sessionUuid);
		if (created) {
			this.state = { state: "running" };
		}
		return Promise.resolve({ sessionUuid: request.sessionUuid, created });
	}

	signalStop(_sessionUuid: string): Promise<void> {
		this.calls.push("process.signalStop");
		this.signalCount += 1;
		if (!this.ignoreSignal) this.state = { state: "exited", exitCode: 0 };
		this.onSignal?.();
		return Promise.resolve();
	}

	status(_sessionUuid: string): Promise<CloudDelegationVmProcessState> {
		this.calls.push("process.status");
		return Promise.resolve(this.state);
	}
}

class FakeWorkspace implements CloudDelegationWorkspaceTransfer {
	captureCount = 0;
	failCapture?: Error;
	manifestDigest = `sha256:${"a".repeat(64)}`;
	totalSizeBytes = 128;

	constructor(private readonly calls: string[]) {}

	capture(request: { cwd: string }): Promise<CloudDelegationCapturedWorkspace> {
		this.calls.push("workspace.capture");
		this.captureCount += 1;
		if (this.failCapture !== undefined) {
			const error = this.failCapture;
			this.failCapture = undefined;
			return Promise.reject(error);
		}
		return Promise.resolve({
			baseline: { repoRoot: request.cwd, headCommit: null, manifestDigest: this.manifestDigest },
			archive: new TextEncoder().encode("workspace-archive-bytes"),
			manifest: new TextEncoder().encode("{}"),
			totalSizeBytes: this.totalSizeBytes,
			cleanup: () => {
				this.calls.push("workspace.cleanup");
			},
		});
	}

	upload(request: {
		sandboxId: string;
		archivePath: string;
		manifestPath: string;
		captured: CloudDelegationCapturedWorkspace;
	}): Promise<void> {
		this.calls.push("workspace.upload");
		expect(request.archivePath).toBe(CLOUD_GUEST_ARCHIVE_PATH);
		expect(request.manifestPath).toBe(CLOUD_GUEST_MANIFEST_PATH);
		return Promise.resolve();
	}
}

class FakeResults implements CloudDelegationResultsClient {
	readonly saved: CloudDelegationTaskResult[] = [];
	result?: CloudDelegationTaskResult;
	enabled = true;
	failFetch?: Error;

	constructor(private readonly calls: string[]) {}

	fetch(_sandboxId: string): Promise<CloudDelegationTaskResult | undefined> {
		this.calls.push("results.fetch");
		if (this.failFetch !== undefined) {
			const error = this.failFetch;
			this.failFetch = undefined;
			return Promise.reject(error);
		}
		return Promise.resolve(this.enabled ? this.result : undefined);
	}

	save(request: { sessionId: string; result: CloudDelegationTaskResult }): Promise<void> {
		this.calls.push("results.save");
		this.saved.push(request.result);
		return Promise.resolve();
	}
}

class FakeReadiness implements CloudDelegationReadiness {
	ready = true;
	gate?: Promise<void>;

	constructor(private readonly calls: string[]) {}

	async isReady(_sandbox: PrimeSandbox): Promise<boolean> {
		this.calls.push("readiness.isReady");
		await this.gate;
		return this.ready;
	}
}

function harness(options?: { orchestrator?: Partial<CloudDelegationOrchestratorOptions> }) {
	const calls: string[] = [];
	const store = new FakeRecordStore(calls);
	const platform = new FakePlatform(calls);
	const process = new FakeVmProcess(calls);
	const workspace = new FakeWorkspace(calls);
	const results = new FakeResults(calls);
	const readiness = new FakeReadiness(calls);
	const progress: CloudDelegationProgress[] = [];
	const orchestrator = new CloudDelegationOrchestrator(
		{ store, platform, process, workspace, results, readiness },
		{
			pollIntervalMs: 1,
			stopTimeoutMs: 5,
			sleepFn: async () => {},
			onProgress: (event) => progress.push(event),
			...options?.orchestrator,
		},
	);
	return { calls, store, platform, process, workspace, results, readiness, progress, orchestrator };
}

function sandboxSpec(overrides?: Partial<CloudDelegationSandboxSpec>): CloudDelegationSandboxSpec {
	return {
		dockerImage: "ghcr.io/primeintellect/prime-agent-cloud:1",
		cpuCores: 4,
		memoryGb: 8,
		diskSizeGb: 40,
		timeoutMinutes: 60,
		...overrides,
	};
}

function delegationRequest(overrides?: Partial<CloudDelegationRequest>): CloudDelegationRequest {
	return {
		prompt: PROMPT,
		cwd: "/repo",
		sandbox: sandboxSpec(),
		inferenceCredential: CREDENTIAL,
		...overrides,
	};
}

function taskResult(outcome: "completed" | "failed" | "stopped"): CloudDelegationTaskResult {
	return {
		outcome,
		stdout: "task stdout",
		stderr: "task stderr",
		patch: new Uint8Array([1, 2, 3]),
		retrievedAt: new Date().toISOString(),
	};
}

async function expectFailure(
	call: () => Promise<unknown>,
	code: CloudDelegationErrorCode,
): Promise<CloudDelegationError> {
	try {
		await call();
	} catch (error) {
		expect(error).toBeInstanceOf(CloudDelegationError);
		const typed = error as CloudDelegationError;
		expect(typed.code).toBe(code);
		return typed;
	}
	throw new Error("expected the call to reject");
}

function requireRecord(store: FakeRecordStore, sessionId: string): CloudSessionRecord {
	const record = store.records.get(sessionId);
	expect(record).toBeDefined();
	return record as CloudSessionRecord;
}

function platformCalls(calls: readonly string[]): string[] {
	return calls.filter((entry) => entry.startsWith("platform."));
}

describe("CloudDelegationOrchestrator", () => {
	it("delegates through the full workflow with fixed inputs and deterministic phases", async () => {
		const h = harness();
		const request = delegationRequest({
			sessionId: "sess_full-1",
			model: "anthropic/test-model",
			packageSpec: "pi-coding-agent@0.9.4",
		});
		const handle = await h.orchestrator.delegate(request);

		expect(handle.status).toBe("running");
		expect(handle.sessionId).toBe("sess_full-1");
		expect(handle.sandboxId).toBe("sbx-0");

		// Capture is the first boundary call, the record precedes provisioning,
		// and readiness adds the injected check on top of the platform status.
		expect(h.calls[0]).toBe("workspace.capture");
		expect(h.calls.indexOf("store.create")).toBeLessThan(h.calls.indexOf("platform.createVmSandbox"));
		expect(h.calls.indexOf("platform.createVmSandbox")).toBeLessThan(h.calls.indexOf("readiness.isReady"));
		expect(h.calls.indexOf("readiness.isReady")).toBeLessThan(
			h.calls.indexOf(`platform.uploadFile ${CLOUD_GUEST_AUTH_PATH}`),
		);
		expect(h.calls.indexOf(`platform.uploadFile ${CLOUD_GUEST_AUTH_PATH}`)).toBeLessThan(
			h.calls.indexOf("process.start"),
		);
		expect(h.calls[h.calls.length - 1]).toBe("workspace.cleanup");

		// The uploaded bootstrap is the fixed script; prompt and credential are files.
		const decoder = new TextDecoder();
		expect(decoder.decode(h.platform.uploads.get(CLOUD_GUEST_BOOTSTRAP_PATH) ?? new Uint8Array())).toBe(
			CLOUD_DELEGATION_BOOTSTRAP_SCRIPT,
		);
		expect(decoder.decode(h.platform.uploads.get(CLOUD_GUEST_PROMPT_PATH) ?? new Uint8Array())).toBe(PROMPT);
		expect(decoder.decode(h.platform.uploads.get(CLOUD_GUEST_AUTH_PATH) ?? new Uint8Array())).toBe(CREDENTIAL);

		// Exactly one reconnectable process, fixed argv, fixed-name env.
		expect(h.process.starts).toHaveLength(1);
		const start = h.process.starts[0];
		if (start === undefined) {
			throw new Error("expected a resident process start");
		}
		expect(start.command).toEqual(CLOUD_DELEGATION_START_COMMAND);
		expect(start.command.args).toEqual([CLOUD_GUEST_BOOTSTRAP_PATH]);
		expect(start.env.PRIME_AGENT_CLOUD_SESSION_ID).toBe("sess_full-1");
		expect(start.env.PRIME_AGENT_CLOUD_GENERATION).toBe("1");
		expect(start.env.PRIME_AGENT_CLOUD_MODEL).toBe("anthropic/test-model");
		expect(start.env.PRIME_AGENT_CLOUD_PACKAGE).toBe("pi-coding-agent@0.9.4");
		expect(start.env.PRIME_AGENT_CLOUD_WORKSPACE_DIR).toBe("/opt/prime-agent/workspace");
		const envValues = Object.values(start.env).join("\n");
		expect(envValues).not.toContain(PROMPT);
		expect(envValues).not.toContain(CREDENTIAL);

		// The durable record holds identity, baseline, and deadline.
		const record = requireRecord(h.store, "sess_full-1");
		expect(record.residentProcessUuid).toMatch(/^[0-9a-f-]{36}$/);
		expect(record.residentProcessUuid).toBe(start.sessionUuid);
		expect(record.sandboxId).toBe("sbx-0");
		expect(record.createIdempotencyKey).toMatch(/^cloud-[a-f0-9]{48}$/);
		expect(record.baseline).toEqual({
			repoRoot: "/repo",
			headCommit: null,
			manifestDigest: `sha256:${"a".repeat(64)}`,
		});
		expect(Date.parse(record.deadlineAt ?? "") - Date.parse(record.createdAt)).toBe(60 * 60_000);
		expect(record.desiredLifecycle).toBe("running");
		expect(record.observedLifecycle).toBe("running");
		expect(record.cleanupState).toBe("none");
		expect(record.resultImportState).toBe("pending");
		expect(cloudDelegationPhaseOf(record)).toBe("running");

		// Progress phases follow the deterministic workflow order.
		expect(h.progress.map((event) => event.phase)).toEqual([
			"capturing",
			"allocating",
			"provisioning",
			"waiting",
			"uploading",
			"starting",
			"running",
		]);
	});

	it("makes no platform call before the workspace capture and records nothing when capture fails", async () => {
		const h = harness();
		h.workspace.failCapture = new Error("not a git repository");
		await expectFailure(
			() => h.orchestrator.delegate(delegationRequest({ sessionId: "sess_capfail-1" })),
			"capture_failed",
		);
		expect(platformCalls(h.calls)).toEqual([]);
		expect(h.process.starts).toHaveLength(0);
		expect(h.results.saved).toHaveLength(0);
		expect(h.store.records.size).toBe(0);
	});

	it("validates prompt, deadline, and workspace size before any boundary work", async () => {
		const h = harness();
		await expectFailure(
			() => h.orchestrator.delegate(delegationRequest({ prompt: "x".repeat(CLOUD_MAX_PROMPT_CHARS + 1) })),
			"invalid_request",
		);
		await expectFailure(
			() => h.orchestrator.delegate(delegationRequest({ sandbox: sandboxSpec({ timeoutMinutes: 5 }) })),
			"invalid_request",
		);
		expect(h.workspace.captureCount).toBe(0);
		expect(h.store.records.size).toBe(0);

		const h2 = harness();
		h2.workspace.totalSizeBytes = MAX_TRANSFER_BYTES + 1;
		await expectFailure(() => h2.orchestrator.delegate(delegationRequest()), "too_large");
		expect(platformCalls(h2.calls)).toEqual([]);
		expect(h2.store.records.size).toBe(0);
	});

	it("recovers from an upload failure without a second sandbox or process", async () => {
		const h = harness();
		h.platform.failUpload = new Error("gateway 502");
		const request = delegationRequest({ sessionId: "sess_upfail-1" });
		await expectFailure(() => h.orchestrator.delegate(request), "upload_failed");

		const afterFailure = requireRecord(h.store, "sess_upfail-1");
		expect(afterFailure.sandboxId).toBe("sbx-0");
		expect(afterFailure.observedLifecycle).toBe("provisioning");
		expect(afterFailure.lastError).toContain(`uploading ${CLOUD_GUEST_BOOTSTRAP_PATH} failed`);

		const handle = await h.orchestrator.delegate(request);
		expect(handle.status).toBe("running");
		expect(h.platform.createKeys).toHaveLength(1);
		expect(h.process.starts).toHaveLength(1);
		expect(h.platform.sandboxCount).toBe(1);
	});

	it("retries an inconclusive create with the same idempotency key and one sandbox", async () => {
		const h = harness();
		h.platform.failCreate = new Error("network blip");
		const request = delegationRequest({ sessionId: "sess_createfail-1" });
		await expectFailure(() => h.orchestrator.delegate(request), "provision_failed");
		expect(requireRecord(h.store, "sess_createfail-1").sandboxId).toBeUndefined();

		const handle = await h.orchestrator.delegate(request);
		expect(handle.status).toBe("running");
		expect(h.platform.createKeys).toHaveLength(2);
		expect(h.platform.createKeys[0]).toMatch(/^cloud-[a-f0-9]{48}$/);
		expect(h.platform.createKeys[1]).toBe(h.platform.createKeys[0]);
		expect(h.platform.sandboxCount).toBe(1);
		expect(handle.sandboxId).toBe("sbx-0");
	});

	it("treats a duplicate delegate call as a resume, never a second task", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_dup-1" });
		const first = await h.orchestrator.delegate(request);
		expect(first.status).toBe("running");

		const mark = h.calls.length;
		const second = await h.orchestrator.delegate(request);
		expect(second.status).toBe("running");
		expect(h.platform.createKeys).toHaveLength(1);
		expect(h.process.starts).toHaveLength(1);
		expect(platformCalls(h.calls.slice(mark))).toEqual([]);
		const resumed = h.calls.slice(mark);
		// Recovery checks results and process status before anything else.
		expect(resumed).toContain("results.fetch");
		expect(resumed).toContain("process.status");
		expect(resumed.indexOf("results.fetch")).toBeLessThan(resumed.indexOf("process.status"));
	});

	it("retrieves results for a task that completed during a disconnect without attach or start", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_disc-1" });
		await h.orchestrator.delegate(request);

		h.results.result = taskResult("completed");
		h.process.setState({ state: "exited", exitCode: 0 });

		const mark = h.calls.length;
		const handle = await h.orchestrator.delegate(request);
		expect(handle.status).toBe("completed");
		expect(handle.results?.outcome).toBe("completed");
		expect(handle.results?.patch).toEqual(new Uint8Array([1, 2, 3]));
		expect(h.process.starts).toHaveLength(1);
		expect(h.calls.slice(mark)).not.toContain("process.start");
		expect(h.calls.slice(mark)).not.toContain("process.status");
		expect(h.results.saved).toHaveLength(1);
		expect(h.platform.deleted).toHaveLength(0);

		const record = requireRecord(h.store, "sess_disc-1");
		expect(record.resultImportState).toBe("available");
		expect(record.cleanupState).toBe("imported");
		expect(record.observedLifecycle).toBe("stopped");
		expect(record.desiredLifecycle).toBe("stopping");
		expect(cloudDelegationPhaseOf(record)).toBe("review");
		expect(h.progress.map((event) => event.phase).slice(-2)).toEqual(["retrieving", "review"]);
	});

	it("marks a lost resident process without replaying the task", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_lost-1" });
		await h.orchestrator.delegate(request);
		h.process.setState({ state: "lost" });

		const handle = await h.orchestrator.delegate(request);
		expect(handle.status).toBe("lost");
		expect(h.process.starts).toHaveLength(1);
		expect(requireRecord(h.store, "sess_lost-1").observedLifecycle).toBe("lost");
	});

	it("stop signals idempotently, retrieves results before any delete, and leaves review state", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_stop-1" });
		await h.orchestrator.delegate(request);

		// No terminal result until the stop signal lands; then the bootstrap's
		// result becomes visible.
		h.results.enabled = false;
		h.results.result = taskResult("stopped");
		h.process.onSignal = () => {
			h.results.enabled = true;
		};

		const handle = await h.orchestrator.stop("sess_stop-1");
		expect(handle.status).toBe("stopped");
		expect(handle.results?.outcome).toBe("stopped");
		expect(h.process.signalCount).toBe(1);
		expect(h.results.saved).toHaveLength(1);
		expect(h.platform.deleted).toHaveLength(0);
		expect(h.calls.indexOf("process.signalStop")).toBeLessThan(h.calls.indexOf("results.save"));

		const record = requireRecord(h.store, "sess_stop-1");
		expect(record.desiredLifecycle).toBe("stopping");
		expect(record.observedLifecycle).toBe("stopped");
		expect(record.cleanupState).toBe("imported");
		expect(record.resultImportState).toBe("available");

		// A second stop is a no-op: the results are already terminal.
		await h.orchestrator.stop("sess_stop-1");
		expect(h.process.signalCount).toBe(1);
		expect(h.platform.deleted).toHaveLength(0);
	});

	it("does not report a still-running process as stopped after the stop timeout", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_stop-timeout-1" });
		await h.orchestrator.delegate(request);
		h.results.enabled = false;
		h.process.ignoreSignal = true;

		const handle = await h.orchestrator.stop("sess_stop-timeout-1");
		expect(handle.status).toBe("uncertain");
		const record = requireRecord(h.store, "sess_stop-timeout-1");
		expect(record.observedLifecycle).toBe("running");
		expect(record.desiredLifecycle).toBe("stopping");
		expect(record.lastError).toContain("after the stop timeout");

		const starts = h.process.starts.length;
		const replay = await h.orchestrator.delegate(request);
		expect(replay.status).toBe("uncertain");
		expect(h.process.starts).toHaveLength(starts);
		expect(requireRecord(h.store, "sess_stop-timeout-1").desiredLifecycle).toBe("stopping");
	});

	it("does not start a process when stop wins during provisioning", async () => {
		const h = harness();
		let releaseReadiness!: () => void;
		h.readiness.gate = new Promise<void>((resolve) => {
			releaseReadiness = resolve;
		});
		const request = delegationRequest({ sessionId: "sess_stop-provisioning-1" });
		const delegation = h.orchestrator.delegate(request);
		while (!h.calls.includes("readiness.isReady")) await Promise.resolve();

		const stopped = await h.orchestrator.stop("sess_stop-provisioning-1");
		expect(stopped.status).toBe("uncertain");
		releaseReadiness();
		const completedDelegate = await delegation;
		expect(completedDelegate.status).toBe("uncertain");
		expect(h.process.starts).toHaveLength(0);
		expect(requireRecord(h.store, "sess_stop-provisioning-1").desiredLifecycle).toBe("stopping");
	});

	it("forfeit deletes the sandbox only after retrieving results, and is idempotent", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_forfeit-1" });
		await h.orchestrator.delegate(request);
		h.results.result = taskResult("completed");

		const handle = await h.orchestrator.forfeit("sess_forfeit-1");
		expect(handle.status).toBe("completed");
		expect(handle.results?.outcome).toBe("completed");
		expect(h.results.saved).toHaveLength(1);
		expect(h.platform.deleted).toEqual(["sbx-0"]);
		expect(h.calls.indexOf("results.fetch")).toBeLessThan(h.calls.indexOf("platform.deleteSandbox"));
		expect(h.calls.indexOf("results.save")).toBeLessThan(h.calls.indexOf("platform.deleteSandbox"));

		const record = requireRecord(h.store, "sess_forfeit-1");
		expect(record.cleanupState).toBe("released");
		expect(record.observedLifecycle).toBe("deleted");
		expect(record.desiredLifecycle).toBe("deleted");
		expect(record.resultImportState).toBe("skipped");
		expect(cloudDelegationPhaseOf(record)).toBe("released");

		const again = await h.orchestrator.forfeit("sess_forfeit-1");
		expect(again.status).toBe("released");
		expect(h.platform.deleted).toHaveLength(1);
	});

	it("forfeit without results still releases compute and reports an uncertain outcome", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_forfeit2-1" });
		await h.orchestrator.delegate(request);

		const handle = await h.orchestrator.forfeit("sess_forfeit2-1");
		expect(handle.status).toBe("uncertain");
		expect(handle.results).toBeUndefined();
		expect(h.platform.deleted).toEqual(["sbx-0"]);
		expect(requireRecord(h.store, "sess_forfeit2-1").resultImportState).toBe("skipped");
	});

	it("redacts secrets from errors, records, and progress", async () => {
		const h = harness();
		h.platform.failUpload = new Error(`upload rejected (token ${GATEWAY_TOKEN}) with credential ${CREDENTIAL}`);
		const error = await expectFailure(
			() => h.orchestrator.delegate(delegationRequest({ sessionId: "sess_redact-1" })),
			"upload_failed",
		);
		expect(error.message).toContain("[redacted]");
		expect(error.message).not.toContain(GATEWAY_TOKEN);
		expect(error.message).not.toContain(CREDENTIAL);
		expect(error.cause).toBeInstanceOf(Error);

		const record = requireRecord(h.store, "sess_redact-1");
		expect(record.lastError).toContain("[redacted]");
		expect(record.lastError).not.toContain(GATEWAY_TOKEN);
		expect(record.lastError).not.toContain(CREDENTIAL);
		expect(JSON.stringify(record)).not.toContain(CREDENTIAL);

		for (const event of h.progress) {
			expect(event.detail ?? "").not.toContain(GATEWAY_TOKEN);
			expect(event.detail ?? "").not.toContain(CREDENTIAL);
		}
	});

	it("rejects resuming a delegation whose workspace changed since capture", async () => {
		const h = harness();
		const request = delegationRequest({ sessionId: "sess_basechg-1" });
		await h.orchestrator.delegate(request);
		h.workspace.manifestDigest = `sha256:${"b".repeat(64)}`;

		await expectFailure(() => h.orchestrator.delegate(request), "conflict");
		expect(h.process.starts).toHaveLength(1);
		expect(requireRecord(h.store, "sess_basechg-1").baseline?.manifestDigest).toBe(`sha256:${"a".repeat(64)}`);
	});

	it("fails closed for unknown sessions", async () => {
		const h = harness();
		await expectFailure(() => h.orchestrator.stop("sess_missing-1"), "not_found");
		await expectFailure(() => h.orchestrator.forfeit("sess_missing-1"), "not_found");
	});

	it("keeps the bootstrap contract: fixed script, terminal writes, binary patch", () => {
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("trap finish EXIT");
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("status.txt");
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("stdout.txt");
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("stderr.txt");
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("diff --binary");
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("changes.patch");
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("PRIME_AGENT_CLOUD_MODEL");
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).not.toContain(PROMPT);
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).not.toContain(CREDENTIAL);
		expect(CLOUD_DELEGATION_START_COMMAND.args).toEqual([CLOUD_GUEST_BOOTSTRAP_PATH]);
	});
});
