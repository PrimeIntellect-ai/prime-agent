import { resolve } from "node:path";
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import chalk from "chalk";
import { spawn } from "child_process";
import { expandTildePath } from "../config.js";
import type { AgentSessionEvent } from "../core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../core/agent-session-config.js";
import { type AgentCronJob, formatAgentCronJob } from "../core/cron-jobs.js";
import { looksLikeSessionPath } from "../core/session-resolver.js";
import { DaemonClient, type DaemonClientMessageListener } from "../modes/daemon/daemon-client.js";
import type { DaemonOutbound, DaemonResponse } from "../modes/daemon/daemon-protocol.js";
import { matchesSessionIdSuffix } from "../modes/daemon/daemon-session-id.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { isLocalPath } from "../utils/paths.js";
import { isValidThinkingLevel } from "./args.js";
import { formatSessionListTable } from "./daemon-list-format.js";
import { runPs, runReap } from "./daemon-ps.js";

interface ParsedDaemonClientCommand {
	command: string;
	socketPath: string;
	json: boolean;
	positionals: string[];
}

const DAEMON_CLIENT_COMMANDS = new Set([
	"start",
	"ps",
	"list",
	"create",
	"attach",
	"detach",
	"kill",
	"rename",
	"prompt",
	"send",
	"agent-messages",
	"steer",
	"follow-up",
	"state",
	"messages",
	"stats",
	"commands",
	"cron",
	"retry",
	"restart",
	"shutdown",
]);

export async function handleDaemonCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "daemon") {
		return false;
	}

	try {
		const parsed = parseDaemonClientCommand(args.slice(1));
		await runDaemonClientCommand(parsed);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

function parseDaemonClientCommand(args: string[]): ParsedDaemonClientCommand {
	let socketPath = defaultDaemonSocketPath();
	let json = false;
	const positionals: string[] = [];
	let passthrough = false;
	let command: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (passthrough) {
			positionals.push(arg);
			continue;
		}

		// send/cron parse "--" themselves as an end-of-flags separator
		if (arg === "--" && (command === "cron" || command === "send")) {
			positionals.push(arg);
			passthrough = true;
			continue;
		}

		if (arg === "--") {
			passthrough = true;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			if (!command) {
				command = "help";
			} else {
				positionals.push("help");
			}
			continue;
		}

		if (arg === "--socket" || arg === "--daemon-socket") {
			const value = args[index + 1];
			if (!value) {
				throw new Error(`${arg} requires a value`);
			}
			socketPath = normalizeSocketPath(value);
			index++;
			continue;
		}

		if (arg === "--json") {
			json = true;
			continue;
		}

		if (!command && DAEMON_CLIENT_COMMANDS.has(arg)) {
			command = arg;
			continue;
		}

		positionals.push(arg);
	}

	command = command ?? "open";
	return { command, socketPath, json, positionals };
}

async function runDaemonClientCommand(parsed: ParsedDaemonClientCommand): Promise<void> {
	if (parsed.command === "open") {
		await runOpen(parsed);
		return;
	}

	if (parsed.command === "start") {
		await runStart(parsed);
		return;
	}

	if (parsed.command === "ps") {
		await runPsCommand(parsed);
		return;
	}

	const client = new DaemonClient(parsed.socketPath);
	await client.connect();

	try {
		switch (parsed.command) {
			case "list":
				await runList(client, parsed.positionals, parsed.json);
				return;
			case "create":
				await runCreate(client, parsed.positionals, parsed.json);
				return;
			case "attach":
				if (parsed.json) {
					await runJsonAttach(client, requireActiveSessionId(parsed.positionals));
				} else {
					await runAttach(client, requireActiveSessionId(parsed.positionals));
				}
				return;
			case "detach":
				await printResponseData(
					client,
					parsed.positionals[0] ? { type: "detach", activeSessionId: parsed.positionals[0] } : { type: "detach" },
					parsed.json,
				);
				return;
			case "kill":
				await printResponseData(
					client,
					{ type: "kill", activeSessionId: requireActiveSessionId(parsed.positionals) },
					parsed.json,
				);
				return;
			case "rename":
				await runRename(client, parsed.positionals, parsed.json);
				return;
			case "prompt":
				await runPrompt(client, parsed.positionals);
				return;
			case "send":
				await runSend(client, parsed.positionals, parsed.json);
				return;
			case "agent-messages":
				await runAgentMessages(client, parsed.positionals, parsed.json);
				return;
			case "steer":
				await runMessageCommand(client, "steer", parsed.positionals, parsed.json);
				return;
			case "follow-up":
				await runMessageCommand(client, "follow_up", parsed.positionals, parsed.json);
				return;
			case "state":
				await printResponseData(
					client,
					{ type: "get_state", activeSessionId: requireActiveSessionId(parsed.positionals) },
					true,
				);
				return;
			case "messages":
				await printResponseData(
					client,
					{ type: "get_messages", activeSessionId: requireActiveSessionId(parsed.positionals) },
					true,
				);
				return;
			case "stats":
				await printResponseData(
					client,
					{ type: "get_session_stats", activeSessionId: requireActiveSessionId(parsed.positionals) },
					true,
				);
				return;
			case "commands":
				await printResponseData(
					client,
					{ type: "get_commands", activeSessionId: requireActiveSessionId(parsed.positionals) },
					true,
				);
				return;
			case "cron":
				await runCron(client, parsed.positionals, parsed.json);
				return;
			case "retry":
				if (parsed.positionals.length !== 1) {
					throw new Error("Usage: daemon retry <session>");
				}
				await printResponseData(
					client,
					{ type: "retry_worker", activeSessionId: parsed.positionals[0]! },
					parsed.json,
				);
				return;
			case "restart":
				if (parsed.positionals.length !== 0) {
					throw new Error("Usage: daemon restart");
				}
				await printResponseData(client, { type: "restart" }, parsed.json);
				return;
			case "shutdown":
				await runShutdown(client, parsed.positionals, parsed.json);
				return;
		}
	} finally {
		client.close();
	}
}

