import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { VERSION } from "../../config.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { InProcessAgentConnection } from "../agent-connection/in-process-agent-connection.js";
import type { AgentConnection } from "../agent-connection/types.js";
import { latestAutonomousGateAttempt } from "../headless-completion.js";
import { type AcpEventMappingState, acpUpdatesForSessionEvent } from "./acp-events.js";
import { primeAgentMeta } from "./acp-meta.js";
import { type AcpStopReason, acpStopReason } from "./acp-stop-reason.js";

/**
 * ACP (Agent Client Protocol) mode.
 *
 * prime-agent acts as an ACP agent over NDJSON on stdio, driving an
 * `AgentConnection` in-process. It deliberately does not shell out to RPC mode
 * and translate: prime-agent's differentiators (IPython-only tools, subagents,
 * autonomous gates) are visible as first-class events here, and a translating
 * adapter is exactly what flattens them away.
 *
 * Capabilities ACP has no native concept for travel in a reverse-domain
 * `_meta` envelope, which vanilla ACP clients ignore.
 */

/**
 * ACP frames must reach real stdout.
 *
 * Startup calls `takeOverStdout()` for every non-interactive mode, which
 * redirects `process.stdout.write` to stderr so stray logging cannot corrupt a
 * machine-readable stream. Handing `process.stdout` to the SDK would therefore
 * publish the whole protocol on stderr; write through the raw escape hatch the
 * guard exposes, exactly as RPC mode does.
 */
