import { afterEach, describe, expect, it, vi } from "vitest";
import * as traces from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface TracesCommandContext {
	traceUploadAllAbortController?: AbortController;
	traceUploadAllRequestId?: string;
	agentConnection: { getState: () => Promise<{ sessionDir?: string; sessionFile?: string }> };
	settingsManager: SettingsManager;
	modelRegistry: { authStorage: AuthStorage };
	chatContainer: { addChild: (child: unknown) => void };
	ui: { requestRender: () => void };
	previewCurrentTrace: () => Promise<void>;
	uploadCurrentTraceOnce: (requireEnabled?: boolean) => Promise<traces.AgentTraceUploadResult>;
	uploadAllTraces: (sessionDir?: string, signal?: AbortSignal) => Promise<traces.AgentTraceUploadAllResult>;
	formatTraceUploadResult: (result: traces.AgentTraceUploadResult) => string;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
}
interface TracesCommandPrototype {
	handleTracesCommand(this: TracesCommandContext, text: string): Promise<void>;
}
const prototype = InteractiveMode.prototype as unknown as TracesCommandPrototype;
function makeContext(): TracesCommandContext {
	return {
		agentConnection: {
			getState: vi.fn(async () => ({ sessionDir: "/custom/sessions", sessionFile: "/custom/session.jsonl" })),
		},
		settingsManager: SettingsManager.inMemory(),
		modelRegistry: { authStorage: AuthStorage.inMemory() },
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		previewCurrentTrace: vi.fn(async () => {}),
		uploadCurrentTraceOnce: vi.fn(async () => ({ status: "queued" as const, requestId: "current" })),
		uploadAllTraces: vi.fn(async () => ({ status: "queued" as const, requestId: "batch" })),
		formatTraceUploadResult: vi.fn(() => "Trace queued for background delivery."),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	};
}
afterEach(() => vi.restoreAllMocks());
describe("InteractiveMode /traces", () => {
	it("previews without enabling or queueing", async () => {
		const context = makeContext();
		await prototype.handleTracesCommand.call(context, "/traces preview");
		expect(context.previewCurrentTrace).toHaveBeenCalledOnce();
		expect(context.uploadCurrentTraceOnce).not.toHaveBeenCalled();
		expect(context.settingsManager.getAgentTracesEnabled()).toBe(false);
	});
	it.each(["/traces upload", "/traces upload-current"])(
		"queues the current trace for %s without resolving credentials",
		async (command) => {
			const context = makeContext();
			const key = vi.spyOn(context.modelRegistry.authStorage, "getApiKey");
			await prototype.handleTracesCommand.call(context, command);
			expect(context.uploadCurrentTraceOnce).toHaveBeenCalledWith();
			expect(context.uploadAllTraces).not.toHaveBeenCalled();
			expect(context.showStatus).toHaveBeenCalledWith("Trace queued for background delivery.");
			expect(key).not.toHaveBeenCalled();
			expect(context.settingsManager.getAgentTracesEnabled()).toBe(false);
		},
	);
	it("enables only global automatic consent and retains the project opt-out", async () => {
		const context = makeContext();
		context.settingsManager = SettingsManager.fromStorage({
			withLock: (scope, fn) => {
				fn(JSON.stringify(scope === "project" ? { agentTraces: { enabled: false } } : {}));
			},
		});
		vi.mocked(context.uploadCurrentTraceOnce).mockResolvedValue({ status: "disabled" });
		await prototype.handleTracesCommand.call(context, "/traces on");
		expect(context.uploadCurrentTraceOnce).toHaveBeenCalledWith(true);
		expect(context.settingsManager.getAgentTracesEnabled()).toBe(false);
	});
	it.each(["no_session_file", "empty_session"] as const)(
		"keeps future guidance when enabling from %s",
		async (status) => {
			const context = makeContext();
			vi.mocked(context.uploadCurrentTraceOnce).mockResolvedValue({ status });
			await prototype.handleTracesCommand.call(context, "/traces on");
			expect(context.showStatus).toHaveBeenCalledWith(
				"Global automatic trace sharing enabled. Current session will queue after the first assistant response.",
			);
		},
	);
	it("queues bulk work promptly and keeps its cancellation handle after acknowledgement", async () => {
		const context = makeContext();
		await prototype.handleTracesCommand.call(context, "/traces upload-all");
		expect(context.uploadAllTraces).toHaveBeenCalledWith("/custom/sessions", expect.any(AbortSignal));
		expect(context.traceUploadAllRequestId).toBe("batch");
		expect(context.traceUploadAllAbortController).toBeDefined();
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("queued for background"));
		expect(context.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Uploaded"));
	});
	it("does not claim cancellation when this task has no request handle", async () => {
		const context = makeContext();
		await prototype.handleTracesCommand.call(context, "/traces cancel");
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("no bulk trace request"));
	});
	it("reports cancellation persistence errors without throwing or claiming success", async () => {
		const context = makeContext();
		context.traceUploadAllRequestId = "batch";
		vi.spyOn(traces, "cancelAgentTraceRequest").mockRejectedValue(new Error("read-only"));
		await prototype.handleTracesCommand.call(context, "/traces cancel");
		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("Could not record"));
		expect(context.showStatus).not.toHaveBeenCalled();
	});
	it("cancels persisted requests across tasks only for explicit cancel-all", async () => {
		const context = makeContext();
		const cancel = vi.spyOn(traces, "cancelPendingAgentTraceRequests").mockResolvedValue({ cancelled: 2, failed: 0 });
		await prototype.handleTracesCommand.call(context, "/traces cancel-all");
		expect(cancel).toHaveBeenCalledOnce();
		expect(context.showStatus).toHaveBeenCalledWith(
			expect.stringContaining("2 pending one-shot requests across tasks"),
		);
	});
	it("reads shared status with configuration inspection and no credential resolution", async () => {
		const context = makeContext();
		const status = vi.spyOn(traces, "readAgentTraceStatus").mockResolvedValue({
			consent: { enabled: false, reason: "global_off" },
			endpoint: "https://example.invalid",
			credentialSource: "Not configured",
			sessionFile: "/custom/session.jsonl",
			pending: 2,
			inProgress: 1,
			paused: 0,
			failed: 0,
			discovering: 0,
			currentSession: "queued",
			pauseReasons: [],
		});
		const credential = vi.spyOn(context.modelRegistry.authStorage, "getApiKey");
		await prototype.handleTracesCommand.call(context, "/traces status");
		expect(status).toHaveBeenCalledWith({
			settingsManager: context.settingsManager,
			authStorage: context.modelRegistry.authStorage,
			sessionFile: "/custom/session.jsonl",
		});
		expect(credential).not.toHaveBeenCalled();
		expect(context.uploadAllTraces).not.toHaveBeenCalled();
		expect(context.uploadCurrentTraceOnce).not.toHaveBeenCalled();
	});
});
