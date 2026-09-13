import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PathMetadata, ResolvedResource } from "../src/core/package-manager.js";
import {
	applyRefinementProposal,
	createEmptyPackageHarnessState,
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
	loadPackageHarness,
	mergeHarnessStates,
	type RefinementProposal,
} from "../src/core/refinement/index.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function packageResource(path: string, metadata: Partial<PathMetadata> = {}, enabled = true): ResolvedResource {
	return {
		path,
		enabled,
		metadata: {
			source: "git:git@github.com:PrimeIntellect-ai/example-package.git",
			scope: "user",
			origin: "package",
			...metadata,
		},
	};
}

function writeHarnessFile(packageRoot: string, kind: string, id: string, content: unknown): string {
	const dir = join(packageRoot, "harness", kind);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, `${id}.json`);
	writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`);
	return filePath;
}

function minimalEntry(kind: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind,
		id,
		title: `${id} title`,
		content: `${id} content`,
		...overrides,
	};
}

function harnessState(entries: HarnessEntry[] = []): HarnessState {
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
	for (const entry of entries) {
		state.entries[entry.kind][entry.id] = entry;
	}
	return state;
}

function editableEntry(kind: HarnessEntry["kind"], id: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id,
		kind,
		title: `${id} title`,
		content: `${id} content`,
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "agent",
		created_at: TIMESTAMP,
		updated_at: TIMESTAMP,
		version: 1,
		...overrides,
	};
}

function packageEntry(kind: HarnessEntry["kind"], id: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		...editableEntry(kind, id, { scope: undefined, ...overrides }),
		source: "git:git@github.com:PrimeIntellect-ai/example-package.git",
		created_at: "1970-01-01T00:00:00.000Z",
		updated_at: "1970-01-01T00:00:00.000Z",
		provenance: {
			origin: "package",
			source: "git:git@github.com:PrimeIntellect-ai/example-package.git",
			scope: "user",
			file: `harness/${kind}/${id}.json`,
			readOnly: true,
		},
		...overrides,
	};
}

function proposal(edits: RefinementProposal["edits"]): RefinementProposal {
	return { summary: "test proposal", rationale: "test", expectedOutcome: "test", edits };
}

describe("loadPackageHarness", () => {
	let tempDir: string;
	let packageRoot: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `package-harness-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		packageRoot = join(tempDir, "example-package");
		mkdirSync(packageRoot, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("mounts all four harness kinds with read-only provenance", { timeout: 10_000 }, () => {
		const skillPath = writeHarnessFile(packageRoot, "skill", "shared_skill", {
			...minimalEntry("skill", "shared_skill"),
			reference: { type: "python", import: "shared_skill", callable: "run" },
			arguments: { query: { type: "string", required: true } },
		});
		const memoryPath = writeHarnessFile(
			packageRoot,
			"memory",
			"team_policy",
			minimalEntry("memory", "team_policy", { path: "Team policy" }),
		);
		const promptPath = writeHarnessFile(packageRoot, "prompt", "policy_note", minimalEntry("prompt", "policy_note"));
		const subagentPath = writeHarnessFile(packageRoot, "subagent", "reviewer", minimalEntry("subagent", "reviewer"));

		const { state, diagnostics } = loadPackageHarness([
			packageResource(skillPath, { baseDir: packageRoot }),
			packageResource(memoryPath, { baseDir: packageRoot }),
			packageResource(promptPath, { baseDir: packageRoot }),
			packageResource(subagentPath, { baseDir: packageRoot }),
		]);

		expect(diagnostics).toEqual([]);
		expect(Object.keys(state.entries.memory)).toEqual(["team_policy"]);
		expect(Object.keys(state.entries.prompt)).toEqual(["policy_note"]);
		expect(Object.keys(state.entries.skill)).toEqual(["shared_skill"]);
		expect(Object.keys(state.entries.subagent)).toEqual(["reviewer"]);

		const memory = state.entries.memory.team_policy!;
		expect(memory.path).toBe("Team policy");
		expect(memory.provenance).toEqual({
			origin: "package",
			source: "git:git@github.com:PrimeIntellect-ai/example-package.git",
			scope: "user",
			file: "harness/memory/team_policy.json",
			readOnly: true,
		});
		const prompt = state.entries.prompt.policy_note!;
		expect(prompt.path).toBe("policy");
		const skill = state.entries.skill.shared_skill!;
		expect(skill.reference).toEqual({ type: "python", import: "shared_skill", callable: "run" });
	});

	it("derives revision from a git checkout", { timeout: 10_000 }, () => {
		const gitDir = join(packageRoot, ".git");
		mkdirSync(gitDir);
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
		writeFileSync(join(gitDir, "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n");
		const memoryPath = writeHarnessFile(packageRoot, "memory", "rev_policy", minimalEntry("memory", "rev_policy"));

		const { state, diagnostics } = loadPackageHarness([packageResource(memoryPath, { baseDir: packageRoot })]);

		expect(diagnostics).toEqual([]);
		expect(state.entries.memory.rev_policy?.provenance?.revision).toBe("0123456789ab");
	});

	it("derives revision from package.json version when no git metadata exists", { timeout: 10_000 }, () => {
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "example", version: "1.2.3" }));
		const memoryPath = writeHarnessFile(
			packageRoot,
			"memory",
			"versioned_policy",
			minimalEntry("memory", "versioned_policy"),
		);

		const { state } = loadPackageHarness([packageResource(memoryPath, { baseDir: packageRoot })]);

		expect(state.entries.memory.versioned_policy?.provenance?.revision).toBe("v1.2.3");
	});

	it("rejects invalid entry shapes with warning diagnostics", { timeout: 10_000 }, () => {
		const badKind = writeHarnessFile(packageRoot, "prompt", "mixed_kind", minimalEntry("memory", "mixed_kind"));
		const badId = writeHarnessFile(packageRoot, "memory", "mismatched_id", minimalEntry("memory", "other_id"));
		const missingContent = writeHarnessFile(packageRoot, "memory", "empty_content", {
			kind: "memory",
			id: "empty_content",
			title: "t",
		});
		const badScope = writeHarnessFile(
			packageRoot,
			"memory",
			"bad_scope",
			minimalEntry("memory", "bad_scope", { scope: "team" }),
		);
		const badVersion = writeHarnessFile(
			packageRoot,
			"memory",
			"bad_version",
			minimalEntry("memory", "bad_version", { version: 0 }),
		);
		const skillWithoutReference = writeHarnessFile(
			packageRoot,
			"skill",
			"not_python",
			minimalEntry("skill", "not_python"),
		);
		const invalidJson = join(packageRoot, "harness", "memory", "invalid.json");
		mkdirSync(join(packageRoot, "harness", "memory"), { recursive: true });
		writeFileSync(invalidJson, "{not json");

		const { state, diagnostics } = loadPackageHarness([
			packageResource(badKind, { baseDir: packageRoot }),
			packageResource(badId, { baseDir: packageRoot }),
			packageResource(missingContent, { baseDir: packageRoot }),
			packageResource(badScope, { baseDir: packageRoot }),
			packageResource(badVersion, { baseDir: packageRoot }),
			packageResource(skillWithoutReference, { baseDir: packageRoot }),
			packageResource(invalidJson, { baseDir: packageRoot }),
		]);

		expect(Object.keys(state.entries.memory)).toEqual([]);
		expect(diagnostics.every((diagnostic) => diagnostic.type === "warning")).toBe(true);
		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("kind must match path kind prompt"),
				expect.stringContaining("id must match file id mismatched_id"),
				expect.stringContaining("content must be a nonempty string"),
				expect.stringContaining("scope must be local or global"),
				expect.stringContaining("version must be a positive integer"),
				expect.stringContaining("reference.type must be python"),
				expect.stringContaining("failed to read package harness entry"),
			]),
		);
	});

	it("rejects files outside the harness/<kind>/<id>.json layout and reserved ids", { timeout: 10_000 }, () => {
		const nested = join(packageRoot, "harness", "memory", "nested", "deep.json");
		mkdirSync(join(packageRoot, "harness", "memory", "nested"), { recursive: true });
		writeFileSync(nested, JSON.stringify(minimalEntry("memory", "deep")));
		const reserved = writeHarnessFile(packageRoot, "memory", "prototype", minimalEntry("memory", "prototype"));
		const missingRoot = packageResource(join(tempDir, "loose.json"));
		writeFileSync(join(tempDir, "loose.json"), JSON.stringify(minimalEntry("memory", "loose")));

		const { state, diagnostics } = loadPackageHarness([
			packageResource(nested, { baseDir: packageRoot }),
			packageResource(reserved, { baseDir: packageRoot }),
			missingRoot,
		]);

		expect(state.entries.memory).toEqual({});
		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"package harness file must use harness/<kind>/<id>.json",
				"package harness id prototype is reserved",
				"package harness resource is missing its package root",
			]),
		);
	});

	it("keeps the first package entry on cross-package collisions and diagnoses them", { timeout: 10_000 }, () => {
		const projectRoot = join(tempDir, "project-package");
		mkdirSync(projectRoot, { recursive: true });
		const projectPath = writeHarnessFile(
			projectRoot,
			"memory",
			"shared",
			minimalEntry("memory", "shared", { title: "project wins" }),
		);
		const userPath = writeHarnessFile(
			packageRoot,
			"memory",
			"shared",
			minimalEntry("memory", "shared", { title: "user loses" }),
		);

		const { state, diagnostics } = loadPackageHarness([
			packageResource(userPath, {
				source: "git:git@github.com:PrimeIntellect-ai/user-package.git",
				baseDir: packageRoot,
			}),
			packageResource(projectPath, { source: "local", scope: "project", baseDir: projectRoot }),
		]);

		expect(state.entries.memory.shared?.title).toBe("project wins");
		expect(state.entries.memory.shared?.provenance?.scope).toBe("project");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.type).toBe("collision");
		expect(diagnostics[0]?.collision).toMatchObject({
			resourceType: "harness",
			name: "memory:shared",
			winnerSource: "local:project-package",
			loserSource: "git:git@github.com:PrimeIntellect-ai/user-package.git",
		});
	});

	it("skips disabled resources and sanitizes credential-bearing sources", { timeout: 10_000 }, () => {
		const memoryPath = writeHarnessFile(
			packageRoot,
			"memory",
			"token_source",
			minimalEntry("memory", "token_source"),
		);

		const queryPath = writeHarnessFile(
			packageRoot,
			"memory",
			"token_query_source",
			minimalEntry("memory", "token_query_source"),
		);

		const { state, diagnostics } = loadPackageHarness([
			packageResource(memoryPath, { baseDir: packageRoot }, false),
			packageResource(memoryPath, {
				source: "git:https://token:secret@github.com/PrimeIntellect-ai/example-package.git?access_token=abc123",
				baseDir: packageRoot,
			}),
			packageResource(queryPath, {
				source: "git:git:secret@github.com:PrimeIntellect-ai/example-package.git?token=abc123",
				baseDir: packageRoot,
			}),
		]);

		expect(diagnostics).toEqual([]);
		// URL sources drop userinfo and credential query parameters entirely.
		const provenance = state.entries.memory.token_source?.provenance;
		expect(provenance?.source).toBe("git:https://github.com/PrimeIntellect-ai/example-package.git");
		expect(provenance?.source).not.toContain("secret");
		expect(provenance?.source).not.toContain("abc123");
		// scp-like sources keep their shape but redact credentials.
		const queryProvenance = state.entries.memory.token_query_source?.provenance;
		expect(queryProvenance?.source).toContain("github.com:PrimeIntellect-ai/example-package.git");
		expect(queryProvenance?.source).toContain("[redacted]");
		expect(queryProvenance?.source).not.toContain("secret");
	});

	it("describes local-path packages by directory name, not their filesystem path", { timeout: 10_000 }, () => {
		const memoryPath = writeHarnessFile(
			packageRoot,
			"memory",
			"local_source",
			minimalEntry("memory", "local_source"),
		);

		const { state } = loadPackageHarness([
			packageResource(memoryPath, { source: packageRoot, scope: "project", baseDir: packageRoot }),
		]);

		const provenance = state.entries.memory.local_source?.provenance;
		expect(provenance?.source).toBe("local:example-package");
		expect(provenance?.source).not.toContain(tempDir);
	});
});

