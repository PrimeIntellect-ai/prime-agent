import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import {
	BASH_ACTIVITY_DISPLAY_MIME,
	createDeferred,
	type HostRequestHandlers,
	ReplKernelManager,
} from "../../../src/core/kernel/index.js";
import { ASYNC_BASH_COMPLETION_CUSTOM_TYPE } from "../../../src/core/messages.js";
import { canEvictWorker, canPassivateSession } from "../../../src/core/session-action-store.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import type { SessionKernel } from "../../../src/session/kernel/kernel.js";
import { createHarness, type Harness } from "../harness.js";

const runtimeDir = resolve(__dirname, "../../../../../prime-agent-runtime");
const python = resolve(runtimeDir, ".venv/bin/python");
const describeRuntime = existsSync(python) ? describe : describe.skip;

interface KernelSession {
	_kernel: SessionKernel;
	_createKernelHostHandlers(): HostRequestHandlers;
}

function evictionSnapshot(session: AgentSession) {
	return {
		isSessionActive: session.isSessionActive,
		attachedClients: 0,
		hasRegisteredCronJob: false,
		lastActivityAt: 0,
	};
}

function passivationAllowed(session: AgentSession): boolean {
	return canPassivateSession(
		{
			...evictionSnapshot(session),
			hasParent: true,
			hasNonPassiveDescendants: false,
			isHydrating: false,
		},
		1,
		120_000,
	);
}

