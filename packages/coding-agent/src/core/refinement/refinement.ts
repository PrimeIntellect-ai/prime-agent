import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.js";
import { serializeConversation } from "../compaction/utils.js";
import { convertToLlm } from "../messages.js";
import type { CustomEntry } from "../session-manager.js";

export const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";

export const REFINE_SKILL_NAME = "refine";
const HARNESS_STATE_DIR_NAME = "harness";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";
const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;

export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";
export type RefinementAction = "create" | "update" | "delete";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	path: string;
	scope?: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
}

export interface HarnessState {
	schema: number;
	generation: number;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id?: string;
	title?: string;
	content?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	reason?: string;
}

export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
}

export interface RefineOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
}

export type AutoRefineReason = "turn_interval" | "compact";

export interface AutoRefineReviewContext {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

const REFINEMENT_SYSTEM_PROMPT = `You are Prime Agent's /refine continual harness subsystem.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise Create, Update, or Delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets Prime Agent improve reusable behavior
outside the token history.
Use "continual harness" for that persistent artifact layer; keep "RLM" for the
runtime, IPython kernel, and native call interface that executes those artifacts.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: installed Python REPL skill. Skill create/update edits MUST include a \`reference\` object with \`{"type":"python"}\`, a Python import, and a callable or call pattern; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the Python callable truly needs no external inputs. Include the RLM-native call form \`await <skill_import>(...)\`.
- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \`handle = await rlm("sub-task")\`; admission returns immediately with \`rlm_child_id\`, \`name\`, \`session_dir\`, and \`model\`, never the child's answer. Results arrive only through explicit \`agent_message\` replies or files; children reply with \`await agent_message.send(message, receiver_role="parent")\`. Use \`await rlm.list_subagents()\` to recover direct child handles and \`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\` for follow-ups. Do not invent wrappers like \`run_subagent(...)\`.

Scope and persistence policy:
- The default editable continual harness store is local to the current Prime Agent session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.
- When an edit is persisted, include metadata such as \`{"scope":"local"}\` or \`{"scope":"global"}\` when that helps future review understand the intended blast radius.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, rollback or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "python", "import": "package.module", "callable": "function_name", "call_pattern": "await function_name(...)"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are Prime Agent's automatic /refine review gate.

Decide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.
Reject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /refine if shouldRefine is true"
}`;

/**
 * Output budgets are derived from the selected model instead of fixed literals.
 * /refine input scales with harness size (entry overview, refinement history, and
 * the trajectory slice), so a constant output cap silently truncates exactly the
 * large multi-edit proposals that matter most. Math.min keeps small models honest.
 */
const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

function refinementMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS);
}

function autoRefineReviewMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
}

function now(): string {
	return new Date().toISOString();
}

function emptyHarnessState(): HarnessState {
	return {
		schema: 2,
		generation: 0,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry ? JSON.parse(JSON.stringify(entry)) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function normalizeHarnessScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

export function inferRefinementResultScope(result: RefinementResult): HarnessScope | undefined {
	if (result.scope) {
		return result.scope;
	}

	const scopes = new Set<HarnessScope>();
	for (const edit of result.appliedEdits) {
		const scope = edit.after?.scope ?? edit.before?.scope;
		if (scope) {
			scopes.add(scope);
		}
	}
	return scopes.size === 1 ? [...scopes][0] : undefined;
}

function withDefaultRefinementScope(result: RefinementResult, scope: HarnessScope): RefinementResult {
	const inferred = inferRefinementResultScope(result);
	return { ...result, scope: inferred ?? scope };
}

export function getGlobalHarnessStateDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, HARNESS_STATE_DIR_NAME);
}

export function getLocalHarnessStateDir(sessionArtifactDir: string | undefined): string | undefined {
	return sessionArtifactDir ? join(sessionArtifactDir, HARNESS_STATE_DIR_NAME) : undefined;
}

export function getHarnessStatePath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, "harness_state.json");
}

export interface HarnessSnapshot {
	generation: number;
	sha256: string;
}

/** A loaded root and the exact durable snapshot used as its CAS fence. */
export interface LoadedHarnessState extends HarnessState {
	/** The explicit state view; aliases this object for source compatibility. */
	state: HarnessState;
	snapshot: HarnessSnapshot;
	recovered: boolean;
	recovery?: string;
}

export class HarnessGenerationConflict extends Error {
	constructor(
		public readonly expected: HarnessSnapshot,
		public readonly actual: HarnessSnapshot,
	) {
		super("harness state changed while this operation was in progress");
	}
}
export class HarnessLockBusy extends Error {}
export class HarnessAtomicWriteUnsupported extends Error {}
export class HarnessRecoveryRequired extends Error {}

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const V2_KEYS = ["entries", "generation", "refinements", "schema"];
const ENTRY_KEYS = [
	"arguments",
	"content",
	"created_at",
	"id",
	"kind",
	"metadata",
	"path",
	"reference",
	"scope",
	"source",
	"title",
	"updated_at",
	"version",
];
const EVENT_KEYS = ["changes", "created_at", "evidence", "id", "outcome", "trigger"];
const ISO_MILLIS_Z = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** Schema-1 records without timestamps migrate to this documented epoch, never the reader clock. */
const LEGACY_DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function scalarCompare(left: string, right: string): number {
	const a = Array.from(left);
	const b = Array.from(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const delta = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
		if (delta) return delta;
	}
	return a.length - b.length;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value).sort(scalarCompare);
	const expected = [...keys].sort(scalarCompare);
	return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
