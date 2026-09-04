/**
 * Built-in Herdr integration extension.
 *
 * Reports agent lifecycle state (working/idle/blocked) to the Herdr terminal
 * workspace manager via its Unix socket. This is the in-tree equivalent of
 * the extension that `herdr integration install pi` writes, so Prime Agent
 * works inside Herdr panes out of the box without a manual install step.
 *
 * Unlike the file-based integration (re-evaluated per session load by jiti),
 * this module is statically imported and evaluated once per process. All env
 * capture and state therefore live inside the factory, which the resource
 * loader invokes per session load — inside the daemon's client-env window —
 * so each daemon session captures its own pane identity.
 *
 * The factory is a complete no-op when `HERDR_ENV` is not `"1"` (i.e. when
 * not running inside a Herdr pane), so it is safe to always load.
 */

import { createConnection } from "node:net";
import { basename, win32 } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "../types.js";

type AgentState = "working" | "blocked" | "idle";

/**
 * True when Herdr's own file-based Pi integration (`herdr integration
 * install pi`) is among the extension files the loader actually loaded this
 * cycle. That extension reports with the same `herdr:pi` source but its own
 * seq counter, so running the built-in alongside it would make the two
 * reporters race on one pane.
 *
 * Loaded paths — not raw disk existence — are the deferral source of truth:
 * a file that exists but never loads (settings `!` overrides, noExtensions,
 * paths outside the discovery dirs such as the legacy `~/.pi/agent/`) never
 * becomes an active reporter, and deferring to it would leave the pane with
 * no reporter at all.
 */
export function hasFileBasedHerdrIntegration(loadedExtensionPaths: string[]): boolean {
	return loadedExtensionPaths.some((path) => {
		const base = basename(path);
		return base === "herdr-agent-state.ts" || base === "herdr-agent-state.js";
	});
}

/** Windows dials local-domain sockets inside \\.\pipe\; Herdr exports a unix-style path, so map it (namespaced paths pass through). */
export function herdrSocketTarget(socketPath: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32" || socketPath.startsWith("\\\\.\\pipe\\") || socketPath.startsWith("\\\\?\\pipe\\")) {
		return socketPath;
	}
	return win32.join("\\\\.\\pipe\\", socketPath);
}

interface QueuedState {
	state: AgentState;
	message?: string;
	seq: number;
}

function parseDurationEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return fallback;
	}
	return parsed;
}

function lastAssistantMessage(messages: unknown[]): any | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as any;
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

/**
 * Error message of the turn's final assistant message, if it ended in error.
 *
 * The agent's auto-retry treats nearly every provider error as retryable and
 * kicks in after extension agent_end fires, so any error end may be followed
 * by a retry. Rather than second-guessing the agent's classification with a
 * pattern list, hold "working" for every error through the retry grace
 * window: if a retry starts, agent_start keeps the pane working; if none
 * does, the hold settles to blocked with the error message.
 */
function errorHoldMessage(event: any): string | undefined {
	const messages = Array.isArray(event?.messages) ? event.messages : [];
	const assistant = lastAssistantMessage(messages);
	if (assistant?.stopReason !== "error") {
		return undefined;
	}
	return String(assistant.errorMessage ?? "") || "provider error";
}

// Monotonic across all extension instances in this process. Herdr guards
// pane.report_agent with a per-source seq and silently drops lower-seq
// reports, so a successor session instance (after /new, resume, fork, or
// reload) must never restart below a seq the previous instance already used —
// otherwise its idle reports are dropped and the pane sticks at "working".
let reportSeq = Date.now() * 1000;

function nextReportSeq(): number {
	reportSeq = Math.max(reportSeq + 1, Date.now() * 1000);
	return reportSeq;
}

/**
 * Build the built-in Herdr reporter factory. `getLoadedExtensionPaths`
 * returns the extension files the resource loader actually loaded in the
 * current cycle; it is re-checked on every factory invocation (i.e. on every
 * session load and `/reload`), so installing Herdr's own file-based
 * integration and reloading hands the pane over to it without also keeping
 * the built-in active — while a file that exists but never loads (settings
 * overrides, legacy paths) does not silence the built-in.
 */
export function createHerdrAgentStateExtension(getLoadedExtensionPaths: () => string[]): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		herdrAgentStateExtensionImpl(pi, getLoadedExtensionPaths);
	};
}

