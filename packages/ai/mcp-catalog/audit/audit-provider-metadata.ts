#!/usr/bin/env node
/**
 * READ-ONLY public metadata audit for the MCP service catalog (ENG-6108 PR2256).
 *
 * For every remote catalog endpoint (streamable HTTP + SSE) this script fetches
 * the same public, unauthenticated metadata the runtime OAuth discovery reads:
 * the MCP endpoint probe (WWW-Authenticate resource_metadata), the RFC 9728
 * protected-resource metadata, and the authorization-server metadata
 * (oauth-authorization-server / openid-configuration). It records DCR, CIMD,
 * PKCE, scopes and client-auth support per endpoint.
 *
 * HARD LINES: no Authorization headers, no cookies, no registration POST, no
 * OAuth or browser flow, no MCP tool calls, no stored credentials, no writes.
 * A successful metadata GET is NEVER proof that live OAuth works; audit results
 * are never labeled metadata-reviewed or live-verified. Bounded per request:
 * timeout, body size and global concurrency; redirects are recorded, never
 * followed. Every request goes through an undici Agent whose connect.lookup
 * resolves the hostname, validates that ALL addresses are public, and returns
 * only those validated addresses for the actual connection (TLS hostname
 * validation retained) — validated addresses are pinned per request, so there
 * is no re-resolution race. https + literal-address pre-flight checks run on
 * every fetched URL (including metadata-supplied destinations); the
 * dispatcher lookup is the authoritative guard.
 *
 * Network is permitted ONLY here (manual run). Project tests stay offline and
 * never invoke this file. Run from the repo root:
 *   npx tsx packages/ai/mcp-catalog/audit/audit-provider-metadata.ts
 * Results are written to packages/ai/mcp-catalog/audit/metadata-audit.json and
 * consumed offline by the importer.
 */

import type { LookupAddress } from "node:dns";
import * as dns from "node:dns/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import { isLiteralPrivateOrLoopbackHost } from "../../src/mcp/url-checks.js";

const USER_AGENT = "PrimeAgent-CatalogAudit/1.0 (ENG-6108 PR2256; read-only metadata audit)";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const CONCURRENCY = 6;
const SCOPES_CAP = 30;
const AUTH_METHODS_CAP = 12;

// ---------------------------------------------------------------------------
// Pure helpers (offline-testable; the test file imports only these)
// ---------------------------------------------------------------------------

export interface PrmEvidence {
	resource?: string;
	authorizationServers?: string[];
	/** scopes_supported from the protected-resource document — the engine's login-relevant scope list (reviewed/config > PRM > omit). */
	protectedResourceScopes?: string[];
	httpStatus?: number;
	contentType?: string;
	error?: string;
}

export interface AsEvidence {
	issuer?: string;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	registrationEndpoint?: string;
	/** true only when code_challenge_methods_supported advertises S256; absent field = list omitted (engine sends S256 by default). */
	pkceS256?: boolean;
	clientIdMetadataDocument?: boolean;
	/** scopes_supported from the AS document — observational only; NEVER fed to the requested scopes (reviewed/config > PRM > omit). */
	authorizationServerScopes?: string[];
	/** token_endpoint_auth_methods_supported; absent field = omitted (engine applies spec defaults). */
	tokenAuthMethods?: string[];
	httpStatus?: number;
	contentType?: string;
	error?: string;
}

export interface PrmAttempt {
	sourceUrl: string;
	/** How this location was chosen: header pointer, pathful well-known, or origin-level well-known (evidence only). */
	kind: "header" | "pathful" | "origin";
	/** "available" = a JSON protected-resource document was served here. */
	status: "available" | "unavailable";
	/**
	 * Raw exact-string comparison of the document's resource against the
	 * endpoint URL as recorded in the audit targets. The engine's actual rule
	 * (`metadata.resource === canonicalResource(endpoint)`) is applied by the
	 * importer when classifying; raw strings are kept here so evidence stays
	 * interpretation-free.
	 */
	audienceMatches?: boolean;
	evidence?: PrmEvidence;
	httpStatus?: number;
	error?: string;
}

