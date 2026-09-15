import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalSessionPath } from "../../../src/core/session-lease.js";
import * as sessionManagerModule from "../../../src/core/session-manager.js";
import { RlmSpawnLedger } from "../../../src/modes/daemon/rlm-ledger.js";
import { createHarness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

describe("cold chat opens during a saved-session scan", () => {
	it("keeps roster reads and appends moving while preserving the scan's captured topology", async () => {
		const harness = await createHarness({ persistSession: true });
		const parent = harness.sessionManager;
		parent.appendSessionInfo("parent");
		parent.flushNow();
		const parentFile = canonicalSessionPath(parent.getSessionFile()!);
		const child = sessionManagerModule.SessionManager.create(harness.tempDir, join(harness.tempDir, "children"));
		child.appendSessionInfo("child");
		child.flushNow();
		const childFile = canonicalSessionPath(child.getSessionFile()!);
		const ledger = new RlmSpawnLedger(harness.tempDir, join(harness.tempDir, "sessions"));
		const edge = { childId: "child", parent: parentFile, child: childFile, depth: 1, name: "before" };
		await ledger.appendSpawn(edge);
		const readSessionInfo = sessionManagerModule.readSessionInfo;
		const started = createDeferred();
		const release = createDeferred();
		const readSpy = vi.spyOn(sessionManagerModule, "readSessionInfo").mockImplementation(async (...args) => {
			started.resolve();
			await release.promise;
			return readSessionInfo(...args);
		});
		const scan = ledger.family();
		try {
			await started.promise;
			let rosterReady = false;
			const roster = ledger.liveEdges().then((edges) => {
				rosterReady = true;
				return edges;
			});
			await vi.waitFor(() => expect(rosterReady).toBe(true));
			await expect(roster).resolves.toEqual([edge]);
			await ledger.appendRename({ childId: "child", child: childFile, name: "after" });
			await expect(ledger.liveEdges()).resolves.toEqual([{ ...edge, name: "after" }]);
			release.resolve();
			expect((await scan).find((row) => row.path === childFile)).toMatchObject({ name: "before", rlmDepth: 1 });
			expect((await ledger.family()).find((row) => row.path === childFile)).toMatchObject({
				name: "after",
				rlmDepth: 1,
			});
		} finally {
			release.resolve();
			await scan;
			readSpy.mockRestore();
			await harness.cleanup();
		}
	});
});
