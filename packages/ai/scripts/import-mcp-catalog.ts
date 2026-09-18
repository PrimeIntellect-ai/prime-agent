#!/usr/bin/env node
/**
 * Deterministic MCP service catalog importer (ENG-6108).
 *
 * Reads the pinned upstream source fixtures in `packages/ai/mcp-catalog/sources/`
 * plus the curated `packages/ai/mcp-catalog/overrides.json`, and emits:
 *   - `packages/ai/src/mcp/catalog.json`  (the shipped, single source of truth)
 *   - `packages/ai/mcp-catalog/import-report.json` (reviewable merge report)
 *
 * The import is offline, deterministic and side-effect free: no plugin code is
 * executed and no network/auth is performed. Upstream OAuth client secrets are
 * never copied into the output; upstream client IDs are copied ONLY in the
 * pinned published-client shape — a client id published TOGETHER with its
 * callback port by the provider's own plugin repo (2026-09-17 decision: Slack's
 * slackapi/slack-mcp-plugin harness client) is a pre-registered secret-less
 * PUBLIC client meant for third-party harness reuse, so it ships pinned on the
 * entry and classifies one-click. A branded id WITHOUT the published callback
 * port is a foreign registered app (e.g. OpenAI's own Slack app) and stays
 * blocked. Fixtures preserve upstream configs verbatim (including placeholders
 * and branded client ids) so that the stripping and dedup rules below stay
 * reproducible and testable; no other upstream identity ever ships.
 *
 * Zero-app shipping policy (2026-09-14 product decision): Prime maintains ZERO
 * provider OAuth apps, so the catalog advertises only what works self-serve —
 * dynamic client registration (readiness "oauth-ready") or user-supplied
 * tokens/keys ("user-setup"). Providers that require a provider-registered
 * client ("prime-restricted") or whose self-serve path could not be verified
 * ("unknown") are cut via the documented `excludedServers` list in
 * overrides.json, each with a per-entry reason; the importer enforces the cut
 * structurally and refuses to ship such entries. Source snapshots and audit
 * evidence stay committed as history and are never deleted by the cut.
 *
 * Final catalog cut (2026-09-15 product decision): the catalog ships one-click
 * DCR or user token/key auth ONLY. Registered-client entries (the user's own
 * confidential OAuth app), local-runtime stdio adapters and url-only tenant
 * templates are cut via the documented `excludedServers` list.
 *
 * Token-only catalog cut (2026-09-16 product decision): the user-setup class is
 * narrowed to a SIMPLE paste-an-API-key/token service — requirement
 * "bearer-token" or "api-key" AND at least one bearer-token/api-key setup
 * field. Tenant configs (instance URL or per-tenant id), legacy-transport
 * entries the runtime cannot connect to, and api-key promises with zero setup
 * fields are cut the same documented way, and the importer fails the import on
 * any other user-setup shape instead of shipping it.
 *
 * Run from the repository root: npx tsx packages/ai/scripts/import-mcp-catalog.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	tokenAuthMethodsSupportConfiguredClient,
	tokenAuthMethodsSupportPublicClient,
} from "../src/mcp/oauth.js";
import { isLiteralPrivateOrLoopbackHost } from "../src/mcp/url-checks.js";

// ---------------------------------------------------------------------------
// Input types (fixture snapshots of the pinned public upstream catalogs)
// ---------------------------------------------------------------------------

export interface SourceServerDef {
	type?: string;
	url?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	headers?: Record<string, string>;
	oauth?: {
		client_id?: string;
		client_secret?: string;
		clientId?: string;
		callbackPort?: number;
		[k: string]: unknown;
	};
	oauth_resource?: string;
	scopes?: string[];
	bearer_token_env_var?: string;
	note?: string;
	[k: string]: unknown;
}

export interface OpenAiPluginFixture {
	name: string;
	displayName?: string;
	description?: string;
	category?: string;
	author?: string;
	homepage?: string;
	privacyUrl?: string;
	supportUrl?: string;
	termsUrl?: string;
	license?: string;
	version?: string;
	wiring?: string;
	configUrl?: string;
	serviceKind?: string;
	oauthPlaceholders?: boolean;
	mcpServers: Record<string, SourceServerDef>;
}

export interface OpenAiFixture {
	source: "openai-plugins";
	repository: string;
	commit: string;
	plugins: OpenAiPluginFixture[];
}

export interface ClaudeSourceFixture {
	kind: string;
	repository?: string;
	path?: string;
	ref?: string;
	sha?: string;
}

export interface ClaudePluginFixture {
	name: string;
	category: "direct_remote_service" | "stdio_service_adapter";
	providers: string[];
	notes?: string;
	source: ClaudeSourceFixture;
	sourceBase?: string;
	configUrl?: string;
	mcpServers: Record<string, SourceServerDef>;
}

export interface ClaudeFixture {
	source: "claude-plugins-official";
	repository: string;
	catalogCommit: string;
	plugins: ClaudePluginFixture[];
}

export interface OverrideEntry {
	/** Renames the derived stable id. */
	id?: string;
	label?: string;
	description?: string;
	/** Brand grouping id (defaults to the provider slug). */
	service?: string;
	aliases?: string[];
	verification?: "metadata-reviewed" | "unverified";
	clientRegistration?: "dynamic" | "pre-registered" | "unknown";
	legacyBuiltin?: boolean;
	setup?: "ready" | "requires-setup";
	setupReason?: string;
	setupFields?: CatalogSetupField[];
	/** Research-anchored readiness of the default path; overrides derivation. */
	readiness?: CatalogReadiness;
	/** Research-anchored genuine requirement; overrides derivation. */
	requirement?: CatalogSetupRequirement;
	/** Documented alternative auth paths, each with per-path readiness. */
	alternatives?: CatalogAuthAlternative[];
	/** Honest note attached to the observational metadata block. */
	metadataNote?: string;
	/** Curated note recorded as a `prime` provenance entry. */
	note?: string;
	homepage?: string;
	docsUrl?: string;
}