export interface AuditResult {
	server: string;
	endpoint: string;
	probe: { url: string; httpStatus?: number; resourceMetadataHeader?: string; error?: string };
	/**
	 * ALL RFC 9728 locations probed, in priority order: the WWW-Authenticate
	 * resource_metadata pointer, the pathful well-known
	 * (`/.well-known/oauth-protected-resource{path}`) and the origin-level
	 * well-known (`/.well-known/oauth-protected-resource`). Some providers
	 * (e.g. Notion) serve DIFFERENT bodies per location — origin-level
	 * documents may declare an origin resource while pathful documents match
	 * the endpoint audience — so evidence records which body serves where.
	 */
	protectedResource: {
		attempts: PrmAttempt[];
		engineVisible: "available" | "unavailable";
		/** The attempt the current engine runtime follows (header pointer, else pathful well-known, else the origin-level root well-known). */
		engineSelectedSourceUrl?: string;
		/** Why the engine's PRM discovery fails closed, when it does (mirrors oauth.ts semantics). */
		selectionNote?: string;
	};
	authorizationServer: {
		issuer?: string;
		sourceUrls: string[];
		status: "available" | "unavailable";
		evidence?: AsEvidence;
	};
	note?: string;
}

/** RFC 9728 well-known location for the protected-resource metadata (mirrors oauth.ts). */
export function protectedResourceUrl(endpoint: string): string {
	const url = new URL(endpoint);
	const resourcePath = url.pathname === "/" ? "" : url.pathname;
	return `${url.origin}/.well-known/oauth-protected-resource${resourcePath}${url.search}`;
}

/** The engine's canonicalResource rule: bare origins collapse, paths and searches stay. */
export function canonicalResource(url: string): string {
	const parsed = new URL(url);
	if (parsed.pathname === "/" && !parsed.search) return parsed.origin;
	return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

/**
 * The engine's audience rule (component comparison): a protected-resource
 * document's resource must match the exact canonical endpoint, or be the
 * endpoint origin itself (root path, no search, same origin).
 */
export function audienceMatchesEngineRule(resource: string | undefined, endpoint: string): boolean {
	if (!resource) return false;
	const parsedResource = new URL(resource);
	const parsedEndpoint = new URL(endpoint);
	const sameOrigin = parsedResource.origin === parsedEndpoint.origin;
	const originLevel =
		sameOrigin && (parsedResource.pathname === "/" || parsedResource.pathname === "") && !parsedResource.search;
	return originLevel || resource === canonicalResource(endpoint);
}

/** Authorization-server metadata candidates (mirrors oauth.ts authorizationServerMetadataUrls). */
export function authorizationServerUrls(issuer: string): string[] {
	const url = new URL(issuer);
	const issuerPath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
	return [
		new URL(`/.well-known/oauth-authorization-server${issuerPath}`, url.origin).toString(),
		new URL(`${issuerPath}/.well-known/openid-configuration`, url.origin).toString(),
	];
}

/** Parses the WWW-Authenticate resource_metadata hint (mirrors oauth.ts). */
export function parseResourceMetadataHeader(value: string | null): string | undefined {
	const match = value?.match(/(?:^|[,\s])resource_metadata\s*=\s*"((?:[^"\\]|\\.)*)"/i);
	return match ? match[1].replace(/\\(.)/g, "$1") : undefined;
}

/** Structural safety gate for every URL this audit fetches. */
export function isFetchableUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" && !parsed.username && !parsed.password && !isLiteralPrivateOrLoopbackHost(parsed.hostname);
	} catch {
		return false;
	}
}

/**
 * DNS guard for every fetch, including metadata-supplied destinations: a
 * hostname that resolves (wholly or partly) to a literal private/loopback/
 * link-local/ULA address is refused before any HTTP request is made. Literal
 * URL checks alone do not stop DNS-to-private rebinding, so both layers run.
 *
 * Every request is issued through an undici Agent whose connect.lookup is the
 * authoritative guard: it resolves each hostname, validates that ALL resolved
 * addresses are public (literal loopback/private/link-local/ULA refused), and
 * returns ONLY those validated addresses for the actual connection — undici
 * connects to the validated addresses, so there is no re-resolution race and no
 * unpinned connect. TLS hostname validation (SNI + certificate verification
 * against the original URL hostname) is retained by the dispatcher. The
 * pre-flight checks in boundedJson/probeEndpoint are advisory fast paths that
 * produce evidence findings; the dispatcher lookup refuses any private
 * destination regardless.
 */
