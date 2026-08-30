#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AvoSpecImpactReport,
	deriveAvoSpecRequirementImpacts,
	loadAndValidateAvoSpecContract,
} from "../../core/avo/spec-contract.js";

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SOURCE_DIR, "..", "..", "..", "..", "..");
const CONTRACT_PATH = "packages/coding-agent/spec/requirements.json";
const MAX_RECEIPT_BYTES = 1_000_000;

interface RunnerOptions {
	changedPaths: string[];
	enforce: boolean;
	json: boolean;
	receiptDir?: string;
	help: boolean;
}

function usage(): string {
	return `Prime AVO behavioral contract

Usage:
  npm run check:spec-contract
  npm run eval:spec-contract -- --changed <path[,path...]> [--changed <path>] [--enforce]

Options:
  --changed <path[,path...]>  Map candidate-changed files to protected requirements
  --receipt-dir <directory>   Load host-signed receipts outside the candidate workspace
  --enforce                   Fail if an affected requirement is not verified or a protected path is unmapped
  --json                      Emit the report and impact data as JSON
  --help                      Show this help

Environment:
  PRIME_AGENT_AVO_SPEC_RECEIPT_KEY  Host-held HMAC key (at least 32 bytes)
  PRIME_AGENT_AVO_SPEC_RECEIPT_DIR  Default external receipt directory
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

export function loadAvoSpecReceiptOverlay(directory: string | undefined): {
	receipts: Record<string, unknown>;
	errors: string[];
} {
	if (!directory) return { receipts: {}, errors: [] };
	const errors: string[] = [];
	const receipts: Record<string, unknown> = {};
	if (!existsSync(directory) || !statSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
		return { receipts, errors: [`receipt directory is missing, unsafe, or not a directory: ${directory}`] };
	}
	for (const name of readdirSync(directory)
		.filter((item) => item.endsWith(".json"))
		.sort()) {
		const path = join(directory, name);
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
				errors.push(`receipt file is unsafe or too large: ${path}`);
				continue;
			}
			const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (
				typeof value !== "object" ||
				value === null ||
				Array.isArray(value) ||
				typeof (value as { evidenceId?: unknown }).evidenceId !== "string"
			) {
				errors.push(`receipt file has no evidenceId: ${path}`);
				continue;
			}
			const evidenceId = (value as { evidenceId: string }).evidenceId;
			if (Object.hasOwn(receipts, evidenceId)) {
				errors.push(`duplicate external receipt for ${evidenceId}`);
				continue;
			}
			receipts[evidenceId] = value;
		} catch (error) {
			errors.push(`could not load receipt ${path}: ${String(error)}`);
		}
	}
	return { receipts, errors };
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
	const overlay = loadAvoSpecReceiptOverlay(receiptDir ? resolve(receiptDir) : undefined);
	const report = loadAndValidateAvoSpecContract(CONTRACT_PATH, REPOSITORY_ROOT, {
		receiptHmacKey: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_KEY,
		receipts: overlay.receipts,
	});
	const contractValue = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, CONTRACT_PATH), "utf8")) as unknown;
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
