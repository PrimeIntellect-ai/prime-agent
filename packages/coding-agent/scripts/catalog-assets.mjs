#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const bundledCatalogFiles = ["models.bundled.json", "mcp-services.bundled.json"];
export const MIN_BUNDLED_MODEL_TRANSPORT_TUPLES = 42;
export const MIN_BUNDLED_MCP_SERVICES = 20;
export const DEFAULT_MODEL_CATALOG_URL =
	"https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/models/catalog.v1.json";
export const DEFAULT_MCP_SERVICE_CATALOG_URL =
	"https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/plugins/catalog.v2.json";
export const MAX_REMOTE_CATALOG_BYTES = 20 * 1024 * 1024;

function catalogSourcePaths(catalogDir) {
	return {
		models: join(catalogDir, "models", "catalog.v1.json"),
		mcpServices: join(catalogDir, "plugins", "catalog.v2.json"),
	};
}

function bundledTargets(outDir) {
	return {
		models: join(outDir, "models.bundled.json"),
		mcpServices: join(outDir, "mcp-services.bundled.json"),
	};
}

function isTrustedCatalogUrl(url) {
	try {
		const parsed = new URL(url);
		return (
			parsed.origin === "https://raw.githubusercontent.com" &&
			parsed.pathname.startsWith("/PrimeIntellect-ai/prime-agent-catalog/")
		);
	} catch {
		return false;
	}
}

function authHeaders(url, options = {}) {
	const token = process.env.GITHUB_TOKEN || process.env.PRIME_CATALOG_REPO_TOKEN;
	return {
		accept: "application/json",
		...(token && (options.allowTokenForUrl === true || isTrustedCatalogUrl(url))
			? { authorization: `Bearer ${token}` }
			: {}),
	};
}

