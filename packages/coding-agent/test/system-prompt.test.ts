import { describe, expect, test } from "vitest";
import { DEFAULT_RLM_EXTRA_IMPORT_LABELS } from "../src/core/kernel/bootstrap.js";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { HarnessState } from "../src/core/refinement/index.js";
import type { Skill } from "../src/core/skills.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import { createIpythonToolDefinition } from "../src/core/tools/ipython.js";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: {
			source: "local",
			path: `/skills/${name}/SKILL.md`,
			scope: "project",
			origin: "top-level",
		},
		disableModelInvocation: false,
		kind: "markdown",
	};
}

function pythonSkill(name: string, importName = name.replaceAll("-", "_")): Skill {
	const base = skill(name);
	return {
		...base,
		kind: "python",
		python: {
			importName,
			packagePath: `/skills/${name}`,
			pyprojectPath: `/skills/${name}/pyproject.toml`,
		},
	};
}

describe("buildRlmPrompt", () => {
	test("builds the rlm prompt without recursion", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch", "refine"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toBe(
			[
				"You are a general purpose agent that uses code to solve tasks.",
				"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
				"When you are done, stop calling tools and state your final answer.",
				"",
				"Working directory: /repo",
				"Conversation log: /repo/.pi/sessions/session.jsonl",
				"Recursive agent depth: 0",
				`Pre-installed Python packages: ${DEFAULT_RLM_EXTRA_IMPORT_LABELS.join(", ")}.`,
				"Install additional packages with `uv pip install <pkg>` (this is a uv-managed venv with no pip module).",
				"",
				"Installed Python skill modules (pre-imported): `websearch`, `refine`.",
				"Read each skill's SKILL.md for its API. Inspect a module with `help(<skill>)` or `dir(<skill>)`, then inspect a documented callable with `inspect.signature(<skill>.<function>)`.",
				"Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
				"",
				"IPython is the agent's long-lived notebook: a persistent control environment for reasoning, context management, state, tool orchestration, and recursive subcalls. Use it to keep intermediate variables, inspect and transform outputs, write small helper functions, and preserve useful state across turns or compaction.",
				"",
				"Do not assume IPython is the native runtime of the external thing being investigated. A repository, package, service, dataset, paper, website, benchmark, or API may have its own environment and normal interface. Evaluate external systems through their own interface, then use IPython to coordinate the process and analyze what comes back.",
				"",
				"When running shell commands from IPython, use `%%bash` cells. If you use `%%bash`, it must be the first line of the code cell: no comments, spaces, blank lines, imports, or Python statements before it. Avoid `!cmd` shell escapes for project commands so shell behavior is explicit and multi-line commands share one shell context.",
				"",
				"Important: do not install dependencies into the IPython kernel just to make an external project import or run there. If a project import, test, script, CLI, or dependency check is needed, run it through that project's own environment and normal command interface. For example, in a Python repo use its documented commands, `uv run ...`, `.venv/bin/python ...`, or the active project interpreter from the repo root. Treat failures from that native environment as the relevant result.",
				"",
				"Use Python for reading, searching, and editing files — it gives you reusable variables you can slice, filter, and act on without re-reading. Always assign read/search results to named variables so you can revisit them later.",
				"",
				"Each `%%bash` cell runs in a throw-away subshell, so shell-level state (`cd`, `export`, `source`, shell variables) does NOT carry to later cells. Keep dependent shell steps inside one `%%bash` cell when they need shared shell state, or use kernel-level equivalents that survive across calls: `%cd <dir>` for the working directory and `os.environ['VAR'] = '...'` (or `%env VAR=...`) for environment variables — these apply to all subsequent `%%bash` calls.",
				"",
				"Python state in the kernel, by contrast, persists across cells: named variables, helper functions, classes, imports, notes, parsed outputs, and helper data structures all remain available in every later turn. Tool calls are themselves Python `await` expressions, so their return values can be bound to variables and composed into program logic just like any other call.",
				"",
				"Continual harness state is available as `rlm.harness` and `rlm.get_harness_state()`. CRUD calls are local to this Prime Agent session by default: `rlm.harness.create_memory(...)`, `rlm.harness.update_memory(...)`, `rlm.harness.delete_memory(...)`, `rlm.harness.create_skill(...)`, `rlm.harness.update_skill(...)`, `rlm.harness.delete_skill(...)`, `rlm.harness.create_subagent(...)`, `rlm.harness.update_subagent(...)`, `rlm.harness.delete_subagent(...)`, `rlm.harness.create_prompt_note(...)`, `rlm.harness.update_prompt_note(...)`, `rlm.harness.delete_prompt_note(...)`, plus `rlm.harness.record_refinement(...)` and `rlm.harness.overview()`. Use `global_=True` only for stable cross-session lessons; Python reserves `global`, so literal `global=True` is invalid syntax.",
				"",
				"Terminology: continual harness names the persisted prompt, memory, skill, and subagent layer; RLM names the runtime, IPython kernel, and native call interface exposed to the model.",
				"",
				"RLM-native call contract: installed Python skills are pre-imported modules. Read the matching SKILL.md and call its documented function, such as `await <skill_import>.<function>(...)`; when a CLI exists, use `<skill_import> ...` from shell. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a reusable delegation spec with `await rlm('sub-task')`; admission returns a child handle immediately. Results arrive only through an available messaging capability or files, never as an `rlm()` return value. Do not invent non-native wrappers such as `call_skill(...)` or `run_subagent(...)`.",
				"",
				"Treat continual harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant continual harness component, validate on the next action, then record the outcome. Use `await refine.run()` to turn repeated delegation patterns into reusable subagent specs, repeated procedures into skills, durable facts/preferences into memories, and narrow behavioral policies into prompt addendums. It returns immediately and runs when the current turn ends, so continue working normally after calling it. Do not rewrite the whole continual harness when a focused memory, skill, prompt note, or subagent spec is enough.",
			].join("\n"),
		);
	});

	test("defaults omitted activeTools to ipython guidance", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
		});

		expect(prompt).toContain("Installed Python skill modules (pre-imported): `websearch`.");
		expect(prompt).toContain("A callable `rlm` is already in your global namespace");
		expect(prompt).toContain("IPython is the agent's long-lived notebook");
		expect(prompt).toContain("Each `%%bash` cell runs in a throw-away subshell");
	});

	test("discovers requested models through a bounded authenticated host search", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
		});

		expect(prompt).toContain("await rlm.find_models(...)");
		expect(prompt).toContain("exact returned selector");
		expect(prompt).toContain("An unavailable requested model fails spawn");
		expect(prompt).toContain("decide whether to retry or omit `model`");
		expect(prompt).toContain("`service_tier` may be `auto`, `default`, `flex`, `scale`, `priority`, or `None`");
		expect(prompt).toContain("only values in the `rlmAllowedServiceTiers` settings array are accepted");
		expect(prompt).toContain("When that setting is absent, only `defaultServiceTier` is allowed");
		expect(prompt).not.toContain("model choices for subagents");
	});

	test("only documents ipython shell prefixes when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).not.toContain("IPython is the agent's long-lived notebook");
	});

	test("keeps shell skill command guidance when ipython is inactive", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["bash"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Installed skills available as shell commands: `websearch`.");
		expect(prompt).toContain("Each skill is also available as a shell command");
		expect(prompt).toContain("`<skill> --help`");
		expect(prompt).not.toContain("Installed Python skill modules (pre-imported)");
		expect(prompt).not.toContain("Read each skill's SKILL.md for its API");
	});

	test("gates agent messaging and observation doctrine on installed Python skills", () => {
		const withoutCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withoutCapabilities).not.toContain("agent_message.send");
		expect(withoutCapabilities).not.toContain("agent_message.list_agents");
		expect(withoutCapabilities).not.toContain("agent_observe");

		const systemPromptWithoutCapabilities = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});
		expect(systemPromptWithoutCapabilities).not.toContain("agent_message.send");
		expect(systemPromptWithoutCapabilities).not.toContain("agent_observe");

		const withCapabilities = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message", "agent_observe"],
			activeTools: ["ipython"],
			allowRecursion: true,
			depth: 1,
		});
		expect(withCapabilities).toContain("agent_message.send");
		expect(withCapabilities).toContain("agent_message.list_agents");
		expect(withCapabilities).toContain("agent_observe");
		expect(withCapabilities).toContain("restricted to your parent, siblings, and direct children");
	});

	test("does not prescribe kernel-only child replies without ipython", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/session.jsonl",
			installedSkills: ["agent_message"],
			activeTools: ["bash"],
			depth: 1,
		});

		expect(prompt).toContain("You are a child agent");
		expect(prompt).not.toContain("When a task calls for an answer, reply explicitly with `await agent_message.send");
	});

	test("exposes the automatic child registry independently of observation skills", () => {
		const withoutObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
		});
		const withObserve = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["agent_observe"],
			activeTools: ["ipython"],
		});

		for (const prompt of [withoutObserve, withObserve]) {
			expect(prompt).toContain("await rlm.list_subagents()");
			expect(prompt).toContain("await rlm.delete_subagent(child)");
			expect(prompt).toContain("recover direct child handles");
			expect(prompt).not.toContain("Write a small disk registry");
		}
	});

	test("documents the %%bash first-line rule when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toContain("it must be the first line of the code cell");
	});

	test("documents preferring Python for reading and searching files when ipython is active", () => {
		const prompt = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(prompt).toContain("Use Python for reading, searching, and editing files");
		expect(prompt).toContain("Always assign read/search results to named variables");
	});

	test("includes the edit skill guidance only when the edit skill is installed", () => {
		const withEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["edit"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(withEdit).toContain('await edit(path="pkg/file.py", old_str=old, new_str=new)');
		expect(withEdit).toContain("triple double quotes");

		const withoutEdit = buildRlmPrompt({
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			installedSkills: ["websearch"],
			activeTools: ["ipython"],
			allowRecursion: false,
		});

		expect(withoutEdit).not.toContain("await edit(path=");
	});
});

