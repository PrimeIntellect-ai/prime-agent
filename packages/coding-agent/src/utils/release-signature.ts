import { bundleFromJSON } from "@sigstore/bundle";
import { crypto as sigstoreCrypto } from "@sigstore/core";
import { type ObjectIdentifierValuePair, TrustedRoot } from "@sigstore/protobuf-specs";
import { type TrustMaterial, toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { parseDownloadBaseUrl } from "./download-url.js";
import {
	ACTIVE_RELEASE_SIGNER,
	buildExpectedSignerIdentity,
	FULCIO_OID_BUILD_SIGNER_URI,
	FULCIO_OID_RUNNER_ENVIRONMENT,
	FULCIO_OID_SOURCE_REPOSITORY_URI,
	type PinnedSignerIdentity,
	parseSignerIdentity,
	RELEASE_CHECKSUMS_ASSET,
	RELEASE_SIGNATURE_BUNDLE_ASSET,
} from "./release-trust.js";
import { SIGSTORE_TRUSTED_ROOT_JSON } from "./sigstore-trusted-root.js";

export { parseDownloadBaseUrl };

/**
 * A release could not be proven to come from Prime Intellect's release workflow. Every path that
 * throws this must leave the installed version untouched - verification failures are never
 * downgraded to warnings.
 */
export class ReleaseSignatureError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause instanceof Error ? { cause } : undefined);
		this.name = "ReleaseSignatureError";
	}
}

let cachedTrustMaterial: TrustMaterial | undefined;

function getTrustMaterial(trustedRootJson = SIGSTORE_TRUSTED_ROOT_JSON): TrustMaterial {
	if (trustedRootJson === SIGSTORE_TRUSTED_ROOT_JSON && cachedTrustMaterial) return cachedTrustMaterial;
	const material = toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(trustedRootJson)));
	if (trustedRootJson === SIGSTORE_TRUSTED_ROOT_JSON) cachedTrustMaterial = material;
	return material;
}

/**
 * Sigstore verification calls `crypto.verify` with NO digest for the signatures it checks itself
 * (the cosign signature, the Rekor inclusion promise, the DSSE envelope, the certificate-transparency
 * SCT). Node's OpenSSL then picks the key's default digest, which is SHA-256 for the EC and RSA keys
 * Sigstore uses. Bun links BoringSSL, which refuses that call with ERR_OSSL_NO_DEFAULT_DIGEST -
 * and `@sigstore/core` reports the resulting throw as "signature invalid". Inside the compiled
 * binary every update would therefore be refused, silently and permanently.
 *
 * So name the digest explicitly instead of relying on a runtime default. This is what Node already
 * computes, so behaviour is identical on both runtimes and the Node test suite exercises the same
 * path the shipped binary takes. Edwards keys legitimately take no digest and are left alone. Calls
 * that already name an algorithm (X.509 chain verification uses the certificate's own signature
 * algorithm) are passed through untouched.
 *
 * The patch targets `@sigstore/core`'s own exported function rather than `node:crypto`: patching
 * `node:crypto` works under Node and plain Bun but NOT inside `bun build --compile --format=esm`,
 * where the bundler turns the library's `require("crypto")` into immutable ESM import bindings.
 * It is installed and removed around a single synchronous call.
 */
function withExplicitVerificationDigest<T>(run: () => T): T {
	const target = sigstoreCrypto as { verify: typeof sigstoreCrypto.verify };
	const original = target.verify;
	target.verify = (data, key, signature, algorithm) => {
		if (algorithm !== undefined) return original(data, key, signature, algorithm);
		const keyType = (key as { asymmetricKeyType?: string }).asymmetricKeyType;
		const usesNoDigest = keyType === "ed25519" || keyType === "ed448";
		return original(data, key, signature, usesNoDigest ? undefined : "sha256");
	};
	try {
		return run();
	} finally {
		target.verify = original;
	}
}

