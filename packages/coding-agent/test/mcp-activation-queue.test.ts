import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { type Component, Container, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { McpRemoveAccountResult } from "../src/core/mcp/connection-store.js";
import { ProviderAuthFlows, type ProviderAuthFlowsHost } from "../src/modes/interactive/auth-flows.js";
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
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("offline synthetic probe");
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

type ActivationQueueThis = {
	chatContainer: Container;
	connectionState: { isStreaming: boolean; isCompacting: boolean; messageCount: number };
	pendingPostRunActivation: { message: string; successMessage: string; connectionOutcome?: unknown } | undefined;
	agentConnection: { appendCustomMessage: ReturnType<typeof vi.fn> };
	pulseTimer: ReturnType<typeof setInterval> | undefined;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	handleReloadCommand: ReturnType<typeof vi.fn>;
};

function createFakeMode(): ActivationQueueThis {
	const fake: ActivationQueueThis = {
		// Main's patchConnectionState now pulses working state off
		// chatContainer children; the fake carries a real (empty) container.
		chatContainer: new Container(),
		connectionState: { isStreaming: false, isCompacting: false, messageCount: 0 },
		pendingPostRunActivation: undefined,
		agentConnection: { appendCustomMessage: vi.fn(async () => {}) },
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

const ACME_URL = "https://mcp.acme.test/mcp";

/** A synthetic OAuth grant bound to the given endpoint. */
const grant = (access: string, endpoint = ACME_URL, at = Date.now()) => ({
	type: "oauth" as const,
	access,
	refresh: "r",
	expires: at + 3600_000,
	endpoint,
});

/** A store record for the account fixture. */
const _account = (connectionId: string, status: "connected" | "error" | "pending" = "connected", at = Date.now()) => ({
	connectionId,
	serviceId: "acme",
	endpoint: ACME_URL,
	label: connectionId === "acme" ? "Acme" : `Acme (${connectionId})`,
	status,
	...(status === "connected" ? { verifiedAt: at, toolCount: 2 } : {}),
	createdAt: at,
	updatedAt: at,
});

/** The /mcp `login <name>` command on the guarded-connect seam. */
const callMcpLogin = (fake: Record<string, unknown>, name: string) =>
	(
		fake as unknown as {
			handleMcpCommand: (this: unknown, args: string | undefined) => Promise<void>;
		}
	).handleMcpCommand.call(fake, `login ${name}`);

/** connectServiceFromPicker on the prototype seam. */
const callPickerAction = (
	fake: Record<string, unknown>,
	service: unknown,
	target: unknown,
	options: unknown = {},
): Promise<unknown> =>
	(
		fake as unknown as {
			connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<unknown>;
		}
	).connectServiceFromPicker.call(fake, service, target, options);

/** A name-routed login through connectMcpAccountByName (resolved-but-not-committed). */
const _callLoginByName = (fake: Record<string, unknown>, name: string) =>
	(
		fake as unknown as {
			connectMcpAccountByName: (
				this: unknown,
				name: string,
			) => Promise<{ resolved: boolean; result: { status: string } }>;
		}
	).connectMcpAccountByName.call(fake, name);

/**
 * Resolve once the queued activation's reload starts: the mock's own invocation
 * is the concrete completion signal — no timer, no polling.
 */
function reloadSignal(target: ActivationQueueThis): Promise<void> {
	return new Promise((resolve) => {
		target.handleReloadCommand.mockImplementation(async () => {
			resolve();
			return true;
		});
	});
}

describe("ENG-6108 MCP activation queue at safe boundaries", () => {
	let mode: ActivationQueueThis;

	beforeAll(() => {
		// Overlay components (the generic /logout selector) need the theme.
		initTheme("dark");
	});

	beforeEach(() => {
		mode = createFakeMode();
	});

	test.each([
		{ boundary: "agent_end", state: "streaming" },
		{ boundary: "compaction_end", state: "compacting" },
	])(
		"queues a login made mid-$state and activates automatically at the $boundary — never says /reload",
		async ({ boundary, state }) => {
			mode.connectionState.isStreaming = state === "streaming";
			mode.connectionState.isCompacting = state === "compacting";
			await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");

			// Deferred: no reload yet, and the message must not tell the user to run /reload.
			expect(mode.handleReloadCommand).not.toHaveBeenCalled();
			expect(mode.showStatus).toHaveBeenCalledWith(
				"Connected Notion. It will activate automatically when the current turn finishes.",
			);
			expect(JSON.stringify(mode.showStatus.mock.calls)).not.toContain("/reload");

			// The boundary fires: activation runs.
			const reloaded = reloadSignal(mode);
			callPrivate("updateConnectionStateFromEvent", mode, { type: boundary } as AgentConnectionSessionEvent);
			await reloaded;
			expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
			expect(mode.showStatus).toHaveBeenCalledWith("Connected Notion.");
			expect(mode.pendingPostRunActivation).toBeUndefined();
		},
	);

	test("waits for both streaming and compaction to finish before activating, and a settled activation never runs twice", async () => {
		mode.connectionState.isStreaming = true;
		mode.connectionState.isCompacting = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");

		// Streaming ends but compaction still holds the boundary: the fire is
		// fully synchronous (the early return precedes any await), so the mock
		// not being called is the settled outcome — nothing is pending.
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();

		const reloaded = reloadSignal(mode);
		callPrivate("updateConnectionStateFromEvent", mode, {
			type: "compaction_end",
		} as AgentConnectionSessionEvent);
		await reloaded;
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
		// The second boundary fires after the queued activation already ran:
		// the early return precedes any await, so the settled count is one.
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
	});
	test("keeps the change queued when the boundary reload fails, with an honest warning", async () => {
		mode.connectionState.isStreaming = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");
		const failedReload = new Promise<void>((resolve) => {
			mode.handleReloadCommand.mockImplementation(async () => {
				resolve();
				return false;
			});
		});
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await failedReload;
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(mode.showWarning).toHaveBeenCalledWith(
			"Connected Notion. The change remains saved, but it is not active in this session.",
		);
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

function fakeWithStore(options: { authStorage?: AuthStorage; runMcpLogin?: ReturnType<typeof vi.fn> } = {}) {
	const store = McpConnectionStore.open(join(mkdtempSync(join(tmpdir(), "guarded-")), "mcp-connections.json"));
	const authStorage = options.authStorage ?? AuthStorage.inMemory();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const appendCustomMessage = vi.fn(async (_message: Record<string, unknown>) => {});
	const fake = {
		agentConnection: { appendCustomMessage },
		mcpConnectionStore: store,
		modelRegistry: { authStorage },
		...(options.runMcpLogin ? { createAuthFlows: () => ({ runMcpLogin: options.runMcpLogin }) } : {}),
		ui: { requestRender: vi.fn() },
		showStatus,
		showWarning,
		handleReloadCommand: vi.fn(async () => true),
		uiServices: {
			settingsManager: {
				getGlobalMcpServers: () => undefined,
				getMcpCatalogSources: () => [],
			},
		},
	} as unknown as Record<string, unknown>;
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return { fake, store, authStorage, showStatus, showWarning, appendCustomMessage };
}

describe("ENG-6108 guarded credential commit", () => {
	beforeAll(() => initTheme("dark"));
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
		expect(JSON.stringify(showStatus.mock.calls)).toContain("logged out or replaced during login");
	});

	test("logoutMcpAccount resolves exact ids first, cancels pending attempts, and preserves completed records", async () => {
		const { fake, store, authStorage } = fakeWithStore();
		const at = Date.now();
		const logoutAccount = (
			InteractiveMode.prototype as unknown as {
				logoutMcpAccount: (this: unknown, providerId: string) => Promise<McpRemoveAccountResult>;
			}
		).logoutMcpAccount;
		// A completed account whose id itself contains "--": EXACT resolution wins (never an unconditional nonce split);
		// the completed record is PRESERVED and its credential removed.
		store.upsert({
			connectionId: "my--service-1",
			serviceId: "my--service",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (my--service-1)",
			status: "connected",
			createdAt: at,
			updatedAt: at,
		});
		authStorage.set("mcp:my--service-1", grant("real-for-my--service-1", "https://mcp.acme.test/mcp", at));
		await expect(logoutAccount.call(fake, "mcp:my--service-1")).resolves.toBe("preserved");
		expect(authStorage.get("mcp:my--service-1")).toBeUndefined();
		expect(store.get("my--service-1")?.status).toBe("connected");
		// A staged key maps back ONLY through its recorded attempt nonce: the
		// pending attempt is cancelled AND the staged credential is removed.
		const mine = "nonce-abc";
		await store.reserveConnectionId({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "pending",
			createdAt: at,
			updatedAt: at,
			attemptId: mine,
		});
		authStorage.set("mcp:acme-2--nonce-abc", grant("staged-for-attempt", "https://mcp.acme.test/mcp", at));
		// A staged-key logout CANCELS the attempt but PRESERVES the account shell: the state-neutral "refused" outcome, the
		// staged credential removed, the nonce invalidated, the record kept (removal is the explicit Remove action's job).
		await expect(logoutAccount.call(fake, "mcp:acme-2--nonce-abc")).resolves.toBe("refused");
		expect(authStorage.get("mcp:acme-2--nonce-abc")).toBeUndefined();
		expect(store.get("acme-2")).toBeDefined();
		expect(store.get("acme-2")?.attemptId).toBeUndefined();
		// An unrelated id containing "--" with NO recorded attempt is its own
		// credential-only account (removed, no record involved).
		authStorage.set("mcp:odd--key", grant("real-for-odd--key", "https://mcp.acme.test/mcp", at));
		await expect(logoutAccount.call(fake, "mcp:odd--key")).resolves.toBe("credential-only");
		expect(authStorage.get("mcp:odd--key")).toBeUndefined();
	});

	test("failed nonce cleanup reports recovery instead of a completed cancellation", async () => {
		const { fake, store, authStorage, showWarning } = fakeWithStore();
		fake.createAuthFlows = () => ({ runMcpLogin: async () => ({ status: "cancelled" }) });
		vi.spyOn(store, "releaseClaim").mockResolvedValue(false);
		await callAddAccount(fake);
		expect(store.get("acme-2")?.attemptId).toBeDefined();
		expect(authStorage.get("mcp:acme-2")).toBeUndefined();
		expect(JSON.stringify(showWarning.mock.calls)).toContain("Could not confirm login cleanup");
	});

	test("a success callback without a staged credential fails without reporting login success", async () => {
		const { fake, store, authStorage, showStatus } = fakeWithStore();
		fake.createAuthFlows = () => ({ runMcpLogin: async () => ({ status: "success" }) });
		await callAddAccount(fake);
		expect(store.get("acme-2")?.attemptId).toBeUndefined();
		expect(store.get("acme-2")?.status).toBe("pending");
		expect(authStorage.get("mcp:acme-2")).toBeUndefined();
		expect(JSON.stringify(showStatus.mock.calls)).not.toContain("Login succeeded");
	});

	test("a direct login on a CONNECTED account reconnects through the guarded claim — never the picker disconnect", async () => {
		const { fake, store, authStorage } = fakeWithStore();
		const at = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: at,
			toolCount: 2,
			createdAt: at,
			updatedAt: at,
		});
		authStorage.set("mcp:acme", grant("old-grant", "https://mcp.acme.test/mcp", at));
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				authStorage.set(`mcp:${serverId}`, grant("reconnected-grant", "https://mcp.acme.test/mcp", at));
				return { status: "success" as const };
			}),
		});
		// LOGIN intent goes DIRECTLY to the guarded operation: the connected record is CLAIMED and CAS-replaced — the
		// picker's disconnect branch must never run for a login.
		await store.flush();
		const { resolved, result } = await (
			InteractiveMode.prototype as unknown as {
				connectMcpAccountByName: (
					this: unknown,
					name: string,
				) => Promise<{
					resolved: boolean;
					result: { status: string };
				}>;
			}
		).connectMcpAccountByName.call(fake, "acme");
		expect(resolved).toBe(true);
		expect(result.status).toBe("success");
		const newGrant = authStorage.get("mcp:acme");
		expect(newGrant?.type).toBe("oauth");
		if (newGrant?.type === "oauth") {
			expect(newGrant.access).toBe("reconnected-grant");
		}
		// The record went pending-verification with the nonce consumed — the
		// account was NOT disconnected (no removeAccount ran).
		const record = store.get("acme");
		expect(record?.status).toBe("pending");
		expect(record?.attemptId).toBeUndefined();
	});

	test("a cancelled login propagates the actual outcome: resolved but not committed", async () => {
		const { fake, store, authStorage } = fakeWithStore();
		const at = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "error",
			createdAt: at,
			updatedAt: at,
		});
		authStorage.set("mcp:acme", grant("old-grant", "https://mcp.acme.test/mcp", at));
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async () => ({ status: "cancelled" as const })),
		});
		await store.flush();
		const { resolved, result } = await (
			InteractiveMode.prototype as unknown as {
				connectMcpAccountByName: (
					this: unknown,
					name: string,
				) => Promise<{
					resolved: boolean;
					result: { status: string };
				}>;
			}
		).connectMcpAccountByName.call(fake, "acme");
		// Resolution and login success are SEPARATE: the endpoint resolved, the login did NOT commit — a /login hook maps
		// this to an honest failure, never a success claim.
		expect(resolved).toBe(true);
		expect(result.status).toBe("cancelled");
		// The account is untouched.
		expect(store.get("acme")?.status).toBe("error");
		expect(authStorage.get("mcp:acme")?.type).toBe("oauth");
	});

	test("a double-hyphen account id resolves EXACTLY through the guarded route — no raw-dialog bypass", async () => {
		const { fake, store, authStorage } = fakeWithStore();
		const at = Date.now();
		store.upsert({
			connectionId: "my--service-1",
			serviceId: "my--service",
			endpoint: "https://mcp.acme.test/mcp",
			label: "My Service (my--service-1)",
			status: "error",
			createdAt: at,
			updatedAt: at,
		});
		authStorage.set("mcp:my--service-1", grant("old-grant", "https://mcp.acme.test/mcp", at));
		let stagedIdSeen = "";
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				stagedIdSeen = serverId;
				authStorage.set(`mcp:${serverId}`, grant("reconnected-grant", "https://mcp.acme.test/mcp", at));
				return { status: "success" as const };
			}),
		});
		await store.flush();
		const { resolved, result } = await (
			InteractiveMode.prototype as unknown as {
				connectMcpAccountByName: (
					this: unknown,
					name: string,
				) => Promise<{
					resolved: boolean;
					result: { status: string };
				}>;
			}
		).connectMcpAccountByName.call(fake, "my--service-1");
		// The double-hyphen id resolved EXACTLY and went through the guarded
		// claim (a staged id was handed to the login) — no raw-dialog fallback.
		expect(resolved).toBe(true);
		expect(result.status).toBe("success");
		expect(stagedIdSeen).toMatch(/^my--service-1--/);
		expect(store.get("my--service-1")?.status).toBe("pending");
	});

	test("a login whose captured old grant was DELETED externally refuses (CAS includes absence) and preserves the shell", async () => {
		const { fake, store, authStorage, showStatus } = fakeWithStore();
		const at = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "error",
			createdAt: at,
			updatedAt: at,
		});
		authStorage.set("mcp:acme", grant("old-grant", "https://mcp.acme.test/mcp", at));
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				// Mid-login, the old grant is deleted externally (a logout).
				authStorage.removeVerified("mcp:acme");
				authStorage.set(`mcp:${serverId}`, grant("late-grant", "https://mcp.acme.test/mcp", at));
				return { status: "success" as const };
			}),
		});
		await store.flush();
		const { resolved, result } = await (
			InteractiveMode.prototype as unknown as {
				connectMcpAccountByName: (
					this: unknown,
					name: string,
				) => Promise<{
					resolved: boolean;
					result: { status: string };
				}>;
			}
		).connectMcpAccountByName.call(fake, "acme");
		expect(resolved).toBe(true);
		// The CAS compared INCLUDING absence: the deleted old grant is a CHANGED
		// state — the late login refuses, never reactivating the account.
		expect(result.status).toBe("failed");
		expect(authStorage.get("mcp:acme")).toBeUndefined();
		expect(authStorage.list().filter((id) => id.startsWith("mcp:acme--"))).toEqual([]);
		// The shell survives with our claim nonce released.
		const record = store.get("acme");
		expect(record?.status).toBe("error");
		expect(record?.attemptId).toBeUndefined();
		expect(JSON.stringify(showStatus.mock.calls)).toContain("discarded");
	});

	// A cancelled fresh login preserving the shell against mid-dialog state changes is the SAME
	// guarded-CAS family as the surviving races below ("late login SUCCESS after the reservation
	// was removed", "a login whose captured old grant was DELETED externally", "same id, new
	// owner") and the store-level bystander refusal in mcp-connection-store.test.ts.

	test("an error-state reconnect routes through the guarded claim: full-identity CAS, pending-verification, nonce consumed", async () => {
		const { fake, store, authStorage, appendCustomMessage } = fakeWithStore();
		const at = Date.now();
		// An EXISTING account: an error record with a real (old) credential and
		// stale verification fields that must NOT carry onto the new grant.
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "error",
			verifiedAt: at - 9999,
			toolCount: 3,
			lastError: "http_unauthorized",
			createdAt: at,
			updatedAt: at,
		});
		const oldCredential = {
			type: "oauth" as const,
			access: "old-grant",
			refresh: "r",
			expires: at + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		authStorage.set("mcp:acme", oldCredential);
		let stagedIdSeen = "";
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				// The login ONLY ever sees the staged id — never the real one.
				stagedIdSeen = serverId;
				authStorage.set(`mcp:${serverId}`, grant("new-grant", "https://mcp.acme.test/mcp", at));
				return { status: "success" as const };
			}),
		});
		await callPickerAction(
			fake,
			{
				serviceId: "acme",
				label: "Acme",
				connectionStatus: "error",
				connectable: true,
				usesOAuth: true,
				source: "catalog",
				connectionIds: ["acme"],
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{},
		);
		// The login was handed the STAGED id only.
		expect(stagedIdSeen).toMatch(/^acme--/);
		// The FULL-IDENTITY CAS replaced the old grant...
		const replacedCredential = authStorage.get("mcp:acme");
		expect(replacedCredential?.type).toBe("oauth");
		if (replacedCredential?.type === "oauth") {
			expect(replacedCredential.access).toBe("new-grant");
		}
		// ...the record is PENDING-VERIFICATION with the nonce CONSUMED and the
		// old verification state cleared (no stale Connected/verifiedAt).
		const record = store.get("acme");
		expect(record?.status).toBe("pending");
		expect(record?.attemptId).toBeUndefined();
		expect(record?.verifiedAt).toBeUndefined();
		expect(record?.toolCount).toBeUndefined();
		// The OLD failure detail never carries onto the new grant (a fresh verification failure of its own is honest).
		expect(record?.lastError).not.toBe("http_unauthorized");
		// No staged leftovers.
		expect(authStorage.list().filter((id) => id.startsWith("mcp:acme--"))).toEqual([]);
		// The offline verification outcome is the durable entry: the login
		// succeeded and the wording never claims Connected.
		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.content).toContain("Login succeeded for Acme");
		expect(appended.content).not.toContain("Connected Acme");
		expect(appended.details).toMatchObject({ label: "Acme", source: "login", verification: "unverified" });
	});

	test("a cancelled reconnect preserves the existing credential and account unchanged", async () => {
		const { fake, store, authStorage } = fakeWithStore();
		const at = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: at,
			toolCount: 2,
			createdAt: at,
			updatedAt: at,
		});
		const oldCredential = {
			type: "oauth" as const,
			access: "old-grant",
			refresh: "r",
			expires: at + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		authStorage.set("mcp:acme", oldCredential);
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async () => ({ status: "cancelled" as const })),
		});
		await callPickerAction(
			fake,
			{
				serviceId: "acme",
				label: "Acme",
				connectionStatus: "error",
				connectable: true,
				usesOAuth: true,
				source: "catalog",
				connectionIds: ["acme"],
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{},
		);
		// The claim was RELEASED: the record keeps its status with NO nonce...
		const record = store.get("acme");
		expect(record?.status).toBe("connected");
		expect(record?.attemptId).toBeUndefined();
		expect(record?.verifiedAt).toBe(at);
		// ...and the old credential survives byte-for-byte.
		expect(authStorage.get("mcp:acme")).toEqual(oldCredential);
		expect(authStorage.list().filter((id) => id.startsWith("mcp:acme--"))).toEqual([]);
	});

	// A late success being discarded against a mid-login state change is pinned by the surviving
	// CAS races below (reservation removed, grant deleted, new owner) and the staged-key logout
	// cancellation in "logoutMcpAccount resolves exact ids first"; the staged-credential discard
	// path is shared by all of them.

	test("the REAL generic /logout fired inside the finalize commit is never defeated by the race", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const clientB = AuthStorage.create(authPath);
		const { fake, store, showStatus } = fakeWithStore({ authStorage: clientA });
		const at = Date.now();
		// The account key holds a REAL credential from client B's ordinary login.
		clientB.set("mcp:acme-2", {
			type: "oauth",
			access: "ordinary-login-for-acme-2",
			refresh: "r2",
			expires: at + 7200_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		// The REAL generic /logout route, driven on client B (which sees the
		// account credential) with the REAL prototype handler wired.
		const routeOverlays: Component[] = [];
		const overlayHandle = (): OverlayHandle => ({
			hide: vi.fn(),
			setHidden: vi.fn(),
			isHidden: () => false,
			focus: vi.fn(),
			unfocus: vi.fn(),
			isFocused: () => true,
		});
		const routeShowOverlay = vi.fn((component: Component) => {
			routeOverlays.push(component);
			return overlayHandle();
		});
		const routeHost: ProviderAuthFlowsHost = {
			ui: {
				terminal: { columns: 80, rows: 24 },
				requestRender: vi.fn(),
				showOverlay: routeShowOverlay,
			} as unknown as TUI,
			modelRegistry: {
				authStorage: clientB,
				refresh: vi.fn(),
				getAll: () => [],
				getProviderDisplayName: (providerId: string) => providerId,
				getProviderAuthStatus: () => clientB.getAuthStatus("mcp:acme-2"),
			} as unknown as ProviderAuthFlowsHost["modelRegistry"],
			showStatus: (message: string) => showStatus(message),
			showError: vi.fn(),
			// #2331 inline-auth surface: the route host must mount auth panels
			// inline; tracked like overlays so the test can inspect them.
			showAuthPanel: (component: Component) => {
				routeOverlays.push(component);
				return () => {
					const index = routeOverlays.lastIndexOf(component);
					if (index !== -1) {
						routeOverlays.splice(index, 1);
					}
				};
			},
			getAuthPanelRows: () => 24,
			getAvailableModels: async () => [],
			onMcpAccountLogout: (providerId) =>
				(
					InteractiveMode.prototype as unknown as {
						logoutMcpAccount: (this: unknown, providerId: string) => Promise<McpRemoveAccountResult>;
					}
				).logoutMcpAccount.call(fake, providerId),
		};
		let routePromise: Promise<string | null> | undefined;
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: stagedLogin(clientA, () => {
				// Mid-login (staged written, reservation held): open the REAL
				// route and filter to the account, leaving the confirm pending.
				routePromise = new ProviderAuthFlows(routeHost).runLogout();
				for (const char of "acme-2") {
					routeOverlays[0]?.handleInput?.(char);
				}
			}),
		});
		// The barrier: the route's selection confirms INSIDE the finalize's locked commit. The OLD code (logout before the
		// store critical section) deleted the credential right here, and the commit then moved our staged credential in —
		// the logout was defeated.
		const originalMove = clientA.moveStagedCredential.bind(clientA);
		clientA.moveStagedCredential = (stagedProvider: string, provider: string) => {
			routeOverlays[0]?.handleInput?.("\r");
			return originalMove(stagedProvider, provider);
		};
		await callAddAccount(fake);
		await routePromise;
		// #2331 inline-auth surface: the route mounted its selector through
		// showAuthPanel (tracked in routeOverlays), never an overlay popup.
		expect(routeShowOverlay).not.toHaveBeenCalled();
		// The route's logout is NEVER defeated: no credential at the account key.
		const fresh = AuthStorage.create(authPath);
		expect(fresh.get("mcp:acme-2")).toBeUndefined();
		// No staged leftovers and no surviving record.
		expect(fresh.list().filter((id) => id.startsWith("mcp:acme-2--"))).toEqual([]);
		expect(store.get("acme-2")).toBeUndefined();
		// The route reported an honest logout.
		expect(JSON.stringify(showStatus.mock.calls)).toContain("Logged out of acme-2");
	});

	test("a bystander written by ANOTHER client's ordinary login survives finalization (two real storage instances)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const clientB = AuthStorage.create(authPath);
		const { fake, store, showStatus } = fakeWithStore({ authStorage: clientA });
		const bystander = {
			type: "oauth" as const,
			access: "ordinary-login-for-acme-2",
			refresh: "r2",
			expires: Date.now() + 7200_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		(fake as unknown as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: stagedLogin(clientA, () => {
				// ANOTHER client's ordinary login writes the real account key after our staging, before our finalize. Client A's
				// per-instance cache never sees it — only the on-disk conditional move under the auth backend's own file lock can
				// refuse the clobber.
				clientB.set("mcp:acme-2", bystander);
			}),
		});
		await callAddAccount(fake);
		// A fresh reader of the shared credential file sees the bystander
		// credential byte-for-byte — never our staged value.
		const fresh = AuthStorage.create(authPath);
		expect(fresh.get("mcp:acme-2")).toEqual(bystander);
		// Our staged credential was discarded...
		expect(fresh.list().filter((id) => id.startsWith("mcp:acme-2--"))).toEqual([]);
		// ...and the account SHELL is PRESERVED (the occupancy refusal saw the newer external credential: only OUR nonce
		// was released, the record never deleted) so the bystander stays visible and manageable.
		const preservedShell = store.get("acme-2");
		expect(preservedShell?.status).toBe("pending");
		expect(preservedShell?.attemptId).toBeUndefined();
		expect(JSON.stringify(showStatus.mock.calls)).toContain("discarded");
	});

	// A direct logout leaving an honest unbound record (no corruption) is the last-writer-wins
	// case pinned by "logoutMcpAccount resolves exact ids first..." above (real key logout →
	// removed) and the unbound-record error honesty in mcp-manager.test.ts ("records an error
	// (reconnect) once when demand-driven verification finds an unbound grant").

	test("a removeAccount whose AUTH-file write fails never reports the logout done (fresh reader sees the credential survive)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
		const authPath = join(tempDir, "auth.json");
		const authStorage = AuthStorage.create(authPath);
		const { fake, store, showWarning, showStatus } = fakeWithStore({ authStorage });
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
		authStorage.set("mcp:acme-2", grant("real-for-acme-2", "https://mcp.acme.test/mcp", at));
		// Fail ONLY the AUTH-file write (the durable logout): the account must
		// NOT be reported removed/disconnected while the credential survives.
		const actualModule =
			await vi.importActual<typeof import("../src/utils/atomic-file.js")>("../src/utils/atomic-file.js");
		const real = actualModule.writeFileAtomicSync;
		vi.mocked(writeFileAtomicSync).mockImplementation((...args: Parameters<typeof real>) => {
			if (String(args[0]).endsWith("auth.json")) {
				throw new Error("simulated auth write failure");
			}
			return real(...args);
		});
		await callPickerAction(
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
		// A FRESH reader of the auth file sees the credential SURVIVE on disk...
		const freshReader = AuthStorage.create(authPath);
		const survivor = freshReader.get("mcp:acme-2");
		expect(survivor?.type).toBe("oauth");
		if (survivor?.type === "oauth") {
			expect(survivor.access).toBe("real-for-acme-2");
		}
		// ...and the connection RECORD survives too: a failed verified logout
		// never persists its record deletion (nothing was cancelled).
		expect(store.get("acme-2")?.status).toBe("connected");
		// The record also survives (nothing durable was committed).
		expect(AuthStorage.create(authPath).list()).toContain("mcp:acme-2");
		// The wording is state-neutral (never "Removed"/"Disconnected").
		const calls = JSON.stringify([...showWarning.mock.calls, ...showStatus.mock.calls]);
		expect(calls).toContain("could not be saved");
		expect(calls).toContain("try removing account acme-2 again");
		expect(calls).not.toContain("Removed account");
		expect(calls).not.toContain("Disconnected");
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
		authStorage.set("mcp:acme-2", grant("real-for-acme-2", "https://mcp.acme.test/mcp", at));
		// Fail ONLY the connection-RECORD write: the durable auth-file logout
		// (removeVerified) must succeed first, then the record save fails.
		const actualModule =
			await vi.importActual<typeof import("../src/utils/atomic-file.js")>("../src/utils/atomic-file.js");
		const real = actualModule.writeFileAtomicSync;
		vi.mocked(writeFileAtomicSync).mockImplementation((...args: Parameters<typeof real>) => {
			if (String(args[0]).includes("mcp-connections.json")) {
				throw new Error("simulated remove write failure");
			}
			return real(...args);
		});
		// Drive the REAL removeAction branch.
		await callPickerAction(
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
		// The logout is PRESERVED (credential gone from DISK, removeVerified); the record survives on disk.
		expect(authStorage.get("mcp:acme-2")).toBeUndefined();
		expect(store.get("acme-2")).toBeDefined();
		// The wording reports the honest partial state and never claims the account is still connected.
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
			// The durable shell remains, but our login nonce is released.
			expect(store.get("acme-2")?.status).toBe("pending");
			expect(store.get("acme-2")?.attemptId).toBeUndefined();
			const calls = JSON.stringify(showStatus.mock.calls);
			expect(calls).toContain("could not be saved");
			expect(calls).toContain("Account settings for acme-2 were kept");
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
				authStorage.set("mcp:acme-2", grant("second-owner-credential", "https://mcp.acme.test/mcp"));
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
		expect(JSON.stringify(showStatus.mock.calls)).toContain("logged out or replaced during login");
	});

	test("a /mcp login on a PENDING account performs a guarded reconnect, never just a verification", async () => {
		const { fake, store, authStorage } = fakeWithStore();
		fake.uiServices = {
			settingsManager: {
				getGlobalMcpServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp" } }),
				getMcpCatalogSources: () => [],
			},
		};
		const at = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "pending",
			createdAt: at,
			updatedAt: at,
		});
		authStorage.set("mcp:acme", grant("existing-grant", "https://mcp.acme.test/mcp", at));
		let stagedIdSeen = "";
		fake.createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				stagedIdSeen = serverId;
				authStorage.set(`mcp:${serverId}`, grant("reconnect-credential", "https://mcp.acme.test/mcp", at));
				return { status: "success" as const };
			}),
		});
		await store.flush();
		await callMcpLogin(fake, "acme");
		// LOGIN intent runs the guarded reconnect (claim + staged login + CAS
		// finalize) even on a pending account — never a verification-only retry.
		expect(stagedIdSeen).toMatch(/^acme--/);
		expect((authStorage.get("mcp:acme") as { access: string } | undefined)?.access).toBe("reconnect-credential");
		expect(store.get("acme"), "the account record must survive a login").toBeDefined();
	});

	test("an explicit /mcp login repairs a vanished-source account at its durable saved endpoint; a bare pending shell without evidence cannot log in", async () => {
		const at = Date.now();
		// Repair evidence: a verified record plus its bound grant at the saved
		// endpoint — the record is the only surviving definition.
		const repaired = fakeWithStore();
		repaired.store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://old.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: at,
			toolCount: 2,
			createdAt: at,
			updatedAt: at,
		});
		repaired.authStorage.set("mcp:acme", {
			type: "oauth",
			access: "existing-grant",
			refresh: "r",
			expires: at + 3600_000,
			endpoint: "https://old.acme.test/mcp",
		});
		let sawStagedId = false;
		repaired.fake.createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				sawStagedId = serverId.startsWith("acme--");
				repaired.authStorage.set(`mcp:${serverId}`, grant("repaired-credential", "https://old.acme.test/mcp", at));
				return { status: "success" as const };
			}),
		});
		await repaired.store.flush();
		await callMcpLogin(repaired.fake, "acme");
		expect(sawStagedId, "the saved endpoint plus bound grant is repair evidence").toBe(true);
		expect((repaired.authStorage.get("mcp:acme") as { access: string } | undefined)?.access).toBe(
			"repaired-credential",
		);

		// A pending shell WITHOUT evidence (no credential, no verification) refuses.
		const bare = fakeWithStore();
		await bare.store.reserveConnectionId({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://old.acme.test/mcp",
			label: "Acme",
			status: "pending",
			createdAt: at,
			updatedAt: at,
			attemptId: "shell",
		});
		await bare.store.releaseClaim({ connectionId: "acme", attemptId: "shell" });
		bare.fake.createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				throw new Error(`no login may start without evidence, got ${serverId}`);
			}),
		});
		await callMcpLogin(bare.fake, "acme");
		expect(JSON.stringify(bare.showStatus.mock.calls)).toContain("restore its source");
		expect(bare.authStorage.get("mcp:acme")).toBeUndefined();
		expect(bare.store.get("acme")).toBeDefined();
	});

	describe("ENG-6108 token paste flow (picker action seam, offline verification)", () => {
		const PASTE_URL = "https://api.githubcopilot.com/mcp/";
		const SECRET = "ghp_live-secret-token-value";

		function pasteFake(prompt: ReturnType<typeof vi.fn>) {
			const built = fakeWithStore();
			Object.assign(built.fake, { promptForMcpTokenValues: prompt });
			return built;
		}

		/** The picker's paste action: `ran` marks a flow that started, so the
		 * chain re-enters; a blocked paste reports ran:false and the status line
		 * is the outcome. */
		function callPaste(fake: Record<string, unknown>, url: string, label: string): Promise<{ ran: boolean }> {
			return (
				fake as unknown as {
					connectServiceFromPicker: (
						this: unknown,
						service: unknown,
						target: unknown,
						options?: unknown,
					) => Promise<{ ran: boolean }>;
				}
			).connectServiceFromPicker.call(
				fake,
				{
					serviceId: "github",
					label,
					connectionStatus: "setup_required",
					connectionIds: [],
					connectable: false,
					usesOAuth: false,
					pasteToken: true,
				},
				{ url, usesOAuth: false, managedBySettings: false },
				{},
			);
		}

		test("stores the single-credential static token under the owning connection's key and verifies with it", async () => {
			const credentialsSeen: unknown[] = [];
			const built = pasteFake(
				vi.fn(async (_definition: unknown, credential: unknown) => {
					credentialsSeen.push(credential);
					return SECRET;
				}),
			);
			await expect(callPaste(built.fake, PASTE_URL, "GitHub")).resolves.toEqual({ ran: true });
			// The seam receives the ONE credential — GitHub's two fields collapse
			// to a single PAT under its first alternative id.
			expect(credentialsSeen).toHaveLength(1);
			expect(credentialsSeen[0]).toMatchObject({
				field: expect.objectContaining({ id: "GITHUB_PAT_TOKEN" }),
				fieldIds: ["GITHUB_PAT_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
			});
			// The credential lands under the SAME key OAuth uses, with the honest single-credential static-token shape: bound
			// to the endpoint, no oauth fields faked, no multi-value map.
			expect(built.authStorage.get("mcp:github")).toMatchObject({
				type: "mcp_static_token",
				endpoint: PASTE_URL,
				bearer: SECRET,
				bearerFieldId: "GITHUB_PAT_TOKEN",
			});
			expect(Object.keys(built.authStorage.get("mcp:github") ?? {})).not.toContain("values");
			// The offline probe failed honestly: saved, never Connected.
			expect(built.store.get("github")?.status).toBe("pending");
			expect(built.store.get("github")?.verifiedAt).toBeUndefined();
			// THE leak test: the raw secret appears in NO status or warning call.
			expect(
				JSON.stringify([...built.showStatus.mock.calls, ...built.showWarning.mock.calls]).includes(SECRET),
			).toBe(false);
		});

		test.each([undefined, ""])(
			"a cancelled (value=%s) paste stores nothing and claims nothing, yet still counts as ran",
			async (value) => {
				const built = pasteFake(vi.fn(async () => value));
				await expect(callPaste(built.fake, PASTE_URL, "GitHub")).resolves.toEqual({ ran: true });
				expect(built.authStorage.get("mcp:github")).toBeUndefined();
				expect(built.store.get("github")).toBeUndefined();
				const emitted = JSON.stringify([...built.showStatus.mock.calls, ...built.showWarning.mock.calls]);
				expect(emitted).not.toContain("Connected");
				expect(emitted).not.toContain("saved");
			},
		);

		test.each([
			{ name: "a login attempt owns the account", url: PASTE_URL, status: "Login in progress" },
			{
				name: "the target no longer matches the catalog definition",
				url: "https://moved.example.test/mcp",
				status: "target changed",
			},
		])("refuses to paste when $name", async ({ url, status }) => {
			const at = Date.now();
			const prompt = vi.fn(async () => SECRET);
			const built = pasteFake(prompt);
			if (url === PASTE_URL) {
				built.store.upsert({
					connectionId: "github",
					serviceId: "github",
					endpoint: PASTE_URL,
					label: "GitHub",
					status: "pending",
					createdAt: at,
					updatedAt: at,
					attemptId: "attempt-in-progress",
				});
				await built.store.flush();
			}
			// Blocked BEFORE the panel opened: ran is false, the status line is
			// the outcome, and the picker chain does not re-enter.
			await expect(callPaste(built.fake, url, "GitHub")).resolves.toEqual({ ran: false });
			expect(prompt).not.toHaveBeenCalled();
			expect(built.authStorage.get("mcp:github")).toBeUndefined();
			expect(JSON.stringify(built.showStatus.mock.calls)).toContain(status);
		});
	});
});

