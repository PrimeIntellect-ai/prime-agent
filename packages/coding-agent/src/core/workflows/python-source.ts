import type { MontySession } from "@pydantic/monty/node";
import { getNativeMonty } from "./monty-loader.js";
import type { WorkflowMeta } from "./runtime.js";

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_VALUE_DEPTH = 100;
const RESERVED_META_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BANNED_NAMES = [
	"compile",
	"delattr",
	"dir",
	"eval",
	"exec",
	"getattr",
	"globals",
	"help",
	"input",
	"locals",
	"memoryview",
	"open",
	"setattr",
	"type",
	"vars",
	"__import__",
] as const;

export interface ParsedPythonWorkflow {
	meta: WorkflowMeta;
	body: string;
	wrappedSource: string;
}

export const WORKFLOW_PRELUDE = `
import asyncio as workflow_asyncio

async def agent(
    prompt,
    *,
    label=None,
    phase=None,
    schema=None,
    model=None,
    effort=None,
    isolation=None,
    agent_type=None,
    timeout_ms=None,
):
    options = {
        "label": label,
        "phase": phase,
        "schema": schema,
        "model": model,
        "effort": effort,
        "isolation": isolation,
        "agentType": agent_type,
        "timeoutMs": timeout_ms,
    }
    return await workflow_agent(prompt, options)

async def parallel(thunks):
    values = list(thunks)
    if len(values) > 4096:
        raise ValueError("parallel item cap exceeded (4096)")
    async def run_one(thunk):
        try:
            return await thunk()
        except Exception as error:
            log(f"parallel slot failed: {error}")
            return None

    return await workflow_asyncio.gather(*(run_one(thunk) for thunk in values))

async def pipeline(items, *stages):
    values = list(items)
    if len(values) > 4096:
        raise ValueError("pipeline item cap exceeded (4096)")
    if not stages:
        raise TypeError("pipeline expects one or more callable stages")

    async def run_one(item, index):
        value = item
        try:
            for stage in stages:
                value = await stage(value, item, index)
            return value
        except Exception as error:
            log(f"pipeline slot {index} failed: {error}")
            return None

    return await workflow_asyncio.gather(*(run_one(item, index) for index, item in enumerate(values)))

def phase(title):
    return workflow_phase(title)

def log(message):
    return workflow_log(message)

class WorkflowBudget:
    def __init__(self, total):
        self.total = total

    def spent(self):
        return workflow_spent()

    def remaining(self):
        if self.total is None:
            return float("inf")
        return max(0, self.total - self.spent())

budget = WorkflowBudget(workflow_token_budget)

def workflow_normalize_result(value, depth=0):
    if depth > 100:
        raise ValueError("workflow result exceeds maximum depth 100")
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [workflow_normalize_result(item, depth + 1) for item in value]
    if isinstance(value, dict):
        output = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("workflow result dictionaries must use string keys")
            if key in ("__proto__", "constructor", "prototype"):
                raise ValueError("workflow result contains a reserved dictionary key")
            output[key] = workflow_normalize_result(item, depth + 1)
        return output
    raise TypeError("workflow result must be JSON-serializable")
`.trim();

export async function parsePythonWorkflow(source: string): Promise<ParsedPythonWorkflow> {
	if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
		throw new Error(`workflow source exceeds ${MAX_SOURCE_BYTES} bytes`);
	}
	const canonicalSource = canonicalizePythonSource(source);
	const { literal, body } = extractMetaLiteral(canonicalSource);
	validatePureLiteralTokens(literal);
	validateBodyPolicy(body);
	const validationSource = `async def workflow_validate():\n${indentPython(body)}\n${literal}`;
	const pool = await getNativeMonty().create({
		minProcesses: 1,
		maxProcesses: 1,
		requestTimeout: 5,
		durationLimitGrace: 1,
		maxCheckoutsPerWorker: 1,
	});
	let session: MontySession | undefined;
	try {
		session = await pool.checkout({
			scriptName: "workflow-validation.py",
			limits: { maxDurationSecs: 2, maxMemory: 32 * 1024 * 1024, maxRecursionDepth: 100 },
		});
		const workerPid = session.workerPid;
		if (typeof workerPid !== "number" || !Number.isSafeInteger(workerPid) || workerPid <= 0) {
			throw new Error("Prime Agent workflows require Monty's native subprocess backend");
		}
		const rawMeta = await session.feedRun(validationSource, {
			printCallback: () => {
				throw new Error("print is not allowed in workflow metadata");
			},
		});
		const metaValue = normalizeMontyValue(rawMeta);
		const meta = normalizeWorkflowMeta(metaValue);
		return {
			meta,
			body,
			wrappedSource: buildWrappedWorkflow(body),
		};
	} finally {
		await Promise.allSettled(
			[session?.close(), pool.close()].filter((value): value is Promise<void> => value !== undefined),
		);
	}
}

