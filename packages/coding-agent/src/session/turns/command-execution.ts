import type { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { GoalState } from "../../core/goals.js";
import {
	type CustomMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
} from "../../core/messages.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import {
	type ActionStore,
	canSelectSessionAction,
	type RuntimeActivity,
	transitionSessionAction,
} from "../../core/session-action-store.js";
import type { SessionManager } from "../../core/session-manager.js";
import { parseRefineCommandOptions, type SessionSlashCommand } from "../../core/slash-commands.js";
import { CompactionSkippedError } from "../compaction/compaction-execution.js";
import type { SessionCommitFence, SessionCommitLease } from "../input/commit-fence.js";
import type { QueuedSessionAction } from "../prepared-actions.js";
import type { SessionRefinement } from "../refinement/refinement.js";

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
export interface SessionCommandExecutionHost {
	getFence(): Pick<SessionCommitFence, "run">;
	acquireFence(): Promise<SessionCommitLease>;
	getRefinement(): Pick<SessionRefinement, "_waitForRefineIdle" | "_emitRefineFailed">;
	isDeferred(epoch: number): boolean;
	getActivity(): RuntimeActivity;
	notifyCheckpoints(): void;
	emitQueueUpdate(): void;
	settleAgentMessage(id: string | undefined, leg: "delivery" | "completion", error?: Error): void;
	rejectAgentMessage(id: string | undefined, error: Error): void;
	compact(instructions?: string, options?: { skipAbort?: boolean }): Promise<CompactionResult>;
	refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		internal: { skipAbort?: boolean },
	): Promise<RefinementResult>;
	handleGoalCommand(text: string, images: ImageContent[] | undefined): Promise<boolean>;
	handleAutonomousCommand(text: string): Promise<boolean>;
	getGoalState(): GoalState;
	getStore(): Pick<SessionManager, "appendCustomMessageEntryWithRollback">;
	getAgent(): Pick<Agent, "state">;
	emit(event: AgentSessionEvent): void;
}
export class SessionCommandExecution {
	constructor(
		private readonly actions: ActionStore<QueuedSessionAction>,
		private readonly host: SessionCommandExecutionHost,
	) {}
	async executeSelectedSessionCommand(action: QueuedSessionAction, epoch: number): Promise<void> {
		if (action.payload.kind !== "session_command") throw new Error("Expected a selected session command");
		const input = action.payload;
		const commitFence = await this.host.acquireFence();
		try {
			await this.host.getFence().run(commitFence, async () => {
				const isCancelled = () => action.lifecycle.state === "cancelled";
				if (isCancelled()) return;
				await this.host.getRefinement()._waitForRefineIdle();
				if (isCancelled()) return;
				if (this.host.isDeferred(epoch) || !canSelectSessionAction(this.host.getActivity())) {
					this.actions.rollback(action);
					this.host.notifyCheckpoints();
					this.host.emitQueueUpdate();
					return;
				}
				transitionSessionAction(action, {
					state: "running",
					execution: "session_command",
				});
				this.host.notifyCheckpoints();
				this.host.emitQueueUpdate();
				try {
					this.appendDurableSessionCommandMessage(input.text, input.command, false);
					this.actions.ticketFor(action).settleDelivered({ status: "not_applicable" });
					this.host.settleAgentMessage(action.agentMessageId, "delivery");
					await this.executeQueuedSessionCommand(action);
					transitionSessionAction(action, { state: "completed" });
					this.actions.ticketFor(action).settleCompleted();
					this.host.settleAgentMessage(action.agentMessageId, "completion");
				} catch (error) {
					const commandError = asError(error);
					transitionSessionAction(action, {
						state: "failed",
						error: commandError,
					});
					const ticket = this.actions.ticketFor(action);
					ticket.rejectDelivered(commandError);
					ticket.settleCompleted(commandError);
					this.host.rejectAgentMessage(action.agentMessageId, commandError);
				} finally {
					this.actions.releaseTerminal(action);
					this.host.notifyCheckpoints();
					this.host.emitQueueUpdate();
				}
			});
		} finally {
			commitFence.release();
		}
	}

	async executeQueuedSessionCommand(action: QueuedSessionAction): Promise<void> {
		if (action.payload.kind !== "session_command") throw new Error("Expected a session command action");
		const input = action.payload;
		try {
			let resultText: string | undefined;
			let displayResult = true;
			switch (input.command.name) {
				case "compact":
					await this.host.compact(input.command.args || undefined, {
						skipAbort: true,
					});
					break;
				case "refine": {
					let result: RefinementResult;
					try {
						const options = parseRefineCommandOptions(input.command.args);
						result = await this.host.refine(options, { skipAbort: true });
					} catch (error) {
						// Only a failure of the refinement itself is a refine failure; a later
						// result-row persist error must not report a completed refinement as failed.
						this.host.getRefinement()._emitRefineFailed(asError(error));
						throw error;
					}
					const applied = result.appliedEdits.filter((edit) => edit.applied).length;
					resultText = `Refined continual harness state: ${applied} edit${applied === 1 ? "" : "s"} applied.`;
					displayResult = false;
					break;
				}
				case "goal":
					await this.host.handleGoalCommand(input.text, input.images);
					resultText = this.host.getGoalState().objective
						? `Goal ${this.host.getGoalState().status}: ${this.host.getGoalState().objective}`
						: "No active goal.";
					break;
				case "autonomous":
					await this.host.handleAutonomousCommand(input.text);
					break;
			}
			if (resultText) {
				this.appendDurableSessionCommandMessage(resultText, input.command, true, false, displayResult);
			}
		} catch (error) {
			if (error instanceof CompactionSkippedError) return;
			const commandError = error instanceof Error ? error : new Error(String(error));
			try {
				this.appendDurableSessionCommandMessage(
					`Command failed: ${commandError.message}`,
					input.command,
					true,
					true,
				);
			} catch {
				// The result row is also the command-correlated UI settle edge.
				const message = createSessionSlashCommandResultMessage(`Command failed: ${commandError.message}`, {
					command: input.command,
					success: false,
					severity: "error",
					error: commandError.message,
				});
				this.host.emit({ type: "message_start", message });
				this.host.emit({ type: "message_end", message });
			}
			throw commandError;
		}
	}

	appendDurableSessionCommandMessage(
		content: string,
		command: SessionSlashCommand,
		isResult: boolean,
		isError = false,
		display = true,
	): void {
		const message: CustomMessage = isResult
			? createSessionSlashCommandResultMessage(
					content,
					{
						command,
						success: !isError,
						severity: isError ? "error" : "info",
						...(isError ? { error: content.replace(/^Command failed:\s*/, "") } : {}),
					},
					display,
				)
			: createSessionSlashCommandMessage(command);
		// Persist before touching live state so a failed write cannot leave an
		// unsaved leaf that the next entry would silently parent onto.
		this.host
			.getStore()
			.appendCustomMessageEntryWithRollback(message.customType, message.content, message.display, message.details);
		this.host.getAgent().state.messages.push(message);
		this.host.emit({ type: "message_start", message });
		this.host.emit({ type: "message_end", message });
	}
}
