import { describe, expect, it, vi } from "vitest";
import { DaemonSupervisor, isDaemonSupervisorCommandType } from "../src/modes/daemon/daemon-supervisor.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";

describe("daemon worker request progress", () => {
	it("admits every cloud command at the supervisor boundary", () => {
		for (const type of [
			"cloud_delegate",
			"cloud_delegations_list",
			"cloud_delegation_stop",
			"cloud_delegation_apply",
			"cloud_session_create",
			"cloud_session_list",
			"cloud_session_stop",
			"cloud_session_reprovision",
			"cloud_session_import_result",
			"cloud_spawn_child",
		]) {
			expect(isDaemonSupervisorCommandType(type)).toBe(true);
		}
	});

	it("forwards worker progress through the supervisor request callback", async () => {
		const progress = {
			id: "worker_1",
			type: "cloud_delegate_progress" as const,
			command: "cloud_delegate" as const,
			activeSessionId: "active",
			delegationId: "sess_cloud-1",
			phase: "running" as const,
			message: "running",
		};
		const request = vi.fn(async (_command, _timeout, options) => {
			options.onProgress(progress);
			return { type: "response" as const, command: "cloud_delegate", success: true as const };
		});
		const worker = { descriptor: { lifecycle: "ready" }, client: { request } };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			canRetryFailedWorker: () => false,
			requireAvailableWorkerClient: () => worker.client,
		}) as unknown as {
			forwardToWorker(
				worker: unknown,
				command: unknown,
				timeoutMs: number,
				onProgress: (value: typeof progress) => void,
			): Promise<unknown>;
		};
		const onProgress = vi.fn();
		await supervisor.forwardToWorker(
			worker,
			{ type: "cloud_delegate", activeSessionId: "active", delegationId: "sess_cloud-1", prompt: "fix" },
			100,
			onProgress,
		);
		expect(onProgress).toHaveBeenCalledWith(progress);
	});

	it("correlates cloud progress with the pending direct request", () => {
		const client = new DaemonWorkerClient("unused");
		const onProgress = vi.fn();
		// The pending entry's timer slot is inert here: the frame path only
		// reads it when the terminal response clears the request.
		const timeout = undefined as unknown as ReturnType<typeof setTimeout>;
		const internals = client as unknown as {
			pending: Map<
				string,
				{
					resolve: () => void;
					reject: () => void;
					timeout: ReturnType<typeof setTimeout>;
					onProgress: typeof onProgress;
				}
			>;
			handleFrame(frame: unknown): void;
		};
		internals.pending.set("worker_1", { resolve: () => {}, reject: () => {}, timeout, onProgress });
		internals.handleFrame({
			header: {
				kind: "outbound",
				outboundType: "cloud_delegate_progress",
				requestId: "worker_1",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(
				JSON.stringify({
					id: "worker_1",
					type: "cloud_delegate_progress",
					command: "cloud_delegate",
					activeSessionId: "active",
					delegationId: "sess_cloud-1",
					phase: "running",
					message: "running",
				}),
			),
		});
		clearTimeout(timeout);
		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({ type: "cloud_delegate_progress", delegationId: "sess_cloud-1", phase: "running" }),
		);
	});
});
