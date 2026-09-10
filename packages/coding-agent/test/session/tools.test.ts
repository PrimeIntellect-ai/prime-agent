import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, type KernelClient } from "../../src/core/kernel/index.js";
import { IpythonKernelProvisioner } from "../../src/core/tools/ipython.js";
import { SessionTools, type SessionToolsHost } from "../../src/session/tools/tools.js";

describe("SessionTools ACP release", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["ok", "error"])(
		"reads the replacement kernel after queued work and releases input on %s",
		async (status) => {
			const idle = createDeferred<void>();
			const events = createDeferred<void>();
			const sequence: string[] = [];
			const previous = new IpythonKernelProvisioner("/workspace");
			const current = new IpythonKernelProvisioner("/workspace");
			let provisioner = previous;
			const oldManager = vi.spyOn(previous, "manager", "get");
			const execute = vi.fn(async (_code: string) => {
				sequence.push("execute");
				return { status, stderr: "close failed" };
			});
			vi.spyOn(current, "manager", "get").mockReturnValue({ isRunning: true, execute } as unknown as KernelClient);
			const host: SessionToolsHost = {
				cwd: "/workspace",
				resourceLoader: {
					getSystemPrompt: () => undefined,
					getAppendSystemPrompt: () => [],
					getAgentsFiles: () => ({ agentsFiles: [] }),
				},
				getExtensionRunner: () => {
					throw new Error("unchanged registry should not rebind extensions");
				},
				getSessionFile: () => undefined,
				getModelVisibleSkills: () => [],
				getDepth: () => 0,
				getMaxDepth: () => 3,
				getParentAgent: () => undefined,
				getMcpManager: () => ({
					getAcpServers: () => [],
					getEnabledPersistentGenericServers: () => [],
					canReleaseAcpServers: () => true,
					replaceAcpServers: () => false,
				}),
				getProvisioner: () => provisioner,
				getActiveToolNames: () => [],
				setActiveToolsByName: () => {},
				getActiveTools: () => [],
				setActiveTools: () => {},
				setSystemPrompt: () => {},
				isStreaming: () => false,
				rebuildRuntime: () => {
					throw new Error("release must preserve the live notebook");
				},
				acquireInputPause: () => {
					sequence.push("pause");
					return {
						release: () => {
							sequence.push("release");
						},
					};
				},
				waitForAgentIdle: () => {
					sequence.push("idle");
					return idle.promise;
				},
				getEventQueue: () => {
					sequence.push("events");
					return events.promise;
				},
			};
			const tools = new SessionTools(host, {});
			const release = tools.releaseAcpMcpServers("owner", ["server", "server"]);
			expect(sequence).toEqual(["pause", "idle"]);
			provisioner = current;
			idle.resolve();
			await Promise.resolve();
			expect(sequence).toEqual(["pause", "idle", "events"]);
			expect(execute).not.toHaveBeenCalled();
			events.resolve();
			if (status === "error") await expect(release).rejects.toThrow("close failed");
			else await release;
			expect(oldManager).not.toHaveBeenCalled();
			expect(sequence).toEqual(["pause", "idle", "events", "execute", "release"]);
			expect(execute).toHaveBeenCalledOnce();
			expect(execute.mock.calls[0]![0]).toContain('_prime_mcp_names = ["server"]');
		},
	);
});
