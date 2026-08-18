import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "../../src/index.js";

/**
 * ENG-4685 event-order recording extension.
 *
 * Runs inside the real daemon worker and records the order in which
 * `refine_complete` and `agent_end` fire, proving the serialized
 * checkpoint applies before the agent loop terminates.
 *
 * Each event is appended to a JSONL file (one JSON object per line).
 * The test reads the file after the CLI exits and checks the sequence.
 */
export default function registerEng4685EventOrder(pi: ExtensionAPI): void {
	const eventLogPath = process.env.PRIME_AGENT_TEST_EVENT_LOG;
	if (!eventLogPath) return;

	let seq = 0;
	// Write an empty array so the test can detect the file exists even
	// if no events fired (e.g. interactive mode without refine).
	writeFileSync(eventLogPath, "");

	pi.on("agent_start", (_event, ctx) => {
		appendFileSync(
			eventLogPath,
			`${JSON.stringify({
				seq: seq++,
				type: "agent_start",
				modelId: ctx.model?.id,
				modelProvider: ctx.model?.provider,
				hasUI: ctx.hasUI,
				ts: Date.now(),
			})}\n`,
		);
	});

	pi.on("refine_complete", (event) => {
		appendFileSync(
			eventLogPath,
			`${JSON.stringify({
				seq: seq++,
				type: "refine_complete",
				id: event.id,
				summary: event.summary,
				appliedEdits: event.appliedEdits,
				scope: event.scope,
				ts: Date.now(),
			})}\n`,
		);
	});

	pi.on("agent_end", () => {
		appendFileSync(
			eventLogPath,
			`${JSON.stringify({
				seq: seq++,
				type: "agent_end",
				ts: Date.now(),
			})}\n`,
		);
	});
}
