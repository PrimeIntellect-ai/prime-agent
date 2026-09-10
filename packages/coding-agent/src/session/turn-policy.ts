import type {
	Agent,
	AgentMessage,
	GetContinuationMessagesContext,
	ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { shouldCompact } from "../core/compaction/index.js";
import { createGoalContextMessage } from "../core/goals.js";
import { getLatestCompactionEntry, type SessionManager } from "../core/session-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";
import type { GoalController } from "../goals/controller.js";
import type { SessionAutonomousContinuation } from "./autonomous-continuation.js";
import type { SessionCompaction } from "./compaction.js";
import type { SessionInputAdmission } from "./input-admission.js";
import { normalizeMessageContent } from "./prepared-actions.js";
import type { SessionRefinement } from "./refinement.js";

export interface SessionTurnPolicyHost {
	steeringStopPending(): boolean;
	stopGoalForTerminalMessage(message: AssistantMessage): boolean;
	getGoals(): Pick<GoalController, "accountAssistantMessage" | "state" | "checkpoint" | "restore">;
	queuePrompt: SessionInputAdmission["queuePreparedPrompt"];
	getRefinement(): Pick<SessionRefinement, "serialized" | "_runSerializedRefineCheckpoint">;
	getEventQueue(): Promise<void>;
	getCompaction(): Pick<
		SessionCompaction,
		"resetContinuation" | "hasPendingRequest" | "requestContinuation" | "getThresholdContextTokens"
	>;
	getAgent(): Pick<Agent, "state">;
	getSettings(): Pick<SettingsManager, "getCompactionSettings">;
	getModel(): Model<Api> | undefined;
	getStore(): Pick<SessionManager, "getBranch">;
	queueThresholdGoal(message: AssistantMessage): boolean;
	queueThresholdAutonomous(message: AssistantMessage): Promise<AgentMessage | undefined>;
	getQueuedCount(): number;
	getArrivalEpoch(): number;
	getGoalMessages(context: GetContinuationMessagesContext, signal?: AbortSignal): Promise<AgentMessage[]>;
	getAutonomous(): Pick<SessionAutonomousContinuation, "isSuppressed" | "next">;
	snapshotAutonomous: SessionAutonomousContinuation["snapshotAutonomousRuntimeState"];
	restoreAutonomous: SessionAutonomousContinuation["restoreAutonomousRuntimeSnapshot"];
}
export class SessionTurnPolicy {
	constructor(private readonly host: SessionTurnPolicyHost) {}
	shouldStopBeforeTurn(): boolean {
		return this.host.steeringStopPending();
	}

	async shouldStopAfterTurn(context: ShouldStopAfterTurnContext): Promise<boolean> {
		if (this.host.stopGoalForTerminalMessage(context.message)) {
			return true;
		}
		try {
			if (this.host.getGoals().accountAssistantMessage(context.message)) {
				const message = createGoalContextMessage(this.host.getGoals().state, "budget_limit");
				const normalized = normalizeMessageContent(message.content);
				await this.host.queuePrompt("steer", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				});
			}
		} catch {
			// Goal accounting must not interrupt the core agent loop.
		}
		// Serialized refine checkpoint: in print/headless mode, run refinement
		// planning+apply synchronously here — the quiescent boundary between
		// turns — so it never overlaps the primary model request.
		// This MUST run BEFORE threshold compaction to prevent the
		// compaction model call from overlapping an in-flight refine
		// plan/apply that was started at message_end.
		if (this.host.getRefinement().serialized) {
			// Ensure the preceding message_end processing (counter increment,
			// background plan kickoff) has completed before the checkpoint.
			await this.host.getEventQueue();
			await this.host.getRefinement()._runSerializedRefineCheckpoint();
		}
		if (await this.shouldStopForThresholdCompaction(context)) {
			return true;
		}
		// Steering stops continuation only after mandatory serialized checkpoints.
		// Returning true here still prevents the agent loop from starting another turn.
		return this.host.steeringStopPending();
	}

	async shouldStopForThresholdCompaction(context: ShouldStopAfterTurnContext): Promise<boolean> {
		this.host.getCompaction().resetContinuation();
		if (!this.host.getCompaction().hasPendingRequest && !(await this.thresholdCompactionNeeded(context))) {
			return false;
		}

		const lastMessage = this.host.getAgent().state.messages[this.host.getAgent().state.messages.length - 1];
		// A queued continuation disproves the assistant-last "task finished" heuristic, so preserve a true set above.
		if (lastMessage !== undefined && lastMessage.role !== "assistant")
			this.host.getCompaction().requestContinuation();
		return true;
	}

	async thresholdCompactionNeeded(context: ShouldStopAfterTurnContext): Promise<boolean> {
		const settings = this.host.getSettings().getCompactionSettings();
		if (!settings.enabled) return false;

		const contextWindow = this.host.getModel()?.contextWindow ?? 0;
		const compactionEntry = getLatestCompactionEntry(this.host.getStore().getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		if (compactionTimestamp !== undefined && context.message.timestamp <= compactionTimestamp) {
			return false;
		}

		const contextTokens = this.host.getCompaction().getThresholdContextTokens(context.message, compactionTimestamp);
		if (contextTokens === undefined || !shouldCompact(contextTokens, contextWindow, settings)) {
			return false;
		}

		// Goal continuation takes exclusive priority over autonomous continuation, matching _getContinuationMessages.
		if (this.host.queueThresholdGoal(context.message)) {
			this.host.getCompaction().requestContinuation();
		} else if (await this.host.queueThresholdAutonomous(context.message)) {
			this.host.getCompaction().requestContinuation();
		}
		return true;
	}

	async getContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this.host.getQueuedCount() > 0) {
			return [];
		}
		const arrivalEpoch = this.host.getArrivalEpoch();
		const goalSnapshot = this.host.getGoals().checkpoint();
		const goalMessages = await this.host.getGoalMessages(context, signal);
		if (goalMessages.length > 0 || signal?.aborted) {
			if (goalMessages.length > 0 && this.host.getArrivalEpoch() !== arrivalEpoch) {
				this.host.getGoals().restore(goalSnapshot);
				return [];
			}
			return goalMessages;
		}
		if (this.host.getAutonomous().isSuppressed(context.newMessages)) {
			return [];
		}
		const autonomousSnapshot = this.host.snapshotAutonomous();
		const autonomousMessage = await this.host.getAutonomous().next(context.message, signal);
		if (autonomousMessage && this.host.getArrivalEpoch() !== arrivalEpoch) {
			this.host.restoreAutonomous(autonomousSnapshot);
			return [];
		}
		return autonomousMessage ? [autonomousMessage] : [];
	}
}
