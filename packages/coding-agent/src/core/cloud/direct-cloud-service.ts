import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnHidden, waitForChildProcess } from "../../utils/child-process.js";
import { findGitPaths } from "../../utils/git.js";
import { loadPrimeCliConfig } from "../prime-inference-auth.js";
import {
	type CloudGuestCursorRecord,
	CloudTunnelAttachment,
	type CloudTunnelAttachmentTarget,
} from "./bridge/tunnel-attachment.js";
import { CloudTunnelSecretStore } from "./bridge/tunnel-secrets.js";
import type { CloudTunnelTransport } from "./bridge/tunnel-transport.js";
import { WsTunnelTransport } from "./bridge/tunnel-transport.js";
import { type CloudSessionRecord, CloudSessionStore } from "./cloud-session-store.js";
import {
	CLOUD_GUEST_RESULTS_DIR,
	type CloudDelegationCapturedWorkspace,
	CloudDelegationOrchestrator,
	type CloudDelegationProgress,
	type CloudDelegationReadiness,
	type CloudDelegationResultsClient,
	type CloudDelegationTaskResult,
	type CloudDelegationTunnelClient,
	type CloudDelegationTunnelInfo,
	type CloudDelegationTunnelRegistration,
	type CloudDelegationTunnelRequest,
	type CloudDelegationVmProcessClient,
	type CloudDelegationVmProcessHandle,
	type CloudDelegationVmProcessStartRequest,
	type CloudDelegationVmProcessState,
	type CloudDelegationWorkspaceTransfer,
} from "./delegation-orchestrator.js";
import { type CloudOutboxEvent, DurableCloudEventOutbox } from "./event-outbox.js";
import {
	MAX_TRANSFER_BYTES,
	type PrimeSandbox,
	PrimeSandboxClient,
	PrimeSandboxError,
} from "./prime-sandbox-client.js";
import { PrimeTunnelClient } from "./prime-tunnel-client.js";
import type { CloudSessionStatus } from "./protocol.js";
import { CloudResultStore, decodeCloudResultPatch } from "./result-import.js";
import { DurableCloudTraceMirror } from "./trace-mirror.js";
import { VmProcessClient, VmProcessError, type VmProcessStream } from "./vm-process-client.js";
import { createWorkspaceSnapshot } from "./workspace-snapshot.js";

export interface DirectCloudDelegateOptions {
	instanceType?: string;
	model?: string;
	timeoutMinutes?: number;
	/** Opt in to a Prime Tunnel bridge for live steering; off by default. */
	tunnel?: boolean;
}

/** Live-steering result of a submitted command over the tunnel bridge. */
export interface DirectCloudSteerResult {
	delegation: DirectCloudDelegationSummary;
	commandId: string;
	state: "acknowledged" | "queued";
}

export interface DirectCloudDelegationSummary {
	id: string;
	activeSessionId: string;
	status: "preparing" | "provisioning" | "running" | "retrieving" | "completed" | "stopping" | "stopped" | "failed";
	createdAt: string;
	updatedAt: string;
	promptPreview: string;
	sandboxId?: string;
	/** Prime Tunnel registration when the delegation opted into live steering. */
	tunnel?: {
		tunnelId: string;
		url: string;
		attached: boolean;
	};
	/** Bounded tail of live output streamed over the tunnel bridge. */
	liveOutput?: string;
	resultReady: boolean;
	resultApplied: boolean;
	changedPaths?: string[];
	changedPathCount?: number;
	patchPreview?: string;
	patchTruncated?: boolean;
	outcome?: CloudDelegationTaskResult["outcome"];
	outputPreview?: string;
	stderrPreview?: string;
	error?: string;
}

export interface DirectCloudServiceOptions {
	stateDirectory: string;
	apiKey?: string;
	/** Credential exposed to the guest for inference only; never defaults to the platform control key. */
	inferenceApiKey?: string;
	baseUrl?: string;
	teamId?: string;
	dockerImage?: string;
	platform?: PrimeSandboxClient;
	store?: CloudSessionStore;
	resultStore?: CloudResultStore;
	process?: CloudDelegationVmProcessClient;
	workspace?: CloudDelegationWorkspaceTransfer;
	results?: CloudDelegationResultsClient;
	readiness?: CloudDelegationReadiness;
	/** Team the guest's inference requests bill to; defaults to the delegation team. */
	inferenceTeamId?: string;
	/** Prime Tunnel registration boundary; registers live-steering tunnels. */
	tunnels?: CloudDelegationTunnelClient;
	/** Durable per-session tunnel secrets; defaults to a 0600 store. */
	tunnelSecrets?: CloudTunnelSecretStore;
	/** WebSocket transport for tunnel attachments; defaults to the real client. */
	tunnelTransport?: CloudTunnelTransport;
	monitorPollIntervalMs?: number;
	/** Called before a cloud event acknowledgement advances. It must persist durably. */
	traceSink?: (activeSessionId: string, cloudSessionId: string, event: CloudOutboxEvent) => void | Promise<void>;
}

export interface DirectCloudDelegateRequest {
	activeSessionId: string;
	delegationId: string;
	cwd: string;
	prompt: string;
	options?: DirectCloudDelegateOptions;
	onProgress?: (progress: CloudDelegationProgress) => void;
}

const DEFAULT_BASE_URL = "https://api.primeintellect.ai";
const DEFAULT_CPU_CORES = 4;
const DEFAULT_MEMORY_GB = 16;
const DEFAULT_DISK_GB = 50;
const DEFAULT_TIMEOUT_MINUTES = 120;
const MAX_RESULT_TEXT_BYTES = 16 * 1024 * 1024;
/** Loopback port inside the sandbox that frpc forwards the tunnel edge to. */
export const CLOUD_TUNNEL_BRIDGE_PORT = 8740;
/** Bounded preview of the live output tail surfaced on delegation summaries. */
const MAX_LIVE_OUTPUT_CHARS = 4_000;
const TUNNEL_GUEST_CURSOR_FILE = "tunnel-guest-cursor.json";
const TUNNEL_GUEST_CURSOR_MAX_BYTES = 4_096;

/**
 * Cloud-scoped team override. The daemon bills sandboxes and registers
 * tunnels under this team when set, without touching the user's global Prime
 * CLI team selection.
 */
export function cloudTeamOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.PRIME_AGENT_CLOUD_TEAM_ID?.trim();
	return value === "" || value === undefined ? undefined : value;
}

/**
 * Team the guest's inference requests bill to (PRIME_TEAM_ID in the guest).
 * Defaults to the delegation team: without a team header the guest credential
 * bills its personal balance, which typically holds no funds and fails every
 * inference request with 402.
 */
export function cloudInferenceTeamOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.PRIME_AGENT_CLOUD_INFERENCE_TEAM_ID?.trim();
	return value === "" || value === undefined ? undefined : value;
}

/** Durable guest-cursor persistence for tunnel attachments (pre-ack). */
function saveTunnelGuestCursor(eventsDirectory: string, cursor: CloudGuestCursorRecord): void {
	const path = join(eventsDirectory, TUNNEL_GUEST_CURSOR_FILE);
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeSync(
			fd,
			`${JSON.stringify({ version: 2, ...cursor })}
`,
		);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
}

