import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyCatalogEntry,
	type AgentFamilyRelationship,
	type AgentFamilyRosterResult,
	type AgentSessionMessageController,
	type AgentSessionMessageDeliveryStatus,
	type AgentSessionMessageEndpoint,
	type AgentSessionMessageListResult,
	type AgentSessionMessagePayload,
	type AgentSessionMessageReceipt,
	assertAgentFamilyReach,
	buildAgentFamilyRoster,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	createAgentSessionMessageReceipt,
	normalizeAgentSessionMessage,
} from "../../core/agent-messages.js";
import {
	type AgentObserveAgentSnapshot,
	type AgentObserveAgentSummary,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesResult,
	createAgentObserveMessagePreview,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
} from "../../core/agent-observe.js";
import type { AgentSession } from "../../core/agent-session.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.js";
import {
	CLOUD_MAX_INLINE_ENTRY_BYTES,
	CLOUD_MAX_OUTPUT_CHARS,
	CLOUD_MAX_PREVIEW_CHARS,
	type CloudCommandId,
	type CloudCommandRequest,
	type CloudFamilyInfo,
	type CloudFamilyRow,
	type CloudRosterRow,
	type CloudSessionState,
	type CloudSessionStatus,
} from "../../core/cloud/protocol.js";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../../core/rlm-runtime.js";
import { type SessionEntry, SessionManager } from "../../core/session-manager.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { createAgentConnectionState } from "../agent-connection/snapshot.js";
import type { AgentConnectionState } from "../agent-connection/types.js";
import type { ActiveSessionState } from "../daemon/active-session-state.js";
import type { DaemonOutbound } from "../daemon/daemon-protocol.js";
import { initTheme } from "../interactive/theme/theme.js";
import { SessionHostCore } from "../shared/session-host-core.js";
import { type CloudProtocolDispatchResult, CloudProtocolServer } from "./cloud-protocol-server.js";

/**
 * Resident guest daemon for a first-class cloud session.
 *
 * One process hosts the cloud root session and every recursive descendant it
 * spawns, through the same `createAgentSessionRuntime` + `SessionHostCore`
 * path the local daemon worker uses. The guest never runs one-shot
 * `prime-agent --print` tasks again: it serves the cloud protocol v2 on a
 * VM-local unix socket and mirrors every session-file entry, live session
 * event, roster row, and usage total into the durable outbox, where the local
 * supervisor's mirror picks them up.
 *
 * Frozen surface guarantees: the model-facing stack (tools, kernel, skills,
 * recursion, answer mechanism) is identical to a local session; `rlm.spawn`
 * works inside the sandbox through the runtime's inline subagent host.
 */

export const CLOUD_DAEMON_ENV_KEYS = {
	socketPath: "PRIME_AGENT_CLOUD_DAEMON_SOCKET",
	sessionId: "PRIME_AGENT_CLOUD_SESSION_ID",
	generation: "PRIME_AGENT_CLOUD_GENERATION",
	workspaceDir: "PRIME_AGENT_CLOUD_WORKSPACE_DIR",
	agentDir: "PRIME_AGENT_CLOUD_AGENT_DIR",
	bridgeToken: "PRIME_AGENT_CLOUD_BRIDGE_TOKEN",
	promptPath: "PRIME_AGENT_CLOUD_PROMPT_PATH",
	model: "PRIME_AGENT_CLOUD_MODEL",
	stateDir: "PRIME_AGENT_CLOUD_DAEMON_STATE_DIR",
	statusFile: "PRIME_AGENT_CLOUD_DAEMON_STATUS_FILE",
} as const;

const DEFAULT_STATE_DIR = "/opt/prime-agent/daemon-state";
const MIRROR_TICK_MS = 200;
const META_MIN_INTERVAL_MS = 500;

export interface CloudDaemonModeOptions {
	createRuntime: CreateAgentSessionRuntimeFactory;
	/** Defaults to process.env; tests inject a controlled environment. */
	env?: NodeJS.ProcessEnv;
	/** Overridden by PRIME_AGENT_CLOUD_DAEMON_STATE_DIR when present. */
	defaultStateDir?: string;
	/** Test seam for the durable outbox's record bound; production uses the default. */
	maxOutboxRecords?: number;
}

interface ParsedCloudDaemonEnv {
	socketPath: string;
	sessionId: string;
	generation: number;
	workspaceDir: string;
	agentDir: string;
	bridgeToken: string;
	promptPath: string | undefined;
	model: string | undefined;
	stateDir: string;
	statusFile: string;
}

export class CloudDaemonEnvError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CloudDaemonEnvError";
	}
}

export function parseCloudDaemonEnv(
	env: NodeJS.ProcessEnv = process.env,
	defaults: { stateDir?: string } = {},
): ParsedCloudDaemonEnv {
	const require = (name: string): string => {
		const value = env[name];
		if (value === undefined || value.length === 0) {
			throw new CloudDaemonEnvError(`missing required environment variable ${name}`);
		}
		return value;
	};
	const generation = Number(require(CLOUD_DAEMON_ENV_KEYS.generation));
	if (!Number.isInteger(generation) || generation < 1) {
		throw new CloudDaemonEnvError(`invalid ${CLOUD_DAEMON_ENV_KEYS.generation}`);
	}
	return {
		socketPath: require(CLOUD_DAEMON_ENV_KEYS.socketPath),
		sessionId: require(CLOUD_DAEMON_ENV_KEYS.sessionId),
		generation,
		workspaceDir: require(CLOUD_DAEMON_ENV_KEYS.workspaceDir),
		agentDir: require(CLOUD_DAEMON_ENV_KEYS.agentDir),
		bridgeToken: require(CLOUD_DAEMON_ENV_KEYS.bridgeToken),
		promptPath: env[CLOUD_DAEMON_ENV_KEYS.promptPath] || undefined,
		model: env[CLOUD_DAEMON_ENV_KEYS.model] || undefined,
		stateDir: env[CLOUD_DAEMON_ENV_KEYS.stateDir] || defaults.stateDir || DEFAULT_STATE_DIR,
		statusFile:
			env[CLOUD_DAEMON_ENV_KEYS.statusFile] ||
			join(env[CLOUD_DAEMON_ENV_KEYS.stateDir] || defaults.stateDir || DEFAULT_STATE_DIR, "daemon-status.json"),
	};
}

interface TrackedSession {
	runtime: AgentSessionRuntime;
	lastEntryIndex: number;
	usageRevision: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	requests: number;
}

/** One cross-boundary request awaiting a journaled result command. */
interface PendingRemoteRequest<T> {
	requestId: string;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const REMOTE_REQUEST_TIMEOUT_MS = 30_000;

export class CloudGuestDaemon {
	private readonly host: SessionHostCore;
	private readonly tracked = new Map<string, TrackedSession>();
	private rootState: ActiveSessionState | undefined;
	private status: CloudSessionStatus = "starting";
	private metaEmittedAt = 0;
	private lastMetaSignature = "";
	private lastRosterSignature = "";
	private readonly childStatus = new Map<string, string>();
	private releaseRequested = false;
	private released = false;
	/** True once any prompt or open_session-with-prompt has been admitted. */
	private workAdmitted = false;
	private mirrorTimer: NodeJS.Timeout | undefined;
	private mirrorQueued = false;
	/** Cross-boundary family context for a spawned child, from open_session. */
	private family: CloudFamilyInfo | undefined;
	/** Guest-side remote requests awaiting a journaled result command. */
	private readonly pendingRemoteRequests = new Map<string, PendingRemoteRequest<unknown>>();

	constructor(
		private readonly env: ParsedCloudDaemonEnv,
		private readonly options: CloudDaemonModeOptions,
		private readonly protocol: CloudProtocolServer,
	) {
		this.host = new SessionHostCore({
			broadcast: (state, message) => this.onSessionOutbound(state, message),
			createConnectionState: (state) => this.createConnectionState(state),
			sessionReplaced: () => undefined,
			shutdown: () => {
				void this.release("stopped");
			},
			// Guest descendants are host states like the worker's children:
			// real controllers, live event mirroring, and addressable sessions.
			createSubagentRuntimeHost: (state) => this.createGuestSubagentHost(state),
			setStateSessionName: async (state, name) => {
				state.runtime.session.setSessionName(name);
			},
			onStateReleased: () => undefined,
			onStateReady: () => this.queueMirror(),
			isSessionClosing: () => false,
		});
	}