describeRuntime("#2053 background kernel bash residency", () => {
	let harness: Harness | undefined;
	let manager: ReplKernelManager | undefined;

	afterEach(async () => {
		await manager?.shutdown();
		harness?.cleanup();
		vi.restoreAllMocks();
	});

	async function start(
		beforeCompletion?: () => Promise<void>,
		withConfiguredAuth = true,
	): Promise<{ session: AgentSession; kernel: ReplKernelManager }> {
		harness = await createHarness({ tools: [], rlmDepth: 1, withConfiguredAuth });
		const session = harness.session;
		const internals = session as unknown as KernelSession;
		const hostHandlers = internals._createKernelHostHandlers();
		const completed = hostHandlers["bash.completed"]!;
		hostHandlers["bash.completed"] = async (payload) => {
			await beforeCompletion?.();
			return completed(payload);
		};
		manager = new ReplKernelManager({
			python,
			cwd: harness.tempDir,
			env: { PYTHONPATH: resolve(runtimeDir, "src") },
			hostHandlers,
		});
		const provisioner = new IpythonKernelProvisioner(harness.tempDir);
		vi.spyOn(provisioner, "manager", "get").mockReturnValue(manager);
		internals._kernel.provisioner = provisioner;
		return { session, kernel: manager };
	}

	it("keeps a managed BashHandle resident after its creating cell without blocking a new turn", async () => {
		const { session, kernel } = await start();
		expect(passivationAllowed(session)).toBe(true);
		const started = await kernel.execute("from rlm import bash\nhandle = bash('sleep 600')\nhandle.pid");
		expect(started.status).toBe("ok");
		expect(Number(started.result)).toBeGreaterThan(0);
		expect(session.isStreaming).toBe(false);
		expect(session.isBashRunning).toBe(false);
		expect(passivationAllowed(session)).toBe(false);
		expect(
			canEvictWorker(
				{
					lifecycle: "ready",
					isConnected: true,
					isStopping: false,
					hasOwnerClient: false,
					isPreparingUpdateRestart: false,
					hasWakeBlindSchedule: false,
					sessions: [evictionSnapshot(session)],
				},
				1,
				120_000,
			),
		).toBe(false);

		harness!.setResponses([fauxAssistantMessage("Other work can continue.")]);
		await session.prompt("Do other work while the command runs.");
		expect(session.getLastAssistantText()).toBe("Other work can continue.");
		expect(passivationAllowed(session)).toBe(false);

		harness!.setResponses([fauxAssistantMessage("Inspected the completed command.")]);
		await kernel.execute("handle.kill()");
		await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("Inspected the completed command."));
		await session.waitForIdle();
		await vi.waitFor(() => expect(passivationAllowed(session)).toBe(true));
		expect(
			session.messages.filter(
				(message) => message.role === "custom" && message.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
			),
		).toHaveLength(1);
	});

	it("keeps concurrent handles resident until the final completion and clears on kernel teardown", async () => {
		const { session, kernel } = await start();
		await kernel.execute("from rlm import bash\nfirst = bash('sleep 600')\nsecond = bash('sleep 600')");
		expect(passivationAllowed(session)).toBe(false);
		harness!.setResponses([fauxAssistantMessage("First command finished.")]);
		await kernel.execute("first.kill()");
		await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("First command finished."));
		await session.waitForIdle();
		expect(passivationAllowed(session)).toBe(false);

		await kernel.kill();
		expect(passivationAllowed(session)).toBe(true);
		expect(
			session.messages.filter(
				(message) => message.role === "custom" && message.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
			),
		).toHaveLength(1);
	});

	it("releases awaited commands without a completion follow-up", async () => {
		const { session, kernel } = await start();
		const result = await kernel.execute("from rlm import bash\n(await bash('printf done')).output");
		expect(result.status).toBe("ok");
		expect(result.result).toContain("done");
		await vi.waitFor(() => expect(passivationAllowed(session)).toBe(true));
		expect(session.messages).toEqual([]);
	});

	it("defers one completion across admission pauses without issuing another host request", async () => {
		const beforeCompletion = vi.fn(async () => {});
		const { session, kernel } = await start(beforeCompletion);
		const firstPause = session.acquireSessionInputPause();
		const secondPause = session.acquireSessionInputPause();
		try {
			await kernel.execute("from rlm import bash\nhandle = bash('printf done')");
			await vi.waitFor(() => expect(session.hasPendingAdmissionWaiters).toBe(true));
			expect(kernel.hasBackgroundWork).toBe(true);
			expect(session.messages).toEqual([]);
			firstPause.release();
			await kernel.execute("42");
			expect(session.hasPendingAdmissionWaiters).toBe(true);
			expect(kernel.hasBackgroundWork).toBe(true);
			harness!.setResponses([fauxAssistantMessage("Completion accepted after pause.")]);
			secondPause.release();
			await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("Completion accepted after pause."));
			await session.waitForIdle();
			await vi.waitFor(() => expect(kernel.hasBackgroundWork).toBe(false));
			expect(beforeCompletion).toHaveBeenCalledTimes(1);
			expect(
				session.messages.filter(
					(message) => message.role === "custom" && message.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
				),
			).toHaveLength(1);
		} finally {
			firstPause.release();
			secondPause.release();
		}
	});

	it("stops waiting for admission when the session is disposed", async () => {
		const beforeCompletion = vi.fn(async () => {});
		const { session, kernel } = await start(beforeCompletion);
		const pause = session.acquireSessionInputPause();
		try {
			await kernel.execute("from rlm import bash\nhandle = bash('printf done')");
			await vi.waitFor(() => expect(session.hasPendingAdmissionWaiters).toBe(true));
			session.dispose();
			await vi.waitFor(() => expect(session.hasPendingAdmissionWaiters).toBe(false));
			await vi.waitFor(() => expect(kernel.hasBackgroundWork).toBe(false));
			expect(beforeCompletion).toHaveBeenCalledTimes(1);
			expect(session.messages).toEqual([]);
		} finally {
			pause.release();
		}
	});

	it("withdraws the queued completion notice when a later cell reads the result", async () => {
		const notice = createDeferred<void>();
		const release = createDeferred<void>();
		try {
			const { session, kernel } = await start(async () => {
				notice.resolve();
				await release.promise;
			});
			harness!.setResponses([
				async () => {
					// The notice queues while the model is busy in the cell that reads the result.
					release.resolve();
					await vi.waitFor(() => expect(session.getSteeringMessages()).toHaveLength(1));
					const read = await kernel.execute("handle.output()");
					expect(read.result).toContain("read-later");
					await vi.waitFor(() => expect(session.getSteeringMessages()).toEqual([]));
					return fauxAssistantMessage("Read the background result directly.");
				},
			]);
			await kernel.execute("from rlm import bash\nhandle = bash('printf read-later')");
			await notice.promise;
			await session.prompt("Keep working.");
			await session.waitForIdle();
			expect(
				session.messages.filter(
					(message) => message.role === "custom" && message.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
				),
			).toEqual([]);
			expect(harness!.eventsOfType("agent_start")).toHaveLength(1);
		} finally {
			release.resolve();
		}
	});

	it("reports a terminal readiness failure without retrying or retaining completed work", async () => {
		const beforeCompletion = vi.fn(async () => {});
		const { session, kernel } = await start(beforeCompletion, false);
		await kernel.execute("from rlm import bash\nhandle = bash('printf done')");
		await vi.waitFor(() => expect(beforeCompletion).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(kernel.hasBackgroundWork).toBe(false));
		expect(session.messages).toEqual([]);
		const nextCell = await kernel.execute("handle.poll().exit_code");
		expect(nextCell.result).toBe("0");
		expect(nextCell.backgroundOutput).toContain("was not accepted");
		expect(beforeCompletion).toHaveBeenCalledTimes(1);
	});

	it("holds residency until the completion follow-up is accepted", async () => {
		const reached = createDeferred<void>();
		const release = createDeferred<void>();
		try {
			const { session, kernel } = await start(async () => {
				reached.resolve();
				await release.promise;
			});
			await kernel.execute("from rlm import bash\nhandle = bash('sleep 600')");
			await kernel.execute("handle.kill()");
			await reached.promise;
			expect(session.messages).toEqual([]);
			expect(passivationAllowed(session)).toBe(false);
			harness!.setResponses([fauxAssistantMessage("Completion accepted.")]);
			release.resolve();
			await vi.waitFor(() => expect(session.getLastAssistantText()).toBe("Completion accepted."));
			await session.waitForIdle();
			await vi.waitFor(() => expect(passivationAllowed(session)).toBe(true));
		} finally {
			release.resolve();
		}
	});
});

