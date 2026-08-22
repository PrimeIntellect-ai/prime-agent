import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import {
	emptyToolIndex,
	getGlobalToolsDir,
	getProjectToolsDir,
	getToolIndexPath,
	loadToolIndex,
	saveToolIndex,
	type ToolIndex,
} from "../../src/core/retained-tools/index.js";

type RenameSync = (typeof fs)["renameSync"];
type WriteFileSync = (typeof fs)["writeFileSync"];

const fsMocks = vi.hoisted(() => ({
	actualRenameSync: undefined as RenameSync | undefined,
	actualWriteFileSync: undefined as WriteFileSync | undefined,
	renameSync: vi.fn<RenameSync>(),
	writeFileSync: vi.fn<WriteFileSync>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.actualRenameSync = actual.renameSync;
	fsMocks.actualWriteFileSync = actual.writeFileSync;
	fsMocks.renameSync.mockImplementation(actual.renameSync);
	fsMocks.writeFileSync.mockImplementation(actual.writeFileSync);
	return {
		...actual,
		renameSync: fsMocks.renameSync,
		writeFileSync: fsMocks.writeFileSync,
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	fsMocks.writeFileSync.mockReset();
	fsMocks.writeFileSync.mockImplementation(fsMocks.actualWriteFileSync!);
	fsMocks.renameSync.mockReset();
	fsMocks.renameSync.mockImplementation(fsMocks.actualRenameSync!);
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(join(tmpdir(), "prime-agent-retained-index-test-"));
	tempDirs.push(dir);
	return dir;
}

function expectEmptyV1Shape(index: ToolIndex): void {
	expect(index.schema).toBe(1);
	expect(index.updated).toBeTypeOf("string");
	expect(Number.isNaN(new Date(index.updated).getTime())).toBe(false);
	expect(index.skills).toEqual({});
	expect(index.embedding_model).toBeNull();
	expect(index.embedding_dim).toBeNull();
}

describe("tool index store (schema v1)", () => {
	it("returns an empty v1 index when the index file is missing", () => {
		const toolsDir = makeTempDir();
		expectEmptyV1Shape(loadToolIndex(toolsDir));
	});

	it("round-trips an empty index through save and load", () => {
		const toolsDir = makeTempDir();
		const index = emptyToolIndex();
		saveToolIndex(toolsDir, index);
		expect(loadToolIndex(toolsDir)).toEqual(index);
	});

	it("round-trips a populated index through save and load", () => {
		const toolsDir = join(makeTempDir(), "tools");
		const index = populatedIndex();
		saveToolIndex(toolsDir, index);
		expect(loadToolIndex(toolsDir)).toEqual(index);
	});
});

describe("interrupted writes", () => {
	function setupWithExistingIndex(): { toolsDir: string; indexPath: string; previousBytes: Buffer } {
		const toolsDir = makeTempDir();
		saveToolIndex(toolsDir, populatedIndex());
		const indexPath = getToolIndexPath(toolsDir);
		return { toolsDir, indexPath, previousBytes: fs.readFileSync(indexPath) };
	}

	function expectNoTempFiles(toolsDir: string): void {
		expect(fs.readdirSync(toolsDir)).not.toContain(expect.stringMatching(/\.tmp$/));
	}

	const failAfterPartialTempWrite: WriteFileSync = (path, data, options) => {
		fsMocks.actualWriteFileSync!(path, Buffer.from(String(data)).subarray(0, 12), options);
		throw new Error("simulated crash mid-write");
	};

	it("keeps the previous index intact and removes the temp file when the write fails mid-way", () => {
		const { toolsDir, indexPath, previousBytes } = setupWithExistingIndex();
		fsMocks.writeFileSync.mockImplementationOnce(failAfterPartialTempWrite);

		expect(() => saveToolIndex(toolsDir, populatedIndex())).toThrow("simulated crash mid-write");
		expect(fs.readFileSync(indexPath)).toEqual(previousBytes);
		expectNoTempFiles(toolsDir);
	});

	it("keeps the previous index intact and removes the temp file when the rename fails", () => {
		const { toolsDir, indexPath, previousBytes } = setupWithExistingIndex();
		fsMocks.renameSync.mockImplementationOnce(() => {
			throw new Error("simulated crash at rename");
		});

		expect(() => saveToolIndex(toolsDir, populatedIndex())).toThrow("simulated crash at rename");
		expect(fs.readFileSync(indexPath)).toEqual(previousBytes);
		expectNoTempFiles(toolsDir);
	});
});

describe("path resolution", () => {
	it("resolves the global tools dir under the agent dir and the project tools dir under cwd", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			expect(getGlobalToolsDir()).toBe(join(agentDir, "tools"));
		} finally {
			if (previous === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previous;
			}
		}
		expect(getProjectToolsDir(cwd)).toBe(join(cwd, ".prime/agent", "tools"));
	});
});

function populatedIndex(): ToolIndex {
	return {
		schema: 1,
		updated: "2026-08-20T18:00:00Z",
		skills: {
			"deploy-staging-canary": {
				scope: "project",
				path: ".prime/agent/skills/deploy-staging-canary",
				version: 1,
				status: "active",
				usage: {
					used: 14,
					explicit_ok: 12,
					explicit_fail: 1,
					last_used: "2026-08-19T10:22:00Z",
					last_status: "ok",
					recent_failures: [{ at: "2026-08-14T09:00:00Z", note: "rollout step timed out twice" }],
				},
				description_hash: "sha256:6b1f7d44",
				embedding: [],
			},
		},
		embedding_model: null,
		embedding_dim: null,
	};
}
