import { describe, expect, it } from "vitest";
import {
	decodePawsManifestBytes,
	encodePawsManifest,
	PAWS_ERRORS,
	type PawsAddEntry,
	type PawsChangeEntry,
	type PawsChangesetEntry,
	type PawsDeleteEntry,
	type PawsResult,
	type PawsSnapshotEntry,
} from "../src/core/paws-stream-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

const WS = "test-ws";
const S0 = "0000000000000000000000000000000000000000000000000000000000000000";

function makeSnap(path: string, size = 10, mode = 100644, sha256 = S0, offset = 0): PawsSnapshotEntry {
	return { path, size, mode, sha256, offset };
}
function makeAdd(path: string, size = 10, mode = 100644, sha256 = S0, offset = 0): PawsAddEntry {
	return { operation: "add", path, size, mode, sha256, offset };
}
function makeChg(path: string, size = 10, mode = 100644, sha256 = S0, offset = 0, baseHash = S0): PawsChangeEntry {
	return { operation: "change", path, size, mode, sha256, offset, baseHash };
}
function makeDel(path: string, baseHash = S0): PawsDeleteEntry {
	return { operation: "delete", path, baseHash };
}

function ok<T>(r: PawsResult<T>): T {
	expect(r.ok).toBe(true);
	if (r.ok === false) throw new Error("unreachable");
	return r.value;
}

function expectFail(r: PawsResult<unknown>, code: string): void {
	expect(r.ok).toBe(false);
	if (r.ok === true) throw new Error("unreachable");
	expect(r.error.code).toBe(code);
}

function buildPawsBytes(json: string): Uint8Array {
	const jsonBytes = new TextEncoder().encode(json);
	const headerSize = 13 + jsonBytes.length;
	const bytes = new Uint8Array(headerSize);
	bytes[0] = 0x50;
	bytes[1] = 0x41;
	bytes[2] = 0x57;
	bytes[3] = 0x53;
	bytes[4] = 0x31;
	const hi = Math.floor(jsonBytes.length / 0x100000000);
	const lo = jsonBytes.length >>> 0;
	bytes[5] = (hi >>> 24) & 0xff;
	bytes[6] = (hi >>> 16) & 0xff;
	bytes[7] = (hi >>> 8) & 0xff;
	bytes[8] = hi & 0xff;
	bytes[9] = (lo >>> 24) & 0xff;
	bytes[10] = (lo >>> 16) & 0xff;
	bytes[11] = (lo >>> 8) & 0xff;
	bytes[12] = lo & 0xff;
	bytes.set(jsonBytes, 13);
	return bytes;
}

// ===========================================================================
// 1. Basic snapshot
// ===========================================================================

