import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type DaemonInfo,
	detectDaemonOwnershipLost,
	evaluateShutdownQuietPeriod,
	isWorkerSocketPath,
	mergeDiscoveredDaemonProcesses,
	type ProbeResult,
	parseLsofListeners,
	parsePrimeAgentProcessIds,
	parsePsEtimes,
	parseSsListeners,
	planReap,
	planShutdownAll,
	planShutdownConfirmation,
	type RepairHooks,
	repairOwnershipLostDaemon,
	sortDaemons,
	verifyHelloSupervisorPid,
} from "../src/cli/daemon-ps.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { defaultDaemonSocketDir } from "../src/modes/daemon/daemon-socket.js";
import { supervisorStateDirMatches } from "../src/modes/daemon/daemon-supervisor.js";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";

describe("worker socket classification", () => {
	it.runIf(process.platform !== "win32")("recognizes only worker sockets in the default service directory", () => {
		expect(isWorkerSocketPath(join(defaultDaemonSocketDir(), "worker-abc.sock"))).toBe(true);
		expect(isWorkerSocketPath(join(defaultDaemonSocketDir(), "daemon.sock"))).toBe(false);
		expect(isWorkerSocketPath("/tmp/worker-abc.sock")).toBe(false);
	});
});

describe("parseSsListeners", () => {
	const stdout = [
		"Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
		'u_str LISTEN 0      511    /tmp/custom.sock 10147608 * 0 users:(("prime-agent",pid=1234,fd=22))',
		'u_str LISTEN 0      511    /tmp/prime-agent-1000/daemon.sock 79453846 * 0 users:(("prime-agent",pid=5678,fd=24))',
		'u_str LISTEN 0      4096   /run/dbus/system_bus_socket 123 * 0 users:(("dbus-daemon",pid=900,fd=3))',
		'u_str ESTAB  0      0      /tmp/other.sock 456 * 0 users:(("prime-agent",pid=4321,fd=9))',
		"",
	].join("\n");

	it("extracts socket + pid for prime-agent LISTEN sockets only", () => {
		const daemons = parseSsListeners(stdout, "prime-agent");
		expect(daemons).toEqual([
			{ pid: 1234, socketPath: "/tmp/custom.sock" },
			{ pid: 5678, socketPath: "/tmp/prime-agent-1000/daemon.sock" },
		]);
	});

	it("ignores sockets owned by other processes and non-LISTEN states", () => {
		const daemons = parseSsListeners(stdout, "prime-agent");
		expect(daemons.some((daemon) => daemon.socketPath.includes("dbus"))).toBe(false);
		expect(daemons.some((daemon) => daemon.pid === 4321)).toBe(false);
	});

	it("honors a different app name", () => {
		expect(parseSsListeners(stdout, "pi")).toEqual([]);
	});
});

describe("parseLsofListeners", () => {
	it("pairs each pid with its listening unix socket paths", () => {
		const stdout = ["p1234", "fu", "n/tmp/a.sock", "p5678", "n/tmp/b.sock", "n0x0 (not a path)", ""].join("\n");
		expect(parseLsofListeners(stdout)).toEqual([
			{ pid: 1234, socketPath: "/tmp/a.sock" },
			{ pid: 5678, socketPath: "/tmp/b.sock" },
		]);
	});
});

describe("parsePrimeAgentProcessIds", () => {
	it("finds process.title names even when lsof reports the executable as node", () => {
		const stdout = [
			"  123 node prime-agent --mode daemon",
			"  456 prime-agent prime-agent",
			"  789 /usr/local/bin/prime-agent prime-agent",
			"  900 node unrelated.js",
			"",
		].join("\n");
		expect(parsePrimeAgentProcessIds(stdout, "prime-agent")).toEqual([123, 456, 789]);
	});
});

describe("mergeDiscoveredDaemonProcesses", () => {
	it("keeps process-title discoveries when lsof by name returned only a partial set", () => {
		expect(
			mergeDiscoveredDaemonProcesses(
				[
					{ pid: 123, socketPath: "/tmp/by-name.sock" },
					{ pid: 456, socketPath: "/tmp/shared.sock" },
				],
				[
					{ pid: 456, socketPath: "/tmp/shared.sock" },
					{ pid: 789, socketPath: "/tmp/by-pid.sock" },
				],
			),
		).toEqual([
			{ pid: 123, socketPath: "/tmp/by-name.sock" },
			{ pid: 456, socketPath: "/tmp/shared.sock" },
			{ pid: 789, socketPath: "/tmp/by-pid.sock" },
		]);
	});
});

