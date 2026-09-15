import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeNativeUpdatePlan, getNativeUpdatePlan } from "../src/cli/native-update.js";
import { NATIVE_RELEASE_ASSETS } from "../src/utils/native-installation.js";
import { ReleaseSignatureError } from "../src/utils/release-signature.js";
import { getLatestPiRelease } from "../src/utils/version-check.js";

const SIGNER_IDENTITY =
	"https://github.com/PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/main";

// The real verifier is exercised end to end in release-signature.test.ts and, against the production
// pinning, in native-update-signature.test.ts. Here it is stubbed so these tests can concentrate on
// how the update plan reacts to its result.
const verifiedDigest = vi.hoisted(() => vi.fn());
vi.mock("../src/utils/release-signature.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/release-signature.js")>()),
	fetchVerifiedReleaseArtifactDigest: verifiedDigest,
}));

const artifact = {
	platform: "linux-x64",
	file: "prime-agent-1.2.4-linux-x64.tar.gz",
	sha256: "b".repeat(64),
};
const invalidMetadata: Array<{ name: string; binaries: unknown }> = [
	{ name: "invalid checksum", binaries: [{ ...artifact, sha256: "invalid" }] },
	{ name: "duplicate platform", binaries: [artifact, artifact] },
	{ name: "valid entry followed by invalid entry", binaries: [artifact, null] },
	{ name: "wrong archive version", binaries: [{ ...artifact, file: "prime-agent-1.2.3-linux-x64.tar.gz" }] },
	{ name: "non-array metadata", binaries: { artifact } },
];

