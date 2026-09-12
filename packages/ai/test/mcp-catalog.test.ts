import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AuditFile,
	buildCatalog,
	type ClaudeFixture,
	type OpenAiFixture,
	type Overrides,
} from "../scripts/import-mcp-catalog.js";
import {
	BUILTIN_MCP_CATALOG,
	getCatalogEntry,
	getServiceCatalogEntry,
	listServiceCatalog,
	type McpServiceEntry,
	registerBuiltinMcpOAuthProviders,
	SERVICE_CATALOG,
	searchServiceCatalog,
	validateMcpServiceEntry,
} from "../src/mcp/catalog.js";
import {
	loadLocalServiceCatalog,
	MAX_LOCAL_CATALOG_BYTES,
	MAX_LOCAL_CATALOG_ENTRIES,
	userProvenance,
} from "../src/mcp/local-catalog.js";
import { getOAuthProvider, resetOAuthProviders } from "../src/utils/oauth/index.js";

const catalogDir = path.resolve(__dirname, "../mcp-catalog");
const rawCatalogJson = fs.readFileSync(path.resolve(__dirname, "../src/mcp/catalog.json"), "utf8");

function loadInputs(): {
	openAi: OpenAiFixture;
	claude: ClaudeFixture;
	overrides: Overrides;
	audit: AuditFile;
} {
	return {
		openAi: JSON.parse(fs.readFileSync(path.join(catalogDir, "sources/openai-plugins.json"), "utf8")),
		claude: JSON.parse(fs.readFileSync(path.join(catalogDir, "sources/claude-plugins-official.json"), "utf8")),
		overrides: JSON.parse(fs.readFileSync(path.join(catalogDir, "overrides.json"), "utf8")),
		audit: JSON.parse(fs.readFileSync(path.join(catalogDir, "audit/metadata-audit.json"), "utf8")),
	};
}

