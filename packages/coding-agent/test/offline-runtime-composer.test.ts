import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	composeOfflineRuntimeTree,
	computeOfflineRuntimeManifestDigest,
	type OfflineRuntimeManifest,
	type OfflineRuntimeSourceKind,
	type OfflineRuntimeTarget,
} from "../src/core/offline-runtime-composer.js";
import { buildPaarArchive } from "../src/core/paar-builder.js";

const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

type File = Readonly<{ path: string; mode: 0o644 | 0o755; bytes: Uint8Array; sha256: string; ino: bigint }>;

function elf(target: OfflineRuntimeTarget): Uint8Array {
	const interpreter = target === "linux-x64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
	const bytes = new Uint8Array(256);
	bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	const view = new DataView(bytes.buffer);
	view.setUint16(18, target === "linux-x64" ? 0x3e : 0xb7, true);
	view.setUint32(20, 1, true);
	view.setBigUint64(32, 64n, true);
	view.setUint16(52, 64, true);
	view.setUint16(54, 56, true);
	view.setUint16(56, 1, true);
	view.setUint32(64, 3, true);
	view.setBigUint64(72, 128n, true);
	view.setBigUint64(96, BigInt(interpreter.length + 1), true);
	bytes.set(new TextEncoder().encode(interpreter), 128);
	return bytes;
}

async function manifest(
	kind: OfflineRuntimeSourceKind,
	target: OfflineRuntimeTarget | "any",
	version: string,
	files: readonly File[],
): Promise<OfflineRuntimeManifest> {
	const entries = Object.freeze(
		files.map((file) =>
			Object.freeze({ path: file.path, mode: file.mode, size: file.bytes.byteLength, sha256: file.sha256 }),
		),
	);
	const base = Object.freeze({ kind, target, version, buildSha256: "a".repeat(64), files: entries });
	const digest = computeOfflineRuntimeManifestDigest(base);
	expect(digest.ok).toBe(true);
	if (!digest.ok) throw new Error("manifest digest failed");
	return Object.freeze({ ...base, treeSha256: digest.value });
}

function file(path: string, mode: 0o644 | 0o755, bytes: Uint8Array, ino: bigint): File {
	return Object.freeze({ path, mode, bytes, ino, sha256: createHash("sha256").update(bytes).digest("hex") });
}

function tree(
	files: readonly File[],
	opens: Array<Readonly<{ path: string; pass: number }>>,
	closes: { value: number },
	short = 7,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		list: () =>
			Promise.resolve(
				Object.freeze({
					status: "listed",
					entries: Object.freeze(files.map((entry) => Object.freeze({ path: entry.path, mode: entry.mode }))),
				}),
			),
		open: (raw: unknown) => {
			const request = raw as { path: string; pass: number };
			const entry = files.find((candidate) => candidate.path === request.path);
			if (!entry) return Promise.resolve(Object.freeze({ status: "error" }));
			opens.push(Object.freeze({ path: request.path, pass: request.pass }));
			const reader = Object.freeze({
				stat: () =>
					Promise.resolve(
						Object.freeze({
							dev: 1n,
							ino: entry.ino,
							uid: 501n,
							gid: 20n,
							mode: 0o100000n | BigInt(entry.mode),
							nlink: 1n,
							size: BigInt(entry.bytes.byteLength),
							mtimeNs: 1n,
							ctimeNs: 1n,
						}),
					),
				read: (readRaw: unknown) => {
					const read = readRaw as { offset: number; maximum: number };
					if (read.offset >= entry.bytes.byteLength) return Promise.resolve(Object.freeze({ status: "eof" }));
					const end = Math.min(entry.bytes.byteLength, read.offset + read.maximum, read.offset + short);
					return Promise.resolve(Object.freeze({ status: "bytes", bytes: entry.bytes.slice(read.offset, end) }));
				},
				close: () => Promise.resolve(Object.freeze({ status: "closed" })),
			});
			return Promise.resolve(Object.freeze({ status: "opened", reader }));
		},
		close: () => {
			closes.value += 1;
			return Promise.resolve(Object.freeze({ status: "closed" }));
		},
	});
}

