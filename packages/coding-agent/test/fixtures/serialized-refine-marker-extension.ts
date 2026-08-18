import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/index.js";

/**
 * Test fixture extension that writes a marker file when the first agent_start
 * fires. The marker includes the model id from the extension context, proving
 * the extension ran in the real daemon worker with a valid model (#503).
 *
 * Also listens for refine_complete events to detect serialized refine activity.
 */
export default function registerSerializedRefineMarker(pi: ExtensionAPI): void {
	let markerWritten = false;

	pi.on("agent_start", (_event, ctx) => {
		if (markerWritten) return;
		markerWritten = true;
		const markerPath = process.env.PRIME_AGENT_TEST_SERIALIZED_REFINE_MARKER;
		if (!markerPath) return;
		writeFileSync(
			markerPath,
			JSON.stringify({
				modelId: ctx.model?.id,
				modelProvider: ctx.model?.provider,
				hasUI: ctx.hasUI,
			}),
		);
	});

	pi.on("agent_end", () => {
		const refineMarkerPath = process.env.PRIME_AGENT_TEST_REFINE_COMPLETE_MARKER;
		if (!refineMarkerPath) return;
		// Write a marker when agent_end fires. If serializedRefine caused
		// a deadlock, this would never be written.
		writeFileSync(refineMarkerPath, "agent_end");
	});
}
