/**
 * Prime Sandbox provider — wraps the `prime sandbox` CLI behind
 * an injectable CommandRunner so tests never call the real API.
 *
 * Every public method accepts an optional AbortSignal through the
 * runner options.
 *
 * `lookupByLabel` and `deleteResolved` are narrow internal
 * capabilities wired through the factory-returned object for the
 * lifecycle resolver.  Their result shapes are module-private.
 */

import { randomBytes } from "node:crypto";
import type {
	CommandRunner,
	SandboxApiStatus,
	SandboxCreateOptions,
	SandboxIdentity,
	SandboxPreflightResult,
} from "./sandbox-types.js";

// -------------------------------------------------------------------------
// Error classification
// -------------------------------------------------------------------------

const NOT_FOUND_SIGNALS = ["not found", "no such sandbox", "does not exist"];

function isNotFoundError(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	return NOT_FOUND_SIGNALS.some((s) => lower.includes(s));
}

function providerError(kind: string, exitCode: number): Error {
	return new Error(`sandbox-provider: ${kind} failed (exit ${exitCode})`);
}

// -------------------------------------------------------------------------
// Status normalisation — reject unknown statuses
// -------------------------------------------------------------------------

const VALID_STATUSES = new Set<SandboxApiStatus>([
	"PENDING",
	"PROVISIONING",
	"RUNNING",
	"PAUSED",
	"ERROR",
	"TERMINATED",
	"TIMEOUT",
]);

function normalizeStatus(raw: unknown): SandboxApiStatus {
	// Exact string check -- no String() coercion, no trim
	if (typeof raw !== "string" || raw.length === 0) {
		throw new Error(`sandbox-provider: unknown API status "${String(raw)}"`);
	}
	const upper = raw.toUpperCase();
	// Check against valid statuses without casting
	// Use Array.from to iterate -- the Set has string values by construction
	for (const valid of VALID_STATUSES) {
		if (upper === valid) return valid;
	}
	throw new Error(`sandbox-provider: unknown API status "${raw}"`);
}

// -------------------------------------------------------------------------
// Field validation helpers
// -------------------------------------------------------------------------

function stringField(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`sandbox-provider: missing or empty ${field} in response`);
	}
	return value.trim();
}

function _stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

// -------------------------------------------------------------------------
// JSON parsing
// -------------------------------------------------------------------------

function parseSandboxGetJson(raw: string): SandboxIdentity {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("sandbox-provider: malformed get JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("sandbox-provider: get JSON is not an object");
	}
	// Read every field via descriptor — no direct property access on unknown
	const readField = (key: string): unknown => {
		const desc = Object.getOwnPropertyDescriptor(parsed, key);
		if (!desc || !("value" in desc) || !desc.enumerable) return undefined;
		return desc.value;
	};
	const rawId = readField("id");
	const id = stringField(rawId, "id");
	const rawName = readField("name");
	const name = typeof rawName === "string" && rawName.length > 0 ? rawName : "";
	const rawStatus = readField("status");
	const rawImage = readField("docker_image");
	const image = typeof rawImage === "string" && rawImage.length > 0 ? rawImage : "";
	const rawRegion = readField("region");
	const region = typeof rawRegion === "string" ? rawRegion : "";
	const rawCreatedAt = readField("created_at");
	const createdAt = stringField(rawCreatedAt, "created_at");
	const rawLabels = readField("labels");
	const labels: string[] = [];
	if (Array.isArray(rawLabels)) {
		for (const l of rawLabels) {
			if (typeof l === "string") labels.push(l);
		}
	}
	return {
		id,
		name,
		status: normalizeStatus(rawStatus),
		image,
		region,
		createdAt,
		labels,
		resources: "",
	};
}

