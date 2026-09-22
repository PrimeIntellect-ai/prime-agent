/**
 * Pinned trust anchors for compiled Prime Agent releases.
 *
 * Everything the self-updater is willing to trust is declared here, in one auditable place. The
 * release workflow signs `SHA256SUMS` with a cosign keyless signature; the updater then refuses any
 * artifact whose digest is not listed in a `SHA256SUMS` carrying a signature from EXACTLY this
 * repository, EXACTLY this workflow file and a ref matching EXACTLY this pattern.
 *
 * These values are deliberately NOT configurable at runtime. `PRIME_AGENT_DOWNLOAD_BASE_URL` may
 * move the download origin for development, but it cannot relax or replace anything below.
 */

/** The only repository whose releases this build will install. */
export const RELEASE_SIGNER_REPOSITORY = "PrimeIntellect-ai/prime-agent";

/** `SourceRepositoryURI` recorded in the signing certificate. */
export const RELEASE_SIGNER_REPOSITORY_URI = `https://github.com/${RELEASE_SIGNER_REPOSITORY}`;

/** The only workflow file allowed to produce a release signature. */
export const RELEASE_SIGNER_WORKFLOW_PATH = ".github/workflows/build-binaries.yml";

/** The OIDC issuer that must have minted the signing certificate. */
export const RELEASE_SIGNER_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** Self-hosted runners are not part of the release path, so the certificate must say github-hosted. */
export const RELEASE_SIGNER_RUNNER_ENVIRONMENT = "github-hosted";

/**
 * Refs the release workflow is allowed to sign from: `main` (the normal merge-triggered release) and
 * `v<semver>` tags (the break-glass path). Any other ref - a feature branch, a fork, a pull request
 * ref - is rejected even though the certificate is otherwise valid.
 */