export interface Overrides {
	/** Curated per-server overrides keyed by "<source>/<plugin>/<server>". */
	servers: Record<string, OverrideEntry>;
	/** Servers excluded from import with documented reasons, keyed the same way. */
	excludedServers: { key: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// Output types (the emitted catalog file)
// ---------------------------------------------------------------------------

export interface CatalogProvenance {
	source: "openai-plugins" | "claude-plugins-official" | "prime";
	repository?: string;
	commit?: string;
	path?: string;
	url?: string;
	license?: string;
	note?: string;
}

export type CatalogSetupFieldKind =
	| "env-var"
	| "url"
	| "client-id"
	| "client-secret"
	| "bearer-token"
	| "api-key";

export interface CatalogSetupField {
	id: string;
	label: string;
	description?: string;
	required: boolean;
	kind?: CatalogSetupFieldKind;
	/** Shared by fields that are ALTERNATIVE NAMES for one credential. */
	credentialSet?: string;
}

export type CatalogReadiness = "oauth-ready" | "user-setup" | "prime-restricted" | "unknown";

export type CatalogSetupRequirement =
	| "api-key"
	| "bearer-token"
	| "registered-client"
	| "tenant"
	| "unsupported-transport"
	| "local-runtime";

export interface CatalogSetup {
	status: "ready" | "requires-setup";
	reason?: string;
	fields?: CatalogSetupField[];
	readiness?: CatalogReadiness;
	requirement?: CatalogSetupRequirement;
}

export interface CatalogAuthAlternative {
	kind: "oauth" | "api-key" | "bearer-token" | "service-account";
	readiness: CatalogReadiness;
	note?: string;
	sourceUrl?: string;
}

/**
 * Observational public-metadata evidence from the read-only audit
 * (packages/ai/mcp-catalog/audit/metadata-audit.json). Never a live credential
 * authority and never a Connect gate; omitted fields mean "not advertised",
 * never "unsupported".
 */
export interface CatalogAuthMetadata {
	status: "available" | "unavailable" | "not-audited";
	authorizationServer?: string;
	resource?: string;
	pkceS256?: boolean;
	dynamicClientRegistration?: boolean;
	clientIdMetadataDocument?: boolean;
	protectedResourceScopes?: string[];
	authorizationServerScopes?: string[];
	tokenAuthMethods?: string[];
	sourceUrls: string[];
	fetchedAt: string;
	note?: string;
}

export interface CatalogAuth {
	strategy: "oauth" | "api_key" | "none" | "unknown";
	clientRegistration: "dynamic" | "pre-registered" | "unknown";
	alternatives?: CatalogAuthAlternative[];
	metadata?: CatalogAuthMetadata;
}

// ---------------------------------------------------------------------------
// Read-only audit evidence input (committed snapshot; the importer is offline)
// ---------------------------------------------------------------------------

export interface AuditPrmEvidence {
	resource?: string;
	authorizationServers?: string[];
	protectedResourceScopes?: string[];
}

export interface AuditAsEvidence {
	issuer?: string;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	registrationEndpoint?: string;
	pkceS256?: boolean;
	clientIdMetadataDocument?: boolean;
	authorizationServerScopes?: string[];
	tokenAuthMethods?: string[];
}

/**
 * Live registration-attempt evidence recorded in the audit store from a real
 * engine login attempt. The read-only audit itself never POSTs registration
 * endpoints, so provenance is recorded on the block. It mirrors the engine's
 * no-credentials flow exactly: an anonymous POST to the advertised
 * registration_endpoint.
 */
export interface AuditRegistrationAttempt {
	/** How the attempt was observed, quoted honestly (e.g. live dogfooding login). */
	provenance: string;
	/** ISO date of the attempt. */
	date: string;
	/** HTTP method of the attempt. */
	method: string;
	/** The registration endpoint the attempt targeted. */
	url: string;
	/** HTTP status the attempt received. */
	httpStatus: number;
	/** Engine error, quoted verbatim when available. */
	error?: string;
	/** What the attempt establishes. */
	finding?: string;
	/** Public corroboration (reports, metadata-only probes). */
	corroboration?: string[];
}

export interface AuditResult {
	server: string;
	endpoint: string;
	probe: { url: string; httpStatus?: number; resourceMetadataHeader?: string; error?: string };
	protectedResource: {
		attempts: Array<{
			sourceUrl: string;
			kind: string;
			status: string;
			audienceMatches?: boolean;
			evidence?: AuditPrmEvidence;
			httpStatus?: number;
			error?: string;
		}>;
		engineVisible: "available" | "unavailable";
		engineSelectedSourceUrl?: string;
		selectionNote?: string;
	};
	authorizationServer: {
		issuer?: string;
		sourceUrls: string[];
		status: "available" | "unavailable";
		evidence?: AuditAsEvidence;
		/** Live (non-audit) registration-attempt evidence; the audit GETs never produce this. */
		registrationAttempt?: AuditRegistrationAttempt;
	};
}

export interface AuditFile {
	fetchedAt: string;
	targets: { server: string; endpoint: string }[];
	results: AuditResult[];
	/**
	 * Live registration-attempt evidence for servers that later left the audit
	 * target set (e.g. a server cut from the catalog by the 2026-09-14
	 * zero-app decision): the audit script carries these blocks forward
	 * verbatim on re-runs so live evidence is never silently dropped.
	 * Evidence/history only — the importer never classifies from them.
	 */
	retiredRegistrationAttempts?: {
		server: string;
		endpoint: string;
		registrationAttempt: AuditRegistrationAttempt;
	}[];
	counts: Record<string, number>;
	bounds: Record<string, string>;
}

export type CatalogTransport =
	| { type: "http"; url: string }
	| { type: "http-template"; template: string; variables: { name: string; description: string }[] }
	| { type: "sse"; url: string }
	| { type: "stdio"; servers: { name: string; command: string; args?: string[]; env?: Record<string, string> }[] };

export interface CatalogEntry {
	server: string;
	service: string;
	label: string;
	url: string;
	description?: string;
	category?: string;
	aliases: string[];
	publisher?: string;
	transport: CatalogTransport;
	auth: CatalogAuth;
	setup: CatalogSetup;
	verification: { status: "metadata-reviewed" | "unverified" };
	legacyBuiltin: boolean;
	/** Pinned published client identity (secret-less public client); secrets never ship. */
	oauth?: { kind: "oauth"; clientId?: string; callbackPort?: number };
	provenance: CatalogProvenance[];
	homepage?: string;
	docsUrl?: string;
	privacyUrl?: string;
	supportUrl?: string;
}

export interface CatalogFile {
	version: number;
	sources: { source: string; repository: string; commit: string }[];
	counts: Record<string, number>;
	entries: CatalogEntry[];
}

export interface ImportReport {
	sources: Record<string, { plugins: number; remoteServers: number; stdioServers: number; excluded: number }>;
	merged: { server: string; sources: string[]; urls: string[] }[];
	excluded: { key: string; reason: string }[];
	counts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPENAI = "openai-plugins";
const CLAUDE = "claude-plugins-official";
const SOURCE_PRECEDENCE: Record<string, number> = { [OPENAI]: 0, [CLAUDE]: 1 };

function slug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function titleCase(value: string): string {
	return value
		.split(/-+/)
		.map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
		.join(" ");
}

/**
 * Dedup key: lowercase scheme+host, drop a trailing slash and utm_* tracking
 * params. The emitted endpoint stays verbatim upstream text.
 */
function reviewedUrl(raw: string): string | undefined {
	const match = /^(\w+:\/\/[^/?#]+)([^#]*)$/.exec(raw.trim());
	if (!match) return undefined;
	const origin = match[1].toLowerCase();
	let suffix = match[2];
	if (suffix.endsWith("/") && suffix.length > 1) suffix = suffix.slice(0, -1);
	const queryStart = suffix.indexOf("?");
	if (queryStart !== -1) {
		const basePath = suffix.slice(0, queryStart);
		const kept = suffix
			.slice(queryStart + 1)
			.split("&")
			.filter((param) => param !== "" && !/^utm[_-]/i.test(param));
		suffix = kept.length ? `${basePath}?${kept.join("&")}` : basePath;
	}
	return `${origin}${suffix}`;
}

function isLoopbackUrl(raw: string): boolean {
	const host = /^\w+:\/\/([^/?#]+)/.exec(raw)?.[1]?.split(":")[0]?.toLowerCase();
	return isLiteralPrivateOrLoopbackHost(host ?? "");
}

const TEMPLATE_RE = /\$\{([^}]+)\}/g;
const TEMPLATE_TEST = /\$\{[^}]+\}/;

interface ResolvedTemplate {
	url?: string;
	template?: string;
	variables: { name: string; description: string }[];
}

/** Resolves ${VAR} and ${VAR:-default}; unresolved variables become setup fields. */
function resolveTemplate(raw: string, describe: (name: string) => string): ResolvedTemplate {
	const variables: { name: string; description: string }[] = [];
	const seen = new Set<string>();
	let unresolved = false;
	const url = raw.replace(TEMPLATE_RE, (_match, expr: string) => {
		const sep = expr.indexOf(":-");
		const name = (sep === -1 ? expr : expr.slice(0, sep)).trim();
		const fallback = sep === -1 ? undefined : expr.slice(sep + 2);
		if (!seen.has(name)) {
			seen.add(name);
			variables.push({ name, description: describe(name) });
		}
		if (fallback === undefined || fallback === "") {
			unresolved = true;
			return `\${${name}}`;
		}
		return fallback;
	});
	TEMPLATE_RE.lastIndex = 0;
	if (unresolved || !/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(url)) {
		return { template: url, variables };
	}
	return { url, variables };
}

/**
 * Normalizes `${VAR}`-style templates and `{placeholder}` path segments into one
 * canonical `${name}` form so both upstream styles become http-template entries.
 */
function normalizeTemplatePlaceholders(url: string): string {
	return url.replace(/(?<!\$)\{([^{}]+)\}/g, (_match, name: string) => `\${${slug(name)}}`);
}

function envRefs(value: string): string[] {
	const names: string[] = [];
	for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)) {
		if (!names.includes(match[1])) names.push(match[1]);
	}
	return names;
}

function classifyOauthClientId(value: string | undefined): "placeholder" | "branded" | "claude-specific" | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.startsWith("<") || /placeholder/i.test(trimmed)) return "placeholder";
	if (trimmed === "claude" || trimmed.startsWith("https://claude.ai/")) return "claude-specific";
	return "branded";
}

/** Treat null/absent/empty fixture values as undefined. */
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function envField(name: string, kind: CatalogSetupFieldKind = "env-var"): CatalogSetupField {
	return { id: name, label: name, description: `Environment variable ${name}`, required: true, kind };
}

function dedupeFields(fields: CatalogSetupField[]): CatalogSetupField[] {
	const seen = new Set<string>();
	const result: CatalogSetupField[] = [];
	for (const field of fields) {
		if (seen.has(field.id)) continue;
		seen.add(field.id);
		result.push(field);
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Record extraction
// ---------------------------------------------------------------------------

interface AuthEvidence {
	oauth: boolean;
	apiKey: boolean;
	blocks: string[];
	fields: CatalogSetupField[];
	/** Pinned published harness client id (id + callback port published by the provider's own repo). */
	pinnedClientId?: string;
	/** The pinned client's registered callback port (its redirect-URI contract). */
	pinnedCallbackPort?: number;
}

interface RemoteRecord {
	source: string;
	plugin: string;
	serverName: string;
	url: string;
	auth: AuthEvidence;
	provenance: CatalogProvenance;
	labelHint?: string;
	description?: string;
	category?: string;
	provider?: string;
	homepage?: string;
	privacyUrl?: string;
	supportUrl?: string;
}

interface TemplateRecord {
	source: string;
	plugin: string;
	serverName: string;
	resolved: ResolvedTemplate;
	auth: AuthEvidence;
	provenance: CatalogProvenance;
	provider?: string;
}

interface SseRecord {
	source: string;
	plugin: string;
	serverName: string;
	url: string;
	auth: AuthEvidence;
	provenance: CatalogProvenance;
	provider?: string;
}

interface StdioRecord {
	source: string;
	plugin: string;
	provider?: string;
	provenance: CatalogProvenance;
	servers: { name: string; command: string; args?: string[]; env?: Record<string, string> }[];
	fields: CatalogSetupField[];
}

function recordAuth(server: SourceServerDef, pluginPlaceholders: boolean): AuthEvidence {
	const evidence: AuthEvidence = { oauth: false, apiKey: false, blocks: [], fields: [] };
	const oauth = server.oauth;
	if (oauth) {
		evidence.oauth = true;
		const clientId = (oauth.client_id ?? oauth.clientId) as string | undefined;
		const callbackPort = typeof oauth.callbackPort === "number" ? oauth.callbackPort : undefined;
		const issue = classifyOauthClientId(clientId);
		if (issue === "placeholder") {
			evidence.blocks.push("upstream OAuth config contains client-id placeholders");
		} else if (issue === "claude-specific") {
			evidence.blocks.push("upstream config relies on a Claude-specific OAuth client identity");
		} else if (issue === "branded" && callbackPort !== undefined) {
			// A client id published TOGETHER with its callback port by the provider's
			// own plugin repo (Slack's slackapi/slack-mcp-plugin harness client) is a
			// pre-registered secret-less public client meant for third-party harness
			// reuse: pin it for the built entry instead of blocking it. Ids without the
			// published callback port stay branded and blocked — a foreign registered
			// app id must never be reused.
			evidence.pinnedClientId = clientId;
			evidence.pinnedCallbackPort = callbackPort;
		} else if (issue === "branded") {
			evidence.blocks.push("upstream config carries a provider-branded OAuth client id that must not be reused");
		}
		if (oauth.client_secret) {
			evidence.blocks.push("upstream OAuth config contains client-secret placeholders");
		}
	}
	if (pluginPlaceholders) {
		evidence.blocks.push("upstream OAuth client values are placeholders");
	}
	if (server.oauth_resource) evidence.oauth = true;
	if (server.note && /oauth/i.test(server.note)) evidence.oauth = true;
	if (server.bearer_token_env_var) {
		evidence.apiKey = true;
		evidence.blocks.push("requires a bearer token supplied via environment variable");
		evidence.fields.push(envField(server.bearer_token_env_var, "bearer-token"));
	}
	for (const [header, value] of Object.entries(server.headers ?? {})) {
		if (typeof value !== "string") continue;
		const refs = envRefs(value);
		if (/^authorization$/i.test(header)) {
			evidence.apiKey = true;
			evidence.blocks.push("requires an auth token supplied via environment variable");
			for (const ref of refs) evidence.fields.push(envField(ref, "bearer-token"));
		} else if (refs.length > 0 || /key|secret|token|authorization/i.test(header)) {
			evidence.apiKey = true;
			evidence.blocks.push("requires provider credentials supplied as headers");
			// Credential-named headers collect an api-key; other header bindings stay generic env vars.
			const credentialHeader = /key|secret|token|authorization/i.test(header);
			evidence.fields.push(envField(refs[0] ?? header, credentialHeader ? "api-key" : "env-var"));
		}
	}
	evidence.fields = dedupeFields(evidence.fields);
	return evidence;
}

function authStrategy(auth: AuthEvidence): "oauth" | "api_key" | "none" | "unknown" {
	if (auth.oauth && auth.apiKey) return "unknown";
	if (auth.oauth) return "oauth";
	if (auth.apiKey) return "api_key";
	return "unknown";
}

function openAiProvenance(fixture: OpenAiFixture, plugin: OpenAiPluginFixture): CatalogProvenance {
	return {
		source: OPENAI,
		repository: "openai/plugins",
		commit: fixture.commit,
		path: `plugins/${plugin.name}/.mcp.json`,
		url: optionalString(plugin.configUrl),
		license: optionalString(plugin.license),
	};
}

function claudeProvenance(fixture: ClaudeFixture, plugin: ClaudePluginFixture): CatalogProvenance {
	const source = plugin.source;
	const vendored = source.kind === "external_plugins";
	return {
		source: CLAUDE,
		repository: vendored ? "anthropics/claude-plugins-official" : optionalString(source.repository),
		commit: vendored ? fixture.catalogCommit : (optionalString(source.sha) ?? fixture.catalogCommit),
		path: optionalString(source.path),
		url: optionalString(plugin.configUrl),
	};
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

interface BuiltEntry {
	entry: CatalogEntry;
	identityKey: string;
}

const GENERIC_SERVER_NAMES = new Set(["mcp", "default", "server", "main", "remote"]);

function deriveId(plugin: string, serverName: string): string {
	const fromServer = slug(serverName);
	if (fromServer && !GENERIC_SERVER_NAMES.has(fromServer)) {
		return fromServer.endsWith("-mcp") && fromServer.length > "-mcp".length
			? fromServer.slice(0, -"-mcp".length)
			: fromServer;
	}
	return slug(plugin);
}

function primeProvenance(override: OverrideEntry): CatalogProvenance {
	return {
		source: "prime",
		note: override.note ?? "curated override applied; see mcp-catalog/overrides.json",
	};
}

function finalizeAliases(entry: CatalogEntry): string[] {
	const aliasSet = new Set<string>();
	for (const alias of entry.aliases) {
		const normalized = slug(alias);
		if (normalized && normalized !== entry.server) aliasSet.add(normalized);
	}
	const labelSlug = slug(entry.label);
	if (labelSlug && labelSlug !== entry.server) aliasSet.add(labelSlug);
	const serviceSlug = slug(entry.service);
	if (serviceSlug && serviceSlug !== entry.server) aliasSet.add(serviceSlug);
	return [...aliasSet].sort();
}

// ---------------------------------------------------------------------------
// Audit evidence merge + readiness derivation
// ---------------------------------------------------------------------------

function deriveRequirement(entry: CatalogEntry): CatalogSetupRequirement | undefined {
	if (entry.setup.status === "ready") return undefined;
	switch (entry.transport.type) {
		case "stdio":
			return "local-runtime";
		case "sse":
			return "unsupported-transport";
		case "http-template":
			return "tenant";
		case "http":
			// Field kinds classify the genuine requirement: bearer tokens, api keys,
			// or a non-credential per-instance config value (cluster id).
			if (entry.setup.fields?.some((field) => field.kind === "bearer-token")) return "bearer-token";
			if (entry.setup.fields?.some((field) => field.kind === "api-key")) return "api-key";
			if (entry.setup.fields?.some((field) => field.kind === "env-var")) return "tenant";
			return undefined;
	}
	return undefined;
}

/**
 * The advertised registration endpoint is gated when a live engine registration
 * attempt — an anonymous POST to exactly the advertised registration_endpoint,
 * the engine's own no-credentials flow (see oauth.ts registerClient) — was
 * rejected with a client-forbidden status (401/403). Recorded live in the audit
 * store (the read-only audit itself never POSTs registration endpoints); an
 * advertisement alone is NOT usable-DCR evidence once the real flow is known
 * to fail.
 *
 * Exported for offline machinery tests: since the 2026-09-14 zero-app cut the
 * gated entry that exercised this predicate live (Figma) is excluded from the
 * shipped catalog (the evidence stays in the audit store), so the predicate
 * now guards future entries and is unit-tested directly.
 */
export function advertisedRegistrationGated(as: AuditResult["authorizationServer"]): boolean {
	const attempt = as.registrationAttempt;
	if (!attempt || !as.evidence?.registrationEndpoint) return false;
	return (
		attempt.method === "POST" &&
		attempt.url === as.evidence.registrationEndpoint &&
		(attempt.httpStatus === 401 || attempt.httpStatus === 403)
	);
}

/**
 * Coherent standard-OAuth evidence, independent of the client-auth-method
 * compatibility gate: a served, structurally valid authorization-server
 * document with an advertised dynamic registration endpoint that a live
 * anonymous registration attempt was not recorded as rejected at, plus a
 * reachable endpoint/AS audience association. This is the evidence the
 * ENGINE itself needs to reach the token request; whether the standard
 * no-credentials flow then survives client-auth negotiation is decided by
 * the shared engine decision (see evidenceSupportsStandardOauth).
 */
function standardOauthEvidenceCoherent(result: AuditResult): boolean {
	// oauth-ready needs a coherent authorization server AND dynamic client
	// registration. CIMD alone is NOT sufficient: no Prime-controlled identity
	// document is deployed or authorized today (root decision), and foreign
	// client ids must never be copied. Omitted PKCE lists are omitted
	// evidence, never unsupported — they do not block oauth-ready.
	const as = result.authorizationServer;
	if (as.status !== "available" || !as.evidence) return false;
	if (
		!as.evidence.issuer ||
		!as.evidence.authorizationEndpoint ||
		!as.evidence.tokenEndpoint ||
		!as.evidence.registrationEndpoint
	) {
		return false;
	}
	// The engine POSTs an anonymous registration to the advertised endpoint when
	// no client credentials are configured; a live recorded rejection means the
	// advertised DCR is gated and the standard flow fails — fail closed, the
	// same honest class as DCR-less providers (HubSpot; Slack reaches one-click
	// only through the separate pinned-client path in applyAuditEvidence).
	if (advertisedRegistrationGated(as)) return false;
	// The engine's PRM validation uses the component comparison (root-approved
	// audience policy): the document's resource must match the exact endpoint
	// (canonical form) OR the exact origin, root-slash normalized. Anything
	// else fails closed — e.g. a resource that keeps the path but drops the
	// query string never matches (LogRocket), and DCR-less providers never
	// become oauth-ready through THIS path (HubSpot; Slack's one-click path is
	// the pinned-client carve-out in applyAuditEvidence, not the standard flow).
	if (result.protectedResource.engineVisible === "available") return !audienceMismatched(result);
	// No valid PRM document anywhere. oauth-ready via the origin-AS fallback
	// requires the engine to actually REACH that fallback: no followed pointer
	// (any pointer failure throws) and every tried well-known candidate exactly
	// 4xx. Served-but-invalid documents, 5xx responses and fetch errors all
	// throw with no fallback — the entry stays honestly unknown.
	return engineFallsBackToOriginAs(result);
}

export function evidenceSupportsStandardOauth(result: AuditResult): boolean {
	// The engine's no-credentials flow logs in as a PUBLIC client (DCR/CIMD, no
	// configured secret), so oauth-ready additionally requires the advertised
	// token auth methods to be compatible with exactly that client shape —
	// the SAME shared engine decision the runtime login runs
	// (tokenAuthMethodsSupportPublicClient → decideClientAuthMethod). A
	// confidential-only authorization server (e.g. Hugging Face: "advertised:
	// client_secret_basic, client_secret_post") fails the engine's gate at
	// connect time, so it can never classify one-click. Omitted lists are
	// omitted evidence: the engine applies the public-client spec default.
	return (
		standardOauthEvidenceCoherent(result) &&
		tokenAuthMethodsSupportPublicClient(result.authorizationServer.evidence?.tokenAuthMethods)
	);
}

/**
 * The honest self-serve fallback when the standard no-credentials flow cannot
 * authenticate: the evidence is fully coherent for standard OAuth (same
 * checks as evidenceSupportsStandardOauth) but the authorization server
 * advertises only secret-bearing client auth methods. The SAME standard flow
 * completes with a user-registered confidential app (configured client id +
 * secret), so these entries demote from oauth-ready to the user-setup OAuth
 * path with client-id/client-secret setup fields — the user's OWN registered
 * app, zero-app compliant, never an exclusion. Entries whose advertised
 * methods serve not even a secret-bearing client (e.g. mTLS-only) stay
 * honestly unknown and fail closed as today.
 */
export function evidenceSupportsUserRegisteredOauth(result: AuditResult): boolean {
	const methods = result.authorizationServer.evidence?.tokenAuthMethods;
	return (
		standardOauthEvidenceCoherent(result) &&
		!tokenAuthMethodsSupportPublicClient(methods) &&
		tokenAuthMethodsSupportConfiguredClient(methods)
	);
}

/**
 * Catalog mirror of the engine's pinned-client carve-out (oauth.ts login): a
 * catalog-pinned pre-registered client id is an explicit vouch for the app's
 * client type, so one-click readiness is decided by the POSITIVELY advertised
 * PKCE S256 evidence and NOT by the AS's global token_endpoint_auth_methods
 * list — the pinned public client authenticates by PKCE, not client auth (live
 * evidence: Slack MCP, confidential-only advertisement, one-click via the
 * provider-published harness client). Without advertised S256 there is no
 * public-client PKCE path, and the entry does NOT classify one-click (honest
 * demotion).
 */
export function evidenceSupportsPinnedClientOauth(result: AuditResult): boolean {
	return result.authorizationServer.evidence?.pkceS256 === true;
}

/** The engine's canonicalResource rule: bare origins collapse, paths and searches stay. */
function canonicalResource(url: string): string {
	const parsed = new URL(url);
	if (parsed.pathname === "/" && !parsed.search) return parsed.origin;
	return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

/** The engine's component comparison: exact canonical endpoint OR exact origin (root-slash normalized). */
function audienceMatches(resource: string, endpoint: string): boolean {
	const parsed = new URL(endpoint);
	const canonical = canonicalResource(endpoint);
	return resource === canonical || resource === parsed.origin || resource === `${parsed.origin}/`;
}

function audienceMismatched(result: AuditResult): boolean {
	const selected = result.protectedResource.attempts.find(
		(attempt) => attempt.sourceUrl === result.protectedResource.engineSelectedSourceUrl,
	);
	if (!selected?.evidence?.resource) return result.protectedResource.engineVisible === "available";
	return !audienceMatches(selected.evidence.resource, result.endpoint);
}

/**
 * The engine reaches its origin-level authorization-server fallback ONLY when
 * no resource_metadata pointer was followed (a followed pointer fails closed
 * on ANY error; a present-but-rejected pointer fails closed at URL validation)
 * AND every well-known candidate it tried returned exactly a 4xx (the loop
 * continues only on 4xx; 5xx, fetch errors and served-but-invalid documents
 * all throw). Derived exactly from the recorded attempts.
 */
function engineFallsBackToOriginAs(result: AuditResult): boolean {
	if (result.protectedResource.attempts.some((attempt) => attempt.kind === "header")) return false;
	if (result.probe.resourceMetadataHeader) return false;
	const wellKnown = result.protectedResource.attempts.filter(
		(attempt) => attempt.kind === "pathful" || attempt.kind === "origin",
	);
	if (wellKnown.some((attempt) => attempt.status === "available")) return false;
	return wellKnown.every(
		(attempt) =>
			attempt.httpStatus !== undefined && attempt.httpStatus >= 400 && attempt.httpStatus < 500,
	);
}

function metadataNote(result: AuditResult, overrideNote?: string): string | undefined {
	if (overrideNote) return overrideNote;
	if (result.protectedResource.selectionNote) return result.protectedResource.selectionNote;
	if (advertisedRegistrationGated(result.authorizationServer)) {
		const status = result.authorizationServer.registrationAttempt?.httpStatus;
		return `advertises a registration endpoint, but a live anonymous registration attempt was rejected there (HTTP ${status}): the advertised dynamic client registration is gated and the engine's standard flow fails without a pre-registered client`;
	}
	if (audienceMismatched(result)) {
		return "the engine-visible protected-resource document's resource matches neither the exact endpoint nor the origin under the engine's component comparison; the engine fails closed on this entry";
	}
	if (evidenceSupportsUserRegisteredOauth(result)) {
		const methods = result.authorizationServer.evidence?.tokenAuthMethods ?? [];
		return `the authorization server advertises only secret-based client authentication (${methods.join(", ")}); the engine's no-credentials flow fails its client-auth compatibility gate at connect, so the entry classifies as user-setup with your own registered OAuth app`;
	}
	return undefined;
}

/**
 * Setup fields for the user-registered OAuth app path (readiness user-setup,
 * requirement registered-client): the user registers their OWN app with the
 * provider and configures its identity exactly the way the host's settings
 * shape does (oauthClientId + oauthClientSecretEnvVar on an mcpServers
 * entry). Zero-app compliant: Prime still registers nothing.
 */
const OAUTH_USER_APP_FIELDS: CatalogSetupField[] = [
	{
		id: "oauthClientId",
		label: "OAuth client id",
		description: "Client id of your own registered OAuth app (settings mcpServers oauthClientId)",
		required: true,
		kind: "client-id",
	},
	{
		id: "oauthClientSecretEnvVar",
		label: "OAuth client secret",
		description:
			"Environment variable holding your app's client secret (settings mcpServers oauthClientSecretEnvVar)",
		required: true,
		kind: "client-secret",
	},
];

/** Honest per-entry demotion reason quoting the advertised auth-method evidence. */
function userRegisteredOauthReason(result: AuditResult): string {
	const methods = result.authorizationServer.evidence?.tokenAuthMethods ?? [];
	const advertised = methods.length > 0 ? ` (${methods.join(", ")})` : "";
	return `requires your own OAuth app: the authorization server accepts only secret-based client authentication${advertised}; register an app with the provider and configure its client id and secret`;
}

/**
 * Demote a would-be-one-click entry to the user-setup OAuth path. The engine's
 * standard no-credentials flow fails its client-auth compatibility gate against
 * this authorization server (live evidence: Hugging Face /mcp login fails with
 * "no compatible client authentication method"), but the same standard flow
 * completes with a user-registered confidential app, so the honest
 * classification is user-setup with client-id/client-secret setup fields — NOT
 * the exclusions list, and never prime-restricted: Prime registers nothing,
 * the user registers their own app.
 */
function demoteToUserRegisteredOauth(entry: CatalogEntry, result: AuditResult): void {
	entry.setup.status = "requires-setup";
	entry.setup.reason = userRegisteredOauthReason(result);
	entry.setup.fields = dedupeFields([...(entry.setup.fields ?? []), ...OAUTH_USER_APP_FIELDS.map((field) => ({ ...field }))]);
	entry.setup.requirement = "registered-client";
	entry.setup.readiness = "user-setup";
}

function applyAuditEvidence(built: BuiltEntry[], audit: AuditFile | undefined, overrides?: Overrides): void {
	if (!audit) return;
	const byServer = new Map(audit.results.map((result) => [result.server, result]));
	for (const { entry, identityKey } of built) {
		if (entry.transport.type !== "http" && entry.transport.type !== "sse") continue;
		const endpointUrl = entry.transport.url;
		const result = byServer.get(entry.server);
		const overrideNote = overrides?.servers[identityKey]?.metadataNote;
		if (!result) {
			// Catalog drift: an endpoint without a committed audit snapshot.
			// "not-audited" is honest; never a gate, never a downgrade.
			entry.auth.metadata = {
				status: "not-audited",
				sourceUrls: [endpointUrl],
				fetchedAt: audit.fetchedAt,
			};
			if (entry.setup.status === "ready" && !entry.setup.readiness) entry.setup.readiness = "unknown";
			continue;
		}
		const as = result.authorizationServer;
		const selected = result.protectedResource.attempts.find(
			(attempt) => attempt.sourceUrl === result.protectedResource.engineSelectedSourceUrl,
		);
		const selectedPrm = selected?.evidence;
		entry.auth.metadata = {
			status: as.status === "available" ? "available" : "unavailable",
			...(as.issuer ? { authorizationServer: as.issuer } : {}),
			...(selectedPrm?.resource ? { resource: selectedPrm.resource } : {}),
			...(as.evidence?.pkceS256 !== undefined ? { pkceS256: as.evidence.pkceS256 } : {}),
			// An advertisement alone is not usable-DCR evidence: when a live
			// anonymous registration attempt at the advertised endpoint was
			// rejected, the honest flag is explicit false (gated), not omitted
			// (omitted means "not advertised").
			...(as.evidence?.registrationEndpoint !== undefined
				? { dynamicClientRegistration: !advertisedRegistrationGated(as) }
				: {}),
			...(as.evidence?.clientIdMetadataDocument ? { clientIdMetadataDocument: true } : {}),
			...(selectedPrm?.protectedResourceScopes?.length ? { protectedResourceScopes: selectedPrm.protectedResourceScopes } : {}),
			...(as.evidence?.authorizationServerScopes?.length
				? { authorizationServerScopes: as.evidence.authorizationServerScopes }
				: {}),
			...(as.evidence?.tokenAuthMethods?.length ? { tokenAuthMethods: as.evidence.tokenAuthMethods } : {}),
			sourceUrls: [
				...new Set([
					result.probe.url,
					...result.protectedResource.attempts.map((attempt) => attempt.sourceUrl),
					...as.sourceUrls,
				]),
			],
			fetchedAt: audit.fetchedAt,
			...(metadataNote(result, overrideNote) ? { note: metadataNote(result, overrideNote) } : {}),
		};
		if (entry.setup.readiness) continue; // curated override wins
		if (entry.setup.status === "ready") {
			// Metadata availability never downgrades a ready entry; oauth-ready
			// requires positive evidence — including the engine's
			// client-auth compatibility gate. A coherent DCR entry whose
			// authorization server advertises only secret-bearing methods
			// demotes honestly to the user-setup OAuth path (the user's own
			// registered app, zero-app compliant); everything else stays
			// unknown. A catalog-pinned client id skips the global
			// auth-method gate entirely (the pinned id vouches for the
			// client type; only advertised PKCE S256 decides).
			if (entry.oauth?.clientId && evidenceSupportsPinnedClientOauth(result)) {
				entry.setup.readiness = "oauth-ready";
				continue;
			}
			if (evidenceSupportsStandardOauth(result)) {
				entry.setup.readiness = "oauth-ready";
				continue;
			}
			if (evidenceSupportsUserRegisteredOauth(result)) {
				demoteToUserRegisteredOauth(entry, result);
				continue;
			}
			entry.setup.readiness = "unknown";
			continue;
		}
		const requirement = entry.setup.requirement ?? deriveRequirement(entry);
		if (!requirement) {
			throw new Error(
				`requires-setup entry ${entry.server} has no genuine requirement signal; curate overrides.json (requirement) or flip the status with evidence`,
			);
		}
		entry.setup.requirement = requirement;
		entry.setup.readiness = requirement === "registered-client" ? "prime-restricted" : "user-setup";
	}
	// Non-remote adapters: local runtime / tenant URL / unsupported transport.
	for (const { entry } of built) {
		if (entry.transport.type === "http" || entry.transport.type === "sse") continue;
		if (entry.setup.readiness) continue;
		if (entry.setup.status === "ready") {
			entry.setup.readiness = "unknown";
			continue;
		}
		entry.setup.requirement ??= deriveRequirement(entry);
		entry.setup.readiness = "user-setup";
	}
}

export function buildCatalog(
	openAi: OpenAiFixture,
	claude: ClaudeFixture,
	overrides: Overrides,
	audit?: AuditFile,
): { catalog: CatalogFile; report: ImportReport } {
	const excluded: { key: string; reason: string }[] = [];
	const excludedKeys = new Set(overrides.excludedServers.map((entry) => entry.key));
	for (const entry of overrides.excludedServers) {
		excluded.push({ key: entry.key, reason: entry.reason });
	}

	const remoteRecords: RemoteRecord[] = [];
	const templateRecords: TemplateRecord[] = [];
	const sseRecords: SseRecord[] = [];
	const stdioRecords: StdioRecord[] = [];

	let oaiRemote = 0;
	let oaiExcluded = 0;
	for (const plugin of openAi.plugins) {
		for (const [serverName, server] of Object.entries(plugin.mcpServers)) {
			const key = `${OPENAI}/${plugin.name}/${serverName}`;
			if (excludedKeys.has(key)) {
				oaiExcluded++;
				continue;
			}
			const auth = recordAuth(server, plugin.oauthPlaceholders === true);
			remoteRecords.push({
				source: OPENAI,
				plugin: plugin.name,
				serverName,
				url: server.url ?? "",
				auth,
				provenance: openAiProvenance(openAi, plugin),
				labelHint: optionalString(plugin.displayName),
				description: optionalString(plugin.description),
				category: optionalString(plugin.category),
				homepage: optionalString(plugin.homepage),
				privacyUrl: optionalString(plugin.privacyUrl),
				supportUrl: optionalString(plugin.supportUrl),
			});
			oaiRemote++;
		}
	}

	let claudeRemote = 0;
	let claudeStdioServers = 0;
	let claudeExcluded = 0;
	for (const plugin of claude.plugins) {
		const provenance = claudeProvenance(claude, plugin);
		const provider = plugin.providers[0];
		if (plugin.category === "stdio_service_adapter") {
			const servers: StdioRecord["servers"] = [];
			const fields: CatalogSetupField[] = [];
			for (const [serverName, server] of Object.entries(plugin.mcpServers)) {
				const key = `${CLAUDE}/${plugin.name}/${serverName}`;
				if (excludedKeys.has(key)) {
					claudeExcluded++;
					continue;
				}
				if (server.command) {
					servers.push({
						name: serverName,
						command: server.command,
						args: server.args,
						env: server.env && Object.keys(server.env).length > 0 ? server.env : undefined,
					});
					for (const envName of Object.keys(server.env ?? {})) fields.push(envField(envName));
					claudeStdioServers++;
				}
			}
			if (servers.length > 0) {
				stdioRecords.push({ source: CLAUDE, plugin: plugin.name, provider: optionalString(provider), provenance, servers, fields });
			}
			continue;
		}
		for (const [serverName, server] of Object.entries(plugin.mcpServers)) {
			const key = `${CLAUDE}/${plugin.name}/${serverName}`;
			if (excludedKeys.has(key)) {
				claudeExcluded++;
				continue;
			}
			const auth = recordAuth(server, false);
			if (server.command) {
				excluded.push({
					key,
					reason: "local stdio utility inside a remote-service plugin; outside the remote service lane",
				});
				claudeExcluded++;
				continue;
			}
			const url = normalizeTemplatePlaceholders(server.url ?? "");
			if (server.type === "sse") {
				sseRecords.push({ source: CLAUDE, plugin: plugin.name, serverName, url: server.url ?? "", auth, provenance, provider });
				claudeRemote++;
				continue;
			}
			if (isLoopbackUrl(url)) {
				excluded.push({ key, reason: "loopback/private endpoint; local server, not a remote service" });
				claudeExcluded++;
				continue;
			}
			if (TEMPLATE_TEST.test(url)) {
				const resolved = resolveTemplate(url, (name) => `Upstream template variable ${name}`);
				if (resolved.url) {
					remoteRecords.push({
						source: CLAUDE,
						plugin: plugin.name,
						serverName,
						url: resolved.url,
						auth,
						provenance,
						provider,
					});
					claudeRemote++;
				} else {
					templateRecords.push({
						source: CLAUDE,
						plugin: plugin.name,
						serverName,
						resolved,
						auth,
						provenance,
						provider,
					});
				}
				continue;
			}
			if (!/^https:\/\//.test(url)) {
				excluded.push({ key, reason: "endpoint is not https" });
				claudeExcluded++;
				continue;
			}
			remoteRecords.push({
				source: CLAUDE,
				plugin: plugin.name,
				serverName,
				url,
				auth,
				provenance,
				provider,
				description: optionalString(server.note),
			});
			claudeRemote++;
		}
	}
	TEMPLATE_RE.lastIndex = 0;

	// --- group static remote records by reviewed endpoint ---
	const groups = new Map<string, RemoteRecord[]>();
	const groupOrder: string[] = [];
	for (const record of remoteRecords) {
		const key = reviewedUrl(record.url);
		if (!key) {
			excluded.push({
				key: `${record.source}/${record.plugin}/${record.serverName}`,
				reason: "endpoint could not be parsed as an absolute URL",
			});
			continue;
		}
		if (!groups.has(key)) {
			groups.set(key, []);
			groupOrder.push(key);
		}
		groups.get(key)!.push(record);
	}

	const built: BuiltEntry[] = [];
	const mergedReport: ImportReport["merged"] = [];

	for (const key of groupOrder) {
		const records = groups.get(key)!;
		records.sort((a, b) => {
			const source = SOURCE_PRECEDENCE[a.source] - SOURCE_PRECEDENCE[b.source];
			if (source !== 0) return source;
			const plugin = a.plugin.localeCompare(b.plugin);
			if (plugin !== 0) return plugin;
			return a.serverName.localeCompare(b.serverName);
		});
		const identity = records[0];
		const identityKey = `${identity.source}/${identity.plugin}/${identity.serverName}`;
		const override = overrides.servers[identityKey];

		// Attach templated records for the same plugin declared by another source.
		const attachedTemplates: TemplateRecord[] = [];
		for (let index = templateRecords.length - 1; index >= 0; index--) {
			const template = templateRecords[index];
			const samePluginElsewhere = records.some(
				(record) => record.plugin === template.plugin && record.source !== template.source,
			);
			if (samePluginElsewhere) {
				attachedTemplates.push(template);
				templateRecords.splice(index, 1);
			}
		}

		built.push(buildHttpEntry(records, attachedTemplates, identityKey, override, mergedReport));
	}

	for (const template of templateRecords) {
		const identityKey = `${template.source}/${template.plugin}/${template.serverName}`;
		const override = overrides.servers[identityKey];
		const strategy = authStrategy(template.auth);
		// Template variables are per-instance endpoint URL bindings.
		const fields = dedupeFields([
			...template.auth.fields,
			...template.resolved.variables.map((variable) => ({
				id: variable.name,
				label: variable.name,
				description: variable.description,
				required: true,
				kind: "url" as const,
			})),
		]);
		built.push({
			identityKey,
			entry: {
				server: override?.id ?? deriveId(template.plugin, template.serverName),
				service: override?.service ?? slug(template.provider ?? template.plugin),
				label: override?.label ?? template.provider ?? titleCase(slug(template.serverName)),
				url: "",
				transport: {
					type: "http-template",
					template: template.resolved.template ?? "",
					variables: template.resolved.variables,
				},
				auth: { strategy, clientRegistration: override?.clientRegistration ?? "unknown" },
				setup: {
					status: "requires-setup",
					reason:
						override?.setupReason ?? "endpoint is tenant-specific; provide your instance URL and credentials",
					fields: fields.length > 0 ? fields : undefined,
				},
				verification: { status: override?.verification ?? "unverified" },
				legacyBuiltin: override?.legacyBuiltin ?? false,
				aliases: [template.plugin, template.serverName, ...(template.provider ? [template.provider] : [])],
				provenance: [template.provenance, ...(override ? [primeProvenance(override)] : [])],
				...(strategy === "oauth" ? { oauth: { kind: "oauth" } } : {}),
			},
		});
	}

	for (const record of sseRecords) {
		const identityKey = `${record.source}/${record.plugin}/${record.serverName}`;
		const override = overrides.servers[identityKey];
		const strategy = authStrategy(record.auth);
		built.push({
			identityKey,
			entry: {
				server: override?.id ?? deriveId(record.plugin, record.serverName),
				service: override?.service ?? slug(record.provider ?? record.plugin),
				label: override?.label ?? record.provider ?? titleCase(slug(record.serverName)),
				url: record.url,
				transport: { type: "sse", url: record.url },
				auth: { strategy, clientRegistration: override?.clientRegistration ?? "unknown" },
				setup: {
					status: "requires-setup",
					reason:
						override?.setupReason ??
						"legacy SSE transport; the generic runtime currently supports streamable HTTP and stdio only",
					fields: record.auth.fields.length > 0 ? record.auth.fields : undefined,
				},
				verification: { status: override?.verification ?? "unverified" },
				legacyBuiltin: override?.legacyBuiltin ?? false,
				aliases: [record.plugin, record.serverName, ...(record.provider ? [record.provider] : [])],
				provenance: [record.provenance, ...(override ? [primeProvenance(override)] : [])],
				...(strategy === "oauth" ? { oauth: { kind: "oauth" } } : {}),
			},
		});
	}

	for (const record of stdioRecords) {
		const identityKey = `${record.source}/${record.plugin}`;
		const override = overrides.servers[identityKey];
		const fields = dedupeFields(record.fields);
		const strategy: CatalogAuth["strategy"] = fields.length > 0 ? "api_key" : "unknown";
		built.push({
			identityKey,
			entry: {
				server: override?.id ?? slug(record.plugin),
				service: override?.service ?? slug(record.provider ?? record.plugin),
				label: override?.label ?? record.provider ?? titleCase(slug(record.plugin)),
				url: "",
				transport: { type: "stdio", servers: record.servers },
				auth: { strategy, clientRegistration: override?.clientRegistration ?? "unknown" },
				setup: {
					status: "requires-setup",
					reason:
						override?.setupReason ??
						"local stdio adapter: requires the listed command and its credentials locally; not part of the remote one-click lane",
					fields: fields.length > 0 ? fields : undefined,
				},
				verification: { status: override?.verification ?? "unverified" },
				legacyBuiltin: override?.legacyBuiltin ?? false,
				aliases: [record.plugin, ...(record.provider ? [record.provider] : [])],
				provenance: [record.provenance, ...(override ? [primeProvenance(override)] : [])],
			},
		});
	}

	// --- apply id-level curated overrides and finalize aliases ---
	for (const { entry, identityKey } of built) {
		const override = overrides.servers[identityKey];
		if (override) {
			if (override.verification) entry.verification = { status: override.verification };
			if (override.clientRegistration) entry.auth.clientRegistration = override.clientRegistration;
			if (override.legacyBuiltin !== undefined) entry.legacyBuiltin = override.legacyBuiltin;
			if (override.setup) entry.setup.status = override.setup;
			if (override.setupReason) entry.setup.reason = override.setupReason;
			if (override.setup === "ready") entry.setup.reason = undefined;
			if (override.setupFields) entry.setup.fields = override.setupFields;
			if (override.readiness) entry.setup.readiness = override.readiness;
			if (override.requirement) entry.setup.requirement = override.requirement;
			if (override.alternatives) entry.auth.alternatives = override.alternatives;
			if (override.description) entry.description = override.description;
			if (override.homepage) entry.homepage = override.homepage;
			if (override.docsUrl) entry.docsUrl = override.docsUrl;
			if (override.service) entry.service = override.service;
			if (override.label) entry.label = override.label;
		}
		entry.aliases = finalizeAliases(entry);
	}

	applyAuditEvidence(built, audit, overrides);

	// Zero-app shipping policy (2026-09-14 product decision): Prime maintains
	// ZERO provider OAuth apps, so the shipped catalog advertises only what
	// works self-serve — dynamic client registration (readiness "oauth-ready")
	// or user-supplied credentials ("user-setup": tokens/keys, or the user's
	// OWN registered OAuth app for providers whose authorization server
	// accepts only secret-bearing client auth methods). Any entry that still
	// classifies "prime-restricted" (needs a provider-registered client) or
	// "unknown" (no verified self-serve path) fails the import on purpose: cut
	// it via overrides.json `excludedServers` with a documented per-entry
	// reason, or curate its readiness with evidence. The readiness vocabulary
	// and the fail-closed audit machinery that derives it are unchanged — only
	// shipping is policed; the excluded source snapshots and audit evidence
	// stay committed as history.
	for (const { entry } of built) {
		// A missing classification is not a pass: an entry the readiness pass
		// never reached (for example a remote endpoint with no committed audit
		// result) would otherwise slip past every downstream shipping guard.
		// Fail closed and force curation instead (2026-09-16).
		if (!entry.setup.readiness) {
			throw new Error(
				`entry ${entry.server} carries no readiness classification; the catalog ships only classified self-serve (oauth-ready/user-setup) entries — add it to overrides.json excludedServers with a documented reason, or curate its readiness with evidence`,
			);
		}
		if (entry.setup.readiness === "prime-restricted" || entry.setup.readiness === "unknown") {
			throw new Error(
				`entry ${entry.server} classifies readiness "${entry.setup.readiness}"; the zero-app catalog ships only self-serve (oauth-ready/user-setup) entries — add it to overrides.json excludedServers with a documented reason, or curate its readiness with evidence`,
			);
		}
	}

	// Token-only catalog cut (2026-09-16 product decision, Kevin live-testing
	// the picker: "things like cockroachdb cloud still need mcp/ 'requires
	// provider credentials supplied as headers'? i told you to remove all
	// that stuff?"): the catalog ships one-click dynamic client registration
	// ("oauth-ready") or a SIMPLE paste-an-API-key/token service ONLY. A
	// user-setup survivor is shippable only when BOTH hold:
	//   1. its requirement is literally "bearer-token" or "api-key" — the two
	//      shapes a user can satisfy by pasting a credential; and
	//   2. it actually collects at least one bearer-token/api-key field, so
	//      the connect sheet always has something to paste.
	// This is deliberately narrower than the 2026-09-15 rule it replaces:
	// tenant configs (instance URL or per-tenant id: Dynatrace, Sourcegraph,
	// CockroachDB Cloud), legacy-transport entries the runtime cannot even
	// connect to (PayPal Sandbox SSE) and api-key promises with zero fields
	// (Render) are no longer shippable shapes at all — they can never
	// silently re-derive into the catalog. Cut such entries via
	// overrides.json `excludedServers` with a documented per-entry reason, or
	// curate the requirement with evidence. The auth-methods honesty
	// machinery that derives these requirements (decideClientAuthMethod
	// parity, demotion, tokenAuthMethods capture) is unchanged — only
	// shipping is policed, and all excluded source snapshots and audit
	// evidence stay committed as history.
	for (const { entry } of built) {
		if (entry.setup.readiness !== "user-setup") continue;
		const requirement = entry.setup.requirement;
		const fields = entry.setup.fields ?? [];
		const pasteableShape = requirement === "bearer-token" || requirement === "api-key";
		const collectsCredential = fields.some(
			(field) => field.kind === "bearer-token" || field.kind === "api-key",
		);
		if (!pasteableShape) {
			throw new Error(
				`entry ${entry.server} has requirement "${requirement ?? "undefined"}"; the catalog ships one-click DCR or a paste-an-api-key/token service only (2026-09-16 decision) — add it to overrides.json excludedServers with a documented reason, or curate its requirement with evidence`,
			);
		}
		if (!collectsCredential) {
			throw new Error(
				`entry ${entry.server} has requirement "${requirement}" but collects no bearer-token/api-key field; a key/token entry the user cannot fill in is unusable (2026-09-16 decision) — add it to overrides.json excludedServers with a documented reason, or curate its setup fields with evidence`,
			);
		}
		// The runtime sends exactly ONE Authorization: Bearer per connection, so a
		// shipped paste-a-key service collects exactly one credential. Fields that
		// are alternative NAMES for it share a curated `credentialSet` id.
		const credentialFields = fields.filter(
			(field) => field.required && (field.kind === "bearer-token" || field.kind === "api-key"),
		);
		const distinctCredentials = new Set(credentialFields.map((field) => field.credentialSet ?? field.id));
		if (distinctCredentials.size > 1) {
			throw new Error(
				`entry ${entry.server} collects ${distinctCredentials.size} distinct required credentials (${[...distinctCredentials].join(", ")}); the generic runtime sends a single bearer per connection, so a complete paste cannot authenticate — mark alternative names with a shared setupFields credentialSet in overrides.json, or exclude the entry with a documented reason`,
			);
		}
	}

	const entries = built.map((item) => item.entry).sort((a, b) => a.server.localeCompare(b.server));

	// Uniqueness and endpoint checks — deterministic failures that force curation.
	if (process.env.MCP_CATALOG_DEBUG_IDS) {
		for (const { entry, identityKey } of built) {
			console.log(`ID ${entry.server} <- ${identityKey} [${entry.transport.type}]`);
		}
	}
	const seenIds = new Set<string>();
	for (const entry of entries) {
		if (seenIds.has(entry.server)) {
			throw new Error(`Duplicate catalog server id: ${entry.server}`);
		}
		seenIds.add(entry.server);
		if (entry.transport.type === "http" || entry.transport.type === "sse") {
			if (!/^https:\/\//.test(entry.transport.url) || isLoopbackUrl(entry.transport.url)) {
				throw new Error(`Entry ${entry.server} has a non-https or loopback endpoint: ${entry.transport.url}`);
			}
		}
	}

	const counts = {
		total: entries.length,
		http: entries.filter((entry) => entry.transport.type === "http").length,
		httpTemplate: entries.filter((entry) => entry.transport.type === "http-template").length,
		sse: entries.filter((entry) => entry.transport.type === "sse").length,
		stdio: entries.filter((entry) => entry.transport.type === "stdio").length,
		ready: entries.filter((entry) => entry.setup.status === "ready").length,
		requiresSetup: entries.filter((entry) => entry.setup.status === "requires-setup").length,
		metadataReviewed: entries.filter((entry) => entry.verification.status === "metadata-reviewed").length,
		oauthStrategy: entries.filter((entry) => entry.auth.strategy === "oauth").length,
		apiKeyStrategy: entries.filter((entry) => entry.auth.strategy === "api_key").length,
		mergedFromBothSources: entries.filter(
			(entry) =>
				new Set(
					entry.provenance
						.map((prov) => prov.source)
						.filter((source) => source !== "prime"),
				).size >= 2,
		).length,
		readinessOauthReady: entries.filter((entry) => entry.setup.readiness === "oauth-ready").length,
		readinessUserSetup: entries.filter((entry) => entry.setup.readiness === "user-setup").length,
		readinessPrimeRestricted: entries.filter((entry) => entry.setup.readiness === "prime-restricted").length,
		readinessUnknown: entries.filter((entry) => entry.setup.readiness === "unknown").length,
		metadataAvailable: entries.filter((entry) => entry.auth.metadata?.status === "available").length,
		metadataUnavailable: entries.filter((entry) => entry.auth.metadata?.status === "unavailable").length,
	};

	const catalog: CatalogFile = {
		version: 2,
		sources: [
			{ source: OPENAI, repository: "openai/plugins", commit: openAi.commit },
			{ source: CLAUDE, repository: "anthropics/claude-plugins-official", commit: claude.catalogCommit },
		],
		counts,
		entries,
	};

	const report: ImportReport = {
		sources: {
			[OPENAI]: {
				plugins: openAi.plugins.length,
				remoteServers: oaiRemote,
				stdioServers: 0,
				excluded: oaiExcluded,
			},
			[CLAUDE]: {
				plugins: claude.plugins.length,
				remoteServers: claudeRemote,
				stdioServers: claudeStdioServers,
				excluded: claudeExcluded,
			},
		},
		merged: mergedReport,
		excluded: excluded.sort((a, b) => a.key.localeCompare(b.key)),
		counts,
	};

	return { catalog, report };
}

function buildHttpEntry(
	records: RemoteRecord[],
	templates: TemplateRecord[],
	identityKey: string,
	override: OverrideEntry | undefined,
	mergedReport: ImportReport["merged"],
): BuiltEntry {
	const identity = records[0];
	const union: AuthEvidence = { oauth: false, apiKey: false, blocks: [], fields: [] };
	for (const record of records) {
		union.oauth = union.oauth || record.auth.oauth;
		union.apiKey = union.apiKey || record.auth.apiKey;
		for (const block of record.auth.blocks) {
			if (!union.blocks.includes(block)) union.blocks.push(block);
		}
		for (const field of record.auth.fields) union.fields.push(field);
	}
	for (const template of templates) {
		union.oauth = union.oauth || template.auth.oauth;
		union.apiKey = union.apiKey || template.auth.apiKey;
		for (const block of template.auth.blocks) {
			if (!union.blocks.includes(block)) union.blocks.push(block);
		}
		for (const field of template.auth.fields) union.fields.push(field);
	}
	const strategy = authStrategy(union);
	const fields = dedupeFields(union.fields);
	// One pinned published client per entry: conflicting pinned ids across merged
	// records are a deterministic import failure, never a silent pick.
	const pinned = records.find((record) => record.auth.pinnedClientId !== undefined);
	if (
		pinned &&
		records.some(
			(record) => record.auth.pinnedClientId !== undefined && record.auth.pinnedClientId !== pinned.auth.pinnedClientId,
		)
	) {
		throw new Error(
			`conflicting pinned OAuth client ids for ${override?.id ?? deriveId(identity.plugin, identity.serverName)}`,
		);
	}
	const providers = records
		.map((record) => record.provider)
		.filter((provider): provider is string => !!provider);
	const publisher = providers[0];
	const label = override?.label ?? identity.labelHint ?? publisher ?? titleCase(slug(identity.serverName));
	const service = override?.service ?? slug(providers[0] ?? identity.plugin);
	const requiresSetup = union.blocks.length > 0;
	const provenance: CatalogProvenance[] = records.map((record) => record.provenance);
	for (const template of templates) {
		provenance.push({
			...template.provenance,
			note: "templated endpoint excluded; upstream requires per-tenant configuration",
		});
	}
	if (override) provenance.push(primeProvenance(override));
	const description =
		override?.description ??
		records.map((record) => record.description).find((value): value is string => !!value);
	const entry: CatalogEntry = {
		server: override?.id ?? deriveId(identity.plugin, identity.serverName),
		service,
		label,
		url: identity.url,
		description,
		category: records.map((record) => record.category).find((value): value is string => !!value),
		aliases: [
			...records.flatMap((record) => [record.plugin, record.serverName]),
			...providers,
			...(override?.aliases ?? []),
		],
		publisher,
		transport: { type: "http", url: identity.url },
		// A pinned published client is pre-registered by definition (the id exists
		// before login; the engine never registers dynamically).
		auth: { strategy, clientRegistration: override?.clientRegistration ?? (pinned ? "pre-registered" : "unknown") },
		setup: requiresSetup
			? {
					status: "requires-setup",
					reason: override?.setupReason ?? [...union.blocks].sort().join("; "),
					fields: fields.length > 0 ? fields : undefined,
				}
			: { status: "ready" },
		verification: { status: override?.verification ?? "unverified" },
		legacyBuiltin: override?.legacyBuiltin ?? false,
		provenance,
		homepage: records.map((record) => record.homepage).find((value): value is string => !!value),
		privacyUrl: records.map((record) => record.privacyUrl).find((value): value is string => !!value),
		supportUrl: records.map((record) => record.supportUrl).find((value): value is string => !!value),
		...(strategy === "oauth"
			? {
					oauth: {
						kind: "oauth" as const,
						...(pinned?.auth.pinnedClientId !== undefined ? { clientId: pinned.auth.pinnedClientId } : {}),
						...(pinned?.auth.pinnedCallbackPort !== undefined
							? { callbackPort: pinned.auth.pinnedCallbackPort }
							: {}),
					},
				}
			: {}),
	};
	if (records.length > 1 || templates.length > 0) {
		const sources = records
			.map((record) => record.source)
			.filter((value, index, array) => array.indexOf(value) === index);
		mergedReport.push({ server: entry.server, sources, urls: [...new Set(records.map((r) => r.url))] });
	}
	return { entry, identityKey };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const catalogDir = path.resolve(scriptDir, "../mcp-catalog");
	const openAi = JSON.parse(
		fs.readFileSync(path.join(catalogDir, "sources/openai-plugins.json"), "utf8"),
	) as OpenAiFixture;
	const claude = JSON.parse(
		fs.readFileSync(path.join(catalogDir, "sources/claude-plugins-official.json"), "utf8"),
	) as ClaudeFixture;
	const overrides = JSON.parse(fs.readFileSync(path.join(catalogDir, "overrides.json"), "utf8")) as Overrides;
	const audit = JSON.parse(
		fs.readFileSync(path.join(catalogDir, "audit/metadata-audit.json"), "utf8"),
	) as AuditFile;

	const { catalog, report } = buildCatalog(openAi, claude, overrides, audit);

	const outPath = path.resolve(scriptDir, "../src/mcp/catalog.json");
	fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, "\t")}\n`);
	// Generated TS mirror (models.generated.ts precedent) so the runtime never needs
	// Node JSON import attributes (the repo compiles with module Node16) and the
	// esbuild CLI bundle can inline the data. catalog.json stays the canonical,
	// reviewable source of truth; both files are regenerated together.
	const generatedPath = path.resolve(scriptDir, "../src/mcp/catalog.data.generated.ts");
	const header = `// AUTO-GENERATED by packages/ai/scripts/import-mcp-catalog.ts — do not edit.\n// Canonical source: packages/ai/src/mcp/catalog.json (both files regenerate together).\n\nimport type { CatalogFileShape } from "./catalog.js";\n\nexport const CATALOG_DATA: CatalogFileShape = `;
	fs.writeFileSync(generatedPath, `${header}${JSON.stringify(catalog, null, "\t")};\n`);
	const reportPath = path.join(catalogDir, "import-report.json");
	fs.writeFileSync(reportPath, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(
		`catalog: ${catalog.counts.total} entries (${catalog.counts.http} http, ${catalog.counts.httpTemplate} templated, ${catalog.counts.sse} sse, ${catalog.counts.stdio} stdio); ${catalog.counts.ready} ready, ${catalog.counts.requiresSetup} require setup`,
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