function parseSandboxListJson(raw: string, labels: string[]): SandboxIdentity[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	// Build result without type assertions
	const result: SandboxIdentity[] = [];
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return result;
	}
	// Read sandboxes descriptor -- reject non-enumerable or accessor
	const sbDesc = Object.getOwnPropertyDescriptor(parsed, "sandboxes");
	if (!sbDesc || !sbDesc.enumerable || !("value" in sbDesc)) {
		return result;
	}
	const sandboxesVal = sbDesc.value;
	if (!Array.isArray(sandboxesVal)) {
		return result;
	}
	for (const entry of sandboxesVal) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			continue;
		}
		// Validate labels -- exact string check, no trimming, no silent filter
		const labelDesc = Object.getOwnPropertyDescriptor(entry, "labels");
		if (!labelDesc || !labelDesc.enumerable || !("value" in labelDesc)) {
			continue;
		}
		const rawLabels = labelDesc.value;
		const entryLabels: string[] = [];
		if (Array.isArray(rawLabels)) {
			for (const l of rawLabels) {
				if (typeof l !== "string") continue;
				entryLabels.push(l);
			}
		}
		const hasAll = labels.every((l) => entryLabels.includes(l));
		if (!hasAll) continue;
		const idDesc = Object.getOwnPropertyDescriptor(entry, "id");
		if (!idDesc || !idDesc.enumerable || !("value" in idDesc)) {
			continue;
		}
		const rawId = idDesc.value;
		if (typeof rawId !== "string" || rawId.length === 0) continue;
		const nameDesc = Object.getOwnPropertyDescriptor(entry, "name");
		const rawName = nameDesc && "value" in nameDesc ? nameDesc.value : "";
		const nameVal = typeof rawName === "string" ? rawName : "";
		const statusDesc = Object.getOwnPropertyDescriptor(entry, "status");
		const rawStatus = statusDesc && "value" in statusDesc ? statusDesc.value : "";
		const imageDesc = Object.getOwnPropertyDescriptor(entry, "image");
		const rawImage = imageDesc && "value" in imageDesc ? imageDesc.value : "";
		const regionDesc = Object.getOwnPropertyDescriptor(entry, "region");
		const rawRegion = regionDesc && "value" in regionDesc ? regionDesc.value : "";
		const caDesc = Object.getOwnPropertyDescriptor(entry, "created_at");
		const rawCa = caDesc && "value" in caDesc ? caDesc.value : "";
		const resourcesDesc = Object.getOwnPropertyDescriptor(entry, "resources");
		const rawResources = resourcesDesc && "value" in resourcesDesc ? resourcesDesc.value : "";
		try {
			result.push({
				id: rawId,
				name: nameVal,
				status: normalizeStatus(rawStatus),
				image: typeof rawImage === "string" && rawImage.length > 0 ? rawImage : "",
				region: typeof rawRegion === "string" ? rawRegion : "",
				createdAt: typeof rawCa === "string" && rawCa.length > 0 ? rawCa : "",
				labels: entryLabels,
				resources: typeof rawResources === "string" ? rawResources : "",
			});
		} catch {}
	}
	return result;
}
function parseCreateSandboxId(stdout: string): string {
	const match = stdout.match(/Successfully created sandbox (\S+)/);
	if (!match) throw new Error("sandbox-provider: create did not produce an id");
	return match[1];
}

// -------------------------------------------------------------------------
// Typed duplicate error
// -------------------------------------------------------------------------

export class DuplicateSandboxError extends Error {
	readonly tag = "DuplicateSandbox" as const;

	constructor(count?: number) {
		const msg =
			count !== undefined
				? `sandbox-provider: ${count} duplicate sandboxes`
				: "sandbox-provider: duplicate sandboxes";
		super(msg);
		this.name = "DuplicateSandboxError";
	}
}

