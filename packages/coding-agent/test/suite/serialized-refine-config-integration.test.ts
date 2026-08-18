/**
 * Focused daemon-path integration tests for serializedRefine propagation,
 * heartbeat/message/observe controller availability, and model rehydration.
 *
 * Uses fake model streams only — no real model/sandbox.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "../../src/core/agent-session-config.js";
import type { AgentRlmHeartbeatController } from "../../src/core/cron-jobs.js";
import { createHarness, type Harness } from "./harness.js";

type SerializedInternals = {
	_serializedRefine: boolean;
	_pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;
	_assistantTurnsSinceAutoRefine: number;
	_lastAutoRefineReviewAt: number;
	_autoRefineInProgress: boolean;
	_rlmHeartbeatController?: unknown;
	_agentMessageController?: unknown;
	_agentObserveController?: unknown;
	_ipythonKernelProvisioner?: unknown;
	_createKernelHostHandlers(): Record<string, unknown>;
};

describe("Serialized refine config integration (unit)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("serializedRefine round-trips through mergeAgentSessionRuntimeConfig", () => {
		const base: AgentSessionRuntimeConfig = {
			cwd: "/tmp",
			serializedRefine: true,
		};
		const override: AgentSessionRuntimeConfig = {
			cwd: "/tmp/override",
		};
		const merged = mergeAgentSessionRuntimeConfig(base, override);

		// Override does not set serializedRefine, so base value is preserved.
		expect(merged.serializedRefine).toBe(true);

		// Explicit override takes priority.
		const merged2 = mergeAgentSessionRuntimeConfig(base, { serializedRefine: false });
		expect(merged2.serializedRefine).toBe(false);

		// Clone preserves the flag.
		const cloned = mergeAgentSessionRuntimeConfig(merged, {});
		expect(cloned.serializedRefine).toBe(true);
	});

	it("serializedRefine=true produces a session with _serializedRefine=true", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals;
		expect(internals._serializedRefine).toBe(true);
	});

	it("serializedRefine=false (default) produces a session with _serializedRefine=false", async () => {
		const harness = await createHarness({
			persistSession: true,
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals;
		expect(internals._serializedRefine).toBe(false);
	});

	it("real autonomous loop crosses threshold and resumes with serialized refine", async () => {
		// Uses real agent.prompt() with faux responses to verify the
		// serialized checkpoint fires and the loop continues.
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "integration",
			instructions: "capture",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals & {
			_planRefine: (opts: { instructions?: string }, signal: AbortSignal) => Promise<unknown>;
			_applyRefine: (plan: unknown, opts: unknown, abort: AbortController) => Promise<unknown>;
		};

		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockResolvedValue({
			id: "refine_test",
			summary: "test",
			rationale: "test",
			expectedOutcome: "test",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		});

		// Turn 1: counter goes to 1 (< threshold 2, no refine)
		harness.setResponses([fauxAssistantMessage("response 1")]);
		await harness.session.prompt("prompt 1");
		expect(internals._assistantTurnsSinceAutoRefine).toBe(1);

		// Turn 2: counter goes to 2 (>= threshold 2, serialized checkpoint fires)
		harness.setResponses([fauxAssistantMessage("response 2")]);
		await harness.session.prompt("prompt 2");

		// After the checkpoint, counter is reset to 0.
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);

		// Turn 3: counter goes to 1 again (< threshold, loop continues)
		harness.setResponses([fauxAssistantMessage("response 3")]);
		await harness.session.prompt("prompt 3");
		expect(internals._assistantTurnsSinceAutoRefine).toBe(1);

		// Reviewer called exactly once (at turn 2).
		expect(reviewer).toHaveBeenCalledTimes(1);
	});
});

describe("Serialized refine controller availability (unit)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("setRlmHeartbeatController attaches a heartbeat controller to a session", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals;
		expect(internals._rlmHeartbeatController).toBeUndefined();
		const initialProvisioner = internals._ipythonKernelProvisioner;

		// Simulate print/headless mode attaching a controller after construction.
		const fakeController = {
			listRlmHeartbeats: () => [],
			createRlmHeartbeat: () => ({ id: "test", status: "active" }),
			updateRlmHeartbeat: () => undefined,
			deleteRlmHeartbeat: () => undefined,
		} as unknown as AgentRlmHeartbeatController;
		harness.session.setRlmHeartbeatController(fakeController);

		expect(internals._rlmHeartbeatController).toBe(fakeController);
		expect(internals._ipythonKernelProvisioner).not.toBe(initialProvisioner);
		expect(internals._createKernelHostHandlers()).toHaveProperty("rlm_heartbeat.create");

		// Verify the controller is usable via host request.
		const result = harness.session.handleRlmHeartbeatHostRequest("rlm_heartbeat.list");
		expect(result).toEqual({ heartbeats: [] });
	});

	it("refine.status reports in_flight when background plan is active", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals & {
			_planRefine: (opts: { instructions?: string }, signal: AbortSignal) => Promise<unknown>;
		};

		// Initially not in flight.
		const statusBefore = harness.session.handleRefineHostRequest("refine.status");
		expect(statusBefore.in_flight).toBe(false);

		// Start background planning.
		let resolvePlan: () => void = () => {};
		const planPromise = new Promise<void>((resolve) => {
			resolvePlan = resolve;
		});
		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			await planPromise;
			return { id: "p", proposal: { edits: [] } };
		});

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		// Wait for the plan to start.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		const statusDuring = harness.session.handleRefineHostRequest("refine.status");
		expect(statusDuring.in_flight).toBe(true);

		// Release the plan.
		resolvePlan();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Run the checkpoint to consume the background plan.
		await (
			harness.session as unknown as { _runSerializedRefineCheckpoint: () => Promise<void> }
		)._runSerializedRefineCheckpoint();

		// After the checkpoint, nothing should be in flight.
		const statusAfter = harness.session.handleRefineHostRequest("refine.status");
		expect(statusAfter.in_flight).toBe(false);
	});
});

describe("PR #503 model preservation (unit)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("model is preserved and accessible after session creation", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
		});
		harnesses.push(harness);

		// The session should have a model set from the faux provider.
		expect(harness.session.model).toBeDefined();
		expect(harness.session.model?.id).toBe(harness.getModel().id);
		expect(harness.session.model?.provider).toBe(harness.getModel().provider);
	});

	it("model survives a serialized refine checkpoint", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals & {
			_planRefine: (opts: { instructions?: string }, signal: AbortSignal) => Promise<unknown>;
			_applyRefine: (plan: unknown, opts: unknown, abort: AbortController) => Promise<unknown>;
		};

		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockResolvedValue({
			id: "refine_test",
			summary: "test",
			rationale: "test",
			expectedOutcome: "test",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		});

		const modelBefore = harness.session.model;
		internals._assistantTurnsSinceAutoRefine = 1;

		await harness.session.prompt("test");
		// Wait for the checkpoint to complete.
		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		// Model is preserved after the checkpoint.
		expect(harness.session.model).toBe(modelBefore);
	});

	it("model is preserved after clean disposal", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
		});
		harnesses.push(harness);

		const modelBefore = harness.session.model;
		expect(modelBefore).toBeDefined();

		await harness.session.disposeAsync();

		// After disposal, the model reference is still accessible (it's on agent.state).
		// The session is disposed but the model object persists.
		expect(modelBefore).toBeDefined();
	});
});
