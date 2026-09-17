import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CLOUD_RESULT_DIR_MODE,
	CLOUD_RESULT_FILE_MODE,
	CLOUD_RESULT_METADATA_FILE_NAME,
	CLOUD_RESULT_PATCH_FILE_NAME,
	type CloudResultRecord,
	CloudResultStore,
	CloudResultStoreError,
	cloudResultPatchDigest,
	cloudResultPatchPaths,
	decodeCloudResultPatch,
	encodeCloudResultPatch,
} from "../src/core/cloud/result-import.js";

const isWindows = process.platform === "win32";

let tempRoot = "";
let repoRootDir = "";
let storeRootDir = "";
let plainDir = "";
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(name = "r"): string {
	const repo = join(repoRootDir, `${name}-${randomUUID().slice(0, 8)}`);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "result-test@example.com");
	git(repo, "config", "user.name", "Result Test");
	return repo;
}

function makeClone(base: string, name = "clone"): string {
	const clone = join(repoRootDir, `${name}-${randomUUID().slice(0, 8)}`);
	git(repoRootDir, "clone", "-q", base, clone);
	return clone;
}

function writeRepoFile(repo: string, relPath: string, content: string): string {
	const absPath = join(repo, ...relPath.split("/"));
	mkdirSync(dirname(absPath), { recursive: true });
	writeFileSync(absPath, content);
	return absPath;
}

function readRepoFile(repo: string, relPath: string): string {
	return readFileSync(join(repo, ...relPath.split("/")), "utf8");
}

function commitAll(repo: string, message: string): void {
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
}

/** Baseline repo with two committed files; returns the repo path. */
function makeBaseRepo(name = "base"): string {
	const repo = makeRepo(name);
	writeRepoFile(repo, "alpha.txt", "alpha line 1\nalpha line 2\nalpha line 3\n");
	writeRepoFile(repo, "beta.txt", "beta line 1\nbeta line 2\nbeta line 3\n");
	commitAll(repo, "baseline");
	return repo;
}

/** Baseline-relative patch produced by a clone of `base` after `edit` runs in it. */
function patchFromEdits(base: string, edit: (clone: string) => void): string {
	const clone = makeClone(base);
	edit(clone);
	git(clone, "add", "-N", "-A");
	return `${git(clone, "diff", "HEAD", "--no-color")}\n`;
}

function makeStore(name = "store"): { store: CloudResultStore; root: string } {
	const root = join(storeRootDir, `${name}-${randomUUID().slice(0, 8)}`);
	return { store: new CloudResultStore(root), root };
}

function saveResult(
	store: CloudResultStore,
	options: {
		sessionId?: string;
		resultId?: string;
		patch: string;
		changedPaths?: string[];
		deletedPaths?: string[];
	},
): CloudResultRecord {
	return store.save({
		sessionId: options.sessionId ?? `sess_${randomUUID()}`,
		...(options.resultId === undefined ? {} : { resultId: options.resultId }),
		patch: options.patch,
		baselineManifestDigest: cloudResultPatchDigest("baseline-manifest"),
		...(options.changedPaths === undefined ? {} : { changedPaths: options.changedPaths }),
		...(options.deletedPaths === undefined ? {} : { deletedPaths: options.deletedPaths }),
	});
}

function asStoreError(error: unknown): CloudResultStoreError {
	expect(error).toBeInstanceOf(CloudResultStoreError);
	if (!(error instanceof CloudResultStoreError)) {
		throw new Error("expected a CloudResultStoreError");
	}
	return error;
}

async function expectStoreErrorCode(
	run: () => Promise<unknown> | unknown,
	code: "invalid" | "not_found" | "conflict" | "corrupt" | "git-failed",
	message?: string,
): Promise<CloudResultStoreError> {
	try {
		await run();
	} catch (error) {
		const storeError = asStoreError(error);
		expect(storeError.code).toBe(code);
		if (message !== undefined) {
			expect(storeError.message).toContain(message);
		}
		return storeError;
	}
	throw new Error("expected the call to reject");
}

