import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import {
	createEmptyPackageHarnessState,
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
	mergeHarnessStates,
} from "../src/core/refinement/index.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * End-to-end regression for the read-only `pi.harness` package overlay.
 *
 * The fixture mirrors the real PrimeIntellect-ai/prime-skills package manifest
 * shape (`pi: { skills: [...], harness: [...] }`). Against main without this
 * feature the test is red: `resolve()` returns no harness resources and the
 * resource loader has no `getHarness`, so skills mount while harness entries
 * never reach the continual harness layer.
 */
describe("package harness overlay lifecycle", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let loader: DefaultResourceLoader;
	let packageDir: string;

	const writePackageFile = (relativePath: string, content: string): string => {
		const filePath = join(packageDir, relativePath);
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, content);
		return filePath;
	};

	const harnessJson = (kind: string, id: string, overrides: Record<string, unknown> = {}): string =>
		`${JSON.stringify({ kind, id, title: `${id} title`, content: `${id} content`, ...overrides }, null, 2)}\n`;

	const reloadAndGetHarness = async () => {
		await loader.reload();
		return loader.getHarness();
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `package-harness-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		packageDir = join(tempDir, "fixture-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "fixture-package",
				version: "0.1.0",
				pi: { skills: ["./skills"], harness: ["./harness"] },
			}),
		);
		writePackageFile("skills/demo/SKILL.md", "---\nname: demo\ndescription: Demo skill\n---\nDemo skill body.");
		writePackageFile(
			"harness/memory/team_policy.json",
			harnessJson("memory", "team_policy", { path: "Team policy" }),
		);
		writePackageFile("harness/prompt/policy_note.json", harnessJson("prompt", "policy_note"));
		writePackageFile(
			"harness/skill/shared_skill.json",
			harnessJson("skill", "shared_skill", {
				reference: { type: "python", import: "shared_skill", callable: "run" },
				arguments: { query: { type: "string", required: true } },
			}),
		);
		writePackageFile("harness/subagent/reviewer.json", harnessJson("subagent", "reviewer"));

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});
		loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
			noExtensions: true,
		});
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("installs a pi.harness package, mounts skills plus all four harness kinds read-only, and unmounts on remove", {
		timeout: 20_000,
	}, async () => {
		await packageManager.installAndPersist(packageDir);
		// Settings persist the normalized local source (agent-dir-relative), not the raw path.
		expect(settingsManager.getGlobalSettings().packages).toHaveLength(1);

		// Install lifecycle: resolve() exposes the package's harness resources.
		const resolved = await packageManager.resolve();
		expect(resolved.harness.length).toBe(4);
		expect(resolved.harness.every((resource) => resource.enabled && resource.metadata.origin === "package")).toBe(
			true,
		);

		// Mount lifecycle: the resource loader mounts skills AND read-only harness entries.
		const first = await reloadAndGetHarness();
		expect(first.diagnostics).toEqual([]);
		expect(Object.keys(first.state.entries.memory)).toEqual(["team_policy"]);
		expect(Object.keys(first.state.entries.prompt)).toEqual(["policy_note"]);
		expect(Object.keys(first.state.entries.skill)).toEqual(["shared_skill"]);
		expect(Object.keys(first.state.entries.subagent)).toEqual(["reviewer"]);
		const mounted = first.state.entries.memory.team_policy!;
		expect(mounted.provenance).toMatchObject({
			origin: "package",
			scope: "user",
			file: "harness/memory/team_policy.json",
			readOnly: true,
		});
		expect(loader.getSkills().skills.some((skill) => skill.name === "demo")).toBe(true);

		// The overlay is read-only: it never lands in the editable global store.
		const globalState: HarnessState = createEmptyPackageHarnessState();
		const digest = formatHarnessStateForPrompt(mergeHarnessStates(globalState, undefined, first.state), {
			includeIpythonExamples: true,
		});
		expect(digest).toContain("[package:team_policy]");
		expect(digest).toContain("read-only package; scope=user");
		expect(Object.keys(globalState.entries.memory)).toEqual([]);

		// Update lifecycle: a package edit refreshes the overlay on reload.
		writePackageFile(
			"harness/memory/team_policy.json",
			harnessJson("memory", "team_policy", { content: "updated policy content" }),
		);
		writePackageFile("harness/memory/new_policy.json", harnessJson("memory", "new_policy"));
		const updated = await reloadAndGetHarness();
		expect(updated.state.entries.memory.team_policy?.content).toBe("updated policy content");
		expect(Object.keys(updated.state.entries.memory).sort()).toEqual(["new_policy", "team_policy"]);

		// Remove lifecycle: uninstalling the package unmounts every overlay entry.
		await packageManager.removeAndPersist(packageDir);
		const removed = await reloadAndGetHarness();
		expect(removed.state.entries).toEqual(createEmptyPackageHarnessState().entries);
		expect(removed.diagnostics).toEqual([]);
	});

	it("keeps editable entries shadowing package overlays across the full merge path", { timeout: 20_000 }, async () => {
		await packageManager.installAndPersist(packageDir);
		const mounted = await reloadAndGetHarness();

		// An editable local entry with the same id wins over the package overlay.
		const editable: HarnessEntry = {
			id: "team_policy",
			kind: "memory",
			title: "session override",
			content: "session override content",
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "agent",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			version: 1,
		};
		const localState: HarnessState = createEmptyPackageHarnessState();
		localState.entries.memory.team_policy = editable;

		const merged = mergeHarnessStates(createEmptyPackageHarnessState(), localState, mounted.state);
		expect(merged.entries.memory.team_policy?.title).toBe("session override");
		expect(merged.entries.memory.team_policy?.provenance).toBeUndefined();
	});

	it("reports diagnostics for malformed package harness files without failing the mount", {
		timeout: 20_000,
	}, async () => {
		writePackageFile("harness/memory/broken.json", "{ not json");
		await packageManager.installAndPersist(packageDir);

		const mounted = await reloadAndGetHarness();

		expect(Object.keys(mounted.state.entries.memory)).toEqual(["team_policy"]);
		expect(mounted.diagnostics).toHaveLength(1);
		expect(mounted.diagnostics[0]?.type).toBe("warning");
		expect(mounted.diagnostics[0]?.message).toContain("failed to read package harness entry");
	});
});
