const NODE_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS = ["NODE_OPTIONS", "NODE_PATH"] as const;
const PYTHON_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS = [
	"COVERAGE_PROCESS_START",
	"PYTHONBREAKPOINT",
	"PYTHONHOME",
	"PYTHONPATH",
] as const;

export const AVO_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS = [
	...NODE_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS,
	...PYTHON_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS,
] as const;

const AVO_SECRET_VERIFICATION_ENVIRONMENT_KEY =
	/(?:^|_)(?:ACCESS_?KEY|API_?KEY|AUTH(?:ORIZATION)?|COOKIE|CREDENTIALS?|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|TOKEN)(?:$|_)/i;

export function unboundAvoVerificationEnvironmentKeys(
	environment: NodeJS.ProcessEnv,
	runnerFamily: "pytest" | "node_test" | "other",
): string[] {
	const keys =
		runnerFamily === "node_test"
			? NODE_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS
			: runnerFamily === "pytest"
				? PYTHON_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS
				: AVO_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS;
	return keys.filter((key) => Boolean(environment[key]?.trim()));
}

export function sanitizeAvoVerificationEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const sanitized = { ...environment };
	for (const key of AVO_UNBOUND_VERIFICATION_ENVIRONMENT_KEYS) delete sanitized[key];
	for (const key of Object.keys(sanitized)) {
		if (AVO_SECRET_VERIFICATION_ENVIRONMENT_KEY.test(key)) delete sanitized[key];
	}
	return sanitized;
}
