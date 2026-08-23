/**
 * SARK retained-tools T03: usage event sources (honest-signal counters).
 *
 * Counters update only from the sources defined in
 * docs/retained-tools/phase-a-index.md "Event sources":
 * - `used`: /skill:<name> invocation, kernel file read of a known SKILL.md,
 *   Python skill function call via the host-request path.
 * - `explicit_ok` / `explicit_fail`: explicit user statements in following
 *   turns, record_refinement outcomes referencing the tool, and Python skill
 *   calls that completed or raised.
 *
 * Session-level success never counts as tool success.
 *
 * Recording only updates entries that already exist in the per-scope tool
 * index. Bundled and path-injected skills have no index entry and are not
 * tracked here; nothing is ever created. All failures degrade to a log line.
 */

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";
import type { HarnessRefinementEvent } from "../refinement/refinement.js";
import { loadToolIndex, saveToolIndex, type ToolScope } from "./index.js";

const log = getLogger("retained-tools.usage");

export type ToolUsageEventKind = "used" | "explicit_ok" | "explicit_fail";

export interface ToolUsageEvent {
	skillName: string;
	event: ToolUsageEventKind;
	/** Short context for failures (error message, outcome text, user statement). */
	note?: string;
}

export interface RecordToolUsageEventOptions {
	skillName: string;
	event: ToolUsageEventKind;
	scope: ToolScope;
	cwd: string;
	agentDir?: string;
	note?: string;
}

const MAX_RECENT_FAILURES = 20;
const MAX_NOTE_LENGTH = 200;

function truncateNote(note?: string): string | undefined {
	if (!note) return undefined;
	const trimmed = note.trim().replace(/\s+/g, " ");
	if (!trimmed) return undefined;
	return trimmed.length > MAX_NOTE_LENGTH ? trimmed.slice(0, MAX_NOTE_LENGTH) : trimmed;
}

/** Resolve the tool index directory for a scope. */
export function resolveToolIndexDir(scope: ToolScope, cwd: string, agentDir?: string): string {
	if (scope === "global") return join(agentDir ?? getAgentDir(), "tools");
	return join(cwd, CONFIG_DIR_NAME, "tools");
}

/**
 * Record a usage event against an existing tool index entry.
 *
 * Returns true when a counter was updated. Entries that do not exist are left
 * alone (no creation): bundled skills and skills loaded from paths outside the
 * two tracked roots have no index entry and are not counted.
 */
export function recordToolUsageEvent(options: RecordToolUsageEventOptions): boolean {
	try {
		const toolsDir = resolveToolIndexDir(options.scope, options.cwd, options.agentDir);
		const index = loadToolIndex(toolsDir);
		const entry = index.skills[options.skillName];
		if (!entry) return false;
		const now = new Date().toISOString();
		if (options.event === "used") {
			entry.usage.used += 1;
			entry.usage.last_used = now;
		} else if (options.event === "explicit_ok") {
			entry.usage.explicit_ok += 1;
			entry.usage.last_status = "ok";
		} else {
			entry.usage.explicit_fail += 1;
			entry.usage.last_status = "fail";
			entry.usage.recent_failures.push({ at: now, note: truncateNote(options.note) ?? "" });
			while (entry.usage.recent_failures.length > MAX_RECENT_FAILURES) {
				entry.usage.recent_failures.shift();
			}
		}
		index.updated = now;
		saveToolIndex(toolsDir, index);
		return true;
	} catch (error) {
		log.warn("tool usage recording failed", {
			skillName: options.skillName,
			event: options.event,
			scope: options.scope,
			error: String(error),
		});
		return false;
	}
}

// =============================================================================
// Explicit outcome classification (user statements and refinement outcomes)
// =============================================================================

