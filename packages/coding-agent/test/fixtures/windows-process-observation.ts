import assert from "node:assert/strict";

const leafScript = `const { existsSync } = require("node:fs"); setInterval(() => { if (existsSync(process.argv[1])) process.exit(0); }, 25);`;
export const cooperativeTreeScript = `const { spawn } = require("node:child_process"); const { existsSync, writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(leafScript)}, process.argv[2]], { stdio: "ignore" }); child.on("spawn", () => writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]))); setInterval(() => { if (existsSync(process.argv[2])) process.exit(0); }, 25);`;

export async function waitUntil(condition: () => boolean, milliseconds: number, phase: string): Promise<void> {
	const deadline = Date.now() + milliseconds;
	while (!condition()) {
		assert(Date.now() < deadline, `${phase} timed out after ${milliseconds}ms`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Observe without abandoning the real operation's exit/error handlers on timeout. */
export async function observe<T>(operation: Promise<T>, milliseconds: number, phase: string): Promise<T> {
	let settled = false;
	operation.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await waitUntil(() => settled, milliseconds, phase);
	return operation;
}
