import { describe, expect, it } from "vitest";
import {
	DISPOSABLE_GHOST_GRACE_MS,
	type DisposableGhostCandidate,
	isDisposableGhost,
} from "../src/core/session-ghost.js";

const NOW = Date.parse("2026-09-01T12:00:00Z");

function candidate(overrides: Partial<DisposableGhostCandidate> = {}): DisposableGhostCandidate {
	const stale = NOW - DISPOSABLE_GHOST_GRACE_MS;
	return {
		hasUserContent: false,
		createdAtMs: stale - 60_000,
		modifiedAtMs: stale,
		resident: false,
		attached: false,
		leased: false,
		hasQueuedInput: false,
		hasScheduledJob: false,
		hasSpawnLedgerChildren: false,
		...overrides,
	};
}

describe("isDisposableGhost", () => {
	it("disposes a stale session with no user content and no live claims", () => {
		expect(isDisposableGhost(candidate(), NOW)).toBe(true);
	});

	it("keeps a draft: any user content beyond the creation prefix survives", () => {
		expect(isDisposableGhost(candidate({ hasUserContent: true }), NOW)).toBe(false);
	});

	it("keeps a session whose scan predates the user-content flag", () => {
		expect(isDisposableGhost(candidate({ hasUserContent: undefined }), NOW)).toBe(false);
	});

	it("keeps a session with queued or stashed prompt input", () => {
		expect(isDisposableGhost(candidate({ hasQueuedInput: true }), NOW)).toBe(false);
	});

	it("keeps a session with an armed heartbeat or registered cron descriptor", () => {
		expect(isDisposableGhost(candidate({ hasScheduledJob: true }), NOW)).toBe(false);
	});

	it("keeps a session with live spawn-ledger children", () => {
		expect(isDisposableGhost(candidate({ hasSpawnLedgerChildren: true }), NOW)).toBe(false);
	});

	it("keeps resident, attached, and leased sessions", () => {
		expect(isDisposableGhost(candidate({ resident: true }), NOW)).toBe(false);
		expect(isDisposableGhost(candidate({ attached: true }), NOW)).toBe(false);
		expect(isDisposableGhost(candidate({ leased: true }), NOW)).toBe(false);
	});

	it("keeps a session inside the grace window and disposes it at the boundary", () => {
		expect(isDisposableGhost(candidate({ modifiedAtMs: NOW - DISPOSABLE_GHOST_GRACE_MS + 1000 }), NOW)).toBe(false);
		expect(isDisposableGhost(candidate({ createdAtMs: NOW - DISPOSABLE_GHOST_GRACE_MS, modifiedAtMs: 0 }), NOW)).toBe(
			true,
		);
	});

	it("keeps a session with unparseable timestamps", () => {
		expect(isDisposableGhost(candidate({ createdAtMs: Number.NaN, modifiedAtMs: Number.NaN }), NOW)).toBe(false);
	});
});
