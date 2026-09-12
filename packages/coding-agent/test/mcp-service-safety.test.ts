// Adversarial regressions for the ENG-6108 service-catalog safety contract.
//
// These encode the invariants from the independent ENG-6108 implementation
// review (Blockers 2 and 3) plus the cross-client stale-probe contract, so the
// host production fixes cannot silently regress:
//
// 1. Credential binding BEFORE probe/token access: a stored MCP credential whose
//    `endpoint` does not match the current server URL — or that carries no
//    endpoint at all — must be rejected BEFORE any probe runs and BEFORE the
//    stored token is accessed. Contract (per authorized policy): ZERO probe
//    calls and ZERO `authStorage.getApiKey` accesses for such credentials, for
//    user-declared servers AND catalog services, both through a direct
//    `verifyConnection()` and through the demand-driven background verification
//    triggered by `mcp.list_plugins` / `mcp.search_plugins`. Settings edits must
//    never be able to replay a stored token against a retargeted URL, and an
//    unusable credential must never yield a `connected` record.
// 2. Cross-client stale probes: two clients share one auth.json (interactive
//    client + daemon). A probe that starts with the first client's cached grant
//    must not persist a `connected` record when a second client logs the grant
//    out or replaces it while the probe is in flight — the finished probe must
//    not bless the CURRENT grant (or a removed one) as verified. The persist step
//    must observe fresh auth.json state, not a cached in-memory read.
// 3. OAuth provider lifecycle: a full OAuth registry reset
//    (ModelRegistry.refresh -> resetOAuthProviders + the production reset hook)
//    must preserve providers for non-bundled catalog services, and removing a
//    user override of a catalog id must restore the catalog provider after ONE
//    manager.refresh() — not two.
//
// RED-ON-BASELINE IS EXPECTED on the 4bd8abc12 base: the failing assertions
// below record the exact current defects for the host production fixes. The
// control tests that pass on baseline prove the harness is not over-mocked.
//
// Offline-only: every probe is injected, `globalThis.fetch` is denied so any
// accidental real network attempt fails loudly, credential and connection
// stores live in per-test temp directories, and no provider endpoints,
// real credentials, or paid APIs are touched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import type { McpServiceDescriptor } from "../src/core/mcp/service-catalog.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/** Non-bundled, connectable catalog service (the kind registerCatalogProviders owns). */
const CATALOG_SERVICE: McpServiceDescriptor = {
	serviceId: "brand",
	label: "Brand",
	aliases: [],
	transport: { type: "http", url: "https://brand.test/mcp" },
	authStrategy: "oauth",
	setup: { status: "ready" },
	metadataReviewed: true,
	legacyBuiltin: false,
};

function oauthCredential(access: string, endpoint?: string): Record<string, unknown> {
	return {
		type: "oauth",
		access,
		refresh: "refresh-token",
		expires: Date.now() + 3600_000,
		...(endpoint === undefined ? {} : { endpoint }),
	};
}

function waitForCondition(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	return new Promise<void>((resolve, reject) => {
		const poll = () => {
			if (condition()) {
				resolve();
				return;
			}
			if (Date.now() - startedAt > timeoutMs) {
				reject(new Error("Timed out waiting for a background condition"));
				return;
			}
			setTimeout(poll, 10);
		};
		poll();
	});
}

/** Count (and forward) authStorage.getApiKey accesses: the token-yielding call. */
function spyOnGetApiKey(storage: AuthStorage): { calls: string[]; restore: () => void } {
	const original = storage.getApiKey.bind(storage);
	const calls: string[] = [];
	(storage as unknown as { getApiKey: typeof original }).getApiKey = (
		providerId: string,
		options?: { includeFallback?: boolean },
	) => {
		calls.push(providerId);
		return original(providerId, options);
	};
	return {
		calls,
		restore: () => {
			delete (storage as unknown as { getApiKey?: typeof original }).getApiKey;
		},
	};
}

