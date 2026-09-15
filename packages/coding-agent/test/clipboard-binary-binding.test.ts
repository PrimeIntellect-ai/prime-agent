import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clipboardNativePackageByPlatform, writeClipboardBinaryBinding } from "../scripts/clipboard-binary-binding.mjs";
import { NATIVE_PLATFORMS } from "../src/utils/native-installation.js";

const platforms = [...NATIVE_PLATFORMS];

let directory: string | undefined;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("standalone clipboard binding", () => {
	it("maps every standalone target to a native clipboard package", () => {
		expect(Object.keys(clipboardNativePackageByPlatform)).toEqual(platforms);
	});

	it.each(platforms)("generates a static native require for %s", (platform) => {
		directory = mkdtempSync(join(tmpdir(), "prime-clipboard-binding-"));
		const output = join(directory, "clipboard-binary-binding.js");
		writeClipboardBinaryBinding(output, platform);
		expect(readFileSync(output, "utf8")).toBe(
			`export function loadBundledClipboard() {\n\treturn require(${JSON.stringify(clipboardNativePackageByPlatform[platform])});\n}\n`,
		);
	});

	it("rejects unsupported targets", () => {
		directory = mkdtempSync(join(tmpdir(), "prime-clipboard-binding-"));
		expect(() => writeClipboardBinaryBinding(join(directory!, "binding.js"), "windows-x64")).toThrow(
			"Unsupported binary platform",
		);
	});
});
