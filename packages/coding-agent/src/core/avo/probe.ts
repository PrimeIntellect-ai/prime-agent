import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseAvoSupervisorPayload } from "./supervisor.js";
import type { AvoCandidate, AvoRunState } from "./types.js";

export const AVO_PYTHON_PROBE_BROKER_SOCKET_ENV = "PRIME_AGENT_INTERNAL_AVO_PROBE_BROKER_SOCKET";
export const AVO_PYTHON_PROBE_BROKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_AVO_PROBE_BROKER_TOKEN";
export const AVO_PYTHON_PROBE_MAX_CASES = 64;
export const AVO_PYTHON_PROBE_POLICY_VERSION = 4;
const AVO_PYTHON_PROBE_BROKER_PROTOCOL_VERSION = 3;
const AVO_PYTHON_PROBE_BROKER_MAX_CONNECTIONS = 32;
const AVO_PYTHON_PROBE_BROKER_MAX_ACTIVE_EXECUTIONS = 2;
const AVO_PYTHON_PROBE_BROKER_MAX_QUEUED_EXECUTIONS = 8;
const AVO_PYTHON_PROBE_BROKER_PREAUTH_MAX_BYTES = 512;
const AVO_PYTHON_PROBE_BROKER_PREAUTH_IDLE_MS = 2_000;
const AVO_PYTHON_PROBE_BROKER_REQUEST_IDLE_MS = 5_000;
const AVO_PYTHON_PROBE_BROKER_MAX_REQUEST_BYTES = 24_000_000;
const AVO_PYTHON_PROBE_BROKER_MAX_BUFFERED_REQUEST_BYTES = 64 * 1024 * 1024;

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
	message?: string;
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
	callableInputDimensions: Readonly<Record<string, readonly string[]>>;
	surfaceError?: string;
	surfaceErrorDisposition?: "candidate_invalid" | "environment_unsupported";
	requirementIds: readonly string[];
	minimumCases: number;
	maximumCases: number;
	minimumCrossRequirementCases: number;
	minimumDistinctRequirements: number;
	minimumContrastedInputDimensions: number;
}

export interface AvoPythonProbeBundleFile {
	path: string;
	contentBase64: string;
}

export interface AvoPythonProbeBundle {
	digest: string;
	fileCount: number;
	totalBytes: number;
	files: AvoPythonProbeBundleFile[];
}

export function createAvoPythonProbeBundle(files: readonly AvoPythonProbeBundleFile[]): AvoPythonProbeBundle {
	const hash = createHash("sha256");
	hash.update("prime-avo-python-bundle-v1\0");
	let totalBytes = 0;
	const normalized = [...files]
		.map((file) => ({ path: file.path.replaceAll("\\", "/"), contentBase64: file.contentBase64 }))
		.sort((left, right) => left.path.localeCompare(right.path));
	if (normalized.length > 10_000) throw new Error("Python probe bundle exceeds 10000 source files");
	for (const file of normalized) {
		if (
			!file.path ||
			file.path.startsWith("/") ||
			file.path.split("/").some((part) => !part || part === "." || part === "..") ||
			!file.path.endsWith(".py")
		) {
			throw new Error(`Python probe bundle contains an unsafe source path: ${file.path}`);
		}
		const contents = Buffer.from(file.contentBase64, "base64");
		if (contents.toString("base64") !== file.contentBase64) {
			throw new Error(`Python probe bundle contains malformed base64 for ${file.path}`);
		}
		totalBytes += contents.byteLength;
		if (totalBytes > 16 * 1024 * 1024) throw new Error("Python probe bundle exceeds 16777216 bytes");
		hash.update(file.path);
		hash.update("\0");
		hash.update(String(contents.byteLength));
		hash.update("\0");
		hash.update(contents);
		hash.update("\0");
	}
	if (new Set(normalized.map((file) => file.path)).size !== normalized.length) {
		throw new Error("Python probe bundle contains duplicate source paths");
	}
	return {
		digest: hash.digest("hex"),
		fileCount: normalized.length,
		totalBytes,
		files: normalized,
	};
}

export function digestAvoPythonProbeApplicability(
	state: Pick<AvoRunState, "objective" | "obligations">,
	candidate: Pick<
		AvoCandidate,
		"candidateId" | "payloadDigest" | "workspaceDigest" | "workspaceChangedPaths" | "pythonProbeBundleDigest"
	>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				probePolicyVersion: AVO_PYTHON_PROBE_POLICY_VERSION,
				objective: state.objective,
				obligations: state.obligations.map((item) => ({
					obligationId: item.obligationId,
					description: item.description,
					kind: item.kind,
					critical: item.critical,
				})),
				candidateId: candidate.candidateId,
				payloadDigest: candidate.payloadDigest,
				workspaceDigest: candidate.workspaceDigest,
				workspaceChangedPaths: candidate.workspaceChangedPaths,
				pythonProbeBundleDigest: candidate.pythonProbeBundleDigest,
			}),
		)
		.digest("hex");
}

export interface AvoPythonProbeAdequacy {
	policyVersion: 3;
	requiredInputDimensions: number;
	contrastedInputDimensions: number;
	callables: Array<{
		callable: string;
		requiredDimensions: string[];
		contrastedDimensions: string[];
	}>;
}