function canonicalizePythonSource(source: string): string {
	const canonical = source.replace(/\r\n?/g, "\n");
	if (/[\0\f\v\u2028\u2029]/.test(canonical)) {
		throw new Error("workflow source contains an unsupported control character");
	}
	return canonical;
}

export function buildWrappedWorkflow(body: string): string {
	return `${WORKFLOW_PRELUDE}\n\nasync def workflow_main():\n${indentPython(body)}\n\nworkflow_normalize_result(await workflow_main())`;
}

export function normalizeMontyValue(value: unknown): unknown {
	return normalizeMontyValueInner(value, { nodes: 0, bytes: 0, seen: new Set<object>() }, 0);
}

function normalizeMontyValueInner(
	value: unknown,
	state: { nodes: number; bytes: number; seen: Set<object> },
	depth: number,
): unknown {
	if (depth > MAX_VALUE_DEPTH) throw new Error(`workflow value exceeds maximum depth ${MAX_VALUE_DEPTH}`);
	state.nodes++;
	if (state.nodes > 1_000_000) throw new Error("workflow value contains too many nodes");
	if (typeof value === "string") {
		state.bytes += Buffer.byteLength(value, "utf8");
		if (state.bytes > 64 * 1024 * 1024) throw new Error("workflow value exceeds normalization byte limit");
		return value;
	}
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("workflow values cannot contain NaN or Infinity");
		return value;
	}
	if (typeof value !== "object") throw new Error(`unsupported workflow value type: ${typeof value}`);
	if (state.seen.has(value)) throw new Error("workflow values cannot contain cycles");
	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > 1_000_000 || Object.keys(value).length !== value.length) {
				throw new Error("workflow arrays must be dense and contain at most 1000000 items");
			}
			return value.map((item) => normalizeMontyValueInner(item, state, depth + 1));
		}
		if (value instanceof Map) {
			const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
			for (const [key, item] of value) {
				if (typeof key !== "string") throw new Error("workflow dictionaries must use string keys");
				if (RESERVED_META_KEYS.has(key)) throw new Error(`reserved workflow dictionary key is not allowed: ${key}`);
				output[key] = normalizeMontyValueInner(item, state, depth + 1);
			}
			return output;
		}
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof Set) {
			throw new Error("workflow values must use plain JSON containers");
		}
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("workflow values must use plain JSON containers");
		}
		if ("__monty_type__" in value) throw new Error("workflow values cannot contain Monty runtime handles");
		const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of Object.entries(value)) {
			if (RESERVED_META_KEYS.has(key)) throw new Error(`reserved workflow dictionary key is not allowed: ${key}`);
			output[key] = normalizeMontyValueInner(item, state, depth + 1);
		}
		return output;
	} finally {
		state.seen.delete(value);
	}
}

