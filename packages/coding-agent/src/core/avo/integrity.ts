import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AvoCandidate, AvoRunState } from "./types.js";
import { captureAvoWorkspaceSnapshot } from "./workspace.js";

export interface AvoCandidateIntegrityAssessment {
	passed: boolean;
	reason?: string;
	observedDigest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assessAvoCandidateIntegrity(
	state: AvoRunState,
	candidate: AvoCandidate,
	cwd: string,
	excludedRoots: readonly string[],
): AvoCandidateIntegrityAssessment {
	if (state.routing.environment === "coding") {
		const workspace = captureAvoWorkspaceSnapshot(cwd, { excludedRoots });
		if (!candidate.workspaceDigest || workspace.digest !== candidate.workspaceDigest) {
			return {
				passed: false,
				reason: "the current coding workspace no longer matches the evaluated candidate",
				observedDigest: workspace.digest,
			};
		}
		return { passed: true, observedDigest: workspace.digest };
	}
	if (state.routing.environment !== "general" || state.verificationClass !== "artifact") {
		return { passed: true };
	}
	const receipt = [...state.evaluations]
		.reverse()
		.find(
			(item) =>
				item.candidateId === candidate.candidateId &&
				item.issuedBy === "host" &&
				item.evaluatorId === "artifact_binding" &&
				item.status === "pass" &&
				typeof item.metrics.artifact_manifest === "string",
		);
	if (!receipt) return { passed: true };
	try {
		const manifest = JSON.parse(receipt.metrics.artifact_manifest as string) as unknown;
		if (!Array.isArray(manifest) || manifest.length === 0) throw new Error("artifact manifest is empty");
		for (const item of manifest) {
			if (
				!isRecord(item) ||
				typeof item.declaredPath !== "string" ||
				typeof item.path !== "string" ||
				typeof item.sha256 !== "string" ||
				typeof item.size !== "number"
			) {
				throw new Error("artifact manifest is invalid");
			}
			if (lstatSync(item.declaredPath).isSymbolicLink()) {
				throw new Error(`artifact became a symbolic link after verification: ${item.declaredPath}`);
			}
			if (realpathSync(item.declaredPath) !== item.path) {
				throw new Error(`artifact path changed after verification: ${item.declaredPath}`);
			}
			const stats = statSync(item.path);
			const sha256 = createHash("sha256").update(readFileSync(item.path)).digest("hex");
			if (!stats.isFile() || stats.size !== item.size || sha256 !== item.sha256) {
				throw new Error(`artifact changed after verification: ${item.path}`);
			}
		}
		return { passed: true };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { passed: false, reason, observedDigest: createHash("sha256").update(reason).digest("hex") };
	}
}

export function reconcileAvoIntegrityForProjection(
	state: AvoRunState,
	cwd: string,
	excludedRoots: readonly string[],
): AvoRunState {
	const reconciled = structuredClone(state);
	const acceptedCandidateIds = new Set(
		reconciled.cycles.filter((cycle) => cycle.outcome === "accepted").map((cycle) => cycle.candidateId),
	);
	let failed = false;
	for (const candidate of reconciled.candidates) {
		if (!acceptedCandidateIds.has(candidate.candidateId)) continue;
		const assessment = assessAvoCandidateIntegrity(reconciled, candidate, resolve(cwd), excludedRoots);
		if (assessment.passed) continue;
		failed = true;
		const observedDigest = assessment.observedDigest ?? "unavailable";
		if (
			reconciled.evaluations.some(
				(item) =>
					item.candidateId === candidate.candidateId &&
					item.evaluatorId === "candidate_integrity" &&
					item.status === "revise" &&
					item.metrics.observed_integrity_digest === observedDigest,
			)
		) {
			continue;
		}
		reconciled.evaluations.push({
			evaluationId: `dashboard-integrity-${candidate.candidateId}-${observedDigest}`,
			candidateId: candidate.candidateId,
			evaluatorId: "candidate_integrity",
			status: "revise",
			authority: "host",
			issuedBy: "host",
			evidenceRefs: [`host:integrity:${observedDigest}`],
			metrics: {
				meaningful: false,
				candidate_payload_digest: candidate.payloadDigest,
				observed_integrity_digest: observedDigest,
				validation_reason: assessment.reason ?? "candidate integrity changed",
			},
			createdAt: reconciled.updatedAt,
		});
	}
	if (failed) reconciled.status = "blocked";
	return reconciled;
}
