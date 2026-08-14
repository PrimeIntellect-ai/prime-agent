import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import {
	RLM_LEDGER_MAX_BYTES,
	RLM_LEDGER_MAX_RECORDS,
	type RlmLedgerDeleteReason,
	RlmSpawnLedger,
	rlmLedgerPath,
} from "../src/modes/daemon/rlm-ledger.js";

function makeRoots(root: string) {
	const sessionsDir = join(root, "sessions");
	const parent = SessionManager.create(root, sessionsDir);
	parent.newSession();
	parent.appendSessionInfo("parent");
	parent.flushNow();
	const parentFile = parent.getSessionFile();
	if (!parentFile) throw new Error("Missing parent session file");
	return { sessionsDir, parent, parentFile };
}

function makeChildSession(root: string, dir: string, parentFile: string, depth: number, name: string) {
	const manager = SessionManager.create(root, dir);
	manager.newSession({ parentSession: parentFile, rlmDepth: depth });
	manager.appendSessionInfo(name);
	manager.flushNow();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing child session file");
	return { manager, file };
}

describe("rlm spawn ledger", () => {
	it("replays spawn, rename, and delete records last-writer-wins", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-"));
		try {
			const { sessionsDir, parentFile } = makeRoots(root);
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: join(root, "a.jsonl"),
				depth: 1,
				name: "worker-a",
			});
			await ledger.appendSpawn({
				childId: "sub-22222222",
				parent: parentFile,
				child: join(root, "b.jsonl"),
				depth: 1,
				name: "worker-b",
			});
			await ledger.appendRename({ childId: "sub-22222222", child: join(root, "b.jsonl"), name: "renamed-b" });
			await ledger.appendDelete({ childId: "sub-11111111", child: join(root, "a.jsonl"), reason: "revoked" });

			const edges = await ledger.edges();
			expect(edges).toEqual([expect.objectContaining({ childId: "sub-22222222", name: "renamed-b", depth: 1 })]);
			const lines = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n");
			expect(JSON.parse(lines[0])).toMatchObject({ v: 1, op: "meta", sessionsDir: resolve(sessionsDir) });
			expect(JSON.parse(lines[4])).toMatchObject({ v: 1, op: "delete", reason: "revoked" });
			expect(statSync(ledger.ledgerPath).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(ledger.ledgerPath)).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a duplicate canonical child path at append", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-dup-"));
		try {
			const { sessionsDir, parentFile } = makeRoots(root);
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			const child = join(root, "child.jsonl");
			await ledger.appendSpawn({ childId: "sub-11111111", parent: parentFile, child, depth: 1, name: "a" });
			await expect(
				ledger.appendSpawn({ childId: "sub-22222222", parent: parentFile, child, depth: 1, name: "b" }),
			).rejects.toThrow("duplicate child session path");
			// Same childId re-recording the same path is an update, not a duplicate.
			await ledger.appendSpawn({ childId: "sub-11111111", parent: parentFile, child, depth: 1, name: "a2" });
			// A deleted edge releases its path.
			await ledger.appendDelete({ childId: "sub-11111111", child, reason: "user" });
			await ledger.appendSpawn({ childId: "sub-33333333", parent: parentFile, child, depth: 1, name: "c" });
			expect(await ledger.edges()).toEqual([expect.objectContaining({ childId: "sub-33333333", name: "c" })]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a malformed ledger line", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-malformed-"));
		try {
			const { sessionsDir, parentFile } = makeRoots(root);
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: join(root, "a.jsonl"),
				depth: 1,
				name: "a",
			});
			writeFileSync(ledger.ledgerPath, `${readFileSync(ledger.ledgerPath, "utf8")}not json\n`);
			await expect(ledger.edges()).rejects.toThrow("Malformed RLM ledger line");
			const fresh = new RlmSpawnLedger(root, sessionsDir);
			writeFileSync(
				fresh.ledgerPath,
				`${JSON.stringify({ v: 1, op: "spawn", at: "x", childId: "sub-1", child: "/c", depth: 0, name: "n", parent: "/p" })}\n`,
			);
			await expect(fresh.edges()).rejects.toThrow("invalid spawn record");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on byte and record bounds", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-bounds-"));
		try {
			const { sessionsDir } = makeRoots(root);
			const oversized = new RlmSpawnLedger(root, sessionsDir);
			mkdirSync(dirname(oversized.ledgerPath), { recursive: true });
			writeFileSync(oversized.ledgerPath, Buffer.alloc(RLM_LEDGER_MAX_BYTES + 1, "\n"));
			await expect(oversized.edges()).rejects.toThrow("bytes");

			const record = `${JSON.stringify({ v: 1, op: "rename", at: "x", childId: "sub-1", child: "/c", name: "n" })}\n`;
			writeFileSync(oversized.ledgerPath, record.repeat(RLM_LEDGER_MAX_RECORDS + 1));
			await expect(new RlmSpawnLedger(root, sessionsDir).edges()).rejects.toThrow("records");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("builds families from roots plus live edges and drops dead entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-family-"));
		try {
			const { sessionsDir, parent, parentFile } = makeRoots(root);
			const other = SessionManager.create(root, sessionsDir);
			other.newSession();
			other.appendSessionInfo("other-root");
			other.flushNow();
			const artifactDir = parent.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing artifact dir");
			const child = makeChildSession(root, join(artifactDir, "sub-11111111"), parentFile, 1, "worker");
			const grandchild = makeChildSession(root, join(artifactDir, "sub-22222222"), child.file, 2, "nested");

			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: child.file,
				depth: 1,
				name: "worker",
			});
			await ledger.appendSpawn({
				childId: "sub-22222222",
				parent: child.file,
				child: grandchild.file,
				depth: 2,
				name: "nested",
			});
			await ledger.appendSpawn({
				childId: "sub-33333333",
				parent: parentFile,
				child: join(artifactDir, "sub-33333333", "gone.jsonl"),
				depth: 1,
				name: "vanished",
			});
			await ledger.appendRename({ childId: "sub-11111111", child: child.file, name: "renamed-worker" });

			const family = await ledger.family();
			expect(family.map((row) => [row.name, row.rlmDepth])).toEqual([
				["parent", 0],
				["other-root", 0],
				["renamed-worker", 1],
				["nested", 2],
			]);
			const childRow = family.find((row) => row.name === "renamed-worker");
			expect(childRow?.parentSessionPath).toBe(resolve(parentFile));
			expect(family.some((row) => row.name === "vanished")).toBe(false);

			const siblings = await ledger.siblings(child.file);
			expect(siblings.map((row) => row.name)).toEqual(["renamed-worker"]);
			const rootSiblings = await ledger.siblings(parentFile);
			expect(rootSiblings.map((row) => row.name)).toEqual(["parent", "other-root"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on a depth contradiction between parent and child edges", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-depth-"));
		try {
			const { sessionsDir, parent, parentFile } = makeRoots(root);
			const artifactDir = parent.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing artifact dir");
			const child = makeChildSession(root, join(artifactDir, "sub-11111111"), parentFile, 1, "worker");
			const grandchild = makeChildSession(root, join(artifactDir, "sub-22222222"), child.file, 2, "nested");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: child.file,
				depth: 1,
				name: "worker",
			});
			await ledger.appendSpawn({
				childId: "sub-22222222",
				parent: child.file,
				child: grandchild.file,
				depth: 3,
				name: "nested",
			});
			await expect(ledger.family()).rejects.toThrow("contradictory depth");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function makeDaemonFixture(tempDir: string) {
	const sessionsDir = join(tempDir, "sessions");
	const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
		session: makeRuntimeSession(options.sessionManager),
		extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
			ReturnType<CreateAgentSessionRuntimeFactory>
		>["extensionsResult"],
		services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
			ReturnType<CreateAgentSessionRuntimeFactory>
		>["services"],
		diagnostics: [],
	}));
	const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
		defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: sessionsDir },
		createRuntime,
	});
	const internals = daemon as unknown as {
		sessions: Map<string, ActiveSessionState>;
		createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
		createRlmSubagentRuntime(
			parentState: ActiveSessionState,
			options: CreateRlmSubagentRuntimeOptions,
		): Promise<ActiveSessionState["runtime"]>;
		createSubagentRuntimeHost(parentState: ActiveSessionState): SubagentRuntimeHost;
		recordRlmSubagentDeletion(
			parentState: ActiveSessionState,
			childId: string,
			reason?: RlmLedgerDeleteReason,
		): Promise<void>;
		setStateSessionName(state: ActiveSessionState, name: string): Promise<void>;
		rlmSpawnLedger(): RlmSpawnLedger;
		rlmLedgerFamily(): Promise<Array<{ name?: string; rlmDepth: number; path: string }>>;
		rlmLedgerSiblings(sessionPath: string): Promise<Array<{ name?: string; rlmDepth: number }>>;
	};
	return { daemon, internals, sessionsDir };
}

