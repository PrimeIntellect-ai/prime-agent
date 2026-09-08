#!/usr/bin/env bun
if (!process.versions.bun) {
	console.error("prime-agent requires Bun. Install Bun from https://bun.sh or use a compiled Prime Agent release.");
	process.exit(1);
}

await import("./bun/cli.js");