async function runtimeInput(
	target: OfflineRuntimeTarget,
	mutate?: (parts: { node: Uint8Array; python: Uint8Array; bundle: Uint8Array; runtime: Uint8Array }) => void,
) {
	const parts = {
		node: elf(target),
		python: elf(target),
		bundle: new TextEncoder().encode("console.log('prime')"),
		runtime: new TextEncoder().encode("__all__ = []"),
	};
	mutate?.(parts);
	const opens: Array<Readonly<{ path: string; pass: number }>> = [];
	const closes = [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 0 }];
	const nodeFiles = Object.freeze([file("node", 0o755, parts.node, 1n)]);
	const pythonFiles = Object.freeze([
		file("bin/python3.11", 0o755, parts.python, 2n),
		file("site-packages/.keep", 0o644, new Uint8Array(), 3n),
	]);
	const bundleFiles = Object.freeze([file("dist/bundle/cli.js", 0o644, parts.bundle, 4n)]);
	const runtimeFiles = Object.freeze([file("rlm/__init__.py", 0o644, parts.runtime, 5n)]);
	return {
		input: Object.freeze({
			target,
			node: Object.freeze({
				tree: tree(nodeFiles, opens, closes[0]!),
				manifest: await manifest("node", target, "22.8.1", nodeFiles),
			}),
			python: Object.freeze({
				tree: tree(pythonFiles, opens, closes[1]!),
				manifest: await manifest("python", target, "3.11.9", pythonFiles),
			}),
			bundle: Object.freeze({
				tree: tree(bundleFiles, opens, closes[2]!),
				manifest: await manifest("bundle", "any", "bundle-1", bundleFiles),
			}),
			runtime: Object.freeze({
				tree: tree(runtimeFiles, opens, closes[3]!),
				manifest: await manifest("runtime", "any", "runtime-1", runtimeFiles),
			}),
		}),
		opens,
		closes,
	};
}

function outputCapability(): Readonly<Record<string, unknown>> {
	let archive: Uint8Array | null = null;
	return Object.freeze({
		create: (raw: unknown) => {
			const request = raw as { archiveSize: number };
			archive = new Uint8Array(request.archiveSize);
			const writer = Object.freeze({
				write: (writeRaw: unknown) => {
					const write = writeRaw as { offset: number; bytes: Uint8Array };
					archive?.set(write.bytes, write.offset);
					return Promise.resolve(Object.freeze({ status: "written", committed: write.bytes.byteLength }));
				},
				finalize: () => {
					const owned = archive;
					if (!owned) return Promise.resolve(Object.freeze({ status: "error" }));
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
									size: BigInt(owned.byteLength),
									mtimeNs: 1n,
									ctimeNs: 1n,
								}),
							),
						read: (offset: number, maximum: number) =>
							offset >= owned.byteLength
								? Promise.resolve(Object.freeze({ status: "eof" }))
								: Promise.resolve(
										Object.freeze({
											status: "bytes",
											bytes: owned.slice(offset, Math.min(owned.byteLength, offset + maximum)),
										}),
									),
						close: () => Promise.resolve(Object.freeze({ status: "closed" })),
					});
					return Promise.resolve(Object.freeze({ status: "sealed", handle }));
				},
				abandon: () => Promise.resolve(Object.freeze({ status: "abandoned" })),
			});
			return Promise.resolve(Object.freeze({ status: "created", writer }));
		},
		close: () => Promise.resolve(Object.freeze({ status: "closed" })),
	});
}