describe("native release metadata isolation", () => {
	let root: string;
	let executable: string;
	let target: string;
	const baseUrl = "https://releases.example";

	beforeEach(() => {
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", baseUrl);
		root = realpathSync(mkdtempSync(join(tmpdir(), "prime-native-metadata-")));
		const checksum = "a".repeat(64);
		const releaseName = `1.2.3-linux-x64-${checksum}`;
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
		verifiedDigest.mockReset();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(invalidMetadata)(
		"preserves npm release details but refuses native updates for $name",
		async ({ binaries }) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json({
						version: "v1.2.4",
						package: "prime-agent",
						tarball: "releases/v1.2.4/prime-agent-1.2.4.tgz",
						binaries,
					}),
				),
			);

			await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
				version: "1.2.4",
				packageName: "prime-agent",
				installSpec: `${baseUrl}/releases/v1.2.4/prime-agent-1.2.4.tgz`,
			});
			for (const force of [false, true]) {
				await expect(getNativeUpdatePlan({ force, rollback: false, executable })).rejects.toThrow(
					"No verified compiled archive is available for linux-x64.",
				);
			}
			expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
		},
	);

	it("uses the signature-verified platform checksum when the entire native list is valid", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "1.2.4", binaries: [artifact] })),
		);
		verifiedDigest.mockResolvedValue({
			digest: artifact.sha256,
			signerIdentity: SIGNER_IDENTITY,
			signerRef: "refs/heads/main",
		});

		const plan = await getNativeUpdatePlan({ force: false, rollback: false, executable });

		expect(verifiedDigest).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl, version: "1.2.4", file: artifact.file }),
		);
		expect(plan.targetVersion).toBe("1.2.4");
		expect(plan.verifiedSignerIdentity).toBe(SIGNER_IDENTITY);
		expect(plan.command?.args).toContain(`PRIME_AGENT_EXPECTED_SHA256=${artifact.sha256}`);
		expect(plan.command?.args).toContain("PRIME_AGENT_INSTALL_METHOD=binary");
	});

	it("refuses the update when the signed SHA256SUMS disagrees with the release manifest", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "1.2.4", binaries: [artifact] })),
		);
		verifiedDigest.mockResolvedValue({
			digest: "c".repeat(64),
			signerIdentity: SIGNER_IDENTITY,
			signerRef: "refs/heads/main",
		});

		await expect(getNativeUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(
			/does not match the release manifest/,
		);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	it("lets a verification failure abort the update instead of degrading to a warning", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "1.2.4", binaries: [artifact] })),
		);
		verifiedDigest.mockRejectedValue(new ReleaseSignatureError("no signature was published"));

		await expect(getNativeUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(
			ReleaseSignatureError,
		);
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	it("records the origin override instead of applying it silently", async () => {
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "https://mirror.example/");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "1.2.4", binaries: [artifact] })),
		);
		verifiedDigest.mockResolvedValue({
			digest: artifact.sha256,
			signerIdentity: SIGNER_IDENTITY,
			signerRef: "refs/heads/main",
		});

		const plan = await getNativeUpdatePlan({ force: false, rollback: false, executable });

		// The override moves the origin, and verification still runs against that origin.
		expect(plan.overriddenBaseUrl).toBe("https://mirror.example");
		expect(verifiedDigest).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://mirror.example" }));
		expect(plan.command?.args).toContain("PRIME_AGENT_DOWNLOAD_BASE_URL=https://mirror.example");
	});

	it("canonicalises the override and builds every downstream URL from it with exactly one separator", async () => {
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "https://Mirror.example:8443/prime//");
		const fetchMock = vi.fn(async (_input: string | URL) =>
			Response.json({ version: "1.2.4", binaries: [artifact] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		verifiedDigest.mockResolvedValue({
			digest: artifact.sha256,
			signerIdentity: SIGNER_IDENTITY,
			signerRef: "refs/heads/main",
		});

		const plan = await getNativeUpdatePlan({ force: false, rollback: false, executable });

		expect(plan.overriddenBaseUrl).toBe("https://mirror.example:8443/prime");
		expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
			"https://mirror.example:8443/prime/latest.json",
		]);
		expect(verifiedDigest).toHaveBeenCalledWith(
			expect.objectContaining({ baseUrl: "https://mirror.example:8443/prime" }),
		);
		expect(plan.command?.args).toContain("PRIME_AGENT_DOWNLOAD_BASE_URL=https://mirror.example:8443/prime");
	});

	it.each([
		["http URL", "http://mirror.example", /must use https/],
		["ftp URL", "ftp://mirror.example", /must use https/],
		["not a URL", "not a url", /not a valid URL/],
		["scheme-relative URL", "//mirror.example", /not a valid URL/],
		["query string", "https://mirror.example/?channel=beta", /query string/],
		["bare question mark", "https://mirror.example?", /query string/],
		["query string on a path", "https://mirror.example/prime?x=1", /query string/],
		["fragment", "https://mirror.example/#latest.json", /fragment/],
		["bare hash", "https://mirror.example#", /fragment/],
		["username and password", "https://user:pass@mirror.example", /credentials/],
		["username only", "https://user@mirror.example", /credentials/],
		["empty password", "https://user:@mirror.example", /credentials/],
	])("refuses an origin override with a %s", async (_label, override, message) => {
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", override);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getNativeUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(
			/PRIME_AGENT_DOWNLOAD_BASE_URL/,
		);
		await expect(getNativeUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(message);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(verifiedDigest).not.toHaveBeenCalled();
		expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
	});

	it.each([
		["query string", "https://releases.example/?x=1", /query string/],
		["fragment", "https://releases.example/#x", /fragment/],
		["credentials", "https://user:pass@releases.example", /credentials/],
		["http scheme", "http://releases.example", /must use https/],
	])("refuses a recorded install source with a %s instead of appending to it", async (_label, source, message) => {
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "");
		writeFileSync(join(root, "releases", `1.2.3-linux-x64-${"a".repeat(64)}`, ".install-source"), source);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getNativeUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(
			/^The recorded install source \(\.install-source\)/,
		);
		await expect(getNativeUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(message);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(verifiedDigest).not.toHaveBeenCalled();
	});

	it("does not report an override that names the recorded origin", async () => {
		// The recorded source is `https://releases.example`; the same origin, differently spelled.
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "https://Releases.example/");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "1.2.4", binaries: [artifact] })),
		);
		verifiedDigest.mockResolvedValue({
			digest: artifact.sha256,
			signerIdentity: SIGNER_IDENTITY,
			signerRef: "refs/heads/main",
		});

		const plan = await getNativeUpdatePlan({ force: false, rollback: false, executable });

		expect(plan.overriddenBaseUrl).toBeUndefined();
		expect(describeNativeUpdatePlan(plan).warnings).toEqual([]);
		expect(plan.command?.args).toContain("PRIME_AGENT_DOWNLOAD_BASE_URL=https://releases.example");
	});

	describe("rollback with a legacy install source", () => {
		const legacySource = "http://legacy.example/prime-agent";
		let previousTarget: string;

		/** Retain a valid previous release and record the legacy http origin in both releases. */
		function retainPreviousRelease(): void {
			const activeDir = join(root, "releases", `1.2.3-linux-x64-${"a".repeat(64)}`);
			writeFileSync(join(activeDir, ".install-source"), legacySource);
			writeFileSync(join(activeDir, "install.sh"), "#!/bin/sh\n# prime-agent-native-recovery-v1\n");
			const checksum = "c".repeat(64);
			const releaseName = `1.2.2-linux-x64-${checksum}`;
			const previousDir = join(root, "releases", releaseName);
			for (const asset of NATIVE_RELEASE_ASSETS) {
				mkdirSync(dirname(join(previousDir, asset)), { recursive: true });
				writeFileSync(join(previousDir, asset), "fixture\n");
			}
			writeFileSync(join(previousDir, ".archive-sha256"), checksum);
			writeFileSync(join(previousDir, ".install-source"), legacySource);
			writeFileSync(join(previousDir, "package.json"), JSON.stringify({ version: "1.2.2" }));
			writeFileSync(join(previousDir, "prime-agent"), "#!/bin/sh\nprintf '1.2.2\\n'\n");
			chmodSync(join(previousDir, "prime-agent"), 0o755);
			previousTarget = `../releases/${releaseName}/prime-agent`;
			symlinkSync(previousTarget, join(root, "bin", "previous"));
		}

		it("plans the rollback: nothing is downloaded, so the recorded origin is not validated", async () => {
			vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "");
			retainPreviousRelease();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			const plan = await getNativeUpdatePlan({ force: false, rollback: true, executable });

			expect(plan.targetVersion).toBe("1.2.2");
			expect(plan.verifiedSignerIdentity).toBeUndefined();
			expect(plan.overriddenBaseUrl).toBeUndefined();
			expect(plan.command?.args).toContain("--rollback");
			expect(plan.command?.args).toContain(`PRIME_AGENT_EXPECTED_PREVIOUS=${previousTarget}`);
			// Handed through exactly as recorded; the installer's rollback never reads it.
			expect(plan.command?.args).toContain(`PRIME_AGENT_DOWNLOAD_BASE_URL=${legacySource}`);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(verifiedDigest).not.toHaveBeenCalled();
			expect(describeNativeUpdatePlan(plan)).toEqual({
				notes: ["Restoring the retained release v1.2.2; no download or signature check is involved."],
				warnings: [],
			});
		});

		it("still refuses to download from the same legacy origin", async () => {
			vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "");
			retainPreviousRelease();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			await expect(getNativeUpdatePlan({ force: true, rollback: false, executable })).rejects.toThrow(
				"The recorded install source (.install-source) must use https, got http://.",
			);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(verifiedDigest).not.toHaveBeenCalled();
			expect(readlinkSync(join(root, "bin", "prime-agent"))).toBe(target);
		});

		it("reports an override on a rollback plan only when it names a different origin", async () => {
			retainPreviousRelease();
			vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "https://mirror.example");

			const plan = await getNativeUpdatePlan({ force: false, rollback: true, executable });

			expect(plan.overriddenBaseUrl).toBe("https://mirror.example");
			expect(plan.command?.args).toContain("PRIME_AGENT_DOWNLOAD_BASE_URL=https://mirror.example");
		});
	});

	describe("user-facing provenance lines", () => {
		const serveRelease = () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({ version: "1.2.4", binaries: [artifact] })),
			);
			verifiedDigest.mockResolvedValue({
				digest: artifact.sha256,
				signerIdentity: SIGNER_IDENTITY,
				signerRef: "refs/heads/main",
			});
		};

		it("names the verified signer and warns about the override when one is in effect", async () => {
			vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "https://mirror.example/");
			serveRelease();

			const { notes, warnings } = describeNativeUpdatePlan(
				await getNativeUpdatePlan({ force: false, rollback: false, executable }),
			);

			expect(notes).toEqual([
				`Release v1.2.4 checksums verified: signed by repository PrimeIntellect-ai/prime-agent, workflow .github/workflows/build-binaries.yml, ref refs/heads/main (${SIGNER_IDENTITY}).`,
			]);
			expect(warnings).toEqual([
				"Warning: PRIME_AGENT_DOWNLOAD_BASE_URL overrides the recorded download origin. Release files will be fetched from https://mirror.example. The signature requirement is unchanged.",
			]);
		});

		it("names the verified signer and prints no warning when the recorded origin is used", async () => {
			vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "");
			serveRelease();

			const { notes, warnings } = describeNativeUpdatePlan(
				await getNativeUpdatePlan({ force: false, rollback: false, executable }),
			);

			expect(notes).toHaveLength(1);
			expect(notes[0]).toContain(SIGNER_IDENTITY);
			expect(notes[0]).toContain("repository PrimeIntellect-ai/prime-agent");
			expect(warnings).toEqual([]);
		});

		it("says nothing for a plan that installs nothing", () => {
			expect(describeNativeUpdatePlan({ targetVersion: "1.2.3" })).toEqual({ notes: [], warnings: [] });
			expect(describeNativeUpdatePlan({ targetVersion: "1.2.3", refusedDowngradeTo: "1.0.0" })).toEqual({
				notes: [],
				warnings: [],
			});
		});

		it("never claims a signature for a rollback plan", () => {
			const { notes, warnings } = describeNativeUpdatePlan({
				targetVersion: "1.2.2",
				overriddenBaseUrl: "https://mirror.example",
				command: { command: "/usr/bin/env", args: [], display: "prime-agent update --rollback" },
			});
			expect(notes).toEqual(["Restoring the retained release v1.2.2; no download or signature check is involved."]);
			expect(notes.join("\n")).not.toMatch(/signed by/);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("https://mirror.example");
		});
	});
});
