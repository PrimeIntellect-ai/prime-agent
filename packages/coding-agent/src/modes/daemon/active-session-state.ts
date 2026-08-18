import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentStatus } from "../../core/session-manager.js";
import type { DaemonClientCapability, DaemonEventSequence, DaemonExtensionUIResponse } from "./daemon-protocol.js";
import { formatSessionDisplayId, matchesSessionIdSuffix } from "./daemon-session-id.js";

export interface DaemonSocketClient {
	id: string;
	socket: Socket;
	attachedActiveSessionIds: Set<string>;
	/** Session events are dropped while the socket is blocked and replaced with one catch-up snapshot on drain. */
	catchupActiveSessionIds?: Set<string>;
	/** A real runtime replacement takes precedence over an ordinary resync for the same queued catch-up. */
	catchupPurposes?: Map<string, "replacement" | "resync">;
	/** The single catch-up drain currently serving this client. */
	catchupPromise?: Promise<void>;
	/** Delayed retry after transient catch-up snapshot preparation failure. */
	catchupRetryTimer?: NodeJS.Timeout;
	backpressured?: boolean;
	authenticated?: boolean;
	transport?: "jsonl" | "private-framed";
	snapshotStreaming?: boolean;
	snapshotActiveSessionIds?: Set<string>;
	snapshotActiveSessionCounts?: Map<string, number>;
	snapshotTransferAbortControllers?: Map<string, AbortController>;
	snapshotTransferTails?: Map<string, Promise<void>>;
	detachInput: () => void;
	supportsExtensionUi: boolean;
	capabilities: Set<DaemonClientCapability>;
	capabilitiesByActiveSessionId?: Map<string, Set<DaemonClientCapability>>;
}

export interface ActiveSessionState {
	activeSessionId: string;
	runtime: AgentSessionRuntime;
	clients: Set<DaemonSocketClient>;
	/** Attach snapshots in flight: reserved for passivation busyness, but not yet event recipients. */
	pendingAttaches: number;
	extensionUiRequests: Map<string, ActiveSessionExtensionUiRequest>;
	eventGeneration: string;
	lastEventSequence: DaemonEventSequence;
	unsubscribe?: () => void;
	/** Latest background status summary, surfaced in the agents view. */
	summaryState?: AgentStatus;
	/**
	 * Client env (e.g. herdr pane identity), merged over process.env for this
	 * session's pi.exec() subprocesses. Bound when the runtime is created (or
	 * adopted from the first env-carrying create that reuses an env-less
	 * session); never overwritten after that — watchers also attach, and
	 * extensions capture identity at load. Subagents inherit the parent's.
	 */
	clientEnv?: Record<string, string>;
}

export interface ActiveSessionExtensionUiRequest {
	resolve: (response: DaemonExtensionUIResponse) => void;
}

interface ActiveSessionIdIndex {
	has(activeSessionId: string): boolean;
}

export function createActiveSessionId(existingIds?: ActiveSessionIdIndex): string {
	while (true) {
		const activeSessionId = formatSessionDisplayId(randomUUID());
		if (!existingIds?.has(activeSessionId)) {
			return activeSessionId;
		}
	}
}

export class AmbiguousActiveSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AmbiguousActiveSessionError";
	}
}

export function resolveActiveSessionState(
	sessions: ReadonlyMap<string, ActiveSessionState>,
	selector: string,
): ActiveSessionState {
	const direct = sessions.get(selector);
	if (direct) {
		return direct;
	}

	const exactMatches = uniqueStates(
		[...sessions.values()].filter((state) => {
			const session = state.runtime.session;
			return session.sessionId === selector || session.sessionName === selector;
		}),
	);
	if (exactMatches.length === 1) {
		return exactMatches[0]!;
	}
	if (exactMatches.length > 1) {
		throw new AmbiguousActiveSessionError(formatAmbiguousSessionError(selector, exactMatches));
	}

	const suffixMatches = uniqueStates(
		[...sessions.values()].filter((state) => {
			const session = state.runtime.session;
			return (
				matchesSessionIdSuffix(state.activeSessionId, selector) ||
				matchesSessionIdSuffix(session.sessionId, selector)
			);
		}),
	);
	if (suffixMatches.length === 1) {
		return suffixMatches[0]!;
	}
	if (suffixMatches.length > 1) {
		throw new AmbiguousActiveSessionError(formatAmbiguousSessionError(selector, suffixMatches));
	}

	throw new Error(`Unknown active session: ${selector}`);
}

function uniqueStates(states: ActiveSessionState[]): ActiveSessionState[] {
	const unique = new Map<string, ActiveSessionState>();
	for (const state of states) {
		unique.set(state.activeSessionId, state);
	}
	return [...unique.values()];
}

function formatAmbiguousSessionError(selector: string, states: readonly ActiveSessionState[]): string {
	return `Ambiguous active session "${selector}": matches ${states.map(formatSessionMatch).join(", ")}`;
}

function formatSessionMatch(state: ActiveSessionState): string {
	const session = state.runtime.session;
	const name = session.sessionName ? ` (${session.sessionName})` : "";
	return `${state.activeSessionId}/${session.sessionId}${name}`;
}
