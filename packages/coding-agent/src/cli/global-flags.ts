/**
 * Shared scanning of leading global flags for the CLI entry paths.
 *
 * Both the early daemon-launch decision and public command routing must agree
 * on which token is the subcommand. When they disagreed, a management command
 * written as `prime-agent --offline model list` was routed to the model as a
 * chat message. Keep this module dependency-free apart from the command
 * registry: daemon-launch.ts loads it before the heavy module graph.
 */

import { PUBLIC_COMMAND_NAMES, REMOVED_COMMAND_NAMES } from "./command-registry.js";

/** Global flags that consume the next argument as their value. */
export const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"--mode",
	"--daemon-socket",
	"--provider",
	"--model",
	"--api-key",
	"--cwd",
	"--system-prompt",
	"--append-system-prompt",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--autonomous-gate",
	"--autonomous-gate-retries",
	"--autonomous-gate-timeout-ms",
	"--autonomous-max-continuations",
	"--autonomous-max-turns",
	"--autonomous-max-tokens",
	"--autonomous-timeout-ms",
	"--goal",
	"--goal-token-budget",
]);

/** Flags that mark the run as a one-shot prompt, so its positional is a message. */
const PROMPT_RUN_FLAGS: ReadonlySet<string> = new Set(["--print", "-p"]);

export interface FirstPositionalArgument {
	index: number;
	value: string;
	/** True when the token only became positional because of a `--` terminator. */
	afterSeparator: boolean;
}

/** Find the first positional argument, skipping global flags and their values. */
export function findFirstPositionalArgument(args: readonly string[]): FirstPositionalArgument | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") {
			const value = args[index + 1];
			return value === undefined ? undefined : { index: index + 1, value, afterSeparator: true };
		}
		if (GLOBAL_VALUE_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (arg === "--resume" || arg === "-r") {
			if (args[index + 1] && !args[index + 1]!.startsWith("-")) {
				index++;
			}
			continue;
		}
		if (!arg.startsWith("-")) {
			return { index, value: arg, afterSeparator: false };
		}
	}
	return undefined;
}

/** True when the first positional names a command instead of starting a message. */
export function isCommandPositional(positional: FirstPositionalArgument | undefined): boolean {
	if (!positional || positional.afterSeparator) {
		return false;
	}
	return PUBLIC_COMMAND_NAMES.has(positional.value) || REMOVED_COMMAND_NAMES.has(positional.value);
}

/**
 * Move leading global flags behind the subcommand they were written in front of,
 * so `prime-agent --offline model list` runs the command instead of chatting.
 * Arguments are returned unchanged when no known command is present, when `--`
 * already escaped the token, and for one-shot prompt runs, whose positional is
 * the message. Moved flags stay ahead of any `--` separator: arguments behind
 * it are operand text (a child command or a scheduled message), so a flag
 * landing there would be forwarded to the child verbatim.
 */
export function rotateGlobalFlagsBeforeCommand(args: readonly string[]): string[] {
	const positional = findFirstPositionalArgument(args);
	if (!positional || positional.index === 0 || !isCommandPositional(positional)) {
		return [...args];
	}
	if (args.slice(0, positional.index).some((arg) => PROMPT_RUN_FLAGS.has(arg))) {
		return [...args];
	}
	const moved = args.slice(0, positional.index);
	const rest = args.slice(positional.index + 1);
	const separatorIndex = rest.indexOf("--");
	if (separatorIndex === -1) {
		return [positional.value, ...rest, ...moved];
	}
	return [positional.value, ...rest.slice(0, separatorIndex), ...moved, ...rest.slice(separatorIndex)];
}

/**
 * The command path a `help` request names, with global run flags (and their
 * values) excluded: they are run options, not help arguments, so
 * `prime-agent --offline help status` asks about `status`. Returns undefined
 * when the tail contains `--` (everything behind it stays literal message
 * text) or an explicit --help/-h flag with no topic yet (the generic
 * per-command help path handles those).
 */
export function extractHelpCommandPath(args: readonly string[], from: number): string[] | undefined {
	const path: string[] = [];
	for (let index = from; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") {
			return undefined;
		}
		if (arg === "--help" || arg === "-h") {
			// An explicit help flag after a topic still asks about that topic;
			// with no topic it defers to the generic per-command help block so
			// `help --help` keeps asking about help itself.
			return path.length > 0 ? path : undefined;
		}
		if (GLOBAL_VALUE_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}
		path.push(arg);
	}
	return path;
}