describe("ENG-6108 /plugins account state actions", () => {
	/** The shared fake-mode builder with a default successful login wired. */
	function fakeFor(options: { authStorage?: AuthStorage; runMcpLogin?: ReturnType<typeof vi.fn> } = {}) {
		const runMcpLogin = options.runMcpLogin ?? vi.fn(async () => ({ status: "success" }) as const);
		return { ...fakeWithStore({ ...options, runMcpLogin }), runMcpLogin };
	}

	const callConnect = (fake: Record<string, unknown>, service: unknown, target: unknown, options: unknown = {}) =>
		(
			fake as unknown as {
				connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
			}
		).connectServiceFromPicker.call(fake, service, target, options);

	test("pending account retries verification without a new login", async () => {
		const { fake, store, authStorage, runMcpLogin, appendCustomMessage } = fakeFor({});
		authStorage.set("mcp:acme-2", grant("second", "https://mcp.acme.test/mcp"));
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
		// The retry runs the verify path and records the outcome as a DURABLE chat entry: offline the probe fails honestly
		// and the wording keeps its pending/category state — no login, no /reload ask.
		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.details).toMatchObject({
			label: "Acme · acme-2",
			source: "retry",
			verification: "unverified",
			activation: "active",
		});
		expect(appended.content).toContain("Verification did not complete");
		expect(appended.content).toContain("The connection is saved; retry from /plugins.");
		expect(JSON.stringify(retryStatus.mock.calls)).not.toContain("/reload");
		expect(JSON.stringify(retryStatus.mock.calls)).not.toContain("Verification did not complete");
	});

	test("remove action logs out and removes that account's record only", async () => {
		const { fake, store, authStorage, appendCustomMessage } = fakeFor({});
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
		// The durable logout uses removeVerified (disk-authoritative); a plain
		// logout() would swallow auth-file write failures.
		const removeVerified = vi.fn(() => true);
		authStorage.removeVerified = removeVerified;
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
		expect(removeVerified).toHaveBeenCalledWith("mcp:acme-2");
		expect(store.get("acme-2")).toBeUndefined();
		// The Remove row records a durable Disconnected entry instead of a status
		// line that scrolls away (Kevin, live testing).
		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.details).toMatchObject({ kind: "disconnect", removal: "removed", connectionId: "acme-2" });
	});

	test("a login whose verification result cannot be saved reports pending, never Connected", async () => {
		const { fake, appendCustomMessage } = fakeFor({});
		const brokenStore = {
			load: vi.fn(),
			get: vi.fn(() => undefined),
			records: vi.fn(() => []),
			flush: vi.fn(async () => undefined),
			upsert: vi.fn(),
			remove: vi.fn(),
			reserveConnectionId: vi.fn(async () => true),
			claimConnectionId: vi.fn(async () => true),
			releaseClaim: vi.fn(async () => true),
			removeReservation: vi.fn(async () => true),
			finalizeAttempt: vi.fn(async () => "committed"),
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
		// The honest pending state lands in the durable outcome message, never
		// as a transient line and never claiming Connected.
		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.details).toMatchObject({
			label: "Acme",
			source: "login",
			verification: "unsaved",
			activation: "active",
		});
		expect(appended.content).toContain("Login succeeded for Acme");
		expect(appended.content).toContain("could not be saved");
		expect(appended.content).not.toContain("Connected Acme");
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
			settingsManager: {
				getGlobalMcpServers: () => ({ "acme-2": { type: "http", url: "https://x.test/mcp" } }),
				getMcpCatalogSources: () => [],
			},
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
		// Skipped the configured acme-2; the allocation landed on acme-3. The synthetic login stages no credential, so the
		// honest finalize failure wording names the allocated id.
		expect(JSON.stringify(showStatus.mock.calls)).toContain("acme-3");
		expect(store.get("acme-2")).toBeUndefined();
		expect(store.get("acme-3")).toBeDefined();
	});
});

