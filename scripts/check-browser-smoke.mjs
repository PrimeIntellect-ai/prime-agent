import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputPath = join(tmpdir(), "prime-agent-browser-smoke.js");
const errorLogPath = join(tmpdir(), "prime-agent-browser-smoke-errors.log");

try {
	const result = await Bun.build({
		entrypoints: ["scripts/browser-smoke-entry.ts"],
		target: "browser",
		format: "esm",
		sourcemap: "none",
		write: false,
		throw: false,
	});
	if (!result.success || result.outputs.length !== 1) {
		throw new Error(result.logs.map((entry) => entry.message).join("\n") || "Bun browser bundle produced no output");
	}
	await Bun.write(outputPath, result.outputs[0]);
} catch (error) {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, message, "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
