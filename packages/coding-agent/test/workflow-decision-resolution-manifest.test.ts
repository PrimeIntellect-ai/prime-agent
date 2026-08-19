import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { loadSkillsFromDir } from "../src/core/skills.js";
import {
	createWorkflowDecisionResolutionManifest,
	type WorkflowDecisionResolutionDecisionInput,
} from "../src/core/workflow/decision-resolution-manifest.js";

function decision(
	input: Partial<WorkflowDecisionResolutionDecisionInput> &
		Pick<WorkflowDecisionResolutionDecisionInput, "decision" | "source">,
): WorkflowDecisionResolutionDecisionInput {
	return {
		confidence: "high",
		redTeamChallenge: {
			challenge: "What evidence would show that this choice exceeds the approved scope?",
			outcome: "passed",
			evidenceRefs: ["red-team:scope-check"],
		},
		reversibility: "reversible",
		externalEffectClass: "none",
		resolutionRefs: ["goal:approved-scope"],
		evidenceRefs: ["evidence:scope-check"],
		...input,
	};
}

describe("workflow decision-resolution manifest", () => {
	it("auto-resolves durable authority, invariants, and safe reversible defaults while batching absent authority", () => {
		const manifest = createWorkflowDecisionResolutionManifest({
			decisions: [
				decision({ decision: "Keep the user-selected repository layout", source: "durable_goal" }),
				decision({ decision: "Preserve the public API invariant", source: "invariant" }),
				decision({
					decision: "Use the existing test runner",
					source: "reversible_default",
					reversibleDefaultBasis: {
						inScope: true,
						noNewCost: true,
						safetyPreserved: true,
						noExternalAuthority: true,
					},
				}),
				decision({
					decision: "Publish the package to the public registry",
					source: "durable_goal",
					externalEffectClass: "irreversible_external_effect",
					reversibility: "irreversible",
				}),
				decision({
					decision: "Permit a material cloud spend",
					source: "durable_goal",
					externalEffectClass: "material_spend_or_cloud",
					reversibility: "irreversible",
				}),
			],
		});

		expect(
			manifest.decisions.filter(
				(item) => item.resolution === "auto_resolved" && item.effectAuthorization === "not_required",
			),
		).toHaveLength(3);
		expect(manifest.designPolicy).toBe("fail_closed");
		expect(manifest.pendingQuestions).toHaveLength(2);
		expect(manifest.approvalManifest.questions).toEqual(manifest.pendingQuestions);
		expect(manifest.approvalManifest.questions).toHaveLength(2);
		expect(manifest.questionsAvoided.map((item) => item.decision)).toEqual(
			expect.arrayContaining([
				"Keep the user-selected repository layout",
				"Preserve the public API invariant",
				"Use the existing test runner",
			]),
		);
		expect(manifest.questionsAvoided.every((item) => item.evidenceRefs.length > 0)).toBe(true);
		const publication = manifest.decisions.find(
			(item) => item.decision === "Publish the package to the public registry",
		);
		expect(publication?.effectAuthorization).toBe("needs_authority");
	});

	it("keeps design selection separate from effect authorization and uses the loaded optional skill at the boundary", () => {
		const discovery = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });
		const brainstorming = discovery.skills.find((skill) => skill.name === "brainstorming");
		const writingPlans = discovery.skills.find((skill) => skill.name === "writing-plans");
		expect(brainstorming?.kind).toBe("markdown");
		expect(writingPlans?.kind).toBe("markdown");
		if (!brainstorming) throw new Error("bundled brainstorming skill was not discovered");
		if (!writingPlans) throw new Error("bundled writing-plans skill was not discovered");
		const skillText = readFileSync(brainstorming.filePath, "utf8");
		const writingPlansText = readFileSync(writingPlans.filePath, "utf8");
		expect(skillText).toContain("optional");
		expect(skillText).toContain("workflow authority");
		expect(writingPlansText).toContain("DecisionResolutionManifest");

		const manifest = createWorkflowDecisionResolutionManifest({
			decisions: [
				decision({
					decision: "Select the least-surprising implementation design",
					source: "sealed_spec",
				}),
			],
		});

		const selected = manifest.decisions[0];
		expect(selected.resolution).toBe("auto_resolved");
		expect(selected.effectAuthorization).toBe("not_required");
		expect(manifest.pendingQuestions).toHaveLength(0);
		expect(manifest.approvalManifest.questions).toHaveLength(0);
		expect(manifest.questionsAvoided).toHaveLength(1);
		expect(manifest.questionsAvoided[0]?.resolutionRefs).toEqual(["goal:approved-scope"]);
		expect(manifest).not.toHaveProperty("progress");
	});

	it.each([
		{
			name: "missing evidence references",
			input: decision({ decision: "Missing evidence", source: "durable_goal", evidenceRefs: [] }),
			message: /evidence/i,
		},
		{
			name: "invented reversible-default assumptions",
			input: decision({
				decision: "Unsafe default",
				source: "reversible_default",
				reversibleDefaultBasis: {
					inScope: true,
					noNewCost: true,
					safetyPreserved: false,
					noExternalAuthority: true,
				},
			}),
			message: /reversible default|safety/i,
		},
		{
			name: "external effects relabeled as reversible",
			input: decision({
				decision: "Reframed external effect",
				source: "durable_goal",
				externalEffectClass: "irreversible_external_effect",
				reversibility: "reversible",
			}),
			message: /irreversible|reversib/i,
		},
	])("rejects $name", ({ input, message }) => {
		expect(() => createWorkflowDecisionResolutionManifest({ decisions: [input] })).toThrow(message);
	});

	it("does not auto-resolve a Pareto tradeoff without explicit effect authority", () => {
		const manifest = createWorkflowDecisionResolutionManifest({
			decisions: [
				decision({
					decision: "Prefer lower latency over lower spend",
					source: "invariant",
					externalEffectClass: "signed_pareto_tradeoff",
					reversibility: "irreversible",
				}),
			],
		});

		expect(manifest.decisions[0]?.resolution).toBe("needs_authority");
		expect(manifest.decisions[0]?.effectAuthorization).toBe("needs_authority");
		expect(manifest.approvalManifest.questions).toHaveLength(1);
	});

	it("fails closed when evidence confidence is not high", () => {
		const manifest = createWorkflowDecisionResolutionManifest({
			decisions: [
				decision({ decision: "Low-confidence implementation choice", source: "durable_goal", confidence: "low" }),
			],
		});

		expect(manifest.decisions[0]?.resolution).toBe("needs_authority");
		expect(manifest.pendingQuestions).toHaveLength(1);
	});

	it("batches provider, spend, and protected-read authority into one bounded manifest", () => {
		const manifest = createWorkflowDecisionResolutionManifest({
			decisions: [
				decision({
					decision: "Select the hosted provider",
					source: "durable_goal",
					externalEffectClass: "provider_or_cloud",
					reversibility: "irreversible",
				}),
				decision({
					decision: "Authorize the provider spend",
					source: "durable_goal",
					externalEffectClass: "material_spend_or_cloud",
					reversibility: "irreversible",
				}),
				decision({
					decision: "Read the protected deployment credential",
					source: "durable_goal",
					externalEffectClass: "protected_read",
					reversibility: "irreversible",
				}),
			],
		});

		expect(manifest.pendingQuestions).toHaveLength(3);
		expect(manifest.approvalManifest).toMatchObject({
			kind: "bounded_approval_manifest",
			bounded: true,
			serial: false,
		});
		expect(manifest.approvalManifest.questions).toEqual(manifest.pendingQuestions);
	});
});