function extractMetaLiteral(source: string): { literal: string; body: string } {
	let index = skipWhitespaceAndComments(source, 0);
	const nameMatch = /^meta\s*=\s*/.exec(source.slice(index));
	if (!nameMatch) throw new Error("`meta = {...}` must be the first statement");
	index += nameMatch[0].length;
	if (source[index] !== "{") throw new Error("meta must be a literal dictionary");
	const end = findMatchingBrace(source, index);
	const lineEnd = source.indexOf("\n", end + 1);
	const remainder = source.slice(end + 1, lineEnd === -1 ? source.length : lineEnd);
	if (!/^\s*(?:#.*)?$/.test(remainder)) throw new Error("meta assignment must be the complete first statement");
	const bodyStart = lineEnd === -1 ? source.length : lineEnd + 1;
	return { literal: source.slice(index, end + 1), body: source.slice(bodyStart) };
}

function findMatchingBrace(source: string, start: number): number {
	const stack: string[] = [];
	let quote: "'" | '"' | undefined;
	let triple = false;
	let escaped = false;
	let comment = false;
	for (let index = start; index < source.length; index++) {
		const character = source[index];
		if (comment) {
			if (character === "\n") comment = false;
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
				index += 2;
				quote = undefined;
				triple = false;
			} else if (!triple && character === quote) {
				quote = undefined;
			}
			continue;
		}
		if (character === "#") {
			comment = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			triple = source.slice(index, index + 3) === character.repeat(3);
			if (triple) index += 2;
			continue;
		}
		if (character === "{" || character === "[") stack.push(character);
		else if (character === "}" || character === "]") {
			const expected = character === "}" ? "{" : "[";
			if (stack.pop() !== expected) throw new Error("unbalanced workflow metadata literal");
			if (stack.length === 0) return index;
		} else if (character === "(") {
			throw new Error("meta must contain only dictionary, list, and scalar literals");
		}
	}
	throw new Error("unterminated workflow metadata literal");
}

function validatePureLiteralTokens(literal: string): void {
	const masked = maskPythonStringsAndComments(literal);
	let index = 0;
	while (index < masked.length) {
		const rest = masked.slice(index);
		const whitespace = /^\s+/.exec(rest);
		if (whitespace) {
			index += whitespace[0].length;
			continue;
		}
		const punctuation = /^[{}[\]:,]/.exec(rest);
		if (punctuation) {
			index++;
			continue;
		}
		const number = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/.exec(rest);
		if (number) {
			index += number[0].length;
			continue;
		}
		const word = /^[A-Za-z_]\w*/.exec(rest);
		if (word && ["True", "False", "None"].includes(word[0])) {
			index += word[0].length;
			continue;
		}
		throw new Error("meta must contain pure literal Python values");
	}
}

function validateBodyPolicy(body: string): void {
	const masked = maskPythonStringsAndComments(body).normalize("NFKC");
	if (/\b(?:import|from)\b/.test(masked)) throw new Error("workflow code cannot import modules");
	if (/\.\s*__|\b__\w+/.test(masked)) throw new Error("private and dunder access is not allowed in workflow code");
	for (const name of BANNED_NAMES) {
		if (new RegExp(`\\b${name}\\b`).test(masked)) throw new Error(`name \`${name}\` is not allowed in workflow code`);
	}
	if (/\bprint\s*\(/.test(masked)) throw new Error("workflow code must use log() instead of print()");
	const reservedNames = [
		"agent",
		"parallel",
		"pipeline",
		"phase",
		"log",
		"args",
		"cwd",
		"budget",
		"workflow_agent",
		"workflow_phase",
		"workflow_log",
		"workflow_spent",
		"workflow_token_budget",
		"workflow_asyncio",
		"workflow_normalize_result",
		"WorkflowBudget",
		"workflow_main",
	];
	for (const name of reservedNames) {
		const definition = new RegExp(String.raw`\b(?:(?:async\s+)?def|class)\s+${name}\b`);
		const binding = new RegExp(
			String.raw`(?:\b(?:global|nonlocal)\s+[^;\n]*\b${name}\b|\b(?:except|with)\b[^;\n]*\bas\s+${name}\b|\b${name}\s*:=|\b${name}\b\s*=(?!=)|\b${name}\b[\s,)]*=(?!=)|(?:for|async\s+for)\s+(?:\([^)]*\b${name}\b[^)]*\)|[^:;\n]*\b${name}\b)\s+in\b|(?:async\s+)?def\s+\w+\s*\([^)]*\b${name}\b)|\blambda\b[^:;\n]*\b${name}\b[^:;\n]*:|(?:^|[;\n])\s*case\s+[^:;\n]*\b${name}\b[^:;\n]*:`,
		);
		if (definition.test(masked) || binding.test(masked)) {
			throw new Error(`workflow code cannot redefine reserved name \`${name}\``);
		}
	}
	if (!/\bagent\s*\(/.test(masked)) throw new Error("workflow scripts must call agent() at least once");
	if (!/\breturn\b/.test(masked)) throw new Error("workflow scripts must return a result");
}

function maskPythonStringsAndComments(source: string): string {
	const output = source.split("");
	let quote: "'" | '"' | undefined;
	let triple = false;
	let escaped = false;
	let comment = false;
	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (comment) {
			if (character === "\n") comment = false;
			else output[index] = " ";
			continue;
		}
		if (quote) {
			if (character !== "\n") output[index] = " ";
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
				output[index + 1] = " ";
				output[index + 2] = " ";
				index += 2;
				quote = undefined;
				triple = false;
			} else if (!triple && character === quote) quote = undefined;
			continue;
		}
		if (character === "#") {
			output[index] = " ";
			comment = true;
		} else if (character === "'" || character === '"') {
			const prefixText = source.slice(Math.max(0, index - 3), index);
			if (/(?:^|[^A-Za-z0-9_])(?:[fF][rR]?|[rR][fF])$/.test(prefixText)) {
				throw new Error("workflow f-strings are not allowed; build strings from plain values");
			}
			output[index] = " ";
			quote = character;
			triple = source.slice(index, index + 3) === character.repeat(3);
			if (triple) {
				output[index + 1] = " ";
				output[index + 2] = " ";
				index += 2;
			}
		}
	}
	return output.join("");
}

function indentPython(source: string): string {
	const body = source.trimEnd();
	if (!body.trim()) return "    pass";
	return body
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

function skipWhitespaceAndComments(source: string, start: number): number {
	let index = start;
	while (index < source.length) {
		if (/\s/.test(source[index] ?? "")) {
			index++;
			continue;
		}
		if (source[index] === "#") {
			const lineEnd = source.indexOf("\n", index);
			if (lineEnd === -1) return source.length;
			index = lineEnd + 1;
			continue;
		}
		break;
	}
	return index;
}

function normalizeWorkflowMeta(value: unknown): WorkflowMeta {
	if (!isRecord(value)) throw new Error("meta must be a literal dictionary");
	const allowedMetaKeys = new Set(["name", "description", "title", "whenToUse", "phases"]);
	for (const key of Object.keys(value)) {
		if (!allowedMetaKeys.has(key)) throw new Error(`unknown workflow meta field: ${key}`);
	}
	if (typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.name)) {
		throw new Error("meta.name must be a short path-safe name");
	}
	if (typeof value.description !== "string" || !value.description.trim()) {
		throw new Error("meta.description must be a non-empty string");
	}
	if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim())) {
		throw new Error("meta.title must be a non-empty string");
	}
	if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
		throw new Error("meta.whenToUse must be a string");
	}
	let phases: WorkflowMeta["phases"];
	if (value.phases !== undefined) {
		if (!Array.isArray(value.phases)) throw new Error("meta.phases must be a list");
		phases = value.phases.map((phase) => {
			if (!isRecord(phase)) throw new Error("each meta phase must be a dictionary");
			for (const key of Object.keys(phase)) {
				if (key !== "title" && key !== "detail" && key !== "model")
					throw new Error(`unknown workflow phase field: ${key}`);
			}
			if (typeof phase.title !== "string") throw new Error("each meta phase needs a title");
			if (phase.detail !== undefined && typeof phase.detail !== "string")
				throw new Error("phase detail must be a string");
			if (phase.model !== undefined && typeof phase.model !== "string")
				throw new Error("phase model must be a string");
			return {
				title: phase.title,
				...(phase.detail !== undefined ? { detail: phase.detail } : {}),
				...(phase.model !== undefined ? { model: phase.model } : {}),
			};
		});
	}
	return {
		name: value.name,
		description: value.description,
		...(value.title !== undefined ? { title: value.title } : {}),
		...(value.whenToUse !== undefined ? { whenToUse: value.whenToUse } : {}),
		...(phases !== undefined ? { phases } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