export interface AvoPythonCallableInspection {
	callables: Array<{
		name: string;
		inputDimensions: string[];
		signatureDigest: string;
		parameterSignatureDigest: string;
		structuralDigest: string;
	}>;
	errors: Array<{ name: string; reason: string }>;
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

export interface AvoPythonProbeExecutorAvailability {
	available: boolean;
	mode: "broker" | "local_sandbox" | "unavailable";
	reason?: string;
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

function exactErrorMessage(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	if (value.length > 500) throw new Error(`${label} exceeds 500 characters`);
	return value;
}

function parseJsonValue(value: unknown, label: string, depth = 0): AvoProbeJsonValue {
	if (depth > 8) throw new Error(`${label} exceeds the JSON nesting limit`);
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		if (typeof value === "string" && value.length > 4_096) throw new Error(`${label} string exceeds 4096 characters`);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${label} numbers must be finite`);
		if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
			throw new Error(`${label} integers must be within the JSON safe-integer range`);
		}
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

function canonicalJson(value: AvoProbeJsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
		.join(",")}}`;
}

function expectationIdentity(expectation: AvoPythonProbeExpectation): string {
	return expectation.kind === "return"
		? `return:${canonicalJson(expectation.value ?? null)}`
		: `raises:${expectation.error ?? ""}:${JSON.stringify(expectation.message ?? "")}`;
}

function probeInputIdentity(probeCase: Pick<AvoPythonProbeCase, "callable" | "args" | "kwargs">): string {
	return `${probeCase.callable}:${canonicalJson({ args: probeCase.args, kwargs: probeCase.kwargs })}`;
}

function inputIdentityWithoutDimension(probeCase: AvoPythonProbeCase, dimension: string): string {
	const args = [...probeCase.args];
	const kwargs = { ...probeCase.kwargs };
	if (dimension.startsWith("arg:")) {
		args[Number(dimension.slice(4))] = { __avo_contrast_dimension__: dimension };
	} else {
		kwargs[dimension.slice(7)] = { __avo_contrast_dimension__: dimension };
	}
	return canonicalJson({ args, kwargs });
}

const AVO_PYTHON_SIGNATURE_INSPECTOR = `
import ast
import hashlib
import json
import sys

def bound_names(statement):
    names = set()
    if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {statement.name}
    if isinstance(statement, (ast.Import, ast.ImportFrom)):
        for alias in statement.names:
            names.add("*" if alias.name == "*" else (alias.asname or alias.name.split(".")[0]))
        return names
    targets = []
    if isinstance(statement, ast.Assign):
        targets = statement.targets
    elif isinstance(statement, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
        targets = [statement.target]
    for target in targets:
      for node in ast.walk(target):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            names.add(node.id)
    return names

def inspect_source(source):
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        return {"callables": [], "errors": [{"name": "*", "reason": f"Python syntax is not inspectable: {exc.msg}"}]}
    direct = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_")]
    callables = []
    errors = []
    direct_names = {node.name for node in direct}
    uncertain_names = set()
    for statement in tree.body:
        if isinstance(statement, ast.Import):
            uncertain_names.update(alias.asname or alias.name.split(".")[0] for alias in statement.names)
        elif isinstance(statement, ast.ImportFrom):
            for alias in statement.names:
                if alias.name == "*":
                    uncertain_names.add("*")
                else:
                    uncertain_names.add(alias.asname or alias.name)
        elif isinstance(statement, ast.ClassDef):
            uncertain_names.add(statement.name)
        elif isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
            uncertain_names.update(bound_names(statement))
    for name in sorted(name for name in uncertain_names if name == "*" or (not name.startswith("_") and name not in direct_names)):
        errors.append({"name": name, "reason": f"public binding {name} may be callable but is not a directly inspectable function definition"})

    def shape(node):
        return None if node is None else ast.dump(node, annotate_fields=True, include_attributes=False)

    binding_records = {}
    function_bindings = {}

    def referenced_binding_records(node, available):
        if node is None:
            return {}
        return {
            name: available[name]
            for name in sorted({item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)})
            if name in available
        }

    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function_bindings[id(statement)] = dict(binding_records)
            binding_records[statement.name] = {"function": shape(statement), "bindings": referenced_binding_records(statement, binding_records)}
        elif isinstance(statement, (ast.Import, ast.ImportFrom)):
            for bound_name in bound_names(statement):
                binding_records[bound_name] = {"import": shape(statement), "unresolved": True}
        elif isinstance(statement, ast.Assign):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    binding_records[target.id] = {"expression": shape(statement.value), "bindings": referenced_binding_records(statement.value, binding_records)}
        elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            binding_records[statement.target.id] = {"expression": shape(statement.value), "bindings": referenced_binding_records(statement.value, binding_records)}

    def binding_closure(nodes, available):
        names = set()
        for root in nodes:
            if root is not None:
                names.update(node.id for node in ast.walk(root) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load))
        return {name: available[name] for name in sorted(names) if name in available}

    def contains_unresolved(record):
        if isinstance(record, dict):
            return record.get("unresolved") is True or any(contains_unresolved(value) for value in record.values())
        if isinstance(record, list):
            return any(contains_unresolved(value) for value in record)
        return False

    for name in dict.fromkeys(node.name for node in direct):
        definitions = [node for node in direct if node.name == name]
        ambiguous = len(definitions) != 1
        for statement in tree.body:
            if statement in definitions:
                continue
            if name in bound_names(statement):
                ambiguous = True
        node = definitions[-1]
        if ambiguous:
            errors.append({"name": name, "reason": f"public callable {name} has ambiguous module-level bindings"})
            continue
        if node.decorator_list:
            errors.append({"name": name, "reason": f"public callable {name} is decorated, so its runtime signature is not statically authoritative"})
            continue
        available_bindings = function_bindings[id(node)]
        default_nodes = [*node.args.defaults, *(item for item in node.args.kw_defaults if item is not None)]
        default_names = {
            item.id
            for root in default_nodes
            for item in ast.walk(root)
            if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)
        }
        unresolved_defaults = sorted(
            name for name in default_names
            if name not in available_bindings or contains_unresolved(available_bindings[name])
        )
        if unresolved_defaults:
            errors.append({"name": name, "reason": f"public callable {name} has defaults with unresolved bindings: {', '.join(unresolved_defaults)}"})
            continue
        positional = [(item, "positional_only") for item in node.args.posonlyargs] + [(item, "positional_or_keyword") for item in node.args.args]
        positional_defaults = [None] * (len(positional) - len(node.args.defaults)) + list(node.args.defaults)
        signature = [
            {"name": item.arg, "kind": kind, "required": positional_defaults[index] is None, "annotation": shape(item.annotation), "default": shape(positional_defaults[index])}
            for index, (item, kind) in enumerate(positional)
        ]
        if node.args.vararg is not None:
            signature.append({"name": node.args.vararg.arg, "kind": "var_positional", "required": False, "annotation": shape(node.args.vararg.annotation), "default": None})
        signature.extend(
            {"name": item.arg, "kind": "keyword_only", "required": node.args.kw_defaults[index] is None, "annotation": shape(item.annotation), "default": shape(node.args.kw_defaults[index])}
            for index, item in enumerate(node.args.kwonlyargs)
        )
        if node.args.kwarg is not None:
            signature.append({"name": node.args.kwarg.arg, "kind": "var_keyword", "required": False, "annotation": shape(node.args.kwarg.annotation), "default": None})
        dimensions = []
        positional_index = 0
        for item in signature:
            if item["kind"] in ("positional_only", "positional_or_keyword"):
                dimensions.append(f"arg:{positional_index}")
                positional_index += 1
            elif item["kind"] == "keyword_only":
                dimensions.append(f"kwarg:{item['name']}")
        if not dimensions and any(item["kind"].startswith("var_") for item in signature):
            errors.append({"name": name, "reason": f"public callable {name} has only variadic inputs and cannot be contrasted deterministically"})
            continue
        parameter_nodes = [*node.args.defaults, *node.args.kw_defaults]
        parameter_nodes.extend(item.annotation for item in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs] if item.annotation is not None)
        if node.args.vararg is not None:
            parameter_nodes.append(node.args.vararg.annotation)
        if node.args.kwarg is not None:
            parameter_nodes.append(node.args.kwarg.annotation)
        signature_nodes = [*parameter_nodes, node.returns]
        signature_record = {"parameters": signature, "returns": shape(node.returns), "type_comment": node.type_comment, "async": isinstance(node, ast.AsyncFunctionDef), "bindings": binding_closure(signature_nodes, available_bindings)}
        encoded = json.dumps(signature_record, sort_keys=True, separators=(",", ":")).encode("utf-8")
        parameter_record = {"parameters": signature, "async": isinstance(node, ast.AsyncFunctionDef), "bindings": binding_closure(parameter_nodes, available_bindings)}
        parameter_encoded = json.dumps(parameter_record, sort_keys=True, separators=(",", ":")).encode("utf-8")
        structural = [{"name": item["name"], "kind": item["kind"], "required": item["required"]} for item in signature]
        structural_encoded = json.dumps({"parameters": structural, "async": isinstance(node, ast.AsyncFunctionDef)}, sort_keys=True, separators=(",", ":")).encode("utf-8")
        callables.append({"name": name, "inputDimensions": dimensions, "signatureDigest": hashlib.sha256(encoded).hexdigest(), "parameterSignatureDigest": hashlib.sha256(parameter_encoded).hexdigest(), "structuralDigest": hashlib.sha256(structural_encoded).hexdigest()})
    return {"callables": callables, "errors": errors}

def main():
    sources = json.load(sys.stdin)
    print(json.dumps({"results": {item["key"]: inspect_source(item["source"]) for item in sources}}, separators=(",", ":")))

main()
`.trim();

function parseAvoPythonCallableInspection(value: unknown): AvoPythonCallableInspection {
	if (!isRecord(value) || !Array.isArray(value.callables) || !Array.isArray(value.errors)) {
		throw new Error("AST inspector returned an invalid inspection envelope");
	}
	const callables = value.callables.map((item): AvoPythonCallableInspection["callables"][number] => {
		if (
			!isRecord(item) ||
			typeof item.name !== "string" ||
			!Array.isArray(item.inputDimensions) ||
			!item.inputDimensions.every((dimension) => typeof dimension === "string") ||
			typeof item.signatureDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.signatureDigest) ||
			typeof item.parameterSignatureDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.parameterSignatureDigest) ||
			typeof item.structuralDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.structuralDigest)
		) {
			throw new Error("AST inspector returned an invalid callable");
		}
		return {
			name: item.name,
			inputDimensions: item.inputDimensions,
			signatureDigest: item.signatureDigest,
			parameterSignatureDigest: item.parameterSignatureDigest,
			structuralDigest: item.structuralDigest,
		};
	});
	const errors = value.errors.map((item): AvoPythonCallableInspection["errors"][number] => {
		if (!isRecord(item) || typeof item.name !== "string" || typeof item.reason !== "string") {
			throw new Error("AST inspector returned an invalid error");
		}
		return { name: item.name, reason: item.reason };
	});
	return { callables, errors };
}