async function runShutdown(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	let force = false;
	for (const arg of args) {
		if (arg === "--force" || arg === "-f") {
			force = true;
			continue;
		}
		throw new Error(`Unknown shutdown option: ${arg}`);
	}
	await printResponseData(client, { type: "shutdown", force }, json);
}

async function runOpen(parsed: ParsedDaemonClientCommand): Promise<void> {
	const sessionArgs = parseSessionArgs(parsed.positionals);
	if (!(await canConnectToDaemon(parsed.socketPath, 250))) {
		await runStart({ ...parsed, command: "start", positionals: sessionArgs.daemonArgs });
	}

	const client = new DaemonClient(parsed.socketPath);
	await client.connect();
	try {
		const autoName = sessionArgs.name === undefined;
		const sessions = await getLiveSessions(client, autoName);
		let sessionName = sessionArgs.name ?? nextDefaultSessionName(sessions);
		let response: DaemonResponse;
		while (true) {
			response = await client.request({
				type: "create",
				name: sessionName,
				config: sessionArgs.config,
				sessionPath: sessionArgs.sessionPath,
				continueRecent: sessionArgs.continueRecent,
			});
			if (response.success || !autoName || !response.error.includes(`Agent name "${sessionName}" is unavailable`)) {
				break;
			}
			sessions.push({ sessionName } as SessionSummary);
			sessionName = nextDefaultSessionName(sessions);
		}
		const data = requireSuccess(response);
		if (!isLiveSessionSummary(data)) {
			throw new Error("Daemon returned an invalid create response");
		}
		await runAttach(client, data.activeSessionId);
	} finally {
		client.close();
	}
}

interface ParsedSessionArgs {
	daemonArgs: string[];
	name?: string;
	config?: AgentSessionRuntimeConfig;
	sessionPath?: string;
	continueRecent?: boolean;
}

const SESSION_BOOLEAN_FLAGS = new Set([
	"--continue",
	"-c",
	"--no-session",
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--verbose",
	"--offline",
	"--foreground",
	"--no-detach",
	"--background",
	"-d",
]);

function parseSessionArgs(args: string[]): ParsedSessionArgs {
	const daemonArgs: string[] = [];
	const nameParts: string[] = [];
	const config: AgentSessionRuntimeConfig = {};
	const pathBaseCwd = findSessionCwdArg(args) ?? process.cwd();
	let sessionPath: string | undefined;
	let continueRecent: boolean | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			nameParts.push(...args.slice(index + 1));
			break;
		}

		if (arg === "--name") {
			const value = args[index + 1];
			if (!value) {
				throw new Error("--name requires a value");
			}
			nameParts.push(value);
			index++;
			continue;
		}

		if (arg === "--cwd") {
			config.cwd = resolve(expandTildePath(requireOptionValue(args, index, arg)));
			index++;
			continue;
		}

		if (arg.startsWith("-")) {
			const parsedOption = parseSessionOption(args, index, config, pathBaseCwd);
			if (!parsedOption) {
				nameParts.push(arg);
				continue;
			}
			if (parsedOption.daemonArg) {
				daemonArgs.push(parsedOption.daemonArg);
				if (parsedOption.value !== undefined) {
					daemonArgs.push(parsedOption.value);
				}
			}
			if (parsedOption.sessionPath !== undefined) {
				sessionPath = parsedOption.sessionPath;
			}
			if (parsedOption.continueRecent !== undefined) {
				continueRecent = parsedOption.continueRecent;
			}
			index += parsedOption.consumed;
			continue;
		}

		nameParts.push(arg);
	}

	const name = nameParts.join(" ").trim();
	// Validate: --goal-token-budget without --goal is an error.
	if (config.initialGoal?.tokenBudget !== undefined && !config.initialGoal.objective) {
		throw new Error("--goal-token-budget requires --goal");
	}
	return {
		daemonArgs,
		name: name || undefined,
		config: Object.keys(config).length > 0 ? config : undefined,
		sessionPath,
		continueRecent,
	};
}

interface ParsedSessionOption {
	consumed: number;
	daemonArg?: string;
	value?: string;
	sessionPath?: string;
	continueRecent?: boolean;
}

