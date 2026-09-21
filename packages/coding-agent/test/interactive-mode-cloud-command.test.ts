import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionCloudSession } from "../src/modes/agent-connection/index.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * /cloud drives the resident-session surface through the connection only:
 * conversion (cloudSessionCreate), listing, and the secondary lifecycle verbs.
 * The legacy one-shot delegation methods must never be called.
 */

function cloudSession(overrides: Partial<AgentConnectionCloudSession> = {}): AgentConnectionCloudSession {
	return {
		sessionId: "sess_cloud_1",
		activeSessionId: "cloud-active-1",
		sessionFile: "/tmp/shadow/sess_cloud_1.jsonl",
		generation: 1,
		connectivity: "connected",
		status: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as AgentConnectionCloudSession;
}

interface CloudCommandTestContext {
	agentConnection: {
		supportsCloudResidentSessions: () => boolean;
		cloudSessionCreate: ReturnType<typeof vi.fn>;
		cloudSessionList: ReturnType<typeof vi.fn>;
		cloudSessionStop: ReturnType<typeof vi.fn>;
		cloudSessionReprovision: ReturnType<typeof vi.fn>;
		cloudSessionImportResult: ReturnType<typeof vi.fn>;
		cloudDelegate: ReturnType<typeof vi.fn>;
		cloudDelegationSteer: ReturnType<typeof vi.fn>;
	};
	connectionState: { activeSessionId?: string; sessionFile?: string; cwd: string } | undefined;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	showExtensionConfirm: ReturnType<typeof vi.fn>;
	startCloudProvisionLoader: ReturnType<typeof vi.fn>;
	stopCloudProvisionLoader: ReturnType<typeof vi.fn>;
}

type CloudCommandInteractiveMode = {
	handleCloudCommand(this: CloudCommandTestContext, args: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as CloudCommandInteractiveMode;

function makeContext(options: {
	capability?: boolean;
	sessions?: AgentConnectionCloudSession[];
	confirm?: boolean;
	connectionState?: CloudCommandTestContext["connectionState"];
}): CloudCommandTestContext {
	// Built on the prototype so the private command methods the handler
	// delegates to (handleCloudConvertCommand and friends) resolve like they
	// do on a real instance, while the own properties below supply the
	// per-test doubles.
	const context = Object.create(InteractiveMode.prototype) as CloudCommandTestContext;
	Object.assign(context, {
		agentConnection: {
			supportsCloudResidentSessions: () => options.capability ?? true,
			cloudSessionCreate: vi.fn(async () => cloudSession()),
			cloudSessionList: vi.fn(async () => options.sessions ?? []),
			cloudSessionStop: vi.fn(async () => cloudSession({ status: "stopped", connectivity: "stopped" })),
			cloudSessionReprovision: vi.fn(async () =>
				cloudSession({ status: "provisioning", connectivity: "provisioning", generation: 2 }),
			),
			cloudSessionImportResult: vi.fn(async () => cloudSession()),
			cloudDelegate: vi.fn(),
			cloudDelegationSteer: vi.fn(),
		},
		connectionState: options.connectionState ?? { activeSessionId: "active-1", cwd: "/tmp/project" },
		showStatus: vi.fn(),
		showError: vi.fn(),
		showExtensionConfirm: vi.fn(async () => options.confirm ?? true),
		startCloudProvisionLoader: vi.fn(),
		stopCloudProvisionLoader: vi.fn(),
	});
	return context;
}

describe("InteractiveMode /cloud", () => {
	it("converts the current idle session after a confirmation panel", async () => {
		const context = makeContext({ sessions: [] });

		await interactiveModePrototype.handleCloudCommand.call(context, "");

		expect(context.showExtensionConfirm).toHaveBeenCalledWith(
			"Convert to a cloud session",
			expect.stringContaining("Prime Sandbox"),
		);
		expect(context.agentConnection.cloudSessionCreate).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("resident"));
	});

	it("cancels the conversion when the confirm panel is dismissed", async () => {
		const context = makeContext({ sessions: [], confirm: false });

		await interactiveModePrototype.handleCloudCommand.call(context, "");

		expect(context.agentConnection.cloudSessionCreate).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Cloud conversion cancelled.");
		// Dismissal never starts the provisioning indicator, so nothing can linger.
		expect(context.startCloudProvisionLoader).not.toHaveBeenCalled();
		expect(context.stopCloudProvisionLoader).not.toHaveBeenCalled();
	});

	it("shows status instead of converting when the current session already runs in the cloud", async () => {
		const session = cloudSession();
		const context = makeContext({
			sessions: [session],
			connectionState: { sessionFile: "/tmp/shadow/sess_cloud_1.jsonl", cwd: "/tmp/project" },
		});

		await interactiveModePrototype.handleCloudCommand.call(context, "");

		expect(context.agentConnection.cloudSessionCreate).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining(session.sessionId));
	});

	it("requires the cloud_resident_sessions capability and degrades on old daemons", async () => {
		const context = makeContext({ capability: false });

		await interactiveModePrototype.handleCloudCommand.call(context, "");

		expect(context.showError).toHaveBeenCalledWith(
			"Cloud sessions need a daemon with the cloud_resident_sessions capability.",
		);
		expect(context.agentConnection.cloudSessionList).not.toHaveBeenCalled();
	});

	it("lists sessions for /cloud status with honest terminal states", async () => {
		const stopped = cloudSession({
			sessionId: "sess_cloud_stopped",
			activeSessionId: "cloud-active-stopped",
			sessionFile: "/tmp/shadow/sess_cloud_stopped.jsonl",
			status: "stopped",
			connectivity: "stopped",
		});
		const failed = cloudSession({
			sessionId: "sess_cloud_failed",
			activeSessionId: "cloud-active-failed",
			sessionFile: "/tmp/shadow/sess_cloud_failed.jsonl",
			status: "failed",
			lastError: "sandbox crashed",
		});
		const lost = cloudSession({
			sessionId: "sess_cloud_lost",
			activeSessionId: "cloud-active-lost",
			sessionFile: "/tmp/shadow/sess_cloud_lost.jsonl",
			status: "lost",
			connectivity: "lost",
		});
		const context = makeContext({ sessions: [stopped, failed, lost] });

		await interactiveModePrototype.handleCloudCommand.call(context, "status");

		const status = context.showStatus.mock.calls[0]?.[0] as string;
		expect(status).toContain("stopped · sandbox released");
		expect(status).toContain("failed · sandbox crashed");
		expect(status).toContain("lost · sandbox unavailable, transcript preserved");
		expect(status).not.toContain("tunnel down");
	});

	it("points /cloud status at conversion when there are no cloud sessions yet", async () => {
		const context = makeContext({ sessions: [] });

		await interactiveModePrototype.handleCloudCommand.call(context, "status");

		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("run /cloud in a new session"));
	});

	it("stops the current cloud session after confirmation", async () => {
		const session = cloudSession();
		const context = makeContext({
			sessions: [session],
			connectionState: { sessionFile: "/tmp/shadow/sess_cloud_1.jsonl", cwd: "/tmp/project" },
		});

		await interactiveModePrototype.handleCloudCommand.call(context, "stop");

		expect(context.showExtensionConfirm).toHaveBeenCalledWith("Stop cloud session", expect.any(String));
		expect(context.agentConnection.cloudSessionStop).toHaveBeenCalledWith("cloud-active-1", { forfeit: false });
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("sandbox released"));
	});

	it("stops a selected session with --forfeit", async () => {
		const session = cloudSession();
		const context = makeContext({ sessions: [session] });

		await interactiveModePrototype.handleCloudCommand.call(context, "stop sess_cloud_1 --forfeit");

		expect(context.agentConnection.cloudSessionStop).toHaveBeenCalledWith("cloud-active-1", { forfeit: true });
	});

	it("refuses to stop when no cloud session matches", async () => {
		const context = makeContext({ sessions: [] });

		await interactiveModePrototype.handleCloudCommand.call(context, "stop");

		expect(context.showError).toHaveBeenCalledWith("No current cloud session to stop.");
		expect(context.agentConnection.cloudSessionStop).not.toHaveBeenCalled();
	});

	it("reprovisions a stopped session after confirmation", async () => {
		const stopped = cloudSession({
			sessionId: "sess_cloud_stopped",
			activeSessionId: "cloud-active-stopped",
			sessionFile: "/tmp/shadow/sess_cloud_stopped.jsonl",
			status: "stopped",
			connectivity: "stopped",
		});
		const context = makeContext({ sessions: [stopped] });

		await interactiveModePrototype.handleCloudCommand.call(context, "reprovision sess_cloud_stopped");

		expect(context.showExtensionConfirm).toHaveBeenCalledWith(
			"Reprovision cloud session",
			expect.stringContaining("sess_cloud_stopped"),
		);
		expect(context.agentConnection.cloudSessionReprovision).toHaveBeenCalledWith("cloud-active-stopped");
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("provisioning"));
	});

	it("imports the result patch after confirmation", async () => {
		const session = cloudSession();
		const context = makeContext({ sessions: [session] });

		await interactiveModePrototype.handleCloudCommand.call(context, "import-result sess_cloud_1");

		expect(context.showExtensionConfirm).toHaveBeenCalledWith("Import cloud result", expect.any(String));
		expect(context.agentConnection.cloudSessionImportResult).toHaveBeenCalledWith("cloud-active-1");
	});

	it("removes /cloud run and /cloud steer from the slash surface", async () => {
		const runContext = makeContext({ sessions: [] });
		await interactiveModePrototype.handleCloudCommand.call(runContext, "run fix the bug");
		expect(runContext.showError).toHaveBeenCalledWith(
			"/cloud run was removed: run /cloud to convert this session, then prompt it directly.",
		);

		const steerContext = makeContext({ sessions: [] });
		await interactiveModePrototype.handleCloudCommand.call(steerContext, "steer sess_cloud_1 more");
		expect(steerContext.showError).toHaveBeenCalledWith(
			"/cloud steer was removed: prompts and steering work like any session once /cloud converted it.",
		);

		expect(runContext.agentConnection.cloudDelegate).not.toHaveBeenCalled();
		expect(steerContext.agentConnection.cloudDelegationSteer).not.toHaveBeenCalled();
	});

	it("renames the legacy apply verb to import-result", async () => {
		const context = makeContext({ sessions: [] });

		await interactiveModePrototype.handleCloudCommand.call(context, "apply sess_cloud_1");

		expect(context.showError).toHaveBeenCalledWith("/cloud apply was renamed: /cloud import-result [id]");
		expect(context.agentConnection.cloudSessionImportResult).not.toHaveBeenCalled();
	});

	it("shows usage for unknown verbs and flags", async () => {
		const unknownVerb = makeContext({ sessions: [] });
		await interactiveModePrototype.handleCloudCommand.call(unknownVerb, "explode");
		expect(unknownVerb.showError).toHaveBeenCalledWith(expect.stringContaining("Usage: /cloud"));

		const unknownFlag = makeContext({ sessions: [] });
		await interactiveModePrototype.handleCloudCommand.call(unknownFlag, "stop sess_1 --fire");
		expect(unknownFlag.showError).toHaveBeenCalledWith("Unknown /cloud option: --fire");
	});

	it("surfaces command failures without swallowing them", async () => {
		const context = makeContext({ sessions: [] });
		context.agentConnection.cloudSessionList.mockRejectedValue(new Error("daemon offline"));

		await interactiveModePrototype.handleCloudCommand.call(context, "status");

		expect(context.showError).toHaveBeenCalledWith("Cloud session command failed: daemon offline");
	});
});

