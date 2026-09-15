import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crypto as sigstoreCrypto } from "@sigstore/core";
import { describe, expect, test } from "vitest";
import {
	fetchVerifiedReleaseArtifactDigest,
	MAX_RELEASE_CHECKSUMS_BYTES,
	MAX_RELEASE_SIGNATURE_BUNDLE_BYTES,
	parseChecksums,
	ReleaseSignatureError,
	verifyReleaseChecksums,
} from "../src/utils/release-signature.js";
import {
	ACTIVE_RELEASE_SIGNER,
	buildExpectedSignerIdentity,
	PINNED_RELEASE_SIGNER,
	type PinnedSignerIdentity,
	parseSignerOverride,
	RELEASE_SIGNER_OIDC_ISSUER,
	RELEASE_SIGNER_TEST_OVERRIDE,
} from "../src/utils/release-trust.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "release-signature");

const checksums = readFileSync(join(fixtures, "SHA256SUMS"));
const bundle = JSON.parse(readFileSync(join(fixtures, "SHA256SUMS.sigstore.json"), "utf8"));
const bundleWithoutTsa = JSON.parse(readFileSync(join(fixtures, "SHA256SUMS.no-tsa.sigstore.json"), "utf8"));

/**
 * The fixture's real signer. Pinning to it proves the whole offline chain verifies; pinning to
 * {@link PINNED_RELEASE_SIGNER} instead proves a valid signature from the wrong project is refused.
 * The fixture was signed through a reusable workflow, so its subject repository (`charmbracelet/meta`)
 * and its source repository (`charmbracelet/crush`) differ - which is exactly why the two are
 * pinned separately.
 */
const FIXTURE_SIGNER: PinnedSignerIdentity = {
	repositoryUri: "https://github.com/charmbracelet/crush",
	workflowRepositoryUri: "https://github.com/charmbracelet/meta",
	workflowPath: ".github/workflows/goreleaser.yml",
	oidcIssuer: RELEASE_SIGNER_OIDC_ISSUER,
	runnerEnvironment: "github-hosted",
	refPattern: /^refs\/heads\/main$/,
};

function fixturePolicy(overrides: Partial<PinnedSignerIdentity> = {}): PinnedSignerIdentity {
	return { ...FIXTURE_SIGNER, ...overrides };
}

const ARTIFACT = "crush_0.94.2_Linux_x86_64.tar.gz";

describe("verifyReleaseChecksums", () => {
	test("accepts a valid bundle and returns only signature-covered digests", () => {
		const verified = verifyReleaseChecksums(checksums, bundle, { identity: fixturePolicy() });

		expect(verified.signerIdentity).toBe(buildExpectedSignerIdentity(FIXTURE_SIGNER, "refs/heads/main"));
		expect(verified.signerRef).toBe("refs/heads/main");
		expect(verified.entries.get(ARTIFACT)).toMatch(/^[a-f0-9]{64}$/);
	});

	test("accepts the bundle shape our release lane emits (no timestamp authority)", () => {
		const verified = verifyReleaseChecksums(checksums, bundleWithoutTsa, { identity: fixturePolicy() });

		expect(verified.signerRef).toBe("refs/heads/main");
	});

	test("rejects a tampered checksum document", () => {
		const tampered = Buffer.from(checksums.toString("utf8").replace(/^[a-f0-9]{64}/m, "0".repeat(64)), "utf8");

		expect(() => verifyReleaseChecksums(tampered, bundle, { identity: fixturePolicy() })).toThrow(
			ReleaseSignatureError,
		);
	});

	test("rejects extra bytes appended to the signed document", () => {
		const appended = Buffer.concat([checksums, Buffer.from("\n")]);

		expect(() => verifyReleaseChecksums(appended, bundle, { identity: fixturePolicy() })).toThrow(
			/signature could not be verified/,
		);
	});

	test("rejects a missing bundle", () => {
		expect(() => verifyReleaseChecksums(checksums, undefined, { identity: fixturePolicy() })).toThrow(
			/No SHA256SUMS.sigstore.json signature was published/,
		);
	});

	test("rejects a structurally broken bundle", () => {
		expect(() => verifyReleaseChecksums(checksums, { mediaType: "nonsense" }, { identity: fixturePolicy() })).toThrow(
			ReleaseSignatureError,
		);
	});

	test("rejects a bundle whose transparency-log entry was stripped", () => {
		const stripped = structuredClone(bundle);
		stripped.verificationMaterial.tlogEntries = [];

		expect(() => verifyReleaseChecksums(checksums, stripped, { identity: fixturePolicy() })).toThrow(
			ReleaseSignatureError,
		);
	});

	test("rejects a cryptographically valid signature from the wrong signer", () => {
		expect(() => verifyReleaseChecksums(checksums, bundle)).toThrow(`not by ${PINNED_RELEASE_SIGNER.repositoryUri}`);
	});

	test("rejects the right workflow on a ref outside the allowed pattern", () => {
		expect(() =>
			verifyReleaseChecksums(checksums, bundle, {
				identity: fixturePolicy({ refPattern: /^refs\/tags\/v\d+\.\d+\.\d+$/ }),
			}),
		).toThrow(/not by /);
	});

	test("rejects the right repository signed by the wrong workflow file", () => {
		expect(() =>
			verifyReleaseChecksums(checksums, bundle, {
				identity: fixturePolicy({ workflowPath: ".github/workflows/build-binaries.yml" }),
			}),
		).toThrow(/not by /);
	});

	test("rejects a signature from an unexpected OIDC issuer", () => {
		expect(() =>
			verifyReleaseChecksums(checksums, bundle, {
				identity: fixturePolicy({ oidcIssuer: "https://accounts.google.com" }),
			}),
		).toThrow(/issued by /);
	});

	test("rejects a signature produced on a self-hosted runner", () => {
		expect(() =>
			verifyReleaseChecksums(checksums, bundle, {
				identity: fixturePolicy({ runnerEnvironment: "self-hosted" }),
			}),
		).toThrow(/runner/);
	});

	test("rejects a source repository that is not the pinned one", () => {
		expect(() =>
			verifyReleaseChecksums(checksums, bundle, {
				identity: fixturePolicy({ repositoryUri: "https://github.com/charmbracelet/meta" }),
			}),
		).toThrow(/source repository/);
	});
});