/** Pinned fetch signature: same call shape as global fetch (string URL). */
export type PinnedFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Pinned fetch: undici Agent dispatcher that only connects to validated public addresses. */
export function createPinnedFetch(): PinnedFetch {
	const agent = new Agent({
		connect: {
			lookup: (hostname: string, _options: unknown, callback: (error: Error | null, address: string | LookupAddress[]) => void) => {
				dns
					.lookup(hostname, { all: true })
					.then((addresses) => {
						if (addresses.length === 0) {
							callback(new Error(`dns: ${hostname} has no addresses`), "");
							return;
						}
						for (const { address } of addresses) {
							if (isLiteralPrivateOrLoopbackHost(address) || isLiteralPrivateOrLoopbackHost(`[${address}]`)) {
								callback(new Error(`dns: ${hostname} resolves to private address ${address}`), "");
								return;
							}
						}
						callback(
							null,
							addresses.map((entry) => ({ address: entry.address, family: entry.family })),
						);
					})
					.catch((error: Error) => callback(error, ""));
			},
		},
	});
	return (url: string, init: RequestInit) =>
		undiciFetch(url, { ...init, dispatcher: agent } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

let pinnedFetch: PinnedFetch | undefined;
function fetchPinned(): PinnedFetch {
	pinnedFetch ??= createPinnedFetch();
	return pinnedFetch;
}

/** Advisory pre-flight DNS check (evidence findings); the dispatcher lookup stays authoritative. */
export async function assertPublicDns(url: string): Promise<string | undefined> {
	const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
	if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) return undefined; // literal IPs are handled by isFetchableUrl
	const dns = await import("node:dns/promises");
	try {
		const addresses = await dns.lookup(hostname, { all: true });
		if (addresses.length === 0) return "dns: no addresses";
		for (const { address } of addresses) {
			if (isLiteralPrivateOrLoopbackHost(address) || isLiteralPrivateOrLoopbackHost(`[${address}]`)) {
				return `dns: ${hostname} resolves to private address ${address}`;
			}
		}
		return undefined;
	} catch (error) {
		return `dns: lookup failed (${(error as Error & { code?: string }).code ?? "error"})`;
	}
}

/** Extracts the recorded protected-resource evidence fields from a PRM document. */
export function extractPrm(json: unknown): PrmEvidence {
	const record = json as Record<string, unknown>;
	const evidence: PrmEvidence = {};
	if (typeof record.resource === "string") evidence.resource = record.resource;
	if (Array.isArray(record.authorization_servers)) {
		evidence.authorizationServers = record.authorization_servers.filter(
			(server): server is string => typeof server === "string",
		);
	}
	if (Array.isArray(record.scopes_supported)) {
		evidence.protectedResourceScopes = record.scopes_supported
			.filter((scope): scope is string => typeof scope === "string")
			.slice(0, SCOPES_CAP);
	}
	return evidence;
}

/** Extracts the recorded authorization-server evidence fields from an AS document. */
export function extractAs(json: unknown): AsEvidence {
	const record = json as Record<string, unknown>;
	const evidence: AsEvidence = {};
	if (typeof record.issuer === "string") evidence.issuer = record.issuer;
	if (typeof record.authorization_endpoint === "string") evidence.authorizationEndpoint = record.authorization_endpoint;
	if (typeof record.token_endpoint === "string") evidence.tokenEndpoint = record.token_endpoint;
	if (typeof record.registration_endpoint === "string") evidence.registrationEndpoint = record.registration_endpoint;
	// Omitted lists stay ABSENT (engine applies spec defaults: S256 sent when PKCE
	// metadata is absent; client_secret_basic assumed when auth methods are
	// absent). Present-but-lacking lists are recorded as real values (e.g. false).
	if (Array.isArray(record.code_challenge_methods_supported)) {
		evidence.pkceS256 = record.code_challenge_methods_supported.includes("S256");
	}
	if (record.client_id_metadata_document_supported === true) evidence.clientIdMetadataDocument = true;
	if (Array.isArray(record.scopes_supported)) {
		evidence.authorizationServerScopes = record.scopes_supported
			.filter((scope): scope is string => typeof scope === "string")
			.slice(0, SCOPES_CAP);
	}
	if (Array.isArray(record.token_endpoint_auth_methods_supported)) {
		evidence.tokenAuthMethods = record.token_endpoint_auth_methods_supported
			.filter((method): method is string => typeof method === "string")
			.slice(0, AUTH_METHODS_CAP);
	}
	return evidence;
}

// ---------------------------------------------------------------------------
// Bounded network fetches (manual run only; never called from tests)
// ---------------------------------------------------------------------------

function classifyError(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
		if (/redirect/i.test(error.message)) return "redirect";
		if (/fetch failed/i.test(error.message)) return "network";
		return "error";
	}
	return "error";
}

