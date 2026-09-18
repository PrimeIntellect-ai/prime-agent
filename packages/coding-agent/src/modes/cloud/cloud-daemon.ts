import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
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
	type CloudRosterRow,
	type CloudSessionState,
	type CloudSessionStatus,
} from "../../core/cloud/protocol.js";
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
			createSubagentRuntimeHost: () => undefined,
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

	/** Run one mirror pass now instead of waiting for the tick. */
	mirrorNow(): void {
		this.mirrorOnce(true);
	}

	private createConnectionState(state: ActiveSessionState): AgentConnectionState {
		return createAgentConnectionState(state.runtime, state.activeSessionId);
	}

	// --- session lifecycle ------------------------------------------------------

	/** Open (or resume) the cloud root session with the cloud session id. */
	async openSession(input: { cwd?: string; model?: string; thinking?: string; prompt?: string }): Promise<void> {
		if (this.rootState) return;
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
		const runtime = await createRuntimeWithModel(
			this.options.createRuntime,
			{
				cwd: sessionManager.getCwd(),
				agentDir: this.env.agentDir,
				sessionManager,
				sessionConfig: { agentDir: this.env.agentDir, cwd, sessionDir },
			},
			input.model ?? this.env.model,
			input.thinking,
		);
		this.rootState = await this.host.addRuntime(runtime);
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
		// Recursive descendants are ordinary in-process subagent runtimes.
		for (const child of runtime.listSubagentRuntimes()) {
			this.track(child);
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

	private refreshTrackedRuntimes(): void {
		if (this.rootState) this.track(this.rootState.runtime);
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
		const walk = (runtime: AgentSessionRuntime, parentRemoteId: string, depth: number): void => {
			for (const child of runtime.listSubagentRuntimes()) {
				const session = child.session;
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
					childId: child.metadata.rlmChildId ?? session.sessionId,
					parentRemoteId,
					...(session.sessionName ? { name: session.sessionName } : {}),
					status: this.childRowStatus(child),
					depth,
					...(preview.length > 0 ? { preview } : {}),
				};
				rows.push(row);
				walk(child, row.childId, depth + 1);
			}
		};
		walk(root, root.session.sessionId, 1);
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
			root.listSubagentRuntimes().some((child) => child.session.isSessionActive || child.session.isStreaming);
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
				return this.dispatchPrompt(request.text, request.queueIfBusy === true);
			case "steer":
				return this.dispatchSteer(request.text);
			case "follow_up":
				return this.dispatchFollowUp(request.text);
			case "abort":
				return this.dispatchAbort();
			case "send_message":
				return this.dispatchSendMessage(request.targetRemoteSessionId, request.message);
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
				return this.dispatchExtensionUiResponse(request.requestId, request.response);
			case "release":
				return this.dispatchRelease();
			default:
				return failed(`unsupported command: ${(request as { kind: string }).kind}`);
		}
	}

	private async dispatchOpenSession(
		request: Extract<CloudCommandRequest, { kind: "open_session" }>,
	): Promise<CloudProtocolDispatchResult> {
		if (this.rootState) {
			// Idempotent open: an already-resident session honors a duplicate
			// open_session's prompt instead of silently dropping it.
			if (request.prompt !== undefined && request.prompt.length > 0) {
				return this.dispatchPrompt(request.prompt, false);
			}
			return completed();
		}
		try {
			await this.openSession({ cwd: request.cwd, model: request.model, thinking: request.thinking });
		} catch (error) {
			return failure(error);
		}
		if (request.prompt !== undefined && request.prompt.length > 0) {
			return this.dispatchPrompt(request.prompt, false);
		}
		return completed();
	}

	private async dispatchPrompt(text: string, queueIfBusy: boolean): Promise<CloudProtocolDispatchResult> {
		const session = this.rootSession;
		if (!session) return failed("no open session");
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
		targetRemoteSessionId: string,
		message: string,
	): Promise<CloudProtocolDispatchResult> {
		// v1 guest scope: delivery into this sandbox's own sessions. The
		// supervisor-side family routing lands with the registry slice.
		const root = this.rootSession;
		if (!root) return failed("no open session");
		if (targetRemoteSessionId === this.rootState?.runtime.session.sessionId) {
			try {
				await root.acceptAgentMessagePrompt(message);
			} catch (error) {
				return failure(error);
			}
			return completed();
		}
		const target = [...this.host.values()].find((state) => state.runtime.session.sessionId === targetRemoteSessionId);
		if (!target) return failed(`unknown remote session ${targetRemoteSessionId}`);
		try {
			await target.runtime.session.acceptAgentMessagePrompt(message);
		} catch (error) {
			return failure(error);
		}
		return completed();
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
		// child runtime through the same runtime-host API the daemon worker
		// uses, so artifacts and ledger edges stay consistent.
		state.runtime.session.cancelRlmChildRun(childId, "Deleted by cloud client");
		try {
			await state.runtime.deleteRlmSubagentRuntime(childId, state.runtime.session);
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

	private dispatchExtensionUiResponse(requestId: string, response: unknown): CloudProtocolDispatchResult {
		const state = this.rootState;
		if (!state) return failed("no open session");
		const pending = state.extensionUiRequests.get(requestId);
		if (!pending) return failed(`unknown extension ui request ${requestId}`);
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