function denyUnexpectedFetch(): { restore: () => void } {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (() => {
		throw new Error("unexpected network fetch in offline mcp-service-safety test");
	}) as typeof fetch;
	return {
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
}

describe("MCP service safety: credential binding before probe/token access", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	let probeCalls: Array<{ url: string; token: string }>;
	let fetchGuard: { restore: () => void };

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-safety-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		probeCalls = [];
		resetOAuthProviders();
		fetchGuard = denyUnexpectedFetch();
	});

	afterEach(() => {
		fetchGuard.restore();
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	function createManager(options: Partial<ConstructorParameters<typeof McpManager>[0]> = {}): McpManager {
		return new McpManager({
			authStorage,
			connectionStore: store,
			probeConnection: async (probeOptions) => {
				const token = await probeOptions.getToken();
				probeCalls.push({ url: probeOptions.url, token });
				return { ok: true, toolCount: 2 };
			},
			...options,
		});
	}

	/**
	 * The rejection contract for unusable credentials: rejected BEFORE any probe
	 * runs and BEFORE the stored token is accessed. Zero probe calls, zero
	 * getApiKey accesses, and never a connected record (verifiedAt included).
	 */
	function expectRejectedBeforeProbeAndTokenAccess(connectionId: string, spy: { calls: string[] }): void {
		expect(probeCalls, "no probe call may run for an unusable credential").toEqual([]);
		expect(spy.calls, "the stored token must never be accessed (getApiKey) for an unusable credential").toEqual([]);
		const record = store.get(connectionId);
		expect(
			record?.status ?? "absent",
			"a connection whose credential is unusable must never be recorded as connected",
		).not.toBe("connected");
		expect(record?.verifiedAt).toBeUndefined();
	}

	it("direct verifyConnection rejects a user credential bound to a different endpoint before probe/token access", async () => {
		authStorage.set("mcp:acme", oauthCredential("tok-old", "https://old.test/mcp") as never);
		const manager = createManager({
			getServiceCatalog: () => [],
			getUserServers: () => ({ acme: { type: "http", url: "https://new.test/mcp", oauth: true } }),
		});
		const spy = spyOnGetApiKey(authStorage);
		try {
			await manager.verifyConnection("acme");
			expectRejectedBeforeProbeAndTokenAccess("acme", spy);
		} finally {
			spy.restore();
		}
	});

	it("direct verifyConnection rejects an unbound user credential before probe/token access", async () => {
		authStorage.set("mcp:acme", oauthCredential("tok-unbound") as never);
		const manager = createManager({
			getServiceCatalog: () => [],
			getUserServers: () => ({ acme: { type: "http", url: "https://srv.test/mcp", oauth: true } }),
		});
		const spy = spyOnGetApiKey(authStorage);
		try {
			await manager.verifyConnection("acme");
			expectRejectedBeforeProbeAndTokenAccess("acme", spy);
		} finally {
			spy.restore();
		}
	});

	it("direct verifyConnection rejects a catalog credential bound to a different endpoint before probe/token access", async () => {
		authStorage.set("mcp:brand", oauthCredential("tok-brand-cross", "https://other.test/mcp") as never);
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		const spy = spyOnGetApiKey(authStorage);
		try {
			await manager.verifyConnection("brand");
			expectRejectedBeforeProbeAndTokenAccess("brand", spy);
		} finally {
			spy.restore();
		}
	});

	it("direct verifyConnection rejects an unbound catalog credential before probe/token access", async () => {
		authStorage.set("mcp:brand", oauthCredential("tok-brand-unbound") as never);
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		const spy = spyOnGetApiKey(authStorage);
		try {
			await manager.verifyConnection("brand");
			expectRejectedBeforeProbeAndTokenAccess("brand", spy);
		} finally {
			spy.restore();
		}
	});

	it("demand-driven verification from mcp.list_plugins rejects a mismatched credential before probe/token access", async () => {
		authStorage.set("mcp:acme", oauthCredential("tok-old", "https://old.test/mcp") as never);
		const manager = createManager({
			getServiceCatalog: () => [],
			getUserServers: () => ({ acme: { type: "http", url: "https://new.test/mcp", oauth: true } }),
		});
		const spy = spyOnGetApiKey(authStorage);
		try {
			const handlers = manager.hostHandlers();
			await handlers["mcp.list_plugins"]({});
			// The background verification is fire-and-forget; give it a bounded
			// window to run. On baseline the leak is observable promptly; after the
			// fix nothing may run at all, so a timeout here is not a failure.
			await waitForCondition(() => store.get("acme") !== undefined, 500).catch(() => undefined);
			expectRejectedBeforeProbeAndTokenAccess("acme", spy);
		} finally {
			spy.restore();
		}
	});

	it("control: a matching user credential is attached and the handshake is recorded", async () => {
		authStorage.set("mcp:acme", oauthCredential("tok-good", "https://good.test/mcp") as never);
		const manager = createManager({
			getServiceCatalog: () => [],
			getUserServers: () => ({ acme: { type: "http", url: "https://good.test/mcp", oauth: true } }),
		});
		const record = await manager.verifyConnection("acme");
		expect(probeCalls).toEqual([{ url: "https://good.test/mcp", token: "tok-good" }]);
		expect(record.status).toBe("connected");
		expect(record.toolCount).toBe(2);
	});

	it("control: a matching catalog credential is attached and the handshake is recorded", async () => {
		authStorage.set("mcp:brand", oauthCredential("tok-brand", "https://brand.test/mcp") as never);
		const manager = createManager({ getServiceCatalog: () => [CATALOG_SERVICE] });
		const record = await manager.verifyConnection("brand");
		expect(probeCalls).toEqual([{ url: "https://brand.test/mcp", token: "tok-brand" }]);
		expect(record.status).toBe("connected");
	});

	it("control: host inventory excludes mismatched and unbound user credentials (dispatch binding)", () => {
		// mcp.config serves a user-declared config unconditionally (by design); the
		// binding block for user servers happens in the kernel (rlm.mcp._bound_auth
		// refuses to attach mismatched/unbound tokens). The host-side gates are the
		// enabled-server inventory and listStatus, which must exclude them.
		authStorage.set("mcp:mismatch", oauthCredential("tok-a", "https://old.test/mcp") as never);
		authStorage.set("mcp:unbound", oauthCredential("tok-b") as never);
		const userServers: Record<string, McpServerConfig> = {
			mismatch: { type: "http", url: "https://new.test/mcp", oauth: true },
			unbound: { type: "http", url: "https://srv.test/mcp", oauth: true },
		};
		const manager = createManager({ getServiceCatalog: () => [], getUserServers: () => userServers });
		expect(manager.getEnabledPersistentGenericServers()).toEqual([]);
		const statuses = manager.listStatus();
		expect(statuses.find((status) => status.server === "mismatch")?.enabled).toBe(false);
		expect(statuses.find((status) => status.server === "unbound")?.enabled).toBe(false);
	});
});

