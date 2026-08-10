import { createHash, randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { cpus, release, type } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createStreamingJsonParseState,
	getLegacyStreamingJsonInputExaminedForTesting,
	getStreamingJsonInputExaminedForTesting,
	parseStreamingJson,
	resetStreamingJsonParseInstrumentationForTesting,
} from "../src/utils/json-parse.js";

export const BENCHMARK_NAME = "N01-streaming-structured-output-parse-cpu";
export const MAX_CORPUS_BYTES = 16 * 1024 * 1024;
export const MAX_REPETITIONS = 21;
type Mode = "legacy" | "incremental";
export type BenchmarkOptions = {
	name: string;
	output: string;
	escapedBytes: number;
	unicodeBytes: number;
	repetitions: number;
};

type CorpusPlan = {
	entries: number;
	structuralMinimum: number;
	estimatedBytes: number;
};

function requiredOption(args: string[], name: string): string {
	const index = args.indexOf(name);
	if (index === -1 || args[index + 1] === undefined) throw new Error(`${name} requires a value`);
	return args[index + 1];
}

function positiveBoundedIntegerOption(args: string[], name: string, defaultValue: number, maximum: number): number {
	const index = args.indexOf(name);
	if (index === -1) return defaultValue;
	const parsed = Number(args[index + 1]);
	if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum)
		throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
	return parsed;
}

/** Parses and bounds every allocation-driving option before corpus estimation or allocation. */
export function parseBenchmarkOptions(args: string[]): BenchmarkOptions {
	const name = requiredOption(args, "--name");
	if (name !== BENCHMARK_NAME) throw new Error(`--name must be ${BENCHMARK_NAME}`);
	return {
		name,
		output: requiredOption(args, "--json"),
		escapedBytes: positiveBoundedIntegerOption(args, "--escaped-bytes", 1024 * 1024, MAX_CORPUS_BYTES),
		unicodeBytes: positiveBoundedIntegerOption(args, "--unicode-bytes", 256 * 1024, MAX_CORPUS_BYTES),
		repetitions: positiveBoundedIntegerOption(args, "--repetitions", 7, MAX_REPETITIONS),
	};
}

function nonnegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}

function safeNumber(value: bigint, name: string): number {
	if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error(`${name} exceeds Number.MAX_SAFE_INTEGER`);
	return Number(value);
}

function corpusDocument(outer: Array<{ index: number; text: string }>, padding: string): string {
	return JSON.stringify({ outer, padding });
}

/**
 * Returns the UTF-8 byte count for a corpus with `count` nested entries and no padding.
 * BigInt keeps every multiplication and addition exact before the checked Number conversion.
 */
export function estimateNestedCorpusBytes(count: number, text: string, emptyBytes: number): number {
	nonnegativeSafeInteger(count, "entry count");
	nonnegativeSafeInteger(emptyBytes, "empty corpus bytes");
	if (count === 0) return emptyBytes;
	const firstEntryBytes = Buffer.byteLength(JSON.stringify({ index: 0, text }));
	nonnegativeSafeInteger(firstEntryBytes, "first entry bytes");

	const countBig = BigInt(count);
	let indexedDigits = 0n;
	let start = 0n;
	let threshold = 10n;
	for (let digits = 1n; start < countBig; digits++) {
		const end = countBig < threshold ? countBig : threshold;
		indexedDigits += (end - start) * digits;
		start = end;
		threshold *= 10n;
	}
	return safeNumber(
		BigInt(emptyBytes) + countBig * BigInt(firstEntryBytes - 1) + indexedDigits + countBig - 1n,
		"estimated corpus bytes",
	);
}

function corpusText(unicode: boolean): string {
	return unicode ? "😀\u2028 nested é " : '\\"escaped\\n nested ';
}

/** Estimates the largest nested corpus that fits a target without constructing its document. */
export function estimateCorpusPlan(bytes: number, unicode: boolean): CorpusPlan {
	nonnegativeSafeInteger(bytes, "requested corpus bytes");
	if (bytes > MAX_CORPUS_BYTES) throw new Error(`requested corpus bytes must be no greater than ${MAX_CORPUS_BYTES}`);
	const text = corpusText(unicode);
	const emptyBytes = Buffer.byteLength(corpusDocument([], ""));
	const structuralMinimum = estimateNestedCorpusBytes(1, text, emptyBytes);
	if (bytes < structuralMinimum)
		throw new Error(`requested ${bytes} bytes is below structural minimum ${structuralMinimum}`);

	const firstEntryBytes = structuralMinimum - emptyBytes;
	const maximumEntries = Math.floor((bytes - emptyBytes) / firstEntryBytes);
	nonnegativeSafeInteger(maximumEntries, "maximum entries");
	let lower = 1;
	let upper = maximumEntries;
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (estimateNestedCorpusBytes(middle, text, emptyBytes) <= bytes) lower = middle;
		else upper = middle - 1;
	}
	return {
		entries: lower,
		structuralMinimum,
		estimatedBytes: estimateNestedCorpusBytes(lower, text, emptyBytes),
	};
}

