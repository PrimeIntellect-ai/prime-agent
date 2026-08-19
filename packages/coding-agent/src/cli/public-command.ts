import chalk from "chalk";
import { APP_NAME, SELF_UPDATE_INTERACTIVE_CHILD_ENV } from "../config.js";
import { AuthStorage } from "../core/auth-storage.js";
import { runMcpManagementCommand } from "../core/mcp/mcp-command.js";
import { SettingsManager } from "../core/settings-manager.js";
import { handlePackageCommand, isSelfUpdateSource } from "../package-manager-cli.js";
import { INTERNAL_RUNTIME_COMMAND_MARKER, parseArgs } from "./args.js";
import {
	findCommandSuggestion,
	formatCommandHelp,
	formatTopLevelHelp,
	getChildCommandSpecs,
	getCommandSpec,
	isHelpCommandRequest,
	PUBLIC_COMMAND_NAMES,
	REMOVED_COMMAND_NAMES,
} from "./command-registry.js";
import { handleDaemonCommand } from "./daemon-command.js";
import { runPs, runReap, runShutdownAll } from "./daemon-ps.js";
import { DAEMON_UPDATE_RESTART_COORDINATOR_FLAG } from "./daemon-update-restart.js";

export interface PublicCommandResult {
	handled: boolean;
	args: string[];
	explicitAgentsView: boolean;
	attachAgent?: string;
}

const HANDLED: PublicCommandResult = { handled: true, args: [], explicitAgentsView: false };

