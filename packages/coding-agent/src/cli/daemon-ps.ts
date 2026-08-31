import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir, VERSION } from "../config.js";
import {
	isOrphanProcessIdentityCurrent,
	killOrphanProcess,
	readActiveOrphanProcesses,
	shouldReapOrphanProcess,
} from "../core/orphan-process-journal.js";
import { getProcessStartId } from "../core/session-lease.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	type DaemonRuntimeIdentity,
} from "../modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { acquireDaemonShutdownAdmission } from "../modes/daemon/daemon-supervisor-ownership.js";
import type { DaemonWorkerDescriptor } from "../modes/daemon/daemon-worker-protocol.js";
import { signalProcessGroupOrProcess } from "../utils/child-process.js";
import { formatDaemonListTable } from "./daemon-ps-format.js";
import { promptYesNo } from "./daemon-stop-confirm.js";

/**
 * `daemon ps` discovers every prime-agent daemon on the machine, not just the
 * one on a single socket. Discovery has two sources merged by socket path:
 *
 *  1. The OS list of listening unix sockets owned by a prime-agent process
 *     (`ss -lxp` on Linux, `lsof` on macOS). Daemons set process.title to
 *     APP_NAME and carry nothing useful in argv, so the socket→pid mapping the
 *     kernel keeps is the only reliable way to find daemons on arbitrary
 *     `--daemon-socket` paths. This is the same data as `ss -lxp | grep
 *     prime-agent`, just parsed.
 *  2. A sweep of the default socket dir, which catches orphaned socket *files*
 *     left behind by daemons that are no longer running.
 *
 * Each discovered socket is then probed with the existing daemon_hello + list
 * primitives, so introspection works even against stale daemons running an
 * older build (a new protocol command would not).
 */

export type DaemonStatus = "current" | "stale" | "unreachable" | "orphan-file";

export interface DiscoveredDaemonProcess {
	pid: number;
	socketPath: string;
	uptimeSeconds?: number;
}

export interface DaemonInfo {
	socketPath: string;
	pid?: number;
	uptimeSeconds?: number;
	version?: string;
	protocolVersion?: number;
	schemaId?: string;
	buildId?: string;
	executablePath?: string;
	pidSource?: "listener" | "hello";
	sessionCount?: number;
	status: DaemonStatus;
	isDefault: boolean;
	hasTrackedWorkers?: boolean;
}

const STATUS_ORDER: Record<DaemonStatus, number> = {
	current: 0,
	stale: 1,
	unreachable: 2,
	"orphan-file": 3,
};
const SHUTDOWN_QUIET_PERIOD_MS = 1000;
const SHUTDOWN_CONVERGENCE_TIMEOUT_MS = 10_000;

export function evaluateShutdownQuietPeriod(now: number, quietSince: number | undefined): "complete" | "waiting" {
	if (quietSince !== undefined && now - quietSince >= SHUTDOWN_QUIET_PERIOD_MS) {
		return "complete";
	}
	return "waiting";
}

// Linux comm names (and thus the process name ss reports) are capped at 15 chars.
const MAX_COMM_LENGTH = 15;

function processNameMatches(name: string, appName: string): boolean {
	return name === appName || appName.slice(0, MAX_COMM_LENGTH) === name;
}

/** Parse `ss -lxp` output into the prime-agent daemons listening on unix sockets. */
export function parseSsListeners(stdout: string, appName: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	for (const line of stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[1] !== "LISTEN") {
			continue;
		}
		const socketPath = fields[4];
		if (!socketPath?.startsWith("/")) {
			continue;
		}
		const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
		if (!owner || !processNameMatches(owner[1]!, appName)) {
			continue;
		}
		daemons.push({ pid: Number.parseInt(owner[2]!, 10), socketPath: normalizeSocketPath(socketPath) });
	}
	return daemons;
}

/** Parse `lsof -nP -F pn -U -a -c <app>` output into listening unix socket owners (macOS fallback). */
export function parseLsofListeners(stdout: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	const seen = new Set<string>();
	let pid: number | undefined;
	for (const line of stdout.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			pid = Number.parseInt(value, 10);
		} else if (field === "n" && pid !== undefined && value.startsWith("/")) {
			const socketPath = normalizeSocketPath(value);
			const key = `${pid}:${socketPath}`;
			if (!seen.has(key)) {
				seen.add(key);
				daemons.push({ pid, socketPath });
			}
		}
	}
	return daemons;
}

export function parsePrimeAgentProcessIds(stdout: string, appName: string): number[] {
	const pids: number[] = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\S+)(?:\s+(.*))?$/);
		if (!match) {
			continue;
		}
		const command = basename(match[2]!);
		const argv0 = basename(match[3]?.trim().split(/\s+/, 1)[0] ?? "");
		if (processNameMatches(command, appName) || processNameMatches(argv0, appName)) {
			pids.push(Number.parseInt(match[1]!, 10));
		}
	}
	return pids;
}

