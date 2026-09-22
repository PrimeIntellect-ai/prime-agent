import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.js";

const provider = "faux-eng-subagent-default-model";

describe("subagent default model setting", () => {
	it("resolves unpinned spawns against subagentDefaultModel", { timeout: 30_000 }, async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
			settings: { subagentDefaultModel: `${provider}/child-model` },
		});
		try {
			harness.setResponses([fauxAssistantMessage("child answer")]);

			const result = await harness.session.runRlmChild("do the work");

			expect(result.model).toBe(`${provider}/child-model`);
			await vi.waitFor(
				async () => {
					const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
					expect(childEntry?.status).toBe("completed");
					expect(harness.session.getRlmChildSession(childEntry!.rlm_child_id)?.model?.id).toBe("child-model");
				},
				{ timeout: 10_000 },
			);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps an explicit spawn model ahead of subagentDefaultModel", { timeout: 30_000 }, async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
			settings: { subagentDefaultModel: `${provider}/child-model` },
		});
		try {
			harness.setResponses([fauxAssistantMessage("parent answer")]);

			const result = await harness.session.runRlmChild("do the work", { model: `${provider}/parent-model` });

			expect(result.model).toBe(`${provider}/parent-model`);
			await vi.waitFor(
				async () => {
					const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
					expect(childEntry?.status).toBe("completed");
					expect(harness.session.getRlmChildSession(childEntry!.rlm_child_id)?.model?.id).toBe("parent-model");
				},
				{ timeout: 10_000 },
			);
		} finally {
			harness.cleanup();
		}
	});

	it("fails an unpinned spawn when the configured default is unavailable", { timeout: 30_000 }, async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }],
			settings: { subagentDefaultModel: `${provider}/missing-model` },
		});
		try {
			await expect(harness.session.runRlmChild("do the work")).rejects.toThrow(
				`Requested subagent model "${provider}/missing-model" is unavailable, unauthenticated, or expired`,
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("fails an unpinned spawn when the configured parent-model default is stale", { timeout: 30_000 }, async () => {
		// A default naming the parent model must pass the same availability and
		// authentication preflight as any other reference; the parent-model
		// equality shortcut would start a child that fails its model request.
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
			settings: { subagentDefaultModel: `${provider}/parent-model` },
		});
		try {
			expect(harness.session.modelRegistry.markProviderAuthStale(provider)).toBe(true);
			expect(harness.session.modelRegistry.markProviderAuthStale(provider)).toBe(true);
			expect(harness.session.modelRegistry.getProviderAuthStatus(provider)).toMatchObject({
				source: "stale",
				label: "expired",
			});
			harness.setResponses([fauxAssistantMessage("child answer")]);

			await expect(harness.session.runRlmChild("do the work")).rejects.toThrow(
				`Requested subagent model "${provider}/parent-model" is unavailable, unauthenticated, or expired`,
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("inherits the parent model when no default is configured", { timeout: 30_000 }, async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		try {
			harness.setResponses([fauxAssistantMessage("parent answer")]);

			const result = await harness.session.runRlmChild("do the work");

			expect(result.model).toBe(`${provider}/parent-model`);
			await vi.waitFor(
				async () => {
					const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
					expect(childEntry?.status).toBe("completed");
				},
				{ timeout: 10_000 },
			);
		} finally {
			harness.cleanup();
		}
	});

	it("treats a non-string subagentDefaultModel setting as unset on unpinned spawns", { timeout: 30_000 }, async () => {
		// Corrupted settings (e.g. 42) must degrade to "unset" in the spawn hot
		// path: the child inherits the parent model instead of throwing.
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
			settings: { subagentDefaultModel: 42 as unknown as string },
		});
		try {
			harness.setResponses([fauxAssistantMessage("parent answer")]);

			const result = await harness.session.runRlmChild("do the work");

			expect(result.model).toBe(`${provider}/parent-model`);
			await vi.waitFor(
				async () => {
					const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
					expect(childEntry?.status).toBe("completed");
				},
				{ timeout: 10_000 },
			);
		} finally {
			harness.cleanup();
		}
	});
});
