/**
 * Home-private Prime CLI 0.6.21 sandbox lifecycle adapter.
 *
 * Consumes a narrow injected async runner; never spawns directly.
 * All handles, permissions, proofs are closure-private
 * WeakMap/WeakSet brands with no serializable fields.
 */

import { parsePrimeCliCreateOutput, parsePrimeCliVersionOutput } from "./prime-cli-create-version-codec.js";
import { parsePrimeSandboxGetOutput, parsePrimeSandboxListOutput } from "./prime-cli-json-codec.js";

// -- Port types --

export type RunnerSuccess = Readonly<{
	ok: true;
	value: Readonly<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>;
}>;

export type RunnerFailure = Readonly<{ ok: false; code: RunnerFailureCode }>;
export type RunnerFailureCode =
	| "INPUT_INVALID"
	| "SPAWN_FAILED"
	| "ABORTED"
	| "TIMED_OUT"
	| "OUTPUT_OVERFLOW"
	| "STREAM_FAILED"
	| "PROCESS_UNCERTAIN";
export type RunnerResult = RunnerSuccess | RunnerFailure;

export type RunCommand = (argv: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<RunnerResult>;

export type Clock = Readonly<{ now: () => number }>;
export type DelayResult = "elapsed" | "aborted";
export type DelayFn = (ms: number, signal?: AbortSignal) => Promise<DelayResult>;

// -- Config --

export type LifecycleConfig = Readonly<{
	primeCliPath: string;
	label: string;
	image: string;
	name: string;
	cpuCores: number;
	memoryGb: number;
	diskSizeGb: number;
	sandboxTimeoutMinutes: number;
	operationTimeoutMs: number;
	pollIntervalMs: number;
}>;

// -- Error types --

export type LifecycleErrorCode =
	| "CONFIG_REJECTED"
	| "VERSION_MISMATCH"
	| "COLLISION"
	| "RECOVERY_REQUIRED"
	| "READY_TERMINAL"
	| "DEADLINE_EXCEEDED"
	| "ABORTED"
	| "HANDLE_INVALID"
	| "TOKEN_INVALID"
	| "TOKEN_CONSUMED"
	| "DUPLICATE_DELETE"
	| "ABSENCE_UNCERTAIN"
	| "UNCERTAIN"
	| "INPUT_INVALID"
	| "POLL_LIMIT"
	| "PROOF_INVALID";

export type LifecycleError = Readonly<{ ok: false; code: LifecycleErrorCode }>;

// -- Nominal brand classes --

class SandboxHandleToken {
	private declare readonly _handle: undefined;
}
export type SandboxHandle = SandboxHandleToken;

class CreatePermissionToken {
	private declare readonly _permission: undefined;
}
export type CreatePermission = CreatePermissionToken;

class DeleteProofToken {
	private declare readonly _proof: undefined;
}
export type DeleteProof = DeleteProofToken;

export type InspectOutcome =
	| Readonly<{ ok: true; kind: "empty"; value: CreatePermission }>
	| Readonly<{ ok: true; kind: "single"; value: SandboxHandle }>
	| Readonly<{ ok: false; code: "COLLISION" }>
	| LifecycleError;

export interface SandboxLifecycle {
	inspect(signal?: AbortSignal): Promise<InspectOutcome>;
	create(
		permission: CreatePermission,
		signal?: AbortSignal,
	): Promise<Readonly<{ ok: true; value: SandboxHandle }> | LifecycleError>;
	waitUntilReady(
		handle: SandboxHandle,
		signal?: AbortSignal,
	): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: "READY_TERMINAL" }> | LifecycleError>;
	deleteAndProveAbsent(
		handle: SandboxHandle,
		signal?: AbortSignal,
	): Promise<Readonly<{ ok: true; value: DeleteProof }> | LifecycleError>;
}

export interface ProofConsumer {
	/** Consume one DeleteProof from this adapter. One-shot per proof. */
	consumeProof(proof: DeleteProof): Readonly<{ ok: true }> | LifecycleError;
}

export type SandboxLifecycleBundle = Readonly<{
	lifecycle: SandboxLifecycle;
	proofConsumer: ProofConsumer;
}>;

// -- Constants --

