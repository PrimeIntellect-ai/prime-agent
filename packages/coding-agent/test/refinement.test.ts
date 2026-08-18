import { appendFileSync, chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendGlobalRefinement,
	applyRefinementProposal,
	formatHarnessStateForPrompt,
	getGlobalHarnessStateDir,
	getHarnessStatePath,
	getLocalHarnessStateDir,
	getRefinementHistory,
	getRefinementHistoryPath,
	type HarnessState,
	inferRefinementResultScope,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	planRefinement,
	type RefinementAction,
	type RefinementKind,
	type RefinementProposal,
	type RefinementResult,
	refineHarness,
	saveHarnessState,
} from "../src/core/refinement/index.js";
import type { CustomEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

let tempDir: string | undefined;

beforeEach(() => {
	completeSimpleMock.mockReset();
});

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-refinement-test-"));
	return tempDir;
}

const kinds = ["prompt", "memory", "skill", "subagent"] as const satisfies readonly RefinementKind[];
const skillReference = {
	type: "python",
	import: "agent_skills.example",
	callable: "run",
	call_pattern: "await run(...)",
};

function proposal(summary: string, edits: RefinementProposal["edits"]): RefinementProposal {
	return {
		summary,
		rationale: `${summary} rationale`,
		expectedOutcome: `${summary} outcome`,
		edits,
	};
}

