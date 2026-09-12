import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { writeFileAtomicSync } from "../src/utils/atomic-file.js";

// The atomic write is the seam for finalize write-failure regressions; every
// other test keeps the real implementation.
vi.mock("../src/utils/atomic-file.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/atomic-file.js")>();
	return { ...actual, writeFileAtomicSync: vi.fn(actual.writeFileAtomicSync) };
});

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

describe("ENG-6108 guarded credential commit", () => {
	function fakeWithStore(authStorageOverride?: AuthStorage) {
		const store = McpConnectionStore.open(join(mkdtempSync(join(tmpdir(), "guarded-")), "mcp-connections.json"));
		const authStorage = authStorageOverride ?? AuthStorage.inMemory();
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const fake = {
			mcpConnectionStore: store,
			modelRegistry: { authStorage },
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning,
			handleReloadCommand: vi.fn(async () => true),
			uiServices: { settingsManager: { getGlobalMcpServers: () => undefined } },
		} as unknown as Record<string, unknown>;
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		return { fake, store, authStorage, showStatus, showWarning };
	}

	const callAddAccount = (fake: Record<string, unknown>) =>
		(
			fake as unknown as {
				connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
			}
		).connectServiceFromPicker.call(
			fake,
			{
				serviceId: "acme",
				label: "Add another account",
				connectionStatus: "not_connected",
				connectionIds: [],
				connectable: true,
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: "acme", addAccount: true, knownIds: new Set(["acme"]) },
		);

	/** A login that writes the STAGED credential and runs `midFlight` first. */
	function stagedLogin(authStorage: AuthStorage, midFlight?: (stagedServerId: string) => void) {
		return vi.fn(async (serverId: string) => {
			midFlight?.(serverId);
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: `staged-for-${serverId}`,
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			return { status: "success" } as const;
		});
	}

	test("late login SUCCESS after the reservation was removed: the credential never lands and the account stays gone", async () => {
		const { fake, store, authStorage, showStatus } = fakeWithStore();
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: stagedLogin(authStorage, (stagedServerId) => {
				// Another client removes OUR pending reservation mid-login.
				const nonce = stagedServerId.split("--")[1];
				void store.removeReservation("acme-2", nonce);
			}),
		});
		await callAddAccount(fake);
		// The real account key NEVER received the late credential.
		expect(authStorage.get("mcp:acme-2")).toBeUndefined();
		// No staged leftovers and no resurrected record.
		expect(store.get("acme-2")).toBeUndefined();
		const stagedLeftovers = authStorage.list().filter((id) => id.startsWith("mcp:acme-2--"));
		expect(stagedLeftovers).toEqual([]);
		expect(JSON.stringify(showStatus.mock.calls)).toContain("removed or replaced during login");
	});

	test("a bystander written by ANOTHER client's ordinary login survives finalization (two real storage instances)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const clientB = AuthStorage.create(authPath);
		const { fake, store, showStatus } = fakeWithStore(clientA);
		const bystander = {
			type: "oauth" as const,
			access: "ordinary-login-for-acme-2",
			refresh: "r2",
			expires: Date.now() + 7200_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: stagedLogin(clientA, () => {
				// ANOTHER client's ordinary login writes the real account key
				// after our staging, before our finalize. Client A's per-instance
				// cache never sees it — only the on-disk conditional move under
				// the auth backend's own file lock can refuse the clobber.
				clientB.set("mcp:acme-2", bystander);
			}),
		});
		await callAddAccount(fake);
		// A fresh reader of the shared credential file sees the bystander
		// credential byte-for-byte — never our staged value.
		const fresh = AuthStorage.create(authPath);
		expect(fresh.get("mcp:acme-2")).toEqual(bystander);
		// Our staged credential was discarded, and no record resurrected.
		expect(fresh.list().filter((id) => id.startsWith("mcp:acme-2--"))).toEqual([]);
		expect(store.get("acme-2")).toBeUndefined();
		expect(JSON.stringify(showStatus.mock.calls)).toContain("discarded");
	});

	test("a generic /logout in another client after the finalize leaves an honest unbound record, never corruption", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const clientB = AuthStorage.create(authPath);
		const { fake, store } = fakeWithStore(clientA);
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: stagedLogin(clientA),
		});
		await callAddAccount(fake);
		// The finalize moved the staged credential onto the real key on disk.
		const fresh = AuthStorage.create(authPath);
		const realCredential = fresh.get("mcp:acme-2");
		expect(realCredential?.type).toBe("oauth");
		if (realCredential?.type === "oauth") {
			expect(realCredential.access).toContain("staged-for-");
		}
		expect(store.get("acme-2")).toBeDefined();
		// The generic /logout route removes the credential directly (the exact
		// authStorage.logout call runLogout makes). Last-writer-wins atomically
		// under the auth backend lock: the credential is gone, and the record
		// survives to show an honest unbound/Reconnect state — no corruption.
		clientB.logout("mcp:acme-2");
		expect(AuthStorage.create(authPath).get("mcp:acme-2")).toBeUndefined();
		expect(store.get("acme-2")).toBeDefined();
	});

	test("a removeAccount whose record write fails after the logout reports the honest partial state", async () => {
		const { fake, store, authStorage, showWarning, showStatus } = fakeWithStore();
		// A real record AND a real credential for the account.
		const at = Date.now();
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "connected",
			createdAt: at,
			updatedAt: at,
		});
		authStorage.set("mcp:acme-2", {
			type: "oauth",
			access: "real-for-acme-2",
			refresh: "r",
			expires: at + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		// Fail the FIRST store write: the removeAccount's record save.
		const actualModule =
			await vi.importActual<typeof import("../src/utils/atomic-file.js")>("../src/utils/atomic-file.js");
		const real = actualModule.writeFileAtomicSync;
		vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
			throw new Error("simulated remove write failure");
		});
		// Drive the REAL removeAction branch.
		await (
			fake as unknown as {
				connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
			}
		).connectServiceFromPicker.call(
			fake,
			{
				serviceId: "acme-2",
				label: "Acme (acme-2)",
				connectionStatus: "connected",
				connectable: false,
				removeAction: true,
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{},
		);
		vi.mocked(writeFileAtomicSync).mockImplementation(real);
		// The logout is PRESERVED (credential gone); the record survives on disk.
		expect(authStorage.get("mcp:acme-2")).toBeUndefined();
		expect(store.get("acme-2")).toBeDefined();
		// The wording reports the honest partial state and never claims the
		// account is still connected.
		const calls = JSON.stringify([...showWarning.mock.calls, ...showStatus.mock.calls]);
		expect(calls).toContain("Logged out account acme-2");
		expect(calls).toContain("could not be saved");
		expect(calls).toContain("try again to finish cleanup");
		expect(calls).not.toContain("still connected");
	});

	test("a finalize whose record write fails: credentials restored to staged, account key untouched, reservation released, honest message", async () => {
		const { fake, store, authStorage, showStatus } = fakeWithStore();
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: stagedLogin(authStorage),
		});
		// Fail exactly the SECOND atomic write: the reserve commit succeeds; the
		// finalize's record write fails, so its compensation must run.
		const actualModule =
			await vi.importActual<typeof import("../src/utils/atomic-file.js")>("../src/utils/atomic-file.js");
		const real = actualModule.writeFileAtomicSync;
		let writeCount = 0;
		vi.mocked(writeFileAtomicSync).mockImplementation((...args: Parameters<typeof real>) => {
			writeCount += 1;
			if (writeCount === 2) {
				throw new Error("simulated finalize write failure");
			}
			return real(...args);
		});
		try {
			await callAddAccount(fake);
			// All-or-nothing: the REAL account key never received the credential...
			expect(authStorage.get("mcp:acme-2")).toBeUndefined();
			// ...the staged credential was compensated then discarded...
			const stagedLeftovers = authStorage.list().filter((id) => id.startsWith("mcp:acme-2--"));
			expect(stagedLeftovers).toEqual([]);
			// ...and the reservation was released (no ghost pending record).
			expect(store.get("acme-2")).toBeUndefined();
			const calls = JSON.stringify(showStatus.mock.calls);
			expect(calls).toContain("could not be saved");
			expect(calls).toContain("account is unchanged");
		} finally {
			vi.mocked(writeFileAtomicSync).mockImplementation(real);
		}
	});

	test("same id, new owner: a replaced reservation is finalized by ITS attempt only; the stale attempt's credential is discarded", async () => {
		const { fake, store, authStorage, showStatus } = fakeWithStore();
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: stagedLogin(authStorage, (stagedServerId) => {
				// The first attempt is cancelled; a second client wins the same id
				// with its own nonce and stores its own credential.
				const nonce = stagedServerId.split("--")[1];
				void store.removeReservation("acme-2", nonce);
				const now = Date.now();
				authStorage.set("mcp:acme-2", {
					type: "oauth",
					access: "second-owner-credential",
					refresh: "r",
					expires: Date.now() + 3600_000,
					endpoint: "https://mcp.acme.test/mcp",
				});
				store.upsert({
					connectionId: "acme-2",
					serviceId: "acme",
					endpoint: "https://mcp.acme.test/mcp",
					label: "Acme (acme-2)",
					status: "pending",
					createdAt: now,
					updatedAt: now,
					attemptId: `second-owner-${now}`,
				});
				void store.flush();
			}),
		});
		await callAddAccount(fake);
		// The new owner's credential is intact; the stale attempt's staged
		// credential was discarded, never overwriting the account.
		expect(authStorage.get("mcp:acme-2")).toMatchObject({
			access: "second-owner-credential",
		});
		expect(store.get("acme-2")).toBeDefined();
		const stagedLeftovers = authStorage.list().filter((id) => id.startsWith("mcp:acme-2--"));
		expect(stagedLeftovers).toEqual([]);
		expect(JSON.stringify(showStatus.mock.calls)).toContain("removed or replaced during login");
	});
});

