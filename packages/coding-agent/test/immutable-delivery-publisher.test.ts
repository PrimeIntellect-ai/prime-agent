/**
 * Tests for publishImmutableDeliveryMarker.
 *
 * Covers: suffix, bounds, exact options, caller/owned erasure, collision,
 * post-open uncertainty, positional write, reopen verification, close counts,
 * real async fs success, and an integration roundtrip with DeliveryMarkerV1.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDeliveryMarkerV1 } from "../src/modes/daemon/b03-delivery-index-codec.js";
import {
	DELIVERY_MARKER_SUFFIX,
	type DeliveryMarkerPublishResult,
	publishImmutableDeliveryMarker,
	RealJournalIo,
} from "../src/modes/daemon/immutable-journal-publisher.js";
import {
	allZero,
	cleanDir,
	detached16,
	entryExists,
	TrackingIo,
	tempDir,
	zeroCaller,
} from "./immutable-publisher-test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deliveryFinalName(seq: number): string {
	return `${String(seq).padStart(20, "0")}${DELIVERY_MARKER_SUFFIX}`;
}

function _uidOf(): number {
	return process.getuid?.() ?? -1;
}

// ---------------------------------------------------------------------------
// Suffix contract
// ---------------------------------------------------------------------------

describe("DELIVERY_MARKER_SUFFIX", () => {
	it("matches the expected scanner layout suffix", () => {
		expect(DELIVERY_MARKER_SUFFIX).toBe(".b03-delivery");
		expect(deliveryFinalName(42)).toBe("00000000000000000042.b03-delivery");
		expect(deliveryFinalName(40000)).toBe("00000000000000040000.b03-delivery");
	});
});

// ---------------------------------------------------------------------------
// INVALID_ARGUMENT
// ---------------------------------------------------------------------------

describe("INVALID_ARGUMENT", () => {
	it("rejects null options", async () => {
		const r = await publishImmutableDeliveryMarker(null as never);
		expect(r).toEqual({ status: "INVALID_ARGUMENT" });
	});

	it("rejects options carrying the wrong key name (seq instead of indexSeq)", async () => {
		const r = await publishImmutableDeliveryMarker({
			journalDir: "/tmp",
			indexSeq: 1,
			bytes: new Uint8Array([1]),
			seq: 1,
		} as never);
		expect(r).toEqual({ status: "INVALID_ARGUMENT" });
	});

	it("rejects options with extra, symbol, or non-enumerable keys", async () => {
		const base = { journalDir: "/tmp", indexSeq: 1, bytes: new Uint8Array([1]) };
		const r1 = await publishImmutableDeliveryMarker({ ...base, extra: true } as never);
		expect(r1).toEqual({ status: "INVALID_ARGUMENT" });

		const withSym: Record<symbol, unknown> = { ...base };
		withSym[Symbol("x")] = 1;
		const r2 = await publishImmutableDeliveryMarker(withSym as never);
		expect(r2).toEqual({ status: "INVALID_ARGUMENT" });

		const withHidden: Record<string, unknown> = { ...base };
		Object.defineProperty(withHidden, "hidden", { value: 1, enumerable: false });
		const r3 = await publishImmutableDeliveryMarker(withHidden as never);
		expect(r3).toEqual({ status: "INVALID_ARGUMENT" });
	});

	it("never invokes getters on options", async () => {
		let gets = 0;
		const opts = {
			journalDir: "/tmp",
			indexSeq: 1,
			bytes: new Uint8Array([1]),
		};
		Object.defineProperty(opts, "indexSeq", {
			enumerable: true,
			get() {
				gets++;
				return 1;
			},
		});
		const r = await publishImmutableDeliveryMarker(opts as never);
		expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		expect(gets).toBe(0);
	});

	it("rejects non-string journalDir", async () => {
		const r = await publishImmutableDeliveryMarker({
			journalDir: 123 as never,
			indexSeq: 1,
			bytes: new Uint8Array([1]),
		});
		expect(r).toEqual({ status: "INVALID_ARGUMENT" });
	});

	it("rejects empty and relative journalDir", async () => {
		for (const dir of ["", "relative/path"]) {
			const r = await publishImmutableDeliveryMarker({ journalDir: dir, indexSeq: 1, bytes: new Uint8Array([1]) });
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		}
	});

	it("rejects non-integer indexSeq and out-of-range indexSeq", async () => {
		for (const s of [1.5, 0, -1, 40001]) {
			const r = await publishImmutableDeliveryMarker({
				journalDir: "/tmp",
				indexSeq: s,
				bytes: new Uint8Array([1]),
			});
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		}
	});

	it("accepts indexSeq = 40000 (max boundary)", async () => {
		const d = await tempDir();
		const bytes = new Uint8Array([1]);
		const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 40000, bytes });
		expect(r.status).toBe("success");
		if (r.status === "success") expect(r.sequence).toBe(40000);
		zeroCaller(bytes);
		await cleanDir(d);
	});

	it("rejects Buffer, subclass, SAB, subview, detached, empty, oversized bytes", async () => {
		class MyU8 extends Uint8Array {}
		const sab = new SharedArrayBuffer(10);
		const big = new Uint8Array(32);
		const cases: unknown[] = [
			Buffer.from([1]),
			new MyU8([1]),
			new Uint8Array(sab),
			big.subarray(0, 4),
			detached16(),
			new Uint8Array(0),
			new Uint8Array(1_310_721),
		];
		for (const b of cases) {
			const r = await publishImmutableDeliveryMarker({
				journalDir: "/tmp",
				indexSeq: 1,
				bytes: b as never,
			});
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		}
	});

	it("erases caller bytes even when path/seq invalid", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		await publishImmutableDeliveryMarker({ journalDir: "/tmp", indexSeq: 40001, bytes });
		zeroCaller(bytes);
	});

	it("rejects journalDir with wrong mode or setgid", async () => {
		const { chmod } = await import("node:fs/promises");
		for (const mode of [0o755, 0o2700]) {
			const d = await tempDir();
			await chmod(d, mode);
			const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 1, bytes: new Uint8Array([1]) });
			await cleanDir(d);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		}
	});

	it("rejects journalDir that is a symlink", async () => {
		const { symlink, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const d = await tempDir();
		const linkDir = join(tmpdir(), `ijp-symlink-${Math.random().toString(36).slice(2)}`);
		try {
			await symlink(d, linkDir);
			const r = await publishImmutableDeliveryMarker({
				journalDir: linkDir,
				indexSeq: 1,
				bytes: new Uint8Array([1]),
			});
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		} finally {
			try {
				await rm(linkDir);
			} catch {
				/* ignore */
			}
			await cleanDir(d);
		}
	});

	it("rejects null io and io missing methods", async () => {
		const realIo = new RealJournalIo();
		const incomplete = {
			lstat: realIo.lstat,
			realpath: realIo.realpath,
			open: realIo.open,
		};
		for (const io of [null, incomplete] as never[]) {
			const r = await publishImmutableDeliveryMarker(
				{ journalDir: "/tmp", indexSeq: 1, bytes: new Uint8Array([1]) },
				io,
			);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		}
	});

	it("erases caller bytes when options snapshot fails", async () => {
		const bytes = new Uint8Array([7, 8, 9]);
		const r = await publishImmutableDeliveryMarker({
			journalDir: "/tmp",
			indexSeq: 1,
			bytes,
			extra: true,
		} as never);
		expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		zeroCaller(bytes);
	});

	it("rejects journalDir containing a NUL byte", async () => {
		const bytes = new Uint8Array([1]);
		const r = await publishImmutableDeliveryMarker({
			journalDir: "/tmp/\0evil",
			indexSeq: 1,
			bytes,
		});
		expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		zeroCaller(bytes);
	});

	it("rejects overlong journalDir", async () => {
		const bytes = new Uint8Array([1]);
		const r = await publishImmutableDeliveryMarker({
			journalDir: `/${"a".repeat(5000)}`,
			indexSeq: 1,
			bytes,
		});
		expect(r).toEqual({ status: "INVALID_ARGUMENT" });
		zeroCaller(bytes);
	});

	it("returns POST_PUBLICATION_UNCERTAIN on top-level throw after core entry", async () => {
		const d = await tempDir();
		const io = new TrackingIo();
		io.openFailAt = 2;
		const bytes = new Uint8Array([1]);
		const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 9, bytes }, io);
		expect(r.status).toBe("POST_PUBLICATION_UNCERTAIN");
		expect(await entryExists(d, deliveryFinalName(9))).toBe(true);
		zeroCaller(bytes);
		await cleanDir(d);
	});

	it("returns INVALID_ARGUMENT when allocateBuffer throws or yields wrong/subclass buffer", async () => {
		class MyU8 extends Uint8Array {}
		const variants: ((size: number) => Uint8Array)[] = [
			() => {
				throw new Error("alloc");
			},
			(size) => new Uint8Array(size + 3),
			(size) => new MyU8(size),
		];
		for (const alloc of variants) {
			const d = await tempDir();
			const io = new TrackingIo();
			io.allocateBuffer = alloc;
			const bytes = new Uint8Array([1, 2, 3]);
			const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 1, bytes }, io);
			expect(r).toEqual({ status: "INVALID_ARGUMENT" });
			zeroCaller(bytes);
			await cleanDir(d);
		}
	});
});

