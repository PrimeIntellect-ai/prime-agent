import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { expandTildePath } from "../src/config.js";
import { resolveUserPath } from "../src/utils/paths.js";

const cwd = join(tmpdir(), "pi-paths-cwd");

describe("resolveUserPath", () => {
	it("keeps a tilde without a separator literal instead of expanding it", () => {
		const result = resolveUserPath("~Documents/file.txt", cwd);
		expect(result).toBe(join(cwd, "~Documents", "file.txt"));
	});

	it("expands a leading tilde that is followed by a separator", () => {
		expect(resolveUserPath("~/Documents/file.txt", cwd)).toBe(join(homedir(), "Documents", "file.txt"));
	});

	it("expands the Windows backslash tilde spelling on Windows only", () => {
		expect(expandTildePath("~\\Documents\\file.txt", "win32")).toBe(win32.join(homedir(), "Documents", "file.txt"));
		expect(expandTildePath("~\\Documents\\file.txt", "linux")).toBe("~\\Documents\\file.txt");
	});

	it("passes an absolute path through unchanged", () => {
		const absolute = join(cwd, "resources", "ext.ts");
		expect(resolveUserPath(absolute, cwd)).toBe(absolute);
		expect(resolveUserPath(absolute, join(cwd, "other"))).toBe(absolute);
	});

	it("trims surrounding whitespace and normalizes Unicode spaces", () => {
		expect(resolveUserPath("  resources/ext.ts\n", cwd)).toBe(join(cwd, "resources", "ext.ts"));
		expect(resolveUserPath("\u00A0skills\u3000dir\u00A0", cwd)).toBe(join(cwd, "skills dir"));
		for (const space of ["\u00A0", "\u2000", "\u200A", "\u202F", "\u205F", "\u3000"]) {
			expect(resolveUserPath(`my${space}folder`, cwd)).toBe(join(cwd, "my folder"));
		}
	});
});
