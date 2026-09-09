import { symlinkSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import { readSessionInfo, SessionManager } from "../../../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import {
	type AgentRoster,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "../../../src/modes/daemon/agent-roster.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import {
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
	failure,
	success,
} from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type {
	DaemonWorkerDescriptor,
	DaemonWorkerRosterOutbound,
} from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { createHarness, type Harness } from "../harness.js";

interface WorkerFixture {
	descriptorPath: string;
	descriptor: Pick<
		DaemonWorkerDescriptor,
		| "workerId"
		| "lifecycle"
		| "rootActiveSessionId"
		| "rootSessionId"
		| "sessionFile"
		| "createCommand"
		| "ownerClientId"
	>;
	client?: { request(command: DaemonCommand): Promise<DaemonResponse> };
	intentionalStop: boolean;
	rosterApplyChain?: Promise<void>;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse>;
	writeRosterEntry(entry: WorkerRosterEntry, worker?: WorkerFixture): void;
	consumeWorkerRosterDelta(worker: WorkerFixture, payload: Buffer): void;
	launchWorker(command: DaemonCommand): Promise<WorkerFixture>;
	roster(): AgentRoster;
}

interface WorkerInternals {
	sessions: Map<string, ActiveSessionState>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	observeRosterEvent(state: ActiveSessionState, message: DaemonOutbound): void;
	flushRoster(): void;
}

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createFixture(sharedSupervisor?: SupervisorInternals) {
	const harness = await createHarness({ persistSession: true });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Saved answer")]);
	await harness.session.prompt("Saved task");
	harness.session.setSessionName("Original name");
	harness.sessionManager.flushNow();
	const sessionPath = harness.session.sessionFile!;
	const activeSessionId = `fixture-active-${harnesses.length}`;
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
	const supervisor =
		sharedSupervisor ??
		(new DaemonSupervisor(join(harness.tempDir, "supervisor.sock"), {
			defaultSessionConfig: config,
		}) as unknown as SupervisorInternals);
	const request = vi.fn(async (command: DaemonCommand) => {
		const response = await daemon.handleCommand(client, command);
		if (!response) throw new Error(`No response for ${command.type}`);
		return response;
	});
	const worker: WorkerFixture = {
		descriptorPath: join(harness.tempDir, "worker.json"),
		descriptor: {
			workerId: `fixture-worker-${harnesses.length}`,
			lifecycle: "ready",
			rootActiveSessionId: activeSessionId,
			rootSessionId: harness.session.sessionId,
			sessionFile: sessionPath,
			createCommand: { type: "create", sessionPath },
		},
		client: { request },
		intentionalStop: false,
	};
	const catalogRename = vi.fn(async (path: string, name: string) => {
		SessionManager.open(path).appendSessionInfo(name.trim());
	});
	const catalogList = vi.fn(async () =>
		Promise.all(harnesses.map((item) => readSessionInfo(item.session.sessionFile!))),
	);
	if (!sharedSupervisor) {
		Object.assign(supervisor, {
			catalog: {
				list: catalogList,
				rename: catalogRename,
			},
		});
	}
	supervisor.workers.set(worker.descriptor.workerId, worker);
	const pendingRoster: Buffer[] = [];
	Object.assign(daemon, {
		hasAuthenticatedSupervisorClient: () => true,
		broadcastRosterFrame: (message: DaemonWorkerRosterOutbound) => {
			if (message.type === "roster_delta") pendingRoster.push(Buffer.from(JSON.stringify(message)));
			return true;
		},
	});
	const flushRoster = async () => {
		await new Promise<void>((resolve) => setImmediate(resolve));
		for (const payload of pendingRoster.splice(0)) supervisor.consumeWorkerRosterDelta(worker, payload);
		await worker.rosterApplyChain;
	};
	daemon.flushRoster();
	await flushRoster();
	harness.session.subscribe((event) =>
		daemon.observeRosterEvent(state, { type: "session_event", activeSessionId, event }),
	);
	const row = async () => {
		const response = await supervisor.handleCommand(client, { type: "list" });
		if (!response.success) throw new Error(response.error);
		const { sessions } = response.data as { sessions: SessionSummary[] };
		return sessions.find((entry) => entry.activeSessionId === activeSessionId);
	};
	return {
		harness,
		supervisor,
		worker,
		client,
		request,
		catalogRename,
		catalogList,
		sessionPath,
		activeSessionId,
		row,
		flushRoster,
	};
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
		await fixture.flushRoster();
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
		await fixture.flushRoster();
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

	it.each(["path", "symlink", "active id", "set_session_name", "rename"])(
		"reserves a name accepted by %s before its delayed roster frame arrives",
		async (route) => {
			const first = await createFixture();
			const second = await createFixture(first.supervisor);
			const { supervisor, client, activeSessionId } = first;
			let sessionPath = first.sessionPath;
			if (route === "symlink") {
				sessionPath = join(first.harness.tempDir, "session-alias.jsonl");
				symlinkSync(first.sessionPath, sessionPath);
			}
			const command: DaemonCommand =
				route === "set_session_name" || route === "rename"
					? { type: route, activeSessionId, name: "  Claimed name  " }
					: {
							type: "rename_saved_session",
							sessionPath,
							name: "  Claimed name  ",
							...(route === "active id" ? { activeSessionId } : {}),
						};
			await expect(supervisor.handleCommand(client, command)).resolves.toMatchObject({ success: true });
			expect(first.harness.session.sessionName).toBe("Claimed name");
			// Worker responses and setImmediate roster publication travel independently over IPC.
			await expect(
				supervisor.handleCommand(client, {
					type: "rename_saved_session",
					sessionPath: second.sessionPath,
					name: "Claimed name",
				}),
			).rejects.toThrow(/already/);
			expect(second.request).not.toHaveBeenCalled();
			expect((await first.row())?.sessionName).toBe("Claimed name");
			await first.flushRoster();
			expect((await first.row())?.sessionName).toBe("Claimed name");
			expect((await second.row())?.sessionName).toBe("Original name");
		},
	);

	it("rejects a competing create before the accepted rename's roster frame arrives", async () => {
		const { supervisor, client, sessionPath, flushRoster } = await createFixture();
		const launch = vi.spyOn(supervisor, "launchWorker").mockRejectedValue(new Error("Unexpected worker launch"));
		await expect(
			supervisor.handleCommand(client, { type: "rename_saved_session", sessionPath, name: "Claimed name" }),
		).resolves.toMatchObject({ success: true });
		await expect(supervisor.handleCommand(client, { type: "create", name: "Claimed name" })).rejects.toThrow(
			/already/,
		);
		expect(launch).not.toHaveBeenCalled();
		await flushRoster();
	});

	it("leaves a rejected rename available to another session", async () => {
		const first = await createFixture();
		const second = await createFixture(first.supervisor);
		first.request.mockResolvedValueOnce(failure(undefined, "rename_saved_session", "Rename rejected"));
		await expect(
			first.supervisor.handleCommand(first.client, {
				type: "rename_saved_session",
				sessionPath: first.sessionPath,
				name: "Available name",
			}),
		).resolves.toMatchObject({ success: false, error: "Rename rejected" });
		expect((await first.row())?.sessionName).toBe("Original name");
		expect((await readSessionInfo(first.sessionPath))?.name).toBe("Original name");
		await expect(
			first.supervisor.handleCommand(first.client, {
				type: "rename_saved_session",
				sessionPath: second.sessionPath,
				name: "Available name",
			}),
		).resolves.toMatchObject({ success: true });
		await second.flushRoster();
		expect((await second.row())?.sessionName).toBe("Available name");
	});

	it.each(["rename_saved_session", "set_session_name", "rename"] as const)(
		"applies an acknowledged %s after earlier queued roster frames",
		async (type) => {
			const { supervisor, worker, client, sessionPath, activeSessionId, row, request } = await createFixture();
			const previous = workerRosterEntryFromSummary((await row())!);
			let release!: () => void;
			worker.rosterApplyChain = new Promise<void>((resolve) => {
				release = resolve;
			});
			supervisor.consumeWorkerRosterDelta(
				worker,
				Buffer.from(JSON.stringify({ type: "roster_delta", entries: [previous] })),
			);
			let acknowledged!: () => void;
			const acknowledgement = new Promise<void>((resolve) => {
				acknowledged = resolve;
			});
			const handleRequest = request.getMockImplementation()!;
			request.mockImplementationOnce(async (command) => {
				const response = await handleRequest(command);
				acknowledged();
				return response;
			});
			const renaming = supervisor.handleCommand(client, {
				type,
				activeSessionId,
				sessionPath,
				name: "Current name",
			});
			await acknowledgement;
			await new Promise<void>((resolve) => setImmediate(resolve));
			release();
			await expect(renaming).resolves.toMatchObject({ success: true });
			await worker.rosterApplyChain;
			expect((await row())?.sessionName).toBe("Current name");
		},
	);

	it.each(["rename_saved_session", "set_session_name", "rename"] as const)(
		"retains an acknowledged %s when the worker disconnects before queued roster application",
		async (type) => {
			const first = await createFixture();
			const second = await createFixture(first.supervisor);
			const { supervisor, worker, client, sessionPath, activeSessionId, request } = first;
			let release!: () => void;
			worker.rosterApplyChain = new Promise<void>((resolve) => {
				release = resolve;
			});
			const handleRequest = request.getMockImplementation()!;
			request.mockImplementationOnce(async (command) => {
				const response = await handleRequest(command);
				worker.client = undefined;
				worker.descriptor.lifecycle = "recovering";
				release();
				return response;
			});
			await expect(
				supervisor.handleCommand(client, {
					type,
					activeSessionId,
					sessionPath,
					name: "Accepted before disconnect",
				}),
			).resolves.toMatchObject({ success: true });
			expect((await first.row())?.sessionName).toBe("Accepted before disconnect");
			await expect(
				supervisor.handleCommand(client, {
					type: "rename_saved_session",
					sessionPath: second.sessionPath,
					name: "Accepted before disconnect",
				}),
			).rejects.toThrow(/already/);
			expect(second.request).not.toHaveBeenCalled();
		},
	);

	it.each(["rename_saved_session", "set_session_name", "rename"] as const)(
		"commits %s when its roster row arrives after the availability check",
		async (type) => {
			const first = await createFixture();
			const second = await createFixture(first.supervisor);
			const { supervisor, worker, client, sessionPath, request } = first;
			const previous = workerRosterEntryFromSummary((await first.row())!);
			const list = first.catalogList.getMockImplementation()!;
			first.catalogList.mockImplementationOnce(async () => {
				supervisor.roster().delete(previous.agentId);
				return list();
			});
			let release!: () => void;
			worker.rosterApplyChain = new Promise<void>((resolve) => {
				release = resolve;
			});
			supervisor.consumeWorkerRosterDelta(
				worker,
				Buffer.from(JSON.stringify({ type: "roster_delta", entries: [previous] })),
			);
			const handleRequest = request.getMockImplementation()!;
			request.mockImplementationOnce(async (command) => {
				const response = await handleRequest(command);
				release();
				return response;
			});
			const command: DaemonCommand =
				type === "rename_saved_session"
					? { type, sessionPath, name: "Claimed before snapshot" }
					: { type, activeSessionId: first.activeSessionId, name: "Claimed before snapshot" };
			await expect(supervisor.handleCommand(client, command)).resolves.toMatchObject({ success: true });
			expect((await first.row())?.sessionName).toBe("Claimed before snapshot");
			await expect(
				supervisor.handleCommand(client, {
					type: "rename_saved_session",
					sessionPath: second.sessionPath,
					name: "Claimed before snapshot",
				}),
			).rejects.toThrow(/already/);
		},
	);

	it("uses the session identity acknowledged by rename after a session switch", async () => {
		const first = await createFixture();
		const second = await createFixture(first.supervisor);
		const { harness, supervisor, client, request, activeSessionId } = first;
		const originalSessionId = harness.session.sessionId;
		const handleRequest = request.getMockImplementation()!;
		request.mockImplementationOnce(async (command) => {
			harness.sessionManager.newSession();
			harness.setResponses([fauxAssistantMessage("New session answer")]);
			await harness.session.prompt("New session task");
			harness.session.setSessionName("Replacement session");
			await first.flushRoster();
			return handleRequest(command);
		});
		await expect(
			supervisor.handleCommand(client, { type: "rename", activeSessionId, name: "Acknowledged session name" }),
		).resolves.toMatchObject({ success: true });
		expect(harness.session.sessionId).not.toBe(originalSessionId);
		expect((await first.row())?.sessionId).toBe(harness.session.sessionId);
		expect((await first.row())?.sessionName).toBe("Acknowledged session name");
		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				sessionPath: second.sessionPath,
				name: "Acknowledged session name",
			}),
		).rejects.toThrow(/already/);
	});

	it.each(["rename_saved_session", "set_session_name", "rename"] as const)(
		"keeps %s reserved through the saved catalog when its roster row disappears",
		async (type) => {
			const first = await createFixture();
			const second = await createFixture(first.supervisor);
			const { supervisor, client, request, sessionPath, activeSessionId } = first;
			const previous = workerRosterEntryFromSummary((await first.row())!);
			const handleRequest = request.getMockImplementation()!;
			request.mockImplementationOnce(async (command) => {
				const response = await handleRequest(command);
				supervisor.roster().delete(previous.agentId);
				return response;
			});
			await expect(
				supervisor.handleCommand(client, { type, activeSessionId, sessionPath, name: "Saved accepted name" }),
			).resolves.toMatchObject({ success: true });
			expect(supervisor.roster().get(previous.agentId)).toBeUndefined();
			await expect(
				supervisor.handleCommand(client, {
					type: "rename_saved_session",
					sessionPath: second.sessionPath,
					name: "Saved accepted name",
				}),
			).rejects.toThrow(/already/);
		},
	);
});
