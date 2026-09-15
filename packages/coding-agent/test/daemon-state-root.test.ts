import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDaemonSocketDir } from "../src/modes/daemon/daemon-socket.js";
import {
	createDaemonStateRootMatcher,
	currentDaemonStateRoot,
	type DaemonStateRoot,
} from "../src/modes/daemon/daemon-state-root.js";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";

const registryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousRegistryDirEnv = process.env[registryDirEnv];
const cleanupDirs: string[] = [];
const releaseOwnerships: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (releaseOwnerships.length > 0) {
		await releaseOwnerships.pop()?.();
	}
	if (previousRegistryDirEnv === undefined) {
		delete process.env[registryDirEnv];
	} else {
		process.env[registryDirEnv] = previousRegistryDirEnv;
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createRoot(): { root: DaemonStateRoot; base: string; registryDir: string } {
	const base = mkdtempSync(join(tmpdir(), "state-root-"));
	cleanupDirs.push(base);
	const agentDir = join(base, "agent");
	const socketDir = join(base, "sockets");
	const registryDir = join(base, "registry");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(socketDir, { recursive: true });
	process.env[registryDirEnv] = registryDir;
	return {
		base,
		registryDir,
		root: { agentDir, socketDir, defaultSocketPath: join(socketDir, "daemon.sock") },
	};
}

async function registerDaemon(
	registryDir: string,
	agentDir: string,
	socketPath: string,
	generation: string,
): Promise<void> {
	const ownership = await acquireDaemonSupervisorOwnership({
		agentDir,
		appVersion: "test",
		descriptorDir: join(agentDir, "workers", generation),
		generation,
		registryDir,
		socketPath,
	});
	releaseOwnerships.push(() => ownership.release());
}

describe.runIf(process.platform !== "win32")("daemon state root scoping", () => {
	it("claims sockets in our own socket dir", () => {
		const { root } = createRoot();
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(root.socketDir, "daemon.sock"))).toBe(true);
		expect(belongsToStateRoot(join(root.socketDir, "worker-abc.sock"))).toBe(true);
	});

	// The OS sweep reports the spelling each daemon bound, which can be a
	// symlink alias of our own TMPDIR spelling while naming the same directory
	// (macOS /var against /private/var). Such a listener must stay in scope or
	// `shutdown --force` drops it from the residual and hidden-supervisor
	// cleanup and its daemon keeps running.
	it("claims a listener reported through a symlink alias of our socket dir", () => {
		const { root, base } = createRoot();
		const aliasDir = join(base, "socket-alias");
		symlinkSync(root.socketDir, aliasDir);
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(aliasDir, "daemon.sock"))).toBe(true);
		expect(belongsToStateRoot(join(aliasDir, "worker-abc.sock"))).toBe(true);
	});

	it("claims a canonical listener when our socket dir is spelled through a symlink alias", () => {
		const { root, base } = createRoot();
		const aliasDir = join(base, "socket-alias");
		symlinkSync(root.socketDir, aliasDir);
		const belongsToStateRoot = createDaemonStateRootMatcher({
			agentDir: root.agentDir,
			socketDir: aliasDir,
			defaultSocketPath: join(aliasDir, "daemon.sock"),
		});
		expect(belongsToStateRoot(join(root.socketDir, "daemon.sock"))).toBe(true);
	});

	it("claims a custom socket path registered under our agent dir", async () => {
		const { root, base, registryDir } = createRoot();
		const customSocket = join(base, "custom.sock");
		await registerDaemon(registryDir, root.agentDir, customSocket, "ours");
		expect(createDaemonStateRootMatcher(root)(customSocket)).toBe(true);
	});

	it("disowns a daemon registered under a different agent dir", async () => {
		const { root, base, registryDir } = createRoot();
		const otherAgentDir = join(base, "other-agent");
		const otherSocket = join(base, "other.sock");
		mkdirSync(otherAgentDir, { recursive: true });
		await registerDaemon(registryDir, otherAgentDir, otherSocket, "theirs");
		expect(createDaemonStateRootMatcher(root)(otherSocket)).toBe(false);
	});

	it("disowns an unregistered daemon outside our socket dir", () => {
		const { root, base } = createRoot();
		expect(createDaemonStateRootMatcher(root)(join(base, "stranger.sock"))).toBe(false);
	});

	// A supervisor that has handed its runtime to a successor is no longer the
	// registered owner, so only the OS socket sweep can still see it. It must stay
	// in scope or `shutdown --force` leaks it, which is the ENG-4603 regression.
	it("claims a hidden unregistered supervisor whose socket sits in our agent dir", () => {
		const { root } = createRoot();
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(root.agentDir, "daemon.sock"))).toBe(true);
		expect(belongsToStateRoot(join(root.agentDir, "nested", "worker-command.sock"))).toBe(true);
	});

	it("claims a hidden supervisor reported through a symlink alias of our agent dir", () => {
		const { root, base } = createRoot();
		const aliasDir = join(base, "agent-alias");
		symlinkSync(root.agentDir, aliasDir);
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(aliasDir, "daemon.sock"))).toBe(true);
		expect(belongsToStateRoot(join(aliasDir, "nested", "worker-command.sock"))).toBe(true);
	});

	it("claims a supervisor in a directory literally named '..runtime'", () => {
		const { root, base } = createRoot();
		const aliasDir = join(base, "agent-alias");
		symlinkSync(root.agentDir, aliasDir);
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(root.agentDir, "..runtime", "daemon.sock"))).toBe(true);
		expect(belongsToStateRoot(join(aliasDir, "..runtime", "daemon.sock"))).toBe(true);
	});

	it("does not mistake an agent dir with a shared name prefix for our own", () => {
		const { root, base } = createRoot();
		expect(createDaemonStateRootMatcher(root)(join(`${base}/agent-other`, "daemon.sock"))).toBe(false);
	});

	it("still disowns a listener that traverses out of our agent dir", () => {
		const { root, base } = createRoot();
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(base, "outside.sock"))).toBe(false);
		expect(belongsToStateRoot(join(base, "..", "outside.sock"))).toBe(false);
	});

	it("still disowns a listener whose symlink alias points outside our root", () => {
		const { root, base } = createRoot();
		const elsewhere = join(base, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		const aliasDir = join(base, "stranger-alias");
		symlinkSync(elsewhere, aliasDir);
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(aliasDir, "daemon.sock"))).toBe(false);
		expect(belongsToStateRoot(join(aliasDir, "nested", "worker-abc.sock"))).toBe(false);
	});

	it("still answers when the registry does not exist yet", () => {
		const { root, base } = createRoot();
		rmSync(root.socketDir, { recursive: true, force: true });
		const belongsToStateRoot = createDaemonStateRootMatcher(root);
		expect(belongsToStateRoot(join(root.socketDir, "daemon.sock"))).toBe(true);
		expect(belongsToStateRoot(join(base, "stranger.sock"))).toBe(false);
	});

	it("follows the environment instead of a value captured at import time", () => {
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		const base = mkdtempSync(join(tmpdir(), "state-root-env-"));
		cleanupDirs.push(base);
		process.env.PRIME_AGENT_CODING_AGENT_DIR = join(base, "agent");
		try {
			const root = currentDaemonStateRoot();
			expect(root.agentDir).toBe(join(base, "agent"));
			expect(root.socketDir).toBe(defaultDaemonSocketDir());
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});
});
