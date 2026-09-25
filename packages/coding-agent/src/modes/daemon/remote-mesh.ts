import {
	AGENT_FAMILY_REACH_ERROR,
	type AgentFamilyCatalogEntry,
	type AgentFamilyRelationship,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
	agentFamilyRelationship,
} from "../../core/agent-messages.js";
import type { AgentRosterEntry, RosterSessionSummary } from "./agent-roster.js";
import { sessionSummaryFromRosterEntry } from "./agent-roster.js";
import { matchesSessionIdSuffix } from "./daemon-session-id.js";
import { classifySessionRosterStatus, type SessionSummary } from "./daemon-session-list.js";

// Tailnet remote-agent mesh: converts RemoteAgentHost snapshots into
// roster, list, and family shapes; marks unreachable peers offline; and
// defines the cross-machine delivery seam. The supervisor refreshes this
// state on demand when a roster consumer queries it.

/** Session facts a remote daemon publishes over the mesh (PR 3 discovery output). */
export interface RemoteAgentSessionSummary {
	id: string;
	sessionId: string;
	activeSessionId?: string;
	sessionName?: string;
	lifecycle: "draft" | "live" | "archived";
	activity: "working" | "idle";
	isStreaming?: boolean;
	isRunningTools?: boolean;
	isCompacting?: boolean;
	cwd: string;
	/** Display-only model identity; remote summaries never carry a full Model. */
	model?: { provider: string; modelId: string };
	messageCount: number;
	attachedClients: number;
	rlmDepth?: number;
	runtimeKind?: "top-level" | "subagent";
	created?: string;
	modified?: string;
	lastActivityAt?: string;
	firstMessage?: string;
	summary?: string;
	taskState?: SessionSummary["taskState"];
	unfinishedActionCount?: number;
}

/** One tailnet peer as reported by an on-demand mesh scan (PR 3). */
export interface RemoteAgentHost {
	/** MagicDNS hostname, e.g. "milk.tailnet.ts.net"; the agents-view label source. */
	tailnetHost: string;
	/** The peer is present in `tailscale status`. */
	online: boolean;
	/** A prime-agent daemon answered on the mesh port. */
	daemon: boolean;
	/** The daemon answered but this machine holds no valid token for its roster. */
	locked?: boolean;
	error?: string;
	/** Mesh port that answered (PR 5 message targeting). */
	port?: number;
	/** Short machine name, display fallback only. */
	hostname?: string;
	sessions: RemoteAgentSessionSummary[];
}

/** On-demand discovery seam; PR 3 backs `list_remote_agents` with the same source. */
export interface RemoteAgentMeshSource {
	listRemoteAgents(): Promise<RemoteAgentHost[]>;
}

export interface RemoteAgentMessageDelivery {
	host: RemoteAgentHost;
	/** Whether the peer was reachable at the last scan. */
	offline: boolean;
	target: Pick<RemoteAgentSessionSummary, "id" | "sessionId" | "activeSessionId" | "sessionName">;
	message: string;
	sender?: AgentSessionMessageSender;
	fromRelationship?: AgentFamilyRelationship;
}

/** Cross-machine delivery seam; PR 5 implements it over the PR 2 TCP transport. */
export interface RemoteAgentMessageTransport {
	sendAgentMessage(delivery: RemoteAgentMessageDelivery): Promise<AgentSessionMessageReceipt>;
}

export interface RemoteAgentMeshOptions {
	source?: RemoteAgentMeshSource;
	transport?: RemoteAgentMessageTransport;
	/** Minimum age before a scan may run again; roster queries share one scan. */
	refreshTtlMs?: number;
	/** How long an unreachable peer's rows stay visible before being forgotten. */
	offlineTtlMs?: number;
	onRosterChange?: (changed: readonly string[], removed: readonly string[]) => void;
	onScanError?: (error: unknown) => void;
	/** Time source for tests. */
	now?: () => number;
}

export interface RemoteAgentMessageTarget {
	host: RemoteAgentHost;
	offline: boolean;
	sessionId: string;
	activeSessionId?: string;
	summary: SessionSummary;
}

