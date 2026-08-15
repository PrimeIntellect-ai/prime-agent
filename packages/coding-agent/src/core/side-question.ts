import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
	type CompactionSettings,
	estimateContextTokens,
	estimateTokens,
	generateSummary,
	serializeConversation,
	shouldCompact,
} from "./compaction/index.js";
import { convertToLlm, createCompactionSummaryMessage } from "./messages.js";

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

export interface SideQuestionDependencies {
	getCompactionSettings(): CompactionSettings;
	getRequestAuth(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
}

const SIDE_QUESTION_INSTRUCTION =
	"Answer this side question using only the conversation context above. Do not use tools. The user may send follow-up side questions; none of this side conversation is added to the main session.";

const SIDE_QUESTION_SUMMARY_INSTRUCTION =
	"Preserve the information needed to answer side questions, including prior side questions and answers. The continuing agent must answer only from the supplied conversation context and must not use tools.";

function sideQuestionPrompt(question: string): string {
	return `<side_question>\n${SIDE_QUESTION_INSTRUCTION}\n\n${question}\n</side_question>`;
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

function createSideAssistantMessage(answer: string, model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: answer }],
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
	};
}

function createPreviousTurnMessages(previousTurns: SideQuestionTurn[], model: Model<Api>): AgentMessage[] {
	return previousTurns.flatMap((turn) => [
		{
			role: "user",
			content: [{ type: "text", text: sideQuestionPrompt(turn.question) }],
			timestamp: Date.now(),
		} satisfies UserMessage,
		createSideAssistantMessage(turn.answer, model),
	]);
}

function isTurnStart(message: AgentMessage): boolean {
	return (
		message.role === "user" ||
		message.role === "bashExecution" ||
		message.role === "custom" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new DOMException("Side question cancelled", "AbortError");
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

function conservativeMessageTokens(message: AgentMessage): number {
	return estimateTokens(message) + (hasImage(message) ? 1200 : 0);
}

function estimateMainContextTokens(messages: AgentMessage[]): number {
	let latestCompactionIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "compactionSummary") {
			latestCompactionIndex = index;
			break;
		}
	}
	if (latestCompactionIndex === -1) return estimateContextTokens(messages).tokens;

	const compactionTimestamp = messages[latestCompactionIndex].timestamp;
	const hasFreshUsage = messages
		.slice(latestCompactionIndex + 1)
		.some(
			(message) =>
				message.role === "assistant" &&
				message.timestamp > compactionTimestamp &&
				message.stopReason !== "aborted" &&
				message.stopReason !== "error" &&
				message.usage.totalTokens > 0,
		);
	if (hasFreshUsage) return estimateContextTokens(messages.slice(latestCompactionIndex)).tokens;

	// Retained assistant messages predate the compaction and still carry usage for
	// the discarded context. Until a fresh response arrives, estimate the rebuilt
	// summary-first context instead of treating that stale usage as live input.
	return messages
		.slice(latestCompactionIndex)
		.reduce((total, message) => total + conservativeMessageTokens(message), 0);
}

interface SideTurn {
	messages: AgentMessage[];
	protected: boolean;
	tokens: number;
}

function hasImage(message: AgentMessage): boolean {
	if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return false;
	return Array.isArray(message.content) && message.content.some((block) => block.type === "image");
}

function buildSideTurns(messages: AgentMessage[]): SideTurn[] {
	if (messages.length === 0) return [];
	const resultIds = new Set(
		messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);
	const openCalls = new Set<string>();
	const turns: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	for (const message of messages) {
		if (current.length > 0 && isTurnStart(message) && openCalls.size === 0) {
			turns.push(current);
			current = [];
		}
		current.push(message);
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && resultIds.has(block.id)) openCalls.add(block.id);
			}
		} else if (message.role === "toolResult") openCalls.delete(message.toolCallId);
	}
	if (current.length > 0) turns.push(current);
	return turns.map((turn) => ({
		messages: turn,
		protected: turn.some(hasImage),
		tokens: turn.reduce((total, message) => total + conservativeMessageTokens(message), 0),
	}));
}

const SIDE_SUMMARY_OVERHEAD_TOKENS = 4096;
const SIDE_ANSWER_SAFETY_TOKENS = 1024;
const SIDE_SUMMARY_MAX_CONTEXT_FRACTION = 0.15;