function nfcString(value: unknown): value is string {
	return typeof value === "string" && value === value.normalize("NFC") && !/[\uD800-\uDFFF]/.test(value);
}
function safeInteger(value: unknown, positive = false): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		!Object.is(value, -0) &&
		value >= (positive ? 1 : 0) &&
		value <= MAX_SAFE_INTEGER
	);
}
function validateJson(value: unknown): void {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		if (!nfcString(value)) throw new Error("non_nfc");
		return;
	}
	if (typeof value === "number") {
		if (!safeInteger(value)) throw new Error("invalid_number");
		return;
	}
	if (Array.isArray(value)) {
		value.forEach(validateJson);
		return;
	}
	if (!isRecord(value)) throw new Error("invalid_json_value");
	for (const [key, child] of Object.entries(value)) {
		if (!nfcString(key)) throw new Error("non_nfc");
		validateJson(child);
	}
}
function canonicalBytes(value: HarnessState): Buffer {
	validateJson(value);
	const order = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(order);
		if (isRecord(item)) {
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(item).sort(scalarCompare)) result[key] = order(item[key]);
			return result;
		}
		return item;
	};
	return Buffer.from(`${JSON.stringify(order(value))}\n`, "utf8");
}
function snapshotFor(state: HarnessState): HarnessSnapshot {
	const bytes = canonicalBytes(state);
	return { generation: state.generation, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function timestamp(value: unknown): boolean {
	return nfcString(value) && ISO_MILLIS_Z.test(value);
}
function validateSkill(reference: Record<string, unknown>): void {
	if (
		reference.type !== "python" ||
		!(nfcString(reference.import) || nfcString(reference.python_import)) ||
		!(nfcString(reference.callable) || nfcString(reference.call_pattern))
	)
		throw new Error("invalid_skill_reference");
}
function validateV2(data: unknown): asserts data is HarnessState {
	if (
		!isRecord(data) ||
		!exactKeys(data, V2_KEYS) ||
		data.schema !== 2 ||
		!safeInteger(data.generation) ||
		!isRecord(data.entries) ||
		!exactKeys(data.entries, ["prompt", "memory", "skill", "subagent"]) ||
		!Array.isArray(data.refinements)
	)
		throw new Error("invalid_shape");
	const ids = new Set<string>();
	for (const kind of ["prompt", "memory", "skill", "subagent"] as RefinementKind[]) {
		const records = data.entries[kind];
		if (!isRecord(records)) throw new Error("invalid_shape");
		for (const [id, raw] of Object.entries(records)) {
			if (
				!nfcString(id) ||
				!id ||
				ids.has(id) ||
				!isRecord(raw) ||
				!exactKeys(raw, ENTRY_KEYS) ||
				raw.id !== id ||
				raw.kind !== kind ||
				!nfcString(raw.title) ||
				!nfcString(raw.content) ||
				!nfcString(raw.path) ||
				!nfcString(raw.source) ||
				!timestamp(raw.created_at) ||
				!timestamp(raw.updated_at) ||
				(raw.scope !== "local" && raw.scope !== "global") ||
				!safeInteger(raw.version, true) ||
				!isRecord(raw.reference) ||
				!isRecord(raw.arguments) ||
				!isRecord(raw.metadata)
			)
				throw new Error("invalid_entry");
			validateJson(raw.reference);
			validateJson(raw.arguments);
			validateJson(raw.metadata);
			if (kind === "skill") validateSkill(raw.reference);
			ids.add(id);
		}
	}
	const refinementIds = new Set<string>();
	for (const event of data.refinements) {
		if (
			!isRecord(event) ||
			!exactKeys(event, EVENT_KEYS) ||
			!nfcString(event.id) ||
			!event.id ||
			refinementIds.has(event.id) ||
			!nfcString(event.trigger) ||
			!nfcString(event.evidence) ||
			!nfcString(event.outcome) ||
			!timestamp(event.created_at) ||
			!Array.isArray(event.changes) ||
			!event.changes.every(nfcString)
		)
			throw new Error("invalid_refinement");
		refinementIds.add(event.id);
	}
}

/* JSON.parse intentionally cannot expose duplicate keys. This tiny scanner does,
 * before JSON.parse gives the value a chance to erase that evidence. */
function rejectDuplicateKeys(text: string): void {
	let i = 0;
	const ws = () => {
		while (/\s/.test(text[i] ?? "")) i += 1;
	};
	const string = (): string => {
		const start = i;
		if (text[i++] !== '"') throw new Error("invalid_json");
		let escaped = false;
		while (i < text.length) {
			const char = text[i++];
			if (!escaped && char === '"') return JSON.parse(text.slice(start, i));
			if (!escaped && char === "\\") escaped = true;
			else escaped = false;
		}
		throw new Error("invalid_json");
	};
	const value = (): void => {
		ws();
		const char = text[i];
		if (char === "{") {
			object();
			return;
		}
		if (char === "[") {
			i += 1;
			ws();
			if (text[i] === "]") {
				i += 1;
				return;
			}
			while (true) {
				value();
				ws();
				if (text[i] === "]") {
					i += 1;
					return;
				}
				if (text[i++] !== ",") throw new Error("invalid_json");
			}
		}
		if (char === '"') {
			string();
			return;
		}
		const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
		if (!match) throw new Error("invalid_json");
		i += match[0].length;
	};
	const object = (): void => {
		i += 1;
		ws();
		const seen = new Set<string>();
		if (text[i] === "}") {
			i += 1;
			return;
		}
		while (true) {
			ws();
			const key = string();
			if (seen.has(key)) throw new Error("duplicate_key");
			seen.add(key);
			ws();
			if (text[i++] !== ":") throw new Error("invalid_json");
			value();
			ws();
			if (text[i] === "}") {
				i += 1;
				return;
			}
			if (text[i++] !== ",") throw new Error("invalid_json");
		}
	};
	value();
	ws();
	if (i !== text.length) throw new Error("invalid_json");
}
function parseV2(raw: Buffer): { state: HarnessState; snapshot: HarnessSnapshot } {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		throw new Error("invalid_utf8");
	}
	rejectDuplicateKeys(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("invalid_json");
	}
	validateV2(parsed);
	if (!raw.equals(canonicalBytes(parsed))) throw new Error("noncanonical_v2");
	return {
		state: parsed,
		snapshot: { generation: parsed.generation, sha256: createHash("sha256").update(raw).digest("hex") },
	};
}
function legacyVersion(value: unknown): number {
	if (safeInteger(value, true)) return value;
	return typeof value === "string" && /^\d+$/.test(value) && safeInteger(Number(value), true) ? Number(value) : 1;
}

/**
 * Schema-1 refinement changes are deliberately not stringified. Only a string
 * or an array containing only strings survives migration. This avoids runtime-
 * specific coercions (for example JavaScript String versus Python str) and
 * prevents object-valued legacy input from entering the schema-2 wire format.
 */
function legacyChanges(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	return Array.isArray(value) && value.every((change) => typeof change === "string") ? value : undefined;
}
function legacyState(raw: Buffer, scope: HarnessScope): { state: HarnessState; snapshot: HarnessSnapshot } | undefined {
	// Schema 1 is deliberately permissive only where both runtimes can perform
	// the same deterministic migration. Invalid retained values are rejected by
	// schema-2 validation on the first mutation rather than silently coerced.
	let parsed: any;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
	} catch {
		return undefined;
	}
	if (
		!isRecord(parsed) ||
		(parsed.schema !== undefined &&
			(typeof parsed.schema !== "number" || !Number.isInteger(parsed.schema) || parsed.schema !== 1))
	)
		return undefined;
	const state = emptyHarnessState();
	state.schema = 1;
	state.generation = 0;
	for (const kind of ["prompt", "memory", "skill", "subagent"] as RefinementKind[]) {
		const records = isRecord(parsed.entries) && isRecord(parsed.entries[kind]) ? parsed.entries[kind] : {};
		for (const [id, value] of Object.entries(records))
			if (isRecord(value) && typeof value.title === "string" && typeof value.content === "string")
				state.entries[kind][id] = {
					id,
					kind,
					title: value.title,
					content: value.content,
					path: typeof value.path === "string" ? value.path : "general",
					scope: value.scope === "global" || value.scope === "local" ? value.scope : scope,
					reference: isRecord(value.reference) ? value.reference : {},
					arguments: isRecord(value.arguments) ? value.arguments : {},
					metadata: isRecord(value.metadata) ? value.metadata : {},
					source: typeof value.source === "string" ? value.source : "agent",
					created_at: typeof value.created_at === "string" ? value.created_at : LEGACY_DEFAULT_TIMESTAMP,
					updated_at: typeof value.updated_at === "string" ? value.updated_at : LEGACY_DEFAULT_TIMESTAMP,
					version: legacyVersion(value.version),
				};
	}
	state.refinements = Array.isArray(parsed.refinements)
		? parsed.refinements.filter(isRecord).flatMap((event: any) => {
				if (typeof event.id !== "string" || typeof event.trigger !== "string") return [];
				const changes = legacyChanges(event.changes);
				if (!changes) return [];
				return [
					{
						id: event.id,
						trigger: event.trigger,
						changes,
						evidence: typeof event.evidence === "string" ? event.evidence : "",
						outcome: typeof event.outcome === "string" ? event.outcome : "",
						created_at: typeof event.created_at === "string" ? event.created_at : LEGACY_DEFAULT_TIMESTAMP,
					},
				];
			})
		: [];
	return { state, snapshot: { generation: 0, sha256: createHash("sha256").update(raw).digest("hex") } };
}
function readState(
	path: string,
	scope: HarnessScope,
): { state: HarnessState; snapshot: HarnessSnapshot; legacy: boolean } {
	if (!existsSync(path)) {
		const state = emptyHarnessState();
		return { state, snapshot: snapshotFor(state), legacy: false };
	}
	const raw = readFileSync(path);
	try {
		const decoded = parseV2(raw);
		return { ...decoded, legacy: false };
	} catch (error) {
		const legacy = legacyState(raw, scope);
		if (legacy) return { ...legacy, legacy: true };
		throw error;
	}
}
function processStart(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(") ")[1]?.split(" ")[19];
	} catch {
		/* macOS has no /proc */
	}
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}
function ensureRoot(dir: string): void {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const mode = statSync(dir).mode & 0o777;
		if (mode !== 0o700) {
			chmodSync(dir, 0o700);
			if ((statSync(dir).mode & 0o777) !== 0o700) throw new Error("mode");
		}
	} catch {
		throw new HarnessAtomicWriteUnsupported("owner-only harness root unavailable");
	}
}
interface LockOwner {
	nonce: string;
	pid: number;
	process_start: string;
	created_at: string;
}
function parseLock(bytes: Buffer): LockOwner | undefined {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		rejectDuplicateKeys(text);
		const raw = JSON.parse(text);
		if (
			!isRecord(raw) ||
			!exactKeys(raw, ["nonce", "pid", "process_start", "created_at"]) ||
			!nfcString(raw.nonce) ||
			!/^[0-9a-f]{32}$/.test(raw.nonce) ||
			!safeInteger(raw.pid, true) ||
			!nfcString(raw.process_start) ||
			!raw.process_start ||
			!timestamp(raw.created_at)
		)
			return undefined;
		const owner: LockOwner = {
			nonce: raw.nonce as string,
			pid: raw.pid as number,
			process_start: raw.process_start as string,
			created_at: raw.created_at as string,
		};
		return bytes.equals(lockBytes(owner)) ? owner : undefined;
	} catch {
		return undefined;
	}
}
function lockBytes(owner: LockOwner): Buffer {
	return Buffer.from(
		`{"nonce":"${owner.nonce}","pid":${owner.pid},"process_start":${JSON.stringify(owner.process_start)},"created_at":"${owner.created_at}"}\n`,
		"utf8",
	);
}
function withHarnessLease<T>(path: string, operation: () => T): T {
	const lock = `${path}.lock`;
	const nonce = randomUUID().replaceAll("-", "");
	const start = processStart(process.pid);
	if (!start) throw new HarnessAtomicWriteUnsupported("process-start identity unavailable");
	const owner: LockOwner = { nonce, pid: process.pid, process_start: start, created_at: now() };
	const deadline = Date.now() + 2_000;
	while (true)
		try {
			const fd = openSync(lock, "wx", 0o600);
			try {
				writeFileSync(fd, lockBytes(owner));
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw new HarnessAtomicWriteUnsupported("exclusive lease unavailable");
			let bytes: Buffer;
			try {
				bytes = readFileSync(lock);
			} catch {
				if (Date.now() >= deadline) throw new HarnessLockBusy("harness state lease is busy");
				continue;
			}
			const other = parseLock(bytes);
			if (!other) throw new HarnessLockBusy("harness state lease is busy");
			const otherStart = processStart(other.pid);
			if (otherStart && otherStart === other.process_start) {
				if (Date.now() >= deadline) throw new HarnessLockBusy("harness state lease is busy");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
				continue;
			}
			if (otherStart) {
				try {
					if (readFileSync(lock).equals(bytes)) unlinkSync(lock);
				} catch {
					/* race: retry bounded */
				}
				continue;
			}
			try {
				process.kill(other.pid, 0);
			} catch (check: any) {
				if (check?.code === "ESRCH") {
					try {
						if (readFileSync(lock).equals(bytes)) unlinkSync(lock);
					} catch {
						/* race */
					}
					continue;
				}
			}
			throw new HarnessLockBusy("harness state lease is busy");
		}
	try {
		return operation();
	} finally {
		try {
			const bytes = readFileSync(lock);
			if (parseLock(bytes)?.nonce === nonce) unlinkSync(lock);
		} catch {
			/* never delete another owner */
		}
	}
}
function writeAtomic(path: string, candidate: HarnessState): HarnessSnapshot {
	const bytes = canonicalBytes(candidate);
	const dir = join(path, "..");
	const temp = join(dir, `.${"harness_state.json"}.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`);
	try {
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if ((statSync(temp).mode & 0o777) !== 0o600)
			throw new HarnessAtomicWriteUnsupported("owner-only temp unavailable");
		renameSync(temp, path);
		const dirFd = openSync(dir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		const verified = parseV2(readFileSync(path));
		if (
			verified.snapshot.generation !== candidate.generation ||
			verified.snapshot.sha256 !== snapshotFor(candidate).sha256
		)
			throw new HarnessAtomicWriteUnsupported("post-rename verification failed");
		if ((statSync(path).mode & 0o777) !== 0o600)
			throw new HarnessAtomicWriteUnsupported("owner-only state unavailable");
		return verified.snapshot;
	} catch (error) {
		if (error instanceof HarnessAtomicWriteUnsupported) throw error;
		throw new HarnessAtomicWriteUnsupported("atomic harness-state write unavailable");
	} finally {
		try {
			if (existsSync(temp)) unlinkSync(temp);
		} catch {
			/* only own temp; preserve original failure */
		}
	}
}
function recoverLocked(path: string, _scope: HarnessScope, reason: string): LoadedHarnessState {
	const raw = readFileSync(path);
	const dir = join(path, "..");
	const suffix = reason === "invalid_utf8" ? "bin" : "json";
	const recovery = join(dir, `harness_state.corrupt.${Date.now()}.${randomUUID().replaceAll("-", "")}.${suffix}`);
	try {
		const fd = openSync(recovery, "wx", 0o600);
		try {
			writeFileSync(fd, raw);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if ((statSync(recovery).mode & 0o777) !== 0o600) throw new Error("mode");
	} catch {
		throw new HarnessRecoveryRequired("unable to preserve corrupt harness state");
	}
	const state = emptyHarnessState();
	state.generation = 1;
	return { ...state, state, snapshot: writeAtomic(path, state), recovered: true, recovery: reason };
}
/** Load returns state and its CAS snapshot. Recovery is performed only under the shared lease. */
export function loadHarnessState(
	harnessStateDir: string = getGlobalHarnessStateDir(),
	scope: HarnessScope = "global",
): LoadedHarnessState {
	ensureRoot(harnessStateDir);
	const path = getHarnessStatePath(harnessStateDir);
	return withHarnessLease(path, () => {
		const loaded: Pick<LoadedHarnessState, "state" | "snapshot" | "recovered" | "recovery"> = (() => {
			try {
				const current = readState(path, scope);
				return { state: current.state, snapshot: current.snapshot, recovered: false };
			} catch (error) {
				if (!existsSync(path)) throw error;
				return recoverLocked(path, scope, error instanceof Error ? error.message : "invalid_json");
			}
		})();
		// Existing consumers received HarnessState directly. Keep that view while
		// making the snapshot explicit and non-serializable in canonical bytes.
		const result = loaded.state as LoadedHarnessState;
		Object.defineProperties(result, {
			state: { value: loaded.state, enumerable: false },
			snapshot: { value: loaded.snapshot, enumerable: false },
			recovered: { value: loaded.recovered, enumerable: false },
			recovery: { value: loaded.recovery, enumerable: false },
		});
		return result;
	});
}
/** Commit a candidate under a caller-owned planning snapshot; no last-writer-wins default exists. */
export function saveHarnessState(
	harnessStateDir: string,
	state: HarnessState,
	expected?: HarnessSnapshot,
	scope: HarnessScope = "global",
): HarnessSnapshot {
	const planningSnapshot = expected ?? (state as Partial<LoadedHarnessState>).snapshot;
	if (!planningSnapshot) throw new HarnessRecoveryRequired("save requires the caller planning snapshot");
	ensureRoot(harnessStateDir);
	const path = getHarnessStatePath(harnessStateDir);
	return withHarnessLease(path, () => {
		let actual: HarnessSnapshot;
		try {
			actual = readState(path, scope).snapshot;
		} catch {
			throw new HarnessRecoveryRequired("state must be reloaded before replacing corrupt content");
		}
		if (actual.generation !== planningSnapshot.generation || actual.sha256 !== planningSnapshot.sha256)
			throw new HarnessGenerationConflict(planningSnapshot, actual);
		const candidate: HarnessState = {
			schema: 2,
			generation: actual.generation + 1,
			entries: state.entries,
			refinements: state.refinements,
		};
		validateV2(candidate);
		return writeAtomic(path, candidate);
	});
}

export function mergeHarnessStates(globalState: HarnessState, localState?: HarnessState): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	for (const kind of Object.keys(merged.entries) as RefinementKind[]) {
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			const cloned = cloneEntry(entry)!;
			merged.entries[kind][id] = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "global") };
		}
		for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
			const cloned = cloneEntry(entry)!;
			const scopedEntry = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "local") };
			const mergedId = merged.entries[kind][id] ? `${scopedEntry.scope}:${id}` : id;
			merged.entries[kind][mergedId] = scopedEntry;
		}
	}
	merged.refinements = [...globalState.refinements, ...(localState?.refinements ?? [])];
	return merged;
}