const DEFAULT_REMOTE_MESH_REFRESH_TTL_MS = 30_000;
/**
 * Offline rows are kept so unreachable peers read "offline" instead of
 * vanishing, but a peer that stays gone is eventually forgotten: mesh state
 * must stay bounded when a tailnet churns through transient devices.
 */
const DEFAULT_REMOTE_MESH_OFFLINE_TTL_MS = 24 * 60 * 60_000;

/**
 * A peer publishes its own session ids, so one id is only unique inside one
 * daemon. Roster ids and send checks namespace a remote row's ids with its
 * host; a row with no host is local and keeps the bare id.
 */
export function agentMeshIdentity(tailnetHost: string | undefined, sessionId: string): string {
	return tailnetHost ? `remote:${tailnetHost}#${sessionId}` : sessionId;
}

/** A host answers with a usable roster only when online, unlocked, and daemon-backed. */
function isRemoteHostUsable(host: RemoteAgentHost): boolean {
	return host.online && host.daemon && host.locked !== true;
}

/** PR 4 surfaces depth-0 remote sessions only: their children have no locally resident parents to nest under. */
function isSurfaceRemoteSession(session: RemoteAgentSessionSummary): boolean {
	return (session.rlmDepth ?? 0) === 0;
}

function remoteSessionSummary(
	host: RemoteAgentHost,
	session: RemoteAgentSessionSummary,
	offline: boolean,
): RosterSessionSummary {
	const isStreaming = session.isStreaming ?? false;
	return {
		id: session.id,
		lifecycle: session.lifecycle,
		activity: session.activity,
		// The remote daemon does not publish residency; "working" is the closest truth.
		isSessionActive: isStreaming || session.activity === "working",
		...(session.activeSessionId ? { activeSessionId: session.activeSessionId } : {}),
		sessionId: session.sessionId,
		...(session.sessionName ? { sessionName: session.sessionName } : {}),
		cwd: session.cwd,
		...(session.model ? { remoteModel: session.model } : {}),
		isStreaming,
		isCompacting: session.isCompacting ?? false,
		...(session.isRunningTools === undefined ? {} : { isRunningTools: session.isRunningTools }),
		attachedClients: session.attachedClients,
		messageCount: session.messageCount,
		...(session.unfinishedActionCount === undefined ? {} : { unfinishedActionCount: session.unfinishedActionCount }),
		...(session.runtimeKind ? { runtimeKind: session.runtimeKind } : {}),
		rlmDepth: session.rlmDepth ?? 0,
		...(session.created ? { created: session.created } : {}),
		...(session.modified ? { modified: session.modified } : {}),
		...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
		...(session.firstMessage ? { firstMessage: session.firstMessage } : {}),
		...(session.summary ? { summary: session.summary } : {}),
		...(session.taskState ? { taskState: session.taskState } : {}),
		remoteHost: host.tailnetHost,
		...(offline ? { remoteOffline: true } : {}),
		// Remote rows never carry local runtime identity; display surfaces read remoteHost instead.
		rosterStatus: offline
			? "inactive"
			: classifySessionRosterStatus({
					activeSessionId:
						session.activeSessionId ??
						(isStreaming || session.activity === "working" ? session.sessionId : undefined),
					activity: session.activity,
					isSessionActive: isStreaming || session.activity === "working",
				}),
	};
}

interface RemoteAgentMeshHostState {
	host: RemoteAgentHost;
	offline: boolean;
	/** Last scan that served a usable roster from this host; drives offline expiry. */
	lastSeenAt: number;
	sessions: Map<string, RemoteAgentSessionSummary>;
}

/**
 * Supervisor-side cache of the last tailnet mesh scan. The mesh never keeps a
 * background loop: `refreshIfStale` runs at most once per TTL when a roster
 * consumer asks, coalescing concurrent queries onto the single in-flight scan.
 * Hosts that drop from a scan keep their last known sessions, marked offline,
 * so the agents view reads "offline" instead of losing rows.
 */
