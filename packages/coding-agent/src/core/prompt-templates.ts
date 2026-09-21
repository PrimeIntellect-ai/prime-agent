import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { CONFIG_DIR_NAME } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { isUnderPath, resolveUserPath } from "../utils/paths.js";
import { parseSlashCommand } from "./slash-commands.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	sourceInfo: SourceInfo;
	filePath: string; // Absolute path to the template file
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	// An explicitly quoted token is an argument even when empty ("" or '').
	let quoted = false;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
			quoted = true;
		} else if (/[\t\p{Zs}]/u.test(char)) {
			if (current || quoted) {
				args.push(current);
				current = "";
				quoted = false;
			}
		} else {
			current += char;
		}
	}

	if (current || quoted) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$(?:(\d+)|\{@:(\d+)(?::(\d+))?\}|ARGUMENTS|@)/g,
		(_, num: string | undefined, startStr: string | undefined, lengthStr: string | undefined) => {
			if (num !== undefined) {
				return args[parseInt(num, 10) - 1] ?? "";
			}
			if (startStr !== undefined) {
				// Slices are 1-indexed; zero also starts at the first argument.
				const start = Math.max(0, parseInt(startStr, 10) - 1);
				const end = lengthStr !== undefined ? start + parseInt(lengthStr, 10) : undefined;
				return args.slice(start, end).join(" ");
			}
			return allArgs;
		},
	);
}

function loadTemplateFromFile(filePath: string, sourceInfo: SourceInfo): PromptTemplate | null {
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(rawContent);

		const name = basename(filePath).replace(/\.md$/, "");

		// Get description from frontmatter or first non-empty line
		let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				// Truncate if too long
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}
		const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;

		return {
			name,
			description,
			...(argumentHint && { argumentHint }),
			content: body,
			sourceInfo,
			filePath,
		};
	} catch {
		return null;
	}
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
function loadTemplatesFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): PromptTemplate[] {
	const templates: PromptTemplate[] = [];

	if (!existsSync(dir)) {
		return templates;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a file
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			if (isFile && entry.name.endsWith(".md")) {
				const template = loadTemplateFromFile(fullPath, getSourceInfo(fullPath));
				if (template) {
					templates.push(template);
				}
			}
		}
	} catch {
		return templates;
	}

	return templates;
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. */
	cwd: string;
	/** Agent config directory for global templates. */
	agentDir: string;
	/** Explicit prompt template paths (files or directories). */
	promptPaths: string[];
	/** Include default prompt directories. */
	includeDefaults: boolean;
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. Explicit prompt paths
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): PromptTemplate[] {
	const resolvedCwd = options.cwd;
	const resolvedAgentDir = options.agentDir;
	const promptPaths = options.promptPaths;
	const includeDefaults = options.includeDefaults;

	const templates: PromptTemplate[] = [];

	const globalPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalPromptsDir,
			});
		}
		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}
		return createSyntheticSourceInfo(resolvedPath, {
			source: "local",
			baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
		});
	};

	if (includeDefaults) {
		templates.push(...loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		templates.push(...loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}

	// 3. Load explicit prompt paths
	for (const rawPath of promptPaths) {
		const resolvedPath = resolveUserPath(rawPath, resolvedCwd);
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			if (stats.isDirectory()) {
				templates.push(...loadTemplatesFromDir(resolvedPath, getSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const template = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
				if (template) {
					templates.push(template);
				}
			}
		} catch {
			// Ignore read failures
		}
	}

	return templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const parsed = parseSlashCommand(text);
	if (!parsed) return text;
	const templateName = parsed.name;
	const argsString = parsed.args;

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}