	static async start(env: ParsedCloudDaemonEnv, options: CloudDaemonModeOptions): Promise<CloudGuestDaemon> {
		// The guest owns its state: agent dir (auth, settings) and daemon state
		// dir both exist before any session or protocol file touches them.
		mkdirSync(env.agentDir, { recursive: true, mode: 0o700 });
		chmodSync(env.agentDir, 0o700);
		mkdirSync(env.stateDir, { recursive: true, mode: 0o700 });
		chmodSync(env.stateDir, 0o700);
		const daemon = new CloudGuestDaemon(
			env,
			options,
			new CloudProtocolServer({
				socketPath: env.socketPath,
				stateDirectory: join(env.stateDir, `${env.sessionId}.g${String(env.generation)}`),
				sessionId: env.sessionId,
				generation: env.generation,
				...(options.maxOutboxRecords === undefined ? {} : { maxOutboxRecords: options.maxOutboxRecords }),
				callbacks: {
					sessionId: () => env.sessionId,
					generation: () => env.generation,
					protocolToken: () => env.bridgeToken,
					status: () => daemon?.status ?? "starting",
					snapshotState: () => daemon?.snapshotState() ?? emptySnapshotState(env.workspaceDir),
					dispatch: (request, commandId) =>
						daemon?.dispatch(request, commandId) ?? Promise.resolve(failed("daemon not ready")),
					// Retention and dispatch health surface in the daemon's
					// status record and log: a full unacknowledged durable log
					// stalls mirroring honestly instead of crash-looping, and
					// the next acknowledged append reports the recovery.
					onRetentionStalled: () => daemon?.markRetentionStalled(),
					onRetentionRecovered: () => daemon?.markRetentionRecovered(),
					onDispatchError: (message) => daemon?.recordDispatchError(message),
				},
			}),
		);
		await daemon.protocol.start();
		return daemon;
	}

	get protocolServer(): CloudProtocolServer {
		return this.protocol;
	}

	get currentStatus(): CloudSessionStatus {
		return this.status;
	}

	/** The cloud root session, when one is open. */
	get rootSession(): AgentSession | undefined {
		return this.rootState?.runtime.session;
	}

	/** The cloud root runtime, when one is open (the host of recursive children). */
	get rootRuntime(): AgentSessionRuntime | undefined {
		return this.rootState?.runtime;
	}

	/** The bound cloud root state (bridge and test seam, like rootSession). */
	get rootStateRef(): ActiveSessionState | undefined {
		return this.rootState;
	}

	/** The guest state for a remote session id: the root or one descendant. */
	stateForRemoteSessionId(sessionId: string | undefined): ActiveSessionState | undefined {
		return this.stateForTarget(sessionId);
	}

	/** Run one mirror pass now instead of waiting for the tick. */
	mirrorNow(): void {
		this.mirrorOnce(true);
	}

	private createConnectionState(state: ActiveSessionState): AgentConnectionState {
		return createAgentConnectionState(state.runtime, state.activeSessionId);
	}

	// --- session lifecycle ------------------------------------------------------

	/** Open (or resume) the cloud root session with the cloud session id. */
	async openSession(input: {
		cwd?: string;
		model?: string;
		thinking?: string;
		prompt?: string;
		family?: CloudFamilyInfo;
	}): Promise<void> {
		if (this.rootState) return;
		this.family = input.family;
		const sessionDir = join(this.env.stateDir, "sessions");
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		const cwd = resolve(input.cwd ?? this.env.workspaceDir);
		if (!existsSync(cwd)) {
			// A resumed sandbox always has its workspace; a fresh test or a
			// lost mount gets an honest empty directory to work in.
			mkdirSync(cwd, { recursive: true });
		}
		const sessionFile = this.locateExistingSessionFile();
		const sessionManager = sessionFile
			? await SessionManager.openAsync(sessionFile, sessionDir, cwd)
			: SessionManager.create(cwd, sessionDir);
		if (!sessionFile) {
			sessionManager.newSession({ id: this.env.sessionId });
		}
		let rootStateRef: ActiveSessionState | undefined;
		const runtime = await createRuntimeWithModel(
			this.options.createRuntime,
			{
				cwd: sessionManager.getCwd(),
				agentDir: this.env.agentDir,
				sessionManager,
				sessionConfig: { agentDir: this.env.agentDir, cwd, sessionDir },
				sessionOptions: {
					agentMessageController: this.createGuestMessageController(() => rootStateRef),
					agentObserveController: this.createGuestObserveController(() => rootStateRef),
				},
			},
			input.model ?? this.env.model,
			input.thinking,
		);
		this.rootState = await this.host.addRuntime(runtime, undefined, undefined, (state) => {
			rootStateRef = state;
		});
		this.track(runtime);
		if (sessionFile) {
			// Crash resume: continue the durable mirror from the persisted
			// cursor instead of re-emitting the whole session.
			const sessionId = runtime.session.sessionId;
			const counts = this.readMirrorCursor();
			const resumed = counts[sessionId];
			const tracked = this.tracked.get(sessionId);
			if (tracked && resumed !== undefined) {
				tracked.lastEntryIndex = Math.min(resumed, runtime.session.sessionManager.getEntries().length);
			}
		}
		this.setStatus("idle");
		this.queueMirror();
	}

