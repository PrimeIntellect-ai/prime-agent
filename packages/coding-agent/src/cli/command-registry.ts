import { APP_NAME } from "../config.js";

export interface CommandSpec {
	path: readonly string[];
	usage: string;
	summary: string;
	description?: string;
	options?: readonly string[];
	examples?: readonly string[];
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
	{
		path: ["help"],
		usage: "help [command]",
		summary: "Show command help",
	},
	{
		path: ["agents"],
		usage: "agents",
		summary: "Search and open sessions",
	},
	{
		path: ["list"],
		usage: "list [--all] [--json]",
		summary: "List agents",
		options: ["-a, --all  Include saved agents", "--json      Print JSON"],
	},
	{
		path: ["attach"],
		usage: "attach <agent>",
		summary: "Attach the interactive UI to an agent",
	},
	{
		path: ["stop"],
		usage: "stop <agent> [--json]",
		summary: "Stop an agent",
	},
	{
		path: ["rename"],
		usage: "rename <agent> <name> [--json]",
		summary: "Rename an agent",
	},
	{
		path: ["send"],
		usage: "send [--from <agent>] <agent> <message>",
		summary: "Send a message to an agent",
		options: [
			"--from <agent>  Identify the sending agent",
			"--steer         Deliver as steering when the agent is busy",
			"--follow-up     Queue the message after the current turn",
			"--json          Print JSON",
		],
	},
	{
		path: ["schedule"],
		usage: "schedule <list|add|cancel>",
		summary: "Manage prompts that run later or on a recurring schedule",
	},
	{
		path: ["schedule", "list"],
		usage: "schedule list [--all] [agent] [--json]",
		summary: "List scheduled prompts",
	},
	{
		path: ["schedule", "add"],
		usage: "schedule add <agent> <schedule> -- <message>",
		summary: "Schedule a prompt",
		description: "The schedule may be a cron expression or a supported one-time schedule.",
		examples: [`schedule add worker "0 9 * * 1-5" -- "Check open work"`],
	},
	{
		path: ["schedule", "cancel"],
		usage: "schedule cancel <job-id>",
		summary: "Cancel a scheduled prompt",
	},
	{
		path: ["status"],
		usage: "status [--json]",
		summary: "Show background service status",
	},
	{
		path: ["doctor"],
		usage: "doctor [--fix] [--json]",
		summary: "Inspect and safely clean up background services",
		options: ["--fix   Remove stale sockets and stop idle orphaned services", "--json  Print JSON"],
	},
	{
		path: ["shutdown"],
		usage: "shutdown [--force] [--json]",
		summary: "Stop every agent and background service",
		description: "Without --force, an interactive confirmation is required. --force also kills unresponsive workers.",
		options: ["--force  Skip confirmation and kill unresponsive processes", "--json   Print JSON"],
	},
	{
		path: ["package"],
		usage: "package <install|remove|list|update>",
		summary: "Manage capability packages",
		description: "Packages can provide extensions, skills, prompts, and themes.",
	},
	{
		path: ["package", "install"],
		usage: "package install <source> [--local]",
		summary: "Install a capability package",
		options: ["--local  Install into the current project instead of the user configuration"],
	},
	{
		path: ["package", "remove"],
		usage: "package remove <source> [--local]",
		summary: "Remove a capability package",
		options: ["--local  Remove from the current project configuration"],
	},
	{
		path: ["package", "list"],
		usage: "package list",
		summary: "List installed capability packages",
	},
	{
		path: ["package", "update"],
		usage: "package update [source]",
		summary: "Update capability packages",
	},
	{
		path: ["update"],
		usage: "update [--force]",
		summary: "Update Prime Agent",
	},
	{
		path: ["model"],
		usage: "model list [search]",
		summary: "Inspect available models",
	},
	{
		path: ["model", "list"],
		usage: "model list [search]",
		summary: "List available models",
	},
	{
		path: ["session"],
		usage: "session export <file> [output]",
		summary: "Manage saved sessions",
	},
	{
		path: ["session", "export"],
		usage: "session export <file> [output]",
		summary: "Export a saved session to HTML",
	},
	{
		path: ["config"],
		usage: "config",
		summary: "Configure package resources",
	},
];