async function boundedJson(
	url: string,
): Promise<{ httpStatus: number; contentType?: string; json?: unknown; error?: string }> {
	if (!isFetchableUrl(url)) {
		return { httpStatus: 0, error: "url rejected (must be https, public literal address)" };
	}
	const dnsError = await assertPublicDns(url);
	if (dnsError) {
		return { httpStatus: 0, error: dnsError };
	}
	try {
		const response = await fetchPinned()(url, {
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { "user-agent": USER_AGENT, accept: "application/json" },
		});
		// Some servers duplicate the header value ("application/json, application/json");
		// take the first media-type token.
		const contentType = response.headers
			.get("content-type")
			?.split(";")[0]
			?.split(",")[0]
			?.trim()
			.toLowerCase();
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return { httpStatus: response.status, contentType };
		}
		if (contentType !== "application/json") {
			await response.body?.cancel().catch(() => {});
			return { httpStatus: response.status, contentType, error: `content-type ${contentType ?? "none"} (expected application/json)` };
		}
		// Bounded body read: never trust Content-Length; cap at MAX_BODY_BYTES.
		const reader = response.body?.getReader();
		if (!reader) return { httpStatus: response.status, contentType, error: "no response body" };
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				return { httpStatus: response.status, contentType, error: `body exceeds ${MAX_BODY_BYTES} bytes` };
			}
			chunks.push(value);
		}
		const text = Buffer.concat(chunks).toString("utf8");
		try {
			return { httpStatus: response.status, contentType, json: JSON.parse(text) };
		} catch {
			return { httpStatus: response.status, contentType, error: "invalid JSON body" };
		}
	} catch (error) {
		return { httpStatus: 0, error: classifyError(error) };
	}
}

/** Unauthenticated probe of the MCP endpoint: only the WWW-Authenticate hint is read; the body is cancelled. */
async function probeEndpoint(endpoint: string): Promise<AuditResult["probe"]> {
	const result: AuditResult["probe"] = { url: endpoint };
	try {
		const dnsError = await assertPublicDns(endpoint);
		if (dnsError) {
			result.error = dnsError;
			return result;
		}
		const response = await fetchPinned()(endpoint, {
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { "user-agent": USER_AGENT, accept: "application/json" },
		});
		result.httpStatus = response.status;
		result.resourceMetadataHeader = parseResourceMetadataHeader(response.headers.get("www-authenticate"));
		await response.body?.cancel().catch(() => {});
	} catch (error) {
		result.error = classifyError(error);
	}
	return result;
}

/**
 * Mirrors the engine's tryProtectedResourceMetadata selection exactly:
 * - a WWW-Authenticate resource_metadata pointer is followed alone — any
 *   failure (fetch, 4xx/5xx, non-JSON, missing resource, audience mismatch,
 *   missing authorization_servers) FAILS CLOSED, no well-known fall-through;
 * - absent a pointer, the pathful well-known is tried first, then the
 *   origin-level root well-known (SDK parity: a 4xx at one location is not
 *   proof the other is absent); non-4xx failures and invalid documents fail
 *   closed instead of falling through.
 * A candidate is selectable only when it serves a valid document whose
 * resource matches the endpoint audience (component comparison) and whose
 * authorization_servers is non-empty — exactly the engine's resourceMetadata
 * validation.
 */
function engineSelectProtectedResource(
	attempts: PrmAttempt[],
	endpoint: string,
	hasPath: boolean,
	hasHeader: boolean,
): PrmAttempt | undefined {
	const attemptByKind = (kind: PrmAttempt["kind"]) => attempts.find((attempt) => attempt.kind === kind);
	const valid = (attempt: PrmAttempt): boolean =>
		attempt.status === "available" &&
		audienceMatchesEngineRule(attempt.evidence?.resource, endpoint) &&
		(attempt.evidence?.authorizationServers?.length ?? 0) > 0;
	if (hasHeader) {
		const header = attemptByKind("header");
		return header && valid(header) ? header : undefined;
	}
	const enginePath: PrmAttempt["kind"][] = hasPath ? ["pathful", "origin"] : ["pathful"];
	for (const kind of enginePath) {
		const attempt = attemptByKind(kind);
		if (!attempt) continue;
		if (valid(attempt)) return attempt;
		const is4xx = attempt.httpStatus !== undefined && attempt.httpStatus >= 400 && attempt.httpStatus < 500;
		if (!is4xx) return undefined;
	}
	return undefined;
}

