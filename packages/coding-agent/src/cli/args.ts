/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { APP_NAME } from "../config.js";

export type Mode = "text" | "json" | "rpc" | "acp" | "daemon";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	cwd?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: true | string;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	daemonSocket?: string;
	noSession?: boolean;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	autonomous?: boolean;
	autonomousGates?: string[];
	autonomousGateRetries?: number;
	autonomousGateTimeoutMs?: number;
	autonomousMaxContinuations?: number;
	autonomousMaxTurns?: number;
	autonomousMaxTokens?: number;
	autonomousTimeoutMs?: number;
	goal?: string;
	goalTokenBudget?: number;
	listModels?: string | true;
	offline?: boolean;
	verbose?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REMOVED_BUILTIN_TOOL_NAMES = new Set(["read", "write", "grep", "find", "ls"]);
const BUILTIN_TOOL_NAMES = ["ipython"];

export const INTERNAL_RUNTIME_COMMAND_MARKER = "\0prime-agent-runtime-command";

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	let endOfOptions = false;
	const internalRuntimeCommand = args[0] === INTERNAL_RUNTIME_COMMAND_MARKER;
	const firstArgIndex = internalRuntimeCommand ? 1 : 0;

	for (let i = firstArgIndex; i < args.length; i++) {
		const arg = args[i];

		// POSIX end-of-options: everything after a standalone "--" is a positional
		// message, even if it starts with a dash (e.g. a Markdown-bullet prompt).
		if (endOfOptions) {
			result.messages.push(arg);
			continue;
		}
		if (arg === "--") {
			endOfOptions = true;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc" || mode === "acp" || mode === "daemon") {
				result.mode = mode;
			}
		} else if (arg === "--daemon-socket" && i + 1 < args.length) {
			result.daemonSocket = args[++i];
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				if (next === "") {
					result.resume = true;
					i++;
				} else {
					result.resume = next;
					i++;
				}
			} else {
				result.resume = true;
			}
		} else if (arg.startsWith("--resume=")) {
			const value = arg.slice("--resume=".length);
			if (!value) {
				result.resume = true;
			} else {
				result.resume = value;
			}
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--cwd" && i + 1 < args.length) {
			result.cwd = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
			const removedTools = result.tools.filter((name) => REMOVED_BUILTIN_TOOL_NAMES.has(name));
			if (removedTools.length > 0) {
				result.diagnostics.push({
					type: "error",
					message: `Unknown built-in tool(s): ${removedTools.join(", ")}. Available built-in tools: ${BUILTIN_TOOL_NAMES.join(", ")}`,
				});
			}
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export") {
			if (!internalRuntimeCommand) {
				result.diagnostics.push({
					type: "error",
					message: `--export was removed. Use "${APP_NAME} session export <file> [output]".`,
				});
				if (i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
			} else if (i + 1 < args.length) {
				result.export = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--export requires a value" });
			}
		} else if (arg.startsWith("--export=")) {
			result.diagnostics.push({
				type: "error",
				message: `--export was removed. Use "${APP_NAME} session export <file> [output]".`,
			});
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--autonomous") {
			result.autonomous = true;
		} else if (arg === "--autonomous-gate") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousGates = result.autonomousGates ?? [];
				result.autonomousGates.push(args[++i]);
			}
		} else if (arg === "--autonomous-gate-retries") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousGateRetries = parsePositiveInt(args[++i], "--autonomous-gate-retries", result);
			}
		} else if (arg === "--autonomous-gate-timeout-ms") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousGateTimeoutMs = parsePositiveInt(args[++i], "--autonomous-gate-timeout-ms", result);
			}
		} else if (arg === "--autonomous-max-continuations") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousMaxContinuations = parsePositiveInt(args[++i], "--autonomous-max-continuations", result);
			}
		} else if (arg === "--autonomous-max-turns") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousMaxTurns = parsePositiveInt(args[++i], "--autonomous-max-turns", result);
			}
		} else if (arg === "--autonomous-max-tokens") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousMaxTokens = parsePositiveInt(args[++i], "--autonomous-max-tokens", result);
			}
		} else if (arg === "--autonomous-timeout-ms") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousTimeoutMs = parsePositiveInt(args[++i], "--autonomous-timeout-ms", result);
			}
		} else if (arg === "--goal") {
			if (hasRequiredOptionValue(args, i, arg, result)) {
				const value = args[++i];
				if (!value.trim()) {
					result.diagnostics.push({ type: "error", message: "--goal requires a non-empty objective" });
				} else {
					result.goal = value;
				}
			}
		} else if (arg === "--goal-token-budget") {
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.goalTokenBudget = parsePositiveInt(args[++i], "--goal-token-budget", result);
			}
		} else if (arg === "--list-models") {
			const hasSearch = i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@");
			if (!internalRuntimeCommand) {
				result.diagnostics.push({
					type: "error",
					message: `--list-models was removed. Use "${APP_NAME} model list [search]".`,
				});
				if (hasSearch) i++;
			} else if (hasSearch) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg.startsWith("--list-models=")) {
			result.diagnostics.push({
				type: "error",
				message: `--list-models was removed. Use "${APP_NAME} model list [search]".`,
			});
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	if (result.goalTokenBudget !== undefined && !result.goal) {
		result.diagnostics.push({
			type: "error",
			message: "--goal-token-budget requires --goal",
		});
	}

	return result;
}

function hasRequiredOptionValue(args: string[], index: number, flag: string, result: Args): boolean {
	const next = args[index + 1];
	if (next === undefined || next.startsWith("--")) {
		result.diagnostics.push({ type: "error", message: `${flag} requires a value` });
		return false;
	}
	return true;
}

function parsePositiveInt(value: string, flag: string, result: Args): number | undefined {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		result.diagnostics.push({ type: "error", message: `${flag} must be a positive integer` });
		return undefined;
	}
	return parsed;
}
