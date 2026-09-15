// ENG-5343: fd/rg helper provisioning must verify pinned digests, contain archive
// members, and leave nothing behind when a download fails.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTarGz, makeZip } from "./archive-fixtures.js";

// getBinDir() is read once at tools-manager import time, so the path must exist before imports run.
const toolState = vi.hoisted(() => ({
	work: `/tmp/eng5343-helper-${process.pid}`,
	toolsDir: `/tmp/eng5343-helper-${process.pid}/bin`,
	platform: process.platform as string,
	architecture: process.arch as string,
	sha256: { fd: {} as Record<string, string>, rg: {} as Record<string, string> },
}));

vi.mock("../src/config.js", () => ({
	APP_NAME: "prime-agent",
	getBinDir: () => toolState.toolsDir,
}));

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>();
	return {
		...actual,
		default: { ...actual, arch: () => toolState.architecture, platform: () => toolState.platform },
		arch: () => toolState.architecture,
		platform: () => toolState.platform,
	};
});

vi.mock("../src/utils/helper-tool-releases.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/helper-tool-releases.js")>();
	return {
		...actual,
		HELPER_TOOL_RELEASES: {
			...actual.HELPER_TOOL_RELEASES,
			fd: {
				...actual.HELPER_TOOL_RELEASES.fd,
				get sha256() {
					return toolState.sha256.fd;
				},
			},
			rg: {
				...actual.HELPER_TOOL_RELEASES.rg,
				get sha256() {
					return toolState.sha256.rg;
				},
			},
		},
	};
});

import { assertSafeArchiveMemberPath } from "../src/utils/helper-tool-install.js";
import { HELPER_TOOL_RELEASES, helperToolDownloadUrl } from "../src/utils/helper-tool-releases.js";
import { ensureToolWithStatus } from "../src/utils/tools-manager.js";

const FD_SCRIPT = "#!/bin/sh\necho 'fd 10.5.0 MARKER-5343'\nexit 0\n";
const originalPath = process.env.PATH;
const work = toolState.work;
let requests: string[] = [];

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fdAsset(): string {
	const asset = HELPER_TOOL_RELEASES.fd.assetName(toolState.platform, toolState.architecture);
	if (!asset) throw new Error("unsupported test platform");
	return asset;
}

function fdArchiveDir(): string {
	return fdAsset().replace(/\.(tar\.gz|zip)$/, "");
}

function pinFd(bytes: Uint8Array): void {
	toolState.sha256.fd = { [fdAsset()]: sha256(bytes) };
}

function serve(body: Uint8Array | (() => Response)): void {
	vi.stubGlobal("fetch", async (input: unknown) => {
		requests.push(String(input));
		return typeof body === "function" ? body() : new Response(body, { status: 200 });
	});
}

function leftovers(): string[] {
	return existsSync(toolState.toolsDir) ? readdirSync(toolState.toolsDir) : [];
}

