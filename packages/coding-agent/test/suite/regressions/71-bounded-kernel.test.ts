import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
	type AgentRunKernelBoundaryLifecycleEvent,
	createAgentRunKernelBoundaryScope,
	prepareAgentRunKernelBoundary,
	releaseAgentRunKernelBoundary,
	revokeAgentRunKernelBoundaryScope,
} from "../../../src/core/run-kernel-boundary.js";
import { createHarness } from "../harness.js";

describe("issue 71 bounded kernel", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("fails boundary initialization before the first provider request", async () => {
		let providerRequests = 0;
		const harness = await createHarness();
		harness.setResponses([
			() => {
				providerRequests += 1;
				throw new Error("provider must not be reached");
			},
		]);
		const scope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:test-workspace",
				network: "enabled",
				reviewerMode: "ask",
			},
			prepare: () => {
				throw new Error("sandbox unavailable");
			},
		});

		await expect(harness.session.promptAndWait("must fail closed", { kernelBoundaryScope: scope })).rejects.toThrow(
			"sandbox unavailable",
		);
		expect(providerRequests).toBe(0);
		harness.cleanup();
	});

	it("retains failed cleanup debt, retries it on revoke, and reports persistent failure", async () => {
		let disposeAttempts = 0;
		const events: AgentRunKernelBoundaryLifecycleEvent[] = [];
		const scope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: process.cwd(),
				workspaceScopeDigest: "sha256:cleanup-debt",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch: () => {
					throw new Error("not launched");
				},
				dispose: () => {
					disposeAttempts += 1;
					if (disposeAttempts === 1) throw new Error("transient cleanup failure");
				},
			}),
			observe: (event) => {
				events.push(event);
			},
		});
		const context = {
			executionId: "cleanup-debt",
			sessionId: "session",
			recursionDepth: 0,
			cwd: process.cwd(),
			signal: new AbortController().signal,
		};
		await prepareAgentRunKernelBoundary(scope, context);

		await expect(releaseAgentRunKernelBoundary(scope, context.executionId, "failed", "first")).rejects.toThrow(
			"Kernel boundary cleanup failed",
		);
		await expect(revokeAgentRunKernelBoundaryScope(scope, "retry")).resolves.toBeUndefined();

		expect(disposeAttempts).toBe(2);
		expect(events.filter((event) => event.phase === "terminal")).toMatchObject([
			{ cleanup: "failed" },
			{ cleanup: "completed" },
		]);

		const persistent = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: scope.policy,
			prepare: () => ({
				launch: () => {
					throw new Error("not launched");
				},
				dispose: () => {
					throw new Error("persistent cleanup failure");
				},
			}),
		});
		await prepareAgentRunKernelBoundary(persistent, { ...context, executionId: "persistent-debt" });
		await expect(revokeAgentRunKernelBoundaryScope(persistent, "persistent")).rejects.toThrow(
			"Kernel boundary revocation failed",
		);
	});

	it("uses the trusted launch boundary and awaits terminal confinement cleanup", async () => {
		const events: AgentRunKernelBoundaryLifecycleEvent[] = [];
		const launches: Array<{
			command: string;
			args: readonly string[];
			cwd: string | undefined;
			env: Readonly<Record<string, string | undefined>>;
		}> = [];
		let cleanupFinished = false;
		vi.stubEnv("PRIME_BOUNDARY_SENTINEL_SECRET", "must-not-reach-kernel");
		const harness = await createHarness();
		const scope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:test-workspace",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch(request) {
					launches.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env });
					return spawn(request.command, [...request.args], {
						cwd: request.cwd,
						env: { ...request.env },
						stdio: ["ignore", "pipe", "pipe"],
					});
				},
				async dispose() {
					await Promise.resolve();
					cleanupFinished = true;
				},
			}),
			observe(event) {
				events.push(event);
			},
		});

		harness.setResponses([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "bounded-ipython", name: "ipython", arguments: { code: "40 + 2" } }],
				api: "faux",
				provider: "faux",
				model: "faux-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "faux",
				provider: "faux",
				model: "faux-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		await harness.session.promptAndWait("run in boundary", { kernelBoundaryScope: scope });

		expect(launches).toHaveLength(1);
		expect(launches[0]).toMatchObject({ cwd: harness.tempDir });
		expect(launches[0]?.args.slice(0, 2)).toEqual(["-m", "ipykernel_launcher"]);
		expect(launches[0]?.env.PRIME_BOUNDARY_SENTINEL_SECRET).toBeUndefined();
		expect(cleanupFinished).toBe(true);
		expect(events.map((event) => event.phase)).toEqual(["initialized", "terminal"]);
		expect(events[0]).toMatchObject({
			phase: "initialized",
			policy: { network: "enabled", reviewerMode: "automatic" },
			context: { cwd: harness.tempDir, recursionDepth: 0 },
		});
		expect(events[1]).toMatchObject({ phase: "terminal", outcome: "completed", cleanup: "completed" });
		harness.cleanup();
	});

	it("keeps omitted Full runs unrestricted and never reuses their kernel state in a bounded run", async () => {
		const harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "full_only = 42" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("full done"),
		]);
		await harness.session.promptAndWait("full run");

		let boundedLaunches = 0;
		const scope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:fresh-workspace",
				network: "enabled",
				reviewerMode: "ask",
			},
			prepare: () => ({
				launch(request) {
					boundedLaunches += 1;
					return spawn(request.command, [...request.args], {
						cwd: request.cwd,
						env: { ...request.env },
						stdio: ["ignore", "pipe", "pipe"],
					});
				},
				dispose() {},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "assert 'full_only' not in globals()" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("bounded done"),
		]);
		await harness.session.promptAndWait("bounded run", { kernelBoundaryScope: scope });

		expect(boundedLaunches).toBe(1);
		harness.cleanup();
	});

	it("inherits fresh non-snapshot launch leases into recursive children", async () => {
		const initializedDepths: number[] = [];
		const terminalDepths: number[] = [];
		let launches = 0;
		let childFinished!: () => void;
		const childTerminal = new Promise<void>((resolve) => {
			childFinished = resolve;
		});
		const harness = await createHarness({ rlmMaxDepth: 1 });
		const scope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:recursive-workspace",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch(request) {
					launches += 1;
					return spawn(request.command, [...request.args], {
						cwd: request.cwd,
						env: { ...request.env },
						stdio: ["ignore", "pipe", "pipe"],
					});
				},
				dispose() {},
			}),
			observe(event) {
				if (event.phase === "initialized") initializedDepths.push(event.context.recursionDepth);
				else {
					terminalDepths.push(event.context.recursionDepth);
					if (event.context.recursionDepth === 1) childFinished();
				}
			},
		});
		const response = async (context: Context) => {
			const child = context.messages.some((message) => {
				if (typeof message.content === "string") return message.content.includes("[task from parent]");
				return message.content.some((part) => part.type === "text" && part.text.includes("[task from parent]"));
			});
			const hasToolResult = context.messages.some((message) => message.role === "toolResult");
			if (child && !hasToolResult) {
				return fauxAssistantMessage(fauxToolCall("ipython", { code: "assert 'parent_only' not in globals()" }), {
					stopReason: "toolUse",
				});
			}
			if (child) return fauxAssistantMessage("child done");
			if (!hasToolResult) {
				return fauxAssistantMessage(
					fauxToolCall("ipython", {
						code: 'parent_only = 1\nawait rlm("child task", name="bounded-child")',
					}),
					{ stopReason: "toolUse" },
				);
			}
			await childTerminal;
			return fauxAssistantMessage("root done");
		};
		harness.setResponses([response, response, response, response]);

		await harness.session.promptAndWait("spawn bounded child", { kernelBoundaryScope: scope });

		expect({ launches, initializedDepths, terminalDepths }).toEqual({
			launches: 2,
			initializedDepths: [0, 1],
			terminalDepths: [1, 0],
		});
		harness.cleanup();
	});

	it("still releases the host boundary and revokes the scope when kernel kill fails", async () => {
		let kernel: ReturnType<typeof spawn> | undefined;
		let disposed = false;
		const harness = await createHarness();
		const scope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:cleanup-failure",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch(request) {
					kernel = spawn(request.command, [...request.args], {
						cwd: request.cwd,
						env: { ...request.env },
						stdio: ["ignore", "pipe", "pipe"],
					});
					return kernel;
				},
				dispose() {
					disposed = true;
					kernel?.kill("SIGKILL");
				},
			}),
		});
		const response = (context: Context) => {
			const hasToolResult = context.messages.some((message) => message.role === "toolResult");
			if (!hasToolResult) {
				return fauxAssistantMessage(fauxToolCall("ipython", { code: "40 + 2" }), { stopReason: "toolUse" });
			}
			const provisioners = (
				harness.session as unknown as {
					_boundedKernelProvisioners: Map<string, { kill(): Promise<void> }>;
				}
			)._boundedKernelProvisioners;
			expect(provisioners.size).toBe(1);
			for (const provisioner of provisioners.values()) {
				provisioner.kill = async () => {
					throw new Error("injected kernel kill failure");
				};
			}
			return fauxAssistantMessage("done");
		};
		harness.setResponses([response, response]);

		await expect(harness.session.promptAndWait("cleanup failure", { kernelBoundaryScope: scope })).rejects.toThrow(
			"Agent run scope cleanup failed",
		);
		expect(disposed).toBe(true);
		await expect(harness.session.promptAndWait("cannot reuse", { kernelBoundaryScope: scope })).rejects.toThrow(
			"revoked",
		);
		harness.cleanup();
	});

	it("tears down the confined process group and its native descendants on cancellation", async () => {
		const harness = await createHarness();
		const marker = `${harness.tempDir}/descendant.pid`;
		let kernelPid: number | undefined;
		const terminal: AgentRunKernelBoundaryLifecycleEvent[] = [];
		const scope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:cancel-workspace",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch(request) {
					const child = spawn(request.command, [...request.args], {
						cwd: request.cwd,
						env: { ...request.env },
						stdio: ["ignore", "pipe", "pipe"],
						detached: true,
					});
					kernelPid = child.pid;
					return child;
				},
				dispose() {
					if (kernelPid === undefined) return;
					try {
						process.kill(-kernelPid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				},
			}),
			observe(event) {
				if (event.phase === "terminal") terminal.push(event);
			},
		});
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: [
						"import pathlib, subprocess, time",
						"descendant = subprocess.Popen(['sleep', '60'])",
						`pathlib.Path(${JSON.stringify(marker)}).write_text(str(descendant.pid))`,
						"time.sleep(60)",
					].join("\n"),
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const run = harness.session.promptAndWait("start cancellable descendant", { kernelBoundaryScope: scope });
		await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
		const descendantPid = Number(readFileSync(marker, "utf8"));

		await harness.session.abort();
		await Promise.allSettled([run]);
		await vi.waitFor(() => {
			expect(() => process.kill(descendantPid, 0)).toThrow();
		});
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({ phase: "terminal", outcome: "cancelled", cleanup: "completed" });
		harness.cleanup();
	});
});
