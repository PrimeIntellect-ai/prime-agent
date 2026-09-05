/**
 * Prime Tunnel lifecycle manager.
 *
 * Manages a `prime tunnel start` subprocess.  Parses startup output
 * incrementally, validates and redacts credentials immediately,
 * returns a catalog-safe TunnelDescriptor plus a one-time TunnelGrant
 * via consumeGrant().  Handles abort, timeout, unexpected-exit,
 * and cleanup with bounded TERM-KILL and exact-ID fallback.
 *
 * Auth (http_user + http_password) never appears in:
 *   URL strings, frames, journals, events, catalog DTOs, argv
 *   (password is output-only), or error text.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { execCommand } from "./exec.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LINE_COUNT = 200;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_LABEL_COUNT = 10;
const MAX_LABEL_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const MAX_TEAM_ID_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 256;
const TERM_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 50;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const MAX_START_TIMEOUT_MS = 600_000;
const CLEANUP_WAIT_MS = 500;

const TUNNEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const SAFE_TEXT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/;
const SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/;
const HTTP_USER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Injectable nonblocking managed-process interface
// ---------------------------------------------------------------------------

export interface ManagedProcess {
	readonly pid: number | undefined;
	readonly running: boolean;

	spawn(argv: string[], options?: { signal?: AbortSignal }): void;
	readLine(): string | null;
	kill(signal?: "SIGTERM" | "SIGKILL"): void;
	wait(): Promise<{ code: number; signal: string | null }>;
}

// ---------------------------------------------------------------------------
// Real subprocess ManagedProcess
// ---------------------------------------------------------------------------

export class RealSubprocessProcess implements ManagedProcess {
	private _proc: ChildProcess | null = null;
	private _exitPromise: Promise<{
		code: number;
		signal: string | null;
	}> | null = null;
	private _lineBuffer: string[] = [];
	private _running = false;
	private _partialLine = "";
	private _byteCount = 0;
	private _abortHandler: (() => void) | null = null;
	private _abortSignal: AbortSignal | null = null;

	get pid(): number | undefined {
		return this._proc?.pid;
	}

	get running(): boolean {
		return this._running;
	}

	spawn(argv: string[], options?: { signal?: AbortSignal }): void {
		if (this._proc) throw new Error("Process already spawned");
		const cmd = argv[0];
		const args = argv.slice(1);

		this._proc = spawn(cmd, args, {
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
		});
		this._running = true;

		this._proc.stdout!.on("data", (chunk: Buffer) => {
			if (this._byteCount >= MAX_INPUT_BYTES) return;
			const allowed = MAX_INPUT_BYTES - this._byteCount;
			const slice = chunk.length > allowed ? chunk.subarray(0, allowed) : chunk;
			this._byteCount += slice.length;
			const text = slice.toString();
			const parts = (this._partialLine + text).split("\n");
			this._partialLine = parts.pop() ?? "";
			for (const raw of parts) {
				const trimmed = raw.trim();
				if (trimmed && this._lineBuffer.length < MAX_LINE_COUNT) {
					this._lineBuffer.push(trimmed);
				}
			}
		});

		this._exitPromise = new Promise<{
			code: number;
			signal: string | null;
		}>((resolve) => {
			this._proc!.on("exit", (_code, signal) => {
				this._running = false;
				this._removeAbortListener();
				if (this._partialLine) {
					const trimmed = this._partialLine.trim();
					if (trimmed && this._lineBuffer.length < MAX_LINE_COUNT) {
						this._lineBuffer.push(trimmed);
					}
					this._partialLine = "";
				}
				resolve({ code: _code ?? 1, signal });
			});
			this._proc!.on("error", () => {
				this._running = false;
				this._removeAbortListener();
				resolve({ code: 1, signal: null });
			});
		});

		if (options?.signal) {
			this._abortSignal = options.signal;
			if (options.signal.aborted) {
				this.kill();
			} else {
				this._abortHandler = () => this.kill();
				options.signal.addEventListener("abort", this._abortHandler, {
					once: true,
				});
			}
		}
	}

	private _removeAbortListener(): void {
		if (this._abortSignal && this._abortHandler) {
			try {
				this._abortSignal.removeEventListener("abort", this._abortHandler);
			} catch {
				/* ignore */
			}
			this._abortHandler = null;
			this._abortSignal = null;
		}
	}

	/** Return next line, removing it from the buffer so password text
	 *  is not retained past its first consumption. */
	readLine(): string | null {
		if (this._lineBuffer.length > 0) {
			return this._lineBuffer.shift() ?? null;
		}
		return null;
	}

	/** Clear all buffered content. */
	clearBuffer(): void {
		this._lineBuffer = [];
		this._partialLine = "";
	}

	kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
		this._removeAbortListener();
		if (!this._proc || !this._running) return;
		try {
			this._proc.kill(signal);
		} catch {
			/* already exited */
		}
	}

	wait(): Promise<{ code: number; signal: string | null }> {
		return this._exitPromise ?? Promise.resolve({ code: -1, signal: null });
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Credential-redacted descriptor safe for catalogs, journals, events. */
export interface TunnelDescriptor {
	readonly tunnelId: string;
	readonly url: string;
	readonly localPort: number;
	readonly name: string | undefined;
	readonly labels: readonly string[];
	readonly createdAt: string;
}

/** One-time credential grant held only in memory. */
export interface TunnelGrant {
	readonly tunnelId: string;
	readonly url: string;
	readonly httpUser: string;
	readonly httpPassword: string;
}

export interface TunnelStartOptions {
	readonly localPort: number;
	readonly httpUser?: string;
	readonly name?: string;
	readonly labels?: readonly string[];
	readonly teamId?: string;
	readonly signal?: AbortSignal;
	readonly startTimeoutMs?: number;
	readonly processFactory?: () => ManagedProcess;
	readonly cleanupRunner?: (tunnelId: string) => Promise<void>;
	readonly onHealthEvent?: (event: TunnelHealthEvent) => void;
	readonly clock?: { sleep(ms: number): Promise<void>; now(): number };
}

export interface TunnelStopResult {
	readonly processKilled: boolean;
	readonly cleanupOk: boolean;
	readonly cleanupError?: "TIMEOUT" | "EXEC_FAILED";
}

export interface TunnelHealthEvent {
	readonly type: "running" | "exited" | "error";
	readonly exitCode?: number;
	readonly error?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const _TUNNEL_ID_RE = /^Tunnel ID:\s*(\S+)/;
const _URL_RE = /^URL:\s*(\S+)/;
const _AUTH_USER_RE = /^Basic auth user:\s*(\S+)/;
const _AUTH_PASSWORD_RE = /^Basic auth password:\s*(\S*)/;

interface _ParsedFields {
	tunnelId: string;
	url: string;
	httpUser: string;
	httpPassword: string | undefined;
}

/**
 * Parse a single output line, extracting known fields into `accum`.
 * Password line is never retained in caller buffers.
 *
 * Returns true if the line should be stored, false to skip it.
 */
function _tryParseLine(line: string, accum: Partial<_ParsedFields>): boolean {
	if (!accum.tunnelId) {
		const m = _TUNNEL_ID_RE.exec(line);
		if (m) {
			accum.tunnelId = m[1];
			return true;
		}
	}
	if (!accum.url) {
		const m = _URL_RE.exec(line);
		if (m) {
			accum.url = m[1];
			return true;
		}
	}
	if (!accum.httpUser) {
		const m = _AUTH_USER_RE.exec(line);
		if (m) {
			accum.httpUser = m[1];
			return true;
		}
	}
	if (accum.httpPassword === undefined) {
		const m = _AUTH_PASSWORD_RE.exec(line);
		if (m) {
			accum.httpPassword = m[1];
			return false; // do not retain password line
		}
	}
	return true;
}

const ERR_INVALID_URL = "INVALID_TUNNEL_URL";
const ERR_INVALID_PROTOCOL = "INVALID_URL_PROTOCOL";
const ERR_USERINFO_IN_URL = "URL_CONTAINS_USERINFO";
const ERR_QUERY_IN_URL = "URL_CONTAINS_QUERY";
const ERR_FRAGMENT_IN_URL = "URL_CONTAINS_FRAGMENT";
const ERR_EMPTY_TUNNEL_ID = "EMPTY_TUNNEL_ID";
const ERR_BAD_TUNNEL_ID = "INVALID_TUNNEL_ID_FORMAT";
const ERR_BAD_PORT = "PORT_OUT_OF_RANGE";
const ERR_EMPTY_LABEL = "EMPTY_LABEL";
const ERR_BAD_LABEL = "INVALID_LABEL_FORMAT";
const ERR_TOO_MANY_LABELS = "TOO_MANY_LABELS";
const ERR_LABEL_TOO_LONG = "LABEL_TOO_LONG";
const ERR_NAME_TOO_LONG = "NAME_TOO_LONG";
const ERR_BAD_NAME = "INVALID_NAME_FORMAT";
const ERR_EMPTY_HTTP_USER = "EMPTY_HTTP_USER";
const ERR_HTTP_USER_TOO_LONG = "HTTP_USER_TOO_LONG";
const ERR_BAD_HTTP_USER = "INVALID_HTTP_USER_FORMAT";
const ERR_BAD_TEAM_ID = "INVALID_TEAM_ID_FORMAT";
const ERR_TEAM_ID_TOO_LONG = "TEAM_ID_TOO_LONG";
const ERR_MISSING_PASSWORD = "TUNNEL_MISSING_PASSWORD";
const ERR_PASSWORD_TOO_LONG = "PASSWORD_TOO_LONG";
const ERR_PASSWORD_EMPTY = "PASSWORD_EMPTY";
const ERR_AUTH_USER_MISMATCH = "AUTH_USER_MISMATCH";
const ERR_CLEANUP_FAILED = "CLEANUP_EXEC_FAILED";

function _validateUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new TunnelStartError("Invalid tunnel URL: not a valid URL", ERR_INVALID_URL);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") {
		throw new TunnelStartError("Invalid tunnel URL protocol", ERR_INVALID_PROTOCOL);
	}
	if (parsed.username) {
		throw new TunnelStartError("Invalid tunnel URL: contains userinfo", ERR_USERINFO_IN_URL);
	}
	if (parsed.search) {
		throw new TunnelStartError("Invalid tunnel URL: contains query string", ERR_QUERY_IN_URL);
	}
	if (parsed.hash) {
		throw new TunnelStartError("Invalid tunnel URL: contains fragment", ERR_FRAGMENT_IN_URL);
	}
	return raw;
}

