import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createWorkspaceSnapshot,
	type WorkspaceSnapshot,
	type WorkspaceSnapshotManifest,
} from "../src/core/cloud/workspace-snapshot.js";
import {
	type CloudRemoteCommandRequest,
	type CloudRemoteCommandResult,
	type CloudRemoteUpload,
	type CloudRemoteUploadRequest,
	type CloudRemoteUploadResult,
	transferWorkspaceSnapshot,
	WorkspaceTransferError,
	type WorkspaceTransferOptions,
	type WorkspaceTransferProgress,
	type WorkspaceTransferSource,
} from "../src/core/cloud/workspace-transfer.js";

/**
 * A fake sandbox transport. It records every upload and argv command, can
 * fail specific operations a bounded number of times, and otherwise answers
 * exactly like the real seams: uploads echo path and size, commands exit 0.
 */
class FakeRemote {
	readonly uploads: Array<{ path: string; filename: string; content: Buffer }> = [];
	readonly uploadAttempts = new Map<string, number>();
	readonly commands: Array<{ argv: string[] }> = [];
	readonly execAttempts = new Map<string, number>();
	uploadFailuresRemaining = new Map<string, number>();
	execFailuresRemaining = new Map<string, number>();

	readonly upload = {
		uploadFile: async (request: CloudRemoteUploadRequest): Promise<CloudRemoteUploadResult> => {
			const path = request.path;
			this.uploadAttempts.set(path, (this.uploadAttempts.get(path) ?? 0) + 1);
			const failures = this.uploadFailuresRemaining.get(path) ?? 0;
			if (failures > 0) {
				this.uploadFailuresRemaining.set(path, failures - 1);
				throw new Error(`transient upload failure for ${path}`);
			}
			const content = Buffer.from(request.content);
			this.uploads.push({ path, filename: request.filename, content });
			return { path, size: content.byteLength };
		},
	};