export function inspectAvoPythonPublicCallableSources(
	sources: Readonly<Record<string, string>>,
): Record<string, AvoPythonCallableInspection> {
	const entries = Object.entries(sources);
	if (entries.length === 0) return {};
	if (entries.length > 20_000) throw new Error("Python AST inspection exceeds the 20000-file limit");
	let totalBytes = 0;
	const oversized = new Set<string>();
	const inspectable = entries.flatMap(([key, source]) => {
		const bytes = Buffer.byteLength(source);
		totalBytes += bytes;
		if (bytes > 1_000_000) {
			oversized.add(key);
			return [];
		}
		return [{ key, source }];
	});
	if (totalBytes > 128 * 1024 * 1024) throw new Error("Python AST inspection exceeds the aggregate byte limit");
	const python = existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
	const result = spawnSync(python, ["-I", "-B", "-c", AVO_PYTHON_SIGNATURE_INSPECTOR], {
		input: JSON.stringify(inspectable),
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 32 * 1024 * 1024,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	if (result.status !== 0 || result.error) {
		throw new Error(
			`Python AST inspection failed: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`,
		);
	}
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.results)) {
			throw new Error("AST inspector returned an invalid envelope");
		}
		const inspections: Record<string, AvoPythonCallableInspection> = {};
		for (const [key] of entries) {
			inspections[key] = oversized.has(key)
				? { callables: [], errors: [{ name: "*", reason: "Python source exceeds the AST inspection limit" }] }
				: parseAvoPythonCallableInspection(parsed.results[key]);
		}
		return inspections;
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}
}

