import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentTraceUploadAllResult, AgentTraceUploadResult } from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface TracesCommandContext {
	traceUploadAllAbortController?: AbortController;
	agentConnection: { getState: () => Promise<{ sessionDir?: string }> };
	settingsManager: {
		getAgentTracesEnabled: () => boolean;
		setAgentTracesEnabled: (enabled: boolean) => void;
		flush: () => Promise<void>;
	};
	modelRegistry: { authStorage: AuthStorage };
	previewCurrentTrace: () => Promise<void>;
	uploadCurrentTraceOnce: () => Promise<AgentTraceUploadResult>;
	uploadAllTraces: (sessionDir?: string, signal?: AbortSignal) => Promise<AgentTraceUploadAllResult>;
	formatTraceUploadResult: (result: AgentTraceUploadResult) => string;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
}

interface TracesCommandPrototype {
	handleTracesCommand(this: TracesCommandContext, text: string): Promise<void>;
	getTracesArgumentCompletions(prefix: string): AutocompleteItem[] | null;
}

const prototype = InteractiveMode.prototype as unknown as TracesCommandPrototype;

function makeContext(enabled = true): TracesCommandContext {
	return {
		agentConnection: { getState: vi.fn(async () => ({ sessionDir: "/custom/sessions" })) },
		settingsManager: {
			getAgentTracesEnabled: () => enabled,
			setAgentTracesEnabled: vi.fn(),
			flush: vi.fn(async () => {}),
		},
		modelRegistry: {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
		},
		previewCurrentTrace: vi.fn(async () => {}),
		uploadCurrentTraceOnce: vi.fn(
			async (): Promise<AgentTraceUploadResult> => ({
				status: "uploaded",
				sessionId: "current",
				traceId: "current",
				bytesStored: 12,
			}),
		),
		uploadAllTraces: vi.fn(
			async (): Promise<AgentTraceUploadAllResult> => ({
				total: 2,
				uploaded: 2,
				failed: 0,
				skipped: 0,
				bytesStored: 24,
				results: [],
			}),
		),
		formatTraceUploadResult: vi.fn(() => "Trace uploaded (12 bytes)."),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	};
}

describe("InteractiveMode /traces", () => {
	it("previews without enabling trace sharing", async () => {
		const context = makeContext(false);

		await prototype.handleTracesCommand.call(context, "/traces preview");

		expect(context.previewCurrentTrace).toHaveBeenCalledOnce();
		expect(context.uploadCurrentTraceOnce).not.toHaveBeenCalled();
		expect(context.uploadAllTraces).not.toHaveBeenCalled();
	});

	it.each(["/traces upload", "/traces upload-current"])("uploads only the current trace for %s", async (command) => {
		const context = makeContext(false);

		await prototype.handleTracesCommand.call(context, command);

		expect(context.uploadCurrentTraceOnce).toHaveBeenCalledOnce();
		expect(context.uploadAllTraces).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Trace uploaded (12 bytes).");
	});

	it.each(["no_session_file", "empty_session"] as const)(
		"keeps future upload guidance when enabling from %s",
		async (status) => {
			const context = makeContext(false);
			vi.mocked(context.uploadCurrentTraceOnce).mockResolvedValue({ status });

			await prototype.handleTracesCommand.call(context, "/traces on");

			expect(context.settingsManager.setAgentTracesEnabled).toHaveBeenCalledWith(true);
			expect(context.showStatus).toHaveBeenCalledWith(
				"Trace sharing enabled. Current session will upload after the first assistant response.",
			);
		},
	);

	it("backfills all discovered traces only for upload-all", async () => {
		const context = makeContext(false);

		await prototype.handleTracesCommand.call(context, "/traces upload-all");

		expect(context.uploadAllTraces).toHaveBeenCalledWith("/custom/sessions", expect.any(AbortSignal));
		expect(context.uploadCurrentTraceOnce).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Uploaded 2 of 2 traces; 24 bytes stored.");
	});

	it("reports a cancelled upload-all without a success summary", async () => {
		const context = makeContext(false);
		vi.mocked(context.uploadAllTraces).mockImplementation(async (_sessionDir, signal) => {
			return await new Promise<AgentTraceUploadAllResult>((resolve) => {
				signal?.addEventListener(
					"abort",
					() =>
						resolve({
							total: 2,
							uploaded: 0,
							failed: 0,
							skipped: 2,
							bytesStored: 0,
							results: [],
						}),
					{ once: true },
				);
			});
		});

		const command = prototype.handleTracesCommand.call(context, "/traces upload-all");
		await vi.waitFor(() => expect(context.traceUploadAllAbortController).toBeDefined());
		context.traceUploadAllAbortController?.abort();
		await command;

		expect(context.showStatus).toHaveBeenCalledWith("Trace upload cancelled.");
		expect(context.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Uploaded 0 of 2"));
		expect(context.traceUploadAllAbortController).toBeUndefined();
	});

	describe("argument autocomplete", () => {
		it("lists every subcommand for an empty prefix", () => {
			const items = prototype.getTracesArgumentCompletions("");

			expect(items?.map((item) => item.value)).toEqual([
				"status",
				"on",
				"off",
				"preview",
				"upload",
				"upload-current",
				"upload-all",
				"login",
			]);
			const statusItem = items?.find((item) => item.value === "status");
			expect(statusItem?.label).toBe("status");
			expect(statusItem?.description).toBe("Show trace sharing status");
		});

		it("filters subcommands by prefix", () => {
			const items = prototype.getTracesArgumentCompletions("up");

			expect(items?.map((item) => item.value)).toEqual(["upload", "upload-current", "upload-all"]);
		});

		it("matches a single subcommand exactly", () => {
			const items = prototype.getTracesArgumentCompletions("status");

			expect(items?.map((item) => item.value)).toEqual(["status"]);
		});

		it("filters case-insensitively", () => {
			const items = prototype.getTracesArgumentCompletions("LOGIN");

			expect(items?.map((item) => item.value)).toEqual(["login"]);
		});

		it("returns null for an unknown prefix", () => {
			const items = prototype.getTracesArgumentCompletions("xyz");

			expect(items).toBeNull();
		});
	});
});