	/** The session file this cloud session id already owns, if any (crash resume). */
	private locateExistingSessionFile(): string | undefined {
		const manifest = join(this.env.stateDir, "session-file.json");
		if (!existsSync(manifest)) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { sessionId?: string; sessionFile?: string };
			if (parsed.sessionId !== this.env.sessionId || typeof parsed.sessionFile !== "string") return undefined;
			return existsSync(parsed.sessionFile) ? parsed.sessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	private persistSessionManifest(sessionFile: string | undefined): void {
		if (!sessionFile) return;
		writeFileSync(
			join(this.env.stateDir, "session-file.json"),
			`${JSON.stringify({ sessionId: this.env.sessionId, sessionFile })}\n`,
			{
				mode: 0o600,
			},
		);
	}

	private track(runtime: AgentSessionRuntime): void {
		const sessionId = runtime.session.sessionId;
		if (!this.tracked.has(sessionId)) {
			this.tracked.set(sessionId, {
				runtime,
				lastEntryIndex: 0,
				usageRevision: 0,
				inputTokens: 0,
				outputTokens: 0,
				cachedTokens: 0,
				requests: 0,
			});
		}
	}

	/** Every guest-hosted session (root and descendants) mirrors its entries. */
	private refreshTrackedRuntimes(): void {
		for (const state of this.host.values()) {
			this.track(state.runtime);
		}
	}

	snapshotState(): CloudSessionState {
		const root = this.rootState?.runtime;
		return {
			cwd: this.env.workspaceDir,
			modelId: root?.session.model?.id ?? this.env.model ?? "image-default",
			queuedCommandIds: this.protocolServerQueuedIds(),
		};
	}

	private protocolServerQueuedIds(): readonly string[] {
		const pending = this.protocol.listPendingCommandIds();
		return pending;
	}

	private setStatus(next: CloudSessionStatus): void {
		if (this.status === next) return;
		this.status = next;
		this.protocol.appendEvent({
			kind: "session_status",
			recordedAt: new Date().toISOString(),
			status: next,
		});
		this.persistStatusFile();
	}

	/**
	 * The guest's answer stream for the results contract. The bridge owns
	 * results/stdout.txt; this file is the authoritative copy it takes at
	 * finalize, so the one-shot flow (no relay client) still ships the answer.
	 */
	private appendGuestStdout(chunk: string): void {
		try {
			appendFileSync(join(this.env.stateDir, "guest-stdout.txt"), chunk, { flag: "a", mode: 0o600 });
		} catch {
			// The results copy is best-effort; the durable mirror still holds
			// the answer in session_entry events.
		}
	}

	/** The bridge's supervision channel: one bounded, atomic status file. */
	private lastStatusPayload = "";

	/** True while the durable log is full with nothing acknowledged. */
	private retentionStalled = false;

	// Not private: the protocol server invokes these through its callbacks
	// closure, which private-membership lint cannot trace.
	markRetentionStalled(): void {
		this.retentionStalled = true;
		getLogger("cloud-daemon").error(
			"the durable event log is full and nothing is acknowledged; mirroring stalls until an ack frees space",
		);
		this.persistStatusFile(true);
	}

	markRetentionRecovered(): void {
		if (!this.retentionStalled) return;
		this.retentionStalled = false;
		getLogger("cloud-daemon").warn("durable event log retention recovered after acknowledgement");
		this.persistStatusFile(true);
	}

	recordDispatchError(message: string): void {
		getLogger("cloud-daemon").warn(`guest command dispatch: ${message}`);
	}

	private persistStatusFile(force = false): void {
		try {
			const idleAfterWork = this.workAdmitted && this.status === "idle";
			// The timestamp changes every call; compare the semantic payload so
			// quiescent sessions do not rewrite the file on every tick.
			const semantic = JSON.stringify({
				status: this.status,
				idleAfterWork,
				retentionStalled: this.retentionStalled,
			});
			if (!force && semantic === this.lastStatusPayload) return;
			this.lastStatusPayload = semantic;
			const payload = `${JSON.stringify({
				status: this.status,
				idleAfterWork,
				retentionStalled: this.retentionStalled,
				updatedAt: new Date().toISOString(),
			})}\n`;
			writeFileSync(`${this.env.statusFile}.tmp`, payload, { mode: 0o600 });
			renameSync(`${this.env.statusFile}.tmp`, this.env.statusFile);
		} catch {
			// The status file is a local probe for the bridge; failures are
			// never fatal for the session itself.
		}
	}

	// --- event mirroring ----------------------------------------------------------

	private onSessionOutbound(state: ActiveSessionState, message: DaemonOutbound): void {
		if (message.type === "session_event") {
			this.onSessionEvent(state, message.event);
		}
		this.queueMirror();
	}

	private onSessionEvent(state: ActiveSessionState, event: Record<string, unknown> & { type: string }): void {
		// Ephemeral live frame: bounded canonical JSON, dropped (not truncated)
		// past the wire bound because durable state lives in session_entry.
		try {
			this.protocol.appendEvent({
				kind: "session_event",
				recordedAt: new Date().toISOString(),
				sessionId: state.runtime.session.sessionId,
				event,
			});
		} catch {
			// Oversized live frames are dropped; the durable entry mirror still
			// carries the payload.
		}
		switch (event.type) {
			case "message_end": {
				const message = (
					event as {
						message?: {
							role?: string;
							content?: unknown;
							usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
						};
					}
				).message;
				if (message?.role === "assistant") {
					this.onAssistantMessage(
						state,
						message as {
							content?: unknown;
							usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
						},
					);
				}
				break;
			}
			case "rlm_child_update": {
				const child = (
					event as {
						child?: {
							id?: string;
							status?: string;
							answerPreview?: string;
							sessionFile?: string;
							model?: string;
						};
					}
				).child;
				if (child?.id !== undefined) {
					this.protocol.appendEvent({
						kind: "child_update",
						recordedAt: new Date().toISOString(),
						childId: child.id,
						status: normalizeChildStatus(child.status),
						...(presentString(child.answerPreview, CLOUD_MAX_PREVIEW_CHARS) !== undefined
							? { answerPreview: presentString(child.answerPreview, CLOUD_MAX_PREVIEW_CHARS) as string }
							: {}),
						...(child.sessionFile !== undefined ? { sessionFile: child.sessionFile } : {}),
						...(child.model !== undefined ? { model: child.model } : {}),
					});
					this.childStatus.set(child.id, child.status ?? "");
				}
				break;
			}
			default:
				break;
		}
	}

	private onAssistantMessage(
		state: ActiveSessionState,
		message: { content?: unknown; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } },
	): void {
		// The results contract: stdout carries the assistant's answer text,
		// batched to the v1 output_delta event the bridge streams into
		// results/stdout.txt.
		const text = messageText(message.content);
		if (text.length > 0) {
			for (const chunk of chunkText(text, CLOUD_MAX_OUTPUT_CHARS)) {
				this.protocol.appendEvent({
					kind: "output_delta",
					recordedAt: new Date().toISOString(),
					taskId: `task_${state.runtime.session.sessionId}`,
					stream: "stdout",
					text: chunk,
				});
				this.appendGuestStdout(chunk);
			}
		}
		const usage = message.usage;
		if (usage !== undefined) {
			const tracked = this.tracked.get(state.runtime.session.sessionId);
			if (tracked) {
				tracked.inputTokens += usage.inputTokens ?? 0;
				tracked.outputTokens += usage.outputTokens ?? 0;
				tracked.cachedTokens += usage.cachedTokens ?? 0;
				tracked.requests += 1;
				tracked.usageRevision += 1;
				this.protocol.appendEvent({
					kind: "usage",
					recordedAt: new Date().toISOString(),
					sessionId: state.runtime.session.sessionId,
					totals: {
						inputTokens: tracked.inputTokens,
						outputTokens: tracked.outputTokens,
						cachedTokens: tracked.cachedTokens,
						requests: tracked.requests,
					},
					revision: tracked.usageRevision,
				});
			}
		}
	}

	/** Mirror queued work: entries, meta, roster. Coalesced per tick. */
	queueMirror(): void {
		if (this.mirrorQueued) return;
		this.mirrorQueued = true;
		setImmediate(() => {
			this.mirrorQueued = false;
			this.mirrorOnce();
		});
	}

	startMirrorLoop(): void {
		if (this.mirrorTimer) return;
		this.mirrorTimer = setInterval(() => this.mirrorOnce(), MIRROR_TICK_MS);
		this.mirrorTimer.unref?.();
	}

	async stop(): Promise<void> {
		if (this.mirrorTimer) {
			clearInterval(this.mirrorTimer);
			this.mirrorTimer = undefined;
		}
		await this.protocol.stop();
	}

	private mirrorOnce(force = false): void {
		// A forced pass runs through release: the final entries must land in the
		// durable log before the session is disposed, or /cloud stop loses the
		// transcript tail.
		if (this.released && !force) return;
		this.refreshTrackedRuntimes();
		this.mirrorEntries();
		this.emitMetaIfChanged(true);
		this.emitRosterIfChanged();
		this.updateStatus();
	}

	private mirrorEntries(): void {
		let cursorChanged = false;
		for (const tracked of this.tracked.values()) {
			const entries = tracked.runtime.session.sessionManager.getEntries();
			for (let index = tracked.lastEntryIndex; index < entries.length; index++) {
				const entry = entries[index];
				if (entry === undefined) continue;
				const appended = this.emitSessionEntry(tracked.runtime.session.sessionId, entry);
				if (!appended) {
					// A stalled log never advances the mirror cursor: the entry
					// re-emits once retention frees space.
					break;
				}
				tracked.lastEntryIndex = index + 1;
				cursorChanged = true;
			}
		}
		if (this.rootState && !this.released) {
			const sessionFile = this.rootState.runtime.session.sessionFile;
			if (sessionFile) this.persistSessionManifest(sessionFile);
		}
		if (cursorChanged) {
			// The mirror cursor is durable: a restarted daemon resumes from the
			// last appended entry instead of re-mirroring the whole session and
			// refilling the log. Written after the appends, so a crash between
			// the two re-emits at worst (the mirror dedupes), never skips.
			this.persistMirrorCursor();
		}
	}

	private persistMirrorCursor(): void {
		try {
			const counts: Record<string, number> = {};
			for (const [sessionId, tracked] of this.tracked) {
				counts[sessionId] = tracked.lastEntryIndex;
			}
			const path = join(this.mirrorStateDirectory(), "mirror-cursor.json");
			writeFileSync(`${path}.tmp`, `${JSON.stringify(counts)}\n`, { mode: 0o600 });
			renameSync(`${path}.tmp`, path);
		} catch {
			// The cursor is an optimization for restarts; a failed write only
			// costs duplicate mirrored entries after a crash.
		}
	}

	private readMirrorCursor(): Record<string, number> {
		try {
			const path = join(this.mirrorStateDirectory(), "mirror-cursor.json");
			if (!existsSync(path)) return {};
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const counts: Record<string, number> = {};
			for (const [sessionId, value] of Object.entries(parsed)) {
				if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
					counts[sessionId] = value;
				}
			}
			return counts;
		} catch {
			return {};
		}
	}

	private mirrorStateDirectory(): string {
		return join(this.env.stateDir, `${this.env.sessionId}.g${String(this.env.generation)}`);
	}

