import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "../../core/extensions/index.js";
import { type CustomMessage, createHarnessDigestMessage, HARNESS_DIGEST_CUSTOM_TYPE } from "../context/messages.js";
import type { BuildSystemPromptOptions } from "../context/system-prompt.js";
import { type SessionAction, transitionSessionAction } from "../input/action-store.js";
import type { SessionCommitFence, SessionCommitLease } from "../input/commit-fence.js";
import {
	createDeliveryRecord,
	DeferredSessionInputError,
	type PreparedPromptPreparation,
	type PreparedTurnPayload,
	primaryDeliveryRecord,
	type QueuedSessionAction,
} from "../input/prepared-actions.js";
import type { TurnPreparer } from "./turn-preparation.js";

export interface SessionTurnExecutionHost {
	getPreparer(): TurnPreparer;
	getFence(): Pick<SessionCommitFence, "run">;
	acquireFence(): Promise<SessionCommitLease>;
	isDeferred(epoch: number): boolean;
	isStreaming(): boolean;
	getBasePrompt(): string;
	refreshExtensionSystemPrompt(extensionPrompt: string, baseSnapshot: string): string;
	getBasePromptOptions(): BuildSystemPromptOptions;
	getExtensions(): Pick<ExtensionRunner, "emitBeforeAgentStart">;
	getAgent(): Pick<Agent, "state" | "prompt">;
	takeNextTurnMessages(): CustomMessage[];
	restoreNextTurnMessages(messages: CustomMessage[]): void;
	consumePendingDigest(): boolean;
	rearmDigest(): void;
	getDigest(): string;
	getLatestDigest(): string | undefined;
	suppressForMessage(message: AgentMessage): void;
	runSuppressed<T>(run: () => Promise<T>): Promise<T>;
	notifyCheckpoints(): void;
	emitQueueUpdate(): void;
	hasCancelledCapture(): boolean;
	getEventQueue(): Promise<void>;
	waitForRetry(): Promise<void>;
	forgetContinuations(messages: AgentMessage[]): void;
}
export class SessionTurnExecution {
	constructor(private readonly host: SessionTurnExecutionHost) {}
	appendBeforeAgentStartMessages(
		messages: AgentMessage[],
		result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>,
	): void {
		if (!result?.messages) return;
		for (const message of result.messages) {
			messages.push({
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				timestamp: Date.now(),
			});
		}
	}

	applyPreparedSystemPrompt(
		preparation: PreparedPromptPreparation | undefined,
		preserveEmptyExtensionPrompt: boolean,
	): void {
		const extensionPrompt = preparation?.result?.systemPrompt;
		const hasExtensionPrompt = preserveEmptyExtensionPrompt
			? extensionPrompt !== undefined
			: Boolean(extensionPrompt);
		this.host.getAgent().state.systemPrompt =
			hasExtensionPrompt && extensionPrompt !== undefined && preparation !== undefined
				? this.host.refreshExtensionSystemPrompt(extensionPrompt, preparation.basePromptSnapshot)
				: this.host.getBasePrompt();
	}

