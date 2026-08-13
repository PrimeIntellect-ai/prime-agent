import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsSpies = vi.hoisted(() => ({
	openSync: vi.fn(),
	closeSync: vi.fn(),
	fstatSync: vi.fn(),
	statSync: vi.fn(),
	actual: undefined as typeof import("node:fs") | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsSpies.actual = actual;
	return {
		...actual,
		openSync: fsSpies.openSync,
		closeSync: fsSpies.closeSync,
		fstatSync: fsSpies.fstatSync,
		statSync: fsSpies.statSync,
	};
});

import {
	createMcpProjectTrustAuthority,
	releaseMcpProjectTrustBinding,
	withValidatedMcpProjectTrustBinding,
} from "../src/core/mcp/project-trust-authority.js";

const cleanup: string[] = [];

function directory(): string {
	const path = realpathSync.native(mkdtempSync(join(tmpdir(), "project-trust-authority-")));
	cleanup.push(path);
	return path;
}

beforeEach(() => {
	fsSpies.openSync.mockImplementation(fsSpies.actual!.openSync);
	fsSpies.closeSync.mockImplementation(fsSpies.actual!.closeSync);
	fsSpies.fstatSync.mockImplementation(fsSpies.actual!.fstatSync);
	fsSpies.statSync.mockImplementation(fsSpies.actual!.statSync);
	for (const spy of [fsSpies.openSync, fsSpies.closeSync, fsSpies.fstatSync, fsSpies.statSync]) spy.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const spy of [fsSpies.openSync, fsSpies.closeSync, fsSpies.fstatSync, fsSpies.statSync]) spy.mockReset();
	while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("MCP project trust authority descriptor ownership", () => {
	it("pins the approved directory once and never reopens its pathname during admission", () => {
		const path = directory();
		const authority = createMcpProjectTrustAuthority({ revision: "r1", allowedProjectDirectories: [path] });
		expect(fsSpies.openSync).toHaveBeenCalledOnce();
		const pinnedFd = fsSpies.openSync.mock.results[0]!.value as number;

		const authorization = authority.authorizeProjectDirectory(path);
		expect(authorization.kind).toBe("granted");
		expect(fsSpies.openSync).toHaveBeenCalledOnce();
		if (authorization.kind !== "granted") return;
		expect(withValidatedMcpProjectTrustBinding(authorization.binding, (rootFd) => rootFd)).toBe(pinnedFd);
	});

	it("keeps operations on the pinned object when pathname identity is forced to look reused", () => {
		const path = directory();
		const oldPath = `${path}-old`;
		cleanup.push(oldPath);
		const authority = createMcpProjectTrustAuthority({ revision: "r1", allowedProjectDirectories: [path] });
		const pinnedFd = fsSpies.openSync.mock.results[0]!.value as number;
		const pinned = fsSpies.actual!.fstatSync(pinnedFd, { bigint: true });
		renameSync(path, oldPath);
		mkdirSync(path);

		// Deterministically model an ABA path stat reporting the pinned numeric
		// identity. The authority still cannot reopen or expose the replacement.
		const actualStatSync = fsSpies.actual!.statSync;
		fsSpies.statSync.mockImplementation(((candidate: Parameters<typeof actualStatSync>[0], options?: unknown) => {
			if (candidate === path && options && typeof options === "object" && "bigint" in options) {
				const replacement = actualStatSync(path, { bigint: true });
				return { ...replacement, isDirectory: () => true, dev: pinned.dev, ino: pinned.ino };
			}
			return actualStatSync(candidate, options as never);
		}) as typeof actualStatSync);

		const authorization = authority.authorizeProjectDirectory(path);
		expect(authorization.kind).toBe("granted");
		expect(fsSpies.openSync).toHaveBeenCalledOnce();
		if (authorization.kind !== "granted") return;
		expect(
			withValidatedMcpProjectTrustBinding(authorization.binding, (rootFd) => {
				expect(rootFd).toBe(pinnedFd);
				const opened = fsSpies.actual!.fstatSync(rootFd, { bigint: true });
				const replacement = fsSpies.actual!.statSync(path, { bigint: true });
				expect(opened.ino).toBe(pinned.ino);
				expect(opened.ino).not.toBe(replacement.ino);
				return true;
			}),
		).toBe(true);
	});

	it("does not close a shared authority descriptor when either binding is released", () => {
		const path = directory();
		const authority = createMcpProjectTrustAuthority({ revision: "r1", allowedProjectDirectories: [path] });
		const first = authority.authorizeProjectDirectory(path);
		const second = authority.authorizeProjectDirectory(path);
		expect(first.kind).toBe("granted");
		expect(second.kind).toBe("granted");
		if (first.kind !== "granted" || second.kind !== "granted") return;
		fsSpies.closeSync.mockClear();

		releaseMcpProjectTrustBinding(first.binding);
		expect(fsSpies.closeSync).not.toHaveBeenCalled();
		expect(withValidatedMcpProjectTrustBinding(first.binding, () => true)).toBeUndefined();
		expect(withValidatedMcpProjectTrustBinding(second.binding, () => true)).toBe(true);
		releaseMcpProjectTrustBinding(second.binding);
		expect(fsSpies.closeSync).not.toHaveBeenCalled();
	});

	it("closes every partially pinned descriptor when policy construction fails", () => {
		const path = directory();
		fsSpies.closeSync.mockClear();
		const authority = createMcpProjectTrustAuthority({
			revision: "r1",
			allowedProjectDirectories: [path, path],
		});
		expect(fsSpies.openSync).toHaveBeenCalledTimes(2);
		expect(fsSpies.closeSync).toHaveBeenCalledTimes(2);
		expect(authority.authorizeProjectDirectory(path)).toEqual({ kind: "denied" });
	});
});
