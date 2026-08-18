import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CustomMessage,
	convertToLlm,
	createCompactionOutcomeMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
	isCompactionOutcomeMessage,
	isSessionSlashCommandMessage,
	isSessionSlashCommandResultMessage,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
} from "../src/core/messages.js";
import { parseSessionSlashCommand } from "../src/core/slash-commands.js";
import { CompactionOutcomeMessageComponent } from "../src/modes/interactive/components/compaction-outcome-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { SlashCommandMessageComponent } from "../src/modes/interactive/components/slash-command-message.js";
import { SlashCommandResultMessageComponent } from "../src/modes/interactive/components/slash-command-result-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const componentOptions = {
	ui: { requestRender: vi.fn() } as unknown as TUI,
	cwd: "/tmp",
	toolOptions: {},
	getToolDefinition: () => undefined,
};

function customMessage(customType: string, details?: unknown): CustomMessage {
	return {
		role: "custom",
		customType,
		content: "durable display text",
		display: true,
		details,
		timestamp: 123,
	};
}

describe("session command messages", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("creates and recognizes typed command and result messages", () => {
		const command = parseSessionSlashCommand("/goal\tship it");
		expect(command).toBeDefined();
		const commandMessage = createSessionSlashCommandMessage(command!, { commandEntryId: "entry-1" }, true, 123);
		const attemptedOverwrite = Reflect.apply(createSessionSlashCommandMessage, undefined, [
			command!,
			{ command: { name: "compact", args: "", text: "/compact" } },
		]);
		const resultMessage = createSessionSlashCommandResultMessage(
			"Goal unavailable",
			{
				command: command!,
				success: false,
				severity: "warning",
				error: "Goal unavailable",
				commandEntryId: "entry-1",
			},
			true,
			124,
		);

		expect(commandMessage).toEqual({
			role: "custom",
			customType: SESSION_SLASH_COMMAND_CUSTOM_TYPE,
			content: "/goal\tship it",
			display: true,
			details: {
				command: { name: "goal", args: "ship it", text: "/goal\tship it" },
				commandEntryId: "entry-1",
			},
			timestamp: 123,
		});
		expect(isSessionSlashCommandMessage(commandMessage)).toBe(true);
		expect(attemptedOverwrite.details.command).toEqual(command);
		expect(isSessionSlashCommandResultMessage(resultMessage)).toBe(true);
		expect(
			isSessionSlashCommandResultMessage({
				...resultMessage,
				details: { ...resultMessage.details, command: { ...command!, text: "/compact" } },
			}),
		).toBe(false);
		expect(
			isSessionSlashCommandResultMessage({
				...resultMessage,
				details: { ...resultMessage.details, severity: "fatal" },
			}),
		).toBe(false);
		expect(
			isSessionSlashCommandResultMessage({ ...resultMessage, details: { ...resultMessage.details, success: "no" } }),
		).toBe(false);
		expect(
			isSessionSlashCommandResultMessage({
				...resultMessage,
				details: { ...resultMessage.details, commandEntryId: "" },
			}),
		).toBe(false);
		expect(
			isSessionSlashCommandMessage({
				...commandMessage,
				details: { command: { ...commandMessage.details.command, name: "compact" } },
			}),
		).toBe(false);
		expect(
			isSessionSlashCommandMessage({
				...commandMessage,
				details: { command: { ...commandMessage.details.command, args: "other" } },
			}),
		).toBe(false);
		expect(
			isSessionSlashCommandMessage({
				...commandMessage,
				details: { command: { ...commandMessage.details.command, text: "/goal other" } },
			}),
		).toBe(false);
		expect(isSessionSlashCommandMessage({ ...commandMessage, timestamp: Number.NaN })).toBe(false);
		expect(
			isSessionSlashCommandMessage({
				...commandMessage,
				details: { ...commandMessage.details, commandEntryId: "" },
			}),
		).toBe(false);
	});

	test("creates and validates typed compaction outcome messages", () => {
		const outcome = createCompactionOutcomeMessage(
			"Requested compaction skipped: too short",
			{ reason: "requested", outcome: "skipped" },
			true,
			123,
		);

		expect(outcome).toEqual({
			role: "custom",
			customType: COMPACTION_OUTCOME_CUSTOM_TYPE,
			content: "Requested compaction skipped: too short",
			display: true,
			details: { reason: "requested", outcome: "skipped" },
			timestamp: 123,
		});
		expect(isCompactionOutcomeMessage(outcome)).toBe(true);
		expect(isCompactionOutcomeMessage({ ...outcome, details: { reason: "manual", outcome: "skipped" } })).toBe(false);
		expect(isCompactionOutcomeMessage({ ...outcome, details: { reason: "requested", outcome: "success" } })).toBe(
			false,
		);
		expect(isCompactionOutcomeMessage({ ...outcome, timestamp: Number.NaN })).toBe(false);
	});

	test("excludes durable command, result, and compaction outcome entries from LLM context", () => {
		const command = parseSessionSlashCommand("/compact");
		expect(command).toBeDefined();

		expect(
			convertToLlm([
				createSessionSlashCommandMessage(command!),
				createSessionSlashCommandResultMessage("Skipped", {
					command: command!,
					success: false,
					severity: "warning",
				}),
				customMessage(SESSION_SLASH_COMMAND_CUSTOM_TYPE),
				customMessage(SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE),
				customMessage(COMPACTION_OUTCOME_CUSTOM_TYPE),
			]),
		).toEqual([]);
	});

	test("continues to include ordinary custom messages", () => {
		expect(convertToLlm([customMessage("extension_notice")])).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "durable display text" }] },
		]);
	});

	test("dispatches valid messages and safely diagnoses malformed reserved entries", () => {
		const command = parseSessionSlashCommand("/compact focus");
		expect(command).toBeDefined();
		const components = buildConversationComponents(
			[
				createSessionSlashCommandMessage(command!),
				createSessionSlashCommandResultMessage("Compaction skipped", {
					command: command!,
					success: false,
					severity: "warning",
				}),
				createCompactionOutcomeMessage("Auto-compaction skipped", {
					reason: "threshold",
					outcome: "skipped",
				}),
				customMessage(SESSION_SLASH_COMMAND_CUSTOM_TYPE, { command: "not-a-command" }),
				customMessage(SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE, { severity: "fatal" }),
				customMessage(COMPACTION_OUTCOME_CUSTOM_TYPE, { reason: "manual", outcome: "skipped" }),
			],
			componentOptions,
		);
		const output = stripAnsi(components.flatMap((component) => component.render(80)).join("\n"));

		expect(components[0]).toBeInstanceOf(SlashCommandMessageComponent);
		expect(components[1]).toBeInstanceOf(SlashCommandResultMessageComponent);
		expect(components[2]).toBeInstanceOf(CompactionOutcomeMessageComponent);
		expect(output).toContain("Compaction skipped");
		expect(output).toContain("Auto-compaction skipped");
		expect(output.match(/\[Malformed session command message\]/g)).toHaveLength(2);
		expect(output).toContain("[Malformed compaction outcome message]");
		expect(output).not.toContain("durable display text");
	});
});