describe("evaluateShutdownQuietPeriod", () => {
	it("requires a full quiet period independently of the convergence window", () => {
		expect(evaluateShutdownQuietPeriod(10_500, 10_000)).toBe("waiting");
		expect(evaluateShutdownQuietPeriod(11_000, 10_000)).toBe("complete");
	});
});

describe("verifyHelloSupervisorPid", () => {
	it("accepts the hello pid only while its process identity still matches", () => {
		const processStartId = getProcessStartId(process.pid);
		expect(verifyHelloSupervisorPid(process.pid, processStartId)).toBe(process.pid);
		if (processStartId) {
			expect(verifyHelloSupervisorPid(process.pid, `${processStartId}-stale`)).toBeUndefined();
		}
	});
});

describe("parsePsEtimes", () => {
	it("maps pid to elapsed seconds", () => {
		const uptimes = parsePsEtimes("  1234  86400\n  5678      42\n");
		expect(uptimes.get(1234)).toBe(86400);
		expect(uptimes.get(5678)).toBe(42);
		expect(uptimes.size).toBe(2);
	});
});

describe("sortDaemons", () => {
	it("orders default first, then by status, then socket", () => {
		const daemons: DaemonInfo[] = [
			makeDaemon({ socketPath: "/tmp/z.sock", status: "orphan-file" }),
			makeDaemon({ socketPath: "/tmp/a.sock", status: "stale" }),
			makeDaemon({ socketPath: "/tmp/default.sock", status: "current", isDefault: true }),
			makeDaemon({ socketPath: "/tmp/b.sock", status: "current" }),
			makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" }),
		];
		expect(sortDaemons(daemons).map((daemon) => daemon.socketPath)).toEqual([
			"/tmp/default.sock",
			"/tmp/b.sock",
			"/tmp/a.sock",
			"/tmp/c.sock",
			"/tmp/z.sock",
		]);
	});
});

describe("planReap", () => {
	it("never touches the default daemon or daemons with live sessions", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "stale", isDefault: true, sessionCount: 0, pid: 1 }),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["skip", "skip"]);
	});

	it("removes orphan files and stops reachable idle non-default daemons", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/idle.sock", status: "current", sessionCount: 0, pid: 5 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			false,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "remove-file"]);
	});

	it("removes a stale default socket file but never stops a live default daemon", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "orphan-file", isDefault: true }),
				makeDaemon({ socketPath: "/tmp/live-default.sock", status: "current", isDefault: true, sessionCount: 0 }),
			],
			true,
		);
		expect(plan[0]!.kind).toBe("remove-file");
		expect(plan[1]!.kind).toBe("skip");
	});

	it("only kills unreachable daemons with --force", () => {
		const daemon = makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 });
		const skipped = planReap([daemon], false)[0]!;
		expect(skipped.kind).toBe("skip");
		expect(skipped.kind === "skip" ? skipped.reason : "").toContain("prime-agent shutdown --force");
		expect(planReap([daemon], true)[0]!.kind).toBe("kill");
	});

	it("refuses to kill a pid that backs more than one discovered daemon", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/listening.sock", status: "current", sessionCount: 4, pid: 99 }),
				makeDaemon({ socketPath: "/tmp/phantom.sock", status: "unreachable", pid: 99 }),
			],
			true,
		);
		const phantom = plan.find((action) => action.daemon.socketPath === "/tmp/phantom.sock");
		expect(phantom?.kind).toBe("skip");
		expect(phantom && phantom.kind === "skip" ? phantom.reason : "").toContain("also backs another daemon");
	});
});

describe("planShutdownAll", () => {
	it("targets every service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({
					socketPath: "/tmp/default.sock",
					status: "current",
					isDefault: true,
					sessionCount: 0,
					pid: 1,
				}),
				makeDaemon({ socketPath: "/tmp/busy.sock", status: "current", sessionCount: 3, pid: 2 }),
				makeDaemon({ socketPath: "/tmp/hung.sock", status: "unreachable", pid: 7 }),
				makeDaemon({ socketPath: "/tmp/orphan.sock", status: "orphan-file" }),
			],
			true,
		);
		expect(plan.map((action) => action.kind)).toEqual(["shutdown", "shutdown", "kill", "remove-file"]);
	});

	it("never skips a service when forced", () => {
		const plan = planShutdownAll(
			[
				makeDaemon({ socketPath: "/tmp/a.sock", status: "stale", pid: 9 }),
				makeDaemon({ socketPath: "/tmp/b.sock", status: "unreachable", pid: 10 }),
			],
			true,
		);
		expect(plan.some((action) => action.kind === "skip")).toBe(false);
	});

	it("removes the socket file for an unreachable daemon with no pid", () => {
		const plan = planShutdownAll([makeDaemon({ socketPath: "/tmp/c.sock", status: "unreachable" })], false);
		expect(plan[0]!.kind).toBe("remove-file");
	});

	it("requires force for unreachable tracked workers", () => {
		const daemon = makeDaemon({
			socketPath: "/tmp/worker-only.sock",
			status: "unreachable",
			hasTrackedWorkers: true,
		});
		expect(planShutdownAll([daemon], false)[0]!.kind).toBe("skip");
		expect(planShutdownAll([daemon], true)[0]!.kind).toBe("remove-file");
	});
});

