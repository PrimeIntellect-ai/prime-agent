import { describe, expect, it } from "vitest";
import { validateKnowledgeProposal } from "../src/core/knowledge/records.js";
import { decisionRef, evidence, hostReceipt, proposal } from "./knowledge-fixtures.js";

describe("canonical knowledge records", () => {
	it("rejects transient, decision, outcome, and run-history payloads", () => {
		expect(() => validateKnowledgeProposal({ ...proposal(), kind: "outcome" } as never)).toThrow(/kind|knowledge/i);
		expect(() => validateKnowledgeProposal({ ...proposal(), transientState: "in progress" } as never)).toThrow(
			/closed|transient|unknown/i,
		);
		expect(() => validateKnowledgeProposal({ ...proposal(), outcome: "completed" } as never)).toThrow(
			/closed|outcome|unknown/i,
		);
	});

	it("requires host-validated evidence and a knowledge decision reference", () => {
		expect(() => validateKnowledgeProposal({ ...proposal(), evidenceRefs: [] })).toThrow(/evidence/i);
		expect(() =>
			validateKnowledgeProposal({
				...proposal(),
				decisionRef: {
					...decisionRef(),
					decisionScope: { kind: "workflow", workflowId: "workflow-1", rootSessionId: "session-1" },
				},
			}),
		).toThrow(/decision|namespace/i);
		expect(() =>
			validateKnowledgeProposal({
				...proposal(),
				evidenceRefs: [
					{
						...evidence("self"),
						validationReceipt: hostReceipt("self-validation", {
							workflowId: "workflow-1",
							issuerId: "self-authored",
						}),
					},
				],
			}),
		).toThrow(/evidence|host|author/i);
	});

	it("rejects unverified confidence and raw secret material", () => {
		expect(() => validateKnowledgeProposal({ ...proposal(), confidence: "unverified" } as never)).toThrow(
			/confidence|verified/i,
		);
		expect(() =>
			validateKnowledgeProposal({ ...proposal(), statement: "Use api_key=sk-live-12345678901234567890" }),
		).toThrow(/secret|sensitive/i);
	});

	it("returns an immutable clone so caller aliases cannot mutate canonical inputs", () => {
		const source = proposal();
		const validated = validateKnowledgeProposal(source);
		source.evidenceRefs[0]!.artifactRefs[0]!.digest = "mutated";
		source.applicability.workspaceId = "mutated";
		expect(validated.evidenceRefs[0]!.artifactRefs[0]!.digest).toBe("evidence-1-digest");
		expect(validated.applicability.workspaceId).toBe("workspace-1");
		expect(Object.isFrozen(validated)).toBe(true);
		expect(Object.isFrozen(validated.evidenceRefs)).toBe(true);
	});

	it("rejects a workspace record without an explicit privacy and retention policy", () => {
		const candidate = proposal();
		delete (candidate as unknown as { privacy?: unknown }).privacy;
		delete (candidate as unknown as { retention?: unknown }).retention;
		expect(() => validateKnowledgeProposal(candidate)).toThrow(/privacy|retention/i);
	});

	it("rejects a restricted record that could be projected outside its session scope", () => {
		expect(() =>
			validateKnowledgeProposal({
				...proposal(),
				applicability: { namespace: "knowledge", scope: "workspace", workspaceId: "workspace-1" },
				privacy: { class: "restricted", secretScan: hostReceipt("restricted-secret-scan") },
			}),
		).toThrow(/restricted|session/i);
		expect(() => validateKnowledgeProposal({ ...proposal(), tombstoneReason: "user-forgotten" })).toThrow(
			/tombstone|retract/i,
		);
	});

	it("rejects expired retention and stale host evidence before admission", () => {
		const expired = proposal({
			retention: { class: "session", expiresAt: "2026-08-15T00:00:00.000Z" },
		});
		expect(() => validateKnowledgeProposal(expired, { now: "2026-08-16T15:00:00.000Z" })).toThrow(
			/expired|retention/i,
		);
		const staleEvidence = proposal({
			evidenceRefs: [
				{
					...evidence("stale"),
					validationReceipt: {
						...evidence("stale").validationReceipt,
						validUntil: "2026-08-15T00:00:00.000Z",
					},
				},
			],
		});
		expect(() => validateKnowledgeProposal(staleEvidence, { now: "2026-08-16T15:00:00.000Z" })).toThrow(
			/fresh|stale|expired/i,
		);
	});
});