	async startPreparedTurnActions(actions: QueuedSessionAction[], epoch: number): Promise<void> {
		let nextTurnMessages: CustomMessage[] = [];
		const activeTurns = () =>
			actions.filter(
				(action): action is SessionAction<PreparedTurnPayload> =>
					action.payload.kind === "turn" && action.lifecycle.state === "preparing",
			);
		const firstTurn = activeTurns()[0];
		if (!firstTurn) return;
		const executionPolicy = firstTurn.payload.executionPolicy;
		// The digest is never parked as pending context; lazy injection re-arms instead.
		const parkNextTurnMessages = (messages: CustomMessage[]) => {
			const parked = messages.filter((message) => message.customType !== HARNESS_DIGEST_CUSTOM_TYPE);
			if (parked.length !== messages.length) this.host.rearmDigest();
			this.host.restoreNextTurnMessages(parked);
		};
		const restoreNextTurnContext = () => {
			parkNextTurnMessages(nextTurnMessages);
			nextTurnMessages = [];
		};
		try {
			const preparedTurn = await this.host.getPreparer().prepare(executionPolicy.preparation, {
				afterValidation: () => {
					if (this.host.isDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before preflight");
					}
				},
				prepare: async () => {
					if (executionPolicy.nextTurnContextTiming === "preparation") {
						nextTurnMessages = this.host.takeNextTurnMessages();
					}
					if (!executionPolicy.runBeforeAgentStart) return undefined;
					while (activeTurns().some((action) => action.payload.prepared === undefined)) {
						if (this.host.isDeferred(epoch)) {
							throw new DeferredSessionInputError("Session input paused before preparation");
						}
						const preparationAction = activeTurns().at(-1);
						if (!preparationAction) return undefined;
						const basePromptSnapshot = this.host.getBasePrompt();
						const result = await this.host
							.getExtensions()
							.emitBeforeAgentStart(
								preparationAction.payload.text,
								preparationAction.payload.images,
								basePromptSnapshot,
								this.host.getBasePromptOptions(),
							);
						if (activeTurns().at(-1) !== preparationAction) continue;
						const prepared = { result, basePromptSnapshot };
						for (const action of activeTurns()) action.payload.prepared = prepared;
					}
					if (this.host.isDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before handoff");
					}
					return activeTurns()[0]?.payload.prepared;
				},
				shouldCommit: () => activeTurns().length > 0,
				commit: (prepared) => {
					if (this.host.isDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before handoff");
					}
					const turns = activeTurns();
					if (turns.length === 0) return undefined;
					return { prepared, turns };
				},
			});
			if (!preparedTurn) {
				restoreNextTurnContext();
				return;
			}
			const { prepared, turns } = preparedTurn;
			const commitFence = await this.host.acquireFence();
			let promptPromise: Promise<void>;
			try {
				promptPromise = this.host.getFence().run(commitFence, () => {
					if (
						this.host.isDeferred(epoch) ||
						this.host.isStreaming() ||
						turns.some((action) => action.lifecycle.state !== "preparing")
					) {
						throw new DeferredSessionInputError("Agent became active before session input handoff");
					}
					if (executionPolicy.nextTurnContextTiming === "commit") {
						nextTurnMessages = this.host.takeNextTurnMessages();
					}
					if (this.host.consumePendingDigest()) {
						// The first-turn digest rides the turn's delivery records so a
						// cancelled first turn strips it with the rest of the turn.

						const digest = this.host.getDigest();
						if (this.host.getLatestDigest() !== digest) {
							nextTurnMessages = [createHarnessDigestMessage(digest), ...nextTurnMessages];
						}
					}
					const contextRecords = nextTurnMessages.map((message) =>
						createDeliveryRecord(turns[0].id, "next_turn", message),
					);
					const firstPrimaryIndex = turns[0].payload.records.indexOf(primaryDeliveryRecord(turns[0]));
					turns[0].payload.records.splice(firstPrimaryIndex, 0, ...contextRecords);
					const preparedMessages: AgentMessage[] = turns.flatMap((action) =>
						action.payload.records.map((record) => record.message),
					);
					for (const action of turns) {
						if (action.suppressAutonomousContinuation) {
							this.host.suppressForMessage(primaryDeliveryRecord(action).message);
						}
					}
					if (executionPolicy.runBeforeAgentStart) {
						this.appendBeforeAgentStartMessages(preparedMessages, prepared?.result);
						this.applyPreparedSystemPrompt(prepared, executionPolicy.preserveEmptyExtensionPrompt);
					} else if (executionPolicy.nextTurnContextTiming !== "skip") {
						this.host.getAgent().state.systemPrompt = this.host.getBasePrompt();
					}
					for (const action of turns) transitionSessionAction(action, { state: "committing" });
					this.host.notifyCheckpoints();
					this.host.emitQueueUpdate();
					return turns.some((action) => action.suppressAutonomousContinuation)
						? this.host.runSuppressed(() => this.host.getAgent().prompt(preparedMessages))
						: this.host.getAgent().prompt(preparedMessages);
				});
			} finally {
				commitFence.release();
			}
			await promptPromise;
			if (executionPolicy.completionIncludesRetryChain) await this.host.waitForRetry();
			if (!this.host.hasCancelledCapture()) await this.host.getEventQueue();
			if (
				turns.some(
					(action) =>
						action.lifecycle.state !== "cancelled" &&
						!primaryDeliveryRecord(action).durable &&
						!this.host.getAgent().state.messages.includes(primaryDeliveryRecord(action).message),
				)
			) {
				throw new Error("Session input dispatch settled without durable delivery");
			}
			this.host.forgetContinuations(turns.map((action) => primaryDeliveryRecord(action).message));
		} catch (error) {
			const delivered = new Set(this.host.getAgent().state.messages);
			parkNextTurnMessages(nextTurnMessages.filter((message) => !delivered.has(message)));
			for (const action of actions) {
				if (action.payload.kind === "turn") {
					action.payload.records = action.payload.records.filter((record) => record.role !== "next_turn");
				}
			}
			throw error;
		}
	}
}
