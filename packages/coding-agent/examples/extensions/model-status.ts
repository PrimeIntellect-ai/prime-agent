/**
 * Model status extension - shows model changes in the status bar.
 *
 * Demonstrates the `model_select` hook which fires when the model changes
 * via /model command, Ctrl+P cycling, or session restore.
 *
 * Usage: pi -e ./model-status.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("model_select", async (event, ctx) => {
		const { model, previousModel, source } = event;

		const next = `${model.provider}/${model.id}`;
		const prev = previousModel ? `${previousModel.provider}/${previousModel.id}` : "none";

		if (source !== "restore") {
			ctx.ui.notify(`Model: ${next}`, "info");
		}

		ctx.ui.setStatus("model", `🤖 ${model.id}`);

		console.log(`[model_select] ${prev} → ${next} (${source})`);
	});
}
