import { APP_NAME } from "../config.js";
import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export const SESSION_SLASH_COMMAND_NAMES = ["compact", "refine", "goal", "autonomous"] as const;

export type SessionSlashCommandName = (typeof SESSION_SLASH_COMMAND_NAMES)[number];

const SESSION_SLASH_COMMAND_NAME_SET: ReadonlySet<string> = new Set(SESSION_SLASH_COMMAND_NAMES);

export function isSessionSlashCommandName(value: unknown): value is SessionSlashCommandName {
	return typeof value === "string" && SESSION_SLASH_COMMAND_NAME_SET.has(value);
}

export interface SessionSlashCommand {
	name: SessionSlashCommandName;
	args: string;
	text: string;
}

export interface RefineCommandOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
}

export function parseRefineCommandOptions(args: string): RefineCommandOptions {
	let rest = args.trim();
	let global = false;
	if (/^--global(?=\s|$)/.test(rest)) {
		global = true;
		rest = rest.replace(/^--global(?=\s|$)/, "").trim();
	}
	if (rest === "rollback") throw new Error("Usage: /refine rollback <refinement-id>");
	// Slash-command args keep their original separators (tabs, Unicode spaces);
	// match the subcommand with the same class parseSlashCommand splits on.
	const rollbackMatch = /^rollback[\t\p{Zs}]/u.exec(rest);
	if (rollbackMatch) {
		let rollbackId = rest.slice(rollbackMatch[0].length).trim();
		if (rollbackId === "--global") {
			throw new Error("Usage: /refine rollback <refinement-id>");
		}
		if (/\s--global$/.test(rollbackId)) {
			global = true;
			rollbackId = rollbackId.replace(/\s--global$/, "").trim();
		}
		if (!rollbackId) throw new Error("Usage: /refine rollback <refinement-id>");
		return { rollbackId, global };
	}
	return { instructions: rest || undefined, global };
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	execution?: "client" | "session";
	/** Shown in autocomplete before the description, e.g. "[instructions]" */
	argumentHint?: string;
	/** Hidden names that resolve to this command without being shown as commands. */
	aliases?: readonly string[];
	takesArgument?: boolean;
}

export interface ParsedSlashCommand {
	name: string;
	args: string;
}

export interface ResolvedSlashCommand extends ParsedSlashCommand {
	originalName: string;
	isAlias: boolean;
}

interface BuiltinSlashCommandAlias {
	name: string;
	aliasFor: string;
}