export const PUBLIC_COMMAND_NAMES = new Set(
	COMMAND_SPECS.filter((spec) => spec.path.length === 1).map((spec) => spec.path[0]!),
);

export const REMOVED_COMMAND_NAMES = new Set(["app", "daemon", "install", "manage", "remove", "uninstall"]);

type TopLevelOption = readonly [option: string, summary: string];

const TOP_LEVEL_OPTION_GROUPS: ReadonlyArray<{ heading: string; options: readonly TopLevelOption[] }> = [
	{
		heading: "Run options",
		options: [
			["-p, --print", "Print a response and exit"],
			["--mode <text|json|rpc|acp|daemon>", "Select the output mode (default: text)"],
			["--cwd <dir>", "Use a specific working directory"],
			["--offline", "Disable startup network operations"],
			["--verbose", "Force verbose startup"],
			["--daemon-socket <path>", "Use a specific daemon socket"],
		],
	},
	{
		heading: "Model options",
		options: [
			["--provider <name>", "Select a model provider"],
			["--model <id>", "Select a model"],
			["--api-key <key>", "Use an API key for this run"],
			["--models <patterns>", "Set comma-separated models for cycling"],
			["--thinking <level>", "Set reasoning: off, minimal, low, medium, high, xhigh, max"],
		],
	},
	{
		heading: "Session options",
		options: [
			["-c, --continue", "Continue the previous session"],
			["-r, --resume <path|id>", "Resume a saved session"],
			["--fork <path|id>", "Fork a saved session into a new session"],
			["--session-dir <dir>", "Use a custom session directory"],
			["--no-session", "Do not save the session"],
			["--goal <objective>", "Seed a persistent goal for a new root session"],
			["--goal-token-budget <n>", "Set a positive token budget for --goal"],
		],
	},
	{
		heading: "Tool and resource options",
		options: [
			["-t, --tools <list>", "Allowlist comma-separated tool names"],
			["-nt, --no-tools", "Disable all tools by default"],
			["-nbt, --no-builtin-tools", "Disable built-in tools by default"],
			["-e, --extension <source>", "Load an extension (repeatable)"],
			["-ne, --no-extensions", "Disable extension discovery"],
			["--skill <path>", "Load a skill (repeatable)"],
			["-ns, --no-skills", "Disable skill discovery"],
			["--prompt-template <path>", "Load a prompt template (repeatable)"],
			["-np, --no-prompt-templates", "Disable prompt template discovery"],
			["--theme <path>", "Load a theme (repeatable)"],
			["--no-themes", "Disable theme discovery"],
			["-nc, --no-context-files", "Disable AGENTS.md and CLAUDE.md discovery"],
		],
	},
	{
		heading: "Prompt options",
		options: [
			["--system-prompt <text>", "Replace the default system prompt"],
			["--append-system-prompt <text>", "Append to the system prompt (repeatable)"],
			["--", "Treat all following arguments as messages"],
		],
	},
	{
		heading: "Autonomous options",
		options: [
			["--autonomous", "Continue until gates pass or a limit is reached"],
			["--autonomous-gate <command>", "Run a completion gate (repeatable)"],
			["--autonomous-gate-retries <n>", "Set positive retries per failed gate (default: 3)"],
			["--autonomous-gate-timeout-ms <n>", "Set positive per-gate timeout in ms (default: 300000)"],
			["--autonomous-max-continuations <n>", "Set positive follow-up limit (default: 3)"],
			["--autonomous-max-turns <n>", "Set positive assistant-turn limit (default: 12)"],
			["--autonomous-max-tokens <n>", "Set positive token limit (default: 80000)"],
			["--autonomous-timeout-ms <n>", "Set positive wall-clock limit in ms (default: 1800000)"],
		],
	},
	{
		heading: "Help",
		options: [
			["-v, --version", "Show version and exit"],
			["-h, --help", "Show this help"],
		],
	},
];

