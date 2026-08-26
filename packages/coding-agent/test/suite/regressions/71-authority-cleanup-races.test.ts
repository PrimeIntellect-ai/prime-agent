import { spawn } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION,
	assertAgentRunKernelBoundaryScope,
	createAgentRunKernelBoundaryScope,
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
});