describe("snapshot", () => {
	it("empty snapshot (zero entries)", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [] }));
		expect(r.manifest.totalBytes).toBe(0);
		expect(r.manifest.snapshotId).toMatch(/^[0-9a-f]{64}$/);
		expect(r.manifest.entries.length).toBe(0);
		expect(r.payloadSize).toBe(0);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		expect(d.manifest.snapshotId).toBe(r.manifest.snapshotId);
	});

	it("single file snapshot", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("a.txt", 100)] }));
		expect(r.manifest.totalBytes).toBe(100);
		expect(r.manifest.entries.length).toBe(1);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		if (d.manifest.kind === "snapshot") {
			expect(d.manifest.entries[0].path).toBe("a.txt");
		}
	});

	it("empty file (size 0)", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("empty.bin", 0)] }));
		expect(r.manifest.totalBytes).toBe(0);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		if (d.manifest.kind === "snapshot") {
			expect(d.manifest.entries[0].size).toBe(0);
		}
	});

	it("multiple files sorted", () => {
		const entries = [makeSnap("b.txt", 20, 100755, S0, 20), makeSnap("a.txt", 10, 100644, S0, 0)].sort((a, b) => {
			const ba = new TextEncoder().encode(a.path);
			const bb = new TextEncoder().encode(b.path);
			for (let i = 0; i < Math.min(ba.length, bb.length); i++) {
				if (ba[i] !== bb[i]) return ba[i] - bb[i];
			}
			return ba.length - bb.length;
		});
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries }));
		if (r.manifest.kind === "snapshot") {
			expect(r.manifest.entries[0].path).toBe("a.txt");
			expect(r.manifest.entries[0].offset).toBe(0);
			expect(r.manifest.entries[1].offset).toBe(10);
		}
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		if (d.manifest.kind === "snapshot") {
			expect(d.manifest.entries.length).toBe(2);
		}
	});

	it("deterministic snapshotId", () => {
		const e1 = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		const e2 = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		expect(e1.manifest.snapshotId).toBe(e2.manifest.snapshotId);
	});

	it("different content yields different snapshotId", () => {
		const e1 = ok(
			encodePawsManifest({
				kind: "snapshot",
				workspaceId: WS,
				entries: [makeSnap("f", 10, 100644, "a".repeat(64))],
			}),
		);
		const e2 = ok(
			encodePawsManifest({
				kind: "snapshot",
				workspaceId: WS,
				entries: [makeSnap("f", 10, 100644, "b".repeat(64))],
			}),
		);
		expect(e1.manifest.snapshotId).not.toBe(e2.manifest.snapshotId);
	});

	it("100755 mode preserved", () => {
		const r = ok(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("exec.sh", 10, 100755)] }),
		);
		if (r.manifest.kind === "snapshot") {
			expect(r.manifest.entries[0].mode).toBe(100755);
		}
	});
});

// ===========================================================================
// 2. Changeset
// ===========================================================================

describe("changeset", () => {
	const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const TARGET = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

	it("add operation", () => {
		const r = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeAdd("new.txt", 50)],
			}),
		);
		expect(r.manifest.kind).toBe("changeset");
		expect(r.payloadSize).toBe(50);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		expect(d.manifest.kind).toBe("changeset");
	});

	it("change operation with baseHash", () => {
		const r = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeChg("old.txt", 30, 100644, S0, 0, S0)],
			}),
		);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		if (d.manifest.kind === "changeset") {
			const e0 = d.manifest.entries[0];
			expect(e0.operation).toBe("change");
			if (e0.operation === "change") {
				expect(e0.baseHash).toBe(S0);
			}
		}
	});

	it("delete operation (zero payload)", () => {
		const r = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeDel("gone.txt", S0)],
			}),
		);
		expect(r.payloadSize).toBe(0);
		expect(r.manifest.totalBytes).toBe(0);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		if (d.manifest.kind === "changeset") {
			expect(d.manifest.entries[0].operation).toBe("delete");
		}
	});

	it("mixed add+change+delete", () => {
		const entries: PawsChangesetEntry[] = [
			makeAdd("add.txt", 30),
			makeChg("mod.txt", 20, 100644, S0, 0, S0),
			makeDel("del.txt", S0),
		].sort((a, b) => {
			const ba = new TextEncoder().encode(a.path);
			const bb = new TextEncoder().encode(b.path);
			for (let i = 0; i < Math.min(ba.length, bb.length); i++) {
				if (ba[i] !== bb[i]) return ba[i] - bb[i];
			}
			return ba.length - bb.length;
		});
		const r = ok(
			encodePawsManifest({ kind: "changeset", workspaceId: WS, baseSnapshotId: BASE, snapshotId: TARGET, entries }),
		);
		expect(r.payloadSize).toBe(50);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		expect(d.manifest.entries.length).toBe(3);
	});

	it("empty changeset (no entries, no-op)", () => {
		const r = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [],
			}),
		);
		expect(r.payloadSize).toBe(0);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		expect(d.manifest.totalBytes).toBe(0);
	});

	it("changesetId deterministic", () => {
		const e1 = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeAdd("x", 10)],
			}),
		);
		const e2 = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeAdd("x", 10)],
			}),
		);
		if ("changesetId" in e1.identity && "changesetId" in e2.identity) {
			expect(e1.identity.changesetId).toBe(e2.identity.changesetId);
		}
	});

	it("delete round-trip preserves baseHash", () => {
		const delHash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
		const r = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeDel("gone.txt", delHash)],
			}),
		);
		const d = ok(decodePawsManifestBytes(new Uint8Array(r.bytes)));
		if (d.manifest.kind === "changeset") {
			const e0 = d.manifest.entries[0];
			if (e0.operation === "delete") {
				expect(e0.baseHash).toBe(delHash);
			}
		}
	});
});

