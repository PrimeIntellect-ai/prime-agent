import { describe, expect, it, vi } from "vitest";
import {
	createHostRequestGateway,
	type HostRequestHandlers,
	installHostRequestCapabilityContext,
	installHostRequestCapabilityResolver,
} from "../src/core/kernel/index.js";

const NOW = 1_700_000_000_000;

function handlers(
	entries: HostRequestHandlers,
	capabilities: Parameters<typeof installHostRequestCapabilityContext>[1] = { capabilities: [] },
): HostRequestHandlers {
	return installHostRequestCapabilityContext(entries, capabilities);
}

describe("kernel host request gateway", () => {
	it("keeps ordinary safe reads compatible while nesting handler output", async () => {
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"model.info": async () => ({ id: "model-1", provider: "test" }),
			}),
			now: () => NOW,
		});

		await expect(gateway.dispatch({ type: "model.info" })).resolves.toEqual({
			status: "ok",
			result: { id: "model-1", provider: "test" },
		});
	});

	it("rejects an arbitrary mutating goal call without a host capability", async () => {
		let calls = 0;
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"goal.complete": async () => {
					calls += 1;
					return { completed: true };
				},
			}),
		});

		await expect(gateway.dispatch({ type: "goal.complete" })).rejects.toThrow(/capability/i);
		expect(calls).toBe(0);
	});

	it("defaults unannotated handler tables to the capability-gated path", async () => {
		const gateway = createHostRequestGateway({
			handlers: { "goal.complete": async () => ({ completed: true }) },
		});

		await expect(gateway.dispatch({ type: "goal.complete" })).rejects.toThrow(/capability/i);
	});

	it("rejects an arbitrary mutating refinement call without a host capability", async () => {
		const gateway = createHostRequestGateway({
			handlers: handlers({ "refine.run": async () => ({ scheduled: true }) }),
		});

		await expect(gateway.dispatch({ type: "refine.run", instructions: "rewrite everything" })).rejects.toThrow(
			/capability/i,
		);
	});

	it("does not accept a caller-supplied capability field", async () => {
		const gateway = createHostRequestGateway({
			handlers: handlers({ "goal.complete": async () => ({ completed: true }) }),
		});

		await expect(
			gateway.dispatch({
				type: "goal.complete",
				capability: { capabilities: ["goal.complete"], workflowId: "spoofed" },
			}),
		).rejects.toThrow(/capability/i);
	});

	it("rejects a million-character field before invoking the handler", async () => {
		let calls = 0;
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"refine.run": async () => {
					calls += 1;
					return { scheduled: true };
				},
			}),
		});

		await expect(gateway.dispatch({ type: "refine.run", instructions: "x".repeat(1_000_000) })).rejects.toThrow(
			/large|bound|size/i,
		);
		expect(calls).toBe(0);
	});

	it("rejects ten thousand evidence references before invoking the handler", async () => {
		let calls = 0;
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"autoresearch.run": async () => {
					calls += 1;
					return { output_kind: "evidence" };
				},
			}),
		});

		await expect(
			gateway.dispatch({
				type: "autoresearch.run",
				recipe_digest: "recipe",
				evidence_refs: Array.from({ length: 10_000 }, () => ({ digest: "evidence" })),
			}),
		).rejects.toThrow(/reference|bound|large|value/i);
		expect(calls).toBe(0);
	});

	it("rejects a huge recall limit before invoking the handler", async () => {
		let calls = 0;
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"mempalace.recall": async () => {
					calls += 1;
					return { output_kind: "evidence" };
				},
			}),
		});

		await expect(
			gateway.dispatch({ type: "mempalace.recall", query: "deploy", limit: Number.MAX_SAFE_INTEGER }),
		).rejects.toThrow(/limit|bound|integer/i);
		expect(calls).toBe(0);
	});

	it("rejects unknown gateway versions before invoking the handler", async () => {
		let calls = 0;
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"model.info": async () => {
					calls += 1;
					return { id: "model-1" };
				},
			}),
		});

		await expect(gateway.dispatch({ type: "model.info", version: 99 })).rejects.toThrow(/version/i);
		expect(calls).toBe(0);
	});

	it("keeps protocol status host-owned when a handler returns status data", async () => {
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"model.info": async () => ({ status: "error", id: "model-1" }),
			}),
		});

		await expect(gateway.dispatch({ type: "model.info" })).resolves.toEqual({
			status: "ok",
			result: { status: "error", id: "model-1" },
		});
	});

	it("snapshots handler registrations so post-install substitution cannot take effect", async () => {
		const registered: HostRequestHandlers = handlers({
			"model.info": async () => ({ id: "original" }),
		});
		const gateway = createHostRequestGateway({ handlers: registered });
		registered["model.info"] = async () => ({ id: "substituted" });

		await expect(gateway.dispatch({ type: "model.info" })).resolves.toMatchObject({
			status: "ok",
			result: { id: "original" },
		});
	});

	it("rejects replayed and expired mutating capabilities", async () => {
		const replayGateway = createHostRequestGateway({
			handlers: handlers(
				{ "goal.complete": async () => ({ completed: true }) },
				{
					workflowId: "workflow-1",
					decisionId: "decision-1",
					decisionRevision: 1,
					capabilities: ["goal.complete"],
					expiresAt: NOW + 60_000,
					nonce: "once",
				},
			),
			now: () => NOW,
		});

		await expect(replayGateway.dispatch({ type: "goal.complete" })).resolves.toMatchObject({ status: "ok" });
		await expect(replayGateway.dispatch({ type: "goal.complete" })).rejects.toThrow(/replay|used|capability/i);

		const expiredGateway = createHostRequestGateway({
			handlers: handlers(
				{ "goal.complete": async () => ({ completed: true }) },
				{
					workflowId: "workflow-1",
					decisionId: "decision-1",
					decisionRevision: 1,
					capabilities: ["goal.complete"],
					expiresAt: NOW - 1,
					nonce: "expired",
				},
			),
			now: () => NOW,
		});

		await expect(expiredGateway.dispatch({ type: "goal.complete" })).rejects.toThrow(/expired|capability/i);
	});

	it("revokes a mutating request when its capability expires during the handler", async () => {
		let now = NOW;
		const gateway = createHostRequestGateway({
			handlers: handlers(
				{
					"goal.complete": async (_payload, context) => {
						now += 2;
						expect(context?.isCurrent()).toBe(false);
						return { completed: true };
					},
				},
				{
					workflowId: "workflow-1",
					decisionId: "decision-1",
					decisionRevision: 1,
					capabilities: ["goal.complete"],
					expiresAt: NOW + 1,
					nonce: "expires-during-handler",
				},
			),
			now: () => now,
		});

		await expect(gateway.dispatch({ type: "goal.complete" })).rejects.toThrow(/expired|revoked|authority/i);
	});

	it("renews an in-flight mutating request only while the durable decision remains current", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		try {
			let resolutions = 0;
			let decisionCurrent = true;
			const gateway = createHostRequestGateway({
				handlers: {
					"goal.complete": async (_payload, context) => {
						await vi.advanceTimersByTimeAsync(11);
						decisionCurrent = false;
						await vi.advanceTimersByTimeAsync(1);
						expect(context?.isCurrent()).toBe(true);
						return { completed: true };
					},
				},
				capabilityResolver: () => {
					resolutions += 1;
					return decisionCurrent
						? {
								workflowId: "workflow-1",
								decisionId: "decision-1",
								decisionRevision: 1,
								capabilities: ["goal.complete"],
								expiresAt: Date.now() + 10,
								nonce: `renewal-${resolutions}`,
							}
						: { capabilities: [] };
				},
			});

			await expect(gateway.dispatch({ type: "goal.complete" })).resolves.toMatchObject({ status: "ok" });
			expect(resolutions).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("revokes an in-flight request when renewal observes a different durable decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		try {
			let decisionRevision = 1;
			const gateway = createHostRequestGateway({
				handlers: {
					"goal.complete": async () => {
						decisionRevision = 2;
						await vi.advanceTimersByTimeAsync(6);
						return { completed: true };
					},
				},
				capabilityResolver: () => ({
					workflowId: "workflow-1",
					decisionId: "decision-1",
					decisionRevision,
					capabilities: ["goal.complete"],
					expiresAt: Date.now() + 10,
					nonce: `decision-${decisionRevision}`,
				}),
			});

			await expect(gateway.dispatch({ type: "goal.complete" })).rejects.toThrow(/revoked|authority/i);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves host authority from current state for each mutating request", async () => {
		let revision = 1;
		const registered = installHostRequestCapabilityResolver(
			{
				"goal.create": async () => {
					revision = 2;
					return { created: true };
				},
				"goal.complete": async () => ({ completed: true }),
			},
			(type) => ({
				workflowId: "workflow-1",
				decisionId: `goal-${revision}`,
				decisionRevision: revision,
				capabilities: [type],
				expiresAt: NOW + 60_000,
				nonce: `goal-${revision}:${type}`,
			}),
		);
		const gateway = createHostRequestGateway({ handlers: registered, now: () => NOW });

		await expect(gateway.dispatch({ type: "goal.create", objective: "durable objective" })).resolves.toMatchObject({
			status: "ok",
		});
		await expect(gateway.dispatch({ type: "goal.complete" })).resolves.toMatchObject({ status: "ok" });
		await expect(gateway.dispatch({ type: "goal.complete" })).rejects.toThrow(/replay|used|capability/i);
	});

	it("keeps native workflow descriptors explicitly unavailable until injected", async () => {
		const gateway = createHostRequestGateway({ handlers: handlers({}) });

		await expect(
			gateway.dispatch({ type: "workflow.v1.autoresearch.run", recipe_digest: "recipe", evidence_refs: [] }),
		).rejects.toThrow(/unavailable/i);
		await expect(
			gateway.dispatch({ type: "workflow.v1.mempalace.recall", query: "deploy", limit: 1 }),
		).rejects.toThrow(/unavailable/i);
		await expect(
			gateway.dispatch({
				type: "workflow.v1.mempalace.propose",
				knowledge_kind: "how",
				source_evidence_refs: [
					{
						artifact_id: "evidence-1",
						relative_path: "evidence.json",
						digest: "a".repeat(64),
						size_bytes: 1,
						source_event_sequence: 1,
					},
				],
			}),
		).rejects.toThrow(/unavailable|reference/i);
		await expect(gateway.dispatch({ type: "workflow.v1.execution_evidence.read" })).rejects.toThrow(/unavailable/i);
	});

	it("allows repeatable read-only access to injected execution evidence", async () => {
		let calls = 0;
		const gateway = createHostRequestGateway({
			handlers: handlers({
				"workflow.v1.execution_evidence.read": async () => {
					calls += 1;
					return { observation_count: 2, can_authorize: false };
				},
			}),
		});

		await expect(gateway.dispatch({ type: "execution_evidence.read" })).resolves.toMatchObject({
			status: "ok",
			result: { observation_count: 2, can_authorize: false },
		});
		await expect(gateway.dispatch({ type: "workflow.v1.execution_evidence.read" })).resolves.toMatchObject({
			status: "ok",
		});
		expect(calls).toBe(2);
	});

	it("fails closed for unknown request types even when a handler is supplied", async () => {
		const gateway = createHostRequestGateway({
			handlers: handlers({ "arbitrary.host.effect": async () => ({ ok: true }) }),
		});

		await expect(gateway.dispatch({ type: "arbitrary.host.effect" })).rejects.toThrow(
			/not available|not registered|unknown/i,
		);
	});
});
