import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { runAcpModeWithConnection } from "../../src/modes/acp/acp-mode.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness } from "./harness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function createClient() {
	const harness = await createHarness({
		models: [
			{ id: "reasoning/model", name: "Reasoning", reasoning: true },
			{ id: "plain", name: "Plain", reasoning: false },
		],
	});
	const runtime = {
		session: harness.session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
	const connection = new InProcessAgentConnection(runtime);
	let inputController!: TransformStreamDefaultController<Uint8Array>;
	const toAgent = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			inputController = controller;
		},
	});
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const updates: acp.SessionNotification[] = [];
	const running = runAcpModeWithConnection(connection, {
		stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
	});
	const handle = acp
		.client({ name: "config-test" })
		.onNotification("session/update", (ctx) => {
			updates.push(ctx.params as acp.SessionNotification);
		})
		.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
	cleanups.push(async () => {
		handle.close();
		inputController.terminate();
		await running;
		harness.cleanup();
	});
	await handle.agent.request("initialize", {
		protocolVersion: acp.PROTOCOL_VERSION,
		clientCapabilities: {},
	});
	const configUpdates = () =>
		updates.flatMap(({ update }) => (update.sessionUpdate === "config_option_update" ? [update.configOptions] : []));
	return { harness, connection, client: handle.agent, updates, configUpdates };
}

async function createSession() {
	const fixture = await createClient();
	const session = await fixture.client.request("session/new", { cwd: fixture.harness.tempDir, mcpServers: [] });
	return { ...fixture, session };
}

