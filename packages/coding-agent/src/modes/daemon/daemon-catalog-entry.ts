import { runDaemonCatalogProcess } from "./daemon-catalog-process.js";

runDaemonCatalogProcess().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`Prime Agent daemon catalog failed: ${message}\n`);
	process.exit(1);
});
