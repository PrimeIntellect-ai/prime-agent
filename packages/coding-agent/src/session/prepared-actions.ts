import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL, isAgentSessionMessage } from "../core/agent-messages.js";
import type { ExtensionRunner, InputSource } from "../core/extensions/index.js";
import type {
	DeliveryPolicy,
	DeliveryRecord,
	SessionAction,
	SessionCommandPayload,
	SessionTurnPayload,
	WakePolicy,
} from "../core/session-action-store.js";
import type { SessionSlashCommand } from "../core/slash-commands.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
	type AsyncBashCompletionDetails,
	type CustomMessage,
} from "./context/messages.js";
import { createTurnExecutionPolicy, type TurnExecutionPolicy } from "./turns/turn-preparation.js";

export type QueuedAgentMessage = UserMessage | CustomMessage;
export type SessionInputSchedule = "steer" | "followUp";

export interface PreparedTurnPayload extends SessionTurnPayload {
	images?: ImageContent[];
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
	prepared?: PreparedPromptPreparation;
	executionPolicy: TurnExecutionPolicy;
	queueVisible: boolean;
	acceptedAgentMessage: boolean;
	acceptedBeforeCompletion: boolean;
	captureRunMessages?: Set<AgentMessage>;
	cancelledDispatchEnded?: boolean;
}

export interface PreparedCommandPayload extends SessionCommandPayload {
	images?: ImageContent[];
}

export type QueuedSessionAction = SessionAction<PreparedTurnPayload | PreparedCommandPayload>;

export interface PreparedPromptPreparation {
	result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>;
	basePromptSnapshot: string;
}

export class DeferredSessionInputError extends Error {}

export class SessionInputAdmissionPausedError extends Error {}

export interface RestoredPromptInput {
	text: string;
	content?: (TextContent | ImageContent)[];
	images?: ImageContent[];
	queueKey?: string;
	agentMessageId?: string;
	customMessage?: CustomMessage;
	prefixMessages?: CustomMessage[];
}

export const SESSION_ACTION_RECOVERY_FORMAT_VERSION = 1;

export interface SessionActionRecoveryRecord {
	id: string;
	role: DeliveryRecord["role"];
	message: QueuedAgentMessage;
	ownerActionId: string;
}

export type SessionActionRecoveryPayload =
	| {
			kind: "turn";
			text: string;
			preview?: string;
			records: SessionActionRecoveryRecord[];
			images?: ImageContent[];
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			executionPolicy: TurnExecutionPolicy;
			queueVisible: boolean;
			acceptedAgentMessage: boolean;
			acceptedBeforeCompletion: boolean;
	  }
	| {
			kind: "session_command";
			text: string;
			command: SessionSlashCommand;
			images?: ImageContent[];
	  };

export interface SessionActionRecoveryAction {
	id: string;
	source: InputSource | "internal";
	delivery: DeliveryPolicy;
	wake: WakePolicy;
	payload: SessionActionRecoveryPayload;
	queueKey?: string;
	agentMessageId?: string;
	suppressAutonomousContinuation?: boolean;
}

export interface SessionActionRecoverySnapshot {
	formatVersion: typeof SESSION_ACTION_RECOVERY_FORMAT_VERSION;
	actions: SessionActionRecoveryAction[];
}

export function cloneCustomMessage(message: CustomMessage): CustomMessage {
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

export function cloneQueuedAgentMessage(message: QueuedAgentMessage): QueuedAgentMessage {
	if (message.role === "custom") return cloneCustomMessage(message);
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

export function primaryDeliveryRecord(action: QueuedSessionAction): DeliveryRecord {
	if (action.payload.kind !== "turn") throw new Error(`Session action ${action.id} is not a turn`);
	const record = action.payload.records.find((candidate) => candidate.role === "primary");
	if (!record) throw new Error(`Turn action ${action.id} has no primary delivery record`);
	return record;
}

export function normalizeMessageContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images?: ImageContent[];
} {
	if (typeof content === "string") return { text: content };
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part): part is ImageContent => part.type === "image");
	return { text, ...(images.length > 0 ? { images } : {}) };
}