const MAX_PATH_BYTES = 4096;
const MAX_FIELD_BYTES = 512;
const MIN_TO = 100;
const MAX_TO = 600_000;
const PER_PAGE = 100;
const MAX_LIST_PAGES = 1000;
const MAX_TOTAL_ROWS = 100_000;
const MAX_READY_POLLS = 600;
const MAX_DELETE_POLLS = 600;

// -- Pure helpers --

function b8(s: string, max: number, empty: boolean): boolean {
	if (!empty && s.length === 0) return false;
	let b = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c <= 0x7f) {
			b += 1;
		} else if (c <= 0x7ff) {
			b += 2;
		} else if (c >= 0xd800 && c <= 0xdbff) {
			if (i + 1 >= s.length) return false;
			const n = s.charCodeAt(i + 1);
			if (n < 0xdc00 || n > 0xdfff) return false;
			b += 4;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return false;
		} else {
			b += 3;
		}
		if (b > max) return false;
	}
	return true;
}

function cf(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c <= 0x1f || c === 0x7f) return false;
	}
	return true;
}

function absPath(v: string): boolean {
	return typeof v === "string" && v.length > 0 && v.charCodeAt(0) === 0x2f && cf(v) && b8(v, MAX_PATH_BYTES, false);
}

function labelOk(v: string): boolean {
	return typeof v === "string" && b8(v, MAX_FIELD_BYTES, false) && cf(v);
}

function intGe1(v: number, max: number): boolean {
	return typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 1 && v <= max;
}

function err(c: LifecycleErrorCode): LifecycleError {
	return Object.freeze({ ok: false, code: c });
}

function toCap(ms: number): number | undefined {
	if (!Number.isFinite(ms)) return undefined;
	if (ms < MIN_TO) return undefined;
	return ms > MAX_TO ? MAX_TO : Math.floor(ms);
}

function od(source: object, key: string): unknown | undefined {
	try {
		const d = Object.getOwnPropertyDescriptor(source, key);
		if (d === undefined) return undefined;
		if (!Object.hasOwn(d, "value")) return undefined;
		return d.value;
	} catch {
		return undefined;
	}
}

function strictPlainObject(v: unknown): v is object {
	if (typeof v !== "object" || v === null) return false;
	try {
		const proto = Object.getPrototypeOf(v);
		if (proto !== Object.prototype && proto !== null) return false;
	} catch {
		return false;
	}
	return true;
}

function checkConfig(v: unknown): v is LifecycleConfig {
	if (!strictPlainObject(v)) return false;
	let ownKeys: readonly (string | symbol)[];
	try {
		ownKeys = Reflect.ownKeys(v);
	} catch {
		return false;
	}
	if (ownKeys.length !== 10) return false;
	const expected: Record<string, true> = {
		primeCliPath: true,
		label: true,
		image: true,
		name: true,
		cpuCores: true,
		memoryGb: true,
		diskSizeGb: true,
		sandboxTimeoutMinutes: true,
		operationTimeoutMs: true,
		pollIntervalMs: true,
	};
	for (const k of ownKeys) {
		if (typeof k !== "string") return false;
		if (!Object.hasOwn(expected, k)) return false;
	}
	for (const k of ownKeys) {
		if (typeof k !== "string") return false;
		const d = od(v, k);
		if (d === undefined) return false;
	}
	return true;
}

