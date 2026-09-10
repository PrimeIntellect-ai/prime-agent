import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateContextTokens } from "../core/compaction/index.js";
import {
	type ContextTreeNode,
	type ContextWindowResolver,
	computeOwnAndTotalUsage,
	loadContextTreeChildFromDisk,
	loadContextTreeChildrenFromDisk,
} from "../core/context-tree.js";
import type { ContextUsage } from "../core/extensions/index.js";
import { getLatestCompactionEntry, type SessionEntry, type SessionManager } from "../core/session-manager.js";
import type { SessionStats } from "../core/session-stats.js";
import { emptyUsage, type SessionUsageSummary, sessionUsageSummaryFrom } from "../core/usage.js";

export interface ContextViewChild {
	id: string;
	label: string;
	status: ContextTreeNode["status"];
	sessionDir: string;
	getContextTree?: () => ContextTreeNode;
}
export interface ContextViewHost {
	sessionManager: Pick<
		SessionManager,
		"getEntries" | "getBranch" | "getSessionId" | "getSessionFile" | "getSessionName"
	>;
	getMessages(): AgentMessage[];
	getContextUsage(): ContextUsage | undefined;
	getModel(): Model<Api> | undefined;
	findModel(provider: string, modelId: string): Model<Api> | undefined;
	subtractUnindexedChildUsage(ownUsage: Usage, entries: SessionEntry[]): void;
	getLiveChildren(): Iterable<ContextViewChild>;
	getRlmSessionDir(): string | undefined;
}
export class SessionContextView {
	private _ownUsageMemo?: { count: number; tailId: string | undefined; usage: SessionUsageSummary | undefined };
	constructor(private readonly host: ContextViewHost) {}
	invalidateOwnUsage(): void {
		this._ownUsageMemo = undefined;
	}
	getSessionStats(): SessionStats {
		const state = { messages: this.host.getMessages() };
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.host.sessionManager.getSessionFile(),
			sessionId: this.host.sessionManager.getSessionId(),
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.host.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.host.getModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.host.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.host.getMessages());
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	private _contextWindowResolver(): ContextWindowResolver {
		return (provider, modelId) => this.host.findModel(provider, modelId)?.contextWindow;
	}

	getOwnUsageSummary(): SessionUsageSummary | undefined {
		const entries = this.host.sessionManager.getEntries();
		const tailId = entries.at(-1)?.id;
		const memo = this._ownUsageMemo;
		if (memo && memo.count === entries.length && memo.tailId === tailId) {
			return memo.usage;
		}
		const { ownUsage } = computeOwnAndTotalUsage(entries, entries);
		this.host.subtractUnindexedChildUsage(ownUsage, entries);
		const usage = sessionUsageSummaryFrom(ownUsage);
		this._ownUsageMemo = { count: entries.length, tailId, usage };
		return usage;
	}

	getContextTree(): ContextTreeNode {
		const resolveContextWindow = this._contextWindowResolver();
		const branch = this.host.sessionManager.getBranch();
		const { ownUsage, totalUsage } = computeOwnAndTotalUsage(branch, this.host.sessionManager.getEntries());
		this.host.subtractUnindexedChildUsage(ownUsage, branch);

		const children: ContextTreeNode[] = [];
		const liveIds = new Set<string>();
		for (const run of this.host.getLiveChildren()) {
			liveIds.add(run.id);
			const node = run.getContextTree?.() ?? loadContextTreeChildFromDisk(run.sessionDir, resolveContextWindow);
			children.push({
				...(node ?? {
					ownUsage: emptyUsage(),
					totalUsage: emptyUsage(),
					children: [],
				}),
				id: run.id,
				label: run.label,
				status: run.status,
			});
		}
		children.push(...loadContextTreeChildrenFromDisk(this.host.getRlmSessionDir(), resolveContextWindow, liveIds));

		const model = this.host.getModel();
		return {
			id: "root",
			label: this.host.sessionManager.getSessionName() ?? "main agent",
			status: "active",
			model: model ? { provider: model.provider, id: model.id } : undefined,
			ownUsage,
			totalUsage,
			contextUsage: this.host.getContextUsage(),
			children,
		};
	}

	getLastAssistantText(): string | undefined {
		const lastAssistant = this.host
			.getMessages()
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}
}
