import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect } from "vitest";
import {
	type CloudTunnelConnection,
	type CloudTunnelTransport,
	CloudTunnelTransportError,
} from "../src/core/cloud/bridge/tunnel-transport.js";
import { CloudSessionStore } from "../src/core/cloud/cloud-session-store.js";
import {
	CLOUD_GUEST_ARCHIVE_PATH,
	CLOUD_GUEST_MANIFEST_PATH,
	type CloudDelegationCapturedWorkspace,
	type CloudDelegationPlatformClient,
	type CloudDelegationReadiness,
	type CloudDelegationResultsClient,
	type CloudDelegationTaskResult,
	type CloudDelegationTunnelClient,
	type CloudDelegationTunnelRegistration,
	type CloudDelegationVmProcessClient,
	type CloudDelegationVmProcessStartRequest,
	type CloudDelegationVmProcessState,
	type CloudDelegationWorkspaceTransfer,
} from "../src/core/cloud/delegation-orchestrator.js";
import { DirectCloudService, type DirectCloudServiceOptions } from "../src/core/cloud/direct-cloud-service.js";
import type {
	PrimeSandbox,
	PrimeSandboxAuth,
	PrimeSandboxClient,
	PrimeSandboxUploadRequest,
	PrimeSandboxUploadResult,
	PrimeSandboxVmCreateRequest,
} from "../src/core/cloud/prime-sandbox-client.js";
import { CloudResultStore } from "../src/core/cloud/result-import.js";
import { CloudGuestDaemon, parseCloudDaemonEnv } from "../src/modes/cloud/cloud-daemon.js";
import { createFauxRuntimeFactory } from "./fixtures/cloud-guest-daemon-fixture.js";

/**
 * Shared harness for the resident-cloud suites: the recording tunnel
 * transport, the faux response queue, the fake delegation stack, and the
 * guest daemon fixtures. One implementation keeps the suites focused on the
 * behavior they pin instead of re-deriving the same fakes per file.
 */

// --- temp roots ---------------------------------------------------------------

const cloudRoots: string[] = [];

