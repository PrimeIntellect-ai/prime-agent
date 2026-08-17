import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../src/config.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type DebugCommandContext = {
	ui: {
		terminal: { columns: number; rows: number };
		render: (width: number) => string[];
		requestRender: () => void;
	};
	agentConnection: {
		getMessages: () => Promise<AgentMessage[]>;
	};
	chatContainer: Container;
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	handleDebugCommand(this: DebugCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /debug", () => {
	let previousAgentDir: string | undefined;
	let tempAgentDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		previousAgentDir = process.env[ENV_AGENT_DIR];
		tempAgentDir = mkdtempSync(join(tmpdir(), "prime-agent-debug-test-"));
		process.env[ENV_AGENT_DIR] = tempAgentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		rmSync(tempAgentDir, { recursive: true, force: true });
	});

	it("writes debug messages from AgentConnection", async () => {
		const message: AgentMessage = { role: "user", content: "connection-owned message", timestamp: 1 };
		const context: DebugCommandContext = {
			ui: {
				terminal: { columns: 80, rows: 24 },
				render: vi.fn(() => ["rendered line"]),
				requestRender: vi.fn(),
			},
			agentConnection: { getMessages: vi.fn(async () => [message]) },
			chatContainer: new Container(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.handleDebugCommand.call(context);

		const debugLog = readFileSync(getDebugLogPath(), "utf8");
		expect(context.agentConnection.getMessages).toHaveBeenCalledWith();
		expect(debugLog).toContain("Terminal: 80x24");
		expect(debugLog).toContain("rendered line");
		expect(debugLog).toContain(JSON.stringify(message));
		expect(statSync(getDebugLogPath()).mode & 0o777).toBe(0o600);
		expect(statSync(tempAgentDir).mode & 0o777).toBe(0o700);
		expect(context.showError).not.toHaveBeenCalled();
		expect(context.ui.requestRender).toHaveBeenCalledWith();
	});

	it("refuses a symlinked debug log without modifying its target", async () => {
		const target = join(tempAgentDir, "outside.log");
		writeFileSync(target, "sentinel");
		symlinkSync(target, getDebugLogPath());
		const context: DebugCommandContext = {
			ui: {
				terminal: { columns: 80, rows: 24 },
				render: vi.fn(() => ["rendered line"]),
				requestRender: vi.fn(),
			},
			agentConnection: { getMessages: vi.fn(async () => []) },
			chatContainer: new Container(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.handleDebugCommand.call(context);

		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("non-regular private file"));
		expect(readFileSync(target, "utf8")).toBe("sentinel");
		expect(context.ui.requestRender).not.toHaveBeenCalled();
	});

	it("reports connection failures instead of falling back to local UI services", async () => {
		const context: DebugCommandContext = {
			ui: {
				terminal: { columns: 80, rows: 24 },
				render: vi.fn(() => ["rendered line"]),
				requestRender: vi.fn(),
			},
			agentConnection: {
				getMessages: vi.fn(async () => {
					throw new Error("connection unavailable");
				}),
			},
			chatContainer: new Container(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.handleDebugCommand.call(context);

		expect(context.showError).toHaveBeenCalledWith("Failed to write debug log: connection unavailable");
		expect(existsSync(getDebugLogPath())).toBe(false);
		expect(context.ui.requestRender).not.toHaveBeenCalled();
	});
});
