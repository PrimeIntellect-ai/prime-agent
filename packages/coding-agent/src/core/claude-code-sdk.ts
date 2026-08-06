import { type McpServerConfig, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeCodeUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	requests: number;
}

export type ClaudeCodeEvent =
	| { kind: "init"; model: string; tools: string[]; version: string; sessionId: string }
	| { kind: "assistant"; text?: string; usage: ClaudeCodeUsage }
	| { kind: "tool-progress"; toolUseId: string; toolName: string; elapsedSeconds: number }
	| { kind: "result"; isError: boolean; text: string; usage: ClaudeCodeUsage }
	| { kind: "error"; error: Error }
	| { kind: "aborted"; reason?: string }
	| { kind: "close" };

export interface ClaudeCodeQueryRequest {
	prompt: AsyncIterable<string>;
	model: string;
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	executable: string;
	cwd: string;
	appendSystemPrompt: string;
	tools: string[];
	allowedTools: string[];
	disallowedTools: string[];
	mcpServers?: Record<string, McpServerConfig>;
	abortController: AbortController;
}

export interface ClaudeCodeQuery {
	events: AsyncIterable<ClaudeCodeEvent>;
	close(): void;
}

export type StartClaudeCodeQuery = (request: ClaudeCodeQueryRequest) => Promise<ClaudeCodeQuery>;

function sdkUsage(message: Extract<SDKMessage, { type: "assistant" | "result" }>): ClaudeCodeUsage {
	const usage = message.type === "assistant" ? message.message.usage : message.usage;
	const input = usage.input_tokens;
	const output = usage.output_tokens;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: message.type === "result" ? message.total_cost_usd : 0,
		requests: message.type === "result" ? message.num_turns : 1,
	};
}

export async function* mapClaudeCodeSdkMessages(messages: AsyncIterable<SDKMessage>): AsyncGenerator<ClaudeCodeEvent> {
	try {
		for await (const message of messages) {
			if (message.type === "system" && message.subtype === "init") {
				yield {
					kind: "init",
					model: message.model,
					tools: [...message.tools],
					version: message.claude_code_version,
					sessionId: message.session_id,
				};
				continue;
			}
			if (message.type === "tool_progress") {
				yield {
					kind: "tool-progress",
					toolUseId: message.tool_use_id,
					toolName: message.tool_name,
					elapsedSeconds: message.elapsed_time_seconds,
				};
				continue;
			}
			if (message.type === "assistant") {
				const text = message.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
				yield { kind: "assistant", ...(text ? { text } : {}), usage: sdkUsage(message) };
				continue;
			}
			if (message.type !== "result") continue;
			yield message.subtype === "success"
				? { kind: "result", isError: message.is_error, text: message.result, usage: sdkUsage(message) }
				: { kind: "result", isError: true, text: message.errors.join("\n"), usage: sdkUsage(message) };
		}
	} catch (error) {
		yield { kind: "error", error: error instanceof Error ? error : new Error(String(error)) };
	} finally {
		yield { kind: "close" };
	}
}

async function* mapClaudeCodeInput(input: AsyncIterable<string>): AsyncGenerator<SDKUserMessage> {
	for await (const text of input) {
		yield {
			type: "user",
			message: { role: "user", content: [{ type: "text", text }] },
			parent_tool_use_id: null,
			origin: { kind: "coordinator" },
			priority: "next",
			shouldQuery: true,
		};
	}
}

export type ClaudeCodeSdkQuery = (params: Parameters<typeof query>[0]) => ReturnType<typeof query>;

export function createClaudeCodeQueryStarter(querySdk: ClaudeCodeSdkQuery = query): StartClaudeCodeQuery {
	return async (request) => {
		const started = querySdk({
			prompt: mapClaudeCodeInput(request.prompt),
			options: {
				model: request.model,
				effort: request.effort,
				cwd: request.cwd,
				pathToClaudeCodeExecutable: request.executable,
				settingSources: [],
				tools: [...request.tools],
				allowedTools: [...request.allowedTools],
				disallowedTools: [...request.disallowedTools],
				...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
				permissionMode: "dontAsk",
				abortController: request.abortController,
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					append: request.appendSystemPrompt,
				},
			},
		});
		return { events: mapClaudeCodeSdkMessages(started), close: () => started.close() };
	};
}

export const startClaudeCodeQuery: StartClaudeCodeQuery = createClaudeCodeQueryStarter();
