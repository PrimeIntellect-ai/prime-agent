import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent, PromptOptions } from "../core/agent-session.js";
import type { KernelSentAgentMessage } from "../core/kernel/index.js";
import type { ActionStore } from "../core/session-action-store.js";
import type { SessionManager } from "../core/session-manager.js";
import type { QueuedSessionAction } from "./prepared-actions.js";

interface AgentMessageDeferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface AgentMessageOutcome {
	delivery?: AgentMessageDeferred;
	completion?: AgentMessageDeferred;
}

function createAgentMessageDeferred(): AgentMessageDeferred {
	const deferred = {} as AgentMessageDeferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	deferred.promise.catch(() => undefined);
	return deferred;
}

const IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY = "ipython_sent_agent_message";

interface PersistedIpythonSentAgentMessage {
	toolCallId: string;
	message: KernelSentAgentMessage;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedIpythonSentAgentMessage(value: unknown): PersistedIpythonSentAgentMessage | undefined {
	if (!isObjectRecord(value) || typeof value.toolCallId !== "string" || !isObjectRecord(value.message)) {
		return undefined;
	}
	const { id, message, deliveryStatus, target } = value.message;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		!isObjectRecord(target) ||
		typeof target.activeSessionId !== "string" ||
		typeof target.sessionId !== "string"
	) {
		return undefined;
	}
	return {
		toolCallId: value.toolCallId,
		message: {
			id,
			message,
			deliveryStatus,
			target: {
				activeSessionId: target.activeSessionId,
				sessionId: target.sessionId,
				...(typeof target.sessionName === "string" ? { sessionName: target.sessionName } : {}),
			},
		},
	};
}

