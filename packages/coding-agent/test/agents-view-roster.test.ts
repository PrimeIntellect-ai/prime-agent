import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import { buildAgentsViewRows } from "../src/modes/agents-view/agents-view-state.js";
import { AgentsViewRosterStore } from "../src/modes/agents-view/roster-store.js";
import {
	type AgentRosterEntry,
	sessionSummaryFromRosterEntry,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "../src/modes/daemon/agent-roster.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { classifySubagentSnapshotStatus } from "../src/modes/interactive/components/subagent-summary-line.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
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

function ledgerEntry(
	overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">,
	roster: Partial<Pick<AgentRosterEntry, "status" | "statusLabel" | "lastHeardFromAt" | "queuedChild">> = {},
): AgentRosterEntry {
	const base = workerRosterEntryFromSummary(summary(overrides));
	return { ...base, status: roster.status ?? "idle", ...roster };
}

type FakeClient = {
	supportsServerCapability: (capability: string) => boolean;
	isConnected: boolean;
	onMessage: (listener: (message: DaemonOutbound) => void) => () => void;
	request: ReturnType<typeof vi.fn>;
	emit: (message: DaemonOutbound) => void;
};

function fakeRosterClient(roster: AgentRosterEntry[], supported = true): FakeClient {
	const listeners = new Set<(message: DaemonOutbound) => void>();
	return {
		supportsServerCapability: () => supported,
		isConnected: true,
		onMessage: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		request: vi.fn(async (command: { type: string }) => {
			if (command.type === "roster_subscribe") {
				return { type: "response", command: command.type, success: true, data: { roster } };
			}
			return { type: "response", command: command.type, success: true };
		}),
		emit: (message) => {
			for (const listener of listeners) listener(message);
		},
	};
}

describe("agents-view roster store", () => {
	it("subscribes once and re-attaches without any further requests", async () => {
		const client = fakeRosterClient([
			ledgerEntry({ id: "a", sessionId: "a", activeSessionId: "a" }, { status: "idle" }),
		]);
		const store = new AgentsViewRosterStore();

		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["a"]);

		// Scope transitions re-attach the surviving store: zero additional requests.
		await expect(store.attach(client as never)).resolves.toBe(true);
		await expect(store.attach(client as never)).resolves.toBe(true);
		expect(client.request).toHaveBeenCalledTimes(1);
	});

	it("reports an unsupported daemon so the view can keep the legacy poll path", async () => {
		const store = new AgentsViewRosterStore();
		const client = fakeRosterClient([], false);
		await expect(store.attach(client as never)).resolves.toBe(false);
		expect(client.request).not.toHaveBeenCalled();
	});

	it("applies pushed updates, removals, and full resyncs", async () => {
		const client = fakeRosterClient([ledgerEntry({ id: "a", sessionId: "a" })]);
		const store = new AgentsViewRosterStore();
		await store.attach(client as never);

		client.emit({
			type: "roster_update",
			changed: [ledgerEntry({ id: "b", sessionId: "b" }, { status: "running" })],
		});
		expect(
			store
				.summaries()
				.map((entry) => entry.sessionId)
				.sort(),
		).toEqual(["a", "b"]);
		expect(store.summaries().find((entry) => entry.sessionId === "b")?.rosterStatus).toBe("running");

		client.emit({ type: "roster_update", changed: [], removed: ["a"] });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["b"]);

		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "c", sessionId: "c" })], resync: true });
		expect(store.summaries().map((entry) => entry.sessionId)).toEqual(["c"]);
	});

	it("emits one listener call for several updates arriving in the same tick", async () => {
		const client = fakeRosterClient([]);
		const store = new AgentsViewRosterStore();
		await store.attach(client as never);
		const listener = vi.fn();
		store.onUpdate(listener);

		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "a", sessionId: "a" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "b", sessionId: "b" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "c", sessionId: "c" })] });
		await Promise.resolve();

		expect(listener).toHaveBeenCalledTimes(1);
		expect(store.summaries()).toHaveLength(3);
	});
});

