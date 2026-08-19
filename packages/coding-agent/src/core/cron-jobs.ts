import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";
import { getSessionArtifactPathForFile } from "./session-manager.js";

export type AgentCronJobStatus = "active" | "paused" | "completed" | "cancelled";
export type AgentCronScheduleKind = "once" | "cron" | "interval";
export type AgentCronJobSource = "cron" | "heartbeat" | "rlm_heartbeat";
export type AgentCronJobRuntimeKind = "top-level" | "subagent";
export type AgentHeartbeatUpdateAction = "pause" | "resume" | "clear";
export type AgentHeartbeatManagementAction = "pause" | "resume" | "stop";
export type AgentRlmHeartbeatStatusUpdate = "pause" | "resume";
/**
 * How a scheduled heartbeat prompt is delivered when the target session is busy:
 * "steer" interrupts the current turn, "follow_up" waits for it to finish.
 */
export type AgentHeartbeatDeliveryMode = "steer" | "follow_up";

export interface AgentCronSchedule {
	kind: AgentCronScheduleKind;
	expression: string;
	intervalMs?: number;
}

export interface AgentCronJob {
	id: string;
	status: AgentCronJobStatus;
	source?: AgentCronJobSource;
	runtimeKind?: AgentCronJobRuntimeKind;
	/** Delivery mode for heartbeat/rlm_heartbeat jobs when the session is busy. Defaults to "steer". */
	deliveryMode?: AgentHeartbeatDeliveryMode;
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	label?: string;
	prompt: string;
	schedule: AgentCronSchedule;
	createdAt: string;
	updatedAt: string;
	nextRunAt?: string;
	lastRunAt?: string;
	lastSkippedAt?: string;
	lastError?: string;
	runCount: number;
}

export interface CreateAgentCronJobInput {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	label?: string;
	prompt: string;
	scheduleText: string;
	source?: AgentCronJobSource;
	runtimeKind?: AgentCronJobRuntimeKind;
	deliveryMode?: AgentHeartbeatDeliveryMode;
	now?: Date;
}

export type AgentCronJobRunResult = "ran" | "skipped";

export interface AgentCronDispatch {
	id: string;
	job: AgentCronJob;
}

export interface AgentCronSchedulerHooks {
	runJob: (job: AgentCronJob) => Promise<AgentCronJobRunResult | undefined>;
	beginDispatch?: (dispatch: AgentCronDispatch) => (() => void) | undefined;
	now?: () => Date;
	onError?: (job: AgentCronJob, error: unknown) => void;
}

export interface HeartbeatCronSessionActivity {
	isStreaming: boolean;
	isCompacting?: boolean;
	isRetrying?: boolean;
	isBashRunning: boolean;
	hasPendingSessionWork: boolean;
	unfinishedActionCount: number;
}

interface CronJobsFile {
	jobs?: unknown;
	dispatches?: unknown;
}

interface AgentCronDispatchRecord {
	id: string;
	jobId: string;
	claimedAt: string;
	scheduledFor: string;
}

interface CronJobsState {
	jobs: AgentCronJob[];
	dispatches: AgentCronDispatchRecord[];
}

export const SESSION_SCHEDULED_JOBS_FILENAME = "scheduled-jobs.json";

const MAX_TIMEOUT_MS = 2_147_483_647;
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60_000;
export const DEFAULT_HEARTBEAT_SCHEDULE = "every 5m";
export const DEFAULT_HEARTBEAT_DELIVERY_MODE: AgentHeartbeatDeliveryMode = "steer";

export type ParsedHeartbeatCommand =
	| { type: "status" }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "clear" }
	| { type: "set"; schedule: string; instruction: string; deliveryMode?: AgentHeartbeatDeliveryMode };

export interface AgentRlmHeartbeatController {
	listRlmHeartbeats(options?: { includeInactive?: boolean }): AgentCronJob[];
	createRlmHeartbeat(input: {
		instruction: string;
		interval?: string;
		label?: string;
		deliveryMode?: AgentHeartbeatDeliveryMode;
	}): AgentCronJob;
	updateRlmHeartbeat(input: {
		id: string;
		instruction?: string;
		interval?: string;
		label?: string;
		status?: AgentRlmHeartbeatStatusUpdate;
		deliveryMode?: AgentHeartbeatDeliveryMode;
	}): AgentCronJob | undefined;
	deleteRlmHeartbeat(id: string): AgentCronJob | undefined;
}

function heartbeatCatalogSignature(jobs: readonly AgentCronJob[]): string {
	return JSON.stringify(
		jobs
			.filter((job) => isHeartbeatCronJob(job) && (job.status === "active" || job.status === "paused"))
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((job) => ({
				id: job.id,
				status: job.status,
				source: job.source,
				runtimeKind: job.runtimeKind,
				deliveryMode: job.deliveryMode,
				activeSessionId: job.activeSessionId,
				sessionId: job.sessionId,
				sessionFile: job.sessionFile,
				cwd: job.cwd,
				label: job.label,
				prompt: job.prompt,
				schedule: job.schedule,
				createdAt: job.createdAt,
			})),
	);
}

export class AgentCronJobStore {
	private readonly sessionArtifactFiles = new Map<string, string>();
	private readonly heartbeatChangeListeners = new Set<() => void>();

	constructor(
		private readonly filePath?: string,
		private readonly sessionArtifactMode = false,
	) {
		if (!filePath && !sessionArtifactMode) {
			throw new Error("Cron job store requires a file path");
		}
	}

	static forSessionArtifacts(): AgentCronJobStore {
		return new AgentCronJobStore(undefined, true);
	}

	onHeartbeatChange(listener: () => void): () => void {
		this.heartbeatChangeListeners.add(listener);
		return () => this.heartbeatChangeListeners.delete(listener);
	}

	registerSessionArtifact(sessionId: string, artifactDir: string): boolean {
		if (!this.sessionArtifactMode) {
			return false;
		}
		const path = join(artifactDir, SESSION_SCHEDULED_JOBS_FILENAME);
		if (this.sessionArtifactFiles.get(sessionId) === path) {
			return false;
		}
		this.sessionArtifactFiles.set(sessionId, path);
		return true;
	}

	recoverSessionArtifact(sessionId: string, now = new Date()): AgentCronJob[] {
		const path = this.sessionArtifactFiles.get(sessionId);
		if (!path) {
			return [];
		}
		return withCronJobsStateLocks([path], () => {
			const state = readJobsState(path);
			const recovered: AgentCronJob[] = [];
			if (state.dispatches.length > 0) {
				recoverInterruptedInState(state, now, recovered);
				writeJobsState(path, state);
			}
			return recovered;
		});
	}

	list(): AgentCronJob[] {
		return this.readJobs().sort((a, b) => compareOptionalIso(a.nextRunAt, b.nextRunAt));
	}