function appendSentAgentMessageToToolResult(
	message: AgentMessage,
	toolCallId: string,
	sentMessage: KernelSentAgentMessage,
): boolean {
	if (message.role !== "toolResult" || message.toolName !== "ipython" || message.toolCallId !== toolCallId) {
		return false;
	}
	const details = isObjectRecord(message.details) ? message.details : {};
	const current = Array.isArray(details.sentAgentMessages) ? details.sentAgentMessages : [];
	if (current.some((entry) => isObjectRecord(entry) && entry.id === sentMessage.id)) {
		return true;
	}
	message.details = {
		...details,
		sentAgentMessages: [...current, sentMessage],
	};
	return true;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
export interface SessionMessageDeliveryHost {
	isDisposed(): boolean;
	getMessages(): AgentMessage[];
	getStore(): Pick<SessionManager, "getBranch" | "appendCustomEntry">;
	enqueue(work: () => void): void;
	emit(event: AgentSessionEvent): void;
	promptUntilAccepted(text: string, options?: PromptOptions): Promise<void>;
	cancelActions(predicate: (action: QueuedSessionAction) => boolean, error: Error): QueuedSessionAction[];
}
export class SessionMessageDelivery {
	private readonly outcomes = new Map<string, AgentMessageOutcome>();
	private readonly lateMessages = new Map<string, KernelSentAgentMessage[]>();
	constructor(
		private readonly actions: Pick<ActionStore<QueuedSessionAction>, "unfinishedActions">,
		private readonly host: SessionMessageDeliveryHost,
	) {}
	dispose(deliveryError: Error, completionError: Error): void {
		this.rejectQueuedAgentMessageDeliveries(deliveryError, completionError);
		for (const [id, outcome] of this.outcomes) {
			if (outcome.delivery) this.settleAgentMessage(id, "delivery", deliveryError);
			if (outcome.completion) this.settleAgentMessage(id, "completion", completionError);
		}
	}
	agentMessageOutcome(agentMessageId: string): AgentMessageOutcome {
		let outcome = this.outcomes.get(agentMessageId);
		if (!outcome) {
			outcome = {};
			this.outcomes.set(agentMessageId, outcome);
		}
		return outcome;
	}

	waitForAgentMessagePromptDelivery(agentMessageId: string): Promise<void> {
		const outcome = this.agentMessageOutcome(agentMessageId);
		outcome.delivery ??= createAgentMessageDeferred();
		return outcome.delivery.promise;
	}

	settleAgentMessage(agentMessageId: string | undefined, leg: "delivery" | "completion", error?: Error): void {
		if (agentMessageId === undefined) return;
		const outcome = this.outcomes.get(agentMessageId);
		if (!outcome) return;
		const deferred = outcome[leg];
		if (!deferred) return;
		outcome[leg] = undefined;
		if (!outcome.delivery && !outcome.completion) {
			this.outcomes.delete(agentMessageId);
		}
		if (error) deferred.reject(error);
		else deferred.resolve();
	}

	rejectAgentMessage(agentMessageId: string | undefined, error: Error): void {
		if (agentMessageId === undefined) return;
		this.settleAgentMessage(agentMessageId, "delivery", error);
		this.settleAgentMessage(agentMessageId, "completion", error);
	}

	rejectQueuedAgentMessageDeliveries(deliveryError: Error, completionError = deliveryError): void {
		for (const action of this.actions.unfinishedActions()) {
			this.settleAgentMessage(action.agentMessageId, "delivery", deliveryError);
			this.settleAgentMessage(action.agentMessageId, "completion", completionError);
		}
	}

	async promptAndWait(text: string, options?: PromptOptions): Promise<void> {
		const agentMessageId = options?.agentMessageId ?? `prompt-wait:${randomUUID()}`;
		if (this.outcomes.get(agentMessageId)?.completion) {
			throw new Error(`Prompt completion id is already in use: ${agentMessageId}`);
		}
		const outcome = this.agentMessageOutcome(agentMessageId);
		outcome.completion = createAgentMessageDeferred();
		const completion = outcome.completion.promise;
		const signal = options?.signal;
		let cancelQueuedPrompt: (() => void) | undefined;
		try {
			await this.host.promptUntilAccepted(text, { ...options, agentMessageId });
			if (signal) {
				cancelQueuedPrompt = () => {
					const error = new Error("Prompt was cancelled before it started.");
					const cancelled = this.host.cancelActions(
						(action) => action.agentMessageId === agentMessageId && action.payload.kind === "turn",
						error,
					);
					if (cancelled.length > 0) {
						this.settleAgentMessage(agentMessageId, "completion", error);
					}
				};
				signal.addEventListener("abort", cancelQueuedPrompt, { once: true });
				if (signal.aborted) cancelQueuedPrompt();
			}
			await completion;
		} catch (error) {
			this.settleAgentMessage(agentMessageId, "completion", asError(error));
			throw error;
		} finally {
			if (signal && cancelQueuedPrompt) {
				signal.removeEventListener("abort", cancelQueuedPrompt);
			}
		}
	}

	restoreLateIpythonSentAgentMessages(): void {
		this.lateMessages.clear();
		for (const entry of this.host.getStore().getBranch()) {
			if (entry.type !== "custom" || entry.customType !== IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY) {
				continue;
			}
			const persisted = parsePersistedIpythonSentAgentMessage(entry.data);
			if (persisted) {
				this.rememberLateIpythonSentAgentMessage(persisted.toolCallId, persisted.message);
			}
		}
	}

	rememberLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): boolean {
		const messages = this.lateMessages.get(toolCallId) ?? [];
		const isNew = !messages.some((entry) => entry.id === message.id);
		if (isNew) {
			messages.push(message);
			this.lateMessages.set(toolCallId, messages);
		}
		for (let index = this.host.getMessages().length - 1; index >= 0; index -= 1) {
			if (appendSentAgentMessageToToolResult(this.host.getMessages()[index], toolCallId, message)) {
				break;
			}
		}
		return isNew;
	}

	applyLateIpythonSentAgentMessages(message: AgentMessage): void {
		if (message.role !== "toolResult" || message.toolName !== "ipython") {
			return;
		}
		for (const sentMessage of this.lateMessages.get(message.toolCallId) ?? []) {
			appendSentAgentMessageToToolResult(message, message.toolCallId, sentMessage);
		}
	}

	recordLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): void {
		const record = () => {
			if (this.host.isDisposed() || !this.rememberLateIpythonSentAgentMessage(toolCallId, message)) {
				return;
			}
			this.host.getStore().appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, { toolCallId, message });
			this.host.emit({ type: "ipython_sent_agent_message", toolCallId, message });
		};
		this.host.enqueue(record);
	}
}