// ===========================================================================
// 3. Field error rejection
// ===========================================================================

describe("field errors", () => {
	it("rejects bool kind", () => {
		expectFail(encodePawsManifest({ kind: true, workspaceId: WS, entries: [] }), PAWS_ERRORS.BAD_KIND);
	});
	it("rejects invalid mode", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10, 644)] }),
			PAWS_ERRORS.INVALID_MODE,
		);
	});
	it("rejects negative size", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", -1)] }),
			PAWS_ERRORS.INVALID_SIZE,
		);
	});
	it("rejects float size", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10.5)] }),
			PAWS_ERRORS.INVALID_SIZE,
		);
	});
	it("rejects invalid sha256", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10, 100644, "bad")] }),
			PAWS_ERRORS.INVALID_SHA256,
		);
	});
	it("rejects bad format string", () => {
		const json = `{"format":"bad","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":0,"entries":[]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.BAD_FORMAT);
	});
	it("rejects wrong version", () => {
		const json = `{"format":"prime-agent-workspace","version":2,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":0,"entries":[]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.BAD_VERSION);
	});
	it("rejects extra manifest field", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":0,"entries":[],"extra":1}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.EXTRA_FIELD);
	});
	it("rejects missing manifest field", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","totalBytes":0,"entries":[]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.EXTRA_FIELD);
	});
	it("rejects extra entry field", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":10,"entries":[{"path":"f","size":10,"mode":100644,"sha256":"${S0}","offset":0,"extra":1}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.EXTRA_FIELD);
	});
	it("rejects missing entry field", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":10,"entries":[{"path":"f","size":10,"mode":100644,"sha256":"${S0}"}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.EXTRA_FIELD);
	});
	it("rejects snapshot with baseSnapshotId", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, baseSnapshotId: S0, entries: [] }),
			PAWS_ERRORS.BASE_SNAPSHOT_ID_NOT_ALLOWED,
		);
	});
	it("rejects snapshot with snapshotId input", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, snapshotId: S0, entries: [] }),
			PAWS_ERRORS.EXTRA_FIELD,
		);
	});
	it("rejects changeset without baseSnapshotId", () => {
		expectFail(
			encodePawsManifest({ kind: "changeset", workspaceId: WS, entries: [] }),
			PAWS_ERRORS.BASE_SNAPSHOT_ID_REQUIRED,
		);
	});
	it("rejects changeset without snapshotId", () => {
		expectFail(
			encodePawsManifest({ kind: "changeset", workspaceId: WS, baseSnapshotId: S0, entries: [] }),
			PAWS_ERRORS.FIELD_TYPE_ERROR,
		);
	});
	it("rejects invalid operation string", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"changeset","workspaceId":"w","baseSnapshotId":"${S0}","snapshotId":"${S0}","totalBytes":0,"entries":[{"operation":"rename","path":"f","baseHash":"${S0}"}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.INVALID_OPERATION);
	});
	it("rejects delete with size field", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"changeset","workspaceId":"w","baseSnapshotId":"${S0}","snapshotId":"${S0}","totalBytes":0,"entries":[{"operation":"delete","path":"f","baseHash":"${S0}","size":10}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.EXTRA_FIELD);
	});
	it("rejects unsorted entries", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("b", 10), makeSnap("a", 10)] }),
			PAWS_ERRORS.ENTRIES_UNSORTED,
		);
	});
	it("rejects duplicate paths", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("dup", 10), makeSnap("dup", 10)] }),
			PAWS_ERRORS.DUPLICATE_ENTRY_PATH,
		);
	});
	it("rejects prefix conflict (dir vs dir/file)", () => {
		expectFail(
			encodePawsManifest({
				kind: "snapshot",
				workspaceId: WS,
				entries: [makeSnap("dir", 10), makeSnap("dir/file", 10)],
			}),
			PAWS_ERRORS.PREFIX_CONFLICT,
		);
	});
	it("accepts a/ab (sorted, not prefix)", () => {
		const r = ok(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("a", 10), makeSnap("ab", 10)] }),
		);
		expect(r.manifest.entries.length).toBe(2);
	});
});

