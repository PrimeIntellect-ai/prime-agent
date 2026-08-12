import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { herdrAgentStateExtension } from "../../../src/core/extensions/builtin/herdr-agent-state.js";
import { createHarness, type Harness } from "../harness.js";

interface RecordedRequest {
	method: string;
	params: Record<string, unknown>;
}

async function startFakeHerdrServer(socketPath: string): Promise<{
	server: Server;
	requests: RecordedRequest[];
	waitForRequests: (count: number, timeoutMs?: number) => Promise<void>;
}> {
	const requests: RecordedRequest[] = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];

	const server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.trim()) {
					const parsed = JSON.parse(line);
					requests.push({ method: parsed.method, params: parsed.params });
					socket.write(`${JSON.stringify({ id: parsed.id, result: { type: "ok" } })}\n`);
					for (const waiter of [...waiters]) {
						if (requests.length >= waiter.count) {
							waiters.splice(waiters.indexOf(waiter), 1);
							waiter.resolve();
						}
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.on("error", reject);
		server.listen(socketPath, resolve);
	});

	const waitForRequests = (count: number, timeoutMs = 3000): Promise<void> => {
		if (requests.length >= count) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} herdr requests`)), timeoutMs);
			waiters.push({
				count,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
		});
	};

	return { server, requests, waitForRequests };
}

describe("regression #1260: builtin herdr reporter registers a resumable session ref", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const envKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_PI_IDLE_DEBOUNCE_MS"];
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
	}

	const cleanupServers: Server[] = [];
	const cleanupHarnesses: Harness[] = [];
	const cleanupPaths: string[] = [];

	afterEach(async () => {
		for (const key of envKeys) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
		while (cleanupHarnesses.length > 0) {
			cleanupHarnesses.pop()?.cleanup();
		}
		while (cleanupServers.length > 0) {
			const server = cleanupServers.pop();
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("reports both session id and session path from the live session manager", async () => {
		// The extension factory captures HERDR_* env at load, so the socket and
		// env must exist before the harness loads extensions.
		const socketDir = join(tmpdir(), `hrd-1260-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(socketDir, { recursive: true });
		cleanupPaths.push(socketDir);
		const socketPath = join(socketDir, "h.sock");
		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";
		process.env.HERDR_PI_IDLE_DEBOUNCE_MS = "10";

		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [herdrAgentStateExtension],
		});
		cleanupHarnesses.push(harness);

		await harness.session.bindExtensions({});
		await waitForRequests(1);

		// Herdr accepts agent_session_id for the prime-agent label but dropped
		// path-only reports, so the session never became resumable. Both forms
		// must ride every report.
		const report = requests[0];
		expect(report?.method).toBe("pane.report_agent");
		expect(report?.params.agent).toBe("prime-agent");
		expect(report?.params.agent_session_id).toBe(harness.sessionManager.getSessionId());
		expect(report?.params.agent_session_path).toBe(harness.sessionManager.getSessionFile());
	});
});
