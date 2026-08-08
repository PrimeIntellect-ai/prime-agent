import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { getLogger } from "@earendil-works/pi-ai";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import {
	appendRotatingLog,
	getCronJobsPath,
	getDaemonLogPath,
	getDaemonUpdateRestartManifestPath,
	VERSION,
} from "../../config.js";
import {
	type AgentFamilyCatalogEntry,
	type AgentSessionMessageAgentSummary,
	assertAgentFamilyReach,
	assertAgentSessionNameAvailable,
	formatAgentSessionNameUnavailable,
	sessionNameReservationKey,
} from "../../core/agent-messages.js";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import {
	type AgentCronJob,
	AgentCronJobStore,
	migrateLegacyCronJobsToSessionArtifacts,
	SESSION_SCHEDULED_JOBS_FILENAME,
} from "../../core/cron-jobs.js";
import {
	clearOrphanProcessJournal,
	isOrphanProcessIdentityCurrent,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
} from "../../core/orphan-process-journal.js";
import { PromptAdmissionCancelledError, waitForPromptAdmission } from "../../core/prompt-admission.js";
import {
	canEvictWorker,
	type IdleEvictionMinutes,
	type WorkerEvictionSnapshot,
} from "../../core/session-action-store.js";
import { canonicalSessionPath, getProcessStartId, SessionAlreadyActiveError } from "../../core/session-lease.js";
import { readSessionInfo, type SessionInfo } from "../../core/session-manager.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { signalProcessGroupOrProcess } from "../../utils/child-process.js";
import type { AgentConnectionHeartbeat } from "../agent-connection/types.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type { PrivateFrame } from "../session-worker/private-framing.js";
import { createActiveSessionId, type DaemonSocketClient } from "./active-session-state.js";
import { CommandRecoveryJournal, createCommandIdempotencyKey } from "./command-recovery-journal.js";
import { CompactAssistantStreamReconstructor, isCompactAssistantDelta } from "./compact-session-stream.js";
import { DAEMON_CATALOG_ROLE_ENV, DaemonCatalogClient } from "./daemon-catalog-process.js";
import { deserializeDaemonError, serializeDaemonError } from "./daemon-errors.js";
import {
	collectDaemonClientEnv,
	createDaemonEventMeta,
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION,
	DAEMON_DEFAULT_CLIENT_CAPABILITIES,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	DAEMON_UPDATE_RESTART_FORMAT_VERSION,
	type DaemonAttachResult,
	type DaemonClientCapability,
	type DaemonClosingReason,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
	type DaemonUpdateRestartManifest,
	failure,
	isDaemonCommandEnvelope,
	isDaemonMutatingCommand,
	salvageDaemonCommandId,
	success,
	UPDATE_RESTART_DRAIN_COMMANDS,
} from "./daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "./daemon-runtime-identity.js";
import { matchesSessionIdSuffix } from "./daemon-session-id.js";
import {
	classifySessionRosterStatus,
	isSessionSummaryBusy,
	type SessionSummary,
	summaryForInactiveSession,
} from "./daemon-session-list.js";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	type DaemonSocketPathLease,
	defaultDaemonSocketDir,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	prepareDaemonSocketPath,
	restrictDaemonSocketPath,
} from "./daemon-socket.js";
import {
	acquireDaemonSupervisorOwnership,
	isDaemonShutdownAdmissionActive,
	waitForDaemonStartupFence,
} from "./daemon-supervisor-ownership.js";
import { DaemonWorkerClient } from "./daemon-worker-client.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_STARTUP_GATE_COMMIT,
	DAEMON_WORKER_STARTUP_GATE_FD_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
	type DaemonCreateCommand,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "./daemon-worker-protocol.js";
import { MutationDrainLatch } from "./mutation-drain-latch.js";
import { serializeSavedSessionInfo } from "./saved-session-info.js";
import { SNAPSHOT_TARGET_CHUNK_BYTES, SnapshotTranscriptCache } from "./snapshot-transcript-cache.js";
import { WorkerRecoveryJournal } from "./worker-recovery-journal.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;

const structuredLog = getLogger("coding-agent.daemon-supervisor");
const WORKER_CONNECT_TIMEOUT_MS = 30_000;
const WORKER_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const UPDATE_RESTART_MUTATION_DRAIN_TIMEOUT_MS = 80_000;
const UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS = 90_000;
// The whole pre-commit prepare (drain + worker fencing) must finish inside the
// caller's 120s prepare_update_restart request timeout, or roll back; otherwise
// an abandoned prepare leaves the daemon permanently fenced with workers stopped.
const UPDATE_RESTART_PREPARE_DEADLINE_MS = 100_000;
const WORKER_RETRY_DELAYS_MS = [250, 1000, 5000] as const;
const DEFERRED_RECOVERY_RECHECK_MS = 5000;
const OWNED_WORKER_DISCONNECT_GRACE_MS = 30_000;
const IDLE_EVICTION_MAX_SWEEP_INTERVAL_MS = 5 * 60_000;
const IDLE_EVICTION_MIN_SWEEP_INTERVAL_MS = 60_000;
const IDLE_EVICTION_DRAIN_TIMEOUT_MS = 5_000;
const CHILD_PASSIVATION_PER_WORKER_CAP = 2;
const SUPERVISOR_CONFIG_FILE_NAME = "supervisor-config";
const WORKER_STARTUP_GATE_FD = 3;

const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"ack_result",
	"list",
	"list_saved_sessions",
	"create",
	"attach",
	"reattach",
	"detach",
	"complete_owned_session",
	"promote_owned_session",
	"kill",
	"rename",
	"prompt",
	"cancel_prompt_admission",
	"prompt_and_wait",
	"steer",
	"follow_up",
	"restore_next_turn",
	"restore_actions",
	"append_custom_message",
	"resume_queue",
	"send_message",
	"agent_messages_status",
	"agent_messages_pause",
	"agent_messages_resume",
	"agent_messages_clear",
	"abort",
	"start_side_question",
	"abort_side_question",
	"execute_bash",
	"execute_bash_and_wait",
	"abort_bash",
	"cancel_rlm_child",
	"delete_rlm_subagent",
	"wait_for_idle",
	"wait_for_headless_completion",
	"get_session_header",
	"get_state",
	"get_connection_state",
	"get_messages",
	"get_session_stats",
	"get_context_tree",
	"get_commands",
	"get_resource_snapshot",
	"get_model_catalog",
	"get_available_models",
	"get_queue",
	"clear_queue",
	"abort_and_clear_queue",
	"cron_list",
	"heartbeats_list",
	"heartbeat_manage",
	"cron_add",
	"cron_cancel",
	"heartbeat_get",
	"heartbeat_set",
	"heartbeat_update",
	"set_model",
	"cycle_model",
	"set_scoped_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_service_tier",
	"set_transport",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"compact",
	"refine",
	"abort_compaction",
	"abort_branch_summary",
	"abort_retry",
	"reload",
	"new_session",
	"switch_session",
	"fork",
	"navigate_tree",
	"import_jsonl",
	"export_html",
	"export_jsonl",
	"set_session_name",
	"get_rlm_max_depth_status",
	"set_rlm_max_depth",
	"rename_saved_session",
	"delete_saved_session",
	"get_session_context",
	"get_session_tree",
	"get_user_messages_for_forking",
	"get_last_assistant_text",
	"get_system_prompt",
	"get_tool_definition",
	"set_session_entry_label",
	"extension_ui_response",
	"prepare_update_restart",
	"retry_worker",
	"restart",
	"shutdown",
]);

interface ResidentWorker {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	client?: DaemonWorkerClient;
	heartbeatSnapshot?: AgentConnectionHeartbeat[];
	heartbeatSnapshotStale?: boolean;
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	snapshotGenerations: Map<string, Map<string, SnapshotTranscriptGeneration>>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	recovery?: Promise<void>;
	deferredRecovery?: Promise<void>;
	intentionalStop: boolean;
	stopRevision: number;
	launchEnv?: Record<string, string>;
	ownerCleanupTimer?: ReturnType<typeof setTimeout>;
	promotedOwnerClientId?: string;
	updateRestartPrepareClient?: DaemonWorkerClient;
}

interface SnapshotDuplicateValidation {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface SnapshotTranscriptGeneration {
	transcript: SnapshotTranscriptCache;
	result: DaemonAttachResult;
	begin?: Buffer;
	end?: Buffer;
	incoming: boolean;
	retired: boolean;
	duplicateChunkIndex?: number;
	duplicateResult?: DaemonAttachResult;
	validation?: SnapshotDuplicateValidation;
}

interface DaemonSupervisorOptions {
	socketPath?: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
	descriptorDir?: string;
}

interface PersistedSupervisorConfig {
	version: 1;
	socketPath: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
}

interface WorkerMatch {
	worker: ResidentWorker;
	summary: SessionSummary;
}

interface WorkerAttachData {
	result: DaemonAttachResult;
	worker: ResidentWorker;
	transcript?: SnapshotTranscriptCache;
	releaseTranscript?: () => void;
}

interface SupervisorPromptAdmission {
	client: DaemonSocketClient;
	activeSessionId: string;
	publicAdmissionId: string;
	workerAdmissionId: string;
	status: "waiting" | "owned" | "cancelled";
	controller: AbortController;
	worker?: ResidentWorker;
	workerActiveSessionId?: string;
}

function throwIfAdmissionCancelled(admission: SupervisorPromptAdmission | undefined): void {
	if (admission?.status === "cancelled") throw new PromptAdmissionCancelledError();
}

class SupervisorRecoveryCancelledError extends Error {
	readonly code = "supervisor_recovery_cancelled" as const;
}

class SnapshotLoadInvalidatedError extends Error {}

function isSupervisorGenerationStale(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "supervisor_generation_stale"
	);
}

function isSupervisorRecoveryCancelled(error: unknown): boolean {
	return isSupervisorShutdownAdmissionCancelled(error) || isSupervisorGenerationStale(error);
}

function isSupervisorShutdownAdmissionCancelled(error: unknown): boolean {
	return (
		error instanceof SupervisorRecoveryCancelledError ||
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "supervisor_recovery_cancelled")
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function unrefDelay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms).unref());
}

function commitWorkerStartupGate(gate: Writable): Promise<void> {
	return new Promise((resolveCommit, rejectCommit) => {
		let settled = false;
		const finish = (error?: Error | null) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error) {
				rejectCommit(error);
			} else {
				resolveCommit();
			}
		};
		const onError = (error: Error) => finish(error);
		gate.on("error", onError);
		gate.once("close", () => gate.off("error", onError));
		gate.end(DAEMON_WORKER_STARTUP_GATE_COMMIT, (error?: Error | null) => finish(error));
	});
}

function withoutCommandId(command: DaemonCommand): DaemonCommandBody {
	const { id: _id, ...body } = command;
	return body as DaemonCommandBody;
}

function withoutSupervisorCreateFields(command: DaemonCreateCommand): DaemonCreateCommand {
	const { launchEnv: _launchEnv, lifecycle: _lifecycle, ...workerCommand } = command;
	return workerCommand;
}

function responseWithId(response: DaemonResponse, id: string | undefined): DaemonResponse {
	return { ...response, id };
}

function isSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { id?: unknown; sessionId?: unknown; cwd?: unknown };
	return (
		typeof candidate.id === "string" && typeof candidate.sessionId === "string" && typeof candidate.cwd === "string"
	);
}

function isDaemonWorkerDescriptor(value: unknown, socketPath: string): value is DaemonWorkerDescriptor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const descriptor = value as Partial<DaemonWorkerDescriptor>;
	return (
		descriptor.version === 1 &&
		descriptor.supervisorSocketPath === socketPath &&
		typeof descriptor.workerId === "string" &&
		Number.isInteger(descriptor.pid) &&
		(descriptor.pid ?? 0) > 0 &&
		(descriptor.processStartId === undefined || typeof descriptor.processStartId === "string") &&
		(descriptor.ownerClientId === undefined || typeof descriptor.ownerClientId === "string") &&
		typeof descriptor.socketPath === "string" &&
		typeof descriptor.authenticationToken === "string" &&
		typeof descriptor.rootActiveSessionId === "string" &&
		typeof descriptor.createdAt === "string" &&
		typeof descriptor.updatedAt === "string" &&
		Number.isInteger(descriptor.consecutiveFailures) &&
		descriptor.createCommand !== undefined &&
		typeof descriptor.createCommand === "object" &&
		descriptor.createCommand.type === "create"
	);
}

function sessionSummariesFromResponse(response: DaemonResponse): SessionSummary[] {
	if (!response.success || !response.data || typeof response.data !== "object" || !("sessions" in response.data)) {
		throw new Error("Session worker returned an invalid list response");
	}
	const sessions = (response.data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions) || !sessions.every(isSessionSummary)) {
		throw new Error("Session worker returned an invalid list response");
	}
	return sessions;
}

function attachResultFromResponse(response: DaemonResponse): DaemonAttachResult {
	if (!response.success || !response.data || typeof response.data !== "object") {
		throw new Error(response.success ? "Session worker returned an invalid attach response" : response.error);
	}
	const candidate = response.data as Partial<DaemonAttachResult>;
	if (typeof candidate.activeSessionId !== "string" || !candidate.snapshot || !candidate.client) {
		throw new Error("Session worker returned an invalid attach response");
	}
	return candidate as DaemonAttachResult;
}

function cronJobsFromResponse(response: DaemonResponse): AgentCronJob[] {
	if (!response.success || !response.data || typeof response.data !== "object") {
		return [];
	}
	const jobs = (response.data as { jobs?: unknown }).jobs;
	return Array.isArray(jobs) ? (jobs as AgentCronJob[]) : [];
}

function heartbeatsFromResponse(response: DaemonResponse): AgentConnectionHeartbeat[] {
	if (!response.success || !response.data || typeof response.data !== "object") {
		return [];
	}
	const heartbeats = (response.data as { heartbeats?: unknown }).heartbeats;
	return Array.isArray(heartbeats) ? (heartbeats as AgentConnectionHeartbeat[]) : [];
}

function sortCronJobs(jobs: AgentCronJob[]): AgentCronJob[] {
	return jobs.sort((left, right) => {
		if (left.nextRunAt === right.nextRunAt) {
			return 0;
		}
		if (left.nextRunAt === undefined) {
			return 1;
		}
		if (right.nextRunAt === undefined) {
			return -1;
		}
		return Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt);
	});
}

function descriptorKey(socketPath: string): string {
	return createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
}

function defaultWorkerDescriptorDir(agentDir: string, socketPath: string): string {
	return join(agentDir, "daemon-workers", descriptorKey(socketPath));
}

export function idleEvictionSweepIntervalMs(idleEvictionMinutes: IdleEvictionMinutes): number {
	if (idleEvictionMinutes === "off") return IDLE_EVICTION_MAX_SWEEP_INTERVAL_MS;
	return Math.max(
		IDLE_EVICTION_MIN_SWEEP_INTERVAL_MS,
		Math.min(IDLE_EVICTION_MAX_SWEEP_INTERVAL_MS, (idleEvictionMinutes * 60_000) / 3),
	);
}

