import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionRunner, SessionBeforeTreeResult, TreePreparation } from "../../core/extensions/index.js";
import type { ProviderRetryPolicy } from "../../core/provider-retry.js";
import type { BranchSummaryEntry, SessionManager } from "../../core/session-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { SessionCommitLease } from "../input/commit-fence.js";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./branch-summary.js";

export interface HistoryNavigationHost {
	sessionManager: SessionManager;
	settingsManager: Pick<SettingsManager, "getBranchSummarySettings">;
	getRetryPolicy(): ProviderRetryPolicy;
	getModel(): Model<Api> | undefined;
	getExtensions(): Pick<ExtensionRunner, "hasHandlers" | "emit">;
	getRequiredAuth(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
	acquireQueuedWorkPause(): { release(): void };
	acquireCommitFence(): Promise<SessionCommitLease>;
	runWithCommitFence<T>(lease: SessionCommitLease, run: () => T): T;
	waitForAgentIdle(): Promise<void>;
	getEventQueue(): Promise<void>;
	invalidateRefinement(): Promise<void>;
	rebuildBranchContext(): void;
	notifyCheckpoints(): void;
}
export class SessionHistoryNavigation {
	private _branchNavigationQueue: Promise<void> = Promise.resolve();
	private _branchSummaryAbortController?: AbortController;
	private _branchSummaryOperation?: Promise<void>;
	constructor(private readonly host: HistoryNavigationHost) {}
	get operation(): Promise<void> | undefined {
		return this._branchSummaryOperation;
	}
	get isSummarizing(): boolean {
		return this._branchSummaryAbortController !== undefined;
	}
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}
	async navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		const previous = this._branchNavigationQueue;
		let release = () => {};
		this._branchNavigationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this._navigateTree(targetId, options);
		} finally {
			release();
		}
	}

	private async _navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		if (options.summarize && !this.host.getModel()) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.host.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const queuedWorkPause = this.host.acquireQueuedWorkPause();
		let commitFence: { owner: symbol; release(): void } | undefined;
		try {
			// Branch navigation and turn dispatch mutate the same transcript leaf.
			commitFence = await this.host.acquireCommitFence();
			return await this.host.runWithCommitFence(commitFence, async () => {
				await this.host.waitForAgentIdle();
				await this.host.getEventQueue();
				return this._navigateTreeUnderPause(targetId, targetEntry, options);
			});
		} finally {
			queuedWorkPause.release();
			commitFence?.release();
		}
	}

	private async _navigateTreeUnderPause(
		targetId: string,
		targetEntry: NonNullable<ReturnType<SessionManager["getEntry"]>>,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		const oldLeafId = this.host.sessionManager.getLeafId();

		// No-op if already at target after admitted work has settled.
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Do not switch branches while /refine has detached event handling and is
		// about to persist harness/session entries for the current branch.
		await this.host.invalidateRefinement();

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.host.sessionManager,
			oldLeafId,
			targetId,
		);

		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		this._branchSummaryAbortController = new AbortController();
		let resolveBranchSummaryOperation: () => void = () => {};
		const branchSummaryOperation = new Promise<void>((resolve) => {
			resolveBranchSummaryOperation = resolve;
		});
		this._branchSummaryOperation = branchSummaryOperation;

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			if (this.host.getExtensions().hasHandlers("session_before_tree")) {
				const result = (await this.host.getExtensions().emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.host.getModel()!;
				const { apiKey, headers } = await this.host.getRequiredAuth(model);
				const branchSummarySettings = this.host.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					retry: this.host.getRetryPolicy(),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}

			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				const summaryId = this.host.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.host.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				if (label) {
					this.host.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				this.host.sessionManager.resetLeaf();
			} else {
				this.host.sessionManager.branch(newLeafId);
			}

			if (label && !summaryText) {
				this.host.sessionManager.appendLabelChange(targetId, label);
			}

			this.host.rebuildBranchContext();

			await this.host.getExtensions().emit({
				type: "session_tree",
				newLeafId: this.host.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			if (this._branchSummaryOperation === branchSummaryOperation) {
				this._branchSummaryOperation = undefined;
			}
			resolveBranchSummaryOperation();
			this.host.notifyCheckpoints();
		}
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.host.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}
}
