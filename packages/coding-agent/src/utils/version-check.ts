import { getPiUserAgent } from "./pi-user-agent.js";

const DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const STABLE_VERSION_MANIFEST_PATH = "latest.json";
const BETA_VERSION_MANIFEST_PATH = "beta.json";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;
export const ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV = "PRIME_AGENT_ALLOW_INSECURE_DOWNLOAD_BASE_URL";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface ReleaseTarball {
	url: string;
	fileName: string;
	sha256: string;
}

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	tarball?: ReleaseTarball;
}

export interface LatestPiReleaseOptions {
	timeoutMs?: number;
	/** Installed package name; the manifest `package` must match it or one of `allowedPackageNames`. */
	packageName?: string;
	allowedPackageNames?: readonly string[];
	/** Explicit user request: ignore PI_SKIP_VERSION_CHECK and PI_OFFLINE. */
	explicit?: boolean;
}

/** The release manifest was reachable but failed validation; nothing from it may be installed. */
export class ReleaseManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReleaseManifestError";
	}
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

function getPrimeAgentDownloadBaseUrl(): URL {
	const configured = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL?.trim();
	const raw = configured || DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ReleaseManifestError(`PRIME_AGENT_DOWNLOAD_BASE_URL is not an absolute URL: ${raw}`);
	}
	if (url.protocol === "http:" && process.env[ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV] === "1") {
		return url;
	}
	if (url.protocol !== "https:") {
		throw new ReleaseManifestError(
			`Release downloads require an https base URL (got ${raw}). Set ${ALLOW_INSECURE_DOWNLOAD_BASE_URL_ENV}=1 to allow a plaintext http mirror.`,
		);
	}
	return url;
}

function joinReleaseUrl(baseUrl: URL, relativePath: string): string {
	return `${baseUrl.toString().replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function normalizeReleaseVersion(version: string): string {
	return version.trim().replace(/^v/, "");
}

function getReleaseManifestPath(currentVersion: string): string {
	const prerelease = parsePackageVersion(currentVersion)?.prerelease;
	return prerelease?.match(/^beta(?:\.|$)/) ? BETA_VERSION_MANIFEST_PATH : STABLE_VERSION_MANIFEST_PATH;
}

/** Mirrors the artifact naming in scripts/pack-prime-agent-release.mjs. */
export function getReleaseTarballFileName(packageName: string, version: string): string {
	return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveTarballUrl(baseUrl: URL, tarball: string): URL {
	let url: URL;
	try {
		url = new URL(tarball);
	} catch {
		try {
			url = new URL(joinReleaseUrl(baseUrl, tarball));
		} catch {
			throw new ReleaseManifestError(`The release manifest tarball path is not a valid URL: ${tarball}`);
		}
	}
	if (url.protocol !== baseUrl.protocol || url.origin !== baseUrl.origin || url.origin === "null") {
		throw new ReleaseManifestError(
			`The release manifest lists tarball ${url.toString()}, which is not on the release origin ${baseUrl.origin}.`,
		);
	}
	return url;
}

function findManifestDigest(data: Record<string, unknown>, fileName: string): string {
	const candidates: unknown[] = [data.sha256];
	if (Array.isArray(data.tarballs)) {
		for (const entry of data.tarballs) {
			if (typeof entry === "object" && entry !== null) {
				const record = entry as Record<string, unknown>;
				if (readOptionalString(record.file) === fileName) {
					candidates.push(record.sha256);
				}
			}
		}
	}
	const digest = candidates.find((candidate): candidate is string => typeof candidate === "string");
	if (!digest) {
		throw new ReleaseManifestError(`The release manifest has no SHA-256 digest for ${fileName}.`);
	}
	const normalized = digest.trim().toLowerCase();
	if (!SHA256_HEX_PATTERN.test(normalized)) {
		throw new ReleaseManifestError(`The release manifest SHA-256 digest for ${fileName} is malformed.`);
	}
	return normalized;
}

function parseReleaseManifest(data: unknown, baseUrl: URL, options: LatestPiReleaseOptions): LatestPiRelease {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new ReleaseManifestError("The release manifest is not a JSON object.");
	}
	const manifest = data as Record<string, unknown>;
	const rawVersion = readOptionalString(manifest.version);
	if (!rawVersion) {
		throw new ReleaseManifestError("The release manifest has no version.");
	}
	const version = normalizeReleaseVersion(rawVersion);
	if (!parsePackageVersion(version)) {
		throw new ReleaseManifestError(`The release manifest version is not a valid package version: ${rawVersion}`);
	}

	const packageName = readOptionalString(manifest.package) ?? readOptionalString(manifest.packageName);
	if (packageName && options.packageName) {
		const accepted = [options.packageName, ...(options.allowedPackageNames ?? [])];
		if (!accepted.includes(packageName)) {
			throw new ReleaseManifestError(
				`The release manifest names package "${packageName}", but this installation is "${options.packageName}".`,
			);
		}
	}

	const release: LatestPiRelease = { version };
	if (packageName) {
		release.packageName = packageName;
	}

	const tarballSpec = readOptionalString(manifest.tarball);
	if (tarballSpec) {
		const url = resolveTarballUrl(baseUrl, tarballSpec);
		const fileName = url.pathname.split("/").pop() ?? "";
		const expectedPackageName = packageName ?? options.packageName;
		const expectedFileName = expectedPackageName
			? getReleaseTarballFileName(expectedPackageName, version)
			: undefined;
		const fileNameMatches = expectedFileName ? fileName === expectedFileName : fileName.endsWith(`-${version}.tgz`);
		if (!fileNameMatches) {
			throw new ReleaseManifestError(
				`The release manifest tarball "${fileName}" does not match release version ${version}` +
					(expectedFileName ? ` (expected ${expectedFileName}).` : "."),
			);
		}
		release.tarball = { url: url.toString(), fileName, sha256: findManifestDigest(manifest, fileName) };
	}
	return release;
}

/**
 * Fetches and validates the release manifest. Returns undefined when checks are disabled or the
 * manifest is unreachable; throws ReleaseManifestError when the manifest fails validation.
 */
export async function getLatestPiRelease(
	currentVersion: string,
	options: LatestPiReleaseOptions = {},
): Promise<LatestPiRelease | undefined> {
	if (!options.explicit && (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE)) return undefined;

	const baseUrl = getPrimeAgentDownloadBaseUrl();
	const response = await fetch(joinReleaseUrl(baseUrl, getReleaseManifestPath(currentVersion)), {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new ReleaseManifestError("The release manifest is not valid JSON.");
	}
	return parseReleaseManifest(data, baseUrl, options);
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