describe("parseChecksums", () => {
	test("rejects a malformed line rather than skipping it", () => {
		expect(() => parseChecksums(Buffer.from(`${"a".repeat(64)}  ok.tar.gz\ngarbage\n`, "utf8"))).toThrow(
			/Malformed line/,
		);
	});

	test("rejects duplicate file names", () => {
		const duplicated = `${"a".repeat(64)}  x.tar.gz\n${"b".repeat(64)}  x.tar.gz\n`;

		expect(() => parseChecksums(Buffer.from(duplicated, "utf8"))).toThrow(/Duplicate entry/);
	});

	test("rejects an empty document", () => {
		expect(() => parseChecksums(Buffer.from("\n\n", "utf8"))).toThrow(/is empty/);
	});
});

describe("fetchVerifiedReleaseArtifactDigest", () => {
	function stubFetch(responses: Record<string, Uint8Array | number>): {
		fetchImpl: typeof fetch;
		requested: string[];
	} {
		const requested: string[] = [];
		const fetchImpl = (async (input: string | URL) => {
			const url = String(input);
			requested.push(url);
			const body = responses[url];
			if (body === undefined) return new Response(null, { status: 404 });
			if (typeof body === "number") return new Response(null, { status: body });
			return new Response(Buffer.from(body), { status: 200 });
		}) as unknown as typeof fetch;
		return { fetchImpl, requested };
	}

	const OTHER_ORIGIN = "https://downloads.example.dev";
	const base = `${OTHER_ORIGIN}/releases/v0.94.2`;

	test("verifies against the pinned identity even on an overridden origin", async () => {
		const { fetchImpl, requested } = stubFetch({
			[`${base}/SHA256SUMS`]: checksums,
			[`${base}/SHA256SUMS.sigstore.json`]: Buffer.from(JSON.stringify(bundle), "utf8"),
		});

		const result = await fetchVerifiedReleaseArtifactDigest({
			baseUrl: OTHER_ORIGIN,
			version: "0.94.2",
			file: ARTIFACT,
			fetchImpl,
			identity: fixturePolicy(),
		});

		expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(requested).toEqual([`${base}/SHA256SUMS`, `${base}/SHA256SUMS.sigstore.json`]);
	});

	test("an overridden origin cannot skip verification by omitting the bundle", async () => {
		const { fetchImpl } = stubFetch({ [`${base}/SHA256SUMS`]: checksums });

		await expect(
			fetchVerifiedReleaseArtifactDigest({
				baseUrl: OTHER_ORIGIN,
				version: "0.94.2",
				file: ARTIFACT,
				fetchImpl,
				identity: fixturePolicy(),
			}),
		).rejects.toThrow(/Could not download .*SHA256SUMS.sigstore.json \(HTTP 404\)/);
	});

	test("an overridden origin cannot substitute its own identity", async () => {
		const { fetchImpl } = stubFetch({
			[`${base}/SHA256SUMS`]: checksums,
			[`${base}/SHA256SUMS.sigstore.json`]: Buffer.from(JSON.stringify(bundle), "utf8"),
		});

		await expect(
			fetchVerifiedReleaseArtifactDigest({
				baseUrl: OTHER_ORIGIN,
				version: "0.94.2",
				file: ARTIFACT,
				fetchImpl,
			}),
		).rejects.toThrow(ReleaseSignatureError);
	});

	test("rejects a bundle that is not JSON", async () => {
		const { fetchImpl } = stubFetch({
			[`${base}/SHA256SUMS`]: checksums,
			[`${base}/SHA256SUMS.sigstore.json`]: Buffer.from("<html>nope</html>", "utf8"),
		});

		await expect(
			fetchVerifiedReleaseArtifactDigest({
				baseUrl: OTHER_ORIGIN,
				version: "0.94.2",
				file: ARTIFACT,
				fetchImpl,
				identity: fixturePolicy(),
			}),
		).rejects.toThrow(/not valid JSON/);
	});

	test("rejects an artifact the signed document does not cover", async () => {
		const { fetchImpl } = stubFetch({
			[`${base}/SHA256SUMS`]: checksums,
			[`${base}/SHA256SUMS.sigstore.json`]: Buffer.from(JSON.stringify(bundle), "utf8"),
		});

		await expect(
			fetchVerifiedReleaseArtifactDigest({
				baseUrl: OTHER_ORIGIN,
				version: "0.94.2",
				file: "prime-agent-0.94.2-darwin-arm64.tar.gz",
				fetchImpl,
				identity: fixturePolicy(),
			}),
		).rejects.toThrow(/does not cover/);
	});
});

