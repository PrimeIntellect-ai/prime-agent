import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotPathIn } from "../../src/core/kernel/state-snapshot.js";
import type { IpythonToolOptions } from "../../src/core/tools/ipython.js";
import { SessionKernel, type SessionKernelHost } from "../../src/session/kernel/kernel.js";
import { SessionKernel as KernelLifecycle } from "../../src/session/runtime/kernel-lifecycle.js";

const mocks = vi.hoisted(() => ({
	toolOptions: [] as Array<{ cwd: string; ipython: IpythonToolOptions | undefined }>,
	instances: [] as Array<{
		options: IpythonToolOptions;
		dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
		prewarm: ReturnType<typeof vi.fn<() => void>>;
	}>,
}));

vi.mock("../../src/kernel/provisioner.js", () => ({
	IpythonKernelProvisioner: class {
		dispose = vi.fn(async () => {});
		prewarm = vi.fn();
		constructor(
			_cwd: string,
			readonly options: IpythonToolOptions,
		) {
			mocks.instances.push(this);
		}
	},
}));
vi.mock("../../src/core/tools/index.js", () => ({
	createAllToolDefinitions: (cwd: string, options?: { ipython?: IpythonToolOptions }) => {
		mocks.toolOptions.push({ cwd, ipython: options?.ipython });
		return { ipython: { name: "ipython" } };
	},
}));

function createKernel(overrides: Partial<SessionKernelHost> = {}, prewarm = false) {
	const sendCustomMessage = vi.fn(async () => {});
	const host: SessionKernelHost = {
		cwd: "/workspace",
		getArtifactDir: () => undefined,
		getSessionId: () => "session",
		getEnv: () => ({}),
		getShellCommandPrefix: () => undefined,
		getShellPath: () => undefined,
		createHostHandlers: () => ({}),
		recordLateSentAgentMessage: () => {},
		getMessages: () => [],
		appendCustomMessageEntry: () => "entry",
		emit: () => {},
		sendCustomMessage,
		...overrides,
	};
	return { kernel: new SessionKernel(host, prewarm), host, sendCustomMessage };
}

describe("SessionKernel lifecycle", () => {
	const directories: string[] = [];
	beforeEach(() => {
		mocks.instances.length = 0;
		mocks.toolOptions.length = 0;
	});
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("preserves the legacy build result and shares its one provisioner through disposal", async () => {
		const recordLateSentAgentMessage = vi.fn();
		const { kernel } = createKernel({
			getShellCommandPrefix: () => "source ./env.sh",
			getShellPath: () => "/bin/bash",
			recordLateSentAgentMessage,
		});
		const tools = kernel.build([]);
		expect(Object.keys(tools)).toEqual(["ipython"]);
		expect(tools.ipython.name).toBe("ipython");
		expect(mocks.instances).toHaveLength(1);
		expect(mocks.toolOptions[0]).toMatchObject({
			cwd: "/workspace",
			ipython: { provisioner: kernel.provisioner, commandPrefix: "source ./env.sh", shellPath: "/bin/bash" },
		});
		const message = {
			id: "message",
			message: "done",
			deliveryStatus: "delivered" as const,
			target: { activeSessionId: "active", sessionId: "session" },
		};
		mocks.toolOptions[0]?.ipython?.onLateSentAgentMessage?.("cell", message);
		expect(recordLateSentAgentMessage).toHaveBeenCalledWith("cell", message);
		await kernel.dispose(true);
		expect(mocks.instances[0]!.dispose).toHaveBeenCalledExactlyOnceWith({ snapshot: true });
	});

	it("prepares the canonical lifecycle without assembling tool definitions", () => {
		const { host } = createKernel();
		const kernel = new KernelLifecycle(host, false);
		expect(kernel.prepare([])).toBe(kernel.provisioner);
		expect(mocks.instances).toHaveLength(1);
		expect(mocks.toolOptions).toHaveLength(0);
	});

	it("gates a replacement on the old snapshot flush and only announces a first-build restore", async () => {
		let finishDispose = () => {};
		const disposing = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		let sessionId = "first";
		let depth = "0";
		const { kernel, sendCustomMessage } = createKernel({
			getSessionId: () => sessionId,
			getEnv: () => ({ RLM_DEPTH: depth }),
		});
		kernel.build([]);
		kernel.finishBuild(["ipython"]);
		const first = mocks.instances[0]!;
		first.dispose.mockReturnValue(disposing);
		first.options.onRestore?.({ restored: ["value"], failed: [], path: "/snapshot" });
		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ display: true, details: { restored: true } }),
			{ deliverAs: "nextTurn" },
		);
		sessionId = "second";
		depth = "1";
		kernel.build([]);
		const second = mocks.instances[1]!;
		expect(first.dispose).toHaveBeenCalledOnce();
		expect(second.options.readyGate).toBe(disposing);
		expect(second.options.onRestore).toBeUndefined();
		expect(second.options).toMatchObject({ sessionId: "second", env: { RLM_DEPTH: "1" } });
		let ready = false;
		void second.options.readyGate?.then(() => {
			ready = true;
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		finishDispose();
		await second.options.readyGate;
		expect(ready).toBe(true);
	});

	it("prewarms resumed state only when ipython is active", () => {
		const directory = mkdtempSync(join(tmpdir(), "session-kernel-"));
		directories.push(directory);
		writeFileSync(snapshotPathIn(directory), "snapshot");
		const { kernel } = createKernel({ getArtifactDir: () => directory });
		kernel.build([]);
		kernel.finishBuild([]);
		expect(mocks.instances[0]!.prewarm).not.toHaveBeenCalled();
		kernel.build([]);
		kernel.finishBuild(["ipython"]);
		expect(mocks.instances[1]!.prewarm).toHaveBeenCalledOnce();
	});

	it("passes the teardown snapshot policy and tolerates failed startup cleanup", async () => {
		const { kernel } = createKernel({}, true);
		kernel.build([]);
		kernel.finishBuild(["ipython"]);
		const current = mocks.instances[0]!;
		expect(current.prewarm).toHaveBeenCalledOnce();
		current.dispose.mockRejectedValue(new Error("startup failed"));
		await expect(kernel.dispose(false)).resolves.toBeUndefined();
		expect(current.dispose).toHaveBeenCalledWith({ snapshot: false });
	});
});
