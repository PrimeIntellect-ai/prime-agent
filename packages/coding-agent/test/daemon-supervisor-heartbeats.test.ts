import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorHarness {
	workers: Map<string, unknown>;
	clients: Set<DaemonSocketClient>;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerFrame(worker: unknown, frame: unknown): void;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function worker(lifecycle: "ready" | "recovering", connected = true) {
	return {
		descriptor: { lifecycle },
		...(connected ? { client: {} } : {}),
	};
}

describe("daemon supervisor heartbeat aggregation", () => {
	it("forwards Act events only to opted-in clients for the addressed session", () => {
		const supervisor = createSupervisorHarness();
		const writes = (capabilitiesByActiveSessionId: Map<string, Set<"rlm_act_stream">>) => {
			const values: string[] = [];
			const client = {
				id: `client-${supervisor.clients.size}`,
				socket: {
					destroyed: false,
					write: (value: Uint8Array) => {
						values.push(Buffer.from(value).toString("utf8"));
						return true;
					},
				},
				attachedActiveSessionIds: new Set(["active-1"]),
				detachInput: vi.fn(),
				supportsExtensionUi: false,
				capabilities: new Set(),
				capabilitiesByActiveSessionId,
			} as unknown as DaemonSocketClient;
			supervisor.clients.add(client);
			return values;
		};
		const supported = writes(new Map([["active-1", new Set(["rlm_act_stream"])]]));
		const unsupported = writes(new Map([["active-1", new Set()]]));
		const wrongSession = writes(new Map([["other", new Set(["rlm_act_stream"])]]));
		const message = {
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "act_event",
				actId: "act-1",
				outerToolCallId: "outer-tool-1",
				sequence: 1,
				event: "assistant_delta",
				stream: "text",
				text: "working",
				textTruncated: false,
			},
		};
		supervisor.handleWorkerFrame(
			{
				snapshotCache: new Map(),
				snapshotLoads: new Map(),
				transcriptCaches: new Map(),
			},
			{
				header: {
					kind: "outbound",
					outboundType: "session_event",
					activeSessionId: "active-1",
					sessionEventType: "act_event",
					payloadEncoding: "jsonl",
				},
				payload: Buffer.from(`${JSON.stringify(message)}\n`),
			},
		);
		expect(supported).toEqual([`${JSON.stringify(message)}\n`]);
		expect(unsupported).toEqual([]);
		expect(wrongSession).toEqual([]);
	});
	it("unions worker subscriptions from capabilities on the same session only", () => {
		const supervisor = createSupervisorHarness();
		const client = {
			attachedActiveSessionIds: new Set(["active-1", "active-2"]),
			capabilities: new Set(),
			capabilitiesByActiveSessionId: new Map([
				["active-1", new Set(["rlm_act_stream"])],
				["active-2", new Set(["extension_ui"])],
			]),
		} as unknown as DaemonSocketClient;
		supervisor.clients.add(client);
		const subscription = Reflect.get(supervisor, "workerSubscriptionCapabilities").bind(supervisor) as (
			activeSessionId: string,
		) => { capabilities: string[]; supportsExtensionUi: boolean };
		expect(subscription("active-1")).toEqual({
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot", "rlm_act_stream"],
			supportsExtensionUi: false,
		});
		expect(subscription("active-2")).toEqual({
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"],
			supportsExtensionUi: true,
		});
		client.attachedActiveSessionIds.delete("active-1");
		expect(subscription("active-1").capabilities).not.toContain("rlm_act_stream");
	});

	it("uses the last complete worker snapshot during recovery", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : "heartbeat-2" } }],
			}),
		);

		const initial = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(initial).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});

		second.descriptor.lifecycle = "recovering";
		delete second.client;
		const recovered = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(recovered).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
	});

	it("returns a worker failure instead of a partial catalog", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			target === first
				? success(command.id, command.type, { heartbeats: [] })
				: failure(command.id, command.type, "worker unavailable"),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("does not fall back to a snapshot after the worker reports heartbeat changes", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1" } }],
			heartbeatSnapshotStale: false,
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			failure(command.id, command.type, "worker unavailable"),
		);

		supervisor.handleWorkerFrame(target, {
			header: { kind: "outbound", outboundType: "heartbeats_changed" },
			payload: Buffer.alloc(0),
		});
		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-stale",
			type: "heartbeats_list",
		});

		expect(target.heartbeatSnapshotStale).toBe(true);
		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
	});

	it("fails rather than returning a partial catalog without a cached snapshot", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("ready", worker("ready"));
		supervisor.workers.set("recovering", worker("recovering", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-3",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: false,
			error: "Cannot list heartbeats while session worker is recovering",
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});

	it("routes management by cached job ownership after a session unloads", async () => {
		const supervisor = createSupervisorHarness();
		const target = {
			...worker("ready"),
			heartbeatSnapshot: [{ job: { id: "heartbeat-1", activeSessionId: "unloaded-session" } }],
		};
		supervisor.workers.set("target", target);
		supervisor.forwardToWorker = vi.fn(async (_worker, command) =>
			success(command.id, command.type, {
				heartbeat: { id: "heartbeat-1", activeSessionId: "unloaded-session", status: "cancelled" },
			}),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "manage-1",
			type: "heartbeat_manage",
			activeSessionId: "unloaded-session",
			jobId: "heartbeat-1",
			action: "stop",
		});

		expect(response).toMatchObject({ success: true });
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ type: "heartbeat_manage", jobId: "heartbeat-1" }),
		);
		expect(target.heartbeatSnapshot).toEqual([]);
	});
});