// ===========================================================================
// 4. Boundary conditions
// ===========================================================================

describe("boundaries", () => {
	it("max file size (50 MiB)", () => {
		const r = ok(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("big", 50 * 1024 * 1024)] }),
		);
		expect(r.payloadSize).toBe(50 * 1024 * 1024);
	});
	it("rejects file exceeding 50 MiB", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("big", 50 * 1024 * 1024 + 1)] }),
			PAWS_ERRORS.INVALID_SIZE,
		);
	});
	it("max path (512 bytes)", () => {
		const p = "a".repeat(512);
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap(p, 10)] }));
		expect(r.manifest.entries[0].path.length).toBe(512);
	});
	it("rejects path exceeding 512 bytes", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("a".repeat(513), 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects leading slash", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("/abs", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects trailing slash", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("trail/", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects dot segment", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("./a", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects dotdot segment", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("../a", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects backslash", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("bad\\\\file", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects control char", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("bad\u0001file", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects C1 control char (U+0085)", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("a\u0085b", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("rejects non-NFC path", () => {
		expectFail(
			encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("e\u0301.txt", 10)] }),
			PAWS_ERRORS.INVALID_PATH,
		);
	});
	it("100k entries", () => {
		const entries: PawsSnapshotEntry[] = [];
		for (let i = 0; i < 100000; i++) {
			const name = String(i).padStart(5, "0");
			entries.push(makeSnap(`f${name}.txt`, 1));
		}
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries }));
		expect(r.manifest.entries.length).toBe(100000);
	});
	it("single entry ordering", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("single", 10)] }));
		expect(r.manifest.entries.length).toBe(1);
	});
});

// ===========================================================================
// 5. Buffer validation
// ===========================================================================

describe("buffer validation", () => {
	it("rejects null", () => {
		expectFail(decodePawsManifestBytes(null), PAWS_ERRORS.NOT_A_BUFFER);
	});
	it("rejects empty buffer", () => {
		expectFail(decodePawsManifestBytes(new Uint8Array(0)), PAWS_ERRORS.BUFFER_EMPTY);
	});
	it("rejects Proxy", () => {
		expectFail(decodePawsManifestBytes(new Proxy(new Uint8Array(13), {})), PAWS_ERRORS.NOT_A_BUFFER);
	});
	it("rejects Buffer (Node.js subclass)", () => {
		expectFail(decodePawsManifestBytes(Buffer.from("PAWS1")), PAWS_ERRORS.NOT_A_BUFFER);
	});
	it("rejects non-zero byteOffset subarray", () => {
		const big = new Uint8Array(100);
		const view = new Uint8Array(big.buffer, 10, 20);
		expectFail(decodePawsManifestBytes(view), PAWS_ERRORS.NOT_A_BUFFER);
	});
	it("rejects custom prototype", () => {
		const arr = new Uint8Array(13);
		Object.setPrototypeOf(arr, Object.create(null));
		expectFail(decodePawsManifestBytes(arr), PAWS_ERRORS.NOT_A_BUFFER);
	});
	it("rejects extra own property on bytes", () => {
		const arr = new Uint8Array(13);
		Object.defineProperty(arr, "x", { value: 1, enumerable: true, configurable: true });
		// isGenuineUint8Array rejects first as NOT_A_BUFFER (ownNames mismatch)
		expectFail(decodePawsManifestBytes(arr), PAWS_ERRORS.NOT_A_BUFFER);
	});
	it("bad magic", () => {
		const bytes = new Uint8Array(13);
		bytes[0] = 0x50;
		bytes[1] = 0x41;
		bytes[2] = 0x52;
		bytes[3] = 0x53;
		bytes[4] = 0x31;
		expectFail(decodePawsManifestBytes(bytes), PAWS_ERRORS.BAD_MAGIC);
	});
});