// ---------------------------------------------------------------------------
// Successful publication
// ---------------------------------------------------------------------------

describe("successful delivery marker publication", () => {
	it("publishes a marker and returns frozen success with sequence field", async () => {
		const d = await tempDir();
		const content = new Uint8Array([104, 101, 108, 108, 111]);
		const originalCopy = new Uint8Array(content);
		const io = new TrackingIo();

		const result = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 42, bytes: content }, io);

		expect(result.status).toBe("success");
		if (result.status === "success") {
			expect(result.sequence).toBe(42);
			expect(result.size).toBe(5);
			expect(result.sha256).toBeDefined();
			expect(result.sha256.length).toBe(64);
			// No seq field in delivery result
			expect((result as Record<string, unknown>).seq).toBeUndefined();
		}

		zeroCaller(content);

		const finalPath = join(d, deliveryFinalName(42));
		const st = await stat(finalPath);
		expect(st.isFile()).toBe(true);
		expect(st.mode & 0o777).toBe(0o600);
		expect(st.size).toBe(5);
		expect(st.nlink).toBe(1);

		const fileContent = await readFile(finalPath);
		expect(Array.from(fileContent)).toEqual(Array.from(originalCopy));

		for (const ab of io.allocatedBuffers) {
			expect(allZero(ab)).toBe(true);
		}
		await cleanDir(d);
	});

	it("writes with explicit positional offsets", async () => {
		const d = await tempDir();
		const size = 200_000;
		const content = new Uint8Array(size);
		for (let i = 0; i < size; i++) content[i] = i & 0xff;
		const io = new TrackingIo();

		const result = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 7, bytes: content }, io);
		expect(result.status).toBe("success");
		expect(io.writePositions).toEqual([0, 65536, 131072, 196608]);
		await cleanDir(d);
	});

	it("closes every handle exactly once on success", async () => {
		const d = await tempDir();
		const io = new TrackingIo();
		const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 7, bytes: new Uint8Array([1]) }, io);
		expect(r.status).toBe("success");
		for (let h = 1; h <= 3; h++) {
			expect(io.closeCountFor(h)).toBe(1);
		}
		await cleanDir(d);
	});

	it("uses default io when not provided", async () => {
		const d = await tempDir();
		try {
			const result = await publishImmutableDeliveryMarker({
				journalDir: d,
				indexSeq: 1,
				bytes: new Uint8Array([1]),
			});
			expect(result.status).toBe("success");
			expect((await stat(join(d, deliveryFinalName(1)))).isFile()).toBe(true);
		} finally {
			await cleanDir(d);
		}
	});

	it("publishes content at max size (1.25 MiB)", async () => {
		const d = await tempDir();
		const size = 1_310_720;
		const content = new Uint8Array(size);
		for (let i = 0; i < size; i++) content[i] = i & 0xff;

		const originalCopy = new Uint8Array(content);
		const result = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 40000, bytes: content });

		expect(result.status).toBe("success");
		if (result.status === "success") {
			expect(result.size).toBe(size);
			expect(result.sequence).toBe(40000);
			const finalPath = join(d, deliveryFinalName(40000));
			const fileContent = await readFile(finalPath);
			expect(Buffer.from(fileContent).equals(Buffer.from(originalCopy))).toBe(true);
		}
		await cleanDir(d);
	});
});

