import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { expandCollapseHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import { spawnHidden, waitForChildProcess } from "../../utils/child-process.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";

import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { previewBashCommand } from "./code-preview.js";
import { OutputAccumulator } from "./output-accumulator.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.js";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	allowDestructiveGit: Type.Optional(
		Type.Boolean({
			description:
				"Skip the dirty-tree guard for destructive git discard commands. Only set when discarding uncommitted work is intentional.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawnHidden(shell, [...args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

/** Bypass env var for the destructive-git dirty-tree guard. */
export const BASH_DESTRUCTIVE_GIT_BYPASS_ENV = "PI_BASH_ALLOW_DESTRUCTIVE_GIT";

const GIT_STATUS_PORCELAIN_COMMAND = "git status --porcelain --untracked-files=all";

/** How many dirty paths the refusal lists before eliding the rest. */
const MAX_DIRTY_PATHS_LISTED = 10;

/**
 * Detection for git commands that discard uncommitted working-tree changes
 * (the "clean the worktree" discard idiom).
 *
 * Conservative by design: a false positive costs one `git status` probe and
 * an explicit-bypass retry; a false negative silently loses work. Matching is
 * best-effort shell-text heuristics, not a parse.
 */

/**
 * Optional git global options between `git` and the subcommand, for example
 * `git -C dir reset --hard`, `git -c key=value checkout -- .`, or
 * `git --git-dir=dir/.git reset --hard`. Kept within one shell segment
 * (no ;&|) so it cannot swallow the rest of a chained command.
 */
const GIT_GLOBAL_OPTIONS = "(?:-{1,2}[^\\s;&|]+(?:\\s+(?:\"[^\"]*\"|'[^']*'|[^\\s;&|]+))?\\s+)*";

const DISCARD_CHECKOUT_PATTERN = new RegExp(
	`\\bgit\\s+${GIT_GLOBAL_OPTIONS}checkout\\s+(?:(?:(?:-[fm]|--ours|--theirs|--conflict=\\S+)\\s+)*(?:--\\s+)?(?:\\.\\/?|:\\/)|[^\\s;&|()]+\\s+(?:--\\s+)?(?:\\.\\/?|:\\/)|(?:-f|--force)\\s+[^\\s;&|()]+)(?=\\s|$|[;&|)])`,
	"g",
);
const DISCARD_RESTORE_PATTERN = new RegExp(
	`\\bgit\\s+${GIT_GLOBAL_OPTIONS}restore\\s+(?:(?:--source|--worktree)(?:=\\S+)?\\s+|-s(?:\\s+\\S+|[^\\s]+)\\s+|-W\\s+|--\\s+)?(?:\\.\\/?|:\\/)(?=\\s|$|[;&|)])`,
	"g",
);
const DISCARD_RESET_PATTERN = new RegExp(
	`\\bgit\\s+${GIT_GLOBAL_OPTIONS}reset\\s+(?:(?:-[^\\s;&|]+)\\s+)*--hard\\b`,
	"g",
);
const DISCARD_CLEAN_PATTERN = new RegExp(`\\bgit\\s+${GIT_GLOBAL_OPTIONS}clean\\s+([^;&|]*)`, "g");

function isForcedCleanSegment(args: string): boolean {
	const tokens = args.split(/\s+/).filter(Boolean);
	// Everything after -- is a pathspec, not options (git clean -f -- -n is forced).
	const optionEnd = tokens.indexOf("--");
	const optionTokens = optionEnd === -1 ? tokens : tokens.slice(0, optionEnd);
	const forces = optionTokens.filter((arg) =>
		arg.startsWith("--") ? arg.startsWith("--force") : arg.startsWith("-") && arg.includes("f"),
	);
	if (forces.length === 0) return false;
	return !optionTokens.some(
		(arg) => arg === "--dry-run" || (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("n")),
	);
}

/**
 * Find every destructive git discard command in `command`, returning the
 * character index where each `git` token starts (empty when none match).
 */
/**
 * Replace characters inside single- or double-quoted spans with spaces so the
 * discard matcher cannot match quoted data (for example `echo 'git reset --hard'`).
 * Character positions stay identical to the original string, so match indices
 * remain valid. Command substitution (`$(...)`, backticks) is left live because
 * it executes.
 */
function maskQuotedSpans(command: string): string {
	const chars = command.split("");
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (quote === null) {
			// An unquoted # at a word boundary starts a comment; mask to end of line.
			const prev = i > 0 ? chars[i - 1] : undefined;
			if (ch === "#" && (i === 0 || prev === undefined || /[\s;&|(){}]/.test(prev))) {
				for (let j = i; j < chars.length && chars[j] !== "\n"; j++) chars[j] = " ";
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
		} else if (quote === "'") {
			// No expansion happens inside single quotes; mask it all.
			if (ch === "'") quote = null;
			else chars[i] = " ";
		} else if (ch === '"') {
			quote = null;
		} else if (ch === "\\" && i + 1 < chars.length) {
			chars[i] = " ";
			chars[i + 1] = " ";
			i++;
		} else if (ch === "$" && chars[i + 1] === "(") {
			// Command substitution inside double quotes still executes; keep it live.
			let depth = 0;
			let j = i;
			for (; j < chars.length; j++) {
				if (chars[j] === "(") depth++;
				else if (chars[j] === ")") {
					depth--;
					if (depth === 0) break;
				}
			}
			i = j - 1;
		} else if (ch === "`") {
			// Backtick substitution inside double quotes still executes; keep it live.
			let j = i + 1;
			while (j < chars.length && chars[j] !== "`") j++;
			i = j - 1;
		} else {
			chars[i] = " ";
		}
	}
	return chars.join("");
}

export function findDestructiveGitDiscardCommands(command: string): number[] {
	const masked = maskQuotedSpans(command);
	const indices: number[] = [];
	for (const pattern of [DISCARD_CHECKOUT_PATTERN, DISCARD_RESTORE_PATTERN, DISCARD_RESET_PATTERN]) {
		for (const match of masked.matchAll(pattern)) indices.push(match.index);
	}
	for (const match of masked.matchAll(DISCARD_CLEAN_PATTERN)) {
		if (isForcedCleanSegment(match[1])) indices.push(match.index);
	}
	return indices.sort((a, b) => a - b);
}

export function isDestructiveGitDiscardCommand(command: string): boolean {
	return findDestructiveGitDiscardCommands(command).length > 0;
}

/**
 * Where a discard command's probe must run: `cd` chains earlier in the command
 * and `git -C <dir>` on the discard invocation itself both relocate the
 * repository being discarded, so the probe follows them instead of assuming
 * the tool cwd.
 */
export interface DiscardProbeTarget {
	/** Shell prefix relocating the probe, for example `cd sub && `. */
	relocationPrefix?: string;
	/**
	 * git status command for this discard: honors a `git -C` on the discard
	 * invocation and includes ignored files when the discard deletes them
	 * (git clean -x/-X).
	 */
	gitStatusCommand: string;
}

/** The probe cannot safely determine the repository the discard targets. */
export const UNRESOLVABLE_DISCARD_TARGET = "unresolvable";

export function resolveDiscardProbeTarget(
	command: string,
	discardIndex: number,
	userCommandStart = 0,
): DiscardProbeTarget | typeof UNRESOLVABLE_DISCARD_TARGET | null {
	const prefix = command.slice(0, discardIndex);
	const invocation = command.slice(discardIndex);
	// A discard inside the configured command prefix would be replayed by the
	// probe itself; refuse instead of executing it during probing.
	if (userCommandStart > 0 && discardIndex < userCommandStart) return UNRESOLVABLE_DISCARD_TARGET;
	const tokens = invocation.split(/\s+/);

	// git -C <dir> (or repository-relocating global options) on the discard invocation itself.
	let dashCDir: string | undefined;
	let subcommandIndex = -1;
	for (const [index, token] of tokens.entries()) {
		if (index === 0) continue; // "git"
		if (token === "reset" || token === "checkout" || token === "clean" || token === "restore") {
			subcommandIndex = index;
			break;
		}
		if (token === "-C") {
			const dir = tokens[index + 1];
			// A quoted, escaped, or substituted path cannot be replayed as a single
			// token; refuse rather than probe a truncated or unset directory.
			if (!dir || /["'\\$`]/.test(dir)) return UNRESOLVABLE_DISCARD_TARGET;
			// Repeated -C paths are relative to the preceding one, so replay the
			// whole sequence instead of keeping only the last directory.
			dashCDir = dashCDir ? `${dashCDir} -C ${dir}` : dir;
		} else if (token.startsWith("--git-dir") || token.startsWith("--work-tree") || token.startsWith("--prefix")) {
			return UNRESOLVABLE_DISCARD_TARGET;
		} else if (token === "-c") {
			const config = tokens[index + 1];
			// core.worktree/core.bare relocate the repository the discard targets.
			if (config && /^core\.(worktree|bare)(=|$)/.test(config)) return UNRESOLVABLE_DISCARD_TARGET;
		}
		// Other flags do not relocate.
	}

	// git clean -x/-X also deletes ignored files, so its probe must include them.
	let cleanRemovesIgnored = false;
	if (subcommandIndex !== -1 && tokens[subcommandIndex] === "clean") {
		for (const token of tokens.slice(subcommandIndex + 1)) {
			if (token === "--") break; // everything after -- is a pathspec
			if (token.startsWith("--")) continue;
			if (token.startsWith("-") && /[xX]/.test(token.slice(1))) {
				cleanRemovesIgnored = true;
				break;
			}
		}
	}

	// Inline env assignments directly before the git invocation (for example
	// GIT_DIR=.../GIT_WORK_TREE=... git reset --hard) relocate the target
	// repository; replay them in the probe, or refuse when they cannot be.
	let envPrefix = "";
	const lastSegment = prefix.split(/&&|\|\||;|\||\n/).pop() ?? "";
	const leadingTokens = lastSegment.trim().split(/\s+/).filter(Boolean);
	for (const token of leadingTokens) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=[^\s$`;&|()<>"]+$/.test(token)) continue; // replayable assignment
		// Wrappers that cannot change directory or select another repository.
		if (token === "sudo" || token === "env" || token === "command" || token === "builtin" || token.endsWith("/")) {
			continue;
		}
		return UNRESOLVABLE_DISCARD_TARGET;
	}
	const assignments = leadingTokens.filter((token) => token.includes("="));
	if (assignments.length > 0) envPrefix = `${assignments.join(" ")} `;

	// cd relocations earlier in the command. cds inside grouping parentheses or
	// command substitutions do not persist: they only matter when the discard
	// itself runs inside the still-open group, tracked via paren depth. Segments
	// before userCommandStart belong to the configured command prefix, which the
	// probe already replays verbatim, so their cds are not re-applied.
	const persistentCdArgs: string[] = [];
	const groupedCdArgs: string[] = [];
	let sawCd = false;
	let parenDepth = 0;
	let cdPendingSeparator = false;
	if (/\b(cd|pushd)\b/.test(prefix) || prefix.includes("(")) {
		let offset = 0;
		for (const part of prefix.split(/(&&|\|\||;|\||\n)/)) {
			const start = offset;
			offset += part.length;
			if (start < userCommandStart) continue; // command-prefix region: replayed as-is
			const separator = part === "&&" || part === "||" || part === ";" || part === "|" || part === "\n";
			if (separator) {
				if (cdPendingSeparator && (part === ";" || part === "\n")) {
					// The discard's directory depends on the cd succeeding; refuse
					// instead of probing only one of the two outcomes.
					return UNRESOLVABLE_DISCARD_TARGET;
				}
				if (part === "||" || part === "|") {
					if (sawCd) return UNRESOLVABLE_DISCARD_TARGET; // cd success no longer guaranteed
					continue;
				}
				cdPendingSeparator = false;
				continue;
			}
			const trimmed = part.trim();
			const opens = part.match(/\(/g)?.length ?? 0;
			const closes = part.match(/\)/g)?.length ?? 0;
			const insideGroup = parenDepth > 0 || opens > 0;
			parenDepth = Math.max(0, parenDepth + opens - closes);
			if (insideGroup) {
				const groupCd = /^cd\s*(.*)$/.exec(trimmed.replace(/^[(\s]+/, "").replace(/[)\s]+$/, ""));
				if (groupCd) {
					const arg = groupCd[1].trim();
					if (!arg || /[$`;&|()<>#"]/.test(arg)) return UNRESOLVABLE_DISCARD_TARGET;
					sawCd = true;
					cdPendingSeparator = true;
					groupedCdArgs.push(arg);
				} else if (/\b(cd|pushd)\b/.test(trimmed)) {
					return UNRESOLVABLE_DISCARD_TARGET; // group content we cannot replay
				}
				// A closed group's cds do not persist and must not leak into a
				// later still-open group's chain.
				if (parenDepth === 0) groupedCdArgs.length = 0;
				continue;
			}
			if (trimmed === "pushd" || trimmed.startsWith("pushd ")) return UNRESOLVABLE_DISCARD_TARGET;
			const cdMatch = /^cd\s*(.*)$/.exec(trimmed);
			if (!cdMatch) {
				cdPendingSeparator = false;
				continue; // not a cd: cannot change cwd
			}
			const arg = cdMatch[1].trim();
			// An arg we cannot replay safely (substitution, redirection, backgrounding,
			// comments, or quotes split by segmenting) leaves the target repository
			// unknown; refuse rather than probe blindly.
			const balanced = (arg.match(/"/g)?.length ?? 0) % 2 === 0 && (arg.match(/'/g)?.length ?? 0) % 2 === 0;
			if (!balanced || (arg && /[$`;&|()<>#]/.test(arg))) return UNRESOLVABLE_DISCARD_TARGET;
			sawCd = true;
			cdPendingSeparator = true;
			persistentCdArgs.push(arg);
		}
	}
	// When the discard runs inside a still-open group, its directory is the
	// persistent cd chain inherited by the group plus the group's own cds;
	// otherwise only persistent cds apply.
	const cdArgs = parenDepth > 0 ? [...persistentCdArgs, ...groupedCdArgs] : persistentCdArgs;

	if (cdArgs.length === 0 && dashCDir === undefined && !cleanRemovesIgnored && !envPrefix) return null;
	const ignored = cleanRemovesIgnored ? " --ignored=matching" : "";
	const cdPrefix = cdArgs.length > 0 ? `${cdArgs.map((arg) => (arg ? `cd ${arg}` : "cd")).join(" && ")} && ` : "";
	return {
		relocationPrefix: `${cdPrefix}${envPrefix}` || undefined,
		gitStatusCommand: `${dashCDir ? `git -C ${dashCDir} ` : "git "}status --porcelain --untracked-files=all${ignored}`,
	};
}

function isTruthyEnvValue(value: string | undefined): boolean {
	return value !== undefined && value !== "" && value !== "0";
}

/**
 * Probe for at-risk files via `git status --porcelain --untracked-files=all`
 * (plus `--ignored=matching` when the discard deletes ignored files) in the
 * command's cwd. Returns null when dirtiness cannot be determined (not a
 * repo, git missing, probe failure) so the guard fails open instead of
 * blocking on a guess.
 */
async function probeUncommittedChanges(
	ops: BashOperations,
	probeCommand: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal | undefined,
	timeout: number | undefined,
): Promise<string[] | null> {
	let output = "";
	try {
		const result = await ops.exec(probeCommand, cwd, {
			onData: (data) => {
				output += data.toString("utf8");
			},
			signal,
			timeout,
			env,
		});
		if (result.exitCode !== 0) return null;
	} catch (err) {
		if (err instanceof Error && err.message === "aborted") throw err;
		return null;
	}
	return output
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => line.replace(/\r$/, ""));
}

function formatDirtyTreeRefusal(dirtyPaths: string[], includesIgnoredFiles = false): string {
	const listed = dirtyPaths.slice(0, MAX_DIRTY_PATHS_LISTED);
	const elided = dirtyPaths.length - listed.length;
	const noun = includesIgnoredFiles ? "uncommitted or ignored file(s)" : "uncommitted change(s)";
	const lines = [
		`Refusing to run this destructive git command: the working tree has ${dirtyPaths.length} ${noun}.`,
		...listed.map((line) => `  ${line}`),
	];
	if (elided > 0) lines.push(`  ... and ${elided} more`);
	lines.push("");
	lines.push("Commit, stash, or stage your work first.");
	lines.push(
		`To discard these changes intentionally, retry with allowDestructiveGit: true, or set ${BASH_DESTRUCTIVE_GIT_BYPASS_ENV}=1.`,
	);
	return lines.join("\n");
}

function formatRelocationRefusal(): string {
	return [
		"Refusing to run this destructive git command: it changes directory (or repository) first, and the uncommitted changes of the repository it targets cannot be checked safely.",
		"",
		`Run the discard as its own command from the target directory, or retry with allowDestructiveGit: true, or set ${BASH_DESTRUCTIVE_GIT_BYPASS_ENV}=1.`,
	].join("\n");
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("dim", ` (timeout ${timeout}s)`) : "";
	let commandDisplay: string;
	if (command === null) {
		commandDisplay = invalidArgText(theme);
	} else if (command) {
		const preview = previewBashCommand(command);
		const label = preview.language === "bash" ? "" : `${preview.language}: `;
		commandDisplay = preview.text ? `${label}${preview.text}` : command;
	} else {
		commandDisplay = theme.fg("toolOutput", "...");
	}
	return theme.fg("dim", `$ ${commandDisplay}`) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	includeImageDimensions: boolean,
	showExpandHint: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const output = getTextOutput(result as any, showImages, { includeImageDimensions }).trim();

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint = showExpandHint
							? `${theme.fg("dim", `... ${state.cachedSkipped} earlier lines`)} ${expandCollapseHint("app.tools.expand", false)}`
							: theme.fg("dim", `... (${state.cachedSkipped} earlier lines)`);
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("dim", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const definition: ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> = {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Destructive git discard commands (git checkout -- ., git checkout ., git clean -f..., git reset --hard, git restore .) are refused while uncommitted changes exist; retry with allowDestructiveGit: true only when the discard is intentional.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{
				command,
				timeout,
				allowDestructiveGit,
			}: { command: string; timeout?: number; allowDestructiveGit?: boolean },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			// Refuse destructive git discard commands while the tree is dirty;
			// bypass with allowDestructiveGit or the PI_BASH_ALLOW_DESTRUCTIVE_GIT
			// env var. The pattern check is string-only and the probe runs only
			// on a match, so clean runs pay nothing.
			// Match and resolve the pre-hook command so probe construction stays
			// aligned with the command prefix; the probe itself goes through the
			// spawn hook like the guarded command does.
			const discardIndices = findDestructiveGitDiscardCommands(resolvedCommand);
			if (
				discardIndices.length > 0 &&
				allowDestructiveGit !== true &&
				!isTruthyEnvValue(spawnContext.env[BASH_DESTRUCTIVE_GIT_BYPASS_ENV])
			) {
				// Probe the repository each discard actually targets: follow cd
				// chains and git -C, refuse when the target cannot be resolved
				// safely, and run the probe through the same spawn hook as the
				// discard so hook-provided shell setup applies to both.
				const probes: Array<{ context: BashSpawnContext; includesIgnoredFiles: boolean }> = [];
				const seenProbes = new Set<string>();
				const userCommandStart = commandPrefix ? commandPrefix.length + 1 : 0;
				for (const index of discardIndices) {
					const target = resolveDiscardProbeTarget(resolvedCommand, index, userCommandStart);
					if (target === UNRESOLVABLE_DISCARD_TARGET) {
						throw new Error(formatRelocationRefusal());
					}
					const relocationPrefix = target?.relocationPrefix ?? "";
					const gitStatus = target?.gitStatusCommand ?? GIT_STATUS_PORCELAIN_COMMAND;
					const rawProbe = commandPrefix
						? `${commandPrefix}\n${relocationPrefix}${gitStatus}`
						: `${relocationPrefix}${gitStatus}`;
					// Resolve the probe from the original cwd so hook transforms (for
					// example a sandbox cwd remap) apply once, not to the already
					// remapped context of the guarded command.
					const context = resolveSpawnContext(rawProbe, cwd, spawnHook);
					const key = `${context.command}\u0000${context.cwd}`;
					if (seenProbes.has(key)) continue;
					seenProbes.add(key);
					probes.push({
						context,
						includesIgnoredFiles: gitStatus.includes("--ignored=matching"),
					});
				}
				for (const probe of probes) {
					const dirtyPaths = await probeUncommittedChanges(
						ops,
						probe.context.command,
						probe.context.cwd,
						probe.context.env,
						signal,
						timeout,
					);
					if (dirtyPaths && dirtyPaths.length > 0) {
						throw new Error(formatDirtyTreeRefusal(dirtyPaths, probe.includesIgnoredFiles));
					}
				}
			}
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot();
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				// Snapshot only after the spill settled: the advertised path is terminal.
				await output.closeTempFile();
				return output.snapshot();
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					// A degraded spill has no path; never advertise "Full output: undefined".
					const location = snapshot.fullOutputPath ? `. Full output: ${snapshot.fullOutputPath}` : "";
					if (truncation.lastLinePartial) {
						// The partial line is the first SHOWN line; trailing blanks can follow it.
						const lastLineBytes = output.getLastLineBytes();
						const lineSize = lastLineBytes > 0 ? ` (line is ${formatSize(lastLineBytes)})` : "";
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${startLine}${lineSize}${location}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${location}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit)${location}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				context.includeImageDimensions,
				context.showExpandHint !== false,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
	return Object.assign(definition, { replayBuiltInToolName: "bash" as const });
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