export function getRefinementHistoryPath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, REFINEMENT_HISTORY_FILE_NAME);
}

function isRefinementResult(data: unknown): data is RefinementResult {
	return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
}

/**
 * Append a global-scope refinement to the cross-session history log so it can be
 * rolled back from any session. Local-scope refinements are recorded only in the
 * session JSONL and roll back via their recorded harnessStatePath.
 */
export function appendGlobalRefinement(harnessStateDir: string, result: RefinementResult): string {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	mkdirSync(harnessStateDir, { recursive: true });
	appendFileSync(historyPath, `${JSON.stringify(result)}\n`, "utf8");
	return historyPath;
}

export function loadGlobalRefinementHistory(harnessStateDir: string = getGlobalHarnessStateDir()): RefinementResult[] {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	if (!existsSync(historyPath)) {
		return [];
	}
	const results: RefinementResult[] = [];
	for (const line of readFileSync(historyPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRefinementResult(parsed)) {
				results.push(withDefaultRefinementScope(parsed, "global"));
			}
		} catch {
			// Skip malformed lines so a single bad append cannot break rollback.
		}
	}
	return results;
}

/**
 * Merge global and session refinement history, de-duplicating by id. Session entries
 * win on conflict so a session that is mid-flight still resolves its own latest result.
 */