/** Add/modify/delete patch built against `makeBaseRepo`'s baseline. */
function addModifyDeletePatch(base: string): string {
	return patchFromEdits(base, (clone) => {
		writeRepoFile(clone, "added/gamma.txt", "gamma\n");
		writeRepoFile(clone, "alpha.txt", "alpha line 1\nCHANGED\nalpha line 3\n");
		git(clone, "rm", "-q", "beta.txt");
	});
}

beforeAll(() => {
	tempRoot = join(tmpdir(), `pi-result-test-${randomUUID()}`);
	repoRootDir = join(tempRoot, "repos");
	storeRootDir = join(tempRoot, "stores");
	plainDir = join(tempRoot, "plain");
	mkdirSync(repoRootDir, { recursive: true });
	mkdirSync(storeRootDir, { recursive: true });
	mkdirSync(plainDir, { recursive: true });
	const xdgHome = join(tempRoot, "xdg");
	mkdirSync(xdgHome, { recursive: true });
	const emptyGitConfig = join(tempRoot, "empty-gitconfig");
	writeFileSync(emptyGitConfig, "");
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
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("cloudResultPatchPaths", () => {
	it("extracts and sorts the repository paths a diff touches", () => {
		const patch = [
			"diff --git a/zeta.txt b/zeta.txt",
			"index 1111111..2222222 100644",
			"--- a/zeta.txt",
			"+++ b/zeta.txt",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/dir/with space.txt b/dir/with space.txt",
			"index 3333333..4444444 100644",
			"--- a/dir/with space.txt",
			"+++ b/dir/with space.txt",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		expect(cloudResultPatchPaths(patch)).toEqual(["dir/with space.txt", "zeta.txt"]);
	});

	it("rejects patches without diff headers, with quoted paths, or with escaping paths", async () => {
		await expectStoreErrorCode(() => cloudResultPatchPaths("not a diff\n"), "invalid", "no diff --git header");
		await expectStoreErrorCode(
			() => cloudResultPatchPaths('diff --git "a/quo ted" "b/quo ted"\n'),
			"invalid",
			"quoted",
		);
		await expectStoreErrorCode(
			() => cloudResultPatchPaths("diff --git a/../escape.txt b/../escape.txt\n"),
			"invalid",
			"escapes the repository",
		);
		await expectStoreErrorCode(() => cloudResultPatchPaths("diff --git a/x b/y\n"), "invalid", "sides disagree");
	});
});

describe("CloudResultStore.save", () => {
	it("persists the patch bytes and strict metadata with 0700/0600 modes", () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store, root } = makeStore();
		const sessionId = `sess_${randomUUID()}`;
		const record = saveResult(store, {
			sessionId,
			patch,
			changedPaths: ["added/gamma.txt", "alpha.txt", "beta.txt"],
			deletedPaths: [],
		});

		expect(record.version).toBe(1);
		expect(record.sessionId).toBe(sessionId);
		expect(record.state).toBe("available");
		expect(record.patchDigest).toBe(cloudResultPatchDigest(patch));
		expect(record.patchSizeBytes).toBe(Buffer.byteLength(patch, "utf8"));
		expect(record.changedPaths).toEqual(["added/gamma.txt", "alpha.txt", "beta.txt"]);

		const resultDir = join(root, sessionId, record.resultId);
		expect(readFileSync(join(resultDir, CLOUD_RESULT_PATCH_FILE_NAME), "utf8")).toBe(patch);
		const metadata = JSON.parse(readFileSync(join(resultDir, CLOUD_RESULT_METADATA_FILE_NAME), "utf8")) as {
			sessionId: string;
			env?: unknown;
			secret?: unknown;
		};
		expect(metadata.sessionId).toBe(sessionId);
		// Metadata carries ids, paths, sizes, and digests only.
		expect(metadata.env).toBeUndefined();
		expect(metadata.secret).toBeUndefined();
		expect(store.get(sessionId, record.resultId)).toEqual(record);

		if (!isWindows) {
			expect(statSync(root).mode & 0o777).toBe(CLOUD_RESULT_DIR_MODE);
			expect(statSync(join(root, sessionId)).mode & 0o777).toBe(CLOUD_RESULT_DIR_MODE);
			expect(statSync(resultDir).mode & 0o777).toBe(CLOUD_RESULT_DIR_MODE);
			expect(statSync(join(resultDir, CLOUD_RESULT_PATCH_FILE_NAME)).mode & 0o777).toBe(CLOUD_RESULT_FILE_MODE);
			expect(statSync(join(resultDir, CLOUD_RESULT_METADATA_FILE_NAME)).mode & 0o777).toBe(CLOUD_RESULT_FILE_MODE);
		}
	});

	it("normalizes unsorted manifest paths into sorted unique record paths", () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, {
			patch,
			changedPaths: ["beta.txt", "alpha.txt", "alpha.txt"],
		});
		expect(record.changedPaths).toEqual(["alpha.txt", "beta.txt"]);
	});

	it("rejects invalid ids, non-diff patches, bad digests, and invalid manifest paths", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();

		await expectStoreErrorCode(
			() => saveResult(store, { sessionId: "../escape", patch }),
			"invalid",
			"sessionId must match",
		);
		await expectStoreErrorCode(() => saveResult(store, { patch: "not a diff" }), "invalid", "patch");
		await expectStoreErrorCode(
			() =>
				store.save({
					sessionId: `sess_${randomUUID()}`,
					patch,
					baselineManifestDigest: "md5:abc",
				}),
			"invalid",
			"baselineManifestDigest",
		);
		await expectStoreErrorCode(
			() => saveResult(store, { patch, changedPaths: ["../escape.txt"] }),
			"invalid",
			"repo-relative POSIX path",
		);
		await expectStoreErrorCode(
			() => saveResult(store, { patch, changedPaths: ["not-in-patch.txt"] }),
			"invalid",
			"not touched by the patch",
		);
		await expectStoreErrorCode(
			() => saveResult(store, { patch, changedPaths: ["alpha.txt"], deletedPaths: ["alpha.txt"] }),
			"invalid",
			"both changed and deleted",
		);
	});

	it("never overwrites an existing result", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const sessionId = `sess_${randomUUID()}`;
		const resultId = `res_${randomUUID()}`;
		saveResult(store, { sessionId, resultId, patch });
		await expectStoreErrorCode(() => saveResult(store, { sessionId, resultId, patch }), "conflict", "already exists");
	});
});

