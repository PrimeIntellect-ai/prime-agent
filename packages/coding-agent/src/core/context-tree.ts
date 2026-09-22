import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { RlmChildAgentStatus } from "./agent-session.js";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.js";
import type { ContextUsage } from "./extensions/index.js";
import { buildSessionContext, type FileEntry, loadEntriesFromBuffer, type SessionEntry } from "./session-manager.js";
import { addAssistantUsage, cloneUsage, emptyUsage, subtractAssistantUsage } from "./usage.js";

/** Resolves a model's context window so disk-only nodes can report utilization. */
export type ContextWindowResolver = (provider: string, modelId: string) => number | undefined;

/**
 * One agent in the context overview: the main session or an RLM (sub-)agent.
 * `ownUsage` excludes descendants; `totalUsage` includes completed descendants, matching /usage.
 */
export interface ContextTreeNode {
	/** "root" for the session itself; sub-xxxx for an RLM child. */
	id: string;
	label: string;
	status: "active" | RlmChildAgentStatus;
	model?: { provider: string; id: string };
	ownUsage: Usage;
	totalUsage: Usage;
	contextUsage?: ContextUsage;
	children: ContextTreeNode[];
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & {
	type: "message";
	message: AssistantMessage;
} {
	return entry.type === "message" && entry.message.role === "assistant";
}

function readUserMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function compactLabel(text: string, maxLength = 80): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/**
 * Usage totals for one agent: `totalUsage` sums the branch's assistant usage
 * (attributed aggregates, so descendants are included), `ownUsage` removes the
 * attributions targeting those assistants. Attribution entries are matched by
 * target across ALL entries, not just the branch: attributions rewrite the
 * target assistant's usage no matter which branch they were appended on, so a
 * fork that keeps the assistant but drops the attribution entry must still
 * subtract it.
 *
 * Totals are deliberately cumulative across compactions: compaction shrinks
 * the model-facing context, not what the session has spent, so assistants
 * dropped from the resolved context still count here.
 */
export function computeOwnAndTotalUsage(
	branch: SessionEntry[],
	allEntries: SessionEntry[],
): { ownUsage: Usage; totalUsage: Usage } {
	const totalUsage = emptyUsage();
	const branchAssistantIds = new Set<string>();
	for (const entry of branch) {
		if (isAssistantEntry(entry)) {
			branchAssistantIds.add(entry.id);
			addAssistantUsage(totalUsage, entry.message.usage);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addAssistantUsage(totalUsage, entry.usage);
		}
	}
	const ownUsage = cloneUsage(totalUsage);
	for (const entry of allEntries) {
		if (entry.type === "child_usage_attributed" && branchAssistantIds.has(entry.targetId)) {
			subtractAssistantUsage(ownUsage, entry.childUsage);
		}
	}
	return { ownUsage, totalUsage };
}

/**
 * Current context utilization from persisted entries, mirroring
 * AgentSession.getContextUsage(): unknown right after a compaction until the
 * next assistant response, otherwise the last assistant usage plus an
 * estimate for trailing messages (tool results, queued user input) that have
 * not hit the model yet.
 */
function computeContextUsageFromEntries(
	allEntries: SessionEntry[],
	branch: SessionEntry[],
	contextWindow: number | undefined,
): ContextUsage | undefined {
	if (!contextWindow || contextWindow <= 0) {
		return undefined;
	}

	let latestCompactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			latestCompactionIndex = i;
			break;
		}
	}

	if (latestCompactionIndex >= 0) {
		let hasPostCompactionUsage = false;
		for (let i = branch.length - 1; i > latestCompactionIndex; i--) {
			const entry = branch[i];
			if (!isAssistantEntry(entry)) {
				continue;
			}
			const assistant = entry.message;
			if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
				continue;
			}
			if (calculateContextTokens(assistant.usage) > 0) {
				hasPostCompactionUsage = true;
			}
			break;
		}
		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const estimate = estimateContextTokens(buildSessionContext(allEntries).messages);
	if (estimate.tokens <= 0) {
		return undefined;
	}
	return { tokens: estimate.tokens, contextWindow, percent: (estimate.tokens / contextWindow) * 100 };
}

/**
 * Read and parse a session file, returning the entries plus the byte count
 * read, which lets the cache verify the read was a complete snapshot.
 */