describe("ENG-5343 helper tool provisioning", () => {
	beforeEach(() => {
		rmSync(work, { recursive: true, force: true });
		toolState.platform = process.platform;
		toolState.architecture = process.arch;
		toolState.sha256 = { fd: {}, rg: {} };
		mkdirSync(toolState.toolsDir, { recursive: true });
		process.env.PATH = "/usr/bin:/bin";
		requests = [];
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(work, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")("installs a pinned asset whose digest matches", async () => {
		const archive = makeTarGz([{ name: `${fdArchiveDir()}/fd`, content: FD_SCRIPT, mode: 0o755 }]);
		pinFd(archive);
		serve(archive);

		const result = await ensureToolWithStatus("fd");

		expect(result).toEqual({ status: "available", path: join(toolState.toolsDir, "fd") });
		expect(readFileSync(join(toolState.toolsDir, "fd"), "utf8")).toBe(FD_SCRIPT);
		expect(requests).toEqual([helperToolDownloadUrl(HELPER_TOOL_RELEASES.fd, fdAsset())]);
		expect(leftovers()).toEqual(["fd"]);
	});

	it.skipIf(process.platform === "win32")("rejects a tampered archive before extracting it", async () => {
		const genuine = makeTarGz([{ name: `${fdArchiveDir()}/fd`, content: FD_SCRIPT, mode: 0o755 }]);
		const tampered = makeTarGz([
			{ name: `${fdArchiveDir()}/fd`, content: "#!/bin/sh\necho tampered-fd MARKER-5343\n", mode: 0o755 },
		]);
		pinFd(genuine);
		serve(tampered);

		const result = await ensureToolWithStatus("fd");

		expect(result).toMatchObject({
			status: "unavailable",
			reason: "download_failed",
			detail: expect.stringContaining("SHA-256 mismatch"),
		});
		expect(requests).toHaveLength(1);
		expect(leftovers()).toEqual([]);
	});

	it("refuses to download when the release has no pinned digest for this platform", async () => {
		toolState.sha256.fd = {};
		serve(new Uint8Array([1]));

		const result = await ensureToolWithStatus("fd");

		expect(result).toMatchObject({
			status: "unavailable",
			reason: "download_failed",
			detail: expect.stringContaining("No pinned SHA-256"),
		});
		expect(requests).toEqual([]);
		expect(leftovers()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("rejects tar members that escape the extraction directory", async () => {
		for (const hostile of [
			"../escaped-5343.txt",
			`${fdArchiveDir()}/../../escaped-5343.txt`,
			"/tmp/absolute-5343.txt",
		]) {
			const archive = makeTarGz([
				{ name: `${fdArchiveDir()}/fd`, content: FD_SCRIPT, mode: 0o755 },
				{ name: hostile, content: "escaped\n" },
			]);
			pinFd(archive);
			serve(archive);

			const result = await ensureToolWithStatus("fd");

			expect(result).toMatchObject({
				status: "unavailable",
				reason: "download_failed",
				detail: expect.stringMatching(/escapes the extraction directory|absolute path/),
			});
			expect(existsSync(join(work, "escaped-5343.txt"))).toBe(false);
			expect(existsSync("/tmp/absolute-5343.txt")).toBe(false);
			expect(leftovers()).toEqual([]);
		}
	});

	it.skipIf(process.platform === "win32")("rejects a binary delivered as a symlink", async () => {
		const archive = makeTarGz([{ name: `${fdArchiveDir()}/fd`, linkTarget: "/bin/sh" }]);
		pinFd(archive);
		serve(archive);

		const result = await ensureToolWithStatus("fd");

		expect(result).toMatchObject({ status: "unavailable", reason: "download_failed" });
		expect(leftovers()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("leaves nothing behind when the download is interrupted", async () => {
		const archive = makeTarGz([{ name: `${fdArchiveDir()}/fd`, content: FD_SCRIPT, mode: 0o755 }]);
		pinFd(archive);
		serve(() => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(archive.subarray(0, 16));
					controller.error(new Error("connection reset"));
				},
			});
			return new Response(stream, { status: 200 });
		});

		const result = await ensureToolWithStatus("fd");

		expect(result).toMatchObject({ status: "unavailable", reason: "download_failed" });
		expect(leftovers()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("keeps a working binary when a re-download fails verification", async () => {
		const genuine = makeTarGz([{ name: `${fdArchiveDir()}/fd`, content: FD_SCRIPT, mode: 0o755 }]);
		pinFd(genuine);
		serve(genuine);
		await expect(ensureToolWithStatus("fd")).resolves.toMatchObject({ status: "available" });

		// Break the installed binary so the next call re-downloads, then serve a tampered asset.
		rmSync(join(toolState.toolsDir, "fd"));
		serve(makeTarGz([{ name: `${fdArchiveDir()}/fd`, content: "#!/bin/sh\nexit 0\n", mode: 0o755 }]));

		await expect(ensureToolWithStatus("fd")).resolves.toMatchObject({ status: "unavailable" });
		expect(leftovers()).toEqual([]);
	});

	describe("zip assets", () => {
		const rgAsset = () => {
			const asset = HELPER_TOOL_RELEASES.rg.assetName("win32", "x64");
			if (!asset) throw new Error("unsupported test platform");
			return asset;
		};
		const RG_SCRIPT = "#!/bin/sh\nexit 0\n";

		beforeEach(() => {
			toolState.platform = "win32";
			toolState.architecture = "x64";
		});

		function pinRg(bytes: Uint8Array): void {
			toolState.sha256.rg = { [rgAsset()]: sha256(bytes) };
		}

		it.skipIf(process.platform === "win32")("installs a verified zip asset", async () => {
			const archive = makeZip([
				{ name: `${rgAsset().replace(/\.zip$/, "")}/rg.exe`, content: RG_SCRIPT, mode: 0o755 },
			]);
			pinRg(archive);
			serve(archive);

			await expect(ensureToolWithStatus("rg")).resolves.toEqual({
				status: "available",
				path: join(toolState.toolsDir, "rg.exe"),
			});
			expect(leftovers()).toEqual(["rg.exe"]);
		});

		it("rejects zip members with traversal or absolute paths", async () => {
			for (const hostile of ["../escaped-5343.txt", "/tmp/absolute-5343.txt", "C:\\escaped-5343.txt"]) {
				const archive = makeZip([
					{ name: "rg.exe", content: RG_SCRIPT, mode: 0o755 },
					{ name: hostile, content: "escaped\n" },
				]);
				pinRg(archive);
				serve(archive);

				await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
					status: "unavailable",
					reason: "download_failed",
				});
				expect(existsSync(join(work, "escaped-5343.txt"))).toBe(false);
				expect(existsSync("/tmp/absolute-5343.txt")).toBe(false);
				expect(leftovers()).toEqual([]);
			}
		});

		it("rejects zip members that are symbolic links", async () => {
			const archive = makeZip([{ name: "rg.exe", linkTarget: "/bin/sh" }]);
			pinRg(archive);
			serve(archive);

			await expect(ensureToolWithStatus("rg")).resolves.toMatchObject({
				status: "unavailable",
				reason: "download_failed",
				detail: expect.stringContaining("symbolic link"),
			});
			expect(leftovers()).toEqual([]);
		});
	});

	it("validates archive member paths", () => {
		expect(() => assertSafeArchiveMemberPath("fd-v10.5.0/fd")).not.toThrow();
		expect(() => assertSafeArchiveMemberPath("dir/../ok/../file")).toThrow(/escapes/);
		expect(() => assertSafeArchiveMemberPath("..")).toThrow(/escapes/);
		expect(() => assertSafeArchiveMemberPath("..\\evil")).toThrow(/escapes/);
		expect(() => assertSafeArchiveMemberPath("/etc/passwd")).toThrow(/absolute/);
		expect(() => assertSafeArchiveMemberPath("\\\\server\\share")).toThrow(/absolute/);
		expect(() => assertSafeArchiveMemberPath("C:/Windows/evil")).toThrow(/absolute/);
		expect(() => assertSafeArchiveMemberPath("")).toThrow(/empty/);
		expect(() => assertSafeArchiveMemberPath("a\0b")).toThrow(/NUL/);
		expect(() => assertSafeArchiveMemberPath("..hidden/file")).not.toThrow();
	});
});
