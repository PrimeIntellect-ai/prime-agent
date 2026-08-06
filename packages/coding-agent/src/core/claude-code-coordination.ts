import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
	AGENT_MESSAGE_ACCEPTED_CUSTOM_TYPE,
	AGENT_MESSAGE_CONSUMED_CUSTOM_TYPE,
	AGENT_MESSAGE_HANDOFF_CUSTOM_TYPE,
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRelationship,
	type AgentFamilyRosterResult,
	type AgentSessionMailboxEnvelope,
	type AgentSessionMailboxInboxInput,
	type AgentSessionMailboxInboxResult,
	type AgentSessionMailboxWaitInput,
	type AgentSessionMailboxWaitResult,
	type AgentSessionMessageDeliveryStatus,
	type AgentSessionMessageEndpoint,
	type AgentSessionMessageHandoff,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
	createAgentSessionMessageId,
	createAgentSessionMessageReceipt,
	findAgentSessionMailboxAcceptance,
	findAgentSessionMailboxHandoff,
	matchesAgentSessionMailboxFilter,
	projectAgentSessionMailbox,
} from "./agent-messages.js";

export const CLAUDE_CODE_MCP_SERVER_NAME = "prime";
export const CLAUDE_CODE_FAMILY_TOOL_NAMES = [
	"mcp__prime__family_list",
	"mcp__prime__family_send",
	"mcp__prime__family_inbox",
	"mcp__prime__family_wait",
] as const;

export interface ClaudeCodeFamilySendInput {
	receiverRole: "parent" | "sibling";
	receiverName?: string;
	message: string;
	id?: string;
	replyTo?: string;
}

export interface ClaudeCodeFamilyController {
	list(): Promise<AgentFamilyRosterResult>;
	send(input: ClaudeCodeFamilySendInput): Promise<AgentSessionMessageReceipt>;
	inbox(input: AgentSessionMailboxInboxInput): Promise<AgentSessionMailboxInboxResult>;
	wait(input: AgentSessionMailboxWaitInput, signal?: AbortSignal): Promise<AgentSessionMailboxWaitResult>;
}

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function createClaudeCodeFamilyMcpServer(
	controller: ClaudeCodeFamilyController,
	signal?: AbortSignal,
): McpSdkServerConfigWithInstance {
	return createSdkMcpServer({
		name: CLAUDE_CODE_MCP_SERVER_NAME,
		version: "1.0.0",
		instructions:
			"Prime Agent owns family coordination. Use these tools only for your parent and siblings; replies correlate with message id and replyTo.",
		alwaysLoad: true,
		tools: [
			tool("family_list", "List this Claude child's parent and siblings.", {}, async () =>
				result(await controller.list()),
			),
			tool(
				"family_send",
				"Send one correlated message to the parent or one named sibling.",
				{
					receiver_role: z.enum(["parent", "sibling"]),
					receiver_name: z.string().trim().min(1).optional(),
					message: z.string().min(1),
					message_id: z.string().trim().min(1).optional(),
					reply_to: z.string().trim().min(1).optional(),
				},
				async (input) => {
					if (input.receiver_role === "parent" && input.receiver_name) {
						throw new Error("receiver_name must be omitted for parent messages");
					}
					if (input.receiver_role === "sibling" && !input.receiver_name) {
						throw new Error("receiver_name is required for sibling messages");
					}
					return result(
						await controller.send({
							receiverRole: input.receiver_role,
							...(input.receiver_name ? { receiverName: input.receiver_name } : {}),
							message: input.message,
							...(input.message_id ? { id: input.message_id } : {}),
							...(input.reply_to ? { replyTo: input.reply_to } : {}),
						}),
					);
				},
			),
			tool(
				"family_inbox",
				"Peek or consume retained family messages in oldest-first order.",
				{
					limit: z.number().int().min(1).max(100).default(20),
					consume: z.boolean().default(false),
					sender: z.string().trim().min(1).optional(),
					reply_to: z.string().trim().min(1).optional(),
				},
				async (input) =>
					result(
						await controller.inbox({
							limit: input.limit,
							consume: input.consume,
							...(input.sender ? { sender: input.sender } : {}),
							...(input.reply_to ? { replyTo: input.reply_to } : {}),
						}),
					),
			),
			tool(
				"family_wait",
				"Wait for and consume the oldest matching family message.",
				{
					timeout_ms: z.number().int().min(1).max(300_000).default(30_000),
					sender: z.string().trim().min(1).optional(),
					reply_to: z.string().trim().min(1).optional(),
				},
				async (input) =>
					result(
						await controller.wait(
							{
								timeoutMs: input.timeout_ms,
								...(input.sender ? { sender: input.sender } : {}),
								...(input.reply_to ? { replyTo: input.reply_to } : {}),
							},
							signal,
						),
					),
			),
		],
	});
}