	private emitSessionEntry(sessionId: string, entry: SessionEntry): boolean {
		// Session entries must mirror exactly what the session file holds: a
		// JSON round-trip strips undefined-valued fields the same way the
		// on-disk JSONL does, so the durable mirror never diverges.
		const jsonSafeEntry = JSON.parse(JSON.stringify(entry)) as SessionEntry;
		let canonical: string;
		try {
			canonical = JSON.stringify(jsonSafeEntry);
		} catch {
			return false;
		}
		if (Buffer.byteLength(canonical, "utf8") <= CLOUD_MAX_INLINE_ENTRY_BYTES) {
			const appended = this.protocol.appendEvent({
				kind: "session_entry",
				recordedAt: new Date().toISOString(),
				sessionId,
				entryId: entry.id,
				entry: jsonSafeEntry as unknown as Record<string, unknown>,
			});
			return appended !== undefined;
		}
		// Oversized entries never travel inline: the durable artifact carries
		// the full canonical JSON and the event carries identity + ref.
		const artifactDir = join(this.env.stateDir, `${this.env.sessionId}.g${String(this.env.generation)}`, "artifacts");
		mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
		const path = join(artifactDir, `${entry.id}.entry.json`);
		const sha256 = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
		writeFileSync(path, canonical, { mode: 0o600 });
		const appended = this.protocol.appendEvent({
			kind: "session_entry",
			recordedAt: new Date().toISOString(),
			sessionId,
			entryId: entry.id,
			entry: entryIdentity(entry),
			artifacts: [{ path, sha256, bytes: Buffer.byteLength(canonical, "utf8") }],
		});
		return appended !== undefined;
	}

	private emitMetaIfChanged(force: boolean): void {
		const root = this.rootState?.runtime;
		if (!root) return;
		const session = root.session;
		const meta = {
			sessionId: session.sessionId,
			streaming: session.isStreaming === true,
			runningTools: session.state?.pendingToolCalls?.size ?? 0,
			queue: session.getSessionActionSnapshot?.().queuedCount ?? 0,
			recap: bounded(session.getCurrentRecap?.() ?? "", CLOUD_MAX_PREVIEW_CHARS),
			model: session.model?.id,
		};
		const signature = JSON.stringify(meta);
		const now = Date.now();
		// Meta is a change feed: an unchanged signature never re-emits. Force
		// bypasses only the rate window, for immediate post-command updates.
		if (signature === this.lastMetaSignature) {
			return;
		}
		if (!force && now - this.metaEmittedAt < META_MIN_INTERVAL_MS) {
			return;
		}
		this.lastMetaSignature = signature;
		this.metaEmittedAt = now;
		this.protocol.appendEvent({
			kind: "session_meta",
			recordedAt: new Date().toISOString(),
			sessionId: meta.sessionId,
			streaming: meta.streaming,
			runningTools: meta.runningTools,
			queue: meta.queue,
			...(meta.recap.length > 0 ? { recap: meta.recap } : {}),
			...(meta.model !== undefined ? { model: meta.model } : {}),
		});
	}

	private emitRosterIfChanged(): void {
		const root = this.rootState?.runtime;
		if (!root) return;
		const rows: CloudRosterRow[] = [];
		// Guest descendants are host states (the worker model): walk the
		// parent-active edges, not the runtime's own child map.
		const childrenByParent = new Map<string, ActiveSessionState[]>();
		for (const state of this.host.values()) {
			const metadata = state.runtime.metadata;
			if (metadata.kind !== "subagent") continue;
			const parentActiveSessionId = metadata.parentActiveSessionId ?? this.rootState?.activeSessionId;
			if (parentActiveSessionId === undefined) continue;
			const bucket = childrenByParent.get(parentActiveSessionId) ?? [];
			bucket.push(state);
			childrenByParent.set(parentActiveSessionId, bucket);
		}
		const walk = (parent: ActiveSessionState, parentRemoteId: string, depth: number): void => {
			for (const child of childrenByParent.get(parent.activeSessionId) ?? []) {
				const session = child.runtime.session;
				const preview = bounded(
					messageText(
						session.messages
							.filter((message) => typeof (message as { content?: unknown }).content !== "undefined")
							.at(-1) as { content?: unknown } | undefined,
					),
					CLOUD_MAX_PREVIEW_CHARS,
				);
				// Empty optional strings are invalid on the wire: omit them.
				const row: CloudRosterRow = {
					childId: child.runtime.metadata.rlmChildId ?? session.sessionId,
					parentRemoteId,
					...(session.sessionName ? { name: session.sessionName } : {}),
					status: this.childRowStatus(child.runtime),
					depth,
					...(preview.length > 0 ? { preview } : {}),
				};
				rows.push(row);
				walk(child, row.childId, depth + 1);
			}
		};
		walk(this.rootState!, root.session.sessionId, 1);
		const signature = JSON.stringify(rows);
		if (signature === this.lastRosterSignature) return;
		this.lastRosterSignature = signature;
		// An emptied roster is itself a change: without the empty row set the
		// local mirror could never observe that the last descendant ended.
		this.protocol.appendEvent({
			kind: "roster_delta",
			recordedAt: new Date().toISOString(),
			rows,
		});
	}

	private childRowStatus(runtime: AgentSessionRuntime): CloudRosterRow["status"] {
		const session = runtime.session;
		if (session.isStreaming) return "running";
		if (session.isSessionActive) return "running";
		return "completed";
	}

	private updateStatus(): void {
		if (this.releaseRequested) return;
		const root = this.rootState?.runtime;
		if (!root) {
			this.setStatus("starting");
			return;
		}
		const session = root.session;
		const busy =
			session.isStreaming === true ||
			session.isCompacting === true ||
			(session.getSessionActionSnapshot?.().queuedCount ?? 0) > 0 ||
			[...this.host.values()].some(
				(state) =>
					state.runtime.metadata.kind === "subagent" &&
					(state.runtime.session.isSessionActive || state.runtime.session.isStreaming),
			);
		this.setStatus(busy ? "busy" : "idle");
		// The one-shot flow keys off idleAfterWork, which flips without a
		// status change (idle before work, idle again after it settles).
		this.persistStatusFile();
	}

	// --- command translation ---------------------------------------------------

	async dispatch(request: CloudCommandRequest, _commandId: CloudCommandId): Promise<CloudProtocolDispatchResult> {
		if (this.released && request.kind !== "release") {
			return failed("the guest session is released");
		}
		switch (request.kind) {
			case "open_session":
				return this.dispatchOpenSession(request);
			case "prompt":
				return this.dispatchPrompt(request.text, request.queueIfBusy === true, request.targetSessionId);
			case "steer":
				return this.dispatchSteer(request.text);
			case "follow_up":
				return this.dispatchFollowUp(request.text);
			case "abort":
				return this.dispatchAbort();
			case "send_message":
				return this.dispatchSendMessage(request);
			case "set_model":
				return this.dispatchSetModel(request.provider, request.modelId);
			case "set_thinking_level":
				return this.dispatchSetThinking(request.level);
			case "set_session_name":
				return this.dispatchSetName(request.name);
			case "compact":
				return this.dispatchCompact(request.customInstructions);
			case "cancel_child":
				return this.dispatchCancelChild(request.childId);
			case "delete_child":
				return this.dispatchDeleteChild(request.childId);
			case "extension_ui_response":
				return this.dispatchExtensionUiResponse(request.requestId, request.response, request.targetSessionId);
			case "release":
				return this.dispatchRelease();
			case "family_roster_result":
				return this.dispatchFamilyRosterResult(request.requestId, request.entries);
			case "agent_message_result":
				return this.dispatchAgentMessageResult(request.requestId, request.ok, request.receipt, request.error);
			default:
				return failed(`unsupported command: ${(request as { kind: string }).kind}`);
		}
	}

	private async dispatchOpenSession(
		request: Extract<CloudCommandRequest, { kind: "open_session" }>,
	): Promise<CloudProtocolDispatchResult> {
		if (this.rootState) {
			// Idempotent open: an already-resident session honors a duplicate
			// open_session's prompt instead of silently dropping it. The
			// bridge-spawned daemon opened its session before the first
			// open_session arrived, so the family context lands here.
			if (request.family !== undefined) {
				this.family = request.family;
			}
			if (request.prompt !== undefined && request.prompt.length > 0) {
				return this.dispatchPrompt(request.prompt, false);
			}
			return completed();
		}
		try {
			await this.openSession({
				cwd: request.cwd,
				model: request.model,
				thinking: request.thinking,
				family: request.family,
			});
		} catch (error) {
			return failure(error);
		}
		if (request.prompt !== undefined && request.prompt.length > 0) {
			return this.dispatchPrompt(request.prompt, false);
		}
		return completed();
	}