/** Honest, bounded reason for a fail-closed PRM discovery (mirrors oauth.ts). */
function engineSelectionNote(
	attempts: PrmAttempt[],
	endpoint: string,
	hasPath: boolean,
	hasHeader: boolean,
): string {
	const attemptByKind = (kind: PrmAttempt["kind"]) => attempts.find((attempt) => attempt.kind === kind);
	const served = (attempt: PrmAttempt | undefined): boolean => !!attempt && attempt.status === "available";
	if (hasHeader) {
		const header = attemptByKind("header");
		return served(header)
			? "the header-pointed document fails the engine's protected-resource validation; PRM discovery fails closed with no well-known fall-through"
			: "the WWW-Authenticate resource_metadata pointer could not be fetched; PRM discovery fails closed with no well-known fall-through";
	}
	const pathful = attemptByKind("pathful");
	const origin = attemptByKind("origin");
	if (served(pathful)) {
		return "the pathful protected-resource document fails the engine's audience/structure validation; PRM discovery fails closed before the origin-level location";
	}
	if (served(origin)) {
		return "the origin-level protected-resource document fails the engine's audience/structure validation; PRM discovery fails closed";
	}
	return hasPath
		? "no valid protected-resource document at the pathful or origin-level well-known locations"
		: "no valid protected-resource document at the well-known location";
}

async function auditEndpoint(server: string, endpoint: string): Promise<AuditResult> {
	const probe = await probeEndpoint(endpoint);
	// Metadata-supplied destinations (header hint, PRM authorization_servers) are
	// only followed when they pass the same https + literal-public + DNS checks.
	const endpointUrl = new URL(endpoint);
	const origin = endpointUrl.origin;
	const hasPath = endpointUrl.pathname !== "/" && endpointUrl.pathname !== "";
	const headerUrl =
		probe.resourceMetadataHeader && isFetchableUrl(probe.resourceMetadataHeader)
			? probe.resourceMetadataHeader
			: undefined;
	const pathfulUrl = protectedResourceUrl(endpoint);
	const originUrl = `${origin}/.well-known/oauth-protected-resource`;
	// Evidence locations are all recorded (which body serves where), while the
	// selection mirrors the engine runtime exactly (fail-closed rules above).
	const candidates: Array<{ url: string; kind: "header" | "pathful" | "origin" }> = [];
	if (headerUrl) candidates.push({ url: headerUrl, kind: "header" });
	candidates.push({ url: pathfulUrl, kind: "pathful" });
	if (hasPath) candidates.push({ url: originUrl, kind: "origin" });
	const attempts: PrmAttempt[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate.url)) continue;
		seen.add(candidate.url);
		const fetchResult = await boundedJson(candidate.url);
		const evidence = fetchResult.json ? extractPrm(fetchResult.json) : undefined;
		const attempt: PrmAttempt = {
			sourceUrl: candidate.url,
			kind: candidate.kind,
			status: fetchResult.json ? "available" : "unavailable",
			...(evidence
				? { evidence }
				: { httpStatus: fetchResult.httpStatus, error: fetchResult.error ?? `http ${fetchResult.httpStatus}` }),
		};
		if (evidence?.resource !== undefined) attempt.audienceMatches = evidence.resource === endpoint;
		attempts.push(attempt);
	}
	const selected = engineSelectProtectedResource(attempts, endpoint, hasPath, headerUrl !== undefined);
	const protectedResource: AuditResult["protectedResource"] = {
		attempts,
		engineVisible: selected ? "available" : "unavailable",
		...(selected ? { engineSelectedSourceUrl: selected.sourceUrl } : { selectionNote: engineSelectionNote(attempts, endpoint, hasPath, headerUrl !== undefined) }),
	};

	const issuer =
		selected?.evidence?.authorizationServers?.find((candidate) => typeof candidate === "string" && isFetchableUrl(candidate)) ??
		new URL(endpoint).origin;
	const asCandidates = authorizationServerUrls(issuer);
	const authorizationServer: AuditResult["authorizationServer"] = {
		sourceUrls: asCandidates,
		status: "unavailable",
	};
	for (const candidate of asCandidates) {
		const asFetch = await boundedJson(candidate);
		if (asFetch.json) {
			authorizationServer.status = "available";
			authorizationServer.issuer = issuer;
			authorizationServer.evidence = extractAs(asFetch.json);
			break;
		}
	}
	if (authorizationServer.status === "unavailable" && !authorizationServer.evidence) {
		const first = await boundedJson(asCandidates[0]);
		authorizationServer.evidence = {
			httpStatus: first.httpStatus,
			contentType: first.contentType,
			error: first.error ?? `http ${first.httpStatus}`,
		};
	}
	return { server, endpoint, probe, protectedResource, authorizationServer };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface CatalogEntryShape {
	server: string;
	url: string;
	transport: { type: string };
}