/** Fulcio stores extension values >= .1.8 as a DER UTF8String; earlier ones are bare UTF-8. */
function decodeExtensionValue(value: Uint8Array): string {
	if (value.length >= 2 && value[0] === 0x0c) {
		let offset = 2;
		let length = value[1];
		if (length & 0x80) {
			const lengthBytes = length & 0x7f;
			length = 0;
			for (let index = 0; index < lengthBytes; index += 1) length = (length << 8) | value[2 + index];
			offset = 2 + lengthBytes;
		}
		if (offset + length === value.length)
			return Buffer.from(value.subarray(offset, offset + length)).toString("utf8");
	}
	return Buffer.from(value).toString("utf8");
}

function readOid(oids: ObjectIdentifierValuePair[] | undefined, id: string): string | undefined {
	const match = oids?.find((entry) => entry.oid?.id.join(".") === id);
	return match ? decodeExtensionValue(match.value) : undefined;
}

export interface VerifiedReleaseChecksums {
	/** file name -> lowercase hex sha256, taken only from the signature-verified document. */
	entries: Map<string, string>;
	/** The certificate SAN that was accepted, for logging and for the update UI. */
	signerIdentity: string;
	/** The git ref the release was signed from. */
	signerRef: string;
}

export interface VerifyReleaseChecksumsOptions {
	/**
	 * Identity to pin. Defaults to {@link ACTIVE_RELEASE_SIGNER}: the production release signer,
	 * or the signer a TEST-ONLY binary had compiled in with `--test-signer-json`. Overriding it here
	 * is an in-process test seam only - it is not reachable from the environment, a config file or
	 * the network.
	 */
	identity?: PinnedSignerIdentity;
	/** Alternate Sigstore trusted root, for tests. Defaults to the embedded public-good root. */
	trustedRootJson?: string;
}

/**
 * Verify a cosign bundle over `SHA256SUMS` and return the digests it authorises.
 *
 * Fails CLOSED. A missing bundle, an unparseable bundle, a bundle that does not chain to Sigstore's
 * roots, a bundle whose transparency-log entry does not check out, a bundle over different bytes,
 * or a bundle from any identity other than the pinned one all raise {@link ReleaseSignatureError}.
 */
export function verifyReleaseChecksums(
	checksums: Uint8Array,
	bundle: unknown,
	options: VerifyReleaseChecksumsOptions = {},
): VerifiedReleaseChecksums {
	const identity = options.identity ?? ACTIVE_RELEASE_SIGNER;
	if (bundle === undefined || bundle === null)
		throw new ReleaseSignatureError(`No ${RELEASE_SIGNATURE_BUNDLE_ASSET} signature was published for this release.`);

	let signer: ReturnType<Verifier["verify"]>;
	try {
		const verifier = new Verifier(getTrustMaterial(options.trustedRootJson), {
			tlogThreshold: 1,
			ctlogThreshold: 1,
			timestampThreshold: 1,
		});
		const entity = toSignedEntity(bundleFromJSON(bundle), Buffer.from(checksums));
		signer = withExplicitVerificationDigest(() => verifier.verify(entity));
	} catch (error) {
		throw new ReleaseSignatureError(
			`The ${RELEASE_CHECKSUMS_ASSET} signature could not be verified: ${
				error instanceof Error ? error.message : String(error)
			}`,
			error,
		);
	}

	const subjectAlternativeName = signer.identity?.subjectAlternativeName;
	if (!subjectAlternativeName) throw new ReleaseSignatureError("The release signature carries no signer identity.");
	const parsed = parseSignerIdentity(subjectAlternativeName);
	if (!parsed) throw new ReleaseSignatureError(`Unrecognised release signer identity: ${subjectAlternativeName}.`);

	const expectedWorkflowUri = `${identity.workflowRepositoryUri}/${identity.workflowPath}`;
	if (parsed.workflowUri !== expectedWorkflowUri || !identity.refPattern.test(parsed.ref))
		throw new ReleaseSignatureError(
			`The release was signed by ${subjectAlternativeName}, not by ${buildExpectedSignerIdentity(identity, "<allowed ref>")}.`,
		);

	const issuer = signer.identity?.extensions?.issuer;
	if (issuer !== identity.oidcIssuer)
		throw new ReleaseSignatureError(`The release signature was issued by ${issuer ?? "an unknown issuer"}.`);

	const oids = signer.identity?.oids;
	const repositoryUri = readOid(oids, FULCIO_OID_SOURCE_REPOSITORY_URI);
	if (repositoryUri !== identity.repositoryUri)
		throw new ReleaseSignatureError(
			`The release signature names source repository ${repositoryUri ?? "<none>"}, not ${identity.repositoryUri}.`,
		);

	const runnerEnvironment = readOid(oids, FULCIO_OID_RUNNER_ENVIRONMENT);
	if (runnerEnvironment !== identity.runnerEnvironment)
		throw new ReleaseSignatureError(
			`The release signature was produced on a ${runnerEnvironment ?? "<unknown>"} runner, not ${identity.runnerEnvironment}.`,
		);

	const buildSignerUri = readOid(oids, FULCIO_OID_BUILD_SIGNER_URI);
	if (buildSignerUri !== undefined && buildSignerUri !== subjectAlternativeName)
		throw new ReleaseSignatureError("The release signature's build signer URI disagrees with its subject.");

	return { entries: parseChecksums(checksums), signerIdentity: subjectAlternativeName, signerRef: parsed.ref };
}

