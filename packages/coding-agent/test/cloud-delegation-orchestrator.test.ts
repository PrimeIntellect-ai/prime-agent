import { describe, expect, it } from "vitest";
import type {
	CloudCleanupState,
	CloudDesiredLifecycle,
	CloudObservedLifecycle,
	CloudResultImportState,
	CloudSessionBaseline,
	CloudSessionCreateInput,
	CloudSessionRecord,
	CloudSessionTunnel,
	CloudTunnelState,
} from "../src/core/cloud/cloud-session-store.js";
import {
	CLOUD_DELEGATION_BOOTSTRAP_SCRIPT,
	CLOUD_DELEGATION_START_COMMAND,
	CLOUD_GUEST_AUTH_PATH,
	CLOUD_GUEST_BOOTSTRAP_PATH,
	CLOUD_GUEST_PROMPT_PATH,
	CloudDelegationError,
	type CloudDelegationErrorCode,
	CloudDelegationOrchestrator,
	type CloudDelegationOrchestratorOptions,
	type CloudDelegationProgress,
	type CloudDelegationRecordStore,
	type CloudDelegationRequest,
	type CloudDelegationSandboxSpec,
	type CloudDelegationTaskResult,
	cloudDelegationPhaseOf,
} from "../src/core/cloud/delegation-orchestrator.js";
import { MAX_TRANSFER_BYTES, type PrimeSandboxStatus } from "../src/core/cloud/prime-sandbox-client.js";
import { CLOUD_MAX_PROMPT_CHARS } from "../src/core/cloud/protocol.js";
import {
	RecordingReadiness,
	RecordingResultsClient,
	RecordingSandboxPlatform,
	RecordingVmProcess,
	RecordingWorkspaceTransfer,
} from "./cloud-support.js";

const GATEWAY_TOKEN = "gtw-secret-token-1234";
const CREDENTIAL = "sk-cloud-inference-secret";
const PROMPT = "fix the failing test";

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

	setTunnel(sessionId: string, tunnel: CloudSessionTunnel): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			record.tunnel = { ...tunnel };
			record.tunnelState = "registered";
		});
	}

	setTunnelState(sessionId: string, state: CloudTunnelState): CloudSessionRecord {
		return this.mutate(sessionId, (record) => {
			record.tunnelState = state;
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

function harness(options?: { orchestrator?: Partial<CloudDelegationOrchestratorOptions> }) {
	const calls: string[] = [];
	const store = new FakeRecordStore(calls);
	const platform = new RecordingSandboxPlatform(calls, { gatewayToken: GATEWAY_TOKEN });
	const process = new RecordingVmProcess(calls);
	const workspace = new RecordingWorkspaceTransfer(calls);
	const results = new RecordingResultsClient(calls);
	const readiness = new RecordingReadiness(calls);
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
		changedPaths: [],
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
		const cases: Array<{
			name: string;
			code: CloudDelegationErrorCode;
			captures: number;
			request: CloudDelegationRequest;
			totalSizeBytes?: number;
		}> = [
			{
				name: "oversized prompt",
				code: "invalid_request",
				captures: 0,
				request: delegationRequest({ prompt: "x".repeat(CLOUD_MAX_PROMPT_CHARS + 1) }),
			},
			{
				name: "short deadline",
				code: "invalid_request",
				captures: 0,
				request: delegationRequest({ sandbox: sandboxSpec({ timeoutMinutes: 5 }) }),
			},
			{
				name: "oversized workspace",
				code: "too_large",
				captures: 1,
				request: delegationRequest(),
				totalSizeBytes: MAX_TRANSFER_BYTES + 1,
			},
		];
		for (const { name, code, captures, request, totalSizeBytes } of cases) {
			const h = harness();
			if (totalSizeBytes !== undefined) h.workspace.totalSizeBytes = totalSizeBytes;
			await expectFailure(() => h.orchestrator.delegate(request), code);
			expect(platformCalls(h.calls), name).toEqual([]);
			expect(h.workspace.captureCount, name).toBe(captures);
			expect(h.store.records.size, name).toBe(0);
		}
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

	it("carries the guest inference billing team on the resident process env", async () => {
		const h = harness();
		await h.orchestrator.delegate(delegationRequest({ sessionId: "sess_team-1", inferenceTeamId: "team_guest" }));
		const start = h.process.starts[0];
		if (start === undefined) throw new Error("expected a resident process start");
		expect(start.env.PRIME_TEAM_ID).toBe("team_guest");

		const bare = harness();
		await bare.orchestrator.delegate(delegationRequest({ sessionId: "sess_team-2" }));
		expect(bare.process.starts[0]?.env.PRIME_TEAM_ID).toBeUndefined();
	});

	it("keeps the bootstrap contract: fixed script, terminal writes, binary patch", () => {
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("trap finish EXIT");
		// The workspace extraction must not preserve contributor ownership:
		// a root extraction of a macOS uid on the "." entry makes git refuse
		// the repo ("not in a git directory") in the deployed sandbox.
		expect(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT).toContain("tar --no-same-owner -xf");
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