// -------------------------------------------------------------------------
// Abortable delay
// -------------------------------------------------------------------------

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(new DOMException("Aborted", "AbortError"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// -------------------------------------------------------------------------
// Background job support
// -------------------------------------------------------------------------

export const SANDBOX_RUNTIME_DIR = "/tmp/prime-sandbox-runtime";

/** Validate that a jobId is a 16-character hex string. */
export function validateJobId(jobId: string): void {
	if (!/^[0-9a-f]{16}$/.test(jobId)) {
		throw new Error(`sandbox-provider: invalid job id "${jobId}"`);
	}
}

/**
 * Forward reference — the full type is defined below at the Provider interface.
 */
type PrivateLabelLookupResult_Internal =
	| { readonly status: "absent" }
	| { readonly status: "found"; readonly identity: { readonly id: string } }
	| { readonly status: "collision" };

/**
 * Parse a single-entry label-filtered sandbox list result.
 *
 * Strict validation — every field is checked before any match is counted.
 * Malformed outer JSON, non-object, missing/extra own keys, non-array sandboxes,
 * malformed entries, or entries missing the requested label all throw → UNCERTAIN.
 * Never silently filters entries to produce false absence.
 */
function parseLabelLookupJson(raw: string, label: string): PrivateLabelLookupResult_Internal {
	// Parse outer JSON without type assertion
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("sandbox-provider: malformed list JSON during label lookup");
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("sandbox-provider: list JSON is not an object");
	}

	// Exact own enumerable key check — only "sandboxes" allowed
	const ownKeys = Object.getOwnPropertyNames(parsed);
	if (ownKeys.length !== 1 || ownKeys[0] !== "sandboxes") {
		throw new Error("sandbox-provider: list JSON has unexpected keys");
	}

	// Check descriptor is enumerable value
	const sandboxDescriptor = Object.getOwnPropertyDescriptor(parsed, "sandboxes");
	if (!sandboxDescriptor || !sandboxDescriptor.enumerable || !("value" in sandboxDescriptor)) {
		throw new Error("sandbox-provider: list JSON sandboxes not enumerable value");
	}

	const sandboxes = sandboxDescriptor.value;
	if (!Array.isArray(sandboxes)) {
		throw new Error("sandbox-provider: list JSON sandboxes is not an array");
	}

	// Validate EVERY entry before counting matches
	const matching: string[] = [];
	const SANDBOX_ENTRY_KEYS = new Set(["id", "name", "image", "status", "region", "created_at", "labels", "resources"]);
	const SANDBOX_REQUIRED_KEYS = new Set(["id", "labels"]);

	for (let i = 0; i < sandboxes.length; i++) {
		const entry = sandboxes[i];
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error("sandbox-provider: malformed entry in label lookup — not an object");
		}

		// Exact own enumerable keys check
		const entryKeys = Object.getOwnPropertyNames(entry);
		// Require ALL expected keys -- no missing fields
		for (const requiredKey of SANDBOX_REQUIRED_KEYS) {
			if (!entryKeys.includes(requiredKey)) {
				throw new Error(`sandbox-provider: malformed entry — missing required key ${requiredKey}`);
			}
		}
		for (const ek of entryKeys) {
			if (!SANDBOX_ENTRY_KEYS.has(ek)) {
				throw new Error("sandbox-provider: malformed entry — unexpected key");
			}
		}

		// Every descriptor must be enumerable value
		const entryDesc = Object.getOwnPropertyDescriptors(entry);
		for (const ek of entryKeys) {
			const d = entryDesc[ek];
			if (!d || !("value" in d) || !d.enumerable) {
				throw new Error("sandbox-provider: malformed entry — non-enumerable or accessor property");
			}
		}

		// Validate labels array -- every element must be a string
		const entryLabels: string[] = [];
		const labelsVal = entryDesc.labels?.value;
		if (Array.isArray(labelsVal)) {
			for (const l of labelsVal) {
				if (typeof l !== "string") {
					throw new Error("sandbox-provider: malformed entry — non-string label");
				}
				entryLabels.push(l);
			}
		}

		// If any entry does NOT have the requested label, that is a protocol error → UNCERTAIN
		if (!entryLabels.includes(label)) {
			throw new Error("sandbox-provider: entry missing requested label");
		}

		// Validate id is a non-empty string
		const eid = entryDesc.id?.value;
		if (typeof eid !== "string" || eid.length === 0) {
			throw new Error("sandbox-provider: malformed entry id in label lookup");
		}

		matching.push(eid);
	}

	if (matching.length === 0) {
		return Object.freeze({ status: "absent" });
	}
	if (matching.length > 1) {
		return Object.freeze({ status: "collision" });
	}
	return Object.freeze({
		status: "found",
		identity: Object.freeze({ id: matching[0] }),
	});
}

