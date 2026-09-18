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
	type HarnessEntry,
	type HarnessState,
	harnessQueryTermIdf,
	harnessQueryTerms,
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
	scoreHarnessEntryForQuery,
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

const kinds = ["prompt", "memory", "skill", "subagent", "swarm"] as const satisfies readonly RefinementKind[];
const skillReference = {
	type: "python",
	import: "agent_skills.example",
	callable: "run",
	call_pattern: "await run(...)",
};
const skillContract = {
	reference: skillReference,
	arguments: { input: { type: "string", required: true, description: "Task input" } },
};
const swarmDag = {
	nodes: [
		{
			id: "collect",
			subagent: "researcher",
			outputs: [{ name: "findings", type: "text" }],
		},
		{
			id: "review",
			subagent: { prompt: "Review the findings." },
			depends_on: ["collect"],
			inputs: [{ name: "draft", type: "text", from: "collect.findings" }],
		},
	],
};

const swarmMachine = {
	states: [
		{ id: "collect", entry: true, subagent: "researcher", outputs: [{ name: "findings", type: "text" }] },
		{
			id: "review",
			subagent: { prompt: "Review the findings." },
			inputs: [{ name: "draft", type: "text", from: "collect.findings" }],
		},
	],
	transitions: [{ from: "collect", to: "review" }],
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
				...(kind === "skill" ? skillContract : kind === "swarm" ? { arguments: { dag: swarmDag } } : {}),
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

	it.each(kinds)("applies the create/update/delete lifecycle for %s entries", (kind) => {
		const state = loadHarnessState(makeTempDir());
		const id = `${kind}_entry`;
		const skillFields = kind === "skill" ? skillContract : kind === "swarm" ? { arguments: { dag: swarmDag } } : {};
		const apply = (edits: RefinementProposal["edits"], refinementId: string) =>
			applyRefinementProposal(state, proposal(`${refinementId} ${kind}`, edits), { id: refinementId });

		const created = apply(
			[
				{
					action: "create",
					kind,
					id,
					title: `${kind} title`,
					content: `${kind} content`,
					path: `${kind}/created`,
					...skillFields,
					metadata: { kind },
				},
			],
			`refine_create_${kind}`,
		);

		expect(created.appliedEdits[0]).toMatchObject({ applied: true, after: { version: 1 } });
		expect(created.appliedEdits[0].before).toBeUndefined();
		expect(state.entries[kind][id]).toMatchObject({
			id,
			kind,
			title: `${kind} title`,
			content: `${kind} content`,
			path: `${kind}/created`,
			metadata: { kind },
			source: "refine",
			version: 1,
		});
		expect(state.refinements.at(-1)?.changes).toEqual([`create ${kind}:${id}`]);

		const updated = apply(
			[
				{
					action: "update",
					kind,
					id,
					title: `${kind} title updated`,
					content: `${kind} content updated`,
					path: `${kind}/updated`,
					...skillFields,
					metadata: { updated: kind },
				},
			],
			`refine_update_${kind}`,
		);

		expect(updated.appliedEdits[0]).toMatchObject({ applied: true, before: { version: 1 }, after: { version: 2 } });
		expect(state.entries[kind][id]).toMatchObject({
			title: `${kind} title updated`,
			content: `${kind} content updated`,
			path: `${kind}/updated`,
			metadata: { updated: kind },
			version: 2,
		});

		const deleted = apply([{ action: "delete", kind, id }], `refine_delete_${kind}`);

		expect(deleted.appliedEdits[0]).toMatchObject({ applied: true, before: { version: 2 } });
		expect(deleted.appliedEdits[0].after).toBeUndefined();
		expect(state.entries[kind][id]).toBeUndefined();
		expect(state.refinements.at(-1)?.changes).toEqual([`delete ${kind}:${id}`]);
	});

	it("requires exactly one dag or machine object in arguments for swarm creates and updates", () => {
		const state = loadHarnessState(makeTempDir());

		const missingSpec = applyRefinementProposal(
			state,
			proposal("Create swarm without a spec", [
				{
					action: "create",
					kind: "swarm",
					id: "swarm_entry",
					title: "Swarm title",
					content: "Swarm content",
				},
			]),
			{ id: "refine_swarm_missing_dag" },
		);

		expect(missingSpec.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "swarm entry requires a dag or machine object in arguments",
		});
		expect(state.entries.swarm.swarm_entry).toBeUndefined();
		expect(state.refinements.at(-1)?.changes).toEqual([]);

		const nonObjectDag = applyRefinementProposal(
			state,
			proposal("Create swarm with a non-object dag", [
				{
					action: "create",
					kind: "swarm",
					id: "swarm_entry",
					title: "Swarm title",
					content: "Swarm content",
					arguments: { dag: ["not", "an", "object"] },
				},
			]),
			{ id: "refine_swarm_non_object_dag" },
		);

		expect(nonObjectDag.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "swarm entry requires a dag or machine object in arguments",
		});

		const bothForms = applyRefinementProposal(
			state,
			proposal("Create swarm with both forms", [
				{
					action: "create",
					kind: "swarm",
					id: "swarm_entry",
					title: "Swarm title",
					content: "Swarm content",
					arguments: { dag: swarmDag, machine: swarmMachine },
				},
			]),
			{ id: "refine_swarm_both_forms" },
		);

		expect(bothForms.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "pass either dag or machine form, not both",
		});
		expect(state.entries.swarm.swarm_entry).toBeUndefined();

		const created = applyRefinementProposal(
			state,
			proposal("Create swarm with a dag", [
				{
					action: "create",
					kind: "swarm",
					id: "swarm_entry",
					title: "Swarm title",
					content: "Swarm content",
					path: "swarm/created",
					arguments: { dag: swarmDag },
					metadata: { kind: "swarm" },
				},
			]),
			{ id: "refine_swarm_valid" },
		);

		expect(created.appliedEdits[0].applied).toBe(true);
		expect(state.entries.swarm.swarm_entry.arguments).toEqual({ dag: swarmDag });

		const machineCreated = applyRefinementProposal(
			state,
			proposal("Create swarm with a machine", [
				{
					action: "create",
					kind: "swarm",
					id: "swarm_machine_entry",
					title: "Swarm machine",
					content: "Swarm machine content",
					arguments: { machine: swarmMachine },
				},
			]),
			{ id: "refine_swarm_machine_valid" },
		);

		expect(machineCreated.appliedEdits[0].applied).toBe(true);
		expect(state.entries.swarm.swarm_machine_entry.arguments).toEqual({ machine: swarmMachine });

		const updateWithoutSpec = applyRefinementProposal(
			state,
			proposal("Update swarm without a spec", [
				{
					action: "update",
					kind: "swarm",
					id: "swarm_entry",
					title: "Swarm title updated",
					content: "Swarm content updated",
				},
			]),
			{ id: "refine_swarm_update_missing_dag" },
		);

		expect(updateWithoutSpec.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "swarm entry requires a dag or machine object in arguments",
		});
		expect(state.entries.swarm.swarm_entry.title).toBe("Swarm title");
	});

	it("renders the swarm invoke contract in the harness digest", () => {
		const state = loadHarnessState(makeTempDir());
		seedEntry(state, "swarm", "sweep");

		const digest = formatHarnessStateForPrompt(state);

		expect(digest).toContain("swarm: 1");
		expect(digest).toContain("await rlm.swarm.run('<id>')");
	});

	it("creates ids from titles and uses default path and metadata when omitted", () => {
		const state = loadHarnessState(makeTempDir());

		const result = applyRefinementProposal(
			state,
			proposal("Create with generated id", [
				{ action: "create", kind: "skill", title: "Native Check!", content: "Run checks.", ...skillContract },
			]),
			{ id: "refine_generated_id" },
		);

		expect(result.appliedEdits[0]).toMatchObject({
			applied: true,
			id: "native_check",
			after: { id: "native_check", path: "general", reference: skillReference, metadata: {}, version: 1 },
		});
	});

	// Every rejected edit must leave harness state and the refinement log untouched.
	type InvalidCase = {
		label: string;
		edit: RefinementProposal["edits"][number];
		error: string;
		seed?: RefinementKind;
	};
	const skillFieldsFor = (kind: RefinementKind) =>
		kind === "skill" ? skillContract : kind === "swarm" ? { arguments: { dag: swarmDag } } : {};
	it.each<InvalidCase>([
		...kinds.map(
			(kind): InvalidCase => ({
				label: `duplicate create for ${kind}`,
				seed: kind,
				edit: { action: "create", kind, id: `${kind}_entry`, title: "t", content: "c", ...skillFieldsFor(kind) },
				error: "entry already exists",
			}),
		),
		...kinds.map(
			(kind): InvalidCase => ({
				label: `update of a missing ${kind}`,
				edit: { action: "update", kind, id: `${kind}_missing`, title: "t", content: "c", ...skillFieldsFor(kind) },
				error: "entry not found",
			}),
		),
		...kinds.map(
			(kind): InvalidCase => ({
				label: `delete of a missing ${kind}`,
				edit: { action: "delete", kind, id: `${kind}_missing` },
				error: "entry not found",
			}),
		),
		{
			label: "create without content",
			edit: { action: "create", kind: "memory", id: "missing_fields", title: "t" },
			error: "create requires title and content",
		},
		{
			label: "update without content",
			seed: "memory",
			edit: { action: "update", kind: "memory", id: "memory_entry", title: "t" },
			error: "update requires title and content",
		},
		{
			label: "update without an id",
			edit: { action: "update", kind: "skill", title: "t", content: "c" },
			error: "update requires id",
		},
		{ label: "delete without an id", edit: { action: "delete", kind: "skill" }, error: "delete requires id" },
		{
			label: "an unsupported action",
			edit: { action: "rename" as RefinementAction, kind: "memory", id: "bad_action", title: "t", content: "c" },
			error: "unsupported action rename",
		},
		{
			label: "an unsupported kind",
			edit: { action: "create", kind: "tool" as RefinementKind, id: "bad_kind", title: "t", content: "c" },
			error: "unsupported kind tool",
		},
		{
			label: "a skill without an argument contract",
			edit: {
				action: "create",
				kind: "skill",
				id: "argumentless",
				title: "t",
				content: "c",
				reference: skillReference,
			},
			error: "create skill requires arguments",
		},
		{
			label: "a skill without a Python reference",
			edit: { action: "create", kind: "skill", id: "unbacked", title: "t", content: "c", arguments: {} },
			error: "create skill requires python reference",
		},
		{
			label: "a skill backed by a non-Python reference",
			edit: {
				action: "create",
				kind: "skill",
				id: "shell_skill",
				title: "t",
				content: "c",
				reference: { type: "shell", command: "edit" },
				arguments: {},
			},
			error: "create skill reference.type must be python",
		},
		{
			label: "an update of the base system prompt",
			edit: { action: "update", kind: "prompt", id: "base_system_prompt", title: "t", content: "c" },
			error: "base system prompt",
		},
		{
			label: "a create whose title derives the base system prompt id",
			edit: { action: "create", kind: "prompt", title: "Base System Prompt", content: "c" },
			error: "base system prompt",
		},
	])("rejects $label without mutating state", ({ seed, edit, error }) => {
		const state = loadHarnessState(makeTempDir());
		if (seed) seedEntry(state, seed);
		const before = structuredClone(state.entries);

		const result = applyRefinementProposal(state, proposal("Invalid edit", [edit]), { id: "refine_invalid" });

		expect(result.appliedEdits).toHaveLength(1);
		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toContain(error);
		expect(state.entries).toEqual(before);
		expect(state.refinements.at(-1)?.changes).toEqual([]);
	});
	it("keeps global and local harness state separate when merging and persisting", () => {
		const root = makeTempDir();
		const globalState = loadHarnessState(join(root, "global"), "global");
		const localState = loadHarnessState(join(root, "local"), "local");
		const note = (content: string): RefinementProposal =>
			proposal(content, [{ action: "create", kind: "memory", id: "shared", title: "Shared", content }]);
		applyRefinementProposal(globalState, note("Global content."), { id: "refine_global", scope: "global" });
		applyRefinementProposal(localState, note("Local content."), { id: "refine_local", scope: "local" });

		const merged = mergeHarnessStates(globalState, localState);

		// A colliding local id is namespaced instead of shadowed.
		expect(merged.entries.memory.shared).toMatchObject({ content: "Global content.", scope: "global" });
		expect(merged.entries.memory["local:shared"]).toMatchObject({
			id: "shared",
			content: "Local content.",
			scope: "local",
		});
		expect(globalState.entries.memory.shared.scope).toBe("global");

		// Scope stored inside a shared file wins over the file's own default scope.
		applyRefinementProposal(
			globalState,
			proposal("Session-local note in shared file", [
				{ action: "create", kind: "memory", id: "session_note", title: "Session note", content: "Local store." },
			]),
			{ id: "refine_local_in_global_file", scope: "local" },
		);
		expect(mergeHarnessStates(globalState).entries.memory.session_note.scope).toBe("local");
	});

	it("resolves the harness state directories and persists state in the selected one", () => {
		const dir = makeTempDir();
		expect(getGlobalHarnessStateDir(dir)).toBe(join(dir, "harness"));
		expect(getHarnessStatePath(getGlobalHarnessStateDir(dir))).toBe(join(dir, "harness", "harness_state.json"));
		expect(getLocalHarnessStateDir(dir)).toBe(join(dir, "harness"));
		expect(getLocalHarnessStateDir(undefined)).toBeUndefined();

		const state = loadHarnessState(dir, "local");
		applyRefinementProposal(
			state,
			proposal("Add prompt note", [
				{
					action: "create",
					kind: "prompt",
					id: "focused_edits",
					title: "Focused edits",
					content: "Prefer small harness edits.",
				},
			]),
			{ id: "refine_1" },
		);

		const statePath = saveHarnessState(dir, state);
		const reloaded = loadHarnessState(dir, "local");

		expect(statePath).toBe(getHarnessStatePath(dir));
		expect(reloaded.entries.prompt.focused_edits).toMatchObject({
			content: "Prefer small harness edits.",
			scope: "local",
		});
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

			expect(state.entries).toEqual({ prompt: {}, memory: {}, skill: {}, subagent: {}, swarm: {} });
			expect(state.refinements).toEqual([]);
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

	it("extracts well-formed refinement history from custom session entries", () => {
		const result: RefinementResult = {
			id: "refine_1",
			summary: "Add skill",
			rationale: "Repeated failure.",
			expectedOutcome: "Better validation.",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		};
		const entry = (customType: string, data: object, id: string): CustomEntry => ({
			type: "custom",
			customType,
			data,
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
		});

		expect(
			getRefinementHistory([
				entry("other", {}, "custom_1"),
				entry("prime-agent.refinement", result, "custom_2"),
				entry("prime-agent.refinement", { id: "malformed" }, "custom_malformed"),
			]),
		).toEqual([result]);
	});

	it("requests a JSON refinement within the model's own output budget and applies it", async () => {
		const state = loadHarnessState(makeTempDir());
		const edit = {
			action: "create",
			kind: "memory",
			id: "native_validation",
			title: "Native validation",
			content: "Run validation through the target project environment.",
		};
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(JSON.stringify({ summary: "s", rationale: "r", expectedOutcome: "o", edits: [edit] })),
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

		// Budget is derived from the model (8192) rather than a fixed literal.
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "low",
			maxTokens: 8192,
			apiKey: "api-key",
			headers: { "x-test-header": "1" },
		});
		expect(result.appliedEdits[0]).toMatchObject({ kind: "memory", id: "native_validation", applied: true });
		expect(state.entries.memory.native_validation.content).toBe(edit.content);
	});

	it("caps the refinement output budget by the policy ceiling for wide models", async () => {
		const state = loadHarnessState(makeTempDir());
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(JSON.stringify({ summary: "s", rationale: "r", expectedOutcome: "o", edits: [] })),
		);

		await refineHarness([], state, [], { ...createRefineModel(false), maxTokens: 128_000 }, "api-key", {});

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ maxTokens: 32_000 });
	});

	// A cut-off reply must be reported as truncation, and a complete-but-invalid
	// reply as a formatting failure: swapping the two sends callers the wrong fix.
	it.each<{ label: string; reply: string; stopReason?: "length"; error: RegExp }>([
		{
			label: "an exhausted output budget",
			reply: `{
  "summary": "s",
  "edits": [
    { "action": "create", "kind": "memory", "id": "a", "title": "t", "content": "first" },
    { "action": "create", "kind": "memory", "id": "b", "title": "t2", "content": "second`,
			stopReason: "length",
			error: /output budget was exhausted/,
		},
		{
			label: "a truncated reply that never reports a length stop reason",
			reply: `{
  "summary": "s",
  "edits": [
    { "action": "create", "kind": "memory", "id": "a", "title": "t", "content": "first" },
    { "action": "create", "kind": "memory", "id": "b", "title": "t2", "content": "second`,
			error: /stopped before completing its JSON object/,
		},
		{
			// Ends on "}" so it takes the startsWith/endsWith fast path rather than
			// the brace-slicing fallback, but is still an incomplete object.
			label: "a JSON-only reply cut after a nested closing brace",
			reply: `{
  "summary": "s",
  "edits": [
    { "action": "create", "kind": "memory", "id": "a", "title": "t", "content": "first" }`,
			error: /stopped before completing its JSON object/,
		},
		{
			label: "a complete but malformed reply",
			reply: 'Here is the result: {"edits": [oops]}',
			error: /did not return valid JSON/,
		},
	])("reports $label", async ({ reply, stopReason, error }) => {
		const state = loadHarnessState(makeTempDir());
		const message = assistantText(reply);
		completeSimpleMock.mockResolvedValueOnce(stopReason ? { ...message, stopReason } : message);

		await expect(refineHarness([], state, [], createRefineModel(false), "api-key", {})).rejects.toThrow(error);
	});

	it("rolls back created, updated, and deleted entries from refinement history", async () => {
		const state = loadHarnessState(makeTempDir());
		seedEntry(state, "memory", "kept_memory");
		seedEntry(state, "skill", "deleted_skill");

		const target = applyRefinementProposal(
			state,
			proposal("Target refinement", [
				{ action: "create", kind: "prompt", id: "created_prompt", title: "Created", content: "Created content" },
				{
					action: "update",
					kind: "memory",
					id: "kept_memory",
					title: "Updated memory",
					content: "Updated memory content",
					path: "updated/path",
					metadata: { updated: true },
				},
				{ action: "delete", kind: "skill", id: "deleted_skill" },
			]),
			{ id: "refine_target" },
		);

		const rollback = await refineHarness([], state, [target], {} as never, "api-key", {
			rollbackId: "refine_target",
		});

		expect(rollback).toMatchObject({ rollbackOf: "refine_target", scope: "local" });
		// Rollback undoes the edits in reverse order and restores the pre-edit snapshots.
		expect(rollback.appliedEdits.map((edit) => `${edit.action} ${edit.kind}:${edit.id}`)).toEqual([
			"create skill:deleted_skill",
			"update memory:kept_memory",
			"delete prompt:created_prompt",
		]);
		expect(state.entries.prompt.created_prompt).toBeUndefined();
		expect(state.entries.memory.kept_memory).toMatchObject({
			content: "memory content",
			path: "memory/path",
			metadata: { seeded: true },
			version: 3,
		});
		expect(state.entries.skill.deleted_skill).toMatchObject({
			content: "skill content",
			reference: skillReference,
			arguments: skillContract.arguments,
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

	it("appends, reloads, and skips malformed history lines", () => {
		const dir = makeTempDir();
		expect(loadGlobalRefinementHistory(dir)).toEqual([]);

		const first = sampleResult("refine_1");
		const second = sampleResult("refine_2");
		const historyPath = appendGlobalRefinement(dir, first);
		appendGlobalRefinement(dir, second);
		appendFileSync(historyPath, "not json\n", "utf8");
		appendFileSync(historyPath, `${JSON.stringify({ id: "x" })}\n`, "utf8");

		expect(historyPath).toBe(getRefinementHistoryPath(dir));
		expect(loadGlobalRefinementHistory(dir)).toEqual([
			{ ...first, scope: "global" },
			{ ...second, scope: "global" },
		]);
	});

	// History written before result.scope existed must still resolve to global.
	it("defaults legacy global history entries to global scope", () => {
		const dir = makeTempDir();
		const legacyEdit = {
			action: "create" as const,
			kind: "memory" as const,
			id: "legacy_global_memory",
			title: "Legacy global memory",
			content: "created globally",
			applied: true,
			after: {
				id: "legacy_global_memory",
				kind: "memory" as const,
				title: "Legacy global memory",
				content: "created globally",
				path: "general",
				scope: "global" as const,
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				version: 1,
			},
		};
		const scopeless = sampleResult("refine_legacy", { scope: undefined });
		const editScoped = sampleResult("refine_legacy_edits", { scope: undefined, appliedEdits: [legacyEdit] });
		for (const legacy of [scopeless, editScoped]) {
			appendFileSync(getRefinementHistoryPath(dir), `${JSON.stringify(legacy)}\n`, "utf8");
		}

		// Scope is recovered from the edit snapshots and written back onto the loaded results.
		expect(loadGlobalRefinementHistory(dir).map((entry) => entry.scope)).toEqual(["global", "global"]);
		expect(inferRefinementResultScope(editScoped)).toBe("global");
	});

	it("merges global and session history, preferring session entries but keeping global scope", () => {
		const globalShared = sampleResult("refine_shared", { scope: "global", summary: "global version" });
		const globalOnly = sampleResult("refine_global_only", { scope: "global" });
		const sessionShared = sampleResult("refine_shared", { scope: undefined, summary: "session version" });
		const sessionOnly = sampleResult("refine_session_only");

		const merged = mergeRefinementHistory([globalShared, globalOnly], [sessionShared, sessionOnly]);

		expect(merged).toHaveLength(3);
		expect(merged.find((item) => item.id === "refine_shared")).toMatchObject({
			summary: "session version",
			scope: "global",
		});
		expect(merged.map((item) => item.id)).toEqual(
			expect.arrayContaining(["refine_shared", "refine_global_only", "refine_session_only"]),
		);
	});

	it("plans a proposal without mutating harness state", async () => {
		const state = loadHarnessState(makeTempDir());
		const edit = {
			action: "create",
			kind: "memory",
			id: "planned_memory",
			title: "Planned memory",
			content: "Created only when applied.",
		};
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(JSON.stringify({ summary: "s", rationale: "r", expectedOutcome: "o", edits: [edit] })),
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
		expect(state.entries.memory.planned_memory).toBeUndefined();
		expect(state.refinements).toHaveLength(0);

		const result = applyRefinementProposal(state, plan.proposal, { id: plan.id });
		expect(result.appliedEdits[0]).toMatchObject({ id: "planned_memory", applied: true });
		expect(state.entries.memory.planned_memory).toBeDefined();
	});

	it.each<{ label: string; scope: "local" | "global" }>([
		{ label: "local", scope: "local" },
		{ label: "global", scope: "global" },
	])("plans a $label rollback against the recorded scope without mutating state", async ({ scope }) => {
		const dir = makeTempDir();
		const state = loadHarnessState(dir, scope);
		const target = applyRefinementProposal(
			state,
			proposal("Target", [
				{ action: "create", kind: "memory", id: "rollback_me", title: "Rollback me", content: "content" },
			]),
			{ id: "refine_rollback_target", scope },
		);
		expect(target.scope).toBe(scope);

		const plan = await planRefinement([], state, [target], {} as never, "api-key", {
			rollbackId: "refine_rollback_target",
		});

		expect(plan.rollbackOf).toBe("refine_rollback_target");
		expect(plan.rollbackScope).toBe(scope);
		expect(state.entries.memory.rollback_me).toBeDefined();

		const rollback = applyRefinementProposal(state, plan.proposal, {
			id: plan.id,
			rollbackOf: plan.rollbackOf,
			scope: plan.rollbackScope,
		});
		expect(rollback.scope).toBe(scope);
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

		expect(rollback).toMatchObject({ rollbackOf: "refine_session_a", scope: "local" });
		expect(sessionBState.entries.memory.session_a_memory).toBeUndefined();
	});
});

describe("harness digest relevance ranking", () => {
	function makeEntry(id: string, title: string, content: string, updatedAt: string): HarnessEntry {
		return {
			id,
			kind: "memory",
			title,
			content,
			path: "memory",
			scope: "global",
			reference: {},
			arguments: {},
			metadata: {},
			source: "test",
			created_at: updatedAt,
			updated_at: updatedAt,
			version: 1,
		};
	}

	function rank(entries: Record<string, HarnessEntry>, query: string | Map<string, number>): string {
		const state = loadHarnessState(join(makeTempDir(), "h"), "local");
		Object.assign(state.entries.memory, entries);
		return formatHarnessStateForPrompt(state, {
			maxEntriesPerKind: 1,
			queryTerms: typeof query === "string" ? new Map(harnessQueryTerms(query).map((term) => [term, 1])) : query,
		});
	}

	it("scores weighted term overlap with field coverage", () => {
		const entry = makeEntry(
			"repo",
			"Repository facts",
			"The checkout lives at ~/repo with worktrees.",
			"2026-09-01T00:00:00.000Z",
		);
		const terms = new Map([
			["repository", 2],
			["worktree", 1],
			["absent-term", 5],
		]);
		// "repository" matches the title only -> 2 * 1 = 2.
		// "worktree" matches content only (1 field) -> 1 * 1 = 1. Total 3.
		expect(scoreHarnessEntryForQuery(entry, terms)).toBe(3);
		expect(scoreHarnessEntryForQuery(entry, new Map())).toBe(0);
	});

	it("computes document-frequency discounts over the ranked corpus", () => {
		const at = "2026-08-01T00:00:00.000Z";
		const terms = new Map([
			["session", 1],
			["quantum", 1],
			["missing", 1],
		]);
		const common = ["common0", "common1"].map((id) => makeEntry(id, "Session notes", "session text", at));
		const rare = makeEntry("rare", "Quantum note", "quantum text", at);
		// "session" matches 2 of 3 entries, "quantum" 1 of 3, "missing" none.
		const idf = harnessQueryTermIdf([...common, rare], terms);
		expect([...idf.keys()]).toEqual(["session", "quantum"]);
		expect(idf.get("session")).toBeCloseTo(Math.log(1 + 3 / 2));
		expect(idf.get("quantum")).toBeCloseTo(Math.log(1 + 3 / 1));
		// The discount scales the weighted overlap: "quantum" covers 2 fields of 1 entry.
		expect(scoreHarnessEntryForQuery(rare, terms, idf)).toBeCloseTo(Math.log(1 + 3 / 1) * 1.5);
		// A term in every entry still weighs log(2); degenerate corpora stay inert.
		expect(harnessQueryTermIdf([rare], terms).get("quantum")).toBeCloseTo(Math.log(2));
		expect(harnessQueryTermIdf([], terms).size).toBe(0);
		expect(harnessQueryTermIdf([...common, rare], new Map()).size).toBe(0);
	});

	it.each<{ label: string; query: string; winner: string; loser: string; entries: Record<string, HarnessEntry> }>([
		{
			label: "relevance over alphabetical order",
			query: "worktree",
			winner: "zzz",
			loser: "aaa",
			entries: {
				aaa: makeEntry("aaa", "Alphabetical first", "Unrelated content about tea.", "2026-08-01T00:00:00.000Z"),
				zzz: makeEntry("zzz", "Zebra note", "The worktree workflow matters.", "2026-08-02T00:00:00.000Z"),
			},
		},
		{
			label: "a rare distinctive term over a common-term-dense entry",
			query: "session quantum",
			winner: "rare",
			loser: "common1",
			entries: {
				common0: makeEntry("common0", "Session notes", "Session state notes.", "2026-08-01T00:00:00.000Z"),
				common1: makeEntry("common1", "Session notes", "Session state notes.", "2026-08-02T00:00:00.000Z"),
				rare: makeEntry("rare", "Quantum note", "Only quantum annealing matters.", "2026-07-01T00:00:00.000Z"),
			},
		},
		{
			label: "whitespace-free CJK matches through bigram terms",
			query: "修复登录",
			winner: "login",
			loser: "tea",
			entries: {
				login: makeEntry("login", "Login fix", "登录故障排查记录。", "2026-08-01T00:00:00.000Z"),
				tea: makeEntry("tea", "Tea notes", "All about oolong brewing.", "2026-08-02T00:00:00.000Z"),
			},
		},
	])("ranks by $label", ({ query, winner, loser, entries }) => {
		const ranked = rank(entries, query);

		expect(ranked).toContain(`[global:${winner}]`);
		expect(ranked).not.toContain(`[global:${loser}]`);
	});

	it("falls back to alphabetical selection and tolerates non-string persisted fields", () => {
		const state = loadHarnessState(join(makeTempDir(), "h"), "local");
		state.entries.memory.aaa = makeEntry("aaa", "Alphabetical first", "Tea.", "2026-08-01T00:00:00.000Z");
		state.entries.memory.zzz = makeEntry("zzz", "Zebra note", "Worktree workflow.", "2026-08-02T00:00:00.000Z");
		(state.entries.memory.zzz as unknown as { title: null }).title = null;

		expect(formatHarnessStateForPrompt(state, { maxEntriesPerKind: 1 })).toContain("[global:aaa]");
		expect(() => formatHarnessStateForPrompt(state, { queryTerms: new Map([["worktree", 1]]) })).not.toThrow();
	});

	it("breaks score ties by stable identifier order, not recency", () => {
		const state = loadHarnessState(join(makeTempDir(), "h2"), "local");
		const older = makeEntry("aaa", "Worktree policy", "Same worktree signal.", "2026-08-01T00:00:00.000Z");
		const newer = makeEntry("zzz", "Worktree policy", "Same worktree signal.", "2026-09-01T00:00:00.000Z");
		state.entries.memory.aaa = older;
		state.entries.memory.zzz = newer;
		const ranked = formatHarnessStateForPrompt(state, {
			maxEntriesPerKind: 1,
			queryTerms: new Map([["worktree", 1]]),
		});
		// Equal scores render in stable identifier order ([path, title, id]);
		// updated_at recency must not hoist the newer entry into the window.
		expect(ranked).toContain("[global:aaa]");
		expect(ranked).not.toContain("[global:zzz]");
	});

	it.each<[string, string[]]>([
		["Worktree?", ["worktree"]],
		["path/to/skill", ["path", "skill"]],
		["harness_search", ["harness", "search"]],
		["??? / . ,", []],
		// Short ASCII runs stay noise; other non-ASCII scripts stay whole.
		["Fix the LOGIN bug", ["login"]],
		["Привет мир", ["привет"]],
		// Combining marks stay in their run: mark-heavy scripts spell whole words.
		["किताब notes", ["किताब", "notes"]],
		["naïve approach", ["naïve", "approach"]],
		// CJK has no spaces between words: runs become overlapping bigrams, so
		// partial matches stay findable and single characters count.
		["修复login", ["修复", "login"]],
		["修复登录", ["修复", "复登", "登录"]],
		["修复登录？", ["修复", "复登", "登录"]],
		["東京会議 login", ["東京", "京会", "会議", "login"]],
		["登", ["登"]],
		// Supplementary-plane ideographs count as CJK.
		["𠀀", ["𠀀"]],
		["𠀀𠀁𠀂", ["𠀀𠀁", "𠀁𠀂"]],
	])("tokenizes %j into %j", (query, expected) => {
		expect(harnessQueryTerms(query)).toEqual(expected);
	});
});
