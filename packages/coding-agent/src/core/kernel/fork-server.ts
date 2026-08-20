// Node-side client for the Python kernel forkserver (see fork-server-script.ts).
// One forkserver process per (python, cwd, env) profile, spawned lazily and kept
// alive for the agent process. Each KernelManager asks it to fork a kernel onto a
// connection file instead of paying a full `python -m ipykernel_launcher` cold boot.
//
// Everything degrades to direct spawn: if the forkserver is disabled, unavailable,
// or a spawn request fails/times out, callers catch ForkServerUnavailable and fall
// back to the existing path, so correctness never depends on fork.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { recordOrphanProcessState } from "../orphan-process-journal.js";
import { FORK_SERVER_SCRIPT } from "./fork-server-script.js";

const READY_TIMEOUT_MS = 30_000;
const SPAWN_TIMEOUT_MS = 10_000;
const STDERR_TAIL_MAX = 4096;

// Vars the Python interpreter consumes at startup (before any user code runs), so
// they can't be honored post-fork via os.environ.update — the forked child inherits
// the template's already-initialized sys.path / site config. A kernel overriding any
// of these to a value the template didn't launch with must take the direct-spawn
// path. We treat the entire PYTHON* family as startup-affecting rather than
// enumerating individual vars: the set is large and version-dependent, and a false
// positive merely (safely) routes a kernel to direct spawn. Plus the non-PYTHON*
// startup vars that also steer interpreter/site resolution.
const INTERPRETER_STARTUP_ENV_EXACT = ["VIRTUAL_ENV", "CONDA_PREFIX", "__PYVENV_LAUNCHER__"];

function affectsInterpreterStartup(key: string): boolean {
	return key.startsWith("PYTHON") || INTERPRETER_STARTUP_ENV_EXACT.includes(key);
}

export class ForkServerUnavailable extends Error {
	/** True for a request timeout: the forkserver may just be stalled (e.g. mid-fork), not gone. */
	readonly timedOut: boolean;

	constructor(message: string, opts?: { timedOut?: boolean }) {
		super(message);
		this.name = "ForkServerUnavailable";
		this.timedOut = opts?.timedOut ?? false;
	}
}

// On by default on Linux (fork-without-exec is unsafe on macOS);
// PRIME_AGENT_KERNEL_FORKSERVER=0 opts out.
export function isForkServerEnabled(): boolean {
	if (process.platform !== "linux") return false;
	return process.env.PRIME_AGENT_KERNEL_FORKSERVER !== "0";
}

// A forkserver template is defined solely by the interpreter — the imported
// module graph doesn't depend on cwd/env. Those are per-kernel and applied in the
// forked child, so every kernel for a given python shares ONE template.
interface ForkServerParams {
	python: string;
	// Registry-history bound override (argv[2] to the script); tests only.
	historyBound?: number;
}

interface SpawnParams {
	connectionPath: string;
	cwd?: string;
	// Mirrors process.env shape; undefined values are dropped when JSON-serialized
	// to the child, matching how spawn() treats them on the direct path.
	env?: Record<string, string | undefined>;
}

export type ForkedKernelKillSignal = "TERM" | "KILL";
export type ForkedKernelKillOutcome = "signaled" | "already-exited" | "unknown-pid";

/**
 * Handle to a forkserver-forked kernel: signaling/liveness go through the
 * forkserver by fork request id, never process.kill (see the protocol header
 * in fork-server-script.ts). `pid` exists for journal writes only.
 */
export interface ForkedKernelHandle {
	readonly pid: number;
	kill(signal: ForkedKernelKillSignal): Promise<ForkedKernelKillOutcome>;
	isAlive(): Promise<boolean>;
}

interface ForkServerReply {
	id: number;
	pid?: number;
	error?: string;
	outcome?: string;
	alive?: boolean;
}

