import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentFamilyCatalogEntry,
	assertAgentFamilyReach,
	sessionNameReservationKey,
} from "../src/core/agent-messages.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	start(): Promise<void>;
	cleanupSupervisorResources(): Promise<void>;
	refreshWorkerSummaries(worker: WorkerFixture): Promise<void>;
	findSummaryInWorker(worker: WorkerFixture, selector: string): SessionSummary | undefined;
	createOrReuseWorker(
		clientId: string,
		command: { type: "create"; name?: string; sessionPath?: string; lifecycle?: "client_owned" },
	): Promise<WorkerFixture>;
	assertSupervisorSavedSessionNameAvailable(sessionPath: string, name: string): Promise<void>;
	assertSavedSiblingNameAvailable(
		siblings: Array<Record<string, unknown>>,
		target: Record<string, unknown>,
		name: string,
	): void;
	familyCatalogEntry(summary: SessionSummary): AgentFamilyCatalogEntry;
	handleCommand(client: object, command: Record<string, unknown>): Promise<unknown>;
}

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "ready" | "starting";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		authenticationToken: string;
		ownerClientId?: string;
		createCommand: { config: { cwd: string }; sessionPath?: string };
	};
	client: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
	return {
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function worker(workerId: string, summaries: SessionSummary[] = []): WorkerFixture {
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: `${workerId}-root-active`,
			rootSessionId: `${workerId}-root-session`,
			pid: 1,
			authenticationToken: `${workerId}-token`,
			createCommand: { config: { cwd: "/tmp/project" } },
		},
		client: {
			request: vi.fn(),
			requestWorker: vi.fn(),
		},
		summaries: new Map(summaries.map((entry) => [entry.activeSessionId ?? entry.id, entry])),
	};
}

