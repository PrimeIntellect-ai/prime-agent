import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSkillTrustExtension } from "../../../src/core/extensions/builtin/project-skill-trust.js";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.js";
import {
	createInMemoryProjectSkillTrustStore,
	PROJECT_SKILL_TRUST_CHOICES,
	PROJECT_SKILL_TRUST_COMMAND,
	type ProjectSkillTrustStore,
} from "../../../src/core/project-skill-trust.js";
import type { PythonSkill, PythonSkillRuntimeInfo } from "../../../src/core/skills.js";
import { createSyntheticSourceInfo, type SourceScope } from "../../../src/core/source-info.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

const PROJECT_SKILL = "marker-skill";
const USER_SKILL = "web-search";

function pythonSkill(root: string, name: string, scope: SourceScope): PythonSkill {
	const skillDir = join(root, scope, name);
	const filePath = join(skillDir, "SKILL.md");
	return {
		kind: "python",
		name,
		description: `${name} skill`,
		filePath,
		baseDir: skillDir,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope, baseDir: skillDir }),
		disableModelInvocation: false,
		python: {
			importName: name.replaceAll("-", "_"),
			packagePath: skillDir,
			pyprojectPath: join(skillDir, "pyproject.toml"),
		},
	};
}

/** Python skills the session hands to the kernel provisioner (what gets installed and imported). */
function kernelPythonSkills(harness: Harness): PythonSkillRuntimeInfo[] {
	const provisioner = Reflect.get(harness.session, "_ipythonKernelProvisioner") as object | undefined;
	expect(provisioner).toBeDefined();
	const options = Reflect.get(provisioner!, "options") as { pythonSkills?: readonly PythonSkillRuntimeInfo[] };
	return [...(options.pythonSkills ?? [])];
}

function kernelImportNames(harness: Harness): string[] {
	return kernelPythonSkills(harness).map((skill) => skill.importName);
}

function promptSkillEntry(harness: Harness, name: string): string {
	const match = harness.session.systemPrompt.match(new RegExp(`<skill>\\s*<name>${name}</name>[\\s\\S]*?</skill>`));
	expect(match, `skill ${name} listed in the system prompt`).not.toBeNull();
	return match![0];
}