export class RemoteAgentMeshState {
	private readonly source?: RemoteAgentMeshSource;
	private readonly transport?: RemoteAgentMessageTransport;
	private readonly refreshTtlMs: number;
	private readonly offlineTtlMs: number;
	private readonly onRosterChange?: RemoteAgentMeshOptions["onRosterChange"];
	private readonly onScanError?: RemoteAgentMeshOptions["onScanError"];
	private readonly now: () => number;
	private readonly hosts = new Map<string, RemoteAgentMeshHostState>();
	private readonly entries = new Map<string, AgentRosterEntry>();
	/** undefined until the first scan, so an epoch-0 clock cannot fake freshness. */
	private lastScanAt?: number;
	private scan?: Promise<boolean>;

	constructor(options: RemoteAgentMeshOptions = {}) {
		this.source = options.source;
		this.transport = options.transport;
		this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REMOTE_MESH_REFRESH_TTL_MS;
		this.offlineTtlMs = options.offlineTtlMs ?? DEFAULT_REMOTE_MESH_OFFLINE_TTL_MS;
		this.onRosterChange = options.onRosterChange;
		this.onScanError = options.onScanError;
		this.now = options.now ?? Date.now;
	}

	enabled(): boolean {
		return this.source !== undefined;
	}

	/**
	 * On-demand refresh bounded by the TTL. Concurrent callers share one scan;
	 * a caller that arrives inside the TTL (or joins an in-flight scan) does
	 * not trigger another. Returns whether a scan completed for this call.
	 */
	async refreshIfStale(): Promise<boolean> {
		if (!this.source) return false;
		if (this.scan) return this.scan;
		if (this.lastScanAt !== undefined && this.now() - this.lastScanAt < this.refreshTtlMs) return false;
		return this.refresh();
	}

	/**
	 * On-demand refresh with a bounded wait: callers answer with whatever the
	 * scan produced inside the budget, and a scan that outruns it lands as a
	 * roster push when it completes. The wait never starts a second scan.
	 */
	async refreshAwaiting(waitMs: number): Promise<void> {
		// A single timer participates in the race and is cleared when the refresh
		// settles first, so frequent polling retains no timer per request.
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.refreshIfStale(),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, waitMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	private async refresh(): Promise<boolean> {
		if (!this.source) return false;
		if (this.scan) return this.scan;
		this.scan = this.runScan(this.source);
		return this.scan.finally(() => {
			this.scan = undefined;
		});
	}

	private async runScan(source: RemoteAgentMeshSource): Promise<boolean> {
		let hosts: RemoteAgentHost[];
		try {
			hosts = await source.listRemoteAgents();
		} catch (error) {
			this.onScanError?.(error);
			this.lastScanAt = this.now();
			return false;
		}
		this.lastScanAt = this.now();
		this.applyScan(hosts);
		return true;
	}

	private applyScan(hosts: readonly RemoteAgentHost[]): void {
		// One row per host: a malformed duplicate entry never wins over a usable one.
		const scanned = new Map<string, RemoteAgentHost>();
		for (const host of hosts) {
			if (!host.tailnetHost) continue;
			const previous = scanned.get(host.tailnetHost);
			if (!previous || (!isRemoteHostUsable(previous) && isRemoteHostUsable(host))) {
				scanned.set(host.tailnetHost, host);
			}
		}
		const now = this.now();
		for (const [tailnetHost, state] of this.hosts) {
			const host = scanned.get(tailnetHost);
			if (host && isRemoteHostUsable(host)) {
				state.host = host;
				state.offline = false;
				state.lastSeenAt = now;
				state.sessions = mergeRemoteSessions(host.sessions);
				continue;
			}
			// Peer dropped, went daemon-less, or locked: keep the last known rows,
			// marked offline, until the offline TTL forgets a long-gone peer.
			state.offline = true;
			if (now - state.lastSeenAt > this.offlineTtlMs) this.hosts.delete(tailnetHost);
		}
		for (const host of scanned.values()) {
			if (!isRemoteHostUsable(host) || this.hosts.has(host.tailnetHost)) continue;
			const sessions = mergeRemoteSessions(host.sessions);
			if (sessions.size === 0) continue;
			this.hosts.set(host.tailnetHost, { host, offline: false, lastSeenAt: now, sessions });
		}
		this.publishEntries();
	}

	private publishEntries(): void {
		const entries = new Map<string, AgentRosterEntry>();
		for (const state of this.hosts.values()) {
			for (const session of state.sessions.values()) {
				const agentId = agentMeshIdentity(state.host.tailnetHost, session.sessionId);
				entries.set(agentId, remoteAgentRosterEntry(state, session));
			}
		}
		const changed: string[] = [];
		const removed: string[] = [];
		for (const [agentId, entry] of entries) {
			const previous = this.entries.get(agentId);
			// Entry objects are rebuilt each scan; compare structurally so an
			// identical roster row is not marked changed on every scan.
			if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(entry)) changed.push(agentId);
		}
		for (const agentId of this.entries.keys()) {
			if (!entries.has(agentId)) removed.push(agentId);
		}
		this.entries.clear();
		for (const [agentId, entry] of entries) this.entries.set(agentId, entry);
		if (changed.length > 0 || removed.length > 0) {
			this.onRosterChange?.(changed, removed);
		}
	}