describe("InteractiveMode /cloud conversion progress", () => {
	async function flushMicrotasks(ticks = 20): Promise<void> {
		for (let i = 0; i < ticks; i++) {
			await Promise.resolve();
		}
	}

	it("shows the provisioning indicator before the pending create resolves, then clears it and shows success", async () => {
		const context = makeContext({ sessions: [] });
		let resolveCreate: (session: AgentConnectionCloudSession) => void = () => {};
		context.agentConnection.cloudSessionCreate.mockImplementation(
			() =>
				new Promise<AgentConnectionCloudSession>((resolve) => {
					resolveCreate = resolve;
				}),
		);
		let commandSettled = false;
		const command = interactiveModePrototype.handleCloudCommand.call(context, "").finally(() => {
			commandSettled = true;
		});

		await flushMicrotasks();

		// The indicator starts while cloudSessionCreate is still pending.
		expect(context.agentConnection.cloudSessionCreate).toHaveBeenCalledTimes(1);
		expect(context.startCloudProvisionLoader).toHaveBeenCalledTimes(1);
		expect(context.startCloudProvisionLoader.mock.invocationCallOrder[0]).toBeLessThan(
			context.agentConnection.cloudSessionCreate.mock.invocationCallOrder[0]!,
		);
		expect(commandSettled).toBe(false);
		expect(context.stopCloudProvisionLoader).not.toHaveBeenCalled();

		resolveCreate(cloudSession());
		await command;

		// The indicator clears before the connected success replaces it.
		expect(context.stopCloudProvisionLoader).toHaveBeenCalledTimes(1);
		expect(context.stopCloudProvisionLoader.mock.invocationCallOrder[0]).toBeLessThan(
			context.showStatus.mock.invocationCallOrder[0]!,
		);
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("resident"));
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("clears the indicator and surfaces the failure when conversion rejects", async () => {
		const context = makeContext({ sessions: [] });
		context.agentConnection.cloudSessionCreate.mockRejectedValue(new Error("sandbox quota exceeded"));

		await interactiveModePrototype.handleCloudCommand.call(context, "");

		expect(context.startCloudProvisionLoader).toHaveBeenCalledTimes(1);
		expect(context.stopCloudProvisionLoader).toHaveBeenCalledTimes(1);
		expect(context.stopCloudProvisionLoader.mock.invocationCallOrder[0]).toBeLessThan(
			context.showError.mock.invocationCallOrder[0]!,
		);
		expect(context.showError).toHaveBeenCalledWith("Cloud session command failed: sandbox quota exceeded");
	});

	it("clears the indicator before the degraded-connection error", async () => {
		const context = makeContext({ sessions: [] });
		context.agentConnection.cloudSessionCreate.mockResolvedValue(undefined as unknown as AgentConnectionCloudSession);

		await interactiveModePrototype.handleCloudCommand.call(context, "");

		expect(context.startCloudProvisionLoader).toHaveBeenCalledTimes(1);
		expect(context.stopCloudProvisionLoader).toHaveBeenCalledTimes(1);
		expect(context.stopCloudProvisionLoader.mock.invocationCallOrder[0]).toBeLessThan(
			context.showError.mock.invocationCallOrder[0]!,
		);
		expect(context.showError).toHaveBeenCalledWith("Cloud sessions are unavailable on this connection.");
	});
});

describe("InteractiveMode cloud provisioning loader sync", () => {
	interface SyncContext {
		autoCompactionLoader: unknown;
		retryLoader: unknown;
		refineLoader: unknown;
		cloudProvisionLoader: { stop(): void };
		statusContainer: { children: { stop(): void }[]; clear(): void; addChild(child: { stop(): void }): void };
		isAgentCompacting(): boolean;
	}

	type SyncInteractiveMode = {
		syncWorkingLoader(this: SyncContext): void;
	};

	const syncPrototype = InteractiveMode.prototype as unknown as SyncInteractiveMode;

	function makeSyncContext(mounted: boolean): SyncContext {
		const loader = { stop: () => {} };
		return {
			autoCompactionLoader: undefined,
			retryLoader: undefined,
			refineLoader: undefined,
			cloudProvisionLoader: loader,
			statusContainer: {
				children: mounted ? [loader] : [],
				clear: vi.fn(),
				addChild: vi.fn(),
			},
			isAgentCompacting: () => false,
		};
	}

	it("remounts a cleared conversion loader while the create is still in flight", () => {
		const context = makeSyncContext(false);

		syncPrototype.syncWorkingLoader.call(context);

		expect(context.statusContainer.clear).toHaveBeenCalledTimes(1);
		expect(context.statusContainer.addChild).toHaveBeenCalledWith(context.cloudProvisionLoader);
	});

	it("leaves a mounted conversion loader in place", () => {
		const context = makeSyncContext(true);

		syncPrototype.syncWorkingLoader.call(context);

		expect(context.statusContainer.clear).not.toHaveBeenCalled();
		expect(context.statusContainer.addChild).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode cloud tray marker", () => {
	interface TrayContext {
		rosterBar: { summaries(): SessionSummary[]; dispose(): Promise<void> } | undefined;
		connectionState:
			| { sessionId?: string; sessionFile?: string; activeSessionId?: string; messageCount?: number; cwd: string }
			| undefined;
		options: Record<string, unknown>;
		subagentSnapshots: Map<string, unknown>;
	}

	type TrayInteractiveMode = {
		getCloudTrayLabel(this: TrayContext): string | undefined;
		getTrayLocationLabel(this: TrayContext): string | undefined;
	};

	const trayPrototype = InteractiveMode.prototype as unknown as TrayInteractiveMode;

	function makeTrayContext(options: {
		execution?: AgentConnectionCloudSession["connectivity"] | "local";
		sessionFile?: string;
	}): TrayContext {
		const summaries: SessionSummary[] = [
			{
				id: "cloud-row",
				activeSessionId: "cloud-row",
				lifecycle: "live",
				activity: "idle",
				isSessionActive: false,
				sessionId: "sess_cloud_1",
				sessionFile: options.sessionFile ?? "/tmp/shadow/sess_cloud_1.jsonl",
				cwd: "/tmp/project",
				isStreaming: false,
				isCompacting: false,
				attachedClients: 1,
				messageCount: 1,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				...(options.execution && options.execution !== "local"
					? { execution: { location: "cloud" as const, connectivity: options.execution } }
					: {}),
			},
		];
		// Built on the prototype so nested prototype methods resolve; own
		// properties below supply the per-test doubles.
		const context = Object.create(InteractiveMode.prototype) as TrayContext;
		Object.assign(context, {
			rosterBar: { summaries: () => summaries, dispose: async () => {} },
			connectionState: {
				sessionId: "sess_cloud_1",
				sessionFile: options.sessionFile ?? "/tmp/shadow/sess_cloud_1.jsonl",
				activeSessionId: "cloud-row",
				messageCount: 1,
				cwd: "/tmp/project",
			},
			options: {},
			subagentSnapshots: new Map(),
		});
		return context;
	}

	it("shows the cloud marker with live connectivity for the current session", () => {
		expect(trayPrototype.getCloudTrayLabel.call(makeTrayContext({ execution: "connected" }))).toBe("cloud");
		expect(trayPrototype.getCloudTrayLabel.call(makeTrayContext({ execution: "provisioning" }))).toBe(
			"cloud provisioning",
		);
		expect(trayPrototype.getCloudTrayLabel.call(makeTrayContext({ execution: "reconnecting" }))).toBe(
			"cloud reconnecting",
		);
		expect(trayPrototype.getCloudTrayLabel.call(makeTrayContext({ execution: "disconnected" }))).toBe(
			"cloud disconnected",
		);
		// Terminal states keep the honest wording, never a generic tunnel failure.
		expect(trayPrototype.getCloudTrayLabel.call(makeTrayContext({ execution: "stopped" }))).toBe(
			"cloud · sandbox released",
		);
		expect(trayPrototype.getCloudTrayLabel.call(makeTrayContext({ execution: "lost" }))).toBe("cloud · sandbox lost");
	});

	it("renders no cloud marker for local sessions and absent rosters", () => {
		expect(trayPrototype.getCloudTrayLabel.call(makeTrayContext({ execution: "local" }))).toBeUndefined();

		const noRoster = makeTrayContext({ execution: "connected" });
		noRoster.rosterBar = undefined;
		expect(trayPrototype.getCloudTrayLabel.call(noRoster)).toBeUndefined();

		const unlisted = makeTrayContext({ execution: "connected" });
		unlisted.connectionState = {
			sessionId: "sess_local_9",
			sessionFile: "/tmp/plain.jsonl",
			activeSessionId: "active-9",
			messageCount: 1,
			cwd: "/tmp/project",
		};
		expect(trayPrototype.getCloudTrayLabel.call(unlisted)).toBeUndefined();
	});

	it("includes the cloud marker in the current session tray label", () => {
		const cloud = makeTrayContext({ execution: "reconnecting" });
		expect(trayPrototype.getTrayLocationLabel.call(cloud)).toContain("cloud reconnecting");

		const local = makeTrayContext({ execution: "local" });
		const label = trayPrototype.getTrayLocationLabel.call(local);
		expect(label).toBeDefined();
		expect(label).not.toContain("cloud");
	});
});
