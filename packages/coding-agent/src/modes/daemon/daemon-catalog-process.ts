import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { deleteSessionFile } from "../../core/session-file-actions.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../../core/session-manager.js";

export const DAEMON_CATALOG_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_CATALOG";

interface SessionInfoWire extends Omit<SessionInfo, "created" | "modified"> {
	created: string;
	modified: string;
}

type CatalogRequest =
	| { type: "request"; id: string; command: "list"; cwd?: string; sessionDir?: string }
	| { type: "request"; id: string; command: "resolve"; selector: string; cwd: string; sessionDir?: string }
	| { type: "request"; id: string; command: "rename"; sessionPath: string; name: string }
	| { type: "request"; id: string; command: "delete"; sessionPath: string }
	| { type: "request"; id: string; command: "archive"; sessionPath: string; sessionId: string }
	| {
			type: "request";
			id: string;
			command: "mark_interrupted";
			sessionPath: string;
			activeSessionId: string;
			operations: string[];
	  }
	| { type: "request"; id: string; command: "shutdown" };

type CatalogOutbound =
	| { type: "ready" }
	| { type: "progress"; id: string; loaded: number; total: number }
	| { type: "session"; id: string; session: SessionInfoWire }
	| { type: "response"; id: string; success: true; data?: unknown }
	| { type: "response"; id: string; success: false; error: string };

interface CatalogListCallbacks {
	onProgress?: (loaded: number, total: number) => void;
	onSession?: (session: SessionInfo) => void;
}

function serializeSessionInfo(session: SessionInfo): SessionInfoWire {
	return {
		...session,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
	};
}

function deserializeSessionInfo(session: SessionInfoWire): SessionInfo {
	return {
		...session,
		created: new Date(session.created),
		modified: new Date(session.modified),
	};
}

/** @internal Exported to pin catalog selector semantics without spawning a catalog process. */
export function resolveCatalogSessionMatch(
	sessions: readonly SessionInfo[],
	selector: string,
): SessionInfo | undefined {
	// Deliberate broadening for create/resume as well as a2a wake: exact names
	// participate alongside id prefixes. Therefore a name that collides with an
	// id prefix is now ambiguous instead of the id-prefix match winning.
	const matches = sessions.filter((session) => session.id.startsWith(selector) || session.name === selector);
	if (matches.length > 1) {
		throw new Error(`Ambiguous session selector "${selector}"`);
	}
	return matches[0];
}

function isCatalogOutbound(value: unknown): value is CatalogOutbound {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown };
	return (
		candidate.type === "ready" ||
		((candidate.type === "progress" || candidate.type === "session" || candidate.type === "response") &&
			typeof candidate.id === "string")
	);
}

function isCatalogRequest(value: unknown): value is CatalogRequest {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown; command?: unknown };
	return (
		candidate.type === "request" &&
		typeof candidate.id === "string" &&
		(candidate.command === "list" ||
			candidate.command === "resolve" ||
			candidate.command === "rename" ||
			candidate.command === "delete" ||
			candidate.command === "archive" ||
			candidate.command === "mark_interrupted" ||
			candidate.command === "shutdown")
	);
}

function sendCatalogMessage(message: CatalogOutbound): void {
	if (process.send) {
		process.send(message);
	}
}

export function isDaemonCatalogProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_CATALOG_ROLE_ENV] === "1";
}

export async function runDaemonCatalogProcess(): Promise<never> {
	process.on("disconnect", () => process.exit(0));
	process.on("message", (value: unknown) => {
		if (!isCatalogRequest(value)) {
			return;
		}
		void handleCatalogRequest(value);
	});
	sendCatalogMessage({ type: "ready" });
	return new Promise(() => {});
}

