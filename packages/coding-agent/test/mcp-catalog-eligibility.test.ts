// Authoritative ENG-6108 MCP catalog eligibility regressions, driven against the
// REAL generated catalog data and the ONE shared oauthGrantUsable predicate.
// The matrix asserts the SAME answer across every consumer that previously
// diverged: system-prompt eligibility (getEnabledPersistentGenericServers),
// kernel dispatch (mcp.config), and the picker/inventory view builders. The
// catalog cap section pins installed-row protection (still-in-source AND
// vanished-source), and the explicit >500-installed soft-discovery diagnostic.
//
// Offline only: in-memory or temp-file auth/records, no network, no provider
// calls; env vars are set and restored inside tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type McpServiceEntry, SERVICE_CATALOG } from "@earendil-works/pi-ai/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthCredential, AuthStorage } from "../src/core/auth-storage.js";

import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import {
	buildPluginViews,
	defaultServiceCatalogProvider,
	type McpServiceDescriptor,
	oauthGrantUsable,
	resolveMcpServiceCatalog,
} from "../src/core/mcp/service-catalog.js";

const ENDPOINT = "https://matrix.example.test/mcp";

function descriptor(overrides: Partial<McpServiceDescriptor>): McpServiceDescriptor {
	return {
		serviceId: "matrix-service",
		label: "Matrix Service",
		aliases: [],
		transport: { type: "http", url: ENDPOINT },
		authStrategy: "none",
		setup: { status: "ready" },
		metadataReviewed: true,
		legacyBuiltin: false,
		...overrides,
	};
}

function record(serviceId: string): McpConnectionRecord {
	const now = Date.now();
	return {
		connectionId: serviceId,
		serviceId,
		endpoint: ENDPOINT,
		label: `Matrix (${serviceId})`,
		status: "connected",
		createdAt: now,
		updatedAt: now,
	};
}