const CANONICAL_BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{
		name: "model",
		description: "Select model and save it as the default",
		argumentHint: "[search]",
		takesArgument: true,
	},
	{
		name: "switch",
		description: "Switch model for this session without changing the default",
		argumentHint: "[search]",
		takesArgument: true,
	},
	{ name: "effort", description: "Select reasoning/thinking level (opens selector UI)", argumentHint: "[level]" },
	{ name: "fast", description: "Toggle OpenAI Fast mode" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{
		name: "export",
		description: "Export session (HTML default, or specify path: .html/.jsonl)",
		argumentHint: "[path]",
		takesArgument: true,
	},
	{
		name: "import",
		description: "Import and resume a session from a JSONL file",
		argumentHint: "<path.jsonl>",
		takesArgument: true,
	},
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{
		name: "btw",
		description: "Ask a side question without adding it to the session; replies follow up, esc returns",
		argumentHint: "<question>",
		takesArgument: true,
	},
	{
		name: "name",
		description: "Set or show the session display name",
		argumentHint: "[name]",
		takesArgument: true,
	},
	{ name: "session", description: "Show session info" },
	{ name: "system-prompt", description: "Show the exact system prompt sent to the model" },
	{ name: "logs", description: "Show where daemon and client logs are saved" },
	{
		name: "traces",
		description: "Preview, upload, or configure Prime Agent traces",
		argumentHint: "[status|on|off|preview|upload|upload-current|upload-all|login]",
	},
	{ name: "context", description: "Show token, cost, and context usage for agent and sub-agents" },
	{ name: "changelog", description: "Show changelog entries" },
	{
		name: "update",
		description: `Update ${APP_NAME} and installed packages`,
		argumentHint: "[source|--self|--extensions]",
		takesArgument: true,
	},
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{
		name: "mcp",
		description: "Open MCP Connections or manage MCP integrations",
		argumentHint: "[list|login <name>|logout <name>]",
		takesArgument: true,
	},
	{
		name: "new",
		description: "Start a new session, optionally named and/or with an initial prompt",
		argumentHint: '[--name "session name" --] [prompt]',
		takesArgument: true,
	},
	{
		name: "compact",
		description: "Compact the session context; optional instructions focus the summary",
		argumentHint: "[instructions]",
	},
	{
		name: "refine",
		description: "Refine continual harness prompt notes, skills, subagents, and memory",
	},
	{
		name: "goal",
		description: "Set or view a persistent goal; supports pause, resume, and clear",
		argumentHint: "[objective]",
		takesArgument: true,
	},
	{
		name: "autonomous",
		description: "Set or view autonomous mode",
		argumentHint: "[status|on|off]",
		takesArgument: true,
	},
	{
		name: "rlm-max-depth",
		description:
			"Set/view the per-chat persistent RLM max depth immediately; never interrupts or queues the running turn",
		argumentHint: "[<int> [--global]]",
		takesArgument: true,
	},
	{
		name: "heartbeat",
		description:
			"Set or view a persistent heartbeat; delivery defaults to steer, use --follow-up to queue; supports pause, resume, stop, and clear",
		argumentHint: "[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]",
		takesArgument: true,
	},
	{ name: "heartbeats", description: "View and manage all user and agent heartbeats" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{
		name: "fullscreen",
		description: "Toggle fullscreen (alternate screen) rendering with scrollable transcript",
		argumentHint: "[on|off]",
		takesArgument: true,
	},
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

const BUILTIN_SLASH_COMMAND_ALIASES: ReadonlyArray<BuiltinSlashCommandAlias> = [
	{ name: "clear", aliasFor: "new" },
	{ name: "usage", aliasFor: "context" },
	{ name: "thinking", aliasFor: "effort" },
	{ name: "rename", aliasFor: "name" },
	{ name: "side", aliasFor: "btw" },
];

function buildBuiltinSlashCommands(): ReadonlyArray<BuiltinSlashCommand> {
	const canonicalByName = new Map(CANONICAL_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
	const aliasesByTarget = new Map<string, string[]>();
	for (const alias of BUILTIN_SLASH_COMMAND_ALIASES) {
		const target = canonicalByName.get(alias.aliasFor);
		if (!target) {
			throw new Error(`Slash command alias '/${alias.name}' targets unknown command '/${alias.aliasFor}'`);
		}
		const targetAliases = aliasesByTarget.get(alias.aliasFor);
		if (targetAliases) {
			targetAliases.push(alias.name);
		} else {
			aliasesByTarget.set(alias.aliasFor, [alias.name]);
		}
	}
	return CANONICAL_BUILTIN_SLASH_COMMANDS.map((command) => ({
		...command,
		...(isSessionSlashCommandName(command.name) ? { execution: "session" as const } : {}),
		...(aliasesByTarget.has(command.name) ? { aliases: aliasesByTarget.get(command.name) } : {}),
	}));
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = buildBuiltinSlashCommands();

const BUILTIN_SLASH_COMMAND_BY_NAME = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
const BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME = new Map(
	BUILTIN_SLASH_COMMANDS.flatMap((command) => command.aliases?.map((alias) => [alias, command.name] as const) ?? []),
);

export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
	if (!text.startsWith("/")) return undefined;
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	return { name: match[1], args: (match[2] ?? "").trim() };
}

export function resolveBuiltinSlashCommandName(name: string): string {
	return BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME.get(name) ?? name;
}

export function isBuiltinSlashCommandName(name: string): boolean {
	return BUILTIN_SLASH_COMMAND_BY_NAME.has(name) || BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME.has(name);
}

export function builtinSlashCommandTakesArgument(name: string): boolean {
	// /clear remains the no-argument compatibility alias even though /new accepts arguments.
	if (name === "clear") return false;
	return BUILTIN_SLASH_COMMAND_BY_NAME.get(resolveBuiltinSlashCommandName(name))?.takesArgument === true;
}

export function resolveSlashCommand(command: ParsedSlashCommand): ResolvedSlashCommand {
	const name = resolveBuiltinSlashCommandName(command.name);
	return {
		...command,
		name,
		originalName: command.name,
		isAlias: name !== command.name,
	};
}

export function parseSessionSlashCommand(text: string): SessionSlashCommand | undefined {
	if (/[\r\n\u2028\u2029]/u.test(text)) return undefined;
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const name = resolveBuiltinSlashCommandName(parsed.name);
	const command = BUILTIN_SLASH_COMMAND_BY_NAME.get(name);
	if (command?.execution !== "session" || !isSessionSlashCommandName(name)) return undefined;
	return { name, args: parsed.args, text };
}
