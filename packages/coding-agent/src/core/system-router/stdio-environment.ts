import type { ChildProcess } from "node:child_process";
import { signalProcessGroupIfHeld, signalProcessGroupOrProcess, spawnHidden } from "../../utils/child-process.js";
import { killOrphanProcess } from "../orphan-process-journal.js";
import {
	isRecord,
	type RouterCloseOptions,
	type RouterEnvironment,
	type RouterExecution,
	type RouterObservation,
} from "./types.js";

/**
 * JSON-lines adapter protocol (the documented environment boundary):
 * request  {"id": <n>, "type": "init"|"reset"|"observe"|"execute"|"close", ...payload}
 * response {"id": <n>, "ok": true, ...result} | {"id": <n>, "ok": false, "error": "<message>"}
 * One JSON object per line on stdin, one per line on stdout. Adapters may be
 * any program that speaks it; the node-mgba GBA adapter
 * (examples/system-router-gba) is one such program.
 */

interface PendingRequest {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

/** A reply line longer than this is a protocol violation, not a message to buffer. */
const MAX_REPLY_LINE_CHARS = 1_000_000;

export class StdioRouterEnvironment implements RouterEnvironment {
	private child: ChildProcess | undefined;
	private nextId = 0;
	private readonly pending = new Map<number, PendingRequest>();
	private stderrTail = "";
	private closed = false;

	constructor(
		private readonly options: {
			command: string[];
			cwd?: string;
			requestTimeoutMs: number;
			init?: unknown;
		},
	) {}

