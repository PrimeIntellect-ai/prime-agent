import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getPiUserAgent } from "./pi-user-agent.js";
import type { ReleaseTarball } from "./version-check.js";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface VerifiedReleaseArtifact {
	/** Local path of the tarball whose SHA-256 matched the manifest digest. */
	path: string;
	sha256: string;
	cleanup(): void;
}

/** The downloaded release artifact could not be fetched or did not match its manifest digest. */
export class ReleaseArtifactError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReleaseArtifactError";
	}
}

export interface DownloadReleaseTarballOptions {
	currentVersion: string;
	timeoutMs?: number;
	tempRoot?: string;
}

/**
 * Downloads the release tarball into a fresh temp directory and verifies its SHA-256 against the
 * manifest digest before returning. A mismatch removes the download and throws; nothing is ever
 * handed to a package manager unverified.
 */
export async function downloadVerifiedReleaseTarball(
	tarball: ReleaseTarball,
	options: DownloadReleaseTarballOptions,
): Promise<VerifiedReleaseArtifact> {
	const tempDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), "prime-agent-update-"));
	const cleanup = (): void => {
		rmSync(tempDir, { recursive: true, force: true });
	};
	const path = join(tempDir, tarball.fileName);

	try {
		const response = await fetch(tarball.url, {
			headers: { "User-Agent": getPiUserAgent(options.currentVersion), accept: "application/octet-stream" },
			redirect: "error",
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS),
		});
		if (!response.ok || !response.body) {
			throw new ReleaseArtifactError(
				`Failed to download ${tarball.url}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
			);
		}

		const hash = createHash("sha256");
		const tap = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				hash.update(chunk);
				callback(null, chunk);
			},
		});
		await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), tap, createWriteStream(path));

		const sha256 = hash.digest("hex");
		if (sha256 !== tarball.sha256) {
			throw new ReleaseArtifactError(
				`SHA-256 mismatch for ${tarball.fileName}: the release manifest expects ${tarball.sha256} but the download hashed to ${sha256}. The download was discarded.`,
			);
		}
		return { path, sha256, cleanup };
	} catch (error) {
		cleanup();
		if (error instanceof ReleaseArtifactError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new ReleaseArtifactError(`Failed to download ${tarball.url}: ${message}`);
	}
}