describe("planShutdownConfirmation", () => {
	it("never prompts when JSON output was requested", () => {
		expect(planShutdownConfirmation(1, true, false, true)).toBe("json-error");
	});

	it("prompts only for non-JSON shutdown at a TTY", () => {
		expect(planShutdownConfirmation(1, false, false, true)).toBe("prompt");
		expect(planShutdownConfirmation(1, false, false, false)).toBe("tty-error");
		expect(planShutdownConfirmation(1, true, true, true)).toBe("none");
		expect(planShutdownConfirmation(0, false, false, true)).toBe("none");
	});
});

describe("planReap ownership-lost", () => {
	it("restarts an ownership-lost daemon even when it is the default", () => {
		const plan = planReap(
			[
				makeDaemon({ socketPath: "/tmp/default.sock", status: "ownership-lost", isDefault: true, pid: 11 }),
				makeDaemon({ socketPath: "/tmp/other.sock", status: "ownership-lost", pid: 12 }),
			],
			false,
		);
		expect(plan.map((action) => action.kind)).toEqual(["restart", "restart"]);
	});
});

const cleanupDirs: string[] = [];

afterEach(() => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

async function acquireTestOwnership(generation: string): Promise<{
	registryDir: string;
	socketPath: string;
	probe: ProbeResult;
	ownerJsonPath: string;
	ownerDir: string;
}> {
	const root = mkdtempSync(join(tmpdir(), "doctor-ownership-"));
	cleanupDirs.push(root);
	const registryDir = join(root, "registry");
	const socketPath = join(root, "daemon.sock");
	const ownership = await acquireDaemonSupervisorOwnership({
		agentDir: join(root, "agent"),
		appVersion: "test",
		descriptorDir: join(root, "workers"),
		generation,
		registryDir,
		socketPath,
	});
	const record = ownership.record;
	const probe: ProbeResult = {
		reachable: true,
		supervisorGeneration: record.generation,
		supervisorPid: record.pid,
		...(record.processStartId ? { supervisorProcessStartId: record.processStartId } : {}),
	};
	const ownerDir = join(registryDir, `${generation}.owner`);
	return { registryDir, socketPath, probe, ownerJsonPath: join(ownerDir, "owner.json"), ownerDir };
}

describe("detectDaemonOwnershipLost", () => {
	it("flags a stale-version supervisor whose owner record was deleted", async () => {
		// The incident case: the CLI was upgraded because the daemon wedged, so the
		// wedged supervisor answers with a pre-upgrade version. Version mismatch
		// must not mask ownership loss.
		const paths = await acquireTestOwnership("stale-lost-owner");
		rmSync(paths.ownerDir, { recursive: true, force: true });
		const probe: ProbeResult = { ...paths.probe, version: "0.0.1-old" };
		await expect(detectDaemonOwnershipLost(paths.socketPath, probe, paths.registryDir)).resolves.toBe(true);
	});

	it("does not flag a supervisor whose owner record is current", async () => {
		const paths = await acquireTestOwnership("healthy-owner");
		await expect(detectDaemonOwnershipLost(paths.socketPath, paths.probe, paths.registryDir)).resolves.toBe(false);
	});

	it("flags a live supervisor whose owner record was deleted", async () => {
		const paths = await acquireTestOwnership("deleted-owner");
		rmSync(paths.ownerDir, { recursive: true, force: true });
		await expect(detectDaemonOwnershipLost(paths.socketPath, paths.probe, paths.registryDir)).resolves.toBe(true);
	});

	it("flags a live supervisor whose owner record was replaced", async () => {
		const paths = await acquireTestOwnership("replaced-owner");
		const record = JSON.parse(readFileSync(paths.ownerJsonPath, "utf8")) as { pid: number };
		record.pid = record.pid + 1;
		writeFileSync(paths.ownerJsonPath, `${JSON.stringify(record, null, 2)}\n`);
		await expect(detectDaemonOwnershipLost(paths.socketPath, paths.probe, paths.registryDir)).resolves.toBe(true);
	});

	it("never flags a hello without a supervisor generation", async () => {
		// A starting daemon has no generation in its hello yet and is skipped.
		const paths = await acquireTestOwnership("young-owner");
		rmSync(paths.ownerDir, { recursive: true, force: true });
		const probe: ProbeResult = { ...paths.probe };
		delete probe.supervisorGeneration;
		await expect(detectDaemonOwnershipLost(paths.socketPath, probe, paths.registryDir)).resolves.toBe(false);
	});

	it("never flags a supervisor whose process identity no longer matches", async () => {
		// Clean-shutdown race: a dead/replaced process identity means no flag.
		const paths = await acquireTestOwnership("stopping-owner");
		rmSync(paths.ownerDir, { recursive: true, force: true });
		const probe: ProbeResult = { ...paths.probe, supervisorProcessStartId: "stale-start-id" };
		await expect(detectDaemonOwnershipLost(paths.socketPath, probe, paths.registryDir)).resolves.toBe(false);
	});
});

describe("supervisorStateDirMatches", () => {
	it("matches only the generation whose snapshot-cache dir exists under the agent dir", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "doctor-agent-dir-"));
		cleanupDirs.push(agentDir);
		const socketPath = "/tmp/state-dir.sock";
		// Created by DaemonSupervisor.start() before it ever listens.
		// Mirrors defaultWorkerDescriptorDir's key rule; the positive assertion below
		// fails if production's path derivation ever drifts from this.
		const stateDir = join(
			agentDir,
			"daemon-workers",
			createHash("sha256").update(socketPath).digest("hex").slice(0, 12),
			"snapshot-cache",
			"gen-a",
		);
		mkdirSync(stateDir, { recursive: true });
		expect(supervisorStateDirMatches(agentDir, socketPath, "gen-a")).toBe(true);
		expect(supervisorStateDirMatches(agentDir, socketPath, "gen-b")).toBe(false);
		expect(supervisorStateDirMatches(agentDir, "/tmp/other.sock", "gen-a")).toBe(false);
	});
});

