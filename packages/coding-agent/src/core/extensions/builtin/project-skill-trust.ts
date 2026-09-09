/**
 * Built-in `/trust-project-skills` command.
 *
 * Project Python skills (code shipped inside the opened repository) are only
 * installed into the kernel after an explicit, persisted trust decision. The
 * startup selector asks once; this command changes the decision later and
 * reloads so the kernel picks up (or drops) the project packages.
 */

import {
	getProjectPythonSkills,
	PROJECT_SKILL_TRUST_COMMAND,
	type ProjectSkillTrustStore,
} from "../../project-skill-trust.js";
import type { Skill } from "../../skills.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../types.js";

export interface ProjectSkillTrustExtensionOptions {
	store: ProjectSkillTrustStore;
	/** Skills as discovered by the resource loader (before the session applies trust). */
	getSkills: () => readonly Skill[];
}

const SUBCOMMANDS = ["status", "on", "off", "reset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function parseSubcommand(args: string): Subcommand | undefined {
	const trimmed = args.trim().toLowerCase();
	if (trimmed === "") return "status";
	return SUBCOMMANDS.find((candidate) => candidate === trimmed);
}

function formatSkillList(skills: readonly Skill[]): string {
	const names = getProjectPythonSkills(skills).map((skill) => skill.name);
	return names.length > 0 ? names.join(", ") : "none discovered";
}

export function createProjectSkillTrustExtension(options: ProjectSkillTrustExtensionOptions): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerCommand(PROJECT_SKILL_TRUST_COMMAND, {
			description: "Trust (on), deny (off), reset, or show the status of this project's Python skills",
			getArgumentCompletions: (prefix) =>
				SUBCOMMANDS.filter((candidate) => candidate.startsWith(prefix.trim().toLowerCase())).map((value) => ({
					value,
					label: value,
				})),
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const subcommand = parseSubcommand(args);
				if (!subcommand) {
					ctx.ui.notify(`Usage: /${PROJECT_SKILL_TRUST_COMMAND} [status|on|off|reset]`, "error");
					return;
				}
				const skills = formatSkillList(options.getSkills());
				if (subcommand === "status") {
					ctx.ui.notify(
						`Project Python skills are ${options.store.getDecision(ctx.cwd)} for ${ctx.cwd} (${skills}).`,
						"info",
					);
					return;
				}
				if (subcommand === "reset") {
					options.store.clearDecision(ctx.cwd);
					ctx.ui.notify(
						`Cleared the project Python skill decision for ${ctx.cwd}; the next session start asks again.`,
						"info",
					);
					return;
				}
				const decision = subcommand === "on" ? "trusted" : "denied";
				options.store.setDecision(ctx.cwd, decision);
				ctx.ui.notify(
					decision === "trusted"
						? `Trusted project Python skills for ${ctx.cwd} (${skills}). Reloading to install them.`
						: `Project Python skills disabled for ${ctx.cwd} (${skills}). Reloading to remove them.`,
					"info",
				);
				await ctx.waitForIdle();
				await ctx.reload();
			},
		});
	};
}
