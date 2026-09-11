import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	completeWithProviderRetry,
	DEFAULT_PROVIDER_RETRY_POLICY,
	type ProviderRetryPolicy,
} from "./provider-retry.js";
import { unwrapSemanticEdgeStreamFn } from "./semantic-edges.js";
import { getAuxiliaryThinkingLevel } from "./thinking-levels.js";

export type SideQuestionStatus = "running" | "complete" | "cancelled" | "error";

export interface SideQuestionEvent {
	id: string;
	question: string;
	answer: string;
	status: SideQuestionStatus;
	errorMessage?: string;
}

export interface SideQuestionTurn {
	question: string;
	answer: string;
}

export interface SideQuestionRun {
	done: Promise<void>;
	abort(): void;
}

const SIDE_QUESTION_INSTRUCTION =
	"The user asked this via `/btw` — a temporary side thread cloned from the main conversation to answer a question without interrupting the main work. Tools (including `ipython`) are deactivated in this side thread and return an error if called; answer using only the conversation context above. The user may send follow-up side questions. Nothing here is added to the main session, so don't start or plan main-session work from this thread.";

const SIDE_QUESTION_TOOL_BLOCKED = "Tools are deactivated in this side thread. Answer from the conversation context.";

/** Backstop for a model that keeps calling deactivated tools instead of answering. */
const SIDE_QUESTION_MAX_TURNS = 3;

function sideQuestionPrompt(question: string, isFirstTurn: boolean): string {
	const body = isFirstTurn ? `${SIDE_QUESTION_INSTRUCTION}\n\n${question}` : question;
	return `<side_question>\n${body}\n</side_question>`;
}

function readAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export function startSideQuestion(
	parent: Agent,
	id: string,
	question: string,
	onEvent: (event: SideQuestionEvent) => void | Promise<void>,
	previousTurns: SideQuestionTurn[] = [],
	retry: ProviderRetryPolicy = DEFAULT_PROVIDER_RETRY_POLICY,
): SideQuestionRun {
	const model = parent.state.model;
	if (!model) {
		throw new Error("Select a model before asking a side question");
	}

	// Each turn re-clones the live main conversation, so follow-ups always see
	// the newest main-thread context; earlier side turns are replayed after it.
	const previousTurnMessages: AgentMessage[] = previousTurns.flatMap((turn, index) => [
		{
			role: "user",
			content: [{ type: "text", text: sideQuestionPrompt(turn.question, index === 0) }],
			timestamp: Date.now(),
		} satisfies UserMessage,
		{
			role: "assistant",
			content: [{ type: "text", text: turn.answer }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} satisfies AssistantMessage,
	]);

	let turnCount = 0;
	const sideAgent = new Agent({
		initialState: {
			model,
			systemPrompt: parent.state.systemPrompt,
			messages: [...structuredClone(parent.state.messages), ...previousTurnMessages],
			thinkingLevel: getAuxiliaryThinkingLevel(model, parent.state.thinkingLevel),
			serviceTier: parent.state.serviceTier,
			// Providers serialize tool declarations ahead of the cached prefix, so an
			// empty list would miss the main cache; execution is blocked in beforeToolCall.
			tools: parent.state.tools,
		},
		convertToLlm: parent.convertToLlm,
		transformContext: parent.transformContext,
		// Side questions are excluded from session history; their calls carry no provenance.
		streamFn: unwrapSemanticEdgeStreamFn(parent.streamFn),
		getApiKey: parent.getApiKey,
		onPayload: parent.onPayload,
		onResponse: parent.onResponse,
		beforeToolCall: async () => ({ block: true, reason: SIDE_QUESTION_TOOL_BLOCKED }),
		shouldStopAfterTurn: ({ message }) => {
			turnCount += 1;
			return turnCount >= SIDE_QUESTION_MAX_TURNS || !message.content.some((block) => block.type === "toolCall");
		},
		sessionId: parent.sessionId,
		thinkingBudgets: parent.thinkingBudgets,
		transport: "sse",
		toolExecution: parent.toolExecution,
	});

	const clonedMessageCount = sideAgent.state.messages.length;
	// A turn-capped run can end on tool results, so its outcome lives in the
	// assistant turns it appended rather than in its last message.
	const assistantTurns = () =>
		sideAgent.state.messages
			.slice(clonedMessageCount)
			.filter((message): message is AssistantMessage => message.role === "assistant");
	let answer = "";
	let abortRequested = false;
	let started = false;
	const retryAbortController = new AbortController();
	const emit = (status: SideQuestionStatus, errorMessage?: string) =>
		onEvent({ id, question, answer, status, ...(errorMessage ? { errorMessage } : {}) });

	// Streaming events carry one partial turn at a time, so they only fill in text
	// as it arrives; the answer of the whole run is derived from its finished turns.
	const unsubscribe = sideAgent.subscribe(async (event) => {
		if (event.type !== "message_update" && event.type !== "message_end") {
			return;
		}
		const nextAnswer = readAssistantText(event.message);
		if (!nextAnswer || nextAnswer === answer) {
			return;
		}
		answer = nextAnswer;
		await emit("running");
	});

	const prompt = sideQuestionPrompt(question, previousTurns.length === 0);
	const done = Promise.resolve()
		.then(() => emit("running"))
		.then(async () => {
			if (abortRequested) {
				await emit("cancelled");
				return;
			}
			started = true;
			// Standalone side agents bypass the session auto-retry loop; retry here instead.
			let promptedOnce = false;
			const finalTurn = await completeWithProviderRetry(
				async () => {
					if (promptedOnce) {
						// Session-loop recovery: drop the failed assistant turn and re-run.
						sideAgent.state.messages = sideAgent.state.messages.slice(0, -1);
						await sideAgent.continue();
					} else {
						promptedOnce = true;
						await sideAgent.prompt(prompt);
					}
					const last = assistantTurns().at(-1);
					if (!last) {
						throw new Error(sideAgent.state.errorMessage || "Side question produced no assistant message");
					}
					return last;
				},
				{ policy: retry, signal: retryAbortController.signal },
			);
			if (abortRequested) {
				await emit("cancelled");
				return;
			}
			if (sideAgent.state.errorMessage) {
				await emit("error", sideAgent.state.errorMessage);
				return;
			}
			// A run that ends on a tool turn was answered in an earlier turn; a textless
			// final turn without tool calls is a genuinely empty answer.
			answer = finalTurn.content.some((block) => block.type === "toolCall")
				? (assistantTurns().map(readAssistantText).filter(Boolean).at(-1) ?? "")
				: readAssistantText(finalTurn);
			await emit("complete");
		})
		.catch(async (error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			await Promise.resolve(
				emit(abortRequested ? "cancelled" : "error", abortRequested ? undefined : errorMessage),
			).catch(() => undefined);
		})
		.finally(unsubscribe);

	return {
		done,
		abort() {
			abortRequested = true;
			retryAbortController.abort();
			if (started) {
				sideAgent.abort();
			}
		},
	};
}