function makeRuntimeSession(
	sessionManager: Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionManager"],
): Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"] {
	return {
		sessionManager,
		messages: [],
		extensionRunner: { hasHandlers: vi.fn(() => false), emit: vi.fn(async () => {}) },
		sessionFile: sessionManager.getSessionFile(),
		sessionId: sessionManager.getSessionId(),
		get sessionName() {
			return sessionManager.getSessionName();
		},
		rlmDepth: sessionManager.getHeader()?.rlmDepth ?? 0,
		setSubagentRuntimeHost: vi.fn(),
		getRlmChildRunStatus: vi.fn(() => "running"),
		registerRlmChildSession: vi.fn(() => true),
		releaseRlmChildSession: vi.fn(() => vi.fn()),
		subscribe: vi.fn(() => vi.fn()),
		bindExtensions: vi.fn(async () => {}),
		setExecEnvProvider: vi.fn(),
		getAvailableThinkingLevels: vi.fn(() => []),
		scopedModels: [],
		getActiveToolNames: vi.fn(() => []),
		getContextUsage: vi.fn(() => undefined),
		setSessionName: vi.fn((name: string) => sessionManager.appendSessionInfo(name)),
		dispose: vi.fn(),
		disposeAsync: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	} as unknown as Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"];
}

function subagentRuntimeOptions(
	parentState: ActiveSessionState,
	overrides: Partial<CreateRlmSubagentRuntimeOptions> & Pick<CreateRlmSubagentRuntimeOptions, "id" | "sessionDir">,
): CreateRlmSubagentRuntimeOptions {
	return {
		parentSession: parentState.runtime.session,
		prompt: "do the work",
		sessionName: overrides.id,
		model: { provider: "test", id: "model" } as Model<Api>,
		thinkingLevel: "off",
		serviceTier: null,
		scopedModels: [],
		activeToolNames: [],
		customTools: [],
		includeGoals: false,
		includeCompactSkill: false,
		rlmDepth: 1,
		rlmMaxDepth: 4,
		rlmParentNodeId: overrides.id,
		...overrides,
	};
}