function getSideSummaryBudget(
	model: Model<Api>,
	requestedReserveTokens: number,
): { reserveTokens: number; inputTokens: number } | undefined {
	const reserveTokens = Math.floor(
		Math.min(requestedReserveTokens, model.contextWindow * SIDE_SUMMARY_MAX_CONTEXT_FRACTION, model.maxTokens / 0.8),
	);
	const maxOutputTokens = Math.floor(0.8 * reserveTokens);
	const inputTokens = model.contextWindow - maxOutputTokens - SIDE_SUMMARY_OVERHEAD_TOKENS;
	return reserveTokens >= 128 && inputTokens >= 512 ? { reserveTokens, inputTokens } : undefined;
}

function splitSummaryText(text: string, inputTokens: number): string[] {
	const chunks: string[] = [];
	let chunk = "";
	let bytes = 0;
	for (const codePoint of text) {
		const nextBytes = utf8Bytes(codePoint);
		if (chunk && bytes + nextBytes > inputTokens) {
			chunks.push(chunk);
			chunk = "";
			bytes = 0;
		}
		chunk += codePoint;
		bytes += nextBytes;
	}
	if (chunk || chunks.length === 0) chunks.push(chunk);
	return chunks;
}

async function generateBoundedSideSummary(
	messages: AgentMessage[],
	model: Model<Api>,
	settings: CompactionSettings,
	apiKey: string,
	headers: Record<string, string> | undefined,
	signal: AbortSignal,
	parent: Agent,
): Promise<string | undefined> {
	const budget = getSideSummaryBudget(model, settings.reserveTokens);
	if (!budget) return undefined;
	const transformedMessages = parent.transformContext ? await parent.transformContext(messages, signal) : messages;
	let segments = splitSummaryText(serializeConversation(convertToLlm(transformedMessages)), budget.inputTokens);
	for (let level = 0; level < 8; level++) {
		const summaries: string[] = [];
		for (const [index, segment] of segments.entries()) {
			throwIfAborted(signal);
			const segmentMessage = {
				role: "user",
				content: [{ type: "text", text: `Conversation segment ${index + 1} of ${segments.length}:\n${segment}` }],
				timestamp: Date.now(),
			} satisfies UserMessage;
			summaries.push(
				await generateSummary(
					[segmentMessage],
					model,
					budget.reserveTokens,
					apiKey,
					headers,
					signal,
					SIDE_QUESTION_SUMMARY_INSTRUCTION,
					undefined,
					"off",
					{
						onPayload: parent.onPayload,
						onResponse: parent.onResponse,
						serviceTier: parent.state.serviceTier,
						sessionId: parent.sessionId,
						maxRetryDelayMs: parent.maxRetryDelayMs,
					},
				),
			);
		}
		throwIfAborted(signal);
		if (summaries.length === 1) return summaries[0];
		segments = splitSummaryText(
			summaries.map((summary, index) => `Summary ${index + 1}:\n${summary}`).join("\n\n"),
			budget.inputTokens,
		);
	}
	throw new Error("Side-question summary could not be reduced to fit the selected model context");
}

function answerContextTarget(
	model: Model<Api>,
	fixedOverheadTokens: number,
	prompt: string,
	aggressive: boolean,
): number {
	const base =
		model.contextWindow -
		model.maxTokens -
		fixedOverheadTokens -
		Math.ceil(utf8Bytes(prompt) / 3) -
		SIDE_ANSWER_SAFETY_TOKENS;
	return aggressive ? Math.floor(base * 0.75) : base;
}

