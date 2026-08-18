/**
 * Auto-Commit on Exit Extension
 *
 * Automatically commits changes when the agent exits.
 * Uses the last assistant message to generate a commit message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);

		if (code !== 0 || status.trim().length === 0) {
			return;
		}

		const entries = ctx.sessionManager.getEntries();
		let lastAssistantText = "";
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = entry.message.content;
				if (Array.isArray(content)) {
					lastAssistantText = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				}
				break;
			}
		}

		const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
		const commitMessage = `[pi] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

		await pi.exec("git", ["add", "-A"]);
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);

		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
		}
	});
}