const OK_PATTERNS: RegExp[] = [
	/\b(it|that|this|these|they|all|one)\s+worked\b/i,
	/\bworked\s+(for me|on it|on this|on the|great|perfectly|fine|as intended|as expected)\b/i,
	/\bnow\s+(works|working|fixed|solved|resolved|green)\b/i,
	/\b(it|that|this|they|the (?:problem|issue|bug|error|build|run|tests?|things?))\s+(?:is\s+|was\s+)?(?:fixed|resolved|working|solved|green|stable)\b/i,
	/\bthat\s+(?:did|does)\s+it\b/i,
	/\bsuccess(?:ful|fully)?\b/i,
	/\bsucceeded\b/i,
	/\bthat\s+solved\s+(?:it|the\s+\w+)\b/i,
	/\beverything\s+(?:is\s+)?(?:working|fine|ok|okay|good)\s+now\b/i,
	/\ball\s+(?:good|working)\b/i,
	/\bexactly\s+(?:what\s+i\s+(?:needed|wanted)|right)\b/i,
	/\bthanks?\s+for\s+(?:fixing|resolving|sorting)\b/i,
	/\bregression\s+(?:is\s+)?(?:gone|fixed|resolved)\b/i,
	/\blooks\s+(?:good|right|perfect)\s+now\b/i,
	/\bthe\s+build\s+(?:is\s+)?(?:green|passing)\b/i,
];

const FAIL_PATTERNS: RegExp[] = [
	/\b(it|that|this|these|they|the (?:build|run|tests?|command|tool|skill|change|fix|code|things?))\s+(?:failed|broke|crashed|regressed|is\s+broken|was\s+broken|is\s+not\s+working|was\s+not\s+working|does\s+not\s+work|did\s+not\s+work|is\s+still\s+(?:broken|failing))\b/i,
	/\bstill\s+(?:fails?|failing|broken|crash(?:es|ed|ing)?|throw(?:s|ing|ed)?|not\s+working|regressed?)\b/i,
	/\bbroke\s+(?:the|my|a|an|it|this|that|things?|code|build|tests?|ci|session|run|change)\b/i,
	/\bnot\s+(?:fixed|resolved)\b/i,
	/\bthrew\s+(?:an?\s+)?(?:error|exception|traceback)\b/i,
	/\bregressed\b/i,
];

/** Normalize apostrophes so contractions read as plain negations. */
function normalizeOutcomeText(text: string): string {
	return text.replace(/’s\b|'s\b/g, " is").replace(/n’t\b|n't\b/g, " not");
}

/**
 * Classify a statement (user turn or refinement outcome) as an explicit tool
 * success or failure. Returns null when the statement carries no explicit
 * outcome, or when it claims both (ambiguous — do not count).
 */
export function classifyExplicitOutcome(text: string): "explicit_ok" | "explicit_fail" | null {
	if (!text || !text.trim()) return null;
	const normalized = normalizeOutcomeText(text);
	const ok = OK_PATTERNS.some((re) => re.test(normalized));
	const fail = FAIL_PATTERNS.some((re) => re.test(normalized));
	if (ok && fail) return null;
	if (ok) return "explicit_ok";
	if (fail) return "explicit_fail";
	return null;
}

// =============================================================================
// Kernel cell SKILL.md read detection
// =============================================================================

export interface SkillFileReadSource {
	/** Skill name (index key). */
	name: string;
	/** Absolute path to the skill's SKILL.md file. */
	skillFilePath: string;
	/** Optional skill base directory; used to derive extra path variants. */
	baseDir?: string;
}

const READ_BEFORE_TOKENS = [
	"open(",
	".read_text(",
	"read_text(",
	".read_bytes(",
	"read_bytes(",
	".read_string(",
	"read_string(",
	".readFileSync(",
	"readFileSync(",
	".readFile(",
	"readFile(",
	"read_file(",
	"cat ",
	"head ",
	"tail ",
	"grep ",
	"less ",
	"more ",
];

const READ_AFTER_TOKENS = [").read_text(", ").read_bytes(", ").read_string(", ").read(", ").readFileSync("];

const WRITE_TOKENS = [
	".write_text(",
	"write_text(",
	".write_bytes(",
	"write_bytes(",
	".write_string(",
	"write_string(",
	".writeFileSync(",
	"writeFileSync(",
	".writeFile(",
	"writeFile(",
	"write_file(",
	".write(",
	"writelines(",
];

const WRITE_MODE_RE = /["']w[ab+]*["']|mode\s*=\s*["']w/;