	readonly command = {
		exec: async (request: CloudRemoteCommandRequest): Promise<CloudRemoteCommandResult> => {
			const key = request.argv.join(" ");
			this.execAttempts.set(key, (this.execAttempts.get(key) ?? 0) + 1);
			const failures = this.execFailuresRemaining.get(key) ?? 0;
			if (failures > 0) {
				this.execFailuresRemaining.set(key, failures - 1);
				return { stdout: "", stderr: "transient command failure", exitCode: 1 };
			}
			this.commands.push({ argv: [...request.argv] });
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	};

	uploadPaths(): string[] {
		return this.uploads.map((upload) => upload.path);
	}

	commandArgv(): string[][] {
		return this.commands.map((command) => command.argv);
	}
}

const REMOTE_DIR = "/transfer";
const REMOTE_WORKSPACE = "/transfer/workspace";
const REMOTE_MANIFEST = "/transfer/workspace-manifest.json";

let tempRoot = "";
let stagingRoot = "";
const savedEnv: Record<string, string | undefined> = {};
const trackedSnapshots: WorkspaceSnapshot[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(name = "r"): string {
	const repo = fs.mkdtempSync(join(tempRoot, `${name}-`));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "transfer-test@example.com");
	git(repo, "config", "user.name", "Transfer Test");
	return repo;
}

function writeRepoFile(repo: string, relPath: string, content: string, mode?: number): string {
	const absPath = join(repo, ...relPath.split("/"));
	fs.mkdirSync(dirname(absPath), { recursive: true });
	fs.writeFileSync(absPath, content);
	if (mode !== undefined) {
		fs.chmodSync(absPath, mode);
	}
	return absPath;
}

function makeSymlink(repo: string, linkRelPath: string, target: string): void {
	const absPath = join(repo, ...linkRelPath.split("/"));
	fs.mkdirSync(dirname(absPath), { recursive: true });
	fs.symlinkSync(target, absPath);
}

function commitAll(repo: string, message: string): void {
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
}

function sha256(content: Uint8Array | string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function snapshot(repo: string): Promise<WorkspaceSnapshot> {
	const snap = await createWorkspaceSnapshot(repo, { stagingRoot });
	trackedSnapshots.push(snap);
	return snap;
}

function fakeSleep(): { sleeps: number[]; sleepFn: (ms: number) => Promise<void> } {
	const sleeps: number[] = [];
	return {
		sleeps,
		sleepFn: async (ms: number) => {
			sleeps.push(ms);
		},
	};
}

/** Run a transfer that must fail and return the typed error. */
async function transferError(source: WorkspaceTransferSource, options: unknown = {}): Promise<WorkspaceTransferError> {
	const remote = new FakeRemote();
	const defaults: WorkspaceTransferOptions = {
		upload: remote.upload,
		command: remote.command,
		remoteDir: REMOTE_DIR,
		sleepFn: async () => {},
	};
	try {
		await transferWorkspaceSnapshot(source, {
			...defaults,
			...(options as Partial<WorkspaceTransferOptions>),
		});
	} catch (error) {
		expect(error).toBeInstanceOf(WorkspaceTransferError);
		if (!(error instanceof WorkspaceTransferError)) {
			throw new Error("expected a WorkspaceTransferError");
		}
		return error;
	}
	throw new Error("expected transferWorkspaceSnapshot to reject");
}

function transferOptions(
	remote: FakeRemote,
	options: Partial<WorkspaceTransferOptions> = {},
): WorkspaceTransferOptions {
	return { upload: remote.upload, command: remote.command, remoteDir: REMOTE_DIR, ...options };
}

function repoWithContent(): { repo: string; files: Record<string, string> } {
	const repo = makeRepo();
	writeRepoFile(repo, "docs/readme.md", "readme\n");
	writeRepoFile(repo, "scripts/run.sh", "echo run\n", 0o755);
	makeSymlink(repo, "docs/link-to-readme", "../docs/readme.md");
	writeRepoFile(repo, "staged.txt", "staged\n");
	commitAll(repo, "init");
	writeRepoFile(repo, "dirty.txt", "dirty\n");
	writeRepoFile(repo, "untracked.txt", "untracked\n");
	return {
		repo,
		files: {
			"docs/readme.md": "readme\n",
			"scripts/run.sh": "echo run\n",
			"docs/link-to-readme": "../docs/readme.md",
			"staged.txt": "staged\n",
			"dirty.txt": "dirty\n",
			"untracked.txt": "untracked\n",
		},
	};
}

beforeAll(() => {
	tempRoot = fs.mkdtempSync(join(tmpdir(), "pi-transfer-test-"));
	stagingRoot = join(tempRoot, "staging");
	fs.mkdirSync(stagingRoot, { recursive: true });
	const xdgHome = join(tempRoot, "xdg");
	fs.mkdirSync(xdgHome, { recursive: true });
	const emptyGitConfig = join(tempRoot, "empty-gitconfig");
	fs.writeFileSync(emptyGitConfig, "");
	// Isolate every git invocation (test helpers and module spawns alike) from
	// host git config and global ignore files.
	for (const [key, value] of Object.entries({
		GIT_CONFIG_GLOBAL: emptyGitConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		XDG_CONFIG_HOME: xdgHome,
	})) {
		savedEnv[key] = process.env[key];
		process.env[key] = value;
	}
});

afterAll(() => {
	for (const snap of trackedSnapshots) {
		snap.cleanup();
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("transferWorkspaceSnapshot", () => {
	it("uploads every captured file, reconstructs symlinks, and uploads the manifest last", async () => {
		const { repo, files } = repoWithContent();
		const snap = await snapshot(repo);
		const remote = new FakeRemote();
		const events: WorkspaceTransferProgress[] = [];
		const { sleepFn } = fakeSleep();

		const result = await transferWorkspaceSnapshot(snap, {
			...transferOptions(remote, { sleepFn }),
			onProgress: (event) => events.push(event),
		});

		expect(result.remoteDir).toBe(REMOTE_DIR);
		expect(result.remoteWorkspaceDir).toBe(REMOTE_WORKSPACE);
		expect(result.remoteManifestPath).toBe(REMOTE_MANIFEST);
		expect(result.manifestDigest).toBe(snap.manifestDigest);
		expect(result.uploadedFiles).toBe(5);
		expect(result.uploadedSymlinks).toBe(1);

		const uploadPaths = remote.uploadPaths();
		expect(uploadPaths).toContain(`${REMOTE_WORKSPACE}/docs/readme.md`);
		expect(uploadPaths).toContain(`${REMOTE_WORKSPACE}/scripts/run.sh`);
		expect(uploadPaths).toContain(`${REMOTE_WORKSPACE}/staged.txt`);
		expect(uploadPaths).toContain(`${REMOTE_WORKSPACE}/dirty.txt`);
		expect(uploadPaths).toContain(`${REMOTE_WORKSPACE}/untracked.txt`);
		expect(uploadPaths).not.toContain(`${REMOTE_WORKSPACE}/docs/link-to-readme`);
		expect(uploadPaths[uploadPaths.length - 1]).toBe(REMOTE_MANIFEST);
		expect(remote.uploads.filter((upload) => upload.path === REMOTE_MANIFEST)).toHaveLength(1);

		for (const upload of remote.uploads) {
			const relPath = upload.path === REMOTE_MANIFEST ? null : upload.path.slice(REMOTE_WORKSPACE.length + 1);
			const expected = relPath === null ? null : files[relPath];
			if (expected !== null && expected !== undefined) {
				expect(upload.content.toString("utf8"), upload.path).toBe(expected);
			}
		}
		const manifestUpload = remote.uploads.find((upload) => upload.path === REMOTE_MANIFEST);
		expect(manifestUpload?.content.toString("utf8")).toBe(
			fs.readFileSync(join(snap.stagingDir, "workspace-manifest.json"), "utf8"),
		);
		expect(manifestUpload?.filename).toBe("workspace-manifest.json");

		const argvs = remote.commandArgv();
		for (const argv of argvs) {
			expect(argv[0]).not.toBe("sh");
			expect(argv.length).toBeGreaterThan(1);
		}
		const mkdirCalls = argvs.filter((argv) => argv[0] === "mkdir" && argv[1] === "-p");
		expect(mkdirCalls.length).toBeGreaterThan(0);
		for (const call of mkdirCalls) {
			expect(call.slice(2).every((path) => path.startsWith(`${REMOTE_WORKSPACE}/`))).toBe(true);
		}
		expect(
			argvs.find(
				(argv) => argv[0] === "ln" && argv[1] === "-sfn" && argv[3] === `${REMOTE_WORKSPACE}/docs/link-to-readme`,
			),
		).toEqual(["ln", "-sfn", "../docs/readme.md", `${REMOTE_WORKSPACE}/docs/link-to-readme`]);
		expect(argvs.find((argv) => argv[0] === "chmod" && argv[2] === `${REMOTE_WORKSPACE}/scripts/run.sh`)).toEqual([
			"chmod",
			"755",
			`${REMOTE_WORKSPACE}/scripts/run.sh`,
		]);
		const chmodCalls = argvs.filter((argv) => argv[0] === "chmod");
		expect(chmodCalls).toHaveLength(1);

		expect(events[0]?.kind).toBe("mkdir");
		expect(events[events.length - 1]?.kind).toBe("manifest");
		const fileEvents = events.filter((event) => event.kind === "file");
		expect(fileEvents).toHaveLength(5);
		expect(events.filter((event) => event.kind === "symlink")).toHaveLength(1);
	});

	it("bounds concurrent uploads to the configured concurrency", async () => {
		const repo = makeRepo();
		for (let index = 0; index < 6; index++) {
			writeRepoFile(repo, `d${index}/f.txt`, `content-${index}\n`);
		}
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		let inFlight = 0;
		let peak = 0;
		const upload: CloudRemoteUpload = {
			uploadFile: async (request: CloudRemoteUploadRequest): Promise<CloudRemoteUploadResult> => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				try {
					await new Promise<void>((resolve) => {
						setTimeout(resolve, 5);
					});
					return await remote.upload.uploadFile(request);
				} finally {
					inFlight -= 1;
				}
			},
		};

		const result = await transferWorkspaceSnapshot(snap, {
			upload,
			command: remote.command,
			remoteDir: REMOTE_DIR,
			concurrency: 2,
			sleepFn: async () => {},
		});

		expect(peak).toBe(2);
		expect(result.uploadedFiles).toBe(6);
		expect(remote.uploads.length).toBe(7);
	});

	it("retries a transient upload failure and then succeeds", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		writeRepoFile(repo, "b.txt", "two\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		remote.uploadFailuresRemaining.set(`${REMOTE_WORKSPACE}/a.txt`, 2);
		const { sleeps, sleepFn } = fakeSleep();

		const result = await transferWorkspaceSnapshot(snap, {
			...transferOptions(remote, { attempts: 3, sleepFn }),
		});

		expect(result.uploadedFiles).toBe(2);
		expect(remote.uploadAttempts.get(`${REMOTE_WORKSPACE}/a.txt`)).toBe(3);
		expect(remote.uploadAttempts.get(`${REMOTE_WORKSPACE}/b.txt`)).toBe(1);
		expect(remote.uploadAttempts.get(REMOTE_MANIFEST)).toBe(1);
		expect(remote.uploadPaths().length).toBe(3);
		expect(sleeps).toEqual([250, 250]);
	});

	it("retries a transient argv command failure and then succeeds", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		const mkdirKey = ["mkdir", "-p", REMOTE_WORKSPACE].join(" ");
		remote.execFailuresRemaining.set(mkdirKey, 1);
		const { sleepFn } = fakeSleep();

		await transferWorkspaceSnapshot(snap, { ...transferOptions(remote, { attempts: 2, sleepFn }) });

		expect(remote.execAttempts.get(mkdirKey) ?? 0).toBe(2);
		expect(remote.uploadPaths()).toEqual([`${REMOTE_WORKSPACE}/a.txt`, REMOTE_MANIFEST]);
	});

	it("fails with upload-failed and skips the manifest upload after exhausting attempts", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		remote.uploadFailuresRemaining.set(`${REMOTE_WORKSPACE}/a.txt`, 99);
		const { sleepFn } = fakeSleep();
		const error = await transferError(snap, { attempts: 2, sleepFn, command: remote.command, upload: remote.upload });

		expect(error.code).toBe("upload-failed");
		expect(remote.uploadPaths()).not.toContain(REMOTE_MANIFEST);
		expect(remote.uploadAttempts.get(`${REMOTE_WORKSPACE}/a.txt`)).toBe(2);
	});

	it("fails with remote-command-failed when mkdir keeps failing", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		remote.execFailuresRemaining.set(["mkdir", "-p", REMOTE_WORKSPACE].join(" "), 99);
		const { sleepFn } = fakeSleep();
		const error = await transferError(snap, { attempts: 2, sleepFn, command: remote.command, upload: remote.upload });

		expect(error.code).toBe("remote-command-failed");
		expect(remote.uploads).toHaveLength(0);
	});

	it("never uploads a staged file whose bytes no longer match the manifest", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		fs.writeFileSync(join(snap.stagingDir, "workspace", "a.txt"), "TWO\n");

		const remote = new FakeRemote();
		const error = await transferError(snap, { command: remote.command, upload: remote.upload });

		expect(error.code).toBe("staging-error");
		expect(error.message).toContain("a.txt");
		expect(remote.uploads).toHaveLength(0);
		expect(remote.commandArgv()).toHaveLength(0);
	});

	it("never reconstructs a staged symlink whose target changed after capture", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		makeSymlink(repo, "link", "a.txt");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		fs.rmSync(join(snap.stagingDir, "workspace", "link"));
		fs.symlinkSync("elsewhere.txt", join(snap.stagingDir, "workspace", "link"));

		const remote = new FakeRemote();
		const error = await transferError(snap, { command: remote.command, upload: remote.upload });

		expect(error.code).toBe("staging-error");
		expect(error.message).toContain("link");
		expect(remote.commandArgv().some((argv) => argv[0] === "ln")).toBe(false);
	});