// ===========================================================================
// 6. Offset / totalBytes
// ===========================================================================

describe("offsets", () => {
	it("rejects non-zero start offset", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":10,"entries":[{"path":"a","size":10,"mode":100644,"sha256":"${S0}","offset":5}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.INVALID_OFFSET);
	});
	it("rejects gap in offsets", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":25,"entries":[{"path":"a","size":10,"mode":100644,"sha256":"${S0}","offset":0},{"path":"b","size":10,"mode":100644,"sha256":"${S0}","offset":15}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.INVALID_OFFSET);
	});
	it("rejects totalBytes mismatch", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":99,"entries":[{"path":"a","size":10,"mode":100644,"sha256":"${S0}","offset":0}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.TOTAL_BYTES_MISMATCH);
	});
});

// ===========================================================================
// 7. Byte erasure
// ===========================================================================

describe("byte erasure", () => {
	it("erases on successful decode", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		const copy = new Uint8Array(r.bytes.length);
		copy.set(r.bytes);
		ok(decodePawsManifestBytes(copy));
		for (const b of copy) expect(b).toBe(0);
	});
	it("erases on failed decode", () => {
		const copy = new Uint8Array(13);
		const d = decodePawsManifestBytes(copy);
		for (const b of copy) expect(b).toBe(0);
		expect(d.ok).toBe(false);
	});
	it("erases on manifest-level failure", () => {
		const json = `{"format":"bad","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"${S0}","totalBytes":0,"entries":[]}`;
		const bytes = buildPawsBytes(json);
		const copy = new Uint8Array(bytes);
		expectFail(decodePawsManifestBytes(copy), PAWS_ERRORS.BAD_FORMAT);
		for (const b of copy) expect(b).toBe(0);
	});
});

// ===========================================================================
// 8. Encode/decode symmetry
// ===========================================================================

describe("symmetry", () => {
	it("snapshot roundtrip", () => {
		const entries = [makeSnap("a/b", 100), makeSnap("c/d.sh", 200, 100755), makeSnap("empty", 0)].sort((a, b) => {
			const ba = new TextEncoder().encode(a.path);
			const bb = new TextEncoder().encode(b.path);
			for (let i = 0; i < Math.min(ba.length, bb.length); i++) {
				if (ba[i] !== bb[i]) return ba[i] - bb[i];
			}
			return ba.length - bb.length;
		});
		const enc = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries }));
		const dec = ok(decodePawsManifestBytes(new Uint8Array(enc.bytes)));
		expect(dec.manifest.snapshotId).toBe(enc.manifest.snapshotId);
		expect(dec.manifest.totalBytes).toBe(enc.manifest.totalBytes);
		if (dec.manifest.kind === "snapshot") {
			dec.manifest.entries.forEach((e, i) => {
				expect(e.path).toBe(entries[i].path);
				expect(e.size).toBe(entries[i].size);
			});
		}
	});
	it("changeset roundtrip", () => {
		const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const TARGET = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
		const entries: PawsChangesetEntry[] = [
			makeDel("del.txt", S0),
			makeChg("mod.txt", 30, 100644, S0, 0, S0),
			makeAdd("new.txt", 50),
		];
		const enc = ok(
			encodePawsManifest({ kind: "changeset", workspaceId: WS, baseSnapshotId: BASE, snapshotId: TARGET, entries }),
		);
		const dec = ok(decodePawsManifestBytes(new Uint8Array(enc.bytes)));
		expect(dec.manifest.snapshotId).toBe(enc.manifest.snapshotId);
		if ("changesetId" in enc.identity) {
			if ("changesetId" in dec.identity) {
				expect(dec.identity.changesetId).toBe(enc.identity.changesetId);
			}
		}
	});
	it("snapshotId mismatch rejection", () => {
		const json = `{"format":"prime-agent-workspace","version":1,"kind":"snapshot","workspaceId":"w","snapshotId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","totalBytes":10,"entries":[{"path":"f","size":10,"mode":100644,"sha256":"${S0}","offset":0}]}`;
		expectFail(decodePawsManifestBytes(buildPawsBytes(json)), PAWS_ERRORS.SNAPSHOT_ID_MISMATCH);
	});
});

