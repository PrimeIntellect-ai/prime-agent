import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { createHarness, type Harness } from "../harness.js";

const SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

type ReplacementSupervisorLauncher = {
	supervisorLaunchInProgress: boolean;
	launchReplacementSupervisor(supervisorSocketPath: string): Promise<void>;
};

describe("#1286 Windows replacement supervisor lock", () => {
	let harness: Harness | undefined;
	const previousRegistryDir = process.env[SUPERVISOR_REGISTRY_DIR_ENV];

	afterEach(() => {
		if (previousRegistryDir === undefined) {
			delete process.env[SUPERVISOR_REGISTRY_DIR_ENV];
		} else {
			process.env[SUPERVISOR_REGISTRY_DIR_ENV] = previousRegistryDir;
		}
		vi.restoreAllMocks();
		harness?.cleanup();
		harness = undefined;
	});

	it("coordinates a named-pipe replacement launch through the supervisor registry", async () => {
		harness = await createHarness();
		const registryDir = join(harness.tempDir, "supervisor-owners");
		process.env[SUPERVISOR_REGISTRY_DIR_ENV] = registryDir;
		const supervisorSocketPath = String.raw`\\.\pipe\prime-agent-daemon`;
		const key = createHash("sha256").update(supervisorSocketPath).digest("hex").slice(0, 12);
		const lockDirectory = resolve(registryDir, `.supervisor-launch-${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(
			join(lockDirectory, "pid"),
			`${process.pid}
`,
			{ mode: 0o600 },
		);
		const processKill = vi.spyOn(process, "kill");
		const canConnectToSupervisor = vi.fn(async () => true);
		const log = vi.fn();
		const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
			supervisorLaunchInProgress: false,
			shuttingDown: false,
			canConnectToSupervisor,
			log,
			options: { defaultSessionConfig: { cwd: harness.tempDir } },
		}) as ReplacementSupervisorLauncher;

		await daemon.launchReplacementSupervisor(supervisorSocketPath);

		expect(processKill).toHaveBeenCalledOnce();
		expect(processKill).toHaveBeenCalledWith(process.pid, 0);
		expect(readFileSync(join(lockDirectory, "pid"), "utf8")).toBe(`${process.pid}
`);
		expect(existsSync(lockDirectory)).toBe(true);
		expect(canConnectToSupervisor).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		expect(daemon.supervisorLaunchInProgress).toBe(false);
	});
});