	create(input: CreateAgentCronJobInput): AgentCronJob {
		const now = input.now ?? new Date();
		const prompt = input.prompt.trim();
		if (!prompt) {
			throw new Error("Cron job prompt cannot be empty");
		}
		const parsed = parseAgentCronSchedule(input.scheduleText, now);
		const nowIso = now.toISOString();
		const job: AgentCronJob = {
			id: randomUUID(),
			status: "active",
			source: input.source ?? "cron",
			runtimeKind: input.runtimeKind,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: normalizeOptionalLabel(input.label),
			prompt,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.writeJobs([...this.readJobs(), job]);
		return job;
	}

	/**
	 * Active session ids are daemon-local. When a persisted session is restored,
	 * bind jobs stored for its stable session file to the new live session id.
	 * When a live session switches to another persisted file, move jobs stored for
	 * its stable active session id to the new file so future restores target the
	 * current session instead of the previous one.
	 */
	rebindSessionJobs(input: {
		activeSessionId: string;
		sessionId: string;
		sessionFile: string;
		cwd: string;
	}): AgentCronJob[] {
		const targetSessionFile = resolve(input.sessionFile);
		const reboundJobs: AgentCronJob[] = [];
		const jobs = this.readJobs().map((job) => {
			if (job.activeSessionId !== input.activeSessionId && resolve(job.sessionFile) !== targetSessionFile) {
				return job;
			}
			if (
				job.activeSessionId === input.activeSessionId &&
				job.sessionId === input.sessionId &&
				resolve(job.sessionFile) === targetSessionFile &&
				job.cwd === input.cwd
			) {
				return job;
			}
			const rebound = {
				...job,
				activeSessionId: input.activeSessionId,
				sessionId: input.sessionId,
				sessionFile: input.sessionFile,
				cwd: input.cwd,
			};
			reboundJobs.push(rebound);
			return rebound;
		});
		if (reboundJobs.length > 0) {
			this.writeJobs(jobs);
		}
		return reboundJobs;
	}

	getHeartbeat(activeSessionId: string): AgentCronJob | undefined {
		return this.readJobs()
			.filter((job) => {
				return (
					job.activeSessionId === activeSessionId &&
					job.source === "heartbeat" &&
					(job.status === "active" || job.status === "paused")
				);
			})
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
	}

	getLatestHeartbeat(activeSessionId: string): AgentCronJob | undefined {
		return this.readJobs()
			.filter((job) => job.activeSessionId === activeSessionId && job.source === "heartbeat")
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
	}

	createHeartbeat(input: CreateAgentCronJobInput): AgentCronJob {
		const now = input.now ?? new Date();
		const parsed = parseAgentCronSchedule(input.scheduleText, now);
		if (parsed.schedule.kind === "once") {
			throw new Error("Heartbeat schedule must be recurring");
		}
		const existing = this.readJobs().map((job) => {
			if (
				job.activeSessionId === input.activeSessionId &&
				job.source === "heartbeat" &&
				(job.status === "active" || job.status === "paused")
			) {
				return { ...job, status: "cancelled" as const, nextRunAt: undefined, updatedAt: now.toISOString() };
			}
			return job;
		});
		const prompt = input.prompt.trim();
		if (!prompt) {
			throw new Error("Heartbeat instruction cannot be empty");
		}
		const nowIso = now.toISOString();
		const job: AgentCronJob = {
			id: randomUUID(),
			status: "active",
			source: "heartbeat",
			runtimeKind: input.runtimeKind,
			deliveryMode: input.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: normalizeOptionalLabel(input.label),
			prompt,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.writeJobs([...existing, job]);
		return job;
	}

	listRlmHeartbeats(activeSessionId: string, options: { includeInactive?: boolean } = {}): AgentCronJob[] {
		return this.readJobs()
			.filter((job) => {
				if (job.activeSessionId !== activeSessionId || job.source !== "rlm_heartbeat") {
					return false;
				}
				if (options.includeInactive) {
					return true;
				}
				return job.status === "active" || job.status === "paused";
			})
			.sort((a, b) => compareOptionalIso(a.nextRunAt, b.nextRunAt));
	}

	createRlmHeartbeat(input: CreateAgentCronJobInput): AgentCronJob {
		const now = input.now ?? new Date();
		const parsed = parseAgentCronSchedule(input.scheduleText, now);
		if (parsed.schedule.kind === "once") {
			throw new Error("RLM heartbeat schedule must be recurring");
		}
		const prompt = input.prompt.trim();
		if (!prompt) {
			throw new Error("RLM heartbeat instruction cannot be empty");
		}
		const nowIso = now.toISOString();
		const job: AgentCronJob = {
			id: randomUUID(),
			status: "active",
			source: "rlm_heartbeat",
			runtimeKind: input.runtimeKind,
			deliveryMode: input.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: normalizeOptionalLabel(input.label),
			prompt,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.writeJobs([...this.readJobs(), job]);
		return job;
	}

	updateRlmHeartbeat(
		activeSessionId: string,
		id: string,
		update: {
			label?: string;
			prompt?: string;
			scheduleText?: string;
			status?: AgentRlmHeartbeatStatusUpdate;
			deliveryMode?: AgentHeartbeatDeliveryMode;
			now?: Date;
		},
	): AgentCronJob | undefined {
		const now = update.now ?? new Date();
		let updated: AgentCronJob | undefined;
		let matchedRlmHeartbeat = false;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.activeSessionId !== activeSessionId || job.source !== "rlm_heartbeat") {
				return job;
			}
			matchedRlmHeartbeat = true;
			if (job.status === "cancelled" || job.status === "completed") {
				return job;
			}
			let nextJob: AgentCronJob = { ...job };
			if (update.label !== undefined) {
				nextJob = { ...nextJob, label: normalizeOptionalLabel(update.label) };
			}
			if (update.deliveryMode !== undefined) {
				nextJob = { ...nextJob, deliveryMode: update.deliveryMode };
			}
			if (update.prompt !== undefined) {
				const prompt = update.prompt.trim();
				if (!prompt) {
					throw new Error("RLM heartbeat instruction cannot be empty");
				}
				nextJob = { ...nextJob, prompt };
			}
			if (update.scheduleText !== undefined) {
				const parsed = parseAgentCronSchedule(update.scheduleText, now);
				if (parsed.schedule.kind === "once") {
					throw new Error("RLM heartbeat schedule must be recurring");
				}
				nextJob =
					nextJob.status === "paused"
						? withoutNextRunAt({ ...nextJob, schedule: parsed.schedule })
						: { ...nextJob, schedule: parsed.schedule, nextRunAt: parsed.nextRunAt.toISOString() };
			}
			if (update.status === "pause") {
				nextJob = withoutNextRunAt({ ...nextJob, status: "paused" });
			} else if (update.status === "resume") {
				const nextRunAt = nextRunAtForSchedule(nextJob.schedule, now);
				if (!nextRunAt) {
					throw new Error("RLM heartbeat schedule must be recurring");
				}
				nextJob = { ...nextJob, status: "active", nextRunAt: nextRunAt.toISOString() };
			}
			updated = { ...nextJob, updatedAt: now.toISOString() };
			return updated;
		});
		if (matchedRlmHeartbeat && updated) {
			this.writeJobs(jobs);
		}
		return updated;
	}