describe("repairOwnershipLostDaemon", () => {
	function makeLostDaemon(): DaemonInfo {
		return makeDaemon({ socketPath: "/tmp/lost.sock", status: "ownership-lost", pid: process.pid });
	}

	function makeHooks(overrides: Partial<RepairHooks> = {}): { hooks: RepairHooks; calls: string[] } {
		const calls: string[] = [];
		const probe: ProbeResult = {
			reachable: true,
			supervisorGeneration: "lost-generation",
			supervisorPid: process.pid,
			...(getProcessStartId(process.pid) ? { supervisorProcessStartId: getProcessStartId(process.pid) } : {}),
		};
		const hooks: RepairHooks = {
			probe: async (socketPath) => {
				calls.push(`probe:${socketPath}`);
				return probe;
			},
			detectLost: async () => {
				calls.push("detectLost");
				return true;
			},
			ownsSupervisorState: (socketPath, supervisorGeneration) => {
				calls.push(`ownsState:${socketPath}:${supervisorGeneration}`);
				return true;
			},
			acquireAdmission: async () => {
				calls.push("acquireAdmission");
				let released = false;
				return {
					assertOrRenew: async () => {
						calls.push("assertAdmission");
					},
					release: async () => {
						if (!released) {
							released = true;
							calls.push("releaseAdmission");
						}
					},
				};
			},
			killDaemon: async (pid, expectedProcessStartId) => {
				calls.push(`kill:${pid}:${expectedProcessStartId ?? "no-start-id"}`);
				return true;
			},
			waitStartupFence: async (socketPath) => {
				calls.push(`fence:${socketPath}`);
			},
			ensureDaemonRunning: async (socketPath) => {
				calls.push(`ensure:${socketPath}`);
			},
			...overrides,
		};
		return { hooks, calls };
	}

	it("holds admission across kill, cleanup, and fence wait, releasing only right before the relaunch", async () => {
		const { hooks, calls } = makeHooks();
		const outcome = await repairOwnershipLostDaemon(makeLostDaemon(), hooks);
		expect(outcome).toEqual({
			reaped: `restarted background service after ownership loss (killed pid ${process.pid}, relaunched on same socket)`,
		});
		expect(calls).toEqual([
			"probe:/tmp/lost.sock",
			"detectLost",
			"ownsState:/tmp/lost.sock:lost-generation",
			"acquireAdmission",
			"probe:/tmp/lost.sock",
			"detectLost",
			"assertAdmission",
			// The start id from the fresh under-admission probe fences the kill
			// against PID reuse.
			`kill:${process.pid}:${getProcessStartId(process.pid) ?? "no-start-id"}`,
			"fence:/tmp/lost.sock",
			"assertAdmission",
			"releaseAdmission",
			"ensure:/tmp/lost.sock",
		]);
	});

	it("skips without killing when the socket was taken over while waiting for admission", async () => {
		const probes: ProbeResult[] = [
			{
				reachable: true,
				supervisorGeneration: "lost-generation",
				supervisorPid: process.pid,
				...(getProcessStartId(process.pid) ? { supervisorProcessStartId: getProcessStartId(process.pid) } : {}),
			},
			{
				reachable: true,
				supervisorGeneration: "replacement-generation",
				supervisorPid: process.pid,
				...(getProcessStartId(process.pid) ? { supervisorProcessStartId: getProcessStartId(process.pid) } : {}),
			},
		];
		const { hooks, calls } = makeHooks({
			probe: async () => {
				const next = probes.shift();
				if (!next) throw new Error("unexpected probe");
				return next;
			},
		});
		const outcome = await repairOwnershipLostDaemon(makeLostDaemon(), hooks);
		expect(outcome).toEqual({ skipped: "no longer ownership-lost; not restarting" });
		expect(calls.some((call) => call.startsWith("kill") || call.startsWith("ensure"))).toBe(false);
		expect(calls).toContain("releaseAdmission");
	});

	it("does not unlink or relaunch when the wedged supervisor survives SIGKILL", async () => {
		const { hooks, calls } = makeHooks({
			killDaemon: async () => false,
		});
		const outcome = await repairOwnershipLostDaemon(makeLostDaemon(), hooks);
		expect("skipped" in outcome && outcome.skipped).toContain("did not exit after SIGKILL");
		expect(calls.some((call) => call.startsWith("fence") || call.startsWith("ensure"))).toBe(false);
		expect(calls).toContain("releaseAdmission");
	});

	it("declines to restart a daemon whose state lives under a different agent dir", async () => {
		// Killing a foreign daemon would silently drop its workers on relaunch.
		const { hooks, calls } = makeHooks({
			ownsSupervisorState: () => false,
		});
		const outcome = await repairOwnershipLostDaemon(makeLostDaemon(), hooks);
		expect("skipped" in outcome && outcome.skipped).toContain("different agent dir");
		expect(calls.some((call) => call.startsWith("kill") || call.startsWith("ensure"))).toBe(false);
	});

	it("does not kill a daemon that recovered between discovery and repair", async () => {
		const { hooks, calls } = makeHooks({
			detectLost: async () => false,
		});
		const outcome = await repairOwnershipLostDaemon(makeLostDaemon(), hooks);
		expect(outcome).toEqual({ skipped: "no longer ownership-lost; not restarting" });
		expect(calls.some((call) => call.startsWith("kill") || call.startsWith("ensure"))).toBe(false);
	});

	it("reports a kill failure without attempting a relaunch", async () => {
		const { hooks, calls } = makeHooks({
			killDaemon: async () => {
				throw new Error("kill refused");
			},
		});
		const outcome = await repairOwnershipLostDaemon(makeLostDaemon(), hooks);
		expect("skipped" in outcome && outcome.skipped).toContain("kill refused");
		expect(calls.some((call) => call.startsWith("ensure"))).toBe(false);
		expect(calls).toContain("releaseAdmission");
	});

	it("names the killed pid and the autostart fallback when the relaunch fails", async () => {
		const { hooks } = makeHooks({
			ensureDaemonRunning: async () => {
				throw new Error("spawn failed");
			},
		});
		const outcome = await repairOwnershipLostDaemon(makeLostDaemon(), hooks);
		expect("skipped" in outcome && outcome.skipped).toContain(`killed wedged supervisor (pid ${process.pid})`);
		expect("skipped" in outcome && outcome.skipped).toContain("spawn failed");
		expect("skipped" in outcome && outcome.skipped).toContain("autostart");
	});
});

function makeDaemon(options: Partial<DaemonInfo> & { socketPath: string; status: DaemonInfo["status"] }): DaemonInfo {
	return {
		isDefault: false,
		...options,
	};
}
