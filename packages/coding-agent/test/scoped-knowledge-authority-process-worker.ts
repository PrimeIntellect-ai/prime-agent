import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { createFileScopedKnowledgeStorage } from "../src/core/knowledge/scoped-knowledge-authority.js";

const [mode, filePath, markerPath] = process.argv.slice(2);
if (mode !== "ack" || filePath === undefined) throw new Error("invalid scoped knowledge worker arguments");

const storage = createFileScopedKnowledgeStorage({ filePath, trustDomainId: "trust-local" });
const pending = await storage.pendingOutbox();
const entry = pending[0];
if (entry === undefined) process.exit(2);

if (markerPath !== undefined) {
	const lockPath = `${filePath}.lock`;
	const probe = setInterval(async () => {
		try {
			await access(lockPath, constants.F_OK);
			await writeFile(markerPath, "locked", { mode: 0o600 });
			clearInterval(probe);
			process.kill(process.pid, "SIGSTOP");
		} catch {
			// The lock is not held yet.
		}
	}, 1);
}

await storage.acknowledgeOutbox({
	idempotencyKey: entry.idempotencyKey,
	expectedFenceDigest: entry.fenceDigest,
});
process.exit(0);