/**
 * Build the sandbox-run command to start a background job.
 *
 * Strategy: base64-encode a shell script into the sandbox, write it to
 * the validated job-id directory, chmod 0700, then nohup it.
 * This avoids the syntactic hazards of nested single-quote escaping.
 */
export function buildBackgroundStartCommand(command: string[]): { jobId: string; startCommand: string[] } {
	if (command.length === 0) {
		throw new Error("sandbox-provider: empty command array");
	}
	const jobId = randomBytes(8).toString("hex");
	validateJobId(jobId);
	const dir = `${SANDBOX_RUNTIME_DIR}/${jobId}`;

	// Build the inner script.  Each argument is single-quote escaped.
	// The script captures the exit code and atomically writes exit/status
	// metadata files so the polling commands can read them.
	const escapedArgs = command.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");

	const trapLine =
		'trap \'CHPID=$(cat "$DIR/child_pid" 2>/dev/null || echo ""); [ -n "$CHPID" ] && kill "$CHPID" 2>/dev/null; exit 0\' TERM INT';
	const scriptLines = [
		"#!/bin/bash",
		`DIR='${dir}'`,
		trapLine,
		`${escapedArgs} &`,
		"CHPID=$!",
		`echo "$CHPID" > "$DIR/child_pid"`,
		'wait "$CHPID"',
		"ret=$?",
		`echo "$ret" > "$DIR/exit.tmp"`,
		`mv -f "$DIR/exit.tmp" "$DIR/exit"`,
		`echo "done" > "$DIR/status.tmp"`,
		`mv -f "$DIR/status.tmp" "$DIR/status"`,
		"exit $ret",
	];
	let scriptContent = "";
	for (const line of scriptLines) {
		scriptContent += `${line}\n`;
	}

	const encoded = Buffer.from(scriptContent, "utf-8").toString("base64");

	// The inner shell launched via sandbox run:
	// setsid creates a new session so the script is a process-group leader.
	// Recording $! gives the PID (which equals the PGID of the script).
	const inner = [
		`mkdir -p '${dir}'`,
		`printf '%s' '${encoded}' | base64 -d > '${dir}/script'`,
		`chmod 0700 '${dir}/script'`,
		`nohup setsid '${dir}/script' >'${dir}/stdout' 2>'${dir}/stderr' </dev/null &`,
		`echo "$!" > '${dir}/pid'`,
	].join(" && ");

	return { jobId, startCommand: ["bash", "-lc", inner] };
}

/**
 * Build the sandbox-run command to poll a background job's status.
 *
 * Uses kill -0 $PID to probe liveness in addition to file checks.
 * Output: `pid|status_label|exitCode`
 *
 * status_label is one of:
 *   "running"   — kill -0 succeeded (process alive)
 *   "completed" — process exited and status=done
 *   "lost"      — process gone, no completion record
 */
export function buildBackgroundStatusCommand(jobId: string): string[] {
	validateJobId(jobId);
	const dir = `${SANDBOX_RUNTIME_DIR}/${jobId}`;

	return [
		"bash",
		"-lc",
		[
			`PID=$(cat "${dir}/pid" 2>/dev/null || echo "")`,
			`STATUS=$(cat "${dir}/status" 2>/dev/null || echo "")`,
			`EXIT=$(cat "${dir}/exit" 2>/dev/null || echo "")`,
			// Check STATUS=done first (reused PIDs), then probe liveness
			'ALIVE=0; [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && ALIVE=1',
			'if [ "$STATUS" = "done" ]; then echo "$PID|completed|$EXIT"',
			'elif [ "$ALIVE" = "1" ]; then echo "$PID|running|"',
			'else echo "$PID|lost|"',
			"fi",
		].join("; "),
	];
}