// ===========================================================================
// 9. UTF-8 encoding
// ===========================================================================

describe("UTF-8", () => {
	it("rejects non-canonical UTF-8 (overlong)", () => {
		const bytes = new Uint8Array(15);
		bytes[0] = 0x50;
		bytes[1] = 0x41;
		bytes[2] = 0x57;
		bytes[3] = 0x53;
		bytes[4] = 0x31;
		bytes[5] = 0;
		bytes[6] = 0;
		bytes[7] = 0;
		bytes[8] = 0;
		bytes[9] = 0;
		bytes[10] = 0;
		bytes[11] = 0;
		bytes[12] = 2;
		bytes[13] = 0xc0;
		bytes[14] = 0xa1;
		expectFail(decodePawsManifestBytes(bytes), PAWS_ERRORS.INVALID_UTF8);
	});
	it("rejects lone surrogate", () => {
		const bytes = new Uint8Array(17);
		bytes[0] = 0x50;
		bytes[1] = 0x41;
		bytes[2] = 0x57;
		bytes[3] = 0x53;
		bytes[4] = 0x31;
		bytes[5] = 0;
		bytes[6] = 0;
		bytes[7] = 0;
		bytes[8] = 0;
		bytes[9] = 0;
		bytes[10] = 0;
		bytes[11] = 0;
		bytes[12] = 4;
		bytes[13] = 0xed;
		bytes[14] = 0xa0;
		bytes[15] = 0x80;
		bytes[16] = 0x22;
		expectFail(decodePawsManifestBytes(bytes), PAWS_ERRORS.INVALID_UTF8);
	});
});

// ===========================================================================
// 10. Trailing bytes
// ===========================================================================

