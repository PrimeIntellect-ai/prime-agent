import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { Skill } from "../../src/core/skills.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { SERPER_CREDENTIAL_ID, SERPER_ENV_VAR, WEBSEARCH_SKILL_NAME } from "../../src/core/websearch-credential.js";
import { KernelEnvironment, type KernelEnvironmentHost } from "../../src/session/kernel-environment.js";

function createEnvironment(overrides: Partial<KernelEnvironmentHost> = {}, sessionDir?: string) {
	return new KernelEnvironment(
		{
			authStorage: AuthStorage.inMemory(),
			resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
			getDepth: () => 0,
			getMaxDepth: () => 3,
			getArtifactDir: () => undefined,
			getLocalHarnessStateDir: () => undefined,
			...overrides,
		},
		sessionDir,
	);
}

describe("KernelEnvironment", () => {
	const directories: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("reuses the explicit root while reading current depth and harness location", () => {
		const root = mkdtempSync(join(tmpdir(), "session-env-"));
		directories.push(root);
		const sessionDir = join(root, "shared");
		let depth = 0;
		let maxDepth = 2;
		let harness = join(root, "first");
		const environment = createEnvironment(
			{
				getDepth: () => depth,
				getMaxDepth: () => maxDepth,
				getLocalHarnessStateDir: () => harness,
				getArtifactDir: () => join(root, "other"),
			},
			sessionDir,
		);
		expect(existsSync(sessionDir)).toBe(false);
		expect(environment.buildEnv()).toMatchObject({
			RLM_SESSION_DIR: sessionDir,
			RLM_DEPTH: "0",
			RLM_MAX_DEPTH: "2",
			RLM_HARNESS_STATE_DIR: harness,
		});
		expect(existsSync(sessionDir)).toBe(true);
		depth = 1;
		maxDepth = 4;
		harness = join(root, "second");
		expect(environment.buildEnv()).toMatchObject({
			RLM_SESSION_DIR: sessionDir,
			RLM_DEPTH: "1",
			RLM_MAX_DEPTH: "4",
			RLM_HARNESS_STATE_DIR: harness,
		});
	});

	it("keeps ephemeral allocation lazy and uses its directory on later provisioning", () => {
		const environment = createEnvironment();
		expect(environment.ensureSessionDir()).toBeUndefined();
		expect(environment.buildEnv()).not.toHaveProperty("RLM_SESSION_DIR");
		const directory = environment.createEphemeralSessionDir();
		directories.push(directory);
		expect(environment.ensureSessionDir()).toBe(directory);
		expect(environment.buildEnv().RLM_SESSION_DIR).toBe(directory);
	});

	it("reads loaded skills and credentials again without overriding an inherited websearch key", () => {
		vi.stubEnv(SERPER_ENV_VAR, "");
		const authStorage = AuthStorage.inMemory();
		authStorage.set(SERPER_CREDENTIAL_ID, { type: "api_key", key: "first" });
		const skills: Skill[] = [];
		const environment = createEnvironment({
			authStorage,
			resourceLoader: { getSkills: () => ({ skills, diagnostics: [] }) },
		});
		expect(environment.buildEnv()).not.toHaveProperty(SERPER_ENV_VAR);
		skills.push({
			kind: "markdown",
			name: WEBSEARCH_SKILL_NAME,
			description: "search",
			filePath: "/skills/search/SKILL.md",
			baseDir: "/skills/search",
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo("<test:search>", { source: "test" }),
		});
		expect(environment.buildEnv()[SERPER_ENV_VAR]).toBe("first");
		authStorage.set(SERPER_CREDENTIAL_ID, { type: "api_key", key: "second" });
		expect(environment.buildEnv()[SERPER_ENV_VAR]).toBe("second");
		vi.stubEnv(SERPER_ENV_VAR, "inherited");
		expect(environment.buildEnv()).not.toHaveProperty(SERPER_ENV_VAR);
	});
});
