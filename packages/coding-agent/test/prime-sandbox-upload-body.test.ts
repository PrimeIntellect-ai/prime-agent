import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ArchiveUploadBody,
	type PreparedArchiveUpload,
	prepareArchiveUpload,
} from "../src/modes/daemon/sandbox/prime-sandbox-upload-body.js";

const roots: string[] = [];

async function root(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "prime-agent-upload-body-"));
	roots.push(value);
	return value;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function archive(bytes: Uint8Array): Promise<Readonly<{ path: string; bytes: Uint8Array }>> {
	const directory = await root();
	const path = join(directory, "runtime.tar.gz");
	await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
	await chmod(path, 0o600);
	return Object.freeze({ path, bytes });
}

async function prepared(bytes: Uint8Array): Promise<PreparedArchiveUpload> {
	const file = await archive(bytes);
	const result = await prepareArchiveUpload(file.path, bytes.byteLength, digest(bytes));
	if (!result.ok) throw new Error(result.code);
	return result.value;
}

function take(value: PreparedArchiveUpload): ArchiveUploadBody {
	const result = value.take();
	if (!result.ok) throw new Error(result.code);
	return result.value;
}

async function readAll(body: ArchiveUploadBody): Promise<Uint8Array> {
	const reader = body.stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
		total += result.value.byteLength;
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

afterEach(async () => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value !== undefined) await rm(value, { force: true, recursive: true });
	}
});