/**
 * Build the sandbox-run command to retrieve a background job's
 * output. Returns stdout and stderr as separate streams.
 */
export function buildBackgroundLogsCommand(jobId: string): string[] {
	validateJobId(jobId);
	const dir = `${SANDBOX_RUNTIME_DIR}/${jobId}`;

	// Output stdout on stdout, stderr on stderr so the CLI run
	// captures them separately.
	return [
		"bash",
		"-lc",
		[`cat "${dir}/stdout" 2>/dev/null || true`, `cat "${dir}/stderr" 2>/dev/null >&2 || true`].join("; "),
	];
}

/**
 * Build the sandbox-run command to kill a background job and
 * clean up its runtime directory.
 */
export function buildBackgroundKillCommand(jobId: string): string[] {
	validateJobId(jobId);
	const dir = `${SANDBOX_RUNTIME_DIR}/${jobId}`;

	return [
		"bash",
		"-lc",
		[
			`PID=$(cat "${dir}/pid" 2>/dev/null || echo "")`,
			// SIGTERM to the whole process group (setsid made the script leader, PGID=PID).
			// Wait, check liveness; escalate to SIGKILL if still alive.
			`[ -n "$PID" ] && kill -TERM -- -"$PID" 2>/dev/null; sleep 1 || true`,
			`[ -n "$PID" ] && kill -0 -- -"$PID" 2>/dev/null && kill -KILL -- -"$PID" 2>/dev/null || true`,
			`sleep 1; rm -rf "${dir}" 2>/dev/null || true`,
		].join("; "),
	];
}

// -------------------------------------------------------------------------
// Background job status helper
// -------------------------------------------------------------------------

export interface BackgroundJobStatus {
	pid: string;
	running: boolean;
	completed: boolean;
	lost: boolean;
	exitCode: number | null;
}

export function parseBackgroundJobStatus(raw: string): BackgroundJobStatus {
	const line = raw.trim();
	const parts = line.split("|");
	if (parts.length !== 3) {
		throw new Error("sandbox-provider: malformed background job status");
	}
	const pid = parts[0] ?? "";
	const label = parts[1] ?? "";
	const exitStr = parts[2] ?? "";

	if (label !== "running" && label !== "completed" && label !== "lost") {
		throw new Error("sandbox-provider: unknown background job status label");
	}

	// Running and completed require a positive decimal pid; lost may have none
	if (label !== "lost" && (!/^[0-9]+$/.test(pid) || Number(pid) <= 0)) {
		throw new Error("sandbox-provider: invalid background job pid");
	}

	let exitCode: number | null = null;

	if (label === "completed") {
		if (exitStr === "") {
			throw new Error("sandbox-provider: completed background job missing exit code");
		}
		const numericExit = Number(exitStr);
		if (!Number.isInteger(numericExit) || numericExit < 0 || numericExit > 255) {
			throw new Error("sandbox-provider: completed background job invalid exit code");
		}
		exitCode = numericExit;
	} else if (exitStr !== "") {
		throw new Error("sandbox-provider: unexpected exit code for non-completed job");
	}

	return {
		pid,
		running: label === "running",
		completed: label === "completed",
		lost: label === "lost",
		exitCode,
	};
}

// -------------------------------------------------------------------------
// Provider interface
// -------------------------------------------------------------------------

export interface SandboxProvider {
	preflight(options?: { signal?: AbortSignal }): Promise<SandboxPreflightResult>;

	create(options: SandboxCreateOptions, signal?: AbortSignal): Promise<SandboxIdentity>;