export function queuedAgentMessagePreview(action: QueuedSessionAction): string {
	const payload = action.payload;
	if (payload.kind === "session_command") return payload.text;
	if (payload.customMessage && isAgentSessionMessage(payload.customMessage)) {
		return `${AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL}: ${payload.customMessage.details.message}`;
	}
	if (payload.customMessage?.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE) {
		const details = payload.customMessage.details as AsyncBashCompletionDetails | undefined;
		return details
			? `${ASYNC_BASH_COMPLETION_PREVIEW_LABEL}: pid ${details.pid}, exit ${details.exitCode}`
			: ASYNC_BASH_COMPLETION_PREVIEW_LABEL;
	}
	return payload.preview ?? payload.text;
}

export function visibleSessionActionProjection(
	actions: readonly QueuedSessionAction[],
): readonly QueuedSessionAction[] {
	return actions.filter(
		(action) =>
			action.payload.kind === "session_command" ||
			action.payload.queueVisible ||
			action.payload.acceptedAgentMessage,
	);
}

export function buildPromptContent(text: string, images?: ImageContent[]): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	content.push({ type: "text", text });
	if (images) content.push(...images);
	return content;
}

function deliveryPolicy(schedule: SessionInputSchedule): DeliveryPolicy {
	return schedule === "steer" ? "next_turn_boundary" : "when_run_idle";
}

export function createDeliveryRecord(
	actionId: string,
	role: DeliveryRecord["role"],
	message: QueuedAgentMessage,
): DeliveryRecord {
	return {
		id: randomUUID(),
		role,
		message,
		started: false,
		durable: false,
		ownerActionId: actionId,
	};
}

export function createPreparedTurnAction(
	schedule: SessionInputSchedule,
	text: string,
	images: ImageContent[] | undefined,
	options: {
		agentMessageId?: string;
		queueKey?: string;
		content?: (TextContent | ImageContent)[];
		message?: QueuedAgentMessage;
		prefixMessages?: CustomMessage[];
		previewLabel?: string;
		suppressAutonomousContinuation?: boolean;
		resumeIfIdle?: boolean;
		source?: InputSource | "internal";
		executionPolicy?: TurnExecutionPolicy;
		queueVisible?: boolean;
		acceptedAgentMessage?: boolean;
		acceptedBeforeCompletion?: boolean;
	},
): QueuedSessionAction {
	const id = randomUUID();
	const content = options.content ?? buildPromptContent(text, images);
	const message =
		options.message ??
		({
			role: "user",
			content: content.map((block) => ({ ...block })),
			timestamp: Date.now(),
		} satisfies UserMessage);
	const prefixMessages = options.prefixMessages?.map((prefix) => cloneCustomMessage(prefix)) ?? [];
	const preview = options.previewLabel ? `${options.previewLabel}: ${text}` : undefined;
	const payload: PreparedTurnPayload = {
		kind: "turn",
		text,
		records: [
			...prefixMessages.map((prefix) => createDeliveryRecord(id, "prefix", prefix)),
			createDeliveryRecord(id, "primary", message),
		],
		preview,
		images: images?.map((image) => ({ ...image })),
		content: content.map((block) => ({ ...block })),
		customMessage: options.message?.role === "custom" ? cloneCustomMessage(options.message) : undefined,
		executionPolicy: options.executionPolicy ?? createTurnExecutionPolicy("queued"),
		queueVisible: options.queueVisible ?? true,
		acceptedAgentMessage: options.acceptedAgentMessage ?? false,
		acceptedBeforeCompletion: options.acceptedBeforeCompletion ?? false,
	};
	return {
		id,
		source: options.source ?? "internal",
		delivery: deliveryPolicy(schedule),
		wake:
			options.resumeIfIdle === true ? "immediate" : schedule === "steer" ? "on_lower_boundary" : "external_resume",
		payload,
		lifecycle: { state: "queued" },
		queueKey: options.queueKey,
		agentMessageId: options.agentMessageId,
		suppressAutonomousContinuation: options.suppressAutonomousContinuation,
	};
}

export function createSessionCommandAction(
	text: string,
	command: SessionSlashCommand,
	images: ImageContent[] | undefined,
	schedule: SessionInputSchedule,
	options: {
		agentMessageId?: string;
		source?: InputSource | "internal";
	} = {},
): QueuedSessionAction {
	return {
		id: randomUUID(),
		source: options.source ?? "internal",
		delivery: deliveryPolicy(schedule),
		wake: "immediate",
		payload: { kind: "session_command", text, command, images },
		lifecycle: { state: "queued" },
		agentMessageId: options.agentMessageId,
	};
}