function _validateTunnelId(id: string): string {
	if (!id) throw new TunnelStartError("Empty tunnel ID", ERR_EMPTY_TUNNEL_ID);
	if (!TUNNEL_ID_PATTERN.test(id)) {
		throw new TunnelStartError("Invalid tunnel ID format", ERR_BAD_TUNNEL_ID);
	}
	return id;
}

function _validatePort(port: number): number {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new TunnelStartError("Port out of valid range (1-65535)", ERR_BAD_PORT);
	}
	return port;
}

function _validateLabel(label: string): string {
	if (!label) throw new TunnelStartError("Empty label", ERR_EMPTY_LABEL);
	if (label.length > MAX_LABEL_LENGTH) throw new TunnelStartError("Label too long", ERR_LABEL_TOO_LONG);
	if (!SAFE_TEXT_PATTERN.test(label)) {
		throw new TunnelStartError("Invalid label format", ERR_BAD_LABEL);
	}
	return label;
}

function _validateLabels(labels: readonly string[] | undefined): string[] {
	const arr = labels ?? [];
	if (arr.length > MAX_LABEL_COUNT) {
		throw new TunnelStartError("Too many labels", ERR_TOO_MANY_LABELS);
	}
	return arr.map((l) => _validateLabel(l));
}

function _validateName(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	if (name.length > MAX_NAME_LENGTH) throw new TunnelStartError("Name too long", ERR_NAME_TOO_LONG);
	if (!SAFE_NAME_PATTERN.test(name)) {
		throw new TunnelStartError("Invalid name format", ERR_BAD_NAME);
	}
	return name;
}