describe("rlm spawn ledger daemon wiring", () => {
	it("appends spawn at admission, rename at the rename write point, and delete with a reason", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-wiring-"));
		try {
			const { internals, sessionsDir } = makeDaemonFixture(tempDir);
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			const parentFile = parentManager.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");
			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentFile });
			const childDir = join(parentManager.getSessionArtifactDir()!, "sub-1234abcd");
			const childRuntime = await internals.createRlmSubagentRuntime(
				parentState,
				subagentRuntimeOptions(parentState, {
					id: "sub-1234abcd",
					sessionName: "spawned-worker",
					sessionDir: childDir,
				}),
			);
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.session === childRuntime.session,
			);
			if (!childState?.runtime.session.sessionFile) throw new Error("Missing child state");

			const ledger = internals.rlmSpawnLedger();
			await expect(ledger.edges()).resolves.toEqual([
				expect.objectContaining({
					childId: "sub-1234abcd",
					parent: resolve(parentFile),
					child: resolve(childState.runtime.session.sessionFile),
					depth: 1,
					name: "spawned-worker",
				}),
			]);

			await internals.setStateSessionName(childState, "renamed-worker");
			await expect(ledger.edges()).resolves.toEqual([expect.objectContaining({ name: "renamed-worker" })]);

			await internals.recordRlmSubagentDeletion(parentState, "sub-1234abcd", "revoked");
			await expect(ledger.edges()).resolves.toEqual([]);
			const lines = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n");
			expect(JSON.parse(lines.at(-1)!)).toMatchObject({ op: "delete", reason: "revoked" });
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("seeds a missing ledger lazily from real-shaped registries, memoized", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-seed-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentFile || !parentArtifactDir) throw new Error("Missing parent session paths");
			// A fork root: header parentSession without rlmDepth. Ledger seeding
			// never consults headers, so it must appear as a plain root.
			const forkManager = SessionManager.create(tempDir, sessionsDir);
			forkManager.newSession({ parentSession: parentFile });
			forkManager.appendSessionInfo("forked-root");
			forkManager.flushNow();

			const childDir = join(parentArtifactDir, "sub-1234abcd");
			const child = makeChildSession(tempDir, childDir, parentFile, 1, "seed-worker");
			const grandchildDir = join(childDir, "sub-deadbeef");
			const grandchild = makeChildSession(tempDir, grandchildDir, child.file, 2, "nested-worker");

			// Registry entries shaped exactly like recordRlmSubagentRegistryEntry
			// output; the legacy grandchild entry omits depth fields.
			mkdirSync(parentArtifactDir, { recursive: true });
			writeFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: "sub-1234abcd",
					sessionName: "seed-worker",
					sessionDir: childDir,
					sessionFile: child.file,
					parentSessionId: parentManager.getSessionId(),
					parentSessionFile: parentFile,
					rlmDepth: 1,
					rlmMaxDepth: 4,
					rlmParentNodeId: "sub-1234abcd",
					prompt: "seed the worker",
					model: { provider: "test", modelId: "model" },
					status: "completed",
					createdAt: 1,
					updatedAt: "2026-01-01T00:00:00.000Z",
				})}\n`,
			);
			const childArtifactDir = child.manager.getSessionArtifactDir();
			if (!childArtifactDir) throw new Error("Missing child artifact dir");
			mkdirSync(childArtifactDir, { recursive: true });
			writeFileSync(
				join(childArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: "sub-deadbeef",
					sessionName: "nested-worker",
					sessionDir: grandchildDir,
					sessionFile: grandchild.file,
					parentSessionId: child.manager.getSessionId(),
					parentSessionFile: child.file,
					status: "completed",
					createdAt: 2,
					updatedAt: "2026-01-01T00:00:01.000Z",
				})}\n`,
			);

			const { internals } = makeDaemonFixture(tempDir);
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(false);
			const family = await internals.rlmLedgerFamily();
			expect(family.map((row) => [row.name, row.rlmDepth])).toEqual(
				expect.arrayContaining([
					["parent", 0],
					["forked-root", 0],
					["seed-worker", 1],
					["nested-worker", 2],
				]),
			);
			expect(family).toHaveLength(4);
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(true);

			// Memoized: the seeded ledger, not the registries, is the source now.
			rmSync(join(parentArtifactDir, "rlm-subagents.jsonl"));
			const again = await internals.rlmLedgerFamily();
			expect(again.map((row) => row.name)).toEqual(expect.arrayContaining(["seed-worker", "nested-worker"]));

			const siblings = await internals.rlmLedgerSiblings(child.file);
			expect(siblings.map((row) => row.name)).toEqual(["seed-worker"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("degrades to a flat family when seeding fails instead of failing closed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-seedfail-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");
			const failures: string[] = [];
			const ledger = new RlmSpawnLedger(
				tempDir,
				sessionsDir,
				{
					readRegistryForSessionFile: async () => {
						throw new Error("registry exploded");
					},
				},
				(message) => failures.push(message),
			);
			const family = await ledger.family();
			expect(family.map((row) => [row.name, row.rlmDepth])).toEqual([["parent", 0]]);
			expect(failures.some((message) => message.includes("registry exploded"))).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
