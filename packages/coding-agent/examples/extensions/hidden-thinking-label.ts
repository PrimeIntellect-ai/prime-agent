/**
 * Hidden Thinking Label Extension
 *
 * Legacy example for the deprecated `ctx.ui.setHiddenThinkingLabel()` hook.
 * The hook has no effect: thinking is now displayed without a heading.
 *
 * Usage:
 *   pi --extension examples/extensions/hidden-thinking-label.ts
 *
 * Test:
 *   1. Load this extension
 *   2. Press Ctrl+O once to show thinking and file diffs
 *   3. Ask for something that produces reasoning output
 *   4. Thinking remains unlabeled; this extension does not change its rendering
 *
 * Commands:
 *   /thinking-label <text>   Exercise the deprecated hook (no visible effect)
 *   /thinking-label          Exercise the deprecated reset (no visible effect)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_LABEL = "Pondering...";

export default function (pi: ExtensionAPI) {
	let label = DEFAULT_LABEL;

	const applyLabel = (ctx: ExtensionContext) => {
		ctx.ui.setHiddenThinkingLabel(label);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyLabel(ctx);
	});

	pi.registerCommand("thinking-label", {
		description: "Legacy thinking-label hook (no visible effect).",
		handler: async (args, ctx) => {
			const nextLabel = args.trim();

			if (!nextLabel) {
				label = DEFAULT_LABEL;
				ctx.ui.setHiddenThinkingLabel();
				ctx.ui.notify("Thinking labels are no longer displayed; resetting the legacy label has no effect.");
				return;
			}

			label = nextLabel;
			ctx.ui.setHiddenThinkingLabel(label);
			ctx.ui.notify("Thinking labels are no longer displayed; setting the legacy label has no effect.");
		},
	});
}
