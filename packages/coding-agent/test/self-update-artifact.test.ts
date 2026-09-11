import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadVerifiedReleaseTarball, ReleaseArtifactError } from "../src/utils/self-update-artifact.js";

const tarballBytes = Buffer.from("not really a tarball, but hashed like one");
const tarball = {
	url: "https://releases.example/releases/v99.0.0/prime-agent-99.0.0.tgz",
	fileName: "prime-agent-99.0.0.tgz",
	sha256: createHash("sha256").update(tarballBytes).digest("hex"),
};

let tempRoot: string;

function stubDownload(body: Buffer | null, status = 200): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => new Response(body, { status }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "self-update-artifact-test-"));
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("downloadVerifiedReleaseTarball", () => {
	it("writes the tarball into a private temp directory when the digest matches", async () => {
		const fetchMock = stubDownload(tarballBytes);

		const artifact = await downloadVerifiedReleaseTarball(tarball, { currentVersion: "0.9.4", tempRoot });

		expect(fetchMock).toHaveBeenCalledWith(tarball.url, expect.objectContaining({ redirect: "error" }));
		expect(artifact.sha256).toBe(tarball.sha256);
		expect(dirname(dirname(artifact.path))).toBe(tempRoot);
		expect(artifact.path.endsWith(join("", tarball.fileName))).toBe(true);
		expect(readFileSync(artifact.path)).toEqual(tarballBytes);

		artifact.cleanup();
		expect(existsSync(artifact.path)).toBe(false);
		expect(readdirSync(tempRoot)).toEqual([]);
	});

	it("discards the download and throws when the digest does not match", async () => {
		stubDownload(Buffer.concat([tarballBytes, Buffer.from("tampered")]));

		await expect(downloadVerifiedReleaseTarball(tarball, { currentVersion: "0.9.4", tempRoot })).rejects.toThrow(
			/SHA-256 mismatch for prime-agent-99\.0\.0\.tgz/,
		);
		expect(readdirSync(tempRoot)).toEqual([]);
	});

	it("throws a ReleaseArtifactError and cleans up on an HTTP error", async () => {
		stubDownload(null, 404);

		await expect(
			downloadVerifiedReleaseTarball(tarball, { currentVersion: "0.9.4", tempRoot }),
		).rejects.toBeInstanceOf(ReleaseArtifactError);
		expect(readdirSync(tempRoot)).toEqual([]);
	});

	it("wraps network failures and cleans up", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);

		await expect(downloadVerifiedReleaseTarball(tarball, { currentVersion: "0.9.4", tempRoot })).rejects.toThrow(
			/Failed to download .*fetch failed/,
		);
		expect(readdirSync(tempRoot)).toEqual([]);
	});
});
