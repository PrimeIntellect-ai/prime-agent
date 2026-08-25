import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rpc-client-hanging-fixture.mjs", import.meta.url));
const clients = new Set<RpcClient>();

async function createClient(): Promise<RpcClient> {
	const client = new RpcClient({ cliPath: fixturePath });
	await client.start();
	clients.add(client);
	return client;
}

describe("RpcClient operation completion", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await Promise.all([...clients].map((client) => client.stop()));
		clients.clear();
	});

	it("does not time out a long RPC command by default", async () => {
		const client = await createClient();
		vi.useFakeTimers();
		const result = client.bash("sleep 120");

		await vi.advanceTimersByTimeAsync(120_000);
		expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");

		client["handleLine"](
			JSON.stringify({
				id: "req_1",
				type: "response",
				command: "bash",
				success: true,
				data: { output: "done", exitCode: 0, cancelled: false, truncated: false },
			}),
		);
		await expect(result).resolves.toMatchObject({ output: "done", exitCode: 0 });
	});

	it("rejects promptAndWait when the prompt response fails", async () => {
		const client = await createClient();
		const result = expect(client.promptAndWait("rejected prompt")).rejects.toThrow("prompt rejected");

		client["handleLine"](
			JSON.stringify({
				id: "req_1",
				type: "response",
				command: "prompt",
				success: false,
				error: "prompt rejected",
			}),
		);

		await result;
		expect(client["pendingEventWaiters"].size).toBe(0);
	});

	it("does not time out agent completion by default", async () => {
		const client = await createClient();
		vi.useFakeTimers();
		const idle = client.waitForIdle();
		const events = client.collectEvents();

		await vi.advanceTimersByTimeAsync(120_000);
		expect(await Promise.race([idle, Promise.resolve("pending")])).toBe("pending");
		expect(await Promise.race([events, Promise.resolve("pending")])).toBe("pending");

		client["handleLine"](JSON.stringify({ type: "agent_end" }));
		await expect(idle).resolves.toBeUndefined();
		await expect(events).resolves.toEqual([{ type: "agent_end" }]);
	});

	it("waits for child close before restarting", async () => {
		const client = await createClient();

		await client.stop();
		await client.start();
		const state = client.getState();
		client["handleLine"](
			JSON.stringify({ id: "req_1", type: "response", command: "get_state", success: true, data: {} }),
		);

		await expect(state).resolves.toEqual({});
	});

	it("starts from the child spawn signal without waiting for a timer", async () => {
		vi.useFakeTimers();
		const client = new RpcClient({ cliPath: fixturePath });
		clients.add(client);

		await expect(client.start()).resolves.toBeUndefined();
	});

	it("rejects start when the child cannot spawn", async () => {
		const client = new RpcClient({ cliPath: fixturePath, env: { PATH: "" } });

		await expect(client.start()).rejects.toThrow("RPC process error");
	});

	it("rejects pending commands and completion waits when the child output closes", async () => {
		const client = await createClient();
		const child = client["process"];
		if (!child) throw new Error("RPC child did not start");
		const command = expect(client.getState()).rejects.toThrow("RPC process output closed");
		const idle = expect(client.waitForIdle()).rejects.toThrow("RPC process output closed");
		const events = expect(client.collectEvents()).rejects.toThrow("RPC process output closed");

		child.kill("SIGTERM");

		await Promise.all([command, idle, events]);
		clients.delete(client);
	});
});
