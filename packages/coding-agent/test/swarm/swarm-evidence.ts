/**
 * Test-only, provider-neutral deterministic swarm-evidence substrate.
 *
 * This file deliberately has no production-runtime or provider imports.  B00A
 * proves only local evidence mechanics; B00B must bind these contracts to the
 * daemon/RLM path and supervised process-tree RSS experiments.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export const SUPPORTED_SWARM_FANOUTS = [1, 4, 16, 64] as const;
export const SWARM_EVIDENCE_SCHEMA_VERSION = "prime-agent.swarm-evidence/v1";
const MICRO_TOKENS = 1_000_000;
const REDACTED = "[REDACTED]";
const EVIDENCE_FILES = [
	"cost-attribution.json",
	"events.jsonl",
	"oracle.jsonl",
	"process-samples.json",
	"summary.json",
] as const;
const ALL_EVIDENCE_FILES = ["manifest.json", ...EVIDENCE_FILES] as const;
const EVENT_TYPES = [
	"dispatch_admitted",
	"provider_request_started",
	"progress",
	"restart",
	"provider_failure",
	"provider_completed",
	"delivery_completed",
	"cleanup_completed",
] as const;
const FAULT_ACTION_TYPES = ["delay", "progress", "failure", "restart", "completion"] as const;

type EventType = (typeof EVENT_TYPES)[number];
export type FakeProviderAction =
	| { readonly type: "delay"; readonly milliseconds: number }
	| { readonly type: "progress"; readonly message: string }
	| { readonly type: "failure"; readonly code: string; readonly message: string }
	| { readonly type: "restart"; readonly reason: string }
	| { readonly type: "completion"; readonly outputTokens?: number };
export interface FakeProviderFaultSchedule {
	readonly nodeId: string;
	readonly actions: readonly FakeProviderAction[];
}
export interface AssignmentSpec {
	readonly nodeId: string;
	readonly parentNodeId?: string;
	readonly role: string;
	readonly requested: {
		readonly provider: string;
		readonly model: string;
		readonly revision?: string;
		readonly effort?: string;
	};
	readonly resolved?: AssignmentSpec["requested"];
	readonly inputTokens?: number;
	readonly outputTokens?: number;
}
export interface PriceCard {
	readonly version: string;
	readonly inputPerMillionTokens: number;
	readonly outputPerMillionTokens: number;
}
export interface ProcessMemory {
	readonly pid: number;
	readonly parentPid?: number;
	readonly startTime?: string;
	readonly rssBytes: number;
	readonly heapUsedBytes?: number;
	readonly externalBytes?: number;
	readonly label?: string;
}
export interface ProcessSampler {
	sample(): readonly ProcessMemory[];
	readonly source?: string;
}
export interface SwarmBenchmarkConfig {
	readonly scenario: string;
	readonly assignments: readonly AssignmentSpec[];
	readonly faultSchedule?: readonly FakeProviderFaultSchedule[];
	readonly priceCard: PriceCard;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly processSampler?: ProcessSampler;
}
export interface SwarmManifest {
	readonly schemaVersion: typeof SWARM_EVIDENCE_SCHEMA_VERSION;
	readonly benchmarkVersion: "b00a";
	/** Public configuration identity, not an authenticity signature. */
	readonly fingerprint: string;
	/** Stable identity of the deterministic oracle/cost/summary subset. */
	readonly deterministicBundleId?: string;
	/** Artifact-index commitment; trust this value out of band for mutation detection. */
	readonly artifactBundleId?: string;
	readonly scenario: string;
	readonly assignments: readonly AssignmentSpec[];
	readonly faultSchedule: readonly FakeProviderFaultSchedule[];
	readonly priceCard: PriceCard;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly runtime: {
		readonly node: string;
		readonly platform: string;
		readonly release: string;
		readonly arch: string;
	};
}
export type SwarmEvent = {
	readonly sequence: number;
	readonly elapsedMilliseconds: number;
	readonly type: EventType;
	readonly nodeId: string;
	readonly requestId: string;
	readonly detail?: Readonly<Record<string, unknown>>;
};
export interface ProcessSample {
	readonly sequence: number;
	readonly elapsedMilliseconds: number;
	readonly phase: "before_dispatch" | "after_admission" | "after_terminal" | "after_cleanup";
	readonly source: string;
	readonly processes: readonly ProcessMemory[];
	readonly totalRssBytes: number;
}
export interface CostAttribution {
	readonly id: string;
	readonly kind: "node" | "role" | "run";
	readonly directInputTokens: number;
	readonly directOutputTokens: number;
	readonly directCost: number;
	readonly downstreamInputTokens: number;
	readonly downstreamOutputTokens: number;
	readonly downstreamCost: number;
}
export interface EvidenceArtifact {
	readonly path: (typeof EVIDENCE_FILES)[number];
	readonly bytes: number;
	readonly sha256: string;
	readonly schemaVersion: typeof SWARM_EVIDENCE_SCHEMA_VERSION;
}
export interface SwarmEvidence {
	readonly manifest: SwarmManifest;
	readonly events: readonly SwarmEvent[];
	readonly processSamples: readonly ProcessSample[];
	readonly costAttribution: readonly CostAttribution[];
	readonly summary: {
		readonly admitted: number;
		readonly started: number;
		readonly completed: number;
		readonly failed: number;
		readonly delivered: number;
		readonly cleanedUp: number;
		readonly independentDispatch: boolean;
	};
}

/**
 * Opaque in-process trust root for a specific emitted evidence directory and
 * artifact-index commitment. It has no serialized representation. The unique
 * brand is module-private and the registry is deliberately process-local, so
 * neither can be reconstructed from manifest.json. Durable cross-process
 * signed commitments are B00B work.
 */