function _validateHttpUser(user: string | undefined): string {
	if (user === undefined) {
		return generateTunnelUser();
	}
	if (!user) throw new TunnelStartError("Empty httpUser", ERR_EMPTY_HTTP_USER);
	if (user.length > 64) throw new TunnelStartError("httpUser too long", ERR_HTTP_USER_TOO_LONG);
	if (user.includes(":") || user.includes(" ") || !HTTP_USER_PATTERN.test(user)) {
		throw new TunnelStartError("Invalid httpUser format", ERR_BAD_HTTP_USER);
	}
	return user;
}

function _validateTeamId(id: string | undefined): string | undefined {
	if (id === undefined) return undefined;
	if (id.length > MAX_TEAM_ID_LENGTH) throw new TunnelStartError("teamId too long", ERR_TEAM_ID_TOO_LONG);
	if (!SAFE_TEXT_PATTERN.test(id)) {
		throw new TunnelStartError("Invalid teamId format", ERR_BAD_TEAM_ID);
	}
	return id;
}

function _validatePassword(pwd: string): string {
	if (!pwd) {
		throw new TunnelStartError("Empty password", ERR_PASSWORD_EMPTY);
	}
	if (pwd.length > MAX_PASSWORD_LENGTH) {
		throw new TunnelStartError("Password too long", ERR_PASSWORD_TOO_LONG);
	}
	return pwd;
}