	deleteRlmHeartbeat(activeSessionId: string, id: string, now = new Date()): AgentCronJob | undefined {
		let deleted: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.activeSessionId !== activeSessionId || job.source !== "rlm_heartbeat") {
				return job;
			}
			deleted = withoutNextRunAt({ ...job, status: "cancelled", updatedAt: now.toISOString() });
			return deleted;
		});
		if (deleted) {
			this.writeJobs(jobs);
		}
		return deleted;
	}

	cancelRlmHeartbeatsForSession(activeSessionId: string, now = new Date()): AgentCronJob[] {
		const cancelled: AgentCronJob[] = [];
		const jobs = this.readJobs().map((job) => {
			if (
				job.activeSessionId !== activeSessionId ||
				job.source !== "rlm_heartbeat" ||
				(job.status !== "active" && job.status !== "paused")
			) {
				return job;
			}
			const cancelledJob = withoutNextRunAt({ ...job, status: "cancelled", updatedAt: now.toISOString() });
			cancelled.push(cancelledJob);
			return cancelledJob;
		});
		if (cancelled.length > 0) {
			this.writeJobs(jobs);
		}
		return cancelled;
	}

	cancelJobsForSession(
		input: { activeSessionId?: string; sessionId?: string; sessionFile?: string },
		now = new Date(),
	): AgentCronJob[] {
		const targetSessionFile = input.sessionFile ? resolve(input.sessionFile) : undefined;
		const cancelled: AgentCronJob[] = [];
		const jobs = this.readJobs().map((job) => {
			const matches =
				(input.activeSessionId !== undefined && job.activeSessionId === input.activeSessionId) ||
				(input.sessionId !== undefined && job.sessionId === input.sessionId) ||
				(targetSessionFile !== undefined && resolve(job.sessionFile) === targetSessionFile);
			if (!matches || (job.status !== "active" && job.status !== "paused")) {
				return job;
			}
			const cancelledJob = withoutNextRunAt({ ...job, status: "cancelled", updatedAt: now.toISOString() });
			cancelled.push(cancelledJob);
			return cancelledJob;
		});
		if (cancelled.length > 0) {
			this.writeJobs(jobs);
		}
		return cancelled;
	}

	pauseHeartbeat(activeSessionId: string, now = new Date()): AgentCronJob | undefined {
		let paused: AgentCronJob | undefined;
		const current = this.getHeartbeat(activeSessionId);
		if (!current) {
			return undefined;
		}
		const jobs = this.readJobs().map((job) => {
			if (job.id !== current.id) {
				return job;
			}
			paused = { ...job, status: "paused", nextRunAt: undefined, updatedAt: now.toISOString() };
			return paused;
		});
		this.writeJobs(jobs);
		return paused;
	}

	resumeHeartbeat(activeSessionId: string, now = new Date()): AgentCronJob | undefined {
		let resumed: AgentCronJob | undefined;
		const current = this.getHeartbeat(activeSessionId);
		if (!current) {
			return undefined;
		}
		const nextRunAt = nextRunAtForSchedule(current.schedule, now);
		if (!nextRunAt) {
			throw new Error("Heartbeat schedule must be recurring");
		}
		const jobs = this.readJobs().map((job) => {
			if (job.id !== current.id) {
				return job;
			}
			resumed = { ...job, status: "active", nextRunAt: nextRunAt.toISOString(), updatedAt: now.toISOString() };
			return resumed;
		});
		this.writeJobs(jobs);
		return resumed;
	}

	clearHeartbeat(activeSessionId: string, now = new Date()): AgentCronJob | undefined {
		let cleared: AgentCronJob | undefined;
		const current = this.getHeartbeat(activeSessionId);
		if (!current) {
			return undefined;
		}
		const jobs = this.readJobs().map((job) => {
			if (job.id !== current.id) {
				return job;
			}
			cleared = { ...job, status: "cancelled", nextRunAt: undefined, updatedAt: now.toISOString() };
			return cleared;
		});
		this.writeJobs(jobs);
		return cleared;
	}

	manageHeartbeat(
		activeSessionId: string,
		id: string,
		action: AgentHeartbeatManagementAction,
		now = new Date(),
	): AgentCronJob | undefined {
		let updated: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.activeSessionId !== activeSessionId || !isHeartbeatCronJob(job)) {
				return job;
			}
			if (job.status === "cancelled" || job.status === "completed") {
				return job;
			}
			if (action === "pause") {
				updated = withoutNextRunAt({ ...job, status: "paused", updatedAt: now.toISOString() });
				return updated;
			}
			if (action === "stop") {
				updated = withoutNextRunAt({ ...job, status: "cancelled", updatedAt: now.toISOString() });
				return updated;
			}
			const nextRunAt = nextRunAtForSchedule(job.schedule, now);
			if (!nextRunAt) {
				throw new Error("Heartbeat schedule must be recurring");
			}
			updated = {
				...job,
				status: "active",
				nextRunAt: nextRunAt.toISOString(),
				updatedAt: now.toISOString(),
			};
			return updated;
		});
		if (updated) {
			this.writeJobs(jobs);
		}
		return updated;
	}

	cancel(id: string, now = new Date()): AgentCronJob | undefined {
		let cancelled: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.status === "cancelled") {
				return job;
			}
			cancelled = { ...job, status: "cancelled", nextRunAt: undefined, updatedAt: now.toISOString() };
			return cancelled;
		});
		if (cancelled) {
			this.writeJobs(jobs);
		}
		return cancelled;
	}

	recordRunResult(id: string, result: { now?: Date; error?: unknown }): AgentCronJob | undefined {
		const now = result.now ?? new Date();
		let updated: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id) {
				return job;
			}
			if (job.status !== "active") {
				updated = job;
				return job;
			}
			const lastError = result.error === undefined ? undefined : errorMessage(result.error);
			const nextRunAt =
				job.schedule.kind === "cron"
					? nextRunAtForSchedule(job.schedule, new Date(now.getTime() + 1))
					: job.schedule.kind === "interval"
						? nextRunAtForSchedule(job.schedule, now)
						: undefined;
			updated = {
				...job,
				status: job.schedule.kind === "once" ? "completed" : "active",
				nextRunAt: nextRunAt?.toISOString(),
				lastRunAt: now.toISOString(),
				lastError,
				runCount: job.runCount + 1,
				updatedAt: now.toISOString(),
			};
			return updated;
		});
		if (updated) {
			this.writeJobs(jobs);
		}
		return updated;
	}

	recordSkipResult(id: string, result: { now?: Date }): AgentCronJob | undefined {
		const now = result.now ?? new Date();
		let updated: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id) {
				return job;
			}
			if (job.status !== "active") {
				updated = job;
				return job;
			}
			const nextRunAt = nextRunAtForSchedule(job.schedule, now);
			updated = {
				...job,
				nextRunAt: nextRunAt?.toISOString(),
				lastSkippedAt: now.toISOString(),
				updatedAt: now.toISOString(),
			};
			return updated;
		});
		if (updated) {
			this.writeJobs(jobs);
		}
		return updated;
	}

	due(now = new Date()): AgentCronJob[] {
		return this.readJobs().filter((job) => isDueJob(job, now));
	}

	claimDue(dueAt = new Date(), claimedAt = dueAt): AgentCronDispatch[] {
		return this.mutateStates((state) => claimDueInState(state, dueAt, claimedAt));
	}

	getClaimedJob(id: string): AgentCronJob | undefined {
		for (const state of this.readStates()) {
			if (!state.dispatches.some((dispatch) => dispatch.jobId === id)) {
				continue;
			}
			return state.jobs.find((job) => job.id === id && job.status === "active");
		}
		return undefined;
	}

	recordDispatchResult(
		dispatchId: string,
		result: { now?: Date; outcome: AgentCronJobRunResult; error?: unknown },
	): AgentCronJob | undefined {
		let updated: AgentCronJob | undefined;
		this.mutateStates((state) => {
			const dispatch = state.dispatches.find((candidate) => candidate.id === dispatchId);
			if (!dispatch) {
				return [];
			}
			const now = result.now ?? new Date();
			state.dispatches = state.dispatches.filter((candidate) => candidate.id !== dispatchId);
			state.jobs = state.jobs.map((job) => {
				if (job.id !== dispatch.jobId || job.status !== "active") {
					return job;
				}
				if (result.outcome === "skipped" && result.error === undefined) {
					const nextRunAt = nextRunAtForSchedule(job.schedule, now);
					updated = {
						...job,
						status: job.schedule.kind === "once" ? "completed" : job.status,
						nextRunAt: nextRunAt?.toISOString(),
						lastSkippedAt: now.toISOString(),
						updatedAt: now.toISOString(),
					};
					return updated;
				}
				updated = {
					...job,
					status: job.schedule.kind === "once" ? "completed" : job.status,
					lastRunAt: now.toISOString(),
					lastError: result.error === undefined ? undefined : errorMessage(result.error),
					runCount: job.runCount + 1,
					updatedAt: now.toISOString(),
				};
				return updated;
			});
			return [];
		});
		return updated;
	}

	recoverInterruptedDispatches(now = new Date()): AgentCronJob[] {
		const recovered: AgentCronJob[] = [];
		this.mutateStates((state) => {
			recoverInterruptedInState(state, now, recovered);
			return [];
		});
		return recovered;
	}

	recoverInterruptedDispatchesById(dispatchIds: readonly string[], now = new Date()): AgentCronJob[] {
		const recovered: AgentCronJob[] = [];
		const interruptedDispatchIds = new Set(dispatchIds);
		this.mutateStates((state) => {
			recoverInterruptedInState(state, now, recovered, interruptedDispatchIds);
			return [];
		});
		return recovered;
	}

	getDueJob(id: string, now = new Date()): AgentCronJob | undefined {
		return this.readJobs().find((job) => job.id === id && isDueJob(job, now));
	}

	nextActiveRunAt(): Date | undefined {
		const times = this.readJobs()
			.filter((job) => job.status === "active" && job.nextRunAt !== undefined)
			.map((job) => new Date(job.nextRunAt!))
			.filter((date) => Number.isFinite(date.getTime()))
			.sort((a, b) => a.getTime() - b.getTime());
		return times[0];
	}

	private readJobs(): AgentCronJob[] {
		return this.readStates().flatMap((state) => state.jobs);
	}

	private readStates(): CronJobsState[] {
		if (this.sessionArtifactMode) {
			return [...this.sessionArtifactFiles.values()].map((path) => readJobsState(path));
		}
		return [readJobsState(this.requireFilePath())];
	}

	private mutateStates(mutator: (state: CronJobsState) => AgentCronDispatch[]): AgentCronDispatch[] {
		const paths = this.sessionArtifactMode ? [...this.sessionArtifactFiles.values()] : [this.requireFilePath()];
		const previousHeartbeats = heartbeatCatalogSignature(this.readJobs());
		let changed = false;
		const dispatches = withCronJobsStateLocks(paths, () => {
			const dispatches: AgentCronDispatch[] = [];
			for (const path of paths) {
				const state = readJobsState(path);
				const before = JSON.stringify(state);
				dispatches.push(...mutator(state));
				if (JSON.stringify(state) !== before) {
					writeJobsState(path, state);
					changed = true;
				}
			}
			return dispatches;
		});
		if (changed && heartbeatCatalogSignature(this.readJobs()) !== previousHeartbeats) {
			this.notifyHeartbeatChange();
		}
		return dispatches;
	}

	private writeJobs(jobs: readonly AgentCronJob[]): void {
		const previousHeartbeats = heartbeatCatalogSignature(this.readJobs());
		if (this.sessionArtifactMode) {
			const registeredSessionIds = new Set(this.sessionArtifactFiles.keys());
			const unregistered = jobs.find((job) => !registeredSessionIds.has(job.sessionId));
			if (unregistered) {
				throw new Error(`Cron job ${unregistered.id} targets an unregistered session artifact`);
			}
			const paths = [...this.sessionArtifactFiles.values()];
			withCronJobsStateLocks(paths, () => {
				const currentBySessionId = new Map(
					[...this.sessionArtifactFiles].map(([sessionId, path]) => [sessionId, readJobsState(path)]),
				);
				const incomingById = new Map(jobs.map((job) => [job.id, job]));
				const mergedJobsBySessionId = new Map<string, AgentCronJob[]>();
				for (const [sessionId, current] of currentBySessionId) {
					const retained = current.jobs.filter((job) => {
						const incoming = incomingById.get(job.id);
						return incoming === undefined || incoming.sessionId === sessionId;
					});
					mergedJobsBySessionId.set(
						sessionId,
						mergeFreshJobs(
							retained,
							jobs.filter((job) => job.sessionId === sessionId),
						),
					);
				}
				const sessionIdByJobId = new Map(
					[...mergedJobsBySessionId].flatMap(([sessionId, sessionJobs]) =>
						sessionJobs.map((job) => [job.id, sessionId] as const),
					),
				);
				const dispatches = [...currentBySessionId.values()].flatMap((state) => state.dispatches);
				for (const [sessionId, path] of this.sessionArtifactFiles) {
					const current = currentBySessionId.get(sessionId) ?? { jobs: [], dispatches: [] };
					const nextState = {
						jobs: mergedJobsBySessionId.get(sessionId) ?? [],
						dispatches: dispatches.filter((dispatch) => sessionIdByJobId.get(dispatch.jobId) === sessionId),
					};
					if (JSON.stringify(current) !== JSON.stringify(nextState)) {
						writeJobsState(path, nextState);
					}
				}
			});
			if (heartbeatCatalogSignature(this.readJobs()) !== previousHeartbeats) {
				this.notifyHeartbeatChange();
			}
			return;
		}
		const path = this.requireFilePath();
		withCronJobsStateLocks([path], () => writeJobsFile(path, jobs, true));
		if (heartbeatCatalogSignature(this.readJobs()) !== previousHeartbeats) {
			this.notifyHeartbeatChange();
		}
	}

	private notifyHeartbeatChange(): void {
		for (const listener of this.heartbeatChangeListeners) {
			listener();
		}
	}

	private requireFilePath(): string {
		if (!this.filePath) {
			throw new Error("Cron job store does not have a legacy file path");
		}
		return this.filePath;
	}
}

