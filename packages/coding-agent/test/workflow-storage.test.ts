import { createHash } from "node:crypto";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWorkflowJournal,
	createWorkflowRun,
	getWorkflowProjectDirectory,
	getWorkflowRunPaths,
	listWorkflowRuns,
	loadWorkflowRun,
	readWorkflowRun,
	resolveSavedWorkflow,
	saveRunAsProjectWorkflow,
	saveRunAsUserWorkflow,
	updateWorkflowRun,
	workflowProjectKey,
} from "../src/core/workflows/storage.js";

const temporaryDirectories: string[] = [];

function createFixture(): { root: string; agentDir: string; project: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-workflow-storage-test-"));
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

describe("workflow run storage", () => {
	it("stores atomic run artifacts in a cwd-hashed project directory and updates metadata", () => {
		const { agentDir, project } = createFixture();
		const script = 'export const meta = { name: "audit", description: "Audit" };\nreturn 1;';
		const record = createWorkflowRun({
			cwd: project,
			agentDir,
			runId: "run-safe_1",
			workflowName: "audit",
			description: "Audit",
			script,
			args: { scope: "src" },
			startedAt: "2026-01-01T00:00:00.000Z",
		});

		const expectedKey = createHash("sha256").update(resolve(project)).digest("hex");
		expect(workflowProjectKey(project)).toBe(expectedKey);
		expect(getWorkflowProjectDirectory(project, agentDir)).toBe(join(agentDir, "workflows", "projects", expectedKey));
		const paths = getWorkflowRunPaths(project, record.runId, agentDir);
		expect(paths.runDirectory).toBe(join(agentDir, "workflows", "projects", expectedKey, "run-safe_1"));
		expect(readdirSync(paths.runDirectory).sort()).toEqual(["run.json", "script.py"]);
		expect(readFileSync(paths.scriptPath, "utf8")).toBe(script);
		expect(lstatSync(paths.scriptPath).mode & 0o777).toBe(0o600);
		expect(lstatSync(paths.recordPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(paths.recordPath, "utf8"))).toEqual(record);
		expect(loadWorkflowRun(project, record.runId, agentDir)).toEqual({ record, script, paths });

		const updated = updateWorkflowRun(
			project,
			record.runId,
			{
				status: "completed",
				result: { findings: 2 },
				completedAt: "2026-01-01T00:01:00.000Z",
				agentCount: 3,
				replayedCount: 1,
				usage: { input: 10, output: 5, totalTokens: 15, cost: 0.02 },
			},
			agentDir,
		);
		expect(updated).toMatchObject({
			status: "completed",
			result: { findings: 2 },
			agentCount: 3,
			replayedCount: 1,
		});
		expect(readWorkflowRun(project, record.runId, agentDir)).toEqual(updated);
		expect(readdirSync(paths.runDirectory).every((name) => !name.endsWith(".tmp"))).toBe(true);
	});

	it("rejects unsafe and duplicate run IDs before they can escape the project directory", () => {
		const { root, agentDir, project } = createFixture();
		const create = (runId: string) =>
			createWorkflowRun({ cwd: project, agentDir, runId, workflowName: "test", script: "return 1;" });

		for (const runId of ["../escape", "nested/run", "nested\\run", ".", "run.json", "", " with-space"]) {
			expect(() => create(runId)).toThrow("path-safe");
		}
		create("unique-run");
		expect(() => create("unique-run")).toThrow();
		expect(() => getWorkflowRunPaths(project, "../../escape", agentDir)).toThrow("path-safe");
		expect(readFileSync(join(getWorkflowRunPaths(project, "unique-run", agentDir).scriptPath), "utf8")).toBe(
			"return 1;",
		);
		expect(() => readFileSync(join(root, "escape", "run.json"), "utf8")).toThrow();
	});

	it("lists valid runs newest first while ignoring corrupt and symlinked entries", () => {
		const { root, agentDir, project } = createFixture();
		createWorkflowRun({
			cwd: project,
			agentDir,
			runId: "older",
			workflowName: "old",
			script: "return 1;",
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		createWorkflowRun({
			cwd: project,
			agentDir,
			runId: "newer",
			workflowName: "new",
			script: "return 2;",
			startedAt: "2026-01-02T00:00:00.000Z",
		});
		const projectDirectory = getWorkflowProjectDirectory(project, agentDir);
		mkdirSync(join(projectDirectory, "corrupt"));
		writeFileSync(join(projectDirectory, "corrupt", "run.json"), "{truncated");
		const outside = join(root, "outside-run");
		mkdirSync(outside);
		writeFileSync(join(outside, "run.json"), JSON.stringify({ runId: "linked" }));
		symlinkSync(outside, join(projectDirectory, "linked"), "dir");

		expect(listWorkflowRuns(project, agentDir).map((run) => run.runId)).toEqual(["newer", "older"]);
		expect(listWorkflowRuns(join(root, "unknown-project"), agentDir)).toEqual([]);
	});
});

describe("workflow journal", () => {
	it("replays only the longest completed prefix in agent start order", () => {
		const { agentDir, project } = createFixture();
		createWorkflowRun({
			cwd: project,
			agentDir,
			runId: "journal-run",
			workflowName: "journal",
			script: "return 1;",
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
		// C completed before the stop, but B was unfinished, so C is outside the replay prefix.
		journal.record({ sequence: 3, key: "agent-c", occurrence: 0, result: { value: "C" } });

		expect(journal.replay({ sequence: 1, key: "agent-a", occurrence: 0 })).toEqual({
			sequence: 1,
			key: "agent-a",
			occurrence: 0,
			result: { value: "A" },
			usage: { input: 2, output: 3, totalTokens: 5, cost: 0.01 },
		});
		expect(journal.replay({ sequence: 2, key: "agent-b", occurrence: 0 })).toBeUndefined();
		expect(journal.replay({ sequence: 3, key: "agent-c", occurrence: 0 })).toBeUndefined();
		expect(journal.replay({ sequence: 1, key: "changed", occurrence: 0 })).toBeUndefined();
		expect(journal.entries()).toHaveLength(2);

		const journalPath = getWorkflowRunPaths(project, "journal-run", agentDir).journalPath;
		appendFileSync(journalPath, '{"version":2,"event":"completed"');
		const restored = createWorkflowJournal(project, "journal-run", agentDir);
		expect(restored.replay({ sequence: 1, key: "agent-a", occurrence: 0 })).toMatchObject({ result: { value: "A" } });
		expect(restored.replay({ sequence: 3, key: "agent-c", occurrence: 0 })).toBeUndefined();
		expect(restored.entries()).toHaveLength(2);
		expect(lstatSync(journalPath).mode & 0o777).toBe(0o600);
		expect(() => restored.start({ sequence: 4, key: "", occurrence: 0 })).toThrow("must not be empty");
		expect(() => restored.replay({ sequence: 0, key: "key", occurrence: 0 })).toThrow("positive");
	});
});

describe("saved workflows", () => {
	it("resolves the closest project workflow before ancestors and the user workflow", () => {
		const { agentDir, project } = createFixture();
		const nested = join(project, "packages", "feature");
		const deep = join(nested, "src");
		mkdirSync(deep, { recursive: true });
		const projectWorkflows = join(project, ".prime", "agent", "workflows");
		const nestedWorkflows = join(nested, ".prime", "agent", "workflows");
		const userWorkflows = join(agentDir, "workflows");
		for (const directory of [projectWorkflows, nestedWorkflows, userWorkflows])
			mkdirSync(directory, { recursive: true });
		writeFileSync(join(projectWorkflows, "review.py"), "project");
		writeFileSync(join(nestedWorkflows, "review.py"), "nested");
		writeFileSync(join(userWorkflows, "review.py"), "user");

		expect(resolveSavedWorkflow("review", deep, agentDir)).toMatchObject({
			script: "nested",
			location: "project",
			projectRoot: nested,
		});
		rmSync(join(nestedWorkflows, "review.py"));
		expect(resolveSavedWorkflow("review", deep, agentDir)).toMatchObject({
			script: "project",
			location: "project",
			projectRoot: project,
		});
		rmSync(join(projectWorkflows, "review.py"));
		expect(resolveSavedWorkflow("review", deep, agentDir)).toMatchObject({ script: "user", location: "user" });
		expect(resolveSavedWorkflow("missing", deep, agentDir)).toBeUndefined();
		expect(() => resolveSavedWorkflow("../review", deep, agentDir)).toThrow("path-safe");
	});

	it("saves a run script atomically in the closest project workflow directory", () => {
		const { agentDir, project } = createFixture();
		const nested = join(project, "packages", "feature");
		mkdirSync(nested, { recursive: true });
		const projectWorkflows = join(project, ".prime", "agent", "workflows");
		mkdirSync(projectWorkflows, { recursive: true });
		const script = 'export const meta = { name: "saved", description: "Saved" };\nreturn 1;';
		createWorkflowRun({
			cwd: nested,
			agentDir,
			runId: "save-run",
			workflowName: "saved",
			script,
		});

		const saved = saveRunAsProjectWorkflow({ cwd: nested, agentDir, runId: "save-run", name: "team-review" });
		expect(saved).toEqual({
			name: "team-review",
			script,
			path: join(projectWorkflows, "team-review.py"),
			location: "project",
			projectRoot: project,
		});
		expect(readFileSync(saved.path, "utf8")).toBe(script);
		expect(lstatSync(saved.path).mode & 0o777).toBe(0o600);
		expect(readdirSync(projectWorkflows).every((name) => !name.endsWith(".tmp"))).toBe(true);
		expect(() =>
			saveRunAsProjectWorkflow({ cwd: nested, agentDir, runId: "save-run", name: "../../escape" }),
		).toThrow("path-safe");
	});

	it("refuses a symlink in the project workflow path", () => {
		const { root, agentDir, project } = createFixture();
		createWorkflowRun({
			cwd: project,
			agentDir,
			runId: "symlink-run",
			workflowName: "saved",
			script: "safe script",
		});
		const outside = join(root, "outside-workflows");
		mkdirSync(outside);
		const agentDirectory = join(project, ".prime", "agent");
		mkdirSync(agentDirectory, { recursive: true });
		symlinkSync(outside, join(agentDirectory, "workflows"), "dir");

		expect(() => saveRunAsProjectWorkflow({ cwd: project, agentDir, runId: "symlink-run", name: "escaped" })).toThrow(
			"symlinked",
		);
		expect(readdirSync(outside)).toEqual([]);
	});

	it("saves to the repository root by default and supports personal workflows", () => {
		const { agentDir, project } = createFixture();
		mkdirSync(join(project, ".git"));
		const nested = join(project, "packages", "feature");
		mkdirSync(nested, { recursive: true });
		createWorkflowRun({
			cwd: nested,
			agentDir,
			runId: "locations-run",
			workflowName: "saved",
			script: "safe script",
		});

		const projectSaved = saveRunAsProjectWorkflow({
			cwd: nested,
			agentDir,
			runId: "locations-run",
			name: "project-copy",
		});
		expect(projectSaved.path).toBe(join(project, ".prime", "agent", "workflows", "project-copy.py"));
		const userSaved = saveRunAsUserWorkflow({
			cwd: nested,
			agentDir,
			runId: "locations-run",
			name: "user-copy",
		});
		expect(userSaved).toMatchObject({ location: "user", path: join(agentDir, "workflows", "user-copy.py") });
		expect(resolveSavedWorkflow("project-copy", nested, agentDir)?.location).toBe("project");
		expect(resolveSavedWorkflow("user-copy", nested, agentDir)?.location).toBe("user");
	});
});