describe("MCP catalog eligibility (authoritative real-data regressions)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-eligibility-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const key of Object.keys(savedEnv)) delete savedEnv[key];
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	function managerFor(options: {
		services?: readonly McpServiceDescriptor[];
		userServers?: Record<string, unknown>;
	}): McpManager {
		return new McpManager({
			authStorage,
			connectionStore: store,
			noBackgroundVerification: true,
			getServiceCatalog: () => options.services ?? [],
			getUserServers: () => (options.userServers ?? undefined) as never,
		});
	}

	async function configFor(manager: McpManager, server: string): Promise<Record<string, unknown>> {
		const handler = manager.hostHandlers()["mcp.config"];
		if (!handler) throw new Error("mcp.config handler missing");
		return handler({ server });
	}

	function viewFor(
		services: readonly McpServiceDescriptor[],
		server: string,
	): ReturnType<typeof buildPluginViews>[number] | undefined {
		return buildPluginViews({
			services,
			userServers: undefined,
			authStorage,
			connectionStore: store,
		}).find((view) => view.serviceId === server);
	}

	it("sweeps the REAL catalog: no row is enabled without proven credentials, and the sweep is meaningful", () => {
		const descriptors = defaultServiceCatalogProvider()();
		// The sweep must actually cover the strategies Bugbot found divergent:
		// real api_key rows and real unknown rows. none+ready is asserted to be
		// exactly zero TODAY so catalog drift forces a conscious update here.
		expect(descriptors.length).toBeGreaterThan(100);
		expect(descriptors.filter((d) => d.authStrategy === "api_key").length).toBeGreaterThanOrEqual(10);
		expect(descriptors.filter((d) => d.authStrategy === "unknown").length).toBeGreaterThanOrEqual(70);
		expect(descriptors.filter((d) => d.authStrategy === "none").length).toBe(0);

		const manager = managerFor({ services: descriptors });
		const enabled = manager.getEnabledPersistentGenericServers();
		expect(enabled, "with empty credentials no real catalog row may be enabled").toEqual([]);
		expect(manager.listStatus().every((row) => !row.enabled)).toBe(true);
	});

	it("the real aws-devops-agent row stays unauthenticated even when its setup env var is present", async () => {
		const descriptors = defaultServiceCatalogProvider()();
		const aws = descriptors.find((d) => d.serviceId === "aws-devops-agent");
		expect(aws, "the real aws-devops-agent row must exist in the catalog").toBeDefined();
		expect(aws?.authStrategy).toBe("api_key");
		expect(aws?.setup.status).toBe("requires-setup");

		// setup-field env presence must NEVER be inferred as a credential.
		savedEnv.DEVOPS_AGENT_TOKEN = process.env.DEVOPS_AGENT_TOKEN;
		process.env.DEVOPS_AGENT_TOKEN = "inferred-secret";
		const manager = managerFor({ services: descriptors });
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("aws-devops-agent");
		expect(await configFor(manager, "aws-devops-agent")).toEqual({});
		expect(manager.listStatus().find((row) => row.server === "aws-devops-agent")?.enabled).toBe(false);
	});

	it.each([
		["none+ready is credential-free eligible", descriptor({}), true],
		["none+requires-setup fails closed", descriptor({ setup: { status: "requires-setup" } }), false],
		["api_key requires-setup fails closed (env unset)", descriptor({ authStrategy: "api_key" }), false],
		["unknown without a credential fails closed", descriptor({ authStrategy: "unknown" }), false],
	])("%s across prompt and dispatch", async (_name, service, expectedEnabled) => {
		const manager = managerFor({ services: [service as McpServiceDescriptor] });
		const enabled = manager.getEnabledPersistentGenericServers();
		const configured = await configFor(manager, (service as McpServiceDescriptor).serviceId);
		if (expectedEnabled) {
			expect(enabled).toContain((service as McpServiceDescriptor).serviceId);
			expect(configured).not.toEqual({});
		} else {
			expect(enabled).not.toContain((service as McpServiceDescriptor).serviceId);
			expect(configured, "dispatch must not serve an unproven catalog row").toEqual({});
			const status = viewFor(
				[service as McpServiceDescriptor],
				(service as McpServiceDescriptor).serviceId,
			)?.connectionStatus;
			if ((service as McpServiceDescriptor).authStrategy === "unknown") {
				// OAuth-gated rows are RECONNECTABLE (not_connected + connect),
				// not setup_required — only api_key/requires-setup rows are.
				expect(status).toBe("not_connected");
			} else {
				expect(status).toBe("setup_required");
			}
		}
	});

	it("a none+requires-setup row never renders as connectable in the picker", () => {
		const service = descriptor({ setup: { status: "requires-setup" } });
		const view = viewFor([service], service.serviceId);
		expect(view?.connectionStatus).toBe("setup_required");
		expect(view?.connectable).toBe(false);
	});

	it("OAuth grant states agree across the shared predicate, prompt, dispatch, and the picker view", async () => {
		const service = descriptor({ authStrategy: "oauth" });
		const bound = {
			type: "oauth" as const,
			access: "valid-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600_000,
			endpoint: ENDPOINT,
		};
		// The OAuthCredentials TYPE requires refresh: string; the shared
		// predicate treats FALSY refresh as no-refresh (Boolean(refresh), the
		// status resolver's semantics), so "" is the type-clean fixture.
		const cases: ReadonlyArray<{
			name: string;
			credential: AuthCredential;
			enabled: boolean;
			reason: string | undefined;
		}> = [
			{
				name: "valid bound grant",
				credential: bound,
				enabled: true,
				reason: undefined,
			},
			{
				name: "expired grant WITH refresh stays usable (dispatch refreshes)",
				credential: { ...bound, access: "stale", expires: Date.now() - 1000 },
				enabled: true,
				reason: undefined,
			},
			{
				name: "expired grant WITHOUT refresh fails closed",
				credential: { ...bound, access: "stale", refresh: "", expires: Date.now() - 1000 },
				enabled: false,
				reason: "expired-no-refresh",
			},
			{
				// Intentionally wrong-typed so the guard is exercised on the
				// TYPE, with an endpoint that MATCHES — the old endpoint-only
				// check passed exactly this shape, so this is the authoritative
				// wrong-type regression.
				name: "wrong-type credential fails closed",
				credential: {
					type: "api_key",
					key: "not-oauth",
					endpoint: ENDPOINT,
				} as unknown as AuthCredential,
				enabled: false,
				reason: "wrong-type",
			},
			{
				name: "empty-access credential fails closed",
				credential: { ...bound, access: "" },
				enabled: false,
				reason: "empty-access",
			},
			{
				name: "unbound credential fails closed",
				credential: { ...bound, endpoint: undefined },
				enabled: false,
				reason: "unbound",
			},
			{
				name: "cross-endpoint credential fails closed",
				credential: { ...bound, endpoint: "https://other.example.test/mcp" },
				enabled: false,
				reason: "cross-endpoint",
			},
		];
		for (const testCase of cases) {
			authStorage.set(`mcp:${service.serviceId}`, testCase.credential);
			const usable = oauthGrantUsable(authStorage.get(`mcp:${service.serviceId}`), ENDPOINT);
			expect(usable.reason, `${testCase.name}: shared predicate reason`).toBe(testCase.reason);
			const manager = managerFor({ services: [service] });
			const enabled = manager.getEnabledPersistentGenericServers();
			const configured = await configFor(manager, service.serviceId);
			const view = viewFor([service], service.serviceId);
			if (testCase.enabled) {
				expect(enabled, testCase.name).toContain(service.serviceId);
				expect(configured, testCase.name).not.toEqual({});
			} else {
				expect(enabled, testCase.name).not.toContain(service.serviceId);
				expect(configured, testCase.name).toEqual({});
				if (usable.reason === "expired-no-refresh") {
					expect(view?.setupHint, testCase.name).toContain("expired without a refresh token");
				}
				if (usable.reason === "unbound" || usable.reason === "cross-endpoint") {
					expect(view?.setupHint, testCase.name).toContain("not bound to this endpoint");
				}
			}
		}
	});

	it("user-declared servers keep their semantics, but a configured bearer env var is the ONLY credential source", async () => {
		// Anonymous HTTP: the user owns the auth decision; stays enabled.
		let manager = managerFor({
			services: [],
			userServers: { anonymous: { type: "http", url: "https://anon.example.test/mcp" } },
		});
		expect(manager.getEnabledPersistentGenericServers()).toContain("anonymous");
		expect(await configFor(manager, "anonymous")).not.toEqual({});

		// stdio: unchanged.
		manager = managerFor({
			services: [],
			userServers: { local: { type: "stdio", command: "run-me" } },
		});
		expect(manager.getEnabledPersistentGenericServers()).toContain("local");

		// disabled: excluded everywhere.
		manager = managerFor({
			services: [],
			userServers: { off: { type: "stdio", command: "no", enabled: false } },
		});
		expect(manager.getEnabledPersistentGenericServers()).not.toContain("off");

		// Bearer env UNSET: must fail closed even though a stale OAuth grant for
		// the same id is bound to the same endpoint (the old stale-OAuth
		// fall-through Bugbot flagged).
		authStorage.set("mcp:bearer", {
			type: "oauth" as const,
			access: "stale-oauth-token",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://bearer.example.test/mcp",
		});
		manager = managerFor({
			services: [],
			userServers: {
				bearer: { type: "http", url: "https://bearer.example.test/mcp", bearerTokenEnvVar: "MATRIX_BEARER" },
			},
		});
		expect(
			manager.getEnabledPersistentGenericServers(),
			"unset bearer env must fail closed with no stale-OAuth fallback",
		).not.toContain("bearer");
		// A user-declared config is the user's own: mcp.config serves it and the
		// kernel fails late at connection time. The stale-OAuth regression is
		// the eligibility exclusion above, which must hold even with a bound
		// grant stored under the same id.
		expect((await configFor(manager, "bearer")).bearerTokenEnvVar).toBe("MATRIX_BEARER");

		// Bearer env SET: enabled and served.
		savedEnv.MATRIX_BEARER = process.env.MATRIX_BEARER;
		process.env.MATRIX_BEARER = "configured-bearer";
		manager = managerFor({
			services: [],
			userServers: {
				bearer: { type: "http", url: "https://bearer.example.test/mcp", bearerTokenEnvVar: "MATRIX_BEARER" },
			},
		});
		expect(manager.getEnabledPersistentGenericServers()).toContain("bearer");
		expect(await configFor(manager, "bearer")).not.toEqual({});
	});
});

