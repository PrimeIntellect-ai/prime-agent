/**
 * System prompt construction and project context loading
 */

import { buildChildAgentDoctrine, buildRlmPrompt, buildSubagentGuidance } from "./prompts/index.js";
import { formatHarnessStateForPrompt, type HarnessState, REFINE_SKILL_NAME } from "./refinement/index.js";
import { formatSkillsForPrompt, getPythonSkillRuntimeInfo, type Skill } from "./skills.js";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Active tools. Tool schemas carry tool descriptions outside the prompt body. */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. Used only for custom prompts. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the system prompt. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Conversation log path. */
	messagesPath?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Whether to include the model-facing rlm recursion guidance. */
	allowRecursion?: boolean;
	/** Fixed recursive-agent depth for this session. */
	rlmDepth?: number;
	/** Human-readable parent name or id for child communication doctrine. */
	rlmParentAgent?: string;
	/** Global harness state to inject as compact persistent context. */
	harnessState?: HarnessState;
	/** Enabled user-configured servers available through the generic kernel MCP API. */
	genericMcpServers?: string[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		messagesPath,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		allowRecursion,
		harnessState,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");
	const promptMessagesPath = (messagesPath ?? "not persisted").replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const tools = selectedTools ?? ["ipython"];
	const hasIpython = tools.includes("ipython");
	const hasBash = tools.includes("bash");
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	const visiblePythonSkillImportNames = getPythonSkillRuntimeInfo(visibleSkills).map((skill) => skill.importName);
	const hasRefineSkill = visibleSkills.some((skill) => skill.name === REFINE_SKILL_NAME);
	const genericMcpSection = hasIpython ? formatGenericMcpGuidance(options.genericMcpServers) : "";

	if (customPrompt) {
		let prompt = customPrompt;

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section only when the model has a way to inspect skill files.
		const customPromptHasFileAccess =
			!selectedTools || selectedTools.includes("ipython") || selectedTools.includes("bash");
		if (customPromptHasFileAccess && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		const childDoctrine = buildChildAgentDoctrine({
			depth: options.rlmDepth,
			parentAgent: options.rlmParentAgent,
			installedSkills: visiblePythonSkillImportNames,
			activeTools: tools,
		});
		if (childDoctrine) {
			prompt += `\n\n${childDoctrine}`;
		}

		if (harnessState) {
			prompt += `\n\n${formatHarnessStateForPrompt(harnessState, { includeIpythonExamples: hasIpython, includeShellExamples: hasBash, includeRefineExamples: hasIpython && hasRefineSkill })}`;
		}

		if (genericMcpSection) {
			prompt += `\n\n${genericMcpSection}`;
		}

		if (appendSection) {
			prompt += appendSection;
		}

		return prompt;
	}

	let prompt = buildRlmPrompt({
		cwd: promptCwd,
		messagesPath: promptMessagesPath,
		installedSkills: visiblePythonSkillImportNames,
		activeTools: tools.filter((name) => name === "ipython" || name === "bash" || name === "edit"),
		allowRecursion,
		depth: options.rlmDepth,
		parentAgent: options.rlmParentAgent,
	});

	// Appended AFTER the trained buildRlmPrompt prefix, and before the harness-state
	// menu, so the model reads when/why to delegate and then sees the concrete subagent
	// specs it can match against — the same ordering as Claude Code's Agent tool.
	if ((allowRecursion ?? true) && hasIpython) {
		const visiblePythonSkillNames = new Set(
			getPythonSkillRuntimeInfo(visibleSkills).map((skill) => skill.importName),
		);
		prompt += `\n\n${buildSubagentGuidance({
			includeRefineExamples: hasRefineSkill,
			hasAgentMessage: visiblePythonSkillNames.has("agent_message"),
			hasAgentObserve: visiblePythonSkillNames.has("agent_observe"),
		})}`;
	}

	if (harnessState) {
		prompt += `\n\n${formatHarnessStateForPrompt(harnessState, { includeIpythonExamples: hasIpython, includeShellExamples: hasBash, includeRefineExamples: hasIpython && hasRefineSkill })}`;
	}

	if (genericMcpSection) {
		prompt += `\n\n${genericMcpSection}`;
	}

	const guidelines = formatPromptGuidelines(promptGuidelines);
	if (guidelines) {
		prompt += `\n\n# Additional Guidance\n\n${guidelines}`;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section only when the model has a way to inspect skill files.
	const hasFileAccess = tools.includes("ipython") || tools.includes("bash");
	if (hasFileAccess && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	if (appendSection) {
		prompt += appendSection;
	}

	return prompt;
}

function formatGenericMcpGuidance(servers: string[] | undefined): string {
	const enabledServers = [...new Set(servers ?? [])].sort((left, right) => left.localeCompare(right));
	if (enabledServers.length === 0) return "";

	return [
		"# Generic MCP Connections",
		"",
		"Generic MCP connections are accessed through the pre-imported Python `mcp` object in IPython, not as top-level native tool namespaces or installed Python skills.",
		`Enabled generic MCP servers: ${enabledServers.map((server) => `\`${server}\``).join(", ")}.`,
		...enabledServers.map(
			(server) =>
				`For \`${server}\`, first discover its tools with \`await mcp.list_tools("${server}")\`, then call one with \`await mcp.call_tool("${server}", "<tool>", arguments)\`.`,
		),
	].join("\n");
}

function formatPromptGuidelines(promptGuidelines: string[] | undefined): string {
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0 && !guidelinesSet.has(normalized)) {
			guidelinesSet.add(normalized);
			guidelinesList.push(normalized);
		}
	}

	return guidelinesList.map((guideline) => `- ${guideline}`).join("\n");
}