describe("control file size caps", () => {
	const OTHER_ORIGIN = "https://downloads.example.dev";
	const base = `${OTHER_ORIGIN}/releases/v0.94.2`;
	const bundleBytes = Buffer.from(JSON.stringify(bundle), "utf8");

	/** A body that keeps producing chunks until it is cancelled, recording how far it got. */
	function endlessBody(chunkSize: number) {
		const state = { pulled: 0, cancelled: false };
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				state.pulled += 1;
				controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
			},
			cancel() {
				state.cancelled = true;
			},
		});
		return { stream, state };
	}

	function fetchWith(responses: Record<string, () => Response>): { fetchImpl: typeof fetch; requested: string[] } {
		const requested: string[] = [];
		const fetchImpl = (async (input: string | URL) => {
			const url = String(input);
			requested.push(url);
			const respond = responses[url];
			return respond ? respond() : new Response(null, { status: 404 });
		}) as unknown as typeof fetch;
		return { fetchImpl, requested };
	}

	const verify = (fetchImpl: typeof fetch) =>
		fetchVerifiedReleaseArtifactDigest({
			baseUrl: OTHER_ORIGIN,
			version: "0.94.2",
			file: ARTIFACT,
			fetchImpl,
			identity: fixturePolicy(),
		});

	test("the caps are generous for real control files but finite", () => {
		expect(checksums.byteLength).toBeLessThan(MAX_RELEASE_CHECKSUMS_BYTES);
		expect(bundleBytes.byteLength).toBeLessThan(MAX_RELEASE_SIGNATURE_BUNDLE_BYTES);
		expect(MAX_RELEASE_CHECKSUMS_BYTES).toBe(1024 * 1024);
		expect(MAX_RELEASE_SIGNATURE_BUNDLE_BYTES).toBe(4 * 1024 * 1024);
	});

	test("normal sizes pass, including bodies delivered in many small chunks", async () => {
		const chunked = (bytes: Buffer) =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (let offset = 0; offset < bytes.length; offset += 7)
							controller.enqueue(bytes.subarray(offset, offset + 7));
						controller.close();
					},
				}),
				{ status: 200 },
			);
		const { fetchImpl } = fetchWith({
			[`${base}/SHA256SUMS`]: () => chunked(checksums),
			[`${base}/SHA256SUMS.sigstore.json`]: () => chunked(bundleBytes),
		});

		const result = await verify(fetchImpl);

		expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	test("refuses a SHA256SUMS whose declared Content-Length exceeds the cap without reading the body", async () => {
		const { stream, state } = endlessBody(1024);
		const { fetchImpl } = fetchWith({
			[`${base}/SHA256SUMS`]: () =>
				new Response(stream, {
					status: 200,
					headers: { "content-length": String(MAX_RELEASE_CHECKSUMS_BYTES + 1) },
				}),
		});

		await expect(verify(fetchImpl)).rejects.toThrow(/exceeds 1048576 bytes/);
		await expect(verify(fetchImpl)).rejects.toThrow(ReleaseSignatureError);
		// A ReadableStream primes one chunk on construction; the updater itself pulled nothing.
		expect(state.pulled).toBeLessThanOrEqual(1);
	});

	test("refuses a bundle whose declared Content-Length exceeds the cap", async () => {
		const { fetchImpl } = fetchWith({
			[`${base}/SHA256SUMS`]: () => new Response(checksums, { status: 200 }),
			[`${base}/SHA256SUMS.sigstore.json`]: () =>
				new Response(bundleBytes, {
					status: 200,
					headers: { "content-length": String(MAX_RELEASE_SIGNATURE_BUNDLE_BYTES + 1) },
				}),
		});

		await expect(verify(fetchImpl)).rejects.toThrow(/exceeds 4194304 bytes/);
	});

	test("a Content-Length exactly at the cap is accepted", async () => {
		const { fetchImpl } = fetchWith({
			[`${base}/SHA256SUMS`]: () =>
				new Response(checksums, {
					status: 200,
					headers: { "content-length": String(MAX_RELEASE_CHECKSUMS_BYTES) },
				}),
			[`${base}/SHA256SUMS.sigstore.json`]: () => new Response(bundleBytes, { status: 200 }),
		});

		await expect(verify(fetchImpl)).resolves.toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
	});

	test("refuses a malformed Content-Length instead of guessing", async () => {
		const { fetchImpl } = fetchWith({
			[`${base}/SHA256SUMS`]: () => new Response(checksums, { status: 200, headers: { "content-length": "lots" } }),
		});

		await expect(verify(fetchImpl)).rejects.toThrow(/malformed Content-Length/);
	});

	test("aborts a chunked SHA256SUMS body the moment it passes the cap", async () => {
		const chunk = 64 * 1024;
		const { stream, state } = endlessBody(chunk);
		const { fetchImpl } = fetchWith({ [`${base}/SHA256SUMS`]: () => new Response(stream, { status: 200 }) });

		await expect(verify(fetchImpl)).rejects.toThrow(/exceeds 1048576 bytes/);
		// One chunk past the cap and not a byte more; the body was cancelled, never buffered whole.
		expect(state.pulled).toBeLessThanOrEqual(MAX_RELEASE_CHECKSUMS_BYTES / chunk + 2);
		expect(state.cancelled).toBe(true);
	});

	test("aborts a chunked bundle body the moment it passes the cap", async () => {
		const chunk = 256 * 1024;
		const { stream, state } = endlessBody(chunk);
		const { fetchImpl, requested } = fetchWith({
			[`${base}/SHA256SUMS`]: () => new Response(checksums, { status: 200 }),
			[`${base}/SHA256SUMS.sigstore.json`]: () => new Response(stream, { status: 200 }),
		});

		await expect(verify(fetchImpl)).rejects.toThrow(/exceeds 4194304 bytes/);
		expect(state.pulled).toBeLessThanOrEqual(MAX_RELEASE_SIGNATURE_BUNDLE_BYTES / chunk + 2);
		expect(state.cancelled).toBe(true);
		expect(requested).toHaveLength(2);
	});

	test("a lying Content-Length below the cap does not let an oversized body through", async () => {
		const { stream, state } = endlessBody(128 * 1024);
		const { fetchImpl } = fetchWith({
			[`${base}/SHA256SUMS`]: () => new Response(stream, { status: 200, headers: { "content-length": "100" } }),
		});

		await expect(verify(fetchImpl)).rejects.toThrow(/exceeds 1048576 bytes/);
		expect(state.cancelled).toBe(true);
	});
});