async function readBoundedResponseText(response, label) {
	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (contentLength > MAX_REMOTE_CATALOG_BYTES) {
		throw new Error(`${label} catalog is too large: ${contentLength} bytes exceeds ${MAX_REMOTE_CATALOG_BYTES}`);
	}
	if (!response.body) {
		const body = await response.text();
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > MAX_REMOTE_CATALOG_BYTES) {
			throw new Error(`${label} catalog is too large: ${bytes} bytes exceeds ${MAX_REMOTE_CATALOG_BYTES}`);
		}
		return body;
	}
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytes += value.byteLength;
			if (bytes > MAX_REMOTE_CATALOG_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error(`${label} catalog is too large: ${bytes} bytes exceeds ${MAX_REMOTE_CATALOG_BYTES}`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchCatalogViaContentsApi(rawUrl, label, options = {}) {
	// Sandboxes and restrictive proxies may block raw.githubusercontent.com while still
	// reaching the GitHub API; the public catalog is readable through the contents API
	// without credentials. Only invoked for the trusted catalog origin URLs.
	const match = rawUrl.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
	if (!match) throw new Error(`Cannot map ${rawUrl} to the GitHub contents API`);
	const [, owner, repo, ref, path] = match;
	const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
	let response;
	try {
		response = await fetch(apiUrl, {
			headers: { ...authHeaders(rawUrl, options), accept: "application/vnd.github.raw+json" },
			signal: AbortSignal.timeout(5_000),
			redirect: "error",
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to fetch ${label} catalog from ${apiUrl}: ${reason}`);
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch ${label} catalog from ${apiUrl}: HTTP ${response.status}`);
	}
	return await readBoundedResponseText(response, label);
}

async function fetchCatalog(url, label, options = {}) {
	let response;
	try {
		response = await fetch(url, {
			headers: authHeaders(url, options),
			signal: AbortSignal.timeout(5_000),
			redirect: "error",
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const viaApi = await fetchCatalogViaContentsApi(url, label, options).catch(() => undefined);
		if (viaApi !== undefined) return viaApi.endsWith("\n") ? viaApi : `${viaApi}\n`;
		throw new Error(`Failed to fetch ${label} catalog from ${url}: ${reason}`);
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 404) {
			const viaApi = await fetchCatalogViaContentsApi(url, label, options).catch(() => undefined);
			if (viaApi !== undefined) return viaApi.endsWith("\n") ? viaApi : `${viaApi}\n`;
		}
		const privateRepoHint =
			response.status === 401 || response.status === 404
				? " The catalog repo is private; set GITHUB_TOKEN or PRIME_CATALOG_REPO_TOKEN."
				: "";
		throw new Error(`Failed to fetch ${label} catalog from ${url}: HTTP ${response.status}.${privateRepoHint}`);
	}
	const body = await readBoundedResponseText(response, label);
	return body.endsWith("\n") ? body : `${body}\n`;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

const MODEL_REQUIRED_KEYS = ["id", "name", "api", "provider", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"];
const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
const MCP_REQUIRED_KEYS = ["server", "service", "label", "url", "aliases", "transport", "auth", "setup", "verification", "legacyBuiltin", "provenance"];

/**
 * Per-entry structural checks mirroring the runtime parsers' required fields, so a
 * malformed bundled asset fails the build here instead of being silently rejected
 * by parseModelCatalog/parseMcpServiceCatalogFile at runtime (which would drop the
 * user to the compiled fallback).
 */
export function validateBundledModelCatalog(path, options = {}) {
	const catalog = readJson(path);
	if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.models)) throw new Error(`Invalid bundled model catalog: ${path}`);
	const tuples = new Set();
	const seen = new Set();
	for (const [index, model] of catalog.models.entries()) {
		if (!model || typeof model !== "object") throw new Error(`Bundled model catalog entry ${index} is not an object: ${path}`);
		for (const key of MODEL_REQUIRED_KEYS) {
			if (!(key in model)) throw new Error(`Bundled model catalog entry ${index} is missing required key ${key}: ${path}`);
		}
		for (const key of ["id", "name", "api", "provider"]) {
			if (typeof model[key] !== "string" || model[key] === "") {
				throw new Error(`Bundled model catalog entry ${index} has an invalid ${key}: ${path}`);
			}
		}
		if (typeof model.baseUrl !== "string") {
			throw new Error(`Bundled model catalog entry ${index} has a non-string baseUrl: ${path}`);
		}
		if (typeof model.reasoning !== "boolean") {
			throw new Error(`Bundled model catalog entry ${index} has a non-boolean reasoning: ${path}`);
		}
		if (!Array.isArray(model.input) || model.input.length === 0 || !model.input.every((item) => item === "text" || item === "image")) {
			throw new Error(`Bundled model catalog entry ${index} has invalid input modalities: ${path}`);
		}
		if (!model.cost || typeof model.cost !== "object") {
			throw new Error(`Bundled model catalog entry ${index} has a non-object cost: ${path}`);
		}
		for (const key of MODEL_COST_KEYS) {
			if (typeof model.cost[key] !== "number" || !Number.isFinite(model.cost[key]) || model.cost[key] < 0) {
				throw new Error(`Bundled model catalog entry ${index} has an invalid cost.${key}: ${path}`);
			}
		}
		if (typeof model.contextWindow !== "number" || !Number.isInteger(model.contextWindow) || model.contextWindow < 1) {
			throw new Error(`Bundled model catalog entry ${index} has an invalid contextWindow: ${path}`);
		}
		if (typeof model.maxTokens !== "number" || !Number.isInteger(model.maxTokens) || model.maxTokens < 1) {
			throw new Error(`Bundled model catalog entry ${index} has an invalid maxTokens: ${path}`);
		}
		const key = `${model.provider}\u0000${model.id}`;
		if (seen.has(key)) throw new Error(`Bundled model catalog has duplicate provider/id ${key}: ${path}`);
		seen.add(key);
		if (tuples.size < 10_000) tuples.add(JSON.stringify([model.provider, model.api, model.baseUrl]));
	}
	if (!options.allowSmallFixture && tuples.size < MIN_BUNDLED_MODEL_TRANSPORT_TUPLES) {
		throw new Error(`Bundled model catalog has ${tuples.size} transport tuples; expected at least ${MIN_BUNDLED_MODEL_TRANSPORT_TUPLES}`);
	}
	return { models: catalog.models.length, transportTuples: tuples.size };
}

export function validateBundledMcpCatalog(path, options = {}) {
	const catalog = readJson(path);
	if (catalog?.version !== 2 || !Array.isArray(catalog.entries)) throw new Error(`Invalid bundled MCP service catalog: ${path}`);
	const seen = new Set();
	for (const [index, entry] of catalog.entries.entries()) {
		if (!entry || typeof entry !== "object") throw new Error(`Bundled MCP service catalog entry ${index} is not an object: ${path}`);
		for (const key of MCP_REQUIRED_KEYS) {
			if (!(key in entry)) throw new Error(`Bundled MCP service catalog entry ${index} is missing required key ${key}: ${path}`);
		}
		for (const key of ["server", "service", "label"]) {
			if (typeof entry[key] !== "string" || entry[key] === "") {
				throw new Error(`Bundled MCP service catalog entry ${index} has an invalid ${key}: ${path}`);
			}
		}
		// The runtime catalog allows an empty url for stdio and http-template transports.
		if (typeof entry.url !== "string" || (entry.url === "" && entry.transport.type !== "stdio" && entry.transport.type !== "http-template")) {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid url: ${path}`);
		}
		if (!Array.isArray(entry.aliases) || !entry.aliases.every((alias) => typeof alias === "string")) {
			throw new Error(`Bundled MCP service catalog entry ${index} has invalid aliases: ${path}`);
		}
		if (!entry.transport || typeof entry.transport !== "object" || typeof entry.transport.type !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid transport: ${path}`);
		}
		if (!entry.auth || typeof entry.auth !== "object" || typeof entry.auth.strategy !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid auth: ${path}`);
		}
		if (!entry.setup || typeof entry.setup !== "object" || typeof entry.setup.status !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid setup: ${path}`);
		}
		if (!entry.verification || typeof entry.verification !== "object" || typeof entry.verification.status !== "string") {
			throw new Error(`Bundled MCP service catalog entry ${index} has an invalid verification: ${path}`);
		}
		if (typeof entry.legacyBuiltin !== "boolean") {
			throw new Error(`Bundled MCP service catalog entry ${index} has a non-boolean legacyBuiltin: ${path}`);
		}
		if (!Array.isArray(entry.provenance) || entry.provenance.length === 0) {
			throw new Error(`Bundled MCP service catalog entry ${index} has invalid provenance: ${path}`);
		}
		if (seen.has(entry.server)) throw new Error(`Bundled MCP service catalog has duplicate server id ${entry.server}: ${path}`);
		seen.add(entry.server);
	}
	if (!options.allowSmallFixture && catalog.entries.length < MIN_BUNDLED_MCP_SERVICES) {
		throw new Error(`Bundled MCP service catalog has ${catalog.entries.length} entries; expected at least ${MIN_BUNDLED_MCP_SERVICES}`);
	}
	return { services: catalog.entries.length };
}

export function validateBundledCatalogDir(directory, options = {}) {
	return {
		models: validateBundledModelCatalog(join(directory, "models.bundled.json"), options),
		mcpServices: validateBundledMcpCatalog(join(directory, "mcp-services.bundled.json"), options),
	};
}

function fixtureModel({ id, name, provider, api, baseUrl, reasoning = false, input = ["text"] }) {
	return {
		id,
		name,
		api,
		provider,
		baseUrl,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function fixtureMcpEntry({ server, label, url, auth = "oauth", setup = { status: "ready", readiness: "oauth-ready" }, transport }) {
	return {
		server,
		service: server,
		label,
		url,
		category: "Fixture",
		aliases: [],
		publisher: "Prime Intellect",
		transport: transport ?? { type: "http", url },
		auth: { strategy: auth, clientRegistration: auth === "oauth" ? "dynamic" : "unknown" },
		setup,
		verification: { status: "unverified" },
		legacyBuiltin: false,
		provenance: [{ source: "prime" }],
		...(auth === "oauth" ? { oauth: { kind: "oauth" } } : {}),
	};
}

function fixtureCatalogBodies() {
	return {
		models: `${JSON.stringify(
			{
				schemaVersion: 1,
				models: [
					fixtureModel({
						id: "fixture-gpt",
						name: "Fixture GPT",
						provider: "openai",
						api: "openai-responses",
						baseUrl: "https://api.openai.com/v1",
						reasoning: true,
					}),
					fixtureModel({
						id: "fixture-claude",
						name: "Fixture Claude",
						provider: "anthropic",
						api: "anthropic-messages",
						baseUrl: "https://api.anthropic.com",
						input: ["text", "image"],
					}),
					fixtureModel({
						id: "fixture-prime",
						name: "Fixture Prime",
						provider: "prime-inference",
						api: "openai-completions",
						baseUrl: "https://api.primeintellect.ai/api/v1",
					}),
					fixtureModel({
						id: "fixture-gemini",
						name: "Fixture Gemini",
						provider: "google-gemini",
						api: "gemini",
						baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					}),
				],
			},
			null,
			2,
		)}\n`,
		mcpServices: `${JSON.stringify(
			{
				version: 2,
				counts: { entries: 4 },
				entries: [
					fixtureMcpEntry({ server: "linear", label: "Linear", url: "https://mcp.linear.app/mcp" }),
					fixtureMcpEntry({ server: "notion", label: "Notion", url: "https://mcp.notion.com/mcp" }),
					fixtureMcpEntry({
						server: "github",
						label: "GitHub",
						url: "https://api.githubcopilot.com/mcp/",
						auth: "api_key",
						setup: {
							status: "requires-setup",
							reason: "Paste a GitHub personal access token.",
							readiness: "user-setup",
							requirement: "bearer-token",
							fields: [
								{
									id: "GITHUB_PAT_TOKEN",
									label: "GitHub personal access token",
									required: true,
									kind: "bearer-token",
									credentialSet: "github-pat",
								},
							],
						},
					}),
					fixtureMcpEntry({
						server: "local-tools",
						label: "Local Tools",
						url: "",
						auth: "none",
						setup: { status: "requires-setup", reason: "Requires a local stdio runtime.", readiness: "user-setup", requirement: "local-runtime" },
						transport: { type: "stdio", servers: [{ name: "local-tools", command: "local-tools-mcp" }] },
					}),
				],
			},
			null,
			2,
		)}\n`,
	};
}

function copyCatalogSourcesToTargets(sourceDir, outDir) {
	const paths = catalogSourcePaths(resolve(sourceDir));
	const targets = bundledTargets(outDir);
	cpSync(paths.models, targets.models);
	cpSync(paths.mcpServices, targets.mcpServices);
}

export async function generateBundledCatalogAssets(options = {}) {
	const outDir = resolve(options.outDir ?? join(packageDir, "dist"));
	mkdirSync(outDir, { recursive: true });
	const targets = bundledTargets(outDir);
	if (options.fixture) {
		const fixture = fixtureCatalogBodies();
		writeFileSync(targets.models, fixture.models);
		writeFileSync(targets.mcpServices, fixture.mcpServices);
	} else if (options.catalogDir) {
		copyCatalogSourcesToTargets(options.catalogDir, outDir);
	} else {
		const [modelBody, mcpServiceBody] = await Promise.all([
			fetchCatalog(options.modelsUrl ?? DEFAULT_MODEL_CATALOG_URL, "model", options),
			fetchCatalog(options.mcpServicesUrl ?? DEFAULT_MCP_SERVICE_CATALOG_URL, "MCP service", options),
		]);
		writeFileSync(targets.models, modelBody);
		writeFileSync(targets.mcpServices, mcpServiceBody);
	}
	return validateBundledCatalogDir(outDir, { allowSmallFixture: options.allowSmallFixture === true || options.fixture === true });
}

export async function copySourceCatalogAssets(options = {}) {
	const outDir = resolve(options.outDir ?? join(packageDir, "dist"));
	mkdirSync(outDir, { recursive: true });
	const targets = bundledTargets(outDir);
	// Prefer the generated source catalog over stale dist copies: incremental
	// builds must package the freshly generated snapshot, not whatever dist
	// happened to keep from a previous build.
	const sourceDir = join(packageDir, "catalog");
	const allSourcesPresent = bundledCatalogFiles.every((file) => existsSync(join(sourceDir, file)));
	if (allSourcesPresent) {
		cpSync(join(sourceDir, "models.bundled.json"), targets.models);
		cpSync(join(sourceDir, "mcp-services.bundled.json"), targets.mcpServices);
		// The deterministic `--fixture` output is the one intentionally-small asset set a
		// source build may package (pack smoke without catalog access). Anything else
		// must be a real catalog and validates with full minimum counts.
		const fixtureBodies = fixtureCatalogBodies();
		const isFixture =
			readFileSync(targets.models, "utf8") === fixtureBodies.models &&
			readFileSync(targets.mcpServices, "utf8") === fixtureBodies.mcpServices;
		return validateBundledCatalogDir(outDir, {
			...options,
			allowSmallFixture: options.allowSmallFixture === true || isFixture,
		});
	}

	const allTargetsPresent = bundledCatalogFiles.every((file) => existsSync(join(outDir, file)));
	if (allTargetsPresent) return validateBundledCatalogDir(outDir, options);

	try {
		const [modelBody, mcpServiceBody] = await Promise.all([
			fetchCatalog(options.modelsUrl ?? DEFAULT_MODEL_CATALOG_URL, "model", options),
			fetchCatalog(options.mcpServicesUrl ?? DEFAULT_MCP_SERVICE_CATALOG_URL, "MCP service", options),
		]);
		writeFileSync(targets.models, modelBody);
		writeFileSync(targets.mcpServices, mcpServiceBody);
		return validateBundledCatalogDir(outDir, options);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const message =
			"Missing generated catalog assets and failed to fetch public catalog assets. Run `npm run catalog:assets -- --catalog-dir /path/to/prime-agent-catalog` or set GITHUB_TOKEN or PRIME_CATALOG_REPO_TOKEN and run `npm run catalog:assets`.";
		if (options.optional) {
			// The optional path (source builds, benchmark harnesses without catalog
			// credentials) still packages a VALID bundled snapshot: the deterministic
			// fixture. Release builds never pass --optional and hard-fail instead.
			const fixtureBodies = fixtureCatalogBodies();
			writeFileSync(targets.models, fixtureBodies.models);
			writeFileSync(targets.mcpServices, fixtureBodies.mcpServices);
			console.warn(
				`${message} ${reason} Continuing with the deterministic fixture snapshot; source runs will fetch the real catalog at runtime.`,
			);
			return validateBundledCatalogDir(outDir, { ...options, allowSmallFixture: true });
		}
		throw new Error(message, { cause: error });
	}
}

function parseArgs(argv) {
	let [command, ...rest] = argv;
	if (!command || command.startsWith("--")) {
		command = "generate";
		rest = argv;
	}
	const options = {};
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === "--out") options.outDir = rest[++i];
		else if (arg === "--catalog-dir") options.catalogDir = rest[++i];
		else if (arg === "--models-url") options.modelsUrl = rest[++i];
		else if (arg === "--mcp-services-url") options.mcpServicesUrl = rest[++i];
		else if (arg === "--fixture") options.fixture = true;
		else if (arg === "--allow-small-fixture") options.allowSmallFixture = true;
		else if (arg === "--allow-token-for-url") options.allowTokenForUrl = true;
		else if (arg === "--optional") options.optional = true;
		else throw new Error(`Unknown catalog-assets argument: ${arg}`);
	}
	return { command, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { command, options } = parseArgs(process.argv.slice(2));
	const result =
		command === "generate"
			? await generateBundledCatalogAssets(options)
			: command === "copy-source"
				? await copySourceCatalogAssets(options)
				: command === "verify"
					? validateBundledCatalogDir(resolve(options.outDir ?? join(packageDir, "dist")), options)
					: undefined;
	if (!result) throw new Error("Usage: catalog-assets.mjs [generate|copy-source|verify] [--out DIR] [--catalog-dir DIR] [--fixture]");
	console.log(JSON.stringify(result, null, 2));
}