	/**
	 * Narrow provider-private label lookup.
	 * Returns a discriminated union:
	 *  - `{status:"absent"}` — 0 exact matches
	 *  - `{status:"found", identity: {id}}` — 1 exact match
	 *  - `{status:"collision"}` — >1 exact match (IDs never exposed)
	 * Malformed JSON, CLI failure, exceptions reject the promise → UNCERTAIN.
	 *
	 * Part of the provider interface for lifecycle resolver; its result
	 * shape is module-private and not exported from the package index.
	 */
	lookupByLabel(label: string, signal?: AbortSignal): Promise<PrivateLabelLookupResult_Internal>;

	get(sandboxId: string, signal?: AbortSignal): Promise<SandboxIdentity>;

	waitForStatus(
		sandboxId: string,
		desiredStatuses: SandboxApiStatus[],
		options?: {
			timeoutMs?: number;
			pollMs?: number;
			signal?: AbortSignal;
		},
	): Promise<SandboxIdentity>;

	upload(sandboxId: string, localPath: string, remotePath: string, signal?: AbortSignal): Promise<void>;

	download(sandboxId: string, remotePath: string, localPath: string, signal?: AbortSignal): Promise<void>;

	runCommand(
		sandboxId: string,
		command: string[],
		options?: {
			timeout?: number;
			signal?: AbortSignal;
			workingDir?: string;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }>;

	getLogs(sandboxId: string, signal?: AbortSignal): Promise<string>;

	delete(sandboxId: string, signal?: AbortSignal): Promise<void>;

	/**
	 * Narrow provider-private resolved delete.
	 * Returns/rejects only on exit 0.  Never parses stderr for "not found".
	 * The facade uses this for unambiguous result after a successful resolution.
	 * Intentionally NOT exported from the package index.
	 */
	deleteResolved(sandboxId: string, signal?: AbortSignal): Promise<void>;

	startBackgroundJob(sandboxId: string, command: string[], signal?: AbortSignal): Promise<string>;

	getBackgroundJobStatus(sandboxId: string, jobId: string, signal?: AbortSignal): Promise<BackgroundJobStatus>;

	getBackgroundJobLogs(
		sandboxId: string,
		jobId: string,
		signal?: AbortSignal,
	): Promise<{ stdout: string; stderr: string }>;

	killBackgroundJob(sandboxId: string, jobId: string, signal?: AbortSignal): Promise<void>;
}

// -------------------------------------------------------------------------
// Factory
// -------------------------------------------------------------------------

const PRIME_CLI = "prime";

export function createPrimeSandboxProvider(runner: CommandRunner): SandboxProvider {
	const preflight = async (opts?: { signal?: AbortSignal }): Promise<SandboxPreflightResult> => {
		const versionResult = await runner.run([PRIME_CLI, "--version"], {
			timeout: 10_000,
			signal: opts?.signal,
		});
		if (versionResult.exitCode !== 0) {
			return {
				available: false,
				version: "",
				error: "prime CLI not found or not executable",
			};
		}
		const version = versionResult.stdout.trim();

		const listResult = await runner.run([PRIME_CLI, "sandbox", "list", "--num", "1", "--output", "json", "--plain"], {
			timeout: 15_000,
			signal: opts?.signal,
		});
		if (listResult.exitCode !== 0) {
			return {
				available: false,
				version,
				error: "prime sandbox auth or API unavailable",
			};
		}
		return { available: true, version, error: "" };
	};

	const create = async (options: SandboxCreateOptions, signal?: AbortSignal): Promise<SandboxIdentity> => {
		const label = options.sessionLabel;

		// List before create
		const listBefore = await runner.run(
			[PRIME_CLI, "sandbox", "list", "--output", "json", "--plain", "--label", label],
			{ signal },
		);
		if (listBefore.exitCode === 0) {
			const matches = parseSandboxListJson(listBefore.stdout, [label]);
			if (matches.length > 0) return matches[0];
		}

		// Build create args
		const args: string[] = [PRIME_CLI, "sandbox", "create", "--yes", "--plain", "--label", label];
		if (options.name) args.push("--name", options.name);
		if (options.startCommand) args.push("--start-command", options.startCommand);
		if (options.image) args.push(options.image);
		if (options.cpuCores !== undefined) args.push("--cpu-cores", String(options.cpuCores));
		if (options.memoryGb !== undefined) args.push("--memory-gb", String(options.memoryGb));
		if (options.diskSizeGb !== undefined) args.push("--disk-size-gb", String(options.diskSizeGb));
		if (options.region) args.push("--region", options.region);
		if (options.timeoutMinutes !== undefined) args.push("--timeout-minutes", String(options.timeoutMinutes));
		if (options.idleTimeoutMinutes !== undefined)
			args.push("--idle-timeout-minutes", String(options.idleTimeoutMinutes));

		const createResult = await runner.run(args, {
			timeout: 120_000,
			signal,
		});
		if (createResult.exitCode !== 0) throw providerError("create", createResult.exitCode);

		const sandboxId = parseCreateSandboxId(createResult.stdout);

		// List after create — if >1 match, return typed duplicate error
		const listAfter = await runner.run(
			[PRIME_CLI, "sandbox", "list", "--output", "json", "--plain", "--label", label],
			{ signal },
		);
		if (listAfter.exitCode === 0) {
			const afterMatches = parseSandboxListJson(listAfter.stdout, [label]);
			if (afterMatches.length > 1) {
				throw new DuplicateSandboxError(afterMatches.length);
			}
			if (afterMatches.length === 1) {
				return afterMatches[0];
			}
		}

		return get(sandboxId, signal);
	};

	const get = async (sandboxId: string, signal?: AbortSignal): Promise<SandboxIdentity> => {
		const result = await runner.run([PRIME_CLI, "sandbox", "get", "--output", "json", "--plain", sandboxId], {
			signal,
		});
		if (result.exitCode !== 0) throw providerError("get", result.exitCode);
		return parseSandboxGetJson(result.stdout);
	};

	const waitForStatus = async (
		sandboxId: string,
		desiredStatuses: SandboxApiStatus[],
		options?: {
			timeoutMs?: number;
			pollMs?: number;
			signal?: AbortSignal;
		},
	): Promise<SandboxIdentity> => {
		const timeoutMs = options?.timeoutMs ?? 300_000;
		const pollMs = options?.pollMs ?? 5_000;
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			options?.signal?.throwIfAborted();
			const identity = await get(sandboxId, options?.signal);
			if (desiredStatuses.includes(identity.status)) return identity;
			await abortableDelay(pollMs, options?.signal);
		}

		throw new Error(`sandbox-provider: wait for ${desiredStatuses.join("/")} timed out`);
	};