export function mergeDiscoveredDaemonProcesses(
	...groups: readonly DiscoveredDaemonProcess[][]
): DiscoveredDaemonProcess[] {
	const byIdentity = new Map<string, DiscoveredDaemonProcess>();
	for (const group of groups) {
		for (const daemon of group) {
			byIdentity.set(`${daemon.pid}:${daemon.socketPath}`, daemon);
		}
	}
	return [...byIdentity.values()];
}

/** Parse `ps -o pid=,etimes=` output into a pid → uptime-seconds map. */
export function parsePsEtimes(stdout: string): Map<number, number> {
	const uptimes = new Map<number, number>();
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (match) {
			uptimes.set(Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10));
		}
	}
	return uptimes;
}

function scanListeningDaemons(): DiscoveredDaemonProcess[] {
	if (process.platform === "win32") {
		return [];
	}
	const ss = spawnSync("ss", ["-lxp"], { encoding: "utf8" });
	if (!ss.error && ss.status === 0 && typeof ss.stdout === "string") {
		return enrichUptimes(parseSsListeners(ss.stdout, APP_NAME));
	}
	const lsof = spawnSync("lsof", ["-nP", "-F", "pn", "-U", "-a", "-c", APP_NAME], { encoding: "utf8" });
	const byName = !lsof.error && typeof lsof.stdout === "string" ? parseLsofListeners(lsof.stdout) : [];
	let byPid: DiscoveredDaemonProcess[] = [];
	const ps = spawnSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
	if (!ps.error && ps.status === 0 && typeof ps.stdout === "string") {
		const pids = parsePrimeAgentProcessIds(ps.stdout, APP_NAME);
		if (pids.length > 0) {
			const lsofByPid = spawnSync("lsof", ["-nP", "-F", "pn", "-U", "-a", "-p", pids.join(",")], {
				encoding: "utf8",
			});
			if (!lsofByPid.error && typeof lsofByPid.stdout === "string") {
				byPid = parseLsofListeners(lsofByPid.stdout);
			}
		}
	}
	return enrichUptimes(mergeDiscoveredDaemonProcesses(byName, byPid));
}

function isDaemonProcessListening(pid: number, socketPath: string): boolean {
	const target = normalizeSocketPath(socketPath);
	return scanListeningDaemons().some((daemon) => daemon.pid === pid && daemon.socketPath === target);
}

function enrichUptimes(daemons: DiscoveredDaemonProcess[]): DiscoveredDaemonProcess[] {
	const pids = daemons.map((daemon) => daemon.pid);
	if (pids.length === 0) {
		return daemons;
	}
	const ps = spawnSync("ps", ["-o", "pid=,etimes=", "-p", pids.join(",")], { encoding: "utf8" });
	if (ps.error || typeof ps.stdout !== "string") {
		return daemons;
	}
	const uptimes = parsePsEtimes(ps.stdout);
	return daemons.map((daemon) => ({ ...daemon, uptimeSeconds: uptimes.get(daemon.pid) }));
}

/** Socket files in the default socket dir (may be live daemons or orphaned files). */
function scanSocketDir(): string[] {
	if (process.platform === "win32") {
		return [];
	}
	const dir = defaultDaemonSocketDir();
	if (!existsSync(dir)) {
		return [];
	}
	const sockets: string[] = [];
	for (const entry of readdirSync(dir)) {
		const socketPath = join(dir, entry);
		try {
			if (lstatSync(socketPath).isSocket()) {
				sockets.push(normalizeSocketPath(socketPath));
			}
		} catch {
			// Entry vanished between readdir and lstat; ignore.
		}
	}
	return sockets;
}

interface ProbeResult {
	version?: string;
	protocolVersion?: number;
	schemaId?: string;
	runtime?: DaemonRuntimeIdentity;
	sessionCount?: number;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	reachable: boolean;
}

async function probeDaemon(socketPath: string): Promise<ProbeResult> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(300);
	} catch {
		client.close();
		return { reachable: false };
	}
	try {
		let version: string | undefined;
		let protocolVersion: number | undefined;
		let schemaId: string | undefined;
		let runtime: DaemonRuntimeIdentity | undefined;
		let supervisorPid: number | undefined;
		let supervisorProcessStartId: string | undefined;
		let greeted = false;
		try {
			const hello = await client.waitForHello(1500);
			version = hello.appVersion;
			protocolVersion = hello.protocol.version;
			schemaId = hello.schemaId;
			runtime = hello.runtime;
			supervisorPid = hello.supervisorPid;
			supervisorProcessStartId = hello.supervisorProcessStartId;
			greeted = true;
		} catch {
			// Connected but no recognizable greeting: an old/foreign daemon.
		}
		let sessionCount: number | undefined;
		try {
			const response = await client.request({ type: "list" }, greeted ? 30000 : 1500);
			if (response.success) {
				const sessions = (response.data as { sessions?: unknown })?.sessions;
				if (Array.isArray(sessions)) {
					sessionCount = sessions.length;
				}
			}
		} catch {
			// Leave sessionCount undefined when the daemon will not answer list.
		}
		return {
			version,
			protocolVersion,
			schemaId,
			runtime,
			sessionCount,
			supervisorPid,
			supervisorProcessStartId,
			reachable: true,
		};
	} finally {
		client.close();
	}
}