async function handleCatalogRequest(request: CatalogRequest): Promise<void> {
	try {
		switch (request.command) {
			case "list": {
				const callbacks = {
					onProgress: (loaded: number, total: number) =>
						sendCatalogMessage({ type: "progress", id: request.id, loaded, total }),
					onSession: (session: SessionInfo) =>
						sendCatalogMessage({ type: "session", id: request.id, session: serializeSessionInfo(session) }),
				};
				const sessions = request.cwd
					? await SessionManager.list(request.cwd, request.sessionDir, callbacks)
					: await SessionManager.listAll(callbacks, request.sessionDir);
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: sessions.map(serializeSessionInfo) },
				});
				return;
			}
			case "resolve": {
				const localMatch = resolveCatalogSessionMatch(
					await SessionManager.list(request.cwd, request.sessionDir),
					request.selector,
				);
				if (localMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: localMatch.path },
					});
					return;
				}
				const globalMatch = resolveCatalogSessionMatch(
					await SessionManager.listAll(undefined, request.sessionDir),
					request.selector,
				);
				if (globalMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: globalMatch.path },
					});
					return;
				}
				throw new Error(`No session found matching '${request.selector}'`);
			}
			case "rename":
				SessionManager.open(request.sessionPath).appendSessionInfo(request.name.trim());
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			case "delete":
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: await deleteSessionFile(request.sessionPath),
				});
				return;
			case "archive": {
				const session = await readSessionInfo(request.sessionPath);
				if (!session || session.id !== request.sessionId) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { archived: false },
					});
					return;
				}
				if (session.state?.status !== "archived") {
					SessionManager.open(request.sessionPath).appendSessionState({ status: "archived" });
				}
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { archived: true },
				});
				return;
			}
			case "mark_interrupted":
				SessionManager.open(request.sessionPath).appendCustomMessageEntry(
					"prime-agent.worker_recovery",
					"<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>",
					false,
					{
						activeSessionId: request.activeSessionId,
						operations: request.operations,
					},
				);
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			case "shutdown":
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				setImmediate(() => process.exit(0));
				return;
		}
	} catch (error) {
		sendCatalogMessage({
			type: "response",
			id: request.id,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export class DaemonCatalogClient {
	private child?: ChildProcess;
	private starting?: Promise<void>;
	private readonly pending = new Map<
		string,
		{
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			callbacks?: CatalogListCallbacks;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(private readonly onDiagnostic: (message: string) => void) {}

	async start(): Promise<void> {
		if (this.child?.connected) {
			return;
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = this.spawnCatalog().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async list(cwd?: string, sessionDir?: string, callbacks?: CatalogListCallbacks): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>(
			{ type: "request", id: randomUUID(), command: "list", cwd, sessionDir },
			callbacks,
		);
		return data.sessions.map(deserializeSessionInfo);
	}

	async rename(sessionPath: string, name: string): Promise<void> {
		await this.request({ type: "request", id: randomUUID(), command: "rename", sessionPath, name });
	}

	async resolve(selector: string, cwd: string, sessionDir?: string): Promise<string> {
		const data = await this.request<{ sessionPath: string }>({
			type: "request",
			id: randomUUID(),
			command: "resolve",
			selector,
			cwd,
			sessionDir,
		});
		return data.sessionPath;
	}

	delete(sessionPath: string): Promise<DeleteSessionFileResult> {
		return this.request({ type: "request", id: randomUUID(), command: "delete", sessionPath });
	}

	async archive(sessionPath: string, sessionId: string): Promise<boolean> {
		const data = await this.request<{ archived: boolean }>({
			type: "request",
			id: randomUUID(),
			command: "archive",
			sessionPath,
			sessionId,
		});
		return data.archived;
	}

	async markInterrupted(sessionPath: string, activeSessionId: string, operations: string[]): Promise<void> {
		await this.request({
			type: "request",
			id: randomUUID(),
			command: "mark_interrupted",
			sessionPath,
			activeSessionId,
			operations,
		});
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}
		await this.request({ type: "request", id: randomUUID(), command: "shutdown" }).catch(() => undefined);
		child.disconnect();
		this.child = undefined;
	}

	private async spawnCatalog(): Promise<void> {
		const launch = createCliSubprocessLaunchSpec(["--version"]);
		const child = spawn(launch.command, launch.args, {
			cwd: process.cwd(),
			env: createCliSubprocessEnv({ ...process.env, [DAEMON_CATALOG_ROLE_ENV]: "1" }),
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		this.child = child;
		child.on("message", (value: unknown) => this.handleMessage(value));
		child.on("error", (error) => this.handleClose(child, error));
		child.on("exit", (code, signal) =>
			this.handleClose(child, new Error(`Daemon catalog exited (${signal ?? code ?? "unknown"})`)),
		);
		await new Promise<void>((resolveReady, rejectReady) => {
			const timeout = setTimeout(() => {
				cleanup();
				const error = new Error("Timed out starting daemon catalog");
				this.handleClose(child, error);
				if (child.connected) {
					child.disconnect();
				}
				child.kill("SIGKILL");
				rejectReady(error);
			}, 5000);
			const cleanup = () => {
				clearTimeout(timeout);
				child.off("message", onMessage);
				child.off("error", onError);
			};
			const onMessage = (value: unknown) => {
				if (isCatalogOutbound(value) && value.type === "ready") {
					cleanup();
					resolveReady();
				}
			};
			const onError = (error: Error) => {
				cleanup();
				rejectReady(error);
			};
			child.on("message", onMessage);
			child.once("error", onError);
		});
	}

	private async request<T = void>(request: CatalogRequest, callbacks?: CatalogListCallbacks): Promise<T> {
		await this.start();
		const child = this.child;
		if (!child?.connected) {
			throw new Error("Daemon catalog is not connected");
		}
		return new Promise<T>((resolveRequest, rejectRequest) => {
			const timeout = setTimeout(
				() => {
					if (!this.pending.delete(request.id)) {
						return;
					}
					child.kill("SIGKILL");
					rejectRequest(new Error(`Timed out waiting for daemon catalog ${request.command}`));
				},
				5 * 60 * 1000,
			);
			this.pending.set(request.id, {
				resolve: (data) => resolveRequest(data as T),
				reject: rejectRequest,
				callbacks,
				timeout,
			});
			child.send(request, (error) => {
				if (!error) {
					return;
				}
				const pending = this.pending.get(request.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pending.delete(request.id);
				}
				rejectRequest(error);
			});
		});
	}

	private handleMessage(value: unknown): void {
		if (!isCatalogOutbound(value) || value.type === "ready") {
			return;
		}
		const pending = this.pending.get(value.id);
		if (!pending) {
			return;
		}
		if (value.type === "progress") {
			pending.callbacks?.onProgress?.(value.loaded, value.total);
			return;
		}
		if (value.type === "session") {
			pending.callbacks?.onSession?.(deserializeSessionInfo(value.session));
			return;
		}
		this.pending.delete(value.id);
		clearTimeout(pending.timeout);
		if (value.success) {
			pending.resolve(value.data);
		} else {
			pending.reject(new Error(value.error));
		}
	}

	private handleClose(child: ChildProcess, error: Error): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		this.onDiagnostic(error.message);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}
