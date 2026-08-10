import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createRlmRunHostHandler } from "../src/core/rlm-runtime.js";
import {
	parseSwarmRolePolicy,
	projectSwarmRoleMetadata,
	resolveSwarmRoleAssignment,
	validateSwarmSharedContext,
} from "../src/core/swarm-role-policy.js";

const policy = {
	version: 1,
	modelProfiles: { neutral_profile: { model: "neutral/provider-model", thinkingLevel: "high" } },
	roles: {
		reviewer_1: {
			modelProfile: "neutral_profile",
			decisionScopes: ["review"],
			implementationScopes: ["patch"],
			allowedToolNames: ["read"],
			delegableRoleIds: [],
			instructions: "Review only.",
			sharedContext: { maxItems: 2, maxBytes: 200, allowedKinds: ["note"] },
		},
	},
};
const model = { provider: "neutral", id: "provider-model" } as Model<Api>;

describe("swarm role policy", () => {
	it("canonicalizes authority independent of object key order", () => {
		const first = parseSwarmRolePolicy(policy);
		const second = parseSwarmRolePolicy({ roles: policy.roles, modelProfiles: policy.modelProfiles, version: 1 });
		expect(first.digest).toBe(second.digest);
		expect(
			parseSwarmRolePolicy({
				...policy,
				roles: { ...policy.roles, reviewer_1: { ...policy.roles.reviewer_1, decisionScopes: [] } },
			}).digest,
		).not.toBe(first.digest);
	});

	it("fails closed for __proto__ and preserves prototype-named profile identifiers", () => {
		const protoProfiles = JSON.parse(
			'{"__proto__":{"model":"neutral/provider-model","thinkingLevel":"high"}}',
		) as Record<string, unknown>;
		expect(() => parseSwarmRolePolicy({ ...policy, modelProfiles: protoProfiles })).toThrow("model profile ID");
		for (const profileId of ["constructor", "prototype"]) {
			const snapshot = parseSwarmRolePolicy({
				...policy,
				modelProfiles: { [profileId]: { model: "neutral/provider-model", thinkingLevel: "high" } },
				roles: { reviewer_1: { ...policy.roles.reviewer_1, modelProfile: profileId } },
			});
			expect(Object.hasOwn(snapshot.policy.modelProfiles, profileId)).toBe(true);
			expect(snapshot.policy.modelProfiles[profileId]?.model).toBe("neutral/provider-model");
		}
		const ordinary = parseSwarmRolePolicy(policy);
		const cloned = parseSwarmRolePolicy({
			...policy,
			modelProfiles: JSON.parse(JSON.stringify(policy.modelProfiles)) as Record<string, unknown>,
		});
		expect(cloned.digest).toBe(ordinary.digest);
	});

	it("resolves only an exact authenticated selector and parent tool intersection", () => {
		const snapshot = parseSwarmRolePolicy(policy);
		const assignment = resolveSwarmRoleAssignment({
			snapshot,
			assignmentId: "assignment-1",
			role: "reviewer_1",
			decisionScopes: ["review"],
			implementationScopes: ["patch"],
			sharedContext: [{ kind: "note", text: "untrusted" }],
			models: [model],
			parentToolNames: ["read", "write"],
		});
		expect(assignment.model).toBe("neutral/provider-model");
		expect(assignment.allowedToolNames).toEqual(["read"]);
		expect(() =>
			resolveSwarmRoleAssignment({
				...{ snapshot, assignmentId: "a", role: "reviewer_1", models: [model], parentToolNames: [] },
				decisionScopes: [],
			}),
		).toThrow("unavailable to parent");
		expect(() =>
			resolveSwarmRoleAssignment({
				snapshot,
				assignmentId: "a",
				role: "reviewer_1",
				models: [{ ...model, id: "provider-model-v2" }],
				parentToolNames: ["read"],
			}),
		).toThrow("exactly available");
	});

	it("fails closed for duplicate grants, malformed values, nested escalation, and oversized context", () => {
		expect(() =>
			parseSwarmRolePolicy({ ...policy, roles: { ...policy.roles, default: policy.roles.reviewer_1 } }),
		).toThrow("reserved");
		expect(() =>
			parseSwarmRolePolicy({
				...policy,
				roles: {
					...policy.roles,
					reviewer_1: { ...policy.roles.reviewer_1, decisionScopes: ["review", "review"] },
				},
			}),
		).toThrow("duplicate");
		const snapshot = parseSwarmRolePolicy(policy);
		expect(() =>
			validateSwarmSharedContext(
				[{ kind: "note", text: "x".repeat(201) }],
				snapshot.policy.roles.reviewer_1.sharedContext,
			),
		).toThrow("byte limit");
		expect(() =>
			resolveSwarmRoleAssignment({
				snapshot,
				assignmentId: "a",
				role: "reviewer_1",
				decisionScopes: ["review"],
				models: [model],
				parentToolNames: ["read"],
				parentAssignment: { delegableRoleIds: [], decisionScopes: ["review"], implementationScopes: [] },
			}),
		).toThrow("not delegable");
	});

	it("rejects inherited delegation targets and accepts exact selectors with slash-bearing model IDs", () => {
		expect(() =>
			parseSwarmRolePolicy({
				...policy,
				roles: {
					...policy.roles,
					reviewer_1: { ...policy.roles.reviewer_1, delegableRoleIds: ["constructor"] },
				},
			}),
		).toThrow("delegates to an unknown role");
		expect(
			parseSwarmRolePolicy({
				...policy,
				modelProfiles: { neutral_profile: { model: "neutral/provider/model" } },
			}).policy.modelProfiles.neutral_profile.model,
		).toBe("neutral/provider/model");
	});

	it("rejects non-object bridge kwargs rather than silently treating them as legacy input", async () => {
		const handler = createRlmRunHostHandler(async ({ prompt, kwargs }) => ({ prompt, kwargs }));
		await expect(handler({ prompt: "task", kwargs: null })).rejects.toThrow("kwargs must be an object");
		await expect(handler({ prompt: "task", kwargs: [] })).rejects.toThrow("kwargs must be an object");
		await expect(handler({ prompt: "task", kwargs: { role: "reviewer" } })).resolves.toEqual({
			prompt: "task",
			kwargs: { role: "reviewer" },
		});
	});

	it("projects a bounded codepoint-sorted minimal role catalog", () => {
		const snapshot = parseSwarmRolePolicy({
			...policy,
			roles: {
				Zebra: policy.roles.reviewer_1,
				alphabet: policy.roles.reviewer_1,
				reviewer_1: policy.roles.reviewer_1,
			},
		});
		expect(projectSwarmRoleMetadata(snapshot).map((role) => role.id)).toEqual(["Zebra", "alphabet", "reviewer_1"]);
	});
});
