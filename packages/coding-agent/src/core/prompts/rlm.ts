import { DEFAULT_RLM_EXTRA_IMPORT_LABELS } from "../kernel/bootstrap.js";

export interface RlmPromptOptions {
	cwd: string;
	skillsDir?: string;
	installedSkills?: string[];
	messagesPath: string;
	allowRecursion?: boolean;
	depth?: number;
	parentAgent?: string;
	activeTools?: string[];
}

const IPYTHON_CONTROL_PROMPT = [
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
].join("\n");

export interface ChildAgentDoctrineOptions {
	depth?: number;
	parentAgent?: string;
	installedSkills?: string[];
	activeTools?: string[];
}

export function buildChildAgentDoctrine(options: ChildAgentDoctrineOptions): string | undefined {
	const depth = options.depth ?? 0;
	const hasIpython = options.activeTools === undefined || options.activeTools.includes("ipython");
	const hasAgentMessage = options.installedSkills?.includes("agent_message") ?? false;
	if (depth <= 0) return undefined;

	const lines = [
		`You are a child agent spawned by ${options.parentAgent ?? "your parent agent"}. Task prompts are labeled \`[task from parent]\`.`,
	];
	if (hasAgentMessage && hasIpython) {
		lines.push(
			'When a task calls for an answer, reply explicitly with `await agent_message.send(message, receiver_role="parent")`. Not every message or task needs a reply; continue cleanup after sending and go idle normally.',
		);
	}
	return lines.join("\n");
}

export function buildRlmPrompt(options: RlmPromptOptions): string {
	const { cwd, skillsDir, messagesPath } = options;
	const installedSkills = options.installedSkills ?? [];
	const hasAgentMessage = installedSkills.includes("agent_message");
	const hasAgentObserve = installedSkills.includes("agent_observe");
	const allowRecursion = options.allowRecursion ?? true;
	const depth = options.depth ?? 0;
	const activeTools = options.activeTools ?? [];
	const hasIpython = options.activeTools === undefined ? true : activeTools.includes("ipython");
	const canRunShellSkills = hasIpython || activeTools.includes("bash");
	const parts = [
		"You are a general purpose agent that uses code to solve tasks.",
		"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
		"When you are done, stop calling tools and state your final answer.",
		"",
		`Working directory: ${cwd}`,
		`Conversation log: ${messagesPath}`,
		`Recursive agent depth: ${depth}`,
		`Pre-installed Python packages: ${DEFAULT_RLM_EXTRA_IMPORT_LABELS.join(", ")}.`,
		"Install additional packages with `uv pip install <pkg>` (this is a uv-managed venv with no pip module).",
	];

	const childDoctrine = buildChildAgentDoctrine(options);
	if (childDoctrine) {
		parts.push("", childDoctrine);
	}

	const skillLines: string[] = [];
	if (skillsDir) {
		skillLines.push(`Local skills live under ${skillsDir}. Read their SKILL.md files when helpful.`);
	}
	if (installedSkills.length > 0) {
		const installed = installedSkills.map((skill) => `\`${skill}\``).join(", ");
		if (hasIpython) {
			skillLines.push(`Installed Python skill modules (pre-imported): ${installed}.`);
			skillLines.push(
				"Read each skill's SKILL.md for its API. Inspect a module with `help(<skill>)` or `dir(<skill>)`, then inspect a documented callable with `inspect.signature(<skill>.<function>)`.",
			);
		} else if (canRunShellSkills) {
			skillLines.push(`Installed skills available as shell commands: ${installed}.`);
		}
		if (canRunShellSkills) {
			skillLines.push(
				"Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.",
			);
		}
		if (hasIpython && installedSkills.includes("edit")) {
			skillLines.push(
				"For targeted existing-file edits, prefer the pre-imported async `edit` skill from IPython: `old = '''...'''; new = '''...'''; await edit(path=\"pkg/file.py\", old_str=old, new_str=new)`. Use exact old/new strings; if the text contains triple double quotes, use triple single-quoted variables or build `old`/`new` from inspected file slices.",
			);
		}
	}
	if (skillLines.length > 0) {
		parts.push("", ...skillLines);
	}
	if (hasAgentMessage) {
		parts.push(
			"Agent messaging is restricted to your parent, siblings, and direct children; roots are siblings, and deeper communication relays through the intermediate child.",
		);
	}
	if (hasAgentObserve) {
		parts.push(
			"Agent observation is restricted to your parent, siblings, and direct children; roots are siblings, and deeper inspection relays through the intermediate child.",
		);
	}

	if (allowRecursion && hasIpython) {
		parts.push(
			"",
			"A callable `rlm` is already in your global namespace. `await rlm('sub-task')` spawns a child and returns immediately after task admission with `rlm_child_id`, `name`, `session_dir`, and `model`; it never waits for or returns the child's answer.",
			"Choose a stable child name with `await rlm('sub-task', name='api-reviewer')`; names must be unique among siblings. If omitted, the host generates a readable unique name.",
			"A child inherits your model and service tier when those options are omitted. If a different model is explicitly requested, use `await rlm.find_models(...)` and an exact returned selector. An unavailable requested model fails spawn; decide whether to retry or omit `model`.",
			"`service_tier` may be `auto`, `default`, `flex`, `scale`, `priority`, or `None`, but only values in the `rlmAllowedServiceTiers` settings array are accepted. When that setting is absent, only `defaultServiceTier` is allowed. `priority` is clamped to `default` when the selected child model does not support fast mode.",
		);
		if (hasAgentMessage) {
			parts.push(
				"Children reply explicitly with `await agent_message.send(message, receiver_role='parent')` when an answer is needed. Replies and follow-ups arrive as ordinary agent messages; not every task requires a reply.",
				"Use `await agent_message.list_agents()` to discover family and `await rlm.list_subagents()` to recover direct child handles. Use `agent_message.send(..., receiver_role='child', receiver_name=child.name)` for follow-ups.",
			);
		} else {
			parts.push("Use `await rlm.list_subagents()` to recover direct child handles after admission.");
		}
		if (hasAgentObserve) {
			parts.push(
				"Use `agent_observe` to inspect a child's rollout. Observation is restricted to your parent, siblings, and direct children; relay through the intermediate child for deeper descendants.",
			);
		} else {
			parts.push("Inspect files a child wrote when you need to collect its work without an observation capability.");
		}
		parts.push(
			"Spawn independent children in separate calls and end your turn instead of awaiting completion. Multiple replies may arrive over multiple turns. Delete a direct child explicitly with `await rlm.delete_subagent(child)` when it is no longer needed.",
		);
	}

	if (hasIpython) {
		parts.push("", IPYTHON_CONTROL_PROMPT);
		if (installedSkills.includes("refine")) {
			parts.push(
				"",
				"Treat continual harness refinement as a small, evidence-backed update after observing a repeated failure or reusable tactic: diagnose the issue, update the smallest relevant continual harness component, validate on the next action, then record the outcome. Use `await refine.run()` to turn repeated delegation patterns into reusable subagent specs, repeated procedures into skills, durable facts/preferences into memories, and narrow behavioral policies into prompt addendums. It returns immediately and runs when the current turn ends, so continue working normally after calling it. Do not rewrite the whole continual harness when a focused memory, skill, prompt note, or subagent spec is enough.",
			);
		}
	}

	return parts.join("\n");
}