describe("package harness overlays in harness state", () => {
	it("merge editable entries ahead of package entries and shadow same-id packages", { timeout: 10_000 }, () => {
		const globalState = harnessState([editableEntry("memory", "user_policy", { scope: "global" })]);
		const localState = harnessState([editableEntry("memory", "session_policy")]);
		const packageState = harnessState([
			packageEntry("memory", "team_policy"),
			packageEntry("memory", "user_policy", { title: "shadowed package title" }),
		]);

		const merged = mergeHarnessStates(globalState, localState, packageState);

		expect(Object.keys(merged.entries.memory).sort()).toEqual(["session_policy", "team_policy", "user_policy"]);
		expect(merged.entries.memory.user_policy?.title).toBe("user_policy title");
		expect(merged.entries.memory.user_policy?.provenance).toBeUndefined();
		expect(merged.entries.memory.team_policy?.provenance?.origin).toBe("package");
	});

	it("render package labels, provenance, and no local filesystem paths in the digest", { timeout: 10_000 }, () => {
		const localState = harnessState([editableEntry("memory", "session_policy")]);
		const packageState = harnessState([
			packageEntry("memory", "team_policy", {
				provenance: {
					origin: "package",
					source: "local:example-package",
					scope: "project",
					file: "harness/memory/team_policy.json",
					revision: "v1.2.3",
					readOnly: true,
				},
			}),
		]);

		const digest = formatHarnessStateForPrompt(
			mergeHarnessStates(createEmptyPackageHarnessState(), localState, packageState),
			{
				includeIpythonExamples: true,
			},
		);

		expect(digest).toContain("[package:team_policy]");
		expect(digest).toContain(
			"read-only package; scope=project; source=local:example-package rev=v1.2.3; file=harness/memory/team_policy.json",
		);
		expect(digest).toContain("Never update or delete a package entry with `/refine`");
		// Redaction: the package-relative file path must be the only file reference.
		expect(digest).not.toContain(tmpdir());
		// Editable entries render ahead of package overlays.
		expect(digest.indexOf("[local:session_policy]")).toBeLessThan(digest.indexOf("[package:team_policy]"));
	});

	it("bounds package-controlled title, path, version, and revision in the digest", { timeout: 10_000 }, () => {
		const packageState = harnessState([
			packageEntry("memory", "bloat", {
				title: "x".repeat(500),
				path: "y".repeat(500),
				version: 123456789012345,
				provenance: {
					origin: "package",
					source: "local:example-package",
					scope: "project",
					file: "harness/memory/bloat.json",
					revision: "z".repeat(300),
					readOnly: true,
				},
			}),
		]);

		const digest = formatHarnessStateForPrompt(
			mergeHarnessStates(createEmptyPackageHarnessState(), undefined, packageState),
			{
				maxContentLength: 40,
			},
		);

		// Every package-controlled field is compacted before interpolation.
		expect(digest).toContain(`[package:bloat] ${"x".repeat(37)}... (${"y".repeat(37)}..., v123456789012)`);
		expect(digest).toContain(`rev=${"z".repeat(37)}...`);
		expect(digest).not.toContain("x".repeat(60));
		expect(digest).not.toContain("y".repeat(60));
		expect(digest).not.toContain("z".repeat(60));
		expect(digest).not.toContain("123456789012345");
	});

	it("guard update and delete of package entries but allow same-id overrides", { timeout: 10_000 }, () => {
		const editableState = harnessState();
		const packageState = harnessState([packageEntry("memory", "team_policy")]);

		const result = applyRefinementProposal(
			editableState,
			proposal([
				{ action: "update", kind: "memory", id: "team_policy", title: "t", content: "c" },
				{ action: "delete", kind: "memory", id: "team_policy" },
				{ action: "create", kind: "memory", id: "team_policy", title: "override", content: "override content" },
			]),
			{
				id: "refine-test",
				scope: "local",
				packageState,
			},
		);

		expect(result.appliedEdits[0]?.applied).toBe(false);
		expect(result.appliedEdits[0]?.error).toContain("read-only");
		expect(result.appliedEdits[1]?.applied).toBe(false);
		expect(result.appliedEdits[1]?.error).toContain("read-only");
		expect(result.appliedEdits[2]?.applied).toBe(true);
		expect(editableState.entries.memory.team_policy?.title).toBe("override");
		expect(editableState.entries.memory.team_policy?.source).toBe("refine");
		expect(editableState.entries.memory.team_policy?.provenance).toBeUndefined();
		// The package overlay itself is untouched.
		expect(packageState.entries.memory.team_policy?.title).toBe("team_policy title");
	});

	it("allow updates of an editable entry that overrides a package id", { timeout: 10_000 }, () => {
		const editableState = harnessState([editableEntry("memory", "team_policy", { title: "editable override" })]);
		const packageState = harnessState([packageEntry("memory", "team_policy")]);

		const result = applyRefinementProposal(
			editableState,
			proposal([
				{ action: "update", kind: "memory", id: "team_policy", title: "editable override v2", content: "c2" },
			]),
			{
				id: "refine-test",
				scope: "local",
				packageState,
			},
		);

		expect(result.appliedEdits[0]?.applied).toBe(true);
		expect(editableState.entries.memory.team_policy?.title).toBe("editable override v2");
	});
});
