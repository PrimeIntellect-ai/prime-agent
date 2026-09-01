import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../../src/config.js";
import { isDaemonCatalogProcess, runDaemonCatalogProcess } from "../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonSupervisor } from "../../src/modes/daemon/daemon-supervisor.js";
import { acquireDaemonSupervisorOwnership } from "../../src/modes/daemon/daemon-supervisor-ownership.js";

type ControlMessage = { type: "go" | "probe" | "release" | "release_runtime" | "shutdown" | "cleanup" };

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing ${name}`);
	}
	return value;
}

function send(message: Record<string, unknown>): void {
	process.send?.(message);
}

function exitFixture(code: number): never {
	process.exitCode = code;
	if (process.connected) process.disconnect();
	const reallyExit = (process as NodeJS.Process & { reallyExit?: (exitCode?: number) => never }).reallyExit;
	if (reallyExit) return reallyExit.call(process, code);
	process.exit(code);
}

function sendAndExit(message: Record<string, unknown>, code: number): void {
	send(message);
	setTimeout(() => exitFixture(code), 10);
}

const pendingControls = new Map<ControlMessage["type"], Array<() => void>>();
const controlBacklog: ControlMessage["type"][] = [];

process.on("message", (message: unknown) => {
	if (!message || typeof message !== "object" || typeof (message as Partial<ControlMessage>).type !== "string") {
		return;
	}
	const type = (message as ControlMessage).type;
	const waiters = pendingControls.get(type);
	const waiter = waiters?.shift();
	if (waiter) waiter();
	else controlBacklog.push(type);
});

function waitForControl(type: ControlMessage["type"]): Promise<void> {
	const queuedIndex = controlBacklog.indexOf(type);
	if (queuedIndex !== -1) {
		controlBacklog.splice(queuedIndex, 1);
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const waiters = pendingControls.get(type) ?? [];
		waiters.push(resolve);
		pendingControls.set(type, waiters);
	});
}

async function runOwnershipHolder(): Promise<never> {
	const ownership = await acquireDaemonSupervisorOwnership({
		socketPath: requiredEnvironment("ENG_4600_SOCKET_PATH"),
		descriptorDir: requiredEnvironment("ENG_4600_DESCRIPTOR_DIR"),
		agentDir: requiredEnvironment("ENG_4600_AGENT_DIR"),
		generation: requiredEnvironment("ENG_4600_GENERATION"),
		appVersion: "test",
		registryDir: requiredEnvironment("ENG_4600_REGISTRY_DIR"),
	});
	send({ type: "ready", owner: ownership.record });
	await waitForControl("release");
	await ownership.release();
	send({ type: "owner_released" });
	await waitForControl("shutdown");
	exitFixture(0);
}

async function runSupervisor(): Promise<never> {
	process.argv[1] = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
	process.title = APP_NAME;
	const socketPath = requiredEnvironment("ENG_4600_SOCKET_PATH");
	const agentDir = requiredEnvironment("ENG_4600_AGENT_DIR");
	const descriptorDir = requiredEnvironment("ENG_4600_DESCRIPTOR_DIR");
	const supervisor = new DaemonSupervisor(socketPath, {
		descriptorDir,
		defaultSessionConfig: {
			agentDir,
			cwd: agentDir,
			noContextFiles: true,
			noExtensions: true,
			noSkills: true,
			noTools: true,
		},
	});
	try {
		await supervisor.start();
		send({ type: "ready" });
		process.on("message", (message: unknown) => {
			if (
				!message ||
				typeof message !== "object" ||
				(message as Partial<ControlMessage>).type !== "release_runtime"
			) {
				return;
			}
			void releaseSupervisorRuntime(supervisor);
		});
		return await new Promise<never>(() => {});
	} catch (error) {
		sendAndExit({ type: "failed", error: error instanceof Error ? error.message : String(error) }, 0);
		return await new Promise<never>(() => {});
	}
}

async function releaseSupervisorRuntime(supervisor: DaemonSupervisor): Promise<void> {
	const ownership = Reflect.get(supervisor, "ownership") as { release: () => Promise<void> } | undefined;
	await ownership?.release();
	Reflect.set(supervisor, "ownership", undefined);
	const cleanupSocket = Reflect.get(supervisor, "cleanupSocket");
	if (typeof cleanupSocket === "function") {
		Reflect.apply(cleanupSocket, supervisor, []);
	}
	const lease = Reflect.get(supervisor, "socketLease") as { release: () => Promise<void> } | undefined;
	await lease?.release();
	Reflect.set(supervisor, "socketLease", undefined);
	send({ type: "runtime_released" });
}

async function runLegacyCleanup(): Promise<never> {
	const socketPath = requiredEnvironment("ENG_4600_SOCKET_PATH");
	send({ type: "ready" });
	await waitForControl("cleanup");
	let skipped = false;
	// This lock/unlink sequence is frozen from the v0.3.0 daemon socket cleanup.
	if (process.platform !== "win32") {
		let releaseLock: (() => void) | undefined;
		try {
			releaseLock = lockfile.lockSync(socketPath, {
				realpath: false,
				stale: 5000,
				update: 1000,
				retries: 0,
			});
		} catch {
			skipped = true;
		}
		if (releaseLock) {
			try {
				if (existsSync(socketPath)) {
					unlinkSync(socketPath);
				}
			} finally {
				releaseLock();
			}
		}
	}
	sendAndExit({ type: "cleanup_complete", skipped }, 0);
	return await new Promise<never>(() => {});
}

async function main(): Promise<never> {
	if (isDaemonCatalogProcess()) {
		return runDaemonCatalogProcess();
	}
	send({ type: "booted" });
	process.on("message", (message: unknown) => {
		if (message && typeof message === "object" && (message as Partial<ControlMessage>).type === "probe") {
			send({ type: "probe_ack" });
		}
	});
	const mode = requiredEnvironment("ENG_4600_FIXTURE_MODE");
	if (mode === "legacy_cleanup") {
		return runLegacyCleanup();
	}
	await waitForControl("go");
	if (mode === "owner") {
		return runOwnershipHolder();
	}
	if (mode === "supervisor") {
		return runSupervisor();
	}
	throw new Error(`Unknown fixture mode: ${mode}`);
}

void main().catch((error) => {
	sendAndExit({ type: "failed", error: error instanceof Error ? error.message : String(error) }, 1);
});
