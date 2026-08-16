import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createReliabilityMonitorService,
	RELIABILITY_MONITOR_SERVICE_LABEL,
	type ReliabilityMonitorServiceState,
} from "../src/modes/daemon/reliability-monitor-service.js";
import { acquireSyncFileLock } from "../src/utils/sync-file-lock.js";

interface CommandCall {
	command: string;
	args: string[];
}

interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

interface ServiceHarnessOptions {
	agentDir: string;
	homeDir: string;
	now: () => number;
	platform?: NodeJS.Platform;
	processExecPath?: string;
	cliEntrypoint?: string;
	commandResults?: CommandResult[];
}

interface ServicePaths {
	launchAgentsDir: string;
	plistPath: string;
	reliabilityDir: string;
	runnerPath: string;
	statePath: string;
}

function servicePaths(homeDir: string, agentDir: string): ServicePaths {
	const reliabilityDir = join(agentDir, "reliability");
	return {
		launchAgentsDir: join(homeDir, "Library", "LaunchAgents"),
		plistPath: join(homeDir, "Library", "LaunchAgents", `${RELIABILITY_MONITOR_SERVICE_LABEL}.plist`),
		reliabilityDir,
		runnerPath: join(reliabilityDir, "monitor-runner.sh"),
		statePath: join(reliabilityDir, "monitor-service-state.json"),
	};
}

function createServiceHarness(options: ServiceHarnessOptions) {
	const calls: CommandCall[] = [];
	const commandResults = [...(options.commandResults ?? [])];
	let serviceLoaded = false;
	const service = createReliabilityMonitorService({
		agentDir: options.agentDir,
		dependencies: {
			platform: options.platform ?? "darwin",
			homeDir: () => options.homeDir,
			processExecPath: options.processExecPath ?? "/opt/prime-agent/bin/node",
			cliEntrypoint: options.cliEntrypoint ?? "/opt/prime-agent/lib/prime-agent.js",
			now: options.now,
			runCommand(command, args) {
				calls.push({ command, args: [...args] });
				if (args[0] === "bootstrap") serviceLoaded = true;
				if (args[0] === "bootout") serviceLoaded = false;
				const queued = commandResults.shift();
				if (queued) return queued;
				if (args[0] === "print") return { status: serviceLoaded ? 0 : 1, stdout: "", stderr: "" };
				return { status: 0, stdout: "", stderr: "" };
			},
		},
	});
	return { service, calls };
}

function readPlistString(contents: string, key: string): string {
	const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(contents);
	if (!match?.[1]) throw new Error(`Missing string plist value: ${key}`);
	return match[1];
}

function readPlistInteger(contents: string, key: string): number {
	const match = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(contents);
	if (!match?.[1]) throw new Error(`Missing integer plist value: ${key}`);
	return Number(match[1]);
}

function readPlistProgramArguments(contents: string): string[] {
	const match = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents);
	if (!match?.[1]) throw new Error("Missing ProgramArguments plist value");
	return [...match[1].matchAll(/<string>([^<]+)<\/string>/g)].map((argument) => argument[1]!);
}

function writeOwnedServiceArtifacts(paths: ServicePaths): void {
	mkdirSync(paths.launchAgentsDir, { recursive: true, mode: 0o700 });
	writeFileSync(paths.plistPath, "owned monitor plist\n", { mode: 0o600 });
	mkdirSync(paths.reliabilityDir, { recursive: true, mode: 0o700 });
	writeFileSync(paths.runnerPath, "#!/bin/sh\n", { mode: 0o700 });
	chmodSync(paths.runnerPath, 0o700);
}

