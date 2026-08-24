import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * How sibling workers on one task graph share work in progress.
 *
 * blind        No sharing. Each worker sees only its own brief and artifacts. Cheapest, and
 *              the reviewer's independence is structural because it cannot see the author.
 * push_diffs   The host computes a diff when a worker edits an owned path and delivers it to
 *              subscribed reviewers. Deterministic: costs the sender no turn and the reviewer
 *              no poll.
 * full_comms   push_diffs, plus workers may message each other directly.
 */
export const AGENT_COLLABORATION_MODES = Object.freeze(["blind", "push_diffs", "full_comms"] as const);
export type AgentCollaborationMode = (typeof AGENT_COLLABORATION_MODES)[number];

export interface AgentCollaborationOptions {
	readonly mode: AgentCollaborationMode;
	/** Deliver pushes at the recipient's next turn boundary rather than after its whole task. */
	readonly midRunDelivery: boolean;
	/**
	 * Require a terminal red-team task: one that depends on real work and that nothing depends on.
	 * Because every task runs in a fresh worker context, that is a fresh-context review of the
	 * finished artifact — the check that caught defects an iterating reviewer walked past.
	 */
	readonly finalCheck: boolean;
	/** Upper bound on diff bytes delivered in one push; larger diffs are summarised to a stat line. */
	readonly maxDiffBytes: number;
}

export const DEFAULT_AGENT_COLLABORATION: AgentCollaborationOptions = Object.freeze({
	mode: "blind",
	midRunDelivery: false,
	finalCheck: true,
	maxDiffBytes: 8_000,
});

/**
 * Normalize caller-supplied collaboration options against the defaults.
 *
 * Args:
 * value: Partial options from settings; unknown modes fall back to the default.
 * Return: Complete options safe to act on.
 */
export function resolveAgentCollaboration(
	value: Partial<AgentCollaborationOptions> | undefined,
): AgentCollaborationOptions {
	if (value === undefined) return DEFAULT_AGENT_COLLABORATION;
	const mode = AGENT_COLLABORATION_MODES.find((candidate) => candidate === value.mode);
	const maxDiffBytes =
		typeof value.maxDiffBytes === "number" && Number.isSafeInteger(value.maxDiffBytes) && value.maxDiffBytes > 0
			? value.maxDiffBytes
			: DEFAULT_AGENT_COLLABORATION.maxDiffBytes;
	return Object.freeze({
		mode: mode ?? DEFAULT_AGENT_COLLABORATION.mode,
		midRunDelivery: value.midRunDelivery === true,
		finalCheck: value.finalCheck !== false,
		maxDiffBytes,
	});
}

/** Whether this mode shares diffs at all. */
export function sharesDiffs(options: AgentCollaborationOptions): boolean {
	return options.mode === "push_diffs" || options.mode === "full_comms";
}

/** Whether workers may address each other directly. */
export function allowsDirectMessages(options: AgentCollaborationOptions): boolean {
	return options.mode === "full_comms";
}

export interface AgentCollaborationDiff {
	readonly path: string;
	readonly body: string;
	readonly truncated: boolean;
}

/**
 * Compute the working-tree diff for one path, deterministically and with no model call.
 *
 * A diff produced here costs the editing worker no turn and the reviewing worker no poll,
 * which is the whole point: the mechanical part is the host's job.
 *
 * Args:
 * cwd: Repository directory to diff in.
 * path: File whose change should be described.
 * maxBytes: Cap on the returned body; larger diffs degrade to a --stat summary.
 * Return: The diff, or undefined when the path is unchanged or not tracked.
 */
export async function computePathDiff(
	cwd: string,
	path: string,
	maxBytes: number,
): Promise<AgentCollaborationDiff | undefined> {
	const diff = await run("git", ["diff", "--no-color", "--", path], { cwd, maxBuffer: 4 * 1024 * 1024 }).catch(
		() => undefined,
	);
	const body = diff?.stdout ?? "";
	if (body.trim().length === 0) return undefined;
	if (body.length <= maxBytes) return { path, body, truncated: false };
	// An oversized diff would cost every later turn of the recipient. Send the shape instead.
	const stat = await run("git", ["diff", "--stat", "--no-color", "--", path], { cwd }).catch(() => undefined);
	return {
		path,
		body: (stat?.stdout ?? "").trim() || `${path} changed (diff exceeded ${maxBytes} bytes)`,
		truncated: true,
	};
}

/**
 * Render a diff as the message body delivered to a reviewer.
 *
 * Args:
 * diff: Computed diff for one path.
 * author: Identifier of the worker that made the change.
 * Return: Message text.
 */
export function formatDiffPush(diff: AgentCollaborationDiff, author: string): string {
	const header = diff.truncated
		? `${author} changed ${diff.path} (summary only; full diff exceeded the delivery cap)`
		: `${author} changed ${diff.path}`;
	return `${header}\n\n${diff.body}`;
}

/**
 * Paths currently changed in the working tree.
 *
 * Asking git rather than parsing tool arguments keeps this correct for every tool that can
 * mutate a file — edit, shell, or IPython — instead of only the one the predicate knows about.
 *
 * Args:
 * cwd: Repository directory to inspect.
 * Return: Repo-relative paths with uncommitted changes.
 */
