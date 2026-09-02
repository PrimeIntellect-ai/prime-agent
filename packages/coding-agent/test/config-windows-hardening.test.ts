import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandTildePath } from "../src/config.js";

describe.skipIf(process.platform !== "win32")("Windows config paths", () => {
	it("expands both native tilde separator forms", () => {
		expect(expandTildePath("~\\prime-agent-sessions")).toBe(join(homedir(), "prime-agent-sessions"));
		expect(expandTildePath("~/prime-agent-sessions")).toBe(join(homedir(), "prime-agent-sessions"));
	});
});
