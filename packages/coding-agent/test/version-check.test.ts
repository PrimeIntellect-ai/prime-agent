import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isBaseVersionDowngrade,
	isNewerPackageVersion,
	isReleaseUpdateCandidate,
	resolveUpdateChannel,
} from "../src/utils/version-check.js";
import { clearAmbientRuntimeEnv } from "./ambient-env.js";

const defaultPrimeAgentDownloadBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";

// These checks read the environment, so each test starts from a cleared one and the
// host shell cannot decide the outcome. Tests that need a variable set it themselves.
let restoreAmbientRuntimeEnv: () => void;

beforeEach(() => {
	restoreAmbientRuntimeEnv = clearAmbientRuntimeEnv();
});

afterEach(() => {
	vi.unstubAllGlobals();
	restoreAmbientRuntimeEnv();
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
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.5-beta.130.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestPiVersion("1.2.4", { channel: "nightly" })).resolves.toBe("1.2.5-beta.130.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultPrimeAgentDownloadBaseUrl}/beta.json`, expect.any(Object));
	});

	it("follows a preferred stable channel from a beta installation", async () => {
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

	it("flags only a lower base version as a downgrade", () => {
		expect(isBaseVersionDowngrade("1.2.2-beta.9.1.abcdef0", "1.2.3")).toBe(true);
		expect(isBaseVersionDowngrade("1.2.2", "1.2.3-beta.5.1.abcdef0")).toBe(true);
		expect(isBaseVersionDowngrade("1.2.3-beta.5.1.abcdef0", "1.2.3")).toBe(false);
		expect(isBaseVersionDowngrade("1.2.3", "1.2.3-beta.5.1.abcdef0")).toBe(false);
		expect(isBaseVersionDowngrade("1.3.0", "1.2.9")).toBe(false);
		expect(isBaseVersionDowngrade("not-a-version", "1.2.3")).toBe(false);
	});

	it("keeps same-channel updates strictly newer", () => {
		expect(isReleaseUpdateCandidate("1.2.3-beta.5.1.abcdef0", "1.2.3-beta.5.1.abcdef0", "nightly")).toBe(false);
		expect(isReleaseUpdateCandidate("1.2.3-beta.4.1.abcdef0", "1.2.3-beta.5.1.abcdef0", "nightly")).toBe(false);
		expect(isReleaseUpdateCandidate("1.2.3-beta.6.1.abcdef0", "1.2.3-beta.5.1.abcdef0", "nightly")).toBe(true);
	});

	it("reports the current beta build from a stable installation once nightly is preferred", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "v1.2.3-beta.5.1.abcdef0" })),
		);
		await expect(checkForNewPiVersion("1.2.3", "nightly")).resolves.toBe("1.2.3-beta.5.1.abcdef0");
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});

	it("reports a newer beta build when nightly is preferred", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "v1.2.5-beta.1.1.abcdef0" })),
		);
		await expect(checkForNewPiVersion("1.2.4", "nightly")).resolves.toBe("1.2.5-beta.1.1.abcdef0");
	});
});