describe("ACP session configuration", () => {
	it("advertises selectable models and supported reasoning levels with current values", async () => {
		const { harness, session } = await createSession();
		expect(session.configOptions).toEqual([
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: `${harness.getModel().provider}/reasoning/model`,
				options: harness.models.map((model) => ({
					value: `${model.provider}/${model.id}`,
					name: `${model.name} (${model.provider})`,
				})),
			},
			{
				id: "thought_level",
				name: "Reasoning level",
				category: "thought_level",
				type: "select",
				currentValue: harness.session.thinkingLevel,
				options: harness.session.getAvailableThinkingLevels().map((level) => ({ value: level, name: level })),
			},
		]);
	});

	it("sets reasoning, then returns dependent configuration when switching models", async () => {
		const { harness, client, session, configUpdates } = await createSession();
		const reasoning = await client.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "thought_level",
			value: "high",
		});
		expect(harness.session.thinkingLevel).toBe("high");
		expect(reasoning.configOptions).toHaveLength(2);
		expect(reasoning.configOptions[1]?.currentValue).toBe("high");
		const switched = await client.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "model",
			value: `${harness.getModel().provider}/plain`,
		});
		expect(harness.session.model?.id).toBe("plain");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(switched.configOptions.map((option) => option.id)).toEqual(["model"]);
		expect(configUpdates().at(-1)).toEqual(switched.configOptions);
		const restored = await client.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "model",
			value: `${harness.getModel().provider}/reasoning/model`,
		});
		expect(restored.configOptions[1]?.currentValue).toBe("high");
	});

	it.each([
		{ configId: "unknown", value: "high" },
		{ configId: "model", value: "unknown/model" },
		{ configId: "thought_level", value: "extreme" },
	])("rejects invalid configuration without changing the session: $configId=$value", async (params) => {
		const { harness, client, session } = await createSession();
		const previousModel = harness.session.model;
		const previousLevel = harness.session.thinkingLevel;
		await expect(
			client.request("session/set_config_option", { sessionId: session.sessionId, ...params }),
		).rejects.toMatchObject({ code: -32602 });
		expect(harness.session.model).toBe(previousModel);
		expect(harness.session.thinkingLevel).toBe(previousLevel);
	});

	it("rejects boolean values and unknown or closed sessions", async () => {
		const { client, session } = await createSession();
		await expect(
			client.request("session/set_config_option", {
				sessionId: session.sessionId,
				configId: "thought_level",
				type: "boolean",
				value: true,
			}),
		).rejects.toMatchObject({ code: -32602 });
		await expect(
			client.request("session/set_config_option", {
				sessionId: "missing",
				configId: "thought_level",
				value: "high",
			}),
		).rejects.toMatchObject({ code: -32602 });
		await client.request("session/close", { sessionId: session.sessionId });
		await expect(
			client.request("session/set_config_option", {
				sessionId: session.sessionId,
				configId: "thought_level",
				value: "high",
			}),
		).rejects.toMatchObject({ code: -32602 });
	});

	it("publishes agent-side reasoning changes without duplicate notifications", async () => {
		const { harness, configUpdates, client, session } = await createSession();
		harness.session.setThinkingLevel("high");
		await vi.waitFor(() => expect(configUpdates().at(-1)?.[1]?.currentValue).toBe("high"));
		const count = configUpdates().length;
		await client.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "thought_level",
			value: "high",
		});
		expect(configUpdates()).toHaveLength(count);
	});

	it("serializes concurrent selections and recovers after a failed mutation", async () => {
		const { client, connection, session, harness } = await createSession();
		vi.spyOn(connection, "setModel").mockRejectedValueOnce(new Error("model unavailable"));
		await expect(
			client.request("session/set_config_option", {
				sessionId: session.sessionId,
				configId: "model",
				value: `${harness.getModel().provider}/plain`,
			}),
		).rejects.toMatchObject({ code: -32603 });
		const results = await Promise.all(
			["low", "high"].map((value) =>
				client.request("session/set_config_option", {
					sessionId: session.sessionId,
					configId: "thought_level",
					value,
				}),
			),
		);
		expect(results.map((result) => result.configOptions[1]?.currentValue)).toEqual(["low", "high"]);
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("accepts model configuration while a prompt is still running", async () => {
		const { client, session, harness } = await createSession();
		let finishResponse!: () => void;
		const responseReady = new Promise<void>((resolve) => {
			finishResponse = resolve;
		});
		harness.setResponses([
			async () => {
				await responseReady;
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "wait" }],
		});
		try {
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
			const result = await client.request("session/set_config_option", {
				sessionId: session.sessionId,
				configId: "model",
				value: `${harness.getModel().provider}/plain`,
			});
			expect(result.configOptions[0]?.currentValue).toBe(`${harness.getModel().provider}/plain`);
			expect(harness.session.isStreaming).toBe(true);
		} finally {
			finishResponse();
			await prompt;
		}
	});

	it("waits for an admitted configuration change before closing the session", async () => {
		const { client, connection, session, harness, configUpdates } = await createSession();
		let finishChange!: () => void;
		const changeReady = new Promise<void>((resolve) => {
			finishChange = resolve;
		});
		const setModel = connection.setModel.bind(connection);
		const changing = vi.spyOn(connection, "setModel").mockImplementation(async (provider, modelId) => {
			await changeReady;
			return setModel(provider, modelId);
		});
		const mutation = client.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "model",
			value: `${harness.getModel().provider}/plain`,
		});
		await vi.waitFor(() => expect(changing).toHaveBeenCalledOnce());
		const closing = client.request("session/close", { sessionId: session.sessionId });
		try {
			await expect(
				client.request("session/set_config_option", {
					sessionId: session.sessionId,
					configId: "thought_level",
					value: "low",
				}),
			).rejects.toMatchObject({ code: -32602 });
		} finally {
			finishChange();
			await mutation;
			await closing;
		}
		const count = configUpdates().length;
		const next = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		expect(next.configOptions?.[0]?.currentValue).toBe(`${harness.getModel().provider}/plain`);
		expect(configUpdates()).toHaveLength(count);
	});

	it("keeps session startup and prompts usable when the model catalog fails", async () => {
		const { client, connection, harness } = await createClient();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(connection, "getAvailableModels").mockRejectedValue(new Error("catalog unavailable"));
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		expect(session.configOptions).toEqual([]);
		harness.setResponses([fauxAssistantMessage("hello")]);
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			}),
		).resolves.toMatchObject({ stopReason: "end_turn" });
	});
});
