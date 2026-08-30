import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseAvoSupervisorPayload } from "./supervisor.js";

export const AVO_PYTHON_PROBE_BROKER_SOCKET_ENV = "PRIME_AGENT_INTERNAL_AVO_PROBE_BROKER_SOCKET";
export const AVO_PYTHON_PROBE_BROKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_AVO_PROBE_BROKER_TOKEN";

export type AvoProbeJsonValue =
	| null
	| boolean
	| number
	| string
	| AvoProbeJsonValue[]
	| { [key: string]: AvoProbeJsonValue };

export interface AvoPythonProbeExpectation {
	kind: "return" | "raises";
	value?: AvoProbeJsonValue;
	error?: string;
}

export interface AvoPythonProbeCase {
	caseId: string;
	callable: string;
	requirementIds: string[];
	args: AvoProbeJsonValue[];
	kwargs: Record<string, AvoProbeJsonValue>;
	expect: AvoPythonProbeExpectation;
}

export interface AvoPythonProbePlan {
	probeVersion: 1;
	runtime: "python_call_v1";
	modulePath: string;
	cases: AvoPythonProbeCase[];
}

export interface AvoPythonProbeBindings {
	modulePaths: readonly string[];
	requiredCallables: readonly string[];
	requirementIds: readonly string[];
	minimumCases: number;
	maximumCases: number;
	minimumCrossRequirementCases: number;
	minimumDistinctRequirements: number;
}

export interface AvoPythonProbeCaseResult {
	caseId: string;
	status: "pass" | "fail";
	actual?: AvoProbeJsonValue;
	expected?: AvoProbeJsonValue;
	error?: string;
}

export interface AvoPythonProbeReport {
	reportVersion: 1;
	passed: boolean;
	results: AvoPythonProbeCaseResult[];
}

export interface AvoPythonProbeExecution {
	report?: AvoPythonProbeReport;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
	error?: string;
}

export interface AvoPythonProbeBrokerHandle {
	socketPath: string;
	token: string;
	close(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) throw new Error(`${label} contains unknown field ${unexpected[0]}`);
}

function requiredString(value: unknown, label: string, pattern?: RegExp): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
	const normalized = value.trim();
	if (normalized.length > 512) throw new Error(`${label} exceeds 512 characters`);
	if (pattern && !pattern.test(normalized)) throw new Error(`${label} has an invalid format`);
	return normalized;
}

