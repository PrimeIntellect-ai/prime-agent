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

	it("stop resolves and allows restart when a grandchild holds the stdio pipes", async () => {
		const client = new RpcClient({ cliPath: fixturePath, env: { RPC_FIXTURE_HOLD_STDIO: "1" } });
		const grandchildPids: number[] = [];
		client.onEvent((event) => {
			const data = event as unknown as { type: string; pid?: number };
			if (data.type === "fixture_grandchild" && typeof data.pid === "number") grandchildPids.push(data.pid);
		});
		try {
			await client.start();
			await vi.waitFor(() => expect(grandchildPids).toHaveLength(1));
			await client.stop();
			await client.start();
			await vi.waitFor(() => expect(grandchildPids).toHaveLength(2));
			// Release the old child's stdio pipes: its late "close" must not poison
			// the restarted client.
			process.kill(grandchildPids[0], "SIGKILL");
			await vi.waitFor(() => expect(() => process.kill(grandchildPids[0], 0)).toThrow());
			await new Promise((resolve) => setTimeout(resolve, 25));
			const state = client.getState();
			client["handleLine"](
				JSON.stringify({ id: "req_1", type: "response", command: "get_state", success: true, data: {} }),
			);
			await expect(state).resolves.toEqual({});
			await client.stop();
		} finally {
			for (const pid of grandchildPids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Grandchild already exited.
				}
			}
		}
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
		// The failed child is cleaned up, so a retry spawns again instead of
		// throwing "Client already started".
		await expect(client.start()).rejects.toThrow("RPC process error");
	});

	it("resolves a response the child wrote just before exiting", async () => {
		const client = new RpcClient({ cliPath: fixturePath, env: { RPC_FIXTURE_REPLY_EXIT: "1" } });
		await client.start();
		await expect(client.getState()).resolves.toEqual({});
	});

	it("rejects pending work when the child exits while a grandchild holds stdout", async () => {
		const client = new RpcClient({ cliPath: fixturePath, env: { RPC_FIXTURE_HOLD_STDIO: "1" } });
		let grandchildPid: number | undefined;
		client.onEvent((event) => {
			const data = event as unknown as { type: string; pid?: number };
			if (data.type === "fixture_grandchild") grandchildPid = data.pid;
		});
		await client.start();
		await vi.waitFor(() => expect(grandchildPid).toBeDefined());
		const child = client["process"];
		if (!child) throw new Error("RPC child did not start");
		try {
			const command = expect(client.getState()).rejects.toThrow("RPC process exited");
			const idle = expect(client.waitForIdle()).rejects.toThrow("RPC process exited");
			child.kill("SIGKILL");
			await Promise.all([command, idle]);
		} finally {
			if (grandchildPid) process.kill(grandchildPid, "SIGKILL");
		}
	});

	it("fails a dead generation's pending work on restart and ignores its late output", async () => {
		const client = new RpcClient({
			cliPath: fixturePath,
			env: { RPC_FIXTURE_HOLD_STDIO: "1", RPC_FIXTURE_GHOST_EVENT: "1" },
		});
		const grandchildPids: number[] = [];
		client.onEvent((event) => {
			const data = event as unknown as { type: string; pid?: number };
			if (data.type === "fixture_grandchild" && typeof data.pid === "number") grandchildPids.push(data.pid);
		});
		try {
			await client.start();
			await vi.waitFor(() => expect(grandchildPids).toHaveLength(1));
			const child = client["process"];
			if (!child) throw new Error("RPC child did not start");
			const orphan = expect(client.getState()).rejects.toThrow("RPC client restarted");
			child.kill("SIGKILL");
			await vi.waitFor(() => expect(client["process"]).toBeNull());
			// Restart inside the dead child's stdout-drain window.
			await client.start();
			await orphan;
			const idle = client.waitForIdle();
			// The old grandchild writes an agent_end into the dead child's stdout ~250ms
			// after the kill; it must not resolve the new session's waiter.
			await vi.waitFor(() => expect(grandchildPids).toHaveLength(2));
			// The stderr sentinel proves the ghost's stdout write really happened, so the
			// still-pending assertion below cannot pass vacuously.
			await vi.waitFor(() => expect(client.getStderr()).toContain("ghost-event-written"), { timeout: 3000 });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(await Promise.race([idle, Promise.resolve("pending")])).toBe("pending");
			client["handleLine"](JSON.stringify({ type: "agent_end" }));
			await expect(idle).resolves.toBeUndefined();
			await client.stop();
		} finally {
			for (const pid of grandchildPids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Grandchild already exited.
				}
			}
		}
	});

	it("rejects pending commands and completion waits when the child output closes", async () => {
		const client = await createClient();
		const child = client["process"];
		if (!child) throw new Error("RPC child did not start");
		const died = /RPC process (exited|output closed)/;
		const command = expect(client.getState()).rejects.toThrow(died);
		const idle = expect(client.waitForIdle()).rejects.toThrow(died);
		const events = expect(client.collectEvents()).rejects.toThrow(died);

		child.kill("SIGTERM");

		await Promise.all([command, idle, events]);
		clients.delete(client);
	});
});
