import { isDaemonCatalogProcess, runDaemonCatalogProcess } from "../../src/modes/daemon/daemon-catalog-process.js";

if (!isDaemonCatalogProcess()) {
	throw new Error("daemon catalog client fixture requires catalog mode");
}

if (process.env.PRIME_AGENT_TEST_CATALOG_STUCK === "1") {
	process.on("message", () => {});
	process.send?.({ type: "ready" });
} else {
	void runDaemonCatalogProcess();
}