function parseJsonValue(value: unknown, label: string, depth = 0): AvoProbeJsonValue {
	if (depth > 8) throw new Error(`${label} exceeds the JSON nesting limit`);
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		if (typeof value === "string" && value.length > 4_096) throw new Error(`${label} string exceeds 4096 characters`);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${label} numbers must be finite`);
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) throw new Error(`${label} arrays may contain at most 64 values`);
		return value.map((item, index) => parseJsonValue(item, `${label}[${index}]`, depth + 1));
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		if (entries.length > 64) throw new Error(`${label} objects may contain at most 64 fields`);
		return Object.fromEntries(
			entries.map(([key, item]) => {
				if (!key || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) {
					throw new Error(`${label} contains an invalid object key`);
				}
				return [key, parseJsonValue(item, `${label}.${key}`, depth + 1)];
			}),
		);
	}
	throw new Error(`${label} must be JSON-compatible`);
}

function parseBrokerPlan(value: unknown): AvoPythonProbePlan {
	if (!isRecord(value)) throw new Error("probe broker plan must be an object");
	assertKnownKeys(value, ["probeVersion", "runtime", "modulePath", "cases"], "probe broker plan");
	if (value.probeVersion !== 1 || value.runtime !== "python_call_v1") {
		throw new Error("probe broker plan uses an unsupported protocol");
	}
	const modulePath = requiredString(value.modulePath, "probe broker plan.modulePath");
	if (
		isAbsolute(modulePath) ||
		!modulePath.endsWith(".py") ||
		modulePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
	) {
		throw new Error("probe broker plan.modulePath must be a bounded relative Python path");
	}
	if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 8) {
		throw new Error("probe broker plan.cases must contain 1-8 cases");
	}
	const cases = value.cases.map((item, index): AvoPythonProbeCase => {
		if (!isRecord(item)) throw new Error(`probe broker plan.cases[${index}] must be an object`);
		assertKnownKeys(
			item,
			["caseId", "callable", "requirementIds", "args", "kwargs", "expect"],
			`probe broker plan.cases[${index}]`,
		);
		const caseId = requiredString(
			item.caseId,
			`probe broker plan.cases[${index}].caseId`,
			/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
		);
		const callable = requiredString(
			item.callable,
			`probe broker plan.cases[${index}].callable`,
			/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/,
		);
		if (!Array.isArray(item.requirementIds) || item.requirementIds.length < 1 || item.requirementIds.length > 3) {
			throw new Error(`probe broker plan.cases[${index}].requirementIds must contain 1-3 IDs`);
		}
		const requirementIds = item.requirementIds.map((requirementId, requirementIndex) =>
			requiredString(requirementId, `probe broker plan.cases[${index}].requirementIds[${requirementIndex}]`),
		);
		if (!Array.isArray(item.args) || item.args.length > 8) {
			throw new Error(`probe broker plan.cases[${index}].args must contain at most 8 values`);
		}
		const args = item.args.map((argument, argumentIndex) =>
			parseJsonValue(argument, `probe broker plan.cases[${index}].args[${argumentIndex}]`),
		);
		if (!isRecord(item.kwargs) || Object.keys(item.kwargs).length > 8) {
			throw new Error(`probe broker plan.cases[${index}].kwargs must contain at most 8 fields`);
		}
		const kwargs = Object.fromEntries(
			Object.entries(item.kwargs).map(([key, argument]) => [
				requiredString(key, `probe broker plan.cases[${index}].kwargs key`, /^[A-Za-z][A-Za-z0-9_]{0,63}$/),
				parseJsonValue(argument, `probe broker plan.cases[${index}].kwargs.${key}`),
			]),
		);
		if (!isRecord(item.expect)) throw new Error(`probe broker plan.cases[${index}].expect must be an object`);
		const expectValue = item.expect;
		const expect: AvoPythonProbeExpectation =
			expectValue.kind === "return"
				? {
						kind: "return",
						value: parseJsonValue(expectValue.value, `probe broker plan.cases[${index}].expect.value`),
					}
				: expectValue.kind === "raises"
					? {
							kind: "raises",
							error: requiredString(
								expectValue.error,
								`probe broker plan.cases[${index}].expect.error`,
								/^[A-Za-z][A-Za-z0-9_]{0,63}$/,
							),
						}
					: (() => {
							throw new Error(`probe broker plan.cases[${index}].expect.kind is invalid`);
						})();
		return { caseId, callable, requirementIds, args, kwargs, expect };
	});
	if (new Set(cases.map((item) => item.caseId)).size !== cases.length) {
		throw new Error("probe broker plan contains duplicate case IDs");
	}
	return { probeVersion: 1, runtime: "python_call_v1", modulePath, cases };
}

export function parseAvoPythonProbePlan(
	message: string,
	expectedCycleId: string,
	bindings: AvoPythonProbeBindings,
): AvoPythonProbePlan {
	const payload = parseAvoSupervisorPayload(message, expectedCycleId);
	if (!isRecord(payload.probe_plan)) throw new Error("supervisor response omitted probe_plan");
	const value = payload.probe_plan;
	if (JSON.stringify(value).length > 12_000) throw new Error("probe_plan exceeds 12000 serialized characters");
	assertKnownKeys(value, ["probe_version", "runtime", "module_path", "cases"], "probe_plan");
	if (value.probe_version !== 1) throw new Error("probe_plan.probe_version must be 1");
	if (value.runtime !== "python_call_v1") throw new Error("probe_plan.runtime must be python_call_v1");
	const modulePath = requiredString(value.module_path, "probe_plan.module_path");
	if (!modulePath.endsWith(".py") || !bindings.modulePaths.includes(modulePath)) {
		throw new Error("probe_plan.module_path must name a host-exposed Python source file");
	}
	if (
		!Array.isArray(value.cases) ||
		value.cases.length < bindings.minimumCases ||
		value.cases.length > bindings.maximumCases
	) {
		throw new Error(`probe_plan.cases must contain ${bindings.minimumCases}-${bindings.maximumCases} cases`);
	}
	const caseIds = new Set<string>();
	const coveredRequirements = new Set<string>();
	let crossRequirementCases = 0;
	const cases = value.cases.map((rawCase, index): AvoPythonProbeCase => {
		if (!isRecord(rawCase)) throw new Error(`probe_plan.cases[${index}] must be an object`);
		assertKnownKeys(
			rawCase,
			["case_id", "callable", "requirement_ids", "args", "kwargs", "expect"],
			`probe_plan.cases[${index}]`,
		);
		const caseId = requiredString(
			rawCase.case_id,
			`probe_plan.cases[${index}].case_id`,
			/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
		);
		if (caseIds.has(caseId)) throw new Error(`probe_plan contains duplicate case_id ${caseId}`);
		caseIds.add(caseId);
		const callable = requiredString(
			rawCase.callable,
			`probe_plan.cases[${index}].callable`,
			/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/,
		);
		if (
			!Array.isArray(rawCase.requirement_ids) ||
			rawCase.requirement_ids.length < 1 ||
			rawCase.requirement_ids.length > 3
		) {
			throw new Error(`probe_plan.cases[${index}].requirement_ids must contain 1-3 IDs`);
		}
		const requirementIds = rawCase.requirement_ids.map((item, requirementIndex) =>
			requiredString(item, `probe_plan.cases[${index}].requirement_ids[${requirementIndex}]`),
		);
		if (new Set(requirementIds).size !== requirementIds.length) {
			throw new Error(`probe_plan.cases[${index}] repeats a requirement ID`);
		}
		if (!requirementIds.every((requirementId) => bindings.requirementIds.includes(requirementId))) {
			throw new Error(`probe_plan.cases[${index}] references a non-host requirement ID`);
		}
		for (const requirementId of requirementIds) coveredRequirements.add(requirementId);
		if (requirementIds.length >= 2) crossRequirementCases += 1;
		if (!Array.isArray(rawCase.args) || rawCase.args.length > 8) {
			throw new Error(`probe_plan.cases[${index}].args must contain at most 8 JSON values`);
		}
		const args = rawCase.args.map((item, argIndex) =>
			parseJsonValue(item, `probe_plan.cases[${index}].args[${argIndex}]`),
		);
		const rawKwargs = rawCase.kwargs ?? {};
		if (!isRecord(rawKwargs) || Object.keys(rawKwargs).length > 8) {
			throw new Error(`probe_plan.cases[${index}].kwargs must contain at most 8 fields`);
		}
		const kwargs = Object.fromEntries(
			Object.entries(rawKwargs).map(([key, item]) => [
				requiredString(key, `probe_plan.cases[${index}].kwargs key`, /^[A-Za-z][A-Za-z0-9_]{0,63}$/),
				parseJsonValue(item, `probe_plan.cases[${index}].kwargs.${key}`),
			]),
		);
		if (!isRecord(rawCase.expect)) throw new Error(`probe_plan.cases[${index}].expect must be an object`);
		const rawExpect = rawCase.expect;
		if (rawExpect.kind === "return") {
			assertKnownKeys(rawExpect, ["kind", "value"], `probe_plan.cases[${index}].expect`);
			if (!("value" in rawExpect)) throw new Error(`probe_plan.cases[${index}].expect.value is required`);
			return {
				caseId,
				callable,
				requirementIds,
				args,
				kwargs,
				expect: {
					kind: "return",
					value: parseJsonValue(rawExpect.value, `probe_plan.cases[${index}].expect.value`),
				},
			};
		}
		if (rawExpect.kind === "raises") {
			assertKnownKeys(rawExpect, ["kind", "error"], `probe_plan.cases[${index}].expect`);
			return {
				caseId,
				callable,
				requirementIds,
				args,
				kwargs,
				expect: {
					kind: "raises",
					error: requiredString(
						rawExpect.error,
						`probe_plan.cases[${index}].expect.error`,
						/^[A-Za-z][A-Za-z0-9_]{0,63}$/,
					),
				},
			};
		}
		throw new Error(`probe_plan.cases[${index}].expect.kind must be return or raises`);
	});
	if (crossRequirementCases < bindings.minimumCrossRequirementCases) {
		throw new Error(`probe_plan requires at least ${bindings.minimumCrossRequirementCases} cross-requirement cases`);
	}
	if (coveredRequirements.size < bindings.minimumDistinctRequirements) {
		throw new Error(`probe_plan requires at least ${bindings.minimumDistinctRequirements} distinct requirement IDs`);
	}
	for (const requiredCallable of bindings.requiredCallables) {
		const callableCases = cases.filter((item) => item.callable === requiredCallable);
		if (callableCases.length === 0) {
			throw new Error(`probe_plan must exercise host-required callable ${requiredCallable}`);
		}
		if (bindings.minimumCrossRequirementCases > 0 && !callableCases.some((item) => item.requirementIds.length >= 2)) {
			throw new Error(`probe_plan requires a cross-requirement case for callable ${requiredCallable}`);
		}
	}
	return { probeVersion: 1, runtime: "python_call_v1", modulePath, cases };
}

export const AVO_PYTHON_PROBE_RESULT_MARKER = "AVO_PYTHON_PROBE_RESULT:";

export function parseAvoPythonProbeReport(stdout: string, expectedCaseIds: readonly string[]): AvoPythonProbeReport {
	const line = stdout
		.split(/\r?\n/)
		.reverse()
		.find((item) => item.startsWith(AVO_PYTHON_PROBE_RESULT_MARKER));
	if (!line) throw new Error("probe runner produced no host-runner result envelope");
	const raw = JSON.parse(line.slice(AVO_PYTHON_PROBE_RESULT_MARKER.length)) as unknown;
	if (!isRecord(raw) || raw.report_version !== 1 || typeof raw.passed !== "boolean" || !Array.isArray(raw.results)) {
		throw new Error("probe runner returned an invalid result envelope");
	}
	if (raw.results.length !== expectedCaseIds.length) throw new Error("probe runner returned the wrong case count");
	const expectedIds = new Set(expectedCaseIds);
	const observedIds = new Set<string>();
	const results = raw.results.map((item, index): AvoPythonProbeCaseResult => {
		if (!isRecord(item)) throw new Error(`probe result ${index} must be an object`);
		const caseId = requiredString(item.case_id, `probe result ${index}.case_id`);
		if (!expectedIds.has(caseId) || observedIds.has(caseId))
			throw new Error("probe runner returned an invalid case ID");
		observedIds.add(caseId);
		if (item.status !== "pass" && item.status !== "fail") throw new Error("probe result status is invalid");
		return {
			caseId,
			status: item.status,
			actual: item.actual === undefined ? undefined : parseJsonValue(item.actual, `probe result ${index}.actual`),
			expected:
				item.expected === undefined ? undefined : parseJsonValue(item.expected, `probe result ${index}.expected`),
			error: item.error === undefined ? undefined : requiredString(item.error, `probe result ${index}.error`),
		};
	});
	const passed = results.every((item) => item.status === "pass");
	if (raw.passed !== passed) throw new Error("probe runner aggregate status is inconsistent");
	return { reportVersion: 1, passed, results };
}

export const AVO_PYTHON_PROBE_RUNNER = `
import contextlib
import importlib.util
import io
import json
import math
import pathlib
import sys

MARKER = "AVO_PYTHON_PROBE_RESULT:"
WORKSPACE = pathlib.Path("/tmp/workspace").resolve()

def normalize(value, depth=0):
    if depth > 8:
        return {"__unsupported__": "depth"}
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else {"__unsupported__": "non_finite_float"}
    if isinstance(value, (list, tuple)):
        return [normalize(item, depth + 1) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: normalize(item, depth + 1) for key, item in value.items()}
    return {"__unsupported__": type(value).__name__, "repr": repr(value)[:500]}

def resolve_callable(module, dotted_name):
    target = module
    for part in dotted_name.split("."):
        if part.startswith("_"):
            raise AttributeError("private callables are forbidden")
        target = getattr(target, part)
    if not callable(target):
        raise TypeError("probe target is not callable")
    return target

def main():
    plan_path = pathlib.Path(sys.argv[1])
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    module_path = (WORKSPACE / plan["modulePath"]).resolve(strict=True)
    module_path.relative_to(WORKSPACE)
    sys.path.insert(0, str(WORKSPACE))
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            spec = importlib.util.spec_from_file_location("avo_candidate_probe_module", module_path)
            if spec is None or spec.loader is None:
                raise ImportError("could not load candidate module")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
    except BaseException as exc:
        results = [
            {"case_id": case["caseId"], "status": "fail", "error": f"module import failed: {type(exc).__name__}: {exc}"[:500]}
            for case in plan["cases"]
        ]
        print(MARKER + json.dumps({"report_version": 1, "passed": False, "results": results}, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
        return 1
    results = []
    for case in plan["cases"]:
        expected = case["expect"]
        try:
            target = resolve_callable(module, case["callable"])
            with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
                actual = target(*case["args"], **case["kwargs"])
            normalized = normalize(actual)
            if expected["kind"] == "return":
                wanted = expected.get("value")
                passed = normalized == wanted
                results.append({"case_id": case["caseId"], "status": "pass" if passed else "fail", "actual": normalized, "expected": wanted})
            else:
                results.append({"case_id": case["caseId"], "status": "fail", "actual": normalized, "error": f"expected {expected.get('error')}"})
        except BaseException as exc:
            passed = expected["kind"] == "raises" and type(exc).__name__ == expected.get("error")
            results.append({"case_id": case["caseId"], "status": "pass" if passed else "fail", "error": f"{type(exc).__name__}: {exc}"[:500], "expected": expected.get("error")})
    passed = all(item["status"] == "pass" for item in results)
    print(MARKER + json.dumps({"report_version": 1, "passed": passed, "results": results}, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
`.trim();

export function canExecuteAvoPythonProbe(): boolean {
	const brokerConfigured =
		Boolean(process.env[AVO_PYTHON_PROBE_BROKER_SOCKET_ENV]) &&
		Boolean(process.env[AVO_PYTHON_PROBE_BROKER_TOKEN_ENV]);
	return (
		brokerConfigured ||
		(process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/python3"))
	);
}

async function executeAvoPythonProbeLocalSandbox(
	workspace: string,
	plan: AvoPythonProbePlan,
): Promise<AvoPythonProbeExecution> {
	if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) {
		return {
			exitCode: null,
			timedOut: false,
			truncated: false,
			stdout: "",
			stderr: "",
			durationMs: 0,
			error: "isolated Python probe execution requires Linux, /usr/bin/bwrap, and /usr/bin/python3",
		};
	}
	const temporaryRoot = mkdtempSync(join(tmpdir(), "prime-avo-probe-"));
	const planPath = join(temporaryRoot, "plan.json");
	const runnerPath = join(temporaryRoot, "runner.py");
	writeFileSync(planPath, JSON.stringify(plan), { encoding: "utf8", mode: 0o600 });
	writeFileSync(runnerPath, AVO_PYTHON_PROBE_RUNNER, { encoding: "utf8", mode: 0o500 });
	const startedAt = Date.now();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let truncated = false;
	let executionError: string | undefined;
	let exitCode: number | null = null;
	try {
		const args = [
			"--ro-bind",
			"/",
			"/",
			"--dev-bind",
			"/dev",
			"/dev",
			"--proc",
			"/proc",
			"--tmpfs",
			"/tmp",
			"--tmpfs",
			homedir(),
			"--dir",
			"/tmp/workspace",
			"--ro-bind",
			workspace,
			"/tmp/workspace",
			"--dir",
			"/tmp/probe",
			"--ro-bind",
			runnerPath,
			"/tmp/probe/runner.py",
			"--ro-bind",
			planPath,
			"/tmp/probe/plan.json",
			"--unshare-net",
			"--unshare-pid",
			"--die-with-parent",
			"--clearenv",
			"--setenv",
			"HOME",
			"/tmp",
			"--setenv",
			"PATH",
			"/usr/bin:/bin",
			"--chdir",
			"/tmp/workspace",
			"--",
			"/usr/bin/python3",
			"-I",
			"-B",
			"/tmp/probe/runner.py",
			"/tmp/probe/plan.json",
		];
		const processResult = await new Promise<{ exitCode: number | null; error?: string }>((resolveResult) => {
			const child = spawn("/usr/bin/bwrap", args, {
				cwd: workspace,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (result: { exitCode: number | null; error?: string }) => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				resolveResult(result);
			};
			const append = (target: "stdout" | "stderr", chunk: Buffer) => {
				const current = target === "stdout" ? stdout : stderr;
				if (current.length >= 64_000) return;
				const next = `${current}${chunk.toString("utf8")}`;
				if (next.length > 64_000) {
					truncated = true;
					if (target === "stdout") stdout = next.slice(0, 64_000);
					else stderr = next.slice(0, 64_000);
					child.kill("SIGKILL");
					return;
				}
				if (target === "stdout") stdout = next;
				else stderr = next;
			};
			child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
			child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
			child.once("error", (error) => finish({ exitCode: null, error: error.message }));
			child.once("close", (code) => finish({ exitCode: code }));
			timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, 10_000);
		});
		exitCode = processResult.exitCode;
		executionError = processResult.error;
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
	let report: AvoPythonProbeReport | undefined;
	if (!executionError && !timedOut && !truncated) {
		try {
			report = parseAvoPythonProbeReport(
				stdout,
				plan.cases.map((item) => item.caseId),
			);
		} catch (error) {
			executionError = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		report,
		exitCode,
		timedOut,
		truncated,
		stdout,
		stderr,
		durationMs: Date.now() - startedAt,
		error: executionError,
	};
}

function brokerTokenMatches(expected: string, observed: unknown): boolean {
	if (typeof observed !== "string") return false;
	const expectedBuffer = Buffer.from(expected);
	const observedBuffer = Buffer.from(observed);
	return expectedBuffer.length === observedBuffer.length && timingSafeEqual(expectedBuffer, observedBuffer);
}

function parseBrokerExecution(value: unknown, plan: AvoPythonProbePlan): AvoPythonProbeExecution {
	if (!isRecord(value)) throw new Error("probe broker returned no execution object");
	const exitCode = value.exitCode === null || typeof value.exitCode === "number" ? value.exitCode : null;
	const timedOut = value.timedOut === true;
	const truncated = value.truncated === true;
	const stdout = typeof value.stdout === "string" ? value.stdout.slice(0, 64_000) : "";
	const stderr = typeof value.stderr === "string" ? value.stderr.slice(0, 64_000) : "";
	const durationMs = typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : 0;
	let error = typeof value.error === "string" ? value.error.slice(0, 1_000) : undefined;
	let report: AvoPythonProbeReport | undefined;
	if (!error && !timedOut && !truncated) {
		try {
			report = parseAvoPythonProbeReport(
				stdout,
				plan.cases.map((item) => item.caseId),
			);
		} catch (parseError) {
			error = parseError instanceof Error ? parseError.message : String(parseError);
		}
	}
	return { report, exitCode, timedOut, truncated, stdout, stderr, durationMs, error };
}

async function executeAvoPythonProbeViaBroker(
	socketPath: string,
	token: string,
	plan: AvoPythonProbePlan,
): Promise<AvoPythonProbeExecution> {
	return new Promise((resolveExecution) => {
		let settled = false;
		let response = "";
		const socket = createConnection(socketPath);
		const finish = (execution: AvoPythonProbeExecution) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolveExecution(execution);
		};
		const fail = (error: string) =>
			finish({
				exitCode: null,
				timedOut: false,
				truncated: false,
				stdout: "",
				stderr: "",
				durationMs: 0,
				error,
			});
		const timeout = setTimeout(() => fail("host probe broker timed out"), 15_000);
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ protocolVersion: 1, token, plan })}\n`);
		});
		socket.on("data", (chunk: string) => {
			response += chunk;
			if (response.length > 128_000) {
				fail("host probe broker response exceeded 128000 characters");
				return;
			}
			const newline = response.indexOf("\n");
			if (newline < 0) return;
			try {
				const parsed = JSON.parse(response.slice(0, newline)) as unknown;
				if (!isRecord(parsed) || parsed.protocolVersion !== 1) {
					fail("host probe broker returned an invalid protocol envelope");
					return;
				}
				if (typeof parsed.error === "string") {
					fail(`host probe broker rejected the request: ${parsed.error.slice(0, 1_000)}`);
					return;
				}
				finish(parseBrokerExecution(parsed.execution, plan));
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		});
		socket.once("error", (error) => fail(`host probe broker connection failed: ${error.message}`));
		socket.once("end", () => {
			if (!settled) fail("host probe broker closed without a result");
		});
	});
}

