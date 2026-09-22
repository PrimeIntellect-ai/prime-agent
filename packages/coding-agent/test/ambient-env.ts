/**
 * Ambient environment sanitation for tests.
 *
 * A running Prime Agent session exports its own runtime configuration into every
 * shell it spawns. A developer who runs the test suite from inside such a session
 * therefore inherits variables that silently change product behaviour: version
 * checks short-circuit, and the npm bridge classifies itself as an internal daemon
 * worker instead of a foreground migration. CI runs with a clean environment, so
 * suites that cover those code paths pass in CI and fail locally for no visible
 * reason.
 *
 * Tests that exercise update, version-check, or npm bridge behaviour must own these
 * variables explicitly instead of inheriting whatever the host shell happens to
 * export.
 */

/**
 * Every variable read by the update, version-check, and npm bridge code paths.
 * Keep this in sync with `src/utils/version-check.ts` and `src/cli/npm-native-bridge.ts`.
 */
export const AMBIENT_RUNTIME_ENV_VARS: readonly string[] = [
	// src/utils/version-check.ts
	"PI_OFFLINE",
	"PI_SKIP_VERSION_CHECK",
	"PRIME_AGENT_DOWNLOAD_BASE_URL",
	// src/cli/npm-native-bridge.ts
	"PI_STARTUP_BENCHMARK",
	"PRIME_AGENT_INSTALL_DIR",
	"PRIME_AGENT_INSTALL_METHOD",
	"PRIME_AGENT_INTERACTIVE_SELF_UPDATE",
	"PRIME_AGENT_INTERNAL_DAEMON_CATALOG",
	"PRIME_AGENT_INTERNAL_DAEMON_WORKER",
	"PRIME_AGENT_INTERNAL_OWNED_WORKER",
	"PRIME_AGENT_MIGRATE_RETRY",
];

/**
 * Removes the ambient variables from this process and returns a callback that puts
 * the original values back. Call it from `beforeEach` and invoke the callback from
 * `afterEach` so each test starts from a known environment.
 */
export function clearAmbientRuntimeEnv(): () => void {
	const saved = new Map<string, string | undefined>();
	for (const name of AMBIENT_RUNTIME_ENV_VARS) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

/**
 * Builds a child-process environment from this process with the ambient variables
 * stripped, so spawned children do not inherit them. Overrides are applied last and
 * may deliberately reintroduce any of the variables under test.
 */
export function ambientFreeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of AMBIENT_RUNTIME_ENV_VARS) delete env[name];
	return { ...env, ...overrides };
}