describe("MCP catalog cap protection (installed rows always survive)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	let realFetch: typeof globalThis.fetch;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-cap-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		realFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("unexpected network fetch in offline mcp-catalog-eligibility test");
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("keeps BOTH vanished-source pins and still-in-source installed rows under overflow", () => {
		const entries: McpServiceEntry[] = [];
		for (let index = 0; index < 600; index++) {
			const serviceId = `overflow-${index}`;
			entries.push({
				server: serviceId,
				service: serviceId,
				label: `Overflow ${index}`,
				url: ENDPOINT,
				aliases: [],
				transport: { type: "http", url: ENDPOINT },
				auth: { strategy: "none", clientRegistration: "unknown" },
				setup: { status: "ready" },
				verification: { status: "unverified" as const },
				legacyBuiltin: false,
				provenance: [],
			});
		}
		const records = [record("overflow-5"), record("vanished-source-pin")];
		const resolution = resolveMcpServiceCatalog({
			localSources: ["synthetic-overflow.json"],
			loadLocal: () => ({ path: "synthetic-overflow.json", entries }),
			records,
		});
		// byId = built-ins + 600 synthetic source entries + 1 pin. Kept anchors =
		// installed (overflow-5, pin) UNION legacy builtins; the rest fill to the
		// cap, so only un-installed discovery extras are dropped.
		expect(resolution.descriptors.length).toBe(500);
		const keptIds = new Set(resolution.descriptors.map((d) => d.serviceId));
		expect(keptIds.has("overflow-5"), "installed descriptor still present in source must survive").toBe(true);
		expect(keptIds.has("vanished-source-pin"), "vanished-source pin must survive").toBe(true);
		expect(keptIds.has("linear"), "legacy builtin anchors must survive overflow").toBe(true);
		expect(keptIds.has("notion")).toBe(true);
		const installed = resolution.descriptors.find((d) => d.serviceId === "overflow-5");
		expect(installed?.transport).toEqual({ type: "http", url: ENDPOINT });
		const diagnostics = resolution.diagnostics.join("\n");
		expect(diagnostics, "the soft discovery cap must be surfaced honestly").toContain("capped");
		// Total is SERVICE_CATALOG.length + 600 + 1; kept anchors + fill is
		// exactly the cap, so the ignored discovery count is total minus cap.
		const expectedIgnored = SERVICE_CATALOG.length + 601 - 500;
		expect(diagnostics).toContain(`${expectedIgnored} entries were ignored`);
	});

	it("legacy builtin descriptors survive the cap: reserved-name protection and credential-only manageability never drop", () => {
		// >500 installed rows consume the entire cap on the current fill
		// policy. The un-installed LEGACY BUILTINS (linear/notion) must NOT be
		// dropped with the rest: their descriptors carry (a) the reserved-name
		// shadow protection and (b) manageability for credential-only legacy
		// accounts (a stored grant with no record pins nothing).
		const legacyLinear = SERVICE_CATALOG.find((entry) => entry.legacyBuiltin && entry.server === "linear");
		const legacyNotion = SERVICE_CATALOG.find((entry) => entry.legacyBuiltin && entry.server === "notion");
		expect(legacyLinear, "the real catalog must carry the linear legacy builtin").toBeDefined();
		expect(legacyNotion, "the real catalog must carry the notion legacy builtin").toBeDefined();

		const entries: McpServiceEntry[] = [];
		const records: McpConnectionRecord[] = [];
		for (let index = 0; index < 505; index++) {
			const serviceId = `mass-${index}`;
			entries.push({
				server: serviceId,
				service: serviceId,
				label: `Mass ${index}`,
				url: ENDPOINT,
				aliases: [],
				transport: { type: "http", url: ENDPOINT },
				auth: { strategy: "none", clientRegistration: "unknown" },
				setup: { status: "ready" },
				verification: { status: "unverified" as const },
				legacyBuiltin: false,
				provenance: [],
			});
			records.push(record(serviceId));
		}
		const resolution = resolveMcpServiceCatalog({
			localSources: ["mass-installed.json"],
			loadLocal: () => ({ path: "mass-installed.json", entries }),
			records,
		});
		expect(
			resolution.descriptors.some((d) => d.serviceId === "linear" && d.legacyBuiltin),
			"the linear builtin descriptor must survive an installed-full catalog",
		).toBe(true);

		// Reserved-name protection must survive the cap: a user-declared
		// shadow of the legacy id with a bound grant stays DEAD.
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "shadow-token",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://shadow.example.test/mcp",
		});
		const shadowManager = new McpManager({
			authStorage,
			connectionStore: store,
			noBackgroundVerification: true,
			getServiceCatalog: () => resolution.descriptors,
			getUserServers: () => ({
				linear: { type: "http", url: "https://shadow.example.test/mcp", oauth: true },
			}),
		});
		expect(
			shadowManager.getEnabledPersistentGenericServers(),
			"a capped catalog must not lose the reserved-name shadow protection",
		).not.toContain("linear");

		// Credential-only legacy account (stored grant, NO record): the
		// surviving descriptor keeps it visible and manageable.
		authStorage.set("mcp:notion", {
			type: "oauth",
			access: "legacy-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.notion.com/mcp",
		});
		const legacyManager = new McpManager({
			authStorage,
			connectionStore: store,
			noBackgroundVerification: true,
			getServiceCatalog: () => resolution.descriptors,
		});
		expect(
			legacyManager.listStatus().find((row) => row.server === "notion")?.enabled,
			"a credential-only legacy account must stay visible and enabled when its descriptor survives",
		).toBe(true);
	});

	it("keeps every installed row and legacy anchors when installed connections alone exceed the cap", () => {
		const entries: McpServiceEntry[] = [];
		const records: McpConnectionRecord[] = [];
		for (let index = 0; index < 505; index++) {
			const serviceId = `installed-${index}`;
			entries.push({
				server: serviceId,
				service: serviceId,
				label: `Installed ${index}`,
				url: ENDPOINT,
				aliases: [],
				transport: { type: "http", url: ENDPOINT },
				auth: { strategy: "none", clientRegistration: "unknown" },
				setup: { status: "ready" },
				verification: { status: "unverified" as const },
				legacyBuiltin: false,
				provenance: [],
			});
			records.push(record(serviceId));
		}
		const resolution = resolveMcpServiceCatalog({
			localSources: ["synthetic-installed.json"],
			loadLocal: () => ({ path: "synthetic-installed.json", entries }),
			records,
		});
		// Installed inventory is uncapped; legacy anchors ride along.
		const keptIds = new Set(resolution.descriptors.map((d) => d.serviceId));
		expect(resolution.descriptors.filter((d) => d.serviceId.startsWith("installed-")).length).toBe(505);
		expect(keptIds.has("linear"), "legacy anchors must be retained beside the installed inventory").toBe(true);
		expect(keptIds.has("notion")).toBe(true);
		expect(resolution.descriptors.length).toBe(507);
		const diagnostics = resolution.diagnostics.join("\n");
		expect(diagnostics, "the diagnostic must state the cap was exceeded by installed inventory").toContain("capped");
		expect(diagnostics).toContain("505");
	});
});