function loadTunnelGuestCursor(eventsDirectory: string): CloudGuestCursorRecord | undefined {
	const path = join(eventsDirectory, TUNNEL_GUEST_CURSOR_FILE);
	if (!existsSync(path)) return undefined;
	if (statSync(path).size > TUNNEL_GUEST_CURSOR_MAX_BYTES) {
		throw new Error("tunnel guest cursor file is too large");
	}
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<{
		version: number;
		generation: number;
		sandboxGeneration: number;
		eventGeneration: number;
		sequence: number;
	}>;
	const isGeneration = (candidate: unknown): candidate is number =>
		typeof candidate === "number" && Number.isInteger(candidate) && (candidate as number) >= 1;
	const isSequence = (candidate: unknown): candidate is number =>
		typeof candidate === "number" && Number.isInteger(candidate) && (candidate as number) >= 0;
	if (value.version === 2) {
		if (
			!isGeneration(value.sandboxGeneration) ||
			!isGeneration(value.eventGeneration) ||
			!isSequence(value.sequence)
		) {
			throw new Error("tunnel guest cursor file is corrupt");
		}
		return {
			sandboxGeneration: value.sandboxGeneration,
			eventGeneration: value.eventGeneration,
			sequence: value.sequence,
		};
	}
	if (value.version === 1) {
		// v1 recorded one generation (the event epoch, equal to the sandbox
		// generation until the first trim) and stays loadable: the position
		// resumes only while the epochs coincide, exactly as v1 did.
		if (!isGeneration(value.generation) || !isSequence(value.sequence)) {
			throw new Error("tunnel guest cursor file is corrupt");
		}
		return {
			sandboxGeneration: value.generation,
			eventGeneration: value.generation,
			sequence: value.sequence,
		};
	}
	throw new Error("tunnel guest cursor file is corrupt");
}

/** Adapter from the typed Prime Tunnel REST client to the orchestrator boundary. */
class ConcreteTunnels implements CloudDelegationTunnelClient {
	constructor(private readonly client: PrimeTunnelClient) {}

	async register(request: {
		sessionId: string;
		guestPort: number;
		name?: string;
		teamId?: string;
		labels?: string[];
		httpUser?: string;
	}): Promise<CloudDelegationTunnelRegistration> {
		const registration = await this.client.createTunnel({
			guestPort: request.guestPort,
			...(request.name === undefined ? {} : { name: request.name }),
			...(request.teamId === undefined ? {} : { teamId: request.teamId }),
			...(request.labels === undefined ? {} : { labels: request.labels }),
			...(request.httpUser === undefined ? {} : { httpUser: request.httpUser }),
		});
		return {
			tunnelId: registration.tunnelId,
			url: registration.url,
			hostname: registration.hostname,
			httpUser: registration.httpUser,
			expiresAt: registration.expiresAt,
			httpPassword: registration.httpPassword,
			frpServerHost: registration.serverHost,
			frpServerPort: registration.serverPort,
			frpToken: registration.frpToken,
			bindingSecret: registration.bindingSecret,
		};
	}

	async delete(tunnelId: string): Promise<void> {
		await this.client.deleteTunnel(tunnelId);
	}

	async get(tunnelId: string): Promise<CloudDelegationTunnelInfo | undefined> {
		const tunnel = await this.client.getTunnel(tunnelId);
		if (tunnel === undefined) return undefined;
		return {
			tunnelId: tunnel.tunnelId,
			url: tunnel.url,
			hostname: tunnel.hostname,
			httpUser: tunnel.httpUser ?? "",
			expiresAt: tunnel.expiresAt,
		};
	}
}

function boundedText(bytes: Uint8Array, label: string, maxBytes = MAX_RESULT_TEXT_BYTES, truncate = false): string {
	if (bytes.byteLength > maxBytes && !truncate) throw new Error(`${label} exceeds ${maxBytes} bytes`);
	return new TextDecoder("utf-8", { fatal: !truncate }).decode(bytes.subarray(0, maxBytes));
}

function isMissing(error: unknown): boolean {
	return (
		(error instanceof PrimeSandboxError &&
			(error.code === "sandbox_not_found" || (error.code === "http" && error.status === 404))) ||
		(error instanceof VmProcessError && (error.code === "not_found" || error.code === "failed_precondition"))
	);
}

class ConcreteWorkspaceTransfer implements CloudDelegationWorkspaceTransfer {
	constructor(private readonly platform: PrimeSandboxClient) {}

	async capture(request: { cwd: string }): Promise<CloudDelegationCapturedWorkspace> {
		const snapshot = await createWorkspaceSnapshot(request.cwd);
		const archivePath = join(snapshot.stagingDir, "workspace.tar");
		try {
			const child = spawnHidden("tar", ["-cf", archivePath, "-C", join(snapshot.stagingDir, "workspace"), "."], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
			});
			const code = await waitForChildProcess(child);
			if (code !== 0) throw new Error(`tar exited with code ${String(code)}: ${stderr.trim()}`);
			const archive = readFileSync(archivePath);
			const manifest = readFileSync(join(snapshot.stagingDir, "workspace-manifest.json"));
			return {
				baseline: {
					repoRoot: snapshot.repoRoot,
					headCommit: snapshot.headCommit,
					manifestDigest: `sha256:${snapshot.manifestDigest}`,
				},
				archive,
				manifest,
				totalSizeBytes: archive.byteLength + manifest.byteLength,
				cleanup: snapshot.cleanup,
			};
		} catch (error) {
			snapshot.cleanup();
			throw error;
		} finally {
			rmSync(archivePath, { force: true });
		}
	}

	async upload(request: {
		sandboxId: string;
		archivePath: string;
		manifestPath: string;
		captured: CloudDelegationCapturedWorkspace;
	}): Promise<void> {
		const auth = await this.platform.getSandboxAuth(request.sandboxId);
		await this.platform.uploadFile(
			request.sandboxId,
			{ path: request.archivePath, filename: "workspace.tar", content: request.captured.archive },
			{ auth },
		);
		await this.platform.uploadFile(
			request.sandboxId,
			{ path: request.manifestPath, filename: "workspace-manifest.json", content: request.captured.manifest },
			{ auth },
		);
	}
}

interface TrackedProcess {
	state: CloudDelegationVmProcessState;
	stream?: VmProcessStream;
}

class ConcreteVmProcesses implements CloudDelegationVmProcessClient {
	private readonly tracked = new Map<string, TrackedProcess>();

	constructor(
		private readonly platform: PrimeSandboxClient,
		private readonly store: CloudSessionStore,
	) {}

	async start(request: CloudDelegationVmProcessStartRequest): Promise<CloudDelegationVmProcessHandle> {
		const existing = this.tracked.get(request.sessionUuid);
		if (existing?.state.state === "running" || existing?.state.state === "starting") {
			return { sessionUuid: request.sessionUuid, created: false };
		}
		const client = this.client(request.sandboxId);
		const stream = await client.start({
			command: { cmd: request.command.executable, args: [...request.command.args], envs: request.env },
			stdin: false,
			sessionUuid: request.sessionUuid,
		});
		this.track(request.sessionUuid, stream);
		return { sessionUuid: request.sessionUuid, created: existing === undefined };
	}