export function migrateLegacyCronJobsToSessionArtifacts(
	filePath: string,
	options: { isSessionOwned?: (job: AgentCronJob) => boolean; now?: Date } = {},
): number {
	const now = options.now ?? new Date();
	const legacyState = readJobsState(filePath);
	recoverInterruptedInState(legacyState, now, []);
	const jobs = legacyState.jobs.map((job) => {
		if (
			!options.isSessionOwned ||
			options.isSessionOwned(job) ||
			(job.status !== "active" && job.status !== "paused")
		) {
			return job;
		}
		return withoutNextRunAt({ ...job, status: "cancelled", updatedAt: now.toISOString() });
	});
	if (jobs.length === 0) {
		return 0;
	}
	const jobsByArtifact = new Map<string, AgentCronJob[]>();
	for (const job of jobs) {
		const artifactPath = join(
			getSessionArtifactPathForFile(resolve(job.sessionFile), job.sessionId),
			SESSION_SCHEDULED_JOBS_FILENAME,
		);
		const grouped = jobsByArtifact.get(artifactPath) ?? [];
		grouped.push(job);
		jobsByArtifact.set(artifactPath, grouped);
	}
	for (const [artifactPath, artifactJobs] of jobsByArtifact) {
		writeJobsFile(artifactPath, artifactJobs, true);
	}
	renameSync(filePath, `${filePath}.migrated-${Date.now()}`);
	return jobs.length;
}

