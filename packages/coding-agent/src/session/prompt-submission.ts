import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
	type AgentSessionMessage,
	isAgentSessionMessage,
	parseAgentSessionMessagePromptId,
} from "../core/agent-messages.js";
import type { InputSource } from "../core/extensions/index.js";
import { GOAL_CONTEXT_CUSTOM_TYPE, GOAL_CONTEXT_PREVIEW_LABEL } from "../core/goals.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
	type AsyncBashCompletionDetails,
	type CustomMessage,
	createAsyncBashCompletionMessage,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
} from "../core/messages.js";
import { throwIfPromptAdmissionCancelled } from "../core/prompt-admission.js";
import { type ActionStore, canSelectSessionAction, type RuntimeActivity } from "../core/session-action-store.js";
import type { SessionManager } from "../core/session-manager.js";
import type { SessionCommitFence, SessionCommitLease } from "./commit-fence.js";
import type { AgentSessionEvent } from "./events.js";
import type { SessionInputAdmission } from "./input-admission.js";
import type { SessionInputScheduler } from "./input-scheduler.js";
import {
	buildPromptContent,
	cloneCustomMessage,
	createPreparedTurnAction,
	createSessionCommandAction,
	normalizeMessageContent,
	primaryDeliveryRecord,
	type QueuedSessionAction,
	SessionInputAdmissionPausedError,
} from "./prepared-actions.js";
import type { SubmissionNormalizer } from "./submission-normalization.js";
import { createTurnExecutionPolicy, type TurnExecutionPolicy } from "./turn-preparation.js";
export interface PromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	followUpQueueKey?: string;
	source?: InputSource;
	preflightResult?: (success: boolean, queued?: boolean) => void;
	queueIfBusy?: boolean;
	resumeIfIdle?: boolean;
	internalPrompt?: boolean;
	suppressAutonomousContinuation?: boolean;
	skipInputHandlers?: boolean;
	signal?: AbortSignal;
	admissionCommitted?: () => void;
	agentMessageId?: string;
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
}

export interface InternalPromptOptions extends PromptOptions {
	skipPrePromptWork?: boolean;
	returnAfterAccepted?: boolean;
	agentMessageId?: string;
}
function oncePreflight(
	preflightResult: ((success: boolean, queued?: boolean) => void) | undefined,
): (success: boolean, queued?: boolean) => void {
	let settled = false;
	return (success, queued = false) => {
		if (!settled) {
			settled = true;
			preflightResult?.(success, queued);
		}
	};
}
function injectedMessagePreviewLabel(message: CustomMessage): string | undefined {
	switch (message.customType) {
		case HEARTBEAT_PROMPT_CUSTOM_TYPE:
			return HEARTBEAT_PROMPT_PREVIEW_LABEL;
		case ASYNC_BASH_COMPLETION_CUSTOM_TYPE:
			return ASYNC_BASH_COMPLETION_PREVIEW_LABEL;
		case GOAL_CONTEXT_CUSTOM_TYPE:
			return GOAL_CONTEXT_PREVIEW_LABEL;
		default:
			return undefined;
	}
}
export interface SessionPromptSubmissionHost {
	queueAgentMessagePrompt(
		text: string,
		streamingBehavior: "steer" | "followUp",
		customMessage?: AgentSessionMessage,
	): Promise<boolean>;
	getScheduler(): Pick<SessionInputScheduler, "epoch" | "suspended" | "suspendedForUpdateRestart" | "admissionPaused">;
	getFence(): Pick<SessionCommitFence, "run" | "disposeSignal">;
	waitForActivityChange(signal: AbortSignal): Promise<void>;
	isStreaming(): boolean;
	isCompacting(): boolean;
	isRetrying(): boolean;
	isBashRunning(): boolean;
	resumeAdmission(): void;
	assertAdmissionAvailable(): void;
	acquireAdmissionFence(signal?: AbortSignal): Promise<SessionCommitLease>;
	normalize: SubmissionNormalizer["normalizeSubmission"];
	settleAgentMessage(id: string | undefined, leg: "delivery" | "completion", error?: Error): void;
	canStartImmediately(): boolean;
	admit: SessionInputAdmission["admitSessionInput"];
	waitForInputIdle(): Promise<void>;
	isBusy(point: "preflight" | "pump"): boolean;
	takeNextTurnMessages(): CustomMessage[];
	restoreNextTurnMessages(messages: CustomMessage[]): void;
	appendNextTurnMessage(message: CustomMessage): void;
	getActivity(): RuntimeActivity;
	suppressForMessage(message: AgentMessage): void;
	observeDeferral(action: QueuedSessionAction): { deferred: Promise<void>; stop(): void };
	rejectAgentMessage(id: string | undefined, error: Error): void;
	cancelActions(predicate: (action: QueuedSessionAction) => boolean, error: Error): QueuedSessionAction[];
	emitQueueUpdate(): void;
	getClearEpoch(): number;
	queuePrompt: SessionInputAdmission["queuePreparedPrompt"];
	resetParentReply(): void;
	getAgent(): Pick<Agent, "state">;
	getStore(): Pick<SessionManager, "appendCustomMessageEntry">;
	emit(event: AgentSessionEvent): void;
}
export class SessionPromptSubmission {
	constructor(
		private readonly actions: ActionStore<QueuedSessionAction>,
		private readonly host: SessionPromptSubmissionHost,
	) {}
	async handleKernelBashCompletion(details: AsyncBashCompletionDetails): Promise<void> {
		const message = createAsyncBashCompletionMessage(details);
		const disposeSignal = this.host.getFence().disposeSignal;
		while (true) {
			let admissionCommitted = false;
			try {
				await this.promptInjectedMessage(message.content, message, {
					streamingBehavior: "steer",
					queueIfBusy: true,
					resumeIfIdle: true,
					returnAfterAccepted: true,
					suppressAutonomousContinuation: true,
					admissionCommitted: () => {
						admissionCommitted = true;
					},
				});
				return;
			} catch (error) {
				if (admissionCommitted || !(error instanceof SessionInputAdmissionPausedError)) throw error;
				while (this.host.getScheduler().admissionPaused && !disposeSignal.aborted) {
					await this.host.waitForActivityChange(disposeSignal);
				}
			}
		}
	}

