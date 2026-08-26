import { spawn } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
	assertAgentRunKernelBoundaryScope,
	createAgentRunKernelBoundaryScope,
	prepareAgentRunKernelBoundary,
	revokeAgentRunKernelBoundaryScope,
} from "../../../src/core/run-kernel-boundary.js";
import {
	AGENT_RUN_MODEL_SCOPE_VERSION,
	assertAgentRunModelScope,
	createAgentRunModelScope,
} from "../../../src/core/run-model-scope.js";
import {
	AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
	assertAgentRunToolAuthorityScope,
	createAgentRunToolAuthorityScope,
} from "../../../src/core/run-tool-authority.js";
import { createHarness, type Harness } from "../harness.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("issue 71 authority cleanup races", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("fences a blocked rlm.run resolution to its exact aborted parent execution", async () => {
		const nameResolutionStarted = deferred();
		const releaseNameResolution = deferred();
		const createChildRuntime = vi.fn(async () => {
			throw new Error("stale host request must not create a child runtime");
		});
		const harness = await createHarness({
			api: "faux-run-abort-race",
			provider: "native-abort-race",
			rlmMaxDepth: 1,
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				assertSessionNameAvailable: async () => {
					nameResolutionStarted.resolve();
					await releaseNameResolution.promise;
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected agent message");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: createChildRuntime,
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const modelScope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [{ model, access: { kind: "secret", contract: "secret@1", apiKey: "scoped-key" } }],
		});
		const toolScope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			authorize: () => ({ decision: "allow" }),
		});
		const kernelScope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:rlm-abort-race",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch: (request) =>
					spawn(request.command, [...request.args], {
						cwd: request.cwd,
						env: { ...request.env },
						stdio: ["ignore", "pipe", "pipe"],
					}),
				dispose: () => {},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: 'await rlm("blocked child", name="blocked-child")' }), {
				stopReason: "toolUse",
			}),
		]);

		const run = harness.session.promptAndWait("spawn then abort", {
			modelScope,
			toolAuthorityScope: toolScope,
			kernelBoundaryScope: kernelScope,
		});
		await nameResolutionStarted.promise;
		const abort = harness.session.abort();
		releaseNameResolution.resolve();
		await abort;
		await Promise.allSettled([run]);

		expect(createChildRuntime).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(() => assertAgentRunModelScope(modelScope)).toThrow("revoked");
		expect(() => assertAgentRunToolAuthorityScope(toolScope)).toThrow("revoked");
		expect(() => assertAgentRunKernelBoundaryScope(kernelScope)).toThrow("revoked");
	});

	it("awaits authority revocation when a scoped queued prompt loses admission to a pause", async () => {
		const rootStarted = deferred();
		const releaseRoot = deferred();
		const harness = await createHarness({ api: "faux-run-pause-race", provider: "native-pause-race" });
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				rootStarted.resolve();
				await releaseRoot.promise;
				return fauxAssistantMessage("root done");
			},
		]);
		const root = harness.session.promptAndWait("hold root");
		await rootStarted.promise;
		const pause = harness.session.acquireSessionInputPause();
		const model = harness.getModel();
		const modelScope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [{ model, access: { kind: "secret", contract: "secret@1", apiKey: "queued-key" } }],
		});
		const toolScope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			authorize: () => ({ decision: "allow" }),
		});
		let kernelPrepared = 0;
		const kernelScope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:paused-queued-prompt",
				network: "enabled",
				reviewerMode: "ask",
			},
			prepare: () => {
				kernelPrepared += 1;
				throw new Error("paused prompt must not prepare a kernel");
			},
		});

		await expect(
			harness.session.prompt("scoped queued prompt", {
				streamingBehavior: "followUp",
				modelScope,
				toolAuthorityScope: toolScope,
				kernelBoundaryScope: kernelScope,
			}),
		).rejects.toThrow("session input admission is paused");

		expect(kernelPrepared).toBe(0);
		expect(() => assertAgentRunModelScope(modelScope)).toThrow("revoked");
		expect(() => assertAgentRunToolAuthorityScope(toolScope)).toThrow("revoked");
		expect(() => assertAgentRunKernelBoundaryScope(kernelScope)).toThrow("revoked");
		pause.release();
		releaseRoot.resolve();
		await root;
	});

	it("awaits scoped authority revocation before reporting a coalesced prompt rejection", async () => {
		const rootStarted = deferred();
		const releaseRoot = deferred();
		const harness = await createHarness({ api: "faux-run-coalesce-race", provider: "native-coalesce-race" });
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				rootStarted.resolve();
				await releaseRoot.promise;
				return fauxAssistantMessage("root done");
			},
			fauxAssistantMessage("queued owner done"),
		]);
		const root = harness.session.promptAndWait("hold root");
		await rootStarted.promise;
		await harness.session.prompt("coalescing owner", {
			streamingBehavior: "followUp",
			followUpQueueKey: "same-follow-up",
		});
		const model = harness.getModel();
		const modelScope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [{ model, access: { kind: "secret", contract: "secret@1", apiKey: "coalesced-key" } }],
		});

		await expect(
			harness.session.prompt("coalesced scoped prompt", {
				streamingBehavior: "followUp",
				followUpQueueKey: "same-follow-up",
				modelScope,
			}),
		).resolves.toBeUndefined();
		expect(() => assertAgentRunModelScope(modelScope)).toThrow("revoked");

		releaseRoot.resolve();
		await root;
		await harness.session.waitForIdle();
	});

	it("revokes every supplied capability when a slash command fails before action construction", async () => {
		const harness = await createHarness({ api: "openai-completions", provider: "slash-authority" });
		harnesses.push(harness);
		const model = harness.getModel();
		const modelScope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [{ model, access: { kind: "secret", contract: "secret@1", apiKey: "slash-key" } }],
		});
		const toolScope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			authorize: () => ({ decision: "allow" }),
		});
		const kernelScope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:slash-command",
				network: "enabled",
				reviewerMode: "ask",
			},
			prepare: () => {
				throw new Error("slash command must not initialize a boundary");
			},
		});

		await expect(
			harness.session.prompt("/compact", {
				modelScope,
				toolAuthorityScope: toolScope,
				kernelBoundaryScope: kernelScope,
			}),
		).rejects.toThrow("Scoped model runs accept prompts only");

		expect(() => assertAgentRunModelScope(modelScope)).toThrow("revoked");
		expect(() => assertAgentRunToolAuthorityScope(toolScope)).toThrow("revoked");
		expect(() => assertAgentRunKernelBoundaryScope(kernelScope)).toThrow("revoked");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("does not let a deferred retry call the provider after its exact run is aborted", async () => {
		const retryContinuationStarted = deferred();
		const releaseRetryContinuation = deferred();
		const harness = await createHarness({
			api: "openai-completions",
			provider: "retry-authority",
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const originalContinue = harness.session.agent.continue.bind(harness.session.agent);
		vi.spyOn(harness.session.agent, "continue").mockImplementation(async (options) => {
			retryContinuationStarted.resolve();
			await releaseRetryContinuation.promise;
			return originalContinue(options);
		});
		const model = harness.getModel();
		const modelScope = createAgentRunModelScope({
			version: AGENT_RUN_MODEL_SCOPE_VERSION,
			root: model,
			models: [model],
			requestAccess: [{ model, access: { kind: "secret", contract: "secret@1", apiKey: "retry-key" } }],
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "temporary provider failure" }),
			fauxAssistantMessage("stale retry must not be sent"),
		]);

		const run = harness.session.prompt("retry then abort", { modelScope });
		await retryContinuationStarted.promise;
		const abort = harness.session.abort();
		releaseRetryContinuation.resolve();
		await abort;
		await Promise.allSettled([run]);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(harness.faux.state.callCount).toBe(1);
		expect(() => assertAgentRunModelScope(modelScope)).toThrow("revoked");
	});

	it("does not resolve disposeAsync until cancelled run-scope cleanup finishes", async () => {
		const requestStarted = deferred();
		const cleanupStarted = deferred();
		const releaseCleanup = deferred();
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const kernelScope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:dispose-cleanup-gate",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch: (request) =>
					spawn(request.command, [...request.args], {
						cwd: request.cwd,
						env: { ...request.env },
						stdio: ["ignore", "pipe", "pipe"],
					}),
				dispose: async () => {
					cleanupStarted.resolve();
					await releaseCleanup.promise;
				},
			}),
		});
		harness.setResponses([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					requestStarted.resolve();
					const abort = () => reject(options?.signal?.reason ?? new Error("cancelled"));
					options?.signal?.addEventListener("abort", abort, { once: true });
					if (options?.signal?.aborted) abort();
				}),
		]);

		const run = harness.session.prompt("bounded run", { kernelBoundaryScope: kernelScope });
		await requestStarted.promise;
		harness.session.requestAbort();
		await cleanupStarted.promise;
		let disposalSettled = false;
		const disposal = harness.session.disposeAsync().then(() => {
			disposalSettled = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(disposalSettled).toBe(false);

		releaseCleanup.resolve();
		await Promise.all([run.catch(() => undefined), disposal]);
		expect(disposalSettled).toBe(true);
	});

	it("rejects disposeAsync after waiting for failed run-scope cleanup", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const kernelScope = createAgentRunKernelBoundaryScope({
			version: AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
			policy: {
				filesystem: "workspace-write",
				workspaceRoot: harness.tempDir,
				workspaceScopeDigest: "sha256:dispose-cleanup-failure",
				network: "enabled",
				reviewerMode: "automatic",
			},
			prepare: () => ({
				launch: () => {
					throw new Error("not launched");
				},
				dispose: () => {
					throw new Error("confinement cleanup stayed unavailable");
				},
			}),
		});
		await prepareAgentRunKernelBoundary(kernelScope, {
			executionId: "dispose-cleanup-failure",
			sessionId: harness.session.sessionId,
			recursionDepth: 0,
			cwd: harness.tempDir,
			signal: new AbortController().signal,
		});
		const cleanup = revokeAgentRunKernelBoundaryScope(kernelScope, "session disposed");
		const trackCleanup = (
			harness.session as unknown as {
				_trackRunScopeCleanupOperation(operation: Promise<void>): Promise<void>;
			}
		)._trackRunScopeCleanupOperation.bind(harness.session);
		void trackCleanup(cleanup).catch(() => undefined);

		await expect(harness.session.disposeAsync()).rejects.toThrow(
			"Agent run scope cleanup failed during session disposal",
		);
	});

	it("gives concurrent disposeAsync callers the same terminal cleanup failure", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		let rejectCleanup!: (error: Error) => void;
		const cleanup = new Promise<void>((_resolve, reject) => {
			rejectCleanup = reject;
		});
		const sessionInternals = harness.session as unknown as {
			_disposed: boolean;
			_trackRunScopeCleanupOperation(operation: Promise<void>): Promise<void>;
		};
		void sessionInternals._trackRunScopeCleanupOperation(cleanup).catch(() => undefined);

		const firstDisposal = harness.session.disposeAsync();
		await vi.waitFor(() => expect(sessionInternals._disposed).toBe(true));
		const concurrentDisposal = harness.session.disposeAsync();
		rejectCleanup(new Error("terminal cleanup debt"));

		const results = await Promise.allSettled([firstDisposal, concurrentDisposal]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		const [first, second] = results as [PromiseRejectedResult, PromiseRejectedResult];
		expect(first.reason).toBe(second.reason);
		expect(first.reason).toMatchObject({
			message: "Agent run scope cleanup failed during session disposal",
		});
	});
});