describe("MCP service safety: cross-client stale probes", () => {
	let tempDir: string;
	let clientA: AuthStorage;
	let clientB: AuthStorage;
	let store: McpConnectionStore;
	let storePath: string;
	let probeCalls: Array<{ url: string; token: string }>;
	let fetchGuard: { restore: () => void };

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-safety-cross-"));
		const authPath = join(tempDir, "auth.json");
		clientA = AuthStorage.create(authPath);
		// The first client holds the grant in its cache, like an interactive
		// client that just completed a login.
		clientA.set("mcp:acme", oauthCredential("tok-old", "https://good.test/mcp") as never);
		// The second client is constructed after the grant exists, like a daemon
		// sharing the same auth.json.
		clientB = AuthStorage.create(authPath);
		storePath = join(tempDir, "mcp-connections.json");
		store = McpConnectionStore.open(storePath);
		probeCalls = [];
		resetOAuthProviders();
		fetchGuard = denyUnexpectedFetch();
	});

	afterEach(() => {
		fetchGuard.restore();
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	function createControllableManager(): {
		manager: McpManager;
		probeStarted: Promise<void>;
		releaseProbe: () => void;
	} {
		let resolveStarted: () => void = () => undefined;
		const probeStarted = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		let release: () => void = () => undefined;
		const manager = new McpManager({
			authStorage: clientA,
			connectionStore: store,
			getServiceCatalog: () => [],
			getUserServers: () => ({ acme: { type: "http", url: "https://good.test/mcp", oauth: true } }),
			probeConnection: async (probeOptions) => {
				const token = await probeOptions.getToken();
				probeCalls.push({ url: probeOptions.url, token });
				resolveStarted();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { ok: true, toolCount: 2 };
			},
		});
		return {
			manager,
			probeStarted,
			releaseProbe: () => {
				release();
			},
		};
	}

	it("a probe finishing after another client logged the grant out must not persist a connected record", async () => {
		const { manager, probeStarted, releaseProbe } = createControllableManager();
		const verifyPromise = manager.verifyConnection("acme");
		await probeStarted;
		// Control: the in-flight probe used the first client's cached grant.
		expect(probeCalls).toEqual([{ url: "https://good.test/mcp", token: "tok-old" }]);

		// The second client logs the grant out while the probe is in flight.
		clientB.logout("mcp:acme");
		clientA.reload();
		expect(clientA.get("mcp:acme"), "sanity: the grant is really gone from auth.json").toBeUndefined();

		releaseProbe();
		await verifyPromise;

		const record = store.get("acme");
		expect(
			record?.status ?? "absent",
			"a probe on a grant that was logged out mid-flight must not persist a connected record",
		).not.toBe("connected");
		expect(record?.verifiedAt).toBeUndefined();
		const persisted = McpConnectionStore.open(storePath).get("acme");
		expect(persisted?.status ?? "absent", "the flushed file must not claim connected either").not.toBe("connected");
	});

	it("a probe finishing after another client replaced the grant must not persist a connected record", async () => {
		const { manager, probeStarted, releaseProbe } = createControllableManager();
		const verifyPromise = manager.verifyConnection("acme");
		await probeStarted;
		expect(probeCalls).toEqual([{ url: "https://good.test/mcp", token: "tok-old" }]);

		// The second client replaces the grant with a different access token
		// while the probe is in flight. The finished probe verified the OLD
		// token; it must not bless the CURRENT (never-probed) grant.
		clientB.set("mcp:acme", oauthCredential("tok-new", "https://good.test/mcp") as never);
		clientA.reload();
		expect(clientA.get("mcp:acme")).toMatchObject({ access: "tok-new" });

		releaseProbe();
		await verifyPromise;

		const record = store.get("acme");
		expect(
			record?.status ?? "absent",
			"a probe on a superseded grant must not persist a connected record for the current grant",
		).not.toBe("connected");
		expect(record?.verifiedAt).toBeUndefined();
		const persisted = McpConnectionStore.open(storePath).get("acme");
		expect(persisted?.status ?? "absent", "the flushed file must not claim connected either").not.toBe("connected");
	});
});