// ---------------------------------------------------------------------------
// SEQ_COLLISION (returns .sequence field)
// ---------------------------------------------------------------------------

describe("DELIVERY SEQ_COLLISION", () => {
	it("returns SEQ_COLLISION when final already exists and preserves it", async () => {
		const d = await tempDir();
		const finalPath = join(d, deliveryFinalName(1));
		await import("node:fs/promises").then((m) => m.writeFile(finalPath, "existing"));

		const bytes = new Uint8Array([1]);
		const io = new TrackingIo();
		const result = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 1, bytes }, io);

		expect(result).toEqual({ status: "SEQ_COLLISION", sequence: 1 });
		expect(await import("node:fs/promises").then((m) => m.readFile(finalPath, "utf8"))).toBe("existing");
		zeroCaller(bytes);
		for (const ab of io.allocatedBuffers) {
			expect(allZero(ab)).toBe(true);
		}
		await cleanDir(d);
	});
});

// ---------------------------------------------------------------------------
// Post-open uncertainty (fault injection reuses TrackingIo)
// ---------------------------------------------------------------------------

describe("delivery POST_PUBLICATION_UNCERTAIN", () => {
	let d: string;
	let io: TrackingIo;

	const expectUncertainWithFinal = async (result: DeliveryMarkerPublishResult, seq: number): Promise<void> => {
		expect(result.status).toBe("POST_PUBLICATION_UNCERTAIN");
		if (result.status === "POST_PUBLICATION_UNCERTAIN") {
			expect(result.sequence).toBe(seq);
			expect(result.sha256.length).toBe(64);
		}
		expect(await entryExists(d, deliveryFinalName(seq))).toBe(true);
		expect(io.records.every((r) => !["unlink", "unlinkIfOwned"].includes(r.op))).toBe(true);
	};

	beforeEach(async () => {
		d = await tempDir();
		io = new TrackingIo();
	});

	afterEach(async () => {
		await cleanDir(d);
	});

	it("on injected open failure, no evidence expected (file never created)", async () => {
		io.failNext("open");
		const bytes = new Uint8Array([1, 2, 3]);
		const result = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 42, bytes }, io);
		expect(result.status).toBe("POST_PUBLICATION_UNCERTAIN");
		if (result.status === "POST_PUBLICATION_UNCERTAIN") {
			expect(result.sequence).toBe(42);
			expect(result.sha256.length).toBe(64);
		}
		// No evidence file was created -- open never succeeded.
		expect(io.records.every((r) => !["unlink", "unlinkIfOwned", "link"].includes(r.op))).toBe(true);
		zeroCaller(bytes);
	});

	it("on initial nonzero size", async () => {
		io.initialNonZeroSize = true;
		const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 9, bytes: new Uint8Array([1]) }, io);
		await expectUncertainWithFinal(r, 9);
	});

	it("on write failure", async () => {
		io.failNext("fh.write");
		const r = await publishImmutableDeliveryMarker(
			{ journalDir: d, indexSeq: 9, bytes: new Uint8Array([1, 2, 3]) },
			io,
		);
		await expectUncertainWithFinal(r, 9);
	});

	it("on file fsync failure", async () => {
		io.failNext("fh.fsync");
		const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 9, bytes: new Uint8Array([1]) }, io);
		await expectUncertainWithFinal(r, 9);
	});

	it("on reopen inode mismatch", async () => {
		io.corruptNextRdonly = 1;
		const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 9, bytes: new Uint8Array([1]) }, io);
		await expectUncertainWithFinal(r, 9);
	});

	it("on reopen read failure", async () => {
		io.failNext("fh.read");
		const r = await publishImmutableDeliveryMarker(
			{ journalDir: d, indexSeq: 9, bytes: new Uint8Array([1, 2, 3]) },
			io,
		);
		await expectUncertainWithFinal(r, 9);
	});

	it("on dir fsync failure", async () => {
		io.failHandle("fh.fsync", 3);
		const r = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 9, bytes: new Uint8Array([1]) }, io);
		await expectUncertainWithFinal(r, 9);
	});
});

