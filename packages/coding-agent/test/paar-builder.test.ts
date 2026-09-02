import { describe, expect, it } from "vitest";
import { buildPaarArchive } from "../src/core/paar-builder.js";
import { decodePaarManifestHeader } from "../src/core/paar-manifest-codec.js";

const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

interface SourceFile {
	readonly path: string;
	readonly mode: 0o644 | 0o755;
	bytes: Uint8Array;
	identityVersion: bigint;
}

interface HarnessOptions {
	readonly partialWrite?: number;
	readonly changeIdentityOnPass2?: boolean;
	readonly changeBytesOnPass2?: boolean;
	readonly failReadOnPass2?: boolean;
	readonly readerCloseError?: boolean;
	readonly writeThrows?: boolean;
	readonly finalizeNonNative?: boolean;
	readonly corruptOutput?: boolean;
	readonly abandonError?: boolean;
	readonly treeCloseError?: boolean;
	readonly malformedOpenResult?: boolean;
	readonly malformedCreateResult?: boolean;
	readonly aliasReaderToTree?: boolean;
	readonly aliasWriterToOutput?: boolean;
	readonly invalidReadStatusWithBytes?: boolean;
	readonly committedOverride?: number;
}

interface BuilderHarness {
	readonly input: Readonly<Record<string, unknown>>;
	readonly outputBytes: () => Uint8Array | null;
	readonly opens: Array<Readonly<{ path: string; pass: number }>>;
	readonly readChunks: Uint8Array[];
	readonly writeChunks: Uint8Array[];
	readonly counts: Readonly<{
		readerCloses: () => number;
		treeCloses: () => number;
		outputCloses: () => number;
		abandons: () => number;
		finalizes: () => number;
		archiveCloses: () => number;
	}>;
}

function identity(file: SourceFile): Readonly<Record<string, bigint>> {
	return Object.freeze({
		dev: 1n,
		ino: file.identityVersion,
		uid: 501n,
		gid: 20n,
		mode: 0o100000n | BigInt(file.mode),
		nlink: 1n,
		size: BigInt(file.bytes.byteLength),
		mtimeNs: file.identityVersion,
		ctimeNs: file.identityVersion,
	});
}

