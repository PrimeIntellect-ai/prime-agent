/**
 * Minimal Mode Example - Demonstrates a "minimal" tool display mode
 *
 * This extension overrides built-in tools to provide custom rendering:
 * - Collapsed mode: Only shows the tool call (command/path), no output
 * - Expanded mode: Shows full output like the built-in renderers
 *
 * This demonstrates how a "minimal mode" could work, where ctrl+o cycles through:
 * - Standard: Shows truncated output (current default)
 * - Expanded: Shows full output (current expanded)
 * - Minimal: Shows only tool call, no output (this extension's collapsed mode)
 *
 * Usage:
 *   pi -e ./minimal-mode.ts
 *
 * Then use ctrl+o to toggle between minimal (collapsed) and full (expanded) views.
 */

import type { ExtensionAPI } from "@prime-intellect/prime-agent";
import { createBashTool, createEditTool } from "@prime-intellect/prime-agent";
import { Text } from "@prime-intellect/prime-agent-tui";
import { homedir } from "os";

/**
 * Shorten a path by replacing home directory with ~
 */
function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

// Cache for built-in tools by cwd
const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// Bash Tool
	// =========================================================================
	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first).",
		parameters: getBuiltInTools(process.cwd()).bash.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.bash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const command = args.command || "...";
			const timeout = args.timeout as number | undefined;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

			return new Text(theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show full output
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			if (!output) {
				return new Text("", 0, 0);
			}

			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Edit Tool
	// =========================================================================
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: getBuiltInTools(process.cwd()).edit.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.edit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show diff or error
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			// For errors, show the error message
			const text = textContent.text;
			if (text.includes("Error") || text.includes("error")) {
				return new Text(`\n${theme.fg("error", text)}`, 0, 0);
			}

			// Otherwise show the text (would be nice to show actual diff here)
			return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});
}