export async function changedPaths(cwd: string): Promise<readonly string[]> {
	const result = await run("git", ["diff", "--name-only"], { cwd }).catch(() => undefined);
	if (result === undefined) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Every path the working tree has changed, including untracked and staged files.
 *
 * `changedPaths` asks `git diff`, which cannot see a file that does not exist in HEAD yet. A
 * scope check has to see exactly that case: adding a second evaluator beside the real one is a
 * new file, not a modification.
 *
 * Args:
 * cwd: Repository directory to inspect.
 * Return: Repo-relative paths that differ from HEAD in any way.
 */
export async function touchedPaths(cwd: string): Promise<readonly string[]> {
	const result = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd }).catch(() => undefined);
	if (result === undefined) return [];
	return result.stdout
		.split("\n")
		.filter((line) => line.length > 3)
		.map((line) => {
			const entry = line.slice(3).trim();
			// A rename prints "old -> new"; the new path is the one that was written.
			const arrow = entry.lastIndexOf(" -> ");
			return arrow === -1 ? entry : entry.slice(arrow + 4);
		})
		.filter((path) => path.length > 0);
}

/**
 * Which written paths fall outside a task's declared ownership.
 *
 * The scheduler already refuses to let two tasks declare overlapping `ownedPaths`, but nothing
 * has ever compared a declaration to what a worker actually wrote. That gap is what makes
 * "the evaluator is off limits" prose: a worker can weaken the check that judges it and no
 * mechanical step notices. Declaring a boundary is what opts a task into this check — a task
 * that declared nothing is unconstrained: it is passed undefined and never reaches this function.
 *
 * Args:
 * written: Repo-relative paths the working tree shows as changed.
 * ownedPaths: Canonical path prefixes the task declared it owns.
 * Return: Written paths under no declared prefix, sorted. An empty prefix list permits nothing, so
 * every written path is returned.
 */
export function pathsOutsideOwned(written: readonly string[], ownedPaths: readonly string[]): readonly string[] {
	// An empty prefix list means nothing is permitted, so every write is outside it. Callers that
	// mean "unconstrained" pass undefined and never reach here.
	if (ownedPaths.length === 0) return [...new Set(written)].sort();
	return sortedUnique(written.filter((path) => !matchesAnyPrefix(path, ownedPaths)));
}

/**
 * Which written paths fall under a path the workflow declared immutable.
 *
 * Ownership is per task and says where a worker may write. This is the complement, and it is what
 * the named cheats actually look like: an evaluator edited so it stops failing, a control weakened,
 * a week set narrowed until the metric clears. Those are writes to files that must not change for
 * the run to mean anything, by any task, whatever it declared it owns. The host can check that with
 * git alone - no executor, no model judgment, no domain knowledge about what the files contain.
 *
 * Args:
 * written: Repo-relative paths the working tree shows as changed.
 * immutablePaths: Canonical path prefixes the workflow declared must not change.
 * Return: Written paths under some immutable prefix, sorted; empty when nothing is declared.
 */
export function pathsInsideProtected(written: readonly string[], immutablePaths: readonly string[]): readonly string[] {
	if (immutablePaths.length === 0) return [];
	return sortedUnique(written.filter((path) => matchesAnyPrefix(path, immutablePaths)));
}

/** Segment-wise prefix test: "src" covers "src/a.py" but never "srcfoo/a.py". */
function matchesAnyPrefix(path: string, prefixes: readonly string[]): boolean {
	const parts = segments(path);
	return prefixes.some((prefix) => {
		const prefixParts = segments(prefix);
		return prefixParts.length <= parts.length && prefixParts.every((part, index) => part === parts[index]);
	});
}

function segments(path: string): readonly string[] {
	return path.split("/").filter((part) => part.length > 0);
}

function sortedUnique(paths: readonly string[]): readonly string[] {
	return [...new Set(paths)].sort();
}

/**
 * How many tracked files sit under a path prefix.
 *
 * Asks git rather than the filesystem so a prefix is judged against what the repository actually
 * contains, not against an untracked build artifact that happens to share the name.
 *
 * Args:
 * cwd: Repository directory to inspect.
 * prefix: Repo-relative path prefix.
 * Return: Count of tracked files under the prefix; 0 when git cannot answer.
 */
export async function trackedUnder(cwd: string, prefix: string): Promise<number> {
	const result = await run("git", ["ls-files", "--", prefix], { cwd }).catch(() => undefined);
	if (result === undefined) return 0;
	return result.stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Linked worktrees of this repository that hold uncommitted work.
 *
 * Every host-side check here asks git about one directory: the session's cwd. An agent that creates a
 * worktree and edits there is therefore invisible to all of them, and an unobserved tree reads exactly
 * like an idle one - no changed paths, no violations, nothing to report. That is not hypothetical; a
 * live run moved itself into `~/.prime/worktrees/...` within half an hour and took its edits out of
 * view. This does not follow the agent there, which would mean guessing which tree is authoritative.
 * It reports that somewhere else is being written, which is the fact the operator actually needs.
 *
 * Args:
 * cwd: Repository directory the session observes.
 * Return: Absolute paths of other worktrees with uncommitted changes, sorted; empty when none.
 */
export async function worktreesWithChanges(cwd: string): Promise<readonly string[]> {
	const listed = await run("git", ["worktree", "list", "--porcelain"], { cwd }).catch(() => undefined);
	if (listed === undefined) return [];
	const paths = listed.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.filter((path) => path.length > 0);
	const here = await realpathOrSelf(cwd);
	const changed: string[] = [];
	for (const path of paths) {
		if ((await realpathOrSelf(path)) === here) continue;
		const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: path }).catch(
			() => undefined,
		);
		if (status !== undefined && status.stdout.trim().length > 0) changed.push(path);
	}
	return [...new Set(changed)].sort();
}

/** Resolve symlinks so /tmp and /private/tmp do not read as different trees; fall back to the input. */
async function realpathOrSelf(path: string): Promise<string> {
	return await realpath(path).catch(() => path);
}