export const RELEASE_SIGNER_REF_PATTERN = /^refs\/(?:heads\/main|tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Fulcio X.509 extension OIDs (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md). */
export const FULCIO_OID_SOURCE_REPOSITORY_URI = "1.3.6.1.4.1.57264.1.12";
export const FULCIO_OID_RUNNER_ENVIRONMENT = "1.3.6.1.4.1.57264.1.11";
export const FULCIO_OID_BUILD_SIGNER_URI = "1.3.6.1.4.1.57264.1.9";

/** Release assets the updater fetches, relative to `<base url>/releases/v<version>/`. */
export const RELEASE_CHECKSUMS_ASSET = "SHA256SUMS";
/** cosign `sign-blob --bundle` output for {@link RELEASE_CHECKSUMS_ASSET}. */
export const RELEASE_SIGNATURE_BUNDLE_ASSET = "SHA256SUMS.sigstore.json";

/** The identity policy the verifier enforces. Exported as data so tests can show what is pinned. */
export interface PinnedSignerIdentity {
	/** `SourceRepositoryURI` - the repository whose commit was built. */
	repositoryUri: string;
	/**
	 * The repository that owns the workflow file named in the certificate subject. Identical to
	 * {@link PinnedSignerIdentity.repositoryUri} for us, because we do not sign from a reusable
	 * workflow hosted in another repository. Kept separate so the distinction stays checkable.
	 */
	workflowRepositoryUri: string;
	workflowPath: string;
	oidcIssuer: string;
	runnerEnvironment: string;
	refPattern: RegExp;
}

/** The production release signer. This constant is never modified by the test override below. */
export const PINNED_RELEASE_SIGNER: PinnedSignerIdentity = {
	repositoryUri: RELEASE_SIGNER_REPOSITORY_URI,
	workflowRepositoryUri: RELEASE_SIGNER_REPOSITORY_URI,
	workflowPath: RELEASE_SIGNER_WORKFLOW_PATH,
	oidcIssuer: RELEASE_SIGNER_OIDC_ISSUER,
	runnerEnvironment: RELEASE_SIGNER_RUNNER_ENVIRONMENT,
	refPattern: RELEASE_SIGNER_REF_PATTERN,
};

/**
 * COMPILE-TIME test seam. `scripts/build-binary.mjs` replaces this identifier with
 * `bun build --define`: `null` for every release build, or - only when the build was invoked with
 * `--test-signer-json` - a JSON string literal describing the signer a TEST-ONLY binary trusts
 * instead of {@link PINNED_RELEASE_SIGNER}. CI uses that to exercise `prime-agent update` against an
 * archive it signed itself.
 *
 * The identifier is a bundler substitution, not a variable: in a compiled binary it is a literal
 * baked into the code, and the substitution happens once, at module load. There is deliberately no
 * environment variable, config file, command-line flag or network input that can set it. Under
 * Node/tsx (where nothing substitutes it) the identifier is undeclared and treated as `null`.
 */
declare const __PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__: string | null | undefined;

/** Appended to every user-facing line that names the signer while a test override is compiled in. */
export const RELEASE_SIGNER_TEST_OVERRIDE_MARKER = "(test signer override)";

const RUNNER_ENVIRONMENTS = new Set(["github-hosted", "self-hosted"]);
const OVERRIDE_FIELDS = [
	"repositoryUri",
	"workflowRepositoryUri",
	"workflowPath",
	"oidcIssuer",
	"runnerEnvironment",
	"refPattern",
] as const;

function requireHttpsUrl(field: string, value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Release signer override: ${field} is not a valid URL: ${JSON.stringify(value)}.`);
	}
	if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password)
		throw new Error(`Release signer override: ${field} must be a bare https URL, got ${JSON.stringify(value)}.`);
	return value;
}

/**
 * Parse and validate a signer override document. Every field is mandatory and typed as a string;
 * unknown fields are refused so a misspelt key can never silently fall back to the production value.
 * Exported for the build script and the tests; the runtime only ever calls it on the compiled-in
 * literal above.
 */
export function parseSignerOverride(json: string): PinnedSignerIdentity {
	let document: unknown;
	try {
		document = JSON.parse(json);
	} catch (error) {
		throw new Error(
			`Release signer override is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof document !== "object" || document === null || Array.isArray(document))
		throw new Error("Release signer override must be a JSON object.");
	const record = document as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!(OVERRIDE_FIELDS as readonly string[]).includes(key))
			throw new Error(`Release signer override has an unknown field ${JSON.stringify(key)}.`);
	}
	const fields = {} as Record<(typeof OVERRIDE_FIELDS)[number], string>;
	for (const field of OVERRIDE_FIELDS) {
		const value = record[field];
		if (typeof value !== "string" || value.length === 0)
			throw new Error(`Release signer override: ${field} must be a non-empty string.`);
		fields[field] = value;
	}
	requireHttpsUrl("repositoryUri", fields.repositoryUri);
	requireHttpsUrl("workflowRepositoryUri", fields.workflowRepositoryUri);
	requireHttpsUrl("oidcIssuer", fields.oidcIssuer);
	if (!/^[^\s]+\.ya?ml$/.test(fields.workflowPath) || fields.workflowPath.startsWith("/"))
		throw new Error(
			`Release signer override: workflowPath must be a relative path ending in .yml or .yaml, got ${JSON.stringify(fields.workflowPath)}.`,
		);
	if (!RUNNER_ENVIRONMENTS.has(fields.runnerEnvironment))
		throw new Error(
			`Release signer override: runnerEnvironment must be github-hosted or self-hosted, got ${JSON.stringify(fields.runnerEnvironment)}.`,
		);
	if (!fields.refPattern.startsWith("^") || !fields.refPattern.endsWith("$"))
		throw new Error(`Release signer override: refPattern must be anchored with ^ and $.`);
	let refPattern: RegExp;
	try {
		refPattern = new RegExp(fields.refPattern);
	} catch (error) {
		throw new Error(
			`Release signer override: refPattern does not compile: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		repositoryUri: fields.repositoryUri,
		workflowRepositoryUri: fields.workflowRepositoryUri,
		workflowPath: fields.workflowPath,
		oidcIssuer: fields.oidcIssuer,
		runnerEnvironment: fields.runnerEnvironment,
		refPattern,
	};
}

function readCompiledSignerOverride(): PinnedSignerIdentity | undefined {
	const compiled =
		typeof __PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__ === "undefined" ? null : __PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__;
	if (compiled === null) return undefined;
	if (typeof compiled !== "string")
		throw new Error("Release signer override must be compiled in as null or a JSON string literal.");
	return parseSignerOverride(compiled);
}

/**
 * The test signer compiled into this build, or `undefined` for every release build. Evaluated
 * exactly once, when the module loads; an invalid override makes the module - and therefore the
 * updater - fail to load rather than fall back to anything.
 */
export const RELEASE_SIGNER_TEST_OVERRIDE: PinnedSignerIdentity | undefined = readCompiledSignerOverride();

/** The identity the verifier enforces: the compiled-in test override if there is one, else the production signer. */
export const ACTIVE_RELEASE_SIGNER: PinnedSignerIdentity = RELEASE_SIGNER_TEST_OVERRIDE ?? PINNED_RELEASE_SIGNER;

/** The certificate SAN a release signature must carry for `ref`. */
export function buildExpectedSignerIdentity(identity: PinnedSignerIdentity, ref: string): string {
	return `${identity.workflowRepositoryUri}/${identity.workflowPath}@${ref}`;
}

/** Splits a build-signer SAN back into its workflow URI and ref halves. */
export function parseSignerIdentity(subjectAlternativeName: string): { workflowUri: string; ref: string } | undefined {
	const separator = subjectAlternativeName.lastIndexOf("@");
	if (separator <= 0) return undefined;
	return {
		workflowUri: subjectAlternativeName.slice(0, separator),
		ref: subjectAlternativeName.slice(separator + 1),
	};
}
