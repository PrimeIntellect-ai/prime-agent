import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const workspace = await mkdtemp(join(tmpdir(), "prime-agent-channel-test-"));
const installer = await readFile(new URL("install.sh", root), "utf8");
const libraryPath = join(workspace, "installer-functions.sh");
await writeFile(libraryPath, installer.replace(/\nmain "\$@"\s*$/, "\n"));

function runDownload(url, { recordSleeps = false } = {}) {
	const outputPath = join(workspace, `channel-${crypto.randomUUID()}`);
	const sleepPath = `${outputPath}.sleeps`;
	const script = `
. "$INSTALLER_LIBRARY"
${recordSleeps ? 'sleep() { printf "%s\\n" "$1" >>"$SLEEP_PATH"; }' : "sleep() { :; }"}
download_channel_marker "$CHANNEL_URL" "$CHANNEL_PATH"
`;
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", script], {
			env: {
				...process.env,
				INSTALLER_LIBRARY: libraryPath,
				CHANNEL_URL: url,
				CHANNEL_PATH: outputPath,
				SLEEP_PATH: sleepPath,
			},
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (status) => resolve({ status, stderr, outputPath, sleepPath }));
	});
}

async function withServer(handler, test) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address();
		await test(`http://127.0.0.1:${port}/stable`);
	} finally {
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

try {
	let transientRequests = 0;
	await withServer(
		(_req, res) => {
			transientRequests += 1;
			if (transientRequests === 1) res.writeHead(503).end("temporarily unavailable");
			else res.writeHead(200).end("v1.2.3\n");
		},
		async (url) => {
			const result = await runDownload(url);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(transientRequests, 2);
			assert.equal(await readFile(result.outputPath, "utf8"), "1.2.3");
		},
	);

	for (const status of [401, 404]) {
		let requests = 0;
		await withServer(
			(_req, res) => {
				requests += 1;
				res.writeHead(status).end("permanent failure");
			},
			async (url) => {
				const result = await runDownload(url);
				assert.notEqual(result.status, 0);
				assert.equal(requests, 1, `${status} must not be retried`);
				await assert.rejects(readFile(result.outputPath));
			},
		);
	}

	let partialRequests = 0;
	await withServer(
		(_req, res) => {
			partialRequests += 1;
			res.writeHead(200, { "Content-Length": "100" });
			res.write("v9.9.9\n");
			res.socket.destroy();
		},
		async (url) => {
			const result = await runDownload(url);
			assert.notEqual(result.status, 0);
			assert.equal(partialRequests, 6);
			await assert.rejects(readFile(result.outputPath));
		},
	);

	let retryAfterRequests = 0;
	await withServer(
		(_req, res) => {
			retryAfterRequests += 1;
			if (retryAfterRequests === 1) res.writeHead(429, { "Retry-After": "60" }).end();
			else res.writeHead(200).end("2.0.0");
		},
		async (url) => {
			const result = await runDownload(url, { recordSleeps: true });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(await readFile(result.sleepPath, "utf8"), "2\n");
		},
	);

	let exhaustedRequests = 0;
	await withServer(
		(_req, res) => {
			exhaustedRequests += 1;
			res.writeHead(503).end("still unavailable");
		},
		async (url) => {
			const result = await runDownload(url);
			assert.notEqual(result.status, 0);
			assert.equal(exhaustedRequests, 6);
			await assert.rejects(readFile(result.outputPath));
		},
	);

	console.log("installer channel resolution tests passed");
} finally {
	await rm(workspace, { recursive: true, force: true });
}