function rawStdoutSink(): WritableStream<Uint8Array> {
	const decoder = new TextDecoder();
	return new WritableStream<Uint8Array>({
		write(chunk) {
			writeRawStdout(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
		},
	});
}

function normalizeWindowsDriveLetter(path: string): string {
	if (process.platform !== "win32" || !/^[A-Z]:/i.test(path)) return path;
	return path.slice(0, 1).toLowerCase() + path.slice(1);
}

function canonicalCwd(path: string): string {
	const resolved = resolve(path);
	let canonical: string;
	try {
		canonical = realpathSync(resolved);
	} catch {
		// Preserve the previous lexical comparison when a path is missing or inaccessible.
		canonical = resolved;
	}
	return normalizeWindowsDriveLetter(canonical);
}

function sameCwd(left: string, right: string): boolean {
	const canonicalLeft = canonicalCwd(left);
	const canonicalRight = canonicalCwd(right);
	if (canonicalLeft === canonicalRight) return true;

	try {
		const leftStat = statSync(canonicalLeft, { bigint: true });
		const rightStat = statSync(canonicalRight, { bigint: true });
		// Either half being zero makes the pair untrustworthy: Windows path-based
		// stat can report dev 0 with a real ino, and comparing ino alone would match
		// distinct directories on different volumes, since file IDs are volume-local.
		const leftIdentityMissing = leftStat.dev === 0n || leftStat.ino === 0n;
		const rightIdentityMissing = rightStat.dev === 0n || rightStat.ino === 0n;
		if (leftIdentityMissing || rightIdentityMissing) return false;
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

export interface AcpModeOptions {
	/** Bind headless extensions once the connection is live (in-process mode). */
	bindHeadlessExtensions?: () => Promise<void>;
	/**
	 * Transport override. Defaults to NDJSON over stdio; tests supply an
	 * in-memory stream pair so the protocol runs without a subprocess.
	 */
	stream?: ReturnType<typeof acp.ndJsonStream>;
	/** Skip claiming stdout when the caller supplies its own transport. */
	ownStdout?: boolean;
}

interface AcpSessionEntry {
	id: string;
	abort: AbortController | undefined;
	unsubscribe: (() => void) | undefined;
}

/**
 * Split ACP prompt blocks into the text and images prime-agent accepts.
 *
 * Image and embedded-resource blocks are advertised in `initialize`, so they must
 * actually reach the model: dropping them silently would let a client believe a
 * pasted screenshot was accepted.
 */
function promptContent(blocks: readonly unknown[]): { text: string; images: ImageContent[] } {
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const typed = block as {
			type?: string;
			text?: string;
			data?: string;
			mimeType?: string;
			uri?: string;
			resource?: { text?: string; uri?: string };
		};
		if (typed.type === "text" && typeof typed.text === "string") {
			texts.push(typed.text);
		} else if (typed.type === "image" && typeof typed.data === "string" && typeof typed.mimeType === "string") {
			images.push({ type: "image", data: typed.data, mimeType: typed.mimeType });
		} else if (typed.type === "resource" && typeof typed.resource?.text === "string") {
			// Embedded text resources become context the model can read.
			const uri = typed.resource.uri ? `${typed.resource.uri}\n` : "";
			texts.push(`${uri}${typed.resource.text}`);
		} else if (typed.type === "resource_link" && typeof typed.uri === "string") {
			texts.push(typed.uri);
		}
	}
	return { text: texts.join("\n"), images };
}

function autonomousMeta(status: AgentAutonomousStatus | undefined): Record<string, unknown> | undefined {
	if (!status?.enabled) return undefined;
	return primeAgentMeta({
		autonomous: {
			enabled: status.enabled,
			continuationsUsed: status.continuationsUsed,
			turnsUsed: status.turnsUsed,
			tokensUsed: status.tokensUsed,
			gateAttempt: latestAutonomousGateAttempt(status) || undefined,
			gateFailure: status.lastGateFailure?.exitText,
		},
	});
}

/**
 * The transcript as it stood before a turn started, recorded so the turn's own
 * messages can be told apart from everything older.
 *
 * A pre-turn message *count* cannot do that job: auto-compaction can fire during
 * a turn and rebuild `state.messages` (it filters, slices, and re-materializes
 * persisted entries), so this turn's failure can end up at a lower index than
 * the count taken before prompting. Membership is tracked by things a rebuild
 * preserves instead — the message objects themselves, plus a content key for
 * transports that hand back fresh copies (daemon RPC re-parses JSON, so identity
 * does not survive it) and for compaction paths that re-materialize a kept
 * message from its persisted entry with its original timestamp.
 */
interface TurnBoundary {
	identities: WeakSet<object>;
	keys: Set<string>;
}

/** Key for a kept message: compaction drops messages, it does not rewrite them. */
function messageKey(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as { role?: unknown; timestamp?: unknown; stopReason?: unknown; errorMessage?: unknown };
	if (typeof record.timestamp !== "number") return undefined;
	return JSON.stringify([
		record.role ?? null,
		record.timestamp,
		record.stopReason ?? null,
		record.errorMessage ?? null,
	]);
}

function turnBoundary(messages: readonly AgentMessage[]): TurnBoundary {
	const identities = new WeakSet<object>();
	const keys = new Set<string>();
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		identities.add(message);
		const key = messageKey(message);
		if (key) keys.add(key);
	}
	return { identities, keys };
}

function isPreTurn(message: unknown, boundary: TurnBoundary): boolean {
	if (typeof message !== "object" || message === null) return false;
	if (boundary.identities.has(message)) return true;
	const key = messageKey(message);
	return key !== undefined && boundary.keys.has(key);
}

/**
 * Error text from an assistant message this turn produced, when it failed.
 *
 * `promptAndWait` resolves for a failed turn just as it does for a successful
 * one, so the outcome has to be read off the transcript. Only messages that were
 * not in the transcript before the turn are considered: scanning the whole
 * transcript would let an earlier failed turn reject a later turn that never
 * called the model (a handled slash command, say), reporting a stale error.
 *
 * A transcript read that fails is not treated as success — that would restore
 * the silent-success behavior this exists to prevent.
 */
async function turnFailure(connection: AgentConnection, boundary: TurnBoundary): Promise<string | undefined> {
	const messages = await connection.getMessages();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		// The newest assistant message predates the turn, so the turn appended none.
		if (isPreTurn(message, boundary)) return undefined;
		const assistant = message as { stopReason?: string; errorMessage?: string };
		if (assistant.stopReason !== "error") return undefined;
		return assistant.errorMessage || "the model request failed";
	}
	return undefined;
}

