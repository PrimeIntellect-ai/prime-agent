import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import {
	formatHarnessStateForPrompt,
	getGlobalHarnessStateDir,
	type HarnessEntry,
	type HarnessState,
	saveHarnessState,
} from "../../../src/core/refinement/index.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { buildSystemPrompt } from "../../../src/core/system-prompt.js";
import { createHarness, type Harness } from "../harness.js";

function entry(overrides: Partial<HarnessEntry> & Pick<HarnessEntry, "id">): HarnessEntry {
	return {
		kind: "memory",
		title: overrides.id,
		content: "content",
		path: "general",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function stateWith(memory: HarnessEntry[]): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: Object.fromEntries(memory.map((item) => [item.id, item])),
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function renderedIds(overview: string): string[] {
	return [...overview.matchAll(/^- \[(?:local|global):([\w-]+)\]/gm)].map((match) => match[1]);
}

/**
 * The overview is the model's only view of continual harness state. Before this fix
 * the surviving entries were the alphabetically-first 6 per kind, so which lessons
 * reached the model depended on how their paths happened to be spelled, and the
 * remaining entries were named by a bare count with no way to read them.
 */
describe("issue #819 continual harness overview reachability", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];
	const originalAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("keeps the most recently updated entries when the per-kind cap truncates", () => {
		const entries: HarnessEntry[] = [];
		for (let index = 0; index < 48; index++) {
			const letter = String.fromCharCode(97 + (index % 26));
			const id = `mem-${String(index).padStart(3, "0")}`;
			entries.push(
				entry({
					id,
					title: `${letter}-lesson-${index}`,
					path: `memory/${letter}/${letter}-lesson-${index}.md`,
					content: `Older lesson ${index}.`,
					updated_at: "2026-01-01T00:00:00.000Z",
				}),
			);
		}
		// Newest entry, highest version, but its path sorts last alphabetically.
		entries.push(
			entry({
				id: "mem-new",
				title: "workspace-resolver-fix",
				path: "memory/w/workspace-resolver-fix.md",
				content: "Just learned: the resolver error is caused by a stale lockfile.",
				updated_at: "2026-08-07T12:00:00.000Z",
				version: 7,
			}),
		);

		const shown = renderedIds(formatHarnessStateForPrompt(stateWith(entries)));

		expect(shown).toHaveLength(6);
		expect(shown[0]).toBe("mem-new");
	});

	it("falls back to created_at and stays deterministic for entries with equal recency", () => {
		const overview = formatHarnessStateForPrompt(
			stateWith([
				entry({ id: "zeta", path: "z", updated_at: "not-a-date", created_at: "2026-05-01T00:00:00.000Z" }),
				entry({ id: "alpha", path: "a", updated_at: "not-a-date", created_at: "2026-01-01T00:00:00.000Z" }),
				entry({ id: "tie-b", path: "m", updated_at: "2026-03-01T00:00:00.000Z", version: 2 }),
				entry({ id: "tie-a", path: "m", updated_at: "2026-03-01T00:00:00.000Z", version: 9 }),
			]),
		);

		// zeta/alpha have unparseable updated_at, so created_at orders them; tie-a and
		// tie-b share a timestamp and are ordered by version.
		expect(renderedIds(overview)).toEqual(["zeta", "tie-a", "tie-b", "alpha"]);
	});

	it("names the call that reads the entries the cap hid", () => {
		const entries = Array.from({ length: 10 }, (_, index) => entry({ id: `mem-${index}` }));

		const withIpython = formatHarnessStateForPrompt(stateWith(entries), { includeIpythonExamples: true });
		expect(withIpython).toContain("+4 more memory entries not shown");
		expect(withIpython).toContain('rlm.harness.list("memory")');
		expect(withIpython).toContain('rlm.harness.list("memory", global_=True)');

		const withoutIpython = formatHarnessStateForPrompt(stateWith(entries), { includeIpythonExamples: false });
		expect(withoutIpython).toContain("+4 more memory entries not shown");
		expect(withoutIpython).toContain("harnessOverview.maxEntriesPerKind");
		expect(withoutIpython).not.toContain("rlm.harness.list");
	});

	it("clamps out-of-range overview budgets instead of trusting them", () => {
		const entries = Array.from({ length: 3 }, (_, index) => entry({ id: `mem-${index}` }));

		expect(renderedIds(formatHarnessStateForPrompt(stateWith(entries), { maxEntriesPerKind: -5 }))).toEqual([]);
		expect(
			renderedIds(formatHarnessStateForPrompt(stateWith(entries), { maxEntriesPerKind: Number.NaN })),
		).toHaveLength(3);
		expect(renderedIds(formatHarnessStateForPrompt(stateWith(entries), { maxEntriesPerKind: 10_000 }))).toHaveLength(
			3,
		);

		const clampedContent = formatHarnessStateForPrompt(
			stateWith([entry({ id: "long", content: "abcdefghijklmnopqrstuvwxyz".repeat(10) })]),
			{ maxContentLength: 1 },
		);
		// Below the floor the clamp applies, so the body is still readable.
		expect(clampedContent).toContain("abcdefghijklmnopqrstuvwxyz");
	});

	it("reads harnessOverview from settings", () => {
		const settings = SettingsManager.inMemory({
			harnessOverview: { maxEntriesPerKind: 25, maxContentLength: 400 },
		});

		expect(settings.getHarnessOverviewSettings()).toEqual({ maxEntriesPerKind: 25, maxContentLength: 400 });
		expect(SettingsManager.inMemory().getHarnessOverviewSettings()).toEqual({
			maxEntriesPerKind: undefined,
			maxContentLength: undefined,
		});
	});

	it("applies harnessOverview to the built system prompt", () => {
		const entries = Array.from({ length: 12 }, (_, index) => entry({ id: `mem-${index}` }));

		const defaults = buildSystemPrompt({ cwd: process.cwd(), harnessState: stateWith(entries) });
		expect(renderedIds(defaults)).toHaveLength(6);

		const widened = buildSystemPrompt({
			cwd: process.cwd(),
			harnessState: stateWith(entries),
			harnessOverview: { maxEntriesPerKind: 12 },
		});
		expect(renderedIds(widened)).toHaveLength(12);
		expect(widened).not.toContain("more memory entries not shown");
	});

	it("carries the setting into a live session's system prompt", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-819-agent-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const entries: HarnessEntry[] = [];
		for (let index = 0; index < 12; index++) {
			entries.push(entry({ id: `mem-${String(index).padStart(2, "0")}`, path: `memory/${index}` }));
		}
		saveHarnessState(getGlobalHarnessStateDir(agentDir), stateWith(entries));

		const harness = await createHarness({ settings: { harnessOverview: { maxEntriesPerKind: 12 } } });
		harnesses.push(harness);

		expect(renderedIds(harness.session.systemPrompt)).toHaveLength(12);
	});
});
