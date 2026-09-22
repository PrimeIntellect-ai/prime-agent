import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions, loadExtensions } from "../src/core/extensions/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const extensionCode = `
	export default function(pi) {
		pi.registerCommand("test", { handler: async () => {} });
	}
`;

const extensionCodeWithTool = (toolName: string) => `
	import { Type } from "typebox";
	export default function(pi) {
		pi.registerTool({
			name: "${toolName}",
			label: "${toolName}",
			description: "Test tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
	}
`;

describe("extensions discovery", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const write = (file: string, code = extensionCode) => {
		const target = path.join(extensionsDir, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, code);
	};
	const manifest = (dir: string, extensions: string[]) =>
		write(path.join(dir, "package.json"), JSON.stringify({ name: "my-package", pi: { extensions } }));

	it.each([
		{
			name: "direct .ts files",
			setup: () => {
				write("foo.ts");
				write("bar.ts");
			},
			expected: ["bar.ts", "foo.ts"],
		},
		{ name: "direct .js files", setup: () => write("foo.js"), expected: ["foo.js"] },
		{
			name: "subdirectory index.ts",
			setup: () => write("my-extension/index.ts"),
			expected: ["my-extension/index.ts"],
		},
		{
			name: "subdirectory index.js",
			setup: () => write("my-extension/index.js"),
			expected: ["my-extension/index.js"],
		},
		{
			name: "index.ts wins over index.js",
			setup: () => {
				write("my-extension/index.ts");
				write("my-extension/index.js");
			},
			expected: ["my-extension/index.ts"],
		},
		{
			name: "package.json pi field",
			setup: () => {
				write("my-package/src/main.ts");
				manifest("my-package", ["./src/main.ts"]);
			},
			expected: ["my-package/src/main.ts"],
		},
		{
			name: "package.json declaring several extensions",
			setup: () => {
				write("my-package/ext1.ts");
				write("my-package/ext2.ts");
				manifest("my-package", ["./ext1.ts", "./ext2.ts"]);
			},
			expected: ["my-package/ext1.ts", "my-package/ext2.ts"],
		},
		{
			name: "package.json pi field wins over index.ts",
			setup: () => {
				write("my-package/index.ts");
				write("my-package/custom.ts");
				manifest("my-package", ["./custom.ts"]);
			},
			expected: ["my-package/custom.ts"],
		},
		{
			name: "package.json with an absent or unusable pi field does not stop discovery",
			setup: () => {
				write("my-package/index.ts");
				write("my-package/package.json", JSON.stringify({ name: "my-package", version: "1.0.0" }));
				write("malformed-package/index.ts");
				write("malformed-package/package.json", JSON.stringify({ pi: { extensions: "index.ts" } }));
				write("invalid-element-package/index.ts");
				write("invalid-element-package/package.json", JSON.stringify({ pi: { extensions: [7] } }));
			},
			expected: ["invalid-element-package/index.ts", "malformed-package/index.ts", "my-package/index.ts"],
		},
		{
			name: "package.json paths that do not exist are skipped",
			setup: () => {
				write("my-package/exists.ts");
				manifest("my-package", ["./exists.ts", "./missing.ts"]);
			},
			expected: ["my-package/exists.ts"],
		},
		{
			name: "subdirectory without index or manifest",
			setup: () => {
				write("not-an-extension/helper.ts");
				write("not-an-extension/utils.ts");
			},
			expected: [],
		},
		{ name: "no recursion beyond one level", setup: () => write("container/nested/index.ts"), expected: [] },
		{
			name: "mixed direct files and subdirectories",
			setup: () => {
				write("direct.ts");
				write("with-index/index.ts");
				write("with-manifest/entry.ts");
				manifest("with-manifest", ["./entry.ts"]);
			},
			expected: ["direct.ts", "with-index/index.ts", "with-manifest/entry.ts"],
		},
	])("discovers $name", async ({ setup, expected }) => {
		setup();

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => path.relative(extensionsDir, extension.path)).sort()).toEqual(
			expected.map((relative) => path.join(...relative.split("/"))).sort(),
		);
	});

	it("resolves a symlink named like a file through the entry point of its target directory", async () => {
		const targetDir = path.join(tempDir, "target");
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(path.join(targetDir, "index.ts"), extensionCode);
		fs.symlinkSync(targetDir, path.join(extensionsDir, "foo.ts"), "dir");
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => path.relative(extensionsDir, extension.path))).toEqual([
			path.join("foo.ts", "index.ts"),
		]);
	});

	it("silently skips a symlink whose target does not exist", async () => {
		write("kept.ts");
		fs.symlinkSync(path.join(tempDir, "missing.ts"), path.join(extensionsDir, "broken.ts"));
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => path.relative(extensionsDir, extension.path))).toEqual(["kept.ts"]);
	});

	it.each([
		{
			name: "code that fails to load",
			file: "invalid.ts",
			code: "this is not valid typescript export",
			error: undefined,
		},
		{
			name: "a factory that throws",
			file: "throws.ts",
			code: 'export default function(pi) { throw new Error("Initialization failed!"); }',
			error: "Initialization failed!",
		},
		{
			name: "a missing default export",
			file: "no-default.ts",
			code: "export function notDefault(pi) {}",
			error: "does not export a valid factory function",
		},
	])("reports $name as a load error", async ({ file, code, error }) => {
		write(file, code);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toContain(file);
		if (error) expect(result.errors[0].error).toContain(error);
	});

	it("skips extensions excluded by the ignore files of the extensions directory", async () => {
		write("kept.ts");
		write("skipped.ts");
		write("ignored-package/index.ts");
		write(".gitignore", "skipped.ts\nignored-package/\n");

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => path.relative(extensionsDir, extension.path))).toEqual(["kept.ts"]);
	});

	it("loads explicitly configured paths outside the extensions directory", async () => {
		const customPath = path.join(tempDir, "custom-location", "my-ext.ts");
		fs.mkdirSync(path.dirname(customPath), { recursive: true });
		fs.writeFileSync(customPath, extensionCode);

		const result = await discoverAndLoadExtensions([customPath], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => extension.path)).toEqual([customPath]);
	});

	it("resolves dependencies from an extension's own node_modules", async () => {
		const extPath = path.resolve(__dirname, "../examples/extensions/with-deps");

		const result = await discoverAndLoadExtensions([extPath], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("parse_duration")).toBe(true);
	});

	it.each([
		{ name: "loads only the explicit path", explicit: true },
		{ name: "loads nothing without paths", explicit: false },
	])("loadExtensions $name", async ({ explicit }) => {
		write("discovered.ts", extensionCodeWithTool("discovered"));
		const explicitPath = path.join(tempDir, "explicit.ts");
		fs.writeFileSync(explicitPath, extensionCodeWithTool("explicit"));

		const result = await loadExtensions(explicit ? [explicitPath] : [], tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.map((extension) => extension.path)).toEqual(explicit ? [explicitPath] : []);
	});
});
