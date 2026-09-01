#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AvoSpecImpactReport,
	assertAvoSpecReceiptTrustConfiguration,
	deriveAvoSpecRequirementImpacts,
	loadAndValidateAvoSpecContract,
	loadAvoSpecReceiptOverlay,
} from "../../core/avo/spec-contract.js";
import { captureAvoWorkspaceSnapshot } from "../../core/avo/workspace.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SOURCE_DIR, "..", "..", "..", "..", "..");
const CONTRACT_PATH = "packages/coding-agent/spec/requirements.json";

interface RunnerOptions {
	changedPaths: string[];
	enforce: boolean;
	json: boolean;
	receiptDir?: string;
	runId?: string;
	help: boolean;
}

function usage(): string {
	return `Prime AVO behavioral contract

Usage:
  npm run check:spec-contract
  npm run eval:spec-contract -- --changed <path[,path...]> [--changed <path>] [--enforce]

Options:
  --changed <path[,path...]>  Map candidate-changed files to protected requirements
  --receipt-dir <directory>   Load independently signed receipts outside the candidate workspace
  --run-id <task-run-id>      Bind receipts to the active AVO task run
  --enforce                   Fail if an affected requirement is not verified or a protected path is unmapped
  --json                      Emit the report and impact data as JSON
  --help                      Show this help

Environment:
  PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY  Ed25519 public key used to verify independent receipts
  PRIME_AGENT_AVO_SPEC_RECEIPT_DIR  Default external receipt directory
  PRIME_AGENT_AVO_SPEC_RUN_ID       Default active AVO task run ID
`;
}

export function parseAvoSpecRunnerArgs(argv: readonly string[]): RunnerOptions {
	const options: RunnerOptions = { changedPaths: [], enforce: false, json: false, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--changed": {
				const value = argv[++index];
				if (!value) throw new Error("--changed requires a repository-relative path");
				options.changedPaths.push(
					...value
						.split(",")
						.map((path) => path.trim())
						.filter(Boolean),
				);
				break;
			}
			case "--receipt-dir": {
				const value = argv[++index];
				if (!value) throw new Error("--receipt-dir requires a directory");
				options.receiptDir = resolve(value);
				break;
			}
			case "--run-id": {
				const value = argv[++index];
				if (!value) throw new Error("--run-id requires an active AVO task run ID");
				options.runId = value;
				break;
			}
			case "--enforce":
				options.enforce = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${argument}`);
		}
	}
	if (options.enforce && options.changedPaths.length === 0) {
		throw new Error("--enforce requires at least one --changed path");
	}
	return options;
}

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

function formatImpactReport(
	impact: AvoSpecImpactReport,
	report: ReturnType<typeof loadAndValidateAvoSpecContract>,
): string {
	const status = new Map(report.requirements.map((requirement) => [requirement.id, requirement.derivedStatus]));
	return [
		`Affected requirements: ${impact.affectedRequirementIds.length > 0 ? impact.affectedRequirementIds.map((id) => `${id}=${status.get(id) ?? "missing"}`).join(", ") : "none"}`,
		`Unmapped protected paths: ${impact.unmappedProtectedPaths.length > 0 ? impact.unmappedProtectedPaths.join(", ") : "none"}`,
		...(impact.errors.length > 0 ? ["Impact errors:", ...impact.errors.map((error) => `- ${error}`)] : []),
	].join("\n");
}

export function runAvoSpecContract(argv: readonly string[]): number {
	let options: RunnerOptions;
	try {
		options = parseAvoSpecRunnerArgs(argv);
	} catch (error) {
		process.stderr.write(`${String(error)}\n\n${usage()}`);
		return 1;
	}
	if (options.help) {
		process.stdout.write(usage());
		return 0;
	}
	const receiptDir = options.receiptDir ?? process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_DIR;
	try {
		assertAvoSpecReceiptTrustConfiguration(process.env);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		return 1;
	}
	const overlay = loadAvoSpecReceiptOverlay(receiptDir ? resolve(receiptDir) : undefined);
	const contractContent = readFileSync(resolve(REPOSITORY_ROOT, CONTRACT_PATH), "utf8");
	const receiptRunId = options.runId ?? process.env.PRIME_AGENT_AVO_SPEC_RUN_ID;
	const workspace = captureAvoWorkspaceSnapshot(REPOSITORY_ROOT);
	const report = loadAndValidateAvoSpecContract(CONTRACT_PATH, REPOSITORY_ROOT, {
		receiptPublicKey: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY,
		receipts: overlay.receipts,
		receiptBinding: receiptRunId
			? {
					runId: receiptRunId,
					workspaceDigest: workspace.digest,
					contractDigest: createHash("sha256").update(contractContent).digest("hex"),
				}
			: undefined,
	});
	const contractValue = JSON.parse(contractContent) as unknown;
	const impact = deriveAvoSpecRequirementImpacts(contractValue, options.changedPaths);
	const affectedStatuses = new Map(
		report.requirements.map((requirement) => [requirement.id, requirement.derivedStatus]),
	);
	const enforcementErrors = options.enforce
		? [
				...impact.unmappedProtectedPaths.map((path) => `protected changed path has no requirement: ${path}`),
				...impact.affectedRequirementIds.flatMap((id) =>
					affectedStatuses.get(id) === "verified" ? [] : [`affected requirement is not verified: ${id}`],
				),
			]
		: [];
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({ report, impact, receiptErrors: overlay.errors, enforcementErrors }, null, 2)}\n`,
		);
	} else {
		process.stdout.write(`${formatAvoSpecContractReport(report)}\n`);
		if (options.changedPaths.length > 0) process.stdout.write(`${formatImpactReport(impact, report)}\n`);
		for (const error of overlay.errors) process.stderr.write(`Receipt error: ${error}\n`);
		for (const error of enforcementErrors) process.stderr.write(`Enforcement error: ${error}\n`);
	}
	return report.valid && overlay.errors.length === 0 && impact.errors.length === 0 && enforcementErrors.length === 0
		? 0
		: 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	process.exitCode = runAvoSpecContract(process.argv.slice(2));
}