export class AgentCronScheduler {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = true;
	private hasStarted = false;
	private readonly dispatchLanes = new Map<string, Promise<void>>();

	constructor(
		private readonly store: AgentCronJobStore,
		private readonly hooks: AgentCronSchedulerHooks,
	) {}

	start(): void {
		this.stopped = false;
		if (!this.hasStarted) {
			this.hasStarted = true;
			this.store.recoverInterruptedDispatches(this.now());
		}
		this.scheduleNext();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	wake(): void {
		if (this.stopped) {
			return;
		}
		this.scheduleNext(0);
	}

	async runDue(now = this.now()): Promise<number> {
		if (this.running || (this.stopped && this.hasStarted)) {
			return 0;
		}
		this.running = true;
		const dispatches: Array<{ dispatch: AgentCronDispatch; endDispatch?: () => void }> = [];
		let claimedDispatches: AgentCronDispatch[] | undefined;
		try {
			claimedDispatches = this.store.claimDue(now, this.now());
			for (const dispatch of claimedDispatches) {
				dispatches.push({ dispatch, endDispatch: this.hooks.beginDispatch?.(dispatch) });
			}
		} catch (error) {
			for (const claimed of dispatches) claimed.endDispatch?.();
			if (claimedDispatches) {
				this.store.recoverInterruptedDispatchesById(
					claimedDispatches.map((dispatch) => dispatch.id),
					this.now(),
				);
			}
			throw error;
		} finally {
			this.running = false;
			if (!this.stopped) {
				this.scheduleNext();
			}
		}
		const results = await Promise.all(
			dispatches.map(({ dispatch, endDispatch }) => this.queueDispatch(dispatch, endDispatch)),
		);
		return results.filter((result) => result !== "skipped").length;
	}

	private queueDispatch(
		dispatch: AgentCronDispatch,
		endDispatch?: () => void,
	): Promise<AgentCronJobRunResult | undefined> {
		const laneKey = dispatch.job.activeSessionId;
		const previous = this.dispatchLanes.get(laneKey) ?? Promise.resolve();
		const task = previous
			.catch(() => undefined)
			.then(async (): Promise<AgentCronJobRunResult | undefined> => {
				try {
					const job = this.store.getClaimedJob(dispatch.job.id);
					if (!job) {
						this.store.recordDispatchResult(dispatch.id, { now: this.now(), outcome: "skipped" });
						return "skipped";
					}
					let runResult: AgentCronJobRunResult | undefined;
					let error: unknown;
					try {
						runResult = await this.hooks.runJob(job);
					} catch (runError) {
						error = runError;
						this.hooks.onError?.(job, runError);
					}
					this.store.recordDispatchResult(dispatch.id, {
						now: this.now(),
						outcome: runResult === "skipped" && error === undefined ? "skipped" : "ran",
						error,
					});
					return runResult;
				} finally {
					endDispatch?.();
				}
			});
		const lane = task.then(
			() => undefined,
			() => undefined,
		);
		this.dispatchLanes.set(laneKey, lane);
		void lane.finally(() => {
			if (this.dispatchLanes.get(laneKey) === lane) {
				this.dispatchLanes.delete(laneKey);
			}
		});
		return task;
	}

	private scheduleNext(delayMs?: number): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const now = this.now();
		const nextDelay =
			delayMs ??
			(() => {
				const next = this.store.nextActiveRunAt();
				if (!next) {
					return undefined;
				}
				return Math.max(0, next.getTime() - now.getTime());
			})();
		if (nextDelay === undefined) {
			return;
		}
		this.timer = setTimeout(
			() => {
				void this.runDue();
			},
			Math.min(nextDelay, MAX_TIMEOUT_MS),
		);
	}

	private now(): Date {
		return this.hooks.now?.() ?? new Date();
	}
}