function createRefineModel(reasoning: boolean): Model<"openai-completions"> {
	return {
		id: "openai/gpt-5.5",
		name: "GPT 5.5",
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: "https://inference.primeintellect.ai/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "prime-inference",
		model: "openai/gpt-5.5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function seedEntry(state: HarnessState, kind: RefinementKind, id = `${kind}_entry`): void {
	const skillArguments =
		kind === "skill"
			? {
					reference: skillReference,
					arguments: { input: { type: "string", required: true, description: "Task input" } },
				}
			: {};
	applyRefinementProposal(
		state,
		proposal(`seed ${kind}`, [
			{
				action: "create",
				kind,
				id,
				title: `${kind} title`,
				content: `${kind} content`,
				path: `${kind}/path`,
				...skillArguments,
				metadata: { seeded: true },
			},
		]),
		{ id: `seed_${kind}_${id}` },
	);
}

describe("harness refinement", () => {
	it("rejects an edit when the target entry changed after planning", () => {
		const harnessStateDir = makeTempDir();
		const baselineState = loadHarnessState(harnessStateDir);
		seedEntry(baselineState, "memory");
		saveHarnessState(harnessStateDir, baselineState);
		const currentState = loadHarnessState(harnessStateDir);
		currentState.entries.memory.memory_entry.content = "concurrent kernel content";
		currentState.entries.memory.memory_entry.version++;

		const result = applyRefinementProposal(
			currentState,
			proposal("Update memory", [
				{
					action: "update",
					kind: "memory",
					id: "memory_entry",
					title: "Planned title",
					content: "stale planned content",
				},
			]),
			{ id: "refine_conflict", baselineState },
		);

		expect(result.appliedEdits).toMatchObject([
			{ applied: false, error: "entry changed during refinement planning" },
		]);
		expect(currentState.entries.memory.memory_entry.content).toBe("concurrent kernel content");
	});

	it("allows sequential edits to the same entry after the baseline matches once", () => {
		const state = loadHarnessState(makeTempDir(), "local");
		seedEntry(state, "memory");
		const baselineState = structuredClone(state);

		const result = applyRefinementProposal(
			state,
			proposal("Update memory twice", [
				{ action: "update", kind: "memory", id: "memory_entry", title: "First", content: "first" },
				{ action: "update", kind: "memory", id: "memory_entry", title: "Second", content: "second" },
			]),
			{ id: "refine_same_entry", baselineState, scope: "local" },
		);

		expect(result.appliedEdits.map((edit) => edit.applied)).toEqual([true, true]);
		expect(state.entries.memory.memory_entry.content).toBe("second");
		expect(state.entries.memory.memory_entry.version).toBe(3);
	});

	it("infers legacy refinement scope from applied edit snapshots", () => {
		const state = loadHarnessState(makeTempDir(), "global");
		seedEntry(state, "memory", "global_memory");
		const after = { ...state.entries.memory.global_memory, scope: "global" as const };
		const result: RefinementResult = {
			...proposal("Legacy global edit", []),
			id: "legacy",
			appliedEdits: [
				{
					action: "create",
					kind: "memory",
					id: "global_memory",
					applied: true,
					after,
				},
			],
			harnessStatePath: "",
		};

		expect(inferRefinementResultScope(result)).toBe("global");
	});

	it("atomically replaces harness state without leaving temporary files", () => {
		const harnessStateDir = makeTempDir();
		const state = loadHarnessState(harnessStateDir);
		seedEntry(state, "memory");

		const statePath = saveHarnessState(harnessStateDir, state);

		expect(loadHarnessState(harnessStateDir).entries.memory.memory_entry).toBeDefined();
		expect(readdirSync(harnessStateDir)).toEqual([statePath.split("/").at(-1)]);
		chmodSync(statePath, 0o600);
		saveHarnessState(harnessStateDir, state);
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
	});

	it("applies create, update, and delete for every editable harness kind", () => {
		const state = loadHarnessState(makeTempDir());

		const created = applyRefinementProposal(
			state,
			proposal(
				"Create all kinds",
				kinds.map((kind) => ({
					action: "create",
					kind,
					id: `${kind}_entry`,
					title: `${kind} title`,
					content: `${kind} content`,
					path: `${kind}/created`,
					...(kind === "skill"
						? {
								reference: skillReference,
								arguments: { input: { type: "string", required: true, description: "Task input" } },
							}
						: {}),
					metadata: { kind },
				})),
			),
			{ id: "refine_create_all" },
		);

		expect(created.appliedEdits).toHaveLength(kinds.length);
		for (const kind of kinds) {
			const edit = created.appliedEdits.find((item) => item.kind === kind);
			expect(edit?.applied).toBe(true);
			expect(edit?.before).toBeUndefined();
			expect(edit?.after?.version).toBe(1);
			expect(state.entries[kind][`${kind}_entry`]).toMatchObject({
				id: `${kind}_entry`,
				kind,
				title: `${kind} title`,
				content: `${kind} content`,
				path: `${kind}/created`,
				metadata: { kind },
				source: "refine",
				version: 1,
			});
		}
		expect(state.refinements.at(-1)?.changes).toEqual(kinds.map((kind) => `create ${kind}:${kind}_entry`));

		const updated = applyRefinementProposal(
			state,
			proposal(
				"Update all kinds",
				kinds.map((kind) => ({
					action: "update",
					kind,
					id: `${kind}_entry`,
					title: `${kind} title updated`,
					content: `${kind} content updated`,
					path: `${kind}/updated`,
					...(kind === "skill"
						? {
								reference: skillReference,
								arguments: {
									input: { type: "string", required: true, description: "Updated task input" },
								},
							}
						: {}),
					metadata: { updated: kind },
				})),
			),
			{ id: "refine_update_all" },
		);

		expect(updated.appliedEdits).toHaveLength(kinds.length);
		for (const kind of kinds) {
			const edit = updated.appliedEdits.find((item) => item.kind === kind);
			expect(edit?.applied).toBe(true);
			expect(edit?.before?.version).toBe(1);
			expect(edit?.after?.version).toBe(2);
			expect(state.entries[kind][`${kind}_entry`]).toMatchObject({
				title: `${kind} title updated`,
				content: `${kind} content updated`,
				path: `${kind}/updated`,
				metadata: { updated: kind },
				version: 2,
			});
		}
		expect(state.refinements.at(-1)?.changes).toEqual(kinds.map((kind) => `update ${kind}:${kind}_entry`));

		const deleted = applyRefinementProposal(
			state,
			proposal(
				"Delete all kinds",
				kinds.map((kind) => ({
					action: "delete",
					kind,
					id: `${kind}_entry`,
				})),
			),
			{ id: "refine_delete_all" },
		);

		expect(deleted.appliedEdits).toHaveLength(kinds.length);
		for (const kind of kinds) {
			const edit = deleted.appliedEdits.find((item) => item.kind === kind);
			expect(edit?.applied).toBe(true);
			expect(edit?.before?.version).toBe(2);
			expect(edit?.after).toBeUndefined();
			expect(state.entries[kind][`${kind}_entry`]).toBeUndefined();
		}
		expect(state.refinements.at(-1)?.changes).toEqual(kinds.map((kind) => `delete ${kind}:${kind}_entry`));
	});

	it("applies create, update, and delete edits to editable continual harness state", () => {
		const state = loadHarnessState(makeTempDir());
		const first = applyRefinementProposal(
			state,
			{
				summary: "Create reusable validation memory and skill",
				rationale: "The same validation issue repeated.",
				expectedOutcome: "Future runs validate through the target environment.",
				edits: [
					{
						action: "create",
						kind: "memory",
						id: "target_env_validation",
						title: "Target environment validation",
						content: "Run checks through the target repository environment.",
						path: "validation",
					},
					{
						action: "create",
						kind: "skill",
						id: "native_check",
						title: "Native check",
						content: "Use documented project commands for validation.",
						reference: {
							type: "python",
							import: "agent_skills.native_check",
							callable: "native_check",
							call_pattern: "await native_check(command=...)",
						},
						arguments: {
							command: { type: "string", required: false, description: "Optional command to validate." },
						},
					},
				],
			},
			{ id: "refine_1" },
		);
		const second = applyRefinementProposal(
			state,
			{
				summary: "Tighten validation skill",
				rationale: "The first skill was too vague.",
				expectedOutcome: "The agent names the exact command.",
				edits: [
					{
						action: "update",
						kind: "skill",
						id: "native_check",
						title: "Native check",
						content: "Use `npm run check` for this repo after code changes.",
						reference: {
							type: "python",
							import: "agent_skills.native_check",
							callable: "native_check",
							call_pattern: "await native_check(command=...)",
						},
						arguments: {
							command: { type: "string", required: false, description: "Optional command to validate." },
						},
					},
					{
						action: "delete",
						kind: "memory",
						id: "target_env_validation",
					},
				],
			},
			{ id: "refine_2" },
		);

		expect(first.appliedEdits).toHaveLength(2);
		expect(second.appliedEdits.filter((edit) => edit.applied)).toHaveLength(2);
		expect(state.entries.memory.target_env_validation).toBeUndefined();
		expect(state.entries.skill.native_check.content).toContain("npm run check");
		expect(state.entries.skill.native_check.version).toBe(2);
		expect(state.refinements.map((event) => event.id)).toEqual(["refine_1", "refine_2"]);
	});

	it("creates ids from titles and uses default path and metadata when omitted", () => {
		const state = loadHarnessState(makeTempDir());

		const result = applyRefinementProposal(
			state,
			proposal("Create with generated id", [
				{
					action: "create",
					kind: "skill",
					title: "Native Check!",
					content: "Run project-native checks.",
					reference: {
						type: "python",
						import: "agent_skills.native_check",
						callable: "native_check",
						call_pattern: "await native_check(command=...)",
					},
					arguments: {
						command: { type: "string", required: false, description: "Optional command override." },
					},
				},
			]),
			{ id: "refine_generated_id" },
		);

		expect(result.appliedEdits[0]).toMatchObject({
			applied: true,
			id: "native_check",
			after: {
				id: "native_check",
				path: "general",
				reference: {
					type: "python",
					import: "agent_skills.native_check",
					callable: "native_check",
					call_pattern: "await native_check(command=...)",
				},
				arguments: {
					command: { type: "string", required: false, description: "Optional command override." },
				},
				metadata: {},
				version: 1,
			},
		});
		expect(state.entries.skill.native_check.content).toBe("Run project-native checks.");
	});

	it("requires argument contracts for harness-created skills", () => {
		const state = loadHarnessState(makeTempDir());

		const missingArguments = applyRefinementProposal(
			state,
			proposal("Create skill without arguments", [
				{
					action: "create",
					kind: "skill",
					id: "argumentless_skill",
					title: "Argumentless skill",
					content: "This should not be accepted without an argument contract.",
				},
			]),
			{ id: "refine_missing_skill_arguments" },
		);
		const explicitNoArguments = applyRefinementProposal(
			state,
			proposal("Create skill with explicit empty arguments", [
				{
					action: "create",
					kind: "skill",
					id: "no_input_skill",
					title: "No input skill",
					content: "This skill intentionally needs no external inputs.",
					reference: skillReference,
					arguments: {},
				},
			]),
			{ id: "refine_empty_skill_arguments" },
		);

		expect(missingArguments.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "create skill requires arguments",
		});
		expect(state.entries.skill.argumentless_skill).toBeUndefined();
		expect(explicitNoArguments.appliedEdits[0]).toMatchObject({
			applied: true,
			after: { arguments: {} },
		});
	});

	it("requires Python references for harness-created skills", () => {
		const state = loadHarnessState(makeTempDir());

		const missingReference = applyRefinementProposal(
			state,
			proposal("Create skill without reference", [
				{
					action: "create",
					kind: "skill",
					id: "unbacked_skill",
					title: "Unbacked skill",
					content: "This should not be accepted without a Python reference.",
					arguments: {},
				},
			]),
			{ id: "refine_missing_skill_reference" },
		);
		const nonPythonReference = applyRefinementProposal(
			state,
			proposal("Create skill with non-python reference", [
				{
					action: "create",
					kind: "skill",
					id: "shell_skill",
					title: "Shell skill",
					content: "This should not be accepted as a harness skill.",
					reference: { type: "shell", command: "edit" },
					arguments: {},
				},
			]),
			{ id: "refine_non_python_skill_reference" },
		);

		expect(missingReference.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "create skill requires python reference",
		});
		expect(nonPythonReference.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "create skill reference.type must be python",
		});
		expect(state.entries.skill.unbacked_skill).toBeUndefined();
		expect(state.entries.skill.shell_skill).toBeUndefined();
	});

	it("uses a global harness state directory under the agent dir by default", () => {
		const agentDir = makeTempDir();
		const harnessDir = getGlobalHarnessStateDir(agentDir);

		expect(harnessDir).toBe(join(agentDir, "harness"));
		expect(getHarnessStatePath(harnessDir)).toBe(join(agentDir, "harness", "harness_state.json"));
	});

	it("uses a local harness state directory under the session artifact dir", () => {
		const artifactDir = makeTempDir();

		expect(getLocalHarnessStateDir(artifactDir)).toBe(join(artifactDir, "harness"));
		expect(getLocalHarnessStateDir(undefined)).toBeUndefined();
	});

	it("merges global and local harness state without hiding colliding entries", () => {
		const root = makeTempDir();
		const globalState = loadHarnessState(join(root, "global"), "global");
		const localState = loadHarnessState(join(root, "local"), "local");
		applyRefinementProposal(
			globalState,
			proposal("Global note", [
				{
					action: "create",
					kind: "memory",
					id: "shared",
					title: "Shared",
					content: "Global content.",
				},
			]),
			{ id: "refine_global", scope: "global" },
		);
		applyRefinementProposal(
			localState,
			proposal("Local note", [
				{
					action: "create",
					kind: "memory",
					id: "shared",
					title: "Shared",
					content: "Local content.",
				},
			]),
			{ id: "refine_local", scope: "local" },
		);

		const merged = mergeHarnessStates(globalState, localState);

		expect(merged.entries.memory.shared.content).toBe("Global content.");
		expect(merged.entries.memory.shared.scope).toBe("global");
		expect(merged.entries.memory["local:shared"]).toMatchObject({
			id: "shared",
			content: "Local content.",
			scope: "local",
		});
		expect(Object.values(merged.entries.memory).map((entry) => `${entry.scope}:${entry.content}`)).toEqual(
			expect.arrayContaining(["global:Global content.", "local:Local content."]),
		);
		const promptOverview = formatHarnessStateForPrompt(merged);
		expect(promptOverview).toContain("[global:shared]");
		expect(promptOverview).toContain("[local:shared]");
		expect(globalState.entries.memory.shared.scope).toBe("global");
	});

	it("preserves entry scope stored inside the global harness file", () => {
		const root = makeTempDir();
		const globalState = loadHarnessState(join(root, "global"), "global");
		applyRefinementProposal(
			globalState,
			proposal("Session-local note in shared file", [
				{
					action: "create",
					kind: "memory",
					id: "session_note",
					title: "Session note",
					content: "Written by a local RLM harness store in a shared file.",
				},
			]),
			{ id: "refine_local_in_global_file", scope: "local" },
		);

		const merged = mergeHarnessStates(globalState);

		expect(merged.entries.memory.session_note.scope).toBe("local");
	});

	it("persists harness state in the selected harness directory", () => {
		const dir = makeTempDir();
		const state = loadHarnessState(dir, "local");
		applyRefinementProposal(
			state,
			{
				summary: "Add prompt note",
				rationale: "The note is useful.",
				expectedOutcome: "The agent remembers the note.",
				edits: [
					{
						action: "create",
						kind: "prompt",
						id: "focused_edits",
						title: "Focused edits",
						content: "Prefer small harness edits.",
					},
				],
			},
			{ id: "refine_1" },
		);

		const statePath = saveHarnessState(dir, state);
		const reloaded = loadHarnessState(dir, "local");

		expect(statePath.endsWith("harness_state.json")).toBe(true);
		expect(reloaded.entries.prompt.focused_edits.content).toBe("Prefer small harness edits.");
		expect(reloaded.entries.prompt.focused_edits.scope).toBe("local");
		expect(reloaded.refinements[0]).toMatchObject({
			id: "refine_1",
			trigger: "Add prompt note",
			changes: ["create prompt:focused_edits"],
		});
	});

	it.each(["not json at all", "null", "[]", '"a string"', "123"])(
		"loads empty harness state from a corrupt or non-object file (%s)",
		(payload) => {
			const dir = makeTempDir();
			writeFileSync(getHarnessStatePath(dir), payload, "utf8");

			const state = loadHarnessState(dir);

			expect(state.entries).toEqual({ prompt: {}, memory: {}, skill: {}, subagent: {} });
			expect(state.refinements).toEqual([]);
			// Still usable: a refinement applies and persists cleanly over the bad file.
			applyRefinementProposal(
				state,
				proposal("Recover", [
					{ action: "create", kind: "memory", id: "recovered", title: "Recovered", content: "ok" },
				]),
				{ id: "refine_recover" },
			);
			saveHarnessState(dir, state);
			expect(loadHarnessState(dir).entries.memory.recovered.content).toBe("ok");
		},
	);

	it("extracts refinement history from custom session entries", () => {
		const result: RefinementResult = {
			id: "refine_1",
			summary: "Add skill",
			rationale: "Repeated failure.",
			expectedOutcome: "Better validation.",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		};
		const entries: CustomEntry[] = [
			{
				type: "custom",
				customType: "other",
				data: {},
				id: "custom_1",
				parentId: null,
				timestamp: new Date().toISOString(),
			},
			{
				type: "custom",
				customType: "prime-agent.refinement",
				data: result,
				id: "custom_2",
				parentId: "custom_1",
				timestamp: new Date().toISOString(),
			},
			{
				type: "custom",
				customType: "prime-agent.refinement",
				data: { id: "malformed" },
				id: "custom_malformed",
				parentId: "custom_2",
				timestamp: new Date().toISOString(),
			},
		];

		expect(getRefinementHistory(entries)).toEqual([result]);
	});

	it.each(kinds)("rejects duplicate create for %s entries", (kind) => {
		const state = loadHarnessState(makeTempDir());
		seedEntry(state, kind);

		const result = applyRefinementProposal(
			state,
			proposal(`Duplicate ${kind}`, [
				{
					action: "create",
					kind,
					id: `${kind}_entry`,
					title: "replacement",
					content: "replacement",
					...(kind === "skill"
						? {
								reference: skillReference,
								arguments: {
									input: { type: "string", required: true, description: "Replacement input" },
								},
							}
						: {}),
				},
			]),
			{ id: `refine_duplicate_${kind}` },
		);

		expect(result.appliedEdits).toHaveLength(1);
		expect(result.appliedEdits[0]).toMatchObject({
			action: "create",
			kind,
			id: `${kind}_entry`,
			applied: false,
			error: "entry already exists",
		});
		expect(result.appliedEdits[0].before?.content).toBe(`${kind} content`);
		expect(state.entries[kind][`${kind}_entry`].content).toBe(`${kind} content`);
		expect(state.refinements.at(-1)?.changes).toEqual([]);
	});

	it.each(kinds)("rejects update of missing %s entries", (kind) => {
		const state = loadHarnessState(makeTempDir());

		const result = applyRefinementProposal(
			state,
			proposal(`Missing ${kind} update`, [
				{
					action: "update",
					kind,
					id: `${kind}_missing`,
					title: "missing",
					content: "missing",
					...(kind === "skill"
						? {
								reference: skillReference,
								arguments: { input: { type: "string", required: true, description: "Missing input" } },
							}
						: {}),
				},
			]),
			{ id: `refine_missing_update_${kind}` },
		);

		expect(result.appliedEdits[0]).toMatchObject({
			action: "update",
			kind,
			id: `${kind}_missing`,
			applied: false,
			error: "entry not found",
		});
		expect(state.entries[kind][`${kind}_missing`]).toBeUndefined();
		expect(state.refinements.at(-1)?.changes).toEqual([]);
	});

	it.each(kinds)("rejects delete of missing %s entries", (kind) => {
		const state = loadHarnessState(makeTempDir());

		const result = applyRefinementProposal(
			state,
			proposal(`Missing ${kind} delete`, [
				{
					action: "delete",
					kind,
					id: `${kind}_missing`,
				},
			]),
			{ id: `refine_missing_delete_${kind}` },
		);

		expect(result.appliedEdits[0]).toMatchObject({
			action: "delete",
			kind,
			id: `${kind}_missing`,
			applied: false,
			error: "entry not found",
		});
		expect(state.refinements.at(-1)?.changes).toEqual([]);
	});

	it.each(["create", "update"] as const satisfies readonly RefinementAction[])(
		"rejects %s edits missing title or content",
		(action) => {
			const state = loadHarnessState(makeTempDir());
			if (action === "update") {
				seedEntry(state, "memory", "missing_fields");
			}

			const result = applyRefinementProposal(
				state,
				proposal(`Invalid ${action}`, [
					{
						action,
						kind: "memory",
						id: "missing_fields",
						title: "Missing content",
					},
				]),
				{ id: `refine_invalid_${action}` },
			);

			expect(result.appliedEdits[0]).toMatchObject({
				action,
				kind: "memory",
				id: "missing_fields",
				applied: false,
				error: `${action} requires title and content`,
			});
			expect(state.refinements.at(-1)?.changes).toEqual([]);
		},
	);

	it.each(["update", "delete"] as const satisfies readonly RefinementAction[])(
		"rejects %s edits missing ids",
		(action) => {
			const state = loadHarnessState(makeTempDir());

			const result = applyRefinementProposal(
				state,
				proposal(`Missing id ${action}`, [
					{
						action,
						kind: "skill",
						title: action === "update" ? "Missing id" : undefined,
						content: action === "update" ? "Missing id" : undefined,
					},
				]),
				{ id: `refine_missing_id_${action}` },
			);

			expect(result.appliedEdits[0]).toMatchObject({
				action,
				kind: "skill",
				id: "",
				applied: false,
				error: `${action} requires id`,
			});
			expect(state.refinements.at(-1)?.changes).toEqual([]);
		},
	);

	it("rejects unsupported actions and kinds without mutating state", () => {
		const state = loadHarnessState(makeTempDir());

		const result = applyRefinementProposal(
			state,
			proposal("Unsupported edits", [
				{
					action: "rename" as RefinementAction,
					kind: "memory",
					id: "bad_action",
					title: "Bad action",
					content: "Bad action",
				},
				{
					action: "create",
					kind: "tool" as RefinementKind,
					id: "bad_kind",
					title: "Bad kind",
					content: "Bad kind",
				},
			]),
			{ id: "refine_unsupported" },
		);

		expect(result.appliedEdits).toHaveLength(2);
		expect(result.appliedEdits[0]).toMatchObject({
			id: "bad_action",
			applied: false,
			error: "unsupported action rename",
		});
		expect(result.appliedEdits[1]).toMatchObject({
			id: "bad_kind",
			applied: false,
			error: "unsupported kind tool",
		});
		expect(state.entries.memory.bad_action).toBeUndefined();
		expect(Object.keys(state.entries)).toEqual([...kinds]);
		expect(state.refinements.at(-1)?.changes).toEqual([]);
	});

	it("rejects attempts to edit the base system prompt", () => {
		const state = loadHarnessState(makeTempDir());
		const result = applyRefinementProposal(
			state,
			{
				summary: "Bad edit",
				rationale: "Should not apply.",
				expectedOutcome: "No change.",
				edits: [
					{
						action: "update",
						kind: "prompt",
						id: "base_system_prompt",
						title: "Base system prompt",
						content: "Replace everything.",
					},
				],
			},
			{ id: "refine_1" },
		);

		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toContain("base system prompt");
		expect(state.entries.prompt.base_system_prompt).toBeUndefined();
	});

	it("rejects base system prompt edits when the id is derived from title", () => {
		const state = loadHarnessState(makeTempDir());
		const result = applyRefinementProposal(
			state,
			{
				summary: "Bad create",
				rationale: "Should not apply.",
				expectedOutcome: "No change.",
				edits: [
					{
						action: "create",
						kind: "prompt",
						title: "Base System Prompt",
						content: "Replace everything.",
					},
				],
			},
			{ id: "refine_1" },
		);

		expect(result.appliedEdits[0]).toMatchObject({
			id: "base_system_prompt",
			applied: false,
		});
		expect(result.appliedEdits[0].error).toContain("base system prompt");
		expect(state.entries.prompt.base_system_prompt).toBeUndefined();
	});

	it("requests JSON refinement without model reasoning even when session thinking is enabled", async () => {
		const state = loadHarnessState(makeTempDir());
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(
				JSON.stringify({
					summary: "Remember native validation",
					rationale: "The conversation repeated native validation guidance.",
					expectedOutcome: "Future sessions use native validation commands.",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "native_validation",
							title: "Native validation",
							content: "Run validation through the target project environment.",
						},
					],
				}),
			),
		);

		const result = await refineHarness(
			[{ role: "user", content: "Use native validation.", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(true),
			"api-key",
			{},
			{ "x-test-header": "1" },
			undefined,
			"xhigh",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][1]).toMatchObject({
			systemPrompt: expect.stringContaining("The default editable continual harness store is local"),
		});
		expect(completeSimpleMock.mock.calls[0][1]).toMatchObject({
			systemPrompt: expect.stringContaining("A caller may explicitly request global refinement"),
		});
		expect(completeSimpleMock.mock.calls[0][1]).toMatchObject({
			systemPrompt: expect.stringContaining("Always use the bare id (no prefix) in edits"),
		});
		expect(completeSimpleMock.mock.calls[0][1]).toMatchObject({
			systemPrompt: expect.stringContaining(
				"During a local refinement, global entries are read-only context: never propose update or delete edits for them",
			),
		});
		// Budget is derived from the model (8192) rather than a fixed literal.
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			maxTokens: 8192,
			apiKey: "api-key",
			headers: { "x-test-header": "1" },
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
		expect(result.appliedEdits[0]).toMatchObject({
			action: "create",
			kind: "memory",
			id: "native_validation",
			applied: true,
		});
		expect(state.entries.memory.native_validation.content).toBe(
			"Run validation through the target project environment.",
		);
	});

	it("caps the refinement output budget by the model's own maxTokens", async () => {
		const state = loadHarnessState(makeTempDir());
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(JSON.stringify({ summary: "s", rationale: "r", expectedOutcome: "o", edits: [] })),
		);
		// A large model must receive the policy ceiling, not its full output width.
		const wideModel = { ...createRefineModel(false), maxTokens: 128_000 };

		await refineHarness([], state, [], wideModel, "api-key", {});

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ maxTokens: 32_000 });
	});

	it("reports an exhausted output budget instead of a JSON parse error", async () => {
		const state = loadHarnessState(makeTempDir());
		// A reply truncated inside the edits array: brace slicing would otherwise
		// recover a fragment and surface an opaque JSON.parse message.
		const truncated = `{
  "summary": "s",
  "rationale": "r",
  "expectedOutcome": "o",
  "edits": [
    { "action": "create", "kind": "memory", "id": "a", "title": "t", "content": "first" },
    { "action": "create", "kind": "memory", "id": "b", "title": "t2", "content": "second`;
		completeSimpleMock.mockResolvedValueOnce({ ...assistantText(truncated), stopReason: "length" });

		await expect(refineHarness([], state, [], createRefineModel(false), "api-key", {})).rejects.toThrow(
			/output budget was exhausted/,
		);
	});

	it("rejects a truncated proposal that never reports a length stop reason", async () => {
		const state = loadHarnessState(makeTempDir());
		const truncated = `{
  "summary": "s",
  "edits": [
    { "action": "create", "kind": "memory", "id": "a", "title": "t", "content": "first" },
    { "action": "create", "kind": "memory", "id": "b", "title": "t2", "content": "second`;
		completeSimpleMock.mockResolvedValueOnce(assistantText(truncated));

		await expect(refineHarness([], state, [], createRefineModel(false), "api-key", {})).rejects.toThrow(
			/stopped before completing its JSON object/,
		);
	});

	it("reports truncation when a JSON-only reply is cut after a nested closing brace", async () => {
		const state = loadHarnessState(makeTempDir());
		// Ends on "}" so it takes the startsWith/endsWith fast path rather than
		// the brace-slicing fallback, but is still an incomplete object.
		const truncated = `{
  "summary": "s",
  "edits": [
    { "action": "create", "kind": "memory", "id": "a", "title": "t", "content": "first" }`;
		completeSimpleMock.mockResolvedValueOnce(assistantText(truncated));

		await expect(refineHarness([], state, [], createRefineModel(false), "api-key", {})).rejects.toThrow(
			/stopped before completing its JSON object/,
		);
	});

	it("reports malformed JSON as invalid rather than as an exhausted budget", async () => {
		const state = loadHarnessState(makeTempDir());
		// Complete and balanced, but not valid JSON: this is a model formatting
		// failure, not a truncation, and must not blame the output budget.
		completeSimpleMock.mockResolvedValueOnce(assistantText('Here is the result: {"edits": [oops]}'));

		await expect(refineHarness([], state, [], createRefineModel(false), "api-key", {})).rejects.toThrow(
			/did not return valid JSON/,
		);
	});

	it("rolls back created, updated, and deleted entries from refinement history", async () => {
		const state = loadHarnessState(makeTempDir());
		seedEntry(state, "memory", "kept_memory");
		seedEntry(state, "skill", "deleted_skill");

		const target = applyRefinementProposal(
			state,
			proposal("Target refinement", [
				{
					action: "create",
					kind: "prompt",
					id: "created_prompt",
					title: "Created prompt",
					content: "Created prompt content",
				},
				{
					action: "update",
					kind: "memory",
					id: "kept_memory",
					title: "Updated memory",
					content: "Updated memory content",
					path: "updated/path",
					metadata: { updated: true },
				},
				{
					action: "delete",
					kind: "skill",
					id: "deleted_skill",
				},
			]),
			{ id: "refine_target" },
		);

		expect(state.entries.prompt.created_prompt).toBeDefined();
		expect(state.entries.memory.kept_memory.content).toBe("Updated memory content");
		expect(state.entries.skill.deleted_skill).toBeUndefined();

		const rollback = await refineHarness([], state, [target], {} as never, "api-key", {
			rollbackId: "refine_target",
		});

		expect(rollback.rollbackOf).toBe("refine_target");
		expect(rollback.scope).toBe("local");
		expect(rollback.appliedEdits.map((edit) => `${edit.action} ${edit.kind}:${edit.id}`)).toEqual([
			"create skill:deleted_skill",
			"update memory:kept_memory",
			"delete prompt:created_prompt",
		]);
		expect(state.entries.prompt.created_prompt).toBeUndefined();
		expect(state.entries.memory.kept_memory).toMatchObject({
			title: "memory title",
			content: "memory content",
			path: "memory/path",
			metadata: { seeded: true },
			version: 3,
		});
		expect(state.entries.skill.deleted_skill).toMatchObject({
			title: "skill title",
			content: "skill content",
			path: "skill/path",
			reference: skillReference,
			arguments: { input: { type: "string", required: true, description: "Task input" } },
			metadata: { seeded: true },
			version: 1,
		});
		expect(state.refinements.at(-1)?.trigger).toBe("Rollback refinement refine_target");
	});

	it("throws when rollback target is missing", async () => {
		const state = loadHarnessState(makeTempDir());

		await expect(
			refineHarness([], state, [], {} as never, "api-key", { rollbackId: "missing_refinement" }),
		).rejects.toThrow("Refinement missing_refinement not found");
	});
});

