import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentState } from "@earendil-works/pi-agent-core";
import { exportSessionToHtml, type ToolHtmlRenderer } from "../../core/export-html/index.js";
import { createToolHtmlRenderer } from "../../core/export-html/tool-renderer.js";
import type { ToolDefinition } from "../../core/extensions/index.js";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "../../core/session-manager.js";
import { theme } from "../../modes/interactive/theme/theme.js";
export interface SessionExportHost {
	sessionManager: SessionManager;
	getState(): AgentState;
	getTheme(): string | undefined;
	getToolDefinition(name: string): ToolDefinition | undefined;
}
export class SessionExport {
	constructor(private readonly host: SessionExportHost) {}
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.host.getTheme();

		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.host.getToolDefinition(name),
			theme,
			cwd: this.host.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.host.sessionManager, this.host.getState(), {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	exportToJsonl(outputPath?: string): string {
		const filePath = resolve(outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.host.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.host.sessionManager.getCwd(),
		};

		const branchEntries = this.host.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}
}