function classifyReachable(probe: ProbeResult): DaemonStatus {
	if (
		probe.protocolVersion === DAEMON_PROTOCOL_VERSION &&
		probe.schemaId === DAEMON_SCHEMA_ID &&
		probe.version === VERSION
	) {
		return "current";
	}
	return "stale";
}

export function verifyHelloSupervisorPid(
	pid: number | undefined,
	expectedProcessStartId: string | undefined,
): number | undefined {
	if (!Number.isInteger(pid) || pid === undefined || pid <= 0) {
		return undefined;
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") {
			return undefined;
		}
	}
	if (expectedProcessStartId) {
		const observedStartId = getProcessStartId(pid);
		if (observedStartId !== expectedProcessStartId) {
			return undefined;
		}
	}
	return pid;
}

/** Discover every daemon on the machine and probe each for version + session count. */
export async function discoverDaemons(): Promise<DaemonInfo[]> {
	const processBySocket = new Map<string, DiscoveredDaemonProcess>();
	for (const daemon of scanListeningDaemons()) {
		if (isWorkerSocketPath(daemon.socketPath)) {
			continue;
		}
		processBySocket.set(daemon.socketPath, daemon);
	}

	const workerSockets = new Set(
		findAllTrackedWorkers().map((worker) => normalizeSocketPath(worker.descriptor.supervisorSocketPath)),
	);
	const sockets = new Set<string>([
		...processBySocket.keys(),
		...scanSocketDir().filter((socketPath) => !isWorkerSocketPath(socketPath)),
		...workerSockets,
	]);
	const defaultSocket = normalizeSocketPath(defaultDaemonSocketPath());

	const infos = await Promise.all(
		[...sockets].map(async (socketPath): Promise<DaemonInfo> => {
			const proc = processBySocket.get(socketPath);
			const probe = await probeDaemon(socketPath);
			const pid = proc?.pid ?? verifyHelloSupervisorPid(probe.supervisorPid, probe.supervisorProcessStartId);
			const hasTrackedWorkers = workerSockets.has(socketPath);
			const status: DaemonStatus = probe.reachable
				? classifyReachable(probe)
				: proc || hasTrackedWorkers
					? "unreachable"
					: "orphan-file";
			return {
				socketPath,
				pid,
				uptimeSeconds: proc?.uptimeSeconds,
				version: probe.version,
				protocolVersion: probe.protocolVersion,
				schemaId: probe.schemaId,
				buildId: probe.runtime?.buildId,
				executablePath:
					probe.runtime?.launcherPath ?? probe.runtime?.entrypointPath ?? probe.runtime?.executablePath,
				...(pid !== undefined ? { pidSource: proc ? ("listener" as const) : ("hello" as const) } : {}),
				sessionCount: probe.sessionCount,
				status,
				isDefault: socketPath === defaultSocket,
				...(hasTrackedWorkers ? { hasTrackedWorkers: true } : {}),
			};
		}),
	);

	return sortDaemons(infos);
}

export function sortDaemons(infos: DaemonInfo[]): DaemonInfo[] {
	return [...infos].sort((left, right) => {
		if (left.isDefault !== right.isDefault) {
			return left.isDefault ? -1 : 1;
		}
		const statusDelta = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
		return statusDelta || left.socketPath.localeCompare(right.socketPath);
	});
}

export async function runPs(json: boolean): Promise<void> {
	const daemons = await discoverDaemons();
	if (json) {
		console.log(JSON.stringify(daemons, null, 2));
		return;
	}
	if (daemons.length === 0) {
		console.log("No background services found.");
		return;
	}
	console.log(formatDaemonListTable(daemons));
}

export type ReapAction =
	| { kind: "remove-file"; daemon: DaemonInfo }
	| { kind: "kill"; daemon: DaemonInfo }
	| { kind: "shutdown"; daemon: DaemonInfo }
	| { kind: "skip"; daemon: DaemonInfo; reason: string };

/**
 * Decide what to do with each discovered daemon (pure, no side effects). Reap
 * targets only clearly-safe daemons: orphaned socket files (including a stale
 * default daemon.sock with no live process), and reachable idle daemons on
 * non-default sockets. A reachable default daemon, and any reachable daemon with
 * live sessions, are never touched.
 *
 * Unreachable (hung) daemons can't report a session count, so they are only
 * ever killed with `force`, and even then never via a pid that backs more than
 * one discovered daemon (e.g. macOS lsof reports every unix socket a process
 * holds, so killing a shared pid could take down a reachable daemon with live
 * sessions). runReap additionally re-probes a kill candidate immediately before
 * the SIGTERM and backs off to the session-aware paths if it has since become
 * reachable, so a daemon that recovered with live sessions is never killed.
 */