describe("canonical JSON", () => {
	it("rejects whitespace in snapshot JSON", () => {
		// Build valid manifest, then corrupt with whitespace
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		const origBytes = r.bytes;
		const origJson = new TextDecoder().decode(origBytes.subarray(13));
		// Re-encode with extra whitespace
		const parsed = JSON.parse(origJson);
		const whitespaceJson = JSON.stringify(parsed, null, 2);
		const paddedBytes = buildPawsBytes(whitespaceJson);
		expectFail(decodePawsManifestBytes(paddedBytes), PAWS_ERRORS.NON_CANONICAL);
	});
	it("rejects reordered keys in snapshot JSON", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		const origBytes = r.bytes;
		const origJson = new TextDecoder().decode(origBytes.subarray(13));
		// Reorder keys via manual construction
		const parsed = JSON.parse(origJson);
		const reorderedJson = `{"version":${parsed.version},"format":"${parsed.format}","kind":"${parsed.kind}","workspaceId":"${parsed.workspaceId}","snapshotId":"${parsed.snapshotId}","totalBytes":${parsed.totalBytes},"entries":${JSON.stringify(parsed.entries)}}`;
		const reorderedBytes = buildPawsBytes(reorderedJson);
		expectFail(decodePawsManifestBytes(reorderedBytes), PAWS_ERRORS.NON_CANONICAL);
	});
	it("rejects whitespace in changeset JSON", () => {
		const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const TARGET = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
		const r = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeAdd("f", 10)],
			}),
		);
		const origBytes = r.bytes;
		const origJson = new TextDecoder().decode(origBytes.subarray(13));
		const parsed = JSON.parse(origJson);
		const whitespaceJson = JSON.stringify(parsed, null, 2);
		const paddedBytes = buildPawsBytes(whitespaceJson);
		expectFail(decodePawsManifestBytes(paddedBytes), PAWS_ERRORS.NON_CANONICAL);
	});
	it("rejects reordered keys in changeset JSON", () => {
		const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const TARGET = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
		const r = ok(
			encodePawsManifest({
				kind: "changeset",
				workspaceId: WS,
				baseSnapshotId: BASE,
				snapshotId: TARGET,
				entries: [makeAdd("f", 10)],
			}),
		);
		const origBytes = r.bytes;
		const origJson = new TextDecoder().decode(origBytes.subarray(13));
		const parsed = JSON.parse(origJson);
		const reorderedJson = `{"version":${parsed.version},"format":"${parsed.format}","kind":"${parsed.kind}","workspaceId":"${parsed.workspaceId}","baseSnapshotId":"${parsed.baseSnapshotId}","snapshotId":"${parsed.snapshotId}","totalBytes":${parsed.totalBytes},"entries":${JSON.stringify(parsed.entries)}}`;
		const reorderedBytes = buildPawsBytes(reorderedJson);
		expectFail(decodePawsManifestBytes(reorderedBytes), PAWS_ERRORS.NON_CANONICAL);
	});
	it("canonical JSON respects input erasure on failure", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		const origBytes = r.bytes;
		const origJson = new TextDecoder().decode(origBytes.subarray(13));
		const parsed = JSON.parse(origJson);
		const whitespaceJson = JSON.stringify(parsed, null, 2);
		const paddedBytes = buildPawsBytes(whitespaceJson);
		const copy = new Uint8Array(paddedBytes);
		expectFail(decodePawsManifestBytes(copy), PAWS_ERRORS.NON_CANONICAL);
		for (const b of copy) expect(b).toBe(0);
	});
});
describe("trailing bytes", () => {
	it("rejects trailing data including declared payload", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		// Copy header bytes before decoding (decode erases input)
		const hdrCopy = new Uint8Array(r.bytes.length);
		hdrCopy.set(r.bytes);
		ok(decodePawsManifestBytes(hdrCopy));
		// Build archive with payload bytes appended — rejected as TRAILING_BYTES
		const withPayload = new Uint8Array(r.bytes.length + r.payloadSize);
		withPayload.set(r.bytes);
		expectFail(decodePawsManifestBytes(withPayload), PAWS_ERRORS.TRAILING_BYTES);
		const withTrailing = new Uint8Array(r.bytes.length + 1);
		withTrailing.set(r.bytes);
		expectFail(decodePawsManifestBytes(withTrailing), PAWS_ERRORS.TRAILING_BYTES);
	});
});

// ===========================================================================
// 11. Frozen results
// ===========================================================================

describe("frozen results", () => {
	it("encode returns frozen result", () => {
		const r = encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [] });
		if (r.ok) {
			expect(Object.isFrozen(r)).toBe(true);
			if ("manifest" in r.value) {
				expect(Object.isFrozen(r.value.manifest)).toBe(true);
				expect(Object.isFrozen(r.value.identity)).toBe(true);
				expect(Object.isFrozen(r.value.manifest.entries)).toBe(true);
			}
		}
	});
	it("decode returns frozen result", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		const d = decodePawsManifestBytes(new Uint8Array(r.bytes));
		if (d.ok) {
			expect(Object.isFrozen(d)).toBe(true);
			expect(Object.isFrozen(d.value)).toBe(true);
			expect(Object.isFrozen(d.value.manifest)).toBe(true);
			expect(Object.isFrozen(d.value.identity)).toBe(true);
		}
	});
	it("error object is frozen", () => {
		const r = encodePawsManifest({ kind: true, workspaceId: WS, entries: [] });
		if (!r.ok) {
			expect(Object.isFrozen(r)).toBe(true);
			expect(Object.isFrozen(r.error)).toBe(true);
		}
	});
});

// ===========================================================================
// 12. Owned bytes
// ===========================================================================

describe("owned bytes", () => {
	it("encode returns mutable fresh bytes", () => {
		const r = ok(encodePawsManifest({ kind: "snapshot", workspaceId: WS, entries: [makeSnap("f", 10)] }));
		expect(r.bytes.byteOffset).toBe(0);
		expect(r.bytes.byteLength).toBe(r.bytes.buffer.byteLength);
		expect(Object.isFrozen(r.bytes)).toBe(false);
		r.bytes[5] = 0;
	});
});