function parseSessionOption(
	args: string[],
	index: number,
	config: AgentSessionRuntimeConfig,
	pathBaseCwd: string,
): ParsedSessionOption | undefined {
	const arg = args[index];
	if (!arg?.startsWith("-")) {
		return undefined;
	}

	const readValue = (optionName = arg): string => requireOptionValue(args, index, optionName);
	const withValue = (daemonArg = arg, value = readValue()): ParsedSessionOption => ({ consumed: 1, daemonArg, value });
	const withParsedValue = (daemonArg: string, apply: (value: string) => void): ParsedSessionOption => {
		const value = readValue(daemonArg);
		apply(value);
		return withValue(daemonArg, value);
	};
	const withSessionSelector = (value: string, consumed: number): ParsedSessionOption => {
		if (!value) {
			throw new Error(`${arg.split("=")[0]} requires a value`);
		}
		return {
			consumed,
			sessionPath: looksLikeSessionPath(value) ? resolvePathOption(value, config.cwd ?? pathBaseCwd) : value,
		};
	};
	const boolean = (daemonArg = arg): ParsedSessionOption => ({ consumed: 0, daemonArg });

	if (arg.startsWith("--resume=")) {
		return withSessionSelector(arg.slice("--resume=".length), 0);
	}

	switch (arg) {
		case "--continue":
		case "-c":
			return { consumed: 0, continueRecent: true };
		case "--resume":
		case "-r":
			return withSessionSelector(readValue(), 1);
		case "--session-dir":
			return withParsedValue(arg, (value) => {
				config.sessionDir = expandTildePath(value);
			});
		case "--provider":
			return withParsedValue(arg, (value) => {
				config.provider = value;
			});
		case "--model":
			return withParsedValue(arg, (value) => {
				config.model = value;
			});
		case "--api-key":
			return withParsedValue(arg, (value) => {
				config.apiKey = value;
			});
		case "--system-prompt":
			return withParsedValue(arg, (value) => {
				config.systemPrompt = value;
			});
		case "--append-system-prompt":
			return withParsedValue(arg, (value) => {
				config.appendSystemPrompt = [...(config.appendSystemPrompt ?? []), value];
			});
		case "--models": {
			const value = readValue();
			config.models = parseCsvValue(value);
			return withValue(arg, value);
		}
		case "--tools":
		case "-t": {
			const value = readValue();
			config.tools = parseCsvValue(value);
			return withValue(arg, value);
		}
		case "--thinking": {
			const level = readValue();
			if (!isValidThinkingLevel(level)) {
				throw new Error(`Invalid thinking level "${level}"`);
			}
			config.thinking = level;
			return withValue(arg);
		}
		case "--extension":
		case "-e":
			return withParsedValue(arg, (value) => {
				config.extensions = [...(config.extensions ?? []), resolvePathOption(value, config.cwd ?? pathBaseCwd)];
			});
		case "--skill":
			return withParsedValue(arg, (value) => {
				config.skills = [...(config.skills ?? []), resolvePathOption(value, config.cwd ?? pathBaseCwd)];
			});
		case "--prompt-template":
			return withParsedValue(arg, (value) => {
				config.promptTemplates = [
					...(config.promptTemplates ?? []),
					resolvePathOption(value, config.cwd ?? pathBaseCwd),
				];
			});
		case "--theme":
			return withParsedValue(arg, (value) => {
				config.themes = [...(config.themes ?? []), resolvePathOption(value, config.cwd ?? pathBaseCwd)];
			});
		case "--no-tools":
		case "-nt":
			config.noTools = true;
			return boolean(arg);
		case "--no-builtin-tools":
		case "-nbt":
			config.noBuiltinTools = true;
			return boolean(arg);
		case "--no-extensions":
		case "-ne":
			config.noExtensions = true;
			return boolean(arg);
		case "--no-skills":
		case "-ns":
			config.noSkills = true;
			return boolean(arg);
		case "--no-prompt-templates":
		case "-np":
			config.noPromptTemplates = true;
			return boolean(arg);
		case "--no-themes":
			config.noThemes = true;
			return boolean(arg);
		case "--no-context-files":
		case "-nc":
			config.noContextFiles = true;
			return boolean(arg);
		case "--goal": {
			const value = readValue(arg);
			if (!value.trim()) {
				throw new Error("--goal requires a non-empty objective");
			}
			config.initialGoal = { objective: value, tokenBudget: config.initialGoal?.tokenBudget };
			// Session-specific flag: do NOT propagate to daemon startup args.
			// The goal is sent per-create via the config in the daemon request,
			// so a later no-goal create is not contaminated.
			return { consumed: 1 };
		}
		case "--goal-token-budget": {
			const value = readValue(arg);
			const budget = Number(value);
			if (!Number.isInteger(budget) || budget <= 0) {
				throw new Error("--goal-token-budget must be a positive integer");
			}
			config.initialGoal = {
				objective: config.initialGoal?.objective ?? "",
				tokenBudget: budget,
			};
			// Session-specific flag: do NOT propagate to daemon startup args.
			return { consumed: 1 };
		}
		case "--foreground":
		case "--no-detach":
		case "--background":
		case "-d":
		case "--verbose":
		case "--offline":
			return SESSION_BOOLEAN_FLAGS.has(arg) ? boolean(arg) : undefined;
		case "--no-session":
			throw new Error(
				"--no-session is not supported for daemon sessions; daemon-owned sessions are always persisted",
			);
		default:
			if (!arg.startsWith("--")) {
				return undefined;
			}
			return parseExtensionFlagOption(args, index, config);
	}
}

function parseCsvValue(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function findSessionCwdArg(args: string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--") {
			return undefined;
		}
		if (args[index] === "--cwd") {
			return resolve(expandTildePath(requireOptionValue(args, index, "--cwd")));
		}
	}
	return undefined;
}