export function getCommandSpec(path: readonly string[]): CommandSpec | undefined {
	return COMMAND_SPECS.find(
		(spec) => spec.path.length === path.length && spec.path.every((segment, index) => segment === path[index]),
	);
}

export function getChildCommandSpecs(path: readonly string[]): CommandSpec[] {
	return COMMAND_SPECS.filter(
		(spec) => spec.path.length === path.length + 1 && path.every((segment, index) => segment === spec.path[index]),
	);
}

export function isHelpCommandRequest(path: readonly string[]): boolean {
	if (path.length === 0 || getCommandSpec(path)) {
		return true;
	}
	if (REMOVED_COMMAND_NAMES.has(path[0]!)) {
		return true;
	}
	if (getCommandSpec(path.slice(0, 1))) {
		return true;
	}
	const parent = path.slice(0, -1);
	const candidates = getChildCommandSpecs(parent).map((spec) => spec.path.at(-1)!);
	return findCommandSuggestion(path.at(-1)!, candidates) !== undefined;
}

export function findCommandSuggestion(input: string, candidates: readonly string[]): string | undefined {
	let closest: { candidate: string; distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = editDistance(input, candidate);
		if (!closest || distance < closest.distance) {
			closest = { candidate, distance };
		}
	}
	if (!closest || closest.distance > Math.max(2, Math.floor(input.length / 3))) {
		return undefined;
	}
	return closest.candidate;
}

export function formatTopLevelHelp(): string {
	const commands = COMMAND_SPECS.filter((spec) => spec.path.length === 1);
	const commandWidth = Math.max(...commands.map((spec) => spec.path[0]!.length));
	const options = TOP_LEVEL_OPTION_GROUPS.map((group) => formatOptionGroup(group.heading, group.options)).join("\n\n");
	return `${APP_NAME} - AI coding assistant with an IPython tool

Usage:
  ${APP_NAME} [options] [@files...] [message...]
  ${APP_NAME} <command> [args...]

Options:
${options}

Commands:
${commands.map((spec) => `  ${spec.path[0]!.padEnd(commandWidth)}  ${spec.summary}`).join("\n")}

Run "${APP_NAME} help <command>" for command details.`;
}

function formatOptionGroup(heading: string, options: readonly TopLevelOption[]): string {
	const width = Math.max(...options.map(([option]) => option.length));
	return `${heading}:\n${options.map(([option, summary]) => `  ${option.padEnd(width)}  ${summary}`).join("\n")}`;
}

export function formatCommandHelp(path: readonly string[]): string | undefined {
	const spec = getCommandSpec(path);
	if (!spec) {
		return undefined;
	}
	const children = getChildCommandSpecs(path);
	const sections = [`Usage:\n  ${APP_NAME} ${spec.usage}`, "", `${spec.summary}.`];
	if (spec.description) {
		sections.push("", spec.description);
	}
	if (children.length > 0) {
		const width = Math.max(...children.map((child) => child.path.at(-1)!.length));
		sections.push(
			"",
			"Commands:",
			...children.map((child) => `  ${child.path.at(-1)!.padEnd(width)}  ${child.summary}`),
		);
	}
	if (spec.options && spec.options.length > 0) {
		sections.push("", "Options:", ...spec.options.map((option) => `  ${option}`));
	}
	if (spec.examples && spec.examples.length > 0) {
		sections.push("", "Examples:", ...spec.examples.map((example) => `  ${APP_NAME} ${example}`));
	}
	return sections.join("\n");
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		let diagonal = previous[0]!;
		previous[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const above = previous[rightIndex]!;
			previous[rightIndex] = Math.min(
				previous[rightIndex]! + 1,
				previous[rightIndex - 1]! + 1,
				diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return previous[right.length]!;
}