	it("rejects a tampered staged manifest", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const manifestFile = join(snap.stagingDir, "workspace-manifest.json");
		const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
			manifest: { entries: Array<Record<string, unknown>> };
		};
		const firstEntry = parsed.manifest.entries[0];
		if (firstEntry === undefined) {
			throw new Error("expected the staged manifest to have an entry");
		}
		firstEntry.size = 9999;
		fs.writeFileSync(manifestFile, JSON.stringify(parsed, null, "\t"));

		const remote = new FakeRemote();
		const error = await transferError(snap, { command: remote.command, upload: remote.upload });

		expect(error.code).toBe("invalid-manifest");
		expect(remote.uploads).toHaveLength(0);
	});

	it("rejects a hostile manifest before any remote call", async () => {
		const { repo } = repoWithContent();
		const snap = await snapshot(repo);
		const hostile = JSON.parse(JSON.stringify(snap.manifest)) as WorkspaceSnapshotManifest;
		hostile.entries.push({
			path: "../escape.txt",
			kind: "file",
			mode: "100644",
			executable: false,
			size: 3,
			sha256: sha256("bad"),
			tracked: false,
		});

		const remote = new FakeRemote();
		const error = await transferError(
			{ stagingDir: snap.stagingDir, manifest: hostile, manifestDigest: snap.manifestDigest },
			{ command: remote.command, upload: remote.upload },
		);

		expect(error.code).toBe("invalid-manifest");
		expect(error.message).toContain("normal components");
		expect(remote.uploads).toHaveLength(0);
		expect(remote.commandArgv()).toHaveLength(0);
	});

	it("rejects symlink entries with absolute or escaping targets", async () => {
		const cases: Array<{ target: string; linkPath: string; problem: string }> = [
			{ target: "/etc/passwd", linkPath: "link", problem: "relative" },
			{ target: "../../outside.txt", linkPath: "sub/link", problem: "escapes" },
			{ target: "a//b.txt", linkPath: "link", problem: "empty" },
		];
		for (const { target, linkPath, problem } of cases) {
			const manifest: WorkspaceSnapshotManifest = {
				version: 1,
				entries: [
					{
						path: linkPath,
						kind: "symlink",
						mode: "120000",
						executable: false,
						size: Buffer.byteLength(target, "utf8"),
						sha256: sha256(target),
						target,
						tracked: false,
					},
				],
				deletedPaths: [],
			};
			const remote = new FakeRemote();
			const error = await transferError(
				{ stagingDir: "/nonexistent-staging", manifest, manifestDigest: "0".repeat(64) },
				{ command: remote.command, upload: remote.upload },
			);
			expect(error.code, `case ${problem}`).toBe("invalid-manifest");
			expect(error.message, `case ${problem}`).toContain(problem === "empty" ? "empty" : problem);
			expect(remote.uploads).toHaveLength(0);
		}
	});

	it("reconstructs a symlink whose relative target climbs with .. as long as it stays inside", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "target.txt", "t\n");
		makeSymlink(repo, "sub/climber", "../target.txt");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		await transferWorkspaceSnapshot(snap, transferOptions(remote, { sleepFn: async () => {} }));

		expect(remote.commandArgv().find((argv) => argv[0] === "ln")).toEqual([
			"ln",
			"-sfn",
			"../target.txt",
			`${REMOTE_WORKSPACE}/sub/climber`,
		]);
	});

	it("chunks mkdir argv calls", async () => {
		const repo = makeRepo();
		for (let index = 0; index < 150; index++) {
			writeRepoFile(repo, `d${index}/f.txt`, `${index}\n`);
		}
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		await transferWorkspaceSnapshot(snap, transferOptions(remote, { sleepFn: async () => {} }));

		const mkdirCalls = remote.commandArgv().filter((argv) => argv[0] === "mkdir");
		expect(mkdirCalls.length).toBe(2);
		expect(mkdirCalls[0]?.length ?? 0).toBeLessThanOrEqual(130);
		expect(mkdirCalls[1]?.length ?? 0).toBeLessThanOrEqual(130);
		const allDirs = mkdirCalls.flatMap((call) => call.slice(2));
		expect(allDirs.length).toBe(150);
		expect(new Set(allDirs).size).toBe(150);
		for (const dir of allDirs) {
			expect(dir.startsWith(REMOTE_WORKSPACE)).toBe(true);
		}
	});

	it("aborts before any work when the signal is already aborted", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		const controller = new AbortController();
		controller.abort();
		const error = await transferError(snap, {
			signal: controller.signal,
			command: remote.command,
			upload: remote.upload,
		});

		expect(error.code).toBe("aborted");
		expect(remote.uploads).toHaveLength(0);
		expect(remote.commandArgv()).toHaveLength(0);
	});

	it("aborts a running transfer and never uploads the manifest", async () => {
		const repo = makeRepo();
		for (let index = 0; index < 4; index++) {
			writeRepoFile(repo, `d${index}/f.txt`, `${index}\n`);
		}
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const remote = new FakeRemote();
		const controller = new AbortController();
		let error: WorkspaceTransferError | undefined;
		const transfer = transferWorkspaceSnapshot(snap, {
			...transferOptions(remote, { sleepFn: async () => {} }),
			signal: controller.signal,
			onProgress: (event) => {
				if (event.kind === "file") {
					controller.abort();
				}
			},
		}).catch((caught: unknown) => {
			error = caught as WorkspaceTransferError;
		});
		await transfer;

		expect(error).toBeInstanceOf(WorkspaceTransferError);
		expect((error as WorkspaceTransferError).code).toBe("aborted");
		expect(remote.uploadPaths()).not.toContain(REMOTE_MANIFEST);
	});

	it("rejects invalid options", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);
		const remote = new FakeRemote();

		const badOptions: unknown[] = [
			{ remoteDir: "workspace" },
			{ remoteDir: "/transfer/" },
			{ remoteDir: "/transfer/../workspace" },
			{ remoteDir: "/" },
			{ concurrency: 0 },
			{ attempts: 0 },
			{ execTimeoutSeconds: 901 },
			{ upload: {} },
			{ command: {} },
			{ isRetryable: "yes" },
		];
		for (const override of badOptions) {
			const error = await transferError(snap, override);
			expect(error.code, JSON.stringify(override)).toBe("invalid-options");
		}

		const badSource = await transferError(
			{ stagingDir: snap.stagingDir, manifest: snap.manifest, manifestDigest: "not-a-digest" },
			{ command: remote.command, upload: remote.upload },
		);
		expect(badSource.code).toBe("invalid-options");
		expect(remote.uploads).toHaveLength(0);
	});

	it("validates the source manifest digest format and requires the staged file to match it", async () => {
		const repo = makeRepo();
		writeRepoFile(repo, "a.txt", "one\n");
		commitAll(repo, "init");
		const snap = await snapshot(repo);

		const tamperedManifest = JSON.parse(
			fs.readFileSync(join(snap.stagingDir, "workspace-manifest.json"), "utf8"),
		) as { manifest: unknown };
		const tamperedDigest = createHash("sha256").update(JSON.stringify(tamperedManifest)).digest("hex");
		const remote = new FakeRemote();
		const error = await transferError(
			{ stagingDir: snap.stagingDir, manifest: snap.manifest, manifestDigest: tamperedDigest },
			{ command: remote.command, upload: remote.upload },
		);
		expect(error.code).toBe("invalid-manifest");
		expect(remote.uploads).toHaveLength(0);
	});
});