function createUi(select: ExtensionUIContext["select"]): {
	ui: ExtensionUIContext;
	notifications: Array<{ message: string; type?: string }>;
} {
	const notifications: Array<{ message: string; type?: string }> = [];
	const ui = {
		select,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string, type?: string) => {
			notifications.push({ message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
	} as unknown as ExtensionUIContext;
	return { ui, notifications };
}

describe("ENG-5338: project Python skills require an explicit trust decision", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createSkillHarness(options?: {
		store?: ProjectSkillTrustStore;
		withCommand?: boolean;
	}): Promise<{ harness: Harness; store: ProjectSkillTrustStore; skills: PythonSkill[] }> {
		const store = options?.store ?? createInMemoryProjectSkillTrustStore();
		// Skills are resolved lazily so the root can be the harness temp dir.
		let skills: PythonSkill[] = [];
		const extensionsResult = options?.withCommand
			? await createTestExtensionsResult([createProjectSkillTrustExtension({ store, getSkills: () => skills })])
			: undefined;
		const resourceLoader = createTestResourceLoader({ extensionsResult });
		resourceLoader.getSkills = () => ({ skills, diagnostics: [] });
		const harness = await createHarness({ resourceLoader, projectSkillTrust: store });
		harnesses.push(harness);
		skills = [
			pythonSkill(harness.tempDir, PROJECT_SKILL, "project"),
			pythonSkill(harness.tempDir, USER_SKILL, "user"),
		];
		// The harness built its runtime before the skills existed; rebuild the way /reload does.
		await harness.session.reload();
		return { harness, store, skills };
	}

	it("keeps untrusted project Python skills out of the kernel and the python_import surface", async () => {
		const { harness } = await createSkillHarness();

		expect(harness.session.getProjectSkillTrust()).toEqual({
			decision: "undecided",
			skills: [expect.objectContaining({ name: PROJECT_SKILL, importName: "marker_skill" })],
		});
		// The kernel provisioner never sees the project package, so nothing is built or imported.
		expect(kernelImportNames(harness)).toEqual(["web_search"]);
		// The SKILL.md stays readable as a markdown skill; the user-level skill is untouched.
		const projectEntry = promptSkillEntry(harness, PROJECT_SKILL);
		expect(projectEntry).toContain("<type>markdown</type>");
		expect(projectEntry).not.toContain("python_import");
		const userEntry = promptSkillEntry(harness, USER_SKILL);
		expect(userEntry).toContain("<type>python</type>");
		expect(userEntry).toContain("<python_import>web_search</python_import>");
	});

	it("never prompts and stays denied when no UI is bound (headless modes)", async () => {
		const { harness, store } = await createSkillHarness();

		await harness.session.bindExtensions({});
		await new Promise((resolve) => setImmediate(resolve));

		expect(store.getDecision(harness.tempDir)).toBe("undecided");
		expect(kernelImportNames(harness)).toEqual(["web_search"]);
	});

	it("installs the project skills only after the user trusts the project in the UI prompt", async () => {
		const { harness, store } = await createSkillHarness();
		const select = vi.fn(async (title: string, options: string[]) => {
			expect(title).toContain(PROJECT_SKILL);
			expect(title).not.toContain(USER_SKILL);
			expect(options).toEqual([
				PROJECT_SKILL_TRUST_CHOICES.trust,
				PROJECT_SKILL_TRUST_CHOICES.notNow,
				PROJECT_SKILL_TRUST_CHOICES.never,
			]);
			return PROJECT_SKILL_TRUST_CHOICES.trust;
		});
		const { ui, notifications } = createUi(select);

		await harness.session.bindExtensions({ uiContext: ui });
		await vi.waitFor(() => expect(store.getDecision(harness.tempDir)).toBe("trusted"));

		expect(select).toHaveBeenCalledTimes(1);
		expect(harness.session.getProjectSkillTrust().decision).toBe("trusted");
		expect(kernelPythonSkills(harness)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ importName: "marker_skill", scope: "project" }),
				expect.objectContaining({ importName: "web_search", scope: "user" }),
			]),
		);
		expect(promptSkillEntry(harness, PROJECT_SKILL)).toContain("<python_import>marker_skill</python_import>");
		expect(notifications.some((n) => n.message.includes(PROJECT_SKILL) && n.type === "info")).toBe(true);

		// Re-binding (e.g. a client reattach) never asks a second time.
		await harness.session.bindExtensions({ uiContext: ui });
		await new Promise((resolve) => setImmediate(resolve));
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("persists a 'never' answer and keeps the project skills disabled", async () => {
		const { harness, store } = await createSkillHarness();
		const select = vi.fn(async () => PROJECT_SKILL_TRUST_CHOICES.never);
		const { ui } = createUi(select);

		await harness.session.bindExtensions({ uiContext: ui });
		await vi.waitFor(() => expect(store.getDecision(harness.tempDir)).toBe("denied"));

		expect(kernelImportNames(harness)).toEqual(["web_search"]);
		expect(promptSkillEntry(harness, PROJECT_SKILL)).not.toContain("python_import");
	});

	it("does not persist a 'not now' answer or a dismissed prompt", async () => {
		const { harness, store } = await createSkillHarness();
		const { ui, notifications } = createUi(async () => PROJECT_SKILL_TRUST_CHOICES.notNow);

		await harness.session.bindExtensions({ uiContext: ui });
		await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(0));

		expect(store.getDecision(harness.tempDir)).toBe("undecided");
		expect(notifications[0]).toMatchObject({ type: "warning" });
		expect(notifications[0]?.message).toContain(`/${PROJECT_SKILL_TRUST_COMMAND}`);
		expect(kernelImportNames(harness)).toEqual(["web_search"]);
	});

	it("applies a persisted trust decision at startup without prompting", async () => {
		const store = createInMemoryProjectSkillTrustStore();
		const select = vi.fn(async () => PROJECT_SKILL_TRUST_CHOICES.never);
		const { ui } = createUi(select);
		// Decide before the session builds its runtime.
		const resourceLoader = createTestResourceLoader();
		let skills: PythonSkill[] = [];
		resourceLoader.getSkills = () => ({ skills, diagnostics: [] });
		const harness = await createHarness({ resourceLoader, projectSkillTrust: store });
		harnesses.push(harness);
		store.setDecision(harness.tempDir, "trusted");
		skills = [pythonSkill(harness.tempDir, PROJECT_SKILL, "project")];
		await harness.session.reload();

		await harness.session.bindExtensions({ uiContext: ui });
		await new Promise((resolve) => setImmediate(resolve));

		expect(select).not.toHaveBeenCalled();
		expect(kernelImportNames(harness)).toEqual(["marker_skill"]);
		expect(promptSkillEntry(harness, PROJECT_SKILL)).toContain("<python_import>marker_skill</python_import>");
	});

	it("/trust-project-skills changes the persisted decision and reloads the runtime", async () => {
		const { harness, store } = await createSkillHarness({ withCommand: true });
		let reloads = 0;
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {
					reloads += 1;
					await harness.session.reload();
				},
			},
		});

		await harness.session.prompt(`/${PROJECT_SKILL_TRUST_COMMAND} on`);
		expect(store.getDecision(harness.tempDir)).toBe("trusted");
		expect(reloads).toBe(1);
		expect(kernelImportNames(harness)).toEqual(expect.arrayContaining(["marker_skill", "web_search"]));

		await harness.session.prompt(`/${PROJECT_SKILL_TRUST_COMMAND} off`);
		expect(store.getDecision(harness.tempDir)).toBe("denied");
		expect(reloads).toBe(2);
		expect(kernelImportNames(harness)).toEqual(["web_search"]);

		await harness.session.prompt(`/${PROJECT_SKILL_TRUST_COMMAND} reset`);
		expect(store.getDecision(harness.tempDir)).toBe("undecided");
	});
});