describe("compiled signer override document", () => {
	const VALID = {
		repositoryUri: "https://github.com/example/prime-agent",
		workflowRepositoryUri: "https://github.com/example/prime-agent",
		workflowPath: ".github/workflows/standalone-binaries.yml",
		oidcIssuer: "https://token.actions.githubusercontent.com",
		runnerEnvironment: "github-hosted",
		refPattern: "^refs/pull/\\d+/merge$",
	};

	test("under Node no override is compiled in and the production signer is active", () => {
		expect(RELEASE_SIGNER_TEST_OVERRIDE).toBeUndefined();
		expect(ACTIVE_RELEASE_SIGNER).toBe(PINNED_RELEASE_SIGNER);
	});

	test("parses a complete document and compiles its ref pattern", () => {
		const parsed = parseSignerOverride(JSON.stringify(VALID));

		expect(parsed).toMatchObject({ ...VALID, refPattern: expect.any(RegExp) });
		expect(parsed.refPattern.source).toBe(new RegExp(VALID.refPattern).source);
		expect(parsed.refPattern.test("refs/pull/12/merge")).toBe(true);
		expect(parsed.refPattern.test("refs/heads/main")).toBe(false);
	});

	test.each([
		["not JSON", "nope", /not valid JSON/],
		["an array", "[]", /JSON object/],
		["a missing field", JSON.stringify({ ...VALID, oidcIssuer: undefined }), /oidcIssuer must be a non-empty string/],
		["an empty field", JSON.stringify({ ...VALID, workflowPath: "" }), /workflowPath must be a non-empty string/],
		["a non-string field", JSON.stringify({ ...VALID, refPattern: 7 }), /refPattern must be a non-empty string/],
		["an unknown field", JSON.stringify({ ...VALID, extra: "x" }), /unknown field "extra"/],
		["an http repository", JSON.stringify({ ...VALID, repositoryUri: "http://github.com/x/y" }), /bare https URL/],
		["a non-URL issuer", JSON.stringify({ ...VALID, oidcIssuer: "token.actions" }), /not a valid URL/],
		[
			"credentials in a URL",
			JSON.stringify({ ...VALID, workflowRepositoryUri: "https://a:b@github.com/x/y" }),
			/bare https URL/,
		],
		[
			"a workflow path without .yml",
			JSON.stringify({ ...VALID, workflowPath: ".github/workflows/x" }),
			/workflowPath/,
		],
		["an absolute workflow path", JSON.stringify({ ...VALID, workflowPath: "/w/x.yml" }), /workflowPath/],
		[
			"an unknown runner environment",
			JSON.stringify({ ...VALID, runnerEnvironment: "anywhere" }),
			/runnerEnvironment/,
		],
		["an unanchored ref pattern", JSON.stringify({ ...VALID, refPattern: "refs/heads/main" }), /anchored/],
		["a non-compiling ref pattern", JSON.stringify({ ...VALID, refPattern: "^refs/(heads$" }), /does not compile/],
	])("refuses %s", (_label, json, message) => {
		expect(() => parseSignerOverride(json)).toThrow(message);
	});
});