	async promptInjectedMessage(
		text: string,
		message: CustomMessage,
		options?: InternalPromptOptions & { executionPolicy?: TurnExecutionPolicy },
	): Promise<void> {
		if (!this.host.isStreaming() && options?.resumeIfIdle) this.host.resumeAdmission();
		const admissionEpoch = this.host.getScheduler().epoch;
		const admissionFence = await this.host.acquireAdmissionFence(options?.signal).catch((error: unknown) => {
			throwIfPromptAdmissionCancelled(options?.signal);
			throw error;
		});
		const reportPreflight = oncePreflight(options?.preflightResult);
		try {
			throwIfPromptAdmissionCancelled(options?.signal);
			if (admissionEpoch !== this.host.getScheduler().epoch) {
				throw new Error("Injected session input was invalidated before admission");
			}
			options?.admissionCommitted?.();
			const queueForStreaming = this.host.isStreaming();
			const queueForBusy = options?.queueIfBusy === true && this.host.isBusy("preflight");
			const visibleQueued = queueForStreaming || queueForBusy;
			if (visibleQueued && !options?.streamingBehavior) {
				const stateDescription = queueForStreaming ? "Agent is already processing" : "Agent has queued work";
				throw new Error(
					`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
				);
			}
			const schedule = options?.streamingBehavior ?? "followUp";
			const prefixMessages = visibleQueued ? this.host.takeNextTurnMessages() : undefined;
			const action = createPreparedTurnAction(schedule, text, undefined, {
				message,
				prefixMessages,
				queueKey: options?.followUpQueueKey,
				previewLabel: injectedMessagePreviewLabel(message),
				suppressAutonomousContinuation: options?.suppressAutonomousContinuation,
				resumeIfIdle:
					!visibleQueued ||
					options?.resumeIfIdle ||
					(options?.queueIfBusy === true && canSelectSessionAction(this.host.getActivity())),
				source: options?.source ?? "internal",
				executionPolicy:
					options?.executionPolicy ??
					(visibleQueued ? createTurnExecutionPolicy("queued") : createTurnExecutionPolicy("injected")),
				queueVisible: visibleQueued,
			});
			const result = this.host.admit(action, {
				immediatelyEligible: !visibleQueued,
			});
			admissionFence.release();
			if (!result.accepted || !result.ticket) {
				if (prefixMessages) this.host.restoreNextTurnMessages(prefixMessages);
				reportPreflight(false, false);
				return;
			}
			if (result.disposition === "queued") {
				reportPreflight(true, true);
			} else {
				void result.ticket.delivered.then(
					() => reportPreflight(true),
					() => reportPreflight(false),
				);
			}
			if (options?.returnAfterAccepted) {
				if (result.disposition === "starts_when_admitted") await result.ticket.delivered;
				return;
			}
			if (visibleQueued) return;
			await result.ticket.completed;
		} catch (error) {
			reportPreflight(false);
			throw error;
		} finally {
			admissionFence.release();
		}
	}

	async prompt(text: string, options?: InternalPromptOptions): Promise<void> {
		const resumeSuspendedInput = options?.resumeIfIdle !== false;
		if (!this.host.isStreaming()) {
			if (resumeSuspendedInput) this.host.resumeAdmission();
			this.host.assertAdmissionAvailable();
		}
		const admissionEpoch = this.host.getScheduler().epoch;
		const commitFence = this.host.isStreaming()
			? undefined
			: await this.host.acquireAdmissionFence(options?.signal).catch((error: unknown) => {
					throwIfPromptAdmissionCancelled(options?.signal);
					throw error;
				});
		const reportPreflight = oncePreflight(options?.preflightResult);
		const run = async () => {
			try {
				throwIfPromptAdmissionCancelled(options?.signal);
				if (!resumeSuspendedInput && admissionEpoch !== this.host.getScheduler().epoch) {
					throw new Error("Session input was invalidated before admission");
				}
				options?.admissionCommitted?.();
				const isInternalPrompt = options?.internalPrompt === true;
				const expandPromptTemplates = isInternalPrompt ? false : (options?.expandPromptTemplates ?? true);
				const normalizationResult = this.host.normalize(text, options?.images, {
					parseSessionCommands: !isInternalPrompt && !options?.skipPrePromptWork,
					extensionCommands: expandPromptTemplates ? "execute" : "ignore",
					inputSource:
						!isInternalPrompt && !options?.skipInputHandlers ? (options?.source ?? "interactive") : undefined,
					expandSkills: expandPromptTemplates,
					expandPromptTemplates,
				});
				const normalized = normalizationResult instanceof Promise ? await normalizationResult : normalizationResult;
				// Async input handlers ran between the admission check above and
				// admission itself; re-check so content invalidated during that
				// await (e.g. a cron job cancelled or updated) is not admitted.
				if (normalizationResult instanceof Promise) options?.admissionCommitted?.();
				if (normalized.kind === "extensionCommand") {
					commitFence?.release();
					reportPreflight(true);
					void normalized.completion.then(
						() => this.host.settleAgentMessage(options?.agentMessageId, "completion"),
						(error) => this.host.settleAgentMessage(options?.agentMessageId, "completion", error),
					);
					void normalized.completion.catch(() => undefined);
					if (!options?.returnAfterAccepted) await normalized.completion.catch(() => undefined);
					return;
				}
				if (normalized.kind === "handled") {
					commitFence?.release();
					reportPreflight(true);
					this.host.settleAgentMessage(options?.agentMessageId, "completion");
					return;
				}

				const pendingOwnedWork = this.actions.unfinishedActions().length > 0;
				const wasRuntimeBusy =
					this.host.isStreaming() ||
					this.host.isCompacting() ||
					this.host.isRetrying() ||
					this.host.isBashRunning();
				const wasBusy = wasRuntimeBusy || pendingOwnedWork;
				if (normalized.kind === "sessionCommand") {
					const schedule = options?.streamingBehavior ?? (this.host.isStreaming() ? "steer" : "followUp");
					const action = createSessionCommandAction(
						normalized.text,
						normalized.command,
						normalized.images,
						schedule,
						{
							agentMessageId: options?.agentMessageId,
							source: isInternalPrompt ? "internal" : (options?.source ?? "interactive"),
						},
					);
					const result = this.host.admit(action, {
						immediatelyEligible: !wasBusy && this.host.canStartImmediately(),
					});
					commitFence?.release();
					reportPreflight(result.accepted, result.disposition === "queued");
					if (!result.accepted || !result.ticket) return;
					if (options?.returnAfterAccepted) {
						if (result.disposition === "starts_when_admitted") await result.ticket.delivered;
						return;
					}
					if (result.disposition === "queued") return;
					await this.host.waitForInputIdle();
					return;
				}

				const queueForStreaming = this.host.isStreaming();
				const queueForBusy = options?.queueIfBusy === true && this.host.isBusy("preflight");
				const visibleQueued = queueForStreaming || queueForBusy;
				if (visibleQueued && !options?.streamingBehavior) {
					const stateDescription = queueForStreaming ? "Agent is already processing" : "Agent has queued work";
					throw new Error(
						`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
					);
				}
				const schedule = options?.streamingBehavior ?? "followUp";
				const prefixMessages = visibleQueued ? this.host.takeNextTurnMessages() : undefined;
				const content = options?.content
					? options.content.map((block) => ({ ...block }))
					: buildPromptContent(normalized.text, normalized.images);
				const suppliedMessage = options?.customMessage;
				const primaryMessage = suppliedMessage
					? visibleQueued
						? suppliedMessage
						: cloneCustomMessage(suppliedMessage)
					: ({
							role: "user",
							content: content.map((block) => ({ ...block })),
							timestamp: Date.now(),
						} satisfies UserMessage);
				const acceptedAgentMessage = options?.skipPrePromptWork === true && options.returnAfterAccepted === true;
				const action = createPreparedTurnAction(schedule, normalized.text, normalized.images, {
					agentMessageId: options?.agentMessageId,
					queueKey: options?.followUpQueueKey,
					content,
					message: primaryMessage,
					prefixMessages,
					suppressAutonomousContinuation: options?.suppressAutonomousContinuation,
					resumeIfIdle:
						!visibleQueued ||
						options?.resumeIfIdle ||
						(options?.queueIfBusy === true && canSelectSessionAction(this.host.getActivity())),
					source: isInternalPrompt ? "internal" : (options?.source ?? "interactive"),
					executionPolicy: visibleQueued
						? createTurnExecutionPolicy("queued")
						: createTurnExecutionPolicy("directPrompt", {
								returnAfterAccepted: options?.returnAfterAccepted,
								skipPrePromptWork: options?.skipPrePromptWork,
							}),
					queueVisible: visibleQueued,
					acceptedAgentMessage,
					acceptedBeforeCompletion: options?.returnAfterAccepted === true,
				});
				if (action.suppressAutonomousContinuation) {
					this.host.suppressForMessage(primaryDeliveryRecord(action).message);
				}
				const result = this.host.admit(action, {
					immediatelyEligible: !visibleQueued && this.host.canStartImmediately(),
				});
				commitFence?.release();
				if (!result.accepted || !result.ticket) {
					if (prefixMessages) this.host.restoreNextTurnMessages(prefixMessages);
					reportPreflight(false, false);
					return;
				}
				if (result.disposition === "queued") {
					reportPreflight(true, true);
				} else {
					void result.ticket.delivered.then(
						() => reportPreflight(true),
						() => reportPreflight(false),
					);
				}
				const deferralObserver =
					acceptedAgentMessage &&
					options?.queueIfBusy === true &&
					!options.streamingBehavior &&
					result.disposition === "starts_when_admitted"
						? this.host.observeDeferral(action)
						: undefined;
				if (acceptedAgentMessage && !queueForStreaming && !queueForBusy && !options?.streamingBehavior) {
					try {
						const outcome = deferralObserver
							? await Promise.race([
									result.ticket.delivered.then(() => "delivered" as const),
									deferralObserver.deferred.then(() => "deferred" as const),
								])
							: await result.ticket.delivered.then(() => "delivered" as const);
						if (outcome === "deferred" && !options?.streamingBehavior) {
							const error = new Error(
								"Agent became busy before prompt delivery. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
							);
							this.host.rejectAgentMessage(action.agentMessageId, error);
							this.host.cancelActions((candidate) => candidate === action, error);
							this.host.emitQueueUpdate();
							throw error;
						}
						return;
					} finally {
						deferralObserver?.stop();
					}
				}
				if (options?.returnAfterAccepted) {
					if (result.disposition === "starts_when_admitted" || (acceptedAgentMessage && !visibleQueued)) {
						await result.ticket.delivered;
					}
					return;
				}
				if (visibleQueued) return;
				await result.ticket.completed;
				await this.host.waitForInputIdle();
			} catch (error) {
				reportPreflight(false);
				throw error;
			} finally {
				commitFence?.release();
			}
		};
		return commitFence ? this.host.getFence().run(commitFence, run) : run();
	}

	async acceptAgentMessagePrompt(text: string, options?: PromptOptions): Promise<void> {
		const customMessage =
			options?.customMessage && isAgentSessionMessage(options.customMessage) ? options.customMessage : undefined;
		const clearEpoch = this.host.getClearEpoch();
		const admissionCommitted = () => {
			options?.admissionCommitted?.();
			if (clearEpoch !== this.host.getClearEpoch()) {
				throw new Error("Agent message was cleared before admission");
			}
		};
		if (
			this.host.getScheduler().suspended &&
			this.host.isBusy("preflight") &&
			options?.queueIfBusy === true &&
			options.streamingBehavior
		) {
			admissionCommitted();
			const queued = await this.host.queueAgentMessagePrompt(text, options.streamingBehavior, customMessage);
			options.preflightResult?.(queued, queued);
			return;
		}
		await this.prompt(text, {
			...options,
			resumeIfIdle: false,
			expandPromptTemplates: false,
			skipInputHandlers: true,
			skipPrePromptWork: true,
			returnAfterAccepted: true,
			agentMessageId: options?.agentMessageId ?? customMessage?.details.id ?? parseAgentSessionMessagePromptId(text),
			customMessage,
			admissionCommitted,
		});
		if (customMessage?.details.fromRelationship === "parent") this.host.resetParentReply();
	}

	async queueAgentMessagePrompt(
		text: string,
		streamingBehavior: "steer" | "followUp",
		customMessage?: AgentSessionMessage,
	): Promise<boolean> {
		const agentMessageId = customMessage?.details.id ?? parseAgentSessionMessagePromptId(text);
		if (streamingBehavior === "steer") {
			await this.host.queuePrompt("steer", text, undefined, {
				agentMessageId,
				message: customMessage,
			});
			if (customMessage?.details.fromRelationship === "parent") this.host.resetParentReply();
			return true;
		}
		const queued = await this.host.queuePrompt("followUp", text, undefined, {
			agentMessageId,
			message: customMessage,
		});
		if (queued && customMessage?.details.fromRelationship === "parent") this.host.resetParentReply();
		return queued;
	}

	async steer(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<void> {
		const normalized = this.host.normalize(text, images, {
			parseSessionCommands: false,
			extensionCommands: "reject",
			expandSkills: true,
			expandPromptTemplates: true,
		});
		if (normalized instanceof Promise || normalized.kind !== "prompt") {
			throw new Error("Queued prompt normalization did not produce a prompt");
		}

		await this.host.queuePrompt("steer", normalized.text, normalized.images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	async followUp(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<boolean> {
		const normalized = this.host.normalize(text, images, {
			parseSessionCommands: false,
			extensionCommands: "reject",
			expandSkills: true,
			expandPromptTemplates: true,
		});
		if (normalized instanceof Promise || normalized.kind !== "prompt") {
			throw new Error("Queued prompt normalization did not produce a prompt");
		}

		return this.host.queuePrompt("followUp", normalized.text, normalized.images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this.host.appendNextTurnMessage(appMessage);
		} else if (this.host.isStreaming()) {
			const normalized = normalizeMessageContent(message.content);
			if (options?.deliverAs === "followUp") {
				await this.host.queuePrompt("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			} else {
				await this.host.queuePrompt("steer", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			}
		} else if (options?.triggerTurn) {
			if (!this.host.getScheduler().suspendedForUpdateRestart) this.host.resumeAdmission();
			const admissionFence = await this.host.acquireAdmissionFence();
			try {
				const normalized = normalizeMessageContent(message.content);
				const immediatelyEligible = this.host.canStartImmediately();
				const action = createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
					executionPolicy: createTurnExecutionPolicy("customTrigger"),
					queueVisible: false,
				});
				const result = this.host.admit(action, { immediatelyEligible });
				admissionFence.release();
				if (!result.ticket) return;
				await result.ticket.completed;
			} finally {
				admissionFence.release();
			}
		} else {
			this.host.getAgent().state.messages.push(appMessage);
			this.host
				.getStore()
				.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			this.host.emit({ type: "message_start", message: appMessage });
			this.host.emit({ type: "message_end", message: appMessage });
		}
	}

	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
			resumeIfIdle: true,
		});
	}
}