afterEach(() => {
	for (const root of cloudRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A per-test workspace root, removed after the suite's tests finish. */
export function cloudTemp(prefix = "cloud-test-"): string {
	const root = mkdtempSync(join(tmpdir(), `${prefix}`));
	cloudRoots.push(root);
	return root;
}

// --- faux provider response queue ---------------------------------------------

/** Queue one AssistantMessage step the in-process faux provider will pop. */
export function queueFauxResponse(root: string, text: string): void {
	const responsesPath = join(root, "responses.jsonl");
	process.env.PRIME_AGENT_TEST_FAUX_RESPONSES = responsesPath;
	delete process.env.PRIME_AGENT_TEST_FAUX_ECHO;
	const response = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		timestamp: Date.now(),
		usage: {
			input: 3,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
	const existing = existsSync(responsesPath) ? readFileSync(responsesPath, "utf8") : "";
	writeFileSync(responsesPath, `${existing}${JSON.stringify(response)}\n`, { mode: 0o600 });
}

// --- recording unix-socket tunnel transport -----------------------------------

/**
 * A CloudTunnelTransport over a real unix socket that records both frame
 * directions and can simulate a downed edge or a client-initiated drop.
 */
export class RecordingTunnelTransport implements CloudTunnelTransport {
	readonly sentFrames: string[] = [];
	/** Every line the server sent, for resync and loop accounting. */
	readonly serverFrames: string[] = [];
	/** While set, connect() fails like a downed tunnel edge. */
	down = false;
	private readonly sockets = new Set<Socket>();
	closedByServer = false;
	closedByClient = false;

	async connect(socketPath: string): Promise<CloudTunnelConnection> {
		if (this.down) {
			throw new CloudTunnelTransportError("connect", "tunnel edge is down (test)");
		}
		// Per-connection state only: one registry drives several concurrent
		// attachments (one per cloud session) through this transport.
		const socket: Socket = createConnection(socketPath);
		this.sockets.add(socket);
		let messageHandler: ((message: string) => void) | undefined;
		let closeHandler: ((error?: CloudTunnelTransportError) => void) | undefined;
		let buffer = "";
		const earlyLines: string[] = [];
		await new Promise<void>((resolve, reject) => {
			socket.setNoDelay(true);
			socket.once("connect", () => resolve());
			socket.once("error", (error) => reject(error));
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				this.serverFrames.push(line);
				if (messageHandler !== undefined) {
					messageHandler(line);
				} else {
					earlyLines.push(line);
				}
			}
		});
		socket.on("close", () => {
			this.closedByServer = true;
			closeHandler?.();
		});
		return {
			send: (message: string) => {
				this.sentFrames.push(message);
				if (!socket.destroyed) socket.write(`${message}\n`);
			},
			close: () => {
				this.closedByClient = true;
				socket.destroy();
			},
			onMessage: (handler) => {
				messageHandler = handler;
				for (const line of earlyLines.splice(0)) handler(line);
			},
			onClose: (handler) => {
				closeHandler = handler;
			},
		};
	}

	/** Client-initiated disconnect: every in-flight frame and ack is dropped. */
	drop(): void {
		for (const socket of [...this.sockets]) {
			this.sockets.delete(socket);
			socket.destroy();
		}
	}
}

// --- fake delegation stack ----------------------------------------------------

export interface FakeDelegationStackOptions {
	/** Fails createVmSandbox with the given error instead of provisioning. */
	failProvisioning?: boolean;
	/** Sandbox identity for roster and auth surfaces. */
	sandboxId?: string;
	/** Tunnel URL per session id (the guest socket path); defaults to guest.sock. */
	guestSocketUrl?: (sessionId: string) => string;
	/** Whether artifact downloads are expected; defaults to throwing. */
	downloadFile?: (sandboxId: string, path: string) => Promise<Uint8Array>;
	/** Captured-workspace baseline; defaults to the temp root at no commit. */
	baseline?: { repoRoot: string; headCommit: string | null };
}

/** The platform sandbox every fake stack provisions. */
export function fakeSandbox(sandboxId = "sandbox-1"): PrimeSandbox {
	const now = "2026-01-01T00:00:00.000Z";
	return {
		id: sandboxId,
		name: "cloud",
		dockerImage: "example/cloud:1",
		cpuCores: 4,
		memoryGb: 16,
		diskSizeGb: 50,
		gpuCount: 0,
		vm: true,
		status: "RUNNING",
		timeoutMinutes: 120,
		labels: [],
		createdAt: now,
		updatedAt: now,
	};
}

/** Prime Sandbox platform boundary that records every call in order. */
export class RecordingSandboxPlatform implements CloudDelegationPlatformClient {
	readonly createKeys: (string | undefined)[] = [];
	readonly uploads = new Map<string, Uint8Array>();
	readonly deleted: string[] = [];
	sandboxCount = 0;
	/** One-shot createVmSandbox failure: the retried create must reuse the key. */
	failCreate?: Error;
	/** One-shot uploadFile failure. */
	failUpload?: Error;
	private readonly byId = new Map<string, PrimeSandbox>();
	private readonly byKey = new Map<string, PrimeSandbox>();
	private nextId = 0;

	constructor(
		private readonly calls: string[] = [],
		private readonly options: {
			/** Every provisioned sandbox carries this id; defaults to sbx-N per create. */
			sandboxId?: string;
			/** Gateway bearer token; redaction suites override it with their secret. */
			gatewayToken?: string;
			/** Persistent createVmSandbox failure: honest terminal provisioning errors. */
			failProvisioning?: boolean;
			/** Artifact download; defaults to refusing downloads. */
			downloadFile?: (sandboxId: string, path: string) => Promise<Uint8Array>;
		} = {},
	) {}

	async createVmSandbox(request: PrimeSandboxVmCreateRequest): Promise<PrimeSandbox> {
		this.calls.push("platform.createVmSandbox");
		this.createKeys.push(request.idempotencyKey);
		if (this.options.failProvisioning === true) throw new Error("provisioning exploded");
		if (this.failCreate !== undefined) {
			const error = this.failCreate;
			this.failCreate = undefined;
			throw error;
		}
		const key = request.idempotencyKey ?? `auto-${this.nextId}`;
		const existing = this.byKey.get(key);
		if (existing !== undefined) return existing;
		const sandbox = fakeSandbox(this.options.sandboxId ?? `sbx-${this.nextId++}`);
		this.sandboxCount += 1;
		this.byId.set(sandbox.id, sandbox);
		this.byKey.set(key, sandbox);
		return sandbox;
	}

	async getSandbox(sandboxId: string): Promise<PrimeSandbox> {
		this.calls.push("platform.getSandbox");
		// Unknown ids stay RUNNING so a fresh stack instance still resolves
		// durable records after a restart.
		return this.byId.get(sandboxId) ?? fakeSandbox(sandboxId);
	}

	async deleteSandbox(sandboxId: string): Promise<void> {
		this.calls.push("platform.deleteSandbox");
		this.deleted.push(sandboxId);
	}

	async getSandboxAuth(sandboxId: string): Promise<PrimeSandboxAuth> {
		this.calls.push("platform.getSandboxAuth");
		return {
			sandboxId,
			gatewayUrl: "https://gateway.example",
			userNamespace: "user",
			jobId: "job",
			token: this.options.gatewayToken ?? "gateway-token",
			expiresAt: "2099-01-01T00:00:00.000Z",
		};
	}

	async uploadFile(_sandboxId: string, request: PrimeSandboxUploadRequest): Promise<PrimeSandboxUploadResult> {
		this.calls.push(`platform.uploadFile ${request.path}`);
		if (this.failUpload !== undefined) {
			const error = this.failUpload;
			this.failUpload = undefined;
			throw error;
		}
		this.uploads.set(request.path, request.content);
		return {
			success: true,
			path: request.path,
			size: request.content.byteLength,
			timestamp: "2026-01-01T00:00:00.000Z",
		};
	}

	async downloadFile(sandboxId: string, path: string): Promise<Uint8Array> {
		if (this.options.downloadFile === undefined) {
			throw new Error("no artifacts expected in this suite");
		}
		return this.options.downloadFile(sandboxId, path);
	}
}

/** Reconnectable VM process boundary with recordable state and signals. */
export class RecordingVmProcess implements CloudDelegationVmProcessClient {
	readonly starts: CloudDelegationVmProcessStartRequest[] = [];
	signalCount = 0;
	ignoreSignal = false;
	/** Runs after signalStop records its stop intent. */
	onSignal?: () => void;
	private readonly states = new Map<string, CloudDelegationVmProcessState>();
	private fallbackState: CloudDelegationVmProcessState = { state: "unknown" };

	constructor(private readonly calls: string[] = []) {}

	/** State for every process uuid: simulates an exited or lost resident. */
	setState(state: CloudDelegationVmProcessState): void {
		this.fallbackState = state;
		this.states.clear();
	}

	async start(request: CloudDelegationVmProcessStartRequest): Promise<{ sessionUuid: string; created: boolean }> {
		this.calls.push("process.start");
		this.starts.push(request);
		const created = !this.states.has(request.sessionUuid);
		this.states.set(request.sessionUuid, { state: "running" });
		return { sessionUuid: request.sessionUuid, created };
	}

	async signalStop(sessionUuid: string): Promise<void> {
		this.calls.push("process.signalStop");
		this.signalCount += 1;
		if (!this.ignoreSignal) this.states.set(sessionUuid, { state: "exited", exitCode: 0 });
		this.onSignal?.();
	}

	async status(sessionUuid: string): Promise<CloudDelegationVmProcessState> {
		this.calls.push("process.status");
		return this.states.get(sessionUuid) ?? this.fallbackState;
	}
}

/** Workspace capture/upload boundary with a scriptable captured baseline. */
export class RecordingWorkspaceTransfer implements CloudDelegationWorkspaceTransfer {
	captureCount = 0;
	failCapture?: Error;
	manifestDigest = `sha256:${"a".repeat(64)}`;
	totalSizeBytes = 3;

	constructor(
		private readonly calls: string[] = [],
		private readonly options: { baseline?: { repoRoot?: string; headCommit?: string | null } } = {},
	) {}

	async capture(request: { cwd: string }): Promise<CloudDelegationCapturedWorkspace> {
		this.calls.push("workspace.capture");
		this.captureCount += 1;
		if (this.failCapture !== undefined) {
			const error = this.failCapture;
			this.failCapture = undefined;
			throw error;
		}
		return {
			baseline: {
				repoRoot: this.options.baseline?.repoRoot ?? request.cwd,
				headCommit: this.options.baseline?.headCommit ?? null,
				manifestDigest: this.manifestDigest,
			},
			archive: new Uint8Array([1]),
			manifest: new TextEncoder().encode("{}"),
			totalSizeBytes: this.totalSizeBytes,
			cleanup: () => {
				this.calls.push("workspace.cleanup");
			},
		};
	}

	async upload(request: {
		sandboxId: string;
		archivePath: string;
		manifestPath: string;
		captured: CloudDelegationCapturedWorkspace;
	}): Promise<void> {
		this.calls.push("workspace.upload");
		expect(request.archivePath).toBe(CLOUD_GUEST_ARCHIVE_PATH);
		expect(request.manifestPath).toBe(CLOUD_GUEST_MANIFEST_PATH);
	}
}

/** Terminal-result boundary whose fetched result tests toggle in place. */
export class RecordingResultsClient implements CloudDelegationResultsClient {
	readonly saved: CloudDelegationTaskResult[] = [];
	/** fetch() returns this while enabled; undefined means no terminal result yet. */
	result?: CloudDelegationTaskResult;
	enabled = true;

	constructor(private readonly calls: string[] = []) {}

	async fetch(_sandboxId: string): Promise<CloudDelegationTaskResult | undefined> {
		this.calls.push("results.fetch");
		return this.enabled ? this.result : undefined;
	}

	async save(request: { sessionId: string; result: CloudDelegationTaskResult }): Promise<void> {
		this.calls.push("results.save");
		this.saved.push(request.result);
	}
}

/** Guest readiness whose check can be gated on a deferred promise. */
export class RecordingReadiness implements CloudDelegationReadiness {
	gate?: Promise<void>;

	constructor(private readonly calls: string[] = []) {}

	async isReady(_sandbox: PrimeSandbox): Promise<boolean> {
		this.calls.push("readiness.isReady");
		await this.gate;
		return true;
	}
}

/**
 * The fake platform, workspace, process, results, and tunnels clients one
 * delegation needs; every suite builds on the same semantics. The platform
 * is a spreadable object over the recording class so wrapper suites can
 * decorate individual calls without losing the rest of the surface.
 */
export function fakeDelegationStack(root: string, options: FakeDelegationStackOptions = {}) {
	const recordingPlatform = new RecordingSandboxPlatform([], {
		sandboxId: options.sandboxId,
		failProvisioning: options.failProvisioning,
		downloadFile: options.downloadFile,
	});
	const platform = {
		createVmSandbox: (request: PrimeSandboxVmCreateRequest) => recordingPlatform.createVmSandbox(request),
		getSandbox: (sandboxId: string) => recordingPlatform.getSandbox(sandboxId),
		deleteSandbox: (sandboxId: string) => recordingPlatform.deleteSandbox(sandboxId),
		getSandboxAuth: (sandboxId: string) => recordingPlatform.getSandboxAuth(sandboxId),
		uploadFile: (sandboxId: string, request: PrimeSandboxUploadRequest) =>
			recordingPlatform.uploadFile(sandboxId, request),
		downloadFile: (sandboxId: string, path: string) => recordingPlatform.downloadFile(sandboxId, path),
	} as unknown as PrimeSandboxClient;
	const workspace = new RecordingWorkspaceTransfer([], {
		baseline: { repoRoot: root, ...options.baseline },
	});
	const process = new RecordingVmProcess([]);
	const results = new RecordingResultsClient([]);
	const tunnels: CloudDelegationTunnelClient = {
		register: async (request) => ({
			tunnelId: `tunnel-${randomUUID().slice(0, 8)}`,
			url: options.guestSocketUrl?.(request.sessionId) ?? join(root, "guest.sock"),
			hostname: "tunnel.example",
			httpUser: "prime-agent",
			httpPassword: "edge-password-0123456789",
			expiresAt: "2099-01-01T00:00:00.000Z",
			frpServerHost: "frp.example",
			frpServerPort: 7000,
			frpToken: "frp-token",
			bindingSecret: "binding-secret",
		}),
		delete: async () => undefined,
		get: async (tunnelId) => ({
			tunnelId,
			url: join(root, "guest.sock"),
			hostname: "tunnel.example",
			httpUser: "u",
			expiresAt: "2099-01-01T00:00:00.000Z",
		}),
	};
	return {
		platform,
		workspace,
		process,
		results,
		tunnels,
		sandbox: fakeSandbox(options.sandboxId ?? "sandbox-1"),
	};
}

/** A DirectCloudService over the fake delegation stack. */
export function fakeCloudService(
	root: string,
	options: FakeDelegationStackOptions & { store?: CloudSessionStore } = {},
): { service: DirectCloudService; store: CloudSessionStore; stack: ReturnType<typeof fakeDelegationStack> } {
	const stateDirectory = join(root, "cloud");
	const store = options.store ?? new CloudSessionStore(join(stateDirectory, "sessions"));
	const resultStore = new CloudResultStore(join(stateDirectory, "results"));
	const stack = fakeDelegationStack(root, options);
	const service = new DirectCloudService({
		stateDirectory,
		apiKey: "platform-key",
		inferenceApiKey: "inference-only-key",
		dockerImage: "example/cloud:1",
		store,
		resultStore,
		platform: stack.platform,
		workspace: stack.workspace,
		process: stack.process,
		results: stack.results,
		readiness: new RecordingReadiness(),
		tunnels: stack.tunnels,
		recordFilter: () => true,
	});
	return { service, store, stack };
}

// --- recording delegation stack ------------------------------------------------

export interface RecordingDelegationStackOptions extends FakeDelegationStackOptions {
	/** Team for tunnel registrations and guest billing. */
	teamId?: string;
	/** Transport for tunnel attachments. */
	tunnelTransport?: CloudTunnelTransport;
	/** Error thrown while `startFailures.count > 0`. */
	startFailureMessage?: string;
	/**
	 * Results client the service uses; defaults to the stack's never-ready
	 * one. `"guest-files"` leaves results to the service default, which
	 * imports them from the platform's guest results files.
	 */
	results?: CloudDelegationResultsClient | "guest-files";
}

/** The instrumented fake stack: every delegation client call is recorded. */
export interface RecordingDelegationStack {
	root: string;
	/** The recording platform used by commonOptions, spreadable for overrides. */
	platform: PrimeSandboxClient;
	calls: Array<{ kind: string; detail?: string }>;
	uploads: string[];
	startEnvs: Array<Record<string, string>>;
	startFailures: { count: number };
	deletedTunnels: string[];
	tunnelRegistration: CloudDelegationTunnelRegistration;
	commonOptions: DirectCloudServiceOptions;
	store: CloudSessionStore;
	resultStore: CloudResultStore;
	stack: ReturnType<typeof fakeDelegationStack>;
}

/**
 * The fake delegation stack wrapped with the instrumentation the direct
 * service suites assert on: client call kinds, upload paths, guest envs,
 * scripted start failures, and tunnel deletes.
 */
export function recordingDelegationStack(
	root: string,
	options: RecordingDelegationStackOptions = {},
): RecordingDelegationStack {
	const stateDirectory = join(root, "state");
	const store = new CloudSessionStore(join(stateDirectory, "sessions"));
	const resultStore = new CloudResultStore(join(stateDirectory, "results"));
	const stack = fakeDelegationStack(root, options);
	const calls: Array<{ kind: string; detail?: string }> = [];
	const uploads: string[] = [];
	const startEnvs: Array<Record<string, string>> = [];
	const startFailures = { count: 0 };
	const startFailureMessage = options.startFailureMessage ?? "simulated resident-process crash";
	const deletedTunnels: string[] = [];
	const tunnelRegistration: CloudDelegationTunnelRegistration = {
		tunnelId: "tun_test1",
		url: "https://tun-test1.tunnels.example.com",
		hostname: "tun-test1.tunnels.example.com",
		httpUser: "prime-agent",
		httpPassword: "edge-password-0123456789",
		expiresAt: "2099-01-01T00:00:00.000Z",
		frpServerHost: "frps.example.com",
		frpServerPort: 7000,
		frpToken: "frp-token",
		bindingSecret: "binding-secret",
	};
	const platform = {
		...stack.platform,
		createVmSandbox: async (request: PrimeSandboxVmCreateRequest) => {
			calls.push({ kind: "create" });
			return await stack.platform.createVmSandbox(request);
		},
		deleteSandbox: async (sandboxId: string) => {
			calls.push({ kind: "delete-sandbox" });
			await stack.platform.deleteSandbox(sandboxId);
		},
		uploadFile: async (sandboxId: string, request: PrimeSandboxUploadRequest) => {
			uploads.push(request.path);
			return await stack.platform.uploadFile(sandboxId, request);
		},
	} as unknown as PrimeSandboxClient;
	const workspace: CloudDelegationWorkspaceTransfer = {
		capture: async (request) => await stack.workspace.capture(request),
		upload: async (request) => {
			uploads.push(request.archivePath, request.manifestPath);
			await stack.workspace.upload(request);
		},
	};
	const process: CloudDelegationVmProcessClient = {
		start: async (request) => {
			if (startFailures.count > 0) {
				startFailures.count -= 1;
				throw new Error(startFailureMessage);
			}
			calls.push({ kind: "start" });
			startEnvs.push(request.env);
			return await stack.process.start(request);
		},
		signalStop: async (sessionUuid) => await stack.process.signalStop(sessionUuid),
		status: async (sessionUuid) => await stack.process.status(sessionUuid),
	};
	const tunnels: CloudDelegationTunnelClient = {
		register: async (request) => {
			calls.push({ kind: "register-tunnel", detail: request.teamId });
			return tunnelRegistration;
		},
		delete: async (tunnelId) => {
			deletedTunnels.push(tunnelId);
		},
		get: async (tunnelId) =>
			tunnelId === tunnelRegistration.tunnelId
				? {
						tunnelId,
						url: tunnelRegistration.url,
						hostname: tunnelRegistration.hostname,
						httpUser: tunnelRegistration.httpUser,
						expiresAt: tunnelRegistration.expiresAt,
					}
				: undefined,
	};
	const commonOptions: DirectCloudServiceOptions = {
		stateDirectory,
		apiKey: "platform-key",
		inferenceApiKey: "inference-only-key",
		dockerImage: "example/cloud:1",
		platform,
		store,
		resultStore,
		workspace,
		process,
		...(options.results === "guest-files" ? {} : { results: options.results ?? stack.results }),
		readiness: { isReady: async () => true },
		tunnels,
		monitorPollIntervalMs: 1,
		...(options.teamId === undefined ? {} : { teamId: options.teamId }),
		...(options.tunnelTransport === undefined ? {} : { tunnelTransport: options.tunnelTransport }),
	};
	return {
		root,
		platform,
		calls,
		uploads,
		startEnvs,
		startFailures,
		deletedTunnels,
		tunnelRegistration,
		commonOptions,
		store,
		resultStore,
		stack,
	};
}

// --- guest daemon ---------------------------------------------------------------

export const CLOUD_TEST_BRIDGE_TOKEN = "t".repeat(64);

export function cloudDaemonEnv(
	root: string,
	generation: number,
	sessionId: string,
	stateDir?: string,
	socketPath?: string,
	bridgeToken = CLOUD_TEST_BRIDGE_TOKEN,
): ReturnType<typeof parseCloudDaemonEnv> {
	const resolvedStateDir = stateDir ?? join(root, "guest-daemon-state");
	return parseCloudDaemonEnv(
		{
			PRIME_AGENT_CLOUD_DAEMON_SOCKET: socketPath ?? join(root, "guest.sock"),
			PRIME_AGENT_CLOUD_SESSION_ID: sessionId,
			PRIME_AGENT_CLOUD_GENERATION: String(generation),
			PRIME_AGENT_CLOUD_WORKSPACE_DIR: join(root, "workspace"),
			PRIME_AGENT_CLOUD_AGENT_DIR: join(root, "guest-agent"),
			PRIME_AGENT_CLOUD_BRIDGE_TOKEN: bridgeToken,
			PRIME_AGENT_CLOUD_PROMPT_PATH: join(root, "prompt.txt"),
			PRIME_AGENT_CLOUD_MODEL: "",
			PRIME_AGENT_CLOUD_DAEMON_STATE_DIR: resolvedStateDir,
		},
		{ stateDir: resolvedStateDir },
	);
}

/** Boot an in-process guest daemon with the faux runtime and its mirror loop. */
export async function startGuestDaemon(
	root: string,
	generation: number,
	sessionId: string,
	stateDir?: string,
	socketPath?: string,
) {
	const daemon = await CloudGuestDaemon.start(cloudDaemonEnv(root, generation, sessionId, stateDir, socketPath), {
		createRuntime: createFauxRuntimeFactory,
	});
	daemon.startMirrorLoop();
	return daemon;
}

// --- Prime Inference guest auth seed -------------------------------------------

/**
 * Stored Prime Inference credential plus a fresh private-entitlement cache
 * entry for `internal/glm-5.3-fast`, so the guest resolves the private route
 * from the cache exactly like a sandbox that already refreshed its team
 * entitlements - no network, no paid tokens.
 */
export function seedPrimeInferenceGuestAuth(root: string): void {
	const agentDir = join(root, "guest-agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify(
			{
				"prime-inference": {
					type: "api_key",
					key: "prime-key",
					primeTeam: { teamId: "engineering-team", name: "Prime Engineering" },
				},
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	// The registry caches authorized private routes per credential+team
	// fingerprint next to models.json (never the token, never re-derivable).
	// Main's scheme MACs the team with the bearer token; the seed must match it.
	const fingerprint = createHmac("sha256", "prime-key")
		.update("prime-agent:private-prime-authorization:v1\0")
		.update("engineering-team")
		.digest("hex");
	writeFileSync(
		join(agentDir, "prime-inference-private-models.json"),
		`${JSON.stringify({
			fingerprint,
			data: [
				{
					id: "internal/glm-5.3-fast",
					display_name: "GLM 5.3 Fast",
					pricing: {
						input_usd_per_mtok: 0,
						output_usd_per_mtok: 0,
						cache_read_usd_per_mtok: 0,
						cache_write_usd_per_mtok: 0,
					},
					specs: {
						context_window: 400_000,
						max_output_tokens: 131_072,
						modalities: { input: ["text"], output: ["text"] },
						supports_reasoning: true,
					},
				},
			],
			refreshedAt: Date.now(),
		})}\n`,
		{ mode: 0o600 },
	);
}
