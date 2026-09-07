import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import * as childProcesses from "../src/utils/child-process.js";

interface Claim {
	supervisorGeneration: string;
	supervisorPid: number;
	supervisorProcessStartId: string;
	supervisorSocketPath: string;
}
interface Client {
	authenticated: boolean;
	socket: { destroyed: boolean };
}
interface BoundClaim {
	claim: Claim;
	ownerFingerprint: string;
}
interface Launcher {
	launchReplacementSupervisor(socketPath: string): Promise<void>;
	assertSupervisorClaimCurrent(claim: Claim, fingerprint?: string): Promise<string>;
	supervisorClaims: Map<Client, BoundClaim>;
	shuttingDown: boolean;
	log: ReturnType<typeof vi.fn>;
}

const children: ChildProcess[] = [];
let directory: string | undefined;
let launcher: Launcher | undefined;
let launched: Promise<void> | undefined;

function startChild(): ChildProcess {
	const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	return child;
}

function setup() {
	directory = mkdtempSync(join(tmpdir(), "prime-launch-test-"));
	vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", directory);
	const socketPath = join(directory, "supervisor.sock");
	launcher = Object.assign(Object.create(AgentDaemon.prototype), {
		options: { defaultSessionConfig: { cwd: directory } },
		supervisorClaims: new Map<Client, BoundClaim>(),
		shuttingDown: false,
		supervisorLaunchInProgress: false,
		canConnectToSupervisor: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
		log: vi.fn(),
	}) as Launcher;
	vi.spyOn(childProcesses, "spawnHidden").mockImplementation(() => startChild());
	return { daemon: launcher, socketPath };
}

function installClaim(daemon: Launcher, socketPath: string, child: ChildProcess) {
	const pid = child.pid!;
	const processStartId = getProcessStartId(pid)!;
	expect(processStartId).toBeDefined();
	const generation = "authenticated-winner";
	const ownerDir = join(directory!, `${generation}.owner`);
	mkdirSync(ownerDir);
	const owner = {
		version: 1,
		role: "supervisor",
		token: "test-token",
		generation,
		pid,
		processStartId,
		socketPath,
		descriptorDir: directory,
		agentDir: directory,
		appVersion: "test",
		phase: "owner",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(join(ownerDir, "owner.json"), JSON.stringify(owner));
	const claim: Claim = {
		supervisorGeneration: generation,
		supervisorPid: pid,
		supervisorProcessStartId: processStartId,
		supervisorSocketPath: socketPath,
	};
	const client: Client = { authenticated: true, socket: { destroyed: false } };
	const bound = { claim, ownerFingerprint: "do-not-trust-cached-fingerprint" };
	daemon.supervisorClaims.set(client, bound);
	return { client, bound, owner, ownerDir };
}

async function begin(daemon: Launcher, socketPath: string): Promise<ChildProcess> {
	const previous = children.length;
	launched = daemon.launchReplacementSupervisor(socketPath);
	await vi.waitFor(() => expect(children).toHaveLength(previous + 1));
	return children[previous]!;
}

afterEach(async () => {
	if (launcher) launcher.shuttingDown = true;
	await launched;
	vi.restoreAllMocks();
	for (const child of children) {
		const exited = childProcesses.waitForChildProcess(child);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	}
	children.length = 0;
	vi.unstubAllEnvs();
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	launcher = undefined;
	launched = undefined;
});

describe("supervisor replacement launch ownership", () => {
	it.each([false, true])("keeps the current winner alive (own child wins: %s)", async (ownWins) => {
		const { daemon, socketPath } = setup();
		const competitor = ownWins ? undefined : startChild();
		const child = await begin(daemon, socketPath);
		const winner = competitor ?? child;
		const kill = vi.spyOn(child, "kill");
		const winnerKill = competitor ? vi.spyOn(competitor, "kill") : undefined;
		const { bound } = installClaim(daemon, socketPath, winner);
		const verify = vi.spyOn(daemon, "assertSupervisorClaimCurrent");
		await launched;
		expect(verify).toHaveBeenCalledWith(bound.claim);
		expect(winner.exitCode).toBeNull();
		expect(winner.signalCode).toBeNull();
		if (ownWins) expect(kill).not.toHaveBeenCalled();
		else {
			expect(kill).toHaveBeenCalledOnce();
			expect(child.signalCode).toBe("SIGKILL");
			expect(winnerKill).not.toHaveBeenCalled();
		}
	});

	it.each(["stale", "replaced", "disconnected"])("does not kill on a %s claim", async (condition) => {
		const { daemon, socketPath } = setup();
		const competitor = startChild();
		const child = await begin(daemon, socketPath);
		const { client, bound, owner, ownerDir } = installClaim(daemon, socketPath, competitor);
		const verifyCurrent = daemon.assertSupervisorClaimCurrent.bind(daemon);
		let finishValidation = () => {};
		const validationFinished = new Promise<void>((resolve) => {
			finishValidation = resolve;
		});
		const verify = vi.spyOn(daemon, "assertSupervisorClaimCurrent").mockImplementation(async (claim, ...rest) => {
			try {
				const result = await verifyCurrent(claim, ...rest);
				if (condition === "replaced") daemon.supervisorClaims.set(client, { ...bound });
				if (condition === "disconnected") client.socket.destroyed = true;
				return result;
			} finally {
				finishValidation();
			}
		});
		if (condition === "stale")
			writeFileSync(join(ownerDir, "owner.json"), JSON.stringify({ ...owner, processStartId: "stale" }));
		const kill = vi.spyOn(child, "kill");
		await validationFinished;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(verify).toHaveBeenCalledWith(bound.claim);
		expect(kill).not.toHaveBeenCalled();
		expect(child.signalCode).toBeNull();
		daemon.shuttingDown = true;
		await launched;
	});

	it.each(["shutdown", "deadline"])("does not kill without an authenticated claim at %s", async (condition) => {
		const { daemon, socketPath } = setup();
		const child = await begin(daemon, socketPath);
		const kill = vi.spyOn(child, "kill");
		if (condition === "shutdown") daemon.shuttingDown = true;
		else vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_000);
		await launched;
		expect(kill).not.toHaveBeenCalled();
		expect(child.signalCode).toBeNull();
		expect(daemon.log).toHaveBeenCalledWith(expect.stringContaining("without a current authenticated supervisor"));
	});
});