export interface ClaudeCodeFamilyMailboxStorage {
	read(): readonly unknown[];
	append(customType: string, details: unknown): void;
}

export interface ClaudeCodeFamilyMailboxOptions {
	target: AgentSessionMessageEndpoint;
	storage: ClaudeCodeFamilyMailboxStorage;
	list(): Promise<AgentFamilyRosterResult>;
	send(input: ClaudeCodeFamilySendInput): Promise<AgentSessionMessageReceipt>;
	deliver(message: string): "queued" | "woken";
}

export interface ClaudeCodeInboundMessage {
	message: string;
	id?: string;
	replyTo?: string;
	from?: AgentSessionMessageSender;
	fromRelationship?: AgentFamilyRelationship;
}

interface FamilyWaiter {
	filter: AgentSessionMailboxWaitInput;
	resolve: (result: AgentSessionMailboxWaitResult) => void;
	reject: (error: Error) => void;
}

export class ClaudeCodeFamilyMailbox implements ClaudeCodeFamilyController {
	private readonly options: ClaudeCodeFamilyMailboxOptions;
	private readonly waiters: FamilyWaiter[] = [];
	private lock: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(options: ClaudeCodeFamilyMailboxOptions) {
		this.options = options;
	}

	list(): Promise<AgentFamilyRosterResult> {
		return this.options.list();
	}

	send(input: ClaudeCodeFamilySendInput): Promise<AgentSessionMessageReceipt> {
		return this.options.send(input);
	}

	async inbox(input: AgentSessionMailboxInboxInput): Promise<AgentSessionMailboxInboxResult> {
		return this.withLock(async () => {
			const messages = this.retained(input).slice(0, input.limit ?? 20);
			if (input.consume) this.consume(messages);
			return { messages };
		});
	}