function harness(options: HarnessOptions = {}): BuilderHarness {
	const files: SourceFile[] = [
		{
			path: "bin/runtime",
			mode: 0o755,
			bytes: new TextEncoder().encode("runtime-bytes"),
			identityVersion: 11n,
		},
		{
			path: "lib/kernel.py",
			mode: 0o644,
			bytes: new TextEncoder().encode("print('kernel')\n"),
			identityVersion: 12n,
		},
	];
	const opens: Array<Readonly<{ path: string; pass: number }>> = [];
	const readChunks: Uint8Array[] = [];
	const writeChunks: Uint8Array[] = [];
	let readerCloses = 0;
	let treeCloses = 0;
	let outputCloses = 0;
	let abandons = 0;
	let finalizes = 0;
	let archiveCloses = 0;
	let output: Uint8Array | null = null;
	const tree = {
		list(): Promise<unknown> {
			return Promise.resolve({
				status: "listed",
				entries: files.map((file) => ({ path: file.path, mode: file.mode })),
			});
		},
		open(raw: unknown): Promise<unknown> {
			const request = raw as { path: string; pass: number };
			const file = files.find((candidate) => candidate.path === request.path);
			if (!file) return Promise.resolve({ status: "error" });
			opens.push({ path: request.path, pass: request.pass });
			if (request.pass === 2 && options.changeIdentityOnPass2) file.identityVersion += 100n;
			if (request.pass === 2 && options.changeBytesOnPass2) {
				file.bytes = new Uint8Array(file.bytes.map((byte) => byte ^ 1));
			}
			let reads = 0;
			const reader = {
				stat(): Promise<unknown> {
					return Promise.resolve(identity(file));
				},
				read(rawRead: unknown): Promise<unknown> {
					const requestRead = rawRead as { offset: number; maximum: number };
					reads += 1;
					if (options.invalidReadStatusWithBytes && reads === 1) {
						const bytes = new Uint8Array([7, 8, 9]);
						readChunks.push(bytes);
						return Promise.resolve({ status: "eof", bytes });
					}
					if (request.pass === 2 && options.failReadOnPass2 && reads === 1) {
						return Promise.resolve({ status: "error" });
					}
					if (requestRead.offset >= file.bytes.byteLength) {
						return Promise.resolve({ status: "eof" });
					}
					const bytes = file.bytes.slice(
						requestRead.offset,
						Math.min(file.bytes.byteLength, requestRead.offset + requestRead.maximum),
					);
					readChunks.push(bytes);
					return Promise.resolve({ status: "bytes", bytes });
				},
				close(): Promise<unknown> {
					readerCloses += 1;
					return Promise.resolve({ status: options.readerCloseError ? "error" : "closed" });
				},
			};
			if (options.aliasReaderToTree) return Promise.resolve({ status: "opened", reader: tree });
			return Promise.resolve(
				options.malformedOpenResult ? { status: "opened", reader, extra: true } : { status: "opened", reader },
			);
		},
		close(): Promise<unknown> {
			treeCloses += 1;
			return Promise.resolve({ status: options.treeCloseError ? "error" : "closed" });
		},
	};
	const outputCapability = {
		create(raw: unknown): Promise<unknown> {
			const request = raw as { archiveSize: number };
			output = new Uint8Array(request.archiveSize);
			const writer = {
				write(rawWrite: unknown): Promise<unknown> {
					const requestWrite = rawWrite as { offset: number; bytes: Uint8Array };
					writeChunks.push(requestWrite.bytes);
					if (options.writeThrows) throw new Error("uncertain write");
					const committed =
						options.committedOverride ??
						Math.min(requestWrite.bytes.byteLength, options.partialWrite ?? requestWrite.bytes.byteLength);
					output?.set(requestWrite.bytes.subarray(0, committed), requestWrite.offset);
					return Promise.resolve({ status: "written", committed });
				},
				finalize(): unknown {
					finalizes += 1;
					if (options.corruptOutput && output) output[output.byteLength - 1] ^= 1;
					if (options.finalizeNonNative) return Object.create(Promise.prototype);
					const archive = output;
					if (!archive) return Promise.resolve({ status: "error" });
					const handle = Object.freeze({
						stat: () =>
							Promise.resolve(
								Object.freeze({
									dev: 2n,
									ino: 99n,
									uid: 501n,
									gid: 20n,
									mode: 0o100600n,
									nlink: 1n,
									size: BigInt(archive.byteLength),
									mtimeNs: 1n,
									ctimeNs: 1n,
								}),
							),
						read: (offset: number, maximum: number) => {
							if (offset >= archive.byteLength) {
								return Promise.resolve(Object.freeze({ status: "eof" }));
							}
							return Promise.resolve(
								Object.freeze({
									status: "bytes",
									bytes: archive.slice(offset, Math.min(archive.byteLength, offset + maximum)),
								}),
							);
						},
						close: () => {
							archiveCloses += 1;
							return Promise.resolve(Object.freeze({ status: "closed" }));
						},
					});
					return Promise.resolve(Object.freeze({ status: "sealed", handle }));
				},
				abandon(): Promise<unknown> {
					abandons += 1;
					return Promise.resolve({ status: options.abandonError ? "error" : "abandoned" });
				},
			};
			if (options.aliasWriterToOutput) {
				return Promise.resolve({ status: "created", writer: outputCapability });
			}
			return Promise.resolve(
				options.malformedCreateResult ? { status: "created", writer, extra: true } : { status: "created", writer },
			);
		},
		close(): Promise<unknown> {
			outputCloses += 1;
			return Promise.resolve({ status: "closed" });
		},
	};
	return {
		input: {
			sourceCommit: SOURCE_COMMIT,
			target: "linux-x64",
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
			tree,
			output: outputCapability,
		},
		outputBytes: () => output,
		opens,
		readChunks,
		writeChunks,
		counts: {
			readerCloses: () => readerCloses,
			treeCloses: () => treeCloses,
			outputCloses: () => outputCloses,
			abandons: () => abandons,
			finalizes: () => finalizes,
			archiveCloses: () => archiveCloses,
		},
	};
}

