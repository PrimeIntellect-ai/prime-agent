import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { createTestResourceLoader } from "./utilities.js";

const MODEL = getModel("anthropic", "claude-sonnet-4-5")!;

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
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
	};
}

describe("AgentSession kernel lifecycle", () => {
	let tempDir = "";
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-agent-session-kernel-${process.pid}-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model: MODEL, systemPrompt: "", tools: [] },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage() }));
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			prewarmIpythonKernel: true,
		});
		return session;
	}

	it("does not prewarm before a workflow host loader supplies identity", async () => {
		const prewarm = vi.spyOn(IpythonKernelProvisioner.prototype, "prewarm").mockImplementation(() => {});
		createSession().setWorkflowHostLoader(async () => {});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(prewarm).not.toHaveBeenCalled();
	});

	it("keeps generic sessions eligible for deferred prewarm", async () => {
		const prewarm = vi.spyOn(IpythonKernelProvisioner.prototype, "prewarm").mockImplementation(() => {});
		createSession();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(prewarm).toHaveBeenCalledTimes(1);
	});

	it("does not persist or publish a workflow terminal when kernel fencing fails", async () => {
		vi.spyOn(IpythonKernelProvisioner.prototype, "prewarm").mockImplementation(() => {});
		const order: string[] = [];
		const cleanupFailure = Object.assign(new Error("container removal failed"), {
			code: "KERNEL_CONTAINER_CLEANUP_FAILED",
		});
		const child = {
			_workflowTaskBinding: {},
			_recordWorkflowTaskTerminal: vi.fn(() => order.push("record")),
			_fenceTerminalTaskKernel: vi.fn(async () => {
				order.push("fence");
				throw cleanupFailure;
			}),
		};
		const run = {
			status: "running",
			error: undefined,
			publication: { reject: vi.fn() },
			abort: vi.fn(() => order.push("abort")),
			emitUpdate: vi.fn(() => order.push("publish")),
			session: child,
		};
		const internal = createSession() as unknown as {
			_cancelRlmChildRun: (value: typeof run, reason: string) => boolean;
		};

		expect(internal._cancelRlmChildRun(run, "task_deadline_expired")).toBe(true);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(order).toEqual(["fence", "abort"]);
		expect(child._recordWorkflowTaskTerminal).not.toHaveBeenCalled();
		expect(run.emitUpdate).not.toHaveBeenCalled();
		expect(run.status).toBe("error");
		expect(run.error).toMatch(/KERNEL_CONTAINER_CLEANUP_FAILED|container removal failed/);
	});
});
