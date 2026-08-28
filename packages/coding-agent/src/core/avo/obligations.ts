import { createHash } from "node:crypto";
import type {
	AvoCandidate,
	AvoCriticalAssumption,
	AvoEvaluationReceipt,
	AvoImpactSurface,
	AvoObligation,
	AvoObligationEvidenceKind,
	AvoRunState,
	AvoVerificationClass,
	AvoVerificationPolicy,
} from "./types.js";

function objectiveEvidence(
	verificationClass: AvoVerificationClass,
	verificationPolicy: AvoVerificationPolicy,
): AvoObligationEvidenceKind[] {
	if (verificationPolicy !== "required" && verificationClass === "external_factual") {
		return ["authoritative", "opinion"];
	}
	switch (verificationClass) {
		case "coding":
			return ["test"];
		case "artifact":
			return ["artifact"];
		case "external_factual":
			return ["external"];
		case "deterministic_local":
			return ["deterministic"];
		case "research":
			return ["authoritative"];
		case "subjective":
			return ["opinion"];
	}
}

function obligationId(prefix: string, description: string): string {
	return `${prefix}-${createHash("sha256").update(description).digest("hex").slice(0, 16)}`;
}

/**
 * Host-owned objective decomposition. The full objective is always retained,
 * and explicit checklist/list items become separate critical obligations.
 * Free-form semantic decomposition remains model-assisted, but those additions
 * are immutable once candidate work begins.
 */
export function deriveAvoObjectiveObligations(
	objective: string,
	verificationClass: AvoVerificationClass,
	verificationPolicy: AvoVerificationPolicy,
	createdAt: string,
): AvoObligation[] {
	const normalized = objective.trim().replace(/\r\n?/g, "\n");
	const evidence = objectiveEvidence(verificationClass, verificationPolicy);
	const descriptions = [normalized];
	for (const line of normalized.split("\n")) {
		const match = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)(.{4,1000})$/);
		if (match?.[1]) descriptions.push(match[1].trim());
	}
	return [...new Set(descriptions)].map((description, index) => ({
		obligationId: obligationId(index === 0 ? "objective" : "requirement", description),
		description,
		kind: index === 0 ? "outcome" : "functional",
		critical: true,
		requiredEvidence: [...evidence],
		source: "host_objective",
		createdAt,
	}));
}

export function avoEvaluationEvidenceKinds(receipt: AvoEvaluationReceipt): Set<AvoObligationEvidenceKind> {
	const kinds = new Set<AvoObligationEvidenceKind>();
	if (receipt.authority === "model_opinion" && receipt.status === "pass") kinds.add("opinion");
	if (
		receipt.issuedBy === "host" &&
		receipt.authority !== "model_opinion" &&
		receipt.status === "pass" &&
		receipt.metrics.meaningful !== false
	) {
		kinds.add("authoritative");
	}
	if (receipt.issuedBy !== "host" || receipt.status !== "pass" || receipt.metrics.meaningful === false) return kinds;
	if (["test", "build", "lint", "benchmark", "runtime", "filesystem", "git"].includes(receipt.evaluatorId)) {
		kinds.add(receipt.evaluatorId as AvoObligationEvidenceKind);
	}
	if (receipt.evaluatorId === "artifact_binding") kinds.add("artifact");
	if (receipt.evaluatorId === "deterministic_result") kinds.add("deterministic");
	if (["external_claim", "online_evidence"].includes(receipt.evaluatorId)) kinds.add("external");
	return kinds;
}

export function avoEvaluatorMatchesRequiredEvidence(
	receipt: AvoEvaluationReceipt,
	requiredEvidence: readonly AvoObligationEvidenceKind[],
): boolean {
	if (requiredEvidence.includes("opinion")) {
		return receipt.authority === "model_opinion" && receipt.status !== "inconclusive";
	}
	if (receipt.issuedBy !== "host" || receipt.authority === "model_opinion") return false;
	if (requiredEvidence.includes("authoritative")) return true;
	const aliases: Partial<Record<AvoObligationEvidenceKind, string[]>> = {
		test: ["test"],
		build: ["build"],
		lint: ["lint"],
		benchmark: ["benchmark", "experiment_trial", "experiment_aggregate"],
		runtime: ["runtime"],
		filesystem: ["filesystem"],
		git: ["git"],
		artifact: ["artifact_binding"],
		external: ["external_claim", "online_evidence"],
		deterministic: ["deterministic_result"],
	};
	return requiredEvidence.some((kind) => aliases[kind]?.includes(receipt.evaluatorId) === true);
}

export function avoEvaluationSatisfiesObligation(
	receipt: AvoEvaluationReceipt,
	obligation: Pick<AvoObligation, "requiredEvidence"> | Pick<AvoCriticalAssumption, "requiredEvidence">,
): boolean {
	const kinds = avoEvaluationEvidenceKinds(receipt);
	return obligation.requiredEvidence.some((required) => kinds.has(required));
}

