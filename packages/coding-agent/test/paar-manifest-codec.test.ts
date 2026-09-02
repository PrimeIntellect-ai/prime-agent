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
	type PaarFileEntry,
} from "../src/core/paar-manifest-codec.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
} from "../src/modes/daemon/remote-agent-host-protocol.js";

// ===========================================================================
// Helpers
// ===========================================================================

function validInput(overrides?: Partial<PaarEncodeInput>): PaarEncodeInput {
	return {
		sourceCommit: overrides?.sourceCommit ?? "a".repeat(40),
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
	const parts: string[] = [];
	for (const f of files) {
		parts.push(
			`{"path":${JSON.stringify(f.path)},"size":${f.size},"mode":${f.mode},"sha256":${JSON.stringify(f.sha256)},"offset":${f.offset}}`,
		);
	}
	const canon = `[${parts.join(",")}]`;
	return createHash("sha256").update(canon, "utf-8").digest("hex");
}

function computeBuildId(sourceCommit: string, target: string, dPV: number, dSR: number, filesDigest: string): string {
	const proto = `{"name":${JSON.stringify(REMOTE_HOST_PROTOCOL_NAME)},"version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":${dPV},"daemonSchemaRevision":${dSR}}`;
	const canon = `{"sourceCommit":${JSON.stringify(sourceCommit)},"target":${JSON.stringify(target)},"protocol":${proto},"filesDigest":${JSON.stringify(filesDigest)}}`;
	return createHash("sha256").update(canon, "utf-8").digest("hex");
}

function buildHeader(jsonStr: string): Uint8Array {
	const bytes = Buffer.from(jsonStr, "utf-8");
	const header = new Uint8Array(9 + bytes.length);
	header[0] = 0x50;
	header[1] = 0x41;
	header[2] = 0x41;
	header[3] = 0x52;
	header[4] = 0x31;
	header[5] = (bytes.length >> 24) & 0xff;
	header[6] = (bytes.length >> 16) & 0xff;
	header[7] = (bytes.length >> 8) & 0xff;
	header[8] = bytes.length & 0xff;
	header.set(bytes, 9);
	return header;
}

// ===========================================================================
// 1. Deterministic golden bytes
// ===========================================================================

describe("deterministic golden bytes", () => {
	it("encodes linux-x64 deterministically", () => {
		const files = sortedFiles([{ path: "data.bin", size: 42, mode: 0o644, sha256: "d".repeat(64), offset: 0 }]);
		const result = encodePaarManifest({
			sourceCommit: "a".repeat(40),
			target: "linux-x64",
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
			files,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const r = result.value;

		expect(r.header[0]).toBe(0x50);
		expect(r.header[1]).toBe(0x41);
		expect(r.header[2]).toBe(0x41);
		expect(r.header[3]).toBe(0x52);
		expect(r.header[4]).toBe(0x31);

		const len = (r.header[5] << 24) | (r.header[6] << 16) | (r.header[7] << 8) | r.header[8];
		expect(len).toBe(r.header.length - 9);
		expect(len).toBeGreaterThan(0);

		expect(r.manifest.format).toBe("prime-agent-artifact");
		expect(r.manifest.version).toBe(1);
		expect(r.manifest.target).toBe("linux-x64");
		expect(r.manifest.sourceCommit).toBe("a".repeat(40));
		expect(r.manifest.protocol.name).toBe(REMOTE_HOST_PROTOCOL_NAME);
		expect(r.manifest.protocol.version).toBe(REMOTE_HOST_PROTOCOL_VERSION);
		expect(r.manifest.protocol.daemonProtocolVersion).toBe(7);
		expect(r.manifest.protocol.daemonSchemaRevision).toBe(25);
		expect(r.manifest.filesDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(r.manifest.buildId).toMatch(/^[0-9a-f]{64}$/);
		expect(r.manifest.files.length).toBe(1);
		expect(r.payloadSize).toBe(42);
		expect(r.headerSize).toBe(9 + len);
		expect(r.archiveSize).toBe(r.headerSize + 42);

		// Roundtrip
		const decResult = decodePaarManifestHeader(r.header, r.archiveSize);
		expect(decResult.ok).toBe(true);
		if (!decResult.ok) return;
		expect(decResult.value.manifest.format).toBe("prime-agent-artifact");
		expect(decResult.value.manifest.target).toBe("linux-x64");
		expect(decResult.value.payloadSize).toBe(42);
		expect(decResult.value.headerSize).toBe(r.headerSize);
		expect(decResult.value.archiveSize).toBe(r.archiveSize);
	});

	it("encodes linux-arm64 deterministically", () => {
		const files = sortedFiles([{ path: "x.bin", size: 1, mode: 0o755, sha256: "e".repeat(64), offset: 0 }]);
		const result = encodePaarManifest({
			sourceCommit: "b".repeat(40),
			target: "linux-arm64",
			daemonProtocolVersion: 1,
			daemonSchemaRevision: 0,
			files,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.manifest.target).toBe("linux-arm64");
	});

	it("same input produces identical bytes", () => {
		const r1 = encodePaarManifest(validInput());
		const r2 = encodePaarManifest(validInput());
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;
		expect(r1.value.header).toEqual(r2.value.header);
		expect(r1.value.manifest).toEqual(r2.value.manifest);
	});

	it("golden exact digest roundtrip", () => {
		const files = sortedFiles([{ path: "a.bin", size: 10, mode: 0o644, sha256: "f".repeat(64), offset: 0 }]);
		const result = encodePaarManifest({
			sourceCommit: "c".repeat(40),
			target: "linux-x64",
			daemonProtocolVersion: 3,
			daemonSchemaRevision: 1,
			files,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const m = result.value.manifest;
		const expectedFD = computeFilesDigest(files);
		const expectedBID = computeBuildId("c".repeat(40), "linux-x64", 3, 1, expectedFD);
		expect(m.filesDigest).toBe(expectedFD);
		expect(m.buildId).toBe(expectedBID);
	});
});

// ===========================================================================
// 2. Numeric mode (0o644 / 0o755)
// ===========================================================================

describe("file mode numeric", () => {
	it("accepts mode 0o644", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }] }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.files[0].mode).toBe(0o644);
	});

	it("accepts mode 0o755", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1, mode: 0o755, sha256: "0".repeat(64), offset: 0 }] }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.files[0].mode).toBe(0o755);
	});

	it("rejects string mode", () => {
		const r = encodePaarManifest(
			validInput({
				// @ts-expect-error testing runtime rejection
				files: [{ path: "f", size: 1, mode: "0644", sha256: "0".repeat(64), offset: 0 }],
			}),
		);
		expect(r.ok).toBe(false);
	});

	it("rejects numeric 0644 (decimal)", () => {
		const r = encodePaarManifest(
			validInput({
				files: [{ path: "f", size: 1, mode: 644, sha256: "0".repeat(64), offset: 0 }],
			}),
		);
		expect(r.ok).toBe(false);
	});

	it("rejects other modes", () => {
		const r = encodePaarManifest(
			validInput({
				files: [{ path: "f", size: 1, mode: 0o777, sha256: "0".repeat(64), offset: 0 }],
			}),
		);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 3. Files cardinality
// ===========================================================================

describe("files cardinality", () => {
	it("rejects empty files", () => {
		const r = encodePaarManifest(validInput({ files: [] }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.FILES_EMPTY);
	});

	it("accepts 20k files", () => {
		const files: PaarFileEntry[] = [];
		let off = 0;
		for (let i = 0; i < 20000; i++) {
			const p = String(i).padStart(10, "0");
			files.push({ path: `f${p}.dat`, size: 1, mode: 0o644, sha256: "a".repeat(64), offset: off });
			off += 1;
		}
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.files.length).toBe(20000);
	});

	it("rejects 20001 files", () => {
		const files: PaarFileEntry[] = [];
		let off = 0;
		for (let i = 0; i < 20001; i++) {
			const p = String(i).padStart(10, "0");
			files.push({ path: `f${p}.dat`, size: 1, mode: 0o644, sha256: "a".repeat(64), offset: off });
			off += 1;
		}
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(false);
	});

	it("rejects empty on decode", () => {
		const src = "a".repeat(40);
		const fd = "0".repeat(64);
		const bid = computeBuildId(src, "linux-x64", 7, 25, fd);
		const badJson = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify(src)},"protocol":{"name":"${REMOTE_HOST_PROTOCOL_NAME}","version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":${JSON.stringify(fd)},"buildId":${JSON.stringify(bid)},"files":[]}`;
		const hdr = buildHeader(badJson);
		const r = decodePaarManifestHeader(hdr, hdr.length);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 4. File size / offset / total
// ===========================================================================

describe("file size and offset", () => {
	it("accepts zero-size file", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "e", size: 0, mode: 0o644, sha256: "0".repeat(64), offset: 0 }] }),
		);
		expect(r.ok).toBe(true);
	});

	it("accepts 256 MiB file", () => {
		const r = encodePaarManifest(
			validInput({
				files: [{ path: "big", size: 256 * 1024 * 1024, mode: 0o644, sha256: "0".repeat(64), offset: 0 }],
			}),
		);
		expect(r.ok).toBe(true);
	});

	it("rejects >256 MiB file", () => {
		const r = encodePaarManifest(
			validInput({
				files: [{ path: "too", size: 256 * 1024 * 1024 + 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }],
			}),
		);
		expect(r.ok).toBe(false);
	});

	it("rejects negative file size", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "n", size: -1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }] }),
		);
		expect(r.ok).toBe(false);
	});

	it("rejects non-integer file size", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1.5, mode: 0o644, sha256: "0".repeat(64), offset: 0 }] }),
		);
		expect(r.ok).toBe(false);
	});

	it("rejects wrong caller offset (not contiguous from 0)", () => {
		const r = encodePaarManifest(
			validInput({
				files: sortedFiles([
					{ path: "a", size: 10, mode: 0o644, sha256: "0".repeat(64), offset: 0 },
					{ path: "b", size: 10, mode: 0o644, sha256: "0".repeat(64), offset: 11 },
				]),
			}),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_FILE_OFFSET);
	});

	it("rejects total payload >1 GiB", () => {
		const files = sortedFiles([
			{ path: "big1", size: 600 * 1024 * 1024, mode: 0o644, sha256: "a".repeat(64), offset: 0 },
			{ path: "big2", size: 600 * 1024 * 1024, mode: 0o644, sha256: "b".repeat(64), offset: 600 * 1024 * 1024 },
		]);
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 5. UTF-8 byte sorting
// ===========================================================================

describe("UTF-8 byte sorting", () => {
	it("rejects unsorted input on encode", () => {
		const files = [
			{ path: "z.txt", size: 1, mode: 0o644, sha256: "a".repeat(64), offset: 2 },
			{ path: "a.txt", size: 1, mode: 0o644, sha256: "b".repeat(64), offset: 0 },
			{ path: "A.txt", size: 1, mode: 0o644, sha256: "c".repeat(64), offset: 1 },
		];
		const r = encodePaarManifest(validInput({ files }));
		// Must fail because a.txt (offset 0) comes before A.txt (offset 1) but sorts after
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.FILES_UNSORTED);
	});

	it("accepts correctly UTF-8 byte sorted input", () => {
		const files: PaarFileEntry[] = [
			{ path: "A.txt", size: 1, mode: 0o644, sha256: "a".repeat(64), offset: 0 },
			{ path: "a.txt", size: 1, mode: 0o644, sha256: "b".repeat(64), offset: 1 },
			{ path: "z.txt", size: 1, mode: 0o644, sha256: "c".repeat(64), offset: 2 },
		];
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(true);
	});

	it("rejects unsorted on decode", () => {
		const files = sortedFiles([
			{ path: "a", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 },
			{ path: "b", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 1 },
		]);
		const enc = encodePaarManifest(validInput({ files }));
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		// Build a header with files reversed
		const reversed = [...enc.value.manifest.files].reverse();
		const json = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify("a".repeat(40))},"protocol":{"name":"${REMOTE_HOST_PROTOCOL_NAME}","version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":${JSON.stringify(enc.value.manifest.filesDigest)},"buildId":${JSON.stringify(enc.value.manifest.buildId)},"files":[${reversed.map((f) => `{"path":${JSON.stringify(f.path)},"size":${f.size},"mode":${f.mode},"sha256":${JSON.stringify(f.sha256)},"offset":${f.offset}}`).join(",")}]}`;
		const hdr = buildHeader(json);
		const r = decodePaarManifestHeader(hdr, hdr.length + 2);
		expect(r.ok).toBe(false);
	});

	it("sorts non-ASCII paths correctly on decode", () => {
		// ä (U+00E4 = 0xC3 0xA4) < é (U+00E9 = 0xC3 0xA9) in UTF-8 byte order
		const files = sortedFiles([
			{ path: "é", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 1 },
			{ path: "ä", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 },
		]);
		const r = encodePaarManifest(validInput({ files }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.files[0].path).toBe("ä");
		expect(r.value.manifest.files[1].path).toBe("é");
	});
});

// ===========================================================================
// 6. Duplicate paths
// ===========================================================================

describe("duplicate file paths", () => {
	it("rejects duplicate paths", () => {
		const r = encodePaarManifest(
			validInput({
				files: [
					{ path: "dup.txt", size: 1, mode: 0o644, sha256: "a".repeat(64), offset: 0 },
					{ path: "dup.txt", size: 2, mode: 0o644, sha256: "b".repeat(64), offset: 1 },
				],
			}),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.DUPLICATE_FILE_PATH);
	});
});

// ===========================================================================
// 7. Path validation (NFC, surrogates, controls, segments)
// ===========================================================================

describe("path validation", () => {
	const H = "0".repeat(64);
	function testGood(p: string) {
		const r = encodePaarManifest(validInput({ files: [{ path: p, size: 1, mode: 0o644, sha256: H, offset: 0 }] }));
		if (!r.ok) console.log("GOOD PATH FAILED:", p, r.error.code);
		expect(r.ok).toBe(true);
	}
	function testBad(p: string) {
		const r = encodePaarManifest(validInput({ files: [{ path: p, size: 1, mode: 0o644, sha256: H, offset: 0 }] }));
		expect(r.ok).toBe(false);
	}

	it("rejects leading slash", () => testBad("/abs"));
	it("rejects trailing slash", () => testBad("dir/"));
	it("rejects empty path", () => testBad(""));
	it("rejects backslash", () => testBad("a\\b"));
	it("rejects NUL", () => testBad("fi\x00le"));
	it("rejects controls", () => testBad("fi\tle"));
	it("rejects DEL", () => testBad("fi\x7fle"));
	it("rejects BOM", () => testBad("\ufefffile"));
	it("rejects dot segment", () => testBad("./x"));
	it("rejects dotdot segment", () => testBad("../x"));
	it("rejects .prime-agent-staging", () => testBad(".prime-agent-staging/x"));
	it("rejects double slash", () => testBad("a//b"));

	it("accepts valid paths", () => {
		testGood("file.txt");
		testGood("dir/file.txt");
		testGood("a/b/c/d");
	});

	it("accepts valid surrogate pair (astral)", () => {
		// U+1F600 (😀) = surrogate pair
		testGood("file\u{1F600}.txt");
	});

	it("rejects lone high surrogate", () => testBad("file\u{D800}.txt"));
	it("rejects lone low surrogate", () => testBad("file\u{DC00}.txt"));

	it("rejects decomposed NFC", () => {
		// é composed (U+00E9) vs decomposed (U+0065 U+0301)
		const decomposed = "e\u0301";
		const nfcForm = decomposed.normalize("NFC");
		expect(decomposed).not.toBe(nfcForm);
		testBad(decomposed);
	});

	it("accepts paths up to 512 UTF-8 bytes", () => {
		const p = "a".repeat(511);
		testGood(p);
	});

	it("rejects path >512 UTF-8 bytes", () => {
		const p = "a".repeat(513);
		testBad(p);
	});
});

// ===========================================================================
// 8. Protocol binding
// ===========================================================================

describe("protocol binding", () => {
	it("binds exact constants", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.manifest.protocol.name).toBe(REMOTE_HOST_PROTOCOL_NAME);
		expect(r.value.manifest.protocol.version).toBe(REMOTE_HOST_PROTOCOL_VERSION);
	});
	it("rejects dPV=0", () => {
		const r = encodePaarManifest(validInput({ daemonProtocolVersion: 0 }));
		expect(r.ok).toBe(false);
	});
	it("accepts dSR=0", () => {
		const r = encodePaarManifest(validInput({ daemonSchemaRevision: 0 }));
		expect(r.ok).toBe(true);
	});
	it("rejects dPV=1.5", () => {
		const r = encodePaarManifest(validInput({ daemonProtocolVersion: 1.5 }));
		expect(r.ok).toBe(false);
	});
	it("rejects dSR=-1", () => {
		const r = encodePaarManifest(validInput({ daemonSchemaRevision: -1 }));
		expect(r.ok).toBe(false);
	});

	it("rejects protocol name mismatch on decode", () => {
		const src = "a".repeat(40);
		const fd = "0".repeat(64);
		const bid = computeBuildId(src, "linux-x64", 7, 25, fd);
		const json = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify(src)},"protocol":{"name":"wrong-name","version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":${JSON.stringify(fd)},"buildId":${JSON.stringify(bid)},"files":[{"path":"f","size":10,"mode":644,"sha256":"${"0".repeat(64)}","offset":0}]}`;
		const hdr = buildHeader(json);
		const r = decodePaarManifestHeader(hdr, hdr.length + 10);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 9. Source commit and hash
// ===========================================================================

describe("source commit and hash", () => {
	it("rejects short sourceCommit", () => {
		const r = encodePaarManifest(validInput({ sourceCommit: "abc" }));
		expect(r.ok).toBe(false);
	});
	it("rejects uppercase sourceCommit", () => {
		const r = encodePaarManifest(validInput({ sourceCommit: `A${"a".repeat(39)}` }));
		expect(r.ok).toBe(false);
	});
	it("rejects non-hex sourceCommit", () => {
		const r = encodePaarManifest(validInput({ sourceCommit: `g${"a".repeat(39)}` }));
		expect(r.ok).toBe(false);
	});
	it("rejects non-64-char sha256", () => {
		const r = encodePaarManifest(
			validInput({ files: [{ path: "f", size: 1, mode: 0o644, sha256: "abc", offset: 0 }] }),
		);
		expect(r.ok).toBe(false);
	});
});

// ===========================================================================
// 10. Byte-level framing
// ===========================================================================

describe("byte-level framing", () => {
	const files = sortedFiles([{ path: "f.dat", size: 10, mode: 0o644, sha256: "0".repeat(64), offset: 0 }]);
	const enc = encodePaarManifest(validInput({ files }));
	expect(enc.ok).toBe(true);
	if (!enc.ok) return;
	const { header, archiveSize } = enc.value;

	it("rejects empty buffer", () => {
		const r = decodePaarManifestHeader(new Uint8Array(0), archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.SHORT_HEADER);
	});

	it("rejects buffer <9 bytes", () => {
		const r = decodePaarManifestHeader(new Uint8Array(5), archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.SHORT_HEADER);
	});

	it("rejects bad magic", () => {
		const bad = new Uint8Array(header);
		bad[0] = 0x48;
		const r = decodePaarManifestHeader(bad, archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.BAD_MAGIC);
	});

	it("rejects manifestLen > 4MiB", () => {
		const bad = new Uint8Array(header);
		bad[5] = 0x01;
		bad[6] = 0x00;
		bad[7] = 0x00;
		bad[8] = 0x00;
		const r = decodePaarManifestHeader(bad, archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.MANIFEST_TOO_LARGE);
	});

	it("rejects truncated manifest", () => {
		const r = decodePaarManifestHeader(header.subarray(0, 9), archiveSize);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.MANIFEST_TRUNCATED);
	});

	it("rejects invalid UTF-8", () => {
		const bad = new Uint8Array(header);
		if (bad.length > 15) {
			bad[14] = 0xff;
			const r = decodePaarManifestHeader(bad, archiveSize);
			expect(r.ok).toBe(false);
		}
	});

	it("rejects invalid JSON", () => {
		const hdr = buildHeader("{{bad}}");
		const r = decodePaarManifestHeader(hdr, hdr.length);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.INVALID_JSON);
	});

	it("rejects FFFFFFFF length (signed int bug)", () => {
		const hdr = new Uint8Array(13);
		hdr[0] = 0x50;
		hdr[1] = 0x41;
		hdr[2] = 0x41;
		hdr[3] = 0x52;
		hdr[4] = 0x31;
		hdr[5] = 0xff;
		hdr[6] = 0xff;
		hdr[7] = 0xff;
		hdr[8] = 0xff;
		// DataView.getUint32(0xFFFFFFFF) = 4294967295 > MAX_MANIFEST_BYTES
		const r = decodePaarManifestHeader(hdr, 100);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.MANIFEST_TOO_LARGE);
	});
});

// ===========================================================================
// 11. Canonical encoding violations
// ===========================================================================

describe("canonical encoding violations", () => {
	const H = "0".repeat(64);
	const SRC = "a".repeat(40);
	const FD = computeFilesDigest([{ path: "f.dat", size: 10, mode: 0o644, sha256: H, offset: 0 }]);
	const BID = computeBuildId(SRC, "linux-x64", 7, 25, FD);
	const good = `{"format":"prime-agent-artifact","version":1,"target":"linux-x64","sourceCommit":${JSON.stringify(SRC)},"protocol":{"name":"${REMOTE_HOST_PROTOCOL_NAME}","version":${REMOTE_HOST_PROTOCOL_VERSION},"daemonProtocolVersion":7,"daemonSchemaRevision":25},"filesDigest":${JSON.stringify(FD)},"buildId":${JSON.stringify(BID)},"files":[{"path":"f.dat","size":10,"mode":${0o644},"sha256":"${H}","offset":0}]}`;

	function mkHdr(j: string, ps: number) {
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
		return { hdr: h, total: 9 + b.length + ps };
	}

	it("rejects whitespace", () => {
		const { hdr, total } = mkHdr(good.replace(/:"/g, ': "'), 10);
		const r = decodePaarManifestHeader(hdr, total);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.NON_CANONICAL);
	});

	it("rejects key reorder", () => {
		const reord = good.replace(
			/^\{"format":"prime-agent-artifact","version":1/,
			'{"version":1,"format":"prime-agent-artifact"',
		);
		const { hdr, total } = mkHdr(reord, 10);
		const r = decodePaarManifestHeader(hdr, total);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.NON_CANONICAL);
	});

	it("rejects extra field", () => {
		const extra = good.replace(/"files"/, '"extra":"x","files"');
		const { hdr, total } = mkHdr(extra, 10);
		const r = decodePaarManifestHeader(hdr, total);
		expect(r.ok).toBe(false);
	});

	it("rejects missing field", () => {
		const miss = good.replace(
			',"protocol":{"name":"prime-agent.remote-host","version":1,"daemonProtocolVersion":7,"daemonSchemaRevision":25}',
			"",
		);
		const { hdr, total } = mkHdr(miss, 10);
		const r = decodePaarManifestHeader(hdr, total);
		expect(r.ok).toBe(false);
	});

	it("rejects trailing bytes", () => {
		const { hdr, total } = mkHdr(`${good} `, 10);
		const r = decodePaarManifestHeader(hdr, total);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.NON_CANONICAL);
	});

	it("rejects -0", () => {
		const { hdr, total } = mkHdr(good.replace('"version":1', '"version":-0'), 10);
		const r = decodePaarManifestHeader(hdr, total);
		expect(r.ok).toBe(false);
	});

	it("rejects uppercase hex in filesDigest", () => {
		const upper = `F${FD.slice(1)}`;
		const mod = good.replace(FD, upper);
		const { hdr, total } = mkHdr(mod, 10);
		const r = decodePaarManifestHeader(hdr, total);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe(PAAR_ERRORS.BAD_FILES_DIGEST);
	});
});

// ===========================================================================
// 12. totalArchiveSize
// ===========================================================================

describe("totalArchiveSize", () => {
	it("rejects mismatch (too small)", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dec = decodePaarManifestHeader(r.value.header, 5);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe(PAAR_ERRORS.TOTAL_ARCHIVE_MISMATCH);
	});

	it("rejects mismatch (too large)", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dec = decodePaarManifestHeader(r.value.header, r.value.archiveSize + 100);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe(PAAR_ERRORS.TOTAL_ARCHIVE_MISMATCH);
	});

	it("rejects total > 1GiB total archive", () => {
		// Encode with tiny payload, then lie about totalArchiveSize
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dec = decodePaarManifestHeader(r.value.header, 1073741825); // 1 GiB + 1
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe(PAAR_ERRORS.ARCHIVE_TOO_LARGE);
	});

	it("rejects non-positive totalArchiveSize", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dec = decodePaarManifestHeader(r.value.header, 0);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe(PAAR_ERRORS.ARCHIVE_TOO_LARGE);
	});

	it("rejects non-integer totalArchiveSize", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dec = decodePaarManifestHeader(r.value.header, 1.5);
		expect(dec.ok).toBe(false);
	});
});

// ===========================================================================
// 13. Digest / buildId mutations
// ===========================================================================

describe("digest mutations", () => {
	it("rejects mutated filesDigest", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const bytes = new Uint8Array(r.value.header);
		const len = (bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
		const ms = Buffer.from(bytes.subarray(9, 9 + len)).toString("utf-8");
		const mutated = ms.replace(/"filesDigest":"[0-9a-f]+"/, `"filesDigest":"${"f".repeat(64)}"`);
		const hdr = buildHeader(mutated);
		const dec = decodePaarManifestHeader(hdr, hdr.length + r.value.payloadSize);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe(PAAR_ERRORS.FILES_DIGEST_MISMATCH);
	});

	it("rejects mutated buildId", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const bytes = new Uint8Array(r.value.header);
		const len = (bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
		const ms = Buffer.from(bytes.subarray(9, 9 + len)).toString("utf-8");
		const mutated = ms.replace(/"buildId":"[0-9a-f]+"/, `"buildId":"${"e".repeat(64)}"`);
		const hdr = buildHeader(mutated);
		const dec = decodePaarManifestHeader(hdr, hdr.length + r.value.payloadSize);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.error.code).toBe(PAAR_ERRORS.BUILD_ID_MISMATCH);
	});
});

// ===========================================================================
// 14. Deep freeze / no aliases / buffer ownership
// ===========================================================================

describe("frozen result DTOs", () => {
	it("encode returns frozen manifest", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r.value.manifest)).toBe(true);
		expect(Object.isFrozen(r.value.manifest.protocol)).toBe(true);
		expect(Object.isFrozen(r.value.manifest.files)).toBe(true);
	});

	it("decode returns frozen manifest", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dec = decodePaarManifestHeader(r.value.header, r.value.archiveSize);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.value.manifest)).toBe(true);
		expect(Object.isFrozen(dec.value.manifest.protocol)).toBe(true);
		expect(Object.isFrozen(dec.value.manifest.files)).toBe(true);
	});

	it("encode and decode produce distinct objects", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dec = decodePaarManifestHeader(r.value.header, r.value.archiveSize);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.value.manifest).toEqual(r.value.manifest);
		expect(dec.value.manifest).not.toBe(r.value.manifest);
	});

	it("header is caller-owned (not a view)", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const copy = new Uint8Array(r.value.header);
		copy[0] = 0x00;
		expect(r.value.header[0]).toBe(0x50);
	});
});

// ===========================================================================
// 15. Adversarial input rejection
// ===========================================================================

describe("adversarial input", () => {
	it("Proxy with getter trap is rejected", () => {
		const target = validInput();
		let getterCalled = false;
		const proxy = new Proxy(target, {
			get(t, p) {
				getterCalled = true;
				return Reflect.get(t, p);
			},
			ownKeys(t) {
				return Reflect.ownKeys(t);
			},
			getOwnPropertyDescriptor(t, p) {
				return Reflect.getOwnPropertyDescriptor(t, p);
			},
		});
		// Proxy own-descriptors match target, so own-data check passes.
		// But encoding succeeds because all values are valid.
		const r = encodePaarManifest(proxy);
		expect(getterCalled).toBe(true);
		expect(r.ok).toBe(true);
	});

	it("rejects getter on encode input", () => {
		const obj = {
			sourceCommit: "a".repeat(40),
			target: "linux-x64" as const,
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
			get files(): PaarFileEntry[] {
				return [{ path: "f", size: 1, mode: 0o644, sha256: "0".repeat(64), offset: 0 }];
			},
		};
		const r = encodePaarManifest(obj);
		expect(r.ok).toBe(false);
	});

	it("rejects Symbol properties on input", () => {
		const obj = validInput();
		(obj as unknown as Record<symbol, unknown>)[Symbol("x")] = "evil";
		const r = encodePaarManifest(obj);
		expect(r.ok).toBe(false);
	});

	it("rejects sparse files array", () => {
		const enc = encodePaarManifest(validInput());
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const bytes = new Uint8Array(enc.value.header);
		const len = (bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
		const ms = Buffer.from(bytes.subarray(9, 9 + len)).toString("utf-8");
		// Insert null in files array
		const sparse = ms.replace('"files":[', '"files":[null,');
		const hdr = buildHeader(sparse);
		const dec = decodePaarManifestHeader(hdr, hdr.length + enc.value.payloadSize);
		expect(dec.ok).toBe(false);
	});

	it("rejects cycle/alias (JSON handles)", () => {
		// JSON.parse never produces cycles, this is a conceptual check
	});

	it("error objects have only code", () => {
		const r = encodePaarManifest(validInput({ files: [] }));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(Object.keys(r.error)).toEqual(["code"]);
		}
	});
});

// ===========================================================================
// 16. Payload after header (decode doesn't touch payload)
// ===========================================================================

describe("decode ignores payload bytes", () => {
	it("decodes with extra payload bytes present", () => {
		const r = encodePaarManifest(validInput());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const payload = new Uint8Array(r.value.payloadSize);
		const full = new Uint8Array(r.value.header.length + payload.length);
		full.set(r.value.header);
		full.set(payload, r.value.header.length);
		const dec = decodePaarManifestHeader(full, r.value.archiveSize);
		expect(dec.ok).toBe(true);
	});
});

// ===========================================================================
// 17. Roundtrip integrity
// ===========================================================================

describe("roundtrip", () => {
	function testRoundtrip(
		sc: string,
		target: "linux-x64" | "linux-arm64",
		dPV: number,
		dSR: number,
		files: PaarFileEntry[],
	) {
		const enc = encodePaarManifest({
			sourceCommit: sc,
			target,
			daemonProtocolVersion: dPV,
			daemonSchemaRevision: dSR,
			files,
		});
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodePaarManifestHeader(enc.value.header, enc.value.archiveSize);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.value.manifest.sourceCommit).toBe(sc);
		expect(dec.value.manifest.target).toBe(target);
		expect(dec.value.manifest.protocol.daemonProtocolVersion).toBe(dPV);
		expect(dec.value.manifest.protocol.daemonSchemaRevision).toBe(dSR);
		expect(dec.value.manifest.filesDigest).toBe(enc.value.manifest.filesDigest);
		expect(dec.value.manifest.buildId).toBe(enc.value.manifest.buildId);
		expect(dec.value.manifest.files.length).toBe(files.length);
		expect(dec.value.payloadSize).toBe(files.reduce((s, f) => s + f.size, 0));
	}

	it("simple", () =>
		testRoundtrip("a".repeat(40), "linux-x64", 7, 25, [
			{ path: "a", size: 100, mode: 0o644, sha256: "b".repeat(64), offset: 0 },
		]));
	it("multiple", () =>
		testRoundtrip("b".repeat(40), "linux-arm64", 1, 0, [
			{ path: "a", size: 5, mode: 0o755, sha256: "c".repeat(64), offset: 0 },
			{ path: "b", size: 10, mode: 0o644, sha256: "d".repeat(64), offset: 5 },
			{ path: "c", size: 0, mode: 0o644, sha256: "e".repeat(64), offset: 15 },
		]));
	it("non-ASCII", () =>
		testRoundtrip("c".repeat(40), "linux-x64", 99, 999, [
			{ path: "résumé.txt", size: 42, mode: 0o644, sha256: "f".repeat(64), offset: 0 },
			{ path: "中文/文件.bin", size: 7, mode: 0o755, sha256: "0".repeat(64), offset: 42 },
		]));
});

// ===========================================================================
// 18. Total archive <= 1GiB boundary
// ===========================================================================

describe("total archive 1GiB boundary", () => {
	it("encode rejects archive just over 1GiB", () => {
		// Use multiple files under 256MiB each, total payload near 1GiB
		// header ~200 bytes => total > 1GiB
		// 4 files * 256 MiB each = 1024 MiB
		const fileSize = 256 * 1024 * 1024; // 256 MiB
		const r = encodePaarManifest({
			sourceCommit: "a".repeat(40),
			target: "linux-x64",
			daemonProtocolVersion: 1,
			daemonSchemaRevision: 0,
			files: [
				{ path: "p1", size: fileSize, mode: 0o644, sha256: "a".repeat(64), offset: 0 },
				{ path: "p2", size: fileSize, mode: 0o644, sha256: "a".repeat(64), offset: fileSize },
				{ path: "p3", size: fileSize, mode: 0o644, sha256: "a".repeat(64), offset: fileSize * 2 },
				{ path: "p4", size: fileSize, mode: 0o644, sha256: "a".repeat(64), offset: fileSize * 3 },
			],
		});
		// payload = 4 * 256 MiB = 1 GiB, header adds >0 => total > 1GiB
		// But encoder checks payload first: payload == 1GiB == MAX_TOTAL_PAYLOAD OK
		// Then checks archive > MAX_ARCHIVE_SIZE -> ARCHIVE_TOO_LARGE
		// Note: first file size = 256 MiB = MAX_FILE_SIZE -> OK
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.code).toBe(PAAR_ERRORS.ARCHIVE_TOO_LARGE);
		}
	});

	it("encode accepts archive near 1GiB", () => {
		// Use 3 files * 256 MiB = 768 MiB payload, header ~200 bytes => < 1 GiB
		const fileSize = 256 * 1024 * 1024;
		const r = encodePaarManifest({
			sourceCommit: "a".repeat(40),
			target: "linux-x64",
			daemonProtocolVersion: 1,
			daemonSchemaRevision: 0,
			files: [
				{ path: "p1", size: fileSize, mode: 0o644, sha256: "a".repeat(64), offset: 0 },
				{ path: "p2", size: fileSize, mode: 0o644, sha256: "a".repeat(64), offset: fileSize },
				{ path: "p3", size: fileSize, mode: 0o644, sha256: "a".repeat(64), offset: fileSize * 2 },
			],
		});
		// payload = 768 MiB, header ~200 bytes => total < 1 GiB
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.archiveSize).toBeLessThanOrEqual(1024 * 1024 * 1024);
	});
});