describe("PAAR builder", () => {
	it("builds and verifies one canonical archive with exactly two source passes", async () => {
		const h = harness();
		const result = await buildPaarArchive(h.input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(h.opens).toEqual([
			{ path: "bin/runtime", pass: 1 },
			{ path: "lib/kernel.py", pass: 1 },
			{ path: "bin/runtime", pass: 2 },
			{ path: "lib/kernel.py", pass: 2 },
		]);
		expect(h.counts.readerCloses()).toBe(4);
		expect(h.counts.finalizes()).toBe(1);
		expect(h.counts.abandons()).toBe(0);
		expect(h.counts.archiveCloses()).toBe(1);
		expect(h.counts.treeCloses()).toBe(1);
		expect(h.counts.outputCloses()).toBe(1);
		const output = h.outputBytes();
		expect(output).not.toBeNull();
		if (output) {
			const decoded = decodePaarManifestHeader(output, output.byteLength);
			expect(decoded.ok).toBe(true);
		}
	});

	it("supports partial explicit-offset writes", async () => {
		const h = harness({ partialWrite: 3 });
		expect((await buildPaarArchive(h.input)).ok).toBe(true);
		expect(h.writeChunks.length).toBeGreaterThan(4);
	});

	it("erases every transferred source read chunk after use", async () => {
		const h = harness();
		expect((await buildPaarArchive(h.input)).ok).toBe(true);
		expect(h.readChunks.length).toBeGreaterThan(0);
		for (const bytes of h.readChunks) expect([...bytes].every((byte) => byte === 0)).toBe(true);
	});

	it("does not touch bytes after transferring them to the writer", async () => {
		const h = harness();
		expect((await buildPaarArchive(h.input)).ok).toBe(true);
		expect(h.writeChunks.some((bytes) => [...bytes].some((byte) => byte !== 0))).toBe(true);
	});

	it("rejects identity changes between source passes and abandons confirmed output", async () => {
		const h = harness({ changeIdentityOnPass2: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "SOURCE_CHANGED" } });
		expect(h.counts.abandons()).toBe(1);
		expect(h.counts.readerCloses()).toBe(3);
	});

	it("rejects byte changes with stable identity and abandons", async () => {
		const h = harness({ changeBytesOnPass2: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "SOURCE_CHANGED" } });
		expect(h.counts.abandons()).toBe(1);
	});

	it("closes a pass-two reader and abandons after a deterministic read failure", async () => {
		const h = harness({ failReadOnPass2: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "SOURCE_READ_FAILED" } });
		expect(h.counts.readerCloses()).toBe(3);
		expect(h.counts.abandons()).toBe(1);
	});

	it("erases discoverable bytes from a malformed eof result", async () => {
		const h = harness({ invalidReadStatusWithBytes: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "SOURCE_READ_FAILED" } });
		expect(h.readChunks).toHaveLength(1);
		expect([...h.readChunks[0]].every((byte) => byte === 0)).toBe(true);
	});

	it.each([0, 100_000])("poisons output for invalid committed count %i", async (committedOverride) => {
		const h = harness({ committedOverride });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "OUTPUT_UNCERTAIN" } });
		expect(h.counts.abandons()).toBe(0);
	});

	it("lets reader close uncertainty dominate", async () => {
		const h = harness({ readerCloseError: true });
		expect(await buildPaarArchive(h.input)).toEqual({
			ok: false,
			error: { code: "SOURCE_CLOSE_UNCONFIRMED" },
		});
		expect(h.counts.readerCloses()).toBe(1);
	});

	it("preserves uncertain output without abandon after a write throw", async () => {
		const h = harness({ writeThrows: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "OUTPUT_UNCERTAIN" } });
		expect(h.counts.abandons()).toBe(0);
	});

	it("lets abandon uncertainty dominate a safe failure", async () => {
		const h = harness({ failReadOnPass2: true, abandonError: true });
		expect(await buildPaarArchive(h.input)).toEqual({
			ok: false,
			error: { code: "ABANDON_UNCONFIRMED" },
		});
	});

	it("does not abandon after finalize ownership becomes uncertain", async () => {
		const h = harness({ finalizeNonNative: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "OUTPUT_UNCERTAIN" } });
		expect(h.counts.abandons()).toBe(0);
	});

	it("reports verifier failure and still closes the sealed handle", async () => {
		const h = harness({ corruptOutput: true });
		expect(await buildPaarArchive(h.input)).toEqual({
			ok: false,
			error: { code: "VERIFICATION_FAILED" },
		});
		expect(h.counts.archiveCloses()).toBe(1);
	});

	it("closes discovered root capabilities after unrelated input rejection", async () => {
		const h = harness();
		const result = await buildPaarArchive({ ...h.input, extra: true });
		expect(result).toEqual({ ok: false, error: { code: "INPUT_INVALID" } });
		expect(h.counts.treeCloses()).toBe(1);
		expect(h.counts.outputCloses()).toBe(1);
	});

	it("rejects root capability aliases and closes the owner once", async () => {
		let closes = 0;
		const shared = {
			list: () => Promise.resolve({ status: "listed", entries: [] }),
			open: () => Promise.resolve({ status: "error" }),
			create: () => Promise.resolve({ status: "error" }),
			close: () => {
				closes += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await buildPaarArchive({
			sourceCommit: SOURCE_COMMIT,
			target: "linux-x64",
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
			tree: shared,
			output: shared,
		});
		expect(result).toEqual({ ok: false, error: { code: "INPUT_INVALID" } });
		expect(closes).toBe(1);
	});

	it("closes a discoverable reader in a malformed open result", async () => {
		const h = harness({ malformedOpenResult: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "SOURCE_OPEN_FAILED" } });
		expect(h.counts.readerCloses()).toBe(1);
	});

	it("abandons a discoverable writer in a malformed create result", async () => {
		const h = harness({ malformedCreateResult: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "OUTPUT_CREATE_FAILED" } });
		expect(h.counts.abandons()).toBe(1);
	});

	it("rejects a reader aliased to the tree and closes the shared owner once", async () => {
		const h = harness({ aliasReaderToTree: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "SOURCE_OPEN_FAILED" } });
		expect(h.counts.treeCloses()).toBe(1);
		expect(h.counts.readerCloses()).toBe(0);
	});

	it("rejects a writer aliased to output and closes the shared owner once", async () => {
		const h = harness({ aliasWriterToOutput: true });
		expect(await buildPaarArchive(h.input)).toEqual({ ok: false, error: { code: "OUTPUT_CREATE_FAILED" } });
		expect(h.counts.outputCloses()).toBe(1);
		expect(h.counts.abandons()).toBe(0);
	});

	it("discovers and closes root capabilities before rejecting symbol keys", async () => {
		const h = harness();
		const raw = { ...h.input, [Symbol("hidden")]: true };
		expect(await buildPaarArchive(raw)).toEqual({ ok: false, error: { code: "INPUT_INVALID" } });
		expect(h.counts.treeCloses()).toBe(1);
		expect(h.counts.outputCloses()).toBe(1);
	});

	it("lets root close uncertainty dominate a verified archive", async () => {
		const h = harness({ treeCloseError: true });
		expect(await buildPaarArchive(h.input)).toEqual({
			ok: false,
			error: { code: "CLOSE_UNCONFIRMED" },
		});
	});
});
