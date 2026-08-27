import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadAvoDashboardPayload, parseAvoDashboardArgs } from "../src/cli/avo-dashboard.js";
import { AutoresearchStore } from "../src/core/autoresearch.js";
import { AvoStore } from "../src/core/avo/index.js";

function agentDir(): string {
	return mkdtempSync(join(tmpdir(), "prime-avo-dashboard-"));
}

describe("universal AVO dashboard", () => {
	test("parses localhost options and rejects unsafe selectors", () => {
		expect(parseAvoDashboardArgs(["dashboard"])).toEqual({ port: 4317, openBrowser: true });
		expect(parseAvoDashboardArgs(["dashboard", "--session=session-1", "--port", "5555", "--no-open"])).toEqual({
			port: 5555,
			sessionId: "session-1",
			openBrowser: false,
		});
		expect(() => parseAvoDashboardArgs(["dashboard", "--session", "../secret"])).toThrow("session id is invalid");
		expect(() => parseAvoDashboardArgs(["dashboard", "--port=70000"])).toThrow("port must be an integer");
	});

	test("projects coding environment and horizon from generic durable state", () => {
		const root = agentDir();
		const artifact = join(root, "session-artifacts", "coding-session");
		mkdirSync(artifact, { recursive: true });
		const store = new AvoStore(artifact, "coding-session", () => "2026-08-26T00:00:00.000Z");
		store.initialize("Fix the parser");
		store.setEnvironment("coding");
		store.setHorizon("iterative");
		store.recordCandidate({ candidateId: "patch-1", kind: "patch", summary: "Fix parser", payload: "diff" });

		const payload = loadAvoDashboardPayload(root, "coding-session");
		expect(payload).toMatchObject({
			sessionId: "coding-session",
			environment: "coding",
			horizon: "iterative",
		});
		expect(payload.phases.some((phase) => phase.id === "test")).toBe(true);
		expect(payload.metrics.find((metric) => metric.label === "Iterations")?.value).toBe(0);
	});

	test("reconciles artifact integrity before showing a live final gate", () => {
		const root = agentDir();
		const workspace = join(root, "workspace");
		const artifact = join(root, "session-artifacts", "artifact-session");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(artifact, { recursive: true });
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(
			join(root, "sessions", "artifact-session.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "artifact-session", cwd: workspace })}\n`,
		);
		const reportPath = join(workspace, "report.md");
		writeFileSync(reportPath, "# Verified report\n");
		const store = new AvoStore(artifact, "artifact-session", () => "2026-08-26T00:00:00.000Z", workspace);
		store.initialize("Create a report and export it");
		const candidate = store.recordCandidate({
			candidateId: "report-1",
			kind: "artifact",
			summary: "Export report",
			payload: "report.md",
			artifactPaths: ["report.md"],
		});
		const verifiedBytes = statSync(reportPath).size;
		const verifiedSha = createHash("sha256").update("# Verified report\n").digest("hex");
		store.recordEvaluation(
			{
				candidateId: candidate.candidateId,
				evaluatorId: "artifact_binding",
				status: "pass",
				authority: "environment",
				evidenceRefs: [`artifact:${verifiedSha}:${reportPath}`],
				metrics: {
					meaningful: true,
					artifact_candidate_binding: true,
					artifact_target_digest: candidate.artifactTargetDigest!,
					candidate_payload_digest: candidate.payloadDigest,
					artifact_manifest: JSON.stringify([
						{ declaredPath: reportPath, path: reportPath, sha256: verifiedSha, size: verifiedBytes },
					]),
				},
			},
			"host",
		);
		store.completeCycle({ candidateId: candidate.candidateId });
		expect(loadAvoDashboardPayload(root, "artifact-session").stopGate.passed).toBe(true);

		writeFileSync(reportPath, "# Corrupted report\n");
		const payload = loadAvoDashboardPayload(root, "artifact-session");
		expect(payload).toMatchObject({ status: "blocked", stopGate: { passed: false } });
		expect(payload.phase.id).not.toBe("final_gate");
		expect(payload.phase.progressPercent).toBeLessThan(100);
	});

	test("preserves the hardened research projection as a compatibility adapter", () => {
		const root = agentDir();
		const artifact = join(root, "session-artifacts", "research-session");
		mkdirSync(artifact, { recursive: true });
		const store = new AutoresearchStore(artifact, () => "2026-08-26T00:00:00.000Z");
		store.initialize("Find a publication-grade problem", "agent memory");
		store.addClaim({
			claimId: "claim-1",
			claimText: "A limitation exists.",
			claimType: "KNOWN_LIMITATION",
			status: "proposed",
			supportingEvidence: [],
			contradictingEvidence: [],
			confidence: "low",
			unresolvedObjections: [],
			createdAt: "2026-08-26T00:00:00.000Z",
		});

		const payload = loadAvoDashboardPayload(root, "research-session");
		expect(payload.environment).toBe("research");
		expect(payload.horizon).toBe("long");
		expect(payload.phase.id).toBe("candidate");
		expect(payload.sections.find((section) => section.id === "reviewers")?.items).toHaveLength(4);
	});
});