function exactOwnDataObject(v: unknown, expected: readonly string[]): v is object {
	if (!strictPlainObject(v)) return false;
	try {
		const ownKeys = Reflect.ownKeys(v);
		if (ownKeys.length !== expected.length) return false;
		for (const key of ownKeys) {
			if (typeof key !== "string" || !expected.includes(key)) return false;
			const descriptor = Object.getOwnPropertyDescriptor(v, key);
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function decodeSuccessValue(v: unknown): RunnerSuccess["value"] | undefined {
	if (!exactOwnDataObject(v, ["stdout", "stderr", "exitCode", "durationMs"])) return undefined;
	const stdout = od(v, "stdout");
	const stderr = od(v, "stderr");
	const exitCode = od(v, "exitCode");
	const durationMs = od(v, "durationMs");
	if (typeof stdout !== "string" || typeof stderr !== "string") return undefined;
	if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || !Number.isSafeInteger(exitCode)) return undefined;
	if (
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs) ||
		!Number.isSafeInteger(durationMs) ||
		durationMs < 0
	)
		return undefined;
	return Object.freeze({ stdout, stderr, exitCode, durationMs });
}

function validRunnerFailureCode(v: unknown): v is RunnerFailureCode {
	return (
		v === "INPUT_INVALID" ||
		v === "SPAWN_FAILED" ||
		v === "ABORTED" ||
		v === "TIMED_OUT" ||
		v === "OUTPUT_OVERFLOW" ||
		v === "STREAM_FAILED" ||
		v === "PROCESS_UNCERTAIN"
	);
}

function decodeRunnerResult(v: unknown): RunnerResult | undefined {
	if (!exactOwnDataObject(v, ["ok", "value"]) && !exactOwnDataObject(v, ["ok", "code"])) return undefined;
	const ok = od(v, "ok");
	if (ok === true) {
		const value = decodeSuccessValue(od(v, "value"));
		if (value === undefined) return undefined;
		return Object.freeze({ ok: true, value });
	}
	if (ok === false) {
		const code = od(v, "code");
		if (!validRunnerFailureCode(code)) return undefined;
		return Object.freeze({ ok: false, code });
	}
	return undefined;
}

function defaultDelay(ms: number, signal?: AbortSignal): Promise<DelayResult> {
	if (!Number.isFinite(ms) || ms < 0) return Promise.resolve("elapsed");
	return new Promise((resolve) => {
		if (signal !== undefined) {
			if (signal.aborted) {
				resolve("aborted");
				return;
			}
			const onAbort = (): void => {
				clearTimeout(timer);
				resolve("aborted");
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve("elapsed");
			}, ms);
			signal.addEventListener("abort", onAbort, { once: true });
		} else {
			setTimeout(() => resolve("elapsed"), ms);
		}
	});
}

// -- Typed result constructors --

function okEmpty(p: CreatePermission): InspectOutcome {
	return Object.freeze({ ok: true, kind: "empty", value: p });
}

function okSingle(h: SandboxHandle): InspectOutcome {
	return Object.freeze({ ok: true, kind: "single", value: h });
}

function collision(): InspectOutcome {
	return Object.freeze({ ok: false, code: "COLLISION" });
}

function okRunning(): Readonly<{ ok: true }> | Readonly<{ ok: false; code: "READY_TERMINAL" }> | LifecycleError {
	return Object.freeze({ ok: true });
}

function terminal(): Readonly<{ ok: true }> | Readonly<{ ok: false; code: "READY_TERMINAL" }> | LifecycleError {
	return Object.freeze({ ok: false, code: "READY_TERMINAL" });
}

function okResultCap(h: SandboxHandle): Readonly<{ ok: true; value: SandboxHandle }> | LifecycleError {
	return Object.freeze({ ok: true, value: h });
}

function okProof(p: DeleteProof): Readonly<{ ok: true; value: DeleteProof }> | LifecycleError {
	return Object.freeze({ ok: true, value: p });
}

function okProofConsumed(): Readonly<{ ok: true }> | LifecycleError {
	return Object.freeze({ ok: true });
}

// -- Factory --

