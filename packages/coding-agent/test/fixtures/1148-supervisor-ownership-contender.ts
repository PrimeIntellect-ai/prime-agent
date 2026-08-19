import { acquireDaemonSupervisorOwnership } from "../../src/modes/daemon/daemon-supervisor-ownership.js";

const REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing ${name}`);
	}
	return value;
}

async function run(): Promise<number> {
	try {
		const ownership = await acquireDaemonSupervisorOwnership({
			socketPath: requiredEnvironment("ENG_1148_SOCKET_PATH"),
			descriptorDir: requiredEnvironment("ENG_1148_DESCRIPTOR_DIR"),
			agentDir: requiredEnvironment("ENG_1148_AGENT_DIR"),
			generation: requiredEnvironment("ENG_1148_GENERATION"),
			appVersion: "test",
			registryDir: requiredEnvironment(REGISTRY_DIR_ENV),
		});
		await ownership.release();
		console.error(JSON.stringify({ code: "unexpectedly_acquired" }));
		return 2;
	} catch (error) {
		const typedError = error as { code?: unknown };
		console.error(
			JSON.stringify({
				code: typedError.code,
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return 1;
	}
}

process.exitCode = await run();