describe("roster-driven agents view rows", () => {
	it("shows a queued child with its ledger label before any session exists", () => {
		const queued = ledgerEntry(
			{
				id: "child-1",
				sessionId: "child-1",
				runtimeKind: "subagent",
				rlmChildId: "child-1",
				parentSessionId: "root-session",
				messageCount: 0,
				firstMessage: "review the API",
			},
			{ status: "running", statusLabel: "queued", queuedChild: true },
		);
		const root = ledgerEntry(
			{ id: "root-active", sessionId: "root-session", activeSessionId: "root-active" },
			{ status: "idle" },
		);

		const summaries = [root, queued].map((entry) => sessionSummaryFromRosterEntry(entry));
		const rootIdentity = buildAgentsViewRows(summaries).find(
			(row) => row.summary.sessionId === "root-session",
		)?.identity;
		if (!rootIdentity) throw new Error("Missing root row");
		const rows = buildAgentsViewRows(summaries, new Set([rootIdentity]));
		const queuedRow = rows.find((row) => row.summary.rlmChildId === "child-1");
		expect(queuedRow).toBeDefined();
		expect(queuedRow?.section).toBe("running");
		expect(queuedRow?.statusLabel).toBe("queued");
	});

	it("labels recovering and stale rows from ledger state instead of hiding them", () => {
		const recovering = ledgerEntry(
			{ id: "r-active", sessionId: "r", activeSessionId: "r-active" },
			{ status: "running", statusLabel: "recovering" },
		);
		const stale = ledgerEntry(
			{ id: "s-active", sessionId: "s", activeSessionId: "s-active" },
			{ status: "idle", lastHeardFromAt: new Date(Date.now() - 60_000).toISOString() },
		);

		const rows = buildAgentsViewRows([recovering, stale].map((entry) => sessionSummaryFromRosterEntry(entry)));
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.summary.sessionId === "r")?.statusLabel).toBe("recovering");
		expect(rows.find((row) => row.summary.sessionId === "s")?.statusLabel).toMatch(/^last heard \d+(s|m) ago$/);
	});

	it("derives header sections and bar counts from the same ledger statuses", () => {
		const entries: AgentRosterEntry[] = [
			ledgerEntry({ id: "run-active", sessionId: "run", activeSessionId: "run-active" }, { status: "running" }),
			ledgerEntry({ id: "idle-active", sessionId: "idle", activeSessionId: "idle-active" }, { status: "idle" }),
			ledgerEntry({ id: "off", sessionId: "off", sessionFile: "/tmp/off.jsonl" }, { status: "inactive" }),
		];
		const byStatus = { running: 0, idle: 0, inactive: 0 };
		for (const entry of entries) byStatus[entry.status] += 1;

		const rows = buildAgentsViewRows(entries.map((entry) => sessionSummaryFromRosterEntry(entry)));
		const headerCounts = {
			running: rows.filter((row) => row.kind === "agent" && row.section === "running").length,
			idle: rows.filter((row) => row.kind === "agent" && row.section === "idle").length,
			inactive: rows.filter((row) => row.kind === "agent" && row.section === "inactive").length,
		};
		expect(headerCounts).toEqual(byStatus);

		// The in-process bar maps snapshots through the same shared classifier.
		const snapshots: AgentConnectionRlmChildAgentSnapshot[] = [
			{ id: "run", label: "run", status: "running", sessionDir: "/tmp", activeSessionId: "run-active" },
			{ id: "idle", label: "idle", status: "done", sessionDir: "/tmp", activeSessionId: "idle-active" },
			{ id: "off", label: "off", status: "done", sessionDir: "/tmp" },
		];
		const barCounts = { running: 0, idle: 0, inactive: 0 };
		for (const snapshot of snapshots) barCounts[classifySubagentSnapshotStatus(snapshot, new Set())] += 1;
		expect(barCounts).toEqual(byStatus);
	});
});

describe("supervisor roster subscription", () => {
	it("seeds subscribers and pushes one coalesced update per mutation batch over the wire", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-roster-push-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		});
		const internals = supervisor as unknown as {
			start(): Promise<void>;
			cleanupSupervisorResources(): Promise<void>;
			writeRosterEntry(entry: WorkerRosterEntry): AgentRosterEntry;
			roster(): { delete(agentId: string): void };
		};
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		const client = new DaemonClient(socketPath);
		try {
			await internals.start();
			internals.writeRosterEntry(
				workerRosterEntryFromSummary(summary({ id: "seeded", sessionId: "seeded", sessionFile: "/tmp/s.jsonl" })),
			);
			await client.connect();
			await client.waitForHello();
			expect(client.supportsServerCapability("agent_roster")).toBe(true);
			const updates: Array<Extract<DaemonOutbound, { type: "roster_update" }>> = [];
			client.onMessage((message) => {
				if (message.type === "roster_update") updates.push(message);
			});

			const subscribed = await client.request({ type: "roster_subscribe" });
			if (!subscribed.success) throw new Error(subscribed.error);
			const roster = (subscribed.success ? (subscribed.data as { roster: AgentRosterEntry[] }) : { roster: [] })
				.roster;
			expect(roster.map((entry) => entry.agentId)).toEqual(["seeded"]);

			internals.writeRosterEntry(
				workerRosterEntryFromSummary(
					summary({ id: "a-active", sessionId: "a", activeSessionId: "a-active", isSessionActive: true }),
				),
			);
			internals.writeRosterEntry(workerRosterEntryFromSummary(summary({ id: "b", sessionId: "b" })));
			internals.roster().delete("seeded");
			await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

			expect(updates).toHaveLength(1);
			expect(updates[0]?.changed.map((entry) => entry.agentId).sort()).toEqual(["a", "b"]);
			expect(updates[0]?.changed.find((entry) => entry.agentId === "a")?.status).toBe("running");
			expect(updates[0]?.removed).toEqual(["seeded"]);
		} finally {
			client.close();
			await internals.cleanupSupervisorResources();
		}
	});
});