async function main(): Promise<void> {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url));
	const catalogPath = path.resolve(scriptDir, "../../src/mcp/catalog.json");
	const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { entries: CatalogEntryShape[] };
	const targets = catalog.entries
		.filter((entry) => entry.transport.type === "http" || entry.transport.type === "sse")
		.map((entry) => ({ server: entry.server, endpoint: entry.url }))
		.sort((a, b) => a.server.localeCompare(b.server));

	const results: AuditResult[] = [];
	let cursor = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const index = cursor++;
			if (index >= targets.length) return;
			const target = targets[index];
			const result = await auditEndpoint(target.server, target.endpoint);
			results.push(result);
			const as = result.authorizationServer;
			console.log(
				`[${results.length}/${targets.length}] ${result.server}: PRM ${result.protectedResource.engineVisible}` +
					` | AS ${as.status}` +
					` | DCR ${as.evidence?.registrationEndpoint ? "yes" : "no"}` +
					` | CIMD ${as.evidence?.clientIdMetadataDocument ? "yes" : "no"}`,
			);
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
	results.sort((a, b) => a.server.localeCompare(b.server));

	const counts = {
		audited: results.length,
		asAvailable: results.filter((result) => result.authorizationServer.status === "available").length,
		prmEngineVisible: results.filter((result) => result.protectedResource.engineVisible === "available").length,
		prmAudienceMismatch: results.filter(
			(result) =>
				result.protectedResource.engineVisible === "available" &&
				!result.protectedResource.attempts.some(
					(attempt) => attempt.status === "available" && attempt.audienceMatches,
				),
		).length,
		asUnavailable: results.filter((result) => result.authorizationServer.status === "unavailable").length,
		dcr: results.filter((result) => result.authorizationServer.evidence?.registrationEndpoint).length,
		cimd: results.filter((result) => result.authorizationServer.evidence?.clientIdMetadataDocument).length,
		pkceS256: results.filter((result) => result.authorizationServer.evidence?.pkceS256).length,
	};

	const output = {
		$comment:
			"READ-ONLY public metadata audit snapshot (unauthenticated GETs of RFC 9728 / AS / OIDC documents). A valid metadata GET is never proof that live OAuth works; results are never labeled metadata-reviewed or live-verified. Generated by audit-provider-metadata.ts; an input to the offline importer; do not hand-edit results.",
		fetchedAt: new Date().toISOString().slice(0, 10),
		method:
			"per endpoint: unauthenticated MCP endpoint probe (WWW-Authenticate resource_metadata), RFC 9728 protected-resource metadata, authorization-server metadata (oauth-authorization-server / openid-configuration candidates)",
		bounds: {
			requestTimeoutMs: REQUEST_TIMEOUT_MS,
			maxBodyBytes: MAX_BODY_BYTES,
			concurrency: CONCURRENCY,
			redirects: "recorded, never followed",
			auth: "none (no Authorization headers, no cookies)",
			dns: "pinned per request: undici Agent connect.lookup resolves, validates all addresses public and returns only those addresses for the connect (TLS hostname validation retained); pre-flight checks advisory",
		},
		userAgent: USER_AGENT,
		counts,
		results,
	};
	const outPath = path.resolve(scriptDir, "metadata-audit.json");
	fs.writeFileSync(outPath, `${JSON.stringify(output, null, "\t")}\n`);
	console.log(
		`wrote ${outPath}: ${counts.audited} audited, AS available ${counts.asAvailable}, unavailable ${counts.asUnavailable}, DCR ${counts.dcr}, CIMD ${counts.cimd}, PKCE S256 ${counts.pkceS256}`,
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
