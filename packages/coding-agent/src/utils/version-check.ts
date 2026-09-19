import { parseDownloadBaseUrl } from "./download-url.js";
import { isNativePlatform } from "./native-installation.js";
import { getPiUserAgent } from "./pi-user-agent.js";

const DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const STABLE_VERSION_MANIFEST_PATH = "latest.json";
const BETA_VERSION_MANIFEST_PATH = "beta.json";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export type UpdateChannel = "stable" | "nightly";

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	installSpec?: string;
	binaries?: NativeReleaseArtifact[];
}

interface NativeReleaseArtifact {
	platform: string;
	file: string;
	sha256: string;
}

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

function comparePrereleaseIdentifiers(leftPrerelease: string, rightPrerelease: string): number {
	const leftIdentifiers = leftPrerelease.split(".");
	const rightIdentifiers = rightPrerelease.split(".");
	const length = Math.max(leftIdentifiers.length, rightIdentifiers.length);

	for (let index = 0; index < length; index += 1) {
		const left = leftIdentifiers[index];
		const right = rightIdentifiers[index];
		if (left === right) continue;
		if (left === undefined) return -1;
		if (right === undefined) return 1;

		const leftIsNumeric = /^\d+$/.test(left);
		const rightIsNumeric = /^\d+$/.test(right);
		if (leftIsNumeric && rightIsNumeric) {
			const leftNumber = left.replace(/^0+(?=\d)/, "");
			const rightNumber = right.replace(/^0+(?=\d)/, "");
			if (leftNumber.length !== rightNumber.length) return leftNumber.length - rightNumber.length;
			const comparison = leftNumber.localeCompare(rightNumber);
			if (comparison !== 0) return comparison;
			continue;
		}
		if (leftIsNumeric) return -1;
		if (rightIsNumeric) return 1;
		return left.localeCompare(right);
	}

	return 0;
}

function parsePackageVersion(version: string): ParsedVersion | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
	if (!match) {
		return undefined;
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
	};
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) {
		return undefined;
	}

	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/**
 * The download origin. An override is validated like every other download base URL (https only, no
 * credentials, no query or fragment) so a broken or hostile value fails here instead of producing
 * malformed URLs downstream.
 */
function getPrimeAgentDownloadBaseUrl(): string {
	const override = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL?.trim();
	return parseDownloadBaseUrl(override || DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL, "PRIME_AGENT_DOWNLOAD_BASE_URL");
}

function normalizeReleaseVersion(version: string): string {
	return version.trim().replace(/^v/, "");
}

/**
 * A preferred channel wins; otherwise a build tagged `-beta` stays on nightly and anything else
 * follows stable. Nightly builds are what the release bucket publishes as beta.
 */
export function resolveUpdateChannel(currentVersion: string, preferred?: UpdateChannel): UpdateChannel {
	if (preferred) return preferred;
	const prerelease = parsePackageVersion(currentVersion)?.prerelease;
	return prerelease?.match(/^beta(?:\.|$)/) ? "nightly" : "stable";
}

/**
 * Whether `candidateVersion` should replace `currentVersion` on the effective channel.
 * Same-channel updates must be strictly newer. An explicit switch to another channel
 * accepts any different version whose base version is not older, so a stable 1.2.3
 * can move onto 1.2.3-beta.5 even though prerelease ordering ranks that lower.
 */
export function isReleaseUpdateCandidate(
	candidateVersion: string,
	currentVersion: string,
	channel?: UpdateChannel,
): boolean {
	if (isNewerPackageVersion(candidateVersion, currentVersion)) return true;
	if (!channel || channel === resolveUpdateChannel(currentVersion)) return false;
	if (normalizeReleaseVersion(candidateVersion) === normalizeReleaseVersion(currentVersion)) return false;
	const candidate = parsePackageVersion(candidateVersion);
	const current = parsePackageVersion(currentVersion);
	if (!candidate || !current) return true;
	if (candidate.major !== current.major) return candidate.major > current.major;
	if (candidate.minor !== current.minor) return candidate.minor > current.minor;
	return candidate.patch >= current.patch;
}