describe("prime sandbox streaming archive body", () => {
	test("streams an exact multipart body and settles only after the suffix", async () => {
		const bytes = new TextEncoder().encode("small exact archive");
		const owner = await prepared(bytes);
		const body = take(owner);
		expect(body.contentType).toMatch(/^multipart\/form-data; boundary=prime-agent-[0-9a-f]{48}$/);

		let settled = false;
		body.completion.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		const output = await readAll(body);
		const completion = await body.completion;
		expect(completion).toEqual({ ok: true });
		expect(settled).toBe(true);
		expect(output.byteLength).toBe(body.contentLength);

		const text = new TextDecoder().decode(output);
		const boundary = body.contentType.slice("multipart/form-data; boundary=".length);
		expect(text).toBe(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="prime-agent-runtime.tar.gz"\r\nContent-Type: application/gzip\r\n\r\nsmall exact archive\r\n--${boundary}--\r\n`,
		);
		expect(await body.retryCleanup()).toEqual({ ok: true });
	});

	test("reads the file in bounded chunks rather than buffering it at take", async () => {
		const bytes = new Uint8Array(3 * 64 * 1024 + 17);
		for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
		const file = await archive(bytes);
		const result = await prepareArchiveUpload(file.path, bytes.byteLength, digest(bytes));
		if (!result.ok) throw new Error(result.code);
		const body = take(result.value);
		const reader = body.stream.getReader();

		const prefix = await reader.read();
		expect(prefix.done).toBe(false);
		const firstFileChunk = await reader.read();
		expect(firstFileChunk.done).toBe(false);
		expect(firstFileChunk.value?.byteLength).toBe(64 * 1024);

		const fd = await open(file.path, "r+");
		try {
			const changed = new Uint8Array([0xff]);
			await fd.write(changed, 0, 1, bytes.byteLength - 1);
			await fd.sync();
		} finally {
			await fd.close();
		}

		let rejected = false;
		try {
			while (!(await reader.read()).done) {
				// Drain until the source rejects the changed file.
			}
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
		const completion = await body.completion;
		expect(completion.ok).toBe(false);
		if (!completion.ok) expect(["FILE_CHANGED", "DIGEST_MISMATCH"]).toContain(completion.code);
		expect(await body.retryCleanup()).toEqual({ ok: true });
	});

	test("cancellation settles and closes an untaken file stream", async () => {
		const owner = await prepared(new Uint8Array([1, 2, 3, 4]));
		const body = take(owner);
		expect(await body.cancelAndSettle()).toEqual({ ok: false, code: "CANCELLED" });
		expect(await body.completion).toEqual({ ok: false, code: "CANCELLED" });
		expect(await body.retryCleanup()).toEqual({ ok: true });
	});

	test("cancellation between the final file chunk and suffix cannot become success", async () => {
		const owner = await prepared(new Uint8Array([9]));
		const body = take(owner);
		const reader = body.stream.getReader();
		expect((await reader.read()).done).toBe(false);
		expect((await reader.read()).done).toBe(false);
		expect(await body.cancelAndSettle()).toEqual({ ok: false, code: "CANCELLED" });
		expect(await body.completion).toEqual({ ok: false, code: "CANCELLED" });
		let rejected = false;
		try {
			await reader.read();
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
	});

	test("built-in reader cancellation forwards to file cleanup", async () => {
		const owner = await prepared(new Uint8Array([4, 3, 2, 1]));
		const body = take(owner);
		const reader = body.stream.getReader();
		await reader.cancel();
		expect(await body.completion).toEqual({ ok: false, code: "CANCELLED" });
		expect(await body.retryCleanup()).toEqual({ ok: true });
	});

	test("the prepared capability is one-shot", async () => {
		const owner = await prepared(new Uint8Array([7]));
		take(owner);
		expect(owner.take()).toEqual({ ok: false, code: "ALREADY_USED" });
		await owner.close();
	});

	test("closing before take disarms the capability", async () => {
		const owner = await prepared(new Uint8Array([8]));
		expect(await owner.close()).toEqual({ ok: true });
		expect(owner.take()).toEqual({ ok: false, code: "ALREADY_USED" });
	});

	test("rejects a digest mismatch before a stream can be taken", async () => {
		const file = await archive(new Uint8Array([1, 2, 3]));
		const result = await prepareArchiveUpload(file.path, 3, "0".repeat(64));
		expect(result).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
	});

	test("rejects a size mismatch before a stream can be taken", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const file = await archive(bytes);
		const result = await prepareArchiveUpload(file.path, 2, digest(bytes));
		expect(result).toEqual({ ok: false, code: "FILE_UNSAFE" });
	});

	test("rejects group-readable archive files", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const file = await archive(bytes);
		await chmod(file.path, 0o640);
		const result = await prepareArchiveUpload(file.path, bytes.byteLength, digest(bytes));
		expect(result).toEqual({ ok: false, code: "FILE_UNSAFE" });
	});

	test("rejects a final-component symlink", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const file = await archive(bytes);
		const linkedPath = join(await root(), "linked.tar.gz");
		await symlink(file.path, linkedPath);
		const result = await prepareArchiveUpload(linkedPath, bytes.byteLength, digest(bytes));
		expect(result).toEqual({ ok: false, code: "OPEN_FAILED" });
	});

	test("rejects a multiply linked archive inode", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const file = await archive(bytes);
		await link(file.path, join(await root(), "second-link.tar.gz"));
		const result = await prepareArchiveUpload(file.path, bytes.byteLength, digest(bytes));
		expect(result).toEqual({ ok: false, code: "FILE_UNSAFE" });
	});

	test("rejects relative paths and malformed metadata without opening a file", async () => {
		expect(await prepareArchiveUpload("relative.tar.gz", 1, "0".repeat(64))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(await prepareArchiveUpload("/missing", 0, "0".repeat(64))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(await prepareArchiveUpload("/missing", 96 * 1024 * 1024 + 1, "0".repeat(64))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(await prepareArchiveUpload("/missing", 1, "A".repeat(64))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
	});

	test("mutation after preparation fails closed before the multipart suffix", async () => {
		const bytes = new Uint8Array(80_000);
		bytes.fill(0x41);
		const file = await archive(bytes);
		const result = await prepareArchiveUpload(file.path, bytes.byteLength, digest(bytes));
		if (!result.ok) throw new Error(result.code);
		const body = take(result.value);

		const fd = await open(file.path, "r+");
		try {
			await fd.write(new Uint8Array([0x42]), 0, 1, 0);
			await fd.sync();
		} finally {
			await fd.close();
		}

		let rejected = false;
		try {
			await readAll(body);
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
		const completion = await body.completion;
		expect(completion.ok).toBe(false);
		if (!completion.ok) expect(["FILE_CHANGED", "DIGEST_MISMATCH"]).toContain(completion.code);
	});
});
