import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionLease from "../src/core/session-lease.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
	type RlmLedgerRecord,
	type RlmLedgerSpawnRecord,
	RlmSpawnLedger,
	tombstoneSavedSessionDelete,
	withPassiveRlmDescendantInfos,
} from "../src/modes/daemon/rlm-ledger.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "prime-ledger-canonicalization-")));
	tempDirs.push(root);
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir);
	return { root, sessionsDir, ledger: new RlmSpawnLedger(root, sessionsDir) };
}

function makeSession(root: string, directory: string, name: string, parent?: string): string {
	const manager = SessionManager.create(root, directory);
	manager.newSession(parent ? { parentSession: parent, rlmDepth: 1 } : {});
	manager.appendSessionInfo(name);
	manager.flushNow();
	const path = manager.getSessionFile();
	if (!path) throw new Error("Missing session file");
	return path;
}

function savedInfo(path: string): SessionInfo {
	return {
		path,
		id: basename(path, ".jsonl"),
		cwd: "",
		rlmDepth: 0,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

function spawn(parent: string, child: string, childId = "sub-worker"): RlmLedgerSpawnRecord {
	return { v: 1, op: "spawn", at: new Date(0).toISOString(), childId, parent, child, depth: 1, name: childId };
}

function writeRecords(ledger: RlmSpawnLedger, records: RlmLedgerRecord[]): void {
	mkdirSync(dirname(ledger.ledgerPath), { recursive: true });
	writeFileSync(ledger.ledgerPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

function lastRecord(ledger: RlmSpawnLedger): RlmLedgerRecord {
	return JSON.parse(readFileSync(ledger.ledgerPath, "utf8").trim().split("\n").at(-1)!) as RlmLedgerRecord;
}

describe("RLM ledger read-side canonicalization", () => {
	it.each(["existing", "missing file", "missing directory", "file symlink", "directory symlink"])(
		"preserves replay identities and caches %s outcomes",
		async (kind) => {
			const { root, sessionsDir, ledger } = fixture();
			const parent = join(sessionsDir, "parent.jsonl");
			const directory = join(root, "real");
			mkdirSync(directory);
			writeFileSync(parent, "");
			const existing = join(directory, "child.jsonl");
			writeFileSync(existing, "");
			const directoryAlias = join(root, "directory-alias");
			symlinkSync(directory, directoryAlias, "dir");
			const fileAlias = join(root, "file-alias.jsonl");
			symlinkSync(existing, fileAlias, "file");
			const paths: Record<string, string> = {
				existing,
				"missing file": join(directoryAlias, "missing.jsonl"),
				"missing directory": join(root, "missing-directory", "child.jsonl"),
				"file symlink": fileAlias,
				"directory symlink": join(directoryAlias, "child.jsonl"),
			};
			const child = paths[kind];
			const canonical = sessionLease.canonicalSessionPath(child);
			expect(canonical).toBe(
				kind === "missing file"
					? join(directory, "missing.jsonl")
					: kind === "missing directory"
						? resolve(child)
						: existing,
			);
			writeRecords(ledger, [
				spawn(parent, child),
				{ v: 1, op: "rename", at: "renamed", childId: "sub-worker", child: canonical, name: "renamed" },
			]);
			const canonicalize = vi.spyOn(sessionLease, "canonicalSessionPath");
			const expected = [{ childId: "sub-worker", parent, child, depth: 1, name: "renamed" }];
			expect(await ledger.edges()).toEqual(expected);
			expect(canonicalize).toHaveBeenCalledTimes(new Set([resolve(child), canonical]).size);
			const live = kind.startsWith("missing") ? [] : expected;
			expect(await ledger.liveEdges()).toEqual(live);
			canonicalize.mockClear();
			expect(await ledger.edges()).toEqual(expected);
			expect(await ledger.liveEdges()).toEqual(live);
			expect(canonicalize).not.toHaveBeenCalled();
		},
	);

	it("reuses warm identities across family, siblings, and passive descendant reads", async () => {
		const { root, sessionsDir, ledger } = fixture();
		const parent = makeSession(root, sessionsDir, "parent");
		const first = makeSession(root, join(root, "first"), "first", parent);
		const second = makeSession(root, join(root, "second"), "second", parent);
		const parentAlias = join(root, "parent-alias.jsonl");
		const firstAlias = join(root, "first-alias.jsonl");
		const secondDirectoryAlias = join(root, "second-alias");
		symlinkSync(parent, parentAlias, "file");
		symlinkSync(first, firstAlias, "file");
		symlinkSync(dirname(second), secondDirectoryAlias, "dir");
		const secondAlias = join(secondDirectoryAlias, basename(second));
		writeRecords(ledger, [
			spawn(parentAlias, firstAlias, "sub-first"),
			spawn(parentAlias, secondAlias, "sub-second"),
			spawn(parentAlias, join(root, "missing.jsonl"), "sub-missing-file"),
			spawn(parentAlias, join(root, "missing-directory", "child.jsonl"), "sub-missing-directory"),
		]);
		const parentInfo = await readSessionInfo(parent);
		const firstInfo = await readSessionInfo(first);
		if (!parentInfo || !firstInfo) throw new Error("Missing session info");
		const saved = [parentInfo, { ...firstInfo, path: firstAlias }];
		const canonicalize = vi.spyOn(sessionLease, "canonicalSessionPath");
		const snapshot = async () => ({
			edges: await ledger.edges(),
			live: await ledger.liveEdges(),
			family: await ledger.family(),
			siblings: await ledger.siblings(firstAlias),
			roots: await ledger.siblings(parentAlias),
			passive: await withPassiveRlmDescendantInfos(saved, ledger),
		});
		const cold = await snapshot();
		expect(cold.edges).toHaveLength(4);
		expect(cold.live).toHaveLength(2);
		expect(cold.family.map((row) => [row.path, row.rlmDepth, row.parentSessionPath])).toEqual([
			[parent, 0, undefined],
			[first, 1, parent],
			[second, 1, parent],
		]);
		expect(cold.siblings.map((row) => row.path)).toEqual([first, second]);
		expect(cold.roots.map((row) => row.path)).toEqual([parent]);
		expect(cold.passive.map((row) => row.path)).toEqual([parent, firstAlias, second]);
		expect(cold.passive[2]).toMatchObject({ parentSessionPath: parentAlias, rlmDepth: 1 });
		expect(canonicalize).toHaveBeenCalled();
		canonicalize.mockClear();
		expect(await snapshot()).toEqual(cold);
		expect(canonicalize).not.toHaveBeenCalled();
	});

	it.each([false, true])("expires a cached identity at 60 seconds without sliding (existing: %s)", async (exists) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.UTC(2030, 0, 1);
		vi.setSystemTime(start);
		const { root, ledger } = fixture();
		const original = makeSession(root, join(root, "original"), "original");
		const replacement = makeSession(root, join(root, "replacement"), "replacement");
		const alias = join(root, "alias.jsonl");
		if (exists) symlinkSync(original, alias, "file");
		const canonicalize = vi.spyOn(sessionLease, "canonicalSessionPath");
		expect((await ledger.siblings(alias)).map((row) => row.path)).toEqual(exists ? [original] : []);
		expect(canonicalize).toHaveBeenCalledOnce();
		if (exists) rmSync(alias);
		symlinkSync(replacement, alias, "file");
		for (const elapsed of [30_000, 59_999]) {
			vi.setSystemTime(start + elapsed);
			expect((await ledger.siblings(alias)).map((row) => row.path)).toEqual([exists ? original : alias]);
		}
		expect(canonicalize).toHaveBeenCalledOnce();
		vi.setSystemTime(start + 60_000);
		expect((await ledger.siblings(alias)).map((row) => row.path)).toEqual([replacement]);
		expect(canonicalize).toHaveBeenCalledTimes(2);
	});

	it("bounds the cache at 4096 entries and promotes recently read entries", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { root, ledger } = fixture();
		const rows = Array.from({ length: 4096 }, (_, index) => savedInfo(join(root, `missing-${index}.jsonl`)));
		const canonicalize = vi.spyOn(sessionLease, "canonicalSessionPath");
		expect(await withPassiveRlmDescendantInfos(rows, ledger)).toEqual(rows);
		expect(canonicalize).toHaveBeenCalledTimes(4096);
		canonicalize.mockClear();
		await withPassiveRlmDescendantInfos([rows[0]], ledger);
		expect(canonicalize).not.toHaveBeenCalled();
		const extra = savedInfo(join(root, "overflow.jsonl"));
		await withPassiveRlmDescendantInfos([extra], ledger);
		expect(canonicalize).toHaveBeenCalledExactlyOnceWith(extra.path);
		canonicalize.mockClear();
		await withPassiveRlmDescendantInfos([rows[0], rows[2], rows[4095]], ledger);
		expect(canonicalize).not.toHaveBeenCalled();
		await withPassiveRlmDescendantInfos([rows[1]], ledger);
		expect(canonicalize).toHaveBeenCalledExactlyOnceWith(rows[1].path);
	});

	it("shares resolved keys without conflating relative paths from different working directories", async () => {
		const { root, ledger } = fixture();
		const first = makeSession(root, join(root, "first"), "first");
		const second = makeSession(root, join(root, "second"), "second");
		const firstAlias = join(dirname(first), "alias.jsonl");
		const secondAlias = join(dirname(second), "alias.jsonl");
		symlinkSync(first, firstAlias, "file");
		symlinkSync(second, secondAlias, "file");
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(dirname(first));
		const canonicalize = vi.spyOn(sessionLease, "canonicalSessionPath");
		expect((await ledger.siblings("alias.jsonl")).map((row) => row.path)).toEqual([first]);
		expect((await ledger.siblings(firstAlias)).map((row) => row.path)).toEqual([first]);
		expect((await ledger.siblings("./alias.jsonl")).map((row) => row.path)).toEqual([first]);
		expect(canonicalize).toHaveBeenCalledExactlyOnceWith(firstAlias);
		cwd.mockReturnValue(dirname(second));
		expect((await ledger.siblings("alias.jsonl")).map((row) => row.path)).toEqual([second]);
		expect(canonicalize).toHaveBeenLastCalledWith(secondAlias);
		cwd.mockReturnValue(dirname(first));
		expect((await ledger.siblings("alias.jsonl")).map((row) => row.path)).toEqual([first]);
		expect(canonicalize).toHaveBeenCalledTimes(2);
	});

	it("tombstones every matching edge through a warm cached alias", async () => {
		const { root, sessionsDir, ledger } = fixture();
		const parent = makeSession(root, sessionsDir, "parent");
		const child = makeSession(root, join(root, "child"), "child", parent);
		const alias = join(root, "child-alias.jsonl");
		symlinkSync(child, alias, "file");
		writeRecords(ledger, [spawn(parent, alias, "sub-first"), spawn(parent, child, "sub-duplicate")]);
		await ledger.siblings(alias);
		const canonicalize = vi.spyOn(sessionLease, "canonicalSessionPath");
		const result = await tombstoneSavedSessionDelete(ledger, alias, { runtimeKind: "subagent" });
		expect(result.deletedInfo?.path).toBe(alias);
		expect(result.ledgerEdge).toMatchObject({ childId: "sub-first", child: alias });
		expect(await ledger.edges()).toEqual([]);
		expect(await ledger.edges(true)).toEqual([
			expect.objectContaining({ childId: "sub-first", deleted: "user" }),
			expect.objectContaining({ childId: "sub-duplicate", deleted: "user" }),
		]);
		// Destructive matching and both appendDelete writes bypass the warm read cache.
		expect(canonicalize.mock.calls).toEqual([[alias], [alias], [child], [alias], [child]]);
	});

	it("matches the current symlink target for deletion despite a warm read identity", async () => {
		const { root, sessionsDir, ledger } = fixture();
		const parent = makeSession(root, sessionsDir, "parent");
		const first = makeSession(root, join(root, "first"), "first", parent);
		const second = makeSession(root, join(root, "second"), "second", parent);
		const alias = join(root, "child-alias.jsonl");
		symlinkSync(first, alias, "file");
		writeRecords(ledger, [spawn(parent, first, "sub-first"), spawn(parent, second, "sub-second")]);
		await ledger.siblings(alias);
		rmSync(alias);
		symlinkSync(second, alias, "file");

		const result = await tombstoneSavedSessionDelete(ledger, alias, { runtimeKind: "subagent" });
		expect(result.ledgerEdge).toMatchObject({ childId: "sub-second", child: second });
		expect(await ledger.edges()).toEqual([
			{ childId: "sub-first", parent, child: first, depth: 1, name: "sub-first" },
		]);
		expect(await ledger.edges(true)).toEqual([
			{ childId: "sub-first", parent, child: first, depth: 1, name: "sub-first" },
			expect.objectContaining({ childId: "sub-second", child: second, deleted: "user" }),
		]);
	});

	it("tombstones the original canonical path after its warmed alias points elsewhere", async () => {
		const { root, sessionsDir, ledger } = fixture();
		const parent = makeSession(root, sessionsDir, "parent");
		const first = makeSession(root, join(root, "first"), "first", parent);
		const second = makeSession(root, join(root, "second"), "second", parent);
		const alias = join(root, "child-alias.jsonl");
		symlinkSync(first, alias, "file");
		writeRecords(ledger, [spawn(parent, first, "sub-first"), spawn(parent, second, "sub-second")]);
		await ledger.siblings(alias);
		rmSync(alias);
		symlinkSync(second, alias, "file");

		const result = await tombstoneSavedSessionDelete(ledger, first, { runtimeKind: "subagent" });
		expect(result.ledgerEdge).toMatchObject({ childId: "sub-first", child: first });
		expect(await ledger.edges()).toEqual([
			{ childId: "sub-second", parent, child: second, depth: 1, name: "sub-second" },
		]);
		expect(await ledger.edges(true)).toEqual([
			expect.objectContaining({ childId: "sub-first", child: first, deleted: "user" }),
			{ childId: "sub-second", parent, child: second, depth: 1, name: "sub-second" },
		]);
	});

	it("preserves the matched edge key when an alias changes before the delete append", async () => {
		const { root, sessionsDir, ledger } = fixture();
		const parent = makeSession(root, sessionsDir, "parent");
		const first = makeSession(root, join(root, "first"), "first", parent);
		const second = makeSession(root, join(root, "second"), "second", parent);
		const alias = join(root, "child-alias.jsonl");
		symlinkSync(first, alias, "file");
		writeRecords(ledger, [spawn(parent, first, "sub-first"), spawn(parent, second, "sub-second")]);
		await ledger.siblings(alias);
		const appendDelete = ledger.appendDelete.bind(ledger);
		const append = vi.spyOn(ledger, "appendDelete").mockImplementation((input) => {
			rmSync(alias);
			symlinkSync(second, alias, "file");
			return appendDelete(input);
		});

		const result = await tombstoneSavedSessionDelete(ledger, alias, { runtimeKind: "subagent" });
		expect(result.ledgerEdge).toMatchObject({ childId: "sub-first", child: first });
		expect(append).toHaveBeenCalledExactlyOnceWith({ childId: "sub-first", child: first, reason: "user" });
		expect(lastRecord(ledger)).toMatchObject({ op: "delete", childId: "sub-first", child: first, reason: "user" });
		expect(await ledger.edges()).toEqual([
			{ childId: "sub-second", parent, child: second, depth: 1, name: "sub-second" },
		]);
		expect(await ledger.edges(true)).toEqual([
			expect.objectContaining({ childId: "sub-first", child: first, deleted: "user" }),
			{ childId: "sub-second", parent, child: second, depth: 1, name: "sub-second" },
		]);
	});

	it.each(["spawn", "rename", "delete", "rename by alias", "rename aliased edge"])(
		"keeps %s writes fresh after a cached missing path becomes a symlink",
		async (operation) => {
			const { root, sessionsDir, ledger } = fixture();
			const parent = makeSession(root, sessionsDir, "parent");
			const child = makeSession(root, join(root, "child"), "child", parent);
			const parentAlias = join(root, "parent-alias.jsonl");
			const childAlias = join(root, "child-alias.jsonl");
			if (operation !== "spawn") {
				writeRecords(ledger, [spawn(parent, operation === "rename aliased edge" ? childAlias : child)]);
			}
			await withPassiveRlmDescendantInfos([savedInfo(parentAlias), savedInfo(childAlias)], ledger);
			symlinkSync(parent, parentAlias, "file");
			symlinkSync(child, childAlias, "file");
			switch (operation) {
				case "spawn":
					await ledger.appendSpawn({
						childId: "sub-worker",
						parent: parentAlias,
						child: childAlias,
						depth: 1,
						name: "fresh",
					});
					break;
				case "rename":
					await ledger.appendRename({ childId: "sub-worker", child: childAlias, name: "fresh" });
					break;
				case "delete":
					await ledger.appendDelete({ childId: "sub-worker", child: childAlias, reason: "user" });
					break;
				default:
					await ledger.appendRenameByChildPath(operation === "rename by alias" ? childAlias : child, "fresh");
			}
			expect(lastRecord(ledger)).toMatchObject({
				op: operation === "spawn" ? "spawn" : operation === "delete" ? "delete" : "rename",
				child,
				...(operation === "spawn" ? { parent } : {}),
			});
		},
	);

	it("checks duplicate spawn paths freshly even when the existing edge has a cached missing alias", async () => {
		const { root, sessionsDir, ledger } = fixture();
		const parent = makeSession(root, sessionsDir, "parent");
		const child = makeSession(root, join(root, "child"), "child", parent);
		const alias = join(root, "child-alias.jsonl");
		writeRecords(ledger, [spawn(parent, alias)]);
		await ledger.edges();
		symlinkSync(child, alias, "file");
		await expect(
			ledger.appendSpawn({ childId: "sub-duplicate", parent, child, depth: 1, name: "duplicate" }),
		).rejects.toThrow("duplicate child session path");
		expect(lastRecord(ledger)).toMatchObject({ childId: "sub-worker", child: alias });
	});

	it("seeds fresh parent, child, and visited identities after warming missing aliases", async () => {
		const { root, sessionsDir, ledger } = fixture();
		const parent = makeSession(root, join(root, "parent"), "parent");
		const child = makeSession(root, join(root, "child"), "child", parent);
		const parentAlias = join(sessionsDir, "parent-alias.jsonl");
		const childAlias = join(root, "child-alias.jsonl");
		await withPassiveRlmDescendantInfos([savedInfo(parentAlias), savedInfo(childAlias)], ledger);
		symlinkSync(parent, parentAlias, "file");
		symlinkSync(child, childAlias, "file");
		const seeded = new RlmSpawnLedger(root, sessionsDir, {
			readRegistryForSessionFile: async (path) =>
				path === parentAlias
					? [
							{ childId: "sub-cycle", sessionName: "cycle", sessionFile: parent, status: "completed" },
							{ childId: "sub-seeded", sessionName: "seeded", sessionFile: childAlias, status: "completed" },
						]
					: [],
		});
		expect(await seeded.edges()).toEqual([{ childId: "sub-seeded", parent, child, depth: 1, name: "seeded" }]);
	});
});