describe("roster-driven agents view instance", () => {
	function makeView(entries: AgentRosterEntry[]) {
		const store = new AgentsViewRosterStore();
		const client = fakeRosterClient(entries);
		const view = new AgentsViewMode(
			{
				config: {} as never,
				uiServices: {
					settingsManager: SettingsManager.inMemory({ theme: "dark" }),
					modelRegistry: {} as never,
					getInitialCwd: () => process.cwd(),
					getInitialSessionName: () => undefined,
					getThemes: () => [],
				},
			},
			{},
		) as AgentsViewMode & Record<string, unknown>;
		Reflect.set(view, "rosterSupported", true);
		Reflect.set(view, "rosterStore", store);
		Reflect.set(view, "client", client);
		Reflect.set(view, "liveCatalogReady", true);
		Reflect.set(view, "savedCatalogReady", true);
		return { view, store, client };
	}

	it("serves navigation refreshes from the store with zero catalog requests", async () => {
		const { view, store, client } = makeView([
			ledgerEntry({ id: "a-active", sessionId: "a", activeSessionId: "a-active" }, { status: "running" }),
		]);
		await store.attach(client as never);
		client.request.mockClear();

		const internals = view as unknown as {
			refreshSessions(): Promise<boolean>;
			refreshBothCatalogs(): Promise<boolean>;
			rows: Array<{ summary: SessionSummary }>;
		};
		await expect(internals.refreshSessions()).resolves.toBe(true);
		await expect(internals.refreshBothCatalogs()).resolves.toBe(true);

		expect(client.request).not.toHaveBeenCalled();
		expect(internals.rows.some((row) => row.summary.sessionId === "a")).toBe(true);
	});

	it("fetches the saved catalog at most once per view instance, and only when a query is typed", () => {
		const { view } = makeView([]);
		const refreshSavedSessions = vi.fn(async () => true);
		Reflect.set(view, "refreshSavedSessions", refreshSavedSessions);
		const internals = view as unknown as {
			queryChanged(): void;
			editor: { setText(text: string): void };
		};

		internals.queryChanged();
		expect(refreshSavedSessions).not.toHaveBeenCalled();

		internals.editor.setText("needle");
		internals.queryChanged();
		internals.editor.setText("needle two");
		internals.queryChanged();
		expect(refreshSavedSessions).toHaveBeenCalledTimes(1);
	});

	it("navigates rows without issuing any daemon requests", async () => {
		setKeybindings(new KeybindingsManager());
		const { view, store, client } = makeView([
			ledgerEntry({ id: "a-active", sessionId: "a", activeSessionId: "a-active" }, { status: "running" }),
			ledgerEntry({ id: "b-active", sessionId: "b", activeSessionId: "b-active" }, { status: "idle" }),
		]);
		await store.attach(client as never);
		(view as unknown as { onRosterUpdate(): void }).onRosterUpdate();
		client.request.mockClear();

		view.handleInput("\u001b[B");
		view.handleInput("\u001b[A");

		expect(client.request).not.toHaveBeenCalled();
	});

	it("reconciles once per pushed batch", async () => {
		const { view, store, client } = makeView([]);
		await store.attach(client as never);
		const applySessionList = vi.fn();
		Reflect.set(view, "applySessionList", applySessionList);
		Reflect.set(
			view,
			"unsubscribeRosterUpdate",
			store.onUpdate(() => (view as unknown as { onRosterUpdate(): void }).onRosterUpdate()),
		);

		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "a", sessionId: "a" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "b", sessionId: "b" })] });
		client.emit({ type: "roster_update", changed: [ledgerEntry({ id: "c", sessionId: "c" })] });
		await Promise.resolve();

		expect(applySessionList).toHaveBeenCalledTimes(1);
	});
});
