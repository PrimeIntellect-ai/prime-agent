import { constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	closedFds: [] as number[],
	failFchmod: false,
	racePath: undefined as string | undefined,
	raceTarget: undefined as string | undefined,
	lastOpenFlags: undefined as number | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		constants: { ...actual.constants, O_NOFOLLOW: actual.constants.O_NOFOLLOW ?? 0x20000 },
		closeSync: (fd: number) => {
			fsMocks.closedFds.push(fd);
			actual.closeSync(fd);
		},
		fchmodSync: (fd: number, mode: number) => {
			if (fsMocks.failFchmod) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
			actual.fchmodSync(fd, mode);
		},
		openSync: (
			path: Parameters<typeof actual.openSync>[0],
			flags: Parameters<typeof actual.openSync>[1],
			mode?: number,
		) => {
			if (path === fsMocks.racePath && typeof flags === "number" && (flags & constants.O_EXCL) !== 0) {
				const racedPath = fsMocks.racePath;
				fsMocks.racePath = undefined;
				if (fsMocks.raceTarget) {
					symlinkSync(fsMocks.raceTarget, racedPath);
				} else {
					writeFileSync(racedPath, "created by competing process");
				}
				throw Object.assign(new Error("already exists"), { code: "EEXIST" });
			}
			if (typeof flags === "number") fsMocks.lastOpenFlags = flags;
			return actual.openSync(path, flags, mode);
		},
	};
});

import {
	ensurePrivateDirectory,
	ensurePrivateFile,
	PRIVATE_FILE_SYSTEM_UNSUPPORTED_ERROR,
	readPrivateFile,
	requireNoFollow,
} from "../src/utils/private-files.js";

let directory: string;

afterEach(() => {
	fsMocks.closedFds = [];
	fsMocks.failFchmod = false;
	fsMocks.racePath = undefined;
	fsMocks.raceTarget = undefined;
	fsMocks.lastOpenFlags = undefined;
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("private filesystem capability", () => {
	it("requires O_NOFOLLOW support", () => {
		expect(PRIVATE_FILE_SYSTEM_UNSUPPORTED_ERROR).toContain("O_NOFOLLOW");
		expect(() => requireNoFollow(undefined)).toThrow(PRIVATE_FILE_SYSTEM_UNSUPPORTED_ERROR);
	});
});

describe("ensurePrivateFile exclusive-create races", () => {
	it("repairs a regular file created after lexical absence", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-private-file-race-"));
		const path = join(directory, "auth.json");
		fsMocks.racePath = path;

		ensurePrivateFile(path, "ignored");

		expect(readFileSync(path, "utf8")).toBe("created by competing process");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("opens private reads non-blocking to reject swapped FIFOs", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-private-file-race-"));
		const path = join(directory, "auth.json");
		writeFileSync(path, "secret");
		readPrivateFile(path, "utf8");
		expect(fsMocks.lastOpenFlags! & (constants.O_NONBLOCK ?? 0)).not.toBe(0);
	});

	it("closes the descriptor when mode repair fails during a read", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-private-file-race-"));
		const path = join(directory, "auth.json");
		writeFileSync(path, "secret");
		fsMocks.closedFds = [];
		fsMocks.failFchmod = true;

		expect(() => readPrivateFile(path, "utf8")).toThrow("permission denied");
		expect(fsMocks.closedFds).toHaveLength(1);
	});

	it("rejects a symlink created after lexical absence", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-private-file-race-"));
		const path = join(directory, "auth.json");
		const target = join(directory, "outside.json");
		writeFileSync(target, "sentinel");
		fsMocks.racePath = path;
		fsMocks.raceTarget = target;

		expect(() => ensurePrivateFile(path, "ignored")).toThrow("non-regular private file");
		expect(readFileSync(target, "utf8")).toBe("sentinel");
	});

	it("rejects an existing directory beneath a symlinked ancestor", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-private-file-race-"));
		const outside = join(directory, "outside");
		const existing = join(outside, "existing");
		const link = join(directory, "link");
		mkdirSync(existing, { recursive: true });
		symlinkSync(outside, link, "dir");

		expect(() => ensurePrivateDirectory(join(link, "existing"))).toThrow("non-directory private path");
		expect(statSync(existing).mode & 0o777).not.toBe(0o700);
	});
});
