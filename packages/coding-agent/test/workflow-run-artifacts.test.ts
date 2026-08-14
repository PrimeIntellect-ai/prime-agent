import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorkflowJournal,
	createWorkflowRunArtifact,
	getWorkflowArtifactProjectDirectory,
	getWorkflowRunArtifactPaths,
	listWorkflowRunArtifacts,
	loadWorkflowRunArtifact,
	MAX_WORKFLOW_JOURNAL_LINE_BYTES,
	MAX_WORKFLOW_JOURNAL_SEQUENCE,
	MAX_WORKFLOW_RECORD_BYTES,
	MAX_WORKFLOW_SOURCE_BYTES,
	updateWorkflowRunArtifact,
	workflowProjectKey,
} from "../src/core/workflows/run-artifacts.js";

const temporaryDirectories: string[] = [];
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");

async function runTerminalWriter(code: string): Promise<string> {
	return await new Promise((resolveResult, rejectResult) => {
		const child = spawn(process.execPath, [tsxPath, "-e", code], {
			cwd: resolve(__dirname, ".."),
			env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json") },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", rejectResult);
		child.once("close", (code) => {
			if (code === 0) resolveResult(stdout.trim());
			else rejectResult(new Error(`Terminal writer exited ${code}: ${stderr}`));
		});
	});
}

function createFixture(): { root: string; agentDir: string; project: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-workflow-artifact-test-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent-home");
	const project = join(root, "project");
	mkdirSync(project, { recursive: true });
	return { root, agentDir, project };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("workflow run artifacts", () => {
	it("stores private atomic artifacts as pending and permits one terminal update", () => {
		const { agentDir, project } = createFixture();
		const source = 'def main():\n    return "audit"\n';
		const artifact = createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "run-safe_1",
			workflowName: "Audit",
			source,
			sessionId: "session-1",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		const expectedKey = createHash("sha256").update(resolve(project)).digest("hex");
		expect(workflowProjectKey(project)).toBe(expectedKey);
		expect(getWorkflowArtifactProjectDirectory(project, agentDir)).toBe(
			join(agentDir, "workflow-runs", "projects", expectedKey),
		);
		const paths = getWorkflowRunArtifactPaths(project, artifact.runId, agentDir);
		expect(readdirSync(paths.runDirectory).sort()).toEqual(["journal", "run.json", "source.txt"]);
		expect(artifact).toMatchObject({
			status: "pending",
			sourceHash: createHash("sha256").update(source).digest("hex"),
		});
		expect(readFileSync(paths.sourcePath, "utf8")).toBe(source);
		expect(lstatSync(paths.runDirectory).mode & 0o777).toBe(0o700);
		expect(lstatSync(paths.sourcePath).mode & 0o777).toBe(0o600);
		expect(lstatSync(paths.recordPath).mode & 0o777).toBe(0o600);
		const loaded = loadWorkflowRunArtifact(project, artifact.runId, agentDir);
		expect(loaded).toEqual({ record: artifact, source, paths });

		const completed = updateWorkflowRunArtifact(
			project,
			artifact.runId,
			{
				status: "completed",
				completedAt: "2026-01-01T00:01:00.000Z",
				result: { findings: 2 },
				usage: { input: 10, output: 5, totalTokens: 15, cost: 0.02 },
			},
			agentDir,
		);
		expect(completed).toMatchObject({ status: "completed", result: { findings: 2 } });
		expect(loadWorkflowRunArtifact(project, artifact.runId, agentDir)?.record).toEqual(completed);
		expect(lstatSync(paths.terminalPath).mode & 0o777).toBe(0o600);
		expect(readdirSync(paths.runDirectory).every((name) => !name.endsWith(".tmp"))).toBe(true);
		expect(() =>
			updateWorkflowRunArtifact(
				project,
				artifact.runId,
				{ status: "failed", completedAt: "2026-01-01T00:02:00.000Z", error: "late" },
				agentDir,
			),
		).toThrow("already terminal");
	});

	it("allows only one terminal writer across concurrent processes", async () => {
		const { agentDir, project } = createFixture();
		const artifact = createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "terminal-cas",
			workflowName: "terminal-cas",
			source: "source",
		});
		const moduleUrl = pathToFileURL(resolve(__dirname, "../src/core/workflows/run-artifacts.ts")).href;
		const writerCode = (writer: string) => `
import { updateWorkflowRunArtifact } from ${JSON.stringify(moduleUrl)};
try {
  updateWorkflowRunArtifact(
    ${JSON.stringify(project)},
    "terminal-cas",
    { status: "completed", completedAt: ${JSON.stringify(artifact.createdAt)}, result: { writer: ${JSON.stringify(writer)} } },
    ${JSON.stringify(agentDir)},
  );
  process.stdout.write("won");
} catch (error) {
  if (error instanceof Error && error.message.includes("already terminal")) process.stdout.write("lost");
  else throw error;
}`;

		const outcomes = await Promise.all([
			runTerminalWriter(writerCode("writer-1")),
			runTerminalWriter(writerCode("writer-2")),
		]);
		expect(outcomes.sort()).toEqual(["lost", "won"]);
		expect(loadWorkflowRunArtifact(project, "terminal-cas", agentDir)?.record).toMatchObject({
			status: "completed",
			result: { writer: expect.stringMatching(/^writer-[12]$/) },
		});
	});

	it("adopts a fully prepared terminal record left before the final CAS link", () => {
		const { agentDir, project } = createFixture();
		const pending = createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "pending-terminal",
			workflowName: "pending-terminal",
			source: "source",
		});
		const paths = getWorkflowRunArtifactPaths(project, "pending-terminal", agentDir);
		writeFileSync(
			join(paths.runDirectory, ".terminal.json.pending"),
			JSON.stringify({
				...pending,
				status: "completed",
				updatedAt: pending.createdAt,
				completedAt: pending.createdAt,
				result: { recovered: true },
			}),
		);

		expect(() =>
			updateWorkflowRunArtifact(
				project,
				"pending-terminal",
				{ status: "failed", completedAt: pending.createdAt, error: "later writer" },
				agentDir,
			),
		).toThrow("already terminal");
		expect(loadWorkflowRunArtifact(project, "pending-terminal", agentDir)?.record).toMatchObject({
			status: "completed",
			result: { recovered: true },
		});
	});

	it("rejects unsafe, duplicate, oversized, invalid, and non-serializable artifacts", () => {
		const { root, agentDir, project } = createFixture();
		const create = (runId: string) =>
			createWorkflowRunArtifact({ cwd: project, agentDir, runId, workflowName: "test", source: "return 1" });

		for (const runId of ["../escape", "nested/run", "nested\\run", ".", "run.json", "", " with-space"]) {
			expect(() => create(runId)).toThrow("path-safe");
		}
		const uniqueArtifact = create("unique-run");
		expect(() => create("unique-run")).toThrow();
		expect(() => getWorkflowRunArtifactPaths(project, "../../escape", agentDir)).toThrow("path-safe");
		expect(() => createWorkflowRunArtifact({ cwd: project, agentDir, workflowName: " ", source: "source" })).toThrow(
			"between 1 and 256",
		);
		expect(() =>
			createWorkflowRunArtifact({
				cwd: project,
				agentDir,
				workflowName: "large",
				source: "x".repeat(MAX_WORKFLOW_SOURCE_BYTES + 1),
			}),
		).toThrow("exceeds");
		expect(() =>
			createWorkflowRunArtifact({
				cwd: project,
				agentDir,
				workflowName: "multibyte-limit",
				source: "é".repeat(MAX_WORKFLOW_SOURCE_BYTES / 2),
			}),
		).not.toThrow();
		expect(() =>
			createWorkflowRunArtifact({
				cwd: project,
				agentDir,
				workflowName: "multibyte-too-large",
				source: "é".repeat(MAX_WORKFLOW_SOURCE_BYTES / 2 + 1),
			}),
		).toThrow("exceeds");
		expect(() =>
			createWorkflowRunArtifact({
				cwd: project,
				agentDir,
				workflowName: "bad-time",
				source: "source",
				createdAt: "tomorrow",
			}),
		).toThrow("ISO timestamp");
		expect(() =>
			createWorkflowRunArtifact({
				cwd: project,
				agentDir,
				workflowName: "future",
				source: "source",
				createdAt: "2999-01-01T00:00:00.000Z",
			}),
		).toThrow("cannot be in the future");
		expect(() =>
			updateWorkflowRunArtifact(project, "unique-run", { status: "failed", error: "missing time" }, agentDir),
		).toThrow("requires an ISO completion time");
		expect(() =>
			updateWorkflowRunArtifact(
				project,
				"unique-run",
				{ status: "failed", completedAt: "2000-01-01T00:00:00.000Z", error: "too early" },
				agentDir,
			),
		).toThrow("cannot precede");
		const badUsage = {
			input: 1,
			output: 1,
			totalTokens: 2,
			cost: 0,
			toJSON: () => "not-usage",
		};
		expect(() =>
			updateWorkflowRunArtifact(
				project,
				"unique-run",
				{ status: "failed", completedAt: uniqueArtifact.createdAt, usage: badUsage },
				agentDir,
			),
		).toThrow("serialization produced an invalid record");
		expect(loadWorkflowRunArtifact(project, "unique-run", agentDir)?.record.status).toBe("pending");

		const shared = { value: "shared" };
		const sharedReferenceResult = [shared, shared];
		expect(() =>
			updateWorkflowRunArtifact(
				project,
				"unique-run",
				{ status: "failed", completedAt: uniqueArtifact.createdAt, result: sharedReferenceResult },
				agentDir,
			),
		).not.toThrow();

		const cyclicArtifact = create("cyclic-run");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			updateWorkflowRunArtifact(
				project,
				"cyclic-run",
				{ status: "failed", completedAt: cyclicArtifact.createdAt, result: cyclic },
				agentDir,
			),
		).toThrow("JSON-serializable");
		const oversizedRecord = create("oversized-record");
		expect(() =>
			updateWorkflowRunArtifact(
				project,
				"oversized-record",
				{
					status: "failed",
					completedAt: oversizedRecord.createdAt,
					error: "x".repeat(MAX_WORKFLOW_RECORD_BYTES),
				},
				agentDir,
			),
		).toThrow("exceeds");
		expect(() => readFileSync(join(root, "escape", "run.json"), "utf8")).toThrow();
	});

	it("lists only valid artifacts and rejects tampering and symlink traversal", () => {
		const { root, agentDir, project } = createFixture();
		for (const [runId, createdAt] of [
			["older", "2026-01-01T00:00:00.000Z"],
			["newer", "2026-01-02T00:00:00.000Z"],
			["bad-order", "2026-01-03T00:00:00.000Z"],
		] as const) {
			createWorkflowRunArtifact({ cwd: project, agentDir, runId, workflowName: runId, source: runId, createdAt });
		}
		const badOrderPaths = getWorkflowRunArtifactPaths(project, "bad-order", agentDir);
		const badOrderRecord = JSON.parse(readFileSync(badOrderPaths.recordPath, "utf8")) as Record<string, unknown>;
		writeFileSync(
			badOrderPaths.terminalPath,
			JSON.stringify({
				...badOrderRecord,
				status: "completed",
				updatedAt: "2026-01-04T00:00:00.000Z",
				completedAt: "2026-01-05T00:00:00.000Z",
			}),
		);
		const projectDirectory = getWorkflowArtifactProjectDirectory(project, agentDir);
		mkdirSync(join(projectDirectory, "corrupt"));
		writeFileSync(join(projectDirectory, "corrupt", "run.json"), "{truncated");
		const outside = join(root, "outside-run");
		mkdirSync(outside);
		writeFileSync(join(outside, "run.json"), JSON.stringify({ runId: "linked" }));
		symlinkSync(outside, join(projectDirectory, "linked"), "dir");
		writeFileSync(getWorkflowRunArtifactPaths(project, "older", agentDir).sourcePath, "tampered");
		writeFileSync(
			getWorkflowRunArtifactPaths(project, "newer", agentDir).recordPath,
			"x".repeat(MAX_WORKFLOW_RECORD_BYTES + 1),
		);

		expect(listWorkflowRunArtifacts(project, agentDir)).toEqual([]);
		expect(loadWorkflowRunArtifact(project, "older", agentDir)).toBeUndefined();
		expect(loadWorkflowRunArtifact(project, "newer", agentDir)).toBeUndefined();
		expect(loadWorkflowRunArtifact(project, "bad-order", agentDir)).toBeUndefined();
		expect(listWorkflowRunArtifacts(join(root, "unknown-project"), agentDir)).toEqual([]);
	});

	it("refuses symlinked artifact directory components", () => {
		const { root, agentDir, project } = createFixture();
		mkdirSync(agentDir);
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(agentDir, "workflow-runs"), "dir");
		expect(() =>
			createWorkflowRunArtifact({ cwd: project, agentDir, workflowName: "unsafe", source: "source" }),
		).toThrow("unsafe workflow artifact directory");
		expect(readdirSync(outside)).toEqual([]);
	});
	it("rejects artifact access after an ancestor directory is replaced by a symlink", () => {
		const { root, agentDir, project } = createFixture();
		createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "anchored",
			workflowName: "anchored",
			source: "source",
		});
		const projectDirectory = getWorkflowArtifactProjectDirectory(project, agentDir);
		const movedDirectory = join(root, "moved-project-artifacts");
		renameSync(projectDirectory, movedDirectory);
		symlinkSync(movedDirectory, projectDirectory, "dir");

		expect(loadWorkflowRunArtifact(project, "anchored", agentDir)).toBeUndefined();
		expect(listWorkflowRunArtifacts(project, agentDir)).toEqual([]);
		expect(() => createWorkflowJournal(project, "anchored", agentDir)).toThrow("unsafe directory path");
		expect(readdirSync(join(movedDirectory, "anchored")).sort()).toEqual(["journal", "run.json", "source.txt"]);
	});
});