function readSessionFile(file: string): { entries: SessionEntry[]; bytes: number } | undefined {
	let buffer: Buffer;
	try {
		buffer = readFileSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	const entries = loadEntriesFromBuffer(buffer).filter(
		(entry: FileEntry): entry is SessionEntry => entry.type !== "session",
	);
	return { entries, bytes: buffer.length };
}

/**
 * Entries on the current branch, root to leaf, mirroring
 * SessionManager.getBranch(): the leaf is the last appended entry and the
 * branch is its parentId chain. Keeps forked/abandoned paths out of usage
 * sums so disk nodes match what a live session would report.
 */
function branchEntries(entries: SessionEntry[]): SessionEntry[] {
	if (entries.length === 0) {
		return [];
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = entries[entries.length - 1];
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

/**
 * Terminal status for a persisted child, inferred from how its last assistant
 * turn ended: errored and aborted runs should not render as successful.
 */
function statusFromBranch(entries: SessionEntry[]): "done" | "error" | "cancelled" {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isAssistantEntry(entry)) {
			continue;
		}
		if (entry.message.stopReason === "error") {
			return "error";
		}
		if (entry.message.stopReason === "aborted") {
			return "cancelled";
		}
		return "done";
	}
	return "done";
}

/** Newest session file in a dir plus the stats that key the node cache. */
interface SessionFile {
	path: string;
	size: number;
	mtimeMs: number;
}

function findSessionFile(dir: string): SessionFile | undefined {
	let newest: { file: SessionFile; mtime: number } | undefined;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) {
			continue;
		}
		const path = join(dir, name);
		try {
			const stats = statSync(path);
			const mtime = stats.mtime.getTime();
			if (!newest || mtime > newest.mtime) {
				newest = { file: { path, size: stats.size, mtimeMs: stats.mtimeMs }, mtime };
			}
		} catch {
			// Skip unreadable files.
		}
	}
	return newest?.file;
}

function listChildSessionDirs(rlmSessionDir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(rlmSessionDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith("sub-"))
		.map((name) => join(rlmSessionDir, name))
		.filter((path) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		})
		.sort((a, b) => {
			try {
				return statSync(a).mtime.getTime() - statSync(b).mtime.getTime();
			} catch {
				return 0;
			}
		});
}

/**
 * Cache entry for a completed child session dir: the built node plus the
 * stats it was built from; a changed nested child file invalidates it too.
 */
interface ChildNodeCacheEntry {
	file: SessionFile;
	childFiles: Map<string, SessionFile | undefined>;
	contextWindow: number | undefined;
	node: ContextTreeNode;
}

/**
 * Node cache for completed RLM child sessions: every top-bar cost refresh or
 * /context call rebuilds the whole tree, and re-parsing finished children dominated it.
 */
const childNodeCache = new Map<string, ChildNodeCacheEntry>();
/** Insertion-order cap so a long-lived daemon cannot accumulate entries. */
const CHILD_NODE_CACHE_MAX = 256;

function listChildSessionFiles(rlmSessionDir: string): Map<string, SessionFile | undefined> {
	const files = new Map<string, SessionFile | undefined>();
	for (const childDir of listChildSessionDirs(rlmSessionDir)) {
		files.set(childDir, findSessionFile(childDir));
	}
	return files;
}

