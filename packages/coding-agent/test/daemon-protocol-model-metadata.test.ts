import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommandEnvelope,
	getDaemonCommandCompatibilities,
	isDaemonCommandEnvelope,
	meetsDaemonCommandCompatibility,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import { serializeJsonLine } from "../src/modes/rpc/jsonl.js";

vi.mock("node:net", () => ({ createConnection: vi.fn() }));

class MockSocket extends EventEmitter {
	readonly writes: string[] = [];
	destroyed = false;

	write(data: string): boolean {
		this.writes.push(data);
		return true;
	}

	end(): this {
		return this;
	}

	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

const clients: DaemonClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	vi.clearAllMocks();
});

const legacyModel: Omit<Model<Api>, "supportedServiceTiers"> = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

async function connect(schemaRevision: number, catalog = false) {
	const socket = new MockSocket();
	vi.mocked(createConnection).mockReturnValue(socket as unknown as Socket);
	const client = new DaemonClient("/tmp/model-metadata.sock");
	clients.push(client);
	const connecting = client.connect(1000);
	socket.emit("connect");
	await connecting;
	socket.emit(
		"data",
		serializeJsonLine({
			type: "daemon_hello",
			socketPath: "/tmp/model-metadata.sock",
			protocol: { name: "prime-agent.daemon", version: 7 },
			schemaRevision,
			clientId: "metadata-client",
			serverCapabilities: catalog ? ["model_catalog"] : [],
		}),
	);
	await client.waitForHello(1000);
	return { client, socket };
}

function respond(socket: MockSocket, data: unknown): DaemonCommandEnvelope {
	const envelope = JSON.parse(socket.writes.at(-1)!) as DaemonCommandEnvelope;
	expect(isDaemonCommandEnvelope(envelope)).toBe(true);
	socket.emit("data", serializeJsonLine(success(envelope.id, envelope.command.type, data)));
	return envelope;
}

describe("optional model metadata protocol compatibility", () => {
	it.each(["get_available_models", "get_model_catalog"] as const)(
		"lets a new client read %s from a pre-metadata daemon",
		async (type) => {
			const { client, socket } = await connect(28, type === "get_model_catalog");
			const pending = client.request({ type, activeSessionId: "active-1" }, 1000);
			respond(socket, { models: [legacyModel], configuredProviders: [legacyModel.provider] });
			const response = await pending;
			expect(response.success).toBe(true);
			if (!response.success) throw new Error(response.error);
			const data = response.data as { models: Model<Api>[] };
			expect(data.models[0].id).toBe("gpt-6-astra");
			expect(data.models[0].supportedServiceTiers).toBeUndefined();
			expect(socket.writes).toHaveLength(1);
			// Optional metadata must not add a startup or attach schema requirement.
			expect(
				getDaemonCommandCompatibilities({ type: "attach", activeSessionId: "active-1" }).every((requirement) =>
					meetsDaemonCommandCompatibility(client.hello!, requirement),
				),
			).toBe(true);
		},
	);

	it("lets a legacy model reader select a model from a new daemon without a metadata capability", async () => {
		const { client, socket } = await connect(DAEMON_SCHEMA_REVISION);
		const model: Model<Api> = { ...legacyModel, supportedServiceTiers: ["priority", "future-tier"] };
		const pending = client.request({ type: "get_available_models", activeSessionId: "active-1" }, 1000);
		respond(socket, { models: [model] });
		const response = await pending;
		expect(response.success).toBe(true);
		if (!response.success) throw new Error(response.error);
		// The pre-metadata reader only uses known Model fields; no schema negotiation is added.
		const data = response.data as { models: Omit<Model<Api>, "supportedServiceTiers">[] };
		const selected = data.models[0];
		const selection = client.request(
			{ type: "set_model", activeSessionId: "active-1", provider: selected.provider, modelId: selected.id },
			1000,
		);
		const envelope = respond(socket, model);
		expect(envelope.protocol.version).toBe(7);
		expect(envelope.command).toMatchObject({
			type: "set_model",
			provider: "openai-codex",
			modelId: "gpt-6-astra",
		});
		expect(envelope.command).not.toHaveProperty("supportedServiceTiers");
		await expect(selection).resolves.toMatchObject({ success: true, data: model });
		expect(response.data).toMatchObject({ models: [{ supportedServiceTiers: ["priority", "future-tier"] }] });
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(29);
		for (const type of ["response", "session_attached", "session_resynced", "session_replaced"] as const) {
			expect(DAEMON_OUTBOUND_COMPATIBILITY[type]).toEqual({ minProtocol: 7 });
		}
	});
});
