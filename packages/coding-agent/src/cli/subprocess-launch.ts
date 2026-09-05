import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isBunBinary } from "../config.js";

const PRIME_AGENT_LAUNCHER_PATH_ENV = "PRIME_AGENT_LAUNCHER_PATH";

export interface CliSubprocessLaunchSpec {
	command: string;
	args: string[];
}

export function resolveInstalledBinaryLauncher(executable = process.execPath): string | undefined {
	try {
		const versionDir = realpathSync(dirname(executable));
		const state = readFileSync(join(versionDir, ".install-paths"), "utf8").split(/\r?\n/);
		const versionsDirValue = state[0]?.trim();
		const launcherPath = state[1]?.trim();
		const commandName = state[2]?.trim() || (launcherPath ? basename(launcherPath) : undefined);
		if (!versionsDirValue || !launcherPath || !commandName || !isAbsolute(launcherPath)) return undefined;

		const versionsDir = realpathSync(versionsDirValue);
		if (dirname(versionDir) !== versionsDir || basename(launcherPath) !== commandName) return undefined;
		if (!lstatSync(launcherPath).isSymbolicLink()) return undefined;

		const activeBinary = realpathSync(launcherPath);
		if (dirname(dirname(activeBinary)) !== versionsDir) return undefined;
		accessSync(activeBinary, constants.X_OK);
		return launcherPath;
	} catch {
		return undefined;
	}
}

export function createCliSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const environment = { ...source };
	if (isBunBinary && !environment[PRIME_AGENT_LAUNCHER_PATH_ENV]) {
		const launcherPath = resolveInstalledBinaryLauncher();
		if (launcherPath) environment[PRIME_AGENT_LAUNCHER_PATH_ENV] = launcherPath;
	}
	return environment;
}

function quoteCommandArgument(value: string): string {
	return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatCurrentCliCommand(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): string {
	const launcherPath = environment[PRIME_AGENT_LAUNCHER_PATH_ENV];
	if (launcherPath) {
		return [launcherPath, ...args].map(quoteCommandArgument).join(" ");
	}
	const launch = createCliSubprocessLaunchSpec(args, process.execPath, process.execArgv, process.argv[1], environment);
	return [launch.command, ...launch.args].map(quoteCommandArgument).join(" ");
}

export function createCliSubprocessLaunchSpec(
	args: readonly string[],
	executable = process.execPath,
	execArgs: readonly string[] = process.execArgv,
	entrypoint = process.argv[1],
	environment: NodeJS.ProcessEnv = process.env,
	compiledBinary = isBunBinary,
): CliSubprocessLaunchSpec {
	if (compiledBinary) {
		const command =
			environment[PRIME_AGENT_LAUNCHER_PATH_ENV] || resolveInstalledBinaryLauncher(executable) || executable;
		return { command, args: [...args] };
	}
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for subprocess launch");
	}
	const resolvedEntrypoint = isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint);
	return { command: executable, args: [...execArgs, resolvedEntrypoint, ...args] };
}