export function planReap(daemons: readonly DaemonInfo[], force: boolean): ReapAction[] {
	const pidCounts = new Map<number, number>();
	for (const daemon of daemons) {
		if (daemon.pid !== undefined) {
			pidCounts.set(daemon.pid, (pidCounts.get(daemon.pid) ?? 0) + 1);
		}
	}

	return daemons.map((daemon): ReapAction => {
		// An orphan socket file has no owning process, so removing it is safe even
		// on the default path (a stale daemon.sock left by a crash). Decide this
		// before the default guard so a dead default socket still gets cleaned up.
		if (daemon.status === "orphan-file") {
			return { kind: "remove-file", daemon };
		}
		if (daemon.isDefault) {
			return { kind: "skip", daemon, reason: "default background service" };
		}
		if (daemon.status === "unreachable") {
			if (!force || daemon.pid === undefined) {
				return { kind: "skip", daemon, reason: 'unreachable; use "prime-agent shutdown --force" to stop it' };
			}
			if ((pidCounts.get(daemon.pid) ?? 0) > 1) {
				return {
					kind: "skip",
					daemon,
					reason: `unreachable; pid ${daemon.pid} also backs another daemon, not killing`,
				};
			}
			return { kind: "kill", daemon };
		}
		if (daemon.sessionCount !== 0) {
			return { kind: "skip", daemon, reason: `has ${daemon.sessionCount ?? "unknown"} session(s)` };
		}
		return { kind: "shutdown", daemon };
	});
}

export function planShutdownAll(daemons: readonly DaemonInfo[], force: boolean): ReapAction[] {
	return daemons.map((daemon): ReapAction => {
		if (daemon.status === "orphan-file") {
			return { kind: "remove-file", daemon };
		}
		if (daemon.status === "unreachable") {
			if (daemon.pid === undefined) {
				return force || !daemon.hasTrackedWorkers
					? { kind: "remove-file", daemon }
					: { kind: "skip", daemon, reason: "has unreachable workers; use --force to kill" };
			}
			return force ? { kind: "kill", daemon } : { kind: "skip", daemon, reason: "unreachable; use --force to kill" };
		}
		return { kind: "shutdown", daemon };
	});
}

const SHUTDOWN_ALL_ACTION_ORDER: Record<ReapAction["kind"], number> = {
	shutdown: 0,
	"remove-file": 1,
	kill: 2,
	skip: 3,
};

export type ShutdownConfirmationPlan = "none" | "prompt" | "json-error" | "tty-error";

export function planShutdownConfirmation(
	daemonCount: number,
	json: boolean,
	force: boolean,
	stdinIsTTY: boolean | undefined,
): ShutdownConfirmationPlan {
	if (daemonCount === 0 || force) return "none";
	if (json) return "json-error";
	return stdinIsTTY ? "prompt" : "tty-error";
}

export async function runShutdownAll(json: boolean, force: boolean): Promise<void> {
	const daemons = await discoverDaemons();
	switch (planShutdownConfirmation(daemons.length, json, force, process.stdin.isTTY)) {
		case "json-error":
			process.exitCode = 1;
			console.log(
				JSON.stringify(
					{
						stopped: [],
						failed: daemons.map(({ socketPath }) => ({
							socketPath,
							reason: 'confirmation required; use "prime-agent shutdown --force --json"',
						})),
					},
					null,
					2,
				),
			);
			return;
		case "tty-error":
			throw new Error(
				'Shutdown requires confirmation in an interactive terminal. Use "prime-agent shutdown --force".',
			);
		case "prompt": {
			const confirmed = await promptYesNo(
				"Stop every agent and background service? Active work will be interrupted.",
			);
			if (!confirmed) {
				console.log(chalk.dim("Shutdown cancelled."));
				return;
			}
			break;
		}
		case "none":
			break;
	}
	const admission = await acquireDaemonShutdownAdmission();
	try {
		await runShutdownAllConverging(json, force, () => admission.assertOrRenew());
	} finally {
		await admission.release();
	}
}

