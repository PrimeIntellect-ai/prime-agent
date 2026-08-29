import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const linkFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: (
			existingPath: Parameters<typeof actual.linkSync>[0],
			newPath: Parameters<typeof actual.linkSync>[1],
		) => {
			if (linkFailure.code) {
				const error = new Error(`simulated link failure ${linkFailure.code}`) as NodeJS.ErrnoException;
				error.code = linkFailure.code;
				throw error;
			}
			return actual.linkSync(existingPath, newPath);
		},
	};
});

import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	RLM_LEDGER_MAX_BYTES,
	RLM_LEDGER_MAX_RECORDS,
	type RlmLedgerDeleteReason,
	RlmSpawnLedger,
	readLegacyRlmSubagentRegistry,
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
			expect(JSON.parse(lines[0])).toMatchObject({ v: 1, op: "meta", sessionsDir: realpathSync(sessionsDir) });
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

	it("tolerates one torn final line without a trailing newline, but not mid-file", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-torn-"));
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
			const intact = readFileSync(ledger.ledgerPath, "utf8");
			// A crashed writer's torn final append (no trailing newline) is
			// in-progress data: ignored with a log, not fail-closed.
			writeFileSync(ledger.ledgerPath, `${intact}{"v":1,"op":"spawn","at":"2026-`);
			const logged: string[] = [];
			const torn = new RlmSpawnLedger(root, sessionsDir, undefined, (message) => logged.push(message));
			await expect(torn.edges()).resolves.toEqual([expect.objectContaining({ childId: "sub-11111111" })]);
			expect(logged.some((message) => message.includes("torn final line"))).toBe(true);
			// The next append repairs the torn tail with a newline first.
			await torn.appendSpawn({
				childId: "sub-22222222",
				parent: parentFile,
				child: join(root, "b.jsonl"),
				depth: 1,
				name: "b",
			});
			await expect(new RlmSpawnLedger(root, sessionsDir).edges()).resolves.toHaveLength(2);
			// The same content mid-file (trailing newline present) stays fail-closed.
			writeFileSync(ledger.ledgerPath, `${intact}{"v":1,"op":"spawn","at":"2026-\n`);
			await expect(new RlmSpawnLedger(root, sessionsDir).edges()).rejects.toThrow("Malformed RLM ledger line");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs a torn tail by byte offset, preserving preceding multi-byte UTF-8 records", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-utf8-torn-"));
		try {
			const { sessionsDir, parentFile } = makeRoots(root);
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			// Multi-byte UTF-8 in the name makes string indices diverge from
			// byte offsets; the truncate must not cut into this record.
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: join(root, "a.jsonl"),
				depth: 1,
				name: "wörker-💥-ümlaut",
			});
			writeFileSync(ledger.ledgerPath, `${readFileSync(ledger.ledgerPath, "utf8")}{"v":1,"op":"spawn","torn`);
			const repairing = new RlmSpawnLedger(root, sessionsDir);
			await repairing.appendSpawn({
				childId: "sub-22222222",
				parent: parentFile,
				child: join(root, "b.jsonl"),
				depth: 1,
				name: "second",
			});
			await expect(new RlmSpawnLedger(root, sessionsDir).edges()).resolves.toEqual([
				expect.objectContaining({ childId: "sub-11111111", name: "wörker-💥-ümlaut" }),
				expect.objectContaining({ childId: "sub-22222222", name: "second" }),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips v1 records with unknown ops instead of failing the whole ledger", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-forward-"));
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
			writeFileSync(
				ledger.ledgerPath,
				`${readFileSync(ledger.ledgerPath, "utf8")}${JSON.stringify({ v: 1, op: "future-op", at: "2026-01-01T00:00:00.000Z" })}\n`,
			);
			const logged: string[] = [];
			const reader = new RlmSpawnLedger(root, sessionsDir, undefined, (message) => logged.push(message));
			await expect(reader.edges()).resolves.toEqual([expect.objectContaining({ childId: "sub-11111111" })]);
			expect(logged.some((message) => message.includes("unknown op"))).toBe(true);
			// A future major version still fails loudly.
			writeFileSync(
				ledger.ledgerPath,
				`${readFileSync(ledger.ledgerPath, "utf8")}${JSON.stringify({ v: 2, op: "spawn", at: "2026-01-01T00:00:00.000Z" })}\n`,
			);
			await expect(new RlmSpawnLedger(root, sessionsDir).edges()).rejects.toThrow("missing v/at");
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

			// The torn-tail repair path must hit the same bound before any
			// file-sized allocation, not just replaySync.
			await expect(
				new RlmSpawnLedger(root, sessionsDir).appendRename({ childId: "sub-1", child: "/c", name: "n" }),
			).rejects.toThrow("bytes");

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
			expect(childRow?.parentSessionPath).toBe(canonicalSessionPath(parentFile));
			expect(family.some((row) => row.name === "vanished")).toBe(false);

			const siblings = await ledger.siblings(child.file);
			expect(siblings.map((row) => row.name)).toEqual(["renamed-worker"]);
			const rootSiblings = await ledger.siblings(parentFile);
			expect(rootSiblings.map((row) => row.name)).toEqual(["parent", "other-root"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops a depth-contradictory edge without failing the rest of the family", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-depth-"));
		try {
			const { sessionsDir, parent, parentFile } = makeRoots(root);
			const artifactDir = parent.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing artifact dir");
			const child = makeChildSession(root, join(artifactDir, "sub-11111111"), parentFile, 1, "worker");
			const grandchild = makeChildSession(root, join(artifactDir, "sub-22222222"), child.file, 2, "nested");
			const logged: string[] = [];
			const ledger = new RlmSpawnLedger(root, sessionsDir, undefined, (message) => logged.push(message));
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
			const family = await ledger.family();
			expect(family.map((row) => row.name)).toEqual(["parent", "worker"]);
			expect(logged.some((message) => message.includes("contradictory depth"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("never passes header-claimed topology through for roots (fork headers)", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-fork-root-"));
		try {
			const { sessionsDir, parentFile } = makeRoots(root);
			// A fork: header carries parentSession, so readSessionInfo reports a
			// parentSessionPath — writer-owned topology the ledger must strip.
			const fork = SessionManager.forkFrom(parentFile, root, sessionsDir);
			fork.appendSessionInfo("forked-root");
			fork.flushNow();
			const forkFile = fork.getSessionFile();
			if (!forkFile) throw new Error("Missing fork session file");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			const family = await ledger.family();
			const forkRow = family.find((row) => row.name === "forked-root");
			expect(forkRow).toBeDefined();
			expect(forkRow?.rlmDepth).toBe(0);
			expect(forkRow?.parentSessionPath).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns the surviving child alone when its parent file is gone", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-orphan-"));
		try {
			const { sessionsDir, parent, parentFile } = makeRoots(root);
			const artifactDir = parent.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing artifact dir");
			const child = makeChildSession(root, join(artifactDir, "sub-11111111"), parentFile, 1, "survivor");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: child.file,
				depth: 1,
				name: "survivor",
			});
			rmSync(parentFile);

			// The edge is reconciliation-dropped, but the child file exists: it
			// must come back as a lone root-shaped row, not vanish entirely.
			const siblings = await ledger.siblings(child.file);
			expect(siblings).toEqual([
				expect.objectContaining({ path: canonicalSessionPath(child.file), name: "survivor", rlmDepth: 0 }),
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("presents roots at their own depth without asserting depth-0 against nested-daemon edges", async () => {
		// A nested daemon's sessions dir has roots that legitimately carry
		// env-derived depths > 0: an edge at depth 3 whose parent is a root must
		// not be dropped against an assumed root depth of 0.
		const root = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-nested-root-"));
		try {
			const { sessionsDir, parent, parentFile } = makeRoots(root);
			const artifactDir = parent.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing artifact dir");
			const child = makeChildSession(root, join(artifactDir, "sub-11111111"), parentFile, 3, "deep-worker");
			const ledger = new RlmSpawnLedger(root, sessionsDir);
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: child.file,
				depth: 3,
				name: "deep-worker",
			});
			const family = await ledger.family();
			expect(family.map((row) => [row.name, row.rlmDepth])).toEqual([
				["parent", 0],
				["deep-worker", 3],
			]);
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
					parent: canonicalSessionPath(parentFile),
					child: canonicalSessionPath(childState.runtime.session.sessionFile),
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

			// Self-heal: with the registry already tombstoned, a live ledger edge
			// (a delete lost to a crash) is finished off by a retried deletion.
			await ledger.appendSpawn({
				childId: "sub-1234abcd",
				parent: parentFile,
				child: childState.runtime.session.sessionFile,
				depth: 1,
				name: "spawned-worker",
			});
			await expect(ledger.edges()).resolves.toHaveLength(1);
			await internals.recordRlmSubagentDeletion(parentState, "sub-1234abcd", "gc");
			await expect(ledger.edges()).resolves.toEqual([]);
			const healed = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n");
			expect(JSON.parse(healed.at(-1)!)).toMatchObject({ op: "delete", reason: "gc" });
			// A second retry with no live edge appends nothing further.
			await internals.recordRlmSubagentDeletion(parentState, "sub-1234abcd", "gc");
			expect(readFileSync(ledger.ledgerPath, "utf8").trim().split("\n")).toHaveLength(healed.length);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails admission when the spawn record cannot be made durable", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-spawn-fail-"));
		try {
			const { internals, sessionsDir } = makeDaemonFixture(tempDir);
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			const parentFile = parentManager.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");
			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentFile });
			const ledger = internals.rlmSpawnLedger();
			const failingAppend = vi.spyOn(ledger, "appendSpawn").mockRejectedValue(new Error("ledger disk exploded"));
			const childDir = join(parentManager.getSessionArtifactDir()!, "sub-badbadba");

			await expect(
				internals.createRlmSubagentRuntime(
					parentState,
					subagentRuntimeOptions(parentState, { id: "sub-badbadba", sessionDir: childDir }),
				),
			).rejects.toThrow("Failed to record RLM subagent spawn for sub-badbadba");
			// No ghost resident session and no display file claiming a running
			// child the ledger cannot see.
			expect(
				[...internals.sessions.values()].some((state) => state.runtime.metadata.rlmChildId === "sub-badbadba"),
			).toBe(false);
			expect(existsSync(join(childDir, "rlm-subagent.json"))).toBe(false);

			// The same spawn succeeds once the append works again.
			failingAppend.mockRestore();
			const retryDir = join(parentManager.getSessionArtifactDir()!, "sub-a11a11a1");
			await internals.createRlmSubagentRuntime(
				parentState,
				subagentRuntimeOptions(parentState, { id: "sub-a11a11a1", sessionDir: retryDir }),
			);
			await expect(ledger.edges()).resolves.toEqual([expect.objectContaining({ childId: "sub-a11a11a1" })]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records an offline saved-session rename by child path", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-offline-rename-"));
		try {
			const { internals, sessionsDir } = makeDaemonFixture(tempDir);
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");
			const childDir = join(parentManager.getSessionArtifactDir()!, "sub-1234abcd");
			const child = makeChildSession(tempDir, childDir, parentFile, 1, "before-rename");
			const ledger = internals.rlmSpawnLedger();
			await ledger.appendSpawn({
				childId: "sub-1234abcd",
				parent: parentFile,
				child: child.file,
				depth: 1,
				name: "before-rename",
			});

			await ledger.appendRenameByChildPath(child.file, "after-rename");
			await expect(ledger.edges()).resolves.toEqual([expect.objectContaining({ name: "after-rename" })]);
			// An unknown path renames nothing and does not throw.
			await ledger.appendRenameByChildPath(join(tempDir, "unknown.jsonl"), "nobody");
			await expect(ledger.edges()).resolves.toEqual([expect.objectContaining({ name: "after-rename" })]);
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

			const zeroDepthDir = join(parentArtifactDir, "sub-0depth00");
			const zeroDepth = makeChildSession(tempDir, zeroDepthDir, parentFile, 1, "zero-depth-worker");

			// Registry entries shaped exactly like recordRlmSubagentRegistryEntry
			// output. The seed-worker appears twice (running then completed) as
			// the real writer produces; the zero-depth entry carries a legacy
			// rlmDepth: 0; the grandchild entry omits depth fields entirely.
			mkdirSync(parentArtifactDir, { recursive: true });
			const registryEntry = (overrides: Record<string, unknown>) => ({
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
				createdAt: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
				...overrides,
			});
			writeFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${[
					JSON.stringify(registryEntry({ status: "running" })),
					JSON.stringify(registryEntry({ status: "completed", updatedAt: "2026-01-01T00:00:02.000Z" })),
					JSON.stringify(
						registryEntry({
							childId: "sub-0depth00",
							sessionName: "zero-depth-worker",
							sessionDir: zeroDepthDir,
							sessionFile: zeroDepth.file,
							rlmDepth: 0,
							status: "completed",
						}),
					),
				].join("\n")}\n`,
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
			const family = await internals.rlmSpawnLedger().family();
			expect(family.map((row) => [row.name, row.rlmDepth])).toEqual(
				expect.arrayContaining([
					["parent", 0],
					["forked-root", 0],
					["seed-worker", 1],
					// The legacy rlmDepth: 0 registry value is unwritable under the
					// spawn invariants; the seeder derives parent depth + 1 instead.
					["zero-depth-worker", 1],
					["nested-worker", 2],
				]),
			);
			expect(family).toHaveLength(5);
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(true);

			// Memoized: the seeded ledger, not the registries, is the source now.
			rmSync(join(parentArtifactDir, "rlm-subagents.jsonl"));
			const again = await internals.rlmSpawnLedger().family();
			expect(again.map((row) => row.name)).toEqual(expect.arrayContaining(["seed-worker", "nested-worker"]));

			const siblings = await internals.rlmSpawnLedger().siblings(child.file);
			expect(siblings.map((row) => row.name).sort()).toEqual(["seed-worker", "zero-depth-worker"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a registry entry whose optional rlmMaxDepth is damaged, dropping only the field", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-damaged-maxdepth-"));
		try {
			const registryPath = join(tempDir, "rlm-subagents.jsonl");
			const entry = (childId: string, overrides: Record<string, unknown>) => ({
				type: "rlm_subagent",
				childId,
				sessionName: `${childId}-worker`,
				sessionDir: join(tempDir, childId),
				sessionFile: join(tempDir, childId, "session.jsonl"),
				status: "completed",
				rlmDepth: 1,
				rlmMaxDepth: 4,
				createdAt: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
				...overrides,
			});
			writeFileSync(
				registryPath,
				`${[
					JSON.stringify(entry("sub-11111111", {})),
					JSON.stringify(entry("sub-22222222", { rlmMaxDepth: "corrupt" })),
				].join("\n")}\n`,
			);

			const entries = await readLegacyRlmSubagentRegistry(registryPath);
			expect(entries.map((item) => item.childId).sort()).toEqual(["sub-11111111", "sub-22222222"]);
			expect(entries.find((item) => item.childId === "sub-11111111")?.rlmMaxDepth).toBe(4);
			expect(entries.find((item) => item.childId === "sub-22222222")?.rlmMaxDepth).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves no ledger file behind an interrupted seed and re-seeds completely", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-seed-crash-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentFile || !parentArtifactDir) throw new Error("Missing parent session paths");
			const child = makeChildSession(tempDir, join(parentArtifactDir, "sub-11111111"), parentFile, 1, "worker");
			const seedEntry = {
				childId: "sub-11111111",
				sessionName: "worker",
				sessionFile: child.file,
				rlmDepth: 1,
				status: "completed" as const,
			};
			let calls = 0;
			const flaky = new RlmSpawnLedger(tempDir, sessionsDir, {
				readRegistryForSessionFile: async () => {
					if (++calls === 1) throw new Error("disk exploded mid-seed");
					return [];
				},
			});
			await expect(flaky.family()).resolves.toEqual([expect.objectContaining({ name: "parent" })]);
			// The interrupted seed published nothing: no ledger file, no partial state.
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(false);

			const healthy = new RlmSpawnLedger(tempDir, sessionsDir, {
				readRegistryForSessionFile: async (sessionFile) =>
					canonicalSessionPath(sessionFile) === canonicalSessionPath(parentFile) ? [seedEntry] : [],
			});
			await expect(healthy.family()).resolves.toEqual([
				expect.objectContaining({ name: "parent", rlmDepth: 0 }),
				expect.objectContaining({ name: "worker", rlmDepth: 1 }),
			]);
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("discards the seed when a live append creates the ledger during seeding", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-seed-race-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentFile || !parentArtifactDir) throw new Error("Missing parent session paths");
			const stale = makeChildSession(tempDir, join(parentArtifactDir, "sub-11111111"), parentFile, 1, "stale");
			const live = makeChildSession(tempDir, join(parentArtifactDir, "sub-22222222"), parentFile, 1, "live");
			// A second process's ledger over the same file: no seed source, so
			// its append lands directly.
			const other = new RlmSpawnLedger(tempDir, sessionsDir);
			const seeding = new RlmSpawnLedger(tempDir, sessionsDir, {
				readRegistryForSessionFile: async (sessionFile) => {
					if (canonicalSessionPath(sessionFile) !== canonicalSessionPath(parentFile)) return [];
					// Simulate the race: the live append creates the real file
					// between the seed's initial existence check and its publish.
					await other.appendSpawn({
						childId: "sub-22222222",
						parent: parentFile,
						child: live.file,
						depth: 1,
						name: "live",
					});
					return [
						{
							childId: "sub-11111111",
							sessionName: "stale",
							sessionFile: stale.file,
							rlmDepth: 1,
							status: "completed" as const,
						},
					];
				},
			});

			const family = await seeding.family();
			// The live append won; the stale seed was discarded, not clobbered over it.
			expect(family.map((row) => row.name)).toEqual(["parent", "live"]);
			const contents = readFileSync(rlmLedgerPath(tempDir, sessionsDir), "utf8");
			expect(contents).toContain("sub-22222222");
			expect(contents).not.toContain("sub-11111111");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("skips seeding entirely when the seed would exceed the read bounds", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-seed-bounds-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");
			// Few-but-huge records: 40 x ~1MiB names serialize past the 32MiB
			// byte bound without a 100k-record loop.
			const hugeName = "n".repeat(1024 * 1024);
			const entries = Array.from({ length: 40 }, (_, index) => ({
				childId: `sub-${String(index).padStart(8, "0")}`,
				sessionName: hugeName,
				sessionFile: join(tempDir, `huge-${index}.jsonl`),
				rlmDepth: 1,
				status: "completed" as const,
			}));
			const logged: string[] = [];
			const ledger = new RlmSpawnLedger(
				tempDir,
				sessionsDir,
				{
					readRegistryForSessionFile: async (sessionFile) =>
						canonicalSessionPath(sessionFile) === canonicalSessionPath(parentFile) ? entries : [],
				},
				(message) => logged.push(message),
			);
			// No ledger file published; the family degrades to flat roots.
			await expect(ledger.family()).resolves.toEqual([expect.objectContaining({ name: "parent", rlmDepth: 0 })]);
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(false);
			expect(logged.some((message) => message.includes("seed exceeds read bounds"))).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("skips seeding on filesystems without hard links instead of racing a clobber", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-seed-nolink-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentFile || !parentArtifactDir) throw new Error("Missing parent session paths");
			const child = makeChildSession(tempDir, join(parentArtifactDir, "sub-11111111"), parentFile, 1, "worker");
			const logged: string[] = [];
			const ledger = new RlmSpawnLedger(
				tempDir,
				sessionsDir,
				{
					readRegistryForSessionFile: async (sessionFile) =>
						canonicalSessionPath(sessionFile) === canonicalSessionPath(parentFile)
							? [
									{
										childId: "sub-11111111",
										sessionName: "worker",
										sessionFile: child.file,
										rlmDepth: 1,
										status: "completed" as const,
									},
								]
							: [],
				},
				(message) => logged.push(message),
			);
			linkFailure.code = "ENOTSUP";
			try {
				// No-clobber publication is unavailable: the seed is discarded and
				// pre-ledger history stays flat rather than risking a clobbered
				// live append.
				await expect(ledger.family()).resolves.toEqual([expect.objectContaining({ name: "parent", rlmDepth: 0 })]);
			} finally {
				linkFailure.code = undefined;
			}
			expect(existsSync(rlmLedgerPath(tempDir, sessionsDir))).toBe(false);
			expect(
				logged.some((message) => message.includes("link publish unavailable (ENOTSUP); skipping seeding")),
			).toBe(true);
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

interface SupervisorLedgerInternals {
	rlmSpawnLedger(): RlmSpawnLedger;
	rlmLedgerSiblings(sessionPath: string): Promise<Array<{ name?: string; rlmDepth: number; path: string }>>;
	assertSupervisorSavedSessionNameAvailable(sessionPath: string, name: string): Promise<void>;
	handleCommand(client: object, command: Record<string, unknown>): Promise<unknown>;
	catalog: object;
}

describe("rlm spawn ledger supervisor wiring", () => {
	it("reserves saved-sibling names against ledger-backed siblings", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-supervisor-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentFile || !parentArtifactDir) throw new Error("Missing parent session paths");
			const first = makeChildSession(tempDir, join(parentArtifactDir, "sub-11111111"), parentFile, 1, "first");
			const second = makeChildSession(tempDir, join(parentArtifactDir, "sub-22222222"), parentFile, 1, "second");
			const supervisor = new DaemonSupervisor(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: sessionsDir },
				descriptorDir: join(tempDir, "workers"),
			}) as unknown as SupervisorLedgerInternals;
			const ledger = supervisor.rlmSpawnLedger();
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: first.file,
				depth: 1,
				name: "first",
			});
			await ledger.appendSpawn({
				childId: "sub-22222222",
				parent: parentFile,
				child: second.file,
				depth: 1,
				name: "second",
			});

			await expect(supervisor.rlmLedgerSiblings(first.file)).resolves.toEqual([
				expect.objectContaining({ name: "first", rlmDepth: 1 }),
				expect.objectContaining({ name: "second", rlmDepth: 1 }),
			]);
			await expect(supervisor.assertSupervisorSavedSessionNameAvailable(first.file, "second")).rejects.toThrow(
				"already exists at depth 1",
			);
			await expect(
				supervisor.assertSupervisorSavedSessionNameAvailable(first.file, "unclaimed"),
			).resolves.toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("appends a ledger rename for an offline saved-session rename", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-ledger-supervisor-rename-"));
		try {
			const sessionsDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionsDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			parentManager.flushNow();
			const parentFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentFile || !parentArtifactDir) throw new Error("Missing parent session paths");
			const child = makeChildSession(tempDir, join(parentArtifactDir, "sub-11111111"), parentFile, 1, "old-name");
			const supervisor = new DaemonSupervisor(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: sessionsDir },
				descriptorDir: join(tempDir, "workers"),
			}) as unknown as SupervisorLedgerInternals;
			const rename = vi.fn(async () => {});
			Object.assign(supervisor.catalog, { rename });
			const ledger = supervisor.rlmSpawnLedger();
			await ledger.appendSpawn({
				childId: "sub-11111111",
				parent: parentFile,
				child: child.file,
				depth: 1,
				name: "old-name",
			});

			await supervisor.handleCommand(
				{},
				{ type: "rename_saved_session", sessionPath: child.file, name: "new-name" },
			);
			expect(rename).toHaveBeenCalledWith(child.file, "new-name");
			await expect(ledger.edges()).resolves.toEqual([expect.objectContaining({ name: "new-name" })]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
