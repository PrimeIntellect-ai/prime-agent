import { getPiUserAgent } from "./pi-user-agent.js";

const DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const STABLE_VERSION_MANIFEST_PATH = "latest.json";
const BETA_VERSION_MANIFEST_PATH = "beta.json";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

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

function getPrimeAgentDownloadBaseUrl(): string {
	return (process.env.PRIME_AGENT_DOWNLOAD_BASE_URL?.trim() || DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL).replace(
		/\/+$/,
		"",
	);
}

function normalizeReleaseVersion(version: string): string {
	return version.trim().replace(/^v/, "");
}

function getReleaseManifestPath(currentVersion: string): string {
	const prerelease = parsePackageVersion(currentVersion)?.prerelease;
	return prerelease?.match(/^beta(?:\.|$)/) ? BETA_VERSION_MANIFEST_PATH : STABLE_VERSION_MANIFEST_PATH;
}

function resolveReleaseUrl(baseUrl: string, pathOrUrl: string): string | undefined {
	const trimmed = pathOrUrl.trim();
	if (!trimmed) return undefined;
	try {
		return new URL(trimmed).toString();
	} catch {
		return `${baseUrl}/${trimmed.replace(/^\/+/, "")}`;
	}
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;

	const baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? getPrimeAgentDownloadBaseUrl();
	const response = await fetch(`${baseUrl}/${getReleaseManifestPath(currentVersion)}`, {
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
	if (Array.isArray(data.binaries)) {
		// Invalid optional native metadata must not discard a valid npm release.
		// Publish the list only after every entry passes validation.
		const binaries: NativeReleaseArtifact[] = [];
		const platforms = new Set<string>();
		for (const candidate of data.binaries) {
			if (!candidate || typeof candidate !== "object") return release;
			const artifact = candidate as Partial<NativeReleaseArtifact>;
			if (
				typeof artifact.platform !== "string" ||
				!/^(darwin|linux)-(arm64|x64)$/.test(artifact.platform) ||
				platforms.has(artifact.platform) ||
				artifact.file !== `prime-agent-${release.version}-${artifact.platform}.tar.gz` ||
				typeof artifact.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(artifact.sha256)
			)
				return release;
			platforms.add(artifact.platform);
			binaries.push({ platform: artifact.platform, file: artifact.file, sha256: artifact.sha256 });
		}
		release.binaries = binaries;
	}
	return release;
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<string | undefined> {
	try {
		const latestVersion = await getLatestPiVersion(currentVersion);
		if (latestVersion && isNewerPackageVersion(latestVersion, currentVersion)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