function workerSocketPath(supervisorSocketPath: string, workerId: string): string {
	const key = descriptorKey(supervisorSocketPath);
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-worker-${key}-${workerId.slice(0, 12)}`;
	}
	return join(defaultDaemonSocketDir(), `worker-${key}-${workerId.slice(0, 12)}.sock`);
}

function looksLikeSessionPath(selector: string): boolean {
	return isAbsolute(selector) || selector.endsWith(".jsonl") || selector.includes("/") || selector.includes("\\");
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isFinalizedTranscriptEvent(eventType: string | undefined): boolean {
	return (
		eventType === "message_end" ||
		eventType === "turn_end" ||
		eventType === "compaction_end" ||
		eventType === "bash_end"
	);
}

function normalizeCapabilities(
	capabilities: readonly DaemonClientCapability[] | undefined,
	supportsExtensionUi: boolean | undefined,
): Set<DaemonClientCapability> {
	const normalized = new Set(capabilities ?? DAEMON_DEFAULT_CLIENT_CAPABILITIES);
	if (supportsExtensionUi) {
		normalized.add("extension_ui");
	}
	return normalized;
}

function mergeSessionLists(active: readonly SessionSummary[], saved: readonly SessionInfo[]): SessionSummary[] {
	const activeByFile = new Map<string, SessionSummary>();
	for (const summary of active) {
		if (summary.sessionFile) {
			activeByFile.set(resolve(summary.sessionFile), summary);
		}
	}
	const merged: SessionSummary[] = [];
	const seenActiveIds = new Set<string>();
	for (const session of saved) {
		const resident = activeByFile.get(resolve(session.path));
		if (resident) {
			merged.push({
				...resident,
				created: resident.created ?? session.created.toISOString(),
				modified: resident.modified ?? session.modified.toISOString(),
				firstMessage: resident.firstMessage ?? session.firstMessage,
			});
			seenActiveIds.add(resident.activeSessionId ?? resident.id);
		} else {
			merged.push(summaryForInactiveSession(session));
		}
	}
	for (const summary of active) {
		if (!seenActiveIds.has(summary.activeSessionId ?? summary.id)) {
			merged.push(summary);
		}
	}
	return merged;
}

export async function runDaemonSupervisorMode(options: DaemonSupervisorOptions): Promise<never> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	const supervisor = new DaemonSupervisor(socketPath, options);
	await supervisor.start();
	return new Promise(() => {});
}

export class DaemonSupervisor {
	private server?: Server;
	private readonly ready: Promise<void>;
	private markReady: () => void = () => {};
	private rejectReady: (error: Error) => void = () => {};
	private ownsSocketPath = false;
	private socketIdentity?: DaemonSocketIdentity;
	private socketLease?: DaemonSocketPathLease;
	private ownership?: Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;
	private cleanupPromise?: Promise<void>;
	private shuttingDown = false;
	private updateRestartPhase?: "draining" | "fencing" | "prepared";
	private readonly mutationDrain = new MutationDrainLatch();
	private readonly clients = new Set<DaemonSocketClient>();
	private readonly protocolClientIds = new WeakMap<DaemonSocketClient, string>();
	private readonly workers = new Map<string, ResidentWorker>();
	private readonly openingWorkers = new Map<string, Promise<ResidentWorker>>();
	/** Public admission ids are scoped to the socket that registered them. */
	private readonly promptAdmissions = new Map<DaemonSocketClient, Map<string, SupervisorPromptAdmission>>();
	private readonly signalCleanupHandlers: Array<() => void> = [];
	private readonly descriptorDir: string;
	private readonly generation = randomUUID();
	private readonly supervisorConfigPath: string;
	private readonly defaultSessionConfig: AgentSessionRuntimeConfig;
	private readonly snapshotCacheRoot: string;
	private commandJournal!: CommandRecoveryJournal;
	private readonly streamReconstructor = new CompactAssistantStreamReconstructor();
	private readonly compactCatchupInProgress = new Set<string>();
	private agentPeerSyncQueue: Promise<void> = Promise.resolve();
	private readonly pendingSessionNames = new Set<string>();
	private readonly catalog: DaemonCatalogClient;
	private readonly settingsManager: SettingsManager;
	private idleEvictionTimer?: ReturnType<typeof setTimeout>;
	private idleEvictionSweep?: Promise<void>;
	private idleEvictionFence?: Promise<void>;

	constructor(
		private readonly socketPath: string,
		options: DaemonSupervisorOptions,
	) {
		this.ready = new Promise<void>((resolveReady, rejectReady) => {
			this.markReady = resolveReady;
			this.rejectReady = rejectReady;
		});
		void this.ready.catch(() => undefined);
		const agentDir = options.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		this.descriptorDir = options.descriptorDir ?? defaultWorkerDescriptorDir(agentDir, socketPath);
		this.supervisorConfigPath = join(this.descriptorDir, SUPERVISOR_CONFIG_FILE_NAME);
		this.defaultSessionConfig = this.loadPersistedSupervisorConfig() ?? options.defaultSessionConfig;
		this.snapshotCacheRoot = join(this.descriptorDir, "snapshot-cache", this.generation);
		this.catalog = new DaemonCatalogClient((message) => this.log(message));
		this.settingsManager = SettingsManager.create(process.cwd(), this.defaultSessionConfig.agentDir ?? agentDir);
	}

	async start(): Promise<void> {
		try {
			const agentDir = this.defaultSessionConfig.agentDir;
			if (!agentDir) {
				throw new Error("Daemon supervisor config is missing agentDir");
			}
			this.socketLease = await acquireDaemonSocketPathLease(this.socketPath);
			await waitForDaemonStartupFence(this.socketPath);
			this.ownership = await acquireDaemonSupervisorOwnership({
				socketPath: this.socketPath,
				descriptorDir: this.descriptorDir,
				agentDir,
				generation: this.generation,
				appVersion: VERSION,
			});
			await prepareDaemonSocketPath(this.socketPath, this.socketLease);

			mkdirSync(this.descriptorDir, { recursive: true, mode: 0o700 });
			chmodSync(this.descriptorDir, 0o700);
			this.persistSupervisorConfig();
			rmSync(this.snapshotCacheRoot, { recursive: true, force: true });
			mkdirSync(this.snapshotCacheRoot, { recursive: true, mode: 0o700 });
			this.commandJournal = new CommandRecoveryJournal(join(this.descriptorDir, "command-journal.jsonl"));
			this.loadWorkerDescriptors();
			const workersToAdopt = [...this.workers.values()];

			this.server = createServer((socket) => this.handleConnection(socket));
			await this.listen();
			this.socketIdentity = getDaemonSocketIdentity(this.socketPath);
			if (process.platform !== "win32" && !this.socketIdentity) {
				throw new Error(`Could not capture daemon socket identity: ${this.socketPath}`);
			}
			this.ownsSocketPath = true;
			restrictDaemonSocketPath(this.socketPath);

			this.registerSignalHandlers();
			const ownedSessionFiles = new Set(
				[...this.workers.values()]
					.flatMap((worker) => [worker.descriptor.sessionFile, worker.descriptor.createCommand.sessionPath])
					.filter((path): path is string => typeof path === "string")
					.map((path) => resolve(path)),
			);
			const migratedJobs = migrateLegacyCronJobsToSessionArtifacts(getCronJobsPath(agentDir), {
				isSessionOwned: (job) => ownedSessionFiles.has(resolve(job.sessionFile)),
			});
			if (migratedJobs > 0) {
				this.log(`Migrated ${migratedJobs} scheduled jobs into session artifacts`);
			}
			await this.catalog.start().catch((error) => this.log(`Could not start daemon catalog: ${String(error)}`));
			let adoptionFailure: unknown;
			let adoptionFailed = false;
			await Promise.all(
				workersToAdopt.map(async (worker) => {
					try {
						await this.adoptOrRecoverWorker(worker);
					} catch (error) {
						if (!adoptionFailed) {
							adoptionFailed = true;
							adoptionFailure = error;
						}
					}
				}),
			);
			if (adoptionFailed) {
				throw adoptionFailure;
			}
			await this.syncAgentPeers().catch((error) => this.log(`Could not synchronize agent peers: ${String(error)}`));
			for (const worker of this.workers.values()) {
				this.scheduleOwnedWorkerCleanup(worker);
			}
			this.scheduleIdleEvictionSweep();
			await this.ownership.updatePhase("owner");
			this.log(`Prime Agent daemon supervisor ${this.generation} listening on ${this.socketPath}`);
			this.markReady();
		} catch (error) {
			const startupError = error instanceof Error ? error : new Error(String(error));
			this.log(`Daemon supervisor startup failed: ${startupError.stack ?? startupError.message}`);
			await this.cleanupSupervisorResources();
			this.rejectReady(startupError);
			throw startupError;
		}
	}

	private listen(): Promise<void> {
		return new Promise<void>((resolveListen, rejectListen) => {
			const onError = (error: Error) => {
				this.server?.off("listening", onListening);
				rejectListen(error);
			};
			const onListening = () => {
				this.server?.off("error", onError);
				resolveListen();
			};
			this.server?.once("error", onError);
			this.server?.once("listening", onListening);
			this.server?.listen(this.socketPath);
		});
	}

	private log(message: string): void {
		console.error(message);
		structuredLog.warn(message, { socketPath: this.socketPath });
		appendRotatingLog(getDaemonLogPath(this.socketPath), `[${new Date().toISOString()}] supervisor: ${message}`);
	}

	private clearIdleEvictionTimer(): void {
		if (!this.idleEvictionTimer) return;
		clearTimeout(this.idleEvictionTimer);
		this.idleEvictionTimer = undefined;
	}

	private scheduleIdleEvictionSweep(): void {
		if (this.shuttingDown || this.idleEvictionTimer || this.idleEvictionSweep) return;
		const delayMs = idleEvictionSweepIntervalMs(this.settingsManager.getIdleEvictionMinutes());
		this.idleEvictionTimer = setTimeout(() => {
			this.idleEvictionTimer = undefined;
			const sweep = this.runIdleEvictionSweep()
				.catch((error) => this.log(`Idle eviction sweep failed: ${String(error)}`))
				.finally(() => {
					if (this.idleEvictionSweep === sweep) this.idleEvictionSweep = undefined;
					this.scheduleIdleEvictionSweep();
				});
			this.idleEvictionSweep = sweep;
		}, delayMs);
		this.idleEvictionTimer.unref();
	}

	private workerEvictionSnapshot(worker: ResidentWorker): WorkerEvictionSnapshot {
		return {
			lifecycle: worker.descriptor.lifecycle,
			isConnected: worker.client !== undefined,
			isStopping: worker.intentionalStop || worker.descriptor.stopRequestedAt !== undefined,
			hasOwnerClient: worker.descriptor.ownerClientId !== undefined,
			isPreparingUpdateRestart:
				this.updateRestartPhase !== undefined || worker.updateRestartPrepareClient !== undefined,
			sessions: [...worker.summaries.values()].map((summary) => {
				const activeSessionId = summary.activeSessionId ?? summary.id;
				return {
					// Use the canonical busy projection: a parent remains active for
					// residency purposes while any of its RLM descendants is running.
					isSessionActive: isSessionSummaryBusy(summary),
					attachedClients: [...this.clients].filter((client) =>
						client.attachedActiveSessionIds.has(activeSessionId),
					).length,
					hasRegisteredHeartbeat: summary.hasRegisteredHeartbeat === true,
					hasRegisteredCronJob: summary.hasRegisteredCronJob === true,
					lastActivityAt: Date.parse(summary.lastActivityAt ?? ""),
				};
			}),
		};
	}

	private async runIdleEvictionSweep(now = Date.now()): Promise<void> {
		if (this.shuttingDown || this.updateRestartPhase !== undefined || this.idleEvictionFence) return;
		await this.settingsManager.reload();
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
		const idleEvictionMinutes = this.settingsManager.getIdleEvictionMinutes();
		if (idleEvictionMinutes === "off") return;

		const refreshed = new Set<ResidentWorker>();
		await Promise.all(
			[...this.workers.values()].map(async (worker) => {
				try {
					await this.refreshWorkerSummaries(worker);
					refreshed.add(worker);
				} catch {
					// A disconnected or transitioning worker is never an eviction candidate.
				}
			}),
		);
		const candidates = [...refreshed].filter((worker) =>
			canEvictWorker(this.workerEvictionSnapshot(worker), idleEvictionMinutes, now),
		);
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
		// Whole-tree candidates skip child work because stopWorker releases everything.
		await Promise.all(
			[...refreshed]
				.filter((worker) => !candidates.includes(worker))
				.map(async (worker) => {
					try {
						const response = await worker.client?.requestWorker(
							{
								type: "worker_passivate_idle_children",
								idleEvictionMinutes,
								now,
								limit: CHILD_PASSIVATION_PER_WORKER_CAP,
							},
							30_000,
						);
						if (response && !response.success) throw new Error(response.error);
						await this.refreshWorkerSummaries(worker);
					} catch (error) {
						refreshed.delete(worker);
						this.log(`Child passivation sweep failed for worker ${worker.descriptor.workerId}: ${String(error)}`);
					}
				}),
		);
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;

		let releaseFence: () => void = () => {};
		const fence = new Promise<void>((resolveFence) => {
			releaseFence = resolveFence;
		});
		this.idleEvictionFence = fence;
		try {
			await this.mutationDrain.waitForDrain(
				0,
				AbortSignal.timeout(IDLE_EVICTION_DRAIN_TIMEOUT_MS),
				"Timed out draining daemon mutations for idle eviction",
			);
			if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
			await Promise.all(
				candidates.map((worker) => this.refreshWorkerSummaries(worker).catch(() => refreshed.delete(worker))),
			);
			if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
			const evictable = candidates.filter(
				(worker) =>
					refreshed.has(worker) &&
					this.workers.get(worker.descriptor.workerId) === worker &&
					canEvictWorker(this.workerEvictionSnapshot(worker), idleEvictionMinutes, now),
			);
			// Promise.all may reject and release the fence while sibling stops are still
			// finishing. That is safe: a racing mutation either reaches a live worker or
			// gets a clean disconnected/unknown-session error.
			await Promise.all(
				evictable.map(async (worker) => {
					if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
					const snapshot = this.workerEvictionSnapshot(worker);
					const idleMinutes = Math.floor(
						Math.min(...snapshot.sessions.map((session) => now - session.lastActivityAt)) / 60_000,
					);
					const root = worker.summaries.get(worker.descriptor.rootActiveSessionId);
					await this.stopWorker(worker, true);
					this.log(
						`Evicted idle worker ${worker.descriptor.workerId} root=${root?.sessionId ?? worker.descriptor.rootSessionId ?? worker.descriptor.rootActiveSessionId} idleMinutes=${idleMinutes} sessions=${snapshot.sessions.length}`,
					);
				}),
			);
		} finally {
			if (this.idleEvictionFence === fence) this.idleEvictionFence = undefined;
			releaseFence();
		}
	}

	private async assertCurrentOwnership(): Promise<void> {
		const ownership = this.ownership;
		if (!ownership) {
			const error = new Error(`Daemon supervisor generation ${this.generation} no longer owns its registry entry`);
			Object.assign(error, { code: "supervisor_generation_stale" as const });
			throw error;
		}
		await ownership.assertCurrent();
	}

	private async assertRecoveryAllowed(): Promise<void> {
		await this.assertCurrentOwnership();
		if (await isDaemonShutdownAdmissionActive()) {
			throw new SupervisorRecoveryCancelledError("Daemon shutdown admission cancelled worker recovery");
		}
	}

	private supervisorAuthenticationClaim(): {
		supervisorGeneration: string;
		supervisorPid: number;
		supervisorProcessStartId?: string;
		supervisorSocketPath: string;
	} {
		const record = this.ownership?.record;
		if (!record) {
			throw new SupervisorRecoveryCancelledError("Daemon supervisor ownership is unavailable");
		}
		return {
			supervisorGeneration: this.generation,
			supervisorPid: record.pid,
			...(record.processStartId ? { supervisorProcessStartId: record.processStartId } : {}),
			supervisorSocketPath: record.socketPath,
		};
	}

	private loadWorkerDescriptors(): void {
		for (const name of readdirSync(this.descriptorDir)) {
			if (name === SUPERVISOR_CONFIG_FILE_NAME || !name.endsWith(".json")) {
				continue;
			}
			const path = join(this.descriptorDir, name);
			try {
				const descriptor: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!isDaemonWorkerDescriptor(descriptor, this.socketPath)) {
					continue;
				}
				descriptor.lifecycle = "recovering";
				descriptor.recoveryJournalPath ??= join(this.descriptorDir, `${descriptor.workerId}.recovery.jsonl`);
				descriptor.orphanProcessJournalPath ??= join(this.descriptorDir, `${descriptor.workerId}.orphans.jsonl`);
				this.workers.set(descriptor.workerId, {
					descriptor,
					descriptorPath: path,
					summaries: new Map(),
					snapshotCache: new Map(),
					transcriptCaches: new Map(),
					snapshotGenerations: new Map(),
					snapshotLoads: new Map(),
					intentionalStop: descriptor.stopRequestedAt !== undefined,
					stopRevision: 0,
				});
			} catch (error) {
				this.log(`Ignoring invalid worker descriptor ${path}: ${String(error)}`);
			}
		}
	}

	private loadPersistedSupervisorConfig(): AgentSessionRuntimeConfig | undefined {
		try {
			const parsed = JSON.parse(
				readFileSync(this.supervisorConfigPath, "utf8"),
			) as Partial<PersistedSupervisorConfig>;
			if (
				parsed.version !== 1 ||
				parsed.socketPath !== this.socketPath ||
				!parsed.defaultSessionConfig ||
				typeof parsed.defaultSessionConfig !== "object" ||
				typeof parsed.defaultSessionConfig.agentDir !== "string"
			) {
				return undefined;
			}
			return parsed.defaultSessionConfig;
		} catch {
			return undefined;
		}
	}

	private persistSupervisorConfig(): void {
		const persisted: PersistedSupervisorConfig = {
			version: 1,
			socketPath: this.socketPath,
			defaultSessionConfig: this.defaultSessionConfig,
		};
		const tempPath = `${this.supervisorConfigPath}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, this.supervisorConfigPath);
	}

	private hasPersistedWorkerDescriptors(): boolean {
		return readdirSync(this.descriptorDir).some(
			(name) => name !== SUPERVISOR_CONFIG_FILE_NAME && name.endsWith(".json"),
		);
	}

	private persistWorker(worker: ResidentWorker): void {
		worker.descriptor.updatedAt = new Date().toISOString();
		const tempPath = `${worker.descriptorPath}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(worker.descriptor, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, worker.descriptorPath);
	}

	private deleteWorkerDescriptor(worker: ResidentWorker): void {
		try {
			rmSync(worker.descriptorPath, { force: true });
			rmSync(worker.descriptor.recoveryJournalPath, { force: true });
			if (worker.descriptor.orphanProcessJournalPath) {
				rmSync(worker.descriptor.orphanProcessJournalPath, { force: true });
			}
		} catch (error) {
			this.log(`Failed to remove worker descriptor ${worker.descriptorPath}: ${String(error)}`);
		}
	}

	private handleConnection(socket: Socket): void {
		const client: DaemonSocketClient = {
			id: createActiveSessionId(),
			socket,
			attachedActiveSessionIds: new Set(),
			catchupActiveSessionIds: new Set(),
			backpressured: false,
			authenticated: true,
			snapshotActiveSessionIds: new Set(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(DAEMON_DEFAULT_CLIENT_CAPABILITIES),
		};
		this.clients.add(client);
		void this.ready.then(
			() => {
				if (!client.socket.destroyed && this.clients.has(client)) {
					this.write(client, {
						type: "daemon_hello",
						socketPath: this.socketPath,
						protocol: DAEMON_PROTOCOL_INFO,
						schemaId: DAEMON_SCHEMA_ID,
						schemaRevision: DAEMON_SCHEMA_REVISION,
						appVersion: VERSION,
						runtime: getDaemonRuntimeIdentity(),
						supervisorGeneration: this.generation,
						supervisorOwnerToken: this.ownership?.record.token,
						supervisorPid: process.pid,
						supervisorProcessStartId: this.ownership?.record.processStartId,
						supervisorSocketPath: this.ownership?.record.socketPath,
						clientId: client.id,
						serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
					});
				}
			},
			() => client.socket.destroy(),
		);

		client.detachInput = attachJsonlLineReader(socket, (line) => void this.handleLine(client, line));
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) {
				return;
			}
			cleaned = true;
			client.detachInput();
			this.clients.delete(client);
			this.cancelWaitingPromptAdmissionsForClient(client);
			for (const activeSessionId of [...client.attachedActiveSessionIds]) {
				client.attachedActiveSessionIds.delete(activeSessionId);
				void this.syncWorkerExtensionUi(activeSessionId);
			}
			this.scheduleOwnedWorkerCleanupForClient(this.protocolClientId(client));
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
		socket.on("drain", () => {
			client.backpressured = false;
			if (!client.snapshotStreaming) {
				void this.catchUpClient(client).catch((error) =>
					this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
				);
			}
		});
	}

	private cancelOwnedWorkerCleanup(clientId: string): void {
		for (const worker of this.workers.values()) {
			if (worker.descriptor.ownerClientId !== clientId || !worker.ownerCleanupTimer) {
				continue;
			}
			clearTimeout(worker.ownerCleanupTimer);
			worker.ownerCleanupTimer = undefined;
		}
	}

	private protocolClientId(client: DaemonSocketClient): string {
		return this.protocolClientIds.get(client) ?? client.id;
	}

	private scheduleOwnedWorkerCleanupForClient(clientId: string): void {
		if ([...this.clients].some((client) => this.protocolClientId(client) === clientId)) {
			return;
		}
		for (const worker of this.workers.values()) {
			if (worker.descriptor.ownerClientId === clientId) {
				this.scheduleOwnedWorkerCleanup(worker);
			}
		}
	}

	private scheduleOwnedWorkerCleanup(worker: ResidentWorker): void {
		const ownerClientId = worker.descriptor.ownerClientId;
		if (
			!ownerClientId ||
			worker.ownerCleanupTimer ||
			[...this.clients].some((client) => this.protocolClientId(client) === ownerClientId)
		) {
			return;
		}
		worker.ownerCleanupTimer = setTimeout(() => {
			worker.ownerCleanupTimer = undefined;
			if (
				worker.descriptor.ownerClientId !== ownerClientId ||
				[...this.clients].some((client) => this.protocolClientId(client) === ownerClientId) ||
				this.workers.get(worker.descriptor.workerId) !== worker
			) {
				return;
			}
			void this.stopWorker(worker, true).catch((error) =>
				this.log(`Could not clean up client-owned worker ${worker.descriptor.workerId}: ${String(error)}`),
			);
		}, OWNED_WORKER_DISCONNECT_GRACE_MS);
		worker.ownerCleanupTimer.unref();
	}

	private promptAdmissionKey(activeSessionId: string, publicAdmissionId: string): string {
		return `${activeSessionId}\0${publicAdmissionId}`;
	}

	private promptAdmissionsFor(client: DaemonSocketClient): Map<string, SupervisorPromptAdmission> {
		let admissions = this.promptAdmissions.get(client);
		if (!admissions) {
			admissions = new Map();
			this.promptAdmissions.set(client, admissions);
		}
		return admissions;
	}

	private getPromptAdmission(
		client: DaemonSocketClient,
		activeSessionId: string,
		publicAdmissionId: string,
	): SupervisorPromptAdmission | undefined {
		return this.promptAdmissions.get(client)?.get(this.promptAdmissionKey(activeSessionId, publicAdmissionId));
	}

	private deletePromptAdmission(admission: SupervisorPromptAdmission): void {
		const admissions = this.promptAdmissions.get(admission.client);
		const key = this.promptAdmissionKey(admission.activeSessionId, admission.publicAdmissionId);
		if (admissions?.get(key) !== admission) return;
		admissions.delete(key);
		if (admissions.size === 0) this.promptAdmissions.delete(admission.client);
	}

	private cancelWaitingPromptAdmissionsForClient(client: DaemonSocketClient): void {
		for (const admission of this.promptAdmissions.get(client)?.values() ?? []) {
			if (admission.status !== "waiting") continue;
			if (!admission.worker || !admission.workerActiveSessionId) {
				admission.status = "cancelled";
				admission.controller.abort();
				continue;
			}
			const worker = admission.worker;
			const workerActiveSessionId = admission.workerActiveSessionId;
			void this.forwardToWorker(worker, {
				type: "cancel_prompt_admission",
				activeSessionId: workerActiveSessionId,
				admissionId: admission.workerAdmissionId,
			})
				.then((response) => {
					if (admission.status !== "waiting") return;
					const status =
						response.success && response.data && typeof response.data === "object" && "status" in response.data
							? (response.data as { status?: unknown }).status
							: undefined;
					if (status === "owned") admission.status = "owned";
					else if (status === "cancelled") admission.status = "cancelled";
				})
				.catch((error: unknown) => {
					this.log(
						`Could not cancel prompt admission ${admission.workerAdmissionId} on disconnected client: ${String(error)}`,
					);
				});
		}
	}

	/** Non-async by design: prompt registration completes before handleLine's first await. */
	private parseCommandAndRegisterPromptAdmission(
		client: DaemonSocketClient,
		line: string,
	): {
		command: DaemonCommand;
		envelopeClientId?: string;
		protocolVersion: number;
		admission?: SupervisorPromptAdmission;
	} {
		const parsed = JSON.parse(line) as unknown;
		const envelope = isDaemonCommandEnvelope(parsed) ? parsed : undefined;
		if (!envelope) {
			throw new Error(`Daemon commands require protocol ${DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION} or newer`);
		}
		const command = { ...envelope.command, id: envelope.id } as DaemonCommand;
		let admission: SupervisorPromptAdmission | undefined;
		if ((command.type === "prompt" || command.type === "prompt_and_wait") && command.admissionId !== undefined) {
			if (typeof command.activeSessionId !== "string" || typeof command.admissionId !== "string") {
				throw new Error("Prompt admission requires string activeSessionId and admissionId");
			}
			if (command.admissionId === "") throw new Error("admissionId must not be empty");
			const admissions = this.promptAdmissionsFor(client);
			const key = this.promptAdmissionKey(command.activeSessionId, command.admissionId);
			if (admissions.has(key)) {
				throw new Error(`Prompt admission id is already in use: ${command.admissionId}`);
			}
			admission = {
				client,
				activeSessionId: command.activeSessionId,
				publicAdmissionId: command.admissionId,
				workerAdmissionId: `supervisor-admission:${randomUUID()}`,
				status: "waiting",
				controller: new AbortController(),
			};
			admissions.set(key, admission);
		}
		return {
			command,
			envelopeClientId: envelope.clientId ?? client.id,
			protocolVersion: envelope.protocol.version,
			admission,
		};
	}

	private async handleLine(client: DaemonSocketClient, line: string): Promise<void> {
		let preParsed: ReturnType<DaemonSupervisor["parseCommandAndRegisterPromptAdmission"]>;
		try {
			preParsed = this.parseCommandAndRegisterPromptAdmission(client, line);
		} catch (error) {
			this.write(client, failure(salvageDaemonCommandId(line), "parse", error));
			return;
		}
		const command = preParsed.command;
		const parsedAdmission = preParsed.admission;
		if (command.type === "cancel_prompt_admission" && this.updateRestartPhase !== undefined) {
			this.write(client, failure(command.id, command.type, "Daemon is preparing an update restart"));
			return;
		}
		const cancellationAdmission =
			command.type === "cancel_prompt_admission"
				? this.getPromptAdmission(client, command.activeSessionId, command.admissionId)
				: undefined;
		if (cancellationAdmission?.status === "waiting" && !cancellationAdmission.worker) {
			cancellationAdmission.status = "cancelled";
			cancellationAdmission.controller.abort();
		}
		try {
			await waitForPromptAdmission(this.ready, parsedAdmission?.controller.signal);
		} catch (error) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, failure(command.id, command.type, error));
			return;
		}
		const envelopeClientId = preParsed.envelopeClientId;
		if (envelopeClientId) {
			this.protocolClientIds.set(client, envelopeClientId);
			client.id = envelopeClientId;
		}
		this.cancelOwnedWorkerCleanup(client.id);
		if (!DAEMON_COMMAND_TYPES.has(command.type)) {
			this.write(client, failure(command.id, command.type, `Unknown daemon command: ${command.type}`));
			return;
		}
		if (
			command.type === "get_session_tree" &&
			preParsed.protocolVersion < DAEMON_COMMAND_COMPATIBILITY.get_session_tree.minProtocol
		) {
			this.write(
				client,
				failure(
					command.id,
					command.type,
					`get_session_tree requires client protocol ${DAEMON_COMMAND_COMPATIBILITY.get_session_tree.minProtocol} or newer`,
				),
			);
			return;
		}

		try {
			await waitForPromptAdmission(this.assertCurrentOwnership(), parsedAdmission?.controller.signal);
		} catch (error) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, failure(command.id, command.type, error));
			return;
		}

		const mutation = isDaemonMutatingCommand(command);
		const journalIdentity =
			envelopeClientId && command.id && mutation ? { clientId: envelopeClientId, commandId: command.id } : undefined;
		const existing = journalIdentity
			? this.commandJournal.lookup(journalIdentity.clientId, journalIdentity.commandId)
			: undefined;
		if (existing?.status === "complete") {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, existing.response);
			return;
		}
		if (existing?.status === "pending" && journalIdentity) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(
				client,
				failure(command.id, command.type, "The previous command result is uncertain and was not replayed", {
					code: "command_result_uncertain",
					...journalIdentity,
				}),
			);
			return;
		}

		const phase = this.updateRestartPhase;
		const restartRejected =
			phase === "draining"
				? !UPDATE_RESTART_DRAIN_COMMANDS.has(command.type)
				: phase !== undefined && !(phase === "prepared" && command.type === "shutdown");
		if (restartRejected && mutation) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, failure(command.id, command.type, "Daemon is preparing an update restart"));
			return;
		}
		if (journalIdentity) {
			const admitted = this.commandJournal.begin(journalIdentity.clientId, journalIdentity.commandId, command.type);
			if (admitted.status === "complete") {
				if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
				this.write(client, admitted.response);
				return;
			}
			if (admitted.status === "pending") {
				if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
				this.write(
					client,
					failure(command.id, command.type, "The previous command result is uncertain and was not replayed", {
						code: "command_result_uncertain",
						...journalIdentity,
					}),
				);
				return;
			}
		}

		if (mutation && !UPDATE_RESTART_DRAIN_COMMANDS.has(command.type)) {
			const idleEvictionFence = this.idleEvictionFence;
			if (idleEvictionFence) await idleEvictionFence;
		}
		// Attach is intentionally read-only and is not fence-gated. If eviction wins
		// the race, attach fails cleanly with "Session worker is not connected" and
		// the client retries through the saved-session path instead of mutating state.
		if (mutation) this.mutationDrain.begin();
		try {
			const response = await this.handleCommand(client, command, cancellationAdmission);
			if (response) {
				if (journalIdentity) {
					await this.assertCurrentOwnership();
					this.commandJournal.recordResult(journalIdentity.clientId, journalIdentity.commandId, response);
				}
				this.write(client, response);
			}
		} catch (error) {
			this.log(`Supervisor command ${command.type} failed: ${error instanceof Error ? error.stack : String(error)}`);
			let response = failure(command.id, command.type, error, serializeDaemonError(error));
			if (journalIdentity && !isSupervisorGenerationStale(error)) {
				try {
					await this.assertCurrentOwnership();
					this.commandJournal.recordResult(journalIdentity.clientId, journalIdentity.commandId, response);
				} catch (ownershipError) {
					response = failure(command.id, command.type, ownershipError, serializeDaemonError(ownershipError));
				}
			}
			this.write(client, response);
		} finally {
			if (mutation) this.mutationDrain.end();
		}
	}

	private async handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
		cancellationAdmission?: SupervisorPromptAdmission,
	): Promise<DaemonResponse | undefined> {
		switch (command.type) {
			case "cancel_prompt_admission": {
				const admission =
					cancellationAdmission ?? this.getPromptAdmission(client, command.activeSessionId, command.admissionId);
				if (!admission) return success(command.id, command.type, { status: "unknown" as const });
				if (admission.status === "owned") return success(command.id, command.type, { status: "owned" as const });
				// A definitive cancellation never downgrades to unknown/waiting.
				if (admission.status === "cancelled") {
					return success(command.id, command.type, { status: "cancelled" as const });
				}
				if (!admission.worker || !admission.workerActiveSessionId) {
					admission.status = "cancelled";
					admission.controller.abort();
					return success(command.id, command.type, { status: "cancelled" as const });
				}
				const response = await this.forwardToWorker(admission.worker, {
					...command,
					activeSessionId: admission.workerActiveSessionId,
					admissionId: admission.workerAdmissionId,
				});
				const status =
					response.success && response.data && typeof response.data === "object" && "status" in response.data
						? (response.data as { status: "cancelled" | "owned" | "unknown" }).status
						: "unknown";
				// Re-read: a socket close may have cancelled during the round-trip (cast widens TS's pre-await narrowing).
				const current = (admission as SupervisorPromptAdmission).status;
				if (status === "owned") admission.status = "owned";
				else if (status === "cancelled") admission.status = "cancelled";
				else if (current !== "cancelled") admission.status = "waiting";
				return { ...response, id: command.id };
			}
			case "ack_result":
				this.commandJournal.acknowledge(client.id, command.commandId);
				return undefined;
			case "list":
				return this.handleList(client, command);
			case "list_saved_sessions":
				return this.handleSavedSessionList(client, command);
			case "create": {
				const worker = await this.createOrReuseWorker(this.protocolClientId(client), command);
				const requestedSummary = command.sessionPath
					? this.findSummaryInWorker(worker, command.sessionPath)
					: undefined;
				if (
					requestedSummary &&
					(requestedSummary.activeSessionId ?? requestedSummary.id) !== worker.descriptor.rootActiveSessionId
				) {
					// A create forwarded to a recovering worker still surfaces an opaque lifecycle error.
					const response = await this.forwardToWorker(worker, withoutSupervisorCreateFields(command));
					if (response.success && isSessionSummary(response.data)) {
						await this.refreshWorkerSummaries(worker);
						await this.syncAgentPeers().catch(() => undefined);
						return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
					}
					return responseWithId(response, command.id);
				}
				const summary = worker.summaries.get(worker.descriptor.rootActiveSessionId);
				if (!summary) {
					throw new Error("Session worker started without a root session");
				}
				return success(command.id, "create", this.publicSummary(worker, summary));
			}
			case "attach": {
				const attached = await this.attachClient(client, command);
				if (client.capabilities.has("chunked_snapshot")) {
					const transcript = attached.transcript;
					if (!transcript) {
						throw new Error("Session worker did not provide a snapshot transcript");
					}
					const streamedResult = this.createStreamedAttachResult(attached.result, transcript);
					try {
						this.write(client, success(command.id, "attach", streamedResult));
						void this.streamSnapshot(
							client,
							attached.worker,
							streamedResult,
							transcript,
							"attach",
							attached.releaseTranscript,
						).catch((error) =>
							this.log(
								`Failed to stream attach snapshot for ${streamedResult.activeSessionId}: ${String(error)}`,
							),
						);
					} catch (error) {
						attached.releaseTranscript?.();
						throw error;
					}
					return undefined;
				}
				return success(command.id, "attach", attached.result);
			}
			case "reattach": {
				const target = await this.findWorkerForClient(client, command.targetActiveSessionId);
				const targetActiveSessionId = target.summary.activeSessionId ?? target.summary.id;
				if (targetActiveSessionId === command.activeSessionId) {
					return success(command.id, command.type, { cancelled: false });
				}
				const targetWasAttached = client.attachedActiveSessionIds.has(targetActiveSessionId);
				const releaseSnapshotReservation = this.reserveSnapshotStream(client, targetActiveSessionId);
				let releaseTranscript: (() => void) | undefined;
				client.attachedActiveSessionIds.add(targetActiveSessionId);
				try {
					const attached = await this.attachClient(client, {
						...command,
						type: "attach",
						activeSessionId: targetActiveSessionId,
					});
					if (client.capabilities.has("chunked_snapshot")) {
						const transcript =
							attached.transcript ?? this.getOrCreateTranscriptCache(attached.worker, attached.result);
						releaseTranscript = attached.releaseTranscript;
						const streamedResult = this.createStreamedAttachResult(attached.result, transcript);
						this.write(client, success(command.id, command.type, streamedResult));
						this.detachClient(client, command.activeSessionId);
						const streaming = this.streamSnapshot(
							client,
							attached.worker,
							streamedResult,
							transcript,
							"replacement",
							releaseTranscript,
							releaseSnapshotReservation,
						);
						releaseTranscript = undefined;
						void streaming.catch((error) =>
							this.log(`Failed to stream reattach snapshot for ${targetActiveSessionId}: ${String(error)}`),
						);
						return undefined;
					}
					this.write(client, success(command.id, command.type, attached.result));
					this.detachClient(client, command.activeSessionId);
					releaseSnapshotReservation();
					return undefined;
				} catch (error) {
					releaseTranscript?.();
					if (!targetWasAttached) {
						this.detachClient(client, targetActiveSessionId);
					}
					releaseSnapshotReservation();
					throw error;
				}
			}
			case "detach":
				this.detachClient(client, command.activeSessionId);
				return success(command.id, "detach");
			case "complete_owned_session": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				if (match.worker.descriptor.ownerClientId !== this.protocolClientId(client)) {
					throw new Error("Session is not owned by this client");
				}
				if (match.worker.ownerCleanupTimer) {
					clearTimeout(match.worker.ownerCleanupTimer);
					match.worker.ownerCleanupTimer = undefined;
				}
				await this.stopWorker(match.worker, true);
				return success(command.id, command.type);
			}
			case "promote_owned_session": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				await this.promoteOwnedWorker(client, match.worker);
				return success(command.id, command.type, this.publicSummary(match.worker, match.summary));
			}
			case "retry_worker": {
				const direct = [...this.workers.values()].find(
					(worker) =>
						worker.descriptor.rootActiveSessionId === command.activeSessionId ||
						worker.descriptor.rootSessionId === command.activeSessionId,
				);
				const worker = direct ?? (await this.findWorkerForClient(client, command.activeSessionId)).worker;
				this.assertWorkerAccessibleToClient(client, worker, command.activeSessionId);
				worker.intentionalStop = false;
				worker.descriptor.stopRequestedAt = undefined;
				worker.descriptor.archiveOnStop = undefined;
				worker.descriptor.lifecycle = "recovering";
				worker.descriptor.consecutiveFailures = 0;
				this.persistWorker(worker);
				await this.recoverWorker(worker);
				if (this.workers.get(worker.descriptor.workerId)?.descriptor.lifecycle !== "ready") {
					throw new Error(worker.descriptor.lastError ?? "Session worker recovery failed");
				}
				const summary = worker.summaries.get(worker.descriptor.rootActiveSessionId);
				return success(command.id, command.type, summary ? this.publicSummary(worker, summary) : undefined);
			}
			case "restart":
				setImmediate(() => void this.shutdown(0, false, true, false, "update"));
				return success(command.id, command.type);
			case "shutdown":
				setImmediate(() => void this.shutdown(0, true, false, command.force === true, "shutdown"));
				return success(command.id, "shutdown");
			case "prepare_update_restart": {
				const manifest = await this.prepareUpdateRestart();
				return success(command.id, "prepare_update_restart", manifest);
			}
			case "agent_messages_status": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const first = [...this.workers.values()].find((worker) => this.isVisibleWorker(worker) && worker.client);
				if (!first) {
					return success(command.id, command.type, { paused: false, limits: {} });
				}
				return this.forwardToWorker(first, command);
			}
			case "agent_messages_pause":
			case "agent_messages_resume": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const responses = await Promise.all(
					[...this.workers.values()]
						.filter((worker) => this.isVisibleWorker(worker) && worker.client)
						.map((worker) => this.forwardToWorker(worker, command)),
				);
				const failed = responses.find((response) => !response.success);
				return failed ?? success(command.id, command.type, responses.find((response) => response.success)?.data);
			}
			case "cron_list": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const jobs = new Map<string, AgentCronJob>();
				const responses = await Promise.all(
					[...this.workers.values()]
						.filter(
							(worker) =>
								this.isVisibleWorker(worker) && worker.client && worker.descriptor.lifecycle === "ready",
						)
						.map((worker) =>
							this.forwardToWorker(worker, command, 5000).catch((error: unknown) =>
								failure(command.id, command.type, error, serializeDaemonError(error)),
							),
						),
				);
				for (const response of responses) {
					if (!response.success) {
						this.log(`Could not list scheduled jobs from a worker: ${response.error}`);
						continue;
					}
					for (const job of cronJobsFromResponse(response)) {
						jobs.set(job.id, job);
					}
				}
				return success(command.id, "cron_list", { jobs: sortCronJobs([...jobs.values()]) });
			}
			case "heartbeats_list": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const workers = [...this.workers.values()].filter((worker) => this.isVisibleWorker(worker));
				const heartbeats = new Map<string, AgentConnectionHeartbeat>();
				const snapshots: Array<{ heartbeats?: AgentConnectionHeartbeat[]; response?: DaemonResponse }> =
					await Promise.all(
						workers.map(async (worker) => {
							if (worker.client && worker.descriptor.lifecycle === "ready") {
								const response = await this.forwardToWorker(worker, command, 5000).catch((error: unknown) =>
									failure(command.id, command.type, error, serializeDaemonError(error)),
								);
								if (response.success) {
									const snapshot = heartbeatsFromResponse(response);
									worker.heartbeatSnapshot = snapshot;
									worker.heartbeatSnapshotStale = false;
									return { heartbeats: snapshot };
								}
								this.log(`Could not list heartbeats from a worker: ${response.error}`);
								if (worker.heartbeatSnapshot === undefined || worker.heartbeatSnapshotStale === true) {
									return { response };
								}
							}
							if (worker.heartbeatSnapshot !== undefined && worker.heartbeatSnapshotStale !== true) {
								return { heartbeats: worker.heartbeatSnapshot };
							}
							const state =
								worker.descriptor.lifecycle === "ready" ? "disconnected" : worker.descriptor.lifecycle;
							const error = new Error(`Cannot list heartbeats while session worker is ${state}`);
							return { response: failure(command.id, command.type, error, serializeDaemonError(error)) };
						}),
					);
				const failed = snapshots.find((snapshot) => snapshot.response)?.response;
				if (failed) {
					return failed;
				}
				for (const snapshot of snapshots) {
					for (const heartbeat of snapshot.heartbeats ?? []) {
						heartbeats.set(heartbeat.job.id, heartbeat);
					}
				}
				return success(command.id, "heartbeats_list", { heartbeats: [...heartbeats.values()] });
			}
			case "heartbeat_manage": {
				const cachedWorker = [...this.workers.values()].find((worker) =>
					worker.heartbeatSnapshot?.some(
						(heartbeat) =>
							heartbeat.job.id === command.jobId && heartbeat.job.activeSessionId === command.activeSessionId,
					),
				);
				const worker = cachedWorker ?? (await this.findWorkerForClient(client, command.activeSessionId)).worker;
				this.assertWorkerAccessibleToClient(client, worker, command.activeSessionId);
				const response = await this.forwardToWorker(worker, command);
				if (
					response.success &&
					response.data &&
					typeof response.data === "object" &&
					"heartbeat" in response.data
				) {
					const job = (response.data as { heartbeat?: AgentCronJob }).heartbeat;
					if (job && worker.heartbeatSnapshot) {
						const existing = worker.heartbeatSnapshot.find((heartbeat) => heartbeat.job.id === job.id);
						const remaining = worker.heartbeatSnapshot.filter((heartbeat) => heartbeat.job.id !== job.id);
						worker.heartbeatSnapshot =
							job.status === "active" || job.status === "paused"
								? [...remaining, existing ? { ...existing, job } : { job }]
								: remaining;
					}
				}
				return response;
			}
			case "cron_add": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				const response = await this.forwardToWorker(match.worker, command);
				if (response.success && command.promoteOwnedSession) {
					await this.promoteOwnedWorker(client, match.worker);
				}
				return response;
			}
			case "cron_cancel": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const listed = await Promise.all(
					[...this.workers.values()]
						.filter(
							(worker) =>
								this.isVisibleWorker(worker) && worker.client && worker.descriptor.lifecycle === "ready",
						)
						.map(async (worker) => ({
							worker,
							response: await this.forwardToWorker(
								worker,
								{ type: "cron_list", includeInactive: true },
								5000,
							).catch(() => undefined),
						})),
				);
				for (const candidate of listed) {
					if (
						candidate.response?.success &&
						cronJobsFromResponse(candidate.response).some((job) => job.id === command.jobId)
					) {
						return this.forwardToWorker(candidate.worker, command);
					}
				}
				throw new Error(`No cron job found: ${command.jobId}`);
			}
			case "heartbeat_get": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "heartbeat_set": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				const response = await this.forwardToWorker(match.worker, command);
				if (response.success && command.promoteOwnedSession) {
					await this.promoteOwnedWorker(client, match.worker);
				}
				return response;
			}
			case "heartbeat_update": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "rename_saved_session": {
				const target = await this.savedSessionNameReservationInput(command.sessionPath, command.name.trim());
				return await this.withSessionNameReservation(target, async () => {
					await this.assertSupervisorSavedSessionNameAvailable(command.sessionPath, target.name);
					if (!command.activeSessionId) {
						await this.catalog.rename(command.sessionPath, command.name);
						return success(command.id, command.type);
					}
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return await this.forwardToWorker(match.worker, {
						...command,
						activeSessionId: match.summary.activeSessionId ?? match.summary.id,
					});
				});
			}
			case "delete_saved_session":
				if (!command.activeSessionId) {
					const active = this.findWorkerBySessionFile(command.sessionPath);
					if (active) {
						throw new Error("Cannot delete the currently active session");
					}
					const result = await this.catalog.delete(command.sessionPath);
					return success(command.id, command.type, result);
				}
				break;
		}

		if (command.type === "send_message") {
			// agentOrigin without fromActiveSessionId is trusted only at the direct socket-client boundary.
			const source = command.fromActiveSessionId
				? await this.findWorkerForClient(client, command.fromActiveSessionId)
				: undefined;
			let target: WorkerMatch;
			try {
				target = await this.findWorkerForClient(client, command.targetActiveSessionId);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.startsWith("Unknown active session:")) throw error;
				const cwd = source?.summary.cwd ?? this.defaultSessionConfig.cwd ?? process.cwd();
				let sessionPath: string;
				try {
					sessionPath = await this.catalog.resolve(
						command.targetActiveSessionId,
						cwd,
						source?.worker.descriptor.createCommand.config?.sessionDir ?? this.defaultSessionConfig.sessionDir,
					);
				} catch (catalogError) {
					// Preserve selector ambiguity so a2a senders can distinguish it from
					// the original unknown-active-session lookup failure.
					if (catalogError instanceof Error && catalogError.message.startsWith("Ambiguous session selector")) {
						throw catalogError;
					}
					throw error;
				}
				if (source && command.agentOrigin === true) {
					const targetInfo = await readSessionInfo(sessionPath);
					if (!targetInfo) throw new Error(`Unknown active session: ${command.targetActiveSessionId}`);
					assertAgentFamilyReach(
						this.familyCatalogEntry(source.summary),
						this.familyCatalogEntry(summaryForInactiveSession(targetInfo)),
					);
				}
				const worker = await this.createOrReuseWorker(this.protocolClientId(client), {
					type: "create",
					sessionPath,
					continueRecent: false,
				});
				const summary =
					this.findSummaryInWorker(worker, sessionPath) ??
					worker.summaries.get(worker.descriptor.rootActiveSessionId);
				if (!summary) throw new Error("Woken session worker has no target session");
				target = { worker, summary };
			}
			const targetActiveSessionId = target.summary.activeSessionId ?? target.summary.id;
			if (source && command.agentOrigin === true) {
				assertAgentFamilyReach(this.familyCatalogEntry(source.summary), this.familyCatalogEntry(target.summary));
			}
			if (source) {
				if ((source.summary.activeSessionId ?? source.summary.id) === targetActiveSessionId) {
					throw new Error("Agent messaging cannot target the sending session");
				}
				if (!target.worker.client) {
					throw new Error("Target session worker is not connected");
				}
				const response = await target.worker.client.requestWorker(
					{
						type: "worker_deliver_message",
						targetActiveSessionId,
						message: command.message,
						sender: {
							activeSessionId: source.summary.activeSessionId ?? source.summary.id,
							sessionId: source.summary.sessionId,
							...(source.summary.sessionName ? { sessionName: source.summary.sessionName } : {}),
							runtimeKind: source.summary.runtimeKind ?? "top-level",
							clientId: client.id,
						},
					},
					WORKER_REQUEST_TIMEOUT_MS,
				);
				return { ...response, id: command.id, command: command.type };
			}
			return this.forwardToWorker(target.worker, { ...command, targetActiveSessionId });
		}

		if (!("activeSessionId" in command) || typeof command.activeSessionId !== "string") {
			throw new Error(`Supervisor cannot route daemon command: ${command.type}`);
		}
		const admission =
			(command.type === "prompt" || command.type === "prompt_and_wait") && command.admissionId
				? this.getPromptAdmission(client, command.activeSessionId, command.admissionId)
				: undefined;
		try {
			throwIfAdmissionCancelled(admission);
			const match = await waitForPromptAdmission(
				command.type === "set_session_name" && command.workerToken !== undefined
					? this.findWorker(
							command.activeSessionId,
							(worker) => worker.descriptor.authenticationToken === command.workerToken,
						)
					: this.findWorkerForClient(client, command.activeSessionId),
				admission?.controller.signal,
			);
			throwIfAdmissionCancelled(admission);
			const resolvedCommand = {
				...command,
				activeSessionId: match.summary.activeSessionId ?? match.summary.id,
				...(admission ? { admissionId: admission.workerAdmissionId } : {}),
			} as DaemonCommand;
			if (admission) {
				admission.worker = match.worker;
				admission.workerActiveSessionId = match.summary.activeSessionId ?? match.summary.id;
			}
			const isRootKill =
				command.type === "kill" &&
				(match.summary.activeSessionId ?? match.summary.id) === match.worker.descriptor.rootActiveSessionId;
			if (!isRootKill) {
				const forward = async () => {
					const response = await this.forwardToWorker(match.worker, resolvedCommand);
					if (admission && response.success) admission.status = "owned";
					return response;
				};
				if (command.type === "rename" || command.type === "set_session_name") {
					const reservation = this.summaryNameReservationInput(match.summary, command.name.trim());
					return await this.withSessionNameReservation(reservation, async () => {
						await this.assertSupervisorSessionNameAvailable(match.summary, reservation.name);
						return forward();
					});
				}
				return await forward();
			}
			this.persistWorkerStopTombstone(match.worker, true);
			let response: DaemonResponse;
			try {
				response = await this.forwardToWorker(match.worker, resolvedCommand);
			} finally {
				await this.stopWorker(match.worker, true, false, true);
			}
			return response;
		} finally {
			if (admission) this.deletePromptAdmission(admission);
		}
	}

	private async handleList(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "list" }>,
	): Promise<DaemonResponse> {
		await Promise.all(
			[...this.workers.values()].map((worker) => this.refreshWorkerSummaries(worker).catch(() => undefined)),
		);
		await this.syncAgentPeers().catch((error) => this.log(`Could not synchronize agent peers: ${String(error)}`));
		const clientOwnedWorkers = [...this.workers.values()].filter((worker) => !this.isVisibleWorker(worker));
		const active = [...this.workers.values()]
			.filter(
				(worker) =>
					this.isVisibleWorker(worker) ||
					(command.includeClientOwned === true && this.isWorkerAccessibleToClient(client, worker)),
			)
			.flatMap((worker) => [...worker.summaries.values()].map((summary) => this.publicSummary(worker, summary)));
		const busyClientOwnedSessionCount = clientOwnedWorkers
			.flatMap((worker) => [...worker.summaries.values()])
			.filter(isSessionSummaryBusy).length;
		const data = {
			sessions: active,
			...(command.includeClientOwned ? { busyClientOwnedSessionCount } : {}),
		};
		if (!command.all) {
			return success(command.id, "list", data);
		}
		const sessionDir = command.sessionDir ?? this.defaultSessionConfig.sessionDir;
		const saved = await this.catalog.list(command.cwd ? resolve(command.cwd) : undefined, sessionDir);
		return success(command.id, "list", { ...data, sessions: mergeSessionLists(active, saved) });
	}

	private async handleSavedSessionList(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "list_saved_sessions" }>,
	): Promise<DaemonResponse> {
		let cwd: string;
		let sessionDir: string | undefined;
		let activeSessionId: string | undefined;
		if ("activeSessionId" in command) {
			const match = await this.findWorkerForClient(client, command.activeSessionId);
			cwd = match.summary.cwd;
			sessionDir = this.defaultSessionConfig.sessionDir;
			activeSessionId = match.summary.activeSessionId ?? match.summary.id;
		} else {
			cwd = resolve(command.cwd);
			sessionDir = command.sessionDir;
		}
		const callbacks = command.id
			? {
					onProgress: (loaded: number, total: number) =>
						this.write(client, {
							id: command.id,
							type: "session_list_progress",
							command: "list_saved_sessions",
							...(activeSessionId ? { activeSessionId } : {}),
							loaded,
							total,
						}),
					onSession: (session: SessionInfo) =>
						this.write(client, {
							id: command.id,
							type: "session_list_item",
							command: "list_saved_sessions",
							...(activeSessionId ? { activeSessionId } : {}),
							session: serializeSavedSessionInfo(session),
						}),
				}
			: undefined;
		const saved = await this.catalog.list(command.scope === "current" ? cwd : undefined, sessionDir, callbacks);
		return success(command.id, "list_saved_sessions", { sessions: saved.map(serializeSavedSessionInfo) });
	}

	private async createOrReuseWorker(clientId: string, command: DaemonCreateCommand): Promise<ResidentWorker> {
		let createCommand = command;
		if (command.name !== undefined) {
			const normalizedName = command.name.trim();
			if (!normalizedName) {
				throw new Error("Session name cannot be empty");
			}
			createCommand = { ...command, name: normalizedName };
		}
		const ownerClientId = command.lifecycle === "client_owned" ? clientId : undefined;
		if (command.sessionPath) {
			const activeMatches = this.matchWorkers(command.sessionPath);
			if (activeMatches.length === 1) {
				return this.reuseWorkerForCreate(activeMatches[0]!.worker, ownerClientId, command.sessionPath);
			}
			if (activeMatches.length > 1) {
				throw new Error(`Ambiguous active session "${command.sessionPath}"`);
			}
			const config = mergeAgentSessionRuntimeConfig(this.defaultSessionConfig, command.config);
			const sessionPath = looksLikeSessionPath(command.sessionPath)
				? resolve(command.sessionPath)
				: await this.catalog.resolve(command.sessionPath, config.cwd ?? process.cwd(), config.sessionDir);
			createCommand = { ...createCommand, sessionPath };
			const existing = this.findWorkerBySessionFile(sessionPath);
			if (existing) {
				return this.reuseWorkerForCreate(existing.worker, ownerClientId, sessionPath);
			}
			// A passive child from a stopped worker reopens as top-level here (pre-existing behavior);
			// the recursive-harness residency/eviction PR will revisit it.
		}
		const key = createCommand.sessionPath
			? canonicalSessionPath(createCommand.sessionPath)
			: `new:${command.id ? createCommandIdempotencyKey(clientId, command.id) : createActiveSessionId()}`;
		const pending = this.openingWorkers.get(key);
		if (pending) {
			return pending;
		}
		const opening = (async () => {
			if (!createCommand.name) return this.launchWorker(createCommand, undefined, ownerClientId);
			const savedSiblings = createCommand.sessionPath ? await this.catalog.siblings(createCommand.sessionPath) : [];
			const target = savedSiblings.find(
				(session) => canonicalSessionPath(session.path) === canonicalSessionPath(createCommand.sessionPath!),
			);
			const targetSummary = target ? summaryForInactiveSession(target) : { sessionId: "new-root", rlmDepth: 0 };
			const reservation = this.summaryNameReservationInput(targetSummary, createCommand.name);
			return this.withSessionNameReservation(reservation, async () => {
				if (target?.parentSessionPath && (target.rlmDepth ?? 0) > 0) {
					this.assertSavedSiblingNameAvailable(savedSiblings, target, createCommand.name!);
				} else {
					await this.assertSupervisorSessionNameAvailable(targetSummary, createCommand.name!);
				}
				return this.launchWorker(createCommand, undefined, ownerClientId);
			});
		})();
		this.openingWorkers.set(key, opening);
		try {
			return await opening;
		} finally {
			if (this.openingWorkers.get(key) === opening) {
				this.openingWorkers.delete(key);
			}
		}
	}

	private reuseWorkerForCreate(
		worker: ResidentWorker,
		ownerClientId: string | undefined,
		sessionPath: string,
	): ResidentWorker {
		if (worker.descriptor.ownerClientId === ownerClientId) {
			return worker;
		}
		throw new SessionAlreadyActiveError(sessionPath, worker.descriptor.rootActiveSessionId);
	}

	private async promoteOwnedWorker(client: DaemonSocketClient, worker: ResidentWorker): Promise<void> {
		const clientId = this.protocolClientId(client);
		if (worker.descriptor.ownerClientId === undefined && worker.promotedOwnerClientId === clientId) {
			return;
		}
		if (worker.descriptor.ownerClientId !== clientId) {
			throw new Error("Session is not owned by this client");
		}
		const previousDescriptor = worker.descriptor;
		worker.descriptor = { ...previousDescriptor, ownerClientId: undefined };
		try {
			this.persistWorker(worker);
		} catch (error) {
			worker.descriptor = previousDescriptor;
			throw error;
		}
		worker.promotedOwnerClientId = clientId;
		if (worker.ownerCleanupTimer) {
			clearTimeout(worker.ownerCleanupTimer);
			worker.ownerCleanupTimer = undefined;
		}
		worker.launchEnv = undefined;
		await this.syncAgentPeers().catch((error) => this.log(`Could not synchronize agent peers: ${String(error)}`));
	}

	private async launchWorker(
		command: DaemonCreateCommand,
		existing?: ResidentWorker,
		ownerClientId?: string,
	): Promise<ResidentWorker> {
		await this.assertRecoveryAllowed();
		if (existing && this.isWorkerRecoveryCancelled(existing)) {
			throw new Error(`Session worker ${existing.descriptor.workerId} recovery was cancelled`);
		}
		const recoveryStopRevision = existing?.stopRevision;
		const launchEnv =
			ownerClientId || existing?.descriptor.ownerClientId ? (command.launchEnv ?? existing?.launchEnv) : undefined;
		const createCommand: DaemonCreateCommand = {
			...withoutSupervisorCreateFields(command),
			config: mergeAgentSessionRuntimeConfig(this.defaultSessionConfig, command.config),
		};
		const workerId = existing?.descriptor.workerId ?? createActiveSessionId();
		const rootActiveSessionId = existing?.descriptor.rootActiveSessionId ?? createActiveSessionId();
		const socketPath = existing?.descriptor.socketPath ?? workerSocketPath(this.socketPath, workerId);
		const token = existing?.descriptor.authenticationToken ?? randomBytes(32).toString("base64url");
		const now = new Date().toISOString();
		const descriptorPath = existing?.descriptorPath ?? join(this.descriptorDir, `${workerId}.json`);
		const recoveryJournalPath =
			existing?.descriptor.recoveryJournalPath ?? join(this.descriptorDir, `${workerId}.recovery.jsonl`);
		const orphanProcessJournalPath =
			existing?.descriptor.orphanProcessJournalPath ?? join(this.descriptorDir, `${workerId}.orphans.jsonl`);
		const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", socketPath]);
		await this.assertRecoveryAllowed();
		const child: ChildProcess = spawn(launch.command, launch.args, {
			cwd: createCommand.config?.cwd ?? process.cwd(),
			detached: true,
			env: createCliSubprocessEnv({
				...process.env,
				...launchEnv,
				[DAEMON_WORKER_ROLE_ENV]: "1",
				[DAEMON_WORKER_TOKEN_ENV]: token,
				[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: rootActiveSessionId,
				[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: this.socketPath,
				[DAEMON_WORKER_RECOVERY_JOURNAL_ENV]: recoveryJournalPath,
				[DAEMON_WORKER_STARTUP_GATE_FD_ENV]: String(WORKER_STARTUP_GATE_FD),
				[ORPHAN_PROCESS_JOURNAL_ENV]: orphanProcessJournalPath,
				[SESSION_LEASES_ENABLED_ENV]: "1",
				[SESSION_LEASE_OWNER_ID_ENV]: rootActiveSessionId,
			}),
			stdio: ["ignore", "ignore", "pipe", "pipe"],
		});
		const detachWorkerStderr = child.stderr
			? attachJsonlLineReader(child.stderr, (line) => this.log(`Session worker ${workerId} stderr: ${line}`), {
					maxLineLength: 64 * 1024,
					onLineOverflow: (prefix) => this.log(`Session worker ${workerId} stderr: ${prefix} [truncated]`),
				})
			: () => {};
		child.once("close", detachWorkerStderr);
		const childClosed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
		child.on("error", (error) => {
			this.log(
				`Session worker ${workerId} process error: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		const startupGate = child.stdio[WORKER_STARTUP_GATE_FD];
		const previousDescriptor = existing?.descriptor;
		const previousIntentionalStop = existing?.intentionalStop;
		let descriptorAssigned = false;
		let childPid: number;
		let childProcessStartId: string | undefined;
		let worker: ResidentWorker;
		try {
			if (!child.pid) {
				throw new Error("Failed to obtain daemon session worker pid");
			}
			if (!(startupGate instanceof Writable)) {
				throw new Error("Failed to create daemon session worker startup gate");
			}
			childPid = child.pid;
			childProcessStartId = getProcessStartId(childPid);
			await this.assertRecoveryAllowed();

			const descriptor: DaemonWorkerDescriptor = {
				version: 1,
				workerId,
				pid: childPid,
				...(childProcessStartId ? { processStartId: childProcessStartId } : {}),
				socketPath,
				recoveryJournalPath,
				orphanProcessJournalPath,
				supervisorSocketPath: this.socketPath,
				authenticationToken: token,
				rootActiveSessionId,
				ownerClientId: existing?.descriptor.ownerClientId ?? ownerClientId,
				createdAt: existing?.descriptor.createdAt ?? now,
				updatedAt: now,
				lifecycle: "starting",
				createCommand: { ...createCommand, id: undefined },
				consecutiveFailures: existing?.descriptor.consecutiveFailures ?? 0,
			};
			worker = existing ?? {
				descriptor,
				descriptorPath,
				summaries: new Map(),
				snapshotCache: new Map(),
				transcriptCaches: new Map(),
				snapshotGenerations: new Map(),
				snapshotLoads: new Map(),
				intentionalStop: false,
				stopRevision: 0,
				launchEnv,
			};
			await this.assertRecoveryAllowed();
			worker.descriptor = descriptor;
			worker.launchEnv = launchEnv;
			descriptorAssigned = true;
			this.persistWorker(worker);
			worker.intentionalStop = false;
			this.workers.set(workerId, worker);
		} catch (error) {
			if (startupGate instanceof Writable) {
				startupGate.destroy();
			}
			await childClosed;
			child.unref();
			try {
				rmSync(`${descriptorPath}.${process.pid}.tmp`, { force: true });
			} catch (cleanupError) {
				this.reportCleanupFailure(`worker launch temp ${workerId}`, cleanupError);
			}
			if (existing && descriptorAssigned && previousDescriptor) {
				try {
					existing.descriptor = previousDescriptor;
				} catch (cleanupError) {
					this.reportCleanupFailure(`worker launch descriptor ${workerId}`, cleanupError);
				}
			}
			throw error;
		}

		try {
			try {
				await commitWorkerStartupGate(startupGate);
			} catch (error) {
				startupGate.destroy();
				await childClosed;
				throw error;
			} finally {
				child.unref();
			}
			const client = await this.connectWorker(worker, WORKER_CONNECT_TIMEOUT_MS);
			const response = await client.request(withoutCommandId(createCommand), WORKER_REQUEST_TIMEOUT_MS);
			if (!response.success) {
				throw deserializeDaemonError(response);
			}
			if (!isSessionSummary(response.data)) {
				throw new Error("Session worker returned an invalid create response");
			}
			const summary = response.data;
			if ((summary.activeSessionId ?? summary.id) !== rootActiveSessionId) {
				throw new Error("Session worker did not preserve its assigned active session id");
			}
			worker.summaries.set(rootActiveSessionId, summary);
			worker.descriptor.rootSessionId = summary.sessionId;
			worker.descriptor.sessionFile = summary.sessionFile;
			await this.subscribeWorker(worker, rootActiveSessionId);
			await this.refreshWorkerSummaries(worker, true);
			if (existing && (this.isWorkerRecoveryCancelled(worker) || worker.stopRevision !== recoveryStopRevision)) {
				throw new Error(`Session worker ${workerId} recovery was cancelled`);
			}
			await this.assertRecoveryAllowed();
			worker.descriptor.lifecycle = "ready";
			worker.descriptor.consecutiveFailures = 0;
			worker.descriptor.lastError = undefined;
			this.persistWorker(worker);
			await this.syncAgentPeers().catch((error) => this.log(`Could not synchronize agent peers: ${String(error)}`));
			this.broadcastHeartbeatsChanged();
			return worker;
		} catch (error) {
			if (isSupervisorGenerationStale(error)) {
				throw error;
			}
			if (isSupervisorShutdownAdmissionCancelled(error)) {
				let rolledBack = false;
				try {
					await this.stopWorker(worker, existing === undefined, true, false, existing !== undefined, {
						child,
						closed: childClosed,
					});
					rolledBack = true;
				} catch (cleanupError) {
					this.reportCleanupFailure(`cancelled worker launch ${workerId}`, cleanupError);
				}
				const mappedWorker = this.workers.get(workerId);
				if (
					rolledBack &&
					existing &&
					previousDescriptor &&
					!this.shuttingDown &&
					existing.stopRevision === recoveryStopRevision &&
					existing.descriptor.stopRequestedAt === undefined &&
					(mappedWorker === undefined || mappedWorker === existing)
				) {
					existing.descriptor = previousDescriptor;
					existing.intentionalStop = previousIntentionalStop ?? false;
					this.workers.set(workerId, existing);
					try {
						this.persistWorker(existing);
					} catch (cleanupError) {
						this.reportCleanupFailure(`cancelled worker recovery ${workerId}`, cleanupError);
					}
					this.deferWorkerRecovery(existing, error instanceof Error ? error : new Error(String(error)));
				}
				throw error;
			}
			await this.assertRecoveryAllowed();
			const shouldResumeRecovery =
				existing !== undefined &&
				!this.shuttingDown &&
				worker.descriptor.stopRequestedAt === undefined &&
				worker.stopRevision === recoveryStopRevision;
			await this.stopWorker(worker, existing === undefined, true, false, existing !== undefined).catch((stopError) =>
				this.log(`Could not stop failed worker ${workerId}: ${String(stopError)}`),
			);
			if (
				shouldResumeRecovery &&
				!this.shuttingDown &&
				worker.descriptor.stopRequestedAt === undefined &&
				worker.stopRevision === recoveryStopRevision
			) {
				await this.assertRecoveryAllowed();
				worker.intentionalStop = false;
				worker.descriptor.lifecycle = "recovering";
				this.workers.set(workerId, worker);
				this.persistWorker(worker);
			}
			throw error;
		}
	}

	private async connectWorker(worker: ResidentWorker, timeoutMs: number): Promise<DaemonWorkerClient> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		while (Date.now() < deadline) {
			await this.assertRecoveryAllowed();
			const client = new DaemonWorkerClient(worker.descriptor.socketPath);
			try {
				await client.connect(Math.min(500, Math.max(50, deadline - Date.now())));
				await client.waitForHello(1000);
				await client.authenticateWorker(
					worker.descriptor.authenticationToken,
					this.supervisorAuthenticationClaim(),
					1000,
				);
				await this.assertRecoveryAllowed();
				client.onFrame((frame) => this.handleWorkerFrame(worker, frame));
				client.onClose((error) => void this.handleWorkerClose(worker, client, error));
				worker.client?.close();
				worker.client = client;
				return client;
			} catch (error) {
				lastError = error;
				client.close();
				if (isSupervisorRecoveryCancelled(error)) {
					throw error;
				}
				await delay(25);
			}
		}
		throw new Error(`Timed out connecting to daemon session worker: ${String(lastError)}`);
	}

	private async subscribeWorker(worker: ResidentWorker, activeSessionId: string): Promise<void> {
		if (!worker.client) {
			throw new Error("Session worker is not connected");
		}
		const supportsExtensionUi = [...this.clients].some(
			(client) => client.attachedActiveSessionIds.has(activeSessionId) && client.supportsExtensionUi,
		);
		const response = await worker.client.requestWorker({
			type: "worker_subscribe",
			activeSessionId,
			capabilities: supportsExtensionUi
				? ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"]
				: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			supportsExtensionUi,
		});
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	private async adoptOrRecoverWorker(worker: ResidentWorker): Promise<void> {
		await this.assertRecoveryAllowed();
		if (worker.descriptor.stopRequestedAt) {
			try {
				// A tombstoned worker must not run long enough to elect another
				// supervisor while its intentional stop is being adopted.
				signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL");
				await this.stopWorker(worker, true, true, worker.descriptor.archiveOnStop === true);
				this.log(`Completed intentional stop for worker ${worker.descriptor.workerId} during supervisor adoption`);
			} catch (error) {
				worker.descriptor.lifecycle = "failed";
				worker.descriptor.lastError = error instanceof Error ? error.message : String(error);
				this.persistWorker(worker);
				this.log(`Could not complete intentional stop for worker ${worker.descriptor.workerId}: ${String(error)}`);
			}
			return;
		}
		try {
			if (!isProcessAlive(worker.descriptor.pid)) {
				throw new Error("Session worker process is no longer running");
			}
			const observedProcessStartId = getProcessStartId(worker.descriptor.pid);
			await this.connectWorker(worker, 2000);
			await this.subscribeWorker(worker, worker.descriptor.rootActiveSessionId);
			await this.refreshWorkerSummaries(worker, true);
			if (worker.descriptor.processStartId === undefined && observedProcessStartId) {
				worker.descriptor.processStartId = observedProcessStartId;
			}
			await this.assertRecoveryAllowed();
			worker.descriptor.lifecycle = "ready";
			worker.descriptor.consecutiveFailures = 0;
			this.persistWorker(worker);
			this.broadcastHeartbeatsChanged();
		} catch (error) {
			if (isSupervisorRecoveryCancelled(error)) {
				return;
			}
			this.log(`Could not adopt worker ${worker.descriptor.workerId}: ${String(error)}`);
			await this.recoverWorker(worker);
		}
	}

	private async handleWorkerClose(worker: ResidentWorker, client: DaemonWorkerClient, error: Error): Promise<void> {
		if (worker.client !== client) {
			return;
		}
		worker.client = undefined;
		const interrupted = new Map<string, Set<string>>();
		for (const [activeSessionId, generations] of worker.snapshotGenerations ?? []) {
			for (const generation of generations.values()) {
				if (generation.incoming || !generation.transcript.complete) {
					const snapshotIds = interrupted.get(activeSessionId) ?? new Set<string>();
					snapshotIds.add(generation.transcript.snapshotId);
					interrupted.set(activeSessionId, snapshotIds);
				}
			}
		}
		for (const [activeSessionId, transcript] of worker.transcriptCaches) {
			if (!transcript.complete) {
				const snapshotIds = interrupted.get(activeSessionId) ?? new Set<string>();
				snapshotIds.add(transcript.snapshotId);
				interrupted.set(activeSessionId, snapshotIds);
			}
		}
		for (const [activeSessionId, snapshotIds] of interrupted) {
			for (const snapshotId of snapshotIds) {
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					new Error("Session worker disconnected during snapshot transfer"),
					false,
					snapshotId,
				);
			}
		}
		if (this.shuttingDown || worker.intentionalStop) {
			return;
		}
		try {
			await this.assertRecoveryAllowed();
		} catch (recoveryError) {
			if (!isSupervisorGenerationStale(recoveryError)) {
				this.deferWorkerRecovery(worker, error);
			}
			return;
		}
		if (!this.isWorkerRecoveryEligible(worker)) {
			return;
		}
		worker.descriptor.lifecycle = "recovering";
		worker.descriptor.lastError = error.message;
		this.persistWorker(worker);
		void this.syncAgentPeers().catch(() => undefined);
		void this.recoverWorker(worker);
	}

	private isWorkerRecoveryEligible(worker: ResidentWorker): boolean {
		return this.isWorkerRecoveryCandidate(worker) && worker.recovery === undefined;
	}

	private isWorkerRecoveryCandidate(worker: ResidentWorker): boolean {
		return (
			!this.shuttingDown &&
			!worker.intentionalStop &&
			worker.descriptor.stopRequestedAt === undefined &&
			this.workers.get(worker.descriptor.workerId) === worker &&
			worker.client === undefined
		);
	}

	private deferWorkerRecovery(worker: ResidentWorker, disconnectError: Error): void {
		if (worker.deferredRecovery) {
			return;
		}
		worker.deferredRecovery = this.resumeDeferredWorkerRecovery(worker, disconnectError).finally(() => {
			worker.deferredRecovery = undefined;
		});
	}

	private async resumeDeferredWorkerRecovery(worker: ResidentWorker, disconnectError: Error): Promise<void> {
		while (true) {
			await unrefDelay(DEFERRED_RECOVERY_RECHECK_MS);
			if (!this.isWorkerRecoveryCandidate(worker)) {
				return;
			}
			if (!this.isWorkerRecoveryEligible(worker)) {
				continue;
			}
			try {
				await this.assertRecoveryAllowed();
			} catch (error) {
				if (isSupervisorGenerationStale(error)) {
					return;
				}
				continue;
			}
			if (!this.isWorkerRecoveryCandidate(worker)) {
				return;
			}
			if (!this.isWorkerRecoveryEligible(worker)) {
				continue;
			}
			worker.descriptor.lifecycle = "recovering";
			worker.descriptor.lastError = disconnectError.message;
			this.persistWorker(worker);
			void this.syncAgentPeers().catch(() => undefined);
			void this.recoverWorker(worker);
			return;
		}
	}

	private failWorkerSnapshotCache(
		worker: ResidentWorker,
		activeSessionId: string,
		error: Error,
		closeWorkerChannel = false,
		expectedSnapshotId?: string,
	): void {
		const generations = worker.snapshotGenerations?.get(activeSessionId);
		if (expectedSnapshotId) {
			const generation = generations?.get(expectedSnapshotId);
			if (generation) {
				this.failSnapshotGeneration(worker, activeSessionId, generation, error);
			} else {
				const transcript = worker.transcriptCaches.get(activeSessionId);
				if (transcript?.snapshotId !== expectedSnapshotId) {
					return;
				}
				transcript.markFailed(error);
				transcript.dispose();
				worker.transcriptCaches.delete(activeSessionId);
				if (worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id === expectedSnapshotId) {
					worker.snapshotCache.delete(activeSessionId);
				}
			}
		} else {
			const failedTranscripts = new Set<SnapshotTranscriptCache>();
			for (const generation of [...(generations?.values() ?? [])]) {
				failedTranscripts.add(generation.transcript);
				this.failSnapshotGeneration(worker, activeSessionId, generation, error);
			}
			const transcript = worker.transcriptCaches.get(activeSessionId);
			if (transcript && !failedTranscripts.has(transcript)) {
				transcript.markFailed(error);
				transcript.dispose();
			}
			worker.transcriptCaches.delete(activeSessionId);
			worker.snapshotCache.delete(activeSessionId);
		}
		if (closeWorkerChannel) {
			const client = worker.client;
			if (client) {
				this.handleWorkerClose(worker, client, error);
				client.close();
			}
		}
	}

	private retireWorkerSnapshotCache(
		worker: ResidentWorker,
		activeSessionId: string,
		expectedTranscript: SnapshotTranscriptCache,
	): void {
		if (worker.transcriptCaches.get(activeSessionId) === expectedTranscript) {
			worker.transcriptCaches.delete(activeSessionId);
		}
		if (worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id === expectedTranscript.snapshotId) {
			worker.snapshotCache.delete(activeSessionId);
		}
		const generation = this.snapshotGeneration(worker, activeSessionId, expectedTranscript.snapshotId);
		if (!generation) {
			expectedTranscript.dispose();
			return;
		}
		generation.retired = true;
		this.settleSnapshotDuplicateValidation(generation);
		if (generation.incoming) {
			return;
		}
		this.deleteSnapshotGeneration(worker, activeSessionId, generation);
		expectedTranscript.dispose();
	}

	private snapshotGenerationsFor(
		worker: ResidentWorker,
		activeSessionId: string,
	): Map<string, SnapshotTranscriptGeneration> {
		worker.snapshotGenerations ??= new Map();
		let generations = worker.snapshotGenerations.get(activeSessionId);
		if (!generations) {
			generations = new Map();
			worker.snapshotGenerations.set(activeSessionId, generations);
		}
		return generations;
	}

	private snapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
		snapshotId: string,
	): SnapshotTranscriptGeneration | undefined {
		return worker.snapshotGenerations?.get(activeSessionId)?.get(snapshotId);
	}

	private currentSnapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
	): SnapshotTranscriptGeneration | undefined {
		worker.transcriptCaches ??= new Map();
		worker.snapshotCache ??= new Map();
		const transcript = worker.transcriptCaches.get(activeSessionId);
		if (!transcript) {
			return undefined;
		}
		const generations = this.snapshotGenerationsFor(worker, activeSessionId);
		let generation = generations.get(transcript.snapshotId);
		if (generation) {
			return generation;
		}
		const result = worker.snapshotCache.get(activeSessionId);
		if (!result) {
			return undefined;
		}
		generation = {
			transcript,
			result,
			incoming: false,
			retired: false,
		};
		generations.set(transcript.snapshotId, generation);
		return generation;
	}

	private deleteSnapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
		generation: SnapshotTranscriptGeneration,
	): void {
		const generations = worker.snapshotGenerations?.get(activeSessionId);
		if (!generations) {
			return;
		}
		if (generations.get(generation.transcript.snapshotId) === generation) {
			generations.delete(generation.transcript.snapshotId);
		}
		if (generations.size === 0) {
			worker.snapshotGenerations.delete(activeSessionId);
		}
	}

	private failSnapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
		generation: SnapshotTranscriptGeneration,
		error: Error,
	): void {
		this.settleSnapshotDuplicateValidation(generation, error);
		generation.transcript.markFailed(error);
		generation.transcript.dispose();
		this.deleteSnapshotGeneration(worker, activeSessionId, generation);
		if (worker.transcriptCaches.get(activeSessionId) === generation.transcript) {
			worker.transcriptCaches.delete(activeSessionId);
		}
		if (worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id === generation.transcript.snapshotId) {
			worker.snapshotCache.delete(activeSessionId);
		}
	}

	private createSnapshotDuplicateValidation(): SnapshotDuplicateValidation {
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		void promise.catch(() => undefined);
		return { promise, resolve, reject };
	}

	private settleSnapshotDuplicateValidation(generation: SnapshotTranscriptGeneration, error?: Error): void {
		const validation = generation.validation;
		if (!validation) {
			return;
		}
		generation.validation = undefined;
		if (error) {
			validation.reject(error);
		} else {
			validation.resolve();
		}
	}

	private async recoverWorker(worker: ResidentWorker): Promise<void> {
		if (this.isWorkerRecoveryCancelled(worker)) {
			return;
		}
		if (worker.descriptor.ownerClientId && !worker.launchEnv && !isProcessAlive(worker.descriptor.pid)) {
			worker.descriptor.lifecycle = "failed";
			worker.descriptor.lastError = "Waiting for the owning client to reconnect";
			this.persistWorker(worker);
			return;
		}
		if (worker.recovery) {
			return worker.recovery;
		}
		worker.recovery = (async () => {
			for (const [retryIndex, retryDelay] of WORKER_RETRY_DELAYS_MS.entries()) {
				await delay(retryDelay);
				if (this.isWorkerRecoveryCancelled(worker)) {
					return;
				}
				try {
					await this.assertRecoveryAllowed();
					const processAlive = isProcessAlive(worker.descriptor.pid);
					const observedProcessStartId = processAlive ? getProcessStartId(worker.descriptor.pid) : undefined;
					const processIdentityMatches =
						worker.descriptor.processStartId === undefined ||
						observedProcessStartId === worker.descriptor.processStartId;
					if (processAlive && processIdentityMatches) {
						try {
							await this.connectWorker(worker, 1500);
							await this.subscribeWorker(worker, worker.descriptor.rootActiveSessionId);
							await this.refreshWorkerSummaries(worker, true);
							if (this.isWorkerRecoveryCancelled(worker)) {
								return;
							}
							if (worker.descriptor.processStartId === undefined && observedProcessStartId) {
								worker.descriptor.processStartId = observedProcessStartId;
							}
							await this.assertRecoveryAllowed();
							worker.descriptor.lifecycle = "ready";
							worker.descriptor.consecutiveFailures = 0;
							this.persistWorker(worker);
							await this.syncAgentPeers().catch((error) =>
								this.log(`Could not synchronize agent peers after worker recovery: ${String(error)}`),
							);
							this.broadcastHeartbeatsChanged();
							return;
						} catch (error) {
							if (isSupervisorRecoveryCancelled(error)) {
								throw error;
							}
							await this.assertRecoveryAllowed();
							worker.client?.close();
							worker.client = undefined;
							if (retryIndex < WORKER_RETRY_DELAYS_MS.length - 1) {
								throw error;
							}
						}
					}
					if (
						processAlive &&
						(worker.descriptor.processStartId === undefined || observedProcessStartId === undefined)
					) {
						throw new Error(
							`Cannot safely replace live session worker ${worker.descriptor.workerId} without a verified process identity`,
						);
					}
					const safeToKillWorkerProcess =
						processAlive && processIdentityMatches && worker.descriptor.processStartId !== undefined;
					await this.recoverUncertainWorkerOperations(worker, safeToKillWorkerProcess);
					if (this.isWorkerRecoveryCancelled(worker)) {
						return;
					}
					await this.launchWorker(worker.descriptor.createCommand, worker);
					return;
				} catch (error) {
					if (isSupervisorRecoveryCancelled(error) || this.isWorkerRecoveryCancelled(worker)) {
						return;
					}
					try {
						await this.assertRecoveryAllowed();
					} catch {
						return;
					}
					worker.client?.close();
					worker.client = undefined;
					worker.descriptor.consecutiveFailures++;
					worker.descriptor.lastFailureAt = new Date().toISOString();
					worker.descriptor.lastError = error instanceof Error ? error.message : String(error);
					this.persistWorker(worker);
				}
			}
			try {
				await this.assertRecoveryAllowed();
			} catch {
				return;
			}
			worker.descriptor.lifecycle = "failed";
			this.persistWorker(worker);
			await this.syncAgentPeers().catch(() => undefined);
			this.log(`Worker ${worker.descriptor.workerId} failed after three recovery attempts`);
		})().finally(() => {
			worker.recovery = undefined;
		});
		return worker.recovery;
	}

	private isWorkerRecoveryCancelled(worker: ResidentWorker): boolean {
		return (
			this.shuttingDown ||
			worker.intentionalStop ||
			worker.descriptor.stopRequestedAt !== undefined ||
			this.workers.get(worker.descriptor.workerId) !== worker
		);
	}

	private async recoverUncertainWorkerOperations(worker: ResidentWorker, killWorkerProcess = true): Promise<void> {
		await this.assertRecoveryAllowed();
		if (killWorkerProcess) {
			// Recovery needs the catalog to record interrupted work. Do not terminate a
			// still-recoverable worker until that dependency is ready.
			await this.catalog.start();
			await this.assertRecoveryAllowed();
			signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL");
		}
		const orphanProcessJournalPath = worker.descriptor.orphanProcessJournalPath;
		if (orphanProcessJournalPath) {
			try {
				for (const orphan of readActiveOrphanProcesses(orphanProcessJournalPath, worker.descriptor.pid)) {
					if (!isOrphanProcessIdentityCurrent(orphan)) {
						continue;
					}
					const { pid } = orphan;
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// The detached resource may already have exited.
						}
					}
				}
				clearOrphanProcessJournal(orphanProcessJournalPath);
			} catch (error) {
				this.log(`Could not reap orphaned worker resources: ${String(error)}`);
			}
		}
		const journal = new WorkerRecoveryJournal(worker.descriptor.recoveryJournalPath);
		const latest = journal.getLatest();
		const uncertain = latest.filter((record) => record.busy);
		if (uncertain.length === 0) {
			return;
		}
		const interruptedSessions = new Map<
			string,
			{ activeSessionId: string; sessionFile: string; operations: Set<string> }
		>();
		for (const record of uncertain) {
			const sessionFile =
				record.sessionFile ??
				(record.activeSessionId === worker.descriptor.rootActiveSessionId
					? worker.descriptor.sessionFile
					: undefined);
			if (!sessionFile) {
				continue;
			}
			const key = `${record.activeSessionId}\0${sessionFile}`;
			let interrupted = interruptedSessions.get(key);
			if (!interrupted) {
				interrupted = { activeSessionId: record.activeSessionId, sessionFile, operations: new Set() };
				interruptedSessions.set(key, interrupted);
			}
			interrupted.operations.add(record.operation);
		}
		await this.assertRecoveryAllowed();
		await Promise.all(
			[...interruptedSessions.values()].map((interrupted) =>
				this.catalog.markInterrupted(interrupted.sessionFile, interrupted.activeSessionId, [
					...interrupted.operations,
				]),
			),
		);
		await this.assertRecoveryAllowed();
		for (const record of latest) {
			journal.record({
				activeSessionId: record.activeSessionId,
				sessionId: record.sessionId,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				busy: false,
				operation: "recovery_hold",
			});
		}
		this.log(
			`Recovered worker ${worker.descriptor.workerId} without replaying uncertain operations: ${uncertain
				.map((record) => record.operation)
				.join(", ")}`,
		);
	}

	private async refreshWorkerSummaries(worker: ResidentWorker, recovery = false): Promise<void> {
		if (!worker.client) {
			throw new Error("Session worker is not connected");
		}
		const response = await worker.client.request({ type: "list" }, 5000);
		const summaries = sessionSummariesFromResponse(response);
		worker.summaries = new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary]));
		for (const summary of summaries) {
			const activeSessionId = summary.activeSessionId ?? summary.id;
			if (summary.streamingMessage?.role === "assistant") {
				this.streamReconstructor.seed(activeSessionId, summary.streamingMessage);
			} else if (!summary.isStreaming) {
				this.streamReconstructor.clear(activeSessionId);
			}
		}
		const root = worker.summaries.get(worker.descriptor.rootActiveSessionId);
		if (root) {
			if (recovery) {
				await this.assertRecoveryAllowed();
			}
			worker.descriptor.rootSessionId = root.sessionId;
			worker.descriptor.sessionFile = root.sessionFile;
			worker.descriptor.createCommand = {
				...worker.descriptor.createCommand,
				sessionPath: root.sessionFile,
				continueRecent: false,
				config: {
					...worker.descriptor.createCommand.config,
					cwd: root.cwd,
				},
			};
			this.persistWorker(worker);
		}
	}

	private async familyCatalogEntries(): Promise<AgentFamilyCatalogEntry[]> {
		const active = [...this.workers.values()].flatMap((worker) => [...worker.summaries.values()]);
		const activePaths = new Set(
			active.flatMap((summary) => (summary.sessionFile ? [canonicalSessionPath(summary.sessionFile)] : [])),
		);
		const savedRoots = (await this.catalog.list()).filter(
			(info) =>
				(info.rlmDepth ?? (info.parentSessionPath ? -1 : 0)) === 0 &&
				!activePaths.has(canonicalSessionPath(info.path)),
		);
		return [...active, ...savedRoots.map((info) => summaryForInactiveSession(info))].map((summary) =>
			this.familyCatalogEntry(summary),
		);
	}

	private async withSessionNameReservation<T>(
		input: { name: string; depth: number; parentSessionId?: string; parentSessionPath?: string },
		action: () => Promise<T>,
	): Promise<T> {
		const key = sessionNameReservationKey(input);
		if (this.pendingSessionNames.has(key)) {
			throw new Error(formatAgentSessionNameUnavailable(input.name, input.depth));
		}
		this.pendingSessionNames.add(key);
		try {
			return await action();
		} finally {
			this.pendingSessionNames.delete(key);
		}
	}

	private async assertSupervisorSessionNameAvailable(
		target: Pick<SessionSummary, "sessionId" | "rlmDepth" | "parentSessionId" | "parentSessionPath">,
		name: string,
	): Promise<void> {
		assertAgentSessionNameAvailable(await this.familyCatalogEntries(), {
			name,
			depth: target.rlmDepth ?? 0,
			parentSessionId: target.parentSessionId,
			parentSessionPath: target.parentSessionPath ? canonicalSessionPath(target.parentSessionPath) : undefined,
			ignoreSessionId: target.sessionId,
		});
	}

	private async savedSessionNameReservationInput(
		sessionPath: string,
		name: string,
	): Promise<{ name: string; depth: number; parentSessionId?: string; parentSessionPath?: string }> {
		const targetPath = canonicalSessionPath(sessionPath);
		const active = [...this.workers.values()]
			.flatMap((worker) => [...worker.summaries.values()])
			.find((summary) => summary.sessionFile && canonicalSessionPath(summary.sessionFile) === targetPath);
		if (active) return this.summaryNameReservationInput(active, name);
		const siblings = await this.catalog.siblings(sessionPath);
		const saved = siblings.find((info) => canonicalSessionPath(info.path) === targetPath);
		if (!saved) throw new Error(`Session not found: ${sessionPath}`);
		return {
			name,
			depth: saved.rlmDepth ?? siblings.find((sibling) => sibling.rlmDepth !== undefined)?.rlmDepth ?? 0,
			parentSessionPath: saved.parentSessionPath,
		};
	}

	private summaryNameReservationInput(
		target: Pick<SessionSummary, "rlmDepth" | "parentSessionId" | "parentSessionPath">,
		name: string,
	): { name: string; depth: number; parentSessionId?: string; parentSessionPath?: string } {
		const depth = target.rlmDepth ?? (target.parentSessionPath ? 1 : 0);
		return {
			name,
			depth,
			...(depth > 0 && target.parentSessionId ? { parentSessionId: target.parentSessionId } : {}),
			...(depth > 0 && target.parentSessionPath ? { parentSessionPath: target.parentSessionPath } : {}),
		};
	}

	private async assertSupervisorSavedSessionNameAvailable(sessionPath: string, name: string): Promise<void> {
		const targetPath = canonicalSessionPath(sessionPath);
		const active = [...this.workers.values()]
			.flatMap((worker) => [...worker.summaries.values()])
			.find((summary) => summary.sessionFile && canonicalSessionPath(summary.sessionFile) === targetPath);
		if (active) return this.assertSupervisorSessionNameAvailable(active, name);
		const siblings = await this.catalog.siblings(sessionPath);
		const saved = siblings.find((info) => canonicalSessionPath(info.path) === targetPath);
		if (!saved) throw new Error(`Session not found: ${sessionPath}`);
		if (saved.parentSessionPath && (saved.rlmDepth ?? 0) > 0) {
			this.assertSavedSiblingNameAvailable(siblings, saved, name);
		} else {
			await this.assertSupervisorSessionNameAvailable(summaryForInactiveSession(saved), name);
		}
	}

	private assertSavedSiblingNameAvailable(siblings: SessionInfo[], target: SessionInfo, name: string): void {
		const setDepth = target.rlmDepth ?? siblings.find((sibling) => sibling.rlmDepth !== undefined)?.rlmDepth ?? 0;
		assertAgentSessionNameAvailable(
			siblings.map((info) => {
				const summary = summaryForInactiveSession(info);
				return {
					id: summary.sessionId,
					...(summary.sessionName ? { name: summary.sessionName } : {}),
					depth: setDepth,
					status: classifySessionRosterStatus(summary),
					...(summary.parentSessionPath
						? { parentSessionPath: canonicalSessionPath(summary.parentSessionPath) }
						: {}),
				};
			}),
			{
				name,
				depth: setDepth,
				parentSessionPath: target.parentSessionPath ? canonicalSessionPath(target.parentSessionPath) : undefined,
				ignoreSessionId: target.id,
			},
		);
	}

	private syncAgentPeers(): Promise<void> {
		const sync = this.agentPeerSyncQueue
			.catch(() => undefined)
			.then(async () => {
				const readyWorkers = [...this.workers.values()].filter(
					(worker): worker is ResidentWorker & { client: DaemonWorkerClient } =>
						this.isVisibleWorker(worker) &&
						worker.descriptor.lifecycle === "ready" &&
						worker.client !== undefined,
				);
				await Promise.all(
					readyWorkers.map(async (worker) => {
						const peers = [
							...readyWorkers
								.filter((candidate) => candidate !== worker)
								.flatMap((candidate) => {
									const root = candidate.summaries.get(candidate.descriptor.rootActiveSessionId);
									return root ? [this.agentPeerSummary(root)] : [];
								}),
						];
						const response = await worker.client.requestWorker({ type: "worker_sync_agent_peers", peers }, 5000);
						if (!response.success) {
							throw new Error(response.error);
						}
					}),
				);
			});
		this.agentPeerSyncQueue = sync;
		return sync;
	}

	private isVisibleWorker(worker: ResidentWorker): boolean {
		return worker.descriptor.ownerClientId === undefined;
	}

	private familyCatalogEntry(summary: SessionSummary): AgentFamilyCatalogEntry {
		const depth = summary.rlmDepth ?? (summary.parentSessionPath ? 1 : 0);
		return {
			id: summary.sessionId,
			...(summary.sessionName ? { name: summary.sessionName } : {}),
			depth,
			status: classifySessionRosterStatus(summary),
			...(depth > 0 && summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
			...(depth > 0 && summary.parentSessionPath
				? { parentSessionPath: canonicalSessionPath(summary.parentSessionPath) }
				: {}),
			...(summary.sessionFile ? { sessionPath: canonicalSessionPath(summary.sessionFile) } : {}),
		};
	}

	private agentPeerSummary(summary: SessionSummary): AgentSessionMessageAgentSummary {
		return {
			activeSessionId: summary.activeSessionId ?? summary.id,
			sessionId: summary.sessionId,
			...(summary.sessionName ? { sessionName: summary.sessionName } : {}),
			runtimeKind: summary.runtimeKind ?? "top-level",
			cwd: summary.cwd,
			isStreaming: summary.isStreaming,
			unfinishedActionCount:
				summary.unfinishedActionCount ??
				(summary.sessionActions.active
					? 1 + summary.sessionActions.queuedCount
					: summary.sessionActions.queuedCount),
			...(summary.parentActiveSessionId ? { parentActiveSessionId: summary.parentActiveSessionId } : {}),
			...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
			...(summary.parentSessionPath ? { parentSessionPath: summary.parentSessionPath } : {}),
			...(summary.sessionFile ? { sessionPath: summary.sessionFile } : {}),
			...(summary.rlmDepth !== undefined ? { rlmDepth: summary.rlmDepth } : {}),
			status: classifySessionRosterStatus(summary),
			...(summary.rlmChildId ? { rlmChildId: summary.rlmChildId } : {}),
		};
	}

	private publicSummary(worker: ResidentWorker, summary: SessionSummary): SessionSummary {
		const activeSessionId = summary.activeSessionId ?? summary.id;
		return {
			...summary,
			attachedClients: [...this.clients].filter((client) => client.attachedActiveSessionIds.has(activeSessionId))
				.length,
			workerState: worker.descriptor.lifecycle,
			workerPid: worker.descriptor.pid,
		};
	}

	private async findWorker(
		selector: string,
		includeWorker?: (worker: ResidentWorker) => boolean,
	): Promise<WorkerMatch> {
		let matches = this.matchWorkers(selector, includeWorker);
		if (matches.length === 0) {
			await Promise.all(
				[...this.workers.values()].map((worker) => this.refreshWorkerSummaries(worker).catch(() => undefined)),
			);
			matches = this.matchWorkers(selector, includeWorker);
		}
		if (matches.length === 1) {
			return matches[0]!;
		}
		if (matches.length > 1) {
			throw new Error(`Ambiguous active session "${selector}"`);
		}
		throw new Error(`Unknown active session: ${selector}`);
	}

	private findWorkerForClient(client: DaemonSocketClient, selector: string): Promise<WorkerMatch> {
		return this.findWorker(selector, (worker) => this.isWorkerAccessibleToClient(client, worker));
	}

	private isWorkerAccessibleToClient(client: DaemonSocketClient, worker: ResidentWorker): boolean {
		return (
			worker.descriptor.ownerClientId === undefined ||
			worker.descriptor.ownerClientId === this.protocolClientId(client)
		);
	}

	private assertWorkerAccessibleToClient(client: DaemonSocketClient, worker: ResidentWorker, selector: string): void {
		if (!this.isWorkerAccessibleToClient(client, worker)) {
			throw new Error(`Unknown active session: ${selector}`);
		}
	}

	private matchWorkers(selector: string, includeWorker?: (worker: ResidentWorker) => boolean): WorkerMatch[] {
		const exact: WorkerMatch[] = [];
		const suffix: WorkerMatch[] = [];
		for (const worker of this.workers.values()) {
			if (includeWorker && !includeWorker(worker)) {
				continue;
			}
			for (const summary of worker.summaries.values()) {
				const activeSessionId = summary.activeSessionId ?? summary.id;
				const match = { worker, summary };
				if (activeSessionId === selector || summary.sessionId === selector || summary.sessionName === selector) {
					exact.push(match);
				} else if (
					matchesSessionIdSuffix(activeSessionId, selector) ||
					matchesSessionIdSuffix(summary.sessionId, selector)
				) {
					suffix.push(match);
				}
			}
		}
		return exact.length > 0 ? exact : suffix;
	}

	private findSummaryInWorker(worker: ResidentWorker, selector: string): SessionSummary | undefined {
		const pathSelector = looksLikeSessionPath(selector) ? canonicalSessionPath(selector) : undefined;
		const summaries = [...worker.summaries.values()];
		const exact = summaries.find((summary) => {
			const activeSessionId = summary.activeSessionId ?? summary.id;
			return (
				activeSessionId === selector ||
				summary.sessionId === selector ||
				summary.sessionName === selector ||
				(pathSelector !== undefined &&
					summary.sessionFile !== undefined &&
					canonicalSessionPath(summary.sessionFile) === pathSelector)
			);
		});
		if (exact) return exact;
		return summaries.find((summary) => {
			const activeSessionId = summary.activeSessionId ?? summary.id;
			return (
				matchesSessionIdSuffix(activeSessionId, selector) || matchesSessionIdSuffix(summary.sessionId, selector)
			);
		});
	}

	private findWorkerBySessionFile(sessionFile: string): WorkerMatch | undefined {
		const target = canonicalSessionPath(sessionFile);
		for (const worker of this.workers.values()) {
			for (const summary of worker.summaries.values()) {
				if (summary.sessionFile && canonicalSessionPath(summary.sessionFile) === target) {
					return { worker, summary };
				}
			}
		}
		return undefined;
	}

	private async forwardToWorker(
		worker: ResidentWorker,
		command: DaemonCommand,
		timeoutMs = WORKER_REQUEST_TIMEOUT_MS,
	): Promise<DaemonResponse> {
		if (!worker.client || worker.descriptor.lifecycle !== "ready") {
			throw new Error(`Session worker is ${worker.descriptor.lifecycle}`);
		}
		const response = await worker.client.request(withoutCommandId(command), timeoutMs);
		if (command.type === "get_state" && response.success && isSessionSummary(response.data)) {
			return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
		}
		if (command.type === "rename" && response.success && isSessionSummary(response.data)) {
			await this.refreshWorkerSummaries(worker);
			return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
		}
		return responseWithId(response, command.id);
	}

	private async attachClient(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "attach" }>,
	): Promise<WorkerAttachData> {
		const ownedWorker = [...this.workers.values()].find(
			(worker) =>
				worker.descriptor.ownerClientId !== undefined &&
				(worker.descriptor.rootActiveSessionId === command.activeSessionId ||
					worker.descriptor.rootSessionId === command.activeSessionId),
		);
		if (ownedWorker) {
			if (ownedWorker.descriptor.ownerClientId !== this.protocolClientId(client)) {
				throw new Error(`Unknown active session: ${command.activeSessionId}`);
			}
			this.assertTelemetryAttachAllowed(ownedWorker, command.telemetryDisabled);
			ownedWorker.launchEnv = command.launchEnv ?? ownedWorker.launchEnv;
			if (!ownedWorker.client || ownedWorker.descriptor.lifecycle !== "ready") {
				if (!ownedWorker.launchEnv) {
					throw new Error("Client-owned session recovery requires the owning client environment");
				}
				ownedWorker.intentionalStop = false;
				ownedWorker.descriptor.stopRequestedAt = undefined;
				ownedWorker.descriptor.archiveOnStop = undefined;
				ownedWorker.descriptor.lifecycle = "recovering";
				ownedWorker.descriptor.consecutiveFailures = 0;
				this.persistWorker(ownedWorker);
				await this.recoverWorker(ownedWorker);
			}
		}
		const match = await this.findWorkerForClient(client, command.activeSessionId);
		this.assertTelemetryAttachAllowed(match.worker, command.telemetryDisabled);
		const activeSessionId = match.summary.activeSessionId ?? match.summary.id;
		const duplicateValidation = this.currentSnapshotGeneration(match.worker, activeSessionId)?.validation;
		if (duplicateValidation) {
			await duplicateValidation.promise;
		}
		if (command.clientId) {
			client.id = command.clientId;
		}
		client.capabilities = normalizeCapabilities(command.capabilities, command.supportsExtensionUi);
		client.supportsExtensionUi = client.capabilities.has("extension_ui");

		let result = match.worker.snapshotCache.get(activeSessionId);
		if (
			result &&
			!client.capabilities.has("chunked_snapshot") &&
			result.snapshot.messages.length < result.snapshot.summary.messageCount
		) {
			result = undefined;
		}
		if (!result) {
			const snapshotLoadKey = `${activeSessionId}:${client.capabilities.has("chunked_snapshot") ? "chunked" : "full"}`;
			let retryInvalidatedLoad = true;
			while (!result) {
				let loading = match.worker.snapshotLoads.get(snapshotLoadKey);
				if (!loading) {
					const observedSnapshotId =
						match.worker.transcriptCaches.get(activeSessionId)?.snapshotId ??
						match.worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id;
					loading = (async () => {
						if (!match.worker.client) {
							throw new Error("Session worker is not connected");
						}
						const response = await match.worker.client.request({
							type: "attach",
							activeSessionId,
							capabilities: client.capabilities.has("chunked_snapshot")
								? ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"]
								: ["attach_snapshot", "event_sequence", "slim_attach"],
							supportsExtensionUi: false,
							env: command.env ?? collectDaemonClientEnv(),
						});
						const loaded = attachResultFromResponse(response);
						if (match.worker.snapshotLoads.get(snapshotLoadKey) !== loading) {
							throw new SnapshotLoadInvalidatedError("Session snapshot changed during attach");
						}
						return this.cacheLoadedSnapshot(match.worker, activeSessionId, loaded, observedSnapshotId);
					})();
					match.worker.snapshotLoads.set(snapshotLoadKey, loading);
					void loading.then(
						async (loaded) => {
							try {
								const snapshotId = loaded.snapshotStream?.id;
								const transcript = snapshotId
									? this.snapshotGeneration(match.worker, loaded.activeSessionId, snapshotId)?.transcript
									: undefined;
								if (transcript && !transcript.complete) {
									let chunkIndex = 0;
									while (await transcript.waitForChunk(chunkIndex)) {
										chunkIndex++;
									}
								}
							} catch {
								// Failed transfers must allow a fresh snapshot request.
							} finally {
								if (match.worker.snapshotLoads.get(snapshotLoadKey) === loading) {
									match.worker.snapshotLoads.delete(snapshotLoadKey);
								}
							}
						},
						() => {
							if (match.worker.snapshotLoads.get(snapshotLoadKey) === loading) {
								match.worker.snapshotLoads.delete(snapshotLoadKey);
							}
						},
					);
				}
				try {
					result = await loading;
				} catch (error) {
					if (!(error instanceof SnapshotLoadInvalidatedError)) {
						throw error;
					}
					if (!retryInvalidatedLoad) {
						throw error;
					}
					retryInvalidatedLoad = false;
				}
			}
		}
		const wasAttached = client.attachedActiveSessionIds.has(activeSessionId);
		let transcript: SnapshotTranscriptCache | undefined;
		if (client.capabilities.has("chunked_snapshot")) {
			while (true) {
				const validation = this.currentSnapshotGeneration(match.worker, activeSessionId)?.validation;
				if (validation) {
					await validation.promise;
					continue;
				}
				result = match.worker.snapshotCache.get(activeSessionId) ?? result;
				transcript = this.getOrCreateTranscriptCache(match.worker, result);
				break;
			}
		}
		const releaseTranscript = transcript?.retain();
		client.attachedActiveSessionIds.add(activeSessionId);
		try {
			const publicSummary = this.publicSummary(match.worker, result.snapshot.summary);
			if (publicSummary.streamingMessage?.role === "assistant") {
				this.streamReconstructor.seed(activeSessionId, publicSummary.streamingMessage);
			} else {
				for (let index = result.snapshot.messages.length - 1; index >= 0; index--) {
					const latestMessage = result.snapshot.messages[index];
					if (latestMessage?.role === "assistant") {
						this.streamReconstructor.seed(activeSessionId, latestMessage);
						break;
					}
				}
			}
			const publicResult: DaemonAttachResult = {
				...result,
				state: result.state ? publicSummary : undefined,
				snapshot: { ...result.snapshot, summary: publicSummary },
				client: { id: client.id, capabilities: [...client.capabilities] },
			};
			if (publicResult.state && publicResult.messages) {
				this.write(client, {
					type: "session_attached",
					activeSessionId,
					state: publicResult.state,
					messages: publicResult.messages,
					snapshot: publicResult.snapshot,
					replay: publicResult.replay,
					lastEventSequence: publicResult.lastEventSequence,
				});
			}
			void this.syncWorkerExtensionUi(activeSessionId);
			return { result: publicResult, worker: match.worker, transcript, releaseTranscript };
		} catch (error) {
			releaseTranscript?.();
			if (!wasAttached) {
				client.attachedActiveSessionIds.delete(activeSessionId);
			}
			throw error;
		}
	}

	private assertTelemetryAttachAllowed(worker: ResidentWorker, telemetryDisabled: true | undefined): void {
		if (telemetryDisabled && worker.descriptor.createCommand.config?.telemetryDisabled !== true) {
			throw new Error(
				"Cannot attach to this active agent while telemetry is disabled for the current invocation. Stop the agent and retry so it can restart without telemetry.",
			);
		}
	}

	private cacheLoadedSnapshot(
		worker: ResidentWorker,
		activeSessionId: string,
		loaded: DaemonAttachResult,
		observedSnapshotId: string | undefined,
	): DaemonAttachResult {
		const currentTranscript = worker.transcriptCaches.get(activeSessionId);
		const currentGeneration = this.currentSnapshotGeneration(worker, activeSessionId);
		const currentResult = currentGeneration?.result ?? worker.snapshotCache.get(activeSessionId);
		const currentSnapshotId = currentTranscript?.snapshotId ?? currentResult?.snapshotStream?.id;
		const loadedSnapshotId = loaded.snapshotStream?.id;
		if (!loaded.snapshotStream) {
			if (currentSnapshotId && currentSnapshotId !== observedSnapshotId) {
				return loaded;
			}
			worker.snapshotCache.set(activeSessionId, loaded);
			return loaded;
		}
		if (
			currentSnapshotId &&
			currentSnapshotId !== loadedSnapshotId &&
			(currentSnapshotId !== observedSnapshotId ||
				(currentResult?.lastEventSequence ?? -1) > loaded.lastEventSequence)
		) {
			return currentResult ?? loaded;
		}
		let transcript = currentTranscript;
		if (transcript && transcript.snapshotId !== loaded.snapshotStream.id) {
			this.retireWorkerSnapshotCache(worker, activeSessionId, transcript);
			transcript = undefined;
		}
		const generations = this.snapshotGenerationsFor(worker, activeSessionId);
		let generation = generations.get(loaded.snapshotStream.id);
		if (!transcript) {
			transcript = generation?.transcript;
		}
		if (!transcript) {
			transcript = new SnapshotTranscriptCache({
				activeSessionId,
				snapshotId: loaded.snapshotStream.id,
				cacheRoot: this.snapshotCacheRoot,
				targetChunkBytes: loaded.snapshotStream.targetChunkBytes,
			});
		}
		if (!generation) {
			generation = {
				transcript,
				result: loaded,
				incoming: false,
				retired: false,
			};
			generations.set(loaded.snapshotStream.id, generation);
		} else {
			generation.result = loaded;
			generation.retired = false;
		}
		worker.transcriptCaches.set(activeSessionId, transcript);
		worker.snapshotCache.set(activeSessionId, loaded);
		return loaded;
	}

	private getOrCreateTranscriptCache(worker: ResidentWorker, result: DaemonAttachResult): SnapshotTranscriptCache {
		const activeSessionId = result.activeSessionId;
		const existing = worker.transcriptCaches.get(activeSessionId);
		if (existing && (!result.snapshotStream || existing.snapshotId === result.snapshotStream.id)) {
			return existing;
		}
		if (result.snapshot.messages.length < result.snapshot.summary.messageCount) {
			throw new Error("Session snapshot generation changed before its transcript could be selected");
		}
		if (existing) {
			this.retireWorkerSnapshotCache(worker, activeSessionId, existing);
		}
		const revision = createHash("sha256")
			.update(
				`${activeSessionId}:${result.snapshot.summary.sessionId}:${result.lastEventSequence}:${result.snapshot.messages.length}`,
			)
			.digest("hex")
			.slice(0, 16);
		const transcript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: `${activeSessionId}-${revision}`,
			messages: result.snapshot.messages,
			cacheRoot: this.snapshotCacheRoot,
			targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
		});
		worker.transcriptCaches.set(activeSessionId, transcript);
		const cachedResult = {
			...result,
			messages: result.messages ? [] : undefined,
			snapshot: { ...result.snapshot, messages: [] },
		};
		worker.snapshotCache.set(activeSessionId, cachedResult);
		this.snapshotGenerationsFor(worker, activeSessionId).set(transcript.snapshotId, {
			transcript,
			result: cachedResult,
			incoming: false,
			retired: false,
		});
		return transcript;
	}

	private createStreamedAttachResult(
		result: DaemonAttachResult,
		transcript: SnapshotTranscriptCache,
	): DaemonAttachResult {
		return {
			...result,
			messages: result.messages ? [] : undefined,
			snapshot: { ...result.snapshot, messages: [] },
			snapshotStream: {
				id: transcript.snapshotId,
				messageCount: result.snapshot.summary.messageCount,
				targetChunkBytes: transcript.targetChunkBytes,
			},
		};
	}

	private async streamSnapshot(
		client: DaemonSocketClient,
		worker: ResidentWorker,
		result: DaemonAttachResult,
		transcript: SnapshotTranscriptCache,
		purpose: "attach" | "replacement" | "resync" = "attach",
		retainedTranscriptRelease?: () => void,
		releaseSnapshotReservation = this.reserveSnapshotStream(client, result.activeSessionId),
	): Promise<void> {
		const stream = result.snapshotStream;
		const releaseTranscript = retainedTranscriptRelease ?? transcript.retain();
		if (!stream || client.socket.destroyed) {
			releaseSnapshotReservation();
			releaseTranscript();
			return;
		}
		const { messages: _messages, ...snapshotHeader } = result.snapshot;
		try {
			if (
				!(await this.writeSnapshotRecord(client, {
					type: "session_snapshot_begin",
					activeSessionId: result.activeSessionId,
					snapshotId: stream.id,
					snapshot: snapshotHeader,
					messageCount: stream.messageCount,
					targetChunkBytes: stream.targetChunkBytes,
					purpose,
				}))
			) {
				return;
			}
			let chunkCount = 0;
			while (true) {
				let chunk: Buffer | undefined;
				try {
					chunk = await transcript.waitForChunk(chunkCount);
				} catch (error) {
					const streamError = error instanceof Error ? error : new Error(String(error));
					this.failWorkerSnapshotCache(worker, result.activeSessionId, streamError, false, stream.id);
					throw streamError;
				}
				if (!chunk) {
					break;
				}
				if (!(await this.writeSnapshotBuffer(client, chunk))) {
					return;
				}
				chunkCount++;
			}
			await this.writeSnapshotRecord(client, {
				type: "session_snapshot_end",
				activeSessionId: result.activeSessionId,
				snapshotId: stream.id,
				chunkCount,
				lastEventSequence: result.lastEventSequence,
				lastEventCursor: result.lastEventCursor,
			});
		} catch (error) {
			const streamError = error instanceof Error ? error : new Error(String(error));
			if (!client.socket.destroyed) {
				try {
					const delivered = await this.writeSnapshotRecord(client, {
						type: "session_snapshot_failed",
						activeSessionId: result.activeSessionId,
						snapshotId: stream.id,
						error: streamError.message,
					});
					if (!delivered && !client.socket.destroyed) {
						client.socket.destroy(streamError);
					}
				} catch (deliveryError) {
					client.socket.destroy(deliveryError instanceof Error ? deliveryError : new Error(String(deliveryError)));
				}
			}
			throw streamError;
		} finally {
			releaseSnapshotReservation();
			releaseTranscript();
		}
	}

	private reserveSnapshotStream(client: DaemonSocketClient, activeSessionId: string): () => void {
		client.snapshotStreaming = true;
		client.snapshotActiveSessionIds ??= new Set();
		client.snapshotActiveSessionIds.add(activeSessionId);
		client.snapshotActiveSessionCounts ??= new Map();
		client.snapshotActiveSessionCounts.set(
			activeSessionId,
			(client.snapshotActiveSessionCounts.get(activeSessionId) ?? 0) + 1,
		);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const streamCount = client.snapshotActiveSessionCounts?.get(activeSessionId) ?? 1;
			if (streamCount > 1) {
				client.snapshotActiveSessionCounts?.set(activeSessionId, streamCount - 1);
			} else {
				client.snapshotActiveSessionCounts?.delete(activeSessionId);
				client.snapshotActiveSessionIds?.delete(activeSessionId);
			}
			client.snapshotStreaming = (client.snapshotActiveSessionIds?.size ?? 0) > 0;
			if (!client.snapshotStreaming) {
				client.backpressured = false;
			}
			if (!client.snapshotStreaming && client.catchupActiveSessionIds?.size) {
				void this.catchUpClient(client).catch((error) =>
					this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
				);
			}
		};
	}

	private writeSnapshotRecord(client: DaemonSocketClient, message: DaemonOutbound): Promise<boolean> {
		return this.writeSnapshotBuffer(client, Buffer.from(serializeJsonLine(message)));
	}

	private async writeSnapshotBuffer(client: DaemonSocketClient, buffer: Uint8Array): Promise<boolean> {
		if (client.socket.destroyed) {
			return false;
		}
		if (this.writeSerialized(client, buffer)) {
			return true;
		}
		return new Promise<boolean>((resolveDrain) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				client.socket.off("drain", onDrain);
				client.socket.off("close", onClose);
				client.socket.off("error", onClose);
				resolveDrain(value);
			};
			const onDrain = () => finish(true);
			const onClose = () => finish(false);
			client.socket.once("drain", onDrain);
			client.socket.once("close", onClose);
			client.socket.once("error", onClose);
		});
	}

	private detachClient(client: DaemonSocketClient, activeSessionId?: string): void {
		const targets = activeSessionId ? [activeSessionId] : [...client.attachedActiveSessionIds];
		for (const selector of targets) {
			const match = this.matchWorkers(selector)[0];
			const resolvedId = match ? (match.summary.activeSessionId ?? match.summary.id) : selector;
			if (!client.attachedActiveSessionIds.delete(resolvedId)) {
				continue;
			}
			client.catchupActiveSessionIds?.delete(resolvedId);
			client.catchupPurposes?.delete(resolvedId);
			this.write(client, { type: "session_detached", activeSessionId: resolvedId });
			void this.syncWorkerExtensionUi(resolvedId);
		}
	}

	private async syncWorkerExtensionUi(activeSessionId: string): Promise<void> {
		const match = this.matchWorkers(activeSessionId)[0];
		if (!match?.worker.client) {
			return;
		}
		await this.subscribeWorker(match.worker, match.summary.activeSessionId ?? match.summary.id).catch(
			() => undefined,
		);
	}

	private handleWorkerFrame(worker: ResidentWorker, frame: PrivateFrame<DaemonWorkerFrameHeader>): void {
		if (frame.header.kind !== "outbound") {
			return;
		}
		const {
			outboundType,
			activeSessionId,
			snapshotId: frameSnapshotId,
			sessionEventType,
			payloadEncoding,
			snapshotPurpose,
		} = frame.header;
		if (outboundType === "heartbeats_changed") {
			worker.heartbeatSnapshotStale = true;
			this.broadcastHeartbeatsChanged();
			return;
		}
		if (outboundType === "session_snapshot_begin" && activeSessionId) {
			try {
				const begin = JSON.parse(frame.payload.toString("utf8")) as Extract<
					DaemonOutbound,
					{ type: "session_snapshot_begin" }
				>;
				if (
					begin.type !== "session_snapshot_begin" ||
					begin.activeSessionId !== activeSessionId ||
					typeof begin.snapshotId !== "string" ||
					(frameSnapshotId !== undefined && frameSnapshotId !== begin.snapshotId) ||
					typeof begin.targetChunkBytes !== "number" ||
					!begin.snapshot ||
					!isSessionSummary(begin.snapshot.summary)
				) {
					throw new Error("Worker returned an invalid snapshot begin frame");
				}
				const publicSummary = this.publicSummary(worker, begin.snapshot.summary);
				const snapshot = {
					...begin.snapshot,
					summary: publicSummary,
					messages: [],
				};
				const result: DaemonAttachResult = {
					protocol: DAEMON_PROTOCOL_INFO,
					activeSessionId,
					snapshot,
					replay: {
						status: "complete",
						toSequence: snapshot.lastEventSequence,
						...(snapshot.lastEventCursor ? { toCursor: snapshot.lastEventCursor } : {}),
					},
					lastEventSequence: snapshot.lastEventSequence,
					...(snapshot.lastEventCursor ? { lastEventCursor: snapshot.lastEventCursor } : {}),
					snapshotStream: {
						id: begin.snapshotId,
						messageCount: begin.messageCount,
						targetChunkBytes: begin.targetChunkBytes,
					},
					client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
				};
				const generations = this.snapshotGenerationsFor(worker, activeSessionId);
				let generation = generations.get(begin.snapshotId);
				if (generation?.incoming) {
					this.failWorkerSnapshotCache(
						worker,
						activeSessionId,
						new Error(`Snapshot ${begin.snapshotId} restarted before completion`),
						true,
						begin.snapshotId,
					);
					return;
				}
				// Snapshot summaries/state include live fields (for example activity and attached client
				// counts) that can change without advancing the transcript sequence. Treat the stable
				// transfer envelope as identity; duplicate chunks and end metadata are still byte-checked.
				const duplicate =
					generation?.transcript.complete === true &&
					generation.end !== undefined &&
					generation.result.snapshotStream?.messageCount === begin.messageCount &&
					generation.result.snapshotStream?.targetChunkBytes === begin.targetChunkBytes &&
					generation.result.lastEventSequence === result.lastEventSequence &&
					generation.result.snapshot.lastEventSequence === result.snapshot.lastEventSequence &&
					generation.result.snapshot.lastEventCursor?.generation === result.snapshot.lastEventCursor?.generation &&
					generation.result.snapshot.lastEventCursor?.sequence === result.snapshot.lastEventCursor?.sequence;
				if (generation?.transcript.complete && !duplicate) {
					this.failWorkerSnapshotCache(
						worker,
						activeSessionId,
						new Error(`Snapshot ${begin.snapshotId} did not match the cached transfer`),
						true,
						begin.snapshotId,
					);
					return;
				}
				const currentGeneration = this.currentSnapshotGeneration(worker, activeSessionId);
				const currentResult = currentGeneration?.result ?? worker.snapshotCache.get(activeSessionId);
				const isOlderThanCurrent =
					currentGeneration !== undefined &&
					currentGeneration.transcript.snapshotId !== begin.snapshotId &&
					currentResult !== undefined &&
					result.lastEventSequence < currentResult.lastEventSequence;
				if (isOlderThanCurrent && !generation) {
					return;
				}
				if (duplicate && generation) {
					generation.incoming = true;
					generation.duplicateChunkIndex = 0;
					generation.duplicateResult = result;
					generation.validation = this.createSnapshotDuplicateValidation();
					if (currentGeneration === generation) {
						worker.snapshotCache.delete(activeSessionId);
					}
					return;
				}
				if (
					currentGeneration &&
					currentGeneration.transcript.snapshotId !== begin.snapshotId &&
					!isOlderThanCurrent
				) {
					if (!currentGeneration.transcript.complete && !currentGeneration.incoming) {
						this.failWorkerSnapshotCache(
							worker,
							activeSessionId,
							new Error(`Snapshot ${currentGeneration.transcript.snapshotId} was superseded`),
							false,
							currentGeneration.transcript.snapshotId,
						);
					} else {
						this.retireWorkerSnapshotCache(worker, activeSessionId, currentGeneration.transcript);
					}
				}
				if (!generation) {
					const transcript = new SnapshotTranscriptCache({
						activeSessionId,
						snapshotId: begin.snapshotId,
						cacheRoot: this.snapshotCacheRoot,
						targetChunkBytes: begin.targetChunkBytes,
					});
					generation = {
						transcript,
						result,
						incoming: false,
						retired: isOlderThanCurrent,
					};
					this.snapshotGenerationsFor(worker, activeSessionId).set(begin.snapshotId, generation);
				}
				generation.result = result;
				generation.begin = Buffer.from(frame.payload);
				generation.end = undefined;
				generation.incoming = true;
				generation.duplicateChunkIndex = undefined;
				generation.duplicateResult = undefined;
				generation.validation = undefined;
				if (!isOlderThanCurrent) {
					generation.retired = false;
					worker.transcriptCaches.set(activeSessionId, generation.transcript);
					worker.snapshotCache.set(activeSessionId, result);
				}
			} catch (error) {
				this.log(`Invalid worker snapshot begin frame: ${String(error)}`);
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					error instanceof Error ? error : new Error(String(error)),
					true,
				);
			}
			return;
		}
		if (outboundType === "session_snapshot_chunk" && activeSessionId) {
			const snapshotId = frameSnapshotId ?? worker.transcriptCaches.get(activeSessionId)?.snapshotId;
			if (!snapshotId) {
				return;
			}
			const generation = this.snapshotGeneration(worker, activeSessionId, snapshotId);
			if (generation?.incoming) {
				try {
					const duplicateIndex = generation.duplicateChunkIndex;
					if (duplicateIndex === undefined) {
						generation.transcript.appendEncodedChunk(Buffer.from(frame.payload));
					} else {
						const chunk = JSON.parse(frame.payload.toString("utf8")) as Extract<
							DaemonOutbound,
							{ type: "session_snapshot_chunk" }
						>;
						if (
							chunk.type !== "session_snapshot_chunk" ||
							chunk.activeSessionId !== activeSessionId ||
							chunk.snapshotId !== generation.transcript.snapshotId ||
							chunk.index !== duplicateIndex ||
							!generation.transcript.readChunk(duplicateIndex).equals(Buffer.from(frame.payload))
						) {
							throw new Error(
								`Duplicate snapshot ${generation.transcript.snapshotId} did not match cached bytes`,
							);
						}
						generation.duplicateChunkIndex = duplicateIndex + 1;
					}
				} catch (error) {
					this.failWorkerSnapshotCache(
						worker,
						activeSessionId,
						error instanceof Error ? error : new Error(String(error)),
						true,
						generation.transcript.snapshotId,
					);
				}
			}
			return;
		}
		if (outboundType === "session_snapshot_end" && activeSessionId) {
			const snapshotId = frameSnapshotId ?? worker.transcriptCaches.get(activeSessionId)?.snapshotId;
			if (!snapshotId) {
				return;
			}
			const generation = this.snapshotGeneration(worker, activeSessionId, snapshotId);
			if (!generation?.incoming) {
				return;
			}
			const transcript = generation.transcript;
			try {
				const duplicateChunkCount = generation.duplicateChunkIndex;
				if (duplicateChunkCount === undefined) {
					transcript.markComplete();
					if (!generation.begin) {
						throw new Error(`Snapshot ${transcript.snapshotId} has no begin frame`);
					}
					generation.end = Buffer.from(frame.payload);
				} else {
					const end = JSON.parse(frame.payload.toString("utf8")) as Extract<
						DaemonOutbound,
						{ type: "session_snapshot_end" }
					>;
					if (
						end.type !== "session_snapshot_end" ||
						end.activeSessionId !== activeSessionId ||
						end.snapshotId !== transcript.snapshotId ||
						end.chunkCount !== duplicateChunkCount ||
						end.chunkCount !== transcript.chunkCount ||
						!generation.end?.equals(frame.payload)
					) {
						throw new Error(`Duplicate snapshot ${transcript.snapshotId} ended with different metadata`);
					}
					if (!generation.duplicateResult) {
						throw new Error(`Duplicate snapshot ${transcript.snapshotId} has no result`);
					}
					generation.result = generation.duplicateResult;
					if (worker.transcriptCaches.get(activeSessionId) === transcript) {
						worker.snapshotCache.set(activeSessionId, generation.duplicateResult);
					}
					this.settleSnapshotDuplicateValidation(generation);
				}
				generation.incoming = false;
				generation.duplicateChunkIndex = undefined;
				generation.duplicateResult = undefined;
			} catch (error) {
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					error instanceof Error ? error : new Error(String(error)),
					true,
					transcript.snapshotId,
				);
				return;
			}
			const published = worker.transcriptCaches.get(activeSessionId) === transcript;
			if (generation.retired) {
				this.deleteSnapshotGeneration(worker, activeSessionId, generation);
				transcript.dispose();
			}
			if (published && (snapshotPurpose === "replacement" || snapshotPurpose === "catchup")) {
				for (const client of this.clients) {
					if (!client.attachedActiveSessionIds.has(activeSessionId)) continue;
					this.queueCatchup(client, activeSessionId, snapshotPurpose === "replacement" ? "replacement" : "resync");
					void this.catchUpClient(client).catch((error) =>
						this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
					);
				}
			}
			return;
		}
		if (outboundType === "session_snapshot_failed" && activeSessionId) {
			try {
				const failed = JSON.parse(frame.payload.toString("utf8")) as Extract<
					DaemonOutbound,
					{ type: "session_snapshot_failed" }
				>;
				if (
					failed.type !== "session_snapshot_failed" ||
					failed.activeSessionId !== activeSessionId ||
					typeof failed.snapshotId !== "string" ||
					typeof failed.error !== "string" ||
					(frameSnapshotId !== undefined && frameSnapshotId !== failed.snapshotId)
				) {
					throw new Error("Worker returned an invalid snapshot failure frame");
				}
				const currentGeneration = this.currentSnapshotGeneration(worker, activeSessionId);
				const generation =
					this.snapshotGeneration(worker, activeSessionId, failed.snapshotId) ??
					(currentGeneration?.transcript.snapshotId === failed.snapshotId ? currentGeneration : undefined);
				if (!generation) {
					return;
				}
				const published = worker.transcriptCaches.get(activeSessionId) === generation.transcript;
				this.failWorkerSnapshotCache(worker, activeSessionId, new Error(failed.error), false, failed.snapshotId);
				if (published && (snapshotPurpose === "replacement" || snapshotPurpose === "catchup")) {
					for (const client of this.clients) {
						if (!client.attachedActiveSessionIds.has(activeSessionId)) continue;
						this.queueCatchup(
							client,
							activeSessionId,
							snapshotPurpose === "replacement" ? "replacement" : "resync",
						);
						void this.catchUpClient(client).catch((error) =>
							this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
						);
					}
				}
			} catch (error) {
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					error instanceof Error ? error : new Error(String(error)),
					true,
				);
			}
			return;
		}
		if (
			outboundType === "daemon_hello" ||
			outboundType === "response" ||
			outboundType === "session_list_progress" ||
			outboundType === "session_list_item" ||
			outboundType === "session_attached" ||
			outboundType === "session_detached" ||
			!activeSessionId
		) {
			return;
		}
		let publicPayload = frame.payload;
		let decodedOutbound: DaemonOutbound | undefined;
		if (payloadEncoding === "assistant-delta") {
			let compactValue: unknown;
			try {
				compactValue = JSON.parse(frame.payload.toString("utf8"));
			} catch {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			if (!isCompactAssistantDelta(compactValue)) {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			const reconstructed = this.streamReconstructor.reconstruct(compactValue);
			if (!reconstructed) {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			publicPayload = Buffer.from(serializeJsonLine(reconstructed));
		} else if (
			sessionEventType === "message_start" ||
			sessionEventType === "message_end" ||
			outboundType === "session_replaced" ||
			outboundType === "session_resynced" ||
			outboundType === "session_closed"
		) {
			try {
				decodedOutbound = JSON.parse(frame.payload.toString("utf8")) as DaemonOutbound;
				this.streamReconstructor.observe(decodedOutbound);
			} catch {
				// A malformed worker event is still isolated to this worker connection.
			}
		}
		const replacementSnapshotFollows =
			decodedOutbound?.type === "session_replaced" && decodedOutbound.snapshotFollows === true;
		this.invalidateWorkerSnapshot(
			worker,
			activeSessionId,
			outboundType === "session_replaced" ||
				outboundType === "session_closed" ||
				isFinalizedTranscriptEvent(sessionEventType),
		);
		for (const client of this.clients) {
			if (!client.attachedActiveSessionIds.has(activeSessionId)) {
				continue;
			}
			if (replacementSnapshotFollows && !client.capabilities.has("chunked_snapshot")) {
				continue;
			}
			if (outboundType === "extension_ui_request" && !client.supportsExtensionUi) {
				continue;
			}
			if (client.snapshotActiveSessionIds?.has(activeSessionId)) {
				this.queueCatchup(client, activeSessionId, outboundType === "session_replaced" ? "replacement" : "resync");
				continue;
			}
			if (client.backpressured === true) {
				this.queueCatchup(client, activeSessionId, outboundType === "session_replaced" ? "replacement" : "resync");
				continue;
			}
			this.writeSerialized(client, publicPayload);
		}
		if (outboundType === "session_replaced" || outboundType === "session_closed") {
			void this.refreshWorkerSummaries(worker)
				.then(() => this.syncAgentPeers())
				.catch(() => undefined);
		} else if (
			sessionEventType === "turn_start" ||
			sessionEventType === "turn_end" ||
			sessionEventType === "rlm_child_update"
		) {
			void this.refreshWorkerSummaries(worker)
				.then(() => this.syncAgentPeers())
				.catch(() => undefined);
		}
		if (
			decodedOutbound?.type === "session_closed" &&
			decodedOutbound.reason === "shutdown" &&
			activeSessionId === worker.descriptor.rootActiveSessionId &&
			!this.shuttingDown
		) {
			worker.intentionalStop = true;
			this.workers.delete(worker.descriptor.workerId);
			this.deleteWorkerDescriptor(worker);
			void this.syncAgentPeers().catch(() => undefined);
		}
	}

	private invalidateWorkerSnapshot(worker: ResidentWorker, activeSessionId: string, transcriptChanged = true): void {
		worker.snapshotCache.delete(activeSessionId);
		if (!transcriptChanged) {
			return;
		}
		worker.snapshotLoads.delete(`${activeSessionId}:chunked`);
		worker.snapshotLoads.delete(`${activeSessionId}:full`);
		const transcript = worker.transcriptCaches.get(activeSessionId);
		if (transcript) {
			this.retireWorkerSnapshotCache(worker, activeSessionId, transcript);
		}
	}

	private scheduleCompactCatchup(worker: ResidentWorker, activeSessionId: string): void {
		if (this.compactCatchupInProgress.has(activeSessionId)) {
			return;
		}
		this.compactCatchupInProgress.add(activeSessionId);
		this.invalidateWorkerSnapshot(worker, activeSessionId);
		const clients = [...this.clients].filter((client) => client.attachedActiveSessionIds.has(activeSessionId));
		for (const client of clients) {
			this.queueCatchup(client, activeSessionId);
		}
		void Promise.all(clients.map((client) => this.catchUpClient(client)))
			.catch((error) => this.log(`Failed compact catch-up for ${activeSessionId}: ${String(error)}`))
			.finally(() => {
				this.compactCatchupInProgress.delete(activeSessionId);
			});
	}

	private queueCatchup(
		client: DaemonSocketClient,
		activeSessionId: string,
		purpose: "replacement" | "resync" = "resync",
	): void {
		if (!client.catchupActiveSessionIds) {
			client.catchupActiveSessionIds = new Set();
		}
		client.catchupActiveSessionIds.add(activeSessionId);
		client.catchupPurposes ??= new Map();
		if (purpose === "replacement" || !client.catchupPurposes.has(activeSessionId)) {
			client.catchupPurposes.set(activeSessionId, purpose);
		}
	}

	private catchUpClient(client: DaemonSocketClient): Promise<void> {
		if (client.catchupPromise) {
			return client.catchupPromise;
		}
		if (client.snapshotStreaming || client.backpressured) {
			return Promise.resolve();
		}
		const catchup = this.drainClientCatchupQueue(client).finally(() => {
			if (client.catchupPromise === catchup) {
				client.catchupPromise = undefined;
			}
		});
		client.catchupPromise = catchup;
		return catchup;
	}

	private async drainClientCatchupQueue(client: DaemonSocketClient): Promise<void> {
		while (
			!client.socket.destroyed &&
			!client.snapshotStreaming &&
			!client.backpressured &&
			client.catchupActiveSessionIds?.size
		) {
			await this.drainClientCatchups(client);
		}
	}

	private async drainClientCatchups(client: DaemonSocketClient): Promise<void> {
		if (client.socket.destroyed) {
			return;
		}
		const pending = [...(client.catchupActiveSessionIds ?? [])].map((activeSessionId) => ({
			activeSessionId,
			purpose: client.catchupPurposes?.get(activeSessionId) ?? ("resync" as const),
		}));
		client.catchupActiveSessionIds?.clear();
		client.catchupPurposes?.clear();
		for (let index = 0; index < pending.length; index++) {
			const { activeSessionId, purpose } = pending[index]!;
			let releaseTranscript: (() => void) | undefined;
			try {
				const attached = await this.attachClient(client, {
					type: "attach",
					activeSessionId,
					capabilities: [...client.capabilities],
					supportsExtensionUi: client.supportsExtensionUi,
				});
				releaseTranscript = attached.releaseTranscript;
				if (client.capabilities.has("chunked_snapshot")) {
					const transcript = attached.transcript;
					if (!transcript) {
						throw new Error("Session worker did not provide a snapshot transcript");
					}
					if (purpose === "replacement") {
						this.write(client, {
							type: "session_replaced",
							activeSessionId,
							state: attached.result.snapshot.state,
							messages: [],
							snapshotFollows: true,
							meta: createDaemonEventMeta(
								activeSessionId,
								attached.result.lastEventSequence,
								undefined,
								attached.result.lastEventCursor?.generation,
							),
						});
					}
					await this.streamSnapshot(
						client,
						attached.worker,
						this.createStreamedAttachResult(attached.result, transcript),
						transcript,
						purpose,
						releaseTranscript,
					);
					releaseTranscript = undefined;
					continue;
				}
				const meta = createDaemonEventMeta(
					activeSessionId,
					attached.result.lastEventSequence,
					undefined,
					attached.result.lastEventCursor?.generation,
				);
				const catchup: DaemonOutbound =
					purpose === "replacement"
						? {
								type: "session_replaced",
								activeSessionId,
								state: attached.result.snapshot.state,
								messages: attached.result.snapshot.messages,
								meta,
							}
						: {
								type: "session_resynced",
								activeSessionId,
								snapshot: attached.result.snapshot,
								meta,
							};
				if (!this.write(client, catchup)) {
					for (const remaining of pending.slice(index + 1)) {
						this.queueCatchup(client, remaining.activeSessionId, remaining.purpose);
					}
					return;
				}
			} catch (error) {
				releaseTranscript?.();
				this.log(`Failed to catch up client ${client.id} for ${activeSessionId}: ${String(error)}`);
			}
		}
	}

	private async prepareUpdateRestart(): Promise<DaemonUpdateRestartManifest> {
		if (this.updateRestartPhase !== undefined) throw new Error("Daemon is already preparing an update restart");
		this.updateRestartPhase = "draining";
		try {
			const deadline = Date.now() + UPDATE_RESTART_PREPARE_DEADLINE_MS;
			const abort = AbortSignal.timeout(Math.min(UPDATE_RESTART_MUTATION_DRAIN_TIMEOUT_MS, deadline - Date.now()));
			await this.mutationDrain.waitForDrain(1, abort, "Timed out draining daemon mutations for update restart");
			this.updateRestartPhase = "fencing";
			await this.mutationDrain.waitForDrain(1, abort, "Timed out draining daemon mutations for update restart");
			const manifest = await this.prepareUpdateRestartFenced(deadline);
			this.updateRestartPhase = "prepared";
			return manifest;
		} catch (error) {
			this.updateRestartPhase = undefined;
			throw error;
		}
	}

	private async prepareUpdateRestartFenced(deadline: number): Promise<DaemonUpdateRestartManifest> {
		const residents = [...this.workers.values()];
		const unavailable = residents.find(
			(worker) => worker.descriptor.lifecycle !== "ready" || worker.client === undefined,
		);
		if (unavailable) {
			throw new Error(
				`Cannot prepare update restart while resident worker ${unavailable.descriptor.workerId} is ${unavailable.descriptor.lifecycle}${unavailable.client ? "" : " and disconnected"}`,
			);
		}
		const workers = residents as Array<ResidentWorker & { client: DaemonWorkerClient }>;
		const acknowledged: ResidentWorker[] = [];
		const preparationResults = await Promise.allSettled(
			workers.map(async (worker) => {
				const client = worker.client;
				const response = await client.requestWorker(
					{ type: "worker_prepare_update" },
					Math.max(1, Math.min(UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS, deadline - Date.now())),
				);
				if (!response.success) throw new Error(response.error);
				worker.updateRestartPrepareClient = client;
				acknowledged.push(worker);
				if (!response.data || typeof response.data !== "object") {
					throw new Error("Worker returned an invalid update manifest");
				}
				if (worker.client !== client || worker.descriptor.lifecycle !== "ready") {
					throw new Error(`Worker ${worker.descriptor.workerId} disconnected during update preparation`);
				}
				const manifest = response.data as DaemonUpdateRestartManifest;
				if (manifest.formatVersion !== DAEMON_UPDATE_RESTART_FORMAT_VERSION) {
					throw new Error(`Worker returned unsupported update manifest version ${manifest.formatVersion}`);
				}
				if (
					!manifest.sessions.some(
						(session) => session.activeSessionId === worker.descriptor.rootActiveSessionId,
					) &&
					!manifest.discardedActiveSessionIds?.includes(worker.descriptor.rootActiveSessionId)
				) {
					throw new Error(
						`Worker ${worker.descriptor.workerId} omitted its root disposition from the update manifest`,
					);
				}
				return { worker, manifest };
			}),
		);
		const cancelAcknowledged = async () => {
			await Promise.all(
				acknowledged.map(async (worker) => {
					const prepareClient = worker.updateRestartPrepareClient;
					worker.updateRestartPrepareClient = undefined;
					if (!prepareClient) return;
					try {
						const response = await prepareClient.requestWorker({ type: "worker_cancel_update" }, 5000);
						if (!response.success) throw new Error(response.error);
					} catch (error) {
						this.log(
							`Could not cancel prepared worker ${worker.descriptor.workerId}; reconnecting it: ${String(error)}`,
						);
						prepareClient.close();
						if (worker.client && worker.client !== prepareClient) worker.client.close();
					}
				}),
			);
		};
		const preparationFailure = preparationResults.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (preparationFailure) {
			await cancelAcknowledged();
			throw preparationFailure.reason;
		}
		const prepared = preparationResults.flatMap((result) =>
			result.status === "fulfilled" ? [result.value.worker] : [],
		);
		const responses = preparationResults.flatMap((result) =>
			result.status === "fulfilled" ? [result.value.manifest] : [],
		);
		const discardedActiveSessionIds = responses.flatMap((manifest) => manifest.discardedActiveSessionIds ?? []);
		const manifest: DaemonUpdateRestartManifest = {
			formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
			createdAt: new Date().toISOString(),
			sessions: responses.flatMap((manifest) => manifest.sessions),
			...(discardedActiveSessionIds.length > 0 ? { discardedActiveSessionIds } : {}),
		};
		// A worker that disconnected after preparing cancelled its checkpoint with
		// the old client; a recovered replacement may have admitted inputs past the
		// captured manifest. Abort before the manifest is persisted so the caller's
		// fallback cannot restore from the stale checkpoint.
		const staleWorker = prepared.find((worker) => worker.client !== worker.updateRestartPrepareClient);
		if (staleWorker) {
			await cancelAcknowledged();
			throw new Error(
				`Worker ${staleWorker.descriptor.workerId} reconnected during update preparation; its checkpoint is stale`,
			);
		}
		try {
			this.validateAndPersistUpdateManifest(manifest);
		} catch (error) {
			await cancelAcknowledged();
			throw error;
		}
		// Commit through the connection that owns the prepared transaction; a client
		// swapped in after the check above must fail the commit rather than reach a
		// worker that no longer holds the checkpoint.
		const commitClients = new Map(prepared.map((worker) => [worker, worker.updateRestartPrepareClient]));
		for (const worker of prepared) worker.updateRestartPrepareClient = undefined;
		const commitResults = await Promise.allSettled(
			prepared.map(async (worker) => {
				const client = commitClients.get(worker);
				if (!client) throw new Error(`Worker ${worker.descriptor.workerId} disconnected before update commit`);
				const response = await client.requestWorker(
					{ type: "worker_commit_update" },
					UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS,
				);
				if (!response.success) throw new Error(response.error);
			}),
		);
		const commitFailure = commitResults.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (commitFailure) {
			this.log(`Update restart commit response failed; forcing restart completion: ${String(commitFailure.reason)}`);
			await Promise.allSettled(prepared.map((worker) => this.stopWorker(worker, false, true)));
			return manifest;
		}
		const stopResults = await Promise.allSettled(prepared.map((worker) => this.stopWorker(worker, false)));
		if (stopResults.some((result) => result.status === "rejected")) {
			this.log("A committed update worker did not stop gracefully; forcing restart completion");
			await Promise.allSettled(prepared.map((worker) => this.stopWorker(worker, false, true)));
		}
		return manifest;
	}

	private validateAndPersistUpdateManifest(manifest: DaemonUpdateRestartManifest): void {
		if (manifest.formatVersion !== DAEMON_UPDATE_RESTART_FORMAT_VERSION) {
			throw new Error(`Unsupported update manifest version ${manifest.formatVersion}`);
		}
		const activeSessionIds = new Set<string>();
		const sessionFiles = new Set<string>();
		for (const discardedActiveSessionId of manifest.discardedActiveSessionIds ?? []) {
			if (!discardedActiveSessionId || activeSessionIds.has(discardedActiveSessionId)) {
				throw new Error("Update manifest contains an invalid discarded session disposition");
			}
			activeSessionIds.add(discardedActiveSessionId);
		}
		for (const session of manifest.sessions) {
			if (!session.activeSessionId || !session.sessionFile) {
				throw new Error("Update manifest contains an incomplete session checkpoint");
			}
			if (activeSessionIds.has(session.activeSessionId)) {
				throw new Error(`Update manifest contains duplicate active session ${session.activeSessionId}`);
			}
			const sessionFile = canonicalSessionPath(session.sessionFile);
			if (sessionFiles.has(sessionFile)) {
				throw new Error(`Update manifest contains duplicate session file ${sessionFile}`);
			}
			activeSessionIds.add(session.activeSessionId);
			sessionFiles.add(sessionFile);
		}
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		const path = getDaemonUpdateRestartManifestPath(this.socketPath, agentDir);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tempPath = `${path}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
		chmodSync(tempPath, 0o600);
		const validated = JSON.parse(readFileSync(tempPath, "utf8")) as DaemonUpdateRestartManifest;
		if (!Array.isArray(validated.sessions) || validated.sessions.length !== manifest.sessions.length) {
			throw new Error("Could not validate aggregate update manifest");
		}
		renameSync(tempPath, path);
	}

	private async stopWorker(
		worker: ResidentWorker,
		removeDescriptor: boolean,
		force = false,
		archiveSession = false,
		recoveryCleanup = false,
		directChild?: { child: ChildProcess; closed: Promise<void> },
	): Promise<void> {
		if (worker.ownerCleanupTimer) {
			clearTimeout(worker.ownerCleanupTimer);
			worker.ownerCleanupTimer = undefined;
		}
		if (!recoveryCleanup) {
			worker.stopRevision++;
		}
		try {
			if (removeDescriptor) {
				this.persistWorkerStopTombstone(worker, archiveSession);
			} else {
				worker.intentionalStop = true;
				worker.descriptor.lifecycle = "recovering";
				this.persistWorker(worker);
			}
		} catch (error) {
			if (!directChild) {
				throw error;
			}
			this.reportCleanupFailure(`worker rollback state ${worker.descriptor.workerId}`, error);
		}
		const transferError = new Error("Session worker stopped during snapshot transfer");
		const generationTranscripts = new Set<SnapshotTranscriptCache>();
		for (const [activeSessionId, generations] of [...(worker.snapshotGenerations ?? new Map())]) {
			for (const generation of [...generations.values()]) {
				generationTranscripts.add(generation.transcript);
				if (generation.incoming || !generation.transcript.complete || generation.validation) {
					this.failSnapshotGeneration(worker, activeSessionId, generation, transferError);
				} else {
					generation.transcript.dispose();
					this.deleteSnapshotGeneration(worker, activeSessionId, generation);
				}
			}
		}
		for (const transcript of worker.transcriptCaches.values()) {
			if (!generationTranscripts.has(transcript) && !transcript.complete) {
				transcript.markFailed(transferError);
			}
			transcript.dispose();
		}
		worker.transcriptCaches.clear();
		worker.snapshotCache.clear();
		worker.snapshotGenerations?.clear();
		if (worker.client) {
			if (archiveSession) {
				await worker.client
					.requestWorker({ type: "worker_archive_and_shutdown" }, force ? 1000 : 5000)
					.catch(() => undefined);
			} else {
				await worker.client.request({ type: "shutdown" }, force ? 1000 : 5000).catch(() => undefined);
			}
			worker.client.close();
			worker.client = undefined;
		} else if (directChild) {
			directChild.child.kill("SIGTERM");
		} else if (isProcessAlive(worker.descriptor.pid)) {
			signalProcessGroupOrProcess(worker.descriptor.pid, "SIGTERM");
		}
		const isWorkerProcessAlive = () =>
			directChild
				? directChild.child.exitCode === null && directChild.child.signalCode === null
				: isProcessAlive(worker.descriptor.pid);
		const gracefulDeadline = Date.now() + (force ? 500 : 2000);
		while (isWorkerProcessAlive() && Date.now() < gracefulDeadline) {
			await delay(25);
		}
		if (force && isWorkerProcessAlive()) {
			if (directChild) {
				directChild.child.kill("SIGKILL");
			} else {
				signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL");
			}
			const forceDeadline = Date.now() + 1000;
			while (isWorkerProcessAlive() && Date.now() < forceDeadline) {
				await delay(25);
			}
		}
		if (isWorkerProcessAlive()) {
			worker.intentionalStop = worker.descriptor.stopRequestedAt !== undefined;
			throw new Error(`Session worker ${worker.descriptor.workerId} did not stop${force ? " after SIGKILL" : ""}`);
		}
		if (directChild) {
			await directChild.closed;
		}
		if (removeDescriptor && worker.descriptor.archiveOnStop) {
			if (force) {
				this.reclaimStoppedWorkerCronLock(worker);
			}
			await this.finalizeArchivedWorkerStop(worker);
		}
		this.workers.delete(worker.descriptor.workerId);
		if (removeDescriptor) {
			this.deleteWorkerDescriptor(worker);
		}
		if (!this.shuttingDown) {
			void this.syncAgentPeers().catch(() => undefined);
			this.broadcastHeartbeatsChanged();
		}
	}

	private async finalizeArchivedWorkerStop(worker: ResidentWorker): Promise<void> {
		const context = this.workerSessionArtifactContext(worker);
		if (!context) {
			return;
		}
		if (worker.descriptor.rootSessionId) {
			const cronStore = AgentCronJobStore.forSessionArtifacts();
			cronStore.registerSessionArtifact(worker.descriptor.rootSessionId, context.artifactDir);
			cronStore.cancelJobsForSession({
				sessionId: worker.descriptor.rootSessionId,
				sessionFile: context.sessionFile,
			});
			await this.catalog.archive(context.sessionFile, worker.descriptor.rootSessionId);
		}
	}

	private reclaimStoppedWorkerCronLock(worker: ResidentWorker): void {
		const context = this.workerSessionArtifactContext(worker);
		if (!context) {
			return;
		}
		rmSync(join(context.artifactDir, `${SESSION_SCHEDULED_JOBS_FILENAME}.lock`), { recursive: true, force: true });
	}

	private workerSessionArtifactContext(
		worker: ResidentWorker,
	): { sessionFile: string; artifactDir: string } | undefined {
		const sessionFile = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
		if (!sessionFile || !worker.descriptor.rootSessionId) {
			return undefined;
		}
		return {
			sessionFile,
			artifactDir: join(dirname(dirname(sessionFile)), "session-artifacts", worker.descriptor.rootSessionId),
		};
	}

	private persistWorkerStopTombstone(worker: ResidentWorker, archiveSession = false): void {
		worker.intentionalStop = true;
		worker.descriptor.stopRequestedAt ??= new Date().toISOString();
		worker.descriptor.archiveOnStop ||= archiveSession;
		this.persistWorker(worker);
	}

	private write(client: DaemonSocketClient, message: DaemonOutbound): boolean {
		return this.writeSerialized(client, serializeJsonLine(message));
	}

	private broadcastHeartbeatsChanged(): void {
		for (const client of this.clients) {
			this.write(client, { type: "heartbeats_changed" });
		}
	}

	private writeSerialized(client: DaemonSocketClient, line: string | Uint8Array): boolean {
		if (client.socket.destroyed) {
			return false;
		}
		const accepted = client.socket.write(line);
		if (!accepted) {
			client.backpressured = true;
		}
		return accepted;
	}

	private registerSignalHandlers(): void {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => void this.shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143, false);
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const exitHandler = () => this.cleanupSocket();
		process.on("exit", exitHandler);
		this.signalCleanupHandlers.push(() => process.off("exit", exitHandler));
	}

	private cleanupSocket(): void {
		if (!this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		const identity = this.socketIdentity;
		this.socketIdentity = undefined;
		cleanupDaemonSocketPath(this.socketPath, identity, this.socketLease);
	}

	private async cleanupSupervisorResources(): Promise<void> {
		if (this.cleanupPromise) {
			return this.cleanupPromise;
		}
		this.cleanupPromise = this.cleanupSupervisorResourcesOnce();
		return this.cleanupPromise;
	}

	private async cleanupSupervisorResourcesOnce(): Promise<void> {
		this.shuttingDown = true;
		this.clearIdleEvictionTimer();
		await this.idleEvictionSweep?.catch(() => undefined);
		for (const cleanup of this.signalCleanupHandlers.splice(0)) {
			await this.runCleanupStep("signal handler", cleanup);
		}
		const server = this.server;
		this.server = undefined;
		const serverClosed = new Promise<void>((resolveClose) => {
			if (!server?.listening) {
				resolveClose();
				return;
			}
			try {
				server.close(() => resolveClose());
			} catch (error) {
				this.reportCleanupFailure("daemon server", error);
				resolveClose();
			}
		});
		for (const client of this.clients) {
			client.attachedActiveSessionIds.clear();
			await this.runCleanupStep(`daemon client input ${client.id}`, () => client.detachInput());
			await this.runCleanupStep(`daemon client socket ${client.id}`, () => {
				client.socket.destroy();
			});
		}
		this.clients.clear();
		for (const worker of this.workers.values()) {
			if (worker.ownerCleanupTimer) {
				clearTimeout(worker.ownerCleanupTimer);
				worker.ownerCleanupTimer = undefined;
			}
			await this.runCleanupStep(`worker client ${worker.descriptor.workerId}`, () => worker.client?.close());
			worker.client = undefined;
			const transcripts = new Set(worker.transcriptCaches.values());
			for (const generations of worker.snapshotGenerations?.values() ?? []) {
				for (const generation of generations.values()) {
					transcripts.add(generation.transcript);
					this.settleSnapshotDuplicateValidation(
						generation,
						new Error("Daemon supervisor stopped during snapshot transfer"),
					);
					if (!generation.transcript.complete) {
						generation.transcript.markFailed(new Error("Daemon supervisor stopped during snapshot transfer"));
					}
				}
			}
			for (const transcript of transcripts) {
				await this.runCleanupStep(`worker transcript ${worker.descriptor.workerId}`, () => transcript.dispose());
			}
			worker.transcriptCaches.clear();
			worker.snapshotGenerations?.clear();
			worker.snapshotCache.clear();
			worker.snapshotLoads.clear();
		}
		this.workers.clear();
		this.openingWorkers.clear();
		await this.runCleanupStep("daemon catalog", () => this.catalog.stop());
		await this.runCleanupStep("daemon server", () => serverClosed);
		await this.runCleanupStep("daemon socket", () => this.cleanupSocket());
		await this.runCleanupStep("supervisor cache", () => {
			rmSync(this.snapshotCacheRoot, { recursive: true, force: true });
		});
		const lease = this.socketLease;
		this.socketLease = undefined;
		await this.runCleanupStep("daemon socket lock", async () => lease?.release());
		const ownership = this.ownership;
		this.ownership = undefined;
		await this.runCleanupStep("daemon ownership", async () => ownership?.release());
	}

	private async runCleanupStep(label: string, action: () => void | Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.reportCleanupFailure(label, error);
		}
	}

	private reportCleanupFailure(label: string, error: unknown): void {
		const message = `Failed to clean up ${label}: ${String(error)}`;
		try {
			this.log(message);
		} catch {
			console.error(message);
		}
	}

	private async shutdown(
		exitCode: number,
		stopWorkers: boolean,
		relaunch = false,
		forceWorkers = false,
		closingReason?: DaemonClosingReason,
	): Promise<never> {
		if (this.shuttingDown) {
			process.exit(exitCode);
		}
		this.shuttingDown = true;
		this.clearIdleEvictionTimer();
		await this.idleEvictionSweep?.catch(() => undefined);
		if (closingReason) {
			for (const client of this.clients) {
				this.write(client, { type: "daemon_closing", reason: closingReason });
			}
		}
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		if (stopWorkers) {
			await Promise.all(
				[...this.workers.values()].map((worker) => this.stopWorker(worker, true, forceWorkers, true)),
			);
			if (!this.hasPersistedWorkerDescriptors()) {
				rmSync(this.supervisorConfigPath, { force: true });
			}
		} else {
			for (const worker of this.workers.values()) {
				worker.intentionalStop = true;
				worker.client?.close();
				worker.client = undefined;
			}
		}
		await this.catalog.stop();
		for (const client of this.clients) {
			client.detachInput();
			client.socket.end();
		}
		await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()) ?? resolveClose());
		await this.runCleanupStep("daemon socket", () => this.cleanupSocket());
		await this.runCleanupStep("supervisor cache", () => {
			rmSync(this.snapshotCacheRoot, { recursive: true, force: true });
		});
		const lease = this.socketLease;
		this.socketLease = undefined;
		await this.runCleanupStep("daemon socket lock", async () => lease?.release());
		const ownership = this.ownership;
		this.ownership = undefined;
		await this.runCleanupStep("daemon ownership", async () => ownership?.release());
		if (relaunch) {
			const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", this.socketPath]);
			const environment = createCliSubprocessEnv();
			delete environment[DAEMON_CATALOG_ROLE_ENV];
			delete environment[DAEMON_WORKER_ROLE_ENV];
			delete environment[DAEMON_WORKER_TOKEN_ENV];
			delete environment[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
			delete environment[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			delete environment[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
			delete environment[ORPHAN_PROCESS_JOURNAL_ENV];
			delete environment[SESSION_LEASES_ENABLED_ENV];
			delete environment[SESSION_LEASE_OWNER_ID_ENV];
			const replacement = spawn(launch.command, launch.args, {
				cwd: this.defaultSessionConfig.cwd ?? process.cwd(),
				detached: true,
				env: environment,
				stdio: "ignore",
			});
			replacement.unref();
		}
		process.exit(exitCode);
	}
}
