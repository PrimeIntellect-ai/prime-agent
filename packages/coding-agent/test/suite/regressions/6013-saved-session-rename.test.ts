import { symlinkSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import { readSessionInfo, SessionManager } from "../../../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { type WorkerRosterEntry, workerRosterEntryFromSummary } from "../../../src/modes/daemon/agent-roster.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { type DaemonCommand, type DaemonResponse, success } from "../../../src/modes/daemon/daemon-protocol.js";
import { type SessionSummary, summaryForActiveSession } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { createHarness, type Harness } from "../harness.js";

interface WorkerFixture {
	descriptor: Pick<
		DaemonWorkerDescriptor,
		"workerId" | "lifecycle" | "rootActiveSessionId" | "sessionFile" | "createCommand" | "ownerClientId"
	>;
	client?: { request(command: DaemonCommand): Promise<DaemonResponse> };
	intentionalStop: boolean;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse>;
	writeRosterEntry(entry: WorkerRosterEntry, worker?: WorkerFixture): void;
}

interface WorkerInternals {
	sessions: Map<string, ActiveSessionState>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
}

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createFixture() {
	const harness = await createHarness({ persistSession: true });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Saved answer")]);
	await harness.session.prompt("Saved task");
	harness.session.setSessionName("Original name");
	harness.sessionManager.flushNow();
	const sessionPath = harness.session.sessionFile!;
	const activeSessionId = "fixture-active";
	const client: DaemonSocketClient = {
		id: "fixture-client",
		socket: new Socket(),
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
	const config = { agentDir: harness.tempDir, cwd: harness.tempDir, sessionDir: join(harness.tempDir, "sessions") };
	const daemon = new AgentDaemon(join(harness.tempDir, "worker.sock"), {
		defaultSessionConfig: config,
		createRuntime: vi.fn(),
		worker: { authenticationToken: "fixture-token" },
	}) as unknown as WorkerInternals;
	const state: ActiveSessionState = {
		activeSessionId,
		runtime: {
			session: harness.session,
			metadata: { kind: "top-level", createdAt: Date.now() },
			diagnostics: [],
		} as unknown as AgentSessionRuntime,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "fixture-generation",
		lastEventSequence: 0,
	};
	daemon.sessions.set(activeSessionId, state);
	const supervisor = new DaemonSupervisor(join(harness.tempDir, "supervisor.sock"), {
		defaultSessionConfig: config,
	}) as unknown as SupervisorInternals;
	const request = vi.fn(async (command: DaemonCommand) => {
		const response = await daemon.handleCommand(client, command);
		if (!response) throw new Error(`No response for ${command.type}`);
		return response;
	});
	const worker: WorkerFixture = {
		descriptor: {
			workerId: "fixture-worker",
			lifecycle: "ready",
			rootActiveSessionId: activeSessionId,
			sessionFile: sessionPath,
			createCommand: { type: "create", sessionPath },
		},
		client: { request },
		intentionalStop: false,
	};
	const catalogRename = vi.fn(async (path: string, name: string) => {
		SessionManager.open(path).appendSessionInfo(name.trim());
	});
	Object.assign(supervisor, {
		catalog: {
			list: async () => [await readSessionInfo(sessionPath)],
			rename: catalogRename,
		},
	});
	supervisor.workers.set(worker.descriptor.workerId, worker);
	const publish = () =>
		supervisor.writeRosterEntry(workerRosterEntryFromSummary(summaryForActiveSession(state)), worker);
	publish();
	harness.session.subscribe(publish);
	const row = async () => {
		const response = await supervisor.handleCommand(client, { type: "list" });
		if (!response.success) throw new Error(response.error);
		const { sessions } = response.data as { sessions: SessionSummary[] };
		return sessions.find((entry) => entry.activeSessionId === activeSessionId);
	};
	return { harness, supervisor, worker, client, request, catalogRename, sessionPath, activeSessionId, row };
}

describe("ENG-6013: saved-session names survive live worker activity", () => {
	it.each(["path", "symlink", "active id"])("keeps a rename by %s through the next streamed turn", async (route) => {
		const fixture = await createFixture();
		const { harness, supervisor, client, sessionPath, activeSessionId, row } = fixture;
		let renamePath = sessionPath;
		if (route === "symlink") {
			renamePath = join(harness.tempDir, "session-alias.jsonl");
			symlinkSync(sessionPath, renamePath);
		}
		const command: DaemonCommand = {
			id: "rename-request",
			type: "rename_saved_session",
			sessionPath: renamePath,
			name: "  Renamed session  ",
			...(route === "active id" ? { activeSessionId } : {}),
		};
		await expect(supervisor.handleCommand(client, command)).resolves.toEqual(success(command.id, command.type));
		expect((await row())?.sessionName).toBe("Renamed session");
		expect((await readSessionInfo(sessionPath))?.name).toBe("Renamed session");

		const streamingRows: Array<Promise<SessionSummary | undefined>> = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_update") streamingRows.push(row());
		});
		harness.setResponses([fauxAssistantMessage("A streamed response after the rename")]);
		await harness.session.prompt("Continue the saved task");
		const streamingNames = (await Promise.all(streamingRows)).map((entry) => entry?.sessionName);
		expect(streamingNames.length).toBeGreaterThan(0);
		expect(new Set(streamingNames)).toEqual(new Set(["Renamed session"]));
		expect((await row())?.sessionName).toBe("Renamed session");
		await expect(supervisor.handleCommand(client, { type: "get_state", activeSessionId })).resolves.toMatchObject({
			data: { sessionName: "Renamed session" },
		});
		expect((await readSessionInfo(sessionPath))?.name).toBe("Renamed session");
		expect(fixture.catalogRename).not.toHaveBeenCalled();
	});

	it("renames an offline session through the saved catalog", async () => {
		const { supervisor, worker, client, sessionPath, catalogRename, request } = await createFixture();
		supervisor.workers.delete(worker.descriptor.workerId);
		await expect(
			supervisor.handleCommand(client, { type: "rename_saved_session", sessionPath, name: "Offline name" }),
		).resolves.toMatchObject({ success: true });
		expect((await readSessionInfo(sessionPath))?.name).toBe("Offline name");
		expect(catalogRename).toHaveBeenCalledOnce();
		expect(request).not.toHaveBeenCalled();
	});

	it.each(["recovering", "stopping"] as const)("does not write behind a %s worker", async (lifecycle) => {
		const { supervisor, worker, client, sessionPath, catalogRename } = await createFixture();
		worker.descriptor.lifecycle = lifecycle;
		worker.client = undefined;
		await expect(
			supervisor.handleCommand(client, { type: "rename_saved_session", sessionPath, name: "Unaccepted name" }),
		).rejects.toThrow(`Session worker is ${lifecycle}`);
		expect((await readSessionInfo(sessionPath))?.name).toBe("Original name");
		expect(catalogRename).not.toHaveBeenCalled();
	});

	it("enforces client-owned worker access for path-only renames", async () => {
		const { supervisor, worker, client, sessionPath, catalogRename, request, harness } = await createFixture();
		worker.descriptor.ownerClientId = "other-client";
		const command: DaemonCommand = { type: "rename_saved_session", sessionPath, name: "Owner rename" };
		await expect(supervisor.handleCommand(client, command)).rejects.toThrow("Unknown active session");
		expect((await readSessionInfo(sessionPath))?.name).toBe("Original name");
		expect(catalogRename).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
		await expect(supervisor.handleCommand({ ...client, id: "other-client" }, command)).resolves.toMatchObject({
			success: true,
		});
		expect(harness.session.sessionName).toBe("Owner rename");
	});
});
