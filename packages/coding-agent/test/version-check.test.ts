import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	isReleaseUpdateCandidate,
	resolveUpdateChannel,
} from "../src/utils/version-check.js";

const defaultPrimeAgentDownloadBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;
const originalPrimeAgentDownloadBaseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL;

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
});

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

	it("returns the active package and tarball install spec from the release manifest", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				package: "prime-agent",
				tarball: "releases/v1.2.4/prime-agent-1.2.4.tgz",
				version: "v1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			installSpec: `${defaultPrimeAgentDownloadBaseUrl}/releases/v1.2.4/prime-agent-1.2.4.tgz`,
			packageName: "prime-agent",
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

describe("update channel preference", () => {
	it("infers the channel from the running version when none is preferred", () => {
		expect(resolveUpdateChannel("1.2.4")).toBe("stable");
		expect(resolveUpdateChannel("1.2.4-beta.123.1.1234567")).toBe("nightly");
		expect(resolveUpdateChannel("1.2.4-beta.123.1.1234567", "stable")).toBe("stable");
		expect(resolveUpdateChannel("1.2.4", "nightly")).toBe("nightly");
	});

	it("follows a preferred nightly channel from a stable installation", async () => {
		delete process.env.PI_SKIP_VERSION_CHECK;
		delete process.env.PI_OFFLINE;
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.5-beta.130.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestPiVersion("1.2.4", { channel: "nightly" })).resolves.toBe("1.2.5-beta.130.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultPrimeAgentDownloadBaseUrl}/beta.json`, expect.any(Object));
	});

	it("follows a preferred stable channel from a beta installation", async () => {
		delete process.env.PI_SKIP_VERSION_CHECK;
		delete process.env.PI_OFFLINE;
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567", { channel: "stable" })).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultPrimeAgentDownloadBaseUrl}/latest.json`, expect.any(Object));
	});

	it("lets a stable installation move onto the current beta build when nightly is preferred", () => {
		expect(isReleaseUpdateCandidate("1.2.3-beta.5.1.abcdef0", "1.2.3", "nightly")).toBe(true);
		expect(isReleaseUpdateCandidate("1.2.3-beta.5.1.abcdef0", "1.2.3")).toBe(false);
		expect(isReleaseUpdateCandidate("1.2.3-beta.5.1.abcdef0", "1.2.3", "stable")).toBe(false);
	});

	it("never downgrades the base version when switching channels", () => {
		expect(isReleaseUpdateCandidate("1.2.2-beta.9.1.abcdef0", "1.2.3", "nightly")).toBe(false);
		expect(isReleaseUpdateCandidate("1.2.2", "1.2.3-beta.5.1.abcdef0", "stable")).toBe(false);
		expect(isReleaseUpdateCandidate("1.2.3", "1.2.3-beta.5.1.abcdef0", "stable")).toBe(true);
	});

	it("keeps same-channel updates strictly newer", () => {
		expect(isReleaseUpdateCandidate("1.2.3-beta.5.1.abcdef0", "1.2.3-beta.5.1.abcdef0", "nightly")).toBe(false);
		expect(isReleaseUpdateCandidate("1.2.3-beta.4.1.abcdef0", "1.2.3-beta.5.1.abcdef0", "nightly")).toBe(false);
		expect(isReleaseUpdateCandidate("1.2.3-beta.6.1.abcdef0", "1.2.3-beta.5.1.abcdef0", "nightly")).toBe(true);
	});

	it("reports the current beta build from a stable installation once nightly is preferred", async () => {
		delete process.env.PI_SKIP_VERSION_CHECK;
		delete process.env.PI_OFFLINE;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "v1.2.3-beta.5.1.abcdef0" })),
		);
		await expect(checkForNewPiVersion("1.2.3", "nightly")).resolves.toBe("1.2.3-beta.5.1.abcdef0");
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});

	it("reports a newer beta build when nightly is preferred", async () => {
		delete process.env.PI_SKIP_VERSION_CHECK;
		delete process.env.PI_OFFLINE;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "v1.2.5-beta.1.1.abcdef0" })),
		);
		await expect(checkForNewPiVersion("1.2.4", "nightly")).resolves.toBe("1.2.5-beta.1.1.abcdef0");
	});
});
