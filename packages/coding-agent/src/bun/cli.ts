#!/usr/bin/env bun
const mode = process.argv[2];
if (mode === "--internal-sandbox-launcher") {
	await import("../modes/daemon/sandbox/prime-sandbox-launcher.js");
} else if (mode === "--internal-sandbox-peer") {
	await import("../modes/daemon/sandbox/prime-sandbox-peer.js");
} else {
	await import("./normal-cli.js");
}
