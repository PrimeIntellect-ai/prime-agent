import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudArtifactRef } from "../src/core/cloud/protocol.js";
import {
	CLOUD_SHADOW_HEAD_CUSTOM_TYPE,
	ShadowSessionArtifactError,
	ShadowSessionSplitBrainError,
	ShadowSessionWriter,
} from "../src/core/cloud/shadow-session-writer.js";
import { type CustomEntry, parseSessionEntries } from "../src/core/session-manager.js";

/**
 * Strict tests for the single-writer shadow transcript: identity claims,
 * dedupe, fsync-before-ack semantics (every appended line is readable), and
 * bounded artifact resolution with digest verification.
 */

const roots: string[] = [];
function temp(): string {
	const value = mkdtempSync(join(tmpdir(), "shadow-writer-test-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
});

function messageEntry(id: string, text: string, parentId: string | null = null) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() },
	};
}

function artifactFor(payload: string): CloudArtifactRef {
	return {
		path: "/guest/artifacts/entry.json",
		sha256: `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`,
		bytes: Buffer.byteLength(payload, "utf8"),
	};
}

describe("ShadowSessionWriter", () => {
	it("creates the shadow with a header that claims the remote session id and a cloud marker", () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_head_1.jsonl");
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_head_1",
			cwd: root,
			cloudSessionId: "sess_shadow_head_1",
			generation: 1,
		});
		expect(existsSync(sessionFile)).toBe(true);
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
		expect(entries[0]).toMatchObject({ type: "session", id: "sess_shadow_head_1", cwd: root });
		expect(entries[1]).toMatchObject({
			type: "custom",
			customType: CLOUD_SHADOW_HEAD_CUSTOM_TYPE,
			data: { cloudSessionId: "sess_shadow_head_1", generation: 1 },
		});
		expect(writer.header.id).toBe("sess_shadow_head_1");
	});

	it("fails closed when the file belongs to another session id (split-brain guard)", () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_a.jsonl");
		ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_a",
			cwd: root,
			cloudSessionId: "sess_shadow_a",
			generation: 1,
		});
		expect(() =>
			ShadowSessionWriter.openOrCreate({
				sessionFile,
				sessionId: "sess_shadow_b",
				cwd: root,
				cloudSessionId: "sess_shadow_b",
				generation: 1,
			}),
		).toThrow(ShadowSessionSplitBrainError);
	});

	it("deduplicates mirrored entries by entry id and appends durably", async () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_dedupe.jsonl");
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_dedupe",
			cwd: root,
			cloudSessionId: "sess_shadow_dedupe",
			generation: 1,
		});
		expect(await writer.appendEntry(messageEntry("m1", "hello"))).toBe(true);
		// A guest replay re-delivers the same entry: the shadow never duplicates.
		expect(await writer.appendEntry(messageEntry("m1", "hello"))).toBe(false);
		expect(await writer.appendEntry(messageEntry("m2", "world", "m1"))).toBe(true);
		writer.sync();
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(4); // header + marker + two entries
		const ids = parseSessionEntries(readFileSync(sessionFile, "utf8"))
			.filter((entry) => entry.type !== "session")
			.map((entry) => entry.id);
		expect(ids).toEqual(expect.arrayContaining(["m1", "m2"]));
		expect(ids.filter((id) => id === "m1")).toHaveLength(1);
	});

	it("resolves artifact-backed entries through the bounded transfer and inlines small payloads", async () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_artifact.jsonl");
		const payload = JSON.stringify(messageEntry("big1", "x".repeat(4096)));
		let fetched = 0;
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_artifact",
			cwd: root,
			cloudSessionId: "sess_shadow_artifact",
			generation: 1,
			artifactResolver: {
				fetch: async (ref) => {
					fetched += 1;
					expect(ref.bytes).toBe(Buffer.byteLength(payload, "utf8"));
					return new TextEncoder().encode(payload);
				},
			},
		});
		expect(
			await writer.appendEntry(
				{ type: "message", id: "big1", parentId: null, timestamp: new Date().toISOString() },
				[artifactFor(payload)],
			),
		).toBe(true);
		expect(fetched).toBe(1);
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
		const restored = entries.find((entry) => entry.id === "big1");
		expect(restored).toBeDefined();
		expect(JSON.stringify(restored)).toContain("x".repeat(100));
	});

	it("rejects an artifact whose digest or size does not match its reference", async () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_bad_artifact.jsonl");
		const payload = JSON.stringify(messageEntry("bad1", "payload"));
		const ref = artifactFor(payload);
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_bad_artifact",
			cwd: root,
			cloudSessionId: "sess_shadow_bad_artifact",
			generation: 1,
			artifactResolver: { fetch: async () => new TextEncoder().encode("tampered") },
		});
		await expect(
			writer.appendEntry({ type: "message", id: "bad1", parentId: null, timestamp: new Date().toISOString() }, [
				ref,
			]),
		).rejects.toThrow(ShadowSessionArtifactError);
		// Nothing landed: the caller must not acknowledge the batch.
		expect(existsSync(sessionFile)).toBe(true);
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("stores oversized artifacts under the session artifact directory with a durable marker", async () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_huge.jsonl");
		const huge = "z".repeat(1024 * 1024 + 512);
		const payload = JSON.stringify(messageEntry("huge1", huge));
		const artifactPath = { path: "/guest/artifacts/huge.json" } as const;
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_huge",
			cwd: root,
			cloudSessionId: "sess_shadow_huge",
			generation: 1,
			artifactResolver: { fetch: async () => new TextEncoder().encode(payload) },
		});
		expect(
			await writer.appendEntry(
				{ type: "message", id: "huge1", parentId: null, timestamp: new Date().toISOString() },
				[
					{
						...artifactPath,
						sha256: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
						bytes: Buffer.byteLength(payload, "utf8"),
					},
				],
			),
		).toBe(true);
		// The transcript line stays bounded and carries no truncated message
		// entry: only the durable artifact marker is appended.
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
		expect(entries.some((entry) => entry.type === "message" && entry.id === "huge1")).toBe(false);
		const stored = entries.find(
			(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "prime-agent.cloud-artifact",
		);
		expect(stored).toMatchObject({ id: "huge1" });
		const markerData = stored?.data as { path?: string; bytes?: number };
		expect(markerData?.path).toBeDefined();
		expect(statSync(markerData!.path!).size).toBe(Buffer.byteLength(payload, "utf8"));
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		for (const line of lines) {
			expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1024 * 1024);
		}
	});

	it("records a generation boundary when the session reprovisions", () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_gen.jsonl");
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_gen",
			cwd: root,
			cloudSessionId: "sess_shadow_gen",
			generation: 1,
		});
		writer.appendGenerationMarker({ generation: 2, sandboxId: "sandbox-2" });
		const marker = parseSessionEntries(readFileSync(sessionFile, "utf8")).find(
			(entry): entry is CustomEntry =>
				entry.type === "custom" && entry.customType === "prime-agent.cloud-generation",
		);
		expect(marker?.data).toMatchObject({ generation: 2, sandboxId: "sandbox-2" });
		expect(writer.generation).toBe(2);
	});

	it("refuses a second session header from the stream", async () => {
		const root = temp();
		const sessionFile = join(root, "sess_shadow_header.jsonl");
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_header",
			cwd: root,
			cloudSessionId: "sess_shadow_header",
			generation: 1,
		});
		await expect(
			writer.appendEntry({ type: "session", id: "h2", parentId: null, timestamp: new Date().toISOString() }),
		).rejects.toThrow("refused a second session header");
		// A re-open of the same file keeps the writer consistent.
		const reopened = ShadowSessionWriter.openOrCreate({
			sessionFile,
			sessionId: "sess_shadow_header",
			cwd: root,
			cloudSessionId: "sess_shadow_header",
			generation: 1,
		});
		expect(reopened.entryCount).toBe(writer.entryCount);
	});

	it("seeds nothing from a pre-existing unrelated file: it claims only its own path", () => {
		const root = temp();
		const unrelated = join(root, "unrelated.jsonl");
		writeFileSync(unrelated, `${JSON.stringify({ type: "session", id: "other" })}\n`, { mode: 0o600 });
		// A fresh writer at its own path never touches the unrelated file.
		const writer = ShadowSessionWriter.openOrCreate({
			sessionFile: join(root, "sess_shadow_isolated.jsonl"),
			sessionId: "sess_shadow_isolated",
			cwd: root,
			cloudSessionId: "sess_shadow_isolated",
			generation: 1,
		});
		expect(writer.sessionFile.endsWith("sess_shadow_isolated.jsonl")).toBe(true);
		expect(readFileSync(unrelated, "utf8")).toContain('"other"');
	});
});