	async wait(input: AgentSessionMailboxWaitInput, signal?: AbortSignal): Promise<AgentSessionMailboxWaitResult> {
		let waiter: FamilyWaiter | undefined;
		let immediate: AgentSessionMailboxWaitResult | undefined;
		let pending: Promise<AgentSessionMailboxWaitResult> | undefined;
		await this.withLock(async () => {
			const message = this.retained(input)[0];
			if (message) {
				this.consume([message]);
				immediate = { message };
				return;
			}
			if (this.closed) throw new Error("Claude Code family mailbox is closed");
			pending = new Promise<AgentSessionMailboxWaitResult>((resolve, reject) => {
				waiter = { filter: input, resolve, reject };
				this.waiters.push(waiter);
			});
		});
		if (immediate) return immediate;
		if (!waiter || !pending) throw new Error("Claude Code family wait was not registered");
		const registeredWaiter = waiter;
		const registeredPending = pending;
		const timeoutMs = input.timeoutMs ?? 30_000;
		return new Promise<AgentSessionMailboxWaitResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				this.removeWaiter(registeredWaiter);
				resolve({});
			}, timeoutMs);
			const onAbort = () => {
				clearTimeout(timeout);
				this.removeWaiter(registeredWaiter);
				reject(new Error("Claude Code family wait cancelled"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			registeredPending.then(
				(value) => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
			if (signal?.aborted) onAbort();
		});
	}

	async receive(input: ClaudeCodeInboundMessage): Promise<AgentSessionMessageReceipt> {
		return this.withLock(async () => {
			if (this.closed) throw new Error("Claude Code family mailbox is closed");
			const id = input.id ?? createAgentSessionMessageId();
			const entries = this.options.storage.read();
			const prior = findAgentSessionMailboxAcceptance(entries, id, this.options.target.sessionId);
			const priorHandoff = prior
				? findAgentSessionMailboxHandoff(entries, id, this.options.target.sessionId)
				: undefined;
			if (prior && priorHandoff) {
				return createAgentSessionMessageReceipt(prior, priorHandoff.deliveryStatus, undefined, {
					acceptedAt: prior.acceptedAt,
					sequence: prior.sequence,
					handoff: "retry",
				});
			}
			const all = projectAgentSessionMailbox(entries, this.options.target.sessionId);
			const envelope: AgentSessionMailboxEnvelope = prior ?? {
				id,
				source: AGENT_MESSAGE_SOURCE,
				message: input.message,
				...(input.replyTo ? { replyTo: input.replyTo } : {}),
				...(input.from ? { from: input.from } : {}),
				...(input.fromRelationship ? { fromRelationship: input.fromRelationship } : {}),
				target: this.options.target,
				acceptedAt: new Date().toISOString(),
				sequence: all.reduce((maximum, message) => Math.max(maximum, message.sequence), 0) + 1,
			};
			if (!prior) this.options.storage.append(AGENT_MESSAGE_ACCEPTED_CUSTOM_TYPE, { envelope });
			const waiterIndex = this.waiters.findIndex((candidate) =>
				matchesAgentSessionMailboxFilter(envelope, candidate.filter),
			);
			if (waiterIndex >= 0) {
				const waiter = this.waiters.splice(waiterIndex, 1)[0]!;
				this.consume([envelope]);
				this.appendHandoff(envelope, "waiter", "delivered");
				waiter.resolve({ message: envelope });
				return createAgentSessionMessageReceipt(envelope, "delivered", new Date().toISOString(), {
					acceptedAt: envelope.acceptedAt,
					sequence: envelope.sequence,
					handoff: "waiter",
				});
			}
			const delivery = this.options.deliver(envelope.message);
			const deliveryStatus = delivery === "woken" ? "delivered" : "queued";
			const handoff = delivery === "woken" ? "context" : "queue";
			this.appendHandoff(envelope, handoff, deliveryStatus);
			return createAgentSessionMessageReceipt(
				envelope,
				deliveryStatus,
				delivery === "woken" ? new Date().toISOString() : undefined,
				{
					acceptedAt: envelope.acceptedAt,
					sequence: envelope.sequence,
					handoff,
				},
			);
		});
	}

	close(reason = "Claude Code family mailbox closed"): void {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(reason));
	}

	private retained(filter: AgentSessionMailboxInboxInput): AgentSessionMailboxEnvelope[] {
		return projectAgentSessionMailbox(this.options.storage.read(), this.options.target.sessionId).filter((message) =>
			matchesAgentSessionMailboxFilter(message, filter),
		);
	}

	private appendHandoff(
		envelope: AgentSessionMailboxEnvelope,
		handoff: Exclude<AgentSessionMessageHandoff, "retry">,
		deliveryStatus: AgentSessionMessageDeliveryStatus,
	): void {
		this.options.storage.append(AGENT_MESSAGE_HANDOFF_CUSTOM_TYPE, {
			messageId: envelope.id,
			targetSessionId: envelope.target.sessionId,
			handoff,
			deliveryStatus,
			handedOffAt: new Date().toISOString(),
		});
	}

	private consume(messages: AgentSessionMailboxEnvelope[]): void {
		for (const message of messages) {
			this.options.storage.append(AGENT_MESSAGE_CONSUMED_CUSTOM_TYPE, {
				messageId: message.id,
				targetSessionId: message.target.sessionId,
				sequence: message.sequence,
				consumedAt: new Date().toISOString(),
			});
		}
	}

	private removeWaiter(waiter: FamilyWaiter): void {
		const index = this.waiters.indexOf(waiter);
		if (index >= 0) this.waiters.splice(index, 1);
	}

	private withLock<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.lock.then(operation, operation);
		this.lock = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