function parseExtensionFlagOption(
	args: string[],
	index: number,
	config: AgentSessionRuntimeConfig,
): ParsedSessionOption {
	const arg = args[index]!;
	const eqIndex = arg.indexOf("=");
	config.extensionFlagValues = config.extensionFlagValues ?? {};
	if (eqIndex !== -1) {
		config.extensionFlagValues[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
		return { consumed: 0, daemonArg: arg };
	}

	const name = arg.slice(2);
	config.extensionFlagValues[name] = true;
	return { consumed: 0, daemonArg: arg };
}

function requireOptionValue(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

function resolvePathOption(value: string, cwd: string): string {
	const expanded = expandTildePath(value);
	return isLocalPath(expanded) ? resolve(cwd, expanded) : expanded;
}

async function getLiveSessions(client: DaemonClient, all = false): Promise<SessionSummary[]> {
	const response = await client.request({ type: "list", ...(all ? { all: true } : {}) });
	const data = requireSuccess(response);
	const sessions = getSessionSummaries(data);
	if (!sessions) {
		throw new Error("Daemon returned an invalid list response");
	}
	return sessions;
}

function nextDefaultSessionName(sessions: SessionSummary[]): string {
	const existingNames = new Set(
		sessions.map((session) => session.sessionName).filter((name): name is string => !!name),
	);
	const numericNames = [...existingNames]
		.map((name) => Number.parseInt(name, 10))
		.filter((value) => Number.isSafeInteger(value) && value > 0);
	let next = numericNames.length > 0 ? Math.max(...numericNames) + 1 : 1;
	while (Number.isSafeInteger(next)) {
		if (!existingNames.has(String(next))) {
			return String(next);
		}
		next++;
	}

	let fallback = "session";
	while (existingNames.has(fallback)) {
		fallback += "-";
	}
	return fallback;
}

async function runStart(parsed: ParsedDaemonClientCommand): Promise<void> {
	if (await canConnectToDaemon(parsed.socketPath, 250)) {
		console.log(`Daemon already running on ${parsed.socketPath}`);
		return;
	}

	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for daemon launch");
	}

	const sessionArgs = parseSessionArgs(parsed.positionals);
	const daemonArgs = [
		...process.execArgv,
		entrypoint,
		"--mode",
		"daemon",
		"--daemon-socket",
		parsed.socketPath,
		...sessionArgs.daemonArgs.filter((arg) => arg !== "--background" && arg !== "-d"),
	];
	const child = spawn(process.execPath, daemonArgs, {
		cwd: sessionArgs.config?.cwd ?? process.cwd(),
		detached: true,
		env: process.env,
		stdio: "ignore",
	});
	child.unref();

	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await canConnectToDaemon(parsed.socketPath, 250)) {
			console.log(`Daemon started on ${parsed.socketPath} (pid ${child.pid})`);
			return;
		}
		await delay(25);
	}

	throw new Error(`Timed out waiting for daemon to start on ${parsed.socketPath}`);
}

async function runPsCommand(parsed: ParsedDaemonClientCommand): Promise<void> {
	let reap = false;
	let force = false;
	for (const arg of parsed.positionals) {
		if (arg === "--reap" || arg === "reap") {
			reap = true;
		} else if (arg === "--force" || arg === "-f") {
			force = true;
		} else {
			throw new Error(`Unknown ps option: ${arg}`);
		}
	}
	if (reap) {
		await runReap(parsed.json, force);
		return;
	}
	await runPs(parsed.json);
}

async function canConnectToDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

async function runList(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const { all } = parseListArgs(args);
	const response = await client.request({ type: "list", all });
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	const sessions = getSessionSummaries(data);
	if (!sessions) {
		printJson(data);
		return;
	}

	if (sessions.length === 0) {
		console.log(all ? "No agents." : "No active agents.");
		return;
	}

	console.log(formatSessionListTable(sessions));
}

function parseListArgs(args: string[]): { all: boolean } {
	let all = false;
	for (const arg of args) {
		if (arg === "-a" || arg === "--all") {
			all = true;
			continue;
		}
		throw new Error(`Unknown list option: ${arg}`);
	}
	return { all };
}

async function runCreate(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const sessionArgs = parseSessionArgs(args);
	const response = await client.request({
		type: "create",
		name: sessionArgs.name,
		config: sessionArgs.config,
		sessionPath: sessionArgs.sessionPath,
		continueRecent: sessionArgs.continueRecent,
	});
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	if (isLiveSessionSummary(data)) {
		console.log(`Created ${data.activeSessionId}${data.sessionName ? ` (${data.sessionName})` : ""}`);
		return;
	}
	printJson(data);
}

async function runAttach(client: DaemonClient, activeSessionId: string): Promise<void> {
	const terminal = new DaemonAttachTerminal(client, activeSessionId);
	await terminal.run();
}

async function runJsonAttach(client: DaemonClient, activeSessionId: string): Promise<void> {
	const unsubscribeOutput = client.onMessage(printJsonLine);
	const sessionClosed = waitForSessionClose(client, activeSessionId);
	const interrupted = waitUntilInterrupted();
	try {
		await requireSuccessAsync(client.request({ type: "attach", activeSessionId }));
		await Promise.race([sessionClosed.promise, interrupted.promise]);
	} finally {
		unsubscribeOutput();
		sessionClosed.cancel();
		interrupted.cancel();
	}
}

async function runRename(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const activeSessionId = requireActiveSessionId(args);
	const name = args.slice(1).join(" ").trim();
	if (!name) {
		throw new Error("Usage: prime-agent rename <agent> <name>");
	}
	const response = await client.request({ type: "rename", activeSessionId, name });
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	if (isLiveSessionSummary(data)) {
		console.log(`Renamed ${data.activeSessionId} to ${data.sessionName ?? name}`);
		return;
	}
	printJson(data);
}

async function runPrompt(client: DaemonClient, args: string[]): Promise<void> {
	const activeSessionId = requireActiveSessionId(args);
	const message = args.slice(1).join(" ").trim();
	if (!message) {
		throw new Error("Usage: daemon prompt <session> <message>");
	}

	let promptAcknowledged = false;
	const finished = waitForSessionEnd(client, activeSessionId, () => promptAcknowledged);
	const unsubscribeOutput = client.onMessage(printJsonLine);
	try {
		await requireSuccessAsync(client.request({ type: "attach", activeSessionId }));
		await requireSuccessAsync(client.request({ type: "prompt", activeSessionId, message }));
		promptAcknowledged = true;
		await finished.promise;
	} finally {
		unsubscribeOutput();
		finished.cancel();
	}
}

async function runAgentMessages(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const subcommand = args[0];
	switch (subcommand) {
		case "status":
			requireNoExtraArgs(args, "daemon agent-messages status");
			await printResponseData(client, { type: "agent_messages_status" }, json);
			return;
		case "pause":
			requireNoExtraArgs(args, "daemon agent-messages pause");
			await printResponseData(client, { type: "agent_messages_pause" }, json);
			return;
		case "resume":
			requireNoExtraArgs(args, "daemon agent-messages resume");
			await printResponseData(client, { type: "agent_messages_resume" }, json);
			return;
		case "clear": {
			const activeSessionId = args[1];
			if (!activeSessionId || args.length !== 2) {
				throw new Error("Usage: daemon agent-messages clear <session>");
			}
			await printResponseData(client, { type: "agent_messages_clear", activeSessionId }, json);
			return;
		}
		default:
			throw new Error("Usage: daemon agent-messages <status|pause|resume|clear>");
	}
}

