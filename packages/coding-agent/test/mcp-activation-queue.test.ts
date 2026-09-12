import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";

import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ActivationQueueThis = {
	connectionState: { isStreaming: boolean; isCompacting: boolean; messageCount: number };
	pendingPostRunActivation: { message: string; successMessage: string } | undefined;
	pulseTimer: ReturnType<typeof setInterval> | undefined;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	handleReloadCommand: ReturnType<typeof vi.fn>;
};

function createFakeMode(): ActivationQueueThis {
	const fake: ActivationQueueThis = {
		connectionState: { isStreaming: false, isCompacting: false, messageCount: 0 },
		pendingPostRunActivation: undefined,
		pulseTimer: undefined,
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		handleReloadCommand: vi.fn(async () => true),
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function callPrivate<TThis extends object, TResult>(name: string, self: TThis, ...args: unknown[]): TResult {
	const method = (InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => TResult>)[name];
	return method.apply(self, args);
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ENG-6108 MCP activation queue at safe boundaries", () => {
	let mode: ActivationQueueThis;

	beforeEach(() => {
		mode = createFakeMode();
	});

	test("queues a login made mid-stream and activates automatically at agent end — never says /reload", async () => {
		mode.connectionState.isStreaming = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");

		// Deferred: no reload yet, and the message must not tell the user to run /reload.
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();
		expect(mode.showStatus).toHaveBeenCalledWith(
			"Connected Notion. It will activate automatically when the current turn finishes.",
		);
		expect(JSON.stringify(mode.showStatus.mock.calls)).not.toContain("/reload");

		// The turn (including any in-flight tool call) ends: activation runs.
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(mode.showStatus).toHaveBeenCalledWith("Connected Notion.");
		expect(mode.pendingPostRunActivation).toBeUndefined();
	});

	test("activates at the compaction boundary when queued during compaction", async () => {
		mode.connectionState.isCompacting = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Linear.", "Connected Linear.");
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();

		callPrivate("updateConnectionStateFromEvent", mode, {
			type: "compaction_end",
		} as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	test("waits for both streaming and compaction to finish before activating", async () => {
		mode.connectionState.isStreaming = true;
		mode.connectionState.isCompacting = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");

		// Streaming ends but compaction still holds the boundary.
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();

		callPrivate("updateConnectionStateFromEvent", mode, {
			type: "compaction_end",
		} as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	test("keeps the change queued when the boundary reload fails, with an honest warning", async () => {
		mode.connectionState.isStreaming = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");
		mode.handleReloadCommand.mockResolvedValue(false);

		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(mode.showWarning).toHaveBeenCalledWith(
			"Connected Notion. The change remains saved, but it is not active in this session.",
		);
	});

	test("a queued activation runs once even if both boundaries fire", async () => {
		mode.connectionState.isStreaming = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		callPrivate("updateConnectionStateFromEvent", mode, {
			type: "compaction_end",
		} as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
	});
});

describe("ENG-6108 /plugins stdio server management", () => {
	type StdioThis = {
		ui: { requestRender: ReturnType<typeof vi.fn> };
		showStatus: ReturnType<typeof vi.fn>;
		showWarning: ReturnType<typeof vi.fn>;
		handleReloadCommand: ReturnType<typeof vi.fn>;
		settingsManager: {
			getGlobalMcpServers: ReturnType<typeof vi.fn>;
			setGlobalMcpServer: ReturnType<typeof vi.fn>;
			flush: ReturnType<typeof vi.fn>;
		};
		uiServices: { refreshMcpProviders: ReturnType<typeof vi.fn> };
	};

	function createStdioFake(servers: Record<string, unknown>): StdioThis {
		const fake: StdioThis = {
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			handleReloadCommand: vi.fn(async () => true),
			settingsManager: {
				getGlobalMcpServers: vi.fn(() => structuredClone(servers)),
				setGlobalMcpServer: vi.fn(),
				flush: vi.fn(async () => undefined),
			},
			uiServices: { refreshMcpProviders: vi.fn() },
		};
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		return fake;
	}

	test("Enter on a connected stdio user server disables it through settings — a real action, not a fake disconnect", async () => {
		const fake = createStdioFake({
			local: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
		});
		await callPrivate(
			"connectServiceFromPicker",
			fake,
			{ serviceId: "local", label: "Local" },
			{ usesOAuth: false, managedBySettings: true, transport: "stdio", name: "local" },
		);

		expect(fake.settingsManager.setGlobalMcpServer).toHaveBeenCalledWith(
			"local",
			{ type: "stdio", command: "npx", args: ["-y", "some-server"], enabled: false },
			true,
		);
		expect(fake.settingsManager.flush).toHaveBeenCalled();
		expect(fake.uiServices.refreshMcpProviders).toHaveBeenCalled();
		expect(fake.handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(fake.showStatus.mock.calls)).toContain("Disabled local server Local.");
	});

	test("Enter on an already-disabled stdio server reports the disabled state instead of acting again", async () => {
		const fake = createStdioFake({
			local: { type: "stdio", command: "npx", enabled: false },
		});
		await callPrivate(
			"connectServiceFromPicker",
			fake,
			{ serviceId: "local", label: "Local" },
			{ usesOAuth: false, managedBySettings: true, transport: "stdio", name: "local" },
		);
		expect(fake.settingsManager.setGlobalMcpServer).not.toHaveBeenCalled();
		expect(JSON.stringify(fake.showStatus.mock.calls)).toContain("disabled");
	});

	test("a vanished stdio settings entry reports it is gone", async () => {
		const fake = createStdioFake({});
		await callPrivate(
			"connectServiceFromPicker",
			fake,
			{ serviceId: "local", label: "Local" },
			{ usesOAuth: false, managedBySettings: true, transport: "stdio", name: "local" },
		);
		expect(fake.settingsManager.setGlobalMcpServer).not.toHaveBeenCalled();
		expect(JSON.stringify(fake.showStatus.mock.calls)).toContain("no longer present in settings");
	});
});

describe("ENG-6108 /plugins add-account flow", () => {
	test("adding an account allocates a new connection id, registers its provider, and records the catalog service id", async () => {
		resetOAuthProviders();
		const tempDir = mkdtempSync(join(tmpdir(), "addacct-"));
		const authStorage = AuthStorage.inMemory();
		const store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		// The first account exists: allocation must land on acme-2, not overwrite.
		const now = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			createdAt: now,
			updatedAt: now,
		});
		const runMcpLogin = vi.fn(async () => ({ status: "success" }) as const);
		const showStatus = vi.fn();
		const fake = {
			mcpConnectionStore: store,
			modelRegistry: { authStorage },
			createAuthFlows: () => ({ runMcpLogin }),
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning: vi.fn(),
			handleReloadCommand: vi.fn(async () => true),
		} as unknown as Record<string, unknown>;
		Object.setPrototypeOf(fake, InteractiveMode.prototype);

		const callAdd = (fake as unknown as { connectServiceFromPicker: (...args: unknown[]) => Promise<void> })
			.connectServiceFromPicker;
		await callAdd.call(
			fake,
			{ serviceId: "acme", label: "Acme", connectable: true, connectionIds: [], connectionStatus: "not_connected" },
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: "acme", addAccount: true },
		);

		// The second account got its OWN id, provider, and login target.
		expect(runMcpLogin).toHaveBeenCalledWith("acme-2", "Acme (acme-2)");
		expect(getOAuthProvider("mcp:acme-2")).toBeDefined();
		const record = store.get("acme-2");
		expect(record?.connectionId).toBe("acme-2");
		expect(record?.serviceId).toBe("acme");
		// The first account is untouched.
		expect(store.get("acme")?.status).toBe("connected");
		expect(JSON.stringify(showStatus.mock.calls)).toContain("acme-2");
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		resetOAuthProviders();
	});
});