	private async dispatchPrompt(
		text: string,
		queueIfBusy: boolean,
		targetSessionId?: string,
	): Promise<CloudProtocolDispatchResult> {
		const session = this.sessionForTarget(targetSessionId);
		if (!session) return failed(`unknown remote session ${targetSessionId ?? this.env.sessionId}`);
		try {
			// Admission-level completion: the durable log carries the run.
			this.workAdmitted = true;
			this.persistStatusFile(true);
			await session.promptUntilAccepted(text, { queueIfBusy });
		} catch (error) {
			return failure(error);
		}
		this.persistStatusFile(true);
		return completed();
	}

	/** The guest session for a remote session id: the root or one descendant. */
	private sessionForTarget(targetSessionId: string | undefined): AgentSession | undefined {
		if (targetSessionId === undefined || targetSessionId === this.rootState?.runtime.session.sessionId) {
			return this.rootSession;
		}
		return [...this.host.values()].find((state) => state.runtime.session.sessionId === targetSessionId)?.runtime
			.session;
	}

	/** The guest state for a remote session id (binding-aware variant). */
	private stateForTarget(targetSessionId: string | undefined): ActiveSessionState | undefined {
		if (targetSessionId === undefined || targetSessionId === this.rootState?.runtime.session.sessionId) {
			return this.rootState;
		}
		return [...this.host.values()].find((state) => state.runtime.session.sessionId === targetSessionId);
	}

	private async dispatchSteer(text: string): Promise<CloudProtocolDispatchResult> {
		const session = this.rootSession;
		if (!session) return failed("no open session");
		try {
			await session.steer(text, undefined, { resumeIfIdle: true });
		} catch (error) {
			return failure(error);
		}
		return completed();
	}

	private async dispatchFollowUp(text: string): Promise<CloudProtocolDispatchResult> {
		const session = this.rootSession;
		if (!session) return failed("no open session");
		try {
			await session.followUp(text, undefined, { resumeIfIdle: true });
		} catch (error) {
			return failure(error);
		}
		return completed();
	}

	private async dispatchAbort(): Promise<CloudProtocolDispatchResult> {
		const session = this.rootSession;
		if (!session) return failed("no open session");
		try {
			await session.abort();
		} catch (error) {
			return failure(error);
		}
		return completed();
	}

	private async dispatchSendMessage(
		request: Extract<CloudCommandRequest, { kind: "send_message" }>,
	): Promise<CloudProtocolDispatchResult> {
		const targetState = this.stateForTarget(request.targetRemoteSessionId);
		if (targetState === undefined) return failed(`unknown remote session ${request.targetRemoteSessionId}`);
		const payload: AgentSessionMessagePayload = {
			id: request.messageId ?? createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message: request.message,
			...(request.from
				? {
						from: {
							...(request.from.activeSessionId ? { activeSessionId: request.from.activeSessionId } : {}),
							...(request.from.sessionId ? { sessionId: request.from.sessionId } : {}),
							...(request.from.sessionName ? { sessionName: request.from.sessionName } : {}),
							...(request.from.runtimeKind ? { runtimeKind: request.from.runtimeKind } : {}),
						},
					}
				: {}),
			...(request.fromRelationship ? { fromRelationship: request.fromRelationship } : {}),
			target: this.messageEndpoint(targetState),
		};
		const status = await this.deliverAgentMessage(targetState, payload);
		// The receipt lands only after admission: the dispatch resolves once
		// acceptAgentMessagePrompt committed (delivered) or queued the steer.
		return {
			state: "completed",
			result: JSON.stringify({ deliveryStatus: status, messageId: payload.id }),
		};
	}