function sameSessionFile(a: SessionFile | undefined, b: SessionFile | undefined): boolean {
	return a !== undefined && b !== undefined && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sameChildFiles(
	cached: Map<string, SessionFile | undefined>,
	current: Map<string, SessionFile | undefined>,
): boolean {
	if (cached.size !== current.size) {
		return false;
	}
	for (const [dir, file] of cached) {
		if (!current.has(dir)) {
			return false;
		}
		const other = current.get(dir);
		if (file === undefined || other === undefined) {
			if (file !== other) {
				return false;
			}
		} else if (file.path !== other.path || file.size !== other.size || file.mtimeMs !== other.mtimeMs) {
			return false;
		}
	}
	return true;
}

/**
 * The registry can change a model's context window while its session file
 * stays unchanged, so cache hits compare the resolved value too.
 */
function resolvesToSameContextWindow(entry: ChildNodeCacheEntry, resolveContextWindow: ContextWindowResolver): boolean {
	const contextWindow = entry.node.model
		? resolveContextWindow(entry.node.model.provider, entry.node.model.id)
		: undefined;
	return contextWindow === entry.contextWindow;
}

/**
 * Build a context node for a completed RLM child from its persisted session
 * dir (sub-xxxx/). Children that already attributed grandchild usage carry the
 * aggregate on their assistant messages (applyChildUsageAttributions), so own
 * usage is recovered by subtracting the attribution entries. Returns undefined
 * when the dir holds no readable session.
 */
export function loadContextTreeChildFromDisk(
	childSessionDir: string,
	resolveContextWindow: ContextWindowResolver,
): ContextTreeNode | undefined {
	const file = findSessionFile(childSessionDir);
	if (!file) {
		// Never surface a cached node for a dir whose session file is gone.
		childNodeCache.delete(childSessionDir);
		return undefined;
	}
	const childFiles = listChildSessionFiles(childSessionDir);
	const cached = childNodeCache.get(childSessionDir);
	if (
		cached &&
		sameSessionFile(cached.file, file) &&
		sameChildFiles(cached.childFiles, childFiles) &&
		resolvesToSameContextWindow(cached, resolveContextWindow)
	) {
		const children: ContextTreeNode[] = [];
		for (const grandchildDir of childFiles.keys()) {
			const childNode = loadContextTreeChildFromDisk(grandchildDir, resolveContextWindow);
			if (childNode) {
				children.push(childNode);
			}
		}
		let changed = children.length !== cached.node.children.length;
		for (let i = 0; !changed && i < children.length; i++) {
			if (children[i] !== cached.node.children[i]) {
				changed = true;
			}
		}
		if (changed) {
			cached.node = { ...cached.node, children };
		}
		return cached.node;
	}
	return buildContextTreeChildFromDisk(childSessionDir, file, childFiles, resolveContextWindow);
}

function buildContextTreeChildFromDisk(
	childSessionDir: string,
	file: SessionFile,
	childFiles: Map<string, SessionFile | undefined>,
	resolveContextWindow: ContextWindowResolver,
): ContextTreeNode | undefined {
	const read = readSessionFile(file.path);
	if (!read) {
		return undefined;
	}
	const allEntries = read.entries;
	const branch = branchEntries(allEntries);
	if (branch.length === 0) {
		return undefined;
	}

	const { ownUsage, totalUsage } = computeOwnAndTotalUsage(branch, allEntries);

	let model: { provider: string; id: string } | undefined;
	for (const entry of branch) {
		if (entry.type === "model_change") {
			model = { provider: entry.provider, id: entry.modelId };
		}
	}

	let label = "";
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			label = compactLabel(readUserMessageText(entry.message.content));
			if (label) {
				break;
			}
		}
	}

	const contextWindow = model ? resolveContextWindow(model.provider, model.id) : undefined;

	const node: ContextTreeNode = {
		id: basename(childSessionDir),
		label: label || "child agent",
		status: statusFromBranch(branch),
		model,
		ownUsage,
		totalUsage,
		contextUsage: computeContextUsageFromEntries(allEntries, branch, contextWindow),
		children: [],
	};
	for (const grandchildDir of childFiles.keys()) {
		const childNode = loadContextTreeChildFromDisk(grandchildDir, resolveContextWindow);
		if (childNode) {
			node.children.push(childNode);
		}
	}
	cacheBuiltChildNode(childSessionDir, file, childFiles, read.bytes, contextWindow, node);
	return node;
}

/**
 * Cache the node only when the read was a stable snapshot: an append or
 * compaction rewrite that raced the read skips caching, re-parsing next time.
 */
function cacheBuiltChildNode(
	childSessionDir: string,
	file: SessionFile,
	childFiles: Map<string, SessionFile | undefined>,
	bytes: number,
	contextWindow: number | undefined,
	node: ContextTreeNode,
): void {
	let stable = false;
	try {
		const stats = statSync(file.path);
		stable = stats.size === bytes && stats.size === file.size && stats.mtimeMs === file.mtimeMs;
	} catch {
		// The file vanished mid-build; nothing to pin the stats to.
	}
	if (!stable) {
		return;
	}
	// Delete first so a re-set entry moves to the end; the cap evicts from the front.
	childNodeCache.delete(childSessionDir);
	childNodeCache.set(childSessionDir, { file, childFiles, contextWindow, node });
	while (childNodeCache.size > CHILD_NODE_CACHE_MAX) {
		const oldest = childNodeCache.keys().next();
		if (oldest.done) {
			break;
		}
		childNodeCache.delete(oldest.value);
	}
}

/**
 * Build context nodes for all persisted RLM children under an RLM session
 * dir, recursing into nested sub-* dirs for grandchildren. `skipIds`
 * excludes children that are already represented live.
 */
export function loadContextTreeChildrenFromDisk(
	rlmSessionDir: string | undefined,
	resolveContextWindow: ContextWindowResolver,
	skipIds?: ReadonlySet<string>,
): ContextTreeNode[] {
	if (!rlmSessionDir || !existsSync(rlmSessionDir)) {
		return [];
	}
	const nodes: ContextTreeNode[] = [];
	for (const childDir of listChildSessionDirs(rlmSessionDir)) {
		if (skipIds?.has(basename(childDir))) {
			continue;
		}
		const node = loadContextTreeChildFromDisk(childDir, resolveContextWindow);
		if (node) {
			nodes.push(node);
		}
	}
	return nodes;
}