export async function runAcpMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	const connection = new InProcessAgentConnection(runtimeHost);
	return runAcpModeWithConnection(connection, {
		bindHeadlessExtensions: () => connection.bindHeadlessExtensions({}),
	});
}

export async function runAcpModeWithConnection(
	connection: AgentConnection,
	options: AcpModeOptions = {},
): Promise<never> {
	// ACP owns stdout: any stray write corrupts the JSON-RPC stream.
	if (options.ownStdout !== false && !options.stream) {
		takeOverStdout();
	}

	// One ACP connection drives one AgentConnection, whose newSession() replaces
	// the live session rather than creating a parallel one. Tracking a single
	// session keeps every event unambiguously attributable; a second session/new
	// is refused rather than silently sharing conversation state, cwd, and queues.
	let session: AcpSessionEntry | undefined;
	let bound = false;

	const stream =
		options.stream ?? acp.ndJsonStream(rawStdoutSink(), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

	const handle = acp
		.agent({ name: "prime-agent" })
		.onRequest("initialize", async () => ({
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: true, embeddedContext: true },
				// Advertise close so a client knows it can release the session (and
				// the single-session slot) instead of dropping the connection.
				sessionCapabilities: { close: {} },
			},
			agentInfo: { name: "prime-agent", title: "Prime Agent", version: VERSION },
			// Advertise prime-agent extras under a namespaced key: ACP reserves
			// every object root for future protocol fields.
			_meta: primeAgentMeta({}),
		}))
		.onRequest("session/new", async (ctx: any) => {
			if (!bound) {
				// Only latch after a successful bind: a rejected bind must not leave
				// extensions permanently unavailable for the rest of the process.
				await options.bindHeadlessExtensions?.();
				bound = true;
			}
			if (session) {
				throw new Error(
					"prime-agent ACP mode hosts one session per connection; " +
						"start another prime-agent process for a second session",
				);
			}
			// prime-agent's cwd is fixed at startup by the session it was launched
			// with, so a client-supplied cwd cannot be adopted after the fact.
			// Report the real cwd back in `_meta` rather than failing the request or
			// letting the client assume a directory the agent is not using.
			const requestedCwd = (ctx.params as { cwd?: unknown } | undefined)?.cwd;
			let cwdMismatch: { requested: string; actual: string } | undefined;
			if (typeof requestedCwd === "string" && requestedCwd.length > 0) {
				const actual = await connection
					.getState()
					.then((state) => state.cwd)
					.catch(() => undefined);
				if (actual && !sameCwd(requestedCwd, actual)) {
					cwdMismatch = { requested: requestedCwd, actual };
				}
			}
			const sessionId = randomUUID();
			const entry: AcpSessionEntry = { id: sessionId, abort: undefined, unsubscribe: undefined };
			// Subscribe for the session lifetime, not per prompt turn: prime-agent
			// subagents are fire-and-forget and keep reporting after the spawning turn
			// ends, so a turn-scoped subscription would drop their updates. One
			// mapping state per session keeps streaming bash output correlated with
			// the run that produced it.
			const mappingState: AcpEventMappingState = {};
			const unsubscribe = connection.subscribe((event) => {
				const notify = (update: Record<string, unknown>) =>
					void ctx.client.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => undefined);
				// Heartbeats and cron schedules are connection-level rather than
				// session events, but they drive the long-running work an ACP client
				// most needs to observe.
				if (event.type === "heartbeats_changed") {
					notify({ sessionUpdate: "session_info_update", _meta: primeAgentMeta({ heartbeatsChanged: true }) });
					return;
				}
				if (event.type !== "session_event") return;
				for (const update of acpUpdatesForSessionEvent(event.event, mappingState)) {
					notify(update);
				}
			});
			// Claim the single-session slot only once the subscription exists, so a
			// failed subscribe cannot leave the slot occupied and unusable.
			entry.unsubscribe = unsubscribe;
			session = entry;
			return {
				sessionId,
				...(cwdMismatch ? { _meta: primeAgentMeta({ cwd: cwdMismatch }) } : {}),
			};
		})
		.onRequest("session/prompt", async (ctx: any) => {
			const params = ctx.params as { sessionId: string; prompt: readonly unknown[] };
			const entry = session?.id === params.sessionId ? session : undefined;
			if (!entry) throw new Error(`Unknown ACP session: ${params.sessionId}`);

			// ACP allows one turn at a time per session. Refuse a concurrent prompt
			// rather than overwriting the running turn's controller, which would make
			// the live turn uncancellable and let the loser's cleanup clear it.
			if (entry.abort) {
				throw new Error("A prompt turn is already running for this ACP session");
			}
			const abort = new AbortController();
			entry.abort = abort;

			try {
				const { text, images } = promptContent(params.prompt);
				// Only this turn's messages may decide its outcome, and compaction can
				// rebuild the transcript mid-turn, so record the pre-turn messages
				// themselves rather than how many there were.
				const priorMessages = turnBoundary(await connection.getMessages());
				await connection.promptAndWait(text, images.length > 0 ? { images } : undefined);
				// Autonomous gates continue inside this same prompt turn: the turn is
				// only over once the gate loop settles.
				const status = await connection.waitForHeadlessCompletion();
				const meta = autonomousMeta(status);
				if (meta) {
					await ctx.client
						.notify(acp.methods.client.session.update, {
							sessionId: params.sessionId,
							update: { sessionUpdate: "session_info_update", _meta: meta },
						})
						.catch(() => undefined);
				}
				// A turn that failed (provider error, auth, no usable model) must not be
				// reported as a clean end_turn. Print mode surfaces
				// `stopReason: "error"` with its errorMessage; ACP previously dropped
				// that and answered end_turn with no updates at all, which reads to a
				// client as a successful but empty turn.
				const failure = await turnFailure(connection, priorMessages);
				if (failure && !abort.signal.aborted) {
					throw new Error(`prime-agent turn failed: ${failure}`);
				}
				return { stopReason: acpStopReason({ cancelled: abort.signal.aborted, autonomous: status }) };
			} catch (error) {
				// Cancellation is a normal ACP prompt outcome, not a JSON-RPC error.
				if (abort.signal.aborted) return { stopReason: "cancelled" satisfies AcpStopReason };
				throw error;
			} finally {
				// Only clear our own controller: a later turn must not be cleared by
				// an earlier one unwinding.
				if (entry.abort === abort) entry.abort = undefined;
			}
		})
		.onRequest("session/close", async (ctx: any) => {
			// Releasing the subscription matters: it is the only thing that stops
			// forwarding events, and closing frees the connection for a new session.
			const params = ctx.params as { sessionId: string };
			if (session?.id !== params.sessionId) {
				throw new Error(`Unknown ACP session: ${params.sessionId}`);
			}
			// Stop real work, not just local bookkeeping: aborting only the local
			// controller leaves the agent running with nobody listening, so closing
			// must abort the connection the same way session/cancel does.
			const closing = session;
			session = undefined;
			closing.unsubscribe?.();
			if (closing.abort) {
				closing.abort.abort();
				await connection.abort().catch(() => undefined);
			}
			return {};
		})
		.onNotification("session/cancel", async (ctx: any) => {
			const params = ctx.params as { sessionId: string };
			// Only cancel the addressed session: aborting unconditionally would kill
			// whichever turn happens to be running, and leave the real turn's
			// AbortController unmarked so it reports a wrong stop reason.
			if (session?.id !== params.sessionId || !session.abort) return;
			session.abort.abort();
			await connection.abort().catch(() => undefined);
		})
		.connect(stream);

	// Exit when the client disconnects (stdin EOF or a closed transport). Blocking
	// forever would leave an orphaned agent per run, which matters most for a
	// harness that spawns many short-lived sessions.
	await handle.closed.catch(() => undefined);
	session?.abort?.abort();
	session?.unsubscribe?.();
	session = undefined;
	await connection.dispose().catch(() => undefined);
	// Only the real stdio entrypoint owns the process; a caller-supplied transport
	// (tests, embedding) must never have its host exited from under it.
	if (options.stream) return undefined as never;
	return process.exit(0) as never;
}