describe("daemon supervisor passive subagent topology", () => {
	it("finds a child summary by its displayed session ID suffix", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-child-suffix-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const child = summary({
			id: "bbbb6666777788889999cccc",
			activeSessionId: "bbbb6666777788889999cccc",
			sessionId: "aaaa6666777788889999dddd",
		});
		const resident = worker("first", [child]);

		expect(supervisor.findSummaryInWorker(resident, "88889999cccc")).toBe(child);
	});

	it("rejects an explicit root name that collides with a saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "duplicate-root" }),
		).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("rejects a forked root name that collides with another saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-forked-root-name-"));
		tempDirs.push(directory);
		const sourceManager = SessionManager.create(directory, join(directory, "sessions"));
		sourceManager.newSession({ rlmDepth: 0 });
		sourceManager.flushNow();
		const sourcePath = sourceManager.getSessionFile();
		if (!sourcePath) throw new Error("Missing source session path");
		const forkedManager = SessionManager.forkFrom(sourcePath, directory, join(directory, "sessions"));
		const forkedPath = forkedManager.getSessionFile();
		if (!forkedPath) throw new Error("Missing forked session path");
		const forkedInfo = await readSessionInfo(forkedPath);
		if (!forkedInfo) throw new Error("Missing forked session info");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			catalog: {
				siblings: vi.fn(async () => [forkedInfo]),
				list: vi.fn(async () => [
					{
						id: "other-root",
						name: "duplicate-root",
						path: join(directory, "other.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
						rlmDepth: 0,
					},
				]),
			},
		});

		await expect(supervisor.assertSupervisorSavedSessionNameAvailable(forkedPath, "duplicate-root")).rejects.toThrow(
			"an agent of that name already exists at depth 0 under this parent",
		);
	});

	it("normalizes explicit root names before supervisor validation and launch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-normalized-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "  duplicate-root  " }),
		).rejects.toThrow('Agent name "duplicate-root" is unavailable');
		await expect(supervisor.createOrReuseWorker("client", { type: "create", name: "   " })).rejects.toThrow(
			"Session name cannot be empty",
		);
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("checks inactive root renames against every saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-saved-root-rename-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		const duplicatePath = join(directory, "duplicate.jsonl");
		const target = {
			id: "target",
			path: targetPath,
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		const duplicate = { ...target, id: "duplicate", path: duplicatePath, name: "taken" };
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async () => [target]),
			catalog: {
				list: vi.fn(async () => [target, duplicate]),
			},
		});

		await expect(supervisor.assertSupervisorSavedSessionNameAvailable(targetPath, "taken")).rejects.toThrow(
			"an agent of that name already exists at depth 0 under this parent",
		);
	});

	it("retains a legacy child's parent edge when its depth is unknown", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-family-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const parentPath = join(directory, "parent.jsonl");
		const child = supervisor.familyCatalogEntry(
			summary({
				id: "legacy-child-active",
				sessionId: "legacy-child",
				parentSessionPath: parentPath,
			}),
		);
		const parent = supervisor.familyCatalogEntry(
			summary({ id: "parent-active", sessionId: "parent", sessionFile: parentPath, rlmDepth: 0 }),
		);
		const unrelated = supervisor.familyCatalogEntry(
			summary({ id: "unrelated-active", sessionId: "unrelated", rlmDepth: 0 }),
		);
		const forkedRoot = supervisor.familyCatalogEntry(
			summary({
				id: "forked-root-active",
				sessionId: "forked-root",
				parentSessionPath: parentPath,
				rlmDepth: 0,
			}),
		);

		expect(child).toMatchObject({ depth: 1, parentSessionPath: parent.sessionPath });
		expect(forkedRoot).not.toHaveProperty("parentSessionPath");
		expect(() => assertAgentFamilyReach(child, parent)).not.toThrow();
		expect(() => assertAgentFamilyReach(child, unrelated)).toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
	});

	it("compares legacy and modern saved siblings at one neutral depth", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-sibling-name-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const base = {
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		const target = { ...base, id: "target", path: join(directory, "target.jsonl"), parentSessionPath, rlmDepth: 1 };
		const legacy = { ...base, id: "legacy", path: join(directory, "legacy.jsonl"), parentSessionPath, name: "taken" };
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;

		expect(() => supervisor.assertSavedSiblingNameAvailable([target, legacy], target, "taken")).toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);
	});

	it("publishes an opening reservation before named create validation awaits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-named-create-race-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseSiblings!: () => void;
		const siblingGate = new Promise<void>((resolve) => {
			releaseSiblings = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const resident = worker("opened");
		const launchWorker = vi.fn(async () => resident);
		Object.assign(supervisor, {
			catalog: {
				resolve: vi.fn(async () => sessionPath),
				siblings: vi.fn(async () => {
					await siblingGate;
					return [];
				}),
				list: vi.fn(async () => []),
			},
			launchWorker,
		});

		const first = supervisor.createOrReuseWorker("client", { type: "create", name: "named", sessionPath });
		const starting = worker("starting");
		starting.descriptor.lifecycle = "starting";
		starting.descriptor.createCommand = { config: { cwd: "/tmp/project" }, sessionPath };
		supervisor.workers.set(starting.descriptor.workerId, starting);
		const second = supervisor.createOrReuseWorker("client", { type: "create", sessionPath });
		releaseSiblings();
		expect(await Promise.all([first, second])).toEqual([resident, resident]);
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("enforces session ownership when joining an in-flight open", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-pending-owner-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const resident = worker("opened");
		resident.descriptor.ownerClientId = "owner";
		const launchWorker = vi.fn(async () => {
			await launchGate;
			return resident;
		});
		Object.assign(supervisor, { launchWorker });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const sameOwner = supervisor.createOrReuseWorker("owner", create);
		const otherClient = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).resolves.toBe(resident),
			expect(sameOwner).resolves.toBe(resident),
			expect(otherClient).rejects.toMatchObject({ code: "session_already_active" }),
		]);
		releaseLaunch();
		await expectations;
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("rejoins an open registered while reclaiming a stale worker registration", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-reclaim-rejoin-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseReclaim!: () => void;
		const reclaimGate = new Promise<void>((resolve) => {
			releaseReclaim = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const stale = worker("stale");
		stale.descriptor.createCommand = { config: { cwd: directory }, sessionPath };
		supervisor.workers.set(stale.descriptor.workerId, stale);
		const resident = worker("opened");
		resident.descriptor.ownerClientId = "owner";
		const launchWorker = vi.fn(async () => resident);
		const reclaimStaleWorkerRegistration = vi.fn(async () => {
			await reclaimGate;
			supervisor.workers.delete(stale.descriptor.workerId);
			return true;
		});
		Object.assign(supervisor, { launchWorker, reclaimStaleWorkerRegistration });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const second = supervisor.createOrReuseWorker("owner", create);
		const intruder = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).resolves.toBe(resident),
			expect(second).resolves.toBe(resident),
			expect(intruder).rejects.toMatchObject({ code: "session_already_active" }),
		]);
		releaseReclaim();
		await expectations;
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("propagates an in-flight open failure to joiners", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-pending-failure-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn(async () => {
			await launchGate;
			throw new Error("launch exploded");
		});
		Object.assign(supervisor, { launchWorker });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const joiner = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).rejects.toThrow("launch exploded"),
			expect(joiner).rejects.toThrow("launch exploded"),
		]);
		releaseLaunch();
		await expectations;
	});

	it("uses injective structural session name reservation keys", () => {
		expect(sessionNameReservationKey({ name: "b:c", depth: 1, parentSessionPath: "/a" })).not.toBe(
			sessionNameReservationKey({ name: "c", depth: 1, parentSessionPath: "/a:b" }),
		);
		expect(sessionNameReservationKey({ name: "worker", depth: 1, parentSessionPath: "/a" })).toBe(
			sessionNameReservationKey({ name: "worker", depth: 1, parentSessionPath: "/a" }),
		);
	});

	it("holds a root rename reservation until the worker commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-root-rename-race-"));
		tempDirs.push(directory);
		const firstSummary = summary({
			id: "first-active",
			activeSessionId: "first-active",
			sessionId: "first-session",
			rlmDepth: 0,
		});
		const secondSummary = summary({
			id: "second-active",
			activeSessionId: "second-active",
			sessionId: "second-session",
			rlmDepth: 0,
		});
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const firstWorker = worker("first", [firstSummary]);
		firstWorker.client.request.mockImplementation(async (command: { type: string }) => {
			if (command.type === "list") return success(undefined, "list", { sessions: [firstSummary] });
			await renameGate;
			return success(undefined, "rename", firstSummary);
		});
		const secondWorker = worker("second", [secondSummary]);
		secondWorker.client.request.mockResolvedValue(success(undefined, "rename", secondSummary));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("first", firstWorker);
		supervisor.workers.set("second", secondWorker);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) } });
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		const first = supervisor.handleCommand(client, {
			type: "rename",
			activeSessionId: "first-active",
			name: "shared-root",
		});
		await vi.waitFor(() =>
			expect(firstWorker.client.request).toHaveBeenCalledWith(
				expect.objectContaining({ type: "rename" }),
				expect.any(Number),
			),
		);
		await expect(
			supervisor.handleCommand(client, {
				type: "rename",
				activeSessionId: "second-active",
				name: "shared-root",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");
		expect(secondWorker.client.request).not.toHaveBeenCalled();
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("allows only a resident worker token to rename a client-owned session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-worker-rename-"));
		tempDirs.push(directory);
		const ownedSummary = summary({
			id: "owned-active",
			activeSessionId: "owned-active",
			sessionId: "owned-session",
			rlmDepth: 0,
		});
		const ownedWorker = worker("owned", [ownedSummary]);
		ownedWorker.descriptor.ownerClientId = "interactive-client";
		ownedWorker.client.request.mockResolvedValue(success(undefined, "set_session_name"));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("owned", ownedWorker);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) } });
		const workerClient = { id: "daemon-client:worker", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(workerClient, {
				type: "set_session_name",
				activeSessionId: "owned-active",
				name: "renamed-by-worker",
				workerToken: "owned-token",
			}),
		).resolves.toMatchObject({ success: true });
		expect(ownedWorker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "set_session_name", activeSessionId: "owned-active" }),
			expect.any(Number),
		);

		ownedWorker.client.request.mockClear();
		for (const workerToken of [undefined, "foreign-token"]) {
			await expect(
				supervisor.handleCommand(workerClient, {
					type: "set_session_name",
					activeSessionId: "owned-active",
					name: "unauthorized",
					...(workerToken ? { workerToken } : {}),
				}),
			).rejects.toThrow("Unknown active session: owned-active");
		}
		expect(ownedWorker.client.request).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "set_session_name" }),
			expect.any(Number),
		);
	});

	it("serializes active saved-session renames until the worker commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-active-saved-rename-race-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const firstPath = join(directory, "first.jsonl");
		const secondPath = join(directory, "second.jsonl");
		const firstSummary = summary({
			id: "first-active",
			activeSessionId: "first-active",
			sessionId: "first-session",
			sessionFile: firstPath,
			parentSessionPath,
			rlmDepth: 1,
		});
		const secondSummary = summary({
			id: "second-active",
			activeSessionId: "second-active",
			sessionId: "second-session",
			sessionFile: secondPath,
			parentSessionPath,
			rlmDepth: 1,
		});
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const firstWorker = worker("first", [firstSummary]);
		firstWorker.client.request.mockImplementation(async () => {
			await renameGate;
			return success(undefined, "rename_saved_session", firstSummary);
		});
		const secondWorker = worker("second", [secondSummary]);
		secondWorker.client.request.mockResolvedValue(success(undefined, "rename_saved_session", secondSummary));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("first", firstWorker);
		supervisor.workers.set("second", secondWorker);
		Object.assign(supervisor, {
			catalog: {
				siblings: vi.fn(async () => []),
				list: vi.fn(async () => []),
			},
		});
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		const first = supervisor.handleCommand(client, {
			type: "rename_saved_session",
			activeSessionId: "first-active",
			sessionPath: firstPath,
			name: "shared",
		});
		await vi.waitFor(() =>
			expect(firstWorker.client.request).toHaveBeenCalledWith(
				expect.objectContaining({ type: "rename_saved_session" }),
				expect.any(Number),
			),
		);
		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				activeSessionId: "second-active",
				sessionPath: secondPath,
				name: "shared",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		expect(secondWorker.client.request).not.toHaveBeenCalled();
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("serializes same-scope inactive renames across catalog validation and commit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-saved-rename-race-"));
		tempDirs.push(directory);
		const firstPath = join(directory, "first.jsonl");
		const secondPath = join(directory, "second.jsonl");
		const parentSessionPath = join(directory, "parent.jsonl");
		const saved = [firstPath, secondPath].map((path, index) => ({
			id: `saved-${index}`,
			path,
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
			parentSessionPath,
			rlmDepth: 1,
		}));
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const rename = vi.fn(async () => renameGate);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async () => saved),
			rlmSpawnLedger: vi.fn(() => ({ appendRenameByChildPath: vi.fn(async () => {}) })),
			catalog: {
				rename,
			},
		});
		const client = {};

		const first = supervisor.handleCommand(client, {
			type: "rename_saved_session",
			sessionPath: firstPath,
			name: "shared",
		});
		await vi.waitFor(() => expect(rename).toHaveBeenCalledOnce());
		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				sessionPath: secondPath,
				name: "shared",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("reserves named child creates by parent scope until worker launch completes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-child-create-race-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const child = (id: string) => ({
			id,
			path: join(directory, `${id}.jsonl`),
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
			parentSessionPath,
			rlmDepth: 1,
		});
		const firstChild = child("first-child");
		const secondChild = child("second-child");
		let releaseLaunch: () => void = () => {};
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const launched = worker("opened");
		const launchWorker = vi.fn(async () => {
			await launchGate;
			return launched;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async (path: string) => [path === firstChild.path ? firstChild : secondChild]),
			catalog: {
				resolve: vi.fn(async (path: string) => path),
			},
			launchWorker,
		});

		const first = supervisor.createOrReuseWorker("client", {
			type: "create",
			name: "shared-child",
			sessionPath: firstChild.path,
		});
		await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledOnce());
		await expect(
			supervisor.createOrReuseWorker("client", {
				type: "create",
				name: "shared-child",
				sessionPath: secondChild.path,
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		releaseLaunch();
		await expect(first).resolves.toBe(launched);
	});

	it("dispatches authenticated peer queries and excludes disconnected workers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-peers-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const client = new DaemonClient(socketPath);
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();

		const passive = summary({
			id: "passive-session",
			sessionId: "passive-session",
			sessionFile: join(directory, "passive.jsonl"),
			sessionName: "passive-worker",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const firstRoot = summary({
			id: "first-root-active",
			activeSessionId: "first-root-active",
			sessionId: "first-root-session",
			runtimeKind: "top-level",
		});
		const secondRoot = summary({
			id: "second-root-active",
			activeSessionId: "second-root-active",
			sessionId: "second-root-session",
		});
		const disconnectedRoot = summary({
			id: "disconnected-root-active",
			activeSessionId: "disconnected-root-active",
			sessionId: "disconnected-root-session",
		});
		const first = worker("first", [firstRoot, passive]);
		const second = worker("second", [secondRoot]);
		const disconnected = worker("disconnected", [disconnectedRoot]);
		Object.assign(disconnected, { client: undefined });

		try {
			await supervisor.start();
			supervisor.workers.set("first", first);
			supervisor.workers.set("second", second);
			supervisor.workers.set("disconnected", disconnected);
			await client.connect();

			await expect(
				client.request({ type: "list_agent_peers", workerToken: "invalid-token" }),
			).resolves.toMatchObject({
				success: false,
				error: "Worker authentication failed",
			});
			const response = await client.request({
				type: "list_agent_peers",
				workerToken: second.descriptor.authenticationToken,
			});
			expect(response).toMatchObject({
				success: true,
				data: {
					peers: [
						expect.objectContaining({
							activeSessionId: "first-root-active",
							sessionId: "first-root-session",
							runtimeKind: "top-level",
						}),
					],
				},
			});
		} finally {
			client.close();
			supervisor.workers.clear();
			await supervisor.cleanupSupervisorResources();
		}
	});
});