function requireNoExtraArgs(args: string[], usage: string): void {
	if (args.length > 1) {
		throw new Error(`Usage: ${usage}`);
	}
}

async function runSend(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const parsed = parseSendArgs(args);
	const response = await client.request({
		type: "send_message",
		targetActiveSessionId: parsed.targetActiveSessionId,
		fromActiveSessionId: parsed.fromActiveSessionId,
		message: parsed.message,
	});
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}
	if (isAgentMessageReceipt(data)) {
		const target = data.target.sessionName ?? data.target.activeSessionId;
		console.log(data.deliveryStatus === "queued" ? `Queued for ${target}` : `Sent to ${target}`);
		return;
	}
	console.log("ok");
}

interface ParsedSendArgs {
	targetActiveSessionId: string;
	fromActiveSessionId?: string;
	message: string;
}

function parseSendArgs(args: string[]): ParsedSendArgs {
	let fromActiveSessionId: string | undefined;
	let targetActiveSessionId: string | undefined;
	let explicitMessage: string | undefined;
	const messageParts: string[] = [];
	let parseOptions = true;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (parseOptions && arg === "--") {
			parseOptions = false;
			continue;
		}
		if (parseOptions && arg === "--from") {
			const value = args[index + 1];
			if (!value) {
				throw new Error("--from requires a session id or name");
			}
			fromActiveSessionId = value;
			index++;
			continue;
		}
		if (parseOptions && arg === "--message") {
			if (!targetActiveSessionId) {
				throw new Error("--message must appear after the target session");
			}
			const value = args[index + 1];
			if (!value) {
				throw new Error("--message requires message text");
			}
			explicitMessage = value;
			index++;
			parseOptions = false;
			continue;
		}
		if (parseOptions && arg.startsWith("--")) {
			throw new Error(`Unknown option for send: ${arg} (use -- before message text starting with --)`);
		}
		if (!targetActiveSessionId) {
			targetActiveSessionId = arg;
			continue;
		}
		messageParts.push(arg);
	}

	if (explicitMessage !== undefined && messageParts.length > 0) {
		throw new Error("Usage: prime-agent send [--from <agent>] <agent> [--message <message>|<message>]");
	}
	const message = (explicitMessage ?? messageParts.join(" ")).trim();
	if (!targetActiveSessionId || !message) {
		throw new Error("Usage: prime-agent send [--from <agent>] <agent> [--message <message>|<message>]");
	}
	return {
		targetActiveSessionId,
		fromActiveSessionId,
		message,
	};
}

async function runMessageCommand(
	client: DaemonClient,
	type: "steer" | "follow_up",
	args: string[],
	json: boolean,
): Promise<void> {
	const activeSessionId = requireActiveSessionId(args);
	const message = args.slice(1).join(" ").trim();
	if (!message) {
		const command = type === "follow_up" ? "follow-up" : type;
		throw new Error(`Usage: daemon ${command} <session> <message>`);
	}
	await printResponseData(client, { type, activeSessionId, message }, json);
}

async function runCron(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const subcommand = args[0] ?? "list";
	if (subcommand === "list") {
		const includeInactive = args.includes("--all") || args.includes("-a");
		const selector = args.find((arg) => !arg.startsWith("-") && arg !== "list");
		const activeSessionId = selector ? await resolveLiveSessionSelector(client, selector) : undefined;
		const response = await client.request({ type: "cron_list", activeSessionId, includeInactive });
		const data = requireSuccess(response);
		if (json) {
			printJson(data);
			return;
		}
		const jobs = getCronJobs(data);
		if (!jobs) {
			printJson(data);
			return;
		}
		if (jobs.length === 0) {
			console.log("No scheduled prompts.");
			return;
		}
		for (const job of jobs) {
			console.log(formatAgentCronJob(job));
		}
		return;
	}

	if (subcommand === "add" || subcommand === "schedule") {
		const separator = args.indexOf("--");
		if (separator < 0) {
			throw new Error("Usage: prime-agent schedule add <agent> <schedule> -- <message>");
		}
		const activeSessionId = args[1];
		if (!activeSessionId) {
			throw new Error("Usage: prime-agent schedule add <agent> <schedule> -- <message>");
		}
		const schedule = args.slice(2, separator).join(" ").trim();
		const message = args
			.slice(separator + 1)
			.join(" ")
			.trim();
		if (!schedule || !message) {
			throw new Error("Usage: prime-agent schedule add <agent> <schedule> -- <message>");
		}
		const response = await client.request({ type: "cron_add", activeSessionId, schedule, prompt: message });
		const data = requireSuccess(response);
		if (json) {
			printJson(data);
			return;
		}
		const job = getCronJob(data);
		console.log(job ? `Scheduled ${job.id} next=${job.nextRunAt ?? "-"}` : "Scheduled prompt.");
		return;
	}

	if (subcommand === "cancel" || subcommand === "delete" || subcommand === "remove") {
		const jobId = args[1];
		if (!jobId) {
			throw new Error("Usage: prime-agent schedule cancel <job-id>");
		}
		const response = await client.request({ type: "cron_cancel", jobId });
		const data = requireSuccess(response);
		if (json) {
			printJson(data);
			return;
		}
		const job = getCronJob(data);
		console.log(job ? `Cancelled ${job.id}` : "Cancelled cron job.");
		return;
	}

	throw new Error(`Unknown schedule command: ${subcommand}`);
}

