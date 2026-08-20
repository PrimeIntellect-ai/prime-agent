import { closeSync, readFileSync } from "node:fs";
import type {
	AgentSessionMessageAgentSummary,
	AgentSessionMessageDeliveryMode,
	AgentSessionMessageSender,
} from "../../core/agent-messages.js";
import type { IdleEvictionMinutes } from "../../core/session-action-store.js";

export { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../../core/session-lease.js";

import type { DaemonClientCapability, DaemonCommand, DaemonOutbound } from "./daemon-protocol.js";

export const DAEMON_WORKER_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER";
export const DAEMON_WORKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN";
export const DAEMON_WORKER_ACTIVE_SESSION_ID_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
export const DAEMON_WORKER_SUPERVISOR_SOCKET_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET";
export const DAEMON_WORKER_RECOVERY_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL";
export const DAEMON_WORKER_STARTUP_GATE_FD_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD";
export const DAEMON_WORKER_STARTUP_GATE_COMMIT = "start\n";
export type DaemonWorkerLifecycle = "starting" | "ready" | "recovering" | "stopping" | "failed";

export type DaemonWorkerFrameHeader =
	| {
			kind: "command";
			requestId: string;
			commandType: string;
	  }
	| {
			kind: "outbound";
			requestId?: string;
			outboundType: DaemonOutbound["type"];
			activeSessionId?: string;
			snapshotId?: string;
			sessionEventType?: string;
			payloadEncoding?: "jsonl" | "assistant-delta";
			snapshotPurpose?: "attach" | "replacement" | "catchup";
	  };

export type DaemonCreateCommand = Extract<DaemonCommand, { type: "create" }>;

export interface DurableDaemonCreateCommand {
	type: "create";
	sessionPath?: string;
	noSession?: boolean;
}

export function durableDaemonCreateCommand(command: DaemonCreateCommand): DurableDaemonCreateCommand {
	return {
		type: "create",
		...(command.sessionPath !== undefined ? { sessionPath: command.sessionPath } : {}),
		...(command.noSession !== undefined ? { noSession: command.noSession } : {}),
	};
}

export type DaemonWorkerCommand =
	| {
			id?: string;
			type: "worker_auth";
			token: string;
			supervisorGeneration: string;
			supervisorPid: number;
			supervisorProcessStartId?: string;
			supervisorSocketPath: string;
	  }
	| {
			id?: string;
			type: "worker_subscribe";
			activeSessionId: string;
			capabilities?: readonly DaemonClientCapability[];
			supportsExtensionUi?: boolean;
	  }
	| { id?: string; type: "worker_unsubscribe"; activeSessionId: string }
	| { id?: string; type: "worker_sync_agent_peers"; peers: AgentSessionMessageAgentSummary[] }
	| { id?: string; type: "worker_archive_and_shutdown" }
	| {
			id?: string;
			type: "worker_passivate_idle_children";
			idleEvictionMinutes: IdleEvictionMinutes;
			now: number;
			limit: number;
	  }
	| {
			id?: string;
			type: "worker_deliver_message";
			targetActiveSessionId: string;
			message: string;
			sender: AgentSessionMessageSender;
			deliveryMode?: AgentSessionMessageDeliveryMode;
	  }
	| { id?: string; type: "worker_prepare_update" }
	| { id?: string; type: "worker_commit_update" }
	| { id?: string; type: "worker_cancel_update" };

export type DaemonWorkerCommandBody = DaemonWorkerCommand extends infer TCommand
	? TCommand extends { id?: string }
		? Omit<TCommand, "id">
		: never
	: never;

export interface DaemonWorkerDescriptor {
	version: 1 | 2;
	workerId: string;
	pid: number;
	processStartId?: string;
	socketPath: string;
	recoveryJournalPath: string;
	orphanProcessJournalPath?: string;
	supervisorSocketPath: string;
	authenticationToken: string;
	rootActiveSessionId: string;
	/** Stable protocol client that owns this worker. Omitted for resident sessions. */
	ownerClientId?: string;
	rootSessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	telemetryDisabled?: true;
	createdAt: string;
	updatedAt: string;
	lifecycle: DaemonWorkerLifecycle;
	createCommand: DurableDaemonCreateCommand;
	consecutiveFailures: number;
	/** Durable intent written before root termination so replacement supervisors never recover it. */
	stopRequestedAt?: string;
	/** Complete the root's archived lifecycle state after its process has stopped. */
	archiveOnStop?: boolean;
	lastFailureAt?: string;
	lastError?: string;
}

export function durableDaemonWorkerDescriptor(descriptor: DaemonWorkerDescriptor): DaemonWorkerDescriptor {
	const versionOneCreateCommand = descriptor.createCommand as unknown as { config?: unknown };
	const versionOneConfig =
		descriptor.version === 1 &&
		typeof versionOneCreateCommand.config === "object" &&
		versionOneCreateCommand.config !== null
			? (versionOneCreateCommand.config as Record<string, unknown>)
			: undefined;
	const sessionDir =
		descriptor.sessionDir ??
		(typeof versionOneConfig?.sessionDir === "string" ? versionOneConfig.sessionDir : undefined);
	const telemetryDisabled = descriptor.telemetryDisabled === true || versionOneConfig?.telemetryDisabled === true;
	return {
		version: 2,
		workerId: descriptor.workerId,
		pid: descriptor.pid,
		...(descriptor.processStartId !== undefined ? { processStartId: descriptor.processStartId } : {}),
		socketPath: descriptor.socketPath,
		recoveryJournalPath: descriptor.recoveryJournalPath,
		...(descriptor.orphanProcessJournalPath !== undefined
			? { orphanProcessJournalPath: descriptor.orphanProcessJournalPath }
			: {}),
		supervisorSocketPath: descriptor.supervisorSocketPath,
		authenticationToken: descriptor.authenticationToken,
		rootActiveSessionId: descriptor.rootActiveSessionId,
		...(descriptor.ownerClientId !== undefined ? { ownerClientId: descriptor.ownerClientId } : {}),
		...(descriptor.rootSessionId !== undefined ? { rootSessionId: descriptor.rootSessionId } : {}),
		...(descriptor.sessionFile !== undefined ? { sessionFile: descriptor.sessionFile } : {}),
		...(sessionDir !== undefined ? { sessionDir } : {}),
		...(telemetryDisabled ? { telemetryDisabled: true as const } : {}),
		createdAt: descriptor.createdAt,
		updatedAt: descriptor.updatedAt,
		lifecycle: descriptor.lifecycle,
		createCommand: durableDaemonCreateCommand(descriptor.createCommand),
		consecutiveFailures: descriptor.consecutiveFailures,
		...(descriptor.stopRequestedAt !== undefined ? { stopRequestedAt: descriptor.stopRequestedAt } : {}),
		...(descriptor.archiveOnStop !== undefined ? { archiveOnStop: descriptor.archiveOnStop } : {}),
		...(descriptor.lastFailureAt !== undefined ? { lastFailureAt: descriptor.lastFailureAt } : {}),
		...(descriptor.lifecycle === "failed" ? { lastError: "Waiting for a client with fresh runtime context" } : {}),
	};
}

export function isDaemonWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_WORKER_ROLE_ENV] === "1";
}