type PendingRequest = {
	resolve: (msg: ForkServerReply) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

// Exported for protocol-level tests (which construct it directly, bypassing the
// isForkServerEnabled platform gate); production entry stays forkKernel().
export class ForkServer {
	private readonly params: ForkServerParams;
	// The env the template process was launched with, snapshotted at construction so
	// it exactly matches what the template's interpreter imported with. The
	// startup-env guard compares against THIS, not live process.env, so a later
	// mutation of process.env can't make a stale template look compatible.
	private readonly launchEnv: NodeJS.ProcessEnv;
	private proc?: ChildProcess;
	private server?: Server;
	private conn?: Socket;
	private socketDir?: string;
	private readyPromise?: Promise<void>;
	private failReady?: (err: Error) => void;
	private buffer = "";
	// Rolling tail of forkserver stderr. Forked children inherit this fd, so a
	// child's import/startup traceback lands here; surfaced in error messages.
	private stderrTail = "";
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	// Request ids whose caller timed out; a late pid reply for one is an orphan to kill.
	private readonly abandoned = new Set<number>();
	private dead = false;

	constructor(params: ForkServerParams) {
		this.params = params;
		// Snapshot now and launch the template with this same object, so the guard's
		// comparison uses exactly the env the interpreter imported with.
		this.launchEnv = { ...process.env };
	}

	get isDead(): boolean {
		return this.dead;
	}

	/**
	 * True if `env` overrides an interpreter-startup var to a value the template
	 * didn't launch with — such a kernel can't be forked (sys.path is baked in at
	 * import), so the caller must direct-spawn it.
	 */
	needsStartupEnvNotInTemplate(env: SpawnParams["env"]): boolean {
		if (!env) return false;
		return Object.keys(env).some((k) => affectsInterpreterStartup(k) && env[k] !== this.launchEnv[k]);
	}

	private async ensureReady(): Promise<void> {
		if (this.dead) throw new ForkServerUnavailable("forkserver is dead");
		if (!this.readyPromise) {
			this.readyPromise = this.start().catch((err) => {
				this.markDead();
				throw err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err));
			});
		}
		return this.readyPromise;
	}

	private start(): Promise<void> {
		this.socketDir = mkdtempSync(join(tmpdir(), "prime-agent-forkserver-"));
		const socketPath = join(this.socketDir, "control.sock");

		return new Promise<void>((resolve, reject) => {
			const server = createServer();
			this.server = server;

			let settled = false;
			const readyTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ForkServerUnavailable(`forkserver did not become ready within ${READY_TIMEOUT_MS}ms`));
			}, READY_TIMEOUT_MS);

			// Lets markDead() fail a still-pending start (interpreter crashed / socket
			// closed before "ready") instead of waiting out the full ready timeout.
			this.failReady = (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				reject(err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err)));
			};

			server.on("connection", (socket) => {
				this.conn = socket;
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("close", () => this.markDead());
				socket.on("error", () => this.markDead());
			});

			server.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				reject(new ForkServerUnavailable(`forkserver control socket failed: ${err.message}`));
			});

			// Buffered until the "ready" line; flip the promise from there.
			this.onReady = () => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				resolve();
			};

			server.listen(socketPath, () => {
				// The template only imports; its own cwd/env are irrelevant since each
				// forked child applies the per-kernel cwd/env itself. Inherit the daemon's.
				const args = ["-c", FORK_SERVER_SCRIPT, socketPath];
				if (this.params.historyBound !== undefined) args.push(String(this.params.historyBound));
				const proc = spawn(this.params.python, args, {
					env: this.launchEnv,
					stdio: ["ignore", "ignore", "pipe"],
				});
				this.proc = proc;
				if (proc.pid !== undefined) recordOrphanProcessState(proc.pid, true);
				proc.stderr?.on("data", (buf: Buffer) => {
					this.stderrTail = `${this.stderrTail}${buf.toString()}`.slice(-STDERR_TAIL_MAX);
				});
				proc.on("error", () => this.markDead());
				proc.on("exit", () => this.markDead());
			});
		});
	}

	private onReady: () => void = () => {};

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (let idx = this.buffer.indexOf("\n"); idx !== -1; idx = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg: ForkServerReply & { type?: string };
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.type === "ready") {
				this.onReady();
				continue;
			}
			if (typeof msg.id !== "number") continue;
			const p = this.pending.get(msg.id);
			if (!p) {
				// A fork the caller already abandoned (timed out): nobody owns it,
				// so have the forkserver kill it.
				if (this.abandoned.delete(msg.id) && typeof msg.pid === "number") {
					void this.killChild(msg.id, "TERM").catch(() => {});
				}
				continue;
			}
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			p.resolve(msg);
		}
	}

	private request(payload: Record<string, unknown>, opts?: { abandonOnTimeout?: boolean }): Promise<ForkServerReply> {
		if (this.dead || !this.conn) {
			return Promise.reject(new ForkServerUnavailable("forkserver connection unavailable"));
		}
		const id = this.nextId++;
		return new Promise<ForkServerReply>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				// A spawn may still land after we give up; remember the id so its late
				// pid reply gets the orphan killed instead of leaked.
				if (opts?.abandonOnTimeout) this.abandoned.add(id);
				reject(
					new ForkServerUnavailable(`forkserver request timed out after ${SPAWN_TIMEOUT_MS}ms`, {
						timedOut: true,
					}),
				);
			}, SPAWN_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.conn?.write(`${JSON.stringify({ id, ...payload })}\n`);
		});
	}

	async spawnKernel(spawn: SpawnParams): Promise<ForkedKernelHandle> {
		await this.ensureReady();
		const msg = await this.request(
			{ connectionPath: spawn.connectionPath, cwd: spawn.cwd, env: spawn.env },
			{ abandonOnTimeout: true },
		);
		if (typeof msg.pid !== "number") {
			throw new ForkServerUnavailable(this.withStderr(msg.error ?? "forkserver fork failed"));
		}
		const pid = msg.pid;
		const forkId = msg.id;
		return {
			pid,
			kill: (signal) => this.killChild(forkId, signal),
			isAlive: () => this.isChildAlive(forkId),
		};
	}

	async killChild(forkId: number, signal: ForkedKernelKillSignal): Promise<ForkedKernelKillOutcome> {
		const msg = await this.request({ kill: forkId, signal });
		const outcome = msg.outcome;
		if (outcome === "signaled" || outcome === "already-exited" || outcome === "unknown-pid") {
			return outcome;
		}
		throw new ForkServerUnavailable(`forkserver kill reply malformed: ${JSON.stringify(msg)}`);
	}

	async isChildAlive(forkId: number): Promise<boolean> {
		const msg = await this.request({ alive: forkId });
		return msg.alive === true;
	}

	private withStderr(message: string): string {
		const tail = this.stderrTail.trim();
		return tail ? `${message}\nforkserver stderr:\n${tail}` : message;
	}

	/** Reject any in-flight ensureReady/spawnKernel callers so none wait out a timeout. */
	private rejectPending(reason: string): void {
		this.failReady?.(new ForkServerUnavailable(reason));
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new ForkServerUnavailable(reason));
		}
		this.pending.clear();
	}

	private markDead(): void {
		this.dispose(this.withStderr("forkserver died"));
	}

	dispose(reason = "forkserver disposed"): void {
		if (this.dead) return;
		// Flip `dead` at entry so the close/exit events our own teardown triggers
		// don't re-enter. Pending callers are rejected directly here (not deferred to
		// those events), so this early flag flip can't strand them on a timeout.
		this.dead = true;
		this.rejectPending(reason);
		// Best-effort teardown: each resource may already be gone.
		try {
			this.conn?.destroy();
		} catch {
			// Already destroyed.
		}
		try {
			this.server?.close();
		} catch {
			// Already closed.
		}
		const proc = this.proc;
		if (proc) {
			// Inactive only when the pid is soundly ours at write time (handle saw the
			// exit, or handle-based kill delivered); otherwise leave the record active.
			const observedExit = proc.exitCode !== null || proc.signalCode !== null;
			let delivered = false;
			try {
				delivered = proc.kill("SIGTERM");
			} catch {
				// Already exited.
			}
			if (proc.pid !== undefined && (observedExit || delivered)) recordOrphanProcessState(proc.pid, false);
		}
		if (this.socketDir) {
			try {
				rmSync(this.socketDir, { recursive: true, force: true });
			} catch {
				// Leave the socket dir for OS tmp cleanup.
			}
			this.socketDir = undefined;
		}
	}
}