async function compactSideContext(
	messages: AgentMessage[],
	tokensBefore: number,
	model: Model<Api>,
	settings: CompactionSettings,
	dependencies: SideQuestionDependencies,
	signal: AbortSignal,
	parent: Agent,
	fixedOverheadTokens: number,
	prompt: string,
	aggressive = false,
): Promise<AgentMessage[] | undefined> {
	const targetTokens = answerContextTarget(model, fixedOverheadTokens, prompt, aggressive);
	if (targetTokens <= 0) return undefined;
	const turns = buildSideTurns(messages);
	const protectedTokens = turns.filter((turn) => turn.protected).reduce((total, turn) => total + turn.tokens, 0);
	if (protectedTokens >= targetTokens) return undefined;

	throwIfAborted(signal);
	const { apiKey, headers } = await dependencies.getRequestAuth(model);
	const summaryBudget = getSideSummaryBudget(model, settings.reserveTokens);
	if (!summaryBudget) return undefined;
	const maxSummaryOutput = Math.floor(summaryBudget.reserveTokens * 0.8);
	let retentionBudget = Math.min(
		settings.keepRecentTokens,
		Math.floor((targetTokens - protectedTokens) * (aggressive ? 0.25 : 0.5)),
	);
	const summaryCache = new Map<string, string>();
	for (let attempt = 0; attempt < 4; attempt++) {
		const kept = new Set<number>();
		let recentTokens = 0;
		let recentSuffixClosed = false;
		for (let index = turns.length - 1; index >= 0; index--) {
			const turn = turns[index];
			if (turn.protected) {
				kept.add(index);
			} else if (!recentSuffixClosed && recentTokens + turn.tokens <= retentionBudget) {
				kept.add(index);
				recentTokens += turn.tokens;
			} else {
				recentSuffixClosed = true;
			}
		}
		const gaps: Array<{ start: number; end: number }> = [];
		for (let index = 0; index < turns.length; ) {
			if (kept.has(index)) {
				index++;
				continue;
			}
			const start = index;
			while (index < turns.length && !kept.has(index)) index++;
			gaps.push({ start, end: index });
		}
		if (gaps.length === 0) return undefined;
		const keptTokens = turns.reduce((total, turn, index) => total + (kept.has(index) ? turn.tokens : 0), 0);
		if (keptTokens + gaps.length * maxSummaryOutput > targetTokens && retentionBudget > 0) {
			retentionBudget = attempt === 2 ? 0 : Math.floor(retentionBudget / 2);
			continue;
		}
		const gapSummaries = new Map<number, AgentMessage>();
		for (const gap of gaps) {
			const key = `${gap.start}:${gap.end}`;
			let summary = summaryCache.get(key);
			if (!summary) {
				const removable = turns.slice(gap.start, gap.end).flatMap((turn) => turn.messages);
				summary = await generateBoundedSideSummary(removable, model, settings, apiKey, headers, signal, parent);
				if (summary === undefined) return undefined;
				summaryCache.set(key, summary);
			}
			gapSummaries.set(gap.start, createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString()));
		}
		const compacted: AgentMessage[] = [];
		for (let index = 0; index < turns.length; ) {
			const summary = gapSummaries.get(index);
			if (summary) {
				compacted.push(summary);
				index = gaps.find((gap) => gap.start === index)!.end;
			} else {
				compacted.push(...turns[index].messages);
				index++;
			}
		}
		const finalTokens = compacted.reduce((total, message) => total + conservativeMessageTokens(message), 0);
		if (finalTokens <= targetTokens) return compacted;
		if (retentionBudget === 0) return undefined;
		retentionBudget = attempt === 2 ? 0 : Math.floor(retentionBudget / 2);
	}
	return undefined;
}

function lastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

