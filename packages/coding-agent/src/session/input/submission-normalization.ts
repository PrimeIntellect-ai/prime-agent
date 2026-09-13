import { readFileSync } from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionRunner, InputSource } from "../../core/extensions/index.js";
import { expandPromptTemplate, type PromptTemplate } from "../../core/prompt-templates.js";
import type { Skill } from "../../core/skills.js";
import { parseSessionSlashCommand, parseSlashCommand, type SessionSlashCommand } from "../../core/slash-commands.js";
import { stripFrontmatter } from "../../utils/frontmatter.js";

type SubmissionExtensionCommandPolicy = "execute" | "reject" | "ignore";

export interface SubmissionNormalizationPolicy {
	parseSessionCommands: boolean;
	extensionCommands: SubmissionExtensionCommandPolicy;
	inputSource?: InputSource;
	expandSkills: boolean;
	expandPromptTemplates: boolean;
}

export type NormalizedSubmission =
	| { kind: "prompt"; text: string; images?: ImageContent[] }
	| {
			kind: "sessionCommand";
			text: string;
			images?: ImageContent[];
			command: SessionSlashCommand;
	  }
	| { kind: "extensionCommand"; completion: Promise<void> }
	| { kind: "handled" };

export interface SubmissionNormalizationHost {
	getExtensions(): Pick<
		ExtensionRunner,
		"hasHandlers" | "emitInput" | "getCommand" | "createCommandContext" | "emitError"
	>;
	getPrompts(): readonly PromptTemplate[];
	getSkills(): readonly Skill[];
}
export class SubmissionNormalizer {
	constructor(private readonly host: SubmissionNormalizationHost) {}
	finishSubmissionNormalization(
		text: string,
		images: ImageContent[] | undefined,
		policy: SubmissionNormalizationPolicy,
	): NormalizedSubmission {
		let expandedText = text;
		if (policy.expandSkills) expandedText = this.expandSkillCommand(expandedText);
		if (policy.expandPromptTemplates) {
			expandedText = expandPromptTemplate(expandedText, [...this.host.getPrompts()]);
		}
		return { kind: "prompt", text: expandedText, images };
	}

	normalizeSubmission(
		text: string,
		images: ImageContent[] | undefined,
		policy: SubmissionNormalizationPolicy,
	): NormalizedSubmission | Promise<NormalizedSubmission> {
		if (policy.parseSessionCommands) {
			const command = parseSessionSlashCommand(text);
			if (command) return { kind: "sessionCommand", text, images, command };
		}

		if (text.startsWith("/")) {
			if (policy.extensionCommands === "execute") {
				const completion = this.executeExtensionCommand(text);
				if (completion) return { kind: "extensionCommand", completion };
			} else if (policy.extensionCommands === "reject") {
				this.throwIfExtensionCommand(text);
			}
		}

		if (policy.inputSource !== undefined && this.host.getExtensions().hasHandlers("input")) {
			return this.host
				.getExtensions()
				.emitInput(text, images, policy.inputSource)
				.then((result) => {
					if (result.action === "handled") return { kind: "handled" };
					if (result.action === "transform") {
						return this.finishSubmissionNormalization(result.text, result.images ?? images, policy);
					}
					return this.finishSubmissionNormalization(text, images, policy);
				});
		}

		return this.finishSubmissionNormalization(text, images, policy);
	}

	executeExtensionCommand(text: string): Promise<void> | undefined {
		const parsed = parseSlashCommand(text);
		if (!parsed) return undefined;
		const commandName = parsed.name;
		const args = parsed.args;

		const command = this.host.getExtensions().getCommand(commandName);
		if (!command) return undefined;
		const context = this.host.getExtensions().createCommandContext();
		return Promise.resolve()
			.then(() => command.handler(args, context))

			.catch((error: unknown) => {
				const commandError = error instanceof Error ? error : new Error(String(error));
				this.host.getExtensions().emitError({
					extensionPath: `command:${commandName}`,
					event: "command",
					error: commandError.message,
				});
				throw commandError;
			});
	}

	expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const parsed = parseSlashCommand(text);
		if (!parsed?.name.startsWith("skill:")) return text;
		const skillName = parsed.name.slice("skill:".length);
		const args = parsed.args;

		const skill = this.host.getSkills().find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			this.host.getExtensions().emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	throwIfExtensionCommand(text: string): void {
		const commandName = parseSlashCommand(text)?.name ?? "";
		const command = this.host.getExtensions().getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}
}