function _checkAuthUser(parsedUser: string, expectedUser: string): void {
	if (parsedUser !== expectedUser) {
		throw new TunnelStartError("Auth user mismatch", ERR_AUTH_USER_MISMATCH);
	}
}

function _validateStartTimeout(ms: number | undefined): number {
	const value = ms ?? DEFAULT_START_TIMEOUT_MS;
	if (!Number.isFinite(value) || value <= 0 || value > MAX_START_TIMEOUT_MS) {
		throw new TunnelStartError("Invalid startTimeoutMs: must be positive and finite", "INVALID_TIMEOUT");
	}
	return value;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TunnelStartError extends Error {
	readonly code: string;
	constructor(message: string, code = "TUNNEL_START_FAILED") {
		super(message);
		this.name = "TunnelStartError";
		this.code = code;
	}
}

export class TunnelTimeoutError extends Error {
	readonly code = "TUNNEL_TIMEOUT";
	constructor(message: string) {
		super(message);
		this.name = "TunnelTimeoutError";
	}
}

export class TunnelAbortError extends Error {
	readonly code = "TUNNEL_ABORTED";
	constructor() {
		super("Tunnel start was aborted");
		this.name = "TunnelAbortError";
	}
}

// ---------------------------------------------------------------------------
// Process termination helper
// ---------------------------------------------------------------------------

/** Bounded TERM-wait-KILL cycle. */
async function _terminateAndWait(
	mp: ManagedProcess,
	sleepFn: (ms: number) => Promise<void>,
	termTimeoutMs = TERM_TIMEOUT_MS,
	killTimeoutMs = KILL_TIMEOUT_MS,
): Promise<{ code: number; signal: string | null }> {
	mp.kill("SIGTERM");
	const termResult = await _race(mp.wait(), termTimeoutMs, sleepFn);
	if (termResult !== null) return termResult;

	mp.kill("SIGKILL");
	const killResult = await _race(mp.wait(), killTimeoutMs, sleepFn);
	return killResult ?? { code: -1, signal: "SIGKILL" };
}

async function _race<T>(
	promise: Promise<T>,
	timeoutMs: number,
	sleepFn: (ms: number) => Promise<void>,
): Promise<T | null> {
	const result = await Promise.race([promise, sleepFn(timeoutMs).then(() => null)]);
	return result;
}

// ---------------------------------------------------------------------------
// Default cleanup runner
// ---------------------------------------------------------------------------

/** @internal exported for testing only */
export async function defaultCleanupRunner(tunnelId: string): Promise<void> {
	const result = await execCommand("prime", ["tunnel", "stop", tunnelId, "--plain", "--yes"], process.cwd());
	if (result.code !== 0) {
		throw new TunnelStartError("CLI cleanup returned nonzero", ERR_CLEANUP_FAILED);
	}
}

// ---------------------------------------------------------------------------
// PrimeTunnelManager
// ---------------------------------------------------------------------------

export class PrimeTunnelManager {
	private _process: ManagedProcess | null = null;
	private _descriptor: TunnelDescriptor | null = null;
	private _grant: TunnelGrant | null = null;
	private _started = false;
	private _stopped = false;
	private _cleanupRunner: (tunnelId: string) => Promise<void>;
	private _onHealthEvent: ((event: TunnelHealthEvent) => void) | undefined;
	private _parsedFields: Partial<_ParsedFields> = {};
	/** Track tunnelId from the moment its line is parsed, for cleanup
	 *  even if start fails before descriptor is formed. */
	private _parsedTunnelIdOnLine: string | undefined;
	private _monitorStarted = false;
	private _cleanupInitiated = false;
	private _sleepFn: (ms: number) => Promise<void> = sleep;
	private _nowFn: () => number = () => Date.now();
	/** Lines consumed during start (for bounds enforcement). */
	private _drainLineCount = 0;
	/** Bytes consumed during start (for bounds enforcement). */
	private _drainByteCount = 0;

	constructor(cleanupRunner?: (tunnelId: string) => Promise<void>) {
		this._cleanupRunner = cleanupRunner ?? defaultCleanupRunner;
	}

	get descriptor(): TunnelDescriptor | null {
		return this._descriptor;
	}

	get running(): boolean {
		return this._process?.running ?? false;
	}

	get tunnelId(): string | undefined {
		return this._descriptor?.tunnelId;
	}

	/** Consume the one-time credential grant, clearing it from memory. */
	consumeGrant(): TunnelGrant | null {
		const grant = this._grant;
		this._grant = null;
		return grant;
	}

	async start(options: TunnelStartOptions): Promise<TunnelDescriptor> {
		if (this._started) throw new TunnelStartError("Tunnel manager already started");
		this._started = true;

		_validatePort(options.localPort);
		const httpUser = _validateHttpUser(options.httpUser);
		const name = _validateName(options.name);
		const labels = _validateLabels(options.labels);
		_validateTeamId(options.teamId);
		const startTimeoutMs = _validateStartTimeout(options.startTimeoutMs);

		if (options.signal?.aborted) throw new TunnelAbortError();

		const processFactory = options.processFactory ?? (() => new RealSubprocessProcess());
		const process = processFactory();
		this._process = process;

		this._sleepFn = options.clock?.sleep ?? sleep;
		this._nowFn = options.clock?.now ?? (() => Date.now());
		const sleepFn = this._sleepFn;
		const nowFn = this._nowFn;

		const argv = _buildStartArgv({
			localPort: options.localPort,
			httpUser,
			name,
			labels,
			teamId: options.teamId,
		});

		if (options.cleanupRunner) {
			this._cleanupRunner = options.cleanupRunner;
		}

		try {
			process.spawn(["prime", ...argv], {
				signal: options.signal,
			});
		} catch (err) {
			await this._cleanupOnFailure(err instanceof Error ? err : new Error(String(err)));
			throw new TunnelStartError("Failed to spawn tunnel process");
		}

		this._parsedFields = {};
		this._parsedTunnelIdOnLine = undefined;
		this._drainLineCount = 0;
		this._drainByteCount = 0;
		const deadline = nowFn() + startTimeoutMs;

		try {
			while (true) {
				if (options.signal?.aborted) {
					this._cleanupInitiated = true;
					await _terminateAndWait(process, sleepFn);
					this._clearSecrets();
					throw new TunnelAbortError();
				}

				if (nowFn() > deadline) {
					this._cleanupInitiated = true;
					await _terminateAndWait(process, sleepFn);
					this._clearSecrets();
					throw new TunnelTimeoutError(`Tunnel did not start within ${startTimeoutMs}ms`);
				}

				// Drain available lines with independent bounds
				for (;;) {
					const line = process.readLine();
					if (line === null) break;
					// Bounds check before processing
					this._drainByteCount += Buffer.byteLength(line, "utf8");
					if (this._drainByteCount > MAX_INPUT_BYTES) {
						this._cleanupInitiated = true;
						await _terminateAndWait(process, sleepFn);
						this._clearSecrets();
						throw new TunnelStartError("Tunnel output exceeded byte limit", "OUTPUT_BYTE_LIMIT");
					}
					if (this._drainLineCount >= MAX_LINE_COUNT) {
						this._cleanupInitiated = true;
						await _terminateAndWait(process, sleepFn);
						this._clearSecrets();
						throw new TunnelStartError("Tunnel output exceeded line limit", "OUTPUT_LINE_LIMIT");
					}
					this._drainLineCount++;
					_tryParseLine(line, this._parsedFields);
					// Capture tunnel ID immediately when its line arrives,
					// validating it before storing so invalid IDs never
					// reach cleanup CLI argv.
					if (this._parsedTunnelIdOnLine === undefined && this._parsedFields.tunnelId) {
						try {
							this._parsedTunnelIdOnLine = _validateTunnelId(this._parsedFields.tunnelId);
						} catch {
							this._cleanupInitiated = true;
							await _terminateAndWait(process, sleepFn);
							this._clearSecrets();
							throw new TunnelStartError("Invalid tunnel ID");
						}
					}
				}

				const parsed = this._parsedFields;
				if (parsed.tunnelId && parsed.url && parsed.httpUser) {
					const tunnelId = _validateTunnelId(parsed.tunnelId);
					const url = _validateUrl(parsed.url);
					_checkAuthUser(parsed.httpUser, httpUser);

					if (parsed.httpPassword === undefined) {
						this._cleanupInitiated = true;
						await _terminateAndWait(process, sleepFn);
						this._clearSecrets();
						throw new TunnelStartError("Tunnel did not report an auth password", ERR_MISSING_PASSWORD);
					}
					_validatePassword(parsed.httpPassword);

					const now = new Date().toISOString();
					this._descriptor = {
						tunnelId,
						url,
						localPort: options.localPort,
						name,
						labels: Object.freeze([...labels]),
						createdAt: now,
					};

					this._grant = {
						tunnelId,
						url,
						httpUser,
						httpPassword: parsed.httpPassword,
					};

					// Clear parsed fields — password lived here
					this._parsedFields = {};
					this._onHealthEvent = options.onHealthEvent;

					// Fire-and-forget exit monitor
					this._startExitMonitor(process);

					return this._descriptor;
				}

				if (!process.running) {
					await process.wait();
					this._clearSecrets();
					throw new TunnelStartError("Tunnel process exited unexpectedly", "TUNNEL_UNEXPECTED_EXIT");
				}

				await sleepFn(POLL_INTERVAL_MS);
			}
		} catch (err) {
			await this._cleanupOnFailure(err instanceof Error ? err : new Error(String(err)));
			throw err;
		}
	}

	async stop(): Promise<TunnelStopResult> {
		if (this._stopped) {
			return { processKilled: false, cleanupOk: true };
		}
		this._stopped = true;

		let processKilled = false;
		if (this._process?.running) {
			await _terminateAndWait(this._process, this._sleepFn);
			processKilled = true;
		} else if (this._process) {
			await this._process.wait();
			processKilled = true;
		}

		this._clearSecrets();

		const tunnelId = this._getCleanupTunnelId();
		this._descriptor = null;

		let cleanupOk = true;
		let cleanupError: "TIMEOUT" | "EXEC_FAILED" | undefined;

		if (tunnelId) {
			await this._sleepFn(CLEANUP_WAIT_MS);
			try {
				await this._cleanupRunner(tunnelId);
			} catch {
				cleanupOk = false;
				cleanupError = "EXEC_FAILED";
			}
		}

		return { processKilled, cleanupOk, cleanupError };
	}

	async abort(): Promise<TunnelStopResult> {
		if (this._stopped) {
			return { processKilled: false, cleanupOk: true };
		}
		this._stopped = true;

		let processKilled = false;
		if (this._process?.running) {
			await _terminateAndWait(this._process, this._sleepFn);
			processKilled = true;
		} else if (this._process) {
			await this._process.wait();
			processKilled = true;
		}

		this._clearSecrets();

		const tunnelId = this._getCleanupTunnelId();
		this._descriptor = null;

		let cleanupOk = true;
		let cleanupError: "TIMEOUT" | "EXEC_FAILED" | undefined;

		if (tunnelId) {
			try {
				await this._cleanupRunner(tunnelId);
			} catch {
				cleanupOk = false;
				cleanupError = "EXEC_FAILED";
			}
		}

		return { processKilled, cleanupOk, cleanupError };
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private _getCleanupTunnelId(): string | undefined {
		return this._descriptor?.tunnelId ?? this._parsedTunnelIdOnLine;
	}

	private _clearSecrets(): void {
		this._grant = null;
		this._parsedFields = {};
	}

	private async _cleanupOnFailure(_err: Error): Promise<void> {
		if (this._cleanupInitiated) {
			this._clearSecrets();
			const tunnelId = this._getCleanupTunnelId();
			this._descriptor = null;
			if (tunnelId) {
				try {
					await this._cleanupRunner(tunnelId);
				} catch {
					/* best-effort */
				}
			}
			return;
		}

		if (this._process) {
			if (this._process.running) {
				await _terminateAndWait(this._process, this._sleepFn);
			} else {
				await this._process.wait();
			}
		}

		this._clearSecrets();

		const tunnelId = this._getCleanupTunnelId();
		this._descriptor = null;

		if (tunnelId) {
			try {
				await this._cleanupRunner(tunnelId);
			} catch {
				/* best-effort */
			}
		}
	}

	private async _startExitMonitor(process: ManagedProcess): Promise<void> {
		if (this._monitorStarted) return;
		this._monitorStarted = true;
		try {
			const { code } = await process.wait();
			if (!this._stopped) {
				this._clearSecrets();
				this._descriptor = null;
				this._onHealthEvent?.({
					type: "exited",
					exitCode: code,
				});
			}
		} catch {
			if (!this._stopped) {
				this._onHealthEvent?.({
					type: "error",
					error: "exit monitor failed",
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _buildStartArgv(options: {
	localPort: number;
	httpUser: string;
	name?: string;
	labels: readonly string[];
	teamId?: string;
}): string[] {
	const argv: string[] = [
		"tunnel",
		"start",
		"--port",
		String(options.localPort),
		"--auth",
		options.httpUser,
		"--plain",
	];

	if (options.name) {
		argv.push("--name", options.name);
	}
	for (const label of options.labels) {
		argv.push("--label", label);
	}
	if (options.teamId) {
		argv.push("--team-id", options.teamId);
	}

	return argv;
}

export function generateTunnelUser(): string {
	return `tun-${randomBytes(8).toString("hex")}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