// ---------------------------------------------------------------------------
// Caller erase
// ---------------------------------------------------------------------------

describe("delivery caller erase", () => {
	it("erases caller bytes on success", async () => {
		const d = await tempDir();
		const bytes = new Uint8Array([1, 2, 3]);
		await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 1, bytes });
		zeroCaller(bytes);
		await cleanDir(d);
	});

	it("erases caller bytes on INVALID_ARGUMENT", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		await publishImmutableDeliveryMarker({ journalDir: "/nonexistent", indexSeq: 1, bytes });
		zeroCaller(bytes);
	});

	it("erases caller bytes on collision", async () => {
		const d = await tempDir();
		const finalPath = join(d, deliveryFinalName(5));
		await import("node:fs/promises").then((m) => m.writeFile(finalPath, "x"));
		const bytes = new Uint8Array([1, 2, 3]);
		await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 5, bytes });
		zeroCaller(bytes);
		await cleanDir(d);
	});

	it("erases caller bytes on open failure", async () => {
		const d = await tempDir();
		const io = new TrackingIo();
		io.failNext("open");
		const bytes = new Uint8Array([1, 2, 3]);
		await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 1, bytes }, io);
		zeroCaller(bytes);
		for (const ab of io.allocatedBuffers) {
			expect(allZero(ab)).toBe(true);
		}
		await cleanDir(d);
	});
});