describe("Bun/BoringSSL compatibility", () => {
	/**
	 * Bun links BoringSSL, which raises ERR_OSSL_NO_DEFAULT_DIGEST for a `crypto.verify` call that
	 * names no digest, where Node's OpenSSL defaults to SHA-256. `@sigstore/core` reports that throw
	 * as "signature invalid", so without naming the digest the compiled binary would refuse every
	 * update. Simulate BoringSSL on Node so the regression is caught by ordinary CI.
	 */
	test("verifies on a runtime that refuses a default digest, and restores crypto.verify", () => {
		const target = nodeCrypto as unknown as { verify: typeof nodeCrypto.verify };
		const real = target.verify;
		const boringSsl = ((algorithm: unknown, ...rest: unknown[]) => {
			if (algorithm === undefined || algorithm === null) {
				const error = new Error("no default digest") as NodeJS.ErrnoException;
				error.code = "ERR_OSSL_NO_DEFAULT_DIGEST";
				throw error;
			}
			return (real as unknown as (...args: unknown[]) => unknown)(algorithm, ...rest);
		}) as typeof nodeCrypto.verify;
		target.verify = boringSsl;
		try {
			const verified = verifyReleaseChecksums(checksums, bundle, { identity: fixturePolicy() });

			expect(verified.signerRef).toBe("refs/heads/main");
		} finally {
			target.verify = real;
		}
	});

	test("leaves @sigstore/core untouched once verification returns", () => {
		const before = sigstoreCrypto.verify;

		expect(() => verifyReleaseChecksums(checksums, { mediaType: "nonsense" })).toThrow(ReleaseSignatureError);
		verifyReleaseChecksums(checksums, bundle, { identity: fixturePolicy() });

		expect(sigstoreCrypto.verify).toBe(before);
	});
});