async function resolveLiveSessionSelector(client: DaemonClient, selector: string): Promise<string> {
	const sessions = (await getLiveSessions(client)).filter(
		(session): session is SessionSummary & { activeSessionId: string } => typeof session.activeSessionId === "string",
	);
	const exact = sessions.filter(
		(session) =>
			session.activeSessionId === selector || session.sessionId === selector || session.sessionName === selector,
	);
	const suffix = sessions.filter(
		(session) =>
			matchesSessionIdSuffix(session.activeSessionId, selector) ||
			matchesSessionIdSuffix(session.sessionId, selector),
	);
	const matches = exact.length > 0 ? exact : suffix;
	if (matches.length === 1) {
		return matches[0]!.activeSessionId;
	}
	if (matches.length > 1) {
		throw new Error(`Ambiguous active session "${selector}"`);
	}
	throw new Error(`Unknown active session: ${selector}`);
}

async function printResponseData(
	client: DaemonClient,
	command: Parameters<DaemonClient["request"]>[0],
	json: boolean,
): Promise<void> {
	const response = await client.request(command);
	const data = requireSuccess(response);
	if (json || data !== undefined) {
		printJson(data ?? response);
		return;
	}
	console.log("ok");
}

function requireActiveSessionId(args: string[]): string {
	const activeSessionId = args[0];
	if (!activeSessionId) {
		throw new Error("Missing agent id or name");
	}
	return activeSessionId;
}

function requireSuccess(response: DaemonResponse): unknown {
	if (!response.success) {
		throw new Error(response.error);
	}
	return "data" in response ? response.data : undefined;
}

async function requireSuccessAsync(responsePromise: Promise<DaemonResponse>): Promise<unknown> {
	return requireSuccess(await responsePromise);
}

interface SessionEndWaiter {
	promise: Promise<void>;
	cancel: () => void;
}

type DaemonWaiterMessagePredicate = (message: DaemonOutbound) => boolean;

function createDaemonMessageWaiter(
	client: DaemonClient,
	shouldResolveOnMessage: DaemonWaiterMessagePredicate,
): SessionEndWaiter {
	let unsubscribeMessages = () => {};
	let unsubscribeClose = () => {};
	let settled = false;
	let resolveWait!: () => void;
	let rejectWait!: (error: Error) => void;

	const cleanup = () => {
		unsubscribeMessages();
		unsubscribeClose();
	};
	const resolveOnce = () => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		resolveWait();
	};
	const rejectOnce = (error: Error) => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		rejectWait(error);
	};

	const promise = new Promise<void>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	unsubscribeMessages = client.onMessage((message) => {
		if (shouldResolveOnMessage(message)) {
			resolveOnce();
		}
	});
	unsubscribeClose = client.onClose((error) => {
		rejectOnce(error);
	});

	return { promise, cancel: resolveOnce };
}

function waitForSessionEnd(
	client: DaemonClient,
	activeSessionId: string,
	isPromptAcknowledged?: () => boolean,
): SessionEndWaiter {
	let observedAgentStart = false;
	return createDaemonMessageWaiter(client, (message) => {
		if (message.type === "session_closed" && message.activeSessionId === activeSessionId) {
			return true;
		}
		if (message.type !== "session_event" || message.activeSessionId !== activeSessionId) {
			return false;
		}
		if (message.event.type === "agent_start") {
			observedAgentStart = true;
			return false;
		}
		// Requiring agent_start guards against replayed agent_end events from the
		// attach snapshot, but an agent that was already running when we attached
		// never emits agent_start to this client. Once our prompt is acknowledged,
		// any later agent_end is live, so accept it to avoid hanging.
		return message.event.type === "agent_end" && (observedAgentStart || (isPromptAcknowledged?.() ?? false));
	});
}

function waitForSessionClose(client: DaemonClient, activeSessionId: string): SessionEndWaiter {
	return createDaemonMessageWaiter(
		client,
		(message) => message.type === "session_closed" && message.activeSessionId === activeSessionId,
	);
}

