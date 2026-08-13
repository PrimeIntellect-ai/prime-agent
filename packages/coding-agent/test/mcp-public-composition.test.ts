import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeMcpProjectDeclarationAdmission } from "../src/cli/public-command.js";
import { executeMcpDeclarationCommand, parseMcpDeclarationCommand } from "../src/core/mcp/mcp-declaration-command.js";
import { McpProjectDeclarationReader } from "../src/core/mcp/mcp-project-declaration-reader.js";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "../src/core/settings-manager.js";

const projectDocument = {
	version: 1,
	servers: { catalog: { name: "catalog", url: "https://catalog.test/mcp", enabled: true } },
};

class TrackingStorage implements SettingsStorage {
	readonly reads: Record<SettingsScope, number> = { global: 0, project: 0 };
	readonly writes: Record<SettingsScope, number> = { global: 0, project: 0 };
	constructor(private values: Record<SettingsScope, string | undefined>) {}
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		this.reads[scope]++;
		const next = fn(this.values[scope]);
		if (next !== undefined) {
			this.writes[scope]++;
			this.values[scope] = next;
		}
	}
	reset(): void {
		this.reads.global = this.reads.project = this.writes.global = this.writes.project = 0;
	}
}

function directory(): { path: string; dispose(): void } {
	const path = realpathSync.native(mkdtempSync(join(tmpdir(), "m01-public-")));
	return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

function storage(global: unknown, project: unknown): TrackingStorage {
	return new TrackingStorage({ global: JSON.stringify(global), project: JSON.stringify(project) });
}

function admitFromGlobalStorage(store: TrackingStorage, workingDirectory: string) {
	return composeMcpProjectDeclarationAdmission(
		command(),
		SettingsManager.loadGlobalSettingsFromStorage(store),
		workingDirectory,
	);
}

const command = () => parseMcpDeclarationCommand(["list", "--project"]);

describe("M01 public command project policy composition", () => {
	it("uses an exact global policy grant and carries only its opaque admission", async () => {
		const d = directory();
		try {
			const store = storage(
				{ mcpProjectTrustPolicy: { revision: "v1", allowedProjectDirectories: [d.path] } },
				{ mcpDeclarations: projectDocument },
			);
			const admission = admitFromGlobalStorage(store, d.path);
			expect(admission).toBeDefined();
			expect(store.reads).toEqual({ global: 1, project: 0 });
			// Only a grant permits construction of the full project-capable manager.
			const settings = SettingsManager.fromStorage(store);
			expect(store.reads).toEqual({ global: 2, project: 1 });
			await expect(executeMcpDeclarationCommand(command(), settings, admission)).resolves.toEqual(projectDocument);
		} finally {
			d.dispose();
		}
	});

	it.each([undefined, { revision: 1, allowedProjectDirectories: ["not-a-string-policy"] }])(
		"denies missing or malformed global policy and project-local self-enable before project I/O",
		async (policy) => {
			const d = directory();
			try {
				const store = storage(
					{ mcpProjectTrustPolicy: policy },
					{
						mcpProjectTrustPolicy: { revision: "evil", allowedProjectDirectories: [d.path] },
						mcpDeclarations: projectDocument,
					},
				);
				const admission = admitFromGlobalStorage(store, d.path);
				expect(admission).toBeUndefined();
				// Production stops here: a deny must not construct SettingsManager.fromStorage.
				expect(store.reads).toEqual({ global: 1, project: 0 });
				expect(store.writes.project).toBe(0);
				// The downstream boundary independently remains inert if accidentally called.
				const settings = SettingsManager.inMemory();
				await expect(executeMcpDeclarationCommand(command(), settings, admission)).rejects.toThrow(
					"Project MCP declarations are unavailable.",
				);
				await expect(
					executeMcpDeclarationCommand(
						parseMcpDeclarationCommand(["test", "catalog", "--project"]),
						settings,
						admission,
					),
				).rejects.toThrow("Project MCP declarations are unavailable.");
			} finally {
				d.dispose();
			}
		},
	);

	it("denies an alias at composition and a replaced directory at the validated use boundary", async () => {
		const d = directory();
		const old = `${d.path}-old`;
		try {
			const store = storage(
				{ mcpProjectTrustPolicy: { revision: "v1", allowedProjectDirectories: [d.path] } },
				{ mcpDeclarations: projectDocument },
			);
			expect(admitFromGlobalStorage(store, `${d.path}/.`)).toBeUndefined();
			const admission = admitFromGlobalStorage(store, d.path);
			const settings = SettingsManager.fromStorage(store);
			renameSync(d.path, old);
			mkdtempSync(d.path);
			await expect(executeMcpDeclarationCommand(command(), settings, admission)).rejects.toThrow(
				"Project MCP declarations are unavailable.",
			);
		} finally {
			rmSync(old, { recursive: true, force: true });
			d.dispose();
		}
	});

	it("authorizes once at composition and never reauthorizes during a later use", async () => {
		const d = directory();
		try {
			const store = storage(
				{ mcpProjectTrustPolicy: { revision: "v1", allowedProjectDirectories: [d.path] } },
				{ mcpDeclarations: projectDocument },
			);
			const admission = admitFromGlobalStorage(store, d.path);
			const settings = SettingsManager.fromStorage(store);
			await expect(executeMcpDeclarationCommand(command(), settings, admission)).resolves.toEqual(projectDocument);
			await expect(executeMcpDeclarationCommand(command(), settings, admission)).resolves.toEqual(projectDocument);
			// execute has only the opaque admission argument; no raw path is available to reauthorize.
		} finally {
			d.dispose();
		}
	});
	it("uses the scoped reader for admitted list and add while retaining ordinary project settings", async () => {
		const d = directory();
		try {
			const store = storage(
				{ mcpProjectTrustPolicy: { revision: "v1", allowedProjectDirectories: [d.path] } },
				{ ordinary: { retained: true }, mcpDeclarations: projectDocument },
			);
			const admission = admitFromGlobalStorage(store, d.path)!;
			const settingsPath = join(d.path, ".prime", "agent", "settings.json");
			// The file-backed reader is deliberately the project-MCP-only seam.
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(d.path, ".prime", "agent"), { recursive: true });
			writeFileSync(
				settingsPath,
				JSON.stringify({ ordinary: { retained: true }, mcpDeclarations: projectDocument }),
			);
			const reader = await McpProjectDeclarationReader.create(admission);
			const settings = reader.asCommandSettings();
			await expect(executeMcpDeclarationCommand(command(), settings as never, admission)).resolves.toEqual(
				projectDocument,
			);
			await expect(
				executeMcpDeclarationCommand(
					parseMcpDeclarationCommand(["add", "added", "https://added.test/mcp", "--project"]),
					settings as never,
					admission,
				),
			).resolves.toMatchObject({ name: "added" });
			const persisted = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(persisted.ordinary).toEqual({ retained: true });
			expect(persisted.mcpDeclarations.servers).toHaveProperty("catalog");
			expect(persisted.mcpDeclarations.servers).toHaveProperty("added");
		} finally {
			d.dispose();
		}
	});
});
