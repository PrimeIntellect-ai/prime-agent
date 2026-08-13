import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	admitProjectMcpDeclarations,
	resolveProjectMcpDeclarations,
	validateProjectMcpDeclarationAdmission,
} from "../src/core/mcp/mcp-project-trust.js";
import { createMcpRuntimeDeclarationSnapshot } from "../src/core/mcp/mcp-runtime-declaration-snapshot.js";
import { createMcpProjectTrustAuthority } from "../src/core/mcp/project-trust-authority.js";

const userDocument = {
	version: 1 as const,
	servers: { catalog: { name: "catalog", url: "HTTPS://Catalog.test:443/mcp", enabled: true } },
};
const projectDocument = {
	version: 1 as const,
	servers: { search: { name: "search", url: "https://search.test/mcp", enabled: false } },
};

function directory(): { path: string; dispose(): void } {
	const path = realpathSync.native(mkdtempSync(join(tmpdir(), "core-mcp-snapshot-")));
	return { path, dispose: () => rmSync(path, { recursive: true, force: true }) };
}

function admission(path: string) {
	return admitProjectMcpDeclarations(
		path,
		createMcpProjectTrustAuthority({ revision: "global-r1", allowedProjectDirectories: [path] }),
	);
}

describe("Core MCP declaration snapshot", () => {
	it("creates a frozen declaration-only, code-point-ordered snapshot", () => {
		const first = createMcpRuntimeDeclarationSnapshot({ userDocument });
		const second = createMcpRuntimeDeclarationSnapshot({ userDocument: structuredClone(userDocument) });
		expect(first).toEqual(second);
		expect(first).toEqual({
			revision: expect.stringMatching(/^[a-f0-9]{64}$/),
			declarations: {
				catalog: { name: "catalog", endpoint: "https://catalog.test/mcp", enabled: true, source: "user" },
			},
		});
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.declarations)).toBe(true);
		expect(Object.isFrozen(first.declarations.catalog)).toBe(true);
		expect(Object.getPrototypeOf(first.declarations)).toBeNull();
	});

	it("does not read project data for omitted, forged, accessor, or copied foreign admissions", () => {
		const first = directory();
		const second = directory();
		try {
			const genuine = admission(first.path)!;
			const foreign = { ...admission(second.path)! };
			let reads = 0;
			let fakeValidationCalls = 0;
			const forged = {
				get authority() {
					fakeValidationCalls++;
					return { validateBinding: () => ({ kind: "granted" }) };
				},
				get binding() {
					fakeValidationCalls++;
					return {};
				},
			};
			for (const projectAdmission of [undefined, {}, forged, foreign]) {
				const snapshot = createMcpRuntimeDeclarationSnapshot({
					userDocument,
					projectAdmission: projectAdmission as never,
					readProjectDocument: () => {
						reads++;
						return projectDocument;
					},
				});
				expect(snapshot.declarations).toEqual({
					catalog: { name: "catalog", endpoint: "https://catalog.test/mcp", enabled: true, source: "user" },
				});
			}
			expect(reads).toBe(0);
			expect(resolveProjectMcpDeclarations(projectDocument, forged as never)).toEqual({
				document: { version: 1, servers: {} },
				effective: false,
			});
			expect(fakeValidationCalls).toBe(0);
			expect(Object.getOwnPropertyNames(genuine)).toEqual([]);
			expect(validateProjectMcpDeclarationAdmission(genuine)).toEqual({ kind: "granted" });
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	it("reads project data only after the opaque admission validates and makes collisions inert", () => {
		const project = directory();
		try {
			const granted = admission(project.path)!;
			let reads = 0;
			const selected = createMcpRuntimeDeclarationSnapshot({
				userDocument,
				projectAdmission: granted,
				readProjectDocument: () => {
					reads++;
					return projectDocument;
				},
			});
			expect(reads).toBe(1);
			expect(selected.declarations.search).toEqual({
				name: "search",
				endpoint: "https://search.test/mcp",
				enabled: false,
				source: "project",
			});

			const colliding = createMcpRuntimeDeclarationSnapshot({
				userDocument,
				projectAdmission: granted,
				readProjectDocument: () => ({
					version: 1,
					servers: { catalog: { name: "catalog", url: "https://other.test/mcp", enabled: true } },
				}),
			});
			expect(Object.keys(colliding.declarations)).toEqual(["catalog"]);
		} finally {
			project.dispose();
		}
	});

	it("uses code-point order rather than locale collation", () => {
		const original = Object.getOwnPropertyDescriptor(String.prototype, "localeCompare")!;
		let localeCalls = 0;
		Object.defineProperty(String.prototype, "localeCompare", {
			...original,
			value() {
				localeCalls++;
				return 0;
			},
		});
		try {
			const snapshot = createMcpRuntimeDeclarationSnapshot({
				userDocument: {
					version: 1,
					servers: {
						zebra: { name: "zebra", url: "https://z.test", enabled: true },
						apple: { name: "apple", url: "https://a.test", enabled: true },
					},
				},
			});
			expect(Object.keys(snapshot.declarations)).toEqual(["apple", "zebra"]);
			expect(localeCalls).toBe(0);
		} finally {
			Object.defineProperty(String.prototype, "localeCompare", original);
		}
	});

	it("rejects accessor, inherited, and locale-sensitive parser inputs without reading inherited data", () => {
		const inherited = Object.create({ version: 1, servers: {} });
		const accessor = { version: 1, servers: {} as Record<string, unknown> };
		Object.defineProperty(accessor.servers, "catalog", {
			enumerable: true,
			get() {
				throw new Error("must not get accessor");
			},
		});
		expect(() => createMcpRuntimeDeclarationSnapshot({ userDocument: inherited })).toThrow();
		expect(() => createMcpRuntimeDeclarationSnapshot({ userDocument: accessor })).toThrow();
		// Names are ASCII-only. Locale collation is never consulted by selection.
		expect(() =>
			createMcpRuntimeDeclarationSnapshot({
				userDocument: { version: 1, servers: { İ: { name: "İ", url: "https://x.test", enabled: true } } },
			}),
		).toThrow();
	});
});