	async signalStop(sessionUuid: string): Promise<void> {
		const sandboxId = this.sandboxIdFor(sessionUuid);
		if (sandboxId === undefined) return;
		try {
			await this.client(sandboxId).sendSignal(sessionUuid, "terminate");
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}

	async status(sessionUuid: string): Promise<CloudDelegationVmProcessState> {
		const existing = this.tracked.get(sessionUuid);
		if (existing !== undefined && existing.state.state !== "unknown") return existing.state;
		const sandboxId = this.sandboxIdFor(sessionUuid);
		if (sandboxId === undefined) return { state: "unknown" };
		try {
			const stream = await this.client(sandboxId).connect(sessionUuid);
			this.track(sessionUuid, stream);
			return this.tracked.get(sessionUuid)?.state ?? { state: "running" };
		} catch (error) {
			return isMissing(error) ? { state: "lost" } : Promise.reject(error);
		}
	}

	private sandboxIdFor(sessionUuid: string): string | undefined {
		return this.store.list().find((record) => record.residentProcessUuid === sessionUuid)?.sandboxId;
	}

	private client(sandboxId: string): VmProcessClient {
		let cached: Awaited<ReturnType<PrimeSandboxClient["getSandboxAuth"]>> | undefined;
		const auth = async () => {
			cached ??= await this.platform.getSandboxAuth(sandboxId);
			return cached;
		};
		return new VmProcessClient({
			auth: {
				getAuth: auth,
				refreshAuth: async () => {
					cached = await this.platform.getSandboxAuth(sandboxId);
					return cached;
				},
			},
		});
	}

	private track(sessionUuid: string, stream: VmProcessStream): void {
		const tracked: TrackedProcess = { state: { state: "running" }, stream };
		this.tracked.set(sessionUuid, tracked);
		void (async () => {
			try {
				for await (const event of stream) {
					if (event.kind === "end") {
						// The deployed end event may omit exit_code; unknown codes stay null.
						tracked.state = { state: "exited", exitCode: event.exitCode ?? null };
					}
				}
				const exit = await stream.exit;
				tracked.state = { state: "exited", exitCode: exit.exitCode ?? null };
			} catch {
				tracked.state = { state: "unknown" };
			}
		})();
	}
}

interface StoredDelegationInput {
	version: 1;
	sessionId: string;
	parentSessionId: string;
	cwd: string;
	prompt: string;
	model?: string;
	/** Persisted tunnel opt-in so crash recovery re-registers the bridge. */
	tunnel?: boolean;
	timeoutMinutes: number;
	baseline: CloudDelegationCapturedWorkspace["baseline"];
	totalSizeBytes: number;
	archiveDigest: string;
	manifestDigest: string;
}

class CloudDelegationInputStore {
	constructor(private readonly directory: string) {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		chmodSync(this.directory, 0o700);
	}

	save(
		sessionId: string,
		request: DirectCloudDelegateRequest,
		captured: CloudDelegationCapturedWorkspace,
		timeoutMinutes: number,
	): void {
		this.assertSessionId(sessionId);
		const existing = this.get(sessionId);
		if (existing) {
			this.assertMatches(existing.metadata, request, captured.baseline, timeoutMinutes);
			return;
		}
		const directory = join(this.directory, sessionId);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const archiveDigest = this.digest(captured.archive);
		const manifestDigest = this.digest(captured.manifest);
		this.atomicWrite(join(directory, "workspace.tar"), captured.archive);
		this.atomicWrite(join(directory, "workspace-manifest.json"), captured.manifest);
		const metadata: StoredDelegationInput = {
			version: 1,
			sessionId,
			parentSessionId: request.activeSessionId,
			cwd: request.cwd,
			prompt: request.prompt,
			...(request.options?.model ? { model: request.options.model } : {}),
			...(request.options?.tunnel ? { tunnel: true } : {}),
			timeoutMinutes,
			baseline: captured.baseline,
			totalSizeBytes: captured.totalSizeBytes,
			archiveDigest,
			manifestDigest,
		};
		// Metadata is the commit marker and lands after both byte payloads.
		this.atomicWrite(join(directory, "input.json"), `${JSON.stringify(metadata)}\n`);
	}

	get(sessionId: string): { metadata: StoredDelegationInput; captured: CloudDelegationCapturedWorkspace } | undefined {
		this.assertSessionId(sessionId);
		const directory = join(this.directory, sessionId);
		const metadataPath = join(directory, "input.json");
		if (!existsSync(metadataPath)) return undefined;
		if (statSync(metadataPath).size > MAX_RESULT_TEXT_BYTES)
			throw new Error(`Cloud input metadata is too large: ${sessionId}`);
		const value = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<StoredDelegationInput>;
		if (
			value.version !== 1 ||
			value.sessionId !== sessionId ||
			typeof value.parentSessionId !== "string" ||
			typeof value.cwd !== "string" ||
			typeof value.prompt !== "string" ||
			(value.model !== undefined && typeof value.model !== "string") ||
			(value.tunnel !== undefined && typeof value.tunnel !== "boolean") ||
			!Number.isInteger(value.timeoutMinutes) ||
			typeof value.totalSizeBytes !== "number" ||
			!value.baseline ||
			typeof value.archiveDigest !== "string" ||
			typeof value.manifestDigest !== "string"
		) {
			throw new Error(`Cloud delegation input is corrupt: ${sessionId}`);
		}
		const metadata = value as StoredDelegationInput;
		const archivePath = join(directory, "workspace.tar");
		const manifestPath = join(directory, "workspace-manifest.json");
		if (
			statSync(archivePath).size > MAX_TRANSFER_BYTES ||
			statSync(manifestPath).size > MAX_TRANSFER_BYTES ||
			statSync(archivePath).size + statSync(manifestPath).size > MAX_TRANSFER_BYTES
		) {
			throw new Error(`Cloud delegation input exceeds the transfer limit: ${sessionId}`);
		}
		const archive = readFileSync(archivePath);
		const manifest = readFileSync(manifestPath);
		if (this.digest(archive) !== metadata.archiveDigest || this.digest(manifest) !== metadata.manifestDigest) {
			throw new Error(`Cloud delegation input digest mismatch: ${sessionId}`);
		}
		return {
			metadata,
			captured: {
				baseline: metadata.baseline,
				archive,
				manifest,
				totalSizeBytes: metadata.totalSizeBytes,
				cleanup: () => {},
			},
		};
	}

	assertRequest(sessionId: string, request: DirectCloudDelegateRequest, timeoutMinutes: number): void {
		const existing = this.get(sessionId);
		if (!existing) return;
		this.assertMatches(existing.metadata, request, existing.metadata.baseline, timeoutMinutes);
	}

	private assertMatches(
		metadata: StoredDelegationInput,
		request: DirectCloudDelegateRequest,
		baseline: CloudDelegationCapturedWorkspace["baseline"],
		timeoutMinutes: number,
	): void {
		if (
			metadata.parentSessionId !== request.activeSessionId ||
			metadata.cwd !== request.cwd ||
			metadata.prompt !== request.prompt ||
			metadata.model !== request.options?.model ||
			(metadata.tunnel === true) !== (request.options?.tunnel === true) ||
			metadata.timeoutMinutes !== timeoutMinutes ||
			metadata.baseline.manifestDigest !== baseline.manifestDigest
		) {
			throw new Error(`Cloud delegation ${request.delegationId} was retried with different inputs`);
		}
	}

	private digest(value: Uint8Array): string {
		return `sha256:${createHash("sha256").update(value).digest("hex")}`;
	}

