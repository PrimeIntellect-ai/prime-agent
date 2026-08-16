import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "../src/core/trust-manager.js";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-trust-store-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions under canonical paths and resolves aliases to the same project", () => {
		const project = join(tempDir, "project");
		const alias = join(tempDir, "project-alias");
		mkdirSync(join(project, "nested"), { recursive: true });
		symlinkSync(project, alias, "dir");
		const store = new ProjectTrustStore(agentDir);

		store.set(join(alias, "nested", ".."), true);

		expect(store.get(project)).toBe(true);
		expect(store.get(alias)).toBe(true);
		expect(JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")) as unknown).toEqual({
			[realpathSync(project)]: true,
		});
	});

	it("inherits the nearest ancestor decision without leaking a sibling-only decision", () => {
		const parent = join(tempDir, "workspaces");
		const first = join(parent, "first");
		const firstChild = join(first, "packages", "app");
		const sibling = join(parent, "sibling");
		mkdirSync(firstChild, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		const store = new ProjectTrustStore(agentDir);

		store.set(first, true);
		expect(store.get(firstChild)).toBe(true);
		expect(store.get(sibling)).toBeNull();

		store.set(parent, true);
		expect(store.get(sibling)).toBe(true);

		store.set(firstChild, false);
		expect(store.get(firstChild)).toBe(false);
		store.set(firstChild, null);
		expect(store.get(firstChild)).toBe(true);
	});

	it("fails closed without replacing a corrupt trust store", () => {
		const project = join(tempDir, "project");
		const trustPath = join(agentDir, "trust.json");
		mkdirSync(project, { recursive: true });
		writeFileSync(trustPath, "{not valid json", "utf8");
		const store = new ProjectTrustStore(agentDir);

		expect(() => store.get(project)).toThrow(`Failed to read trust store ${trustPath}`);
		expect(() => store.set(project, true)).toThrow(`Failed to read trust store ${trustPath}`);
		expect(readFileSync(trustPath, "utf8")).toBe("{not valid json");
	});

	it("fails closed when the trust store path is unreadable", () => {
		const project = join(tempDir, "project");
		const trustPath = join(agentDir, "trust.json");
		mkdirSync(project, { recursive: true });
		mkdirSync(trustPath, { recursive: true });
		const store = new ProjectTrustStore(agentDir);

		expect(() => store.get(project)).toThrow(`Failed to read trust store ${trustPath}`);
	});
});
