import { resolve } from "node:path";
import { VERSION } from "../../config.js";
import type { DaemonRuntimeIdentity } from "./daemon-protocol.js";

declare const __PI_BUILD_ID__: string | undefined;

export const PRIME_AGENT_BUILD_ID_ENV = "PRIME_AGENT_BUILD_ID";
export const PRIME_AGENT_LAUNCHER_PATH_ENV = "PRIME_AGENT_LAUNCHER_PATH";

function bundledBuildId(): string | undefined {
	return typeof __PI_BUILD_ID__ === "undefined" ? undefined : __PI_BUILD_ID__;
}

export function getDaemonRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env): DaemonRuntimeIdentity {
	const entrypoint = process.argv[1];
	const launcher = environment[PRIME_AGENT_LAUNCHER_PATH_ENV];
	return {
		// The bundle's embedded id wins over the launcher's environment value. prime-agent.sh
		// derives that value from the worktree's live `git describe`, so preferring it would let a
		// daemon still serving an older bundle report the current checkout: commit without
		// rebuilding, restart, and the mismatch becomes invisible. The embedded id is the only
		// value that describes the code actually loaded. The environment is the fallback for
		// unbundled execution, where __PI_BUILD_ID__ is never substituted.
		buildId: bundledBuildId() ?? environment[PRIME_AGENT_BUILD_ID_ENV] ?? `release-${VERSION}`,
		executablePath: resolve(process.execPath),
		...(entrypoint ? { entrypointPath: resolve(entrypoint) } : {}),
		...(launcher ? { launcherPath: resolve(launcher) } : {}),
	};
}
