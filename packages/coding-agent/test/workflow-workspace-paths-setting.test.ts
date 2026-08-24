import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

async function managerWith(settings: Record<string, unknown>): Promise<SettingsManager> {
	const dir = await mkdtemp(join(tmpdir(), "workspace-paths-"));
	// Project settings live under the config dir inside cwd, not at the cwd root.
	const projectDir = join(dir, ".prime", "agent");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, "settings.json"), JSON.stringify(settings));
	return SettingsManager.create(dir, join(dir, "global-agent"));
}

describe("workflowWorkspacePaths setting", () => {
	it("is undefined when unset, so the built-in default stands", async () => {
		const manager = await managerWith({});
		expect(manager.getWorkflowWorkspacePaths()).toBeUndefined();
	});

	it("treats an empty list as unset rather than as 'own nothing anywhere'", async () => {
		// An empty roots list would make every declared ownedPath outside the boundary, failing every
		// graph. Absent and empty must mean the same thing here.
		const manager = await managerWith({ workflowWorkspacePaths: [] });
		expect(manager.getWorkflowWorkspacePaths()).toBeUndefined();
	});

	it("returns configured roots so a repo without src/ can own its own layout", async () => {
		const manager = await managerWith({ workflowWorkspacePaths: ["etl", "models"] });
		expect(manager.getWorkflowWorkspacePaths()).toEqual(["etl", "models"]);
	});
});
