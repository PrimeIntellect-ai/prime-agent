// Minimal tar.gz and zip writers for helper-install tests. Real archivers strip or
// refuse `..` and absolute member names, so hostile fixtures have to be hand-built.
import { crc32, gzipSync } from "node:zlib";

export interface ArchiveEntry {
	name: string;
	content?: string;
	mode?: number;
	/** Symbolic link target; the entry becomes a symlink when set. */
	linkTarget?: string;
}

function octal(value: number, width: number): Buffer {
	return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "latin1");
}

function tarHeader(entry: ArchiveEntry, size: number): Buffer {
	const header = Buffer.alloc(512);
	header.write(entry.name, 0, 100, "utf8");
	octal(entry.mode ?? (entry.linkTarget ? 0o777 : 0o644), 8).copy(header, 100);
	octal(0, 8).copy(header, 108);
	octal(0, 8).copy(header, 116);
	octal(size, 12).copy(header, 124);
	octal(0, 12).copy(header, 136);
	header.fill(" ", 148, 156);
	header.write(entry.linkTarget ? "2" : "0", 156, 1, "latin1");
	if (entry.linkTarget) header.write(entry.linkTarget, 157, 100, "utf8");
	header.write("ustar\0", 257, 6, "latin1");
	header.write("00", 263, 2, "latin1");
	let sum = 0;
	for (const byte of header) sum += byte;
	Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "latin1").copy(header, 148);
	return header;
}

export function makeTarGz(entries: ArchiveEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = Buffer.from(entry.linkTarget ? "" : (entry.content ?? ""), "utf8");
		blocks.push(tarHeader(entry, data.length));
		blocks.push(data);
		const padding = (512 - (data.length % 512)) % 512;
		if (padding) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function u16(value: number): Buffer {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16LE(value);
	return buffer;
}

function u32(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value >>> 0);
	return buffer;
}

export function makeZip(entries: ArchiveEntry[]): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data = Buffer.from(entry.linkTarget ?? entry.content ?? "", "utf8");
		const crc = crc32(data);
		const mode = entry.linkTarget ? 0o120777 : (entry.mode ?? 0o644);
		const fixed = Buffer.concat([
			u16(20),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(data.length),
			u32(data.length),
		]);
		const localHeader = Buffer.concat([u32(0x04034b50), fixed, u16(name.length), u16(0), name]);
		local.push(localHeader, data);
		central.push(
			Buffer.concat([
				u32(0x02014b50),
				u16((3 << 8) | 20),
				fixed,
				u16(name.length),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(mode << 16),
				u32(offset),
				name,
			]),
		);
		offset += localHeader.length + data.length;
	}
	const centralDirectory = Buffer.concat(central);
	const end = Buffer.concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(centralDirectory.length),
		u32(offset),
		u16(0),
	]);
	return Buffer.concat([...local, centralDirectory, end]);
}