	private ensureChild(): ChildProcess {
		if (this.child) return this.child;
		const [command, ...args] = this.options.command;
		const child = spawnHidden(command, args, {
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group on POSIX: forced cleanup can signal a launcher's
			// (`sh -c ...`, docker wrapper) descendants, not only the direct child.
			...(process.platform === "win32" ? {} : { detached: true }),
			// Adapter commands such as `docker run` need the environment they were given.
		});
		this.child = child;
		// An EPIPE while writing (the adapter died mid-request or closed its
		// stdin) must fail the pending requests, not crash the host as an
		// unhandled stream "error" event.
		child.stdin?.on("error", (error: Error) => {
			this.failAll(new Error(`environment adapter stdin failed: ${error.message}`));
		});
		let buffer = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const rawLine = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const line = rawLine.trim();
				if (rawLine.length > MAX_REPLY_LINE_CHARS) {
					// A terminated oversized line is the same protocol violation as an
					// unterminated one; reject it before parsing can allocate.
					const overflow = `environment adapter wrote a reply line over ${MAX_REPLY_LINE_CHARS} chars`;
					this.appendKernelAdapterDiagnostic(overflow);
					this.failAll(new Error(overflow));
				} else if (line) {
					this.dispatchLine(line);
				}
				newline = buffer.indexOf("\n");
			}
			// An unterminated line is buffered until its newline arrives; a
			// protocol-violating line that never ends must not grow without bound.
			if (buffer.length > MAX_REPLY_LINE_CHARS) {
				const overflow = `environment adapter wrote an unterminated reply line over ${MAX_REPLY_LINE_CHARS} chars`;
				buffer = "";
				this.appendKernelAdapterDiagnostic(overflow);
				this.failAll(new Error(overflow));
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000);
		});
		child.on("error", (error) => {
			this.failAll(new Error(`environment adapter failed to start: ${error.message}`));
		});
		// "close", not "exit": the exit event can fire while stdout data from the
		// adapter's final reply is still in flight; failing on close guarantees
		// every reply line is dispatched (and the stderr tail captured) first.
		child.on("close", (code) => {
			if (!this.closed) {
				this.failAll(
					new Error(`environment adapter exited early (code ${code ?? "null"}): ${this.stderrTail.trim()}`),
				);
			}
		});
		return child;
	}

	private dispatchLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const record = parsed as Record<string, unknown>;
		const id = typeof record.id === "number" ? record.id : undefined;
		const pending = id !== undefined ? this.pending.get(id) : undefined;
		if (id === undefined || !pending) return;
		this.pending.delete(id);
		if (record.ok === true) {
			pending.resolve(record);
		} else {
			const detail = typeof record.error === "string" ? record.error.slice(0, 2_000) : "adapter error";
			pending.reject(new Error(detail));
		}
	}

	private failAll(error: Error): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const request of pending) request.reject(error);
	}

	/** Keep a bounded tail of protocol violations alongside the stderr tail. */
	private appendKernelAdapterDiagnostic(message: string): void {
		this.stderrTail = `${this.stderrTail}\n${message}`.slice(-2_000);
	}

	private async request(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const child = this.ensureChild();
		if (child.stdin === null) throw new Error("environment adapter stdin is not a pipe");
		const id = this.nextId;
		this.nextId += 1;
		const request = { id, type, ...payload };
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const line = `${JSON.stringify(request)}\n`;
			child.stdin?.write(line, (error) => {
				if (error) {
					this.pending.delete(id);
					reject(new Error(`failed writing to the environment adapter: ${error.message}`));
				}
			});
		});
		// The losing side of the timeout race keeps a handler, so a late adapter
		// reply or rejection can never surface as an unhandled rejection.
		const timeout = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`environment adapter ${type} timed out after ${this.options.requestTimeoutMs}ms`));
			}, this.options.requestTimeoutMs);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
		});
		void timeout.catch(() => {});
		try {
			return await Promise.race([response, timeout]);
		} finally {
			// The response promise is handled here or by the race; a late resolution is a no-op.
			void response.catch(() => {});
		}
	}

	/** Initialize the adapter and merge its default action space, if it supplies one. */
	async init(): Promise<Record<string, unknown> | undefined> {
		// Only an omitted init payload is absent; a provided falsy one (false,
		// 0, "", null) is the caller's value and must reach the adapter.
		const reply = await this.request("init", this.options.init !== undefined ? { init: this.options.init } : {});
		return reply.environment as Record<string, unknown> | undefined;
	}

	async reset(goal: string): Promise<void> {
		await this.request("reset", { goal });
	}

	async observe(): Promise<RouterObservation> {
		const reply = await this.request("observe");
		const observation = reply.observation;
		if (!isRecord(observation) || typeof observation.text !== "string") {
			throw new Error("environment adapter observe must reply with {ok: true, observation: {text: string}}");
		}
		const record: Record<string, unknown> = observation;
		const observationOut: RouterObservation = { text: record.text as string };
		if (typeof record.fields === "object" && record.fields !== null) {
			observationOut.fields = record.fields as RouterObservation["fields"];
		}
		if (typeof record.image === "string" && record.image) {
			observationOut.image = record.image;
		}
		if (record.terminal === true) observationOut.terminal = true;
		return observationOut;
	}

	async execute(action: string, params: Record<string, string>): Promise<RouterExecution> {
		const reply = await this.request("execute", { action, params });
		if (typeof reply.text !== "string") {
			throw new Error("environment adapter execute must reply with {ok: true, text: string}");
		}
		return { text: reply.text, ...(reply.terminal === true ? { terminal: true } : {}) };
	}

	/**
	 * Stop the adapter. `budgetMs` bounds the graceful waits (SIGTERM, then
	 * SIGKILL, always dispatched) so cleanup cannot extend a timed-out
	 * segment past its wall-clock budget; the default waits up to 2.5s.
	 * Idempotent: the segment runner closes on every path after the loop has
	 * already closed, and a second close must not repeat the shutdown (an
	 * extra close request, another SIGTERM budget, re-ending stdin) after a
	 * timeout already dispatched SIGKILL without waiting for the reap.
	 */
	async close(options: RouterCloseOptions = {}): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const child = this.child;
		if (!child) return;
		if (child.exitCode !== null || child.signalCode !== null) {
			// The adapter already exited; its exit event was handled at exit time.
			this.failAll(new Error("environment adapter closed"));
			// A group can outlive its leader: a launcher that exited with its
			// descendants still running (e.g. a container) gets the relayed stop
			// while the exited leader anchors the pgid against reuse.
			if (child.pid !== undefined) signalProcessGroupIfHeld(child.pid, "SIGTERM");
			return;
		}
		const budgetEndsAt =
			Date.now() + (options.budgetMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.budgetMs));
		// Half the budget is reserved for the SIGTERM wait: an adapter that
		// ignores the close request but forwards SIGTERM (docker run) still
		// gets its stop relayed before the SIGKILL. Large budgets are unaffected.
		const sigtermReserveMs = Math.min(1_000, Math.floor(Math.max(0, options.budgetMs ?? 0) / 2));
		const remainingBudget = (waitMs: number, reserveMs = 0) =>
			Math.min(waitMs, Math.max(0, budgetEndsAt - Date.now() - reserveMs));
		// Ask the adapter to exit, then enforce a bounded shutdown.
		child.stdin?.end(`${JSON.stringify({ id: this.nextId, type: "close" })}\n`);
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		await Promise.race([
			exited,
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => resolve(), remainingBudget(1_500, sigtermReserveMs));
				if (typeof timer === "object" && "unref" in timer) timer.unref();
			}),
		]);
		if (child.exitCode === null && child.signalCode === null) {
			// SIGTERM first: for a container-wrapped adapter (docker run), a
			// SIGKILL would hit only the client process and leak the container;
			// a forwardable SIGTERM lets the container stop and --rm reap it.
			// The whole process group is signaled so a launcher's descendants
			// (the docker wrapper case) cannot outlive the shutdown.
			const pid = child.pid;
			if (pid) {
				if (process.platform === "win32") {
					// Windows has no signalable process groups; the hardened
					// System32 taskkill /T tree kill takes the launcher's
					// descendants down, bounded by the remaining budget.
					killOrphanProcess(pid, remainingBudget(10_000));
				} else {
					signalProcessGroupOrProcess(pid, "SIGTERM");
					const terminated = new Promise<void>((resolve) => {
						child.once("exit", () => resolve());
					});
					await Promise.race([
						terminated,
						new Promise<void>((resolve) => {
							const timer = setTimeout(() => resolve(), remainingBudget(1_000));
							if (typeof timer === "object" && "unref" in timer) timer.unref();
						}),
					]);
					if (child.exitCode === null && child.signalCode === null) {
						signalProcessGroupOrProcess(pid, "SIGKILL");
					} else {
						// The leader exited from the relayed SIGTERM: descendants that
						// ignored it still get the enforced kill while the leader's
						// zombie anchors the pgid against reuse.
						signalProcessGroupIfHeld(pid, "SIGKILL");
					}
				}
			}
		} else if (child.pid !== undefined) {
			// The leader exited during the graceful close wait (it answered the
			// close request, or crashed first): its group can still hold
			// descendants (a launcher's child), so relay the stop while the
			// exited leader anchors the pgid against reuse.
			signalProcessGroupIfHeld(child.pid, "SIGTERM");
		}
		this.failAll(new Error("environment adapter closed"));
	}
}
