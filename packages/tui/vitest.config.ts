import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/selection-metadata.test.ts", "test/wrap-ansi.test.ts"],
	},
});