export function mergeRefinementHistory(
	global: readonly RefinementResult[],
	session: readonly RefinementResult[],
): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	for (const result of global) {
		byId.set(result.id, result);
	}
	for (const result of session) {
		const existing = byId.get(result.id);
		byId.set(result.id, result.scope || !existing?.scope ? result : { ...result, scope: existing.scope });
	}
	return [...byId.values()];
}

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatHarnessStateForPrompt(
	state: HarnessState,
	options: {
		maxEntriesPerKind?: number;
		maxRefinements?: number;
		maxContentLength?: number;
		includeIpythonExamples?: boolean;
		includeShellExamples?: boolean;
		includeRefineExamples?: boolean;
	} = {},
): string {
	const maxEntriesPerKind = options.maxEntriesPerKind ?? DEFAULT_OVERVIEW_ENTRY_LIMIT;
	const maxRefinements = options.maxRefinements ?? DEFAULT_OVERVIEW_REFINEMENT_LIMIT;
	const maxContentLength = options.maxContentLength ?? DEFAULT_OVERVIEW_CONTENT_LIMIT;
	const includeIpythonExamples = options.includeIpythonExamples ?? true;
	const includeRefineExamples = options.includeRefineExamples ?? includeIpythonExamples;
	const lines = [
		"# Continual Harness State",
		"",
		"Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.",
		"The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.",
		"Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
		"Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
		"",
		includeRefineExamples
			? "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed."
			: "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.",
		"",
		includeIpythonExamples
			? "Call contract: read each installed Python skill's SKILL.md and call its documented module function in IPython; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm('sub-task')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries."
			: options.includeShellExamples
				? "Call contract: use installed skills as shell commands when available (for example `<skill_import> ...`). Continual harness entries are routing/context hints only in sessions without IPython; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents an IPython kernel."
				: "Call contract: continual harness entries are routing/context hints only in sessions without IPython or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.",
		"",
	];

	let totalEntries = 0;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = Object.values(state.entries[kind]).sort((a, b) =>
			[a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0")),
		);
		totalEntries += entries.length;
		// Render subagent specs as a task-shaped roster the model can match against — the
		// analogue of Claude Code's agent-type menu — rather than a bare count. In
		// IPython sessions, include the native `rlm` invocation hint.
		if (kind === "subagent" && entries.length > 0 && includeIpythonExamples) {
			lines.push(
				`${kind}: ${entries.length} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm('<task>')\`; admission returns a child handle, never the answer)`,
			);
		} else {
			lines.push(`${kind}: ${entries.length}`);
		}
		for (const entry of entries.slice(0, maxEntriesPerKind)) {
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${compactText(
					entry.content,
					maxContentLength,
				)}`,
			);
		}
		const overflow = entries.length - Math.min(entries.length, maxEntriesPerKind);
		if (overflow > 0) {
			lines.push(`- +${overflow} more ${kind} entries`);
		}
		lines.push("");
	}

	if (totalEntries === 0) {
		lines.push("No saved harness entries yet.", "");
	}

	lines.push(`recent refinements: ${state.refinements.length}`);
	for (const event of state.refinements.slice(-maxRefinements)) {
		const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
		const outcome = event.outcome ? `; outcome: ${compactText(event.outcome, maxContentLength)}` : "";
		lines.push(`- [${event.id}] ${compactText(event.trigger, maxContentLength)}: ${changes}${outcome}`);
	}
	const refinementOverflow = state.refinements.length - Math.min(state.refinements.length, maxRefinements);
	if (refinementOverflow > 0) {
		lines.push(`- +${refinementOverflow} older refinement events`);
	}

	return lines.join("\n").trim();
}

function overviewForPrompt(state: HarnessState): string {
	const lines: string[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = Object.values(state.entries[kind]);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, 40)) {
			const content = entry.content.replace(/\s+/g, " ").slice(0, 240);
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${content}`,
			);
		}
		if (entries.length > 40) {
			lines.push(`- +${entries.length - 40} more ${kind} entries`);
		}
	}
	return lines.join("\n");
}