	/**
	 * Deliver one agent message into a guest session with the same semantics
	 * as the local daemon worker: steering behavior, queue-if-busy, and the
	 * preflight delivery status.
	 */
	private async deliverAgentMessage(
		targetState: ActiveSessionState,
		payload: AgentSessionMessagePayload,
	): Promise<AgentSessionMessageDeliveryStatus> {
		const message = createAgentSessionMessage(payload);
		let preflightFailed = false;
		let preflightQueued = false;
		await targetState.runtime.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
			preflightResult: (didSucceed, didQueue) => {
				preflightFailed = !didSucceed;
				preflightQueued = didSucceed && didQueue === true;
			},
		});
		if (preflightFailed) {
			throw new Error("Agent message was not accepted");
		}
		return preflightQueued ? "queued" : "delivered";
	}

	private messageEndpoint(state: ActiveSessionState): AgentSessionMessageEndpoint {
		return {
			activeSessionId: state.activeSessionId,
			sessionId: state.runtime.session.sessionId,
			...(state.runtime.session.sessionName ? { sessionName: state.runtime.session.sessionName } : {}),
			runtimeKind: state.runtime.metadata.kind,
		};
	}

	// --- cross-boundary family surface ------------------------------------

	/** Resolve the journaled result command for one pending remote request. */
	private dispatchFamilyRosterResult(requestId: string, entries: CloudFamilyRow[]): CloudProtocolDispatchResult {
		const pending = this.takePendingRemoteRequest<CloudFamilyRow[]>(requestId);
		if (pending === undefined) return failed(`unknown family roster request ${requestId}`);
		pending.resolve(entries);
		return completed();
	}

	private dispatchAgentMessageResult(
		requestId: string,
		ok: boolean,
		receipt: Record<string, unknown> | undefined,
		error: string | undefined,
	): CloudProtocolDispatchResult {
		const pending = this.takePendingRemoteRequest<AgentSessionMessageReceipt>(requestId);
		if (pending === undefined) return failed(`unknown agent message request ${requestId}`);
		if (ok && receipt !== undefined) {
			pending.resolve(receipt as unknown as AgentSessionMessageReceipt);
		} else {
			pending.reject(new Error(error ?? "the supervisor could not deliver the agent message"));
		}
		return completed();
	}

	private takePendingRemoteRequest<T>(requestId: string): PendingRemoteRequest<T> | undefined {
		const pending = this.pendingRemoteRequests.get(requestId) as PendingRemoteRequest<T> | undefined;
		if (pending === undefined) return undefined;
		this.pendingRemoteRequests.delete(requestId);
		clearTimeout(pending.timer);
		return pending;
	}

	private registerPendingRemoteRequest<T>(requestId: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRemoteRequest<T> = {
				requestId,
				resolve: (value) => resolve(value),
				reject: (error) => reject(error),
				timer: setTimeout(() => {
					if (this.pendingRemoteRequests.get(requestId) !== undefined) {
						this.pendingRemoteRequests.delete(requestId);
						reject(new Error(`cross-boundary request ${requestId} timed out`));
					}
				}, REMOTE_REQUEST_TIMEOUT_MS),
			};
			this.pendingRemoteRequests.set(requestId, pending as PendingRemoteRequest<unknown>);
		});
	}

	/**
	 * Ask the local supervisor for this session's cross-boundary family rows
	 * (self, parent, siblings). Durable: the request rides the guest outbox
	 * as an event; the journaled result command resolves the promise.
	 */
	private async fetchRemoteFamilyRows(fromRemoteSessionId: string): Promise<CloudFamilyRow[]> {
		const requestId = `famreq_${randomUUID()}`;
		const pending = this.registerPendingRemoteRequest<CloudFamilyRow[]>(requestId);
		const appended = this.protocol.appendEvent({
			kind: "family_roster_request",
			recordedAt: new Date().toISOString(),
			requestId,
			fromRemoteSessionId,
		});
		if (appended === undefined) {
			this.takePendingRemoteRequest<CloudFamilyRow[]>(requestId);
			throw new Error("the guest event log is stalled; the family roster is unavailable");
		}
		return pending;
	}

	/**
	 * Send one agent message to a non-guest family target through the local
	 * supervisor. The supervisor asserts reach, delivers, and returns the
	 * receipt only after the target admitted the message.
	 */
	private async sendRemoteAgentMessage(input: {
		fromRemoteSessionId: string;
		targetSelector: string;
		message: string;
	}): Promise<AgentSessionMessageReceipt> {
		const requestId = `msgreq_${randomUUID()}`;
		const pending = this.registerPendingRemoteRequest<AgentSessionMessageReceipt>(requestId);
		const appended = this.protocol.appendEvent({
			kind: "agent_message_request",
			recordedAt: new Date().toISOString(),
			requestId,
			fromRemoteSessionId: input.fromRemoteSessionId,
			targetSelector: input.targetSelector,
			message: input.message,
		});
		if (appended === undefined) {
			this.takePendingRemoteRequest<AgentSessionMessageReceipt>(requestId);
			throw new Error("the guest event log is stalled; agent messaging is unavailable");
		}
		return pending;
	}

	private async dispatchSetModel(provider: string, modelId: string): Promise<CloudProtocolDispatchResult> {
		const state = this.rootState;
		if (!state) return failed("no open session");
		const registry = state.runtime.services.modelRegistry;
		const model = registry.find(provider, modelId);
		if (!model) return failed(`unknown model ${provider}/${modelId}`);
		try {
			await state.runtime.session.setModel(model);
		} catch (error) {
			return failure(error);
		}
		return completed();
	}

	private async dispatchSetThinking(level: string): Promise<CloudProtocolDispatchResult> {
		const session = this.rootSession;
		if (!session) return failed("no open session");
		const available = session.getAvailableThinkingLevels();
		if (available.length > 0 && !available.includes(level as never)) {
			return failed(`thinking level ${level} is not available (have: ${available.join(", ")})`);
		}
		try {
			session.setThinkingLevel(level as never);
		} catch (error) {
			return failure(error);
		}
		return completed();
	}

	private dispatchSetName(name: string): CloudProtocolDispatchResult {
		const session = this.rootSession;
		if (!session) return failed("no open session");
		try {
			session.setSessionName(name);
		} catch (error) {
			return failure(error);
		}
		return completed();
	}

	private async dispatchCompact(customInstructions?: string): Promise<CloudProtocolDispatchResult> {
		const session = this.rootSession;
		if (!session) return failed("no open session");
		try {
			await session.compact(customInstructions);
		} catch (error) {
			return failure(error);
		}
		return completed();
	}

	private dispatchCancelChild(childId: string): CloudProtocolDispatchResult {
		const session = this.rootSession;
		if (!session) return failed("no open session");
		const cancelled = session.cancelRlmChildRun(childId, "Cancelled by cloud client");
		return cancelled ? completed() : failed(`unknown child ${childId}`);
	}

	private async dispatchDeleteChild(childId: string): Promise<CloudProtocolDispatchResult> {
		const state = this.rootState;
		if (!state) return failed("no open session");
		// Parity with the local delete path: cancel the run, then dispose the
		// child state through the guest host (the same runtime-host contract
		// the daemon worker uses), so event binding and ledger stay consistent.
		state.runtime.session.cancelRlmChildRun(childId, "Deleted by cloud client");
		try {
			await this.deleteGuestSubagentRuntime(childId, state.runtime.session);
		} catch (error) {
			return failure(error);
		}
		// The mirror tracks sessions by SESSION id, not the RLM child id: drop
		// the deleted child's tracked entry so its entries never mirror again.
		for (const [trackedSessionId, tracked] of this.tracked) {
			if (tracked.runtime.metadata.rlmChildId === childId) {
				this.tracked.delete(trackedSessionId);
				break;
			}
		}
		return completed();
	}

	private dispatchExtensionUiResponse(
		requestId: string,
		response: unknown,
		targetSessionId?: string,
	): CloudProtocolDispatchResult {
		const state = this.stateForTarget(targetSessionId);
		if (!state) return failed(`unknown remote session ${targetSessionId ?? this.env.sessionId}`);
		const pending = state.extensionUiRequests.get(requestId);
		if (!pending) return failed(`unknown extension ui request ${requestId}`);
		state.extensionUiRequests.delete(requestId);
		pending.resolve(response as never);
		return completed();
	}

	private async dispatchRelease(): Promise<CloudProtocolDispatchResult> {
		if (this.released) return completed();
		this.released = true;
		this.releaseRequested = true;
		this.setStatus("stopping");
		// Fire-and-forget settle: the receipt completes the release command
		// immediately; the durable status event records the final state.
		void this.drainAndDispose().catch(() => undefined);
		return completed();
	}

	private async drainAndDispose(): Promise<void> {
		const state = this.rootState;
		if (state) {
			const session = state.runtime.session;
			if (session.isStreaming || session.isSessionActive) {
				await session.abort().catch(() => undefined);
			}
			await session.waitForIdle().catch(() => undefined);
			// The tail mirror is forced: release must never lose the last
			// entries to the tick guard.
			this.mirrorOnce(true);
			await state.runtime.dispose().catch(() => undefined);
		}
		this.setStatus("stopped");
		await this.stop();
	}

	async release(outcome: "stopped" | "failed"): Promise<void> {
		this.released = true;
		this.releaseRequested = true;
		if (this.status !== "stopping") this.setStatus("stopping");
		for (const pending of this.pendingRemoteRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("the guest session is releasing"));
		}
		this.pendingRemoteRequests.clear();
		const state = this.rootState;
		if (state) {
			await state.runtime.session.abort().catch(() => undefined);
			await state.runtime.session.waitForIdle().catch(() => undefined);
			// Forced: the final entries land in the durable log before disposal.
			this.mirrorOnce(true);
			await state.runtime.dispose().catch(() => undefined);
		}
		this.setStatus(outcome);
		await this.stop();
	}

	// --- guest descendant hosting (worker parity) ---------------------------

	/**
	 * Guest descendant host: recursive children are bound host states with
	 * their own controllers, exactly like the daemon worker's children, so
	 * `agent_message` / `agent_observe` work inside the sandbox and every
	 * descendant's live events mirror. `spawnRlmCloudChild` stays unsupported
	 * in the guest (cloud-in-cloud spawns are out of scope); the runtime
	 * fails that request with its precise unsupported-host error.
	 */
	private createGuestSubagentHost(parentState: ActiveSessionState): SubagentRuntimeHost {
		return {
			createRlmSubagentRuntime: async (options) => this.createGuestSubagentRuntime(parentState, options),
			deleteRlmSubagentRuntime: async (childId, session) => this.deleteGuestSubagentRuntime(childId, session),
		};
	}

	private async createGuestSubagentRuntime(
		parentState: ActiveSessionState,
		options: CreateRlmSubagentRuntimeOptions,
	): Promise<AgentSessionRuntime> {
		const sessionManager = SessionManager.create(options.parentSession.sessionManager.getCwd(), options.sessionDir);
		if (options.parentSession.sessionFile) {
			sessionManager.newSession({
				parentSession: options.parentSession.sessionFile,
				rlmDepth: options.rlmDepth,
			});
		}
		sessionManager.appendModelChange(options.model.provider, options.model.id);
		sessionManager.appendThinkingLevelChange(options.thinkingLevel);
		sessionManager.appendServiceTierChange(options.serviceTier);
		let stateRef: ActiveSessionState | undefined;
		const runtime = await createAgentSessionRuntime(this.options.createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: parentState.runtime.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
			sessionOptions: {
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				serviceTier: options.serviceTier,
				scopedModels: options.scopedModels,
				initialActiveToolNames: options.activeToolNames,
				allowedToolNames: options.allowedToolNames,
				customTools: options.customTools,
				includeGoals: options.includeGoals,
				includeCompactSkill: options.includeCompactSkill,
				agentMessageController: this.createGuestMessageController(() => stateRef),
				agentObserveController: this.createGuestObserveController(() => stateRef),
				rlmDepth: options.rlmDepth,
				rlmMaxDepth: options.rlmMaxDepth,
				rlmSessionDir: options.sessionDir,
				rlmParentNodeId: options.rlmParentNodeId,
				rlmParentAgent: options.parentSession.sessionName ?? options.parentSession.sessionId,
				semanticParentSessionId: options.parentSession.sessionId,
				semanticSpawnedByRequestId: options.spawnedByRequestId,
			},
			runtimeMetadata: {
				kind: "subagent",
				createdAt: Date.now(),
				parentActiveSessionId: parentState.activeSessionId,
				parentSessionId: options.parentSession.sessionId,
				parentSessionFile: options.parentSession.sessionFile,
				rlmChildId: options.id,
				rlmParentNodeId: options.rlmParentNodeId,
				prompt: options.prompt,
				spawnCode: options.spawnCode,
				sessionDir: options.sessionDir,
			},
		});
		const state = await this.host.addRuntime(runtime, undefined, undefined, (createdState) => {
			stateRef = createdState;
		});
		try {
			await runtime.session.bindExtensions({});
			if (runtime.session.sessionName !== options.sessionName) {
				runtime.session.setSessionName(options.sessionName);
			}
		} catch (error) {
			await this.disposeGuestState(state);
			throw error;
		}
		options.onSessionPublished?.(runtime.session);
		this.track(runtime);
		this.queueMirror();
		return runtime;
	}

	private async deleteGuestSubagentRuntime(childId: string, session?: AgentSession): Promise<void> {
		const state = [...this.host.values()].find(
			(candidate) =>
				candidate.runtime.metadata.kind === "subagent" && candidate.runtime.metadata.rlmChildId === childId,
		);
		if (state !== undefined) {
			await this.disposeGuestState(state);
			return;
		}
		if (session !== undefined) {
			await session.disposeAsync();
		}
	}

	private async disposeGuestState(state: ActiveSessionState): Promise<void> {
		state.unsubscribe?.();
		this.host.remove(state.activeSessionId);
		this.tracked.delete(state.runtime.session.sessionId);
		try {
			await state.runtime.dispose();
		} finally {
			this.queueMirror();
		}
	}

	// --- agent messaging and observation ------------------------------------

	/** Per-session message controller: guest-local delivery plus the remote family surface. */
	private createGuestMessageController(
		getCurrentState: () => ActiveSessionState | undefined,
	): AgentSessionMessageController {
		const requireCurrentState = (): ActiveSessionState => {
			const current = getCurrentState();
			if (!current) {
				throw new Error("Agent message state is not ready for this session yet");
			}
			return current;
		};
		return {
			listAgents: async () => this.guestListAgents(requireCurrentState()),
			roster: async () => this.guestFamilyRoster(requireCurrentState()),
			sendAgentMessage: async (input) => this.guestSendAgentMessage(requireCurrentState(), input),
		};
	}

	private createGuestObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController {
		const requireCurrentState = (): ActiveSessionState => {
			const current = getCurrentState();
			if (!current) {
				throw new Error("Agent observe state is not ready for this session yet");
			}
			return current;
		};
		return {
			listAgents: async () => this.guestObserveList(requireCurrentState()),
			getAgent: async (target) => this.guestObserveGet(requireCurrentState(), target),
			recentMessages: async (input) => this.guestObserveRecent(requireCurrentState(), input),
		};
	}

	/** Absolute depth of one guest session (spawn-depth shifted). */
	private absoluteDepth(state: ActiveSessionState): number {
		const familyDepth = this.family?.depth ?? 0;
		return familyDepth + (state.runtime.session.rlmDepth ?? 0);
	}

	/** One guest-local family catalog entry (absolute depths, id-linked parents). */
	private guestCatalogEntry(state: ActiveSessionState): AgentFamilyCatalogEntry {
		const metadata = state.runtime.metadata;
		const session = state.runtime.session;
		const depth = this.absoluteDepth(state);
		return {
			id: session.sessionId,
			...(session.sessionName ? { name: session.sessionName } : {}),
			depth,
			status: session.isSessionActive || session.isStreaming ? "running" : "idle",
			...(depth > 0 && metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
			...(depth > 0 && metadata.parentSessionFile ? { parentSessionPath: metadata.parentSessionFile } : {}),
			...(session.sessionFile ? { sessionPath: session.sessionFile } : {}),
		};
	}

	private guestFamilyEntry(state: ActiveSessionState): AgentFamilyCatalogEntry {
		return this.guestCatalogEntry(state);
	}

	private remoteFamilyRowToEntry(row: CloudFamilyRow): AgentFamilyCatalogEntry {
		return {
			id: row.id,
			...(row.name ? { name: row.name } : {}),
			depth: row.depth,
			status: row.status,
			...(row.depth > 0 && row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
			...(row.depth > 0 && row.parentSessionPath ? { parentSessionPath: row.parentSessionPath } : {}),
			...(row.sessionPath ? { sessionPath: row.sessionPath } : {}),
		};
	}

	/**
	 * The full family catalog for one guest session: guest-local rows plus
	 * the supervisor's cross-boundary rows (self, local parent, siblings).
	 * Remote rows override same-id guest rows (they carry the absolute
	 * depth and the local parent edges).
	 */
	private async guestFamilyCatalog(currentState: ActiveSessionState): Promise<AgentFamilyCatalogEntry[]> {
		const byId = new Map<string, AgentFamilyCatalogEntry>();
		for (const state of this.host.values()) {
			const entry = this.guestCatalogEntry(state);
			byId.set(entry.id, entry);
		}
		const remoteRows = await this.fetchRemoteFamilyRows(currentState.runtime.session.sessionId).catch(
			(error: unknown) => {
				getLogger("cloud-daemon").warn(
					`remote family roster unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return [] as CloudFamilyRow[];
			},
		);
		for (const row of remoteRows) {
			byId.set(row.id, this.remoteFamilyRowToEntry(row));
		}
		// The durable spawn context links the root to its local parent even
		// while the tunnel is down, so guest-local family keeps working.
		const family = this.family;
		if (family !== undefined && this.rootState !== undefined) {
			const rootId = this.rootState.runtime.session.sessionId;
			if (!remoteRows.some((row) => row.id === rootId)) {
				const existing = byId.get(rootId);
				byId.set(rootId, {
					id: rootId,
					...(existing?.name !== undefined ? { name: existing.name } : {}),
					depth: family.depth,
					status: existing?.status ?? "running",
					parentSessionId: family.parentSessionId,
					parentSessionPath: family.parentSessionFile,
					...(existing?.sessionPath !== undefined ? { sessionPath: existing.sessionPath } : {}),
				});
			}
		}
		return [...byId.values()];
	}

	private async guestFamilyRoster(currentState: ActiveSessionState): Promise<AgentFamilyRosterResult> {
		const catalog = await this.guestFamilyCatalog(currentState);
		const currentEntry =
			catalog.find((entry) => entry.id === currentState.runtime.session.sessionId) ??
			this.guestFamilyEntry(currentState);
		return buildAgentFamilyRoster(currentEntry, catalog);
	}

	private async guestListAgents(currentState: ActiveSessionState): Promise<AgentSessionMessageListResult> {
		const catalog = await this.guestFamilyCatalog(currentState);
		const agents: AgentSessionMessageListResult["agents"] = [];
		for (const entry of catalog) {
			const state = [...this.host.values()].find((candidate) => candidate.runtime.session.sessionId === entry.id);
			if (state !== undefined) {
				agents.push({
					...this.messageEndpoint(state),
					cwd: state.runtime.cwd,
					isStreaming: state.runtime.session.isStreaming,
					unfinishedActionCount: state.runtime.session.unfinishedActionCount,
					rlmDepth: entry.depth,
					status: entry.status,
				});
				continue;
			}
			agents.push({
				// A remote family row is addressed by its durable session id.
				activeSessionId: entry.id,
				sessionId: entry.id,
				...(entry.name ? { sessionName: entry.name } : {}),
				cwd: this.env.workspaceDir,
				isStreaming: entry.status === "running",
				unfinishedActionCount: 0,
				rlmDepth: entry.depth,
				status: entry.status,
			});
		}
		return {
			current: this.messageEndpoint(currentState),
			agents,
		};
	}

	private async guestSendAgentMessage(
		currentState: ActiveSessionState,
		input: { target: string; message: string; receiverRole?: AgentFamilyRelationship },
	): Promise<AgentSessionMessageReceipt> {
		const message = normalizeAgentSessionMessage(input.message);
		const targetState = this.findGuestTarget(input.target);
		if (targetState === undefined) {
			// Not a guest session: the supervisor resolves the target, asserts
			// family reach, and returns the receipt after admission.
			return this.sendRemoteAgentMessage({
				fromRemoteSessionId: currentState.runtime.session.sessionId,
				targetSelector: input.target,
				message,
			});
		}
		if (targetState.activeSessionId === currentState.activeSessionId) {
			throw new Error("Agent messaging cannot target the sending session");
		}
		assertAgentFamilyReach(this.guestFamilyEntry(currentState), this.guestFamilyEntry(targetState));
		const payload: AgentSessionMessagePayload = {
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message,
			from: this.messageEndpoint(currentState),
			fromRelationship: agentRelationshipBetween(targetState, currentState),
			target: this.messageEndpoint(targetState),
		};
		const status = await this.deliverAgentMessage(targetState, payload);
		return createAgentSessionMessageReceipt(payload, status);
	}

	/** Resolve a selector against guest sessions: session id, then session name. */
	private findGuestTarget(selector: string): ActiveSessionState | undefined {
		return (
			[...this.host.values()].find((state) => state.runtime.session.sessionId === selector) ??
			[...this.host.values()].find(
				(state) =>
					state.runtime.session.sessionName !== undefined && state.runtime.session.sessionName === selector,
			)
		);
	}

	// --- guest observation ---------------------------------------------------

	private observeSummaryFor(state: ActiveSessionState, currentState: ActiveSessionState): AgentObserveAgentSummary {
		const session = state.runtime.session;
		const messages = session.messages;
		const latest = messages.at(-1);
		const status = session.isStreaming
			? session.state.pendingToolCalls.size > 0
				? "tool"
				: "model"
			: session.isCompacting
				? "compacting"
				: session.isSessionActive || session.hasRunningRlmChildren()
					? "busy"
					: state.clients.size > 0
						? "user"
						: "idle";
		return {
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			...(session.sessionName ? { sessionName: session.sessionName } : {}),
			runtimeKind: state.runtime.metadata.kind,
			cwd: state.runtime.cwd,
			status,
			isCurrent: state.activeSessionId === currentState.activeSessionId,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			attachedClients: state.clients.size,
			messageCount: messages.length,
			queuedCount: session.getSessionActionSnapshot?.().queuedCount ?? 0,
			isSessionActive: session.isSessionActive,
			...(state.runtime.metadata.parentActiveSessionId
				? { parentActiveSessionId: state.runtime.metadata.parentActiveSessionId }
				: {}),
			...(state.runtime.metadata.parentSessionId ? { parentSessionId: state.runtime.metadata.parentSessionId } : {}),
			...(state.runtime.metadata.rlmChildId ? { rlmChildId: state.runtime.metadata.rlmChildId } : {}),
			...(latest
				? {
						latestMessage: createAgentObserveMessagePreview(latest, messages.length - 1, 240),
					}
				: {}),
		};
	}

	private async guestObserveList(currentState: ActiveSessionState): Promise<AgentObserveListResult> {
		const agents: AgentObserveAgentSummary[] = [];
		const seen = new Set<string>();
		for (const state of this.host.values()) {
			if (state.activeSessionId === currentState.activeSessionId) continue;
			try {
				assertAgentFamilyReach(this.guestFamilyEntry(currentState), this.guestFamilyEntry(state));
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "Agent reach is limited to parent, siblings, and children"
				) {
					continue;
				}
				throw error;
			}
			agents.push(this.observeSummaryFor(state, currentState));
			seen.add(state.activeSessionId);
		}
		return {
			current: this.observeSummaryFor(currentState, currentState),
			agents,
		};
	}

	private async guestObserveGet(currentState: ActiveSessionState, target: string): Promise<AgentObserveAgentSnapshot> {
		const state = this.requireGuestFamilyTarget(currentState, target);
		return { agent: this.observeSummaryFor(state, currentState) };
	}

	private async guestObserveRecent(
		currentState: ActiveSessionState,
		input: { target: string; limit?: number; maxChars?: number },
	): Promise<AgentObserveRecentMessagesResult> {
		const state = this.requireGuestFamilyTarget(currentState, input.target);
		const limit = normalizeObserveLimit(input.limit);
		const maxChars = normalizeObserveMaxChars(input.maxChars);
		const messages = state.runtime.session.messages;
		const startIndex = Math.max(0, messages.length - limit);
		return {
			agent: this.observeSummaryFor(state, currentState),
			messages: messages
				.slice(startIndex)
				.map((message, offset) => createAgentObserveMessagePreview(message, startIndex + offset, maxChars)),
			limit,
			maxChars,
			truncated: startIndex > 0,
		};
	}

	private requireGuestFamilyTarget(currentState: ActiveSessionState, target: string): ActiveSessionState {
		const state = this.findGuestTarget(target);
		if (state === undefined) {
			throw new Error(`Unknown active session: ${target}`);
		}
		assertAgentFamilyReach(this.guestFamilyEntry(currentState), this.guestFamilyEntry(state));
		return state;
	}
}

/** The receiver-side relationship between two guest sessions. */
function agentRelationshipBetween(
	target: ActiveSessionState,
	current: ActiveSessionState,
): AgentFamilyRelationship | undefined {
	const targetMetadata = target.runtime.metadata;
	const currentMetadata = current.runtime.metadata;
	if (targetMetadata.parentSessionId === currentMetadata.parentSessionId) return "sibling";
	if (targetMetadata.parentSessionId === current.runtime.session.sessionId) return "child";
	if (currentMetadata.parentSessionId === target.runtime.session.sessionId) return "parent";
	return undefined;
}

// --- helpers -------------------------------------------------------------------

function completed(): CloudProtocolDispatchResult {
	return { state: "completed" };
}

function failed(error: string): CloudProtocolDispatchResult {
	return { state: "failed", error };
}

function failure(error: unknown): CloudProtocolDispatchResult {
	return { state: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
}

function emptySnapshotState(cwd: string): CloudSessionState {
	return { cwd, modelId: "image-default", queuedCommandIds: [] };
}

function entryIdentity(entry: SessionEntry): Record<string, unknown> {
	return {
		type: entry.type,
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
	};
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}

function chunkText(text: string, chunkSize: number): string[] {
	if (text.length <= chunkSize) return [text];
	const chunks: string[] = [];
	for (let offset = 0; offset < text.length; offset += chunkSize) {
		chunks.push(text.slice(offset, offset + chunkSize));
	}
	return chunks;
}

/** A bounded optional string value, or undefined when absent/empty (wire-valid omission). */
function presentString(value: string | undefined, max: number): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	return bounded(value, max);
}

function bounded(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

function normalizeChildStatus(status: string | undefined): CloudRosterRow["status"] {
	switch (status) {
		case "queued":
		case "running":
		case "completed":
		case "failed":
		case "cancelled":
			return status;
		default:
			return "running";
	}
}

async function createRuntimeWithModel(
	factory: CreateAgentSessionRuntimeFactory,
	options: Parameters<CreateAgentSessionRuntimeFactory>[0],
	model: string | undefined,
	thinking: string | undefined,
): Promise<AgentSessionRuntime> {
	const result = await createAgentSessionRuntime(factory, options);
	if (model !== undefined && model.length > 0) {
		const [provider, ...rest] = model.split("/");
		const modelId = rest.join("/");
		if (provider && modelId) {
			const resolved = result.services.modelRegistry.find(provider, modelId);
			if (!resolved) {
				// A requested model that cannot resolve is an honest failure,
				// never a silent fallback to an unconfigured session.
				await result.session.disposeAsync().catch(() => undefined);
				throw new Error(`unknown model ${provider}/${modelId}`);
			}
			await result.session.setModel(resolved).catch((error: unknown) => {
				throw error instanceof Error ? error : new Error(String(error));
			});
		}
	}
	if (thinking !== undefined && thinking.length > 0) {
		result.session.setThinkingLevel(thinking as never);
	}
	return result;
}

/**
 * The guest daemon entrypoint. Wired in main.ts behind the internal
 * PRIME_AGENT_INTERNAL_CLOUD_DAEMON env the bridge sets; never user-facing.
 */
export async function runCloudDaemonMode(options: CloudDaemonModeOptions): Promise<never> {
	const env = parseCloudDaemonEnv(options.env);
	// The guest owns its state: agent dir (auth, settings) and daemon state dir
	// both exist before any session or protocol touches them.
	mkdirSync(env.agentDir, { recursive: true, mode: 0o700 });
	chmodSync(env.agentDir, 0o700);
	// Hosted extensions need ctx.ui.theme; init headlessly like the worker.
	initTheme(SettingsManager.create(env.workspaceDir, env.agentDir).getTheme(), false);
	const daemon = await CloudGuestDaemon.start(env, options);
	await daemon.openSession({});
	daemon.startMirrorLoop();

	const initialPrompt =
		env.promptPath !== undefined && existsSync(env.promptPath) ? readFileSync(env.promptPath, "utf8") : "";
	if (initialPrompt.trim().length > 0) {
		await daemon
			.dispatch({ kind: "prompt", text: initialPrompt }, `cmd_initial_${env.sessionId}`)
			.catch(() => undefined);
	}

	let releasing = false;
	const requestRelease = (outcome: "stopped" | "failed") => {
		if (releasing) return;
		releasing = true;
		void daemon
			.release(outcome)
			.catch(() => undefined)
			.then(() => process.exit(outcome === "failed" ? 1 : 0));
	};
	process.on("SIGTERM", () => requestRelease("stopped"));
	process.on("SIGINT", () => requestRelease("stopped"));
	process.on("uncaughtException", (error) => {
		daemon.protocolServer.appendEvent({
			kind: "session_status",
			recordedAt: new Date().toISOString(),
			status: "failed",
		});
		getLogger("cloud-daemon").error(`guest daemon crashed: ${String(error)}`);
		requestRelease("failed");
	});
	return new Promise(() => {});
}
