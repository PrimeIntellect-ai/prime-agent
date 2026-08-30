import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const AVO_SPEC_GATES = [
	"static",
	"unit",
	"integration",
	"behavioral",
	"adversarial",
	"independent_review",
] as const;

export type AvoSpecGate = (typeof AVO_SPEC_GATES)[number];
export type AvoSpecEvidenceState = "planned" | "linked" | "observed";
export type AvoSpecRequirementStatus = "unproven" | "partial" | "verified";

export const AVO_SPEC_MECHANISMS = [
	"compiler",
	"linter",
	"deterministic_unit_test",
	"deterministic_integration_test",
	"invariant_test",
	"runtime_trace",
	"adversarial_test",
	"fault_injection",
	"independent_review",
] as const;

export type AvoSpecMechanism = (typeof AVO_SPEC_MECHANISMS)[number];

const MECHANISMS_BY_GATE: Record<AvoSpecGate, readonly AvoSpecMechanism[]> = {
	static: ["compiler", "linter"],
	unit: ["deterministic_unit_test"],
	integration: ["deterministic_integration_test"],
	behavioral: ["invariant_test", "runtime_trace"],
	adversarial: ["adversarial_test", "fault_injection"],
	independent_review: ["independent_review"],
};

export interface AvoSpecEvidenceDefinition {
	evidenceId: string;
	gate: AvoSpecGate;
	state: AvoSpecEvidenceState;
	mechanism: AvoSpecMechanism;
	path?: string;
	anchor?: string;
	plan?: string;
	receiptPath?: string;
}

export interface AvoSpecRequirementDefinition {
	id: string;
	domain: string;
	title: string;
	statement: string;
	critical: boolean;
	behaviors: {
		normal: string;
		failure: string;
		ordering: string;
		authority: string;
		persistence: string;
	};
	sourcePaths: string[];
	requiredGates: AvoSpecGate[];
	requiresRuntimeTrace: boolean;
	declaredStatus: AvoSpecRequirementStatus;
	evidence: AvoSpecEvidenceDefinition[];
}

interface AvoSpecReceipt {
	schemaVersion: 1;
	receiptId: string;
	requirementId: string;
	evidenceId: string;
	gate: AvoSpecGate;
	mechanism: AvoSpecMechanism;
	status: "pass";
	sourceDigest: string;
	command: string;
	startedAt: string;
	completedAt: string;
	satisfies: string[];
	producer: {
		role: "compiler" | "deterministic_test_runner" | "runtime_host" | "independent_reviewer";
		identity: string;
		independentFromCandidateGenerator: boolean;
	};
	events?: Array<{ event: string; satisfies: string[] }>;
	signature: string;
}

export interface AvoSpecValidationOptions {
	receiptHmacKey?: string | Uint8Array;
}

export interface AvoSpecRequirementCoverage {
	id: string;
	declaredStatus: AvoSpecRequirementStatus;
	derivedStatus: AvoSpecRequirementStatus;
	mappedGates: AvoSpecGate[];
	observedGates: AvoSpecGate[];
	missingObservedGates: AvoSpecGate[];
	runtimeTraceObserved: boolean;
	independentReviewObserved: boolean;
	mechanisms: AvoSpecMechanism[];
}

