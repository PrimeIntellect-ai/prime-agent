import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeUpdatePlan } from "../src/cli/native-update.js";
import { NATIVE_RELEASE_ASSETS } from "../src/utils/native-installation.js";
import {
	parseChecksums,
	parseDownloadBaseUrl,
	ReleaseSignatureError,
	releaseAssetUrl,
} from "../src/utils/release-signature.js";
import { PINNED_RELEASE_SIGNER, RELEASE_SIGNER_TEST_OVERRIDE_MARKER } from "../src/utils/release-trust.js";

/**
 * End-to-end fail-closed behaviour with NOTHING stubbed except the network.
 *
 * The updater runs its real, production-pinned verifier here. The fixtures are a genuine Sigstore
 * bundle from another project, so the bytes and the signature agree perfectly and only the identity
 * is wrong - which is exactly the shape of an attacker who owns the download origin and can also
 * produce their own valid Sigstore signature.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "release-signature");
const foreignChecksums = readFileSync(join(fixtures, "SHA256SUMS"), "utf8");
const foreignBundle = readFileSync(join(fixtures, "SHA256SUMS.sigstore.json"), "utf8");

const PLATFORM = "linux-x64";
const VERSION = "1.2.4";
const FILE = `prime-agent-${VERSION}-${PLATFORM}.tar.gz`;
const DIGEST = "b".repeat(64);
const baseUrl = "https://releases.example";

describe("self-update signature enforcement", () => {
	let root: string;
	let executable: string;
	let target: string;

	beforeEach(() => {
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", baseUrl);
		root = realpathSync(mkdtempSync(join(tmpdir(), "prime-native-signature-")));
		const checksum = "a".repeat(64);
		const releaseName = `1.2.3-${PLATFORM}-${checksum}`;
		const releaseDir = join(root, "releases", releaseName);
		mkdirSync(releaseDir, { recursive: true });
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, ".managed"), "prime-agent-native-v1\n");
		for (const asset of NATIVE_RELEASE_ASSETS) {
			mkdirSync(dirname(join(releaseDir, asset)), { recursive: true });
			writeFileSync(join(releaseDir, asset), "fixture\n");
		}
		writeFileSync(join(releaseDir, ".archive-sha256"), checksum);
		writeFileSync(join(releaseDir, ".install-source"), baseUrl);
		writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
		executable = join(releaseDir, "prime-agent");
		writeFileSync(executable, "fixture executable");
		target = `../releases/${releaseName}/prime-agent`;
		symlinkSync(target, join(root, "bin", "prime-agent"));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function serve(assets: Record<string, string>): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				if (url.endsWith("/latest.json"))
					return Response.json({
						version: VERSION,
						binaries: [{ platform: PLATFORM, file: FILE, sha256: DIGEST }],
					});
				const body = assets[url];
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}),
		);
	}

	const signatureUrl = `${baseUrl}/releases/v${VERSION}/SHA256SUMS.sigstore.json`;
	const checksumsUrl = `${baseUrl}/releases/v${VERSION}/SHA256SUMS`;
	const signedForThisRelease = `${DIGEST}  ${FILE}\n`;

	it("refuses an update when no signature bundle is published", async () => {
		serve({ [checksumsUrl]: signedForThisRelease });

		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
			ReleaseSignatureError,
		);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	it("refuses an update when the signature comes from another project's release workflow", async () => {
		serve({ [checksumsUrl]: foreignChecksums, [signatureUrl]: foreignBundle });

		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
			/not by https:\/\/github\.com\/PrimeIntellect-ai\/prime-agent/,
		);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	it("refuses an update when a valid signature covers different bytes", async () => {
		// The signature is real and its identity check would run, but it does not cover this
		// document, so verification fails before the identity is even considered.
		serve({ [checksumsUrl]: signedForThisRelease, [signatureUrl]: foreignBundle });

		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
			/signature could not be verified/,
		);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	it("refuses an update when the bundle is not a Sigstore bundle at all", async () => {
		serve({ [checksumsUrl]: signedForThisRelease, [signatureUrl]: JSON.stringify({ hello: "world" }) });

		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
			ReleaseSignatureError,
		);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	it("fetches the manifest, checksums and bundle from URL-API-built paths under the origin", async () => {
		// An origin with a path and stray trailing slashes must still produce exactly one `/` per join.
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "https://mirror.example/prime//");
		serve({
			[`https://mirror.example/prime/releases/v${VERSION}/SHA256SUMS`]: signedForThisRelease,
			[`https://mirror.example/prime/releases/v${VERSION}/SHA256SUMS.sigstore.json`]: foreignBundle,
		});

		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
			/signature could not be verified/,
		);
		const requested = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
		expect(requested).toEqual([
			"https://mirror.example/prime/latest.json",
			`https://mirror.example/prime/releases/v${VERSION}/SHA256SUMS`,
			`https://mirror.example/prime/releases/v${VERSION}/SHA256SUMS.sigstore.json`,
		]);
	});

	it("an overridden origin gets no relaxation: the same signature is still demanded", async () => {
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "https://mirror.example");
		serve({
			[`https://mirror.example/releases/v${VERSION}/SHA256SUMS`]: foreignChecksums,
			[`https://mirror.example/releases/v${VERSION}/SHA256SUMS.sigstore.json`]: foreignBundle,
		});

		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
			/not by https:\/\/github\.com\/PrimeIntellect-ai\/prime-agent/,
		);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});
});

/**
 * The compile-time test signer override, exercised the way the CI binary uses it: the identifier
 * `__PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__` is a `bun build --define` substitution, so under Node
 * the only way to stand in for the bundler is to declare the global before the module graph is
 * loaded. Each case therefore resets the module registry and imports the updater fresh.
 */