describe("workflow artifact journal", () => {
	it("replays only the longest completed prefix from immutable records", () => {
		const { agentDir, project } = createFixture();
		createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "journal-run",
			workflowName: "journal",
			source: "source",
		});
		const journal = createWorkflowJournal(project, "journal-run", agentDir);
		journal.start({ sequence: 1, key: "agent-a", occurrence: 0 });
		journal.start({ sequence: 2, key: "agent-b", occurrence: 0 });
		journal.start({ sequence: 3, key: "agent-c", occurrence: 0 });
		journal.record({
			sequence: 1,
			key: "agent-a",
			occurrence: 0,
			result: { value: "A" },
			usage: { input: 2, output: 3, totalTokens: 5, cost: 0.01 },
		});
		journal.record({ sequence: 3, key: "agent-c", occurrence: 0, result: { value: "C" } });

		expect(journal.replay({ sequence: 1, key: "agent-a", occurrence: 0 })).toEqual({
			sequence: 1,
			key: "agent-a",
			occurrence: 0,
			result: { value: "A" },
			usage: { input: 2, output: 3, totalTokens: 5, cost: 0.01 },
		});
		const mutableReplay = journal.replay({ sequence: 1, key: "agent-a", occurrence: 0 });
		if (mutableReplay?.usage) mutableReplay.usage.input = 999;
		expect(journal.replay({ sequence: 1, key: "agent-a", occurrence: 0 })?.usage?.input).toBe(2);
		expect(journal.replay({ sequence: 2, key: "agent-b", occurrence: 0 })).toBeUndefined();
		expect(journal.replay({ sequence: 3, key: "agent-c", occurrence: 0 })).toBeUndefined();
		expect(journal.replay({ sequence: 1, key: "changed", occurrence: 0 })).toBeUndefined();
		expect(journal.entries()).toHaveLength(2);

		const journalPath = getWorkflowRunArtifactPaths(project, "journal-run", agentDir).journalPath;
		expect(lstatSync(journalPath).mode & 0o777).toBe(0o700);
		expect(
			readdirSync(journalPath)
				.filter((name) => !name.startsWith("."))
				.sort(),
		).toEqual([
			"000000000001.completed.json",
			"000000000001.started.json",
			"000000000002.started.json",
			"000000000003.completed.json",
			"000000000003.started.json",
		]);
		for (const name of readdirSync(journalPath)) {
			expect(lstatSync(join(journalPath, name)).mode & 0o777).toBe(0o600);
		}

		const restored = createWorkflowJournal(project, "journal-run", agentDir);
		restored.start({ sequence: 1, key: "agent-a", occurrence: 0 });
		expect(restored.replay({ sequence: 1, key: "agent-a", occurrence: 0 })).toMatchObject({ result: { value: "A" } });
		restored.start({ sequence: 2, key: "agent-b", occurrence: 0 });
		restored.record({ sequence: 2, key: "agent-b", occurrence: 0, result: { value: "B" } });
		const extended = createWorkflowJournal(project, "journal-run", agentDir);
		expect(extended.replay({ sequence: 2, key: "agent-b", occurrence: 0 })).toMatchObject({ result: { value: "B" } });
		expect(extended.entries()).toHaveLength(3);
	});

	it("adopts fully prepared journal records left before their final CAS links", () => {
		const { agentDir, project } = createFixture();
		createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "pending-journal",
			workflowName: "journal",
			source: "source",
		});
		const journalPath = getWorkflowRunArtifactPaths(project, "pending-journal", agentDir).journalPath;
		const identity = { sequence: 1, key: "agent-a", occurrence: 0 };
		writeFileSync(
			join(journalPath, ".000000000001.started.json.pending"),
			JSON.stringify({
				...identity,
				version: 1,
				event: "started",
				recordedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		const journal = createWorkflowJournal(project, "pending-journal", agentDir);
		journal.start(identity);
		writeFileSync(
			join(journalPath, ".000000000001.completed.json.pending"),
			JSON.stringify({
				...identity,
				version: 1,
				event: "completed",
				result: { recovered: true },
				recordedAt: "2026-01-01T00:00:01.000Z",
			}),
		);
		journal.record({ ...identity, result: { later: true } });

		const restored = createWorkflowJournal(project, "pending-journal", agentDir);
		expect(restored.replay(identity)).toMatchObject({ result: { recovered: true } });
	});

	it("fails closed on corrupt records and completions without matching starts", () => {
		const { agentDir, project } = createFixture();
		createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "corrupt-journal",
			workflowName: "journal",
			source: "source",
		});
		const journalPath = getWorkflowRunArtifactPaths(project, "corrupt-journal", agentDir).journalPath;
		const completion = {
			version: 1,
			event: "completed",
			sequence: 1,
			key: "agent-a",
			occurrence: 0,
			result: "premature",
			recordedAt: "2026-01-01T00:00:00.000Z",
		};
		writeFileSync(join(journalPath, "000000000001.completed.json"), JSON.stringify(completion));
		expect(() => createWorkflowJournal(project, "corrupt-journal", agentDir)).toThrow("no matching start");

		rmSync(join(journalPath, "000000000001.completed.json"));
		writeFileSync(join(journalPath, "000000000001.started.json"), "{truncated");
		expect(() => createWorkflowJournal(project, "corrupt-journal", agentDir)).toThrow("corrupt record");
	});

	it("rejects invalid identities, conflicting records, unsafe paths, and invalid values", () => {
		const { root, agentDir, project } = createFixture();
		createWorkflowRunArtifact({
			cwd: project,
			agentDir,
			runId: "journal-run",
			workflowName: "journal",
			source: "source",
		});
		const paths = getWorkflowRunArtifactPaths(project, "journal-run", agentDir);
		const journal = createWorkflowJournal(project, "journal-run", agentDir);
		const forgedStart = { sequence: 1, key: "forged", occurrence: 0, event: "completed", result: "forged" } as const;
		journal.start(forgedStart);
		expect(journal.entries()).toEqual([]);
		const recordsBeforeInvalidSerialization = readdirSync(paths.journalPath);
		const badUsage = { input: 1, toJSON: () => "not-usage" };
		expect(() =>
			journal.record({ sequence: 1, key: "forged", occurrence: 0, result: null, usage: badUsage }),
		).toThrow("serialization produced an invalid record");
		expect(readdirSync(paths.journalPath)).toEqual(recordsBeforeInvalidSerialization);
		expect(() => journal.start({ sequence: 1, key: "different", occurrence: 0 })).toThrow("different start identity");
		expect(() => journal.start({ sequence: 0, key: "key", occurrence: 0 })).toThrow("integer from 1");
		expect(() => journal.start({ sequence: MAX_WORKFLOW_JOURNAL_SEQUENCE + 1, key: "key", occurrence: 0 })).toThrow(
			"integer from 1",
		);
		expect(() => journal.start({ sequence: 1, key: "", occurrence: 0 })).toThrow("between 1 and 512");
		expect(() => journal.start({ sequence: 1, key: "key", occurrence: -1 })).toThrow("non-negative");
		expect(() =>
			journal.record({
				sequence: 1,
				key: "forged",
				occurrence: 0,
				result: "x".repeat(MAX_WORKFLOW_JOURNAL_LINE_BYTES),
			}),
		).toThrow("exceeds");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => journal.record({ sequence: 1, key: "forged", occurrence: 0, result: cyclic })).toThrow(
			"JSON-serializable",
		);
		expect(() => createWorkflowJournal(project, "missing", agentDir)).toThrow("not found");

		const outside = join(root, "outside-journal");
		mkdirSync(outside);
		rmSync(paths.journalPath, { recursive: true });
		symlinkSync(outside, paths.journalPath, "dir");
		expect(() => createWorkflowJournal(project, "journal-run", agentDir)).toThrow("unsafe directory path");
		expect(readdirSync(outside)).toEqual([]);
	});
});
