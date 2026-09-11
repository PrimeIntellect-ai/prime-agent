import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { VIRTUAL_MODULES } from "../../../src/core/extensions/bundled-modules.js";
import { loadExtensions } from "../../../src/core/extensions/loader.js";
import { createHarness, type Harness } from "../harness.js";

describe("PR 2138 catalog schema imports in extensions", () => {
	let harness: Harness;
	beforeEach(async () => {
		harness = await createHarness();
	});
	afterEach(() => {
		harness.cleanup();
	});

	test.each(["typebox", "@sinclair/typebox"])(
		"resolves %s/schema through native loader aliases",
		async (specifier) => {
			const extensionPath = join(harness.tempDir, "schema-extension.ts");
			writeFileSync(
				extensionPath,
				`
			import { Type } from "${specifier}";
			import { Compile } from "${specifier}/schema";
			export default function(pi) {
				const validator = Compile(Type.Object({ ready: Type.Boolean() }, { additionalProperties: false }));
				if (!validator.Check({ ready: true }) || validator.Check({ ready: "yes" })) throw new Error("bad validator");
				pi.registerFlag("schema-ready", { description: "Schema loaded", type: "boolean" });
			}
		`,
			);
			const loaded = await loadExtensions([extensionPath], harness.tempDir);
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
			expect(loaded.extensions[0].flags.has("schema-ready")).toBe(true);
		},
	);

	test.each(["typebox", "@sinclair/typebox"])(
		"serves %s/schema in the bundled virtual module map",
		async (specifier) => {
			expect(VIRTUAL_MODULES[`${specifier}/schema`]).toBeDefined();
			const extensionPath = join(harness.tempDir, "virtual-schema-extension.ts");
			writeFileSync(
				extensionPath,
				`
			import { Type } from "${specifier}";
			import { Compile } from "${specifier}/schema";
			export default function() {
				const validator = Compile(Type.String());
				if (!validator.Check("ready") || validator.Check(42)) throw new Error("bad validator");
			}
		`,
			);
			const jiti = createJiti(import.meta.url, {
				virtualModules: VIRTUAL_MODULES,
				tryNative: false,
				moduleCache: false,
			});
			const validate = await jiti.import<() => void>(extensionPath, { default: true });
			expect(validate).not.toThrow();
		},
	);
});
