import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type CompactionResult,
	type CompactionSettings,
	compact,
	prepareCompaction,
} from "../../core/compaction/index.js";
import type { ExtensionRunner, SessionBeforeCompactResult } from "../../core/extensions/index.js";
import type { ProviderRetryPolicy } from "../../core/provider-retry.js";
import { modelRequestHeaders, type SemanticEdgeRecorder } from "../../core/semantic-edges.js";
import type { CompactionEntry, SessionManager } from "../../core/session-manager.js";

export class CompactionSkippedError extends Error {}

export interface CompactionExecutionOptions {
	model: Model<Api>;
	apiKey: string;
	headers?: Record<string, string>;
	customInstructions?: string;
	signal: AbortSignal;
}

export interface CompactionExecutionHost {
	getSessionStore(): Pick<SessionManager, "getBranch" | "appendCompaction" | "getEntries">;
	getSettings(): CompactionSettings;
	getSemanticEdges(): Pick<
		SemanticEdgeRecorder,
		"beginCompaction" | "startCompactionRequest" | "failRequest" | "finishRequest" | "finishCompaction"
	>;
	getExtensions(): Pick<ExtensionRunner, "hasHandlers" | "emit">;
	getThinkingLevel(): ThinkingLevel;
	getRetryPolicy(): ProviderRetryPolicy;
	getHarnessDigest(): string;
	rebuildContext(): void;
	syncKernelState(): Promise<void>;
	reapDeletedChildren(): Promise<void>;
}

export async function performSessionCompaction(
	host: CompactionExecutionHost,
	options: CompactionExecutionOptions,
): Promise<CompactionResult> {
	const { model, apiKey, headers, customInstructions, signal } = options;
	const pathEntries = host.getSessionStore().getBranch();
	const settings = host.getSettings();

	const preparation = prepareCompaction(pathEntries, settings);
	if (!preparation) {
		const lastEntry = pathEntries[pathEntries.length - 1];
		if (lastEntry?.type === "compaction") {
			throw new CompactionSkippedError("Already compacted");
		}
		throw new CompactionSkippedError("Session is too short to compact — try again once it grows");
	}

	let extensionCompaction: CompactionResult | undefined;
	let fromExtension = false;

	const semanticCompaction = host.getSemanticEdges().beginCompaction();
	let compactionRecorded = false;
	const uncommittedSlices: string[] = [];
	let compactionSettled = false;
	let summary: string;
	let firstKeptEntryId: string;
	let tokensBefore: number;
	let details: CompactionResult["details"];
	let usage: CompactionResult["usage"];
	try {
		if (host.getExtensions().hasHandlers("session_before_compact")) {
			const result = (await host.getExtensions().emit({
				type: "session_before_compact",
				preparation,
				branchEntries: pathEntries,
				customInstructions,
				signal,
			})) as SessionBeforeCompactResult | undefined;

			if (result?.cancel) {
				throw new Error("Compaction cancelled");
			}

			if (result?.compaction) {
				extensionCompaction = result.compaction;
				fromExtension = true;
			}
		}

		if (extensionCompaction) {
			({ summary, firstKeptEntryId, tokensBefore, details, usage } = extensionCompaction);
		} else {
			// Each summary wire call gets its own request ID: split turns send two
			// different bodies, and one Idempotency-Key must never cover both. A slice
			// that succeeds on the wire stays uncommitted until the compaction itself
			// commits: a racing sibling's failure (or an abort) must leave no committed
			// summary request for the next turn's continuation edge to attach to.
			const summaryCall = async <T>(
				call: (callHeaders: Record<string, string> | undefined) => Promise<T>,
			): Promise<T> => {
				const requestId = host.getSemanticEdges().startCompactionRequest(semanticCompaction.compactionId);
				if (requestId === undefined) {
					return call(headers);
				}
				try {
					const result = await call({ ...headers, ...modelRequestHeaders(requestId) });
					// A slice resolving after a sibling's rejection already settled the
					// compaction would push into a drained list and stay in-flight forever.
					if (compactionSettled) {
						host.getSemanticEdges().failRequest(requestId);
					} else {
						uncommittedSlices.push(requestId);
					}
					return result;
				} catch (error) {
					host.getSemanticEdges().failRequest(requestId);
					throw error;
				}
			};
			({ summary, firstKeptEntryId, tokensBefore, details, usage } = await compact(
				preparation,
				model,
				apiKey,
				headers,
				customInstructions,
				signal,
				host.getThinkingLevel(),
				summaryCall,
				host.getRetryPolicy(),
			));
		}

		if (signal.aborted) {
			throw new Error("Compaction cancelled");
		}

		// Ledger-before-effect: the compaction outcome is durable before the transcript
		// commits it. Marked first: the ID is consumed even when the write throws, and a
		// second finish attempt would mask the original I/O error.
		compactionRecorded = true;
		compactionSettled = true;
		for (const requestId of uncommittedSlices.splice(0)) {
			host.getSemanticEdges().finishRequest(requestId);
		}
		host.getSemanticEdges().finishCompaction(semanticCompaction.compactionId, "completed");
		// Attached mechanically; the digest never flows through the summarizer LLM.
		host
			.getSessionStore()
			.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				customInstructions,
				usage,
				host.getHarnessDigest(),
			);
	} catch (error) {
		compactionSettled = true;
		for (const requestId of uncommittedSlices.splice(0)) {
			host.getSemanticEdges().failRequest(requestId);
		}
		if (!compactionRecorded) {
			const cancelled =
				error instanceof Error && (error.name === "AbortError" || error.message === "Compaction cancelled");
			host.getSemanticEdges().finishCompaction(semanticCompaction.compactionId, cancelled ? "cancelled" : "failed");
		}
		throw error;
	}
	const newEntries = host.getSessionStore().getEntries();
	host.rebuildContext();

	const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
		| CompactionEntry
		| undefined;
	if (savedCompactionEntry) {
		await host.getExtensions().emit({
			type: "session_compact",
			compactionEntry: savedCompactionEntry,
			fromExtension,
		});
	}
	await host.syncKernelState();
	await host.reapDeletedChildren();

	return { summary, firstKeptEntryId, tokensBefore, details };
}