export function parseAgentCronSchedule(
	input: string,
	now = new Date(),
): { schedule: AgentCronSchedule; nextRunAt: Date } {
	const text = stripMatchingQuotes(input.trim());
	if (!text) {
		throw new Error("Cron schedule cannot be empty");
	}

	const inMatch = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(text);
	if (inMatch) {
		const amount = Number.parseInt(inMatch[1]!, 10);
		const unit = inMatch[2]!.toLowerCase();
		const multiplier = unit.startsWith("m")
			? ONE_MINUTE_MS
			: unit.startsWith("h")
				? 60 * ONE_MINUTE_MS
				: 24 * 60 * ONE_MINUTE_MS;
		return {
			schedule: { kind: "once", expression: text },
			nextRunAt: new Date(now.getTime() + amount * multiplier),
		};
	}

	const everyMatch =
		/^(?:every|each)\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(
			text,
		);
	if (everyMatch) {
		const amount = Number.parseInt(everyMatch[1]!, 10);
		const unit = everyMatch[2]!.toLowerCase();
		const multiplier = unit.startsWith("s")
			? ONE_SECOND_MS
			: unit.startsWith("m")
				? ONE_MINUTE_MS
				: 60 * ONE_MINUTE_MS;
		const intervalMs = amount * multiplier;
		if (intervalMs < 10 * ONE_SECOND_MS) {
			throw new Error("Recurring interval must be at least 10 seconds");
		}
		return {
			schedule: { kind: "interval", expression: text, intervalMs },
			nextRunAt: new Date(now.getTime() + intervalMs),
		};
	}

	if (text.toLowerCase().startsWith("at ")) {
		const when = new Date(text.slice(3).trim());
		if (!Number.isFinite(when.getTime())) {
			throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
		}
		if (when.getTime() <= now.getTime()) {
			throw new Error("One-shot schedule must be in the future");
		}
		return { schedule: { kind: "once", expression: text }, nextRunAt: when };
	}

	const expression = normalizeCronAlias(text);
	const nextRunAt = nextCronRunAfter(expression, now);
	return { schedule: { kind: "cron", expression }, nextRunAt };
}

export function normalizeHeartbeatSchedule(input: string | undefined): string {
	const text = input?.trim();
	if (!text) {
		return DEFAULT_HEARTBEAT_SCHEDULE;
	}
	if (/^\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(text)) {
		return `every ${text}`;
	}
	return text;
}

export function normalizeHeartbeatDeliveryMode(value: unknown): AgentHeartbeatDeliveryMode | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (value === "steer" || value === "follow_up") {
		return value;
	}
	throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
}

export function resolveHeartbeatStreamingBehavior(
	deliveryMode: AgentHeartbeatDeliveryMode | undefined,
): "steer" | "followUp" {
	return (deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE) === "follow_up" ? "followUp" : "steer";
}

export function parseHeartbeatCommand(input: string): ParsedHeartbeatCommand {
	const text = input.replace(/^\/heartbeat\b/, "").trim();
	if (!text || text === "status") {
		return { type: "status" };
	}
	if (text === "pause") {
		return { type: "pause" };
	}
	if (text === "resume") {
		return { type: "resume" };
	}
	if (text === "clear" || text === "stop") {
		return { type: "clear" };
	}

	const leadingDelivery = consumeDeliveryOption(text);
	let deliveryMode = leadingDelivery.deliveryMode;
	let remaining = leadingDelivery.rest;

	const option = consumeEveryOption(remaining);
	if (option) {
		const trailingDelivery = consumeDeliveryOption(option.rest);
		deliveryMode = trailingDelivery.deliveryMode ?? deliveryMode;
		if (!trailingDelivery.rest) {
			throw new Error("Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>");
		}
		return {
			type: "set",
			schedule: normalizeHeartbeatSchedule(option.interval),
			instruction: trailingDelivery.rest,
			...(deliveryMode ? { deliveryMode } : {}),
		};
	}

	const leadingSchedule = consumeLeadingEverySchedule(remaining);
	if (leadingSchedule) {
		const trailingDelivery = consumeDeliveryOption(leadingSchedule.rest);
		deliveryMode = trailingDelivery.deliveryMode ?? deliveryMode;
		if (!trailingDelivery.rest) {
			throw new Error("Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>");
		}
		return {
			type: "set",
			schedule: normalizeHeartbeatSchedule(leadingSchedule.interval),
			instruction: trailingDelivery.rest,
			...(deliveryMode ? { deliveryMode } : {}),
		};
	}

	remaining = remaining.trim();
	if (!remaining) {
		throw new Error("Usage: /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>");
	}
	return {
		type: "set",
		schedule: DEFAULT_HEARTBEAT_SCHEDULE,
		instruction: remaining,
		...(deliveryMode ? { deliveryMode } : {}),
	};
}

export function nextRunAtForSchedule(schedule: AgentCronSchedule, after: Date): Date | undefined {
	if (schedule.kind === "once") {
		return undefined;
	}
	if (schedule.kind === "interval") {
		if (!schedule.intervalMs || schedule.intervalMs <= 0) {
			throw new Error(`Invalid interval schedule: ${schedule.expression}`);
		}
		return new Date(after.getTime() + schedule.intervalMs);
	}
	return nextCronRunAfter(schedule.expression, after);
}

export function formatAgentCronJob(job: AgentCronJob): string {
	const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "-";
	const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "-";
	const preview = job.prompt.replace(/\s+/g, " ").slice(0, 80);
	const error = job.lastError ? ` error=${job.lastError}` : "";
	const label = job.label ? ` label="${job.label}"` : "";
	const skipped = job.lastSkippedAt ? ` skipped=${new Date(job.lastSkippedAt).toLocaleString()}` : "";
	return `${job.id} ${job.status}${label} next=${next} last=${last}${skipped} runs=${job.runCount} schedule="${job.schedule.expression}" prompt="${preview}"${error}`;
}

function consumeDeliveryOption(text: string): { deliveryMode: AgentHeartbeatDeliveryMode | undefined; rest: string } {
	let rest = text.trim();
	if (/(?:^|\s)--deliver=?$/i.test(rest)) {
		throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
	}
	let deliveryMode: AgentHeartbeatDeliveryMode | undefined;
	let leading = consumeLeadingDeliveryFlag(rest);
	while (leading) {
		deliveryMode = leading.deliveryMode;
		rest = leading.rest.trim();
		leading = consumeLeadingDeliveryFlag(rest);
	}

	let trailing = consumeTrailingDeliveryFlag(rest);
	let trailingDeliveryMode: AgentHeartbeatDeliveryMode | undefined;
	while (trailing) {
		// Consume all trailing flags, but keep the rightmost flag's mode because it
		// is textually latest and should win over earlier flags.
		trailingDeliveryMode ??= trailing.deliveryMode;
		rest = trailing.rest.trim();
		trailing = consumeTrailingDeliveryFlag(rest);
	}
	return { deliveryMode: trailingDeliveryMode ?? deliveryMode, rest };
}

