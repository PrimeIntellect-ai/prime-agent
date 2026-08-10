import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Args, parseArgs } from "../src/cli/args.js";
import { type ProjectTrustPromptOption, resolveCliProjectTrust } from "../src/cli/project-trust.js";
import type { AgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { ProjectTrustSelection } from "../src/core/project-trust.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ProjectTrustStore } from "../src/core/trust-manager.js";
import type { AppMode } from "../src/main.js";
import * as mainModule from "../src/main.js";

type SelectProjectTrust = (options: readonly ProjectTrustPromptOption[]) => Promise<ProjectTrustSelection | undefined>;

interface MainProjectTrustResolver {
	resolve(options: {
		finalCwd: string;
		appMode: AppMode;
		select?: SelectProjectTrust;
		onDiagnostic?: (message: string) => void;
	}): Promise<boolean>;
}

interface MainTrustStartupSeams {
	createMainProjectTrustResolver(options: {
		startupCwd: string;
		agentDir: string;
		trustOverride?: boolean;
	}): MainProjectTrustResolver;
	runtimeConfigFromArgs(
		parsed: Args,
		cwd: string,
		agentDir: string,
		sessionDir: string | undefined,
		appMode: AppMode,
		telemetryDisabled: true | undefined,
		projectTrusted: boolean,
	): AgentSessionRuntimeConfig;
}

const projectedMain = mainModule as typeof mainModule & Partial<MainTrustStartupSeams>;

function requireMainTrustStartupSeams(): MainTrustStartupSeams {
	const createMainProjectTrustResolver = projectedMain.createMainProjectTrustResolver;
	const runtimeConfigFromArgs = projectedMain.runtimeConfigFromArgs;
	if (typeof createMainProjectTrustResolver !== "function") {
		throw new Error("main.ts must export createMainProjectTrustResolver for cwd-bound trust resolution");
	}
	if (typeof runtimeConfigFromArgs !== "function") {
		throw new Error("main.ts must export runtimeConfigFromArgs so the resolved trust decision is observable");
	}
	return { createMainProjectTrustResolver, runtimeConfigFromArgs };
}

interface TrustFixture {
	root: string;
	agentDir: string;
	startupCwd: string;
	finalCwd: string;
	siblingCwd: string;
}

function writeJson(path: string, value: object): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createTrustRequiringProject(cwd: string): void {
	const configDir = join(cwd, ".prime", "agent");
	mkdirSync(configDir, { recursive: true });
	// A project setting must not be able to opt its own directory into trust.
	writeJson(join(configDir, "settings.json"), { defaultProjectTrust: "always" });
}

function createFixture(): TrustFixture {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-main-trust-"));
	const agentDir = join(root, "agent");
	const startupCwd = join(root, "launch-project");
	const finalCwd = join(root, "selected-project");
	const siblingCwd = join(root, "sibling-project");
	mkdirSync(agentDir, { recursive: true });
	writeJson(join(agentDir, "settings.json"), { defaultProjectTrust: "ask" });
	createTrustRequiringProject(startupCwd);
	createTrustRequiringProject(finalCwd);
	createTrustRequiringProject(siblingCwd);
	return { root, agentDir, startupCwd, finalCwd, siblingCwd };
}

function readStoredTrust(agentDir: string): Record<string, boolean> {
	const trustPath = join(agentDir, "trust.json");
	if (!existsSync(trustPath)) {
		return {};
	}
	return JSON.parse(readFileSync(trustPath, "utf8")) as Record<string, boolean>;
}

const NON_INTERACTIVE_MODES = ["print", "json", "rpc", "acp", "daemon"] as const satisfies readonly AppMode[];

const INTERACTIVE_DECISIONS = [
	{ selection: "trust", trusted: true, storedAt: "cwd" },
	{ selection: "trust-parent", trusted: true, storedAt: "parent" },
	{ selection: "trust-session", trusted: true, storedAt: null },
	{ selection: "do-not-trust", trusted: false, storedAt: "cwd" },
	{ selection: "do-not-trust-session", trusted: false, storedAt: null },
] as const satisfies readonly {
	selection: ProjectTrustSelection;
	trusted: boolean;
	storedAt: "cwd" | "parent" | null;
}[];

describe("main project-trust startup integration", () => {
	let fixture: TrustFixture;

	beforeEach(() => {
		fixture = createFixture();
	});

	afterEach(() => {
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it("resolves trust from the final selected session cwd rather than the launch cwd", async () => {
		const seams = requireMainTrustStartupSeams();
		const trustStore = new ProjectTrustStore(fixture.agentDir);
		trustStore.set(fixture.startupCwd, false);
		trustStore.set(fixture.finalCwd, true);
		const resolver = seams.createMainProjectTrustResolver({
			startupCwd: fixture.startupCwd,
			agentDir: fixture.agentDir,
		});

		await expect(resolver.resolve({ finalCwd: fixture.finalCwd, appMode: "print" })).resolves.toBe(true);
	});

	it.each([
		{ args: ["--approve"], saved: false, expected: true },
		{ args: ["--no-approve"], saved: true, expected: false },
	] as const)("applies $args as a non-persistent one-run decision", async ({ args, saved, expected }) => {
		const seams = requireMainTrustStartupSeams();
		const parsed = parseArgs([...args]);
		const trustStore = new ProjectTrustStore(fixture.agentDir);
		trustStore.set(fixture.finalCwd, saved);
		const resolver = seams.createMainProjectTrustResolver({
			startupCwd: fixture.startupCwd,
			agentDir: fixture.agentDir,
			trustOverride: parsed.projectTrustOverride,
		});

		await expect(resolver.resolve({ finalCwd: fixture.finalCwd, appMode: "print" })).resolves.toBe(expected);
		expect(trustStore.get(fixture.finalCwd)).toBe(saved);
	});

	it.each(NON_INTERACTIVE_MODES)("treats global ask as untrusted in %s mode", async (appMode) => {
		const seams = requireMainTrustStartupSeams();
		const resolver = seams.createMainProjectTrustResolver({
			startupCwd: fixture.startupCwd,
			agentDir: fixture.agentDir,
		});

		await expect(resolver.resolve({ finalCwd: fixture.finalCwd, appMode })).resolves.toBe(false);
		expect(new ProjectTrustStore(fixture.agentDir).get(fixture.finalCwd)).toBeNull();
	});

	it.each([true, false] as const)(
		"carries projectTrusted=%s in the main runtime and daemon-default config",
		(projectTrusted) => {
			const seams = requireMainTrustStartupSeams();
			const config = seams.runtimeConfigFromArgs(
				parseArgs([]),
				fixture.finalCwd,
				fixture.agentDir,
				undefined,
				"print",
				undefined,
				projectTrusted,
			);

			expect(Object.hasOwn(config, "projectTrusted")).toBe(true);
			expect(config).toMatchObject({ cwd: fixture.finalCwd, projectTrusted });
			expect(mainModule.daemonServerDefaultSessionConfig(config).projectTrusted).toBe(projectTrusted);
		},
	);

	it("re-resolves trust after a cwd switch without leaking a session-only sibling decision", async () => {
		const seams = requireMainTrustStartupSeams();
		const resolver = seams.createMainProjectTrustResolver({
			startupCwd: fixture.startupCwd,
			agentDir: fixture.agentDir,
		});
		let selections = 0;

		const firstDecision = await resolver.resolve({
			finalCwd: fixture.finalCwd,
			appMode: "interactive",
			select: async () => {
				selections += 1;
				return "trust-session";
			},
		});
		const siblingDecision = await resolver.resolve({
			finalCwd: fixture.siblingCwd,
			appMode: "print",
		});

		expect(firstDecision).toBe(true);
		expect(siblingDecision).toBe(false);
		expect(selections).toBe(1);
		const trustStore = new ProjectTrustStore(fixture.agentDir);
		expect(trustStore.get(fixture.finalCwd)).toBeNull();
		expect(trustStore.get(fixture.siblingCwd)).toBeNull();
	});
});

describe("interactive project-trust resolver decisions", () => {
	let fixture: TrustFixture;

	beforeEach(() => {
		fixture = createFixture();
	});

	afterEach(() => {
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it.each(INTERACTIVE_DECISIONS)(
		"resolves $selection without driving a terminal",
		async ({ selection, trusted, storedAt }) => {
			let promptOptions: readonly ProjectTrustPromptOption[] | undefined;
			const settingsManager = SettingsManager.create(fixture.finalCwd, fixture.agentDir, {
				projectTrusted: false,
			});

			await expect(
				resolveCliProjectTrust({
					cwd: fixture.finalCwd,
					agentDir: fixture.agentDir,
					settingsManager,
					interactive: true,
					select: async (options) => {
						promptOptions = options;
						return selection;
					},
				}),
			).resolves.toBe(trusted);

			expect(promptOptions).toEqual([
				{ value: "trust", label: "Trust" },
				{
					value: "trust-parent",
					label: `Trust parent folder (${dirname(realpathSync(fixture.finalCwd))})`,
				},
				{ value: "trust-session", label: "Trust (this session only)" },
				{ value: "do-not-trust", label: "Do not trust" },
				{ value: "do-not-trust-session", label: "Do not trust (this session only)" },
			]);

			const stored = readStoredTrust(fixture.agentDir);
			if (storedAt === null) {
				expect(stored).toEqual({});
				return;
			}
			const storedPath =
				storedAt === "cwd" ? realpathSync(fixture.finalCwd) : dirname(realpathSync(fixture.finalCwd));
			expect(stored).toEqual({ [storedPath]: trusted });
		},
	);
});