export function startSideQuestion(
	parent: Agent,
	id: string,
	question: string,
	onEvent: (event: SideQuestionEvent) => void | Promise<void>,
	previousTurns: SideQuestionTurn[] = [],
	dependencies?: SideQuestionDependencies,
): SideQuestionRun {
	const model = parent.state.model;
	if (!model) {
		throw new Error("Select a model before asking a side question");
	}

	// Snapshot only: side-question compaction and answering never mutate the live session.
	const mainMessages = structuredClone(parent.state.messages).filter((message) => convertToLlm([message]).length > 0);
	const previousTurnMessages = createPreviousTurnMessages(previousTurns, model);
	const prompt = sideQuestionPrompt(question);
	const promptMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	} satisfies UserMessage;
	// Estimate the live context before appending synthetic zero-usage side answers.
	const mainEstimate = estimateMainContextTokens(mainMessages);
	const replayTokens = previousTurnMessages.reduce((total, message) => total + estimateTokens(message), 0);
	const imageTokens = [...mainMessages, ...previousTurnMessages].reduce(
		(total, message) => total + (hasImage(message) ? 1200 : 0),
		0,
	);
	const estimatedMainTokens = mainMessages.reduce((total, message) => total + conservativeMessageTokens(message), 0);
	const hiddenOverheadTokens = Math.max(
		Math.ceil(utf8Bytes(parent.state.systemPrompt) / 3),
		mainEstimate - estimatedMainTokens,
		0,
	);
	const requestTokens =
		hiddenOverheadTokens + estimatedMainTokens + replayTokens + imageTokens + estimateTokens(promptMessage);
	const settings = dependencies?.getCompactionSettings();
	const runAbort = new AbortController();

	let answer = "";
	let abortRequested = false;
	let activeAgent: Agent | undefined;
	const emit = (status: SideQuestionStatus, errorMessage?: string) =>
		onEvent({ id, question, answer, status, ...(errorMessage ? { errorMessage } : {}) });

	const createSideAgent = (messages: AgentMessage[]): Agent =>
		new Agent({
			initialState: {
				model,
				systemPrompt: parent.state.systemPrompt,
				messages,
				thinkingLevel: "off",
				serviceTier: parent.state.serviceTier,
				tools: [],
			},
			convertToLlm: parent.convertToLlm,
			transformContext: parent.transformContext,
			streamFn: parent.streamFn,
			getApiKey: parent.getApiKey,
			onPayload: parent.onPayload,
			onResponse: parent.onResponse,
			shouldStopAfterTurn: () => true,
			sessionId: parent.sessionId,
			thinkingBudgets: parent.thinkingBudgets,
			transport: "sse",
			maxRetryDelayMs: parent.maxRetryDelayMs,
			toolExecution: parent.toolExecution,
		});

	const answerOnce = async (messages: AgentMessage[]): Promise<AssistantMessage | undefined> => {
		throwIfAborted(runAbort.signal);
		const sideAgent = createSideAgent(messages);
		activeAgent = sideAgent;
		const unsubscribe = sideAgent.subscribe(async (event) => {
			if (event.type !== "message_update" && event.type !== "message_end") {
				return;
			}
			const nextAnswer = readAssistantText(event.message);
			const completedMessage =
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.stopReason !== "error" &&
				event.message.stopReason !== "aborted" &&
				!isContextOverflow(event.message, model.contextWindow);
			if (nextAnswer === answer && !completedMessage) {
				return;
			}
			answer = nextAnswer;
			// The daemon writes side-question events directly to the attached client,
			// so a reconnect between message_end and run settlement could otherwise
			// leave the pane permanently "running". Emit completion at both boundaries.
			await emit(completedMessage ? "complete" : "running");
		});
		try {
			await sideAgent.prompt(prompt);
			return lastAssistantMessage(sideAgent.state.messages);
		} finally {
			unsubscribe();
			if (activeAgent === sideAgent) {
				activeAgent = undefined;
			}
		}
	};

	const done = Promise.resolve()
		.then(() => emit("running"))
		.then(async () => {
			throwIfAborted(runAbort.signal);
			let contextMessages = [...mainMessages, ...previousTurnMessages];
			const needsAnswerHeadroom = requestTokens > model.contextWindow - model.maxTokens - SIDE_ANSWER_SAFETY_TOKENS;
			if (
				dependencies &&
				settings &&
				(shouldCompact(requestTokens, model.contextWindow, settings) || (settings.enabled && needsAnswerHeadroom))
			) {
				contextMessages =
					(await compactSideContext(
						contextMessages,
						requestTokens,
						model,
						settings,
						dependencies,
						runAbort.signal,
						parent,
						hiddenOverheadTokens,
						prompt,
					)) ?? contextMessages;
			}

			let response = await answerOnce(contextMessages);
			throwIfAborted(runAbort.signal);
			if (response && dependencies && settings?.enabled && isContextOverflow(response, model.contextWindow)) {
				const retryContext = await compactSideContext(
					contextMessages,
					requestTokens,
					model,
					settings,
					dependencies,
					runAbort.signal,
					parent,
					hiddenOverheadTokens,
					prompt,
					true,
				);
				if (retryContext) {
					answer = "";
					response = await answerOnce(retryContext);
					throwIfAborted(runAbort.signal);
				}
			}

			if (response?.stopReason === "error") {
				await emit("error", response.errorMessage ?? "Side question failed");
				return;
			}
			await emit("complete");
		})
		.catch(async (error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			await Promise.resolve(
				emit(abortRequested ? "cancelled" : "error", abortRequested ? undefined : errorMessage),
			).catch(() => undefined);
		});

	return {
		done,
		abort() {
			abortRequested = true;
			runAbort.abort();
			activeAgent?.abort();
		},
	};
}