	/** Roster projection pushed to subscribed clients. */
	entriesForClients(): AgentRosterEntry[] {
		return [...this.entries.values()];
	}

	entryById(agentId: string): AgentRosterEntry | undefined {
		return this.entries.get(agentId);
	}

	/** `list` response rows: roster summaries with neutral session actions filled in. */
	sessionSummaries(): SessionSummary[] {
		return [...this.entries.values()].map((entry) => sessionSummaryFromRosterEntry(entry));
	}

	/** Depth-0 peer rows for `list_agent_peers` (worker-side sibling lists). */
	peerSummaries(): AgentSessionMessageAgentSummary[] {
		return [...this.entries.values()].map((entry) => {
			const summary = sessionSummaryFromRosterEntry(entry);
			return {
				activeSessionId: summary.activeSessionId ?? summary.id,
				sessionId: summary.sessionId,
				...(summary.sessionName ? { sessionName: summary.sessionName } : {}),
				runtimeKind: summary.runtimeKind ?? "top-level",
				cwd: summary.cwd,
				isStreaming: summary.isStreaming,
				unfinishedActionCount: summary.unfinishedActionCount ?? 0,
				rlmDepth: 0,
				status: summary.rosterStatus ?? classifySessionRosterStatus(summary),
				...(summary.remoteHost ? { remoteHost: summary.remoteHost } : {}),
			};
		});
	}

	/**
	 * Resolve send targets by session id, active id, or name. Local workers
	 * always take precedence: this lookup is only consulted after local
	 * resolution fails, so remote rows never shadow or crowd local ones.
	 * Session names are unique per daemon, not per tailnet: callers must
	 * treat a two-match result as ambiguous exactly like the local path.
	 * Selector handling mirrors the local live-session path: an exact id or
	 * name wins, and the 12-character id a session table prints resolves by
	 * suffix, so a copied table id reaches a remote row the same way.
	 */
	findMessageTargets(selector: string): RemoteAgentMessageTarget[] {
		const rows = [...this.entries.values()].map((entry) => {
			const summary = sessionSummaryFromRosterEntry(entry);
			return { summary, activeSessionId: summary.activeSessionId ?? summary.id };
		});
		const exact = rows.filter(
			(row) =>
				row.activeSessionId === selector ||
				row.summary.sessionId === selector ||
				row.summary.sessionName === selector,
		);
		const matches =
			exact.length > 0
				? exact
				: rows.filter(
						(row) =>
							matchesSessionIdSuffix(row.activeSessionId, selector) ||
							matchesSessionIdSuffix(row.summary.sessionId, selector),
					);
		const targets: RemoteAgentMessageTarget[] = [];
		for (const { summary } of matches) {
			const state = this.hosts.get(summary.remoteHost ?? "");
			if (!state) continue;
			targets.push({
				host: state.host,
				offline: state.offline,
				sessionId: summary.sessionId,
				...(summary.activeSessionId ? { activeSessionId: summary.activeSessionId } : {}),
				summary,
			});
		}
		return targets;
	}

