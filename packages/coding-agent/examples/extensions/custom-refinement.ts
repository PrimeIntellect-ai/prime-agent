/**
 * Custom Refinement Extension
 *
 * Replaces the built-in /refine planner with a cheaper/faster model.
 * The extension receives the planning inputs (harness state, refinement
 * history, serialized conversation) and returns a RefinementProposal.
 * Returned edits are still validated by the core apply path, so a bad
 * proposal degrades to per-edit errors instead of corrupting the harness.
 *
 * Returning nothing falls back to the built-in planner; returning
 * `{ skip: true }` suppresses the refinement round entirely.
 *
 * Usage:
 *   prime-agent -e examples/extensions/custom-refinement.ts
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, RefinementProposal } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_refine", async (event, ctx) => {
		const { trigger, instructions, scope, planningState, history, conversationText } = event.preparation;

		// Use a cheaper model than the conversation model for planning.
		const model = ctx.modelRegistry.find("google", "gemini-2.5-flash");
		if (!model) {
			ctx.ui.notify("Custom refinement: model not found, using default planner", "warning");
			return;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify("Custom refinement: no auth for model, using default planner", "warning");
			return;
		}

		ctx.ui.notify(`Custom refinement (${trigger}, ${scope}) with ${model.id}...`, "info");

		// Global entries are read-only during a local refinement; label scopes so
		// the model never proposes edits against another scope's ids.
		const existingIds = Object.entries(planningState.entries)
			.flatMap(([kind, entries]) =>
				Object.entries(entries).map(([id, entry]) => `${entry.scope ?? scope}:${kind}:${id}`),
			)
			.join(", ");
		const recentRefinements = history
			.slice(-5)
			.map((item) => `- ${item.summary}`)
			.join("\n");

		const planningMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `You maintain a persistent "continual harness" of prompt notes, memories, skills, and subagent specs for a coding agent.
From the conversation, propose a SMALL set of create/update/delete edits that capture durable, reusable lessons.

Existing entries as scope:kind:id (use the bare id in edits): ${existingIds || "(none)"}
This refinement targets the ${scope} scope. Entries from any other scope are read-only: never propose update or delete edits for them.
Recent refinements:
${recentRefinements || "(none)"}
${instructions ? `Focus: ${instructions}` : ""}

Respond with ONLY a JSON object:
{"summary": "...", "rationale": "...", "expectedOutcome": "...", "edits": [{"action": "create"|"update"|"delete", "kind": "prompt"|"memory"|"skill"|"subagent", "id": "existing-id-for-update-or-delete", "title": "...", "content": "...", "reason": "..."}]}

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await complete(
				model,
				{ messages: planningMessages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 4096,
					signal: event.signal,
				},
			);

			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("");
			const start = text.indexOf("{");
			const end = text.lastIndexOf("}");
			if (start < 0 || end <= start) {
				ctx.ui.notify("Custom refinement: unparseable plan, using default planner", "warning");
				return;
			}
			const proposal = JSON.parse(text.slice(start, end + 1)) as RefinementProposal;
			return { proposal };
		} catch (error) {
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Custom refinement failed (${message}), using default planner`, "warning");
			}
			return;
		}
	});
}