export function inspectAvoPythonPublicCallables(source: string): AvoPythonCallableInspection {
	try {
		return inspectAvoPythonPublicCallableSources({ source }).source!;
	} catch (error) {
		return {
			callables: [],
			errors: [{ name: "*", reason: error instanceof Error ? error.message : String(error) }],
		};
	}
}

function dimensionValue(probeCase: AvoPythonProbeCase, dimension: string): AvoProbeJsonValue | undefined {
	return dimension.startsWith("arg:")
		? probeCase.args[Number(dimension.slice(4))]
		: probeCase.kwargs[dimension.slice(7)];
}

export function assessAvoPythonProbeAdequacy(
	plan: AvoPythonProbePlan,
	bindings: Pick<
		AvoPythonProbeBindings,
		"requiredCallables" | "callableInputDimensions" | "minimumContrastedInputDimensions"
	>,
): AvoPythonProbeAdequacy {
	const summaries: AvoPythonProbeAdequacy["callables"] = [];
	for (const callable of bindings.requiredCallables) {
		const cases = plan.cases.filter((item) => item.callable === callable);
		if (cases.length === 0) throw new Error(`probe_plan must exercise host-required callable ${callable}`);
		const hostDimensions = bindings.callableInputDimensions[callable];
		if (!hostDimensions) throw new Error(`host has no trusted input signature for required callable ${callable}`);
		const requiredDimensions = hostDimensions.slice(0, bindings.minimumContrastedInputDimensions);
		const contrastedDimensions = requiredDimensions.filter((dimension) =>
			cases.some((left, leftIndex) =>
				cases.slice(leftIndex + 1).some((right) => {
					const leftValue = dimensionValue(left, dimension);
					const rightValue = dimensionValue(right, dimension);
					return (
						leftValue !== undefined &&
						rightValue !== undefined &&
						canonicalJson(leftValue) !== canonicalJson(rightValue) &&
						inputIdentityWithoutDimension(left, dimension) === inputIdentityWithoutDimension(right, dimension) &&
						expectationIdentity(left.expect) !== expectationIdentity(right.expect)
					);
				}),
			),
		);
		const missingDimension = requiredDimensions.find((dimension) => !contrastedDimensions.includes(dimension));
		if (missingDimension) {
			throw new Error(
				`probe_plan requires a discriminating contrast pair for callable ${callable} input ${missingDimension}`,
			);
		}
		summaries.push({ callable, requiredDimensions, contrastedDimensions });
	}
	return {
		policyVersion: 3,
		requiredInputDimensions: summaries.reduce((total, item) => total + item.requiredDimensions.length, 0),
		contrastedInputDimensions: summaries.reduce((total, item) => total + item.contrastedDimensions.length, 0),
		callables: summaries,
	};
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
	if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > AVO_PYTHON_PROBE_MAX_CASES) {
		throw new Error(`probe broker plan.cases must contain 1-${AVO_PYTHON_PROBE_MAX_CASES} cases`);
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
							message: exactErrorMessage(
								expectValue.message,
								`probe broker plan.cases[${index}].expect.message`,
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
	if (new Set(cases.map(probeInputIdentity)).size !== cases.length) {
		throw new Error("probe broker plan contains duplicate callable inputs");
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
	if (JSON.stringify(value).length > 32_000) throw new Error("probe_plan exceeds 32000 serialized characters");
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
		value.cases.length > Math.min(bindings.maximumCases, AVO_PYTHON_PROBE_MAX_CASES)
	) {
		throw new Error(
			`probe_plan.cases must contain ${bindings.minimumCases}-${Math.min(bindings.maximumCases, AVO_PYTHON_PROBE_MAX_CASES)} cases`,
		);
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
		if (!bindings.requiredCallables.includes(callable)) {
			throw new Error(`probe_plan.cases[${index}].callable must be a host-required callable`);
		}
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
			assertKnownKeys(rawExpect, ["kind", "error", "message"], `probe_plan.cases[${index}].expect`);
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
					message: exactErrorMessage(rawExpect.message, `probe_plan.cases[${index}].expect.message`),
				},
			};
		}
		throw new Error(`probe_plan.cases[${index}].expect.kind must be return or raises`);
	});
	if (new Set(cases.map(probeInputIdentity)).size !== cases.length) {
		throw new Error("probe_plan cases must use distinct callable inputs");
	}
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
	const plan = { probeVersion: 1 as const, runtime: "python_call_v1" as const, modulePath, cases };
	assessAvoPythonProbeAdequacy(plan, bindings);
	return plan;
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
import base64
import contextlib
import hashlib
import importlib
import importlib.util
import inspect
import asyncio
import io
import json
import math
import os
import pathlib
import resource
import sys

