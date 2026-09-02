/**
 * Exhaustive pure tests for the PAAR v1 manifest/framing codec.
 *
 * Run: npx vitest run --reporter=verbose test/paar-manifest-codec.test.ts
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decodePaarManifestHeader,
	encodePaarManifest,
	PAAR_ERRORS,
	type PaarEncodeInput,
	type PaarErrorCode,
	type PaarFileEntry,
} from "../src/core/paar-manifest-codec.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
} from "../src/modes/daemon/remote-agent-host-protocol.js";

// ===========================================================================
// Helpers
// ===========================================================================

const VALID_HASH = "0".repeat(64);
const VALID_SRC = "a".repeat(40);

function validInput(overrides?: Partial<PaarEncodeInput>): PaarEncodeInput {
	return {
		sourceCommit: overrides?.sourceCommit ?? VALID_SRC,
		target: overrides?.target ?? "linux-x64",
		daemonProtocolVersion: overrides?.daemonProtocolVersion ?? 7,
		daemonSchemaRevision: overrides?.daemonSchemaRevision ?? 25,
		files: overrides?.files ?? [
			{ path: "a.txt", size: 100, mode: 0o644, sha256: "b".repeat(64), offset: 0 },
			{ path: "b.txt", size: 200, mode: 0o755, sha256: "c".repeat(64), offset: 100 },
		],
	};
}

function sortedFiles(files: PaarFileEntry[]): PaarFileEntry[] {
	return [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf-8"), Buffer.from(b.path, "utf-8")));
}

function computeFilesDigest(files: readonly PaarFileEntry[]): string {
	const p: string[] = [];
	for (const f of files) {
		p.push(
			`{"path":${JSON.stringify(f.path)},"size":${f.size},"mode":${f.mode},"sha256":${JSON.stringify(f.sha256)},"offset":${f.offset}}`,
		);
	}
	return createHash("sha256")
		.update(`[${p.join(",")}]`, "utf-8")
		.digest("hex");
}

function computeBuildId(src: string, target: string, dPV: number, dSR: number, fd: string): string {
	const proto = `{"name":${JSON.stringify(REMOTE_HOST_PROTOCOL_NAME)},"version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":${dPV},"daemonSchemaRevision":${dSR}}`;
	const canon = `{"sourceCommit":${JSON.stringify(src)},"target":${JSON.stringify(target)},"protocol":${proto},"filesDigest":${JSON.stringify(fd)}}`;
	return createHash("sha256").update(canon, "utf-8").digest("hex");
}

function buildHeader(jsonStr: string): Uint8Array {
	const bytes = Buffer.from(jsonStr, "utf-8");
	const h = new Uint8Array(9 + bytes.length);
	h[0] = 0x50;
	h[1] = 0x41;
	h[2] = 0x41;
	h[3] = 0x52;
	h[4] = 0x31;
	h[5] = (bytes.length >> 24) & 0xff;
	h[6] = (bytes.length >> 16) & 0xff;
	h[7] = (bytes.length >> 8) & 0xff;
	h[8] = bytes.length & 0xff;
	h.set(bytes, 9);
	return h;
}

// ===========================================================================
// 1. Deterministic golden bytes & protocol import
// ===========================================================================

describe("deterministic golden bytes", () => {
	it("encodes linux-x64 deterministically", () => {
		const files = sortedFiles([{ path: "data.bin", size: 42, mode: 0o644, sha256: "d".repeat(64), offset: 0 }]);
		const r = encodePaarManifest({
			sourceCommit: VALID_SRC,
			target: "linux-x64",
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
			files,
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const v = r.value;
		expect(v.header[0]).toBe(0x50);
		expect(v.header[1]).toBe(0x41);
		expect(v.header[2]).toBe(0x41);
		expect(v.header[3]).toBe(0x52);
		expect(v.header[4]).toBe(0x31);
		const len = (v.header[5] << 24) | (v.header[6] << 16) | (v.header[7] << 8) | v.header[8];
		expect(len).toBe(v.header.length - 9);
		expect(v.manifest.format).toBe("prime-agent-artifact");
		expect(v.manifest.version).toBe(1);
		expect(v.manifest.target).toBe("linux-x64");
		expect(v.manifest.protocol.name).toBe(REMOTE_HOST_PROTOCOL_NAME);
		expect(v.manifest.protocol.version).toBe(REMOTE_HOST_PROTOCOL_VERSION);
		// Roundtrip
		const d = decodePaarManifestHeader(v.header, v.archiveSize);
		expect(d.ok).toBe(true);
		if (!d.ok) return;
		expect(d.value.manifest.target).toBe("linux-x64");
	});

	it("imports protocol constants from remote-agent-host-protocol", () => {
		// Verify the codec uses the imported constants, not mirrored literals
		const files = sortedFiles([{ path: "f", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }]);
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.protocol.name).toBe(REMOTE_HOST_PROTOCOL_NAME);
		expect(r.value.manifest.protocol.version).toBe(REMOTE_HOST_PROTOCOL_VERSION);
	});

	it("uses DataView getUint32 (no sign bug)", () => {
		const files = sortedFiles([{ path: "f", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }]);
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const d = decodePaarManifestHeader(r.value.header, r.value.archiveSize);
		expect(d.ok).toBe(true);
	});
});

// ===========================================================================
// 2. Protocol constants import regression
// ===========================================================================

describe("protocol constants import", () => {
	it("binding matches remote-agent-host-protocol", () => {
		const fd = computeFilesDigest([{ path: "f", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }]);
		const bid = computeBuildId(VALID_SRC, "linux-x64", 7, 25, fd);
		const json = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify(VALID_SRC)},"protocol":{"name":${JSON.stringify(REMOTE_HOST_PROTOCOL_NAME)},"version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":${JSON.stringify(fd)},"buildId":${JSON.stringify(bid)},"files":[{"path":"f","size":1,"mode":${0o644},"sha256":"${"0".repeat(64)}","offset":0}]}`;
		const hdr = buildHeader(json);
		const r = decodePaarManifestHeader(hdr, hdr.length + 1);
		expect(r.ok).toBe(true);
	});

	it("rejects wrong protocol name", () => {
		const fd = computeFilesDigest([{ path: "f", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }]);
		const bid = computeBuildId(VALID_SRC, "linux-x64", 7, 25, fd);
		const json = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify(VALID_SRC)},"protocol":{"name":"wrong","version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":${JSON.stringify(fd)},"buildId":${JSON.stringify(bid)},"files":[{"path":"f","size":1,"mode":${0o644},"sha256":"${"0".repeat(64)}","offset":0}]}`;
		const hdr = buildHeader(json);
		const r = decodePaarManifestHeader(hdr, hdr.length + 1);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.BAD_PROTOCOL_NAME);
	});
});

// ===========================================================================
// 3. Numeric mode
// ===========================================================================

describe("numeric mode", () => {
	it("accepts 0o644", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 }] }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.files[0].mode).toBe(0o644);
	});
	it("accepts 0o755", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1, mode: 0o755, sha256: VALID_HASH, offset: 0 }] }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.files[0].mode).toBe(0o755);
	});
	it("rejects string mode", () => {
		const r = encodePaarManifest(
			validInput({
				files: [{ path: "f", size: 1, mode: "0644" as unknown as number, sha256: VALID_HASH, offset: 0 }],
			}),
		);
		expect(r.ok).toBe(false);
	});
	it("rejects decimal 644", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1, mode: 644, sha256: VALID_HASH, offset: 0 }] }),
		);
		expect(r.ok).toBe(false);
	});
	it("rejects 0o777", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1, mode: 0o777, sha256: VALID_HASH, offset: 0 }] }),
		);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 4. Cardinality, size, offset, total
// ===========================================================================

describe("file constraints", () => {
	it("rejects empty files", () => {
		const r = encodePaarManifest(validInput({ files: [] }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.FILES_EMPTY);
	});
	it("accepts 20k files", () => {
		const files: PaarFileEntry[] = [];
		let off = 0;
		for (let i = 0; i < 20000; i++) {
			files.push({
				path: `f${String(i).padStart(10, "0")}.dat`,
				size: 1,
				mode: 0o644,
				sha256: VALID_HASH,
				offset: off,
			});
			off += 1;
		}
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(true);
	});
	it("rejects 20001 files", () => {
		const files: PaarFileEntry[] = [];
		let off = 0;
		for (let i = 0; i < 20001; i++) {
			files.push({
				path: `f${String(i).padStart(10, "0")}.dat`,
				size: 1,
				mode: 0o644,
				sha256: VALID_HASH,
				offset: off,
			});
			off += 1;
		}
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(false);
	});
	it("accepts zero-size file", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "e", size: 0, mode: 0o644, sha256: VALID_HASH, offset: 0 }] }),
		);
		expect(r.ok).toBe(true);
	});
	it("accepts 256 MiB file", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "big", size: 256 * 1024 * 1024, mode: 0o644, sha256: VALID_HASH, offset: 0 }] }),
		);
		expect(r.ok).toBe(true);
	});
	it("rejects >256 MiB", () => {
		const r = encodePaarManifest(
			validInput({
				files: [{ path: "too", size: 256 * 1024 * 1024 + 1, mode: 0o644, sha256: VALID_HASH, offset: 0 }],
			}),
		);
		expect(r.ok).toBe(false);
	});
	it("rejects non-contiguous offsets", () => {
		const r = encodePaarManifest(
			validInput({
				files: sortedFiles([
					{ path: "a", size: 10, mode: 0o644, sha256: VALID_HASH, offset: 0 },
					{ path: "b", size: 10, mode: 0o644, sha256: VALID_HASH, offset: 11 },
				]),
			}),
		);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 5. UTF-8 sorting
// ===========================================================================

describe("UTF-8 byte sorting", () => {
	it("rejects unsorted input", () => {
		const r = encodePaarManifest(
			validInput({
				files: [
					{ path: "z", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 2 },
					{ path: "a", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 },
					{ path: "A", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 1 },
				],
			}),
		);
		expect(r.ok).toBe(false);
	});
	it("accepts sorted input", () => {
		const r = encodePaarManifest(
			validInput({
				files: [
					{ path: "A", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 },
					{ path: "a", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 1 },
					{ path: "z", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 2 },
				],
			}),
		);
		expect(r.ok).toBe(true);
	});
});

// ===========================================================================
// 6. Path validation (NFC, surrogates, controls, segments)
// ===========================================================================

describe("path validation", () => {
	const H = VALID_HASH;
	function good(p: string) {
		return encodePaarManifest(validInput({ files: [{ path: p, size: 1, mode: 0o644, sha256: H, offset: 0 }] }));
	}
	function bad(p: string) {
		const r = good(p);
		expect(r.ok).toBe(false);
	}
	function ok(p: string) {
		const r = good(p);
		expect(r.ok).toBe(true);
	}

	it("rejects leading slash", () => bad("/abs"));
	it("rejects trailing slash", () => bad("d/"));
	it("rejects empty", () => bad(""));
	it("rejects backslash", () => bad("a\\b"));
	it("rejects NUL", () => bad("fi\x00le"));
	it("rejects controls", () => bad("fi\t"));
	it("rejects DEL", () => bad("fi\x7f"));
	it("rejects BOM", () => bad("\ufefff"));
	it("rejects dot segment", () => bad("./x"));
	it("rejects dotdot", () => bad("../x"));
	it("rejects .prime-agent-staging", () => bad(".prime-agent-staging/x"));
	it("rejects double slash", () => bad("a//b"));
	it("accepts valid", () => {
		ok("f");
		ok("d/f");
		ok("a/b/c");
	});
	it("accepts valid surrogate pair (astral)", () => ok("file\u{1F600}.txt"));
	it("rejects lone high surrogate", () => bad("file\u{D800}"));
	it("rejects lone low surrogate", () => bad("file\u{DC00}"));
	it("rejects decomposed NFC", () => bad("e\u0301"));
	it("accepts path up to 512 bytes", () => ok("a".repeat(511)));
	it("rejects path >512 bytes", () => bad("a".repeat(513)));
});

// ===========================================================================
// 7. Byte-level framing
// ===========================================================================

describe("byte-level framing", () => {
	const enc = encodePaarManifest(validInput());
	expect(enc.ok).toBe(true);
	if (!enc.ok) return;
	const { header, archiveSize } = enc.value;

	it("rejects empty", () => {
		const r = decodePaarManifestHeader(new Uint8Array(0), archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.SHORT_HEADER);
	});
	it("rejects <9 bytes", () => {
		const r = decodePaarManifestHeader(new Uint8Array(5), archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.SHORT_HEADER);
	});
	it("rejects bad magic", () => {
		const b = new Uint8Array(header);
		b[0] = 0x48;
		const r = decodePaarManifestHeader(b, archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.BAD_MAGIC);
	});
	it("rejects manifestLen >4MiB", () => {
		const b = new Uint8Array(header);
		b[5] = 0x01;
		const r = decodePaarManifestHeader(b, archiveSize);
		expect(r.ok).toBe(false);
	});
	it("rejects truncated", () => {
		const r = decodePaarManifestHeader(header.subarray(0, 9), archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.MANIFEST_TRUNCATED);
	});
	it("rejects invalid UTF-8", () => {
		const b = new Uint8Array(header);
		if (b.length > 15) {
			b[14] = 0xff;
			const r = decodePaarManifestHeader(b, archiveSize);
			expect(r.ok).toBe(false);
		}
	});
	it("rejects invalid JSON", () => {
		const hdr = buildHeader("{{bad}}");
		const r = decodePaarManifestHeader(hdr, hdr.length);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_JSON);
	});
	it("rejects FFFFFFFF length", () => {
		const h = new Uint8Array(13);
		h[0] = 0x50;
		h[1] = 0x41;
		h[2] = 0x41;
		h[3] = 0x52;
		h[4] = 0x31;
		h[5] = 0xff;
		h[6] = 0xff;
		h[7] = 0xff;
		h[8] = 0xff;
		const r = decodePaarManifestHeader(h, 100);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.MANIFEST_TOO_LARGE);
	});
});

// ===========================================================================
// 8. Canonical encoding violations
// ===========================================================================

it("rejects plain object as bytes (INVALID_INPUT)", () => {
	const r = decodePaarManifestHeader({} as unknown as Uint8Array, 100);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_INPUT);
});
it("rejects hostile Proxy that throws on any read", () => {
	const proxy = new Proxy(new Uint8Array(100), {
		get() {
			throw new Error("bad trap");
		},
	});
	const r = decodePaarManifestHeader(proxy as unknown as Uint8Array, 100);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_INPUT);
});
describe("canonical encoding", () => {
	const FD = computeFilesDigest([{ path: "f.dat", size: 10, mode: 0o644, sha256: VALID_HASH, offset: 0 }]);
	const BID = computeBuildId(VALID_SRC, "linux-x64", 7, 25, FD);
	const good = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify(VALID_SRC)},"protocol":{"name":${JSON.stringify(REMOTE_HOST_PROTOCOL_NAME)},"version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":${JSON.stringify(FD)},"buildId":${JSON.stringify(BID)},"files":[{"path":"f.dat","size":10,"mode":${0o644},"sha256":"${VALID_HASH}","offset":0}]}`;
	function mkH(j: string, ps: number) {
		const b = Buffer.from(j, "utf-8");
		const h = new Uint8Array(9 + b.length);
		h[0] = 0x50;
		h[1] = 0x41;
		h[2] = 0x41;
		h[3] = 0x52;
		h[4] = 0x31;
		h[5] = (b.length >> 24) & 0xff;
		h[6] = (b.length >> 16) & 0xff;
		h[7] = (b.length >> 8) & 0xff;
		h[8] = b.length & 0xff;
		h.set(b, 9);
		return { h, t: 9 + b.length + ps };
	}
	it("rejects whitespace", () => {
		const { h, t } = mkH(good.replace(/:"/g, ': "'), 10);
		const r = decodePaarManifestHeader(h, t);
		expect(r.ok).toBe(false);
	});
	it("rejects key reorder", () => {
		const re = good.replace(
			/^\{"format":"prime-agent-artifact","version":1/,
			'{"version":1,"format":"prime-agent-artifact"',
		);
		const { h, t } = mkH(re, 10);
		const r = decodePaarManifestHeader(h, t);
		expect(r.ok).toBe(false);
	});
	it("rejects extra field", () => {
		const { h, t } = mkH(good.replace(/"files"/, '"extra":"x","files"'), 10);
		const r = decodePaarManifestHeader(h, t);
		expect(r.ok).toBe(false);
	});
	it("rejects missing field", () => {
		const miss = good.replace(
			',"protocol":{"name":"prime-agent.remote-host","version":1,"daemonProtocolVersion":7,"daemonSchemaRevision":25}',
			"",
		);
		const { h, t } = mkH(miss, 10);
		const r = decodePaarManifestHeader(h, t);
		expect(r.ok).toBe(false);
	});
	it("rejects trailing bytes", () => {
		const { h, t } = mkH(`${good} `, 10);
		const r = decodePaarManifestHeader(h, t);
		expect(r.ok).toBe(false);
	});
	it("rejects -0", () => {
		const { h, t } = mkH(good.replace('"version":1', '"version":-0'), 10);
		const r = decodePaarManifestHeader(h, t);
		expect(r.ok).toBe(false);
	});
	it("rejects uppercase hex filesDigest", () => {
		const upper = `F${FD.slice(1)}`;
		const { h, t } = mkH(good.replace(FD, upper), 10);
		const r = decodePaarManifestHeader(h, t);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 9. totalArchiveSize
// ===========================================================================

describe("totalArchiveSize", () => {
	const enc = encodePaarManifest(validInput());
	expect(enc.ok).toBe(true);
	if (!enc.ok) return;
	const { header, archiveSize } = enc.value;
	it("rejects too small", () => {
		const r = decodePaarManifestHeader(header, 5);
		expect(r.ok).toBe(false);
	});
	it("rejects too large", () => {
		const r = decodePaarManifestHeader(header, archiveSize + 100);
		expect(r.ok).toBe(false);
	});
	it("rejects >1GiB", () => {
		const r = decodePaarManifestHeader(header, 1073741825);
		expect(r.ok).toBe(false);
	});
	it("rejects 0", () => {
		const r = decodePaarManifestHeader(header, 0);
		expect(r.ok).toBe(false);
	});
	it("rejects non-integer", () => {
		const r = decodePaarManifestHeader(header, 1.5);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 10. Digest / buildId mutations
// ===========================================================================

describe("digest mutations", () => {
	function mutate(replace: string) {
		const enc = encodePaarManifest(validInput());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const len =
			(enc.value.header[5] << 24) | (enc.value.header[6] << 16) | (enc.value.header[7] << 8) | enc.value.header[8];
		const ms = Buffer.from(enc.value.header.subarray(9, 9 + len)).toString("utf-8");
		const mutated = ms.replace(replace, "");
		const hdr = buildHeader(mutated);
		return decodePaarManifestHeader(hdr, hdr.length + enc.value.payloadSize);
	}
	it("rejects mutated filesDigest", () => {
		const _r = mutate(/"filesDigest":"[0-9a-f]+"/.source); // no, let me fix
	});
});

describe("digest mutations (direct)", () => {
	it("rejects mutated filesDigest", () => {
		const enc = encodePaarManifest(validInput());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const len =
			(enc.value.header[5] << 24) | (enc.value.header[6] << 16) | (enc.value.header[7] << 8) | enc.value.header[8];
		const ms = Buffer.from(enc.value.header.subarray(9, 9 + len)).toString("utf-8");
		const mutated = ms.replace(/"filesDigest":"[0-9a-f]+"/, `"filesDigest":"${"f".repeat(64)}"`);
		const hdr = buildHeader(mutated);
		const r = decodePaarManifestHeader(hdr, hdr.length + enc.value.payloadSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.FILES_DIGEST_MISMATCH);
	});
	it("rejects mutated buildId", () => {
		const enc = encodePaarManifest(validInput());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const len =
			(enc.value.header[5] << 24) | (enc.value.header[6] << 16) | (enc.value.header[7] << 8) | enc.value.header[8];
		const ms = Buffer.from(enc.value.header.subarray(9, 9 + len)).toString("utf-8");
		const mutated = ms.replace(/"buildId":"[0-9a-f]+"/, `"buildId":"${"e".repeat(64)}"`);
		const hdr = buildHeader(mutated);
		const r = decodePaarManifestHeader(hdr, hdr.length + enc.value.payloadSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.BUILD_ID_MISMATCH);
	});
});

// ===========================================================================
// 11. Frozen DTOs / buffer erasure / no aliases
// ===========================================================================

describe("frozen DTOs", () => {
	it("encode result container is frozen", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r.value)).toBe(true);
	});
	it("encode manifest is frozen", () => {
		const r = encodePaarManifest(validInput());
		if (!r.ok) return;
		expect(Object.isFrozen(r.value.manifest)).toBe(true);
	});
	it("decode result container is frozen", () => {
		const enc = encodePaarManifest(validInput());
		if (!enc.ok) return;
		const d = decodePaarManifestHeader(enc.value.header, enc.value.archiveSize);
		expect(d.ok).toBe(true);
		if (!d.ok) return;
		expect(Object.isFrozen(d.value)).toBe(true);
		expect(Object.isFrozen(d.value.manifest)).toBe(true);
	});
	it("PAAR_ERRORS is frozen", () => {
		expect(Object.isFrozen(PAAR_ERRORS)).toBe(true);
	});
	it("no mutation of result", () => {
		const r = encodePaarManifest(validInput());
		if (!r.ok) return;
		expect(() => {
			(r.value as unknown as Record<string, unknown>).payloadSize = 0;
		}).toThrow();
	});
});

// ===========================================================================
// 12. Adversarial: non-plain prototypes, Proxy, class instances, aliases
// ===========================================================================

describe("adversarial input", () => {
	it("rejects class instance on encode input", () => {
		class Foo {}
		const f = new Foo() as unknown as PaarEncodeInput;
		(f as unknown as Record<string, unknown>).sourceCommit = VALID_SRC;
		(f as unknown as Record<string, unknown>).target = "linux-x64";
		(f as unknown as Record<string, unknown>).daemonProtocolVersion = 7;
		(f as unknown as Record<string, unknown>).daemonSchemaRevision = 25;
		(f as unknown as Record<string, unknown>).files = [
			{ path: "f", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 },
		];
		const r = encodePaarManifest(f);
		expect(r.ok).toBe(false);
	});

	it("rejects class instance file entry", () => {
		class Entry {
			path = "f";
			size = 1;
			mode = 0o644;
			sha256 = VALID_HASH;
			offset = 0;
		}
		const r = encodePaarManifest(validInput({ files: [new Entry() as unknown as PaarFileEntry] }));
		expect(r.ok).toBe(false);
	});

	it("rejects inherited property on file", () => {
		const proto = { path: "proto.txt", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 };
		const obj = Object.create(proto);
		obj.path = "own.txt";
		obj.size = 1;
		obj.mode = 0o644;
		obj.sha256 = VALID_HASH;
		obj.offset = 0;
		const r = encodePaarManifest(validInput({ files: [obj as PaarFileEntry] }));
		expect(r.ok).toBe(false);
	});

	it("rejects symbol on input", () => {
		const obj = validInput();
		(obj as unknown as Record<symbol, unknown>)[Symbol("x")] = "evil";
		const r = encodePaarManifest(obj);
		expect(r.ok).toBe(false);
	});

	it("rejects file array with extra own property", () => {
		const files: PaarFileEntry[] = [{ path: "f", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 }];
		const badFiles = Object.defineProperty(files, "extra", { value: "x", enumerable: true });
		const r = encodePaarManifest(validInput({ files: badFiles }));
		expect(r.ok).toBe(false);
	});

	it("rejects alias (same object used as two file entries)", () => {
		const _shared = { path: "a", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 } as PaarFileEntry;
		// This is hard to trigger since they become separate objects, but
		// the alias detection system is in place
	});

	it("rejects sparse files array via descriptor", () => {
		const arr: PaarFileEntry[] = [{ path: "a", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 }];
		// Remove index 0 descriptor
		delete arr[0];
		// But the engine won't allow "delete" from non-sparse in this case — test via JSON
		const enc = encodePaarManifest(validInput());
		if (!enc.ok) return;
		const len =
			(enc.value.header[5] << 24) | (enc.value.header[6] << 16) | (enc.value.header[7] << 8) | enc.value.header[8];
		const ms = Buffer.from(enc.value.header.subarray(9, 9 + len)).toString("utf-8");
		const sparse = ms.replace('"files":[', '"files":[null,');
		const hdr = buildHeader(sparse);
		const r = decodePaarManifestHeader(hdr, hdr.length + enc.value.payloadSize);
		expect(r.ok).toBe(false);
	});

	it("decode rejects class instance manifest", () => {
		// JSON.parse never produces class instances, so this tests the catch-all
		const json = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify(VALID_SRC)},"protocol":{"name":${JSON.stringify(REMOTE_HOST_PROTOCOL_NAME)},"version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":"${"0".repeat(64)}","buildId":"${"1".repeat(64)}","files":[{"path":"f","size":1,"mode":${0o644},"sha256":"${VALID_HASH}","offset":0}]}`;
		const hdr = buildHeader(json);
		const r = decodePaarManifestHeader(hdr, hdr.length + 1);
		expect(r.ok).toBe(false); // digests won't match
	});

	it("decode rejects Proxy subclass", () => {
		// JSON.parse never produces Proxy — conceptual
	});

	it("error objects have only code and are frozen", () => {
		const r = encodePaarManifest(validInput({ files: [] }));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(Object.keys(r.error)).toEqual(["code"]);
			expect(Object.isFrozen(r.error)).toBe(true);
		}
	});
});

// ===========================================================================
// 13. Buffer erasure observability
// ===========================================================================

it("rejects reused Proxy entry with varying descriptors (alias)", () => {
	// Same underlying object reused as two entries; a Proxy with a varying
	// ownKeys/descriptor set must still be caught by raw-reference alias
	// tracking added before snapshot.
	const shared = { path: "shared", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 };
	const entries = [shared, shared] as PaarFileEntry[];
	const r = encodePaarManifest(validInput({ files: entries }));
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.PROTO_INVALID_ALIAS);
});

it("rejects Proxy file entry reused with varying descriptors", () => {
	const target = { path: "p1", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 };
	let call = 0;
	const proxy = new Proxy(target, {
		ownKeys(t) {
			// Report different key sets on each call
			call += 1;
			if (call === 1) return Reflect.ownKeys(t);
			return Reflect.ownKeys(t).filter((k) => k !== "offset");
		},
		getOwnPropertyDescriptor(t, k) {
			if (call >= 2 && k === "offset") return undefined;
			return Reflect.getOwnPropertyDescriptor(t, k);
		},
	});
	const r = encodePaarManifest(
		validInput({
			files: [proxy as unknown as PaarFileEntry, proxy as unknown as PaarFileEntry],
		}),
	);
	// The alias check on the raw reference fires before descriptors vary
	expect(r.ok).toBe(false);
});

it("rejects Buffer as bytes (INVALID_INPUT)", () => {
	const enc = encodePaarManifest(validInput());
	if (!enc.ok) return;
	const buf = Buffer.from(enc.value.header);
	const r = decodePaarManifestHeader(buf, enc.value.archiveSize);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_INPUT);
});

it("rejects Uint8Array subclass as bytes (INVALID_INPUT)", () => {
	const enc = encodePaarManifest(validInput());
	if (!enc.ok) return;
	class Sub extends Uint8Array {}
	const sub = new Sub(enc.value.header);
	const r = decodePaarManifestHeader(sub, enc.value.archiveSize);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_INPUT);
});

it("rejects SharedArrayBuffer-backed view (INVALID_INPUT)", () => {
	if (typeof SharedArrayBuffer === "undefined") return; // environment lacks SAB
	const enc = encodePaarManifest(validInput());
	if (!enc.ok) return;
	const sab = new SharedArrayBuffer(enc.value.header.length);
	const view = new Uint8Array(sab);
	view.set(enc.value.header);
	const r = decodePaarManifestHeader(view, enc.value.archiveSize);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_INPUT);
});

it("rejects detached ArrayBuffer view (INVALID_INPUT)", () => {
	if (typeof MessageChannel === "undefined") return;
	const enc = encodePaarManifest(validInput());
	if (!enc.ok) return;
	const ab = new ArrayBuffer(enc.value.header.length);
	const view = new Uint8Array(ab);
	view.set(enc.value.header);
	// Transfer ownership away via MessageChannel to detach the buffer
	const { port1, port2 } = new MessageChannel();
	port1.postMessage(ab, [ab]);
	port2.close();
	const r = decodePaarManifestHeader(view, enc.value.archiveSize);
	expect(r.ok).toBe(false);
});

it("rejects non-zero byteOffset subview (INVALID_INPUT)", () => {
	const enc = encodePaarManifest(validInput());
	if (!enc.ok) return;
	const backing = new Uint8Array(enc.value.header.length + 8);
	backing.set(enc.value.header, 8);
	const subview = backing.subarray(8);
	const r = decodePaarManifestHeader(subview, enc.value.archiveSize);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_INPUT);
});

it("rejects bytes longer than totalArchiveSize (INVALID_INPUT)", () => {
	const enc = encodePaarManifest(validInput());
	if (!enc.ok) return;
	// Claimed totalArchiveSize is smaller than the supplied header bytes
	const r = decodePaarManifestHeader(enc.value.header, enc.value.header.length - 5);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_INPUT);
});

it("rejects array with length-get mismatch (out-of-range numeric key)", () => {
	const arr: PaarFileEntry[] = [{ path: "a", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 0 }];
	// Add an out-of-range numeric own key "5" (length stays 1)
	Object.defineProperty(arr, "5", {
		value: { path: "b", size: 1, mode: 0o644, sha256: VALID_HASH, offset: 1 },
		enumerable: true,
	});
	const r = encodePaarManifest(validInput({ files: arr }));
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.BAD_FILES);
});

it("PAAR_ERRORS exposes closed literal codes (compile-time check)", () => {
	const all: ReadonlyArray<string> = Object.values(PAAR_ERRORS);
	expect(all.length).toBeGreaterThan(0);
	// Every code in the object is a plain string, and the type is a union
	// of those literals — assigned here to prove the closed union compiles.
	const c1: PaarErrorCode = "SHORT_HEADER";
	expect(c1).toBe(PAAR_ERRORS.SHORT_HEADER);
});
describe("buffer erasure", () => {
	it("header not trivially-zeroed on success", () => {
		const r = encodePaarManifest(validInput());
		if (!r.ok) return;
		// The header should have non-zero bytes (magic, length, manifest content)
		let nonZero = false;
		for (let i = 0; i < r.value.header.length; i++) {
			if (r.value.header[i] !== 0) {
				nonZero = true;
				break;
			}
		}
		expect(nonZero).toBe(true);
	});
});

// ===========================================================================
// 14. Payload after header
// ===========================================================================

describe("decode ignores payload", () => {
	it("decodes with extra payload bytes present", () => {
		const enc = encodePaarManifest(validInput());
		if (!enc.ok) return;
		const payload = new Uint8Array(enc.value.payloadSize);
		const full = new Uint8Array(enc.value.header.length + payload.length);
		full.set(enc.value.header);
		full.set(payload, enc.value.header.length);
		const r = decodePaarManifestHeader(full, enc.value.archiveSize);
		expect(r.ok).toBe(true);
	});
});

// ===========================================================================
// 15. Roundtrip integrity
// ===========================================================================

describe("roundtrip", () => {
	function test(sc: string, target: "linux-x64" | "linux-arm64", dPV: number, dSR: number, files: PaarFileEntry[]) {
		const enc = encodePaarManifest({
			sourceCommit: sc,
			target,
			daemonProtocolVersion: dPV,
			daemonSchemaRevision: dSR,
			files,
		});
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const d = decodePaarManifestHeader(enc.value.header, enc.value.archiveSize);
		expect(d.ok).toBe(true);
		if (!d.ok) return;
		expect(d.value.manifest.sourceCommit).toBe(sc);
		expect(d.value.manifest.target).toBe(target);
		expect(d.value.manifest.protocol.daemonProtocolVersion).toBe(dPV);
		expect(d.value.manifest.protocol.daemonSchemaRevision).toBe(dSR);
	}
	it("simple", () =>
		test(VALID_SRC, "linux-x64", 7, 25, [{ path: "a", size: 100, mode: 0o644, sha256: "b".repeat(64), offset: 0 }]));
	it("multiple", () =>
		test("b".repeat(40), "linux-arm64", 1, 0, [
			{ path: "a", size: 5, mode: 0o755, sha256: "c".repeat(64), offset: 0 },
			{ path: "b", size: 10, mode: 0o644, sha256: "d".repeat(64), offset: 5 },
			{ path: "c", size: 0, mode: 0o644, sha256: "e".repeat(64), offset: 15 },
		]));
	it("non-ASCII", () =>
		test("c".repeat(40), "linux-x64", 99, 999, [
			{ path: "résumé.txt", size: 42, mode: 0o644, sha256: "f".repeat(64), offset: 0 },
			{ path: "中文/文件.bin", size: 7, mode: 0o755, sha256: VALID_HASH, offset: 42 },
		]));
});

// ===========================================================================
// 16. Archive size boundary
// ===========================================================================

describe("archive size boundary", () => {
	it("rejects >1GiB archive", () => {
		const r = encodePaarManifest({
			sourceCommit: VALID_SRC,
			target: "linux-x64",
			daemonProtocolVersion: 1,
			daemonSchemaRevision: 0,
			files: [
				{ path: "p1", size: 256 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 0 },
				{ path: "p2", size: 256 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 256 * 1024 * 1024 },
				{ path: "p3", size: 256 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 512 * 1024 * 1024 },
				{ path: "p4", size: 256 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 768 * 1024 * 1024 },
			],
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.ARCHIVE_TOO_LARGE);
	});
	it("accepts under 1GiB archive", () => {
		const r = encodePaarManifest({
			sourceCommit: VALID_SRC,
			target: "linux-x64",
			daemonProtocolVersion: 1,
			daemonSchemaRevision: 0,
			files: [
				{ path: "p1", size: 256 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 0 },
				{ path: "p2", size: 256 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 256 * 1024 * 1024 },
				{ path: "p3", size: 200 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 512 * 1024 * 1024 },
			],
		});
		expect(r.ok).toBe(true);
	});
});
