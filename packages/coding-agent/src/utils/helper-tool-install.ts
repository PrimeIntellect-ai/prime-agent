import { createHash } from "node:crypto";
import {
	chmodSync,
	createWriteStream,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import extractZip from "extract-zip";
import { spawnSyncHidden } from "./child-process.js";
import { HELPER_TOOL_RELEASES, type HelperToolId, helperToolDownloadUrl } from "./helper-tool-releases.js";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const TAR_LIST_MAX_BUFFER = 16 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export class UnsupportedHelperPlatformError extends Error {}
export class HelperIntegrityError extends Error {}
export class UnsafeArchiveMemberError extends Error {}

export interface DownloadVerifiedOptions {
	timeoutMs?: number;
	maxBytes?: number;
}

/** Download `url` to `dest`, hashing the stream; `dest` is removed unless the SHA-256 matches. */
export async function downloadVerified(
	url: string,
	dest: string,
	expectedSha256: string,
	options: DownloadVerifiedOptions = {},
): Promise<void> {
	if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
		throw new HelperIntegrityError(`No valid pinned SHA-256 for ${basename(dest)}; refusing to download`);
	}
	if (!url.startsWith("https://")) {
		throw new HelperIntegrityError(`Refusing to download ${basename(dest)} over a non-HTTPS URL`);
	}
	const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;

	const response = await fetch(url, {
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Failed to download ${basename(dest)}: HTTP ${response.status}`);
	}
	if (!response.body) {
		throw new Error(`Failed to download ${basename(dest)}: empty response body`);
	}

	const hash = createHash("sha256");
	let received = 0;
	const hasher = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			received += chunk.length;
			if (received > maxBytes) {
				callback(new HelperIntegrityError(`Download of ${basename(dest)} exceeded ${maxBytes} bytes`));
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(
			Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>),
			hasher,
			createWriteStream(dest, { flags: "wx", mode: 0o600 }),
		);
		const actual = hash.digest("hex");
		if (actual !== expectedSha256) {
			throw new HelperIntegrityError(
				`SHA-256 mismatch for ${basename(dest)}: expected ${expectedSha256}, got ${actual}`,
			);
		}
	} catch (error) {
		rmSync(dest, { force: true });
		throw error;
	}
}

/** Reject archive members that could write outside the extraction directory. */
export function assertSafeArchiveMemberPath(memberPath: string): void {
	if (memberPath.length === 0 || memberPath.includes("\0")) {
		throw new UnsafeArchiveMemberError(`Archive member has an empty or NUL-containing path`);
	}
	if (/^[\\/]/.test(memberPath) || /^[A-Za-z]:/.test(memberPath)) {
		throw new UnsafeArchiveMemberError(`Archive member uses an absolute path: ${memberPath}`);
	}
	if (memberPath.split(/[\\/]+/).includes("..")) {
		throw new UnsafeArchiveMemberError(`Archive member escapes the extraction directory: ${memberPath}`);
	}
}

function listTarMembers(archivePath: string): string[] {
	const result = spawnSyncHidden("tar", ["tzPf", archivePath], {
		stdio: "pipe",
		encoding: "utf8",
		maxBuffer: TAR_LIST_MAX_BUFFER,
	});
	if (result.error || result.status !== 0) {
		const detail = result.error?.message ?? result.stderr?.trim() ?? "unknown error";
		throw new Error(`Failed to list ${basename(archivePath)}: ${detail}`);
	}
	return result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/** Extract a `.tar.gz` or `.zip` into `extractDir` after validating every member path. */
export async function extractArchiveSafely(archivePath: string, extractDir: string): Promise<void> {
	mkdirSync(extractDir, { recursive: true });
	if (archivePath.endsWith(".tar.gz")) {
		for (const member of listTarMembers(archivePath)) {
			assertSafeArchiveMemberPath(member);
		}
		const result = spawnSyncHidden("tar", ["xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
		if (result.error || result.status !== 0) {
			const detail = result.error?.message ?? result.stderr?.toString().trim() ?? "unknown error";
			throw new Error(`Failed to extract ${basename(archivePath)}: ${detail}`);
		}
		return;
	}
	if (archivePath.endsWith(".zip")) {
		await extractZip(archivePath, {
			dir: extractDir,
			onEntry: (entry) => {
				assertSafeArchiveMemberPath(entry.fileName);
				const mode = (entry.externalFileAttributes >> 16) & 0xffff;
				if ((mode & S_IFMT) === S_IFLNK) {
					throw new UnsafeArchiveMemberError(`Archive member is a symbolic link: ${entry.fileName}`);
				}
			},
		});
		return;
	}
	throw new Error(`Unsupported archive format: ${basename(archivePath)}`);
}

function findFileRecursively(rootDir: string, fileName: string): string | null {
	const stack: string[] = [rootDir];
	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;
		for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === fileName) return fullPath;
			if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	return null;
}

function locateExtractedBinary(extractDir: string, archiveName: string, binaryFileName: string): string {
	const nested = join(extractDir, archiveName.replace(/\.(tar\.gz|zip)$/, ""), binaryFileName);
	const flat = join(extractDir, binaryFileName);
	const candidate =
		[nested, flat].find((path) => {
			try {
				return lstatSync(path).isFile();
			} catch {
				return false;
			}
		}) ?? findFileRecursively(extractDir, binaryFileName);
	if (!candidate) {
		throw new Error(`Binary not found in archive: expected ${binaryFileName} in ${archiveName}`);
	}
	if (!lstatSync(candidate).isFile()) {
		throw new UnsafeArchiveMemberError(`Extracted ${binaryFileName} is not a regular file`);
	}
	const root = realpathSync(extractDir);
	if (!realpathSync(candidate).startsWith(root + sep)) {
		throw new UnsafeArchiveMemberError(`Extracted ${binaryFileName} resolves outside the extraction directory`);
	}
	return candidate;
}

export interface InstallPinnedHelperToolOptions {
	tool: HelperToolId;
	platform: string;
	architecture: string;
	/** Directory the verified binary is moved into; staging happens in a sibling temp dir. */
	destDir: string;
	binaryFileName: string;
	/** Must return true for the staged binary (for example a `--version` run) before it is installed. */
	verifyBinary: (binaryPath: string) => Promise<boolean> | boolean;
	timeoutMs?: number;
}

/**
 * Download the pinned release asset for `tool`, verify its SHA-256, extract it in a
 * staging directory, check the binary works, then move it to `destDir`. Nothing is left
 * in `destDir` when any step fails.
 */
export async function installPinnedHelperTool(options: InstallPinnedHelperToolOptions): Promise<string> {
	const release = HELPER_TOOL_RELEASES[options.tool];
	const assetName = release.assetName(options.platform, options.architecture);
	if (!assetName) {
		throw new UnsupportedHelperPlatformError(`Unsupported platform: ${options.platform}/${options.architecture}`);
	}
	const expectedSha256 = release.sha256[assetName];
	if (!expectedSha256) {
		throw new HelperIntegrityError(`No pinned SHA-256 for ${assetName}; refusing to install ${options.tool}`);
	}

	mkdirSync(options.destDir, { recursive: true });
	const stagingDir = mkdtempSync(join(options.destDir, `.staging-${options.binaryFileName}-`));
	try {
		const archivePath = join(stagingDir, assetName);
		await downloadVerified(helperToolDownloadUrl(release, assetName), archivePath, expectedSha256, {
			timeoutMs: options.timeoutMs,
		});

		const extractDir = join(stagingDir, "extract");
		await extractArchiveSafely(archivePath, extractDir);
		const stagedBinary = locateExtractedBinary(extractDir, assetName, options.binaryFileName);
		if (options.platform !== "win32") {
			chmodSync(stagedBinary, 0o755);
		}
		if (!(await options.verifyBinary(stagedBinary))) {
			throw new Error(`Downloaded ${options.binaryFileName} ${release.version} failed its version check`);
		}

		const installedPath = join(options.destDir, options.binaryFileName);
		rmSync(installedPath, { force: true });
		renameSync(stagedBinary, installedPath);
		return installedPath;
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
	}
}
