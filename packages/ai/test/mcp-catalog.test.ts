import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AuditFile,
	type AuditResult,
	advertisedRegistrationGated,
	buildCatalog,
	type ClaudeFixture,
	evidenceSupportsStandardOauth,
	evidenceSupportsUserRegisteredOauth,
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
	// The committed fixtures are deterministic: load them once and share the
	// rebuild/report surface across the cut-evidence tests.
	const inputs = loadInputs();
	const buildReport = () => buildCatalog(inputs.openAi, inputs.claude, inputs.overrides, inputs.audit);
	const excludedOf = (report: ReturnType<typeof buildCatalog>["report"]) =>
		new Map(report.excluded.map((entry) => [entry.key, entry.reason]));

	it("loads, validates and orders the merged catalog", () => {
		expect(SERVICE_CATALOG.length).toBeGreaterThan(50);
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
		// Imported catalog services are not eagerly registered (figma and slack
		// were cut from the catalog entirely by the 2026-09-14 zero-app decision).
		expect(getOAuthProvider("mcp:stripe")).toBeUndefined();
		expect(getOAuthProvider("mcp:github")).toBeUndefined();
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
		// The distinct ZoomInfo brand was cut by the 2026-09-15 final cut (user-own-app OAuth is neither one-click DCR nor
		// token/key), so a zoom search stays zoom-only.
		expect(zoomServers).not.toContain("zoominfo");
		expect(zoomHits.filter((entry) => entry.service === "zoom")).toHaveLength(7);
		// The monday-crm plugin was cut by the same decision: no entry surfaces.
		expect(searchServiceCatalog("monday-crm")).toEqual([]);
	});

	it("merges the same service across sources into one canonical entry", () => {
		for (const server of ["notion", "linear", "github", "stripe"]) {
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
		// Distinct Google products (Gmail / Drive / Calendar) were never merged upstream, so after the zero-app cut they
		// are simply gone — no merged or recombined ghost of them may remain.
		for (const term of ["gmail", "google-drive", "google-calendar"]) {
			expect(searchServiceCatalog(term)).toEqual([]);
		}
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
		// Provider-client gates (Slack, Figma, Google, MongoDB) and honest unknowns are no longer in-catalog
		// classifications: the zero-app cut (2026-09-14) excludes those providers with documented per-entry reasons (see
		// the cut test below). Placeholder-only upstream blocks were cleared with evidence where the provider supports
		// self-serve OAuth: Airtable Connects with OAuth DCR.
		const airtable = getServiceCatalogEntry("airtable");
		expect(airtable?.setup.status).toBe("ready");
		expect(airtable?.setup.reason).toBeUndefined();
		expect(airtable?.setup.reason ?? "").not.toMatch(/placeholder/i);
		// Genuine documented restrictions stay hard for kept providers, with
		// research-anchored reasons: GitHub needs a user-supplied PAT.
		const github = getServiceCatalogEntry("github");
		expect(github?.auth.strategy).toBe("api_key");
		expect(github?.setup.fields?.map((field) => field.id).sort()).toEqual([
			"GITHUB_PAT_TOKEN",
			"GITHUB_PERSONAL_ACCESS_TOKEN",
		]);
		expect(github?.auth.reviewedScopes).toBeUndefined();
		expect(github?.oauth?.scopes).toBeUndefined();
	});

	it("classifies readiness from committed audit evidence without blanket bans", () => {
		// Ready entries are never downgraded by missing evidence, and a metadata GET is never proof of live OAuth:
		// oauth-ready requires audience-coherent DCR evidence; everything else stays honestly unknown.
		const airtable = getServiceCatalogEntry("airtable");
		expect(airtable?.setup.status).toBe("ready");
		expect(airtable?.setup.readiness).toBe("oauth-ready");
		expect(airtable?.auth.metadata?.dynamicClientRegistration).toBe(true);
		expect(airtable?.auth.metadata?.note).toBeUndefined();
		expect(airtable?.auth.alternatives).toEqual([
			expect.objectContaining({ kind: "api-key", readiness: "user-setup" }),
		]);
		const linear = getServiceCatalogEntry("linear");
		expect(linear?.setup.readiness).toBe("oauth-ready");
		expect(linear?.auth.metadata?.dynamicClientRegistration).toBe(true);
		expect(linear?.auth.metadata?.note).toBeUndefined();
		// Notion: the engine component comparison accepts the pathful document
		// served via the header pointer (exact endpoint match).
		const notion = getServiceCatalogEntry("notion");
		expect(notion?.setup.readiness).toBe("oauth-ready");
		expect(notion?.auth.metadata?.note).toBeUndefined();
		// The component comparison accepts exact-origin resources (root-slash normalized): DCR-capable origin-mismatched
		// entries flipped — and stay one-click only where the advertised token auth methods still serve the engine's public
		// client (the confidential-only subset — miro, vercel, windsor-ai, zoominfo, … — demotes to the user-own-app OAuth
		// path, and the 2026-09-15 final cut excludes those entries with documented reasons).
		for (const server of ["amplitude", "appwrite", "lovable", "rootly"]) {
			expect(getServiceCatalogEntry(server)?.setup.readiness).toBe("oauth-ready");
		}
		// The SDK-parity origin-level fallback makes previously unreachable PRM documents engine-visible: valid documents
		// with DCR flip (Codspeed, Resend), served-but-invalid ones fail closed (Confidence).
		expect(getServiceCatalogEntry("codspeed")?.setup.readiness).toBe("oauth-ready");
		expect(getServiceCatalogEntry("resend")?.setup.readiness).toBe("oauth-ready");
		// Prime-restricted and unknown classifications no longer ship at all: the zero-app cut (2026-09-14) excludes those
		// providers (see the cut test), and the importer now refuses to emit either class. Documented user-supplied
		// credentials stay primary; OAuth alternatives stay unknown.
		const github = getServiceCatalogEntry("github");
		expect(github?.setup.readiness).toBe("user-setup");
		expect(github?.setup.requirement).toBe("bearer-token");
		expect(github?.auth.alternatives).toEqual([expect.objectContaining({ kind: "oauth", readiness: "unknown" })]);
		for (const field of github?.setup.fields ?? []) {
			expect(field.kind).toBe("bearer-token");
		}
		// The surviving requirement shapes are exactly the two pasteable ones (2026-09-16 token-only cut): bearer tokens
		// and api keys, each with a credential field the user can actually fill in. Tenant configs, legacy-transport
		// entries and field-less api-key promises are gone.
		expect(getServiceCatalogEntry("zoom")?.setup.requirement).toBe("bearer-token");
		// Both named-header api-key pairs (Datadog's DD_API_KEY + DD_APPLICATION_KEY, Cloudinary MediaFlows' cld-api-key +
		// cld-secret) are cut by the single-credential cut — see the cut test below.
		for (const server of [
			"cockroachdb",
			"dynatrace",
			"sourcegraph",
			"paypal-sandbox",
			"render",
			"datadog",
			"cloudinary-mediaflows",
		]) {
			expect(getServiceCatalogEntry(server), `${server} must be cut from the catalog`).toBeUndefined();
		}
		for (const entry of SERVICE_CATALOG) {
			if (entry.setup.readiness !== "user-setup") continue;
			expect(["bearer-token", "api-key"], `${entry.server} requirement`).toContain(entry.setup.requirement);
			expect(
				entry.setup.fields?.some((field) => field.kind === "bearer-token" || field.kind === "api-key"),
				`${entry.server} must collect a credential the user can paste`,
			).toBe(true);
		}
		// Every survivor says what to paste in one honest line — no "requires provider credentials supplied as headers"
		// restatements (2026-09-16 wording fix), and no multi-credential reasons (the single-credential cut removed the
		// named-header pairs).
		for (const entry of SERVICE_CATALOG) {
			expect(entry.setup.reason ?? "").not.toContain("requires provider credentials supplied as headers");
			if (entry.setup.readiness === "user-setup") {
				expect(entry.setup.reason ?? "", `${entry.server} reason`).toMatch(/^paste /);
			}
		}
		// GitHub's two setup fields are curated ALTERNATIVE NAMES for one PAT (a shared credentialSet): the paste flow
		// prompts once and stores the value under the first alternative's id.
		const githubAlternatives = getServiceCatalogEntry("github");
		expect(githubAlternatives?.setup.fields).toEqual([
			expect.objectContaining({ id: "GITHUB_PAT_TOKEN", credentialSet: "github-pat" }),
			expect.objectContaining({ id: "GITHUB_PERSONAL_ACCESS_TOKEN", credentialSet: "github-pat" }),
		]);
		expect(
			SERVICE_CATALOG.filter((entry) => entry.setup.readiness === "user-setup")
				.map((entry) => entry.server)
				.sort(),
		).toEqual([
			"aws-devops-agent",
			"github",
			"pagerduty",
			"sonatype-guide",
			"zoom",
			"zoom-canvas",
			"zoom-chat",
			"zoom-meetings",
			"zoom-revenue-accelerator",
			"zoom-tasks",
			"zoom-whiteboard",
		]);
		// Readiness is informational-only data; the raw counts are in the file. Zero-app cut state (2026-09-14) + engine
		// auth-method compatibility (2026-09-14, live Hugging Face gap) + final catalog cut (2026-09-15, one-click DCR or
		// user token/key only) + token-only cut (2026-09-16, paste-an-api-key/token survivors only) + single-credential cut
		// (2026-09-16, one prompt/one bearer: named-header pairs cut): the catalog ships exactly the two self-serve
		// classes, with the user-setup class fully pasteable — the sums must stay exact so any drift forces a conscious
		// update here.
		const committed = JSON.parse(rawCatalogJson);
		expect(committed.counts.total).toBe(68);
		expect(committed.counts.readinessOauthReady).toBe(57);
		expect(committed.counts.readinessUserSetup).toBe(11);
		expect(committed.counts.readinessPrimeRestricted).toBe(0);
		expect(committed.counts.readinessUnknown).toBe(0);
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
		// The engine-undefined fallback is exact: an all-4xx well-known state is NOT a failure — the engine falls back to
		// origin-level AS discovery, so no fail-closed note is recorded, and readiness follows the AS evidence (Intercom
		// flips via DCR; Adobe stays unknown with unavailable AS).
		const intercom = getServiceCatalogEntry("intercom");
		expect(intercom?.auth.metadata?.note).toBeUndefined();
		expect(intercom?.auth.metadata?.dynamicClientRegistration).toBe(true);
		expect(intercom?.setup.readiness).toBe("oauth-ready");
		// Observational AS scope universes are recorded but never imported as
		// reviewed scopes, and no entry ever auto-requests them.
		for (const entry of SERVICE_CATALOG) {
			expect(entry.auth.reviewedScopes).toBeUndefined();
		}
	});

	it("ships only streamable-http endpoints: no stdio, no tenant template, no legacy SSE", () => {
		// 2026-09-15 final cut: local stdio adapters and url-only tenant templates were excluded. 2026-09-16 token-only
		// cut: the remaining non-http shapes go too — every shipped entry is a plain http endpoint the runtime can actually
		// connect to.
		expect(SERVICE_CATALOG.filter((entry) => entry.transport.type !== "http")).toEqual([]);
		for (const entry of SERVICE_CATALOG) {
			expect(entry.url, `${entry.server} must ship a concrete endpoint`).not.toBe("");
		}
		for (const server of ["activecampaign", "jfrog", "pigment", "sourcegraph", "dynatrace", "paypal-sandbox"]) {
			expect(getServiceCatalogEntry(server), `${server} must be cut from the catalog`).toBeUndefined();
		}
	});

	it("says what to paste: every requires-setup reason is plain single-line picker copy", () => {
		// The shipped reason is the line a human reads in the /mcp picker, so it must be an instruction, not an importer
		// diagnostic (2026-09-16). The old copy leaked machine vocabulary ("requires an auth token supplied via environment
		// variable"), stuttered the same clause twice (github) and appended upstream-config notes that changed nothing for
		// the user (zoom-meetings).
		const setupEntries = SERVICE_CATALOG.filter((entry) => entry.setup.status === "requires-setup");
		expect(setupEntries).toHaveLength(11);
		for (const entry of setupEntries) {
			const reason = entry.setup.reason ?? "";
			expect(reason, `${entry.server} must carry setup copy`).not.toBe("");
			expect(reason, `${entry.server} reason must be one line`).not.toMatch(/[\n\r]/);
			expect(reason.length, `${entry.server} reason must fit a picker row`).toBeLessThanOrEqual(100);
			expect(reason, `${entry.server} reason must tell the user what to do`).toMatch(/^paste /);
			expect(reason.toLowerCase(), `${entry.server} reason must not leak importer vocabulary`).not.toContain(
				"upstream",
			);
			const clauses = reason.split(";").map((clause) => clause.trim().toLowerCase());
			expect(new Set(clauses).size, `${entry.server} reason repeats a clause`).toBe(clauses.length);
			const fieldIds = entry.setup.fields?.map((field) => field.id) ?? [];
			expect(fieldIds.length, `${entry.server} must collect a field`).toBeGreaterThan(0);
			expect(
				fieldIds.some((id) => reason.includes(id)),
				`${entry.server} reason must name one of its real setup fields`,
			).toBe(true);
		}
		expect(getServiceCatalogEntry("github")?.setup.reason).toBe(
			"paste a GitHub personal access token (GITHUB_PAT_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN)",
		);
		expect(getServiceCatalogEntry("zoom-meetings")?.setup.reason).toBe(
			"paste your Zoom Meetings access token (ZOOM_MEETINGS_MCP_ACCESS_TOKEN)",
		);
		// Dropping the placeholder note from the shipped copy deletes no evidence: the pinned fixture still carries the
		// upstream placeholder client id, and Prime never uses it either way.
		const zoomPlugin = inputs.openAi.plugins.find((plugin) => plugin.name === "zoom");
		expect(zoomPlugin?.oauthPlaceholders).toBe(true);
		expect(zoomPlugin?.mcpServers.zoom?.oauth?.client_id).toBe("<ZOOM_PUBLIC_CLIENT_ID>");
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
		const { catalog } = buildReport();
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

	it("cuts the catalog to zero-app self-serve only, with documented exclusions and kept evidence", () => {
		// 2026-09-14 product decision: Prime maintains ZERO provider OAuth apps. The shipped catalog advertises only
		// self-serve connectors — dynamic client registration (readiness "oauth-ready") or user-supplied tokens/keys
		// ("user-setup"). Providers that require a provider-registered client and providers whose self-serve path stayed
		// honestly unknown are EXCLUDED with a documented per-entry reason, not shipped mislabeled.
		const providerClient = ["figma", "gmail", "google-calendar", "google-drive", "mongodb-atlas", "slack"];
		const unverified = [
			"adobe-for-creativity",
			"confidence-docs",
			"confidence-flags",
			"hubspot",
			"logrocket",
			"mapbox-docs",
			"shopify",
			"sumup",
			"synthflow",
			"synthflow-docs",
		];
		for (const server of [...providerClient, ...unverified]) {
			expect(getServiceCatalogEntry(server), `${server} must be cut from the catalog`).toBeUndefined();
		}
		// Providers merged from both upstreams were cut on BOTH sides, so no ghost entry can re-enter from the other source
		// — and neither can any alias or label fragment of the cut brands.
		for (const term of ["figma", "slack", "shopify", "gmail", "mongodb", "synthflow", "hubspot"]) {
			expect(searchServiceCatalog(term)).toEqual([]);
		}
		const { report } = buildReport();
		const excluded = excludedOf(report);
		for (const key of [
			"openai-plugins/figma/figma",
			"claude-plugins-official/figma/figma",
			"openai-plugins/slack/slack",
			"claude-plugins-official/slack/slack",
			"openai-plugins/gmail/gmail",
			"openai-plugins/google-calendar/google-calendar",
			"openai-plugins/google-drive/google-drive",
			"claude-plugins-official/mongodb-atlas/mongodb-atlas",
			"openai-plugins/shopify/shopify",
			"claude-plugins-official/adobe-for-creativity/Adobe for creativity",
			"claude-plugins-official/confidence/confidence-docs",
			"claude-plugins-official/confidence/confidence-flags",
			"claude-plugins-official/hubspot-sales/hubspot",
			"claude-plugins-official/logrocket/logrocket",
			"claude-plugins-official/mapbox/mapbox-docs",
			"claude-plugins-official/sumup/sumup",
			"claude-plugins-official/synthflow/synthflow",
			"claude-plugins-official/synthflow/synthflow-docs",
		]) {
			expect(excluded.has(key), `${key} must be a documented exclusion`).toBe(true);
			expect(excluded.get(key), `${key} must cite the zero-app decision`).toMatch(/zero-app/);
		}
		// The cut is a shipping decision, not an evidence deletion: the pinned source snapshots still carry the excluded
		// upstream configs and the committed audit store still holds every excluded endpoint's metadata — including Figma's
		// live gated-DCR evidence.
		expect(inputs.openAi.plugins.some((plugin) => plugin.name === "figma")).toBe(true);
		expect(inputs.openAi.plugins.some((plugin) => plugin.name === "slack")).toBe(true);
		expect(inputs.claude.plugins.some((plugin) => plugin.name === "mongodb-atlas")).toBe(true);
		const auditedServers = new Set(inputs.audit.results.map((result) => result.server));
		for (const server of [...providerClient, ...unverified]) {
			expect(auditedServers.has(server), `${server} audit evidence must stay committed`).toBe(true);
		}
		const figma = inputs.audit.results.find((result) => result.server === "figma");
		expect(figma?.authorizationServer.registrationAttempt?.httpStatus).toBe(403);
	});

	it("cuts the catalog to one-click DCR or user token/key only, with documented exclusions and kept evidence", () => {
		// 2026-09-15 product decision ("remove everything that's not one-click auth or api key"): the shipped catalog
		// advertises ONLY one-click dynamic client registration (readiness "oauth-ready") and user token/key entries. The
		// 49 entries that are neither — the 14 registered-client entries (the user's own confidential OAuth app is not a
		// token/key), the 32 local-runtime stdio adapters and the 3 url-only tenant templates — are EXCLUDED with a
		// documented per-entry reason, not shipped mislabeled.
		const registeredClient = [
			"airwallex",
			"airwallex-sandbox",
			"atlan",
			"gitlab",
			"huggingface-skills",
			"legalzoom",
			"lusha",
			"miro",
			"monday-com",
			"planetscale",
			"supabase",
			"vercel",
			"windsor-ai",
			"zoominfo",
		];
		const localRuntime = [
			"aikido",
			"alloydb",
			"amazon-location-service",
			"aws-amplify",
			"aws-core",
			"aws-data-analytics",
			"aws-serverless",
			"aws-transform",
			"azure",
			"bigquery-data-analytics",
			"cloud-sql-mysql",
			"cloud-sql-postgresql",
			"cloud-sql-sqlserver",
			"convex",
			"data-agent-kit-starter-pack",
			"dataproc",
			"deploy-on-aws",
			"discord",
			"dominodatalab",
			"firebase",
			"firestore-native",
			"gitkraken",
			"google-cloud-storage",
			"knowledge-catalog",
			"looker",
			"pinecone",
			"sagemaker-ai",
			"semgrep",
			"spanner",
			"telegram",
			"terraform",
			"zscaler",
		];
		const urlOnlyTenant = ["activecampaign", "jfrog", "pigment"];
		for (const server of [...registeredClient, ...localRuntime, ...urlOnlyTenant]) {
			expect(getServiceCatalogEntry(server), `${server} must be cut from the catalog`).toBeUndefined();
		}
		// No ghost re-entry from the other upstream side of merged providers (gitlab stays single-source; monday-com,
		// supabase and vercel were merged from both upstreams, so both sides are cut), and neither can any alias or label
		// fragment of the cut brands resurface.
		for (const term of [
			"gitlab",
			"supabase",
			"vercel",
			"monday",
			"zoominfo",
			"miro",
			"planetscale",
			"huggingface",
			"airwallex",
			"aikido",
			"alloydb",
			"bigquery",
			"firebase",
			"pinecone",
			"semgrep",
			"activecampaign",
			"jfrog",
			"pigment",
			"discord",
			"telegram",
			"zscaler",
			"looker",
		]) {
			expect(searchServiceCatalog(term), `${term} must not surface a cut entry`).toEqual([]);
		}
		const { report } = buildReport();
		const excluded = excludedOf(report);
		// One exclusion per upstream record: 64 keys cover the 49 entries, including both upstream sides of the merged
		// providers and every stdio server of the multi-server adapter plugins.
		for (const key of [
			"claude-plugins-official/airwallex-agentos/airwallex-agentos",
			"claude-plugins-official/airwallex-agentos/airwallex-dev",
			"claude-plugins-official/airwallex-dev/airwallex-dev",
			"claude-plugins-official/atlan/atlan",
			"claude-plugins-official/gitlab/gitlab",
			"claude-plugins-official/huggingface-skills/huggingface-skills",
			"claude-plugins-official/legalzoom/legalzoom",
			"claude-plugins-official/lusha/lusha",
			"claude-plugins-official/miro/miro",
			"claude-plugins-official/monday-crm/monday",
			"openai-plugins/monday-com/monday-com",
			"claude-plugins-official/planetscale/planetscale",
			"claude-plugins-official/supabase/supabase",
			"openai-plugins/supabase/supabase",
			"claude-plugins-official/vercel/vercel",
			"openai-plugins/vercel/vercel",
			"claude-plugins-official/windsor-ai/windsor-ai",
			"claude-plugins-official/zoominfo/zoominfo",
			"claude-plugins-official/aikido/aikido-mcp",
			"claude-plugins-official/alloydb/alloydb-postgres",
			"claude-plugins-official/amazon-location-service/aws-mcp",
			"claude-plugins-official/aws-amplify/aws-mcp",
			"claude-plugins-official/aws-core/aws-mcp",
			"claude-plugins-official/aws-data-analytics/aws-mcp",
			"claude-plugins-official/aws-serverless/aws-serverless-mcp",
			"claude-plugins-official/aws-transform/aws-transform-mcp",
			"claude-plugins-official/azure/azure",
			"claude-plugins-official/bigquery-data-analytics/bigquery",
			"claude-plugins-official/cloud-sql-mysql/cloud-sql-mysql",
			"claude-plugins-official/cloud-sql-postgresql/cloud-sql-postgres",
			"claude-plugins-official/cloud-sql-sqlserver/cloud-sql-mssql",
			"claude-plugins-official/convex/convex",
			"claude-plugins-official/data-agent-kit-starter-pack/alloydb-postgres",
			"claude-plugins-official/data-agent-kit-starter-pack/bigquery",
			"claude-plugins-official/data-agent-kit-starter-pack/bigtable",
			"claude-plugins-official/data-agent-kit-starter-pack/cloud-sql-postgresql",
			"claude-plugins-official/data-agent-kit-starter-pack/cloud-storage",
			"claude-plugins-official/data-agent-kit-starter-pack/dataproc",
			"claude-plugins-official/data-agent-kit-starter-pack/knowledge_catalog",
			"claude-plugins-official/data-agent-kit-starter-pack/notebook",
			"claude-plugins-official/data-agent-kit-starter-pack/spanner",
			"claude-plugins-official/data-agent-kit-starter-pack/visualization",
			"claude-plugins-official/dataproc/dataproc",
			"claude-plugins-official/deploy-on-aws/awsiac",
			"claude-plugins-official/deploy-on-aws/awspricing",
			"claude-plugins-official/discord/discord",
			"claude-plugins-official/dominodatalab/domino_server",
			"claude-plugins-official/firebase/firebase",
			"claude-plugins-official/firestore-native/firestore",
			"claude-plugins-official/gitkraken/gitkraken",
			"claude-plugins-official/google-cloud-storage/cloud-storage",
			"claude-plugins-official/knowledge-catalog/dataplex",
			"claude-plugins-official/looker/looker",
			"claude-plugins-official/looker/looker-dev",
			"claude-plugins-official/pinecone/pinecone",
			"claude-plugins-official/sagemaker-ai/aws-mcp",
			"claude-plugins-official/semgrep/guardian",
			"claude-plugins-official/spanner/spanner",
			"claude-plugins-official/telegram/telegram",
			"claude-plugins-official/terraform/terraform",
			"claude-plugins-official/zscaler/zscaler-mcp-server",
			"claude-plugins-official/activecampaign/activecampaign",
			"claude-plugins-official/jfrog/jfrog",
			"claude-plugins-official/pigment/pigment",
		]) {
			expect(excluded.has(key), `${key} must be a documented exclusion`).toBe(true);
			expect(excluded.get(key), `${key} must cite the final catalog cut decision`).toMatch(
				/2026-09-15 product decision: the catalog ships one-click DCR or user token\/key only/,
			);
		}
		// The cut is a shipping decision, not an evidence deletion: the pinned source snapshots still carry the excluded
		// upstream configs (remote, templated and stdio) and the committed audit store still holds every excluded remote
		// endpoint's metadata.
		expect(inputs.claude.plugins.some((plugin) => plugin.name === "gitlab")).toBe(true);
		expect(inputs.claude.plugins.some((plugin) => plugin.name === "miro")).toBe(true);
		expect(inputs.claude.plugins.filter((plugin) => plugin.category === "stdio_service_adapter")).toHaveLength(32);
		const gitlabPlugin = inputs.claude.plugins.find((plugin) => plugin.name === "gitlab");
		expect(gitlabPlugin?.mcpServers.gitlab?.url).toBeDefined();
		const auditedServers = new Set(inputs.audit.results.map((result) => result.server));
		for (const server of registeredClient) {
			expect(auditedServers.has(server), `${server} audit evidence must stay committed`).toBe(true);
		}
	});

	it("cuts the catalog to one-click DCR or a paste-an-api-key/token service, structurally", () => {
		// 2026-09-16 product decision (Kevin, live testing: "things like cockroachdb cloud still need mcp/ 'requires
		// provider credentials supplied as headers'? i told you to remove all that stuff?"): the user-setup class is
		// narrowed to services a user can connect by pasting a key or token. The 5 remaining survivors that were not — 3
		// tenant configs (CockroachDB Cloud's per-cluster header, Dynatrace and Sourcegraph's instance URLs), 1 legacy-SSE
		// endpoint the runtime cannot connect to at all (PayPal Sandbox) and 1 api-key promise with zero setup fields
		// (Render) — are EXCLUDED with a documented per-entry reason, not shipped mislabeled.
		for (const server of ["cockroachdb", "dynatrace", "sourcegraph", "paypal-sandbox", "render"]) {
			expect(getServiceCatalogEntry(server), `${server} must be cut from the catalog`).toBeUndefined();
		}
		for (const term of ["cockroach", "dynatrace", "sourcegraph", "paypal", "render"]) {
			expect(searchServiceCatalog(term), `${term} must not surface a cut entry`).toEqual([]);
		}
		const { report } = buildReport();
		const excluded = excludedOf(report);
		for (const key of [
			"claude-plugins-official/paypal/paypal-sandbox",
			"claude-plugins-official/cockroachdb/cockroachdb-cloud",
			"claude-plugins-official/dynatrace/dynatrace",
			"claude-plugins-official/sourcegraph/sourcegraph",
			"claude-plugins-official/render/render",
		]) {
			expect(excluded.has(key), `${key} must be a documented exclusion`).toBe(true);
			expect(excluded.get(key), `${key} must cite the token-only cut decision`).toMatch(
				/token-only catalog cut \(2026-09-16 product decision/,
			);
		}
		// The importer enforces the cut structurally: lift any one exclusion and the import fails with a curation prompt
		// instead of shipping, so none of these shapes can silently re-derive.
		const withoutExclusion = (key: string, servers?: Overrides["servers"]): Overrides => ({
			...inputs.overrides,
			servers: { ...inputs.overrides.servers, ...servers },
			excludedServers: inputs.overrides.excludedServers.filter((entry) => entry.key !== key),
		});
		const build = (overrides: Overrides): void => {
			buildCatalog(inputs.openAi, inputs.claude, overrides, inputs.audit);
		};
		// Tenant shapes (instance URL or per-tenant id) are no longer shippable.
		expect(() =>
			build(
				withoutExclusion("claude-plugins-official/cockroachdb/cockroachdb-cloud", {
					"claude-plugins-official/cockroachdb/cockroachdb-cloud": { id: "cockroachdb" },
				}),
			),
		).toThrow(
			/entry cockroachdb has requirement "tenant"; the catalog ships one-click DCR or a paste-an-api-key\/token service only/,
		);
		for (const server of ["dynatrace", "sourcegraph"]) {
			expect(() => build(withoutExclusion(`claude-plugins-official/${server}/${server}`))).toThrow(
				new RegExp(`entry ${server} has requirement "tenant"`),
			);
		}
		// A transport the runtime cannot speak is not shippable either.
		expect(() => build(withoutExclusion("claude-plugins-official/paypal/paypal-sandbox"))).toThrow(
			/entry paypal-sandbox has requirement "unsupported-transport"/,
		);
		// Render has nothing to paste: without curation its requirement cannot even be derived, and curating the api-key
		// requirement back (its old shipped shape) hits the "collects no credential field" guard.
		expect(() => build(withoutExclusion("claude-plugins-official/render/render"))).toThrow(
			/requires-setup entry render has no genuine requirement signal/,
		);
		expect(() =>
			build(
				withoutExclusion("claude-plugins-official/render/render", {
					"claude-plugins-official/render/render": { requirement: "api-key", readiness: "user-setup" },
				}),
			),
		).toThrow(/entry render has requirement "api-key" but collects no bearer-token\/api-key field/);
		// An entry the readiness pass never classified fails closed too, so a
		// missing audit result can never become a silent free pass.
		expect(() => build(withoutExclusion("claude-plugins-official/cockroachdb/cockroachdb-cloud"))).toThrow(
			/entry cockroachdb-cloud carries no readiness classification/,
		);
		// The cut is a shipping decision, not an evidence deletion: the pinned source snapshots still carry every cut
		// upstream config, including PayPal's SSE transport and Render's Claude-branded OAuth client id.
		const paypalPlugin = inputs.claude.plugins.find((plugin) => plugin.name === "paypal");
		expect(paypalPlugin?.mcpServers["paypal-sandbox"]?.type).toBe("sse");
		const renderPlugin = inputs.claude.plugins.find((plugin) => plugin.name === "render");
		expect(renderPlugin?.mcpServers.render?.oauth?.clientId).toBe("claude");
		const cockroachPlugin = inputs.claude.plugins.find((plugin) => plugin.name === "cockroachdb");
		expect(cockroachPlugin?.mcpServers["cockroachdb-cloud"]?.headers?.["mcp-cluster-id"]).toMatch(
			/^\$\{COCKROACHDB_CLUSTER_ID\}$/,
		);
		const auditedCut = new Set(inputs.audit.results.map((result) => result.server));
		for (const server of ["cockroachdb", "render", "paypal-sandbox"]) {
			expect(auditedCut.has(server), `${server} audit evidence must stay committed`).toBe(true);
		}
	});

	it("cuts genuinely distinct credential pairs, structurally: the shipped paste class collects exactly ONE credential", () => {
		// 2026-09-16 single-credential cut (Bugbot findings "extra pasted credentials never sent" / "GitHub alternative
		// tokens both required"): the generic runtime sends exactly ONE Authorization: Bearer per connection, so the
		// shipped user-setup class collects exactly one credential. Named-header pairs — Datadog's DD_API_KEY +
		// DD_APPLICATION_KEY, Cloudinary MediaFlows' cld-api-key + cld-secret — cannot authenticate through a single bearer
		// even with a complete paste, so both entries are EXCLUDED with documented reasons instead of shipping mislabeled
		// as pasteable.
		for (const server of ["datadog", "cloudinary-mediaflows"]) {
			expect(getServiceCatalogEntry(server), `${server} must be cut from the catalog`).toBeUndefined();
		}
		// (The other Cloudinary endpoints legitimately ship; only the named-header mediaflows entry is cut.)
		for (const term of ["datadog", "cloudinary-mediaflows"]) {
			expect(searchServiceCatalog(term), `${term} must not surface a cut entry`).toEqual([]);
		}
		const { report } = buildReport();
		const excluded = excludedOf(report);
		for (const key of [
			"openai-plugins/datadog/datadog",
			"claude-plugins-official/datadog/mcp",
			"claude-plugins-official/cloudinary/cloudinary-mediaflows",
		]) {
			expect(excluded.has(key), `${key} must be a documented exclusion`).toBe(true);
			expect(excluded.get(key), `${key} must cite the single-credential cut decision`).toMatch(
				/single-credential catalog cut \(2026-09-16 product decision/,
			);
		}
		// The importer enforces the cut structurally: lift any exclusion and the import fails with a curation prompt
		// instead of shipping, so no unmarked multi-credential entry can ever silently re-derive.
		const withoutExclusions = (keys: string[]): Overrides => ({
			...inputs.overrides,
			excludedServers: inputs.overrides.excludedServers.filter((entry) => !keys.includes(entry.key)),
		});
		const build = (overrides: Overrides): void => {
			buildCatalog(inputs.openAi, inputs.claude, overrides, inputs.audit);
		};
		// Datadog's user-setup shape exists only when BOTH upstream sides ship (the openai side supplies the endpoint, the
		// claude side the named header evidence): lifting both exclusions re-derives the two-key entry and the import fails
		// instead of shipping it.
		expect(() =>
			build(withoutExclusions(["openai-plugins/datadog/datadog", "claude-plugins-official/datadog/mcp"])),
		).toThrow(
			/entry datadog collects 2 distinct required credentials \(DD_API_KEY, DD_APPLICATION_KEY\); the generic runtime sends a single bearer per connection/,
		);
		expect(() => build(withoutExclusions(["claude-plugins-official/cloudinary/cloudinary-mediaflows"]))).toThrow(
			/entry cloudinary-mediaflows collects 2 distinct required credentials \(cld-api-key, cld-secret\); the generic runtime sends a single bearer per connection/,
		);
		// Marked alternatives are the ONE multi-field shape that ships: GitHub fields share the curated credentialSet
		// "github-pat", and the shipped entries resolve to at most one distinct credential each.
		for (const entry of SERVICE_CATALOG) {
			if (entry.setup.readiness !== "user-setup") continue;
			const credentials = new Set(
				(entry.setup.fields ?? [])
					.filter((field) => field.required && (field.kind === "bearer-token" || field.kind === "api-key"))
					.map((field) => field.credentialSet ?? field.id),
			);
			expect(credentials.size, `${entry.server} must collect exactly one credential`).toBeLessThanOrEqual(1);
		}
	});

	it("keeps the gated-DCR machinery: live-rejected advertised registration is explicit-false and never oauth-ready", () => {
		// The figma entry that exercised this predicate live is now excluded by the zero-app cut (its evidence stays in the
		// audit store), so the machinery is pinned directly with synthetic evidence mirroring the preserved figma attempt:
		// an advertisement alone is NOT usable-DCR evidence once the real no-credentials flow is known to be rejected.
		const registrationEndpoint = "https://as.example.test/register";
		const gatedAttempt = {
			provenance: "live dogfooding login",
			date: "2026-09-13",
			method: "POST",
			url: registrationEndpoint,
			httpStatus: 403,
		};
		const gatedResult: AuditResult = {
			server: "gated",
			endpoint: "https://mcp.example.test/mcp",
			probe: { url: "https://mcp.example.test/mcp", httpStatus: 401 },
			protectedResource: {
				attempts: [
					{
						sourceUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
						kind: "pathful",
						status: "available",
						audienceMatches: true,
						evidence: { resource: "https://mcp.example.test/mcp", authorizationServers: [registrationEndpoint] },
					},
				],
				engineVisible: "available",
				engineSelectedSourceUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
			},
			authorizationServer: {
				issuer: "https://as.example.test",
				sourceUrls: [registrationEndpoint],
				status: "available",
				evidence: {
					issuer: "https://as.example.test",
					authorizationEndpoint: "https://as.example.test/authorize",
					tokenEndpoint: "https://as.example.test/token",
					registrationEndpoint,
				},
				registrationAttempt: gatedAttempt,
			},
		};
		// A POST to exactly the advertised endpoint rejected with 401/403 gates.
		expect(advertisedRegistrationGated(gatedResult.authorizationServer)).toBe(true);
		expect(evidenceSupportsStandardOauth(gatedResult)).toBe(false);
		expect(
			advertisedRegistrationGated({
				...gatedResult.authorizationServer,
				registrationAttempt: { ...gatedAttempt, httpStatus: 401 },
			}),
		).toBe(true);
		// 404 is a real answer, not a client-forbidden rejection: not gated.
		expect(
			advertisedRegistrationGated({
				...gatedResult.authorizationServer,
				registrationAttempt: { ...gatedAttempt, httpStatus: 404 },
			}),
		).toBe(false);
		// Only an anonymous POST to exactly the advertised endpoint counts: a
		// different URL or method never gates the advertisement.
		expect(
			advertisedRegistrationGated({
				...gatedResult.authorizationServer,
				registrationAttempt: { ...gatedAttempt, url: "https://as.example.test/other" },
			}),
		).toBe(false);
		expect(
			advertisedRegistrationGated({
				...gatedResult.authorizationServer,
				registrationAttempt: { ...gatedAttempt, method: "GET" },
			}),
		).toBe(false);
		// Without a live attempt the advertisement is evidence: not gated, and the same coherent metadata is oauth-ready.
		const ungated = { ...gatedResult, authorizationServer: { ...gatedResult.authorizationServer } };
		delete ungated.authorizationServer.registrationAttempt;
		expect(advertisedRegistrationGated(ungated.authorizationServer)).toBe(false);
		expect(evidenceSupportsStandardOauth(ungated)).toBe(true);
	});

	it("keeps the confidential-only demotion machinery and cuts its output from the shipped catalog (engine auth-method parity)", () => {
		// Live-verified gap (2026-09-14 dogfooding): Hugging Face /mcp login failed at connect with "no compatible client
		// authentication method (advertised: client_secret_basic, client_secret_post)" — the engine's standard
		// no-credentials flow is a PUBLIC client, and the catalog had classified the entry one-click without ever checking
		// the advertised token auth methods. Readiness runs the SAME engine decision (decideClientAuthMethod, shared from
		// oauth.ts), so such entries demote honestly to the user-setup OAuth path: the user registers their OWN app
		// (client-id/client-secret setup fields, requirement "registered-client") — zero-app compliant self-serve, never
		// prime-restricted. Since the 2026-09-15 final cut ("one-click DCR or user token/key only") none of those demoted
		// entries ships: the 14 are excluded per upstream record with documented reasons (see the final-cut test), and no
		// registered-client requirement survives.
		const confidentialOnly = [
			"airwallex",
			"airwallex-sandbox",
			"atlan",
			"gitlab",
			"huggingface-skills",
			"legalzoom",
			"lusha",
			"miro",
			"monday-com",
			"planetscale",
			"supabase",
			"vercel",
			"windsor-ai",
			"zoominfo",
		];
		for (const server of confidentialOnly) {
			expect(getServiceCatalogEntry(server), `${server} must be cut from the catalog`).toBeUndefined();
		}
		expect(SERVICE_CATALOG.filter((entry) => entry.setup.requirement === "registered-client")).toEqual([]);
		// The demotion itself still derives from the committed evidence: the huggingface-skills audit result still fails
		// the engine's public- client gate and still supports the user-own-app path — the cut is a shipping decision, not
		// an evidence change.
		const huggingfaceAudit = loadInputs().audit.results.find((result) => result.server === "huggingface-skills");
		if (!huggingfaceAudit) throw new Error("huggingface-skills audit evidence must stay committed");
		expect(huggingfaceAudit.authorizationServer.evidence?.tokenAuthMethods).toEqual([
			"client_secret_basic",
			"client_secret_post",
		]);
		expect(evidenceSupportsStandardOauth(huggingfaceAudit)).toBe(false);
		expect(evidenceSupportsUserRegisteredOauth(huggingfaceAudit)).toBe(true);
		// The importer enforces the cut structurally: lift one exclusion and the demoted entry fails the import with a
		// curation prompt instead of shipping — a registered-client shape can never silently re-derive.
		const inputs = loadInputs();
		const withoutGitlab: Overrides = {
			...inputs.overrides,
			excludedServers: inputs.overrides.excludedServers.filter(
				(entry) => entry.key !== "claude-plugins-official/gitlab/gitlab",
			),
		};
		expect(() => buildCatalog(inputs.openAi, inputs.claude, withoutGitlab, inputs.audit)).toThrow(
			/entry gitlab has requirement "registered-client"; the catalog ships one-click DCR or a paste-an-api-key\/token service only/,
		);
		// The shared engine decision drives the synthetic classification matrix: coherent DCR evidence with
		// confidential-only methods demotes (never one-click); adding "none" restores one-click; omitted methods stay
		// one-click (the engine applies the public-client spec default); a list that serves not even a configured
		// secret-bearing client (mTLS-only) stays honestly unknown — fail closed as before.
		const coherentEvidence = (tokenAuthMethods?: string[]): AuditResult => ({
			server: "synthetic",
			endpoint: "https://mcp.example.test/mcp",
			probe: { url: "https://mcp.example.test/mcp", httpStatus: 401 },
			protectedResource: {
				attempts: [
					{
						sourceUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
						kind: "pathful",
						status: "available",
						audienceMatches: true,
						evidence: {
							resource: "https://mcp.example.test/mcp",
							authorizationServers: ["https://as.example.test"],
						},
					},
				],
				engineVisible: "available",
				engineSelectedSourceUrl: "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
			},
			authorizationServer: {
				issuer: "https://as.example.test",
				sourceUrls: ["https://as.example.test/.well-known/oauth-authorization-server"],
				status: "available",
				evidence: {
					issuer: "https://as.example.test",
					authorizationEndpoint: "https://as.example.test/authorize",
					tokenEndpoint: "https://as.example.test/token",
					registrationEndpoint: "https://as.example.test/register",
					...(tokenAuthMethods ? { tokenAuthMethods } : {}),
				},
			},
		});
		const confidential = coherentEvidence(["client_secret_basic", "client_secret_post"]);
		expect(evidenceSupportsStandardOauth(confidential)).toBe(false);
		expect(evidenceSupportsUserRegisteredOauth(confidential)).toBe(true);
		const publicCompatible = coherentEvidence(["client_secret_basic", "client_secret_post", "none"]);
		expect(evidenceSupportsStandardOauth(publicCompatible)).toBe(true);
		expect(evidenceSupportsUserRegisteredOauth(publicCompatible)).toBe(false);
		const omitted = coherentEvidence(undefined);
		expect(evidenceSupportsStandardOauth(omitted)).toBe(true);
		expect(evidenceSupportsUserRegisteredOauth(omitted)).toBe(false);
		const mtlsOnly = coherentEvidence(["tls_client_auth", "self_signed_tls_client_auth"]);
		expect(evidenceSupportsStandardOauth(mtlsOnly)).toBe(false);
		expect(evidenceSupportsUserRegisteredOauth(mtlsOnly)).toBe(false);
	});

	it("counts the sources before dedupe and records every exclusion", () => {
		const { report } = buildReport();
		const _excluded = excludedOf(report);
		expect(inputs.openAi.plugins).toHaveLength(25);
		expect(inputs.claude.plugins).toHaveLength(118);
		// The single-credential cut excluded datadog from the openai side.
		expect(report.sources["openai-plugins"].remoteServers).toBe(15);
		expect(report.sources["claude-plugins-official"].stdioServers).toBe(0);
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
			provenance: [{ source: "user" as const, note: "added locally by the user" }],
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
		// Audit-derived readiness and evidence are Prime assessments; a local file cannot self-assert them.
		// setup.requirement stays allowed as honest self-description of the user's own service.
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