function historyForPrompt(history: RefinementResult[]): string {
	if (history.length === 0) {
		return "No prior refinement history.";
	}
	return history
		.slice(-20)
		.map((item) => {
			const edits = item.appliedEdits
				.map((edit) => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`)
				.join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete in
 * this sense, while a complete-but-malformed reply is balanced. Brace slicing can
 * also produce a balanced fragment, so callers treat "balanced" as malformed.
 */
function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		// A truncated reply and a malformed one both fail here, and JSON.parse
		// describes the fragment rather than the cause. Name the cause instead.
		if (isIncompleteJson(candidate)) {
			throw new Error(TRUNCATED_JSON_ERROR);
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		// A reply truncated after a nested closing brace still looks well-formed
		// here, so this path needs the same diagnosis as the slicing fallback.
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	// Brace slicing recovers JSON wrapped in prose. On a reply truncated inside the
	// edits array it slices to an earlier edit's closing brace, so a failure here
	// is diagnosed against the original text rather than the balanced fragment.
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error(TRUNCATED_JSON_ERROR);
	}
	throw new Error("Refiner did not return a JSON object");
}

function parseProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Refiner JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	const edits = Array.isArray(record.edits) ? record.edits : [];
	return {
		summary: typeof record.summary === "string" ? record.summary : "Refined continual harness state",
		rationale: typeof record.rationale === "string" ? record.rationale : "",
		expectedOutcome: typeof record.expectedOutcome === "string" ? record.expectedOutcome : "",
		edits: edits
			.filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
			.map((edit) => ({
				action: edit.action as RefinementAction,
				kind: edit.kind as RefinementKind,
				id: typeof edit.id === "string" ? edit.id : undefined,
				title: typeof edit.title === "string" ? edit.title : undefined,
				content: typeof edit.content === "string" ? edit.content : undefined,
				path: typeof edit.path === "string" ? edit.path : undefined,
				reference: objectRecord(edit.reference),
				arguments: objectRecord(edit.arguments),
				metadata:
					typeof edit.metadata === "object" && edit.metadata !== null && !Array.isArray(edit.metadata)
						? (edit.metadata as Record<string, unknown>)
						: undefined,
				reason: typeof edit.reason === "string" ? edit.reason : undefined,
			})),
	};
}

function validateEdit(edit: RefinementEdit, computedId?: string): string | undefined {
	if (!["create", "update", "delete"].includes(edit.action)) {
		return `unsupported action ${String(edit.action)}`;
	}
	if (!["prompt", "memory", "skill", "subagent"].includes(edit.kind)) {
		return `unsupported kind ${String(edit.kind)}`;
	}
	if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || computedId === "base_system_prompt")) {
		return "base system prompt is not editable";
	}
	if (edit.action !== "create" && !edit.id) {
		return `${edit.action} requires id`;
	}
	if (edit.action !== "delete" && (!edit.title || !edit.content)) {
		return `${edit.action} requires title and content`;
	}
	if (edit.action !== "delete" && edit.kind === "skill" && edit.arguments === undefined) {
		return `${edit.action} skill requires arguments`;
	}
	if (edit.action !== "delete" && edit.kind === "skill") {
		const reference = edit.reference;
		if (!reference) {
			return `${edit.action} skill requires python reference`;
		}
		if (reference.type !== "python") {
			return `${edit.action} skill reference.type must be python`;
		}
		const hasImport =
			(typeof reference.import === "string" && reference.import.length > 0) ||
			(typeof reference.python_import === "string" && reference.python_import.length > 0);
		const hasCallable =
			(typeof reference.callable === "string" && reference.callable.length > 0) ||
			(typeof reference.call_pattern === "string" && reference.call_pattern.length > 0);
		if (!hasImport) {
			return `${edit.action} skill requires python import`;
		}
		if (!hasCallable) {
			return `${edit.action} skill requires callable or call_pattern`;
		}
	}
	return undefined;
}

export function applyRefinementProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: { id: string; rollbackOf?: string; scope?: HarnessScope; baselineState?: HarnessState },
): RefinementResult {
	const appliedEdits: AppliedRefinementEdit[] = [];
	const proposalModifiedKeys = new Set<string>();
	for (const edit of proposal.edits) {
		const computedId = edit.id ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);
		const id = computedId ?? "";
		const validationError = validateEdit(edit, id);
		if (validationError) {
			appliedEdits.push({ ...edit, id, applied: false, error: validationError });
			continue;
		}

		const records = state.entries[edit.kind];
		const before = cloneEntry(records[id]);
		const entryKey = `${edit.kind}:${id}`;
		const baseline = cloneEntry(options.baselineState?.entries[edit.kind][id]);
		if (
			options.baselineState &&
			!proposalModifiedKeys.has(entryKey) &&
			JSON.stringify(before) !== JSON.stringify(baseline)
		) {
			appliedEdits.push({
				...edit,
				id,
				before,
				applied: false,
				error: "entry changed during refinement planning",
			});
			continue;
		}
		if (edit.action === "delete") {
			if (!before) {
				appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
				continue;
			}
			delete records[id];
			proposalModifiedKeys.add(entryKey);
			appliedEdits.push({ ...edit, id, before, applied: true });
			continue;
		}
		if (edit.action === "create" && before) {
			appliedEdits.push({ ...edit, id, before, applied: false, error: "entry already exists" });
			continue;
		}
		if (edit.action === "update" && !before) {
			appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
			continue;
		}

		const createdAt = before?.created_at ?? now();
		const version = before ? before.version + 1 : 1;
		const after: HarnessEntry = {
			id,
			kind: edit.kind,
			title: edit.title ?? before?.title ?? id,
			content: edit.content ?? before?.content ?? "",
			path: edit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope ?? "local",
			reference: edit.reference ?? before?.reference ?? {},
			arguments: edit.arguments ?? before?.arguments ?? {},
			metadata: edit.metadata ?? before?.metadata ?? {},
			source: "refine",
			created_at: createdAt,
			updated_at: now(),
			version,
		};
		records[id] = after;
		proposalModifiedKeys.add(entryKey);
		appliedEdits.push({ ...edit, id, before, after: cloneEntry(after), applied: true });
	}

	const changes = appliedEdits.filter((edit) => edit.applied).map((edit) => `${edit.action} ${edit.kind}:${edit.id}`);
	state.refinements.push({
		id: options.id,
		trigger: proposal.summary,
		changes,
		evidence: proposal.rationale,
		outcome: proposal.expectedOutcome,
		created_at: now(),
	});

	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits,
		harnessStatePath: "",
		rollbackOf: options.rollbackOf,
		scope: options.scope,
	};
}

function rollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		if (edit.before) {
			edits.push({
				action: edit.after ? "update" : "create",
				kind: edit.kind,
				id: edit.id,
				title: edit.before.title,
				content: edit.before.content,
				path: edit.before.path,
				reference: edit.before.reference,
				arguments: edit.before.arguments,
				metadata: edit.before.metadata,
				reason: `Rollback ${target.id}`,
			});
		} else if (edit.after) {
			edits.push({
				action: "delete",
				kind: edit.kind,
				id: edit.id,
				reason: `Rollback ${target.id}`,
			});
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restores continual harness state snapshots from refinement ${target.id}.`,
		expectedOutcome: "Faulty refinement edits are reverted.",
		edits,
	};
}

export function getRefinementHistory(entries: readonly CustomEntry[]): RefinementResult[] {
	return entries
		.filter((entry) => entry.customType === REFINEMENT_CUSTOM_TYPE)
		.map((entry) => entry.data)
		.filter((data): data is RefinementResult => {
			return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
		});
}

export interface RefinementPlan {
	proposal: RefinementProposal;
	id: string;
	rollbackOf?: string;
	rollbackScope?: HarnessScope;
	/** Target-root state and its exact CAS snapshot captured before model planning. */
	baselineState?: HarnessState;
	rootSnapshot?: HarnessSnapshot;
}

/**
 * Produce a refinement proposal (the LLM pass, or a rollback proposal) without
 * mutating any harness state. Separated from {@link applyRefinementProposal} so
 * callers can re-read the harness file immediately before applying — the LLM call
 * here can take many seconds, during which the kernel or another session may write
 * the shared `harness_state.json`.
 */
export async function planRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementPlan> {
	const id = `refine_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
	if (options.rollbackId) {
		const target = history.find((item) => item.id === options.rollbackId);
		if (!target) {
			throw new Error(`Refinement ${options.rollbackId} not found`);
		}
		const fallbackScope: HarnessScope = options.global ? "global" : "local";
		return {
			proposal: rollbackProposal(target),
			id,
			rollbackOf: target.id,
			rollbackScope: inferRefinementResultScope(target) ?? fallbackScope,
		};
	}

	const conversationText = serializeConversation(convertToLlm(messages)).slice(-80_000);
	const scopeInstruction = options.global
		? "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
		: "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";
	const userPrompt = [
		`<current_harness_state>\n${overviewForPrompt(state)}\n</current_harness_state>`,
		`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
		`<conversation>\n${conversationText}\n</conversation>`,
		`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
		options.instructions ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>` : "",
		"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	// /refine requires a parseable JSON object in the final text. Some reasoning-capable
	// OpenAI-compatible models can spend the response on visible thinking and return no
	// final text, which makes otherwise successful daemon /refine calls fail parsing.
	// Keep the refinement request non-reasoning regardless of the interactive session
	// thinking level so the model uses its output budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: REFINEMENT_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: refinementMaxOutputTokens(model), signal, apiKey, headers },
	);

	if (response.stopReason === "error") {
		throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return { proposal: parseProposal(text), id };
}

function parseAutoRefineReview(text: string): AutoRefineReview {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Auto-refine review JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	return {
		shouldRefine: record.shouldRefine === true,
		rationale: typeof record.rationale === "string" ? record.rationale : "No rationale provided.",
		instructions: typeof record.instructions === "string" ? record.instructions : undefined,
	};
}

export async function reviewAutoRefine(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	context: AutoRefineReviewContext,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<AutoRefineReview> {
	const conversationText = serializeConversation(convertToLlm(messages)).slice(-40_000);
	const userPrompt = [
		`<trigger>
${context.reason}; ${context.turnsSinceLastReview} assistant turns since last auto-refine review
</trigger>`,
		`<current_harness_state>
${overviewForPrompt(state)}
</current_harness_state>`,
		`<refinement_history>
${historyForPrompt(history)}
</refinement_history>`,
		`<conversation>
${conversationText}
</conversation>`,
		"Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified facts likely to be reused in future sessions.",
	].join("\n\n");
	// Auto-refine review requires parseable JSON. Keep it non-reasoning so
	// reasoning-capable models use final text budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: autoRefineReviewMaxOutputTokens(model), signal, apiKey, headers },
	);
	if (response.stopReason === "error") {
		throw new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
	}
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseAutoRefineReview(text);
}

export async function refineHarness(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementResult> {
	const plan = await planRefinement(messages, state, history, model, apiKey, options, headers, signal, thinkingLevel);
	return applyRefinementProposal(state, plan.proposal, {
		id: plan.id,
		rollbackOf: plan.rollbackOf,
		scope: plan.rollbackScope ?? (options.global ? "global" : "local"),
	});
}