async function runShutdownAllConverging(
	json: boolean,
	force: boolean,
	assertAdmission: () => Promise<void>,
): Promise<void> {
	const stopped: Array<{ socketPath: string; action: string }> = [];
	const failed: Array<{ socketPath: string; reason: string }> = [];
	const handledPids = new Set<number>();
	const reportedFailures = new Set<string>();

	if (force) {
		await stopHiddenSupervisors(stopped, failed, handledPids, reportedFailures, assertAdmission);
	}
	const daemons = (await discoverDaemons()).filter((daemon) => !isWorkerSocketPath(daemon.socketPath));

	const actions = [...planShutdownAll(daemons, force)].sort(
		(left, right) => SHUTDOWN_ALL_ACTION_ORDER[left.kind] - SHUTDOWN_ALL_ACTION_ORDER[right.kind],
	);

	for (const action of actions) {
		const { socketPath, pid } = action.daemon;
		if (pid !== undefined && handledPids.has(pid)) {
			await assertAdmission();
			removeSocketFile(socketPath);
			stopped.push({ socketPath, action: `background service already stopped (pid ${pid})` });
			if (force) {
				failed.push(
					...(await forceStopTrackedWorkers(socketPath, assertAdmission)).map((reason) => ({
						socketPath,
						reason,
					})),
				);
			}
			continue;
		}
		switch (action.kind) {
			case "remove-file": {
				if ((await probeDaemon(socketPath)).reachable) {
					apply(
						await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
						socketPath,
						stopped,
						failed,
					);
				} else {
					await assertAdmission();
					if (removeSocketFile(socketPath)) {
						stopped.push({ socketPath, action: "removed stale socket file" });
					} else {
						failed.push({ socketPath, reason: "could not remove socket file" });
					}
				}
				break;
			}
			case "kill": {
				if ((await probeDaemon(socketPath)).reachable) {
					apply(
						await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
						socketPath,
						stopped,
						failed,
					);
				} else if (isDaemonProcessListening(pid!, socketPath)) {
					await assertAdmission();
					await forceKillDaemon(pid!);
					handledPids.add(pid!);
					await assertAdmission();
					removeSocketFile(socketPath);
					stopped.push({ socketPath, action: `killed unreachable background service (pid ${pid})` });
				} else {
					await assertAdmission();
					removeSocketFile(socketPath);
					stopped.push({ socketPath, action: "background service already stopped" });
				}
				break;
			}
			case "shutdown":
				apply(
					await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
					socketPath,
					stopped,
					failed,
				);
				break;
			case "skip":
				failed.push({ socketPath, reason: action.reason });
				break;
		}
		if (force && action.kind !== "skip") {
			failed.push(
				...(await forceStopTrackedWorkers(socketPath, assertAdmission)).map((reason) => ({ socketPath, reason })),
			);
		}
	}

	if (force) {
		await terminateVerifiedResiduals(stopped, failed, handledPids, reportedFailures, assertAdmission);
	}

	if (json) {
		if (failed.length > 0) {
			process.exitCode = 1;
		}
		console.log(JSON.stringify({ stopped, failed }, null, 2));
		return;
	}
	if (stopped.length === 0 && failed.length === 0) {
		console.log("No background services found.");
		return;
	}
	for (const entry of stopped) {
		console.log(chalk.green(`stopped ${entry.socketPath}: ${entry.action}`));
	}
	for (const entry of failed) {
		console.log(chalk.red(`failed  ${entry.socketPath}: ${entry.reason}`));
	}
	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

async function stopHiddenSupervisors(
	stopped: Array<{ socketPath: string; action: string }>,
	failed: Array<{ socketPath: string; reason: string }>,
	handledPids: Set<number>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
): Promise<void> {
	while (true) {
		const listeners = scanListeningDaemons().filter((listener) => !isWorkerSocketPath(listener.socketPath));
		const bySocket = new Map<string, DiscoveredDaemonProcess[]>();
		for (const listener of listeners) {
			const group = bySocket.get(listener.socketPath) ?? [];
			group.push(listener);
			bySocket.set(listener.socketPath, group);
		}
		const hidden: DiscoveredDaemonProcess[] = [];
		for (const [socketPath, group] of bySocket) {
			if (new Set(group.map((listener) => listener.pid)).size < 2) {
				continue;
			}
			const currentPid = (await probeDaemon(socketPath)).supervisorPid;
			if (currentPid === undefined || !group.some((listener) => listener.pid === currentPid)) {
				recordShutdownFailure(
					failed,
					reportedFailures,
					socketPath,
					"could not identify the current same-path daemon",
				);
				continue;
			}
			hidden.push(...group.filter((listener) => listener.pid !== currentPid));
		}
		if (hidden.length === 0) {
			return;
		}
		const before = daemonListenerSignature(hidden);
		for (const listener of hidden) {
			if (await terminateVerifiedListener(listener, failed, reportedFailures, assertAdmission)) {
				handledPids.add(listener.pid);
				stopped.push({ socketPath: listener.socketPath, action: `stopped hidden daemon (pid ${listener.pid})` });
			}
		}
		const afterHidden = scanListeningDaemons().filter(
			(listener) =>
				!isWorkerSocketPath(listener.socketPath) &&
				hidden.some((candidate) => candidate.pid === listener.pid && candidate.socketPath === listener.socketPath),
		);
		if (afterHidden.length === 0 || daemonListenerSignature(afterHidden) === before) {
			return;
		}
	}
}

async function terminateVerifiedResiduals(
	stopped: Array<{ socketPath: string; action: string }>,
	failed: Array<{ socketPath: string; reason: string }>,
	handledPids: Set<number>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
): Promise<void> {
	let previousSignature: string | undefined;
	let quietSince: number | undefined;
	const deadline = Date.now() + SHUTDOWN_CONVERGENCE_TIMEOUT_MS;
	while (true) {
		await assertAdmission();
		const listeners = scanListeningDaemons();
		const now = Date.now();
		if (listeners.length === 0) {
			previousSignature = undefined;
			quietSince ??= now;
			const quietPeriod = evaluateShutdownQuietPeriod(now, quietSince);
			if (quietPeriod === "complete") {
				return;
			}
			await delay(100);
			continue;
		}
		quietSince = undefined;
		const signature = daemonListenerSignature(listeners);
		if (now >= deadline) {
			recordResidualListenerFailures(listeners, failed, reportedFailures, "kept respawning during shutdown");
			return;
		}
		if (signature === previousSignature) {
			recordResidualListenerFailures(listeners, failed, reportedFailures, "remained after shutdown");
			return;
		}
		previousSignature = signature;
		const seenPids = new Set<number>();
		for (const listener of listeners) {
			if (seenPids.has(listener.pid)) {
				continue;
			}
			seenPids.add(listener.pid);
			const alreadyReported = handledPids.has(listener.pid);
			if (await terminateVerifiedListener(listener, failed, reportedFailures, assertAdmission)) {
				handledPids.add(listener.pid);
				if (!alreadyReported) {
					stopped.push({
						socketPath: listener.socketPath,
						action: `stopped residual daemon process (pid ${listener.pid})`,
					});
				}
			}
		}
	}
}

function recordResidualListenerFailures(
	listeners: readonly DiscoveredDaemonProcess[],
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	reason: string,
): void {
	for (const listener of listeners) {
		const processStartId = getProcessStartId(listener.pid);
		const identity = processStartId
			? `pid ${listener.pid}, start ${processStartId}`
			: `pid ${listener.pid}, process identity unavailable`;
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`daemon ${reason} (${identity})${describeDaemonParent(listener.pid)}`,
		);
	}
}
function describeDaemonParent(pid: number): string {
	const result = spawnSync("ps", ["-o", "ppid=,tty=,command=", "-p", String(pid)], { encoding: "utf8" });
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
		return "";
	}
	const match = result.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
	if (!match) {
		return "";
	}
	return `; close parent PID ${match[1]} on ${match[2]} (${match[3]}) and retry shutdown`;
}