describe("MCP service safety: OAuth provider lifecycle", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let probeCalls: Array<{ url: string; token: string }>;
	let fetchGuard: { restore: () => void };

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-safety-lifecycle-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		probeCalls = [];
		resetOAuthProviders();
		fetchGuard = denyUnexpectedFetch();
	});

	afterEach(() => {
		fetchGuard.restore();
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("a full OAuth registry reset preserves non-bundled catalog providers", async () => {
		const mcpManager = new McpManager({
			authStorage,
			connectionStore: McpConnectionStore.open(join(tempDir, "mcp-connections.json")),
			getServiceCatalog: () => [CATALOG_SERVICE],
			noBackgroundVerification: true,
			probeConnection: async (probeOptions) => {
				const token = await probeOptions.getToken();
				probeCalls.push({ url: probeOptions.url, token });
				return { ok: true, toolCount: 2 };
			},
		});
		const modelRegistry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			authStorage,
			settingsManager: SettingsManager.inMemory(),
			modelRegistry,
			mcpManager,
			telemetryDisabled: true,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noExtensions: true },
		});
		// Control: the catalog provider is registered initially (green on baseline).
		expect(getOAuthProvider("mcp:brand")).toBeDefined();

		// ModelRegistry.refresh() runs resetOAuthProviders(), re-registers the
		// bundled built-ins, then invokes the production reset hook. The catalog
		// provider must survive the same way user-declared providers do.
		services.modelRegistry.refresh();

		expect(getOAuthProvider("mcp:linear"), "the bundled provider must survive the reset").toBeDefined();
		expect(
			getOAuthProvider("mcp:brand"),
			"a non-bundled catalog provider must survive a full OAuth registry reset",
		).toBeDefined();
		expect(probeCalls, "no verification probe may run during registry churn").toEqual([]);
	});

	it("removing a user override restores the catalog provider in ONE refresh", () => {
		let servers: Record<string, McpServerConfig> = {
			brand: { type: "http", url: "https://custom.brand.test/mcp", oauth: true },
		};
		const manager = new McpManager({
			authStorage,
			connectionStore: McpConnectionStore.open(join(tempDir, "mcp-connections.json")),
			getServiceCatalog: () => [CATALOG_SERVICE],
			getUserServers: () => servers,
			noBackgroundVerification: true,
			probeConnection: async (probeOptions) => {
				const token = await probeOptions.getToken();
				probeCalls.push({ url: probeOptions.url, token });
				return { ok: true, toolCount: 2 };
			},
		});
		// Control: while the override exists, the user provider owns the id.
		expect(getOAuthProvider("mcp:brand")?.name).toBe("brand");

		// Remove the user entry and run exactly ONE refresh.
		servers = {};
		manager.refresh();

		expect(
			getOAuthProvider("mcp:brand"),
			"removing a user override must restore the catalog provider after one refresh",
		).toBeDefined();
		expect(getOAuthProvider("mcp:brand")?.name).toBe("Brand");
		// Stability control: a further refresh keeps the catalog provider registered.
		manager.refresh();
		expect(getOAuthProvider("mcp:brand")?.name).toBe("Brand");
		expect(probeCalls).toEqual([]);
	});
});