	/** Deliver through the PR 5 seam; offline peers and missing transports fail loudly. */
	async sendAgentMessage(input: {
		target: RemoteAgentMessageTarget;
		message: string;
		sender?: AgentSessionMessageSender;
		fromRelationship?: AgentFamilyRelationship;
	}): Promise<AgentSessionMessageReceipt> {
		const { target } = input;
		if (!this.transport) {
			throw new Error(
				`Cannot message the remote agent on ${target.host.tailnetHost}: remote agent messaging is not available on this daemon`,
			);
		}
		if (target.offline) {
			throw new Error(`Remote agent on ${target.host.tailnetHost} is offline`);
		}
		return this.transport.sendAgentMessage({
			host: target.host,
			offline: target.offline,
			target: {
				id: target.summary.id,
				sessionId: target.sessionId,
				...(target.activeSessionId ? { activeSessionId: target.activeSessionId } : {}),
				...(target.summary.sessionName ? { sessionName: target.summary.sessionName } : {}),
			},
			message: input.message,
			...(input.sender ? { sender: input.sender } : {}),
			...(input.fromRelationship ? { fromRelationship: input.fromRelationship } : {}),
		});
	}
}

function mergeRemoteSessions(sessions: readonly RemoteAgentSessionSummary[]): Map<string, RemoteAgentSessionSummary> {
	// A usable scan fully replaces the host's roster; stale sessions must not linger as ghosts.
	const merged = new Map<string, RemoteAgentSessionSummary>();
	for (const session of sessions) {
		// A row without a session id cannot be addressed; a malformed peer never poisons the roster.
		if (!session.sessionId || !isSurfaceRemoteSession(session)) continue;
		// Defensive dedupe: one row per session id per host.
		if (!merged.has(session.sessionId)) merged.set(session.sessionId, session);
	}
	return merged;
}

/**
 * Family-catalog facts for a remote target: depth-0, no parent edges. Reach
 * derives exactly as for local rows: a depth-0 remote session is a sibling of
 * depth-0 locals and unrelated to everything else. The id carries the target's
 * host scope, so a peer that reuses a local session id is another agent.
 */
function remoteAgentFamilyEntry(target: RemoteAgentMessageTarget): AgentFamilyCatalogEntry {
	return {
		id: agentMeshIdentity(target.host.tailnetHost, target.sessionId),
		...(target.summary.sessionName ? { name: target.summary.sessionName } : {}),
		depth: target.summary.rlmDepth ?? 0,
		status: target.summary.rosterStatus ?? "inactive",
	};
}

/** Family relationship of a local source to a remote target, or undefined when unrelated. */
export function remoteAgentFamilyRelationship(
	source: AgentFamilyCatalogEntry,
	target: RemoteAgentMessageTarget,
): AgentFamilyRelationship | undefined {
	return agentFamilyRelationship(source, remoteAgentFamilyEntry(target));
}

/** Family reach for agent-origin sends to a remote target; throws like local delivery. */
export function assertRemoteAgentFamilyReach(source: AgentFamilyCatalogEntry, target: RemoteAgentMessageTarget): void {
	if (!agentFamilyRelationship(source, remoteAgentFamilyEntry(target))) {
		throw new Error(AGENT_FAMILY_REACH_ERROR);
	}
}

function remoteAgentRosterEntry(state: RemoteAgentMeshHostState, session: RemoteAgentSessionSummary): AgentRosterEntry {
	const summary = remoteSessionSummary(state.host, session, state.offline);
	return {
		agentId: agentMeshIdentity(state.host.tailnetHost, session.sessionId),
		summary,
		status: summary.rosterStatus ?? "idle",
		// Exceptional labels are the one channel the Activity column renders, so
		// an unreachable peer reads "offline" exactly like a recovering worker.
		...(state.offline ? { statusLabel: "offline" as const } : {}),
	};
}