async function terminateVerifiedListener(
	listener: DiscoveredDaemonProcess,
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
): Promise<boolean> {
	const processStartId = getProcessStartId(listener.pid);
	if (!processStartId) {
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`could not verify daemon process identity (pid ${listener.pid})`,
		);
		return false;
	}
	if (getProcessStartId(listener.pid) !== processStartId) {
		return false;
	}
	await assertAdmission();
	if (getProcessStartId(listener.pid) !== processStartId) {
		return false;
	}
	killDaemon(listener.pid);
	const deadline = Date.now() + 1000;
	while (getProcessStartId(listener.pid) === processStartId && Date.now() < deadline) {
		await delay(50);
	}
	if (getProcessStartId(listener.pid) === processStartId) {
		await assertAdmission();
		if (getProcessStartId(listener.pid) !== processStartId) {
			return false;
		}
		try {
			process.kill(listener.pid, "SIGKILL");
		} catch {
			// The verified process exited between the identity check and signal.
		}
	}
	return getProcessStartId(listener.pid) !== processStartId;
}

function daemonListenerSignature(listeners: readonly DiscoveredDaemonProcess[]): string {
	return listeners
		.map((listener) => `${listener.pid}:${getProcessStartId(listener.pid) ?? "unknown"}:${listener.socketPath}`)
		.sort()
		.join("\n");
}

function recordShutdownFailure(
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	socketPath: string,
	reason: string,
): void {
	const key = `${socketPath}\0${reason}`;
	if (reportedFailures.has(key)) {
		return;
	}
	reportedFailures.add(key);
	failed.push({ socketPath, reason });
}

export function isWorkerSocketPath(socketPath: string): boolean {
	return (
		process.platform !== "win32" &&
		resolve(dirname(socketPath)) === resolve(defaultDaemonSocketDir()) &&
		basename(socketPath).startsWith("worker-") &&
		basename(socketPath).endsWith(".sock")
	);
}

async function stopBackgroundService(
	socketPath: string,
	pid: number | undefined,
	handledPids: Set<number>,
	force: boolean,
	assertAdmission: () => Promise<void>,
): Promise<ReapOutcome> {
	await assertAdmission();
	if (await shutdownDaemon(socketPath, force)) {
		if (pid !== undefined) {
			handledPids.add(pid);
		}
		return { reaped: `stopped background service${pid ? ` (pid ${pid})` : ""}` };
	}
	if (!(await canConnectToSocket(socketPath, 250))) {
		await assertAdmission();
		removeSocketFile(socketPath);
		return { reaped: "background service already stopped" };
	}
	if (pid === undefined) {
		return { skipped: "still listening but no pid to kill" };
	}
	if (!force) {
		return { skipped: "did not stop gracefully; retry with --force" };
	}
	await assertAdmission();
	await forceKillDaemon(pid);
	handledPids.add(pid);
	await assertAdmission();
	removeSocketFile(socketPath);
	return { reaped: `force-killed unresponsive background service (pid ${pid})` };
}

interface TrackedWorker {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
}

