import { type McpDeclaration, previewMcpProbe } from "./mcp-declarations.js";

/** The probe never constructs a network client. Callers must inject a local test transport. */
export interface McpProbeTransport {
	open(request: McpProbeOpenRequest): Promise<McpProbeSession>;
}

export interface McpProbeOpenRequest {
	url: string;
	signal: AbortSignal;
}

export interface McpProbeSession {
	request(request: McpProbeRequest): Promise<unknown>;
	close(): Promise<void> | void;
}

export interface McpProbeRequest {
	method: "initialize" | "tools/list";
	params?: Record<string, unknown>;
	signal: AbortSignal;
}

export interface McpDeclarationProbeOptions {
	/** Explicit offline mode blocks before the injected transport is opened. */
	offline?: boolean;
	/** A project declaration must have passed the C05 trust boundary first. */
	trusted?: boolean;
	/** Total wall-clock budget for opening and protocol requests. */
	timeoutMs?: number;
	/** Receives a redacted failure when a timed-out open later needs cleanup. */
	onLateCleanupFailure?: (error: Error) => void;
}

export interface McpDeclarationProbeResult {
	initialized: true;
	toolsListed: true;
}

/** A bounded, offline declaration preview; it never opens a transport. */
export type McpDeclarationProbePreview = ReturnType<typeof previewMcpProbe>;

/** Returns a bounded, offline preview for an already-validated declaration. */
export function previewMcpDeclarationProbe(declaration: McpDeclaration): McpDeclarationProbePreview {
	return previewMcpProbe(declaration);
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;

function boundedTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value) || value <= 0) throw new Error("MCP probe timeout must be a positive finite number.");
	return Math.max(1, Math.min(Math.floor(value), MAX_TIMEOUT_MS));
}

function publicProbeError(kind: "disabled" | "offline" | "untrusted" | "timeout" | "failed"): Error {
	// Never expose endpoint, transport, or protocol error text: any of these can
	// carry an accidentally credential-bearing URL or response payload.
	if (kind === "disabled") return new Error("MCP probe is unavailable because this declaration is disabled.");
	if (kind === "offline") return new Error("MCP probe is unavailable while offline.");
	if (kind === "untrusted") return new Error("MCP probe is unavailable because this declaration is not trusted.");
	if (kind === "timeout") return new Error("MCP probe timed out.");
	return new Error("MCP probe failed.");
}

function withDeadline<T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(publicProbeError("timeout"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(promise)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Close with a fresh bounded signal: a failed operation must not strand its session. */
async function closeSession(session: McpProbeSession, timeoutMs: number): Promise<Error | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		await withDeadline(session.close(), controller.signal);
	} catch {
		return controller.signal.aborted ? publicProbeError("timeout") : publicProbeError("failed");
	} finally {
		clearTimeout(timer);
	}
	return undefined;
}

function reportLateCleanupFailure(options: McpDeclarationProbeOptions, error: Error): void {
	try {
		options.onLateCleanupFailure?.(error);
	} catch {
		// The probe has already completed. A diagnostic observer cannot revive it.
	}
}

/**
 * Executes the smallest possible read-only MCP handshake using an injected
 * transport. It has no SDK, fetch, auth, or endpoint implementation, and is
 * therefore usable only by an explicitly supplied local fake/adapter.
 */
export async function runMcpDeclarationProbe(
	declaration: McpDeclaration,
	transport: McpProbeTransport,
	options: McpDeclarationProbeOptions = {},
): Promise<McpDeclarationProbeResult> {
	// These guards intentionally precede *all* transport work.
	if (!declaration.enabled) throw publicProbeError("disabled");
	if (options.offline) throw publicProbeError("offline");
	if (options.trusted !== true) throw publicProbeError("untrusted");

	const timeoutMs = boundedTimeout(options.timeoutMs);
	const operationController = new AbortController();
	const operationTimer = setTimeout(() => operationController.abort(), timeoutMs);
	let opening: Promise<McpProbeSession> | undefined;
	let session: McpProbeSession | undefined;
	let failure: Error | undefined;
	try {
		// Keep the raw opening promise so a transport that resolves after our timeout
		// is still closed. Awaiting only a deadline wrapper would lose that session.
		// Deferring the call also sends synchronous adapter failures through redaction.
		opening = Promise.resolve().then(() =>
			transport.open({ url: declaration.url, signal: operationController.signal }),
		);
		session = await withDeadline(opening, operationController.signal);
		await withDeadline(
			session.request({
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "Prime Agent" },
				},
				signal: operationController.signal,
			}),
			operationController.signal,
		);
		await withDeadline(
			session.request({ method: "tools/list", signal: operationController.signal }),
			operationController.signal,
		);
	} catch (error) {
		operationController.abort();
		failure = error instanceof Error && error.message === "MCP probe timed out." ? error : publicProbeError("failed");
	} finally {
		clearTimeout(operationTimer);
		if (session) {
			const closeFailure = await closeSession(session, timeoutMs);
			if (!failure && closeFailure) failure = closeFailure;
		} else if (opening) {
			// A timeout can win while `open` is still pending. It is not safe to
			// abandon the eventual session, so arrange bounded, redacted cleanup.
			void opening.then(
				async (lateSession) => {
					const closeFailure = await closeSession(lateSession, timeoutMs);
					if (closeFailure) reportLateCleanupFailure(options, closeFailure);
				},
				() => undefined,
			);
		}
	}
	if (failure) throw failure;
	return { initialized: true, toolsListed: true };
}