describe("MCP service catalog", () => {
	it("loads, validates and orders the merged catalog", () => {
		expect(SERVICE_CATALOG.length).toBeGreaterThan(100);
		const ids = SERVICE_CATALOG.map((entry) => entry.server);
		for (let index = 1; index < ids.length; index++) {
			expect(ids[index - 1] < ids[index]).toBe(true);
		}
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("keeps the legacy built-in slice exactly linear and notion", () => {
		expect(BUILTIN_MCP_CATALOG.map((entry) => entry.server)).toEqual(["linear", "notion"]);
		const linear = getCatalogEntry("linear");
		const notion = getCatalogEntry("notion");
		expect(linear).toMatchObject({
			server: "linear",
			label: "Linear",
			url: "https://mcp.linear.app/mcp",
		});
		expect(linear?.oauth).toEqual({ kind: "oauth" });
		expect(notion).toMatchObject({
			server: "notion",
			label: "Notion",
			url: "https://mcp.notion.com/mcp",
		});
		expect(notion?.oauth).toEqual({ kind: "oauth" });
		// The legacy lookup stays legacy-builtin-only: imported services are not "built-in".
		expect(getCatalogEntry("github")).toBeUndefined();
	});

	it("registers only the built-in OAuth providers, idempotently", () => {
		resetOAuthProviders();
		registerBuiltinMcpOAuthProviders();
		registerBuiltinMcpOAuthProviders();
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
		// Imported catalog services are not eagerly registered.
		expect(getOAuthProvider("mcp:figma")).toBeUndefined();
		expect(getOAuthProvider("mcp:slack")).toBeUndefined();
	});

	it("resolves and searches services deterministically", () => {
		expect(getServiceCatalogEntry("notion")?.url).toBe("https://mcp.notion.com/mcp");
		expect(getServiceCatalogEntry("does-not-exist")).toBeUndefined();
		expect(listServiceCatalog()).toBe(SERVICE_CATALOG);
		const notionHits = searchServiceCatalog("Notion");
		expect(notionHits.map((entry) => entry.server)).toEqual(["notion"]);
		expect(searchServiceCatalog("")).toEqual([]);
		const zoomHits = searchServiceCatalog("zoom");
		const zoomServers = zoomHits.map((entry) => entry.server);
		for (const server of ["zoom", "zoom-meetings", "zoom-chat", "zoom-whiteboard"]) {
			expect(zoomServers).toContain(server);
		}
		// Substring search also surfaces the distinct ZoomInfo brand; that is expected.
		expect(zoomServers).toContain("zoominfo");
		expect(zoomHits.filter((entry) => entry.service === "zoom")).toHaveLength(7);
		// A merged upstream plugin name still finds the canonical entry.
		expect(searchServiceCatalog("monday-crm").map((entry) => entry.server)).toEqual(["monday-com"]);
	});

	it("merges the same service across sources into one canonical entry", () => {
		for (const server of ["notion", "linear", "github", "figma", "stripe"]) {
			const entry = getServiceCatalogEntry(server);
			const sources = new Set(entry?.provenance.map((prov) => prov.source));
			expect(sources.has("openai-plugins")).toBe(true);
			expect(sources.has("claude-plugins-official")).toBe(true);
		}
		// Sentry merges modulo utm tracking params and keeps the clean endpoint.
		const sentry = getServiceCatalogEntry("sentry");
		expect(sentry?.url).toBe("https://mcp.sentry.dev/mcp");
		expect(new Set(sentry?.provenance.map((prov) => prov.source)).size).toBe(2);
	});

	it("keeps distinct products and reviewed endpoint variants separate", () => {
		for (const server of ["gmail", "google-drive", "google-calendar"]) {
			expect(getServiceCatalogEntry(server)).toBeDefined();
		}
		expect(getServiceCatalogEntry("gmail")?.url).not.toBe(getServiceCatalogEntry("google-drive")?.url);
		// Zoom product endpoints stay distinct; the merged meeting endpoint keeps both sources.
		expect(getServiceCatalogEntry("zoom")?.url).toBe("https://mcp.zoom.us/mcp/zoom/streamable");
		const meetings = getServiceCatalogEntry("zoom-meetings");
		expect(meetings?.url).toBe("https://mcp.zoom.us/mcp/meeting/streamable");
		expect(new Set(meetings?.provenance.map((prov) => prov.source).filter((source) => source !== "prime"))).toEqual(
			new Set(["openai-plugins", "claude-plugins-official"]),
		);
		// Vanta regions are separate reviewed endpoints of one brand.
		expect(getServiceCatalogEntry("vanta")?.url).toBe("https://mcp.vanta.com/mcp");
		expect(getServiceCatalogEntry("vanta-eu")?.url).toBe("https://mcp.eu.vanta.com/mcp");
		expect(getServiceCatalogEntry("vanta-aus")?.url).toBe("https://mcp.aus.vanta.com/mcp");
	});

	it("carries no branded client ids, placeholders, secrets or hosted app ids", () => {
		for (const forbidden of [
			"1601185624273.8899143856786",
			"11843774967.11905492103734",
			"<GMAIL_PUBLIC_CLIENT_ID>",
			"<GMAIL_CLIENT_SECRET>",
			"asdk_app_",
			"claude.ai/oauth/claude-code-client-metadata",
		]) {
			expect(rawCatalogJson).not.toContain(forbidden);
		}
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
				return;
			}
			if (value && typeof value === "object") {
				for (const [key, child] of Object.entries(value)) {
					expect(["client_id", "clientId", "client_secret"]).not.toContain(key);
					walk(child);
				}
			}
		};
		walk(JSON.parse(rawCatalogJson));
	});

	it("marks known setup blockers honestly and imports no reviewed scope lists", () => {
		const slack = getServiceCatalogEntry("slack");
		expect(slack?.auth).toMatchObject({ strategy: "oauth", clientRegistration: "pre-registered" });
		expect(slack?.setup.status).toBe("requires-setup");
		expect(slack?.setup.reason).toMatch(/dynamic client registration/i);
		// Placeholder-only upstream blocks were cleared with evidence: Airtable
		// now Connects with OAuth DCR, Shopify stays attemptable with honest unknowns.
		for (const server of ["airtable", "shopify"]) {
			const entry = getServiceCatalogEntry(server);
			expect(entry?.setup.status).toBe("ready");
			expect(entry?.setup.reason).toBeUndefined();
			expect(entry?.setup.reason ?? "").not.toMatch(/placeholder/i);
		}
		// Genuine docs-anchored restrictions are kept, with research-anchored reasons.
		for (const server of ["gmail", "google-calendar", "google-drive"]) {
			const entry = getServiceCatalogEntry(server);
			expect(entry?.setup.status).toBe("requires-setup");
			expect(entry?.setup.requirement).toBe("registered-client");
			expect(entry?.setup.reason).toMatch(/Developer Preview/i);
			expect(entry?.setup.reason ?? "").not.toMatch(/placeholder/i);
		}
		for (const server of ["gmail", "google-calendar", "google-drive"]) {
			const entry = getServiceCatalogEntry(server);
			expect(entry?.auth.reviewedScopes).toBeUndefined();
			expect(entry?.oauth?.scopes).toBeUndefined();
		}
		const github = getServiceCatalogEntry("github");
		expect(github?.auth.strategy).toBe("api_key");
		expect(github?.setup.fields?.map((field) => field.id).sort()).toEqual([
			"GITHUB_PAT_TOKEN",
			"GITHUB_PERSONAL_ACCESS_TOKEN",
		]);
	});

	it("classifies readiness from committed audit evidence without blanket bans", () => {
		// Ready entries are never downgraded by missing evidence, and a metadata GET
		// is never proof of live OAuth: oauth-ready requires audience-coherent
		// DCR evidence; everything else stays honestly unknown.
		const airtable = getServiceCatalogEntry("airtable");
		expect(airtable?.setup.status).toBe("ready");
		expect(airtable?.setup.readiness).toBe("oauth-ready");
		expect(airtable?.auth.metadata?.dynamicClientRegistration).toBe(true);
		expect(airtable?.auth.metadata?.note).toBeUndefined();
		expect(airtable?.auth.alternatives).toEqual([
			expect.objectContaining({ kind: "api-key", readiness: "user-setup" }),
		]);
		const shopify = getServiceCatalogEntry("shopify");
		expect(shopify?.setup.status).toBe("ready");
		expect(shopify?.setup.readiness).toBe("unknown");
		expect(shopify?.auth.metadata?.status).toBe("unavailable");
		const linear = getServiceCatalogEntry("linear");
		expect(linear?.setup.readiness).toBe("oauth-ready");
		expect(linear?.auth.metadata?.dynamicClientRegistration).toBe(true);
		expect(linear?.auth.metadata?.note).toBeUndefined();
		// Notion: the engine component comparison accepts the pathful document
		// served via the header pointer (exact endpoint match).
		const notion = getServiceCatalogEntry("notion");
		expect(notion?.setup.readiness).toBe("oauth-ready");
		expect(notion?.auth.metadata?.note).toBeUndefined();
		// CIMD alone is never oauth-ready (no Prime-controlled identity deployed).
		const synthflow = getServiceCatalogEntry("synthflow");
		expect(synthflow?.setup.readiness).toBe("unknown");
		// The component comparison accepts exact-origin resources (root-slash
		// normalized): the 9 DCR-capable origin-mismatched entries flipped.
		for (const server of ["amplitude", "appwrite", "lovable", "miro", "rootly", "vercel", "windsor-ai", "zoominfo"]) {
			expect(getServiceCatalogEntry(server)?.setup.readiness).toBe("oauth-ready");
		}
		// LogRocket fails closed even under the component rule: its resource keeps
		// the path but drops the ?toolsets=all query, matching neither the exact
		// endpoint nor the origin.
		const logrocket = getServiceCatalogEntry("logrocket");
		expect(logrocket?.setup.readiness).toBe("unknown");
		expect(logrocket?.auth.metadata?.note).toMatch(/matches neither the exact endpoint nor the origin/);
		// DCR-less mismatched providers never become oauth-ready.
		expect(getServiceCatalogEntry("hubspot")?.setup.readiness).toBe("unknown");
		// Prime-restricted: registered-client requirements stay hard, research-anchored.
		for (const server of ["gmail", "google-calendar", "google-drive", "slack", "mongodb-atlas"]) {
			const entry = getServiceCatalogEntry(server);
			expect(entry?.setup.status).toBe("requires-setup");
			expect(entry?.setup.readiness).toBe("prime-restricted");
			expect(entry?.setup.requirement).toBe("registered-client");
		}
		const mongo = getServiceCatalogEntry("mongodb-atlas");
		expect(mongo?.auth.alternatives).toEqual([
			expect.objectContaining({ kind: "service-account", readiness: "user-setup" }),
		]);
		// Documented user-supplied credentials stay primary; OAuth alternatives stay unknown.
		const render = getServiceCatalogEntry("render");
		expect(render?.setup.status).toBe("requires-setup");
		expect(render?.setup.readiness).toBe("user-setup");
		expect(render?.setup.requirement).toBe("api-key");
		expect(render?.auth.alternatives).toEqual([expect.objectContaining({ kind: "oauth", readiness: "unknown" })]);
		const github = getServiceCatalogEntry("github");
		expect(github?.setup.readiness).toBe("user-setup");
		expect(github?.setup.requirement).toBe("bearer-token");
		expect(github?.auth.alternatives).toEqual([expect.objectContaining({ kind: "oauth", readiness: "unknown" })]);
		for (const field of github?.setup.fields ?? []) {
			expect(field.kind).toBe("bearer-token");
		}
		// Tenant, transport and local-runtime requirements are classified.
		expect(getServiceCatalogEntry("cockroachdb")?.setup.requirement).toBe("tenant");
		expect(getServiceCatalogEntry("jfrog")?.setup.requirement).toBe("tenant");
		expect(getServiceCatalogEntry("paypal-sandbox")?.setup.requirement).toBe("unsupported-transport");
		expect(getServiceCatalogEntry("aikido")?.setup.requirement).toBe("local-runtime");
		expect(getServiceCatalogEntry("zoom")?.setup.requirement).toBe("bearer-token");
		// Readiness is informational-only data; the raw counts are in the file.
		const committed = JSON.parse(rawCatalogJson);
		expect(
			committed.counts.readinessOauthReady +
				committed.counts.readinessUserSetup +
				committed.counts.readinessPrimeRestricted +
				committed.counts.readinessUnknown,
		).toBe(committed.counts.total);
		expect(committed.counts.metadataAvailable + committed.counts.metadataUnavailable).toBe(
			committed.counts.http + committed.counts.sse,
		);
		// Metadata evidence blocks exist only on audited remote entries, all stamped
		// with the same committed audit snapshot date.
		const fetchedAt = loadInputs().audit.fetchedAt;
		for (const entry of SERVICE_CATALOG) {
			if (entry.transport.type === "http" || entry.transport.type === "sse") {
				expect(entry.auth.metadata?.status).toBeDefined();
				expect(entry.auth.metadata?.fetchedAt).toBe(fetchedAt);
			} else {
				expect(entry.auth.metadata).toBeUndefined();
			}
		}
		// Observational AS scope universes are recorded but never imported as
		// reviewed scopes, and no entry ever auto-requests them.
		for (const entry of SERVICE_CATALOG) {
			expect(entry.auth.reviewedScopes).toBeUndefined();
		}
	});

	it("flags stdio, sse and tenant-URL adapters as not one-click", () => {
		const stdio = SERVICE_CATALOG.filter((entry) => entry.transport.type === "stdio");
		expect(stdio.length).toBe(32);
		for (const entry of stdio) {
			expect(entry.setup.status).toBe("requires-setup");
			expect(entry.url).toBe("");
			expect(entry.setup.reason).toMatch(/local stdio adapter/i);
		}
		const paypal = getServiceCatalogEntry("paypal-sandbox");
		expect(paypal?.transport.type).toBe("sse");
		expect(paypal?.setup.status).toBe("requires-setup");
		for (const server of ["jfrog", "sourcegraph", "dynatrace", "activecampaign", "pigment"]) {
			const entry = getServiceCatalogEntry(server);
			expect(entry?.transport.type).toBe("http-template");
			expect(entry?.setup.status).toBe("requires-setup");
			expect(entry?.url).toBe("");
		}
	});

	it("marks only the legacy built-ins as metadata-reviewed; every import stays unverified", () => {
		const metadataReviewed = SERVICE_CATALOG.filter((entry) => entry.verification.status === "metadata-reviewed");
		expect(metadataReviewed.map((entry) => entry.server).sort()).toEqual(["linear", "notion"]);
		for (const entry of SERVICE_CATALOG) {
			if (entry.server === "linear" || entry.server === "notion") continue;
			expect(entry.verification.status).toBe("unverified");
		}
		// The review claim is scoped to public metadata, not runtime interop.
		const linear = getServiceCatalogEntry("linear");
		const primeNote = linear?.provenance.find((prov) => prov.source === "prime")?.note ?? "";
		expect(primeNote).toMatch(/reviewed against public provider metadata/);
		expect(primeNote).not.toMatch(/verified against/);
	});

	it("rejects malformed entries and literal private endpoints", () => {
		const good = getServiceCatalogEntry("linear");
		expect(good).toBeDefined();
		expect(() => validateMcpServiceEntry(good)).not.toThrow();
		if (!good) throw new Error("unreachable");
		expect(() => validateMcpServiceEntry({ ...good, server: "Not Upper" })).toThrow(/server id/);
		expect(() => validateMcpServiceEntry({ ...good, auth: { ...good.auth, strategy: "weird" } })).toThrow(/strategy/);
		expect(() =>
			validateMcpServiceEntry({ ...good, oauth: { kind: "oauth" }, auth: { ...good.auth, strategy: "api_key" } }),
		).toThrow(/oauth is only allowed on oauth-strategy/);
		// Client ids and secrets both fail loudly in catalog data — secrets are
		// rejected explicitly, never silently dropped.
		expect(() => validateMcpServiceEntry({ ...good, oauth: { kind: "oauth", clientId: "abc" } })).toThrow(
			/client ids/,
		);
		for (const secretShape of [{ clientSecret: "shh" }, { client_secret: "shh" }]) {
			expect(() => validateMcpServiceEntry({ ...good, oauth: { kind: "oauth", ...secretShape } })).toThrow(
				/client secrets/,
			);
		}
		expect(() => validateMcpServiceEntry({ ...good, aliases: ["linear", "Linear"] })).toThrow(/aliases/);
		// Literal loopback/private/link-local/unspecified endpoints are rejected structurally.
		for (const badUrl of [
			"https://127.0.0.1/mcp",
			"https://127.0.0.2/mcp",
			"https://127.8.8.8/mcp",
			"https://[::1]/mcp",
			"https://[::]/mcp",
			"https://[::ffff:127.0.0.1]/mcp",
			"https://10.1.2.3/mcp",
			"https://172.16.0.1/mcp",
			"https://192.168.1.4/mcp",
			"https://169.254.1.1/mcp",
			"https://0.0.0.0/mcp",
			"https://[fe80::1]/mcp",
			"https://localhost/mcp",
			"https://box.localhost/mcp",
		]) {
			expect(() =>
				validateMcpServiceEntry({ ...good, transport: { type: "http", url: badUrl }, url: badUrl }),
			).toThrow(/loopback, private/);
		}
		// Public hosts are untouched by the literal checks.
		expect(
			validateMcpServiceEntry({
				...good,
				transport: { type: "http", url: "https://mcp.example.com/mcp" },
				url: "https://mcp.example.com/mcp",
			}),
		).toBeDefined();
	});

	it("rebuilds the committed catalog byte-for-byte from the pinned fixtures", async () => {
		const inputs = loadInputs();
		const { catalog } = buildCatalog(inputs.openAi, inputs.claude, inputs.overrides, inputs.audit);
		const rebuilt = JSON.parse(JSON.stringify(catalog));
		const committed = JSON.parse(rawCatalogJson);
		expect(rebuilt).toEqual(committed);
		// The generated TS mirror must match the canonical JSON exactly.
		const { CATALOG_DATA } = await import("../src/mcp/catalog.data.generated.js");
		expect(JSON.parse(JSON.stringify(CATALOG_DATA))).toEqual(committed);
		// Deterministic: a second run produces identical output.
		const again = buildCatalog(inputs.openAi, inputs.claude, inputs.overrides, inputs.audit);
		expect(JSON.stringify(again.catalog)).toBe(JSON.stringify(catalog));
	});

	it("counts the sources before dedupe and records every exclusion", () => {
		const inputs = loadInputs();
		const { report } = buildCatalog(inputs.openAi, inputs.claude, inputs.overrides, inputs.audit);
		expect(inputs.openAi.plugins).toHaveLength(25);
		expect(inputs.claude.plugins).toHaveLength(118);
		expect(report.sources["openai-plugins"].remoteServers).toBe(25);
		expect(report.sources["claude-plugins-official"].stdioServers).toBe(43);
		// Documented exclusions are all present with reasons.
		expect(report.excluded.length).toBeGreaterThan(0);
		for (const exclusion of report.excluded) {
			expect(exclusion.reason.length).toBeGreaterThan(3);
		}
		expect(report.excluded.map((entry) => entry.key)).toContain("claude-plugins-official/dropbox/claude_app_mcp");
	});
});

