import type { SessionSummary } from "./daemon-session-list.js";

// One status formula shared by every agent surface; surfaces adapt their inputs and never reimplement it.
export type AgentRosterStatus = "running" | "idle" | "inactive";

export interface AgentStatusInput {
	/** A live runtime exists for the agent. */
	resident: boolean;
	/** Admitted child run whose session has not materialized yet. */
	queuedChild: boolean;
	/** Actively working: streaming, running tools/bash, or running children. */
	busy: boolean;
	hasActiveHeartbeat: boolean;
}

export function classifyAgentStatus(input: AgentStatusInput): AgentRosterStatus {
	if (input.queuedChild) return "running";
	if (!input.resident) return "inactive";
	return input.busy || input.hasActiveHeartbeat ? "running" : "idle";
}

// A session summary without its heavyweight per-event fields; `list` re-adds an empty sessionActions.
export type RosterSessionSummary = Omit<SessionSummary, "streamingMessage" | "sessionActions" | "diagnostics">;

export interface WorkerRosterEntry {
	/** rlmChildId for subagents (stable queued->running->passivated), sessionId otherwise. */
	agentId: string;
	/** Admitted child run whose session has not materialized yet. */
	queuedChild?: true;
	summary: RosterSessionSummary;
}

/** Supervisor-owned roster row: a worker entry plus supervisor-only state. */
export interface AgentRosterEntry extends WorkerRosterEntry {
	status: AgentRosterStatus;
	statusLabel?: "queued" | "recovering" | "failed";
	/** Staleness marker set by the supervisor watchdog while the owning worker is silent. */
	lastHeardFromAt?: string;
	/** Owning resident worker; absent for seeded entries no worker has claimed. */
	workerId?: string;
}

export function rosterAgentIdForSummary(
	summary: Pick<SessionSummary, "runtimeKind" | "rlmChildId" | "sessionId">,
): string {
	return summary.runtimeKind === "subagent" && summary.rlmChildId ? summary.rlmChildId : summary.sessionId;
}

export function workerRosterEntryFromSummary(summary: SessionSummary): WorkerRosterEntry {
	const { streamingMessage, sessionActions, diagnostics, ...slim } = summary;
	return { agentId: rosterAgentIdForSummary(summary), summary: slim };
}

/** The roster half of the classifier input; the queuedChild bit rides the entry itself. */
export function classifyWorkerRosterEntry(entry: WorkerRosterEntry): AgentRosterStatus {
	const summary = entry.summary;
	return classifyAgentStatus({
		resident: !!summary.activeSessionId,
		queuedChild: entry.queuedChild === true,
		busy: summary.activity === "working" || summary.isSessionActive || summary.hasRunningRlmChildren === true,
		hasActiveHeartbeat: summary.hasActiveHeartbeat === true,
	});
}

/** Final entry for an agent whose runtime left memory; identity and display fields survive. */
export function passivatedWorkerRosterEntry(entry: WorkerRosterEntry): WorkerRosterEntry {
	const {
		activeSessionId,
		hasActiveHeartbeat,
		hasRunningRlmChildren,
		isBashRunning,
		isRunningTools,
		workerState,
		workerPid,
		...summary
	} = entry.summary;
	return {
		agentId: entry.agentId,
		summary: {
			...summary,
			// Inactive rows are keyed by their durable session id, like catalog rows.
			id: summary.sessionId,
			activity: "idle",
			isSessionActive: false,
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
		},
	};
}

export function sessionSummaryFromRosterEntry(entry: WorkerRosterEntry): SessionSummary {
	return { ...entry.summary, sessionActions: { queuedCount: 0, steering: [], followUps: [] } };
}

// Supervisor-owned roster store; write() classifies once and its file index converges seed and worker keys.
export class AgentRosterLedger {
	private readonly entries = new Map<string, AgentRosterEntry>();
	private readonly agentIdByActiveSessionId = new Map<string, string>();
	private readonly agentIdBySessionFile = new Map<string, string>();

	constructor(private readonly canonicalPath: (path: string) => string) {}

	values(): IterableIterator<AgentRosterEntry> {
		return this.entries.values();
	}

	get(agentId: string): AgentRosterEntry | undefined {
		return this.entries.get(agentId);
	}

	has(agentId: string): boolean {
		return this.entries.has(agentId);
	}

	byActiveSessionId(activeSessionId: string): AgentRosterEntry | undefined {
		const agentId = this.agentIdByActiveSessionId.get(activeSessionId);
		return agentId !== undefined ? this.entries.get(agentId) : undefined;
	}

	bySessionFile(canonicalPath: string): AgentRosterEntry | undefined {
		const agentId = this.agentIdBySessionFile.get(canonicalPath);
		return agentId !== undefined ? this.entries.get(agentId) : undefined;
	}

	hasSessionFile(canonicalPath: string): boolean {
		return this.agentIdBySessionFile.has(canonicalPath);
	}

	entriesForWorker(workerId: string): AgentRosterEntry[] {
		return [...this.entries.values()].filter((entry) => entry.workerId === workerId);
	}

	write(entry: WorkerRosterEntry, workerId?: string, statusLabel?: AgentRosterEntry["statusLabel"]): AgentRosterEntry {
		const stored: AgentRosterEntry = {
			...entry,
			status: classifyWorkerRosterEntry(entry),
			...(entry.queuedChild ? { statusLabel: "queued" as const } : statusLabel ? { statusLabel } : {}),
			...(workerId !== undefined ? { workerId } : {}),
		};
		const previous = this.entries.get(entry.agentId);
		if (previous) this.dropIndexes(previous);
		if (stored.summary.sessionFile) {
			const file = this.canonicalPath(stored.summary.sessionFile);
			const existingAgentId = this.agentIdBySessionFile.get(file);
			if (existingAgentId !== undefined && existingAgentId !== entry.agentId) {
				this.delete(existingAgentId);
			}
			this.agentIdBySessionFile.set(file, entry.agentId);
		}
		if (stored.summary.activeSessionId) {
			this.agentIdByActiveSessionId.set(stored.summary.activeSessionId, entry.agentId);
		}
		this.entries.set(entry.agentId, stored);
		return stored;
	}

	delete(agentId: string): void {
		const entry = this.entries.get(agentId);
		if (!entry) return;
		this.dropIndexes(entry);
		this.entries.delete(agentId);
	}

	private dropIndexes(entry: AgentRosterEntry): void {
		if (
			entry.summary.activeSessionId &&
			this.agentIdByActiveSessionId.get(entry.summary.activeSessionId) === entry.agentId
		) {
			this.agentIdByActiveSessionId.delete(entry.summary.activeSessionId);
		}
		if (entry.summary.sessionFile) {
			const file = this.canonicalPath(entry.summary.sessionFile);
			if (this.agentIdBySessionFile.get(file) === entry.agentId) {
				this.agentIdBySessionFile.delete(file);
			}
		}
	}
}