/** True when installing `candidateVersion` would lower the major.minor.patch base, prerelease tags aside. */
export function isBaseVersionDowngrade(candidateVersion: string, currentVersion: string): boolean {
	const candidate = parsePackageVersion(candidateVersion);
	const current = parsePackageVersion(currentVersion);
	if (!candidate || !current) return false;
	if (candidate.major !== current.major) return candidate.major < current.major;
	if (candidate.minor !== current.minor) return candidate.minor < current.minor;
	return candidate.patch < current.patch;
}

function getReleaseManifestPath(currentVersion: string, channel?: UpdateChannel): string {
	return resolveUpdateChannel(currentVersion, channel) === "nightly"
		? BETA_VERSION_MANIFEST_PATH
		: STABLE_VERSION_MANIFEST_PATH;
}

/**
 * Resolve a manifest-provided release location. An absolute https URL is used as published
 * (release feeds may name a tarball on their own distribution host); it is still refused when it
 * carries credentials, a query, or a fragment, or is protocol-relative. A relative path is joined
 * with the URL API and must stay inside the download origin's prefix.
 */
function resolveReleaseUrl(baseUrl: string, pathOrUrl: string): string | undefined {
	const trimmed = pathOrUrl.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("//")) return undefined; // protocol-relative: scheme depends on context
	const base = new URL(`${baseUrl}/`);
	let resolved: URL;
	try {
		resolved = new URL(trimmed, base);
	} catch {
		return undefined;
	}
	if (resolved.protocol !== "https:") return undefined;
	if (resolved.search || resolved.hash || resolved.username || resolved.password) return undefined;
	if (trimmed.includes("://") && !/^https:/.test(trimmed)) return undefined;
	if (!trimmed.includes("://")) {
		// A relative location may not escape the origin or the configured prefix.
		if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) return undefined;
	}
	return resolved.toString();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; baseUrl?: string; channel?: UpdateChannel } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const baseUrl = options.baseUrl ? parseDownloadBaseUrl(options.baseUrl) : getPrimeAgentDownloadBaseUrl();
	const manifestUrl = new URL(getReleaseManifestPath(currentVersion, options.channel), `${baseUrl}/`);
	const response = await fetch(manifestUrl.toString(), {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		package?: unknown;
		packageName?: unknown;
		tarball?: unknown;
		version?: unknown;
		binaries?: unknown;
		binariesV2?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.package === "string" && data.package.trim()
			? data.package.trim()
			: typeof data.packageName === "string" && data.packageName.trim()
				? data.packageName.trim()
				: undefined;
	const installSpec = typeof data.tarball === "string" ? resolveReleaseUrl(baseUrl, data.tarball) : undefined;
	const release: LatestPiRelease = { version: normalizeReleaseVersion(data.version) };
	if (packageName) {
		release.packageName = packageName;
	}
	if (installSpec) {
		release.installSpec = installSpec;
	}
	// Prefer the complete v2 schema, with the v1 schema as a compatibility
	// fallback. Structurally valid entries for future platforms are ignored,
	// while malformed or duplicate supported-platform entries reject the list.
	const binarySource = Array.isArray(data.binariesV2)
		? data.binariesV2
		: Array.isArray(data.binaries)
			? data.binaries
			: undefined;
	if (binarySource) {
		const binaries: NativeReleaseArtifact[] = [];
		const platforms = new Set<string>();
		for (const candidate of binarySource) {
			if (!candidate || typeof candidate !== "object") return release;
			const artifact = candidate as Partial<NativeReleaseArtifact>;
			if (typeof artifact.platform !== "string") return release;
			if (!isNativePlatform(artifact.platform)) continue;
			if (
				platforms.has(artifact.platform) ||
				artifact.file !== `prime-agent-${release.version}-${artifact.platform}.tar.gz` ||
				typeof artifact.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(artifact.sha256)
			)
				return release;
			platforms.add(artifact.platform);
			binaries.push({ platform: artifact.platform, file: artifact.file, sha256: artifact.sha256 });
		}
		if (binaries.length > 0) release.binaries = binaries;
	}
	return release;
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; channel?: UpdateChannel } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(
	currentVersion: string,
	channel?: UpdateChannel,
): Promise<string | undefined> {
	try {
		const latestVersion = await getLatestPiVersion(currentVersion, { channel });
		if (latestVersion && isReleaseUpdateCandidate(latestVersion, currentVersion, channel)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