function pathVariants(source: SkillFileReadSource, cwd: string): string[] {
	const variants = new Set<string>();
	const abs = resolve(source.skillFilePath);
	variants.add(abs);
	const home = homedir();
	if (abs === home || abs.startsWith(home + sep)) {
		const tilde = abs === home ? "~" : `~${abs.slice(home.length)}`;
		variants.add(tilde);
		variants.add(tilde.split(sep).join("/"));
	}
	const posixAbs = abs.split(sep).join("/");
	if (posixAbs !== abs) variants.add(posixAbs);
	try {
		const rel = relative(cwd, abs);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
			variants.add(rel.split(sep).join("/"));
		}
	} catch {
		// ignore relative-path failures
	}
	if (source.baseDir) {
		// Cells may reference the skill file relative to its base dir.
		try {
			const basePosix = resolve(source.baseDir).split(sep).join("/");
			const baseRel = relative(cwd, resolve(source.baseDir));
			if (baseRel && !baseRel.startsWith("..") && !isAbsolute(baseRel)) {
				variants.add(`${baseRel.split(sep).join("/")}/SKILL.md`);
			}
			variants.add(`${basePosix}/SKILL.md`);
		} catch {
			// ignore
		}
	}
	return [...variants];
}

function isReadOccurrence(code: string, idx: number, variantLength: number): boolean {
	const lineStart = code.lastIndexOf("\n", idx) + 1;
	let lineEnd = code.indexOf("\n", idx);
	if (lineEnd === -1) lineEnd = code.length;
	const line = code.slice(lineStart, lineEnd);
	// Writes to the skill file (or mode "w" opens) are not reads.
	if (WRITE_TOKENS.some((t) => line.includes(t)) || WRITE_MODE_RE.test(line)) return false;
	// Shell redirect target (cat other.txt > skill.md) is a write.
	if (idx > 0 && code[idx - 1] === ">") return false;
	const before = code.slice(Math.max(0, idx - 160), idx);
	const after = code.slice(idx + variantLength, idx + variantLength + 60);
	if (READ_BEFORE_TOKENS.some((t) => before.includes(t))) return true;
	return READ_AFTER_TOKENS.some((t) => after.includes(t));
}

/**
 * Detect which known skills' SKILL.md files a kernel cell source reads.
 *
 * Heuristic: an occurrence of the skill file path (or a cwd/base-dir relative
 * variant) counts as a read when a read call or shell read command is nearby
 * and no write call/mode is on the same line. At most one event per skill per
 * cell. Returns the set of skill names read.
 */
export function detectSkillFileReads(code: string, sources: readonly SkillFileReadSource[], cwd: string): Set<string> {
	const found = new Set<string>();
	if (!code || sources.length === 0) return found;
	for (const source of sources) {
		let matched = false;
		for (const variant of pathVariants(source, cwd)) {
			let idx = code.indexOf(variant);
			while (idx !== -1) {
				if (isReadOccurrence(code, idx, variant.length)) {
					matched = true;
					break;
				}
				idx = code.indexOf(variant, idx + 1);
			}
			if (matched) break;
		}
		if (matched) found.add(source.name);
	}
	return found;
}

// =============================================================================
// User-statement attribution
// =============================================================================

export interface OutcomeAttribution {
	scope: ToolScope;
	skillName: string;
	event: "explicit_ok" | "explicit_fail";
}

interface PendingOutcome {
	scope: ToolScope;
	skillName: string;
	at: number;
}