async function forceStopTrackedWorkers(
	supervisorSocketPath: string,
	assertAdmission: () => Promise<void>,
): Promise<string[]> {
	const failures: string[] = [];
	for (const worker of findTrackedWorkers(supervisorSocketPath)) {
		const { descriptor } = worker;
		let cleanupWorkerRecords = await stopTrackedProcess(descriptor.pid, descriptor.processStartId, assertAdmission);
		if (!cleanupWorkerRecords) {
			failures.push(`could not safely stop worker ${descriptor.workerId} (pid ${descriptor.pid})`);
		}
		if (descriptor.orphanProcessJournalPath) {
			let orphans: ReturnType<typeof readActiveOrphanProcesses> = [];
			try {
				orphans = readActiveOrphanProcesses(descriptor.orphanProcessJournalPath, descriptor.pid);
			} catch (error) {
				failures.push(`could not read child process records for worker ${descriptor.workerId}: ${String(error)}`);
			}
			for (const orphan of orphans) {
				// Pid-only records go through the platform predicate (stopTrackedProcess needs a startId).
				if (orphan.processStartId === undefined) {
					if (shouldReapOrphanProcess(orphan)) {
						killOrphanProcess(orphan.pid);
					}
					continue;
				}
				if (!isOrphanProcessIdentityCurrent(orphan)) {
					continue;
				}
				if (process.platform === "win32") {
					// taskkill /T, like the sibling reapers: signalling only the shell pid leaves its descendants alive.
					await assertAdmission();
					if (isOrphanProcessIdentityCurrent(orphan)) {
						killOrphanProcess(orphan.pid);
						if (isProcessAlive(orphan.pid)) {
							cleanupWorkerRecords = false;
							failures.push(`could not stop child process ${orphan.pid} for worker ${descriptor.workerId}`);
						}
					}
					continue;
				}
				if (!(await stopTrackedProcess(orphan.pid, orphan.processStartId, assertAdmission))) {
					cleanupWorkerRecords = false;
					failures.push(`could not stop child process ${orphan.pid} for worker ${descriptor.workerId}`);
				}
			}
		}
		if (cleanupWorkerRecords) {
			try {
				removeSocketFile(descriptor.socketPath);
				rmSync(worker.descriptorPath, { force: true });
				rmSync(descriptor.recoveryJournalPath, { force: true });
				if (descriptor.orphanProcessJournalPath) {
					rmSync(descriptor.orphanProcessJournalPath, { force: true });
				}
			} catch (error) {
				failures.push(`could not clean up worker ${descriptor.workerId}: ${String(error)}`);
			}
		}
	}
	return failures;
}

function findTrackedWorkers(supervisorSocketPath: string): TrackedWorker[] {
	return findAllTrackedWorkers().filter(
		(worker) =>
			normalizeSocketPath(worker.descriptor.supervisorSocketPath) === normalizeSocketPath(supervisorSocketPath),
	);
}

function findAllTrackedWorkers(): TrackedWorker[] {
	const root = join(getAgentDir(), "daemon-workers");
	if (!existsSync(root)) {
		return [];
	}
	const workers: TrackedWorker[] = [];
	let directoryNames: string[];
	try {
		directoryNames = readdirSync(root);
	} catch {
		return [];
	}
	for (const directoryName of directoryNames) {
		const directory = join(root, directoryName);
		try {
			if (!lstatSync(directory).isDirectory()) {
				continue;
			}
		} catch {
			continue;
		}
		let fileNames: string[];
		try {
			fileNames = readdirSync(directory);
		} catch {
			continue;
		}
		for (const fileName of fileNames) {
			if (!fileName.endsWith(".json")) {
				continue;
			}
			const descriptorPath = join(directory, fileName);
			try {
				const value: unknown = JSON.parse(readFileSync(descriptorPath, "utf8"));
				if (isTrackedWorkerDescriptor(value)) {
					workers.push({ descriptor: value, descriptorPath });
				}
			} catch {
				// Invalid or concurrently removed descriptors are not safe shutdown targets.
			}
		}
	}
	return workers;
}

function isTrackedWorkerDescriptor(value: unknown): value is DaemonWorkerDescriptor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const descriptor = value as Partial<DaemonWorkerDescriptor>;
	return (
		(descriptor.version === 1 || descriptor.version === 2) &&
		typeof descriptor.supervisorSocketPath === "string" &&
		typeof descriptor.workerId === "string" &&
		Number.isInteger(descriptor.pid) &&
		(descriptor.pid ?? 0) > 0 &&
		(descriptor.processStartId === undefined || typeof descriptor.processStartId === "string") &&
		typeof descriptor.socketPath === "string" &&
		typeof descriptor.recoveryJournalPath === "string"
	);
}