function writeServiceState(agentDir: string, state: ReliabilityMonitorServiceState): void {
	const path = servicePaths("unused", agentDir).statePath;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function successfulState(at: string): ReliabilityMonitorServiceState {
	return {
		schemaVersion: 1,
		status: "succeeded",
		lastStartedAt: at,
		lastCompletedAt: at,
		lastExitCode: 0,
		lastResult: {
			scannedSnapshots: 0,
			alertCount: 0,
			attemptedNotifications: 0,
			pendingNotifications: 0,
			settledExtensionRequests: 0,
		},
	};
}

function hasLaunchctlCall(calls: readonly CommandCall[], operation: string, expectedArgument: string): boolean {
	return calls.some(
		({ args }) => args[0] === operation && args.some((argument) => argument.includes(expectedArgument)),
	);
}

describe("reliability monitor service", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("uses the exact repository-owned launchd label", () => {
		expect(RELIABILITY_MONITOR_SERVICE_LABEL).toBe("ai.primeintellect.prime-agent.reliability-monitor");
	});

	it("renders and installs an owner-only one-minute monitor service through injected launchctl", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-service-"));
		roots.push(root);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const processExecPath = "/opt/prime-agent/bin/node";
		const cliEntrypoint = "/opt/prime-agent/lib/prime-agent.js";
		const { service, calls } = createServiceHarness({
			agentDir,
			homeDir,
			now: () => Date.parse("2026-08-10T10:00:00.000Z"),
			processExecPath,
			cliEntrypoint,
		});

		const install = service.install();
		const paths = servicePaths(homeDir, agentDir);
		const plist = readFileSync(paths.plistPath, "utf8");
		const runner = readFileSync(paths.runnerPath, "utf8");

		expect(install).toMatchObject({ status: "healthy" });
		expect(readPlistString(plist, "Label")).toBe(RELIABILITY_MONITOR_SERVICE_LABEL);
		expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(readPlistInteger(plist, "StartInterval")).toBe(60);
		expect(readPlistProgramArguments(plist)).toEqual([paths.runnerPath]);
		expect(runner).toContain(processExecPath);
		expect(runner).toContain(cliEntrypoint);
		expect(runner).toContain(paths.reliabilityDir);
		expect(runner).not.toContain(process.cwd());
		expect(statSync(paths.runnerPath).mode & 0o777).toBe(0o700);
		expect(hasLaunchctlCall(calls, "bootout", RELIABILITY_MONITOR_SERVICE_LABEL)).toBe(true);
		expect(hasLaunchctlCall(calls, "bootstrap", paths.plistPath)).toBe(true);
		expect(hasLaunchctlCall(calls, "print", RELIABILITY_MONITOR_SERVICE_LABEL)).toBe(true);
	});

	it("locks the same path from the generated runner that the node state writer locks", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-lock-path-"));
		roots.push(root);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const { service } = createServiceHarness({
			agentDir,
			homeDir,
			now: () => Date.parse("2026-08-10T10:00:00.000Z"),
		});

		service.install();
		const paths = servicePaths(homeDir, agentDir);
		const runner = readFileSync(paths.runnerPath, "utf8");
		const expectedLockPath = `${paths.reliabilityDir}.lock`;

		expect(runner).toMatch(/state_lock="\$\{RELIABILITY_DIR\}\.lock"/);
		expect(runner).not.toMatch(/state_lock="\$\{STATE_PATH\}/);

		// The fallback state write is best-effort; without the guard set -e would replace the
		// monitor's exit code with the write's own failure status.
		expect(runner).toMatch(/^write_failure_state "\$started_at" "\$completed_at" "\$exit_code" \|\| true$/m);
		expect(runner).toMatch(/^exit "\$exit_code"$/m);

		const release = acquireSyncFileLock(paths.reliabilityDir, { staleMs: 30_000 });
		try {
			expect(existsSync(expectedLockPath)).toBe(true);
		} finally {
			release();
		}
	});

	it("uninstalls only the exact owned launchd artifacts", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-uninstall-"));
		roots.push(root);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const { service, calls } = createServiceHarness({
			agentDir,
			homeDir,
			now: () => Date.parse("2026-08-10T10:00:00.000Z"),
		});
		const paths = servicePaths(homeDir, agentDir);

		service.install();
		const unrelatedPlist = join(paths.launchAgentsDir, "com.example.unrelated.plist");
		const unrelatedReliabilityFile = join(paths.reliabilityDir, "preserve.txt");
		writeFileSync(unrelatedPlist, "unrelated\n");
		writeFileSync(unrelatedReliabilityFile, "preserve\n");
		calls.splice(0);

		const uninstall = service.uninstall();

		expect(uninstall).toMatchObject({ status: "not_installed" });
		expect(existsSync(paths.plistPath)).toBe(false);
		expect(existsSync(paths.runnerPath)).toBe(false);
		expect(readFileSync(unrelatedPlist, "utf8")).toBe("unrelated\n");
		expect(readFileSync(unrelatedReliabilityFile, "utf8")).toBe("preserve\n");
		expect(hasLaunchctlCall(calls, "bootout", RELIABILITY_MONITOR_SERVICE_LABEL)).toBe(true);
	});

	it("throws when launchctl still reports the service loaded after bootout", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-uninstall-stuck-"));
		roots.push(root);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const paths = servicePaths(homeDir, agentDir);
		writeOwnedServiceArtifacts(paths);
		const { service } = createServiceHarness({
			agentDir,
			homeDir,
			now: () => Date.parse("2026-08-10T10:00:00.000Z"),
			commandResults: [
				{ status: 1, stdout: "", stderr: "launchctl bootout: no such process" },
				{ status: 0, stdout: "", stderr: "" },
			],
		});

		expect(() => service.uninstall()).toThrow(/left the reliability monitor service loaded/);
		expect(existsSync(paths.plistPath)).toBe(true);
		expect(existsSync(paths.runnerPath)).toBe(true);
	});

	it("rejects source and tsx launch targets before creating service artifacts", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-source-runner-"));
		roots.push(root);
		const cases = [
			{
				name: "a source TypeScript entrypoint",
				processExecPath: "/opt/prime-agent/bin/node",
				cliEntrypoint: join(root, "src", "main.ts"),
			},
			{
				name: "a tsx process runner",
				processExecPath: "/opt/prime-agent/bin/tsx",
				cliEntrypoint: "/opt/prime-agent/lib/prime-agent.js",
			},
		];

		for (const testCase of cases) {
			const homeDir = join(root, testCase.name.replaceAll(" ", "-"), "home");
			const agentDir = join(root, testCase.name.replaceAll(" ", "-"), "agent");
			const { service, calls } = createServiceHarness({
				agentDir,
				homeDir,
				now: () => Date.parse("2026-08-10T10:00:00.000Z"),
				processExecPath: testCase.processExecPath,
				cliEntrypoint: testCase.cliEntrypoint,
			});

			expect(() => service.install()).toThrow(/packaged|source|tsx/i);
			expect(existsSync(servicePaths(homeDir, agentDir).plistPath)).toBe(false);
			expect(existsSync(servicePaths(homeDir, agentDir).runnerPath)).toBe(false);
			expect(calls).toEqual([]);
		}
	});

	it("returns an unsupported result on non-Darwin hosts without creating files or running commands", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-unsupported-"));
		roots.push(root);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const { service, calls } = createServiceHarness({
			agentDir,
			homeDir,
			now: () => Date.parse("2026-08-10T10:00:00.000Z"),
			platform: "linux",
		});

		expect(service.install()).toMatchObject({ status: "unsupported" });
		expect(service.uninstall()).toMatchObject({ status: "unsupported" });
		expect(existsSync(homeDir)).toBe(false);
		expect(existsSync(agentDir)).toBe(false);
		expect(calls).toEqual([]);
	});

	it("reports not installed without writing outside the supplied temporary agent directory", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-status-"));
		roots.push(root);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const { service, calls } = createServiceHarness({
			agentDir,
			homeDir,
			now: () => Date.parse("2026-08-10T10:00:00.000Z"),
		});

		expect(service.status()).toMatchObject({ status: "not_installed" });
		expect(existsSync(homeDir)).toBe(false);
		expect(existsSync(agentDir)).toBe(false);
		expect(calls).toEqual([]);
	});

	it("classifies recent, stale, and failed owner-only service state from the supplied agent directory", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-state-"));
		roots.push(root);
		const now = Date.parse("2026-08-10T10:00:00.000Z");
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const paths = servicePaths(homeDir, agentDir);
		writeOwnedServiceArtifacts(paths);
		const { service } = createServiceHarness({ agentDir, homeDir, now: () => now });

		writeServiceState(agentDir, successfulState(new Date(now - 179_999).toISOString()));
		expect(service.status()).toMatchObject({ status: "healthy" });

		writeServiceState(agentDir, {
			schemaVersion: 1,
			status: "running",
			lastStartedAt: new Date(now - 180_001).toISOString(),
		});
		expect(service.status()).toMatchObject({ status: "stale" });

		writeServiceState(agentDir, successfulState(new Date(now - 180_001).toISOString()));
		expect(service.status()).toMatchObject({ status: "stale" });

		writeServiceState(agentDir, {
			schemaVersion: 1,
			status: "failed",
			lastStartedAt: new Date(now - 1_000).toISOString(),
			lastCompletedAt: new Date(now - 1_000).toISOString(),
			lastExitCode: 1,
			lastError: "monitor command exited 1",
		});
		expect(service.status()).toMatchObject({ status: "failed" });
		expect(statSync(paths.statePath).mode & 0o777).toBe(0o600);
	});
});