function consumeLeadingDeliveryFlag(
	text: string,
): { deliveryMode: AgentHeartbeatDeliveryMode; rest: string } | undefined {
	const match = /^--(?:deliver(?:=|\s+)(\S+)|(steer)|(follow[-_]up))(?:\s+|$)([\s\S]*)$/i.exec(text);
	if (!match) {
		return undefined;
	}
	return {
		deliveryMode: parseDeliveryModeToken(match[1] ?? match[2] ?? match[3] ?? ""),
		rest: match[4]?.trim() ?? "",
	};
}

function consumeTrailingDeliveryFlag(
	text: string,
): { deliveryMode: AgentHeartbeatDeliveryMode; rest: string } | undefined {
	const deliverWithSpace = /^([\s\S]*?)\s+--deliver\s+(\S+)$/i.exec(text);
	if (deliverWithSpace) {
		return { deliveryMode: parseDeliveryModeToken(deliverWithSpace[2] ?? ""), rest: deliverWithSpace[1] ?? "" };
	}
	const deliverWithEquals = /^([\s\S]*?)\s+--deliver=(\S+)$/i.exec(text);
	if (deliverWithEquals) {
		return { deliveryMode: parseDeliveryModeToken(deliverWithEquals[2] ?? ""), rest: deliverWithEquals[1] ?? "" };
	}
	const shorthand = /^([\s\S]*?)\s+--(steer|follow[-_]up)$/i.exec(text);
	if (shorthand) {
		return { deliveryMode: parseDeliveryModeToken(shorthand[2] ?? ""), rest: shorthand[1] ?? "" };
	}
	return undefined;
}

function parseDeliveryModeToken(token: string): AgentHeartbeatDeliveryMode {
	const normalized = token.toLowerCase().replace("-", "_");
	if (normalized === "steer" || normalized === "follow_up") {
		return normalized;
	}
	throw new Error('Heartbeat delivery mode must be "steer" or "follow_up"');
}

function consumeEveryOption(text: string): { interval: string; rest: string } | undefined {
	const match =
		/^--every(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours))|(\S+))(?:\s+|$)([\s\S]*)$/i.exec(
			text,
		);
	if (!match) {
		return undefined;
	}
	return {
		interval: match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
		rest: match[5]?.trim() ?? "",
	};
}

function consumeLeadingEverySchedule(text: string): { interval: string; rest: string } | undefined {
	const match =
		/^(every|each)\s+\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(text);
	if (!match) {
		return undefined;
	}
	return {
		interval: match[0],
		rest: text
			.slice(match[0].length)
			.trim()
			// Strip only a standalone "--" separator, never a flag like "--follow-up".
			.replace(/^--(?=\s|$)/, "")
			.trim(),
	};
}

export function isHeartbeatCronJob(job: AgentCronJob): boolean {
	return job.source === "heartbeat" || job.source === "rlm_heartbeat";
}

export function shouldDeferHeartbeatCronJob(job: AgentCronJob, activity: HeartbeatCronSessionActivity): boolean {
	if (!isHeartbeatCronJob(job)) {
		return false;
	}
	// States where delivering a heartbeat is unsafe or would stack redundant work,
	// regardless of delivery mode.
	const busyBesidesStreaming =
		activity.isCompacting === true ||
		activity.isRetrying === true ||
		activity.isBashRunning ||
		activity.hasPendingSessionWork ||
		(!activity.isStreaming && activity.unfinishedActionCount > 0);
	if (busyBesidesStreaming) {
		return true;
	}
	// "steer" heartbeats interrupt the current turn, so a plain streaming turn must
	// not defer them; "follow_up" heartbeats wait, so streaming still defers.
	if (resolveHeartbeatStreamingBehavior(job.deliveryMode) === "steer") {
		return false;
	}
	return activity.isStreaming;
}

function nextCronRunAfter(expression: string, after: Date): Date {
	const fields = parseCronExpression(expression);
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	const deadline = candidate.getTime() + 366 * 24 * 60 * ONE_MINUTE_MS;
	while (candidate.getTime() <= deadline) {
		if (matchesCronFields(candidate, fields)) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error(`Cron schedule did not match within one year: ${expression}`);
}

function parseCronExpression(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			"Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday",
		);
	}
	return {
		minute: parseCronField(parts[0]!, 0, 59),
		hour: parseCronField(parts[1]!, 0, 23),
		dayOfMonth: parseCronField(parts[2]!, 1, 31),
		month: parseCronField(parts[3]!, 1, 12),
		dayOfWeek: parseCronField(parts[4]!, 0, 7),
	};
}

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) {
			throw new Error(`Invalid cron field: ${field}`);
		}
		const [rangeText, stepText] = part.split("/");
		const step = stepText === undefined ? 1 : parseCronNumber(stepText, 1, max);
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else if (rangeText?.includes("-")) {
			const [startText, endText] = rangeText.split("-");
			start = parseCronNumber(startText, min, max);
			end = parseCronNumber(endText, min, max);
			if (start > end) {
				throw new Error(`Invalid cron range: ${rangeText}`);
			}
		} else {
			start = parseCronNumber(rangeText, min, max);
			end = start;
		}
		for (let value = start; value <= end; value += step) {
			values.add(value);
		}
	}
	return values;
}

function parseCronNumber(value: string | undefined, min: number, max: number): number {
	if (!value || !/^\d+$/.test(value)) {
		throw new Error(`Invalid cron number: ${value ?? ""}`);
	}
	const parsed = Number.parseInt(value, 10);
	if (parsed < min || parsed > max) {
		throw new Error(`Cron number out of range: ${value}`);
	}
	return parsed;
}

function matchesCronFields(date: Date, fields: CronFields): boolean {
	const day = date.getDay();
	const dayMatches = fields.dayOfWeek.has(day) || (day === 0 && fields.dayOfWeek.has(7));
	return (
		fields.minute.has(date.getMinutes()) &&
		fields.hour.has(date.getHours()) &&
		fields.dayOfMonth.has(date.getDate()) &&
		fields.month.has(date.getMonth() + 1) &&
		dayMatches
	);
}

function normalizeCronAlias(text: string): string {
	switch (text) {
		case "@hourly":
			return "0 * * * *";
		case "@daily":
			return "0 0 * * *";
		case "@weekly":
			return "0 0 * * 0";
		case "@monthly":
			return "0 0 1 * *";
		default:
			return text;
	}
}

function stripMatchingQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function isDueJob(job: AgentCronJob, now: Date): boolean {
	return job.status === "active" && job.nextRunAt !== undefined && Date.parse(job.nextRunAt) <= now.getTime();
}