function mentionBoundary(name: string): RegExp {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`);
}

/** Case-insensitive skill mention check (also matches the python import alias). */
export function textMentionsSkill(text: string, skillName: string): boolean {
	const normalized = text.toLowerCase();
	const aliases = new Set([skillName.toLowerCase(), skillName.toLowerCase().replace(/-/g, "_")]);
	for (const alias of aliases) {
		if (!alias) continue;
		if (mentionBoundary(alias).test(normalized)) return true;
	}
	return false;
}

/**
 * Substitute mentioned skill names with the pronoun "it" so outcome phrases
 * with the skill as subject ("demo-tool worked") classify like "it worked".
 */
function substituteSkillMentions(text: string, skillNames: readonly string[]): string {
	let result = text;
	for (const name of skillNames) {
		for (const alias of [name, name.replace(/-/g, "_")]) {
			if (!alias) continue;
			const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const re = new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, "gi");
			result = result.replace(re, "it");
		}
	}
	return result;
}

/**
 * Tracks which tools have been used since their explicit outcome was
 * attributed, so a user statement in a following turn can be attached to the
 * right tool. Statements must name the skill (or use the most recently used
 * pending skill) — nothing is attributed blindly.
 */
export class ExplicitOutcomeTracker {
	private readonly pending = new Map<string, PendingOutcome>();

	private key(scope: ToolScope, skillName: string): string {
		return `${scope}\u0000${skillName}`;
	}

	markUsed(scope: ToolScope, skillName: string, at: number = Date.now()): void {
		const key = this.key(scope, skillName);
		const existing = this.pending.get(key);
		this.pending.set(key, { scope, skillName, at: existing && existing.at > at ? existing.at : at });
		while (this.pending.size > 50) {
			let oldestKey: string | undefined;
			let oldestAt = Infinity;
			for (const [k, v] of this.pending) {
				if (v.at < oldestAt) {
					oldestAt = v.at;
					oldestKey = k;
				}
			}
			if (oldestKey) this.pending.delete(oldestKey);
			else break;
		}
	}

	/**
	 * Classify a user statement and attribute it to a pending tool.
	 *
	 * Attribution: a named pending skill wins (project scope shadows global
	 * for the same name); otherwise the most recently used pending skill.
	 * Returns null when the statement has no explicit outcome, nothing is
	 * pending, or the statement names a skill that is not pending.
	 */
	onUserStatement(text: string, knownSkillNames: readonly string[]): OutcomeAttribution | null {
		const named = knownSkillNames.filter((name) => textMentionsSkill(text, name));
		const event = classifyExplicitOutcome(named.length > 0 ? substituteSkillMentions(text, named) : text);
		if (!event || this.pending.size === 0) return null;
		let pool = this.pending;
		if (named.length > 0) {
			pool = new Map([...this.pending].filter(([, v]) => named.includes(v.skillName)));
		}
		let best: PendingOutcome | undefined;
		for (const candidate of pool.values()) {
			if (!best) {
				best = candidate;
				continue;
			}
			if (candidate.scope === "project" && best.scope !== "project") {
				best = candidate;
				continue;
			}
			if (candidate.scope === best.scope && candidate.at > best.at) best = candidate;
		}
		if (!best) return null;
		pool.delete(this.key(best.scope, best.skillName));
		return { scope: best.scope, skillName: best.skillName, event };
	}

	get size(): number {
		return this.pending.size;
	}

	clear(): void {
		this.pending.clear();
	}
}

// =============================================================================
// Refinement (record_refinement) outcome extraction
// =============================================================================

const SKILL_CHANGE_RE = /^(?:create|update|delete)\s+(?:python\s+)?skill:([^\s:]+)/i;

export interface RefinementToolSignal {
	skillName: string;
	event: "explicit_ok" | "explicit_fail";
}

/**
 * Extract a retained-tool explicit outcome from a record_refinement event.
 *
 * The event's outcome text must contain an explicit success/failure phrase,
 * and the event must reference exactly one known skill — via a structured
 * `skill:<name>` change, or a skill name mentioned in the event text.
 * Multiple or zero skill references yield no signal (conservative).
 */
export function extractRefinementToolSignals(
	event: Pick<HarnessRefinementEvent, "trigger" | "changes" | "outcome">,
	knownSkillNames: readonly string[],
): RefinementToolSignal | null {
	const outcome = (event.outcome ?? "").trim();
	const eventKind = classifyExplicitOutcome(outcome);
	if (!eventKind || knownSkillNames.length === 0) return null;
	const names = new Set<string>();
	for (const change of event.changes) {
		const match = SKILL_CHANGE_RE.exec(change.trim());
		if (match) {
			const candidate = match[1].replace(/[.,;:!?]+$/, "");
			if (knownSkillNames.includes(candidate)) names.add(candidate);
		}
	}
	if (names.size === 0) {
		const haystack = [event.trigger, ...event.changes, outcome].join("\n");
		for (const name of knownSkillNames) {
			if (textMentionsSkill(haystack, name)) names.add(name);
		}
	}
	if (names.size !== 1) return null;
	return { skillName: [...names][0], event: eventKind };
}