export async function executeAvoPythonProbeSandbox(
	workspace: string,
	plan: AvoPythonProbePlan,
): Promise<AvoPythonProbeExecution> {
	const socketPath = process.env[AVO_PYTHON_PROBE_BROKER_SOCKET_ENV];
	const token = process.env[AVO_PYTHON_PROBE_BROKER_TOKEN_ENV];
	if (socketPath && token) return executeAvoPythonProbeViaBroker(socketPath, token, plan);
	return executeAvoPythonProbeLocalSandbox(workspace, plan);
}

function brokerSocketDirectory(): string {
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
	if (runtimeDirectory && isAbsolute(runtimeDirectory) && existsSync(runtimeDirectory)) return runtimeDirectory;
	const fallback = join(homedir(), ".cache", "prime-agent", "probe-brokers");
	mkdirSync(fallback, { recursive: true, mode: 0o700 });
	return fallback;
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolveListen, rejectListen) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			rejectListen(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolveListen();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

export async function startAvoPythonProbeBroker(workspace: string): Promise<AvoPythonProbeBrokerHandle> {
	if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) {
		throw new Error("the host probe broker requires Linux, /usr/bin/bwrap, and /usr/bin/python3");
	}
	const token = randomBytes(32).toString("hex");
	const socketPath = join(
		brokerSocketDirectory(),
		`prime-avo-probe-${process.pid}-${randomBytes(8).toString("hex")}.sock`,
	);
	const server = createServer((socket) => {
		let requestText = "";
		let handled = false;
		const respond = (value: Record<string, unknown>) => {
			if (socket.destroyed) return;
			socket.end(`${JSON.stringify({ protocolVersion: 1, ...value })}\n`);
		};
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			if (handled) return;
			requestText += chunk;
			if (requestText.length > 64_000) {
				handled = true;
				respond({ error: "request exceeded 64000 characters" });
				return;
			}
			const newline = requestText.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			void (async () => {
				try {
					const request = JSON.parse(requestText.slice(0, newline)) as unknown;
					if (!isRecord(request) || request.protocolVersion !== 1 || !brokerTokenMatches(token, request.token)) {
						throw new Error("unauthorized or invalid broker request");
					}
					const plan = parseBrokerPlan(request.plan);
					const execution = await executeAvoPythonProbeLocalSandbox(workspace, plan);
					respond({ execution });
				} catch (error) {
					respond({
						error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
					});
				}
			})();
		});
	});
	await listenOnSocket(server, socketPath);
	chmodSync(socketPath, 0o600);
	return {
		socketPath,
		token,
		close: async () => {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			rmSync(socketPath, { force: true });
		},
	};
}