MARKER = "AVO_PYTHON_PROBE_RAW:"
WORKSPACE = pathlib.Path("/tmp/workspace").resolve()
MAX_SAFE_INTEGER = 9007199254740991

class UnsupportedReturn(Exception):
    pass

def normalize(value, depth=0):
    if depth > 8:
        raise UnsupportedReturn("return value exceeds the JSON nesting limit")
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise UnsupportedReturn("return integer exceeds the JSON safe-integer range")
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise UnsupportedReturn("return value is a non-finite float")
        return value
    if isinstance(value, list):
        return [normalize(item, depth + 1) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: normalize(item, depth + 1) for key, item in value.items()}
    raise UnsupportedReturn(f"unsupported return type {type(value).__name__}")

def resolve_callable(module, dotted_name):
    target = module
    for part in dotted_name.split("."):
        if part.startswith("_"):
            raise AttributeError("private callables are forbidden")
        target = getattr(target, part)
    if not callable(target):
        raise TypeError("probe target is not callable")
    return target

def emit(value):
    encoded = (MARKER + json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\\n").encode("utf-8")
    os.write(1, encoded)

def main():
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    envelope = json.load(sys.stdin)
    request = envelope["request"]
    bundle = envelope["bundle"]
    digest = hashlib.sha256()
    digest.update(b"prime-avo-python-bundle-v1\\0")
    for item in sorted(bundle["files"], key=lambda value: value["path"]):
        relative_path = pathlib.PurePosixPath(item["path"])
        if relative_path.is_absolute() or any(part in ("", ".", "..") for part in relative_path.parts) or relative_path.suffix != ".py":
            raise ValueError("unsafe Python bundle path")
        contents = base64.b64decode(item["contentBase64"], validate=True)
        digest.update(item["path"].encode("utf-8"))
        digest.update(b"\\0")
        digest.update(str(len(contents)).encode("ascii"))
        digest.update(b"\\0")
        digest.update(contents)
        digest.update(b"\\0")
        destination = (WORKSPACE / relative_path).resolve()
        destination.relative_to(WORKSPACE)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(contents)
    if digest.hexdigest() != bundle["digest"]:
        raise ValueError("Python bundle digest mismatch")
    module_path = (WORKSPACE / request["modulePath"]).resolve(strict=True)
    module_path.relative_to(WORKSPACE)
    relative_module_path = pathlib.PurePosixPath(request["modulePath"])
    package_directories = list(relative_module_path.parts[:-1])
    package_start = len(package_directories)
    while package_start > 0 and (WORKSPACE.joinpath(*package_directories[:package_start]) / "__init__.py").is_file():
        package_start -= 1
    if package_start == len(package_directories) and package_directories:
        package_start = 1 if package_directories[0] in ("src", "lib") and len(package_directories) > 1 else 0
    sys.path.insert(0, str(WORKSPACE.joinpath(*package_directories[:package_start])))
    sys.path.insert(0, str(WORKSPACE))
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            if package_start < len(package_directories):
                dotted_name = ".".join([*package_directories[package_start:], relative_module_path.stem])
                module = importlib.import_module(dotted_name)
            else:
                spec = importlib.util.spec_from_file_location("avo_candidate_probe_module", module_path)
                if spec is None or spec.loader is None:
                    raise ImportError("could not load candidate module")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
    except BaseException as exc:
        emit({"kind": "import_error", "error": type(exc).__name__, "detail": f"{type(exc).__name__}: {exc}"[:500]})
        return 0
    try:
        target = resolve_callable(module, request["callable"])
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            actual = target(*request["args"], **request["kwargs"])
            if inspect.isawaitable(actual):
                actual = asyncio.run(actual)
    except BaseException as exc:
        emit({"kind": "raises", "error": type(exc).__name__, "message": str(exc)[:500], "detail": f"{type(exc).__name__}: {exc}"[:500]})
        return 0
    try:
        normalized = normalize(actual)
    except UnsupportedReturn as exc:
        emit({"kind": "unsupported_return", "detail": str(exc)[:500]})
        return 0
    emit({"kind": "return", "actual": normalized})
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`.trim();

export function getAvoPythonProbeExecutorAvailability(): AvoPythonProbeExecutorAvailability {
	const brokerConfigured =
		Boolean(process.env[AVO_PYTHON_PROBE_BROKER_SOCKET_ENV]) &&
		Boolean(process.env[AVO_PYTHON_PROBE_BROKER_TOKEN_ENV]);
	if (brokerConfigured) return { available: true, mode: "broker" };
	if (process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/python3")) {
		return { available: true, mode: "local_sandbox" };
	}
	return {
		available: false,
		mode: "unavailable",
		reason:
			"isolated Python probe execution requires a configured host broker or Linux with /usr/bin/bwrap and /usr/bin/python3",
	};
}

export function canExecuteAvoPythonProbe(): boolean {
	return getAvoPythonProbeExecutorAvailability().available;
}

async function executeAvoPythonProbeLocalSandbox(
	workspace: string,
	plan: AvoPythonProbePlan,
	bundle: AvoPythonProbeBundle,
	signal?: AbortSignal,
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
	const startedAt = Date.now();
	let stderr = "";
	let timedOut = false;
	let truncated = false;
	let executionError: string | undefined;
	const args = [
		"--tmpfs",
		"/",
		...(["/usr", "/lib", "/lib64"] as const).flatMap((path) => (existsSync(path) ? ["--ro-bind", path, path] : [])),
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/tmp/workspace",
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
		"-c",
		AVO_PYTHON_PROBE_RUNNER,
	];
	const results: AvoPythonProbeCaseResult[] = [];
	const aggregateDeadline = startedAt + 10_000;
	for (let caseIndex = 0; caseIndex < plan.cases.length; caseIndex += 1) {
		if (signal?.aborted) {
			executionError = "probe execution aborted";
			break;
		}
		const probeCase = plan.cases[caseIndex]!;
		const remainingMs = aggregateDeadline - Date.now();
		if (remainingMs <= 0) {
			timedOut = true;
			for (const skipped of plan.cases.slice(caseIndex)) {
				results.push({
					caseId: skipped.caseId,
					status: "fail",
					error: "TimeoutError: aggregate probe deadline exhausted before this case ran",
				});
			}
			break;
		}
		const envelope = JSON.stringify({
			request: {
				modulePath: plan.modulePath,
				callable: probeCase.callable,
				args: probeCase.args,
				kwargs: probeCase.kwargs,
			},
			bundle,
		});
		let caseStdout = "";
		let caseStderr = "";
		let caseTimedOut = false;
		let caseTruncated = false;
		const processResult = await new Promise<{ exitCode: number | null; error?: string }>((resolveResult) => {
			const child = spawn("/usr/bin/bwrap", args, {
				cwd: workspace,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => child.kill("SIGKILL");
			const finish = (result: { exitCode: number | null; error?: string }) => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				resolveResult(result);
			};
			const append = (target: "stdout" | "stderr", chunk: Buffer) => {
				const current = target === "stdout" ? caseStdout : caseStderr;
				const next = `${current}${chunk.toString("utf8")}`;
				if (next.length > 16_000) {
					caseTruncated = true;
					if (target === "stdout") caseStdout = next.slice(0, 16_000);
					else caseStderr = next.slice(0, 16_000);
					child.kill("SIGKILL");
					return;
				}
				if (target === "stdout") caseStdout = next;
				else caseStderr = next;
			};
			child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
			child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
			child.stdin.on("error", (error) => finish({ exitCode: null, error: error.message }));
			child.stdin.end(envelope);
			child.once("error", (error) => finish({ exitCode: null, error: error.message }));
			child.once("close", (code) => finish({ exitCode: code }));
			timeout = setTimeout(
				() => {
					caseTimedOut = true;
					child.kill("SIGKILL");
				},
				Math.max(1, Math.min(3_000, remainingMs)),
			);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
		if (signal?.aborted) {
			executionError = "probe execution aborted";
			break;
		}
		timedOut ||= caseTimedOut;
		truncated ||= caseTruncated;
		if (caseStderr.trim()) stderr = `${stderr}${probeCase.caseId}: ${caseStderr.trim()}\n`.slice(0, 64_000);
		if (processResult.error) {
			executionError = processResult.error;
			break;
		}
		const rawMarker = "AVO_PYTHON_PROBE_RAW:";
		const envelopes = caseStdout.split(/\r?\n/).filter((line) => line.startsWith(rawMarker));
		let result: AvoPythonProbeCaseResult;
		if (caseTimedOut) {
			result = { caseId: probeCase.caseId, status: "fail", error: "TimeoutError: probe case exceeded 3 seconds" };
		} else if (caseTruncated || processResult.exitCode !== 0 || envelopes.length !== 1) {
			result = {
				caseId: probeCase.caseId,
				status: "fail",
				error: `probe worker returned code ${processResult.exitCode ?? "none"} with ${envelopes.length} raw result envelopes`,
			};
		} else {
			try {
				const observed = JSON.parse(envelopes[0]!.slice(rawMarker.length)) as unknown;
				if (
					!isRecord(observed) ||
					!["return", "raises", "import_error", "unsupported_return"].includes(String(observed.kind))
				) {
					throw new Error("probe worker returned an invalid raw outcome");
				}
				if (observed.kind === "return") {
					const actual = parseJsonValue(observed.actual, `${probeCase.caseId}.actual`);
					const expected = probeCase.expect.value ?? null;
					const passed = probeCase.expect.kind === "return" && canonicalJson(actual) === canonicalJson(expected);
					result = { caseId: probeCase.caseId, status: passed ? "pass" : "fail", actual, expected };
				} else if (observed.kind === "raises") {
					const errorName = requiredString(observed.error, `${probeCase.caseId}.error`);
					const errorMessage = exactErrorMessage(observed.message, `${probeCase.caseId}.message`);
					const passed =
						probeCase.expect.kind === "raises" &&
						errorName === probeCase.expect.error &&
						errorMessage === probeCase.expect.message;
					result = {
						caseId: probeCase.caseId,
						status: passed ? "pass" : "fail",
						error: typeof observed.detail === "string" ? observed.detail.slice(0, 500) : errorName,
						expected:
							probeCase.expect.kind === "raises"
								? `${probeCase.expect.error}: ${probeCase.expect.message}`
								: probeCase.expect.value,
					};
				} else if (observed.kind === "import_error") {
					result = {
						caseId: probeCase.caseId,
						status: "fail",
						error: `module import failed: ${String(observed.detail ?? observed.error).slice(0, 500)}`,
					};
				} else {
					result = {
						caseId: probeCase.caseId,
						status: "fail",
						error: `unsupported return: ${String(observed.detail ?? "candidate returned a non-JSON value").slice(0, 500)}`,
					};
				}
			} catch (error) {
				result = {
					caseId: probeCase.caseId,
					status: "fail",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
		results.push(result);
	}
	const report = executionError
		? undefined
		: {
				reportVersion: 1 as const,
				passed: results.length === plan.cases.length && results.every((item) => item.status === "pass"),
				results,
			};
	const stdout = report
		? `${AVO_PYTHON_PROBE_RESULT_MARKER}${JSON.stringify({
				report_version: 1,
				passed: report.passed,
				results: report.results.map((item) => ({
					case_id: item.caseId,
					status: item.status,
					actual: item.actual,
					expected: item.expected,
					error: item.error,
				})),
			})}\n`
		: "";
	return {
		report,
		exitCode: executionError ? null : report?.passed ? 0 : 1,
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

function parseBrokerBundle(value: unknown): AvoPythonProbeBundle {
	if (!isRecord(value) || !Array.isArray(value.files)) throw new Error("probe broker bundle must be an object");
	const files = value.files.map((item, index) => {
		if (!isRecord(item) || typeof item.path !== "string" || typeof item.contentBase64 !== "string") {
			throw new Error(`probe broker bundle.files[${index}] is invalid`);
		}
		return { path: item.path, contentBase64: item.contentBase64 };
	});
	const bundle = createAvoPythonProbeBundle(files);
	if (
		value.digest !== bundle.digest ||
		value.fileCount !== bundle.fileCount ||
		value.totalBytes !== bundle.totalBytes
	) {
		throw new Error("probe broker bundle metadata does not match its source bytes");
	}
	return bundle;
}

async function executeAvoPythonProbeViaBroker(
	socketPath: string,
	token: string,
	plan: AvoPythonProbePlan,
	bundle: AvoPythonProbeBundle,
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
			socket.write(
				`${JSON.stringify({ protocolVersion: AVO_PYTHON_PROBE_BROKER_PROTOCOL_VERSION, token, plan, bundle })}\n`,
			);
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
				if (!isRecord(parsed) || parsed.protocolVersion !== AVO_PYTHON_PROBE_BROKER_PROTOCOL_VERSION) {
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
	bundle: AvoPythonProbeBundle,
): Promise<AvoPythonProbeExecution> {
	const socketPath = process.env[AVO_PYTHON_PROBE_BROKER_SOCKET_ENV];
	const token = process.env[AVO_PYTHON_PROBE_BROKER_TOKEN_ENV];
	if (socketPath && token) return executeAvoPythonProbeViaBroker(socketPath, token, plan, bundle);
	return executeAvoPythonProbeLocalSandbox(workspace, plan, bundle);
}

function brokerSocketDirectory(preferredDirectory?: string): string {
	if (preferredDirectory) {
		const directory = resolve(preferredDirectory);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		return directory;
	}
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
		server.listen(socketPath, AVO_PYTHON_PROBE_BROKER_MAX_CONNECTIONS);
	});
}

export async function startAvoPythonProbeBroker(
	workspace: string,
	options: { socketDirectory?: string } = {},
): Promise<AvoPythonProbeBrokerHandle> {
	if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/python3")) {
		throw new Error("the host probe broker requires Linux, /usr/bin/bwrap, and /usr/bin/python3");
	}
	const token = randomBytes(32).toString("hex");
	const socketPath = join(
		brokerSocketDirectory(options.socketDirectory),
		`prime-avo-probe-${process.pid}-${randomBytes(8).toString("hex")}.sock`,
	);
	type ExecutionTask = {
		socket: Socket;
		abortController: AbortController;
		cancelled: boolean;
		completion?: Promise<void>;
		execute(): Promise<void>;
	};
	const clients = new Set<Socket>();
	const queuedExecutions: ExecutionTask[] = [];
	const activeTasks = new Set<ExecutionTask>();
	let activeExecutions = 0;
	let bufferedRequestBytes = 0;
	let closing = false;
	const startExecution = (task: ExecutionTask) => {
		activeExecutions += 1;
		activeTasks.add(task);
		task.completion = task.execute().finally(() => {
			activeExecutions -= 1;
			activeTasks.delete(task);
			drainExecutions();
		});
		void task.completion;
	};
	const drainExecutions = () => {
		while (!closing && activeExecutions < AVO_PYTHON_PROBE_BROKER_MAX_ACTIVE_EXECUTIONS) {
			const task = queuedExecutions.shift();
			if (!task) return;
			if (task.cancelled || task.socket.destroyed) continue;
			startExecution(task);
		}
	};
	const scheduleExecution = (task: ExecutionTask): boolean => {
		if (closing || task.socket.destroyed) return false;
		if (activeExecutions < AVO_PYTHON_PROBE_BROKER_MAX_ACTIVE_EXECUTIONS) {
			startExecution(task);
			return true;
		}
		if (queuedExecutions.length >= AVO_PYTHON_PROBE_BROKER_MAX_QUEUED_EXECUTIONS) return false;
		queuedExecutions.push(task);
		return true;
	};
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		if (closing || clients.size >= AVO_PYTHON_PROBE_BROKER_MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		clients.add(socket);
		let requestText = "";
		let requestBytes = 0;
		let requestBytesReleased = false;
		let handled = false;
		let authenticated = false;
		let requestDeadline: ReturnType<typeof setTimeout> | undefined;
		let task: ExecutionTask | undefined;
		const releaseRequestBytes = () => {
			if (requestBytesReleased) return;
			requestBytesReleased = true;
			bufferedRequestBytes -= requestBytes;
		};
		const respond = (value: Record<string, unknown>) => {
			if (socket.destroyed) return;
			if (requestDeadline) clearTimeout(requestDeadline);
			requestDeadline = setTimeout(() => socket.destroy(), AVO_PYTHON_PROBE_BROKER_REQUEST_IDLE_MS);
			socket.end(
				`${JSON.stringify({ protocolVersion: AVO_PYTHON_PROBE_BROKER_PROTOCOL_VERSION, ...value })}\n`,
				() => {
					if (requestDeadline) clearTimeout(requestDeadline);
					socket.destroy();
				},
			);
		};
		const rejectRequest = (message: string) => {
			if (handled) return;
			handled = true;
			socket.setTimeout(0);
			respond({ error: message });
		};
		socket.setEncoding("utf8");
		socket.once("error", () => socket.destroy());
		requestDeadline = setTimeout(
			() => rejectRequest("broker authentication timed out"),
			AVO_PYTHON_PROBE_BROKER_PREAUTH_IDLE_MS,
		);
		socket.setTimeout(AVO_PYTHON_PROBE_BROKER_PREAUTH_IDLE_MS, () => {
			rejectRequest(authenticated ? "broker request timed out" : "broker authentication timed out");
		});
		socket.once("close", () => {
			if (requestDeadline) clearTimeout(requestDeadline);
			releaseRequestBytes();
			clients.delete(socket);
			if (!task) return;
			task.cancelled = true;
			task.abortController.abort();
			const queuedIndex = queuedExecutions.indexOf(task);
			if (queuedIndex >= 0) queuedExecutions.splice(queuedIndex, 1);
		});
		socket.on("data", (chunk: string) => {
			if (handled) return;
			const chunkBytes = Buffer.byteLength(chunk);
			if (bufferedRequestBytes + chunkBytes > AVO_PYTHON_PROBE_BROKER_MAX_BUFFERED_REQUEST_BYTES) {
				rejectRequest("probe broker buffered request capacity exceeded");
				return;
			}
			requestText += chunk;
			requestBytes += chunkBytes;
			bufferedRequestBytes += chunkBytes;
			if (!authenticated) {
				const authenticationWindow = Buffer.from(requestText)
					.subarray(0, AVO_PYTHON_PROBE_BROKER_PREAUTH_MAX_BYTES)
					.toString("utf8");
				const observedToken = /"token"\s*:\s*"([^"\\]*)"/.exec(authenticationWindow)?.[1];
				const observedProtocol = /"protocolVersion"\s*:\s*(\d+)/.exec(authenticationWindow)?.[1];
				if (observedToken !== undefined && !brokerTokenMatches(token, observedToken)) {
					rejectRequest("unauthorized or invalid broker request");
					return;
				}
				if (observedToken !== undefined && observedProtocol !== undefined) {
					if (observedProtocol !== String(AVO_PYTHON_PROBE_BROKER_PROTOCOL_VERSION)) {
						rejectRequest("unauthorized or invalid broker request");
						return;
					}
					authenticated = true;
					socket.setTimeout(AVO_PYTHON_PROBE_BROKER_REQUEST_IDLE_MS);
					if (requestDeadline) clearTimeout(requestDeadline);
					requestDeadline = setTimeout(
						() => rejectRequest("broker request timed out"),
						AVO_PYTHON_PROBE_BROKER_REQUEST_IDLE_MS,
					);
				} else if (requestBytes > AVO_PYTHON_PROBE_BROKER_PREAUTH_MAX_BYTES || requestText.includes("\n")) {
					rejectRequest("unauthorized or invalid broker request");
					return;
				} else {
					return;
				}
			}
			if (requestBytes > AVO_PYTHON_PROBE_BROKER_MAX_REQUEST_BYTES) {
				rejectRequest("request exceeded 24000000 bytes");
				return;
			}
			const newline = requestText.indexOf("\n");
			if (newline < 0) return;
			const requestLine = requestText.slice(0, newline);
			requestText = "";
			handled = true;
			socket.setTimeout(0);
			if (requestDeadline) clearTimeout(requestDeadline);
			try {
				const request = JSON.parse(requestLine) as unknown;
				if (
					!isRecord(request) ||
					request.protocolVersion !== AVO_PYTHON_PROBE_BROKER_PROTOCOL_VERSION ||
					!brokerTokenMatches(token, request.token)
				) {
					throw new Error("unauthorized or invalid broker request");
				}
				const plan = parseBrokerPlan(request.plan);
				const bundle = parseBrokerBundle(request.bundle);
				const abortController = new AbortController();
				task = {
					socket,
					abortController,
					cancelled: false,
					execute: async () => {
						try {
							const execution = await executeAvoPythonProbeLocalSandbox(
								workspace,
								plan,
								bundle,
								abortController.signal,
							);
							respond({ execution });
						} catch (error) {
							respond({
								error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
							});
						}
					},
				};
				if (!scheduleExecution(task)) respond({ error: "probe broker is at execution capacity" });
			} catch (error) {
				respond({
					error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
				});
			}
		});
	});
	server.maxConnections = AVO_PYTHON_PROBE_BROKER_MAX_CONNECTIONS;
	await listenOnSocket(server, socketPath);
	chmodSync(socketPath, 0o600);
	let closePromise: Promise<void> | undefined;
	return {
		socketPath,
		token,
		close: () => {
			closePromise ??= (async () => {
				closing = true;
				const activeCompletions = [...activeTasks].flatMap((active) => {
					active.cancelled = true;
					active.abortController.abort();
					return active.completion ? [active.completion] : [];
				});
				for (const queued of queuedExecutions) {
					queued.cancelled = true;
					queued.abortController.abort();
				}
				queuedExecutions.length = 0;
				for (const client of clients) client.destroy();
				const serverClosed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
				await Promise.allSettled(activeCompletions);
				await serverClosed;
				rmSync(socketPath, { force: true });
			})();
			return closePromise;
		},
	};
}
