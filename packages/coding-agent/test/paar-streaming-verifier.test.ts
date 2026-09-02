import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodePaarManifest } from "../src/core/paar-manifest-codec.js";
import {
	type PaarArchiveIdentity,
	type PaarVerificationExpectation,
	verifyPaarArchive,
} from "../src/core/paar-streaming-verifier.js";

const SOURCE = "1".repeat(40);
const PROTOCOL = "prime-agent.remote-host";

function sha(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fixture(): { archive: Uint8Array; expectation: PaarVerificationExpectation } {
	const zero = new Uint8Array(0);
	const content = new TextEncoder().encode("sandbox-runtime-payload");
	const encoded = encodePaarManifest({
		daemonProtocolVersion: 7,
		daemonSchemaRevision: 3,
		files: [
			{ mode: 0o644, offset: 0, path: "empty", sha256: sha(zero), size: 0 },
			{ mode: 0o755, offset: 0, path: "runtime/node", sha256: sha(content), size: content.byteLength },
		],
		sourceCommit: SOURCE,
		target: "linux-x64",
	});
	if (!encoded.ok) throw new Error(encoded.error.code);
	const archive = new Uint8Array(encoded.value.archiveSize);
	archive.set(encoded.value.header);
	archive.set(content, encoded.value.headerSize);
	return {
		archive,
		expectation: Object.freeze({
			archiveSha256: sha(archive),
			archiveSize: archive.byteLength,
			buildId: encoded.value.manifest.buildId,
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 3,
			protocolName: PROTOCOL,
			protocolVersion: 1,
			sourceCommit: SOURCE,
			target: "linux-x64" as const,
		}),
	};
}

function identity(size: number, changes: Partial<PaarArchiveIdentity> = {}): PaarArchiveIdentity {
	return Object.freeze({
		ctimeNs: 11n,
		dev: 1n,
		gid: 2n,
		ino: 3n,
		mode: 0o100644n,
		mtimeNs: 10n,
		nlink: 1n,
		size: BigInt(size),
		uid: 4n,
		...changes,
	});
}

type HandleOptions = Readonly<{
	close?: () => unknown;
	postIdentity?: PaarArchiveIdentity;
	read?: (offset: number, maxBytes: number) => unknown;
	short?: number;
}>;

function handleFor(
	archive: Uint8Array,
	options: HandleOptions = {},
): {
	handle: Readonly<{ close: () => unknown; read: (offset: number, maxBytes: number) => unknown; stat: () => unknown }>;
	state: { closes: number; reads: number; stats: number };
} {
	const state = { closes: 0, reads: 0, stats: 0 };
	const first = identity(archive.byteLength);
	const close = options.close ?? (() => Promise.resolve(Object.freeze({ status: "closed" })));
	return {
		handle: Object.freeze({
			close(): unknown {
				state.closes += 1;
				return close();
			},
			read(offset: number, maxBytes: number): unknown {
				state.reads += 1;
				if (options.read) return options.read(offset, maxBytes);
				if (offset >= archive.byteLength) return Promise.resolve(Object.freeze({ status: "eof" }));
				const count = Math.min(maxBytes, options.short ?? maxBytes, archive.byteLength - offset);
				return Promise.resolve(Object.freeze({ bytes: archive.slice(offset, offset + count), status: "bytes" }));
			},
			stat(): unknown {
				state.stats += 1;
				return Promise.resolve(state.stats === 1 ? first : (options.postIdentity ?? first));
			},
		}),
		state,
	};
}

describe("verifyPaarArchive", () => {
	it("streams short reads, verifies zero-byte files, then closes once", async () => {
		const { archive, expectation } = fixture();
		let closed = false;
		const { handle, state } = handleFor(archive, {
			short: 1,
			close: () => {
				closed = true;
				return Promise.resolve(Object.freeze({ status: "closed" }));
			},
			read: (offset, maxBytes) => {
				if (closed) return Promise.resolve(Object.freeze({ status: "error" }));
				if (offset >= archive.byteLength) return Promise.resolve(Object.freeze({ status: "eof" }));
				return Promise.resolve(
					Object.freeze({ bytes: archive.slice(offset, offset + Math.min(1, maxBytes)), status: "bytes" }),
				);
			},
		});
		const result = await verifyPaarArchive(handle, expectation);
		expect(result.ok).toBe(true);
		expect(state.closes).toBe(1);
		expect(state.stats).toBe(2);
		if (result.ok) {
			expect(result.value.archiveSha256).toBe(expectation.archiveSha256);
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.value)).toBe(true);
			expect(Object.isFrozen(result.value.identity)).toBe(true);
		}
	});

	it("closes after invalid expectations when close was discoverable", async () => {
		const { archive, expectation } = fixture();
		const { handle, state } = handleFor(archive);
		const result = await verifyPaarArchive(handle, { ...expectation, extra: true });
		expect(result).toEqual({ ok: false, error: { code: "MANIFEST_INVALID" } });
		expect(state.closes).toBe(1);
	});

	it("acquires an own close before rejecting a non-plain handle", async () => {
		const { archive, expectation } = fixture();
		let closes = 0;
		class NonPlainHandle {
			readonly close = (): Promise<unknown> => {
				closes += 1;
				return Promise.resolve(Object.freeze({ status: "closed" }));
			};
			readonly read = (): Promise<unknown> => Promise.resolve(Object.freeze({ status: "eof" }));
			readonly stat = (): Promise<unknown> => Promise.resolve(identity(archive.byteLength));
		}
		const handle = Object.freeze(new NonPlainHandle());
		expect(await verifyPaarArchive(handle, expectation)).toEqual({ ok: false, error: { code: "HANDLE_INVALID" } });
		expect(closes).toBe(1);
	});

	it("closes when another handle method is invalid", async () => {
		const { archive, expectation } = fixture();
		let closes = 0;
		const handle = Object.freeze({
			close: () => {
				closes += 1;
				return Promise.resolve(Object.freeze({ status: "closed" }));
			},
			read: 1,
			stat: () => Promise.resolve(identity(archive.byteLength)),
		});
		expect(await verifyPaarArchive(handle, expectation)).toEqual({ ok: false, error: { code: "HANDLE_INVALID" } });
		expect(closes).toBe(1);
	});

	it.each([
		() => {
			throw new Error("secret");
		},
		() => Promise.reject(new Error("secret")),
		() => Promise.resolve(Object.freeze({ status: "error" })),
		() => Promise.resolve({ status: "closed" }),
	])("lets close uncertainty dominate", async (close) => {
		const { archive, expectation } = fixture();
		const { handle } = handleFor(archive, { close });
		expect(await verifyPaarArchive(handle, expectation)).toEqual({ ok: false, error: { code: "CLOSE_UNCONFIRMED" } });
	});

	it("rejects an archive size mismatch", async () => {
		const { archive, expectation } = fixture();
		const { handle } = handleFor(archive.slice(0, archive.byteLength - 1));
		expect(await verifyPaarArchive(handle, expectation)).toEqual({
			ok: false,
			error: { code: "ARCHIVE_SIZE_MISMATCH" },
		});
	});

	it("rejects a wrong archive digest", async () => {
		const { archive, expectation } = fixture();
		const { handle } = handleFor(archive);
		const result = await verifyPaarArchive(handle, Object.freeze({ ...expectation, archiveSha256: "0".repeat(64) }));
		expect(result).toEqual({ ok: false, error: { code: "ARCHIVE_HASH_MISMATCH" } });
	});

	it("rejects payload bytes that disagree with a manifest file hash", async () => {
		const { archive, expectation } = fixture();
		const changed = archive.slice();
		changed[changed.byteLength - 1] ^= 1;
		const { handle } = handleFor(changed);
		const changedExpectation = Object.freeze({ ...expectation, archiveSha256: sha(changed) });
		expect(await verifyPaarArchive(handle, changedExpectation)).toEqual({
			ok: false,
			error: { code: "FILE_HASH_MISMATCH" },
		});
	});

	it.each(["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const)(
		"compares the complete post-read identity field %s",
		async (field) => {
			const { archive, expectation } = fixture();
			const changed = identity(archive.byteLength, { [field]: identity(archive.byteLength)[field] + 1n });
			const { handle } = handleFor(archive, { postIdentity: changed });
			const result = await verifyPaarArchive(handle, expectation);
			if (field === "mode" || field === "nlink") expect(result.ok).toBe(false);
			else if (field === "size") expect(result.ok).toBe(false);
			else expect(result).toEqual({ ok: false, error: { code: "IDENTITY_CHANGED" } });
		},
	);

	it("rejects non-regular identities", async () => {
		const { archive, expectation } = fixture();
		const bad = Object.freeze({ ...identity(archive.byteLength), mode: 0o140777n });
		let stats = 0;
		const base = handleFor(archive);
		const handle = Object.freeze({
			...base.handle,
			stat: () => {
				stats += 1;
				return Promise.resolve(bad);
			},
		});
		expect((await verifyPaarArchive(handle, expectation)).ok).toBe(false);
		expect(stats).toBe(1);
	});

	it("requires exact EOF even when stat reports the expected size", async () => {
		const { archive, expectation } = fixture();
		const { handle } = handleFor(archive, {
			read: (offset, maxBytes) => {
				if (offset === archive.byteLength)
					return Promise.resolve(Object.freeze({ bytes: new Uint8Array([9]), status: "bytes" }));
				const count = Math.min(maxBytes, archive.byteLength - offset);
				return Promise.resolve(Object.freeze({ bytes: archive.slice(offset, offset + count), status: "bytes" }));
			},
		});
		expect(await verifyPaarArchive(handle, expectation)).toEqual({
			ok: false,
			error: { code: "UNEXPECTED_TRAILING_BYTES" },
		});
	});

	it("rejects Buffer and subview read transfers", async () => {
		const { archive, expectation } = fixture();
		for (const bytes of [Buffer.from([1, 2]), new Uint8Array(4).subarray(1, 3)]) {
			const { handle } = handleFor(archive, {
				read: () => Promise.resolve(Object.freeze({ bytes, status: "bytes" })),
			});
			expect(await verifyPaarArchive(handle, expectation)).toEqual({ ok: false, error: { code: "READ_FAILED" } });
		}
	});

	it("rejects a promise with an own then without invoking it", async () => {
		const { archive, expectation } = fixture();
		let calls = 0;
		const promise = Promise.resolve(Object.freeze({ status: "eof" }));
		// biome-ignore lint/suspicious/noThenProperty: adversarial native promise with an own then slot
		Object.defineProperty(promise, "then", {
			value: () => {
				calls += 1;
			},
		});
		const { handle } = handleFor(archive, { read: () => promise });
		expect(await verifyPaarArchive(handle, expectation)).toEqual({ ok: false, error: { code: "READ_FAILED" } });
		expect(calls).toBe(0);
	});

	it("erases bytes that arrive after the total deadline", async () => {
		vi.useFakeTimers();
		try {
			const { archive, expectation } = fixture();
			const deferred: { resolve: ((value: unknown) => void) | null } = { resolve: null };
			const pending = new Promise<unknown>((resolve) => {
				deferred.resolve = resolve;
			});
			const { handle } = handleFor(archive, { read: () => pending });
			const resultPromise = verifyPaarArchive(handle, expectation);
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await resultPromise;
			expect(result).toEqual({ ok: false, error: { code: "TIMEOUT" } });
			const late = new Uint8Array([1, 2, 3]);
			if (!deferred.resolve) throw new Error("missing deferred resolver");
			deferred.resolve(Object.freeze({ bytes: late, status: "bytes" }));
			await vi.runAllTicks();
			await Promise.resolve();
			expect(Array.from(late)).toEqual([0, 0, 0]);
		} finally {
			vi.useRealTimers();
		}
	});
});