export function waitForDaemonWorkerStartupGate(environment: NodeJS.ProcessEnv = process.env): void {
	const rawFd = environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	if (rawFd === undefined) {
		return;
	}
	delete environment[DAEMON_WORKER_STARTUP_GATE_FD_ENV];
	const fd = Number(rawFd);
	if (!Number.isInteger(fd) || fd < 3) {
		throw new Error("Daemon session worker has an invalid startup gate");
	}
	let marker: string;
	try {
		marker = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	if (marker !== DAEMON_WORKER_STARTUP_GATE_COMMIT) {
		throw new Error("Daemon session worker startup was cancelled");
	}
}

export function requireDaemonWorkerAuthenticationToken(environment: NodeJS.ProcessEnv = process.env): string {
	const token = environment[DAEMON_WORKER_TOKEN_ENV];
	if (!token) {
		throw new Error("Daemon session worker is missing its authentication token");
	}
	return token;
}

export function isDaemonWorkerFrameHeader(value: unknown): value is DaemonWorkerFrameHeader {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "command") {
		return typeof candidate.requestId === "string" && typeof candidate.commandType === "string";
	}
	return (
		candidate.kind === "outbound" &&
		typeof candidate.outboundType === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string") &&
		(candidate.activeSessionId === undefined || typeof candidate.activeSessionId === "string") &&
		(candidate.snapshotId === undefined || typeof candidate.snapshotId === "string") &&
		(candidate.sessionEventType === undefined || typeof candidate.sessionEventType === "string") &&
		(candidate.snapshotPurpose === undefined ||
			candidate.snapshotPurpose === "attach" ||
			candidate.snapshotPurpose === "replacement" ||
			candidate.snapshotPurpose === "catchup") &&
		(candidate.payloadEncoding === undefined ||
			candidate.payloadEncoding === "jsonl" ||
			candidate.payloadEncoding === "assistant-delta")
	);
}