/**
 * Supplemental sub-agent delegation guidance, appended after the base RLM
 * prompt (see system-prompt.ts). The recursion block covers the mechanics
 * (`rlm(...)` admission and handle management); this block adds the
 * when and why in the same When -> Why -> menu order Claude Code's Agent tool
 * uses. The subagent-spec menu itself renders just after this, inside the
 * harness-state block.
 */
export function buildSubagentGuidance(
	options: { includeRefineExamples?: boolean; hasAgentMessage?: boolean; hasAgentObserve?: boolean } = {},
): string {
	const lines = [
		"# Delegating to sub-agents",
		"",
		"Spawn independent, self-contained work with `handle = await rlm('task', name='worker')`. This returns at admission, not completion; keep the handle to stop or inspect the child later.",
		"Set a child's service tier only when its value appears in `rlmAllowedServiceTiers`; omit it to inherit the parent's tier. When the setting is absent, only `defaultServiceTier` is allowed. Explicit `priority` remains subject to child-model fast-mode clamping.",
	];
	if (options.hasAgentMessage) {
		lines.push(
			"Ask for an explicit reply when needed. A child replies with `await agent_message.send(message, receiver_role='parent')`; parent follow-ups use `receiver_role='child'` plus the child's name or id. Not every message needs a reply.",
		);
	}
	lines.push("Use `await rlm.list_subagents()` after kernel restart or compaction.");
	if (options.hasAgentObserve) {
		lines.push("Use `agent_observe` for bounded transcript inspection.");
	}
	lines.push(
		"Have children write files and read those files for fan-in.",
		"Delegate parallel context-heavy research or independent implementation; do a single known lookup, edit, or command inline.",
	);
	if (options.includeRefineExamples ?? true) {
		lines.push("Persist genuinely reusable delegation patterns with `await refine.run()`.");
	}
	return lines.join("\n");
}
