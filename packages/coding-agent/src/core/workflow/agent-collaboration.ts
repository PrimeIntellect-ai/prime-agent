import { execFile } from "node:child_process";
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
