import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_RELEASE_ASSETS } from "../src/utils/native-installation.js";

describe("compiled update instructions", () => {
	it.each(["healthy", "missing metadata", "missing asset", "unmanaged"])(
		"uses installer ownership for a %s compiled installation",
		(state) => {
			const root = mkdtempSync(join(tmpdir(), "native-update-instruction-"));
			try {
				const virtual = join(root, "$bunfs");
				mkdirSync(join(virtual, "utils"), { recursive: true });
				for (const file of [
					"config.ts",
					"utils/child-process.ts",
					"utils/daemon-socket-path.ts",
					"utils/native-installation.ts",
				])
					copyFileSync(resolve(__dirname, "../src", file), join(virtual, file));
				const managed = join(root, "managed");
				mkdirSync(join(managed, "bin"), { recursive: true });
				writeFileSync(join(managed, ".managed"), "prime-agent-native-v1\n");
				let executable = "";
				for (const [version, link] of [
					["1.0.0", "previous"],
					["1.0.1", "prime-agent"],
				]) {
					const digest = "a".repeat(64);
					const name = `${version}-linux-x64-${digest}`;
					const release = join(managed, "releases", name);
					for (const asset of NATIVE_RELEASE_ASSETS) {
						mkdirSync(dirname(join(release, asset)), { recursive: true });
						writeFileSync(join(release, asset), "fixture\n");
					}
					writeFileSync(join(release, "package.json"), JSON.stringify({ version }));
					writeFileSync(join(release, ".archive-sha256"), digest);
					writeFileSync(join(release, ".install-source"), "https://example.invalid");
					symlinkSync(`../releases/${name}/prime-agent`, join(managed, "bin", link));
					if (link === "prime-agent") {
						executable = join(release, "prime-agent");
						if (state === "missing metadata") rmSync(join(release, ".archive-sha256"));
						if (state === "missing asset") rmSync(join(release, "theme/prime.json"));
					}
				}
				if (state === "unmanaged") rmSync(join(managed, ".managed"));
				const entrypoint = join(root, "instruction.mts");
				writeFileSync(
					entrypoint,
					`import { getUpdateInstruction, isBunBinary } from './$bunfs/config.js';
if (!isBunBinary) throw new Error('fixture must use compiled path detection');
Object.defineProperty(process, 'execPath', { value: process.argv[2] });
console.log(getUpdateInstruction('prime-agent'));
`,
				);
				const output = execFileSync(
					process.execPath,
					["--import", resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"), entrypoint, executable],
					{
						encoding: "utf8",
						timeout: 10000,
						env: { ...process.env, PI_PACKAGE_DIR: resolve(__dirname, "..") },
					},
				);
				expect(output.trim()).toBe(
					state === "unmanaged"
						? "Download from: https://github.com/PrimeIntellect-ai/prime-agent/releases/latest"
						: "Run: prime-agent update",
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
