import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog, type ClaudeFixture, type OpenAiFixture, type Overrides } from "../scripts/import-mcp-catalog.js";
import {
	BUILTIN_MCP_CATALOG,
	getCatalogEntry,
	getServiceCatalogEntry,
	listServiceCatalog,
	registerBuiltinMcpOAuthProviders,
	SERVICE_CATALOG,
	searchServiceCatalog,
	validateMcpServiceEntry,
} from "../src/mcp/catalog.js";
import { getOAuthProvider, resetOAuthProviders } from "../src/utils/oauth/index.js";

const catalogDir = path.resolve(__dirname, "../mcp-catalog");
const rawCatalogJson = fs.readFileSync(path.resolve(__dirname, "../src/mcp/catalog.json"), "utf8");

function loadInputs(): { openAi: OpenAiFixture; claude: ClaudeFixture; overrides: Overrides } {
	return {
		openAi: JSON.parse(fs.readFileSync(path.join(catalogDir, "sources/openai-plugins.json"), "utf8")),
		claude: JSON.parse(fs.readFileSync(path.join(catalogDir, "sources/claude-plugins-official.json"), "utf8")),
		overrides: JSON.parse(fs.readFileSync(path.join(catalogDir, "overrides.json"), "utf8")),
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
		// The legacy lookup stays bundled-slice-only: imported services are not "built-in".
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

	it("marks known setup blockers honestly and imports no scope lists", () => {
		const slack = getServiceCatalogEntry("slack");
		expect(slack?.auth).toMatchObject({ strategy: "oauth", clientRegistration: "pre-registered" });
		expect(slack?.setup.status).toBe("requires-setup");
		expect(slack?.setup.reason).toMatch(/dynamic client registration/i);
		for (const server of ["gmail", "google-calendar", "google-drive", "airtable", "shopify"]) {
			const entry = getServiceCatalogEntry(server);
			expect(entry?.setup.status).toBe("requires-setup");
			expect(entry?.setup.reason).toMatch(/placeholder/i);
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

	it("verifies only the pre-existing built-ins and keeps every import unverified", () => {
		const verified = SERVICE_CATALOG.filter((entry) => entry.verification.status === "verified");
		expect(verified.map((entry) => entry.server).sort()).toEqual(["linear", "notion"]);
		for (const entry of SERVICE_CATALOG) {
			if (entry.server === "linear" || entry.server === "notion") continue;
			expect(entry.verification.status).toBe("unverified");
		}
	});

	it("rejects malformed entries", () => {
		const good = getServiceCatalogEntry("linear");
		expect(good).toBeDefined();
		expect(() => validateMcpServiceEntry(good)).not.toThrow();
		if (!good) throw new Error("unreachable");
		expect(() => validateMcpServiceEntry({ ...good, server: "Not Upper" })).toThrow(/server id/);
		expect(() => validateMcpServiceEntry({ ...good, transport: { type: "http", url: "http://x.dev/mcp" } })).toThrow(
			/HTTPS/,
		);
		expect(() =>
			validateMcpServiceEntry({ ...good, transport: { type: "http", url: "https://mcp.linear.app/mcp" }, url: "" }),
		).toThrow(/url must equal/);
		expect(() => validateMcpServiceEntry({ ...good, auth: { ...good.auth, strategy: "weird" } })).toThrow(/strategy/);
		expect(() =>
			validateMcpServiceEntry({ ...good, oauth: { kind: "oauth" }, auth: { ...good.auth, strategy: "api_key" } }),
		).toThrow(/oauth is only allowed on oauth-strategy/);
		expect(() => validateMcpServiceEntry({ ...good, aliases: ["linear", "Linear"] })).toThrow(/aliases/);
	});

	it("rebuilds the committed catalog byte-for-byte from the pinned fixtures", async () => {
		const inputs = loadInputs();
		const { catalog } = buildCatalog(inputs.openAi, inputs.claude, inputs.overrides);
		const rebuilt = JSON.parse(JSON.stringify(catalog));
		const committed = JSON.parse(rawCatalogJson);
		expect(rebuilt).toEqual(committed);
		// The generated TS mirror must match the canonical JSON exactly.
		const { CATALOG_DATA } = await import("../src/mcp/catalog.data.generated.js");
		expect(JSON.parse(JSON.stringify(CATALOG_DATA))).toEqual(committed);
		// Deterministic: a second run produces identical output.
		const again = buildCatalog(inputs.openAi, inputs.claude, inputs.overrides);
		expect(JSON.stringify(again.catalog)).toBe(JSON.stringify(catalog));
	});

	it("counts the sources before dedupe and records every exclusion", () => {
		const inputs = loadInputs();
		const { report } = buildCatalog(inputs.openAi, inputs.claude, inputs.overrides);
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