export interface AvoSpecValidationReport {
	valid: boolean;
	contractId?: string;
	errors: string[];
	warnings: string[];
	requirements: AvoSpecRequirementCoverage[];
	summary: {
		total: number;
		unproven: number;
		partial: number;
		verified: number;
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function canonicalAvoSpecJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("spec receipt contains a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalAvoSpecJson).join(",")}]`;
	if (!isObject(value)) throw new Error("spec receipt contains a non-JSON value");
	return `{${Object.keys(value)
		.filter((key) => key !== "signature" && value[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalAvoSpecJson(value[key])}`)
		.join(",")}}`;
}

function normalizedReceiptHmacKey(key: string | Uint8Array): Uint8Array {
	const normalized = typeof key === "string" ? Buffer.from(key, "utf8") : key;
	if (normalized.byteLength < 32) throw new Error("trusted spec receipt HMAC key must contain at least 32 bytes");
	return normalized;
}

export function signAvoSpecReceipt(value: Record<string, unknown>, key: string | Uint8Array): string {
	const digest = createHmac("sha256", normalizedReceiptHmacKey(key)).update(canonicalAvoSpecJson(value)).digest("hex");
	return `hmac-sha256:${digest}`;
}

function receiptSignatureMatches(
	receipt: AvoSpecReceipt,
	key: string | Uint8Array | undefined,
	path: string,
	errors: string[],
): boolean {
	if (key === undefined) {
		errors.push(`${path} cannot be trusted without the host spec-receipt HMAC key`);
		return false;
	}
	let expected: string;
	try {
		expected = signAvoSpecReceipt(receipt as unknown as Record<string, unknown>, key);
	} catch (error) {
		errors.push(`${path} could not verify its host signature: ${String(error)}`);
		return false;
	}
	const actualBytes = Buffer.from(receipt.signature, "utf8");
	const expectedBytes = Buffer.from(expected, "utf8");
	if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
		errors.push(`${path} has an invalid host signature`);
		return false;
	}
	return true;
}

function isAvoSpecGate(value: unknown): value is AvoSpecGate {
	return typeof value === "string" && AVO_SPEC_GATES.includes(value as AvoSpecGate);
}

function isAvoSpecMechanism(value: unknown): value is AvoSpecMechanism {
	return typeof value === "string" && AVO_SPEC_MECHANISMS.includes(value as AvoSpecMechanism);
}

function isAvoSpecEvidenceState(value: unknown): value is AvoSpecEvidenceState {
	return value === "planned" || value === "linked" || value === "observed";
}

function isAvoSpecRequirementStatus(value: unknown): value is AvoSpecRequirementStatus {
	return value === "unproven" || value === "partial" || value === "verified";
}

function safeRepositoryFile(repositoryRoot: string, path: string): string | undefined {
	if (isAbsolute(path)) return undefined;
	const root = resolve(repositoryRoot);
	const absolute = resolve(root, path);
	const fromRoot = relative(root, absolute);
	if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return undefined;
	if (!existsSync(absolute)) return absolute;
	try {
		if (lstatSync(absolute).isSymbolicLink()) return undefined;
		const canonicalRoot = realpathSync(root);
		const canonical = realpathSync(absolute);
		const canonicalFromRoot = relative(canonicalRoot, canonical);
		if (canonicalFromRoot.startsWith("..") || isAbsolute(canonicalFromRoot)) return undefined;
		return canonical;
	} catch {
		return undefined;
	}
}

export function digestAvoSpecSources(repositoryRoot: string, sourcePaths: readonly string[]): string {
	const hash = createHash("sha256");
	for (const path of [...sourcePaths].sort()) {
		const absolute = safeRepositoryFile(repositoryRoot, path);
		if (!absolute || !existsSync(absolute) || !statSync(absolute).isFile()) {
			throw new Error(`cannot digest missing or unsafe source path: ${path}`);
		}
		hash.update(path);
		hash.update("\0");
		hash.update(readFileSync(absolute));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function digestAvoSpecRequirement(repositoryRoot: string, requirement: AvoSpecRequirementDefinition): string {
	const definition = {
		id: requirement.id,
		domain: requirement.domain,
		title: requirement.title,
		statement: requirement.statement,
		critical: requirement.critical,
		behaviors: requirement.behaviors,
		sourcePaths: requirement.sourcePaths,
		requiredGates: requirement.requiredGates,
		requiresRuntimeTrace: requirement.requiresRuntimeTrace,
		evidence: requirement.evidence.map((evidence) => ({
			evidenceId: evidence.evidenceId,
			gate: evidence.gate,
			mechanism: evidence.mechanism,
			path: evidence.path,
			anchor: evidence.anchor,
			plan: evidence.plan,
		})),
	};
	return createHash("sha256")
		.update(
			canonicalAvoSpecJson({
				definition,
				sourceDigest: digestAvoSpecSources(repositoryRoot, requirement.sourcePaths),
			}),
		)
		.digest("hex");
}

function parseReceipt(value: unknown, path: string, errors: string[]): AvoSpecReceipt | undefined {
	if (!isObject(value)) {
		errors.push(`${path} must contain a JSON object`);
		return undefined;
	}
	const producer = value.producer;
	if (!isObject(producer)) errors.push(`${path}.producer must be an object`);
	const events = value.events;
	if (events !== undefined && !Array.isArray(events)) errors.push(`${path}.events must be an array when present`);
	const validEvents =
		events === undefined ||
		(Array.isArray(events) &&
			events.every(
				(event) =>
					isObject(event) &&
					nonEmptyString(event.event) &&
					Array.isArray(event.satisfies) &&
					event.satisfies.every(nonEmptyString),
			));
	const valid =
		value.schemaVersion === 1 &&
		nonEmptyString(value.receiptId) &&
		nonEmptyString(value.requirementId) &&
		nonEmptyString(value.evidenceId) &&
		isAvoSpecGate(value.gate) &&
		isAvoSpecMechanism(value.mechanism) &&
		value.status === "pass" &&
		typeof value.sourceDigest === "string" &&
		/^[a-f0-9]{64}$/.test(value.sourceDigest) &&
		nonEmptyString(value.command) &&
		nonEmptyString(value.startedAt) &&
		nonEmptyString(value.completedAt) &&
		Array.isArray(value.satisfies) &&
		value.satisfies.every(nonEmptyString) &&
		validEvents &&
		typeof value.signature === "string" &&
		/^hmac-sha256:[a-f0-9]{64}$/.test(value.signature) &&
		isObject(producer) &&
		["compiler", "deterministic_test_runner", "runtime_host", "independent_reviewer"].includes(
			String(producer.role),
		) &&
		nonEmptyString(producer.identity) &&
		typeof producer.independentFromCandidateGenerator === "boolean";
	if (!valid) {
		errors.push(`${path} is not a valid schema-v1 host evidence receipt`);
		return undefined;
	}
	const startedAt = Date.parse(value.startedAt as string);
	const completedAt = Date.parse(value.completedAt as string);
	if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
		errors.push(`${path} startedAt and completedAt must be valid timestamps`);
		return undefined;
	}
	if (startedAt > completedAt) {
		errors.push(`${path} completedAt precedes startedAt`);
		return undefined;
	}
	return value as unknown as AvoSpecReceipt;
}

function parseEvidence(value: unknown, path: string, errors: string[]): AvoSpecEvidenceDefinition | undefined {
	if (!isObject(value)) {
		errors.push(`${path} must be an object`);
		return undefined;
	}
	if (
		!nonEmptyString(value.evidenceId) ||
		!isAvoSpecGate(value.gate) ||
		!isAvoSpecEvidenceState(value.state) ||
		!isAvoSpecMechanism(value.mechanism)
	) {
		errors.push(`${path} has an invalid evidenceId, gate, state, or mechanism`);
		return undefined;
	}
	if (!MECHANISMS_BY_GATE[value.gate].includes(value.mechanism)) {
		errors.push(`${path} mechanism ${value.mechanism} cannot satisfy gate ${value.gate}`);
	}
	if (value.state === "planned") {
		if (!nonEmptyString(value.plan)) errors.push(`${path}.plan is required for planned evidence`);
	} else {
		if (!nonEmptyString(value.path)) errors.push(`${path}.path is required for ${value.state} evidence`);
		if (!nonEmptyString(value.anchor)) errors.push(`${path}.anchor is required for ${value.state} evidence`);
		if (value.state === "observed" && !nonEmptyString(value.receiptPath)) {
			errors.push(`${path}.receiptPath is required for observed evidence`);
		}
	}
	return value as unknown as AvoSpecEvidenceDefinition;
}

function parseRequirement(value: unknown, path: string, errors: string[]): AvoSpecRequirementDefinition | undefined {
	if (!isObject(value)) {
		errors.push(`${path} must be an object`);
		return undefined;
	}
	const behaviors = value.behaviors;
	const evidenceValues = Array.isArray(value.evidence) ? value.evidence : [];
	const evidence = evidenceValues.flatMap((item, index) => {
		const parsed = parseEvidence(item, `${path}.evidence[${index}]`, errors);
		return parsed ? [parsed] : [];
	});
	const requiredGates = Array.isArray(value.requiredGates) ? value.requiredGates.filter(isAvoSpecGate) : [];
	const valid =
		nonEmptyString(value.id) &&
		/^[A-Z][A-Z0-9]*-\d{3}$/.test(value.id) &&
		nonEmptyString(value.domain) &&
		nonEmptyString(value.title) &&
		nonEmptyString(value.statement) &&
		typeof value.critical === "boolean" &&
		isObject(behaviors) &&
		nonEmptyString(behaviors.normal) &&
		nonEmptyString(behaviors.failure) &&
		nonEmptyString(behaviors.ordering) &&
		nonEmptyString(behaviors.authority) &&
		nonEmptyString(behaviors.persistence) &&
		Array.isArray(value.sourcePaths) &&
		value.sourcePaths.length > 0 &&
		value.sourcePaths.every(nonEmptyString) &&
		Array.isArray(value.requiredGates) &&
		value.requiredGates.length === requiredGates.length &&
		typeof value.requiresRuntimeTrace === "boolean" &&
		isAvoSpecRequirementStatus(value.declaredStatus) &&
		Array.isArray(value.evidence) &&
		evidence.length === evidenceValues.length;
	if (!valid) {
		errors.push(`${path} is not a complete observable requirement`);
		return undefined;
	}
	return {
		...(value as unknown as AvoSpecRequirementDefinition),
		requiredGates,
		evidence,
	};
}

function readJsonFile(repositoryRoot: string, path: string, errors: string[]): unknown {
	const absolute = safeRepositoryFile(repositoryRoot, path);
	if (!absolute) {
		errors.push(`unsafe repository path: ${path}`);
		return undefined;
	}
	if (!existsSync(absolute) || !statSync(absolute).isFile()) {
		errors.push(`missing repository file: ${path}`);
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(absolute, "utf8")) as unknown;
	} catch (error) {
		errors.push(`invalid JSON in ${path}: ${String(error)}`);
		return undefined;
	}
}

function validateLinkedEvidence(
	repositoryRoot: string,
	requirement: AvoSpecRequirementDefinition,
	evidence: AvoSpecEvidenceDefinition,
	errors: string[],
): boolean {
	if (evidence.state === "planned") return true;
	if (!evidence.path || !evidence.anchor) return false;
	const absolute = safeRepositoryFile(repositoryRoot, evidence.path);
	if (!absolute || !existsSync(absolute) || !statSync(absolute).isFile()) {
		errors.push(`${requirement.id}/${evidence.evidenceId} references missing or unsafe file ${evidence.path}`);
		return false;
	}
	const contents = readFileSync(absolute, "utf8");
	let valid = true;
	if (!contents.includes(evidence.anchor)) {
		errors.push(`${requirement.id}/${evidence.evidenceId} anchor was not found in ${evidence.path}`);
		valid = false;
	}
	if (
		["deterministic_unit_test", "deterministic_integration_test", "invariant_test", "adversarial_test"].includes(
			evidence.mechanism,
		) &&
		!evidence.anchor.includes(requirement.id)
	) {
		errors.push(`${requirement.id}/${evidence.evidenceId} test anchor must include its stable requirement ID`);
		valid = false;
	}
	return valid;
}

function validateObservedEvidence(
	repositoryRoot: string,
	requirement: AvoSpecRequirementDefinition,
	evidence: AvoSpecEvidenceDefinition,
	sourceDigest: string | undefined,
	usedReceiptIds: Set<string>,
	options: AvoSpecValidationOptions,
	errors: string[],
): boolean {
	if (evidence.state !== "observed" || !evidence.receiptPath || !sourceDigest) return false;
	const receipt = parseReceipt(
		readJsonFile(repositoryRoot, evidence.receiptPath, errors),
		evidence.receiptPath,
		errors,
	);
	if (!receipt) return false;
	if (!receiptSignatureMatches(receipt, options.receiptHmacKey, evidence.receiptPath, errors)) return false;
	if (
		receipt.requirementId !== requirement.id ||
		receipt.evidenceId !== evidence.evidenceId ||
		receipt.gate !== evidence.gate ||
		receipt.mechanism !== evidence.mechanism
	) {
		errors.push(`${requirement.id}/${evidence.evidenceId} receipt identity does not match its evidence declaration`);
		return false;
	}
	if (usedReceiptIds.has(receipt.receiptId)) {
		errors.push(`receipt ${receipt.receiptId} was reused across evidence declarations`);
		return false;
	}
	usedReceiptIds.add(receipt.receiptId);
	if (receipt.sourceDigest !== sourceDigest) {
		errors.push(`${requirement.id}/${evidence.evidenceId} receipt is stale for the current requirement sources`);
		return false;
	}
	if (!receipt.satisfies.includes(requirement.id)) {
		errors.push(`${requirement.id}/${evidence.evidenceId} receipt does not cite the requirement it satisfies`);
		return false;
	}
	if (evidence.mechanism === "runtime_trace") {
		if (!receipt.events?.some((event) => nonEmptyString(event.event) && event.satisfies.includes(requirement.id))) {
			errors.push(
				`${requirement.id}/${evidence.evidenceId} runtime receipt has no trace event citing the requirement`,
			);
			return false;
		}
		if (receipt.producer.role !== "runtime_host") {
			errors.push(`${requirement.id}/${evidence.evidenceId} runtime trace was not issued by the runtime host`);
			return false;
		}
	}
	if (
		evidence.gate === "independent_review" &&
		(receipt.producer.role !== "independent_reviewer" || !receipt.producer.independentFromCandidateGenerator)
	) {
		errors.push(`${requirement.id}/${evidence.evidenceId} review is not independent of the candidate generator`);
		return false;
	}
	return true;
}

export function validateAvoSpecContract(
	value: unknown,
	repositoryRoot: string,
	options: AvoSpecValidationOptions = {},
): AvoSpecValidationReport {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!isObject(value)) {
		return {
			valid: false,
			errors: ["spec contract must be a JSON object"],
			warnings,
			requirements: [],
			summary: { total: 0, unproven: 0, partial: 0, verified: 0 },
		};
	}
	if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (!nonEmptyString(value.contractId)) errors.push("contractId must be a non-empty string");
	const gateOrder = Array.isArray(value.gateOrder) ? value.gateOrder.filter(isAvoSpecGate) : [];
	if (gateOrder.length !== AVO_SPEC_GATES.length || gateOrder.some((gate, index) => gate !== AVO_SPEC_GATES[index])) {
		errors.push(`gateOrder must be exactly ${AVO_SPEC_GATES.join(" -> ")}`);
	}
	const requirementValues = Array.isArray(value.requirements) ? value.requirements : [];
	if (requirementValues.length === 0) errors.push("requirements must contain at least one requirement");
	const requirements = requirementValues.flatMap((item, index) => {
		const parsed = parseRequirement(item, `requirements[${index}]`, errors);
		return parsed ? [parsed] : [];
	});
	const requirementIds = new Set<string>();
	const evidenceIds = new Set<string>();
	const usedReceiptIds = new Set<string>();
	const coverage: AvoSpecRequirementCoverage[] = [];
	for (const requirement of requirements) {
		if (requirementIds.has(requirement.id)) errors.push(`duplicate requirement ID: ${requirement.id}`);
		requirementIds.add(requirement.id);
		if (
			requirement.requiredGates.length !== AVO_SPEC_GATES.length ||
			requirement.requiredGates.some((gate, index) => gate !== AVO_SPEC_GATES[index])
		) {
			errors.push(`${requirement.id} must require all six gates in canonical order`);
		}
		if (!requirement.requiresRuntimeTrace) errors.push(`${requirement.id} must require a runtime trace`);
		let sourceDigest: string | undefined;
		try {
			sourceDigest = digestAvoSpecRequirement(repositoryRoot, requirement);
		} catch (error) {
			errors.push(`${requirement.id}: ${String(error)}`);
		}
		const mappedGates: AvoSpecGate[] = [];
		const observedGates: AvoSpecGate[] = [];
		const observedMechanisms: AvoSpecMechanism[] = [];
		const observedPaths: string[] = [];
		let runtimeTraceObserved = false;
		let independentReviewObserved = false;
		for (const evidence of requirement.evidence) {
			if (evidenceIds.has(evidence.evidenceId)) errors.push(`duplicate evidence ID: ${evidence.evidenceId}`);
			evidenceIds.add(evidence.evidenceId);
			if (!evidence.evidenceId.startsWith(`${requirement.id}:`)) {
				errors.push(`${requirement.id} evidence ID must start with ${requirement.id}:`);
			}
			mappedGates.push(evidence.gate);
			const linkedEvidenceValid = validateLinkedEvidence(repositoryRoot, requirement, evidence, errors);
			if (
				linkedEvidenceValid &&
				validateObservedEvidence(
					repositoryRoot,
					requirement,
					evidence,
					sourceDigest,
					usedReceiptIds,
					options,
					errors,
				)
			) {
				observedGates.push(evidence.gate);
				observedMechanisms.push(evidence.mechanism);
				if (evidence.path) observedPaths.push(evidence.path);
				if (evidence.mechanism === "runtime_trace") runtimeTraceObserved = true;
				if (evidence.gate === "independent_review") independentReviewObserved = true;
			}
		}
		for (const gate of AVO_SPEC_GATES) {
			if (!mappedGates.includes(gate))
				errors.push(`${requirement.id} has no planned, linked, or observed ${gate} evidence`);
		}
		if (!requirement.evidence.some((evidence) => evidence.mechanism === "runtime_trace")) {
			errors.push(`${requirement.id} has no runtime-trace evidence declaration`);
		}
		const distinctObservedGates = unique(observedGates);
		const missingObservedGates = AVO_SPEC_GATES.filter((gate) => !distinctObservedGates.includes(gate));
		const structurallyVerified =
			missingObservedGates.length === 0 &&
			runtimeTraceObserved &&
			independentReviewObserved &&
			unique(observedMechanisms).length >= 5 &&
			unique(observedPaths).length >= 4;
		const derivedStatus: AvoSpecRequirementStatus = structurallyVerified
			? "verified"
			: requirement.evidence.some((evidence) => evidence.state !== "planned")
				? "partial"
				: "unproven";
		if (requirement.declaredStatus !== derivedStatus) {
			errors.push(
				`${requirement.id} declares ${requirement.declaredStatus} but current evidence derives ${derivedStatus}`,
			);
		}
		if (derivedStatus !== "verified") {
			warnings.push(
				`${requirement.id} is ${derivedStatus}; missing observed gates: ${missingObservedGates.join(", ") || "runtime/diversity policy"}`,
			);
		}
		coverage.push({
			id: requirement.id,
			declaredStatus: requirement.declaredStatus,
			derivedStatus,
			mappedGates: AVO_SPEC_GATES.filter((gate) => mappedGates.includes(gate)),
			observedGates: distinctObservedGates,
			missingObservedGates,
			runtimeTraceObserved,
			independentReviewObserved,
			mechanisms: unique(requirement.evidence.map((evidence) => evidence.mechanism)),
		});
	}
	const summary = {
		total: coverage.length,
		unproven: coverage.filter((item) => item.derivedStatus === "unproven").length,
		partial: coverage.filter((item) => item.derivedStatus === "partial").length,
		verified: coverage.filter((item) => item.derivedStatus === "verified").length,
	};
	return {
		valid: errors.length === 0,
		contractId: nonEmptyString(value.contractId) ? value.contractId : undefined,
		errors,
		warnings,
		requirements: coverage,
		summary,
	};
}

export function loadAndValidateAvoSpecContract(
	contractPath: string,
	repositoryRoot: string,
	options: AvoSpecValidationOptions = {},
): AvoSpecValidationReport {
	const errors: string[] = [];
	const value = readJsonFile(repositoryRoot, contractPath, errors);
	if (value === undefined) {
		return {
			valid: false,
			errors,
			warnings: [],
			requirements: [],
			summary: { total: 0, unproven: 0, partial: 0, verified: 0 },
		};
	}
	return validateAvoSpecContract(value, repositoryRoot, options);
}