export function deriveAvoObligationCoverage(
	state: AvoRunState,
	candidate: AvoCandidate,
): Array<{ obligation: AvoObligation; satisfied: boolean; evidenceIds: string[]; reason?: string }> {
	const receipts = state.evaluations.filter((receipt) => receipt.candidateId === candidate.candidateId);
	return state.obligations.map((obligation) => {
		if (!candidate.obligationIds.includes(obligation.obligationId)) {
			return { obligation, satisfied: false, evidenceIds: [], reason: "candidate did not declare this obligation" };
		}
		const explicit = state.obligationCoverage.find(
			(coverage) =>
				coverage.obligationId === obligation.obligationId && coverage.candidateId === candidate.candidateId,
		);
		const evidenceIds =
			explicit?.evaluationIds ??
			(obligation.source === "host_objective" && obligation.kind === "outcome"
				? receipts
						.filter((receipt) => avoEvaluationSatisfiesObligation(receipt, obligation))
						.map((item) => item.evaluationId)
				: []);
		const valid = evidenceIds.filter((evaluationId) => {
			const receipt = receipts.find((item) => item.evaluationId === evaluationId);
			return receipt !== undefined && avoEvaluationSatisfiesObligation(receipt, obligation);
		});
		return {
			obligation,
			satisfied: valid.length > 0,
			evidenceIds: valid,
			reason: valid.length > 0 ? undefined : "no matching host-issued evidence is bound",
		};
	});
}

export function deriveAvoCriticalAssumptionChecks(
	state: AvoRunState,
	candidate?: AvoCandidate,
): Array<{
	assumption: AvoCriticalAssumption;
	passed: boolean;
	reason?: string;
}> {
	return state.criticalAssumptions
		.filter((assumption) => assumption.critical)
		.map((assumption) => {
			const candidateMatches =
				candidate === undefined ||
				(assumption.candidateId === candidate.candidateId &&
					assumption.candidatePayloadDigest === candidate.payloadDigest);
			return {
				assumption,
				passed: assumption.status === "supported" && candidateMatches,
				reason:
					assumption.status === "open"
						? "critical assumption has not been tested"
						: !candidateMatches
							? "critical assumption was tested for a different candidate payload"
							: assumption.status === "refuted"
								? "critical assumption was refuted by host evidence"
								: undefined,
			};
		});
}

function impactKind(path: string): AvoImpactSurface["kind"] | undefined {
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	const name = normalized.split("/").at(-1) ?? normalized;
	if (name === "readme" || name.startsWith("readme.") || normalized.startsWith("docs/") || /\.mdx?$/.test(name)) {
		return "documentation";
	}
	if (
		["package.json", "pyproject.toml", "cargo.toml", "go.mod", "tsconfig.json", "vite.config.ts"].includes(name) ||
		/(?:^|\/)(?:config|configs)\//.test(normalized) ||
		/\.(?:ya?ml|toml|ini)$/.test(name)
	) {
		return "configuration";
	}
	if (/(?:^|[._-])(?:api|schema|openapi|types?|interface)(?:[._-]|$)/.test(name) || /\.(?:proto|d\.ts)$/.test(name)) {
		return "public_api";
	}
	if (/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|cs|rb|php|scala|sh|c|cc|cpp|h|hpp)$/.test(name)) {
		return "source";
	}
	return undefined;
}

export function deriveAvoCandidateImpactSurfaces(candidate: AvoCandidate): AvoImpactSurface[] {
	const grouped = new Map<AvoImpactSurface["kind"], string[]>();
	for (const path of candidate.workspaceChangedPaths ?? []) {
		const kind = impactKind(path);
		if (!kind) continue;
		grouped.set(kind, [...(grouped.get(kind) ?? []), path]);
	}
	return [...grouped.entries()].map(([kind, paths]) => ({
		surfaceId: `impact-${kind}-${createHash("sha256").update(paths.sort().join("\0")).digest("hex").slice(0, 12)}`,
		kind,
		paths,
		requiredEvidenceGroups:
			kind === "documentation"
				? [["filesystem"]]
				: kind === "configuration"
					? [["test"], ["build", "runtime"]]
					: kind === "public_api"
						? [["test"], ["build"]]
						: [["test"]],
	}));
}

export function deriveAvoCandidateImpactChecks(
	state: AvoRunState,
	candidate: AvoCandidate,
): Array<{ surface: AvoImpactSurface; passed: boolean; evidenceIds: string[]; missingGroups: string[] }> {
	const receipts = state.evaluations.filter((receipt) => receipt.candidateId === candidate.candidateId);
	return (candidate.impactSurfaces ?? deriveAvoCandidateImpactSurfaces(candidate)).map((surface) => {
		const evidenceIds = new Set<string>();
		const missingGroups: string[] = [];
		for (const group of surface.requiredEvidenceGroups) {
			const matches = receipts.filter(
				(receipt) =>
					receipt.status === "pass" &&
					receipt.metrics.meaningful !== false &&
					avoEvaluatorMatchesRequiredEvidence(receipt, group),
			);
			if (matches.length === 0) missingGroups.push(group.join(" or "));
			for (const receipt of matches) evidenceIds.add(receipt.evaluationId);
		}
		return { surface, passed: missingGroups.length === 0, evidenceIds: [...evidenceIds], missingGroups };
	});
}
