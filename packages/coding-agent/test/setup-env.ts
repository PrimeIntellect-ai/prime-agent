/**
 * Hermetic test-environment guard.
 *
 * The suite must behave identically whether it is launched from a clean CI
 * shell or from inside a live Prime Agent daemon worker (for example, an
 * agent asked to run the tests by its own kernel). A worker environment
 * carries live-session state that leaks into both in-process `main()` calls
 * and spawned CLI children:
 *
 * - NO_COLOR + FORCE_COLOR both set -> every spawned node binary prints a
 *   deprecation warning on stderr, breaking strict empty-stderr assertions.
 * - RLM_MAX_DEPTH / RLM_DEPTH -> AgentSession reports max-depth source
 *   "env" instead of "default".
 * - RLM_SESSION_DIR / RLM_HARNESS_STATE_DIR / RLM_GLOBAL_HARNESS_STATE_DIR
 *   and PRIME_AGENT_INTERNAL_* (supervisor socket, worker identity,
 *   recovery journals) -> self-update flows probe the developer's real
 *   daemon through resolveUpdateDaemonSocketPath() and refuse on live busy
 *   sessions, even when the test redirects TMPDIR/agent dir.
 *
 * Scrub these before any test module imports run. Tests that need any of
 * them set their own values after this file has run.
 */

const COLOR_CONFLICT_VARS = ["NO_COLOR"] as const;
const RUNNER_SESSION_VARS = [
	"RLM_MAX_DEPTH",
	"RLM_DEPTH",
	"RLM_SESSION_DIR",
	"RLM_HARNESS_STATE_DIR",
	"RLM_GLOBAL_HARNESS_STATE_DIR",
] as const;
const RUNNER_SESSION_PREFIXES = ["PRIME_AGENT_INTERNAL_", "PI_INTERNAL_"] as const;

for (const name of COLOR_CONFLICT_VARS) {
	if (process.env.FORCE_COLOR !== undefined && process.env[name] !== undefined) {
		delete process.env[name];
	}
}
for (const name of RUNNER_SESSION_VARS) {
	delete process.env[name];
}
for (const name of Object.keys(process.env)) {
	if (RUNNER_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix))) {
		delete process.env[name];
	}
}