describe("CloudResultStore list/get/inspect", () => {
	it("lists results across sessions, sorted, and filters by session", () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const sessionIdA = `sess_${randomUUID()}`;
		const sessionIdB = `sess_${randomUUID()}`;
		const first = saveResult(store, { sessionId: sessionIdA, patch });
		const second = saveResult(store, { sessionId: sessionIdB, patch });
		expect(store.list().length).toBe(2);
		expect(store.list(sessionIdA).map((record) => record.resultId)).toEqual([first.resultId]);
		expect(store.list().map((record) => record.resultId)).toEqual([first.resultId, second.resultId]);
		expect(store.get(sessionIdA, second.resultId)).toBeUndefined();
	});

	it("inspects a result with its patch bytes", () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		const inspected = store.inspect(record.sessionId, record.resultId);
		expect(inspected.record).toEqual(record);
		expect(inspected.patch).toBe(patch);
	});
});

describe("CloudResultStore read validation", () => {
	it("fails closed on malformed metadata and preserves the bytes for review", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		const metadataPath = join(store.directory, record.sessionId, record.resultId, CLOUD_RESULT_METADATA_FILE_NAME);
		const original = readFileSync(metadataPath, "utf8");
		writeFileSync(metadataPath, "{not json", { mode: 0o600 });

		await expectStoreErrorCode(() => store.get(record.sessionId, record.resultId), "corrupt", "not valid JSON");
		await expectStoreErrorCode(() => store.inspect(record.sessionId, record.resultId), "corrupt");
		await expectStoreErrorCode(() => store.list(), "corrupt");
		// The malformed bytes stay in place for manual review.
		expect(readFileSync(metadataPath, "utf8")).toBe("{not json");

		writeFileSync(metadataPath, original, { mode: 0o600 });
		expect(store.get(record.sessionId, record.resultId)).toEqual(record);
	});

	it("fails closed on metadata carrying unknown or invalid fields", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		const metadataPath = join(store.directory, record.sessionId, record.resultId, CLOUD_RESULT_METADATA_FILE_NAME);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
		metadata.apiKey = "sk-live";
		writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
		await expectStoreErrorCode(
			() => store.get(record.sessionId, record.resultId),
			"corrupt",
			"unexpected field: apiKey",
		);

		const broken = { ...metadata };
		delete broken.apiKey;
		broken.state = "imported";
		writeFileSync(metadataPath, JSON.stringify(broken), { mode: 0o600 });
		await expectStoreErrorCode(() => store.get(record.sessionId, record.resultId), "corrupt", "state must be one of");
	});

	it("fails closed when the patch bytes do not match the recorded size or digest", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		const patchPath = join(store.directory, record.sessionId, record.resultId, CLOUD_RESULT_PATCH_FILE_NAME);

		writeFileSync(patchPath, `${patch}extra\n`, { mode: 0o600 });
		await expectStoreErrorCode(() => store.inspect(record.sessionId, record.resultId), "corrupt", "size");

		// Same length, different bytes: only the digest check catches it.
		writeFileSync(patchPath, patch.replace("gamma", "GAMMA"), { mode: 0o600 });
		await expectStoreErrorCode(() => store.inspect(record.sessionId, record.resultId), "corrupt", "digest");
	});

	it("fails closed when metadata names a different result than its location", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const first = saveResult(store, { patch });
		const second = saveResult(store, { patch });
		const firstMetadataPath = join(store.directory, first.sessionId, first.resultId, CLOUD_RESULT_METADATA_FILE_NAME);
		const secondMetadataPath = join(
			store.directory,
			second.sessionId,
			second.resultId,
			CLOUD_RESULT_METADATA_FILE_NAME,
		);
		writeFileSync(secondMetadataPath, readFileSync(firstMetadataPath, "utf8"), { mode: 0o600 });
		await expectStoreErrorCode(() => store.get(second.sessionId, second.resultId), "corrupt", "names session");
	});

	it("fails closed when an applied record lacks appliedAt", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		const metadataPath = join(store.directory, record.sessionId, record.resultId, CLOUD_RESULT_METADATA_FILE_NAME);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
		metadata.state = "applied";
		writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
		await expectStoreErrorCode(() => store.get(record.sessionId, record.resultId), "corrupt", "appliedAt");
	});
});