/**
 * Find a bounded number of nested entries before filling the exact remaining
 * UTF-8 budget with ASCII. The estimator makes the preflight logarithmic,
 * rather than constructing increasingly large candidate documents.
 */
function corpus(bytes: number, unicode: boolean): string {
	const text = corpusText(unicode);
	const plan = estimateCorpusPlan(bytes, unicode);
	const outer = Array.from({ length: plan.entries }, (_, index) => ({ index, text }));
	const paddingBytes = bytes - plan.estimatedBytes;
	const document = corpusDocument(outer, "x".repeat(paddingBytes));
	if (Buffer.byteLength(document) !== bytes) throw new Error("corpus did not meet requested UTF-8 byte length");
	return document;
}

function chunks(document: string, size: number): string[] {
	return Array.from({ length: Math.ceil(document.length / size) }, (_, index) =>
		document.slice(index * size, (index + 1) * size),
	);
}

function measured(document: string, input: string[], mode: Mode) {
	resetStreamingJsonParseInstrumentationForTesting();
	const resourcesBefore = process.resourceUsage();
	const wallBefore = process.hrtime.bigint();
	let result: unknown;
	let examined: number;
	if (mode === "legacy") {
		let prefix = "";
		for (const chunk of input) {
			prefix += chunk;
			parseStreamingJson(prefix);
		}
		result = JSON.parse(prefix);
		examined = getLegacyStreamingJsonInputExaminedForTesting() + document.length;
	} else {
		const state = createStreamingJsonParseState();
		for (const chunk of input) state.append(chunk);
		result = state.finalize();
		examined = getStreamingJsonInputExaminedForTesting(state).total;
	}
	if (JSON.stringify(result) !== document) throw new Error(`${mode} result differs from source document`);
	const resourcesAfter = process.resourceUsage();
	return {
		wallNs: Number(process.hrtime.bigint() - wallBefore),
		cpuUs:
			resourcesAfter.userCPUTime -
			resourcesBefore.userCPUTime +
			(resourcesAfter.systemCPUTime - resourcesBefore.systemCPUTime),
		inputExamined: examined,
		chunkCount: input.length,
	};
}

function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
}

function writeJsonAtomically(output: string, value: unknown): void {
	const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, output);
}

function run(options: BenchmarkOptions): void {
	const results = [
		{
			name: `escaped-nested-${options.escapedBytes}-64`,
			document: corpus(options.escapedBytes, false),
			chunkSize: 64,
		},
		{ name: `unicode-nested-${options.unicodeBytes}-7`, document: corpus(options.unicodeBytes, true), chunkSize: 7 },
	].map(({ name, document, chunkSize }) => {
		const input = chunks(document, chunkSize);
		measured(document, input, "legacy");
		measured(document, input, "incremental");
		const samples: Record<Mode, ReturnType<typeof measured>[]> = { legacy: [], incremental: [] };
		for (let repetition = 0; repetition < options.repetitions; repetition++) {
			const order: Mode[] = repetition % 2 === 0 ? ["legacy", "incremental"] : ["incremental", "legacy"];
			for (const mode of order) samples[mode].push(measured(document, input, mode));
		}
		const legacyCpuUs = stats(samples.legacy.map((sample) => sample.cpuUs));
		const incrementalCpuUs = stats(samples.incremental.map((sample) => sample.cpuUs));
		if (samples.incremental[0].inputExamined !== document.length * 2)
			throw new Error("incremental input examination is not linear");
		if (incrementalCpuUs.median >= legacyCpuUs.median)
			throw new Error("incremental median CPU did not beat legacy replay");
		const inputBytes = Buffer.byteLength(document);
		if (inputBytes !== (name.startsWith("escaped") ? options.escapedBytes : options.unicodeBytes))
			throw new Error("corpus byte length differs from requested target");
		return {
			name,
			inputHash: createHash("sha256").update(document).digest("hex"),
			inputBytes,
			inputLength: document.length,
			chunkCount: input.length,
			repetitions: options.repetitions,
			order: "alternating legacy/incremental by repetition",
			legacy: {
				wallNs: stats(samples.legacy.map((sample) => sample.wallNs)),
				cpuUs: legacyCpuUs,
				inputExamined: samples.legacy[0].inputExamined,
			},
			incremental: {
				wallNs: stats(samples.incremental.map((sample) => sample.wallNs)),
				cpuUs: incrementalCpuUs,
				inputExamined: samples.incremental[0].inputExamined,
			},
		};
	});
	writeJsonAtomically(options.output, {
		name: options.name,
		command: process.argv.join(" "),
		node: process.version,
		os: {
			platform: process.platform,
			release: release(),
			arch: process.arch,
			type: type(),
		},
		cpu: cpus()[0]?.model ?? "unknown",
		results,
	});
}

function isDirectExecution(): boolean {
	return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) run(parseBenchmarkOptions(process.argv.slice(2)));
