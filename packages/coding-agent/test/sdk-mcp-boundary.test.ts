import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { admitProjectMcpDeclarations } from "../src/core/mcp/mcp-project-trust.js";
import { createMcpProjectTrustAuthority } from "../src/core/mcp/project-trust-authority.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "../src/core/settings-manager.js";
import { invokeHostRequestThroughKernelForTest } from "./host-request-context.js";

const mcpBoundarySpies = vi.hoisted(() => ({
	composeProjectReader: vi.fn(),
	createScopedReader: vi.fn(),
	readScopedDocument: vi.fn(),
	createRuntimeSnapshot: vi.fn(),
	ensureKernelPython: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("../src/core/kernel/bootstrap.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/kernel/bootstrap.js")>();
	mcpBoundarySpies.ensureKernelPython.mockImplementation(actual.ensureKernelPython);
	return { ...actual, ensureKernelPython: mcpBoundarySpies.ensureKernelPython };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	mcpBoundarySpies.spawnSync.mockImplementation(actual.spawnSync);
	return { ...actual, spawnSync: mcpBoundarySpies.spawnSync };
});

vi.mock("../src/core/mcp/mcp-project-declaration-reader.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/mcp/mcp-project-declaration-reader.js")>();
	const createScopedReader = actual.McpProjectDeclarationReader.create;
	const readScopedDocument = actual.McpProjectDeclarationReader.prototype.getDocument;
	mcpBoundarySpies.composeProjectReader.mockImplementation(actual.composeMcpProjectDeclarationReader);
	mcpBoundarySpies.createScopedReader.mockImplementation(createScopedReader);
	mcpBoundarySpies.readScopedDocument.mockImplementation(readScopedDocument);
	Object.defineProperty(actual.McpProjectDeclarationReader, "create", {
		configurable: true,
		value: mcpBoundarySpies.createScopedReader,
	});
	Object.defineProperty(actual.McpProjectDeclarationReader.prototype, "getDocument", {
		configurable: true,
		value: mcpBoundarySpies.readScopedDocument,
	});
	return { ...actual, composeMcpProjectDeclarationReader: mcpBoundarySpies.composeProjectReader };
});

vi.mock("../src/core/mcp/mcp-runtime-declaration-snapshot.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/mcp/mcp-runtime-declaration-snapshot.js")>();
	mcpBoundarySpies.createRuntimeSnapshot.mockImplementation(actual.createMcpRuntimeDeclarationSnapshot);
	return { ...actual, createMcpRuntimeDeclarationSnapshot: mcpBoundarySpies.createRuntimeSnapshot };
});

const cleanup: string[] = [];

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => undefined,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
};

function manager(session: unknown): McpManager {
	return (session as { _mcpManager: McpManager })._mcpManager;
}

function server(name: string, url: string) {
	return { [name]: { type: "http" as const, url } };
}

class MemoryStorage implements SettingsStorage {
	constructor(private readonly values: Record<SettingsScope, string | undefined>) {}
	withLock(scope: SettingsScope, callback: (current: string | undefined) => string | undefined): void {
		const next = callback(this.values[scope]);
		if (next !== undefined) this.values[scope] = next;
	}
}

async function sdk(options: NonNullable<Parameters<typeof createAgentSession>[0]>) {
	return createAgentSession({ ...options, resourceLoader, sessionManager: SessionManager.inMemory(options.cwd) });
}

beforeEach(() => {
	mcpBoundarySpies.composeProjectReader.mockClear();
	mcpBoundarySpies.createScopedReader.mockClear();
	mcpBoundarySpies.readScopedDocument.mockClear();
	mcpBoundarySpies.createRuntimeSnapshot.mockClear();
	mcpBoundarySpies.ensureKernelPython.mockClear();
	mcpBoundarySpies.spawnSync.mockClear();
});

