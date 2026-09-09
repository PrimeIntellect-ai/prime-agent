import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { TelemetryClient } from "../src/core/telemetry.js";
import { reportTelemetryError, reportTelemetryLogEntry } from "../src/core/telemetry-errors.js";
import { runDaemonCatalogProcess } from "../src/modes/daemon/daemon-catalog-process.js";

describe("daemon catalog startup telemetry", () => {
	let directory: string;
	let agentDir: string;
	let cwd: string;
	let capture: MockInstance<TelemetryClient["capture"]>;
	let flush: MockInstance<TelemetryClient["flush"]>;
	let on: MockInstance<typeof process.on>;
	let previousSend: PropertyDescriptor | undefined;
	const send = vi.fn<(message: unknown) => boolean>();

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "prime-catalog-telemetry-"));
		agentDir = join(directory, "agent");
		cwd = join(directory, "project");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		for (const name of ["PI_OFFLINE", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY"]) vi.stubEnv(name, "");
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		on = vi.spyOn(process, "on").mockReturnValue(process);
		capture = vi.spyOn(TelemetryClient.prototype, "capture").mockImplementation(() => {});
		flush = vi.spyOn(TelemetryClient.prototype, "flush").mockResolvedValue(undefined);
		previousSend = Object.getOwnPropertyDescriptor(process, "send");
		send.mockReset().mockReturnValue(true);
		Object.defineProperty(process, "send", { configurable: true, writable: true, value: send });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (previousSend) Object.defineProperty(process, "send", previousSend);
		else delete process.send;
		rmSync(directory, { recursive: true, force: true });
	});

	function failStartup(error: Error): Promise<never> {
		send.mockImplementationOnce(() => {
			throw error;
		});
		return runDaemonCatalogProcess();
	}

	it("reports bootstrap failures with effective settings and a bounded flush before rethrowing", async () => {
		const createSettings = vi.spyOn(SettingsManager, "create");
		const failure = Object.assign(
			new Error("Catalog pipe failed: PROMPT_CANARY. Authorization: Bearer catalog-secret"),
			{
				code: "EPIPE",
			},
		);
		await expect(failStartup(failure)).rejects.toBe(failure);
		expect(createSettings).toHaveBeenCalledWith(cwd, agentDir);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(capture).toHaveBeenCalledWith(
			"agent error",
			expect.objectContaining({
				component: "daemon",
				operation: "startup",
				stage: "startup",
				error_code_group: "EPIPE",
				error_message: "The connection was closed while writing.",
				error_message_id: "system_broken_pipe",
				error_message_source: "system_template",
			}),
		);
		expect(JSON.stringify(capture.mock.calls)).not.toContain("catalog-secret");
		expect(JSON.stringify(capture.mock.calls)).not.toContain("PROMPT_CANARY");
		expect(flush).toHaveBeenCalledWith({ timeoutMs: 1_500 });
		expect(
			reportTelemetryError({ error: new Error("later failure"), component: "daemon", operation: "execute" }),
		).toBeUndefined();
		expect(capture).toHaveBeenCalledTimes(1);
	});

	it.each(["global", "project"])("honors %s opt-out without creating identity or flushing", async (scope) => {
		writeFileSync(
			join(scope === "global" ? agentDir : join(cwd, CONFIG_DIR_NAME), "settings.json"),
			JSON.stringify({ telemetry: { enabled: false } }),
		);
		const failure = new Error("startup failed");
		await expect(failStartup(failure)).rejects.toBe(failure);
		expect(capture).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
	});

	it.each(["PI_OFFLINE", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY"])("honors inherited %s opt-out", async (name) => {
		vi.stubEnv(name, name === "PRIME_AGENT_TELEMETRY" ? "0" : "1");
		const failure = new Error("startup failed");
		await expect(failStartup(failure)).rejects.toBe(failure);
		expect(capture).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
	});

	it("skips reporting when settings cannot establish consent", async () => {
		writeFileSync(join(agentDir, "settings.json"), "invalid json");
		const failure = new Error("startup failed");
		await expect(failStartup(failure)).rejects.toBe(failure);
		expect(capture).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});

	it("preserves the original startup failure when delivery fails", async () => {
		flush.mockRejectedValueOnce(new Error("telemetry unavailable"));
		const failure = new Error("startup failed");
		await expect(failStartup(failure)).rejects.toBe(failure);
		expect(flush).toHaveBeenCalledWith({ timeoutMs: 1_500 });
	});

	it("preserves the original startup failure when loading its reporting context throws", async () => {
		vi.spyOn(SettingsManager, "create").mockImplementationOnce(() => {
			throw new Error("settings unavailable");
		});
		const failure = new Error("startup failed");
		await expect(failStartup(failure)).rejects.toBe(failure);
		expect(capture).not.toHaveBeenCalled();
	});

	it("starts without loading consent or reporting unrelated catalog request errors", async () => {
		const createSettings = vi.spyOn(SettingsManager, "create");
		const list = vi.spyOn(SessionManager, "list").mockImplementationOnce(async () => {
			reportTelemetryLogEntry({
				ts: "private-time",
				level: "error",
				component: "coding-agent.daemon",
				msg: "Project request failed",
			});
			throw new Error("request failed");
		});
		void runDaemonCatalogProcess();
		expect(send).toHaveBeenCalledWith({ type: "ready" });
		const messageHandler = on.mock.calls.find(([event]) => event === "message")?.[1];
		expect(messageHandler).toBeTypeOf("function");
		messageHandler?.({ type: "request", id: "private-request-id", command: "list", cwd: "/other-project" });
		await Promise.resolve();
		expect(list).toHaveBeenCalledWith("/other-project", undefined, expect.any(Object));
		expect(send).toHaveBeenCalledWith({
			type: "response",
			id: "private-request-id",
			success: false,
			error: "request failed",
		});
		expect(createSettings).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});
});
