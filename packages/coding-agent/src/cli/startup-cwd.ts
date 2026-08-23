import { isAbsolute } from "node:path";
import { APP_NAME, expandTildePath } from "../config.js";
import { parseArgs } from "./args.js";

export interface StartupCwdIo {
	log: (message: string) => void;
}

function findCwdArg(args: readonly string[]): string | undefined {
	const index = args.indexOf("--cwd");
	return index === -1 ? undefined : args[index + 1];
}

export function ensureStartupCwd(args: readonly string[], io: StartupCwdIo): boolean {
	try {
		process.cwd();
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	const parsed = parseArgs([...args]);
	if (parsed.help || parsed.version) {
		return true;
	}

	const cwdArg = findCwdArg(args);
	const expandedCwd = cwdArg ? expandTildePath(cwdArg) : undefined;
	if (expandedCwd && isAbsolute(expandedCwd)) {
		try {
			process.chdir(expandedCwd);
			return true;
		} catch {
			// Fall through to the deleted-directory guidance.
		}
	}

	io.log("Error: Current working directory no longer exists.");
	io.log(`Change to an existing directory or run ${APP_NAME} --cwd /path/to/project.`);
	return false;
}