describe("compile-time signer override", () => {
	const OVERRIDE_IDENTIFIER = "__PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__";
	/** The foreign fixture's real signer, as the JSON document `--test-signer-json` takes. */
	const fixtureSignerJson = JSON.stringify({
		repositoryUri: "https://github.com/charmbracelet/crush",
		workflowRepositoryUri: "https://github.com/charmbracelet/meta",
		workflowPath: ".github/workflows/goreleaser.yml",
		oidcIssuer: "https://token.actions.githubusercontent.com",
		runnerEnvironment: "github-hosted",
		refPattern: "^refs/heads/main$",
	});
	const FIXTURE_IDENTITY = "https://github.com/charmbracelet/meta/.github/workflows/goreleaser.yml@refs/heads/main";
	const FIXTURE_ARTIFACT = "crush_0.94.2_Linux_x86_64.tar.gz";
	const fixtureDigest = parseChecksums(Buffer.from(foreignChecksums, "utf8")).get(FIXTURE_ARTIFACT)!;

	let root: string;
	let executable: string;

	async function loadWithOverride(value: string | null) {
		vi.stubGlobal(OVERRIDE_IDENTIFIER, value);
		vi.resetModules();
		const trust = await import("../src/utils/release-trust.js");
		const signature = await import("../src/utils/release-signature.js");
		return { trust, signature };
	}

	/**
	 * Load the updater with `fetchVerifiedReleaseArtifactDigest` stubbed to succeed, so the plan and
	 * its user-facing lines can be inspected. The verifier itself is covered by the cases above that
	 * run the real one against the foreign fixture.
	 */
	async function loadUpdaterWithOverride(value: string | null) {
		vi.stubGlobal(OVERRIDE_IDENTIFIER, value);
		vi.resetModules();
		vi.doMock("../src/utils/release-signature.js", async (importOriginal) => ({
			...(await importOriginal<typeof import("../src/utils/release-signature.js")>()),
			fetchVerifiedReleaseArtifactDigest: async () => ({
				digest: DIGEST,
				signerIdentity: FIXTURE_IDENTITY,
				signerRef: "refs/heads/main",
			}),
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ version: VERSION, binaries: [{ platform: PLATFORM, file: FILE, sha256: DIGEST }] }),
			),
		);
		return await import("../src/cli/native-update.js");
	}

	function foreignReleaseFetch(withBundle = true): typeof fetch {
		return (async (input: string | URL) => {
			const url = String(input);
			if (url === `${baseUrl}/releases/v0.94.2/SHA256SUMS`) return new Response(foreignChecksums, { status: 200 });
			if (url === `${baseUrl}/releases/v0.94.2/SHA256SUMS.sigstore.json` && withBundle)
				return new Response(foreignBundle, { status: 200 });
			return new Response(null, { status: 404 });
		}) as unknown as typeof fetch;
	}

	beforeEach(() => {
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", baseUrl);
		root = realpathSync(mkdtempSync(join(tmpdir(), "prime-native-override-")));
		const checksum = "a".repeat(64);
		const releaseName = `1.2.3-${PLATFORM}-${checksum}`;
		const releaseDir = join(root, "releases", releaseName);
		mkdirSync(releaseDir, { recursive: true });
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, ".managed"), "prime-agent-native-v1\n");
		for (const asset of NATIVE_RELEASE_ASSETS) {
			mkdirSync(dirname(join(releaseDir, asset)), { recursive: true });
			writeFileSync(join(releaseDir, asset), "fixture\n");
		}
		writeFileSync(join(releaseDir, ".archive-sha256"), checksum);
		writeFileSync(join(releaseDir, ".install-source"), baseUrl);
		writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
		executable = join(releaseDir, "prime-agent");
		writeFileSync(executable, "fixture executable");
		symlinkSync(`../releases/${releaseName}/prime-agent`, join(root, "bin", "prime-agent"));
	});

	afterEach(() => {
		vi.doUnmock("../src/utils/release-signature.js");
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.resetModules();
		rmSync(root, { recursive: true, force: true });
	});

	it("with the identifier defined as null the production signer is pinned and the foreign release is refused", async () => {
		const { trust, signature } = await loadWithOverride(null);

		expect(trust.RELEASE_SIGNER_TEST_OVERRIDE).toBeUndefined();
		expect(trust.ACTIVE_RELEASE_SIGNER).toEqual(PINNED_RELEASE_SIGNER);
		expect(trust.ACTIVE_RELEASE_SIGNER.repositoryUri).toBe("https://github.com/PrimeIntellect-ai/prime-agent");
		await expect(
			signature.fetchVerifiedReleaseArtifactDigest({
				baseUrl,
				version: "0.94.2",
				file: FIXTURE_ARTIFACT,
				fetchImpl: foreignReleaseFetch(),
			}),
		).rejects.toThrow(/not by https:\/\/github\.com\/PrimeIntellect-ai\/prime-agent/);
	});

	it("with the identifier defined as null the update output carries no marker", async () => {
		const update = await loadUpdaterWithOverride(null);

		const plan = await update.getNativeUpdatePlan({ force: true, rollback: false, executable });

		expect(plan.testSignerOverride).toBeUndefined();
		const { notes, warnings } = update.describeNativeUpdatePlan(plan);
		expect(notes).toHaveLength(1);
		expect([...notes, ...warnings].join("\n")).not.toContain(RELEASE_SIGNER_TEST_OVERRIDE_MARKER);
	});

	it("a valid override is used by the real verifier instead of the production signer", async () => {
		const { trust, signature } = await loadWithOverride(fixtureSignerJson);

		expect(trust.RELEASE_SIGNER_TEST_OVERRIDE?.repositoryUri).toBe("https://github.com/charmbracelet/crush");
		expect(trust.ACTIVE_RELEASE_SIGNER).toBe(trust.RELEASE_SIGNER_TEST_OVERRIDE);
		// The constant itself is untouched: the override sits beside it, never inside it.
		expect(trust.PINNED_RELEASE_SIGNER).toEqual(PINNED_RELEASE_SIGNER);

		const verified = await signature.fetchVerifiedReleaseArtifactDigest({
			baseUrl,
			version: "0.94.2",
			file: FIXTURE_ARTIFACT,
			fetchImpl: foreignReleaseFetch(),
		});

		expect(verified.signerIdentity).toBe(FIXTURE_IDENTITY);
		expect(verified.digest).toBe(fixtureDigest);
	});

	it("an override relaxes nothing: the bundle is still mandatory and still has to verify", async () => {
		const { signature } = await loadWithOverride(fixtureSignerJson);

		await expect(
			signature.fetchVerifiedReleaseArtifactDigest({
				baseUrl,
				version: "0.94.2",
				file: FIXTURE_ARTIFACT,
				fetchImpl: foreignReleaseFetch(false),
			}),
		).rejects.toThrow(signature.ReleaseSignatureError);
		await expect(
			signature.fetchVerifiedReleaseArtifactDigest({
				baseUrl,
				version: "0.94.2",
				file: FIXTURE_ARTIFACT,
				fetchImpl: (async () => new Response(`${DIGEST}  ${FIXTURE_ARTIFACT}\n`, { status: 200 })) as never,
			}),
		).rejects.toThrow(/not valid JSON|could not be verified/);
	});

	it("with a valid override every update output line that names the signer carries the marker", async () => {
		const update = await loadUpdaterWithOverride(fixtureSignerJson);

		const plan = await update.getNativeUpdatePlan({ force: true, rollback: false, executable });

		expect(plan.verifiedSignerIdentity).toBe(FIXTURE_IDENTITY);
		expect(plan.testSignerOverride).toBe(true);
		const { notes, warnings } = update.describeNativeUpdatePlan(plan);
		expect(notes[0]).toBe(
			`Release v${VERSION} checksums verified: signed by repository charmbracelet/meta, workflow .github/workflows/goreleaser.yml, ref refs/heads/main (${FIXTURE_IDENTITY}) ${RELEASE_SIGNER_TEST_OVERRIDE_MARKER}.`,
		);
		expect(notes[1]).toBe(
			`This build trusts a test signer override, not the production release signer ${RELEASE_SIGNER_TEST_OVERRIDE_MARKER}.`,
		);
		expect(notes).toHaveLength(2);
		const signerLines = [...notes, ...warnings].filter((line) => /sign/i.test(line));
		expect(signerLines.length).toBeGreaterThan(0);
		for (const line of signerLines) expect(line).toContain(RELEASE_SIGNER_TEST_OVERRIDE_MARKER);
		expect(RELEASE_SIGNER_TEST_OVERRIDE_MARKER).toBe("(test signer override)");
	});

	it.each([
		[
			"a bad URL",
			JSON.stringify({ ...JSON.parse(fixtureSignerJson), repositoryUri: "http://github.com/x/y" }),
			/bare https URL/,
		],
		["a missing field", JSON.stringify({ ...JSON.parse(fixtureSignerJson), oidcIssuer: undefined }), /oidcIssuer/],
		[
			"a non-compiling regex",
			JSON.stringify({ ...JSON.parse(fixtureSignerJson), refPattern: "^refs/(main$" }),
			/does not compile/,
		],
		[
			"an unanchored regex",
			JSON.stringify({ ...JSON.parse(fixtureSignerJson), refPattern: "refs/heads/main" }),
			/anchored/,
		],
		["a non-object", '"https://github.com/x/y"', /JSON object/],
		["malformed JSON", "{", /not valid JSON/],
	])("an override with %s makes the trust module fail to load", async (_label, json, message) => {
		vi.stubGlobal(OVERRIDE_IDENTIFIER, json);
		vi.resetModules();

		await expect(import("../src/utils/release-trust.js")).rejects.toThrow(message);
		// The updater depends on it, so it cannot load either - there is no fallback to the constant.
		await expect(import("../src/cli/native-update.js")).rejects.toThrow(message);
	});

	it("a non-string, non-null definition is refused", async () => {
		vi.stubGlobal(OVERRIDE_IDENTIFIER, { repositoryUri: "x" });
		vi.resetModules();

		await expect(import("../src/utils/release-trust.js")).rejects.toThrow(/null or a JSON string literal/);
	});

	it("the override has no runtime input: the trust module reads no environment, files or arguments", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "..", "src", "utils", "release-trust.ts"),
			"utf8",
		);
		const code = source
			.split("\n")
			.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
			.join("\n");

		expect(code).not.toMatch(/process\.env/);
		expect(code).not.toMatch(/process\.argv/);
		expect(code).not.toMatch(/\bimport\b.*["']node:/);
		expect(code).not.toMatch(/\brequire\(/);
		expect(code).not.toMatch(/globalThis/);
		expect(code).not.toMatch(/readFileSync|readFile\b|fetch\(/);
		// The identifier is declared once and read once, through a typeof guard.
		const references = code.match(new RegExp(OVERRIDE_IDENTIFIER, "g")) ?? [];
		expect(references).toHaveLength(3);
		expect(code).toMatch(new RegExp(`declare const ${OVERRIDE_IDENTIFIER}: string \\| null \\| undefined;`));
		expect(code).toMatch(new RegExp(`typeof ${OVERRIDE_IDENTIFIER} === "undefined"`));
	});
});