// ---------------------------------------------------------------------------
// Buffer erasure through allocation seam
// ---------------------------------------------------------------------------

describe("delivery buffer erasure", () => {
	it("every internal buffer is zeroed on success", async () => {
		const d = await tempDir();
		const io = new TrackingIo();
		const bytes = new Uint8Array([10, 20, 30, 40]);
		const result = await publishImmutableDeliveryMarker({ journalDir: d, indexSeq: 10, bytes }, io);
		expect(result.status).toBe("success");
		for (const ab of io.allocatedBuffers) {
			expect(allZero(ab)).toBe(true);
		}
		await cleanDir(d);
	});
});

// ---------------------------------------------------------------------------
// DeliveryMarkerV1 integration — encode, publish, read, decode
// ---------------------------------------------------------------------------

describe("DeliveryMarkerV1 integration roundtrip", () => {
	it("encodes a real marker, publishes via delivery publisher, reads back, decodes, and verifies identity/digest", async () => {
		const d = await tempDir();
		try {
			const markerRaw = Object.freeze({
				version: 1,
				hostId: "h-abc",
				generation: "g-xyz",
				sessionId: "s-001",
				direction: "sent" as const,
				frameId: "f-002",
				envelopeDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				journalSeq: 1,
				indexSeq: 1,
				state: "pending" as const,
				recordedAt: "2026-02-15T10:30:00.000Z",
			});

			// Encode via the accepted codec
			const enc = encodeDeliveryMarkerV1(markerRaw);
			expect(enc.ok).toBe(true);
			if (!enc.ok) return;
			const { bytes, marker } = enc;

			// Publish the encoded bytes via delivery publisher
			const pubResult = await publishImmutableDeliveryMarker({
				journalDir: d,
				indexSeq: marker.indexSeq,
				bytes: new Uint8Array(bytes),
			});
			expect(pubResult.status).toBe("success");

			// Read back from filesystem (async, no sync fs)
			const finalPath = join(d, deliveryFinalName(marker.indexSeq));
			const onDisk = await readFile(finalPath);
			expect(Buffer.from(onDisk).equals(Buffer.from(bytes))).toBe(true);
			expect(onDisk.byteLength).toBe(pubResult.status === "success" ? pubResult.size : -1);

			// Decode the bytes using the accepted codec
			const dec = (await import("../src/modes/daemon/b03-delivery-index-codec.js")).decodeDeliveryMarkerV1(
				new Uint8Array(onDisk),
				{
					hostId: marker.hostId,
					generation: marker.generation,
					sessionId: marker.sessionId,
				},
			);
			expect(dec.ok).toBe(true);
			if (!dec.ok) return;

			// Verify exact identity/index/digest
			expect(dec.marker.hostId).toBe("h-abc");
			expect(dec.marker.generation).toBe("g-xyz");
			expect(dec.marker.sessionId).toBe("s-001");
			expect(dec.marker.indexSeq).toBe(1);
			expect(dec.marker.envelopeDigest).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
			expect(dec.marker.direction).toBe("sent");
			expect(dec.marker.state).toBe("pending");
			expect(dec.marker.frameId).toBe("f-002");
			expect(dec.marker.journalSeq).toBe(1);
		} finally {
			await cleanDir(d);
		}
	});
});