/** Built-in reporter with no file-based deferral, for tests and embedders. */
export const herdrAgentStateExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	herdrAgentStateExtensionImpl(pi, () => []);
};

function herdrAgentStateExtensionImpl(pi: ExtensionAPI, getLoadedExtensionPaths: () => string[]): void {
	// Captured per factory invocation: the resource loader runs this during
	// session load, inside the daemon's client-env window, so these reflect the
	// session's own Herdr pane rather than the daemon's startup environment.
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	const enabled = process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;
	if (!enabled || hasFileBasedHerdrIntegration(getLoadedExtensionPaths())) {
		return;
	}

	const source = "herdr:pi";
	const agentLabel = "prime-agent";
	const idleDebounceMs = parseDurationEnv("HERDR_PI_IDLE_DEBOUNCE_MS", 250);
	const retryGraceMs = parseDurationEnv("HERDR_PI_RETRY_GRACE_MS", 2500);

	let currentAgentSessionId: string | undefined;
	let currentAgentSessionPath: string | undefined;
	// Inline RLM child sessions reuse the parent's resource loader, so their
	// extension runners re-bind these same handler closures. Bind the reporter
	// to the first session that starts (the parent) and ignore events other
	// sessions deliver, or a subagent's turns would flip the pane state and
	// stomp the parent's session reference.
	let boundSessionManager: unknown;
	let sendInFlight = false;
	let queuedState: QueuedState | undefined;
	let activeDrain: Promise<void> = Promise.resolve();
	let released = false;

	let agentActive = false;
	let retryHoldActive = false;
	let failureBlocked = false;
	let failureMessage: string | undefined;
	let blockedCount = 0;
	let blockedMessage: string | undefined;
	let lastState: AgentState | undefined;
	let lastMessage: string | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	function sendRequest(request: unknown): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				socket.destroy();
				resolve();
			};

			const socket = createConnection(herdrSocketTarget(socketPath!));
			socket.on("error", finish);
			socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("data", finish);
			socket.on("end", finish);
			const timeout = setTimeout(finish, 500);
			timeout.unref?.();
		});
	}

	function isBoundSession(ctx: any): boolean {
		if (boundSessionManager === undefined) {
			return true;
		}
		return ctx?.sessionManager === boundSessionManager;
	}

	function updateSessionRef(ctx: any): void {
		try {
			const file = ctx?.sessionManager?.getSessionFile?.();
			currentAgentSessionPath = typeof file === "string" && file.startsWith("/") ? file : undefined;
		} catch {
			currentAgentSessionPath = undefined;
		}

		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
		} catch {
			currentAgentSessionId = undefined;
		}
	}

	function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
		if (currentAgentSessionPath) {
			return { ...params, agent_session_path: currentAgentSessionPath };
		}
		if (currentAgentSessionId) {
			return { ...params, agent_session_id: currentAgentSessionId };
		}
		return params;
	}

	function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
		return sendRequest({
			id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.report_agent",
			params: withSessionRef({
				pane_id: paneId,
				source,
				agent: agentLabel,
				state,
				message,
				seq,
			}),
		});
	}

	function queueState(state: AgentState, message?: string): void {
		if (released) {
			// The pane was released on quit; a late report would reclaim it and
			// leave Herdr showing an agent that already exited.
			return;
		}
		queuedState = { state, message, seq: nextReportSeq() };
		if (!sendInFlight) {
			activeDrain = drainStateQueue();
		}
	}

	async function drainStateQueue(): Promise<void> {
		if (sendInFlight) {
			return;
		}

		sendInFlight = true;
		try {
			while (queuedState) {
				const next = queuedState;
				queuedState = undefined;
				await sendState(next.state, next.message, next.seq);
			}
		} finally {
			sendInFlight = false;
			if (queuedState) {
				activeDrain = drainStateQueue();
			}
		}
	}

	async function releaseAgent(): Promise<void> {
		// Stop new reports, drop anything still queued, and wait for the
		// in-flight send to finish so the release is the last write on the wire;
		// a report landing after the release would reclaim the pane.
		released = true;
		queuedState = undefined;
		await activeDrain.catch(() => undefined);
		return sendRequest({
			id: `${source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.release_agent",
			params: {
				pane_id: paneId,
				source,
				agent: agentLabel,
				seq: nextReportSeq(),
			},
		});
	}

	function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
		if (timer) {
			clearTimeout(timer);
		}
	}

	function clearPendingTimers() {
		clearTimer(idleTimer);
		clearTimer(retryTimer);
		idleTimer = undefined;
		retryTimer = undefined;
	}

	function clearFailureState() {
		retryHoldActive = false;
		failureBlocked = false;
		failureMessage = undefined;
	}

	function desiredState(): { state: AgentState; message?: string } {
		if (blockedCount > 0) {
			return { state: "blocked", message: blockedMessage };
		}
		if (failureBlocked) {
			return { state: "blocked", message: failureMessage };
		}
		if (agentActive || retryHoldActive) {
			return { state: "working", message: undefined };
		}
		return { state: "idle", message: undefined };
	}

	function publishState(force = false) {
		const next = desiredState();
		if (!force && next.state === lastState && next.message === lastMessage) {
			return;
		}
		lastState = next.state;
		lastMessage = next.message;
		queueState(next.state, next.message);
	}

	function scheduleIdle() {
		clearPendingTimers();
		clearFailureState();
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			publishState();
		}, idleDebounceMs);
		idleTimer.unref?.();
	}

	function holdForRetry(message: string) {
		clearPendingTimers();
		retryHoldActive = true;
		failureBlocked = false;
		failureMessage = message;
		publishState();

		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			retryHoldActive = false;
			failureBlocked = true;
			publishState();
		}, retryGraceMs);
		retryTimer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		if (!isBoundSession(ctx)) {
			return;
		}
		if (boundSessionManager === undefined && ctx?.sessionManager !== undefined) {
			boundSessionManager = ctx.sessionManager;
		}
		updateSessionRef(ctx);
		// A reload can re-create this reporter mid-turn (daemon-driven reloads
		// and extension ctx.reload() are not gated on idle). Seed the active
		// flag from the session so the fresh instance does not report idle
		// while the agent is still streaming, which would also make the guard
		// in agent_end swallow the turn's real end transition.
		if (typeof ctx?.isIdle === "function") {
			try {
				agentActive = !ctx.isIdle();
			} catch {
				agentActive = false;
			}
		}
		publishState(true);
	});

	const unsubscribeBlocked = pi.events.on("herdr:blocked", (data: any) => {
		if (!data?.active) {
			blockedCount = Math.max(0, blockedCount - 1);
			if (blockedCount === 0) {
				blockedMessage = undefined;
			}
			publishState();
			return;
		}

		clearPendingTimers();
		// clearPendingTimers cancelled the retry timer; settle the hold the way
		// the timer would have, or retryHoldActive keeps desiredState() at
		// "working" forever once the block lifts.
		if (retryHoldActive) {
			retryHoldActive = false;
			failureBlocked = true;
		}
		blockedCount += 1;
		blockedMessage = data.label;
		publishState();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!isBoundSession(ctx)) {
			return;
		}
		clearPendingTimers();
		clearFailureState();
		agentActive = true;
		publishState();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!isBoundSession(ctx)) {
			return;
		}
		if (!agentActive) {
			// Duplicate/late end events can arrive while auto-retry is already
			// holding the pane in Working. Do not let an unqualified duplicate end
			// cancel the retry hold and publish a false Idle.
			return;
		}

		agentActive = false;

		const holdMessage = errorHoldMessage(event);
		if (holdMessage) {
			holdForRetry(holdMessage);
			return;
		}

		// Queued follow-up/steer messages start another loop right away; debounce
		// so the pane does not flicker done -> working. With nothing queued,
		// report idle immediately so Herdr flips to done as streaming finishes.
		if (typeof ctx?.hasPendingMessages === "function" && ctx.hasPendingMessages()) {
			scheduleIdle();
			return;
		}

		clearPendingTimers();
		clearFailureState();
		publishState();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!isBoundSession(ctx)) {
			return;
		}
		clearPendingTimers();
		// The event bus is shared across reloads and session replacements, so a
		// listener left behind would keep this stale instance reporting with a
		// captured (possibly wrong) pane identity forever.
		unsubscribeBlocked();
		// On session replacement (new/resume/fork) or reload, a successor
		// instance in this same pane re-reports immediately. Releasing here
		// races that report: two independent socket writes with no ordering,
		// and a release that lands after the successor's report clears the
		// pane. Only a real quit should release; every shutdown silences this
		// instance so no stale queued report lands around the successor's.
		if (event?.reason !== "quit") {
			released = true;
			queuedState = undefined;
			return;
		}
		await releaseAgent();
	});
}
