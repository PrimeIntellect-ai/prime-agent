import { describe, expect, it, vi } from "vitest";
import type { DaemonClient, DaemonHello } from "../src/modes/daemon/daemon-client.js";
import { listDaemonHeartbeats } from "../src/modes/daemon/heartbeat-catalog.js";

function hello(): DaemonHello {
	return {
		type: "daemon_hello",
		socketPath: "/tmp/daemon.sock",
		protocol: { name: "prime-agent.daemon", version: 4 },
		schemaId: "test",
		appVersion: "test",
		runtime: { buildId: "test", executablePath: "node" },
		clientId: "client",
		serverCapabilities: ["heartbeat_catalog"],
	};
}

describe("daemon heartbeat catalog", () => {
	it("waits for the daemon hello before checking heartbeat capabilities", async () => {
		let greeted = false;
		const heartbeat = { job: { id: "heartbeat" } };
		const client = {
			hello: undefined,
			waitForHello: vi.fn(async () => {
				greeted = true;
				return hello();
			}),
			supportsServerCapability: vi.fn(() => greeted),
			request: vi.fn(async () => ({
				id: "request",
				type: "response",
				command: "heartbeats_list",
				success: true,
				data: { heartbeats: [heartbeat] },
			})),
		} as unknown as DaemonClient;

		await expect(listDaemonHeartbeats(client)).resolves.toEqual([heartbeat]);
		expect(client.waitForHello).toHaveBeenCalledOnce();
		expect(client.request).toHaveBeenCalledWith({ type: "heartbeats_list" });
	});
});