function withCronJobsStateLocks<T>(paths: readonly string[], action: () => T): T {
	const releases: Array<() => void> = [];
	try {
		for (const path of [...new Set(paths)].sort()) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			let release: (() => void) | undefined;
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					release = lockSync(path, {
						realpath: false,
						lockfilePath: `${path}.lock`,
						stale: 30_000,
					});
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 99) {
						throw error;
					}
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				}
			}
			if (!release) {
				throw new Error(`Could not coordinate scheduled jobs: ${path}`);
			}
			releases.push(release);
		}
		return action();
	} finally {
		for (const release of releases.reverse()) {
			release();
		}
	}
}

function readJobsState(path: string): CronJobsState {
	if (!existsSync(path)) {
		return { jobs: [], dispatches: [] };
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as CronJobsFile;
	return {
		jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter(isAgentCronJob) : [],
		dispatches: Array.isArray(parsed.dispatches) ? parsed.dispatches.filter(isAgentCronDispatchRecord) : [],
	};
}

function writeJobsFile(path: string, jobs: readonly AgentCronJob[], mergeCurrent: boolean): void {
	const current = readJobsState(path);
	writeJobsState(path, {
		jobs: mergeCurrent ? mergeFreshJobs(current.jobs, jobs) : [...jobs],
		dispatches: current.dispatches,
	});
}

function writeJobsState(path: string, state: CronJobsState): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const descriptor = openSync(tempPath, "w", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(tempPath, path);
	try {
		const directoryDescriptor = openSync(directory, "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
	} catch {
		// Directory fsync is unavailable on some platforms; the atomic rename still protects readers.
	}
}

function claimDueInState(state: CronJobsState, dueAt: Date, claimedAt: Date): AgentCronDispatch[] {
	const dispatches: AgentCronDispatch[] = [];
	const claimedJobIds = new Set(state.dispatches.map((dispatch) => dispatch.jobId));
	state.jobs = state.jobs.map((job) => {
		if (!isDueJob(job, dueAt)) {
			return job;
		}
		const scheduledFor = job.nextRunAt!;
		const nextRunAt = nextRunAtForSchedule(job.schedule, claimedAt)?.toISOString();
		const advanced = nextRunAt
			? { ...job, nextRunAt, updatedAt: claimedAt.toISOString() }
			: withoutNextRunAt({ ...job, updatedAt: claimedAt.toISOString() });
		if (claimedJobIds.has(job.id)) {
			return { ...advanced, lastSkippedAt: claimedAt.toISOString() };
		}
		const dispatch: AgentCronDispatchRecord = {
			id: randomUUID(),
			jobId: job.id,
			claimedAt: claimedAt.toISOString(),
			scheduledFor,
		};
		state.dispatches.push(dispatch);
		dispatches.push({ id: dispatch.id, job: advanced });
		return advanced;
	});
	return dispatches;
}

function recoverInterruptedInState(
	state: CronJobsState,
	now: Date,
	recovered: AgentCronJob[],
	dispatchIds?: ReadonlySet<string>,
): void {
	const interrupted = dispatchIds
		? state.dispatches.filter((dispatch) => dispatchIds.has(dispatch.id))
		: state.dispatches;
	if (interrupted.length === 0) {
		return;
	}
	const interruptedIds = new Set(interrupted.map((dispatch) => dispatch.jobId));
	state.dispatches = dispatchIds ? state.dispatches.filter((dispatch) => !dispatchIds.has(dispatch.id)) : [];
	state.jobs = state.jobs.map((job) => {
		if (!interruptedIds.has(job.id) || job.status !== "active") {
			return job;
		}
		const next = {
			...job,
			status: job.schedule.kind === "once" ? ("completed" as const) : job.status,
			lastError: "Interrupted before scheduled operation completion",
			updatedAt: now.toISOString(),
		};
		recovered.push(next);
		return next;
	});
}

function mergeFreshJobs(currentJobs: readonly AgentCronJob[], nextJobs: readonly AgentCronJob[]): AgentCronJob[] {
	const merged = new Map<string, AgentCronJob>();
	for (const job of currentJobs) {
		merged.set(job.id, job);
	}
	for (const job of nextJobs) {
		const current = merged.get(job.id);
		if (!current || isAtLeastAsFresh(job, current)) {
			merged.set(job.id, job);
		}
	}
	return [...merged.values()];
}

function isAtLeastAsFresh(candidate: AgentCronJob, current: AgentCronJob): boolean {
	const candidateTime = Date.parse(candidate.updatedAt);
	const currentTime = Date.parse(current.updatedAt);
	if (!Number.isFinite(currentTime)) {
		return true;
	}
	if (!Number.isFinite(candidateTime)) {
		return false;
	}
	return candidateTime >= currentTime;
}

function compareOptionalIso(left: string | undefined, right: string | undefined): number {
	if (left === right) {
		return 0;
	}
	if (left === undefined) {
		return 1;
	}
	if (right === undefined) {
		return -1;
	}
	return Date.parse(left) - Date.parse(right);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalLabel(label: string | undefined): string | undefined {
	const trimmed = label?.trim();
	return trimmed ? trimmed : undefined;
}

function withoutNextRunAt(job: AgentCronJob): AgentCronJob {
	const { nextRunAt: _nextRunAt, ...rest } = job;
	return rest;
}

function isAgentCronJob(value: unknown): value is AgentCronJob {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<AgentCronJob>;
	return (
		typeof candidate.id === "string" &&
		(candidate.status === "active" ||
			candidate.status === "paused" ||
			candidate.status === "completed" ||
			candidate.status === "cancelled") &&
		(candidate.source === undefined ||
			candidate.source === "cron" ||
			candidate.source === "heartbeat" ||
			candidate.source === "rlm_heartbeat") &&
		(candidate.runtimeKind === undefined ||
			candidate.runtimeKind === "top-level" ||
			candidate.runtimeKind === "subagent") &&
		(candidate.deliveryMode === undefined ||
			candidate.deliveryMode === "steer" ||
			candidate.deliveryMode === "follow_up") &&
		typeof candidate.activeSessionId === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.sessionFile === "string" &&
		typeof candidate.cwd === "string" &&
		(candidate.label === undefined || typeof candidate.label === "string") &&
		typeof candidate.prompt === "string" &&
		typeof candidate.schedule === "object" &&
		candidate.schedule !== null &&
		(candidate.schedule.kind === "once" ||
			candidate.schedule.kind === "cron" ||
			(candidate.schedule.kind === "interval" &&
				typeof candidate.schedule.intervalMs === "number" &&
				candidate.schedule.intervalMs > 0)) &&
		typeof candidate.schedule.expression === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string" &&
		typeof candidate.runCount === "number"
	);
}

function isAgentCronDispatchRecord(value: unknown): value is AgentCronDispatchRecord {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<AgentCronDispatchRecord>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.jobId === "string" &&
		typeof candidate.claimedAt === "string" &&
		typeof candidate.scheduledFor === "string"
	);
}