declare const swarmEvidenceCapabilityBrand: unique symbol;
export type SwarmEvidenceCapability = { readonly [swarmEvidenceCapabilityBrand]: true };
type RegisteredBundle = Readonly<{ directory: string; artifactBundleId: string }>;
const registeredBundles = new WeakMap<object, RegisteredBundle>();
function issueSwarmEvidenceCapability(): SwarmEvidenceCapability {
	return Object.freeze({}) as SwarmEvidenceCapability;
}

/** Canonical JSON rejects values which JSON.stringify silently changes. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			throw new Error("canonical JSON accepts plain objects only");
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => {
				if (record[key] === undefined) throw new Error("canonical JSON rejects undefined");
				return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
			})
			.join(",")}}`;
	}
	throw new Error(`canonical JSON rejects ${typeof value}`);
}
function fingerprint(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isString(value: unknown): value is string {
	return typeof value === "string";
}
function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Content-free strings and object keys are allowlisted independently. */
const SAFE_EVIDENCE_KEYS = new Set([
	"schemaVersion",
	"benchmarkVersion",
	"fingerprint",
	"deterministicBundleId",
	"artifactBundleId",
	"scenario",
	"assignments",
	"faultSchedule",
	"priceCard",
	"metadata",
	"runtime",
	"artifacts",
	"events",
	"processSamples",
	"costAttribution",
	"summary",
	"path",
	"bytes",
	"sha256",
	"nodeId",
	"parentNodeId",
	"role",
	"requested",
	"resolved",
	"provider",
	"model",
	"revision",
	"effort",
	"inputTokens",
	"outputTokens",
	"actions",
	"type",
	"milliseconds",
	"message",
	"code",
	"reason",
	"sequence",
	"elapsedMilliseconds",
	"requestId",
	"detail",
	"phase",
	"source",
	"processes",
	"pid",
	"parentPid",
	"startTime",
	"rssBytes",
	"heapUsedBytes",
	"externalBytes",
	"label",
	"totalRssBytes",
	"id",
	"kind",
	"directInputTokens",
	"directOutputTokens",
	"directCost",
	"downstreamInputTokens",
	"downstreamOutputTokens",
	"downstreamCost",
	"admitted",
	"started",
	"completed",
	"failed",
	"delivered",
	"cleanedUp",
	"independentDispatch",
	"version",
	"inputPerMillionTokens",
	"outputPerMillionTokens",
]);
function safeEvidenceString(value: string, key?: string): boolean {
	return (
		(key === "nodeId" && /^worker-\d{4}$/.test(value)) ||
		(key === "requestId" && /^request-\d{4}$/.test(value)) ||
		(key === "parentNodeId" && (value === "root" || /^worker-\d{4}$/.test(value))) ||
		((key === "id" || key === "role") &&
			(value === "run" || /^worker-\d{4}$/.test(value) || /^role-\d{4}$/.test(value))) ||
		(key === "kind" && ["node", "role", "run"].includes(value)) ||
		(key === "phase" && ["before_dispatch", "after_admission", "after_terminal", "after_cleanup"].includes(value)) ||
		(key === "type" &&
			((EVENT_TYPES as readonly string[]).includes(value) ||
				(FAULT_ACTION_TYPES as readonly string[]).includes(value))) ||
		(key === "schemaVersion" && value === SWARM_EVIDENCE_SCHEMA_VERSION) ||
		(key === "benchmarkVersion" && value === "b00a") ||
		((key === "fingerprint" || key === "deterministicBundleId" || key === "artifactBundleId" || key === "sha256") &&
			/^[0-9a-f]{64}$/.test(value)) ||
		(key === "path" && (EVIDENCE_FILES as readonly string[]).includes(value))
	);
}
/** No arbitrary fixture content, including object keys, enters normal artifacts. */
export function redactEvidence<T>(value: T, key?: string, redactObjectKeys = false): T {
	if (typeof value === "string") return (safeEvidenceString(value, key) ? value : REDACTED) as T;
	if (Array.isArray(value)) return value.map((item) => redactEvidence(item, undefined, redactObjectKeys)) as T;
	if (isRecord(value)) {
		const entries = Object.entries(value).map(([entryKey, item]) => {
			const safeKey = !redactObjectKeys && SAFE_EVIDENCE_KEYS.has(entryKey);
			return [
				safeKey ? entryKey : REDACTED,
				redactEvidence(item, safeKey ? entryKey : undefined, redactObjectKeys || key === "metadata"),
			];
		});
		return Object.fromEntries(entries) as T;
	}
	return value;
}
function assertContentFree(value: unknown, key?: string, untrustedObjectKeys = false): void {
	if (typeof value === "string") {
		assert(value === REDACTED || safeEvidenceString(value, key), `non-content-free string: ${key ?? "value"}`);
		return;
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") return;
	if (Array.isArray(value)) {
		value.forEach((item) => {
			assertContentFree(item, undefined, untrustedObjectKeys);
		});
		return;
	}
	assert(isRecord(value), "non-content-free value type");
	for (const [entryKey, item] of Object.entries(value)) {
		assert(
			entryKey === REDACTED || (!untrustedObjectKeys && SAFE_EVIDENCE_KEYS.has(entryKey)),
			`non-content-free key: ${entryKey}`,
		);
		assertContentFree(
			item,
			SAFE_EVIDENCE_KEYS.has(entryKey) ? entryKey : undefined,
			untrustedObjectKeys || key === "metadata",
		);
	}
}
function money(tokens: number, pricePerMillion: number): number {
	return (tokens * pricePerMillion) / MICRO_TOKENS;
}
function validate(config: SwarmBenchmarkConfig): void {
	assert(config.scenario.trim().length > 0, "scenario must not be empty");
	assert(config.assignments.length > 0, "at least one assignment is required");
	assert(
		new Set(config.assignments.map((assignment) => assignment.nodeId)).size === config.assignments.length,
		"assignment nodeId values must be unique",
	);
	assert(
		isSafeInteger(config.priceCard.inputPerMillionTokens) && isSafeInteger(config.priceCard.outputPerMillionTokens),
		"prices must be non-negative safe integers",
	);
	for (const assignment of config.assignments) {
		assert(
			Boolean(assignment.role && assignment.requested.provider && assignment.requested.model),
			`assignment ${assignment.nodeId} requires role, provider, and model`,
		);
		assert(
			assignment.inputTokens === undefined || isSafeInteger(assignment.inputTokens),
			"input tokens must be non-negative safe integers",
		);
		assert(
			assignment.outputTokens === undefined || isSafeInteger(assignment.outputTokens),
			"output tokens must be non-negative safe integers",
		);
	}
	for (const schedule of config.faultSchedule ?? []) {
		assert(
			config.assignments.some((assignment) => assignment.nodeId === schedule.nodeId),
			"fault schedule references unknown assignment",
		);
		for (const action of schedule.actions) {
			if (action.type === "delay")
				assert(isSafeInteger(action.milliseconds), "delay milliseconds must be a non-negative safe integer");
			if (action.type === "completion")
				assert(
					action.outputTokens === undefined || isSafeInteger(action.outputTokens),
					"output tokens must be non-negative safe integers",
				);
		}
	}
}
function publicConfig(config: SwarmBenchmarkConfig): Omit<SwarmManifest, "fingerprint" | "runtime"> {
	validate(config);
	const originalToPublic = new Map(
		config.assignments.map((assignment, index) => [
			assignment.nodeId,
			`worker-${String(index + 1).padStart(4, "0")}`,
		]),
	);
	const roles = [...new Set(config.assignments.map((assignment) => assignment.role))];
	const roleIds = new Map(roles.map((role, index) => [role, `role-${String(index + 1).padStart(4, "0")}`]));
	const assignmentFor = (assignment: AssignmentSpec): AssignmentSpec => ({
		nodeId: originalToPublic.get(assignment.nodeId)!,
		...(assignment.parentNodeId && originalToPublic.get(assignment.parentNodeId)
			? { parentNodeId: originalToPublic.get(assignment.parentNodeId) }
			: {}),
		role: roleIds.get(assignment.role)!,
		requested: redactEvidence(assignment.requested),
		...(assignment.resolved ? { resolved: redactEvidence(assignment.resolved) } : {}),
		inputTokens: assignment.inputTokens ?? 32,
		outputTokens: assignment.outputTokens ?? 16,
	});
	const assignments = config.assignments.map(assignmentFor);
	const faults = (config.faultSchedule ?? []).map((schedule) => ({
		nodeId: originalToPublic.get(schedule.nodeId)!,
		actions: schedule.actions.map((action) => redactEvidence(action)),
	}));
	return {
		schemaVersion: SWARM_EVIDENCE_SCHEMA_VERSION,
		benchmarkVersion: "b00a",
		scenario: REDACTED,
		assignments,
		faultSchedule: faults,
		priceCard: redactEvidence(config.priceCard),
		metadata: redactEvidence(config.metadata ?? {}, undefined, true),
	};
}
/** Creates a public, content-free manifest whose fingerprint is recomputable from disk. */
export function createSwarmManifest(config: SwarmBenchmarkConfig): SwarmManifest {
	const input = publicConfig(config);
	return {
		...input,
		fingerprint: fingerprint(input),
		runtime: { node: REDACTED, platform: REDACTED, release: REDACTED, arch: REDACTED },
	};
}

export const currentProcessSampler: ProcessSampler = {
	source:
		process.platform === "win32" ? "unsupported: native Windows sampler required" : "ps: summed process-tree RSS",
	sample(): readonly ProcessMemory[] {
		if (process.platform === "win32") return [];
		try {
			const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,lstart="], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			})
				.split("\n")
				.map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
				.filter((match): match is RegExpMatchArray => match !== null)
				.map((match) => ({
					pid: Number(match[1]),
					parentPid: Number(match[2]),
					rssBytes: Number(match[3]) * 1024,
					startTime: match[4],
					label: "process-tree",
				}));
			const wanted = new Set([process.pid]);
			for (let changed = true; changed; ) {
				changed = false;
				for (const row of rows)
					if (wanted.has(row.parentPid) && !wanted.has(row.pid)) {
						wanted.add(row.pid);
						changed = true;
					}
			}
			return rows.filter((row) => wanted.has(row.pid));
		} catch {
			return [];
		}
	},
};
function defaultActions(assignment: AssignmentSpec): readonly FakeProviderAction[] {
	return [{ type: "completion", outputTokens: assignment.outputTokens ?? 16 }];
}
/**
 * Immediate Promise.all dispatch is intentionally fixture-only. No admission
 * queue, semaphore, retry, limiter, or synthetic 429 exists here.
 */
export async function runSwarmBenchmark(config: SwarmBenchmarkConfig): Promise<SwarmEvidence> {
	const manifest = createSwarmManifest(config);
	const sampler = config.processSampler ?? currentProcessSampler;
	const publicAssignments = manifest.assignments;
	const publicByOriginal = new Map(
		config.assignments.map((assignment, index) => [assignment.nodeId, publicAssignments[index]!]),
	);
	const actionsByNode = new Map((config.faultSchedule ?? []).map((schedule) => [schedule.nodeId, schedule.actions]));
	let sequence = 0;
	const startedAt = performance.now();
	const events: SwarmEvent[] = [];
	const processSamples: ProcessSample[] = [];
	const requestFor = (nodeId: string) => `request-${nodeId.slice("worker-".length)}`;
	const record = (type: EventType, nodeId: string, detail?: Readonly<Record<string, unknown>>) =>
		events.push({
			sequence: ++sequence,
			elapsedMilliseconds: performance.now() - startedAt,
			type,
			nodeId,
			requestId: requestFor(nodeId),
			...(detail === undefined ? {} : { detail }),
		});
	const sample = (phase: ProcessSample["phase"]) => {
		const processes = sampler.sample();
		processSamples.push({
			sequence: ++sequence,
			elapsedMilliseconds: performance.now() - startedAt,
			phase,
			source: sampler.source ?? "injected process sampler",
			processes,
			totalRssBytes: processes.reduce((total, item) => total + item.rssBytes, 0),
		});
	};
	sample("before_dispatch");
	for (const assignment of publicAssignments) record("dispatch_admitted", assignment.nodeId);
	const runAssignment = async (original: AssignmentSpec, assignment: AssignmentSpec) => {
		const nodeId = assignment.nodeId;
		record("provider_request_started", nodeId, {
			role: assignment.role,
			requested: assignment.requested,
			resolved: assignment.resolved ?? assignment.requested,
		});
		await Promise.resolve();
		let terminal: "completed" | "failed" = "completed";
		let outputTokens = assignment.outputTokens ?? 16;
		for (const action of actionsByNode.get(original.nodeId) ?? defaultActions(original)) {
			switch (action.type) {
				case "delay":
					await new Promise<void>((resolve) => setTimeout(resolve, action.milliseconds));
					break;
				case "progress":
					record("progress", nodeId, { message: REDACTED });
					break;
				case "restart":
					record("restart", nodeId, { reason: REDACTED });
					break;
				case "failure":
					terminal = "failed";
					record("provider_failure", nodeId, { code: REDACTED, message: REDACTED });
					break;
				case "completion":
					outputTokens = action.outputTokens ?? outputTokens;
					break;
			}
			if (terminal === "failed") break;
		}
		if (terminal === "completed") {
			record("provider_completed", nodeId, { outputTokens });
			record("delivery_completed", nodeId);
		}
		record("cleanup_completed", nodeId);
		return { assignment, terminal, outputTokens: terminal === "completed" ? outputTokens : 0 };
	};
	const runs = config.assignments.map((assignment) =>
		runAssignment(assignment, publicByOriginal.get(assignment.nodeId)!),
	);
	sample("after_admission");
	const results = await Promise.all(runs);
	sample("after_terminal");
	sample("after_cleanup");
	const byNode = new Map(results.map((result) => [result.assignment.nodeId, result]));
	const costs = new Map<string, CostAttribution>();
	const calculate = (id: string): CostAttribution => {
		const prior = costs.get(id);
		if (prior) return prior;
		const result = byNode.get(id);
		assert(result, `unknown cost node ${id}`);
		const children = results
			.filter((candidate) => candidate.assignment.parentNodeId === id)
			.map((candidate) => calculate(candidate.assignment.nodeId));
		const directInputTokens = result.assignment.inputTokens ?? 32;
		const directOutputTokens = result.outputTokens;
		const directCost =
			money(directInputTokens, config.priceCard.inputPerMillionTokens) +
			money(directOutputTokens, config.priceCard.outputPerMillionTokens);
		const attribution = {
			id,
			kind: "node" as const,
			directInputTokens,
			directOutputTokens,
			directCost,
			downstreamInputTokens:
				directInputTokens + children.reduce((sum, child) => sum + child.downstreamInputTokens, 0),
			downstreamOutputTokens:
				directOutputTokens + children.reduce((sum, child) => sum + child.downstreamOutputTokens, 0),
			downstreamCost: directCost + children.reduce((sum, child) => sum + child.downstreamCost, 0),
		};
		costs.set(id, attribution);
		return attribution;
	};
	for (const result of results) calculate(result.assignment.nodeId);
	const nodeCosts = [...costs.values()];
	const descendants = (id: string, visited = new Set<string>()): CostAttribution[] => {
		if (visited.has(id)) return [];
		visited.add(id);
		return [
			calculate(id),
			...results
				.filter((candidate) => candidate.assignment.parentNodeId === id)
				.flatMap((child) => descendants(child.assignment.nodeId, visited)),
		];
	};
	const roleCosts = [...new Set(publicAssignments.map((assignment) => assignment.role))].map((role) => {
		const included = new Map(
			results
				.filter((result) => result.assignment.role === role)
				.flatMap((result) => descendants(result.assignment.nodeId))
				.map((cost) => [cost.id, cost]),
		);
		const direct = results
			.filter((result) => result.assignment.role === role)
			.map((result) => calculate(result.assignment.nodeId));
		const sum = (items: readonly CostAttribution[], key: keyof CostAttribution) =>
			items.reduce((total, item) => total + (item[key] as number), 0);
		return {
			id: role,
			kind: "role" as const,
			directInputTokens: sum(direct, "directInputTokens"),
			directOutputTokens: sum(direct, "directOutputTokens"),
			directCost: sum(direct, "directCost"),
			downstreamInputTokens: sum([...included.values()], "directInputTokens"),
			downstreamOutputTokens: sum([...included.values()], "directOutputTokens"),
			downstreamCost: sum([...included.values()], "directCost"),
		};
	});
	const roots = results
		.filter((result) => !result.assignment.parentNodeId || !byNode.has(result.assignment.parentNodeId))
		.map((result) => calculate(result.assignment.nodeId));
	const runCost: CostAttribution = {
		id: "run",
		kind: "run",
		directInputTokens: 0,
		directOutputTokens: 0,
		directCost: 0,
		downstreamInputTokens: roots.reduce((sum, item) => sum + item.downstreamInputTokens, 0),
		downstreamOutputTokens: roots.reduce((sum, item) => sum + item.downstreamOutputTokens, 0),
		downstreamCost: roots.reduce((sum, item) => sum + item.downstreamCost, 0),
	};
	const firstTerminal = events.findIndex(
		(event) => event.type === "provider_completed" || event.type === "provider_failure",
	);
	const independentDispatch =
		firstTerminal < 0 ||
		events.slice(0, firstTerminal).filter((event) => event.type === "provider_request_started").length ===
			results.length;
	return {
		manifest,
		events,
		processSamples,
		costAttribution: [...nodeCosts, ...roleCosts, runCost].sort((left, right) => left.id.localeCompare(right.id)),
		summary: {
			admitted: results.length,
			started: events.filter((event) => event.type === "provider_request_started").length,
			completed: results.filter((result) => result.terminal === "completed").length,
			failed: results.filter((result) => result.terminal === "failed").length,
			delivered: events.filter((event) => event.type === "delivery_completed").length,
			cleanedUp: events.filter((event) => event.type === "cleanup_completed").length,
			independentDispatch,
		},
	};
}
function oracleEvent(event: SwarmEvent): Omit<SwarmEvent, "elapsedMilliseconds"> {
	return {
		sequence: event.sequence,
		type: event.type,
		nodeId: event.nodeId,
		requestId: event.requestId,
		...(event.detail === undefined ? {} : { detail: event.detail }),
	};
}
function lines(values: readonly unknown[]): string {
	return `${values.map(canonicalJson).join("\n")}\n`;
}
/** Only these normalized artifacts are deterministic across equivalent fixture runs. */
function deterministicBundleId(
	files: Pick<
		Record<(typeof EVIDENCE_FILES)[number], string>,
		"oracle.jsonl" | "cost-attribution.json" | "summary.json"
	>,
): string {
	return fingerprint({
		oracle: files["oracle.jsonl"],
		costAttribution: files["cost-attribution.json"],
		summary: files["summary.json"],
	});
}
function fileContents(evidence: SwarmEvidence): Record<(typeof EVIDENCE_FILES)[number], string> {
	const redacted = redactEvidence(evidence);
	return {
		"events.jsonl": lines(redacted.events),
		"oracle.jsonl": lines(evidence.events.map(oracleEvent)),
		"process-samples.json": `${canonicalJson(redacted.processSamples)}\n`,
		"cost-attribution.json": `${canonicalJson(redacted.costAttribution)}\n`,
		"summary.json": `${canonicalJson(redacted.summary)}\n`,
	};
}
/**
 * Writes canonical content-free artifacts and returns the only trust root the
 * verifier accepts. The capability is registered in this process for this
 * canonical directory and exact artifact-index commitment; it cannot be
 * reconstructed from manifest.json.
 */
export async function writeSwarmEvidence(directory: string, evidence: SwarmEvidence): Promise<SwarmEvidenceCapability> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const root = await realpath(directory);
	const files = fileContents(evidence);
	for (const name of EVIDENCE_FILES) await writeFile(join(root, name), files[name], { encoding: "utf8", mode: 0o600 });
	const artifacts: EvidenceArtifact[] = EVIDENCE_FILES.map((path) => ({
		path,
		bytes: Buffer.byteLength(files[path]),
		sha256: sha256(files[path]),
		schemaVersion: SWARM_EVIDENCE_SCHEMA_VERSION,
	}));
	const manifest = {
		...redactEvidence(evidence.manifest),
		deterministicBundleId: deterministicBundleId(files),
		artifactBundleId: fingerprint(artifacts),
		artifacts,
	};
	await writeFile(join(root, "manifest.json"), `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
	const capability = issueSwarmEvidenceCapability();
	registeredBundles.set(capability, { directory: root, artifactBundleId: manifest.artifactBundleId });
	await verifySwarmEvidence(root, capability);
	return capability;
}
function parseCanonicalJson(raw: string, label: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`invalid JSON: ${label}`);
	}
	assert(raw === `${canonicalJson(parsed)}\n`, `non-canonical JSON: ${label}`);
	return parsed;
}
function parseCanonicalJsonl(raw: string, label: string): unknown[] {
	assert(raw.endsWith("\n"), `invalid JSONL terminator: ${label}`);
	const entries = raw.slice(0, -1).split("\n");
	assert(entries.length > 0 && entries.every(Boolean), `invalid JSONL: ${label}`);
	return entries.map((entry, index) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(entry);
		} catch {
			throw new Error(`invalid JSONL: ${label}:${index + 1}`);
		}
		assert(entry === canonicalJson(parsed), `non-canonical JSONL: ${label}:${index + 1}`);
		return parsed;
	});
}
function requireManifest(manifest: unknown): asserts manifest is SwarmManifest & { artifacts: EvidenceArtifact[] } {
	assert(isRecord(manifest), "manifest must be an object");
	assert(
		manifest.schemaVersion === SWARM_EVIDENCE_SCHEMA_VERSION && manifest.benchmarkVersion === "b00a",
		"unsupported manifest schema",
	);
	assert(
		typeof manifest.fingerprint === "string" && /^[0-9a-f]{64}$/.test(manifest.fingerprint),
		"invalid manifest fingerprint",
	);
	assert(
		Array.isArray(manifest.assignments) &&
			Array.isArray(manifest.faultSchedule) &&
			isRecord(manifest.priceCard) &&
			isRecord(manifest.metadata) &&
			isRecord(manifest.runtime),
		"invalid manifest shape",
	);
	assert(Array.isArray(manifest.artifacts), "manifest has no artifact index");
	assert(
		typeof manifest.deterministicBundleId === "string" && /^[0-9a-f]{64}$/.test(manifest.deterministicBundleId),
		"invalid deterministic bundle identity",
	);
	assert(
		typeof manifest.artifactBundleId === "string" && /^[0-9a-f]{64}$/.test(manifest.artifactBundleId),
		"invalid artifact bundle identity",
	);
	assertContentFree(manifest);
	const source = {
		schemaVersion: manifest.schemaVersion,
		benchmarkVersion: manifest.benchmarkVersion,
		scenario: manifest.scenario,
		assignments: manifest.assignments,
		faultSchedule: manifest.faultSchedule,
		priceCard: manifest.priceCard,
		metadata: manifest.metadata,
	};
	assert(fingerprint(source) === manifest.fingerprint, "manifest fingerprint mismatch");
}
function verifyEvents(events: readonly unknown[], oracle: readonly unknown[], assignments: readonly unknown[]): void {
	assert(events.length === oracle.length && events.length > 0, "event/oracle length mismatch");
	const nodeIds = new Set(
		(assignments as readonly Record<string, unknown>[]).map((assignment) => assignment.nodeId).filter(isString),
	);
	let previousSequence = 0;
	const byNode = new Map<string, Record<string, unknown>[]>();
	for (let index = 0; index < events.length; index++) {
		const eventCandidate = events[index];
		const logicalCandidate = oracle[index];
		assert(isRecord(eventCandidate) && isRecord(logicalCandidate), "invalid event record");
		const event: Record<string, unknown> = eventCandidate;
		const logical: Record<string, unknown> = logicalCandidate;
		assertContentFree(event);
		assertContentFree(logical);
		assert(
			event.sequence === logical.sequence &&
				event.type === logical.type &&
				event.nodeId === logical.nodeId &&
				event.requestId === logical.requestId &&
				canonicalJson(event.detail ?? null) === canonicalJson(logical.detail ?? null),
			"oracle differs from event facts",
		);
		assert(isSafeInteger(event.sequence) && event.sequence > previousSequence, "invalid event sequence");
		previousSequence = event.sequence;
		assert(
			typeof event.elapsedMilliseconds === "number" &&
				Number.isFinite(event.elapsedMilliseconds) &&
				(EVENT_TYPES as readonly unknown[]).includes(event.type),
			"invalid event timing/type",
		);
		assert(
			typeof event.nodeId === "string" &&
				nodeIds.has(event.nodeId) &&
				event.requestId === `request-${event.nodeId.slice("worker-".length)}`,
			"invalid event identity",
		);
		assert(
			canonicalJson(logical) === canonicalJson(oracleEvent(event as SwarmEvent)),
			"oracle contains non-logical event data",
		);
		const detail = event.detail;
		const exactDetail = (keys: readonly string[]) =>
			assert(
				(detail === undefined && keys.length === 0) ||
					(isRecord(detail) && canonicalJson(Object.keys(detail).sort()) === canonicalJson([...keys].sort())),
				`invalid event detail: ${event.type}`,
			);
		switch (event.type) {
			case "dispatch_admitted":
			case "delivery_completed":
			case "cleanup_completed":
				exactDetail([]);
				break;
			case "provider_request_started":
				exactDetail(["role", "requested", "resolved"]);
				break;
			case "progress":
				exactDetail(["message"]);
				break;
			case "restart":
				exactDetail(["reason"]);
				break;
			case "provider_failure":
				exactDetail(["code", "message"]);
				break;
			case "provider_completed":
				exactDetail(["outputTokens"]);
				assert(isRecord(detail) && isSafeInteger(detail.outputTokens), "invalid completion usage");
				break;
		}
		const nodeId = event.nodeId;
		assert(typeof nodeId === "string", "invalid event identity");
		const lifecycle = byNode.get(nodeId) ?? [];
		lifecycle.push(event);
		byNode.set(nodeId, lifecycle);
	}
	for (const nodeId of nodeIds) {
		const lifecycle = byNode.get(nodeId) ?? [];
		const types = lifecycle.map((event) => event.type);
		assert(
			types.filter((type) => type === "dispatch_admitted").length === 1,
			`invalid admission lifecycle: ${nodeId}`,
		);
		assert(
			types.filter((type) => type === "provider_request_started").length === 1,
			`invalid start lifecycle: ${nodeId}`,
		);
		assert(types.filter((type) => type === "cleanup_completed").length === 1, `invalid cleanup lifecycle: ${nodeId}`);
		const terminal = types.filter((type) => type === "provider_completed" || type === "provider_failure");
		assert(terminal.length === 1, `invalid terminal lifecycle: ${nodeId}`);
		assert(
			types.indexOf("dispatch_admitted") < types.indexOf("provider_request_started"),
			`invalid lifecycle order: ${nodeId}`,
		);
		assert(types.at(-1) === "cleanup_completed", `cleanup must be final: ${nodeId}`);
		if (terminal[0] === "provider_completed")
			assert(
				types.filter((type) => type === "delivery_completed").length === 1,
				`missing delivery lifecycle: ${nodeId}`,
			);
		else assert(!types.includes("delivery_completed"), `failed request delivered: ${nodeId}`);
	}
}
function verifySummary(events: Record<string, unknown>[], summary: unknown, assignmentCount: number): void {
	assert(isRecord(summary), "invalid summary");
	const count = (type: EventType) => events.filter((event) => event.type === type).length;
	const completed = count("provider_completed"),
		failed = count("provider_failure"),
		started = count("provider_request_started");
	assert(
		summary.admitted === assignmentCount &&
			summary.started === started &&
			summary.completed === completed &&
			summary.failed === failed &&
			summary.delivered === count("delivery_completed") &&
			summary.cleanedUp === count("cleanup_completed"),
		"summary/event mismatch",
	);
	const firstTerminal = events.findIndex(
		(event) => event.type === "provider_completed" || event.type === "provider_failure",
	);
	const independent =
		firstTerminal < 0 ||
		events.slice(0, firstTerminal).filter((event) => event.type === "provider_request_started").length ===
			assignmentCount;
	assert(summary.independentDispatch === independent, "independent-dispatch mismatch");
	assert(
		started === assignmentCount &&
			completed + failed === assignmentCount &&
			count("cleanup_completed") === assignmentCount,
		"terminal event invariant failed",
	);
}
function verifyCosts(
	costs: unknown,
	assignments: readonly unknown[],
	priceCard: Readonly<{ inputPerMillionTokens: unknown; outputPerMillionTokens: unknown }>,
	events: readonly Record<string, unknown>[],
): void {
	assert(Array.isArray(costs), "invalid cost attribution");
	const inputPrice = priceCard.inputPerMillionTokens,
		outputPrice = priceCard.outputPerMillionTokens;
	assert(isSafeInteger(inputPrice) && isSafeInteger(outputPrice), "invalid price card");
	const rows = costs as Record<string, unknown>[];
	const ids = new Set<string>();
	for (const row of rows) {
		assert(isRecord(row) && typeof row.id === "string" && !ids.has(row.id), "duplicate or invalid cost id");
		ids.add(row.id);
		for (const key of ["directInputTokens", "directOutputTokens", "downstreamInputTokens", "downstreamOutputTokens"])
			assert(isSafeInteger(row[key]), `invalid ${key}`);
		for (const key of ["directCost", "downstreamCost"])
			assert(typeof row[key] === "number" && Number.isFinite(row[key]), `invalid ${key}`);
	}
	const nodes = rows.filter((row) => row.kind === "node");
	const assignmentRows = assignments as readonly Record<string, unknown>[];
	assert(
		nodes.length === assignmentRows.length &&
			nodes.every((node) => assignmentRows.some((assignment) => assignment.nodeId === node.id)),
		"node-cost set mismatch",
	);
	const nodeById = new Map(nodes.map((node) => [node.id as string, node]));
	const completedOutputByNode = new Map<string, number>();
	for (const event of events)
		if (event.type === "provider_completed") {
			assert(isRecord(event.detail) && isSafeInteger(event.detail.outputTokens), "invalid terminal usage");
			assert(!completedOutputByNode.has(event.nodeId as string), "duplicate terminal usage");
			completedOutputByNode.set(event.nodeId as string, event.detail.outputTokens);
		}
	for (const node of nodes) {
		const assignment = assignmentRows.find((candidate) => candidate.nodeId === node.id);
		assert(assignment, `missing assignment for cost node: ${node.id}`);
		assert(node.directInputTokens === assignment.inputTokens, `assignment input usage mismatch: ${node.id}`);
		assert(
			node.directOutputTokens === (completedOutputByNode.get(node.id as string) ?? 0),
			`terminal output usage mismatch: ${node.id}`,
		);
		assert(
			node.directCost ===
				money(node.directInputTokens as number, inputPrice) + money(node.directOutputTokens as number, outputPrice),
			"direct economics mismatch",
		);
		const children = assignmentRows
			.filter((assignment) => assignment.parentNodeId === node.id)
			.map((assignment) => nodeById.get(assignment.nodeId as string));
		assert(children.every(isRecord), "missing child cost");
		for (const suffix of ["InputTokens", "OutputTokens", "Cost"] as const) {
			const direct = node[`direct${suffix}`];
			assert(typeof direct === "number", `invalid direct cost field: ${suffix}`);
			assert(
				node[`downstream${suffix}`] ===
					direct + children.reduce((sum, child) => sum + (child[`downstream${suffix}`] as number), 0),
				`node tree invariant failed: ${node.id}:${suffix}`,
			);
		}
	}
	const descendants = (id: string, visited = new Set<string>()): Record<string, unknown>[] => {
		assert(!visited.has(id), "cycle in assignment tree");
		visited.add(id);
		return [
			nodeById.get(id)!,
			...assignmentRows
				.filter((assignment) => assignment.parentNodeId === id)
				.flatMap((assignment) => descendants(assignment.nodeId as string, visited)),
		];
	};
	const roleRows = rows.filter((row) => row.kind === "role");
	const roles = [...new Set(assignmentRows.map((assignment) => assignment.role))];
	assert(
		roleRows.length === roles.length && roleRows.every((row) => roles.includes(row.id)),
		"role-cost set mismatch",
	);
	for (const role of roleRows) {
		const direct = assignmentRows
			.filter((assignment) => assignment.role === role.id)
			.map((assignment) => nodeById.get(assignment.nodeId as string)!);
		const included = new Map(direct.flatMap((node) => descendants(node.id as string)).map((node) => [node.id, node]));
		for (const suffix of ["InputTokens", "OutputTokens", "Cost"] as const) {
			assert(
				role[`direct${suffix}`] === direct.reduce((sum, node) => sum + (node[`direct${suffix}`] as number), 0),
				`role direct invariant failed: ${role.id}:${suffix}`,
			);
			assert(
				role[`downstream${suffix}`] ===
					[...included.values()].reduce((sum, node) => sum + (node[`direct${suffix}`] as number), 0),
				`role tree invariant failed: ${role.id}:${suffix}`,
			);
		}
	}
	const run = rows.find((row) => row.id === "run" && row.kind === "run");
	assert(run, "missing run cost");
	const roots = nodes.filter(
		(node) => !assignmentRows.find((assignment) => assignment.nodeId === node.id)?.parentNodeId,
	);
	for (const suffix of ["InputTokens", "OutputTokens", "Cost"] as const)
		assert(
			run[`downstream${suffix}`] === roots.reduce((sum, node) => sum + (node[`downstream${suffix}`] as number), 0),
			`run tree invariant failed: ${suffix}`,
		);
}
function verifyProcessSamples(samples: unknown): void {
	assert(Array.isArray(samples) && samples.length === 4, "invalid process sample count");
	const expected = ["before_dispatch", "after_admission", "after_terminal", "after_cleanup"];
	let priorSequence = 0;
	for (let index = 0; index < samples.length; index++) {
		const sample = samples[index];
		assert(isRecord(sample) && sample.phase === expected[index], "invalid process sample phase");
		assert(isSafeInteger(sample.sequence) && sample.sequence > priorSequence, "invalid process sample sequence");
		priorSequence = sample.sequence as number;
		assert(
			typeof sample.elapsedMilliseconds === "number" &&
				Number.isFinite(sample.elapsedMilliseconds) &&
				sample.elapsedMilliseconds >= 0,
			"invalid process sample timing",
		);
		assert(
			typeof sample.source === "string" && Array.isArray(sample.processes) && isSafeInteger(sample.totalRssBytes),
			"invalid process sample shape",
		);
		let total = 0;
		for (const process of sample.processes) {
			assert(
				isRecord(process) && isSafeInteger(process.pid) && isSafeInteger(process.rssBytes),
				"invalid process record",
			);
			if (process.parentPid !== undefined) assert(isSafeInteger(process.parentPid), "invalid process parent");
			for (const key of ["heapUsedBytes", "externalBytes"])
				if (process[key] !== undefined) assert(isSafeInteger(process[key]), `invalid process ${key}`);
			total += process.rssBytes as number;
		}
		assert(sample.totalRssBytes === total, "process RSS total mismatch");
		assertContentFree(sample);
	}
}

/** Strict verifier: expected set only, no links/extras, canonical bytes, hashes, and semantic joins. */
export async function verifySwarmEvidence(directory: string, capability: SwarmEvidenceCapability): Promise<void> {
	const registration = registeredBundles.get(capability);
	assert(registration, "issued swarm evidence capability is required");
	const root = await realpath(directory);
	assert(root === registration.directory, "swarm evidence capability directory mismatch");
	const names = (await readdir(root)).sort();
	assert(
		canonicalJson(names) === canonicalJson([...ALL_EVIDENCE_FILES].sort()),
		"unexpected or missing evidence artifact",
	);
	for (const name of ALL_EVIDENCE_FILES) {
		const info = await lstat(join(root, name));
		assert(info.isFile() && !info.isSymbolicLink(), `unsafe evidence artifact: ${name}`);
	}
	const manifestRaw = await readFile(join(root, "manifest.json"), "utf8");
	const manifest = parseCanonicalJson(manifestRaw, "manifest.json");
	requireManifest(manifest);
	assert(manifest.artifacts.length === EVIDENCE_FILES.length, "wrong artifact count");
	const indexed = new Set<string>();
	for (const artifact of manifest.artifacts) {
		assert(
			isRecord(artifact) &&
				typeof artifact.path === "string" &&
				(EVIDENCE_FILES as readonly string[]).includes(artifact.path) &&
				!indexed.has(artifact.path),
			"invalid or duplicate artifact index",
		);
		indexed.add(artifact.path);
		assert(
			artifact.schemaVersion === SWARM_EVIDENCE_SCHEMA_VERSION &&
				isSafeInteger(artifact.bytes) &&
				typeof artifact.sha256 === "string" &&
				/^[0-9a-f]{64}$/.test(artifact.sha256),
			"invalid artifact metadata",
		);
		const raw = await readFile(join(root, artifact.path), "utf8");
		const info = await stat(join(root, artifact.path));
		assert(
			info.size === artifact.bytes && Buffer.byteLength(raw) === artifact.bytes && sha256(raw) === artifact.sha256,
			`evidence artifact hash mismatch: ${artifact.path}`,
		);
	}
	assert(indexed.size === EVIDENCE_FILES.length, "missing indexed artifact");
	assert(manifest.artifactBundleId === fingerprint(manifest.artifacts), "artifact bundle identity mismatch");
	const events = parseCanonicalJsonl(await readFile(join(root, "events.jsonl"), "utf8"), "events.jsonl");
	const oracle = parseCanonicalJsonl(await readFile(join(root, "oracle.jsonl"), "utf8"), "oracle.jsonl");
	verifyEvents(events, oracle, manifest.assignments);
	verifySummary(
		events as Record<string, unknown>[],
		parseCanonicalJson(await readFile(join(root, "summary.json"), "utf8"), "summary.json"),
		manifest.assignments.length,
	);
	verifyCosts(
		parseCanonicalJson(await readFile(join(root, "cost-attribution.json"), "utf8"), "cost-attribution.json"),
		manifest.assignments,
		manifest.priceCard,
		events as Record<string, unknown>[],
	);
	const processSamples = parseCanonicalJson(
		await readFile(join(root, "process-samples.json"), "utf8"),
		"process-samples.json",
	);
	verifyProcessSamples(processSamples);
	const deterministic = deterministicBundleId({
		"oracle.jsonl": await readFile(join(root, "oracle.jsonl"), "utf8"),
		"cost-attribution.json": await readFile(join(root, "cost-attribution.json"), "utf8"),
		"summary.json": await readFile(join(root, "summary.json"), "utf8"),
	});
	assert(manifest.deterministicBundleId === deterministic, "deterministic bundle identity mismatch");
	assert(
		manifest.artifactBundleId === registration.artifactBundleId,
		"issued swarm evidence capability bundle mismatch",
	);
}
export function createFixedFanoutScenario(fanout: (typeof SUPPORTED_SWARM_FANOUTS)[number]): SwarmBenchmarkConfig {
	return {
		scenario: `fixed-fanout-${fanout}`,
		assignments: Array.from({ length: fanout }, (_, index) => ({
			nodeId: `child-${index + 1}`,
			parentNodeId: "root",
			role: "worker",
			requested: { provider: "local-fake", model: "deterministic-v1", revision: "b00a", effort: "low" },
			inputTokens: 32,
			outputTokens: 16,
		})),
		priceCard: { version: "local-fake-v1", inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
	};
}