afterEach(() => {
	while (cleanup.length > 0) {
		const path = cleanup.pop();
		if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
});

describe("SDK MCP boundary", () => {
	it("uses only global legacy integrations and publishes one frozen globally admitted declaration snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "sdk-mcp-boundary-"));
		const cwd = realpathSync.native(root);
		const agentDir = join(root, "agent");
		cleanup.push(root);
		mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mcpProjectTrustPolicy: { revision: "r1", allowedProjectDirectories: [cwd] },
				mcpServers: server("global", "https://global.example/mcp"),
				mcpDeclarations: {
					version: 1,
					servers: { user: { name: "user", url: "https://user.example/mcp", enabled: true } },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".prime", "agent", "settings.json"),
			JSON.stringify({
				mcpServers: server("project", "https://project.example/mcp"),
				mcpDeclarations: {
					version: 1,
					servers: { project: { name: "project", url: "https://project.example/mcp", enabled: true } },
				},
			}),
		);

		const { session } = await sdk({ cwd, agentDir, authStorage: AuthStorage.inMemory() });
		try {
			const mcp = manager(session);
			expect(mcp.listStatus().map((status) => status.server)).toContain("global");
			expect(mcp.listStatus().map((status) => status.server)).not.toContain("project");
			const handlers = mcp.hostHandlers();
			expect(
				await invokeHostRequestThroughKernelForTest(handlers["mcp.config"] as never, { server: "global" }),
			).toEqual({
				url: "https://global.example/mcp",
			});
			expect(
				await invokeHostRequestThroughKernelForTest(handlers["mcp.config"] as never, { server: "project" }),
			).toEqual({});
			expect(handlers).not.toHaveProperty("mcp.declarations");
			const snapshot = mcp.getDeclarationSnapshot()!;
			expect(snapshot.declarations).toHaveProperty("user");
			expect(snapshot.declarations).toHaveProperty("project");
			expect(Object.isFrozen(snapshot)).toBe(true);
			expect(Object.isFrozen(snapshot.declarations)).toBe(true);
			expect(Object.isFrozen(snapshot.declarations.project)).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("creates an SDK session for an admitted fresh project without .prime storage", async () => {
		const root = mkdtempSync(join(tmpdir(), "sdk-mcp-fresh-project-"));
		const cwd = realpathSync.native(root);
		const agentDir = join(root, "agent");
		cleanup.push(root);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mcpProjectTrustPolicy: { revision: "r1", allowedProjectDirectories: [cwd] },
				mcpDeclarations: {
					version: 1,
					servers: { user: { name: "user", url: "https://user.example/mcp", enabled: true } },
				},
			}),
		);

		const { session } = await sdk({ cwd, agentDir, authStorage: AuthStorage.inMemory() });
		try {
			const declarations = manager(session).getDeclarationSnapshot()!.declarations;
			expect(declarations).toHaveProperty("user");
			expect(declarations).not.toHaveProperty("project");
			expect(existsSync(join(cwd, ".prime"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("makes missing, forged, and root-swapped admissions user-only for injected settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "sdk-mcp-inert-"));
		const cwd = realpathSync.native(root);
		const replacement = `${cwd}-replacement`;
		const old = `${cwd}-old`;
		cleanup.push(old, replacement, root);
		mkdirSync(replacement);
		const authority = createMcpProjectTrustAuthority({ revision: "r1", allowedProjectDirectories: [cwd] });
		const admission = admitProjectMcpDeclarations(cwd, authority)!;
		const settingsManager = SettingsManager.fromStorage(
			new MemoryStorage({
				global: JSON.stringify({
					mcpServers: server("global", "https://global.example/mcp"),
					mcpDeclarations: {
						version: 1,
						servers: { user: { name: "user", url: "https://user.example/mcp", enabled: true } },
					},
				}),
				project: JSON.stringify({
					mcpServers: server("project", "https://project.example/mcp"),
					mcpDeclarations: {
						version: 1,
						servers: { project: { name: "project", url: "https://project.example/mcp", enabled: true } },
					},
				}),
			}),
		);
		for (const projectMcpAdmission of [undefined, {} as never]) {
			const { session } = await sdk({
				cwd,
				agentDir: cwd,
				settingsManager,
				authStorage: AuthStorage.inMemory(),
				projectMcpAdmission,
			});
			try {
				const mcp = manager(session);
				expect(mcp.getDeclarationSnapshot()!.declarations).toHaveProperty("user");
				expect(mcp.getDeclarationSnapshot()!.declarations).not.toHaveProperty("project");
				expect(mcp.listStatus().map((status) => status.server)).not.toContain("project");
			} finally {
				session.dispose();
			}
		}
		renameSync(cwd, old);
		renameSync(replacement, cwd);
		const { session } = await sdk({
			cwd,
			agentDir: cwd,
			settingsManager,
			authStorage: AuthStorage.inMemory(),
			projectMcpAdmission: admission,
		});
		try {
			expect(manager(session).getDeclarationSnapshot()!.declarations).toEqual(
				expect.objectContaining({ user: expect.any(Object) }),
			);
			expect(manager(session).getDeclarationSnapshot()!.declarations).not.toHaveProperty("project");
		} finally {
			session.dispose();
		}
	});

	it("leaves every explicitly supplied MCP manager untouched across the project-admission matrix", async () => {
		const physicalRoot = mkdtempSync(join(tmpdir(), "sdk-mcp-explicit-C04-target-"));
		const root = `${physicalRoot}-C04-root`;
		const agentDir = join(root, "agent");
		const replacement = `${physicalRoot}-replacement`;
		const old = `${physicalRoot}-old`;
		cleanup.push(root, old, replacement, physicalRoot);
		// C04 deliberately has one symlink: the root spelling. The SDK receives the
		// physical spelling below, so this test never accidentally treats an alias as
		// a valid admission.
		symlinkSync(physicalRoot, root, "dir");
		mkdirSync(agentDir, { recursive: true });
		const authority = createMcpProjectTrustAuthority({
			revision: "r1",
			allowedProjectDirectories: [physicalRoot],
		});
		const validAdmission = admitProjectMcpDeclarations(physicalRoot, authority)!;

		const cases: Array<{ name: string; admission: unknown; replaceRoot?: boolean }> = [
			{ name: "no admission", admission: undefined },
			{ name: "a genuine valid admission", admission: validAdmission },
			{ name: "a forged admission", admission: Object.freeze(Object.create(null)) },
			{ name: "a stale admission after root identity replacement", admission: validAdmission, replaceRoot: true },
		];

		for (const testCase of cases) {
			const storageCalls: SettingsScope[] = [];
			const settingsManager = SettingsManager.fromStorage({
				withLock(scope, callback) {
					storageCalls.push(scope);
					const current =
						scope === "global"
							? JSON.stringify({ mcpServers: server("ordinary-global", "https://global.example/mcp") })
							: JSON.stringify({
									mcpDeclarations: {
										version: 1,
										servers: {
											project: { name: "project", url: "https://project.example/mcp", enabled: true },
										},
									},
								});
					return callback(current);
				},
			});
			// This is intentionally an ordinary SettingsManager project-scope load.
			// The boundary below is only about *scoped project-MCP* composition/read/snapshot.
			expect(storageCalls).toContain("project");
			if (testCase.replaceRoot) {
				mkdirSync(replacement);
				renameSync(physicalRoot, old);
				renameSync(replacement, physicalRoot);
			}

			const supplied = new McpManager({
				authStorage: AuthStorage.inMemory(),
				getUserServers: () => server("caller", "https://caller.example/mcp"),
			});
			const { session } = await sdk({
				cwd: root,
				agentDir,
				authStorage: AuthStorage.inMemory(),
				settingsManager,
				projectMcpAdmission: testCase.admission as never,
				mcpManager: supplied,
			});
			try {
				expect(manager(session), testCase.name).toBe(supplied);
				expect(
					supplied.listStatus().map((status) => status.server),
					testCase.name,
				).toContain("caller");
				expect(
					await invokeHostRequestThroughKernelForTest(supplied.hostHandlers()["mcp.config"] as never, {
						server: "caller",
					}),
					testCase.name,
				).toEqual({
					url: "https://caller.example/mcp",
				});
				expect(supplied.getDeclarationSnapshot(), testCase.name).toBeUndefined();
				// Explicit-manager authority means zero scoped project-MCP composition,
				// reader construction/read, and runtime declaration snapshot work.
				expect(mcpBoundarySpies.composeProjectReader, testCase.name).not.toHaveBeenCalled();
				expect(mcpBoundarySpies.createScopedReader, testCase.name).not.toHaveBeenCalled();
				expect(mcpBoundarySpies.readScopedDocument, testCase.name).not.toHaveBeenCalled();
				expect(mcpBoundarySpies.createRuntimeSnapshot, testCase.name).not.toHaveBeenCalled();
				expect(mcpBoundarySpies.ensureKernelPython, testCase.name).not.toHaveBeenCalled();
				expect(mcpBoundarySpies.spawnSync, testCase.name).not.toHaveBeenCalled();
			} finally {
				session.dispose();
			}
			mcpBoundarySpies.composeProjectReader.mockClear();
			mcpBoundarySpies.createScopedReader.mockClear();
			mcpBoundarySpies.readScopedDocument.mockClear();
			mcpBoundarySpies.createRuntimeSnapshot.mockClear();
			mcpBoundarySpies.ensureKernelPython.mockClear();
			mcpBoundarySpies.spawnSync.mockClear();
		}
	});
});