describe("offline runtime composer", () => {
	it.each(["linux-x64", "linux-arm64"] as const)(
		"composes %s through the accepted exactly-two-pass builder",
		async (target) => {
			const h = await runtimeInput(target);
			const composed = await composeOfflineRuntimeTree(h.input);
			expect(composed.ok).toBe(true);
			if (!composed.ok) return;
			const result = await buildPaarArchive(
				Object.freeze({
					sourceCommit: SOURCE_COMMIT,
					target,
					daemonProtocolVersion: 1,
					daemonSchemaRevision: 0,
					tree: composed.tree,
					output: outputCapability(),
				}),
			);
			expect(result.ok).toBe(true);
			expect(h.opens).toHaveLength(10);
			expect(h.opens.filter((entry) => entry.pass === 1)).toHaveLength(5);
			expect(h.opens.filter((entry) => entry.pass === 2)).toHaveLength(5);
			expect(h.closes.map((count) => count.value)).toEqual([1, 1, 1, 1]);
		},
	);

	it("publishes the fixed normalized layout", async () => {
		const h = await runtimeInput("linux-x64");
		const composed = await composeOfflineRuntimeTree(h.input);
		if (!composed.ok) throw new Error("compose failed");
		const listed = (await composed.tree.list()) as { entries: Array<{ path: string }> };
		expect(listed.entries.map((entry) => entry.path)).toEqual([
			"node/node",
			"prime-agent/dist/bundle/cli.js",
			"python/bin/python3.11",
			"python/site-packages/.keep",
			"python/site-packages/rlm/__init__.py",
		]);
		await composed.tree.close();
	});

	it("rejects a required non-ELF executable during pass one", async () => {
		const h = await runtimeInput("linux-x64", (parts) => parts.node.fill(1));
		const composed = await composeOfflineRuntimeTree(h.input);
		if (!composed.ok) throw new Error("compose failed");
		const result = await buildPaarArchive(
			Object.freeze({
				sourceCommit: SOURCE_COMMIT,
				target: "linux-x64",
				daemonProtocolVersion: 1,
				daemonSchemaRevision: 0,
				tree: composed.tree,
				output: outputCapability(),
			}),
		);
		expect(result).toEqual({ ok: false, error: { code: "SOURCE_CLOSE_UNCONFIRMED" } });
	});

	it("rejects ELF bytes in a neutral source", async () => {
		const h = await runtimeInput("linux-x64", (parts) => {
			parts.bundle.set([0x7f, 0x45, 0x4c, 0x46]);
		});
		const composed = await composeOfflineRuntimeTree(h.input);
		if (!composed.ok) throw new Error("compose failed");
		const result = await buildPaarArchive(
			Object.freeze({
				sourceCommit: SOURCE_COMMIT,
				target: "linux-x64",
				daemonProtocolVersion: 1,
				daemonSchemaRevision: 0,
				tree: composed.tree,
				output: outputCapability(),
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a cross-architecture ELF even when its trusted file digest matches", async () => {
		const h = await runtimeInput("linux-x64", (parts) => {
			new DataView(parts.node.buffer).setUint16(18, 0xb7, true);
		});
		const composed = await composeOfflineRuntimeTree(h.input);
		if (!composed.ok) throw new Error("compose failed");
		const result = await buildPaarArchive(
			Object.freeze({
				sourceCommit: SOURCE_COMMIT,
				target: "linux-x64",
				daemonProtocolVersion: 1,
				daemonSchemaRevision: 0,
				tree: composed.tree,
				output: outputCapability(),
			}),
		);
		expect(result).toEqual({ ok: false, error: { code: "SOURCE_CLOSE_UNCONFIRMED" } });
	});

	it("rejects non-NFC manifest paths before source access", () => {
		const files = Object.freeze([Object.freeze({ path: "e\u0301", mode: 0o644, size: 0, sha256: "0".repeat(64) })]);
		const result = computeOfflineRuntimeManifestDigest(
			Object.freeze({ kind: "bundle", target: "any", version: "bundle-1", buildSha256: "a".repeat(64), files }),
		);
		expect(result).toEqual({ ok: false, error: { code: "MANIFEST_INVALID" } });
	});

	it("shares the composed root close promise and rejects open before list", async () => {
		const h = await runtimeInput("linux-x64");
		const composed = await composeOfflineRuntimeTree(h.input);
		if (!composed.ok) throw new Error("compose failed");
		expect(await composed.tree.open(Object.freeze({ path: "node/node", pass: 1 }))).toEqual({ status: "error" });
		const first = composed.tree.close();
		const second = composed.tree.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ status: "closed" });
		expect(h.closes.map((count) => count.value)).toEqual([1, 1, 1, 1]);
	});

	it("closes every acquired root when a trusted manifest is invalid", async () => {
		const h = await runtimeInput("linux-x64");
		const node = h.input.node as { tree: unknown; manifest: OfflineRuntimeManifest };
		const bad = Object.freeze({ ...node.manifest, treeSha256: "0".repeat(64) });
		const result = await composeOfflineRuntimeTree(
			Object.freeze({ ...h.input, node: Object.freeze({ tree: node.tree, manifest: bad }) }),
		);
		expect(result).toEqual({ ok: false, error: { code: "MANIFEST_INVALID" } });
		expect(h.closes.map((count) => count.value)).toEqual([1, 1, 1, 1]);
	});

	it("lets root close uncertainty dominate an invalid manifest", async () => {
		const h = await runtimeInput("linux-x64");
		const nodeTree = h.input.node.tree as {
			list: () => unknown;
			open: (raw: unknown) => unknown;
			close: () => Promise<unknown>;
		};
		const failingTree = Object.freeze({
			list: (...args: readonly unknown[]) => Reflect.apply(nodeTree.list, nodeTree, args),
			open: (...args: readonly unknown[]) => Reflect.apply(nodeTree.open, nodeTree, args),
			close: async () => {
				await Reflect.apply(nodeTree.close, nodeTree, []);
				return Object.freeze({ status: "error" });
			},
		});
		const badManifest = Object.freeze({ ...h.input.node.manifest, treeSha256: "0".repeat(64) });
		const result = await composeOfflineRuntimeTree(
			Object.freeze({ ...h.input, node: Object.freeze({ tree: failingTree, manifest: badManifest }) }),
		);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCONFIRMED" } });
		expect(h.closes.map((count) => count.value)).toEqual([1, 1, 1, 1]);
	});

	it("rejects aliased source roots and closes the shared owner once", async () => {
		const h = await runtimeInput("linux-x64");
		const result = await composeOfflineRuntimeTree(
			Object.freeze({
				...h.input,
				python: Object.freeze({ tree: h.input.node.tree, manifest: h.input.python.manifest }),
			}),
		);
		expect(result).toEqual({ ok: false, error: { code: "SOURCE_ALIASED" } });
		expect(h.closes[0]!.value).toBe(1);
	});
});