describe("CloudResultStore.apply", () => {
	it("applies additions, modifications, and deletions to the working tree and records the outcome", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });

		const target = makeClone(base);
		const outcome = await store.apply(record.sessionId, record.resultId, { cwd: target });

		expect(outcome.applied).toBe(true);
		const appliedRecord = outcome.applied ? outcome.record : undefined;
		expect(appliedRecord?.state).toBe("applied");
		expect(appliedRecord?.appliedAt).toBeDefined();
		expect(appliedRecord?.lastApply?.applied).toBe(true);
		expect(appliedRecord?.lastApply?.repoRoot).toBe(realpathSync(target));
		expect(readRepoFile(target, "added/gamma.txt")).toBe("gamma\n");
		expect(readRepoFile(target, "alpha.txt")).toBe("alpha line 1\nCHANGED\nalpha line 3\n");
		expect(existsSync(join(target, "beta.txt"))).toBe(false);
		expect(store.get(record.sessionId, record.resultId)?.state).toBe("applied");

		// The outcome is durable: a fresh store over the same root still sees it.
		const reopened = new CloudResultStore(store.directory);
		expect(reopened.get(record.sessionId, record.resultId)?.state).toBe("applied");

		// Re-applying is a conflict, never a silent second overwrite.
		await expectStoreErrorCode(
			() => store.apply(record.sessionId, record.resultId, { cwd: target }),
			"conflict",
			"already applied",
		);
	});

	it("returns a rejected outcome on conflict and leaves the working tree untouched", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });

		const target = makeClone(base);
		// Conflicting local edit in the exact hunk the patch modifies.
		writeRepoFile(target, "alpha.txt", "alpha line 1\nLOCAL CONFLICT\nalpha line 3\n");

		const outcome = await store.apply(record.sessionId, record.resultId, { cwd: target });

		expect(outcome.applied).toBe(false);
		if (outcome.applied) throw new Error("expected rejection");
		expect(outcome.error).toContain("git apply --check failed");
		expect(outcome.error).toContain("alpha.txt");
		// Local edit preserved byte-for-byte; nothing else changed.
		expect(readRepoFile(target, "alpha.txt")).toBe("alpha line 1\nLOCAL CONFLICT\nalpha line 3\n");
		expect(existsSync(join(target, "added/gamma.txt"))).toBe(false);
		expect(existsSync(join(target, "beta.txt"))).toBe(true);
		expect(git(target, "status", "--porcelain")).toContain("alpha.txt");

		// The rejection is recorded but the result stays available for review.
		const stored = store.get(record.sessionId, record.resultId);
		expect(stored?.state).toBe("available");
		expect(stored?.lastApply?.applied).toBe(false);
		expect(stored?.lastApply?.error).toContain("git apply --check failed");
		// Patch and metadata remain on disk, still mode 0600.
		const resultDir = join(store.directory, record.sessionId, record.resultId);
		expect(readFileSync(join(resultDir, CLOUD_RESULT_PATCH_FILE_NAME), "utf8")).toBe(patch);
		expect(JSON.parse(readFileSync(join(resultDir, CLOUD_RESULT_METADATA_FILE_NAME), "utf8"))).toMatchObject({
			state: "available",
		});
		if (!isWindows) {
			expect(statSync(join(resultDir, CLOUD_RESULT_PATCH_FILE_NAME)).mode & 0o777).toBe(CLOUD_RESULT_FILE_MODE);
			expect(statSync(join(resultDir, CLOUD_RESULT_METADATA_FILE_NAME)).mode & 0o777).toBe(CLOUD_RESULT_FILE_MODE);
		}
	});

	it("preserves unrelated local edits when a conflicting edit rejects the apply", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });

		const target = makeClone(base);
		// beta.txt has an unrelated local edit the patch would replace only
		// after a clean check; alpha.txt conflicts with the patch hunk.
		const conflicting = "alpha line 1\nLOCAL CONFLICT\nalpha line 3\n";
		const unrelated = "beta line 1\nLOCAL UNRELATED EDIT\nbeta line 3\n";
		writeRepoFile(target, "alpha.txt", conflicting);
		writeRepoFile(target, "beta.txt", unrelated);

		const outcome = await store.apply(record.sessionId, record.resultId, { cwd: target });

		expect(outcome.applied).toBe(false);
		expect(readRepoFile(target, "alpha.txt")).toBe(conflicting);
		expect(readRepoFile(target, "beta.txt")).toBe(unrelated);
		expect(existsSync(join(target, "added/gamma.txt"))).toBe(false);
	});

	it("rejects a non-git cwd without recording an apply attempt", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });

		await expectStoreErrorCode(
			() => store.apply(record.sessionId, record.resultId, { cwd: plainDir }),
			"invalid",
			"not inside a Git repository",
		);
		const stored = store.get(record.sessionId, record.resultId);
		expect(stored?.state).toBe("available");
		expect(stored?.lastApply).toBeUndefined();
	});

	it("rejects patch paths that escape the repository before git runs", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });

		// Tamper the stored patch into an escaping one and repair the recorded
		// digest and size so the read validation passes; the apply-time path
		// check is the remaining guard.
		const escapePatch = [
			"diff --git a/../escape.txt b/../escape.txt",
			"index e69de29..8a1214a 100644",
			"--- a/../escape.txt",
			"+++ b/../escape.txt",
			"@@ -0,0 +1 @@",
			"+escaped",
		].join("\n");
		const resultDir = join(store.directory, record.sessionId, record.resultId);
		writeFileSync(join(resultDir, CLOUD_RESULT_PATCH_FILE_NAME), escapePatch, { mode: 0o600 });
		const metadataPath = join(resultDir, CLOUD_RESULT_METADATA_FILE_NAME);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
		metadata.patchDigest = cloudResultPatchDigest(escapePatch);
		metadata.patchSizeBytes = Buffer.byteLength(escapePatch, "utf8");
		writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });

		const target = makeClone(base);
		await expectStoreErrorCode(
			() => store.apply(record.sessionId, record.resultId, { cwd: target }),
			"invalid",
			"escapes the repository",
		);
		expect(existsSync(join(dirname(target), "escape.txt"))).toBe(false);
		expect(git(target, "status", "--porcelain")).toBe("");
	});

	it("rejects a store that lives inside the repository it applies into", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const inRepoStore = new CloudResultStore(join(base, "results"));
		const record = saveResult(inRepoStore, { patch });

		await expectStoreErrorCode(
			() => inRepoStore.apply(record.sessionId, record.resultId, { cwd: base }),
			"conflict",
			"outside the repository",
		);
	});

	it("reconciles a crash after git applied the patch but before metadata committed", async () => {
		const base = makeBaseRepo();
		const patch = patchFromEdits(base, (clone) => writeRepoFile(clone, "alpha.txt", "recovered\n"));
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		const target = makeClone(base);
		execFileSync("git", ["apply", "--whitespace=nowarn"], { cwd: target, input: patch });
		const metadataPath = join(store.directory, record.sessionId, record.resultId, CLOUD_RESULT_METADATA_FILE_NAME);
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as CloudResultRecord;
		metadata.lastApply = {
			at: new Date().toISOString(),
			applied: false,
			repoRoot: realpathSync(target),
			error: "apply started; recovery must reconcile the working tree",
		};
		writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);

		const outcome = await store.apply(record.sessionId, record.resultId, { cwd: target });
		expect(outcome.applied).toBe(true);
		expect(outcome.record.state).toBe("applied");
		expect(readRepoFile(target, "alpha.txt")).toBe("recovered\n");
	});

	it("serializes concurrent applies so the patch mutates the tree once", async () => {
		const base = makeBaseRepo();
		const patch = patchFromEdits(base, (clone) => writeRepoFile(clone, "alpha.txt", "once\n"));
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		const target = makeClone(base);

		const outcomes = await Promise.allSettled([
			store.apply(record.sessionId, record.resultId, { cwd: target }),
			store.apply(record.sessionId, record.resultId, { cwd: target }),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		expect(readRepoFile(target, "alpha.txt")).toBe("once\n");
	});

	it("applies into a repository from a subdirectory cwd", async () => {
		const base = makeBaseRepo();
		const patch = addModifyDeletePatch(base);
		const { store } = makeStore();
		const record = saveResult(store, { patch });

		const target = makeClone(base);
		const sub = join(target, "added");
		mkdirSync(sub, { recursive: true });
		const outcome = await store.apply(record.sessionId, record.resultId, { cwd: sub });
		expect(outcome.applied).toBe(true);
		expect(readRepoFile(target, "added/gamma.txt")).toBe("gamma\n");
	});

	it("round-trips and applies patch bytes that are not valid UTF-8", async () => {
		// git diff emits raw file bytes in text hunks, so a delegation that
		// touches a non-UTF-8 file produces a patch a strict UTF-8 decode
		// rejects; the store must keep and apply the exact bytes anyway.
		const base = makeRepo("latin1");
		writeFileSync(join(base, "latin.txt"), Buffer.from([0x61, 0xe9, 0xff, 0x0a]));
		commitAll(base, "latin baseline");
		const after = Buffer.from([0x62, 0xe9, 0xfe, 0x0a]);
		const clone = makeClone(base);
		writeFileSync(join(clone, "latin.txt"), after);
		const patchBytes = execFileSync("git", ["diff", "HEAD", "--no-color"], {
			cwd: clone,
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(() => new TextDecoder("utf-8", { fatal: true }).decode(patchBytes)).toThrow();

		const patch = decodeCloudResultPatch(patchBytes);
		const { store } = makeStore();
		const record = saveResult(store, { patch });
		expect(record.patchSizeBytes).toBe(patchBytes.byteLength);
		const inspected = store.inspect(record.sessionId, record.resultId);
		expect(encodeCloudResultPatch(inspected.patch).equals(patchBytes)).toBe(true);

		const target = makeClone(base);
		const outcome = await store.apply(record.sessionId, record.resultId, { cwd: target });
		expect(outcome.applied).toBe(true);
		expect(readFileSync(join(target, "latin.txt")).equals(after)).toBe(true);
	});
});