describe("ENG-6108 /plugins add-account flow", () => {
	test("adding an account allocates a new connection id, registers its provider, and records the catalog service id", async () => {
		resetOAuthProviders();
		const now = Date.now();
		const runMcpLogin = vi.fn(async (serverId: string, _label?: string) => {
			// The login writes the STAGED credential; the guarded finalize commits it under the real account key.
			fakeAuth.set(`mcp:${serverId}`, grant("synthetic", "https://mcp.acme.test/mcp", now));
			return { status: "success" } as const;
		});
		const built = fakeWithStore({ runMcpLogin });
		const fakeAuth = built.authStorage;
		// The first account exists: allocation must land on acme-2, not overwrite. A connected record carries its
		// verification evidence: the durable endpoint approval the Add-account exception requires.
		built.store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			verifiedAt: now,
			toolCount: 2,
			createdAt: now,
			updatedAt: now,
		});
		const fake = built.fake;
		const store = built.store;
		const _authStorage = built.authStorage;
		const appendCustomMessage = built.appendCustomMessage;

		const callAdd = (fake as unknown as { connectServiceFromPicker: (...args: unknown[]) => Promise<void> })
			.connectServiceFromPicker;
		await callAdd.call(
			fake,
			{ serviceId: "acme", label: "Acme", connectable: true, connectionIds: [], connectionStatus: "not_connected" },
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: "acme", addAccount: true },
		);

		// The second account got its OWN id: the login targets the per-attempt STAGED id (<id>--<nonce>); the credential
		// moves to mcp:acme-2 only through the guarded finalize.
		const loginCall = runMcpLogin.mock.calls[0];
		expect(loginCall?.[1]).toBe("Acme (acme-2)");
		expect(String(loginCall?.[0])).toMatch(/^acme-2--[0-9a-f-]{36}$/);
		// After the guarded finalize the staged registration is gone; the REAL account provider is registered for the id.
		expect(getOAuthProvider("mcp:acme-2")).toBeDefined();
		const record = store.get("acme-2");
		expect(record?.connectionId).toBe("acme-2");
		expect(record?.serviceId).toBe("acme");
		// The first account is untouched.
		expect(store.get("acme")?.status).toBe("connected");
		// The connect outcome is a durable chat entry naming the new account.
		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.content).toContain("Added account acme-2.");
		expect(appended.details).toMatchObject({
			connectionId: "acme-2",
			addedAccount: true,
			source: "login",
		});
		resetOAuthProviders();
	});
});