describe("global refinement history", () => {
	function sampleResult(id: string, overrides: Partial<RefinementResult> = {}): RefinementResult {
		return {
			id,
			summary: `${id} summary`,
			rationale: `${id} rationale`,
			expectedOutcome: `${id} outcome`,
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
			...overrides,
		};
	}

	it("appends and reloads refinement results across calls", () => {
		const dir = makeTempDir();
		expect(loadGlobalRefinementHistory(dir)).toEqual([]);

		const first = sampleResult("refine_1");
		const second = sampleResult("refine_2");
		const historyPath = appendGlobalRefinement(dir, first);
		appendGlobalRefinement(dir, second);

		expect(historyPath).toBe(getRefinementHistoryPath(dir));
		expect(loadGlobalRefinementHistory(dir)).toEqual([
			{ ...first, scope: "global" },
			{ ...second, scope: "global" },
		]);
	});

	it("defaults legacy global history results to global scope", () => {
		const dir = makeTempDir();
		const legacy = sampleResult("refine_legacy_global", { scope: undefined });
		appendFileSync(
			getRefinementHistoryPath(dir),
			`${JSON.stringify(legacy)}
`,
			"utf8",
		);

		expect(loadGlobalRefinementHistory(dir)[0]).toMatchObject({ id: "refine_legacy_global", scope: "global" });
	});

	it("writes inferred legacy history scope back onto loaded results", () => {
		const dir = makeTempDir();
		const legacy = sampleResult("refine_legacy_inferred", {
			scope: undefined,
			appliedEdits: [
				{
					action: "create",
					kind: "memory",
					id: "legacy_global_memory",
					title: "Legacy global memory",
					content: "created globally",
					applied: true,
					after: {
						id: "legacy_global_memory",
						kind: "memory",
						title: "Legacy global memory",
						content: "created globally",
						path: "general",
						scope: "global",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-01-01T00:00:00.000Z",
						updated_at: "2026-01-01T00:00:00.000Z",
						version: 1,
					},
				},
			],
		});
		appendFileSync(getRefinementHistoryPath(dir), `${JSON.stringify(legacy)}\n`, "utf8");

		expect(loadGlobalRefinementHistory(dir)[0]).toMatchObject({
			id: "refine_legacy_inferred",
			scope: "global",
		});
	});

	it("preserves global scope when session history shadows legacy global history", () => {
		const globalOld = sampleResult("refine_shared", { scope: "global", summary: "global version" });
		const sessionNew = sampleResult("refine_shared", { scope: undefined, summary: "session version" });

		const merged = mergeRefinementHistory([globalOld], [sessionNew]);

		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ id: "refine_shared", summary: "session version", scope: "global" });
	});

	it("skips malformed history lines without throwing", () => {
		const dir = makeTempDir();
		const valid = sampleResult("refine_valid");
		appendGlobalRefinement(dir, valid);
		// Corrupt append: a non-JSON line and a JSON object that is not a refinement result.
		appendFileSync(getRefinementHistoryPath(dir), "not json\n", "utf8");
		appendFileSync(getRefinementHistoryPath(dir), `${JSON.stringify({ id: "x" })}\n`, "utf8");

		expect(loadGlobalRefinementHistory(dir)).toEqual([{ ...valid, scope: "global" }]);
	});

	it("merges global and session history, preferring session entries by id", () => {
		const globalOld = sampleResult("refine_shared", { summary: "global version" });
		const globalOnly = sampleResult("refine_global_only");
		const sessionNew = sampleResult("refine_shared", { summary: "session version" });
		const sessionOnly = sampleResult("refine_session_only");

		const merged = mergeRefinementHistory([globalOld, globalOnly], [sessionNew, sessionOnly]);

		expect(merged).toHaveLength(3);
		expect(merged.find((item) => item.id === "refine_shared")?.summary).toBe("session version");
		expect(merged.map((item) => item.id)).toEqual(
			expect.arrayContaining(["refine_shared", "refine_global_only", "refine_session_only"]),
		);
	});

	it("plans a proposal without mutating harness state", async () => {
		const dir = makeTempDir();
		const state = loadHarnessState(dir);
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(
				JSON.stringify({
					summary: "Add a memory",
					rationale: "useful",
					expectedOutcome: "remembered",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "planned_memory",
							title: "Planned memory",
							content: "Created only when applied.",
						},
					],
				}),
			),
		);

		const plan = await planRefinement(
			[{ role: "user", content: "remember this", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(false),
			"api-key",
			{},
		);

		// planRefinement must not touch state: the host re-reads the file before applying,
		// so applying must be the only thing that mutates state.
		expect(plan.proposal.edits).toHaveLength(1);
		expect(plan.id).toMatch(/^refine_/);
		const request = completeSimpleMock.mock.calls[0][1];
		const userPrompt = request.messages[0].content[0].text;
		expect(userPrompt).toContain("Requested refinement scope: local");
		expect(userPrompt).toContain("Global entries in the overview are read-only context");
		expect(request.systemPrompt).toContain('handle = await rlm("sub-task")');
		expect(request.systemPrompt).toContain("never the child's answer");
		expect(request.systemPrompt).toContain('receiver_role="parent"');
		expect(request.systemPrompt).toContain("await rlm.list_subagents()");
		expect(request.systemPrompt).toContain('receiver_role="child"');
		expect(request.systemPrompt).not.toContain("asyncio.create_task(rlm");
		expect(request.systemPrompt).not.toContain("asyncio.gather(rlm");
		expect(state.entries.memory.planned_memory).toBeUndefined();
		expect(state.refinements).toHaveLength(0);

		const result = applyRefinementProposal(state, plan.proposal, { id: plan.id });
		expect(result.appliedEdits[0]).toMatchObject({ id: "planned_memory", applied: true });
		expect(state.entries.memory.planned_memory).toBeDefined();
	});

	it("adds global-only scope policy when planning a global refinement", async () => {
		const state = loadHarnessState(makeTempDir(), "global");
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(
				JSON.stringify({
					summary: "No global edit",
					rationale: "No durable cross-session lesson.",
					expectedOutcome: "No change.",
					edits: [],
				}),
			),
		);

		await planRefinement(
			[{ role: "user", content: "remember this only if global", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(false),
			"api-key",
			{ global: true },
		);

		const userPrompt = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(userPrompt).toContain("Requested refinement scope: global");
		expect(userPrompt).toContain("Do not persist session-only progress");
	});

	it("plans a rollback without mutating harness state", async () => {
		const dir = makeTempDir();
		const state = loadHarnessState(dir);
		const target = applyRefinementProposal(
			state,
			proposal("Target", [
				{ action: "create", kind: "memory", id: "rollback_me", title: "Rollback me", content: "content" },
			]),
			{ id: "refine_rollback_target" },
		);

		const plan = await planRefinement([], state, [target], {} as never, "api-key", {
			rollbackId: "refine_rollback_target",
		});

		expect(plan.rollbackOf).toBe("refine_rollback_target");
		expect(plan.rollbackScope).toBe("local");
		// The entry still exists until the proposal is applied.
		expect(state.entries.memory.rollback_me).toBeDefined();
		applyRefinementProposal(state, plan.proposal, { id: plan.id, rollbackOf: plan.rollbackOf });
		expect(state.entries.memory.rollback_me).toBeUndefined();
	});

	it("rolls back a refinement recorded in a different session via global history", async () => {
		const dir = makeTempDir();
		const sessionAState = loadHarnessState(dir);
		const applied = applyRefinementProposal(
			sessionAState,
			proposal("Session A refinement", [
				{
					action: "create",
					kind: "memory",
					id: "session_a_memory",
					title: "Session A memory",
					content: "Created in session A.",
				},
			]),
			{ id: "refine_session_a" },
		);
		applied.harnessStatePath = saveHarnessState(dir, sessionAState);
		appendGlobalRefinement(dir, applied);

		// A fresh session loads the global state and the global history (its own session
		// has no record of refine_session_a) and can still roll it back.
		const sessionBState = loadHarnessState(dir);
		expect(sessionBState.entries.memory.session_a_memory).toBeDefined();

		const globalHistory = mergeRefinementHistory(loadGlobalRefinementHistory(dir), getRefinementHistory([]));
		const rollback = await refineHarness([], sessionBState, globalHistory, {} as never, "api-key", {
			rollbackId: "refine_session_a",
		});

		expect(rollback.rollbackOf).toBe("refine_session_a");
		expect(rollback.scope).toBe("local");
		expect(sessionBState.entries.memory.session_a_memory).toBeUndefined();
	});

	it("plans rollback against the recorded global scope when --global is omitted", async () => {
		const dir = makeTempDir();
		const state = loadHarnessState(dir, "global");
		const target = applyRefinementProposal(
			state,
			proposal("Global refinement", [
				{
					action: "create",
					kind: "memory",
					id: "global_memory",
					title: "Global memory",
					content: "Created globally.",
				},
			]),
			{ id: "refine_global_target", scope: "global" },
		);
		expect(target.scope).toBe("global");

		const plan = await planRefinement([], state, [target], {} as never, "api-key", {
			rollbackId: "refine_global_target",
		});

		expect(plan.rollbackOf).toBe("refine_global_target");
		expect(plan.rollbackScope).toBe("global");
		const rollback = applyRefinementProposal(state, plan.proposal, {
			id: plan.id,
			rollbackOf: plan.rollbackOf,
			scope: plan.rollbackScope,
		});
		expect(rollback.scope).toBe("global");
		expect(state.entries.memory.global_memory).toBeUndefined();
	});

	it("infers rollback scope from legacy global edits without top-level scope", async () => {
		const dir = makeTempDir();
		const state = loadHarnessState(dir, "global");
		const target = applyRefinementProposal(
			state,
			proposal("Legacy global refinement", [
				{
					action: "create",
					kind: "memory",
					id: "legacy_global_memory",
					title: "Legacy global memory",
					content: "Created globally before result.scope existed.",
				},
			]),
			{ id: "refine_legacy_global", scope: "global" },
		);
		const legacyTarget = {
			...target,
			scope: undefined,
			appliedEdits: target.appliedEdits.map((edit) => ({
				...edit,
				before: edit.before ? { ...edit.before, scope: undefined } : undefined,
				after: edit.after ? { ...edit.after, scope: undefined } : undefined,
			})),
		};
		const legacyHistory = mergeRefinementHistory([{ ...legacyTarget, scope: "global" }], [legacyTarget]);

		const plan = await planRefinement([], state, legacyHistory, {} as never, "api-key", {
			rollbackId: "refine_legacy_global",
		});

		expect(plan.rollbackScope).toBe("global");
	});
});