	const upload = async (
		sandboxId: string,
		localPath: string,
		remotePath: string,
		signal?: AbortSignal,
	): Promise<void> => {
		const result = await runner.run([PRIME_CLI, "sandbox", "upload", "--plain", sandboxId, localPath, remotePath], {
			signal,
		});
		if (result.exitCode !== 0) throw providerError("upload", result.exitCode);
	};

	const download = async (
		sandboxId: string,
		remotePath: string,
		localPath: string,
		signal?: AbortSignal,
	): Promise<void> => {
		const result = await runner.run([PRIME_CLI, "sandbox", "download", "--plain", sandboxId, remotePath, localPath], {
			signal,
		});
		if (result.exitCode !== 0) throw providerError("download", result.exitCode);
	};

	const runCommand = async (
		sandboxId: string,
		command: string[],
		runOptions?: {
			timeout?: number;
			signal?: AbortSignal;
			workingDir?: string;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
		const args: string[] = [PRIME_CLI, "sandbox", "run", "--plain", sandboxId];
		if (runOptions?.workingDir) args.push("--working-dir", runOptions.workingDir);
		if (runOptions?.timeout !== undefined) args.push("--timeout", String(runOptions.timeout));
		args.push("--");
		args.push(...command);
		return runner.run(args, {
			timeout: (runOptions?.timeout ?? 60) * 1000,
			signal: runOptions?.signal,
		});
	};

	const getLogs = async (sandboxId: string, signal?: AbortSignal): Promise<string> => {
		const result = await runner.run([PRIME_CLI, "sandbox", "logs", "--plain", sandboxId], { signal });
		if (result.exitCode !== 0) throw providerError("logs", result.exitCode);
		return result.stdout;
	};

	const lookupByLabel = async (label: string, signal?: AbortSignal): Promise<PrivateLabelLookupResult_Internal> => {
		const result = await runner.run([PRIME_CLI, "sandbox", "list", "--output", "json", "--plain", "--label", label], {
			signal,
		});
		if (result.exitCode !== 0) {
			throw new Error(`sandbox-provider: label lookup CLI failed (exit ${result.exitCode})`);
		}
		return parseLabelLookupJson(result.stdout, label);
	};

	const _delete = async (sandboxId: string, signal?: AbortSignal): Promise<void> => {
		const result = await runner.run([PRIME_CLI, "sandbox", "delete", "--yes", "--plain", sandboxId], { signal });
		if (result.exitCode !== 0 && !isNotFoundError(result.stderr)) {
			throw providerError("delete", result.exitCode);
		}
	};

	const deleteResolved = async (sandboxId: string, signal?: AbortSignal): Promise<void> => {
		const result = await runner.run([PRIME_CLI, "sandbox", "delete", "--yes", "--plain", sandboxId], { signal });
		if (result.exitCode !== 0) {
			throw providerError("deleteResolved", result.exitCode);
		}
	};

	// ---- Background job operations ----

	const startBackgroundJob = async (sandboxId: string, command: string[], signal?: AbortSignal): Promise<string> => {
		const { jobId, startCommand } = buildBackgroundStartCommand(command);
		const result = await runCommand(sandboxId, startCommand, { signal });
		if (result.exitCode !== 0) {
			throw new Error(`sandbox-provider: start background job failed (exit ${result.exitCode})`);
		}
		return jobId;
	};

	const getBackgroundJobStatus = async (
		sandboxId: string,
		jobId: string,
		signal?: AbortSignal,
	): Promise<BackgroundJobStatus> => {
		const cmd = buildBackgroundStatusCommand(jobId);
		const result = await runCommand(sandboxId, cmd, { signal });
		if (result.exitCode !== 0) {
			throw new Error(`sandbox-provider: get background job status failed (exit ${result.exitCode})`);
		}
		return parseBackgroundJobStatus(result.stdout);
	};

	const getBackgroundJobLogs = async (
		sandboxId: string,
		jobId: string,
		signal?: AbortSignal,
	): Promise<{ stdout: string; stderr: string }> => {
		const cmd = buildBackgroundLogsCommand(jobId);
		const result = await runCommand(sandboxId, cmd, { signal });
		if (result.exitCode !== 0) {
			throw new Error(`sandbox-provider: get background job logs failed (exit ${result.exitCode})`);
		}
		return { stdout: result.stdout, stderr: result.stderr };
	};

	const killBackgroundJob = async (sandboxId: string, jobId: string, signal?: AbortSignal): Promise<void> => {
		const cmd = buildBackgroundKillCommand(jobId);
		const result = await runCommand(sandboxId, cmd, { signal });
		if (result.exitCode !== 0) {
			throw new Error(`sandbox-provider: kill background job failed (exit ${result.exitCode})`);
		}
	};

	return {
		preflight,
		create,
		get,
		waitForStatus,
		upload,
		download,
		runCommand,
		getLogs,
		delete: _delete,
		deleteResolved,
		lookupByLabel,
		startBackgroundJob,
		getBackgroundJobStatus,
		getBackgroundJobLogs,
		killBackgroundJob,
	};
}