function waitUntilInterrupted(): SessionEndWaiter {
	let settled = false;
	let resolveWait!: () => void;

	const cleanup = () => {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	};
	const resolveOnce = () => {
		if (settled) {
			return;
		}
		settled = true;
		cleanup();
		resolveWait();
	};
	const onSigint = () => {
		resolveOnce();
	};
	const onSigterm = () => {
		resolveOnce();
	};

	const promise = new Promise<void>((resolve) => {
		resolveWait = resolve;
	});
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	return { promise, cancel: resolveOnce };
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

const printJsonLine: DaemonClientMessageListener = (value) => {
	console.log(JSON.stringify(value));
};

class DaemonAttachTerminal {
	private rl?: Interface;
	private isStreaming = false;
	private readonly prompt = chalk.green("prime-agent> ");

	constructor(
		private readonly client: DaemonClient,
		private readonly activeSessionId: string,
	) {}

	async run(): Promise<void> {
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		this.rl.setPrompt(this.prompt);

		const unsubscribe = this.client.onMessage((message) => this.handleMessage(message));
		this.rl.on("line", (line) => {
			void this.handleInput(line).catch((error) => {
				this.writeLine(chalk.red(error instanceof Error ? error.message : String(error)));
			});
		});
		this.rl.on("SIGINT", () => {
			this.rl?.close();
		});

		const closePromise = new Promise<void>((resolve) => {
			this.rl?.once("close", resolve);
		});

		try {
			await requireSuccessAsync(this.client.request({ type: "attach", activeSessionId: this.activeSessionId }));
			await closePromise;
		} finally {
			unsubscribe();
			this.rl?.removeAllListeners();
			this.rl = undefined;
			await this.client.request({ type: "detach", activeSessionId: this.activeSessionId }).catch(() => undefined);
			process.stdin.pause();
			process.stdout.write(`${chalk.dim("Detached.")}\n`);
		}
	}

	private async handleInput(line: string): Promise<void> {
		const input = line.trim();
		if (!input) {
			this.rl?.prompt();
			return;
		}

		if (input === "/quit" || input === "/exit" || input === "/detach") {
			this.rl?.close();
			return;
		}

		if (input === "/help") {
			this.printHelp();
			this.rl?.prompt();
			return;
		}

		if (input === "/abort") {
			requireSuccess(await this.client.request({ type: "abort", activeSessionId: this.activeSessionId }));
			this.writeLine(chalk.dim("Abort requested."));
			return;
		}

		if (input === "/state") {
			const response = await this.client.request({ type: "get_state", activeSessionId: this.activeSessionId });
			this.writeLine(JSON.stringify(requireSuccess(response), null, 2));
			return;
		}

		if (input === "/messages") {
			const response = await this.client.request({ type: "get_messages", activeSessionId: this.activeSessionId });
			const data = requireSuccess(response);
			if (isMessagesData(data)) {
				this.writeLine(chalk.bold("Transcript"));
				this.printTranscript(data.messages);
			} else {
				this.writeLine(JSON.stringify(data, null, 2));
			}
			return;
		}

		if (this.isStreaming) {
			requireSuccess(
				await this.client.request({ type: "follow_up", activeSessionId: this.activeSessionId, message: input }),
			);
			this.writeLine(chalk.dim("Queued follow-up."));
			return;
		}

		requireSuccess(
			await this.client.request({ type: "prompt", activeSessionId: this.activeSessionId, message: input }),
		);
	}

	private handleMessage(message: DaemonOutbound): void {
		switch (message.type) {
			case "daemon_hello":
				return;
			case "session_attached":
				this.isStreaming = message.state.isStreaming;
				this.writeLine(chalk.bold(`Attached to ${message.state.sessionName ?? message.activeSessionId}`));
				if (message.state.model) {
					this.writeLine(chalk.dim(`Model: ${message.state.model.provider}/${message.state.model.id}`));
				}
				if (message.state.sessionFile) {
					this.writeLine(chalk.dim(`Session: ${message.state.sessionFile}`));
				}
				this.printHelp();
				if (message.messages.length > 0) {
					this.writeLine(chalk.bold("Transcript"));
					this.printTranscript(message.messages);
				}
				this.rl?.prompt();
				return;
			case "session_event":
				if (message.event.type !== "refine_complete") {
					this.handleSessionEvent(message.event);
				}
				return;
			case "session_replaced":
				this.isStreaming = message.state.isStreaming;
				this.writeLine(chalk.dim(`Session replaced: ${message.state.sessionName ?? message.activeSessionId}`));
				if (message.messages.length > 0) {
					this.writeLine(chalk.bold("Transcript"));
					this.printTranscript(message.messages);
				}
				this.rl?.prompt();
				return;
			case "session_resynced":
				this.isStreaming = message.snapshot.state.isStreaming;
				this.writeLine(
					chalk.dim(`Session resynchronized: ${message.snapshot.state.sessionName ?? message.activeSessionId}`),
				);
				if (message.snapshot.messages.length > 0) {
					this.writeLine(chalk.bold("Transcript"));
					this.printTranscript(message.snapshot.messages);
				}
				this.rl?.prompt();
				return;
			case "session_detached":
				return;
			case "session_closed":
				this.writeLine(chalk.yellow(`Session closed: ${message.reason}`));
				this.rl?.close();
				return;
			case "extension_ui_request":
				this.writeLine(chalk.dim(`Extension UI request: ${message.method}`));
				return;
			case "extension_error":
				this.writeLine(chalk.red(`Extension error (${message.extensionPath}, ${message.event}): ${message.error}`));
				return;
			case "response":
				if (!message.success) {
					this.writeLine(chalk.red(message.error));
				}
				return;
		}
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.isStreaming = true;
				this.writeLine(chalk.dim("Agent started."));
				return;
			case "agent_end":
				this.isStreaming = false;
				this.writeLine(chalk.dim("Agent idle."));
				return;
			case "message_end":
				this.printMessage(event.message);
				return;
			case "message_update":
				if (event.assistantMessageEvent.type === "toolcall_end") {
					this.writeLine(chalk.dim(`Tool call: ${event.assistantMessageEvent.toolCall.name}`));
				}
				return;
			case "tool_execution_start":
				this.writeLine(chalk.dim(`Tool started: ${event.toolName}`));
				return;
			case "tool_execution_end":
				this.writeLine(chalk.dim(`Tool ${event.isError ? "failed" : "finished"}: ${event.toolName}`));
				return;
			case "session_action_update":
				if (event.actions.queuedCount > 0) {
					this.writeLine(
						chalk.dim(
							`Queued: ${event.actions.steering.length} steering, ${event.actions.followUps.length} follow-up`,
						),
					);
				}
				return;
			case "session_info_changed":
				this.writeLine(chalk.dim(`Session name: ${event.name ?? "(unnamed)"}`));
				return;
			case "thinking_level_changed":
				this.writeLine(chalk.dim(`Thinking: ${event.level}`));
				return;
			case "compaction_start":
				this.writeLine(chalk.dim(`Compaction started: ${event.reason}`));
				return;
			case "compaction_end":
				this.writeLine(chalk.dim(`Compaction ${event.aborted ? "aborted" : "finished"}: ${event.reason}`));
				return;
			case "auto_retry_start":
				this.writeLine(chalk.dim(`Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`));
				return;
			case "auto_retry_end":
				this.writeLine(chalk.dim(event.success ? "Retry succeeded." : `Retry failed: ${event.finalError ?? ""}`));
				return;
			case "rlm_child_update":
				this.writeLine(chalk.dim(`Subagent ${event.child.label}: ${event.child.status}`));
				return;
			case "goal_update":
				this.writeLine(chalk.dim(`Goal: ${event.goal.status}`));
				return;
			case "refine_failed":
				this.writeLine(chalk.red(`Refinement failed: ${event.error}`));
				return;
			case "refine_complete":
				return;
			case "turn_start":
			case "turn_end":
			case "message_start":
			case "tool_execution_update":
			case "auth_stale":
				return;
		}
	}

	private printTranscript(messages: AgentMessage[]): void {
		for (const message of messages) {
			this.printMessage(message);
		}
	}

	private printMessage(message: AgentMessage): void {
		const role = getMessageRole(message);
		const body = getMessageText(message).trim();
		const label = formatRole(role);
		this.writeLine(body ? `${label}\n${indent(body)}` : `${label} ${chalk.dim("[no text content]")}`);
	}

	private printHelp(): void {
		this.writeLine(chalk.dim("Type a message and press Enter. Commands: /help /state /messages /abort /detach"));
	}

	private writeLine(text: string): void {
		if (this.rl && process.stdout.isTTY) {
			clearLine(process.stdout, 0);
			cursorTo(process.stdout, 0);
		}
		process.stdout.write(`${text}\n`);
		this.rl?.prompt(true);
	}
}

