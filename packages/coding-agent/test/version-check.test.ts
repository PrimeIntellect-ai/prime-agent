import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV,
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	getReleaseTarballFileName,
	isNewerPackageVersion,
	ReleaseManifestError,
} from "../src/utils/version-check.js";

const defaultPrimeAgentDownloadBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;
const originalPrimeAgentDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;
const originalAllowInsecure = process.env[ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV];
const digest = "b8d752a53d11a8c9a7580e1fb5fc24f7ce74ccad979c7e6e6aa8880fc3ad90b0";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("PI_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("PI_OFFLINE", originalOffline);
	restoreEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", originalPrimeAgentDownloadBaseUrl);
	restoreEnv(ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV, originalAllowInsecure);
});

function stubManifest(manifest: unknown): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(manifest)),
	);
}

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the Prime Agent release manifest with a Prime Agent user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${defaultPrimeAgentDownloadBaseUrl}/latest.json`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^prime-agent\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("keeps beta installations on the beta release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4-beta.124.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567")).resolves.toBe("1.2.4-beta.124.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultPrimeAgentDownloadBaseUrl}/beta.json`, expect.any(Object));
	});

	it("returns the package and the verified tarball descriptor from the release manifest", async () => {
		stubManifest({
			package: "prime-agent",
			tarball: "releases/v1.2.4/prime-agent-1.2.4.tgz",
			tarballs: [{ package: "prime-agent", file: "prime-agent-1.2.4.tgz", sha256: digest }],
			version: "v1.2.4",
		});

		await expect(getLatestPiRelease("1.2.3", { packageName: "prime-agent" })).resolves.toEqual({
			packageName: "prime-agent",
			tarball: {
				fileName: "prime-agent-1.2.4.tgz",
				sha256: digest,
				url: `${defaultPrimeAgentDownloadBaseUrl}/releases/v1.2.4/prime-agent-1.2.4.tgz`,
			},
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("release manifest validation (ENG-5341)", () => {
	const baseManifest = {
		package: "prime-agent",
		version: "v99.0.0",
		tarball: "releases/v99.0.0/prime-agent-99.0.0.tgz",
		sha256: digest,
	};
	const options = { packageName: "prime-agent" };

	it("derives release tarball names the way the pack script does", () => {
		expect(getReleaseTarballFileName("prime-agent", "1.2.3")).toBe("prime-agent-1.2.3.tgz");
		expect(getReleaseTarballFileName("@earendil-works/pi-coding-agent", "1.2.3-beta.1")).toBe(
			"earendil-works-pi-coding-agent-1.2.3-beta.1.tgz",
		);
	});

	it("accepts a same-origin https tarball with a top-level digest", async () => {
		stubManifest(baseManifest);
		const release = await getLatestPiRelease("0.9.4", options);
		expect(release?.tarball).toEqual({
			fileName: "prime-agent-99.0.0.tgz",
			sha256: digest,
			url: `${defaultPrimeAgentDownloadBaseUrl}/releases/v99.0.0/prime-agent-99.0.0.tgz`,
		});
	});

	it("accepts an absolute tarball URL on the release origin and an uppercase digest", async () => {
		stubManifest({
			...baseManifest,
			sha256: undefined,
			tarball: `${defaultPrimeAgentDownloadBaseUrl}/releases/v99.0.0/prime-agent-99.0.0.tgz`,
			tarballs: [{ file: "prime-agent-99.0.0.tgz", sha256: digest.toUpperCase() }],
		});
		const release = await getLatestPiRelease("0.9.4", options);
		expect(release?.tarball?.sha256).toBe(digest);
	});

	it("rejects a tarball on a foreign origin", async () => {
		stubManifest({ ...baseManifest, tarball: "https://attacker.invalid/prime-agent-99.0.0.tgz" });
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(
			/attacker\.invalid.*not on the release origin/,
		);
	});

	it("rejects plaintext http and file tarballs even when the host matches", async () => {
		const host = new URL(defaultPrimeAgentDownloadBaseUrl).host;
		stubManifest({ ...baseManifest, tarball: `http://${host}/releases/v99.0.0/prime-agent-99.0.0.tgz` });
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toBeInstanceOf(ReleaseManifestError);

		stubManifest({ ...baseManifest, tarball: "file:///tmp/prime-agent-99.0.0.tgz" });
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(/not on the release origin/);
	});

	it("rejects a plaintext base URL unless the insecure mirror override is set", async () => {
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = "http://127.0.0.1:9/mirror";
		const fetchMock = vi.fn(async () => Response.json(baseManifest));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(/require an https base URL/);
		expect(fetchMock).not.toHaveBeenCalled();

		process.env[ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV] = "1";
		const release = await getLatestPiRelease("0.9.4", options);
		expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:9/mirror/latest.json", expect.any(Object));
		expect(release?.tarball?.url).toBe("http://127.0.0.1:9/mirror/releases/v99.0.0/prime-agent-99.0.0.tgz");
	});

	it("rejects a file: base URL even with the insecure override", async () => {
		process.env.PRIME_AGENT_DOWNLOAD_BASE_URL = "file:///tmp/mirror";
		process.env[ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV] = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("0.9.4", options)).rejects.toBeInstanceOf(ReleaseManifestError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a manifest package that differs from the installed package", async () => {
		stubManifest({
			...baseManifest,
			package: "@attacker/anything",
			tarball: "releases/v99.0.0/attacker-anything-99.0.0.tgz",
		});
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(
			/names package "@attacker\/anything", but this installation is "prime-agent"/,
		);
	});

	it("accepts an allowlisted package rename", async () => {
		stubManifest({
			...baseManifest,
			package: "prime-agent-next",
			tarball: "releases/v99.0.0/prime-agent-next-99.0.0.tgz",
		});
		const release = await getLatestPiRelease("0.9.4", { ...options, allowedPackageNames: ["prime-agent-next"] });
		expect(release?.packageName).toBe("prime-agent-next");
		expect(release?.tarball?.fileName).toBe("prime-agent-next-99.0.0.tgz");
	});

	it("rejects a tarball whose file name does not carry the manifest version", async () => {
		stubManifest({ ...baseManifest, tarball: "releases/v1.0.0/prime-agent-1.0.0.tgz" });
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(
			/"prime-agent-1\.0\.0\.tgz" does not match release version 99\.0\.0 \(expected prime-agent-99\.0\.0\.tgz\)/,
		);
	});

	it("rejects a tarball named after another package", async () => {
		stubManifest({ ...baseManifest, tarball: "releases/v99.0.0/other-99.0.0.tgz" });
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(/expected prime-agent-99\.0\.0\.tgz/);
	});

	it("rejects a manifest without a digest for the tarball", async () => {
		stubManifest({
			...baseManifest,
			sha256: undefined,
			tarballs: [{ file: "prime-agent-ai-99.0.0.tgz", sha256: digest }],
		});
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(
			/no SHA-256 digest for prime-agent-99\.0\.0\.tgz/,
		);
	});

	it("rejects a malformed digest", async () => {
		stubManifest({ ...baseManifest, sha256: "sha512-AAAA" });
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(/digest .* is malformed/);
	});

	it("rejects a manifest whose version is not a package version", async () => {
		stubManifest({ ...baseManifest, version: "latest" });
		await expect(getLatestPiRelease("0.9.4", options)).rejects.toThrow(/not a valid package version/);
	});

	it("keeps the startup version notice quiet when the manifest fails validation", async () => {
		stubManifest({ ...baseManifest, tarball: "https://attacker.invalid/prime-agent-99.0.0.tgz" });
		await expect(checkForNewPiVersion("0.9.4")).resolves.toBeUndefined();
	});

	it("still reports a newer version from a manifest without a tarball", async () => {
		stubManifest({ version: "v99.0.0" });
		await expect(getLatestPiRelease("0.9.4", options)).resolves.toEqual({ version: "99.0.0" });
	});

	it("fetches the manifest for an explicit update even when startup checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		stubManifest(baseManifest);
		await expect(getLatestPiRelease("0.9.4", options)).resolves.toBeUndefined();
		await expect(getLatestPiRelease("0.9.4", { ...options, explicit: true })).resolves.toMatchObject({
			version: "99.0.0",
		});
	});
});