describe("kernel bash activity validation", () => {
	it("ignores unrelated display data and rejects malformed or mismatched releases", async () => {
		const kernel = new ReplKernelManager({});
		const deliver = (data: Record<string, unknown>) =>
			(kernel as unknown as { handleEvent(event: Record<string, unknown>): void }).handleEvent({
				event: "display",
				id: "old-cell",
				data,
			});
		const activity = { id: "a".repeat(32), pid: 42, active: true };
		deliver({ [BASH_ACTIVITY_DISPLAY_MIME]: activity });
		expect(kernel.hasBackgroundWork).toBe(true);
		for (const invalid of [
			{ ...activity, pid: 0, active: false },
			{ ...activity, pid: -1, active: false },
			{ ...activity, pid: 42.5, active: false },
			{ ...activity, pid: 43, active: false },
			{ ...activity, id: "", active: false },
			{ ...activity, id: "b".repeat(32), active: false },
			{ ...activity, active: "false" },
		]) {
			deliver({ [BASH_ACTIVITY_DISPLAY_MIME]: invalid });
			expect(kernel.hasBackgroundWork).toBe(true);
		}
		deliver({ "application/json": { ...activity, active: false } });
		expect(kernel.hasBackgroundWork).toBe(true);
		deliver({ [BASH_ACTIVITY_DISPLAY_MIME]: { ...activity, active: false } });
		expect(kernel.hasBackgroundWork).toBe(false);
		await kernel.shutdown();
	});
});