describe("release URL construction", () => {
	it("canonicalises a download origin", () => {
		expect(parseDownloadBaseUrl("https://releases.example")).toBe("https://releases.example");
		expect(parseDownloadBaseUrl("https://releases.example/")).toBe("https://releases.example");
		expect(parseDownloadBaseUrl(" https://Releases.Example:8443/prime// ")).toBe(
			"https://releases.example:8443/prime",
		);
		expect(parseDownloadBaseUrl("https://releases.example:443/prime")).toBe("https://releases.example/prime");
	});

	it.each([
		["http scheme", "http://releases.example", /must use https/],
		["invalid URL", "releases.example", /not a valid URL/],
		["query string", "https://releases.example/?x=1", /query string/],
		["empty query string", "https://releases.example/?", /query string/],
		["fragment", "https://releases.example/#x", /fragment/],
		["empty fragment", "https://releases.example/#", /fragment/],
		["credentials", "https://user:pass@releases.example", /credentials/],
		["username", "https://user@releases.example", /credentials/],
	])("refuses a download origin with a %s", (_label, raw, message) => {
		expect(() => parseDownloadBaseUrl(raw, "The origin")).toThrow(message);
		expect(() => parseDownloadBaseUrl(raw, "The origin")).toThrow(/^The origin/);
		expect(() => releaseAssetUrl(raw, VERSION, "SHA256SUMS")).toThrow(ReleaseSignatureError);
	});

	it("joins release assets with the URL API, never by concatenation", () => {
		expect(releaseAssetUrl("https://releases.example", VERSION, "SHA256SUMS")).toBe(
			`https://releases.example/releases/v${VERSION}/SHA256SUMS`,
		);
		expect(releaseAssetUrl("https://releases.example/prime///", "1.2.4-beta.1", "SHA256SUMS.sigstore.json")).toBe(
			"https://releases.example/prime/releases/v1.2.4-beta.1/SHA256SUMS.sigstore.json",
		);
	});

	it.each([
		["a path segment in the version", "1.2.4/../../evil", "SHA256SUMS"],
		["a query in the version", "1.2.4?x=1", "SHA256SUMS"],
		["a tag prefix in the version", "v1.2.4", "SHA256SUMS"],
		["a path segment in the asset", VERSION, "../SHA256SUMS"],
		["a query in the asset", VERSION, "SHA256SUMS?x=1"],
		["an empty asset", VERSION, ""],
	])("refuses to build a release URL with %s", (_label, version, asset) => {
		expect(() => releaseAssetUrl("https://releases.example", version, asset)).toThrow(ReleaseSignatureError);
	});
});
