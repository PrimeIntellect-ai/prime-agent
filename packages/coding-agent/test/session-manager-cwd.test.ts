import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";

function seed() {
	const root = mkdtempSync(join(tmpdir(), "sm-cwd-"));
	const header = join(root, "header");
	const child = join(root, "child");
	mkdirSync(header);
	mkdirSync(child);
	const sm = SessionManager.create(header, join(root, "sessions"));
	const msgId = sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
	sm.recordCwd(child);
	return { root, header, child, msgId, file: sm.getSessionFile()! };
}

describe("SessionManager cwd resolution", () => {
	it("resolves the newest existing /cwd entry on the branch and keeps the cwd when the header dir is gone", () => {
		const { root, header, child, msgId, file } = seed();
		rmSync(header, { recursive: true });
		const sm = SessionManager.open(file);
		expect(sm.getCwd()).toBe(child);
		sm.branch(msgId);
		expect(sm.getCwd()).toBe(child);
		rmSync(root, { recursive: true, force: true });
	});

	it("pins an explicit cwd override for the whole run", () => {
		const { root, child, msgId, file } = seed();
		const sm = SessionManager.open(file, undefined, root);
		expect(sm.hasCwdOverride).toBe(true);
		expect(sm.getCwd()).toBe(root);
		sm.branch(msgId);
		expect(sm.getCwd()).toBe(root);
		sm.recordCwd(child);
		expect(sm.getCwd()).toBe(child);
		rmSync(root, { recursive: true, force: true });
	});
});