describe("ENG-6108 /plugins account state actions", () => {
	function fakeFor(options: {
		authStorage?: AuthStorage;
		store?: McpConnectionStore;
		runMcpLogin?: ReturnType<typeof vi.fn>;
	}) {
		const store =
			options.store ??
			McpConnectionStore.open(join(mkdtempSync(join(tmpdir(), "actions-")), "mcp-connections.json"));
		const authStorage = options.authStorage ?? AuthStorage.inMemory();
		const runMcpLogin = options.runMcpLogin ?? vi.fn(async () => ({ status: "success" }) as const);
		const showStatus = vi.fn();
		const fake = {
			mcpConnectionStore: store,
			modelRegistry: { authStorage },
			createAuthFlows: () => ({ runMcpLogin }),
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning: vi.fn(),
			handleReloadCommand: vi.fn(async () => true),
			uiServices: { settingsManager: { getGlobalMcpServers: () => undefined } },
		} as unknown as Record<string, unknown>;
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		return { fake, store, authStorage, showStatus, runMcpLogin };
	}

	const callConnect = (fake: Record<string, unknown>, service: unknown, target: unknown, options: unknown = {}) =>
		(
			fake as unknown as {
				connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
			}
		).connectServiceFromPicker.call(fake, service, target, options);

	test("pending account retries verification without a new login", async () => {
		const { fake, store, authStorage, runMcpLogin } = fakeFor({});
		authStorage.set("mcp:acme-2", {
			type: "oauth",
			access: "second",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const at = Date.now();
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "pending",
			createdAt: at,
			updatedAt: at,
		});
		const retryStatus = vi.fn();
		(fake as unknown as Record<string, unknown>).showStatus = retryStatus;
		await callConnect(
			fake,
			{ serviceId: "acme-2", label: "Acme · acme-2", connectionStatus: "pending", connectionIds: ["acme-2"] },
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: "acme" },
		);
		expect(runMcpLogin).not.toHaveBeenCalled();
		// The retry runs the verify path: offline the probe fails honestly and
		// the record keeps its pending/category state — no login, no /reload ask.
		expect(JSON.stringify(retryStatus.mock.calls)).not.toContain("/reload");
	});

	test("remove action logs out and removes that account's record only", async () => {
		const { fake, store, authStorage, showStatus: removedStatus } = fakeFor({});
		const at = Date.now();
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "connected",
			verifiedAt: at,
			toolCount: 1,
			createdAt: at,
			updatedAt: at,
		});
		const logout = vi.fn();
		authStorage.logout = logout;
		await callConnect(
			fake,
			{
				serviceId: "acme-2",
				label: "Remove acme-2",
				connectionStatus: "connected",
				connectionIds: ["acme-2"],
				removeAction: true,
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: "acme" },
		);
		expect(logout).toHaveBeenCalledWith("mcp:acme-2");
		expect(store.get("acme-2")).toBeUndefined();
		expect(JSON.stringify(removedStatus.mock.calls)).toContain("Removed account acme-2");
	});

	test("a login whose verification result cannot be saved reports pending, never Connected", async () => {
		const { fake, showStatus } = fakeFor({});
		const brokenStore = {
			get: vi.fn(() => undefined),
			records: vi.fn(() => []),
			flush: vi.fn(async () => undefined),
			upsert: vi.fn(),
			remove: vi.fn(),
			queueVerifyResult: vi.fn(() => {
				throw new Error("boom");
			}),
		};
		(fake as unknown as Record<string, unknown>).mcpConnectionStore = brokenStore;
		await callConnect(
			fake,
			{
				serviceId: "acme",
				label: "Acme",
				connectionStatus: "not_connected",
				connectionIds: [],
				connectable: true,
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
		);
		const calls = JSON.stringify(showStatus.mock.calls);
		expect(calls).toContain("Login succeeded for Acme");
		expect(calls).toContain("could not be saved");
		expect(calls).not.toContain("Connected Acme");
	});

	test("add-account never allocates an id configured as a user server", async () => {
		const { fake, store, showStatus } = fakeFor({});
		const at = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: at,
			toolCount: 1,
			createdAt: at,
			updatedAt: at,
		});
		(fake as unknown as Record<string, unknown>).uiServices = {
			settingsManager: { getGlobalMcpServers: () => ({ "acme-2": { type: "http", url: "https://x.test/mcp" } }) },
		};
		await callConnect(
			fake,
			{
				serviceId: "acme",
				label: "Add another account",
				connectionStatus: "not_connected",
				connectionIds: [],
				connectable: true,
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: "acme", addAccount: true, knownIds: new Set(["acme"]) },
		);
		// Skipped the configured acme-2; the allocation landed on acme-3.
		expect(JSON.stringify(showStatus.mock.calls)).toContain("acme-3");
		expect(store.get("acme-2")).toBeUndefined();
		expect(store.get("acme-3")).toBeDefined();
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
		const runMcpLogin = vi.fn(async (_serverId: string, _label?: string) => ({ status: "success" }) as const);
		const showStatus = vi.fn();
		const fake = {
			mcpConnectionStore: store,
			modelRegistry: { authStorage },
			createAuthFlows: () => ({ runMcpLogin }),
			ui: { requestRender: vi.fn() },
			showStatus,
			showWarning: vi.fn(),
			handleReloadCommand: vi.fn(async () => true),
			uiServices: { settingsManager: { getGlobalMcpServers: () => undefined } },
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

		// The second account got its OWN id: the login targets the per-attempt
		// STAGED id (<id>--<nonce>); the credential moves to mcp:acme-2 only
		// through the guarded finalize.
		const loginCall = runMcpLogin.mock.calls[0];
		expect(loginCall?.[1]).toBe("Acme (acme-2)");
		expect(String(loginCall?.[0])).toMatch(/^acme-2--[0-9a-f-]{36}$/);
		// After the guarded finalize the staged registration is gone; the REAL
		// account provider is registered for the id.
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
