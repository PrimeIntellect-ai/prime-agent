import { Buffer } from "node:buffer";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

function getEntryTypes(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => entry.type);
}

describe("AgentSession bash and persistence characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records bash results immediately while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
		expect(getEntryTypes(harness)).toContain("message");
	});

	it("defers bash results while streaming and flushes them before the next prompt", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after flush"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await sawToolStart;
		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		releaseToolExecution?.();
		await firstPrompt;

		expect(harness.session.hasPendingBashMessages).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		await harness.session.prompt("next turn");

		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(harness.session.messages.some((message) => message.role === "bashExecution")).toBe(true);
		expect(getEntryTypes(harness).filter((type) => type === "message").length).toBeGreaterThan(0);
	});

	it("executes bash commands and records the result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const result = await harness.session.executeBash("printf 'hello'");

		expect(result.output).toContain("hello");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("cancels running bash commands with abortBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		};

		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);
		harness.session.abortBash();

		const result = await bashPromise;
		expect(result.cancelled).toBe(true);
		expect(harness.session.isBashRunning).toBe(false);
	});

	it("persists user, assistant, toolResult, and custom messages in order", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.sendCustomMessage({
			customType: "note",
			content: "hello",
			display: true,
			details: { a: 1 },
		});
		await harness.session.prompt("start");

		const entries = harness.sessionManager.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual([
			"custom_message",
			"message",
			"message",
			"message",
			"message",
		]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("does not emit message_end for bash execution messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const messageEndRoles: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end") {
				messageEndRoles.push(event.message.role);
			}
		});

		harness.session.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		expect(messageEndRoles).toEqual([]);
	});

	it("persists aborted assistant messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await promptPromise;

		const lastEntry = harness.sessionManager.getEntries()[harness.sessionManager.getEntries().length - 1];
		expect(lastEntry?.type).toBe("message");
		if (lastEntry?.type === "message") {
			expect(lastEntry.message.role).toBe("assistant");
			if (lastEntry.message.role === "assistant") {
				expect(lastEntry.message.stopReason).toBe("aborted");
			}
		}
	});

	it("records bash output through custom operations", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("hello from custom ops"));
				return { exitCode: 0 };
			},
		};

		const result = await harness.session.executeBash("custom", undefined, { operations });

		expect(result.output).toContain("hello from custom ops");
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("bashExecution");
	});

	it("emits bash lifecycle events and records the result for runUserBash", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const events: Array<{ type: string }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "bash_start" || event.type === "bash_output" || event.type === "bash_end") {
				events.push(event);
			}
		});

		await harness.session.runUserBash("echo lifecycle", { excludeFromContext: true });
		unsubscribe();

		expect(events[0]).toMatchObject({ type: "bash_start", command: "echo lifecycle", excludeFromContext: true });
		expect(events.some((event) => event.type === "bash_output")).toBe(true);
		expect(events[events.length - 1]).toMatchObject({ type: "bash_end", exitCode: 0, cancelled: false });

		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("bashExecution");
		if (lastMessage?.role === "bashExecution") {
			expect(lastMessage.output).toContain("lifecycle");
			expect(lastMessage.excludeFromContext).toBe(true);
		}
	});

	it("reports runUserBash execution failures through bash_end instead of rejecting", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const events: Array<{ type: string; errorMessage?: string }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "bash_end") {
				events.push(event);
			}
		});

		const executeBashSpy = harness.session.executeBash.bind(harness.session);
		harness.session.executeBash = async () => {
			throw new Error("spawn failure");
		};
		await harness.session.runUserBash("echo unreachable");
		harness.session.executeBash = executeBashSpy;
		unsubscribe();

		expect(events).toHaveLength(1);
		expect(events[0]?.errorMessage).toBe("spawn failure");

		// The failure is persisted like every other outcome
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("bashExecution");
		if (lastMessage?.role === "bashExecution") {
			expect(lastMessage.output).toContain("spawn failure");
		}
	});

	it("cancels runUserBash when abortBash arrives before execution starts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const events: Array<{ type: string; cancelled?: boolean }> = [];
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "bash_output" || event.type === "bash_end") {
				events.push(event);
			}
		});

		// Abort lands during the user_bash extension dispatch, before any process spawns
		const run = harness.session.runUserBash("echo should-not-run");
		harness.session.abortBash();
		await run;
		unsubscribe();

		expect(events).toEqual([{ type: "bash_end", exitCode: undefined, cancelled: true, truncated: false }]);
		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("bashExecution");
		if (lastMessage?.role === "bashExecution") {
			expect(lastMessage.cancelled).toBe(true);
			expect(lastMessage.output).toBe("");
		}
	});

	it("releases the bash slot before bash_end reaches subscribers", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let runningAtBashEnd: boolean | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "bash_end") {
				runningAtBashEnd = harness.session.isBashRunning;
			}
		});

		await harness.session.runUserBash("echo done");
		unsubscribe();

		expect(runningAtBashEnd).toBe(false);
	});

	it("drains queued agent-message prompts after user bash finishes", async () => {
		let releaseBash: (() => void) | undefined;
		let bashStarted: (() => void) | undefined;
		const bashStartedPromise = new Promise<void>((resolve) => {
			bashStarted = resolve;
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				bashStarted?.();
				options.onData(Buffer.from("bash output"));
				await new Promise<void>((resolve) => {
					releaseBash = resolve;
				});
				return { exitCode: 0 };
			},
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", async () => ({ operations }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("after bash")]);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_bash\n\nqueued after bash";
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_bash");

		const bashRun = harness.session.runUserBash("slow bash");
		await bashStartedPromise;
		expect(harness.session.isBashRunning).toBe(true);
		await harness.session.queueAgentMessagePrompt(agentPrompt, "followUp");
		expect(harness.session.queuedActionCount).toBe(1);

		releaseBash?.();
		await bashRun;
		for (let i = 0; i < 10 && harness.session.queuedActionCount > 0; i++) {
			await Promise.resolve();
		}
		await delivery;

		expect(harness.session.queuedActionCount).toBe(0);
	});

	it("drains steering before follow-up prompts after user bash finishes", async () => {
		let releaseBash: (() => void) | undefined;
		let bashStarted: (() => void) | undefined;
		const bashStartedPromise = new Promise<void>((resolve) => {
			bashStarted = resolve;
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				bashStarted?.();
				options.onData(Buffer.from("bash output"));
				await new Promise<void>((resolve) => {
					releaseBash = resolve;
				});
				return { exitCode: 0 };
			},
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", async () => ({ operations }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("after steer"), fauxAssistantMessage("after follow-up")]);
		const steerPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_bash_steer\n\nsteer after bash";
		const followUpPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_bash_followup\n\nfollow-up after bash";
		const steerDelivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_bash_steer");
		const followUpDelivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_bash_followup");

		const bashRun = harness.session.runUserBash("slow bash");
		await bashStartedPromise;
		await harness.session.queueAgentMessagePrompt(followUpPrompt, "followUp");
		await harness.session.queueAgentMessagePrompt(steerPrompt, "steer");

		releaseBash?.();
		await bashRun;
		await steerDelivery;
		await followUpDelivery;
		await harness.session.waitForIdle();

		const userTexts = harness.session.messages.filter((message) => message.role === "user").map(getMessageText);
		expect(userTexts.findIndex((text) => text.includes("steer after bash"))).toBeLessThan(
			userTexts.findIndex((text) => text.includes("follow-up after bash")),
		);
		expect(harness.session.queuedActionCount).toBe(0);
	});

	it("flushes pending bash output before draining queued prompts", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("after bash"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_flush_bash\n\nqueued after bash";
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_flush_bash");

		const turn = harness.session.prompt("start");
		await toolStarted;
		harness.session.recordBashResult("echo flushed", {
			output: "flushed output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		await harness.session.queueAgentMessagePrompt(agentPrompt, "followUp");
		releaseToolExecution?.();
		await turn;
		await delivery;
		await harness.session.waitForIdle();

		const bashIndex = harness.session.messages.findIndex((message) => message.role === "bashExecution");
		const userIndex = harness.session.messages.findIndex(
			(message) => message.role === "user" && getMessageText(message).includes("queued after bash"),
		);
		expect(bashIndex).toBeGreaterThanOrEqual(0);
		expect(userIndex).toBeGreaterThan(bashIndex);
		expect(harness.session.hasPendingBashMessages).toBe(false);
	});

	it("rejects a second runUserBash issued before the first starts executing", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Same-tick overlap: the guard must trip before the first command reaches
		// executeBash, i.e. during the async user_bash extension dispatch.
		const first = harness.session.runUserBash("echo first");
		await expect(harness.session.runUserBash("echo second")).rejects.toThrow("already running");
		await first;

		const bashMessages = harness.session.messages.filter((message) => message.role === "bashExecution");
		expect(bashMessages).toHaveLength(1);
	});

	it("rejects runUserBash while another bash command is running", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let releaseExec: (() => void) | undefined;
		const operations: BashOperations = {
			exec: async () => {
				await new Promise<void>((resolve) => {
					releaseExec = resolve;
				});
				return { exitCode: 0 };
			},
		};

		const first = harness.session.executeBash("blocked", undefined, { operations });
		await expect(harness.session.runUserBash("echo nope")).rejects.toThrow("already running");
		releaseExec?.();
		await first;
	});
});
