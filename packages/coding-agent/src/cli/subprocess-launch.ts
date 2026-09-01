import { isAbsolute, resolve } from "node:path";
import { isBunBinary } from "../config.js";

export interface CliSubprocessLaunchSpec {
	command: string;
	args: string[];
}

export function createCliSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...source };
}

function quoteCommandArgument(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatCurrentCliCommand(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): string {
	const launcherPath = environment.PRIME_AGENT_LAUNCHER_PATH;
	if (launcherPath) {
		return [launcherPath, ...args].map(quoteCommandArgument).join(" ");
	}
	const launch = createCliSubprocessLaunchSpec(args);
	return [launch.command, ...launch.args].map(quoteCommandArgument).join(" ");
}

export function createCliSubprocessLaunchSpec(
	args: readonly string[],
	executable = process.execPath,
	execArgs: readonly string[] = process.execArgv,
	entrypoint = process.argv[1],
): CliSubprocessLaunchSpec {
	if (isBunBinary) {
		return { command: executable, args: [...args] };
	}
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for subprocess launch");
	}
	const resolvedEntrypoint = isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint);
	return { command: executable, args: [...execArgs, resolvedEntrypoint, ...args] };
}
