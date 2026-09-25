import { describe, expect, it } from "vitest";
import {
	BUILTIN_MCP_CATALOG,
	getCatalogEntry,
	getServiceCatalogEntry,
	listServiceCatalog,
	parseMcpServiceCatalogFile,
	registerBuiltinMcpOAuthProviders,
	SERVICE_CATALOG,
	validateMcpServiceEntry,
} from "../src/mcp/catalog.js";
import { getOAuthProvider, resetOAuthProviders } from "../src/utils/oauth/index.js";

describe("MCP fallback service catalog", () => {
	it("ships only the tiny legacy fallback catalog", () => {
		expect(SERVICE_CATALOG.map((entry) => entry.server)).toEqual(["linear", "notion"]);
		expect(BUILTIN_MCP_CATALOG.map((entry) => entry.server)).toEqual(["linear", "notion"]);
		expect(getCatalogEntry("linear")?.url).toBe("https://mcp.linear.app/mcp");
		expect(getServiceCatalogEntry("notion")?.url).toBe("https://mcp.notion.com/mcp");
		expect(listServiceCatalog()).toBe(SERVICE_CATALOG);
	});

	it("registers fallback OAuth providers idempotently", () => {
		resetOAuthProviders();
		registerBuiltinMcpOAuthProviders();
		registerBuiltinMcpOAuthProviders();
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
		expect(getOAuthProvider("mcp:github")).toBeUndefined();
	});

	it("validates remote catalog envelopes fail closed", () => {
		expect(() => parseMcpServiceCatalogFile({ version: 999, entries: [] })).toThrow(/unsupported version/);
		const linear = SERVICE_CATALOG[0]!;
		expect(
			parseMcpServiceCatalogFile({ version: 2, counts: { entries: 1 }, entries: [linear] }).entries[0]?.server,
		).toBe("linear");
		expect(() => parseMcpServiceCatalogFile({ version: 2, sources: [], entries: [linear] })).toThrow(
			/catalog has unsupported keys: sources/,
		);
		expect(() => validateMcpServiceEntry({ ...linear, url: "https://evil.example/mcp" })).toThrow(
			/url must equal transport.url/,
		);
		expect(() => validateMcpServiceEntry({ ...linear, auth: { ...linear.auth, metadata: {} } })).toThrow(
			/auth has unsupported keys: metadata/,
		);
		expect(() => validateMcpServiceEntry({ ...linear, auth: { ...linear.auth, alternatives: [] } })).toThrow(
			/auth has unsupported keys: alternatives/,
		);
		expect(() =>
			validateMcpServiceEntry({ ...linear, provenance: [{ source: "prime", repository: "openai/plugins" }] }),
		).toThrow(/provenance has unsupported keys: repository/);
	});
});