async function stopTrackedProcess(
	pid: number,
	expectedStartId: string | undefined,
	assertAdmission: () => Promise<void>,
): Promise<boolean> {
	if (!isProcessAlive(pid)) {
		return true;
	}
	if (!expectedStartId || getProcessStartId(pid) !== expectedStartId) {
		return false;
	}
	await assertAdmission();
	if (getProcessStartId(pid) !== expectedStartId) {
		return false;
	}
	signalProcessGroupOrProcess(pid, "SIGTERM");
	let deadline = Date.now() + 500;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await delay(25);
	}
	if (!isProcessAlive(pid)) {
		return true;
	}
	await assertAdmission();
	if (getProcessStartId(pid) !== expectedStartId) {
		return false;
	}
	signalProcessGroupOrProcess(pid, "SIGKILL");
	deadline = Date.now() + 1000;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await delay(25);
	}
	return !isProcessAlive(pid);
}

export async function runReap(json: boolean, force: boolean): Promise<void> {
	const daemons = await discoverDaemons();
	const reaped: Array<{ socketPath: string; action: string }> = [];
	const skipped: Array<{ socketPath: string; reason: string }> = [];

	for (const action of planReap(daemons, force)) {
		const { socketPath, pid } = action.daemon;
		switch (action.kind) {
			case "skip":
				skipped.push({ socketPath, reason: action.reason });
				break;
			case "remove-file": {
				// Re-probe before unlinking: a path marked orphan-file at discovery
				// may have since become a live listener. Only remove it if it is
				// still unreachable, so we never delete a socket a daemon is using.
				if ((await probeDaemon(socketPath)).reachable) {
					skipped.push({ socketPath, reason: "now reachable; not removing socket file" });
				} else if (removeSocketFile(socketPath)) {
					reaped.push({ socketPath, action: "removed stale socket file" });
				} else {
					skipped.push({ socketPath, reason: "could not remove socket file" });
				}
				break;
			}
			case "kill": {
				// Re-probe right before killing: discovery and this kill happen at
				// different moments, so a daemon classified "unreachable" may have
				// since started answering. Never SIGTERM one that now responds;
				// defer to the session-aware shutdown path instead.
				const recheck = await probeDaemon(socketPath);
				if (!recheck.reachable) {
					killDaemon(pid!);
					removeSocketFile(socketPath);
					reaped.push({ socketPath, action: `killed unreachable daemon (pid ${pid})` });
				} else {
					apply(await reapReachableDaemon(socketPath, pid), socketPath, reaped, skipped);
				}
				break;
			}
			case "shutdown":
				apply(await reapReachableDaemon(socketPath, pid), socketPath, reaped, skipped);
				break;
		}
	}

	if (json) {
		console.log(JSON.stringify({ reaped, skipped }, null, 2));
		return;
	}
	if (reaped.length === 0 && skipped.length === 0) {
		console.log("No background services found.");
		return;
	}
	for (const entry of reaped) {
		console.log(chalk.green(`reaped ${entry.socketPath}: ${entry.action}`));
	}
	for (const entry of skipped) {
		console.log(chalk.dim(`kept   ${entry.socketPath}: ${entry.reason}`));
	}
}

type ReapOutcome = { reaped: string } | { skipped: string };

function apply(
	outcome: ReapOutcome,
	socketPath: string,
	reaped: Array<{ socketPath: string; action: string }>,
	skipped: Array<{ socketPath: string; reason: string }>,
): void {
	if ("reaped" in outcome) {
		reaped.push({ socketPath, action: outcome.reaped });
	} else {
		skipped.push({ socketPath, reason: outcome.skipped });
	}
}

/**
 * Gracefully stop a daemon, but only after a fresh probe confirms it is idle.
 * Discovery and reap happen at different moments, so the session count is
 * re-checked here to avoid stopping a daemon that gained a session in between.
 */
async function reapReachableDaemon(socketPath: string, pid: number | undefined): Promise<ReapOutcome> {
	const probe = await probeDaemon(socketPath);
	if (!probe.reachable) {
		return { skipped: "no longer reachable" };
	}
	if (probe.sessionCount !== 0) {
		return { skipped: `now has ${probe.sessionCount ?? "unknown"} session(s)` };
	}
	return (await shutdownDaemon(socketPath, false))
		? { reaped: `stopped idle background service${pid ? ` (pid ${pid})` : ""}` }
		: { skipped: "shutdown request failed" };
}

function removeSocketFile(socketPath: string): boolean {
	try {
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
		return true;
	} catch {
		return false;
	}
}

function killDaemon(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process already gone or not permitted; the socket file cleanup still runs.
	}
}

async function forceKillDaemon(pid: number): Promise<void> {
	killDaemon(pid);
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return;
		}
		await delay(50);
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Process already exited between the liveness check and the kill.
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnectToSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

/**
 * Ask a daemon to shut down and confirm it actually stopped listening. The
 * shutdown ack alone is not proof, so success is reported only once the socket
 * stops accepting connections.
 */
async function shutdownDaemon(socketPath: string, force: boolean): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
	} catch {
		client.close();
		return false;
	}
	try {
		await client.request({ type: "shutdown", force }, 1500);
	} catch {
		// The daemon may still stop; the connectivity check below is the source of truth.
	} finally {
		client.close();
	}

	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!(await canConnectToSocket(socketPath, 250))) {
			return true;
		}
		await delay(50);
	}
	return false;
}
