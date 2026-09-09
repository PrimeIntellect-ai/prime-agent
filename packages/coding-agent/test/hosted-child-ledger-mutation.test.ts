/**
 * hosted-child-ledger-mutation.test.ts — Mutation test.
 *
 * Verifies that the mutation fixture exits with code 1 only when every
 * production mutation attempt is blocked. Exit 0 means a mutation succeeded
 * or the proof could not establish protection, and fails this test.
 * No casts, `any`, non-null assertion, `instanceof`, `throw`, spread,
 * `as const`, `Object.setPrototypeOf`, or `ts-expect-error` appear in this file.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const mutationFixturePath: string = resolve(__dirname, "fixtures/hosted-child-ledger-mutation-worker.ts");

describe("mutation detection", () => {
	it("exits with code 1 when fixture runs against production ledger", () => {
		// Spawn a subprocess that imports and exercises the production ledger
		const result = spawnSync("bun", ["run", mutationFixturePath], {
			timeout: 15000,
		});
		// IMPORTANT: exit 1 when immutability guard is healthy (expected).
		// If production becomes mutable or the proof cannot exercise the API,
		// the fixture exits 0 and this assertion fails.
		expect(result.status).toBe(1);
	});
});