/** Parse a `sha256sum` document. Any malformed or duplicated line invalidates the whole document. */
export function parseChecksums(checksums: Uint8Array): Map<string, string> {
	const entries = new Map<string, string>();
	for (const rawLine of Buffer.from(checksums).toString("utf8").split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (!line.trim()) continue;
		const match = /^([a-f0-9]{64}) [ *](\S.*)$/.exec(line);
		if (!match) throw new ReleaseSignatureError(`Malformed line in the signed ${RELEASE_CHECKSUMS_ASSET}.`);
		if (entries.has(match[2]))
			throw new ReleaseSignatureError(`Duplicate entry for ${match[2]} in the signed ${RELEASE_CHECKSUMS_ASSET}.`);
		entries.set(match[2], match[1]);
	}
	if (entries.size === 0) throw new ReleaseSignatureError(`The signed ${RELEASE_CHECKSUMS_ASSET} is empty.`);
	return entries;
}

export interface FetchVerifiedDigestOptions {
	/** Download origin. May be an override origin; verification is identical either way. */
	baseUrl: string;
	version: string;
	/** Archive file name, e.g. `prime-agent-1.2.3-darwin-arm64.tar.gz`. */
	file: string;
	timeoutMs?: number;
	userAgent?: string;
	/** Injected in tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	identity?: PinnedSignerIdentity;
	trustedRootJson?: string;
}

const DEFAULT_SIGNATURE_TIMEOUT_MS = 30000;

/**
 * Hard size caps for the two control files. A real `SHA256SUMS` is a few hundred bytes and a cosign
 * bundle a few kilobytes, so these are generous - but they are hard: a download origin (including
 * one supplied through PRIME_AGENT_DOWNLOAD_BASE_URL) must not be able to make the updater buffer an
 * unbounded body into memory before verification has even started.
 */
export const MAX_RELEASE_CHECKSUMS_BYTES = 1024 * 1024;
export const MAX_RELEASE_SIGNATURE_BUNDLE_BYTES = 4 * 1024 * 1024;

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Build the URL of a release asset under `baseUrl` with the URL API, never by string concatenation.
 * `baseUrl` is validated with {@link parseDownloadBaseUrl}; `version` and `asset` are restricted to
 * the shapes the release layout uses so neither can introduce path segments, queries or fragments.
 */
export function releaseAssetUrl(baseUrl: string, version: string, asset: string): string {
	if (!RELEASE_VERSION_PATTERN.test(version))
		throw new ReleaseSignatureError(
			`Refusing to build a release URL for invalid version ${JSON.stringify(version)}.`,
		);
	if (!RELEASE_ASSET_NAME_PATTERN.test(asset))
		throw new ReleaseSignatureError(
			`Refusing to build a release URL for invalid asset name ${JSON.stringify(asset)}.`,
		);
	let base: URL;
	try {
		base = new URL(parseDownloadBaseUrl(baseUrl));
	} catch (error) {
		throw new ReleaseSignatureError(error instanceof Error ? error.message : String(error), error);
	}
	base.pathname = `${base.pathname.replace(/\/+$/, "")}/releases/v${version}/${asset}`;
	return base.href;
}

/**
 * Download a control file of at most `maxBytes`.
 *
 * The cap is enforced twice: a declared `Content-Length` above it is refused before a single body
 * byte is read, and the body is then streamed with a running count so a chunked or lying response
 * is cut off the moment it exceeds the cap. The body is never buffered whole before the check.
 */
async function download(
	url: string,
	options: { timeoutMs: number; userAgent?: string; fetchImpl: typeof fetch; maxBytes: number },
): Promise<Uint8Array> {
	let response: Response;
	try {
		response = await options.fetchImpl(url, {
			headers: options.userAgent ? { "User-Agent": options.userAgent } : {},
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (error) {
		throw new ReleaseSignatureError(`Could not download ${url}.`, error);
	}
	if (!response.ok) throw new ReleaseSignatureError(`Could not download ${url} (HTTP ${response.status}).`);
	const tooLarge = () =>
		new ReleaseSignatureError(`Refusing to download ${url}: the response exceeds ${options.maxBytes} bytes.`);
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		if (!/^\d+$/.test(declaredLength.trim()))
			throw new ReleaseSignatureError(`Could not download ${url}: malformed Content-Length header.`);
		if (Number(declaredLength.trim()) > options.maxBytes) throw tooLarge();
	}
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			received += value.byteLength;
			if (received > options.maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw tooLarge();
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof ReleaseSignatureError) throw error;
		throw new ReleaseSignatureError(`Could not download ${url}.`, error);
	}
	return Buffer.concat(chunks, received);
}

/**
 * Download `SHA256SUMS` and its cosign bundle for `version`, verify the signature against the pinned
 * identity, and return the digest the signed document records for `file`.
 *
 * This is the only place the updater is allowed to learn an artifact digest. The release manifest
 * (`latest.json`) is same-origin with the artifact and is therefore treated as a hint, never as a
 * source of truth.
 */
export async function fetchVerifiedReleaseArtifactDigest(
	options: FetchVerifiedDigestOptions,
): Promise<{ digest: string; signerIdentity: string; signerRef: string }> {
	const download_ = {
		timeoutMs: options.timeoutMs ?? DEFAULT_SIGNATURE_TIMEOUT_MS,
		userAgent: options.userAgent,
		fetchImpl: options.fetchImpl ?? fetch,
	};
	const checksums = await download(releaseAssetUrl(options.baseUrl, options.version, RELEASE_CHECKSUMS_ASSET), {
		...download_,
		maxBytes: MAX_RELEASE_CHECKSUMS_BYTES,
	});
	const bundleBytes = await download(
		releaseAssetUrl(options.baseUrl, options.version, RELEASE_SIGNATURE_BUNDLE_ASSET),
		{ ...download_, maxBytes: MAX_RELEASE_SIGNATURE_BUNDLE_BYTES },
	);

	let bundle: unknown;
	try {
		bundle = JSON.parse(Buffer.from(bundleBytes).toString("utf8"));
	} catch (error) {
		throw new ReleaseSignatureError(`${RELEASE_SIGNATURE_BUNDLE_ASSET} is not valid JSON.`, error);
	}

	const verified = verifyReleaseChecksums(checksums, bundle, {
		identity: options.identity,
		trustedRootJson: options.trustedRootJson,
	});
	const digest = verified.entries.get(options.file);
	if (!digest)
		throw new ReleaseSignatureError(
			`The signed ${RELEASE_CHECKSUMS_ASSET} for ${options.version} does not cover ${options.file}.`,
		);
	return { digest, signerIdentity: verified.signerIdentity, signerRef: verified.signerRef };
}