// Keyed by interpreter only: cwd/env are per-kernel (applied in the child), so all
// kernels for a given python share ONE warm template.
const servers = new Map<string, ForkServer>();
let cleanupRegistered = false;

function keyFor(params: ForkServerParams): string {
	return params.python;
}

function registerForkServerCleanupOnce(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	// A forkserver is process-lived and shared across sessions, so per-session
	// cleanup must not yank the warm template from other live sessions — only a full
	// process shutdown (no sessionId) disposes it here.
	registerSessionResourceCleanup((sessionId) => {
		if (!sessionId) disposeAllForkServers();
	});
	// cleanupSessionResources(undefined) is never called on exit, so also tear the
	// forkserver down directly on process teardown or it leaks as an orphan.
	process.once("exit", disposeAllForkServers);
	for (const signal of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
		process.once(signal, () => disposeAllForkServers());
	}
}

/**
 * Fork a kernel onto `spawn.connectionPath` from the shared template for this
 * interpreter, applying `spawn.cwd`/`spawn.env` in the forked child. Throws
 * ForkServerUnavailable if forking is disabled or fails — callers fall back to
 * direct spawn. Returns a handle whose kill/liveness go through the forkserver.
 */
export async function forkKernel(python: string, spawn: SpawnParams): Promise<ForkedKernelHandle> {
	if (!isForkServerEnabled()) throw new ForkServerUnavailable("forkserver disabled");
	registerForkServerCleanupOnce();
	const key = keyFor({ python });
	let server = servers.get(key);
	if (!server || server.isDead) {
		server = new ForkServer({ python });
		servers.set(key, server);
	}
	// Compare against the template's own launch env (not live process.env): a kernel
	// overriding an interpreter-startup var to a value the template didn't import
	// with can't be forked — defer to direct spawn rather than boot with wrong sys.path.
	if (server.needsStartupEnvNotInTemplate(spawn.env)) {
		throw new ForkServerUnavailable("kernel overrides interpreter-startup env; using direct spawn");
	}
	try {
		return await server.spawnKernel(spawn);
	} catch (err) {
		// Only evict if the map still points at this dead instance: a concurrent
		// caller may have already replaced it with a fresh live server under this key.
		if (server.isDead && servers.get(key) === server) servers.delete(key);
		throw err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err));
	}
}

export function disposeAllForkServers(): void {
	for (const server of servers.values()) server.dispose();
	servers.clear();
}