describe("Local MCP service sources", () => {
	function tempDir(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-local-"));
	}

	function writeLocal(dir: string, name: string, data: unknown): string {
		const filePath = path.join(dir, name);
		fs.writeFileSync(filePath, typeof data === "string" ? data : JSON.stringify(data, null, "\t"));
		return filePath;
	}

	function validLocalEntry(overrides: Partial<McpServiceEntry> = {}): Record<string, unknown> {
		return {
			server: "acme-docs",
			service: "acme-docs",
			label: "Acme Docs",
			url: "https://mcp.docs.acme.example.com/mcp",
			aliases: ["acme", "acme documentation"],
			transport: { type: "http", url: "https://mcp.docs.acme.example.com/mcp" },
			auth: { strategy: "oauth", clientRegistration: "unknown" },
			setup: { status: "ready" },
			verification: { status: "unverified" },
			legacyBuiltin: false,
			provenance: [userProvenance("added locally by the user")],
			...overrides,
		};
	}

	it("loads and validates a local source file", () => {
		const dir = tempDir();
		const filePath = writeLocal(dir, "mcp-services.json", {
			version: 1,
			entries: [validLocalEntry()],
		});
		const result = loadLocalServiceCatalog(filePath);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].server).toBe("acme-docs");
		expect(result.entries[0].provenance[0].source).toBe("user");
		expect(result.path).toBe(filePath);
	});

	it("treats a missing file as empty and refuses directories", () => {
		const dir = tempDir();
		expect(loadLocalServiceCatalog(path.join(dir, "absent.json"))).toEqual({ entries: [], path: "" });
		expect(() => loadLocalServiceCatalog(dir)).toThrow(/directories, FIFOs and devices are refused/);
	});

	it("bounds file size and entry counts with visible errors", () => {
		const dir = tempDir();
		const big = writeLocal(dir, "big.json", {
			version: 1,
			entries: [validLocalEntry(), { note: "x".repeat(MAX_LOCAL_CATALOG_BYTES) }],
		});
		expect(() => loadLocalServiceCatalog(big)).toThrow(/bytes/);
		const many = {
			version: 1,
			entries: Array.from({ length: MAX_LOCAL_CATALOG_ENTRIES + 1 }, (_value, index) =>
				validLocalEntry({
					server: `acme-${index}`,
					service: `acme-${index}`,
					url: `https://mcp-${index}.acme.example.com/mcp`,
					transport: { type: "http", url: `https://mcp-${index}.acme.example.com/mcp` },
				}),
			),
		};
		const manyPath = writeLocal(dir, "many.json", many);
		expect(() => loadLocalServiceCatalog(manyPath)).toThrow(new RegExp(`maximum is ${MAX_LOCAL_CATALOG_ENTRIES}`));
	});

	it("rejects bad versions, malformed JSON and invalid entries with file context", () => {
		const dir = tempDir();
		const badVersion = writeLocal(dir, "bad-version.json", { version: 2, entries: [] });
		expect(() => loadLocalServiceCatalog(badVersion)).toThrow(/unsupported version/);
		const badJson = writeLocal(dir, "bad.json", "{ not json");
		expect(() => loadLocalServiceCatalog(badJson)).toThrow(/not valid JSON/);
		const invalidEntry = writeLocal(dir, "invalid.json", {
			version: 1,
			entries: [validLocalEntry({ url: "" })],
		});
		expect(() => loadLocalServiceCatalog(invalidEntry)).toThrow(/entry 0/);
	});

	it("never lets local entries claim vendor or Prime trust", () => {
		const dir = tempDir();
		const vendor = writeLocal(dir, "vendor.json", {
			version: 1,
			entries: [
				validLocalEntry({
					provenance: [{ source: "openai-plugins", repository: "openai/plugins" }],
				}),
			],
		});
		expect(() => loadLocalServiceCatalog(vendor)).toThrow(/may only carry provenance source "user"/);
		const prime = writeLocal(dir, "prime.json", {
			version: 1,
			entries: [validLocalEntry({ provenance: [{ source: "prime" }] })],
		});
		expect(() => loadLocalServiceCatalog(prime)).toThrow(/may only carry provenance source "user"/);
	});

	it("refuses to shadow or rebind bundled ids and duplicates within the file", () => {
		const dir = tempDir();
		const collision = writeLocal(dir, "collision.json", {
			version: 1,
			entries: [validLocalEntry({ server: "notion", service: "notion", label: "Notion" })],
		});
		expect(() => loadLocalServiceCatalog(collision)).toThrow(/collides with the bundled catalog entry/);
		const duplicate = writeLocal(dir, "duplicate.json", {
			version: 1,
			entries: [validLocalEntry(), validLocalEntry()],
		});
		expect(() => loadLocalServiceCatalog(duplicate)).toThrow(/duplicate local id/);
	});

	it("applies the same literal endpoint rules to local sources", () => {
		const dir = tempDir();
		const loopback = writeLocal(dir, "loopback.json", {
			version: 1,
			entries: [
				validLocalEntry({
					server: "acme-local",
					url: "https://127.0.0.2/mcp",
					transport: { type: "http", url: "https://127.0.0.2/mcp" },
				}),
			],
		});
		expect(() => loadLocalServiceCatalog(loopback)).toThrow(/loopback, private/);
		// IPv6 unique-local fc00::/7 is rejected like other private ranges.
		for (const badUrl of ["https://[fc00::1]/mcp", "https://[fd12::3456]/mcp"]) {
			const ula = writeLocal(dir, `ula-${badUrl.slice(8, 13)}.json`, {
				version: 1,
				entries: [
					validLocalEntry({
						server: "acme-ula",
						url: badUrl,
						transport: { type: "http", url: badUrl },
					}),
				],
			});
			expect(() => loadLocalServiceCatalog(ula)).toThrow(/loopback, private/);
		}
	});

	it("never lets local entries self-assert legacy-builtin or review status", () => {
		const dir = tempDir();
		const builtin = writeLocal(dir, "builtin.json", {
			version: 1,
			entries: [validLocalEntry({ legacyBuiltin: true })],
		});
		expect(() => loadLocalServiceCatalog(builtin)).toThrow(/cannot claim legacyBuiltin/);
		const reviewed = writeLocal(dir, "reviewed.json", {
			version: 1,
			entries: [validLocalEntry({ verification: { status: "metadata-reviewed" } })],
		});
		expect(() => loadLocalServiceCatalog(reviewed)).toThrow(/local sources are always unverified/);
		// Audit-derived readiness and evidence are Prime assessments; a local file
		// cannot self-assert them. setup.requirement stays allowed as honest
		// self-description of the user's own service.
		const readiness = writeLocal(dir, "readiness.json", {
			version: 1,
			entries: [validLocalEntry({ setup: { status: "ready", readiness: "oauth-ready" } })],
		});
		expect(() => loadLocalServiceCatalog(readiness)).toThrow(/cannot claim setup.readiness/);
		const withRequirement = writeLocal(dir, "requirement.json", {
			version: 1,
			entries: [
				validLocalEntry({
					setup: { status: "requires-setup", reason: "needs an api key", requirement: "api-key" },
				}),
			],
		});
		expect(loadLocalServiceCatalog(withRequirement).entries[0].setup.requirement).toBe("api-key");
		const evidence = writeLocal(dir, "evidence.json", {
			version: 1,
			entries: [
				validLocalEntry({
					auth: {
						strategy: "oauth",
						clientRegistration: "dynamic",
						metadata: {
							status: "available",
							sourceUrls: ["https://mcp.docs.acme.example.com/mcp"],
							fetchedAt: "2026-09-12",
						},
					},
				}),
			],
		});
		expect(() => loadLocalServiceCatalog(evidence)).toThrow(/cannot carry auth.alternatives or auth.metadata/);
	});

	it("refuses special files instead of hanging on them", () => {
		const dir = tempDir();
		// Directories are refused up front.
		expect(() => loadLocalServiceCatalog(dir)).toThrow(/not a regular file/);
		// FIFOs (POSIX only) must be refused as non-regular files, never read.
		if (process.platform !== "win32") {
			const fifoPath = path.join(dir, "fifo");
			execFileSync("mkfifo", [fifoPath]);
			expect(() => loadLocalServiceCatalog(fifoPath)).toThrow(/not a regular file/);
		}
	});

	it("bounds the actual read, not a stale stat size", () => {
		const dir = tempDir();
		// A file larger than the maximum is refused from the bounded read itself.
		const big = writeLocal(dir, "big.json", {
			version: 1,
			entries: [validLocalEntry(), { note: "x".repeat(MAX_LOCAL_CATALOG_BYTES) }],
		});
		expect(() => loadLocalServiceCatalog(big)).toThrow(new RegExp(`maximum of ${MAX_LOCAL_CATALOG_BYTES} bytes`));
	});

	it("never echoes raw input values in diagnostics", () => {
		const dir = tempDir();
		const marker = "SYNTHETIC_SECRET_TOKEN_XYZ";
		// Malformed JSON containing a secret-looking marker.
		const badJson = writeLocal(
			dir,
			"bad.json",
			`{
  "entries": [{"token": "${marker}"}]`,
		);
		let message = "";
		try {
			loadLocalServiceCatalog(badJson);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/not valid JSON/);
		expect(message).not.toContain(marker);
		// A syntactically invalid URL input triggers the no-echo parse failure.
		const badUrlEntry = writeLocal(dir, "bad-url-entry.json", {
			version: 1,
			entries: [
				validLocalEntry({
					url: "ht tp://ex ample",
					transport: { type: "http", url: "ht tp://ex ample" },
				}),
			],
		});
		let urlMessage = "";
		try {
			loadLocalServiceCatalog(badUrlEntry);
		} catch (error) {
			urlMessage = (error as Error).message;
		}
		expect(urlMessage).toMatch(/not an absolute URL/);
		expect(urlMessage).not.toContain("ht tp://ex ample");
		// An entry id that is oversized/secret-ish is echoed only in bounded form.
		const longId = "a".repeat(300) + marker;
		const longIdFile = writeLocal(dir, "long-id.json", {
			version: 1,
			entries: [validLocalEntry({ server: longId, service: longId })],
		});
		let idMessage = "";
		try {
			loadLocalServiceCatalog(longIdFile);
		} catch (error) {
			idMessage = (error as Error).message;
		}
		expect(idMessage).toMatch(/server id/);
		expect(idMessage).not.toContain(marker);
		expect(idMessage.length).toBeLessThan(400);
	});
});
