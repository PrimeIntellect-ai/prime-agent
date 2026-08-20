import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createDefaultPrimeWorkflowWorkerLauncher,
	resolveWorkerModelForComputeClass,
} from "../src/core/agent-session-services.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { WORKFLOW_COMPUTE_CLASSES } from "../src/core/workflow/default-task-runtime.js";

const TIERS = {
	cheap: "openrouter/google/gemma-4-31b-it:free",
	standard: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
	deep: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
} as const;
const DEFAULT_SELECTOR = "openai-codex/gpt-5.6-luna";

describe("compute class routing", () => {
	it("routes each declared tier to its configured model", () => {
		for (const tier of WORKFLOW_COMPUTE_CLASSES) {
			expect(resolveWorkerModelForComputeClass(tier, TIERS, DEFAULT_SELECTOR)).toBe(TIERS[tier]);
		}
	});

	it("uses the session default when a task declares no tier", () => {
		expect(resolveWorkerModelForComputeClass(undefined, TIERS, DEFAULT_SELECTOR)).toBe(DEFAULT_SELECTOR);
	});

	it("falls back rather than failing when a tier has no configured model", () => {
		expect(resolveWorkerModelForComputeClass("deep", { cheap: TIERS.cheap }, DEFAULT_SELECTOR)).toBe(
			DEFAULT_SELECTOR,
		);
		expect(resolveWorkerModelForComputeClass("cheap", undefined, DEFAULT_SELECTOR)).toBe(DEFAULT_SELECTOR);
	});

	it("never silently upgrades a cheap task to the deep model", () => {
		expect(resolveWorkerModelForComputeClass("cheap", TIERS, DEFAULT_SELECTOR)).not.toBe(TIERS.deep);
	});
});

describe("compute class tier configuration", () => {
	const testDir = join(process.cwd(), "test-compute-class-routing-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("carries an operator-configured tier map from settings.json through the launcher to the worker session", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ workflowWorkerModelsByComputeClass: TIERS }));
		const settingsManager = SettingsManager.create(projectDir, agentDir);
		expect(settingsManager.getWorkflowWorkerModelsByComputeClass()).toEqual(TIERS);

		const session = {
			cancelRlmChildRun: vi.fn(() => true),
			awaitRlmChildCompletion: vi.fn(async () => ({
				status: "completed" as const,
				output: "deep-tier result",
				error: null,
				retryable: false,
			})),
			runWorkflowRlmChild: vi.fn(async () => ({
				rlm_child_id: "child-deep",
				name: "deep-worker",
				session_dir: "/tmp/deep-worker",
				model: TIERS.deep,
			})),
		};
		const launcher = createDefaultPrimeWorkflowWorkerLauncher({
			session,
			workerModel: DEFAULT_SELECTOR,
			workerModelsByComputeClass: settingsManager.getWorkflowWorkerModelsByComputeClass(),
		});
		await launcher({
			workflowId: "workflow-deep",
			taskId: "task-deep",
			attemptId: "attempt-deep",
			executionKey: "execution-deep",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			prompt: "deep task",
			taskCapsule: { capsuleDigest: "capsule-digest-deep" } as never,
			sessionName: "deep-worker",
			computeClass: "deep",
			reportHeartbeat: vi.fn(async () => undefined),
		});

		expect(session.runWorkflowRlmChild).toHaveBeenCalledWith(
			"deep task",
			"deep-worker",
			TIERS.deep,
			expect.anything(),
			expect.any(Function),
			// Sixth argument is the capability-derived tool allowlist; undefined when the task
			// declares no authority, which is the case for this fixture.
			undefined,
		);
	});
});