	private atomicWrite(path: string, contents: string | Uint8Array): void {
		const directory = dirname(path);
		const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		const fd = openSync(temporary, "wx", 0o600);
		try {
			if (typeof contents === "string") writeSync(fd, contents);
			else writeSync(fd, contents, 0, contents.byteLength);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		const directoryFd = openSync(directory, "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	}

	private assertSessionId(sessionId: string): void {
		if (!/^sess_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
			throw new Error("Invalid cloud session id for delegation input");
		}
	}
}

interface StoredTaskOutput {
	outcome: CloudDelegationTaskResult["outcome"];
	stdout: string;
	stderr: string;
	retrievedAt: string;
}

class CloudTaskOutputStore {
	constructor(private readonly directory: string) {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		chmodSync(this.directory, 0o700);
	}

	savePromptPreview(sessionId: string, prompt: string): void {
		this.assertSessionId(sessionId);
		const directory = join(this.directory, sessionId);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		this.atomicWrite(join(directory, "prompt-preview.txt"), prompt.slice(0, 120));
	}

	getPromptPreview(sessionId: string): string | undefined {
		this.assertSessionId(sessionId);
		const path = join(this.directory, sessionId, "prompt-preview.txt");
		if (!existsSync(path)) return undefined;
		if (statSync(path).size > 512) throw new Error(`Cloud prompt preview is too large: ${sessionId}`);
		return readFileSync(path, "utf8").slice(0, 120);
	}

	save(sessionId: string, result: CloudDelegationTaskResult): void {
		this.assertSessionId(sessionId);
		const directory = join(this.directory, sessionId);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		this.atomicWrite(
			join(directory, "result.json"),
			`${JSON.stringify({
				outcome: result.outcome,
				stdout: result.stdout,
				stderr: result.stderr,
				retrievedAt: result.retrievedAt,
			})}\n`,
		);
	}

	get(sessionId: string): StoredTaskOutput | undefined {
		this.assertSessionId(sessionId);
		const path = join(this.directory, sessionId, "result.json");
		if (!existsSync(path)) return undefined;
		if (statSync(path).size > MAX_RESULT_TEXT_BYTES * 2 + 1_048_576) {
			throw new Error(`Cloud task output is too large: ${sessionId}`);
		}
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredTaskOutput>;
		if (
			(value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "stopped") ||
			typeof value.stdout !== "string" ||
			typeof value.stderr !== "string" ||
			typeof value.retrievedAt !== "string"
		) {
			throw new Error(`Cloud task output is corrupt for ${sessionId}`);
		}
		return value as StoredTaskOutput;
	}

	private atomicWrite(path: string, contents: string): void {
		const directory = dirname(path);
		const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeSync(fd, contents);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		const directoryFd = openSync(directory, "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	}

	private assertSessionId(sessionId: string): void {
		if (!/^sess_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
			throw new Error("Invalid cloud session id for task output");
		}
	}
}

class PersistingResults implements CloudDelegationResultsClient {
	constructor(
		private readonly inner: CloudDelegationResultsClient,
		private readonly outputs: CloudTaskOutputStore,
	) {}

	fetch(sandboxId: string): Promise<CloudDelegationTaskResult | undefined> {
		return this.inner.fetch(sandboxId);
	}

	async save(request: { sessionId: string; result: CloudDelegationTaskResult }): Promise<void> {
		this.outputs.save(request.sessionId, request.result);
		await this.inner.save(request);
	}
}

class ConcreteResults implements CloudDelegationResultsClient {
	constructor(
		private readonly platform: PrimeSandboxClient,
		private readonly sessions: CloudSessionStore,
		private readonly results: CloudResultStore,
	) {}

	async fetch(sandboxId: string): Promise<CloudDelegationTaskResult | undefined> {
		let statusBytes: Uint8Array;
		try {
			statusBytes = await this.platform.downloadFile(sandboxId, `${CLOUD_GUEST_RESULTS_DIR}/status.txt`);
		} catch (error) {
			if (isMissing(error)) return undefined;
			throw error;
		}
		const status = boundedText(statusBytes, "cloud result status").trim();
		if (status !== "completed" && status !== "failed" && status !== "stopped") {
			throw new Error(`invalid cloud result outcome: ${status}`);
		}
		const [stdout, stderr, patch] = await Promise.all([
			this.platform.downloadFile(sandboxId, `${CLOUD_GUEST_RESULTS_DIR}/stdout.txt`),
			this.platform.downloadFile(sandboxId, `${CLOUD_GUEST_RESULTS_DIR}/stderr.txt`),
			this.platform.downloadFile(sandboxId, `${CLOUD_GUEST_RESULTS_DIR}/changes.patch`),
		]);
		return {
			outcome: status,
			stdout: boundedText(stdout, "cloud stdout", MAX_RESULT_TEXT_BYTES, true),
			stderr: boundedText(stderr, "cloud stderr", MAX_RESULT_TEXT_BYTES, true),
			patch,
			retrievedAt: new Date().toISOString(),
		};
	}

	async save(request: { sessionId: string; result: CloudDelegationTaskResult }): Promise<void> {
		const record = this.sessions.get(request.sessionId);
		if (record?.baseline === undefined) throw new Error("cloud session baseline is missing");
		// The patch keeps its exact bytes: git diff output is not guaranteed
		// UTF-8, and a lossy decode would corrupt the applied result.
		const patch = decodeCloudResultPatch(request.result.patch);
		if (request.result.outcome === "failed") {
			this.sessions.setLastError(request.sessionId, "the cloud agent exited with a failure");
		}
		if (patch.trim() === "") return;
		if (this.results.get(request.sessionId, "res_output") !== undefined) return;
		this.results.save({
			sessionId: request.sessionId,
			resultId: "res_output",
			patch,
			baselineManifestDigest: record.baseline.manifestDigest,
		});
	}
}

class ConcreteReadiness implements CloudDelegationReadiness {
	constructor(private readonly platform: PrimeSandboxClient) {}
	async isReady(sandbox: PrimeSandbox): Promise<boolean> {
		if (sandbox.status !== "RUNNING") return false;
		try {
			await this.platform.getSandboxAuth(sandbox.id);
			return true;
		} catch {
			return false;
		}
	}
}

function cloudStatusForProgress(phase: CloudDelegationProgress["phase"]): CloudSessionStatus {
	switch (phase) {
		case "capturing":
		case "allocating":
		case "provisioning":
		case "waiting":
		case "uploading":
		case "starting":
			return "starting";
		case "running":
			return "busy";
		case "retrieving":
		case "review":
			return "idle";
		case "released":
			return "stopped";
		case "lost":
			return "failed";
	}
}

/**
 * Resolution of the guest-scoped cloud inference credential.
 *
 * The credential never needs to live in a shell profile or command history:
 * `PRIME_AGENT_CLOUD_INFERENCE_API_KEY_FILE` (default
 * `~/.config/prime-agent-cloud/inference-api-key`) loads it from a local key
 * file that must be a regular, non-symlink file readable only by the owner.
 * `PRIME_AGENT_CLOUD_INFERENCE_API_KEY` remains an explicit override.
 */
export interface CloudInferenceCredentialResolution {
	/** The guest-scoped credential when one was resolved. */
	credential?: string;
	/** Human-readable reason when no credential was resolved. */
	problem?: string;
}

/** Key-file path used for the cloud inference credential. */
export function cloudInferenceKeyFilePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const explicit = env.PRIME_AGENT_CLOUD_INFERENCE_API_KEY_FILE?.trim();
	if (explicit !== undefined && explicit !== "") return explicit;
	return join(home, ".config", "prime-agent-cloud", "inference-api-key");
}

const CLOUD_INFERENCE_CREDENTIAL_MAX_CHARS = 8192;

/**
 * Shared loader for capability gating and {@link DirectCloudService}. An
 * insecure file fails closed: it never yields a credential, and the reason
 * explains what to fix.
 */
export function resolveCloudInferenceCredential(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): CloudInferenceCredentialResolution {
	const fromEnv = env.PRIME_AGENT_CLOUD_INFERENCE_API_KEY?.trim();
	if (fromEnv !== undefined && fromEnv !== "") return { credential: fromEnv };
	const path = cloudInferenceKeyFilePath(env, home);
	if (!isAbsolute(path)) {
		return { problem: "PRIME_AGENT_CLOUD_INFERENCE_API_KEY_FILE must be an absolute path" };
	}
	let stat: Stats;
	try {
		// lstat so a symlink is rejected by its own type, never followed.
		stat = lstatSync(path);
	} catch {
		return {
			problem: `no cloud inference credential configured: set PRIME_AGENT_CLOUD_INFERENCE_API_KEY or create ${path}`,
		};
	}
	if (!stat.isFile()) {
		return { problem: `cloud inference key file ${path} is not a regular file` };
	}
	if ((stat.mode & 0o077) !== 0) {
		return { problem: `cloud inference key file ${path} must be readable only by its owner (chmod 600)` };
	}
	if (stat.size > CLOUD_INFERENCE_CREDENTIAL_MAX_CHARS) {
		return { problem: `cloud inference key file ${path} is too large` };
	}
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch {
		return { problem: `cloud inference key file ${path} is not readable` };
	}
	const credential = contents.trim();
	if (credential === "" || credential.includes("\0") || /\n|\r/.test(credential)) {
		return { problem: `cloud inference key file ${path} must hold one single-line key` };
	}
	return { credential };
}

export function isDirectCloudConfigured(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
	if (!env.PRIME_AGENT_CLOUD_IMAGE?.trim()) return false;
	return resolveCloudInferenceCredential(env, home).credential !== undefined;
}

export class DirectCloudService {
	readonly store: CloudSessionStore;
	readonly resultStore: CloudResultStore;
	readonly platform: PrimeSandboxClient;
	private readonly inputStore: CloudDelegationInputStore;
	private readonly outputStore: CloudTaskOutputStore;
	private readonly stateDirectory: string;
	private readonly traceSink: (
		activeSessionId: string,
		cloudSessionId: string,
		event: CloudOutboxEvent,
	) => void | Promise<void>;
	private readonly monitors = new Map<string, Promise<void>>();
	private readonly operationTails = new Map<string, Promise<void>>();
	private readonly monitorPollIntervalMs: number;
	private readonly process: CloudDelegationVmProcessClient;
	private readonly workspace: CloudDelegationWorkspaceTransfer;
	private readonly results: CloudDelegationResultsClient;
	private readonly readiness: CloudDelegationReadiness;
	private readonly inferenceApiKey: string;
	private readonly dockerImage: string;
	private readonly teamId: string | undefined;
	/** Team the guest's inference requests bill to. */
	private readonly inferenceTeamId: string | undefined;
	private readonly tunnels: CloudDelegationTunnelClient | undefined;
	private readonly tunnelSecrets: CloudTunnelSecretStore;
	private readonly tunnelTransport: CloudTunnelTransport;
	private readonly attachments = new Map<string, CloudTunnelAttachment>();

	constructor(options: DirectCloudServiceOptions) {
		this.stateDirectory = options.stateDirectory;
		this.monitorPollIntervalMs = options.monitorPollIntervalMs ?? 2_000;
		if (!Number.isInteger(this.monitorPollIntervalMs) || this.monitorPollIntervalMs < 1) {
			throw new Error("monitorPollIntervalMs must be a positive integer");
		}
		this.traceSink =
			options.traceSink ??
			((activeSessionId, cloudSessionId, event) => this.persistDefaultTrace(activeSessionId, cloudSessionId, event));
		const config = loadPrimeCliConfig();
		const apiKey = options.apiKey ?? process.env.PRIME_API_KEY ?? config.apiKey;
		if (!apiKey) throw new Error("Cloud delegation requires PRIME_API_KEY or a logged-in Prime CLI");
		const dockerImage = options.dockerImage ?? process.env.PRIME_AGENT_CLOUD_IMAGE;
		if (!dockerImage) throw new Error("Cloud delegation requires PRIME_AGENT_CLOUD_IMAGE");
		const resolved =
			options.inferenceApiKey === undefined
				? resolveCloudInferenceCredential()
				: { credential: options.inferenceApiKey };
		const inferenceApiKey = resolved.credential;
		if (inferenceApiKey === undefined) {
			throw new Error(
				`Cloud delegation requires a guest-scoped inference credential: ${resolved.problem ?? "none configured"}`,
			);
		}
		this.inferenceApiKey = inferenceApiKey;
		this.dockerImage = dockerImage;
		this.teamId = options.teamId ?? cloudTeamOverride() ?? config.teamId;
		this.inferenceTeamId = options.inferenceTeamId ?? cloudInferenceTeamOverride() ?? this.teamId;
		this.store = options.store ?? new CloudSessionStore(join(options.stateDirectory, "sessions"));
		this.resultStore = options.resultStore ?? new CloudResultStore(join(options.stateDirectory, "results"));
		this.inputStore = new CloudDelegationInputStore(join(options.stateDirectory, "inputs"));
		this.outputStore = new CloudTaskOutputStore(join(options.stateDirectory, "outputs"));
		this.tunnelSecrets =
			options.tunnelSecrets ?? new CloudTunnelSecretStore(join(options.stateDirectory, "tunnel-secrets"));
		this.tunnelTransport = options.tunnelTransport ?? new WsTunnelTransport();
		this.tunnels =
			options.tunnels ??
			new ConcreteTunnels(
				new PrimeTunnelClient({
					apiKey,
					baseUrl: options.baseUrl ?? config.baseUrl ?? DEFAULT_BASE_URL,
				}),
			);
		this.platform =
			options.platform ??
			new PrimeSandboxClient({
				apiKey,
				baseUrl: options.baseUrl ?? config.baseUrl ?? DEFAULT_BASE_URL,
				teamId: this.teamId,
			});
		this.process = options.process ?? new ConcreteVmProcesses(this.platform, this.store);
		this.workspace = options.workspace ?? new ConcreteWorkspaceTransfer(this.platform);
		const results = options.results ?? new ConcreteResults(this.platform, this.store, this.resultStore);
		this.results = new PersistingResults(results, this.outputStore);
		this.readiness = options.readiness ?? new ConcreteReadiness(this.platform);
	}

	async delegate(request: DirectCloudDelegateRequest): Promise<DirectCloudDelegationSummary> {
		return await this.withOperationLock(request.delegationId, () => this.delegateUnlocked(request));
	}

	private async delegateUnlocked(request: DirectCloudDelegateRequest): Promise<DirectCloudDelegationSummary> {
		if (!request.prompt.trim()) throw new Error("Cloud delegation prompt must not be empty");
		if (request.options?.instanceType) {
			throw new Error("Cloud instanceType selection is not supported by the current Sandbox API");
		}
		const timeoutMinutes = request.options?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
		let stored = this.inputStore.get(request.delegationId);
		let captured: CloudDelegationCapturedWorkspace;
		if (stored) {
			this.inputStore.assertRequest(request.delegationId, request, timeoutMinutes);
			captured = stored.captured;
		} else {
			captured = await this.workspace.capture({ cwd: request.cwd });
			try {
				this.inputStore.save(request.delegationId, request, captured, timeoutMinutes);
				stored = this.inputStore.get(request.delegationId);
				if (!stored) throw new Error(`Cloud delegation input was not persisted: ${request.delegationId}`);
			} catch (error) {
				captured.cleanup();
				throw error;
			}
		}
		let traceSessionId: string | undefined;
		const onProgress = (progress: CloudDelegationProgress) => {
			if (traceSessionId === undefined) this.outputStore.savePromptPreview(progress.sessionId, request.prompt);
			traceSessionId = progress.sessionId;
			this.recordProgress(request.activeSessionId, progress);
			request.onProgress?.(progress);
		};
		try {
			const tunnel: CloudDelegationTunnelRequest | undefined =
				request.options?.tunnel === true
					? {
							bridgeToken: randomBytes(32).toString("hex"),
							guestPort: CLOUD_TUNNEL_BRIDGE_PORT,
							...(this.teamId === undefined ? {} : { teamId: this.teamId }),
						}
					: undefined;
			const handle = await this.orchestrator(onProgress).delegate({
				sessionId: request.delegationId,
				parentSessionId: request.activeSessionId,
				prompt: request.prompt,
				cwd: request.cwd,
				capturedWorkspace: captured,
				model: request.options?.model,
				sandbox: {
					dockerImage: this.dockerImage,
					cpuCores: DEFAULT_CPU_CORES,
					memoryGb: DEFAULT_MEMORY_GB,
					diskSizeGb: DEFAULT_DISK_GB,
					timeoutMinutes,
					idleTimeoutMinutes: timeoutMinutes,
				},
				inferenceCredential: this.inferenceApiKey,
				...(this.inferenceTeamId === undefined ? {} : { inferenceTeamId: this.inferenceTeamId }),
				...(tunnel === undefined ? {} : { tunnel }),
			});
			this.startResultMonitor(request.activeSessionId, handle.record.sessionId);
			if (tunnel !== undefined) this.ensureAttachment(request.activeSessionId, handle.record.sessionId);
			return this.summary(handle.record, request.prompt);
		} finally {
			if (traceSessionId) await this.safeFlushTrace(request.activeSessionId, traceSessionId);
		}
	}

	/** Live-steer one running tunnel delegation; requires an active bridge. */
	async steer(
		activeSessionId: string,
		sessionId: string,
		text: string,
		steerId?: string,
	): Promise<DirectCloudSteerResult> {
		return await this.withOperationLock(sessionId, () =>
			this.steerUnlocked(activeSessionId, sessionId, text, steerId),
		);
	}

	private async steerUnlocked(
		activeSessionId: string,
		sessionId: string,
		text: string,
		steerId?: string,
	): Promise<DirectCloudSteerResult> {
		const record = this.owned(activeSessionId, sessionId);
		if (!record.tunnel || record.tunnelState !== "registered") {
			throw new Error(`Cloud delegation ${sessionId} has no live tunnel bridge; rerun it with --tunnel`);
		}
		if (text.trim() === "") throw new Error("steer text must not be empty");
		const attachment = this.ensureAttachment(activeSessionId, sessionId);
		// The identity is caller-supplied when it exists: a retried daemon
		// command must map to the same command id and request digest, so the
		// guest journal deduplicates instead of running the steer twice.
		const identity = steerId ?? randomUUID();
		const commandId = `cmd_${identity}`;
		const outcome = await attachment.submit(commandId, { kind: "steer", text });
		const current = this.owned(activeSessionId, sessionId);
		return {
			delegation: this.summary(current),
			commandId,
			state: outcome.state === "acknowledged" ? "acknowledged" : "queued",
		};
	}

	async list(activeSessionId: string): Promise<DirectCloudDelegationSummary[]> {
		const records = this.store.list().filter((record) => record.parentSessionId === activeSessionId);
		for (const record of records) {
			try {
				await this.withOperationLock(record.sessionId, async () => {
					if (record.observedLifecycle === "provisioning" && record.desiredLifecycle === "provisioning") {
						await this.resumePending(record);
					}
					await this.refresh(this.store.get(record.sessionId) ?? record);
					await this.cleanupRetrieved(this.store.get(record.sessionId) ?? record);
					const current = this.store.get(record.sessionId) ?? record;
					this.recordStatus(activeSessionId, current.sessionId, this.statusForRecord(current));
					await this.safeFlushTrace(activeSessionId, current.sessionId);
					// Durable attachment resume: a restarted daemon re-attaches running tunnels.
					if (this.isSteerable(current) && !this.attachments.has(current.sessionId)) {
						this.ensureAttachment(activeSessionId, current.sessionId);
					}
				});
			} catch (error) {
				this.store.setLastError(
					record.sessionId,
					`status refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return records.map((record) => this.summary(this.store.get(record.sessionId) ?? record));
	}

	async stop(activeSessionId: string, sessionId: string, forfeit = false): Promise<DirectCloudDelegationSummary> {
		return await this.withOperationLock(sessionId, () => this.stopUnlocked(activeSessionId, sessionId, forfeit));
	}

	private async stopUnlocked(
		activeSessionId: string,
		sessionId: string,
		forfeit = false,
	): Promise<DirectCloudDelegationSummary> {
		const record = this.owned(activeSessionId, sessionId);
		const onProgress = (progress: CloudDelegationProgress) => this.recordProgress(activeSessionId, progress);
		try {
			const handle = forfeit
				? await this.orchestrator(onProgress).forfeit(record.sessionId)
				: await this.orchestrator(onProgress).stop(record.sessionId);
			await this.releaseTunnel(this.owned(activeSessionId, sessionId));
			return this.summary(handle.record);
		} finally {
			await this.safeFlushTrace(activeSessionId, sessionId);
		}
	}

	async apply(activeSessionId: string, sessionId: string, cwd: string): Promise<DirectCloudDelegationSummary> {
		return await this.withOperationLock(sessionId, () => this.applyUnlocked(activeSessionId, sessionId, cwd));
	}

	private async applyUnlocked(
		activeSessionId: string,
		sessionId: string,
		cwd: string,
	): Promise<DirectCloudDelegationSummary> {
		let record = this.owned(activeSessionId, sessionId);
		if (record.resultImportState === "skipped") {
			throw new Error(`Cloud delegation ${sessionId} was forfeited and cannot be applied`);
		}
		if (
			record.resultImportState === "imported" &&
			record.cleanupState === "released" &&
			record.observedLifecycle === "deleted"
		) {
			return this.summary(record);
		}
		await this.refresh(record);
		record = this.owned(activeSessionId, sessionId);
		if (record.resultImportState === "skipped") {
			throw new Error(`Cloud delegation ${sessionId} was forfeited and cannot be applied`);
		}
		const targetRepository = findGitPaths(cwd)?.repoDir;
		if (
			!record.baseline ||
			!targetRepository ||
			realpathSync(targetRepository) !== realpathSync(record.baseline.repoRoot)
		) {
			throw new Error(`Cloud delegation ${sessionId} can only be applied to its captured repository`);
		}
		const output = this.outputStore.get(sessionId);
		if (!output && record.resultImportState !== "available" && record.resultImportState !== "imported") {
			throw new Error(`Cloud delegation ${sessionId} has no retrieved result to apply`);
		}
		const result = this.resultStore.get(sessionId, "res_output");
		if (result !== undefined && result.patchSizeBytes > 0 && result.state !== "applied") {
			const applied = await this.resultStore.apply(sessionId, result.resultId, { cwd });
			if (!applied.applied) throw new Error(applied.error);
		}
		if (record.resultImportState !== "imported") this.store.setResultImportState(sessionId, "imported");
		record = this.owned(activeSessionId, sessionId);
		if (record.cleanupState !== "released") {
			if (record.cleanupState !== "releasing") this.store.setCleanupState(sessionId, "releasing");
			await this.releaseTunnel(record);
			if (record.sandboxId) {
				try {
					await this.platform.deleteSandbox(record.sandboxId);
				} catch (error) {
					if (!isMissing(error)) throw error;
				}
			}
			this.store.setCleanupState(sessionId, "released");
		}
		if (record.desiredLifecycle !== "deleted") this.store.setDesiredLifecycle(sessionId, "deleted");
		if (record.observedLifecycle !== "deleted") this.store.setObservedLifecycle(sessionId, "deleted");
		this.recordStatus(activeSessionId, sessionId, "stopped");
		await this.safeFlushTrace(activeSessionId, sessionId);
		return this.summary(this.owned(activeSessionId, sessionId));
	}

	private async withOperationLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.operationTails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => {}).then(() => current);
		this.operationTails.set(sessionId, tail);
		await previous.catch(() => {});
		try {
			return await operation();
		} finally {
			release();
			if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId);
		}
	}

	/**
	 * Ensure the tunnel attachment supervisor for one session is running.
	 * Durable across daemon restarts: the record, secrets, and guest cursor all
	 * live on disk, so `list()` re-attaches a running delegation.
	 */
	private ensureAttachment(activeSessionId: string, sessionId: string): CloudTunnelAttachment {
		const existing = this.attachments.get(sessionId);
		if (existing !== undefined) return existing;
		const eventsDirectory = join(this.stateDirectory, "events", sessionId);
		const attachment = new CloudTunnelAttachment({
			sessionId,
			generation: this.store.get(sessionId)?.generation ?? 1,
			transport: this.tunnelTransport,
			callbacks: {
				resolveTarget: (): CloudTunnelAttachmentTarget | undefined => {
					const record = this.store.get(sessionId);
					if (record?.tunnel === undefined || record.tunnelState !== "registered" || !this.isSteerable(record)) {
						return undefined;
					}
					const secrets = this.tunnelSecrets.get(sessionId);
					if (secrets === undefined) return undefined;
					return {
						url: record.tunnel.url,
						httpUser: record.tunnel.httpUser,
						httpPassword: secrets.httpPassword,
						bridgeToken: secrets.bridgeToken,
					};
				},
				appendGuestEvent: (event) => {
					const outbox = new DurableCloudEventOutbox({ directory: eventsDirectory, sessionId });
					outbox.append(event);
				},
				flushTrace: () => this.safeFlushTrace(activeSessionId, sessionId),
				persistGuestCursor: (cursor) => saveTunnelGuestCursor(eventsDirectory, cursor),
				loadGuestCursor: () => loadTunnelGuestCursor(eventsDirectory),
				recordAttachment: (attachmentUuid) => {
					if (this.store.get(sessionId)) this.store.recordAttachment(sessionId, attachmentUuid);
				},
				isSessionLive: () => {
					const record = this.store.get(sessionId);
					return record !== undefined && this.isSteerable(record);
				},
				checkTunnelAlive: async () => {
					const record = this.store.get(sessionId);
					if (record?.tunnel === undefined || this.tunnels === undefined) return false;
					return (await this.tunnels.get(record.tunnel.tunnelId)) !== undefined;
				},
				onAttachmentError: (message) => {
					if (this.store.get(sessionId)) this.store.setLastError(sessionId, message);
				},
				onTerminal: (reason) => {
					const record = this.store.get(sessionId);
					if (record === undefined) return;
					this.store.setLastError(sessionId, `tunnel bridge stopped: ${reason}`);
					if (record.tunnelState === "registered" && record.tunnel !== undefined) {
						// The supervisor is terminal and nothing else will
						// release the registration: delete it before forgetting
						// the tunnel. Fire-and-forget because this callback runs
						// on the attachment's own loop, which must not await its
						// own stop.
						const tunnelId = record.tunnel.tunnelId;
						void this.tunnels?.delete(tunnelId).catch(() => {
							// An unreachable platform cannot keep the tunnel
							// alive locally; the state is terminal either way.
						});
					}
					if (record.tunnelState !== "released") this.store.setTunnelState(sessionId, "released");
					this.tunnelSecrets.delete(sessionId);
					this.attachments.delete(sessionId);
				},
			},
		});
		this.attachments.set(sessionId, attachment);
		attachment.start();
		return attachment;
	}

	/** True while the delegation can still accept steering over its tunnel. */
	private isSteerable(record: CloudSessionRecord): boolean {
		return (
			record.tunnel !== undefined &&
			record.tunnelState === "registered" &&
			record.resultImportState === "pending" &&
			(record.observedLifecycle === "running" || record.observedLifecycle === "provisioning") &&
			(record.desiredLifecycle === "running" || record.desiredLifecycle === "provisioning") &&
			record.cleanupState !== "releasing" &&
			record.cleanupState !== "released"
		);
	}

	/** Release the tunnel: stop the attachment, delete the registration, clear secrets. */
	private async releaseTunnel(record: CloudSessionRecord): Promise<void> {
		const attachment = this.attachments.get(record.sessionId);
		if (attachment !== undefined) {
			await attachment.stop();
			this.attachments.delete(record.sessionId);
		}
		if (record.tunnel !== undefined && record.tunnelState === "registered") {
			try {
				await this.tunnels?.delete(record.tunnel.tunnelId);
			} catch (error) {
				this.store.setLastError(
					record.sessionId,
					`tunnel release failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			try {
				this.store.setTunnelState(record.sessionId, "released");
			} catch {
				// Terminal state conflicts are benign here.
			}
		}
		this.tunnelSecrets.delete(record.sessionId);
	}

	private startResultMonitor(activeSessionId: string, sessionId: string): void {
		if (this.monitors.has(sessionId)) return;
		const monitor = this.monitorResults(activeSessionId, sessionId)
			.catch((error) => {
				if (this.store.get(sessionId)) {
					this.store.setLastError(
						sessionId,
						`background result monitor stopped: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			})
			.finally(() => {
				if (this.monitors.get(sessionId) === monitor) this.monitors.delete(sessionId);
			});
		this.monitors.set(sessionId, monitor);
	}

	private async cleanupRetrieved(record: CloudSessionRecord): Promise<void> {
		if (
			record.resultImportState === "pending" ||
			record.resultImportState === "skipped" ||
			record.cleanupState === "released" ||
			!record.sandboxId
		) {
			return;
		}
		if (record.cleanupState !== "releasing") this.store.setCleanupState(record.sessionId, "releasing");
		try {
			await this.releaseTunnel(record);
			await this.platform.deleteSandbox(record.sandboxId);
		} catch (error) {
			this.store.setCleanupState(record.sessionId, "failed");
			throw error;
		}
		this.store.setCleanupState(record.sessionId, "released");
		this.store.setObservedLifecycle(record.sessionId, "deleted");
		this.store.setDesiredLifecycle(record.sessionId, "deleted");
	}

	private async monitorResults(activeSessionId: string, sessionId: string): Promise<void> {
		for (;;) {
			const record = this.store.get(sessionId);
			if (!record || record.observedLifecycle === "deleted" || record.observedLifecycle === "lost") return;
			try {
				await this.withOperationLock(sessionId, async () => {
					const current = this.store.get(sessionId) ?? record;
					if (current.resultImportState === "pending") await this.refresh(current);
					await this.cleanupRetrieved(this.store.get(sessionId) ?? current);
				});
				const current = this.store.get(sessionId);
				if (current && current.resultImportState !== "pending") {
					this.recordStatus(activeSessionId, sessionId, this.statusForRecord(current));
					await this.safeFlushTrace(activeSessionId, sessionId);
					return;
				}
			} catch (error) {
				this.store.setLastError(
					sessionId,
					`background result retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const deadline = this.store.get(sessionId)?.deadlineAt;
			if (deadline && Date.parse(deadline) <= Date.now()) return;
			await new Promise<void>((resolveDelay) => {
				const timer = setTimeout(resolveDelay, this.monitorPollIntervalMs);
				timer.unref?.();
			});
		}
	}

	private statusForRecord(record: CloudSessionRecord): CloudSessionStatus {
		if (record.observedLifecycle === "lost") return "failed";
		if (record.observedLifecycle === "deleted" || record.observedLifecycle === "stopped") return "stopped";
		if (record.desiredLifecycle === "stopping") return "stopping";
		if (record.resultImportState !== "pending") return "idle";
		if (record.observedLifecycle === "running") return "busy";
		return "starting";
	}

	private recordProgress(activeSessionId: string, progress: CloudDelegationProgress): void {
		try {
			this.recordStatus(activeSessionId, progress.sessionId, cloudStatusForProgress(progress.phase));
		} catch (error) {
			const record = this.store.get(progress.sessionId);
			if (record) {
				this.store.setLastError(
					progress.sessionId,
					`cloud event persistence failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private recordStatus(_activeSessionId: string, sessionId: string, status: CloudSessionStatus): void {
		const outbox = new DurableCloudEventOutbox({
			directory: join(this.stateDirectory, "events", sessionId),
			sessionId,
		});
		outbox.append({ kind: "session_status", recordedAt: new Date().toISOString(), status });
		if (this.store.get(sessionId)) this.store.advanceEventCursor(sessionId, outbox.tailCursor);
	}

	private async flushTrace(activeSessionId: string, sessionId: string): Promise<void> {
		const outbox = new DurableCloudEventOutbox({
			directory: join(this.stateDirectory, "events", sessionId),
			sessionId,
		});
		const mirror = new DurableCloudTraceMirror({
			directory: join(this.stateDirectory, "trace-mirrors", sessionId),
			sessionId,
			sink: {
				persistCloudEvent: (event) => Promise.resolve(this.traceSink(activeSessionId, sessionId, event)),
			},
		});
		const cursor = mirror.cursor ?? { generation: outbox.generation, sequence: 0 };
		const acknowledgement = await mirror.import(outbox.eventsAfter(cursor));
		if (!acknowledgement) return;
		outbox.ack(acknowledgement.cursor);
		if (this.store.get(sessionId)) {
			this.store.advanceEventCursor(sessionId, outbox.tailCursor);
			this.store.advanceAckCursor(sessionId, acknowledgement.cursor);
		}
	}

	private async safeFlushTrace(activeSessionId: string, sessionId: string): Promise<void> {
		try {
			await this.flushTrace(activeSessionId, sessionId);
		} catch (error) {
			if (this.store.get(sessionId)) {
				this.store.setLastError(
					sessionId,
					`cloud trace mirroring failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private persistDefaultTrace(activeSessionId: string, cloudSessionId: string, event: CloudOutboxEvent): void {
		const directory = join(this.stateDirectory, "traces");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, "cloud-events.ndjson");
		const fd = openSync(path, "a", 0o600);
		try {
			writeSync(fd, `${JSON.stringify({ activeSessionId, cloudSessionId, event })}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const directoryFd = openSync(directory, "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	}

	private async resumePending(record: CloudSessionRecord): Promise<void> {
		const stored = this.inputStore.get(record.sessionId);
		if (!stored) throw new Error(`Cloud delegation input is unavailable for recovery: ${record.sessionId}`);
		await this.delegateUnlocked({
			activeSessionId: record.parentSessionId ?? stored.metadata.parentSessionId,
			delegationId: record.sessionId,
			cwd: stored.metadata.cwd,
			prompt: stored.metadata.prompt,
			options: {
				...(stored.metadata.model ? { model: stored.metadata.model } : {}),
				...(stored.metadata.tunnel ? { tunnel: true } : {}),
				timeoutMinutes: stored.metadata.timeoutMinutes,
			},
		});
	}

	private async refresh(record: CloudSessionRecord): Promise<void> {
		if (
			!record.sandboxId ||
			record.observedLifecycle === "deleted" ||
			record.resultImportState === "available" ||
			record.resultImportState === "imported"
		)
			return;
		let result = await this.results.fetch(record.sandboxId);
		if (result !== undefined) {
			await this.importTerminalResult(record, result);
			return;
		}

		let sandbox: PrimeSandbox;
		try {
			sandbox = await this.platform.getSandbox(record.sandboxId);
		} catch (error) {
			if (!isMissing(error)) throw error;
			this.store.setObservedLifecycle(record.sessionId, "lost");
			this.store.setLastError(
				record.sessionId,
				"the cloud sandbox no longer exists and no terminal result was found",
			);
			await this.releaseTunnel(record);
			return;
		}
		this.store.setSandbox(record.sessionId, sandbox.id, sandbox.status);
		if (sandbox.status === "ERROR" || sandbox.status === "TERMINATED" || sandbox.status === "TIMEOUT") {
			this.store.setObservedLifecycle(record.sessionId, "lost");
			this.store.setLastError(record.sessionId, `the cloud sandbox ended with status ${sandbox.status}`);
			return;
		}
		if (sandbox.status !== "RUNNING") return;

		const processState = await this.process.status(record.residentProcessUuid);
		if (processState.state === "lost") {
			this.store.setObservedLifecycle(record.sessionId, "lost");
			this.store.setLastError(record.sessionId, "the cloud agent process could not be reattached");
			await this.releaseTunnel(record);
			return;
		}
		if (processState.state !== "exited") return;
		result = await this.results.fetch(record.sandboxId);
		if (result !== undefined) {
			await this.importTerminalResult(record, result);
			return;
		}
		this.store.setObservedLifecycle(record.sessionId, "stopped");
		this.store.setLastError(record.sessionId, "the cloud agent exited without a terminal result");
	}

	private async importTerminalResult(record: CloudSessionRecord, result: CloudDelegationTaskResult): Promise<void> {
		await this.results.save({ sessionId: record.sessionId, result });
		this.store.setResultImportState(record.sessionId, "available");
		this.store.setCleanupState(record.sessionId, "imported");
		this.store.setObservedLifecycle(record.sessionId, "stopped");
		this.store.setDesiredLifecycle(record.sessionId, "stopping");
	}

	private owned(activeSessionId: string, sessionId: string): CloudSessionRecord {
		const record = this.store.get(sessionId);
		if (!record || record.parentSessionId !== activeSessionId)
			throw new Error(`Unknown cloud delegation: ${sessionId}`);
		return record;
	}

	private orchestrator(onProgress?: (progress: CloudDelegationProgress) => void): CloudDelegationOrchestrator {
		return new CloudDelegationOrchestrator(
			{
				store: this.store,
				platform: this.platform,
				process: this.process,
				workspace: this.workspace,
				results: this.results,
				readiness: this.readiness,
				...(this.tunnels === undefined ? {} : { tunnel: this.tunnels }),
				tunnelSecrets: this.tunnelSecrets,
			},
			{ onProgress },
		);
	}

	/** Bounded tail of streamed guest output, read back from the durable outbox. */
	private liveOutputPreview(sessionId: string): string | undefined {
		const eventsDirectory = join(this.stateDirectory, "events", sessionId);
		try {
			const outbox = new DurableCloudEventOutbox({ directory: eventsDirectory, sessionId });
			const tail = outbox.tailCursor.sequence;
			const from = Math.max(0, tail - 40);
			if (from >= tail) return undefined;
			const events = outbox.eventsAfter({ generation: outbox.generation, sequence: from });
			const texts: string[] = [];
			for (const item of events) {
				if (item.event.kind === "output_delta") texts.push(item.event.text);
			}
			if (texts.length === 0) return undefined;
			return texts.join("").slice(-MAX_LIVE_OUTPUT_CHARS);
		} catch {
			return undefined;
		}
	}

	private summary(record: CloudSessionRecord, prompt?: string): DirectCloudDelegationSummary {
		const resultRecord = this.resultStore.get(record.sessionId, "res_output");
		const resultPatch = resultRecord
			? this.resultStore.inspect(record.sessionId, resultRecord.resultId).patch
			: undefined;
		const output = this.outputStore.get(record.sessionId);
		const resultReady =
			record.resultImportState === "available" ||
			record.resultImportState === "reviewed" ||
			record.resultImportState === "imported";
		let status: DirectCloudDelegationSummary["status"];
		if (output?.outcome === "failed") status = "failed";
		else if (output?.outcome === "stopped") status = "stopped";
		else if (
			record.resultImportState === "available" ||
			record.resultImportState === "reviewed" ||
			record.resultImportState === "imported"
		)
			status = "completed";
		else if (record.observedLifecycle === "deleted") status = "stopped";
		else if (
			record.observedLifecycle === "lost" ||
			(record.lastError && record.observedLifecycle === "stopped" && !resultReady)
		)
			status = "failed";
		else if (record.desiredLifecycle === "stopping") status = "stopping";
		else if (record.observedLifecycle === "running") status = "running";
		else status = "provisioning";
		return {
			id: record.sessionId,
			activeSessionId: record.parentSessionId ?? "",
			status,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			promptPreview:
				prompt?.slice(0, 120) ?? this.outputStore.getPromptPreview(record.sessionId) ?? "cloud delegation",
			...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
			...(record.tunnel !== undefined
				? {
						tunnel: {
							tunnelId: record.tunnel.tunnelId,
							url: record.tunnel.url,
							attached: this.attachments.get(record.sessionId)?.attached ?? false,
						},
					}
				: {}),
			...(() => {
				const liveOutput = this.liveOutputPreview(record.sessionId);
				return liveOutput === undefined ? {} : { liveOutput };
			})(),
			resultReady,
			resultApplied: resultRecord?.state === "applied" || record.resultImportState === "imported",
			...(resultRecord
				? {
						changedPaths: resultRecord.changedPaths.slice(0, 100),
						changedPathCount: resultRecord.changedPaths.length,
						...(resultPatch
							? {
									patchPreview: resultPatch.slice(0, 12_000),
									patchTruncated: resultPatch.length > 12_000,
								}
							: {}),
					}
				: {}),
			...(output
				? {
						outcome: output.outcome,
						outputPreview: output.stdout.slice(0, 4_000),
						stderrPreview: output.stderr.slice(0, 2_000),
					}
				: {}),
			...(record.lastError ? { error: record.lastError } : {}),
		};
	}
}