describe("buildSystemPrompt", () => {
	test("injects compact global harness context and refine guidance by default", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {
					focused_edits: {
						id: "focused_edits",
						kind: "prompt",
						title: "Focused edits",
						content: "Prefer small prompt, memory, skill, or subagent updates over broad rewrites.",
						path: "policy",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				memory: {
					validation: {
						id: "validation",
						kind: "memory",
						title: "Validation",
						content: "Run `npm run check` after PrimeAgent code changes.",
						path: "repo/prime-agent",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 2,
					},
				},
				skill: {
					review_refinement: {
						id: "review_refinement",
						kind: "skill",
						title: "Review refinement",
						content: "Check requested edit coverage, rollback safety, and validation commands.",
						path: "quality",
						reference: {
							type: "python",
							import: "agent_skills.review_refinement",
							callable: "review_refinement",
							call_pattern: "await review_refinement(task=...)",
						},
						arguments: {
							task: { type: "string", required: true, description: "Review task to perform." },
						},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				subagent: {
					refinement_reviewer: {
						id: "refinement_reviewer",
						kind: "subagent",
						title: "Refinement reviewer",
						content: "Review proposed harness edits for scope, evidence, and unintended behavior.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [
				{
					id: "refine_1",
					trigger: "Observed validation miss",
					changes: ["create memory:validation"],
					evidence: "manual test",
					outcome: "Future runs should name npm run check.",
					created_at: "2026-06-08T00:00:00.000Z",
				},
			],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("refine"), pythonSkill("agent-message"), pythonSkill("agent-observe")],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("Local continual harness entries belong to this Prime Agent session");
		expect(prompt).toContain("The continual harness entries below are compact summaries, not full descriptions");
		expect(prompt).toContain("Use global continual harness refinement only for stable cross-session lessons");
		expect(prompt).toContain("When to call `await refine.run()`");
		expect(prompt).toContain("Call contract: read each installed Python skill's SKILL.md");
		expect(prompt).toContain("Continual harness skill entries are Python REPL skills");
		expect(prompt).toContain("Spawn a continual harness subagent spec by composing a concise task prompt");
		expect(prompt).toContain("handle = await rlm('sub-task')");
		expect(prompt).toContain("admission returns immediately");
		expect(prompt).toContain("never the child's answer");
		expect(prompt).toContain("receiver_role='parent'");
		expect(prompt).toContain("await rlm.list_subagents()");
		expect(prompt).toContain("receiver_role='child'");
		expect(prompt).not.toContain("asyncio.create_task(rlm('sub-task'))");
		expect(prompt).not.toContain("asyncio.gather(rlm('task1'), rlm('task2'))");
		expect(prompt).toContain("after a repeated failure");
		expect(prompt).toContain("a reusable tactic emerges");
		expect(prompt).toContain("a repeated delegation role should become a subagent spec");
		expect(prompt).toContain("a repeated procedure should become a skill");
		expect(prompt).toContain("a durable fact/preference should become a memory");
		expect(prompt).toContain("a narrow behavioral policy should become a prompt addendum");
		expect(prompt).toContain("validation shows a continual harness entry is wrong");
		expect(prompt).toContain("[global:focused_edits] Focused edits (policy, v1)");
		expect(prompt).toContain("[global:validation] Validation (repo/prime-agent, v2): Run `npm run check`");
		expect(prompt).toContain("[global:review_refinement] Review refinement (quality, v1)");
		expect(prompt).toContain("[global:refinement_reviewer] Refinement reviewer (review, v1)");
		expect(prompt).toContain("recent refinements: 1");
		expect(prompt).toContain("[refine_1] Observed validation miss: create memory:validation");
		expect(prompt.indexOf("# Continual Harness State")).toBeGreaterThan(prompt.indexOf("Conversation log:"));
	});

	test("keeps injected harness context compact", () => {
		const longContent = "x".repeat(500);
		const memoryEntries: HarnessState["entries"]["memory"] = {};
		for (let i = 0; i < 8; i++) {
			memoryEntries[`memory_${i}`] = {
				id: `memory_${i}`,
				kind: "memory",
				title: `Memory ${i}`,
				content: longContent,
				path: "overflow",
				reference: {},
				arguments: {},
				metadata: {},
				source: "refine",
				created_at: "2026-06-08T00:00:00.000Z",
				updated_at: "2026-06-08T00:00:00.000Z",
				version: 1,
			};
		}
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: memoryEntries,
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("memory: 8");
		expect(prompt).toContain("- +2 more memory entries");
		expect(prompt).toContain(`${"x".repeat(177)}...`);
		expect(prompt).not.toContain(longContent);
	});

	test("uses the model-agnostic rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("refine"), pythonSkill("agent-message"), pythonSkill("agent-observe")],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("Working directory: /repo");
		expect(prompt).toContain("Conversation log: /repo/.pi/sessions/session.jsonl");
		expect(prompt).toContain("await rlm('sub-task')");
		expect(prompt).toContain("returns at admission, not completion");
		expect(prompt).toContain("Results arrive only through an available messaging capability or files");
		expect(prompt).toContain("recover direct child handles");
		expect(prompt).toContain("kernel restart or compaction");
		expect(prompt).toContain("rlm.list_subagents");
		expect(prompt).toContain("rlm.delete_subagent");
		expect(prompt).toContain("rlm_child_id");
		expect(prompt).toContain("name='api-reviewer'");
		expect(prompt).toContain("session_dir");
		expect(prompt).toContain("agent_observe");
		expect(prompt).toContain("restricted to your parent, siblings, and direct children");
	});

	test("omits ipython-only subagent guidance when ipython is inactive", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {},
				skill: {},
				subagent: {
					worker: {
						id: "worker",
						kind: "subagent",
						title: "Worker",
						content: "Review a self-contained task and report findings.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [],
		};
		const prompt = buildSystemPrompt({
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("Call contract: use installed skills as shell commands");
		expect(prompt).toContain("subagent: 1");
		expect(prompt).not.toContain("IPython is the agent's long-lived notebook");
		expect(prompt).not.toContain("Default to non-blocking subagents");
		expect(prompt).not.toContain("agent_observe.list_agents");
		expect(prompt).not.toContain("asyncio.create_task");
		expect(prompt).not.toContain("await <skill_import>");
		expect(prompt).not.toContain("await refine.run()");
	});

	test("omits shell guidance from harness state when shell is inactive", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {},
				skill: {},
				subagent: {
					worker: {
						id: "worker",
						kind: "subagent",
						title: "Worker",
						content: "Review a self-contained task and report findings.",
						path: "review",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
			},
			refinements: [],
		};
		const prompt = buildSystemPrompt({
			selectedTools: ["edit"],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			messagesPath: "/repo/.pi/sessions/session.jsonl",
			harnessState,
		});

		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("without IPython or shell access");
		expect(prompt).not.toContain("use installed skills as shell commands");
		expect(prompt).not.toContain("<skill_import> ...");
		expect(prompt).not.toContain("asyncio.create_task");
		expect(prompt).not.toContain("await <skill_import>");
		expect(prompt).not.toContain("await refine.run()");
	});

	test("custom prompt override bypasses the rlm harness body", () => {
		const harnessState: HarnessState = {
			schema: 1,
			entries: {
				prompt: {},
				memory: {
					custom_memory: {
						id: "custom_memory",
						kind: "memory",
						title: "Custom memory",
						content: "Custom prompts still receive harness state.",
						path: "custom",
						reference: {},
						arguments: {},
						metadata: {},
						source: "refine",
						created_at: "2026-06-08T00:00:00.000Z",
						updated_at: "2026-06-08T00:00:00.000Z",
						version: 1,
					},
				},
				skill: {},
				subagent: {},
			},
			refinements: [],
		};

		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["ipython"],
			appendSystemPrompt: "custom append",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
			harnessState,
		});

		expect(prompt).toContain("custom body");
		expect(prompt).toContain("# Continual Harness State");
		expect(prompt).toContain("[global:custom_memory] Custom memory (custom, v1)");
		expect(prompt).not.toContain("# IPython Kernel Guidance");
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(
			prompt.indexOf("# Continual Harness State"),
		);
		expect(prompt.indexOf("Current working directory: /repo")).toBeLessThan(prompt.indexOf("custom append"));
		expect(prompt.indexOf("# Continual Harness State")).toBeLessThan(prompt.indexOf("custom append"));
	});

	test("adds child reply doctrine to custom prompts when messaging is available", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "custom body",
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("agent-message")],
			cwd: "/repo",
			rlmDepth: 1,
			rlmParentAgent: "orchestrator",
		});

		expect(prompt).toContain("You are a child agent spawned by orchestrator");
		expect(prompt).toContain('await agent_message.send(message, receiver_role="parent")');
		expect(prompt).not.toContain("You are a general purpose agent that uses code to solve tasks.");
	});

	test("gates custom-prompt child reply doctrine on IPython and agent messaging", () => {
		const build = (selectedTools: string[], skills: Skill[]) =>
			buildSystemPrompt({
				customPrompt: "custom body",
				selectedTools,
				contextFiles: [],
				skills,
				cwd: "/repo",
				rlmDepth: 1,
			});

		expect(build(["ipython"], [])).toContain("You are a child agent spawned by your parent agent");
		expect(build(["ipython"], [])).not.toContain("agent_message.send");
		expect(build(["bash"], [pythonSkill("agent-message")])).not.toContain("agent_message.send");
	});

	test("append system prompt content is included after the rlm harness prompt", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			appendSystemPrompt: "extra instruction",
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt.indexOf("Treat harness refinement as a small, evidence-backed update")).toBeLessThan(
			prompt.indexOf("extra instruction"),
		);
		expect(prompt).not.toContain("Call at most one built-in tool per turn.");
	});

	test("project context files are appended", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Project Context");
		expect(prompt).toContain("## AGENTS.md\n\nproject rules");
	});

	test("markdown skills are included in rlm harness prompts without Python pre-imports", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [skill("websearch")],
			cwd: "/repo",
		});

		expect(prompt).not.toContain("Installed Python skill modules (pre-imported)");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("<name>websearch</name>");
		expect(prompt).toContain("<type>markdown</type>");
		expect(prompt).toContain("<location>/skills/websearch/SKILL.md</location>");
	});

	test("Python skills are configured for IPython and included in skill metadata", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython"],
			contextFiles: [],
			skills: [pythonSkill("web-search")],
			cwd: "/repo",
		});

		expect(prompt).toContain("Installed Python skill modules (pre-imported): `web_search`.");
		expect(prompt).toContain("<name>web-search</name>");
		expect(prompt).toContain("<type>python</type>");
		expect(prompt).toContain("<python_import>web_search</python_import>");
	});

	test("prompt guidelines are appended and deduplicated", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["ipython", "dynamic_tool"],
			promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
			contextFiles: [],
			skills: [],
			cwd: "/repo",
		});

		expect(prompt).toContain("# Additional Guidance");
		expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
	});
});

describe("createIpythonToolDefinition", () => {
	test("describes project checks as target-environment work", () => {
		const tool = createIpythonToolDefinition("/repo");

		expect(tool.description).toContain("Python scratchpad code");
		expect(tool.description).toContain("target project's own environment");
		expect(tool.promptSnippet).toContain("%%bash orchestration");
		const codeSchema = tool.parameters.properties.code;
		const codeDescription =
			"description" in codeSchema && typeof codeSchema.description === "string" ? codeSchema.description : "";
		expect(codeDescription).toContain("target project's own environment");
	});
});