export async function createSandboxLifecycle(
	runCommand: RunCommand,
	config: LifecycleConfig,
	clock?: Clock,
	delay?: DelayFn,
): Promise<Readonly<{ ok: true; value: SandboxLifecycleBundle }> | LifecycleError> {
	if (typeof runCommand !== "function") return err("CONFIG_REJECTED");

	if (!checkConfig(config)) return err("CONFIG_REJECTED");

	const primeCliPathRaw = od(config, "primeCliPath");
	const labelRaw = od(config, "label");
	const imageRaw = od(config, "image");
	const nameRaw = od(config, "name");
	const cpuCoresRaw = od(config, "cpuCores");
	const memoryGbRaw = od(config, "memoryGb");
	const diskSizeGbRaw = od(config, "diskSizeGb");
	const sandboxTimeoutMinutesRaw = od(config, "sandboxTimeoutMinutes");
	const operationTimeoutMsRaw = od(config, "operationTimeoutMs");
	const pollIntervalMsRaw = od(config, "pollIntervalMs");

	if (
		typeof primeCliPathRaw !== "string" ||
		typeof labelRaw !== "string" ||
		typeof imageRaw !== "string" ||
		typeof nameRaw !== "string" ||
		typeof cpuCoresRaw !== "number" ||
		typeof memoryGbRaw !== "number" ||
		typeof diskSizeGbRaw !== "number" ||
		typeof sandboxTimeoutMinutesRaw !== "number" ||
		typeof operationTimeoutMsRaw !== "number" ||
		typeof pollIntervalMsRaw !== "number"
	)
		return err("CONFIG_REJECTED");

	const primeCliPath: string = primeCliPathRaw;
	const label: string = labelRaw;
	const image: string = imageRaw;
	const name: string = nameRaw;
	const cpuCores: number = cpuCoresRaw;
	const memoryGb: number = memoryGbRaw;
	const diskSizeGb: number = diskSizeGbRaw;
	const sandboxTimeoutMinutes: number = sandboxTimeoutMinutesRaw;
	const operationTimeoutMs: number = operationTimeoutMsRaw;
	const pollIntervalMs: number = pollIntervalMsRaw;

	if (!absPath(primeCliPath) || !labelOk(label) || !labelOk(image) || !labelOk(name)) return err("CONFIG_REJECTED");
	if (image.length > 0 && image.charCodeAt(0) === 0x2d) return err("CONFIG_REJECTED");
	if (!intGe1(cpuCores, 1024) || !intGe1(memoryGb, 1_000_000) || !intGe1(diskSizeGb, 1_000_000))
		return err("CONFIG_REJECTED");
	if (
		!intGe1(sandboxTimeoutMinutes, 1_000_000) ||
		!intGe1(operationTimeoutMs, MAX_TO) ||
		!intGe1(pollIntervalMs, MAX_TO)
	)
		return err("CONFIG_REJECTED");

	// If clock is provided with a valid .now() function, use it; otherwise Date.now
	let clockNow: () => number;
	if (clock !== undefined) {
		try {
			const cd = Object.getOwnPropertyDescriptor(clock, "now");
			if (cd !== undefined && Object.hasOwn(cd, "value") && typeof cd.value === "function") {
				clockNow = cd.value;
			} else {
				clockNow = Date.now;
			}
		} catch {
			clockNow = Date.now;
		}
	} else {
		clockNow = Date.now;
	}

	let lastNow = Number.NEGATIVE_INFINITY;
	function readNow(): number | undefined {
		let t: number;
		try {
			t = clockNow();
		} catch {
			return undefined;
		}
		if (!Number.isFinite(t)) return undefined;
		if (t < lastNow) return undefined;
		lastNow = t;
		return t;
	}

	{
		const init = readNow();
		if (init === undefined) return err("CONFIG_REJECTED");
	}

	const safeDelay: DelayFn = typeof delay === "function" ? delay : defaultDelay;

	const gt = toCap(Math.min(operationTimeoutMs, 30_000));
	if (gt === undefined) return err("CONFIG_REJECTED");
	let vr: unknown;
	try {
		vr = await runCommand([primeCliPath, "--version"], gt);
	} catch {
		return err("VERSION_MISMATCH");
	}
	const versionResult = decodeRunnerResult(vr);
	if (versionResult === undefined || !versionResult.ok) return err("VERSION_MISMATCH");
	if (versionResult.value.exitCode !== 0 || versionResult.value.stderr !== "") return err("VERSION_MISMATCH");
	if (!parsePrimeCliVersionOutput(versionResult.value.stdout).ok) return err("VERSION_MISMATCH");

	// Closure-private state
	const handleIdMap = new WeakMap<SandboxHandleToken, string>();
	const deleteIssued = new WeakSet<SandboxHandleToken>();
	const createPerms = new WeakSet<CreatePermissionToken>();
	const createUsed = new WeakSet<CreatePermissionToken>();
	const proofSet = new WeakSet<DeleteProofToken>();
	const proofConsumed = new WeakSet<DeleteProofToken>();

	function newHandle(id: string): SandboxHandle {
		const o = new SandboxHandleToken();
		Object.freeze(o);
		handleIdMap.set(o, id);
		return o;
	}

	function newPerm(): CreatePermission {
		const o = new CreatePermissionToken();
		Object.freeze(o);
		createPerms.add(o);
		return o;
	}

	function tryUsePerm(p: CreatePermission): "invalid" | "used" | "ok" {
		if (!(p instanceof CreatePermissionToken)) return "invalid";
		if (!createPerms.has(p)) return "invalid";
		if (createUsed.has(p)) return "used";
		createUsed.add(p);
		return "ok";
	}

	function newProof(): DeleteProof {
		const o = new DeleteProofToken();
		Object.freeze(o);
		proofSet.add(o);
		return o;
	}

	function tryUseProof(p: DeleteProof): boolean {
		if (!(p instanceof DeleteProofToken)) return false;
		if (!proofSet.has(p)) return false;
		if (proofConsumed.has(p)) return false;
		proofConsumed.add(p);
		return true;
	}

	function remaining(deadline: number): number | LifecycleError {
		const n = readNow();
		if (n === undefined) return err("UNCERTAIN");
		const r = deadline - n;
		if (!Number.isFinite(r)) return err("UNCERTAIN");
		if (r < MIN_TO) return err("DEADLINE_EXCEEDED");
		const capped = r > MAX_TO ? MAX_TO : Math.floor(r);
		return capped;
	}

	function unpackRunner(r: unknown): Readonly<{ ok: true; stdout: string }> | LifecycleError {
		const decoded = decodeRunnerResult(r);
		if (decoded === undefined) return err("UNCERTAIN");
		if (!decoded.ok) {
			if (decoded.code === "INPUT_INVALID") return err("INPUT_INVALID");
			if (decoded.code === "ABORTED") return err("ABORTED");
			return err("UNCERTAIN");
		}
		if (decoded.value.exitCode !== 0 || decoded.value.stderr !== "") return err("UNCERTAIN");
		return Object.freeze({ ok: true, stdout: decoded.value.stdout });
	}

	async function runCE(
		argv: readonly string[],
		toMs: number,
		sig?: AbortSignal,
	): Promise<Readonly<{ ok: true; stdout: string }> | LifecycleError> {
		if (sig !== undefined && sig.aborted) return err("ABORTED");
		const t = toCap(toMs);
		if (t === undefined) return err("INPUT_INVALID");
		let res: unknown;
		try {
			res = await runCommand(argv, t, sig);
		} catch {
			return err("UNCERTAIN");
		}
		return unpackRunner(res);
	}

	async function boundedDelay(
		dm: number,
		deadline: number,
		sig?: AbortSignal,
	): Promise<LifecycleError | "elapsed" | "aborted"> {
		const pr = remaining(deadline);
		if (typeof pr !== "number") return pr;
		if (sig !== undefined && sig.aborted) return "aborted";

		const actualMs = Math.min(dm, pr, MAX_TO);

		if (safeDelay === defaultDelay) {
			try {
				const dr = await defaultDelay(actualMs, sig);
				if (dr !== "elapsed" && dr !== "aborted") return err("UNCERTAIN");
				if (sig !== undefined && sig.aborted) return "aborted";
				return dr;
			} catch {
				return err("UNCERTAIN");
			}
		} else {
			// Injected delay: race against a trusted, disposable guard.
			const guardController = new AbortController();
			const abortGuard = (): void => guardController.abort();
			if (sig !== undefined) {
				if (sig.aborted) guardController.abort();
				else {
					sig.addEventListener("abort", abortGuard, { once: true });
					if (sig.aborted) guardController.abort();
				}
			}
			const guard = defaultDelay(actualMs, guardController.signal);
			try {
				const result = await Promise.race([
					safeDelay(actualMs, sig),
					guard.then((guardResult) => (guardResult === "aborted" ? "aborted" : "guard-timeout")),
				]);
				if (result === "guard-timeout") return err("UNCERTAIN");
				if (result !== "elapsed" && result !== "aborted") return err("UNCERTAIN");
				if (sig !== undefined && sig.aborted) return "aborted";
				return result;
			} catch {
				return err("UNCERTAIN");
			} finally {
				if (sig !== undefined) sig.removeEventListener("abort", abortGuard);
				guardController.abort();
			}
		}
	}

	async function scanAll(
		deadline: number,
		sig?: AbortSignal,
	): Promise<
		Readonly<{ ok: true; rows: readonly Readonly<{ id: string; status: string }>[]; total: number }> | LifecycleError
	> {
		if (sig !== undefined && sig.aborted) return err("ABORTED");

		const all: Array<Readonly<{ id: string; status: string }>> = [];
		const seenIds = new Set<string>();
		let page = 1;
		let vTotal = -1;
		let completed = false;

		while (page <= MAX_LIST_PAGES) {
			const r = remaining(deadline);
			if (typeof r !== "number") return r;
			if (sig !== undefined && sig.aborted) return err("ABORTED");

			const r2 = await runCE(
				[
					primeCliPath,
					"--plain",
					"sandbox",
					"list",
					"--label",
					label,
					"--page",
					String(page),
					"--num",
					"100",
					"--output",
					"json",
				],
				r,
				sig,
			);
			if (!r2.ok) return r2;

			const p = parsePrimeSandboxListOutput(r2.stdout, label);
			if (!p.ok) return err("UNCERTAIN");

			const l = p.value;
			if (l.perPage !== PER_PAGE || l.page !== page) return err("UNCERTAIN");
			if (vTotal < 0) vTotal = l.total;
			if (vTotal !== l.total) return err("UNCERTAIN");
			if (vTotal > MAX_TOTAL_ROWS) return err("UNCERTAIN");
			if (l.sandboxes.length > l.perPage) return err("UNCERTAIN");

			for (const row of l.sandboxes) {
				if (seenIds.has(row.id)) return err("UNCERTAIN");
				seenIds.add(row.id);
				all.push(Object.freeze({ id: row.id, status: row.status }));
			}

			if (!l.hasNext) {
				completed = true;
				break;
			}
			page++;
		}

		if (!completed) return err("UNCERTAIN");
		if (all.length !== vTotal) return err("UNCERTAIN");
		return Object.freeze({ ok: true, rows: Object.freeze(all), total: vTotal });
	}

	const lifecycle: SandboxLifecycle = Object.freeze({
		async inspect(sig?: AbortSignal): Promise<InspectOutcome> {
			if (sig !== undefined && sig.aborted) return err("ABORTED");
			const start = readNow();
			if (start === undefined) return err("UNCERTAIN");
			const d = start + operationTimeoutMs;

			const s = await scanAll(d, sig);
			if (!s.ok) return s;

			if (s.rows.length === 0) return okEmpty(newPerm());
			for (const r of s.rows) {
				if (r.status === "TERMINATED") return err("UNCERTAIN");
			}
			if (s.rows.length > 1) return collision();

			const row = s.rows[0];
			const gr = remaining(d);
			if (typeof gr !== "number") return gr;
			if (sig !== undefined && sig.aborted) return err("ABORTED");

			const g = await runCE([primeCliPath, "--plain", "sandbox", "get", row.id, "--output", "json"], gr, sig);
			if (!g.ok) return g;

			const gp = parsePrimeSandboxGetOutput(g.stdout, row.id, label);
			if (!gp.ok || gp.value.vm || gp.value.type !== "Container") return err("UNCERTAIN");

			return okSingle(newHandle(gp.value.id));
		},

		async create(
			perm: CreatePermission,
			sig?: AbortSignal,
		): Promise<Readonly<{ ok: true; value: SandboxHandle }> | LifecycleError> {
			if (sig !== undefined && sig.aborted) return err("ABORTED");
			const permStatus = tryUsePerm(perm);
			if (permStatus !== "ok") {
				return permStatus === "invalid" ? err("TOKEN_INVALID") : err("TOKEN_CONSUMED");
			}

			const start = readNow();
			if (start === undefined) return err("UNCERTAIN");
			const d = start + operationTimeoutMs;

			const cr = remaining(d);
			if (typeof cr !== "number") return err("DEADLINE_EXCEEDED");
			if (sig !== undefined && sig.aborted) return err("ABORTED");

			const cResult = await runCE(
				[
					primeCliPath,
					"--plain",
					"sandbox",
					"create",
					image,
					"--name",
					name,
					"--cpu-cores",
					String(cpuCores),
					"--memory-gb",
					String(memoryGb),
					"--disk-size-gb",
					String(diskSizeGb),
					"--timeout-minutes",
					String(sandboxTimeoutMinutes),
					"--label",
					label,
					"--yes",
				],
				cr,
				sig,
			);
			if (!cResult.ok) return err("RECOVERY_REQUIRED");

			const cp = parsePrimeCliCreateOutput(cResult.stdout);
			if (!cp.ok) return err("RECOVERY_REQUIRED");

			const nid = cp.value.id;
			const ggr = remaining(d);
			if (typeof ggr !== "number") return err("RECOVERY_REQUIRED");
			if (sig !== undefined && sig.aborted) return err("RECOVERY_REQUIRED");

			const g = await runCE([primeCliPath, "--plain", "sandbox", "get", nid, "--output", "json"], ggr, sig);
			if (!g.ok) return err("RECOVERY_REQUIRED");

			const gp = parsePrimeSandboxGetOutput(g.stdout, nid, label);
			if (!gp.ok || gp.value.vm || gp.value.type !== "Container") return err("RECOVERY_REQUIRED");

			return okResultCap(newHandle(gp.value.id));
		},

		async waitUntilReady(
			h: SandboxHandle,
			sig?: AbortSignal,
		): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: "READY_TERMINAL" }> | LifecycleError> {
			if (sig !== undefined && sig.aborted) return err("ABORTED");
			if (!(h instanceof SandboxHandleToken)) return err("HANDLE_INVALID");
			const id = handleIdMap.get(h);
			if (id === undefined) return err("HANDLE_INVALID");

			const start = readNow();
			if (start === undefined) return err("UNCERTAIN");
			const d = start + operationTimeoutMs;

			let polls = 0;
			while (polls < MAX_READY_POLLS) {
				polls++;
				if (sig !== undefined && sig.aborted) return err("ABORTED");
				const r = remaining(d);
				if (typeof r !== "number") return r;

				const g = await runCE([primeCliPath, "--plain", "sandbox", "get", id, "--output", "json"], r, sig);
				if (!g.ok) {
					if (g.code === "ABORTED") return g;
					return err("UNCERTAIN");
				}

				const gp = parsePrimeSandboxGetOutput(g.stdout, id, label);
				if (!gp.ok) return err("UNCERTAIN");

				const detail = gp.value;
				if (detail.vm || detail.type !== "Container") return err("UNCERTAIN");

				const s = detail.status;
				if (s === "RUNNING") return okRunning();
				if (s === "ERROR" || s === "TIMEOUT" || s === "TERMINATED") return terminal();

				const dr = await boundedDelay(pollIntervalMs, d, sig);
				if (dr === "aborted") return err("ABORTED");
				if (typeof dr === "object" && !dr.ok) return dr;
			}
			return err("POLL_LIMIT");
		},

		async deleteAndProveAbsent(
			h: SandboxHandle,
			sig?: AbortSignal,
		): Promise<Readonly<{ ok: true; value: DeleteProof }> | LifecycleError> {
			if (sig !== undefined && sig.aborted) return err("ABORTED");
			if (!(h instanceof SandboxHandleToken)) return err("HANDLE_INVALID");
			const id = handleIdMap.get(h);
			if (id === undefined) return err("HANDLE_INVALID");

			if (deleteIssued.has(h)) return err("DUPLICATE_DELETE");
			deleteIssued.add(h);

			const start = readNow();
			if (start === undefined) return err("UNCERTAIN");
			const d = start + operationTimeoutMs;

			const dr = remaining(d);
			if (typeof dr === "number" && (sig === undefined || !sig.aborted)) {
				await runCE([primeCliPath, "--plain", "sandbox", "delete", id, "--yes"], dr, sig);
			}

			let polls = 0;
			while (polls < MAX_DELETE_POLLS) {
				polls++;
				if (sig !== undefined && sig.aborted) return err("ABORTED");
				const s = await scanAll(d, sig);
				if (!s.ok) {
					if (s.code === "DEADLINE_EXCEEDED" || s.code === "ABORTED") return s;
					return err("ABSENCE_UNCERTAIN");
				}

				if (s.total === 0) return okProof(newProof());

				const dr2 = await boundedDelay(pollIntervalMs, d, sig);
				if (dr2 === "aborted") return err("ABORTED");
				if (typeof dr2 === "object" && !dr2.ok) return dr2;
			}
			return err("POLL_LIMIT");
		},
	});

	const proofConsumer: ProofConsumer = Object.freeze({
		consumeProof(proof: DeleteProof): Readonly<{ ok: true }> | LifecycleError {
			if (!tryUseProof(proof)) return err("PROOF_INVALID");
			return okProofConsumed();
		},
	});

	const bundle: SandboxLifecycleBundle = Object.freeze({
		lifecycle,
		proofConsumer,
	});

	return Object.freeze({ ok: true, value: bundle });
}
