import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.js";
import { startSideQuestion } from "../../../src/core/side-question.js";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import {
	createDaemonCommandEnvelope,
	type DaemonCommand,
	type DaemonResponse,
} from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../../../src/modes/daemon/mutation-drain-latch.js";
import { createHarness } from "../harness.js";

const fastModel = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	models: [{ id: "gpt-5.4" }],
};

interface SupervisorHarness {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
}

describe("ENG-4620 fast mode child agents", () => {
	it("allows service-tier changes through the daemon supervisor", async () => {
		const handleCommand = vi.fn(
			async (_client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse> => ({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
			}),
		);
		const write = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			ownership: { assertCurrent: vi.fn(async () => undefined) },
			workers: new Map(),
			clients: new Set(),
			protocolClientIds: new WeakMap(),
			mutationDrain: new MutationDrainLatch(),
			commandJournal: {
				lookup: vi.fn(() => undefined),
				begin: vi.fn(() => ({ status: "new" })),
				recordResult: vi.fn(),
				acknowledge: vi.fn(),
			},
			handleCommand,
			write,
			log: vi.fn(),
		}) as SupervisorHarness;
		const client = { id: "client-1" } as DaemonSocketClient;
		const command = {
			id: "tier-1",
			type: "set_service_tier",
			activeSessionId: "active-1",
			serviceTier: "priority",
		} satisfies DaemonCommand;

		await supervisor.handleLine(client, JSON.stringify(createDaemonCommandEnvelope(command, command.id)));

		expect(handleCommand.mock.calls[0]?.slice(0, 2)).toEqual([client, command]);
		expect(write).toHaveBeenCalledWith(
			client,
			expect.objectContaining({ command: "set_service_tier", success: true }),
		);
	});

	it("passes fast mode to side questions", async () => {
		const harness = await createHarness(fastModel);
		try {
			harness.session.setServiceTier("priority");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("side answer");
				},
			]);

			const run = startSideQuestion(harness.session.agent, "question-1", "Check fast mode", () => {});
			await run.done;
		} finally {
			harness.cleanup();
		}
	});

	it("passes and persists fast mode for inline RLM children", async () => {
		const harness = await createHarness({ ...fastModel, persistSession: true });
		try {
			harness.session.setServiceTier("priority");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("child answer");
				},
			]);

			const result = await harness.session.runRlmChild("Check fast mode");
			expect(result.rlm_child_id).toMatch(/^sub-/);
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.getLastAssistantText()).toBe(
					"child answer",
				);
			});
			expect(result.session_dir).not.toBeNull();
			const childSessions = await SessionManager.list(harness.tempDir, result.session_dir!);
			const childSession = SessionManager.open(childSessions[0]!.path, result.session_dir!);
			expect(childSession.buildSessionContext().serviceTier).toBe("priority");
		} finally {
			harness.cleanup();
		}
	});
});
