import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpProjectTrustAuthority, type McpProjectTrustAuthority } from "../src/core/index.js";
import { executeMcpDeclarationCommand, parseMcpDeclarationCommand } from "../src/core/mcp/mcp-declaration-command.js";
import {
	addMcpDeclaration,
	emptyMcpDeclarationDocument,
	parseMcpDeclarationDocument,
} from "../src/core/mcp/mcp-declarations.js";
import {
	admitProjectMcpDeclarations,
	releaseProjectMcpDeclarationAdmission,
	resolveProjectMcpDeclarations,
} from "../src/core/mcp/mcp-project-trust.js";
import { redactMcpValue } from "../src/core/mcp/mcp-redaction.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const projectDocument = {
	version: 1 as const,
	servers: { catalog: { name: "catalog", url: "https://catalog.test/mcp", enabled: true } },
};

function fixture(): { directory: string; authority: McpProjectTrustAuthority; dispose(): void } {
	const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "m01-project-")));
	return {
		directory,
		authority: createMcpProjectTrustAuthority({ revision: "test-policy", allowedProjectDirectories: [directory] }),
		dispose: () => rmSync(directory, { recursive: true, force: true }),
	};
}

describe("M01 declarative MCP contract", () => {
	it("accepts only canonical credential-free declarations", () => {
		const document = addMcpDeclaration(emptyMcpDeclarationDocument(), "public-docs", "HTTPS://Example.test:443/mcp");
		expect(document).toEqual({
			version: 1,
			servers: { "public-docs": { name: "public-docs", url: "https://example.test/mcp", enabled: true } },
		});
		for (const url of [
			"https://user:secret@example.test/mcp",
			"https://example.test/mcp?token=secret",
			"https://example.test/mcp#token",
			"file:///tmp/mcp",
		]) {
			expect(() => addMcpDeclaration(emptyMcpDeclarationDocument(), "safe", url)).toThrow();
		}
		expect(() =>
			parseMcpDeclarationDocument({
				version: 1,
				servers: { x: { name: "x", url: "https://x.test", enabled: true, headers: {} } },
			}),
		).toThrow();
	});

	it("rejects inherited, accessor, and symbol-bearing declaration data without reading it", () => {
		const inherited = Object.create({ version: 1, servers: {} });
		const accessor = { version: 1, servers: {} as Record<string, unknown> };
		Object.defineProperty(accessor, "servers", {
			enumerable: true,
			get() {
				throw new Error("must not read accessor");
			},
		});
		const symbolBearing = { version: 1, servers: {} };
		Object.defineProperty(symbolBearing, Symbol("hidden"), { value: true, enumerable: false });
		expect(() => parseMcpDeclarationDocument(inherited)).toThrow();
		expect(() => parseMcpDeclarationDocument(accessor)).toThrow();
		expect(() => parseMcpDeclarationDocument(symbolBearing)).toThrow();
	});

	it("parses non-starting command routing without touching settings or a runtime", () => {
		expect(parseMcpDeclarationCommand(["add", "catalog", "https://catalog.test/mcp"])).toEqual({
			kind: "add",
			scope: "user",
			name: "catalog",
			url: "https://catalog.test/mcp",
		});
		expect(parseMcpDeclarationCommand(["preview", "catalog", "--project"])).toEqual({
			kind: "preview",
			scope: "project",
			name: "catalog",
		});
	});

	it("keeps user scope unchanged and returns a declaration-only test preview", async () => {
		const settings = SettingsManager.inMemory({ mcpDeclarations: projectDocument });
		const command = parseMcpDeclarationCommand(["test", "catalog"]);
		await expect(executeMcpDeclarationCommand(command, settings)).resolves.toEqual({
			url: "https://catalog.test/mcp",
			method: "POST",
			redirect: "error",
			requestKind: "mcp-initialize",
		});
	});

	it("rejects absent Object prototype declaration names", async () => {
		const settings = SettingsManager.inMemory({ mcpDeclarations: emptyMcpDeclarationDocument() });
		for (const kind of ["inspect", "preview", "test", "enable", "disable"] as const) {
			const command = parseMcpDeclarationCommand([kind, "constructor"]);
			await expect(executeMcpDeclarationCommand(command, settings)).rejects.toThrow(
				"No MCP declaration has that name.",
			);
		}
	});

	it("rejects a structurally forged authority before authorization or project reads", () => {
		let calls = 0;
		const fake = {
			authorizeProjectDirectory() {
				calls++;
				return { kind: "granted", binding: {} };
			},
			validateBinding() {
				calls++;
				return { kind: "granted" };
			},
		};
		const admission = admitProjectMcpDeclarations("/not-a-project", fake as never);
		expect(admission).toBeUndefined();
		expect(calls).toBe(0);
	});

	it("makes exactly one raw-path authorization at admission and validates an opaque Core binding for project reads", () => {
		const f = fixture();
		try {
			// The actual Core authority returns a single opaque binding at admission.
			// Subsequent uses only receive that binding; they have no raw path to reauthorize.
			const admission = admitProjectMcpDeclarations(f.directory, f.authority);
			expect(admission).toBeDefined();
			expect(resolveProjectMcpDeclarations(projectDocument, admission)).toEqual({
				document: projectDocument,
				effective: true,
			});
			expect(resolveProjectMcpDeclarations(projectDocument, admission)).toEqual({
				document: projectDocument,
				effective: true,
			});
		} finally {
			f.dispose();
		}
	});

	it("denies missing, forged, stale, and foreign bindings before project reads, writes, or probe opens", async () => {
		const f = fixture();
		const other = fixture();
		try {
			const settings = SettingsManager.inMemory();
			const list = parseMcpDeclarationCommand(["list", "--project"]);
			const add = parseMcpDeclarationCommand(["add", "new", "https://new.test/mcp", "--project"]);
			const test = parseMcpDeclarationCommand(["test", "new", "--project"]);
			const granted = admitProjectMcpDeclarations(f.directory, f.authority)!;
			const foreign = { ...admitProjectMcpDeclarations(other.directory, other.authority)! };
			let forgedAuthorityCalls = 0;
			const forged = {
				get authority() {
					forgedAuthorityCalls++;
					return { validateBinding: () => ({ kind: "granted" }) };
				},
				get binding() {
					forgedAuthorityCalls++;
					return {};
				},
			};
			// Admissions are identity capabilities, so copied, forged, and foreign
			// envelopes all fail before any caller-supplied member is read.
			for (const admission of [undefined, { ...granted }, forged, foreign]) {
				await expect(executeMcpDeclarationCommand(list, settings, admission)).rejects.toThrow(
					"Project MCP declarations are unavailable.",
				);
				await expect(executeMcpDeclarationCommand(add, settings, admission)).rejects.toThrow(
					"Project MCP declarations are unavailable.",
				);
				await expect(executeMcpDeclarationCommand(test, settings, admission)).rejects.toThrow(
					"Project MCP declarations are unavailable.",
				);
			}
			expect(forgedAuthorityCalls).toBe(0);
			// A binding becomes stale once its bound directory no longer exists.
			rmSync(f.directory, { recursive: true, force: true });
			await expect(executeMcpDeclarationCommand(list, settings, granted)).rejects.toThrow(
				"Project MCP declarations are unavailable.",
			);
		} finally {
			f.dispose();
			other.dispose();
		}
	});

	it("keeps the authority-pinned directory alive across independent binding releases", () => {
		const f = fixture();
		try {
			const first = admitProjectMcpDeclarations(f.directory, f.authority)!;
			const second = admitProjectMcpDeclarations(f.directory, f.authority)!;
			releaseProjectMcpDeclarationAdmission(first);
			expect(resolveProjectMcpDeclarations(projectDocument, first)).toEqual({
				document: { version: 1, servers: {} },
				effective: false,
			});
			expect(resolveProjectMcpDeclarations(projectDocument, second)).toEqual({
				document: projectDocument,
				effective: true,
			});
			releaseProjectMcpDeclarationAdmission(second);
		} finally {
			f.dispose();
		}
	});

	it("returns a project test preview only after a validated Core grant", async () => {
		const f = fixture();
		try {
			const admission = admitProjectMcpDeclarations(f.directory, f.authority)!;
			const settings = SettingsManager.inMemory();
			await executeMcpDeclarationCommand(
				parseMcpDeclarationCommand(["add", "catalog", "https://catalog.test/mcp", "--project"]),
				settings,
				admission,
			);
			await expect(
				executeMcpDeclarationCommand(
					parseMcpDeclarationCommand(["test", "catalog", "--project"]),
					settings,
					admission,
				),
			).resolves.toEqual({
				url: "https://catalog.test/mcp",
				method: "POST",
				redirect: "error",
				requestKind: "mcp-initialize",
			});
		} finally {
			f.dispose();
		}
	});

	it("redacts credential-shaped fields and unsafe URLs before public rendering", () => {
		const redacted = redactMcpValue({
			authorization: "Bearer secret",
			headers: { "X-Api-Key": "secret" },
			nested: { token: "secret" },
			url: "https://u:secret@example.test/mcp",
		});
		expect(redacted).toEqual({
			authorization: "<redacted>",
			headers: "<redacted>",
			nested: { token: "<redacted>" },
			url: "<redacted-url>",
		});
		expect(JSON.stringify(redacted)).not.toContain("secret");
	});
	it("fails closed when a queued project write loses its approved root", async () => {
		const f = fixture();
		const replacement = `${f.directory}-replacement`;
		const old = `${f.directory}-old`;
		const agentDir = mkdtempSync(join(tmpdir(), "m01-agent-"));
		try {
			const admission = admitProjectMcpDeclarations(f.directory, f.authority)!;
			const settings = SettingsManager.create(f.directory, agentDir);
			await executeMcpDeclarationCommand(
				parseMcpDeclarationCommand(["add", "queued", "https://queued.test/mcp", "--project"]),
				settings,
				admission,
			);
			renameSync(f.directory, old);
			mkdirSync(replacement);
			renameSync(replacement, f.directory);
			await settings.flush();
			expect(existsSync(join(f.directory, ".prime", "agent", "settings.json"))).toBe(false);
		} finally {
			rmSync(old, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			f.dispose();
		}
	});
});
