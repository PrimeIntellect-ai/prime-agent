import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildRestoreCode,
	buildSnapshotCode,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	manifestPathIn,
	parseRestoreResult,
	parseSnapshotResult,
	snapshotPathIn,
} from "../src/core/kernel/state-snapshot.js";

// Kept in sync with the marker the Python helpers print.
const MARKER = "__PRIME_AGENT_KERNEL_STATE__";

describe("kernel state snapshot paths", () => {
	it("places snapshot + manifest inside the session artifact directory", () => {
		const artifactDir = "/home/u/.prime/agent/session-artifacts/abc-123";
		expect(snapshotPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.dill"));
		expect(manifestPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.json"));
	});
});

describe("parseSnapshotResult", () => {
	it("parses a valid marker line", () => {
		const stdout = `${MARKER}${JSON.stringify({
			saved: ["x", "y"],
			skipped: [{ name: "sock", reason: "TypeError: cannot pickle" }],
			bytes: 1234,
		})}\n`;
		const result = parseSnapshotResult(stdout, "/tmp/s.dill");
		expect(result).toEqual({
			saved: ["x", "y"],
			skipped: [{ name: "sock", reason: "TypeError: cannot pickle" }],
			bytes: 1234,
			path: "/tmp/s.dill",
		});
	});

	it("ignores stdout printed before the marker line", () => {
		const stdout = `some earlier print output\n${MARKER}${JSON.stringify({ saved: ["a"], skipped: [], bytes: 7 })}`;
		expect(parseSnapshotResult(stdout, "/tmp/s.dill")?.saved).toEqual(["a"]);
	});

	it("returns null when the marker is absent", () => {
		expect(parseSnapshotResult("no marker here", "/tmp/s.dill")).toBeNull();
	});

	it("returns null when the payload reports an error", () => {
		const stdout = `${MARKER}${JSON.stringify({ error: "dill unavailable" })}`;
		expect(parseSnapshotResult(stdout, "/tmp/s.dill")).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		expect(parseSnapshotResult(`${MARKER}{not json`, "/tmp/s.dill")).toBeNull();
	});

	it("tolerates missing fields", () => {
		const result = parseSnapshotResult(`${MARKER}{}`, "/tmp/s.dill");
		expect(result).toEqual({ saved: [], skipped: [], bytes: 0, path: "/tmp/s.dill" });
	});
});

describe("parseRestoreResult", () => {
	it("parses restored and failed names", () => {
		const stdout = `${MARKER}${JSON.stringify({
			restored: ["df", "model"],
			failed: [{ name: "conn", reason: "TypeError" }],
		})}`;
		expect(parseRestoreResult(stdout, "/tmp/s.dill")).toEqual({
			restored: ["df", "model"],
			failed: [{ name: "conn", reason: "TypeError" }],
			path: "/tmp/s.dill",
		});
	});

	it("returns null when the marker is absent", () => {
		expect(parseRestoreResult("", "/tmp/s.dill")).toBeNull();
	});

	it("returns null when the payload reports an error", () => {
		expect(parseRestoreResult(`${MARKER}${JSON.stringify({ error: "load failed" })}`, "/tmp/s.dill")).toBeNull();
	});
});

describe("buildSnapshotCode", () => {
	const code = buildSnapshotCode("/state/sess.dill", "/state/sess.json", DEFAULT_SNAPSHOT_MAX_BYTES);

	it("embeds the output, manifest paths, and the byte cap", () => {
		expect(code).toContain('"/state/sess.dill"');
		expect(code).toContain('"/state/sess.json"');
		expect(code).toContain(String(DEFAULT_SNAPSHOT_MAX_BYTES));
	});

	it("uses dill with private exclusive atomic writes and skips internal handles", () => {
		expect(code).toContain("import dill");
		expect(code).toContain("os.O_EXCL");
		expect(code).toContain('hasattr(os, "O_NOFOLLOW")');
		expect(code).toContain("os.O_NOFOLLOW");
		expect(code).toContain("os.replace");
		expect(code).toContain("os.lstat(out_dir)");
		expect(code).toContain("os.fchmod");
		// rlm and the IPython display names must never be serialized.
		expect(code).toContain('"rlm"');
		expect(code).toContain(`print(${JSON.stringify(MARKER)}`);
	});
});

describe("buildRestoreCode", () => {
	const code = buildRestoreCode("/state/sess.dill");

	it("embeds the input path and rejects non-regular or symlinked snapshot files", () => {
		expect(code).toContain('"/state/sess.dill"');
		expect(code).toContain("os.path.lexists");
		expect(code).toContain("os.lstat");
		expect(code).toContain("S_ISREG");
		expect(code).toContain('hasattr(os, "O_NOFOLLOW")');
		expect(code).toContain("os.O_NOFOLLOW");
		expect(code).toContain("dill.loads");
	});
});