function isMessagesData(value: unknown): value is { messages: AgentMessage[] } {
	if (!value || typeof value !== "object") {
		return false;
	}
	return Array.isArray((value as { messages?: unknown }).messages);
}

function getMessageRole(message: AgentMessage): string {
	if (!message || typeof message !== "object" || !("role" in message) || typeof message.role !== "string") {
		return "message";
	}
	return message.role;
}

function getMessageText(message: AgentMessage): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return JSON.stringify(message);
	}
	return formatContent((message as { content: unknown }).content);
}

function formatContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(formatContentBlock)
			.filter((text) => text.length > 0)
			.join("\n");
	}
	if (content === undefined || content === null) {
		return "";
	}
	return JSON.stringify(content);
}

function formatContentBlock(block: unknown): string {
	if (!block || typeof block !== "object" || !("type" in block) || typeof block.type !== "string") {
		return JSON.stringify(block);
	}

	switch (block.type) {
		case "text":
			return getStringProperty(block, "text");
		case "thinking": {
			const thinking = getStringProperty(block, "thinking");
			return thinking ? `[thinking]\n${thinking}` : "[thinking]";
		}
		case "image": {
			const mimeType = getStringProperty(block, "mimeType");
			return mimeType ? `[image: ${mimeType}]` : "[image]";
		}
		case "toolCall": {
			const name = getStringProperty(block, "name");
			const args = getUnknownProperty(block, "arguments");
			const argsText = args === undefined ? "" : ` ${JSON.stringify(args)}`;
			return `[tool call: ${name || "unknown"}${argsText}]`;
		}
		default:
			return JSON.stringify(block);
	}
}

function getStringProperty(value: object, key: string): string {
	const record = value as Record<string, unknown>;
	const property = record[key];
	return typeof property === "string" ? property : "";
}

function getUnknownProperty(value: object, key: string): unknown {
	return (value as Record<string, unknown>)[key];
}

function formatRole(role: string): string {
	switch (role) {
		case "user":
			return chalk.blue.bold("user:");
		case "assistant":
			return chalk.green.bold("assistant:");
		case "toolResult":
			return chalk.magenta.bold("tool:");
		default:
			return chalk.bold(`${role}:`);
	}
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function getSessionSummaries(value: unknown): SessionSummary[] | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const sessions = (value as { sessions?: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		return undefined;
	}

	const entries: SessionSummary[] = [];
	for (const session of sessions) {
		if (isSessionSummary(session)) {
			entries.push(session);
			continue;
		}
		return undefined;
	}
	return entries;
}

function isSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<SessionSummary>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.lifecycle === "string" &&
		typeof candidate.activity === "string" &&
		typeof candidate.isSessionActive === "boolean" &&
		typeof candidate.isStreaming === "boolean" &&
		typeof candidate.isCompacting === "boolean" &&
		typeof candidate.attachedClients === "number" &&
		typeof candidate.messageCount === "number" &&
		(candidate.unfinishedActionCount === undefined || typeof candidate.unfinishedActionCount === "number") &&
		typeof candidate.sessionActions === "object" &&
		candidate.sessionActions !== null &&
		typeof candidate.sessionActions.queuedCount === "number" &&
		Array.isArray(candidate.sessionActions.steering) &&
		Array.isArray(candidate.sessionActions.followUps)
	);
}

function isLiveSessionSummary(value: unknown): value is SessionSummary & { activeSessionId: string } {
	return isSessionSummary(value) && typeof value.activeSessionId === "string";
}

function getCronJobs(value: unknown): AgentCronJob[] | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const jobs = (value as { jobs?: unknown }).jobs;
	return Array.isArray(jobs) ? (jobs as AgentCronJob[]) : undefined;
}

function getCronJob(value: unknown): { id: string; nextRunAt?: string } | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const job = (value as { job?: unknown }).job;
	if (!job || typeof job !== "object" || typeof (job as { id?: unknown }).id !== "string") {
		return undefined;
	}
	const candidate = job as { id: string; nextRunAt?: unknown };
	return { id: candidate.id, ...(typeof candidate.nextRunAt === "string" ? { nextRunAt: candidate.nextRunAt } : {}) };
}

function isAgentMessageReceipt(
	value: unknown,
): value is { target: { activeSessionId: string; sessionName?: string }; deliveryStatus?: string } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const target = (value as { target?: unknown }).target;
	return (
		!!target &&
		typeof target === "object" &&
		typeof (target as { activeSessionId?: unknown }).activeSessionId === "string"
	);
}