export async function handlePublicCommand(args: string[]): Promise<PublicCommandResult> {
	try {
		return await runPublicCommand(args);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

async function runPublicCommand(args: string[]): Promise<PublicCommandResult> {
	args = normalizeLeadingDaemonSocketOption(args);
	if (args[0] === "help" && isHelpCommandRequest(args.slice(1))) {
		return printRequestedHelp(args.slice(1));
	}

	const command = args[0];
	if (!command) {
		return continueWith(args);
	}

	if (REMOVED_COMMAND_NAMES.has(command)) {
		return rejectRemovedCommand(args);
	}

	if (!PUBLIC_COMMAND_NAMES.has(command)) {
		return continueWith(args);
	}
	if (command === "update" && process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] === "1") {
		await handlePackageCommand(args);
		return HANDLED;
	}
	if (command === "update" && args.includes(DAEMON_UPDATE_RESTART_COORDINATOR_FLAG)) {
		await handlePackageCommand(args);
		return HANDLED;
	}

	const separatorIndex = args.indexOf("--");
	const helpIndex = args.findIndex(
		(arg, index) =>
			index > 0 && (separatorIndex === -1 || index < separatorIndex) && (arg === "--help" || arg === "-h"),
	);
	if (helpIndex !== -1) {
		return printRequestedHelp(getCommandPath(args.slice(0, helpIndex)));
	}

	switch (command) {
		case "agents":
			return { handled: false, args: args.slice(1), explicitAgentsView: true };
		case "list":
			return runInternalAgentCommand("list", args.slice(1));
		case "attach": {
			const rest = args.slice(1);
			const agent = rest[0];
			const options = rest.slice(1);
			if (!agent || agent.startsWith("-") || hasPositionalArguments(options)) {
				return fail(`Usage: ${APP_NAME} ${getCommandSpec(["attach"])!.usage}`);
			}
			if (hasConflictingAttachOption(options)) {
				return fail("attach cannot be combined with --resume, --continue, or --fork.");
			}
			return {
				handled: false,
				args: ["--resume", agent, ...options],
				explicitAgentsView: false,
				attachAgent: agent,
			};
		}
		case "stop":
			if (!requireOperandCount(args.slice(1), 1, 1, "stop")) return HANDLED;
			return runInternalAgentCommand("kill", args.slice(1));
		case "rename":
			if (!requireOperandCount(args.slice(1), 2, undefined, "rename")) return HANDLED;
			return runInternalAgentCommand("rename", args.slice(1));
		case "send":
			return runInternalAgentCommand("send", args.slice(1));
		case "schedule":
			return runNestedAgentCommand("schedule", "cron", args.slice(1));
		case "status":
			return runStatus(args.slice(1));
		case "doctor":
			return runDoctor(args.slice(1));
		case "shutdown":
			return runShutdown(args.slice(1));
		case "package":
			return runPackage(args.slice(1));
		case "mcp":
			return runMcp(args.slice(1));
		case "update": {
			const rest = args.slice(1);
			const hasLegacySelfTarget = rest.some((arg) => arg === "--self" || isSelfUpdateSource(arg));
			const hasLegacyPackageTarget = rest.some(
				(arg) =>
					arg === "--extensions" || arg === "--extension" || (!arg.startsWith("-") && !isSelfUpdateSource(arg)),
			);
			if (hasLegacySelfTarget && hasLegacyPackageTarget) {
				return fail(
					"Prime Agent and package updates are now separate.",
					`Run "${APP_NAME} update [--force]" and "${APP_NAME} package update [source]" separately.`,
				);
			}
			if (hasLegacySelfTarget) {
				return fail("An update target is no longer needed.", `Use "${APP_NAME} update [--force]".`);
			}
			if (hasLegacyPackageTarget) {
				return fail("Package updates moved to the package command.", `Use "${APP_NAME} package update [source]".`);
			}
			const options = parseBooleanOptions(rest, new Set(["--force"]), "update");
			if (!options) return HANDLED;
			await handlePackageCommand(["update", "--self", ...options]);
			return HANDLED;
		}
		case "model":
			return rewriteNestedCommand("model", "list", "--list-models", args.slice(1));
		case "session":
			return rewriteNestedCommand("session", "export", "--export", args.slice(1));
		case "config":
			if (!requireArgumentCount(args.slice(1), 0, "config")) return HANDLED;
			return continueWith(args);
		default:
			return continueWith(args);
	}
}

function normalizeLeadingDaemonSocketOption(args: string[]): string[] {
	const option = args[0];
	if (option !== "--daemon-socket") {
		return args;
	}
	const socketPath = args[1];
	const command = args[2];
	if (socketPath === undefined || (command !== "stop" && command !== "rename")) {
		return args;
	}
	return [command, ...args.slice(3), option, socketPath];
}

function continueWith(args: string[]): PublicCommandResult {
	return { handled: false, args, explicitAgentsView: false };
}

function printRequestedHelp(path: string[]): PublicCommandResult {
	if (path.length === 0) {
		console.log(formatTopLevelHelp());
		return HANDLED;
	}
	if (REMOVED_COMMAND_NAMES.has(path[0]!)) {
		return rejectRemovedCommand(path);
	}
	const help = formatCommandHelp(path);
	if (help) {
		console.log(help);
		return HANDLED;
	}
	const parent = path.slice(0, -1);
	const candidates = getChildCommandSpecs(parent).map((spec) => spec.path.at(-1)!);
	const suggestion = findCommandSuggestion(path.at(-1)!, candidates);
	return fail(
		`Unknown command: ${path.join(" ")}`,
		suggestion ? `Did you mean "${APP_NAME} help ${[...parent, suggestion].join(" ")}"?` : undefined,
	);
}

function getCommandPath(args: string[]): string[] {
	const path: string[] = [];
	for (const arg of args) {
		if (!getCommandSpec([...path, arg])) {
			break;
		}
		path.push(arg);
	}
	return path;
}

function rejectRemovedCommand(args: string[]): PublicCommandResult {
	const [command, subcommand] = args;
	let replacement: string | undefined;
	if (command === "daemon") {
		replacement = 'Run "prime-agent help" to see the agent commands.';
	} else if (command === "app" && subcommand === "update") {
		replacement = 'Use "prime-agent update".';
	} else if (command === "install") {
		replacement = 'Use "prime-agent package install".';
	} else if (command === "remove" || command === "uninstall") {
		replacement = 'Use "prime-agent package remove".';
	} else if (command === "manage") {
		replacement = 'Use "prime-agent agents".';
	}
	return fail(`Unknown command: ${args.slice(0, 2).join(" ")}`, replacement);
}

async function runInternalAgentCommand(command: string, args: string[]): Promise<PublicCommandResult> {
	await handleDaemonCommand(["daemon", command, ...args]);
	return HANDLED;
}

async function runNestedAgentCommand(
	parent: string,
	internalCommand: string,
	args: string[],
): Promise<PublicCommandResult> {
	const subcommand = args[0];
	const children = getChildCommandSpecs([parent]).map((spec) => spec.path.at(-1)!);
	if (!subcommand || !children.includes(subcommand)) {
		const suggestion = subcommand ? findCommandSuggestion(subcommand, children) : undefined;
		return fail(
			subcommand ? `Unknown ${parent} command: ${subcommand}` : `Missing ${parent} command.`,
			suggestion
				? `Did you mean "${APP_NAME} ${parent} ${suggestion}"?`
				: `Run "${APP_NAME} help ${parent}" for usage.`,
		);
	}
	if (parent === "schedule" && !validateScheduleArgs(args)) {
		return HANDLED;
	}
	await handleDaemonCommand(["daemon", internalCommand, ...args]);
	return HANDLED;
}

async function runStatus(args: string[]): Promise<PublicCommandResult> {
	const options = parseBooleanOptions(args, new Set(["--json"]), "status");
	if (!options) return HANDLED;
	await runPs(options.has("--json"));
	return HANDLED;
}

async function runDoctor(args: string[]): Promise<PublicCommandResult> {
	const options = parseBooleanOptions(args, new Set(["--fix", "--json"]), "doctor");
	if (!options) return HANDLED;
	if (options.has("--fix")) {
		await runReap(options.has("--json"), false);
	} else {
		await runPs(options.has("--json"));
	}
	return HANDLED;
}

async function runShutdown(args: string[]): Promise<PublicCommandResult> {
	const options = parseBooleanOptions(args, new Set(["--force", "--json"]), "shutdown");
	if (!options) return HANDLED;
	await runShutdownAll(options.has("--json"), options.has("--force"));
	return HANDLED;
}

async function runMcp(args: string[]): Promise<PublicCommandResult> {
	const settingsManager = SettingsManager.create(process.cwd());
	const result = await runMcpManagementCommand(args, settingsManager, AuthStorage.create());
	console.log(result.message);
	return HANDLED;
}

async function runPackage(args: string[]): Promise<PublicCommandResult> {
	const subcommand = args[0];
	if (subcommand === "uninstall") {
		return fail("Unknown package command: uninstall", `Use "${APP_NAME} package remove".`);
	}
	const children = getChildCommandSpecs(["package"]).map((spec) => spec.path.at(-1)!);
	if (!subcommand || !children.includes(subcommand)) {
		const suggestion = subcommand ? findCommandSuggestion(subcommand, children) : undefined;
		return fail(
			subcommand ? `Unknown package command: ${subcommand}` : "Missing package command.",
			suggestion ? `Did you mean "${APP_NAME} package ${suggestion}"?` : `Run "${APP_NAME} help package" for usage.`,
		);
	}
	const rest = args.slice(1);
	if (subcommand === "list" && rest.length > 0) {
		return fail(`Usage: ${APP_NAME} package list`);
	}
	if (subcommand === "update") {
		if (
			rest.some((arg) => arg === "--self" || arg === "--extensions" || arg === "--extension" || arg === "--force")
		) {
			return fail(
				'Package updates accept only an optional source. Use "prime-agent update --force" to update Prime Agent.',
			);
		}
		if (rest.length > 1) {
			return fail(`Usage: ${APP_NAME} package update [source]`);
		}
		if (rest[0] && isSelfUpdateSource(rest[0])) {
			return fail('Use "prime-agent update" to update Prime Agent.');
		}
		await handlePackageCommand(["update", ...(rest.length === 0 ? ["--extensions"] : rest)]);
		return HANDLED;
	}
	await handlePackageCommand([subcommand, ...rest]);
	return HANDLED;
}

function rewriteNestedCommand(parent: string, subcommand: string, flag: string, args: string[]): PublicCommandResult {
	if (args[0] !== subcommand) {
		const candidate = args[0];
		const suggestion = candidate ? findCommandSuggestion(candidate, [subcommand]) : undefined;
		return fail(
			candidate ? `Unknown ${parent} command: ${candidate}` : `Missing ${parent} command.`,
			suggestion
				? `Did you mean "${APP_NAME} ${parent} ${suggestion}"?`
				: `Run "${APP_NAME} help ${parent}" for usage.`,
		);
	}
	const splitArgs = splitOperandsAndOptions(args.slice(1));
	if (!splitArgs) {
		return fail(`Usage: ${APP_NAME} ${getCommandSpec([parent, subcommand])?.usage ?? `${parent} ${subcommand}`}`);
	}
	const { operands, options } = splitArgs;
	const validCount = parent === "model" ? operands.length <= 1 : operands.length >= 1 && operands.length <= 2;
	if (!validCount) {
		return fail(`Usage: ${APP_NAME} ${getCommandSpec([parent, subcommand])?.usage ?? `${parent} ${subcommand}`}`);
	}
	return continueWith([INTERNAL_RUNTIME_COMMAND_MARKER, flag, ...operands, ...options]);
}

function parseBooleanOptions(args: string[], allowed: ReadonlySet<string>, command: string): Set<string> | undefined {
	const options = new Set<string>();
	for (const arg of args) {
		if (!allowed.has(arg)) {
			fail(`Unknown option for ${command}: ${arg}`, `Run "${APP_NAME} help ${command}" for usage.`);
			return undefined;
		}
		options.add(arg);
	}
	return options;
}

function requireArgumentCount(args: string[], count: number, command: string): boolean {
	if (args.length === count) {
		return true;
	}
	fail(`Usage: ${APP_NAME} ${getCommandSpec([command])?.usage ?? command}`);
	return false;
}

function hasPositionalArguments(args: string[]): boolean {
	const parsed = parseArgs(args);
	return parsed.messages.length > 0 || parsed.fileArgs.length > 0;
}

function hasConflictingAttachOption(args: string[]): boolean {
	return args.some(
		(arg) =>
			arg === "--resume" ||
			arg === "-r" ||
			arg.startsWith("--resume=") ||
			arg === "--continue" ||
			arg === "-c" ||
			arg === "--fork",
	);
}

function splitOperandsAndOptions(args: string[]): { operands: string[]; options: string[] } | undefined {
	const optionsStart = args.findIndex((arg) => arg.startsWith("-"));
	if (optionsStart === -1) {
		return { operands: args, options: [] };
	}
	const options = args.slice(optionsStart);
	if (hasPositionalArguments(options)) {
		return undefined;
	}
	return { operands: args.slice(0, optionsStart), options };
}

function requireOperandCount(args: string[], minimum: number, maximum: number | undefined, command: string): boolean {
	const operands: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--json") {
			continue;
		}
		if (arg === "--socket" || arg === "--daemon-socket") {
			index++;
			continue;
		}
		if (arg.startsWith("-")) {
			fail(`Usage: ${APP_NAME} ${getCommandSpec([command])?.usage ?? command}`);
			return false;
		}
		operands.push(arg);
	}
	if (operands.length >= minimum && (maximum === undefined || operands.length <= maximum)) {
		return true;
	}
	fail(`Usage: ${APP_NAME} ${getCommandSpec([command])?.usage ?? command}`);
	return false;
}

function validateScheduleArgs(args: string[]): boolean {
	const subcommand = args[0];
	if (subcommand === "list") {
		let agentCount = 0;
		for (const arg of args.slice(1)) {
			if (arg === "--all" || arg === "-a" || arg === "--json") {
				continue;
			}
			if (arg.startsWith("-") || ++agentCount > 1) {
				fail(`Usage: ${APP_NAME} schedule list [--all] [agent] [--json]`);
				return false;
			}
		}
		return true;
	}
	if (subcommand === "cancel") {
		const operands = args.slice(1).filter((arg) => arg !== "--json");
		if (operands.length === 1 && !operands[0]!.startsWith("-")) {
			return true;
		}
		fail(`Usage: ${APP_NAME} ${getCommandSpec(["schedule", "cancel"])!.usage}`);
		return false;
	}
	return true;
}

function fail(message: string, hint?: string): PublicCommandResult {
	console.error(chalk.red(`Error: ${message}`));
	if (hint) {
		console.error(chalk.dim(hint));
	}
	process.exitCode = 1;
	return HANDLED;
}
