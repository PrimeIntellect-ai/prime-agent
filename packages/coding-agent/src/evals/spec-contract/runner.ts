#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateAvoSpecContract } from "../../core/avo/spec-contract.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SOURCE_DIR, "..", "..", "..", "..", "..");
const CONTRACT_PATH = "packages/coding-agent/spec/requirements.json";

export function formatAvoSpecContractReport(report: ReturnType<typeof loadAndValidateAvoSpecContract>): string {
	const lines = [
		`AVO behavioral contract: ${report.contractId ?? "invalid"}`,
		`Requirements: ${report.summary.total} total · ${report.summary.verified} verified · ${report.summary.partial} partial · ${report.summary.unproven} unproven`,
	];
	for (const requirement of report.requirements) {
		lines.push(
			`${requirement.id}: ${requirement.derivedStatus} · observed ${requirement.observedGates.length}/${requirement.missingObservedGates.length + requirement.observedGates.length} gates · runtime=${requirement.runtimeTraceObserved ? "observed" : "missing"} · independent=${requirement.independentReviewObserved ? "observed" : "missing"}`,
		);
	}
	if (report.warnings.length > 0) {
		lines.push("Unproven coverage (non-fatal, never promoted to verified):");
		for (const warning of report.warnings) lines.push(`- ${warning}`);
	}
	if (report.errors.length > 0) {
		lines.push("Contract errors:");
		for (const error of report.errors) lines.push(`- ${error}`);
	}
	return lines.join("\n");
}

const report = loadAndValidateAvoSpecContract(CONTRACT_PATH, REPOSITORY_ROOT, {
	receiptHmacKey: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_KEY,
});
process.stdout.write(`${formatAvoSpecContractReport(report)}\n`);
if (!report.valid) process.exitCode = 1;
